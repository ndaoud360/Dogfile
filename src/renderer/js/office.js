// Dogfile Office: Word, Excel, PowerPoint and PDF files, read and lightly edited inside Dogfile.
//   Word (.docx): shown as a page you can type in (bold, italic, headings, lists…); saved back as .docx.
//   Excel (.xlsx .xls .xlsm .ods): sheets as a grid, cells edited in place (values and formulas).
//   PowerPoint (.pptx): slides drawn from their own layout (text, pictures, shapes), text edited in place, slideshow.
//   PDF: pages drawn by pdf.js; rotate, delete, reorder pages, add text, highlights and drawings; saved with pdf-lib.
//   OneNote (.one): the text found in the notebook page, read-only (its format isn't published in full).
// Saving keeps the original layout where it can; a note says when complex parts (tracked changes, charts…) are
// simplified, and Save a copy is always there.
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, fileUrl, debounce } from './core.js';
import { icon } from './icons.js';
import { confirm, modal } from './dialogs.js';
import { applyColors } from './theme.js';
import { EMBED, pendingFiles, onHost, setTitle, showInFiles, onLeave, onWindowClose, tellHost } from './embed.js';

const $ = (id) => document.getElementById(id);
let sys = {}, settings = { ...DEFAULT_SETTINGS };
let lib = null; // { docx, JSZip, XLSX, PDFLib, mammoth }
const office = async () => (lib ||= await import('../vendor/office.js'));
let pdfjs = null;
const pdfLib = async () => {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
};

const KIND = (p) => {
  const e = (p.split('.').pop() || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['docx', 'docm', 'dotx'].includes(e)) return 'docx';
  if (['xlsx', 'xlsm', 'xls', 'ods', 'xlsb'].includes(e)) return 'xlsx';
  if (['pptx', 'ppsx', 'potx'].includes(e)) return 'pptx';
  if (e === 'one') return 'one';
  if (['doc', 'ppt', 'rtf'].includes(e)) return 'legacy';
  return 'other';
};
const KIND_NAME = { pdf: 'PDF', docx: 'Word document', xlsx: 'Spreadsheet', pptx: 'Presentation', one: 'OneNote page', legacy: 'Older Office file', other: 'File' };
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');

const docs = []; // { path, name, kind, dirty, view: {…kind state} }
let cur = null;

