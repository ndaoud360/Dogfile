// Extras: Drop Shelf (temporary file basket), embedded terminal drawer (ConPTY + xterm.js, synced with the active
// pane in both directions), and the "who is locking this file?" helper.
import { animatePanel } from './panelanim.js';
import { api, onMain, state, sys, bus, h, esc, isVirtual, isMtp, basename, dirname, samePath, toast, saveSettings, IS_WIN, debounce } from './core.js';
import { icon } from './icons.js';
import { activeTab, navigate, paneEls, attachDropTarget, currentDrag, selectedItems } from './pane.js';
import { showMenu } from './menu.js';
import { modal } from './dialogs.js';
import * as A from './actions.js';

const $ = (id) => document.getElementById(id);

export function initExtras() {
  const main = $('main');
  const status = $('statusbar');
  const shelf = h('div', { id: 'shelf' });
  const term = h('div', { id: 'term-drawer' });
  main.insertBefore(term, status);
  main.insertBefore(shelf, status);
  // status bar buttons
  const sb = h('button', { id: 'shelf-btn', class: 'icon-btn', title: 'Drop Shelf (Ctrl+Shift+J). Drag files here to collect them', html: icon('shelf') });
  const tb = h('button', { id: 'term-btn', class: 'icon-btn', title: 'Terminal (Ctrl+`)', html: icon('terminal') });
  status.insertBefore(tb, $('ops-btn'));
  status.insertBefore(sb, $('ops-btn'));
  sb.addEventListener('click', () => toggleShelf());
  tb.addEventListener('click', () => toggleTerminal());
  // dragging files over the shelf button opens the shelf
  // dropping files on the shelf button puts them on the shelf (and opens it)
  sb.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); sb.classList.add('drop-on'); } });
  sb.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } });
  sb.addEventListener('dragleave', () => sb.classList.remove('drop-on'));
  sb.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); sb.classList.remove('drop-on');
    let paths = [...(e.dataTransfer.files || [])].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (!paths.length) paths = currentDrag()?.paths || [];
    if (paths.length) addToShelf(paths); else toggleShelf(true);
  });
  renderShelf();
  bus.on('toggleShelf', () => toggleShelf());
  bus.on('addToShelf', (paths) => addToShelf(paths));
  bus.on('shelfChanged', () => { if (!rendering) renderShelf(); });
  bus.on('toggleTerminal', () => toggleTerminal());
  bus.on('runInTerminal', (o) => runInTerminal(o));
  bus.on('jobLocked', (j) => lockedToast(j));
  bus.on('whoLocks', (paths) => showLocks(paths));
  bus.on('loaded', (t) => syncTerminalTo(t));
  bus.on('activePane', () => syncTerminalTo(activeTab()));
}

