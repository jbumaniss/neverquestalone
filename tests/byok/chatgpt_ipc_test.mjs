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
    models: () => ({ ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] }),
    signIn: async () => { calls.push('signIn'); return { ok: true, status: 'connected', sharing: true }; },
    disconnect: () => { calls.push('disconnect'); return { ok: true, status: 'disconnected', sharing: false }; },
    cancelSignIn: () => { calls.push('cancelSignIn'); return { ok: true }; },
    accessToken: async () => credentials.accessToken,
  };
  const dialogs = [];
  const ipc = createIpc({
    chatgpt: mock,
    api: {
      chooseChatGPT: async ({ model }) => { calls.push('use:' + model); return { ok: true, model }; },
      chatgptChanged: async () => { calls.push('changed'); return { ok: true }; },
      status: async () => ({ backend: { provider: { id: 'anthropic', auth: 'key' } } }),
    },
    keys: { secrets: () => [credentials.accessToken, credentials.refreshToken] },
    confirm: async spec => { dialogs.push(spec); return confirm; },
    log: () => {},
  });
  return { ipc, calls, dialogs };
}

test('ChatGPT IPC methods have empty-input schemas and do not expose tokens', async () => {
  for (const name of ['chatgptStatus', 'chatgptModels', 'chatgptSignIn', 'chatgptCancelSignIn', 'chatgptDisconnect']) {
    assert.ok(HANDLERS[name], name);
    assert.equal(HANDLERS[name].input.type, 'none');
  }
  const { ipc } = fixture();
  const status = await ipc.call('chatgptStatus');
  assert.equal(status.status, 'connected');
  assert.equal(status.sharing, true);
  assert.deepEqual(await ipc.call('chatgptModels'), { ok: true, models: [{ id: 'gpt-test', name: 'GPT Test' }] });
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
  assert.deepEqual(accepted.calls, ['signIn', 'changed', 'disconnect', 'changed']);
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
  assert.equal((await missing.ipc.call('chatgptModels')).error, 'unsupported');
  assert.equal((await missing.ipc.call('chatgptSignIn')).error, 'unsupported');
  assert.equal((await missing.ipc.call('chatgptCancelSignIn')).error, 'unsupported');
  assert.equal((await missing.ipc.call('chatgptDisconnect')).error, 'unsupported');
});


test('activation validates a selected model, requires consent and never exposes credentials', async () => {
  const rejected = fixture({ confirm: false });
  assert.equal((await rejected.ipc.call('chatgptUse', { model: 'gpt-test' })).error, 'cancelled');
  assert.deepEqual(rejected.calls, []);
  const accepted = fixture();
  assert.deepEqual(await accepted.ipc.call('chatgptUse', { model: 'gpt-test' }), { ok: true, model: 'gpt-test' });
  assert.deepEqual(accepted.calls, ['use:gpt-test']);
  assert.match(accepted.dialogs[0].detail, /game context/);
  assert.match(accepted.dialogs[0].detail, /API keys are preserved/);
  assert.equal((await accepted.ipc.call('chatgptUse', { model: '../bad' })).error, 'bad_input');
  assert.equal((await accepted.ipc.call('chatgptUse', { model: 'gpt-test', token: 'secret' })).error, 'bad_input');
  assert.deepEqual(await accepted.ipc.call('chatgptAccessToken'), { ok: false, error: 'unknown_call' });
});
