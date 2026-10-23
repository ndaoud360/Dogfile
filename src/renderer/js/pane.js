// Tabs, panes, navigation, listing, sorting/grouping/filtering, the virtualized views
// (Grid · Details · List · Columns), selection (click/shift/ctrl/marquee/type-ahead), inline rename and drag & drop.
import { playFolderAnim, directionOf } from './folderanim.js';
import {
  api, state, sys, bus, h, esc, isVirtual, isMtp, isRemote, remoteParts, pjoin, dirname, basename, normalize, samePath, isInside, splitPath, virtualTitle,
  fmtSize, fmtDate, dateBucket, sizeBucket, kindOf, typeLabel, natCmp, debounce, fileUrl, DECODED_IMG, decodedUrl, uid, IS_WIN, addRecent, tagsOf,
  saveLibrary, saveSettings, expandUserPath, toast, extname, KINDS,
} from './core.js';
import { icon, folderArt, fileArt } from './icons.js';
import { showMenu, closeMenus } from './menu.js';
import * as MM from './mediameta.js';
import { requirePro } from './license.js';

let A = null; // actions module (late bound to avoid circular init)
export function bindActions(actions) { A = actions; }

// ======================================================================
// Tabs & panes
// ======================================================================
export function newTabState(path, opts = {}) {
  if (path && typeof path === 'object') { opts = path; path = null; }
  const t = {
    id: uid(), path: null, history: [], hi: -1, view: state.settings.defaultView, sort: { key: 'name', dir: 1 }, group: null,
    items: [], shown: [], sel: new Set(), focus: null, anchor: null, scroll: 0, filter: '', loading: false, error: null,
    pinned: false, locked: false, git: null, gridSize: null, searchJob: null, searchInfo: null, colWidths: null, ...opts,
  };
  return t;
}

export const tabById = (id) => state.tabs.find((t) => t.id === id);
export const paneTab = (i) => tabById(state.panes[i]);
export const activeTab = () => paneTab(state.activePane);
export const paneCount = () => (state.layout === 'custom' && state.splitTree ? treeLeaves(state.splitTree).length : ({ 1: 1, '2v': 2, '2h': 2, 3: 3, 4: 4 }[state.layout] || 1));

// ---- free splits: any pane can be split right or down, as often as wanted (up to MAX_PANES) ----
// state.splitTree is a tree: a leaf is { pane: i } (state.panes[i]), a split is { dir: 'v' | 'h', r: 0.5, a, b }
// ('v' = side by side, r = the share of the first child). The fixed layouts are the same trees.
export const MAX_PANES = 6;
export function treeLeaves(n, out = []) { if (!n) return out; if (n.pane != null) out.push(n.pane); else { treeLeaves(n.a, out); treeLeaves(n.b, out); } return out; }
export function presetTree(layout) {
  const L = (i) => ({ pane: i });
  const v = state.paneSizes?.v ?? 0.5, hh = state.paneSizes?.h ?? 0.5;
  switch (layout) {
    case '2v': return { dir: 'v', r: v, a: L(0), b: L(1) };
    case '2h': return { dir: 'h', r: hh, a: L(0), b: L(1) };
    case '3': return { dir: 'v', r: v, a: L(0), b: { dir: 'h', r: hh, a: L(1), b: L(2) } };
    case '4': return { dir: 'v', r: v, a: { dir: 'h', r: hh, a: L(0), b: L(2) }, b: { dir: 'h', r: hh, a: L(1), b: L(3) } };
    default: return L(0);
  }
}
/** split pane `idx` in two: 'v' puts the new pane to the right, 'h' below (`before`: left / above). The new pane
 *  shows `tabId` (a tab dragged there) or the same folder. */
