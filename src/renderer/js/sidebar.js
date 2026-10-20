// Sidebar: quick-access list (exactly like the design), pinned folders, devices with an expandable
// folder tree, network, recycle bin and color tags. Every entry is a drop target.
import { api, state, sys, bus, h, esc, debounce, basename, pjoin, samePath, isInside, IS_WIN, saveLibrary, saveSettings, toast, isVirtual } from './core.js';
import { icon } from './icons.js';
import { activeTab, navigate, openTab, attachDropTarget, currentDrag, selectedItems, selectNone } from './pane.js';
import { showMenu } from './menu.js';
import * as A from './actions.js';

const expanded = new Set();
const childCache = new Map();
let root;

export function initSidebar(el) {
  root = el;
  render();
  bus.on('sidebar', render);
  bus.on('drives', render);
  bus.on('tags', render);
  bus.on('collections', render);
  bus.on('projectFiles', render);
  bus.on('connections', render);
  bus.on('activePane', highlight);
  bus.on('tabs', highlight);
  bus.on('loaded', highlight);
  // optional "actions" mode: the selection's right-click menu lives in the sidebar
  const sync = debounce(syncMode, 70);
  for (const ev of ['selection', 'activePane', 'tabs', 'loaded', 'sidebarMode', 'status']) bus.on(ev, sync);
  // resizer
  const rz = document.getElementById('sidebar-resizer');
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { state.settings.sidebarWidth = Math.max(200, Math.min(480, ev.clientX)); document.documentElement.style.setProperty('--side-w', state.settings.sidebarWidth + 'px'); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveSettings(); bus.emit('relayout'); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  rz.addEventListener('dblclick', () => { state.settings.sidebarWidth = 300; document.documentElement.style.setProperty('--side-w', '300px'); saveSettings(); });
}

function entry({ label, ic, path, depth = 0, pinned = false, expandable = false, extra = '', title, onclick, cls = '', iconHtml }) {
  const isOpen = expandable && expanded.has(path);
  const row = h('div', { class: `side-item ${cls}`, 'data-path': path || '', style: { '--pad': 28 + depth * 16 + 'px' }, title: title || path || label, tabindex: '-1', draggable: pinned ? 'true' : null });
  row.innerHTML = `${expandable ? `<span class="twisty ${isOpen ? 'open' : ''}">${icon('chevronRight')}</span>` : ''}<span class="si-icon">${iconHtml || icon(ic)}</span><span class="si-label">${esc(label)}</span>${extra}`;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.twisty')) { toggle(path); return; }
    if (e.target.closest('.si-action')) return;
    if (onclick) return onclick(e);
    if (!path) return;
    if (e.ctrlKey) openTab(path, { background: true }); else navigate(activeTab(), path);
  });
  row.addEventListener('auxclick', (e) => { if (e.button === 1 && path) { e.preventDefault(); openTab(path, { background: true }); } });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); sideMenu({ label, path, pinned }, e); });
  if (path && !isVirtual(path)) attachDropTarget(row, () => path);
  if (pinned) {
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-atlas-pin', path); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-atlas-pin')) { e.preventDefault(); row.classList.add('pin-over'); } });
    row.addEventListener('dragleave', () => row.classList.remove('pin-over'));
    row.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('application/x-atlas-pin');
      row.classList.remove('pin-over');
      if (!from) return;
      e.preventDefault();
      const arr = state.pinned.filter((p) => p !== from);
      arr.splice(arr.indexOf(path), 0, from);
      state.pinned = arr; saveLibrary(); render();
    });
  }
  return row;
}

async function toggle(path) {
  if (expanded.has(path)) expanded.delete(path);
  else { expanded.add(path); if (!childCache.has(path)) childCache.set(path, await api('fs:subdirs', path, state.settings.showHidden)); }
  render();
}

function tree(parent, path, depth) {
  if (!expanded.has(path)) return;
  const kids = childCache.get(path) || [];
  for (const k of kids.slice(0, 300)) {
    const p = pjoin(path, k);
    parent.append(entry({ label: k, ic: 'folder', path: p, depth, expandable: true }));
    tree(parent, p, depth + 1);
  }
}

