// Clipboard history (Ctrl+Shift+V): files and folders you copied or cut in Atlas, and paths / text you copied
// anywhere. Private by default: only paths are kept, nothing is kept after Atlas closes unless you ask for it,
// and anything a password manager marks as private is never recorded. Settings > Privacy.
import { api, state, bus, h, esc, toast, basename, onMain, fmtDate, saveSettings } from './core.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';
import { activeTab, navigate } from './pane.js';
import * as A from './actions.js';

let items = [];
const mode = () => state.settings.clipHistory || 'paths'; // off | paths | all
const MAX = 60;
function save() { if (state.settings.clipRemember) api('store:set', 'cliphistory', items.filter((x) => !x.secret).slice(0, MAX)); }
export function add(entry) {
  if (mode() === 'off') return;
  const key = entry.kind === 'files' ? 'f:' + entry.paths.join('|') + (entry.cut ? ':cut' : '') : 't:' + entry.text;
  items = [{ ...entry, key, at: Date.now(), pinned: items.find((x) => x.key === key)?.pinned }, ...items.filter((x) => x.key !== key)];
  const pinned = items.filter((x) => x.pinned), rest = items.filter((x) => !x.pinned);
  items = [...pinned, ...rest].slice(0, MAX + pinned.length);
  save();
}
export async function init() {
  if (state.settings.clipRemember) items = (await api('store:get', 'cliphistory').catch(() => null)) || [];
  api('clip:watch', mode());
}
onMain('clip:changed', (x) => add({ kind: x.isPath ? 'paths' : 'text', text: x.text, paths: x.isPath ? x.text.split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean) : null }));
bus.on('copied', ({ paths, cut }) => add({ kind: 'files', paths, cut }));
bus.on('settings', () => api('clip:watch', mode()));
setTimeout(init, 1500);

export async function showHistory() {
  if (mode() === 'off') {
    const ok = await modal({ title: 'Clipboard history is off', width: 460, body: h('p', {}, 'Turn it on to see the files, folders and paths you copied recently. It stays on this PC.'), buttons: [{ label: 'Not now', value: null }, { label: 'Turn on (paths only)', primary: true, value: true }] });
    if (!ok) return;
    state.settings.clipHistory = 'paths'; saveSettings(); bus.emit('settings');
  }
  const list = h('div', { class: 'ch-list', role: 'listbox' });
  let sel = 0;
  const q = h('input', { class: 'input', placeholder: 'Filter…', spellcheck: 'false' });
  const shown = () => { const s = q.value.trim().toLowerCase(); return items.filter((x) => !s || (x.text || x.paths?.join(' ') || '').toLowerCase().includes(s)); };
  const use = async (x, paste) => {
    closeIt();
    if (x.kind === 'files' || x.kind === 'paths') {
      const paths = x.paths || [];
      state.clipboard = { paths, cut: !!x.cut, at: Date.now() };
      await api('clip:writeFiles', paths, !!x.cut).catch(() => {});
      if (paste) A.paste(activeTab()); else toast(`Ready to paste ${paths.length} item${paths.length === 1 ? '' : 's'}`);
    } else { await api('clip:writeText', x.text); toast('Copied to the clipboard'); }
  };
  const draw = () => {
    const arr = shown();
    sel = Math.min(sel, Math.max(0, arr.length - 1));
    list.innerHTML = '';
    if (!arr.length) list.append(h('div', { class: 'hint pad' }, items.length ? 'Nothing matches.' : 'Nothing yet. Copy or cut files in Atlas, or copy a path anywhere.'));
    arr.forEach((x, i) => {
      const isFiles = x.kind === 'files' || x.kind === 'paths';
      const title = isFiles ? (x.paths.length === 1 ? basename(x.paths[0]) || x.paths[0] : `${x.paths.length} items: ${x.paths.slice(0, 3).map((p) => basename(p)).join(', ')}${x.paths.length > 3 ? '…' : ''}`) : x.text.replace(/\s+/g, ' ').slice(0, 140);
      const row = h('div', { class: 'ch-row' + (i === sel ? ' on' : ''), role: 'option', 'aria-selected': String(i === sel) },
        h('span', { class: 'hi-ic', html: icon(x.kind === 'files' ? (x.cut ? 'cut' : 'copy') : x.kind === 'paths' ? 'link' : 'clipboard') }),
        h('div', { class: 'hi-main' }, h('b', {}, title), h('span', { class: 'hint' }, [isFiles ? (x.cut ? 'cut' : x.kind === 'paths' ? 'path' : 'copied') : 'text', fmtDate(x.at), isFiles && x.paths[0] ? x.paths[0].replace(/[\\/][^\\/]*$/, '') : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'hi-acts' },
          isFiles ? h('button', { class: 'btn small primary', title: 'Paste into the current folder', onclick: (e) => { e.stopPropagation(); use(x, true); } }, 'Paste here') : null,
          isFiles && x.paths.length === 1 ? h('button', { class: 'icon-btn small', title: 'Show in folder', html: icon('folderOpen'), onclick: (e) => { e.stopPropagation(); closeIt(); navigate(activeTab(), x.paths[0].replace(/[\\/][^\\/]*$/, ''), { select: x.paths[0] }); } }) : null,
          h('button', { class: 'icon-btn small' + (x.pinned ? ' on' : ''), title: x.pinned ? 'Unpin' : 'Pin (kept at the top)', html: icon(x.pinned ? 'unpin' : 'pin'), onclick: (e) => { e.stopPropagation(); x.pinned = !x.pinned; save(); draw(); } }),
          h('button', { class: 'icon-btn small', title: 'Remove', html: icon('close'), onclick: (e) => { e.stopPropagation(); items = items.filter((y) => y !== x); save(); draw(); } })));
      row.onclick = () => use(x, false);
      row.ondblclick = () => use(x, isFiles);
      list.append(row);
    });
  };
  q.addEventListener('input', () => { sel = 0; draw(); });
  q.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const arr = shown();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(arr.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (arr[sel]) use(arr[sel], arr[sel].kind !== 'text'); }
  });
  draw();
  let closeIt = () => {};
  const p = modal({ title: 'Clipboard history', width: 640, className: 'ch-modal', body: h('div', { class: 'stack' }, q, list, h('div', { class: 'hint' }, `Keeping: ${{ paths: 'files and paths', all: 'files, paths and text', off: 'nothing' }[mode()]}${state.settings.clipRemember ? ', remembered after Atlas closes' : ', until Atlas closes'}. Change this in Settings > Privacy. Enter pastes, click copies.`)),
    buttons: [{ label: 'Clear', left: true, run: () => { items = items.filter((x) => x.pinned); save(); draw(); return false; } }, { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.ch-modal')?._close?.(null); q.focus(); }, 30);
  return p;
}
