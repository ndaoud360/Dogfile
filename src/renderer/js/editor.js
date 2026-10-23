// Dogfile Notepad: a Notepad++-style editor: document tabs, 55+ languages, find/replace (regex), multi-cursor &
// column editing, bookmarks, encodings (UTF-8/BOM, UTF-16 LE/BE, ANSI), EOL conversion, session restore with
// unsaved-change backup, external-change detection, Markdown preview, and a toolbox of text operations.
import * as CM from '../vendor/cm.js';
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, debounce } from './core.js';
import { icon } from './icons.js';
import { initLicense } from './license.js';
import { showMenu, closeMenus } from './menu.js';
import { prompt, modal } from './dialogs.js';
import { applyColors } from './theme.js';
import { markdown } from './md.js';
import * as FR from './featureref.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let ed = { wrap: false, whitespace: false, lineNumbers: true, fontSize: 14, preview: false, trimOnSave: false, tabSize: 4, autoComplete: true };
let sys = {};
const docs = [];
let active = null;
const closed = [];
let recent = [];
let seq = 1;

// ---------------- CodeMirror setup ----------------
import { hlStyle } from './cmtheme.js';
import { EMBED, pendingFiles, onHost, showInFiles, setTitle, closeApp, tellHost, onLeave, onWindowClose, exposeMenus, onAsk } from './embed.js';

// bookmarks (Ctrl+F2 toggle, F2 / Shift+F2 next / previous): like Notepad++
const toggleBm = CM.StateEffect.define();
const clearBm = CM.StateEffect.define();
class BmMarker extends CM.GutterMarker { toDOM() { const d = document.createElement('div'); d.className = 'cm-bm'; return d; } }
const bmMarker = new BmMarker();
const bmField = CM.StateField.define({
  create: () => CM.RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearBm)) set = CM.RangeSet.empty;
      if (e.is(toggleBm)) {
        let has = false;
        set.between(e.value, e.value, (from) => { if (from === e.value) has = true; });
        set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bmMarker.range(e.value)], sort: true });
      }
    }
    return set;
  },
});
const bmGutter = CM.gutter({
  class: 'cm-bm-gutter', markers: (v) => v.state.field(bmField), initialSpacer: () => bmMarker,
  domEventHandlers: { mousedown(view, line) { view.dispatch({ effects: toggleBm.of(line.from) }); return true; } },
});
const bmLines = CM.EditorView.decorations.compute([bmField], (st) => {
  const b = new CM.RangeSetBuilder();
  st.field(bmField).between(0, st.doc.length, (from) => { b.add(from, from, CM.Decoration.line({ class: 'cm-bm-line' })); });
  return b.finish();
});

const langC = new CM.Compartment(), wrapC = new CM.Compartment(), wsC = new CM.Compartment(), roC = new CM.Compartment(), numC = new CM.Compartment(), tabC = new CM.Compartment(), acC = new CM.Compartment();

function edKeymap() {
  const run = (fn) => () => { fn(); return true; };
  return CM.Prec.highest(CM.keymap.of([
    { key: 'Mod-s', run: run(() => save(active)) },
    { key: 'Mod-Alt-s', run: run(() => saveAs(active)) },
    { key: 'Mod-Shift-s', run: run(saveAll) },
    { key: 'Mod-n', run: run(() => newDoc()) },
    { key: 'Mod-o', run: run(openDialog) },
    { key: 'Mod-w', run: run(() => closeDoc(active)) },
    { key: 'Mod-F4', run: run(() => closeDoc(active)) },
    { key: 'Mod-Shift-t', run: run(reopenClosed) },
    { key: 'Mod-Tab', run: run(() => cycle(1)) }, { key: 'Mod-Shift-Tab', run: run(() => cycle(-1)) },
    { key: 'Mod-PageDown', run: run(() => cycle(1)) }, { key: 'Mod-PageUp', run: run(() => cycle(-1)) },
    { key: 'Mod-h', run: (v) => { CM.openSearchPanel(v); setTimeout(() => document.querySelector('.cm-search [name=replace]')?.focus(), 10); return true; } },
    { key: 'F3', run: CM.findNext, shift: CM.findPrevious },
    { key: 'Mod-g', run: run(gotoLineDialog) },
    { key: 'Mod-d', run: CM.copyLineDown },
    { key: 'Mod-Shift-l', run: CM.deleteLine },
    { key: 'Mod-Shift-ArrowUp', run: CM.moveLineUp }, { key: 'Mod-Shift-ArrowDown', run: CM.moveLineDown },
    { key: 'Mod-q', run: CM.toggleComment }, { key: 'Mod-/', run: CM.toggleComment }, { key: 'Mod-Shift-q', run: CM.toggleBlockComment },
    { key: 'Mod-u', run: run(() => transformSel((s) => s.toLowerCase())) },
    { key: 'Mod-Shift-u', run: run(() => transformSel((s) => s.toUpperCase())) },
    { key: 'Mod-j', run: run(joinLines) },
    { key: 'Mod-Alt-d', run: CM.selectNextOccurrence },
    { key: 'Mod-Alt-Shift-d', run: CM.selectMatches },
    { key: 'Mod-F2', run: run(() => toggleBookmark()) }, { key: 'F2', run: run(() => jumpBookmark(1)), shift: run(() => jumpBookmark(-1)) },
    { key: 'Mod-=', run: run(() => zoom(1)) }, { key: 'Mod-+', run: run(() => zoom(1)) }, { key: 'Mod--', run: run(() => zoom(-1)) }, { key: 'Mod-0', run: run(() => zoom(0)) },
    { key: 'Alt-z', run: run(() => toggle('wrap')) },
    { key: 'Mod-Shift-v', run: run(() => toggle('preview')) },
    { key: 'F1', run: run(() => toggleRef()) },
  ]));
}

function baseExtensions(doc) {
  return [
    edKeymap(),
    numC.of(ed.lineNumbers ? [CM.lineNumbers(), CM.foldGutter()] : []),
    bmField, bmGutter, bmLines,
    CM.highlightActiveLineGutter(), CM.highlightSpecialChars(), CM.history(), CM.drawSelection(), CM.dropCursor(),
    CM.EditorState.allowMultipleSelections.of(true), CM.indentOnInput(), CM.syntaxHighlighting(hlStyle), CM.bracketMatching(),
    CM.closeBrackets(), acC.of(ed.autoComplete ? [CM.autocompletion(), CM.EditorState.languageData.of(() => [{ autocomplete: FR.completionSource }, { autocomplete: CM.completeAnyWord }])] : []),
    CM.hoverTooltip((view, pos) => FR.hoverAt(view, pos), { hoverTime: 350 }),
    CM.rectangularSelection(), CM.crosshairCursor(), CM.highlightActiveLine(), CM.highlightSelectionMatches(), CM.search({ top: true }),
    CM.keymap.of([...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.searchKeymap, ...CM.historyKeymap, ...CM.foldKeymap, ...CM.completionKeymap, CM.indentWithTab]),
    langC.of([]), wrapC.of(ed.wrap ? CM.EditorView.lineWrapping : []),
    wsC.of(ed.whitespace ? [CM.highlightWhitespace(), CM.highlightTrailingWhitespace()] : []),
    roC.of(CM.EditorState.readOnly.of(!!doc.readonly)),
    tabC.of([CM.EditorState.tabSize.of(ed.tabSize), CM.indentUnit.of(' '.repeat(ed.tabSize))]),
    CM.EditorView.updateListener.of((u) => {
      if (u.docChanged) { const was = doc.dirty; doc.dirty = !u.state.doc.eq(doc.saved); if (was !== doc.dirty) renderTabs(); if (ed.preview && doc === active) updatePreviewSoon(); if (refPanel && doc === active) refCheckSoon(); saveSessionSoon(); }
      if (u.selectionSet || u.docChanged) renderStatusSoon();
    }),
    CM.EditorView.domEventHandlers({ wheel: (e) => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); return true; } return false; } }),
  ];
}

// ---------------- encodings ----------------
const ENCODINGS = [['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 with BOM'], ['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'], ['ansi', 'ANSI (Windows-1252)']];
const encName = (e) => (ENCODINGS.find((x) => x[0] === e) || [, e])[1];
function b64ToBytes(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function decode(b, force) {
  const td = (label, bytes, fatal) => new TextDecoder(label, { fatal }).decode(bytes);
  if (force) {
    if (force === 'utf8') return { text: td('utf-8', b), enc: 'utf8' };
    if (force === 'utf8bom') return { text: td('utf-8', b[0] === 0xef ? b.subarray(3) : b), enc: 'utf8bom' };
    if (force === 'utf16le') return { text: td('utf-16le', b[0] === 0xff ? b.subarray(2) : b), enc: 'utf16le' };
    if (force === 'utf16be') return { text: td('utf-16be', b[0] === 0xfe ? b.subarray(2) : b), enc: 'utf16be' };
    return { text: td('windows-1252', b), enc: 'ansi' };
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: td('utf-8', b.subarray(3)), enc: 'utf8bom' };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: td('utf-16le', b.subarray(2)), enc: 'utf16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: td('utf-16be', b.subarray(2)), enc: 'utf16be' };
  // BOM-less UTF-16 heuristic: lots of zero bytes on one side
  const n = Math.min(b.length, 4000); let z0 = 0, z1 = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? z1++ : z0++);
  if (n > 8 && z1 > n * 0.3 && z0 < n * 0.05) return { text: td('utf-16le', b), enc: 'utf16le' };
  if (n > 8 && z0 > n * 0.3 && z1 < n * 0.05) return { text: td('utf-16be', b), enc: 'utf16be' };
  try { return { text: td('utf-8', b, true), enc: 'utf8' }; } catch { return { text: td('windows-1252', b), enc: 'ansi' }; }
}
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(?<!\r)\n/g) || []).length, cr = (text.match(/\r(?!\n)/g) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  if (cr > lf) return '\r';
  if (lf > 0) return '\n';
  return sys.platform === 'win32' ? '\r\n' : '\n';
}
const eolName = (e) => (e === '\r\n' ? 'Windows (CR LF)' : e === '\r' ? 'Macintosh (CR)' : 'Unix (LF)');
const isBinary = (b) => { const n = Math.min(b.length, 8000); let z = 0; for (let i = 0; i < n; i++) if (b[i] === 0) z++; return z > 0 && z > n * 0.01; };

// ---------------- documents ----------------
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');