// ---------------- actions mode ----------------
let mode = 'nav', actKey = '';
const openSubs = new Set();
function wantActions() { const t = activeTab(); return !!(state.settings.sidebarActions && t && !t.app && t.sel && t.sel.size > 0); }
function syncMode() {
  if (!root) return;
  if (wantActions()) {
    const t = activeTab();
    const key = t.id + '|' + [...t.sel].join('|');
    if (mode === 'actions' && key === actKey) return;
    mode = 'actions'; actKey = key; renderActions();
  } else if (mode === 'actions') { mode = 'nav'; actKey = ''; openSubs.clear(); render(); }
}
function renderActions() {
  const t = activeTab();
  const items = selectedItems(t);
  root.innerHTML = '';
  root.classList.add('actions-mode');
  const one = items.length === 1 ? items[0] : null;
  const head = h('div', { class: 'sa-head' },
    h('div', { class: 'sa-title' }, one ? one.name : `${items.length} items selected`),
    h('button', { class: 'sa-close', title: 'Back to folders (clears the selection)', html: icon('close'), onclick: () => { selectNone(t); } }));
  const list = h('div', { class: 'sa-list' });
  const menu = A.buildItemsMenu(t, items);
  addRows(list, menu, 0);
  root.append(head, list);
}
function addRows(box, menu, depth) {
  const clean = [];
  for (const it of (menu || []).filter((i) => i && !i.hidden)) { if (it.separator && (!clean.length || clean[clean.length - 1].separator)) continue; clean.push(it); }
  while (clean.length && clean[clean.length - 1].separator) clean.pop();
  for (const it of clean) {
    if (it.separator) { box.append(h('div', { class: 'sa-sep' })); continue; }
    if (it.header) { box.append(h('div', { class: 'sa-header' }, it.header)); continue; }
    const hasSub = !!it.submenu;
    const key = depth + ':' + it.label;
    const row = h('div', { class: `side-item sa-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${hasSub ? ' has-sub' : ''}`, style: { '--pad': 24 + depth * 18 + 'px' }, title: it.label });
    row.innerHTML = `${hasSub ? `<span class="twisty ${openSubs.has(key) ? 'open' : ''}">${icon('chevronRight')}</span>` : ''}<span class="si-icon">${it.swatch ? `<i class="sa-sw" style="background:${esc(it.swatch)}"></i>` : icon(it.icon || (it.checked ? 'check' : 'dot'))}</span><span class="si-label">${esc(it.label)}</span>${it.keys ? `<span class="sa-keys">${esc(it.keys)}</span>` : ''}`;
    const sub = h('div', { class: 'sa-sub' });
    if (hasSub && openSubs.has(key)) fill(sub, it.submenu, depth + 1);
    row.addEventListener('click', async (e) => {
      if (it.disabled) return;
      if (hasSub) {
        if (openSubs.has(key)) { openSubs.delete(key); sub.innerHTML = ''; row.querySelector('.twisty').classList.remove('open'); }
        else { openSubs.add(key); row.querySelector('.twisty').classList.add('open'); await fill(sub, it.submenu, depth + 1); }
        return;
      }
      it.run?.(e);
    });
    box.append(row, sub);
  }
}
async function fill(sub, submenu, depth) {
  sub.innerHTML = '';
  const m = typeof submenu === 'function' ? await submenu() : submenu;
  addRows(sub, m, depth);
}

