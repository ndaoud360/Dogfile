// File-operation engine: queued, background copy/move/delete/trash/extract/compress with
// progress, pause/resume, cancel, conflict prompts ("apply to all") and undo records.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { spawn } = require('child_process');
const win = require('./winshell');

let nextId = 1;
const jobs = new Map();
let send = () => {};
let askConflict = async () => ({ action: 'skip' });
let runningCount = 0;
const queue = [];
let settings = { parallel: 2, sequential: false, throttle: 0 };

function init(opts) { send = opts.send; askConflict = opts.askConflict; }
function configure(s) { Object.assign(settings, s || {}); }

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const sameVolume = (a, b) => {
  if (process.platform !== 'win32') return true;
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
};

async function exists(p) { try { await fsp.lstat(p); return true; } catch { return false; } }

async function uniqueName(dir, name, style = 'copy') {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  if (!(await exists(candidate))) return candidate;
  for (let i = 1; i < 10000; i++) {
    const n = style === 'copy' ? (i === 1 ? `${base} - Copy${ext}` : `${base} - Copy (${i})${ext}`) : `${base} (${i + 1})${ext}`;
    candidate = path.join(dir, n);
    if (!(await exists(candidate))) return candidate;
  }
  return candidate;
}

function publicJob(j) {
  return {
    id: j.id, type: j.type, title: j.title, status: j.status, total: j.total, done: j.done, filesTotal: j.filesTotal,
    filesDone: j.filesDone, current: j.current, error: j.error, errors: j.errors.slice(-20), started: j.started,
    speed: j.speed, dest: j.dest, paused: j.paused, locked: (j.locked || []).slice(0, 50), indeterminate: !!j.indeterminate, undo: j.status === 'done' ? j.undo : null,
    finished: j.finished || null, failed: j.failed || [], sourceCount: j.sources.length, canRetry: ['copy', 'move', 'delete', 'trash', 'extract', 'compress'].includes(j.type), queuePos: j.status === 'queued' ? queue.indexOf(j) + 1 : 0,
  };
}

let emitTimer = null;
function emit(j, force) {
  j._dirty = true;
  if (force) { send('ops:update', publicJob(j)); j._dirty = false; return; }
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    for (const jj of jobs.values()) if (jj._dirty) { jj._dirty = false; send('ops:update', publicJob(jj)); }
  }, 120);
}

function start(spec) {
  const j = {
    id: nextId++, type: spec.type, sources: spec.sources || [], dest: spec.dest || null, opts: spec.opts || {},
    status: 'queued', total: 0, done: 0, filesTotal: 0, filesDone: 0, current: '', errors: [], undo: null,
    paused: false, cancelled: false, policy: null, started: Date.now(), speed: 0, title: spec.title || '', spec,
  };
  if (!j.title) {
    const n = j.sources.length;
    const what = n === 1 ? `"${path.basename(j.sources[0])}"` : `${n} items`;
    j.title = {
      copy: `Copying ${what}`, move: `Moving ${what}`, delete: `Deleting ${what}`, trash: `Recycling ${what}`,
      extract: `Extracting ${what}`, compress: `Compressing ${what}`, archiveAdd: `Adding ${what} to ${path.basename(j.dest || '')}`,
      archiveDelete: `Removing from ${path.basename(j.dest || '')}`, archiveRename: `Renaming in ${path.basename(j.dest || '')}`, convert: `Converting ${what}`,
    }[j.type] || j.type;
  }
  jobs.set(j.id, j);
  emit(j, true);
  queue.push(j);
  pump();
  return j.id;
}

// network copies (shares, mapped drives, servers) run one at a time in their own lane so a slow network copy
// never blocks local work and two network copies don't fight over the same connection
let netRunning = 0;
function pump() {
  const limit = settings.sequential ? 1 : Math.max(1, settings.parallel | 0);
  for (let i = 0; i < queue.length;) {
    const j = queue[i];
    if (j.cancelled) { queue.splice(i, 1); continue; }
    const net = !!j.spec?.network && settings.networkQueue !== false;
    if (net && netRunning) { i++; continue; }
    if (!net && runningCount - netRunning >= limit) { i++; continue; }
    queue.splice(i, 1);
    runningCount++; if (net) netRunning++;
    run(j).finally(() => { runningCount--; if (net) netRunning--; pump(); });
  }
}

