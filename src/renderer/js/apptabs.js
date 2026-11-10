// Built-in apps (Dogfile Notepad, Dogfile Player, Dogfile Photos) either in their own window or as tabs inside the
// main window (Settings > General > "Open built-in apps as tabs"). Each app tab owns one persistent <iframe>
// that floats over whichever pane is showing the tab, so switching tabs or changing the split never reloads it.
import { api, onMain, state, bus, h, toast } from './core.js';
import { paneEls, paneCount, newTabState, showTabInPane, openTab, navigate, tabById, closeTab, setLeaveHandler, setLayout } from './pane.js';

export const APPS = {
  editor: { title: 'Dogfile Notepad', icon: 'notepad' },
  player: { title: 'Dogfile Player', icon: 'film' },
  viewer: { title: 'Dogfile Photos', icon: 'image' },
  model: { title: 'Dogfile 3D', icon: 'cube' },
  office: { title: 'Dogfile Office', icon: 'page' },
  psd: { title: 'Dogfile PSD', icon: 'stack' },
  web: { title: 'Dogfile Web', icon: 'globe' },
};
const frames = new Map(); // tabId -> iframe
let host = null;
const ro = new ResizeObserver(() => syncFrames());

export const isAppTab = (t) => !!(t && t.app);

const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function newAppTab(kind, pending, { activate = true, after = null } = {}) {
  const t = newTabState({ app: kind, appTitle: APPS[kind].title });
  t.path = 'atlas:app:' + kind; t.history = [t.path]; t.hi = 0; t._loadedOnce = true; t._viewInit = true;
  const cur = after || tabById(state.panes[state.activePane]);
  const at = cur ? state.tabs.indexOf(cur) + 1 : state.tabs.length;
  state.tabs.splice(at, 0, t);
  createFrame(t, pending);
  if (activate) showTabInPane(t.id, state.activePane);
  bus.emit('tabs');
  return t;
}
export function openTool(kind, files = [], opts = {}) {
  // opts.inTab: the assistant opens a file to work on it here, even when built-in apps normally get their own window
  // the web pane only exists as a tab: it sits over a pane
  if (kind === 'web') opts = { ...opts, inTab: true };
  if (!state.settings.toolsInTabs && !opts.inTab) return api('tool:open', kind, files, opts);
  // Dogfile Notepad: every document is its own tab, like a browser
  if (kind === 'editor') {
    if (opts.compare) { const t = newAppTab('editor', { files, compare: true }); t.appTitle = files.map((f) => f.split(/[\\/]/).pop()).join(' ↔ '); return t; }
    if (!files.length) return newAppTab('editor', opts.text != null ? { text: String(opts.text), name: opts.name || null, dir: opts.dir || null } : {});
    let last = null;
    for (const f of files) {
      const ex = state.tabs.find((x) => x.app === 'editor' && samePath(x.appPath, f));
      if (ex) { last = ex; continue; }
      last = newAppTab('editor', { files: [f] }, { activate: false, after: last });
      last.appPath = f;
    }
    if (last) showTabInPane(last.id, paneFor(last));
    return last;
  }
  // "Open in a new tab": its own tab even when one is open already (two Office documents side by side)
  if (opts.newTab) { const { newTab: _n, ...rest } = opts; return newAppTab(kind, { files, ...rest }); }
  // otherwise the one showing now, or the last one opened
  const act = tabById(state.panes[state.activePane]);
  let t = act?.app === kind ? act : [...state.tabs].reverse().find((x) => x.app === kind);
  if (t && frames.has(t.id)) {
    if (files.length || opts.url) post(t, { type: 'open', files, ...opts });
    showTabInPane(t.id, paneFor(t));
    return t;
  }
  return newAppTab(kind, { files, ...opts });
}
/** a web page in the other pane, what you are looking at stays where it is (the URL buttons, "Web pane" in the pane list) */
export function openWebBeside(url) {
  const here = state.activePane;
  if (paneCount() < 2) setLayout('2v');
  const other = here === 0 ? 1 : 0;
  let t = state.tabs.find((x) => x.app === 'web');
  if (t && frames.has(t.id)) {
    const f = frames.get(t.id);
    const send = () => post(t, { type: 'open', url });
    // a page still loading would miss the message
    let ready = false, loaded = false;
    try { loaded = f.contentDocument?.readyState === 'complete'; ready = !!f.contentDocument?.body?.classList.contains('ready'); } catch { /* not readable: send anyway */ ready = true; }
    if (ready) send(); else if (loaded) setTimeout(send, 500); else f.addEventListener('load', () => setTimeout(send, 500), { once: true });
    // the web page itself is what is on show here: it just goes to the address
    if (state.panes[here] === t.id) return t;
  } else t = newAppTab('web', url ? { url } : {}, { activate: false });
  // the pane shows its tab a moment after the layout is built
  setTimeout(() => { showTabInPane(t.id, other); state.activePane = here; bus.emit('activePane'); document.querySelectorAll('.pane').forEach((p, k) => p.classList.toggle('active', k === here)); syncFrames(); }, 0);
  return t;
}
function paneFor(t) { const i = state.panes.slice(0, paneCount()).indexOf(t.id); return i >= 0 ? i : state.activePane; }

