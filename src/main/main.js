'use strict';
const { app, BrowserWindow, ipcMain, protocol, nativeTheme, shell, clipboard, nativeImage, Tray, Menu, dialog, screen, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const win = require('./winshell');
const ops = require('./ops');
const core = require('./core');
const media = require('./media');

const IS_WIN = process.platform === 'win32';
const RENDERER = path.join(__dirname, '..', 'renderer');
const ARGS = process.argv.slice(1);
const TEST_MODE = process.env.ATLAS_TEST === '1';
if (TEST_MODE) console.log('[args]', JSON.stringify(process.argv));

if (process.env.ATLAS_PORTABLE === '1' || fs.existsSync(path.join(path.dirname(process.execPath), 'portable.txt'))) {
  app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));
}
app.setAppUserModelId('AtlasFiles');

protocol.registerSchemesAsPrivileged([
  { scheme: 'atlas', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } },
]);

// ---------------- persistent store ----------------
const store = {
  dir: () => app.getPath('userData'),
  file: (n) => path.join(app.getPath('userData'), `${n}.json`),
  get(n) { try { return JSON.parse(fs.readFileSync(this.file(n), 'utf8')); } catch { return null; } },
  set(n, v) {
    fs.mkdirSync(this.dir(), { recursive: true });
    const tmp = this.file(n) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
    fs.renameSync(tmp, this.file(n));
    return true;
  },
};

let settingsCache = store.get('settings') || {};
const windows = new Set();
let tray = null;
let quitting = false;

// ---------------- launch-argument parsing (Explorer-compatible) ----------------
function parseLaunchArgs(argv) {
  const out = { path: null, select: null, edit: [], play: [], view: [] };
  // --edit <files…> / --play <files…>  (used by the Windows right-click verbs)
  for (const flag of ['--edit', '--play', '--view']) {
    const i = argv.indexOf(flag);
    if (i >= 0) { for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out[flag.slice(2)].push(argv[k].replace(/^"|"$/g, '')); argv = argv.filter((_, k) => k < i || k > i + out[flag.slice(2)].length); }
  }
  const args = argv.filter((a) => a && !a.startsWith('--') && !/electron(\.exe)?$/i.test(a) && a !== '.' && !a.endsWith('.js') && path.resolve(a) !== path.resolve(app.getAppPath()));
  for (let a of args) {
    a = a.replace(/^"|"$/g, '');
    if (/^\/select,/i.test(a)) { out.select = a.slice(8).replace(/^"|"$/g, ''); out.path = path.dirname(out.select); continue; }
    if (/^\/(e|n|root|separate)(,|$)/i.test(a)) { const rest = a.replace(/^\/(e|n|root|separate),?/i, ''); if (rest) a = rest.replace(/^"|"$/g, ''); else continue; }
    if (a.startsWith('::') || /^shell:/i.test(a)) {
      const s = a.toLowerCase();
      if (s.includes('20d04fe0') || s.includes('mycomputer')) out.path = 'atlas:thispc';
      else if (s.includes('645ff040') || s.includes('recyclebin')) out.path = 'atlas:recycle';
      else if (s.includes('downloads') || s.includes('374de290')) out.path = app.getPath('downloads');
      else if (s.includes('desktop')) out.path = app.getPath('desktop');
      else if (s.includes('documents') || s.includes('personal')) out.path = app.getPath('documents');
      else out.path = 'atlas:home';
      continue;
    }
    try { const st = fs.statSync(a); out.path = st.isDirectory() ? a : path.dirname(a); if (!st.isDirectory()) out.select = a; } catch { /* ignore */ }
  }
  return out;
}

// ---------------- windows ----------------
function themeColors() {
  const dark = settingsCache.theme === 'dark' || (settingsCache.theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? { color: '#151618', symbolColor: '#c9cacc' } : { color: '#efeff0', symbolColor: '#3a3a3a' };
}

function createWindow(launch = {}) {
  const bounds = store.get('window') || {};
  const display = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({
    width: bounds.width || Math.min(1440, display.width - 80),
    height: bounds.height || Math.min(940, display.height - 60),
    x: windows.size ? undefined : bounds.x,
    y: windows.size ? undefined : bounds.y,
    minWidth: 380, minHeight: 300,
    show: false,
    frame: IS_WIN,
    titleBarStyle: 'hidden',
    titleBarOverlay: IS_WIN ? { ...themeColors(), height: 40 } : false,
    backgroundColor: themeColors().color,
    icon: path.join(RENDERER, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // the preload bridge also runs in built-in app tabs (iframes)
      sandbox: false,
      plugins: true,
      spellcheck: false,
    },
  });
  if (bounds.maximized && !windows.size) w.maximize();
  const first = !windows.size;
  windows.add(w);
  w.launch = launch;
  w.loadURL('atlas://app/index.html');
  w.once('ready-to-show', () => { w.show(); applyWindowCorners(w, cornerPref()); });
  if (TEST_MODE && process.env.ATLAS_SHOT && first) runTestScript(w);
  const saveBounds = () => { if (!w.isDestroyed() && !w.isMinimized()) store.set('window', { ...(w.isMaximized() ? store.get('window') || {} : w.getBounds()), maximized: w.isMaximized() }); };
  w.on('resize', debounce(saveBounds, 500));
  w.on('move', debounce(saveBounds, 500));
  w.on('maximize', () => w.webContents.send('win:state', { maximized: true }));
  w.on('unmaximize', () => w.webContents.send('win:state', { maximized: false }));
  w.on('close', (e) => {
    if (!quitting && settingsCache.keepRunning && windows.size === 1) {
      e.preventDefault();
      w.webContents.send('app:beforeHide');
      w.hide();
      ensureTray();
    }
  });
  const wcId = w.webContents.id;
  w.on('closed', () => { windows.delete(w); unwatchAll(wcId); for (const [id, t] of ptys) if (t.sender === wcId) { try { t.p.kill(); } catch {} ptys.delete(id); } });
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('atlas://app/')) e.preventDefault(); });
  return w;
}

async function runTestScript(w) {
  const steps = JSON.parse(process.env.ATLAS_STEPS || '[]');
  w.webContents.on('console-message', (e, level, msg) => console.log('[renderer]', msg));
  w.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(+(process.env.ATLAS_SHOT_DELAY || 2500));
    let i = 0;
    for (const st of steps) {
      if (st.size) { w.setMinimumSize(200, 150); w.setSize(st.size[0], st.size[1]); await wait(300); }
      try { if (st.js) { const r = await w.webContents.executeJavaScript(st.js); if (r !== undefined) console.log('[eval]', JSON.stringify(r).slice(0, 2000)); } } catch (e) { console.log('[eval-error]', e.message); }
      await wait(st.wait || 800);
      if (st.shot) { const img = await w.webContents.capturePage(); fs.writeFileSync(st.shot, img.toPNG()); console.log('[shot]', st.shot); }
      i++;
    }
    const img = await w.webContents.capturePage();
    fs.writeFileSync(process.env.ATLAS_SHOT, img.toPNG());
    console.log('[shot]', process.env.ATLAS_SHOT);
    quitting = true; app.exit(0);
  });
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(RENDERER, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Atlas Files');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New window', click: () => openPathAnywhere({ path: null, newWindow: true }) },
    { type: 'separator' },
    { label: 'Quit Atlas Files', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => openPathAnywhere({ path: null }));
}