async function waitIfPaused(j) {
  while (j.paused && !j.cancelled) await new Promise((r) => setTimeout(r, 200));
  if (j.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
}

async function run(j) {
  j.status = 'running'; j.started = Date.now(); emit(j, true);
  try {
    if (j.type === 'copy' || j.type === 'move') await copyMove(j);
    else if (j.type === 'delete') await del(j);
    else if (j.type === 'trash') await trash(j);
    else if (j.type === 'extract') await extract(j);
    else if (j.type === 'compress') await compress(j);
    else if (j.type === 'archiveAdd') await archiveAdd(j);
    else if (j.type === 'archiveDelete') await archiveDelete(j);
    else if (j.type === 'archiveRename') await archiveRename(j);
    else if (j.type === 'convert') await archiveConvert(j);
    j.status = j.cancelled ? 'cancelled' : j.errors.length ? 'done-errors' : 'done';
    if (j.status === 'done-errors') j.status = 'done';
  } catch (e) {
    if (e.cancelled) j.status = 'cancelled';
    else { j.status = 'error'; j.error = e.message; }
  }
  j.current = '';
  j.finished = Date.now();
  // which of the original items had problems (for "Retry failed")
  if (j.errors.length || j.status === 'error' || j.status === 'cancelled') {
    const low = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
    const errs = j.errors.map(low);
    j.failed = j.status === 'error' || j.status === 'cancelled' ? j.sources.slice() : j.sources.filter((s0) => errs.some((e) => e.startsWith(low(s0))));
    if (!j.failed.length && j.errors.length) j.failed = j.sources.slice();
  }
  emit(j, true);
  send('ops:finished', publicJob(j));
}

// ---------- copy / move ----------
async function walk(src, dst, out, j) {
  const st = await fsp.lstat(src);
  if (st.isDirectory()) {
    out.push({ src, dst, dir: true, size: 0, st });
    let entries = [];
    try { entries = await fsp.readdir(src); } catch (e) { j.errors.push(`${src}: ${e.message}`); }
    for (const e of entries) {
      if (j.cancelled) return;
      await walk(path.join(src, e), path.join(dst, e), out, j);
    }
  } else {
    out.push({ src, dst, dir: false, size: st.size, st, link: st.isSymbolicLink() });
    j.total += st.size; j.filesTotal++;
  }
}

async function resolveConflict(j, src, dst) {
  if (j.opts.conflictMap) { const k = process.platform === 'win32' ? dst.toLowerCase() : dst; if (j.opts.conflictMap[k]) return j.opts.conflictMap[k]; }
  if (j.policy) return j.policy;
  if (j.opts.conflict) return j.opts.conflict;
  let srcSt = null, dstSt = null;
  try { srcSt = await fsp.stat(src); } catch {}
  try { dstSt = await fsp.stat(dst); } catch {}
  j.status = 'waiting'; emit(j, true);
  const r = await askConflict({ jobId: j.id, src, dst, srcSize: srcSt?.size, srcMtime: srcSt?.mtimeMs, dstSize: dstSt?.size, dstMtime: dstSt?.mtimeMs, isDir: srcSt?.isDirectory() });
  j.status = 'running'; emit(j, true);
  if (r.action === 'cancel') { j.cancelled = true; throw Object.assign(new Error('Cancelled'), { cancelled: true }); }
  if (r.applyAll) j.policy = r.action;
  return r.action;
}

async function copyFileWithProgress(j, src, dst, size) {
  const big = size > 256 * 1024 * 1024 || settings.throttle > 0;
  if (!big) {
    let last = 0;
    let poll = null;
    if (size > 8 * 1024 * 1024) {
      poll = setInterval(async () => {
        try { const s = await fsp.stat(dst); const d = s.size - last; if (d > 0) { j.done += d; last = s.size; emit(j); } } catch {}
      }, 250);
    }
    try { await fsp.copyFile(src, dst); } finally { if (poll) clearInterval(poll); }
    j.done += size - last;
    return;
  }
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(dst);
    let doneHere = 0, throttled = false;
    const t0 = Date.now();
    const pauseCheck = setInterval(() => {
      if (j.cancelled) { rs.destroy(); ws.destroy(); fsp.rm(dst, { force: true }).finally(() => reject(Object.assign(new Error('Cancelled'), { cancelled: true }))); }
      else if (j.paused && !rs.isPaused()) rs.pause();
      else if (!j.paused && !throttled && rs.isPaused()) rs.resume();
    }, 200);
    rs.on('data', (c) => {
      doneHere += c.length; j.done += c.length; emit(j);
      const lim = settings.throttle * 1024 * 1024; // MB/s speed limit
      if (lim > 0) {
        const ahead = (doneHere / lim) * 1000 - (Date.now() - t0);
        if (ahead > 15) { throttled = true; rs.pause(); setTimeout(() => { throttled = false; if (!j.paused && !j.cancelled) rs.resume(); }, ahead); }
      }
    });
    rs.on('error', (e) => { clearInterval(pauseCheck); reject(e); });
    ws.on('error', (e) => { clearInterval(pauseCheck); reject(e); });
    ws.on('finish', () => { clearInterval(pauseCheck); resolve(); });
    rs.pipe(ws);
  });
}

