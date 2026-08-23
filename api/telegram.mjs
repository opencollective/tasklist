/* Telegram webhook. One update in, a few relay/KV round-trips, one reply out.
   Register with setWebhook + secret_token; requests missing the secret are dropped. */

import { tg, send, esc } from './_lib/tg.mjs';
import { fetchEvents } from './_lib/nostr.mjs';
import { foldList, taskState, nameOf, openTasks, tagVal, LIST_KINDS, KIND_PROFILE } from './_lib/state.mjs';
import * as bot from './_lib/bot.mjs';

const HELP = [
  '<b>tasklist</b> — instant shareable task lists (<a href="https://tasklist.sh">tasklist.sh</a>)',
  '',
  '/newlist <i>[name]</i> — create a tasklist and link it to this chat',
  '/link <i>&lt;url&gt;</i> — link an existing tasklist (paste its link)',
  '/add <i>&lt;task&gt;</i> — add a task (in a private chat, any message works)',
  '/list — show open tasks with ✓ buttons',
  '/unlink — disconnect this chat from its tasklist',
  '',
  'Reply to a task message to comment on it. Everything syncs live with everyone on the web app.',
].join('\n');

async function loadFold(listId) {
  const events = await fetchEvents({ kinds: LIST_KINDS, '#t': [listId], limit: 500 });
  const authors = [...new Set(events.map((e) => e.pubkey))];
  if (authors.length) {
    try {
      events.push(...await fetchEvents({ kinds: [KIND_PROFILE], authors, limit: 200 }, { timeoutMs: 2000 }));
    } catch {}
  }
  return foldList(listId, events);
}

function taskLine(fold, t, st) {
  let line = (st.done ? '✅ <s>' : '○ ') + esc(t.title) + (st.done ? '</s>' : '');
  if (!st.done && st.assignee) line += '\n👋 ' + esc(nameOf(fold, st.assignee)) + ' is on it';
  return line;
}

function taskKeyboard(t, st) {
  if (st.done) return undefined;
  const row = [{ text: '✓ Done', callback_data: 'd:' + t.id.slice(0, 16) }];
  if (!st.assignee) row.push({ text: "👋 I'll take it", callback_data: 'c:' + t.id.slice(0, 16) });
  return { inline_keyboard: [row] };
}

async function requireLink(chatId) {
  const link = await bot.chatLink(chatId);
  if (!link) {
    await send(chatId, 'This chat has no tasklist yet. /newlist to create one, or /link a tasklist URL.', { parse_mode: 'HTML' });
    return null;
  }
  return link;
}

