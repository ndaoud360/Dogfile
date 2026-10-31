// App shell: boot, theme, tab strip, File/Home/Organize/Tools/View ribbon, split-layout picker, status bar,
// session restore, IPC events and global keyboard handling.
import { panelClass, animatePanel } from './panelanim.js';
import { shownPath,
  api, onMain, sys, state, bus, h, esc, DEFAULT_SETTINGS, DEFAULT_TAGS, defaultSort, saveSettings, saveLibrary, fmtSize, isVirtual, basename, virtualTitle,
  dirname, samePath, toast, isMtp, IS_WIN, debounce, persist, setNativeDialogs,
} from './core.js';
import { icon } from './icons.js';
import {
  bindActions, buildPanes, activeTab, paneTab, paneCount, openTab, closeTab, showTabInPane, setLayout, loadTab, navigate, focusPane,
  selectedItems, renderAll, onWatchChanged, duplicateTab, tabById, attachDropTarget, registerDropTarget, paneEls, renderTabPanes, sortMenu, newTabState, recompute, confirmLeaveAll,
} from './pane.js';
import * as A from './actions.js';
import * as T from './tools.js';
import { initSidebar } from './sidebar.js';
import { initPreview, quickLookOpen } from './preview.js';
import { commands, handleKey, keysFor, palette, rebuildKeymap } from './commands.js';
import { initLicense, starHtml } from './license.js';
import { showMenu, closeMenus } from './menu.js';
import { openSettings } from './settings.js';
import { anyModalOpen } from './dialogs.js';
import { applyColors } from './theme.js';
import { initFold } from './fold.js';
import { initExtras } from './extras.js';
import { APPS, syncFrames, activeAppTab } from './apptabs.js';
import { contextRibbon } from './ctxribbon.js';
import './mediatools.js';
import './foldernotes.js';
import './collections.js';
import './rules.js';
import * as U from './updates.js';
import './history.js';
import './reminders.js';
import './phonelink.js';
import './demo.js';
import './workspaces.js';
import './cliphistory.js';
import './a11y.js';
import './features.js';
import './macros.js';

bindActions(A);
A.bindSearch({ runSearch: T.runSearch, searchHere: T.searchHere });

const $ = (id) => document.getElementById(id);

// ======================================================================
// Theme
// ======================================================================
let systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
let lastThemeSig = '';
function applyTheme() {
  const s = state.settings;
  const dark = applyColors(s);
  state.dark = dark;
  const root = document.documentElement;
  // touch: bigger rows and buttons; "auto" picks it on a touch screen without a mouse
  const touchy = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const dens = s.density === 'auto' ? (touchy ? 'touch' : 'comfortable') : s.density;
  if (root.dataset.density !== dens) { root.dataset.density = dens; if (state.tabs?.length) setTimeout(() => renderAll(), 0); }
  document.body.classList.toggle('touch', dens === 'touch');
  root.style.setProperty('--side-w', (s.sidebarWidth || 300) + 'px');
  root.style.setProperty('--pv-w', (s.previewWidth || 340) + 'px');
  if (!document.body.classList.contains('folding')) { document.body.classList.toggle('no-sidebar', !!s.sidebarCollapsed); document.body.classList.toggle('side-collapsed', !!s.sidebarCollapsed); }
  panelClass('preview', document.getElementById('preview'), 'show-preview', !!s.showPreview);
  document.body.classList.toggle('pv-apps', !!s.previewWithApps);
  document.body.classList.toggle('ribbon-pinned', !!s.ribbonPinned);
  panelClass('status', document.getElementById('statusbar'), 'no-status', s.showStatusBar === false);
  applyGlass(!!s.sidebarGlass);
  // built-in apps in tabs follow at once (light/dark, colours, roundness)
  const sig = JSON.stringify([s.theme, s.mediaTheme, s.accent, s.colors, s.corners, s.fontScale, dark]);
  if (sig !== lastThemeSig) { lastThemeSig = sig; bus.emit('settings'); }
  if (IS_WIN() && !sys.customControls) { const cs = getComputedStyle(root); api('win:overlay', { color: cs.getPropertyValue('--tabbar').trim() || (dark ? '#151618' : '#efeff0'), symbolColor: cs.getPropertyValue('--text-2').trim() || (dark ? '#c9cacc' : '#3a3a3a') }); }
}
// glass sidebar: blur + translucency in the page; on Windows the window itself turns see-through (Acrylic)
let glassOn = null;
function applyGlass(on) {
  if (on === glassOn) return;
  const first = glassOn === null;
  glassOn = on;
  document.body.classList.toggle('glass', on);
  if (!on) document.body.classList.remove('see-through');
  if (!IS_WIN()) return;
  api('win:control', on ? 'glassOn' : 'glassOff').then((r) => {
    if (!r || typeof r !== 'object') return;
    document.body.classList.toggle('see-through', on && !!r.seeThrough);
    if (on && !r.seeThrough && !first) toast('Glass is on. To see your desktop through the sidebar, open a new window (Ctrl+N) or restart Dogfile.');
  }).catch(() => {});
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { systemDark = e.matches; applyTheme(); });
bus.on('theme', applyTheme);
bus.on('settings', () => { applyTheme(); renderStatus(); renderRibbon(); document.body.classList.toggle('ui-simple', state.settings.uiMode === 'simple'); });

// ======================================================================
// Tab strip
// ======================================================================
function tabTitle(t) {
  if (t.app) return t.appTitle || APPS[t.app].title;
  if (!t.path) return 'New tab';
  if (isVirtual(t.path)) return virtualTitle(t.path);
  return basename(t.path) || t.path;
}
function tabIcon(t) {
  if (t.app) return APPS[t.app].icon;
  const p = t.path || '';
  if (p === 'atlas:home') return 'home';
  if (p === 'atlas:thispc') return 'computer';
  if (p === 'atlas:recycle') return 'recycle';
  if (p === 'atlas:recent') return 'recent';
  if (p.startsWith('atlas:search')) return 'search';
  if (p.startsWith('atlas:tag')) return 'tag';
  if (p.startsWith('atlas:zip')) return 'zip';
  if (/^[A-Z]:\\$/.test(p)) return 'drive';
  return 'folder';
}

