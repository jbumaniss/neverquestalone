// ChatGPT OAuth authorization preparation. No tokens are stored in this module.
// Identity-token verification and OS-backed credential storage are required before activating a session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const NEW_CLIENT = 'dynamic_agent_client';
const ISSUED_CLIENT = /^oaiapp_[A-Za-z0-9_-]{4,}$/;
const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message) { throw new Error('ChatGPT sign-in: ' + message); }

function validateRedirectUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { invalid('invalid redirect URI'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.port || parsed.pathname !== '/auth/callback' || parsed.search || parsed.hash ||
      parsed.username || parsed.password) invalid('redirect must be an IPv4 loopback callback');
  return parsed;
}

// Persist one host ID per installation. This is an identifier, not a credential.
export function getOrCreateHostId(file, { uuid = crypto.randomUUID } = {}) {
  const read = () => {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (!HOST_ID.test(id)) invalid('stored host ID is invalid');
    return id;
  };
  try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const id = 'urn:uuid:' + uuid();
  if (!HOST_ID.test(id)) invalid('generated host ID is invalid');
  try { fs.writeFileSync(file, id + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return read(); }
  return id;
}

// The caller must start a loopback listener before opening this URL.
// Keep the state, nonce and verifier in memory and discard them after the callback.
export function createAuthorization({ hostId, appName, redirectUri, clientId = NEW_CLIENT,
  idTokenHint, loginHint, random = crypto.randomBytes } = {}) {
  if (!HOST_ID.test(hostId ?? '')) invalid('host ID is required');
  if (typeof appName !== 'string' || !appName.trim() || appName.length > 120) invalid('app name is required');
  const redirect = validateRedirectUri(redirectUri);
  if (clientId !== NEW_CLIENT && !ISSUED_CLIENT.test(clientId)) invalid('invalid issued client ID');
  const verifier = random(32).toString('base64url');
  const state = random(24).toString('base64url');
  const nonce = random(24).toString('base64url');
  if (![verifier, state, nonce].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(v))) {
    invalid('random values must be cryptographically random');
  }
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const params = {
    client_id: clientId, ext_agent_host_id: hostId, response_type: 'code',
    redirect_uri: redirect.href, scope: CHATGPT_SCOPES, resource: CHATGPT_RESOURCE,
    state, nonce, code_challenge_method: 'S256',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
  if (clientId === NEW_CLIENT) params.agent_name_hint = appName.trim();
  else {
    if (idTokenHint) params.id_token_hint = idTokenHint;
    if (loginHint) params.login_hint = loginHint;
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.href, state, nonce, verifier, clientId, redirectUri: redirect.href };
}

function one(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) invalid('duplicate ' + name + ' callback parameter');
  return values[0] ?? null;
}

// The returned code is single-use. Do not log or persist it.
export function validateAuthorizationCallback(callbackUrl, transaction) {
  const expected = validateRedirectUri(transaction?.redirectUri);
  let callback;
  try { callback = new URL(callbackUrl); } catch { invalid('invalid callback'); }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash) invalid('unexpected callback address');
  const state = one(callback.searchParams, 'state');
  const wanted = transaction?.state;
  if (typeof state !== 'string' || typeof wanted !== 'string' ||
      !crypto.timingSafeEqual(crypto.createHash('sha256').update(state).digest(),
        crypto.createHash('sha256').update(wanted).digest())) invalid('state mismatch');
  const error = one(callback.searchParams, 'error');
  if (error) invalid('authorization was declined or interrupted');
  const code = one(callback.searchParams, 'code');
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) invalid('missing or invalid authorization code');
  const issued = one(callback.searchParams, 'client_id');
  let clientId;
  if (transaction.clientId === NEW_CLIENT) {
    if (!issued || !ISSUED_CLIENT.test(issued)) invalid('dynamic registration did not return an issued client ID');
    clientId = issued;
  } else {
    if (!ISSUED_CLIENT.test(transaction.clientId) || (issued && issued !== transaction.clientId)) invalid('registered client ID mismatch');
    clientId = transaction.clientId;
  }
  return { code, clientId };
}

export function authorizationCodeBody({ code, clientId, verifier, redirectUri }) {
  validateRedirectUri(redirectUri);
  if (!code || !ISSUED_CLIENT.test(clientId ?? '') || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier ?? '')) invalid('invalid code-exchange inputs');
  return new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
    code, code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_RESOURCE });
}

export function planUsageGranted(scopes) {
  const set = new Set(typeof scopes === 'string' ? scopes.trim().split(/\s+/) : Array.isArray(scopes) ? scopes : []);
  return set.has('chatgpt.tokens.use.direct') && set.has('resource.invoke');
}
