// Power tools: search (name/regex/wildcards/content/size/date + Everything integration), compare folders,
// duplicate finder, storage analyzer, workspaces, and the operations "status center".
import { api, state, sys, bus, h, esc, fmtSize, fmtDate, basename, dirname, isVirtual, samePath, toast, IS_WIN, natCmp, saveLibrary, extname } from './core.js';
import { icon } from './icons.js';
import { activeTab, navigate, openTab, paneTab, paneCount, recompute, renderTabPanes, setLayout, showTabInPane, newTabState, focusPane, otherPaneTab, selectedItems } from './pane.js';
import { modal, prompt, confirm, conflictDialog } from './dialogs.js';
import * as A from './actions.js';
import { showMenu } from './menu.js';
import { runAiSearch, looksLikeAiQuery } from './ai.js';
bus.on('aiWorkStarted', ({ id, onMsg }) => onWorkMsgFor(id, onMsg));
bus.on('aiSearchUpdate', (t) => { recompute(t); renderTabPanes(t); bus.emit('status'); });

// ======================================================================
// Search
// ======================================================================
// (work-message routing lives in core.js so every module shares the early-message buffer)
import { onWorkMsgFor, onWorkMsg, offWorkMsg } from './core.js';
import { requirePro, isPro } from './license.js';
export { onWorkMsgFor, onWorkMsg };
// job messages by id (the router lives in core.js; early messages are kept until a listener is set)
const workHandlers = { set: (id, fn) => onWorkMsgFor(id, fn), delete: (id) => offWorkMsg(id) };

export function searchUrl(o) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) q.set(k, v === true ? '1' : v);
  return 'atlas:search?' + q.toString();
}

export async function runSearch(t) {
  if (t.searchJob) api('work:cancel', t.searchJob);
  const q = new URLSearchParams(t.path.split('?')[1] || '');
  const roots = (q.get('root') || '').split('|').filter(Boolean);
  if (q.get('ai') === '1') {
    // AI search: no folder means your personal folders (Pictures, Videos, Music, Desktop, Documents, Downloads)
    const k = sys.known || {};
    const r = roots.length ? roots : [k.pictures, k.videos, k.music, k.desktop, k.documents, k.downloads, k.onedrive].filter(Boolean);
    t.items = [];
    runAiSearch(t, q.get('q') || '', [...new Set(r)]).catch((e) => { t.searchInfo = { running: false, text: `AI search failed: ${e.message}` }; bus.emit('aiSearchUpdate', t); });
    return;
  }
  if (q.get('coll')) return runCollection(t, q.get('coll'));
  if (q.get('assist')) { const { results } = await import('./assistant.js'); const r = results.get(q.get('assist')); t.items = r?.items || []; t.searchInfo = { running: false, text: r ? `${t.items.length.toLocaleString()} files from the assistant · ${fmtSize(t.items.reduce((a, i) => a + (i.size || 0), 0))}` : 'These results are gone (Dogfile was restarted). Ask the assistant again.' }; recompute(t); renderTabPanes(t); return; }
  const scopeAll = q.get('scope') === 'all';
  if (scopeAll || !roots.length) { const ds = state.drives.length ? state.drives : await A.refreshDrives(); roots.splice(0, roots.length, ...ds.filter((d) => d.type !== 'network' && d.type !== 'optical').map((d) => d.path)); }
  t.items = [];
  const started = Date.now();
  t.searchInfo = { running: true, text: 'Searching…' };
  // Everything (voidtools) – instant whole-disk search if installed
  if (q.get('every') === '1' || (state.settings.useEverything && !q.get('content'))) {
    const lines = await api('everything:search', [q.get('q') || '', q.get('ext') ? `ext:${q.get('ext').replace(/[ ,]+/g, ';')}` : ''].join(' ').trim(), 5000, scopeAll ? null : roots[0]);
    if (lines) {
      const st = await api('fs:statMany', lines.slice(0, 5000));
      t.items = st.filter(Boolean);
      t.searchInfo = { running: false, text: `${t.items.length.toLocaleString()} results · Everything · ${((Date.now() - started) / 1000).toFixed(2)}s` };
      recompute(t); renderTabPanes(t);
      return;
    }
  }
  const spec = {
    type: 'search', roots, query: q.get('q') || '', regex: q.get('regex') === '1', caseSensitive: q.get('cs') === '1',
    content: q.get('content') || '', contentRegex: q.get('cre') === '1', kind: q.get('kind') || 'any', extensions: q.get('ext') || '',
    minSize: q.get('min') ? +q.get('min') : null, maxSize: q.get('max') ? +q.get('max') : null,
    after: q.get('after') ? Date.parse(q.get('after')) : null, before: q.get('before') ? Date.parse(q.get('before')) + 86400000 : null,
    includeHidden: q.get('hidden') === '1' || state.settings.showHidden, recursive: q.get('flat') !== '1', maxResults: 50000,
    skipDirs: q.get('nodev') === '0' ? [] : ['node_modules', '.git', '__pycache__', '.venv'],
  };
  const id = await api('work:start', spec);
  t.searchJob = id;
  let pending = false;
  const flush = () => { pending = false; recompute(t); renderTabPanes(t); bus.emit('status'); };
  workHandlers.set(id, (m) => {
    if (m.type === 'results') {
      t.items.push(...m.items);
      t.searchInfo = { running: true, text: `${t.items.length.toLocaleString()} found · ${m.scanned.toLocaleString()} scanned` };
      if (!pending) { pending = true; setTimeout(flush, 250); }
    } else if (m.type === 'done' || m.type === 'error') {
      workHandlers.delete(id); t.searchJob = null;
      t.searchInfo = { running: false, text: m.type === 'error' ? `Error: ${m.error}` : m.indexed ? `${(m.total ?? t.items.length).toLocaleString()} results${m.total > t.items.length ? ` (showing ${t.items.length.toLocaleString()})` : ''} · instant index · ${((Date.now() - started) / 1000).toFixed(2)}s` : `${t.items.length.toLocaleString()} results · ${(m.scanned || 0).toLocaleString()} items scanned in ${((Date.now() - started) / 1000).toFixed(1)}s` };
      flush();
    }
  });
}

