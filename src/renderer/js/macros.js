// Macros: record what you do (going to folders, selecting, commands, right-click menu actions, copies and
// moves, renames…), edit the steps, and play them back from the palette, a shortcut, at startup, on a schedule,
// or whenever new files land in a folder. Steps can also be added by hand, including your own features.
import { api, state, bus, h, esc, toast, saveSettings, uid, basename, dirname, pjoin, isVirtual, sys } from './core.js';
import { modal, confirm, prompt } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate, selectedItems, renderTabPanes, recompute, loadTab, otherPaneTab, setView } from './pane.js';
import * as A from './actions.js';

const macros = () => (state.settings.macros ||= []);
export const STEP_TYPES = {
  go: ['Go to a folder', 'folder'], select: ['Select files', 'selectAll'], command: ['Run a command', 'command'], menu: ['Right-click menu action', 'more'],
  copy: ['Copy selection to…', 'copy'], move: ['Move selection to…', 'cut'], rename: ['Rename selection (pattern)', 'rename'], organize: ['Sort the folder into subfolders', 'wand'],
  newFolder: ['New folder', 'newFolder'], zip: ['Zip the selection', 'zip'], trash: ['Recycle the selection', 'trash'], tag: ['Tag the selection', 'tag'],
  filter: ['Filter the folder', 'filter'], view: ['Change view', 'viewGrid'], wait: ['Wait', 'clock'], message: ['Show a message', 'info'],
};
export function describeStep(s) {
  switch (s.type) {
    case 'go': return `Go to ${s.path === '{other}' ? 'the other pane’s folder' : s.path}`;
    case 'select': return s.how === 'all' ? 'Select everything' : s.how === 'none' ? 'Select nothing' : s.how === 'pattern' ? `Select files matching ${s.value}` : s.how === 'new' ? 'Select the new files' : s.how === 'newest' ? `Select the newest ${s.value || 1}` : `Select ${(s.names || []).length} named file${(s.names || []).length === 1 ? '' : 's'}${(s.names || []).length ? ` (${s.names.slice(0, 3).join(', ')}${s.names.length > 3 ? '…' : ''})` : ''}`;
    case 'command': return `Run “${s.title || s.id}”`;
    case 'menu': return `Right-click > ${(s.path || []).join(' > ')}`;
    case 'copy': case 'move': return `${s.type === 'copy' ? 'Copy' : 'Move'} the selection to ${s.dest === '{other}' ? 'the other pane' : s.dest}`;
    case 'rename': return `Rename with “${s.template}”`;
    case 'organize': return `Sort into folders ${{ byKind: 'by type', byName: 'by topic in the name', byMonth: 'by month', byYear: 'by year' }[s.by] || s.by}`;
    case 'newFolder': return `New folder “${s.name}”`;
    case 'zip': return 'Zip the selection';
    case 'trash': return 'Move the selection to the Recycle Bin';
    case 'tag': return `Tag ${s.tag}`;
    case 'filter': return s.text ? `Filter by “${s.text}”` : 'Clear the filter';
    case 'view': return `Switch to ${s.view} view`;
    case 'wait': return `Wait ${s.ms / 1000} s`;
    case 'message': return `Show “${s.text}”`;
    default: return s.type;
  }
}

