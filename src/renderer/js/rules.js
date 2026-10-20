// Folder automations: "when a file lands in this folder, do this". Each folder gets a list of when→then rules
// (by extension, type, size, name, age; move/copy into a subfolder, tag, recycle, or sort by type / topic / month).
// Atlas watches the folders while it is running and applies the rules to new files once they finish downloading
// or copying. "Run now" previews what would happen to the files already there.
import { api, onMain, state, bus, h, esc, toast, pjoin, basename, isVirtual, saveSettings, uid, fmtSize, setTags, sys } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, loadTab } from './pane.js';
import * as A from './actions.js';
import { planRules, describeRule, KIND_FOLDERS, SIZE_UNITS } from './organize.js';

const autos = () => (state.settings.automations ||= []);
const PARTIAL = /\.(crdownload|part|partial|tmp|download|opdownload|!ut|downloading|filepart)$/i;
const isAbs = (p) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p || '');

// ---------------- runner ----------------
const baseline = new Map(); // folder -> Set(names already handled)
const pending = new Map(); // folder -> timer
async function listLoose(folder) {
  const r = await api('fs:list', folder);
  if (r.error) return null;
  return r.items;
}
async function snapshotFolder(folder) { const items = await listLoose(folder); if (items) baseline.set(folder, new Set(items.map((i) => i.name))); }
export async function syncWatches() {
  const dirs = autos().filter((a) => a.on !== false && a.watch !== false).map((a) => a.folder);
  const mf = await import('./macros.js').then((m) => m.macroFolders()).catch(() => []);
  for (const d of [...dirs, ...mf]) if (!baseline.has(d)) snapshotFolder(d);
  api('rules:watch', [...new Set([...dirs, ...mf])]);
}
// macros that run when new files arrive in a folder
async function macroWatch(dir) {
  const items = await listLoose(dir);
  if (!items) return;
  const seen = baseline.get(dir) || new Set();
  const fresh = items.filter((i) => !seen.has(i.name) && !i.hidden);
  if (!fresh.length) return;
  const ready = [];
  for (const f of fresh) { if (f.isDir || (await stable(f))) ready.push(f); else setTimeout(() => macroWatch(dir), 4000); }
  for (const f of ready) seen.add(f.name);
  baseline.set(dir, seen);
  if (ready.length) bus.emit('folderNewFiles', { dir, files: ready.map((f) => f.path) });
}
onMain('rules:changed', ({ dir }) => {
  clearTimeout(pending.get(dir));
  pending.set(dir, setTimeout(async () => {
    const isMacro = await import('./macros.js').then((m) => m.macroFolders().some((f) => f.toLowerCase() === dir.toLowerCase())).catch(() => false);
    if (autos().some((a) => a.folder === dir && a.on !== false)) await runNew(dir);
    if (isMacro) macroWatch(dir);
  }, 1500));
});

async function stable(f) {
  if (PARTIAL.test(f.name)) return false;
  const a = await api('fs:stat', f.path);
  await new Promise((r) => setTimeout(r, 1200));
  const b = await api('fs:stat', f.path);
  return a && b && a.size === b.size && a.mtime === b.mtime;
}
async function runNew(folder) {
  const auto = autos().find((a) => a.folder === folder && a.on !== false);
  if (!auto) return;
  const items = await listLoose(folder);
  if (!items) return;
  const seen = baseline.get(folder) || new Set();
  const fresh = items.filter((i) => !seen.has(i.name) && !i.isDir && !i.hidden);
  for (const i of items) if (i.isDir) seen.add(i.name);
  baseline.set(folder, seen);
  if (!fresh.length) return;
  const ready = [];
  for (const f of fresh) { if (await stable(f)) ready.push(f); else setTimeout(() => runNew(folder), 4000); }
  if (!ready.length) return;
  for (const f of ready) seen.add(f.name);
  const plan = planRules(auto.rules || [], ready, { existingDirs: items.filter((i) => i.isDir).map((i) => i.name), folderName: basename(folder) });
  if (!plan.length) return;
  const n = await execute(folder, plan);
  if (n) {
    toast(`${auto.name || basename(folder)}: sorted ${n} new file${n === 1 ? '' : 's'}`, { action: { label: 'Undo', run: () => bus.cmd('undo') }, ms: 6000 });
    bus.emit('history', { kind: 'automation', title: `Automation in ${basename(folder)}`, detail: plan.map((p) => `${p.file.name} → ${p.dest || p.action}`).slice(0, 50), at: Date.now() });
  }
}

