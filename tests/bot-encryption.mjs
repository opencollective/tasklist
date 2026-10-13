// End-to-end webhook regression with mocked relays/Telegram and memory KV only.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TASKLIST_RELAYS = 'wss://test.invalid';
process.env.TELEGRAM_API_BASE = 'https://telegram.test.invalid';
process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'synthetic-webhook-secret';
process.env.TASKLIST_MASTER_SECRET = 'synthetic-master-secret';
for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
const { default: handler } = await import('../api/telegram.mjs');
const { default: C } = await import('../api/_lib/crypto.mjs');
const { linkChat } = await import('../api/_lib/bot.mjs');

test('Telegram refuses plaintext title creation for an encrypted list, but ordinary lists still work', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  const messages = [], published = [];
  const listId = 'a1b2c3d4e5f60718';
  const encrypted = await C.finalizeEvent({ kind: 2100, created_at: 100, tags: [['t', listId]], content: 'TLENC1:test-envelope' }, C.generateSecretKey());
  let history = [encrypted];
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    close() {}
    send(text) {
      const packet = JSON.parse(text);
      if (packet[0] === 'REQ') {
        for (const event of history) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['EVENT', packet[1], event]) }));
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['EOSE', packet[1]]) }));
      }
      if (packet[0] === 'EVENT') {
        published.push(packet[1]);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['OK', packet[1].id, true]) }));
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://telegram.test.invalid/'));
    const body = JSON.parse(options.body); messages.push(body);
    return { json: async () => ({ ok: true, result: { message_id: messages.length } }) };
  };
  const req = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { message_id: 1, chat: { id: 123, type: 'private' }, from: { id: 1, first_name: 'Test' }, text: '/task Private title must not leak' } } };
  const res = { status(code) { assert.equal(code, 200); return this; }, json() {} };
  try {
    await linkChat('123', { listId, chatId: 123 });
    await handler(req, res);
    assert.equal(published.length, 0);
    assert.ok(messages.at(-1).text.includes('uses encrypted titles'));
    assert.ok(!messages.at(-1).text.includes('Private title must not leak'));
    history = []; messages.length = 0;
    req.body.message.text = '/task Ordinary public title';
    await handler(req, res);
    const task = published.find(e => e.kind === 2100);
    assert.ok(task); assert.equal(task.content, 'Ordinary public title');
    assert.equal(await C.verifyEvent(task), true);
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});