// ---------------- recording ----------------
let rec = null; // { steps, lastSel, offs, wrapped }
const selNames = (t) => selectedItems(t).filter((i) => !i.virtual).map((i) => i.name);
function noteSelection() {
  const t = activeTab();
  const names = selNames(t);
  const key = names.join('\u0001');
  if (key === rec.lastSel) return;
  rec.lastSel = key;
  const allNames = (t.shown || []).filter((i) => !i.virtual).map((i) => i.name);
  if (names.length && names.length === allNames.length) rec.steps.push({ type: 'select', how: 'all' });
  else if (names.length) rec.steps.push({ type: 'select', how: 'names', names });
  else rec.steps.push({ type: 'select', how: 'none' });
}
export async function startRecording() {
  if (rec) return;
  rec = { steps: [], lastSel: null, offs: [], running: false };
  const t = activeTab();
  if (t?.path && !isVirtual(t.path)) rec.steps.push({ type: 'go', path: t.path });
  // commands (palette, keys, ribbon) are wrapped while recording
  const { commands } = await import('./commands.js');
  rec.wrapped = [];
  for (const c of commands.values()) {
    if (/^(startMacro|stopMacro|macros|palette|selectAll|selectNone|invertSel|nextTab|prevTab|focusPane|nextPane|prevPane|back|forward|up|refresh)/.test(c.id)) continue;
    const orig = c.run;
    c.run = (...a) => { if (rec && !rec.inMenu) { noteSelection(); rec.steps.push({ type: 'command', id: c.id, title: c.title }); drawChip(); } return orig(...a); };
    rec.wrapped.push([c, orig]);
  }
  rec.offs.push(bus.on('navigated', ({ t: tt, path, sync }) => { if (!rec || sync || tt !== activeTab()) return; const last = rec.steps[rec.steps.length - 1]; if (last?.type === 'go') last.path = path; else rec.steps.push({ type: 'go', path }); rec.lastSel = null; drawChip(); }));
  rec.offs.push(bus.on('menuRun', ({ kind, path }) => { if (!rec) return; noteSelection(); rec.steps.push({ type: 'menu', kind, path }); rec.inMenu = true; setTimeout(() => { if (rec) rec.inMenu = false; }, 50); drawChip(); }));
  rec.offs.push(bus.on('transferStarted', ({ dest, mode }) => { if (!rec || rec.inMenu) return; const last = rec.steps[rec.steps.length - 1]; if (last?.type === 'command' && /paste|copyTo|moveTo|ToOther/.test(last.id)) return; noteSelection(); const o = otherPaneTab(); rec.steps.push({ type: mode === 'move' ? 'move' : 'copy', dest: o && o.path === dest ? '{other}' : dest }); drawChip(); }));
  rec.offs.push(bus.on('renamedOne', ({ name }) => { if (!rec) return; rec.steps.push({ type: 'rename', template: name }); drawChip(); }));
  drawChip();
  toast('Recording a macro. Do the steps, then press Stop in the status bar.');
}
export async function stopRecording() {
  if (!rec) return;
  for (const [c, orig] of rec.wrapped || []) c.run = orig;
  rec.offs.forEach((off) => off());
  const steps = rec.steps;
  rec = null;
  drawChip();
  if (steps.length < 1) return toast('Nothing was recorded');
  const m = { id: uid(), name: `Macro ${macros().length + 1}`, steps, trigger: { type: 'manual' }, enabled: true, created: Date.now() };
  await editMacro(m, true);
}
let chip = null;
function drawChip() {
  if (!rec) { chip?.remove(); chip = null; return; }
  if (!chip) { chip = h('button', { class: 'chip rec-chip', title: 'Stop recording' }); chip.onclick = stopRecording; document.getElementById('statusbar')?.querySelector('#ops-btn')?.before(chip); }
  chip.innerHTML = icon('record') + `<span>Recording · ${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'} · Stop</span>`;
}