function openPathAnywhere(launch) {
  const visible = [...windows].filter((w) => !w.isDestroyed());
  const target = visible.find((w) => w.isFocused()) || visible[0];
  const wantNewWindow = launch.newWindow || settingsCache.openInNewWindow;
  if (target && !wantNewWindow) {
    if (!target.isVisible()) target.show();
    if (target.isMinimized()) target.restore();
    target.focus();
    target.webContents.send('app:open', launch);
  } else if (target && !target.isVisible() && visible.length === 1) {
    target.show(); target.focus();
    target.webContents.send('app:open', launch);
  } else createWindow(launch);
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------- tool windows: Atlas Notepad & Atlas Player ----------------
const tools = { editor: null, player: null, viewer: null };
function allWindows() { return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()); }
function broadcast(ch, data) { for (const w of allWindows()) w.webContents.send(ch, data); }
function openTool(kind, files = [], opts = {}) {
  let w = tools[kind];
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.show(); w.focus();
    if (files.length) w.webContents.send(kind + ':open', { files, ...opts });
    return w;
  }
  const saved = store.get(kind + '-window') || {};
  const display = screen.getPrimaryDisplay().workAreaSize;
  const isPlayer = kind === 'player' || kind === 'viewer';
  w = new BrowserWindow({
    width: saved.width || Math.min(isPlayer ? 1280 : 1100, display.width - 80),
    height: saved.height || Math.min(isPlayer ? 760 : 800, display.height - 60),
    x: saved.x, y: saved.y, minWidth: 340, minHeight: 260, show: false, frame: IS_WIN, titleBarStyle: 'hidden',
    titleBarOverlay: IS_WIN ? { ...(isPlayer ? { color: '#101012', symbolColor: '#c9cacc' } : themeColors()), height: 40 } : false,
    backgroundColor: isPlayer ? (kind === 'viewer' ? '#0b0b0d' : '#000000') : themeColors().color,
    icon: path.join(RENDERER, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  tools[kind] = w;
  w.toolKind = kind;
  w.pending = { files, ...opts };
  w.loadURL(`atlas://app/${kind}.html`);
  w.once('ready-to-show', () => { w.show(); applyWindowCorners(w, cornerPref()); });
  const save = debounce(() => { if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen()) store.set(kind + '-window', w.getBounds()); }, 500);
  w.on('resize', save); w.on('move', save);
  w.on('closed', () => { tools[kind] = null; if (kind === 'player') media.killAll(); });
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('atlas://app/')) e.preventDefault(); });
  if (TEST_MODE && process.env.ATLAS_SHOT && process.env.ATLAS_TEST_TOOL === kind) runTestScript(w);
  return w;
}


// ---------------- protocol: app files + local files with Range support ----------------
const MIME = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', onnx: 'application/octet-stream', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', apng: 'image/apng', jfif: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

