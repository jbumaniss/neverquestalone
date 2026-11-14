// Direct ChatGPT plan inference transport (not OpenAI Platform API-key billing).
// Trusted local process only. A provided accessToken() obtains the verified,
// refreshed OAuth token. This module never logs or returns credential material.
import { responsesParse } from '../providers/adapters/openai.mjs';
import { systemText } from '../providers/util.mjs';
import { makeError } from '../providers/errors.mjs';

export const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models';
export const CHATGPT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const MAX_CATALOG_BYTES = 256 * 1024;
const MODEL_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 180_000;

function fault(code, status = undefined) {
  const err = new Error('ChatGPT plan: ' + code);
  err.code = code;
  if (Number.isInteger(status)) err.status = status;
  return err;
}
function signalFor(signal, timeout) {
  const limit = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}
function statusError(status) {
  if (status === 401) return 'sign_in_required';
  if (status === 403) return 'plan_permission_denied';
  if (status === 429) return 'plan_usage_limited';
  return 'service_unavailable';
}
function providerError(code, status) {
  const kind = code === 'sign_in_required' ? 'auth_invalid'
    : code === 'plan_permission_denied' ? 'region_blocked'
    : code === 'plan_usage_limited' ? 'rate_limited'
    : 'unknown';
  return makeError({ provider: 'openai', kind, status, code, retryable: false });
}
async function jsonLimited(response) {
  if (!response?.body) throw fault('invalid_model_catalog');
  let length = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const bytes of response.body) {
      length += bytes.byteLength;
      if (length > MAX_CATALOG_BYTES) throw fault('invalid_model_catalog');
      text += decoder.decode(bytes, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { throw fault('invalid_model_catalog'); }
}

/**
 * listModels() discovers the models granted to this ChatGPT account.
 * stream() accepts the bridge's ordinary {model, system, messages, maxTokens}
 * request and emits its existing {text, usage, done, error} stream events.
 */
export function createChatGPTDirect({ accessToken, fetchFn = globalThis.fetch } = {}) {
  if (typeof accessToken !== 'function' || typeof fetchFn !== 'function') {
    throw new TypeError('ChatGPT direct transport needs credential access and fetch');
  }
  let models = null;
  let validUntil = 0;

  async function listModels({ signal, fresh = false } = {}) {
    if (!fresh && models && Date.now() < validUntil) return models.map(m => ({ ...m }));
    const token = await accessToken();
    if (typeof token !== 'string' || !token || /[\s\u0000-\u001f\u007f]/.test(token)) throw fault('sign_in_required');
    let response;
    try {
      response = await fetchFn(CHATGPT_MODELS_URL, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
        signal: signalFor(signal, MODEL_TIMEOUT_MS),
      });
    } catch {
      throw fault(signal?.aborted ? 'cancelled' : 'service_unavailable');
    }
    if (!response.ok) throw fault(statusError(response.status), response.status);
    const body = await jsonLimited(response);
    if (!body || !Array.isArray(body.models) || body.models.length > 500) throw fault('invalid_model_catalog');
    const seen = new Set();
    const catalog = [];
    for (const m of body.models) {
      if (!m || m.visibility !== 'list') continue;
      if (typeof m.slug !== 'string' || !MODEL.test(m.slug) ||
          typeof m.display_name !== 'string' || !m.display_name.trim() || m.display_name.length > 200) {
        throw fault('invalid_model_catalog');
      }
      if (!seen.has(m.slug)) {
        seen.add(m.slug);
        catalog.push({ id: m.slug, name: m.display_name });
      }
    }
    models = catalog;
    validUntil = Date.now() + 5 * 60_000;
    return catalog.map(m => ({ ...m }));
  }

  async function* stream(req, { signal } = {}) {
    const model = req?.model;
    if (typeof model !== 'string' || !MODEL.test(model)) {
      yield { type: 'error', error: providerError('invalid_model') };
      return;
    }
    const messages = req?.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200 ||
        messages.some(m => !m || !['developer', 'user', 'assistant'].includes(m.role) ||
          typeof m.content !== 'string' || m.content.length > 200_000)) {
      yield { type: 'error', error: providerError('invalid_request_shape') };
      return;
    }
    if (req.system != null && !Array.isArray(req.system)) {
      yield { type: 'error', error: providerError('invalid_request_shape') };
      return;
    }
    const instructions = systemText(req.system);
    if (instructions && (typeof instructions !== 'string' || instructions.length > 200_000)) {
      yield { type: 'error', error: providerError('invalid_request_shape') };
      return;
    }
    let permitted;
    try { permitted = await listModels({ signal }); }
    catch (e) {
      yield { type: 'error', error: providerError(e?.code || 'service_unavailable', e?.status) };
      return;
    }
    if (!permitted.some(m => m.id === model)) {
      yield { type: 'error', error: providerError('model_not_available') };
      return;
    }
    let token;
    try { token = await accessToken(); }
    catch {
      yield { type: 'error', error: providerError('sign_in_required') };
      return;
    }
    const body = {
      model, input: messages.map(m => ({ role: m.role, content: m.content })),
      ...(instructions ? { instructions } : {}),
      store: false, stream: true,
    };
    // The ChatGPT plan preview rejects max_output_tokens, unlike Platform API keys.
    let response;
    try {
      response = await fetchFn(CHATGPT_RESPONSES_URL, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token,
          'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body), signal: signalFor(signal, RESPONSE_TIMEOUT_MS),
      });
    } catch {
      yield { type: 'error', error: providerError(signal?.aborted ? 'cancelled' : 'service_unavailable') };
      return;
    }
    if (!response.ok) {
      yield { type: 'error', error: providerError(statusError(response.status), response.status) };
      return;
    }
    const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0]?.trim()?.toLowerCase();
    if (!response.body || (contentType && contentType !== 'text/event-stream')) {
      yield { type: 'error', error: providerError('invalid_response_stream') };
      return;
    }
    // Use NeverQuestAlone's established Responses event parser instead of
    // duplicating SSE semantics. Only response.completed yields successful done.
    try {
      for await (const event of responsesParse(response, {
        fail: data => {
          const code = data?.response?.error?.code ?? data?.error?.code;
          return providerError(code === 'subscription_sharing_usage_limit_exceeded' ||
            code === 'subscription_sharing_usage_unavailable' ? 'plan_usage_limited' : 'response_failed');
        },
        truncated: () => providerError('response_interrupted'),
      })) {
        // The standard API adapter reports response.incomplete as done(length).
        // ChatGPT plan inference must only finish on response.completed.
        if (event.type === 'done' && event.finish !== 'stop' && event.finish !== 'refusal') {
          yield { type: 'error', error: providerError('response_incomplete') };
          return;
        }
        yield event;
      }
    } catch {
      yield { type: 'error', error: providerError('response_interrupted') };
    }
  }

  return Object.freeze({
    listModels, stream,
    invalidateModels() { models = null; validUntil = 0; },
  });
}