// ---------------- playing ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { await sleep(120); }
export async function runMacro(m, { newFiles } = {}) {
  const t0 = activeTab();
  let t = t0;
  toast(`Running “${m.name}”…`, { ms: 1500 });
  try {
    for (const [i, s] of m.steps.entries()) {
      t = activeTab();
      switch (s.type) {
        case 'go': { const p = s.path === '{other}' ? otherPaneTab()?.path : s.path.replace(/^~(?=$|[\\/])/, sys.known.home || '~'); if (!p) throw new Error('There is no other pane'); const ok = await navigate(t, p); if (ok === false) throw new Error(`Can’t open ${p}`); break; }
        case 'select': {
          const shown = (t.shown || []).filter((x) => !x.virtual);
          let pick = [];
          if (s.how === 'all') pick = shown;
          else if (s.how === 'pattern') { const { patternToTest } = await import('./dialogs.js'); const test = patternToTest(s.value || '*'); pick = shown.filter((x) => test(x.name)); }
          else if (s.how === 'names') { const want = new Set((s.names || []).map((n) => n.toLowerCase())); pick = shown.filter((x) => want.has(x.name.toLowerCase())); }
          else if (s.how === 'new') { const want = new Set((newFiles || []).map((p) => p.toLowerCase())); pick = shown.filter((x) => want.has(x.path.toLowerCase())); }
          else if (s.how === 'newest') pick = [...shown].filter((x) => !x.isDir).sort((a, b) => b.mtime - a.mtime).slice(0, +s.value || 1);
          t.sel = new Set(pick.map((x) => x.path)); t.focus = pick[0]?.path || null;
          renderTabPanes(t, true); bus.emit('selection', t);
          break;
        }
        case 'command': { const { commands } = await import('./commands.js'); const c = commands.get(s.id); if (!c) throw new Error(`The command “${s.title || s.id}” isn’t available`); await c.run(); break; }
        case 'menu': {
          const items = selectedItems(t);
          let menu = s.kind === 'background' ? A.buildBackgroundMenu(t) : A.buildItemsMenu(t, items);
          let it = null;
          for (const label of s.path) {
            const list = (typeof menu === 'function' ? await menu() : menu || []).filter(Boolean);
            it = list.find((x) => x.label === label) || list.find((x) => x.label && x.label.replace(/“.*”/, '') === label.replace(/“.*”/, ''));
            if (!it) throw new Error(`“${label}” isn’t in the menu here`);
            menu = it.submenu;
          }
          await it.run?.({ clientX: 200, clientY: 200 });
          break;
        }
        case 'copy': case 'move': {
          const dest = s.dest === '{other}' ? otherPaneTab()?.path : /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s.dest) ? s.dest : pjoin(t.path, s.dest);
          if (!dest) throw new Error('No destination');
          if (!(await api('fs:stat', dest))) await api('fs:mkdir', dest);
          const paths = selectedItems(t).filter((x) => !x.virtual).map((x) => x.path);
          if (paths.length) await A.transfer(paths, dest, s.type, { conflict: s.conflict || undefined });
          break;
        }
        case 'rename': {
          const items = selectedItems(t).filter((x) => !x.virtual);
          if (!items.length) break;
          if (items.length === 1 && !/\{/.test(s.template)) { await A.renameOne(items[0], s.template); break; }
          const { computeNames } = await import('./renamestudio.js');
          const { out } = computeNames(items, { template: s.template, start: 1, step: 1 }, {});
          await A.renamePairs(out.filter((o) => !o.problem && o.name !== o.it.name).map((o) => ({ from: o.it.path, to: pjoin(dirname(o.it.path), o.name) })), `Macro: rename`);
          break;
        }
        case 'organize': {
          const { planRules } = await import('./organize.js');
          const { execute } = await import('./rules.js');
          const sel = selectedItems(t).filter((x) => !x.isDir && !x.virtual);
          const files = sel.length ? sel : (t.items || []).filter((x) => !x.isDir && !x.hidden && !x.virtual);
          const plan = planRules([{ conditions: [], action: { type: s.by || 'byKind' } }], files, { existingDirs: (t.items || []).filter((x) => x.isDir).map((x) => x.name), folderName: basename(t.path) });
          await execute(t.path, plan);
          await loadTab(t, { soft: true });
          break;
        }
        case 'newFolder': { const p = pjoin(t.path, s.name || 'New folder'); if (!(await api('fs:stat', p))) await api('fs:mkdir', p); await loadTab(t, { soft: true }); break; }
        case 'zip': await A.quickZip(selectedItems(t)); break;
        case 'trash': { const paths = selectedItems(t).filter((x) => !x.virtual).map((x) => x.path); if (paths.length) await A.runJob({ type: 'trash', sources: paths }); break; }
        case 'tag': { const { setTags } = await import('./core.js'); const tg = state.tags.defs.find((d) => d.id === s.tag || d.name.toLowerCase() === String(s.tag).toLowerCase()); if (tg) setTags(selectedItems(t).map((x) => x.path), tg.id, true); break; }
        case 'filter': t.filter = s.text || ''; recompute(t); renderTabPanes(t); break;
        case 'view': setView(t, s.view || 'details'); break;
        case 'wait': await sleep(Math.min(600000, +s.ms || 1000)); break;
        case 'message': toast(s.text || ''); break;
      }
      await settle();
    }
    bus.emit('history', { kind: 'automation', title: `Macro “${m.name}”`, detail: m.steps.map(describeStep), at: Date.now() });
    toast(`“${m.name}” finished`);
    return true;
  } catch (e) { toast(`“${m.name}” stopped: ${e.message}`, { error: true, ms: 7000 }); return false; }
}