export function splitPane(idx = state.activePane, dir = 'v', { tabId = null, before = false } = {}) {
  let n = paneCount();
  if (n >= MAX_PANES) { toast(`Up to ${MAX_PANES} panes`); return; }
  if (n >= 2 && !requirePro('panes')) return;
  if (state.layout !== 'custom' || !state.splitTree) { state.splitTree = presetTree(state.layout); state.layout = 'custom'; }
  // a tab already showing in another pane moves: that pane closes first
  if (tabId) {
    const at = state.panes.slice(0, n).indexOf(tabId);
    if (at === idx) return;
    if (at >= 0) { const target = state.panes[idx]; closePaneInTree(at); idx = state.panes.indexOf(target); n = paneCount(); if (state.layout !== 'custom') { state.splitTree = { pane: 0 }; state.layout = 'custom'; } }
  }
  const panes = state.panes.slice(0, n);
  const walk = (node) => {
    if (node.pane === idx) return { dir, r: 0.5, a: before ? { pane: n } : { pane: idx }, b: before ? { pane: idx } : { pane: n } };
    if (node.pane != null) return node;
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  let id = tabId;
  if (!id) {
    const src = state.tabs.find((x) => x.id === panes[idx]);
    const t = newTabState(); state.tabs.push(t);
    navigate(t, src && !src.app ? src.path : 'atlas:home', { push: true });
    if (src && !src.app) { t.view = src.view; t.sort = { ...src.sort }; }
    id = t.id;
  }
  panes[n] = id;
  state.splitTree = walk(state.splitTree);
  state.panes = panes;
  // number panes in reading order (left to right, top to bottom)
  const order = treeLeaves(state.splitTree);
  const renum = (node) => (node.pane != null ? { pane: order.indexOf(node.pane) } : { ...node, a: renum(node.a), b: renum(node.b) });
  state.panes = order.map((i) => panes[i]);
  state.splitTree = renum(state.splitTree);
  state.activePane = state.panes.indexOf(id);
  bus.emit('tabs'); bus.emit('layout'); bus.emit('saveSession');
}
/** take pane `idx` out of a free layout: its neighbour grows into the space. Returns false when it isn't one. */
function closePaneInTree(idx) {
  if (state.layout !== 'custom' || !state.splitTree) return false;
  const drop = (node) => {
    if (node.pane != null) return node.pane === idx ? null : node;
    const a = drop(node.a), b = drop(node.b);
    return !a ? b : !b ? a : { ...node, a, b };
  };
  const tree = drop(state.splitTree);
  const old = treeLeaves(tree);
  const activeId = state.panes[state.activePane];
  // number the panes again in reading order
  const renum = (node) => (node.pane != null ? { pane: old.indexOf(node.pane) } : { ...node, a: renum(node.a), b: renum(node.b) });
  state.panes = old.map((i) => state.panes[i]);
  state.splitTree = old.length > 1 ? renum(tree) : null;
  state.layout = old.length > 1 ? 'custom' : '1';
  const ai = state.panes.indexOf(activeId);
  state.activePane = ai >= 0 ? ai : Math.min(old.indexOf(idx) >= 0 ? old.indexOf(idx) : 0, state.panes.length - 1);
  return true;
}
/** close a pane (keeps its tab) */
export function closePane(idx = state.activePane) {
  const n = paneCount();
  if (n < 2) return;
  if (state.layout !== 'custom') { state.splitTree = presetTree(state.layout); state.layout = 'custom'; }
  closePaneInTree(idx);
  bus.emit('tabs'); bus.emit('layout'); bus.emit('saveSession');
}

export function openTab(path, { activate = true, background = false, pane = null, after = null } = {}) {
  const t = newTabState();
  const idx = after ? state.tabs.indexOf(after) + 1 : state.tabs.length;
  state.tabs.splice(idx, 0, t);
  if (!background && activate) showTabInPane(t.id, pane ?? state.activePane);
  navigate(t, path || defaultStartPath(), { push: true });
  bus.emit('tabs');
  return t;
}

export function defaultStartPath() {
  const s = state.settings.startupPath;
  if (s && s !== 'restore' && s !== 'home') return s;
  return 'atlas:home';
}

export function showTabInPane(tabId, paneIdx) {
  const other = state.panes.indexOf(tabId);
  if (other >= 0 && other !== paneIdx) { state.activePane = other; bus.emit('layout'); return; }
  state.panes[paneIdx] = tabId;
  state.activePane = paneIdx;
  bus.emit('layout');
}

// A built-in app in a tab (Notepad, Photos, Player) is asked before it goes away: unsaved work gets a
// Save / Don't save / Cancel question. apptabs.js answers; without it, leaving is always fine.
let confirmLeaveApp = async () => true;
export function setLeaveHandler(fn) { confirmLeaveApp = fn; }
// every app tab in this window, one after another (closing the window, quitting)
export async function confirmLeaveAll(asking) {
  const apps = state.tabs.filter((x) => x.app);
  if (apps.length) asking?.();
  for (const t of apps) {
    if (!(await confirmLeaveApp(t))) return false;
  }
  return true;
}
export async function closeTab(t, { force = false } = {}) {
  if (!t) return;
  if (t.locked && !force) { toast('Tab is locked. Unlock it to close'); return; }
  if (t.app && !force && !(await confirmLeaveApp(t))) return;
  if (t.searchJob) api('work:cancel', t.searchJob);
  const i = state.tabs.indexOf(t);
  if (!t.app) state.closedTabs.unshift({ path: t.path, view: t.view, sort: t.sort, history: t.history, hi: t.hi });
  else bus.emit('tabClosed', t);
  state.closedTabs = state.closedTabs.slice(0, 30);
  state.tabs.splice(i, 1);
  if (!state.tabs.length) {
    if (state.settings.closeLastTabClosesWindow) { api('win:control', 'close'); return; }
    openTab('atlas:home');
    return;
  }
  // in a split view the pane closes with its tab and the layout shrinks (4 → 3 → 2 → 1)
  const n = paneCount();
  const pi = state.panes.slice(0, n).indexOf(t.id);
  if (pi >= 0 && n > 1 && closePaneInTree(pi)) { bus.emit('tabs'); bus.emit('layout'); return; }
  if (pi >= 0 && n > 1) {
    const P = state.panes.slice(0, n);
    let layout, order;
    if (n === 2) { layout = '1'; order = [P[1 - pi]]; }
    else if (n === 3) { if (pi === 0) { layout = '2h'; order = [P[1], P[2]]; } else { layout = '2v'; order = [P[0], P[pi === 1 ? 2 : 1]]; } }
    else { layout = '3'; order = pi === 0 ? [P[2], P[1], P[3]] : pi === 2 ? [P[0], P[1], P[3]] : [P[0], P[2], P[pi === 1 ? 3 : 1]]; }
    const wasActive = state.activePane === pi;
    const activeId = state.panes[state.activePane];
    state.layout = layout; state.panes = order;
    state.activePane = wasActive ? Math.min(pi, order.length - 1) : Math.max(0, order.indexOf(activeId));
    bus.emit('tabs'); bus.emit('layout');
    return;
  }
  // replace in panes
  state.panes = state.panes.map((pid, pi) => {
    if (pid !== t.id) return pid;
    const free = state.tabs.find((x) => !state.panes.includes(x.id)) || null;
    if (free) return free.id;
    const nt = newTabState(); state.tabs.push(nt); navigate(nt, 'atlas:home', { push: true }); return nt.id;
  });
  bus.emit('tabs'); bus.emit('layout');
}

export function reopenClosedTab() {
  const c = state.closedTabs.shift();
  if (!c) return;
  const t = openTab(c.path);
  t.view = c.view; t.sort = c.sort; t.history = c.history; t.hi = c.hi;
}

export function duplicateTab(t) {
  if (t.app) return t;
  const n = openTab(t.path, { after: t });
  n.view = t.view; n.sort = { ...t.sort }; n.group = t.group; n.history = [...t.history]; n.hi = t.hi; n.gridSize = t.gridSize;
  return n;
}

export function setLayout(layout) {
  if ((layout === '3' || layout === '4') && !requirePro('panes')) return;
  state.layout = layout;
  state.splitTree = null;
  const n = paneCount();
  const panes = state.panes.slice(0, n).filter(Boolean);
  // fill new panes with unshown tabs or clones of the active location
  while (panes.length < n) {
    const free = state.tabs.find((t) => !panes.includes(t.id));
    if (free) panes.push(free.id);
    else { const src = activeTab(); const t = newTabState(); state.tabs.push(t); navigate(t, src?.path || 'atlas:home', { push: true }); panes.push(t.id); }
  }
  state.panes = panes;
  if (state.activePane >= n) state.activePane = 0;
  bus.emit('tabs'); bus.emit('layout');
}

export function focusPane(i) {
  if (i < 0 || i >= paneCount()) return;
  state.activePane = i;
  document.querySelectorAll('.pane').forEach((p, k) => p.classList.toggle('active', k === i));
  bus.emit('activePane');
  bus.emit('tabs');
  paneEls[i]?.body.focus({ preventScroll: true });
}

export function otherPaneTab() {
  if (paneCount() < 2) return null;
  return paneTab((state.activePane + 1) % paneCount());
}

// ======================================================================
// Navigation & listing
// ======================================================================
const listCache = new Map(); // archive listings
const folderSizeCache = new Map();

export async function navigate(t, rawPath, { push = true, select = null, keepScroll = false, fromSync = false } = {}) {
  if (!t) return;
  // a built-in app in this tab: going somewhere else turns the tab back into a folder (after asking to save)
  if (t.app) {
    if (fromSync) return;
    if (!(await confirmLeaveApp(t))) return false;
    bus.emit('tabClosed', t);
    for (const k of ['app', 'appTitle', 'appPath', 'appState', 'appDirty']) delete t[k];
    t.path = null; t.history = []; t.hi = -1; t.items = []; t.shown = []; t._loadedOnce = false; t._viewInit = false;
    if (!t.view) t.view = state.settings.defaultView || 'details';
    if (!t.sort) t.sort = { key: 'name', dir: 1 };
    t.sel = new Set();
  }
  let p = isVirtual(rawPath) ? rawPath : normalize(expandUserPath(rawPath));
  if (!p) return;
  if (!isVirtual(p) && !/^\\\\[^\\]+\\?$/.test(p)) {
    const st = await api('fs:stat', p);
    if (!st) { toast(`Can't find "${rawPath}". Check the spelling and try again.`, { error: true }); return false; }
    if (!st.isDir) { // navigating to a file: open its folder and select it
      select = p; p = dirname(p);
    }
  }
  if (t.searchJob && !p.startsWith('atlas:search')) { api('work:cancel', t.searchJob); t.searchJob = null; }
  if (!p.startsWith('atlas:search')) t.searchInfo = null;
  const prev = t.path;
  if (prev && prev !== p) rememberFolderView(t);
  // the folder animation plays once the new folder has rendered (into a folder: open; back up: close)
  if (prev && prev !== p && !fromSync && !p.startsWith('atlas:search')) t._anim = { dir: directionOf(prev, p) };
  t.path = p;
  if (push) {
    t.history = t.history.slice(0, t.hi + 1);
    if (t.history[t.history.length - 1] !== p) t.history.push(p);
    if (t.history.length > 200) t.history.shift();
    t.hi = t.history.length - 1;
  }
  if (prev !== p) { t.filter = ''; t.sel = new Set(); t.focus = null; t.anchor = null; if (!keepScroll) t.scroll = 0; applyFolderView(t); if (t.sort?.key === 'match' && !p.includes('ai=1')) t.sort = { ...(state.settings.defaultSort || { key: 'name', dir: 1 }) }; }
  if (select) { t.sel = new Set([normalize(select)]); t.focus = normalize(select); t.anchor = t.focus; t._scrollToFocus = true; }
  addRecent(p);
  bus.emit('tabs');
  await loadTab(t);
  bus.emit('navigated', { t, path: p, sync: fromSync });
  // Sync browsing: mirror relative navigation in the other panes
  if (state.settings.syncNavigation && !fromSync && prev && !isVirtual(prev) && !isVirtual(p)) {
    for (let i = 0; i < paneCount(); i++) {
      const o = paneTab(i);
      if (!o || o === t || !o.path || isVirtual(o.path)) continue;
      let target = null;
      if (isInside(p, prev)) target = pjoin(o.path, p.slice(prev.length).replace(/^[\\/]/, ''));
      else if (isInside(prev, p)) { let q = o.path; const ups = prev.slice(p.length).split(/[\\/]/).filter(Boolean).length; for (let k = 0; k < ups; k++) q = dirname(q); target = q; }
      if (target) navigate(o, target, { fromSync: true });
    }
  }
  return true;
}

function viewKey(p) { return IS_WIN() ? p.toLowerCase() : p; }
function rememberFolderView(t) {
  if (!state.settings.rememberFolderViews || !t.path || t.path.startsWith('atlas:search')) return;
  if (!t._viewTouched) return;
  state.folderViews[viewKey(t.path)] = { view: t.view, sort: t.sort, group: t.group, gridSize: t.gridSize, rowZoom: t.rowZoom || 1 };
  const keys = Object.keys(state.folderViews);
  if (keys.length > 2000) delete state.folderViews[keys[0]];
  saveLibrary();
}
function applyFolderView(t) {
  t._viewTouched = false;
  if (t.path.startsWith('atlas:search') || t.path === 'atlas:recycle') { t.view = 'details'; t.group = null; return; }
  if (t.path === 'atlas:recent') { t.view = 'details'; t.sort = { key: 'mtime', dir: -1 }; t.group = 'date'; return; }
  if (t.path === 'atlas:home' || t.path === 'atlas:thispc' || t.path === 'atlas:network') { t.view = 'grid'; t.group = 'section'; t.sort = { key: 'none', dir: 1 }; return; }
  if (t.sort.key === 'none') t.sort = { key: 'name', dir: 1 };
  if (t.group === 'section') t.group = null;
  const fv = state.settings.rememberFolderViews && state.folderViews[viewKey(t.path)];
  if (fv) { t.view = fv.view; t.sort = fv.sort; t.group = fv.group; t.gridSize = fv.gridSize; t.rowZoom = fv.rowZoom || 1; } else t.rowZoom = 1;
}
export function touchView(t) { t._viewTouched = true; rememberFolderView(t); }

export function goBack(t) { if (t.hi > 0) { t.hi--; navigate(t, t.history[t.hi], { push: false, select: t.history[t.hi + 1] && dirname(t.history[t.hi + 1]) === t.history[t.hi] ? t.history[t.hi + 1] : null }); } }
export function goForward(t) { if (t.hi < t.history.length - 1) { t.hi++; navigate(t, t.history[t.hi], { push: false }); } }
export function goUp(t) {
  if (!t.path) return;
  if (t.path.startsWith('atlas:zip|')) { const [, arc, inner] = t.path.split('|'); if (!inner) return navigate(t, dirname(arc), { select: arc }); const parts = inner.split('/'); parts.pop(); return navigate(t, `atlas:zip|${arc}|${parts.join('/')}`); }
  if (isMtp(t.path) || isRemote(t.path)) return navigate(t, dirname(t.path), { select: t.path });
  if (isVirtual(t.path)) return navigate(t, IS_WIN() ? 'atlas:thispc' : 'atlas:home');
  const up = dirname(t.path);
  if (up) navigate(t, up, { select: t.path });
}

let loadSeq = 0;
export async function loadTab(t, { soft = false } = {}) {
  if (t.app) return;
  if (!t._viewInit) { t._viewInit = true; if (!t._restoredView) applyFolderView(t); }
  const seq = ++loadSeq;
  t._seq = seq;
  if (!soft) { t.loading = true; t.error = null; renderTabPanes(t); }
  const p = t.path;
  let items = [];
  let error = null;
  try {
    if (p === 'atlas:home') items = await A.listHome();
    else if (p === 'atlas:thispc') items = await A.listThisPC();
    else if (p === 'atlas:recent') items = await A.listRecent();
    else if (p === 'atlas:recycle') items = await A.listRecycle();
    else if (p === 'atlas:network') items = await A.listNetwork();
    else if (p.startsWith('atlas:tag:')) items = await A.listTag(p.slice(10));
    else if (p.startsWith('atlas:search')) { if (!soft) await A.runSearch(t); items = t.items; }
    else if (p.startsWith('atlas:zip|')) items = await listArchive(p);
    else if (isMtp(p)) items = await api('mtp:list', p);
    else if (isRemote(p)) { const { id, path } = remoteParts(p); items = (await api('remote:list', id, path)).map((i) => ({ ...i, ext: i.isDir ? '' : extname(i.name) })); }
    else {
      // network locations: don't hang on a server that isn't answering
      if (isNetworkPath(p) && !(await api('net:reachable', p, 5000))) throw Object.assign(new Error('offline'), { netdown: true });
      const r = await api('fs:list', p);
      if (r.error) error = r.error;
      items = r.items;
    }
  } catch (e) { error = e.netdown ? 'netdown' : String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  if (t._seq !== seq || t.path !== p) return;
  t.items = items;
  t.error = error;
  t.loading = false;
  // keep selection only for still-existing paths
  const exists = new Set(items.map((i) => i.path));
  t.sel = new Set([...t.sel].filter((x) => exists.has(x)));
  if (t.focus && !exists.has(t.focus)) t.focus = null;
  recompute(t);
  renderTabPanes(t);
  if (t._anim) {
    const a = t._anim; t._anim = null;
    state.panes.forEach((pid, i) => { if (pid === t.id && i < paneCount() && paneEls[i]) playFolderAnim(paneEls[i], a.dir); });
  }
  if (!isVirtual(p)) {
    if (state.settings.gitBadges) api('git:status', p).then((g) => { if (t.path === p) { t.git = g ? indexGit(g) : null; renderTabPanes(t, true); bus.emit('status'); } });
    else t.git = null;
    if (state.settings.folderSizes) computeFolderSizes(t);
  } else t.git = null;
  bus.emit('status');
  bus.emit('loaded', t);
}

function indexGit(g) {
  if (!g.files) return g;
  const dirs = new Map();
  for (const [f, code] of Object.entries(g.files)) {
    let d = f;
    for (let i = 0; i < 64; i++) { const up = dirname(d); if (!up || up === d || up.startsWith('atlas:')) break; d = up; if (!dirs.has(d)) dirs.set(d, code.includes('?') ? '?' : 'M'); if (samePath(d, g.root)) break; }
  }
  return { ...g, dirs };
}

export function invalidateArchive(arc) { listCache.delete(arc); }
async function listArchive(p) {
  const [, arc, inner = ''] = p.split('|');
  let entries = listCache.get(arc);
  if (!entries) { entries = await api('archive:list', arc); listCache.set(arc, entries); if (listCache.size > 20) listCache.delete(listCache.keys().next().value); }
  const prefix = inner ? inner + '/' : '';
  const seen = new Map();
  for (const e of entries) {
    const ep = e.path.replace(/^\.?\//, '');
    if (!ep.startsWith(prefix) || ep === prefix) continue;
    const rest = ep.slice(prefix.length).replace(/\/$/, '');
    if (!rest) continue;
    const first = rest.split('/')[0];
    const isDir = rest.includes('/') || e.isDir;
    const key = first;
    if (seen.has(key)) { const s = seen.get(key); if (!s.isDir && isDir) s.isDir = true; if (!isDir || rest.includes('/')) { /* accumulate size */ s.size = (s.size || 0) + (rest.includes('/') ? e.size : 0); } continue; }
    seen.set(key, { name: first, path: `atlas:zip|${arc}|${prefix}${first}`, isDir, size: isDir ? (rest.includes('/') ? e.size : 0) : e.size, mtime: e.mtime, ctime: e.mtime, ext: isDir ? '' : extname(first), archive: { arc, entry: prefix + first }, hidden: false });
  }
  return [...seen.values()];
}

async function computeFolderSizes(t) {
  let dirs = t.items.filter((i) => i.isDir && !i.virtual);
  let i = 0;
  const p = t.path;
  // everything the instant index knows comes back in one call
  const known = dirs.length ? await api('index:sizes', dirs.map((d) => d.path)).catch(() => ({})) : {};
  if (t.path !== p) return;
  for (const d of dirs) { const k = known[d.path]; if (k) { d.size = k.size; folderSizeCache.set(d.path, { total: k.size, files: k.files, at: Date.now() }); } }
  if (Object.keys(known).length) rerenderSoon(t);
  dirs = dirs.filter((d) => !known[d.path]);
  const next = async () => {
    if (t.path !== p || i >= dirs.length) return;
    const d = dirs[i++];
    const cached = folderSizeCache.get(d.path);
    if (cached && Date.now() - cached.at < 60000) d.size = cached.total;
    else { const r = await A.folderSize(d.path); d.size = r.total; folderSizeCache.set(d.path, { total: r.total, at: Date.now() }); }
    rerenderSoon(t);
    await next();
  };
  await Promise.all([next(), next(), next()]);
  if (t.sort.key === 'size') { recompute(t); renderTabPanes(t); }
}
const rerenderSoon = debounce((t) => renderTabPanes(t, true), 150);

// ======================================================================
// Sorting / filtering / grouping
// ======================================================================
export function visibleFilter(it) {
  if (it.virtual) return true;
  if (it.name === '.folder.md' && state.settings.folderNotes !== false) return false; // shown as the folder's note instead
  if (!state.settings.showHidden && it.hidden) return false;
  if (!state.settings.showSystem && it.system && it.hidden) return false;
  return true;
}

function filterTest(f) {
  f = f.trim();
  if (!f) return null;
  if (/^\/.+\/[a-z]*$/.test(f)) { try { const i = f.lastIndexOf('/'); const re = new RegExp(f.slice(1, i), f.slice(i + 1) || 'i'); return (n) => re.test(n); } catch { return () => true; } }
  if (/[*?]/.test(f)) { const re = new RegExp('^' + f.split(/[;,]/).map((p) => p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('$|^') + '$', 'i'); return (n) => re.test(n); }
  if (f.startsWith('.') && !f.includes(' ')) { const e = f.slice(1).toLowerCase(); return (n) => n.toLowerCase().endsWith('.' + e); }
  const words = f.toLowerCase().split(/\s+/);
  return (n) => { const s = n.toLowerCase(); return words.every((w) => (w.startsWith('-') && w.length > 1 ? !s.includes(w.slice(1)) : s.includes(w))); };
}

// load media details (sizes, dates taken, lengths, BPM…) when something on screen needs them
const META_SORTS = new Set(['taken', 'camera', 'dims', 'duration', 'bpm', 'key', 'color']);
function needsMeta(t) {
  if (t.view === 'gallery' || META_SORTS.has(t.sort?.key) || ['gallery', 'camera', 'takenMonth', 'color'].includes(t.group) || MM.mediaFilterActive(t)) return true;
  return t.view === 'details' && columnsFor(t).some((c) => MEDIA_COLS.includes(c));
}
function requestMeta(t) {
  if (!t.items?.length || isVirtual(t.path) && !t.path.startsWith('atlas:search') && !t.path.startsWith('atlas:tag') || !needsMeta(t)) return;
  const sig = t.path + '|' + t.items.length;
  if (t._metaSig === sig) return;
  t._metaSig = sig;
  let timer = null;
  MM.ensureMeta(t.items, { onUpdate: () => { clearTimeout(timer); timer = setTimeout(() => { if (t._metaSig !== sig) return; recompute(t); renderTabPanes(t, true); }, 200); } });
}

export function isNetworkPath(p) {
  if (!p || isVirtual(p)) return isRemote(p);
  if (p.startsWith('\\\\')) return true;
  const d = (state.drives || []).find((x) => x.type === 'network' && x.path && p.toUpperCase().startsWith(x.path.toUpperCase().slice(0, 2)));
  return !!d;
}

// Natural, case-insensitive name order (file2 before file10), like Explorer. Plain names compare by a key worked
// out once per item (numbers padded), which is many times faster than the locale collator on big folders; names
// with accents or other scripts still use the collator.
// punctuation sorts before digits and letters, in the locale collator's order
const PUNCT_RANK = Object.fromEntries([...' _-,;:!?.\'"()[]{}@*/\\&#%`^+<=>|~$'].map((c, i) => [c, String.fromCharCode(1 + i)]));
function natKey(it) {
  if (it._nk !== undefined && it._nkn === it.name) return it._nk;
  const n = it.name;
  let k = null;
  if (/^[\x20-\x7e]*$/.test(n)) k = n.toLowerCase().replace(/[^a-z0-9]/g, (c) => PUNCT_RANK[c] || c).replace(/\d+/g, (d) => { const t = d.replace(/^0+(?=\d)/, ''); return String.fromCharCode(48 + Math.min(t.length, 40)) + t; });
  it._nk = k; it._nkn = n;
  return k;
}
function nameCmp(a, b) {
  const x = natKey(a), y = natKey(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : natCmp(a.name, b.name);
  return natCmp(a.name, b.name);
}

export function recompute(t) {
  let list = t.items.filter(visibleFilter);
  const ft = filterTest(t.filter || '');
  if (ft) list = list.filter((i) => ft(i.name));
  if (t.tagFilter) list = list.filter((i) => tagsOf(i.path).includes(t.tagFilter));
  const mft = MM.mediaFilterTest(t);
  if (mft) list = list.filter(mft);
  requestMeta(t);
  const { key, dir } = t.sort;
  if (key !== 'none') {
    const ff = state.settings.foldersFirst;
    const byName = (a, b) => nameCmp(a, b);
    const val = {
      name: byName,
      mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      ctime: (a, b) => (a.ctime || 0) - (b.ctime || 0),
      size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
      type: (a, b) => natCmp(typeLabel(a), typeLabel(b)) || natCmp(a.name, b.name),
      ext: (a, b) => natCmp(a.ext || '', b.ext || '') || natCmp(a.name, b.name),
      location: (a, b) => natCmp(dirname(a.path) || '', dirname(b.path) || '') || natCmp(a.name, b.name),
      deleted: (a, b) => (a.recycle?.deleted || 0) - (b.recycle?.deleted || 0),
      tags: (a, b) => (tagsOf(a.path)[0] || 'zz').localeCompare(tagsOf(b.path)[0] || 'zz'),
      match: (a, b) => (a.aiScore || 0) - (b.aiScore || 0),
      taken: (a, b) => MM.takenOf(a) - MM.takenOf(b),
      camera: (a, b) => natCmp(MM.metaOf(a)?.camera || '~', MM.metaOf(b)?.camera || '~'),
      dims: (a, b) => (MM.metaOf(a)?.w || 0) * (MM.metaOf(a)?.h || 0) - (MM.metaOf(b)?.w || 0) * (MM.metaOf(b)?.h || 0),
      duration: (a, b) => (MM.metaOf(a)?.dur || 0) - (MM.metaOf(b)?.dur || 0),
      bpm: (a, b) => (MM.metaOf(a)?.bpm || 0) - (MM.metaOf(b)?.bpm || 0),
      key: (a, b) => natCmp(MM.metaOf(a)?.camelot || '~', MM.metaOf(b)?.camelot || '~'),
      color: (a, b) => MM.COLORS.findIndex((c) => c[0] === MM.metaOf(a)?.color) - MM.COLORS.findIndex((c) => c[0] === MM.metaOf(b)?.color),
    }[key] || ((a, b) => natCmp(a.name, b.name));
    list.sort((a, b) => {
      if (ff && a.isDir !== b.isDir && key !== 'location') return a.isDir ? -1 : 1;
      const r = val(a, b);
      return (r || byName(a, b)) * dir;
    });
  }
  // grouping
  const g = t.group;
  if (g) {
    const label = (it) => {
      if (g === 'section') return it.section || '';
      if (g === 'type') return typeLabel(it);
      if (g === 'kind') return { folder: 'Folders', image: 'Pictures', video: 'Videos', audio: 'Music', archive: 'Archives', document: 'Documents', code: 'Code', executable: 'Programs', font: 'Fonts', model: '3D models', other: 'Other' }[kindOf(it)];
      if (g === 'date') return dateBucket(it.mtime);
      if (g === 'size') return sizeBucket(it.size, it.isDir);
      if (g === 'name') { const c = (it.name[0] || '#').toUpperCase(); return /[A-Z]/.test(c) ? c : /\d/.test(c) ? '0–9' : '#'; }
      if (g === 'tag') { const tg = tagsOf(it.path)[0]; return tg ? state.tags.defs.find((d) => d.id === tg)?.name || tg : 'No tag'; }
      if (g === 'location') return dirname(it.path) || '';
      if (g === 'gallery') return it.isDir ? 'Folders' : MM.galleryKind(it);
      if (g === 'camera') return it.isDir ? 'Folders' : MM.metaOf(it)?.camera || 'Unknown camera';
      if (g === 'takenMonth') { if (it.isDir) return 'Folders'; const d = new Date(MM.takenOf(it)); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }); }
      if (g === 'color') return it.isDir ? 'Folders' : (MM.metaOf(it)?.color || 'unknown').replace(/^./, (c) => c.toUpperCase());
      return '';
    };
    const groups = new Map();
    for (const it of list) { const l = label(it); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(it); }
    t.groups = [...groups.entries()].map(([label, items]) => ({ label, items, collapsed: t._collapsed?.has(label) }));
    list = t.groups.flatMap((gr) => (gr.collapsed ? [] : gr.items));
  } else t.groups = null;
  t.shown = list;
  t.indexOf = new Map(list.map((it, i) => [it.path, i]));
  let mx = 0; for (const it of list) if (!it.drive && it.size > mx) mx = it.size;
  t._maxSize = mx;
}

// ======================================================================
// Pane DOM
// ======================================================================
export const paneEls = []; // [{root, nav, crumbs, body, scroller, inner, overlay, header}]
const thumbCache = new Map();
let thumbBytes = 0;
const fontCache = new Map();
const iconCache = new Map();

export function buildPanes(host) {
  host.innerHTML = '';
  paneEls.length = 0;
  const n = paneCount();
  host.className = `panes layout-${state.layout}`;
  const mk = (i) => {
    const root = h('section', { class: 'pane' + (i === state.activePane ? ' active' : ''), 'data-idx': i });
    const nav = h('div', { class: 'pane-nav' });
    const tools = h('div', { class: 'pane-tools' });
    const body = h('div', { class: 'pane-body', tabindex: '0' });
    const scroller = h('div', { class: 'scroller' });
    const inner = h('div', { class: 'inner', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Files' });
    const overlay = h('div', { class: 'overlay' });
    scroller.append(inner, overlay);
    body.append(scroller);
    root.append(nav, tools, body);
    const el = { root, nav, tools, body, scroller, inner, overlay, idx: i };
    paneEls[i] = el;
    wirePane(el);
    return root;
  };
  const v = state.paneSizes.v, hh = state.paneSizes.h;
  if (n === 1) host.append(mk(0));
  else if (state.layout === '2v') { host.append(mk(0), splitter('v'), mk(1)); host.style.gridTemplateColumns = `${v}fr 1px ${1 - v}fr`; host.style.gridTemplateRows = ''; }
  else if (state.layout === '2h') { host.append(mk(0), splitter('h'), mk(1)); host.style.gridTemplateRows = `${hh}fr 1px ${1 - hh}fr`; host.style.gridTemplateColumns = ''; }
  else if (state.layout === '3') {
    const right = h('div', { class: 'stack-col' }, mk(1), splitter('h', true), mk(2));
    right.style.gridTemplateRows = `${hh}fr 1px ${1 - hh}fr`;
    host.append(mk(0), splitter('v'), right);
    host.style.gridTemplateColumns = `${v}fr 1px ${1 - v}fr`; host.style.gridTemplateRows = '';
  } else if (state.layout === '4') {
    const c1 = h('div', { class: 'stack-col' }, mk(0), splitter('h', true), mk(2));
    const c2 = h('div', { class: 'stack-col' }, mk(1), splitter('h', true), mk(3));
    c1.style.gridTemplateRows = c2.style.gridTemplateRows = `${hh}fr 1px ${1 - hh}fr`;
    host.append(c1, splitter('v'), c2);
    host.style.gridTemplateColumns = `${v}fr 1px ${1 - v}fr`; host.style.gridTemplateRows = '';
  }
  if (state.layout === 'custom' && state.splitTree && n > 1) {
    // a free layout: nested two-way splits, each with its own divider
    host.style.gridTemplateColumns = ''; host.style.gridTemplateRows = '';
    const tpl = (node) => `${node.r}fr 1px ${1 - node.r}fr`;
    const build = (node) => {
      if (node.pane != null) return mk(node.pane);
      const box = h('div', { class: `split-node ${node.dir}` });
      box.style[node.dir === 'v' ? 'gridTemplateColumns' : 'gridTemplateRows'] = tpl(node);
      const div = h('div', { class: `splitter ${node.dir}` });
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r = box.getBoundingClientRect();
        const move = (ev) => {
          node.r = Math.min(0.88, Math.max(0.12, node.dir === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height));
          box.style[node.dir === 'v' ? 'gridTemplateColumns' : 'gridTemplateRows'] = tpl(node);
          paneEls.forEach((p, i) => renderView(i));
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); bus.emit('saveSession'); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
      div.addEventListener('dblclick', () => { node.r = 0.5; buildPanes(host); });
      box.append(build(node.a), div, build(node.b));
      return box;
    };
    host.classList.add('free');
    host.append(build(state.splitTree));
  }
  if (n === 1) { host.style.gridTemplateColumns = ''; host.style.gridTemplateRows = ''; }
  for (let i = 0; i < n; i++) renderPane(i);
  watchPanes();
  bus.emit('panesBuilt');
}

function splitter(dir, nested) {
  const s = h('div', { class: `splitter ${dir}` });
  s.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const host = nested ? s.parentElement : s.parentElement;
    const r = host.getBoundingClientRect();
    const move = (ev) => {
      if (dir === 'v') state.paneSizes.v = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
      else state.paneSizes.h = Math.min(0.85, Math.max(0.15, (ev.clientY - r.top) / r.height));
      const v = state.paneSizes.v, hh = state.paneSizes.h;
      const root = document.getElementById('panes');
      if (dir === 'v') root.style.gridTemplateColumns = `${v}fr 1px ${1 - v}fr`;
      else { if (state.layout === '2h') root.style.gridTemplateRows = `${hh}fr 1px ${1 - hh}fr`; root.querySelectorAll('.stack-col').forEach((c) => (c.style.gridTemplateRows = `${hh}fr 1px ${1 - hh}fr`)); }
      paneEls.forEach((p, i) => renderView(i));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); bus.emit('saveSession'); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  s.addEventListener('dblclick', () => { state.paneSizes[dir] = 0.5; buildPanes(document.getElementById('panes')); });
  return s;
}

export function renderTabPanes(t, viewOnly) {
  state.panes.forEach((pid, i) => { if (pid === t.id && i < paneCount()) viewOnly ? renderView(i) : renderPane(i); });
}
export function renderAll() { for (let i = 0; i < paneCount(); i++) renderPane(i); }

export function renderPane(i) {
  const el = paneEls[i];
  const t = paneTab(i);
  if (!el || !t) return;
  el.root.classList.toggle('active', i === state.activePane);
  el.root.classList.toggle('app-pane', !!t.app);
  if (t.app) { el.nav.innerHTML = ''; el.tools.innerHTML = ''; el.inner.innerHTML = ''; el._cells = null; el.scroller.querySelector('.details-head')?.remove(); bus.emit('syncFrames'); return; }
  el.root.dataset.view = t.view;
  // Ctrl+wheel in Details / List makes rows bigger or smaller instead of switching view
  if (t.rowZoom && t.rowZoom !== 1) { el.root.style.setProperty('--row-h', ROW_H(t) + 'px'); el.root.style.setProperty('--fs', String((state.settings.fontScale || 1) * t.rowZoom)); }
  else { el.root.style.removeProperty('--row-h'); el.root.style.removeProperty('--fs'); }
  renderNav(el, t);
  renderTools(el, t);
  renderView(i);
  bus.emit('paneRendered', { el, t });
}

// ---------- nav row: back / forward / up / breadcrumb / caret ----------
function renderNav(el, t) {
  const canBack = t.hi > 0, canFwd = t.hi < t.history.length - 1;
  el.nav.innerHTML = '';
  const btn = (name, title, enabled, fn, cls = '') => {
    const b = h('button', { class: 'nav-btn ' + cls, title, disabled: !enabled, html: icon(name) });
    b.addEventListener('click', (e) => { e.stopPropagation(); focusPane(el.idx); fn(e); });
    return b;
  };
  const back = btn('back', 'Back (Alt+Left)', canBack, () => goBack(t));
  const fwd = btn('forward', 'Forward (Alt+Right)', canFwd, () => goForward(t));
  back.addEventListener('contextmenu', (e) => { e.preventDefault(); historyMenu(t, -1, e); });
  fwd.addEventListener('contextmenu', (e) => { e.preventDefault(); historyMenu(t, 1, e); });
  const up = btn('up', 'Up (Alt+Up)', !!t.path && t.path !== 'atlas:home' && !(isVirtual(t.path) && !t.path.startsWith('atlas:zip')) || (t.path && !isVirtual(t.path)), () => goUp(t));
  const crumbBtn = btn('chevronRight', 'Recent locations', true, (e) => recentMenu(t, e), 'crumb-root');
  const crumbs = h('div', { class: 'crumbs', title: 'Click to type a path' });
  const parts = splitPath(t.path || '');
  // On Windows show the path like the design: "Documents / Design / References": start from a friendly anchor
  let startIdx = 0;
  const known = sys.known;
  const anchors = [known.home, known.onedrive].filter(Boolean);
  for (let k = parts.length - 1; k >= 0; k--) { if (anchors.some((a) => samePath(a, parts[k].path))) { startIdx = k + 1 < parts.length ? k + 1 : k; break; } }
  if (state.settings.fullCrumbs) startIdx = 0;
  const shown = parts.slice(startIdx);
  if (startIdx > 0) {
    const more = h('span', { class: 'crumb more', title: parts.slice(0, startIdx).map((p) => p.label).join(' / ') }, '…');
    more.addEventListener('click', (e) => { e.stopPropagation(); showMenu(parts.slice(0, startIdx).reverse().map((p) => ({ label: p.label, icon: 'folder', run: () => navigate(t, p.path) })), e.clientX, e.clientY + 10); });
    crumbs.append(more, h('span', { class: 'crumb-sep' }, '/'));
  }
  shown.forEach((c, k) => {
    const last = k === shown.length - 1;
    const span = h('span', { class: 'crumb' + (last ? ' current' : ''), 'data-path': c.path }, c.label);
    span.addEventListener('click', (e) => { e.stopPropagation(); focusPane(el.idx); if (e.ctrlKey || e.button === 1) openTab(c.path, { after: t }); else if (!last) navigate(t, c.path); else startPathEdit(el, t); });
    span.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openTab(c.path, { after: t }); } });
    span.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); A.folderContextMenu(c.path, e); });
    attachDropTarget(span, () => (isVirtual(c.path) ? null : c.path));
    crumbs.append(span);
    if (!last || (!isVirtual(c.path))) {
      const sep = h('span', { class: 'crumb-sep' + (last ? ' tail' : ''), title: 'Subfolders' }, last ? '' : '/');
      if (!isVirtual(c.path)) sep.addEventListener('click', async (e) => { e.stopPropagation(); subfolderMenu(t, c.path, e); });
      crumbs.append(sep);
    }
  });
  crumbs.addEventListener('click', (e) => { if (e.target === crumbs) startPathEdit(el, t); });
  crumbs.addEventListener('dblclick', (e) => { if (e.target === crumbs) startPathEdit(el, t); });
  const filterBox = h('input', { class: 'filter-box' + (t.filter ? ' has' : ''), placeholder: 'Filter', value: t.filter || '', spellcheck: 'false', title: 'Filter this folder (Ctrl+F). Supports *.jpg, -exclude, /regex/' });
  filterBox.addEventListener('input', () => { t.filter = filterBox.value; filterBox.classList.toggle('has', !!t.filter); recompute(t); renderView(el.idx); bus.emit('status'); });
  filterBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { t.filter = ''; filterBox.value = ''; filterBox.classList.remove('has'); recompute(t); renderView(el.idx); el.body.focus(); } if (e.key === 'Enter' || e.key === 'ArrowDown') { el.body.focus(); if (!t.focus && t.shown[0]) selectOnly(t, t.shown[0].path); renderView(el.idx); } e.stopPropagation(); });
  const caret = h('button', { class: 'nav-btn caret', title: state.settings.ribbonPinned ? 'Collapse the ribbon (Ctrl+F1)' : 'Expand the ribbon (Ctrl+F1)', html: icon(state.settings.ribbonPinned ? 'caretUp' : 'caretDown') });
  caret.addEventListener('click', () => bus.emit('toggleRibbon'));
  el.nav.append(back, fwd, up, crumbBtn, crumbs, filterBox);
  if (el.idx === 0 || paneCount() === 1) el.nav.append(caret);
  if (t.loading) el.nav.append(h('div', { class: 'loading-bar' }));
}

