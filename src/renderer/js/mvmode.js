// Multiverse Mode: one click saves a snapshot of the folder you are in (and everything in it). A glowing frame and a
// "Multiverse Mode" label show you are in it. Work as normal: rename, sort, tidy up, delete, anything. Deleted things wait in
// a temporary trash. Then Make it real (after a look at what changed and what goes to the Recycle Bin) or Discard, which goes
// back to the snapshot. It only covers the folder it started in and the folders inside it.
// The engine is backend/src/snapshot.rs; this is the window.
import { api, state, h, toast, bus, fmtSize, basename, errText, isVirtual, isRemote, isMtp } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab } from './pane.js';
import { mvActive, mvName } from './mvstate.js';

const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const refresh = () => bus.emit('refreshPanes');
let badge = null, halo = null, timer = null, wait = null;

// ---------- the frame and the corner label ----------
function mount() {
  if (halo) return;
  document.body.classList.add('mv-on');
  halo = h('div', { id: 'mv-halo' });
  const count = h('span', { class: 'mv-count' });
  badge = h('div', { id: 'mv-badge' },
    h('div', { class: 'mv-title', title: `Everything here is a trial run inside “${state.mv.name}”. Nothing is final until you make it real.` }, h('span', { class: 'mv-dot' }), 'Multiverse Mode', h('span', { class: 'mv-where' }, state.mv.name)),
    h('div', { class: 'mv-actions' },
      h('button', { class: 'mv-btn', title: 'Things you deleted wait here until you make it real', onclick: () => showTrash() }, h('span', { html: icon('trash') }), ' Trash ', count),
      h('button', { class: 'mv-btn', title: 'Throw it all away and go back to the snapshot', onclick: () => discard() }, 'Discard'),
      h('button', { class: 'mv-btn primary', title: 'Keep these changes (you will see what changes first)', onclick: () => makeReal() }, 'Make it real…')));
  badge._count = count;
  document.body.append(halo, badge);
  tick();
  timer = setInterval(tick, 3000);
}
function unmount() {
  document.body.classList.remove('mv-on');
  halo?.remove(); badge?.remove(); halo = badge = null;
  clearInterval(timer); timer = null;
}
async function tick() {
  if (!state.mv || !badge) return;
  try {
    const s = await api('mvs:status');
    if (!s?.active) return;
    badge._count.textContent = s.trashed ? `(${s.trashed})` : '';
    state.mv.trashed = s.trashed;
  } catch { /* the next tick tries again */ }
}
bus.on('jobDone', () => { if (mvActive()) setTimeout(tick, 200); });
bus.on('undo', () => { if (mvActive()) setTimeout(tick, 200); });

function showWait(text) {
  hideWait();
  wait = h('div', { class: 'mv-wait' }, h('div', { class: 'mv-wait-box' }, h('div', { class: 'mv-spin' }), h('div', {}, text)));
  document.body.append(wait);
}
function hideWait() { wait?.remove(); wait = null; }

/** what happened in this Multiverse is not a step to undo any more (it is final, or it never happened) */
function forgetHistory(since) {
  state.undo = state.undo.filter((e) => (e.at || 0) < since);
  state.redo = [];
  bus.emit('undo');
}

// ---------- start ----------
export async function start() {
  if (mvActive()) return choose();
  const t = activeTab();
  const path = t?.path;
  if (!path || t.app || isVirtual(path) || isRemote(path) || isMtp(path)) { toast('Open a folder on this PC first, then start Multiverse'); return; }
  showWait(`Saving a snapshot of “${basename(path) || path}”…`);
  let r;
  try { r = await api('mvs:begin', path); } catch (e) { hideWait(); toast(errText(e), { error: true, ms: 9000 }); return; }
  hideWait();
  state.mv = { root: path, name: basename(path) || path, started: r.started, files: r.files, folders: r.folders, unprotected: r.unprotected, trashed: 0 };
  mount();
  const note = r.unprotected ? ` ${plural(r.unprotected, 'file')} couldn’t be copied into the snapshot (other drive or cloud-only), so changes to ${r.unprotected === 1 ? 'it' : 'those'} can’t be fully undone.` : '';
  toast(`Multiverse Mode is on. Snapshot saved: ${plural(r.files, 'file')} in ${plural(r.folders + 1, 'folder')}.${note}`, { ok: !r.unprotected, ms: r.unprotected ? 12000 : 6000 });
}