let dragTab = null;
// Dragging a tab: along the strip to reorder it, onto a pane to show it there or split the window. Done with the
// mouse directly: in the app on Windows the web view's own drag hands the mouse to Windows, which froze clicks.
let tabArm = null, tabDrag = null, tabDragged = false;
window.addEventListener('mousemove', (e) => {
  if (tabArm && !tabDrag) {
    if (!(e.buttons & 1)) { tabArm = null; return; }
    if (Math.abs(e.clientX - tabArm.x) < 6 && Math.abs(e.clientY - tabArm.y) < 6) return;
    const ghost = h('div', { class: 'drag-ghost' }, h('span', { html: icon(tabIcon(tabArm.t)) }), h('span', {}, tabTitle(tabArm.t)));
    document.body.append(ghost);
    tabDrag = { ...tabArm, ghost };
    dragTab = tabArm.t; tabArm.el.classList.add('dragging'); document.body.classList.add('tab-dragging');
  }
  if (!tabDrag) return;
  tabDrag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
  document.querySelectorAll('.tab.ins-before, .tab.ins-after').forEach((x) => x.classList.remove('ins-before', 'ins-after'));
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const tabEl = under?.closest?.('#tabs .tab');
  if (tabEl && tabEl !== tabDrag.el) { const r = tabEl.getBoundingClientRect(); tabEl.classList.add(e.clientX < r.left + r.width / 2 ? 'ins-before' : 'ins-after'); }
  import('./pane.js').then((m) => m.tabDragOver?.(tabEl ? null : under, e.clientX, e.clientY));
}, true);
window.addEventListener('mouseup', (e) => {
  tabArm = null;
  if (!tabDrag) return;
  const d = tabDrag; tabDrag = null; tabDragged = true; setTimeout(() => { tabDragged = false; }, 50);
  d.ghost.remove(); d.el.classList.remove('dragging'); document.body.classList.remove('tab-dragging');
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const tabEl = under?.closest?.('#tabs .tab');
  const before = tabEl?.classList.contains('ins-before'), after = tabEl?.classList.contains('ins-after');
  document.querySelectorAll('.tab.ins-before, .tab.ins-after').forEach((x) => x.classList.remove('ins-before', 'ins-after'));
  if (tabEl && (before || after)) {
    const target = state.tabs.find((x) => String(x.id) === tabEl.dataset.id);
    if (target && target !== d.t) { state.tabs.splice(state.tabs.indexOf(d.t), 1); state.tabs.splice(state.tabs.indexOf(target) + (after ? 1 : 0), 0, d.t); renderTabs(); saveSession(); }
  } else import('./pane.js').then((m) => m.tabDrop?.(under, e.clientX, e.clientY, d.t.id));
  dragTab = null;
}, true);
function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';
  const n = paneCount();
  const ordered = [...state.tabs.filter((t) => t.pinned), ...state.tabs.filter((t) => !t.pinned)];
  for (const t of ordered) {
    const paneIdx = state.panes.slice(0, n).indexOf(t.id);
    const active = paneIdx === state.activePane;
    const el = h('div', { class: `tab${active ? ' active' : ''}${paneIdx >= 0 ? ' shown' : ''}${t.pinned ? ' pinned' : ''}${t.loading ? ' loading' : ''}`, role: 'tab', draggable: 'false', title: (t.path && !isVirtual(t.path) ? shownPath(t.path) : tabTitle(t)) + (t.pinned ? '  (pinned)' : ''), 'data-id': t.id });
    if (t.color) el.style.setProperty('--tabc', t.color);
    el.innerHTML = `${n > 1 && paneIdx >= 0 ? `<span class="pane-badge">${paneIdx + 1}</span>` : ''}<span class="tab-ic">${icon(tabIcon(t))}</span><span class="tab-title">${esc(tabTitle(t))}</span>${t.pinned ? `<span class="tab-lock" title="Pinned: stays at the left and can't be closed by accident">${icon('pin')}</span>` : `<button class="tab-close" title="Close (Ctrl+W)">${icon('close')}</button>`}`;
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(t); return; }
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      tabArm = { t, el, x: e.clientX, y: e.clientY };
    });
    // switch on release, not on press: pressing and dragging a tab leaves the current tab showing so the dragged
    // one can be dropped beside it to split the window
    el.addEventListener('click', (e) => {
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      if (tabDragged) { tabDragged = false; return; }
      if (e.ctrlKey && n > 1) { showTabInPane(t.id, (state.activePane + 1) % n); return; } // Ctrl+click: next pane
      showTabInPane(t.id, state.activePane);
      ensureLoaded(t);
    });
    el.querySelector('.tab-close')?.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, e); });
    el.addEventListener('dblclick', (e) => { if (state.settings.dblClickTabCloses) closeTab(t); });
    el.addEventListener('dragstart', (e) => {
      dragTab = t; e.dataTransfer.setData('application/x-atlas-tab', t.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging');
      document.body.classList.add('tab-dragging'); // lets the drag pass over built-in app tabs (iframes) too
      const n = state.settings.splitTips || 0;
      if (n < 3 && paneCount() < 6) { state.settings.splitTips = n + 1; saveSettings(); toast('Drop the tab on the left, right or bottom edge of a pane to split the window. Drop in the middle to show it there.'); }
    });
    el.addEventListener('dragend', () => { dragTab = null; el.classList.remove('dragging'); document.body.classList.remove('tab-dragging'); document.querySelectorAll('.pane.tab-drop').forEach((p) => p.classList.remove('tab-drop')); });
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-atlas-tab')) { e.preventDefault(); const r = el.getBoundingClientRect(); el.classList.toggle('ins-before', e.clientX < r.left + r.width / 2); el.classList.toggle('ins-after', e.clientX >= r.left + r.width / 2); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('ins-before', 'ins-after'));
    el.addEventListener('drop', (e) => {
      if (!dragTab || dragTab === t) return;
      e.preventDefault();
      const after = el.classList.contains('ins-after');
      el.classList.remove('ins-before', 'ins-after');
      state.tabs.splice(state.tabs.indexOf(dragTab), 1);
      state.tabs.splice(state.tabs.indexOf(t) + (after ? 1 : 0), 0, dragTab);
      renderTabs(); saveSession();
    });
    // Files dragged onto a tab: hover to switch to it, drop to copy/move into its folder
    let hoverT;
    const hoverSwitch = () => { clearTimeout(hoverT); hoverT = setTimeout(() => showTabInPane(t.id, state.activePane), 650); };
    el.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) hoverSwitch(); });
    el.addEventListener('dragleave', () => clearTimeout(hoverT));
    attachDropTarget(el, () => (t.path && !isVirtual(t.path) ? t.path : null), null, { enter: hoverSwitch, leave: () => clearTimeout(hoverT) });
    host.append(el);
  }
  // keep active tab visible
  host.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function ensureLoaded(t) { if (!t._loadedOnce && !t.loading && t.path) loadTab(t); }

