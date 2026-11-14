// ChatGPT plan authentication uses the existing provider Switch and model list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageRig } from './helpers/page-rig.mjs';

const READY = {
  keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } },
  choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null },
  addonInstalled: true,
};
const row = rig => rig.document.getElementById('chatgpt-row');
const action = (rig, name) => rig.document.querySelector('[data-fk="' + name + '"]');
const catalog = [{ id: 'gpt-test', name: 'GPT Test' }, { id: 'gpt-another', name: 'Another GPT' }];
const service = overrides => ({
  status: () => ({ ok: true, status: 'connected', sharing: true }),
  models: async () => ({ ok: true, models: catalog }),
  signIn: async () => ({ ok: true, status: 'connected' }),
  disconnect: () => ({ ok: true, status: 'disconnected' }),
  cancelSignIn: () => ({ ok: true }),
  ...overrides,
});
async function pickOpenAI(rig) {
  await rig.press(action(rig, 'change-ai'));
  await rig.press(action(rig, 'card-openai'));
}

test('Your AI keeps the existing layout; no duplicate ChatGPT model/account card', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service() });
  assert.equal(row(rig), null);
  assert.deepEqual(rig.document.querySelectorAll('#page .set-key').map(e => e.textContent),
    ['AI', 'Key', 'Model', 'Today', 'Daily limit']);
  await pickOpenAI(rig);
  assert.ok(action(rig, 'openai-auth-key'));
  assert.ok(action(rig, 'openai-auth-oauth'));
  assert.ok(row(rig));
  assert.ok(action(rig, 'chatgpt-use'));
  assert.ok(action(rig, 'model-gpt-test'));
  assert.equal(action(rig, 'model-gpt-another'), null, 'shared picker starts with a short list');
  assert.ok(action(rig, 'all-models'));
  await rig.press(action(rig, 'all-models'));
  assert.ok(action(rig, 'model-gpt-another'), 'remaining models appear after Show all models');
});

test('Switch uses one provider picker with API key or ChatGPT plan modes', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service() });
  await pickOpenAI(rig);
  await rig.press(action(rig, 'openai-auth-key'));
  assert.equal(action(rig, 'chatgpt-use'), null);
  assert.ok(action(rig, 'paste-key'), 'existing API key flow is reused');
  await rig.press(action(rig, 'openai-auth-oauth'));
  assert.equal(action(rig, 'paste-key'), null, 'OAuth must never be pasted as an API key');
  assert.ok(action(rig, 'chatgpt-use'));
  let selected = null;
  rig.ctx.api.chooseChatGPT = async ({ model }) => { selected = model; return { ok: true, model }; };
  await rig.press(action(rig, 'chatgpt-use'));
  assert.equal(selected, 'gpt-test');
  assert.equal(rig.confirms.length, 1, 'native consent required before activating ChatGPT');
});

test('model discovery never blocks the Your AI page or Claude Switch selection', async () => {
  let resolveModels;
  let calls = 0;
  const pending = new Promise(resolve => { resolveModels = resolve; });
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    models: () => { calls++; return pending; },
  }) });
  assert.ok(action(rig, 'change-ai'));
  assert.equal(calls, 0);
  await rig.press(action(rig, 'change-ai'));
  assert.equal(calls, 0);
  await rig.press(action(rig, 'card-openai'));
  assert.equal(calls, 1);
  assert.match(rig.document.querySelector('#page').textContent, /Loading models/);
  resolveModels({ ok: true, models: catalog });
  await rig.settle(20);
  assert.ok(action(rig, 'chatgpt-use'));
});

test('model discovery failures are visible and retryable in Switch, never fall back to API models', async () => {
  let calls = 0;
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    models: async () => ++calls === 1
      ? { ok: false, error: 'service_unavailable', httpStatus: 520 }
      : { ok: true, models: catalog },
  }) });
  await pickOpenAI(rig);
  assert.match(rig.document.querySelector('#page').textContent, /HTTP 520/);
  assert.equal(action(rig, 'chatgpt-use'), null);
  await rig.press(action(rig, 'chatgpt-retry-models'));
  assert.equal(calls, 2);
  assert.ok(action(rig, 'chatgpt-use'));
});

test('disconnected and missing-plan-permission OAuth accounts cannot activate a model', async () => {
  const disconnected = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    status: () => ({ ok: true, status: 'disconnected', sharing: false }),
  }) });
  await pickOpenAI(disconnected);
  await disconnected.press(action(disconnected, 'openai-auth-oauth'));
  assert.match(row(disconnected).textContent, /Not connected/);
  assert.ok(action(disconnected, 'chatgpt-signin'));
  assert.equal(action(disconnected, 'chatgpt-use'), null);
  const noPermission = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    status: () => ({ ok: true, status: 'connected', sharing: false }),
  }) });
  await pickOpenAI(noPermission);
  assert.match(row(noPermission).textContent, /plan permission not granted/);
  assert.equal(action(noPermission, 'chatgpt-use'), null);
});

test('unavailable credential encryption cannot show sign-in controls', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    status: () => ({ ok: false, error: 'storage_unavailable' }),
  }) });
  await pickOpenAI(rig);
  await rig.press(action(rig, 'openai-auth-oauth'));
  assert.match(row(rig).textContent, /Secure ChatGPT sign-in is unavailable/);
  assert.equal(action(rig, 'chatgpt-signin'), null);
  assert.equal(action(rig, 'chatgpt-use'), null);
});


test('safe model catalog diagnostic describes the failure without a second provider picker', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: service({
    models: async () => ({ ok: false, error: 'invalid_model_catalog', catalogReason: 'unexpected_shape' }),
  }) });
  await pickOpenAI(rig);
  assert.match(rig.document.querySelector('#page').textContent, /Unexpected model response structure/);
  assert.equal(action(rig, 'chatgpt-use'), null);
  assert.ok(action(rig, 'chatgpt-retry-models'));
});