function createFrame(t, pending) {
  ensureHost();
  const q = new URLSearchParams({ embed: '1', id: t.id, pending: JSON.stringify(pending || {}) });
  const f = h('iframe', { class: 'app-frame', src: `/app/${t.app}.html?${q}`, allow: 'fullscreen; autoplay; clipboard-read; clipboard-write', allowfullscreen: 'true' });
  f.dataset.tab = t.id;
  host.append(f);
  frames.set(t.id, f);
  f.addEventListener('load', () => post(t, { type: 'settings', settings: state.settings }));
}
function ensureHost() {
  if (host) return;
  host = h('div', { id: 'app-frames' });
  // inside the main area, so its floating panels (Operations, search suggestions, the assistant) stay on top of
  // an app tab instead of opening underneath it
  (document.getElementById('main') || document.body).append(host);
}
export function post(t, msg) { const f = frames.get(t.id); f?.contentWindow?.postMessage({ ...msg, atlasHost: true }, '*'); }
export function appCmd(id, arg) { const t = activeAppTab(); if (t) post(t, { type: 'cmd', id, arg }); }
export function activeAppTab() { const t = tabById(state.panes[state.activePane]); return isAppTab(t) ? t : null; }

// keep every frame glued to the pane that shows its tab
let raf = 0;
export function syncFrames() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(applyFrames);
}
function applyFrames() {
  {
    const n = paneCount();
    // an app filling the only pane doesn't need the preview column beside it
    const appOnly = n === 1 && frames.has(state.panes[0]);
    if (document.body.classList.contains('app-only') !== appOnly) { document.body.classList.toggle('app-only', appOnly); syncFrames(); }
    for (const [id, f] of frames) {
      const i = state.panes.slice(0, n).indexOf(id);
      const el = i >= 0 ? paneEls[i] : null;
      if (!el || !el.root.isConnected) { f.style.display = 'none'; webLayout(id, false); continue; }
      const r = el.root.getBoundingClientRect();
      Object.assign(f.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      f.classList.toggle('active', i === state.activePane);
      webLayout(id, true);
    }
  }
}
// the web pane's native views sit above everything the window draws: tell the page when its pane is hidden, and when
// a menu, dialog or panel of the window is over it (the page hides its view until they are gone)
function webLayout(id, visible) {
  const t = tabById(id);
  if (t?.app !== 'web') return;
  post(t, { type: 'layout', visible });
  scheduleCover();
}
let coverTimer = 0;
const covered = new Set();
const dragging = () => document.body.classList.contains('pane-resizing') || document.body.classList.contains('wheel-open') || document.body.classList.contains('tab-dragging');
// dragging a pane divider, the sidebar edge or the preview edge: the pages must not catch the mouse on the way
window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && e.target?.closest?.('.splitter, #sidebar-resizer, #preview-resizer') && frames.size) { document.body.classList.add('pane-resizing'); checkCover(); }
}, true);
bus.on('coverNow', () => { if (frames.size) checkCover(); });
window.addEventListener('mouseup', () => { if (document.body.classList.contains('pane-resizing')) { document.body.classList.remove('pane-resizing'); setTimeout(checkCover, 30); } }, true);
function scheduleCover() { if (!coverTimer) coverTimer = setTimeout(() => { coverTimer = 0; checkCover(); }, 90); }
function checkCover() {
  for (const [id, f] of frames) {
    const t = tabById(id);
    if (t?.app !== 'web') continue;
    let on = false;
    // while a divider (or a tab or file) is being dragged the page's native view would swallow the mouse: hide it
    if (f.style.display !== 'none' && dragging()) on = true;
    // files being dragged from a folder: the page stays on show (a site takes the drop), and the frames ignore the mouse then, so looking at what is on top would say "covered"
    else if (document.body.classList.contains('item-dragging')) on = false;
    else if (f.style.display !== 'none') {
      let r = f.getBoundingClientRect();
      try { const s = f.contentDocument?.getElementById('wb-stage')?.getBoundingClientRect(); if (s && s.width) r = { left: r.left + s.left, top: r.top + s.top, width: s.width, height: s.height }; } catch { /* not readable: the whole frame */ }
      outer: for (const fx of [0.04, 0.3, 0.5, 0.7, 0.96]) for (const fy of [0.04, 0.5, 0.96]) {
        const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        if (el && el !== f && !f.contains(el)) { on = true; break outer; }
      }
    }
    if (on !== covered.has(id)) { on ? covered.add(id) : covered.delete(id); post(t, { type: 'cover', on }); }
  }
}
new MutationObserver(() => { if (frames.size) scheduleCover(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] });
for (const ev of ['mousedown', 'keydown', 'contextmenu', 'focusin', 'transitionend', 'animationend']) document.addEventListener(ev, () => { if (frames.size) scheduleCover(); }, true);
export function observePanes() {
  ro.disconnect();
  for (const el of paneEls) if (el) ro.observe(el.root);
  syncFrames();
}
// During the sidebar fold animation panes move every frame: follow them
bus.on('foldTick', syncFrames);
for (const ev of ['syncFrames', 'layout', 'activePane', 'tabs']) bus.on(ev, syncFrames);
bus.on('panesBuilt', observePanes);
window.addEventListener('resize', syncFrames);
bus.on('tabClosed', (t) => {
  const f = frames.get(t.id);
  if (f) { f.remove(); frames.delete(t.id); }
  covered.delete(t.id);
  if (t.app === 'web') {
    // every page of this browser is closed and forgotten with its tab
    api('web:do', 'closeAll', { prefix: t.id.replace(/[^a-z0-9]/gi, '').slice(0, 6) + '_' }).catch(() => {});
    toast('Dogfile Web closed. Nothing was saved: no history, cookies, passwords or logins.');
  }
  syncFrames();
});
bus.on('settings', () => { for (const id of frames.keys()) { const t = tabById(id); if (t) post(t, { type: 'settings', settings: state.settings }); } });