async function cmdNewList(user, chatId, name) {
  const listId = bot.randomListId();
  if (name) await bot.setListName(user, chatId, listId, name);
  else await bot.addTask(user, chatId, listId, 'My first task — tap ✓ when done');
  await bot.linkChat(chatId, listId);
  await send(chatId,
    '📝 Created <b>' + esc(name || 'a tasklist') + '</b> and linked it to this chat.\n' +
    'Open and share it: ' + bot.listUrl(listId) + '\n\nAdd your first task with /add — or just type it.',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

async function cmdLink(chatId, text) {
  const listId = bot.parseListId(text);
  if (!listId) {
    await send(chatId, 'Paste a tasklist link, e.g. /link https://tasklist.sh/#a1b2c3d4e5f60718');
    return;
  }
  await bot.linkChat(chatId, listId);
  const fold = await loadFold(listId);
  const title = (fold.owner ? nameOf(fold, fold.owner) + "'s " : '') + (fold.listMeta.name || 'tasklist');
  await send(chatId, '🔗 Linked to <b>' + esc(title) + '</b> — ' + openTasks(fold).length + ' to do.\n/list to see the tasks; new activity will show up here.',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

async function cmdList(chatId, listId) {
  const fold = await loadFold(listId);
  const open = openTasks(fold);
  const title = (fold.owner ? nameOf(fold, fold.owner) + "'s " : '') + (fold.listMeta.name || 'tasklist');
  if (!open.length) {
    await send(chatId, '<b>' + esc(title) + '</b>: all done ✓\n' + bot.listUrl(listId),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  await send(chatId, '<b>' + esc(title) + '</b> — ' + open.length + ' to do:',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  for (const { t, st } of open.slice(0, 25)) {
    const m = await send(chatId, taskLine(fold, t, st), { parse_mode: 'HTML', reply_markup: taskKeyboard(t, st) });
    await bot.rememberTaskMsg(chatId, m.message_id, t.id);
  }
  if (open.length > 25) await send(chatId, '…and ' + (open.length - 25) + ' more on ' + bot.listUrl(listId));
}

async function cmdAdd(user, chatId, listId, title) {
  if (!title) { await send(chatId, 'Usage: /add buy milk'); return; }
  const evt = await bot.addTask(user, chatId, listId, title);
  const m = await send(chatId, '○ ' + esc(title.slice(0, 300)),
    { parse_mode: 'HTML', reply_markup: taskKeyboard({ id: evt.id }, { done: false, assignee: null }) });
  await bot.rememberTaskMsg(chatId, m.message_id, evt.id);
}

async function onMessage(msg) {
  const chatId = msg.chat.id, user = msg.from, text = (msg.text || '').trim();
  if (!user || user.is_bot) return;
  const isPrivate = msg.chat.type === 'private';

  // Replies to a known task message become comments on that task.
  if (msg.reply_to_message && text && !text.startsWith('/')) {
    const taskId = await bot.taskForMsg(chatId, msg.reply_to_message.message_id);
    if (taskId) {
      const link = await bot.chatLink(chatId);
      if (!link) return;
      await bot.comment(user, chatId, link.listId, taskId, text);
      await tg('setMessageReaction', { chat_id: chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
      return;
    }
  }

  const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*([\s\S]*)$/);
  const cmd = m ? m[1] : null, arg = m ? m[2].trim() : '';

  if (cmd === 'start') {
    const deepLink = bot.parseListId(arg);
    if (deepLink) { await cmdLink(chatId, deepLink); return; }
    await send(chatId, HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  if (cmd === 'help') { await send(chatId, HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); return; }
  if (cmd === 'newlist') { await cmdNewList(user, chatId, arg.slice(0, 48)); return; }
  if (cmd === 'link') { await cmdLink(chatId, arg); return; }
  if (cmd === 'unlink') { await bot.unlinkChat(chatId); await send(chatId, 'Unlinked. The tasklist itself still exists for everyone who has its URL.'); return; }
  if (cmd === 'list') { const link = await requireLink(chatId); if (link) await cmdList(chatId, link.listId); return; }
  if (cmd === 'add') { const link = await requireLink(chatId); if (link) await cmdAdd(user, chatId, link.listId, arg); return; }
  if (cmd) return; // unknown command: stay quiet (important in groups)

  // Plain text in a private chat adds a task; in groups only /add does (too noisy otherwise).
  if (isPrivate && text) {
    const link = await requireLink(chatId);
    if (link) await cmdAdd(user, chatId, link.listId, text);
  }
}

async function onCallback(q) {
  const chatId = q.message && q.message.chat.id;
  const [op, idPrefix] = String(q.data || '').split(':');
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!chatId || !idPrefix || !['d', 'c'].includes(op)) { await ack(''); return; }
  const link = await bot.chatLink(chatId);
  if (!link) { await ack('This chat is no longer linked to a tasklist.'); return; }
  const fold = await loadFold(link.listId);
  const t = [...fold.tasks.values()].find((x) => x.id.startsWith(idPrefix));
  if (!t) { await ack("Couldn't find that task any more."); return; }
  const st = taskState(fold, t);
  if (op === 'd') {
    if (!st.done) await bot.taskAction(q.from, chatId, link.listId, t.id, 'done');
    await ack('Done ✓');
    await tg('editMessageText', {
      chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
      text: '✅ <s>' + esc(t.title) + '</s>\n— ' + esc(bot.displayName(q.from)),
    }).catch(() => {});
  } else {
    if (!st.done) await bot.taskAction(q.from, chatId, link.listId, t.id, 'claim');
    await ack("It's yours 👋");
    await tg('editMessageText', {
      chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
      text: '○ ' + esc(t.title) + '\n👋 ' + esc(bot.displayName(q.from)) + ' is on it',
      reply_markup: { inline_keyboard: [[{ text: '✓ Done', callback_data: 'd:' + t.id.slice(0, 16) }]] },
    }).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('POST only'); return; }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).send('bad secret'); return;
  }
  const update = req.body || {};
  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (err) {
    console.error('webhook error', err);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) await send(chatId, '⚠️ That didn\'t go through (' + esc(err.message).slice(0, 120) + '). Try again.', { parse_mode: 'HTML' }).catch(() => {});
  }
  res.status(200).json({ ok: true }); // always 200 so Telegram doesn't retry-storm
}
