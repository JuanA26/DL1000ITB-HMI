// Figures -- MATLAB-style "Figures" window for the HMI.
//
// Every capture started from the dashboard (Log Summary, Bump Test, RPM Sweep,
// Free Vibration) is saved as a numbered figure ("Figure 1", "Figure 2", ...)
// and shown in the Figures tab (figures.html), where it stays until someone
// closes it -- so changing the speed and taking the next capture never loses
// the previous plot, the way MATLAB keeps every figure a script opens.
//
// Storage: IndexedDB (browser-local, survives reloads of either tab). Figure
// numbers follow MATLAB: the lowest positive integer not in use.
// Messaging: a BroadcastChannel tells an open Figures tab about new/updated/
// closed figures immediately. Messages carry the whole record, so the Figures
// tab still works (without persistence) if IndexedDB is unavailable.

const DB_NAME = 'dl1000-hmi-figures';
const DB_VERSION = 1;
const STORE = 'figures';
const CHANNEL_NAME = 'dl1000-figures';
export const FIGURES_WINDOW_NAME = 'dl1000-figures';

let dbPromise = null;
// In-memory fallback when IndexedDB can't be opened (e.g. storage blocked).
const memStore = new Map();
let memNextId = 1;
let useMemory = false;

function openDb() {
  if (useMemory) return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('num', 'num', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; useMemory = true; });
  return dbPromise;
}

function lowestFreeNum(used) {
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export async function listFigures() {
  let db;
  try { db = await openDb(); } catch {
    return [...memStore.values()].sort((a, b) => a.num - b.num);
  }
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.num - b.num));
    req.onerror = () => reject(req.error);
  });
}