// messages coming up from the apps
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (!m.atlasFrame) return;
  const t = tabById(m.atlasFrame);
  if (!t) return;
  if (m.type === 'title') { t.appTitle = m.title.replace(/ - Dogfile (Notepad|Player|Photos|Web)$/, '') || APPS[t.app].title; bus.emit('tabs'); }
  else if (m.type === 'state') { t.appState = m; if (m.path) t.appPath = m.path; bus.emit('appState', t); }
  else if (m.type === 'open') openTool(m.kind || t.app, m.files || [], m.opts || {});
  else if (m.type === 'dirty') { t.appDirty = !!m.dirty; bus.emit('tabs'); }
  else if (m.type === 'showInFiles') {
    const nt = openTab(m.path);
    if (m.select) setTimeout(() => navigate(nt, m.path, { select: m.select }), 30);
  } else if (m.type === 'key') bus.cmd(m.cmd);
  else if (m.type === 'close') closeTab(t, { force: true });
  else if (m.type === 'focus') { const i = state.panes.slice(0, paneCount()).indexOf(t.id); if (i >= 0 && i !== state.activePane) { state.activePane = i; bus.emit('activePane'); document.querySelectorAll('.pane').forEach((p, k) => p.classList.toggle('active', k === i)); syncFrames(); bus.emit('appState', t); } }
  else if (m.type === 'toast') toast(m.text, { error: m.error });
  else if (m.type === 'askAnswer') { const r = askWaits.get(m.token); askWaits.delete(m.token); r?.(m.result); }
  else if (m.type === 'menuSpec') { const r = menuWaits.get(m.token); menuWaits.delete(m.token); r?.(m.items || []); }
  else if (m.type === 'leaveAsking') leaveWaits.get(m.token + ':asking')?.();
  else if (m.type === 'leaveAnswer') { const r = leaveWaits.get(m.token); leaveWaits.delete(m.token); leaveWaits.delete(m.token + ':asking'); r?.(!!m.ok); }
});

