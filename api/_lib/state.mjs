/* Server-side port of the app's event fold (processEvent + taskState in index.html).
   Same validation, same caps, same (created_at, id) ordering — keep them in sync. */

export const KIND_PROFILE = 0;
export const KIND_TASK = 2100;
export const KIND_ACTION = 2101;
export const KIND_META = 2102;
export const KIND_COMMENT = 2103;
export const LIST_KINDS = [KIND_TASK, KIND_ACTION, KIND_META, KIND_COMMENT];

export const tagVal = (evt, k) => { const t = (evt.tags || []).find((x) => x[0] === k); return t ? t[1] : null; };
const tagOf = (evt, k) => (evt.tags || []).find((x) => x[0] === k) || null;

export function foldList(listId, events) {
  const tasks = new Map(), actions = new Map(), comments = new Map(), names = new Map();
  let listMeta = { name: '', at: 0, evtId: '' };
  let earliest = null;
  const learnName = (pk, name, at) => {
    name = String(name || '').slice(0, 40).trim();
    if (!name) return;
    const cur = names.get(pk);
    if (!cur || at > cur.at) names.set(pk, { name, at });
  };
  const sorted = [...new Map(events.map((e) => [e.id, e])).values()]
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  for (const evt of sorted) {
    if (!evt || !evt.id) continue;
    if (evt.kind === KIND_PROFILE) {
      try { learnName(evt.pubkey, JSON.parse(evt.content).name, evt.created_at); } catch {}
      continue;
    }
    if (!LIST_KINDS.includes(evt.kind) || tagVal(evt, 't') !== listId) continue;
    if (!earliest || evt.created_at < earliest.created_at ||
        (evt.created_at === earliest.created_at && evt.id < earliest.id)) earliest = evt;
    learnName(evt.pubkey, tagVal(evt, 'name'), evt.created_at);
    if (evt.kind === KIND_TASK) {
      const title = String(evt.content || '').slice(0, 300).trim();
      if (title) tasks.set(evt.id, { id: evt.id, title, creator: evt.pubkey, createdAt: evt.created_at });
    } else if (evt.kind === KIND_ACTION) {
      const taskId = tagVal(evt, 'e'), act = tagVal(evt, 'action');
      if (!taskId || !['claim', 'unclaim', 'done', 'undone', 'delete'].includes(act)) continue;
      if (!actions.has(taskId)) actions.set(taskId, []);
      actions.get(taskId).push({ id: evt.id, pubkey: evt.pubkey, created_at: evt.created_at, act });
    } else if (evt.kind === KIND_COMMENT) {
      const taskId = tagVal(evt, 'e');
      if (!taskId) continue;
      let att = null;
      const a = tagOf(evt, 'attachment');
      if (a && /^https?:\/\//.test(a[1] || '')) {
        att = { url: a[1].slice(0, 500), mime: (a[2] || '').slice(0, 100), name: (a[3] || 'file').slice(0, 100) };
      }
      const text = String(evt.content || '').slice(0, 2000);
      if (!text && !att) continue;
      if (!comments.has(taskId)) comments.set(taskId, []);
      comments.get(taskId).push({ id: evt.id, pubkey: evt.pubkey, created_at: evt.created_at, text, att });
    } else { // KIND_META
      const name = String(evt.content || '').slice(0, 48).trim();
      if (name && (evt.created_at > listMeta.at || (evt.created_at === listMeta.at && evt.id < listMeta.evtId))) {
        listMeta = { name, at: evt.created_at, evtId: evt.id };
      }
    }
  }
  return { tasks, actions, comments, names, listMeta, owner: earliest ? earliest.pubkey : null };
}

export function taskState(fold, t) {
  const acts = (fold.actions.get(t.id) || []).slice().sort((a, b) =>
    a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  let assignee = null, done = false, doneBy = null, doneAt = 0, deleted = false;
  for (const a of acts) {
    if (a.act === 'claim') assignee = a.pubkey;
    else if (a.act === 'unclaim' && assignee === a.pubkey) assignee = null;
    else if (a.act === 'done') { done = true; doneBy = a.pubkey; doneAt = a.created_at; }
    else if (a.act === 'undone') done = false;
    else if (a.act === 'delete' && a.pubkey === t.creator) deleted = true;
  }
  return { assignee, done, doneBy, doneAt, deleted };
}

export function nameOf(fold, pk) {
  const n = fold.names.get(pk);
  return n ? n.name : 'Anon';
}

/* Open (not done, not deleted) tasks in creation order. */
export function openTasks(fold) {
  return [...fold.tasks.values()]
    .map((t) => ({ t, st: taskState(fold, t) }))
    .filter((x) => !x.st.deleted && !x.st.done)
    .sort((a, b) => a.t.createdAt - b.t.createdAt || (a.t.id < b.t.id ? -1 : 1));
}
