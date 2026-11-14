// Adapter for the existing BYOK backend: ChatGPT subscription is a distinct
// authorization route for OpenAI, never a fallback to an OpenAI Platform key.
import { makeError } from '../providers/errors.mjs';

function issue(code, kind = 'no_key') {
  return makeError({ provider: 'openai', kind, code, retryable: false });
}
function connection(getChatGPT) {
  try { return typeof getChatGPT === 'function' ? getChatGPT() : null; }
  catch { return null; }
}
function ready(instance) {
  try {
    const status = instance?.status?.();
    return status?.ok === true && status.status === 'connected' && status.sharing === true;
  } catch { return false; }
}

/** A provider whose credentials can only originate from the verified OAuth store. */
export function createChatGPTBackendProvider(getChatGPT) {
  const usable = () => ready(connection(getChatGPT));
  return Object.freeze({
    usable,
    async validate() {
      const client = connection(getChatGPT);
      if (!ready(client)) return { ok: false, error: issue('sign_in_required') };
      try {
        const response = await client.models();
        if (response?.ok !== true || !Array.isArray(response.models)) {
          return { ok: false, error: issue(response?.error ?? 'model_discovery_failed', 'unknown') };
        }
        return { ok: true, models: response.models
          .filter(m => typeof m?.id === 'string').map(m => m.id) };
      } catch { return { ok: false, error: issue('model_discovery_failed', 'unknown') }; }
    },
    async *stream(req, options = {}) {
      const client = connection(getChatGPT);
      if (!ready(client)) {
        yield { type: 'error', error: issue('sign_in_required') };
        return;
      }
      if (typeof client.streamResponse !== 'function') {
        yield { type: 'error', error: issue('subscription_unavailable', 'unknown') };
        return;
      }
      try { yield* client.streamResponse(req, options); }
      catch { yield { type: 'error', error: issue('subscription_unavailable', 'unknown') }; }
    },
  });
}
