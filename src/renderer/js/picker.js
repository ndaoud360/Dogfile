// Dogfile's own file / folder picker and message box, used everywhere instead of the Windows dialogs
// (Move to, Copy to, Extract to, Open, Save as, Import, Add files…). Works in the main window and in the
// built-in apps. Settings > Behavior > "Use Windows dialogs" switches back to the system ones.
import { h, esc, fmtSize, fmtDate, natCmp, toast, state, fileUrl, KINDS } from './core.js';
import { icon, folderArt, fileArt } from './icons.js';
import { customIcon } from './icontheme.js';
import { loadWinIcons, winIconsOn } from './winicons.js';
import { modal } from './dialogs.js';

const invoke = (name, ...args) => window.atlas.invoke(name, ...args);
let info = null;
const sysInfo = async () => (info ||= await invoke('sys:info'));
const LAST_KEY = 'atlas-picker-last';
const lastDir = (mode) => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '{}')[mode] || null; } catch { return null; } };
const rememberDir = (mode, dir) => { try { const o = JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); o[mode] = dir; localStorage.setItem(LAST_KEY, JSON.stringify(o)); } catch { /* storage unavailable: the last folder just isn't remembered */ } };
const ROOT = 'atlas:pc';
// how the list is shown: Grid, Details, Columns or Gallery (remembered, and the same in every picker)
// the same order and pictures as the view buttons in the main window
const VIEWS = [['details', 'viewList', 'Details'], ['columns', 'viewColumns', 'Columns'], ['grid', 'viewGrid', 'Grid'], ['gallery', 'gallery', 'Gallery']];
const getView = () => { try { const v = localStorage.getItem('pickerView'); return VIEWS.some((x) => x[0] === v) ? v : 'details'; } catch { return 'details'; } };
const setView = (v) => { try { localStorage.setItem('pickerView', v); } catch { /* storage unavailable: the view just isn't remembered */ } };
const PIC_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const WIN_THUMBS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'psd', 'ai', 'mp3', 'flac', 'm4a', 'exe', 'lnk', 'heic', 'stl', '3mf', 'blend']);
const thumbCache = new Map();
const extOfName = (n) => (/\.([^.\\/]+)$/.exec(n) || [, ''])[1].toLowerCase();
const samePath = (a, b, win) => { const n = (x) => String(x || '').replace(/[\\/]+$/, ''); return win ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };

function parentOf(p, win) {
  if (p === ROOT) return null;
  if (win) {
    if (/^[A-Za-z]:\\?$/.test(p)) return ROOT;
    const m = p.match(/^\\\\[^\\]+\\[^\\]+\\?$/); if (m) return ROOT;
    const q = p.replace(/\\+$/, '');
    const i = q.lastIndexOf('\\');
    return i <= 2 ? q.slice(0, 3).replace(/\\?$/, '\\') : q.slice(0, i);
  }
  if (p === '/') return null;
  const q = p.replace(/\/+$/, '');
  return q.slice(0, q.lastIndexOf('/')) || '/';
}
const join = (dir, name, sep) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
const baseOf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// mode: 'folder' | 'open' | 'save'
async function picker(mode, opts = {}) {
  const S = await sysInfo();
  const win = S.platform === 'win32';
  const sep = S.sep || (win ? '\\' : '/');
  const k = S.known || {};
  const filters = (opts.filters || []).filter((f) => f.extensions?.length);
  let filterIdx = 0;
  let cwd = null;
  let defName = '';
  if (opts.defaultPath) {
    const st = await invoke('fs:stat', opts.defaultPath).catch(() => null);
    if (st?.isDir) cwd = opts.defaultPath;
    else if (/[\\/]/.test(opts.defaultPath)) { cwd = parentOf(opts.defaultPath, win); defName = baseOf(opts.defaultPath); }
    else defName = opts.defaultPath;
  }
  if (!cwd) cwd = lastDir(mode) || k.documents || k.home || (win ? 'C:\\' : '/');
  const history = [];
  let items = [];
  let sel = new Set();
  let anchor = null;
  let view = getView();
  const dirCache = new Map(); // folder -> its items, for the Columns view
  let drawnCwd = null;

  // the picture for an item: your icon theme, the Windows icon or a thumbnail when those are on, Dogfile's own otherwise
  const fallbackArt = (p, big) => fileArt(extOfName(p));
  function art(it, big, sz = 96) {
    if (it.drive) return icon('drive');
    if (it.isDir) return folderArt();
    const e = extOfName(it.name || it.path || '');
    const own = customIcon(e);
    if (own) return `<img class="cicon${big ? ' big' : ''}" src="${own}" alt="" draggable="false">`;
    if (big && state.settings?.showThumbnails !== false && (PIC_EXT.has(e) || (win && (KINDS.video.includes(e) || WIN_THUMBS.has(e))))) return `<img class="pk-th" data-th="${esc(it.path)}" data-sz="${sz}" alt="" draggable="false">`;
    if (winIconsOn()) return `<img class="wicon${big ? ' big' : ''}" data-icon="${esc(it.path)}" alt="" draggable="false">`;
    return fileArt(e);
  }
  function hydrate() {
    loadWinIcons(list.querySelectorAll('img[data-icon]'), fallbackArt);
    list.querySelectorAll('img[data-th]').forEach(async (img) => {
      await null;
      const p = img.dataset.th, sz = Math.round((+img.dataset.sz || 96) * (window.devicePixelRatio || 1)), e = extOfName(p), key = p + '|' + sz;
      let u = thumbCache.get(key);
      if (u === undefined) {
        u = win ? await invoke('thumb:get', p, sz).catch(() => null) : null;
        if (!u && PIC_EXT.has(e)) u = fileUrl(p);
        thumbCache.set(key, u);
        if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value);
      }
      if (!img.isConnected) return;
      const instead = () => {
        const t = document.createElement('template');
        t.innerHTML = winIconsOn() ? `<img class="wicon big" data-icon="${esc(p)}" alt="">` : fileArt(e);
        const n = t.content.firstElementChild;
        img.replaceWith(n);
        if (n.matches('img[data-icon]')) loadWinIcons([n], fallbackArt);
      };
      if (!u) return instead();
      img.onerror = instead;
      img.src = u;
    });
  }

  const pathInput = h('input', { class: 'input pk-path', spellcheck: 'false' });
  const list = h('div', { class: 'pk-list', tabindex: '0' });
  const places = h('div', { class: 'pk-places' });
  const nameInput = h('input', { class: 'input pk-name', value: defName, spellcheck: 'false', placeholder: 'File name' });
  const filterSel = h('select', { class: 'input pk-filter' }, ...filters.map((f, i) => h('option', { value: String(i) }, `${f.name} (${f.extensions.map((e) => (e === '*' ? '*.*' : '*.' + e)).join(', ')})`)), h('option', { value: '-1' }, 'All files (*.*)'));
  filterSel.onchange = () => { filterIdx = +filterSel.value; dirCache.clear(); draw(); };
  const filterOk = (it) => {
    if (it.isDir || mode === 'folder') return true;
    const f = filters[filterIdx];
    if (!f || filterIdx < 0 || f.extensions.includes('*')) return true;
    return f.extensions.includes((it.name.split('.').pop() || '').toLowerCase());
  };
  const B = (ic, title, fn) => { const b = h('button', { class: 'icon-btn pk-btn', title, html: icon(ic) }); b.onclick = fn; return b; };
  const backBtn = B('back', 'Back', () => { const p = history.pop(); if (p) go(p, false); });
  const upBtn = B('up', 'Up one level (Backspace)', () => { const p = parentOf(cwd, win); if (p) go(p); });
  const newBtn = B('newFolder', 'New folder', async () => {
    if (cwd === ROOT) return;
    const { prompt } = await import('./dialogs.js');
    const n = await prompt('New folder', 'New folder', { label: 'Name' });
    if (!n) return;
    try { const p = join(cwd, n.trim(), sep); await invoke('fs:mkdir', p); dirCache.clear(); await go(cwd, false); sel = new Set([p]); draw(); } catch (e) { toast(String(e.message || e).replace(/^.*Error: /, ''), { error: true }); }
  });
  const status = h('div', { class: 'pk-status' });
  // search: filters this folder as you type, then (with the index) everything inside it
  const searchInput = h('input', { class: 'input pk-search', spellcheck: 'false', placeholder: 'Search', type: 'search' });
  let query = '', found = null, sSeq = 0, sTimer = 0;
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase(); found = null; sel = new Set(); anchor = null; draw();
    clearTimeout(sTimer);
    if (query.length < 2 || cwd === ROOT) return;
    const my = ++sSeq;
    sTimer = setTimeout(async () => {
      let r = await invoke('index:search', { query: searchInput.value.trim(), roots: [cwd], limit: 300 }).catch(() => null);
      if (my !== sSeq) return;
      if (!r?.items) { r = { items: await invoke('fs:findUnder', cwd, searchInput.value.trim(), 300).catch(() => []) }; if (my !== sSeq) return; }
      found = r.items.filter((x) => x.path !== cwd).map((x) => ({ ...x, name: x.name || baseOf(x.path), deep: true }));
      draw();
    }, 120);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list.focus(); const r = shown()[0]; if (r) { sel = new Set([r.path]); anchor = 0; draw(); } }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const r = shown()[0]; if (r) { if (r.isDir) go(r.path); else { sel = new Set([r.path]); draw(); confirmBtn(); } } }
  });

  async function go(p, push = true) {
    if (push && cwd && cwd !== p) history.push(cwd);
    cwd = p;
    sel = new Set(); anchor = null;
    if (searchInput.value) { searchInput.value = ''; query = ''; found = null; }
    pathInput.value = p === ROOT ? 'This PC' : p;
    list.innerHTML = '<div class="pk-empty">Loading…</div>';
    if (p === ROOT) {
      const drives = await invoke('fs:drives').catch(() => []);
      items = drives.filter((d) => d.path && !String(d.path).startsWith('atlas:')).map((d) => ({ name: d.label ? `${d.label} (${d.letter || d.name})` : d.name || d.path, path: d.path, isDir: true, drive: true }));
    } else {
      const r = await invoke('fs:list', p).catch((e) => ({ error: e.message, items: [] }));
      if (r.error) { list.innerHTML = `<div class="pk-empty">${esc(r.error)}</div>`; items = []; status.textContent = ''; return; }
      items = (r.items || []).filter((i) => !i.hidden).sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : natCmp(a.name, b.name)));
    }
    backBtn.disabled = !history.length; upBtn.disabled = !parentOf(cwd, win); newBtn.disabled = cwd === ROOT;
    draw();
    markPlace();
  }
  function shown() {
    let src = items;
    if (query) {
      const here = items.filter((it) => it.name.toLowerCase().includes(query));
      const seen = new Set(here.map((x) => x.path));
      src = here.concat((found || []).filter((x) => !seen.has(x.path)));
    }
    const out = src.filter((it) => (mode === 'folder' ? it.isDir : true) && filterOk(it));
    // the column picked in the header, folders first; clicking it again turns the order around
    const { key, dir } = pkSort();
    const val = (it) => (key === 'mtime' ? it.mtime || 0 : key === 'size' ? (it.isDir ? -1 : it.size || 0) : 0);
    return out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : (key === 'name' ? natCmp(a.name, b.name) : val(a) - val(b) || natCmp(a.name, b.name)) * dir));
  }
  const relOf = (p) => { const r = p.slice(cwd.length).replace(/^[\\/]+/, ''); const i = Math.max(r.lastIndexOf('\\'), r.lastIndexOf('/')); return i > 0 ? r.slice(0, i) : ''; };
  const nameHtml = (it) => `${esc(it.name)}${it.deep && relOf(it.path) ? `<span class="pk-in"> in ${esc(relOf(it.path))}</span>` : ''}`;
  const itemCls = (it) => `${sel.has(it.path) ? ' sel' : ''}${!it.isDir && mode === 'folder' ? ' dim' : ''}`;
  // the items of a folder for the Columns view: shown from what is kept, fetched (once) when it isn't there yet
  function dirItems(dir) {
    const c = dirCache.get(dir);
    if (c) return c;
    dirCache.set(dir, []);
    invoke('fs:list', dir).then((r) => {
      dirCache.set(dir, (r.items || []).filter((i) => !i.hidden && (mode === 'folder' ? i.isDir : filterOk(i))).sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : natCmp(a.name, b.name))));
      if (view === 'columns') draw();
    }, () => {});
    return [];
  }
  function drawColumns(rows) {
    const keep = list.querySelector('.pk-miller')?.scrollLeft || 0;
    const chain = [];
    for (let d = cwd === ROOT ? null : parentOf(cwd, win); d && d !== ROOT; d = parentOf(d, win)) chain.unshift(d);
    const col = (items, next, cls = '') => `<div class="pk-mcol${cls}">${items.map((it) => `<div class="pk-mitem${next && samePath(it.path, next, win) ? ' trail' : ''}${!it.isDir && mode === 'folder' ? ' dim' : ''}" data-nav="${esc(it.path)}" title="${esc(it.path)}"><span class="pk-ic">${art(it, false)}</span><span class="pk-n">${esc(it.name)}</span>${it.isDir ? '<span class="pk-chev">›</span>' : ''}</div>`).join('')}</div>`;
    const above = chain.map((d, k) => col(dirItems(d), k + 1 < chain.length ? chain[k + 1] : cwd)).join('');
    const here = `<div class="pk-mcol cur">${rows.map((it, i) => `<div class="pk-item pk-mrow${itemCls(it)}" data-i="${i}" title="${esc(it.path)}"><span class="pk-ic">${art(it, false)}</span><span class="pk-n">${nameHtml(it)}</span>${it.isDir ? '<span class="pk-chev">›</span>' : ''}</div>`).join('')}</div>`;
    const picked = rows.filter((r) => sel.has(r.path));
    const inside = picked.length === 1 && picked[0].isDir && !picked[0].drive ? picked[0].path : null;
    list.innerHTML = `<div class="pk-miller">${above}${here}${inside ? col(dirItems(inside), null, ' pv') : ''}</div>`;
    const m = list.querySelector('.pk-miller');
    m.scrollLeft = drawnCwd !== cwd ? m.scrollWidth : keep;
  }
  function drawGallery(rows) {
    const cur = rows.find((r) => sel.has(r.path)) || rows[0];
    const stage = `<div class="pk-stage"><div class="pk-stage-art">${art(cur, true, 480)}</div><div class="pk-stage-cap"><b>${esc(cur.name)}</b><span>${[cur.isDir ? '' : fmtSize(cur.size || 0), cur.mtime ? fmtDate(cur.mtime) : ''].filter(Boolean).join(' · ')}</span></div></div>`;
    const strip = `<div class="pk-strip">${rows.map((it, i) => `<div class="pk-item pk-cell${itemCls(it)}" data-i="${i}" title="${esc(it.path)}"><div class="pk-tile">${art(it, true, 128)}</div><div class="pk-cn">${esc(it.name)}</div></div>`).join('')}</div>`;
    list.innerHTML = stage + strip;
  }
  function draw() {
    const rows = shown();
    list.className = 'pk-list v-' + view;
    cols.style.display = view === 'details' ? '' : 'none';
    if (!rows.length) { list.innerHTML = `<div class="pk-empty">${query ? 'Nothing matches “' + esc(searchInput.value.trim()) + '”' + (found ? '' : ' in this folder') + '.' : mode === 'folder' ? 'No folders here. Choose this folder, or create one.' : 'Nothing here.'}</div>`; status.textContent = ''; return; }
    if (view === 'columns') drawColumns(rows);
    else if (view === 'gallery') drawGallery(rows);
    else if (view === 'grid') list.innerHTML = rows.map((it, i) => `<div class="pk-item pk-cell${itemCls(it)}" data-i="${i}" title="${esc(it.path)}"><div class="pk-tile">${art(it, true, 128)}</div><div class="pk-cn">${esc(it.name)}</div></div>`).join('');
    else list.innerHTML = rows.map((it, i) => `<div class="pk-item pk-row${itemCls(it)}" data-i="${i}" title="${esc(it.path)}"><span class="pk-ic">${art(it, false)}</span><span class="pk-n">${nameHtml(it)}</span><span class="pk-d">${it.mtime ? esc(fmtDate(it.mtime)) : ''}</span><span class="pk-s">${it.isDir ? '' : fmtSize(it.size || 0)}</span></div>`).join('');
    drawnCwd = cwd;
    hydrate();
    const n = rows.filter((r) => sel.has(r.path)).length;
    status.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${query ? (found ? ' found in this folder and below' : ' in this folder') : ''}${n ? ` · ${n} selected` : ''}`;
  }
  list.addEventListener('mousedown', (e) => {
    const r = e.target.closest('.pk-item');
    if (!r) { if (!e.target.closest('.pk-mitem, .pk-stage')) { sel = new Set(); draw(); } return; }
    const rows = shown(); const it = rows[+r.dataset.i];
    if (mode === 'open' && e.shiftKey && anchor != null) { const a = Math.min(anchor, +r.dataset.i), b = Math.max(anchor, +r.dataset.i); sel = new Set(rows.slice(a, b + 1).filter((x) => !x.isDir).map((x) => x.path)); }
    else if (mode === 'open' && e.ctrlKey) { sel.has(it.path) ? sel.delete(it.path) : sel.add(it.path); anchor = +r.dataset.i; }
    else { sel = new Set([it.path]); anchor = +r.dataset.i; }
    if (mode === 'save' && !it.isDir) nameInput.value = it.name;
    draw();
  });
  // Columns: a click in a column to the left goes back to that folder (or into a folder picked in the one on the right)
  list.addEventListener('click', async (e) => {
    const m = e.target.closest('.pk-mitem'); if (!m) return;
    const p = m.dataset.nav;
    const st = await invoke('fs:stat', p).catch(() => null);
    if (!st) return;
    if (st.isDir) return go(p);
    if (mode === 'folder') return;
    await go(parentOf(p, win), false);
    sel = new Set([p]); if (mode === 'save') nameInput.value = baseOf(p);
    draw();
  });
  list.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.pk-item'); if (!r) return;
    const it = shown()[+r.dataset.i];
    if (it.isDir) go(it.path);
    else if (mode === 'open') { sel = new Set([it.path]); confirmBtn(); }
    else if (mode === 'save') { nameInput.value = it.name; confirmBtn(); }
  });
  // how many tiles fit across, for the arrow keys in the Grid view
  const perRow = () => { const c = [...list.querySelectorAll('.pk-item')]; if (!c.length) return 1; let n = 0; for (const x of c) { if (x.offsetTop !== c[0].offsetTop) break; n++; } return Math.max(1, n); };
  list.addEventListener('keydown', (e) => {
    const rows = shown();
    let i = rows.findIndex((r) => sel.has(r.path));
    const move = (to) => { to = Math.max(0, Math.min(rows.length - 1, to)); if (rows[to]) { sel = new Set([rows[to].path]); anchor = to; draw(); list.querySelector('.pk-item.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } };
    const across = view === 'grid' ? perRow() : 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(i < 0 ? 0 : i + (e.key === 'ArrowDown' ? across : -across)); }
    else if ((view === 'grid' || view === 'gallery') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); move(i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1)); }
    else if (view === 'columns' && e.key === 'ArrowRight' && i >= 0 && rows[i].isDir) { e.preventDefault(); go(rows[i].path); }
    else if (view === 'columns' && e.key === 'ArrowLeft') { e.preventDefault(); upBtn.click(); }
    else if (e.key === 'Backspace') { e.preventDefault(); upBtn.click(); }
    else if (e.key === 'Enter' && i >= 0 && rows[i].isDir && mode !== 'folder') { e.preventDefault(); e.stopPropagation(); go(rows[i].path); }
  });
  pathInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    let v = pathInput.value.trim().replace(/^"|"$/g, '');
    if (/^this pc$/i.test(v)) return go(ROOT);
    if (v.startsWith('~')) v = (k.home || '') + v.slice(1);
    const st = await invoke('fs:stat', v).catch(() => null);
    if (!st) return toast(`Can't find "${v}"`, { error: true });
    if (st.isDir) go(v);
    else if (mode !== 'folder') { await go(parentOf(v, win)); sel = new Set([v]); nameInput.value = baseOf(v); draw(); confirmBtn(); }
  });

  // places
  const P = (label, ic, p) => p && { label, ic, p };
  const quick = [P('Home', 'home', k.home), P('Desktop', 'desktop', k.desktop), P('Documents', 'documents', k.documents), P('Downloads', 'download', k.downloads), P('Pictures', 'photos', k.pictures), P('Music', 'music', k.music), P('Videos', 'videos', k.videos)].filter(Boolean);
  function renderPlaces(drives) {
    places.innerHTML = '';
    const sec = (t) => places.append(h('div', { class: 'pk-sec' }, t));
    const add = (pl) => { const r = h('div', { class: 'pk-place', title: pl.p, 'data-p': pl.p, html: `${icon(pl.ic)}<span>${esc(pl.label)}</span>` }); r.onclick = () => go(pl.p); places.append(r); };
    sec('Quick access'); quick.forEach(add);
    let pinned = [];
    try { pinned = JSON.parse(localStorage.getItem('atlas-picker-pins') || '[]'); } catch { /* storage unavailable or unreadable: no pinned folders */ }
    if (opts.pinned?.length) pinned = opts.pinned;
    if (pinned.length) { sec('Pinned'); pinned.forEach((p) => add({ label: baseOf(p), ic: 'pin', p })); }
    sec(win ? 'This PC' : 'Devices');
    if (win) add({ label: 'All drives', ic: 'computer', p: ROOT });
    for (const d of drives.filter((x) => x.path && !String(x.path).startsWith('atlas:'))) add({ label: d.label ? `${d.label} (${d.letter || d.name})` : d.name || d.path, ic: 'drive', p: d.path });
    markPlace();
  }
  function markPlace() { places.querySelectorAll('.pk-place').forEach((r) => r.classList.toggle('on', r.dataset.p === cwd)); }
  invoke('fs:drives').then(renderPlaces, () => renderPlaces([]));
  renderPlaces([]);

  let resolveOut;
  const result = new Promise((r) => (resolveOut = r));
  let closeFn = null;
  async function confirmBtn() {
    if (mode === 'folder') {
      const rows = shown(); const chosen = rows.find((r) => sel.has(r.path) && r.isDir);
      const target = chosen ? chosen.path : cwd;
      if (target === ROOT) { toast('Pick a drive or folder'); return false; }
      rememberDir(mode, chosen ? cwd : target);
      closeFn(target); return;
    }
    if (mode === 'open') {
      const files = shown().filter((r) => sel.has(r.path) && !r.isDir).map((r) => r.path);
      const dirSel = shown().find((r) => sel.has(r.path) && r.isDir);
      if (!files.length && dirSel) { go(dirSel.path); return false; }
      if (!files.length) { toast('Select a file'); return false; }
      rememberDir(mode, cwd);
      closeFn(files); return;
    }
    // save
    let n = nameInput.value.trim();
    if (!n) { nameInput.focus(); return false; }
    if (cwd === ROOT) { toast('Pick a folder first'); return false; }
    if (/[<>:"/\\|?*]/.test(n) && win) { toast('A file name can\'t contain \\ / : * ? " < > |', { error: true }); return false; }
    const f = filters[filterIdx];
    if (f && filterIdx >= 0 && !f.extensions.includes('*') && !/\.[^.]+$/.test(n)) n += '.' + f.extensions[0];
    const target = join(cwd, n, sep);
    const st = await invoke('fs:stat', target).catch(() => null);
    if (st?.isDir) { go(target); return false; }
    if (st) { const { confirm } = await import('./dialogs.js'); if (!(await confirm('Replace file?', `<b>${esc(n)}</b> already exists. Replace it?`, { ok: 'Replace', danger: true }))) return false; }
    rememberDir(mode, cwd);
    closeFn(target);
  }
  // the four ways to look at the list, in the top right corner
  const viewBtns = h('div', { class: 'pk-views', role: 'group', 'aria-label': 'View' });
  const drawViewBtns = () => { viewBtns.innerHTML = ''; for (const [v, ic, label] of VIEWS) { const b = h('button', { class: 'icon-btn pk-btn' + (v === view ? ' on' : ''), title: label, 'aria-pressed': String(v === view), html: icon(ic) }); b.onclick = () => { if (v === view) return; view = v; setView(v); drawViewBtns(); draw(); }; viewBtns.append(b); } };
  drawViewBtns();
  const head = h('div', { class: 'pk-bar' }, backBtn, upBtn, pathInput, searchInput, newBtn, viewBtns);
  const cols = h('div', { class: 'pk-cols' });
  const drawCols = () => {
    const { key, dir } = pkSort();
    cols.innerHTML = '';
    for (const [k, label] of [['name', 'Name'], ['mtime', 'Modified'], ['size', 'Size']]) {
      const b = h('button', { class: 'pk-col' + (k === key ? ' on' : ''), title: `Sort by ${label.toLowerCase()}` }, label, k === key ? h('span', { class: 'pk-arrow' }, dir > 0 ? '▲' : '▼') : null);
      b.addEventListener('click', () => { const cur = pkSort(); setPkSort({ key: k, dir: cur.key === k ? -cur.dir : k === 'name' ? 1 : -1 }); drawCols(); draw(); });
      cols.append(b);
    }
  };
  drawCols();
  const main = h('div', { class: 'pk-main' }, head, cols, list);
  const foot = h('div', { class: 'pk-foot' }, status,
    mode === 'save' ? h('label', { class: 'pk-namewrap' }, h('span', {}, 'File name'), nameInput) : null,
    (mode !== 'folder' && filters.length) ? filterSel : null);
  const body = h('div', { class: 'pk' }, places, h('div', { class: 'pk-right' }, main, foot));
  const okLabel = opts.okLabel || (mode === 'folder' ? (opts.title && /^(move|copy|extract)/i.test(opts.title) ? opts.title.replace(/\s*(to)?…?$/i, '').replace(/^(\w+).*$/, '$1 here') : 'Select folder') : mode === 'open' ? 'Open' : 'Save');
  modal({
    title: opts.title || (mode === 'folder' ? 'Choose a folder' : mode === 'open' ? 'Open' : 'Save as'), body, width: 880, className: 'pk-modal', noPadding: true,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, run: async (close) => { closeFn = close; const r = await confirmBtn(); return r; } }],
    onClose: (v) => resolveOut(v),
  }).then(() => {});
  // the modal's close function is needed by double-click confirm, too
  setTimeout(() => { const box = body.closest('.modal'); closeFn = box?._close || closeFn; if (mode === 'save') { nameInput.focus(); const i = nameInput.value.lastIndexOf('.'); nameInput.setSelectionRange(0, i > 0 ? i : nameInput.value.length); } else list.focus(); }, 30);
  nameInput.classList.add('no-enter');
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmBtn(); } });
  if (!filters.length) filterIdx = -1;
  await go(cwd, false).catch(() => go(k.home || (win ? 'C:\\' : '/'), false));
  const v = await result;
  if (mode === 'open') return Array.isArray(v) ? v : [];
  return v || null;
}

