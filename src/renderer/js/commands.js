// Command registry: every action has an id, title, icon and default shortcut(s).
// Shortcuts are user-remappable; the Command Palette (Ctrl+Shift+P) searches them all.
import { api, state, bus, h, esc, isVirtual, saveSettings, toast, IS_WIN, sys, debounce } from './core.js';
import { openTool } from './apptabs.js';
import { icon } from './icons.js';
import {
  activeTab, paneTab, paneCount, navigate, goBack, goForward, goUp, openTab, closeTab, reopenClosedTab, duplicateTab, setLayout,
  focusPane, selectedItems, selectAll, selectNone, invertSelection, setView, loadTab, otherPaneTab, startPathEdit, paneEls,
  renderAll, recompute, renderTabPanes, clearThumbCache, touchView, showTabInPane, selectOnly, confirmLeaveAll,
} from './pane.js';
import * as A from './actions.js';
import * as T from './tools.js';
import { quickLook } from './preview.js';
import { selectPatternDialog, patternToTest, modal } from './dialogs.js';
import { closeMenus } from './menu.js';
import { requirePro } from './license.js';
import { PRO_COMMANDS } from './pro-marks.js';

export const commands = new Map();
const def = (id, title, opts = {}) => commands.set(id, { id, title, ...opts });
const T_ = () => activeTab();
const S_ = () => selectedItems(activeTab());

// ---------------- navigation ----------------
def('back', 'Go back', { icon: 'back', keys: ['Alt+Left', 'Backspace', 'BrowserBack'], cat: 'Navigate', run: () => goBack(T_()) });
def('forward', 'Go forward', { icon: 'forward', keys: ['Alt+Right', 'BrowserForward'], cat: 'Navigate', run: () => goForward(T_()) });
def('up', 'Up one level', { icon: 'up', keys: ['Alt+Up'], cat: 'Navigate', run: () => goUp(T_()) });
def('refresh', 'Refresh', { icon: 'refresh', keys: ['F5', 'Ctrl+R'], cat: 'Navigate', run: () => { clearThumbCache(); A.refreshDrives(); loadTab(T_()); }, when: () => paneCount() < 2 });
def('editPath', 'Edit address bar', { icon: 'rename', keys: ['Ctrl+L', 'Alt+D', 'F4'], cat: 'Navigate', run: () => startPathEdit(paneEls[state.activePane], T_()) });
def('home', 'Go to Home', { icon: 'home', keys: ['Alt+Home'], cat: 'Navigate', run: () => navigate(T_(), 'atlas:home') });
def('thispc', 'Go to This PC', { icon: 'computer', cat: 'Navigate', run: () => navigate(T_(), IS_WIN() ? 'atlas:thispc' : '/') });
def('recycleBin', 'Open Recycle Bin', { icon: 'recycle', cat: 'Navigate', run: () => navigate(T_(), 'atlas:recycle') });
def('recent', 'Open Recent', { icon: 'recent', cat: 'Navigate', run: () => navigate(T_(), 'atlas:recent') });
def('goDesktop', 'Go to Desktop', { icon: 'desktop', cat: 'Navigate', run: () => navigate(T_(), sys.known.desktop) });
def('goDownloads', 'Go to Downloads', { icon: 'downloadArrow', cat: 'Navigate', run: () => navigate(T_(), sys.known.downloads) });
def('goDocuments', 'Go to Documents', { icon: 'page', cat: 'Navigate', run: () => navigate(T_(), sys.known.documents) });
def('goTo', 'Go to folder…', { icon: 'folder', keys: ['Ctrl+G'], cat: 'Navigate', run: () => goToDialog() });

// ---------------- tabs & panes ----------------
def('newTab', 'New tab', { icon: 'plus', keys: ['Ctrl+T'], cat: 'Tabs', run: () => openTab(state.settings.newTabPath === 'current' && !T_().app ? T_().path : 'atlas:home', { after: T_() }) });
def('closeTab', 'Close tab', { icon: 'close', keys: ['Ctrl+W', 'Ctrl+F4'], cat: 'Tabs', run: () => closeTab(T_()) });
def('reopenTab', 'Reopen closed tab', { icon: 'history', keys: ['Ctrl+Shift+T'], cat: 'Tabs', run: reopenClosedTab });
def('duplicateTab', 'Duplicate tab', { icon: 'copy', keys: ['Ctrl+Shift+K'], cat: 'Tabs', run: () => duplicateTab(T_()) });
def('nextTab', 'Next tab', { keys: ['Ctrl+Tab', 'Ctrl+PageDown'], cat: 'Tabs', run: () => cycleTab(1) });
def('prevTab', 'Previous tab', { keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], cat: 'Tabs', run: () => cycleTab(-1) });
for (let i = 1; i <= 9; i++) def('tab' + i, `Switch to tab ${i}`, { keys: [`Ctrl+${i}`], cat: 'Tabs', hidden: true, run: () => { const t = i === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[i - 1]; if (t) showTabInPane(t.id, state.activePane); } });
def('pinTab', 'Pin / unpin tab', { icon: 'pin', cat: 'Tabs', run: () => { const t = T_(); t.pinned = !t.pinned; bus.emit('tabs'); } });
def('newWindow', 'New window', { icon: 'newWindow', keys: ['Ctrl+N'], cat: 'Tabs', run: () => api('win:new', { path: T_().path }) });
def('layout1', 'Single pane', { icon: 'layout1', keys: ['Ctrl+Alt+1'], cat: 'Layout', run: () => setLayout('1') });
def('layout2v', 'Two panes side by side', { icon: 'layout2v', keys: ['Ctrl+Alt+2', 'Ctrl+Shift+S'], cat: 'Layout', run: () => setLayout('2v') });
def('layout2h', 'Two panes stacked', { icon: 'layout2h', keys: ['Ctrl+Alt+3'], cat: 'Layout', run: () => setLayout('2h') });
def('layout3', 'Three panes', { icon: 'layout3', keys: ['Ctrl+Alt+4'], cat: 'Layout', run: () => setLayout('3') });
def('layout4', 'Four panes (2×2)', { icon: 'layout4', keys: ['Ctrl+Alt+5'], cat: 'Layout', run: () => setLayout('4') });
def('toggleSplit', 'Toggle dual pane', { icon: 'split', keys: ['F3'], cat: 'Layout', run: () => setLayout(paneCount() > 1 ? '1' : '2v') });
def('nextPane', 'Focus next pane', { keys: ['Tab', 'Ctrl+Alt+Right'], cat: 'Layout', run: () => focusPane((state.activePane + 1) % paneCount()), when: () => paneCount() > 1 });
def('prevPane', 'Focus previous pane', { keys: ['Shift+Tab', 'Ctrl+Alt+Left'], cat: 'Layout', run: () => focusPane((state.activePane - 1 + paneCount()) % paneCount()), when: () => paneCount() > 1 });
def('swapPanes', 'Swap panes', { icon: 'swap', keys: ['Ctrl+U'], cat: 'Layout', run: () => { if (paneCount() < 2) return; const a = state.activePane, b = (a + 1) % paneCount(); [state.panes[a], state.panes[b]] = [state.panes[b], state.panes[a]]; bus.emit('layout'); } });
def('mirrorPane', 'Show this folder in the other pane', { icon: 'split', keys: ['Ctrl+Alt+Down'], cat: 'Layout', run: () => { const o = otherPaneTab(); if (!o) setLayout('2v'); setTimeout(() => navigate(otherPaneTab(), T_().path), 0); } });
def('syncNav', 'Sync browsing between panes', { icon: 'sync', cat: 'Layout', check: () => state.settings.syncNavigation, run: () => { state.settings.syncNavigation = !state.settings.syncNavigation; saveSettings(); toast(state.settings.syncNavigation ? 'Synchronized browsing on' : 'Synchronized browsing off'); bus.emit('settings'); } });
def('toggleSidebar', 'Toggle sidebar', { icon: 'panel', keys: ['Ctrl+B'], cat: 'Layout', run: () => bus.emit('toggleSidebarAnimated') });
def('togglePreview', 'Toggle preview pane', { icon: 'panel', keys: ['Alt+P', 'Ctrl+Shift+E'], cat: 'Layout', check: () => state.settings.showPreview, run: () => { state.settings.showPreview = !state.settings.showPreview; saveSettings(); bus.emit('settings'); bus.emit('preview'); } });
def('toggleRibbon', 'Pin / collapse the ribbon', { icon: 'caretUp', keys: ['Ctrl+F1'], cat: 'Layout', run: () => bus.emit('toggleRibbon') });
def('fullscreen', 'Full screen', { icon: 'max', keys: ['F11'], cat: 'Layout', run: () => api('win:control', 'fullscreen') });