function tabMenu(t, e) {
  const n = paneCount();
  const colors = [null, '#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6'];
  showMenu([
    { label: 'New tab', icon: 'plus', keys: 'Ctrl+T', run: () => openTab('atlas:home', { after: t }) },
    { label: 'Duplicate tab', icon: 'copy', keys: 'Ctrl+Shift+K', run: () => duplicateTab(t) },
    { label: 'Open in new window', icon: 'newWindow', run: () => { api('win:new', { path: t.path }); closeTab(t); } },
    { separator: true },
    { label: 'Show in pane', icon: 'split', submenu: [1, 2, 3, 4].map((k) => ({ label: `Pane ${k}`, disabled: k > n && false, run: () => { if (k > n) setLayout(k === 2 ? '2v' : String(k)); setTimeout(() => showTabInPane(t.id, k - 1), 0); } })) },
    { label: 'Split with this tab', icon: 'layout2v', run: () => { if (n < 2) setLayout('2v'); setTimeout(() => showTabInPane(t.id, (state.activePane + 1) % paneCount()), 0); } },
    { separator: true },
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', icon: 'pin', run: () => { t.pinned = !t.pinned; renderTabs(); saveSession(); } },
    { label: 'Tab color', submenu: colors.map((c) => ({ label: c ? c : 'None', swatch: c || 'transparent', checked: t.color === c, run: () => { t.color = c; renderTabs(); saveSession(); } })) },
    { label: 'Copy path', icon: 'link', run: () => !isVirtual(t.path) && api('clip:writeText', t.path) },
    { separator: true },
    { label: 'Close tab', icon: 'close', keys: 'Ctrl+W', run: () => closeTab(t) },
    { label: 'Close other tabs', run: () => closeEach(state.tabs.filter((x) => x !== t && !x.locked && !x.pinned)) },
    { label: 'Close tabs to the right', run: () => closeEach(state.tabs.slice(state.tabs.indexOf(t) + 1).filter((x) => !x.locked && !x.pinned)) },
    { label: 'Close tabs to the left', run: () => closeEach(state.tabs.slice(0, state.tabs.indexOf(t)).filter((x) => !x.locked && !x.pinned)) },
    { label: 'Reopen closed tab', icon: 'history', keys: 'Ctrl+Shift+T', disabled: !state.closedTabs.length, run: () => bus.cmd('reopenTab') },
    { separator: true },
    { label: 'Save tabs as workspace…', icon: 'workspace', run: () => bus.cmd('saveWorkspace') },
  ], e.clientX, e.clientY);
}

// ======================================================================
// Menubar & ribbon (File / Home / Share / View)
// ======================================================================
let ribbonOpen = null;
// Ribbon tabs. Each group: [name, [[commandId, label, big?], …]]. Simple mode hides ADVANCED_CMDS; when a window is too
// narrow, groups on the right fold into a single button with a menu (see fitRibbon).
const R = {
  home: [
    ['Clipboard', [['copy', null, true], ['paste', null, true], ['cut'], ['copyPath'], ['pasteShortcut']]],
    ['Organize', [['moveTo'], ['copyTo'], ['rename'], ['delete'], ['pin', 'Pin to sidebar'], ['copyToOther', 'Copy → other pane'], ['moveToOther', 'Move → other pane']]],
    ['New', [['newFolder', 'New folder', true], ['newFile', 'New file…'], ['newFolderSel', 'From selection']]],
    ['Open', [['properties', null, true], ['open'], ['openWith'], ['openNewTab', 'In new tab'], ['openOtherPane', 'In other pane'], ['quickLook', 'Quick look'], ['goTo', 'Go to folder…'], ['terminal', 'Terminal here']]],
    ['Select', [['selectAll', 'All'], ['selectNone', 'None'], ['invertSel', 'Invert'], ['selectPattern', 'By pattern…'], ['selectSameType', 'Same type']]],
    ['Undo', [['undo'], ['redo'], ['history', 'File history'], ['clipHistory', 'Clipboard list']]],
  ],
  organize: [
    ['Sort files', [['declutter', 'Tidy up', true], ['folderRules', 'Automate', true], ['automations', 'All automations']]],
    ['Rename', [['batchRename', 'Rename Studio', true]]],
    ['Compress', [['quickZip', 'Zip', true], ['compress', 'Compress…'], ['extract'], ['extractTo']]],
    ['Find', [['newCollection', 'New collection'], ['dupes', 'Duplicates'], ['similarImages', 'Similar pictures']]],
    ['Share', [['sendToPhone', 'Send to phone'], ['copyPath', 'Copy path'], ['copyName'], ['createShortcut'], ['symlink'], ['addToShelf', 'Add to Drop Shelf']]],
  ],
  tools: [
    ['Clean up', [['cleanup', 'Cleanup', true], ['analyze', 'Disk space'], ['emptyRecycle'], ['similarMedia', 'Similar media']]],
    ['Compare', [['compare', 'Compare & sync', true], ['compareFiles', 'Two files…']]],
    ['Protect', [['timeTravel', 'Time travel', true], ['history', 'File history'], ['allVersions', 'Versions'], ['makeChecksums', 'Checksums'], ['verifyChecksums', 'Verify'], ['hashes'], ['whoLocks', 'What’s locking it?']]],
    ['Connect', [['phoneTransfer', 'Phone', true], ['connections', 'Servers', true], ['addConnection', 'Add server']]],
    ['Apps', [['notepad', 'Notepad', true], ['player', 'Player', true], ['viewer3d', '3D viewer'], ['terminalDrawer', 'Terminal'], ['shelf', 'Drop Shelf'], ['gotoFile', 'Go to file']]],
    ['Automate', [['features', 'Features', true], ['startMacro', 'Record macro'], ['macros', 'Macros'], ['featureStore', 'Get features']]],
    ['AI', [['aiModels', 'AI models', true]]],
    ['Windows', [['showInExplorer'], ['winProperties'], ['windowsMenu']]],
  ],
  view: [
    ['Layout', [['viewGrid', 'Grid', true], ['viewDetails', 'Details', true], ['viewGallery', 'Gallery', true], ['viewList', 'List'], ['viewColumns', 'Columns'], ['zoomIn', 'Bigger'], ['zoomOut', 'Smaller']]],
    ['History', [['timeTravel', 'Time travel', true]]],
    ['Sort & group', [['sort_name', 'By name'], ['sort_mtime', 'By date'], ['sort_size', 'By size'], ['sort_type', 'By type'], ['group_type', 'Group by type'], ['group_date', 'Group by date'], ['groupNone', 'No groups'], ['mediaFilter', 'Media filter']]],
    ['Panes', [['togglePreview', 'Preview pane'], ['toggleSidebar', 'Sidebar'], ['layout1', 'One pane'], ['layout2v', 'Side by side'], ['layout2h', 'Stacked'], ['layout3', 'Three'], ['layout4', 'Four'], ['mirrorPane', 'Same folder in other pane'], ['syncNav', 'Sync browsing'], ['swapPanes', 'Swap panes']]],
    ['Show', [['toggleHidden', 'Hidden items'], ['toggleExt', 'File extensions'], ['toggleFolderSizes', 'Folder sizes'], ['toggleCheckboxes', 'Check boxes'], ['flatten', 'Flatten folder'], ['toggleGlass', 'Glass sidebar']]],
    ['Workspace', [['workspaces', 'Workspaces', true], ['profiles', 'Profiles'], ['pinToWorkspace', 'Pin files']]],
    ['Theme', [['themeSystem', 'System'], ['themeLight', 'Light'], ['themeDark', 'Dark'], ['customizeToolbar', 'Toolbar…']]],
  ],
};
R.share = R.organize; // older saved setting

