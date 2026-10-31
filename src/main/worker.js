// Background worker: recursive search (name / regex / wildcard / content), folder sizes,
// storage breakdown, and duplicate finder. Runs off the main thread so the UI never freezes.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const job = workerData;
let results = [];
let lastPost = Date.now();
let scanned = 0;
const SKIP_DIRS = new Set(['$Recycle.Bin', 'System Volume Information', '$WinREAgent', 'Config.Msi']);

function post(force) {
  const now = Date.now();
  if (!force && results.length < 200 && now - lastPost < 200) return;
  parentPort.postMessage({ type: 'results', items: results, scanned });
  results = [];
  lastPost = now;
}

function wildcardToRegex(w, cs) {
  const parts = w.split(/[;|]/).map((s) => s.trim()).filter(Boolean).map((p) => {
    let r = p.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return p.includes('*') || p.includes('?') ? `^${r}$` : r;
  });
  return new RegExp(parts.join('|') || '.*', cs ? '' : 'i');
}

function buildMatcher(q) {
  if (!q.query) return () => true;
  if (q.regex) { const re = new RegExp(q.query, q.caseSensitive ? '' : 'i'); return (n) => re.test(n); }
  if (/[*?;|]/.test(q.query)) { const re = wildcardToRegex(q.query, q.caseSensitive); return (n) => re.test(n); }
  // Plain words: all words must appear (AND), "-word" excludes
  const words = q.query.split(/\s+/).filter(Boolean);
  const inc = words.filter((w) => !w.startsWith('-')).map((w) => (q.caseSensitive ? w : w.toLowerCase()));
  const exc = words.filter((w) => w.startsWith('-') && w.length > 1).map((w) => (q.caseSensitive ? w.slice(1) : w.slice(1).toLowerCase()));
  return (n) => { const s = q.caseSensitive ? n : n.toLowerCase(); return inc.every((w) => s.includes(w)) && !exc.some((w) => s.includes(w)); };
}

async function contentMatch(file, size, q, re) {
  if (size > (q.maxContentBytes || 50 * 1024 * 1024)) return false;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(Math.min(8192, size));
    await fh.read(head, 0, head.length, 0);
    if (head.includes(0) && !(head[0] === 0xff && head[1] === 0xfe)) return false; // binary
    const buf = await fh.readFile();
    let text = head[0] === 0xff && head[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return re.test(text);
  } catch { return false; } finally { try { await fh?.close(); } catch {} }
}

async function search() {
  const match = buildMatcher(job);
  const cre = job.content ? (job.contentRegex ? new RegExp(job.content, job.caseSensitive ? 'm' : 'im') : new RegExp(job.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), job.caseSensitive ? '' : 'i')) : null;
  let count = 0;
  const max = job.maxResults || 20000;
  const stack = [...job.roots];
  const anyWords = job.anyWords && job.anyWords.length ? job.anyWords.map((w) => w.toLowerCase()) : null;
  const excludeExt = job.excludeExtensions ? new Set(job.excludeExtensions.split(/[,; ]+/).filter(Boolean).map((e) => e.replace(/^\*?\./, '').toLowerCase())) : null;
  const ext = job.extensions ? new Set(job.extensions.split(/[,; ]+/).filter(Boolean).map((e) => e.replace(/^\*?\./, '').toLowerCase())) : null;
  while (stack.length) {
    const dir = stack.pop();
    let dh;
    try { dh = await fsp.opendir(dir); } catch { continue; }
    try {
      for await (const d of dh) {
        scanned++;
        const full = path.join(dir, d.name);
        const isDir = d.isDirectory();
        if (!job.includeHidden && d.name.startsWith('.')) continue;
        if (isDir && !SKIP_DIRS.has(d.name) && !(job.skipDirs || []).includes(d.name) && job.recursive !== false && !d.isSymbolicLink()) stack.push(full);
        if (job.kind === 'file' && isDir) continue;
        if (job.kind === 'dir' && !isDir) continue;
        if (!match(d.name)) continue;
        if (ext && (isDir || !ext.has(path.extname(d.name).slice(1).toLowerCase()))) continue;
        let st = null;
        if (job.minSize != null || job.maxSize != null || job.after || job.before || cre || true) {
          try { st = await fsp.stat(full); } catch { continue; }
        }
        if (!isDir && job.minSize != null && st.size < job.minSize) continue;
        if (!isDir && job.maxSize != null && st.size > job.maxSize) continue;
        if (job.after && st.mtimeMs < job.after) continue;
        if (job.before && st.mtimeMs > job.before) continue;
        if (job.createdAfter && st.birthtimeMs < job.createdAfter) continue;
        if (job.createdBefore && st.birthtimeMs > job.createdBefore) continue;
        if (job.accessedBefore && Math.max(st.atimeMs, st.mtimeMs) > job.accessedBefore) continue;
        if (anyWords && !anyWords.some((w) => d.name.toLowerCase().includes(w))) continue;
        if (excludeExt && excludeExt.has(path.extname(d.name).slice(1).toLowerCase())) continue;
        if (cre && (isDir || !(await contentMatch(full, st.size, job, cre)))) continue;
        results.push({ name: d.name, path: full, isDir, size: isDir ? 0 : st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, atime: st.atimeMs, isLink: d.isSymbolicLink() });
        count++;
        if (count >= max) { post(true); return; }
        post();
      }
    } catch {}
    post();
  }
  post(true);
}

