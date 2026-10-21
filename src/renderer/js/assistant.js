// AI file assistant: ask in plain words ("PDFs about taxes from last year", "group these by type",
// "rename these using their contents", "files I haven't opened in six months"). It shows how it understood the
// request and what it found, previews any change, and asks before doing anything big or destructive.
// Everything runs on this PC: a request grammar, name & content matching, and (optionally) the local AI models.
import { api, state, sys, bus, h, esc, toast, fmtSize, fmtDate, basename, dirname, pjoin, IS_WIN, KINDS, uid, setTags, isVirtual } from './core.js';
import { icon, fileArt } from './icons.js';
import { modal, confirm } from './dialogs.js';
import { activeTab, navigate, selectedItems, openTab, loadTab } from './pane.js';
import * as A from './actions.js';
import { parseRequest, expandTopic, describePlan } from './assistant-parse.js';
import { onWorkMsgFor } from './tools.js';
import { planRules, describeAction } from './organize.js';

export const results = new Map(); // id -> items (shown in a tab as atlas:search?assist=id)
let panel = null, log = null, input = null, sendBtn = null;
// the request being worked on (Stop ends it) and what the conversation is about (for follow-ups)
let busy = null;
const C = { items: null, plan: null };
function setBusy(on) {
  busy = on ? { stop: false, jobs: new Set() } : null;
  if (!sendBtn) return;
  sendBtn.classList.toggle('stop', !!on);
  sendBtn.title = on ? 'Stop' : 'Send';
  sendBtn.innerHTML = icon(on ? 'pstop' : 'forward');
}
function stopNow() {
  if (!busy) return;
  busy.stop = true;
  for (const id of busy.jobs) api('work:cancel', id).catch(() => {});
  for (const f of busy.onStop || []) f();
}
const SUGGEST = ['Find the latest version of my screenplay', 'Show me PDFs about taxes from last year', 'Group these by type', 'Find files I haven’t opened in six months', 'Rename these using their contents', 'How much space do my videos take?', 'Videos bigger than 1 GB', 'Organize my Downloads'];

export function toggleAssistant(force) {
  if (!panel) build();
  const open = force ?? !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  document.body.classList.toggle('assistant-open', open);
  if (open) setTimeout(() => input.focus(), 50);
  bus.emit('syncFrames');
}
function build() {
  log = h('div', { class: 'as-log' });
  input = h('textarea', { class: 'as-input', rows: '1', placeholder: 'Ask about your files… (Enter to send)', spellcheck: 'true' });
  const send = h('button', { class: 'as-send', title: 'Send', html: icon('forward') });
  const go = () => { if (busy) { stopNow(); return; } const v = input.value.trim(); if (!v) return; input.value = ''; input.style.height = ''; ask(v); };
  sendBtn = send;
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === 'Escape') toggleAssistant(false); });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(140, input.scrollHeight) + 'px'; });
  send.onclick = go;
  panel = h('aside', { id: 'assistant', role: 'complementary', 'aria-label': 'File assistant' },
    h('div', { class: 'as-head' }, h('span', { class: 'as-logo', html: icon('sparkle') }), h('b', {}, 'Assistant'), h('span', { class: 'hint' }, 'private · runs on this PC'), h('span', { class: 'st-spacer' }),
      h('button', { class: 'icon-btn small', title: 'Clear the conversation', html: icon('trash'), onclick: () => { log.innerHTML = ''; C.items = null; C.plan = null; hello(); } }),
      h('button', { class: 'icon-btn small', title: 'Close (Esc)', html: icon('close'), onclick: () => toggleAssistant(false) })),
    log, h('div', { class: 'as-foot' }, input, send));
  document.body.append(panel);
  // sits beside the file panes (they get narrower) rather than covering them
  const ws = document.getElementById('workspace');
  const place = () => { if (!ws) return; const r = ws.getBoundingClientRect(); panel.style.top = r.top + 'px'; panel.style.height = r.height + 'px'; };
  new ResizeObserver(place).observe(ws || document.body);
  window.addEventListener('resize', place);
  bus.on('layout', place);
  place();
  hello();
}
function hello() {
  log.append(msg('bot', h('div', {}, h('p', {}, 'Tell me what you’re looking for or what to do with your files. I’ll show you the plan and the files before changing anything.'), h('div', { class: 'as-sugg' }, ...SUGGEST.map((s) => h('button', { class: 'chip', onclick: () => ask(s) }, s))))));
}
const msg = (who, ...c) => h('div', { class: 'as-msg ' + who }, ...c);
function scrollDown() { requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); }