export async function getFigure(id) {
  let db;
  try { db = await openDb(); } catch { return memStore.get(id) || null; }
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Creates a figure and assigns its number atomically (one readwrite
// transaction), so two quick captures can't both become "Figure 3".
export async function createFigure(fields) {
  const base = { ...fields, createdAt: fields.createdAt || new Date().toISOString() };
  let db;
  try { db = await openDb(); } catch {
    const rec = { ...base, id: `mem-${memNextId++}`, num: lowestFreeNum(new Set([...memStore.values()].map((r) => r.num))) };
    memStore.set(rec.id, rec);
    return rec;
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const used = new Set();
    let rec = null;
    const cur = store.index('num').openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { used.add(c.key); c.continue(); return; }
      rec = { ...base, num: lowestFreeNum(used) };
      const add = store.add(rec);
      add.onsuccess = () => { rec.id = add.result; };
    };
    t.oncomplete = () => resolve(rec);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

// Merges `patch` into a figure. Resolves to the updated record, or null if the
// figure no longer exists (someone closed it in the Figures tab meanwhile --
// that's respected, it isn't re-created).
export async function updateFigure(id, patch) {
  if (id == null) return null;
  let db;
  try { db = await openDb(); } catch {
    const old = memStore.get(id);
    if (!old) return null;
    const rec = { ...old, ...patch, id, num: old.num };
    memStore.set(id, rec);
    return rec;
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    let rec = null;
    const get = store.get(id);
    get.onsuccess = () => {
      if (!get.result) return;
      rec = { ...get.result, ...patch, id, num: get.result.num };
      store.put(rec);
    };
    t.oncomplete = () => resolve(rec);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export async function deleteFigure(id) {
  if (id == null) return;
  let db;
  try { db = await openDb(); } catch { memStore.delete(id); return; }
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearFigures() {
  let db;
  try { db = await openDb(); } catch { memStore.clear(); return; }
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 'indexeddb' (figures survive reloads) or 'memory' (storage blocked: figures
// live only as long as the HMI tab that made them).
export async function storageMode() {
  try { await openDb(); return 'indexeddb'; } catch { return 'memory'; }
}

// ---- Messaging between the HMI tab and the Figures tab ----
// { type: 'upsert', record, select } | { type: 'delete', id } | { type: 'clear' }
// | { type: 'progress', id, text }   (live status of a capture still running)
// | { type: 'sync-request' }          (memory mode: "send me what you have")
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

export function postFigureMessage(msg) {
  try { channel?.postMessage(msg); } catch (err) { console.warn('[figures] message not sent:', err); }
}

export function onFigureMessage(cb) {
  channel?.addEventListener('message', (e) => cb(e.data));
}

// Memory mode only: the HMI tab holds the records, so keep them in step with
// what the Figures tab closes, and re-send them when a Figures tab (re)opens.
channel?.addEventListener('message', (e) => {
  if (!useMemory) return;
  const m = e.data;
  if (m?.type === 'delete') memStore.delete(m.id);
  else if (m?.type === 'clear') memStore.clear();
  else if (m?.type === 'sync-request') {
    for (const record of [...memStore.values()].sort((a, b) => a.num - b.num)) {
      postFigureMessage({ type: 'upsert', record, select: false });
    }
  }
});

// ---- Ownership: is the HMI tab that started a capture still open? ----
// Each HMI page holds a Web Lock named after its session for as long as it is
// open (the browser drops it when the tab closes, reloads or crashes). A figure
// still 'pending'/'running' whose owner no longer holds its lock can never be
// finished -- its capture died with that tab.
const LOCK_PREFIX = 'dl1000-hmi-session-';
const REAP_MIN_AGE_MS = 5000;   // never touch a figure this fresh (lock may not be granted yet)

export function claimHmiSession() {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try { navigator.locks?.request(LOCK_PREFIX + id, () => new Promise(() => {})); } catch { /* no Web Locks */ }
  return id;
}

async function liveSessions() {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return null;
  try {
    const { held = [], pending = [] } = await navigator.locks.query();
    return new Set([...held, ...pending].map((l) => l.name)
      .filter((n) => n && n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
  } catch { return null; }
}

// Settles every orphaned figure: a sweep that has points is kept, marked
// aborted; anything else unfinished (a spinner with no data) is deleted.
// Broadcasts each change and also returns them, since a BroadcastChannel
// doesn't deliver to its own sender: [{ type:'upsert', record } | { type:'delete', id }].
export async function reapOrphanFigures({ mySession = null } = {}) {
  const live = await liveSessions();
  if (!live) return [];   // can't tell who is alive -- leave everything alone
  const changes = [];
  for (const r of await listFigures()) {
    if (r.status === 'done') continue;
    if (r.owner && (r.owner === mySession || live.has(r.owner))) continue;
    if (Date.now() - Date.parse(r.createdAt) < REAP_MIN_AGE_MS) continue;
    let msg;
    if (r.type === 'sweep' && (r.data?.points || []).length) {
      const data = { ...r.data, aborted: true };
      const record = await updateFigure(r.id, { status: 'done', data, title: figureTitle('sweep', data, { demo: r.demo }) });
      if (!record) continue;
      msg = { type: 'upsert', record, select: false };
    } else {
      await deleteFigure(r.id);
      msg = { type: 'delete', id: r.id };
    }
    postFigureMessage(msg);
    changes.push(msg);
  }
  return changes;
}

// ---- Opening the Figures tab ----
// Must be called synchronously inside a click handler: browsers only let a page
// open or focus another tab in direct response to a user gesture. Re-uses the
// existing Figures tab when there is one (found by window name, even after the
// HMI tab was reloaded) instead of opening a second.
let figuresWin = null;
export function openFiguresWindow({ focus = true } = {}) {
  try {
    if (figuresWin && !figuresWin.closed) {
      if (focus) figuresWin.focus();
      return figuresWin;
    }
    const w = window.open('', FIGURES_WINDOW_NAME);
    if (!w) return null;   // pop-up blocked
    let blank = true;
    try { blank = !w.location.href || w.location.href === 'about:blank'; } catch { blank = false; }
    if (blank) w.location.replace(new URL('figures.html', window.location.href).href);
    figuresWin = w;
    if (focus) w.focus();
    return w;
  } catch (err) {
    console.warn('[figures] could not open the Figures tab:', err);
    return null;
  }
}

// ---- Titles ----
export function figureTitle(type, data, { demo = false, status = 'done' } = {}) {
  const tag = demo ? ' (demo)' : '';
  const d = data || {};
  switch (type) {
    case 'logsum':
      if (status !== 'done' || !(d.rpmAvg > 0)) return `Log Summary · capturing…${tag}`;
      return `Log Summary · ${d.rpmAvg.toFixed(0)} RPM (${(d.rpmAvg / 60).toFixed(2)} Hz)${tag}`;
    case 'bump':
      if (status !== 'done') return `Bump Test · armed, waiting for the bump…${tag}`;
      return `Bump Test · ${(d.raw || []).length} samples${tag}`;
    case 'sweep': {
      const n = (d.points || []).length;
      const mode = d.mode || 'undamped';
      if (status !== 'done') return `RPM Sweep · ${mode} · running (${n} point${n === 1 ? '' : 's'})${tag}`;
      return `RPM Sweep · ${mode} · ${n} point${n === 1 ? '' : 's'}${d.aborted ? ' (aborted)' : ''}${tag}`;
    }
    case 'freevib': {
      if (status !== 'done') return `Free Vibration · recording…${tag}`;
      const s = d.samples || [];
      const span = s.length > 1 ? s[s.length - 1].time_s - s[0].time_s : 0;
      return `Free Vibration · ${span.toFixed(1)} s${d.aborted ? ' (stopped early)' : ''}${tag}`;
    }
    default:
      return `Figure${tag}`;
  }
}
