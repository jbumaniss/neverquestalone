// ChatGPT browser sign-in coordinator. Runs only in Electron's trusted main process.
// Browser and IPC never receive OAuth tokens. Each install owns one connected account.
import path from 'node:path';
import { getOrCreateHostId, createAuthorization, NEW_CLIENT } from './chatgpt-oauth.mjs';
import { startChatGPTCallback } from './chatgpt-loopback.mjs';
import { exchangeChatGPTCode } from './chatgpt-tokens.mjs';
import { createChatGPTStore } from './chatgpt-store.mjs';
import { createChatGPTSessions } from './chatgpt-session.mjs';
import { createChatGPTDirect } from './chatgpt-direct.mjs';

const AUTHORIZE_ORIGIN = 'https://auth.openai.com';
const SAFE_ERRORS = new Set(['busy', 'cancelled', 'storage_unavailable', 'open_browser_failed', 'sign_in_failed', 'multiple_accounts']);

export function createChatGPTConnection({
  userData, encryption, openBrowser,
  fetchFn = globalThis.fetch,
  startCallback = startChatGPTCallback,
  exchangeCode = exchangeChatGPTCode,
} = {}) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData) ||
      !encryption || typeof openBrowser !== 'function' || typeof fetchFn !== 'function') {
    throw new TypeError('ChatGPT connection requires app data, OS encryption, a browser and fetch');
  }
  const folder = path.join(userData, 'chatgpt');
  const store = createChatGPTStore({ directory: path.join(folder, 'credentials'), encryption });
  const sessions = createChatGPTSessions({ store, fetchFn });
  let busy = false;
  let listener = null;

  function existing() {
    const ids = store.listClientIds();
    if (ids.length > 1) throw Object.assign(new Error('Multiple ChatGPT accounts need explicit selection'), { code: 'multiple_accounts' });
    const clientId = ids[0] ?? null;
    return clientId ? store.load(clientId) : null;
  }

  async function getAccessToken() {
    const current = existing();
    if (!current) throw Object.assign(new Error('ChatGPT sign-in required'), { code: 'sign_in_required' });
    return sessions.ensureFresh(current.clientId);
  }
  const direct = createChatGPTDirect({ accessToken: getAccessToken, fetchFn });

  function publicState() {
    const current = existing();
    if (!current) return { ok: true, status: 'disconnected', sharing: false };
    // The account and connection state may be shown, but never the credential record.
    return { ok: true, ...sessions.getStatus(current.clientId) };
  }

  function failure(err, fallback = 'sign_in_failed') {
    const code = typeof err?.code === 'string' && SAFE_ERRORS.has(err.code) ? err.code : fallback;
    return { ok: false, error: code };
  }

  return Object.freeze({
    status() {
      try { return publicState(); }
      catch (err) { return failure(err, err?.code === 'multiple_accounts' ? 'multiple_accounts' : 'storage_unavailable'); }
    },
    async signIn() {
      if (busy) return { ok: false, error: 'busy' };
      busy = true;
      try {
        const previous = existing();
        const hostId = getOrCreateHostId(path.join(folder, 'host-id'));
        listener = await startCallback();
        const tx = createAuthorization({
          hostId, appName: 'NeverQuestAlone', redirectUri: listener.redirectUri,
          clientId: previous?.clientId ?? NEW_CLIENT,
          ...(previous?.credentials?.idToken ? { idTokenHint: previous.credentials.idToken } : {}),
          ...(previous?.email ? { loginHint: previous.email } : {}),
        });
        const url = new URL(tx.url);
        if (url.origin !== AUTHORIZE_ORIGIN || url.protocol !== 'https:') {
          throw Object.assign(new Error('Invalid authorization URL'), { code: 'sign_in_failed' });
        }
        // Begin waiting BEFORE the system browser opens, so an immediate callback is not lost.
        const pending = listener.waitForCallback(tx);
        pending.catch(() => {}); // Cancellation can arrive while the system browser is still opening.
        try {
          await openBrowser(url.href);
        } catch {
          // A failed browser launch must consume the pending rejection too.
          listener.cancel();
          await pending.catch(() => {});
          return { ok: false, error: 'open_browser_failed' };
        }
        const callback = await pending;
        const verified = await exchangeCode({
          callback, transaction: tx, fetchFn,
          ...(previous?.subject ? { expectedSubject: previous.subject } : {}),
        });
        const status = sessions.saveConnected({ clientId: callback.clientId, hostId, exchange: verified });
        direct.invalidateModels();
        return { ok: true, ...status };
      } catch (err) {
        return failure(err);
      } finally {
        listener?.close();
        listener = null;
        busy = false;
      }
    },
    cancelSignIn() {
      if (!busy || !listener) return { ok: false, error: 'not_connecting' };
      listener.cancel();
      return { ok: true };
    },
    disconnect() {
      if (busy) return { ok: false, error: 'busy' };
      try {
        const current = existing();
        if (current) store.remove(current.clientId);
        direct.invalidateModels();
        return { ok: true, status: 'disconnected', sharing: false };
      } catch (err) { return failure(err, err?.code === 'multiple_accounts' ? 'multiple_accounts' : 'storage_unavailable'); }
    },
    // Only verified model names and their IDs may be shared with a renderer.
    async models() {
      try { return { ok: true, models: await direct.listModels() }; }
      catch (err) {
        const allowed = new Set(['sign_in_required', 'plan_permission_denied',
          'plan_usage_limited', 'invalid_model_catalog', 'service_unavailable', 'cancelled']);
        return {
          ok: false, error: allowed.has(err?.code) ? err.code : 'service_unavailable',
          ...(Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
            ? { httpStatus: err.status } : {}),
          // Only explicit, bounded categories. Never include server responses or tokens.
          ...(['empty_response', 'response_too_large', 'unreadable_response',
            'invalid_json', 'unexpected_shape', 'too_many_models', 'invalid_visible_model']
              .includes(err?.catalogReason) ? { catalogReason: err.catalogReason } : {}),
        };
      }
    },
    // Cached catalog is safe display metadata; no network is performed.
    cachedModels() { return direct.cachedModels(); },
    // Main-process-only APIs. Never attach either to renderer IPC.
    accessToken: getAccessToken,
    streamResponse: (req, opts) => direct.stream(req, opts),
    close() { listener?.cancel(); },
  });
}
