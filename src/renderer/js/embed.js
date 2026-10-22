// Lets Dogfile Notepad / Player / Viewer run either in their own window or inside a tab of the main window.
import { api } from './core.js';

const params = new URLSearchParams(location.search);
export const EMBED = params.has('embed');
export const FRAME_ID = params.get('id') || '';

export async function pendingFiles() {
  if (EMBED) { try { return JSON.parse(params.get('pending') || 'null'); } catch { return null; } }
  return api('tool:pending');
}
// tell the host tab something (title, media kind for the contextual ribbon, …)
export function tellHost(msg) { if (EMBED) parent.postMessage({ ...msg, atlasFrame: FRAME_ID }, '*'); }
export function onHost(handlers) {
  if (!EMBED) return;
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.atlasHost !== true) return;
    if (m.type === 'open') handlers.open?.(m);
    if (m.type === 'cmd') handlers.cmd?.(m.id, m.arg);
    if (m.type === 'settings') handlers.settings?.(m.settings);
    if (m.type === 'fileChanged') handlers.fileChanged?.(m.path);
    if (m.type === 'leave') answerLeave(m.token);
  });
}
// Before the tab closes or goes to a folder: unsaved work? The app's handler asks the person and says yes or no.
let leaveHandler = null;
export function onLeave(fn) { leaveHandler = fn; }
async function answerLeave(token) {
  let ok = true;
  try { if (leaveHandler) ok = await leaveHandler(() => tellHost({ type: 'leaveAsking', token })); } catch { ok = true; }
  tellHost({ type: 'leaveAnswer', token, ok });
}
// In its own window: closing the window asks the same question first (the window waits for the answer).
export function onWindowClose(fn) {
  if (EMBED) return;
  window.atlas.on('app:closeRequested', async () => {
    let ok = true;
    try { ok = await fn(() => api('win:control', 'closeAsking')); } catch { ok = true; }
    api('win:control', ok ? 'closeNow' : 'closeCancel');
  });
}
// The app's menus (File, Edit, Search, View…) shown from the main window's ribbon: the host asks for a menu by
// name, gets a plain copy of it, and sends back which item was picked.
let menuSource = null, menuAfter = null;
const menuRuns = new Map();
let menuSeq = 0;
export function exposeMenus(get, { after } = {}) { menuSource = get; menuAfter = after; }
async function plainMenu(items) {
  if (typeof items === 'function') items = await items();
  const out = [];
  for (const it of items || []) {
    if (!it || it.hidden || it.custom) continue;
    const o = {};
    for (const k of ['label', 'keys', 'icon', 'checked', 'radio', 'selected', 'disabled', 'separator', 'header', 'danger', 'swatch', 'tone']) if (it[k] != null && it[k] !== false) o[k] = it[k];
    if (it.submenu) o.submenu = await plainMenu(it.submenu);
    else if (it.run) { const id = ++menuSeq; menuRuns.set(id, it.run); o.id = id; }
    out.push(o);
  }
  return out;
}
if (EMBED) window.addEventListener('message', async (e) => {
  const m = e.data || {};
  if (m.atlasHost !== true) return;
  if (m.type === 'menuSpec') {
    let items = [];
    try { const all = menuSource ? await menuSource() : {}; if (m.name === '*') items = Object.keys(all); else { menuRuns.clear(); items = await plainMenu(all[m.name]); } } catch (err) { console.error(err); }
    tellHost({ type: 'menuSpec', token: m.token, items });
  } else if (m.type === 'menuRun') {
    const run = menuRuns.get(m.id);
    if (run) { try { await run(); } finally { menuAfter?.(); } }
  }
});
export function showInFiles(path, isDir) {
  const dir = isDir ? path : path.replace(/[\\/][^\\/]*$/, '');
  if (EMBED) tellHost({ type: 'showInFiles', path: dir, select: isDir ? null : path });
  else api('win:new', { path: dir, select: isDir ? null : path });
}
export function setTitle(t) { document.title = t; tellHost({ type: 'title', title: t }); }
if (EMBED) {
  document.documentElement.classList.add('embedded');
  // tab shortcuts still work while the app inside a tab has focus
  window.addEventListener('keydown', (e) => {
    const c = e.ctrlKey || e.metaKey;
    let cmd = null;
    if (c && e.key === 'Tab') cmd = e.shiftKey ? 'prevTab' : 'nextTab';
    else if (c && e.key === 'PageDown') cmd = 'nextTab';
    else if (c && e.key === 'PageUp') cmd = 'prevTab';
    else if (c && !e.shiftKey && e.key.toLowerCase() === 't') cmd = 'newTab';
    else if (c && e.shiftKey && e.key.toLowerCase() === 't') cmd = 'reopenTab';
    else if (c && e.key === 'F4') cmd = 'closeTab';
    if (cmd) { e.preventDefault(); e.stopPropagation(); tellHost({ type: 'key', cmd }); }
  }, true);
  window.addEventListener('pointerdown', () => tellHost({ type: 'focus' }), true);
}
// close the app: its own window, or its tab when embedded
export function closeApp() { if (EMBED) tellHost({ type: 'close' }); else api('win:control', 'close'); }