function historyMenu(t, dir, e) {
  const list = dir < 0 ? t.history.slice(0, t.hi).map((p, i) => [p, i]).reverse() : t.history.slice(t.hi + 1).map((p, i) => [p, t.hi + 1 + i]);
  showMenu(list.slice(0, 20).map(([p, i]) => ({ label: virtualTitle(p) === p ? basename(p) || p : virtualTitle(p), keys: isVirtual(p) ? '' : dirname(p) || '', icon: 'folder', run: () => { t.hi = i; navigate(t, p, { push: false }); } })), e.clientX, e.clientY);
}

function recentMenu(t, e) {
  const items = state.recent.filter((p) => !samePath(p, t.path)).slice(0, 15).map((p) => ({ label: basename(p) || p, keys: dirname(p) || '', icon: 'history', run: () => navigate(t, p) }));
  showMenu([{ header: 'Recent locations' }, ...items, { separator: true }, { label: 'Home', icon: 'home', run: () => navigate(t, 'atlas:home') }, IS_WIN() && { label: 'This PC', icon: 'computer', run: () => navigate(t, 'atlas:thispc') }, { label: 'Recycle Bin', icon: 'recycle', run: () => navigate(t, 'atlas:recycle'), hidden: !IS_WIN() }], e.clientX, e.clientY + 12);
}

async function subfolderMenu(t, p, e) {
  const subs = await api('fs:subdirs', p, state.settings.showHidden);
  if (!subs.length) { showMenu([{ label: 'No subfolders', disabled: true }], e.clientX, e.clientY + 12); return; }
  showMenu(subs.slice(0, 400).map((n) => ({ label: n, icon: 'folder', run: () => navigate(t, pjoin(p, n)) })), e.clientX, e.clientY + 12);
}

export function startPathEdit(el, t) {
  const crumbs = el.nav.querySelector('.crumbs');
  if (!crumbs || el.nav.querySelector('.path-edit')) return;
  const input = h('input', { class: 'path-edit', value: isVirtual(t.path) ? (t.path.startsWith('atlas:zip|') ? t.path.split('|')[1] : virtualTitle(t.path)) : t.path, spellcheck: 'false' });
  const list = h('div', { class: 'autocomplete' });
  crumbs.replaceWith(input);
  el.nav.append(list);
  input.focus(); input.select();
  let sugg = []; let si = -1;
  const done = (go) => {
    const v = input.value.trim();
    list.remove();
    if (go && v) {
      if (/^(cmd|powershell|pwsh|wt)(\.exe)?$/i.test(v) && !isVirtual(t.path)) { api('shell:terminal', t.path, v.toLowerCase().replace('.exe', '')); renderPane(el.idx); return; }
      if (/^https?:\/\//i.test(v)) { api('shell:openExternal', v); renderPane(el.idx); return; }
      if (v.startsWith('?')) { renderPane(el.idx); A.searchHere(t, v.slice(1)); return; }
      navigate(t, v).then((ok) => { if (ok === false) renderPane(el.idx); });
    } else renderPane(el.idx);
  };
  const update = debounce(async () => {
    const v = expandUserPath(input.value);
    if (!v || isVirtual(v)) { list.innerHTML = ''; return; }
    const sep = sys.sep;
    const i = v.lastIndexOf(sep);
    if (i < 0) { list.innerHTML = ''; return; }
    const base = v.slice(0, i + 1) || sep;
    const partial = v.slice(i + 1).toLowerCase();
    const subs = await api('fs:subdirs', base.length > 3 && base.endsWith(sep) ? base.slice(0, -1) : base, true);
    sugg = subs.filter((s) => s.toLowerCase().startsWith(partial)).slice(0, 12).map((s) => pjoin(base.endsWith(sep) ? base.slice(0, -1) || sep : base, s));
    si = -1;
    list.innerHTML = sugg.map((s, k) => `<div class="ac-item" data-k="${k}">${icon('folder')}<span>${esc(s)}</span></div>`).join('');
  }, 80);
  list.addEventListener('mousedown', (e) => { const it = e.target.closest('.ac-item'); if (it) { e.preventDefault(); input.value = sugg[+it.dataset.k]; done(true); } });
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); if (si >= 0) input.value = sugg[si]; done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); el.body.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!sugg.length) return;
      si = (si + (e.key === 'ArrowDown' ? 1 : -1) + sugg.length) % sugg.length;
      list.querySelectorAll('.ac-item').forEach((n, k) => n.classList.toggle('on', k === si));
    } else if (e.key === 'Tab' && sugg.length) { e.preventDefault(); input.value = sugg[Math.max(0, si)] + sys.sep; update(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) done(false); }, 120));
}

// ---------- tools row: sort label + view switches ----------
function renderTools(el, t) {
  const sortNames = { name: 'Name', mtime: 'Date modified', ctime: 'Date created', size: 'Size', type: 'Type', ext: 'Extension', location: 'Location', deleted: 'Date deleted', tags: 'Tags', match: 'Best match', none: 'Default' };
  el.tools.innerHTML = '';
  const sortBtn = h('button', { class: 'sort-btn', title: 'Sort & group' }, h('span', {}, (sortNames[t.sort.key] || 'Name').toUpperCase()), h('span', { class: 'sort-caret', html: icon(t.sort.dir > 0 ? 'caretDown' : 'caretUp') }));
  sortBtn.addEventListener('click', (e) => { focusPane(el.idx); sortMenu(t, e.currentTarget.getBoundingClientRect()); });
  el.tools.append(sortBtn);
  if (t.group && t.group !== 'section') el.tools.append(h('span', { class: 'group-pill', title: 'Grouped (click to remove)', onclick: () => { t.group = null; touchView(t); recompute(t); renderPane(el.idx); } }, `GROUPED BY ${t.group.toUpperCase()}`, h('span', { html: icon('close') })));
  if (t.tagFilter) { const tg = state.tags.defs.find((d) => d.id === t.tagFilter); el.tools.append(h('span', { class: 'group-pill', style: { '--tag': tg?.color }, onclick: () => { t.tagFilter = null; recompute(t); renderPane(el.idx); } }, h('span', { class: 'tdot' }), (tg?.name || '').toUpperCase(), h('span', { html: icon('close') }))); }
  if (t.searchInfo) {
    el.tools.append(h('span', { class: 'search-info' + (t.searchInfo.running ? ' running' : '') }, t.searchInfo.text));
    if (t.searchInfo.running) el.tools.append(h('button', { class: 'btn small search-stop', title: 'Stop searching and keep what was found so far', onclick: (e) => { e.stopPropagation(); bus.emit('stopSearch', t); } }, h('span', { html: icon('close') }), 'Stop'));
  }
  const spacer = h('div', { class: 'spacer' });
  el.tools.append(spacer);
  // media filter (colour, kind, length, BPM, key…) for folders with pictures, videos or music
  const hasMedia = (!isVirtual(t.path) || /^atlas:(search|tag)/.test(t.path)) && (t.items || []).some((i) => MM.isPic(i) || MM.isVid(i) || MM.isAud(i));
  if (hasMedia || MM.mediaFilterActive(t)) {
    const on = MM.mediaFilterActive(t);
    const fb = h('button', { class: 'chip mf-btn' + (on ? ' on' : ''), title: 'Filter pictures, videos and music by colour, kind, length, BPM or key', html: icon('filter') + `<span>${on ? 'Filtered' : 'Media filter'}</span>` });
    fb.addEventListener('click', (e) => { e.stopPropagation(); import('./gallery.js').then((g) => g.mediaFilterPanel(t, fb)); });
    el.tools.append(fb);
    if (on) el.tools.append(h('button', { class: 'chip mf-clear', title: 'Clear the media filter', onclick: () => { t.mf = null; recompute(t); renderTabPanes(t); } }, '×'));
  }
  if (t.view === 'grid' || t.view === 'gallery') {
    const slider = h('input', { type: 'range', class: 'size-slider', min: '72', max: t.view === 'gallery' ? '420' : '320', step: '8', value: String(t.gridSize || state.settings.gridSize), title: 'Thumbnail size (Ctrl+wheel)' });
    slider.addEventListener('input', () => { t.gridSize = +slider.value; touchView(t); renderView(el.idx); });
    el.tools.append(slider);
  }
  const vb = (v, ic, title) => {
    const b = h('button', { class: 'view-btn' + (t.view === v ? ' on' : ''), title, html: icon(ic) });
    b.addEventListener('click', () => { focusPane(el.idx); setView(t, v); });
    return b;
  };
  el.tools.append(vb('details', 'viewList', 'Details (Ctrl+Shift+6)'), vb('columns', 'viewColumns', 'Columns (Ctrl+Shift+7)'), vb('grid', 'viewGrid', 'Grid (Ctrl+Shift+2)'), vb('gallery', 'gallery', 'Gallery: pictures and videos in their real shape (Ctrl+Shift+8)'));
  const more = h('button', { class: 'view-btn', title: 'More view options', html: icon('more') });
  more.addEventListener('click', (e) => viewMenu(t, e.currentTarget.getBoundingClientRect()));
  el.tools.append(more);
}