async function dirSize(root, withChildren) {
  let total = 0, files = 0, dirs = 0;
  const children = withChildren ? new Map() : null;
  const stack = [[root, null]];
  let lastProg = Date.now();
  while (stack.length) {
    const [dir, top] = stack.pop();
    let dh;
    try { dh = await fsp.opendir(dir); } catch { continue; }
    try {
      for await (const d of dh) {
        const full = path.join(dir, d.name);
        const t = top || (withChildren ? full : null);
        if (d.isDirectory() && !d.isSymbolicLink()) {
          dirs++;
          if (withChildren && !top) children.set(full, { path: full, name: d.name, isDir: true, size: 0, files: 0 });
          stack.push([full, t]);
        } else if (d.isFile()) {
          let s = 0; try { s = (await fsp.lstat(full)).size; } catch {}
          total += s; files++;
          if (withChildren) {
            if (!top) children.set(full, { path: full, name: d.name, isDir: false, size: s, files: 1 });
            else { const c = children.get(t); if (c) { c.size += s; c.files++; } }
          }
        }
      }
    } catch {}
    if (Date.now() - lastProg > 300) { lastProg = Date.now(); parentPort.postMessage({ type: 'progress', total, files, dirs, current: dir, children: withChildren ? [...children.values()] : undefined }); }
  }
  return { total, files, dirs, children: withChildren ? [...children.values()].sort((a, b) => b.size - a.size) : undefined };
}

async function hashPart(file, bytes) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    const opts = bytes ? { start: 0, end: bytes - 1 } : {};
    const s = fs.createReadStream(file, opts);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', () => resolve(null));
  });
}

async function dupes() {
  const bySize = new Map();
  const stack = [...job.roots];
  const minSize = job.minSize ?? 1;
  while (stack.length) {
    const dir = stack.pop();
    let dh;
    try { dh = await fsp.opendir(dir); } catch { continue; }
    try {
      for await (const d of dh) {
        scanned++;
        const full = path.join(dir, d.name);
        if (d.isDirectory() && !d.isSymbolicLink() && !SKIP_DIRS.has(d.name)) stack.push(full);
        else if (d.isFile()) {
          let st; try { st = await fsp.stat(full); } catch { continue; }
          if (st.size < minSize) continue;
          const arr = bySize.get(st.size) || [];
          arr.push({ path: full, name: d.name, size: st.size, mtime: st.mtimeMs });
          bySize.set(st.size, arr);
        }
      }
    } catch {}
    if (Date.now() - lastPost > 300) { lastPost = Date.now(); parentPort.postMessage({ type: 'progress', phase: 'Scanning', scanned, current: dir }); }
  }
  const groups = [];
  const cands = [...bySize.values()].filter((a) => a.length > 1);
  let i = 0;
  for (const arr of cands) {
    i++;
    const byHead = new Map();
    for (const f of arr) { const h = await hashPart(f.path, 65536); if (!h) continue; const a = byHead.get(h) || []; a.push(f); byHead.set(h, a); }
    for (const a of byHead.values()) {
      if (a.length < 2) continue;
      const byFull = new Map();
      for (const f of a) { const h = a[0].size <= 65536 ? 'same' : await hashPart(f.path); if (!h) continue; const b = byFull.get(h) || []; b.push(f); byFull.set(h, b); }
      for (const b of byFull.values()) if (b.length > 1) groups.push({ size: b[0].size, files: b });
    }
    if (Date.now() - lastPost > 300) { lastPost = Date.now(); parentPort.postMessage({ type: 'progress', phase: 'Comparing', scanned: i, of: cands.length, groups: groups.length }); }
  }
  groups.sort((a, b) => b.size * b.files.length - a.size * a.files.length);
  return groups;
}

