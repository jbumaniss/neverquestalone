import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLocalBackend, settingsOf } from '../../bridge/byok/backend.mjs';
import { createAppApi } from '../../bridge/byok/app-api.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { configWithDefaults } from '../../bridge/config.mjs';
import { tmpDir, sendParams, waitFor, CANARY_KEYS } from './helpers/byok-env.mjs';

const CHAT = 'c3f9a1e';
const makeAccount = (overrides = {}) => ({
  status: () => ({ ok: true, status: 'connected', sharing: true }),
  models: async () => ({ ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] }),
  // providers() deliberately reads only cached model metadata; it does not perform network discovery.
  cachedModels: () => [{ id: 'gpt-test', name: 'GPT Test' }],
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
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-test' }), { ok: true, model: 'gpt-test', effort: null });
  assert.deepEqual(updates.at(-1), { provider: 'openai', model: 'gpt-test', effort: null, auth: 'oauth' });
  assert.equal(writes.at(-1).byok.auth, 'oauth');
  assert.equal((await api.providers()).find(p => p.id === 'openai').auth, 'oauth');
  const openai = (await api.providers()).find(p => p.id === 'openai');
  assert.deepEqual(openai.models.map(m => m.id), ['gpt-test']);
  assert.ok(openai.apiModels.length > 0, 'existing API-key models remain available');
  assert.equal(openai.key.saved, true, 'saved Platform key remains visible for explicit key mode');
  await api.choose({ provider: 'openai', model: 'gpt-6-luna', effort: null });
  assert.equal(config.byok.auth, 'key', 'returning to Platform requires explicit key choice');
  assert.equal(await keystore.get('openai'), CANARY_KEYS.openai);
});


test('a forged OAuth flag cannot switch Anthropic or another API-key provider to bearer auth', () => {
  assert.equal(settingsOf({ provider: 'anthropic', auth: 'oauth' }).auth, 'key');
  assert.equal(settingsOf({ provider: 'google', auth: 'oauth' }).auth, 'key');
  assert.equal(settingsOf({ provider: 'openai', auth: 'oauth' }).auth, 'oauth');
  assert.equal(settingsOf({ provider: 'openai', auth: 'key' }).auth, 'key');
});


test('ChatGPT Thinking reuses the manifest levels, defaults to Medium, and rejects unsupported values', async t => {
  const dataDir = tmpDir('nqa-chatgpt-thinking-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configWithDefaults({ byok: { provider: 'anthropic', model: 'claude-sonnet-5-5', auth: 'key' } });
  const changes = [];
  const account = makeAccount({
    models: async () => ({ ok: true, models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] }),
    cachedModels: () => [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
  });
  const api = createAppApi({
    backend: { setConfig: async next => { changes.push(next); return next; } },
    config, keystore: createKeyStore({ backend: 'memory' }),
    chatgpt: () => account, paths: { userData: dataDir }, saveConfig: () => {},
  });
  t.after(() => api.stop?.());
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-6.1-sol', effort: 'off' }),
    { ok: false, error: 'invalid_effort' });
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-6.1-sol', effort: 'minimal' }),
    { ok: false, error: 'invalid_effort' });
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-6.1-sol', effort: 'nonsense' }),
    { ok: false, error: 'invalid_effort' });
  assert.equal(changes.length, 0, 'invalid effort must not modify saved provider configuration');
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-6.1-sol' }),
    { ok: true, model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(changes.at(-1), { provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium', auth: 'oauth' });
  assert.deepEqual(await api.chooseChatGPT({ model: 'gpt-6.1-sol', effort: 'high' }),
    { ok: true, model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(changes.at(-1), { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high', auth: 'oauth' });
  const openai = (await api.providers()).find(p => p.id === 'openai');
  assert.equal(openai.auth, 'oauth');
  assert.equal(openai.models[0].effort, true);
  assert.deepEqual(openai.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(openai.models[0].priceHint, null, 'subscription UI must not show Platform token pricing');
});


test('per-chat ChatGPT model selection uses only the verified subscription catalog', async t => {
  const dataDir = tmpDir('nqa-chatgpt-chat-model-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const slug = 'future/' + 'x'.repeat(90) + '~preview';
  const account = makeAccount({
    cachedModels: () => [{ id: slug, name: 'Future preview' }, { id: 'gpt-test', name: 'GPT Test' }],
    models: async () => ({ ok: true, models: [{ id: slug }, { id: 'gpt-test' }] }),
  });
  const backend = createLocalBackend({}, {
    config: configWithDefaults({ byok: { provider: 'openai', model: 'gpt-test', auth: 'oauth' } }),
    dataDir, keystore: createKeyStore({ backend: 'memory' }), chatgpt: () => account,
    manifests: loadManifests(), checks: { models: false },
  });
  try {
    await backend.start();
    assert.deepEqual(backend.setChatModel(CHAT, slug), { ok: true, model: slug });
    assert.equal(backend.chatSlot(CHAT).model, slug);
    assert.deepEqual(backend.setChatModel(CHAT, 'gpt-6-astra'),
      { ok: false, error: 'unknown_model' }, 'API-key-only model is not offered to this account');
    assert.deepEqual(backend.setChatModel(CHAT, '\u0000forged'),
      { ok: false, error: 'bad_model' });
    assert.deepEqual(backend.setChatModel(CHAT, null), { ok: true, model: null });
  } finally { await backend.stop(); }
});

test('expired account model never switches automatically to a Platform API model', async t => {
  const dataDir = tmpDir('nqa-chatgpt-retired-model-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const account = makeAccount({
    models: async () => ({ ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] }),
  });
  const backend = createLocalBackend({}, {
    config: configWithDefaults({ byok: { provider: 'openai', model: 'gpt-6.1-sol', auth: 'oauth' } }),
    dataDir, keystore: createKeyStore({ backend: 'memory' }), chatgpt: () => account,
    manifests: loadManifests(),
  });
  try {
    await backend.start();
    const checked = await backend.checkModel();
    assert.equal(checked?.switched, false);
    assert.equal(backend.slotExtras().bridge.provider.model, 'gpt-6.1-sol');
    assert.equal(backend.slotExtras().bridge.provider.auth, 'oauth');
  } finally { await backend.stop(); }
});