async function copyMove(j) {
  const isMove = j.type === 'move';
  const dest = j.dest;
  await fsp.mkdir(dest, { recursive: true });
  const created = [];
  const moved = [];
  const plans = [];
  // Plan top-level items
  for (const src of j.sources) {
    if (j.cancelled) break;
    const name = path.basename(src);
    let dst = path.join(dest, name);
    if (isInside(dest, src) && !samePath(path.dirname(src), dest)) { j.errors.push(`Can't put "${name}" inside itself`); continue; }
    if (samePath(src, dst)) {
      if (isMove) continue; // moving onto itself = no-op
      dst = await uniqueName(dest, name, 'copy'); // duplicate in same folder -> "name - Copy"
    }
    plans.push({ src, dst });
  }
  // Fast path for moves on the same volume: rename top-level items
  const slow = [];
  for (const p of plans) {
    if (j.cancelled) break;
    await waitIfPaused(j);
    if (isMove && sameVolume(p.src, p.dst)) {
      let dst = p.dst;
      if (await exists(dst)) {
        const srcIsDir = (await fsp.lstat(p.src)).isDirectory();
        const dstIsDir = (await fsp.lstat(dst)).isDirectory();
        if (srcIsDir && dstIsDir) { slow.push(p); continue; } // merge folders via slow path
        const a = await resolveConflict(j, p.src, dst);
        if (a === 'skip') continue;
        if (a === 'keepBoth') dst = await uniqueName(dest, path.basename(p.src), 'number');
        if (a === 'skipIdentical') { const s1 = await fsp.stat(p.src), s2 = await fsp.stat(dst); if (s1.size === s2.size && Math.abs(s1.mtimeMs - s2.mtimeMs) < 2000) continue; await fsp.rm(dst, { recursive: true, force: true }); }
        if (a === 'replace') await fsp.rm(dst, { recursive: true, force: true });
        if (a === 'newer') { const s1 = await fsp.stat(p.src), s2 = await fsp.stat(dst); if (s1.mtimeMs <= s2.mtimeMs) continue; await fsp.rm(dst, { recursive: true, force: true }); }
      }
      j.current = path.basename(p.src); emit(j);
      try { await fsp.rename(p.src, dst); moved.push([p.src, dst]); j.filesDone++; }
      catch (e) { if (e.code === 'EXDEV') slow.push({ src: p.src, dst }); else j.errors.push(`${p.src}: ${e.message}`); }
    } else slow.push(p);
  }
  if (!slow.length) { j.undo = { type: 'moved', pairs: moved }; return; }

  const entries = [];
  for (const p of slow) { if (j.cancelled) break; try { await walk(p.src, p.dst, entries, j); } catch (e) { j.errors.push(`${p.src}: ${e.message}`); } }
  emit(j, true);
  const skippedDirs = [];
  let lastT = Date.now(), lastDone = 0;
  for (const e of entries) {
    await waitIfPaused(j);
    if (skippedDirs.some((d) => isInside(e.src, d))) continue;
    j.current = path.basename(e.src);
    const now = Date.now();
    if (now - lastT > 700) { j.speed = ((j.done - lastDone) / (now - lastT)) * 1000; lastT = now; lastDone = j.done; }
    emit(j);
    try {
      if (e.dir) {
        if (!(await exists(e.dst))) { await fsp.mkdir(e.dst, { recursive: true }); if (slow.some((p) => p.dst === e.dst)) created.push(e.dst); }
        continue;
      }
      let dst = e.dst;
      if (await exists(dst)) {
        const a = await resolveConflict(j, e.src, dst);
        if (a === 'skip') { j.done += e.size; j.filesDone++; continue; }
        if (a === 'skipIdentical') { const s2 = await fsp.stat(dst); if (s2.size === e.size && Math.abs(s2.mtimeMs - e.st.mtimeMs) < 2000) { j.done += e.size; j.filesDone++; continue; } }
        if (a === 'keepBoth') dst = await uniqueName(path.dirname(dst), path.basename(dst), 'number');
        if (a === 'newer') { const s2 = await fsp.stat(dst); if (e.st.mtimeMs <= s2.mtimeMs) { j.done += e.size; j.filesDone++; continue; } }
        if (a === 'replace' || a === 'newer' || a === 'skipIdentical') { try { await fsp.chmod(dst, 0o666); } catch {} await fsp.rm(dst, { force: true }); }
      }
      if (e.link) {
        const t = await fsp.readlink(e.src);
        await fsp.symlink(t, dst);
      } else {
        await copyFileWithProgress(j, e.src, dst, e.size);
        try { await fsp.utimes(dst, e.st.atime, e.st.mtime); } catch {}
      }
      if (slow.some((p) => p.dst === e.dst)) created.push(dst);
      j.filesDone++;
    } catch (err) {
      if (err.cancelled) throw err;
      j.errors.push(`${e.src}: ${err.message}`);
      if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) (j.locked = j.locked || []).push(e.src);
    }
  }
  // Preserve folder timestamps (after files are written)
  for (const e of entries) if (e.dir) { try { await fsp.utimes(e.dst, e.st.atime, e.st.mtime); } catch {} }
  if (isMove && !j.cancelled) {
    for (const p of slow) {
      const hadErr = j.errors.some((er) => er.startsWith(p.src));
      if (!hadErr) { try { await fsp.rm(p.src, { recursive: true, force: true }); moved.push([p.src, p.dst]); } catch (err) { j.errors.push(`${p.src}: ${err.message}`); } }
    }
    j.undo = { type: 'moved', pairs: moved };
  } else {
    j.undo = { type: 'created', paths: created };
  }
}