let ctxCache = null;
function updateCtxTab() {
  const c = contextRibbon();
  ctxCache = c;
  const b = $('menu-ctx');
  b.hidden = !c;
  if (c) { b.textContent = c.label; b.dataset.ctx = c.key; }
  // a pinned ribbon follows the context tab when it appears / disappears
  if (!c && (ribbonOpen === 'ctx' || (state.settings.ribbonPinned && state.settings.ribbonTab === 'ctx'))) { if (ribbonOpen === 'ctx') ribbonOpen = null; renderRibbon(); }
  else if (c && (ribbonOpen === 'ctx' || (state.settings.ribbonPinned && state.settings.ribbonTab === 'ctx'))) renderRibbon();
}
const updateCtxSoon = debounce(updateCtxTab, 60);
for (const ev of ['selection', 'tabs', 'activePane', 'appState', 'layout', 'loaded', 'status']) bus.on(ev, updateCtxSoon);
function renderCtxRibbon(r) {
  for (const [gname, btns] of ctxCache.groups) {
    const list = btns.filter(Boolean);
    if (!list.length) continue;
    r.append(ribbonGroup(gname, list.map((bt) => ({ icon: bt.icon || 'command', label: bt.label, title: bt.title || bt.label, big: bt.big, on: bt.on, run: bt.run, menu: bt.menu }))));
  }
}
// one ribbon group: big buttons, then small ones in columns of three, and the group name under them
function ribbonGroup(gname, entries) {
  const g = h('div', { class: 'rb-group' });
  const big = h('div', { class: 'rb-big' }), small = h('div', { class: 'rb-small' });
  const after = () => { if (!state.settings.ribbonPinned) { ribbonOpen = null; renderRibbon(); } else setTimeout(renderRibbon, 50); };
  for (const e of entries) {
    const b = h('button', { class: `rb-btn ${e.big ? 'big' : ''}${e.on ? ' on' : ''}${e.menu ? ' has-menu' : ''}`, title: e.title || e.label, html: `${icon(e.icon)}<span>${esc(e.label)}${e.pro ? starHtml : ''}${e.menu ? ' ▾' : ''}</span>` });
    // a button with a menu drops it down under itself (and a second click closes it)
    if (e.menu) b.addEventListener('click', () => { const r = b.getBoundingClientRect(); showMenu(e.menu, r.left, r.bottom + 2); });
    else b.addEventListener('click', () => { e.run(); after(); });
    if (e.id) b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); showMenu([{ label: 'Add to toolbar', icon: 'plus', run: () => import('./toolbar.js').then((m) => m.addToToolbar(e.id)) }, { label: 'Customize toolbar…', icon: 'settings', run: () => import('./toolbar.js').then((m) => m.customizeToolbar()) }], ev.clientX, ev.clientY); });
    (e.big ? big : small).append(b);
  }
  g.append(h('div', { class: 'rb-btns' }, big.childElementCount ? big : null, small.childElementCount ? small : null), h('div', { class: 'rb-label' }, gname));
  g._fold = () => {
    g.innerHTML = '';
    g.classList.add('folded');
    // a folded group of Pro features keeps its star
    const allPro = entries.every((e) => e.pro);
    const b = h('button', { class: 'rb-btn big', title: gname, html: `${icon(entries[0].icon)}<span>${esc(gname)}${allPro ? starHtml : ''} ▾</span>` });
    b.addEventListener('click', () => { const r = b.getBoundingClientRect(); showMenu(entries.map((e) => (e.menu ? { label: e.label, icon: e.icon, submenu: e.menu } : { label: e.label, icon: e.icon, pro: e.pro, checked: e.on || undefined, run: () => { e.run(); after(); } })), r.left, r.bottom + 2); });
    g.append(h('div', { class: 'rb-btns' }, h('div', { class: 'rb-big' }, b)), h('div', { class: 'rb-label' }, gname));
  };
  return g;
}
// too wide for the window: fold groups into one button each, starting from the right
function fitRibbon(r) {
  const groups = [...r.querySelectorAll(':scope > .rb-group')];
  for (let i = groups.length - 1; i >= 1 && r.scrollWidth > r.clientWidth + 1; i--) groups[i]._fold?.();
}
window.addEventListener('resize', debounce(() => { if ($('ribbon').classList.contains('open')) renderRibbon(); }, 150));
// the sidebar opened or closed: the ribbon has a new width (refit it once the browser is idle)
bus.on('sidebarToggled', () => { const r = $('ribbon'); const go = () => { if (r.classList.contains('open')) renderRibbon(); }; (window.requestIdleCallback || setTimeout)(go, { timeout: 500 }); });

