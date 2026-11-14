import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTBackendProvider } from '../../bridge/byok/auth/chatgpt-backend-provider.mjs';

const status = { ok: true, status: 'connected', sharing: true };
const service = {
  status: () => status,
  models: async () => ({ ok: true, models: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }),
  async *streamResponse(request) {
    assert.equal(request.model, 'gpt-a');
    yield { type: 'text', delta: 'For the Horde' };
    yield { type: 'done', finish: 'stop' };
  },
};
const collect = async gen => { const out = []; for await (const ev of gen) out.push(ev); return out; };

test('backend adapter uses model discovery and established stream events', async () => {
  const p = createChatGPTBackendProvider(() => service);
  assert.equal(p.usable(), true);
  assert.deepEqual(await p.validate(), { ok: true, models: ['gpt-a', 'gpt-b'] });
  assert.deepEqual(await collect(p.stream({ model: 'gpt-a' })), [
    { type: 'text', delta: 'For the Horde' }, { type: 'done', finish: 'stop' },
  ]);
});
test('no subscription permission does not fall back to the API-key provider', async () => {
  const p = createChatGPTBackendProvider(() => ({ ...service, status: () => ({ ...status, sharing: false }) }));
  assert.equal(p.usable(), false);
  assert.equal((await p.validate()).error.code, 'sign_in_required');
  assert.equal((await collect(p.stream({ model: 'gpt-a' })))[0].error.kind, 'no_key');
  const missing = createChatGPTBackendProvider(() => null);
  assert.equal((await missing.validate()).ok, false);
});
test('model discovery errors and streaming failures return sanitized provider errors', async () => {
  const p = createChatGPTBackendProvider(() => ({
    ...service, models: async () => { throw Error('private-token!'); },
    async *streamResponse() { throw Error('private-token!'); },
  }));
  assert.equal((await p.validate()).error.code, 'model_discovery_failed');
  const events = await collect(p.stream({ model: 'gpt-a' }));
  assert.equal(events[0].error.code, 'subscription_unavailable');
  assert.equal(JSON.stringify(events).includes('private-token!'), false);
});