export function setView(t, v) {
  t.view = v; touchView(t);
  recompute(t);
  renderTabPanes(t);
}

export function sortMenu(t, r) {
  const opt = (key, label) => ({ label, radio: true, selected: t.sort.key === key, run: () => { t.sort = { key, dir: t.sort.key === key ? -t.sort.dir : key === 'mtime' || key === 'size' || key === 'ctime' ? -1 : 1 }; touchView(t); recompute(t); renderTabPanes(t); } });
  const grp = (key, label) => ({ label, radio: true, selected: t.group === key, run: () => { t.group = key; touchView(t); recompute(t); renderTabPanes(t); } });
  showMenu([
    { header: 'Sort by' }, opt('name', 'Name'), opt('mtime', 'Date modified'), opt('ctime', 'Date created'), opt('size', 'Size'), opt('type', 'Type'), opt('ext', 'Extension'), opt('tags', 'Tags'),
    t.path?.startsWith('atlas:search') || t.path?.startsWith('atlas:tag') || t.path === 'atlas:recent' ? opt('location', 'Location') : null,
    t.path === 'atlas:recycle' ? opt('deleted', 'Date deleted') : null,
    ...((t.items || []).some((i) => MM.isPic(i) || MM.isVid(i)) ? [{ separator: true }, opt('taken', 'Date taken'), opt('camera', 'Camera'), opt('dims', 'Dimensions'), opt('color', 'Colour')] : []),
    ...((t.items || []).some((i) => MM.isVid(i) || MM.isAud(i)) ? [opt('duration', 'Length')] : []),
    ...((t.items || []).some((i) => MM.isAud(i)) ? [opt('bpm', 'BPM'), opt('key', 'Key (Camelot)')] : []),
    { separator: true },
    { label: 'Ascending', radio: true, selected: t.sort.dir > 0, run: () => { t.sort.dir = 1; touchView(t); recompute(t); renderTabPanes(t); } },
    { label: 'Descending', radio: true, selected: t.sort.dir < 0, run: () => { t.sort.dir = -1; touchView(t); recompute(t); renderTabPanes(t); } },
    { label: 'Folders first', checked: state.settings.foldersFirst, run: () => { state.settings.foldersFirst = !state.settings.foldersFirst; saveSettings(); state.tabs.forEach(recompute); renderAll(); } },
    { separator: true },
    { label: 'Group by', icon: 'group', submenu: [grp(null, 'None'), grp('type', 'Type'), grp('kind', 'Kind'), grp('date', 'Date modified'), grp('size', 'Size'), grp('name', 'Name (A–Z)'), grp('tag', 'Tag'), grp('location', 'Location'),
      ...((t.items || []).some((i) => MM.isPic(i) || MM.isVid(i)) ? [{ separator: true }, grp('gallery', 'Screenshots / photos / artwork'), grp('takenMonth', 'Month taken'), grp('camera', 'Camera'), grp('color', 'Colour')] : [])] },
  ], r.left, r.bottom + 4);
}

export function viewMenu(t, r) {
  const v = (id, label, ic, keys) => ({ label, icon: ic, keys, radio: false, checked: t.view === id, run: () => setView(t, id) });
  const sz = (n, label) => ({ label, checked: t.view === 'grid' && (t.gridSize || state.settings.gridSize) === n, run: () => { t.view = 'grid'; t.gridSize = n; touchView(t); renderTabPanes(t); } });
  const tog = (k, label) => ({ label, checked: !!state.settings[k], run: () => { state.settings[k] = !state.settings[k]; saveSettings(); state.tabs.forEach(recompute); renderAll(); bus.emit('settings'); } });
  showMenu([
    v('grid', 'Grid', 'viewGrid', 'Ctrl+Shift+2'), v('gallery', 'Gallery', 'gallery', 'Ctrl+Shift+8'), v('list', 'List', 'viewDetails', 'Ctrl+Shift+5'), v('details', 'Details', 'viewList', 'Ctrl+Shift+6'), v('columns', 'Columns', 'viewColumns', 'Ctrl+Shift+7'),
    { separator: true },
    { label: 'Thumbnail size', submenu: [sz(96, 'Small'), sz(128, 'Medium'), sz(160, 'Large'), sz(224, 'Extra large'), sz(300, 'Huge')] },
    { label: 'Grid labels', submenu: ['smart', 'always', 'hover'].map((k) => ({ label: { smart: 'Smart (hide on photos)', always: 'Always', hover: 'On hover only' }[k], radio: true, selected: state.settings.gridLabels === k, run: () => { state.settings.gridLabels = k; saveSettings(); renderAll(); } })) },
    { separator: true },
    tog('showHidden', 'Hidden items'), tog('showExtensions', 'File name extensions'), tog('showCheckboxes', 'Item check boxes'), tog('folderSizes', 'Calculate folder sizes'), tog('showThumbnails', 'Show thumbnails'),
    { separator: true },
    { label: 'Apply this view to all folders', run: () => { state.settings.defaultView = t.view; state.settings.gridSize = t.gridSize || state.settings.gridSize; state.folderViews = {}; saveSettings(); saveLibrary(); toast('Default view updated'); } },
    { label: 'Reset this folder’s view', run: () => { delete state.folderViews[viewKey(t.path)]; saveLibrary(); t.view = state.settings.defaultView; t.sort = { key: 'name', dir: 1 }; t.group = null; t.gridSize = null; recompute(t); renderTabPanes(t); } },
  ], r.right, r.bottom + 4, { alignRight: true });
}

// ======================================================================
// Views (virtualized)
// ======================================================================
const ROW_H = (t) => Math.round(({ compact: 26, touch: 44 }[document.documentElement.dataset.density] || 32) * (t?.rowZoom || 1));
const COLS = {
  name: { label: 'Name', w: 320, min: 140 },
  mtime: { label: 'Date modified', w: 170 },
  type: { label: 'Type', w: 150 },
  size: { label: 'Size', w: 100, align: 'right' },
  ctime: { label: 'Date created', w: 170 },
  ext: { label: 'Extension', w: 90 },
  location: { label: 'Location', w: 280 },
  tags: { label: 'Tags', w: 110 },
  git: { label: 'Git', w: 60 },
  deleted: { label: 'Date deleted', w: 170 },
  from: { label: 'Original location', w: 260 },
  attrs: { label: 'Attributes', w: 90 },
  duration: { label: 'Length', w: 80, align: 'right' },
  dims: { label: 'Dimensions', w: 110 },
  taken: { label: 'Date taken', w: 170 },
  camera: { label: 'Camera', w: 150 },
  bpm: { label: 'BPM', w: 64, align: 'right' },
  key: { label: 'Key', w: 90 },
};
const MEDIA_COLS = ['duration', 'dims', 'taken', 'camera', 'bpm', 'key'];
export function columnsFor(t) {
  if (t.path === 'atlas:recycle') return ['name', 'from', 'deleted', 'size', 'type'];
  const base = state.settings.visibleColumns || ['name', 'mtime', 'type', 'size', 'tags'];
  let cols = [...base];
  if ((t.path?.startsWith('atlas:search') || t.path?.startsWith('atlas:tag') || t.path === 'atlas:recent') && !cols.includes('location')) cols.splice(1, 0, 'location');
  if (t.git && state.settings.gitBadges && !cols.includes('git')) cols.push('git');
  // media folders get their own columns automatically (Settings > View > "Media columns in music, video and photo folders")
  if (state.settings.mediaColumns !== false && t.items?.length) {
    // what kind of folder this is, worked out once per listing (this runs for every row that is drawn)
    let mk = t._mediaKind;
    if (!mk || mk.items !== t.items || mk.n !== t.items.length) {
      let files = 0, a = 0, v = 0, p = 0;
      for (const i of t.items) { if (i.isDir) continue; files++; if (MM.isAud(i)) a++; else if (MM.isVid(i)) v++; else if (MM.isPic(i)) p++; }
      const kind = !files ? '' : a / files > 0.5 ? 'aud' : v / files > 0.5 ? 'vid' : p / files > 0.6 ? 'pic' : '';
      mk = t._mediaKind = { items: t.items, n: t.items.length, kind };
    }
    const add = (c) => { if (!cols.includes(c)) cols.splice(Math.max(1, cols.indexOf('size') + 1 || cols.length), 0, c); };
    if (mk.kind === 'aud') ['key', 'bpm', 'duration'].forEach(add);
    else if (mk.kind === 'vid') ['dims', 'duration'].forEach(add);
    else if (mk.kind === 'pic') ['dims', 'taken'].forEach(add);
  }
  return cols;
}
function colWidth(c) { return (state.settings.columnWidths && state.settings.columnWidths[c]) || COLS[c].w; }

function layoutFor(t, el) {
  const width = el.scroller.clientWidth;
  const rows = []; // {y, h, type:'header'|'items', label, items:[indices]}
  let y = 0;
  const pad = t.view === 'grid' ? (width < 420 ? 6 : width < 700 ? 14 : 30) : t.view === 'gallery' ? (width < 420 ? 4 : 12) : 0;
  let cellW = 0, cellH = 0, cols = 1, S = 0;
  if (t.view === 'grid') {
    // thumbnails shrink to fit a narrow pane instead of being cut off
    S = Math.max(40, Math.min(t.gridSize || state.settings.gridSize, width - pad * 2 - 22));
    cellW = S + 20; cellH = S + 20 + (S >= 90 ? 40 : 34) + (t.shown.some((i) => i.drive || i.subtitle || (state.settings.folderSizes && i.isDir && !i.virtual)) ? 18 : 0);
    cols = Math.max(1, Math.floor((width - pad * 2 + 2) / cellW));
    y = 14;
  } else if (t.view === 'gallery') {
    // justified rows: every picture keeps its shape, rows fill the width (like a photo library)
    S = Math.max(70, Math.min(Math.round((t.gridSize || state.settings.gridSize) * 1.15), Math.max(70, width - pad * 2)));
    y = 10;
  } else if (t.view === 'list') {
    cellW = Math.max(120, Math.min(260, width - 24)); cellH = 30; cols = Math.max(1, Math.floor((width - 24) / cellW)); y = 6;
  } else { cellH = ROW_H(t); cols = 1; y = t.view === 'details' ? 34 : 0; }
  const GAP = width < 500 ? 4 : 6;
  const push = t.view === 'gallery' ? (idxs) => {
    const avail = Math.max(60, width - pad * 2);
    let row = [], asp = [], sum = 0;
    const flush = (last) => {
      if (!row.length) return;
      const gaps = GAP * (row.length - 1);
      let hh = (avail - gaps) / sum;
      if (last) hh = Math.min(hh, S);
      hh = Math.max(40, Math.min(hh, S * 1.7));
      const xs = [], ws = [];
      let x = pad;
      row.forEach((ix, k) => { const w = !last && k === row.length - 1 ? pad + avail - x : Math.max(24, Math.round(asp[k] * hh)); xs.push(x); ws.push(w); x += w + GAP; });
      rows.push({ y, h: Math.round(hh), type: 'items', items: row, xs, ws });
      y += Math.round(hh) + GAP;
      row = []; asp = []; sum = 0;
    };
    for (const ix of idxs) {
      const it = t.shown[ix];
      const a = it.isDir ? 1 : MM.aspectOf(it);
      row.push(ix); asp.push(a); sum += a;
      if (sum * S + GAP * (row.length - 1) >= avail) flush(false);
    }
    flush(true);
  } : (idxs) => {
    for (let k = 0; k < idxs.length; k += cols) { rows.push({ y, h: cellH, type: 'items', items: idxs.slice(k, k + cols) }); y += cellH; }
  };
  if (t.groups && t.view !== 'columns') {
    let idx = 0;
    for (const g of t.groups) {
      rows.push({ y, h: 40, type: 'header', label: g.label, count: g.items.length, collapsed: g.collapsed });
      y += 40;
      if (g.collapsed) continue;
      const idxs = []; for (let k = 0; k < g.items.length; k++) idxs.push(idx++);
      push(idxs);
      y += t.view === 'grid' || t.view === 'gallery' ? 6 : 4;
    }
  } else {
    const idxs = t.shown.map((_, i) => i);
    push(idxs);
  }
  const pos = new Map();
  rows.forEach((r, ri) => { if (r.type === 'items') r.items.forEach((ix, c) => pos.set(ix, { ri, c })); });
  return { rows, total: y + 40, cellW, cellH, cols, pad, pos, width, S };
}

export function renderView(i) {
  const el = paneEls[i];
  const t = paneTab(i);
  if (!el || !t || t.app) return;
  el.root.dataset.view = t.view;
  // Ctrl+wheel in Details / List makes rows bigger or smaller instead of switching view
  if (t.rowZoom && t.rowZoom !== 1) { el.root.style.setProperty('--row-h', ROW_H(t) + 'px'); el.root.style.setProperty('--fs', String((state.settings.fontScale || 1) * t.rowZoom)); }
  else { el.root.style.removeProperty('--row-h'); el.root.style.removeProperty('--fs'); }
  if (t.view === 'columns' && t.path && !isVirtual(t.path)) return renderColumns(el, t);
  el.scroller.classList.remove('miller');
  if (t.error === 'netdown') {
    el.inner.style.height = '100%';
    el.inner.innerHTML = `<div class="empty-state">${icon('network')}<div><b>This network location isn’t answering</b></div><div class="hint">${esc(t.path)}<br>The server may be off, asleep, or you may be on a different network.</div><div class="row-inline"><button class="btn" data-act="retry">Try again</button><button class="btn" data-act="reconnect">Reconnect…</button><button class="btn" data-act="net">Network</button></div></div>`;
    el.inner.querySelector('[data-act=retry]').onclick = () => loadTab(t);
    el.inner.querySelector('[data-act=net]').onclick = () => navigate(t, 'atlas:network');
    el.inner.querySelector('[data-act=reconnect]').onclick = () => import('./network.js').then((m) => m.reconnect(t.path).then((ok) => ok && loadTab(t)));
    return;
  }
  if (t.error) { el.inner.style.height = '100%'; el.inner.innerHTML = `<div class="empty-state">${icon('info')}<div>${esc(t.error)}</div>${t.error === 'Access denied' && IS_WIN() ? '<button class="btn" data-act="admin">Open in Windows Explorer</button>' : ''}</div>`; el.inner.querySelector('[data-act]')?.addEventListener('click', () => api('shell:showInExplorer', t.path)); return; }
  const L = layoutFor(t, el);
  el.layout = L;
  el.inner.style.height = L.total + 'px';
  if (t.view === 'details') renderDetailsHeader(el, t); else { el.scroller.querySelector('.details-head')?.remove(); el.inner.style.minWidth = ''; }
  if (!t.shown.length && !t.loading) {
    const msg = t.filter ? 'No items match your filter.' : t.path?.startsWith('atlas:search') ? (t.searchInfo?.running ? 'Searching…' : 'No results.') : t.path === 'atlas:recycle' ? 'Recycle Bin is empty.' : 'This folder is empty.';
    el.inner.innerHTML = `<div class="empty-state">${icon(t.path === 'atlas:recycle' ? 'recycle' : 'folderOpen')}<div>${msg}</div></div>`;
    el.inner.style.height = '100%';
    el._cells = null;
    return;
  }
  if (t._scrollToFocus && t.focus != null) { t._scrollToFocus = false; scrollToItem(el, t, t.indexOf.get(t.focus), true); }
  else if (t._restoreScroll !== false && el.scroller.scrollTop !== t.scroll && !el._userScrolled) el.scroller.scrollTop = t.scroll;
  paintRows(el, t);
}