function makeDoc({ path = null, text = '', enc = 'utf8', eol = null, mtime = 0, readonly = false, name = null, langId = null, dirtyText = null }) {
  const doc = { id: seq++, path, name: name || (path ? basename(path) : `new ${docs.filter((d) => !d.path).length + 1}`), enc, eol: eol || detectEol(text), mtime, readonly, dirty: false, langId: null, view: null, externalChange: false };
  const state = CM.EditorState.create({ doc: text, extensions: baseExtensions(doc) });
  doc.saved = state.doc;
  doc.view = new CM.EditorView({ state });
  doc.view.dom.classList.add('ed-view');
  if (dirtyText != null && dirtyText !== text) { doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: dirtyText } }); }
  setLanguage(doc, langId || CM.langForName(doc.path ? basename(doc.path) : sniffName(text)).id, true);
  return doc;
}
function sniffName(text) {
  const head = text.slice(0, 300).trimStart();
  if (/^#!.*\b(bash|sh|zsh)\b/.test(head)) return 'x.sh';
  if (/^#!.*\bpython/.test(head)) return 'x.py';
  if (/^#!.*\bnode/.test(head)) return 'x.js';
  if (/^<\?xml/i.test(head)) return 'x.xml';
  if (/^<!doctype html|^<html/i.test(head)) return 'x.html';
  if (/^[{[]/.test(head)) { try { JSON.parse(text); return 'x.json'; } catch {} }
  return 'x.txt';
}

async function openPaths(paths, { activate = true } = {}) {
  // inside a main-window tab each document gets its own tab: hand extra files to the host
  if (EMBED && paths.length) {
    const pristine = docs.length === 0 || (docs.length === 1 && !docs[0].path && !docs[0].dirty && !docs[0].view.state.doc.length);
    const here = pristine ? paths.slice(0, 1) : [];
    const rest = paths.filter((p) => !here.includes(p) && !docs.some((d) => d.path && d.path.toLowerCase() === p.toLowerCase()));
    if (rest.length) tellHost({ type: 'open', kind: 'editor', files: rest });
    if (!here.length) return active;
    if (pristine && docs.length === 1) { const old = docs.pop(); old.view.destroy(); }
    paths = here;
  }
  let last = null;
  for (const p of paths) {
    const exist = docs.find((d) => d.path && d.path.toLowerCase() === p.toLowerCase());
    if (exist) { last = exist; continue; }
    try {
      const r = await api('fs:readBuffer', p);
      const bytes = b64ToBytes(r.data);
      if (isBinary(bytes) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
        const go = await api('dialog:confirm', { type: 'warning', title: 'Dogfile Notepad', message: `“${basename(p)}” looks like a binary file.`, detail: 'Opening it as text may show garbage characters, and saving it can corrupt it.', buttons: ['Open read-only', 'Cancel'] });
        if (go !== 0) continue;
        r.readonly = true;
      }
      const { text, enc } = decode(bytes);
      const doc = makeDoc({ path: p, text, enc, mtime: r.mtime, readonly: r.readonly });
      if (r.size > 20 * 1024 * 1024) setLanguage(doc, 'text');
      docs.push(doc);
      api('fs:watchFile', p, true);
      addRecent(p);
      last = doc;
    } catch (e) { toast(`Couldn't open ${basename(p)}: ${String(e.message).replace(/^Error invoking remote method 'invoke': (Error: )?/, '')}`, { error: true }); }
  }
  if (last && activate) activate_(last);
  renderTabs(); saveSessionSoon();
  return last;
}

function newDoc(text = '', { here = false } = {}) {
  if (EMBED && docs.length && !here) { tellHost({ type: 'open', kind: 'editor', files: [] }); return active; }
  const d = makeDoc({ text }); docs.push(d); activate_(d); renderTabs(); return d;
}

function activate_(doc) {
  if (!doc) return;
  active = doc;
  const host = $('ed-host');
  if (host.firstChild !== doc.view.dom) { host.innerHTML = ''; host.append(doc.view.dom); }
  doc.view.focus();
  if (document.getElementById('ed-toolbar')?.childElementCount) renderToolbar();
  refPanel?.refreshCheck();
  requestAnimationFrame(() => doc.view.requestMeasure());
  renderTabs(); renderStatus(); renderNotice(); updatePreview();
  setTitle(`${doc.dirty ? '● ' : ''}${doc.name} - Dogfile Notepad`);
}

function setLanguage(doc, id, silent) {
  const L = CM.LANGS.find((l) => l.id === id) || CM.LANGS[0];
  doc.langId = L.id;
  let ext = [];
  try { ext = L.load ? L.load() : []; } catch (e) { console.error(e); }
  doc.view.dispatch({ effects: langC.reconfigure(ext) });
  if (!silent) { renderStatus(); saveSessionSoon(); }
}

function textOf(doc) { let t = doc.view.state.doc.toString(); if (ed.trimOnSave) t = t.replace(/[ \t]+$/gm, ''); return doc.eol === '\n' ? t : t.replace(/\n/g, doc.eol); }

async function save(doc) {
  if (!doc) return false;
  if (!doc.path) return saveAs(doc);
  if (doc.readonly) { toast('This file is read-only. Use Save As', { error: true }); return false; }
  try {
    if (ed.trimOnSave) { const cur = doc.view.state.doc.toString(); const trimmed = cur.replace(/[ \t]+$/gm, ''); if (trimmed !== cur) doc.view.dispatch({ changes: { from: 0, to: cur.length, insert: trimmed } }); }
    doc.saving = true;
    const r = await api('fs:writeEncoded', doc.path, textOf(doc), doc.enc === 'ansi' ? 'cp1252' : doc.enc);
    doc.mtime = r.mtime; doc.saved = doc.view.state.doc; doc.dirty = false; doc.externalChange = false;
    setTimeout(() => (doc.saving = false), 600);
    renderTabs(); renderNotice(); saveSessionSoon();
    toast(`Saved ${doc.name}`, { ms: 1400 });
    return true;
  } catch (e) { doc.saving = false; toast(`Save failed: ${e.message}`, { error: true }); return false; }
}
async function saveAs(doc) {
  if (!doc) return false;
  const p = await api('dialog:saveFile', { title: 'Save As', defaultPath: doc.path || doc.name + (doc.langId === 'text' ? '.txt' : '') });
  if (!p) return false;
  if (doc.path) api('fs:watchFile', doc.path, false);
  doc.path = p; doc.name = basename(p); doc.readonly = false;
  doc.view.dispatch({ effects: roC.reconfigure(CM.EditorState.readOnly.of(false)) });
  if (doc.langId === 'text') setLanguage(doc, CM.langForName(doc.name).id);
  const ok = await save(doc);
  api('fs:watchFile', p, true); addRecent(p);
  return ok;
}
async function saveAll() { for (const d of docs) if (d.dirty) { if (!(await save(d))) return; } }

async function closeDoc(doc, { force = false } = {}) {
  if (!doc) return true;
  if (doc.dirty && !force) {
    const r = await api('dialog:confirm', { type: 'warning', title: 'Dogfile Notepad', message: `Save changes to “${doc.name}”?`, buttons: ['Save', "Don't save", 'Cancel'], cancelId: 2 });
    if (r === 2) return false;
    if (r === 0 && !(await save(doc))) return false;
  }
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  if (doc.path) { api('fs:watchFile', doc.path, false); closed.unshift(doc.path); }
  doc.view.destroy();
  if (!docs.length && EMBED) { closeApp(); return true; }
  if (!docs.length) newDoc();
  else if (active === doc) activate_(docs[Math.min(i, docs.length - 1)]);
  renderTabs(); saveSessionSoon();
  return true;
}
// leaving the tab (closing it, or going to a folder from it): Save / Don't save / Cancel for each unsaved document
async function confirmLeave(asking) {
  const dirty = docs.filter((d) => d.dirty);
  if (!dirty.length) return true;
  asking?.();
  for (const d of dirty) {
    if (d !== active) activate_(d);
    const r = await api('dialog:confirm', { type: 'warning', title: 'Dogfile Notepad', message: `Save changes to “${d.name}”?`, buttons: ['Save', "Don't save", 'Cancel'], cancelId: 2 });
    if (r === 2) return false;
    if (r === 0) { if (!(await save(d))) return false; }
    else { d.discarded = true; d.dirty = false; }
  }
  renderTabs();
  return true;
}
onLeave(confirmLeave);
// its own window keeps unsaved documents for next time (like Notepad++), so closing it needs no question
onWindowClose(async () => { api('store:set', 'editor-session', snapshot()); return true; });
function reopenClosed() { const p = closed.shift(); if (p) openPaths([p]); }
function cycle(d) { if (docs.length < 2) return; const i = docs.indexOf(active); activate_(docs[(i + d + docs.length) % docs.length]); }

async function reloadDoc(doc, enc) {
  if (!doc?.path) return;
  const r = await api('fs:readBuffer', doc.path);
  const { text, enc: e } = decode(b64ToBytes(r.data), enc);
  doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: text } });
  doc.saved = doc.view.state.doc; doc.dirty = false; doc.mtime = r.mtime; doc.enc = e; doc.eol = detectEol(text); doc.externalChange = false;
  renderTabs(); renderStatus(); renderNotice();
}

async function openDialog() { const files = await api('dialog:openFiles', { title: 'Open', defaultPath: active?.path ? dirname(active.path) : undefined }); if (files.length) openPaths(files); }

function addRecent(p) { recent = [p, ...recent.filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 20); api('store:set', 'editor-recent', recent); }

// ---------------- text operations ----------------
function view() { return active?.view; }
function transformSel(fn) {
  const v = view(); if (!v) return;
  const changes = v.state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to, insert: fn(v.state.sliceDoc(r.from, r.to)) }));
  if (changes.length) v.dispatch({ changes });
  else { const line = v.state.doc.lineAt(v.state.selection.main.head); v.dispatch({ changes: { from: line.from, to: line.to, insert: fn(line.text) } }); }
}
function transformLines(fn) {
  const v = view(); if (!v) return;
  const sel = v.state.selection.main;
  let from = 0, to = v.state.doc.length;
  if (!sel.empty) { from = v.state.doc.lineAt(sel.from).from; to = v.state.doc.lineAt(sel.to).to; }
  const lines = v.state.sliceDoc(from, to).split('\n');
  v.dispatch({ changes: { from, to, insert: fn(lines).join('\n') } });
}
function joinLines() { transformSel((s) => s.replace(/\s*\n\s*/g, ' ')); }
function toggleBookmark() { const v = view(); if (!v) return; const line = v.state.doc.lineAt(v.state.selection.main.head); v.dispatch({ effects: toggleBm.of(line.from) }); }
function jumpBookmark(dir) {
  const v = view(); if (!v) return;
  const pos = v.state.doc.lineAt(v.state.selection.main.head).from;
  const all = []; v.state.field(bmField).between(0, v.state.doc.length, (f) => { all.push(f); });
  if (!all.length) return toast('No bookmarks (Ctrl+F2 adds one)');
  const next = dir > 0 ? all.find((f) => f > pos) ?? all[0] : [...all].reverse().find((f) => f < pos) ?? all[all.length - 1];
  v.dispatch({ selection: { anchor: next }, scrollIntoView: true });
}
async function gotoLineDialog() {
  const v = view(); if (!v) return;
  const cur = v.state.doc.lineAt(v.state.selection.main.head).number;
  const r = await prompt('Go to line', String(cur), { label: `Line (1 – ${v.state.doc.lines}), optionally line:column` });
  if (!r) return v.focus();
  const [ln, col] = r.split(/[:,]/).map((x) => parseInt(x, 10));
  const line = v.state.doc.line(Math.max(1, Math.min(v.state.doc.lines, ln || 1)));
  v.dispatch({ selection: { anchor: Math.min(line.to, line.from + Math.max(0, (col || 1) - 1)) }, scrollIntoView: true });
  v.focus();
}
function insertText(t) { const v = view(); v?.dispatch(v.state.replaceSelection(t)); v?.focus(); }
async function hashText(algo) {
  const v = view(); if (!v) return;
  const sel = v.state.selection.main;
  const text = sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await api('clip:writeText', hex);
  toast(`${algo} of ${sel.empty ? 'document' : 'selection'} copied: ${hex.slice(0, 16)}…`);
}
function formatJson(min) {
  const v = view(); if (!v) return;
  try { const t = JSON.stringify(JSON.parse(v.state.doc.toString()), null, min ? 0 : ed.tabSize); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } }); if (active.langId === 'text') setLanguage(active, 'json'); }
  catch (e) { toast(`Not valid JSON: ${e.message}`, { error: true }); }
}

