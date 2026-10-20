// Storage cleanup center: one scan shows where the space went (by folder, type and age) and collects everything
// that is usually safe to remove: exact duplicates (hash-checked), near-duplicate photos, versions of the same
// document, installers that were already run, temporary files, empty folders, large files nobody touched for a
// year, and the Recycle Bin. Every list shows how much space it frees; nothing is removed until the review step.
import { api, state, sys, bus, h, esc, toast, fmtSize, fmtDate, basename, dirname, IS_WIN, extname } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate } from './pane.js';
import * as A from './actions.js';
import { onWorkMsgFor, similarImageGroups } from './tools.js';
import { renderPreview } from './preview.js';

const CATS = [
  ['overview', 'Overview', 'chart'],
  ['dupes', 'Exact duplicates', 'dupes', 'Files with identical contents (checked with a hash). One copy of each is kept.'],
  ['photos', 'Similar photos', 'photos', 'The same picture saved more than once at different sizes or qualities. The largest copy is kept.'],
  ['docs', 'Document versions', 'page', 'Copies and versions of the same document (“report (1).docx”, “report final v2.docx”). The newest is kept.'],
  ['installers', 'Old installers', 'exe', 'Setup files in Downloads that are older than two weeks. Programs stay installed if you remove these.'],
  ['temp', 'Temporary files', 'clock', 'Files in the temporary folder and leftovers like .tmp, unfinished downloads and Office lock files.'],
  ['empty', 'Empty folders', 'folder', 'Folders with nothing inside (or only other empty folders).'],
  ['largeOld', 'Large & old', 'drive', 'Files over 500 MB that haven’t changed for a year. Check these before removing them.'],
  ['big', 'Biggest files', 'chart', 'The largest files, to help you decide. Nothing is selected for you here.'],
  ['recycle', 'Recycle Bin', 'recycle', 'Files you already deleted. Emptying the Recycle Bin frees their space for good.'],
];
// "report (1).docx", "Report - Copy.docx", "report_final_v2.docx" -> "report|doc"
export function docKey(name) {
  const e = extname(name);
  const fam = /^(docx?|odt|rtf|pages)$/.test(e) ? 'doc' : /^(xlsx?|ods|csv|numbers)$/.test(e) ? 'sheet' : /^(pptx?|odp|key)$/.test(e) ? 'slides' : e;
  let s = name.replace(/\.[^.]+$/, '').toLowerCase();
  s = s.replace(/\s*-\s*copy(\s*\(\d+\))?$/g, '').replace(/\bcopy( of)?\b/g, '').replace(/\(\d+\)/g, '').replace(/\[\d+\]/g, '')
    .replace(/\b(final|draft|edited|edit|new|old|latest|updated|revised|rev\s?\d*|v\s?\d+(\.\d+)*|version\s?\d*|\d{4}[-_.]\d{2}[-_.]\d{2}|\d{8})\b/g, '')
    .replace(/[_\-.]+/g, ' ').replace(/\s+\d{1,2}$/, '').replace(/\s+/g, ' ').trim();
  return s.length >= 3 ? `${s}|${fam}` : null;
}