// tools that only show in Full mode (Simple mode keeps them in the command palette and the right-click "More")
const ADVANCED_CMDS = new Set(['selectAll', 'selectNone', 'invertSel', 'shelf', 'pin', 'clipHistory', 'allVersions', 'emptyRecycle', 'showInExplorer', 'symlink', 'pasteShortcut', 'copyToOther', 'moveToOther', 'newFolderSel', 'openNewTab', 'terminal', 'runAsAdmin', 'selectPattern', 'selectSameType', 'createShortcut', 'symlink', 'hashes', 'whoLocks', 'addToShelf', 'terminalDrawer', 'gotoFile', 'winProperties', 'windowsMenu', 'syncNav', 'swapPanes', 'layout3', 'layout4', 'viewColumns', 'group_type', 'group_date', 'groupNone', 'flatten', 'toggleCheckboxes', 'toggleFolderSizes', 'sort_type', 'extractTo', 'copyName', 'editor', 'compare', 'hashes', 'similarMedia', 'makeChecksums', 'verifyChecksums', 'macros', 'startMacro', 'featureStore', 'features', 'addConnection', 'pinToWorkspace', 'automations', 'profiles', 'clipHistory', 'newCollection', 'mediaFilter']);
function renderRibbon() {
  const r = $('ribbon');
  let which = ribbonOpen || (state.settings.ribbonPinned ? state.settings.ribbonTab || 'home' : null);
  if (which === 'ctx' && !ctxCache) which = state.settings.ribbonPinned && !ribbonOpen ? 'home' : null;
  document.querySelectorAll('.menu-tab').forEach((b) => b.classList.toggle('on', b.dataset.menu === which));
  const wasOpen = r.classList.contains('open');
  if (!which || which === 'file') { if (wasOpen) animatePanel('ribbon', r, false, () => { r.innerHTML = ''; r.classList.remove('open'); setTimeout(syncFrames, 0); }); else { r.innerHTML = ''; r.classList.remove('open'); } return; }
  r.classList.add('open');
  // a ribbon that wasn't showing folds down once its buttons are in (measured before anything is painted)
  const unfold = () => { if (!wasOpen) animatePanel('ribbon', r, true, () => {}, { applied: true }); };
  r.innerHTML = '';
  if (which === 'ctx') { r.classList.add('ctx'); renderCtxRibbon(r); fitRibbon(r); setTimeout(syncFrames, 0); unfold(); return; }
  r.classList.remove('ctx');
  setTimeout(syncFrames, 0);
  const simple = state.settings.uiMode === 'simple';
  for (const [gname, btns0] of R[which] || R.home) {
    const btns = simple ? btns0.filter(([id]) => !ADVANCED_CMDS.has(id)) : btns0;
    const entries = [];
    for (const [id, label, isBig] of btns) {
      const c = commands.get(id);
      if (!c || (c.when && !c.when())) continue;
      const k = keysFor(id)[0];
      const on = c.check?.() || (id === 'theme' + state.settings.theme[0].toUpperCase() + state.settings.theme.slice(1)) || (id === 'layout' + state.layout) || (id.startsWith('view') && activeTab()?.view === id.slice(4).toLowerCase());
      entries.push({ id, icon: c.icon || 'command', label: label || c.title, title: `${c.title}${c.pro ? ' (Dogfile Pro)' : ''}${k ? ` (${k})` : ''}`, big: isBig, on, run: c.run, pro: c.pro });
    }
    if (entries.length) r.append(ribbonGroup(gname, entries));
  }
  fitRibbon(r);
  unfold();
}
function fileMenu(btn) {
  const r = btn.getBoundingClientRect();
  const C = (id, label) => { const c = commands.get(id); return { label: label || c.title, icon: c.icon, keys: keysFor(id)[0], run: c.run, pro: c.pro }; };
  const full = state.settings.uiMode !== 'simple';
  const featureCmds = () => [...commands.values()].filter((c) => c.id.startsWith('feature:')).map((c) => ({ label: c.title, icon: c.icon, run: c.run }));
  showMenu([
    C('newWindow', 'New window'), C('newTab'), C('reopenTab'),
    { separator: true },
    C('search'), full && C('advSearch'), C('assistant'), C('palette'),
    { separator: true },
    { label: 'Workspaces & profiles', icon: 'workspace', submenu: [C('workspaces'), C('saveWorkspace'), C('profiles')] },
    full && { label: 'Open terminal', icon: 'terminal', submenu: [C('terminal', 'Default terminal'), C('psHere', 'PowerShell'), C('cmdHere', 'Command Prompt'), C('terminalAdmin', 'As administrator')] },
    full && C('editor'),
    { separator: true },
    { label: 'Tools', icon: 'wand', submenu: [{ header: 'Tidy & clean' }, C('declutter'), C('cleanup'), C('automations'), C('analyze'), { separator: true }, { header: 'Find' }, C('dupes'), C('similarImages'), C('similarMedia'), C('compare'), C('newCollection'), { separator: true }, { header: 'Safety' }, C('history'), C('allVersions'), C('makeChecksums'), C('verifyChecksums'), { separator: true }, { header: 'Phone' }, C('phoneTransfer')] },
    { label: 'Features', icon: 'puzzle', submenu: () => { const f = featureCmds(); return [...f, f.length && { separator: true }, C('features', 'Manage features…'), C('createFeature'), C('featureStore', 'Browse & share features…')].filter(Boolean); } },
    full && { label: 'Macros', icon: 'record', submenu: [C('startMacro'), C('macros'), ...[...commands.values()].filter((c) => c.id.startsWith('macro:')).map((c) => ({ label: c.title.replace(/^Macro: /, ''), icon: 'record', run: c.run }))] },
    { separator: true },
    C('settings'),
    U.menuItem(),
    { label: 'Help', icon: 'info', submenu: [C('shortcuts'), C('reportBug'), { label: 'Welcome tour', icon: 'info', run: () => import('./welcome.js').then((m) => m.showWelcome()) }, { label: 'Feature guide (for making features)', icon: 'book', run: async () => { const p = await api('docs:featureGuide'); (await import('./apptabs.js')).openTool('editor', [p]); } }] },
    IS_WIN() && C('setDefault'),
    { separator: true },
    C('closeWindow', 'Close window'), C('quit', 'Quit Dogfile'),
  ].filter(Boolean), r.left, r.bottom + 2);
}
function initMenubar() {
  document.querySelectorAll('.menu-tab').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.menu;
    if (m === 'file') { ribbonOpen = null; renderRibbon(); return fileMenu(b); }
    if (state.settings.ribbonPinned) { state.settings.ribbonTab = m; saveSettings(); ribbonOpen = null; }
    else ribbonOpen = ribbonOpen === m ? null : m;
    renderRibbon();
  }));
  document.addEventListener('mousedown', (e) => { if (ribbonOpen && e.target.closest && !e.target.closest('#ribbon') && !e.target.closest('.menu-tab') && !e.target.closest('.menu')) { ribbonOpen = null; renderRibbon(); } });
  $('btn-search').innerHTML = icon('search');
  $('btn-newwin').innerHTML = icon('newWindow');
  $('btn-layout').innerHTML = icon('layout' + state.layout);
  $('btn-search').addEventListener('click', () => T.openSearchBar());
  { const ab = h('button', { class: 'icon-btn top-ic', id: 'btn-assistant', title: 'Ask the file assistant (Ctrl+J)', html: icon('sparkle') }); ab.addEventListener('click', () => import('./assistant.js').then((m) => m.toggleAssistant())); $('btn-search').before(ab); }
  import('./toolbar.js').then((m) => m.renderToolbar());
  if (state.settings.settingsSync?.folder) import('./settingsync.js').then((m) => m.startSync());
  // Open / Save dialogs of other programs: Ctrl+G jumps to a folder open here (Windows)
  if (IS_WIN()) {
    let last = '';
    const send = debounce(() => {
      const cur = activeTab()?.path;
      // turned off in Settings: nothing to jump to (it works again the moment it's turned back on)
      const list = state.settings.dialogJump === false ? [] : [cur, ...state.tabs.map((x) => x.path)].filter((p) => p && !isVirtual(p) && !/^[a-z]+:\/\//i.test(p));
      const uniq = [...new Set(list)];
      const k = sys.known || {};
      const known = [['Desktop', k.desktop], ['Documents', k.documents], ['Downloads', k.downloads], ['Pictures', k.pictures]].filter(([, p]) => p).map(([label, path]) => ({ label, path }));
      const sig = JSON.stringify(uniq);
      if (sig === last) return; last = sig;
      api('dialogjump:folders', uniq, known).catch(() => {});
    }, 400);
    for (const ev of ['tabs', 'activePane', 'loaded', 'settings']) bus.on(ev, send);
    send();
  }
  // how long starting took (shown in About; logged in test runs)
  { const off = bus.on('loaded', async () => { off?.(); const up = await api('sys:uptime').catch(() => 0); state.startupMs = up; if (sys.test) api('test:log', `startup: window ready ${up} ms after the program started (page ${Math.round(performance.now())} ms)`); }); }
  $('btn-newwin').addEventListener('click', () => api('win:new', { path: activeTab()?.path }));
  $('btn-newwin').addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu([{ label: 'New tab', icon: 'plus', run: () => bus.cmd('newTab') }, { label: 'New window', icon: 'newWindow', run: () => bus.cmd('newWindow') }], e.clientX, e.clientY); });
  $('btn-layout').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const L = (id, label, ic, k) => ({ label, icon: ic, keys: k, checked: state.layout === id, run: () => setLayout(id) });
    showMenu([
      { header: 'Split view' },
      L('1', 'Single pane', 'layout1', 'Ctrl+Alt+1'), L('2v', 'Two side by side', 'layout2v', 'Ctrl+Alt+2'), L('2h', 'Two stacked', 'layout2h', 'Ctrl+Alt+3'), L('3', 'Three panes', 'layout3', 'Ctrl+Alt+4'), L('4', 'Four panes (2×2)', 'layout4', 'Ctrl+Alt+5'),
      { separator: true },
      { label: 'Split this pane right', icon: 'layout2v', keys: 'Ctrl+Alt+\\', run: () => bus.cmd('splitRight') },
      { label: 'Split this pane down', icon: 'layout2h', keys: 'Ctrl+Alt+-', run: () => bus.cmd('splitDown') },
      { label: 'Close this pane', icon: 'close', keys: 'Ctrl+Alt+W', run: () => bus.cmd('closePane'), disabled: paneCount() < 2 },
      { separator: true },
      { label: 'Sync browsing', icon: 'sync', checked: state.settings.syncNavigation, run: () => bus.cmd('syncNav') },
      { label: 'Swap panes', icon: 'swap', keys: 'Ctrl+U', run: () => bus.cmd('swapPanes'), disabled: paneCount() < 2 },
      { label: 'Compare folders', icon: 'compare', run: () => bus.cmd('compare') },
      { label: 'Equalize pane sizes', run: () => { state.paneSizes = { v: 0.5, h: 0.5 }; const eq = (nd) => { if (nd && nd.pane == null) { nd.r = 0.5; eq(nd.a); eq(nd.b); } }; eq(state.splitTree); rebuild(); } },
    ], r.right, r.bottom + 4, { alignRight: true });
  });
  $('tab-add').innerHTML = icon('plus');
  $('tab-add').addEventListener('click', () => bus.cmd('newTab'));
  $('tabbar').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs' || e.target.classList.contains('tab-drag')) bus.cmd('newTab'); });
  $('tabs').addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('tabs').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('btn-preview').innerHTML = icon('panel');
  $('btn-preview').addEventListener('click', () => bus.cmd('togglePreview'));
  $('ops-btn').innerHTML = icon('sync');
  $('st-mid').addEventListener('click', gitMenu);
  // custom window controls when there is no native overlay (Linux/macOS dev builds)
  if (!IS_WIN() || sys.customControls) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  } else document.body.classList.add('win-overlay');
}
bus.on('toggleRibbon', () => { state.settings.ribbonPinned = !state.settings.ribbonPinned; if (state.settings.ribbonPinned && !state.settings.ribbonTab) state.settings.ribbonTab = 'home'; ribbonOpen = null; saveSettings(); applyTheme(); renderRibbon(); renderAll(); });
// status bar git branch: switch branches, see recent commits
async function gitMenu(e) {
  const t = activeTab();
  if (!t?.git?.branch || isVirtual(t.path)) return;
  const r = e.currentTarget.getBoundingClientRect();
  const dir = t.path;
  const refresh = () => loadTab(t, { soft: true });
  const [branches, log] = await Promise.all([api('git:branches', dir).catch(() => []), api('git:log', dir, 15).catch(() => [])]);
  showMenu([
    { header: 'Switch branch' },
    ...branches.slice(0, 15).map((b) => ({ label: b.name, checked: b.current, keys: b.when, run: async () => { if (b.current) return; try { await api('git:checkout', dir, b.name); toast(`Switched to ${b.name}`); refresh(); } catch (err) { toast(err.message.replace(/^.*Error: /, ''), { error: true }); } } })),
    { label: 'New branch…', icon: 'plus', run: async () => { const { prompt } = await import('./dialogs.js'); const n = await prompt('New branch', '', { label: 'Branch name' }); if (!n) return; try { await api('git:checkout', dir, n.trim().replace(/\s+/g, '-'), true); toast(`Created and switched to ${n}`); refresh(); } catch (err) { toast(err.message.replace(/^.*Error: /, ''), { error: true }); } } },
    { label: 'Pull (fast-forward)', icon: 'download', run: async () => { try { await api('git:pull', dir); toast('Up to date'); refresh(); } catch (err) { toast(err.message.replace(/^.*Error: /, ''), { error: true }); } } },
    { separator: true },
    { header: 'Recent commits' },
    ...log.map((c) => ({ label: c.subject.length > 60 ? c.subject.slice(0, 58) + '…' : c.subject, keys: `${c.hash} · ${c.date}`, run: () => { api('clip:writeText', c.hash); toast(`Copied ${c.hash} (${c.author})`); } })),
    !log.length && { label: 'No commits yet', disabled: true },
  ], r.left, r.top - 8, {});
}
bus.on('openSortMenu', ({ t, x, y }) => sortMenu(t, { left: x, bottom: y }));

