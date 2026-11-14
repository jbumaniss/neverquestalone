import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatGPTStore } from '../../bridge/byok/auth/chatgpt-store.mjs';
import { createChatGPTSessions } from '../../bridge/byok/auth/chatgpt-session.mjs';
import { CHATGPT_TOKEN_URL } from '../../bridge/byok/auth/chatgpt-oauth.mjs';

const clientId = 'oaiapp_testing123', hostId = 'urn:uuid:6081bf29-dae3-45d7-a1fe-8d49041dba5b';
const NOW = 1_800_000_000_000;
function secure() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]); },
    decryptString: b => { const iv = b.subarray(0, 12), c = crypto.createDecipheriv('aes-256-gcm', key, iv); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(); },
  };
}
async function setup(fn, {fetchFn = async () => { throw Error('unmocked request'); }, verifier = async (_, opts) => ({ clientId: opts.clientId, subject: opts.expectedSubject })} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-session-')); fs.chmodSync(root, 0o700);
  try {
    const store = createChatGPTStore({ directory: path.join(root, 'secure'), encryption: secure() });
    const sessions = createChatGPTSessions({ store, fetchFn, verifyIdToken: verifier, now: () => NOW });
    const save = ({ expiresAt = NOW + 50_000, earliestRefreshAt = undefined } = {}) => sessions.saveConnected({
      clientId, hostId, exchange: { identity: { clientId, subject: 'stable-subject', email: 'private@example.com' },
        scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
        credentials: { accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id', expiresAt,
          ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}) },
      },
    });
    return await fn({ sessions, store, save, root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const replacement = (overrides = {}) => ({
  access_token: 'new-access', id_token: 'new-id', refresh_token: 'new-refresh',
  token_type: 'Bearer', scope: 'openid resource.invoke chatgpt.tokens.use.direct', expires_in: 3600,
  ...overrides,
});
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

test('saves an account encrypted and exposes only safe status', () => setup(({ store, sessions, save, root }) => {
  const status = save();
  assert.equal(status.status, 'connected');
  assert.equal(status.sharing, true);
  assert.ok(!JSON.stringify(status).includes('old-access'));
  assert.ok(!JSON.stringify(sessions.getStatus(clientId)).includes('old-refresh'));
  const file = fs.readFileSync(path.join(root, 'secure', 'client-' + clientId + '.bin'));
  assert.ok(!file.includes(Buffer.from('old-access')));
  assert.ok(!file.includes(Buffer.from('old-refresh')));
  assert.equal(store.load(clientId).subject, 'stable-subject');
  assert.throws(() => sessions.saveConnected({ clientId, hostId, exchange: {
    identity: { clientId, subject: 'another' }, scopes: [], credentials: { accessToken: 'x' },
  } }), /account_mismatch/);
}));
test('refreshes and saves rotated credentials together with a verified subject', async () => {
  let calls = 0;
  await setup(async ({ sessions, store, save }) => {
    save();
    assert.equal(await sessions.ensureFresh(clientId), 'new-access');
    assert.equal(calls, 1);
    const next = store.load(clientId);
    assert.equal(next.status, 'connected');
    assert.deepEqual(next.credentials, { accessToken: 'new-access', idToken: 'new-id', refreshToken: 'new-refresh', expiresAt: NOW + 3600_000 });
    assert.equal(await sessions.ensureFresh(clientId), 'new-access');
    assert.equal(calls, 1);
  }, { fetchFn: async (url, init) => {
    calls++;
    assert.equal(url, CHATGPT_TOKEN_URL);
    assert.equal(init.redirect, 'manual');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.get('client_id'), clientId);
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    assert.equal(form.has('scope'), false);
    return json(replacement());
  }});
});
test('two simultaneous calls issue only one refresh', async () => {
  let calls = 0;
  await setup(async ({ sessions, save }) => {
    save();
    assert.deepEqual(await Promise.all([sessions.ensureFresh(clientId), sessions.ensureFresh(clientId)]), ['new-access', 'new-access']);
    assert.equal(calls, 1);
  }, {fetchFn: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return json(replacement()); }});
});
test('checkpoint rotated token before verification; recover after restart', async () => {
  let calls = 0;
  let verifierFails = true;
  await setup(async ({ sessions, store, save }) => {
    save();
    await assert.rejects(sessions.ensureFresh(clientId), /temporary signing key failure/);
    const checkpoint = store.load(clientId);
    assert.equal(checkpoint.status, 'pending_refresh');
    assert.equal(checkpoint.pending.refreshToken, 'new-refresh');
    verifierFails = false;
    const restarted = createChatGPTSessions({ store, fetchFn: async () => { throw Error('should not refresh again'); },
      verifyIdToken: async (_, opts) => ({ clientId: opts.clientId, subject: opts.expectedSubject }), now: () => NOW });
    assert.equal(await restarted.ensureFresh(clientId), 'new-access');
    assert.equal(store.load(clientId).status, 'connected');
    assert.equal(calls, 1);
  }, { fetchFn: async () => { calls++; return json(replacement()); },
    verifier: async (_, opts) => { if (verifierFails) throw Error('temporary signing key failure'); return { clientId: opts.clientId, subject: opts.expectedSubject }; },
  });
});
test('earliest-refresh constraint preserves valid access token', async () => setup(async ({ sessions, save }) => {
  save({ earliestRefreshAt: (NOW + 60_000) / 1000 });
  assert.equal(await sessions.ensureFresh(clientId), 'old-access');
}));
test('invalid_grant discards unusable tokens but retains registration', async () => setup(async ({ sessions, store, save }) => {
  save();
  await assert.rejects(sessions.ensureFresh(clientId), /sign_in_required/);
  const updated = store.load(clientId);
  assert.equal(updated.status, 'reauth_required');
  assert.equal(updated.subject, 'stable-subject');
  assert.equal(updated.credentials, undefined);
}, { fetchFn: async () => json({ error: 'invalid_grant' }, 400) }));
test('network errors preserve old encrypted credentials', async () => setup(async ({ sessions, store, save }) => {
  save();
  await assert.rejects(sessions.ensureFresh(clientId), /refresh_unavailable/);
  assert.equal(store.load(clientId).credentials.refreshToken, 'old-refresh');
}));
test('bad refresh response and identity mismatch never activate replacement', async () => {
  await setup(async ({ sessions, store, save }) => {
    save();
    await assert.rejects(sessions.ensureFresh(clientId), /bad_response/);
    assert.equal(store.load(clientId).status, 'connected');
  }, { fetchFn: async () => json({ access_token: 'only-access' }) });
  await setup(async ({ sessions, store, save }) => {
    save();
    await assert.rejects(sessions.ensureFresh(clientId), /account_mismatch/);
    assert.equal(store.load(clientId).status, 'pending_refresh');
  }, { fetchFn: async () => json(replacement()), verifier: async () => ({ clientId, subject: 'wrong-account' }) });
});
test('missing sharing permission refuses access after rotating credentials', async () => setup(async ({ sessions, store, save }) => {
  save();
  await assert.rejects(sessions.ensureFresh(clientId), /sharing_not_enabled/);
  assert.equal(store.load(clientId).status, 'connected');
  assert.equal(store.load(clientId).scopes.includes('chatgpt.tokens.use.direct'), false);
}, { fetchFn: async () => json(replacement({ scope: 'openid email' })) }));

test('a recovered token already expired is not returned to the provider', async () => setup(async ({ sessions, store, save }) => {
  save();
  const current = store.load(clientId);
  store.save({ ...current, status: 'pending_refresh', pending: {
    accessToken: 'expired-access', refreshToken: 'rotated-refresh', idToken: 'rotated-id',
    scopes: current.scopes, expiresAt: NOW - 1000, receivedAt: NOW - 3600_000,
  } });
  await assert.rejects(sessions.ensureFresh(clientId), /refresh_not_ready/);
  assert.equal(store.load(clientId).credentials.refreshToken, 'rotated-refresh');
}));
