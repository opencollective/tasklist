/* Short-lived nostr relay client for serverless: open sockets, do one job
   (publish or fetch), close. Uses Node's native WebSocket (Node >= 22). */

export const RELAYS = (process.env.TASKLIST_RELAYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!RELAYS.length) RELAYS.push('wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub');

function connect(url, timeoutMs) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return resolve(null); }
    const to = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, timeoutMs);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = () => { clearTimeout(to); resolve(null); };
  });
}

/* Publish signed events to all relays. Resolves once every event got an OK from at
   least one relay, or the timeout passes. Returns {acked: Set<eventId>}. */
export async function publish(events, { timeoutMs = 4000 } = {}) {
  if (!events.length) return { acked: new Set() };
  const acked = new Set();
  const sockets = (await Promise.all(RELAYS.map((r) => connect(r, 2500)))).filter(Boolean);
  if (!sockets.length) throw new Error('no relay reachable');
  await new Promise((resolve) => {
    const done = () => { if (acked.size === events.length) resolve(); };
    const to = setTimeout(resolve, timeoutMs);
    for (const ws of sockets) {
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data);
          if (d[0] === 'OK' && d[2]) { acked.add(d[1]); done(); }
        } catch {}
      };
      for (const e of events) ws.send(JSON.stringify(['EVENT', e]));
    }
    if (acked.size === events.length) { clearTimeout(to); resolve(); }
  });
  for (const ws of sockets) { try { ws.close(); } catch {} }
  return { acked };
}

/* Fetch events matching a filter from all relays, dedupe by id, until EOSE
   everywhere or timeout. */
export async function fetchEvents(filter, { timeoutMs = 3500 } = {}) {
  const byId = new Map();
  const sockets = (await Promise.all(RELAYS.map((r) => connect(r, 2500)))).filter(Boolean);
  if (!sockets.length) throw new Error('no relay reachable');
  await new Promise((resolve) => {
    let eosed = 0;
    const to = setTimeout(resolve, timeoutMs);
    for (const ws of sockets) {
      const sub = 'tl' + Math.random().toString(36).slice(2, 8);
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data);
          if (d[0] === 'EVENT' && d[1] === sub && d[2] && d[2].id) byId.set(d[2].id, d[2]);
          if (d[0] === 'EOSE' && d[1] === sub && ++eosed === sockets.length) { clearTimeout(to); resolve(); }
        } catch {}
      };
      ws.send(JSON.stringify(['REQ', sub, filter]));
    }
  });
  for (const ws of sockets) { try { ws.close(); } catch {} }
  return [...byId.values()];
}