// Stop button next to the search status: AI search keeps what it found so far; a normal search stops scanning
bus.on('stopSearch', (t) => {
  if (t._aiStop) { t._aiStop(); return; }
  if (t.searchJob) {
    const id = t.searchJob; api('work:cancel', id); workHandlers.delete(id); t.searchJob = null;
    t.searchInfo = { running: false, text: `Stopped · ${t.items.length.toLocaleString()} results` };
    recompute(t); renderTabPanes(t); bus.emit('status');
  }
});

// Smart collection: a saved search with rules (collections.js)
async function runCollection(t, id) {
  const C = await import('./collections.js');
  const c = C.collectionById(id);
  t.items = [];
  if (!c) { t.searchInfo = { running: false, text: 'This collection was deleted' }; recompute(t); renderTabPanes(t); return; }
  if (!state.drives?.length && c.where === 'drives') await A.refreshDrives();
  const started = Date.now();
  t.searchInfo = { running: true, text: `Collecting… ${C.describeCollection(c)}` };
  await C.prepareCollection?.(c);
  const id2 = await api('work:start', C.collectionSpec(c));
  t.searchJob = id2;
  let pending = false;
  const raw = [];
  const myPath = t.path;
  const flush = async () => { pending = false; const items = await C.postFilter(c, raw.slice()); if (t.path !== myPath) return; t.items = items; recompute(t); renderTabPanes(t); bus.emit('status'); };
  workHandlers.set(id2, (m) => {
    if (m.type === 'results') {
      raw.push(...m.items);
      t.searchInfo = { running: true, text: `${raw.length.toLocaleString()} found · ${m.scanned.toLocaleString()} looked at` };
      if (!pending) { pending = true; setTimeout(flush, 300); }
    } else if (m.type === 'done' || m.type === 'error') {
      workHandlers.delete(id2); t.searchJob = null;
      flush().then(() => {
        const total = t.items.reduce((a, i) => a + (i.size || 0), 0);
        t.searchInfo = { running: false, text: m.type === 'error' ? `Error: ${m.error}` : `${t.items.length.toLocaleString()} files · ${fmtSize(total)} · ${C.describeCollection(c)} · ${((Date.now() - started) / 1000).toFixed(1)}s` };
        renderTabPanes(t); bus.emit('status');
      });
    }
  });
}

export function searchHere(t, query) {
  const root = !t.path || isVirtual(t.path) ? (t.path?.startsWith('atlas:search') ? new URLSearchParams(t.path.split('?')[1]).get('root') : '') : t.path;
  const ai = aiMode === 'on' || (aiMode === 'auto' && state.settings.aiSearch !== false && looksLikeAiQuery(query));
  navigate(t, searchUrl({ q: query, root, scope: root ? '' : 'all', ai }));
}
let aiMode = 'auto'; // auto: natural-language searches use AI; on / off from the search bar toggle

let searchBox = null;
export function openSearchBar() {
  const host = document.getElementById('search-host');
  const t = activeTab();
  if (searchBox) { searchBox.querySelector('input').focus(); searchBox.querySelector('input').select(); return; }
  const prev = t.path?.startsWith('atlas:search') ? new URLSearchParams(t.path.split('?')[1]) : null;
  const scopeName = !isVirtual(t.path) ? basename(t.path) || t.path : prev?.get('root') ? basename(prev.get('root').split('|')[0]) : 'everywhere';
  const input = h('input', { class: 'search-input', placeholder: `Search ${scopeName}`, spellcheck: 'false', value: prev?.get('q') || '' });
  const adv = h('button', { class: 'icon-btn', title: 'Advanced search (filters, content, size, date…)', html: icon('filter') });
  aiMode = prev?.get('ai') === '1' ? 'on' : 'auto';
  const aiBtn = h('button', { class: 'ai-toggle', title: 'AI search: describe what is in the picture, video or song. Auto turns on for sentences like “photos of a dog on grass”.' });
  const drawAi = () => { aiBtn.textContent = aiMode === 'on' ? 'AI on' : aiMode === 'off' ? 'AI off' : 'AI auto'; aiBtn.classList.toggle('on', aiMode === 'on'); input.placeholder = aiMode === 'on' ? 'Describe it: photos of a dog running on grass…' : `Search ${scopeName}`; };
  aiBtn.addEventListener('mousedown', (e) => e.preventDefault());
  aiBtn.addEventListener('click', () => { aiMode = { auto: 'on', on: 'off', off: 'auto' }[aiMode]; drawAi(); input.focus(); });
  searchBox = h('div', { class: 'search-bar' }, h('span', { class: 'si', html: icon('search') }), input, aiBtn, adv);
  drawAi();
  host.append(searchBox);
  host.classList.add('open');
  input.focus();
  const close = () => { searchBox?.remove(); searchBox = null; host.classList.remove('open'); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.value.trim()) { searchHere(t, input.value.trim()); }
    if (e.key === 'Escape') { close(); document.querySelector('.pane.active .pane-body')?.focus(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (searchBox && !searchBox.contains(document.activeElement) && !input.value) close(); }, 200));
  adv.addEventListener('click', () => { close(); advancedSearch(input.value); });
}

