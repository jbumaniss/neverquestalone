// Voice/text-to-game boundary. The core owns its security and outbox; this adapter
// knows only how to choose a current chat and shape a desktop message.
import { randomUUID } from 'node:crypto';

export function createDesktopInput({ currentToken, tokenState, chats, acceptMessage, records }) {
  return {
    send(text) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 2900) return { ok: false, error: 'bad_input' };
      const token = currentToken();
      const t = token && tokenState(token);
      const chat = token && chats().filter(c => c.token === token).sort((a, b) => (b.seen || 0) - (a.seen || 0))[0];
      if (!t || !chat) return { ok: false, error: 'no_active_chat' };
      const key = `desktop-${randomUUID()}`;
      acceptMessage({ token, chat: chat.id, key, text, context: null, args: {} }, t, 'desktop');
      return { ok: true, chatId: chat.id, key };
    },
    replies(after = 0) {
      const token = currentToken();
      if (!token || !Number.isSafeInteger(after) || after < 0) return [];
      return records(token).filter(r => r.t === 'reply' && r.seq > after)
        .map(r => ({ seq: r.seq, chatId: r.chat, text: r.summary || r.text || '' }));
    },
  };
}
