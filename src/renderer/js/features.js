// Features in the file browser: runs file-browser features, adds their commands to the palette and their
// items to the right-click menu, installs features (from Notepad, files or the feature browser) after showing
// what they may do, and the Features manager (turn on/off, edit, export, update, remove).
import { api, onMain, state, bus, h, esc, toast, saveSettings, basename, dirname, sys, uid } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, selectedItems, navigate, loadTab } from './pane.js';
import * as A from './actions.js';
import * as X from './extensions.js';
import { requirePro } from './license.js';

const list = () => (state.settings.extensions ||= []);
let host = null;
const simple = (i) => ({ path: i.path, name: i.name, ext: i.ext || '', isDir: !!i.isDir, size: i.size || 0, mtime: i.mtime || 0 });
async function registerCommands() {
  const { commands, rebuildKeymap } = await import('./commands.js');
  for (const k of [...commands.keys()]) if (k.startsWith('feature:')) commands.delete(k);
  for (const c of host.commands()) commands.set(`feature:${c.feature.id}:${c.id}`, { id: `feature:${c.feature.id}:${c.id}`, title: c.title, icon: c.icon || 'puzzle', keys: c.keys ? [].concat(c.keys) : [], cat: 'Features', run: () => c.run({ selection: selectedItems(activeTab()).map(simple), folder: activeTab()?.path }) });
  rebuildKeymap?.();
  state.featureMenus = host.menus();
  bus.emit('featuresChanged');
}
function start() {
  host = X.startFeatures({
    target: 'files', getSettings: () => state.settings, onChange: () => registerCommands(),
    provide: {
      'ctx.selection': () => selectedItems(activeTab()).filter((i) => !i.virtual).map(simple),
      'ctx.folder': () => activeTab()?.path || '',
      'ctx.navigate': (p) => { navigate(activeTab(), p); return true; },
      'ctx.refresh': () => { loadTab(activeTab(), { soft: true }); return true; },
      runJob: (spec) => A.runJob(spec),
      open: (p) => { A.openItems([{ path: p, name: basename(p), isDir: false, ext: (p.split('.').pop() || '').toLowerCase() }]); return true; },
      run: async (cmd, cwd) => { const ex = await import('./extras.js'); await ex.runInTerminal({ command: cmd, cwd: cwd || activeTab()?.path }); return true; },
      storageSet: (fid, k, v) => { const st = (state.settings.extStorage ||= {}); st[fid] = { ...(st[fid] || {}), [k]: v }; saveSettings(); return true; },
    },
  });
  // features' file-event listeners (dogfile.on) hear copies, moves, deletes, renames, drops…
  if (!hooked) { hooked = true; import('./hooks.js').then((H) => H.addHookSource((ev, p) => host.hook(ev, p))); }
}
let hooked = false;
// right-click menu items from features whose "when" fits the selection
export function featureMenuItems(items) {
  const menus = state.featureMenus || [];
  const ok = menus.filter((m) => {
    const w = m.when || {};
    if (w.files && items.some((i) => i.isDir)) return false;
    if (w.folders && items.some((i) => !i.isDir)) return false;
    if (w.ext) { const exts = [].concat(w.ext).map((e) => String(e).toLowerCase().replace(/^\./, '')); if (!items.every((i) => exts.includes((i.ext || '').toLowerCase()))) return false; }
    if (w.single && items.length !== 1) return false;
    return true;
  });
  return ok.map((m) => ({ label: m.title, icon: m.icon || 'puzzle', run: () => m.run({ selection: items.map(simple), folder: activeTab()?.path }) }));
}

// ---------------- installing ----------------
export async function install(code, { source, meta } = {}) {
  const f = await X.reviewInstall(code, { source, meta });
  if (!f) return null;
  const existing = list().find((x) => x.id === f.id);
  const rec = { ...existing, ...f, enabled: true, installed: existing?.installed || Date.now(), updated: Date.now(), source: source || 'local', storeRef: meta?.storeRef || existing?.storeRef || null };
  state.settings.extensions = [...list().filter((x) => x.id !== f.id), rec];
  saveSettings(); bus.emit('settings');
  host.reload();
  toast(`${existing ? 'Updated' : 'Installed'} “${f.name}”. ${f.target === 'files' ? 'Find it in the command palette, the Features menu or the right-click menu.' : `Find it in ${X.TARGETS[f.target]} under Features.`}`, { ms: 7000 });
  return rec;
}
onMain('ext:install', async (p) => {
  if (p?.manage) return featuresManager();
  if (p?.store) return import('./featurestore.js').then((m) => m.featureBrowser());
  if (p?.create) return createFeature(p.create);
  if (p?.code) return install(p.code, { source: p.source, meta: p.meta });
});
export async function createFeature(target) {
  if (!requirePro('features')) return;
  const pick = await X.pickStarter(target);
  if (!pick) return;
  if (pick.action === 'install') return install(pick.code, { source: 'Example' });
  const base = (await api('store:path')) + (sys.platform === 'win32' ? '\\Features' : '/Features');
  await api('fs:mkdir', base).catch(() => {});
  const file = await api('fs:uniqueName', base, `${String(pick.name).replace(/[\\/:*?"<>|]/g, '_')}.dogmod.js`, 'number');
  await api('fs:writeText', file, pick.code);
  const { openTool } = await import('./apptabs.js');
  openTool('editor', [file]);
  toast('Change it in Notepad, then press Features > Install. Press F1 there for help.', { ms: 6000 });
}
export async function importFeature(path) {
  if (!path) { const f = await api('dialog:openFiles', { title: 'Import a feature', filters: [{ name: 'Dogfile mod', extensions: ['dogmod', 'atlasfeature', 'js', 'json'] }] }); path = f?.[0]; }
  if (!path) return;
  const t = (await api('fs:readText', path, 2 * 1048576)).text;
  const j = X.readFeatureFile(t);
  return install(j.code, { source: path, meta: j.dogmod || j.atlasFeature ? j : null });
}
export async function exportFeature(f) {
  const p = await api('dialog:saveFile', { title: 'Export feature', defaultPath: `${(f.name || 'feature').replace(/[\\/:*?"<>|]/g, '_')}.dogmod`, filters: [{ name: 'Dogfile mod', extensions: ['atlasfeature'] }] });
  if (!p) return;
  await api('fs:writeText', p, X.featureFile(f));
  toast('Exported', { action: { label: 'Show', run: () => navigate(activeTab(), dirname(p), { select: p }) } });
}

