// File actions: open, copy/cut/paste, delete, rename, new items, undo/redo, archives, shortcuts,
// virtual locations (Home, This PC, Recent, Recycle Bin, Network, Tags), and context menus.
import { isLocked, canLock, lockItems, unlockItems } from './lockui.js';
import { api, state, sys, bus, h, isVirtual, isRemote, remoteParts, onMain, pjoin, dirname, basename, normalize, samePath, extname, stem, fmtSize, toast, onWorkMsgFor, IS_WIN, isMtp, isTextFile, isMediaFile, isImageFile, isModelFile, isOfficeFile, addRecentFile, tagsOf, setTags, moveTags, saveLibrary, kindOf, KINDS, setDriveNames, uid, errText, openDefault } from './core.js';
import { activeTab, paneTab, navigate, openTab, loadTab, renderTabPanes, selectedItems, startRename, selectOnly, otherPaneTab, paneCount, clearThumbCache, invalidateArchive } from './pane.js';
import { showMenu } from './menu.js';
import { prompt, confirm, propertiesDialog, compressDialog, archivePasswordDialog, alertBox } from './dialogs.js';
import { openTool } from './apptabs.js';
import { icon } from './icons.js';
import { featureMenuItems } from './features.js';
import { mvActive, mvJobBlocked } from './mvstate.js';
import { componentReady } from './components.js';

const NO_SEL = () => toast('Select one or more items first');
const realItems = (items) => items.filter((i) => !i.virtual && !i.archive && !i.recycle && !i.share && !i.mtp);
const copyable = (items) => items.filter((i) => !i.virtual && !i.archive && !i.recycle && !i.share);

// ======================================================================
// Opening
// ======================================================================
export async function openItems(items, { pane = state.activePane, newTab = false, newWindow = false } = {}) {
  for (const i of items) if (i && i.ext == null && !i.isDir && (i.name || i.path)) i.ext = extname(i.name || basename(i.path));
  const t = paneTab(pane);
  // time travel: a file that's gone can't open (Revive brings it back); a folder that's gone still shows as it was
  if (items.some((i) => i.tt === 'gone' && !i.isDir)) { toast('This file is gone now. Right-click › Revive brings it back.'); items = items.filter((i) => !(i.tt === 'gone' && !i.isDir)); if (!items.length) return; }
  const dirs = items.filter((i) => i.isDir);
  let files = items.filter((i) => !i.isDir);
  if (items.length === 1 && items[0].addPhone) { import('./phonelink.js').then((m) => m.openPhoneTransfer({ focus: 'android' })); return; }
  if (items.length === 1 && items[0].netdev) { const d = items[0].netdev; if (d.url) api('shell:openExternal', d.url); else if (d.source === 'ssdp') toast(`${d.name}${d.model ? ` (${d.model})` : ''} at ${d.ip}. This device has no web page to open.`); else api('net:open', d.name); return; }
  const locks = files.filter(isLocked);
  if (locks.length) { files = files.filter((f) => !locks.includes(f)); await unlockItems(locks); if (!files.length && !dirs.length) return; }
  const feats = files.filter((f) => /\.(dogmod|atlasfeature)$/i.test(f.name || f.path));
  if (feats.length) { files = files.filter((f) => !feats.includes(f)); const F = await import('./features.js'); for (const f of feats) await F.importFeature(f.path); if (!files.length && !dirs.length) return; }
  const rem = files.filter((f) => f.remote);
  if (rem.length) {
    files = files.filter((f) => !f.remote);
    for (const f of rem.slice(0, 10)) {
      toast(`Downloading “${f.name}” to open it…`, { ms: 2500 });
      try { const local = await api('remote:open', f.remote.id, f.remote.path); await openItems([{ ...f, path: local, remote: null, virtual: false }], { pane }); } catch (e) { toast(`Couldn’t open: ${cleanErr(e)}`, { error: true }); }
    }
    if (!files.length && !dirs.length) return;
  }
  if (items.length === 1 && items[0].path === 'atlas:netinfo') { api('shell:openExternal', 'ms-settings:network-advancedsharing').catch(() => {}); return; }
  if (items.length === 1 && dirs.length === 1) {
    const it = dirs[0];
    if (it.recycle) return;
    if (newWindow) return api('win:new', { path: it.path });
    if (newTab) return openTab(it.path, { after: t, background: true });
    return navigate(t, it.path);
  }
  for (const d of dirs) openTab(d.path, { after: t, background: true });
  // File types chosen in Settings > File types (or "Always open … with") come first
  if (state.settings.fileAssoc && Object.keys(state.settings.fileAssoc).length) {
    const { openAssociated } = await import('./assoc.js');
    const plain = files.filter((f) => !f.archive && !f.recycle && !f.mtp);
    const rest = await openAssociated(plain);
    const done = new Set(plain.filter((f) => !rest.includes(f)));
    done.forEach((f) => addRecentFile(f.path));
    files = files.filter((f) => !done.has(f));
    if (!files.length) return;
  }
  // Built-in apps: Dogfile Notepad for text, Dogfile Player for audio/video
  const local = files.filter((f) => !f.archive && !f.recycle && !f.mtp);
  const texts = state.settings.useAtlasEditor !== false ? local.filter((f) => isTextFile(f) && !(state.settings.useAtlasViewer !== false && isImageFile(f)) && !(state.settings.useAtlas3D !== false && isModelFile(f))) : [];
  const medias = state.settings.useAtlasPlayer !== false ? local.filter(isMediaFile) : [];
  // Photoshop files open as a plain picture, until the Photoshop helper (a one-time download) is installed: then they open
  // in Dogfile PSD with their layers. "Edit layers" in the menu offers the download.
  const psdFiles = state.settings.useAtlasPsd !== false ? local.filter(isPsdFile) : [];
  const psds = psdFiles.length && (await componentReady('psd')) ? psdFiles : [];
  const photos = state.settings.useAtlasViewer !== false ? local.filter((f) => isImageFile(f) && !psds.includes(f)) : [];
  const models = state.settings.useAtlas3D !== false ? local.filter(isModelFile) : [];
  const offices = state.settings.useAtlasOffice !== false ? local.filter((f) => isOfficeFile(f) && !isTextFile(f)) : [];
  if (offices.length) { openTool('office', offices.map((f) => f.path)); offices.forEach((f) => addRecentFile(f.path)); }
  if (models.length) { openTool('model', models.map((f) => f.path), { autoPlaylist: models.length === 1 }); models.forEach((f) => addRecentFile(f.path)); }
  if (psds.length) { openTool('psd', psds.map((f) => f.path), { newTab: true }); psds.forEach((f) => addRecentFile(f.path)); }
  if (photos.length) { openTool('viewer', photos.map((f) => f.path), { autoPlaylist: photos.length === 1 }); photos.forEach((f) => addRecentFile(f.path)); }
  if (texts.length) { openTool('editor', texts.map((f) => f.path)); texts.forEach((f) => addRecentFile(f.path)); }
  if (medias.length) { openTool('player', medias.map((f) => f.path), { play: true, autoPlaylist: medias.length === 1 }); medias.forEach((f) => addRecentFile(f.path)); }
  files = files.filter((f) => !texts.includes(f) && !medias.includes(f) && !photos.includes(f) && !models.includes(f) && !offices.includes(f) && !psds.includes(f)); // psds too: left in, Windows was asked to open them as well ("application not found")
  if (files.length > 15 && !(await confirm('Open many files?', `You're about to open <b>${files.length}</b> files.`))) return;
  for (const f of files) {
    if (f.mtp) {
      toast(`Copying “${f.name}” from the device…`);
      try { const local = await api('mtp:fetch', f.path); const lf = { ...f, path: local, mtp: false }; if (isTextFile(lf) && state.settings.useAtlasEditor !== false) openTool('editor', [local]); else if (isMediaFile(lf) && state.settings.useAtlasPlayer !== false) openTool('player', [local], { play: true }); else if (isImageFile(lf) && state.settings.useAtlasViewer !== false) openTool('viewer', [local]); else api('shell:open', local); }
      catch (e) { toast(`Couldn't open: ${e.message}`, { error: true }); }
      continue;
    }
    if (f.archive) { openArchiveEntry(f); continue; }
    if (f.recycle) continue;
    if (KINDS.archive.includes(f.ext) && state.settings.browseArchives !== false && !newWindow) { navigate(t, `atlas:zip|${f.path}|`); continue; }
    if (f.ext === 'lnk' || f.isLink) {
      const target = await api('fs:readLink', f.path);
      if (target && (await api('fs:isDir', target))) { navigate(t, target); continue; }
    }
    await openDefault(f.path);
    addRecentFile(f.path);
  }
}

async function openArchiveEntry(f) {
  const { arc, entry } = f.archive;
  const tmp = pjoin(sys.known.temp, 'atlas-' + uid());
  toast('Extracting…');
  await runJob({ type: 'extract', sources: [arc], dest: tmp, opts: { smart: false, entry } });
  const p = pjoin(tmp, entry.replace(/\//g, sys.sep));
  // edits are packed back into the archive when the file is saved
  const inner = entry.includes('/') ? entry.replace(/\/[^/]*$/, '') : '';
  api('archive:watchEdit', p, arc, inner);
  const lf = { ...f, path: p, archive: null, virtual: false };
  setTimeout(() => {
    if (isTextFile(lf) && state.settings.useAtlasEditor !== false) openTool('editor', [p]);
    else if (isMediaFile(lf) && state.settings.useAtlasPlayer !== false) openTool('player', [p], { play: true });
    else if (isImageFile(lf) && state.settings.useAtlasViewer !== false) openTool('viewer', [p]);
    else openDefault(p);
  }, 300);
}

export function openInNewTab(items) { for (const i of items.filter((x) => x.isDir)) openTab(i.path, { after: activeTab(), background: true }); }
export function openInOtherPane(items) {
  const d = items.find((i) => i.isDir);
  if (!d) return;
  if (paneCount() < 2) { bus.emit('setLayout', '2v'); }
  setTimeout(() => { const o = otherPaneTab(); if (o) navigate(o, d.path); }, 0);
}

// ======================================================================
// Jobs (via main-process engine)
// ======================================================================
const jobWaiters = new Map();
let undoing = false;
// operations features may watch and change (dogfile.on('beforeMove'…)), by job type
const HOOKED = { copy: 'Copy', move: 'Move', trash: 'Delete', delete: 'Delete', compress: 'Compress', extract: 'Extract' };
export function runJob(spec) {
  // Multiverse Mode: only inside the folder; deleting goes to its temporary trash, not the Recycle Bin
  if (mvActive()) {
    const why = mvJobBlocked(spec);
    if (why) { toast(why, { error: true }); return Promise.resolve({ status: 'cancelled', title: spec.type, error: why }); }
    if (spec.type === 'trash' || spec.type === 'delete') return mvTrash(spec);
  }
  if (spec.network == null) { const net = (p) => p && (/^\\\\/.test(p) || (state.drives || []).some((d) => d.type === 'network' && d.path && String(p).toUpperCase().startsWith(d.path.toUpperCase().slice(0, 2)))); spec = { ...spec, network: net(spec.dest) || (spec.sources || []).some(net) }; }
  return new Promise((resolve0) => { (async () => {
    const kind = HOOKED[spec.type];
    const H = kind && !undoing && !spec.noHooks ? await import('./hooks.js') : null;
    let resolve = resolve0;
    if (H?.hasListeners()) {
      const p = await H.before('before' + kind, { sources: [...(spec.sources || [])], dest: spec.dest ?? null, type: spec.type });
      if (p.cancel) { toast(p.reason, { error: true }); resolve0({ status: 'cancelled', title: spec.type, error: p.reason, cancelledBy: p.by }); return; }
      if (!p.sources?.length) { resolve0({ status: 'cancelled', title: spec.type, error: 'No files left to work on' }); return; }
      spec = { ...spec, sources: p.sources, dest: p.dest ?? spec.dest };
      resolve = (j) => { if (j?.status === 'done') H.after('after' + kind, { sources: spec.sources, dest: spec.dest ?? null, type: spec.type }); resolve0(j); };
    } else if (H) resolve = (j) => { if (j?.status === 'done') H.after('after' + kind, { sources: spec.sources, dest: spec.dest ?? null, type: spec.type }); resolve0(j); };
    const id = await api('ops:start', spec);
    // a quick job can finish before its id arrives here (events and answers travel separately)
    if (finishedEarly.has(id)) { const j = finishedEarly.get(id); finishedEarly.delete(id); resolve(j); return; }
    jobWaiters.set(id, resolve);
  })().catch((e) => {
    // the job couldn't start (a bad path, a feature's hook failing): said, and answered as a failed job like any
    // other, so nothing waits for it forever
    toast(errText(e), { error: true });
    resolve0({ status: 'error', title: spec.type, error: errText(e), errors: [errText(e)] });
  }); });
}

let mvSeq = 0;
async function mvTrash(spec) {
  const started = Date.now();
  let r;
  try { r = await api('mvs:trash', spec.sources || []); } catch (e) { toast(errText(e), { error: true }); return { status: 'error', title: spec.type, error: errText(e), errors: [errText(e)] }; }
  const pairs = r.pairs || [];
  const problems = r.problems || [];
  const j = {
    id: `mv-${++mvSeq}`, type: 'mvtrash', status: 'done', started, finished: Date.now(), sourceCount: pairs.length, filesDone: pairs.length,
    title: pairs.length === 1 ? `Move \"${basename(pairs[0][0])}\" to the Multiverse trash` : `Move ${pairs.length} items to the Multiverse trash`,
    undo: pairs.length ? { type: 'moved', pairs } : null, errors: problems,
  };
  onJobFinished(j);
  return j;
}
const finishedEarly = new Map();
const asking = { password: 0 };
export function onJobFinished(j) {
  const r = jobWaiters.get(j.id);
  if (r) { jobWaiters.delete(j.id); r(j); }
  else { finishedEarly.set(j.id, j); if (finishedEarly.size > 50) finishedEarly.delete(finishedEarly.keys().next().value); }
  if (!(j.status === 'done' && j.undo && !undoing)) bus.emit('jobDone', j);
  let entry = null;
  if (j.status === 'done' && j.undo && !undoing) entry = pushUndo(j.undo, j.title);
  if (!undoing) confirmFinished(j, entry);
  if (j.locked?.length && IS_WIN()) bus.emit('jobLocked', j);
  else if (j.errors?.length) toast(`${j.title}: ${j.errors.length} problem${j.errors.length > 1 ? 's' : ''}: ${j.errors[0]}`, { error: true });
  // an archive that needs its password: extract() asks for it instead
  if (j.status === 'error' && !(asking.password && j.type === 'extract' && /password|encrypted/i.test(String(j.error)))) toast(`${j.title} failed: ${j.error}`, { error: true });
  refreshAffected();
}
const refreshAffected = () => { for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t) loadTab(t, { soft: true }); } };