// ---------------------------------------------------------------------------------------------------------------
// files
async function readBytes(path) {
  const r = await fetch(fileUrl(path) + '&b=' + Date.now());
  if (!r.ok) throw new Error(r.status === 404 ? 'The file isn’t there any more' : `Couldn’t read the file (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function writeBytes(path, bytes) {
  const b64 = bytesToB64(bytes);
  const CH = 4 << 20;
  for (let i = 0; i < b64.length || i === 0; i += CH) { await api('fs:writePart', path, b64.slice(i, i + CH), i > 0); if (!b64.length) break; }
  await api('fs:finishPart', path);
}

// ---------------------------------------------------------------------------------------------------------------
// documents and tabs
async function openPaths(paths) {
  let last = null;
  for (const p of paths) {
    let d = docs.find((x) => x.path.toLowerCase() === p.toLowerCase());
    if (!d) { d = { path: p, name: baseName(p), kind: KIND(p), dirty: false, view: null }; docs.push(d); }
    last = d;
  }
  if (last) await show(last);
  renderTabs();
}
function renderTabs() {
  const box = $('of-tabs');
  box.innerHTML = '';
  box.hidden = docs.length < 2;
  for (const d of docs) {
    const t = h('div', { class: 'of-tab' + (d === cur ? ' on' : '') + (d.dirty ? ' dirty' : ''), title: d.path },
      h('span', { class: 'of-kind k-' + d.kind }), h('span', { class: 'of-tname' }, d.name),
      h('button', { class: 'of-tx', title: 'Close', html: icon('close'), onclick: (e) => { e.stopPropagation(); closeDoc(d); } }));
    t.onclick = () => show(d);
    box.append(t);
  }
}
async function closeDoc(d) {
  if (d.dirty && !(await askSave(d))) return;
  const i = docs.indexOf(d);
  docs.splice(i, 1);
  if (cur === d) { cur = null; if (docs.length) await show(docs[Math.max(0, i - 1)]); else showEmpty(); }
  renderTabs();
}
function showEmpty() {
  $('of-doc').innerHTML = ''; $('of-side').innerHTML = ''; $('of-bar').innerHTML = ''; $('of-status').textContent = '';
  $('of-empty').hidden = false; document.body.classList.remove('has-side');
  setTitle('Dogfile Office'); $('of-name').textContent = 'Dogfile Office';
  sendState();
}
function busy(msg) { $('of-busy').classList.toggle('show', !!msg); if (msg) $('of-busy').querySelector('.msg').textContent = msg; }
function setDirty(v = true) {
  if (!cur) return;
  if (cur.dirty === v) return;
  cur.dirty = v; renderTabs(); renderBar(); updateTitle();
}
function updateTitle() {
  if (!cur) return;
  const t = `${cur.dirty ? '● ' : ''}${cur.name} — Dogfile Office`;
  setTitle(t); $('of-name').textContent = (cur.dirty ? '● ' : '') + cur.name;
}

async function show(d) {
  cur = d;
  $('of-empty').hidden = true;
  renderTabs(); updateTitle();
  const doc = $('of-doc');
  doc.innerHTML = ''; doc.className = 'k-' + d.kind; $('of-side').innerHTML = '';
  document.body.classList.remove('has-side');
  if (!d.view) {
    busy('Opening ' + d.name + '…');
    try {
      const bytes = await readBytes(d.path);
      d.view = await LOADERS[d.kind](bytes, d);
    } catch (e) { busy(''); doc.append(errorBox(d, e)); renderBar(); return; }
    busy('');
  }
  if (cur !== d) return;
  await RENDER[d.kind](d);
  renderBar();
}
function errorBox(d, e) {
  return h('div', { class: 'of-err' }, h('div', { class: 'err-title' }, `Couldn’t open ${d.name}`), h('div', { class: 'err-msg' }, String(e?.message || e)),
    h('button', { class: 'btn', onclick: () => api('shell:open', d.path) }, 'Open with the Windows default app'));
}

// ---------------------------------------------------------------------------------------------------------------
// toolbar and saving
function tb(ic, label, run, { on = false, title, disabled = false, primary = false } = {}) {
  const b = h('button', { class: 'of-btn' + (on ? ' on' : '') + (primary ? ' primary' : ''), title: title || label, disabled, html: (ic ? icon(ic) : '') + (label ? `<span>${esc(label)}</span>` : '') });
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the typing place in the document
  b.onclick = run;
  return b;
}
const sep = () => h('span', { class: 'of-sep' });
function renderBar() {
  const bar = $('of-bar');
  bar.innerHTML = '';
  if (!cur || !cur.view) { $('of-status').textContent = ''; return; }
  const canSave = SAVE[cur.kind] && !cur.view.readonly;
  bar.append(
    canSave ? tb('save', 'Save', () => save(false), { disabled: !cur.dirty, primary: cur.dirty, title: 'Save (Ctrl+S)' }) : null,
    canSave ? tb('copy', 'Save a copy', () => save(true), { title: 'Save a copy next to the original (Ctrl+Shift+S)' }) : null,
    tb('print', 'Print', () => print(), { title: 'Print (Ctrl+P)' }),
    tb('sparkle', 'Summarize', () => summarize(), { title: 'A short summary of this document as a note you can save. Made on this PC.' }),
    sep(),
    ...(TOOLS[cur.kind]?.(cur) || []),
    h('span', { class: 'of-grow' }),
    tb('folderOpen', '', () => showInFiles(cur.path), { title: 'Show in folder' }),
    tb('open', '', () => api('shell:open', cur.path), { title: 'Open with the Windows default app' }));
  // in a tab the ribbon has the buttons (the bar above is hidden there); the tips move down here
  const tip = EMBED ? ({ xlsx: ' · Double-click or type to edit a cell, formulas start with =', pptx: ' · Click any text on a slide to change it' }[cur.kind] || '') : '';
  $('of-status').textContent = `${KIND_NAME[cur.kind]} · ${cur.view.status?.() || ''}${tip}`;
  sendState();
}
// in a Dogfile tab: the ribbon shows a Word / Excel / PowerPoint / PDF tab next to View
function sendState() {
  const v = cur?.view;
  tellHost({ type: 'state', kind: 'office', doc: cur?.kind || null, path: cur?.path || null, dirty: !!cur?.dirty, canSave: !!(cur && SAVE[cur.kind] && v && !v.readonly),
    tool: v?.tool || null, fit: v?.zoom === 'fit', sheets: v?.wb?.SheetNames || null, sheet: v?.sheet || null });
}
async function save(copy) {
  const d = cur;
  if (!d?.view || !SAVE[d.kind]) return;
  let target = d.path;
  if (copy) {
    const ext = d.path.split('.').pop();
    target = await api('fs:uniqueName', dirName(d.path), `${d.name.replace(/\.[^.]+$/, '')} (edited).${['xls', 'ods', 'xlsb'].includes(ext.toLowerCase()) ? 'xlsx' : ext}`, 'number');
  } else if (d.view.lossy && !d.warned) {
    const ok = await confirm('Save over the original?', `${esc(d.view.lossy)}<br><br>Choose <b>Save a copy</b> instead to keep the original as it is.`, { ok: 'Save' });
    if (!ok) return false;
    d.warned = true;
  }
  if (!copy && ['xls', 'ods', 'xlsb'].includes(d.path.split('.').pop().toLowerCase())) target = d.path.replace(/\.[^.]+$/, '.xlsx');
  busy('Saving…');
  try {
    const bytes = await SAVE[d.kind](d);
    await writeBytes(target, bytes);
    busy('');
    if (!copy) { if (target !== d.path) { d.path = target; d.name = baseName(target); } setDirty(false); await AFTER[d.kind]?.(d, bytes); }
    toast(copy ? `Saved a copy: ${baseName(target)}` : 'Saved', { action: { label: 'Show', run: () => showInFiles(target) } });
    return true;
  } catch (e) { busy(''); toast(`Couldn’t save: ${e.message}`, { error: true }); return false; }
}
// Summarize: a short summary as a new Dogfile Notepad note (made on this PC, free). Word documents send what's on the
// page, so changes that aren't saved yet are included.
let summarizing = false;
async function summarize() {
  const d = cur;
  if (!d || summarizing) return;
  summarizing = true;
  busy('Summarizing…');
  try {
    // the text as Dogfile Office sees it: Word from the page (unsaved changes too), PDF from pdf.js, which reads any font
    const text = d.kind === 'docx' ? (d.view.page?.innerText || '') : d.kind === 'pdf' && d.view.pdf ? await pdfText(d.view.pdf, (n, of) => busy(`Reading page ${n} of ${of}…`)) : '';
    if (d.kind === 'pdf') busy('Summarizing…');
    const r = await api('doc:summarize', { path: d.path, name: d.name, text });
    const opts = { text: r.markdown, name: r.name, dir: dirName(d.path) };
    if (EMBED) tellHost({ type: 'open', kind: 'editor', files: [], opts: { ...opts, inTab: true } });
    else await api('tool:open', 'editor', [], opts);
  } catch (e) { toast(e.message || String(e), { error: true }); }
  finally { busy(''); summarizing = false; }
}
// every page's text, with line breaks where the lines are
async function pdfText(pdf, onPage) {
  let out = '';
  for (let i = 1; i <= pdf.numPages && out.length < 600000; i++) {
    if (i % 10 === 1) onPage?.(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform?.[5];
      if (lastY != null && y != null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
      out += it.str;
      if (it.hasEOL) out += '\n';
      if (y != null) lastY = y;
    }
    out += '\n\n';
    page.cleanup?.();
  }
  return out;
}
async function askSave(d) {
  const v = await modal({ title: 'Save your changes?', width: 440, body: h('div', {}, `“${d.name}” has changes that aren’t saved.`),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Don’t save', value: 'discard' }, { label: 'Save a copy', value: 'copy' }, { label: 'Save', primary: true, value: 'save' }], closeOnBackdrop: false });
  if (v === 'discard') return true;
  if (v === 'save' || v === 'copy') { const prev = cur; cur = d; const ok = await save(v === 'copy'); cur = prev; return ok; }
  return false;
}
function print() {
  document.body.classList.add('printing-' + cur.kind);
  setTimeout(() => { window.print(); document.body.classList.remove('printing-' + cur.kind); }, 50);
}

// ---------------------------------------------------------------------------------------------------------------
// Word
const LOADERS = {}, RENDER = {}, SAVE = {}, TOOLS = {}, AFTER = {};
LOADERS.docx = async (bytes) => {
  const { mammoth } = await office();
  const r = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer }, {
    convertImage: mammoth.images.imgElement((img) => img.read('base64').then((b) => ({ src: `data:${img.contentType};base64,${b}` }))),
    styleMap: ['p[style-name=\'Title\'] => h1.doc-title:fresh', 'p[style-name=\'Subtitle\'] => p.doc-subtitle:fresh'],
  });
  const v = { html: r.value || '<p></p>', lossy: 'Text, headings, bold, italic, underline, lists, links, tables and pictures are kept. Page layout details (columns, headers and footers, comments, tracked changes) are simplified.' };
  v.status = () => { const n = (v.page?.innerText || '').trim().split(/\s+/).filter(Boolean).length; return `${n.toLocaleString()} words`; };
  return v;
};
RENDER.docx = (d) => {
  const page = h('div', { class: 'doc-page', contenteditable: 'true', spellcheck: 'true' });
  page.innerHTML = d.view.page ? d.view.page.innerHTML : d.view.html;
  d.view.page = page;
  page.addEventListener('input', () => { setDirty(true); statusSoon(); });
  page.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); exec({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]); }
  });
  $('of-doc').append(h('div', { class: 'doc-scroll' }, page));
};
const statusSoon = debounce(() => { if (cur?.view?.status) $('of-status').textContent = `${KIND_NAME[cur.kind]} · ${cur.view.status()}`; }, 400);
// the typing place in the page, kept so the ribbon (outside this page) can still format the selected words
let lastRange = null;
document.addEventListener('selectionchange', () => { const sel = getSelection(); const page = cur?.view?.page; if (page && sel.rangeCount && page.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange(); });
function exec(cmd, val) {
  const page = cur?.view?.page;
  if (page && document.activeElement !== page) { page.focus(); if (lastRange && page.contains(lastRange.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(lastRange); } }
  document.execCommand(cmd, false, val); setDirty(true);
}
TOOLS.docx = () => [
  tb('', 'B', () => exec('bold'), { title: 'Bold (Ctrl+B)' }), tb('', 'I', () => exec('italic'), { title: 'Italic (Ctrl+I)' }), tb('', 'U', () => exec('underline'), { title: 'Underline (Ctrl+U)' }),
  sep(),
  tb('', 'Title', () => exec('formatBlock', 'h1')), tb('', 'Heading', () => exec('formatBlock', 'h2')), tb('', 'Text', () => exec('formatBlock', 'p')),
  sep(),
  tb('', '• List', () => exec('insertUnorderedList'), { title: 'Bulleted list' }), tb('', '1. List', () => exec('insertOrderedList'), { title: 'Numbered list' }),
  sep(),
  tb('', 'Left', () => exec('justifyLeft')), tb('', 'Center', () => exec('justifyCenter')), tb('', 'Right', () => exec('justifyRight')),
  sep(),
  tb('undo', '', () => exec('undo'), { title: 'Undo (Ctrl+Z)' }), tb('redo', '', () => exec('redo'), { title: 'Redo (Ctrl+Y)' }),
];
SAVE.docx = async (d) => {
  const { docx } = await office();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun, ExternalHyperlink, LevelFormat } = docx;
  const H = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3, H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };
  const align = (el) => { const a = (el.style?.textAlign || el.getAttribute?.('align') || '').toLowerCase(); return a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : a === 'justify' ? AlignmentType.JUSTIFIED : undefined; };
  const dataBytes = (src) => { const b = atob(src.split(',')[1] || ''); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  // the words and pictures inside a block, with their formatting
  const runs = (node, fmt = {}) => {
    const out = [];
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.textContent) out.push(new TextRun({ text: c.textContent.replace(/\s+/g, ' '), ...fmt })); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (tag === 'BR') { out.push(new TextRun({ text: '', break: 1 })); continue; }
      if (tag === 'IMG' && c.src.startsWith('data:')) {
        const w = Math.min(600, c.naturalWidth || c.width || 300), hh = Math.round(w * ((c.naturalHeight || c.height || 200) / (c.naturalWidth || c.width || 300)));
        const type = /image\/png/.test(c.src) ? 'png' : /image\/gif/.test(c.src) ? 'gif' : /image\/bmp/.test(c.src) ? 'bmp' : 'jpg';
        try { out.push(new ImageRun({ type, data: dataBytes(c.src), transformation: { width: w, height: hh } })); } catch {}
        continue;
      }
      const f = { ...fmt };
      if (tag === 'B' || tag === 'STRONG' || c.style?.fontWeight === 'bold' || +c.style?.fontWeight >= 600) f.bold = true;
      if (tag === 'I' || tag === 'EM' || c.style?.fontStyle === 'italic') f.italics = true;
      if (tag === 'U' || /underline/.test(c.style?.textDecoration || '')) f.underline = {};
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(c.style?.textDecoration || '')) f.strike = true;
      if (tag === 'SUP') f.superScript = true;
      if (tag === 'SUB') f.subScript = true;
      if (tag === 'A' && c.href) { out.push(new ExternalHyperlink({ link: c.href, children: runs(c, { ...f, style: 'Hyperlink' }) })); continue; }
      out.push(...runs(c, f));
    }
    return out;
  };
  const blocks = (container, ctx = {}) => {
    const out = [];
    let loose = [];
    const flush = () => { if (loose.length) { const p = document.createElement('p'); loose.forEach((n) => p.append(n.cloneNode(true))); out.push(new Paragraph({ children: runs(p) })); loose = []; } };
    for (const el of container.childNodes) {
      if (el.nodeType === 3 || (el.nodeType === 1 && /^(B|I|U|STRONG|EM|SPAN|A|IMG|BR|SUP|SUB|S)$/.test(el.tagName))) { if (el.textContent.trim() || el.tagName === 'IMG') loose.push(el); continue; }
      if (el.nodeType !== 1) continue;
      flush();
      const tag = el.tagName;
      if (H[tag]) out.push(new Paragraph({ heading: tag === 'H1' && el.classList.contains('doc-title') ? HeadingLevel.TITLE : H[tag], alignment: align(el), children: runs(el) }));
      else if (tag === 'UL' || tag === 'OL') {
        for (const li of el.children) {
          if (li.tagName !== 'LI') continue;
          const nested = [...li.children].filter((x) => x.tagName === 'UL' || x.tagName === 'OL');
          const clone = li.cloneNode(true); clone.querySelectorAll('ul,ol').forEach((x) => x.remove());
          out.push(new Paragraph({ children: runs(clone), ...(tag === 'OL' ? { numbering: { reference: 'nums', level: ctx.level || 0 } } : { bullet: { level: ctx.level || 0 } }) }));
          for (const n of nested) out.push(...blocks(h('div', {}, n.cloneNode(true)), { level: (ctx.level || 0) + 1 }));
        }
      } else if (tag === 'TABLE') {
        const rows = [...el.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')];
        if (rows.length) out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map((tr) => new TableRow({ children: [...tr.children].map((td) => new TableCell({ children: (() => { const b = blocks(td); return b.length ? b : [new Paragraph('')]; })() })) })) }));
      } else if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'BLOCKQUOTE') out.push(...blocks(el, ctx));
      else if (tag === 'HR') out.push(new Paragraph({ thematicBreak: true, children: [] }));
      else out.push(new Paragraph({ alignment: align(el), children: runs(el) }));
    }
    flush();
    return out;
  };
  const children = blocks(d.view.page);
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'nums', levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
  });
  return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
};

// ---------------------------------------------------------------------------------------------------------------
// Excel
LOADERS.xlsx = async (bytes) => {
  const { XLSX } = await office();
  const wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellDates: false, cellNF: true, cellStyles: false, sheetStubs: true });
  try { recalc(wb, { all: true }); } catch (e) { console.warn('formulas', e); } // some programs save formulas without their results
  const v = { wb, sheet: wb.SheetNames[0], sel: { r: 0, c: 0 }, lossy: 'Values and formulas are kept. Colours, fonts, charts and pictures in the workbook are not kept when it’s saved here.' };
  v.status = () => { const ws = wb.Sheets[v.sheet]; const ref = ws?.['!ref'] || 'A1'; return `${wb.SheetNames.length} sheet${wb.SheetNames.length > 1 ? 's' : ''} · ${v.sheet} · ${ref}`; };
  return v;
};
const MAX_R = 3000, MAX_C = 120;
RENDER.xlsx = async (d) => {
  const { XLSX } = await office();
  const v = d.view, ws = v.wb.Sheets[v.sheet];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const nr = Math.min(Math.max(range.e.r + 1, 40), MAX_R), nc = Math.min(Math.max(range.e.c + 1, 12), MAX_C);
  const wrap = h('div', { class: 'xl' });
  const fx = h('input', { class: 'xl-fx input', placeholder: 'Value or =formula', spellcheck: 'false' });
  const addr = h('span', { class: 'xl-addr' });
  const head = h('div', { class: 'xl-fxbar' }, addr, fx);
  const grid = h('div', { class: 'xl-grid', tabindex: '0' });
  const table = document.createElement('table');
  let html = '<thead><tr><th class="corner"></th>';
  for (let c = 0; c < nc; c++) html += `<th>${XLSX.utils.encode_col(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 0; r < nr; r++) {
    html += `<tr><th>${r + 1}</th>`;
    for (let c = 0; c < nc; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      html += `<td data-r="${r}" data-c="${c}"${cell?.t === 'n' ? ' class="num"' : ''}>${esc(cellText(cell))}</td>`;
    }
    html += '</tr>';
  }
  table.innerHTML = html + '</tbody>';
  grid.append(table);
  const tabs = h('div', { class: 'xl-tabs' });
  for (const name of v.wb.SheetNames) tabs.append(h('button', { class: 'xl-tab' + (name === v.sheet ? ' on' : ''), onclick: () => { v.sheet = name; v.sel = { r: 0, c: 0 }; $('of-doc').innerHTML = ''; RENDER.xlsx(d); renderBar(); } }, name));
  const more = range.e.r + 1 > MAX_R || range.e.c + 1 > MAX_C ? h('div', { class: 'xl-more' }, `Showing the first ${MAX_R.toLocaleString()} rows and ${MAX_C} columns of ${ws['!ref']}.`) : null;
  wrap.append(head, grid, more, tabs);
  $('of-doc').append(wrap);
  const td = (r, c) => table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  const select = (r, c) => {
    r = Math.max(0, Math.min(nr - 1, r)); c = Math.max(0, Math.min(nc - 1, c));
    table.querySelector('td.sel')?.classList.remove('sel');
    const el = td(r, c); el?.classList.add('sel'); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    v.sel = { r, c };
    const ref = XLSX.utils.encode_cell({ r, c });
    addr.textContent = ref;
    const cell = ws[ref];
    fx.value = cell ? (cell.f ? '=' + cell.f : cell.v ?? '') : '';
  };
  const commit = (r, c, text) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const old = ws[ref];
    const was = old ? (old.f ? '=' + old.f : String(old.v ?? '')) : '';
    if (text === was) return;
    if (text === '') delete ws[ref];
    else if (text.startsWith('=')) ws[ref] = { t: 'n', f: text.slice(1), v: undefined };
    else if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(text.trim())) ws[ref] = { t: 'n', v: +text };
    else if (/^(true|false)$/i.test(text.trim())) ws[ref] = { t: 'b', v: /^true$/i.test(text.trim()) };
    else ws[ref] = { t: 's', v: text };
    if (ws[ref]?.f) ws[ref].__had = null;
    // other formulas may depend on this one
    try { recalc(v.wb, { all: true }); } catch (e) { console.warn('formulas', e); }
    for (const k of Object.keys(ws)) if (k[0] !== '!' && ws[k].f && k !== ref) { const a = XLSX.utils.decode_cell(k); const el = td(a.r, a.c); if (el) { el.textContent = cellText(ws[k]); el.classList.toggle('num', ws[k].t === 'n'); } }
    const r0 = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: Math.min(r0.s.r, r), c: Math.min(r0.s.c, c) }, e: { r: Math.max(r0.e.r, r), c: Math.max(r0.e.c, c) } });
    const el = td(r, c); if (el) { el.textContent = cellText(ws[ref]); el.classList.toggle('num', ws[ref]?.t === 'n'); }
    setDirty(true);
  };
  // typing straight into a cell
  let editing = null;
  const startEdit = (r, c, initial) => {
    const el = td(r, c); if (!el) return;
    const ref = XLSX.utils.encode_cell({ r, c }); const cell = ws[ref];
    const inp = h('input', { class: 'xl-edit', spellcheck: 'false' });
    inp.value = initial ?? (cell ? (cell.f ? '=' + cell.f : String(cell.v ?? '')) : '');
    el.textContent = ''; el.append(inp); inp.focus();
    editing = { r, c, inp };
    const done = (keep, move) => {
      if (!editing) return;
      editing = null;
      const val = inp.value; inp.remove();
      el.textContent = cellText(ws[ref]);
      if (keep) commit(r, c, val);
      if (move) select(r + move[0], c + move[1]);
      grid.focus();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true, [e.shiftKey ? -1 : 1, 0]); }
      else if (e.key === 'Tab') { e.preventDefault(); done(true, [0, e.shiftKey ? -1 : 1]); }
      else if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));
  };
  table.addEventListener('mousedown', (e) => { const el = e.target.closest('td'); if (!el || editing) return; select(+el.dataset.r, +el.dataset.c); });
  table.addEventListener('dblclick', (e) => { const el = e.target.closest('td'); if (el) startEdit(+el.dataset.r, +el.dataset.c); });
  grid.addEventListener('keydown', (e) => {
    if (editing) return;
    const { r, c } = v.sel;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, e.shiftKey ? -1 : 1] }[e.key];
    if (mv) { e.preventDefault(); select(r + mv[0], c + mv[1]); return; }
    if (e.key === 'F2') { e.preventDefault(); startEdit(r, c); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commit(r, c, ''); select(r, c); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(r, c, e.key); }
  });
  fx.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { commit(v.sel.r, v.sel.c, fx.value); select(v.sel.r + 1, v.sel.c); grid.focus(); } if (e.key === 'Escape') { select(v.sel.r, v.sel.c); grid.focus(); } });
  select(v.sel.r, v.sel.c);
  grid.focus();
};
// A small formula engine for the everyday functions, so totals show and follow edits. The window's safety rules
// don't allow running text as code, so formulas are read with a tiny parser. Anything it doesn't know keeps the value
// Excel saved (or shows the formula), and Excel works everything out again when the file opens there.
class Unknown extends Error {}
class CellErr extends Error {}
const colNum = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
function tokens(src) {
  const out = [];
  const re = /\s*(?:("(?:[^"]|"")*")|((?:'[^']+'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(])|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][\w.]*)\s*\(|(TRUE|FALSE)\b|(<>|<=|>=|[-+*/^&=<>(),%:]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src))) { if (/^\s*$/.test(src.slice(at))) break; throw new Unknown(); }
    if (m[1]) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/""/g, '"') });
    else if (m[3]) out.push({ t: 'ref', sheet: m[2] ? m[2].slice(0, -1).replace(/^'|'$/g, '') : null, v: m[3].replace(/\$/g, '').toUpperCase() });
    else if (m[4]) out.push({ t: 'num', v: +m[4] });
    else if (m[5]) out.push({ t: 'fn', v: m[5].toUpperCase().replace(/^_XLFN\./, '') });
    else if (m[6]) out.push({ t: 'bool', v: m[6] === 'TRUE' });
    else if (m[7]) out.push({ t: 'op', v: m[7] });
  }
  return out;
}
const num = (x) => { if (Array.isArray(x)) x = x[0]; if (typeof x === 'number') return x; if (typeof x === 'boolean') return +x; if (x == null || x === '') return 0; const n = +x; if (Number.isNaN(n)) throw new CellErr('#VALUE!'); return n; };
const flat = (args) => args.flat(Infinity);
const nums = (args) => flat(args).filter((x) => typeof x === 'number');
const str = (x) => { if (Array.isArray(x)) x = x[0]; return typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : x == null ? '' : String(x); };
const truthy = (x) => { if (Array.isArray(x)) x = x[0]; return typeof x === 'string' ? x !== '' && x.toUpperCase() !== 'FALSE' : !!x; };
const roundTo = (x, d, f = Math.round) => { const k = 10 ** d; return f(x * k) / k; };
const FN = {
  SUM: (a) => nums(a).reduce((s, x) => s + x, 0),
  PRODUCT: (a) => nums(a).reduce((s, x) => s * x, 1),
  AVERAGE: (a) => { const n = nums(a); if (!n.length) throw new CellErr('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => nums(a).length,
  COUNTA: (a) => flat(a).filter((x) => x !== '' && x != null).length,
  COUNTBLANK: (a) => flat(a).filter((x) => x === '' || x == null).length,
  ABS: (a) => Math.abs(num(a[0])), INT: (a) => Math.floor(num(a[0])), SQRT: (a) => Math.sqrt(num(a[0])), POWER: (a) => num(a[0]) ** num(a[1]),
  MOD: (a) => { const d = num(a[1]); if (!d) throw new CellErr('#DIV/0!'); const r = num(a[0]) % d; return r && (r < 0) !== (d < 0) ? r + d : r; },
  ROUND: (a) => roundTo(num(a[0]), num(a[1] ?? 0)), ROUNDUP: (a) => roundTo(num(a[0]), num(a[1] ?? 0), (x) => (x < 0 ? Math.floor(x) : Math.ceil(x))), ROUNDDOWN: (a) => roundTo(num(a[0]), num(a[1] ?? 0), Math.trunc),
  IF: (a) => (truthy(a[0]) ? a[1] ?? true : a[2] ?? false),
  IFERROR: (a) => a[0], // errors are caught where IFERROR is called
  AND: (a) => flat(a).every(truthy), OR: (a) => flat(a).some(truthy), NOT: (a) => !truthy(a[0]),
  CONCAT: (a) => flat(a).map(str).join(''), CONCATENATE: (a) => flat(a).map(str).join(''),
  LEN: (a) => str(a[0]).length, UPPER: (a) => str(a[0]).toUpperCase(), LOWER: (a) => str(a[0]).toLowerCase(), TRIM: (a) => str(a[0]).trim().replace(/\s+/g, ' '),
  LEFT: (a) => str(a[0]).slice(0, num(a[1] ?? 1)), RIGHT: (a) => { const t = str(a[0]), n = num(a[1] ?? 1); return n ? t.slice(-n) : ''; }, MID: (a) => str(a[0]).substr(num(a[1]) - 1, num(a[2])),
  PI: () => Math.PI,
};
function evaluate(wb, sheetName, formula, seen) {
  const tk = tokens(formula);
  let i = 0;
  const peek = () => tk[i], isOp = (v) => tk[i]?.t === 'op' && tk[i].v === v;
  const take = (v) => { if (!isOp(v)) throw new Unknown(); i++; };
  const cellVal = (sheet, ref) => cellValue(wb, sheet || sheetName, ref, seen);
  const range = (sheet, a, b) => {
    const ws = wb.Sheets[sheet || sheetName]; if (!ws) throw new CellErr('#REF!');
    const pa = /^([A-Z]+)(\d+)$/.exec(a), pb = /^([A-Z]+)(\d+)$/.exec(b);
    const c1 = Math.min(colNum(pa[1]), colNum(pb[1])), c2 = Math.max(colNum(pa[1]), colNum(pb[1])), r1 = Math.min(+pa[2], +pb[2]) - 1, r2 = Math.max(+pa[2], +pb[2]) - 1;
    const lim = ws['!ref'] ? /:?[A-Z]+(\d+)$/.exec(ws['!ref']) : null;
    const rEnd = Math.min(r2, lim ? +lim[1] - 1 : r2);
    const out = [];
    for (let r = r1; r <= rEnd; r++) for (let c = c1; c <= c2; c++) out.push(cellVal(sheet, colName(c) + (r + 1)));
    return out;
  };
  const primary = () => {
    const t = peek(); if (!t) throw new Unknown();
    i++;
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool') return t.v;
    if (t.t === 'ref') { const [a, b] = t.v.split(':'); return b ? range(t.sheet, a, b) : cellVal(t.sheet, a); }
    if (t.t === 'fn') {
      const f = FN[t.v]; if (!f) throw new Unknown();
      const args = [];
      if (!isOp(')')) {
        for (;;) {
          if (t.v === 'IFERROR' && args.length === 0) { const save = i; try { args.push(compare()); } catch (e) { if (e instanceof Unknown) throw e; i = save; skipArg(); args.push(null); args.err = true; } }
          else if (t.v === 'IF' && args.length && (args.length === 1) !== truthy(args[0])) { skipArg(); args.push(null); } // the branch not taken isn't worked out
          else args.push(compare());
          if (isOp(',')) { i++; continue; }
          break;
        }
      }
      take(')');
      if (t.v === 'IFERROR' && args.err) return args[1] ?? '';
      return f(args);
    }
    if (t.t === 'op' && t.v === '(') { const v = compare(); take(')'); return v; }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { const v = num(power()); return t.v === '-' ? -v : v; }
    throw new Unknown();
  };
  const skipArg = () => { let depth = 0; while (i < tk.length) { const t = tk[i]; if (t.t === 'fn' || (t.t === 'op' && t.v === '(')) depth++; else if (t.t === 'op' && t.v === ')') { if (!depth) return; depth--; } else if (t.t === 'op' && t.v === ',' && !depth) return; i++; } };
  const postfix = () => { let v = primary(); while (isOp('%')) { i++; v = num(v) / 100; } return v; };
  const power = () => { let v = postfix(); while (isOp('^')) { i++; v = num(v) ** num(postfix()); } return v; };
  const mul = () => { let v = power(); while (isOp('*') || isOp('/')) { const o = tk[i++].v, r = num(power()); if (o === '/' && !r) throw new CellErr('#DIV/0!'); v = o === '*' ? num(v) * r : num(v) / r; } return v; };
  const add = () => { let v = mul(); while (isOp('+') || isOp('-')) { const o = tk[i++].v, r = num(mul()); v = o === '+' ? num(v) + r : num(v) - r; } return v; };
  const concat = () => { let v = add(); while (isOp('&')) { i++; v = str(v) + str(add()); } return v; };
  const compare = () => {
    let v = concat();
    while (['=', '<>', '<', '>', '<=', '>='].some(isOp)) {
      const o = tk[i++].v, r = concat();
      const a = Array.isArray(v) ? v[0] : v, b = Array.isArray(r) ? r[0] : r;
      const x = typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() : a, y = typeof a === 'string' && typeof b === 'string' ? b.toLowerCase() : b;
      v = o === '=' ? x == y : o === '<>' ? x != y : o === '<' ? x < y : o === '>' ? x > y : o === '<=' ? x <= y : x >= y; // eslint-disable-line eqeqeq
    }
    return v;
  };
  const v = compare();
  if (i < tk.length) throw new Unknown();
  return Array.isArray(v) ? v[0] : v;
}
const colName = (c) => { let s = ''; c++; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
// a cell's value, working out its formula first when it needs to
function cellValue(wb, sheet, ref, seen) {
  const ws = wb.Sheets[sheet]; if (!ws) throw new CellErr('#REF!');
  const cell = ws[ref];
  if (!cell) return '';
  if (cell.f && cell.__calc) {
    const key = sheet + '!' + ref;
    if (seen.has(key)) throw new CellErr('#CYCLE!');
    seen.add(key);
    try { workOut(wb, sheet, ref, cell, seen); } finally { seen.delete(key); }
  }
  if (cell.t === 'e') throw new CellErr(cell.w || '#VALUE!');
  return cell.v ?? '';
}
function workOut(wb, sheet, ref, cell, seen = new Set()) {
  cell.__calc = false;
  try {
    const v = evaluate(wb, sheet, cell.f, seen);
    cell.v = v ?? 0; cell.t = typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's';
    cell.w = typeof v === 'number' ? String(Math.abs(v) < 1e15 ? +v.toPrecision(12) : v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  } catch (e) {
    if (e instanceof CellErr) { cell.t = 'e'; cell.w = e.message; cell.v = { '#DIV/0!': 7, '#REF!': 23 }[e.message] ?? 15; }
    else if (e instanceof Unknown) { if (cell.__had) { cell.v = cell.__had.v; cell.w = cell.__had.w; cell.t = cell.__had.t; } else { cell.v = undefined; delete cell.w; } }
    else throw e;
  }
}
// work out formulas: all of them after an edit, or just those with no saved result when the file opens
function recalc(wb, { all = false } = {}) {
  const todo = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const ref of Object.keys(ws)) {
      if (ref[0] === '!') continue;
      const c = ws[ref];
      if (!c.f) continue;
      if (!all && c.v !== undefined && !(c.v === '' && !c.w)) continue;
      if (c.__had === undefined) c.__had = c.v !== undefined && !(c.v === '' && !c.w) ? { v: c.v, w: c.w, t: c.t } : null;
      c.__calc = true; todo.push([name, ref, c]);
    }
  }
  for (const [name, ref, c] of todo) if (c.__calc) workOut(wb, name, ref, c);
}
function cellText(cell) {
  if (!cell) return '';
  if (cell.f && (cell.v === undefined || (cell.v === '' && !cell.w))) return '=' + cell.f;
  if (cell.w != null && cell.v !== undefined) return cell.w;
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  return cell.v == null ? '' : String(cell.v);
}
TOOLS.xlsx = (d) => [h('span', { class: 'of-hint' }, 'Double-click or type to edit a cell · Enter moves down · formulas start with =')];
SAVE.xlsx = async (d) => {
  const { XLSX } = await office();
  // drop the text Excel had shown for cells changed here, so it's worked out again
  return new Uint8Array(XLSX.write(d.view.wb, { type: 'array', bookType: 'xlsx', compression: true }));
};

// ---------------------------------------------------------------------------------------------------------------
// PowerPoint
const EMU = 12700; // per point
const NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main', p: 'http://schemas.openxmlformats.org/presentationml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
const kids = (el, ns, name) => (el ? [...el.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === NS[ns] && n.localName === name) : []);
const kid = (el, ns, name) => kids(el, ns, name)[0] || null;
const deep = (el, ns, name) => (el ? [...el.getElementsByTagNameNS(NS[ns], name)] : []);
const resolve = (base, target) => { const parts = base.split('/'); parts.pop(); for (const s of target.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); } return parts.join('/'); };
async function rels(zip, part) {
  const p = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const x = await zip.file(p)?.async('string');
  const m = {};
  if (!x) return m;
  const doc = new DOMParser().parseFromString(x, 'application/xml');
  for (const r of doc.getElementsByTagName('Relationship')) m[r.getAttribute('Id')] = { target: r.getAttribute('TargetMode') === 'External' ? r.getAttribute('Target') : resolve(part, r.getAttribute('Target')), type: r.getAttribute('Type') };
  return m;
}
LOADERS.pptx = async (bytes) => {
  const { JSZip } = await office();
  const zip = await JSZip.loadAsync(bytes);
  const presPath = 'ppt/presentation.xml';
  const pres = new DOMParser().parseFromString(await zip.file(presPath).async('string'), 'application/xml');
  const sz = deep(pres, 'p', 'sldSz')[0];
  const W = +(sz?.getAttribute('cx') || 12192000), H = +(sz?.getAttribute('cy') || 6858000);
  const prel = await rels(zip, presPath);
  const order = deep(pres, 'p', 'sldId').map((s) => prel[s.getAttributeNS(NS.r, 'id')]?.target).filter(Boolean);
  const media = new Map();
  const mediaUrl = async (path) => { if (!media.has(path)) { const f = zip.file(path); media.set(path, f ? URL.createObjectURL(new Blob([await f.async('uint8array')], { type: /\.png$/i.test(path) ? 'image/png' : /\.svg$/i.test(path) ? 'image/svg+xml' : /\.gif$/i.test(path) ? 'image/gif' : 'image/jpeg' })) : ''); } return media.get(path); };
  const parsed = new Map();
  const xml = async (path) => { if (!parsed.has(path)) { const s = await zip.file(path)?.async('string'); parsed.set(path, s ? new DOMParser().parseFromString(s, 'application/xml') : null); } return parsed.get(path); };
  const slides = [];
  const themes = new Map();
  for (const path of order) {
    const doc = await xml(path);
    const r = await rels(zip, path);
    const layoutPath = Object.values(r).find((x) => /slideLayout/.test(x.type))?.target;
    const layout = layoutPath ? await xml(layoutPath) : null;
    const lr = layoutPath ? await rels(zip, layoutPath) : {};
    const masterPath = Object.values(lr).find((x) => /slideMaster/.test(x.type))?.target;
    const master = masterPath ? await xml(masterPath) : null;
    const mr = masterPath ? await rels(zip, masterPath) : {};
    const themePath = Object.values(mr).find((x) => /\/theme$/.test(x.type))?.target;
    const theme = themePath ? await xml(themePath) : null;
    if (!themes.has(themePath)) themes.set(themePath, themeColors(theme, master));
    slides.push({ path, doc, rels: r, layout, master, colors: themes.get(themePath), edited: false });
  }
  const v = { zip, slides, W, H, idx: 0, mediaUrl, lossy: null };
  v.status = () => `Slide ${v.idx + 1} of ${slides.length}`;
  return v;
};
// the layout's and the master's version of a placeholder: where it sits and how its text looks when the slide doesn't say
function inherited(sp, slide) {
  const ph = deep(sp, 'p', 'ph')[0];
  if (!ph) return [];
  const type = ph.getAttribute('type') || 'body', idx = ph.getAttribute('idx');
  const out = [];
  for (const src of [slide.layout, slide.master]) {
    if (!src) continue;
    const all = deep(src, 'p', 'sp').filter((s) => deep(s, 'p', 'ph')[0]);
    const tOf = (s) => deep(s, 'p', 'ph')[0].getAttribute('type') || 'body';
    const want = type === 'ctrTitle' ? ['ctrTitle', 'title'] : type === 'subTitle' ? ['subTitle', 'body'] : [type];
    const hit = (src === slide.layout && idx && all.find((s) => deep(s, 'p', 'ph')[0].getAttribute('idx') === idx)) || want.map((w) => all.find((s) => tOf(s) === w)).find(Boolean);
    if (hit) out.push(hit);
  }
  return out;
}
function placeholderXfrm(sp, slide) {
  for (const s of inherited(sp, slide)) { const x = deep(s, 'a', 'xfrm')[0]; if (x) return x; }
  return null;
}
// size, bullet and alignment for a paragraph level: the slide's own, then the layout's, then the master's
function textLook(sp, slide, lvl) {
  const ph = deep(sp, 'p', 'ph')[0];
  const type = ph ? ph.getAttribute('type') || 'body' : null;
  const name = `lvl${lvl + 1}pPr`;
  const levels = [];
  const own = kid(kid(sp, 'p', 'txBody'), 'a', 'lstStyle');
  if (own) levels.push(kid(own, 'a', name));
  for (const s of inherited(sp, slide)) levels.push(kid(kid(kid(s, 'p', 'txBody'), 'a', 'lstStyle'), 'a', name));
  const tx = slide.master && deep(slide.master, 'p', 'txStyles')[0];
  const style = tx && kid(tx, 'p', !type ? 'otherStyle' : /title/i.test(type) && type !== 'subTitle' ? 'titleStyle' : 'bodyStyle');
  if (style) levels.push(kid(style, 'a', name));
  const look = { sz: null, bullet: null, algn: null };
  for (const l of levels) {
    if (!l) continue;
    if (look.sz == null) { const d = kid(l, 'a', 'defRPr'); if (d?.getAttribute('sz')) look.sz = +d.getAttribute('sz') / 100; }
    if (look.bullet == null) { if (kid(l, 'a', 'buNone')) look.bullet = false; else if (kid(l, 'a', 'buChar')) look.bullet = kid(l, 'a', 'buChar').getAttribute('char') || '•'; else if (kid(l, 'a', 'buAutoNum')) look.bullet = '•'; }
    if (look.algn == null && l.getAttribute('algn')) look.algn = l.getAttribute('algn');
  }
  return look;
}
// the theme's named colours (accent 1–6, dark and light…), with the master's text/background names mapped onto them
function themeColors(theme, master) {
  const m = {};
  const scheme = theme && deep(theme, 'a', 'clrScheme')[0];
  for (const c of scheme ? [...scheme.children] : []) {
    const v = c.firstElementChild;
    if (!v) continue;
    m[c.localName] = v.localName === 'sysClr' ? v.getAttribute('lastClr') || '000000' : v.getAttribute('val');
  }
  const map = master && deep(master, 'p', 'clrMap')[0];
  for (const k of ['bg1', 'tx1', 'bg2', 'tx2']) m[k] = m[map?.getAttribute(k) || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[k]];
  return m;
}
// a colour element (srgbClr, schemeClr…) as CSS, with the usual lighter/darker tweaks applied
let COLORS = {};
function colorOf(c) {
  if (!c) return null;
  let hex = c.localName === 'srgbClr' ? c.getAttribute('val') : c.localName === 'schemeClr' ? COLORS[c.getAttribute('val')] : c.localName === 'sysClr' ? c.getAttribute('lastClr') : c.localName === 'prstClr' ? { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000' }[c.getAttribute('val')] : null;
  if (!hex) return null;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  let alpha = 1;
  for (const t of c.children) {
    const v = +t.getAttribute('val') / 100000;
    if (t.localName === 'lumMod') [r, g, b] = [r, g, b].map((x) => x * v);
    else if (t.localName === 'lumOff') [r, g, b] = [r, g, b].map((x) => Math.min(1, x + v));
    else if (t.localName === 'tint') [r, g, b] = [r, g, b].map((x) => x + (1 - x) * (1 - v));
    else if (t.localName === 'shade') [r, g, b] = [r, g, b].map((x) => x * v);
    else if (t.localName === 'alpha') alpha = v;
  }
  const to = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return alpha < 1 ? `rgba(${to(r)},${to(g)},${to(b)},${alpha})` : `rgb(${to(r)},${to(g)},${to(b)})`;
}
const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr']);
const color = (el) => { if (!el) return null; if (COLOR_TAGS.has(el.localName)) return colorOf(el); const c = [...el.getElementsByTagNameNS(NS.a, '*')].find((x) => COLOR_TAGS.has(x.localName)); return colorOf(c); };
async function drawSlide(v, slide, box, { editable = false } = {}) {
  box.innerHTML = '';
  const W = v.W, H = v.H;
  const bg = kid(kid(slide.doc.documentElement, 'p', 'cSld'), 'p', 'bg') || kid(kid(slide.layout?.documentElement, 'p', 'cSld'), 'p', 'bg') || kid(kid(slide.master?.documentElement, 'p', 'cSld'), 'p', 'bg');
  COLORS = slide.colors || {};
  box.style.color = COLORS.tx1 ? '#' + COLORS.tx1 : '';
  const bgRef = bg && deep(bg, 'p', 'bgRef')[0];
  box.style.background = (bg && color(bg)) || (bgRef && color(bgRef)) || (COLORS.bg1 ? '#' + COLORS.bg1 : '#ffffff');
  const blip = bg && deep(bg, 'a', 'blip')[0];
  if (blip) {
    const relsOf = slide.doc && kid(kid(slide.doc.documentElement, 'p', 'cSld'), 'p', 'bg') ? slide.rels : null;
    const t = relsOf?.[blip.getAttributeNS(NS.r, 'embed')]?.target;
    if (t) box.style.background = `url("${await v.mediaUrl(t)}") center/cover`;
  }
  const place = (el, xfrm) => {
    const off = kid(xfrm, 'a', 'off'), ext = kid(xfrm, 'a', 'ext');
    if (!off || !ext) return false;
    Object.assign(el.style, { left: (100 * +off.getAttribute('x') / W) + '%', top: (100 * +off.getAttribute('y') / H) + '%', width: (100 * +ext.getAttribute('cx') / W) + '%', height: (100 * +ext.getAttribute('cy') / H) + '%' });
    const rot = +(xfrm.getAttribute('rot') || 0); if (rot) el.style.transform = `rotate(${rot / 60000}deg)`;
    return true;
  };
  const tree = kid(kid(slide.doc.documentElement, 'p', 'cSld'), 'p', 'spTree');
  const walk = async (parent) => {
    for (const n of [...(parent?.childNodes || [])]) {
      if (n.nodeType !== 1) continue;
      COLORS = slide.colors || {}; // thumbnails draw at the same time, each with its own theme
      if (n.localName === 'grpSp') { await walk(n); continue; }
      if (n.localName === 'pic') {
        const b = deep(n, 'a', 'blip')[0]; const t = slide.rels[b?.getAttributeNS(NS.r, 'embed')]?.target;
        const xf = deep(n, 'a', 'xfrm')[0];
        if (!t || !xf) continue;
        const img = h('img', { class: 'sl-pic', src: await v.mediaUrl(t), alt: '', draggable: 'false' });
        if (place(img, xf)) box.append(img);
        continue;
      }
      if (n.localName !== 'sp' && n.localName !== 'graphicFrame') continue;
      const spPr = kid(n, 'p', 'spPr');
      const xf = (spPr && kid(spPr, 'a', 'xfrm')) || kid(n, 'p', 'xfrm') || placeholderXfrm(n, slide);
      if (!xf) continue;
      const el = h('div', { class: 'sl-sp' });
      if (!place(el, xf)) continue;
      // the shape's own fill, else the theme style it points at
      const style = kid(n, 'p', 'style');
      const fill = spPr && kid(spPr, 'a', 'solidFill');
      const grad = spPr && kid(spPr, 'a', 'gradFill');
      const noFill = spPr && kid(spPr, 'a', 'noFill');
      if (fill) el.style.background = color(fill);
      else if (grad) { const stops = deep(grad, 'a', 'gs').map((g) => `${color(g)} ${+g.getAttribute('pos') / 1000}%`); if (stops.length) el.style.background = `linear-gradient(180deg, ${stops.join(', ')})`; }
      else if (!noFill && style) { const fr = kid(style, 'a', 'fillRef'); if (fr && fr.getAttribute('idx') !== '0') el.style.background = color(fr); }
      const fontRef = style && kid(style, 'a', 'fontRef');
      if (fontRef && color(fontRef)) el.style.color = color(fontRef);
      const lnRef = style && kid(style, 'a', 'lnRef');
      if (lnRef && lnRef.getAttribute('idx') !== '0' && !(spPr && kid(kid(spPr, 'a', 'ln'), 'a', 'noFill')) && n.localName === 'sp' && !deep(n, 'p', 'ph')[0]) el.style.border = `${Math.max(1, (lnRef.getAttribute('idx') || 1) * 0.75)}px solid ${color(lnRef)}`;
      const geom = spPr && kid(spPr, 'a', 'prstGeom');
      if (geom?.getAttribute('prst') === 'ellipse') el.style.borderRadius = '50%';
      if (geom?.getAttribute('prst') === 'roundRect') el.style.borderRadius = '6%';
      const ln = spPr && kid(spPr, 'a', 'ln');
      if (ln && kid(ln, 'a', 'solidFill')) el.style.border = `${Math.max(1, (+(ln.getAttribute('w') || 12700)) / EMU)}px solid ${color(kid(ln, 'a', 'solidFill'))}`;
      const ph = deep(n, 'p', 'ph')[0]?.getAttribute('type') || '';
      const fallbackSize = /title/i.test(ph) ? 40 : /subTitle/.test(ph) ? 24 : 18;
      const body = kid(n, 'p', 'txBody') || deep(n, 'a', 'txBody')[0];
      const anchor = body && kid(body, 'a', 'bodyPr')?.getAttribute('anchor');
      el.style.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : /title/i.test(ph) && !/sub/i.test(ph) ? 'center' : 'flex-start';
      // tables: each cell's words
      const paras = body ? kids(body, 'a', 'p') : deep(n, 'a', 'p');
      for (const p of paras) {
        const pPr = kid(p, 'a', 'pPr');
        const lvl = +(pPr?.getAttribute('lvl') || 0);
        const look = textLook(n, slide, lvl);
        const defSize = look.sz || fallbackSize;
        const algn = pPr?.getAttribute('algn') || look.algn;
        const line = h('div', { class: 'sl-p', style: { fontSize: `calc(var(--u) * ${defSize})` } });
        line.style.textAlign = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : 'left';
        const bullet = pPr && kid(pPr, 'a', 'buNone') ? false : (pPr && kid(pPr, 'a', 'buChar')?.getAttribute('char')) || look.bullet;
        const hasText = kids(p, 'a', 'r').some((r) => kid(r, 'a', 't')?.textContent);
        if (bullet && hasText) { line.classList.add('bullet'); line.dataset.bu = bullet; }
        if (lvl) line.style.paddingLeft = lvl * 4 + '%';
        const rs = kids(p, 'a', 'r').concat(kids(p, 'a', 'fld'));
        let size = defSize;
        for (const r of rs) {
          const rPr = kid(r, 'a', 'rPr');
          const t = kid(r, 'a', 't')?.textContent || '';
          const s = h('span', {}, t);
          if (rPr?.getAttribute('sz')) size = +rPr.getAttribute('sz') / 100;
          s.style.fontSize = `calc(var(--u) * ${(rPr?.getAttribute('sz') ? +rPr.getAttribute('sz') / 100 : defSize)})`;
          if (rPr?.getAttribute('b') === '1') s.style.fontWeight = '700';
          if (rPr?.getAttribute('i') === '1') s.style.fontStyle = 'italic';
          if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') s.style.textDecoration = 'underline';
          const c = rPr && color(kid(rPr, 'a', 'solidFill')); if (c) s.style.color = c;
          line.append(s);
        }
        if (!rs.length) line.append(h('span', { style: { fontSize: `calc(var(--u) * ${size})` } }, '​'));
        if (editable) {
          line.contentEditable = 'true';
          line.spellcheck = true;
          line.addEventListener('input', () => { p.__edited = line.innerText.replace(/\n/g, ' '); slide.edited = true; setDirty(true); });
          line.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); e.stopPropagation(); });
        }
        el.append(line);
      }
      box.append(el);
    }
  };
  await walk(tree);
}
RENDER.pptx = async (d) => {
  const v = d.view;
  document.body.classList.add('has-side');
  const side = $('of-side');
  side.innerHTML = '';
  const stage = h('div', { class: 'sl-stage' });
  const slideBox = h('div', { class: 'sl-slide' });
  stage.append(slideBox);
  $('of-doc').append(stage);
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const ratio = v.W / v.H;
    let w = r.width - 48, hh = w / ratio;
    if (hh > r.height - 48) { hh = r.height - 48; w = hh * ratio; }
    Object.assign(slideBox.style, { width: w + 'px', height: hh + 'px' });
    slideBox.style.setProperty('--u', (w / (v.W / EMU)) + 'px'); // one point on the slide, in screen pixels
  };
  new ResizeObserver(fit).observe(stage);
  const go = async (i) => {
    v.idx = Math.max(0, Math.min(v.slides.length - 1, i));
    fit();
    await drawSlide(v, v.slides[v.idx], slideBox, { editable: true });
    side.querySelectorAll('.sl-thumb').forEach((t, k) => t.classList.toggle('on', k === v.idx));
    side.querySelector('.sl-thumb.on')?.scrollIntoView({ block: 'nearest' });
    renderBar();
  };
  v.go = go;
  for (const [i, s] of v.slides.entries()) {
    const th = h('div', { class: 'sl-thumb' }, h('span', { class: 'n' }, String(i + 1)));
    const mini = h('div', { class: 'sl-mini' });
    th.append(mini);
    th.onclick = () => go(i);
    side.append(th);
    // small copies, drawn when the browser has a moment
    setTimeout(async () => { const w = 168; mini.style.setProperty('--u', (w / (v.W / EMU)) + 'px'); mini.style.height = (w * v.H / v.W) + 'px'; await drawSlide(v, s, mini); }, 30 * i);
  }
  stage.tabIndex = 0;
  stage.addEventListener('keydown', (e) => { if (['ArrowRight', 'PageDown', 'ArrowDown'].includes(e.key)) go(v.idx + 1); if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) go(v.idx - 1); });
  await go(v.idx);
};
TOOLS.pptx = (d) => [
  tb('pprev', '', () => d.view.go?.(d.view.idx - 1), { title: 'Previous slide' }),
  tb('pnext', '', () => d.view.go?.(d.view.idx + 1), { title: 'Next slide' }),
  tb('pplay', 'Slideshow', () => slideshow(d), { title: 'Slideshow from this slide (F5)' }),
  h('span', { class: 'of-hint' }, 'Click any text on the slide to change it'),
];
async function slideshow(d) {
  const v = d.view;
  const shade = h('div', { class: 'sl-show' });
  const box = h('div', { class: 'sl-slide' });
  shade.append(box);
  document.body.append(shade);
  try { await shade.requestFullscreen(); } catch {}
  let i = v.idx;
  const fit = () => { const ratio = v.W / v.H; let w = innerWidth, hh = w / ratio; if (hh > innerHeight) { hh = innerHeight; w = hh * ratio; } Object.assign(box.style, { width: w + 'px', height: hh + 'px' }); box.style.setProperty('--u', (w / (v.W / EMU)) + 'px'); };
  const draw = async () => { fit(); await drawSlide(v, v.slides[i], box); };
  const key = (e) => {
    if (['ArrowRight', 'PageDown', ' ', 'Enter', 'ArrowDown'].includes(e.key)) { e.preventDefault(); if (i < v.slides.length - 1) { i++; draw(); } else end(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp', 'Backspace'].includes(e.key)) { e.preventDefault(); if (i > 0) { i--; draw(); } }
    else if (e.key === 'Escape') end();
  };
  const end = () => { window.removeEventListener('keydown', key, true); window.removeEventListener('resize', draw); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); shade.remove(); v.go?.(i); };
  shade.addEventListener('click', () => { if (i < v.slides.length - 1) { i++; draw(); } else end(); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && shade.isConnected) end(); }, { once: true });
  window.addEventListener('keydown', key, true);
  window.addEventListener('resize', draw);
  await draw();
}
SAVE.pptx = async (d) => {
  const v = d.view;
  for (const s of v.slides) {
    if (!s.edited) continue;
    for (const p of deep(s.doc, 'a', 'p')) {
      if (p.__edited == null) continue;
      const runs = kids(p, 'a', 'r');
      if (runs.length) {
        kid(runs[0], 'a', 't').textContent = p.__edited;
        runs.slice(1).forEach((r) => r.remove());
      } else if (p.__edited) {
        const r = s.doc.createElementNS(NS.a, 'a:r'); const t = s.doc.createElementNS(NS.a, 'a:t'); t.textContent = p.__edited; r.append(t);
        const end = kid(p, 'a', 'endParaRPr'); p.insertBefore(r, end);
      }
    }
    v.zip.file(s.path, new XMLSerializer().serializeToString(s.doc));
  }
  return v.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
};