function paintRows(el, t) {
  const L = el.layout;
  if (!L) return;
  const top = el.scroller.scrollTop - 400, bottom = el.scroller.scrollTop + el.scroller.clientHeight + 400;
  // binary search first row
  let lo = 0, hi = L.rows.length - 1, first = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L.rows[m].y + L.rows[m].h < top) lo = m + 1; else { first = m; hi = m - 1; } }
  // Keyed recycling: cells that are still visible keep their DOM node (and their loaded thumbnail), so fast
  // scrolling never re-creates images. Only cells that scrolled into view are built.
  const prev = el._cells || new Map();
  const next = new Map();
  const fresh = [];
  const put = (key, html) => {
    const old = prev.get(key);
    // the thumbnail part is ignored when comparing, so a tile whose image finished loading is kept as-is
    const sig = html.replace(/<!--T-->[\s\S]*?<!--\/T-->/, '');
    if (old && old.sig === sig && old.node.parentNode === el.inner) { next.set(key, old); prev.delete(key); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild;
    next.set(key, { node, sig });
    fresh.push(node);
  };
  for (let r = first; r < L.rows.length; r++) {
    const row = L.rows[r];
    if (row.y > bottom) break;
    if (row.type === 'header') {
      put('g|' + row.label + '|' + row.y, `<div class="group-head${row.collapsed ? ' collapsed' : ''}" data-group="${esc(row.label)}" style="top:${row.y}px">${icon('chevronDown')}<span>${esc(row.label || '-')}</span><span class="gcount">${row.count}</span><div class="gline"></div></div>`);
      continue;
    }
    row.items.forEach((ix, c) => {
      const it = t.shown[ix];
      if (!it) return;
      put('c|' + it.path, t.view === 'gallery' ? galleryCell(t, it, ix, row.y, row.xs[c], row.ws[c], row.h) : t.view === 'grid' ? gridCell(t, it, ix, row.y, L.pad + c * L.cellW, L) : t.view === 'list' ? listCell(t, it, ix, row.y, 12 + c * L.cellW, L) : detailsRow(t, it, ix, row.y));
    });
  }
  // drop anything that isn't a recycled cell (empty states, stale nodes)
  for (const v of prev.values()) v.node.remove();
  const keep = new Set([...next.values()].map((v) => v.node));
  for (const n of [...el.inner.children]) if (!keep.has(n)) n.remove();
  for (const n of fresh) el.inner.appendChild(n);
  el._cells = next;
  if (fresh.length) hydrateImages(el, t, fresh);
}

function itemClasses(t, it) {
  let c = '';
  if (t.sel.has(it.path)) c += ' selected';
  if (t.focus === it.path) c += ' focused';
  if (it.hidden) c += ' hidden-item';
  if (it.cloud) c += ' cloud-item';
  if (state.clipboard?.cut && state.clipboard.paths.includes(it.path)) c += ' cut';
  return c;
}

// ---- color-coding rules ----
let rulesKey = '', compiled = [];
function ruleColor(it) {
  const rules = state.settings.highlightRules || [];
  const key = JSON.stringify(rules);
  if (key !== rulesKey) {
    rulesKey = key;
    compiled = rules.filter((r) => r.on !== false && r.color).map((r) => {
      if (r.type === 'pattern') { const parts = (r.pattern || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean).map((x) => new RegExp('^' + x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')); return { c: r.color, t: (i) => parts.some((re) => re.test(i.name)) }; }
      if (r.type === 'recent') return { c: r.color, t: (i) => i.mtime && Date.now() - i.mtime < (r.minutes || 10) * 60000 };
      if (r.type === 'size') return { c: r.color, t: (i) => (i.size || 0) > (r.mb || 500) * 1048576 };
      if (r.type === 'hidden') return { c: r.color, t: (i) => !!i.hidden };
      return { c: null, t: () => false };
    });
  }
  if (it.virtual || it.drive) return null;
  for (const r of compiled) if (r.t(it)) return r.c;
  return null;
}
const nameStyle = (it) => { const c = ruleColor(it); return c ? ` style="color:${c}"` : ''; };

function displayName(it) {
  if (it.isDir || state.settings.showExtensions || !it.ext || it.virtual) return it.name;
  const i = it.name.lastIndexOf('.');
  return i > 0 ? it.name.slice(0, i) : it.name;
}

function tagDots(it) {
  const tg = tagsOf(it.path);
  if (!tg.length) return '';
  return `<span class="tdots">${tg.map((id) => { const d = state.tags.defs.find((x) => x.id === id); return d ? `<i style="background:${d.color}" title="${esc(d.name)}"></i>` : ''; }).join('')}</span>`;
}

function gitBadge(t, it) {
  if (!t.git || !state.settings.gitBadges) return '';
  const code = t.git.files?.[it.path] || (it.isDir ? t.git.dirs?.get(it.path) : null);
  if (!code) return '';
  const c = code.includes('?') ? 'U' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : 'M';
  return `<span class="git-badge g${c}" title="Git: ${esc(code)}">${c}</span>`;
}

function smallIcon(it) {
  if (it.drive) return icon(it.drive.type === 'portable' ? 'phone' : it.drive.type === 'removable' ? 'usb' : it.drive.type === 'network' ? 'network' : it.drive.type === 'optical' ? 'disc' : 'drive');
  if (it.icon) return icon(it.icon);
  if (it.isDir) return `<span class="fico folder">${icon('folder')}</span>`;
  if (state.settings.useWindowsIcons && IS_WIN()) return `<img class="wicon" data-icon="${esc(it.path)}" alt="">`;
  const k = kindOf(it);
  const map = { image: 'photos', video: 'videos', audio: 'music', archive: 'zip', code: 'code', executable: 'terminal', document: 'page', font: 'page', model: 'cube' };
  return `<span class="fico k-${k}">${icon(map[k] || 'page')}</span>`;
}

function wantsThumb(it) {
  if (!state.settings.showThumbnails || it.isDir || it.archive || it.recycle) return false;
  const k = kindOf(it);
  if (k === 'image') return true;
  if (IS_WIN() && (k === 'video' || it.ext === 'pdf' || ['docx', 'xlsx', 'pptx', 'psd', 'ai', 'mp3', 'flac', 'm4a', 'exe', 'lnk', 'ico', 'svg', 'heic', 'stl', '3mf', 'blend'].includes(it.ext))) return true;
  return false;
}

function gridCell(t, it, ix, y, x, L) {
  const S = L.S || t.gridSize || state.settings.gridSize;
  const thumb = wantsThumb(it);
  const labels = state.settings.gridLabels;
  const isPhoto = thumb && kindOf(it) === 'image';
  const labelCls = labels === 'hover' || (labels === 'smart' && isPhoto) ? ' label-hover' : '';
  let art;
  if (it.drive) art = driveArt(it.drive, S);
  else if (it.isDir) art = it.icon && !it.path.startsWith('atlas:') ? folderArt() : it.icon ? `<div class="virt-art">${icon(it.icon)}</div>` : folderArt(it.color);
  else if (thumb && thumbCache.get(it.path + '|' + (it.mtime || 0))) art = `<img class="thumb-img" src="${thumbCache.get(it.path + '|' + (it.mtime || 0))}" alt="" draggable="false" decoding="sync">`;
  else if (thumb && thumbCache.get(it.path + '|' + (it.mtime || 0)) === null) art = fileArt(it.ext);
  else if (thumb) art = `<img class="thumb-img pending" data-thumb="${esc(it.path)}" data-m="${it.mtime || 0}" alt="" draggable="false">${state.settings.useWindowsIcons ? '' : `<div class="thumb-fallback">${fileArt(it.ext)}</div>`}`;
  else if (KINDS.font.includes(it.ext) && it.ext !== 'fon' && !it.archive && !it.mtp) art = `<div class="font-art" data-font="${esc(it.path)}"><b>Aa</b><span>${esc(it.ext.toUpperCase())}</span></div>`;
  else if (state.settings.useWindowsIcons && IS_WIN() && !it.archive) art = `<img class="wicon big" data-icon="${esc(it.path)}" alt="">`;
  else art = fileArt(it.ext);
  const sub = state.settings.folderSizes && it.isDir && !it.virtual && !it.drive ? `<div class="sub size-badge">${it.size != null ? fmtSize(it.size) : '…'}</div>` : it.drive ? `<div class="sub">${it.drive.type === 'portable' ? esc(it.drive.devType || 'Portable device') : `${fmtSize(it.drive.free)} free of ${fmtSize(it.drive.total)}`}</div>` : it.subtitle ? `<div class="sub">${esc(it.subtitle)}</div>` : '';
  return `<div class="cell grid-cell${itemClasses(t, it)}${labelCls}" data-ix="${ix}" role="option" aria-selected="${t.sel.has(it.path)}" draggable="true" style="transform:translate(${x}px,${y}px);width:${L.cellW}px;height:${L.cellH}px">
    <div class="tile" style="width:${S}px;height:${S}px"><!--T-->${art}<!--/T-->${state.settings.showCheckboxes ? `<span class="cbox">${icon('check')}</span>` : ''}${gitBadge(t, it)}${it.isLink ? `<span class="link-badge">${icon('link')}</span>` : ''}</div>
    <div class="label" title="${esc(it.name)}">${tagDots(it)}<span${nameStyle(it)}>${esc(displayName(it))}</span></div>${sub}</div>`;
}

function galleryCell(t, it, ix, y, x, w, hh) {
  const vid = MM.isVid(it), pic = MM.isPic(it);
  const m = MM.metaOf(it) || {};
  let art;
  if (it.isDir) art = `<div class="gal-folder">${folderArt(it.color)}</div>`;
  else if (pic || vid) {
    const k = it.path + '|' + (it.mtime || 0) + '|g';
    const u = thumbCache.get(k);
    art = u ? `<img class="gal-img" src="${u}" alt="" draggable="false" crossorigin="anonymous" data-gal="${esc(it.path)}">` : `<img class="gal-img pending" data-thumb="${esc(it.path)}" data-m="${it.mtime || 0}" data-gal="${esc(it.path)}" data-tw="${Math.min(1024, Math.round(Math.max(w, hh) * (window.devicePixelRatio || 1)))}" alt="" draggable="false" crossorigin="anonymous">`;
  } else if (MM.isAud(it)) art = `<div class="gal-wave"><img src="/media/wave?p=${encodeURIComponent(it.path)}&w=${Math.min(1200, Math.round(w * (window.devicePixelRatio || 1)))}&h=${Math.round(hh * 0.6 * (window.devicePixelRatio || 1))}&c=${(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().replace('#', '') || '3b82f6').slice(0, 6)}" alt="" draggable="false" onerror="this.remove()"></div>`;
  else art = `<div class="gal-file">${fileArt(it.ext)}</div>`;
  const cap = it.isDir || !(pic || vid) || state.settings.galleryNames;
  return `<div class="cell gal-cell${itemClasses(t, it)}${cap ? ' cap' : ''}${vid ? ' vid' : ''}" data-ix="${ix}" role="option" aria-selected="${t.sel.has(it.path)}" draggable="true" style="transform:translate(${x}px,${y}px);width:${w}px;height:${hh}px">
    <!--T-->${art}<!--/T-->${vid ? `<span class="gal-dur">${m.dur ? MM.fmtDur(m.dur) : icon('pplay')}</span><span class="gal-scrub"><i></i></span>` : MM.isAud(it) && m.dur ? `<span class="gal-dur">${MM.fmtDur(m.dur)}${m.bpm ? ` · ${Math.round(m.bpm)} BPM` : ''}${m.camelot ? ` · ${m.camelot}` : ''}</span>` : ''}
    <div class="gal-cap"><span${nameStyle(it)}>${esc(displayName(it))}</span></div>${state.settings.showCheckboxes ? `<span class="cbox">${icon('check')}</span>` : ''}${tagDots(it) ? `<span class="gal-tags">${tagDots(it)}</span>` : ''}</div>`;
}

function driveArt(d, S) {
  const pct = d.total ? (1 - d.free / d.total) * 100 : 0;
  if (d.type === 'portable') return `<div class="drive-art"><div class="drive-ic">${icon('phone')}</div></div>`;
  return `<div class="drive-art"><div class="drive-ic">${icon(d.type === 'removable' ? 'usb' : d.type === 'network' ? 'network' : d.type === 'optical' ? 'disc' : 'drive')}</div><div class="usage"><i style="width:${pct.toFixed(1)}%" class="${pct > 90 ? 'crit' : ''}"></i></div></div>`;
}

function listCell(t, it, ix, y, x, L) {
  return `<div class="cell list-cell${itemClasses(t, it)}" data-ix="${ix}" role="option" aria-selected="${t.sel.has(it.path)}" draggable="true" style="transform:translate(${x}px,${y}px);width:${L.cellW - 8}px;height:${L.cellH}px">${state.settings.showCheckboxes ? `<span class="cbox">${icon('check')}</span>` : ''}${smallIcon(it)}<span class="nm" title="${esc(it.name)}"${nameStyle(it)}>${esc(displayName(it))}</span>${state.settings.folderSizes && it.isDir && it.size != null ? `<span class="lsize">${fmtSize(it.size)}</span>` : ''}${tagDots(it)}${gitBadge(t, it)}</div>`;
}

function detailsRow(t, it, ix, y) {
  const cols = columnsFor(t);
  const cells = cols.map((c) => {
    let v = '';
    if (c === 'name') return `<div class="dc c-name" style="width:${colWidth(c)}px">${state.settings.showCheckboxes ? `<span class="cbox">${icon('check')}</span>` : ''}${smallIcon(it)}<span class="nm" title="${esc(it.name)}"${nameStyle(it)}>${esc(displayName(it))}</span>${it.isLink ? `<span class="link-badge small">${icon('link')}</span>` : ''}</div>`;
    if (c === 'mtime') v = fmtDate(it.mtime);
    else if (c === 'ctime') v = fmtDate(it.ctime);
    else if (c === 'type') v = it.drive ? 'Drive' : it.typeLabel || typeLabel(it);
    else if (c === 'size') v = it.drive ? `${fmtSize(it.drive.free)} free` : it.isDir ? (it.size != null ? fmtSize(it.size) : '') : fmtSize(it.size);
    else if (c === 'ext') v = it.ext;
    else if (c === 'location') v = it.archive ? '' : dirname(it.path) || '';
    else if (c === 'tags') return `<div class="dc c-tags" style="width:${colWidth(c)}px">${tagDots(it)}</div>`;
    else if (c === 'git') return `<div class="dc c-git" style="width:${colWidth(c)}px">${gitBadge(t, it)}</div>`;
    else if (c === 'deleted') v = it.recycle ? fmtDate(it.recycle.deleted) : '';
    else if (c === 'from') v = it.recycle?.from || '';
    else if (MEDIA_COLS.includes(c)) { const m = MM.metaOf(it) || {}; v = c === 'duration' ? MM.fmtDur(m.dur) : c === 'dims' ? (m.w ? `${m.w} × ${m.h}` : '') : c === 'taken' ? (m.taken ? fmtDate(m.taken) : '') : c === 'camera' ? m.camera || '' : c === 'bpm' ? (m.bpm ? String(Math.round(m.bpm)) : '') : m.camelot ? `${m.camelot} · ${m.key || ''}` : ''; }
    else if (c === 'attrs') v = (it.readonly ? 'R' : '') + (it.hidden ? 'H' : '') + (it.system ? 'S' : '') + (it.isLink ? 'L' : '');
    if (c === 'size' && state.settings.sizeBars && t._maxSize > 0 && it.size > 0 && !it.drive) {
      const pct = Math.max(1.5, (it.size / t._maxSize) * 100);
      return `<div class="dc c-size right has-bar" style="width:${colWidth(c)}px" title="${esc(v)}"><i class="szbar" style="width:${pct.toFixed(1)}%"></i><span>${esc(v)}</span></div>`;
    }
    return `<div class="dc c-${c}${COLS[c].align === 'right' ? ' right' : ''}" style="width:${colWidth(c)}px" title="${esc(v)}">${esc(v)}</div>`;
  });
  return `<div class="cell drow${itemClasses(t, it)}" data-ix="${ix}" role="option" aria-selected="${t.sel.has(it.path)}" draggable="true" style="transform:translateY(${y}px)">${cells.join('')}</div>`;
}

function renderDetailsHeader(el, t) {
  let head = el.scroller.querySelector('.details-head');
  if (!head) { head = h('div', { class: 'details-head' }); el.scroller.prepend(head); }
  const cols = columnsFor(t);
  head.innerHTML = cols.map((c) => `<div class="hc c-${c}${COLS[c].align === 'right' ? ' right' : ''}" data-col="${c}" style="width:${colWidth(c)}px"><span>${COLS[c].label}</span>${t.sort.key === c ? icon(t.sort.dir > 0 ? 'caretUp' : 'caretDown', 'sort-ind') : ''}<i class="rz" data-rz="${c}" title="Drag to resize · double-click to fit"></i></div>`).join('') + `<button class="hc-cols" title="Choose columns (or right-click the column names)">${icon('viewColumns')}</button>`;
  head.querySelector('.hc-cols').onclick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); head.oncontextmenu({ preventDefault() {}, clientX: r.left, clientY: r.bottom + 2 }); };
  head.onclick = (e) => {
    const hc = e.target.closest('.hc');
    if (!hc || e.target.classList.contains('rz')) return;
    const k = hc.dataset.col;
    if (['tags', 'git', 'attrs', 'from'].includes(k) && k !== 'tags') return;
    const key = k === 'deleted' ? 'deleted' : k;
    t.sort = { key, dir: t.sort.key === key ? -t.sort.dir : 1 };
    touchView(t); recompute(t); renderView(el.idx); renderTools(el, t);
  };
  head.oncontextmenu = (e) => {
    e.preventDefault();
    const vis = state.settings.visibleColumns || ['name', 'mtime', 'type', 'size', 'tags'];
    showMenu(['mtime', 'ctime', 'type', 'size', 'ext', 'tags', 'attrs', 'location', ...MEDIA_COLS].map((c) => ({ label: COLS[c].label, checked: vis.includes(c), run: () => { const s = new Set(vis); s.has(c) ? s.delete(c) : s.add(c); state.settings.visibleColumns = ['name', ...['location', 'mtime', 'ctime', 'type', 'size', 'ext', 'attrs', 'tags', ...MEDIA_COLS].filter((x) => s.has(x))]; saveSettings(); renderAll(); } }))
      .concat([{ separator: true }, { label: 'Size columns to fit', run: () => { state.settings.columnWidths = null; saveSettings(); renderAll(); } }]), e.clientX, e.clientY);
  };
  head.onmousedown = (e) => {
    const rz = e.target.dataset?.rz;
    if (!rz) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = colWidth(rz);
    const move = (ev) => {
      state.settings.columnWidths = { ...(state.settings.columnWidths || {}), [rz]: Math.max(COLS[rz].min || 50, startW + ev.clientX - startX) };
      renderDetailsHeader(el, t); paintRows(el, t);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveSettings(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  head.ondblclick = (e) => {
    const rz = e.target.dataset?.rz; if (!rz) return;
    // auto-fit column to content
    const ctx = document.createElement('canvas').getContext('2d'); ctx.font = '13px Inter, Segoe UI';
    let w = 60;
    for (const it of t.shown.slice(0, 3000)) { const txt = rz === 'name' ? displayName(it) : rz === 'location' ? dirname(it.path) || '' : rz === 'type' ? typeLabel(it) : rz === 'size' ? fmtSize(it.size) : fmtDate(it[rz]); w = Math.max(w, ctx.measureText(txt || '').width + (rz === 'name' ? 60 : 30)); }
    state.settings.columnWidths = { ...(state.settings.columnWidths || {}), [rz]: Math.min(900, Math.ceil(w)) };
    saveSettings(); renderDetailsHeader(el, t); paintRows(el, t);
  };
  head.style.minWidth = cols.reduce((a, c) => a + colWidth(c), 0) + 'px';
  el.inner.style.minWidth = head.style.minWidth;
}

// Thumbnails & Windows icons (lazy, cached)
// gallery thumbnails: bigger, and each one teaches the gallery its real shape and colours
const relayoutSoon = new Map();
function hydrateGal(el, t, img) {
  const p = img.dataset.gal;
  const it = t.shown[t.indexOf.get(p)];
  const onload = () => {
    img.classList.remove('pending');
    if (!it) return;
    if (img.naturalWidth && !MM.metaOf(it)?.w) {
      const a = img.naturalWidth / img.naturalHeight;
      if (!it._aspect || Math.abs(it._aspect - a) > 0.05) {
        it._aspect = a;
        clearTimeout(relayoutSoon.get(el));
        relayoutSoon.set(el, setTimeout(() => { if (paneTab(el.idx) === t && t.view === 'gallery') renderView(el.idx); }, 250));
      }
    }
    const m = MM.metaOf(it);
    if (!m?.hash || !m?.colors) MM.analyzeImage(img, it);
  };
  if (!img.dataset.thumb) { if (img.complete) onload(); else img.onload = onload; return; }
  const key = p + '|' + img.dataset.m + '|g';
  const show = (u) => { img.onload = onload; img.onerror = () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'gal-file', innerHTML: fileArt(extname(p)) })); }; img.src = u; };
  const cached = thumbCache.get(key);
  if (cached) return show(cached);
  (async () => {
    let url = null;
    const tw = +img.dataset.tw || 400;
    if (it && DECODED_IMG.has(it.ext)) url = decodedUrl(p, Math.min(1024, tw));
    else if (IS_WIN()) url = await api('thumb:get', p, Math.min(1024, tw)).catch(() => null);
    if (!url) url = it && MM.isPic(it) && !['heic', 'psd', 'raw', 'cr2', 'nef', 'dng', 'tif', 'tiff', 'arw', 'cr3'].includes(it.ext) ? fileUrl(p) : `/media/thumb?p=${encodeURIComponent(p)}&w=${Math.min(1024, tw)}`;
    thumbCache.set(key, url);
    if (img.isConnected) show(url);
  })();
}

