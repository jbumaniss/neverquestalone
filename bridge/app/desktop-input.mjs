// Voice/text-to-game boundary. The core owns its security and outbox; this adapter
// knows only how to choose a current chat and shape a desktop message.
import { randomUUID } from 'node:crypto';

export function createDesktopInput({ currentToken, tokenState, chats, acceptMessage, records }) {
  const selectCurrent = () => {
    const token = currentToken();
    const t = token && tokenState(token);
    const chat = token && chats().filter(c => c.token === token).sort((a, b) => (b.seen || 0) - (a.seen || 0))[0];
    if (!t || !chat) return null;
    const after = records(token).reduce((last, r) => r.t === 'reply' ? Math.max(last, r.seq || 0) : last, 0);
    return { token, t, chat, after };
  };
  return {
    current() {
      const s = selectCurrent();
      return s ? { ok: true, chatId: s.chat.id, after: s.after } : { ok: false, error: 'no_active_chat' };
    },
    send(text) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 2900) return { ok: false, error: 'bad_input' };
      const selected = selectCurrent();
      if (!selected) return { ok: false, error: 'no_active_chat' };
      const { token, t, chat, after } = selected;
      const key = `desktop-${randomUUID()}`;
      acceptMessage({ token, chat: chat.id, key, text, context: null, args: {} }, t, 'desktop');
      return { ok: true, chatId: chat.id, key, after };
    },
    replies(after = 0, chatId) {
      const token = currentToken();
      if (!token || !Number.isSafeInteger(after) || after < 0 || typeof chatId !== 'string' || !chatId) return [];
      return records(token).filter(r => r.t === 'reply' && r.seq > after && r.chat === chatId)
        .map(r => ({ seq: r.seq, chatId: r.chat, text: r.summary || r.text || '' }));
    },
  };
}