/** the command while one is open: choose what to do */
async function choose() {
  const v = await modal({
    title: 'Multiverse is open', width: 460,
    body: h('div', { class: 'confirm-msg' }, `You are trying changes in “${mvName()}”. Make them real, or go back to how it was when you started.`),
    buttons: [{ label: 'Keep working', value: 'keep' }, { label: 'Discard', value: 'discard' }, { label: 'Make it real…', primary: true, value: 'real' }],
  });
  if (v === 'real') return makeReal();
  if (v === 'discard') return discard();
}

// ---------- make it real ----------
const list = (items, n, fmt = (x) => x) => h('ul', { class: 'mv-list' }, ...items.slice(0, 8).map((x) => h('li', {}, fmt(x))), n > 8 ? h('li', { class: 'mv-more' }, `and ${(n - 8).toLocaleString()} more`) : null);
function section(title, n, body, cls = '') {
  return n ? h('div', { class: 'mv-sec ' + cls }, h('div', { class: 'mv-sec-h' }, title), body) : null;
}
function summaryBody(p, mode) {
  const none = !(p.createdCount || p.changedCount || p.movedCount || p.removedCount || p.foldersCreatedCount || p.foldersRemovedCount || p.trashedCount);
  if (none) return h('div', { class: 'confirm-msg' }, 'Nothing is different from the snapshot.');
  const arrow = ([a, b]) => h('span', {}, h('b', {}, a), ' → ', h('b', {}, b));
  const bold = (x) => h('b', {}, x);
  const real = mode === 'real';
  return h('div', { class: 'mv-sum' },
    section(real ? 'Moved or renamed' : 'Will move back', p.movedCount, list(p.moved, p.movedCount, arrow)),
    section(real ? 'New files' : 'New files (sent to the Recycle Bin)', p.createdCount, list(p.created, p.createdCount, bold)),
    section(real ? 'New folders' : 'New folders (removed)', p.foldersCreatedCount, list(p.foldersCreated, p.foldersCreatedCount, bold)),
    section(real ? 'Changed' : 'Changed files (brought back as they were)', p.changedCount, list(p.changed, p.changedCount, bold)),
    section(real ? 'Gone another way' : 'Gone another way (brought back)', p.removedCount + p.foldersRemovedCount, list([...p.removed, ...p.foldersRemoved], p.removedCount + p.foldersRemovedCount, bold)),
    section(real ? `Will go to the Windows Recycle Bin (${plural(p.trashedCount, 'item')}, ${fmtSize(p.trashedBytes)})` : `Deleted here, so they come back (${plural(p.trashedCount, 'item')})`, p.trashedCount,
      list(p.trashed, p.trashedCount, (x) => h('span', {}, bold(x.rel), x.isDir ? ' (folder)' : '', ` · ${fmtSize(x.size)}`)), real ? 'danger' : ''));
}

export async function makeReal() {
  if (!mvActive()) return;
  let p;
  try { p = await api('mvs:plan'); } catch (e) { toast(errText(e), { error: true }); return; }
  const ok = await modal({
    title: 'Make these changes real?', width: 620, className: 'mv-modal',
    body: h('div', {}, h('div', { class: 'hint' }, 'This is what changed in “' + mvName() + '” since the snapshot.'), summaryBody(p, 'real'),
      p.trashedCount ? h('div', { class: 'mv-warn' }, 'The deleted items will be moved to the Windows Recycle Bin. You can still restore them from there.') : null),
    buttons: [{ label: 'Keep working', value: false }, { label: 'Make it real', primary: true, danger: !!p.trashedCount, value: true }],
  });
  if (!ok) return;
  const since = state.mv.started;
  showWait('Making it real…');
  let r;
  try { r = await api('mvs:commit'); } catch (e) { hideWait(); toast(errText(e), { error: true, ms: 9000 }); return; }
  hideWait();
  state.mv = null; unmount(); forgetHistory(since); refresh();
  toast(`Done. The changes are real${r.recycled ? ` and ${plural(r.recycled, 'item')} went to the Recycle Bin` : ''}.${r.problems?.length ? ` ${plural(r.problems.length, 'problem')}: ${r.problems[0]}` : ''}`, { ok: !r.problems?.length, error: !!r.problems?.length, ms: 7000 });
}