// file watching for Dogfile Notepad tabs is delivered to the main frame: pass it on
onMain('file:changed', (p) => { for (const id of frames.keys()) { const t = tabById(id); if (t?.app === 'editor') post(t, { type: 'fileChanged', path: p }); } });

// the id an app tab's answer must carry: unguessable, so no other page can answer in its place (for example to
// skip the "save your changes?" question when a tab closes)
const newToken = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');

// the assistant asking an app tab to do something; resolves with the app's { ok, msg }
const askWaits = new Map();
export function appAsk(op, arg, t = activeAppTab(), ms = 120000) {
  if (!t || !frames.has(t.id)) return Promise.resolve({ ok: false, msg: 'The app isn’t open' });
  const token = newToken();
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => { askWaits.delete(token); resolve({ ok: false, msg: 'The app didn’t answer' }); }, ms);
    askWaits.set(token, (r) => { clearTimeout(giveUp); resolve(r || { ok: true }); });
    post(t, { type: 'ask', op, arg, token });
  });
}
// an app's own menu (File, Edit…), shown from the ribbon in the main window
const menuWaits = new Map();
export function appMenu(name) {
  const t = activeAppTab();
  if (!t) return Promise.resolve([]);
  const token = newToken();
  const conv = (items) => items.map((it) => ({ ...it, submenu: it.submenu ? conv(it.submenu) : undefined, run: it.id ? () => post(t, { type: 'menuRun', id: it.id }) : undefined }));
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => { menuWaits.delete(token); resolve([]); }, 3000);
    menuWaits.set(token, (items) => { clearTimeout(giveUp); resolve(name === '*' ? items : conv(items)); });
    post(t, { type: 'menuSpec', name, token });
  });
}

// leaving or closing an app tab: the app asks about unsaved work (Save / Don't save / Cancel) and answers
const leaveWaits = new Map();
setLeaveHandler((t) => {
  const f = frames.get(t.id);
  if (!f?.contentWindow) return Promise.resolve(true);
  const token = newToken();
  return new Promise((resolve) => {
    leaveWaits.set(token, resolve);
    // an app that never answers (still loading, or crashed) doesn't hold the tab hostage
    const giveUp = setTimeout(() => { if (leaveWaits.delete(token)) resolve(true); }, 1500);
    leaveWaits.set(token, (ok) => { clearTimeout(giveUp); resolve(ok); });
    post(t, { type: 'leave', token });
    // once the app shows a question, it may take as long as the person needs
    leaveWaits.set(token + ':asking', () => { clearTimeout(giveUp); if (state.panes[state.activePane] !== t.id) showTabInPane(t.id, state.activePane); });
  });
});

// keep frames glued to their panes even when a pane moves without resizing (ribbon, sidebar fold, window
// snapping, status bar...). Only runs while at least one app tab is on screen; cheap rect reads.
let lastKey = '';
(function watch() {
  requestAnimationFrame(watch);
  if (!frames.size) return;
  const n = paneCount();
  let key = '';
  for (let i = 0; i < n; i++) { const el = paneEls[i]; const t = tabById(state.panes[i]); if (!el || !t?.app) continue; const r = el.root.getBoundingClientRect(); key += `${i}:${r.left},${r.top},${r.width},${r.height}|`; }
  if (key !== lastKey) { lastKey = key; applyFrames(); }
})();
