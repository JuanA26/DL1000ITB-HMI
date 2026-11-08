// Figures tab (figures.html) -- the HMI's answer to MATLAB's Figures window.
//
// Shows every saved capture as a numbered figure tab ("Figure 1", "Figure 2",
// ...). The HMI tab creates the figures (figure-store.js) and tells this tab
// about each new/updated one over a BroadcastChannel; on load this tab reads
// whatever is already stored, so it can be opened, closed or reloaded at any
// time without losing anything. Figures stay until closed here.
import {
  FIGURES_WINDOW_NAME, listFigures, deleteFigure, clearFigures, postFigureMessage,
  onFigureMessage, storageMode, reapOrphanFigures,
} from './figure-store.js';
import { createFigureView } from './figure-views.js';

// The HMI finds this tab by name (window.open('', name)) instead of opening a
// second one -- also after either tab was reloaded.
window.name = FIGURES_WINDOW_NAME;

const tabsEl = document.getElementById('fig-tabs');
const mainEl = document.getElementById('fig-main');
const emptyEl = document.getElementById('fig-empty');
const countEl = document.getElementById('fig-count');
const btnCloseAll = document.getElementById('btn-close-all');
const storageWarning = document.getElementById('fig-storage-warning');

const SELECTED_KEY = 'dl1000-figures-selected';   // sessionStorage: survives a reload of this tab
const DEFAULT_TITLE = document.title;

const figs = new Map();   // id -> { rec, view, tab, num, title, scrollTop }
let activeId = null;

const byNum = () => [...figs.values()].sort((a, b) => a.rec.num - b.rec.num);

function makeTab(id) {
  const num = document.createElement('span');
  num.className = 'fig-tab-num';
  const title = document.createElement('span');
  title.className = 'fig-tab-title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fig-tab-close';
  close.textContent = '×';
  const tab = document.createElement('div');
  tab.className = 'fig-tab';
  tab.setAttribute('role', 'tab');
  tab.tabIndex = -1;
  tab.append(num, title, close);
  tab.addEventListener('click', () => select(id));
  close.addEventListener('click', (e) => { e.stopPropagation(); closeFigure(id); });
  // Middle-click closes, like a browser tab.
  tab.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeFigure(id); } });
  return { tab, num, title, close };
}

function renderTab(f) {
  const r = f.rec;
  f.num.textContent = `Figure ${r.num}`;
  f.title.textContent = r.title || '';
  f.tab.title = `Figure ${r.num}: ${r.title || ''}`;
  f.close.setAttribute('aria-label', `Close Figure ${r.num}`);
  f.close.title = `Close Figure ${r.num}`;
  f.tab.classList.toggle('pending', r.status !== 'done');
}

// Tabs and figures are kept in figure-number order, like MATLAB's figure list.
function place(f) {
  const later = byNum().find((o) => o !== f && o.rec.num > f.rec.num);
  tabsEl.insertBefore(f.tab, later ? later.tab : null);
}

function upsert(rec, { select: wantSelect = false, autoSelect = true } = {}) {
  if (rec?.id == null) return;
  // 'mem-' ids come from an HMI tab that can't store figures either.
  if (String(rec.id).startsWith('mem-')) storageWarning.hidden = false;
  let f = figs.get(rec.id);
  if (!f) {
    const view = createFigureView(rec);
    view.el.hidden = true;
    view.el.setAttribute('role', 'tabpanel');
    mainEl.appendChild(view.el);
    f = { rec, view, scrollTop: 0, ...makeTab(rec.id) };
    figs.set(rec.id, f);
    place(f);
  } else {
    const renumbered = f.rec.num !== rec.num;
    f.rec = rec;
    f.view.update(rec);
    if (renumbered) place(f);
  }
  renderTab(f);
  if (wantSelect || (autoSelect && activeId == null)) select(rec.id);
  refreshChrome();
}

function select(id, { focusTab = false } = {}) {
  const f = figs.get(id);
  if (!f) return;
  const prev = activeId != null ? figs.get(activeId) : null;
  if (prev && prev !== f) prev.scrollTop = mainEl.scrollTop;
  activeId = id;
  for (const [fid, o] of figs) {
    const on = fid === id;
    o.view.el.hidden = !on;
    o.tab.classList.toggle('active', on);
    o.tab.setAttribute('aria-selected', String(on));
    o.tab.tabIndex = on ? 0 : -1;
  }
  f.view.show();   // builds/redraws now that its canvases have a size
  if (prev !== f) mainEl.scrollTop = f.scrollTop;
  f.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusTab) f.tab.focus();
  try { sessionStorage.setItem(SELECTED_KEY, String(id)); } catch { /* storage blocked */ }
  refreshChrome();
}