// ---------- delete ----------
async function del(j) {
  j.filesTotal = j.sources.length; j.indeterminate = false;
  for (const p of j.sources) {
    await waitIfPaused(j);
    j.current = path.basename(p); emit(j);
    try {
      try { await fsp.rm(p, { recursive: true, force: false, maxRetries: 2 }); }
      catch (e) {
        if (e.code === 'EPERM' || e.code === 'EACCES') { await clearReadonly(p); await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 }); }
        else throw e;
      }
    } catch (e) { j.errors.push(`${p}: ${e.message}`); if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) (j.locked = j.locked || []).push(p); }
    j.filesDone++; emit(j);
  }
}

async function clearReadonly(p) {
  if (process.platform === 'win32') await win.run('attrib.exe', ['-R', p, '/S', '/D']);
  try { await fsp.chmod(p, 0o777); } catch {}
}

async function trash(j) {
  j.filesTotal = j.sources.length;
  const done = [];
  for (const p of j.sources) {
    await waitIfPaused(j);
    j.current = path.basename(p); emit(j);
    try { await shell.trashItem(p); done.push(p); } catch (e) { j.errors.push(`${p}: ${e.message}`); (j.locked = j.locked || []).push(p); }
    j.filesDone++; emit(j);
  }
  j.undo = { type: 'trashed', paths: done };
}

