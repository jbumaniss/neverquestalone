import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { createAppApi } from '../../bridge/byok/app-api.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { configWithDefaults } from '../../bridge/config.mjs';
import { tmpDir, sendParams, waitFor, CANARY_KEYS } from './helpers/byok-env.mjs';

const CHAT = 'c3f9a1e';
const makeAccount = (overrides = {}) => ({
  status: () => ({ ok: true, status: 'connected', sharing: true }),
  models: async () => ({ ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] }),
  async *streamResponse(req) {
    yield { type: 'text', delta: 'The quest is in Mulgore.' };
    yield { type: 'usage', usage: { input: 10, output: 6, exact: false } };
    yield { type: 'done', finish: 'stop' };
  },
  ...overrides,
});

test('WoW replies use the selected ChatGPT subscription route without accessing the API key', async (t) => {
  const dataDir = tmpDir('nqa-chatgpt-backend-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const keys = createKeyStore({ backend: 'memory' });
  await keys.set('openai', CANARY_KEYS.openai);
  let keyReads = 0, calls = 0;
  const keystore = {
    get: async id => { keyReads++; return keys.get(id); },
    list: async ids => keys.list(ids),
  };
  const account = makeAccount({
    async *streamResponse(req) {
      calls++;
      assert.equal(req.model, 'gpt-test');
      assert.equal(req.messages.at(-1).role, 'user');
      yield { type: 'text', delta: 'The quest is in Mulgore.' };
      yield { type: 'usage', usage: { input: 10, output: 6, exact: false } };
      yield { type: 'done', finish: 'stop' };
    },
  });
  const events = [];
  const config = configWithDefaults({ byok: { provider: 'openai', model: 'gpt-test', auth: 'oauth', effort: null } });
  const backend = createLocalBackend({ onEvent: e => events.push(e) }, {
    config, dataDir, keystore, chatgpt: () => account,
    manifests: loadManifests(), checks: { models: false },
    fetch: async () => { throw Error('API key network path must not be called'); },
  });
  try {
    await backend.start();
    assert.equal(backend.slotExtras().bridge.provider.auth, 'oauth');
    assert.equal(backend.slotExtras().rt.state, 'ready');
    assert.equal(backend.slotExtras().bridge.provider.name, 'ChatGPT');
    const sent = backend.send(sendParams(CHAT, 'sub_1', 'Where is the quest?'));
    assert.equal(sent.status, 'started');
    const final = await waitFor(() => events.find(e => e.event === 'chat' && e.payload?.state === 'final'), 5000, 'ChatGPT final');
    assert.match(final.payload.message.content[0].text, /Mulgore/);
    assert.equal(final.payload.usage.micros, 0, 'no API-key usage cost');
    assert.equal(calls, 1);
    assert.equal(keyReads, 0, 'no Platform key was accessed');
    assert.equal(await keys.get('openai'), CANARY_KEYS.openai, 'the original API key remains saved');
  } finally { await backend.stop(); }
});

test('missing or unpermitted ChatGPT sessions remain no_key, never use saved Platform credentials', async (t) => {
  const dataDir = tmpDir('nqa-chatgpt-permissions-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configWithDefaults({ byok: { provider: 'openai', model: 'gpt-test', auth: 'oauth' } });
  const backend = createLocalBackend({}, {
    config, dataDir, keystore: { get: async () => { throw Error('must not access API key'); }, list: async () => ['openai'] },
    chatgpt: () => makeAccount({ status: () => ({ ok: true, status: 'connected', sharing: false }) }),
    checks: { models: false },
  });
  try {
    await backend.start();
    assert.equal(backend.slotExtras().rt.state, 'no_key');
    assert.equal(backend.slotExtras().bridge.provider.keyState, 'missing');
  } finally { await backend.stop(); }
});

test('app chooses only models returned by ChatGPT, persists OAuth mode and switches back to key explicitly', async (t) => {
  const dataDir = tmpDir('nqa-chatgpt-selection-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configWithDefaults({ byok: { provider: 'anthropic', model: 'claude-sonnet-5-5', auth: 'key' } });
  const keystore = createKeyStore({ backend: 'memory' });
  await keystore.set('openai', CANARY_KEYS.openai);
  const updates = [], writes = [];
  const backend = {
    setConfig: async change => { updates.push(change); return change; },
    refresh: async () => ({ ok: true }),
    status: () => ({ provider: { id: config.byok.provider, auth: config.byok.auth } }),
  };
  const account = makeAccount();
  const api = createAppApi({
    backend, config, keystore, chatgpt: () => account,
    paths: { userData: dataDir },
    saveConfig: value => writes.push(structuredClone(value)),
  });
  t.after(() => api.stop?.());
  assert.deepEqual(await api.chooseChatGPT({ model: 'not-granted' }), { ok: false, error: 'unknown_model' });
  assert.equal(config.byok.provider, 'anthropic');
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-test' }), { ok: true, model: 'gpt-test' });
  assert.deepEqual(updates.at(-1), { provider: 'openai', model: 'gpt-test', effort: null, auth: 'oauth' });
  assert.equal(writes.at(-1).byok.auth, 'oauth');
  assert.equal((await api.providers()).find(p => p.id === 'openai').auth, 'oauth');
  assert.deepEqual((await api.providers()).find(p => p.id === 'openai').models.map(m => m.id), ['gpt-test']);
  await api.choose({ provider: 'openai', model: 'gpt-6-luna', effort: null });
  assert.equal(config.byok.auth, 'key', 'returning to Platform requires explicit key choice');
  assert.equal(await keystore.get('openai'), CANARY_KEYS.openai);
});