export async function advancedSearch(initial = '') {
  const t = activeTab();
  const prev = t.path?.startsWith('atlas:search') ? new URLSearchParams(t.path.split('?')[1]) : new URLSearchParams();
  const root = !isVirtual(t.path) ? t.path : prev.get('root') || '';
  const everyAvail = await api('everything:available');
  const f = {
    q: h('input', { class: 'input', value: initial || prev.get('q') || '', placeholder: 'Name: words, *.wildcards or regex' }),
    regex: h('input', { type: 'checkbox' }), cs: h('input', { type: 'checkbox' }),
    content: h('input', { class: 'input', value: prev.get('content') || '', placeholder: 'Text inside files (optional)' }), cre: h('input', { type: 'checkbox' }),
    scope: h('select', { class: 'input' }, h('option', { value: 'here' }, root ? `This folder (${basename(root) || root})` : 'Current folder'), h('option', { value: 'all' }, IS_WIN() ? 'All drives' : 'Everywhere'), h('option', { value: 'flat' }, 'This folder only (no subfolders)')),
    kind: h('select', { class: 'input' }, h('option', { value: 'any' }, 'Files and folders'), h('option', { value: 'file' }, 'Files only'), h('option', { value: 'dir' }, 'Folders only')),
    ext: h('input', { class: 'input', value: prev.get('ext') || '', placeholder: 'Extensions e.g. jpg, png, psd' }),
    min: h('input', { class: 'input', type: 'number', placeholder: 'Min MB' }), max: h('input', { class: 'input', type: 'number', placeholder: 'Max MB' }),
    after: h('input', { class: 'input', type: 'date' }), before: h('input', { class: 'input', type: 'date' }),
    hidden: h('input', { type: 'checkbox' }), nodev: h('input', { type: 'checkbox', checked: true }), every: h('input', { type: 'checkbox', disabled: !everyAvail }),
  };
  f.regex.checked = prev.get('regex') === '1'; f.cs.checked = prev.get('cs') === '1';
  const presets = h('div', { class: 'chips' }, ...[
    ['Images', 'jpg,jpeg,png,gif,webp,heic,bmp,tif'], ['Videos', 'mp4,mkv,mov,avi,webm'], ['Music', 'mp3,flac,wav,m4a,ogg'], ['Documents', 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md'], ['Archives', 'zip,7z,rar,tar,gz'], ['Code', 'js,ts,py,cs,cpp,java,go,rs'],
  ].map(([l, e]) => h('button', { class: 'chip', onclick: () => { f.ext.value = e; } }, l)), h('button', { class: 'chip', onclick: () => { f.min.value = 500; } }, 'Large (>500 MB)'), h('button', { class: 'chip', onclick: () => { const d = new Date(Date.now() - 7 * 864e5); f.after.value = d.toISOString().slice(0, 10); } }, 'Last 7 days'));
  const row = (...c) => h('div', { class: 'row2' }, ...c);
  const body = h('div', { class: 'stack' }, f.q,
    h('div', { class: 'row-inline' }, h('label', { class: 'check' }, f.regex, ' Regex'), h('label', { class: 'check' }, f.cs, ' Match case'), h('label', { class: 'check' }, f.hidden, ' Include hidden'), h('label', { class: 'check' }, f.nodev, ' Skip node_modules/.git')),
    f.content, h('label', { class: 'check' }, f.cre, ' Content is a regex'),
    row(f.scope, f.kind), f.ext, presets, row(f.min, f.max), row(h('label', { class: 'field-label' }, 'Modified after', f.after), h('label', { class: 'field-label' }, 'Modified before', f.before)),
    h('label', { class: 'check' }, f.every, everyAvail ? ' Use Everything for instant results' : ' Use Everything (install voidtools Everything + es.exe to enable)'));
  const r = await modal({ title: 'Search', body, width: 560, buttons: [{ label: 'Cancel', value: null }, { label: 'Search', primary: true, value: true }] });
  if (!r) return;
  const MB = 1024 * 1024;
  navigate(t, searchUrl({
    q: f.q.value.trim(), regex: f.regex.checked, cs: f.cs.checked, content: f.content.value, cre: f.cre.checked,
    root: f.scope.value === 'all' ? '' : root, scope: f.scope.value === 'all' || !root ? 'all' : '', flat: f.scope.value === 'flat',
    kind: f.kind.value === 'any' ? '' : f.kind.value, ext: f.ext.value.trim(), min: f.min.value ? Math.round(+f.min.value * MB) : '', max: f.max.value ? Math.round(+f.max.value * MB) : '',
    after: f.after.value, before: f.before.value, hidden: f.hidden.checked, nodev: f.nodev.checked ? '' : '0', every: f.every.checked,
  }));
}

// ======================================================================
// Compare folders (two panes)
// ======================================================================
export async function compareFolders() {
  if (!requirePro('compare')) return;
  // remember the layout so closing the dialog puts it back (unless you chose to look at the differences)
  const restoreLayout = paneCount() < 2 ? state.layout : null;
  if (restoreLayout) setLayout('2v');
  let keepSplit = false;
  // a freshly opened second pane resolves its folder asynchronously: wait for it
  for (let i = 0; i < 80 && !(paneTab(1)?.path); i++) await new Promise((r) => setTimeout(r, 25));
  const a = paneTab(0), b = paneTab(1);
  if (!a || !b || isVirtual(a.path) || isVirtual(b.path)) { if (restoreLayout) setLayout(restoreLayout); return toast('Show a folder in each of the first two panes'); }
  const [la, lb] = await Promise.all([api('fs:list', a.path), api('fs:list', b.path)]);
  const key = (n) => (IS_WIN() ? n.toLowerCase() : n);
  const mb = new Map(lb.items.map((i) => [key(i.name), i]));
  const ma = new Map(la.items.map((i) => [key(i.name), i]));
  const rows = [];
  for (const i of la.items) {
    const o = mb.get(key(i.name));
    if (!o) rows.push({ name: i.name, state: 'left', a: i });
    else if (i.isDir !== o.isDir) rows.push({ name: i.name, state: 'type', a: i, b: o });
    else if (!i.isDir && (i.size !== o.size || Math.abs(i.mtime - o.mtime) > 2000)) rows.push({ name: i.name, state: i.mtime > o.mtime ? 'newerL' : 'newerR', a: i, b: o });
    else rows.push({ name: i.name, state: 'same', a: i, b: o });
  }
  for (const i of lb.items) if (!ma.has(key(i.name))) rows.push({ name: i.name, state: 'right', b: i });
  rows.sort((x, y) => natCmp(x.name, y.name));
  const labels = { left: '← only left', right: 'only right →', newerL: '← newer', newerR: 'newer →', type: 'type differs', same: 'identical' };
  const showSame = h('input', { type: 'checkbox' });
  const table = h('div', { class: 'cmp-table' });
  const draw = () => {
    table.innerHTML = `<div class="cmp-row head"><div>${esc(basename(a.path))}</div><div></div><div>${esc(basename(b.path))}</div></div>` +
      rows.filter((r) => showSame.checked || r.state !== 'same').map((r) => `<div class="cmp-row s-${r.state}"><div>${r.a ? `${esc(r.a.name)}<span class="hint"> ${r.a.isDir ? '' : fmtSize(r.a.size)} · ${fmtDate(r.a.mtime, 'iso')}</span>` : ''}</div><div class="cmp-state">${labels[r.state]}</div><div>${r.b ? `${esc(r.b.name)}<span class="hint"> ${r.b.isDir ? '' : fmtSize(r.b.size)} · ${fmtDate(r.b.mtime, 'iso')}</span>` : ''}</div></div>`).join('');
  };
  showSame.addEventListener('change', draw);
  draw();
  const counts = rows.reduce((o, r) => ((o[r.state] = (o[r.state] || 0) + 1), o), {});
  const sync = async (dir) => {
    const toB = rows.filter((r) => r.state === 'left' || r.state === 'newerL').map((r) => r.a.path);
    const toA = rows.filter((r) => r.state === 'right' || r.state === 'newerR').map((r) => r.b.path);
    if (dir !== 'ltr' && toA.length) await A.transfer(toA, a.path, 'copy', { conflict: 'replace' });
    if (dir !== 'rtl' && toB.length) await A.transfer(toB, b.path, 'copy', { conflict: 'replace' });
    toast('Sync complete');
  };
  await modal({
    title: 'Compare folders', width: 860,
    body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `${counts.left || 0} only left · ${counts.right || 0} only right · ${(counts.newerL || 0) + (counts.newerR || 0)} different · ${counts.same || 0} identical`), h('label', { class: 'check' }, showSame, ' Show identical'), table),
    buttons: [
      { label: 'Select differences in panes', left: true, run: (c) => {
        a.sel = new Set(rows.filter((r) => r.a && r.state !== 'same').map((r) => r.a.path)); b.sel = new Set(rows.filter((r) => r.b && r.state !== 'same').map((r) => r.b.path));
        renderTabPanes(a, true); renderTabPanes(b, true); keepSplit = true; c(true);
      } },
      { label: 'Mirror left → right', run: async (c) => { if (await confirm('Sync', 'Copy missing and newer files from the left folder to the right folder?')) { c(true); sync('ltr'); } return false; } },
      { label: 'Mirror right → left', run: async (c) => { if (await confirm('Sync', 'Copy missing and newer files from the right folder to the left folder?')) { c(true); sync('rtl'); } return false; } },
      { label: 'Two-way sync', primary: true, run: async (c) => { if (await confirm('Two-way sync', 'Copy missing and newer files in both directions?')) { c(true); sync('both'); } return false; } },
    ],
  });
  if (restoreLayout && !keepSplit) setLayout(restoreLayout);
}

