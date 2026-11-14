// ChatGPT subscription connection controls: these are separate from API-key providers.
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

test('Your AI keeps legacy layout when ChatGPT integration is absent', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider' });
  assert.equal(row(rig), null);
  assert.deepEqual(rig.document.querySelectorAll('#page .set-key').map(e => e.textContent),
    ['AI', 'Key', 'Model', 'Today', 'Daily limit']);
});

test('ChatGPT sign-in is separate from an OpenAI API key and never changes the selected AI', async () => {
  let status = { ok: true, status: 'disconnected', sharing: false };
  const chatgpt = {
    status: () => status,
    signIn: async () => {
      status = { ok: true, status: 'connected', sharing: true,
        clientId: 'oaiapp_testclient123', subject: 'safe-subject' };
      return status;
    },
    disconnect: () => { status = { ok: true, status: 'disconnected', sharing: false }; return status; },
    cancelSignIn: () => ({ ok: true }),
    models: async () => ({ ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] }),
  };
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt });
  assert.match(row(rig).textContent, /ChatGPT accountNot connected/);
  assert.ok(action(rig, 'chatgpt-signin'));
  await rig.press(action(rig, 'chatgpt-signin'));
  assert.match(row(rig).textContent, /Connected/);
  assert.match(row(rig).textContent, /Choose a model to use ChatGPT in WoW/);
  assert.ok(action(rig, 'chatgpt-use'));
  let useModel = null;
  rig.ctx.api.chooseChatGPT = async ({ model }) => { useModel = model; return { ok: true, model }; };
  await rig.press(action(rig, 'chatgpt-use'));
  assert.equal(useModel, 'gpt-test');
  assert.ok(!row(rig).textContent.includes('safe-subject'));
  assert.match(rig.document.getElementById('ai-row').textContent, /Claude/);
  assert.ok(action(rig, 'chatgpt-disconnect'));
  await rig.press(action(rig, 'chatgpt-disconnect'));
  assert.match(row(rig).textContent, /Not connected/);
  assert.equal(rig.confirms.length, 3);
});

test('missing plan permission and unavailable encryption are displayed without pretending to connect', async () => {
  const noPermission = await pageRig({
    state: READY, hash: 'provider', chatgpt: {
      status: () => ({ ok: true, status: 'connected', sharing: false }),
    },
  });
  assert.match(row(noPermission).textContent, /plan permission not granted/);
  const noEncryption = await pageRig({
    state: READY, hash: 'provider', chatgpt: {
      status: () => ({ ok: false, error: 'storage_unavailable' }),
    },
  });
  assert.match(row(noEncryption).textContent, /Secure ChatGPT sign-in is unavailable/);
  assert.equal(action(noEncryption, 'chatgpt-signin'), null);
});


test('model discovery errors show safe HTTP status and can be retried', async () => {
  let status = { ok: true, status: 'connected', sharing: true };
  let attempts = 0;
  const chatgpt = {
    status: () => status,
    models: async () => ++attempts === 1
      ? { ok: false, error: 'service_unavailable', httpStatus: 520 }
      : { ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] },
    signIn: async () => ({ ok: true }),
    disconnect: () => ({ ok: true }),
  };
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt });
  assert.match(row(rig).textContent, /Could not load ChatGPT models\. \(HTTP 520\)/);
  assert.equal(action(rig, 'chatgpt-use'), null, 'do not allow model activation on discovery error');
  assert.ok(action(rig, 'chatgpt-retry-models'));
  await rig.press(action(rig, 'chatgpt-retry-models'));
  assert.equal(attempts, 2);
  assert.ok(action(rig, 'chatgpt-use'));
  assert.ok(!row(rig).textContent.includes('HTTP 520'));
});

test('empty model catalog shows an explanation and retry, not a misleading model picker', async () => {
  const rig = await pageRig({ state: READY, hash: 'provider', chatgpt: {
    status: () => ({ ok: true, status: 'connected', sharing: true }),
    models: async () => ({ ok: true, models: [] }),
  } });
  assert.match(row(rig).textContent, /No ChatGPT models available/);
  assert.ok(action(rig, 'chatgpt-retry-models'));
  assert.equal(action(rig, 'chatgpt-use'), null);
});
