import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatGPTConnection } from '../../bridge/byok/auth/chatgpt-connection.mjs';

const CLIENT = 'oaiapp_testclient123';
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: bytes => {
      const iv = bytes.subarray(0, 12);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(fn, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-chatgpt-connect-'));
  fs.chmodSync(root, 0o700);
  const visits = [];
  const exchangeCalls = [];
  const listeners = [];
  const secure = overrides.encryption ?? encryption();
  const callback = overrides.callback ?? { code: 'one-time-code', clientId: CLIENT };
  const startCallback = overrides.startCallback ? () => overrides.startCallback(listeners) : (async () => {
    const listener = {
      redirectUri: 'http://127.0.0.1:49123/auth/callback',
      waitForCallback: tx => { listener.transaction = tx; return Promise.resolve(callback); },
      cancel() { listener.cancelled = true; },
      close() { listener.closed = true; },
    };
    listeners.push(listener);
    return listener;
  });
  const openBrowser = overrides.openBrowser ?? (async uri => { visits.push(uri); });
  const exchangeCode = overrides.exchangeCode ?? (async args => {
    exchangeCalls.push(args);
    return {
      identity: { subject: 'stable-user', clientId: args.callback.clientId, email: 'private@example.org' },
      scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      credentials: { accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'private-id-token', expiresAt: Date.now() + 3600_000 },
    };
  });
  const make = () => createChatGPTConnection({
    userData: root, encryption: secure, openBrowser,
    startCallback, exchangeCode, fetchFn: overrides.fetchFn ?? (async () => { throw Error('unexpected remote request'); }),
  });
  try { return await fn({ root, make, listeners, visits, exchangeCalls, secure }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('opens a pinned OpenAI sign-in URL and returns status, never credentials', () => fixture(async ({ root, make, visits, listeners }) => {
  const service = make();
  assert.deepEqual(service.status(), { ok: true, status: 'disconnected', sharing: false });
  const result = await service.signIn();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'connected');
  assert.equal(result.sharing, true);
  assert.equal(result.clientId, CLIENT);
  assert.equal(result.subject, 'stable-user');
  assert.equal(visits.length, 1);
  assert.equal(new URL(visits[0]).origin, 'https://auth.openai.com');
  assert.equal(new URL(visits[0]).searchParams.get('client_id'), 'dynamic_agent_client');
  assert.ok(!JSON.stringify(result).includes('secret-access'));
  assert.equal(listeners[0].closed, true);
  assert.equal(await service.accessToken(), 'secret-access');
  const files = fs.readdirSync(path.join(root, 'chatgpt', 'credentials'));
  assert.deepEqual(files, ['client-' + CLIENT + '.bin']);
  assert.ok(!fs.readFileSync(path.join(root, 'chatgpt', 'credentials', files[0])).includes(Buffer.from('secret-access')));
}));

test('reconnect uses issued client identity and validates the same account', () => fixture(async ({ make, visits, exchangeCalls }) => {
  const first = make();
  assert.equal((await first.signIn()).ok, true);
  const afterRestart = make();
  assert.equal(afterRestart.status().status, 'connected');
  assert.equal((await afterRestart.signIn()).ok, true);
  assert.equal(new URL(visits[1]).searchParams.get('client_id'), CLIENT);
  assert.equal(exchangeCalls[1].expectedSubject, 'stable-user');
  assert.equal(await afterRestart.accessToken(), 'secret-access');
}));

test('disconnect removes credentials and returns disconnected status', () => fixture(async ({ make }) => {
  const service = make();
  await service.signIn();
  assert.deepEqual(service.disconnect(), { ok: true, status: 'disconnected', sharing: false });
  assert.deepEqual(service.status(), { ok: true, status: 'disconnected', sharing: false });
  await assert.rejects(service.accessToken(), /sign-in required/);
}));

test('refuses browser launch failures without activating credentials', () => fixture(async ({ make, listeners }) => {
  const service = make();
  assert.deepEqual(await service.signIn(), { ok: false, error: 'open_browser_failed' });
  assert.equal(listeners[0].cancelled, true);
  assert.equal(service.status().status, 'disconnected');
}, { openBrowser: async () => { throw Error('browser refused'); } }));

test('unavailable encryption blocks sign-in without falling back to plaintext', () => fixture(async ({ make }) => {
  const service = make();
  assert.deepEqual(service.status(), { ok: false, error: 'storage_unavailable' });
  assert.deepEqual(await service.signIn(), { ok: false, error: 'sign_in_failed' });
}, { encryption: { ...encryption(), isEncryptionAvailable: () => false } }));

test('refuses overlapping sign-ins and allows explicit cancellation', () => fixture(async ({ make, listeners }) => {
  const service = make();
  const first = service.signIn();
  // startCallback and openBrowser yield at microtask boundaries.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await service.signIn(), { ok: false, error: 'busy' });
  assert.deepEqual(service.cancelSignIn(), { ok: true });
  assert.equal(listeners[0].cancelled, true);
  assert.deepEqual(await first, { ok: false, error: 'sign_in_failed' });
}, { startCallback: async listeners => {
  let rejectWaiting;
  const listener = {
    redirectUri: 'http://127.0.0.1:49123/auth/callback',
    waitForCallback: () => new Promise((_, reject) => { rejectWaiting = reject; }),
    cancel() { listener.cancelled = true; rejectWaiting?.(new Error('cancelled')); },
    close() { listener.closed = true; },
  };
  listeners.push(listener);
  return listener;
} }));


test('model discovery is account-scoped and returns no secrets to the UI', () => fixture(async ({ make }) => {
  const service = make();
  assert.equal((await service.models()).error, 'sign_in_required');
  await service.signIn();
  const result = await service.models();
  assert.deepEqual(result, { ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] });
  assert.ok(!JSON.stringify(result).includes('secret-access'));
  service.disconnect();
  assert.equal((await service.models()).error, 'sign_in_required');
}, {
  fetchFn: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(init.headers.authorization, 'Bearer secret-access');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ models: [
      { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
    ] }), { headers: { 'content-type': 'application/json' } });
  },
}));
