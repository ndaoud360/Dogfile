// File types: choose what opens each extension inside Dogfile (Dogfile Notepad / Player / Photos, the Windows
// default, or any program), with extra "Open with" choices per type. Windows' own defaults are untouched, and
// "Set the Windows default…" opens Windows' chooser for that type.
import { api, state, bus, h, esc, toast, saveSettings, extname, basename, IS_WIN } from './core.js';
import { modal, prompt } from './dialogs.js';
import { icon } from './icons.js';

export const HANDLERS = [['', 'Dogfile decides (built-in apps first)'], ['notepad', 'Dogfile Notepad'], ['player', 'Dogfile Player'], ['photos', 'Dogfile Photos'], ['windows', 'Windows default app']];
const map = () => (state.settings.fileAssoc ||= {});
export const assocFor = (ext) => map()[(ext || '').toLowerCase()] || null;
export function appLabel(h0) {
  if (!h0) return HANDLERS[0][1];
  const b = HANDLERS.find(([v]) => v === h0); if (b) return b[1];
  if (h0.startsWith('app:')) { const a = (state.settings.openWithApps || []).find((x) => x.command === h0.slice(4)); return a?.name || basename(h0.slice(4)); }
  return h0;
}
// open a file with an explicit choice; returns true when handled
export async function openWith(handler, paths) {
  const { openTool } = await import('./apptabs.js');
  if (handler === 'notepad') return openTool('editor', paths), true;
  if (handler === 'player') return openTool('player', paths, { play: true }), true;
  if (handler === 'photos') return openTool('viewer', paths, { autoPlaylist: paths.length === 1 }), true;
  if (handler === 'windows') { for (const p of paths) await api('shell:open', p); return true; }
  if (handler?.startsWith('app:')) { await api('shell:launch', handler.slice(4), paths); return true; }
  return false;
}
// split files into those with a chosen app (opened now) and the rest
export async function openAssociated(files) {
  const groups = new Map();
  const rest = [];
  for (const f of files) { const a = assocFor(f.ext); if (a?.open) { if (!groups.has(a.open)) groups.set(a.open, []); groups.get(a.open).push(f.path); } else rest.push(f); }
  for (const [hd, paths] of groups) await openWith(hd, paths);
  return rest;
}
export function setAssoc(ext, open) {
  ext = ext.toLowerCase().replace(/^\*?\./, '');
  const m = map();
  m[ext] = { ...(m[ext] || {}), open };
  if (!open && !(m[ext].alts || []).length) delete m[ext];
  saveSettings();
}
export function addAlt(ext, command) { ext = ext.toLowerCase(); const m = map(); m[ext] = { ...(m[ext] || {}), alts: [...new Set([...(m[ext]?.alts || []), command])] }; saveSettings(); }
// "Open with" submenu entries for one file
export function openWithEntries(it) {
  const ext = (it.ext || extname(it.name)).toLowerCase();
  const a = assocFor(ext) || {};
  const apps = state.settings.openWithApps || [];
  const alts = (a.alts || []).map((c) => apps.find((x) => x.command === c) || { name: basename(c), command: c });
  const items = alts.map((x) => ({ label: x.name, icon: 'open', run: () => openWith('app:' + x.command, [it.path]) }));
  const always = [...HANDLERS.slice(1).map(([v, l]) => ({ label: l, radio: true, selected: a.open === v, run: () => { setAssoc(ext, v); toast(`.${ext} files now open with ${l} in Dogfile`); } })),
    ...apps.map((x) => ({ label: x.name, radio: true, selected: a.open === 'app:' + x.command, run: () => { setAssoc(ext, 'app:' + x.command); toast(`.${ext} files now open with ${x.name} in Dogfile`); } })),
    { separator: true }, { label: 'Let Dogfile decide', radio: true, selected: !a.open, run: () => setAssoc(ext, '') },
    { label: 'Choose a program…', icon: 'plus', run: () => pickProgram(ext, true) }];
  return [...items, items.length && { separator: true }, { label: `Always open .${ext || '(no extension)'} files with`, icon: 'pin', submenu: always }, { label: 'Add a program to this list…', icon: 'plus', run: () => pickProgram(ext, false, it) }, IS_WIN() && { label: 'Set the Windows default…', icon: 'monitor', run: () => api('shell:openWith', it.path) }].filter(Boolean);
}
export async function pickProgram(ext, makeDefault, openNow) {
  const f = await api('dialog:openFiles', { title: 'Choose a program', filters: IS_WIN() ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }] : [] });
  if (!f?.[0]) return;
  const command = f[0];
  const name = (await prompt('Name for this program', basename(command).replace(/\.(exe|bat|cmd|lnk)$/i, ''), { label: 'Shown in “Open with”' })) || basename(command);
  state.settings.openWithApps = [...(state.settings.openWithApps || []).filter((x) => x.command !== command), { name, command }];
  if (ext) addAlt(ext, command);
  if (makeDefault && ext) setAssoc(ext, 'app:' + command);
  saveSettings();
  if (openNow) openWith('app:' + command, [openNow.path]);
  toast(makeDefault ? `.${ext} files now open with ${name}` : `${name} added to “Open with”`);
}
export async function fileTypesDialog() {
  const list = h('div', { class: 'ft-list' });
  const draw = () => {
    list.innerHTML = '';
    const m = map();
    const keys = Object.keys(m).sort();
    if (!keys.length) list.append(h('div', { class: 'hint pad' }, 'No custom choices yet: Dogfile opens text in Dogfile Notepad, music and video in Dogfile Player, pictures in Dogfile Photos (if those are on in Settings) and everything else with the Windows default.'));
    for (const ext of keys) {
      const sel = h('select', { class: 'input sm' }, ...HANDLERS.map(([v, l]) => h('option', { value: v }, l)), ...(state.settings.openWithApps || []).map((x) => h('option', { value: 'app:' + x.command }, x.name)));
      sel.value = m[ext].open || '';
      sel.onchange = () => { setAssoc(ext, sel.value); };
      list.append(h('div', { class: 'ft-row' }, h('b', {}, '.' + ext), sel, h('span', { class: 'hint' }, (m[ext].alts || []).length ? `also: ${(m[ext].alts || []).map((c) => appLabel('app:' + c)).join(', ')}` : ''), h('button', { class: 'icon-btn small', title: 'Forget', html: icon('close'), onclick: () => { delete m[ext]; saveSettings(); draw(); } })));
    }
  };
  draw();
  await modal({ title: 'File types', width: 640, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'What opens each kind of file when you open it in Dogfile. Right-click a file > Open with > “Always open … with” also sets this.'), list), buttons: [
    { label: 'Add a file type…', left: true, run: async () => { const e = await prompt('Add a file type', '', { label: 'Extension', placeholder: 'e.g. psd' }); if (!e) return false; setAssoc(e, 'windows'); draw(); return false; } },
    { label: 'Add a program…', left: true, run: async () => { await pickProgram(null, false); draw(); return false; } },
    { label: 'Close', primary: true, value: true }] });
}
bus.on('fileTypes', fileTypesDialog);
