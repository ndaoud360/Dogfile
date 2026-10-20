// File & folder versions: copies kept in Atlas's data folder (never next to your files). Save a version by hand,
// or let Atlas save one whenever a tracked file changes. Old versions are pruned (per file count and total size).
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

let root = null, settings = { keep: 20, maxTotalMB: 5000 };
const idFor = (p) => crypto.createHash('sha1').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 20);
const dirFor = (p) => path.join(root, idFor(p));
const indexFile = (p) => path.join(dirFor(p), 'index.json');
async function readIndex(p) { try { return JSON.parse(await fsp.readFile(indexFile(p), 'utf8')); } catch { return { path: p, versions: [] }; } }
async function writeIndex(p, idx) { await fsp.mkdir(dirFor(p), { recursive: true }); await fsp.writeFile(indexFile(p), JSON.stringify(idx, null, 1)); }
async function du(p) { const st = await fsp.stat(p).catch(() => null); if (!st) return 0; if (!st.isDirectory()) return st.size; let n = 0; for (const e of await fsp.readdir(p)) n += await du(path.join(p, e)); return n; }

function init(dir, s) { root = dir; Object.assign(settings, s || {}); }
function configure(s) { Object.assign(settings, s || {}); }

async function save(p, note = '', auto = false) {
  const st = await fsp.stat(p);
  const idx = await readIndex(p);
  const last = idx.versions[idx.versions.length - 1];
  if (auto && last && last.mtime === st.mtimeMs && last.size === st.size) return null; // nothing changed
  const at = Date.now();
  const name = `${at}-${path.basename(p)}`;
  const dst = path.join(dirFor(p), name);
  await fsp.mkdir(dirFor(p), { recursive: true });
  if (st.isDirectory()) await fsp.cp(p, dst, { recursive: true, errorOnExist: false, force: true, preserveTimestamps: true });
  else await fsp.copyFile(p, dst);
  const v = { id: name, at, note, auto, size: st.isDirectory() ? await du(dst) : st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
  idx.path = p; idx.versions.push(v);
  // keep the newest N
  while (idx.versions.length > (settings.keep || 20)) { const old = idx.versions.shift(); await fsp.rm(path.join(dirFor(p), old.id), { recursive: true, force: true }).catch(() => {}); }
  await writeIndex(p, idx);
  prune().catch(() => {});
  return v;
}
async function list(p) { const idx = await readIndex(p); return idx.versions.slice().reverse().map((v) => ({ ...v, file: path.join(dirFor(p), v.id) })); }
async function restore(p, id, { asCopy = false } = {}) {
  const src = path.join(dirFor(p), id);
  const st = await fsp.stat(src);
  if (asCopy) {
    const ext = st.isDirectory() ? '' : path.extname(p);
    const base = st.isDirectory() ? p : p.slice(0, -ext.length || undefined);
    const d = new Date(+id.split('-')[0]);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
    const out = `${base} (version ${stamp})${ext}`;
    if (st.isDirectory()) await fsp.cp(src, out, { recursive: true }); else await fsp.copyFile(src, out);
    return out;
  }
  if (await fsp.stat(p).catch(() => null)) await save(p, 'Before restoring an older version', true).catch(() => {});
  if (st.isDirectory()) { await fsp.rm(p, { recursive: true, force: true }); await fsp.cp(src, p, { recursive: true }); }
  else await fsp.copyFile(src, p);
  return p;
}
async function remove(p, id) {
  const idx = await readIndex(p);
  idx.versions = idx.versions.filter((v) => v.id !== id);
  await fsp.rm(path.join(dirFor(p), id), { recursive: true, force: true }).catch(() => {});
  await writeIndex(p, idx);
  return true;
}
async function overview() {
  const out = [];
  let ents = []; try { ents = await fsp.readdir(root); } catch { return out; }
  for (const e of ents) { try { const idx = JSON.parse(await fsp.readFile(path.join(root, e, 'index.json'), 'utf8')); if (idx.versions.length) out.push({ path: idx.path, count: idx.versions.length, last: idx.versions[idx.versions.length - 1].at, size: idx.versions.reduce((a, v) => a + (v.size || 0), 0) }); } catch {} }
  return out.sort((a, b) => b.last - a.last);
}
// keep the whole store under the size limit by dropping the oldest versions anywhere
async function prune() {
  const all = [];
  let ents = []; try { ents = await fsp.readdir(root); } catch { return; }
  let total = 0;
  for (const e of ents) { try { const idx = JSON.parse(await fsp.readFile(path.join(root, e, 'index.json'), 'utf8')); for (const v of idx.versions) { all.push({ p: idx.path, v }); total += v.size || 0; } } catch {} }
  const max = (settings.maxTotalMB || 5000) * 1048576;
  all.sort((a, b) => a.v.at - b.v.at);
  while (total > max && all.length) { const x = all.shift(); total -= x.v.size || 0; await remove(x.p, x.v.id); }
}

// automatic versions for tracked files
const watched = new Map();
function track(paths) {
  const want = new Set(paths || []);
  for (const [p, w] of watched) if (!want.has(p)) { fs.unwatchFile(p, w); watched.delete(p); }
  for (const p of want) {
    if (watched.has(p)) continue;
    let timer = null;
    const fn = (cur, prev) => { if (!cur.mtimeMs || cur.mtimeMs === prev.mtimeMs) return; clearTimeout(timer); timer = setTimeout(() => save(p, '', true).catch(() => {}), 4000); };
    fs.watchFile(p, { interval: 3000 }, fn);
    watched.set(p, fn);
    // first version right away so there is always something to go back to
    readIndex(p).then((idx) => { if (!idx.versions.length) save(p, 'Started tracking', true).catch(() => {}); });
  }
}
module.exports = { init, configure, save, list, restore, remove, overview, track };