// ---------------------------------------------------------------------------------------------------------------
// PDF
LOADERS.pdf = async (bytes) => {
  const pj = await pdfLib();
  const original = bytes.slice();
  const pdf = await pj.getDocument({ data: bytes, isEvalSupported: false }).promise; // no code from inside a PDF, ever
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) pages.push({ n: i, rot: 0, marks: [] });
  const v = { pdf, original, pages, zoom: 'fit', tool: null, lossy: null };
  v.status = () => `${pages.length} page${pages.length > 1 ? 's' : ''}`;
  return v;
};
RENDER.pdf = async (d) => {
  const v = d.view, pj = await pdfLib();
  document.body.classList.add('has-side');
  const side = $('of-side');
  const scroll = h('div', { class: 'pdf-scroll' });
  $('of-doc').append(scroll);
  const width = () => Math.min(1100, scroll.clientWidth - 60);
  const draw = async () => {
    scroll.innerHTML = ''; side.innerHTML = '';
    for (const [k, pg] of v.pages.entries()) {
      const page = await v.pdf.getPage(pg.n);
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + pg.rot) % 360 });
      const scale = v.zoom === 'fit' ? width() / base.width : v.zoom;
      const vp = page.getViewport({ scale, rotation: (page.rotate + pg.rot) % 360 });
      const wrap = h('div', { class: 'pdf-page', style: { width: vp.width + 'px', height: vp.height + 'px' } });
      const canvas = h('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      const text = h('div', { class: 'textLayer' });
      text.style.setProperty('--scale-factor', String(scale));
      const marks = h('div', { class: 'pdf-marks' });
      wrap.append(canvas, text, marks);
      scroll.append(wrap);
      // drawn when it comes near the screen
      const render = async () => {
        if (wrap.__drawn) return; wrap.__drawn = true;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise.catch(() => {});
        try { await new pj.TextLayer({ textContentSource: await page.getTextContent(), container: text, viewport: vp }).render(); } catch {}
      };
      new IntersectionObserver((es, ob) => { if (es.some((e) => e.isIntersecting)) { ob.disconnect(); render(); } }, { root: scroll, rootMargin: '600px' }).observe(wrap);
      drawMarks(v, pg, marks, vp);
      wireMarks(v, pg, wrap, marks, vp);
      // page list
      const th = h('div', { class: 'pdf-thumb' }, h('span', { class: 'n' }, String(k + 1)),
        h('div', { class: 'pdf-pacts' },
          h('button', { class: 'icon-btn small', title: 'Rotate', html: icon('refresh'), onclick: (e) => { e.stopPropagation(); pg.rot = (pg.rot + 90) % 360; setDirty(true); draw(); } }),
          h('button', { class: 'icon-btn small', title: 'Move up', html: icon('up'), disabled: k === 0, onclick: (e) => { e.stopPropagation(); v.pages.splice(k - 1, 0, v.pages.splice(k, 1)[0]); setDirty(true); draw(); } }),
          h('button', { class: 'icon-btn small', title: 'Delete page', html: icon('trash'), disabled: v.pages.length < 2, onclick: (e) => { e.stopPropagation(); v.pages.splice(k, 1); setDirty(true); draw(); } })));
      th.onclick = () => wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      side.append(th);
    }
    renderBar();
  };
  v.redraw = draw;
  new ResizeObserver(debounce(() => { if (v.zoom === 'fit') draw(); }, 200)).observe(scroll);
  await draw();
};
// marks added here (text, highlights, drawings), in PDF points from the page's top-left
function drawMarks(v, pg, layer, vp) {
  layer.innerHTML = '';
  const s = vp.scale;
  for (const m of pg.marks) {
    if (m.type === 'text') layer.append(h('div', { class: 'pm-text', style: { left: m.x * s + 'px', top: m.y * s + 'px', fontSize: m.size * s + 'px', color: m.color } }, m.text));
    if (m.type === 'hl') layer.append(h('div', { class: 'pm-hl', style: { left: m.x * s + 'px', top: m.y * s + 'px', width: m.w * s + 'px', height: m.h * s + 'px' } }));
    if (m.type === 'pen') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pm-pen'); svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', m.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0] * s} ${p[1] * s}`).join(' '));
      path.setAttribute('stroke', m.color); path.setAttribute('stroke-width', m.width * s); path.setAttribute('fill', 'none'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
      svg.append(path); layer.append(svg);
    }
  }
}
function wireMarks(v, pg, wrap, layer, vp) {
  const s = vp.scale;
  const at = (e) => { const r = wrap.getBoundingClientRect(); return [(e.clientX - r.left) / s, (e.clientY - r.top) / s]; };
  wrap.addEventListener('mousedown', async (e) => {
    if (!v.tool || e.button !== 0 || pg.rot) { if (v.tool && pg.rot) toast('Marks go on pages that aren’t rotated'); return; }
    e.preventDefault();
    const [x, y] = at(e);
    if (v.tool === 'text') {
      const { prompt } = await import('./dialogs.js');
      const t = await prompt('Add text', '', { label: 'Text' });
      if (t) { pg.marks.push({ type: 'text', x, y, text: t, size: 14, color: '#111111' }); setDirty(true); drawMarks(v, pg, layer, vp); }
      return;
    }
    const m = v.tool === 'hl' ? { type: 'hl', x, y, w: 0, h: 0 } : { type: 'pen', pts: [[x, y]], color: '#e5322d', width: 2.2 };
    pg.marks.push(m);
    const move = (ev) => { const [x2, y2] = at(ev); if (m.type === 'hl') { m.w = x2 - x; m.h = y2 - y; } else m.pts.push([x2, y2]); drawMarks(v, pg, layer, vp); };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (m.type === 'hl') { if (m.w < 0) { m.x += m.w; m.w = -m.w; } if (m.h < 0) { m.y += m.h; m.h = -m.h; } if (m.w < 3 || m.h < 3) pg.marks.pop(); }
      setDirty(true); drawMarks(v, pg, layer, vp);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}
TOOLS.pdf = (d) => {
  const v = d.view;
  const tool = (id, label, ic, title) => tb(ic, label, () => pdfTool(v, id), { on: v.tool === id, title });
  return [
    tb('zoomOut', '', () => pdfZoom(v, -1), { title: 'Zoom out' }),
    tb('', 'Fit', () => pdfZoom(v, 0), { on: v.zoom === 'fit', title: 'Fit the width' }),
    tb('zoomIn', '', () => pdfZoom(v, 1), { title: 'Zoom in' }),
    sep(),
    tool('text', 'Text', 'rename', 'Click on a page to add text'),
    tool('hl', 'Highlight', 'marker', 'Drag over a page to highlight'),
    tool('pen', 'Draw', 'pen', 'Draw on a page'),
    tb('undo', '', () => pdfUndo(v), { title: 'Take back the last mark' }),
  ];
};
function pdfZoom(v, dir) { v.zoom = dir === 0 ? 'fit' : Math.max(0.3, Math.min(4, (v.zoom === 'fit' ? 1 : v.zoom) + 0.2 * dir)); v.redraw(); }
function pdfTool(v, id) { v.tool = v.tool === id ? null : id; document.body.classList.toggle('pdf-marking', !!v.tool); renderBar(); }
function pdfUndo(v) { for (let k = v.pages.length - 1; k >= 0; k--) if (v.pages[k].marks.length) { v.pages[k].marks.pop(); setDirty(true); v.redraw(); return; } }
SAVE.pdf = async (d) => {
  const v = d.view;
  const { PDFLib } = await office();
  const src = await PDFLib.PDFDocument.load(v.original, { ignoreEncryption: true });
  const out = await PDFLib.PDFDocument.create();
  const copied = await out.copyPages(src, v.pages.map((p) => p.n - 1));
  const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  copied.forEach((page, k) => {
    const pg = v.pages[k];
    out.addPage(page);
    const { height } = page.getSize();
    for (const m of pg.marks) {
      if (m.type === 'text') page.drawText(m.text, { x: m.x, y: height - m.y - m.size, size: m.size, font, color: rgb(m.color) });
      if (m.type === 'hl') page.drawRectangle({ x: m.x, y: height - m.y - m.h, width: m.w, height: m.h, color: PDFLib.rgb(1, 0.92, 0.2), opacity: 0.38 });
      if (m.type === 'pen') for (let i = 1; i < m.pts.length; i++) page.drawLine({ start: { x: m.pts[i - 1][0], y: height - m.pts[i - 1][1] }, end: { x: m.pts[i][0], y: height - m.pts[i][1] }, thickness: m.width, color: rgb(m.color) });
    }
    if (pg.rot) page.setRotation(PDFLib.degrees((page.getRotation().angle + pg.rot) % 360));
  });
  return out.save();
};
// once saved over the original, what's on disk is the new starting point
AFTER.pdf = async (d, bytes) => {
  const v = d.view;
  v.original = bytes.slice(); v.pdf = await (await pdfLib()).getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  v.pages = v.pages.map((p, k) => ({ n: k + 1, rot: 0, marks: [] }));
  if (cur === d) v.redraw?.();
};

// ---------------------------------------------------------------------------------------------------------------
// OneNote: the words in the page (its format isn't fully published, so this is reading only)
LOADERS.one = async (bytes) => {
  const found = [];
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if ((c >= 32 && c < 0xd800 && c !== 0xfffd) || c === 9) s += String.fromCharCode(c);
    else { if (s.trim().length >= 3 && /[\p{L}]{2}/u.test(s)) found.push(s.trim()); s = ''; }
  }
  const seen = new Set();
  const lines = found.filter((x) => !/^[\x21-\x7e]{1,6}$/.test(x) && !/^\{[0-9A-F-]+\}$/i.test(x) && !/\.(png|jpg|emf|wmf)$/i.test(x) && !seen.has(x) && seen.add(x));
  return { lines, readonly: true, status: () => `${lines.length} pieces of text found` };
};
RENDER.one = (d) => {
  const box = h('div', { class: 'doc-scroll' }, h('div', { class: 'doc-page one' },
    h('div', { class: 'one-note' }, 'OneNote pages keep their content in a format Microsoft hasn’t fully published, so this shows the text found in the page, for reading and copying.', h('button', { class: 'btn small', onclick: () => api('shell:open', d.path) }, 'Open in OneNote')),
    ...(d.view.lines.length ? d.view.lines.map((l) => h('p', {}, l)) : [h('p', { class: 'muted' }, 'No text was found in this page.')])));
  $('of-doc').append(box);
};

// older formats Dogfile can't edit
LOADERS.legacy = async () => ({ readonly: true, status: () => 'older format' });
RENDER.legacy = (d) => { $('of-doc').append(h('div', { class: 'of-err' }, h('div', { class: 'err-title' }, `${d.name} is in an older Office format`), h('div', { class: 'err-msg' }, 'Dogfile Office opens .docx, .xlsx (and .xls), .pptx and PDF files. Open this one in its own program, or save it there in the newer format.'), h('button', { class: 'btn', onclick: () => api('shell:open', d.path) }, 'Open with the Windows default app'))); };
LOADERS.other = LOADERS.legacy; RENDER.other = RENDER.legacy;

// ---------------------------------------------------------------------------------------------------------------
// keys, leaving, start
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); if (cur) print(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog(); }
  else if (e.key === 'F5' && cur?.kind === 'pptx') { e.preventDefault(); slideshow(cur); }
});
async function openDialog() {
  const files = await api('dialog:openFiles', { title: 'Open a document', filters: [{ name: 'Documents', extensions: ['docx', 'xlsx', 'xls', 'xlsm', 'ods', 'pptx', 'pdf', 'one'] }] });
  if (files?.length) openPaths(files);
}
const confirmLeave = async (asking) => {
  const dirty = docs.filter((d) => d.dirty);
  if (!dirty.length) return true;
  asking?.();
  for (const d of dirty) if (!(await askSave(d))) return false;
  return true;
};
onLeave(confirmLeave);
onWindowClose(confirmLeave);

async function boot() {
  sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  const st = await api('store:get', 'settings');
  settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  applyColors(settings);
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  $('of-open').onclick = openDialog;
  showEmpty();
  const pending = await pendingFiles();
  if (pending?.files?.length) await openPaths(pending.files);
  sendState();
  document.body.classList.add('ready');
}
onMain('office:open', ({ files }) => openPaths(files || []));
onMain('settings:changed', (s) => { settings = { ...settings, ...s }; applyColors(settings); });
// what the ribbon's buttons ask for when Dogfile Office is a tab
const CMD = {
  save: () => save(false), saveCopy: () => save(true), print: () => cur && print(), summarize: () => summarize(), open: () => openDialog(),
  showFolder: () => cur && showInFiles(cur.path), openDefault: () => cur && api('shell:open', cur.path), close: () => cur && closeDoc(cur),
  bold: () => exec('bold'), italic: () => exec('italic'), underline: () => exec('underline'), strike: () => exec('strikeThrough'),
  title: () => exec('formatBlock', 'h1'), heading: () => exec('formatBlock', 'h2'), subheading: () => exec('formatBlock', 'h3'), text: () => exec('formatBlock', 'p'),
  bullets: () => exec('insertUnorderedList'), numbers: () => exec('insertOrderedList'), indent: () => exec('indent'), outdent: () => exec('outdent'),
  left: () => exec('justifyLeft'), center: () => exec('justifyCenter'), right: () => exec('justifyRight'), justify: () => exec('justifyFull'),
  undo: () => (cur?.kind === 'pdf' ? pdfUndo(cur.view) : exec('undo')), redo: () => exec('redo'),
  prevSlide: () => cur?.view?.go?.(cur.view.idx - 1), nextSlide: () => cur?.view?.go?.(cur.view.idx + 1), slideshow: () => cur?.kind === 'pptx' && slideshow(cur),
  zoomIn: () => cur?.kind === 'pdf' && pdfZoom(cur.view, 1), zoomOut: () => cur?.kind === 'pdf' && pdfZoom(cur.view, -1), fit: () => cur?.kind === 'pdf' && pdfZoom(cur.view, 0),
  markText: () => cur?.kind === 'pdf' && pdfTool(cur.view, 'text'), markHl: () => cur?.kind === 'pdf' && pdfTool(cur.view, 'hl'), markPen: () => cur?.kind === 'pdf' && pdfTool(cur.view, 'pen'),
  sheet: (name) => { const v = cur?.view; if (cur?.kind === 'xlsx' && v.wb.Sheets[name]) { v.sheet = name; v.sel = { r: 0, c: 0 }; $('of-doc').innerHTML = ''; RENDER.xlsx(cur); renderBar(); } },
};
onHost({ open: (m) => openPaths(m.files || []), cmd: (id, arg) => CMD[id]?.(arg), settings: (s) => { settings = { ...settings, ...s }; applyColors(settings); } });
window.__office = { docs, get cur() { return cur; }, openPaths, save, show };
boot().catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#f66">${esc(e.stack || e.message)}</pre>`; });