// ---------------- selection ----------------
def('selectAll', 'Select all', { icon: 'selectAll', keys: ['Ctrl+A'], cat: 'Select', run: () => selectAll(T_()) });
def('selectNone', 'Select none', { keys: ['Ctrl+Shift+D', 'Escape'], cat: 'Select', run: () => selectNone(T_()) });
def('invertSel', 'Invert selection', { icon: 'invert', keys: ['Ctrl+I'], cat: 'Select', run: () => invertSelection(T_()) });
def('selectPattern', 'Select by pattern…', { icon: 'filter', keys: ['Ctrl+Shift+A', 'NumpadAdd'], cat: 'Select', run: async () => {
  const r = await selectPatternDialog(); if (!r?.pattern) return;
  const t = T_(); const test = patternToTest(r.pattern);
  const m = t.shown.filter((i) => test(i.name)).map((i) => i.path);
  if (r.mode === 'replace') t.sel = new Set(m); else if (r.mode === 'add') m.forEach((p) => t.sel.add(p)); else m.forEach((p) => t.sel.delete(p));
  renderTabPanes(t, true); bus.emit('selection', t); toast(`${m.length} matching`);
} });
def('selectSameType', 'Select all of the same type', { cat: 'Select', run: () => { const t = T_(); const ex = new Set(S_().map((i) => (i.isDir ? '/' : i.ext))); t.sel = new Set(t.shown.filter((i) => ex.has(i.isDir ? '/' : i.ext)).map((i) => i.path)); renderTabPanes(t, true); bus.emit('selection', t); } });
def('filter', 'Filter this folder', { icon: 'filter', keys: ['Ctrl+F'], cat: 'Select', run: () => { const el = paneEls[state.activePane]; el?.nav.querySelector('.filter-box')?.focus(); } });