// ---------- archives ----------
// Archive engine: full 7-Zip when installed (adds RAR/ISO/… reading), otherwise the bundled 7za
// (7z, zip, tar, gz, bz2, xz, wim, cab) plus Windows' own tar.exe (libarchive) for reading RAR and others.
const SEVENZIP = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'];
const WINRAR = ['C:\\Program Files\\WinRAR\\Rar.exe', 'C:\\Program Files (x86)\\WinRAR\\Rar.exe'];
let bundled7z;
function findBundled7z() {
  if (bundled7z !== undefined) return bundled7z;
  const exe = process.platform === 'win32' ? '7za.exe' : '7za';
  const { app } = require('electron');
  const c = [process.resourcesPath && path.join(process.resourcesPath, '7zip', exe), path.join(app.getAppPath(), 'vendor', '7zip', process.platform, exe), path.join(app.getAppPath(), '..', 'vendor', '7zip', process.platform, exe)].filter(Boolean);
  bundled7z = c.find((x) => fs.existsSync(x)) || null;
  return bundled7z;
}
function findFull7z() { for (const p of SEVENZIP) if (fs.existsSync(p)) return p; return null; }
function find7z() { return findFull7z() || findBundled7z(); }
function findRar() { for (const p of WINRAR) if (fs.existsSync(p)) return p; return null; }
const BUNDLED_FORMATS = /\.(7z|zip|zipx|jar|tar|gz|tgz|bz2|tbz2?|xz|txz|cab|wim|lzma|z|taz|epub|docx|xlsx|pptx|odt|ods|apk|xpi)$/i;
const isTarball = (f) => /\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?)$/i.test(f);
function sevenFor(file) { const full = findFull7z(); if (full) return full; return BUNDLED_FORMATS.test(file) ? findBundled7z() : null; }
function tarExe() { return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'; }

function spawnTracked(j, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    let lines = 0;
    p.stdout?.on('data', (d) => { const s = d.toString(); lines += (s.match(/\n/g) || []).length; j.filesDone = lines; const m = s.match(/(\d+)%/); if (m) { j.indeterminate = false; j.total = 100; j.done = +m[1]; } const last = s.trim().split(/\r?\n/).pop(); if (last) j.current = last.slice(-80); emit(j); });
    p.stderr?.on('data', (d) => { const s = d.toString(); err += s; lines += (s.match(/\n/g) || []).length; j.filesDone = lines; const last = s.trim().split(/\r?\n/).pop(); if (last && !/^x /.test(last)) j.current = last.replace(/^[ax] /, '').slice(-80); else if (last) j.current = last.slice(2).slice(-80); emit(j); });
    const iv = setInterval(() => { if (j.cancelled) { try { p.kill(); } catch {} } }, 200);
    p.on('error', (e) => { clearInterval(iv); reject(e); });
    p.on('close', (code) => { clearInterval(iv); if (j.cancelled) reject(Object.assign(new Error('Cancelled'), { cancelled: true })); else if (code === 0) resolve(); else reject(new Error(err.trim().split(/\r?\n/).slice(-2).join(' ') || `Exited with code ${code}`)); });
  });
}