function hydrateImages(el, t, nodes) {
  const q = (sel) => (nodes ? nodes.flatMap((n) => [...n.querySelectorAll(sel)]) : [...el.inner.querySelectorAll(sel)]);
  q('img[data-gal]').forEach((img) => hydrateGal(el, t, img));
  q('img[data-thumb]:not([data-gal])').forEach(async (img) => {
    const p = img.dataset.thumb;
    const key = p + '|' + img.dataset.m;
    let url = thumbCache.get(key);
    const show = (u) => {
      img.onload = () => { img.classList.remove('pending'); img.nextElementSibling?.classList?.contains('thumb-fallback') && img.nextElementSibling.remove(); };
      img.onerror = () => { img.remove(); };
      img.src = u;
    };
    if (url) return show(url);
    if (url === null) { img.remove(); return; }
    const it = t.shown[t.indexOf.get(p)];
    if (it && DECODED_IMG.has(it.ext)) url = decodedUrl(p, Math.min(512, Math.round((t.gridSize || state.settings.gridSize) * (window.devicePixelRatio || 1))));
    else if (IS_WIN()) {
      url = await api('thumb:get', p, Math.min(512, Math.round((t.gridSize || state.settings.gridSize) * (window.devicePixelRatio || 1))));
      if (!url && it && kindOf(it) === 'image' && !['heic', 'psd', 'raw', 'cr2', 'nef', 'dng', 'tif', 'tiff'].includes(it.ext)) url = fileUrl(p);
    } else url = it && kindOf(it) === 'image' && !['heic', 'psd', 'raw', 'cr2', 'nef', 'dng', 'tif', 'tiff'].includes(it.ext) ? fileUrl(p) : null;
    thumbCache.set(key, url);
    thumbBytes += url ? url.length : 0;
    // keep the cache to about 48 MB of thumbnails (oldest go first)
    while (thumbCache.size > 3000 || thumbBytes > 48 * 1048576) { const k = thumbCache.keys().next().value; thumbBytes -= thumbCache.get(k)?.length || 0; thumbCache.delete(k); }
    if (url && img.isConnected) show(url); else img.remove();
  });
  q('.font-art[data-font]').forEach(async (el2) => {
    const p = el2.dataset.font;
    let fam = fontCache.get(p);
    if (!fam) { fam = 'ff' + fontCache.size; fontCache.set(p, fam); try { const ff = new FontFace(fam, `url("${fileUrl(p)}")`); await ff.load(); document.fonts.add(ff); } catch { fontCache.set(p, 'x-none'); } }
    if (fontCache.get(p) !== 'x-none') el2.querySelector('b').style.fontFamily = `"${fam}"`;
  });
  q('img[data-icon]').forEach(async (img) => {
    const p = img.dataset.icon;
    const e = extname(p);
    const key = ['exe', 'lnk', 'ico', 'url', 'appref-ms', 'msc', 'cpl', 'scr'].includes(e) || !e ? p : '.' + e;
    let u = iconCache.get(key);
    if (u === undefined) { u = await api('icon:get', p, img.classList.contains('big') ? 'large' : 'normal'); iconCache.set(key, u); }
    if (u) img.src = u; else img.replaceWith(Object.assign(document.createElement('span'), { className: 'fico', innerHTML: icon('page') }));
  });
}
export function clearThumbCache(p) { for (const k of [...thumbCache.keys()]) if (!p || k.startsWith(p + "|")) { thumbBytes -= thumbCache.get(k)?.length || 0; thumbCache.delete(k); } if (!p) thumbBytes = 0; }

// ---------- Miller columns ----------
// Miller columns: every folder from the drive down to this one, side by side (as deep as it goes), then the
// current folder, then a preview of the focused file. Going deeper slides the new column in from the right;
// columns can be resized by dragging their right edge (double-click resets).
const millerCache = new Map(); // dir -> { items, at }
const millerW = new Map(); // dir -> width (px), for this session
async function millerList(dir) {
  const c = millerCache.get(dir);
  if (c && Date.now() - c.at < 8000) return c.items;
  const r = await api('fs:list', dir).catch(() => ({ items: [] }));
  const items = (r.items || []).filter(visibleFilter).sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : natCmp(a.name, b.name)));
  millerCache.set(dir, { items, at: Date.now() });
  if (millerCache.size > 200) millerCache.delete(millerCache.keys().next().value);
  return items;
}
async function renderColumns(el, t) {
  el.scroller.classList.add('miller');
  el.scroller.querySelector('.details-head')?.remove();
  el.inner.style.height = '100%';
  el.inner.style.minWidth = '';
  const cols = splitPath(t.path).map((c) => c.path).filter((p) => !isVirtual(p));
  const seq = (el._millerSeq = (el._millerSeq || 0) + 1);
  const data = await Promise.all(cols.slice(0, -1).map(async (dir) => ({ dir, items: await millerList(dir) })));
  if (el._millerSeq !== seq) return;
  const prev = el._millerChain || [];
  const deeper = prev.length && cols.length > prev.length && prev.every((p, i) => samePath(p, cols[i]));
  const prevScroll = el.inner.querySelector('.mrow')?.scrollLeft || 0;
  el._millerChain = cols;
  const w = (dir, d) => millerW.get(dir) || d;
  const grip = '<div class="mgrip" title="Drag to resize · double-click to reset"></div>';
  const html = [];
  data.forEach((col, k) => {
    const next = cols[k + 1];
    html.push(`<div class="mcol" data-dir="${esc(col.dir)}" style="width:${w(col.dir, 250)}px">${col.items.map((it) => `<div class="mitem${samePath(it.path, next) ? ' trail' : ''}${it.hidden ? ' hidden-item' : ''}" data-path="${esc(it.path)}" data-dir="${it.isDir ? 1 : 0}">${smallIcon(it)}<span class="nm">${esc(displayName(it))}</span>${it.isDir ? `<span class="chev">${icon('chevronRight')}</span>` : ''}</div>`).join('')}${grip}</div>`);
  });
  html.push(`<div class="mcol current${deeper && !document.body.classList.contains('reduce-motion') ? ' mslide' : ''}" data-dir="${esc(t.path)}" style="width:${w(t.path, 280)}px">${t.shown.map((it, ix) => `<div class="mitem cell${itemClasses(t, it)}" data-ix="${ix}" role="option" aria-selected="${t.sel.has(it.path)}" draggable="true" data-path="${esc(it.path)}">${smallIcon(it)}<span class="nm">${esc(displayName(it))}</span>${tagDots(it)}${gitBadge(t, it)}${it.isDir ? `<span class="chev">${icon('chevronRight')}</span>` : ''}</div>`).join('') || '<div class="hint pad">Empty folder</div>'}${grip}</div>`);
  const focusIt = t.focus && t.shown[t.indexOf.get(t.focus)];
  if (focusIt && !focusIt.isDir) html.push(`<div class="mcol mpreview" data-preview="${esc(focusIt.path)}"></div>`);
  el.inner.innerHTML = `<div class="mrow">${html.join('')}</div>`;
  el.inner.querySelectorAll('.mcol:not(.current) .mitem').forEach((m) => {
    m.addEventListener('click', () => { const p = m.dataset.path; if (m.dataset.dir === '1') navigate(t, p); else navigate(t, dirname(p), { select: p }); });
    m.addEventListener('contextmenu', (e) => { e.preventDefault(); A.folderContextMenu(m.dataset.path, e); });
  });
  // resizing a column by its right edge
  el.inner.querySelectorAll('.mgrip').forEach((g) => {
    const col = g.parentElement;
    g.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = col.offsetWidth;
      const move = (ev) => { const nw = Math.max(140, Math.min(700, w0 + ev.clientX - x0)); col.style.width = nw + 'px'; millerW.set(col.dataset.dir, nw); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('col-resizing'); };
      document.body.classList.add('col-resizing');
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); millerW.delete(col.dataset.dir); col.style.width = (col.classList.contains('current') ? 280 : 250) + 'px'; });
    g.addEventListener('click', (e) => e.stopPropagation());
  });
  const pv = el.inner.querySelector('.mpreview');
  if (pv) bus.emit('renderMiniPreview', { el: pv, item: focusIt });
  const row = el.inner.querySelector('.mrow');
  // keep the current folder (and its preview) in view: glide there from where the row was
  const end = row.scrollWidth - row.clientWidth;
  if (document.body.classList.contains('reduce-motion') || !prev.length) row.scrollLeft = end;
  else { row.scrollLeft = Math.min(prevScroll, end); requestAnimationFrame(() => row.scrollTo({ left: end, behavior: 'smooth' })); }
  el.inner.querySelector('.mcol.current .focused')?.scrollIntoView({ block: 'nearest' });
  hydrateImages(el, t);
}

// ======================================================================
// Selection
// ======================================================================
export function selectedItems(t = activeTab()) {
  if (!t) return [];
  return t.shown.filter((it) => t.sel.has(it.path));
}
export function selectOnly(t, p) { t.sel = new Set(p ? [p] : []); t.focus = p; t.anchor = p; }
function selectRange(t, from, to, add) {
  const a = t.indexOf.get(from) ?? 0, b = t.indexOf.get(to) ?? 0;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (!add) t.sel = new Set();
  for (let i = lo; i <= hi; i++) t.sel.add(t.shown[i].path);
  t.focus = to;
}
export function selectAll(t) { t.sel = new Set(t.shown.map((i) => i.path)); renderTabPanes(t, true); bus.emit('status'); }
export function selectNone(t) { t.sel = new Set(); renderTabPanes(t, true); bus.emit('status'); bus.emit('selection', t); }
export function invertSelection(t) { t.sel = new Set(t.shown.filter((i) => !t.sel.has(i.path)).map((i) => i.path)); renderTabPanes(t, true); bus.emit('status'); }

function scrollToItem(el, t, ix, center) {
  const L = el.layout || layoutFor(t, el);
  const pos = L.pos.get(ix);
  if (!pos) return;
  const row = L.rows[pos.ri];
  const headerH = t.view === 'details' ? 34 : 0;
  const top = el.scroller.scrollTop, hgt = el.scroller.clientHeight;
  if (center) el.scroller.scrollTop = Math.max(0, row.y - hgt / 2 + row.h / 2);
  else if (row.y - headerH < top) el.scroller.scrollTop = row.y - headerH - 4;
  else if (row.y + row.h > top + hgt) el.scroller.scrollTop = row.y + row.h - hgt + 4;
}

function moveFocus(el, t, key, shift, ctrl) {
  if (!t.shown.length) return;
  const L = el.layout || layoutFor(t, el);
  let ix = t.focus != null && t.indexOf.has(t.focus) ? t.indexOf.get(t.focus) : -1;
  const pos = L.pos.get(ix);
  const pageRows = Math.max(1, Math.floor(el.scroller.clientHeight / (L.cellH || 30)) - 1);
  const rowsIdx = L.rows.map((r, i) => i).filter((i) => L.rows[i].type === 'items');
  const rowAt = (ri, c) => { const r = L.rows[ri]; return r.items[Math.min(c, r.items.length - 1)]; };
  const gridLike = t.view === 'grid' || t.view === 'list' || t.view === 'gallery';
  if (t.view === 'gallery' && ix >= 0 && (key === 'ArrowDown' || key === 'ArrowUp')) {
    // rows have different numbers of pictures: go to the one right above / below
    const L = el.layout, p0 = L.pos.get(ix);
    const row = L.rows[p0.ri];
    const cx = row.xs[p0.c] + row.ws[p0.c] / 2;
    let ri = p0.ri;
    do { ri += key === 'ArrowDown' ? 1 : -1; } while (ri >= 0 && ri < L.rows.length && L.rows[ri].type !== 'items');
    if (ri >= 0 && ri < L.rows.length) {
      const r2 = L.rows[ri];
      let best = 0, bd = Infinity;
      r2.items.forEach((_, c) => { const d = Math.abs(r2.xs[c] + r2.ws[c] / 2 - cx); if (d < bd) { bd = d; best = c; } });
      ix = r2.items[best];
      const p = t.shown[ix].path;
      if (shift) selectRange(t, t.anchor ?? p, p, ctrl); else if (ctrl) t.focus = p; else selectOnly(t, p);
      scrollToItem(el, t, ix); paintRows(el, t); bus.emit('selection', t);
    }
    return;
  }
  if (ix < 0) ix = key === 'End' ? t.shown.length - 1 : 0;
  else if (key === 'ArrowRight' && gridLike) ix = Math.min(t.shown.length - 1, ix + 1);
  else if (key === 'ArrowLeft' && gridLike) ix = Math.max(0, ix - 1);
  else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp') {
    const step = key.startsWith('Page') ? pageRows : 1;
    const dir = key === 'ArrowDown' || key === 'PageDown' ? 1 : -1;
    if (!gridLike) ix = Math.max(0, Math.min(t.shown.length - 1, ix + dir * step));
    else {
      const k = rowsIdx.indexOf(pos.ri);
      const nk = Math.max(0, Math.min(rowsIdx.length - 1, k + dir * step));
      ix = rowAt(rowsIdx[nk], pos.c);
    }
  } else if (key === 'Home') ix = 0;
  else if (key === 'End') ix = t.shown.length - 1;
  else return;
  const p = t.shown[ix].path;
  if (shift) selectRange(t, t.anchor ?? p, p, ctrl);
  else if (ctrl) t.focus = p;
  else selectOnly(t, p);
  scrollToItem(el, t, ix);
  paintRows(el, t);
  bus.emit('selection', t);
}

