/* Minimal Telegram Bot API client (zero deps). TELEGRAM_API_BASE is overridable so
   tests can point it at a local capture server. */

const BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export async function tg(method, params) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const r = await fetch(BASE + '/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error('telegram ' + method + ': ' + (d.description || r.status));
  return d.result;
}

export function send(chatId, text, extra) {
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

/* Telegram HTML-mode escaping for user content. */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