// ---------------- view toggles ----------------
function sendState() { if (EMBED) tellHost({ type: 'state', kind: 'text', path: active?.path || null, wrap: !!ed.wrap, whitespace: !!ed.whitespace, preview: !!ed.preview }); }
function toggle(k) {
  ed[k] = !ed[k];
  for (const d of docs) {
    if (k === 'wrap') d.view.dispatch({ effects: wrapC.reconfigure(ed.wrap ? CM.EditorView.lineWrapping : []) });
    if (k === 'whitespace') d.view.dispatch({ effects: wsC.reconfigure(ed.whitespace ? [CM.highlightWhitespace(), CM.highlightTrailingWhitespace()] : []) });
    if (k === 'lineNumbers') d.view.dispatch({ effects: numC.reconfigure(ed.lineNumbers ? [CM.lineNumbers(), CM.foldGutter()] : []) });
    if (k === 'autoComplete') d.view.dispatch({ effects: acC.reconfigure(ed.autoComplete ? [CM.autocompletion(), CM.EditorState.languageData.of(() => [{ autocomplete: CM.completeAnyWord }])] : []) });
  }
  if (k === 'preview') { document.body.classList.toggle('ed-preview-on', ed.preview); updatePreview(); }
  saveEd(); renderToolbar(); renderStatus(); sendState();
}
function setTab(n) { ed.tabSize = n; for (const d of docs) d.view.dispatch({ effects: tabC.reconfigure([CM.EditorState.tabSize.of(n), CM.indentUnit.of(' '.repeat(n))]) }); saveEd(); renderStatus(); }
function zoom(d) { ed.fontSize = d === 0 ? 14 : Math.max(8, Math.min(40, ed.fontSize + d)); applyFont(); saveEd(); }
function applyFont() { document.documentElement.style.setProperty('--ed-fs', ed.fontSize + 'px'); for (const d of docs) d.view.requestMeasure(); }
const saveEd = debounce(() => api('store:set', 'editor-prefs', ed), 300);

function updatePreview() {
  const pv = $('ed-preview');
  if (!ed.preview || !active) { pv.innerHTML = ''; return; }
  const t = active.view.state.doc.toString();
  if (active.langId === 'md' || /\.(md|markdown)$/i.test(active.name)) pv.innerHTML = markdown(t);
  else if (active.langId === 'html') pv.innerHTML = '<iframe class="ed-html" sandbox=""></iframe>', (pv.firstChild.srcdoc = t);
  else pv.innerHTML = `<div class="hint pad">Preview is available for Markdown and HTML.</div>`;
}
const updatePreviewSoon = debounce(updatePreview, 250);

// ---------------- UI: tabs, menus, toolbar, status ----------------
function renderTabs() {
  if (EMBED) { const dirty = docs.some((d) => d.dirty); if (dirty !== renderTabs._dirty) { renderTabs._dirty = dirty; tellHost({ type: 'dirty', dirty }); } sendState(); }
  const host = $('ed-tabs');
  host.innerHTML = '';
  for (const d of docs) {
    const t = h('div', { class: 'tab' + (d === active ? ' active' : '') + (d.dirty ? ' dirty' : ''), title: d.path || d.name, draggable: 'true' });
    t.innerHTML = `<span class="tab-ic">${icon(d.readonly ? 'lock' : 'notepad')}</span><span class="tab-title">${esc(d.name)}</span><span class="dirty-dot"></span><button class="tab-close" title="Close (Ctrl+W)">${icon('close')}</button>`;
    t.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeDoc(d); } else if (e.button === 0 && !e.target.closest('.tab-close')) activate_(d); });
    t.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeDoc(d); });
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu([
      { label: 'Close', icon: 'close', keys: 'Ctrl+W', run: () => closeDoc(d) },
      { label: 'Close others', run: async () => { for (const x of docs.filter((x) => x !== d)) if (!(await closeDoc(x))) break; } },
      { label: 'Close to the right', run: async () => { for (const x of docs.slice(docs.indexOf(d) + 1)) if (!(await closeDoc(x))) break; } },
      { separator: true },
      d.path && { label: 'Copy full path', icon: 'link', run: () => api('clip:writeText', d.path) },
      d.path && { label: 'Copy file name', run: () => api('clip:writeText', d.name) },
      d.path && { label: 'Show in Dogfile', icon: 'folder', run: () => showInFiles(d.path) },
      d.path && { label: 'Reload from disk', icon: 'refresh', run: () => reloadDoc(d) },
      { label: d.readonly ? 'Make editable' : 'Make read-only', icon: 'lock', run: () => { d.readonly = !d.readonly; d.view.dispatch({ effects: roC.reconfigure(CM.EditorState.readOnly.of(d.readonly)) }); renderTabs(); } },
    ], e.clientX, e.clientY); });
    t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-atlas-doc', String(d.id)); });
    t.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-atlas-doc')) e.preventDefault(); });
    t.addEventListener('drop', (e) => { const id = +e.dataTransfer.getData('text/x-atlas-doc'); const src = docs.find((x) => x.id === id); if (!src || src === d) return; docs.splice(docs.indexOf(src), 1); docs.splice(docs.indexOf(d), 0, src); renderTabs(); });
    host.append(t);
  }
  host.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  if (active) setTitle(`${active.dirty ? '● ' : ''}${active.name} - Dogfile Notepad`);
}

const MENUS = {
  File: () => [
    { label: 'New', icon: 'newFile', keys: 'Ctrl+N', run: () => newDoc() },
    { label: 'Open…', icon: 'folderOpen', keys: 'Ctrl+O', run: openDialog },
    { label: 'Open recent', icon: 'history', submenu: () => (recent.length ? recent.map((p) => ({ label: basename(p), keys: dirname(p), run: () => openPaths([p]) })) : [{ label: 'No recent files', disabled: true }]) },
    { label: 'Reopen closed tab', keys: 'Ctrl+Shift+T', run: reopenClosed, disabled: !closed.length },
    { separator: true },
    { label: 'Save', icon: 'check', keys: 'Ctrl+S', run: () => save(active) },
    { label: 'Save As…', keys: 'Ctrl+Alt+S', run: () => saveAs(active) },
    { label: 'Save All', keys: 'Ctrl+Shift+S', run: saveAll },
    { label: 'Reload from disk', icon: 'refresh', run: () => reloadDoc(active), disabled: !active?.path },
    { separator: true },
    { label: 'Show in Dogfile', icon: 'folder', run: () => showInFiles(active.path), disabled: !active?.path },
    { label: 'Print…', run: () => window.print() },
    { separator: true },
    { label: 'Close tab', keys: 'Ctrl+W', run: () => closeDoc(active) },
    { label: 'Close all', run: async () => { for (const d of [...docs]) if (!(await closeDoc(d))) break; } },
    { label: EMBED ? 'Close tab' : 'Exit', run: closeApp },
  ],
  Edit: () => [
    { label: 'Undo', icon: 'undo', keys: 'Ctrl+Z', run: () => CM.undo(view()) },
    { label: 'Redo', icon: 'redo', keys: 'Ctrl+Y', run: () => CM.redo(view()) },
    { separator: true },
    { label: 'Cut', icon: 'cut', keys: 'Ctrl+X', run: () => document.execCommand('cut') },
    { label: 'Copy', icon: 'copy', keys: 'Ctrl+C', run: () => document.execCommand('copy') },
    { label: 'Paste', icon: 'paste', keys: 'Ctrl+V', run: async () => insertText(await api('clip:readText')) },
    { label: 'Select all', icon: 'selectAll', keys: 'Ctrl+A', run: () => CM.selectAll(view()) },
    { separator: true },
    { label: 'Line operations', submenu: [
      { label: 'Duplicate line', keys: 'Ctrl+D', run: () => CM.copyLineDown(view()) },
      { label: 'Delete line', keys: 'Ctrl+Shift+L', run: () => CM.deleteLine(view()) },
      { label: 'Move line up', keys: 'Ctrl+Shift+Up', run: () => CM.moveLineUp(view()) },
      { label: 'Move line down', keys: 'Ctrl+Shift+Down', run: () => CM.moveLineDown(view()) },
      { label: 'Join lines', keys: 'Ctrl+J', run: joinLines },
      { separator: true },
      { label: 'Sort lines ascending', run: () => transformLines((l) => l.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) },
      { label: 'Sort lines descending', run: () => transformLines((l) => l.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) },
      { label: 'Sort lines (case-insensitive)', run: () => transformLines((l) => l.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))) },
      { label: 'Reverse line order', run: () => transformLines((l) => l.reverse()) },
      { label: 'Remove duplicate lines', run: () => transformLines((l) => [...new Set(l)]) },
      { label: 'Remove empty lines', run: () => transformLines((l) => l.filter((x) => x.trim())) },
      { label: 'Trim trailing whitespace', run: () => transformLines((l) => l.map((x) => x.replace(/\s+$/, ''))) },
      { label: 'Trim leading whitespace', run: () => transformLines((l) => l.map((x) => x.replace(/^\s+/, ''))) },
    ] },
    { label: 'Convert case', submenu: [
      { label: 'UPPERCASE', keys: 'Ctrl+Shift+U', run: () => transformSel((s) => s.toUpperCase()) },
      { label: 'lowercase', keys: 'Ctrl+U', run: () => transformSel((s) => s.toLowerCase()) },
      { label: 'Title Case', run: () => transformSel((s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())) },
      { label: 'Sentence case', run: () => transformSel((s) => s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase())) },
      { label: 'iNVERT cASE', run: () => transformSel((s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')) },
    ] },
    { label: 'Comment', submenu: [
      { label: 'Toggle line comment', keys: 'Ctrl+Q', run: () => CM.toggleComment(view()) },
      { label: 'Toggle block comment', keys: 'Ctrl+Shift+Q', run: () => CM.toggleBlockComment(view()) },
    ] },
    { label: 'Blank operations', submenu: [
      { label: 'Tabs to spaces', run: () => transformLines((l) => l.map((x) => x.replace(/\t/g, ' '.repeat(ed.tabSize)))) },
      { label: 'Leading spaces to tabs', run: () => transformLines((l) => l.map((x) => x.replace(new RegExp(`^((?: {${ed.tabSize}})+)`), (m) => '\t'.repeat(m.length / ed.tabSize)))) },
    ] },
    { label: 'Insert date & time', run: () => insertText(new Date().toLocaleString()) },
    { separator: true },
    { label: 'Multi-select next match', keys: 'Ctrl+Alt+D', run: () => CM.selectNextOccurrence(view()) },
    { label: 'Select all matches', keys: 'Ctrl+Alt+Shift+D', run: () => CM.selectMatches(view()) },
    { label: 'Column / box select', keys: 'Alt+drag', disabled: true },
    { separator: true },
    { label: active?.readonly ? 'Clear read-only' : 'Set read-only', icon: 'lock', run: () => { active.readonly = !active.readonly; active.view.dispatch({ effects: roC.reconfigure(CM.EditorState.readOnly.of(active.readonly)) }); renderTabs(); } },
  ],
  Search: () => [
    { label: 'Find…', icon: 'search', keys: 'Ctrl+F', run: () => CM.openSearchPanel(view()) },
    { label: 'Replace…', keys: 'Ctrl+H', run: () => { CM.openSearchPanel(view()); setTimeout(() => document.querySelector('.cm-search [name=replace]')?.focus(), 10); } },
    { label: 'Find next', keys: 'F3', run: () => CM.findNext(view()) },
    { label: 'Find previous', keys: 'Shift+F3', run: () => CM.findPrevious(view()) },
    { label: 'Go to line…', keys: 'Ctrl+G', run: gotoLineDialog },
    { separator: true },
    { label: 'Toggle bookmark', keys: 'Ctrl+F2', run: toggleBookmark },
    { label: 'Next bookmark', keys: 'F2', run: () => jumpBookmark(1) },
    { label: 'Previous bookmark', keys: 'Shift+F2', run: () => jumpBookmark(-1) },
    { label: 'Clear all bookmarks', run: () => view()?.dispatch({ effects: clearBm.of(null) }) },
  ],
  View: () => [
    { label: 'Word wrap', checked: ed.wrap, keys: 'Alt+Z', run: () => toggle('wrap') },
    { label: 'Show whitespace', checked: ed.whitespace, run: () => toggle('whitespace') },
    { label: 'Line numbers & folding', checked: ed.lineNumbers, run: () => toggle('lineNumbers') },
    { label: 'Auto-completion', checked: ed.autoComplete, run: () => toggle('autoComplete') },
    { label: 'Trim trailing spaces on save', checked: ed.trimOnSave, run: () => toggle('trimOnSave') },
    { label: 'Tab size', submenu: [2, 4, 8].map((n) => ({ label: `${n} spaces`, radio: true, selected: ed.tabSize === n, run: () => setTab(n) })) },
    { separator: true },
    { label: 'Fold all', run: () => CM.foldAll(view()) }, { label: 'Unfold all', run: () => CM.unfoldAll(view()) },
    { separator: true },
    { label: 'Zoom in', icon: 'zoomIn', keys: 'Ctrl+=', run: () => zoom(1) }, { label: 'Zoom out', icon: 'zoomOut', keys: 'Ctrl+-', run: () => zoom(-1) }, { label: 'Reset zoom', keys: 'Ctrl+0', run: () => zoom(0) },
    { separator: true },
    { label: 'Markdown / HTML preview', checked: ed.preview, keys: 'Ctrl+Shift+V', run: () => toggle('preview') },
    !EMBED && { label: 'Always on top', icon: 'pin', run: () => api('win:control', 'ontop') },
    { label: 'Theme', icon: 'sun', submenu: ['system', 'light', 'dark'].map((th) => ({ label: th[0].toUpperCase() + th.slice(1), radio: true, selected: settings.theme === th, run: () => { settings.theme = th; api('store:set', 'settings', settings); applyColors(settings); } })) },
  ],
  Encoding: () => [
    { header: 'Save with encoding' },
    ...ENCODINGS.map(([k, l]) => ({ label: l, radio: true, selected: active?.enc === k, run: () => { active.enc = k; active.dirty = true; renderTabs(); renderStatus(); } })),
    { separator: true },
    { label: 'Reopen with encoding', disabled: !active?.path, submenu: ENCODINGS.map(([k, l]) => ({ label: l, run: () => reloadDoc(active, k) })) },
  ],
  Language: () => [
    { label: 'Auto-detect', run: () => setLanguage(active, CM.langForName(active.path ? basename(active.path) : sniffName(active.view.state.doc.toString())).id) },
    { separator: true },
    ...CM.LANGS.slice().sort((a, b) => (a.id === 'text' ? -1 : b.id === 'text' ? 1 : a.name.localeCompare(b.name))).map((L) => ({ label: L.name, radio: true, selected: active?.langId === L.id, run: () => setLanguage(active, L.id) })),
  ],
  EOL: () => [
    ...[['\r\n', 'Windows (CR LF)'], ['\n', 'Unix (LF)'], ['\r', 'Macintosh (CR)']].map(([k, l]) => ({ label: l, radio: true, selected: active?.eol === k, run: () => { active.eol = k; active.dirty = true; renderTabs(); renderStatus(); } })),
  ],
  Tools: () => [
    { label: 'Compare with another file…', icon: 'compare', run: async () => { if (!active?.path) return toast('Save this document first'); const [f] = await api('dialog:openFiles', { title: 'Compare with…', defaultPath: dirname(active.path) }); if (f) openCompare(active.path, f); } },
    { separator: true },
    { label: 'SHA-1 → clipboard', icon: 'hash', run: () => hashText('SHA-1') },
    { label: 'SHA-256 → clipboard', icon: 'hash', run: () => hashText('SHA-256') },
    { label: 'SHA-512 → clipboard', icon: 'hash', run: () => hashText('SHA-512') },
    { separator: true },
    { label: 'Base64 encode', run: () => transformSel((s) => btoa(unescape(encodeURIComponent(s)))) },
    { label: 'Base64 decode', run: () => transformSel((s) => { try { return decodeURIComponent(escape(atob(s.trim()))); } catch { toast('Not valid Base64', { error: true }); return s; } }) },
    { label: 'URL encode', run: () => transformSel(encodeURIComponent) },
    { label: 'URL decode', run: () => transformSel((s) => { try { return decodeURIComponent(s); } catch { return s; } }) },
    { label: 'Escape HTML', run: () => transformSel(esc) },
    { separator: true },
    { label: 'Format JSON', icon: 'code', run: () => formatJson(false) },
    { label: 'Minify JSON', run: () => formatJson(true) },
    { separator: true },
    { label: 'Document statistics', icon: 'info', run: stats },
  ],
};

