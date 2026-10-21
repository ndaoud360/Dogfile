// Smart collections: virtual folders that gather files by rules (type, size, dates, words in the name, not opened
// for a while, not watched yet) from any folders or drives, without moving anything. They open like a search, so
// everything you can do to files (copy, move, tag, open, delete…) works on them.
import { api, state, bus, h, toast, sys, saveSettings, uid, KINDS, basename } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate } from './pane.js';
import { KIND_FOLDERS } from './organize.js';

const DAY = 86400000;
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const DEFAULT_COLLECTIONS = [
  { id: 'large', name: 'Large files (over 1 GB)', icon: 'drive', where: 'drives', kinds: [], minSize: 1024, sizeUnit: 'MB' },
  { id: 'imgmonth', name: 'Pictures edited this month', icon: 'photos', where: 'personal', kinds: ['Pictures'], modified: 'month' },
  { id: 'installers', name: 'Recently downloaded installers', icon: 'download', where: 'downloads', kinds: ['Installers'], created: 30 },
  { id: 'unwatched', name: 'Videos not watched yet', icon: 'videos', where: 'personal', kinds: ['Videos'], unwatched: true },
];
export const collections = () => (state.settings.collections ||= JSON.parse(JSON.stringify(DEFAULT_COLLECTIONS)));
export const collectionById = (id) => collections().find((c) => c.id === id);