async function mtpTransfer(paths, dest, mode) {
  const fromDev = paths.some(isMtp), toDev = isMtp(dest);
  if (fromDev && toDev) return toast('Copying between two device folders isn’t supported. Copy to the PC first', { error: true });
  const what = paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
  // sizes for an honest progress bar: phone files from their folder's list, PC files from the disk
  const sizes = new Map();
  try {
    if (fromDev) {
      for (const dir of new Set(paths.map((p) => p.replace(/\/[^/]*$/, '').replace(/\|[^|/]*$/, '|')))) for (const it of await api('mtp:list', dir).catch(() => [])) sizes.set(it.path, it.isDir ? 0 : it.size || 0);
    } else (await api('fs:statMany', paths).catch(() => [])).forEach((x, i) => sizes.set(paths[i], x?.isDir ? 0 : x?.size || 0));
  } catch { /* sizes only make the progress bar exact; the copy runs without them */ }
  const total = paths.reduce((a, p) => a + (sizes.get(p) || 0), 0);
  const { clientJob } = await import('./tools.js');
  const job = clientJob(`${toDev ? 'Copying to the phone' : 'Copying from the phone'}: ${what}`);
  let done = 0, n = 0;
  try {
    for (const p of paths) {
      if (job.cancelled) break;
      job.update({ done, total, filesDone: n, filesTotal: paths.length, current: basename(p), indeterminate: !total });
      if (fromDev) await api('mtp:copyOut', [p], dest); else await api('mtp:copyIn', [p], dest);
      done += sizes.get(p) || 0; n++;
      job.update({ done, total, filesDone: n, filesTotal: paths.length });
    }
    job.finish('done');
    if (!job.cancelled && mode === 'move') toast('Phones only support copying, so the originals were kept');
  } catch (e) { job.finish('error', cleanErr(e)); toast(`Phone copy failed: ${cleanErr(e)}`, { error: true }); }
  refreshAffected();
}

// copying to and from SFTP / FTP servers (with a progress toast)
let remoteToken = 0;
const remoteProg = new Map();
onMain('remote:progress', (x) => remoteProg.get(x.token)?.(x));
async function remoteTransfer(paths, dest, mode) {
  const token = ++remoteToken;
  // progress in the Activity list / progress window (minimize it to keep working)
  const { clientJob } = await import('./tools.js');
  const job = clientJob(`${isRemote(dest) ? 'Uploading' : 'Downloading'} ${paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`}`);
  const txt = { set textContent(v) { job.update({ current: v }); } };
  let total = 0;
  const st = await api('fs:statMany', paths.filter((p) => !isRemote(p))).catch(() => []);
  total = st.reduce((a, x) => a + (x?.size || 0), 0);
  remoteProg.set(token, (x) => job.update({ current: x.current || '', done: x.done || 0, total, indeterminate: !total }));
  try {
    if (isRemote(dest)) {
      const { id, path } = remoteParts(dest);
      const local = paths.filter((p) => !isRemote(p));
      // inside the same connection: the service copies or moves it itself (nothing comes down to this PC)
      if (paths.length && paths.every((p) => isRemote(p) && remoteParts(p).id === id)) {
        txt.textContent = mode === 'move' ? 'Moving on the server…' : 'Copying on the server…';
        const rels = paths.map((p) => remoteParts(p).path);
        if (mode === 'move') for (const r of rels) await api('remote:rename', id, r, (path.endsWith('/') ? path : path + '/') + basename(r));
        else await api('remote:copy', id, rels, path);
        toast(`${mode === 'move' ? 'Moved' : 'Copied'} ${rels.length} item${rels.length === 1 ? '' : 's'} on the server`);
        job.finish('done');
        return { status: 'done' };
      }
      if (paths.some(isRemote)) throw new Error('Copying between two servers isn’t supported. Copy to this PC first.');
      await api('remote:put', id, local, path, token);
      if (mode === 'move') await runJob({ type: 'trash', sources: local });
      toast(`${mode === 'move' ? 'Moved' : 'Uploaded'} ${local.length} item${local.length === 1 ? '' : 's'} to the server`);
    } else {
      if (isVirtual(dest)) throw new Error('Choose a folder on this PC');
      const groups = new Map();
      for (const p of paths) { const { id, path } = remoteParts(p); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(path); }
      const made = [];
      for (const [id, list] of groups) { made.push(...(await api('remote:get', id, list, dest, token))); if (mode === 'move') await api('remote:remove', id, list); }
      pushUndo({ type: 'created', paths: made }, `Download ${made.length} item${made.length === 1 ? '' : 's'}`);
      toast(`Downloaded ${made.length} item${made.length === 1 ? '' : 's'}`);
    }
    job.finish('done');
  } catch (e) {
    job.finish('error', cleanErr(e)); toast(cleanErr(e), { error: true });
    // a failed transfer says so: a cut isn't treated as done (the clipboard keeps the files), and callers can tell
    return { status: 'error', error: cleanErr(e) };
  } finally { remoteProg.delete(token); refreshAffected(); }
  return { status: 'done' };
}

async function reviewConflicts(paths, dest, mode) {
  const r = await api('fs:list', dest).catch(() => null);
  if (!r?.items) return false;
  const low = (x) => (IS_WIN() ? x.toLowerCase() : x);
  const there = new Map(r.items.map((i) => [low(i.name), i]));
  const clashes = paths.filter((p) => there.has(low(basename(p))) && !samePath(dirname(p), dest));
  if (clashes.length < 2) return false;
  const srcSt = await api('fs:statMany', clashes).catch(() => []);
  const rows = clashes.map((p, i) => ({ src: p, dst: pjoin(dest, basename(p)), a: srcSt[i] || {}, b: there.get(low(basename(p))) }));
  const same = (x) => x.a.size === x.b.size && Math.abs((x.a.mtime || 0) - (x.b.mtime || 0)) < 2000;
  const choice = new Map();
  const smart = (x) => (same(x) ? 'skip' : (x.a.mtime || 0) > (x.b.mtime || 0) ? 'replace' : 'keepBoth');
  rows.forEach((x) => choice.set(x, smart(x)));
  const OPTS = [['replace', 'Replace'], ['skip', 'Skip'], ['keepBoth', 'Keep both'], ['newer', 'Keep newer']];
  const { modal } = await import('./dialogs.js');
  const { fmtDate } = await import('./core.js');
  const list = h('div', { class: 'bc-list' });
  const draw = () => {
    list.innerHTML = '';
    for (const x of rows) {
      const sel = h('select', { class: 'input sm' }, ...OPTS.map(([v, l]) => h('option', { value: v }, l)));
      sel.value = choice.get(x); sel.onchange = () => choice.set(x, sel.value);
      const newer = (x.a.mtime || 0) > (x.b.mtime || 0) + 2000 ? 'a' : (x.b.mtime || 0) > (x.a.mtime || 0) + 2000 ? 'b' : '';
      list.append(h('div', { class: 'bc-row' }, h('span', { class: 'bc-n', title: x.src }, basename(x.src)),
        h('span', { class: 'bc-m' + (newer === 'a' ? ' newer' : '') }, `${fmtSize(x.a.size || 0)} · ${fmtDate(x.a.mtime)}`),
        h('span', { class: 'bc-m' + (newer === 'b' ? ' newer' : '') }, same(x) ? 'identical' : `${fmtSize(x.b.size || 0)} · ${fmtDate(x.b.mtime)}`), sel));
    }
  };
  draw();
  const all = (v) => { rows.forEach((x) => choice.set(x, v)); draw(); };
  const ok = await modal({ title: `${clashes.length} files already exist in “${basename(dest) || dest}”`, width: 760, body: h('div', { class: 'stack' },
    h('div', { class: 'row-inline wrap' }, h('span', { class: 'hint' }, 'For all:'), ...OPTS.map(([v, l]) => h('button', { class: 'chip', onclick: () => all(v) }, l)), h('button', { class: 'chip on', title: 'Skip identical files, replace older ones, keep both when the one already there is newer', onclick: () => { rows.forEach((x) => choice.set(x, smart(x))); draw(); } }, 'Smart')),
    h('div', { class: 'bc-row bc-h' }, h('span', {}, 'Name'), h('span', {}, mode === 'move' ? 'Moving in' : 'Copying in'), h('span', {}, 'Already there'), h('span', {}, 'Do')), list,
    h('div', { class: 'hint' }, `${paths.length - clashes.length === 1 ? '1 other item has' : `${paths.length - clashes.length} other items have`} no clash and go${paths.length - clashes.length === 1 ? 'es' : ''} straight in. Newer dates are highlighted.`)),
    buttons: [{ label: 'Cancel', value: null }, { label: mode === 'move' ? 'Move' : 'Copy', primary: true, value: true }] });
  if (!ok) return null;
  const map = {};
  for (const x of rows) map[low(x.dst)] = choice.get(x);
  return map;
}

export async function transfer(paths, dest, mode, opts = {}) {
  paths = paths.filter(Boolean);
  if (paths.length && dest && (isMtp(dest) || paths.some(isMtp))) return mtpTransfer(paths, dest, mode);
  if (paths.length && dest && (isRemote(dest) || paths.some(isRemote))) return remoteTransfer(paths, dest, mode);
  if (paths.length && arcOf(dest)) return addToArchive(paths, arcOf(dest).arc, arcOf(dest).inner);
  if (!paths.length || !dest || isVirtual(dest)) return;
  if (mode === 'move' && !opts.noLinkCheck && paths.some((p) => !samePath(dirname(p), dest)) && !(await (await import('./links.js')).linkGuard(paths, 'move'))) return;
  bus.emit('transferStarted', { paths, dest, mode });
  // several name clashes: review them all at once and pick a rule, instead of one question per file
  if (!opts.conflict && !opts.conflictMap && paths.length > 1) {
    const r = await reviewConflicts(paths, dest, mode);
    if (r === null) return;
    if (r) opts = { ...opts, conflictMap: r };
  }
  const j = await runJob({ type: mode, sources: paths, dest, opts });
  if (mode === 'move') for (const [a, b] of j.undo?.pairs || []) moveTags(a, b);
  if (j.status === 'done') {
    // select pasted items in panes showing dest
    for (let i = 0; i < paneCount(); i++) {
      const t = paneTab(i);
      if (t && samePath(t.path, dest)) {
        const names = new Set((j.undo?.paths || (j.undo?.pairs || []).map((p) => p[1]) || []).map((p) => p));
        if (names.size) { await loadTab(t, { soft: true }); t.sel = new Set([...names].map(normalize)); t.focus = [...t.sel][0]; renderTabPanes(t, true); }
      }
    }
  }
  return j;
}

// ======================================================================
// Clipboard
// ======================================================================
export async function copy(items, cut = false) {
  items = copyable(items);
  if (!items.length) return NO_SEL();
  state.clipboard = { paths: items.map((i) => i.path), cut, at: Date.now() };
  bus.emit('copied', { paths: state.clipboard.paths, cut });
  if (!items.some((i) => i.mtp)) await api('clip:writeFiles', state.clipboard.paths, cut);
  for (let i = 0; i < paneCount(); i++) renderTabPanes(paneTab(i), true);
  toast(`${cut ? 'Cut' : 'Copied'} ${items.length === 1 ? `"${items[0].name}"` : `${items.length} items`}`);
}

export async function paste(t = activeTab(), { target = null, asShortcut = false } = {}) {
  const dest = target || t.path;
  const intoArc = arcOf(dest);
  if (intoArc) {
    let c = state.clipboard; const ext2 = await api('clip:readFiles');
    if (ext2.paths.length && (!c || ext2.paths.join('|') !== c.paths.join('|'))) c = { paths: ext2.paths };
    if (!c?.paths?.length) return toast('Nothing to paste');
    return addToArchive(c.paths, intoArc.arc, intoArc.inner);
  }
  if (!dest || (isVirtual(dest) && !isMtp(dest))) return toast("Can't paste here");
  // prefer the Windows clipboard if it changed since our own copy (so pasting from Explorer/other apps works)
  let clip = state.clipboard;
  const ext = clip && clip.paths.some(isMtp) ? { paths: [] } : await api('clip:readFiles');
  if (ext.paths.length && (!clip || ext.paths.join('|') !== clip.paths.join('|'))) clip = { paths: ext.paths, cut: ext.cut };
  if (clip && clip.paths.length) {
    if (asShortcut) return createShortcuts(clip.paths, dest);
    const j = await transfer(clip.paths, dest, clip.cut ? 'move' : 'copy');
    if (clip.cut && j?.status === 'done') { state.clipboard = null; api('clip:writeText', ''); }
    return;
  }
  // image on the clipboard -> save PNG; text -> save .txt (Files-app style)
  if (await api('clip:hasImage')) {
    const name = await api('fs:uniqueName', dest, `Pasted image ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`, 'number');
    if (await api('fs:writeImage', name)) { pushUndo({ type: 'created', paths: [name] }, 'Paste image'); await afterCreate(t, name); toast('Saved image from clipboard'); }
    return;
  }
  const text = await api('clip:readText');
  if (text) { await saveDroppedText(dest, text); return; }
  toast('Clipboard is empty');
}

export async function saveDroppedText(dir, text) {
  const isUrl = /^https?:\/\/\S+$/.test(text.trim());
  const name = await api('fs:uniqueName', dir, isUrl ? 'Link.url' : 'Pasted text.txt', 'number');
  await api('fs:newFile', name, isUrl ? `[InternetShortcut]\r\nURL=${text.trim()}\r\n` : text);
  pushUndo({ type: 'created', paths: [name] }, 'Paste text');
  const t = activeTab();
  if (samePath(t.path, dir)) await afterCreate(t, name);
}

export async function copyPaths(items, mode = 'path') {
  items = items.length ? items : [{ path: activeTab().path, name: basename(activeTab().path) }];
  const text = items.map((i) => (mode === 'name' ? i.name : mode === 'quoted' ? `"${i.path}"` : mode === 'unix' ? i.path.replace(/\\/g, '/') : mode === 'uri' ? 'file:///' + encodeURI(i.path.replace(/\\/g, '/')) : mode === 'dir' ? dirname(i.path) : i.path)).join('\r\n');
  await api('clip:writeText', text);
  toast(items.length === 1 ? `Copied ${mode === 'name' ? 'name' : 'path'}` : `Copied ${items.length} ${mode === 'name' ? 'names' : 'paths'}`);
}

export async function copyContents(it) {
  const r = await api('fs:readText', it.path, 4 * 1024 * 1024);
  if (r.binary) return toast("That's a binary file", { error: true });
  await api('clip:writeText', r.text);
  toast('Copied file contents');
}

// ======================================================================
// Delete / restore
// ======================================================================
const cleanErr = errText;
export async function remove(items, permanent = false) {
  if (activeTab().path === 'atlas:recycle') return recycleDelete(items);
  const rem = items.filter((i) => i.remote);
  if (rem.length) {
    if (!(await confirm('Delete from the server?', `Permanently delete <b>${rem.length}</b> item${rem.length > 1 ? 's' : ''} from the server? Servers have no Recycle Bin.`, { ok: 'Delete', danger: true }))) return;
    try { await api('remote:remove', rem[0].remote.id, rem.map((i) => i.remote.path)); toast(`Deleted ${rem.length} from the server`); } catch (e) { toast(cleanErr(e), { error: true }); }
    return loadTab(activeTab(), { soft: true });
  }
  if (items.length && items.every((i) => i.archive)) return deleteFromArchive(items);
  const dev = items.filter((i) => i.mtp);
  if (dev.length) {
    if (!(await confirm('Delete from device?', `Permanently delete <b>${dev.length}</b> item${dev.length > 1 ? 's' : ''} from the device? Devices have no Recycle Bin.`, { ok: 'Delete', danger: true }))) return;
    try { await api('mtp:delete', dev.map((i) => i.path)); } catch (e) { toast(e.message, { error: true }); }
    return loadTab(activeTab(), { soft: true });
  }
  items = realItems(items);
  if (!items.length) return NO_SEL();
  if (!(await (await import('./links.js')).linkGuard(items.map((i) => i.path), 'delete'))) return;
  const forever = !mvActive() && (permanent || !state.settings.deleteToRecycle);
  if (!mvActive() && (forever || state.settings.confirmDelete)) {
    const what = items.length === 1 ? `<b>${h('i', {}, items[0].name).innerHTML}</b>` : `these <b>${items.length}</b> items`;
    const ok = await confirm(forever ? 'Permanently delete?' : 'Move to Recycle Bin?', forever ? `Are you sure you want to permanently delete ${what}? This can't be undone.` : `Move ${what} to the Recycle Bin?`, { ok: forever ? 'Delete' : 'Move to Recycle Bin', danger: forever });
    if (!ok) return;
  }
  const t = activeTab();
  const idx = Math.min(...items.map((i) => t.indexOf.get(i.path) ?? 0));
  const job = await runJob({ type: forever ? 'delete' : 'trash', sources: items.map((i) => i.path) });
  // on a USB stick or network drive there's no Recycle Bin: nothing was deleted; ask before deleting for good
  const nobin = job?.noRecycleBin || [];
  if (nobin.length) {
    const what = nobin.length === 1 ? `<b>${h('i', {}, basename(nobin[0])).innerHTML}</b> is` : `<b>${nobin.length}</b> items are`;
    if (await confirm('No Recycle Bin here', `${what} on a drive without a Recycle Bin (like a USB stick or a network drive), so ${nobin.length === 1 ? 'it' : 'they'} can’t be recycled. Delete permanently instead? This can’t be undone.`, { ok: 'Delete permanently', danger: true })) await runJob({ type: 'delete', sources: nobin });
  }
  // keep a sensible focus after deletion
  await loadTab(t, { soft: true });
  const next = t.shown[Math.min(idx, t.shown.length - 1)];
  if (next) { selectOnly(t, next.path); renderTabPanes(t, true); }
}

