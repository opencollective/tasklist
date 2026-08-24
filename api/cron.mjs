/* Notification poller, run by Vercel Cron every minute. For every linked chat scope
   (chat, group, channel, or forum topic), fetch the list's events from the relays and
   push anything new into it. Events published *from* a scope are in seen:{chatKey}
   and are not echoed back. */

import { tg, send, esc } from './_lib/tg.mjs';
import { fetchEvents } from './_lib/nostr.mjs';
import { foldList, taskState, nameOf, tagVal, LIST_KINDS, KIND_TASK, KIND_ACTION, KIND_META, KIND_COMMENT } from './_lib/state.mjs';
import { kv, kvPipeline } from './_lib/kv.mjs';
import { taskButtons, statusLine, rememberTaskMsg, updateTaskMessages } from './_lib/taskmsgs.mjs';
import * as bot from './_lib/bot.mjs';

const MAX_PER_RUN = 15; // stay well under Telegram's ~20 msg/min per chat

function statusFromFold(fold, taskId) {
  const t = fold.tasks.get(taskId);
  if (!t) return {};
  const st = taskState(fold, t);
  return {
    done: st.done || st.deleted,
    by: st.doneBy ? nameOf(fold, st.doneBy) : null,
    assignee: st.assignee ? nameOf(fold, st.assignee) : null,
  };
}

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

async function notifyChat(chatKey, link, fold, events) {
  const chatId = link.chatId ?? String(chatKey).split(':')[0];
  const cursor = parseInt(await kv('GET', 'cursor:' + chatKey), 10) || 0;
  const fresh = events
    .filter((e) => e.created_at > cursor - 900) // clock-skew buffer; seen-set dedupes
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  if (!fresh.length) return 0;
  const seenChecks = await kvPipeline(fresh.map((e) => ['SISMEMBER', 'seen:' + chatKey, e.id]));

  /* First, refresh previously sent messages for tasks whose state changed in this
     batch — original text kept, CTA swapped for the latest status. Done before
     sending so the new notifications never get edited in the same pass. */
  const affected = new Set();
  for (let i = 0; i < fresh.length; i++) {
    if (seenChecks[i] || fresh[i].kind !== KIND_ACTION) continue;
    const tid = tagVal(fresh[i], 'e');
    if (tid && fold.tasks.has(tid)) affected.add(tid);
  }
  for (const tid of affected) {
    await updateTaskMessages(chatKey, chatId, tid, statusFromFold(fold, tid),
      '○ ' + esc(fold.tasks.get(tid).title));
  }

  let sent = 0, lastAt = cursor;
  for (let i = 0; i < fresh.length; i++) {
    const evt = fresh[i];
    if (seenChecks[i]) { lastAt = Math.max(lastAt, evt.created_at); continue; }
    const d = describe(fold, evt);
    await kvPipeline([['SADD', 'seen:' + chatKey, evt.id], ['EXPIRE', 'seen:' + chatKey, 7 * 86400]]);
    lastAt = Math.max(lastAt, evt.created_at);
    if (d) {
      const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
      if (link.threadId) extra.message_thread_id = link.threadId;
      const status = d.taskId ? statusFromFold(fold, d.taskId) : {};
      let text = d.text;
      // ➕ lines show the task's *current* state right away (it may already be
      // claimed or even done by the time this batch is delivered).
      if (evt.kind === KIND_TASK && (status.done || status.assignee)) text += statusLine(status);
      if (d.button && d.taskId) {
        const kb = taskButtons(d.taskId, status);
        if (kb.inline_keyboard.length) extra.reply_markup = kb;
      }
      try {
        const m = await send(chatId, text, extra);
        if (d.taskId) await rememberTaskMsg(chatKey, chatId, m.message_id, d.taskId, d.text);
        sent++;
      } catch (err) {
        // 403 = bot kicked from the chat: stop notifying it
        if (/forbidden|kicked|blocked/i.test(err.message)) { await bot.unlinkChat(chatKey); return sent; }
        console.error('notify', chatKey, err.message);
      }
      if (sent >= MAX_PER_RUN) break;
    }
  }
  await kv('SET', 'cursor:' + chatKey, String(lastAt));
  return sent;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== 'Bearer ' + process.env.CRON_SECRET) {
    res.status(401).send('unauthorized'); return;
  }
  const chatKeys = await bot.allChats();
  const links = await Promise.all(chatKeys.map(async (k) => ({ chatKey: k, link: await bot.chatLink(k) })));
  const byList = new Map();
  for (const { chatKey, link } of links) {
    if (!link) continue;
    if (!byList.has(link.listId)) byList.set(link.listId, []);
    byList.get(link.listId).push({ chatKey, link });
  }
  let total = 0;
  for (const [listId, targets] of byList) {
    let events;
    try { events = await fetchEvents({ kinds: LIST_KINDS, '#t': [listId], limit: 500 }); }
    catch (err) { console.error('fetch', listId, err.message); continue; }
    const fold = foldList(listId, events);
    for (const { chatKey, link } of targets) total += await notifyChat(chatKey, link, fold, events);
  }
  res.status(200).json({ ok: true, chats: chatKeys.length, lists: byList.size, sent: total });
}
