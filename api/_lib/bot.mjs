/* Bot core: per-Telegram-user nostr identities, event publishing, chat↔list links,
   and the message↔task mapping that powers reply-to-comment and done buttons. */

import { createHmac } from 'node:crypto';
import C from './crypto.mjs';
import { publish } from './nostr.mjs';
import { kv, kvPipeline, kvGetJSON, kvSetJSON } from './kv.mjs';
import { KIND_PROFILE, KIND_TASK, KIND_ACTION, KIND_META, KIND_COMMENT } from './state.mjs';

export const SITE = process.env.TASKLIST_SITE || 'https://tasklist.sh';
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/* Deterministic per-Telegram-user secret key: HMAC(master, "tg-user:<id>[:n]"),
   reduced mod the curve order. The master secret never leaves the server, so a
   Telegram user's key exists only here — same trust model as localStorage on web. */
export function userKey(tgUserId) {
  const master = process.env.TASKLIST_MASTER_SECRET;
  if (!master) throw new Error('TASKLIST_MASTER_SECRET not set');
  for (let n = 0; ; n++) {
    const h = createHmac('sha256', master).update('tg-user:' + tgUserId + (n ? ':' + n : '')).digest();
    const k = BigInt('0x' + h.toString('hex')) % SECP_N;
    if (k > 0n) {
      const sk = new Uint8Array(h);
      // re-encode the reduced scalar (h may exceed N; astronomically unlikely, but exact)
      let hex = k.toString(16).padStart(64, '0');
      for (let i = 0; i < 32; i++) sk[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return { sk, pk: C.getPublicKey(sk) };
    }
  }
}

export function displayName(tgUser) {
  const n = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();
  return (n || tgUser.username || 'Anon').slice(0, 40);
}

/* Monotonic per-list timestamps so same-second sequences fold in publish order
   (mirrors the web client's now()). */
async function nextTs(listId) {
  const now = Math.floor(Date.now() / 1000);
  const last = parseInt(await kv('GET', 'ts:' + listId), 10) || 0;
  const ts = Math.max(now, last + 1);
  await kv('SET', 'ts:' + listId, String(ts));
  return ts;
}

/* Sign + publish one list event as a Telegram user. Also (once per name change)
   publishes their kind 0 profile so web clients resolve the name. Records the event
   id in seen:{chatId} so the notifier doesn't echo a chat's own actions back at it. */
export async function publishAs(tgUser, chatId, listId, { kind, content = '', tags = [] }) {
  const { sk } = userKey(tgUser.id);
  const name = displayName(tgUser);
  const ts = await nextTs(listId);
  const evt = await C.finalizeEvent({
    kind, created_at: ts, content,
    tags: [...tags, ['t', listId], ['client', 'tasklist-telegram'], ['name', name]],
  }, sk);
  const toSend = [evt];
  if ((await kv('GET', 'name:' + tgUser.id)) !== name) {
    toSend.push(await C.finalizeEvent({
      kind: KIND_PROFILE, created_at: ts, content: JSON.stringify({ name }), tags: [],
    }, sk));
    await kv('SET', 'name:' + tgUser.id, name);
  }
  const { acked } = await publish(toSend);
  if (!acked.has(evt.id)) throw new Error('no relay accepted the event');
  await kvPipeline([
    ['SADD', 'seen:' + chatId, evt.id],
    ['EXPIRE', 'seen:' + chatId, 7 * 86400],
  ]);
  return evt;
}

export const addTask = (u, chat, list, title) =>
  publishAs(u, chat, list, { kind: KIND_TASK, content: title.slice(0, 300) });
export const taskAction = (u, chat, list, taskId, action) =>
  publishAs(u, chat, list, { kind: KIND_ACTION, tags: [['e', taskId], ['action', action]] });
export const comment = (u, chat, list, taskId, text) =>
  publishAs(u, chat, list, { kind: KIND_COMMENT, content: text.slice(0, 2000), tags: [['e', taskId]] });
export const setListName = (u, chat, list, name) =>
  publishAs(u, chat, list, { kind: KIND_META, content: name.slice(0, 48) });

/* --- chat ↔ list link registry --- */

export async function linkChat(chatId, listId) {
  await kvPipeline([
    ['SET', 'chat:' + chatId, JSON.stringify({ listId, linkedAt: Date.now() })],
    ['SADD', 'chats', String(chatId)],
    ['SET', 'cursor:' + chatId, String(Math.floor(Date.now() / 1000))],
  ]);
}

export async function unlinkChat(chatId) {
  await kvPipeline([['DEL', 'chat:' + chatId], ['SREM', 'chats', String(chatId)], ['DEL', 'cursor:' + chatId]]);
}

export const chatLink = (chatId) => kvGetJSON('chat:' + chatId, null);
export const allChats = () => kv('SMEMBERS', 'chats');

/* --- telegram message ↔ task mapping (reply-to-comment, done buttons) --- */

export async function rememberTaskMsg(chatId, messageId, taskId) {
  await kvPipeline([
    ['SET', 'msg:' + chatId + ':' + messageId, taskId],
    ['EXPIRE', 'msg:' + chatId + ':' + messageId, 30 * 86400],
  ]);
}

export const taskForMsg = (chatId, messageId) => kv('GET', 'msg:' + chatId + ':' + messageId);

export function randomListId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return C.bytesToHex(b);
}

export const listUrl = (listId) => SITE + '/#' + listId;

/* Parse a list id out of free text: a tasklist URL or a bare 16-hex id. */
export function parseListId(text) {
  const m = String(text || '').match(/#?\/?\b([a-f0-9]{16})\b/);
  return m ? m[1] : null;
}
