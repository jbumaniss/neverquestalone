// Trusted-process ChatGPT session management. Tokens are never returned to IPC.
import { CHATGPT_RESOURCE, CHATGPT_TOKEN_URL, planUsageGranted } from './chatgpt-oauth.mjs';
import { verifyChatGPTIdToken } from './chatgpt-tokens.mjs';

const REFRESH_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const REVOKED = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
function error(code) { const e = new Error('ChatGPT session: ' + code); e.code = code; return e; }
function earliest(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}
async function limitedJSON(res) {
  let text = '', size = 0;
  const decoder = new TextDecoder();
  if (!res?.body) throw error('bad_response');
  try {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw error('bad_response');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { throw error('bad_response'); }
}
function publicStatus(r) {
  if (!r) return { status: 'disconnected', sharing: false };
  return {
    status: r.status, sharing: r.status === 'connected' && planUsageGranted(r.scopes),
    clientId: r.clientId,
    subject: r.subject,
    ...(r.email ? { email: r.email } : {}),
  };
}
function tokenData(t, now) {
  if (!t || typeof t.access_token !== 'string' || !t.access_token || t.access_token.length > 16_384 ||
      typeof t.id_token !== 'string' || !t.id_token || t.id_token.length > 32768 ||
      typeof t.refresh_token !== 'string' || !t.refresh_token || t.refresh_token.length > 16384 ||
      typeof t.token_type !== 'string' || t.token_type.toLowerCase() !== 'bearer' ||
      !Number.isInteger(t.expires_in) || t.expires_in < 1 || t.expires_in > 86_400 ||
      typeof t.scope !== 'string' || t.scope.length > 4096 ||
      (t.earliest_refresh_at !== undefined && earliest(t.earliest_refresh_at) === 0)) throw error('bad_response');
  return {
    accessToken: t.access_token, idToken: t.id_token, refreshToken: t.refresh_token,
    expiresAt: now() + t.expires_in * 1000,
    ...(t.earliest_refresh_at !== undefined ? { earliestRefreshAt: t.earliest_refresh_at } : {}),
    scopes: t.scope.split(/\s+/).filter(Boolean),
  };
}

/** The app's Electron main process is single-instance; a promise gate also serializes same-process refresh. */
export function createChatGPTSessions({ store, fetchFn = globalThis.fetch, verifyIdToken = verifyChatGPTIdToken, now = Date.now } = {}) {
  if (!store?.save || !store?.load || typeof fetchFn !== 'function' || typeof verifyIdToken !== 'function') throw new TypeError('ChatGPT session dependencies required');
  const inFlight = new Map();

  function saveConnected({ clientId, hostId, exchange }) {
    const identity = exchange?.identity;
    const credentials = exchange?.credentials;
    if (!identity || identity.clientId !== clientId || typeof identity.subject !== 'string' || !identity.subject ||
        typeof hostId !== 'string' || typeof credentials?.accessToken !== 'string' ||
        !Array.isArray(exchange.scopes)) throw error('invalid_identity');
    const before = store.load(clientId);
    if (before && (before.subject !== identity.subject || before.hostId !== hostId)) throw error('account_mismatch');
    const record = {
      v: 1, clientId, hostId, subject: identity.subject, status: 'connected',
      scopes: exchange.scopes, credentials,
      ...(typeof identity.email === 'string' ? { email: identity.email } : {}),
    };
    store.save(record);
    return publicStatus(record);
  }

  async function verifyPending(record) {
    const pending = record.pending;
    if (!pending) throw error('missing_pending_refresh');
    const identity = await verifyIdToken(pending.idToken, {
      clientId: record.clientId, nonce: null, expectedSubject: record.subject,
      accessToken: pending.accessToken, fetchFn, now: () => pending.receivedAt,
    });
    if (!identity || identity.subject !== record.subject || identity.clientId !== record.clientId) throw error('account_mismatch');
    const updated = {
      ...record, status: 'connected', scopes: pending.scopes,
      credentials: {
        accessToken: pending.accessToken, refreshToken: pending.refreshToken,
        idToken: pending.idToken, expiresAt: pending.expiresAt,
        ...(pending.earliestRefreshAt !== undefined ? { earliestRefreshAt: pending.earliestRefreshAt } : {}),
      },
    };
    delete updated.pending;
    store.save(updated);
    return updated;
  }

  async function renew(clientId) {
    let record = store.load(clientId);
    if (!record || record.status === 'disconnected' || record.status === 'reauth_required') throw error('sign_in_required');
    // Recovery must take priority over any old access token. The previous refresh token was consumed.
    if (record.status === 'pending_refresh') return verifyPending(record);
    if (record.credentials.expiresAt > now() + REFRESH_MARGIN_MS) return record;
    if (!record.credentials.refreshToken) throw error('sign_in_required');
    if (earliest(record.credentials.earliestRefreshAt) > now()) {
      if (record.credentials.expiresAt > now()) return record;
      throw error('refresh_not_ready');
    }
    let res;
    try {
      res = await fetchFn(CHATGPT_TOKEN_URL, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId,
          refresh_token: record.credentials.refreshToken, resource: CHATGPT_RESOURCE }).toString(),
      });
    } catch { throw error('refresh_unavailable'); }
    if (res.status >= 300 && res.status < 400) throw error('refresh_unavailable');
    if (!res.ok) {
      let remoteCode = '';
      try { const body = await limitedJSON(res); if (typeof body?.error === 'string') remoteCode = body.error; } catch { /* only machine codes matter */ }
      if (res.status === 400 && REVOKED.has(remoteCode)) {
        // Keep the account-to-client registration for reauthorization, but discard invalid tokens.
        const { credentials: _old, pending: _pending, ...publicRecord } = record;
        store.save({ ...publicRecord, status: 'reauth_required' });
        throw error('sign_in_required');
      }
      throw error('refresh_unavailable');
    }
    const replacement = tokenData(await limitedJSON(res), now);
    // A successful refresh consumes its predecessor. Checkpoint replacement tokens before any
    // network-based JWKS verification so failure or restart never loses the rotated refresh token.
    record = { ...record, status: 'pending_refresh', pending: { ...replacement, receivedAt: now() } };
    store.save(record);
    return verifyPending(record);
  }

  async function ensureFresh(clientId) {
    if (inFlight.has(clientId)) return inFlight.get(clientId);
    const work = (async () => {
      const r = await renew(clientId);
      if (!planUsageGranted(r.scopes)) throw error('sharing_not_enabled');
      if (r.credentials.expiresAt <= now()) throw error('refresh_not_ready');
      return r.credentials.accessToken;
    })();
    inFlight.set(clientId, work);
    try { return await work; } finally { if (inFlight.get(clientId) === work) inFlight.delete(clientId); }
  }
  return Object.freeze({ saveConnected, ensureFresh, getStatus: clientId => publicStatus(store.load(clientId)) });
}