function renderMenubar() {
  const bar = $('ed-menubar');
  bar.innerHTML = '';
  for (const name of Object.keys(MENUS)) {
    const b = h('button', { class: 'menu-tab' }, name);
    b.addEventListener('click', () => { const r = b.getBoundingClientRect(); showMenu(MENUS[name](), r.left, r.bottom + 2, { onClose: () => active?.view.focus() }); });
    b.addEventListener('mouseenter', () => { if (document.querySelector('.menu') && !b.classList.contains('on')) b.click(); });
    bar.append(b);
  }
}

function renderToolbar() {
  const tb = $('ed-toolbar');
  const B = (ic, title, fn, on) => { const b = h('button', { class: 'tb-btn' + (on ? ' on' : ''), title, html: icon(ic) }); b.addEventListener('click', () => { fn(); active?.view.focus(); }); return b; };
  tb.innerHTML = '';
  tb.append(
    B('newFile', 'New (Ctrl+N)', () => newDoc()), B('folderOpen', 'Open (Ctrl+O)', openDialog), B('check', 'Save (Ctrl+S)', () => save(active)), B('copy', 'Save all (Ctrl+Shift+S)', saveAll),
    h('span', { class: 'tb-sep' }),
    B('undo', 'Undo (Ctrl+Z)', () => CM.undo(view())), B('redo', 'Redo (Ctrl+Y)', () => CM.redo(view())),
    h('span', { class: 'tb-sep' }),
    B('search', 'Find (Ctrl+F)', () => CM.openSearchPanel(view())), B('rename', 'Replace (Ctrl+H)', () => { CM.openSearchPanel(view()); setTimeout(() => document.querySelector('.cm-search [name=replace]')?.focus(), 10); }),
    B('star', 'Toggle bookmark (Ctrl+F2)', toggleBookmark),
    h('span', { class: 'tb-sep' }),
    B('flatten', 'Word wrap (Alt+Z)', () => toggle('wrap'), ed.wrap), B('eye', 'Show whitespace', () => toggle('whitespace'), ed.whitespace),
    B('zoomIn', 'Zoom in (Ctrl+=)', () => zoom(1)), B('zoomOut', 'Zoom out (Ctrl+-)', () => zoom(-1)),
    h('span', { class: 'tb-sep' }),
    B('panel', 'Markdown / HTML preview (Ctrl+Shift+V)', () => toggle('preview'), ed.preview),
    h('span', { class: 'tb-sep' }),
    ...(features?.commands() || []).filter((c) => c.toolbar).map((c) => B(c.icon || 'puzzle', `${c.title} (${c.feature.name})`, () => c.run({ fileName: active?.name }))),
    (() => { const b = B('puzzle', 'Features: add your own tools to Notepad', () => {}); b.onclick = (e) => featuresMenu(e); return b; })(),
    (active && FR.isFeatureText(active.view.state.doc.sliceString(0, 4000), active.name)) || document.body.classList.contains('ed-ref-on') ? B('book', 'Feature help & API reference (F1)', () => toggleRef(), document.body.classList.contains('ed-ref-on')) : '',
  );
}
// ---------------- features (user-made tools) ----------------
let features = null;
async function featuresMenu(e) {
  const r = e.currentTarget?.getBoundingClientRect?.() || { left: e.clientX, bottom: e.clientY };
  showMenu(await featureItems(), r.left, r.bottom + 4);
}
async function featureItems() {
  const X = await import('./extensions.js');
  const cmds = features?.commands() || [];
  const code = active?.view.state.doc.toString() || '';
  const meta = X.parseFeature(code);
  return [
    ...(cmds.length ? [{ header: 'Your features' }, ...cmds.map((c) => ({ label: c.title, icon: c.icon || 'puzzle', run: () => c.run({ fileName: active?.name }) })), { separator: true }] : []),
    { label: 'Add a feature…', icon: 'plus', run: () => newFeature() },
    { label: 'Feature help & API reference', icon: 'book', keys: 'F1', run: () => toggleRef(true, 'ref') },
    { label: 'Examples', icon: 'puzzle', run: () => toggleRef(true, 'examples') },
    { label: 'Read the feature guide', icon: 'note', run: () => openGuide() },
    { separator: true },
    meta.isFeature && { label: `Install “${meta.name || 'this feature'}”`, icon: 'check', run: () => installFromDoc() },
    meta.isFeature && { label: 'Check this feature', icon: 'shieldCheck', run: () => toggleRef(true, 'check') },
    meta.isFeature && { label: 'Export this feature…', icon: 'downloadArrow', run: () => exportFromDoc() },
    meta.isFeature && { separator: true },
    { label: 'Import a feature…', icon: 'folderOpen', run: async () => { const f = await api('dialog:openFiles', { title: 'Import a feature', filters: [{ name: 'Dogfile mod', extensions: ['dogmod', 'atlasfeature', 'js', 'json'] }] }); if (!f?.[0]) return; const t = (await api('fs:readText', f[0], 2 * 1048576)).text; const j = X.readFeatureFile(t); api('ext:install', { code: j.code, meta: j.dogmod || j.atlasFeature ? j : null, source: f[0] }); } },
    { label: 'Manage features…', icon: 'settings', run: () => api('ext:install', { manage: true }) },
    { label: 'Browse features…', icon: 'store', run: () => api('ext:install', { store: true }) },
  ].filter(Boolean);
}
// in a tab of the main window, these menus live on the ribbon's Notepad tab
exposeMenus(() => ({ ...MENUS, Features: featureItems }), { after: () => active?.view.focus() });
async function newFeature(prefer) {
  const X = await import('./extensions.js');
  const pick = await X.pickStarter(prefer);
  if (!pick) return;
  if (pick.action === 'install') return api('ext:install', { code: pick.code, source: 'Example in Dogfile Notepad' });
  await openStarter(pick.code, pick.name);
}
// the starter is saved as a real file in Dogfile's "Features" folder so your work is never lost
async function openStarter(code, name) {
  const base = (await api('store:path')) + (sys.platform === 'win32' ? '\\Features\\' : '/Features/');
  await api('fs:mkdir', base).catch(() => {});
  const safe = String(name || 'My feature').replace(/[\\/:*?"<>|]/g, '_');
  const file = await api('fs:uniqueName', base.replace(/[\\/]$/, ''), `${safe}.dogmod.js`, 'number').catch(() => base + `${safe}.dogmod.js`);
  await api('fs:writeText', file, code);
  if (EMBED) tellHost({ type: 'open', kind: 'editor', files: [file] }); else { await openPaths([file]); toggleRef(true, 'ref'); }
  toast('Change it, then press Features > Install. Press F1 for help.', { ms: 5000 });
}
async function installFromDoc() {
  let code = active.view.state.doc.toString();
  const c = FR.checkDoc(code);
  if (c.missing.length) {
    const PN = { read: 'Read files', write: 'Change files', network: 'Use the internet', run: 'Run commands' };
    const r = await modal({ title: 'Add the missing permissions?', width: 520, body: h('div', { class: 'stack' },
      h('p', {}, 'Your feature uses things its header doesn’t ask for, so Dogfile would refuse them:'),
      h('ul', {}, ...c.missing.map((x) => h('li', {}, h('code', {}, x.fn + '()'), ' needs ', h('b', {}, PN[x.perm])))),
      h('div', { class: 'hint' }, 'Adding them changes the // @permissions line at the top. People installing your feature will see what it asks for.')),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Install without', value: 'skip' }, { label: 'Add and install', primary: true, value: 'add' }] });
    if (!r) return;
    if (r === 'add') { code = FR.addPermissions(code, c.missing.map((x) => x.perm)); const v = active.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code } }); }
  }
  api('ext:install', { code, source: 'Dogfile Notepad' + (active.path ? ` (${active.name})` : '') });
}
async function openGuide() {
  const p = await api('docs:featureGuide');
  if (EMBED) return tellHost({ type: 'open', kind: 'editor', files: [p] });
  await openPaths([p]);
  if (!ed.preview) toggle('preview');
}
// ---------------- feature help panel (F1) ----------------
let refPanel = null;
const refCheckSoon = debounce(() => refPanel?.refreshCheck(), 500);
function toggleRef(force, tab) {
  const on = force ?? !document.body.classList.contains('ed-ref-on');
  document.body.classList.toggle('ed-ref-on', on);
  if (on) {
    if (!refPanel) refPanel = FR.createPanel($('ed-ref'), {
      getText: () => active?.view.state.doc.toString() || '', getName: () => active?.name || '',
      setText: (t) => { const v = active.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } }); },
      insert: (t) => { const v = active.view; const line = v.state.doc.lineAt(v.state.selection.main.head); const at = line.text.trim() ? line.to : line.from; v.dispatch({ changes: { from: at, insert: (line.text.trim() ? '\n' : '') + t }, selection: { anchor: at + t.length + (line.text.trim() ? 1 : 0) } }); v.focus(); },
      close: () => toggleRef(false), install: () => installFromDoc(), newFeature: () => newFeature(),
      openExample: (e) => openStarter(e.code, FR.readHeader(e.code).name || e.title),
      openGuide: () => openGuide(),
    });
    refPanel.show(tab);
  } else active?.view.focus();
  renderToolbar();
}
async function exportFromDoc() {
  const X = await import('./extensions.js');
  const code = active.view.state.doc.toString();
  const meta = X.parseFeature(code);
  const p = await api('dialog:saveFile', { title: 'Export feature', defaultPath: `${(meta.name || 'feature').replace(/[\\/:*?"<>|]/g, '_')}.dogmod`, filters: [{ name: 'Dogfile mod', extensions: ['atlasfeature'] }] });
  if (!p) return;
  await api('fs:writeText', p, X.featureFile({ ...meta, code }));
  toast('Exported. Share the .dogmod file, or upload it from the feature browser.');
}
async function startEditorFeatures() {
  const X = await import('./extensions.js');
  features = X.startFeatures({
    target: 'notepad', getSettings: () => settings, onChange: () => renderToolbar(),
    provide: {
      'editor.getText': () => active?.view.state.doc.toString() ?? '',
      'editor.setText': (t) => { const v = active.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } }); return true; },
      'editor.getSelection': () => { const st = active.view.state; return st.sliceDoc(st.selection.main.from, st.selection.main.to); },
      'editor.replaceSelection': (t) => { active.view.dispatch(active.view.state.replaceSelection(t)); return true; },
      'editor.insert': (t) => { const v = active.view; v.dispatch({ changes: { from: v.state.selection.main.head, insert: t } }); return true; },
      'editor.fileName': () => active?.path || active?.name || '',
      'editor.getLanguage': () => active?.langId || 'text',
      'editor.setLanguage': (id) => { setLanguage(active, id); return true; },
      run: (cmd, cwd) => api('shell:runCommand', cmd, cwd),
    },
  });
}

