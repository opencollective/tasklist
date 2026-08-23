/* Notification poller, run by Vercel Cron every minute. For every linked chat,
   fetch the list's events from the relays and push anything new into the chat.
   Events published *from* a chat are in seen:{chatId} and are not echoed back. */

import { tg, send, esc } from './_lib/tg.mjs';
import { fetchEvents } from './_lib/nostr.mjs';
import { foldList, nameOf, tagVal, LIST_KINDS, KIND_TASK, KIND_ACTION, KIND_META, KIND_COMMENT } from './_lib/state.mjs';
import { kv, kvPipeline } from './_lib/kv.mjs';
import * as bot from './_lib/bot.mjs';

const MAX_PER_RUN = 15; // stay well under Telegram's ~20 msg/min per chat

function describe(fold, evt) {
  const who = esc(nameOf(fold, evt.pubkey));
  const titleOf = (id) => { const t = fold.tasks.get(id); return t ? esc(t.title) : null; };
  if (evt.kind === KIND_TASK) {
    const t = fold.tasks.get(evt.id);
    return t ? { text: '➕ <b>' + who + '</b> added: ' + esc(t.title), taskId: evt.id, button: true } : null;
  }
  if (evt.kind === KIND_ACTION) {
    const taskId = tagVal(evt, 'e'), act = tagVal(evt, 'action'), title = titleOf(taskId);
    if (!title) return null;
    if (act === 'done') return { text: '✅ <b>' + who + '</b> completed: <s>' + title + '</s>', taskId };
    if (act === 'undone') return { text: '↩️ <b>' + who + '</b> reopened: ' + title, taskId, button: true };
    if (act === 'claim') return { text: '👋 <b>' + who + '</b> is taking: ' + title, taskId, button: true };
    if (act === 'unclaim') return { text: '🫥 <b>' + who + '</b> stepped away from: ' + title, taskId, button: true };
    return null; // deletes: silent
  }
  if (evt.kind === KIND_COMMENT) {
    const taskId = tagVal(evt, 'e'), title = titleOf(taskId);
    if (!title) return null;
    let text = '💬 <b>' + who + '</b> on «' + title + '»';
    const body = String(evt.content || '').slice(0, 500);
    if (body) text += ':\n' + esc(body);
    const att = (evt.tags || []).find((x) => x[0] === 'attachment');
    if (att && /^https?:\/\//.test(att[1] || '')) text += '\n📎 ' + esc((att[3] || 'attachment').slice(0, 100)) + ' — ' + esc(att[1].slice(0, 300));
    return { text, taskId };
  }
  if (evt.kind === KIND_META) {
    return { text: '✏️ <b>' + who + '</b> named the list: ' + esc(String(evt.content || '').slice(0, 48)) };
  }
  return null;
}

async function notifyChat(chatId, listId, fold, events) {
  const cursor = parseInt(await kv('GET', 'cursor:' + chatId), 10) || 0;
  const fresh = events
    .filter((e) => e.created_at > cursor - 900) // clock-skew buffer; seen-set dedupes
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  if (!fresh.length) return 0;
  const seenChecks = await kvPipeline(fresh.map((e) => ['SISMEMBER', 'seen:' + chatId, e.id]));
  let sent = 0, lastAt = cursor;
  for (let i = 0; i < fresh.length; i++) {
    const evt = fresh[i];
    if (seenChecks[i]) { lastAt = Math.max(lastAt, evt.created_at); continue; }
    const d = describe(fold, evt);
    await kvPipeline([['SADD', 'seen:' + chatId, evt.id], ['EXPIRE', 'seen:' + chatId, 7 * 86400]]);
    lastAt = Math.max(lastAt, evt.created_at);
    if (d) {
      const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
      if (d.button && d.taskId) extra.reply_markup = { inline_keyboard: [[{ text: '✓ Done', callback_data: 'd:' + d.taskId.slice(0, 16) }]] };
      try {
        const m = await send(chatId, d.text, extra);
        if (d.taskId) await bot.rememberTaskMsg(chatId, m.message_id, d.taskId);
        sent++;
      } catch (err) {
        // 403 = bot kicked from the chat: stop notifying it
        if (/forbidden|kicked|blocked/i.test(err.message)) { await bot.unlinkChat(chatId); return sent; }
        console.error('notify', chatId, err.message);
      }
      if (sent >= MAX_PER_RUN) break;
    }
  }
  await kv('SET', 'cursor:' + chatId, String(lastAt));
  return sent;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== 'Bearer ' + process.env.CRON_SECRET) {
    res.status(401).send('unauthorized'); return;
  }
  const chats = await bot.allChats();
  const links = await Promise.all(chats.map(async (c) => ({ chatId: c, link: await bot.chatLink(c) })));
  const byList = new Map();
  for (const { chatId, link } of links) {
    if (!link) continue;
    if (!byList.has(link.listId)) byList.set(link.listId, []);
    byList.get(link.listId).push(chatId);
  }
  let total = 0;
  for (const [listId, chatIds] of byList) {
    let events;
    try { events = await fetchEvents({ kinds: LIST_KINDS, '#t': [listId], limit: 500 }); }
    catch (err) { console.error('fetch', listId, err.message); continue; }
    const fold = foldList(listId, events);
    for (const chatId of chatIds) total += await notifyChat(chatId, listId, fold, events);
  }
  res.status(200).json({ ok: true, chats: chats.length, lists: byList.size, sent: total });
}