// ---------------- running a request ----------------
function startCard(text) {
  if (!panel) build();
  toggleAssistant(true);
  log.append(msg('me', text));
  const card = h('div', { class: 'as-card' });
  log.append(msg('bot', card));
  scrollDown();
  return card;
}
async function runPlan(plan, card, ctx) {
  setBusy(true);
  try { await execute(plan, card, ctx); } catch (e) { card.append(h('div', { class: 'as-err' }, `Something went wrong: ${e.message}`)); }
  if (busy?.stop) card.append(h('p', { class: 'hint' }, 'Stopped.'));
  card.querySelectorAll('.as-stop').forEach((b) => b.remove());
  setBusy(false);
  scrollDown();
}
function understoodChips(plan, extra = []) {
  const chips = [];
  const act = { find: 'Find', count: 'Count', size: 'Measure', rename: 'Rename', group: 'Sort into folders', move: 'Move', copy: 'Copy', delete: 'Move to the Recycle Bin', zip: 'Zip', tag: 'Tag', open: 'Open' }[plan.action];
  chips.push(act);
  if (plan.action !== 'group' || plan.kinds.length) chips.push(describePlan(plan));
  if (plan.topic.length) chips.push(`about “${plan.topic.join(' ')}”`);
  chips.push(...plan.notes.filter((x) => x !== 'the selected items'));
  if (plan.groupBy) chips.push(describeAction({ type: plan.groupBy }).replace(/^sort into folders /, ''));
  if (plan.dest) chips.push(`to “${plan.dest}”`);
  chips.push(...extra);
  return h('div', { class: 'as-understood' }, h('span', { class: 'hint' }, 'I understood:'), ...chips.filter(Boolean).map((c) => h('span', { class: 'as-chip' }, c)));
}
function rootsFor(plan, t, sel) {
  const k = sys.known || {};
  const personal = [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music, k.onedrive].filter(Boolean);
  const sc = plan.scope;
  if (sc === 'selection') { const dirs = sel.filter((i) => i.isDir).map((i) => i.path); return { roots: dirs, files: sel.filter((i) => !i.isDir), label: 'the selected items' }; }
  if (sc === 'here') return { roots: t?.path && !isVirtual(t.path) ? [t.path] : personal, label: t?.path && !isVirtual(t.path) ? `“${basename(t.path)}”` : 'your personal folders', flat: true };
  if (sc && sc.startsWith('drive:')) { const L = sc.slice(6); const d = (state.drives || []).find((x) => (x.letter || x.path || '').toUpperCase().startsWith(L)); return { roots: [d?.path || `${L}:\\`], label: `drive ${L}:` }; }
  if (sc === 'everywhere') return { roots: (state.drives || []).filter((d) => !['network', 'optical', 'portable'].includes(d.type)).map((d) => d.path), label: 'all drives' };
  if (sc && k[sc]) return { roots: [k[sc]], label: sc.charAt(0).toUpperCase() + sc.slice(1), flat: ['move', 'delete', 'group'].includes(plan.action) };
  return { roots: personal, label: 'your personal folders (Desktop, Documents, Downloads, Pictures, Videos, Music)' };
}
async function findFiles(plan, where, card) {
  const label = h('span', {}, 'Looking…');
  const stopB = h('button', { class: 'btn small as-stop' }, 'Stop');
  stopB.onclick = stopNow;
  const status = h('div', { class: 'as-status' }, h('span', { class: 'as-spin' }), label, stopB);
  card.append(status);
  let items = [...(where.files || [])];
  if (where.roots.length) {
    const spec = { type: 'search', roots: where.roots, query: '', kind: 'file', extensions: plan.exts.join(','), recursive: !where.flat, includeHidden: false, maxResults: 30000,
      after: plan.after || null, before: plan.before || null, minSize: plan.minSize ?? null, maxSize: plan.maxSize ?? null, accessedBefore: plan.notOpenedBefore || null,
      skipDirs: ['node_modules', '.git', '__pycache__', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'] };
    const found = await new Promise(async (resolve) => {
      const acc = [];
      const id = await api('work:start', spec);
      busy?.jobs.add(id);
      if (busy) (busy.onStop ||= []).push(() => resolve(acc));
      onWorkMsgFor(id, (m) => { if (m.type === 'results') { acc.push(...m.items); label.textContent = `Looking… ${acc.length.toLocaleString()} candidates · ${m.scanned.toLocaleString()} checked`; } else resolve(acc); });
    });
    items.push(...found);
  } else {
    // selection only: apply the same filters to the selected files
    const ok = (i) => (!plan.exts.length || plan.exts.includes((i.ext || '').toLowerCase())) && (!plan.after || i.mtime >= plan.after) && (!plan.before || i.mtime < plan.before) && (!plan.minSize || i.size >= plan.minSize) && (!plan.maxSize || i.size <= plan.maxSize);
    items = items.filter(ok);
  }
  for (const f of items) if (!f.ext) f.ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  // screenplays: Final Draft / Fountain files always, Word & PDF only when the name says script / screenplay / draft
  if (plan.kinds.includes('screenplay') && plan.kinds.length === 1) items = items.filter((f) => /^(fdx|fountain|celtx|highland|sexp)$/.test(f.ext) || /screenplay|script|teleplay|pilot|draft|episode|ep\d|act ?\d|scene/i.test(f.name) || plan.topic.some((w) => f.name.toLowerCase().includes(w)));
  if (plan.nameHint) items = items.filter((f) => plan.nameHint.some((w) => f.name.toLowerCase().includes(w)) || (f.ext === 'png' && /^(?:\d|img)/i.test(f.name) === false));
  // topic: names, folder names, then (for documents) what's inside
  const why = new Map();
  if (plan.topic.length) {
    const terms = expandTopic(plan.topic);
    const hit = (s) => terms.some((w) => s.includes(w));
    const byName = [], rest = [];
    for (const f of items) {
      const n = f.name.toLowerCase(), folder = dirname(f.path).toLowerCase();
      if (hit(n)) { byName.push(f); why.set(f, 'name matches'); } else if (hit(folder.split(/[\\/]/).slice(-3).join('/'))) { byName.push(f); why.set(f, `in “${basename(dirname(f.path))}”`); } else rest.push(f);
    }
    const docs = rest.filter((f) => /^(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|html?|fdx|fountain)$/.test(f.ext)).sort((a, b) => b.mtime - a.mtime).slice(0, plan.inside ? 400 : 150);
    if (docs.length) {
      let k = 0;
      for (const f of docs) {
        if (busy?.stop) break;
        if (++k % 10 === 0) label.textContent = `Reading documents… ${k} of ${docs.length}`;
        const txt = (await api('doc:text', f.path, 8000).catch(() => '') || '').toLowerCase();
        const w = terms.find((x) => txt.includes(x));
        if (w) { byName.push(f); why.set(f, `mentions “${w}”`); }
      }
    }
    items = byName;
  }
  // newest version only: same document name after removing "final", "v2", "(1)", dates…
  if (plan.latest) {
    const { docKey } = await import('./cleanup.js');
    const groups = new Map();
    for (const f of items) { const k = docKey(f.name) || f.name; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    items = [...groups.values()].map((g) => { g.sort((a, b) => b.mtime - a.mtime); if (g.length > 1) why.set(g[0], `newest of ${g.length} versions`); g[0]._older = g.slice(1); return g[0]; });
  }
  items.sort((a, b) => (plan.minSize ? b.size - a.size : b.mtime - a.mtime));
  status.remove();
  return { items, why };
}
function fileRows(items, why, { limit = 40, checks = null } = {}) {
  const box = h('div', { class: 'as-files' });
  for (const f of items.slice(0, limit)) {
    const c = checks ? h('input', { type: 'checkbox', checked: !checks.off.has(f) }) : null;
    if (c) c.onchange = () => (c.checked ? checks.off.delete(f) : checks.off.add(f));
    const row = h('div', { class: 'as-file', title: f.path }, c, h('span', { class: 'as-art', html: fileArt(f.ext) }), h('div', { class: 'as-fn' }, h('b', {}, f.name), h('span', { class: 'hint' }, [basename(dirname(f.path)), fmtDate(f.mtime), fmtSize(f.size || 0), why?.get(f), f._older?.length ? `${f._older.length} older version${f._older.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))));
    row.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; navigate(activeTab(), dirname(f.path), { select: f.path }); });
    row.addEventListener('dblclick', () => A.openItems([{ ...f, isDir: false }]));
    box.append(row);
  }
  if (items.length > limit) box.append(h('div', { class: 'hint' }, `…and ${items.length - limit} more`));
  return box;
}
function showInTab(items, title) {
  const id = uid();
  results.set(id, { items, title });
  if (results.size > 20) results.delete(results.keys().next().value);
  openTab(`atlas:search?assist=${id}&q=${encodeURIComponent(title)}`);
}
const btn = (label, run, cls = '') => h('button', { class: 'btn small ' + cls, onclick: run }, label);

async function execute(plan, card, { t, sel }) {
  const where = rootsFor(plan, t, sel);
  card.append(understoodChips(plan, [where.label ? `in ${where.label}` : '']));
  // ----- group / organize -----
  if (plan.action === 'group') {
    let folder, files;
    if (plan.scope === 'selection') { files = sel.filter((i) => !i.isDir); folder = dirname(files[0]?.path || ''); }
    else { folder = where.roots[0]; const r = await api('fs:list', folder); files = (r.items || []).filter((i) => !i.isDir && !i.hidden); }
    if (!files?.length) return card.append(h('p', {}, 'There are no loose files there to sort.'));
    const r = await api('fs:list', folder);
    const existing = (r.items || []).filter((i) => i.isDir).map((i) => i.name);
    const plan2 = planRules([{ conditions: [], action: { type: plan.groupBy } }], files, { existingDirs: existing, folderName: basename(folder) });
    if (!plan2.length) return card.append(h('p', {}, 'I couldn’t find a sensible way to group these. Try “by type” or “by month”.'));
    const dests = new Map(); for (const p of plan2) dests.set(p.dest, (dests.get(p.dest) || 0) + 1);
    card.append(h('p', {}, `I’d sort ${plan2.length} file${plan2.length === 1 ? '' : 's'} into ${dests.size} folder${dests.size === 1 ? '' : 's'} in “${basename(folder)}”:`),
      h('div', { class: 'as-groups' }, ...[...dests.entries()].map(([d, c]) => h('span', { class: 'as-chip' }, `${d} · ${c}`))));
    card.append(h('div', { class: 'as-acts' },
      btn('Review & apply…', async () => { const { runNowDialog } = await import('./rules.js'); await runNowDialog({ folder, rules: [{ conditions: [], action: { type: plan.groupBy } }] }, { only: plan.scope === 'selection' ? files : null }); }, 'primary'),
      btn('Make it automatic', async () => { const { automationDialog } = await import('./rules.js'); automationDialog(folder, { preset: plan.groupBy }); })));
    return;
  }
  // ----- rename -----
  if (plan.action === 'rename') {
    const items = plan.scope === 'selection' ? sel.filter((i) => !i.isDir) : (await findFiles(plan, where, card)).items.slice(0, 500);
    if (!items.length) return card.append(h('p', {}, 'Select the files you want to rename first, then ask again.'));
    if (plan.renameMode === 'describe') {
      const { interpretRename } = await import('./dialogs.js');
      const r = interpretRename(plan.renameText || plan.raw);
      card.append(h('p', {}, r.notes.length ? `Opening the rename studio with: ${r.notes.join(', ')}.` : 'Opening the rename studio so you can describe the new names.'));
      const { renameStudio } = await import('./renamestudio.js');
      renameStudio(items, { ...r, spaces: r.spaces ? '_' : '' });
      return;
    }
    const status = h('div', { class: 'as-status' }, h('span', { class: 'as-spin' }), 'Reading the files…');
    card.append(status);
    const newNames = new Map();
    if (plan.renameMode === 'content') {
      const docs = items.filter((i) => !KINDS.image.includes(i.ext) && !KINDS.audio.includes(i.ext) && !KINDS.video.includes(i.ext));
      const titles = docs.length ? await api('doc:titles', docs.map((d) => d.path)) : [];
      docs.forEach((d, i) => { if (titles[i]) newNames.set(d, titles[i]); });
    }
    const MM = await import('./mediameta.js');
    if (plan.renameMode !== 'tags') await MM.ensureMeta(items.filter((i) => KINDS.image.includes(i.ext) || KINDS.video.includes(i.ext)));
    for (const it of items) {
      if (newNames.has(it)) continue;
      if (KINDS.audio.includes(it.ext)) { const tg = (await api('tags:read', it.path).catch(() => null))?.tags || {}; if (tg.title) newNames.set(it, tg.artist ? `${tg.artist} - ${tg.title}` : tg.title); continue; }
      if (KINDS.image.includes(it.ext) || KINDS.video.includes(it.ext)) { const m = MM.metaOf(it) || {}; const d = new Date(m.taken || it.mtime); const z2 = (x) => String(x).padStart(2, '0'); newNames.set(it, `${KINDS.video.includes(it.ext) ? 'Video' : 'Photo'} ${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())} ${z2(d.getHours())}.${z2(d.getMinutes())}.${z2(d.getSeconds())}${m.camera ? ` (${m.camera})` : ''}`); }
    }
    status.remove();
    const clean = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 90);
    const used = new Set();
    const pairs = [];
    for (const it of items) {
      const nn = newNames.get(it);
      if (!nn) continue;
      const ext = it.name.includes('.') ? it.name.slice(it.name.lastIndexOf('.')) : '';
      let base = clean(nn), name = base + ext, k = 2;
      while (used.has(name.toLowerCase())) name = `${base} (${k++})${ext}`;
      used.add(name.toLowerCase());
      if (name !== it.name) pairs.push({ it, from: it.path, to: pjoin(dirname(it.path), name), name });
    }
    if (!pairs.length) return card.append(h('p', {}, 'I couldn’t find better names inside these files. Try the rename studio (F2 with several files selected).'));
    const off = new Set();
    const list = h('div', { class: 'as-files' }, ...pairs.map((p) => { const c = h('input', { type: 'checkbox', checked: true }); c.onchange = () => (c.checked ? off.delete(p) : off.add(p)); return h('label', { class: 'as-file rn' }, c, h('div', { class: 'as-fn' }, h('span', { class: 'hint' }, p.it.name), h('b', {}, '→ ' + p.name))); }));
    card.append(h('p', {}, `New names for ${pairs.length} of ${items.length} file${items.length === 1 ? '' : 's'} (${items.length - pairs.length} kept their names):`), list,
      h('div', { class: 'as-acts' }, btn('Rename', async (e) => { e.target.disabled = true; const go = pairs.filter((p) => !off.has(p)); await A.renamePairs(go, `Rename ${go.length} files using their contents`); card.append(h('p', { class: 'as-done' }, `Done. Renamed ${go.length}. Ctrl+Z puts the old names back.`)); }, 'primary'),
        btn('Edit in rename studio…', async () => { const { renameStudio } = await import('./renamestudio.js'); renameStudio(items, { template: '{content}' }); })));
    return;
  }
  // ----- everything else starts by finding files -----
  if (plan.duplicates) {
    card.append(h('p', {}, 'Duplicates are best checked in Storage cleanup, which compares file contents and shows how much space you’d get back.'), h('div', { class: 'as-acts' }, btn('Open Storage cleanup', () => import('./cleanup.js').then((m) => m.openCleanup(where.roots.length === 1 ? where.roots[0] : undefined)), 'primary')));
    return;
  }
  const isSelOnly = plan.scope === 'selection' && !where.roots.length && ['move', 'copy', 'delete', 'zip', 'tag', 'open'].includes(plan.action);
  const { items, why } = isSelOnly ? { items: sel.filter((i) => !i.isDir).concat(sel.filter((i) => i.isDir)), why: new Map() } : await findFiles(plan, where, card);
  const total = items.reduce((a, f) => a + (f.size || 0), 0);
  if (items.length) { C.items = items; C.plan = plan; }
  if (!items.length) {
    const tips = [];
    if (plan.topic.length && plan.kinds.some((k) => ['image', 'video', 'audio'].includes(k))) tips.push(btn('Search inside the pictures with AI', () => { const q = encodeURIComponent(plan.raw); navigate(activeTab(), `atlas:search?q=${q}&ai=1`); }, 'primary'));
    if (plan.after || plan.before) tips.push(h('span', { class: 'hint' }, 'Tip: try without the date.'));
    card.append(h('p', {}, 'I didn’t find anything that matches.'), h('div', { class: 'as-acts' }, ...tips));
    return;
  }
  if (plan.action === 'count' || plan.action === 'size') {
    const byKind = new Map();
    for (const f of items) { const k = KINDS.image.includes(f.ext) ? 'Pictures' : KINDS.video.includes(f.ext) ? 'Videos' : KINDS.audio.includes(f.ext) ? 'Music' : f.ext ? f.ext.toUpperCase() + ' files' : 'Other'; const x = byKind.get(k) || [0, 0]; x[0]++; x[1] += f.size || 0; byKind.set(k, x); }
    card.append(h('p', { class: 'as-big' }, plan.action === 'count' ? `${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'}` : `${fmtSize(total)}`, h('span', { class: 'hint' }, plan.action === 'count' ? ` · ${fmtSize(total)}` : ` in ${items.length.toLocaleString()} files`)),
      h('div', { class: 'as-groups' }, ...[...byKind.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8).map(([k, [c, sz]]) => h('span', { class: 'as-chip' }, `${k}: ${c.toLocaleString()} · ${fmtSize(sz)}`))),
      h('p', { class: 'hint' }, 'Biggest:'), fileRows([...items].sort((a, b) => b.size - a.size), why, { limit: 6 }),
      h('div', { class: 'as-acts' }, btn('Show all in a tab', () => showInTab(items, plan.raw), 'primary'), btn('Storage cleanup…', () => import('./cleanup.js').then((m) => m.openCleanup()))));
    return;
  }
  const checks = ['move', 'copy', 'delete', 'zip', 'tag'].includes(plan.action) ? { off: new Set() } : null;
  card.append(h('p', {}, `${plan.latest ? 'Newest version' + (items.length > 1 ? 's' : '') : 'Found'}: ${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'} · ${fmtSize(total)}`), fileRows(items, why, { checks, limit: checks ? 200 : 40 }));
  const chosen = () => items.filter((f) => !checks?.off.has(f));
  const acts = h('div', { class: 'as-acts' });
  card.append(acts);
  const done = (text) => card.append(h('p', { class: 'as-done' }, text));
  if (plan.action === 'find' || plan.action === 'open') {
    acts.append(btn('Show all in a tab', () => showInTab(items, plan.raw), 'primary'));
    if (plan.action === 'open' || items.length === 1) acts.append(btn(items.length === 1 ? 'Open it' : `Open ${Math.min(items.length, 10)}`, () => A.openItems(items.slice(0, 10).map((f) => ({ ...f, isDir: false })))));
    if (items.length === 1) acts.append(btn('Show in folder', () => navigate(activeTab(), dirname(items[0].path), { select: items[0].path })));
    acts.append(h('span', { class: 'hint' }, 'Then you can say “move them to…”, “zip them”, “only the PDFs”…'));
    return;
  }
  if (plan.action === 'move' || plan.action === 'copy') {
    const dest = await resolveDest(plan.dest, t);
    if (!dest) { acts.append(btn(`Choose where to ${plan.action}…`, async () => { const d = await api('dialog:pickFolder', `${plan.action === 'move' ? 'Move' : 'Copy'} to`); if (d) { const j = await A.transfer(chosen().map((f) => f.path), d, plan.action); if (j?.status === 'done') done(`Done. Ctrl+Z undoes it.`); } }, 'primary')); return; }
    acts.append(h('span', { class: 'hint' }, `${plan.action === 'move' ? 'Move' : 'Copy'} to ${dest.path}${dest.create ? ' (a new folder)' : ''}`),
      btn(plan.action === 'move' ? 'Move' : 'Copy', async (e) => {
        const go = chosen();
        if (go.length > 25 && !(await confirm(`${plan.action === 'move' ? 'Move' : 'Copy'} ${go.length} files?`, `To ${esc(dest.path)}`, { ok: plan.action === 'move' ? 'Move' : 'Copy' }))) return;
        e.target.disabled = true;
        if (dest.create) await api('fs:mkdir', dest.path).catch(() => {});
        const j = await A.transfer(go.map((f) => f.path), dest.path, plan.action);
        if (j?.status === 'done') done(`Done. ${go.length} file${go.length === 1 ? '' : 's'} ${plan.action === 'move' ? 'moved' : 'copied'}. Ctrl+Z undoes it.`);
      }, 'primary'));
    return;
  }
  if (plan.action === 'delete') {
    acts.append(btn('Move to Recycle Bin…', async (e) => {
      const go = chosen();
      if (!(await confirm(`Move ${go.length} file${go.length === 1 ? '' : 's'} to the Recycle Bin?`, `${fmtSize(go.reduce((a, f) => a + (f.size || 0), 0))}. You can restore them from the Recycle Bin.`, { ok: 'Recycle', danger: true }))) return;
      e.target.disabled = true;
      const j = await A.runJob({ type: 'trash', sources: go.map((f) => f.path) });
      done(j.status === 'done' ? `Done. Recycled ${go.length}. Ctrl+Z restores them.` : `Finished with problems: ${j.errors?.[0] || j.error || ''}`);
    }, 'primary danger'));
    return;
  }
  if (plan.action === 'zip') { acts.append(btn('Zip them', async () => { await A.quickZip(chosen().map((f) => ({ ...f, isDir: !!f.isDir }))); done('Zipped.'); }, 'primary')); return; }
  if (plan.action === 'tag') {
    const tag = state.tags.defs.find((d) => d.id === plan.tag || d.name.toLowerCase() === plan.tag) || state.tags.defs[0];
    acts.append(btn(`Tag ${tag?.name || ''}`, () => { setTags(chosen().map((f) => f.path), tag.id, true); done(`Tagged ${chosen().length} ${tag.name}.`); }, 'primary'));
  }
}
async function resolveDest(name, t) {
  if (!name) return null;
  const k = sys.known || {};
  const known = { documents: k.documents, document: k.documents, desktop: k.desktop, downloads: k.downloads, pictures: k.pictures, photos: k.pictures, videos: k.videos, music: k.music, onedrive: k.onedrive };
  const key = name.toLowerCase().replace(/^(my|the)\s+/, '').replace(/\s+folder$/, '').trim();
  if (known[key]) return { path: known[key] };
  if (/^([a-z]:[\\/]|\\\\|\/)/i.test(name)) return { path: name, create: !(await api('fs:stat', name)) };
  const base = t?.path && !isVirtual(t.path) ? t.path : k.documents;
  const p = pjoin(base, name.replace(/[<>:"/\\|?*]/g, '_'));
  return { path: p, create: !(await api('fs:stat', p)) };
}

// ---------------- understanding a message ----------------
const FILLER = /\b(actually|instead|rather|also|too|no|nope|wait|ok|okay|then|please|just|now|hmm|oh|so)\b,?/gi;
const FOLLOW = /\b(instead|actually|rather|also|them|those|these|it|that|that one|the same|same ones|again|the files?|the results?)\b/i;
const FILE_Q = /^\s*(how (much|many|big)|where (is|are|did) (my|the|i)|which of my|can you (find|show|get|list|delete|remove|move|copy|zip|compress|tag|rename|sort|organi[sz]e|group|open)|could you (find|show|get|move|copy|zip|tag|rename|sort)|show me (my|all|the)|do i have)\b/i;
const HELP_Q = /^\s*(what|what's|whats|how|why|where|can i|could i|is there|are there|does|do you|do i|which|when|explain|tell me|help|i don'?t (understand|get)|what'?s the (point|difference))\b|\?\s*$/i;
const hasTarget = (p) => !!(p.kinds.length || p.topic.length || p.exts.length || p.quoted.length || (p.scope && p.scope !== 'selection') || p.after || p.before || p.minSize || p.maxSize || p.notOpenedBefore || p.duplicates || p.latest);

function ask(text) { return askAssistant(text); }
export async function askAssistant(text) {
  if (busy) stopNow();
  const t = activeTab();
  const sel = selectedItems(t).filter((i) => !i.virtual);
  // small talk
  if (/^\s*(hi|hello|hey|yo|thanks|thank you|thx|cheers|good (morning|evening|afternoon))\b[\s!.]*$/i.test(text)) {
    const card = startCard(text);
    card.append(h('p', {}, /thank|thx|cheers/i.test(text) ? 'You’re welcome!' : 'Hi! Ask me to find or tidy files, or how to do something in Dogfile.'));
    return;
  }
  // questions about Dogfile itself
  if (HELP_Q.test(text) && !FILE_Q.test(text)) {
    const plan = parseRequest(text, { hasSelection: false });
    const fileish = plan.kinds.length || plan.after || plan.before || plan.minSize || plan.maxSize || plan.notOpenedBefore || /\b(my|downloaded|saved)\b/i.test(text);
    const appish = /\b(dogfile|feature|setting|settings|button|menu|ribbon|sidebar|tab|pane|mean|means|do i|can i|how to|how do|shortcut|key)\b/i.test(text);
    if (!fileish || appish) { answerHelp(text, await helpSearch(text), startCard(text)); return; }
  }
  const cleaned = text.replace(FILLER, ' ').replace(/\s+/g, ' ').trim() || text;
  const refine = C.items && !sel.length && /^\s*(only|just|of (those|these|them)|from (those|these|them)|which of (those|these|them)|keep only)\b/i.test(text);
  const plan = parseRequest(cleaned, { hasSelection: sel.length > 0 || !!C.items });
  // "only the PDFs", "just the big ones": narrow what was found last
  if (refine) {
    const card = startCard(text);
    plan.action = plan.action === 'find' ? 'find' : plan.action;
    plan.scope = 'selection';
    return runPlan(plan, card, { t, sel: C.items.map((f) => ({ ...f, isDir: !!f.isDir })) });
  }
  // follow-ups ("actually zip it instead", "move them to Archive", "tag them red") act on what we were just talking about
  if (C.items && !sel.length && plan.action !== 'find' && (!hasTarget(plan) || FOLLOW.test(text))) {
    const card = startCard(text);
    plan.scope = 'selection';
    plan.topic = []; plan.kinds = []; plan.exts = []; plan.quoted = [];
    return runPlan(plan, card, { t, sel: C.items.map((f) => ({ ...f, isDir: !!f.isDir })) });
  }
  // nothing to go on: try the help, otherwise say so
  if (plan.action === 'find' && !hasTarget(plan) && plan.scope !== 'selection') {
    const hits = await helpSearch(text);
    answerHelp(text, hits, startCard(text));
    return;
  }
  return runPlan(plan, startCard(text), { t, sel });
}

// ---------------- help: answers from Dogfile's own feature list, commands and guide ----------------
let HELP = null;
const HSTOP = new Set('what whats what\'s does do did how i me my the a an is are was can could would should to of in on for with and or you your it this that these those there here mean means meaning work works working use using used dogfile app feature features thing stuff way want wanna need get make makes where why when which who please explain tell about any some does doesnt don\'t dont not no be have has if then than so just like into from by at as up out off its'.split(' '));
const stemW = (w) => w.replace(/(ings?|edly|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
const toks = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9+]+/).filter((w) => w.length > 1 && !HSTOP.has(w)).map(stemW).filter((w) => w.length > 1);
async function loadHelp() {
  if (HELP) return HELP;
  let list = [];
  try { list = await (await fetch(new URL('../assets/help.json', import.meta.url))).json(); } catch {}
  let cmds = new Map();
  try { cmds = (await import('./commands.js')).commands; } catch {}
  const entries = list.map((e) => ({ ...e, N: toks(e.n + ' ' + (e.q || '')), H: toks(e.h), A: toks(e.a) }));
  for (const c of cmds.values()) if (!c.hidden && c.title && c.run) entries.push({ cmd: c, n: c.title, a: c.cat || 'Commands', h: c.keys?.length ? `Shortcut: ${c.keys[0]}. Also in the command palette (Ctrl+Shift+P).` : 'In the command palette (Ctrl+Shift+P).', N: toks(c.title), H: [], A: toks(c.cat) });
  return (HELP = entries);
}
const hasTok = (list, w) => list.some((x) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x)) && Math.min(x.length, w.length) >= 4));
async function helpSearch(text) {
  const q = toks(text);
  if (!q.length) return [];
  const all = await loadHelp();
  const out = [];
  for (const e of all) {
    let score = 0, hit = 0;
    for (const w of q) { const s2 = hasTok(e.N, w) ? 3 : hasTok(e.H, w) ? 1 : hasTok(e.A, w) ? 0.5 : 0; if (s2) hit++; score += s2; }
    if (!hit) continue;
    score *= hit / q.length; // reward answers that cover the whole question
    if (e.x) score += 0.5; // hand-written explanations first
    if (e.cmd) score -= 0.3;
    out.push({ e, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}
function answerHelp(text, hits, card) {
  const vague = !toks(text).length;
  if (!hits.length || hits[0].score < 1.5) {
    card.append(h('p', {}, vague ? 'Which part of Dogfile do you mean? Tell me its name, for example “what does Smart drop do?” or “how do I pin a folder?”.' : 'I can’t answer that one, sorry. I can explain Dogfile’s features and settings, and find, count, measure, move, copy, zip, tag, rename, sort or recycle your files.'),
      h('div', { class: 'as-sugg' }, ...['What can you do?', 'How do I split the window?', 'Find videos bigger than 1 GB', 'How do I see copy progress?'].map((x) => h('button', { class: 'chip', onclick: () => ask(x) }, x))));
    return;
  }
  const top = hits.filter((x) => x.score >= hits[0].score * 0.6).slice(0, 3);
  const cmdFor = (e) => e.cmd || (HELP || []).find((c) => c.cmd && c.n.toLowerCase() === e.n.toLowerCase())?.cmd;
  for (const { e } of top) {
    const c = cmdFor(e);
    card.append(h('div', { class: 'as-help' },
      h('div', {}, h('b', {}, e.n), h('span', { class: 'as-chip' }, e.a)),
      h('p', {}, e.h),
      c ? h('div', { class: 'as-acts' }, btn(`Do it: ${c.title}`, () => { try { c.run(); } catch (err) { toast(err.message, { error: true }); } })) : null));
  }
  card.append(h('p', { class: 'hint' }, 'Not it? Ask in other words, or search every command with Ctrl+Shift+P.'));
  scrollDown();
}
bus.on('assistant', (q) => (q ? askAssistant(q) : toggleAssistant()));