function renderStatus() {
  const st = $('ed-status');
  if (!active) { st.innerHTML = ''; return; }
  const s = active.view.state;
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  const selLen = s.selection.ranges.reduce((a, r) => a + (r.to - r.from), 0);
  const L = CM.LANGS.find((l) => l.id === active.langId);
  st.innerHTML = '';
  const item = (text, title, onclick) => { const b = h('button', { class: 'st-item', title }, text); if (onclick) b.addEventListener('click', onclick); return b; };
  st.append(
    item(L ? L.name : 'Normal text', 'Language', (e) => showMenu(MENUS.Language(), e.clientX, e.clientY - 10)),
    h('span', { class: 'st-spacer' }),
    item(`length: ${s.doc.length.toLocaleString()}   lines: ${s.doc.lines.toLocaleString()}`, 'Document size'),
    item(`Ln ${line.number}, Col ${head - line.from + 1}${selLen ? `   Sel ${selLen}${s.selection.ranges.length > 1 ? ` (${s.selection.ranges.length})` : ''}` : ''}`, 'Go to line (Ctrl+G)', gotoLineDialog),
    item(eolName(active.eol), 'Line endings', (e) => showMenu(MENUS.EOL(), e.clientX, e.clientY - 10)),
    item(encName(active.enc), 'Encoding', (e) => showMenu(MENUS.Encoding(), e.clientX, e.clientY - 10)),
    item(`Spaces: ${ed.tabSize}`, 'Tab size', (e) => showMenu([2, 4, 8].map((n) => ({ label: `${n} spaces`, radio: true, selected: ed.tabSize === n, run: () => setTab(n) })), e.clientX, e.clientY - 10)),
    item(active.readonly ? 'READ-ONLY' : 'INS', 'Mode'),
  );
}
const renderStatusSoon = debounce(renderStatus, 30);

function renderNotice() {
  const n = $('ed-notice');
  n.innerHTML = '';
  if (!active?.externalChange) { n.classList.remove('show'); return; }
  n.classList.add('show');
  n.append(h('span', {}, `“${active.name}” was changed by another program.`),
    h('button', { class: 'btn small', onclick: () => reloadDoc(active) }, active.dirty ? 'Reload (discard my changes)' : 'Reload'),
    h('button', { class: 'btn small', onclick: () => { active.externalChange = false; renderNotice(); } }, 'Keep mine'));
}

function stats() {
  const t = active.view.state.doc.toString();
  const words = (t.match(/\S+/g) || []).length;
  modal({ title: 'Document statistics', width: 380, body: h('div', { class: 'kv' },
    h('div', { class: 'k' }, 'Characters'), h('div', { class: 'v' }, t.length.toLocaleString()),
    h('div', { class: 'k' }, 'Without spaces'), h('div', { class: 'v' }, t.replace(/\s/g, '').length.toLocaleString()),
    h('div', { class: 'k' }, 'Words'), h('div', { class: 'v' }, words.toLocaleString()),
    h('div', { class: 'k' }, 'Lines'), h('div', { class: 'v' }, active.view.state.doc.lines.toLocaleString()),
    h('div', { class: 'k' }, 'Encoding'), h('div', { class: 'v' }, encName(active.enc)),
    h('div', { class: 'k' }, 'Line endings'), h('div', { class: 'v' }, eolName(active.eol))), buttons: [{ label: 'Close', primary: true, value: true }] });
}

// ---------------- compare two files side by side (edit either side, save each) ----------------
let compareView = null;
async function openCompare(a, b) {
  const read = async (p) => { const r = await api('fs:readBuffer', p); const bytes = b64ToBytes(r.data); if (isBinary(bytes)) throw new Error(`${basename(p)} is a binary file`); return { p, ...decode(bytes) }; };
  let A, B;
  try { [A, B] = await Promise.all([read(a), read(b)]); } catch (e) { return toast(e.message, { error: true }); }
  closeCompare();
  const lang = (p) => { const L = CM.LANGS.find((l) => l.id === CM.langForName(basename(p)).id); try { return L?.load ? L.load() : []; } catch { return []; } };
  const side = (f) => ({ doc: f.text, extensions: [CM.lineNumbers(), CM.highlightActiveLine(), CM.highlightSpecialChars(), CM.history(), CM.drawSelection(), CM.syntaxHighlighting(hlStyle), CM.keymap.of([...CM.defaultKeymap, ...CM.historyKeymap, ...CM.searchKeymap]), CM.search({ top: true }), lang(f.p), wrapC.of(ed.wrap ? CM.EditorView.lineWrapping : [])] });
  const host = h('div', { class: 'cmp-host' });
  const info = h('span', { class: 'cmp-info' });
  const saveSide = async (which) => {
    const f = which === 'a' ? A : B;
    const view = which === 'a' ? compareView.a : compareView.b;
    const text = view.state.doc.toString();
    try { await api('fs:writeEncoded', f.p, text, f.enc === 'ansi' ? 'cp1252' : f.enc); f.text = text; toast(`Saved ${basename(f.p)}`, { ms: 1400 }); }
    catch (e) { toast(`Save failed: ${e.message}`, { error: true }); }
  };
  // the arrows beside each change copy it across: left to right, or right to left
  let dir = 'a-to-b';
  const dirBtn = h('button', { class: 'btn small', title: 'Which way the arrows beside each change copy it' }, 'Copy: left → right');
  dirBtn.onclick = () => {
    dir = dir === 'a-to-b' ? 'b-to-a' : 'a-to-b';
    dirBtn.textContent = dir === 'a-to-b' ? 'Copy: left → right' : 'Copy: right → left';
    const ta = compareView.a.state.doc.toString(), tb = compareView.b.state.doc.toString();
    compareView.destroy();
    compareView = new CM.MergeView({ a: side({ ...A, text: ta }), b: side({ ...B, text: tb }), parent: host, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 6 }, revertControls: dir });
    count();
  };
  const bar = h('div', { class: 'cmp-bar' },
    h('b', { title: a }, basename(a)), h('span', { class: 'cmp-vs' }, '↔'), h('b', { title: b }, basename(b)), info, h('span', { class: 'ctl-spacer' }),
    h('button', { class: 'btn small', title: 'Previous change (Shift+F7)', onclick: () => CM.goToPreviousChunk(compareView.b) }, '↑ Previous'),
    h('button', { class: 'btn small', title: 'Next change (F7)', onclick: () => CM.goToNextChunk(compareView.b) }, '↓ Next'),
    dirBtn,
    h('button', { class: 'btn small', onclick: () => saveSide('a') }, 'Save left'),
    h('button', { class: 'btn small', onclick: () => saveSide('b') }, 'Save right'),
    h('button', { class: 'btn small primary', onclick: closeCompare }, 'Close compare'));
  const wrap = h('div', { id: 'ed-compare' }, bar, host);
  document.body.append(wrap);
  document.body.classList.add('comparing');
  compareView = new CM.MergeView({ a: side(A), b: side(B), parent: host, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 6 }, revertControls: 'a-to-b' });
  const count = () => { const c = CM.getChunks(compareView.b.state); const n = c ? c.chunks.length : 0; info.textContent = n ? `${n} difference${n === 1 ? '' : 's'}` : 'The files are identical'; };
  count();
  const iv = setInterval(() => { if (!compareView) clearInterval(iv); else count(); }, 800);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'F7') { e.preventDefault(); (e.shiftKey ? CM.goToPreviousChunk : CM.goToNextChunk)(compareView.b); } if (e.key === 'Escape') closeCompare(); });
  setTitle(`${basename(a)} ↔ ${basename(b)} - Dogfile Notepad`);
}
function closeCompare() { if (!compareView) return; compareView.destroy(); compareView = null; $('ed-compare')?.remove(); document.body.classList.remove('comparing'); if (active) setTitle(`${active.name} - Dogfile Notepad`); }

