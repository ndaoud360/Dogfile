// AI file assistant: ask in plain words ("PDFs about taxes from last year", "group these by type",
// "rename these using their contents", "files I haven't opened in six months"). It shows how it understood the
// request and what it found, previews any change, and asks before doing anything big or destructive.
// Everything runs on this PC: a request grammar, name & content matching, and (optionally) the local AI models.
import { api, state, sys, bus, h, esc, toast, fmtSize, fmtDate, basename, dirname, pjoin, IS_WIN, KINDS, TEXT_EXTS, uid, setTags, isVirtual } from './core.js';
import { icon, fileArt } from './icons.js';
import { modal, confirm } from './dialogs.js';
import { activeTab, navigate, selectedItems, openTab, loadTab } from './pane.js';
import * as A from './actions.js';
import { parseRequest, expandTopic, describePlan } from './assistant-parse.js';
import { onWorkMsgFor } from './tools.js';
import { planRules, describeAction } from './organize.js';
import { parseAppRequest, writingRequest, APP_SUGGEST } from './assistant-apps.js';
import { matchIntent, OVER_APPS } from './assistant-intents.js';
import { activeAppTab, appAsk } from './apptabs.js';
import { requirePro } from './license.js';

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
const SUGGEST = ['What can you do?', 'Show me PDFs about taxes from last year', 'Group these by type', 'Find files I haven’t opened in six months', 'Rename these using their contents', 'How much space do my videos take?', 'Top 20 largest files on this drive', 'Organize my Downloads', 'Switch to dark mode'];

