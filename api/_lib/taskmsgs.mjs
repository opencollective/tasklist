/* Task display messages: every Telegram message that shows a task (a ○ task line, a
   ➕/👋/↩️ notification) is registered here so that when the task's state changes we
   can refresh it — the original text is kept, only the call-to-action changes:
   buttons are swapped and a status line is appended. History stays honest, stale
   CTAs don't. */

import { tg, esc } from './tg.mjs';
import { kv, kvPipeline } from './kv.mjs';

const EXP = 30 * 86400;

/* status: { done, by, assignee } — done wins, names already display-ready. */
export function taskButtons(taskId, status) {
  if (status.done) return { inline_keyboard: [] }; // explicit empty = strip buttons on edit
  const row = [{ text: '✓ Done', callback_data: 'd:' + taskId.slice(0, 16) }];
  if (!status.assignee) row.push({ text: "👋 I'll take it", callback_data: 'c:' + taskId.slice(0, 16) });
  return { inline_keyboard: [row] };
}

export function statusLine(status) {
  if (status.done) return '\n✅ Done' + (status.by ? ' — ' + esc(status.by) : '');
  if (status.assignee) return '\n👋 ' + esc(status.assignee) + ' is on it';
  return '';
}

/* Register a sent message as displaying a task. The msg: key powers reply-to-comment;
   taskmsgs: and msgtxt: power status refreshes (baseText is the message without any
   status line). */
export async function rememberTaskMsg(chatKey, chatId, messageId, taskId, baseText) {
  await kvPipeline([
    ['SET', 'msg:' + chatId + ':' + messageId, taskId], ['EXPIRE', 'msg:' + chatId + ':' + messageId, EXP],
    ['SADD', 'taskmsgs:' + chatKey + ':' + taskId, String(messageId)], ['EXPIRE', 'taskmsgs:' + chatKey + ':' + taskId, EXP],
    ['SET', 'msgtxt:' + chatId + ':' + messageId, baseText || ''], ['EXPIRE', 'msgtxt:' + chatId + ':' + messageId, EXP],
  ]);
}

export const taskForMsg = (chatId, messageId) => kv('GET', 'msg:' + chatId + ':' + messageId);

/* Refresh every registered message showing this task in this scope. alsoMessageId
   forces one message (e.g. the tapped one) into the pass even if unregistered;
   fallbackBase is used when a message has no stored base text. */
export async function updateTaskMessages(chatKey, chatId, taskId, status, fallbackBase, alsoMessageId) {
  const ids = new Set((await kv('SMEMBERS', 'taskmsgs:' + chatKey + ':' + taskId)) || []);
  if (alsoMessageId) ids.add(String(alsoMessageId));
  const list = [...ids].slice(-10);
  if (!list.length) return;
  const bases = await kvPipeline(list.map((m) => ['GET', 'msgtxt:' + chatId + ':' + m]));
  for (let i = 0; i < list.length; i++) {
    const base = bases[i] || fallbackBase;
    if (!base) continue;
    try {
      await tg('editMessageText', {
        chat_id: chatId, message_id: Number(list[i]), parse_mode: 'HTML',
        text: base + statusLine(status), reply_markup: taskButtons(taskId, status),
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (/not modified/i.test(err.message)) continue;
      if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(err.message)) {
        await kv('SREM', 'taskmsgs:' + chatKey + ':' + taskId, list[i]).catch(() => {});
      }
    }
  }
}
