// Folder cleanup ("Tidy up"): proposes subfolders for a messy folder like Downloads. Files first go to subfolders
// that already exist when their names fit, then to topics found in their names (organize.js), optionally to
// groups a small local AI model finds, and the rest by kind. The preview shows why each file goes where it goes,
// and every file can be sent to another folder or left alone before anything moves. Every move can be undone.
import { api, state, h, toast, pjoin, basename, isVirtual, fmtSize, bus } from './core.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, loadTab } from './pane.js';
import * as A from './actions.js';
import { groupByName, matchExisting, kindFolder, monthFolder, groupBy, nameWords } from './organize.js';
import { requirePro } from './license.js';

const LEAVE = '\u0000leave';
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function propose(files, mode, { vectors, existing, folderName, rest: restMode }) {
  const dest = new Map(); // file -> folder name
  const why = new Map();
  if (mode === 'date') { for (const f of files) { dest.set(f, monthFolder(f)); why.set(f, 'last changed that month'); } return { dest, why }; }
  if (mode === 'kind') { for (const f of files) { dest.set(f, kindFolder(f.ext)); why.set(f, `it’s ${kindFolder(f.ext).toLowerCase()}`); } return { dest, why }; }
  let rest = files;
  // 1. subfolders that already exist
  const ex = matchExisting(rest, existing);
  for (const [d, l] of ex.groups) for (const f of l) { dest.set(f, d); why.set(f, ex.why.get(f)); }
  rest = ex.rest;
  // 2. topics in names
  const g = groupByName(rest, { min: files.length < 30 ? 2 : 3, folderName });
  for (const [d, l] of g.groups) for (const f of l) { dest.set(f, d); why.set(f, g.why.get(f)); }
  rest = g.rest;
  // 3. AI: names that mean similar things ("receipt", "invoice", "bill")
  if (vectors) {
    const idx = rest.map((f) => files.indexOf(f)).filter((i) => vectors[i]);
    const used = new Set();
    for (const i of idx) {
      if (used.has(i)) continue;
      const cluster = idx.filter((j) => !used.has(j) && dot(vectors[i], vectors[j]) > 0.62);
      if (cluster.length < 3) continue;
      cluster.forEach((j) => used.add(j));
      const members = cluster.map((j) => files[j]);
      const freq = new Map(); for (const m of members) for (const w of nameWords(m.name)) freq.set(w, (freq.get(w) || 0) + 1);
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      const name = top && top[1] >= 2 ? top[0].charAt(0).toUpperCase() + top[0].slice(1) : `${kindFolder(members[0].ext)} (similar names)`;
      for (const m of members) { dest.set(m, name); why.set(m, 'similar meaning (AI)'); }
    }
    rest = rest.filter((f) => !dest.has(f));
  }
  // 4. everything else
  for (const f of rest) {
    if (restMode === 'leave') { dest.set(f, LEAVE); why.set(f, 'no clear topic'); }
    else { dest.set(f, kindFolder(f.ext)); why.set(f, `no topic in the name, so by type (${kindFolder(f.ext).toLowerCase()})`); }
  }
  return { dest, why };
}