// Type-ahead: jump to the next item starting with typed characters
let typeBuf = '', typeTimer = null;
function typeAhead(el, t, ch) {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => (typeBuf = ''), 900);
  typeBuf += ch.toLowerCase();
  if (state.settings.typeAhead === 'filter') { t.filter = typeBuf; recompute(t); renderPane(el.idx); return; }
  const start = t.focus ? (t.indexOf.get(t.focus) ?? -1) + (typeBuf.length === 1 ? 1 : 0) : 0;
  for (let k = 0; k < t.shown.length; k++) {
    const it = t.shown[(start + k) % t.shown.length];
    if (it.name.toLowerCase().startsWith(typeBuf)) { selectOnly(t, it.path); scrollToItem(el, t, t.indexOf.get(it.path)); paintRows(el, t); bus.emit('selection', t); return; }
  }
}

// ======================================================================
// Events per pane
// ======================================================================
let dragPaths = null;
export const currentDrag = () => dragPaths;

function itemFromEvent(el, e) {
  const cell = e.target.closest('.cell');
  if (!cell || !el.inner.contains(cell)) return null;
  // the gaps around a thumbnail count as empty space, so clicking them clears the selection
  if (state.settings.clickEmptyDeselects !== false) {
    if (cell.classList.contains('grid-cell') && !e.target.closest('.tile, .label, .sub, .cbox, .rename-box')) return null;
    // list view: the blank part of a cell after the name; details: the blank area right of the last column
    if (e.target === cell && (cell.classList.contains('list-cell') || cell.classList.contains('drow') || cell.classList.contains('details-row'))) return null;
  }
  const t = paneTab(el.idx);
  const ix = +cell.dataset.ix;
  return { t, ix, it: t.shown[ix], cell };
}

function wirePane(el) {
  const { body, scroller, inner } = el;
  body.addEventListener('mousedown', () => { if (state.activePane !== el.idx) focusPane(el.idx); }, true);
  // clicking the pane background outside the item area also clears the selection
  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || state.settings.clickEmptyDeselects === false) return;
    if (e.target === body || e.target === el.scroller || e.target === el.overlay) { const t = paneTab(el.idx); if (t?.sel?.size) selectNone(t); }
  });
  el.nav.addEventListener('mousedown', () => { if (state.activePane !== el.idx) focusPane(el.idx); }, true);
  el.tools.addEventListener('mousedown', () => { if (state.activePane !== el.idx) focusPane(el.idx); }, true);

  scroller.addEventListener('scroll', () => {
    const t = paneTab(el.idx);
    if (!t || t.view === 'columns') return;
    t.scroll = scroller.scrollTop;
    el._userScrolled = true;
    requestAnimationFrame(() => paintRows(el, t));
    clearTimeout(el._st); el._st = setTimeout(() => (el._userScrolled = false), 300);
  }, { passive: true });

  new ResizeObserver(debounce(() => { const t = paneTab(el.idx); if (t && t.view !== 'columns') renderView(el.idx); }, 30)).observe(scroller);

  // Ctrl+wheel resizes thumbnails
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const t = paneTab(el.idx);
    if (t.view === 'details' || t.view === 'list' || t.view === 'columns') t.rowZoom = Math.max(0.8, Math.min(1.8, Math.round(((t.rowZoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10));
    else t.gridSize = Math.max(72, Math.min(320, (t.gridSize || state.settings.gridSize) + (e.deltaY < 0 ? 16 : -16)));
    touchView(t);
    renderPane(el.idx);
  }, { passive: false });

  // hovering a folder shows its size in the tooltip (worked out in the background, then remembered for a minute)
  let hoverT = null;
  inner.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.cell');
    clearTimeout(hoverT);
    if (!cell || state.settings.hoverFolderSize === false) return;
    const t = paneTab(el.idx);
    const it = t?.shown[+cell.dataset.ix];
    if (it && !it.isDir && !it.virtual) {
      // files: size, type and date right away
      const tip = `${it.name}\nSize: ${fmtSize(it.size)}${it.size >= 1024 ? ` (${(it.size || 0).toLocaleString()} bytes)` : ''}\nType: ${typeLabel(it)}${it.mtime ? `\nModified: ${fmtDate(it.mtime, 'locale')}` : ''}`;
      cell.title = tip; cell.querySelectorAll('[title]').forEach((x) => (x.title = tip));
      return;
    }
    if (!it?.isDir || it.virtual || it.drive || isVirtual(it.path)) return;
    hoverT = setTimeout(async () => {
      let c = folderSizeCache.get(it.path);
      if (!c || Date.now() - c.at > 60000) { const r = await A.folderSize(it.path); c = { total: r.total, files: r.files, dirs: r.dirs, at: Date.now() }; folderSizeCache.set(it.path, c); }
      const tip = `${it.name}\nSize: ${fmtSize(c.total)}${c.files != null ? ` · ${c.files.toLocaleString()} files${c.dirs ? `, ${c.dirs.toLocaleString()} folders` : ''}` : ''}`;
      cell.title = tip; cell.querySelectorAll('[title]').forEach((x) => (x.title = tip));
      if (it.size == null || it.size !== c.total) { it.size = c.total; if (t.view === 'details' || state.settings.folderSizes) rerenderSoon(t); }
    }, 450);
  });

  // gallery: sliding the mouse across a video shows frames from start to end (filmstrip preview)
  let scrub = null, scrubRaf = 0;
  inner.addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.gal-cell.vid');
    if (scrub && scrub.cell !== cell) endScrub();
    if (!cell || e.buttons) return;
    const t = paneTab(el.idx);
    const it = t?.shown[+cell.dataset.ix];
    const m = it && MM.metaOf(it);
    if (!m?.dur) return;
    const img = cell.querySelector('img.gal-img');
    if (!img) return;
    if (!scrub) scrub = { cell, img, orig: img.src, last: -1 };
    const r = cell.getBoundingClientRect();
    const f = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
    cell.querySelector('.gal-scrub i')?.style.setProperty('width', (f * 100).toFixed(1) + '%');
    cell.classList.add('scrubbing');
    const step = Math.floor(f * 12);
    if (step === scrub.last) return;
    scrub.last = step;
    cancelAnimationFrame(scrubRaf);
    scrubRaf = requestAnimationFrame(() => { if (scrub?.cell === cell) img.src = `/media/thumb?p=${encodeURIComponent(it.path)}&t=${((step + 0.5) / 12 * m.dur).toFixed(1)}&w=${Math.min(640, Math.round(r.width * (window.devicePixelRatio || 1)))}`; });
  });
  const endScrub = () => { if (!scrub) return; scrub.cell.classList.remove('scrubbing'); scrub.img.src = scrub.orig; scrub = null; };
  inner.addEventListener('mouseleave', endScrub);

  inner.addEventListener('mousedown', (e) => {
    const hit = itemFromEvent(el, e);
    const t = paneTab(el.idx);
    const gh = e.target.closest('.group-head');
    if (gh) { t._collapsed = t._collapsed || new Set(); const g = gh.dataset.group; t._collapsed.has(g) ? t._collapsed.delete(g) : t._collapsed.add(g); recompute(t); renderView(el.idx); return; }
    if (e.button === 1 && hit) { e.preventDefault(); if (hit.it.isDir) openTab(hit.it.path, { after: t, background: true }); return; }
    if (!hit) {
      el._lastDown = null;
      if (e.button === 0 && t.view !== 'columns') startMarquee(el, t, e);
      else if (e.button === 0 && !e.ctrlKey && !e.shiftKey && state.settings.clickEmptyDeselects !== false && !e.target.closest('.mitem') && t.sel.size) selectNone(t);
      else if (e.button === 2 && !e.ctrlKey) { selectNone(t); }
      return;
    }
    const p = hit.it.path;
    // Our own double-click detection: the DOM never gets rebuilt between the two clicks, and it
    // works regardless of which element ends up under the cursor.
    if (e.button === 0) {
      const now = performance.now();
      const last = el._lastDown;
      const isDbl = last && last.path === p && now - last.t < DBL_MS && Math.abs(e.clientX - last.x) < 6 && Math.abs(e.clientY - last.y) < 6;
      el._lastDown = isDbl ? null : { path: p, t: now, x: e.clientX, y: e.clientY };
      if (isDbl && !e.shiftKey) {
        e.preventDefault();
        el._pendingSingle = null;
        if (!t.sel.has(p)) selectOnly(t, p);
        refreshSel(el, t);
        if (state.settings.singleClick) return;
        if (e.altKey) A.properties([hit.it]);
        else A.openItems([hit.it], { pane: el.idx, newTab: e.ctrlKey });
        return;
      }
    }
    const onBox = e.target.closest('.cbox');
    if (e.button === 2) { if (!t.sel.has(p)) { selectOnly(t, p); refreshSel(el, t); bus.emit('selection', t); } return; }
    if (e.shiftKey) selectRange(t, t.anchor ?? p, p, e.ctrlKey);
    else if (e.ctrlKey || onBox) { t.sel.has(p) ? t.sel.delete(p) : t.sel.add(p); t.focus = p; t.anchor = p; }
    else if (!t.sel.has(p)) selectOnly(t, p);
    else { t.focus = p; el._pendingSingle = p; }
    refreshSel(el, t);
    bus.emit('selection', t);
    if (t.view === 'columns' && hit.it.isDir && !e.ctrlKey && !e.shiftKey) { setTimeout(() => navigate(t, p), DBL_MS); }
    else if (t.view === 'columns' && !hit.it.isDir) setTimeout(() => { if (t.focus === p) renderColumns(el, t); }, DBL_MS);
  });
  inner.addEventListener('mouseup', (e) => {
    const t = paneTab(el.idx);
    if (el._pendingSingle && !e.ctrlKey && !e.shiftKey && e.button === 0 && !el._dragged) { selectOnly(t, el._pendingSingle); refreshSel(el, t); bus.emit('selection', t); }
    el._pendingSingle = null; el._dragged = false;
    if (state.settings.singleClick && e.button === 0 && !e.ctrlKey && !e.shiftKey) { const hit = itemFromEvent(el, e); if (hit) A.openItems([hit.it], { pane: el.idx }); }
  });
  inner.addEventListener('dblclick', (e) => {
    // Items are handled in mousedown; here only empty-space double-click (go up).
    if (itemFromEvent(el, e) || e.target.closest('.group-head')) return;
    const t = paneTab(el.idx);
    if (state.settings.doubleClickUp) goUp(t);
  });
  inner.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = itemFromEvent(el, e);
    const t = paneTab(el.idx);
    if (hit) A.itemsContextMenu(t, selectedItems(t), e);
    else A.backgroundContextMenu(t, e);
  });
  scroller.addEventListener('contextmenu', (e) => { if (e.target === scroller || e.target === el.overlay) { e.preventDefault(); A.backgroundContextMenu(paneTab(el.idx), e); } });

  // hover preview / tooltips
  inner.addEventListener('mouseover', (e) => {
    const hit = itemFromEvent(el, e);
    if (hit) bus.emit('hover', { item: hit.it, e });
  });

  // drag out (native: works with Explorer, desktop, browsers, mail…)
  inner.addEventListener('dragstart', (e) => {
    const hit = itemFromEvent(el, e);
    if (!hit) { e.preventDefault(); return; }
    const t = paneTab(el.idx);
    if (!t.sel.has(hit.it.path)) { selectOnly(t, hit.it.path); paintRows(el, t); }
    const paths = selectedItems(t).filter((i) => !i.virtual && !i.archive && !i.recycle && !i.mtp).map((i) => i.path);
    el._dragged = true;
    e.preventDefault();
    if (!paths.length) return;
    dragPaths = { paths, sourceDir: t.path, at: Date.now() };
    beginInternalDrag(paths, e);
  });

  attachDropTarget(body, (e) => {
    const hit = itemFromEvent(el, e);
    const t = paneTab(el.idx);
    if (hit && hit.it.isDir && !hit.it.virtual) return hit.it.path;
    if (hit && !hit.it.isDir && ['exe', 'bat', 'cmd'].includes(hit.it.ext)) return { exe: hit.it.path };
    if (hit && !hit.it.isDir && !hit.it.virtual && !hit.it.archive && KINDS.archive.includes(hit.it.ext)) return { archive: hit.it.path };
    if (hit && hit.it.isDir && hit.it.archive) return hit.it.path;
    return t.path && (!isVirtual(t.path) || isMtp(t.path) || isRemote(t.path) || t.path.startsWith('atlas:zip|')) ? t.path : null;
  }, (e) => { const hit = itemFromEvent(el, e); return hit?.cell || null; });

  body.addEventListener('keydown', (e) => onPaneKey(el, e));

  // drag a tab onto a pane: the middle shows it here, an edge splits the window (like a browser)
  const zoneOf = (e) => {
    const r = el.root.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (paneCount() >= MAX_PANES) return 'center';
    if (x < 0.22) return 'left'; if (x > 0.78) return 'right';
    if (y > 0.75) return 'bottom'; if (y < 0.18) return 'top';
    return 'center';
  };
  let hint = null;
  const clearHint = () => { hint?.remove(); hint = null; };
  el.root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-atlas-tab')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const z = zoneOf(e);
    // only one pane shows a hint at a time, and it disappears by itself once the drag stops moving over it
    document.querySelectorAll('.split-hint').forEach((x) => { if (x !== hint) x.remove(); });
    if (!hint || !hint.isConnected) { hint = h('div', { class: 'split-hint' }); el.root.append(hint); }
    hint.className = 'split-hint z-' + z;
    hint.textContent = z === 'center' ? 'Show here' : 'Split ' + z;
    clearTimeout(hint._t); hint._t = setTimeout(clearHint, 250);
  });
  el.root.addEventListener('dragleave', (e) => { if (!el.root.contains(e.relatedTarget)) clearHint(); });
  el.root.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('application/x-atlas-tab')) return;
    e.preventDefault(); e.stopPropagation();
    const z = zoneOf(e); clearHint();
    const id = e.dataTransfer.getData('application/x-atlas-tab');
    if (!tabById(id)) return;
    if (z === 'center') return showTabInPane(id, el.idx);
    splitPane(el.idx, z === 'left' || z === 'right' ? 'v' : 'h', { tabId: id, before: z === 'left' || z === 'top' });
  });
}

// a tab drag that ends anywhere (dropped on the tab strip, outside the window, Esc) never leaves a hint behind
for (const ev of ['dragend', 'drop']) document.addEventListener(ev, () => document.querySelectorAll('.split-hint').forEach((x) => x.remove()), true);
window.addEventListener('blur', () => document.querySelectorAll('.split-hint').forEach((x) => x.remove()));

const DBL_MS = 500;
// Update selection/focus classes in place (no DOM rebuild).
function refreshSel(el, t) {
  const sel = el.inner.querySelectorAll('.cell');
  for (const c of sel) { const it = t.shown[+c.dataset.ix]; if (!it) continue; const on = t.sel.has(it.path); c.classList.toggle('selected', on); c.setAttribute('aria-selected', String(on)); c.classList.toggle('focused', t.focus === it.path); }
}
function paintRowsOrColumns(el, t) { if (t.view === 'columns') { el.inner.querySelectorAll('.mcol.current .mitem').forEach((m) => { const it = t.shown[+m.dataset.ix]; m.classList.toggle('selected', t.sel.has(it.path)); m.classList.toggle('focused', t.focus === it.path); }); } else paintRows(el, t); }

