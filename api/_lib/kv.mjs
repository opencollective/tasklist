/* Minimal Upstash Redis REST client (zero deps). Every call is one HTTPS request:
   POST <url>/pipeline with [["SET","k","v"],...]. Falls back to an in-process Map
   when no KV env is configured (tests / local dev only — not durable). */

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const mem = globalThis.__kvmem || (globalThis.__kvmem = new Map());

function memExec(cmds) {
  return cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    const k = c[1];
    if (op === 'GET') return mem.get(k) ?? null;
    if (op === 'SET') { mem.set(k, String(c[2])); return 'OK'; }
    if (op === 'DEL') { const had = mem.delete(k); return had ? 1 : 0; }
    if (op === 'SADD') { const s = mem.get(k) instanceof Set ? mem.get(k) : new Set(); const n = s.size; for (const v of c.slice(2)) s.add(String(v)); mem.set(k, s); return s.size - n; }
    if (op === 'SREM') { const s = mem.get(k); if (!(s instanceof Set)) return 0; let n = 0; for (const v of c.slice(2)) n += s.delete(String(v)) ? 1 : 0; return n; }
    if (op === 'SMEMBERS') { const s = mem.get(k); return s instanceof Set ? [...s] : []; }
    if (op === 'SISMEMBER') { const s = mem.get(k); return s instanceof Set && s.has(String(c[2])) ? 1 : 0; }
    if (op === 'EXPIRE') return 1;
    if (op === 'INCR') { const v = (parseInt(mem.get(k), 10) || 0) + 1; mem.set(k, String(v)); return v; }
    throw new Error('kv mem: unsupported ' + op);
  });
}

/* Run a batch of redis commands; returns an array of results in order. */
export async function kvPipeline(cmds) {
  if (!cmds.length) return [];
  if (!URL_) return memExec(cmds);
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  if (!r.ok) throw new Error('kv http ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  const bad = out.find((o) => o.error);
  if (bad) throw new Error('kv: ' + bad.error);
  return out.map((o) => o.result);
}

export async function kv(...cmd) { return (await kvPipeline([cmd]))[0]; }

export async function kvGetJSON(key, fallback) {
  const v = await kv('GET', key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function kvSetJSON(key, val) { return kv('SET', key, JSON.stringify(val)); }
