import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAuthorization, CHATGPT_TOKEN_URL } from '../../bridge/byok/auth/chatgpt-oauth.mjs';
import { verifyChatGPTIdToken, exchangeChatGPTCode, CHATGPT_DISCOVERY_URL, CHATGPT_JWKS_URL } from '../../bridge/byok/auth/chatgpt-tokens.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const hostId = 'urn:uuid:6081bf29-dae3-45d7-a1fe-8d49041dba5b';
const clientId = 'oaiapp_testing123';
const nonce = 'nonce-value';
const NOW = 1_800_000_000_000;
function jwt(overrides = {}, headerOverrides = {}) {
  const header = { alg: 'RS256', kid: 'test-kid', typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://auth.openai.com', aud: clientId, sub: 'subject1',
    nonce, iat: NOW / 1000 - 60, exp: NOW / 1000 + 3600, name: 'Example User',
    ...overrides,
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const text = encode(header) + '.' + encode(claims);
  const sig = crypto.sign('sha256', Buffer.from(text), privateKey).toString('base64url');
  return text + '.' + sig;
}
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function fakeFetch(tokenValue = null, overrides = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === CHATGPT_TOKEN_URL) return overrides.tokenResponse ?? json(tokenValue);
    if (url === CHATGPT_DISCOVERY_URL) return json(overrides.discovery ?? {
      issuer: 'https://auth.openai.com', jwks_uri: CHATGPT_JWKS_URL, token_endpoint: CHATGPT_TOKEN_URL,
    });
    if (url === CHATGPT_JWKS_URL) return json(overrides.jwks ?? { keys: [jwk] });
    throw Error('unexpected URL');
  };
  return { calls, fetchFn };
}
const verify = (token, fetchFn) => verifyChatGPTIdToken(token, { clientId, nonce, fetchFn, now: () => NOW });
test('valid OpenAI ID token verifies signature, issuer, audience and nonce', async () => {
  const f = fakeFetch();
  const identity = await verify(jwt({ email: 'user@example.com' }), f.fetchFn);
  assert.deepEqual(identity, { issuer: 'https://auth.openai.com', subject: 'subject1', clientId, name: 'Example User', email: 'user@example.com' });
  assert.deepEqual(f.calls.map(x => x.url), [CHATGPT_DISCOVERY_URL, CHATGPT_JWKS_URL]);
  assert.ok(f.calls.every(x => x.init.redirect === 'manual'));
});
test('rejects tampered tokens, wrong issuer, wrong audience, wrong nonce and expiry', async () => {
  const f = fakeFetch();
  const good = jwt();
  const parts = good.split('.');
  const corrupted = parts[0] + '.' + parts[1] + '.' + (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(verify(corrupted, f.fetchFn), /signature/);
  for (const claims of [{ iss: 'https://example.com' }, { aud: 'oaiapp_another' }, { nonce: 'bad' },
    { exp: NOW / 1000 - 30 }, { iat: NOW / 1000 + 30 }, { sub: '' }]) {
    await assert.rejects(verify(jwt(claims), f.fetchFn), /identity or claims/);
  }
  await assert.rejects(verifyChatGPTIdToken(jwt(), { clientId, nonce, expectedSubject: 'another', fetchFn: f.fetchFn, now: () => NOW }), /does not match/);
});
test('rejects unknown signing key and untrusted discovery endpoints', async () => {
  await assert.rejects(verify(jwt(), fakeFetch(null, { jwks: { keys: [] } }).fetchFn), /key unavailable/);
  await assert.rejects(verify(jwt(), fakeFetch(null, { discovery: { issuer: 'https://evil.example', jwks_uri: CHATGPT_JWKS_URL, token_endpoint: CHATGPT_TOKEN_URL } }).fetchFn), /issuer configuration/);
  await assert.rejects(verify(jwt({}, { alg: 'none' }), fakeFetch().fetchFn), /unsupported/);
});
test('code exchange uses PKCE without a client secret and returns verified credentials', async () => {
  const tx = createAuthorization({ hostId, appName: 'Companion', redirectUri: 'http://127.0.0.1:14999/auth/callback' });
  const token = {
    access_token: 'access-token', refresh_token: 'refresh-token', id_token: jwt({ nonce: tx.nonce }),
    token_type: 'Bearer', expires_in: 3600,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  };
  const f = fakeFetch(token);
  const out = await exchangeChatGPTCode({ callback: { code: 'callback-code', clientId }, transaction: tx, fetchFn: f.fetchFn, now: () => NOW });
  assert.equal(out.sharing, true);
  assert.equal(out.identity.subject, 'subject1');
  assert.equal(out.credentials.refreshToken, 'refresh-token');
  assert.equal(out.credentials.expiresAt, NOW + 3600_000);
  const sent = new URLSearchParams(f.calls[0].init.body);
  assert.equal(f.calls[0].url, CHATGPT_TOKEN_URL);
  assert.equal(sent.get('code_verifier'), tx.verifier);
  assert.equal(sent.get('client_id'), clientId);
  assert.equal(sent.get('resource'), 'https://api.openai.com/v1');
  assert.equal(sent.has('client_secret'), false);
});
test('login succeeds without plan permission, but sharing is disabled', async () => {
  const tx = createAuthorization({ hostId, appName: 'Companion', redirectUri: 'http://127.0.0.1:14999/auth/callback' });
  const token = { access_token: 'abc', id_token: jwt({ nonce: tx.nonce }), token_type: 'Bearer', expires_in: 3600, scope: 'openid email' };
  const result = await exchangeChatGPTCode({ callback: { code: 'code', clientId }, transaction: tx, fetchFn: fakeFetch(token).fetchFn, now: () => NOW });
  assert.equal(result.sharing, false);
});
test('failed exchange never includes response data in error message', async () => {
  const tx = createAuthorization({ hostId, appName: 'Companion', redirectUri: 'http://127.0.0.1:14999/auth/callback' });
  const f = fakeFetch(null, { tokenResponse: new Response('secret-do-not-echo', { status: 400 }) });
  await assert.rejects(exchangeChatGPTCode({ callback: { code: 'code', clientId }, transaction: tx, fetchFn: f.fetchFn, now: () => NOW }), error => !error.message.includes('secret-do-not-echo'));
});

test('refresh ID token requires the previous verified subject even without a browser nonce', async () => {
  const f = fakeFetch();
  const refreshed = jwt({ nonce: undefined });
  const verified = await verifyChatGPTIdToken(refreshed, {
    clientId, nonce: null, expectedSubject: 'subject1', fetchFn: f.fetchFn, now: () => NOW,
  });
  assert.equal(verified.subject, 'subject1');
  await assert.rejects(verifyChatGPTIdToken(refreshed, {
    clientId, nonce: null, expectedSubject: 'another', fetchFn: f.fetchFn, now: () => NOW,
  }), /selected account/);
  await assert.rejects(verifyChatGPTIdToken(refreshed, {
    clientId, nonce: null, fetchFn: f.fetchFn, now: () => NOW,
  }), /verification context/);
});