export async function openCleanup(initialRoot) {
  const k = sys.known || {};
  const S = { root: initialRoot || null, data: null, groups: {}, checked: new Map(), cat: 'overview', scanning: false, recycle: [] };
  const nav = h('div', { class: 'cl-nav' });
  const main = h('div', { class: 'cl-main' });
  const pv = h('div', { class: 'cl-pv' });
  const status = h('div', { class: 'hint cl-status' }, 'Choose where to look and press Scan.');
  const scope = h('select', { class: 'input sm' });
  const personal = [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music].filter(Boolean);
  const scopes = [['personal', 'My personal folders', personal], ...(state.drives || []).filter((d) => ['fixed', 'removable', 'local'].includes(d.type) || !d.type).map((d) => [d.path, `Drive ${d.name || d.path}`, [d.path]])];
  const cur = activeTab()?.path;
  if (cur && !cur.startsWith('atlas:')) scopes.push(['here', `This folder (${basename(cur) || cur})`, [cur]]);
  scopes.push(['choose', 'Choose a folder…', null]);
  for (const [v, l] of scopes) scope.append(h('option', { value: v }, l));
  if (initialRoot) { scopes.unshift(['init', basename(initialRoot) || initialRoot, [initialRoot]]); scope.prepend(h('option', { value: 'init' }, basename(initialRoot) || initialRoot)); scope.value = 'init'; }
  const scanBtn = h('button', { class: 'btn small primary with-ic', html: icon('search') + '<span>Scan</span>' });
  const cleanBtn = h('button', { class: 'btn primary', disabled: true }, 'Review cleanup');
  let jobs = [];
  const sizeOf = (cat) => [...(S.checked.get(cat) || [])].reduce((a, it) => a + (it.size || 0), 0);
  const countOf = (cat) => (S.checked.get(cat) || new Set()).size;
  const allChecked = () => CATS.slice(1).reduce((a, [c]) => a + sizeOf(c), 0);
  const updFoot = () => { const n = CATS.slice(1).reduce((a, [c]) => a + countOf(c), 0); cleanBtn.disabled = !n; cleanBtn.textContent = n ? `Review cleanup · ${n.toLocaleString()} item${n === 1 ? '' : 's'} · ${fmtSize(allChecked())}` : 'Review cleanup'; drawNav(); };
  const drawNav = () => {
    nav.innerHTML = '';
    for (const [c, l, ic] of CATS) {
      const items = S.groups[c];
      const badge = c === 'overview' ? '' : items == null ? (S.scanning ? '…' : '') : sizeOf(c) ? fmtSize(sizeOf(c)) : items.length ? `${items.length}` : '0';
      const b = h('button', { class: 'cl-cat' + (S.cat === c ? ' on' : '') + (items && !items.length ? ' none' : '') }, h('span', { html: icon(ic) }), h('span', { class: 'cl-cl' }, l), h('b', {}, badge));
      b.onclick = () => { S.cat = c; drawNav(); drawMain(); };
      nav.append(b);
    }
  };
  const bars = (title, rows, total, onClick) => h('div', { class: 'cl-card' }, h('h4', {}, title), ...rows.map((r) => {
    const el = h('div', { class: 'cl-bar' + (onClick ? ' click' : ''), title: r.path || r.name }, h('span', { class: 'cl-bn' }, r.name), h('span', { class: 'cl-bt' }, h('i', { style: { width: `${total ? Math.max(1, (r.size / total) * 100) : 0}%` } })), h('span', { class: 'cl-bs' }, fmtSize(r.size)));
    if (onClick) el.onclick = () => onClick(r);
    return el;
  }));
  const drawOverview = () => {
    if (!S.data) { main.append(h('div', { class: 'cl-empty' }, h('div', { html: icon('broom') }), h('b', {}, 'Find out what’s using your space'), h('p', { class: 'hint' }, 'Scan to see your storage by folder, type and age, and to find duplicates, old installers, temporary files and more. Nothing is deleted until you review and confirm.'))); return; }
    const d = S.data;
    const cards = h('div', { class: 'cl-sum' });
    for (const [c, l, ic] of CATS.slice(1)) {
      const items = S.groups[c] || [];
      const sz = c === 'big' ? items.reduce((a, i) => a + i.size, 0) : sizeOf(c);
      const card = h('button', { class: 'cl-tile' + (sz ? '' : ' dim') }, h('span', { html: icon(ic) }), h('span', {}, l), h('b', {}, S.groups[c] == null ? '…' : c === 'big' ? (items.length ? `${items.length} files` : 'None') : sz ? fmtSize(sz) : items.length ? `${items.length} items` : 'Nothing'));
      card.onclick = () => { S.cat = c; drawNav(); drawMain(); };
      cards.append(card);
    }
    const max = (o) => Math.max(...o.map((r) => r.size), 1);
    const types = Object.entries(d.byType).map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size);
    const ages = Object.entries(d.byAge).map(([name, size]) => ({ name, size }));
    main.append(h('div', { class: 'cl-head' }, h('h3', {}, `${fmtSize(d.total)} in ${d.files.toLocaleString()} files`), h('span', { class: 'hint' }, `Up to ${fmtSize(allChecked())} can be freed with what’s selected. Pick a category on the left to review it.`)),
      cards,
      h('div', { class: 'cl-grid' },
        bars('By folder', d.byFolder.slice(0, 12), max(d.byFolder), (r) => { if (r.path && !r.path.startsWith('(')) import('./tools.js').then((m) => m.analyzeSpace(r.path)); }),
        bars('By type', types, max(types)),
        bars('By age (last changed)', ages, max(ages))));
  };
  const row = (cat, it, { keep } = {}) => {
    const set = S.checked.get(cat) || new Set();
    const c = h('input', { type: 'checkbox' }); c.checked = set.has(it);
    c.onchange = () => { c.checked ? set.add(it) : set.delete(it); S.checked.set(cat, set); updFoot(); main.querySelector('.cl-sel')?.replaceChildren(selText(cat)); };
    const r = h('label', { class: 'cl-row' + (keep ? ' keep' : '') }, c, h('span', { class: 'cl-ic', html: icon(it.isDir ? 'folder' : 'page') }), h('span', { class: 'cl-n', title: it.path }, it.name, h('small', {}, dirname(it.path) || '')), h('span', { class: 'cl-why' }, keep ? 'kept' : it.why || ''), h('span', { class: 'cl-d' }, it.mtime ? fmtDate(it.mtime) : ''), h('span', { class: 'cl-s' }, it.isDir ? '' : fmtSize(it.size || 0)));
    r.addEventListener('mouseenter', () => { if (!it.isDir) showPv(it); });
    r.addEventListener('dblclick', (e) => { e.preventDefault(); closeAll(); navigate(activeTab(), dirname(it.path), { select: it.path }); });
    return r;
  };
  let pvTimer;
  const showPv = (it) => { clearTimeout(pvTimer); pvTimer = setTimeout(() => renderPreview(pv, { ...it, ext: it.ext ?? extname(it.name), isDir: false }), 120); };
  const selText = (cat) => `${countOf(cat).toLocaleString()} selected · ${fmtSize(sizeOf(cat))}`;
  const drawList = (cat) => {
    const def = CATS.find((x) => x[0] === cat);
    const items = S.groups[cat];
    const set = S.checked.get(cat) || new Set(); S.checked.set(cat, set);
    const flat = (S.groupsRaw?.[cat] ? S.groupsRaw[cat].flatMap((g) => g.slice(1)) : items) || [];
    main.append(h('div', { class: 'cl-head' }, h('h3', {}, def[1]), h('span', { class: 'hint' }, def[3] || ''),
      h('div', { class: 'row-inline' }, h('span', { class: 'cl-sel' }, selText(cat)), h('span', { class: 'st-spacer' }),
        cat === 'recycle' ? null : h('button', { class: 'btn small', onclick: () => { flat.forEach((x) => set.add(x)); updFoot(); drawMain(); } }, 'Select all'),
        cat === 'recycle' ? null : h('button', { class: 'btn small', onclick: () => { set.clear(); updFoot(); drawMain(); } }, 'Select none'))));
    if (items == null) { main.append(h('div', { class: 'hint pad' }, S.scanning ? 'Still looking…' : 'Scan first.')); return; }
    if (!items.length && !(S.groupsRaw?.[cat]?.length)) { main.append(h('div', { class: 'cl-empty small' }, h('div', { html: icon('check') }), h('b', {}, 'Nothing here'), h('span', { class: 'hint' }, 'Nothing to clean up in this category.'))); return; }
    const list = h('div', { class: 'cl-list' });
    if (cat === 'recycle') {
      const tot = items.reduce((a, i) => a + (i.size || 0), 0);
      const c = h('input', { type: 'checkbox' }); c.checked = set.size > 0;
      c.onchange = () => { if (c.checked) items.forEach((x) => set.add(x)); else set.clear(); updFoot(); main.querySelector('.cl-sel')?.replaceChildren(selText(cat)); };
      list.append(h('label', { class: 'cl-row big' }, c, h('span', { class: 'cl-ic', html: icon('recycle') }), h('span', { class: 'cl-n' }, `Empty the Recycle Bin (${items.length.toLocaleString()} items)`, h('small', {}, 'Everything in it, permanently')), h('span'), h('span'), h('span', { class: 'cl-s' }, fmtSize(tot))));
      for (const it of items.slice(0, 300)) list.append(h('div', { class: 'cl-row sub' }, h('span'), h('span', { class: 'cl-ic', html: icon(it.isDir ? 'folder' : 'page') }), h('span', { class: 'cl-n' }, it.name, h('small', {}, it.recycle?.from || '')), h('span'), h('span', { class: 'cl-d' }, it.recycle?.deleted ? fmtDate(it.recycle.deleted) : ''), h('span', { class: 'cl-s' }, fmtSize(it.size || 0))));
    } else if (S.groupsRaw?.[cat]) {
      for (const g of S.groupsRaw[cat].slice(0, 600)) {
        const box = h('div', { class: 'cl-group' }, h('div', { class: 'cl-gh' }, `${g.length} copies · ${fmtSize(g[0].size || 0)} each`));
        g.forEach((it, i) => box.append(row(cat, it, { keep: i === 0 && !set.has(it) })));
        list.append(box);
      }
    } else for (const it of items.slice(0, 3000)) list.append(row(cat, it));
    main.append(list);
  };
  const drawMain = () => { main.innerHTML = ''; if (S.cat === 'overview') drawOverview(); else drawList(S.cat); };
  // ---------- scanning ----------
  const finish = (cat, items, { groups, preselect = true } = {}) => {
    if (groups) { S.groupsRaw = S.groupsRaw || {}; S.groupsRaw[cat] = groups; items = groups.flatMap((g) => g.slice(1)); }
    S.groups[cat] = items;
    S.checked.set(cat, new Set(preselect ? items : []));
    updFoot(); if (S.cat === cat || S.cat === 'overview') drawMain();
  };
  const scan = async () => {
    let roots = scopes.find((s) => s[0] === scope.value)?.[2];
    if (scope.value === 'choose') { const d = await api('dialog:pickFolder', 'Clean up which folder?'); if (!d) return; roots = [d]; }
    if (!roots?.length) return;
    for (const j of jobs) api('work:cancel', j);
    jobs = []; S.data = null; S.groups = {}; S.groupsRaw = {}; S.checked = new Map(); S.scanning = true; S.cat = 'overview';
    drawNav(); drawMain();
    status.textContent = 'Scanning…';
    const started = Date.now();
    const inv = await new Promise(async (resolve) => {
      const id = await api('work:start', { type: 'inventory', roots, tempRoots: [k.temp].filter(Boolean), downloads: [k.downloads].filter(Boolean), skipDirs: ['node_modules', '.git', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin'] });
      jobs.push(id);
      onWorkMsgFor(id, (m) => { if (m.type === 'progress') status.textContent = `Scanning… ${m.files.toLocaleString()} files · ${fmtSize(m.total)} · ${m.current}`; else resolve(m.type === 'error' ? null : m); });
    });
    if (!inv) { status.textContent = 'Scan failed'; S.scanning = false; drawNav(); return; }
    S.data = inv;
    status.textContent = `${fmtSize(inv.total)} · ${inv.files.toLocaleString()} files in ${((Date.now() - started) / 1000).toFixed(1)}s. Still checking duplicates and photos…`;
    finish('installers', inv.installers); finish('temp', inv.temp); finish('empty', inv.emptyDirs); finish('largeOld', inv.largeOld, { preselect: false }); finish('big', inv.big.slice(0, 500).map((x) => ({ ...x, why: '' })), { preselect: false });
    // document versions: same name after removing "copy", "(1)", "final", "v2", dates…; keep the newest
    const byKey = new Map();
    for (const d of inv.docs) { const key = docKey(d.name); if (!key) continue; const dir = dirname(d.path); const kk = key + '|' + dir; if (!byKey.has(kk)) byKey.set(kk, []); byKey.get(kk).push(d); }
    const docGroups = [...byKey.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => b.mtime - a.mtime).map((x, i) => ({ ...x, why: i ? `older version (newest is ${g[0].name})` : '' })));
    finish('docs', null, { groups: docGroups });
    // recycle bin
    if (IS_WIN()) A.listRecycle().then((r) => { S.recycle = r; S.groups.recycle = r; S.checked.set('recycle', new Set()); updFoot(); if (S.cat === 'recycle') drawMain(); }).catch(() => { S.groups.recycle = []; });
    else S.groups.recycle = [];
    // exact duplicates
    const dupes = new Promise(async (resolve) => {
      const id = await api('work:start', { type: 'dupes', roots, minSize: 64 * 1024 });
      jobs.push(id);
      onWorkMsgFor(id, (m) => { if (m.type === 'done' || m.type === 'error') resolve(m.groups || []); });
    }).then((groups) => {
      const gs = groups.map((g) => g.files.slice().sort((a, b) => a.path.length - b.path.length || a.mtime - b.mtime).map((f, i) => ({ ...f, why: i ? `same as ${g.files[0].name === f.name ? 'the copy in ' + basename(dirname(g.files.slice().sort((a, b) => a.path.length - b.path.length)[0].path)) : g.files[0].name}` : '' })));
      finish('dupes', null, { groups: gs });
    });
    // similar photos
    let cancelledP = false;
    S.cancelPhotos = () => { cancelledP = true; };
    const photos = similarImageGroups(inv.images.slice(0, 8000), { cancelled: () => cancelledP, onProgress: (i, n) => { if (S.cat === 'photos') { const x = main.querySelector('.hint.pad'); if (x) x.textContent = `Looking at pictures… ${i.toLocaleString()} of ${n.toLocaleString()}`; } } })
      .then((groups) => finish('photos', null, { groups: groups.map((g) => g.map((x, i) => ({ ...x.f, why: i ? `${x.w}×${x.h}, smaller copy` : '' }))) }));
    await Promise.all([dupes, photos]).catch(() => {});
    S.scanning = false;
    status.textContent = `${fmtSize(inv.total)} · ${inv.files.toLocaleString()} files · done in ${((Date.now() - started) / 1000).toFixed(1)}s`;
    drawNav(); drawMain();
  };
  scanBtn.onclick = scan;
  // ---------- review ----------
  cleanBtn.onclick = async () => {
    const lines = CATS.slice(1).map(([c, l]) => [c, l, countOf(c), sizeOf(c)]).filter((x) => x[2]);
    const perm = h('input', { type: 'radio', name: 'cl-how' }), rec = h('input', { type: 'radio', name: 'cl-how', checked: true });
    const body = h('div', { class: 'stack' },
      h('div', { class: 'cl-review' }, ...lines.map(([c, l, n, sz]) => h('div', { class: 'cl-rl' }, h('span', {}, l), h('span', { class: 'hint' }, `${n.toLocaleString()} item${n === 1 ? '' : 's'}`), h('b', {}, fmtSize(sz)))), h('div', { class: 'cl-rl total' }, h('span', {}, 'Total'), h('span'), h('b', {}, fmtSize(allChecked())))),
      h('label', { class: 'check' }, rec, h('span', {}, h('b', {}, ' Move to the Recycle Bin'), h('span', { class: 'hint' }, ' (safe: you can restore them. The space is freed when the Recycle Bin is emptied.)'))),
      h('label', { class: 'check' }, perm, h('span', {}, h('b', {}, ' Delete permanently'), h('span', { class: 'hint' }, ' (frees the space right away; can’t be undone)'))),
      countOf('recycle') ? h('div', { class: 'hint' }, 'Emptying the Recycle Bin is always permanent.') : null);
    const ok = await modal({ title: 'Review cleanup', body, width: 520, buttons: [{ label: 'Back', value: null }, { label: 'Clean up', primary: true, danger: true, value: true }] });
    if (!ok) return;
    const permanent = perm.checked;
    if (permanent && !(await confirm('Delete permanently?', `${fmtSize(allChecked())} will be deleted for good. This can’t be undone.`, { ok: 'Delete', danger: true }))) return;
    let freed = 0, failed = 0;
    const paths = [], sizes = new Map();
    for (const [c] of CATS.slice(1)) { if (c === 'recycle') continue; for (const it of S.checked.get(c) || []) { if (!sizes.has(it.path)) { paths.push(it.path); sizes.set(it.path, it.size || 0); } } }
    status.textContent = 'Cleaning up…';
    if (paths.length) {
      const j = await A.runJob({ type: permanent ? 'delete' : 'trash', sources: paths });
      const bad = new Set((j.errors || []).map((e) => e.split(': ')[0]));
      for (const p of paths) { if (bad.has(p)) failed++; else freed += sizes.get(p); }
    }
    if (countOf('recycle')) { const before = S.recycle.reduce((a, i) => a + (i.size || 0), 0); if (await api('recycle:empty').catch(() => false)) freed += before; }
    toast(`${permanent ? 'Freed' : 'Moved to the Recycle Bin:'} ${fmtSize(freed)}${failed ? ` · ${failed} item${failed === 1 ? '' : 's'} couldn’t be removed (in use?)` : ''}`, { ms: 7000 });
    scan();
  };
  let closeAll = () => {};
  drawNav(); drawMain();
  const body = h('div', { class: 'cl' },
    h('div', { class: 'cl-top' }, h('span', { class: 'hint' }, 'Look in'), scope, scanBtn, status),
    h('div', { class: 'cl-body' }, nav, main, pv));
  const p = modal({ title: 'Storage cleanup', body, width: 1180, className: 'cl-modal', noPadding: false,
    onClose: () => { for (const j of jobs) api('work:cancel', j); S.cancelPhotos?.(); },
    buttons: [{ label: 'Close', value: null }, { el: cleanBtn, primary: true }] });
  setTimeout(() => {
    closeAll = () => body.closest('.modal')?.querySelector('.modal-foot .btn:not(.primary)')?.click();
    if (initialRoot) scan();
  }, 0);
  return p;
}
bus.on('cleanup', () => openCleanup());