async function listArchive(file) {
  // compressed tarballs: list the files inside the tar, not the single .tar inside the .gz
  const z = isTarball(file) ? null : sevenFor(file);
  const run = (cmd, args) => new Promise((resolve) => {
    require('child_process').execFile(cmd, args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (z) {
    const out = await run(z, ['l', '-slt', '-ba', file]);
    if (out != null) {
      const items = [];
      for (const block of out.split(/\r?\n\r?\n/)) {
        const kv = {};
        for (const line of block.split(/\r?\n/)) { const i = line.indexOf(' = '); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 3); }
        if (kv.Path) items.push({ path: kv.Path.replace(/\\/g, '/'), size: +kv.Size || 0, isDir: (kv.Attributes || '').includes('D') || kv.Folder === '+', mtime: kv.Modified ? Date.parse(kv.Modified.replace(' ', 'T')) || 0 : 0 });
      }
      return items;
    }
  }
  const out = await run(tarExe(), ['-tvf', file]);
  if (out == null) throw new Error('Could not read archive (install 7-Zip for more formats)');
  const items = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // bsdtar -tv format: perms links owner group size Mon DD HH:MM name
    // bsdtar (Windows): perms links owner group size Mon DD HH:MM|YYYY name ; GNU tar: perms owner/group size YYYY-MM-DD HH:MM name
    let m = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+(?:\d\d:\d\d|\d{4}))\s(.*)$/);
    let when = 0;
    if (m) { const y = /\d{4}$/.test(m[3]) ? '' : ' ' + new Date().getFullYear(); when = Date.parse(m[3].replace(/\s+/g, ' ') + y) || 0; }
    else { m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s(.*)$/); if (m) when = Date.parse(m[3].replace(' ', 'T')) || 0; }
    if (m) items.push({ path: m[4].replace(/\\/g, '/'), size: +m[2], isDir: m[1].startsWith('d') || m[4].endsWith('/'), mtime: when });
    else items.push({ path: line.trim(), size: 0, isDir: line.trim().endsWith('/'), mtime: 0 });
  }
  return items;
}

async function extract(j) {
  j.indeterminate = true;
  const created = [];
  for (const file of j.sources) {
    await waitIfPaused(j);
    let dest = j.dest;
    if (j.opts.smart !== false) {
      // Smart extract: if the archive has a single root folder, extract straight into dest; otherwise into a folder named after the archive
      let roots = new Set();
      try { for (const it of await listArchive(file)) roots.add(it.path.split('/')[0]); } catch {}
      const base = path.basename(file).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|zip|7z|rar|tar|gz|bz2|xz|cab|iso|zst)$/i, '');
      if (roots.size !== 1 || j.opts.toFolder) { dest = await uniqueName(j.dest, base, 'number'); }
      else { const only = [...roots][0]; if (await exists(path.join(j.dest, only))) dest = await uniqueName(j.dest, base, 'number'); }
    }
    await fsp.mkdir(dest, { recursive: true });
    j.current = path.basename(file); emit(j);
    const member = j.opts.entry ? [j.opts.entry] : [];
    const z = isTarball(file) ? null : sevenFor(file);
    if (z) await spawnTracked(j, z, ['x', '-y', '-bsp1', `-o${dest}`, file, ...member, ...(j.opts.password ? [`-p${j.opts.password}`] : [])]);
    else await spawnTracked(j, tarExe(), ['-xvf', file, '-C', dest, ...member]);
    created.push(dest);
  }
  j.undo = { type: 'created', paths: created.filter((d) => !samePath(d, j.dest)) };
}

async function compress(j) {
  j.indeterminate = true;
  const out = j.opts.output; // full path of archive
  const fmt = (j.opts.format || path.extname(out).slice(1) || 'zip').toLowerCase();
  const parent = path.dirname(j.sources[0]);
  const names = j.sources.map((s) => path.relative(parent, s));
  const z = find7z();
  if (await exists(out)) await fsp.rm(out, { force: true });
  if (z && fmt !== 'tar.gz' && fmt !== 'tgz') {
    const type = { zip: 'zip', '7z': '7z', tar: 'tar', gz: 'gzip', xz: 'xz', wim: 'wim' }[fmt] || 'zip';
    const lvl = j.opts.level != null ? [`-mx=${j.opts.level}`] : [];
    const pw = j.opts.password ? [`-p${j.opts.password}`, ...(type === '7z' ? ['-mhe=on'] : [])] : [];
    await spawnTracked(j, z, ['a', '-bsp1', `-t${type}`, ...lvl, ...pw, out, ...names], { cwd: parent });
  } else {
    const t = tarExe();
    let args;
    if (fmt === 'zip') args = ['-a', '-cvf', out, ...names];
    else if (fmt === '7z') args = ['--format', '7zip', '-cvf', out, ...names];
    else if (fmt === 'tar') args = ['-cvf', out, ...names];
    else if (fmt === 'tar.gz' || fmt === 'tgz') args = ['-czvf', out, ...names];
    else args = ['-a', '-cvf', out, ...names];
    await spawnTracked(j, t, args, { cwd: parent });
  }
  j.undo = { type: 'created', paths: [out] };
}