export function render() {
  if (!root) return;
  if (wantActions()) { mode = 'actions'; renderActions(); return; }
  root.classList.remove('actions-mode');
  const k = sys.known;
  root.innerHTML = '';
  const top = h('div', { class: 'side-top' });
  const sec = state.settings.sidebarSections;
  top.append(entry({ label: 'Desktop', ic: 'desktop', path: k.desktop }));
  top.append(entry({ label: 'Recent', ic: 'recent', path: 'atlas:recent' }));
  if (k.onedrive) top.append(entry({ label: 'OneDrive', ic: 'cloud', path: k.onedrive }));
  top.append(entry({ label: 'Documents', ic: 'documents', path: k.documents }));
  top.append(entry({ label: 'Downloads', ic: 'download', path: k.downloads }));
  top.append(entry({ label: 'Photos', ic: 'photos', path: k.pictures }));
  top.append(entry({ label: 'Videos', ic: 'videos', path: k.videos }));
  top.append(entry({ label: 'Music', ic: 'music', path: k.music }));
  // your pinned folders, in their own group under the standard ones
  if (state.pinned.length) {
    top.append(h('div', { class: 'side-sep', role: 'separator' }));
    for (const p of state.pinned) top.append(entry({ label: basename(p) || p, ic: 'pin', path: p, pinned: true, title: p }));
  }
  // Drop folders on empty space to pin them
  top.addEventListener('dragover', (e) => { if (e.target === top && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; top.classList.add('pin-zone'); } });
  top.addEventListener('dragleave', (e) => { if (e.target === top) top.classList.remove('pin-zone'); });
  top.addEventListener('drop', async (e) => {
    if (e.target !== top) return;
    e.preventDefault(); top.classList.remove('pin-zone');
    let paths = [...e.dataTransfer.files].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (!paths.length) paths = currentDrag()?.paths || [];
    const dirs = []; for (const p of paths) if (await api('fs:isDir', p)) dirs.push(p);
    if (dirs.length) A.pin(dirs);
  });
  if (sec.tags !== false) {
    const tagsRow = h('div', { class: 'side-tags' });
    tagsRow.append(h('span', { class: 'si-icon', html: icon('tag') }));
    for (const d of state.tags.defs) {
      const dot = h('button', { class: 'tag-dot', title: d.name, style: { background: d.color }, 'data-path': 'atlas:tag:' + d.id });
      dot.addEventListener('click', () => navigate(activeTab(), 'atlas:tag:' + d.id));
      dot.addEventListener('contextmenu', (e) => { e.preventDefault(); tagMenu(d, e); });
      dot.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dot.classList.add('drop-on'); } });
      dot.addEventListener('dragleave', () => dot.classList.remove('drop-on'));
      dot.addEventListener('drop', async (e) => {
        e.preventDefault(); dot.classList.remove('drop-on');
        let paths = [...e.dataTransfer.files].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
        if (!paths.length) paths = currentDrag()?.paths || [];
        const { setTags } = await import('./core.js');
        setTags(paths, d.id, true);
        toast(`Tagged ${paths.length} item${paths.length > 1 ? 's' : ''} ${d.name}`);
      });
      tagsRow.append(dot);
    }
    top.append(h('div', { class: 'side-sep', role: 'separator' }), tagsRow);
  }

  const bottom = h('div', { class: 'side-bottom' });
  // files pinned to the open workspace
  if (state.projectFiles?.length) {
    const box = h('div', { class: 'device' });
    box.append(entry({ label: 'Project files', ic: 'workspace', cls: 'device-head', onclick: () => {} }));
    for (const p of state.projectFiles) {
      const row = entry({ label: basename(p), ic: 'page', depth: 1, title: p, onclick: () => A.openItems([{ path: p, name: basename(p), isDir: false, ext: (p.split('.').pop() || '').toLowerCase() }]) });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopImmediatePropagation(); showMenu([{ label: 'Open', icon: 'open', run: () => row.click() }, { label: 'Show in folder', icon: 'folderOpen', run: () => navigate(activeTab(), p.replace(/[\\/][^\\/]+$/, ''), { select: p }) }, { label: 'Unpin from workspace', icon: 'unpin', run: () => { state.projectFiles = state.projectFiles.filter((x) => x !== p); render(); } }], e.clientX, e.clientY); }, true);
      box.append(row);
    }
    bottom.append(box);
  }
  // smart collections (collections.js)
  if (sec.collections !== false) {
    const colls = state.settings.collections || [];
    const box = h('div', { class: 'device' });
    const head = entry({ label: 'Collections', ic: 'collection', cls: 'device-head', onclick: () => { secOpen.collections = !secOpen.collections; render(); }, extra: `<button class="si-action" title="New smart collection">${icon('plus')}</button>` });
    head.querySelector('.si-action').addEventListener('click', (e) => { e.stopPropagation(); bus.emit('newCollection'); });
    box.append(head);
    if (secOpen.collections !== false) {
      import('./collections.js').then((C) => {
        for (const c of C.collections()) {
          const row = entry({ label: c.name, ic: c.icon || 'collection', path: C.collectionUrl(c), depth: 1, title: `${c.name}\n${C.describeCollection(c)}` });
          row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopImmediatePropagation(); showMenu([
            { label: 'Open', icon: 'open', run: () => C.openCollection(c) },
            { label: 'Open in new tab', icon: 'plus', run: () => openTab(C.collectionUrl(c), { background: true }) },
            { label: 'Edit…', icon: 'rename', run: () => C.editCollection(c) },
            { label: 'Delete', icon: 'trash', danger: true, run: () => { state.settings.collections = C.collections().filter((x) => x.id !== c.id); saveSettings(); render(); } },
          ], e.clientX, e.clientY); }, true);
          box.append(row);
        }
        highlight();
      });
    }
    bottom.append(box);
  }
  const dev = h('div', { class: 'device' });
  const pcName = IS_WIN() ? 'This PC' : (state.hostname || 'Computer');
  const devHead = entry({ label: pcName, ic: 'computer', path: IS_WIN() ? 'atlas:thispc' : '/', cls: 'device-head', extra: `<button class="si-action" title="Refresh drives">${icon('refresh')}</button>` });
  devHead.querySelector('.si-action').addEventListener('click', async (e) => { e.stopPropagation(); childCache.clear(); await A.refreshDrives(); toast('Drives refreshed'); });
  dev.append(devHead);
  if (sec.drives !== false) {
    for (const d of state.drives) {
      if (d.type === 'network') continue;
      const pct = d.total ? Math.round((1 - d.free / d.total) * 100) : 0;
      if (d.type === 'portable') { dev.append(entry({ label: d.name, ic: 'phone', path: d.path, depth: 1, title: `${d.name}\n${d.devType || 'Portable device'}` })); continue; }
      const row = entry({ label: d.name, ic: d.type === 'removable' ? 'usb' : d.type === 'optical' ? 'disc' : 'drive', path: d.path, depth: 1, expandable: true, title: `${d.name}\n${(d.free / 1073741824).toFixed(1)} GB free of ${(d.total / 1073741824).toFixed(1)} GB`, extra: `<span class="mini-usage"><i style="width:${pct}%" class="${pct > 90 ? 'crit' : ''}"></i></span>${d.type === 'removable' ? `<button class="si-action eject" title="Eject">${icon('eject')}</button>` : ''}` });
      row.querySelector('.eject')?.addEventListener('click', async (e) => { e.stopPropagation(); await api('fs:eject', d.letter); toast(`${d.name} can be safely removed`); A.refreshDrives(); });
      dev.append(row);
      tree(dev, d.path, 2);
    }
    if (IS_WIN()) dev.append(entry({ label: 'Recycle Bin', ic: 'recycle', path: 'atlas:recycle', depth: 1 }));
  }
  bottom.append(dev);
  const nets = state.drives.filter((d) => d.type === 'network');
  // cloud storage folders synced to this PC (OneDrive, Google Drive, Dropbox, iCloud, Box…)
  if (sec.cloud !== false && cloudList?.length) {
    const box = h('div', { class: 'device' });
    box.append(entry({ label: 'Cloud', ic: 'cloud', cls: 'device-head', onclick: () => {} }));
    for (const c of cloudList) if (!(c.provider === 'OneDrive' && samePath(c.path, k.onedrive || ''))) box.append(entry({ label: c.name, ic: 'cloud', path: c.path, depth: 1, expandable: true, title: `${c.provider}\n${c.path}` }));
    if (box.children.length > 1) bottom.append(box);
  }
  if (sec.network !== false && (IS_WIN() || (state.settings.connections || []).length)) {
    const net = h('div', { class: 'device' });
    const nh = entry({ label: 'Network', ic: 'network', path: IS_WIN() ? 'atlas:network' : null, cls: 'device-head', extra: `<button class="si-action" title="Add a server connection (NAS, share, SFTP, FTP, WebDAV)">${icon('plus')}</button>` });
    nh.querySelector('.si-action').addEventListener('click', (e) => { e.stopPropagation(); import('./network.js').then((m) => m.editConnection(null)); });
    net.append(nh);
    import('./network.js').then((N) => {
      let after = nh;
      for (const c of N.conns()) {
        const st = N.status.get(c.id);
        const row = entry({ label: c.name || c.host, ic: c.type === 'smb' ? 'computer' : 'server', depth: 1, title: `${c.name}\n${c.type.toUpperCase()} · ${c.host}${st === false ? '\nNot answering' : ''}`, onclick: () => N.openConnection(c), extra: `<span class="cn-dot small ${st === true ? 'up' : st === false ? 'down' : ''}"></span>` });
        row.dataset.path = c.type === 'sftp' || c.type === 'ftp' || c.type === 'ftps' ? `atlas:remote|${c.id}|${c.path || '/'}` : '';
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopImmediatePropagation(); showMenu([{ label: 'Open', icon: 'open', run: () => N.openConnection(c) }, { label: 'Edit…', icon: 'rename', run: () => N.editConnection(c) }, { label: 'All connections…', icon: 'server', run: () => N.connectionsDialog() }], e.clientX, e.clientY); }, true);
        after.after(row); after = row;
      }
    });
    for (const d of nets) net.append(entry({ label: d.name, ic: 'network', path: d.path, depth: 1, expandable: true }));
    for (const s of state.settings.networkPlaces || []) net.append(entry({ label: s.replace(/^\\\\/, ''), ic: 'network', path: s, depth: 1, expandable: true }));
    bottom.append(net);
  }
  root.append(top, bottom);
  highlight();
}