// ---------------- session (Notepad++-style: unsaved changes survive restarts) ----------------
function snapshot() {
  return {
    active: docs.indexOf(active),
    docs: docs.filter((d) => !d.discarded).map((d) => {
      const cur = d.view.state.doc.toString();
      return { path: d.path, name: d.name, langId: d.langId, enc: d.enc, eol: d.eol, cursor: d.view.state.selection.main.head,
        backup: d.dirty || !d.path ? (cur.length < 4 * 1024 * 1024 ? cur : null) : null };
    }),
  };
}
const saveSessionSoon = debounce(() => { if (!EMBED) api('store:set', 'editor-session', snapshot()); }, 800);
async function restoreSession(s) {
  if (!s?.docs?.length) return false;
  for (const x of s.docs) {
    try {
      if (x.path) {
        let text = '', enc = x.enc, mtime = 0;
        try { const r = await api('fs:readBuffer', x.path); const dec = decode(b64ToBytes(r.data), x.enc); text = dec.text; enc = dec.enc; mtime = r.mtime; } catch { if (x.backup == null) continue; }
        const d = makeDoc({ path: x.path, text, enc, eol: x.eol, mtime, langId: x.langId, dirtyText: x.backup });
        docs.push(d); api('fs:watchFile', x.path, true);
        try { d.view.dispatch({ selection: { anchor: Math.min(x.cursor || 0, d.view.state.doc.length) }, scrollIntoView: true }); } catch {}
      } else if (x.backup) {
        const d = makeDoc({ text: '', name: x.name, langId: x.langId, dirtyText: x.backup });
        docs.push(d);
      }
    } catch (e) { console.error(e); }
  }
  if (!docs.length) return false;
  activate_(docs[Math.max(0, Math.min(s.active || 0, docs.length - 1))]);
  return true;
}

// ---------------- boot ----------------
async function boot() {
  sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  const [st, prefs, sess, rec] = await Promise.all([api('store:get', 'settings'), api('store:get', 'editor-prefs'), api('store:get', 'editor-session'), api('store:get', 'editor-recent')]);
  if ((st?.language || 'auto') !== 'en') import('./i18n.js').then((m) => m.initI18n(st?.language || 'auto')).catch(() => {});
  settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  ed = { ...ed, ...(prefs || {}) };
  recent = rec || [];
  applyColors(settings);
  applyFont();
  document.body.classList.toggle('ed-preview-on', !!ed.preview);
  $('ed-new').innerHTML = icon('plus');
  $('ed-new').addEventListener('click', () => newDoc());
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  renderMenubar(); renderToolbar();
  startEditorFeatures().catch((e) => console.error(e));
  if (!EMBED) await restoreSession(sess);
  const pending = await pendingFiles();
  if (pending?.compare && pending.files?.length === 2) { if (!docs.length) newDoc('', { here: true }); await openCompare(pending.files[0], pending.files[1]); }
  else if (pending?.files?.length) await openPaths(pending.files);
  else if (pending?.text != null && !docs.length) { const d = makeDoc({ text: '', dirtyText: pending.text }); docs.push(d); activate_(d); renderTabs(); }
  if (!docs.length) newDoc();
  document.body.classList.add('ready');
}

onMain('editor:open', ({ files, compare }) => (compare && files.length === 2 ? openCompare(files[0], files[1]) : openPaths(files)));
onHost({ open: (m) => (m.compare && m.files?.length === 2 ? openCompare(m.files[0], m.files[1]) : openPaths(m.files || [])), settings: (v) => { settings = { ...settings, ...v }; applyColors(settings); features?.reload(); }, cmd: (id) => { ({ save: () => save(active), saveAs: () => saveAs(active), saveAll, new: () => newDoc(), open: () => openDialog(), requestClose: () => closeDoc(active),
  undo: () => CM.undo(view()), redo: () => CM.redo(view()), find: () => CM.openSearchPanel(view()), replace: () => { CM.openSearchPanel(view()); setTimeout(() => document.querySelector('.cm-search [name=replace]')?.focus(), 10); },
  bookmark: toggleBookmark, wrap: () => toggle('wrap'), whitespace: () => toggle('whitespace'), zoomIn: () => zoom(1), zoomOut: () => zoom(-1), preview: () => toggle('preview'), stats }[id]?.()); if (id !== 'requestClose') active?.view.focus(); }, fileChanged: (p) => fileChanged(p) });
onMain('settings:changed', (v) => { settings = { ...settings, ...v }; applyColors(settings); features?.reload(); });
onMain('file:changed', (p) => fileChanged(p));
async function fileChanged(p) {
  const d = docs.find((x) => x.path === p);
  if (!d || d.saving) return;
  const st = await api('fs:stat', p);
  if (!st || Math.abs(st.mtime - d.mtime) < 1) return;
  if (!d.dirty) { await reloadDoc(d); toast(`Reloaded ${d.name} (changed on disk)`, { ms: 1800 }); }
  else { d.externalChange = true; if (d === active) renderNotice(); }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyColors(settings));
window.addEventListener('beforeunload', () => { if (!EMBED) api('store:set', 'editor-session', snapshot()); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); const paths = [...e.dataTransfer.files].map((f) => window.atlas.pathForFile(f)).filter(Boolean); if (paths.length) openPaths(paths); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !document.activeElement.closest('.cm-editor')) { e.preventDefault(); toggleRef(); }
  // shortcuts that must work even when the editor isn't focused
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n' && !e.shiftKey && !document.activeElement.closest('.cm-editor')) { e.preventDefault(); newDoc(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'o' && !document.activeElement.closest('.cm-editor')) { e.preventDefault(); openDialog(); }
  if (e.ctrlKey && e.key.toLowerCase() === 's' && !document.activeElement.closest('.cm-editor')) { e.preventDefault(); save(active); }
});
window.__ed = { toggleRef, newFeature, installFromDoc, openGuide, openCompare, closeCompare, docs, get active() { return active; }, openPaths, save, setLanguage, toggle, CM };
boot().then(() => initLicense({ test: true })).catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#c00">${esc(e.stack || e.message)}</pre>`; });

// a new document holding some text (in a tab of the main window: a new tab)
function newDocWithText(text) {
  if (EMBED && docs.length) { tellHost({ type: 'open', kind: 'editor', files: [], opts: { text } }); return; }
  const d = makeDoc({ text: '', dirtyText: text }); docs.push(d); activate_(d); renderTabs();
}
// ---------------- the assistant: plain-language edits ("sort the lines", "replace cat with dog", "make it uppercase") ----------------
// Each operation works on the selection when there is one, otherwise on the whole document, in one undo step.
function opRange(v, a = {}) {
  const sel = v.state.selection.main;
  if (a.scope === 'all' || sel.empty) return { from: 0, to: v.state.doc.length, whole: true };
  return { from: sel.from, to: sel.to, whole: false };
}
function opLines(v, a, fn) {
  const r = opRange(v, a);
  const from = r.whole ? 0 : v.state.doc.lineAt(r.from).from, to = r.whole ? v.state.doc.length : v.state.doc.lineAt(r.to).to;
  const before = v.state.sliceDoc(from, to).split('\n');
  const after = fn(before.slice());
  v.dispatch({ changes: { from, to, insert: after.join('\n') }, userEvent: 'input.assistant' });
  return { before: before.length, after: after.length, whole: r.whole };
}
function opText(v, a, fn) {
  const r = opRange(v, a);
  const t = v.state.sliceDoc(r.from, r.to);
  const out = fn(t);
  if (out !== t) v.dispatch({ changes: { from: r.from, to: r.to, insert: out }, userEvent: 'input.assistant' });
  return { changed: out !== t, whole: r.whole };
}
const where = (w) => (w ? 'the whole document' : 'the selection');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
function makeRe(a) {
  let src = a.regex ? a.find : escRe(a.find);
  if (a.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, 'g' + (a.caseSensitive ? '' : 'i') + (a.regex ? 'm' : ''));
}
const CASES = {
  upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(),
  title: (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  sentence: (s) => s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w|\n\s*\w)/g, (c) => c.toUpperCase()),
  invert: (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
  camel: (s) => s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()),
  snake: (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase(),
  kebab: (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase(),
};
const LINEFN = {
  sortAsc: (l) => l.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
  sortDesc: (l) => l.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })),
  sortLen: (l) => l.sort((a, b) => a.length - b.length), sortLenDesc: (l) => l.sort((a, b) => b.length - a.length),
  sortNum: (l) => l.sort((a, b) => (parseFloat(a.replace(/[^\d.-]/g, '')) || 0) - (parseFloat(b.replace(/[^\d.-]/g, '')) || 0)),
  reverse: (l) => l.reverse(),
  shuffle: (l) => { for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; },
  unique: (l) => [...new Set(l)],
  uniqueCI: (l) => { const seen = new Set(); return l.filter((x) => { const k = x.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); },
  removeEmpty: (l) => l.filter((x) => x.trim()),
  collapseEmpty: (l) => l.filter((x, i) => x.trim() || (i > 0 && l[i - 1].trim())),
  trimTrailing: (l) => l.map((x) => x.replace(/\s+$/, '')), trimLeading: (l) => l.map((x) => x.replace(/^\s+/, '')), trim: (l) => l.map((x) => x.trim()),
  number: (l) => { const w = String(l.length).length; return l.map((x, i) => `${String(i + 1).padStart(w, ' ')}. ${x}`); },
  unnumber: (l) => l.map((x) => x.replace(/^\s*(\d+[.):]|[-*•])\s+/, '')),
  bullets: (l) => l.map((x) => (x.trim() ? `- ${x}` : x)),
  tabsToSpaces: (l) => l.map((x) => x.replace(/\t/g, ' '.repeat(ed.tabSize))),
  spacesToTabs: (l) => l.map((x) => x.replace(new RegExp(`^((?: {${ed.tabSize}})+)`), (m) => '\t'.repeat(m.length / ed.tabSize))),
  indent: (l) => l.map((x) => (x ? ' '.repeat(ed.tabSize) + x : x)), outdent: (l) => l.map((x) => x.replace(new RegExp(`^( {1,${ed.tabSize}}|\\t)`), '')),
};
// British ⇄ American spelling: the common word families (colour, organise, centre, travelled, catalogue…)
const UK_US = { colour: 'color', flavour: 'flavor', honour: 'honor', humour: 'humor', labour: 'labor', neighbour: 'neighbor', rumour: 'rumor', vapour: 'vapor', favour: 'favor', behaviour: 'behavior', harbour: 'harbor', armour: 'armor', endeavour: 'endeavor', odour: 'odor', savour: 'savor', vigour: 'vigor', glamour: 'glamor', parlour: 'parlor', splendour: 'splendor', tumour: 'tumor', valour: 'valor',
  centre: 'center', metre: 'meter', litre: 'liter', theatre: 'theater', fibre: 'fiber', calibre: 'caliber', sombre: 'somber', spectre: 'specter', lustre: 'luster', meagre: 'meager', sabre: 'saber',
  analyse: 'analyze', paralyse: 'paralyze', catalyse: 'catalyze', breathalyse: 'breathalyze',
  catalogue: 'catalog', dialogue: 'dialog', analogue: 'analog', monologue: 'monolog', prologue: 'prolog', epilogue: 'epilog',
  defence: 'defense', offence: 'offense', licence: 'license', pretence: 'pretense',
  travelled: 'traveled', travelling: 'traveling', traveller: 'traveler', cancelled: 'canceled', cancelling: 'canceling', labelled: 'labeled', labelling: 'labeling', modelled: 'modeled', modelling: 'modeling', fuelled: 'fueled', fuelling: 'fueling', levelled: 'leveled', counsellor: 'counselor', jewellery: 'jewelry', marvellous: 'marvelous', woollen: 'woolen',
  grey: 'gray', programme: 'program', tyre: 'tire', aluminium: 'aluminum', cheque: 'check', kerb: 'curb', plough: 'plow', mould: 'mold', moult: 'molt', smoulder: 'smolder', manoeuvre: 'maneuver', paediatric: 'pediatric', encyclopaedia: 'encyclopedia', oestrogen: 'estrogen', anaemia: 'anemia', anaesthetic: 'anesthetic', diarrhoea: 'diarrhea', foetus: 'fetus', haemorrhage: 'hemorrhage',
  enrol: 'enroll', fulfil: 'fulfill', instil: 'instill', skilful: 'skillful', wilful: 'willful', judgement: 'judgment', ageing: 'aging', storey: 'story', pyjamas: 'pajamas', draught: 'draft', sceptical: 'skeptical', artefact: 'artifact', practise: 'practice', learnt: 'learned', spelt: 'spelled', dreamt: 'dreamed' };