// ---------------- file operations ----------------
def('open', 'Open', { icon: 'open', keys: ['Enter'], cat: 'File', run: () => { const s = S_(); if (s.length) A.openItems(s); } });
def('openNewTab', 'Open in new tab', { icon: 'plus', keys: ['Ctrl+Enter'], cat: 'File', run: () => A.openInNewTab(S_()) });
def('openOtherPane', 'Open in other pane', { icon: 'split', keys: ['Shift+Enter'], cat: 'File', run: () => A.openInOtherPane(S_()) });
def('openWith', 'Open with…', { icon: 'apps', cat: 'File', run: () => { const s = S_()[0]; if (s) api('shell:openWith', s.path); } });
def('copy', 'Copy', { icon: 'copy', keys: ['Ctrl+C', 'Ctrl+Insert'], cat: 'Edit', run: () => A.copy(S_()) });
def('cut', 'Cut', { icon: 'cut', keys: ['Ctrl+X'], cat: 'Edit', run: () => A.copy(S_(), true) });
def('paste', 'Paste', { icon: 'paste', keys: ['Ctrl+V', 'Shift+Insert'], cat: 'Edit', run: () => A.paste(T_()) });
def('pasteShortcut', 'Paste shortcut', { icon: 'link', cat: 'Edit', run: () => A.paste(T_(), { asShortcut: true }) });
def('copyPath', 'Copy path', { icon: 'link', keys: ['Ctrl+Shift+C'], cat: 'Edit', run: () => A.copyPaths(S_()) });
def('copyName', 'Copy name', { keys: ['Ctrl+Alt+C'], cat: 'Edit', run: () => A.copyPaths(S_(), 'name') });
def('delete', 'Delete', { icon: 'trash', keys: ['Delete', 'Ctrl+D'], cat: 'Edit', run: () => A.remove(S_()) });
def('deleteForever', 'Delete permanently', { icon: 'trash', keys: ['Shift+Delete'], cat: 'Edit', run: () => A.remove(S_(), true) });
def('rename', 'Rename', { icon: 'rename', keys: ['F2'], cat: 'Edit', run: () => A.rename(S_()) });
def('batchRename', 'Rename Studio…', { icon: 'rename', keys: ['Ctrl+Shift+R'], cat: 'Edit', run: () => A.batchRename(S_().length ? S_() : T_().shown) });
def('newFolder', 'New folder', { icon: 'newFolder', keys: ['Ctrl+Shift+N'], cat: 'Edit', run: () => A.newFolder(T_()) });
def('newFile', 'New file…', { icon: 'newFile', keys: ['Ctrl+Alt+N'], cat: 'Edit', run: () => A.newFileNamed(T_()) });
def('newFolderSel', 'New folder with selection', { icon: 'newFolder', keys: ['Ctrl+Alt+Shift+N'], cat: 'Edit', run: () => A.newFolder(T_(), true) });
def('undo', 'Undo', { icon: 'undo', keys: ['Ctrl+Z'], cat: 'Edit', run: A.undo });
def('redo', 'Redo', { icon: 'redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], cat: 'Edit', run: A.redo });
def('copyToOther', 'Copy to other pane', { icon: 'copy', keys: ['F5'], cat: 'Edit', when: () => paneCount() > 1, run: () => { const o = otherPaneTab(); if (!o || isVirtual(o.path)) return toast('The other pane must show a folder'); A.transfer(S_().map((i) => i.path), o.path, 'copy'); } });
def('moveToOther', 'Move to other pane', { icon: 'cut', keys: ['F6'], cat: 'Edit', when: () => paneCount() > 1, run: () => { const o = otherPaneTab(); if (!o || isVirtual(o.path)) return toast('The other pane must show a folder'); A.transfer(S_().map((i) => i.path), o.path, 'move'); } });
def('copyTo', 'Copy to…', { icon: 'copyTo', cat: 'Edit', run: async () => { const d = await api('dialog:pickFolder', 'Copy to'); if (d) A.transfer(S_().map((i) => i.path), d, 'copy'); } });
def('moveTo', 'Move to…', { icon: 'moveTo', cat: 'Edit', run: async () => { const d = await api('dialog:pickFolder', 'Move to'); if (d) A.transfer(S_().map((i) => i.path), d, 'move'); } });
def('properties', 'Properties', { icon: 'info', keys: ['Alt+Enter'], cat: 'File', run: () => A.properties(S_()) });
def('winProperties', 'Windows properties', { icon: 'info', keys: ['Ctrl+Alt+Enter'], cat: 'File', run: () => { const s = S_(); api('shell:properties', s.length ? s.map((i) => i.path) : [T_().path]); } });
def('quickLook', 'Quick Look', { icon: 'eye', keys: ['Space'], cat: 'File', run: quickLook });
def('compress', 'Compress…', { icon: 'zip', keys: ['Ctrl+Alt+Z'], cat: 'File', run: () => A.compress(S_()) });
def('quickZip', 'Add to zip', { icon: 'zip', cat: 'File', run: () => A.quickZip(S_()) });
def('extract', 'Extract here', { icon: 'extract', keys: ['Ctrl+Alt+X'], cat: 'File', run: () => A.extract(S_()) });
def('extractTo', 'Extract to…', { icon: 'extract', cat: 'File', run: () => A.extract(S_(), 'choose') });
def('createShortcut', 'Create shortcut', { icon: 'link', cat: 'File', run: () => { const s = S_(); if (s.length) A.createShortcuts(s.map((i) => i.path), T_().path); } });
def('symlink', 'Create symbolic link…', { icon: 'link', cat: 'File', run: () => A.createSymlink(S_()) });
def('pin', 'Pin to sidebar', { icon: 'pin', cat: 'File', run: () => { const s = S_().filter((i) => i.isDir); A.pin(s.length ? s.map((i) => i.path) : [T_().path]); } });
def('runAsAdmin', 'Run as administrator', { icon: 'admin', keys: ['Ctrl+Shift+Enter'], cat: 'File', run: () => { const s = S_()[0]; if (s) api('shell:runAs', s.path); } });
def('showInExplorer', 'Show in Windows Explorer', { icon: 'folder', cat: 'File', run: () => { const s = S_()[0]; api('shell:showInExplorer', s ? s.path : T_().path, !!s); } });
def('windowsMenu', 'Windows context menu', { icon: 'hamburger', keys: ['Shift+F10', 'ContextMenu'], cat: 'File', run: () => { const el = paneEls[state.activePane]; const c = el?.inner.querySelector('.cell.focused') || el?.inner.querySelector('.cell.selected'); const r = (c || el.body).getBoundingClientRect(); const t = T_(); const s = S_(); if (s.length) A.itemsContextMenu(t, s, { clientX: r.left + 40, clientY: r.top + 30 }); else A.backgroundContextMenu(t, { clientX: r.left + 40, clientY: r.top + 30 }); } });

// ---------------- view ----------------
def('viewGrid', 'Grid view', { icon: 'viewGrid', keys: ['Ctrl+Shift+2'], cat: 'View', run: () => setView(T_(), 'grid') });
def('viewGallery', 'Gallery view', { icon: 'gallery', keys: ['Ctrl+Shift+8'], cat: 'View', run: () => setView(T_(), 'gallery') });
def('viewList', 'List view', { icon: 'viewDetails', keys: ['Ctrl+Shift+5'], cat: 'View', run: () => setView(T_(), 'list') });
def('viewDetails', 'Details view', { icon: 'viewList', keys: ['Ctrl+Shift+6'], cat: 'View', run: () => setView(T_(), 'details') });
def('viewColumns', 'Columns view', { icon: 'viewColumns', keys: ['Ctrl+Shift+7'], cat: 'View', run: () => setView(T_(), 'columns') });
def('zoomIn', 'Bigger items', { icon: 'zoomIn', keys: ['Ctrl+=', 'Ctrl+Plus'], cat: 'View', run: () => { const t = T_(); if (['details', 'list', 'columns'].includes(t.view)) t.rowZoom = Math.min(1.8, (t.rowZoom || 1) + 0.1); else t.gridSize = Math.min(320, (t.gridSize || state.settings.gridSize) + 24); touchView(t); renderTabPanes(t); } });
def('zoomOut', 'Smaller items', { icon: 'zoomOut', keys: ['Ctrl+-'], cat: 'View', run: () => { const t = T_(); if (['details', 'list', 'columns'].includes(t.view)) t.rowZoom = Math.max(0.8, (t.rowZoom || 1) - 0.1); else t.gridSize = Math.max(72, (t.gridSize || state.settings.gridSize) - 24); touchView(t); renderTabPanes(t); } });
def('toggleGlass', 'Glass sidebar (aero / liquid glass)', { icon: 'sidebar', cat: 'View', check: () => !!state.settings.sidebarGlass, run: () => { state.settings.sidebarGlass = !state.settings.sidebarGlass; saveSettings(); bus.emit('settings'); toast(state.settings.sidebarGlass ? 'Glass sidebar on' : 'Glass sidebar off'); } });
def('toggleHidden', 'Show hidden items', { icon: 'eye', keys: ['Ctrl+H', 'Ctrl+.'], cat: 'View', check: () => state.settings.showHidden, run: () => { state.settings.showHidden = !state.settings.showHidden; saveSettings(); state.tabs.forEach(recompute); renderAll(); toast(state.settings.showHidden ? 'Showing hidden items' : 'Hiding hidden items'); bus.emit('settings'); } });
def('toggleExt', 'Show file extensions', { icon: 'extension', cat: 'View', check: () => state.settings.showExtensions, run: () => { state.settings.showExtensions = !state.settings.showExtensions; saveSettings(); renderAll(); bus.emit('settings'); } });
def('toggleCheckboxes', 'Item check boxes', { icon: 'checkbox', cat: 'View', check: () => state.settings.showCheckboxes, run: () => { state.settings.showCheckboxes = !state.settings.showCheckboxes; saveSettings(); renderAll(); bus.emit('settings'); } });
def('toggleFolderSizes', 'Calculate folder sizes', { icon: 'chart', cat: 'View', check: () => state.settings.folderSizes, run: () => { state.settings.folderSizes = !state.settings.folderSizes; saveSettings(); loadTab(T_()); bus.emit('settings'); } });
def('themeSystem', 'Theme: System', { icon: 'monitor', cat: 'View', run: () => setTheme('system') });
def('themeLight', 'Theme: Light', { icon: 'sun', cat: 'View', run: () => setTheme('light') });
def('themeDark', 'Theme: Dark', { icon: 'moon', cat: 'View', run: () => setTheme('dark') });
def('cycleTheme', 'Cycle theme (System → Light → Dark)', { icon: 'sun', keys: ['Ctrl+Shift+L'], cat: 'View', run: () => setTheme({ system: 'light', light: 'dark', dark: 'system' }[state.settings.theme] || 'system') });
def('groupNone', 'Group by: none', { cat: 'View', run: () => { const t = T_(); t.group = null; touchView(t); recompute(t); renderTabPanes(t); } });
for (const g of ['type', 'kind', 'date', 'size', 'name', 'tag']) def('group_' + g, `Group by: ${g}`, { icon: 'group', cat: 'View', run: () => { const t = T_(); t.group = g; touchView(t); recompute(t); renderTabPanes(t); } });
for (const [k, l] of [['name', 'Name'], ['mtime', 'Date modified'], ['size', 'Size'], ['type', 'Type']]) def('sort_' + k, `Sort by ${l}`, { icon: 'sort', cat: 'View', run: () => { const t = T_(); t.sort = { key: k, dir: t.sort.key === k ? -t.sort.dir : 1 }; touchView(t); recompute(t); renderTabPanes(t); } });

// ---------------- tools ----------------
def('search', 'Search', { icon: 'search', keys: ['Ctrl+E', 'Ctrl+Shift+F'], cat: 'Tools', run: () => T.openSearchBar() });
def('advSearch', 'Advanced search…', { icon: 'filter', keys: ['Ctrl+Alt+F'], cat: 'Tools', run: () => T.advancedSearch() });
def('compare', 'Compare / sync folders', { icon: 'compare', keys: ['Ctrl+Alt+M'], cat: 'Tools', run: T.compareFolders });
def('dupes', 'Find duplicate files', { icon: 'dupes', cat: 'Tools', run: T.findDuplicates });
def('analyze', 'Analyze disk space', { icon: 'chart', keys: ['Ctrl+Alt+A'], cat: 'Tools', run: () => T.analyzeSpace() });
def('analyzeSelection', 'Calculate selection size', { icon: 'chart', cat: 'Tools', run: T.analyzeSelection });
def('terminal', 'Open terminal window here', { icon: 'terminal', keys: ['Ctrl+Alt+T'], cat: 'Tools', run: () => A.openTerminal(T_()) });
def('terminalDrawer', 'Toggle built-in terminal', { icon: 'terminal', keys: ['Ctrl+`', "Ctrl+'"], cat: 'Tools', run: () => bus.emit('toggleTerminal') });
def('shelf', 'Toggle Drop Shelf', { icon: 'shelf', keys: ['Ctrl+Shift+J'], cat: 'Tools', run: () => bus.emit('toggleShelf') });
def('addToShelf', 'Add selection to Drop Shelf', { icon: 'shelf', keys: ['Ctrl+Alt+J'], cat: 'Tools', run: () => { const s = S_().filter((i) => !i.virtual); if (s.length) bus.emit('addToShelf', s.map((i) => i.path)); } });
def('similarImages', 'Find similar pictures', { icon: 'photos', cat: 'Tools', run: () => T.findSimilarImages() });
def('folderNote', 'Add or edit folder note', { icon: 'rename', cat: 'Tools', run: () => bus.emit('addFolderNote', T_()) });
def('contactSheet', 'Make video contact sheet', { icon: 'viewGrid', cat: 'Media', run: () => import('./gallery.js').then((m) => m.contactSheets(S_())) });
def('similarMedia', 'Find similar videos & songs', { icon: 'dupes', cat: 'Media', run: () => import('./gallery.js').then((m) => m.findSimilarMedia()) });
def('analyzeFolderAudio', 'Analyze BPM & key of every song here', { icon: 'music', cat: 'Media', run: () => import('./gallery.js').then((m) => m.analyzeFolder()) });
def('mediaFilter', 'Media filter (colour, kind, length, BPM, key)…', { icon: 'filter', cat: 'Media', run: () => document.querySelector('.pane.active .mf-btn')?.click() });
def('history', 'File history (undo anything)…', { icon: 'history', keys: ['Ctrl+Shift+H'], cat: 'Tools', run: () => import('./history.js').then((m) => m.historyDialog()) });
def('versions', 'Versions of this file…', { icon: 'history', cat: 'File', run: () => import('./history.js').then((m) => m.versionsDialog()) });
def('allVersions', 'All saved versions…', { icon: 'history', cat: 'Tools', run: () => import('./history.js').then((m) => m.versionsOverview()) });
def('makeChecksums', 'Create checksum file…', { icon: 'shieldCheck', cat: 'Tools', run: () => import('./history.js').then((m) => m.createChecksums()) });
def('verifyChecksums', 'Verify checksums…', { icon: 'shieldCheck', cat: 'Tools', run: () => import('./history.js').then((m) => m.verifyChecksums()) });
def('assistant', 'Ask the file assistant…', { icon: 'sparkle', keys: ['Ctrl+J'], cat: 'Tools', run: () => import('./assistant.js').then((m) => m.toggleAssistant()) });
def('connections', 'Server connections (NAS, SFTP, FTP, WebDAV)…', { icon: 'server', cat: 'Tools', run: () => import('./network.js').then((m) => m.connectionsDialog()) });
def('addConnection', 'Add a server connection…', { icon: 'server', cat: 'Tools', run: () => import('./network.js').then((m) => m.editConnection(null)) });
def('clipHistory', 'Clipboard history…', { icon: 'clipboard', keys: ['Ctrl+Shift+V'], cat: 'Edit', run: () => import('./cliphistory.js').then((m) => m.showHistory()) });
def('fileTypes', 'File types (what opens each kind of file)…', { icon: 'open', cat: 'App', run: () => import('./assoc.js').then((m) => m.fileTypesDialog()) });
def('nextRegionF6', 'Move to the next area', { keys: ['F6'], cat: 'Navigate', hidden: true, when: () => paneCount() < 2, run: () => import('./a11y.js').then((m) => m.cycleRegion(false)) });
def('nextRegion', 'Move to the next area (sidebar, address bar, files, preview…)', { icon: 'keyboard', keys: ['Ctrl+F6'], cat: 'Navigate', run: () => import('./a11y.js').then((m) => m.cycleRegion(false)) });
def('prevRegion', 'Move to the previous area', { keys: ['Shift+F6', 'Ctrl+Shift+F6'], cat: 'Navigate', run: () => import('./a11y.js').then((m) => m.cycleRegion(true)) });
def('focusSidebar', 'Focus the sidebar', { keys: ['Ctrl+Shift+1'], cat: 'Navigate', run: () => { const el = document.querySelector('#side-list .side-item.active') || document.querySelector('#side-list .side-item'); el?.focus(); } });
def('features', 'Features (your own tools)…', { icon: 'puzzle', cat: 'Features', run: () => import('./features.js').then((m) => m.featuresManager()) });
def('createFeature', 'Add a feature…', { icon: 'plus', cat: 'Features', run: () => import('./features.js').then((m) => m.createFeature()) });
def('featureStore', 'Browse features (feature browser)…', { icon: 'store', cat: 'Features', run: () => import('./featurestore.js').then((m) => m.featureBrowser()) });
def('startMacro', 'Record a macro', { icon: 'record', cat: 'Macros', run: () => import('./macros.js').then((m) => m.startRecording()) });
def('stopMacro', 'Stop recording the macro', { icon: 'stop', cat: 'Macros', run: () => import('./macros.js').then((m) => m.stopRecording()) });
def('macros', 'Macros…', { icon: 'record', cat: 'Macros', run: () => import('./macros.js').then((m) => m.macrosManager()) });
def('cleanup', 'Storage cleanup…', { icon: 'broom', cat: 'Tools', run: () => import('./cleanup.js').then((m) => m.openCleanup()) });
def('folderRules', 'Automate this folder…', { icon: 'automation', cat: 'Tools', run: () => import('./rules.js').then((m) => m.automationDialog(T_()?.path)) });
def('automations', 'Folder automations…', { icon: 'automation', cat: 'Tools', run: () => import('./rules.js').then((m) => m.automationsManager()) });
def('newCollection', 'New smart collection…', { icon: 'collection', cat: 'Tools', run: () => import('./collections.js').then((m) => m.editCollection(null)) });
def('declutter', 'Tidy up this folder…', { icon: 'wand', cat: 'Tools', run: () => import('./declutter.js').then((m) => m.declutter()) });
def('renameWords', 'Rename by describing it…', { icon: 'rename', cat: 'Edit', run: () => A.batchRename(S_()) });
def('aiModels', 'AI models…', { icon: 'wand', cat: 'Tools', run: () => import('./ai.js').then((m) => m.modelsDialog()) });
def('flatten', 'Flatten this folder (all files in subfolders)', { icon: 'flatten', keys: ['Ctrl+Alt+B'], cat: 'View', run: () => { const t = T_(); if (isVirtual(t.path)) return toast('Open a folder first'); navigate(t, T.searchUrl({ root: t.path, kind: 'file', flatten: 1 })); } });
def('flattenSel', 'Flatten selected folder', { icon: 'flatten', cat: 'View', hidden: true, run: () => { const d = S_().find((i) => i.isDir && !i.virtual); if (d) navigate(T_(), T.searchUrl({ root: d.path, kind: 'file', flatten: 1 })); } });
def('gotoFile', 'Go to file…', { icon: 'search', keys: ['Ctrl+P'], cat: 'Navigate', run: () => palette('', 'files') });
def('notepad', 'Open Dogfile Notepad', { icon: 'notepad', cat: 'Tools', run: () => { const s = S_().filter((i) => !i.isDir && !i.virtual); openTool('editor', s.map((i) => i.path)); } });
def('player', 'Open Dogfile Player', { icon: 'film', cat: 'Tools', run: () => { const s = S_().filter((i) => !i.isDir && !i.virtual); openTool('player', s.map((i) => i.path), { play: true }); } });
def('whoLocks', 'What’s locking this?', { icon: 'lock', cat: 'Tools', run: () => { const s = S_(); if (s.length) bus.emit('whoLocks', s.map((i) => i.path)); } });
def('terminalAdmin', 'Open terminal as administrator', { icon: 'admin', keys: ['Ctrl+Shift+`'], cat: 'Tools', run: () => A.openTerminal(T_(), null, true) });
def('cmdHere', 'Open Command Prompt here', { icon: 'terminal', cat: 'Tools', run: () => A.openTerminal(T_(), 'cmd') });
def('psHere', 'Open PowerShell here', { icon: 'terminal', cat: 'Tools', run: () => A.openTerminal(T_(), 'powershell') });
def('editor', 'Open in code editor', { icon: 'code', keys: ['Ctrl+Shift+O'], cat: 'Tools', run: () => A.openInEditor(S_(), T_()) });
def('workspaces', 'Workspaces…', { icon: 'workspace', keys: ['Ctrl+Alt+W'], cat: 'Tools', run: () => import('./workspaces.js').then((m) => m.workspacesDialog()) });
def('profiles', 'Profiles (Work, Gaming, Music, Development…)…', { icon: 'user', cat: 'Tools', run: () => import('./workspaces.js').then((m) => m.profilesDialog()) });
def('pinToWorkspace', 'Pin selected files to this workspace', { icon: 'pin', cat: 'Tools', run: () => import('./workspaces.js').then((m) => m.pinFilesToWorkspace(S_().filter((i) => !i.isDir).map((i) => i.path))) });
def('saveWorkspace', 'Save workspace…', { icon: 'workspace', cat: 'Tools', run: async () => { const { prompt } = await import('./dialogs.js'); const n = await prompt('Save workspace', '', { label: 'Name' }); if (n) { const W = await import('./workspaces.js'); state.workspaces[n] = await W.captureWorkspace({ files: state.projectFiles || [] }); (await import('./core.js')).saveLibrary(); toast('Saved'); } } });
def('emptyRecycle', 'Empty Recycle Bin', { icon: 'recycle', cat: 'Tools', run: A.emptyRecycle });
def('hashes', 'Compute file hashes', { icon: 'hash', cat: 'Tools', run: () => A.properties(S_().slice(0, 1)) });
def('palette', 'Command palette', { icon: 'command', keys: ['Ctrl+Shift+P', 'Ctrl+K'], cat: 'App', run: () => palette() });
def('settings', 'Settings', { icon: 'settings', keys: ['Ctrl+,'], cat: 'App', run: () => bus.emit('openSettings') });
def('shortcuts', 'Keyboard shortcuts', { icon: 'keyboard', keys: ['F1', 'Ctrl+/'], cat: 'App', run: () => bus.emit('openSettings', 'keys') });
def('setDefault', 'Make Dogfile the default file manager', { icon: 'shield', cat: 'App', run: () => bus.emit('openSettings', 'general') });
def('devtools', 'Toggle developer tools', { keys: ['Ctrl+Shift+I'], cat: 'App', run: () => api('win:control', 'devtools') });
def('customizeToolbar', 'Customize toolbar…', { cat: 'View', icon: 'settings', run: () => import('./toolbar.js').then((m) => m.customizeToolbar()) });
def('quit', 'Quit', { keys: ['Ctrl+Q'], cat: 'App', run: async () => { if (await confirmLeaveAll()) api('win:control', 'quit'); } });
def('closeWindow', 'Close window', { keys: ['Ctrl+Shift+W', 'Alt+F4'], cat: 'App', run: () => api('win:control', 'close') });

// Tag shortcuts Alt+1..7
for (let i = 1; i <= 7; i++) def('tag' + i, `Toggle tag ${i}`, { keys: [`Alt+${i}`], cat: 'Tags', hidden: true, run: async () => { const d = state.tags.defs[i - 1]; const s = S_(); if (!d || !s.length) return; const { setTags, tagsOf } = await import('./core.js'); const on = !s.every((x) => tagsOf(x.path).includes(d.id)); setTags(s.map((x) => x.path), d.id, on); toast(`${on ? 'Tagged' : 'Untagged'} ${d.name}`); renderAll(); } });

// Dogfile Pro commands: a star in menus and the ribbon, and the Pro check before they run
for (const [id, f] of Object.entries(PRO_COMMANDS)) {
  const c = commands.get(id);
  if (!c) continue;
  const run = c.run;
  c.pro = f;
  c.run = (...a) => (requirePro(f) ? run(...a) : undefined);
}
bus.cmd = (id) => commands.get(id)?.run();

function setTheme(th) { state.settings.theme = th; saveSettings(); bus.emit('theme'); toast(`Theme: ${th[0].toUpperCase() + th.slice(1)}`); }
function cycleTab(d) {
  const t = T_(); const i = state.tabs.indexOf(t);
  const n = state.tabs[(i + d + state.tabs.length) % state.tabs.length];
  if (n) showTabInPane(n.id, state.activePane);
}

async function goToDialog() {
  const { prompt } = await import('./dialogs.js');
  const v = await prompt('Go to folder', isVirtual(T_().path) ? '' : T_().path, { label: 'Path, %ENV%, shell:folder or ~', placeholder: 'C:\\Projects' });
  if (v) navigate(T_(), v);
}

// ---------------- key handling ----------------
export function keysFor(id) {
  const o = state.settings.keybindings?.[id];
  return o || commands.get(id)?.keys || [];
}
export function comboFromEvent(e) {
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === '+' ) k = 'Plus';
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code === 'Backquote') k = '`';
  if (e.code === 'NumpadAdd') k = 'NumpadAdd';
  if (/^Digit\d$/.test(e.code) && (e.ctrlKey || e.altKey)) k = e.code.slice(5);
  if (k === 'Escape' || ['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return k;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !(k === 'Plus')) parts.push('Shift');
  if (k === '=' && e.ctrlKey) k = '=';
  parts.push(k === 'ArrowLeft' ? 'Left' : k === 'ArrowRight' ? 'Right' : k === 'ArrowUp' ? 'Up' : k === 'ArrowDown' ? 'Down' : k === 'Del' ? 'Delete' : k);
  return parts.join('+');
}
let keyMap = null;
export function rebuildKeymap() {
  keyMap = new Map();
  for (const c of commands.values()) for (const k of keysFor(c.id)) { if (!keyMap.has(k)) keyMap.set(k, []); keyMap.get(k).push(c); }
}
const PANE_ONLY = new Set(['Escape', 'Ctrl+Shift+D', 'Enter', 'Space', 'Backspace', 'Delete', 'Shift+Delete', 'F2', 'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Y', 'Tab', 'Shift+Tab', 'Ctrl+D', 'Ctrl+I', 'Shift+Enter', 'Ctrl+Enter', 'Ctrl+Insert', 'Shift+Insert', 'F5', 'F6', 'Alt+Enter']);
export function handleKey(e) {
  if (!keyMap) rebuildKeymap();
  const combo = comboFromEvent(e);
  const inField = e.target.matches('input, textarea, select, [contenteditable]');
  if (inField) return false;
  const list = keyMap.get(combo);
  if (!list) return false;
  const inPane = !!e.target.closest('.pane-body');
  if (PANE_ONLY.has(combo) && !inPane && document.activeElement !== document.body) return false;
  const c = list.find((x) => !x.when || x.when());
  if (!c) return false;
  e.preventDefault();
  closeMenus(0);
  c.run();
  return true;
}

// ---------------- command palette ----------------
// fuzzy subsequence score: consecutive & word-start matches score higher
function fuzzy(q, s) {
  if (!q) return 1;
  const low = s.toLowerCase();
  const idx = low.indexOf(q);
  if (idx >= 0) return 1000 - idx - s.length * 0.1 + (idx === 0 || /[\\/ _.-]/.test(low[idx - 1]) ? 200 : 0);
  let si = 0, score = 0, run = 0;
  for (const ch of q) {
    const f = low.indexOf(ch, si);
    if (f < 0) return 0;
    run = f === si ? run + 1 : 0;
    score += 10 + run * 5 + (f === 0 || /[\\/ _.-]/.test(low[f - 1]) ? 15 : 0);
    si = f + 1;
  }
  return score - s.length * 0.05;
}

// One search box for everything: commands, folders, recent files, settings, tags, collections, workspaces,
// profiles and server connections. Prefixes narrow it: > folders, # tags, @ settings, ? ask the assistant, / search.
export function palette(initial = '', mode = 'commands') {
  if (mode === 'files') return filePalette();
  const input = h('input', { class: 'input palette-input', placeholder: 'Search commands, folders, files, settings, tags, workspaces…   (> folders · # tags · @ settings · ? ask)', value: initial, 'aria-label': 'Command palette', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pl-list' });
  const list = h('div', { class: 'palette-list', id: 'pl-list', role: 'listbox' });
  let items = [], sel = 0;
  const all = [...commands.values()].filter((c) => !c.hidden);
  const score = (q, s) => { s = (s || '').toLowerCase(); if (!q) return 1; if (s.startsWith(q)) return 140; const i = s.indexOf(q); if (i >= 0) return 100 - Math.min(60, i); const words = q.split(/\s+/).filter(Boolean); if (words.length > 1 && words.every((w) => s.includes(w))) return 70; const initials = s.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join(''); if (q.length >= 2 && !q.includes(' ') && initials.includes(q)) return 40; const ws = s.split(/[^a-z0-9]+/); if (words.every((w) => ws.some((x) => x.startsWith(w)))) return 30; return 0; };
  let settingsIdx = [];
  import('./settings.js').then((m) => m.settingsIndex()).then((x) => { settingsIdx = x || []; draw(); }).catch(() => {});
  const recentCmds = () => state.settings.recentCommands || [];
  const folderPool = () => {
    const k = sys.known || {};
    const out = new Map();
    const add = (p, label, ic = 'folder', sub) => { if (p && !out.has(p)) out.set(p, { path: p, label: label || p.split(/[\\/]/).pop() || p, icon: ic, sub: sub || p }); };
    for (const p of state.pinned) add(p, null, 'pin');
    for (const [n, ic] of [['desktop', 'desktop'], ['documents', 'documents'], ['downloads', 'download'], ['pictures', 'photos'], ['videos', 'videos'], ['music', 'music'], ['home', 'home']]) add(k[n], n.charAt(0).toUpperCase() + n.slice(1), ic);
    for (const p of state.recent) add(p);
    for (const d of state.drives || []) add(d.path, d.name, 'drive');
    return [...out.values()];
  };
  const draw = () => {
    const raw = input.value;
    let q = raw.trim().toLowerCase();
    const groups = [];
    const push = (title, arr, max) => { if (arr.length) groups.push([title, arr.slice(0, max)]); };
    const prefix = q[0];
    if (prefix === '/') { items = [{ title: `Search for “${raw.trim().slice(1)}” here`, icon: 'search', run: () => T.searchHere(T_(), raw.trim().slice(1)) }]; return paint([['Search', items]]); }
    if (prefix === '?') { const qq = raw.trim().slice(1).trim(); items = [{ title: qq ? `Ask: “${qq}”` : 'Open the assistant', icon: 'sparkle', run: () => import('./assistant.js').then((m) => (qq ? m.askAssistant(qq) : m.toggleAssistant(true))) }]; return paint([['Assistant', items]]); }
    const only = prefix === '>' ? 'folders' : prefix === '#' ? 'tags' : prefix === '@' ? 'settings' : null;
    if (only) q = q.slice(1).trim();
    const rank = (arr, text) => arr.map((x) => ({ x, s: score(q, text(x)) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.x);
    if (!only || only === 'folders') {
      const folders = rank(folderPool(), (f) => f.label + ' ' + f.path);
      push('Folders', folders.map((f) => ({ title: f.label, sub: f.sub, icon: f.icon, run: () => navigate(T_(), f.path) })), only ? 40 : q ? 6 : 4);
    }
    if (!only) {
      let cmds = rank(all, (c) => c.title + ' ' + (c.cat || ''));
      if (!q) { const rc = recentCmds().map((id) => commands.get(id)).filter(Boolean); cmds = [...rc, ...cmds.filter((c) => !rc.includes(c))]; }
      push(q ? 'Commands' : 'Commands (recently used first)', cmds.map((c) => ({ title: c.title, cat: c.cat, keys: keysFor(c.id)[0], icon: c.icon, check: c.check?.(), run: () => { state.settings.recentCommands = [c.id, ...recentCmds().filter((x) => x !== c.id)].slice(0, 8); saveSettings(); c.run(); } })), q ? 8 : 6);
      const files = rank(state.recentFiles.map((p) => ({ p, n: p.split(/[\\/]/).pop() })), (f) => f.n + ' ' + f.p);
      push('Recent files', files.map((f) => ({ title: f.n, sub: f.p, icon: 'page', run: () => A.openItems([{ path: f.p, name: f.n, isDir: false, ext: (f.n.includes('.') ? f.n.split('.').pop() : '').toLowerCase() }]) })), q ? 6 : 3);
      const colls = rank(state.settings.collections || [], (c) => c.name);
      push('Collections', colls.map((c) => ({ title: c.name, icon: c.icon || 'collection', run: () => navigate(T_(), `atlas:search?coll=${encodeURIComponent(c.id)}`) })), 4);
      const ws = rank(Object.keys(state.workspaces), (n) => n + ' workspace');
      push('Workspaces', ws.map((n) => ({ title: n, cat: 'Workspace', icon: 'workspace', run: () => import('./workspaces.js').then((m) => m.openWorkspace(state.workspaces[n])) })), 4);
      const pf = rank(Object.keys(state.settings.profiles || {}), (n) => n + ' profile');
      push('Profiles', pf.map((n) => ({ title: n, cat: 'Profile', icon: 'user', check: state.settings.activeProfile === n, run: () => import('./workspaces.js').then((m) => m.switchProfile(n)) })), 4);
      const cn = rank(state.settings.connections || [], (c) => `${c.name} ${c.host} server connection`);
      push('Servers', cn.map((c) => ({ title: c.name || c.host, sub: `${c.type.toUpperCase()} · ${c.host}`, icon: 'server', run: () => import('./network.js').then((m) => m.openConnection(c)) })), 4);
    }
    if (!only || only === 'tags') {
      const tags = rank(state.tags.defs, (d) => d.name + ' tag');
      push('Tags', tags.map((d) => ({ title: d.name, cat: 'Tag', swatch: d.color, run: () => navigate(T_(), 'atlas:tag:' + d.id) })), only ? 30 : 4);
    }
    if ((!only && q.length >= 2) || only === 'settings') {
      const st = rank(settingsIdx, (x) => `${x.label} ${x.hint} ${x.sectionLabel}`);
      push('Settings', st.map((x) => ({ title: x.label, sub: x.sectionLabel, icon: 'settings', run: () => import('./settings.js').then((m) => m.openSettings(x.section, { search: x.label })) })), only ? 30 : 5);
    }
    if (!only && q && q.split(/\s+/).length >= 3) groups.push(['Assistant', [{ title: `Ask the assistant: “${raw.trim()}”`, icon: 'sparkle', run: () => import('./assistant.js').then((m) => m.askAssistant(raw.trim())) }]]);
    if (!only && q) groups.push(['Search', [{ title: `Search for “${raw.trim()}” here`, icon: 'search', run: () => T.searchHere(T_(), raw.trim()) }, { title: `Go to a file named “${raw.trim()}”…`, icon: 'page', run: () => palette(raw.trim(), 'files') }]]);
    paint(groups);
  };
  const paint = (groups) => {
    items = groups.flatMap(([, arr]) => arr);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let i = 0;
    list.innerHTML = groups.map(([title, arr]) => `<div class="pl-group" role="presentation">${esc(title)}</div>` + arr.map((it) => { const k = i++; return `<div class="pl-item${k === sel ? ' on' : ''}" data-i="${k}" role="option" id="pl-o${k}" aria-selected="${k === sel}">${it.swatch ? `<span class="pl-sw" style="background:${esc(it.swatch)}"></span>` : icon(it.icon || 'command')}<span class="pl-title">${esc(it.title)}${it.check ? ' ✓' : ''}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.cat ? `<span class="pl-cat">${esc(it.cat)}</span>` : ''}${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ''}</div>`; }).join('')).join('') || '<div class="hint pad">No matches</div>';
    input.setAttribute('aria-activedescendant', 'pl-o' + sel);
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  let closeFn;
  const run = (i) => { const it = items[i]; if (!it) return; closeFn(null); setTimeout(() => it.run(), 10); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(sel); }
  });
  const paintSel = () => { list.querySelectorAll('.pl-item').forEach((x) => { const on = +x.dataset.i === sel; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); }); input.setAttribute('aria-activedescendant', 'pl-o' + sel); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); };
  list.addEventListener('click', (e) => { const r = e.target.closest('.pl-item'); if (r) run(+r.dataset.i); });
  const body = h('div', { class: 'palette no-enter' }, input, list);
  draw();
  modal({ title: '', body, width: 680, className: 'palette-modal' });
  closeFn = () => document.querySelector('.palette-modal')?._close(null);
  setTimeout(() => input.focus(), 30);
}

// Ctrl+P: jump to any file: current folder, everything below it, recent files, pinned & recent folders
function filePalette() {
  const t = activeTab();
  const input = h('input', { class: 'input palette-input', placeholder: `Go to file${t.path && !isVirtual(t.path) ? ' in ' + (t.path.split(/[\\/]/).pop() || t.path) : ''}…  (Enter = show, Shift+Enter = open)` });
  const list = h('div', { class: 'palette-list' });
  const status = h('div', { class: 'hint', style: { padding: '6px 4px 0' } }, '');
  const pool = new Map();
  const add = (p, isDir, src) => { if (p && !pool.has(p)) pool.set(p, { path: p, name: p.split(/[\\/]/).pop() || p, isDir, src }); };
  for (const it of t.shown || []) add(it.path, it.isDir, 'here');
  for (const p of state.recentFiles) add(p, false, 'recent');
  for (const p of state.pinned) add(p, true, 'pinned');
  for (const p of state.recent) add(p, true, 'recent');
  let items = [], sel = 0, workId = null;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const scored = [];
    for (const c of pool.values()) {
      const sc = q ? Math.max(fuzzy(q, c.name) * 1.5, fuzzy(q, c.path) * 0.6) : (c.src === 'here' ? 3 : c.src === 'recent' ? 2 : 1);
      if (sc > 0) scored.push([sc + (c.src === 'here' ? 20 : 0), c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    items = scored.slice(0, 80).map((x) => x[1]);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<div class="pl-item${i === sel ? ' on' : ''}" data-i="${i}">${icon(it.isDir ? 'folder' : 'page')}<span class="pl-title">${esc(it.name)}</span><span class="pl-cat" style="max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.path.slice(0, -it.name.length - 1))}</span></div>`).join('') || '<div class="hint pad">No matches</div>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const go = (i, open) => {
    const it = items[i]; if (!it) return;
    closeFn();
    if (it.isDir) return navigate(T_(), it.path);
    if (open) return A.openItems([{ path: it.path, name: it.name, isDir: false, ext: (it.name.includes('.') ? it.name.split('.').pop() : '').toLowerCase() }]);
    navigate(T_(), it.path); // navigating to a file opens its folder with the file selected
  };
  // every drive at once from the instant index, as you type
  let idxSeq = 0;
  const askIndex = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const my = ++idxSeq;
    const r = await api('index:search', { query: q, limit: 80 }).catch(() => null);
    if (!r || my !== idxSeq) return;
    for (const it of r.items) add(it.path, it.isDir, 'index');
    status.textContent = `${r.total.toLocaleString()} matches on your drives · ${Math.max(1, Math.round(r.ms))} ms`;
    draw();
  }, 70);
  input.addEventListener('input', () => { sel = 0; draw(); askIndex(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(sel, e.shiftKey); }
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('.pl-item'); if (r) go(+r.dataset.i, e.shiftKey); });
  draw();
  modal({ title: '', body: h('div', { class: 'palette no-enter' }, input, list, status), width: 680, className: 'palette-modal', onClose: () => { if (workId) api('work:cancel', workId); } });
  const closeFn = () => document.querySelector('.palette-modal')?._close(null);
  setTimeout(() => input.focus(), 30);
  // index everything below the current folder in the background
  if (t.path && !isVirtual(t.path)) {
    status.textContent = 'Indexing subfolders…';
    api('work:start', { type: 'search', roots: [t.path], query: '', maxResults: 30000, skipDirs: ['node_modules', '.git', '__pycache__', '.venv', '$RECYCLE.BIN'] }).then((id) => {
      workId = id;
      const off = () => {};
      import('./core.js').then(({ onWorkMsgFor }) => onWorkMsgFor(id, (m) => {
        if (m.type === 'results') { for (const it of m.items) add(it.path, it.isDir, 'below'); status.textContent = `${pool.size.toLocaleString()} items indexed…`; drawSoon(); }
        if (m.type === 'done' || m.type === 'error') { off(); status.textContent = `${pool.size.toLocaleString()} items`; draw(); }
      }));
    });
  }
  const drawSoon = debounce(draw, 120);
}

