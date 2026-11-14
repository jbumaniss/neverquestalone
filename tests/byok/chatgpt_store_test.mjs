import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChatGPTStore } from '../../bridge/byok/auth/chatgpt-store.mjs';

const hostId = 'urn:uuid:6081bf29-dae3-45d7-a1fe-8d49041dba5b';
const clientId = 'oaiapp_myclient123';
const record = () => ({ v: 1, clientId, subject: 'private-subject', hostId, status: 'connected',
  scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
  credentials: { accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token', idToken: 'signed-id-token', expiresAt: Date.now() + 3600000 },
});
function safeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: plaintext => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: ciphertext => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
function withStore(fn, { encryption = safeStorage(), platform } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-encryption-'));
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'accounts');
  try { return fn(createChatGPTStore({ directory, encryption, platform }), directory); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('encrypted files contain no plaintext tokens and survive reload', () => withStore((store, directory) => {
  const first = record();
  store.save(first);
  assert.deepEqual(store.listClientIds(), [clientId]);
  assert.deepEqual(store.load(clientId), first);
  const file = path.join(directory, 'client-' + clientId + '.bin');
  const bytes = fs.readFileSync(file);
  assert.ok(!bytes.includes(Buffer.from('secret-access-token')));
  assert.ok(!bytes.includes(Buffer.from('secret-refresh-token')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.load('oaiapp_unknown123'), null);
}));
test('credential rotation replaces both tokens without leaving plaintext files', () => withStore((store, directory) => {
  store.save(record());
  const next = record();
  next.credentials.accessToken = 'replacement-access-token';
  next.credentials.refreshToken = 'replacement-refresh-token';
  store.save(next);
  assert.deepEqual(store.load(clientId), next);
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.equal(store.remove(clientId), true);
  assert.equal(store.remove(clientId), false);
}));
test('pending refresh is stored encrypted before becoming active', () => withStore(store => {
  const data = { ...record(), status: 'pending_refresh', pending: {
    accessToken: 'pending-secret-access', refreshToken: 'pending-secret-refresh', idToken: 'pending-id', expiresAt: Date.now() + 3600000, receivedAt: Date.now(),
  }};
  store.save(data);
  assert.deepEqual(store.load(clientId).pending, data.pending);
  assert.throws(() => store.save({ ...data, pending: { accessToken: 'incomplete' } }), /invalid pending/);
}));
test('encryption must be available and cannot use Linux basic_text fallback', () => {
  assert.throws(() => createChatGPTStore({ directory: 'relative', encryption: safeStorage() }), /absolute/);
  withStore((store) => assert.throws(() => store.save(record()), /unavailable/), { encryption: { ...safeStorage(), isEncryptionAvailable: () => false } });
  withStore(store => assert.throws(() => store.save(record()), /unencrypted Linux backend/), {
    encryption: { ...safeStorage(), getSelectedStorageBackend: () => 'basic_text' }, platform: 'linux',
  });
});
test('refuses symlinks, permissive files and corrupt encrypted records', () => withStore((store, directory) => {
  store.save(record());
  const file = path.join(directory, 'client-' + clientId + '.bin');
  fs.writeFileSync(file, 'plaintext');
  assert.throws(() => store.load(clientId), /could not be verified/);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(directory, 'other.bin'), file);
  assert.throws(() => store.load(clientId), /not private/);
  fs.unlinkSync(file);
  store.save(record());
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.throws(() => store.load(clientId), /not private/);
  }
}));
test('does not accept credentials or account IDs with unsafe shapes', () => withStore(store => {
  assert.throws(() => store.save({ ...record(), clientId: '../other' }), /invalid/);
  assert.throws(() => store.save({ ...record(), credentials: { ...record().credentials, accessToken: null } }), /invalid/);
  assert.throws(() => store.load('../../outside'), /invalid/);
}));