const secOpen = {};
let cloudList = null;
setTimeout(() => import('./network.js').then((N) => N.cloudFolders()).then((c) => { cloudList = c; if (c?.length) render(); }).catch(() => {}), 1500);
let lastActive = null;
function highlight() {
  if (!root) return;
  const t = activeTab();
  const p = t?.path;
  root.querySelectorAll('[data-path]').forEach((n) => n.classList.toggle('active', !!p && !!n.dataset.path && samePath(n.dataset.path, p)));
  if (p !== lastActive) { lastActive = p; bus.emit('sidebarHighlight'); }
  else root.querySelectorAll('.side-item.active').forEach((n) => n.classList.add('hl-on'));
}

function sideMenu({ label, path, pinned }, e) {
  if (!path) return;
  const real = !isVirtual(path);
  showMenu([
    { label: 'Open', icon: 'open', run: () => navigate(activeTab(), path) },
    { label: 'Open in new tab', icon: 'plus', run: () => openTab(path, { background: true }) },
    { label: 'Open in other pane', icon: 'split', run: () => A.openInOtherPane([{ path, isDir: true }]) },
    { label: 'Open in new window', icon: 'newWindow', run: () => api('win:new', { path }) },
    { separator: true },
    real && { label: 'Paste into folder', icon: 'paste', run: () => A.paste(activeTab(), { target: path }) },
    real && { label: 'Copy path', icon: 'link', run: () => A.copyPaths([{ path, name: label }]) },
    real && { label: 'Open terminal here', icon: 'terminal', run: () => api('shell:terminal', path, state.settings.terminal) },
    real && !pinned && { label: 'Pin to sidebar', icon: 'pin', run: () => A.pin([path]) },
    pinned && { label: 'Unpin', icon: 'unpin', run: () => A.unpin(path) },
    pinned && { label: 'Move up', run: () => movePin(path, -1) },
    pinned && { label: 'Move down', run: () => movePin(path, 1) },
    path === 'atlas:recycle' && { label: 'Empty Recycle Bin', icon: 'recycle', run: A.emptyRecycle },
    (state.settings.networkPlaces || []).includes(path) && { label: 'Remove', run: () => { state.settings.networkPlaces = state.settings.networkPlaces.filter((x) => x !== path); saveSettings(); render(); } },
    { separator: true },
    real && { label: 'Properties', icon: 'info', run: () => A.properties([{ name: label, path, isDir: true, ext: '' }]) },
  ], e.clientX, e.clientY);
}

