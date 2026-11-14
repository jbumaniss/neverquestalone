// Encrypted, per-client ChatGPT OAuth records for the Electron main process.
// Construct with Electron's safeStorage; never import this in a renderer process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CLIENT_ID = /^oaiapp_[A-Za-z0-9_-]{4,100}$/;
const MAX_BYTES = 256 * 1024;
const PREFIX = 'client-';
const SUFFIX = '.bin';

function refuse(message) { throw new Error('ChatGPT storage: ' + message); }
function clientIdOf(value) {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) refuse('invalid client ID');
  return value;
}
function secretOf(value) { return typeof value === 'string' && value.length > 0 && value.length < 32768; }
function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.v !== 1 ||
      !CLIENT_ID.test(record.clientId ?? '') ||
      typeof record.subject !== 'string' || !record.subject || record.subject.length > 1024 ||
      typeof record.hostId !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(record.hostId) ||
      !Array.isArray(record.scopes) || record.scopes.some(s => typeof s !== 'string' || s.length > 128) ||
      !['connected', 'pending_refresh', 'reauth_required', 'disconnected'].includes(record.status)) {
    refuse('invalid credential record');
  }
  const current = record.credentials;
  if (record.status === 'connected' || record.status === 'pending_refresh') {
    if (!current || !secretOf(current.accessToken) || !secretOf(current.idToken) ||
        typeof current.expiresAt !== 'number' || !Number.isFinite(current.expiresAt) ||
        (current.refreshToken != null && !secretOf(current.refreshToken))) refuse('invalid active credentials');
  } else if (current != null) refuse('disconnected credentials must not be retained');
  if (record.status === 'pending_refresh') {
    if (!record.pending || !secretOf(record.pending.accessToken) || !secretOf(record.pending.idToken) ||
        !secretOf(record.pending.refreshToken) || !Number.isFinite(record.pending.expiresAt) ||
        !Number.isFinite(record.pending.receivedAt)) {
      refuse('invalid pending refresh');
    }
  } else if (record.pending !== undefined) refuse('unexpected pending refresh');
  return record;
}

/** Do not construct unless OS encryption is actually available. */
export function createChatGPTStore({ directory, encryption, platform = process.platform } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) refuse('absolute storage directory required');
  if (!encryption || typeof encryption.isEncryptionAvailable !== 'function' ||
      typeof encryption.encryptString !== 'function' || typeof encryption.decryptString !== 'function') {
    refuse('OS encryption required');
  }
  const available = () => {
    if (!encryption.isEncryptionAvailable()) refuse('OS encryption unavailable');
    if (platform === 'linux' && typeof encryption.getSelectedStorageBackend === 'function' &&
        encryption.getSelectedStorageBackend() === 'basic_text') refuse('unencrypted Linux backend refused');
  };
  const directoryInfo = () => {
    available();
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('storage directory is not private');
      if (platform !== 'win32' && (stat.mode & 0o077) !== 0) refuse('storage directory permissions are too open');
    } catch (error) {
      if (error.message?.startsWith('ChatGPT storage:')) throw error;
      refuse('cannot access protected storage directory');
    }
  };
  const fileFor = clientId => path.join(directory, PREFIX + clientIdOf(clientId) + SUFFIX);
  const privateStat = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES ||
        (platform !== 'win32' && (stat.mode & 0o077) !== 0)) refuse('credential file is not private');
    return stat;
  };

  function load(clientId) {
    directoryInfo();
    const file = fileFor(clientId);
    let cipher;
    try {
      privateStat(file);
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(file, flags);
      try { cipher = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.message?.startsWith('ChatGPT storage:')) throw error;
      refuse('could not read encrypted credentials');
    }
    try {
      const raw = encryption.decryptString(cipher);
      const record = validate(JSON.parse(raw));
      if (record.clientId !== clientId) refuse('credential ID mismatch');
      return record;
    } catch {
      refuse('encrypted credentials could not be verified');
    }
  }

  function save(value) {
    directoryInfo();
    const record = validate(value);
    const file = fileFor(record.clientId);
    try { privateStat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let cipher;
    try {
      cipher = encryption.encryptString(JSON.stringify(record));
      if (!Buffer.isBuffer(cipher) || cipher.length > MAX_BYTES || cipher.length === 0) refuse('invalid encrypted payload');
    } catch (error) {
      if (error.message?.startsWith('ChatGPT storage:')) throw error;
      refuse('OS credential encryption failed');
    }
    const temp = path.join(directory, '.credential-' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, cipher, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } catch {
      refuse('could not save encrypted credentials');
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') { /* best-effort cleanup */ } }
    }
  }

  function remove(clientId) {
    directoryInfo();
    const file = fileFor(clientId);
    try { privateStat(file); fs.unlinkSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  function listClientIds() {
    directoryInfo();
    return fs.readdirSync(directory).filter(name => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .map(name => name.slice(PREFIX.length, -SUFFIX.length)).filter(id => CLIENT_ID.test(id));
  }

  // Only IDs are listed; every actual credential remains encrypted until read by the main process.
  return Object.freeze({ load, save, remove, listClientIds });
}
