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
  });
}
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