// ======================================================================
// Drop Shelf
// ======================================================================
let shelfOpen = false;
function toggleShelf(force) {
  shelfOpen = force ?? !shelfOpen;
  const open = shelfOpen;
  animatePanel('shelf', $('shelf'), open, () => document.body.classList.toggle('shelf-open', open));
  $('shelf-btn')?.classList.toggle('on', shelfOpen);
}
function addToShelf(paths) {
  const cur = state.settings.shelf || [];
  const add = paths.filter((p) => p && !isVirtual(p) && !cur.some((x) => samePath(x, p)));
  state.settings.shelf = [...cur, ...add];
  saveSettings();
  renderShelf();
  toggleShelf(true);
  if (add.length) toast(`Added ${add.length} item${add.length > 1 ? 's' : ''} to the Drop Shelf`);
}
let rendering = false;
function renderShelf() {
  if (rendering) return;
  rendering = true;
  try { drawShelf(); } finally { rendering = false; }
}
function drawShelf() {
  const el = $('shelf');
  if (!el) return;
  const items = state.settings.shelf || [];
  el.innerHTML = '';
  const head = h('div', { class: 'shelf-head' },
    h('span', { class: 'shelf-title', html: `${icon('shelf')}<span>Drop Shelf</span>` }),
    h('span', { class: 'hint' }, items.length ? `${items.length} item${items.length > 1 ? 's' : ''} · drag in from anywhere, then act on them all at once` : 'Drag files and folders here from any folder or pane to collect them'),
    h('span', { class: 'st-spacer' }),
    h('button', { class: 'btn small primary', disabled: !items.length, title: 'Everything you can do with the files on the shelf (or just the selected ones)', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); shelfActions(shelfTargets(), r.left, r.top); } }, shelfSel.size ? `Actions (${shelfSel.size})` : 'Actions'),
    h('button', { class: 'btn small with-ic', disabled: !items.length, title: 'Tell the Assistant what to do with these files: rename, resize, convert, play…', html: `${icon('sparkle')}<span>Ask the Assistant</span>`, onclick: () => import('./assistant.js').then((m) => m.setShelfMode(true)) }),
    h('button', { class: 'btn small', disabled: !items.length, onclick: () => dump('copy') }, 'Copy here'),
    h('button', { class: 'btn small', disabled: !items.length, onclick: () => dump('move') }, 'Move here'),
    h('button', { class: 'btn small', disabled: !items.length, onclick: () => { A.copy(items.map((p) => ({ path: p, name: basename(p) }))); } }, 'Copy to clipboard'),
    h('button', { class: 'btn small', disabled: !items.length, onclick: () => { state.settings.shelf = []; saveSettings(); renderShelf(); } }, 'Clear'),
    h('button', { class: 'icon-btn small', title: 'Hide', html: icon('close'), onclick: () => toggleShelf(false) }));
  const list = h('div', { class: 'shelf-items' });
  for (const p of items) {
    const chip = h('div', { class: 'shelf-chip', title: p, draggable: 'false' }, h('span', { html: icon(/\.[a-z0-9]{1,5}$/i.test(p) ? 'page' : 'folder') }), h('span', { class: 'sc-name' }, basename(p)),
      h('button', { class: 'sc-x', title: 'Remove', html: icon('close'), onclick: (e) => { e.stopPropagation(); state.settings.shelf = items.filter((x) => x !== p); saveSettings(); renderShelf(); } }));
    chip.classList.toggle('sel', shelfSel.has(p));
    chip.addEventListener('click', (e) => { if (e.target.closest('.sc-x')) return; if (e.ctrlKey || e.shiftKey) { shelfSel.has(p) ? shelfSel.delete(p) : shelfSel.add(p); } else if (shelfSel.size === 1 && shelfSel.has(p)) shelfSel.clear(); else { shelfSel.clear(); shelfSel.add(p); } renderShelf(); });
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); const targets = shelfSel.has(p) ? shelfTargets() : [p]; shelfActions(targets, e.clientX, e.clientY, p); });
    // drag out to Explorer, the desktop or other programs: starts after a few pixels with the button down
    chip.addEventListener('mousedown', (e0) => {
      if (e0.button !== 0 || e0.target.closest('.sc-x')) return;
      const move = (e) => {
        if (!(e.buttons & 1)) return stop();
        if (Math.abs(e.clientX - e0.clientX) < 6 && Math.abs(e.clientY - e0.clientY) < 6) return;
        stop();
        window.atlas.startDrag(e0.altKey ? [p] : shelfSel.size ? shelfTargets() : items);
      };
      const stop = () => { window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', stop, true); };
      window.addEventListener('mousemove', move, true); window.addEventListener('mouseup', stop, true);
    });
    chip.addEventListener('dblclick', () => A.openItems([{ path: p, name: basename(p), isDir: !/\.[a-z0-9]{1,5}$/i.test(p), ext: (p.split('.').pop() || '').toLowerCase() }]));
    list.append(chip);
  }
  el.append(head, list);
  $('shelf-btn')?.classList.toggle('has', items.length > 0);
  bus.emit('shelfChanged');
  // drop target
  el.ondragover = (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; el.classList.add('drop-on'); } };
  el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-on'); };
  el.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-on');
    let paths = [...(e.dataTransfer.files || [])].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (!paths.length) paths = currentDrag()?.paths || [];
    addToShelf(paths);
  };
}
// ---- shelf actions: anything you could do with a selection, for the files on the shelf ----
const shelfSel = new Set();
function shelfTargets() { const all = state.settings.shelf || []; const sel = all.filter((p) => shelfSel.has(p)); return sel.length ? sel : all; }
function setShelf(paths) { state.settings.shelf = paths; for (const p of [...shelfSel]) if (!paths.includes(p)) shelfSel.delete(p); saveSettings(); renderShelf(); }
async function shelfItems(paths) {
  const out = [];
  for (const p of paths) { const st = await api('fs:stat', p).catch(() => null); if (st) out.push({ path: p, name: basename(p), isDir: st.isDir, ext: st.isDir ? '' : (basename(p).includes('.') ? basename(p).split('.').pop().toLowerCase() : ''), size: st.size, mtime: st.mtime }); }
  return out;
}
async function shelfActions(paths, x, y, chipPath) {
  const items = await shelfItems(paths);
  const missing = paths.filter((p) => !items.some((i) => i.path === p));
  const files = items.filter((i) => !i.isDir);
  const dest = () => { const t = activeTab(); return t?.path && !isVirtual(t.path) ? t.path : null; };
  const what = paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
  const zipName = async (dir) => api('fs:uniqueName', dir, `${paths.length === 1 ? basename(paths[0]).replace(/\.[^.]+$/, '') : 'Drop Shelf'}.zip`, 'number');
  const audio = files.filter((i) => ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'alac'].includes(i.ext));
  const imgs = files.filter((i) => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'jfif'].includes(i.ext));
  showMenu([
    { header: paths.length === (state.settings.shelf || []).length ? `All ${what} on the shelf` : `${what} selected` },
    ...A.openAllEntries(files.map((i) => i.path)),
    { separator: true },
    { label: 'Add to zip in this folder', icon: 'zip', disabled: !dest(), run: async () => { const d = dest(); const out = await zipName(d); await A.runJob({ type: 'compress', sources: paths, dest: d, opts: { output: out, format: 'zip' } }); toast(`Created ${basename(out)}`); } },
    { label: 'Add to zip next to the files', icon: 'zip', run: async () => { const d = dirname(paths[0]); const out = await zipName(d); await A.runJob({ type: 'compress', sources: paths, dest: d, opts: { output: out, format: 'zip' } }); toast(`Created ${basename(out)} in ${basename(d)}`); } },
    { label: 'Add to archive…', icon: 'zip', run: () => A.compress(items) },
    { label: 'Add to existing archive…', icon: 'plus', run: () => A.addToExistingArchive(items) },
    { separator: true },
    { label: 'Copy to this folder', icon: 'copy', disabled: !dest(), run: () => A.transfer(paths, dest(), 'copy') },
    { label: 'Move to this folder', icon: 'cut', disabled: !dest(), run: async () => { await A.transfer(paths, dest(), 'move'); setShelf((state.settings.shelf || []).filter((p) => !paths.includes(p))); } },
    { label: 'Copy to…', icon: 'copy', run: async () => { const d = await api('dialog:pickFolder', 'Copy to'); if (d) A.transfer(paths, d, 'copy'); } },
    { label: 'Move to…', icon: 'cut', run: async () => { const d = await api('dialog:pickFolder', 'Move to'); if (d) { await A.transfer(paths, d, 'move'); setShelf((state.settings.shelf || []).filter((p) => !paths.includes(p))); } } },
    { label: 'Copy to clipboard', icon: 'copy', run: () => A.copy(items) },
    { label: 'Copy paths', icon: 'link', run: () => A.copyPaths(items) },
    { separator: true },
    items.length > 1 && { label: 'Rename Studio…', icon: 'rename', run: async () => { await A.batchRename(items); setShelf((state.settings.shelf || []).filter((p) => !paths.includes(p))); } },
    audio.length && { label: 'Detect BPM & key', icon: 'music', run: () => bus.emit('analyzeAudio', audio.map((i) => i.path)) },
    imgs.length && { label: 'Convert pictures', icon: 'convert', submenu: ['jpg', 'png', 'webp'].map((f) => ({ label: f.toUpperCase(), run: () => import('./mediatools.js').then((m) => m.convertImages(imgs.map((i) => i.path), f)) })) },
    audio.length && { label: 'Convert audio', icon: 'convert', submenu: ['mp3', 'flac', 'wav', 'm4a'].map((f) => ({ label: f.toUpperCase(), run: () => import('./mediatools.js').then((m) => m.convertMedia(audio.map((i) => i.path), f)) })) },
    files.some((i) => ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'xz', 'bz2'].includes(i.ext)) && { label: 'Extract archives here', icon: 'extract', disabled: !dest(), run: () => A.runJob({ type: 'extract', sources: files.filter((i) => ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'xz', 'bz2'].includes(i.ext)).map((i) => i.path), dest: dest(), opts: { smart: true } }) },
    { label: 'Tags', icon: 'tag', submenu: state.tags.defs.map((d) => ({ label: d.name, swatch: d.color, run: () => import('./core.js').then((m) => m.setTags(paths, d.id, true)) })) },
    { label: 'Properties', icon: 'info', run: () => A.properties(items) },
    { separator: true },
    chipPath && { label: 'Show in folder', icon: 'folder', run: () => navigate(activeTab(), dirname(chipPath), { select: chipPath }) },
    missing.length && { label: `Remove ${missing.length} missing`, run: () => setShelf((state.settings.shelf || []).filter((p) => !missing.includes(p))) },
    { label: paths.length === 1 ? 'Remove from shelf' : 'Remove these from shelf', icon: 'close', run: () => setShelf((state.settings.shelf || []).filter((p) => !paths.includes(p))) },
    { label: 'Delete (Recycle Bin)', icon: 'trash', danger: true, run: async () => { await A.remove(items); setShelf((state.settings.shelf || []).filter((p) => !paths.includes(p))); } },
  ], x, y);
}
async function dump(mode) {
  const t = activeTab();
  if (!t.path || (isVirtual(t.path) && !isMtp(t.path))) return toast('Open the destination folder first');
  const items = state.settings.shelf || [];
  await A.transfer(items, t.path, mode);
  if (mode === 'move') { state.settings.shelf = []; saveSettings(); renderShelf(); }
}

