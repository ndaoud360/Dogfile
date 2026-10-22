// File history & recovery: a log of what happened to your files (copies, moves, renames, deletes, automations),
// with Undo on anything that can still be undone, plus versions of chosen files and folders, and checksum files
// to prove nothing changed or got corrupted. The log is capped (Settings) so it never slows Dogfile down.
import { api, state, bus, h, esc, toast, fmtSize, fmtDate, basename, dirname, debounce, IS_WIN, pjoin, uid, saveSettings } from './core.js';
import { modal, confirm, prompt } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate, selectedItems, loadTab } from './pane.js';
import * as A from './actions.js';
import { onWorkMsgFor } from './tools.js';
import { requirePro } from './license.js';

let log = null; // newest first
const limit = () => Math.max(50, +state.settings.historyLimit || 1000);
const save = debounce(() => api('store:set', 'history', log.slice(0, limit())), 1500);
async function ensure() { if (!log) log = (await api('store:get', 'history').catch(() => null)) || []; return log; }
const KIND = { renamed: ['rename', 'Renamed'], moved: ['cut', 'Moved'], created: ['copy', 'Created / copied'], trashed: ['trash', 'Recycled'], copy: ['copy', 'Copied'], move: ['cut', 'Moved'], delete: ['trash', 'Deleted'], trash: ['trash', 'Recycled'], extract: ['extract', 'Extracted'], compress: ['zip', 'Compressed'], automation: ['automation', 'Automation'], version: ['history', 'Version saved'], restore: ['history', 'Version restored'] };
async function add(e) {
  await ensure();
  log.unshift({ id: uid(), at: Date.now(), ...e });
  if (log.length > limit() + 50) log.length = limit();
  save();
  bus.emit('historyChanged');
}
bus.on('historyAdd', (rec) => {
  const paths = rec.pairs ? rec.pairs.slice(0, 200) : (rec.paths || []).slice(0, 200).map((p) => [p]);
  add({ kind: rec.type, title: rec.title || KIND[rec.type]?.[1] || rec.type, paths, count: (rec.pairs || rec.paths || []).length, rec: { ...rec, pairs: rec.pairs?.slice(0, 5000), paths: rec.paths?.slice(0, 5000) } });
});
bus.on('jobDone', (j) => {
  if (j.status === 'cancelled' && !j.done) return;
  add({ kind: j.type, title: j.title, count: j.sourceCount || 0, status: j.status, errors: (j.errors || []).slice(0, 20), dest: j.dest, failed: j.failed });
});
bus.on('history', (e) => add(e));
// for the assistant: the log (newest first), and undoing one entry
export async function historyEntries() { return (await ensure()).slice(); }
export const canUndoEntry = (e) => !!(e.rec && !e.undone && ['renamed', 'moved', 'created', 'trashed'].includes(e.rec.type));
export async function undoEntry(e) {
  await A.reverseRecord(e.rec);
  state.undo = state.undo.filter((x) => !(x.at === e.rec.at && x.title === e.rec.title));
  e.undone = true; save(); bus.emit('refreshPanes'); bus.emit('historyChanged');
}
bus.on('historyUndone', async (r) => { await ensure(); const e = log.find((x) => x.rec && x.rec.at === r.at && x.rec.title === r.title); if (e) { e.undone = !!r.undone; save(); bus.emit('historyChanged'); } });

