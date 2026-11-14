import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpc, HANDLERS } from '../../app/desktop/ipc.mjs';

function fixture({ confirm = true, chatgpt = null } = {}) {
  const calls = [];
  const credentials = {
    accessToken: 'NEVER-RENDER-ACCESS',
    refreshToken: 'NEVER-RENDER-REFRESH',
  };
  const mock = chatgpt ?? {
    status: () => ({ ok: true, status: 'connected', sharing: true, clientId: 'oaiapp_testclient123', subject: 'stable-subject' }),
    signIn: async () => { calls.push('signIn'); return { ok: true, status: 'connected', sharing: true }; },
    disconnect: () => { calls.push('disconnect'); return { ok: true, status: 'disconnected', sharing: false }; },
    cancelSignIn: () => { calls.push('cancelSignIn'); return { ok: true }; },
    accessToken: async () => credentials.accessToken,
  };
  const dialogs = [];
  const ipc = createIpc({
    chatgpt: mock,
    keys: { secrets: () => [credentials.accessToken, credentials.refreshToken] },
    confirm: async spec => { dialogs.push(spec); return confirm; },
    log: () => {},
  });
  return { ipc, calls, dialogs };
}

test('ChatGPT IPC methods have empty-input schemas and do not expose tokens', async () => {
  for (const name of ['chatgptStatus', 'chatgptSignIn', 'chatgptCancelSignIn', 'chatgptDisconnect']) {
    assert.ok(HANDLERS[name], name);
    assert.equal(HANDLERS[name].input.type, 'none');
  }
  const { ipc } = fixture();
  const status = await ipc.call('chatgptStatus');
  assert.equal(status.status, 'connected');
  assert.equal(status.sharing, true);
  assert.ok(!JSON.stringify(status).includes('NEVER-RENDER'));
  assert.deepEqual(await ipc.call('chatgptAccessToken'), { ok: false, error: 'unknown_call' });
  assert.equal((await ipc.call('chatgptStatus', { token: true })).error, 'bad_input');
});

test('browser sign-in and disconnect require native confirmation', async () => {
  const denied = fixture({ confirm: false });
  assert.equal((await denied.ipc.call('chatgptSignIn')).error, 'cancelled');
  assert.equal((await denied.ipc.call('chatgptDisconnect')).error, 'cancelled');
  assert.deepEqual(denied.calls, []);
  const accepted = fixture();
  assert.equal((await accepted.ipc.call('chatgptSignIn')).ok, true);
  assert.equal((await accepted.ipc.call('chatgptDisconnect')).ok, true);
  assert.deepEqual(accepted.calls, ['signIn', 'disconnect']);
  assert.equal(accepted.dialogs.length, 2);
  assert.match(accepted.dialogs[0].message, /Sign in with ChatGPT/);
  assert.equal(accepted.dialogs[1].destructive, true);
});

test('cancellation needs no confirmation and missing integration is unsupported', async () => {
  const conn = fixture();
  assert.equal((await conn.ipc.call('chatgptCancelSignIn')).ok, true);
  assert.deepEqual(conn.calls, ['cancelSignIn']);
  const missing = fixture({ chatgpt: {} });
  assert.equal((await missing.ipc.call('chatgptStatus')).error, 'unsupported');
  assert.equal((await missing.ipc.call('chatgptSignIn')).error, 'unsupported');
});