export async function declutter(t = activeTab()) {
  if (!requirePro('automation')) return;
  if (!t?.path || isVirtual(t.path)) return toast('Open the folder you want to tidy up first');
  const files = (t.items || []).filter((i) => !i.isDir && !i.hidden && !i.virtual && i.name !== '.folder.md');
  if (files.length < 3) return toast('This folder is already tidy (fewer than 3 loose files)');
  const existing = (t.items || []).filter((i) => i.isDir && !i.virtual).map((i) => i.name);
  let mode = 'smart', restMode = 'kind', useAi = false, vectors = null;
  const box = h('div', { class: 'dc-groups' });
  const summary = h('div', { class: 'hint' });
  const S = { dest: new Map(), why: new Map(), names: new Map() };
  const draw = () => {
    const r = propose(files, mode, { vectors: useAi ? vectors : null, existing, folderName: basename(t.path), rest: restMode });
    S.dest = r.dest; S.why = r.why; S.names = new Map();
    render();
  };
  const render = () => {
    box.innerHTML = '';
    const groups = groupBy(files, (f) => S.dest.get(f));
    const names = [...groups.keys()].filter((k) => k !== LEAVE);
    const sorted = [...groups.entries()].sort((a, b) => (a[0] === LEAVE) - (b[0] === LEAVE) || b[1].length - a[1].length);
    const lower = new Set(existing.map((x) => x.toLowerCase()));
    for (const [g, list] of sorted) {
      const leave = g === LEAVE;
      const nameIn = leave ? h('b', { class: 'dc-name' }, 'Leave where they are') : h('input', { class: 'input dc-name', value: S.names.get(g) || g, spellcheck: 'false' });
      if (!leave) { nameIn.oninput = () => S.names.set(g, nameIn.value); nameIn.addEventListener('click', (e) => e.preventDefault()); nameIn.addEventListener('keydown', (e) => e.stopPropagation()); }
      const filesBox = h('div', { class: 'dc-files' }, ...list.slice(0, 400).map((f) => {
        const sel = h('select', { class: 'input dc-move', title: 'Send this file somewhere else' });
        for (const n of names) sel.append(h('option', { value: n, selected: n === g }, `→ ${S.names.get(n) || n}`));
        sel.append(h('option', { value: LEAVE, selected: leave }, 'Leave it here'));
        sel.append(h('option', { value: '\u0000new' }, 'New folder…'));
        sel.onchange = async () => {
          let v = sel.value;
          if (v === '\u0000new') { const { prompt } = await import('./dialogs.js'); v = await prompt('New folder', '', { label: 'Folder name' }); if (!v) { sel.value = g; return; } }
          S.dest.set(f, v); S.why.set(f, 'you chose this'); render();
        };
        return h('div', { class: 'dc-file', title: f.name }, h('span', { class: 'dc-fn' }, f.name), h('span', { class: 'dc-why' }, S.why.get(f) || ''), h('i', {}, fmtSize(f.size || 0)), sel);
      }));
      const det = h('details', { class: 'dc-group' + (leave ? ' leave' : ''), open: sorted.length <= 4 }, h('summary', {}, h('span', { class: 'dc-ic', html: icon(leave ? 'pin' : 'folder') }), nameIn, h('span', { class: 'dc-count' }, `${list.length} file${list.length === 1 ? '' : 's'}${!leave && lower.has((S.names.get(g) || g).toLowerCase()) ? ' · into the existing folder' : ''}`)), filesBox);
      box.append(det);
    }
    const moving = files.filter((f) => S.dest.get(f) !== LEAVE).length;
    summary.textContent = `${moving} of ${files.length} files into ${names.length} folder${names.length === 1 ? '' : 's'}. Open a folder to see why each file goes there and send any file somewhere else. Folder names are editable.`;
  };
  const seg = h('div', { class: 'seg' }, ...[['smart', 'By topic in the name'], ['kind', 'By type'], ['date', 'By month']].map(([k, l]) => { const b = h('button', { class: 'seg-btn' + (k === mode ? ' on' : '') }, l); b.onclick = () => { mode = k; seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); draw(); }; return b; }));
  const restSel = h('select', { class: 'input sm' }, h('option', { value: 'kind' }, 'sort by type'), h('option', { value: 'leave' }, 'leave them alone'));
  restSel.onchange = () => { restMode = restSel.value; draw(); };
  const aiBox = h('input', { type: 'checkbox' });
  aiBox.onchange = async () => {
    if (!aiBox.checked) { useAi = false; draw(); return; }
    const ai = await import('./ai.js');
    if (!(await ai.ensureModels(['minilm']))) { aiBox.checked = false; return; }
    if (!vectors) {
      summary.textContent = 'Understanding file names…';
      try { vectors = await ai.call({ type: 'sentences', texts: files.map((f) => nameWords(f.name).join(' ') || f.name) }); }
      catch (e) { toast(`AI grouping failed: ${e.message}`, { error: true }); aiBox.checked = false; return; }
    }
    useAi = true; mode = 'smart'; seg.querySelectorAll('.seg-btn').forEach((x, i) => x.classList.toggle('on', i === 0)); draw();
  };
  const body = h('div', { class: 'dcl' },
    h('div', { class: 'row-inline wrap' }, seg, h('span', { class: 'hint' }, 'Files without a topic:'), restSel, h('label', { class: 'check', title: 'Uses a small free AI model on this PC (25 MB, downloaded once) so names that mean similar things go together' }, aiBox, ' Smarter with AI')),
    summary, box);
  draw();
  const ok = await modal({ title: `Tidy up “${basename(t.path)}”`, body, width: 860, className: 'dc-modal', buttons: [
    { label: 'Make this automatic…', left: true, run: (c) => { c(null); import('./rules.js').then((m) => m.automationDialog(t.path, { preset: mode === 'kind' ? 'byKind' : mode === 'date' ? 'byMonth' : 'byName' })); } },
    { label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  const byDest = groupBy(files.filter((f) => S.dest.get(f) !== LEAVE), (f) => S.dest.get(f));
  let moved = 0;
  for (const [g, list] of byDest) {
    const name = (S.names.get(g) || g).trim().replace(/[<>:"/\\|?*]/g, '_');
    if (!name) continue;
    const dir = pjoin(t.path, name);
    if (!(await api('fs:stat', dir))) await api('fs:mkdir', dir).catch(() => {});
    const j = await A.transfer(list.map((f) => f.path), dir, 'move');
    if (j?.status === 'done') moved += list.length;
  }
  await loadTab(t, { soft: true });
  toast(`Moved ${moved} file${moved === 1 ? '' : 's'} into folders. Ctrl+Z undoes it.`);
}
bus.on('declutter', () => declutter());
