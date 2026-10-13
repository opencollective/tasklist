// Run with Node.js 22+: node --test tests/encryption.mjs
// No npm dependencies. Exercise the exact inline code shipped to browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { foldList, taskState } from '../api/_lib/state.mjs';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1].trim());
const sandbox = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView, btoa, atob });
vm.runInContext(scripts[0], sandbox);
vm.runInContext(scripts.find(s => s.includes('root.TaskEncryption =')), sandbox);
const C = sandbox.NostrCrypto, E = sandbox.TaskEncryption;
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const key = await E.generateKey('test-encrypted-list');
const secret = C.generateSecretKey();
async function task(title, file = key, ts = 100) {
  const template = { pubkey: C.getPublicKey(secret), kind: 2100, created_at: ts, tags: [['t', file.listId], ['client', 'test']] };
  template.content = await E.encrypt(title, file, template);
  return C.finalizeEvent(template, secret);
}

test('BIP-340 official vectors verify; signatures/public keys match known answers', async () => {
  const csv = await readFile(new URL('./bip340-test-vectors.csv', import.meta.url), 'utf8');
  for (const row of csv.trim().split(/\r?\n/).slice(1)) {
    const [index, sk, pk, aux, message, signature, valid] = row.split(',');
    assert.equal(await C.schnorrVerify(bytes(signature), bytes(message), bytes(pk)), valid === 'TRUE', `verify vector ${index}`);
    if (sk) {
      assert.equal(C.getPublicKey(bytes(sk)), pk.toLowerCase(), `pubkey vector ${index}`);
      assert.equal(C.bytesToHex(await C.schnorrSign(bytes(message), bytes(sk), bytes(aux))), signature.toLowerCase(), `sign vector ${index}`);
    }
  }
});
test('server crypto is extracted verbatim from browser crypto', async () => {
  const server = await readFile(new URL('../api/_lib/crypto.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes(scripts[0]));
});
test('generated keys validate, differ, and are scoped to one list', async () => {
  assert.equal((await E.validateKey(key, key.listId)).key, key.key);
  assert.notEqual((await E.generateKey(key.listId)).key, key.key);
  await assert.rejects(E.validateKey(key, 'another-list'));
  await assert.rejects(E.validateKey({ ...key, key: 'AAAA' }, key.listId));
  await assert.rejects(E.validateKey({ ...key, keyId: '0'.repeat(16) }, key.listId));
  await assert.rejects(E.validateKey({ format: key.format }, undefined));
});
test('long Unicode titles round-trip with ciphertext-only signed events and fresh nonces', async () => {
  const title = 'Review 東京 🔐 https://example.com/private ' + 'Long title '.repeat(70);
  const evt = await task(title), again = await task(title);
  assert.ok(evt.content.length > 300);
  assert.equal(await C.verifyEvent(evt), true);
  assert.equal(await E.decrypt(evt, key), title);
  assert.notEqual(evt.content, again.content);
  assert.ok(!JSON.stringify(evt).includes('example.com'));
  assert.ok(!JSON.stringify(evt).includes(key.key));
});
test('tampering, wrong keys, wrong lists, malformed content and overlong titles fail', async () => {
  const evt = await task('Private title');
  await assert.rejects(E.decrypt(evt, await E.generateKey(key.listId)));
  await assert.rejects(E.decrypt(evt, { ...key, listId: 'another-list' }));
  for (const patch of [{ sig: '0'.repeat(128) }, { content: evt.content.slice(0, 300) }, { tags: [['t', key.listId], ['t', key.listId]] }, { tags: 'not-an-array' }]) {
    await assert.rejects(E.decrypt({ ...evt, ...patch }, key));
  }
  // Even correctly re-signed ciphertext cannot move to a different authenticated context.
  await assert.rejects(E.decrypt(await C.finalizeEvent({ ...evt, created_at: 101 }, secret), key));
  await assert.rejects(task('x'.repeat(8193)));
  assert.equal(await C.verifyEvent({ ...evt, tags: [null] }), false);
});
test('Telegram keeps encrypted titles locked while preserving completion actions', async () => {
  const evt = await task('Not readable by Telegram');
  const done = await C.finalizeEvent({ kind: 2101, created_at: 101, content: '', tags: [['t', key.listId], ['e', evt.id], ['action', 'done']] }, secret);
  const fold = foldList(key.listId, [done, evt]);
  assert.equal(fold.encryptedTitles, true);
  assert.ok(fold.tasks.get(evt.id).title.includes('Encrypted task'));
  assert.ok(!fold.tasks.get(evt.id).title.includes('TLENC1:'));
  assert.equal(taskState(fold, fold.tasks.get(evt.id)).done, true);
  const plain = await C.finalizeEvent({ kind: 2100, created_at: 100, content: 'Public task', tags: [['t', key.listId]] }, secret);
  assert.equal(foldList(key.listId, [plain]).encryptedTitles, false);
});
