import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopInput } from '../../bridge/app/desktop-input.mjs';

test('desktop input uses current chat and existing guarded message handler', () => {
  const sent = [];
  const input = createDesktopInput({
    currentToken: () => 'token-1', tokenState: () => ({}),
    chats: () => [{ id: 'old', token: 'token-1', seen: 2 }, { id: 'new', token: 'token-1', seen: 4 }],
    acceptMessage: (...args) => sent.push(args),
    records: () => [{ t: 'reply', seq: 2, chat: 'new', text: 'Hello' }, { t: 'error', seq: 3, text: 'ignore' }],
  });
  const sentMessage = input.send('Go north');
  assert.deepEqual(input.current(), { ok: true, chatId: 'new', after: 2 });
  assert.equal(sentMessage.chatId, 'new');
  assert.equal(sentMessage.after, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].text, 'Go north');
  assert.equal(sent[0][2], 'desktop');
  assert.deepEqual(input.replies(1, 'new'), [{ seq: 2, chatId: 'new', text: 'Hello' }]);
  assert.deepEqual(input.replies(1, 'old'), []);
  assert.deepEqual(input.replies(2, 'new'), []);
  assert.equal(input.send('x'.repeat(2901)).error, 'bad_input');
});

test('desktop input cannot send when no live game chat exists', () => {
  const input = createDesktopInput({ currentToken: () => null, tokenState: () => null, chats: () => [], acceptMessage: () => { throw new Error('sent'); }, records: () => [] });
  assert.equal(input.send('Hello').error, 'no_active_chat');
  assert.deepEqual(input.current(), { ok: false, error: 'no_active_chat' });
  assert.deepEqual(input.replies(0, 'none'), []);
});

test('a global reply cursor follows a newly active in-game chat without replaying old replies', () => {
  let active = 'first';
  const rec = [{ t: 'reply', seq: 2, chat: 'first', text: 'Earlier reply' }];
  const input = createDesktopInput({
    currentToken: () => 'game', tokenState: () => ({}),
    chats: () => [{ id: active, token: 'game', seen: 1 }],
    acceptMessage: () => {}, records: () => rec,
  });
  const before = input.current();
  active = 'second';
  rec.push({ t: 'reply', seq: 3, chat: 'second', text: 'New answer' });
  assert.equal(input.current().chatId, 'second');
  assert.deepEqual(input.replies(before.after, 'second'), [{ seq: 3, chatId: 'second', text: 'New answer' }]);
});