// ======================================================================
// Terminal drawer
// ======================================================================
let term = null, fit = null, ptyId = null, termCwd = null, lastPrompt = 0, lastInput = 0, termOpen = false, termShell = null;
// set when you press Enter in the terminal: only then may its new folder move the pane (never just from opening it)
let typedCommand = false;
async function toggleTerminal(force) {
  termOpen = force ?? !termOpen;
  const open = termOpen;
  animatePanel('terminal', $('term-drawer'), open, () => document.body.classList.toggle('term-open', open));
  $('term-btn')?.classList.toggle('on', termOpen);
  if (termOpen) { await ensureTerminal(); setTimeout(() => { fitTerm(); term?.focus(); }, 30); }
  else paneEls[state.activePane]?.body.focus();
}
const fitTerm = () => { try { fit?.fit(); if (ptyId && term) api('pty:resize', ptyId, term.cols, term.rows); } catch {} };

async function ensureTerminal() {
  const drawer = $('term-drawer');
  if (term) return;
  if (!(await api('pty:available'))) { drawer.innerHTML = '<div class="hint pad">The terminal component isn’t available on this system.</div>'; return; }
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'vendor/xterm.css'; document.head.append(link);
  const X = await import('../vendor/xterm.js');
  drawer.style.height = (state.settings.terminalHeight || 260) + 'px';
  drawer.innerHTML = '';
  const rz = h('div', { class: 'term-rz' });
  const head = h('div', { class: 'term-head' });
  const host = h('div', { class: 'term-host' });
  drawer.append(rz, head, host);
  const renderHead = () => {
    head.innerHTML = '';
    const syncBtn = h('button', { class: 'chip' + (state.settings.terminalSync ? ' on' : ''), title: 'Keep the terminal and the active pane in the same folder' }, state.settings.terminalSync ? '⇄ Synced with pane' : '⇄ Sync off');
    syncBtn.onclick = () => { state.settings.terminalSync = !state.settings.terminalSync; saveSettings(); renderHead(); if (state.settings.terminalSync) syncTerminalTo(activeTab(), true); };
    head.append(h('span', { class: 'term-title', html: `${icon('terminal')}<span>${esc(termShell === 'cmd' ? 'Command Prompt' : sys.platform === 'win32' ? 'PowerShell' : 'Shell')}</span>` }),
      h('span', { class: 'term-cwd' }, termCwd || ''), h('span', { class: 'st-spacer' }), syncBtn,
      h('button', { class: 'icon-btn small', title: 'Shell', html: icon('more'), onclick: (e) => showMenu([
        sys.platform === 'win32' && { label: 'PowerShell', radio: true, selected: termShell !== 'cmd' && termShell !== 'pwsh', run: () => restart('powershell') },
        sys.platform === 'win32' && { label: 'PowerShell 7 (pwsh)', radio: true, selected: termShell === 'pwsh', run: () => restart('pwsh') },
        sys.platform === 'win32' && { label: 'Command Prompt', radio: true, selected: termShell === 'cmd', run: () => restart('cmd') },
        { separator: true },
        { label: 'Clear', run: () => term.clear() },
        { label: 'Restart', icon: 'refresh', run: () => restart(termShell) },
        { label: 'Open in a separate window', icon: 'newWindow', run: () => api('shell:terminal', termCwd || activeTab().path, state.settings.terminal) },
      ], e.clientX, e.clientY - 200) }),
      h('button', { class: 'icon-btn small', title: 'Hide (Ctrl+`)', html: icon('close'), onclick: () => toggleTerminal(false) }));
  };
  const dark = state.dark;
  const css = getComputedStyle(document.documentElement);
  term = new X.Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace", fontSize: 13, cursorBlink: true, allowProposedApi: true, scrollback: 5000,
    theme: dark ? { background: '#141517', foreground: '#d7d8db', cursor: css.getPropertyValue('--accent').trim(), selectionBackground: '#3a3d45' } : { background: '#fbfbfb', foreground: '#2b2b2b', cursor: css.getPropertyValue('--accent').trim(), selectionBackground: '#cfe0ff', black: '#2b2b2b', brightBlack: '#666' },
  });
  fit = new X.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new X.WebLinksAddon((e, uri) => api('shell:openExternal', uri)));
  term.open(host);
  // OSC 9;9 "current directory" (emitted by our prompt) -> keep the pane in sync
  term.parser.registerOscHandler(9, (data) => {
    const m = data.match(/^9;"?(.*?)"?$/);
    if (m) { termCwd = m[1]; lastPrompt = performance.now(); renderHead(); if (typedCommand) { typedCommand = false; onTerminalCwd(termCwd); } }
    return true;
  });
  term.onData((d) => { lastInput = performance.now(); if (d.includes('\r')) typedCommand = true; if (ptyId) api('pty:write', ptyId, d); });
  onMain('pty:data', ({ id, d }) => { if (id === ptyId) term.write(d); });
  onMain('pty:exit', ({ id }) => { if (id === ptyId) { ptyId = null; term.write('\r\n\x1b[90m[process exited, press Enter to restart]\x1b[0m\r\n'); const sub = term.onData(() => { sub.dispose(); restart(termShell); }); } });
  new ResizeObserver(debounce(fitTerm, 40)).observe(host);
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = drawer.offsetHeight;
    const move = (ev) => { const hgt = Math.max(120, Math.min(window.innerHeight - 220, startH + startY - ev.clientY)); drawer.style.height = hgt + 'px'; state.settings.terminalHeight = hgt; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveSettings(); fitTerm(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  const restart = async (shell) => {
    if (ptyId) api('pty:kill', ptyId);
    term.reset();
    const t = activeTab();
    const cwd = t && !isVirtual(t.path) ? t.path : sys.known.home;
    fit.fit();
    const r = await api('pty:spawn', { shell: shell || state.settings.terminalShell || 'powershell', cwd, cols: term.cols, rows: term.rows }).catch((e) => { term.write(`\x1b[31m${e.message}\x1b[0m`); return null; });
    if (!r) return;
    ptyId = r.id; termShell = r.shell; termCwd = cwd;
    if (shell) { state.settings.terminalShell = shell; saveSettings(); }
    renderHead();
  };
  renderHead();
  await restart(state.settings.terminalShell);
}

// run a command (or a script) in the built-in terminal, from a folder; output stays visible in the drawer
export async function runInTerminal({ command, cwd }) {
  await toggleTerminal(true);
  for (let i = 0; i < 50 && !ptyId; i++) await new Promise((r) => setTimeout(r, 100));
  if (!ptyId) return toast('The terminal isn’t available', { error: true });
  const win = sys.platform === 'win32';
  if (cwd && !samePath(cwd, termCwd)) {
    const q = cwd.replace(/'/g, "''");
    api('pty:write', ptyId, termShell === 'cmd' ? `cd /d "${cwd}"\r` : win ? `Set-Location -LiteralPath '${q}'\r` : `cd '${cwd.replace(/'/g, "'\\''")}'\r`);
    termCwd = cwd;
  }
  lastInput = performance.now();
  api('pty:write', ptyId, command + '\r');
  term?.focus();
}
/** a PowerShell script in the terminal: saved to a file, then run as a script block in the open PowerShell */
export async function runPowerShellScript(script, cwd) {
  const dir = sys.userData + sys.sep + 'tmp';
  await api('fs:mkdir', dir).catch(() => {});
  const file = dir + sys.sep + 'script-' + Date.now().toString(36) + '.ps1';
  await api('fs:writeText', file, script);
  const q = file.replace(/'/g, "''");
  if (sys.platform === 'win32' && termShell === 'cmd') return runInTerminal({ command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`, cwd });
  return runInTerminal({ command: `& ([ScriptBlock]::Create((Get-Content -Raw -LiteralPath '${q}'))); Remove-Item -LiteralPath '${q}' -ErrorAction SilentlyContinue`, cwd });
}
// how to run a script file in the current shell
export function scriptCommand(file, shell = termShell) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  const q = `"${file}"`;
  const ps = shell !== 'cmd' && sys.platform === 'win32';
  const amp = ps ? '& ' : '';
  if (ext === 'ps1') return ps ? `& ${q}` : `powershell -ExecutionPolicy Bypass -File ${q}`;
  if (ext === 'py') return `${amp}python ${q}`;
  if (ext === 'js' || ext === 'mjs') return `${amp}node ${q}`;
  if (ext === 'sh') return `${amp}bash ${q}`;
  if (ext === 'rb') return `${amp}ruby ${q}`;
  if (ext === 'bat' || ext === 'cmd') return ps ? `& ${q}` : q;
  return `${amp}${q}`;
}

// for workspaces: is the terminal open and where is it
export const terminalState = () => ({ open: termOpen, cwd: termCwd });
/** the shell the terminal drawer runs (or will run when it opens): powershell, pwsh or cmd */
export const terminalShell = () => termShell || state.settings.terminalShell || (sys.platform === 'win32' ? 'powershell' : 'sh');
export async function openTerminalAt(cwd) {
  await toggleTerminal(true);
  if (!cwd || !ptyId) return;
  const q = cwd.replace(/'/g, "''");
  api('pty:write', ptyId, termShell === 'cmd' ? `cd /d "${cwd}"\r` : sys.platform === 'win32' ? `Set-Location -LiteralPath '${q}'\r` : `cd '${cwd.replace(/'/g, "'\\''")}'\r`);
  termCwd = cwd;
}
export const closeTerminal = () => termOpen && toggleTerminal(false);
function onTerminalCwd(p) {
  if (!state.settings.terminalSync) return;
  const t = activeTab();
  if (!t || t.app || samePath(t.path, p)) return; // a player, Photos or Office tab stays what it is
  navigate(t, p);
}
function syncTerminalTo(t, force) {
  if (!term || !ptyId || !termOpen || !state.settings.terminalSync || !t || t !== activeTab()) return;
  if (!t.path || isVirtual(t.path) || samePath(t.path, termCwd)) return;
  // only when the shell is sitting at a prompt (don't type into a running program)
  if (!force && lastInput > lastPrompt) return;
  const q = t.path.replace(/'/g, "''");
  const cmd = termShell === 'cmd' ? `cd /d "${t.path}"\r` : sys.platform === 'win32' ? `Set-Location -LiteralPath '${q}'\r` : `cd '${t.path.replace(/'/g, "'\\''")}'\r`;
  termCwd = t.path;
  api('pty:write', ptyId, cmd);
}

// ======================================================================
// File locks
// ======================================================================
function lockedToast(j) {
  if (!IS_WIN() || !j.locked?.length) return;
  toast(`${j.locked.length} item${j.locked.length > 1 ? 's are' : ' is'} in use or protected`, { error: true, ms: 9000, action: { label: 'What’s locking it?', run: () => showLocks(j.locked, j) } });
}
export async function showLocks(paths, job) {
  if (!IS_WIN()) return toast('Lock detection is available on Windows');
  const body = h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Checking which programs have these files open…'));
  let close;
  const draw = async () => {
    const list = await api('locks:who', paths).catch(() => []);
    body.innerHTML = '';
    body.append(h('div', { class: 'hint' }, paths.length === 1 ? paths[0] : `${paths.length} items`));
    if (!list.length) body.append(h('p', {}, 'Nothing seems to be using these files. They might be read-only or need administrator rights. Try again in a moment.'));
    for (const p of list) body.append(h('div', { class: 'lock-row' }, h('div', { class: 'grow' }, h('b', {}, p.name || 'Unknown program'), h('div', { class: 'hint' }, `PID ${p.pid}${p.exe ? ' · ' + p.exe : ''}`)),
      h('button', { class: 'btn small danger', onclick: async () => { await api('locks:kill', p.pid); toast(`Ended ${p.name}`); draw(); } }, 'End task')));
  };
  draw();
  const buttons = [{ label: 'Refresh', left: true, run: () => { draw(); return false; } }, { label: 'Close', value: null }];
  if (job && ['delete', 'trash', 'move', 'copy'].includes(job.type)) buttons.push({ label: 'Retry', primary: true, run: (c) => { c(true); A.runJob({ type: job.type, sources: paths, dest: job.dest }); } });
  await modal({ title: 'What’s using these files?', body, width: 540, buttons });
}