// ---------- discard ----------
export async function discard() {
  if (!mvActive()) return;
  let p;
  try { p = await api('mvs:plan'); } catch (e) { toast(errText(e), { error: true }); return; }
  const ok = await modal({
    title: 'Go back to the snapshot?', width: 620, className: 'mv-modal',
    body: h('div', {}, h('div', { class: 'hint' }, 'Everything in “' + mvName() + '” goes back to how it was when you started. This is what is put back:'), summaryBody(p, 'discard')),
    buttons: [{ label: 'Keep working', value: false }, { label: 'Go back to the snapshot', primary: true, value: true }],
  });
  if (!ok) return;
  const since = state.mv.started;
  showWait('Going back to the snapshot…');
  let r;
  try { r = await api('mvs:discard'); } catch (e) { hideWait(); toast(errText(e), { error: true, ms: 9000 }); return; }
  hideWait();
  if (r.finished) {
    state.mv = null; unmount(); forgetHistory(since); refresh();
    toast(`Back to the snapshot. ${plural(r.restored, 'item')} put back${r.recycled ? `, ${plural(r.recycled, 'new item')} sent to the Recycle Bin` : ''}.`, { ok: true, ms: 7000 });
    if (r.warnings?.length) await modal({ title: 'Some files could not be brought back exactly', width: 560, body: list(r.warnings, r.warnings.length), buttons: [{ label: 'OK', primary: true, value: true }] });
    return;
  }
  refresh();
  const again = await modal({
    title: 'Not everything went back', width: 580,
    body: h('div', {}, h('div', { class: 'confirm-msg' }, 'Some things could not be put back. The snapshot is still saved, so you can try again.'), list(r.problems, r.problems.length)),
    buttons: [{ label: 'Close', value: null }, { label: 'Let go of the snapshot', value: 'forget' }, { label: 'Try again', primary: true, value: 'again' }],
  });
  if (again === 'again') return discard();
  if (again === 'forget' && await confirm('Let go of the snapshot?', 'The folder stays as it is now and Multiverse closes. The snapshot is deleted.', { ok: 'Let go', danger: true })) {
    await api('mvs:forget').catch(() => {});
    state.mv = null; unmount(); forgetHistory(since); refresh();
  }
}

// ---------- the temporary trash ----------
export async function showTrash() {
  if (!mvActive()) return;
  const box = h('div', { class: 'mv-trash' });
  const draw = async () => {
    let r;
    try { r = await api('mvs:trashList'); } catch (e) { box.textContent = errText(e); return; }
    box.innerHTML = '';
    if (!r.items.length) { box.append(h('div', { class: 'confirm-msg' }, 'The trash is empty. Things you delete in Multiverse wait here, and only go to the Recycle Bin when you make it real.')); return; }
    for (const it of r.items) {
      box.append(h('div', { class: 'mv-trash-row' },
        h('span', { class: 'mv-trash-name', title: it.rel }, it.rel, it.isDir ? ' (folder)' : ''),
        h('span', { class: 'hint' }, fmtSize(it.size)),
        h('button', { class: 'btn', onclick: async () => { try { await api('mvs:restore', it.id); refresh(); tick(); draw(); } catch (e) { toast(errText(e), { error: true }); } } }, 'Put back')));
    }
  };
  await draw();
  await modal({ title: 'Multiverse trash', width: 560, body: box, buttons: [{ label: 'Close', primary: true, value: true }] });
}

// ---------- at start: a Multiverse left open by a crash is found again ----------
export async function recover() {
  try {
    const r = await api('mvs:recover');
    if (r?.active) {
      state.mv = { root: r.root, name: basename(r.root) || r.root, started: r.started, files: r.files, folders: r.folders, unprotected: r.unprotected, trashed: r.trashed };
      mount();
      toast(`Multiverse Mode was still open on “${state.mv.name}”. Make it real or discard it when you are ready.`, { ms: 10000 });
    } else if (r?.lost) toast(`A Multiverse snapshot for “${basename(r.lost)}” could not be read. Nothing was changed.`, { error: true, ms: 10000 });
  } catch { /* nothing to find */ }
}

bus.on('multiverse', () => start());