// ======================================================================
// Duplicate finder
// ======================================================================
export async function findDuplicates() {
  if (!requirePro('dupes')) return;
  const t = activeTab();
  if (isVirtual(t.path)) return toast('Open a folder first');
  const status = h('div', { class: 'hint' }, 'Scanning…');
  const list = h('div', { class: 'dupe-list' });
  let groups = [];
  const id = await api('work:start', { type: 'dupes', roots: [t.path], minSize: 1024 });
  const done = new Promise((res) => workHandlers.set(id, (m) => {
    if (m.type === 'progress') status.textContent = `${m.phase}… ${m.scanned?.toLocaleString() || ''}${m.of ? ' / ' + m.of.toLocaleString() : ''}${m.groups ? ` · ${m.groups} groups` : ''}`;
    else { workHandlers.delete(id); groups = m.groups || []; res(); }
  }));
  const draw = () => {
    const wasted = groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
    status.textContent = `${groups.length} duplicate groups · ${fmtSize(wasted)} reclaimable`;
    list.innerHTML = groups.slice(0, 500).map((g, gi) => `<div class="dupe-group"><div class="dg-head">${fmtSize(g.size)} × ${g.files.length}</div>${g.files.map((f, fi) => `<label class="dg-file"><input type="checkbox" data-g="${gi}" data-f="${fi}" ${fi > 0 ? 'checked' : ''}> <span>${esc(f.path)}</span><span class="hint">${fmtDate(f.mtime, 'iso')}</span></label>`).join('')}</div>`).join('');
  };
  done.then(draw);
  await modal({
    title: `Duplicates in ${basename(t.path)}`, width: 820, body: h('div', { class: 'stack' }, status, list),
    onClose: () => api('work:cancel', id),
    buttons: [
      { label: 'Keep newest in each group', left: true, run: () => { list.querySelectorAll('input').forEach((c) => { const g = groups[c.dataset.g]; const newest = g.files.reduce((a, b) => (b.mtime > a.mtime ? b : a)); c.checked = g.files[c.dataset.f] !== newest; }); return false; } },
      { label: 'Close', value: null },
      { label: 'Recycle checked', primary: true, danger: true, run: async (c) => {
        const paths = [...list.querySelectorAll('input:checked')].map((x) => groups[x.dataset.g].files[x.dataset.f].path);
        if (!paths.length) return false;
        if (!(await confirm('Recycle duplicates?', `Move ${paths.length} files to the Recycle Bin?`))) return false;
        await A.runJob({ type: 'trash', sources: paths });
        c(true);
      } },
    ],
  });
}

// perceptual hash (dHash + average colour) of pictures, grouped into sets of near-identical ones
export async function similarImageGroups(files, { onProgress, cancelled = () => false } = {}) {
  let groups = [];
  const hashes = [];
  const c = document.createElement('canvas'); c.width = 9; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  const load = (src) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  const work = (async () => {
    for (let i = 0; i < files.length && !cancelled(); i++) {
      const f = files[i];
      if (i % 10 === 0) onProgress?.(i, files.length);
      let src = IS_WIN() ? await api('thumb:get', f.path, 96).catch(() => null) : null;
      if (!src) src = /\.(jpe?g|jfif|png|webp|bmp|gif|avif)$/i.test(f.path) ? `/f/?p=${encodeURIComponent(f.path)}` : `/media/thumb?p=${encodeURIComponent(f.path)}&w=96`;
      const im = await load(src);
      if (!im) continue;
      g.drawImage(im, 0, 0, 9, 8);
      const d = g.getImageData(0, 0, 9, 8).data;
      let hi = 0, lo = 0, cr = 0, cg = 0, cb = 0;
      for (let k2 = 0; k2 < d.length; k2 += 4) { cr += d[k2]; cg += d[k2 + 1]; cb += d[k2 + 2]; }
      const px = d.length / 4;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = (y * 9 + x) * 4, q = p + 4;
        const a = d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11, b = d[q] * 0.3 + d[q + 1] * 0.59 + d[q + 2] * 0.11;
        const bit = a > b ? 1 : 0, k = y * 8 + x;
        if (k < 32) hi = (hi | (bit << k)) >>> 0; else lo = (lo | (bit << (k - 32))) >>> 0;
      }
      hashes.push({ f, hi, lo, w: im.naturalWidth, h: im.naturalHeight, col: [cr / px, cg / px, cb / px] });
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
    // compare each picture with each group's first picture (no chaining), on shape AND colour
    const sets = [];
    const near = (a, b) => pop(a.hi ^ b.hi) + pop(a.lo ^ b.lo) <= 5 && Math.hypot(a.col[0] - b.col[0], a.col[1] - b.col[1], a.col[2] - b.col[2]) < 24;
    for (const x of hashes) { const s2 = sets.find((gg) => near(gg[0], x)); if (s2) s2.push(x); else sets.push([x]); }
    groups = sets.filter((gg) => gg.length > 1).map((gg) => gg.sort((a, b) => b.w * b.h - a.w * a.h || (b.f.size || 0) - (a.f.size || 0)));
    return groups;
  })();
  return work;
}