// the sort picked in the header, shared by every Dogfile window
const pkSort = () => { try { return { key: 'name', dir: 1, ...JSON.parse(localStorage.getItem('pickerSort') || '{}') }; } catch { return { key: 'name', dir: 1 }; } };
const setPkSort = (v) => { try { localStorage.setItem('pickerSort', JSON.stringify(v)); } catch { /* storage unavailable: the sort order just isn't remembered */ } };
export const pickFolder = (title, opts = {}) => picker('folder', { ...opts, title });
export const openFiles = (opts = {}) => picker('open', opts);
export const saveFile = (opts = {}) => picker('save', opts);

// in-app replacement for the Windows message box; resolves to the index of the clicked button
export function messageBox({ title, message, detail, buttons = ['OK', 'Cancel'], cancelId, type }) {
  const cancel = cancelId ?? buttons.length - 1;
  return new Promise((resolve) => {
    modal({
      title: title || 'Dogfile', width: 460,
      body: h('div', { class: 'confirm-msg' }, h('div', { class: 'mb-msg' + (type === 'warning' ? ' warn' : '') }, message || ''), detail ? h('div', { class: 'hint', style: { marginTop: '6px' } }, detail) : null),
      buttons: buttons.map((b, i) => ({ label: b, primary: i === 0, value: i })),
      onClose: (v) => resolve(v == null ? cancel : v),
    });
  });
}