// ======================================================================
// Rename
// ======================================================================
export async function renameOne(it, newName) {
  if (it.remote) { try { await api('remote:rename', it.remote.id, it.remote.path, it.remote.path.replace(/[^/]*$/, '') + newName); } catch (e) { toast(cleanErr(e), { error: true }); } return loadTab(activeTab(), { soft: true }); }
  if (it.mtp) { try { await api('mtp:rename', it.path, newName); } catch (e) { toast(e.message, { error: true }); } return loadTab(activeTab(), { soft: true }); }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(newName) && IS_WIN()) return toast('A file name can\'t contain any of: \\ / : * ? " < > |', { error: true });
  if (!state.settings.showExtensions && !it.isDir && it.ext && !newName.includes('.')) newName += '.' + it.name.split('.').pop();
  // features listening for renames may change the new name or stop it
  const H = await import('./hooks.js');
  if (H.hasListeners()) {
    const p = await H.before('beforeRename', { path: it.path, name: it.name, newName });
    if (p.cancel) return toast(p.reason, { error: true });
    newName = p.newName;
  }
  const to = pjoin(dirname(it.path), newName);
  if (to !== it.path && !(await (await import('./links.js')).linkGuard([it.path], 'rename'))) return;
  const oldExt = extname(it.name), newExt = extname(newName);
  if (!it.isDir && oldExt !== newExt) {
    if (!(await confirm('Change extension?', `If you change a file name extension, the file might become unusable.<br><br>Change <b>.${oldExt || '(none)'}</b> to <b>.${newExt || '(none)'}</b>?`))) return;
  }
  try {
    await api('fs:rename', it.path, to);
    moveTags(it.path, to);
    pushUndo({ type: 'renamed', pairs: [[it.path, to]] }, `Rename "${it.name}"`);
    bus.emit('renamedOne', { from: it.path, to, name: newName });
    H.after('afterRename', { from: it.path, to });
    const t = activeTab();
    await loadTab(t, { soft: true });
    selectOnly(t, normalize(to));
    renderTabPanes(t, true);
  } catch (e) { toast(errText(e), { error: true }); }
}

export async function rename(items) {
  if (items.length === 1 && items[0].archive) return renameInArchive(items[0]);
  if (items.length === 1 && items[0].mtp) return startRename(activeTab(), items[0]);
  items = realItems(items);
  if (!items.length) return NO_SEL();
  if (items.length === 1) return startRename(activeTab(), items[0]);
  return batchRename(items);
}

export async function batchRename(items) {
  items = realItems(items);
  if (items.length < 1) return NO_SEL();
  const { renameStudio } = await import('./renamestudio.js');
  await renameStudio(items);
}
// rename many at once (two-phase, so swaps like a->b, b->a work); one undo step
export async function renamePairs(pairs, title) {
  pairs = pairs.filter((p) => p.from !== p.to);
  const H = await import('./hooks.js');
  if (H.hasListeners() && !undoing) {
    const kept = [];
    for (const p of pairs) {
      const r = await H.before('beforeRename', { path: p.from, name: basename(p.from), newName: basename(p.to) });
      if (r.cancel) continue;
      kept.push({ ...p, to: pjoin(dirname(p.to), r.newName) });
    }
    if (kept.length < pairs.length) toast(`${pairs.length - kept.length} rename${pairs.length - kept.length === 1 ? ' was' : 's were'} stopped by a feature`);
    pairs = kept.filter((p) => p.from !== p.to);
  }
  if (!undoing && pairs.length && !(await (await import('./links.js')).linkGuard(pairs.map((p) => p.from), 'rename'))) return [];
  const tmp = pairs.map((p) => [p.from, p.from + '.atlas-' + uid()]);
  const done = [];
  let parked = 0; // how many are under their temporary name
  try {
    for (const [a, b] of tmp) { await api('fs:rename', a, b); parked++; }
    for (let k = 0; k < pairs.length; k++) { await api('fs:rename', tmp[k][1], pairs[k].to); done.push([pairs[k].from, pairs[k].to]); moveTags(pairs[k].from, pairs[k].to); }
  } catch (e) {
    toast(errText(e), { error: true });
    // put back what is still under a temporary name; anything that can't go back is named, not left hidden
    const stuck = [];
    for (let k = done.length; k < parked; k++) await api('fs:rename', tmp[k][1], pairs[k].from).catch(() => stuck.push(tmp[k][1]));
    if (stuck.length) toast(`${stuck.length === 1 ? 'One file' : `${stuck.length} files`} couldn’t get ${stuck.length === 1 ? 'its' : 'their'} name back and ${stuck.length === 1 ? 'is' : 'are'} now called ${stuck.slice(0, 3).map((x) => `“${basename(x)}”`).join(', ')}${stuck.length > 3 ? '…' : ''}. Rename ${stuck.length === 1 ? 'it' : 'them'} back by hand.`, { error: true });
  }
  if (done.length) pushUndo({ type: 'renamed', pairs: done }, title || `Rename ${done.length} items`);
  for (const [from, to] of done) H.after('afterRename', { from, to });
  for (let i = 0; i < paneCount(); i++) { const t = paneTab(i); if (t) await loadTab(t, { soft: true }); }
  toast(`Renamed ${done.length} item${done.length === 1 ? '' : 's'}. Ctrl+Z undoes it.`);
  return done;
}

