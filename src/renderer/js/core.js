// Core: IPC bridge, path helpers, formatting, settings/state persistence and a tiny event bus.
// File / folder pickers and message boxes are Dogfile's own (see picker.js) unless "Use Windows dialogs" is on.
const PICKERS = { 'dialog:pickFolder': (m, a) => m.pickFolder(a[0], { pinned: (typeof state !== 'undefined' && state.pinned) || undefined, ...(a[1] || {}) }), 'dialog:openFiles': (m, a) => m.openFiles(a[0] || {}), 'dialog:saveFile': (m, a) => m.saveFile(a[0] || {}), 'dialog:confirm': (m, a) => m.messageBox(a[0] || {}) };
let nativeDialogs = null;
export const setNativeDialogs = (v) => { nativeDialogs = !!v; };
export const api = (name, ...args) => {
  if (PICKERS[name] && !nativeDialogs) return import('./picker.js').then((m) => PICKERS[name](m, args));
  return window.atlas.invoke(name, ...args);
};
export const onMain = (ch, fn) => window.atlas.on(ch, fn);

export const sys = { platform: 'win32', sep: '\\', known: {} };
export const IS_WIN = () => sys.platform === 'win32';

// ---------------- event bus ----------------
const subs = new Map();
export const bus = {
  on(ev, fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); return () => subs.get(ev).delete(fn); },
  emit(ev, data) { (subs.get(ev) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};
if (typeof window !== 'undefined') window.__atlasBus = bus;

// ---------------- paths ----------------
export const isVirtual = (p) => typeof p === 'string' && p.startsWith('atlas:');
export const isMtp = (p) => typeof p === 'string' && p.startsWith('atlas:mtp|');
// saved SFTP / FTP connections: atlas:remote|<id>|/path
export const isRemote = (p) => typeof p === 'string' && p.startsWith('atlas:remote|');
export function remoteParts(p) { const i = p.indexOf('|'), j = p.indexOf('|', i + 1); return { id: p.slice(i + 1, j), path: p.slice(j + 1) || '/' }; }
export const remoteConn = (id) => (state.settings.connections || []).find((c) => c.id === id);
export function mtpParts(p) { const i = p.indexOf('|'), j = p.indexOf('|', i + 1); return { dev: p.slice(i + 1, j), rest: p.slice(j + 1) }; }
export function pjoin(dir, name) {
  if (!dir) return name;
  const s = sys.sep;
  return dir.endsWith(s) || dir.endsWith('/') ? dir + name : dir + s + name;
}
export function isRoot(p) {
  if (IS_WIN()) return /^[a-zA-Z]:\\?$/.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p) || /^\\\\[^\\]+\\?$/.test(p);
  return p === '/';
}
export function normalize(p) {
  if (!p || isVirtual(p)) return p;
  if (IS_WIN()) {
    p = p.replace(/\//g, '\\');
    if (/^[a-zA-Z]:$/.test(p)) return p.toUpperCase() + '\\';
    if (/^[a-zA-Z]:\\/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    if (p.length > 3 && p.endsWith('\\') && !/^\\\\[^\\]+\\?$/.test(p)) p = p.replace(/\\+$/, '');
    return p;
  }
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}
export function dirname(p) {
  if (isRemote(p)) { const { id, path } = remoteParts(p); if (path === '/' || !path) return 'atlas:network'; const parts = path.split('/').filter(Boolean); parts.pop(); return `atlas:remote|${id}|/${parts.join('/')}`; }
  if (isMtp(p)) { const { dev, rest } = mtpParts(p); if (!rest) return 'atlas:thispc'; const parts = rest.split('/').filter(Boolean); parts.pop(); return `atlas:mtp|${dev}|${parts.join('/')}`; }
  if (!p || isVirtual(p)) return null;
  p = normalize(p);
  if (isRoot(p)) {
    if (IS_WIN() && /^\\\\[^\\]+\\[^\\]+/.test(p)) return p.match(/^\\\\[^\\]+/)[0];
    return IS_WIN() ? 'atlas:thispc' : null;
  }
  const s = sys.sep;
  const i = p.lastIndexOf(s);
  if (i < 0) return null;
  let d = p.slice(0, i);
  if (IS_WIN() && /^[a-zA-Z]:$/.test(d)) d += '\\';
  if (!IS_WIN() && d === '') d = '/';
  if (IS_WIN() && /^\\\\[^\\]+$/.test(d)) return d;
  return d;
}
export function basename(p) {
  if (!p) return '';
  if (isVirtual(p)) return virtualTitle(p);
  p = normalize(p);
  if (IS_WIN() && /^[a-zA-Z]:\\$/.test(p)) return p.slice(0, 2);
  if (p === '/') return '/';
  const i = p.lastIndexOf(sys.sep);
  return i >= 0 ? p.slice(i + 1) : p;
}
export function extname(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
export function stem(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; }
export function samePath(a, b) { if (!a || !b) return false; return IS_WIN() ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b); }
export function isInside(child, parent) {
  if (!child || !parent || isVirtual(child) || isVirtual(parent)) return false;
  const c = IS_WIN() ? normalize(child).toLowerCase() : normalize(child);
  let pp = IS_WIN() ? normalize(parent).toLowerCase() : normalize(parent);
  if (!pp.endsWith(sys.sep)) pp += sys.sep;
  return c.startsWith(pp);
}
export function splitPath(p) {
  // returns [{label, path}] crumbs
  if (isMtp(p)) {
    const { dev, rest } = mtpParts(p);
    const crumbs = [{ label: 'This PC', path: 'atlas:thispc' }, { label: dev, path: `atlas:mtp|${dev}|` }];
    let acc = '';
    for (const part of rest.split('/').filter(Boolean)) { acc = acc ? acc + '/' + part : part; crumbs.push({ label: part, path: `atlas:mtp|${dev}|${acc}` }); }
    return crumbs;
  }
  if (isRemote(p)) {
    const { id, path } = remoteParts(p);
    const c = remoteConn(id);
    const crumbs = [{ label: 'Network', path: 'atlas:network' }, { label: c?.name || c?.host || 'Server', path: `atlas:remote|${id}|/` }];
    let acc = '';
    for (const part of path.split('/').filter(Boolean)) { acc += '/' + part; crumbs.push({ label: part, path: `atlas:remote|${id}|${acc}` }); }
    return crumbs;
  }
  if (isVirtual(p)) {
    if (p.startsWith('atlas:zip|')) {
      const [, arc, inner] = p.split('|');
      const crumbs = splitPath(arc);
      let acc = '';
      for (const part of (inner || '').split('/').filter(Boolean)) { acc = acc ? acc + '/' + part : part; crumbs.push({ label: part, path: `atlas:zip|${arc}|${acc}` }); }
      return crumbs;
    }
    return [{ label: virtualTitle(p), path: p }];
  }
  p = normalize(p);
  const out = [];
  if (IS_WIN()) {
    if (p.startsWith('\\\\')) {
      const parts = p.slice(2).split('\\').filter(Boolean);
      out.push({ label: 'Network', path: 'atlas:network' });
      let acc = '\\\\' + parts[0];
      out.push({ label: parts[0], path: acc });
      for (const part of parts.slice(1)) { acc += '\\' + part; out.push({ label: part, path: acc }); }
      return out;
    }
    out.push({ label: 'This PC', path: 'atlas:thispc' });
    const parts = p.split('\\').filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => { acc = i === 0 ? part + '\\' : pjoin(acc, part); out.push({ label: i === 0 ? driveLabel(part) : part, path: acc }); });
    return out;
  }
  out.push({ label: '/', path: '/' });
  let acc = '';
  for (const part of p.split('/').filter(Boolean)) { acc += '/' + part; out.push({ label: part, path: acc }); }
  return out;
}
let driveNames = {};
export function setDriveNames(m) { driveNames = m; }
function driveLabel(part) { return driveNames[part.toUpperCase()] || part; }

export function virtualTitle(p) {
  if (p === 'atlas:home') return 'Home';
  if (p === 'atlas:thispc') return 'This PC';
  if (p === 'atlas:recent') return 'Recent';
  if (p === 'atlas:recycle') return 'Recycle Bin';
  if (p === 'atlas:network') return 'Network';
  if (p === 'atlas:settings') return 'Settings';
  if (p.startsWith('atlas:tag:')) { const t = state.tags.defs.find((d) => d.id === p.slice(10)); return t ? t.name : 'Tag'; }
  if (p.startsWith('atlas:search')) { const q = new URLSearchParams(p.split('?')[1] || ''); if (q.get('assist')) return `Assistant: ${q.get('q') || ''}`; if (q.get('coll')) return (state.settings.collections || []).find((c) => c.id === q.get('coll'))?.name || 'Collection'; if (q.get('flatten')) return `Flattened: ${basename((q.get('root') || '').split('|')[0])}`; if (q.get('ai')) return `AI: ${q.get('q') || '…'}`; return `Search: ${q.get('q') || q.get('content') || '…'}`; }
  if (p.startsWith('atlas:zip|')) { const [, arc, inner] = p.split('|'); return inner ? inner.split('/').pop() : basename(arc); }
  if (isMtp(p)) { const { dev, rest } = mtpParts(p); return rest ? rest.split('/').filter(Boolean).pop() : dev; }
  if (isRemote(p)) { const { id, path } = remoteParts(p); return path.split('/').filter(Boolean).pop() || remoteConn(id)?.name || 'Server'; }
  if (p.startsWith('atlas:search')) return 'Search';
  return p;
}

// Expand %ENV% / ~ / shell: aliases typed into the address bar
export function expandUserPath(input) {
  let s = input.trim().replace(/^"|"$/g, '');
  const k = sys.known;
  const aliases = {
    'shell:desktop': k.desktop, 'shell:downloads': k.downloads, 'shell:personal': k.documents, 'shell:documents': k.documents,
    'shell:my pictures': k.pictures, 'shell:pictures': k.pictures, 'shell:my music': k.music, 'shell:music': k.music, 'shell:my video': k.videos,
    'shell:videos': k.videos, 'shell:appdata': k.appData, 'shell:recent': k.recentWin, 'shell:profile': k.home, 'shell:onedrive': k.onedrive,
    'shell:mycomputerfolder': 'atlas:thispc', 'shell:recyclebinfolder': 'atlas:recycle', 'shell:startup': k.appData && pjoin(k.appData, 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'),
    'shell:sendto': k.appData && pjoin(k.appData, 'Microsoft\\Windows\\SendTo'), 'shell:start menu': k.appData && pjoin(k.appData, 'Microsoft\\Windows\\Start Menu'),
    'this pc': 'atlas:thispc', 'recycle bin': 'atlas:recycle', home: 'atlas:home', network: 'atlas:network', recent: 'atlas:recent',
  };
  const low = s.toLowerCase();
  if (aliases[low]) return aliases[low];
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = k.home + s.slice(1);
  s = s.replace(/%([^%]+)%/g, (m, v) => {
    const key = v.toUpperCase();
    const map = { USERPROFILE: k.home, APPDATA: k.appData, LOCALAPPDATA: k.appData && k.appData.replace(/Roaming$/i, 'Local'), TEMP: k.temp, TMP: k.temp, ONEDRIVE: k.onedrive, HOMEPATH: k.home, SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PROGRAMDATA: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };
    return map[key] || m;
  });
  if (s.startsWith('file:///')) s = decodeURIComponent(s.slice(IS_WIN() ? 8 : 7));
  return normalize(s);
}

// ---------------- formatting ----------------
export function fmtSize(n, opts = {}) {
  if (n == null || isNaN(n)) return '';
  const bin = (opts.units || state.settings.sizeUnits) !== 'decimal';
  const k = bin ? 1024 : 1000;
  const units = bin ? ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'] : ['bytes', 'kB', 'MB', 'GB', 'TB', 'PB'];
  if (n < k) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  let i = 0; let v = n;
  while (v >= k && i < units.length - 1) { v /= k; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
// Intl formatters are expensive to create, so they are made once; finished strings are remembered too
const DF = { date: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }), time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }) };
const dateMemo = new Map();
export function fmtDate(ms, style) {
  if (!ms) return '';
  style = style || state.settings.dateFormat;
  if (style !== 'relative') {
    const k = style + ms;
    let v = dateMemo.get(k);
    if (v === undefined) { v = fmtDateRaw(ms, style); if (dateMemo.size > 20000) dateMemo.clear(); dateMemo.set(k, v); }
    return v;
  }
  return fmtDateRaw(ms, style);
}
function fmtDateRaw(ms, style) {
  const d = new Date(ms);
  if (style === 'relative') {
    const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400 && new Date().getDate() === d.getDate()) return `Today, ${DF.time.format(d)}`;
    if (diff < 172800) return `Yesterday, ${DF.time.format(d)}`;
    if (diff < 7 * 86400) return d.toLocaleDateString([], { weekday: 'long' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (style === 'iso') { const z = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; }
  return DF.date.format(d) + ' ' + DF.time.format(d);
}
export function dateBucket(ms) {
  if (!ms) return 'Unknown';
  const now = new Date(); const d = new Date(ms);
  const day = 86400000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday) return 'Today';
  if (ms >= startToday - day) return 'Yesterday';
  if (ms >= startToday - 6 * day) return 'Earlier this week';
  if (ms >= startToday - 13 * day) return 'Last week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'long' });
  return String(d.getFullYear());
}
export function sizeBucket(n, isDir) {
  if (isDir) return 'Folders';
  if (n === 0) return 'Empty';
  if (n < 16 * 1024) return 'Tiny (0 – 16 KB)';
  if (n < 1024 * 1024) return 'Small (16 KB – 1 MB)';
  if (n < 128 * 1024 * 1024) return 'Medium (1 – 128 MB)';
  if (n < 1024 * 1024 * 1024) return 'Large (128 MB – 1 GB)';
  if (n < 4 * 1024 * 1024 * 1024) return 'Huge (1 – 4 GB)';
  return 'Gigantic (> 4 GB)';
}

export const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tif', 'tiff', 'heic', 'jfif', 'apng', 'raw', 'cr2', 'nef', 'dng', 'psd'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'm4v', 'flv', 'mpg', 'mpeg', 'ogv', '3gp', 'ts'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'mid', 'midi'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso', 'zst', 'lz', 'lzma', 'wim'],
  document: ['pdf', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'epub', 'pages', 'key', 'numbers'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'lua', 'swift', 'vue', 'svelte', 'dart', 'r', 'pl', 'gradle', 'dockerfile', 'makefile', 'log', 'env', 'gitignore', 'editorconfig'],
  executable: ['exe', 'msi', 'appx', 'msix', 'com', 'scr', 'lnk', 'url'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'fon'],
};
export const TEXT_EXTS = new Set([...KINDS.code, 'txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv', 'nfo', 'srt', 'vtt', 'ass', 'ssa', 'sub', 'reg', 'inf', 'properties', 'gitattributes', 'npmrc', 'license', 'readme', 'sln', 'csproj', 'vcxproj', 'plist', 'lock', 'diff', 'patch', 'tex', 'bib', 'rst', 'adoc', 'cue', 'm3u', 'm3u8', 'pls', 'url', 'desktop', 'service', 'rc', 'def', 'asm', 's', 'mk', 'cmake', 'proto', 'graphql', 'gql', 'tf', 'hcl', 'nix', 'zig', 'v', 'sv', 'vhd', 'kt', 'kts', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'elm', 'ml', 'fs', 'fsx', 'jl', 'nim', 'cr', 'pas', 'vb', 'vbs', 'au3', 'ahk', 'iss', 'nsi', 'json5', 'jsonc', 'ndjson', 'xaml', 'xsd', 'xsl', 'svelte', 'astro', 'mdx', 'hbs', 'ejs', 'pug', 'twig', 'liquid', 'csv']);
// every item gets its type from its name when whoever made it (a search, a virtual folder…) left it out
const ex = (it) => { if (it.ext == null) { const n = it.name || ''; const i = n.lastIndexOf('.'); it.ext = it.isDir ? '' : i > 0 ? n.slice(i + 1).toLowerCase() : ''; } return it.ext; };
export const isTextFile = (it) => !it.isDir && (TEXT_EXTS.has(ex(it)) || (!it.ext && /^(readme|license|changelog|makefile|dockerfile|authors|copying|todo)$/i.test(it.name)) || /^\.(gitignore|env|editorconfig|bashrc|zshrc|profile|npmrc|prettierrc|eslintrc|babelrc|dockerignore)/i.test(it.name));
export const isImageFile = (it) => !it.isDir && (KINDS.image.includes(ex(it)) || ['heif', 'jxl', 'tga', 'arw', 'orf', 'rw2', 'raf'].includes(it.ext));
export const isMediaFile = (it) => !it.isDir && (KINDS.video.includes(ex(it)) || KINDS.audio.includes(it.ext) || ['mka', 'ape', 'wv', 'tta', 'dts', 'ac3', 'eac3', 'amr', 'm2ts', 'mts', 'vob', 'divx', 'xvid', 'rm', 'rmvb', 'asf', 'f4v', 'ogm', 'm4b', 'caf', 'aif', 'aifc', 'mpc', 'spx', 'dsf', 'dff'].includes(it.ext));
const kindByExt = {};
for (const [k, list] of Object.entries(KINDS)) for (const e of list) kindByExt[e] = k;
export const kindOf = (item) => (item.isDir ? 'folder' : kindByExt[ex(item)] || 'other');
export function typeLabel(item) {
  if (item.isDir) return item.share ? 'Shared folder' : 'File folder';
  if (!ex(item)) return 'File';
  const named = { jpg: 'JPEG image', jpeg: 'JPEG image', png: 'PNG image', gif: 'GIF image', pdf: 'PDF document', txt: 'Text document', md: 'Markdown', zip: 'Compressed (zipped) folder', exe: 'Application', lnk: 'Shortcut', docx: 'Word document', xlsx: 'Excel worksheet', pptx: 'PowerPoint presentation', mp3: 'MP3 audio', mp4: 'MP4 video', js: 'JavaScript file', json: 'JSON file', html: 'HTML document', css: 'CSS stylesheet', py: 'Python file', dll: 'Application extension', svg: 'SVG image', webp: 'WebP image', '7z': '7-Zip archive', rar: 'RAR archive' };
  return named[item.ext] || `${item.ext.toUpperCase()} file`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const natCmp = (a, b) => collator.compare(a, b);

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
export const fileUrl = (p) => `/f/?p=${encodeURIComponent(p)}`;
export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------- settings & state ----------------
export const DEFAULT_SETTINGS = {
  theme: 'system', accent: '#3b82f6', density: 'comfortable', fontScale: 1, dialogJump: true, dialogJumpAuto: false,
  showHidden: false, showSystem: false, showExtensions: true, foldersFirst: true, showCheckboxes: false,
  defaultView: 'grid', gridSize: 160, gridLabels: 'smart', showPreview: false, previewWidth: 340,
  dateFormat: 'locale', sizeUnits: 'binary', folderSizes: false, rememberFolderViews: true,
  singleClick: false, doubleClickUp: true, typeAhead: 'select', confirmDelete: true, deleteToRecycle: true,
  startupPath: 'restore', terminal: 'auto', editor: '', keepRunning: false, openInNewWindow: false,
  useWindowsIcons: false, showThumbnails: true, gitBadges: true, hoverPreview: false, sequentialOps: false,
  ribbonPinned: false, sidebarWidth: 300, sidebarCollapsed: false, syncNavigation: false, restoreTabs: true,
  showStatusBar: true, smartExtract: true, closeLastTabClosesWindow: false, middleClickOpensTab: true,
  autoUpdates: true, sidebarSections: { quick: true, drives: true, network: true, tags: true, collections: false },
  warnExtChange: true, browseArchives: true, askOnDrop: false, newTabPath: 'home', fullCrumbs: false, useEverything: false, indexEnabled: true, indexRoots: [], indexMft: true, nativeEngine: true,
  openWithApps: [], networkPlaces: [], userTemplates: [], ribbonTab: 'home',
  corners: { radius: 8, tabs: false, tiles: true, controls: true, menus: true, dialogs: true, panels: true, items: true, window: true },
  colorPresets: {}, toolsInTabs: false, sidebarActions: false, useAtlasViewer: true, slideshowSeconds: 4, playerAnalyze: true, nativeDialogs: false, clickEmptyDeselects: true, mediaTheme: 'app', aiSearch: true, uiMode: 'full', welcomed: false, folderNotes: true,
  useAtlasEditor: true, useAtlasPlayer: true, playerAutoPlaylist: true, foldAnimation: true, sidebarGlass: false, shadowStrength: 1, colors: { light: {}, dark: {} },
  throttleMBps: 0, sizeBars: true, terminalSync: true, terminalShell: 'powershell', terminalHeight: 260, shelf: [],
  highlightRules: [
    { name: 'Changed in the last 10 minutes', type: 'recent', minutes: 10, color: '#30a46c', on: true },
    { name: 'Programs & scripts', type: 'pattern', pattern: '*.exe;*.msi;*.bat;*.cmd;*.ps1;*.vbs', color: '#c98a12', on: true },
  ],
  smartDrop: 'smart', batchConflicts: true, networkQueue: true, hoverFolderSize: true, mediaColumns: true, galleryNames: false,
  historyLimit: 1000, versionsKeep: 20, versionsMaxMB: 5000, trackedFiles: [], clipHistory: 'paths', clipRemember: false,
  focusRings: 'auto', a11yAnnounce: true, highContrast: false, reduceMotion: '', bigTargets: false,
  automations: [], connections: [], fileAssoc: {}, renamePresets: {}, profiles: {}, activeProfile: null, recentCommands: [],
  extensions: [], macros: [],
  keybindings: {}, customCommands: [], newFileTemplates: null, zoom: 1, columnWidths: null, visibleColumns: null,
};

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  tabs: [], layout: '1', panes: [], activePane: 0, paneSizes: { v: 0.5, h: 0.5 },
  closedTabs: [], clipboard: null, undo: [], redo: [],
  pinned: [], recent: [], recentFiles: [], tags: { defs: [], map: {} }, workspaces: {}, folderViews: {},
  drives: [], dark: false,
};