export function toggleAssistant(force) {
  const wantOpen = force ?? !panel?.classList.contains('open');
  if (wantOpen && !requirePro('assistant')) return;
  if (!panel) build();
  const open = wantOpen;
  panel.classList.toggle('open', open);
  document.body.classList.toggle('assistant-open', open);
  if (open) { placeholder(); setTimeout(() => input.focus(), 50); }
  bus.emit('syncFrames');
}
function placeholder() {
  if (!input) return;
  const app = activeAppTab()?.app;
  input.placeholder = app === 'editor' ? 'Tell Notepad what to do or write… (Enter to send)' : app === 'viewer' ? 'Tell Photos what to do… (Enter to send)' : app === 'player' ? 'Tell the Player what to do… (Enter to send)' : 'Ask about your files… (Enter to send)';
}
for (const ev of ['tabs', 'activePane', 'layout']) bus.on(ev, () => { if (panel?.classList.contains('open')) placeholder(); });
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
const APP_NAME = { editor: 'Notepad', viewer: 'Photos', player: 'the Player' };
function hello() {
  const app = activeAppTab()?.app;
  if (APP_SUGGEST[app]) { log.append(msg('bot', h('div', {}, h('p', {}, `Tell me what to do in ${APP_NAME[app]} — several things at once is fine (“…and then…”).`), h('div', { class: 'as-sugg' }, ...APP_SUGGEST[app].map((x) => h('button', { class: 'chip', onclick: () => ask(x) }, x)))))); return; }
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
  const act = { find: 'Find', count: 'Count', size: 'Measure', rename: 'Rename', group: 'Sort into folders', move: 'Move', copy: 'Copy', delete: 'Move to the Recycle Bin', zip: 'Zip', tag: 'Tag', open: 'Open', shelf: 'Put on the Drop Shelf' }[plan.action];
  chips.push(act);
  if ((plan.action !== 'group' || plan.kinds.length) && !plan.emptyDirs) chips.push(describePlan(plan));
  if (plan.topic.length) chips.push(`about “${plan.topic.join(' ')}”`);
  chips.push(...plan.notes.filter((x) => x !== 'the selected items'));
  if (plan.groupBy) chips.push(describeAction({ type: plan.groupBy }).replace(/^sort into folders /, ''));
  if (plan.dest) chips.push(`to “${plan.dest}”`);
  if (plan.topic.length === 0 && plan.contentText) chips.push(`containing “${plan.contentText}”`);
  chips.push(...extra);
  return h('div', { class: 'as-understood' }, h('span', { class: 'hint' }, 'I understood:'), ...chips.filter(Boolean).map((c) => h('span', { class: 'as-chip' }, c)));
}
function rootsFor(plan, t, sel) {
  const k = sys.known || {};
  const personal = [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music, k.onedrive].filter(Boolean);
  // several places at once ("across my Downloads and Desktop folders")
  if (plan.scopes?.length > 1) {
    const parts = plan.scopes.map((x) => rootsFor({ ...plan, scopes: null, scope: x }, t, sel));
    return { roots: [...new Set(parts.flatMap((p) => p.roots))], label: parts.map((p) => p.label).join(' and '), flat: parts.every((p) => p.flat) };
  }
  // a folder named in the request ("in my projects folder"): found among the usual places
  if (plan.resolvedFolder) return { roots: [plan.resolvedFolder], label: `“${basename(plan.resolvedFolder)}”`, flat: false };
  const sc = plan.scope;
  if (sc === 'selection') { const dirs = sel.filter((i) => i.isDir).map((i) => i.path); return { roots: dirs, files: sel.filter((i) => !i.isDir), label: 'the selected items' }; }
  if (sc === 'here') return { roots: t?.path && !isVirtual(t.path) ? [t.path] : personal, label: t?.path && !isVirtual(t.path) ? `“${basename(t.path)}”${plan.recursive ? ' and its subfolders' : ''}` : 'your personal folders', flat: !plan.recursive };
  if (sc && sc.startsWith('drive:')) { const L = sc.slice(6); const d = (state.drives || []).find((x) => (x.letter || x.path || '').toUpperCase().startsWith(L)); return { roots: [d?.path || `${L}:\\`], label: `drive ${L}:` }; }
  if (sc === 'everywhere') return { roots: (state.drives || []).filter((d) => !['network', 'optical', 'portable'].includes(d.type)).map((d) => d.path), label: 'all drives' };
  if (sc && k[sc]) return { roots: [k[sc]], label: sc.charAt(0).toUpperCase() + sc.slice(1), flat: ['move', 'delete', 'group'].includes(plan.action) && !plan.recursive && !plan.emptyDirs };
  return { roots: personal, label: 'your personal folders (Desktop, Documents, Downloads, Pictures, Videos, Music)' };
}
const TEXTISH = /^(pdf|docx?|odt|rtf|txt|md|markdown|xlsx?|ods|csv|tsv|pptx?|odp|html?|fdx|fountain|json|xml|ya?ml|toml|ini|cfg|conf|config|env|properties|log|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|cs|cpp|c|h|hpp|php|sh|ps1|bat|cmd|sql|css|scss|vue|svelte|srt|vtt)$/;
const hasMeta = (p) => !!(p.cameras || p.gps || p.orient || p.minW || p.minH || p.minSide || p.minBpm || p.maxBpm || p.key || p.minDur || p.maxDur || p.vcodec || p.takenAfter || p.takenBefore);
async function findFiles(plan, where, card) {
  const label = h('span', {}, 'Looking…');
  const stopB = h('button', { class: 'btn small as-stop' }, 'Stop');
  stopB.onclick = stopNow;
  const status = h('div', { class: 'as-status' }, h('span', { class: 'as-spin' }), label, stopB);
  card.append(status);
  let items = [...(where.files || [])];
  const runSearch = (spec) => new Promise(async (resolve) => {
    const acc = [];
    const id = await api('work:start', spec);
    busy?.jobs.add(id);
    if (busy) (busy.onStop ||= []).push(() => resolve(acc));
    onWorkMsgFor(id, (m) => { if (m.type === 'results') { acc.push(...m.items); label.textContent = `Looking… ${acc.length.toLocaleString()} candidates · ${(m.scanned || 0).toLocaleString()} checked`; } else resolve(acc); });
  });
  const skipDirs = ['node_modules', '.git', '__pycache__', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'];
  if (where.roots.length) {
    // a typed key or phrase inside code / settings files: let the search read the files (fast, case-insensitive)
    const textOnly = plan.inside && plan.exts.length && plan.exts.every((e) => TEXTISH.test(e) && !/^(pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/.test(e));
    const content = textOnly ? (plan.contentText || (plan.quoted.length === 1 ? plan.quoted[0] : '')) : '';
    const spec = { type: 'search', roots: where.roots, query: plan.regex || '', regex: !!plan.regex, kind: 'file', extensions: plan.exts.join(','), excludeExtensions: (plan.excludeExts || []).join(','), recursive: !where.flat, includeHidden: plan.kinds.includes('config') || plan.exts.some((e) => ['env', 'gitignore', 'npmrc', 'editorconfig'].includes(e)), maxResults: plan.top ? 200000 : 30000,
      after: plan.after || null, before: plan.before || null, createdAfter: plan.createdAfter || null, createdBefore: plan.createdBefore || null, minSize: plan.minSize ?? null, maxSize: plan.maxSize ?? null, accessedBefore: plan.notOpenedBefore || null,
      content: content || undefined, skipDirs };
    const found = await runSearch(spec);
    if (content) { plan.topic = []; for (const f of found) f._why = `contains “${content}”`; }
    items.push(...found);
  } else {
    // selection only: apply the same filters to the selected files
    const ok = (i) => (!plan.exts.length || plan.exts.includes((i.ext || '').toLowerCase())) && !(plan.excludeExts || []).includes((i.ext || '').toLowerCase()) && (!plan.after || i.mtime >= plan.after) && (!plan.before || i.mtime < plan.before) && (!plan.minSize || i.size >= plan.minSize) && (!plan.maxSize || i.size <= plan.maxSize);
    items = items.filter(ok);
  }
  for (const f of items) if (!f.ext) f.ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  // screenplays: Final Draft / Fountain files always, Word & PDF only when the name says script / screenplay / draft
  if (plan.kinds.includes('screenplay') && plan.kinds.length === 1) items = items.filter((f) => /^(fdx|fountain|celtx|highland|sexp)$/.test(f.ext) || /screenplay|script|teleplay|pilot|draft|episode|ep\d|act ?\d|scene/i.test(f.name) || plan.topic.some((w) => f.name.toLowerCase().includes(w)));
  if (plan.nameHint) items = items.filter((f) => plan.nameHint.some((w) => f.name.toLowerCase().includes(w)) || (f.ext === 'png' && /^(?:\d|img)/i.test(f.name) === false));
  const why = new Map();
  for (const f of items) if (f._why) why.set(f, f._why);
  // topic: names, folder names, then (for documents and text files) what's inside
  if (plan.topic.length) {
    const terms = expandTopic(plan.topic);
    const hit = (s) => terms.some((w) => s.includes(w));
    const byName = [], rest = [];
    for (const f of items) {
      const n = f.name.toLowerCase(), folder = dirname(f.path).toLowerCase();
      if (!plan.inside && hit(n)) { byName.push(f); why.set(f, 'name matches'); } else if (!plan.inside && hit(folder.split(/[\\/]/).slice(-3).join('/'))) { byName.push(f); why.set(f, `in “${basename(dirname(f.path))}”`); } else if (plan.inside && hit(n)) { byName.push(f); why.set(f, 'name matches'); } else rest.push(f);
    }
    const docs = rest.filter((f) => TEXTISH.test(f.ext)).sort((a, b) => b.mtime - a.mtime).slice(0, plan.inside ? 600 : 150);
    if (docs.length) {
      let k = 0;
      for (const f of docs) {
        if (busy?.stop) break;
        if (++k % 10 === 0) label.textContent = `Reading documents… ${k} of ${docs.length}`;
        const txt = (await api('doc:text', f.path, 200000).catch(() => '') || '').toLowerCase();
        const w = terms.find((x) => txt.includes(x));
        if (w) { byName.push(f); why.set(f, `mentions “${w}”`); }
      }
    }
    items = byName;
  }
  // newest version only (or only the older ones): same document name after removing "final", "v2", "(1)", dates…
  if (plan.latest || plan.oldVersions) {
    const { docKey } = await import('./cleanup.js');
    const groups = new Map();
    for (const f of items) { const k = docKey(f.name) || f.name; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    if (plan.latest) items = [...groups.values()].map((g) => { g.sort((a, b) => b.mtime - a.mtime); if (g.length > 1) why.set(g[0], `newest of ${g.length} versions`); g[0]._older = g.slice(1); return g[0]; });
    else items = [...groups.values()].filter((g) => g.length > 1).flatMap((g) => { g.sort((a, b) => b.mtime - a.mtime); return g.slice(1).map((f) => { why.set(f, `older version (newest is ${g[0].name})`); return f; }); });
  }
  // what's inside pictures, videos and songs: camera, GPS, size, orientation, length, codec, tempo, key
  if (hasMeta(plan) && items.length) {
    const MM = await import('./mediameta.js');
    label.textContent = `Reading ${items.length.toLocaleString()} file details…`;
    const need = [plan.gps && 'gps', plan.vcodec && 'vcodec'].filter(Boolean);
    const pool = items.slice(0, 20000);
    await MM.ensureMeta(pool, { need, audio: true });
    if (plan.minBpm || plan.maxBpm || plan.key) {
      // songs not analysed yet: analyse up to 300 now (BPM / key)
      const todo = pool.filter((f) => MM.isAud(f) && !(MM.metaOf(f)?.bpm)).slice(0, 300);
      if (todo.length) { const { analyzeAudio } = await import('./audio-analysis.js'); let k = 0; for (const f of todo) { if (busy?.stop) break; label.textContent = `Finding tempo and key… ${++k} of ${todo.length}`; try { const a = await analyzeAudio(f.path); MM.setMeta(f, { bpm: a.bpm, key: a.keyLabel, camelot: a.camelot }); } catch {} } }
    }
    const { compatibleKeys } = MM;
    const cams = (plan.cameras || []).map((c) => c.toLowerCase().replace(/^apple\s+/, ''));
    items = pool.filter((f) => {
      const m = MM.metaOf(f) || {};
      if (cams.length && !cams.some((c) => (m.camera || '').toLowerCase().includes(c) || (c === 'iphone' && /apple/i.test(m.camera || '')))) return false;
      if (plan.gps && !m.gps) return false;
      if (plan.orient === 'portrait' && !(m.h > m.w)) return false;
      if (plan.orient === 'landscape' && !(m.w > m.h)) return false;
      if (plan.minW && !(m.w >= plan.minW)) return false;
      if (plan.minH && !(m.h >= plan.minH)) return false;
      if (plan.minSide && !(Math.max(m.w || 0, m.h || 0) >= plan.minSide)) return false;
      if (plan.minDur && !(m.dur >= plan.minDur)) return false;
      if (plan.maxDur && !(m.dur > 0 && m.dur <= plan.maxDur)) return false;
      if (plan.vcodec && (m.vcodec || '').toLowerCase() !== plan.vcodec) return false;
      if (plan.minBpm && !(m.bpm >= plan.minBpm)) return false;
      if (plan.maxBpm && !(m.bpm > 0 && m.bpm <= plan.maxBpm)) return false;
      if (plan.key && m.camelot !== plan.key && !(plan.keyCompat && compatibleKeys(plan.key).includes(m.camelot))) return false;
      const taken = m.taken || f.mtime;
      if (plan.takenAfter && !(taken >= plan.takenAfter)) return false;
      if (plan.takenBefore && !(taken < plan.takenBefore)) return false;
      const bits = [m.camera, m.w && m.h ? `${m.w}×${m.h}` : '', m.dur ? MM.fmtDur(m.dur) : '', plan.vcodec && m.vcodec ? m.vcodec.toUpperCase() : '', m.bpm ? `${Math.round(m.bpm)} BPM` : '', m.key && (plan.key || plan.minBpm) ? `${m.key} (${m.camelot})` : '', plan.gps ? 'GPS' : ''].filter(Boolean);
      if (bits.length) why.set(f, bits.join(' · '));
      return true;
    });
  }
  if (plan.sortBy === 'newest') items.sort((a, b) => b.mtime - a.mtime);
  else if (plan.sortBy === 'oldest') items.sort((a, b) => a.mtime - b.mtime);
  else if (plan.sortBy === 'sizeAsc') items.sort((a, b) => a.size - b.size);
  else items.sort((a, b) => (plan.minSize || plan.sortBy === 'size' ? b.size - a.size : b.mtime - a.mtime));
  if (plan.top) items = items.slice(0, plan.top);
  status.remove();
  return { items, why };
}
// empty folders (nothing inside, not even hidden files) under the roots
async function findEmptyDirs(where, card) {
  if (!where.roots?.length) return [];
  const label = h('span', {}, 'Looking for empty folders…');
  const status = h('div', { class: 'as-status' }, h('span', { class: 'as-spin' }), label);
  card.append(status);
  const dirs = [];
  await new Promise(async (resolve) => {
    const id = await api('work:start', { type: 'search', roots: where.roots, query: '', kind: 'dir', recursive: true, includeHidden: true, maxResults: 20000, skipDirs: ['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'] });
    busy?.jobs.add(id);
    if (busy) (busy.onStop ||= []).push(resolve);
    onWorkMsgFor(id, (m) => { if (m.type === 'results') dirs.push(...m.items); else resolve(); });
  });
  const empty = [];
  let k = 0;
  // deepest first, so a folder that only holds empty folders counts as empty too
  const sorted = dirs.sort((a, b) => b.path.length - a.path.length);
  const emptySet = new Set();
  for (const d of sorted) {
    if (busy?.stop) break;
    if (++k % 50 === 0) label.textContent = `Checking folders… ${k} of ${sorted.length}`;
    const r = await api('fs:list', d.path, { hidden: true }).catch(() => null);
    if (!r || r.error) continue;
    const kids = r.items || [];
    if (kids.every((x) => x.isDir && emptySet.has(x.path))) { emptySet.add(d.path); empty.push({ ...d, isDir: true, size: 0 }); }
  }
  status.remove();
  // only the outermost empty folder of a chain is shown (recycling it takes the rest)
  return empty.filter((d) => !emptySet.has(dirname(d.path)));
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
function showInTab(items, title, { view, mf } = {}) {
  const id = uid();
  results.set(id, { items, title });
  if (results.size > 20) results.delete(results.keys().next().value);
  const nt = openTab(`atlas:search?assist=${id}&q=${encodeURIComponent(title)}`);
  if (nt && (view || mf)) setTimeout(async () => { const P = await import('./pane.js'); if (mf) nt.mf = mf; if (view) P.setView(nt, view); else { P.recompute(nt); P.renderTabPanes(nt); } }, 300);
  return nt;
}
const btn = (label, run, cls = '') => h('button', { class: 'btn small ' + cls, onclick: run }, label);

// a folder named in the request ("my projects folder"): look in the user folders and one level below them
async function resolveNamedFolder(name) {
  const k = sys.known || {};
  const want = name.toLowerCase().replace(/^(my|the)\s+/, '');
  const bases = [k.home, k.documents, k.desktop, k.downloads, k.pictures, k.videos, k.music, k.onedrive, ...(state.pinned || [])].filter(Boolean);
  for (const b of bases) if (basename(b).toLowerCase() === want) return b;
  const cur = activeTab()?.path && !isVirtual(activeTab().path) ? activeTab().path : null;
  if (cur && basename(cur).toLowerCase() === want) return cur;
  for (const b of [cur, cur && dirname(cur), k.home, k.documents, k.desktop, k.onedrive].filter(Boolean)) {
    const r = await api('fs:list', b).catch(() => null);
    const hit = (r?.items || []).find((i) => i.isDir && (i.name.toLowerCase() === want || i.name.toLowerCase() === want.replace(/s$/, '') || i.name.toLowerCase() === want + 's'));
    if (hit) return hit.path;
  }
  // the instant index knows every folder
  const r = await api('index:search', { query: name, kind: 'dir', limit: 60 }).catch(() => null);
  const list = Array.isArray(r) ? r : r?.items || [];
  const hit = list.filter((i) => i.isDir !== false && basename(i.path).toLowerCase() === want).sort((a, b) => a.path.length - b.path.length)[0];
  return hit?.path || null;
}

async function execute(plan, card, { t, sel }) {
  if (plan.folderName && !['here', 'selection'].includes(plan.scope) && !plan.scope?.startsWith?.('drive:')) {
    plan.resolvedFolder = await resolveNamedFolder(plan.folderName);
    if (!plan.resolvedFolder) { card.append(h('p', {}, `I couldn’t find a folder called “${plan.folderName}”. Open it in this tab and ask again with “here”.`)); return; }
  }
  const where = rootsFor(plan, t, sel);
  card.append(understoodChips(plan, [where.label ? `in ${where.label}` : '']));
  // ----- empty folders -----
  if (plan.emptyDirs) {
    const roots = plan.scope === 'selection' ? sel.filter((i) => i.isDir).map((i) => i.path) : where.roots;
    const dirs = await findEmptyDirs({ roots }, card);
    if (!dirs.length) return card.append(h('p', {}, 'There are no empty folders there.'));
    const checks = { off: new Set() };
    card.append(h('p', {}, `${dirs.length} empty folder${dirs.length === 1 ? '' : 's'}:`), fileRows(dirs, new Map(dirs.map((d) => [d, basename(dirname(d.path))])), { checks, limit: 300 }));
    const acts = h('div', { class: 'as-acts' }); card.append(acts);
    if (plan.action === 'delete') acts.append(btn('Move to Recycle Bin…', async (e) => { const go = dirs.filter((d) => !checks.off.has(d)); if (!(await confirm(`Recycle ${go.length} empty folder${go.length === 1 ? '' : 's'}?`, 'They have nothing in them. You can restore them from the Recycle Bin.', { ok: 'Recycle', danger: true }))) return; e.target.disabled = true; const j = await A.runJob({ type: 'trash', sources: go.map((d) => d.path) }); card.append(h('p', { class: 'as-done' }, j.status === 'done' ? `Done. Recycled ${go.length}. Ctrl+Z restores them.` : `Finished with problems: ${j.errors?.[0] || ''}`)); }, 'primary danger'));
    acts.append(btn('Show all in a tab', () => showInTab(dirs, plan.raw)));
    C.items = dirs; C.plan = plan;
    return;
  }
  // ----- group / organize -----
  if (plan.action === 'group') {
    let folder, files;
    if (plan.scope === 'selection') { files = sel.filter((i) => !i.isDir); folder = dirname(files[0]?.path || ''); }
    else { folder = where.roots[0]; const r = await api('fs:list', folder); files = (r.items || []).filter((i) => !i.isDir && !i.hidden); }
    if (plan.exts.length) files = files.filter((f) => plan.exts.includes((f.ext || '').toLowerCase()));
    if (!files?.length) return card.append(h('p', {}, 'There are no loose files there to sort.'));
    // each file into a folder of its own, named after it
    if (plan.groupBy === 'own') {
      const stem = (n) => n.replace(/\.[^.]+$/, '').replace(/[. ]+$/, '') || n;
      card.append(h('p', {}, `I’d put each of the ${files.length} file${files.length === 1 ? '' : 's'} into a new folder named after it:`), h('div', { class: 'as-files' }, ...files.slice(0, 12).map((f) => h('div', { class: 'as-file rn' }, h('div', { class: 'as-fn' }, h('span', { class: 'hint' }, f.name), h('b', {}, `→ ${stem(f.name)}\\${f.name}`))))));
      card.append(h('div', { class: 'as-acts' }, btn('Do it', async (e) => {
        e.target.disabled = true;
        const pairs = [];
        for (const f of files) { const d = await api('fs:uniqueName', dirname(f.path), stem(f.name), 'number'); await api('fs:mkdir', d); pairs.push([f.path, d]); }
        let ok = 0; for (const [src, d] of pairs) { const j = await A.runJob({ type: 'move', sources: [src], dest: d, opts: { conflict: 'keepBoth' } }); if (j.status === 'done') ok++; }
        card.append(h('p', { class: 'as-done' }, `Done. ${ok} file${ok === 1 ? '' : 's'} now in folders of their own.`));
        bus.emit('refreshPanes');
      }, 'primary')));
      return;
    }
    const r = await api('fs:list', folder);
    const existing = (r.items || []).filter((i) => i.isDir).map((i) => i.name);
    const plan2 = planRules([{ conditions: [], action: { type: plan.groupBy } }], files, { existingDirs: existing, folderName: basename(folder) });
    if (!plan2.length) return card.append(h('p', {}, 'I couldn’t find a sensible way to group these. Try “by type” or “by month”.'));
    const dests = new Map(); for (const p of plan2) dests.set(p.dest, (dests.get(p.dest) || 0) + 1);
    card.append(h('p', {}, `I’d sort ${plan2.length} file${plan2.length === 1 ? '' : 's'} into ${dests.size} folder${dests.size === 1 ? '' : 's'} in “${basename(folder)}”:`),
      h('div', { class: 'as-groups' }, ...[...dests.entries()].map(([d, c]) => h('span', { class: 'as-chip' }, `${d} · ${c}`))));
    const only = plan.scope === 'selection' || plan.exts.length ? files : null;
    card.append(h('div', { class: 'as-acts' },
      btn('Review & apply…', async () => { const { runNowDialog } = await import('./rules.js'); await runNowDialog({ folder, rules: [{ conditions: [], action: { type: plan.groupBy } }] }, { only }); }, 'primary'),
      btn('Make it automatic', async () => { const { automationDialog } = await import('./rules.js'); automationDialog(folder, { preset: plan.groupBy }); })));
    return;
  }
  // ----- rename -----
  if (plan.action === 'rename') {
    const items = plan.scope === 'selection' ? sel.filter((i) => !i.isDir) : (await findFiles({ ...plan, topic: [] }, where, card)).items.slice(0, 2000);
    if (!items.length) return card.append(h('p', {}, plan.scope === 'selection' || !hasTarget(plan) ? 'Select the files you want to rename first, then ask again.' : `I didn’t find any ${describePlan(plan)} to rename${where.label ? ` in ${where.label}` : ''}.`));
    if (plan.renameMode === 'describe') {
      const { interpretRename } = await import('./rename-words.js');
      const r = interpretRename(plan.renameText || plan.raw);
      if (plan.newExt && !r.newExt) r.newExt = plan.newExt;
      if (r.newExt && !r.notes.some((x) => /extension/.test(x))) r.notes.push(`extension .${r.newExt}`);
      card.append(h('p', {}, r.notes.length ? `Opening Rename Studio for ${items.length} file${items.length === 1 ? '' : 's'} with: ${r.notes.join(', ')}. Check the preview, then press Rename.` : 'Opening Rename Studio so you can describe the new names.'));
      const { renameStudio } = await import('./renamestudio.js');
      const { notes, ...init } = r;
      renameStudio(items, { ...init, spaces: r.spaces ? '_' : '' });
      return;
    }
    const status = h('div', { class: 'as-status' }, h('span', { class: 'as-spin' }), 'Reading the files…');
    card.append(status);
    const newNames = new Map();
    const docs = items.filter((i) => !KINDS.image.includes(i.ext) && !KINDS.audio.includes(i.ext) && !KINDS.video.includes(i.ext));
    const titles = docs.length ? await api('doc:titles', docs.map((d) => d.path)) : [];
    docs.forEach((d, i) => { if (titles[i]) newNames.set(d, titles[i]); });
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
    card.append(h('p', {}, 'Duplicates are checked by content (a hash of each file) in Storage cleanup. It keeps the newest copy in each group ticked off and shows how much space you’d get back.'), h('div', { class: 'as-acts' }, btn('Open Storage cleanup', () => import('./cleanup.js').then((m) => m.openCleanup(where.roots.length === 1 ? where.roots[0] : undefined)), 'primary'), btn('Duplicate finder…', () => window.__atlas?.commands.get('dupes')?.run())));
    return;
  }
  // pictures described by what's in them ("a dog on grass"): the AI picture search
  if (plan.action === 'find' && plan.topic.length && plan.kinds.some((k) => ['image', 'video'].includes(k)) && !hasMeta(plan) && !plan.color && /\b(?:pictures?|photos?|images?|pics?|videos?|clips?|shots?)\s+(?:of|showing|that show|with)\b/i.test(plan.raw)) {
    card.append(h('p', {}, `Searching inside the pictures for “${plan.topic.join(' ')}” (runs on this PC).`));
    const q = plan.raw.replace(/^\s*(?:find|show(?: me)?|search(?: for)?|look for|get)\s+(?:all\s+|my\s+|the\s+|some\s+)?/i, '');
    navigate(activeTab(), `atlas:search?q=${encodeURIComponent(q)}&ai=1${where.roots.length === 1 ? `&root=${encodeURIComponent(where.roots[0])}` : ''}`);
    return;
  }
  const isSelOnly = plan.scope === 'selection' && !where.roots.length && ['move', 'copy', 'delete', 'zip', 'tag', 'open', 'shelf'].includes(plan.action);
  const { items, why } = isSelOnly ? { items: sel.filter((i) => !i.isDir).concat(sel.filter((i) => i.isDir)), why: new Map() } : await findFiles(plan, where, card);
  const total = items.reduce((a, f) => a + (f.size || 0), 0);
  if (items.length) { C.items = items; C.plan = plan; }
  if (!items.length) {
    const tips = [];
    if (plan.topic.length && plan.kinds.some((k) => ['image', 'video', 'audio'].includes(k))) tips.push(btn('Search inside the pictures with AI', () => { const q = encodeURIComponent(plan.raw); navigate(activeTab(), `atlas:search?q=${q}&ai=1`); }, 'primary'));
    if (plan.after || plan.before || plan.createdAfter) tips.push(h('span', { class: 'hint' }, 'Tip: try without the date.'));
    if (plan.cameras || plan.gps) tips.push(h('span', { class: 'hint' }, 'Only photos whose files say which camera took them / where can match.'));
    card.append(h('p', {}, 'I didn’t find anything that matches.'), h('div', { class: 'as-acts' }, ...tips));
    return;
  }
  // colour, kind and tempo filters live in the gallery: show the results there with the filter on
  if (plan.color) {
    card.append(h('p', {}, `${items.length.toLocaleString()} picture${items.length === 1 ? '' : 's'} to check. Opening them in the gallery with the “mostly ${plan.color}” filter — the colours are read as the thumbnails appear.`));
    showInTab(items, plan.raw, { view: 'gallery', mf: { color: plan.color } });
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
  const checks = ['move', 'copy', 'delete', 'zip', 'tag', 'shelf'].includes(plan.action) ? { off: new Set() } : null;
  card.append(h('p', {}, `${plan.latest ? 'Newest version' + (items.length > 1 ? 's' : '') : plan.top ? `The ${items.length} ${{ size: 'largest', sizeAsc: 'smallest', newest: 'newest', oldest: 'oldest' }[plan.sortBy] || ''}` : 'Found'}: ${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'} · ${fmtSize(total)}`), fileRows(items, why, { checks, limit: checks ? 200 : plan.top ? Math.min(plan.top, 100) : 40 }));
  const chosen = () => items.filter((f) => !checks?.off.has(f));
  const acts = h('div', { class: 'as-acts' });
  card.append(acts);
  const done = (text) => card.append(h('p', { class: 'as-done' }, text));
  if (plan.action === 'find' || plan.action === 'open') {
    acts.append(btn('Show all in a tab', () => showInTab(items, plan.raw), 'primary'));
    if (plan.action === 'open' || items.length === 1) acts.append(btn(items.length === 1 ? 'Open it' : `Open ${Math.min(items.length, 10)}`, () => A.openItems(items.slice(0, 10).map((f) => ({ ...f, isDir: false })))));
    if (items.length === 1) acts.append(btn('Show in folder', () => navigate(activeTab(), dirname(items[0].path), { select: items[0].path })));
    if (plan.oldVersions) acts.append(btn('Move these to the Recycle Bin…', async (e) => { if (!(await confirm(`Recycle ${items.length} older version${items.length === 1 ? '' : 's'}?`, 'The newest copy of each document stays. You can restore them from the Recycle Bin.', { ok: 'Recycle', danger: true }))) return; e.target.disabled = true; const j = await A.runJob({ type: 'trash', sources: items.map((f) => f.path) }); done(j.status === 'done' ? `Done. Ctrl+Z restores them.` : `Finished with problems: ${j.errors?.[0] || ''}`); }, 'danger'));
    acts.append(h('span', { class: 'hint' }, 'Then you can say “move them to…”, “zip them”, “only the PDFs”…'));
    return;
  }
  if (plan.action === 'shelf') {
    acts.append(btn(`Put ${items.length} on the Drop Shelf`, () => { bus.emit('addToShelf', chosen().map((f) => f.path)); done(`Added ${chosen().length} to the Drop Shelf (Ctrl+Shift+J shows it). Drag them out together, or right-click the shelf to move them all.`); }, 'primary'));
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
    }, 'primary danger'), h('span', { class: 'hint' }, 'Untick anything you want to keep.'));
    return;
  }
  if (plan.action === 'zip') {
    acts.append(btn(plan.zipName ? `Zip into ${plan.zipName}` : 'Zip them', async (e) => {
      e.target.disabled = true;
      const go = chosen();
      if (plan.zipName) {
        const dir = dirname(go[0].path);
        const fmt = /\.7z$/i.test(plan.zipName) ? '7z' : /\.(tar\.gz|tgz)$/i.test(plan.zipName) ? 'tar.gz' : /\.tar$/i.test(plan.zipName) ? 'tar' : 'zip';
        const dest = await api('fs:uniqueName', dir, plan.zipName, 'number');
        const j = await A.runJob({ type: 'compress', sources: go.map((f) => f.path), dest: dir, opts: { output: dest, format: fmt } });
        done(j.status === 'done' ? `Zipped into ${basename(dest)}.` : `Couldn’t zip: ${j.errors?.[0] || j.error || ''}`);
      } else { await A.quickZip(go.map((f) => ({ ...f, isDir: !!f.isDir }))); done('Zipped.'); }
    }, 'primary'));
    return;
  }
  if (plan.action === 'tag') {
    const defs = (plan.tags?.length ? plan.tags : [plan.tag]).map((w) => state.tags.defs.find((d) => d.id === w || d.name.toLowerCase() === String(w).toLowerCase())).filter(Boolean);
    if (!defs.length) defs.push(state.tags.defs[0]);
    acts.append(btn(`Tag ${defs.map((d) => d.name).join(' and ')}`, () => { const ps = chosen().map((f) => f.path); for (const d of defs) setTags(ps, d.id, true); done(`Tagged ${ps.length} ${defs.map((d) => d.name).join(' and ')}.`); }, 'primary'));
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
const hasTarget = (p) => !!(p.kinds.length || p.topic.length || p.exts.length || p.quoted.length || (p.scope && p.scope !== 'selection') || p.after || p.before || p.createdAfter || p.minSize || p.maxSize || p.notOpenedBefore || p.duplicates || p.latest || p.oldVersions || p.emptyDirs || p.regex || p.folderName || p.top || hasMeta(p) || p.color);

function ask(text) { return askAssistant(text); }
export const resolveNamedFolderPublic = (name) => resolveNamedFolder(name);
// an action the assistant recognised (settings, tools, history, archives…): see assistant-actions.js
async function runIntent(intent, text) {
  const card = startCard(text);
  const { HANDLERS } = await import('./assistant-actions.js');
  const fn = HANDLERS[intent.id];
  if (!fn) { card.append(h('p', {}, 'I know what you mean, but I can’t do that yet.')); return; }
  const say = (p) => { card.append(h('p', {}, p)); scrollDown(); };
  const acts = (...b) => { const els = b.filter(Boolean); if (els.length) card.append(h('div', { class: 'as-acts' }, ...els)); scrollDown(); };
  setBusy(true);
  try { await fn(intent, { say, acts, text, ctx: { card }, showInTab }); }
  catch (e) { card.append(h('div', { class: 'as-err' }, `Something went wrong: ${e.message}`)); }
  finally { setBusy(false); scrollDown(); }
}
// which built-in app works on a file
const appForFile = (f) => { const e = (f.ext || '').toLowerCase(); return KINDS.image.includes(e) ? 'viewer' : KINDS.video.includes(e) || KINDS.audio.includes(e) || ['mkv', 'm2ts', 'mts', 'vob'].includes(e) ? 'player' : TEXT_EXTS.has(e) || !e ? 'editor' : null; };
const NOT_IN_APP = /^\s*(?:please\s+)?(?:find|show(?: me)?|search|list|where|look for|count how many|how many (?:files|pictures|photos|songs|videos))\b/i;
// "write a short email…" with nothing open: a new Notepad document to write it in
const WRITE_NEW = /\b(email|e-mail|letter|message|note|memo|poem|story|post|tweet|paragraph|essay|reply|cover letter|bio|description|speech|toast|list of|outline|summary|report|invitation|apology|thank-you|thank you)\b/i;

export async function askAssistant(text) {
  if (busy) stopNow();
  const intent = matchIntent(text);
  // a built-in app in this tab (Notepad, Photos, Player): the request is about it, unless it's clearly about files
  const appT = activeAppTab();
  if (appT && APP_NAME[appT.app]) {
    if (intent && (OVER_APPS.has(intent.id) || (intent.id === 'contactSheet' && appT.app === 'player'))) return runIntent(intent, text);
    if (await askApp(appT, text)) return;
  }
  const t = activeTab();
  const sel = selectedItems(t).filter((i) => !i.virtual);
  // small talk
  if (/^\s*(hi|hello|hey|yo|thanks|thank you|thx|cheers|good (morning|evening|afternoon))\b[\s!.]*$/i.test(text)) {
    const card = startCard(text);
    card.append(h('p', {}, /thank|thx|cheers/i.test(text) ? 'You’re welcome!' : 'Hi! Ask me to find or tidy files, or how to do something in Dogfile.'));
    return;
  }
  if (/^\s*(?:what (?:can|do) you (?:do|help with)|what are you(?: for)?|help|what can i ask(?: you)?|show me what you can do)\s*\??\s*$/i.test(text)) { showAbilities(startCard(text)); return; }
  if (intent && intent.id !== 'help') return runIntent(intent, text);
  // something for Notepad / Photos / the Player about the one selected file: open it there and do it
  if (!intent && sel.length === 1 && !sel[0].isDir && !NOT_IN_APP.test(text)) {
    const app = appForFile(sel[0]);
    const { steps, rest } = app ? parseAppRequest(app, text) : { steps: [], rest: [] };
    if (app && steps.length && !rest.length && !steps.every((x) => ['find', 'open', 'new', 'save', 'saveAs', 'info', 'list'].includes(x.op))) {
      const { openInApp } = await import('./assistant-actions.js');
      const card = startCard(text);
      card.append(h('p', { class: 'hint' }, `Opening ${sel[0].name} in ${APP_NAME[app]}…`));
      const tab = await openInApp(app, sel[0].path);
      if (!tab) { card.append(h('p', {}, `I couldn’t open ${sel[0].name} in ${APP_NAME[app]}.`)); return; }
      const wrap = card.parentElement; wrap?.previousElementSibling?.remove(); wrap?.remove();
      await askApp(tab, text);
      return;
    }
  }
  // "write a thank-you email…" with nothing open: write it in a new Notepad document
  if (!intent && writingRequest(text)?.mode === 'insert' && WRITE_NEW.test(text) && !/\b(files?|folders?)\b/i.test(text)) {
    const { openInApp } = await import('./assistant-actions.js');
    const { openTool } = await import('./apptabs.js');
    openTool('editor', [], { inTab: true });
    let tab = null;
    for (let i = 0; i < 40 && !(tab = activeAppTab()?.app === 'editor' ? activeAppTab() : null); i++) await new Promise((r) => setTimeout(r, 150));
    if (tab) { await new Promise((r) => setTimeout(r, 600)); await writeInNotepad(tab, text, { mode: 'insert', autoInsert: true }); return; }
    void openInApp;
  }
  // questions about Dogfile itself
  if (intent?.id === 'help' || (HELP_Q.test(text) && !FILE_Q.test(text))) {
    const plan = parseRequest(text, { hasSelection: false });
    const fileish = hasTarget(plan) || /\b(my|downloaded|saved|files?|folders?|photos?|pictures?|songs?|videos?|documents?)\b/i.test(text);
    const appish = /\b(dogfile|feature|setting|settings|button|menu|ribbon|sidebar|tab|pane|mean|means|do i|can i|how to|how do|shortcut|key|dialog|default|retry|queue)\b/i.test(text);
    if (intent?.id === 'help' || !fileish || appish) { answerHelp(text, await helpSearch(text), startCard(text)); return; }
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
  if (C.items && !sel.length && plan.action !== 'find' && (!hasTarget(plan) || (FOLLOW.test(text) && !plan.emptyDirs && !plan.kinds.length && !plan.exts.length && !(plan.scope && plan.scope !== 'selection')))) {
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

// ---------------- the app in this tab ----------------
const FILE_TALK = /\b(files?|folders?|downloads|documents folder|desktop|pdfs?|photos (?:from|in|about)|videos (?:from|in)|organi[sz]e my|rename these|zip|move (?:these|them|my)|delete (?:these|them|my files))\b/i;
async function askApp(t, text) {
  const app = t.app;
  const { steps, rest } = parseAppRequest(app, text);
  if (!steps.length) {
    if (app === 'editor' && writingRequest(text)) { await writeInNotepad(t, text, writingRequest(text)); return true; }
    if (FILE_TALK.test(text)) return false;
    // not understood: in Notepad anything else is a writing request; elsewhere say what works
    if (app === 'editor' && !HELP_Q.test(text)) { await writeInNotepad(t, text, { mode: 'insert' }); return true; }
    if (HELP_Q.test(text)) return false;
    const card = startCard(text);
    card.append(h('p', {}, `I didn’t catch what to do in ${APP_NAME[app]}. Try one of these:`), h('div', { class: 'as-sugg' }, ...APP_SUGGEST[app].map((x) => h('button', { class: 'chip', onclick: () => ask(x) }, x))));
    return true;
  }
  const card = startCard(text);
  const list = h('ul', { class: 'as-steps' });
  card.append(list);
  setBusy(true);
  let done = 0;
  try {
    for (const st of steps) {
      if (busy?.stop) break;
      const arg = st.arg && typeof st.arg === 'object' ? Object.fromEntries(Object.entries(st.arg).filter(([k]) => k !== 'relative')) : st.arg;
      if (st.op === 'contactSheet') { const { HANDLERS } = await import('./assistant-actions.js'); await HANDLERS.contactSheet({}, { say: (p) => list.append(h('li', { class: 'ok' }, h('span', { class: 'as-step-ic', html: icon('check') }), h('span', {}, p))), acts: () => {}, text, ctx: { card } }); done++; continue; }
      let r = await appAsk(st.op, arg, t);
      if (r?.ok !== false && st.apply) r = { ...(await appAsk('apply', null, t)), msg: r?.msg };
      const ok = r?.ok !== false;
      if (ok) done++;
      if (st.quiet && ok) continue;
      list.append(h('li', { class: ok ? 'ok' : 'bad' }, h('span', { class: 'as-step-ic', html: icon(ok ? 'check' : 'close') }), h('span', {}, r?.msg || st.label + (ok ? '' : ' — couldn’t do that'))));
      scrollDown();
      if (!ok) break;
    }
    if (rest.length) card.append(h('p', { class: 'hint' }, `I skipped “${rest.join('”, “')}” — I didn’t understand that part.`));
    const undoable = steps.filter((x) => !NO_UNDO.has(x.op)).length;
    if (done && undoable && app !== 'player') card.append(h('div', { class: 'as-acts' }, h('button', { class: 'btn small', onclick: async (e) => { e.currentTarget.disabled = true; for (let i = 0; i < undoable; i++) await appAsk('undo', null, t); toast('Undone'); } }, 'Undo')));
  } finally { setBusy(false); scrollDown(); }
  return true;
}
const NO_UNDO = new Set(['contactSheet', 'trim', 'ab', 'abOff', 'subDelay', 'compareWith', 'count', 'find', 'goto', 'top', 'bottom', 'copy', 'save', 'saveAs', 'saveCopy', 'overwrite', 'info', 'next', 'prev', 'ocr', 'stats', 'apply', 'applyCrop', 'cropAspect', 'zoomIn', 'zoomOut', 'fit', 'wrap', 'whitespace', 'preview', 'zoom', 'fontSize', 'lang', 'eol', 'encoding', 'readonly', 'hash', 'new', 'open', 'selectAll', 'drawMode', 'drawColor', 'format', 'edit', 'exitEdit', 'slideshow', 'fullscreen', 'extract', 'undo', 'redo', 'bookmark', 'fold', 'lineNumbers', 'tabSize', 'close', 'delete']);
// small models like to say "Sure, here is the corrected text:" and wrap the answer in quotes: keep just the text
function cleanWriting(t) {
  let s = String(t || '').replace(/^```\w*\n?|\n?```$/g, '').replace(/^<<<\n?|\n?>>>$/g, '').trim();
  s = s.replace(/^(?:sure|certainly|of course|okay|ok|here(?:'s| is| are)|absolutely)[^\n]{0,120}:\s*\n+/i, '').trim();
  if (/^["“].*["”]$/s.test(s) && !/["“”]/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
}
// writing with the local model: summaries and answers show here; new text goes into the document
async function writeInNotepad(t, text, { mode, autoInsert = false }) {
  const card = startCard(text);
  const ctx = await appAsk('context', null, t);
  if (ctx?.ok === false) { card.append(h('p', {}, ctx.msg)); return; }
  const target = ctx.selection || (mode === 'insert' ? '' : ctx.text);
  if ((mode === 'replace' || mode === 'answer') && !target.trim()) { card.append(h('p', {}, 'The document is empty — write or paste something first, or ask me to write something new.')); return; }
  const sys = 'You are a writing assistant inside a text editor. Reply with only the requested text: no preamble, no explanations, no quotes around it, no markdown code fences unless the document is code. Keep the language of the document unless asked to translate.';
  const fence = (x) => `<<<\n${x}\n>>>`;
  const user = mode === 'insert' ? (ctx.text.trim() ? `Document so far, for context:\n${fence(ctx.text.slice(-3000))}\n\nTask: ${text}` : text)
    : mode === 'end' ? `Continue this text naturally:\n${fence(ctx.text.slice(-4000))}\n\n${text}`
    : `${text}\n\nText:\n${fence(target.slice(0, 8000))}`;
  const out = h('div', { class: 'as-write' });
  const status = h('p', { class: 'hint' }, 'Writing… (runs on this PC; the first time takes a moment to load)');
  card.append(status, out);
  setBusy(true);
  const ai = await import('./ai.js');
  (busy.onStop ||= []).push(() => ai.stopAI());
  let res = null;
  try { res = await ai.write([{ role: 'system', content: sys }, { role: 'user', content: user }], { onPartial: (p) => { out.textContent = p; scrollDown(); }, maxTokens: mode === 'answer' ? 300 : 700 }); }
  catch (e) { status.textContent = /Stopped/.test(e.message) ? 'Stopped.' : `Couldn’t write that: ${e.message}`; setBusy(false); return; }
  setBusy(false);
  if (res == null) { status.textContent = 'The writing helper needs its one-time download to work.'; return; }
  res = cleanWriting(res);
  out.textContent = res;
  status.textContent = mode === 'answer' ? '' : 'Ready:';
  const put = (m, label, primary) => h('button', { class: 'btn small' + (primary ? ' primary' : ''), onclick: async () => { const r = await appAsk('write', { text: res, mode: m }, t); toast(r?.ok === false ? r.msg : 'Done'); } }, label);
  const acts = h('div', { class: 'as-acts' });
  if (autoInsert) { const r = await appAsk('write', { text: res, mode: 'cursor' }, t); status.textContent = r?.ok === false ? r.msg : 'Written into a new Notepad document:'; acts.append(h('button', { class: 'btn small', onclick: () => api('clip:writeText', res).then(() => toast('Copied')) }, 'Copy')); card.append(acts); scrollDown(); return; }
  if (mode === 'replace') acts.append(put(ctx.selection ? 'replaceSel' : 'replaceAll', ctx.selection ? 'Replace the selection' : 'Replace the document', true), put('cursor', 'Insert at the cursor'));
  else if (mode === 'end') acts.append(put('end', 'Add to the end', true));
  else if (mode === 'answer') acts.append(put('end', 'Add to the document'), put('cursor', 'Insert at the cursor'));
  else acts.append(put('cursor', 'Insert at the cursor', true), put('end', 'Add to the end'), ctx.selection ? put('replaceSel', 'Replace the selection') : '');
  acts.append(h('button', { class: 'btn small', onclick: () => api('clip:writeText', res).then(() => toast('Copied')) }, 'Copy'));
  card.append(acts); scrollDown();
}

// ---------------- what the assistant can do, with examples to try ----------------
const ABILITIES = [
  ['Find', ['PDFs about taxes from last year', 'Photos taken with my iPhone that have GPS location data', 'Songs around 120 BPM in G minor or compatible keys', 'Videos longer than 20 minutes encoded in HEVC', 'Search inside .json files for the key apiKey']],
  ['Space & cleanup', ['What are the top 20 largest files on my D: drive?', 'Break down the storage in this folder by type and age', 'Find all empty folders here and delete them', 'Empty my Recycle Bin']],
  ['Move, sort & rename', ['Move all screenshots from Downloads to Pictures\\Screens', 'Move all PDFs here into folders by year', 'Rename these photos by date taken as YYYY-MM-DD_HH-mm', 'Number these files as Project_Asset_001']],
  ['Tags, notes, versions', ['Tag the selected files red and blue', 'Give these a 5-star rating', 'Save a version of this file before I edit it', 'Undo the rename I did 20 minutes ago']],
  ['Dogfile itself', ['Switch to dark mode', 'Show hidden files and file extensions', 'Four panes with synced browsing', 'Turn on the glass sidebar', 'Save my tabs as a workspace called Tax Prep']],
  ['Tools', ['Open the terminal here', 'Which files in this Git repository have uncommitted changes?', 'Convert all .flac files here to 320kbps MP3', 'Record a macro that runs every Friday at 5 PM']],
];
function showAbilities(card) {
  card.append(h('p', {}, 'I can find files in plain words, then move, copy, zip, tag, rename or recycle them; answer “how do I…” questions; and change Dogfile for you. In Notepad, Photos and the Player I edit the open file. Some things to try:'));
  for (const [title, list] of ABILITIES) card.append(h('div', { class: 'as-help' }, h('b', {}, title), h('div', { class: 'as-sugg' }, ...list.map((x) => h('button', { class: 'chip', onclick: () => ask(x) }, x)))));
  scrollDown();
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
