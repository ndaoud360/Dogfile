// Saved server connections: SFTP and FTP/FTPS browsed as folders inside Atlas (atlas:remote|<id>|/path), plus
// Windows shares (SMB) and WebDAV connected with saved credentials. Passwords are encrypted with Windows' own
// data protection (Electron safeStorage) and never leave this PC.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { safeStorage } = require('electron');
const { execFile } = require('child_process');

let libs = null;
const L = () => (libs ||= require('./vendor/remote-libs.js'));
let store = null, settings = () => ({});
function init(s, getSettings) { store = s; settings = getSettings; }

// ---------- secrets ----------
function secrets() { return store.get('connection-secrets') || {}; }
function setSecret(id, pw) {
  const all = secrets();
  if (pw == null || pw === '') delete all[id];
  else all[id] = safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(pw).toString('base64') : 'p:' + Buffer.from(pw).toString('base64');
  store.set('connection-secrets', all);
}
function getSecret(id) {
  const v = secrets()[id];
  if (!v) return '';
  try { return v.startsWith('e:') ? safeStorage.decryptString(Buffer.from(v.slice(2), 'base64')) : Buffer.from(v.slice(2), 'base64').toString(); } catch { return ''; }
}
const conn = (id) => (settings().connections || []).find((c) => c.id === id);

// ---------- sessions (kept open a few minutes) ----------
const sessions = new Map(); // id -> { kind, client, sftp?, busy: Promise, timer }
function touch(id) { const s = sessions.get(id); if (!s) return; clearTimeout(s.timer); s.timer = setTimeout(() => close(id), 4 * 60000); }
function close(id) { const s = sessions.get(id); if (!s) return; sessions.delete(id); try { s.kind === 'sftp' ? s.client.end() : s.client.close(); } catch {} }
async function session(id) {
  let s = sessions.get(id);
  if (s && !s.closed) { touch(id); return s; }
  const c = conn(id);
  if (!c) throw new Error('This connection was removed');
  const password = getSecret(id);
  if (c.type === 'sftp') {
    const { Client } = L().ssh2;
    const client = new Client();
    s = await new Promise((resolve, reject) => {
      const to = setTimeout(() => { try { client.end(); } catch {} reject(new Error(`No answer from ${c.host} (timed out)`)); }, 20000);
      client.on('ready', () => client.sftp((err, sftp) => { clearTimeout(to); if (err) return reject(err); resolve({ kind: 'sftp', client, sftp }); }));
      client.on('error', (e) => { clearTimeout(to); reject(friendly(e, c)); });
      client.on('close', () => { const x = sessions.get(id); if (x) { x.closed = true; sessions.delete(id); } });
      const opts = { host: c.host, port: +c.port || 22, username: c.user || '', readyTimeout: 20000, keepaliveInterval: 20000 };
      if (c.keyFile) { try { opts.privateKey = fs.readFileSync(c.keyFile); if (password) opts.passphrase = password; } catch (e) { clearTimeout(to); return reject(new Error(`Can’t read the key file: ${e.message}`)); } }
      else opts.password = password;
      if (!opts.privateKey && !password && process.env.SSH_AUTH_SOCK) opts.agent = process.env.SSH_AUTH_SOCK;
      client.connect(opts);
    });
  } else if (c.type === 'ftp' || c.type === 'ftps') {
    const client = new (L().ftp.Client)(30000);
    try {
      await client.access({ host: c.host, port: +c.port || 21, user: c.user || 'anonymous', password: password || (c.user ? '' : 'guest'), secure: c.type === 'ftps' ? true : false, secureOptions: { rejectUnauthorized: !c.allowSelfSigned } });
    } catch (e) { client.close(); throw friendly(e, c); }
    s = { kind: 'ftp', client };
  } else throw new Error('Unsupported connection type');
  s.queue = Promise.resolve();
  sessions.set(id, s);
  touch(id);
  return s;
}
function friendly(e, c) {
  const m = String(e.message || e);
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return new Error(`Can’t find the server “${c.host}”. Check the address.`);
  if (/ECONNREFUSED/i.test(m)) return new Error(`${c.host} refused the connection on port ${c.port || (c.type === 'sftp' ? 22 : 21)}. Is the server running?`);
  if (/ETIMEDOUT|timed out/i.test(m)) return new Error(`No answer from ${c.host}. Check the address, the network or a firewall.`);
  if (/authentication|auth fail|530|login|password/i.test(m)) return new Error('The user name or password was not accepted.');
  if (/self.signed|certificate/i.test(m)) return new Error('The server’s certificate isn’t trusted. Turn on “Allow self-signed certificates” if you trust this server.');
  return new Error(m);
}
// FTP can only do one thing at a time per connection: queue calls
function run(id, fn) {
  return session(id).then((s) => { const p = s.queue.then(() => fn(s)); s.queue = p.catch(() => {}); return p; });
}
const rp = (p) => (p || '/').replace(/\\/g, '/').replace(/\/+/g, '/') || '/';
const join = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
const url = (id, p) => `atlas:remote|${id}|${rp(p)}`;