// ======================================================================
// Status bar
// ======================================================================
function renderStatus() {
  const t = activeTab();
  if (t?.app) { $('st-left').textContent = t.appTitle || APPS[t.app].title; $('st-mid').innerHTML = ''; $('st-right').innerHTML = ''; return; }
  if (!t || !t.path) return;
  const sel = selectedItems(t);
  const selSize = sel.reduce((a, i) => a + (i.isDir ? 0 : i.size || 0), 0);
  const total = t.shown?.length || 0;
  const hiddenCount = (t.items?.length || 0) - total;
  $('st-left').innerHTML = `${total.toLocaleString()} item${total === 1 ? '' : 's'}${hiddenCount > 0 && !t.filter ? `<span class="dim"> · ${hiddenCount} hidden</span>` : ''}${t.filter ? `<span class="dim"> · filtered</span>` : ''}${sel.length ? ` <span class="sep">|</span> ${sel.length} selected${selSize ? ` · ${fmtSize(selSize)}` : ''}` : ''}`;
  $('st-mid').innerHTML = t.git?.branch ? `${icon('git')}<span>${esc(t.git.branch)}</span>${icon('chevronRight')}` : '';
  $('st-mid').title = t.git?.branch ? 'Git: switch branch, recent commits' : '';
  let right = '';
  if (!isVirtual(t.path)) {
    const d = state.drives.find((x) => t.path.toLowerCase().startsWith(x.path.toLowerCase().replace(/\\$/, '')));
    if (d) right = `${fmtSize(d.free)} free on ${esc(d.letter || d.name)}`;
  }
  if (state.clipboard) right = `<span class="dim">${state.clipboard.cut ? 'Cut' : 'Copied'} ${state.clipboard.paths.length}</span>  ` + right;
  if (state.settings.syncNavigation && paneCount() > 1) right = `<span class="dim">⇄ synced</span>  ` + right;
  $('st-right').innerHTML = right;
  $('btn-preview').classList.toggle('on', !!state.settings.showPreview);
}
const renderStatusSoon = debounce(renderStatus, 40);
bus.on('selection', renderStatusSoon);
bus.on('status', renderStatusSoon);
bus.on('activePane', renderStatusSoon);
bus.on('drives', renderStatusSoon);