function movePin(p, d) {
  const i = state.pinned.indexOf(p);
  const j = i + d;
  if (j < 0 || j >= state.pinned.length) return;
  [state.pinned[i], state.pinned[j]] = [state.pinned[j], state.pinned[i]];
  saveLibrary(); render();
}

async function tagMenu(d, e) {
  const { prompt } = await import('./dialogs.js');
  const { saveTags } = await import('./core.js');
  const colors = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6', '#8b8d98', '#d6409f', '#12a594', '#46a758'];
  showMenu([
    { label: `Show “${d.name}”`, icon: 'tag', run: () => navigate(activeTab(), 'atlas:tag:' + d.id) },
    { label: 'Rename tag…', icon: 'rename', run: async () => { const n = await prompt('Rename tag', d.name); if (n) { d.name = n; saveTags(); bus.emit('tags'); } } },
    { label: 'Color', submenu: colors.map((c) => ({ label: c, swatch: c, checked: d.color === c, run: () => { d.color = c; saveTags(); bus.emit('tags'); } })) },
    { label: 'Filter current folder by tag', icon: 'filter', run: () => { const t = activeTab(); t.tagFilter = d.id; import('./pane.js').then((m) => { m.recompute(t); m.renderTabPanes(t); }); } },
  ], e.clientX, e.clientY);
}