// -ise / -isation words that are -ize in American English (not "advise", "exercise", "surprise"…)
const ISE_KEEP = /(advis|apprais|aris|chastis|circumcis|compromis|compris|concis|demis|despis|devis|disguis|enterpris|excis|exercis|expertis|franchis|improvis|incis|merchandis|premis|precis|promis|revis|supervis|surmis|surpris|televis|advertis|wis|nois|pois|prais|rais|cruis|bruis|guis|chemis|tis)$/;
function toUS(text) {
  const keepCase = (from, to) => (from === from.toUpperCase() ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);
  let n = 0;
  const words = Object.keys(UK_US).sort((a, b) => b.length - a.length).join('|');
  let out = text.replace(new RegExp(`\\b(${words})(s|ed|ing|ly|ful|ite|ites|ist|ists|ation|ations)?\\b`, 'gi'), (m, w, suf = '') => { n++; return keepCase(m, UK_US[w.toLowerCase()] + suf.toLowerCase()); });
  out = out.replace(/\b([A-Za-z]{3,})is(e|es|ed|ing|ation|ations|er|ers)\b/g, (m, stem, suf) => { if (ISE_KEEP.test((stem + 'is').toLowerCase()) || stem.length < 3) return m; n++; return stem + (m.slice(stem.length, stem.length + 2) === 'IS' ? 'IZ' : 'iz') + suf; });
  out = out.replace(/\b([A-Za-z]{3,})ys(e|es|ed|ing)\b/g, (m, stem, suf) => { if (!/^(anal|paral|catal|breathal|dial)$/i.test(stem)) return m; n++; return stem + 'yz' + suf; });
  return { out, n };
}
function toUK(text) {
  const keepCase = (from, to) => (from === from.toUpperCase() ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);
  const back = Object.fromEntries(Object.entries(UK_US).map(([k, v]) => [v, k]));
  let n = 0;
  const words = Object.keys(back).sort((a, b) => b.length - a.length).join('|');
  const out = text.replace(new RegExp(`\\b(${words})(s|ed|ing)?\\b`, 'gi'), (m, w, suf = '') => { n++; return keepCase(m, back[w.toLowerCase()] + suf.toLowerCase()); }).replace(/\b([A-Za-z]{3,})iz(e|es|ed|ing|ation|ations)\b/g, (m, stem, suf) => { if (/^(pr|s|capsiz)$/i.test(stem)) return m; n++; return stem + 'is' + suf; });
  return { out, n };
}
// CSV / TSV lines ⇄ a Markdown table
function csvRows(t) {
  const sep = (t.match(/\t/g) || []).length > (t.match(/,/g) || []).length ? '\t' : (t.match(/;/g) || []).length > (t.match(/,/g) || []).length ? ';' : ',';
  return t.split(/\r?\n/).filter((l) => l.trim()).map((line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map((x) => x.trim()); });
}
function csvToMd(t) {
  const rows = csvRows(t); if (!rows.length) return t;
  const w = Math.max(...rows.map((r) => r.length)); const cell = (x) => String(x ?? '').replace(/\|/g, '\\|');
  const pad = (r) => [...r, ...Array(w - r.length).fill('')];
  return [`| ${pad(rows[0]).map(cell).join(' | ')} |`, `| ${Array(w).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).map(cell).join(' | ')} |`)].join('\n');
}
function mdToCsv(t) {
  return t.split(/\r?\n/).filter((l) => /^\s*\|/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => { const v = c.trim().replace(/\\\|/g, '|'); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\n');
}
async function assistantOp(op, a = {}) {
  const v = view();
  if (!v && !['new', 'open'].includes(op)) return { ok: false, msg: 'No document is open' };
  if (active?.readonly && !['find', 'goto', 'count', 'stats', 'save', 'saveAs', 'new', 'open', 'wrap', 'zoom', 'selectAll', 'copy', 'lang', 'readonly', 'ask', 'preview'].includes(op)) return { ok: false, msg: 'This document is read-only' };
  const T = () => v.state.doc.toString();
  switch (op) {
    case 'replace': {
      if (!a.find) return { ok: false, msg: 'What should I replace?' };
      let re; try { re = makeRe(a); } catch (e) { return { ok: false, msg: `That pattern doesn’t work: ${e.message}` }; }
      let n = 0;
      const r = opText(v, a, (t) => t.replace(re, (...m) => { n++; return a.regex ? m[0].replace(makeRe({ ...a, find: a.find }), a.with ?? '') : (a.with ?? ''); }));
      return n ? { ok: true, msg: `${a.with ? 'Replaced' : 'Removed'} ${plural(n, 'match')} of “${a.find}”${a.with ? ` with “${a.with}”` : ''} in ${where(r.whole)}` } : { ok: false, msg: `“${a.find}” isn’t in ${where(r.whole)}` };
    }
    case 'spelling': {
      let n = 0; const r = opText(v, a, (t) => { const x = a.to === 'uk' ? toUK(t) : toUS(t); n = x.n; return x.out; });
      return n ? { ok: true, msg: `Changed ${plural(n, 'word')} to ${a.to === 'uk' ? 'British' : 'American'} spelling in ${where(r.whole)}` } : { ok: true, msg: `No ${a.to === 'uk' ? 'American' : 'British'} spellings found in ${where(r.whole)}` };
    }
    case 'table': {
      const r = opText(v, a, (t) => (a.to === 'csv' ? mdToCsv(t) : csvToMd(t)));
      return r.changed ? { ok: true, msg: a.to === 'csv' ? `Turned the table in ${where(r.whole)} into CSV` : `Turned ${where(r.whole)} into a Markdown table` } : { ok: false, msg: 'There’s nothing to turn into a table' };
    }
    case 'compareWith': {
      if (!active?.path) return { ok: false, msg: 'Save this document first, then I can compare it' };
      const name = String(a.file || '').trim();
      let other = /^([a-z]:[\\/]|\\\\|\/)/i.test(name) ? name : dirname(active.path) + (sys.platform === 'win32' ? '\\' : '/') + name;
      if (!name || !(await api('fs:stat', other).catch(() => null))) { const [f] = await api('dialog:openFiles', { title: `Compare with${name ? ` (couldn’t find ${name})` : ''}…`, defaultPath: dirname(active.path) }) || []; if (!f) return { ok: false, msg: name ? `I couldn’t find “${name}” next to this file` : 'Pick a file to compare with' }; other = f; }
      await openCompare(active.path, other);
      if (a.jump !== false && compareView) setTimeout(() => { try { CM.goToNextChunk(compareView.b); } catch {} }, 150);
      return { ok: true, msg: `Comparing with ${basename(other)} — F7 jumps to the next difference` };
    }
    case 'case': { if (a.scope === 'headings') { let n = 0; opLines(v, { ...a, scope: 'all' }, (l) => l.map((x) => (/^\s{0,3}#{1,6}\s/.test(x) || /^[A-Z0-9][^.!?]{0,60}$/.test(x.trim()) && x.trim().split(/\s+/).length <= 10 && x === x.trim() && !/[.,;:]$/.test(x) ? (n++, x.replace(/^(\s*#*\s*)(.*)$/, (m, p, t) => p + CASES[a.to](t))) : x))); return { ok: true, msg: `Changed ${plural(n, 'heading')} to ${{ title: 'Title Case', upper: 'UPPERCASE', lower: 'lowercase', sentence: 'Sentence case' }[a.to] || a.to}` }; }
      const f = CASES[a.to]; if (!f) return { ok: false }; const r = opText(v, a, f); return { ok: true, msg: `Changed ${where(r.whole)} to ${{ upper: 'UPPERCASE', lower: 'lowercase', title: 'Title Case', sentence: 'Sentence case', invert: 'iNVERTED cASE', camel: 'camelCase', snake: 'snake_case', kebab: 'kebab-case' }[a.to]}` }; }
    case 'lines': {
      const f = LINEFN[a.fn]; if (!f) return { ok: false };
      const r = opLines(v, a, f);
      const what = { sortAsc: 'Sorted the lines A → Z', sortDesc: 'Sorted the lines Z → A', sortLen: 'Sorted the lines shortest first', sortLenDesc: 'Sorted the lines longest first', sortNum: 'Sorted the lines by number', reverse: 'Reversed the line order', shuffle: 'Shuffled the lines', unique: 'Removed duplicate lines', uniqueCI: 'Removed duplicate lines (ignoring case)', removeEmpty: 'Removed empty lines', collapseEmpty: 'Collapsed runs of empty lines', trimTrailing: 'Trimmed trailing spaces', trimLeading: 'Trimmed leading spaces', trim: 'Trimmed spaces at both ends of each line', number: 'Numbered the lines', unnumber: 'Removed numbering and bullets', bullets: 'Made each line a bullet', tabsToSpaces: 'Turned tabs into spaces', spacesToTabs: 'Turned leading spaces into tabs', indent: 'Indented the lines', outdent: 'Outdented the lines' }[a.fn];
      const diff = r.before - r.after;
      return { ok: true, msg: `${what}${diff > 0 ? ` (${plural(diff, 'line')} removed)` : ''}` };
    }
    case 'affix': { const r = opLines(v, a, (l) => l.map((x) => (a.skipEmpty !== false && !x.trim() ? x : `${a.before || ''}${x}${a.after || ''}`))); return { ok: true, msg: `Added ${[a.before && `“${a.before}” to the start`, a.after && `“${a.after}” to the end`].filter(Boolean).join(' and ')} of every line${r.whole ? '' : ' in the selection'}` }; }
    case 'filterLines': {
      let re; try { re = makeRe(a); } catch (e) { return { ok: false, msg: e.message }; }
      const r = opLines(v, a, (l) => l.filter((x) => { re.lastIndex = 0; const hit = re.test(x); return a.keep ? hit : !hit; }));
      return { ok: true, msg: `${a.keep ? 'Kept only' : 'Deleted'} the lines containing “${a.find}” (${plural(Math.abs(r.before - r.after), 'line')} removed)` };
    }
    case 'joinLines': { opText(v, a, (s) => s.replace(/\s*\n\s*/g, a.sep ?? ' ')); return { ok: true, msg: 'Joined the lines' }; }
    case 'splitLines': { if (!a.sep) return { ok: false }; let n = 0; opText(v, a, (s) => s.split(a.sep).map((x, i, all) => { if (i < all.length - 1) n++; return a.trim === false ? x : x.trim(); }).join('\n')); return { ok: true, msg: `Split at “${a.sep}” (${plural(n, 'new line')})` }; }
    case 'spaces': { opText(v, a, (s) => s.replace(/[ \t]{2,}/g, ' ')); return { ok: true, msg: 'Collapsed repeated spaces' }; }
    case 'json': { const before = T(); formatJson(!!a.min); return T() !== before ? { ok: true, msg: a.min ? 'Minified the JSON' : 'Formatted the JSON' } : { ok: false, msg: 'This isn’t valid JSON' }; }
    case 'encode': {
      const F = { base64: (s) => btoa(unescape(encodeURIComponent(s))), base64d: (s) => decodeURIComponent(escape(atob(s.trim()))), url: encodeURIComponent, urld: decodeURIComponent, escapeHtml: esc,
        stripHtml: (s) => { const d = new DOMParser().parseFromString(s, 'text/html'); return d.body.textContent || ''; }, reverseText: (s) => [...s].reverse().join(''), smartQuotes: (s) => s.replace(/(^|[\s(\[])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s(\[])'/g, '$1‘').replace(/'/g, '’'), plainQuotes: (s) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'") };
      if (!F[a.kind]) return { ok: false };
      try { opText(v, a, F[a.kind]); } catch { return { ok: false, msg: 'That text can’t be decoded' }; }
      return { ok: true, msg: { base64: 'Encoded as Base64', base64d: 'Decoded the Base64', url: 'URL-encoded', urld: 'URL-decoded', escapeHtml: 'Escaped the HTML', stripHtml: 'Removed the HTML tags', reverseText: 'Reversed the text', smartQuotes: 'Changed to curly quotes', plainQuotes: 'Changed to straight quotes' }[a.kind] };
    }
    case 'extract': {
      const RX = { emails: /[\w.+-]+@[\w-]+\.[\w.-]+/g, urls: /\bhttps?:\/\/[^\s<>"')]+/g, numbers: /-?\d+(?:[.,]\d+)?/g, phones: /\+?\d[\d\s().-]{6,}\d/g, hashtags: /#\w+/g };
      const r = opRange(v, a);
      const found = [...new Set(v.state.sliceDoc(r.from, r.to).match(RX[a.kind]) || [])];
      if (!found.length) return { ok: false, msg: `No ${a.kind} found` };
      newDocWithText(found.join('\n'));
      return { ok: true, msg: `Put ${plural(found.length, a.kind.replace(/s$/, ''))} in a new document` };
    }
    case 'insert': {
      const text = String(a.text ?? '');
      const pos = a.where === 'start' ? 0 : a.where === 'end' ? v.state.doc.length : null;
      if (pos == null) v.dispatch(v.state.replaceSelection(text));
      else { const pre = a.where === 'end' && pos > 0 && !T().endsWith('\n') && a.newline !== false ? '\n' : ''; const post = a.where === 'start' && a.newline !== false && v.state.doc.length ? '\n' : ''; v.dispatch({ changes: { from: pos, insert: pre + text + post } }); }
      return { ok: true, msg: `Inserted ${a.label || `“${text.length > 40 ? text.slice(0, 40) + '…' : text}”`}${a.where === 'start' ? ' at the top' : a.where === 'end' ? ' at the end' : ''}` };
    }
    case 'date': return assistantOp('insert', { text: a.iso ? new Date().toISOString().slice(0, 10) : new Date().toLocaleString(), label: 'the date and time' });
    case 'clear': { v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } }); return { ok: true, msg: 'Cleared the document (Ctrl+Z brings it back)' }; }
    case 'deleteLine': { const n = a.line; if (n) { if (n < 1 || n > v.state.doc.lines) return { ok: false, msg: `There’s no line ${n}` }; const L = v.state.doc.line(n); v.dispatch({ changes: { from: L.from, to: Math.min(v.state.doc.length, L.to + 1) } }); return { ok: true, msg: `Deleted line ${n}` }; } CM.deleteLine(v); return { ok: true, msg: 'Deleted the line' }; }
    case 'duplicateLine': { CM.copyLineDown(v); return { ok: true, msg: 'Duplicated the line' }; }
    case 'goto': {
      const n = a.line === 'last' ? v.state.doc.lines : Math.max(1, Math.min(v.state.doc.lines, a.line | 0));
      const L = v.state.doc.line(n); v.dispatch({ selection: { anchor: L.from }, scrollIntoView: true }); v.focus();
      return { ok: true, msg: `Went to line ${n}` };
    }
    case 'top': v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); return { ok: true, msg: 'Went to the top' };
    case 'bottom': v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true }); return { ok: true, msg: 'Went to the end' };
    case 'find': {
      let re; try { re = makeRe({ ...a, find: a.find || '' }); } catch (e) { return { ok: false, msg: e.message }; }
      const t = T(); const all = [...t.matchAll(re)];
      if (!all.length) return { ok: false, msg: `“${a.find}” isn’t in the document` };
      const ranges = all.slice(0, 5000).map((m) => CM.EditorSelection.range(m.index, m.index + m[0].length));
      v.dispatch({ selection: a.all ? CM.EditorSelection.create(ranges) : CM.EditorSelection.create([ranges[0]]), scrollIntoView: true });
      v.focus();
      return { ok: true, msg: `Found ${plural(all.length, 'match')} of “${a.find}”${a.all ? ' and selected them all' : ` (first one is on line ${v.state.doc.lineAt(all[0].index).number})`}` };
    }
    case 'count': {
      if (a.find) { let re; try { re = makeRe(a); } catch (e) { return { ok: false, msg: e.message }; } const n = (T().match(re) || []).length; return { ok: true, msg: `“${a.find}” appears ${n === 1 ? 'once' : `${n.toLocaleString()} times`}` }; }
      const r = opRange(v, a); const t = v.state.sliceDoc(r.from, r.to);
      const words = (t.match(/\S+/g) || []).length, lines = t ? t.split('\n').length : 0, sentences = (t.match(/[^.!?]+[.!?]+/g) || []).length, paras = t.split(/\n\s*\n/).filter((x) => x.trim()).length;
      return { ok: true, msg: `${r.whole ? 'The document' : 'The selection'} has ${plural(words, 'word')}, ${plural(t.length, 'character')} (${t.replace(/\s/g, '').length.toLocaleString()} without spaces), ${plural(lines, 'line')}, ${plural(sentences, 'sentence')} and ${plural(paras, 'paragraph')}. About ${Math.max(1, Math.round(words / 230))} min to read.`, info: true };
    }
    case 'selectAll': CM.selectAll(v); v.focus(); return { ok: true, msg: 'Selected everything' };
    case 'copy': { const r = opRange(v, a); await api('clip:writeText', v.state.sliceDoc(r.from, r.to)); return { ok: true, msg: `Copied ${where(r.whole)}` }; }
    case 'undo': CM.undo(v); return { ok: true, msg: 'Undid the last change' };
    case 'redo': CM.redo(v); return { ok: true, msg: 'Redid the change' };
    case 'save': { const ok = await save(active); return { ok, msg: ok ? `Saved ${active.name}` : 'Not saved' }; }
    case 'saveAs': { const ok = await saveAs(active); return { ok, msg: ok ? `Saved as ${active.name}` : 'Not saved' }; }
    case 'new': newDoc(); return { ok: true, msg: 'Opened a new document' };
    case 'open': openDialog(); return { ok: true, msg: 'Choose a file to open' };
    case 'wrap': if (!!ed.wrap !== !!a.on) toggle('wrap'); return { ok: true, msg: `Word wrap ${a.on ? 'on' : 'off'}` };
    case 'whitespace': if (!!ed.whitespace !== !!a.on) toggle('whitespace'); return { ok: true, msg: `Whitespace ${a.on ? 'shown' : 'hidden'}` };
    case 'preview': if (!!ed.preview !== !!a.on) toggle('preview'); return { ok: true, msg: `Preview ${a.on ? 'on' : 'off'}` };
    case 'lineNumbers': if (!!ed.lineNumbers !== !!a.on) toggle('lineNumbers'); return { ok: true, msg: `Line numbers ${a.on ? 'on' : 'off'}` };
    case 'zoom': zoom(a.dir); return { ok: true, msg: a.dir === 0 ? 'Zoom reset' : a.dir > 0 ? 'Zoomed in' : 'Zoomed out' };
    case 'fontSize': ed.fontSize = Math.max(8, Math.min(40, a.size | 0)); applyFont(); saveEd(); return { ok: true, msg: `Font size ${ed.fontSize}` };
    case 'tabSize': setTab(a.size); return { ok: true, msg: `Tab size ${a.size}` };
    case 'lang': {
      const q = String(a.name || '').toLowerCase().replace(/^\./, '');
      const L = CM.LANGS.find((l) => l.id === q || l.name.toLowerCase() === q) || CM.LANGS.find((l) => l.name.toLowerCase().startsWith(q) || (l.ext || []).includes?.(q)) || CM.LANGS.find((l) => CM.langForName('x.' + q).id === l.id && l.id !== 'text');
      if (!L) return { ok: false, msg: `I don’t know the language “${a.name}”` };
      setLanguage(active, L.id); return { ok: true, msg: `Language set to ${L.name}` };
    }
    case 'eol': { const k = { windows: '\r\n', crlf: '\r\n', unix: '\n', lf: '\n', linux: '\n', mac: '\r', cr: '\r' }[a.kind]; if (!k) return { ok: false }; active.eol = k; active.dirty = true; renderTabs(); renderStatus(); return { ok: true, msg: `Line endings: ${eolName(k)}` }; }
    case 'encoding': { const E = ENCODINGS.find(([k, l]) => k === a.enc || l.toLowerCase().includes(String(a.enc).toLowerCase())); if (!E) return { ok: false, msg: `Unknown encoding “${a.enc}”` }; active.enc = E[0]; active.dirty = true; renderTabs(); renderStatus(); return { ok: true, msg: `Will save as ${E[1]}` }; }
    case 'readonly': active.readonly = !!a.on; active.view.dispatch({ effects: roC.reconfigure(CM.EditorState.readOnly.of(active.readonly)) }); renderTabs(); return { ok: true, msg: a.on ? 'Read-only on' : 'Read-only off' };
    case 'hash': { await hashText(a.algo || 'SHA-256'); return { ok: true, msg: `${a.algo || 'SHA-256'} copied to the clipboard` }; }
    case 'stats': stats(); return { ok: true, msg: 'Here are the statistics' };
    case 'bookmark': toggleBookmark(); return { ok: true, msg: 'Toggled a bookmark on this line' };
    case 'fold': (a.on ? CM.foldAll : CM.unfoldAll)(v); return { ok: true, msg: a.on ? 'Folded everything' : 'Unfolded everything' };
    case 'comment': CM.toggleComment(v); return { ok: true, msg: 'Toggled comments' };
    case 'close': setTimeout(() => closeDoc(active), 0); return { ok: true, msg: 'Closing the document' };
    case 'context': { const r = opRange(v, a); return { ok: true, name: active.name, lang: active.langId, selection: r.whole ? '' : v.state.sliceDoc(r.from, r.to), text: T().slice(0, 12000), length: v.state.doc.length }; }
    case 'write': {
      // text from the writing model: replace the selection / the document, or insert at the cursor / end
      const text = String(a.text ?? '');
      if (a.mode === 'replaceAll') v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      else if (a.mode === 'replaceSel') { const r = opRange(v, a); v.dispatch({ changes: { from: r.from, to: r.to, insert: text } }); }
      else if (a.mode === 'end') return assistantOp('insert', { text, where: 'end', label: 'the text' });
      else v.dispatch(v.state.replaceSelection(text));
      return { ok: true, msg: 'Done' };
    }
  }
  return { ok: false, msg: `I can’t do “${op}” in Notepad` };
}
onAsk(assistantOp);