// ======================================================================
// Session
// ======================================================================
const saveSession = debounce(() => {
  if (!state.settings.restoreTabs && state.settings.startupPath !== 'restore') return;
  api('store:set', 'session', T.snapshot());
}, 600);
bus.on('saveSession', saveSession);

function rebuild() {
  buildPanes($('panes'));
  for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t) ensureLoaded(t); }
  renderTabs();
  $('btn-layout').innerHTML = icon('layout' + state.layout);
  renderStatus();
  renderRibbon();
  saveSession();
}
bus.on('rebuild', rebuild);
let lastLayoutKey = '';
bus.on('layout', () => {
  // a free layout is rebuilt when its shape changes (a split added or closed), not when a divider moves
  const shape = (n) => (!n ? '' : n.pane != null ? String(n.pane) : `${n.dir}(${shape(n.a)},${shape(n.b)})`);
  const key = (state.layout === 'custom' ? 'custom:' + shape(state.splitTree) : state.layout) + '|' + state.panes.slice(0, paneCount()).join(',');
  if (key.split('|')[0] !== lastLayoutKey.split('|')[0] || !document.querySelector('.pane')) { lastLayoutKey = key; rebuild(); return; }
  lastLayoutKey = key;
  for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t) { ensureLoaded(t); } }
  renderAll();
  renderTabs(); renderStatus(); renderRibbon(); saveSession();
  bus.emit('activePane');
});
bus.on('tabs', () => { renderTabs(); renderStatusSoon(); saveSession(); });
bus.on('loaded', (t) => { t._loadedOnce = true; renderTabs(); renderStatusSoon(); });
bus.on('setLayout', (l) => setLayout(l));
bus.on('refreshPanes', () => { for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t && !t.app) loadTab(t, { soft: true }); } });
bus.on('openSettings', (s) => openSettings(s));

// ======================================================================
// Boot
// ======================================================================
async function boot() {
  const info = await api('sys:info');
  Object.assign(sys, info); // platform, sep, known folders, version, customControls (Dogfile 2 draws its own window buttons)…
  state.hostname = info.hostname;
  if (info.demo) import('./demo.js').then((m) => m.showDemoSign());
  const [settings, library, tags, session] = await Promise.all([api('store:get', 'settings'), api('store:get', 'library'), api('store:get', 'tags'), api('store:get', 'session')]);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  setNativeDialogs(state.settings.nativeDialogs);
  state.settings.sidebarSections = { ...DEFAULT_SETTINGS.sidebarSections, ...(state.settings.sidebarSections || {}) };
  // new defaults, applied once to settings saved before them: folders mixed in with files, the progress window on
  if ((state.settings.defaultsRev || 0) < 1) {
    state.settings.defaultsRev = 1;
    state.settings.foldersFirst = false;
    state.settings.opsPopup = true;
    delete state.settings.panelAnims; // the sidebar folds, the other panels slide
    if (settings) saveSettings();
  }
  // sorting by date created (newest first) became the default: tabs kept from before move over to it once
  let resort = false;
  if ((state.settings.defaultsRev || 0) < 2) { state.settings.defaultsRev = 2; resort = !!settings; if (settings) saveSettings(); }
  if (library) Object.assign(state, { pinned: library.pinned || [], recent: library.recent || [], recentFiles: library.recentFiles || [], workspaces: library.workspaces || {}, folderViews: library.folderViews || {} });
  state.tags = tags && tags.defs ? tags : { defs: DEFAULT_TAGS.map((d) => ({ ...d })), map: {} };
  if (!library) {
    // First run: pin a couple of useful folders so the sidebar matches the design
    state.pinned = [];
  }
  applyTheme();
  // the interface language (translates as things appear)
  if ((state.settings.language || 'auto') !== 'en') await import('./i18n.js').then((m) => m.initI18n(state.settings.language || 'auto')).catch(() => {});
  initMenubar();
  initSidebar($('side-list'));
  initPreview($('preview'));
  T.initOps();
  initFold();
  // folders dropped on the tab strip (not on a tab) open in new tabs, like links dropped on a browser's tab strip
  registerDropTarget($('tabbar'), {
    hover: () => $('tabbar'),
    op: () => 'Open in new tab',
    drop: async (e, paths) => {
      const st = await api('fs:statMany', paths).catch(() => []);
      const dirs = paths.filter((p, i) => st[i]?.isDir || isMtp(p) && !/\.[a-z0-9]{1,5}$/i.test(p));
      if (!dirs.length) { toast('Drop folders here to open them in new tabs'); return; }
      let last = null;
      for (const d of dirs) last = openTab(d, { background: true });
      if (last) showTabInPane(last.id, state.activePane);
    },
  });
  initExtras();
  A.refreshDrives();

  const launch = info.launch || {};
  // only the first window brings back the last session; New window starts fresh
  // Dogfile Pro: the licence state first (a saved 4-pane layout needs it), the trial offer after the welcome tour
  await initLicense({ test: info.test && !window.__dogTestLicense });
  const restored = (state.settings.startupPath === 'restore' && !info.test && !launch.fresh) && T.restoreSnapshot(session);
  if (!restored) {
    const t = newTabState();
    state.tabs = [t]; state.panes = [t.id]; state.layout = '1'; state.activePane = 0;
    const start = launch.path || (state.settings.startupPath && state.settings.startupPath !== 'restore' ? state.settings.startupPath : 'atlas:home');
    t.path = start; t.history = [start]; t.hi = 0;
  } else if (launch.path) {
    const t = newTabState(); state.tabs.push(t); t.path = launch.path; t.history = [launch.path]; t.hi = 0; state.panes[state.activePane] = t.id;
  }
  if (resort) for (const t of state.tabs) if (!t.app && (!t.sort || (t.sort.key === 'name' && t.sort.dir === 1))) t.sort = defaultSort();
  rebuild();
  document.body.classList.toggle('ui-simple', state.settings.uiMode === 'simple');
  if (!info.test || sessionStorage.getItem('dogfile.welcomeAgain')) import('./welcome.js').then((m) => { const again = m.welcomeAgain(); if (again || (!state.settings.welcomed && !info.test)) setTimeout(() => m.showWelcome(again || {}), again ? 150 : 700); });
  if (!info.test || window.__dogTestUpdates) U.startUpdates();
  // a dot on File while an update is waiting
  bus.on('updateStatus', () => document.querySelector('.menu-tab[data-menu="file"]')?.classList.toggle('has-update', !!U.U.status?.available));
  if (launch.select) setTimeout(() => navigate(activeTab(), launch.path, { select: launch.select }), 50);
  if (launch.open === 'reminders') setTimeout(() => import('./reminders.js').then((m) => m.openReminders(launch.reminder)), 300);
  focusPane(state.activePane);
  initLicense({ test: info.test && !window.__dogTestLicense });
  document.body.classList.add('ready');
}