export const DEFAULT_TAGS = [
  { id: 'red', name: 'Red', color: '#e5484d' }, { id: 'orange', name: 'Orange', color: '#f76b15' },
  { id: 'yellow', name: 'Yellow', color: '#ffc53d' }, { id: 'green', name: 'Green', color: '#30a46c' },
  { id: 'blue', name: 'Blue', color: '#0090ff' }, { id: 'purple', name: 'Purple', color: '#8e4ec6' },
  { id: 'gray', name: 'Gray', color: '#8b8d98' },
];

const saveLater = {};
export function persist(name, getter, ms = 400) {
  clearTimeout(saveLater[name]);
  saveLater[name] = setTimeout(() => api('store:set', name, getter()), ms);
}
export function saveSettings() { persist('settings', () => state.settings, 150); }
export function saveLibrary() {
  persist('library', () => ({ pinned: state.pinned, recent: state.recent.slice(0, 60), recentFiles: state.recentFiles.slice(0, 80), workspaces: state.workspaces, folderViews: state.folderViews }));
}
export function saveTags() { persist('tags', () => state.tags); }

export function addRecent(p) {
  if (!p || isVirtual(p)) return;
  state.recent = [p, ...state.recent.filter((x) => !samePath(x, p))].slice(0, 60);
  saveLibrary();
}
export function addRecentFile(p) {
  state.recentFiles = [p, ...state.recentFiles.filter((x) => !samePath(x, p))].slice(0, 80);
  saveLibrary();
}

