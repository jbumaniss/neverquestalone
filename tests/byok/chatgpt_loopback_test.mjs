import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAuthorization } from '../../bridge/byok/auth/chatgpt-oauth.mjs';
import { startChatGPTCallback } from '../../bridge/byok/auth/chatgpt-loopback.mjs';

const hostId = 'urn:uuid:6081bf29-dae3-45d7-a1fe-8d49041dba5b';
const begin = async (opts = {}) => {
  const listener = await startChatGPTCallback(opts);
  const tx = createAuthorization({ hostId, appName: 'Companion', redirectUri: listener.redirectUri });
  return { listener, tx };
};
const callback = (tx, extra = {}) => {
  const url = new URL(tx.redirectUri);
  for (const [name, value] of Object.entries({ code: 'a-code', state: tx.state, client_id: 'oaiapp_example123', ...extra })) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url.href;
};
function get(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { headers: host ? { host } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('ChatGPT callback binds to 127.0.0.1 and accepts one valid transaction', async () => {
  const { listener, tx } = await begin();
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const result = listener.waitForCallback(tx);
  assert.equal((await get(callback(tx))).status, 200);
  assert.deepEqual(await result, { code: 'a-code', clientId: 'oaiapp_example123' });
  assert.throws(() => listener.waitForCallback(tx), /once/);
});

test('wrong state and wrong Host cannot terminate a valid sign-in', async () => {
  const { listener, tx } = await begin();
  const result = listener.waitForCallback(tx);
  assert.equal((await get(callback(tx, { state: 'wrong' }))).status, 400);
  assert.equal((await get(callback(tx), 'localhost:1234')).status, 400);
  assert.equal((await get(callback(tx))).status, 200);
  assert.equal((await result).code, 'a-code');
});

test('valid-state denial ends the attempt without a code', async () => {
  const { listener, tx } = await begin();
  const result = listener.waitForCallback(tx);
  const rejected = assert.rejects(result, /cancelled or invalid/);
  assert.equal((await get(callback(tx, { code: null, error: 'access_denied' }))).status, 400);
  await rejected;
});

test('timeout and cancellation reject a pending attempt', async () => {
  const first = await begin({ timeoutMs: 10 });
  await assert.rejects(first.listener.waitForCallback(first.tx), /timed out/);
  const second = await begin();
  const waiting = second.listener.waitForCallback(second.tx);
  second.listener.cancel();
  await assert.rejects(waiting, /cancelled/);
});

test('listener refuses a mismatched transaction and invalid bind arguments', async () => {
  await assert.rejects(startChatGPTCallback({ port: -1 }), /port/);
  const { listener, tx } = await begin();
  assert.throws(() => listener.waitForCallback({ ...tx, redirectUri: 'http://127.0.0.1:9999/auth/callback' }), /does not match/);
  listener.close();
});