// ---------------- manager ----------------
export async function featuresManager() {
  if (!requirePro('features')) return;
  const box = h('div', { class: 'ws-list' });
  const draw = () => {
    box.innerHTML = '';
    if (!list().length) box.append(h('div', { class: 'hint pad' }, 'No features yet. Make one in Dogfile Notepad, import a .dogmod file, or browse what others made.'));
    for (const f of list()) {
      const on = h('input', { type: 'checkbox', class: 'switch', title: 'On / off' }); on.checked = f.enabled !== false;
      on.onchange = () => { f.enabled = on.checked; saveSettings(); bus.emit('settings'); host.reload(); };
      const err = host.errors.get(f.id);
      box.append(h('div', { class: 'ws-row ext-row' }, on, h('div', { class: 'hi-main' }, h('b', {}, f.name || f.id), h('span', { class: 'hint' }, [X.TARGETS[f.target] || f.target, f.version ? `v${f.version}` : '', f.author ? `by ${f.author}` : '', (f.permissions || []).length ? 'can ' + f.permissions.map((p) => X.PERMS[p]?.[0].toLowerCase()).join(', ') : 'no file or internet access', f.storeRef ? 'from the feature browser' : ''].filter(Boolean).join(' · ')), f.description ? h('span', { class: 'hint' }, f.description) : null, err ? h('span', { class: 'ext-err' }, err.split('\n')[0]) : null),
        h('div', { class: 'hi-acts' },
          h('button', { class: 'btn small', title: 'Open the code in Dogfile Notepad', onclick: async () => { const base = (await api('store:path')) + (sys.platform === 'win32' ? '\\Features' : '/Features'); await api('fs:mkdir', base).catch(() => {}); const p = `${base}${sys.platform === 'win32' ? '\\' : '/'}${(f.name || f.id).replace(/[\\/:*?"<>|]/g, '_')}.dogmod.js`; await api('fs:writeText', p, f.code); (await import('./apptabs.js')).openTool('editor', [p]); closeIt(); toast('Edit, then press Features > Install in Notepad to update it'); } }, 'Edit'),
          h('button', { class: 'icon-btn small', title: 'Export as a .dogmod file', html: icon('downloadArrow'), onclick: () => exportFeature(f) }),
          f.storeRef ? h('button', { class: 'icon-btn small', title: 'Check for an update', html: icon('refresh'), onclick: () => import('./featurestore.js').then((m) => m.checkUpdate(f)) }) : null,
          h('button', { class: 'icon-btn small', title: 'Remove', html: icon('trash'), onclick: async () => { if (await confirm('Remove feature?', `Remove “${esc(f.name)}”?`, { ok: 'Remove', danger: true })) { state.settings.extensions = list().filter((x) => x.id !== f.id); saveSettings(); bus.emit('settings'); host.reload(); draw(); } } }))));
    }
  };
  draw();
  const off = bus.on('featuresChanged', draw);
  let closeIt = () => {};
  const p = modal({ title: 'Features', width: 720, className: 'ext-modal', onClose: off, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Features add your own tools to Dogfile, Notepad, Photos and Player. They only get the access you allow.'), box), buttons: [
    { label: 'Create…', left: true, run: () => { closeIt(); createFeature(); } },
    { label: 'Import…', left: true, run: async () => { await importFeature(); draw(); return false; } },
    { label: 'Browse features…', left: true, run: () => { closeIt(); import('./featurestore.js').then((m) => m.featureBrowser()); } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.ext-modal')?._close?.(null); }, 0);
  return p;
}
bus.on('featuresManager', featuresManager);
setTimeout(start, 1200);
