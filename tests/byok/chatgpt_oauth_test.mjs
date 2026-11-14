import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getOrCreateHostId, createAuthorization, validateAuthorizationCallback,
  authorizationCodeBody, planUsageGranted, CHATGPT_RESOURCE, NEW_CLIENT } from '../../bridge/byok/auth/chatgpt-oauth.mjs';

const hostId = 'urn:uuid:6081bf29-dae3-45d7-a1fe-8d49041dba5b';
const redirectUri = 'http://127.0.0.1:14999/auth/callback';
const request = () => createAuthorization({ hostId, appName: 'My WoW Companion', redirectUri });

function callback(tx, params = {}) {
  const u = new URL(tx.redirectUri);
  for (const [k, v] of Object.entries({ code: 'sample-code', state: tx.state, client_id: 'oaiapp_123456', ...params })) {
    if (v !== null) u.searchParams.set(k, v);
  }
  return u.href;
}

test('ChatGPT OAuth registration includes host identity, PKCE and safe callback', () => {
  const tx = request();
  const url = new URL(tx.url);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), NEW_CLIENT);
  assert.equal(url.searchParams.get('agent_name_hint'), 'My WoW Companion');
  assert.equal(url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(url.searchParams.get('resource'), CHATGPT_RESOURCE);
  assert.ok(url.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(tx.verifier).digest('base64url'));
  assert.deepEqual(validateAuthorizationCallback(callback(tx), tx), { code: 'sample-code', clientId: 'oaiapp_123456' });
  const body = authorizationCodeBody({ code: 'sample-code', clientId: 'oaiapp_123456', verifier: tx.verifier, redirectUri });
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('resource'), CHATGPT_RESOURCE);
  assert.equal(body.has('client_secret'), false);
});

test('returning accounts reuse issued client IDs without new registration', () => {
  const tx = createAuthorization({ hostId, appName: 'My WoW Companion', redirectUri, clientId: 'oaiapp_123456', loginHint: 'example@example.com' });
  const url = new URL(tx.url);
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_123456');
  assert.equal(validateAuthorizationCallback(callback(tx, { client_id: null }), tx).clientId, 'oaiapp_123456');
  assert.throws(() => validateAuthorizationCallback(callback(tx, { client_id: 'oaiapp_other123' }), tx), /client ID mismatch/);
});

test('callbacks reject mismatches, duplicates and spoofed redirect addresses', () => {
  const tx = request();
  assert.throws(() => validateAuthorizationCallback(callback(tx, { state: 'wrong' }), tx), /state mismatch/);
  assert.throws(() => validateAuthorizationCallback(callback(tx, { client_id: null }), tx), /issued client ID/);
  assert.throws(() => validateAuthorizationCallback(callback(tx, { code: null }), tx), /authorization code/);
  assert.throws(() => validateAuthorizationCallback(callback(tx, { error: 'access_denied' }), tx), /declined/);
  assert.throws(() => validateAuthorizationCallback(callback(tx).replace('/auth/callback?', '/callback?'), tx), /unexpected callback/);
  assert.throws(() => validateAuthorizationCallback(callback(tx) + '&state=' + tx.state, tx), /duplicate state/);
  assert.throws(() => createAuthorization({ hostId, appName: 'Bad', redirectUri: 'http://localhost:14999/auth/callback' }), /loopback/);
});

test('host ID persists without changing on later launches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-chatgpt-test-'));
  try {
    const file = path.join(dir, 'oauth', 'host-id');
    assert.equal(getOrCreateHostId(file, { uuid: () => hostId.slice('urn:uuid:'.length) }), hostId);
    assert.equal(getOrCreateHostId(file, { uuid: () => { throw Error('must not regenerate'); } }), hostId);
    fs.writeFileSync(file, 'invalid-host-id');
    assert.throws(() => getOrCreateHostId(file), /invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plan usage permission requires both granted scopes', () => {
  assert.equal(planUsageGranted('openid resource.invoke chatgpt.tokens.use.direct'), true);
  assert.equal(planUsageGranted('openid email'), false);
  assert.equal(planUsageGranted(['chatgpt.tokens.use.direct']), false);
});