// Similar pictures: perceptual hashes (dHash) find the same photo at different sizes, crops of quality or formats
export async function findSimilarImages() {
  if (!requirePro('dupes')) return;
  const t = activeTab();
  if (isVirtual(t.path)) return toast('Open a folder first');
  const status = h('div', { class: 'hint' }, 'Finding pictures…');
  const list = h('div', { class: 'dupe-list' });
  let cancelled = false, groups = [];
  const files = await new Promise(async (resolve) => {
    const found = [];
    const id = await api('work:start', { type: 'search', roots: [t.path], query: '', kind: 'file', extensions: 'jpg,jpeg,jfif,png,webp,bmp,gif,heic,avif,tif,tiff', recursive: true, maxResults: 20000, skipDirs: ['node_modules', '.git'] });
    workHandlers.set(id, (m) => { if (m.type === 'results') found.push(...m.items); else if (m.type === 'done' || m.type === 'error') { workHandlers.delete(id); resolve(found); } });
  });
  const work = (async () => {
    groups = await similarImageGroups(files, { onProgress: (i, n) => { status.textContent = `Looking at pictures… ${i.toLocaleString()} of ${n.toLocaleString()}`; }, cancelled: () => cancelled });
    const wasted = groups.reduce((a, gg) => a + gg.slice(1).reduce((s2, x) => s2 + (x.f.size || 0), 0), 0);
    status.textContent = groups.length ? `${groups.length} sets of similar pictures · ${fmtSize(wasted)} could be freed. The best copy (largest) is kept unticked.` : 'No similar pictures found.';
    list.innerHTML = groups.slice(0, 300).map((gg, gi) => `<div class="dupe-group sim"><div class="dg-head">${gg.length} similar</div><div class="sim-row">${gg.map((x, fi) => `<label class="sim-card" title="${esc(x.f.path)}"><img src="/f/?p=${encodeURIComponent(x.f.path)}" loading="lazy" alt=""><span><input type="checkbox" data-g="${gi}" data-f="${fi}" ${fi > 0 ? 'checked' : ''}> ${x.w}×${x.h} · ${fmtSize(x.f.size || 0)}</span><span class="hint">${esc(x.f.name)}</span></label>`).join('')}</div></div>`).join('');
  })();
  await modal({
    title: `Similar pictures in ${basename(t.path)}`, width: 900, body: h('div', { class: 'stack' }, status, list),
    onClose: () => { cancelled = true; },
    buttons: [
      { label: 'Close', value: null },
      { label: 'Recycle checked', primary: true, danger: true, run: async (cl) => {
        const paths = [...list.querySelectorAll('input:checked')].map((x) => groups[x.dataset.g][x.dataset.f].f.path);
        if (!paths.length) return false;
        if (!(await confirm('Recycle similar pictures?', `Move ${paths.length} pictures to the Recycle Bin?`))) return false;
        await A.runJob({ type: 'trash', sources: paths });
        cl(true);
      } },
    ],
  });
  await work.catch(() => {});
}