export async function execute(folder, plan) {
  let n = 0;
  const groups = new Map();
  for (const p of plan) {
    const k = `${p.action}|${p.dest || ''}|${p.tag || ''}`;
    if (!groups.has(k)) groups.set(k, { ...p, files: [] });
    groups.get(k).files.push(p.file.path);
  }
  for (const g of groups.values()) {
    if (g.action === 'tag') { setTags(g.files, g.tag, true); n += g.files.length; continue; }
    if (g.action === 'recycle') { const j = await A.runJob({ type: 'trash', sources: g.files }); if (j.status === 'done') n += g.files.length; continue; }
    const name = String(g.dest || '').trim();
    if (!name) continue;
    const dir = isAbs(name) ? name : pjoin(folder, name.replace(/[<>:"|?*]/g, '_'));
    if (!(await api('fs:stat', dir))) await api('fs:mkdir', dir).catch(() => {});
    const j = await A.transfer(g.files, dir, g.action === 'copy' ? 'copy' : 'move', { conflict: 'keepBoth' });
    if (j?.status === 'done') n += g.files.length;
  }
  for (const id of [...baseline.keys()]) if (id === folder) snapshotFolder(folder);
  return n;
}

// ---------------- editor ----------------
const FIELD_OPTS = [['any', 'Any file'], ['ext', 'Extension is'], ['kind', 'Type is'], ['size', 'Size'], ['name', 'Name'], ['age', 'Last changed']];
const ACTIONS = [['move', 'Move into folder'], ['copy', 'Copy to folder'], ['byName', 'Sort into folders by topic in the name'], ['byKind', 'Sort into folders by type'], ['byMonth', 'Sort into month folders'], ['byYear', 'Sort into year folders'], ['bySize', 'Sort into size folders'], ['tag', 'Add a tag'], ['recycle', 'Move to Recycle Bin']];
export const PRESETS = {
  byKind: { name: 'Sort everything by type', conditions: [], action: { type: 'byKind' } },
  byName: { name: 'Group files by the topic in their names', conditions: [], action: { type: 'byName' } },
  byMonth: { name: 'Month folders', conditions: [], action: { type: 'byMonth' } },
  installers: { name: 'Installers', conditions: [{ field: 'ext', value: 'exe, msi, msix, appx' }], action: { type: 'move', target: 'Installers' } },
  pngs: { name: 'PNG files', conditions: [{ field: 'ext', value: 'png' }], action: { type: 'move', target: 'PNG' } },
  big: { name: 'Big files', conditions: [{ field: 'size', op: '>=', num: 1, unit: 'GB' }], action: { type: 'move', target: 'Large files' } },
  screenshots: { name: 'Screenshots', conditions: [{ field: 'name', op: 'contains', value: 'screenshot' }], action: { type: 'move', target: 'Screenshots' } },
};

function ruleEditor(rule, onChange, onRemove, onMove) {
  const box = h('div', { class: 'ru-rule' + (rule.on === false ? ' off' : '') });
  const draw = () => {
    box.innerHTML = '';
    box.classList.toggle('off', rule.on === false);
    const on = h('input', { type: 'checkbox', class: 'switch', title: 'Rule on/off' }); on.checked = rule.on !== false;
    on.onchange = () => { rule.on = on.checked; draw(); onChange(); };
    const head = h('div', { class: 'ru-head' }, on, h('b', {}, 'If'),
      (() => { const s = h('select', { class: 'input sm' }, h('option', { value: 'all' }, 'all of these are true'), h('option', { value: 'any' }, 'any of these is true')); s.value = rule.match || 'all'; s.onchange = () => { rule.match = s.value; onChange(); }; return (rule.conditions || []).length > 1 ? s : null; })(),
      h('span', { class: 'st-spacer' }),
      h('button', { class: 'icon-btn small', title: 'Move up', html: icon('up'), onclick: () => onMove(-1) }),
      h('button', { class: 'icon-btn small', title: 'Move down', html: icon('down'), onclick: () => onMove(1) }),
      h('button', { class: 'icon-btn small', title: 'Remove rule', html: icon('trash'), onclick: onRemove }));
    box.append(head);
    const conds = rule.conditions || (rule.conditions = []);
    if (!conds.length) conds.push({ field: 'any' });
    conds.forEach((c, i) => {
      const row = h('div', { class: 'ru-cond' });
      const field = h('select', { class: 'input sm' }, ...FIELD_OPTS.map(([v, l]) => h('option', { value: v }, l))); field.value = c.field;
      field.onchange = () => { Object.keys(c).forEach((k) => delete c[k]); c.field = field.value; if (c.field === 'kind') c.value = 'Pictures'; if (c.field === 'size') Object.assign(c, { op: '>', num: 100, unit: 'MB' }); if (c.field === 'age') Object.assign(c, { op: '>', num: 30 }); if (c.field === 'name') c.op = 'contains'; draw(); onChange(); };
      row.append(field);
      const inp = (k, ph, w) => { const x = h('input', { class: 'input sm', placeholder: ph, style: w ? { width: w } : null }); x.value = c[k] ?? ''; x.oninput = () => { c[k] = x.value; onChange(); }; x.addEventListener('keydown', (e) => e.stopPropagation()); return x; };
      const sel = (k, opts) => { const x = h('select', { class: 'input sm' }, ...opts.map(([v, l]) => h('option', { value: v }, l))); x.value = c[k] ?? opts[0][0]; c[k] = x.value; x.onchange = () => { c[k] = x.value; onChange(); }; return x; };
      if (c.field === 'ext') row.append(inp('value', 'png, jpg', '160px'));
      else if (c.field === 'kind') row.append(sel('value', [...KIND_FOLDERS.map(([n]) => [n, n]), ['Other', 'Other']]));
      else if (c.field === 'size') row.append(sel('op', [['>', 'is over'], ['>=', 'is at least'], ['<', 'is under'], ['<=', 'is at most']]), inp('num', '100', '80px'), sel('unit', Object.keys(SIZE_UNITS).map((u) => [u, u])));
      else if (c.field === 'name') row.append(sel('op', [['contains', 'contains'], ['starts', 'starts with'], ['ends', 'ends with'], ['not', 'does not contain'], ['regex', 'matches pattern (regex)']]), inp('value', 'text', '180px'));
      else if (c.field === 'age') row.append(sel('op', [['>', 'more than'], ['<', 'less than']]), inp('num', '30', '70px'), h('span', { class: 'hint' }, 'days ago'));
      if (conds.length > 1) row.append(h('button', { class: 'icon-btn small', title: 'Remove condition', html: icon('close'), onclick: () => { conds.splice(i, 1); draw(); onChange(); } }));
      box.append(row);
    });
    box.append(h('button', { class: 'link ru-add', onclick: () => { if (conds.length === 1 && conds[0].field === 'any') conds[0] = { field: 'ext', value: '' }; else conds.push({ field: 'ext', value: '' }); draw(); onChange(); } }, '+ condition'));
    const a = rule.action || (rule.action = { type: 'move', target: '' });
    const act = h('select', { class: 'input sm' }, ...ACTIONS.map(([v, l]) => h('option', { value: v }, l))); act.value = a.type;
    act.onchange = () => { a.type = act.value; draw(); onChange(); };
    const then = h('div', { class: 'ru-then' }, h('b', {}, 'then'), act);
    if (a.type === 'move' || a.type === 'copy') {
      const t = h('input', { class: 'input sm', placeholder: 'Subfolder name, or a full path', style: { flex: '1', minWidth: '140px' } }); t.value = a.target || '';
      t.oninput = () => { a.target = t.value; onChange(); }; t.addEventListener('keydown', (e) => e.stopPropagation());
      then.append(t, h('button', { class: 'btn small', onclick: async () => { const d = await api('dialog:pickFolder', 'Choose the destination'); if (d) { a.target = d; t.value = d; onChange(); } } }, 'Browse…'));
    } else if (a.type === 'tag') {
      const s = h('select', { class: 'input sm' }, ...state.tags.defs.map((d) => h('option', { value: d.id }, d.name))); s.value = a.tag || state.tags.defs[0]?.id; a.tag = s.value; s.onchange = () => { a.tag = s.value; onChange(); }; then.append(s);
    }
    box.append(then, h('div', { class: 'hint ru-desc' }, describeRule(rule)));
  };
  draw();
  return box;
}

export async function automationDialog(folder, { preset } = {}) {
  folder = folder || activeTab()?.path;
  if (!folder || isVirtual(folder)) return toast('Open the folder you want to automate first');
  let auto = autos().find((a) => a.folder === folder);
  const isNew = !auto;
  auto = auto ? JSON.parse(JSON.stringify(auto)) : { id: uid(), folder, name: basename(folder), on: true, watch: true, rules: [] };
  if (preset && PRESETS[preset] && !auto.rules.some((r) => r.action?.type === PRESETS[preset].action.type)) auto.rules.push({ id: uid(), ...JSON.parse(JSON.stringify(PRESETS[preset])) });
  const list = h('div', { class: 'ru-list' });
  const draw = () => {
    list.innerHTML = '';
    if (!auto.rules.length) list.append(h('div', { class: 'hint pad' }, 'No rules yet. Add one, or start from an example below. Rules are checked top to bottom and the first one that fits a file wins.'));
    auto.rules.forEach((r, i) => list.append(ruleEditor(r, () => {}, () => { auto.rules.splice(i, 1); draw(); }, (d) => { const j = i + d; if (j < 0 || j >= auto.rules.length) return; [auto.rules[i], auto.rules[j]] = [auto.rules[j], auto.rules[i]]; draw(); })));
  };
  draw();
  const watch = h('input', { type: 'checkbox', class: 'switch' }); watch.checked = auto.watch !== false;
  const presets = h('div', { class: 'ru-presets' }, h('span', { class: 'hint' }, 'Examples:'), ...Object.entries(PRESETS).map(([k, p]) => h('button', { class: 'chip', onclick: () => { auto.rules.push({ id: uid(), ...JSON.parse(JSON.stringify(p)) }); draw(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); } }, p.name)));
  const body = h('div', { class: 'ru' },
    h('div', { class: 'hint' }, `Folder: ${folder}`),
    h('label', { class: 'ru-watch' }, watch, h('span', {}, h('b', {}, 'Run automatically'), h('span', { class: 'hint' }, ' when new files arrive in this folder (while Atlas is open). Downloads are left alone until they finish.'))),
    list,
    h('div', { class: 'row-inline wrap' }, h('button', { class: 'btn small with-ic', html: icon('plus') + '<span>Add rule</span>', onclick: () => { auto.rules.push({ id: uid(), on: true, match: 'all', conditions: [{ field: 'ext', value: '' }], action: { type: 'move', target: '' } }); draw(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); } }), presets));
  const save = () => { auto.watch = watch.checked; const all = autos().filter((a) => a.folder !== folder); all.push(auto); state.settings.automations = all; saveSettings(); syncWatches(); bus.emit('automations'); };
  const res = await modal({ title: `${isNew ? 'Automate' : 'Edit automation for'} “${basename(folder)}”`, body, width: 760, className: 'ru-modal', buttons: [
    !isNew && { label: 'Delete', left: true, danger: true, run: async (c) => { if (await confirm('Delete automation?', 'Files already sorted stay where they are.', { ok: 'Delete', danger: true })) { state.settings.automations = autos().filter((a) => a.folder !== folder); saveSettings(); syncWatches(); bus.emit('automations'); c(null); } return false; } },
    { label: 'Preview & run now…', left: true, run: async () => { save(); await runNowDialog(auto); return false; } },
    { label: 'Cancel', value: null },
    { label: 'Save', primary: true, value: true },
  ].filter(Boolean) });
  if (res) { save(); toast(watch.checked ? `Automation on: new files in “${basename(folder)}” will be sorted` : 'Automation saved'); }
}

export async function runNowDialog(auto, { only } = {}) {
  const items = await listLoose(auto.folder);
  if (!items) return toast('Can’t read that folder', { error: true });
  const onlySet = only ? new Set(only.map((x) => x.path)) : null;
  const files = items.filter((i) => !i.isDir && !i.hidden && i.name !== '.folder.md' && (!onlySet || onlySet.has(i.path)));
  const plan = planRules(auto.rules || [], files, { existingDirs: items.filter((i) => i.isDir).map((i) => i.name), folderName: basename(auto.folder) });
  if (!plan.length) return toast('No files here match the rules');
  const off = new Set();
  const rows = h('div', { class: 'ru-plan' }, ...plan.map((p, i) => { const c = h('input', { type: 'checkbox', checked: true }); c.onchange = () => (c.checked ? off.delete(i) : off.add(i)); return h('label', { class: 'ru-prow' }, c, h('span', { class: 'ru-pf', title: p.file.name }, p.file.name), h('span', { class: 'ru-arrow', html: icon('forward') }), h('span', { class: 'ru-pd' }, p.action === 'recycle' ? 'Recycle Bin' : p.action === 'tag' ? `tag ${state.tags.defs.find((d) => d.id === p.tag)?.name || ''}` : (p.action === 'copy' ? 'copy to ' : '') + p.dest), h('span', { class: 'hint' }, p.why || '')); }));
  const ok = await modal({ title: `Run now: ${plan.length} file${plan.length === 1 ? '' : 's'}`, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `${fmtSize(plan.reduce((a, p) => a + (p.file.size || 0), 0))} · untick anything you want to leave alone. Ctrl+Z undoes it afterwards.`), rows), width: 760, buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  const n = await execute(auto.folder, plan.filter((_, i) => !off.has(i)));
  const t = activeTab(); if (t?.path === auto.folder) loadTab(t, { soft: true });
  toast(`Sorted ${n} file${n === 1 ? '' : 's'}`);
}

export async function automationsManager() {
  const list = h('div', { class: 'ru-mgr' });
  const draw = () => {
    list.innerHTML = '';
    if (!autos().length) list.append(h('div', { class: 'hint pad' }, 'No folder automations yet. Open a folder, right-click empty space and choose “Automate this folder…”.'));
    for (const a of autos()) {
      const on = h('input', { type: 'checkbox', class: 'switch' }); on.checked = a.on !== false;
      on.onchange = () => { a.on = on.checked; saveSettings(); syncWatches(); };
      list.append(h('div', { class: 'ru-mrow' }, on, h('div', { class: 'ru-minfo' }, h('b', {}, a.name || basename(a.folder)), h('span', { class: 'hint' }, `${a.folder} · ${a.rules.length} rule${a.rules.length === 1 ? '' : 's'}${a.watch === false ? ' · manual' : ' · automatic'}`)),
        h('button', { class: 'btn small', onclick: () => runNowDialog(a) }, 'Run now'), h('button', { class: 'btn small', onclick: async () => { await automationDialog(a.folder); draw(); } }, 'Edit')));
    }
  };
  draw();
  await modal({ title: 'Folder automations', body: list, width: 640, buttons: [{ label: 'Automate current folder…', left: true, run: async () => { await automationDialog(activeTab()?.path); draw(); return false; } }, { label: 'Close', primary: true, value: true }] });
}

bus.on('automations:sync', syncWatches);
bus.on('folderRules', () => automationDialog(activeTab()?.path));
bus.on('automationsManager', automationsManager);
setTimeout(syncWatches, 2500);
