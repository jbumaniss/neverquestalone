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
  assert.equal(input.send('Go north').chatId, 'new');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].text, 'Go north');
  assert.equal(sent[0][2], 'desktop');
  assert.deepEqual(input.replies(1), [{ seq: 2, chatId: 'new', text: 'Hello' }]);
  assert.deepEqual(input.replies(2), []);
  assert.equal(input.send('x'.repeat(2901)).error, 'bad_input');
});

test('desktop input cannot send when no live game chat exists', () => {
  const input = createDesktopInput({ currentToken: () => null, tokenState: () => null, chats: () => [], acceptMessage: () => { throw new Error('sent'); }, records: () => [] });
  assert.equal(input.send('Hello').error, 'no_active_chat');
  assert.deepEqual(input.replies(), []);
});