// ======================================================================
// Storage analyzer (what's taking up space)
// ======================================================================
export async function analyzeSpace(path) {
  if (!requirePro('space')) return;
  const t = activeTab();
  path = path || (isVirtual(t.path) ? null : t.path);
  if (!path) return toast('Open a folder or drive first');
  const status = h('div', { class: 'hint' }, 'Measuring…');
  const chart = h('div', { class: 'treebars' });
  const map = h('div', { class: 'treemap' });
  let mode = state.settings.analyzerView || 'treemap';
  let last = null;
  const tabs = h('div', { class: 'seg' });
  const setMode = (m) => { mode = m; state.settings.analyzerView = m; tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); chart.style.display = m === 'bars' ? '' : 'none'; map.style.display = m === 'treemap' ? '' : 'none'; if (last) draw(last); };
  for (const [m, l, ic] of [['treemap', 'Treemap', 'treemap'], ['bars', 'Bars', 'chart']]) { const b = h('button', { class: 'seg-btn', 'data-m': m, html: `${icon(ic)}<span>${l}</span>` }); b.onclick = () => setMode(m); tabs.append(b); }
  const hue = (c) => { if (c.isDir) return 215; const e = (c.name.split('.').pop() || '').toLowerCase(); const k = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'raw', 'psd'].includes(e) ? 160 : ['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(e) ? 275 : ['mp3', 'flac', 'wav', 'm4a'].includes(e) ? 330 : ['zip', '7z', 'rar', 'iso', 'gz'].includes(e) ? 40 : ['exe', 'dll', 'msi', 'sys'].includes(e) ? 0 : 190; return k; };
  // squarified treemap layout
  const squarify = (kids, x, y, w, hgt) => {
    const out = [];
    const total = kids.reduce((a, c) => a + c.size, 0);
    if (!total || w <= 0 || hgt <= 0) return out;
    const scale = (w * hgt) / total;
    let items = kids.map((c) => ({ c, a: c.size * scale }));
    const worst = (row, len) => { const s = row.reduce((a, r) => a + r.a, 0); let mx = 0; for (const r of row) { const v = Math.max((len * len * r.a) / (s * s), (s * s) / (len * len * r.a)); if (v > mx) mx = v; } return mx; };
    while (items.length) {
      const len = Math.min(w, hgt);
      let row = [items[0]], i = 1;
      while (i < items.length && worst([...row, items[i]], len) <= worst(row, len)) { row.push(items[i]); i++; }
      const s = row.reduce((a, r) => a + r.a, 0);
      if (w >= hgt) { const rw = s / hgt; let yy = y; for (const r of row) { const rh = r.a / rw; out.push({ c: r.c, x, y: yy, w: rw, h: rh }); yy += rh; } x += rw; w -= rw; }
      else { const rh = s / w; let xx = x; for (const r of row) { const rw = r.a / rh; out.push({ c: r.c, x: xx, y, w: rw, h: rh }); xx += rw; } y += rh; hgt -= rh; }
      items = items.slice(i);
    }
    return out;
  };
  const draw = (r) => {
    last = r;
    const kids = (r.children || []).filter((c) => c.size > 0).slice().sort((a, b) => b.size - a.size);
    status.textContent = `${fmtSize(r.total)} · ${r.files.toLocaleString()} files · ${r.dirs.toLocaleString()} folders`;
    if (mode === 'bars') {
      const top = kids.slice(0, 60), max = top[0]?.size || 1;
      chart.innerHTML = top.map((c) => `<div class="tb-row" data-path="${esc(c.path)}" data-dir="${c.isDir ? 1 : 0}"><div class="tb-name">${icon(c.isDir ? 'folder' : 'page')}<span>${esc(c.name)}</span></div><div class="tb-bar"><i style="width:${((c.size / max) * 100).toFixed(1)}%"></i></div><div class="tb-size">${fmtSize(c.size)}</div><div class="tb-pct">${r.total ? ((c.size / r.total) * 100).toFixed(1) : 0}%</div></div>`).join('');
    } else {
      const W = map.clientWidth || 700, H = map.clientHeight || 420;
      const rects = squarify(kids.slice(0, 250), 0, 0, W, H);
      map.innerHTML = rects.map(({ c, x, y, w, h: hh }) => `<div class="tm-cell${c.isDir ? ' dir' : ''}" data-path="${esc(c.path)}" data-dir="${c.isDir ? 1 : 0}" title="${esc(c.name)}: ${fmtSize(c.size)} (${r.total ? ((c.size / r.total) * 100).toFixed(1) : 0}%)" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${Math.max(0, w - 2).toFixed(1)}px;height:${Math.max(0, hh - 2).toFixed(1)}px;--h:${hue(c)}">${w > 70 && hh > 34 ? `<span class="tm-name">${esc(c.name)}</span><span class="tm-size">${fmtSize(c.size)}</span>` : ''}</div>`).join('');
    }
  };
  const onPick = (e, open) => { const row = e.target.closest('[data-path]'); if (!row) return; if (!open && row.dataset.dir === '1') { closeIt(); analyzeSpace(row.dataset.path); } else if (open) { closeIt(); navigate(t, row.dataset.dir === '1' ? row.dataset.path : dirname(row.dataset.path), { select: row.dataset.dir === '1' ? null : row.dataset.path }); } };
  for (const el of [chart, map]) { el.addEventListener('click', (e) => onPick(e, false)); el.addEventListener('dblclick', (e) => onPick(e, true)); el.addEventListener('contextmenu', (e) => { e.preventDefault(); const row = e.target.closest('[data-path]'); if (!row) return; showMenu([{ label: 'Open location', icon: 'folder', run: () => onPick({ target: row }, true) }, { label: 'Move to Recycle Bin', icon: 'trash', run: async () => { if (await confirm('Recycle?', `Move <b>${esc(row.dataset.path)}</b> to the Recycle Bin?`)) { await A.runJob({ type: 'trash', sources: [row.dataset.path] }); closeIt(); analyzeSpace(path); } } }], e.clientX, e.clientY); }); }
  let closeIt = () => document.querySelector('.analyzer-modal')?._close(null);
  setTimeout(() => setMode(mode), 0);
  A.folderSize(path, (p) => { if (p.children) draw({ ...p, children: p.children }); }, true).then(draw);
  await modal({
    title: `Space used by ${basename(path) || path}`, width: 900, className: 'analyzer-modal', body: h('div', { class: 'stack' }, h('div', { class: 'row-inline' }, status, h('span', { class: 'st-spacer' }), tabs), chart, map, h('div', { class: 'hint' }, 'Click a folder to drill in · double-click to open its location · right-click for more')),
    buttons: [dirname(path) && !isVirtual(dirname(path)) ? { label: 'Up one level', left: true, run: (c) => { c(null); analyzeSpace(dirname(path)); } } : null, { label: 'Close', primary: true, value: true }].filter(Boolean),
  });
}

export async function analyzeSelection() {
  if (!requirePro('space')) return;
  const t = activeTab();
  const sel = selectedItems(t).filter((i) => !i.virtual);
  if (sel.length === 1 && sel[0].isDir) return analyzeSpace(sel[0].path);
  let total = 0, files = 0;
  for (const i of sel) { if (i.isDir) { const r = await A.folderSize(i.path); total += r.total; files += r.files; } else { total += i.size; files++; } }
  toast(`${sel.length} items · ${fmtSize(total)} · ${files.toLocaleString()} files`);
}

// ======================================================================
// Workspaces (named sets of tabs + split layout)
// ======================================================================
export function snapshot() {
  const tabs = state.tabs.filter((t) => !t.app);
  return { layout: state.layout, splitTree: state.splitTree ? JSON.parse(JSON.stringify(state.splitTree)) : null, paneSizes: { ...state.paneSizes }, tabs: tabs.map((t) => ({ path: t.path?.startsWith('atlas:search') ? 'atlas:home' : t.path, view: t.view, sort: t.sort, group: t.group, pinned: t.pinned, locked: t.locked, gridSize: t.gridSize, color: t.color })), panes: state.panes.map((id) => Math.max(0, tabs.findIndex((t) => t.id === id))), activePane: state.activePane };
}
export function restoreSnapshot(s) {
  if (!s || !s.tabs?.length) return false;
  for (const t of state.tabs) if (t.searchJob) api('work:cancel', t.searchJob);
  state.tabs = [];
  for (const st of s.tabs) {
    const t = newTabState({ view: st.view || state.settings.defaultView, sort: st.sort || { key: 'name', dir: 1 }, group: st.group || null, pinned: !!st.pinned, locked: !!st.locked, gridSize: st.gridSize || null, color: st.color || null });
    state.tabs.push(t);
    t.path = st.path; t.history = [st.path]; t.hi = 0; t._restoredView = true;
  }
  state.layout = s.layout || '1';
  // three or four panes are Pro: a saved layout opens with two without it
  if ((state.layout === '3' || state.layout === '4') && !isPro()) state.layout = '2v';
  state.paneSizes = s.paneSizes || { v: 0.5, h: 0.5 };
  state.splitTree = s.layout === 'custom' ? s.splitTree || null : null;
  if (state.layout === 'custom' && !state.splitTree) state.layout = '1';
  const leaves = (nd) => (!nd ? 0 : nd.pane != null ? 1 : leaves(nd.a) + leaves(nd.b));
  if (state.layout === 'custom' && leaves(state.splitTree) > 2 && !isPro()) { state.layout = '2v'; state.splitTree = null; }
  const n = state.layout === 'custom' ? leaves(state.splitTree) : { 1: 1, '2v': 2, '2h': 2, 3: 3, 4: 4 }[state.layout] || 1;
  state.panes = (s.panes || [0]).slice(0, n).map((i) => state.tabs[i]?.id).filter(Boolean);
  while (state.panes.length < n) { const free = state.tabs.find((t) => !state.panes.includes(t.id)); if (free) state.panes.push(free.id); else { const t = newTabState(); t.path = 'atlas:home'; t.history = ['atlas:home']; t.hi = 0; state.tabs.push(t); state.panes.push(t.id); } }
  state.activePane = Math.min(s.activePane || 0, n - 1);
  return true;
}