// ======================================================================
// New items
// ======================================================================
const TEMPLATES = [
  { label: 'Text Document', name: 'New Text Document.txt', icon: 'page' },
  { label: 'Markdown', name: 'README.md', content: '# Title\n\n' },
  { label: 'JSON', name: 'data.json', content: '{\n  \n}\n' },
  { label: 'HTML', name: 'index.html', content: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Untitled</title>\n</head>\n<body>\n\n</body>\n</html>\n' },
  { label: 'CSS', name: 'style.css', content: '' }, { label: 'JavaScript', name: 'script.js', content: '' },
  { label: 'Python', name: 'main.py', content: '#!/usr/bin/env python3\n\n' },
  { label: 'PowerShell script', name: 'script.ps1', content: '' }, { label: 'Batch file', name: 'script.bat', content: '@echo off\r\n' },
  { label: 'CSV', name: 'table.csv', content: 'Column A,Column B\n' },
  { label: 'Internet shortcut', name: 'Link.url', content: '[InternetShortcut]\r\nURL=https://\r\n' },
  { label: '.gitignore', name: '.gitignore', content: 'node_modules/\n.DS_Store\n' },
  { label: '.editorconfig', name: '.editorconfig', content: 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n' },
];
export function templates() { return [...TEMPLATES, ...(state.settings.userTemplates || [])]; }

async function afterCreate(t, p, rename = true) {
  await loadTab(t, { soft: true });
  const np = normalize(p);
  selectOnly(t, np);
  t._scrollToFocus = true;
  renderTabPanes(t, true);
  if (rename) setTimeout(() => { const it = t.shown[t.indexOf.get(np)]; if (it) startRename(t, it); }, 30);
}

export async function newFolder(t = activeTab(), fromSelection = false) {
  if (isRemote(t.path)) { const n = await prompt('New folder on the server', 'New folder'); if (n) { const { id, path } = remoteParts(t.path); try { await api('remote:mkdir', id, (path.endsWith('/') ? path : path + '/') + n); } catch (e) { toast(cleanErr(e), { error: true }); } loadTab(t, { soft: true }); } return; }
  if (isMtp(t.path)) { const n = await prompt('New folder on device', 'New folder'); if (n) { try { await api('mtp:mkdir', t.path, n); } catch (e) { toast(e.message, { error: true }); } loadTab(t, { soft: true }); } return; }
  if (!t.path || isVirtual(t.path)) return toast("Can't create a folder here");
  const p = await api('fs:uniqueName', t.path, 'New folder', 'number');
  await api('fs:mkdir', p);
  pushUndo({ type: 'created', paths: [p] }, 'New folder');
  if (fromSelection) {
    const sel = realItems(selectedItems(t));
    if (sel.length) await transfer(sel.map((i) => i.path), p, 'move');
  }
  await afterCreate(t, p);
}

export async function newFile(t = activeTab(), tpl = TEMPLATES[0]) {
  if (!t.path || isVirtual(t.path)) return toast("Can't create a file here");
  const p = await api('fs:uniqueName', t.path, tpl.name, 'number');
  await api('fs:newFile', p, tpl.content || '');
  pushUndo({ type: 'created', paths: [p] }, `New ${tpl.label}`);
  await afterCreate(t, p);
}

export async function newFileNamed(t = activeTab()) {
  if (!t.path || isVirtual(t.path)) return;
  const name = await prompt('New file', '', { label: 'File name (include an extension, or a path like src/app/index.ts)', placeholder: 'notes.md' });
  if (!name) return;
  const parts = name.split(/[\\/]/).filter(Boolean);
  // only names inside this folder: "." and ".." would lead somewhere else
  if (!parts.length || parts.some((x) => x === '.' || x === '..')) return toast('Use a name inside this folder (no “.” or “..” in the path)', { error: true });
  // Undo removes only what this made: the first folder of the path that didn't exist yet, or else the file itself,
  // never a folder that was already there with other things in it
  let dir = t.path, made = null;
  try {
    for (const part of parts.slice(0, -1)) { dir = pjoin(dir, part); if (!(await api('fs:exists', dir))) { await api('fs:mkdir', dir); made ??= dir; } }
    const p = pjoin(dir, parts[parts.length - 1]);
    if (name.endsWith('/') || name.endsWith('\\')) await api('fs:mkdir', p);
    else await api('fs:newFile', p, '');
    made ??= p;
  } catch (e) {
    toast(errText(e), { error: true });
    // folders it did make stay (they're empty and shown); nothing else to undo
    if (!made) return;
  }
  pushUndo({ type: 'created', paths: [made] }, 'New file');
  await afterCreate(t, pjoin(t.path, parts[0]), false);
}

export async function createShortcuts(paths, dir) {
  const made = [];
  for (const p of paths) {
    const name = await api('fs:uniqueName', dir, `${basename(p)}${IS_WIN() ? ' - Shortcut.lnk' : ''}`, 'number');
    try { await api('fs:shortcut', name, p); made.push(name); } catch (e) { toast(e.message, { error: true }); }
  }
  if (made.length) pushUndo({ type: 'created', paths: made }, 'Create shortcut');
  loadTab(activeTab(), { soft: true });
}

export async function createSymlink(items) {
  const it = realItems(items)[0];
  if (!it) return NO_SEL();
  const dest = await api('dialog:pickFolder', 'Create a link in…');
  if (!dest) return;
  try { const lp = await api('fs:uniqueName', dest, it.name, 'number'); await api('fs:symlink', it.path, lp, it.isDir ? 'junction' : 'file'); pushUndo({ type: 'created', paths: [lp] }, 'Create link'); toast('Link created'); }
  catch (e) { toast(`Couldn't create link: ${e.message} (file symlinks need Developer Mode or admin)`, { error: true }); }
}

// ======================================================================
// Undo / redo
// ======================================================================
export const isPsdFile = (i) => !i.isDir && /^(psd|psb)$/i.test(i.ext || '');

// Self-destruct: the rule (if any) that covers this file, and the menu items for keeping a file from it
const sdFlat = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function sdRuleFor(path) {
  const p = sdFlat(path);
  return (state.sdFolders || []).find((r) => { const f = sdFlat(r.folder); return p.startsWith(f + '/') && (r.subfolders || !p.slice(f.length + 1).includes('/')); });
}
function sdMenu(real, one) {
  const out = [];
  const files = real.filter((i) => !i.isDir && !i.archive && !i.mtp && !i.virtual && sdRuleFor(i.path));
  if (files.length && files.length === real.length) {
    const kept = (i) => sdRuleFor(i.path).keep.some((k) => sdFlat(k) === sdFlat(i.path));
    const all = files.every(kept);
    out.push({ label: all ? 'Allow self-destruct again' : 'Keep from self-destruct', icon: 'clock', run: () => import('./selfdestruct.js').then((m) => m.keepFiles(files.filter((i) => (all ? kept(i) : !kept(i))), !all)) });
  }
  if (one && one.isDir && !one.virtual && !one.archive && !one.mtp && !isVirtual(one.path)) out.push({ label: 'Self-destruct this folder…', icon: 'clock', run: () => import('./selfdestruct.js').then((m) => m.open(one.path)) });
  return out;
}

// work made of several steps (Tidy up makes folders and moves files into each) is one step in the undo list
let undoGroup = null;
export function beginUndoGroup() { undoGroup = []; }
export function endUndoGroup(title) {
  const steps = undoGroup; undoGroup = null;
  if (!steps?.length) return null;
  const pairs = steps.flatMap((x) => (x.type === 'moved' || x.type === 'renamed' ? x.pairs : []));
  return pushUndo({ type: 'batch', steps, pairs: pairs.length ? pairs : undefined, paths: pairs.length ? undefined : steps.flatMap((x) => x.paths || []) }, title);
}
export function pushUndo(rec, title) {
  if (!rec) return null;
  if ((rec.paths && !rec.paths.length) || (rec.pairs && !rec.pairs.length)) return null;
  if (undoGroup) { undoGroup.push({ ...rec }); return null; }
  const entry = { ...rec, title, at: Date.now() };
  state.undo.push(entry);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  bus.emit('undo');
  bus.emit('historyAdd', entry);
  return entry;
}
/** undo one particular recorded operation (the Undo button on its "done" message), wherever it is in the list */
async function undoEntry(entry) {
  const i = state.undo.lastIndexOf(entry);
  if (i < 0) return toast('That was already undone');
  if (i === state.undo.length - 1) return undo();
  state.undo.splice(i, 1);
  undoing = true;
  try { await reverseRecord(entry); state.redo.push(entry); toast(`Undid: ${entry.title || entry.type}`); } catch (e) { toast(`Undo failed: ${e.message}`, { error: true }); }
  undoing = false;
  bus.emit('undo');
  refreshAffected();
}

// ---- "it's done": every copy, move, delete, extract and zip says so when it finishes ----
// In the window: a short message with Show (the files where they went) and Undo. When Dogfile isn't in front and the
// work took a while: a Windows notification as well, so nobody has to keep checking whether it went through.
const FINISHED_VERB = { copy: 'Copied', move: 'Moved', delete: 'Deleted', trash: 'Moved to the Recycle Bin', mvtrash: 'Moved to the Multiverse trash', extract: 'Extracted', compress: 'Zipped', convert: 'Converted' };
// the message in parts ("Copied" · "40 files" · "7.6 MB" · "to “Backup”" · "3 s"), so each part can be translated
function finishedParts(j) {
  const n = j.filesDone || j.filesTotal || j.sourceCount || 0;
  const one = j.title.match(/"(.+)"/)?.[1];
  const what = n === 1 && one ? `“${one}”` : n === 1 ? '1 item' : `${n.toLocaleString()} ${j.type === 'copy' || j.type === 'move' ? 'files' : 'items'}`;
  const secs = ((j.finished || Date.now()) - (j.started || Date.now())) / 1000;
  return [
    FINISHED_VERB[j.type],
    what,
    (j.type === 'copy' || j.type === 'move') && j.total > 0 ? fmtSize(j.total) : '',
    j.destLabel || (j.dest && (j.type === 'copy' || j.type === 'move' || j.type === 'extract') ? `to “${basename(j.dest) || j.dest}”` : ''),
    secs >= 2 ? (secs < 60 ? `${Math.round(secs)} s` : `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`) : '',
    j.errors?.length ? (j.errors.length === 1 ? '1 problem' : `${j.errors.length} problems`) : '',
  ].filter(Boolean);
}
// many jobs finishing together (Tidy up moves files into a dozen folders) are one message, not a pile of them
const finishedQueue = [];
let finishedTimer = null;
function confirmFinished(j, entry) {
  if (j.status !== 'done' || !FINISHED_VERB[j.type] || j.client || j.quiet) return;
  finishedQueue.push({ j, entry });
  clearTimeout(finishedTimer);
  finishedTimer = setTimeout(flushFinished, 600);
}
function flushFinished() {
  const byType = new Map();
  for (const it of finishedQueue.splice(0)) byType.set(it.j.type, [...(byType.get(it.j.type) || []), it]);
  for (const group of byType.values()) {
    if (group.length === 1) { announceFinished(group[0].j, [group[0].entry].filter(Boolean)); continue; }
    const js = group.map((g) => g.j), dests = [...new Set(js.map((x) => x.dest).filter(Boolean))];
    announceFinished({
      type: js[0].type, status: 'done', title: '',
      filesDone: js.reduce((a, x) => a + (x.filesDone || x.filesTotal || x.sourceCount || 0), 0),
      total: js.reduce((a, x) => a + (x.total || 0), 0),
      dest: dests.length === 1 ? dests[0] : null,
      destLabel: dests.length > 1 && ['copy', 'move', 'extract'].includes(js[0].type) ? `to ${dests.length} folders` : '',
      started: Math.min(...js.map((x) => x.started || Date.now())), finished: Math.max(...js.map((x) => x.finished || Date.now())),
      errors: js.flatMap((x) => x.errors || []),
      undo: js[0].undo,
    }, group.map((g) => g.entry).filter(Boolean));
  }
}
function announceFinished(j, entries) {
  const parts = finishedParts(j);
  const problems = j.errors?.length || 0;
  const shown = j.undo?.paths || (j.undo?.pairs || []).map((p) => p[1]);
  const actions = [];
  if (j.dest && !isVirtual(j.dest) && (j.type === 'copy' || j.type === 'move' || j.type === 'extract')) actions.push({ label: 'Show', run: () => { const t = activeTab(); navigate(t, j.dest, { select: shown?.[0] || null }); } });
  if (entries.length) actions.push({ label: entries.length > 1 ? 'Undo all' : 'Undo', run: async () => { for (const e of [...entries].reverse()) await undoEntry(e); } });
  const msg = h('span', {}, h('span', {}, parts[0]), ': ', ...parts.slice(1).flatMap((x, i) => [i ? ' · ' : '', h('span', {}, x)]));
  if (!problems) toast(msg, { ok: true, actions, ms: 6000 });
  // in the background: Windows says so too (only for work that took a while, so quick ones don't nag)
  const secs = ((j.finished || Date.now()) - (j.started || Date.now())) / 1000;
  if ((document.hidden || (secs >= 8 && !document.hasFocus())) && state.settings.notifyFinished !== false) {
    import('./i18n.js').then(({ tr }) => {
      const t = parts.map(tr);
      api('notify:show', { title: `${t[0]}: ${t.slice(1).join(' · ')}`, body: tr(problems ? 'Some files had problems. Open Dogfile to see which.' : 'Done. Click to open the folder.'), path: j.dest && !isVirtual(j.dest) ? j.dest : null }).catch(() => {});
    }).catch(() => {});
  }
}
// put things back the way they were before a recorded operation (used by Undo and by File history)
export async function reverseRecord(r) {
  undoing = true;
  try { await reverseSteps(r); } finally { undoing = false; }
  r.undone = true;
  bus.emit('historyUndone', r);
}
// the work of putting back one recorded operation (a batch puts back its steps, last first)
async function reverseSteps(r) {
  if (r.type === 'batch') { for (const st of [...r.steps].reverse()) await reverseSteps(st); return; }
  if (r.type === 'renamed') { for (const [a, b] of [...r.pairs].reverse()) { await api('fs:rename', b, a); moveTags(b, a); } }
  else if (r.type === 'moved') {
    const failed = [];
    for (const [a, b] of [...r.pairs].reverse()) {
      try { await api('fs:rename', b, a); moveTags(b, a); continue; } catch { /* not a plain rename (another drive, or the name is taken): a full move below */ }
      // another drive, or the old name is taken again: a normal move (which asks about name clashes)
      const j = await runJob({ type: 'move', sources: [b], dest: dirname(a) });
      if (j?.status === 'done' && !j.errors?.length) moveTags(b, a); else failed.push(b);
    }
    if (failed.length) throw new Error(`${failed.length} of ${r.pairs.length} couldn’t go back (${basename(failed[0])}${failed.length > 1 ? '…' : ''})`);
  } else if (r.type === 'created') {
    const j = await runJob({ type: 'trash', sources: r.paths });
    if (j?.status !== 'done' || j.errors?.length) throw new Error(j?.errors?.[0] || j?.error || 'couldn’t remove what was made');
  }
  else if (r.type === 'trashed') {
    const res = await api('recycle:restoreOriginal', r.paths);
    if (res?.problems?.length) throw new Error(`${res.problems.length} of ${r.paths.length} couldn’t go back. ${res.problems[0].split(': ').slice(1).join(': ')}`);
  }
  // photo details: each file gets back the values it had
  else if (r.type === 'metadata') { for (const f of r.files || []) await api('meta:write', [f.path], f.values, {}); }
}

export async function undo() {
  const r = state.undo.pop();
  if (!r) return toast('Nothing to undo');
  undoing = true;
  try {
    await reverseRecord(r);
    undoing = true;
    state.redo.push(r);
    toast(`Undid: ${r.title || r.type}`);
  } catch (e) { toast(`Undo failed: ${e.message}`, { error: true }); }
  undoing = false;
  bus.emit('undo');
  refreshAffected();
}
export async function redo() {
  const r = state.redo.pop();
  if (!r) return toast('Nothing to redo');
  undoing = true;
  try {
    await redoSteps(r);
    state.undo.push(r);
    r.undone = false; bus.emit('historyUndone', r);
    toast(`Redid: ${r.title || r.type}`);
  } catch (e) { toast(`Redo failed: ${e.message}`, { error: true }); }
  undoing = false;
  bus.emit('undo');
  refreshAffected();
}
// the work of doing one recorded operation again (a batch does its steps in order)
async function redoSteps(r) {
  if (r.type === 'batch') { for (const st of r.steps) await redoSteps(st); return; }
  if (r.type === 'renamed') for (const [a, b] of r.pairs) { await api('fs:rename', a, b); moveTags(a, b); }
  else if (r.type === 'moved') for (const [a, b] of r.pairs) { try { await api('fs:rename', a, b); } catch { await runJob({ type: 'move', sources: [a], dest: dirname(b) }); } moveTags(a, b); }
  else if (r.type === 'trashed') { await runJob({ type: 'trash', sources: r.paths }); }
  else if (r.type === 'created') {
    const res = await api('recycle:restoreOriginal', r.paths);
    if (res?.problems?.length) throw new Error(`${res.problems.length} of ${r.paths.length} couldn’t come back. ${res.problems[0].split(': ').slice(1).join(': ')}`);
  }
  // photo details: written again as they were after the edit
  else if (r.type === 'metadata' && r.after && r.paths) await api('meta:write', r.paths, r.after, {});
  // anything else can't be redone: said plainly (not "Redid"), and taken off the list so Redo isn't stuck on it
  else throw new Error(`“${r.title || r.type}” can’t be redone`);
}

// ======================================================================
// Archives
// ======================================================================
let info = null;
export async function sysCaps() { if (!info) info = await api('sys:info'); return info; }

export async function compress(items) {
  items = realItems(items);
  if (!items.length) return NO_SEL();
  const caps = await sysCaps();
  const def = items.length === 1 ? stem(items[0].name) || items[0].name : basename(dirname(items[0].path)) || 'Archive';
  const r = await compressDialog(def, caps.has7z);
  if (!r || !r.name) return;
  const dir = dirname(items[0].path);
  const ext = r.format;
  const out = await api('fs:uniqueName', dir, `${r.name}.${ext}`, 'number');
  const { name: _n, recycleAfter, ...opts } = r;
  const j = await runJob({ type: 'compress', sources: items.map((i) => i.path), dest: dir, opts: { ...opts, output: out } });
  if (j.status === 'done') {
    // the originals go to the Recycle Bin (not deleted for good), so they can still come back
    if (recycleAfter) await runJob({ type: 'trash', sources: items.map((i) => i.path) });
    const t = activeTab(); await loadTab(t, { soft: true });
    const made = j.undo?.paths || [out];
    selectOnly(t, normalize(made[0] || out)); renderTabPanes(t, true);
    if (made.length > 1) toast(`Split into ${made.length} pieces. To open it, open the first one (.001) with all the pieces in one folder.`, { ms: 7000 });
  }
}
export async function compressTo(paths, dir) {
  const out = await api('fs:uniqueName', dir, `${paths.length === 1 ? stem(basename(paths[0])) || basename(paths[0]) : 'Archive'}.zip`, 'number');
  await runJob({ type: 'compress', sources: paths, dest: dir, opts: { output: out, format: 'zip' } });
}
export async function quickZip(items) { items = realItems(items); if (!items.length) return NO_SEL(); await compressTo(items.map((i) => i.path), dirname(items[0].path)); }

export async function extract(items, mode = 'smart') {
  const arcs = realItems(items).filter((i) => KINDS.archive.includes(i.ext));
  const t = activeTab();
  if (!arcs.length) {
    if (t.path.startsWith('atlas:zip|')) return extractAll(t.path.split('|')[1]);
    return toast('Select an archive (.zip, .7z, .rar, .tar …)');
  }
  let dest = dirname(arcs[0].path);
  if (mode === 'choose') { dest = await api('dialog:pickFolder', 'Extract to…'); if (!dest) return; }
  if (mode === 'other') { const o = otherPaneTab(); if (!o || isVirtual(o.path)) return toast('The other pane must show a folder'); dest = o.path; }
  const opts = { smart: mode !== 'folder', toFolder: mode === 'folder' };
  asking.password++;
  try { for (const a of arcs) {
    let j = await runJob({ type: 'extract', sources: [a.path], dest, opts });
    // a protected archive: ask for its password (or keyfile) and try again, until it works or they cancel
    while (j.status === 'error' && /password|encrypted/i.test(`${j.error} ${(j.errors || []).join(' ')}`)) {
      const pw = await archivePasswordDialog(a.path);
      if (!pw) break;
      j = await runJob({ type: 'extract', sources: [a.path], dest, opts: { ...opts, ...pw } });
    }
  } } finally { asking.password--; }
}
// ---------------- archive manager ----------------
export const ARCHIVE_FORMATS = [['zip', 'ZIP'], ['7z', '7Z (best compression)'], ['tar', 'TAR'], ['tar.gz', 'TAR.GZ'], ['tar.xz', 'TAR.XZ'], ['rar', 'RAR (needs WinRAR)']];
export const invalidateArchiveCache = (arc) => { invalidateArchive(arc); };
export const arcOf = (p) => (typeof p === 'string' && p.startsWith('atlas:zip|') ? { arc: p.split('|')[1], inner: p.split('|')[2] || '' } : null);
const arcName = (a) => basename(a);
function afterArchiveChange(arc) { invalidateArchive(arc); refreshAffected(); }
export async function addToArchive(paths, arc, inner = '') {
  paths = paths.filter((p) => p && !isVirtual(p));
  if (!paths.length) return;
  const j = await runJob({ type: 'archiveAdd', sources: paths, dest: arc, opts: { inner } });
  afterArchiveChange(arc);
  if (j.status === 'done') toast(`Added ${paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`} to ${arcName(arc)}${inner ? ` › ${inner}` : ''}`);
  return j;
}
export async function addFilesToArchive(arc, inner = '') {
  const files = await api('dialog:openFiles', { title: `Add to ${arcName(arc)}` });
  if (files.length) addToArchive(files, arc, inner);
}
export async function addToExistingArchive(items) {
  items = realItems(items); if (!items.length) return NO_SEL();
  const f = await api('dialog:openFiles', { title: 'Choose an archive to add to', filters: [{ name: 'Archives', extensions: ['zip', '7z', 'tar', 'wim'] }] });
  if (f[0]) addToArchive(items.map((i) => i.path), f[0]);
}
export async function deleteFromArchive(items) {
  items = items.filter((i) => i.archive);
  if (!items.length) return;
  const arc = items[0].archive.arc;
  const what = items.length === 1 ? `<b>${h('i', {}, items[0].name).innerHTML}</b>` : `<b>${items.length}</b> items`;
  if (!(await confirm('Remove from archive?', `Permanently remove ${what} from <b>${h('i', {}, arcName(arc)).innerHTML}</b>?`, { ok: 'Remove', danger: true }))) return;
  await runJob({ type: 'archiveDelete', sources: [], dest: arc, opts: { entries: items.map((i) => i.archive.entry) } });
  afterArchiveChange(arc);
}
export async function renameInArchive(it) {
  const arc = it.archive.arc;
  const name = await prompt('Rename inside archive', it.name, { label: 'New name', selectStem: !it.isDir, validate: (v) => (!v.trim() ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'A name can’t contain \\ / : * ? " < > |' : null) });
  if (!name || name === it.name) return;
  const dir = it.archive.entry.includes('/') ? it.archive.entry.replace(/\/[^/]*$/, '/') : '';
  await runJob({ type: 'archiveRename', sources: [], dest: arc, opts: { from: it.archive.entry, to: dir + name.trim() } });
  afterArchiveChange(arc);
}
export async function convertArchive(items, format) {
  let arcs = realItems(items).filter((i) => KINDS.archive.includes(i.ext)).map((i) => i.path);
  const t = activeTab();
  if (!arcs.length && arcOf(t.path)) arcs = [arcOf(t.path).arc];
  if (!arcs.length) return toast('Select an archive to convert');
  if (format === 'rar' && !(await api('archive:caps')).rar) return alertBox('RAR needs WinRAR', 'Making .rar files needs WinRAR installed. Dogfile can still open and extract them, and 7z or zip work great for sharing.');
  for (const a of arcs) {
    const base = basename(a).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|txz|tbz2?|[^.]+)$/i, '');
    const out = await api('fs:uniqueName', dirname(a), `${base}.${format}`, 'number');
    const j = await runJob({ type: 'convert', sources: [a], dest: dirname(a), opts: { format, output: out }, title: `Converting “${basename(a)}” to ${format.toUpperCase()}` });
    if (j.status === 'done') toast(`Created ${basename(out)}`, { action: { label: 'Show', run: () => { const tt = activeTab(); navigate(tt, dirname(out), { select: out }); } } });
  }
}
export async function testArchives(items) {
  let arcs = realItems(items).filter((i) => KINDS.archive.includes(i.ext)).map((i) => i.path);
  const t = activeTab();
  if (!arcs.length && arcOf(t.path)) arcs = [arcOf(t.path).arc];
  if (!arcs.length) return toast('Select an archive to test');
  for (const a of arcs) {
    toast(`Testing ${basename(a)}…`, { ms: 1500 });
    const r = await api('archive:test', a);
    toast(`${basename(a)}: ${r.ok ? 'No errors found' : 'Problems found'} (${r.message})`, { error: !r.ok, ms: 6000 });
  }
}
export function convertMenu(items) { return ARCHIVE_FORMATS.map(([f, l]) => ({ label: l, run: () => convertArchive(items, f) })); }

async function extractAll(arc) {
  const dest = await api('dialog:pickFolder', 'Extract to…');
  if (dest) await runJob({ type: 'extract', sources: [arc], dest, opts: { smart: true } });
}

// ======================================================================
// Misc tools
// ======================================================================
export async function properties(items) {
  const t = activeTab();
  if (!items.length) {
    if (isVirtual(t.path)) return;
    const st = await api('fs:stat', t.path);
    items = [{ name: basename(t.path), path: t.path, isDir: true, mtime: st?.mtime, ctime: st?.ctime, atime: st?.atime, ext: '' }];
  }
  if (items.some((i) => i.drive) && IS_WIN()) return api('shell:properties', items.map((i) => i.path));
  items = realItems(items);
  if (!items.length) return;
  await propertiesDialog(items, {
    folderSize,
    refresh: () => loadTab(t, { soft: true }),
    renderThumb: (el, it) => { el.innerHTML = it.isDir ? icon('folder') : icon('page'); if (!it.isDir && kindOf(it) === 'image') el.innerHTML = `<img src="/f/?p=${encodeURIComponent(it.path)}">`; },
  });
}

export function folderSize(p, onProgress, children = false) {
  return new Promise((resolve, __reject) => { (async () => {
    // the instant index already knows every folder's size
    if (!children && !onProgress) { const r = (await api('index:sizes', [p]).catch(() => ({})))[p]; if (r) return resolve({ total: r.size, files: r.files, dirs: null, indexed: true }); }
    const id = await api('work:start', { type: 'size', root: p, children });
    onWorkMsgFor(id, (m) => {
      if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'done' || m.type === 'error') resolve(m.type === 'done' ? m : { total: 0, files: 0, dirs: 0, failed: true });
    });
  })().catch(__reject); });
}

/** "Open terminal here": Dogfile's own terminal, in the folder (windows and administrator shells are separate commands) */
export async function openTerminalHere(dir, t = activeTab()) {
  const target = dir || (selectedItems(t).find((i) => i.isDir && !i.virtual)?.path) || (isVirtual(t.path) ? sys.known.home : t.path);
  const { openTerminalAt } = await import('./extras.js');
  await openTerminalAt(target);
}
/** a separate terminal window (Windows Terminal, PowerShell or Command Prompt), also as administrator */
export async function openTerminal(t = activeTab(), kind, admin) {
  const it = selectedItems(t).find((i) => i.isDir && !i.virtual);
  const dir = it?.path || (isVirtual(t.path) ? sys.known.home : t.path);
  await api('shell:terminal', dir, kind || state.settings.terminal, !!admin);
}

/** "Open in code editor": a program you chose in Settings is used as set. Otherwise files open in Dogfile Notepad
 * (its own editor) and only folders, which Notepad can't open, go to an editor found on this PC (VS Code, Cursor…). */
export async function openInEditor(items, t = activeTab()) {
  const explicit = (state.settings.editor || '').trim();
  const own = !explicit || explicit === 'code';
  let rest = items.length ? items : [{ path: t.path, isDir: true }];
  if (own && state.settings.useAtlasEditor !== false) {
    const files = rest.filter((i) => !i.isDir && !i.virtual).map((i) => i.path);
    if (files.length) { const { openTool } = await import('./apptabs.js'); openTool('editor', files); files.forEach((f) => addRecentFile(f)); }
    rest = rest.filter((i) => i.isDir);
    if (!rest.length) return;
  }
  let cmd = explicit;
  if (own) {
    const found = await api('sys:findEditor').catch(() => null);
    cmd = found ? `"${found.path}"` : '';
  }
  if (!cmd) { toast('No code editor found for folders. Install VS Code, or set one in Settings > Tools > Code editor command.', { error: true }); return; }
  await api('shell:runCommand', `${cmd} ${rest.map((i) => `"${i.path}"`).join(' ')}`, isVirtual(t.path) ? undefined : t.path);
}

export function pin(paths) {
  for (const p of paths) if (!state.pinned.some((x) => samePath(x, p))) state.pinned.push(p);
  saveLibrary(); bus.emit('sidebar'); toast('Pinned to sidebar');
}
export function unpin(p) { state.pinned = state.pinned.filter((x) => !samePath(x, p)); saveLibrary(); bus.emit('sidebar'); }
export const isPinned = (p) => state.pinned.some((x) => samePath(x, p));

export async function runCustomCommand(cmd, t = activeTab()) {
  const sel = selectedItems(t);
  // names go in quoted for the shell that runs them: PowerShell expands $( ) inside "double quotes", so there they
  // go in 'single quotes' (nothing inside is special); cmd reads "double quotes" (Windows names can't contain ")
  const { terminalShell } = await import('./extras.js');
  const sh = cmd.detached ? (IS_WIN() ? 'cmd' : 'sh') : terminalShell();
  const q = sh === 'cmd' ? (s) => `"${s}"` : sh === 'sh' ? (s) => `'${String(s).replace(/'/g, "'\\''")}'` : (s) => `'${String(s).replace(/'/g, "''")}'`;
  const line = cmd.command
    .replace(/\{files\}/g, sel.map((i) => q(i.path)).join(' '))
    .replace(/\{file\}/g, q(sel[0]?.path || ''))
    .replace(/\{names\}/g, sel.map((i) => q(i.name)).join(' '))
    .replace(/\{dir\}/g, q(t.path))
    .replace(/\{other\}/g, q(otherPaneTab()?.path || ''));
  // output goes to the built-in terminal so you can see it (set "detached" on a command to launch it silently)
  if (cmd.detached) await api('shell:runCommand', line, isVirtual(t.path) ? undefined : t.path);
  else bus.emit('runInTerminal', { command: line, cwd: isVirtual(t.path) ? undefined : t.path });
}

// ======================================================================
// Virtual locations
// ======================================================================
const V = (o) => ({ virtual: true, isDir: true, size: null, mtime: 0, ext: '', hidden: false, ...o });

export async function refreshDrives() {
  state.drives = await api('fs:drives').catch(() => []);
  const m = {};
  for (const d of state.drives) if (d.letter) m[d.letter.toUpperCase()] = d.label ? `${d.label} (${d.letter})` : d.name;
  setDriveNames(m);
  bus.emit('drives');
  return state.drives;
}

function knownItems(section) {
  const k = sys.known;
  return [
    ['Desktop', k.desktop, 'desktop'], ['Downloads', k.downloads, 'downloadArrow'], ['Documents', k.documents, 'page'],
    ['Pictures', k.pictures, 'photos'], ['Music', k.music, 'music'], ['Videos', k.videos, 'videos'], ['OneDrive', k.onedrive, 'cloud'],
  ].filter(([, p]) => p).map(([name, path, ic]) => ({ name, path, isDir: true, icon: ic, section, mtime: 0, size: null, ext: '' }));
}

export async function listHome() {
  const items = [];
  for (const p of state.pinned) items.push({ name: basename(p) || p, path: p, isDir: true, section: 'Pinned', mtime: 0, size: null, ext: '', subtitle: dirname(p) || '' });
  if (!state.pinned.length) items.push(...knownItems('Quick access'));
  const drives = state.drives.length ? state.drives : await refreshDrives();
  for (const d of drives) items.push(V({ name: d.name, path: d.path, virtual: d.type === 'portable', section: 'Drives', drive: d }));
  const tags = state.tags.defs.filter((d) => Object.values(state.tags.map).some((ids) => ids.includes(d.id)));
  for (const tg of tags) items.push(V({ name: tg.name, path: 'atlas:tag:' + tg.id, section: 'Tags', icon: 'tag', color: tg.color }));
  const recent = await api('fs:statMany', state.recentFiles.slice(0, 24));
  for (const r of recent) if (r) items.push({ ...r, section: 'Recent files' });
  return items;
}

export async function listThisPC() {
  const drives = await refreshDrives();
  const items = [];
  // Devices and drives first, then network locations, then the user folders
  for (const d of drives.filter((x) => x.type !== 'network')) items.push(V({ name: d.name, path: d.path, virtual: d.type === 'portable', section: 'Devices and drives', drive: d }));
  // no phone yet: a tile next to the drives that sets one up (Wi-Fi or USB), so people know where phones show up
  if (IS_WIN() && !drives.some((x) => x.type === 'portable')) items.push(V({ name: 'Add a phone', path: 'atlas:addphone', virtual: true, isDir: false, section: 'Devices and drives', addPhone: true, drive: { type: 'portable', devType: state.settings.phoneAdb ? 'Not connected right now' : 'Browse your phone here', total: 0, free: 0 } }));
  for (const d of drives.filter((x) => x.type === 'network')) items.push(V({ name: d.name, path: d.path, virtual: false, section: 'Network locations', drive: d }));
  items.push(...knownItems('Folders'));
  return items;
}

export async function listRecent() {
  const win = await api('fs:recentWindows');
  const paths = new Map();
  for (const p of state.recentFiles) paths.set(IS_WIN() ? p.toLowerCase() : p, p);
  for (const p of state.recent.slice(0, 30)) paths.set(IS_WIN() ? p.toLowerCase() : p, p);
  for (const r of win) paths.set(r.target.toLowerCase(), r.target);
  const st = await api('fs:statMany', [...paths.values()].slice(0, 250));
  const times = new Map(win.map((r) => [r.target.toLowerCase(), r.time]));
  return st.filter(Boolean).map((s) => ({ ...s, mtime: times.get(s.path.toLowerCase()) || s.mtime }));
}

export async function listRecycle() {
  if (!IS_WIN()) return [];
  const list = await api('recycle:list');
  return list.map((r) => ({ name: r.name, path: r.path, isDir: !!r.isDir, size: r.size, mtime: Date.parse(r.modified) || 0, ctime: 0, ext: r.isDir ? '' : extname(r.name), recycle: { from: r.from, deleted: Date.parse(r.deleted) || 0 }, hidden: false }));
}

export async function listNetwork() {
  const [mapped, found] = await Promise.all([api('fs:mapped'), api('net:discover').catch(() => [])]);
  const items = [];
  // Computers, media servers, printers and routers found on the network (same list File Explorer shows)
  for (const d of found) {
    const isPc = d.path && d.path.startsWith('\\\\');
    items.push(V({ name: d.name, path: isPc ? d.path : 'atlas:netdev|' + d.name, virtual: !isPc, icon: isPc ? 'computer' : /print/i.test(d.type) ? 'page' : /media/i.test(d.type) ? 'film' : 'network', section: isPc ? 'Computers' : d.type || 'Other devices', subtitle: [d.model, d.ip].filter(Boolean).join(' · ') || d.type || '', netdev: isPc ? null : d }));
  }
  for (const m of mapped) items.push(V({ name: `${m.remote} (${m.letter})`, path: m.letter + '\\', virtual: false, icon: 'network', section: 'Mapped drives' }));
  for (const s of state.settings.networkPlaces || []) items.push(V({ name: s, path: s, virtual: false, icon: 'network', section: 'Saved places' }));
  if (!found.length) items.push(V({ name: 'Nothing found yet', path: 'atlas:netinfo', icon: 'info', section: 'Computers', subtitle: 'Turn on Network discovery in Windows if this stays empty' }));
  return items;
}

export async function listTag(id) {
  const paths = Object.entries(state.tags.map).filter(([, ids]) => ids.includes(id)).map(([p]) => p);
  const st = await api('fs:statMany', paths);
  return st.filter(Boolean);
}

export async function recycleRestore(items) {
  items = items.filter((i) => i.recycle);
  if (!items.length) return;
  const res = await api('recycle:restore', items.map((i) => i.path));
  const bad = res?.problems || [];
  const ok = items.length - bad.length;
  if (bad.length) toast(`${ok ? `Restored ${ok}. ` : ''}${bad.length} couldn’t be restored: ${bad[0].split(': ').slice(1).join(': ')}`, { error: true, ms: 9000 });
  else toast(`Restored ${items.length} item${items.length > 1 ? 's' : ''}`);
  loadTab(activeTab(), { soft: true });
}
async function recycleDelete(items) {
  items = items.filter((i) => i.recycle);
  if (!items.length) return;
  if (!(await confirm('Delete permanently?', `Permanently delete ${items.length} item${items.length > 1 ? 's' : ''} from the Recycle Bin?`, { ok: 'Delete', danger: true }))) return;
  await api('recycle:deleteForever', items.map((i) => i.path));
  loadTab(activeTab(), { soft: true });
}
export async function emptyRecycle() {
  if (!(await confirm('Empty Recycle Bin?', 'All items in the Recycle Bin will be permanently deleted.', { ok: 'Empty Recycle Bin', danger: true }))) return;
  await api('recycle:empty');
  toast('Recycle Bin emptied');
  const t = activeTab(); if (t.path === 'atlas:recycle') loadTab(t);
}

// ======================================================================
// Context menus
// ======================================================================
function tagMenu(paths) {
  return state.tags.defs.map((d) => ({ label: d.name, swatch: d.color, checked: paths.every((p) => tagsOf(p).includes(d.id)), keys: `Alt+${state.tags.defs.indexOf(d) + 1}`, run: () => setTags(paths, d.id, !paths.every((p) => tagsOf(p).includes(d.id))) }))
    .concat([{ separator: true },
      { label: 'Auto-tag…', icon: 'wand', run: () => autoTagDialog(paths) },
      { label: 'Clear tags', run: () => { for (const d of state.tags.defs) setTags(paths, d.id, false); } }]);
}
// Auto-tag: colour tags by a rule you pick now, songs' details from online, or a rule that keeps tagging new files
export async function autoTagDialog(paths) {
  const items = paths.map((p) => ({ path: p, name: basename(p) }));
  const { modal } = await import('./dialogs.js');
  const songs = items.filter((it) => /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma)$/i.test(it.name));
  const tagSel = h('select', { class: 'input' }, ...state.tags.defs.map((d) => h('option', { value: d.id }, d.name)));
  const rule = h('select', { class: 'input' },
    h('option', { value: 'all' }, 'every selected item'),
    h('option', { value: 'images' }, 'pictures'), h('option', { value: 'videos' }, 'videos'), h('option', { value: 'audio' }, 'music'),
    h('option', { value: 'docs' }, 'documents'), h('option', { value: 'big' }, 'files over 100 MB'), h('option', { value: 'old' }, 'files not changed for a year'));
  const body = h('div', { class: 'col', style: { gap: '10px' } },
    h('div', { class: 'hint' }, 'Give a colour tag to the items that match. For folders, everything inside counts.'),
    h('div', { class: 'row-inline' }, h('span', {}, 'Tag'), rule, h('span', {}, 'as'), tagSel),
    songs.length ? h('div', { class: 'hint' }, `${songs.length} song${songs.length > 1 ? 's' : ''} selected: “Song details” looks up artist, album and cover online.`) : null,
    h('div', { class: 'hint' }, 'To keep tagging new files automatically, use “Keep doing this” to make a folder automation.'));
  const v = await modal({ title: 'Auto-tag', width: 520, body, buttons: [
    songs.length ? { label: 'Song details…', value: 'songs' } : null,
    { label: 'Keep doing this…', value: 'rule' }, { label: 'Cancel', value: null }, { label: 'Tag', primary: true, value: 'tag' }].filter(Boolean) });
  if (v === 'songs') return import('./tageditor.js').then((m) => m.openTagEditor(songs.map((s) => s.path)));
  if (v === 'rule') { const dir = paths.length === 1 ? paths[0] : dirname(paths[0]); return import('./rules.js').then((m) => m.automationDialog(dir)); }
  if (v !== 'tag') return;
  const want = rule.value, now = Date.now();
  const test = (it) => {
    const k = kindOf({ ...it, ext: it.ext || extname(it.name || '') });
    if (want === 'all') return true;
    if (want === 'images') return k === 'image'; if (want === 'videos') return k === 'video'; if (want === 'audio') return k === 'audio';
    if (want === 'docs') return ['document', 'pdf', 'text', 'spreadsheet', 'presentation'].includes(k);
    if (want === 'big') return (it.size || 0) > 100 * 1024 * 1024;
    if (want === 'old') return it.mtime && now - it.mtime > 365 * 864e5;
    return false;
  };
  const hits = [];
  for (const p of paths) {
    const st = await api('fs:stat', p).catch(() => null); if (!st) continue;
    if (st.isDir && want !== 'all') {
      const r = await api('fs:list', p).catch(() => ({ items: [] }));
      for (const it of r.items || []) if (!it.isDir && test(it)) hits.push(it.path);
    } else if (want === 'all' || test({ ...st, path: p, name: basename(p), ext: extname(p) })) hits.push(p);
  }
  if (!hits.length) return toast('Nothing matched');
  setTags(hits, tagSel.value, true);
  toast(`Tagged ${hits.length} item${hits.length > 1 ? 's' : ''} ${state.tags.defs.find((d) => d.id === tagSel.value)?.name || ''}`);
}

async function openWithMenu(it) {
  const builtin = [{ label: 'Dogfile Notepad', icon: 'notepad', run: () => openTool('editor', [it.path]) }, isMediaFile(it) && { label: 'Dogfile Player', icon: 'film', run: () => openTool('player', [it.path], { play: true }) }, isImageFile(it) && { label: 'Dogfile Photos', icon: 'image', run: () => openTool('viewer', [it.path]) }, isModelFile(it) && { label: 'Dogfile 3D', icon: 'cube', run: () => openTool('model', [it.path]) }, isOfficeFile(it) && { label: 'Dogfile Office', icon: 'page', run: () => openTool('office', [it.path]) }, { label: 'Windows default app', icon: 'monitor', run: () => api('shell:open', it.path) }, { separator: true }];
  const apps = (state.settings.openWithApps || []).map((a) => ({ label: a.name, icon: 'open', run: () => api('shell:launch', a.command, [it.path]) }));
  const { openWithEntries } = await import('./assoc.js');
  return [...builtin, ...apps, apps.length && { separator: true }, { label: 'Code editor', icon: 'code', run: () => openInEditor([it]) }, IS_WIN() && { label: 'Choose another app…', run: () => api('shell:openWith', it.path) }, { separator: true }, ...openWithEntries(it).filter((x) => !/^Set the Windows default/.test(x.label || ''))];
}

const WIN_DUP_VERBS = /^(open|open with|edit|cut|copy|paste|delete|rename|properties|create shortcut|open in new (window|tab|process)|open file location|open folder location|(un)?pin (to|from) quick access|copy as path|compress to( zip file)?|compress to zip|extract all|extract here|open in (windows )?terminal|open powershell window here|open command window here|send to|run as administrator|open with (visual studio )?code|set as desktop background|play|add to (windows media player|vlc media player's) playlist|show more options|share|preview)$/i;
// Windows' own Share window (send by email, Nearby sharing, Teams, OneDrive…), through the file's Share command
async function shareFile(p) {
  const verbs = await api('shell:verbs', p).catch(() => []);
  const v = verbs.find((x) => /^share$/i.test(x.replace(/&(.)/g, '$1').replace(/\s*(\.\.\.|…)\s*$/, '').trim()));
  if (!v) return toast('Windows doesn’t offer Share for this file');
  api('shell:invokeVerb', p, v).catch((e) => toast(`Couldn’t open Share: ${cleanErr(e)}`, { error: true }));
}
async function windowsVerbsMenu(it) {
  const verbs = await api('shell:verbs', it.path).catch(() => []);
  // only what Dogfile doesn't already offer in its own menu (Open, Cut, Copy, Rename, Properties… are left out)
  const clean = (v) => v.replace(/&(.)/g, '$1').replace(/\s*(\.\.\.|…)\s*$/, '').trim();
  const seen = new Set();
  const list = verbs.filter((v) => { const c = clean(v); const k = c.toLowerCase(); if (!c || seen.has(k) || WIN_DUP_VERBS.test(c)) return false; seen.add(k); return true; });
  if (!list.length) return [{ label: 'Nothing extra from Windows for this item', disabled: true }];
  return list.map((v) => ({ label: clean(v), run: () => api('shell:invokeVerb', it.path, v) }));
}

export function itemsContextMenu(t, items, e) { showMenu(buildItemsMenu(t, items), e.clientX, e.clientY, { kind: 'items' }); }
// Simple mode: power-user entries move into one "More options" submenu so menus stay short
const ADVANCED_LABELS = /^(Open in other pane|Open in new window|Copy to other pane|Move to other pane|Delete permanently|Windows menu|Run as administrator|Run in terminal|Paste shortcut|Open terminal as administrator|Open in code editor|Select by pattern|Show in Windows Explorer|Archive|Compare these two files|Detect BPM & key|Pin to sidebar|Unpin from sidebar|Open terminal here)/;
export function simplifyMenu(menu) {
  if (state.settings.uiMode !== 'simple') return menu;
  const keep = [], more = [];
  for (const it of menu.filter(Boolean)) {
    if (it.label && ADVANCED_LABELS.test(it.label)) more.push(it);
    // everyday items in More (Send to phone, Remind me…) stay in sight; the rest folds away
    else if (it.label === 'More' && it.submenu && typeof it.submenu !== 'function') { for (const x of it.submenu.filter(Boolean)) (x.simple ? keep : more).push(x); }
    else if (it.label === 'More' && it.submenu) more.push(it);
    else keep.push(it);
  }
  if (!more.length) return keep;
  const at = keep.map((x) => x.label).lastIndexOf('Properties');
  const moreItem = { label: 'More options', icon: 'more', submenu: more.filter(Boolean) };
  if (at > 0) keep.splice(at, 0, moreItem, { separator: true }); else keep.push({ separator: true }, moreItem);
  return keep;
}
// Open several files at once in the built-in apps (they become a queue / playlist / set of tabs)
export function openAllIn(kind, paths, opts = {}) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  if (kind === 'editor') openTool('editor', paths);
  else if (kind === 'player') openTool('player', paths, { play: true, ...opts });
  else if (kind === 'model') openTool('model', paths, opts);
  else if (kind === 'office') openTool('office', paths, opts);
  else openTool('viewer', paths, opts);
  paths.forEach(addRecentFile);
}
export function openAllEntries(paths) {
  const its = paths.map((p) => ({ path: p, name: basename(p), ext: extname(p), isDir: false }));
  const out = [];
  const txt = its.filter((i) => isTextFile(i) && !isImageFile(i)), med = its.filter(isMediaFile), img = its.filter(isImageFile);
  if (txt.length) out.push({ label: txt.length > 1 ? `Open all ${txt.length} in Dogfile Notepad` : 'Open in Dogfile Notepad', icon: 'notepad', run: () => openAllIn('editor', txt.map((i) => i.path)) });
  if (med.length) out.push({ label: med.length > 1 ? `Play all ${med.length} in Dogfile Player` : 'Play in Dogfile Player', icon: 'film', run: () => openAllIn('player', med.map((i) => i.path)) });
  if (img.length) out.push({ label: img.length > 1 ? `View all ${img.length} in Dogfile Photos` : 'View in Dogfile Photos', icon: 'image', run: () => openAllIn('viewer', img.map((i) => i.path)) });
  const mdl = its.filter(isModelFile);
  if (mdl.length) out.push({ label: mdl.length > 1 ? `View all ${mdl.length} in Dogfile 3D` : 'View in Dogfile 3D', icon: 'cube', run: () => openAllIn('model', mdl.map((i) => i.path)) });
  const ofc = its.filter(isOfficeFile);
  if (ofc.length) out.push({ label: ofc.length > 1 ? `Open all ${ofc.length} in Dogfile Office` : 'Open in Dogfile Office', icon: 'page', run: () => openAllIn('office', ofc.map((i) => i.path)) });
  if (ofc.length) out.push({ label: ofc.length > 1 ? 'Open each in a new Office tab' : 'Open in a new Office tab', icon: 'newWindow', run: () => { for (const f of ofc) openTool('office', [f.path], { newTab: true, inTab: true }); ofc.forEach((f) => addRecentFile(f.path)); } });
  return out;
}
export function buildItemsMenu(t, items) {
  const C = (id) => bus.cmd(id);
  // time travel: files that are gone can only come back
  if (t.tt?.at && items.length && items.every((i) => i.tt === 'gone')) {
    return [
      { label: items.length === 1 ? 'Revive' : `Revive ${items.length} items`, icon: 'undo', run: () => import('./timetravel.js').then((m) => m.revive(items)) },
      { label: 'Back to now', icon: 'history', run: () => import('./timetravel.js').then((m) => m.toggleTimeTravel(t)) },
    ];
  }
  if (t.path === 'atlas:recycle') {
    return [
      { label: 'Restore', icon: 'undo', run: () => recycleRestore(items) },
      { label: 'Delete permanently', icon: 'trash', danger: true, run: () => recycleDelete(items) },
      { separator: true }, { label: 'Empty Recycle Bin', icon: 'recycle', run: emptyRecycle },
    ];
  }
  const arcItems = items.filter((i) => i.archive);
  if (arcItems.length && arcItems.length === items.length) {
    const arc = arcItems[0].archive.arc;
    return [
      { label: 'Open', icon: 'open', keys: 'Enter', run: () => openItems(items) },
      { separator: true },
      { label: 'Extract to…', icon: 'extract', run: async () => { const d = await api('dialog:pickFolder', 'Extract to…'); if (!d) return; for (const it of arcItems) await runJob({ type: 'extract', sources: [arc], dest: d, opts: { smart: false, entry: it.archive.entry } }); } },
      { label: 'Extract all…', icon: 'extract', run: () => extractAll(arc) },
      { separator: true },
      { label: 'Add files here…', icon: 'plus', run: () => addFilesToArchive(arc, arcOf(t.path)?.inner || '') },
      arcItems.length === 1 && { label: 'Rename', icon: 'rename', keys: 'F2', run: () => renameInArchive(arcItems[0]) },
      { label: 'Remove from archive', icon: 'trash', keys: 'Del', danger: true, run: () => deleteFromArchive(arcItems) },
      { separator: true },
      { label: 'Convert archive to', icon: 'convert', submenu: convertMenu([]) },
      { label: 'Test archive', icon: 'check', run: () => testArchives([]) },
    ];
  }
  // items from search, collections or the index may arrive without a type: give every one its extension
  // so type-based entries (Run in terminal, Edit tags, Extract…) show the same everywhere
  for (const i of items) if (i && i.ext == null && !i.isDir && i.name) i.ext = extname(i.name);
  const real = realItems(items);
  const one = items.length === 1 ? items[0] : null;
  const allDirs = items.every((i) => i.isDir);
  const anyArchive = real.some((i) => KINDS.archive.includes(i.ext));
  const paths = real.map((i) => i.path);
  const menu = [
    { label: one?.isDir ? 'Open' : 'Open', icon: 'open', keys: 'Enter', run: () => openItems(items) },
    // results gathered from many folders (search, recent, tags, collections): go to where the file lives
    one && !one.virtual && !one.archive && !one.mtp && isVirtual(t.path || '') && t.path !== 'atlas:thispc' && t.path !== 'atlas:home' && { label: 'Show in folder', icon: 'folderOpen', run: () => navigate(t, dirname(one.path), { select: one.path }) },
    allDirs && { label: 'Open in new tab', icon: 'plus', keys: 'Ctrl+Enter', run: () => openInNewTab(items) },
    allDirs && { label: 'Open in other pane', icon: 'split', run: () => openInOtherPane(items) },
    allDirs && { label: 'Open in new window', icon: 'newWindow', run: () => items.forEach((i) => api('win:new', { path: i.path })) },
    one && !one.isDir && { label: 'Open with', icon: 'apps', submenu: () => openWithMenu(one) },
    one && !one.isDir && !one.virtual && !one.archive && !one.recycle && !one.mtp && ![...KINDS.image, ...KINDS.video, ...KINDS.audio, ...KINDS.archive, ...KINDS.model].includes(one.ext) && { label: 'Edit with Dogfile Notepad', icon: 'notepad', run: () => openTool('editor', [one.path]) },
    real.length === 2 && real.every((i) => !i.isDir) && { label: 'Compare these two files', icon: 'compare', run: () => import('./compare.js').then((m) => m.compareFiles(real[0].path, real[1].path)) },
    ...(real.length > 1 || (one && !one.isDir && !isTextFile(one)) ? openAllEntries(real.filter((i) => !i.isDir).map((i) => i.path)).filter((x) => real.length > 1 || !/Notepad/.test(x.label)) : []),
    real.length && real.some((i) => KINDS.audio.includes(i.ext)) && { label: real.filter((i) => KINDS.audio.includes(i.ext)).length > 1 ? 'Edit tags of all…' : 'Edit tags…', icon: 'tag', run: () => import('./tageditor.js').then((m) => m.openTagEditor(real.filter((i) => KINDS.audio.includes(i.ext)).map((i) => i.path))) },
    real.length && real.some((i) => KINDS.audio.includes(i.ext)) && { label: 'Detect BPM & key', icon: 'music', run: () => bus.emit('analyzeAudio', real.filter((i) => KINDS.audio.includes(i.ext)).map((i) => i.path)) },
    one && ['exe', 'msi', 'bat', 'cmd', 'ps1'].includes(one.ext) && IS_WIN() && { label: 'Run as administrator', icon: 'admin', run: () => api('shell:runAs', one.path) },
    one && ['ps1', 'bat', 'cmd', 'py', 'js', 'mjs', 'sh', 'rb'].includes(one.ext) && !one.archive && { label: 'Run in terminal', icon: 'terminal', run: () => import('./extras.js').then((m) => bus.emit('runInTerminal', { command: m.scriptCommand(one.path), cwd: dirname(one.path) })) },
    one?.archive && { label: 'Extract and open', icon: 'extract', run: () => openItems([one]) },
    { separator: true },
    real.length && { label: 'Cut', icon: 'cut', keys: 'Ctrl+X', run: () => copy(items, true) },
    real.length && { label: 'Copy', icon: 'copy', keys: 'Ctrl+C', run: () => copy(items) },
    one?.isDir && !one.virtual && { label: 'Paste into folder', icon: 'paste', run: () => paste(t, { target: one.path }) },
    real.length && { label: 'Copy as path', icon: 'link', keys: 'Ctrl+Shift+C', submenu: [
      { label: 'Full path', run: () => copyPaths(items, 'path') }, { label: 'Quoted path', run: () => copyPaths(items, 'quoted') },
      { label: 'Name', run: () => copyPaths(items, 'name') }, { label: 'Forward slashes', run: () => copyPaths(items, 'unix') },
      { label: 'file:// URI', run: () => copyPaths(items, 'uri') }, { label: 'Parent folder', run: () => copyPaths(items, 'dir') },
      one && !one.isDir && { separator: true }, one && !one.isDir && { label: 'File contents (text)', run: () => copyContents(one) },
    ] },
    paneCount() > 1 && real.length && { label: 'Copy to other pane', icon: 'copy', keys: 'F5', run: () => C('copyToOther') },
    paneCount() > 1 && real.length && { label: 'Move to other pane', icon: 'cut', keys: 'F6', run: () => C('moveToOther') },
    real.length && { label: 'Copy to…', icon: 'copyTo', run: async () => { const d = await api('dialog:pickFolder', 'Copy to'); if (d) transfer(paths, d, 'copy'); } },
    real.length && { label: 'Move to…', icon: 'moveTo', run: async () => { const d = await api('dialog:pickFolder', 'Move to'); if (d) transfer(paths, d, 'move'); } },
    { separator: true },
    real.length && { label: 'Rename', icon: 'rename', keys: 'F2', run: () => rename(items) },
    real.length > 1 && { label: 'Rename Studio…', icon: 'rename', keys: 'Ctrl+Shift+R', run: () => batchRename(items) },
    real.length && { label: 'Delete', icon: 'trash', keys: 'Del', run: () => remove(items) },
    real.length && { label: 'Delete permanently', icon: 'trash', keys: 'Shift+Del', danger: true, run: () => remove(items, true) },
    { separator: true },
    real.length && { label: real.length === 1 ? `Add to “${(real[0].isDir ? real[0].name : stem(real[0].name) || real[0].name)}.zip”` : 'Add to zip', icon: 'zip', run: () => quickZip(items) },
    real.length && { label: 'Archive', icon: 'zip', submenu: [
      { label: 'Add to archive…', icon: 'zip', run: () => compress(items) },
      { label: 'Add to existing archive…', icon: 'plus', run: () => addToExistingArchive(items) },
      anyArchive && { separator: true },
      anyArchive && { label: 'Convert to', icon: 'convert', submenu: convertMenu(items) },
      anyArchive && { label: 'Test archive', icon: 'check', run: () => testArchives(items) },
    ] },
    real.some(isLocked) && { label: 'Unlock…', icon: 'lock', run: () => unlockItems(real.filter(isLocked)) },
    real.some(canLock) && { label: 'Lock with a password…', icon: 'lock', run: () => lockItems(real.filter(canLock)) },
    anyArchive && { label: 'Extract', icon: 'extract', submenu: [
      { label: 'Extract here (smart)', run: () => extract(items) }, { label: 'Extract to folder', run: () => extract(items, 'folder') },
      { label: 'Extract to…', run: () => extract(items, 'choose') }, paneCount() > 1 && { label: 'Extract to other pane', run: () => extract(items, 'other') },
      { label: 'Browse contents', run: () => navigate(t, `atlas:zip|${real.find((i) => KINDS.archive.includes(i.ext)).path}|`) },
    ] },
    one && !one.isDir && t.links?.[one.path] && { label: 'See what’s linked', redDot: !!t.links[one.path].outside, icon: 'pageLinked', run: () => import('./links.js').then((m) => m.showLinks(one)) },
    real.length && { label: 'Tags', icon: 'tag', submenu: tagMenu(paths) },
    allDirs && real.length && { label: isPinned(real[0].path) ? 'Unpin from sidebar' : 'Pin to sidebar', icon: isPinned(real[0]?.path) ? 'unpin' : 'pin', run: () => (isPinned(real[0].path) ? unpin(real[0].path) : pin(paths)) },
    one && !one.isDir && isImageFile(one) && { label: 'Extract image color palette…', icon: 'palette', run: () => import('./utilities.js').then((m) => m.openUtilities('palette', { path: one.path })) },
    ...sdMenu(real, one),
    one && !one.isDir && /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(one.name || '') && !one.archive && !one.mtp && { label: 'Docker Compose', icon: 'stack', submenu: [
      { label: 'Start (up -d)', run: () => import('./devpanels.js').then((m) => m.composeHere('up', dirname(one.path))) },
      { label: 'Stop and remove (down)', run: () => import('./devpanels.js').then((m) => m.composeHere('down', dirname(one.path))) },
      { label: 'Open the Docker tab', run: () => bus.emit('termTab', 'docker') },
    ] },
    one && isPsdFile(one) && !one.archive && !one.mtp && { label: 'Edit layers (Dogfile PSD)', icon: 'stack', run: () => openTool('psd', [one.path], { newTab: true }) },
    one && isPsdFile(one) && !one.archive && !one.mtp && { label: 'Open as a flat picture (Dogfile Photos)', icon: 'image', run: () => openTool('viewer', [one.path], {}) },
    real.length > 1 && real.every((i) => !i.isDir && i.ext === 'pdf' && !i.archive && !i.mtp) && { label: 'Merge PDFs…', icon: 'page', run: () => import('./protools.js').then((m) => m.mergePdfs(paths)) },
    one && !one.isDir && one.ext === 'pdf' && !one.archive && !one.mtp && { label: 'Split PDF pages…', icon: 'scissors', run: () => import('./protools.js').then((m) => m.splitPdf(one.path)) },
    one && !one.isDir && isImageFile(one) && !one.archive && !one.mtp && !isVirtual(dirname(one.path)) && { label: 'Set as folder icon', icon: 'image', run: () => import('./foldericon.js').then((m) => m.setFolderIcon(dirname(one.path), one.path)) },
    one && one.isDir && !one.virtual && !isVirtual(one.path) && { label: 'Reset folder icon', icon: 'folder', run: () => import('./foldericon.js').then((m) => m.resetFolderIcon(one.path)) },
    real.length && { label: 'More', icon: 'more', submenu: [
      !real.some((i) => i.mtp) && { label: 'Send to phone', icon: 'phone', simple: true, run: () => import('./phonelink.js').then((m) => m.sendToPhone(paths)) },
      { label: 'Add to Drop Shelf', icon: 'shelf', run: () => bus.emit('addToShelf', paths) },
      allDirs && { label: 'Flatten (show all files inside)', icon: 'flatten', run: () => bus.cmd('flattenSel') },
      IS_WIN() && { label: 'What’s locking this?', icon: 'lock', run: () => bus.emit('whoLocks', paths) },
      { label: 'New folder with selection', icon: 'newFolder', run: () => newFolder(t, true) },
      { label: 'Create shortcut', icon: 'link', run: () => createShortcuts(paths, dirname(paths[0])) },
      { label: 'Create symbolic link / junction…', icon: 'link', run: () => createSymlink(items) },
      { label: 'Open in code editor', icon: 'code', run: () => openInEditor(items) },
      allDirs && { label: 'Open terminal here', icon: 'terminal', run: () => openTerminalHere(real[0].path) },
      { label: 'Calculate size', icon: 'chart', run: () => C('analyzeSelection') },
      one && !one.isDir && /^(pdf|jpe?g|png|heic|heif|webp|tiff?|bmp|docx|odt|txt|rtf)$/i.test(one.ext || '') && { label: 'Remind me before it’s due or expires…', icon: 'bell', simple: true, run: () => import('./reminders.js').then((m) => m.remindAbout(one)) },
      one && { label: 'Versions…', icon: 'history', run: () => import('./history.js').then((m) => m.versionsDialog(one.path)) },
      { label: 'Create checksum file…', icon: 'shieldCheck', run: () => import('./history.js').then((m) => m.createChecksums(real)) },
      one && /\.(sha256|sha1|md5)$/i.test(one.name) && { label: 'Verify checksums', icon: 'shieldCheck', run: () => import('./history.js').then((m) => m.verifyChecksums(one.path)) },
      one && !one.isDir && { label: 'Compute hashes', icon: 'hash', run: () => properties([one]) },
      real.some((i) => KINDS.video.includes(i.ext) || ['mkv', 'm2ts', 'ts'].includes(i.ext)) && { label: 'Make contact sheet', icon: 'viewGrid', run: () => import('./gallery.js').then((m) => m.contactSheets(real)) },
      one && !one.isDir && KINDS.image.includes(one.ext) && IS_WIN() && { label: 'Set as desktop background', icon: 'desktop', run: () => import('./mediatools.js').then((m) => m.setWallpaper(one.path)) },
      one && !one.isDir && IS_WIN() && !isVirtual(one.path) && { label: 'Share…', icon: 'share', run: () => shareFile(one.path) },
      real.some((i) => !i.isDir && /^(jpe?g|jfif|png|heic|heif|tiff?|webp|avif|jxl|dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|orf|raf|rw2|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|rwl|iiq|psd|gif)$/i.test(i.ext || '')) && { label: 'Edit photo details…', icon: 'camera', run: () => import('./metadata.js').then((m) => m.editPhotoDetails(real)) },
      real.some((i) => !i.isDir && /^(jpe?g|jfif|png|heic|heif|tiff?|webp|dng|cr2|cr3|nef|arw|orf|raf|rw2)$/i.test(i.ext || '')) && { label: 'Remove location from photos', icon: 'globe', run: () => import('./metadata.js').then((m) => m.removeLocation(real)) },
      real.some((i) => !i.isDir && /^(jpe?g|jfif|png|heic|heif|tiff?|webp|dng|cr2|cr3|nef|arw|orf|raf|rw2)$/i.test(i.ext || '')) && { label: 'Remove all hidden photo details (EXIF)…', icon: 'broom', run: () => import('./metadata.js').then((m) => m.removeAllDetails(real)) },
      IS_WIN() && real.some((i) => !i.isDir) && { label: 'Hidden streams…', icon: 'stack', run: () => import('./metadata.js').then((m) => m.streamsDialog(real)) },
      { label: 'Show in Windows Explorer', icon: 'folder', run: () => api('shell:showInExplorer', paths[0], true), hidden: !IS_WIN() },
      ...(state.settings.customCommands || []).map((c) => ({ label: c.name, icon: 'command', run: () => runCustomCommand(c, t) })),
    ] },
    real.length && featureMenuItems(real).length && { label: 'Features', icon: 'puzzle', submenu: featureMenuItems(real) },
    one && IS_WIN() && !one.virtual && !one.archive && { label: 'Windows menu', icon: 'hamburger', title: 'Extra commands other apps added to Windows (7-Zip, antivirus, Print…)', submenu: () => windowsVerbsMenu(one) },
    { separator: true },
    { label: 'Properties', icon: 'info', keys: 'Alt+Enter', run: () => properties(items) },
  ];
  // drives
  if (one?.drive) {
    menu.splice(1, 0, { label: 'Open in new tab', icon: 'plus', run: () => openInNewTab(items) });
    if (one.drive.type === 'removable' || one.drive.type === 'optical') menu.push({ label: 'Eject', icon: 'eject', run: async () => { await api('fs:eject', one.drive.letter); toast('Safe to remove'); refreshDrives(); } });
  }
  return simplifyMenu(menu);
}

export function backgroundContextMenu(t, e) { showMenu(buildBackgroundMenu(t, e), e.clientX, e.clientY, { kind: 'background' }); }
export function buildBackgroundMenu(t, e = { clientX: 0, clientY: 0 }) {
  const C = (id) => bus.cmd(id);
  const real = !isVirtual(t.path);
  const vtog = (label, view) => ({ label, radio: true, selected: t.view === view, run: () => import('./pane.js').then((m) => m.setView(t, view)) });
  return (simplifyMenu([
    { label: 'View', icon: 'viewGrid', submenu: [vtog('Details', 'details'), vtog('Columns', 'columns'), vtog('Grid', 'grid'), vtog('Gallery', 'gallery'), vtog('List', 'list')] },
    { label: 'Sort by', icon: 'sort', run: (ev) => bus.emit('openSortMenu', { t, x: e.clientX, y: e.clientY }) },
    { label: 'Refresh', icon: 'refresh', keys: 'F5', run: () => { clearThumbCache(); loadTab(t); } },
    { separator: true },
    real && { label: 'Paste', icon: 'paste', keys: 'Ctrl+V', run: () => paste(t) },
    real && { label: 'Paste shortcut', icon: 'link', run: () => paste(t, { asShortcut: true }) },
    state.undo.length && { label: `Undo ${state.undo[state.undo.length - 1].title || ''}`, icon: 'undo', keys: 'Ctrl+Z', run: undo },
    { separator: true },
    real && { label: 'New', icon: 'plus', submenu: [
      { label: 'Folder', icon: 'newFolder', keys: 'Ctrl+Shift+N', run: () => newFolder(t) },
      { label: 'File…', icon: 'newFile', keys: 'Ctrl+Alt+N', run: () => newFileNamed(t) },
      { label: 'Exact-size blank file…', icon: 'newFile', run: () => import('./utilities.js').then((m) => m.openUtilities('blank', { folder: t.path })) },
      { separator: true },
      ...templates().map((tp) => ({ label: tp.label, icon: 'page', run: () => newFile(t, tp) })),
    ] },
    real && { label: 'Organize', icon: 'wand', submenu: [
      { label: 'Tidy up this folder…', icon: 'wand', run: () => import('./declutter.js').then((m) => m.declutter(t)) },
      { label: (state.settings.automations || []).some((a) => a.folder === t.path) ? 'Edit this folder’s automation…' : 'Automate this folder…', icon: 'automation', run: () => import('./rules.js').then((m) => m.automationDialog(t.path)) },
      { label: 'Clean up storage here…', icon: 'broom', run: () => import('./cleanup.js').then((m) => m.openCleanup(t.path)) },
      { label: 'Create a smart collection…', icon: 'collection', run: () => bus.emit('newCollection') },
    ] },
    real && { label: isPinned(t.path) ? 'Unpin from sidebar' : 'Pin to sidebar', icon: 'pin', run: () => (isPinned(t.path) ? unpin(t.path) : pin([t.path])) },
    real && { label: (t.items || []).some((i) => i.name === '.folder.md') ? 'Edit folder note' : 'Add folder note', icon: 'note', run: () => bus.emit('addFolderNote', t) },
    t.path === 'atlas:recycle' && { label: 'Empty Recycle Bin', icon: 'recycle', run: emptyRecycle },
    real && { label: t.tt ? 'Close time travel' : 'Time travel (this folder before)', icon: 'history', run: () => C('timeTravel') },
    { separator: true },
    real && { label: 'Search in this folder', icon: 'search', keys: 'Ctrl+Shift+F', run: () => C('search') },
    real && { label: 'Open terminal here', icon: 'terminal', keys: 'Ctrl+`', run: () => openTerminalHere(isVirtual(t.path) ? undefined : t.path, t) },
    real && IS_WIN() && { label: 'Open terminal as administrator', icon: 'admin', run: () => openTerminal(t, null, true) },
    real && { label: 'Open in code editor', icon: 'code', run: () => openInEditor([], t) },
    { separator: true },
    { label: 'Select all', icon: 'selectAll', keys: 'Ctrl+A', run: () => C('selectAll') },
    { label: 'Select by pattern…', icon: 'filter', keys: 'Ctrl+Shift+A', run: () => C('selectPattern') },
    { separator: true },
    real && IS_WIN() && { label: 'Show in Windows Explorer', icon: 'folder', run: () => api('shell:showInExplorer', t.path) },
    real && { label: 'Properties', icon: 'info', run: () => properties([]) },
  ]));
}