// ---------------- storage inventory (cleanup center) ----------------
const CAT = [
  ['Pictures', /^(jpe?g|jfif|png|gif|webp|bmp|tiff?|heic|heif|avif|raw|cr2|cr3|nef|arw|dng|orf|rw2|psd|svg|ico)$/],
  ['Videos', /^(mp4|m4v|mkv|mov|avi|wmv|webm|flv|mpe?g|m2ts|mts|ts|vob|3gp)$/],
  ['Music & audio', /^(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?|alac|mid|midi)$/],
  ['Documents', /^(pdf|docx?|odt|rtf|txt|md|epub|xlsx?|csv|ods|pptx?|odp|pages|numbers|key)$/],
  ['Archives & disk images', /^(zip|rar|7z|gz|tgz|xz|bz2|tar|iso|img|vhdx?|dmg|cab)$/],
  ['Programs & installers', /^(exe|msi|msix|msixbundle|appx|dll|sys|apk)$/],
  ['Code & projects', /^(js|ts|jsx|tsx|py|cs|cpp|c|h|java|go|rs|json|html|css|map|lock|pyc|o|obj|pdb|class|jar)$/],
];
const catOf = (ext) => { for (const [n, re] of CAT) if (re.test(ext)) return n; return 'Other'; };
const INSTALLER = /^(exe|msi|msix|msixbundle|appx|appxbundle)$/;
const TEMPNAME = /(^~\$|^thumbs\.db$|^\.ds_store$|\.(tmp|temp|crdownload|part|partial|dmp|old|bak|chk|gid|log1|etl)$|^desktop\.ini\.bak$)/i;
async function inventory() {
  const now = Date.now(), DAY = 86400000;
  const out = { total: 0, files: 0, dirs: 0, byType: {}, byAge: { 'Last 30 days': 0, '1-6 months': 0, '6-12 months': 0, '1-3 years': 0, 'Over 3 years': 0 }, byFolder: {}, installers: [], temp: [], emptyDirs: [], largeOld: [], big: [], docs: [], images: [] };
  const lim = (arr, x, n = 4000) => { if (arr.length < n) arr.push(x); };
  const tempRoots = (job.tempRoots || []).map((r) => r.toLowerCase());
  const dlRoots = (job.downloads || []).map((r) => r.toLowerCase());
  const counts = new Map(); // dir -> number of entries that are not empty dirs
  const parents = new Map();
  const order = [];
  for (const root of job.roots) {
    const stack = [[root, null]];
    while (stack.length) {
      const [dir, top] = stack.pop();
      let dh; try { dh = await fsp.opendir(dir); } catch { counts.set(dir, 1); continue; }
      order.push(dir);
      let n = 0;
      try {
        for await (const d of dh) {
          scanned++;
          const full = path.join(dir, d.name);
          const t = top || full;
          n++;
          if (d.isDirectory() && !d.isSymbolicLink()) {
            if (SKIP_DIRS.has(d.name) || (job.skipDirs || []).includes(d.name)) continue;
            out.dirs++; parents.set(full, dir); stack.push([full, t]);
            if (!top) out.byFolder[full] = out.byFolder[full] || 0;
            continue;
          }
          if (!d.isFile()) continue;
          let st; try { st = await fsp.stat(full); } catch { continue; }
          const size = st.size, ext = path.extname(d.name).slice(1).toLowerCase();
          out.total += size; out.files++;
          const cat = catOf(ext); out.byType[cat] = (out.byType[cat] || 0) + size;
          const age = (now - st.mtimeMs) / DAY;
          out.byAge[age < 30 ? 'Last 30 days' : age < 182 ? '1-6 months' : age < 365 ? '6-12 months' : age < 1095 ? '1-3 years' : 'Over 3 years'] += size;
          out.byFolder[top ? t : '(files here)'] = (out.byFolder[top ? t : '(files here)'] || 0) + size;
          const item = { path: full, name: d.name, size, mtime: st.mtimeMs, ext };
          const low = full.toLowerCase();
          const inTemp = tempRoots.some((r) => low.startsWith(r));
          if (INSTALLER.test(ext) && dlRoots.some((r) => low.startsWith(r)) && age > (job.installerDays ?? 14)) lim(out.installers, { ...item, why: `installer, downloaded ${Math.round(age)} days ago` });
          else if ((inTemp && age > 1) || (TEMPNAME.test(d.name) && age > 2)) lim(out.temp, { ...item, why: inTemp ? 'in the temporary files folder' : 'leftover temporary file' });
          if (size >= (job.largeOldMB ?? 500) * 1048576 && age > (job.largeOldDays ?? 365)) lim(out.largeOld, { ...item, why: `${(size / 1073741824).toFixed(1)} GB, untouched for ${Math.round(age / 30)} months` });
          if (size >= 100 * 1048576) lim(out.big, item, 2000);
          if (cat === 'Documents' && size > 0) lim(out.docs, item, 20000);
          else if (cat === 'Pictures' && size > 10240 && /^(jpe?g|jfif|png|webp|bmp|gif|heic|avif|tiff?)$/.test(ext)) lim(out.images, item, 20000);
        }
      } catch {}
      counts.set(dir, n);
      if (Date.now() - lastPost > 300) { lastPost = Date.now(); parentPort.postMessage({ type: 'progress', scanned, files: out.files, total: out.total, current: dir }); }
    }
  }
  // empty folders, including folders that only hold empty folders (deepest first)
  const empty = new Set(), emptyKids = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const d = order[i];
    if (job.roots.includes(d)) continue;
    if ((counts.get(d) || 0) - (emptyKids.get(d) || 0) === 0) { empty.add(d); const p = parents.get(d); emptyKids.set(p, (emptyKids.get(p) || 0) + 1); }
  }
  for (const d of empty) if (!empty.has(parents.get(d))) lim(out.emptyDirs, { path: d, name: path.basename(d), size: 0, isDir: true, why: 'empty folder' });
  out.big.sort((a, b) => b.size - a.size);
  out.byFolder = Object.entries(out.byFolder).map(([p, size]) => ({ path: p, name: path.basename(p) || p, size })).sort((a, b) => b.size - a.size).slice(0, 40);
  return out;
}