function removeLocal(id) {
  const f = figs.get(id);
  if (!f) return;
  const order = byNum().map((o) => o.rec.id);
  const at = order.indexOf(id);
  f.view.destroy();
  f.view.el.remove();
  f.tab.remove();
  figs.delete(id);
  if (activeId === id) {
    activeId = null;
    // Like closing a browser tab: the next figure, else the previous one.
    const next = order[at + 1] ?? order[at - 1];
    if (next != null && figs.has(next)) select(next);
  }
  refreshChrome();
}

async function closeFigure(id) {
  removeLocal(id);
  try { await deleteFigure(id); } catch (err) { console.warn('[figures] delete failed:', err); }
  postFigureMessage({ type: 'delete', id });
}

function refreshChrome() {
  const n = figs.size;
  emptyEl.hidden = n > 0;
  countEl.textContent = n ? `${n} figure${n === 1 ? '' : 's'}` : '';
  btnCloseAll.disabled = n === 0;
  if (n === 0) resetCloseAll();
  const f = activeId != null ? figs.get(activeId) : null;
  document.title = f ? `Figure ${f.rec.num}: ${f.rec.title || ''} — Figures` : DEFAULT_TITLE;
}

// ---- Close All: a second click within a few seconds confirms (no blocking dialog) ----
let confirmTimer = null;
function resetCloseAll() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  btnCloseAll.classList.remove('confirm');
  btnCloseAll.textContent = 'Close All';
}
btnCloseAll.addEventListener('click', async () => {
  if (!btnCloseAll.classList.contains('confirm')) {
    btnCloseAll.classList.add('confirm');
    btnCloseAll.textContent = `Close all ${figs.size}? Click again`;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(resetCloseAll, 4000);
    return;
  }
  resetCloseAll();
  for (const id of [...figs.keys()]) removeLocal(id);
  try { await clearFigures(); } catch (err) { console.warn('[figures] clear failed:', err); }
  postFigureMessage({ type: 'clear' });
});

// ---- Keyboard: arrows move between figure tabs, Delete closes one ----
tabsEl.addEventListener('keydown', (e) => {
  if (activeId == null) return;
  const order = byNum().map((o) => o.rec.id);
  const at = order.indexOf(activeId);
  let to = null;
  if (e.key === 'ArrowRight') to = order[Math.min(order.length - 1, at + 1)];
  else if (e.key === 'ArrowLeft') to = order[Math.max(0, at - 1)];
  else if (e.key === 'Home') to = order[0];
  else if (e.key === 'End') to = order[order.length - 1];
  else if (e.key === 'Delete') {
    e.preventDefault();
    closeFigure(activeId);
    if (activeId != null) figs.get(activeId)?.tab.focus();
    return;
  } else return;
  e.preventDefault();
  if (to != null) select(to, { focusTab: true });
});

// ---- Messages from the HMI tab (and from other Figures tabs) ----
function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'upsert': upsert(msg.record, { select: !!msg.select }); break;
    case 'delete': removeLocal(msg.id); break;
    case 'clear': for (const id of [...figs.keys()]) removeLocal(id); break;
    case 'progress': figs.get(msg.id)?.view.setProgress?.(msg.text); break;
    default: break;
  }
}

// A capture left unfinished by an HMI tab that has since closed or reloaded
// can never complete: settle it (see reapOrphanFigures) rather than spin forever.
let reaping = false;
async function reapIfNeeded() {
  if (reaping || ![...figs.values()].some((f) => f.rec.status !== 'done')) return;
  reaping = true;
  try {
    for (const msg of await reapOrphanFigures()) handle(msg);
  } catch (err) {
    console.warn('[figures] orphan check failed:', err);
  } finally {
    reaping = false;
  }
}

// Subscribe before the first read so nothing sent meanwhile is missed; the
// queue is replayed on top of what was read.
const queued = [];
let ready = false;
onFigureMessage((msg) => { if (ready) handle(msg); else queued.push(msg); });

(async function init() {
  const mode = await storageMode().catch(() => 'memory');
  storageWarning.hidden = mode !== 'memory';
  let recs = [];
  try { recs = await listFigures(); } catch (err) { console.warn('[figures] could not read stored figures:', err); }
  for (const r of recs) upsert(r, { autoSelect: false });

  // Reopen what this tab was showing before a reload; otherwise the newest.
  let remembered = null;
  try { remembered = sessionStorage.getItem(SELECTED_KEY); } catch { /* storage blocked */ }
  const keep = recs.find((r) => String(r.id) === remembered);
  const newest = recs.reduce((a, b) => (!a || Date.parse(b.createdAt) >= Date.parse(a.createdAt) ? b : a), null);
  const first = keep || newest;
  if (first) select(first.id);

  ready = true;
  for (const msg of queued.splice(0)) handle(msg);
  refreshChrome();

  // If the HMI tab couldn't store its figures (storage blocked), they only
  // exist in its memory: ask it to resend them. Ignored when it could.
  postFigureMessage({ type: 'sync-request' });
  reapIfNeeded();
  setInterval(reapIfNeeded, 5000);
})();