// ---------- archive manager: add / delete / rename inside, convert, test ----------
const os = require('os');
async function tempDir(tag) { return fsp.mkdtemp(path.join(os.tmpdir(), `atlas-${tag}-`)); }
async function copyTree(src, dst) { await fsp.cp(src, dst, { recursive: true, force: true, errorOnExist: false }); }
function needs7z(file) { if (isTarball(file)) throw new Error('Compressed tarballs (.tar.gz etc.) can’t be changed in place. Convert to zip or 7z first.'); const z = sevenFor(file); if (!z) throw new Error('This archive type can be read but not changed. Install 7-Zip for more formats, or convert it to zip first.'); return z; }

// add files into an archive, optionally inside a folder of it
async function archiveAdd(j) {
  j.indeterminate = true;
  const arc = j.dest, inner = (j.opts.inner || '').replace(/^\/+|\/+$/g, '');
  const z = needs7z(arc);
  if (!inner) {
    const parent = path.dirname(j.sources[0]);
    const sameParent = j.sources.every((s) => path.dirname(s) === parent);
    if (sameParent) { await spawnTracked(j, z, ['a', '-bsp1', '-y', arc, ...j.sources.map((s) => path.relative(parent, s))], { cwd: parent }); return; }
  }
  // stage the files in the folder structure they should have inside the archive
  const tmp = await tempDir('add');
  try {
    const base = inner ? path.join(tmp, ...inner.split('/')) : tmp;
    await fsp.mkdir(base, { recursive: true });
    for (const s of j.sources) { await waitIfPaused(j); j.current = path.basename(s); emit(j); await copyTree(s, path.join(base, path.basename(s))); }
    const top = inner ? [inner.split('/')[0]] : await fsp.readdir(tmp);
    await spawnTracked(j, z, ['a', '-bsp1', '-y', arc, ...top], { cwd: tmp });
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
async function archiveDelete(j) {
  j.indeterminate = true;
  const arc = j.dest;
  const z = needs7z(arc);
  await spawnTracked(j, z, ['d', '-bsp1', '-y', arc, ...j.opts.entries]);
}
async function archiveRename(j) {
  const arc = j.dest;
  const z = needs7z(arc);
  await spawnTracked(j, z, ['rn', '-y', arc, j.opts.from, j.opts.to]);
}
// convert by extracting to a temp folder and packing again in the new format
async function archiveConvert(j) {
  j.indeterminate = true;
  const src = j.sources[0];
  const fmt = j.opts.format;
  const out = j.opts.output;
  const tmp = await tempDir('conv');
  try {
    j.current = 'Unpacking ' + path.basename(src); emit(j);
    const z = isTarball(src) ? null : sevenFor(src);
    if (z) await spawnTracked(j, z, ['x', '-y', '-bsp1', `-o${tmp}`, src, ...(j.opts.password ? [`-p${j.opts.password}`] : [])]);
    else await spawnTracked(j, tarExe(), ['-xf', src, '-C', tmp]);
    const names = await fsp.readdir(tmp);
    if (!names.length) throw new Error('The archive is empty');
    if (await exists(out)) await fsp.rm(out, { force: true });
    j.current = 'Packing ' + path.basename(out); emit(j);
    if (fmt === 'rar') {
      const rar = findRar();
      if (!rar) throw new Error('Creating RAR files needs WinRAR (RAR is a closed format). Choose 7z or zip instead.');
      await spawnTracked(j, rar, ['a', '-r', '-ep1', '-idq', out, ...names.map((n) => path.join(tmp, n))]);
    } else if (fmt === 'tar.gz' || fmt === 'tgz' || fmt === 'tar.xz' || fmt === 'tar.bz2') {
      const z7 = find7z();
      const tarDir = await tempDir('tar');
      const tarTmp = path.join(tarDir, path.basename(out).replace(/\.(tgz)$/i, '.tar').replace(/\.(gz|xz|bz2)$/i, ''));
      if (z7) {
        await spawnTracked(j, z7, ['a', '-bsp1', '-ttar', tarTmp, ...names], { cwd: tmp });
        const t = { 'tar.gz': 'gzip', tgz: 'gzip', 'tar.xz': 'xz', 'tar.bz2': 'bzip2' }[fmt];
        await spawnTracked(j, z7, ['a', '-bsp1', `-t${t}`, out, tarTmp]);
        await fsp.rm(tarDir, { recursive: true, force: true });
      } else await spawnTracked(j, tarExe(), [fmt === 'tar.xz' ? '-cJf' : fmt === 'tar.bz2' ? '-cjf' : '-czf', out, ...names], { cwd: tmp });
    } else {
      const z7 = find7z();
      const type = { zip: 'zip', '7z': '7z', tar: 'tar', wim: 'wim' }[fmt] || 'zip';
      const lvl = j.opts.level != null ? [`-mx=${j.opts.level}`] : [];
      const pw = j.opts.newPassword ? [`-p${j.opts.newPassword}`, ...(type === '7z' ? ['-mhe=on'] : [])] : [];
      if (z7) await spawnTracked(j, z7, ['a', '-bsp1', `-t${type}`, ...lvl, ...pw, out, ...names], { cwd: tmp });
      else await spawnTracked(j, tarExe(), [type === 'zip' ? '-acf' : '-cf', out, ...names], { cwd: tmp });
    }
    if (j.opts.deleteOriginal) await shell.trashItem(src).catch(() => {});
    j.undo = { type: 'created', paths: [out] };
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
function testArchive(file) {
  return new Promise((resolve) => {
    const z = sevenFor(file);
    const [cmd, args] = z ? [z, ['t', file]] : [tarExe(), ['-tf', file]];
    require('child_process').execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      resolve({ ok: !err && !/ERROR|Error/.test(stderr || ''), message: err ? (out.trim().split(/\r?\n/).slice(-3).join(' ') || err.message) : (out.match(/Files: \d+|Everything is Ok/g) || ['OK']).join(' · ') });
    });
  });
}
const archiveCaps = () => ({ full: !!findFull7z(), bundled: !!findBundled7z(), rar: !!findRar() });

function control(id, action) {
  const j = jobs.get(id);
  if (!j) return false;
  if (action === 'pause') j.paused = true;
  else if (action === 'resume') j.paused = false;
  else if (action === 'cancel') { j.cancelled = true; j.paused = false; if (j.status === 'queued') { j.status = 'cancelled'; } }
  else if (action === 'dismiss') { if (!['running', 'queued', 'waiting'].includes(j.status)) jobs.delete(id); }
  else if (action === 'prioritize') { const i = queue.indexOf(j); if (i > 0) { queue.splice(i, 1); queue.unshift(j); for (const q of queue) emit(q); } }
  else if (action === 'retry' || action === 'retryAll') {
    // start again with only what failed (or everything); conflicts are asked again
    const sources = action === 'retry' && j.failed?.length ? j.failed : j.sources;
    const nid = start({ ...j.spec, sources, title: `Retry: ${j.title.replace(/^Retry: /, '')}` });
    jobs.delete(id);
    send('ops:removed', { id });
    return nid;
  }
  emit(j, true);
  return true;
}

function list() { return [...jobs.values()].map(publicJob); }

module.exports = { init, configure, start, control, list, listArchive, uniqueName, find7z, testArchive, archiveCaps };
