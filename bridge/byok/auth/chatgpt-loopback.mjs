// Loopback callback for Sign in with ChatGPT. No credentials or codes are persisted here.
import http from 'node:http';
import crypto from 'node:crypto';
import { validateAuthorizationCallback } from './chatgpt-oauth.mjs';

export const CALLBACK_PATH = '/auth/callback';
export const CALLBACK_TIMEOUT_MS = 120_000;

function matchesState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function respond(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/**
 * Bind only to IPv4 loopback. Call waitForCallback() with a transaction created
 * using this listener's redirectUri, then open the authorization URL in the
 * system browser. A mismatched state cannot end the current sign-in attempt.
 * Close the listener on completion, refusal, timeout, or cancellation.
 */
export async function startChatGPTCallback({ port = 0, timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid callback port');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) throw new TypeError('Invalid callback timeout');

  let transaction = null;
  let waiting = false;
  let settled = false;
  let timer = null;
  let resolveResult;
  let rejectResult;
  let redirectUri = null;
  const server = http.createServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 20;

  function close() {
    clearTimeout(timer);
    if (server.listening) server.close();
  }
  function finish(error, result) {
    if (settled) return;
    settled = true;
    close();
    if (error) rejectResult?.(error);
    else resolveResult?.(result);
  }

  server.on('request', (req, res) => {
    if (!waiting || settled) return respond(res, 409, 'No ChatGPT sign-in is pending.');
    if (req.method !== 'GET') return respond(res, 405, 'Only GET is accepted.');
    const origin = new URL(redirectUri).origin;
    if (req.headers.host !== new URL(redirectUri).host) return respond(res, 400, 'Invalid callback host.');
    if (!req.url || req.url.length > 8192) return respond(res, 414, 'Invalid callback URL.');
    let callback;
    try { callback = new URL(req.url, origin); } catch { return respond(res, 400, 'Invalid callback URL.'); }
    if (callback.origin !== origin || callback.pathname !== CALLBACK_PATH || callback.hash) {
      return respond(res, 404, 'Not a ChatGPT callback.');
    }
    const states = callback.searchParams.getAll('state');
    if (states.length !== 1 || !matchesState(states[0], transaction.state)) {
      return respond(res, 400, 'The sign-in request did not match.');
    }
    try {
      const result = validateAuthorizationCallback(callback.href, transaction);
      respond(res, 200, 'ChatGPT authorization received. Return to the desktop app.');
      finish(null, result);
    } catch {
      respond(res, 400, 'ChatGPT authorization was cancelled or invalid. Return to the app.');
      finish(new Error('ChatGPT authorization was cancelled or invalid'));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  } catch (error) {
    close();
    throw error;
  }
  redirectUri = 'http://127.0.0.1:' + server.address().port + CALLBACK_PATH;

  return Object.freeze({
    redirectUri,
    waitForCallback(tx) {
      if (waiting || settled) throw new Error('The callback can only be awaited once');
      if (!tx || tx.redirectUri !== redirectUri || typeof tx.state !== 'string') throw new Error('The OAuth transaction does not match this listener');
      waiting = true;
      transaction = tx;
      const pending = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      timer = setTimeout(() => finish(new Error('ChatGPT authorization timed out')), timeoutMs);
      return pending;
    },
    cancel() { if (waiting) finish(new Error('ChatGPT authorization cancelled')); else close(); },
    close() { if (waiting) finish(new Error('ChatGPT authorization cancelled')); else close(); },
  });
}