// ---------------- checksums (integrity) ----------------
function hashFull(file, algo) {
  return new Promise((resolve) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (c) => { h.update(c); bytes += c.length; });
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}
let bytes = 0;
async function hashFiles() {
  const out = [];
  // expand folders
  const list = [];
  for (const f of job.files) {
    let st; try { st = await fsp.stat(f.abs); } catch { list.push({ ...f, missing: true }); continue; }
    if (!st.isDirectory()) { list.push({ ...f, size: st.size }); continue; }
    const stack = [[f.abs, f.rel]];
    while (stack.length) {
      const [d, rel] = stack.pop();
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const abs = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) stack.push([abs, r]);
        else if (e.isFile() && !/\.(sha256|sha1|md5|sfv)$/i.test(e.name)) { let s2 = 0; try { s2 = (await fsp.stat(abs)).size; } catch {} list.push({ abs, rel: r, size: s2 }); }
      }
    }
  }
  const total = list.reduce((a, f) => a + (f.size || 0), 0);
  let i = 0;
  for (const f of list) {
    i++;
    if (f.missing) { out.push({ rel: f.rel, abs: f.abs, missing: true }); continue; }
    const h = await hashFull(f.abs, job.algo || 'sha256');
    out.push(typeof h === 'string' ? { rel: f.rel, abs: f.abs, hash: h, size: f.size } : { rel: f.rel, abs: f.abs, error: h.error });
    if (Date.now() - lastPost > 250) { lastPost = Date.now(); parentPort.postMessage({ type: 'progress', done: i, of: list.length, bytes, total, current: f.rel }); }
  }
  return out;
}

(async () => {
  try {
    if (job.type === 'hashfiles') { const r = await hashFiles(); parentPort.postMessage({ type: 'done', files: r }); return; }
    if (job.type === 'inventory') { const r = await inventory(); parentPort.postMessage({ type: 'done', ...r }); return; }
    if (job.type === 'search') { await search(); parentPort.postMessage({ type: 'done', scanned }); }
    else if (job.type === 'size') { const r = await dirSize(job.root, !!job.children); parentPort.postMessage({ type: 'done', ...r }); }
    else if (job.type === 'dupes') { const g = await dupes(); parentPort.postMessage({ type: 'done', groups: g }); }
  } catch (e) { parentPort.postMessage({ type: 'error', error: e.message }); }
})();