// ---------------- editing ----------------
function stepEditor(s, onChange) {
  const box = h('div', { class: 'mc-fields' });
  const inp = (k, ph, w) => { const x = h('input', { class: 'input sm', placeholder: ph, spellcheck: 'false', style: { width: w || '220px' } }); x.value = s[k] ?? ''; x.oninput = () => { s[k] = x.value; onChange(); }; x.addEventListener('keydown', (e) => e.stopPropagation()); return x; };
  const sel = (k, opts) => { const x = h('select', { class: 'input sm' }, ...opts.map(([v, l]) => h('option', { value: v }, l))); x.value = s[k] ?? opts[0][0]; s[k] = x.value; x.onchange = () => { s[k] = x.value; onChange(); }; return x; };
  const pick = (k) => h('button', { class: 'btn small', onclick: async () => { const d = await api('dialog:pickFolder', 'Choose a folder'); if (d) { s[k] = d; onChange(true); } } }, 'Browse…');
  switch (s.type) {
    case 'go': box.append(inp('path', 'Folder path (or {other})', '300px'), pick('path')); break;
    case 'select': box.append(sel('how', [['names', 'These names'], ['pattern', 'Matching a pattern'], ['all', 'Everything'], ['none', 'Nothing'], ['newest', 'The newest files'], ['new', 'Files that just arrived (folder trigger)']]), s.how === 'pattern' ? inp('value', '*.jpg;*.png', '160px') : s.how === 'newest' ? inp('value', 'how many', '80px') : null, s.how === 'names' ? h('span', { class: 'hint' }, (s.names || []).join(', ').slice(0, 120)) : null); break;
    case 'copy': case 'move': box.append(inp('dest', 'Folder, subfolder name, or {other}', '260px'), pick('dest'), sel('conflict', [['', 'Ask on clashes'], ['keepBoth', 'Keep both'], ['replace', 'Replace'], ['skip', 'Skip'], ['newer', 'Keep newer']])); break;
    case 'rename': box.append(inp('template', 'e.g. {date}_{name} or Trip {n:3}', '260px')); break;
    case 'organize': box.append(sel('by', [['byKind', 'By type'], ['byName', 'By topic in the name'], ['byMonth', 'By month'], ['byYear', 'By year'], ['bySize', 'By size']])); break;
    case 'newFolder': box.append(inp('name', 'Folder name')); break;
    case 'tag': box.append(sel('tag', state.tags.defs.map((d) => [d.id, d.name]))); break;
    case 'filter': box.append(inp('text', 'Text, *.jpg, or empty to clear')); break;
    case 'view': box.append(sel('view', [['details', 'Details'], ['grid', 'Grid'], ['gallery', 'Gallery'], ['list', 'List'], ['columns', 'Columns']])); break;
    case 'wait': { const x = h('input', { class: 'input sm', type: 'number', min: '0.1', step: '0.5', style: { width: '80px' } }); x.value = String((s.ms || 1000) / 1000); x.oninput = () => { s.ms = Math.round(+x.value * 1000) || 1000; onChange(); }; box.append(x, h('span', { class: 'hint' }, 'seconds')); break; }
    case 'message': box.append(inp('text', 'Message', '300px')); break;
    case 'command': box.append(h('span', { class: 'hint' }, s.id)); break;
    default: break;
  }
  return box;
}
async function addStepMenu(m, draw, e) {
  const { showMenu } = await import('./menu.js');
  const { commands } = await import('./commands.js');
  const add = (s) => { m.steps.push(s); draw(); };
  showMenu([
    ...Object.entries(STEP_TYPES).filter(([k]) => !['command', 'menu'].includes(k)).map(([k, [l, ic]]) => ({ label: l, icon: ic, run: () => add({ type: k, ...(k === 'select' ? { how: 'pattern', value: '*' } : k === 'wait' ? { ms: 1000 } : k === 'go' ? { path: activeTab()?.path || '' } : {}) }) })),
    { separator: true },
    { label: 'Run a command or feature', icon: 'command', submenu: () => [...commands.values()].filter((c) => !c.hidden && !/^macro:/.test(c.id)).sort((a, b) => (a.cat || '').localeCompare(b.cat || '') || a.title.localeCompare(b.title)).slice(0, 400).map((c) => ({ label: `${c.cat ? c.cat + ': ' : ''}${c.title}`, icon: c.icon, run: () => add({ type: 'command', id: c.id, title: c.title }) })) },
  ], e.clientX, e.clientY);
}
export async function editMacro(m0, isNew = false) {
  const m = JSON.parse(JSON.stringify(m0));
  const steps = h('div', { class: 'mc-steps' });
  const draw = (rerender = false) => {
    steps.innerHTML = '';
    if (!m.steps.length) steps.append(h('div', { class: 'hint pad' }, 'No steps yet. Add some, or record.'));
    m.steps.forEach((s, i) => {
      const desc = h('div', { class: 'mc-desc' }, `${i + 1}. ${describeStep(s)}`);
      steps.append(h('div', { class: 'mc-step' }, h('span', { class: 'hi-ic', html: icon(STEP_TYPES[s.type]?.[1] || 'command') }), h('div', { class: 'mc-body' }, desc, stepEditor(s, (full) => { desc.textContent = `${i + 1}. ${describeStep(s)}`; if (full) draw(); })),
        h('div', { class: 'hi-acts' }, h('button', { class: 'icon-btn small', title: 'Up', html: icon('up'), onclick: () => { if (i) { [m.steps[i - 1], m.steps[i]] = [m.steps[i], m.steps[i - 1]]; draw(); } } }), h('button', { class: 'icon-btn small', title: 'Down', html: icon('down'), onclick: () => { if (i < m.steps.length - 1) { [m.steps[i + 1], m.steps[i]] = [m.steps[i], m.steps[i + 1]]; draw(); } } }), h('button', { class: 'icon-btn small', title: 'Remove', html: icon('trash'), onclick: () => { m.steps.splice(i, 1); draw(); } }))));
    });
  };
  draw();
  const name = h('input', { class: 'input', value: m.name }); name.addEventListener('keydown', (e) => e.stopPropagation()); name.oninput = () => { m.name = name.value; };
  const trig = m.trigger || (m.trigger = { type: 'manual' });
  const trigBox = h('div', { class: 'row-inline wrap' });
  const drawTrig = () => {
    trigBox.innerHTML = '';
    const tsel = h('select', { class: 'input sm' }, ...[['manual', 'Only when I run it'], ['key', 'With a keyboard shortcut'], ['startup', 'When Dogfile starts'], ['schedule', 'On a schedule'], ['folder', 'When new files arrive in a folder']].map(([v, l]) => h('option', { value: v }, l)));
    tsel.value = trig.type; tsel.onchange = () => { trig.type = tsel.value; drawTrig(); };
    trigBox.append(tsel);
    const inp = (k, ph, w) => { const x = h('input', { class: 'input sm', placeholder: ph, style: { width: w } }); x.value = trig[k] ?? ''; x.oninput = () => { trig[k] = x.value; }; x.addEventListener('keydown', (e) => e.stopPropagation()); return x; };
    if (trig.type === 'key') { const x = inp('keys', 'e.g. Ctrl+Alt+M', '150px'); x.readOnly = true; x.placeholder = 'press the keys here'; x.addEventListener('keydown', (e) => { e.preventDefault(); if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; const k = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+'); trig.keys = k; x.value = k; }); trigBox.append(x); }
    if (trig.type === 'schedule') { const mode = h('select', { class: 'input sm' }, h('option', { value: 'every' }, 'Every'), h('option', { value: 'daily' }, 'Every day at')); mode.value = trig.mode || 'every'; trig.mode = mode.value; mode.onchange = () => { trig.mode = mode.value; drawTrig(); }; trigBox.append(mode, trig.mode === 'daily' ? inp('at', '08:00', '80px') : inp('minutes', '60', '70px'), trig.mode === 'daily' ? null : h('span', { class: 'hint' }, 'minutes'), h('span', { class: 'hint' }, '(while Dogfile is open)')); }
    if (trig.type === 'folder') trigBox.append(inp('folder', 'Folder', '260px'), h('button', { class: 'btn small', onclick: async () => { const d = await api('dialog:pickFolder', 'Watch which folder?'); if (d) { trig.folder = d; drawTrig(); } } }, 'Browse…'), h('span', { class: 'hint' }, 'Tip: start with “Select files: Files that just arrived”'));
  };
  drawTrig();
  const ok = await modal({ title: isNew ? 'Save your macro' : `Edit “${m.name}”`, width: 820, className: 'mc-modal', body: h('div', { class: 'stack' }, h('label', { class: 'pp-row' }, h('span', {}, 'Name'), name), h('label', { class: 'pp-row' }, h('span', {}, 'Runs'), trigBox), h('div', { class: 'row-inline' }, h('b', {}, 'Steps'), h('span', { class: 'st-spacer' }), h('button', { class: 'btn small with-ic', html: icon('plus') + '<span>Add step</span>', onclick: (e) => addStepMenu(m, draw, e) })), steps), buttons: [
    !isNew && { label: 'Delete', left: true, danger: true, run: async (c) => { if (await confirm('Delete macro?', `Delete “${esc(m.name)}”?`, { ok: 'Delete', danger: true })) { state.settings.macros = macros().filter((x) => x.id !== m.id); saveSettings(); syncMacros(); c(null); } return false; } },
    { label: 'Try it now', left: true, run: () => { runMacro(m); return false; } },
    { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: true }].filter(Boolean) });
  if (!ok) return;
  state.settings.macros = [...macros().filter((x) => x.id !== m.id), m];
  saveSettings(); syncMacros();
  toast(`Macro “${m.name}” saved${trig.type === 'key' && trig.keys ? ` (${trig.keys})` : ''}. Find it in the command palette.`);
}
export async function macrosManager() {
  const list = h('div', { class: 'ws-list' });
  const draw = () => {
    list.innerHTML = '';
    if (!macros().length) list.append(h('div', { class: 'hint pad' }, 'No macros yet. Press “Record” and do something you repeat often; Dogfile writes down the steps.'));
    for (const m of macros()) {
      const on = h('input', { type: 'checkbox', class: 'switch' }); on.checked = m.enabled !== false; on.onchange = () => { m.enabled = on.checked; saveSettings(); syncMacros(); };
      const tr = m.trigger || {};
      list.append(h('div', { class: 'ws-row ext-row' }, on, h('div', { class: 'hi-main' }, h('b', {}, m.name), h('span', { class: 'hint' }, `${m.steps.length} step${m.steps.length === 1 ? '' : 's'} · ${{ manual: 'run by hand', key: `shortcut ${tr.keys || ''}`, startup: 'at startup', schedule: tr.mode === 'daily' ? `daily at ${tr.at}` : `every ${tr.minutes} min`, folder: `when files arrive in ${basename(tr.folder || '')}` }[tr.type] || ''}`)),
        h('div', { class: 'hi-acts' }, h('button', { class: 'btn small primary', onclick: () => { closeIt(); runMacro(m); } }, 'Run'), h('button', { class: 'btn small', onclick: async () => { await editMacro(m); draw(); } }, 'Edit'))));
    }
  };
  draw();
  let closeIt = () => {};
  const p = modal({ title: 'Macros', width: 680, className: 'mcm-modal', body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Record a series of steps once and replay it with one click, a shortcut, on a schedule or when files arrive. Every step can be edited.'), list), buttons: [
    { label: 'Record…', left: true, run: () => { closeIt(); startRecording(); } },
    { label: 'New (empty)…', left: true, run: async () => { await editMacro({ id: uid(), name: `Macro ${macros().length + 1}`, steps: [], trigger: { type: 'manual' }, enabled: true }, true); draw(); return false; } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.mcm-modal')?._close?.(null); }, 0);
  return p;
}

// ---------------- triggers ----------------
let timers = [];
export async function syncMacros() {
  const { commands, rebuildKeymap } = await import('./commands.js');
  for (const k of [...commands.keys()]) if (k.startsWith('macro:')) commands.delete(k);
  for (const m of macros().filter((x) => x.enabled !== false)) commands.set('macro:' + m.id, { id: 'macro:' + m.id, title: `Macro: ${m.name}`, icon: 'record', cat: 'Macros', keys: m.trigger?.type === 'key' && m.trigger.keys ? [m.trigger.keys] : [], run: () => runMacro(m) });
  rebuildKeymap?.();
  timers.forEach(clearInterval); timers = [];
  for (const m of macros().filter((x) => x.enabled !== false && x.trigger?.type === 'schedule')) {
    const tr = m.trigger;
    if (tr.mode === 'daily') { let last = ''; timers.push(setInterval(() => { const d = new Date(); const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; const day = d.toDateString(); if (hm === (tr.at || '').padStart(5, '0') && last !== day) { last = day; runMacro(m); } }, 20000)); }
    else { const min = Math.max(1, +tr.minutes || 60); timers.push(setInterval(() => runMacro(m), min * 60000)); }
  }
  bus.emit('automations:sync');
}
// new files in a watched folder (the folder automations' watcher reports them)
bus.on('folderNewFiles', ({ dir, files }) => {
  for (const m of macros().filter((x) => x.enabled !== false && x.trigger?.type === 'folder' && x.trigger.folder && x.trigger.folder.toLowerCase() === dir.toLowerCase())) {
    (async () => { await navigate(activeTab(), dir); await runMacro(m, { newFiles: files }); })();
  }
});
export const macroFolders = () => macros().filter((x) => x.enabled !== false && x.trigger?.type === 'folder' && x.trigger.folder).map((x) => x.trigger.folder);
setTimeout(() => { syncMacros(); for (const m of macros().filter((x) => x.enabled !== false && x.trigger?.type === 'startup')) runMacro(m); }, 3500);
bus.on('macros', macrosManager);