async function list(id, dir) {
  dir = rp(dir);
  return run(id, async (s) => {
    if (s.kind === 'sftp') {
      const ents = await new Promise((res, rej) => s.sftp.readdir(dir, (e, l) => (e ? rej(e) : res(l))));
      return ents.filter((e) => e.filename !== '.' && e.filename !== '..').map((e) => {
        const isDir = (e.attrs.mode & 0o170000) === 0o040000, isLink = (e.attrs.mode & 0o170000) === 0o120000;
        return { name: e.filename, path: url(id, join(dir, e.filename)), isDir: isDir || (isLink && e.longname?.startsWith('l') && !path.extname(e.filename)), size: isDir ? 0 : e.attrs.size, mtime: e.attrs.mtime * 1000, ctime: e.attrs.mtime * 1000, hidden: e.filename.startsWith('.'), remote: { id, path: join(dir, e.filename) } };
      });
    }
    const ents = await s.client.list(dir);
    return ents.filter((e) => e.name !== '.' && e.name !== '..').map((e) => ({ name: e.name, path: url(id, join(dir, e.name)), isDir: e.isDirectory, size: e.isDirectory ? 0 : e.size, mtime: e.modifiedAt ? e.modifiedAt.getTime() : 0, ctime: 0, hidden: e.name.startsWith('.'), remote: { id, path: join(dir, e.name) } }));
  });
}
async function statRemote(s, p) {
  if (s.kind === 'sftp') return new Promise((res) => s.sftp.stat(p, (e, st) => res(e ? null : { isDir: (st.mode & 0o170000) === 0o040000, size: st.size })));
  try { const sz = await s.client.size(p); return { isDir: false, size: sz }; } catch { try { const cwd = await s.client.pwd(); await s.client.cd(p); await s.client.cd(cwd); return { isDir: true, size: 0 }; } catch { return null; } }
}
// download remote files / folders into a local folder
async function get(id, remotePaths, localDir, progress) {
  let done = 0;
  const out = [];
  for (const rpth0 of remotePaths) {
    const rpth = rp(rpth0);
    await run(id, async (s) => {
      const walk = async (r, l) => {
        const st = await statRemote(s, r);
        if (!st) throw new Error(`${r} is gone`);
        if (st.isDir) {
          await fsp.mkdir(l, { recursive: true });
          const kids = s.kind === 'sftp' ? await new Promise((res, rej) => s.sftp.readdir(r, (e, x) => (e ? rej(e) : res(x.map((k) => k.filename))))) : (await s.client.list(r)).map((k) => k.name);
          for (const k of kids) if (k !== '.' && k !== '..') await walk(join(r, k), path.join(l, k));
          return;
        }
        progress?.({ current: path.basename(r), done });
        if (s.kind === 'sftp') await new Promise((res, rej) => s.sftp.fastGet(r, l, { step: (t) => progress?.({ current: path.basename(r), done: done + t }) }, (e) => (e ? rej(e) : res())));
        else { s.client.trackProgress((info) => progress?.({ current: path.basename(r), done: done + info.bytes })); await s.client.downloadTo(l, r); s.client.trackProgress(); }
        done += st.size;
      };
      const local = path.join(localDir, path.posix.basename(rpth));
      await walk(rpth, local);
      out.push(local);
    });
  }
  return out;
}
async function put(id, localPaths, remoteDir, progress) {
  let done = 0;
  remoteDir = rp(remoteDir);
  for (const lp of localPaths) {
    await run(id, async (s) => {
      const walk = async (l, r) => {
        const st = await fsp.stat(l);
        if (st.isDirectory()) {
          if (s.kind === 'sftp') await new Promise((res) => s.sftp.mkdir(r, () => res())); else await s.client.ensureDir(r).then(() => s.client.cd('/'));
          for (const k of await fsp.readdir(l)) await walk(path.join(l, k), join(r, k));
          return;
        }
        progress?.({ current: path.basename(l), done });
        if (s.kind === 'sftp') await new Promise((res, rej) => s.sftp.fastPut(l, r, { step: (t) => progress?.({ current: path.basename(l), done: done + t }) }, (e) => (e ? rej(e) : res())));
        else { s.client.trackProgress((info) => progress?.({ current: path.basename(l), done: done + info.bytes })); await s.client.uploadFrom(l, r); s.client.trackProgress(); }
        done += st.size;
      };
      await walk(lp, join(remoteDir, path.basename(lp)));
    });
  }
  return true;
}
async function remove(id, paths) {
  for (const p0 of paths) {
    const p = rp(p0);
    await run(id, async (s) => {
      const st = await statRemote(s, p);
      if (!st) return;
      if (s.kind === 'ftp') { if (st.isDir) await s.client.removeDir(p); else await s.client.remove(p); return; }
      const rm = async (x) => {
        const t = await statRemote(s, x);
        if (t?.isDir) { const kids = await new Promise((res, rej) => s.sftp.readdir(x, (e, l) => (e ? rej(e) : res(l)))); for (const k of kids) await rm(join(x, k.filename)); await new Promise((res, rej) => s.sftp.rmdir(x, (e) => (e ? rej(e) : res()))); }
        else await new Promise((res, rej) => s.sftp.unlink(x, (e) => (e ? rej(e) : res())));
      };
      await rm(p);
    });
  }
  return true;
}
async function rename(id, from, to) { from = rp(from); to = rp(to); return run(id, async (s) => { if (s.kind === 'sftp') await new Promise((res, rej) => s.sftp.rename(from, to, (e) => (e ? rej(e) : res()))); else await s.client.rename(from, to); return true; }); }
async function mkdir(id, p) { p = rp(p); return run(id, async (s) => { if (s.kind === 'sftp') await new Promise((res, rej) => s.sftp.mkdir(p, (e) => (e ? rej(e) : res()))); else { await s.client.ensureDir(p); await s.client.cd('/'); } return true; }); }
async function openLocal(id, p) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-remote-'));
  const [local] = await get(id, [p], dir);
  return local;
}
async function test(c, password) {
  const id = '__test_' + Date.now();
  const all = settings().connections || [];
  const orig = settings;
  settings = () => ({ ...orig(), connections: [...all, { ...c, id }] });
  setSecret(id, password || '');
  try { const items = await list(id, c.path || '/'); return { ok: true, count: items.length }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { close(id); setSecret(id, ''); settings = orig; }
}

// ---------- Windows shares / WebDAV ----------
function netUse(target, user, password) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Only on Windows' });
    const args = ['use', target];
    if (password) args.push(password);
    if (user) args.push('/user:' + user);
    args.push('/persistent:no');
    execFile('net', args, { windowsHide: true, timeout: 30000 }, (err, so, se) => {
      if (!err || /1219|already/.test(String(se))) return resolve({ ok: true });
      const m = String(se || err.message);
      resolve({ ok: false, error: /86|1326|password/i.test(m) ? 'The user name or password was not accepted.' : /53|67|not found|network path/i.test(m) ? 'Can’t find that server or share. Check the address and that you’re on the same network.' : m.trim().split('\n').pop() });
    });
  });
}
async function connectShare(id) {
  const c = conn(id);
  if (!c) throw new Error('This connection was removed');
  const target = uncOf(c);
  const r = await netUse(target, c.user, getSecret(id));
  if (!r.ok) throw new Error(r.error);
  return target;
}
function uncOf(c) {
  if (c.type === 'webdav') { const u = new URL(/^https?:/i.test(c.host) ? c.host : `https://${c.host}`); return `\\\\${u.hostname}${u.protocol === 'https:' ? '@SSL' : ''}${u.port ? '@' + u.port : ''}\\DavWWWRoot${decodeURIComponent(u.pathname).replace(/\//g, '\\').replace(/\\$/, '')}`; }
  return `\\\\${c.host.replace(/^\\\\/, '')}${c.share ? '\\' + c.share.replace(/^\\/, '') : ''}`;
}
// is a path (share, mapped drive, server) answering? never hangs longer than the timeout
function reachable(p, ms = 4000) {
  return Promise.race([fsp.stat(p).then(() => true).catch((e) => (e.code === 'EACCES' || e.code === 'EPERM' ? true : false)), new Promise((r) => setTimeout(() => r(false), ms))]);
}
async function status(id) {
  const c = conn(id);
  if (!c) return { ok: false };
  if (c.type === 'smb' || c.type === 'webdav') return { ok: await reachable(uncOf(c)) };
  if (sessions.has(id)) return { ok: true, connected: true };
  // TCP probe without logging in
  return new Promise((resolve) => {
    const sock = require('net').connect(+c.port || (c.type === 'sftp' ? 22 : 21), c.host);
    const done = (ok) => { try { sock.destroy(); } catch {} resolve({ ok }); };
    sock.setTimeout(4000, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}
module.exports = { init, setSecret, list, get, put, remove, rename, mkdir, openLocal, test, connectShare, uncOf, reachable, status, close };