function rootsFor(c) {
  const k = sys.known || {};
  if (c.where === 'downloads') return [k.downloads].filter(Boolean);
  if (c.where === 'drives') return (state.drives || []).filter((d) => !['network', 'optical', 'portable'].includes(d.type)).map((d) => d.path).concat(state.drives?.length ? [] : ['/']);
  if (c.where === 'folders') return (c.folders || []).filter(Boolean);
  return [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music, k.onedrive].filter(Boolean);
}
const kindExts = (names) => {
  const out = new Set();
  for (const n of names) {
    if (n === 'Pictures') KINDS.image.forEach((e) => out.add(e));
    else if (n === 'Videos') [...KINDS.video, 'mkv', 'm2ts', 'mts', 'ts'].forEach((e) => out.add(e));
    else if (n === 'Music') KINDS.audio.forEach((e) => out.add(e));
    else { const f = KIND_FOLDERS.find(([k]) => k === n); if (f) for (const e of ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub', 'fdx', 'fountain', 'xls', 'xlsx', 'csv', 'ods', 'numbers', 'ppt', 'pptx', 'key', 'odp', 'zip', 'rar', '7z', 'gz', 'tar', 'xz', 'bz2', 'iso', 'exe', 'msi', 'msix', 'appx', 'dmg', 'apk', 'msixbundle', 'js', 'ts', 'py', 'cs', 'cpp', 'c', 'h', 'java', 'go', 'rs', 'json', 'html', 'css', 'sh', 'ps1', 'bat', 'xml', 'yml', 'yaml', 'ttf', 'otf', 'woff', 'woff2', 'psd', 'ai', 'fig', 'sketch', 'xd', 'svg', 'blend', 'indd', 'obj', 'fbx', 'stl', 'glb', 'gltf', '3mf', 'ply', 'torrent'].filter((e) => f[1](e))) out.add(e); }
  }
  return [...out];
};
const SU = { KB: 1024, MB: 1048576, GB: 1073741824 };
export function collectionSpec(c) {
  const now = Date.now();
  const exts = [...kindExts(c.kinds || []), ...String(c.exts || '').split(/[\s,;]+/).map((e) => e.replace(/^\*?\./, '').toLowerCase()).filter(Boolean)];
  return {
    type: 'search', roots: rootsFor(c), query: '', kind: 'file', extensions: exts.join(','), recursive: true, includeHidden: false, maxResults: c.max || 5000,
    minSize: c.minSize ? +c.minSize * (SU[c.sizeUnit || 'MB']) : null, maxSize: c.maxSize ? +c.maxSize * (SU[c.sizeUnit || 'MB']) : null,
    after: c.modified === 'month' ? startOfMonth() : c.modified === 'week' ? now - 7 * DAY : +c.modified ? now - +c.modified * DAY : null,
    before: +c.olderThan ? now - +c.olderThan * DAY : null,
    createdAfter: +c.created ? now - +c.created * DAY : null,
    accessedBefore: +c.notOpened ? now - +c.notOpened * DAY : null,
    anyWords: String(c.words || '').split(/[,;]+/).map((w) => w.trim()).filter(Boolean),
    skipDirs: ['node_modules', '.git', '__pycache__', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'],
  };
}
// files filtered after the scan (things the scanner doesn't know)
export async function postFilter(c, items) {
  if (!c.unwatched) return items;
  const w = await api('watched:get').catch(() => ({}));
  const seen = new Set(Object.keys(w).map((p) => p.toLowerCase()));
  for (const p of state.recentFiles || []) seen.add(p.toLowerCase());
  return items.filter((i) => !seen.has(i.path.toLowerCase()));
}
export const collectionUrl = (c) => `atlas:search?coll=${encodeURIComponent(c.id)}`;
export function describeCollection(c) {
  const bits = [];
  if (c.kinds?.length) bits.push(c.kinds.join(', ').toLowerCase());
  else bits.push('files');
  if (c.exts) bits.push(`ending in ${c.exts}`);
  if (c.words) bits.push(`named with “${c.words}”`);
  if (+c.minSize) bits.push(`over ${c.minSize} ${c.sizeUnit || 'MB'}`);
  if (+c.maxSize) bits.push(`under ${c.maxSize} ${c.sizeUnit || 'MB'}`);
  if (c.modified === 'month') bits.push('changed this month'); else if (c.modified === 'week') bits.push('changed this week'); else if (+c.modified) bits.push(`changed in the last ${c.modified} days`);
  if (+c.olderThan) bits.push(`not changed for ${c.olderThan} days`);
  if (+c.created) bits.push(`added in the last ${c.created} days`);
  if (+c.notOpened) bits.push(`not opened for ${c.notOpened} days`);
  if (c.unwatched) bits.push('not played in Dogfile yet');
  bits.push({ downloads: 'in Downloads', drives: 'on all drives', folders: `in ${(c.folders || []).map(basename).join(', ') || 'chosen folders'}`, personal: 'in your personal folders' }[c.where || 'personal']);
  return bits.join(' · ');
}

export async function editCollection(c) {
  const isNew = !c;
  c = c ? JSON.parse(JSON.stringify(c)) : { id: uid(), name: '', icon: 'collection', where: 'personal', kinds: [] };
  const row = (label, ...ctl) => h('div', { class: 'co-row' }, h('label', {}, label), h('div', { class: 'co-ctl' }, ...ctl));
  const txt = (k, ph, w) => { const x = h('input', { class: 'input sm', placeholder: ph, style: w ? { width: w } : { flex: '1' } }); x.value = c[k] ?? ''; x.oninput = () => { c[k] = x.value; upd(); }; x.addEventListener('keydown', (e) => e.stopPropagation()); return x; };
  const num = (k, ph) => { const x = txt(k, ph, '80px'); x.type = 'number'; x.min = '0'; return x; };
  const sel = (k, opts) => { const x = h('select', { class: 'input sm' }, ...opts.map(([v, l]) => h('option', { value: v }, l))); x.value = c[k] ?? opts[0][0]; x.onchange = () => { c[k] = x.value; upd(); draw(); }; return x; };
  const desc = h('div', { class: 'co-desc' });
  const upd = () => { desc.textContent = describeCollection(c); };
  const kinds = h('div', { class: 'co-chips' });
  for (const n of [...KIND_FOLDERS.map(([k]) => k)]) {
    const b = h('button', { class: 'chip' + (c.kinds?.includes(n) ? ' on' : '') }, n);
    b.onclick = () => { c.kinds = c.kinds?.includes(n) ? c.kinds.filter((x) => x !== n) : [...(c.kinds || []), n]; b.classList.toggle('on'); upd(); };
    kinds.append(b);
  }
  const folders = h('div', { class: 'co-folders' });
  const drawFolders = () => {
    folders.innerHTML = '';
    if (c.where !== 'folders') return;
    for (const f of c.folders || []) folders.append(h('span', { class: 'chip on', title: f }, basename(f) || f, h('button', { class: 'link', onclick: () => { c.folders = c.folders.filter((x) => x !== f); drawFolders(); upd(); } }, ' ×')));
    folders.append(h('button', { class: 'chip', onclick: async () => { const d = await api('dialog:pickFolder', 'Add a folder to this collection'); if (d) { c.folders = [...new Set([...(c.folders || []), d])]; drawFolders(); upd(); } } }, '+ Add folder'));
  };
  const watched = h('input', { type: 'checkbox' }); watched.checked = !!c.unwatched; watched.onchange = () => { c.unwatched = watched.checked; upd(); };
  const body = h('div', { class: 'co' });
  const draw = () => {
    body.innerHTML = '';
    body.append(
      row('Name', txt('name', 'e.g. Wedding project')),
      row('Look in', sel('where', [['personal', 'My personal folders'], ['downloads', 'Downloads'], ['drives', 'All drives'], ['folders', 'Folders I choose']]), folders),
      row('Types', kinds),
      row('Extensions', txt('exts', 'optional, e.g. psd, ai')),
      row('Name contains', txt('words', 'any of these words, comma separated (great for a project scattered across drives)')),
      row('Size', h('span', { class: 'hint' }, 'at least'), num('minSize', ''), h('span', { class: 'hint' }, 'at most'), num('maxSize', ''), sel('sizeUnit', [['MB', 'MB'], ['GB', 'GB'], ['KB', 'KB']])),
      row('Changed', sel('modified', [['', 'any time'], ['week', 'this week'], ['month', 'this month'], ['30', 'in the last 30 days'], ['90', 'in the last 90 days'], ['365', 'in the last year']]), h('span', { class: 'hint' }, 'or not changed for'), num('olderThan', 'days'), h('span', { class: 'hint' }, 'days')),
      row('Added', h('span', { class: 'hint' }, 'in the last'), num('created', ''), h('span', { class: 'hint' }, 'days')),
      row('Not opened for', num('notOpened', ''), h('span', { class: 'hint' }, 'days (Windows keeps “last opened” loosely, so this is approximate)')),
      row('', h('label', { class: 'check' }, watched, ' Only videos and songs I haven’t played in Dogfile')),
      desc);
    drawFolders(); upd();
  };
  draw();
  const ok = await modal({ title: isNew ? 'New smart collection' : `Edit “${c.name}”`, body, width: 680, buttons: [
    !isNew && { label: 'Delete', left: true, danger: true, run: async (cl) => { if (await confirm('Delete collection?', 'Only the collection is removed. The files stay where they are.', { ok: 'Delete', danger: true })) { state.settings.collections = collections().filter((x) => x.id !== c.id); saveSettings(); bus.emit('collections'); cl(null); } return false; } },
    { label: 'Cancel', value: null }, { label: isNew ? 'Create' : 'Save', primary: true, value: true }].filter(Boolean) });
  if (!ok) return null;
  if (!c.name.trim()) c.name = describeCollection(c).split(' · ').slice(0, 2).join(' ');
  const list = collections().filter((x) => x.id !== c.id);
  const at = collections().findIndex((x) => x.id === c.id);
  list.splice(at >= 0 ? at : list.length, 0, c);
  state.settings.collections = list;
  // making a collection shows the sidebar's Collections section
  state.settings.sidebarSections = { ...(state.settings.sidebarSections || {}), collections: true };
  saveSettings(); bus.emit('collections');
  navigate(activeTab(), collectionUrl(c));
  return c;
}
export function openCollection(c) { navigate(activeTab(), collectionUrl(c)); }
bus.on('newCollection', () => editCollection(null));