function registerProtocol() {
  protocol.handle('atlas', async (req) => {
    const u = new URL(req.url);
    let file;
    if (u.host === 'app') {
      file = path.normalize(path.join(RENDERER, decodeURIComponent(u.pathname)));
      if (!file.startsWith(RENDERER)) return new Response('Forbidden', { status: 403 });
    } else if (u.host === 'media') {
      return media.handle(req);
    } else if (u.host === 'models') {
      return ai.serve(u);
    } else if (u.host === 'f') {
      file = u.searchParams.get('p');
    } else return new Response('Not found', { status: 404 });
    try {
      const st = await fsp.stat(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const range = req.headers.get('range');
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': u.host === 'app' ? 'no-cache' : 'max-age=60' };
      // the feature sandbox: may evaluate the feature's code, but can't load other scripts or reach the network
      if (u.host === 'app' && /[\\/]ext-worker\.js$/.test(file)) headers['Content-Security-Policy'] = "default-src 'none'; script-src atlas: 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (!m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
        end = Math.min(end, st.size - 1);
        const stream = fs.createReadStream(file, { start, end });
        return new Response(nodeToWeb(stream), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` } });
      }
      return new Response(nodeToWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function nodeToWeb(stream) {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (c) => controller.enqueue(new Uint8Array(c)));
      stream.on('end', () => controller.close());
      stream.on('error', (e) => controller.error(e));
    },
    cancel() { stream.destroy(); },
  });
}

// ---------------- IPC ----------------
const handlers = {};
const on = (name, fn) => { handlers[name] = fn; };

function knownFolders() {
  const g = (k) => { try { return app.getPath(k); } catch { return null; } };
  const home = g('home');
  const kf = {
    home, desktop: g('desktop'), documents: g('documents'), downloads: g('downloads'), pictures: g('pictures'),
    videos: g('videos'), music: g('music'), appData: g('appData'), temp: g('temp'),
    onedrive: process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial || null,
    recentWin: IS_WIN ? path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent') : null,
  };
  if (kf.onedrive && !fs.existsSync(kf.onedrive)) kf.onedrive = null;
  return kf;
}

on('sys:info', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return {
    platform: process.platform, sep: path.sep, version: app.getVersion(), known: knownFolders(), userData: app.getPath('userData'),
    exe: process.execPath, packaged: app.isPackaged, launch: w?.launch || {}, pending: w?.pending || null, ffmpeg: media.available(), user: require('os').userInfo().username,
    hostname: require('os').hostname(), has7z: !!ops.find7z(), test: TEST_MODE,
  };
});

// ---------- file system ----------
async function statEntry(dir, name, attrs) {
  const full = path.join(dir, name);
  let lst, st;
  try { lst = await fsp.lstat(full); } catch (e) { return null; }
  st = lst;
  let isLink = lst.isSymbolicLink();
  let broken = false;
  if (isLink) { try { st = await fsp.stat(full); } catch { broken = true; } }
  const isDir = st.isDirectory();
  const hidden = attrs.hidden ? attrs.hidden.has(name) : name.startsWith('.');
  const system = attrs.system ? attrs.system.has(name) : false;
  return {
    name, path: full, isDir, isLink, broken, size: isDir ? null : st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs,
    atime: st.atimeMs, hidden, system, readonly: !(st.mode & 0o200), ext: isDir ? '' : path.extname(name).slice(1).toLowerCase(),
  };
}

on('fs:list', async (e, dir) => {
  try {
    if (/^\\\\[^\\]+\\?$/.test(dir)) {
      // \\server  -> list shares
      const shares = await win.netView(dir.replace(/\\$/, ''));
      return { path: dir, items: shares.map((s) => ({ name: s, path: dir.replace(/\\$/, '') + '\\' + s, isDir: true, size: null, mtime: 0, ctime: 0, hidden: false, system: false, ext: '', share: true })) };
    }
    // native engine: one call, attributes included (no PowerShell round trip)
    if (core.available()) {
      try { const r = await core.request('list', { path: dir }); return { path: dir, items: r.items }; }
      catch (err) {
        const code = err.message === 'EACCES' ? 'EACCES' : err.message === 'ENOENT' ? 'ENOENT' : null;
        if (code) return { path: dir, items: [], error: code === 'EACCES' ? 'Access denied' : 'This location could not be found', code };
      }
    }
    const [names, attrs] = await Promise.all([fsp.readdir(dir), win.attrSets(dir).catch(() => ({}))]);
    const items = [];
    const BATCH = 256;
    for (let i = 0; i < names.length; i += BATCH) {
      const part = await Promise.all(names.slice(i, i + BATCH).map((n) => statEntry(dir, n, attrs)));
      for (const p of part) if (p) items.push(p);
    }
    return { path: dir, items };
  } catch (err) {
    return { path: dir, items: [], error: err.code === 'EPERM' || err.code === 'EACCES' ? 'Access denied' : err.code === 'ENOENT' ? 'This location could not be found' : err.message, code: err.code };
  }
});

on('fs:subdirs', async (e, dir, includeHidden) => {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const attrs = includeHidden ? {} : await win.attrSets(dir).catch(() => ({}));
    return ents.filter((d) => {
      if (!(d.isDirectory() || (d.isSymbolicLink() && isDirSafe(path.join(dir, d.name))))) return false;
      if (includeHidden) return true;
      if (attrs.hidden) return !attrs.hidden.has(d.name);
      return !d.name.startsWith('.');
    }).map((d) => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch { return []; }
});
function isDirSafe(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

on('fs:stat', async (e, p) => {
  try { const st = await fsp.stat(p); return { isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, atime: st.atimeMs, mode: st.mode }; }
  catch (err) { return null; }
});
on('fs:exists', async (e, p) => { try { await fsp.access(p); return true; } catch { return false; } });
on('fs:isDir', async (e, p) => isDirSafe(p));
on('fs:mkdir', async (e, p) => { await fsp.mkdir(p); return p; });
on('fs:newFile', async (e, p, content) => { await fsp.writeFile(p, content || '', { flag: 'wx' }); return p; });
on('fs:rename', async (e, from, to) => {
  if (from === to) return to;
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  if (!caseOnly) { try { await fsp.access(to); throw new Error(`"${path.basename(to)}" already exists`); } catch (er) { if (er.code !== 'ENOENT') throw er; } }
  if (caseOnly && IS_WIN) { const tmp = from + '.atlas-tmp-' + Date.now(); await fsp.rename(from, tmp); await fsp.rename(tmp, to); }
  else await fsp.rename(from, to);
  return to;
});
on('fs:uniqueName', async (e, dir, name, style) => ops.uniqueName(dir, name, style));
on('fs:readText', async (e, p, max = 512 * 1024) => {
  const fh = await fsp.open(p, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const binary = buf.subarray(0, 8000).includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe);
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return { text, truncated: st.size > max, size: st.size, binary };
  } finally { await fh.close(); }
});
on('fs:readBytes', async (e, p, n = 4096, offset = 0) => {
  const fh = await fsp.open(p, 'r');
  try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, offset); return Array.from(buf.subarray(0, bytesRead)); }
  finally { await fh.close(); }
});
on('fs:writeText', async (e, p, text) => { await fsp.writeFile(p, text, 'utf8'); return true; });
on('fs:writeImage', async (e, p) => { const img = clipboard.readImage(); if (img.isEmpty()) return false; await fsp.writeFile(p, img.toPNG()); return true; });
on('fs:hash', async (e, p, algos = ['md5', 'sha1', 'sha256']) => {
  const hs = algos.map((a) => [a, crypto.createHash(a)]);
  await new Promise((res, rej) => { const s = fs.createReadStream(p, { highWaterMark: 4 << 20 }); s.on('data', (c) => hs.forEach(([, h]) => h.update(c))); s.on('end', res); s.on('error', rej); });
  return Object.fromEntries(hs.map(([a, h]) => [a, h.digest('hex')]));
});
on('fs:attributes', async (e, p) => win.getAttributes(p));
on('fs:setAttributes', async (e, paths, attrs) => win.setAttributes(paths, attrs));
on('fs:setTimes', async (e, p, t) => {
  const st = await fsp.stat(p);
  await fsp.utimes(p, t.atime ? new Date(t.atime) : st.atime, t.mtime ? new Date(t.mtime) : st.mtime);
  if (t.ctime) await win.setCreationTime(p, new Date(t.ctime).toISOString()).catch(() => {});
  return true;
});
on('fs:symlink', async (e, target, linkPath, type) => { await fsp.symlink(target, linkPath, type || (isDirSafe(target) ? 'junction' : 'file')); return true; });
on('fs:shortcut', async (e, lnk, target) => win.createShortcut(lnk, target));
on('fs:readLink', async (e, p) => {
  if (IS_WIN && p.toLowerCase().endsWith('.lnk')) { try { return shell.readShortcutLink(p).target; } catch { return null; } }
  try { return await fsp.realpath(p); } catch { return null; }
});
on('fs:drives', async () => win.listDrives());
on('fs:eject', async (e, letter) => win.ejectDrive(letter));
on('fs:mapped', async () => win.mappedDrives());
on('fs:recentWindows', async () => {
  // Windows' own Recent items (.lnk files) resolved to their targets
  if (!IS_WIN) return [];
  const dir = knownFolders().recentWin;
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.lnk'));
    const out = [];
    for (const n of names) {
      const full = path.join(dir, n);
      try { const st = await fsp.stat(full); const t = shell.readShortcutLink(full).target; if (t) out.push({ target: t, time: st.mtimeMs }); } catch {}
    }
    return out.sort((a, b) => b.time - a.time).slice(0, 150);
  } catch { return []; }
});
on('fs:statMany', async (e, paths) => Promise.all(paths.map(async (p) => {
  try { const st = await fsp.stat(p); return { name: path.basename(p) || p, path: p, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, ext: st.isDirectory() ? '' : path.extname(p).slice(1).toLowerCase(), hidden: false }; } catch { return null; }
})));

// ---------- thumbnails & icons ----------
const thumbQueue = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const t = thumbQueue.pop(); // LIFO: most recently requested (visible) first
    thumbActive++;
    nativeImage.createThumbnailFromPath(t.p, { width: t.size, height: t.size })
      .then((img) => t.resolve(img.isEmpty() ? null : thumbUrl(img)))
      .catch(() => t.resolve(null))
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}
// thumbnails travel as data URLs: opaque ones as JPEG (about a tenth of the size of PNG), so the window's
// thumbnail cache stays small; ones with transparency (icons) stay PNG
function thumbUrl(img) {
  try {
    const bmp = img.toBitmap();
    let opaque = true;
    for (let i = 3; i < bmp.length; i += 16) if (bmp[i] !== 255) { opaque = false; break; }
    if (opaque) return 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
  } catch {}
  return img.toDataURL();
}
on('thumb:get', async (e, p, size = 256) => {
  if (process.platform === 'linux') return null;
  return new Promise((resolve) => { thumbQueue.push({ p, size, resolve }); if (thumbQueue.length > 400) thumbQueue.shift().resolve(null); pumpThumbs(); });
});
on('icon:get', async (e, p, size = 'normal') => {
  try { const img = await app.getFileIcon(p, { size }); return img.isEmpty() ? null : img.toDataURL(); } catch { return null; }
});

// ---------- shell ----------
on('shell:open', async (e, p) => { const r = await shell.openPath(p); return r || true; });
on('shell:openExternal', async (e, url) => { await shell.openExternal(url); return true; });
on('shell:openWith', async (e, p) => win.openWith(p));
on('shell:runAs', async (e, p) => win.runAsAdmin(p));
on('shell:showInExplorer', async (e, p, select) => win.showInExplorer(p, select));
on('shell:terminal', async (e, dir, kind, admin) => win.openTerminal(dir, kind, admin));
on('shell:properties', async (e, paths) => win.showProperties(paths));
on('shell:verbs', async (e, p) => win.shellVerbs(p));
on('shell:invokeVerb', async (e, p, verb) => win.invokeVerb(p, verb));
on('shell:beep', async () => { shell.beep(); return true; });
on('shell:launch', async (e, cmd, args, cwd) => {
  const { spawn } = require('child_process');
  const resolved = cmd.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
  // with a shell, arguments are joined as text: quote anything with spaces so paths like "My Photos" survive
  const q = (a) => (IS_WIN && /[\s&()^%!,;=]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);
  const exe = IS_WIN && fs.existsSync(resolved) ? q(resolved) : resolved;
  spawn(exe, (args || []).map((a) => (IS_WIN ? q(String(a)) : String(a))), { cwd: cwd || undefined, detached: true, stdio: 'ignore', shell: IS_WIN, windowsVerbatimArguments: false }).unref();
  return true;
});
on('shell:runCommand', async (e, cmdline, cwd) => {
  const { spawn } = require('child_process');
  spawn(cmdline, { cwd, detached: true, stdio: 'ignore', shell: true }).unref();
  return true;
});

// ---------- clipboard ----------
on('clip:writeFiles', async (e, paths, cut) => {
  clipboard.writeText(paths.join('\r\n'));
  return win.clipboardSetFiles(paths, cut).catch(() => false);
});
on('clip:readFiles', async () => win.clipboardGetFiles().catch(() => ({ paths: [], cut: false })));
on('clip:writeText', async (e, t) => { clipboard.writeText(t); return true; });
on('clip:readText', async () => clipboard.readText());
on('clip:hasImage', async () => !clipboard.readImage().isEmpty());
on('clip:formats', async () => clipboard.availableFormats());
// clipboard history: watches text you copy anywhere (paths, notes…), skipping anything a password manager or
// another app marks as private. Off / paths only / everything is chosen in Settings > Privacy.
let clipWatch = null, lastClip = '';
const PRIVATE_FORMATS = /ExcludeClipboardContentFromMonitorProcessing|CanIncludeInClipboardHistory|CanUploadToCloudClipboard|Clipboard Viewer Ignore|x-kde-passwordManagerHint/i;
on('clip:watch', async (e, mode) => {
  clearInterval(clipWatch); clipWatch = null;
  if (!mode || mode === 'off') return true;
  const sender = e.sender;
  lastClip = clipboard.readText();
  clipWatch = setInterval(() => {
    if (sender.isDestroyed()) { clearInterval(clipWatch); return; }
    let t;
    try { if (clipboard.availableFormats().some((f) => PRIVATE_FORMATS.test(f))) { lastClip = clipboard.readText(); return; } t = clipboard.readText(); } catch { return; }
    if (!t || t === lastClip || t.length > 20000) { lastClip = t; return; }
    lastClip = t;
    const looksPath = /^(\s*("?([a-zA-Z]:\\|\\\\|\/)[^\n"]*"?)\s*)(\r?\n\s*"?([a-zA-Z]:\\|\\\\|\/)[^\n"]*"?\s*)*$/.test(t);
    if (mode === 'paths' && !looksPath) return;
    sender.send('clip:changed', { text: t, isPath: looksPath, at: Date.now() });
  }, 1200);
  return true;
});

// ---------- ops ----------
on('ops:start', async (e, spec) => ops.start(spec));
on('shell:wallpaper', async (e, f) => win.setWallpaper(f));
on('archive:test', async (e, f) => ops.testArchive(f));
on('archive:caps', async () => ops.archiveCaps());
on('ops:control', async (e, id, action) => ops.control(id, action));
on('ops:list', async () => ops.list());
on('ops:configure', async (e, s) => ops.configure(s));
const pendingConflicts = new Map();
ops.init({
  send: (ch, data) => { for (const w of windows) if (!w.isDestroyed()) w.webContents.send(ch, data); },
  askConflict: (info) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingConflicts.set(id, resolve);
    const target = [...windows].find((w) => w.isFocused()) || [...windows][0];
    if (!target) return resolve({ action: 'skip' });
    target.webContents.send('ops:conflict', { ...info, conflictId: id });
  }),
});
on('ops:resolveConflict', async (e, id, decision) => { const r = pendingConflicts.get(id); if (r) { pendingConflicts.delete(id); r(decision); } return true; });

// ---------- archives ----------
on('archive:list', async (e, p) => ops.listArchive(p));

// ---------- workers (search / size / dupes) ----------
const workers = new Map();
const coreJobs = new Map(); // our id -> core id
const CORE_JOBS = new Set(['search', 'size', 'dupes', 'inventory', 'hashfiles']);
on('work:start', async (e, spec) => {
  const id = crypto.randomUUID();
  const sender = e.sender;
  if (CORE_JOBS.has(spec.type) && settingsCache.nativeEngine !== false && core.available()) {
    const relay = (m) => { if (!sender.isDestroyed()) sender.send('work:msg', { ...m, id }); if (m.type === 'done' || m.type === 'error') coreJobs.delete(id); };
    // a search the instant index can answer: whole result in one go
    if (spec.type === 'search' && settingsCache.indexEnabled !== false) {
      try {
        const r = await core.request('index.search', { ...spec, limit: spec.maxResults || 20000 });
        setImmediate(() => { relay({ type: 'results', items: r.items, scanned: r.total }); relay({ type: 'done', scanned: r.total, indexed: true, total: r.total, ms: r.ms }); });
        return id;
      } catch { /* not indexed (yet) or needs a folder walk */ }
    }
    const cid = core.send(spec.type, spec, relay);
    if (cid != null) { coreJobs.set(id, cid); return id; }
  }
  const wk = new Worker(path.join(__dirname, 'worker.js'), { workerData: spec });
  workers.set(id, wk);
  wk.on('message', (m) => { if (!sender.isDestroyed()) sender.send('work:msg', { id, ...m }); if (m.type === 'done' || m.type === 'error') { workers.delete(id); wk.terminate(); } });
  wk.on('error', (err) => { if (!sender.isDestroyed()) sender.send('work:msg', { id, type: 'error', error: err.message }); workers.delete(id); });
  return id;
});
on('work:cancel', async (e, id) => { const wk = workers.get(id); if (wk) { wk.terminate(); workers.delete(id); } const c = coreJobs.get(id); if (c) { core.cancel(c); coreJobs.delete(id); } return true; });

// ---------- instant index (atlas-core) ----------
async function indexRoots() {
  if (settingsCache.indexEnabled === false) return [];
  if (Array.isArray(settingsCache.indexRoots) && settingsCache.indexRoots.length) return settingsCache.indexRoots;
  if (IS_WIN) { const ds = await win.listDrives().catch(() => []); return ds.filter((d) => d.type === 'fixed').map((d) => d.path); }
  return [app.getPath('home')];
}
async function configureIndex(rescan = true) {
  if (!core.available()) return null;
  const roots = await indexRoots();
  return core.configureIndex({ roots, dataDir: path.join(app.getPath('userData'), 'Index'), rescan, mft: settingsCache.indexMft !== false });
}
core.onEvent((m) => { if (m.type === 'index') broadcast('index:status', m); });
on('index:status', async () => { if (!core.available()) return { available: false, roots: [] }; const [s, p] = await Promise.all([core.request('index.status'), core.ping()]); return { available: true, admin: !!p?.admin, roots: s.roots }; });
on('index:configure', async () => configureIndex(true));
on('index:refresh', async (e, root) => core.request('index.refresh', { root: root || '', mft: settingsCache.indexMft !== false }));
on('index:search', async (e, args) => core.request('index.search', { typed: true, ...args }));
on('index:sizes', async (e, paths) => { if (!core.available() || settingsCache.indexEnabled === false) return {}; try { return (await core.request('index.sizes', { paths })); } catch { return {}; } });
// one-time fast build: reading the NTFS file table needs administrator rights, so a helper runs elevated
// (Windows asks once), writes the index file and exits; the normal engine then loads it.
on('index:fastBuild', async (e, roots) => {
  const bin = core.binPath();
  if (!IS_WIN || !bin) return { ok: false, error: 'Only on Windows' };
  const dataDir = path.join(app.getPath('userData'), 'Index');
  const list = (roots && roots.length ? roots : await indexRoots()).map((r) => r.replace(/[\\/]+$/, ''));
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = list.map((r) => `Start-Process -FilePath ${q(bin)} -ArgumentList ${q(`--build-index "${r}" "${dataDir}"`)} -Verb RunAs -Wait -WindowStyle Hidden`).join('; ');
  try { await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30 * 60 * 1000 }, (err, out, errOut) => (err ? rej(new Error(String(errOut || err.message))) : res()))); } catch (err) { return { ok: false, error: /canceled|cancelled/i.test(err.message) ? 'Administrator permission was not given' : err.message }; }
  await core.request('index.reload', {});
  return { ok: true };
});
on('core:info', async () => ({ available: core.available(), ...(await core.ping() || {}) }));

// Everything (voidtools) integration for instant whole-disk search
on('everything:search', async (e, query, max = 2000, root) => {
  const es = await findEs();
  if (!es) return null;
  const args = ['-n', String(max), '-full-path-and-name'];
  if (root) args.push('-path', root);
  args.push(query);
  return new Promise((resolve) => execFile(es, args, { windowsHide: true, maxBuffer: 64 << 20 }, (err, out) => resolve(err ? null : out.split(/\r?\n/).filter(Boolean))));
});
let esPath;
async function findEs() {
  if (esPath !== undefined) return esPath;
  const cands = [await win.which('es.exe'), 'C:\\Program Files\\Everything\\es.exe', 'C:\\Program Files (x86)\\Everything\\es.exe'].filter(Boolean);
  esPath = cands.find((c) => fs.existsSync(c)) || null;
  return esPath;
}
on('everything:available', async () => !!(await findEs()));

// ---------- git ----------
// git: branches, switching and recent history for the status bar branch menu
const gitRun = (dir, args, timeout = 15000) => new Promise((resolve, reject) => execFile('git', args, { cwd: dir, windowsHide: true, maxBuffer: 16 << 20, timeout }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim().split('\n').slice(-2).join(' '))) : resolve(out))));
on('git:branches', async (e, dir) => {
  const out = await gitRun(dir, ['branch', '--format=%(HEAD)|%(refname:short)|%(committerdate:relative)', '--sort=-committerdate']);
  return out.split('\n').filter(Boolean).map((l) => { const [h, name, when] = l.split('|'); return { name, current: h === '*', when }; });
});
on('git:checkout', async (e, dir, branch, create) => { await gitRun(dir, create ? ['checkout', '-b', branch] : ['checkout', branch], 30000); return true; });
on('git:log', async (e, dir, n = 25) => {
  const out = await gitRun(dir, ['log', `-${n}`, '--date=relative', '--pretty=format:%h\x1f%s\x1f%an\x1f%ad']);
  return out.split('\n').filter(Boolean).map((l) => { const [hash, subject, author, date] = l.split('\x1f'); return { hash, subject, author, date }; });
});
on('git:pull', async (e, dir) => gitRun(dir, ['pull', '--ff-only'], 60000));
on('git:status', async (e, dir) => {
  let d = dir, root = null;
  for (let i = 0; i < 40; i++) { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } const up = path.dirname(d); if (up === d) break; d = up; }
  if (!root) return null;
  let branch = null;
  try { const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim(); branch = head.startsWith('ref:') ? head.split('/').slice(2).join('/') : head.slice(0, 7); } catch {}
  const files = await new Promise((resolve) => execFile('git', ['status', '--porcelain=v1', '-z', '--ignored=no', '-unormal'], { cwd: root, windowsHide: true, maxBuffer: 32 << 20, timeout: 8000 }, (err, out) => {
    if (err) return resolve(null);
    const map = {};
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i]; if (!s) continue;
      const code = s.slice(0, 2); const rel = s.slice(3);
      if (code[0] === 'R') i++;
      map[path.join(root, rel).replace(/[\\/]$/, '')] = code.trim() || code;
    }
    resolve(map);
  }));
  return { root, branch, files };
});

// ---------- recycle bin ----------
on('recycle:list', async () => win.recycleList());
on('recycle:restore', async (e, paths) => win.recycleRestore(paths));
on('recycle:restoreOriginal', async (e, paths) => win.recycleRestoreOriginal(paths));
on('recycle:deleteForever', async (e, paths) => win.recycleDeleteForever(paths));
on('recycle:empty', async () => win.recycleEmpty());

// ---------- watchers ----------
const watchers = new Map(); // key `${wcId}:${paneKey}` -> FSWatcher
function unwatchAll(wcId) { for (const [k, w] of watchers) if (k.startsWith(wcId + ':')) { try { w.close(); } catch {} watchers.delete(k); } }
on('watch:set', async (e, key, dir) => {
  const k = `${e.sender.id}:${key}`;
  const old = watchers.get(k);
  if (old) { try { old.close(); } catch {} watchers.delete(k); }
  if (!dir || dir.startsWith('atlas:')) return false;
  try {
    const sender = e.sender;
    const fire = debounce(() => { if (!sender.isDestroyed()) sender.send('watch:changed', { key, dir }); }, 250);
    const w = fs.watch(dir, { persistent: false }, fire);
    w.on('error', () => {});
    watchers.set(k, w);
    return true;
  } catch { return false; }
});

// ---------- folder automations: watch the folders that have rules ----------
const ruleWatchers = new Map(); // dir -> FSWatcher
on('rules:watch', async (e, dirs) => {
  const want = new Set((dirs || []).filter((d) => d && !d.startsWith('atlas:')));
  for (const [d, w] of ruleWatchers) if (!want.has(d)) { try { w.close(); } catch {} ruleWatchers.delete(d); }
  const sender = e.sender;
  for (const d of want) {
    const old = ruleWatchers.get(d);
    if (old && !old.sender.isDestroyed()) continue;
    if (old) { try { old.close(); } catch {} }
    try {
      const fire = debounce(() => { if (!sender.isDestroyed()) sender.send('rules:changed', { dir: d }); }, 600);
      const w = fs.watch(d, { persistent: false }, fire);
      w.sender = sender;
      w.on('error', () => { ruleWatchers.delete(d); });
      ruleWatchers.set(d, w);
    } catch {}
  }
  return [...ruleWatchers.keys()];
});

// ---------- server connections (SFTP / FTP / shares / WebDAV) ----------
const remote = require('./remote');
remote.init(store, () => settingsCache);
const remoteProgress = (e, token) => (x) => { if (!e.sender.isDestroyed()) e.sender.send('remote:progress', { token, ...x }); };
on('remote:list', async (e, id, dir) => remote.list(id, dir));
on('remote:get', async (e, id, paths, localDir, token) => remote.get(id, paths, localDir, remoteProgress(e, token)));
on('remote:put', async (e, id, paths, remoteDir, token) => remote.put(id, paths, remoteDir, remoteProgress(e, token)));
on('remote:remove', async (e, id, paths) => remote.remove(id, paths));
on('remote:rename', async (e, id, a, b) => remote.rename(id, a, b));
on('remote:mkdir', async (e, id, p) => remote.mkdir(id, p));
on('remote:open', async (e, id, p) => remote.openLocal(id, p));
on('remote:test', async (e, c, pw) => remote.test(c, pw));
on('remote:setSecret', async (e, id, pw) => { remote.setSecret(id, pw); return true; });
on('remote:disconnect', async (e, id) => { remote.close(id); return true; });
on('net:connectShare', async (e, id) => remote.connectShare(id));
on('net:unc', async (e, c) => remote.uncOf(c));
on('net:reachable', async (e, p, ms) => remote.reachable(p, ms));
on('net:status', async (e, id) => remote.status(id));

// cloud storage folders synced to this PC
on('cloud:detect', async () => {
  const home = require('os').homedir();
  const out = [];
  const add = async (provider, p, name) => { if (p && !out.some((x) => x.path.toLowerCase() === p.toLowerCase()) && await fsp.stat(p).then((s2) => s2.isDirectory()).catch(() => false)) out.push({ provider, name: name || provider, path: p }); };
  await add('OneDrive', process.env.OneDriveConsumer || process.env.OneDrive, 'OneDrive');
  if (process.env.OneDriveCommercial && process.env.OneDriveCommercial !== process.env.OneDrive) await add('OneDrive', process.env.OneDriveCommercial, path.basename(process.env.OneDriveCommercial));
  try { const info = JSON.parse(await fsp.readFile(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Dropbox', 'info.json'), 'utf8')); for (const [k, v] of Object.entries(info)) await add('Dropbox', v.path, k === 'business' ? 'Dropbox (work)' : 'Dropbox'); } catch {}
  await add('Dropbox', path.join(home, 'Dropbox'));
  await add('Google Drive', path.join(home, 'Google Drive'));
  await add('Google Drive', path.join(home, 'My Drive'), 'Google Drive');
  if (process.platform === 'win32') for (const L of 'GHIJKLMNOPQRSTUVWXYZ') { const p2 = `${L}:\\My Drive`; if (await fsp.stat(p2).catch(() => null)) { await add('Google Drive', p2, 'Google Drive'); break; } }
  await add('iCloud Drive', path.join(home, 'iCloudDrive'));
  await add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'iCloud Drive');
  await add('Box', path.join(home, 'Box'));
  await add('MEGA', path.join(home, 'MEGA'));
  await add('MEGA', path.join(home, 'Documents', 'MEGAsync'), 'MEGA');
  await add('Nextcloud', path.join(home, 'Nextcloud'));
  await add('pCloud', 'P:\\', 'pCloud Drive').catch(() => {});
  await add('Proton Drive', path.join(home, 'Proton Drive'));
  await add('Sync.com', path.join(home, 'Sync'));
  return out;
});

// ---------- features (extensions) ----------
on('ext:fetch', async (e, url, o = {}) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https addresses');
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await net.fetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body, signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, text: buf.subarray(0, 5 * 1048576).toString('utf8'), headers: Object.fromEntries(r.headers.entries()) };
  } finally { clearTimeout(to); }
});
// the feature guide (FEATURES.md) copied next to the user's features so Notepad can open it like any file
on('docs:featureGuide', async () => {
  const dir = path.join(app.getPath('userData'), 'Features');
  await fsp.mkdir(dir, { recursive: true });
  const dst = path.join(dir, 'Feature guide.md');
  await fsp.writeFile(dst, await fsp.readFile(path.join(__dirname, '..', 'renderer', 'assets', 'FEATURES.md')));
  return dst;
});
// feature log: what features print and the errors they hit, shown in Notepad's API reference (Log)
const extLogs = [];
on('ext:log', async (e, entry) => { extLogs.push(entry); if (extLogs.length > 500) extLogs.splice(0, extLogs.length - 500); broadcast('ext:log', entry); return true; });
on('ext:logs', async () => extLogs.slice());
on('ext:clearLogs', async () => { extLogs.length = 0; broadcast('ext:log', { clear: true }); return true; });
// a feature made in Notepad (another window) is installed by the main window, which asks first
on('ext:install', async (e, payload) => { for (const w of allWindows()) if (w.toolKind == null && !w.isDestroyed()) { w.webContents.send('ext:install', payload); w.focus(); break; } return true; });
// secrets for accounts (feature browser): encrypted with Windows data protection
on('secret:set', async (e, name, value) => { const all = store.get('secrets') || {}; if (!value) delete all[name]; else all[name] = safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(value).toString('base64') : 'p:' + Buffer.from(value).toString('base64'); store.set('secrets', all); return true; });
const getSecretValue = (name) => { const v = (store.get('secrets') || {})[name]; if (!v) return ''; try { return v.startsWith('e:') ? safeStorage.decryptString(Buffer.from(v.slice(2), 'base64')) : Buffer.from(v.slice(2), 'base64').toString(); } catch { return ''; } };
on('secret:has', async (e, name) => !!getSecretValue(name));
// GitHub (feature browser): only api.github.com and raw files; the token never reaches the page
on('gh:request', async (e, method, pathOrUrl, body, auth = true) => {
  const url = /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(pathOrUrl) ? pathOrUrl : 'https://api.github.com' + pathOrUrl;
  if (!/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(url)) throw new Error('Not a GitHub address');
  const headers = { 'User-Agent': 'AtlasFiles', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const tok = auth ? getSecretValue('github') : '';
  if (tok && url.startsWith('https://api.github.com')) headers.Authorization = 'Bearer ' + tok;
  if (body != null) headers['Content-Type'] = 'application/json';
  const r = await net.fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json, text: json ? null : text.slice(0, 2 * 1048576) };
});

// ---------- documents (previews, assistant) ----------
const doctext = require('./doctext');
on('doc:read', async (e, p, o) => doctext.read(p, o || {}));
on('doc:text', async (e, p, n) => doctext.text(p, n || 20000));
on('doc:titles', async (e, paths) => { const out = []; for (const p of (paths || []).slice(0, 500)) out.push(await doctext.title(p)); return out; });
on('doc:setProps', async (e, p, props) => doctext.setProps(p, props || {}));

// ---------- versions ----------
const versions = require('./versions');
let versionsReady = false;
function ensureVersions() { if (!versionsReady) { versionsReady = true; versions.init(path.join(app.getPath('userData'), 'versions'), { keep: settingsCache.versionsKeep || 20, maxTotalMB: settingsCache.versionsMaxMB || 5000 }); } }
on('versions:save', async (e, p, note) => { ensureVersions(); return versions.save(p, note || ''); });
on('versions:list', async (e, p) => { ensureVersions(); return versions.list(p); });
on('versions:restore', async (e, p, id, o) => { ensureVersions(); return versions.restore(p, id, o || {}); });
on('versions:remove', async (e, p, id) => { ensureVersions(); return versions.remove(p, id); });
on('versions:overview', async () => { ensureVersions(); return versions.overview(); });
on('versions:track', async (e, paths) => { ensureVersions(); versions.track(paths); return true; });

// ---------- watched videos / played songs ----------
on('watched:add', async (e, p) => { const w = store.get('watched') || {}; w[p] = Date.now(); const k = Object.keys(w); if (k.length > 20000) for (const x of k.sort((a, b) => w[a] - w[b]).slice(0, k.length - 20000)) delete w[x]; store.set('watched', w); return true; });
on('watched:get', async () => store.get('watched') || {});

// ---------- store ----------
on('store:get', async (e, n) => store.get(n));
on('store:set', async (e, n, v) => {
  if (n === 'settings') {
    const idxChanged = JSON.stringify([settingsCache.indexEnabled, settingsCache.indexRoots]) !== JSON.stringify([v.indexEnabled, v.indexRoots]);
    settingsCache = v;
    if (idxChanged) setTimeout(() => configureIndex(true).catch(() => {}), 50); nativeTheme.themeSource = v.theme || 'system';
    for (const w of allWindows()) if (IS_WIN && w.toolKind !== 'player' && w.toolKind !== 'viewer') try { w.setTitleBarOverlay({ ...themeColors(), height: 40 }); } catch {}
    ops.configure({ sequential: !!v.sequentialOps, throttle: +v.throttleMBps || 0, networkQueue: v.networkQueue !== false });
    if (versionsReady) versions.configure({ keep: v.versionsKeep || 20, maxTotalMB: v.versionsMaxMB || 5000 });
    const r = store.set(n, v);
    for (const w of allWindows()) if (w.webContents !== e.sender) w.webContents.send('settings:changed', v);
    return r;
  }
  return store.set(n, v);
});
on('store:path', async () => app.getPath('userData'));

// ---------- default explorer ----------
on('default:get', async () => win.isDefault(process.execPath));
on('default:set', async (e, enable) => win.setDefault(process.execPath, enable));

// ---------- windows & theme ----------
on('win:new', async (e, launch) => { createWindow(launch || {}); return true; });
on('win:control', async (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === 'min') w.minimize();
  else if (action === 'max') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === 'close') w.close();
  else if (action === 'devtools') w.webContents.toggleDevTools();
  else if (action === 'fullscreen') w.setFullScreen(!w.isFullScreen());
  else if (action === 'quit') { quitting = true; app.quit(); }
  else if (action === 'ontop') { w.setAlwaysOnTop(!w.isAlwaysOnTop()); return w.isAlwaysOnTop(); }
  else if (action === 'isFullscreen') return w.isFullScreen();
  else if (action === 'focus') { w.show(); w.focus(); }
  return w.isMaximized();
});
on('win:overlay', async (e, colors) => { const w = BrowserWindow.fromWebContents(e.sender); if (IS_WIN && w) try { w.setTitleBarOverlay({ ...colors, height: 40 }); } catch {} return true; });
on('win:zoom', async (e, f) => { e.sender.setZoomFactor(f); return true; });
on('theme:get', async () => ({ dark: nativeTheme.shouldUseDarkColors, accent: IS_WIN ? require('electron').systemPreferences.getAccentColor?.() : null }));
on('dialog:pickFolder', async (e, title) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
on('dialog:openFiles', async (e, opts = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
on('dialog:saveFile', async (e, opts = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(w, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
  return r.canceled ? null : r.filePath;
});
on('dialog:confirm', async (e, opts) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(w, { type: opts.type || 'question', buttons: opts.buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 1), title: opts.title || 'Atlas', message: opts.message, detail: opts.detail, noLink: true });
  return r.response;
});

// ---------- tools ----------
on('tool:open', async (e, kind, files, opts) => { openTool(kind, files || [], opts || {}); return true; });
on('tool:pending', async (e) => { const w = BrowserWindow.fromWebContents(e.sender); const p = w?.pending; if (w) w.pending = null; return p; });
on('media:probe', async (e, p) => media.probe(p));
on('media:imgMeta', async (e, paths) => require('./imgmeta').meta(paths || []));
// light probe for many files at once: duration + size of videos / songs (gallery, duration filters, columns)
on('media:quickProbe', async (e, paths) => {
  const out = [];
  for (const p of (paths || []).slice(0, 64)) {
    try { const i = await media.probe(p); const v = (i.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)); out.push({ dur: parseFloat(i.format?.duration) || 0, w: v?.width || 0, h: v?.height || 0, rot: Math.abs(parseInt(v?.tags?.rotate || (v?.side_data_list || []).find((d) => d.rotation != null)?.rotation || 0, 10)) }); }
    catch { out.push({}); }
  }
  return out;
});
// video contact sheet: a grid of frames saved as a JPG next to the video
on('media:contactSheet', async (e, file, o = {}) => {
  const info = await media.probe(file);
  const dur = parseFloat(info.format?.duration) || 0;
  if (!dur) throw new Error('Can’t read the length of this video');
  const cols = o.cols || 4, rows = o.rows || 4, n = cols * rows, w = o.width || 360;
  const out = o.out || file.replace(/\.[^.\\/]+$/, '') + ' - contact sheet.jpg';
  const fps = n / Math.max(1, dur * 0.96);
  await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pr = spawn(media.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(dur * 0.02, 5)), '-i', file, '-vf', `fps=${fps.toFixed(6)},scale=${w}:-2,drawtext=text='%{pts\\:hms}':x=8:y=h-th-8:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4,tile=${cols}x${rows}:padding=6:margin=6:color=0x1b1b1d`, '-frames:v', '1', '-q:v', '3', out], { windowsHide: true });
    let err = ''; pr.stderr.on('data', (d) => { err += d; });
    pr.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed'))));
    pr.on('error', reject);
  }).catch(async (err) => {
    // some ffmpeg builds have no drawtext (no fonts): try again without timestamps
    if (!/drawtext|Font|font/i.test(err.message)) throw err;
    await new Promise((resolve, reject) => { const { spawn } = require('child_process'); const pr = spawn(media.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `fps=${fps.toFixed(6)},scale=${w}:-2,tile=${cols}x${rows}:padding=6:margin=6:color=0x1b1b1d`, '-frames:v', '1', '-q:v', '3', out], { windowsHide: true }); pr.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg failed')))); pr.on('error', reject); });
  });
  return out;
});
on('media:encoder', async () => media.bestEncoder());
on('media:shotDir', async () => media.screenshotTo());
on('media:export', async (e, o) => media.exportMedia(o));
const tags = require('./tags');
const ai = require('./ai');
on('ai:status', async () => ai.status());
on('ai:download', async (e, k) => ai.download(k));
on('ai:remove', async (e, k) => ai.remove(k));
on('ai:cacheGet', async (e, k, keys) => ai.cacheGet(k, keys));
on('ai:cacheSet', async (e, k, entries) => ai.cacheSet(k, entries));
on('tags:read', async (e, p) => tags.read(p));
on('tags:write', async (e, p, changes, cover) => tags.write(p, changes, cover));
on('tags:lookup', async (e, q) => tags.lookup(q));
on('tags:identify', async (e, p, key) => tags.identify(p, key));
on('tags:fetchArt', async (e, url) => tags.fetchArt(url));
on('media:job', async (e, id) => media.jobStatus(id));
on('media:cancel', async (e, id) => media.cancelJob(id));
on('fs:trash', async (e, p) => { await shell.trashItem(p); return true; });
on('fs:copyFile', async (e, a, b) => { await fsp.copyFile(a, b); return b; });
on('fs:writeDataUrl', async (e, p, dataUrl) => { await fsp.writeFile(p, Buffer.from(dataUrl.split(',')[1], 'base64')); return p; });

// Text files with encodings (Atlas Notepad)
on('fs:readBuffer', async (e, p, max = 64 * 1024 * 1024) => {
  const st = await fsp.stat(p);
  if (st.size > max) throw new Error(`File is too large to edit (${Math.round(st.size / 1048576)} MB)`);
  const buf = await fsp.readFile(p);
  return { data: buf.toString('base64'), mtime: st.mtimeMs, size: st.size, readonly: !(st.mode & 0o200) };
});
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function encodeText(text, enc) {
  if (enc === 'utf8') return Buffer.from(text, 'utf8');
  if (enc === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf16be') { const b = Buffer.from(text, 'utf16le'); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; } return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
  // windows-1252 / latin1
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) { const c = ch.codePointAt(0); out[n++] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252[c] ?? 0x3f; }
  return out.subarray(0, n);
}
on('fs:writeEncoded', async (e, p, text, enc) => { await fsp.writeFile(p, encodeText(text, enc || 'utf8')); const st = await fsp.stat(p); return { mtime: st.mtimeMs, size: st.size }; });
const fileWatchers = new Map();
// a file opened from inside an archive: when it's saved, put it back into the archive automatically
const archiveEdits = new Map();
on('archive:watchEdit', async (e, file, arc, inner) => {
  if (archiveEdits.has(file)) return true;
  const sender = e.sender;
  let last = 0;
  try { last = fs.statSync(file).mtimeMs; } catch { return false; }
  const check = debounce(() => {
    let m = 0; try { m = fs.statSync(file).mtimeMs; } catch { return; }
    if (m === last) return;
    last = m;
    const id = ops.start({ type: 'archiveAdd', sources: [file], dest: arc, opts: { inner }, title: `Updating ${path.basename(file)} in ${path.basename(arc)}` });
    if (!sender.isDestroyed()) sender.send('archive:updated', { file, arc, id });
  }, 700);
  fs.watchFile(file, { interval: 1000 }, check);
  archiveEdits.set(file, check);
  return true;
});
app.on('before-quit', () => { for (const f of archiveEdits.keys()) fs.unwatchFile(f); });
on('fs:watchFile', async (e, p, on) => {
  const k = e.sender.id + '|' + p;
  if (fileWatchers.has(k)) { try { fileWatchers.get(k).close(); } catch {} fileWatchers.delete(k); }
  if (!on) return true;
  try {
    const sender = e.sender;
    const fire = debounce(() => { if (!sender.isDestroyed()) sender.send('file:changed', p); }, 300);
    const w = fs.watch(p, { persistent: false }, fire); w.on('error', () => {}); fileWatchers.set(k, w);
  } catch {}
  return true;
});

// ---------- phones / cameras (MTP) ----------
on('mtp:list', async (e, p) => win.mtpList(p));
on('mtp:copyOut', async (e, paths, dest) => win.mtpCopyOut(paths, dest));
on('mtp:copyIn', async (e, paths, dest) => win.mtpCopyIn(paths, dest));
on('mtp:delete', async (e, paths) => win.mtpDelete(paths));
on('mtp:mkdir', async (e, dir, name) => win.mtpMkdir(dir, name));
on('mtp:rename', async (e, p, name) => win.mtpRename(p, name));
on('mtp:fetch', async (e, p) => {
  const dir = path.join(app.getPath('temp'), 'atlas-mtp', crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const [out] = await win.mtpCopyOut([p], dir);
  return out;
});

// ---------- file locks ----------
// Windows 11 window corner style (DWMWA_WINDOW_CORNER_PREFERENCE)
async function applyWindowCorners(w, pref) {
  if (!IS_WIN || !w || w.isDestroyed()) return;
  const hwnd = w.getNativeWindowHandle();
  const ptr = hwnd.length >= 8 ? hwnd.readBigUInt64LE(0).toString() : String(hwnd.readUInt32LE(0));
  const val = { square: 1, round: 2, small: 3 }[pref] || 0;
  await win.ps.json(`if (-not ('AtlasNs.Dwm' -as [type])) { Add-Type -Namespace AtlasNs -Name Dwm -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(System.IntPtr hwnd, int attr, ref int val, int size);' }; $v = ${val}; [void][AtlasNs.Dwm]::DwmSetWindowAttribute([System.IntPtr]${ptr}, 33, [ref]$v, 4); '{}'`).catch(() => {});
}
function cornerPref() { const c = settingsCache.corners || {}; return c.window === false ? 'square' : (c.radius ?? 8) >= 6 ? 'round' : 'small'; }
on('win:corners', async (e, pref) => { for (const w of allWindows()) await applyWindowCorners(w, pref); return true; });
on('net:discover', async (e, force) => win.discoverNetwork(force));
on('net:open', async (e, name) => win.openNetworkItem(name));
on('locks:who', async (e, paths) => win.whoLocks(paths));
on('locks:kill', async (e, pid) => win.killProcess(pid));
on('shellverbs:set', async (e, enable) => win.setShellVerbs(process.execPath, enable));

// ---------- embedded terminal (ConPTY via node-pty) ----------
let ptyMod = null;
function loadPty() { if (ptyMod === null) { try { ptyMod = require('node-pty'); } catch (err) { console.error('node-pty unavailable', err.message); ptyMod = false; } } return ptyMod; }
const ptys = new Map();
let ptySeq = 1;
on('pty:available', async () => !!loadPty());
on('pty:spawn', async (e, opts = {}) => {
  const pty = loadPty();
  if (!pty) throw new Error('Terminal component is not available');
  const kind = opts.shell || 'powershell';
  let file, args;
  if (IS_WIN) {
    if (kind === 'cmd') { file = 'cmd.exe'; args = ['/K', 'prompt $e]9;9;"$P"$e\\$P$G']; }
    else {
      file = kind === 'pwsh' && (await win.which('pwsh.exe')) ? 'pwsh.exe' : 'powershell.exe';
      args = ['-NoLogo', '-NoExit', '-Command', 'function prompt { $e=[char]27; $p=$PWD.ProviderPath; "$e]9;9;`"$p`"$([char]7)PS $p> " }'];
    }
  } else {
    file = process.env.SHELL || '/bin/bash';
    args = [];
  }
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (!IS_WIN) env.PROMPT_COMMAND = 'printf "\\033]9;9;\\"%s\\"\\007" "$PWD"';
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols || 100, rows: opts.rows || 24, cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : app.getPath('home'), env, useConpty: true });
  const id = ptySeq++;
  const sender = e.sender;
  ptys.set(id, { p, sender: sender.id });
  p.onData((d) => { if (!sender.isDestroyed()) sender.send('pty:data', { id, d }); });
  p.onExit(({ exitCode }) => { ptys.delete(id); if (!sender.isDestroyed()) sender.send('pty:exit', { id, exitCode }); });
  return { id, shell: kind };
});
on('pty:write', async (e, id, d) => { ptys.get(id)?.p.write(d); return true; });
on('pty:resize', async (e, id, cols, rows) => { try { ptys.get(id)?.p.resize(Math.max(2, cols), Math.max(2, rows)); } catch {} return true; });
on('pty:kill', async (e, id) => { try { ptys.get(id)?.p.kill(); } catch {} ptys.delete(id); return true; });

on('test:capture', async (e, file) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const img = await w.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  return true;
});

ipcMain.handle('invoke', async (e, name, ...args) => {
  const h = handlers[name];
  if (!h) throw new Error(`Unknown channel ${name}`);
  return h(e, ...args);
});

// Native drag-out (to Explorer, desktop, email, other apps) and between our own panes.
const dragIcon = () => nativeImage.createFromPath(path.join(RENDERER, 'assets', 'drag.png'));
ipcMain.on('drag:start', (e, paths) => {
  try { e.sender.startDrag({ files: paths, file: paths[0], icon: dragIcon() }); } catch (err) { console.error(err); }
});

nativeTheme.on('updated', () => {
  for (const w of windows) if (!w.isDestroyed()) {
    w.webContents.send('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
    if (IS_WIN) try { w.setTitleBarOverlay(themeColors()); } catch {}
  }
});

// ---------------- drive / device hot-plug ----------------
let driveSig = '';
function startDriveWatch() {
  let n = 0;
  const tick = async () => {
    try {
      const letters = [];
      if (IS_WIN) { for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { await fsp.access(d); letters.push(d[0]); } catch {} } }
      else { for (const b of ['/mnt', '/media']) { try { letters.push(...(await fsp.readdir(b))); } catch {} } }
      let devs = '';
      if (IS_WIN && n % 3 === 0) devs = (await win.portableDevices().catch(() => [])).map((d) => d.name).join(',');
      else devs = driveSig.split('#')[1] || '';
      const sig = letters.join('') + '#' + devs;
      if (driveSig && sig !== driveSig) broadcast('drives:changed', {});
      driveSig = sig;
    } catch {}
    n++;
    setTimeout(tick, 2500);
  };
  tick();
}

// ---------------- app lifecycle ----------------
const gotLock = TEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (e, argv) => {
    const launch = parseLaunchArgs(argv.slice(1));
    if (launch.edit.length) openTool('editor', launch.edit);
    if (launch.play.length) openTool('player', launch.play, { play: true });
    if (launch.view.length) openTool('viewer', launch.view, { autoPlaylist: launch.view.length === 1 });
    if (launch.edit.length || launch.play.length || launch.view.length) { if (!launch.path) return; }
    openPathAnywhere(launch);
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = settingsCache.theme || 'system';
    ops.configure({ sequential: !!settingsCache.sequentialOps, networkQueue: settingsCache.networkQueue !== false });
    registerProtocol();
    Menu.setApplicationMenu(null);
    const launch = parseLaunchArgs(ARGS);
    if (TEST_MODE && process.env.ATLAS_TEST_TOOL) {
      openTool(process.env.ATLAS_TEST_TOOL, JSON.parse(process.env.ATLAS_TEST_FILES || '[]'), { play: true });
    } else {
      if (launch.edit.length) openTool('editor', launch.edit);
      if (launch.play.length) openTool('player', launch.play, { play: true });
      if (launch.view.length) openTool('viewer', launch.view, { autoPlaylist: launch.view.length === 1 });
      if (!(launch.edit.length || launch.play.length || launch.view.length) || launch.path) createWindow(launch);
    }
    if (settingsCache.keepRunning) ensureTray();
    startDriveWatch();
    setTimeout(() => configureIndex(true).catch(() => {}), 1500);
  });
  app.on('before-quit', () => { quitting = true; core.stop(); media.killAll(); for (const t of ptys.values()) { try { t.p.kill(); } catch {} } win.ps.dispose(); });
  app.on('window-all-closed', () => { if (!settingsCache.keepRunning || quitting) app.quit(); });
}
