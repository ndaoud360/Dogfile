// Workspaces 2.0 and profiles.
// A workspace saves a whole working environment: tabs and split layout, each tab's view, sorting and filters,
// open Notepad documents, the terminal and its folder, the sidebar and preview pane, and pinned project files.
// A profile (Work, Gaming, Music production, Development…) is a bigger switch: its own look and settings, its own
// pinned folders, and the workspace it was left in. Switching profiles brings all of that back.
import { api, state, sys, bus, h, esc, toast, saveSettings, saveLibrary, basename, dirname, IS_WIN, fmtDate, uid } from './core.js';
import { modal, prompt, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate, selectedItems, recompute, renderTabPanes, tabById } from './pane.js';
import { snapshot, restoreSnapshot } from './tools.js';
import { showMenu } from './menu.js';

// ---------------- workspaces ----------------
export async function captureWorkspace({ files = [] } = {}) {
  const base = snapshot();
  const tabs = state.tabs.filter((t) => !t.app);
  base.tabs = base.tabs.map((st, i) => ({ ...st, filter: tabs[i]?.filter || '', tagFilter: tabs[i]?.tagFilter || null, mf: tabs[i]?.mf || null }));
  base.apps = state.tabs.filter((t) => t.app === 'editor' && t.appPath).map((t) => ({ app: 'editor', path: t.appPath }));
  const ex = await import('./extras.js');
  const term = ex.terminalState?.() || {};
  base.terminal = { open: !!term.open, cwd: term.cwd || null };
  base.ui = { sidebarCollapsed: !!state.settings.sidebarCollapsed, showPreview: !!state.settings.showPreview };
  base.files = files;
  base.version = 2;
  base.saved = Date.now();
  return base;
}
export async function openWorkspace(ws) {
  if (!ws) return;
  restoreSnapshot(ws);
  const tabs = state.tabs.filter((t) => !t.app);
  (ws.tabs || []).forEach((st, i) => { const t = tabs[i]; if (!t) return; t.filter = st.filter || ''; t.tagFilter = st.tagFilter || null; t.mf = st.mf || null; });
  if (ws.ui) { state.settings.showPreview = !!ws.ui.showPreview; state.settings.sidebarCollapsed = !!ws.ui.sidebarCollapsed; saveSettings(); bus.emit('settings'); }
  bus.emit('rebuild');
  if (ws.apps?.length) { const { openTool } = await import('./apptabs.js'); for (const a of ws.apps) openTool(a.app, [a.path]); }
  const ex = await import('./extras.js');
  if (ws.terminal?.open) ex.openTerminalAt?.(ws.terminal.cwd); else ex.closeTerminal?.();
  state.projectFiles = ws.files || [];
  bus.emit('projectFiles');
}
export async function workspacesDialog() {
  const list = h('div', { class: 'ws-list' });
  const draw = () => {
    list.innerHTML = '';
    const names = Object.keys(state.workspaces);
    if (!names.length) list.append(h('div', { class: 'hint pad' }, 'No workspaces yet. Set up your tabs, split view and folders the way you like, then press “Save current…”.'));
    for (const n of names) {
      const w = state.workspaces[n];
      const tabsN = (w.tabs || []).length, layout = { 1: 'one pane', '2v': 'two panes', '2h': 'two panes', 3: 'three panes', 4: 'four panes' }[w.layout] || 'one pane';
      const bits = [`${tabsN} tab${tabsN === 1 ? '' : 's'}`, layout, w.apps?.length ? `${w.apps.length} document${w.apps.length === 1 ? '' : 's'}` : '', w.terminal?.open ? 'terminal' : '', w.files?.length ? `${w.files.length} pinned file${w.files.length === 1 ? '' : 's'}` : '', w.saved ? `saved ${fmtDate(w.saved)}` : ''].filter(Boolean);
      list.append(h('div', { class: 'ws-row' }, h('span', { class: 'hi-ic', html: icon('workspace') }), h('div', { class: 'hi-main' }, h('b', {}, n), h('span', { class: 'hint' }, bits.join(' · ')), h('span', { class: 'hint ws-paths' }, (w.tabs || []).slice(0, 4).map((t) => basename(t.path || '') || t.path).join(', '))),
        h('div', { class: 'hi-acts' },
          h('button', { class: 'btn small primary', onclick: () => { closeIt(); openWorkspace(w); toast(`Workspace “${n}”`); } }, 'Open'),
          h('button', { class: 'btn small', title: 'Replace it with what is open now', onclick: async () => { state.workspaces[n] = await captureWorkspace({ files: w.files || [] }); saveLibrary(); toast('Updated'); draw(); } }, 'Update'),
          h('button', { class: 'icon-btn small', title: 'Rename', html: icon('rename'), onclick: async () => { const nn = await prompt('Rename workspace', n); if (nn && nn !== n) { state.workspaces[nn] = w; delete state.workspaces[n]; saveLibrary(); draw(); } } }),
          h('button', { class: 'icon-btn small', title: 'Delete', html: icon('trash'), onclick: async () => { if (await confirm('Delete workspace?', `“${esc(n)}” will be removed. Your files are not touched.`, { ok: 'Delete', danger: true })) { delete state.workspaces[n]; saveLibrary(); draw(); } } }))));
    }
  };
  draw();
  let closeIt = () => {};
  const p = modal({ title: 'Workspaces', width: 680, className: 'ws-modal', body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'A workspace remembers your tabs, layout and open documents, so you can jump back in later.'), list), buttons: [
    { label: 'Save current…', left: true, run: async () => { const n = await prompt('Save workspace', '', { label: 'Name', placeholder: 'e.g. Wedding video edit' }); if (!n) return false; state.workspaces[n] = await captureWorkspace({ files: state.projectFiles || [] }); saveLibrary(); toast(`Workspace “${n}” saved`); draw(); return false; } },
    { label: 'Profiles…', left: true, run: () => { closeIt(); profilesDialog(); } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.ws-modal')?._close?.(null); }, 0);
  return p;
}
// pinned project files (shown in the sidebar while the workspace is open)
export function pinFilesToWorkspace(paths) {
  state.projectFiles = [...new Set([...(state.projectFiles || []), ...paths])];
  bus.emit('projectFiles');
  toast(`Pinned ${paths.length} file${paths.length === 1 ? '' : 's'}. Save or update a workspace to keep them with it.`);
}

// ---------------- profiles ----------------
const PROFILE_KEYS = ['theme', 'accent', 'uiMode', 'defaultView', 'showHidden', 'showExtensions', 'gridSize', 'gridLabels', 'sidebarSections', 'showPreview', 'toolsInTabs', 'mediaColumns', 'gitBadges', 'terminalShell', 'folderSizes', 'density', 'fontScale', 'sizeBars', 'showCheckboxes'];
export function profileTemplates() {
  const k = sys.known || {};
  const j = (...a) => a.filter(Boolean).join(IS_WIN() ? '\\' : '/');
  return {
    Work: { icon: 'documents', settings: { defaultView: 'details', showHidden: false, uiMode: 'full' }, pinned: [k.documents, k.desktop, k.downloads].filter(Boolean) },
    Gaming: { icon: 'monitor', settings: { theme: 'dark', defaultView: 'gallery', gridSize: 200 }, pinned: [k.videos, j(k.pictures, 'Screenshots'), IS_WIN() ? 'C:\\Program Files (x86)\\Steam\\steamapps\\common' : null, IS_WIN() ? 'C:\\Program Files\\Epic Games' : null, IS_WIN() ? j(k.videos, 'Captures') : null].filter(Boolean) },
    'Music production': { icon: 'music', settings: { theme: 'dark', defaultView: 'details', mediaColumns: true, sizeBars: true }, pinned: [k.music, k.downloads, j(k.documents, 'Image-Line'), j(k.documents, 'Ableton')].filter(Boolean) },
    Development: { icon: 'code', settings: { theme: 'dark', defaultView: 'details', showHidden: true, showExtensions: true, gitBadges: true }, pinned: [j(k.home, 'source', 'repos'), j(k.home, 'Projects'), j(k.home, 'dev'), k.documents].filter(Boolean), terminal: true },
  };
}
const profiles = () => (state.settings.profiles ||= {});
async function captureProfile(name) {
  const p = profiles()[name] || { name };
  p.settings = Object.fromEntries(PROFILE_KEYS.filter((k) => k in state.settings).map((k) => [k, JSON.parse(JSON.stringify(state.settings[k]))]));
  p.pinned = [...state.pinned];
  p.workspace = await captureWorkspace({ files: state.projectFiles || [] });
  profiles()[name] = p;
  return p;
}
export async function switchProfile(name) {
  const cur = state.settings.activeProfile;
  if (cur === name) return;
  if (cur && profiles()[cur]) await captureProfile(cur);
  const p = profiles()[name];
  if (!p) return;
  Object.assign(state.settings, JSON.parse(JSON.stringify(p.settings || {})));
  state.settings.activeProfile = name;
  if (p.pinned) { const ok = []; for (const x of p.pinned) if (await api('fs:stat', x)) ok.push(x); state.pinned = ok; saveLibrary(); }
  saveSettings();
  bus.emit('theme'); bus.emit('settings'); bus.emit('sidebar');
  document.body.classList.toggle('ui-simple', state.settings.uiMode === 'simple');
  if (p.workspace) await openWorkspace(p.workspace);
  else if (p.terminal) (await import('./extras.js')).openTerminalAt?.(state.pinned[0]);
  state.tabs.forEach((t) => { if (!t.app) recompute(t); });
  drawChip();
  toast(`Profile: ${name}`);
}
export async function profilesDialog() {
  const list = h('div', { class: 'ws-list' });
  const draw = () => {
    list.innerHTML = '';
    const ps = profiles();
    if (!Object.keys(ps).length) list.append(h('div', { class: 'hint pad' }, 'No profiles yet. Start from one below, or save how things are now as a profile.'));
    for (const [n, p] of Object.entries(ps)) {
      const on = state.settings.activeProfile === n;
      list.append(h('div', { class: 'ws-row' + (on ? ' on' : '') }, h('span', { class: 'hi-ic', html: icon(p.icon || 'user') }), h('div', { class: 'hi-main' }, h('b', {}, n + (on ? ' (current)' : '')), h('span', { class: 'hint' }, [`${(p.pinned || []).length} pinned folder${(p.pinned || []).length === 1 ? '' : 's'}`, p.settings?.theme ? `${p.settings.theme} theme` : '', p.settings?.defaultView ? `${p.settings.defaultView} view` : '', p.workspace ? `${(p.workspace.tabs || []).length} tabs` : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'hi-acts' }, on ? h('button', { class: 'btn small', onclick: async () => { await captureProfile(n); saveSettings(); toast('Profile updated'); draw(); } }, 'Update from now') : h('button', { class: 'btn small primary', onclick: async () => { closeIt(); await switchProfile(n); } }, 'Switch'),
          h('button', { class: 'icon-btn small', title: 'Rename', html: icon('rename'), onclick: async () => { const nn = await prompt('Rename profile', n); if (nn && nn !== n) { ps[nn] = { ...p, name: nn }; delete ps[n]; if (state.settings.activeProfile === n) state.settings.activeProfile = nn; saveSettings(); draw(); drawChip(); } } }),
          h('button', { class: 'icon-btn small', title: 'Delete', html: icon('trash'), onclick: async () => { if (await confirm('Delete profile?', `“${esc(n)}” will be removed.`, { ok: 'Delete', danger: true })) { delete ps[n]; if (state.settings.activeProfile === n) state.settings.activeProfile = null; saveSettings(); draw(); drawChip(); } } }))));
    }
  };
  draw();
  const tpl = profileTemplates();
  let closeIt = () => {};
  const starters = h('div', { class: 'row-inline wrap' }, h('span', { class: 'hint' }, 'Start from:'), ...Object.entries(tpl).map(([n, t]) => h('button', { class: 'chip', html: icon(t.icon) + `<span>${esc(n)}</span>`, onclick: async () => {
    if (!state.settings.activeProfile) { await captureProfile('My setup'); state.settings.activeProfile = 'My setup'; }
    const name = profiles()[n] ? `${n} ${Object.keys(profiles()).length + 1}` : n;
    profiles()[name] = { name, icon: t.icon, settings: { ...Object.fromEntries(PROFILE_KEYS.filter((k) => k in state.settings).map((k) => [k, state.settings[k]])), ...t.settings }, pinned: t.pinned, terminal: !!t.terminal };
    saveSettings(); draw(); drawChip();
  } })));
  const p = modal({ title: 'Profiles', width: 680, className: 'pf-modal', body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Each profile keeps its own theme and view settings, pinned folders and the tabs it was left with. Switch from the status bar or the command palette.'), starters, list), buttons: [
    { label: 'Save current as profile…', left: true, run: async () => { const n = await prompt('New profile', '', { label: 'Name', placeholder: 'e.g. Photo editing' }); if (!n) return false; await captureProfile(n); profiles()[n].icon = 'user'; if (!state.settings.activeProfile) state.settings.activeProfile = n; saveSettings(); draw(); drawChip(); return false; } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.pf-modal')?._close?.(null); }, 0);
  return p;
}
// status bar chip: current profile, click to switch
let chip = null;
function drawChip() {
  const host = document.getElementById('statusbar');
  if (!host) return;
  const ps = Object.keys(profiles());
  if (!ps.length) { chip?.remove(); chip = null; return; }
  if (!chip) { chip = h('button', { class: 'chip pf-chip', title: 'Switch profile' }); chip.onclick = (e) => { const r = chip.getBoundingClientRect(); showMenu([{ header: 'Profiles' }, ...Object.keys(profiles()).map((n) => ({ label: n, icon: profiles()[n].icon || 'user', checked: state.settings.activeProfile === n, run: () => switchProfile(n) })), { separator: true }, { label: 'Manage profiles…', icon: 'settings', run: profilesDialog }, { label: 'Workspaces…', icon: 'workspace', run: workspacesDialog }], r.left, r.top - 8, { above: true }); }; host.querySelector('#ops-btn')?.before(chip); }
  const cur = state.settings.activeProfile;
  chip.innerHTML = icon(profiles()[cur]?.icon || 'user') + `<span>${esc(cur || 'Profiles')}</span>`;
}
bus.on('settings', drawChip);
setTimeout(drawChip, 800);
bus.on('workspaces', workspacesDialog);
bus.on('profiles', profilesDialog);