// Generic drop target for any element (pane bodies, sidebar entries, crumbs, tabs)
// ---- dragging inside Dogfile ----
// Windows doesn't hand a native file drag back to the window it started from, so drags between panes, tabs,
// folders and the sidebar are run by Dogfile itself: a label follows the pointer, targets light up, and the drop
// happens on release. Leaving the window hands the drag to Windows (Explorer, the desktop, mail…); if it comes
// back and is dropped here, the main process reports where (drag:ended) and the drop still happens.
const internalTargets = new Set(); // { node, hover(e) -> element to light up | null, drop(e, paths), enter?(), leave?() }
export function registerDropTarget(node, spec) { internalTargets.add({ node, ...spec }); }
function targetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  let best = null;
  for (const t of internalTargets) {
    if (!t.node.isConnected) { internalTargets.delete(t); continue; }
    if (t.node.contains(el) && (!best || best.node.contains(t.node))) best = t;
  }
  return best ? { tgt: best, el } : null;
}
function fakeEvent(ev, el) {
  return { clientX: ev.clientX, clientY: ev.clientY, target: el, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, button: 0, synthetic: true,
    preventDefault() {}, stopPropagation() {}, dataTransfer: { types: ['Files'], files: [], getData: () => '', dropEffect: 'none' } };
}
let dragging = null;
export const isInternalDragging = () => !!dragging;
function beginInternalDrag(paths, e0) {
  const ghost = h('div', { class: 'drag-ghost' }, h('span', { html: icon(paths.length > 1 ? 'stack' : 'page') }), h('span', {}, paths.length > 1 ? `${paths.length} items` : basename(paths[0])), h('span', { class: 'dg-op' }));
  document.body.append(ghost);
  document.body.classList.add('item-dragging');
  let cur = null, lit = null;
  const place = (ev) => { ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`; };
  place(e0);
  const light = (node) => { if (lit === node) return; lit?.classList.remove('drop-on'); lit = node; lit?.classList.add('drop-on'); };
  const move = (ev) => {
    if (ev.buttons === 0) return up(ev); // released outside our listeners
    place(ev);
    const hit = targetAt(ev.clientX, ev.clientY);
    const fe = hit && fakeEvent(ev, hit.el);
    const tgt = hit && hit.tgt.hover(fe) ? hit.tgt : null;
    if (tgt !== cur) { cur?.leave?.(); cur = tgt; cur?.enter?.(); }
    light(tgt ? tgt.hover(fe) : null);
    const op = !tgt ? '' : ev.altKey ? 'Shortcut' : ev.ctrlKey ? 'Copy' : ev.shiftKey ? 'Move' : tgt.op?.(fe, paths) || '';
    ghost.querySelector('.dg-op').textContent = op;
    ghost.classList.toggle('none', !tgt);
  };
  const out = (ev) => {
    // left the window: hand over to Windows for Explorer, the desktop, other apps
    if (ev.relatedTarget || ev.toElement) return;
    stop();
    window.atlas.startDrag(paths);
  };
  const up = (ev) => {
    const hit = targetAt(ev.clientX, ev.clientY);
    stop();
    if (!hit) { dragPaths = null; return; }
    const fe = fakeEvent(ev, hit.el);
    if (!hit.tgt.hover(fe)) { dragPaths = null; return; }
    dragPaths = null;
    hit.tgt.drop(fe, paths);
  };
  const key = (ev) => { if (ev.key === 'Escape') { stop(); dragPaths = null; } };
  const stop = () => {
    window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', up, true);
    document.removeEventListener('mouseout', out, true); window.removeEventListener('keydown', key, true);
    cur?.leave?.(); light(null); ghost.remove(); document.body.classList.remove('item-dragging'); dragging = null;
    bus.emit('dragEnded');
  };
  dragging = { paths, stop };
  window.addEventListener('mousemove', move, true); window.addEventListener('mouseup', up, true);
  document.addEventListener('mouseout', out, true); window.addEventListener('keydown', key, true);
}
// a native drag that went out of the window and was dropped back in (or into another Dogfile window)
window.atlas?.on?.('drag:ended', ({ x, y, paths }) => {
  const ps = paths || dragPaths?.paths;
  if (!ps?.length) return;
  if (!paths && !dragPaths) return; // a real drop already handled it
  const hit = targetAt(x, y);
  dragPaths = null;
  if (!hit) return;
  const fe = fakeEvent({ clientX: x, clientY: y }, hit.el);
  if (hit.tgt.hover(fe)) hit.tgt.drop(fe, ps);
});

// files dragged in from Explorer, the desktop or another app (and Dogfile's own drags that left the window and
// came back): the app reports them with the pointer position, and the same drop targets light up and take them
{
  let nd = null;
  const light = (node) => { if (nd.lit === node) return; nd.lit?.classList.remove('drop-on'); nd.lit = node; nd.lit?.classList.add('drop-on'); };
  const clear = () => { if (!nd) return; nd.cur?.leave?.(); light(null); nd = null; document.body.classList.remove('item-dragging'); };
  window.addEventListener('dogfile:nativedrag', ({ detail: d }) => {
    if (d.type === 'leave') { clear(); return; }
    if (!nd) nd = { cur: null, lit: null, paths: [] };
    if (d.paths?.length) nd.paths = d.paths;
    const ev = { clientX: d.x, clientY: d.y };
    const hit = targetAt(d.x, d.y);
    const fe = hit && fakeEvent(ev, hit.el);
    const tgt = hit && hit.tgt.hover(fe) ? hit.tgt : null;
    if (d.type === 'drop') {
      const paths = nd.paths;
      clear();
      dragPaths = null;
      if (tgt && paths.length) tgt.drop(fe, paths);
      return;
    }
    document.body.classList.add('item-dragging');
    if (tgt !== nd.cur) { nd.cur?.leave?.(); nd.cur = tgt; nd.cur?.enter?.(); }
    light(tgt ? tgt.hover(fe) : null);
  });
}

export function attachDropTarget(node, resolveDir, hiliteFn, opts = {}) {
  registerDropTarget(node, {
    hover: (e) => (resolveDir(e) ? (hiliteFn ? hiliteFn(e) || node : node) : null),
    drop: (e, paths) => runDrop(e, resolveDir(e), paths),
    op: (e, paths) => { const dir = resolveDir(e); if (typeof dir === 'object') return dir.exe ? 'Open with' : 'Add to archive'; if (typeof dir === 'string' && paths.every((p) => samePath(dirname(p), dir))) return ''; return typeof dir === 'string' && sameRoot(paths[0], dir) ? 'Move' : 'Copy'; },
    enter: opts.enter, leave: opts.leave,
  });
  let last = null;
  const clear = () => { node.classList.remove('drop-on'); if (last) last.classList.remove('drop-on'); last = null; };
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    const dir = resolveDir(e);
    if (!dir) { e.dataTransfer.dropEffect = 'none'; clear(); return; }
    e.preventDefault();
    e.stopPropagation();
    const target = typeof dir === 'string' ? dir : null;
    const src = dragPaths?.paths?.[0];
    let effect = e.ctrlKey ? 'copy' : e.shiftKey ? 'move' : e.altKey ? 'link' : src && target && sameRoot(src, target) ? 'move' : 'copy';
    if (typeof dir === 'object') effect = 'copy';
    e.dataTransfer.dropEffect = effect;
    const hl = hiliteFn ? hiliteFn(e) : null;
    if (hl !== last) { if (last) last.classList.remove('drop-on'); last = hl; if (hl) hl.classList.add('drop-on'); }
    if (!hl) node.classList.add('drop-on'); else node.classList.remove('drop-on');
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) clear(); });
  node.addEventListener('drop', async (e) => {
    const dir = resolveDir(e);
    clear();
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    let paths = [...(e.dataTransfer.files || [])].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (!paths.length && dragPaths) paths = dragPaths.paths;
    dragPaths = null;
    if (!paths.length) {
      // dropped text / url -> save as file
      const txt = e.dataTransfer.getData('text/plain');
      if (txt && typeof dir === 'string') A.saveDroppedText(dir, txt);
      return;
    }
    runDrop(e, dir, paths);
  });
}
async function runDrop(e, dir, paths) {
    if (!dir || !paths?.length) return;
    if (typeof dir === 'object' && dir.exe) { api('shell:launch', dir.exe, paths); return; }
    // dropping onto an archive (or into an open archive) adds the files to it
    const zipT = typeof dir === 'object' && dir.archive ? { arc: dir.archive, inner: '' } : typeof dir === 'string' && dir.startsWith('atlas:zip|') ? A.arcOf(dir) : null;
    if (zipT) { if (paths.some((p) => samePath(p, zipT.arc))) return; A.addToArchive(paths, zipT.arc, zipT.inner); return; }
    if (e.altKey) { A.createShortcuts(paths, dir); return; }
    if (paths.every((p) => samePath(dirname(p), dir)) && !e.ctrlKey) return; // dropped onto its own folder
    if (paths.some((p) => samePath(p, dir) || isInside(dir, p))) { toast("Can't move a folder into itself", { error: true }); return; }
    let move = e.shiftKey ? true : e.ctrlKey ? false : sameRoot(paths[0], dir);
    // features listening for drops may send the files elsewhere, take fewer, switch copy/move, or stop it
    const H = await import('./hooks.js');
    if (H.hasListeners() && typeof dir === 'string') {
      const p = await H.before('beforeDrop', { sources: paths, dest: dir, mode: move ? 'move' : 'copy' });
      if (p.cancel) { toast(p.reason, { error: true }); return; }
      if (!p.sources.length) return;
      paths = p.sources; dir = p.dest; move = p.mode === 'move';
    }
    if (e.button === 2 || state.settings.askOnDrop) {
      showMenu([
        { label: 'Move here', icon: 'cut', run: () => A.transfer(paths, dir, 'move') },
        { label: 'Copy here', icon: 'copy', run: () => A.transfer(paths, dir, 'copy') },
        { label: 'Create shortcuts here', icon: 'link', run: () => A.createShortcuts(paths, dir) },
        { label: 'Compress here (zip)', icon: 'zip', run: () => A.compressTo(paths, dir) },
      ], e.clientX, e.clientY);
      return;
    }
    // smart drop: when the files and the place suggest something better (extract, sort with this folder's rules,
    // put into matching subfolders…), offer it, with the usual move / copy first
    if (state.settings.smartDrop !== 'off' && !e.ctrlKey && !e.shiftKey && !isVirtual(dir)) {
      const sm = await import('./smartdrop.js');
      if (await sm.smartDrop(paths, dir, move, e.clientX, e.clientY)) return;
    }
    A.transfer(paths, dir, move ? 'move' : 'copy');
}
export function sameRoot(a, b) {
  if (!IS_WIN()) return true;
  const r = (p) => (p.startsWith('\\\\') ? p.split('\\').slice(0, 4).join('\\') : p.slice(0, 2)).toLowerCase();
  return r(a) === r(b);
}

// Marquee (rubber-band) selection with auto-scroll
function startMarquee(el, t, e) {
  const base = e.ctrlKey ? new Set(t.sel) : new Set();
  if (!e.ctrlKey && !e.shiftKey) { t.sel = new Set(); t.focus = null; refreshSel(el, t); bus.emit('selection', t); bus.emit('status'); }
  const sr = el.scroller.getBoundingClientRect();
  const x0 = e.clientX - sr.left + el.scroller.scrollLeft, y0 = e.clientY - sr.top + el.scroller.scrollTop;
  // hit-testing uses the item area's own coordinates (they don't change when it scrolls)
  const ir0 = el.inner.getBoundingClientRect();
  const xi0 = e.clientX - ir0.left, yi0 = e.clientY - ir0.top;
  const box = h('div', { class: 'marquee' });
  let started = false, lastE = e, raf = null;
  const update = () => {
    const x1 = lastE.clientX - sr.left + el.scroller.scrollLeft, y1 = lastE.clientY - sr.top + el.scroller.scrollTop;
    const L = el.layout;
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    Object.assign(box.style, { left: ax + 'px', top: ay + 'px', width: bx - ax + 'px', height: by - ay + 'px' });
    const ir = el.inner.getBoundingClientRect();
    const xi1 = lastE.clientX - ir.left, yi1 = lastE.clientY - ir.top;
    const [hx0, hx1] = [Math.min(xi0, xi1), Math.max(xi0, xi1)], [hy0, hy1] = [Math.min(yi0, yi1), Math.max(yi0, yi1)];
    const sel = new Set(base);
    // only the visible part of each item counts (not the spacing around it), so the row above isn't picked up
    const pad = t.view === 'grid' || t.view === 'gallery' ? 8 : 3;
    for (const row of L.rows) {
      if (row.type !== 'items' || row.y + row.h - pad < hy0 || row.y + pad > hy1) continue;
      row.items.forEach((ix, c) => {
        let cx0, cx1;
        if (t.view === 'gallery') { cx0 = row.xs[c]; cx1 = cx0 + row.ws[c]; }
        else if (t.view === 'grid') { cx0 = L.pad + c * L.cellW + 6; cx1 = cx0 + L.cellW - 12; }
        else if (t.view === 'list') { cx0 = 12 + c * L.cellW; cx1 = cx0 + L.cellW - 12; }
        else { cx0 = 0; cx1 = colWidth('name') + 40; }
        if (cx1 >= hx0 && cx0 <= hx1) { const p = t.shown[ix].path; if (e.ctrlKey && base.has(p)) sel.delete(p); else sel.add(p); }
      });
    }
    t.sel = sel;
    refreshSel(el, t);
    bus.emit('selection', t);
  };
  const autoscroll = () => {
    const r = el.scroller.getBoundingClientRect();
    let dy = 0;
    if (lastE.clientY < r.top + 30) dy = -Math.min(40, r.top + 30 - lastE.clientY);
    else if (lastE.clientY > r.bottom - 30) dy = Math.min(40, lastE.clientY - (r.bottom - 30));
    if (dy) { el.scroller.scrollTop += dy; update(); }
    raf = requestAnimationFrame(autoscroll);
  };
  const move = (ev) => {
    lastE = ev;
    if (!started && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
    if (!started) { started = true; el.overlay.append(box); raf = requestAnimationFrame(autoscroll); }
    update();
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    cancelAnimationFrame(raf); box.remove();
    if (started) { const arr = [...t.sel]; t.focus = arr[arr.length - 1] || null; t.anchor = t.focus; }
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

function onPaneKey(el, e) {
  const t = paneTab(el.idx);
  if (!t) return;
  if (e.target !== el.body) return;
  const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
  if (nav.includes(e.key) && !e.altKey) {
    if (t.view === 'columns' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') goUp(t);
      else { const it = t.focus && t.shown[t.indexOf.get(t.focus)]; if (it?.isDir) navigate(t, it.path); }
      return;
    }
    e.preventDefault();
    moveFocus(el, t, e.key, e.shiftKey, e.ctrlKey);
    return;
  }
  if (e.key === ' ' && e.ctrlKey && t.focus) { e.preventDefault(); t.sel.has(t.focus) ? t.sel.delete(t.focus) : t.sel.add(t.focus); paintRows(el, t); bus.emit('selection', t); return; }
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== ' ' ) { typeAhead(el, t, e.key); e.preventDefault(); return; }
}

// ======================================================================
// Inline rename (F2): selects name without extension; Tab moves to next item
// ======================================================================
export function startRename(t, it, paneIdx = state.activePane) {
  const el = paneEls[paneIdx];
  if (!el || !it || it.virtual || it.recycle || it.archive) return;
  const ix = t.indexOf.get(it.path);
  scrollToItem(el, t, ix);
  paintRows(el, t);
  const cell = el.inner.querySelector(`.cell[data-ix="${ix}"]`);
  if (!cell) return;
  const target = cell.querySelector('.label, .nm');
  const sr = el.scroller.getBoundingClientRect();
  const r = (target || cell).getBoundingClientRect();
  const input = h(t.view === 'grid' ? 'textarea' : 'input', { class: 'rename-box ' + t.view, spellcheck: 'false' });
  input.value = it.name;
  const w = t.view === 'grid' ? Math.max(r.width, 140) : Math.max(r.width + 40, 220);
  Object.assign(input.style, { left: r.left - sr.left + el.scroller.scrollLeft - (t.view === 'grid' ? (w - r.width) / 2 : 4) + 'px', top: r.top - sr.top + el.scroller.scrollTop - 3 + 'px', width: w + 'px' });
  el.overlay.append(input);
  input.focus();
  const dot = it.isDir ? -1 : it.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : it.name.length);
  let finished = false;
  const finish = async (commit, next) => {
    if (finished) return; finished = true;
    const v = input.value.trim().replace(/[\r\n]/g, '');
    input.remove();
    el.body.focus({ preventScroll: true });
    if (commit && v && v !== it.name) await A.renameOne(it, v);
    if (next) {
      const ni = (t.indexOf.get(it.path) ?? ix) + next;
      const nit = t.shown[ni];
      if (nit) { selectOnly(t, nit.path); startRename(t, nit, paneIdx); }
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
    else if (e.key === 'F2') {
      // cycle selection: name → extension → all (like Explorer power-user trick)
      e.preventDefault(); const v = input.value; const d = v.lastIndexOf('.');
      if (input.selectionStart === 0 && input.selectionEnd === d) input.setSelectionRange(d + 1, v.length);
      else if (input.selectionStart === d + 1) input.setSelectionRange(0, v.length);
      else input.setSelectionRange(0, d > 0 ? d : v.length);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

// ======================================================================
// Watchers
// ======================================================================
export function watchPanes() {
  for (let i = 0; i < 4; i++) {
    const t = i < paneCount() ? paneTab(i) : null;
    api('watch:set', 'pane' + i, t && !isVirtual(t.path) ? t.path : null);
  }
}
bus.on('layout', () => watchPanes());
bus.on('loaded', () => watchPanes());
bus.on('tags', () => requestAnimationFrame(renderAll)); // tag dots show the moment a tag changes
export function onWatchChanged({ key, dir }) {
  const i = +key.replace('pane', '');
  const t = paneTab(i);
  if (t && samePath(t.path, dir) && !t.loading) {
    clearThumbCache();
    loadTab(t, { soft: true });
  }
}