export async function workspacesMenu(x, y) {
  const names = Object.keys(state.workspaces);
  showMenu([
    { label: 'Save current workspace…', icon: 'plus', run: async () => {
      const n = await prompt('Save workspace', '', { label: 'Name', placeholder: 'e.g. Photo editing' });
      if (!n) return;
      state.workspaces[n] = snapshot(); saveLibrary(); toast(`Workspace “${n}” saved`);
    } },
    names.length && { separator: true },
    ...names.map((n) => ({ label: n, icon: 'workspace', submenu: [
      { label: 'Open', run: () => { restoreSnapshot(state.workspaces[n]); bus.emit('rebuild'); } },
      { label: 'Overwrite with current', run: () => { state.workspaces[n] = snapshot(); saveLibrary(); toast('Updated'); } },
      { label: 'Delete', danger: true, run: () => { delete state.workspaces[n]; saveLibrary(); } },
    ] })),
  ], x, y);
}

// ======================================================================
// Operations status center + conflicts
// ======================================================================
const jobs = new Map();
export function initOps() {
  const btn = document.getElementById('ops-btn');
  const panel = document.getElementById('ops-panel');
  btn.addEventListener('click', () => panel.classList.toggle('open'));
  document.addEventListener('mousedown', (e) => { if (!panel.contains(e.target) && !btn.contains(e.target)) panel.classList.remove('open'); });
}
export function onOpsUpdate(j) {
  jobs.set(j.id, j);
  drawOps();
}
const fmtDurS = (s) => { s = Math.max(0, Math.round(s)); if (s < 60) return `${s} s`; const m = Math.floor(s / 60); if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim(); return `${Math.floor(m / 60)} h ${m % 60} min`; };
const expanded = new Set();
const popSeen = new Set();
let popMin = false;
onMainSafe('ops:removed', ({ id }) => { jobs.delete(id); drawOps(); });
function onMainSafe(ch, fn) { try { window.atlas?.on(ch, fn); } catch {} }
function drawOps() {
  const btn = document.getElementById('ops-btn');
  const panel = document.getElementById('ops-panel');
  const list = [...jobs.values()].sort((a, b) => (a.status === 'queued') - (b.status === 'queued') || b.id - a.id).slice(0, 40);
  const active = list.filter((j) => ['running', 'queued', 'waiting'].includes(j.status));
  btn.classList.toggle('busy', active.length > 0);
  btn.classList.toggle('show', list.length > 0);
  const total = active.reduce((a, j) => a + (j.total || 0), 0), done = active.reduce((a, j) => a + (j.done || 0), 0);
  btn.style.setProperty('--p', active.length && total ? (done / total) * 100 + '%' : '0%');
  btn.title = active.length ? `${active.length} operation${active.length > 1 ? 's' : ''} running` : 'Operations';
  const seq = !!state.settings.sequentialOps;
  const anyRunning = active.some((j) => j.status === 'running');
  const allPaused = active.length && active.every((j) => j.paused || j.status !== 'running');
  const showPop = state.settings.opsPopup && active.length > 0;
  panel.innerHTML = `<div class="ops-head"><span>Operations</span>${state.settings.opsPopup && active.length ? `<button class="link" data-act="popup" title="Show progress in its own window">Pop out</button>` : ''}<label class="ops-seq" title="Run copies and moves one after another instead of at the same time (faster on hard drives)"><input type="checkbox" data-act="seq" ${seq ? 'checked' : ''}> One at a time</label>${anyRunning ? `<button class="link" data-act="${allPaused ? 'resumeAll' : 'pauseAll'}">${allPaused ? 'Resume all' : 'Pause all'}</button>` : ''}<button class="link" data-act="clear">Clear finished</button></div>` + (list.length ? list.map((j) => {
    const pct = j.indeterminate || !j.total ? (j.filesTotal ? (j.filesDone / j.filesTotal) * 100 : null) : (j.done / j.total) * 100;
    const eta = j.speed > 0 && j.total ? Math.max(0, (j.total - j.done) / j.speed) : null;
    const elapsed = ((j.finished || Date.now()) - (j.started || Date.now())) / 1000;
    const files = j.filesTotal ? `${(j.filesDone || 0).toLocaleString()} of ${j.filesTotal.toLocaleString()} files` : '';
    const st = {
      running: j.paused ? `Paused · ${files}` : [pct != null ? Math.floor(pct) + '%' : '', j.total ? `${fmtSize(j.done || 0)} of ${fmtSize(j.total)}` : files, j.speed ? `${fmtSize(j.speed)}/s` : '', eta != null && eta > 1 ? `about ${fmtDurS(eta)} left` : '', elapsed > 3 ? `${fmtDurS(elapsed)} so far` : ''].filter(Boolean).join(' · '),
      queued: `Waiting in line${j.queuePos ? ` (#${j.queuePos})` : ''}`, waiting: 'Waiting for you to choose', done: j.errors?.length ? `Done in ${fmtDurS(elapsed)} · ${j.errors.length} problem${j.errors.length > 1 ? 's' : ''}` : `Done in ${fmtDurS(elapsed)}${j.total ? ` · ${fmtSize(j.total)}` : ''}${j.total && elapsed > 1 ? ` · ${fmtSize(j.total / elapsed)}/s average` : ''}`,
      error: `Failed: ${j.error}`, cancelled: 'Cancelled',
    }[j.status];
    const running = ['running', 'queued', 'waiting'].includes(j.status);
    const problems = (j.errors || []).length || j.status === 'error';
    const open = expanded.has(j.id);
    const explain = (e) => `<div class="op-err"><b>${esc(e.split(': ')[0].split(/[\\/]/).pop())}</b>: ${esc(explainErr(e))}</div>`;
    return `<div class="op ${j.status}${problems ? ' has-problems' : ''}"><div class="op-title" title="${esc(j.title)}">${esc(j.title)}</div><div class="op-sub">${esc(st || '')}${j.current && running ? ` · ${esc(j.current)}` : ''}</div>${running ? `<div class="op-bar ${pct == null ? 'indet' : ''}"><i style="width:${pct ?? 30}%"></i></div>` : ''}
      ${problems ? `<button class="link op-more" data-id="${j.id}" data-act="toggle">${open ? 'Hide problems' : 'What went wrong?'}</button>${open ? `<div class="op-errs">${(j.errors || []).slice(0, 12).map(explain).join('')}${j.status === 'error' ? explain(j.error || '') : ''}${j.locked?.length ? `<button class="link" data-id="${j.id}" data-act="locks">Find what’s locking ${j.locked.length > 1 ? 'them' : 'it'}</button>` : ''}</div>` : ''}` : ''}
      <div class="op-actions">${running
        ? `${j.status === 'queued' && j.queuePos > 1 ? `<button class="icon-btn" data-id="${j.id}" data-act="prioritize" title="Run this next">${icon('up')}</button>` : ''}${j.status === 'running' ? `<button class="icon-btn" data-id="${j.id}" data-act="${j.paused ? 'resume' : 'pause'}" title="${j.paused ? 'Resume' : 'Pause'}">${icon(j.paused ? 'play' : 'pause')}</button>` : ''}<button class="icon-btn" data-id="${j.id}" data-act="cancel" title="Cancel">${icon('stop')}</button>`
        : `${(problems || j.status === 'cancelled') && j.canRetry ? `<button class="icon-btn" data-id="${j.id}" data-act="retry" title="${j.failed?.length && j.failed.length < j.sourceCount ? `Retry the ${j.failed.length} that failed` : 'Try again'}">${icon('refresh')}</button>` : ''}<button class="icon-btn" data-id="${j.id}" data-act="dismiss" title="Dismiss">${icon('close')}</button>`}</div></div>`;
  }).join('') : '<div class="hint pad">No recent operations</div>') + `<div class="ops-foot"><button class="link" data-act="history">${icon('history')} File history…</button></div>`;
  // optional progress window (Settings > Behavior): the same list, floating, with Minimize
  let pop = document.getElementById('ops-pop');
  for (const j of active) if (!popSeen.has(j.id)) { popSeen.add(j.id); popMin = false; }
  if (showPop && !popMin) {
    if (!pop) { pop = h('div', { id: 'ops-pop', role: 'dialog', 'aria-label': 'Transfer progress' }); document.body.append(pop); }
    const listHtml = panel.innerHTML.replace(/^<div class="ops-head">[\s\S]*?<\/div>/, '').replace(/<div class="ops-foot">[\s\S]*$/, '');
    pop.innerHTML = `<div class="pop-head"><b>${active.length === 1 ? esc(active[0].title) : `${active.length} operations`}</b><span class="grow"></span><button class="btn small" data-act="minimize" title="Keep going in the background (click the progress button at the bottom right to see it again)">Minimize</button></div><div class="pop-body">${listHtml}</div>`;
  } else if (pop && (!active.length || popMin || !state.settings.opsPopup)) pop.remove();
  const containers = [panel, document.getElementById('ops-pop')].filter(Boolean);
  for (const c of containers) c.querySelectorAll('[data-act]').forEach((b) => b.addEventListener(b.type === 'checkbox' ? 'change' : 'click', async (e) => {
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === 'minimize') { popMin = true; drawOps(); return; }
    if (act === 'popup') { popMin = false; panel.classList.remove('open'); drawOps(); return; }
    if (act === 'clear') { for (const [id, j] of jobs) if (!['running', 'queued', 'waiting'].includes(j.status)) { jobs.delete(id); api('ops:control', id, 'dismiss'); } drawOps(); return; }
    if (act === 'seq') { state.settings.sequentialOps = b.checked; saveSettingsT(); return; }
    if (act === 'pauseAll' || act === 'resumeAll') { for (const j of jobs.values()) if (j.status === 'running') api('ops:control', j.id, act === 'pauseAll' ? 'pause' : 'resume'); return; }
    if (act === 'history') { panel.classList.remove('open'); import('./history.js').then((m) => m.historyDialog()); return; }
    const id = +b.dataset.id;
    if (act === 'toggle') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); drawOps(); return; }
    if (act === 'locks') { const j = jobs.get(id); bus.emit('whoLocks', j.locked); return; }
    if (act === 'retry') { await api('ops:control', id, 'retry'); jobs.delete(id); drawOps(); return; }
    api('ops:control', id, act);
    if (act === 'dismiss') { jobs.delete(id); drawOps(); }
  }));
}
const saveSettingsT = () => import('./core.js').then((m) => m.saveSettings());
function explainErr(e) { const msg = String(e || ''); const why = errorWhy(msg); return why; }
function errorWhy(m) {
  if (/EBUSY|resource busy|being used|locked/i.test(m)) return 'in use by another program. Close it and retry.';
  if (/EPERM|EACCES|access is denied|permission/i.test(m)) return 'Windows didn’t allow it (read-only, protected, or needs administrator rights).';
  if (/ENOSPC|no space/i.test(m)) return 'the destination is full.';
  if (/ENAMETOOLONG|name too long/i.test(m)) return 'the path is too long. Shorten folder or file names.';
  if (/ENOENT|no such file/i.test(m)) return 'it was moved or deleted before Dogfile got to it.';
  if (/EIO|i\/o error|CRC|cyclic redundancy/i.test(m)) return 'the disk couldn’t read it (damaged file or drive).';
  if (/ETIMEDOUT|ECONNRESET|network|ENETUNREACH/i.test(m)) return 'the network connection dropped.';
  if (/inside itself/i.test(m)) return 'a folder can’t go inside itself.';
  return m.split(': ').slice(1).join(': ') || m;
}
export async function onConflict(info) {
  const r = await conflictDialog(info);
  api('ops:resolveConflict', info.conflictId, r);
}