export function tagsOf(p) { return state.tags.map[IS_WIN() ? p.toLowerCase() : p] || []; }
export function setTags(paths, tagId, on) {
  for (const p of paths) {
    const k = IS_WIN() ? p.toLowerCase() : p;
    const cur = new Set(state.tags.map[k] || []);
    if (on === undefined) on = !cur.has(tagId);
    on ? cur.add(tagId) : cur.delete(tagId);
    if (cur.size) state.tags.map[k] = [...cur]; else delete state.tags.map[k];
  }
  saveTags();
  bus.emit('tags');
  if (state.settings.tagsInFiles) writeTagsIntoFiles(paths);
}
// the tags' names as the file's own keywords (Explorer's "Tags"), when that setting is on
export async function writeTagsIntoFiles(paths) {
  let failed = 0, last = '';
  for (const p of paths) {
    const k = IS_WIN() ? p.toLowerCase() : p;
    const names = (state.tags.map[k] || []).map((id) => state.tags.defs.find((d) => d.id === id)?.name).filter(Boolean);
    const r = await api('keywords:write', p, names).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { failed++; last = r?.error || ''; }
  }
  if (failed) toast(`${failed === paths.length ? 'Couldn’t' : `${failed} of ${paths.length}: couldn’t`} save the tags inside the file${failed > 1 ? 's' : ''}${last ? ` (${last})` : ''}`, { error: true });
}
export function moveTags(from, to) {
  const f = IS_WIN() ? from.toLowerCase() : from;
  const t = IS_WIN() ? to.toLowerCase() : to;
  let changed = false;
  for (const k of Object.keys(state.tags.map)) {
    if (k === f || k.startsWith(f + sys.sep)) { state.tags.map[t + k.slice(f.length)] = state.tags.map[k]; delete state.tags.map[k]; changed = true; }
  }
  if (changed) saveTags();
}

// ---------------- toasts ----------------
export function toast(msg, opts = {}) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: 'toast' + (opts.error ? ' error' : '') }, h('span', {}, msg));
  if (opts.action) el.append(h('button', { class: 'link', onclick: () => { opts.action.run(); el.remove(); } }, opts.action.label));
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, opts.ms || (opts.error ? 6000 : 3200));
}

// ---- background jobs (search, folder sizes, duplicates…): messages routed by job id ----
// A job's first messages can arrive before its id reaches the caller (answers and events travel separately),
// so messages for unknown ids are kept for a while and handed over when the caller starts listening.
const workHandlers = new Map();
const workEarly = new Map();
export function onWorkMsgFor(id, fn) {
  const h = (m) => { if (m.type === 'done' || m.type === 'error') workHandlers.delete(id); fn(m); };
  workHandlers.set(id, h);
  const q = workEarly.get(id);
  if (q) { workEarly.delete(id); for (const m of q) h(m); }
}
export function onWorkMsg(m) {
  const f = workHandlers.get(m.id);
  if (f) { f(m); return true; }
  if (!workEarly.has(m.id)) { workEarly.set(m.id, []); setTimeout(() => workEarly.delete(m.id), 30000); }
  workEarly.get(m.id).push(m);
  return false;
}