// ======================================================================
// Events from main process
// ======================================================================
onMain('app:open', (launch) => {
  if (launch.newWindow) return;
  const p = launch.path || 'atlas:home';
  const t = openTab(p);
  if (launch.select) navigate(t, p, { select: launch.select });
});
onMain('archive:updated', ({ file, arc }) => { toast(`Saved changes back into ${basename(arc)}`); A.invalidateArchiveCache?.(arc); });
onMain('ops:update', T.onOpsUpdate);
onMain('ops:finished', (j) => { T.onOpsUpdate(j); A.onJobFinished(j); });
onMain('ops:conflict', T.onConflict);
// results from searches carry only the basics: fill in what the rest of Dogfile expects of a file (its type), so files
// found by a search open in the built-in apps and get the same right-click options as anywhere else
const fillItem = (it) => { if (it && !it.isDir && it.ext == null) { const n = it.name || ''; const i = n.lastIndexOf('.'); it.ext = i > 0 ? n.slice(i + 1).toLowerCase() : ''; } if (it && it.isDir && it.ext == null) it.ext = ''; return it; };
onMain('work:msg', (m) => { if (Array.isArray(m.items)) m.items.forEach(fillItem); T.onWorkMsg(m); });
onMain('watch:changed', onWatchChanged);
onMain('theme:changed', ({ dark }) => { systemDark = dark; applyTheme(); });
onMain('app:beforeHide', (d) => {
  saveSession();
  // the window closed while files were still being copied: say that the work carries on and Dogfile closes after
  if (d?.busy && !state.settings.keepRunning) import('./i18n.js').then(({ tr }) => api('notify:show', { title: tr('Dogfile is finishing in the background'), body: tr('Your files are still being copied. Dogfile closes by itself when it’s done, and tells you here.') })).catch(() => {});
});
// closing the window: apps in tabs with unsaved work ask first (Save / Don't save / Cancel)
onMain('app:closeRequested', async () => {
  let ok = true;
  try { ok = await confirmLeaveAll(() => api('win:control', 'closeAsking')); } catch { ok = true; }
  api('win:control', ok ? 'closeNow' : 'closeCancel');
});
async function closeEach(tabs) { for (const x of tabs) await closeTab(x); }
// a setting changed in another window: this one follows at once, like the window it was changed in
onMain('settings:changed', (v) => {
  const old = state.settings;
  state.settings = { ...state.settings, ...v };
  // a new language needs the page built again (tabs come back as they were)
  if ((old.language || 'auto') !== (state.settings.language || 'auto')) { api('store:set', 'session', T.snapshot()).finally(() => location.reload()); return; }
  for (const t of state.tabs) if (!t.app && t.items) recompute(t);
  bus.emit('settings');
  bus.emit('sidebar');
  renderAll();
});
onMain('drives:changed', async () => {
  await A.refreshDrives();
  for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t && (t.path === 'atlas:thispc' || t.path === 'atlas:home')) loadTab(t, { soft: true }); }
});

// ======================================================================
// Global keyboard & mouse
// ======================================================================
window.addEventListener('keydown', (e) => {
  if (anyModalOpen() || quickLookOpen()) return;
  if (document.querySelector('.menu')) return;
  // Ctrl+C with words selected in a message (a toast, an error, the assistant) copies the words, not the files
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.key === 'Insert')) {
    const sel = getSelection();
    if (sel && sel.toString() && sel.anchorNode && sel.anchorNode.parentElement?.closest('.toast, .empty-state, .as-log, .tt-tip, .lk, #statusbar, .of-status')) return;
  }
  if (e.key === 'Escape') { if (ribbonOpen) { ribbonOpen = null; renderRibbon(); return; } }
  if (e.key === 'Alt' && !e.repeat) { document.body.classList.add('alt-held'); }
  handleKey(e);
});
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') document.body.classList.remove('alt-held'); });
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); bus.cmd('back'); }
  if (e.button === 4) { e.preventDefault(); bus.cmd('forward'); }
});
window.addEventListener('beforeunload', () => api('store:set', 'session', T.snapshot()));
let lastDriveRefresh = 0;
window.addEventListener('focus', () => { if (Date.now() - lastDriveRefresh > 5000) { lastDriveRefresh = Date.now(); A.refreshDrives(); } });
// Prevent the window from navigating when files are dropped outside a drop target
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

boot().catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#c00">${esc(e.stack || e.message)}</pre>`; });

// Debug handle (handy from DevTools: __atlas.state)
window.__atlas = { state, bus, api, A, T, commands };

// a tab drag can end without a dragend on its (possibly re-rendered) tab: clean up on the next sign of life
for (const ev of ['drop', 'dragend', 'mousemove', 'mousedown', 'keydown']) document.addEventListener(ev, () => { if (document.body.classList.contains('tab-dragging')) { document.body.classList.remove('tab-dragging'); document.querySelectorAll('.split-hint').forEach((x) => x.remove()); } }, true);
