// Text and structure from documents, without Office installed: Word/Writer, Excel/Calc, PowerPoint/Impress
// (they are zip files of XML, read with the bundled 7-Zip), PDF (text operators + document title), plain text,
// Markdown, HTML, RTF. Used by previews, the AI assistant ("rename using contents", "PDFs about taxes") and search.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const ops = require('./ops');

function unzipEntry(file, entry, max = 30 * 1048576) {
  return new Promise((resolve) => {
    const z = ops.find7z();
    if (!z) return resolve(null);
    const p = spawn(z, ['e', '-so', '-y', file, entry], { windowsHide: true });
    const chunks = []; let n = 0;
    p.stdout.on('data', (d) => { n += d.length; if (n <= max) chunks.push(d); else p.kill(); });
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}
function listZip(file) {
  return new Promise((resolve) => {
    const z = ops.find7z();
    if (!z) return resolve([]);
    const p = spawn(z, ['l', '-slt', '-ba', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve([]));
    p.on('close', () => resolve(out.split(/\r?\n/).filter((l) => l.startsWith('Path = ')).map((l) => l.slice(7).replace(/\\/g, '/'))));
  });
}
const ents = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// ---------- Word / Writer ----------
function docxBlocks(xml) {
  const blocks = [];
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (t) => { // keep tables as tab separated rows
    const rows = [...t.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) => ents([...c[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(''))));
    return `<w:p><w:pPr><w:pStyle w:val="AtlasTable"/></w:pPr><w:r><w:t>${rows.map((r) => r.join('\t')).join('\n').replace(/[<&]/g, ' ')}</w:t></w:r></w:p>`;
  });
  for (const m of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || '';
    const text = ents([...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((x) => (x[0].startsWith('<w:tab') ? '\t' : x[0].startsWith('<w:br') ? '\n' : x[1])).join(''));
    const list = /<w:numPr>/.test(p);
    const bold = /<w:b\/>|<w:b w:val="(1|true)"/.test(p);
    let kind = 'p';
    if (/^(Title)$/i.test(style)) kind = 'h1';
    else if (/heading\s?1|Heading1|berschrift1/i.test(style)) kind = 'h1';
    else if (/heading\s?2|Heading2/i.test(style)) kind = 'h2';
    else if (/heading\s?[3-6]|Heading[3-6]|Subtitle/i.test(style)) kind = 'h3';
    else if (style === 'AtlasTable') kind = 'table';
    else if (list) kind = 'li';
    if (text.trim() || kind === 'p') blocks.push({ kind, text, bold });
  }
  return blocks;
}
function odtBlocks(xml) {
  const blocks = [];
  for (const m of xml.matchAll(/<text:(h|p)([^>]*)>([\s\S]*?)<\/text:\1>/g)) {
    const text = ents(m[3].replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s(?: text:c="(\d+)")?\/>/g, (x, n) => ' '.repeat(+n || 1)).replace(/<[^>]+>/g, ''));
    const lvl = +((/text:outline-level="(\d)"/.exec(m[2]) || [])[1] || 0);
    blocks.push({ kind: m[1] === 'h' ? (lvl <= 1 ? 'h1' : lvl === 2 ? 'h2' : 'h3') : 'p', text });
  }
  return blocks;
}
// ---------- Excel / Calc ----------
async function xlsxSheets(file, maxRows = 200) {
  const names = await listZip(file);
  const ss = await unzipEntry(file, 'xl/sharedStrings.xml');
  const shared = ss ? [...ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => ents([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''))) : [];
  const wb = (await unzipEntry(file, 'xl/workbook.xml'))?.toString('utf8') || '';
  const titles = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => ents(m[1]));
  const sheets = [];
  const files = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  for (let i = 0; i < files.length && i < 12; i++) {
    const x = (await unzipEntry(file, files[i]))?.toString('utf8') || '';
    const rows = [];
    for (const r of x.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) break;
      const cells = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = c[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const t = (/t="(\w+)"/.exec(c[2]) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(c[3] || '') || [])[1];
        const is = (/<is>([\s\S]*?)<\/is>/.exec(c[3] || '') || [])[1];
        let val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? ents((is || '').replace(/<[^>]+>/g, '')) : v != null ? ents(v) : '';
        while (cells.length < col) cells.push('');
        cells[col] = val;
      }
      rows.push(cells.slice(0, 40));
    }
    sheets.push({ name: titles[i] || `Sheet ${i + 1}`, rows });
  }
  return sheets;
}
function odsSheets(xml, maxRows = 200) {
  const sheets = [];
  for (const t of xml.matchAll(/<table:table table:name="([^"]*)"[\s\S]*?<\/table:table>/g)) {
    const rows = [];
    for (const r of t[0].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      if (rows.length >= maxRows) break;
      const cells = [];
      for (const c of r[1].matchAll(/<table:table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
        const rep = Math.min(40, +((/table:number-columns-repeated="(\d+)"/.exec(c[1]) || [])[1] || 1));
        const v = ents((c[2] || '').replace(/<\/text:p>/g, '\n').replace(/<[^>]+>/g, '').trim());
        for (let k = 0; k < rep && cells.length < 40; k++) cells.push(v);
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      rows.push(cells);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    sheets.push({ name: ents(t[1]), rows });
  }
  return sheets;
}
// ---------- PowerPoint / Impress ----------
async function pptxSlides(file) {
  const names = (await listZip(file)).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const slides = [];
  for (const n of names.slice(0, 80)) {
    const x = (await unzipEntry(file, n))?.toString('utf8') || '';
    const paras = [...x.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => ents([...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''))).filter((t) => t.trim());
    const title = (() => { const sp = [...x.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].find((s) => /type="(ctr)?[Tt]itle"/.test(s[1])); return sp ? ents([...sp[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(' ')) : ''; })();
    slides.push({ title: title || paras[0] || '', lines: title ? paras.filter((p) => p !== title) : paras.slice(1) });
  }
  return slides;
}
function odpSlides(xml) {
  return [...xml.matchAll(/<draw:page[^>]*>([\s\S]*?)<\/draw:page>/g)].map((p) => {
    const paras = [...p[1].matchAll(/<text:(?:p|h|span)[^>]*>([\s\S]*?)<\/text:(?:p|h|span)>/g)].map((x) => ents(x[1].replace(/<[^>]+>/g, ''))).filter((t) => t.trim());
    return { title: paras[0] || '', lines: paras.slice(1) };
  });
}
// ---------- PDF ----------
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const str = (k) => { const m = new RegExp(`/${k}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(s); if (m) return pdfString(m[1]); const hx = new RegExp(`/${k}\\s*<([0-9A-Fa-f]+)>`).exec(s); if (hx) return hexString(hx[1]); return ''; };
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { title: str('Title'), author: str('Author'), subject: str('Subject'), keywords: str('Keywords'), creator: str('Creator'), producer: str('Producer'), pages };
}
function hexString(h) {
  const b = Buffer.from(h.length % 2 ? h + '0' : h, 'hex');
  if (b[0] === 0xfe && b[1] === 0xff) { let o = ''; for (let i = 2; i + 1 < b.length; i += 2) o += String.fromCharCode((b[i] << 8) | b[i + 1]); return o; }
  return b.toString('latin1');
}
function pdfString(raw) {
  let s = raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) { let o = ''; for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)); return o; }
  return s;
}
function a85(str) {
  str = str.replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '');
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = str.slice(i, i + 5); i += 5;
    const pad = 5 - chunk.length;
    let v = 0;
    for (const ch of (chunk + 'uuuu').slice(0, 5)) { const c = ch.charCodeAt(0) - 33; if (c < 0 || c > 84) return null; v = v * 85 + c; }
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}
function pdfText(buf, maxChars) {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  let streams = 0;
  while ((m = re.exec(s)) && out.length < maxChars && streams < 400) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const dict = s.slice(Math.max(0, m.index - 300), m.index);
    re.lastIndex = end + 9;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject[^>]*\/Subtype\s*\/Image|\/FontFile/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/ASCII85Decode|\/A85/.test(dict)) { data = a85(data.toString('latin1')); if (!data) continue; }
    if (/\/FlateDecode|\/Fl\b/.test(dict)) { try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data.subarray(2)); } catch { continue; } } }
    else if (/\/Filter/.test(dict) && !/\/ASCII85Decode|\/A85/.test(dict)) continue;
    streams++;
    const t = data.toString('latin1');
    if (!/T[Jj]/.test(t)) continue;
    // text-showing operators: (..) Tj, [(..) n (..)] TJ, ' and "; T* / Td moves become spaces or new lines
    for (const op of t.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f]+)>\s*Tj|(T\*|Td|TD|Tm|ET)/g)) {
      if (op[4]) { out += op[4] === 'Td' || op[4] === 'TD' ? ' ' : '\n'; continue; }
      if (op[3]) { out += hexString(op[3]).replace(/[\x00-\x08]/g, ''); continue; }
      if (op[2] != null) { out += pdfString(op[2]); continue; }
      for (const p of op[1].matchAll(/\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g)) { if (p[1] != null) out += pdfString(p[1]); else if (+p[2] < -200) out += ' '; }
    }
    out += '\n';
  }
  // keep it readable: printable characters, collapsed spaces
  return out.replace(/[^\x09\x0a\x20-\x7e -￿]/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, maxChars);
}
const stripHtml = (s) => ents(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
const stripRtf = (s) => s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/g, '').replace(/\n{3,}/g, '\n\n').trim();

// structured document for previews
async function read(file, { maxChars = 200000 } = {}) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const st = await fs.promises.stat(file);
  if (['docx', 'docm', 'dotx'].includes(ext)) {
    const x = (await unzipEntry(file, 'word/document.xml'))?.toString('utf8');
    if (!x) throw new Error('Can’t read this document');
    const core = (await unzipEntry(file, 'docProps/core.xml'))?.toString('utf8') || '';
    const tag = (t) => ents((new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(core) || [])[1] || '');
    return { type: 'doc', blocks: docxBlocks(x), props: { title: tag('dc:title'), subject: tag('dc:subject'), author: tag('dc:creator'), keywords: tag('cp:keywords'), description: tag('dc:description') } };
  }
  if (['odt', 'ott'].includes(ext)) { const x = (await unzipEntry(file, 'content.xml'))?.toString('utf8'); if (!x) throw new Error('Can’t read this document'); return { type: 'doc', blocks: odtBlocks(x) }; }
  if (['xlsx', 'xlsm', 'xltx'].includes(ext)) return { type: 'sheet', sheets: await xlsxSheets(file) };
  if (ext === 'ods') { const x = (await unzipEntry(file, 'content.xml'))?.toString('utf8'); return { type: 'sheet', sheets: x ? odsSheets(x) : [] }; }
  if (['pptx', 'pptm', 'potx'].includes(ext)) return { type: 'slides', slides: await pptxSlides(file) };
  if (ext === 'odp') { const x = (await unzipEntry(file, 'content.xml'))?.toString('utf8'); return { type: 'slides', slides: x ? odpSlides(x) : [] }; }
  if (ext === 'pdf') {
    const buf = await fs.promises.readFile(file);
    return { type: 'text', text: pdfText(buf.length > 60 * 1048576 ? buf.subarray(0, 60 * 1048576) : buf, maxChars), props: pdfInfo(buf.subarray(0, Math.min(buf.length, 4 * 1048576))) };
  }
  if (['html', 'htm', 'xhtml'].includes(ext)) return { type: 'text', text: stripHtml((await fs.promises.readFile(file, 'utf8')).slice(0, maxChars * 3)).slice(0, maxChars) };
  if (ext === 'rtf') return { type: 'text', text: stripRtf((await fs.promises.readFile(file, 'latin1')).slice(0, maxChars * 3)).slice(0, maxChars) };
  if (st.size > 50 * 1048576) throw new Error('Too large');
  const fd = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(Math.min(st.size, maxChars * 2)); await fd.read(b, 0, b.length, 0);
    if (b.includes(0) && !(b[0] === 0xff && b[1] === 0xfe)) throw new Error('Not a text file');
    return { type: 'text', text: (b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')).slice(0, maxChars) };
  } finally { await fd.close(); }
}
// plain text of anything above
async function text(file, maxChars = 20000) {
  const d = await read(file, { maxChars });
  if (d.type === 'doc') return d.blocks.map((b) => b.text).join('\n').slice(0, maxChars);
  if (d.type === 'sheet') return d.sheets.map((s) => `${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`).join('\n\n').slice(0, maxChars);
  if (d.type === 'slides') return d.slides.map((s) => [s.title, ...s.lines].join('\n')).join('\n\n').slice(0, maxChars);
  return (d.props?.title ? d.props.title + '\n' : '') + (d.text || '');
}
// a good title for a file, from its contents
async function title(file) {
  try {
    const d = await read(file, { maxChars: 6000 });
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const ok = (s) => s && s.length >= 3 && s.length <= 120 && !/^(untitled|microsoft word|document\d*|slide \d+|page \d+|draft)$/i.test(s) && /[a-z]/i.test(s);
    if (ok(clean(d.props?.title))) return clean(d.props.title);
    if (d.type === 'doc') { const h = d.blocks.find((b) => ['h1', 'h2'].includes(b.kind) && ok(clean(b.text))) || d.blocks.find((b) => b.bold && ok(clean(b.text))) || d.blocks.find((b) => ok(clean(b.text))); return h ? clean(h.text) : ''; }
    if (d.type === 'slides') { const s = d.slides.find((x) => ok(clean(x.title))); return s ? clean(s.title) : ''; }
    if (d.type === 'sheet') { const s = d.sheets[0]; if (s && ok(clean(s.name)) && !/^(sheet|tabelle|feuil|hoja|foglio)\s?\d+$/i.test(s.name)) return clean(s.name); const c = s?.rows.flat().find((v) => ok(clean(v)) && !/^[\d.,\-/: ]+$/.test(v)); return clean(c || s?.name || ''); }
    const lines = (d.text || '').split(/\r?\n/).map((l) => clean(l.replace(/^#+\s*|^[=*\-_]{3,}$/g, '')));
    return lines.find((l) => ok(l) && l.split(' ').length <= 16) || '';
  } catch { return ''; }
}
// write title / subject / author / keywords into an Office document (docProps/core.xml)
async function setProps(file, props) {
  const z = ops.find7z();
  if (!z) throw new Error('7-Zip is needed to edit document properties');
  const os = require('os');
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-props-'));
  try {
    let core = (await unzipEntry(file, 'docProps/core.xml'))?.toString('utf8');
    if (!core) throw new Error('This document has no properties part');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const set = (tag, val) => {
      if (val == null) return;
      const re = new RegExp(`<${tag}([^>]*)>[^<]*</${tag}>|<${tag}\\s*/>`);
      if (re.test(core)) core = core.replace(re, `<${tag}>${esc(val)}</${tag}>`);
      else core = core.replace(/<\/cp:coreProperties>/, `<${tag}>${esc(val)}</${tag}></cp:coreProperties>`);
    };
    set('dc:title', props.title); set('dc:subject', props.subject); set('dc:creator', props.author); set('cp:keywords', props.keywords); set('dc:description', props.description);
    await fs.promises.mkdir(path.join(tmp, 'docProps'), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, 'docProps', 'core.xml'), core);
    await new Promise((resolve, reject) => { const p = spawn(z, ['u', '-tzip', '-y', file, 'docProps/core.xml'], { cwd: tmp, windowsHide: true }); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Couldn’t save the properties')))); p.on('error', reject); });
    return true;
  } finally { fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
module.exports = { read, text, title, setProps };