export async function historyDialog() {
  await ensure();
  const q = h('input', { class: 'input', placeholder: 'Search history (file name, folder, action)…', spellcheck: 'false' });
  let kindF = 'all';
  const list = h('div', { class: 'hi-list' });
  const kinds = h('div', { class: 'row-inline wrap' }, ...[['all', 'Everything'], ['move', 'Moves'], ['renamed', 'Renames'], ['copy', 'Copies'], ['trash', 'Deletes'], ['automation', 'Automations'], ['problems', 'Problems']].map(([k, l]) => { const b = h('button', { class: 'chip' + (k === kindF ? ' on' : '') }, l); b.onclick = () => { kindF = k; kinds.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); draw(); }; return b; }));
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    list.innerHTML = '';
    let day = '';
    let shown = 0;
    for (const e of log) {
      if (kindF === 'problems' && !(e.errors?.length || e.status === 'error')) continue;
      if (kindF === 'move' && !['move', 'moved'].includes(e.kind)) continue;
      if (kindF === 'copy' && !['copy', 'created'].includes(e.kind)) continue;
      if (kindF === 'trash' && !['trash', 'trashed', 'delete'].includes(e.kind)) continue;
      if (!['all', 'problems', 'move', 'copy', 'trash'].includes(kindF) && e.kind !== kindF) continue;
      if (s && !JSON.stringify([e.title, e.paths, e.detail, e.dest]).toLowerCase().includes(s)) continue;
      if (++shown > 400) break;
      const d = new Date(e.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (d !== day) { day = d; list.append(h('div', { class: 'hi-day' }, d)); }
      const [ic] = KIND[e.kind] || ['history'];
      const canUndo = e.rec && !e.undone && ['renamed', 'moved', 'created', 'trashed'].includes(e.rec.type);
      const detail = h('div', { class: 'hi-detail' });
      const row = h('div', { class: 'hi-row' + (e.undone ? ' undone' : '') + (e.errors?.length || e.status === 'error' ? ' bad' : '') },
        h('span', { class: 'hi-ic', html: icon(ic) }),
        h('div', { class: 'hi-main' }, h('b', {}, e.title || e.kind), h('span', { class: 'hint' }, [new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), e.count ? `${e.count} item${e.count === 1 ? '' : 's'}` : '', e.dest ? `→ ${e.dest}` : '', e.undone ? 'undone' : '', e.errors?.length ? `${e.errors.length} problem${e.errors.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'hi-acts' },
          (e.paths?.length || e.detail?.length || e.errors?.length) ? h('button', { class: 'btn small', onclick: () => { detail.classList.toggle('open'); if (!detail.childNodes.length) fillDetail(detail, e); } }, 'Details') : null,
          canUndo ? h('button', { class: 'btn small', onclick: async () => { if (!(await confirm('Undo this?', `Put back: ${esc(e.title)}`, { ok: 'Undo' }))) return; try { await A.reverseRecord(e.rec); state.undo = state.undo.filter((x) => !(x.at === e.rec.at && x.title === e.rec.title)); e.undone = true; save(); toast('Undone'); bus.emit('refreshPanes'); draw(); } catch (err) { toast(`Couldn’t undo: ${err.message}`, { error: true }); } } }, 'Undo') : null,
          e.failed?.length ? h('button', { class: 'btn small', onclick: () => A.runJob({ type: e.kind, sources: e.failed, dest: e.dest }) }, 'Retry') : null,
          showPath(e) ? h('button', { class: 'icon-btn small', title: 'Show in folder', html: icon('folderOpen'), onclick: () => { const p = showPath(e); closeIt(); navigate(activeTab(), dirname(p) || p, { select: p }); } }) : null));
      list.append(row, detail);
    }
    if (!shown) list.append(h('div', { class: 'hint pad' }, log.length ? 'Nothing matches.' : 'Nothing yet. Copies, moves, renames and deletes will show up here.'));
  };
  const fillDetail = (box, e) => {
    for (const p of (e.paths || []).slice(0, 200)) box.append(h('div', { class: 'hi-p' }, p.length > 1 ? `${p[0]}  →  ${basename(p[1]) === basename(p[0]) ? dirname(p[1]) : p[1]}` : p[0]));
    for (const x of (e.detail || []).slice(0, 200)) box.append(h('div', { class: 'hi-p' }, x));
    for (const x of e.errors || []) box.append(h('div', { class: 'hi-p bad' }, `${x} — ${explainError(x)}`));
  };
  const showPath = (e) => (e.rec?.pairs?.[0]?.[e.undone ? 0 : 1]) || (e.rec?.paths?.[0]) || e.dest || null;
  q.oninput = draw;
  q.addEventListener('keydown', (e) => e.stopPropagation());
  draw();
  const off = bus.on('historyChanged', draw);
  let closeIt = () => {};
  const p = modal({ title: 'File history', width: 820, className: 'hi-modal', body: h('div', { class: 'hi' }, q, kinds, list), onClose: off, buttons: [
    { label: 'Versions…', left: true, run: () => { versionsOverview(); return false; } },
    { label: 'Clear history', left: true, run: async () => { if (await confirm('Clear history?', 'This only clears the list. Your files are not touched.', { ok: 'Clear' })) { log = []; save(); draw(); } return false; } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.hi-modal')?._close?.(null); }, 0);
  return p;
}

// plain-language reasons for failed file operations
export function explainError(msg = '') {
  const m = String(msg);
  if (/EBUSY|resource busy|being used|locked/i.test(m)) return 'another program has it open. Close that program (or use “What’s locking this?”) and retry.';
  if (/EPERM|EACCES|access is denied|permission/i.test(m)) return 'Windows didn’t allow it. The file may be read-only, protected, or need administrator rights.';
  if (/ENOSPC|no space/i.test(m)) return 'the destination drive is full. Free some space and retry.';
  if (/ENAMETOOLONG|name too long/i.test(m)) return 'the full path is too long for Windows. Shorten folder or file names.';
  if (/ENOENT|no such file/i.test(m)) return 'it was moved or deleted before Dogfile got to it.';
  if (/EEXIST/i.test(m)) return 'something with that name is already there.';
  if (/EIO|i\/o error|CRC|cyclic redundancy/i.test(m)) return 'the disk couldn’t read it. The drive or the file may be damaged.';
  if (/ENOTEMPTY/i.test(m)) return 'the folder still has files in it.';
  if (/EINVAL|invalid/i.test(m)) return 'the name has characters Windows doesn’t allow (\\ / : * ? " < > |).';
  if (/ETIMEDOUT|ECONNRESET|network|ENETUNREACH|EHOSTUNREACH/i.test(m)) return 'the network connection dropped. Check the connection and retry.';
  if (/inside itself/i.test(m)) return 'a folder can’t go inside itself.';
  return 'see the message for details.';
}

// ---------------- versions ----------------
export async function versionsDialog(p) {
  if (!requirePro('versions')) return;
  if (!p) { const it = selectedItems(activeTab())[0]; p = it?.path; }
  if (!p || p.startsWith('atlas:')) return toast('Select a file or folder first');
  const list = h('div', { class: 'vs-list' });
  const tracked = () => (state.settings.trackedFiles || []).includes(p);
  const isDir = await api('fs:isDir', p);
  const trackBox = h('input', { type: 'checkbox', class: 'switch' }); trackBox.checked = tracked(); trackBox.disabled = isDir;
  trackBox.onchange = () => { const s = new Set(state.settings.trackedFiles || []); trackBox.checked ? s.add(p) : s.delete(p); state.settings.trackedFiles = [...s]; saveSettings(); api('versions:track', state.settings.trackedFiles); };
  const draw = async () => {
    const vs = await api('versions:list', p);
    list.innerHTML = '';
    if (!vs.length) list.append(h('div', { class: 'hint pad' }, 'No versions yet. Save one now, or turn on automatic versions.'));
    for (const v of vs) {
      list.append(h('div', { class: 'vs-row' }, h('span', { class: 'hi-ic', html: icon(v.auto ? 'history' : 'save') }),
        h('div', { class: 'hi-main' }, h('b', {}, fmtDate(v.at)), h('span', { class: 'hint' }, [fmtSize(v.size || 0), v.note, v.auto ? 'automatic' : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'hi-acts' },
          !v.isDir ? h('button', { class: 'btn small', onclick: () => api('shell:open', v.file) }, 'Open') : h('button', { class: 'btn small', onclick: () => { closeIt(); navigate(activeTab(), v.file); } }, 'Browse'),
          !v.isDir ? h('button', { class: 'btn small', title: 'Compare with the current file', onclick: () => import('./apptabs.js').then((m) => m.openTool('editor', [v.file, p], { compare: true })) }, 'Compare') : null,
          h('button', { class: 'btn small', onclick: async () => { const out = await api('versions:restore', p, v.id, { asCopy: true }); toast(`Saved as “${basename(out)}”`); bus.emit('refreshPanes'); } }, 'Restore as copy'),
          h('button', { class: 'btn small primary', onclick: async () => { if (!(await confirm('Restore this version?', `The current ${isDir ? 'folder' : 'file'} is saved as a version first, so you can come back to it.`, { ok: 'Restore' }))) return; await api('versions:restore', p, v.id); bus.emit('history', { kind: 'restore', title: `Restored an older version of ${basename(p)}`, paths: [[p]] }); toast('Restored'); bus.emit('refreshPanes'); draw(); } }, 'Restore'),
          h('button', { class: 'icon-btn small', title: 'Delete this version', html: icon('trash'), onclick: async () => { await api('versions:remove', p, v.id); draw(); } }))));
    }
  };
  draw();
  let closeIt = () => {};
  const p2 = modal({ title: `Versions of “${basename(p)}”`, width: 720, className: 'vs-modal', body: h('div', { class: 'stack' },
    h('div', { class: 'hint' }, p),
    h('label', { class: 'ru-watch' }, trackBox, h('span', {}, h('b', {}, 'Save a version automatically'), h('span', { class: 'hint' }, isDir ? ' (files only; save folder versions by hand)' : ' every time this file changes (while Dogfile is open).'))),
    list), buttons: [
    { label: 'Save a version now…', left: true, run: async () => { const note = await prompt('Save a version', '', { label: 'Note (optional)', placeholder: 'e.g. Before big edits' }); if (note === null) return false; try { await api('versions:save', p, note); bus.emit('history', { kind: 'version', title: `Saved a version of ${basename(p)}`, paths: [[p]] }); toast('Version saved'); draw(); } catch (e) { toast(`Couldn’t save a version: ${e.message}`, { error: true }); } return false; } },
    { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.vs-modal')?._close?.(null); }, 0);
  return p2;
}
export async function versionsOverview() {
  if (!requirePro('versions')) return;
  const all = await api('versions:overview');
  const list = h('div', { class: 'vs-list' }, ...(all.length ? all.map((x) => h('div', { class: 'vs-row' }, h('span', { class: 'hi-ic', html: icon('history') }), h('div', { class: 'hi-main' }, h('b', {}, basename(x.path)), h('span', { class: 'hint' }, `${x.path} · ${x.count} version${x.count === 1 ? '' : 's'} · ${fmtSize(x.size)} · last ${fmtDate(x.last)}${(state.settings.trackedFiles || []).includes(x.path) ? ' · automatic' : ''}`)), h('div', { class: 'hi-acts' }, h('button', { class: 'btn small', onclick: () => versionsDialog(x.path) }, 'Open')))) : [h('div', { class: 'hint pad' }, 'No versions saved yet. Right-click a file > More > Versions… to start.')]));
  await modal({ title: 'All saved versions', width: 720, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `Dogfile keeps up to ${state.settings.versionsKeep || 20} versions per file and ${fmtSize((state.settings.versionsMaxMB || 5000) * 1048576)} in total (change this in Settings > Files).`), list), buttons: [{ label: 'Close', primary: true, value: true }] });
}
setTimeout(() => { if (state.settings.trackedFiles?.length) api('versions:track', state.settings.trackedFiles); }, 3000);

// ---------------- checksums ----------------
const ALGOS = { sha256: 64, sha1: 40, md5: 32 };
export async function createChecksums(items) {
  items = (items || selectedItems(activeTab())).filter((i) => !i.virtual);
  const t = activeTab();
  if (!items.length && t?.path && !t.path.startsWith('atlas:')) items = [{ path: t.path, name: basename(t.path), isDir: true }];
  if (!items.length) return toast('Select files or a folder first');
  const base = items.length === 1 && items[0].isDir ? items[0].path : dirname(items[0].path);
  const algoSel = h('select', { class: 'input sm' }, h('option', { value: 'sha256' }, 'SHA-256 (recommended)'), h('option', { value: 'sha1' }, 'SHA-1'), h('option', { value: 'md5' }, 'MD5'));
  const name = h('input', { class: 'input', value: `${items.length === 1 ? items[0].name.replace(/\.[^.]+$/, '') : basename(base) || 'checksums'}.sha256` });
  algoSel.onchange = () => { name.value = name.value.replace(/\.(sha256|sha1|md5)$/i, '') + '.' + algoSel.value; };
  const ok = await modal({ title: 'Create checksum file', width: 520, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `A small text file with a fingerprint of every file (${items.length === 1 && items[0].isDir ? 'in this folder and its subfolders' : `${items.length} selected`}). Later, “Verify checksums” tells you if anything changed, went missing or got corrupted.`), h('div', { class: 'row-inline' }, h('span', {}, 'Method'), algoSel), h('div', { class: 'row-inline' }, h('span', {}, 'Save as'), name)), buttons: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, value: true }] });
  if (!ok) return;
  const files = items.length === 1 && items[0].isDir ? [{ abs: items[0].path, rel: '' }] : items.map((i) => ({ abs: i.path, rel: i.name }));
  const res = await hashWithProgress(files, algoSel.value, 'Fingerprinting files…');
  if (!res) return;
  const lines = res.filter((f) => f.hash).sort((a, b) => a.rel.localeCompare(b.rel)).map((f) => `${f.hash} *${f.rel}`);
  const out = pjoin(base, name.value.trim() || 'checksums.sha256');
  await api('fs:writeText', out, lines.join('\n') + '\n');
  toast(`Saved fingerprints of ${lines.length} file${lines.length === 1 ? '' : 's'} to ${basename(out)}`, { action: { label: 'Show', run: () => navigate(activeTab(), base, { select: out }) } });
  bus.emit('refreshPanes');
}
async function hashWithProgress(files, algo, title) {
  const host = document.getElementById('toasts');
  const txt = h('span', {}, title), fill = h('div', { class: 'tp-fill' });
  let id;
  const el = h('div', { class: 'toast show tprog' }, txt, h('div', { class: 'tp-bar' }, fill), h('button', { class: 'link', onclick: () => { api('work:cancel', id); el.remove(); res(null); } }, 'Stop'));
  host?.append(el);
  let res;
  const r = await new Promise(async (resolve) => {
    res = resolve;
    id = await api('work:start', { type: 'hashfiles', files, algo });
    onWorkMsgFor(id, (m) => { if (m.type === 'progress') { txt.textContent = `${title} ${m.done} of ${m.of} · ${fmtSize(m.bytes)}`; fill.style.width = (m.total ? (m.bytes / m.total) * 100 : (m.done / m.of) * 100) + '%'; } else resolve(m.type === 'done' ? m.files : null); });
  });
  el.remove();
  return r;
}
export async function verifyChecksums(file) {
  if (!file) { const it = selectedItems(activeTab()).find((i) => /\.(sha256|sha1|md5|sfv)$/i.test(i.name)); file = it?.path; }
  if (!file) { const f = await api('dialog:openFiles', { title: 'Choose a checksum file', filters: [{ name: 'Checksums', extensions: ['sha256', 'sha1', 'md5'] }] }); file = f?.[0]; }
  if (!file) return;
  const txt = await api('fs:readText', file, 20 * 1048576);
  const base = dirname(file);
  const want = [];
  for (const line of (txt.text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{32,64})\s+\*?(.+)$/.exec(line.trim()) || /^(?:SHA256|SHA1|MD5) \((.+)\) = ([0-9a-fA-F]+)$/.exec(line.trim());
    if (!m) continue;
    const [hash, rel] = /^[0-9a-f]+$/i.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    want.push({ hash: hash.toLowerCase(), rel: rel.replace(/^\.\//, '') });
  }
  if (!want.length) return toast('No checksums found in that file', { error: true });
  const algo = Object.entries(ALGOS).find(([, n]) => n === want[0].hash.length)?.[0] || 'sha256';
  const res = await hashWithProgress(want.map((w) => ({ abs: pjoin(base, w.rel.replace(/\//g, IS_WIN() ? '\\' : '/')), rel: w.rel })), algo, 'Verifying…');
  if (!res) return;
  const got = new Map(res.map((r) => [r.rel, r]));
  const rows = { ok: [], changed: [], missing: [], unreadable: [] };
  for (const w of want) { const r = got.get(w.rel); if (!r || r.missing) rows.missing.push(w.rel); else if (r.error) rows.unreadable.push(`${w.rel} (${r.error})`); else if (r.hash === w.hash) rows.ok.push(w.rel); else rows.changed.push(w.rel); }
  const sec = (title, cls, arr) => arr.length ? h('details', { class: 'iv-sec ' + cls, open: cls !== 'ok' }, h('summary', {}, `${title}: ${arr.length}`), ...arr.slice(0, 500).map((x) => h('div', { class: 'hi-p' }, x))) : null;
  const allGood = !rows.changed.length && !rows.missing.length && !rows.unreadable.length;
  await modal({ title: allGood ? 'All files are intact' : 'Some files changed', width: 640, body: h('div', { class: 'stack' },
    h('div', { class: 'iv-head ' + (allGood ? 'good' : 'bad'), html: icon(allGood ? 'shieldCheck' : 'info') + `<span>${allGood ? `All ${rows.ok.length} files match their fingerprints. Nothing changed or got corrupted.` : `${rows.changed.length} changed, ${rows.missing.length} missing, ${rows.unreadable.length} unreadable, ${rows.ok.length} fine.`}</span>` }),
    sec('Changed or corrupted', 'bad', rows.changed), sec('Missing', 'bad', rows.missing), sec('Couldn’t read', 'bad', rows.unreadable), sec('Fine', 'ok', rows.ok)),
    buttons: [{ label: 'Close', primary: true, value: true }] });
}
bus.on('historyDialog', historyDialog);