export function folderContextMenu(p, e) {
  if (isVirtual(p)) return;
  const t = activeTab();
  showMenu([
    { label: 'Open', icon: 'open', run: () => navigate(t, p) },
    { label: 'Open in new tab', icon: 'plus', run: () => openTab(p, { after: t, background: true }) },
    { label: 'Open in other pane', icon: 'split', run: () => openInOtherPane([{ path: p, isDir: true }]) },
    { label: 'Open in new window', icon: 'newWindow', run: () => api('win:new', { path: p }) },
    { separator: true },
    { label: 'Paste into folder', icon: 'paste', run: () => paste(t, { target: p }) },
    { label: 'Copy path', icon: 'link', run: () => copyPaths([{ path: p, name: basename(p) }]) },
    { label: 'Open terminal here', icon: 'terminal', run: () => openTerminalHere(p) },
    { label: isPinned(p) ? 'Unpin from sidebar' : 'Pin to sidebar', icon: 'pin', run: () => (isPinned(p) ? unpin(p) : pin([p])) },
    { label: 'Tags', icon: 'tag', submenu: tagMenu([p]) },
    { separator: true },
    { label: 'Properties', icon: 'info', run: async () => { const st = await api('fs:stat', p); properties([{ name: basename(p), path: p, isDir: true, mtime: st?.mtime, ctime: st?.ctime, atime: st?.atime, ext: '' }]); } },
  ], e.clientX, e.clientY);
}

// late wiring from search/tools
export let runSearch = async () => {};
export let searchHere = () => {};
export function bindSearch(fns) { runSearch = fns.runSearch; searchHere = fns.searchHere; }
