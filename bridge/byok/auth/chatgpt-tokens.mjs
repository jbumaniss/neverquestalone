// Trusted-process-only ChatGPT token exchange and ID-token verification.
// No token contents, error bodies, or OAuth codes are written to logs.
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { authorizationCodeBody, CHATGPT_TOKEN_URL, planUsageGranted } from './chatgpt-oauth.mjs';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_DISCOVERY_URL = CHATGPT_ISSUER + '/.well-known/openid-configuration';
export const CHATGPT_JWKS_URL = CHATGPT_ISSUER + '/.well-known/jwks.json';
export const TOKEN_TIMEOUT_MS = 15_000;
const CLOCK_SKEW_SECONDS = 5;
const MAX_JSON_BYTES = 128 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLIENT_ID = /^oaiapp_[A-Za-z0-9_-]{4,}$/;

function fail(reason) { throw new Error('ChatGPT OAuth: ' + reason); }

async function jsonFrom(url, init, fetchFn) {
  let response;
  try {
    response = await fetchFn(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  } catch {
    fail('the authorization service could not be reached');
  }
  if (!response || response.status < 200 || response.status >= 300) {
    // Never include the response body: some auth failures echo sensitive input.
    fail('the authorization service rejected the request');
  }
  let bytes = 0;
  let raw = '';
  try {
    const decoder = new TextDecoder();
    if (!response.body) fail('empty authorization response');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) fail('authorization response too large');
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    return JSON.parse(raw);
  } catch {
    fail('invalid authorization response');
  }
}

function decoded(value) {
  if (!BASE64URL.test(value) || value.length > 16384) fail('invalid ID token encoding');
  try { return Buffer.from(value, 'base64url'); }
  catch { fail('invalid ID token encoding'); }
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export async function verifyChatGPTIdToken(idToken, {
  clientId, nonce, expectedSubject = null, accessToken = null,
  fetchFn = globalThis.fetch, now = Date.now,
} = {}) {
  // Refresh grants have no browser nonce; require an already verified account subject instead.
  const refreshing = nonce === null && typeof expectedSubject === 'string' && expectedSubject.length > 0;
  if (!CLIENT_ID.test(clientId ?? '') || (!refreshing && (typeof nonce !== 'string' || !nonce))) fail('missing token verification context');
  if (typeof idToken !== 'string' || idToken.length > 32_768) fail('invalid ID token');
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments.some(v => !v)) fail('invalid ID token');
  let header, claims;
  try {
    header = JSON.parse(decoded(segments[0]).toString('utf8'));
    claims = JSON.parse(decoded(segments[1]).toString('utf8'));
  } catch {
    fail('invalid ID token');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      !claims || typeof claims !== 'object' || Array.isArray(claims) ||
      !['RS256', 'ES256'].includes(header.alg) ||
      typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
      header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) {
    fail('unsupported ID token header');
  }

  // Discovery and JWKS are pinned to the documented OpenAI authentication origin.
  // Never follow URLs or keys provided in a JWT header.
  const discovery = await jsonFrom(CHATGPT_DISCOVERY_URL, { method: 'GET', headers: { accept: 'application/json' } }, fetchFn);
  if (discovery?.issuer !== CHATGPT_ISSUER || discovery?.jwks_uri !== CHATGPT_JWKS_URL ||
      discovery?.token_endpoint !== CHATGPT_TOKEN_URL) fail('unexpected OpenAI issuer configuration');
  const jwks = await jsonFrom(CHATGPT_JWKS_URL, { method: 'GET', headers: { accept: 'application/json' } }, fetchFn);
  if (!Array.isArray(jwks?.keys) || jwks.keys.length > 128) fail('invalid OpenAI signing keys');
  const matching = jwks.keys.filter(key => key?.kid === header.kid &&
    (key.alg === undefined || key.alg === header.alg) &&
    (key.use === undefined || key.use === 'sig') &&
    (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
    (header.alg === 'RS256' ? key.kty === 'RSA' : (key.kty === 'EC' && key.crv === 'P-256')));
  if (matching.length !== 1) fail('ID token signing key unavailable');
  let valid = false;
  try {
    const key = createPublicKey({ key: matching[0], format: 'jwk' });
    const signed = Buffer.from(segments[0] + '.' + segments[1]);
    const signature = decoded(segments[2]);
    valid = cryptoVerify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    fail('invalid ID token signature');
  }
  if (!valid) fail('invalid ID token signature');

  const seconds = Math.floor(now() / 1000);
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (claims.iss !== CHATGPT_ISSUER || !Array.isArray(audiences) || !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isInteger(claims.exp) || claims.exp <= seconds - CLOCK_SKEW_SECONDS ||
      !Number.isInteger(claims.iat) || claims.iat > seconds + CLOCK_SKEW_SECONDS ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + CLOCK_SKEW_SECONDS)) ||
      (!refreshing && !sameSecret(claims.nonce, nonce))) fail('invalid ID token identity or claims');
  if (expectedSubject !== null && claims.sub !== expectedSubject) fail('signed-in account does not match the selected account');
  if (claims.sid !== undefined && (typeof claims.sid !== 'string' || !claims.sid.trim())) fail('invalid ID token session');
  if (claims.at_hash !== undefined) {
    if (typeof accessToken !== 'string' || !accessToken) fail('missing access token for hash verification');
    const expectedHash = createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');
    if (!sameSecret(claims.at_hash, expectedHash)) fail('access token hash mismatch');
  }

  return Object.freeze({
    issuer: claims.iss,
    subject: claims.sub,
    clientId,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
  });
}

/**
 * Exchange an already validated callback, then verify identity before returning
 * credentials to the trusted local process. The caller must save credentials in
 * an OS-protected store before treating this as a persistent connection.
 */
export async function exchangeChatGPTCode({
  callback, transaction, expectedSubject = null, fetchFn = globalThis.fetch, now = Date.now,
} = {}) {
  if (!callback || !transaction || !CLIENT_ID.test(callback.clientId ?? '') ||
      (transaction.clientId !== 'dynamic_agent_client' && transaction.clientId !== callback.clientId) ||
      typeof callback.code !== 'string' || !callback.code ||
      typeof transaction.nonce !== 'string' || !transaction.nonce) fail('invalid authorization exchange');
  const form = authorizationCodeBody({
    code: callback.code, clientId: callback.clientId,
    verifier: transaction.verifier, redirectUri: transaction.redirectUri,
  });
  const token = await jsonFrom(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  }, fetchFn);
  if (typeof token?.access_token !== 'string' || !token.access_token || token.access_token.length > 16384 ||
      typeof token?.id_token !== 'string' || typeof token?.token_type !== 'string' ||
      token.token_type.toLowerCase() !== 'bearer' ||
      !Number.isInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > 86400 ||
      typeof token.scope !== 'string') fail('incomplete token response');
  if (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== 'string' || !token.refresh_token || token.refresh_token.length > 16384)) fail('invalid refresh token');

  const identity = await verifyChatGPTIdToken(token.id_token, {
    clientId: callback.clientId, nonce: transaction.nonce,
    expectedSubject, accessToken: token.access_token, fetchFn, now,
  });
  return {
    identity,
    sharing: planUsageGranted(token.scope),
    scopes: token.scope.split(/\s+/).filter(Boolean),
    credentials: {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      idToken: token.id_token,
      expiresAt: now() + token.expires_in * 1000,
      ...(token.earliest_refresh_at !== undefined ? { earliestRefreshAt: token.earliest_refresh_at } : {}),
    },
  };
}
