// Direct ChatGPT plan inference transport (not OpenAI Platform API-key billing).
// Trusted local process only. A provided accessToken() obtains the verified,
// refreshed OAuth token. This module never logs or returns credential material.
import { responsesParse } from '../providers/adapters/openai.mjs';
import { systemText } from '../providers/util.mjs';
import { makeError, cleanRequestId, classify, fetchErrorPhase, networkErrorCode, EGRESS_BLOCKED, EGRESS_STOPPED } from '../providers/errors.mjs';

export const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models';
export const CHATGPT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
// OpenAI's ChatGPT catalog permits opaque slugs up to 200 characters. Accept
// that documented shape while excluding control and bidi-format characters.
const MODEL = /^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]{1,200}$/u;
// One validated catalog identifier contract shared by the desktop, transport
// and the WoW per-chat model command. Never treat it as a credential.
export const isChatGPTModelId = value => typeof value === 'string' && MODEL.test(value) && !!value.trim();
const modelSlug = isChatGPTModelId;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 2000;
const MODEL_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 180_000;
const REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function fault(code, status = undefined, catalogReason = undefined) {
  const err = new Error('ChatGPT plan: ' + code);
  err.code = code;
  if (Number.isInteger(status)) err.status = status;
  if (catalogReason) err.catalogReason = catalogReason; // Fixed machine code only.
  return err;
}
function isEgressRefusal(error) {
  const code = networkErrorCode(error);
  return code === EGRESS_BLOCKED || code === EGRESS_STOPPED;
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
function providerError(code, status, egressCode = null) {
  if (code === 'egress_blocked') return makeError({
    kind: 'egress_blocked', provider: 'openai', code: egressCode ?? EGRESS_BLOCKED,
    ownHost: true, retryable: false,
  });
  const kind = code === 'sign_in_required' ? 'auth_invalid'
    : code === 'plan_permission_denied' ? 'region_blocked'
    : code === 'plan_usage_limited' ? 'rate_limited'
    : 'unknown';
  return makeError({ provider: 'openai', kind, status, code, retryable: false });
}
async function jsonLimited(response) {
  if (!response?.body) throw fault('invalid_model_catalog', undefined, 'empty_response');
  let length = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const bytes of response.body) {
      length += bytes.byteLength;
      if (length > MAX_CATALOG_BYTES) throw fault('invalid_model_catalog', undefined, 'response_too_large');
      text += decoder.decode(bytes, { stream: true });
    }
    text += decoder.decode();
  } catch (err) {
    if (err?.catalogReason === 'response_too_large') throw err;
    throw fault('invalid_model_catalog', undefined, 'unreadable_response');
  }
  try { return JSON.parse(text); }
  catch { throw fault('invalid_model_catalog', undefined, 'invalid_json'); }
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
    } catch (error) {
      if (isEgressRefusal(error)) {
        const denied = fault('egress_blocked');
        denied.egressCode = networkErrorCode(error);
        throw denied;
      }
      throw fault(signal?.aborted ? 'cancelled' : 'service_unavailable');
    }
    if (!response.ok) throw fault(statusError(response.status), response.status);
    const body = await jsonLimited(response);
    if (!body || !Array.isArray(body.models)) throw fault('invalid_model_catalog', undefined, 'unexpected_shape');
    if (body.models.length > MAX_MODELS) throw fault('invalid_model_catalog', undefined, 'too_many_models');
    const seen = new Set();
    const catalog = [];
    for (const m of body.models) {
      if (!m || m.visibility !== 'list') continue;
      if (!modelSlug(m.slug) ||
          typeof m.display_name !== 'string' || !m.display_name.trim() || m.display_name.length > 200) {
        throw fault('invalid_model_catalog', undefined, 'invalid_visible_model');
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

  // A credential-free probe, identical to the existing provider reach() contract.
  // Any HTTP response means that OpenAI's host is reachable.
  async function reach({ signal } = {}) {
    try {
      const response = await fetchFn(CHATGPT_MODELS_URL, {
        method: 'HEAD', redirect: 'error', signal: signalFor(signal, MODEL_TIMEOUT_MS),
      });
      return { ok: true, status: response.status };
    } catch (error) {
      return { ok: false, error: classify('openai', {
        networkPhase: fetchErrorPhase(error), networkError: error,
      }) };
    }
  }

  async function* stream(req, { signal, onRequest } = {}) {
    const model = req?.model;
    if (!modelSlug(model)) {
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
    if (req.effort != null && !REASONING_LEVELS.has(req.effort)) {
      yield { type: 'error', error: providerError('invalid_reasoning_effort') };
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
      const reason = e?.code ?? 'service_unavailable';
      if (reason === 'service_unavailable' || reason === 'refresh_unavailable') {
        yield { type: 'error', error: makeError({
          provider: 'openai', kind: 'network_before_send', code: 'model_discovery_unavailable',
          retryable: true,
        }) };
      } else if (reason === 'cancelled') {
        yield { type: 'error', error: makeError({ provider: 'openai',
          kind: 'interrupted', code: 'cancelled', retryable: false }) };
      } else {
        yield { type: 'error', error: providerError(reason, e?.status, e?.egressCode) };
      }
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
      ...(req.effort != null ? { reasoning: { effort: req.effort === 'off' ? 'none' : req.effort } } : {}),
      store: false, stream: true,
    };
    // Preserve the existing local Last Request diagnostic without leaking OAuth credentials.
    // The bridge owns when and how long the request snapshot can be retained.
    if (typeof onRequest === 'function') {
      try {
        onRequest({
          method: 'POST', url: CHATGPT_RESPONSES_URL,
          headers: { authorization: '(redacted)', 'content-type': 'application/json', accept: 'text/event-stream' },
          body: structuredClone(body),
        });
      } catch { /* diagnostics must not interrupt inference */ }
    }
    // The ChatGPT plan preview rejects max_output_tokens, unlike Platform API keys.
    let response;
    const transportSignal = signalFor(signal, RESPONSE_TIMEOUT_MS);
    try {
      response = await fetchFn(CHATGPT_RESPONSES_URL, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token,
          'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body), signal: transportSignal,
      });
    } catch (error) {
      const failure = signal?.aborted ? makeError({ provider: 'openai', kind: 'interrupted', code: 'cancelled', retryable: false })
        : transportSignal.aborted ? makeError({ provider: 'openai', kind: 'timeout', phase: 'request',
          afterMs: RESPONSE_TIMEOUT_MS, retryable: false })
          : classify('openai', { networkPhase: fetchErrorPhase(error), networkError: error });
      yield { type: 'error', error: failure };
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
    // The stream lifecycle is the same as for API-key providers. A 200 response
    // emits start before any text or reasoning, enabling retry and accounting.
    yield { type: 'start', requestId: cleanRequestId(response.headers?.get?.('x-request-id')) };
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
        // Convert parser event names into the existing backend contract.
        if (event.type === 'thinking') {
          if (event.active !== false) yield { type: 'reasoning' };
        } else if (event.type === 'progress') {
          if (event.reasoning === true) yield { type: 'reasoning' };
        } else {
          yield event;
        }
      }
    } catch {
      yield { type: 'error', error: providerError('response_interrupted') };
    }
  }

  return Object.freeze({
    listModels, reach, stream,
    // The last successfully verified catalog remains display-only after its
    // short network TTL. Choosing/streaming still revalidates against the server.
    cachedModels() { return models ? models.map(m => ({ ...m })) : null; },
    invalidateModels() { models = null; validUntil = 0; },
  });
}
