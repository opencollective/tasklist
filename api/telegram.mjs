/* Telegram webhook. One update in, a few relay/KV round-trips, one reply out.
   Register with setWebhook + secret_token; requests missing the secret are dropped.

   Every chat — private, group, channel, or forum topic — transparently gets its own
   tasklist: the first /task auto-creates one. /tasklist switches or creates by name. */

import { tg, send as tgSend, esc } from './_lib/tg.mjs';
import { fetchEvents } from './_lib/nostr.mjs';
import { foldList, taskState, nameOf, openTasks, LIST_KINDS, KIND_PROFILE } from './_lib/state.mjs';
import * as bot from './_lib/bot.mjs';

const HELP = [
  '<b>tasklist</b> — instant shareable task lists (<a href="https://tasklist.sh">tasklist.sh</a>)',
  '',
  '/task <i>&lt;task&gt;</i> — add a task (in a private chat, any message works)',
  '/tasks — show open tasks with ✓ buttons',
  '/tasklist <i>[name or URL]</i> — switch to another tasklist (or create one by that name); without arguments, shows the current one',
  '/unlink — disconnect this chat from its tasklist',
  '',
  'This chat gets its own tasklist automatically with your first task. Reply to a task message to comment on it. Everything syncs live with everyone on the web app.',
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

const foldTitle = (fold) =>
  (fold.owner ? nameOf(fold, fold.owner) + "'s " : '') + (fold.listMeta.name || 'tasklist');

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

/* A chat's scope: forum topics are their own scope, so each topic gets its own list. */
function scopeOf(msg) {
  const chatId = msg.chat.id;
  const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : undefined;
  const send = (text, extra) => tgSend(chatId, text, threadId ? { message_thread_id: threadId, ...extra } : extra);
  return { chatId, threadId, chatKey: chatId + (threadId ? ':' + threadId : ''), chat: msg.chat, send };
}

/* Current list for this scope, creating one transparently on first use. */
async function ensureLink(scope, user, { announce = true } = {}) {
  const existing = await bot.chatLink(scope.chatKey);
  if (existing) return existing;
  const listId = bot.randomListId();
  const name = scope.chat.type === 'private' ? '' : String(scope.chat.title || '').slice(0, 48);
  if (name) await bot.setListName(user, scope.chatKey, listId, name);
  await bot.linkChat(scope.chatKey, { listId, chatId: scope.chatId, threadId: scope.threadId });
  await bot.rememberList(scope.chatKey, listId, name);
  if (announce) {
    await scope.send('📝 Started a tasklist for this chat — open and share it:\n' + bot.listUrl(listId),
      { link_preview_options: { is_disabled: true } });
  }
  return { listId, chatId: scope.chatId, threadId: scope.threadId };
}

async function switchToList(scope, listId, name) {
  await bot.linkChat(scope.chatKey, { listId, chatId: scope.chatId, threadId: scope.threadId });
  await bot.rememberList(scope.chatKey, listId, name);
}

async function cmdTask(scope, user, title) {
  if (!title) { await scope.send('Usage: /task buy milk'); return; }
  const link = await ensureLink(scope, user);
  const evt = await bot.addTask(user, scope.chatKey, link.listId, title);
  const m = await scope.send('○ ' + esc(title.slice(0, 300)),
    { parse_mode: 'HTML', reply_markup: taskKeyboard({ id: evt.id }, { done: false, assignee: null }) });
  await bot.rememberTaskMsg(scope.chatId, m.message_id, evt.id);
}

async function cmdTasks(scope, user) {
  const link = await ensureLink(scope, user);
  const fold = await loadFold(link.listId);
  const open = openTasks(fold);
  if (!open.length) {
    await scope.send('<b>' + esc(foldTitle(fold)) + '</b>: all done ✓\n' + bot.listUrl(link.listId),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  await scope.send('<b>' + esc(foldTitle(fold)) + '</b> — ' + open.length + ' to do:',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  for (const { t, st } of open.slice(0, 25)) {
    const m = await scope.send(taskLine(fold, t, st), { parse_mode: 'HTML', reply_markup: taskKeyboard(t, st) });
    await bot.rememberTaskMsg(scope.chatId, m.message_id, t.id);
  }
  if (open.length > 25) await scope.send('…and ' + (open.length - 25) + ' more on ' + bot.listUrl(link.listId));
}

/* /tasklist — no arg: show current. URL/id: link it. Name: switch back to a list this
   chat has used, else create a new one with that name. */
async function cmdTasklist(scope, user, arg) {
  const urlId = bot.parseListId(arg);
  if (urlId) {
    const fold = await loadFold(urlId);
    await switchToList(scope, urlId, fold.listMeta.name);
    await scope.send('🔗 Now on <b>' + esc(foldTitle(fold)) + '</b> — ' + openTasks(fold).length + ' to do.\n/tasks to see them; new activity will show up here.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  if (!arg) {
    const link = await ensureLink(scope, user);
    const fold = await loadFold(link.listId);
    await scope.send('<b>' + esc(foldTitle(fold)) + '</b> — ' + openTasks(fold).length + ' to do.\n' + bot.listUrl(link.listId) +
      '\n\n/tasklist <i>name</i> switches to another list (creating it if new).',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  const name = arg.slice(0, 48);
  const current = await bot.chatLink(scope.chatKey);
  const known = await bot.findListByName(scope.chatKey, name);
  if (known) {
    if (current && current.listId === known) {
      await scope.send('Already on <b>' + esc(name) + '</b> — /tasks to see it.', { parse_mode: 'HTML' });
      return;
    }
    await switchToList(scope, known, name);
    const fold = await loadFold(known);
    await scope.send('🔀 Switched to <b>' + esc(foldTitle(fold)) + '</b> — ' + openTasks(fold).length + ' to do.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  const listId = bot.randomListId();
  await bot.setListName(user, scope.chatKey, listId, name);
  await switchToList(scope, listId, name);
  await scope.send('📝 Created <b>' + esc(name) + '</b> and switched this chat to it.\nOpen and share it: ' + bot.listUrl(listId),
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

async function onMessage(msg) {
  const user = msg.from, text = (msg.text || '').trim();
  if (!user || user.is_bot) return;
  const scope = scopeOf(msg);
  const isPrivate = msg.chat.type === 'private';

  // Replies to a known task message become comments on that task.
  if (msg.reply_to_message && text && !text.startsWith('/')) {
    const taskId = await bot.taskForMsg(scope.chatId, msg.reply_to_message.message_id);
    if (taskId) {
      const link = await bot.chatLink(scope.chatKey);
      if (!link) return;
      await bot.comment(user, scope.chatKey, link.listId, taskId, text);
      await tg('setMessageReaction', { chat_id: scope.chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
      return;
    }
  }

  const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*([\s\S]*)$/);
  const cmd = m ? m[1] : null, arg = m ? m[2].trim() : '';

  if (cmd === 'start') {
    const deepLink = bot.parseListId(arg);
    if (deepLink) { await cmdTasklist(scope, user, deepLink); return; }
    await scope.send(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return;
  }
  if (cmd === 'help') { await scope.send(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); return; }
  if (cmd === 'task' || cmd === 'add') { await cmdTask(scope, user, arg); return; }
  if (cmd === 'tasks' || cmd === 'list') { await cmdTasks(scope, user); return; }
  if (cmd === 'tasklist' || cmd === 'newlist' || cmd === 'link') { await cmdTasklist(scope, user, arg); return; }
  if (cmd === 'unlink') { await bot.unlinkChat(scope.chatKey); await scope.send('Unlinked. The tasklist itself still exists for everyone who has its URL.'); return; }
  if (cmd) return; // unknown command: stay quiet (important in groups)

  // Plain text in a private chat adds a task; in groups only /task does (too noisy otherwise).
  if (isPrivate && text) await cmdTask(scope, user, text);
}

async function onCallback(q) {
  if (!q.message) { await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {}); return; }
  const scope = scopeOf(q.message);
  const [op, idPrefix] = String(q.data || '').split(':');
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!idPrefix || !['d', 'c'].includes(op)) { await ack(''); return; }
  const link = await bot.chatLink(scope.chatKey);
  if (!link) { await ack('This chat is no longer linked to a tasklist.'); return; }
  const fold = await loadFold(link.listId);
  const t = [...fold.tasks.values()].find((x) => x.id.startsWith(idPrefix));
  if (!t) { await ack("Couldn't find that task any more."); return; }
  const st = taskState(fold, t);
  if (op === 'd') {
    if (!st.done) await bot.taskAction(q.from, scope.chatKey, link.listId, t.id, 'done');
    await ack('Done ✓');
    await tg('editMessageText', {
      chat_id: scope.chatId, message_id: q.message.message_id, parse_mode: 'HTML',
      text: '✅ <s>' + esc(t.title) + '</s>\n— ' + esc(bot.displayName(q.from)),
    }).catch(() => {});
  } else {
    if (!st.done) await bot.taskAction(q.from, scope.chatKey, link.listId, t.id, 'claim');
    await ack("It's yours 👋");
    await tg('editMessageText', {
      chat_id: scope.chatId, message_id: q.message.message_id, parse_mode: 'HTML',
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
    const msg = update.message || update.callback_query?.message;
    if (msg?.chat?.id) {
      await tgSend(msg.chat.id, '⚠️ That didn\'t go through (' + esc(err.message).slice(0, 120) + '). Try again.',
        { parse_mode: 'HTML' }).catch(() => {});
    }
  }
  res.status(200).json({ ok: true }); // always 200 so Telegram doesn't retry-storm
}
