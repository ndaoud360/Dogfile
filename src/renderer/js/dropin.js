// Files dragged from a folder pane onto a built-in app (Notepad, Office, 3D, PSD, Photos, Player). The main window works out
// where the pointer is and tells the app (dragFiles while it moves, dropFiles on release); the app decides what its drop means.
// This file holds what every app shares: which app a file belongs to, the "new tab or replace this one?" question, and the
// pop-up for a file the app can't show (with a way to open it in the app that can, or in its own program).
import { h, basename, extname, openDefault, isTextFile, isImageFile, isMediaFile, isModelFile, isOfficeFile } from './core.js';
import { modal } from './dialogs.js';
import { EMBED, tellHost } from './embed.js';
import { api } from './core.js';

export const APP_NAME = { editor: 'Dogfile Notepad', player: 'Dogfile Player', viewer: 'Dogfile Photos', model: 'Dogfile 3D', office: 'Dogfile Office', psd: 'Dogfile PSD' };
const itemOf = (p) => ({ name: basename(p), ext: extname(basename(p)), isDir: false });

/** which built-in app a file belongs to (the same order a double-click uses), or null when none of them shows it */
export function appFor(path) {
  const it = itemOf(path);
  if (/^(psd|psb)$/.test(it.ext)) return 'psd';
  if (isOfficeFile(it) && !isTextFile(it)) return 'office';
  if (isModelFile(it)) return 'model';
  if (isImageFile(it)) return 'viewer';
  if (isTextFile(it)) return 'editor';
  if (isMediaFile(it)) return 'player';
  return null;
}
/** like appFor, but a file with no (or an unknown) extension is looked inside: a text of any kind belongs to Notepad */
export async function appForDeep(path) {
  const a = appFor(path);
  if (a) return a;
  try {
    const info = await api('file:identify', path);
    if (info?.ext) { const b = appFor('x.' + info.ext); if (b === 'editor') return 'editor'; }
  } catch { /* unreadable: no app */ }
  return null;
}
const KIND_WORD = { psd: 'Photoshop file', office: 'document', model: '3D model', viewer: 'picture', editor: 'text file', player: 'audio or video file' };

/** open files in another built-in app (a new tab of the main window, or its own window) */
export function openElsewhere(kind, files) {
  if (EMBED) tellHost({ type: 'open', kind, files, opts: { newTab: kind === 'office' || kind === 'psd' } });
  else api('tool:open', kind, files, {});
}

/**
 * The pop-up for files this app doesn't show. `bad` = [{ path, app }] (app = the built-in app that does, or null).
 * Each row offers that app and the file's own program ("Open with" is always there, too, in the folder's menu).
 */
export async function unsupportedDialog(self, bad) {
  if (!bad.length) return;
  const name = APP_NAME[self];
  const rows = bad.slice(0, 8).map(({ path, app }) => {
    const btns = [];
    let close = () => {};
    if (app) btns.push(h('button', { class: 'btn small primary', onclick: () => { openElsewhere(app, [path]); close(); } }, `Open in ${APP_NAME[app]}`));
    btns.push(h('button', { class: 'btn small', onclick: () => { openDefault(path); close(); } }, 'Open with its own program'));
    const row = h('div', { class: 'di-row' }, h('div', { class: 'di-name', title: path }, basename(path)), h('div', { class: 'di-sub' }, app ? `This is a ${KIND_WORD[app]}.` : 'No built-in app shows this kind of file.'), h('div', { class: 'di-btns' }, ...btns));
    row._setClose = (c) => { close = c; };
    return row;
  });
  const body = h('div', { class: 'stack' },
    h('div', {}, bad.length === 1 ? `${name} can’t open “${basename(bad[0].path)}”.` : `${name} can’t open these ${bad.length} files.`),
    ...rows, bad.length > 8 ? h('div', { class: 'hint' }, `…and ${bad.length - 8} more.`) : null,
    h('div', { class: 'hint' }, 'You can also right-click a file in the folder and choose Open with.'));
  const p = modal({ title: 'Can’t open here', body, width: 460, className: 'di-modal', buttons: [{ label: 'OK', primary: true, value: null }] });
  // the buttons close the pop-up they sit in
  setTimeout(() => { const close = () => document.querySelector('.di-modal .modal-foot .btn')?.click(); rows.forEach((r) => r._setClose(close)); }, 0);
  await p;
}

/** a document is open here and another is dropped: 'new' (another tab), 'replace' (this tab's file goes), or null (cancel) */
export async function askNewOrReplace(self, droppedName, currentName) {
  return modal({
    title: `Open “${droppedName}”`, width: 460,
    body: h('div', { class: 'stack' }, h('div', {}, `${APP_NAME[self]} already has “${currentName}” open.`), h('div', { class: 'hint' }, 'Replace it with the new file, or open the new file in its own tab? If you replace it and it has unsaved changes, you’ll be asked to save first.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Replace this one', value: 'replace' }, { label: 'Open in a new tab', primary: true, value: 'new' }],
  });
}

/** Save / Don't save / Cancel before a tab's file is replaced. `save` does the saving and answers whether it worked. */
export async function askSaveBeforeReplace(self, name, save) {
  const v = await modal({
    title: 'Save your changes?', width: 440, closeOnBackdrop: false,
    body: h('div', {}, `“${name}” has changes that aren’t saved. Save them before it is replaced?`),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Don’t save', value: 'discard' }, { label: 'Save', primary: true, value: 'save' }],
  });
  if (v === 'discard') return true;
  if (v === 'save') return !!(await save());
  return false;
}
