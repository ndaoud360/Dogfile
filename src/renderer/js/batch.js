// Batch tools: one window for doing the same thing to many files at once. Pictures (resize, convert, compress, strip camera
// details, watermark), dates and attributes, pack into / flatten folders, zip each / extract each, text out of documents,
// find & replace inside text files, copy paths in several forms, checksum files, tags and notes, and stems for a whole album.
// Everything that changes files says what it will do first, writes new files with a free name (never over something), and
// can be undone, except find & replace, which keeps the old text for an Undo button until the window closes.
import { api, state, bus, h, esc, toast, basename, dirname, stem, pjoin, fileUrl, fmtSize, IS_WIN, errText, KINDS, isImageFile, setTags, tagsOf, saveTags, samePath } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { requirePro } from './license.js';
import { activeTab, selectedItems, otherPaneTab } from './pane.js';
import * as A from './actions.js';
import { clientJob } from './tools.js';
import { getWatermark, watermarkImage, drawWatermark, watermarkDialog } from './watermark.js';
import { kindFolder, groupBy, groupByName } from './organize.js';

const real = (items) => items.filter((i) => !i.virtual && !i.archive && !i.recycle && !i.share && !i.mtp);
const sel = () => real(selectedItems(activeTab()));
const here = () => { const t = activeTab(); return t && t.path && !t.path.startsWith('atlas:') ? t.path : ''; };
const refresh = () => bus.emit('refreshPanes');
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const gate = () => requirePro('batch');
const field = (label, ...els) => h('div', { class: 'stack tight' }, h('div', { class: 'field-label' }, label), ...els);
const radio = (name, value, label, checked) => { const i = h('input', { type: 'radio', name, value }); i.checked = !!checked; return { i, el: h('label', { class: 'check block' }, i, ' ' + label) }; };
const checkbox = (label, on) => { const i = h('input', { type: 'checkbox' }); i.checked = !!on; return { i, el: h('label', { class: 'check block' }, i, ' ' + label) }; };
const numInput = (v, min, max, w = 90) => h('input', { class: 'input', type: 'number', value: String(v), min: String(min), max: String(max), style: { width: w + 'px' } });
const cancelBtn = { label: 'Cancel', value: null };

/** run `fn(item, index)` over a list with progress in the Operations list; stops when cancelled. Returns { ok, failed:[{name,error}] } */
async function eachWithProgress(title, list, fn, nameOf = (x) => basename(x.path || x)) {
  const job = clientJob(title);
  job.update({ total: list.length, filesTotal: list.length, done: 0, filesDone: 0 });
  const failed = []; let ok = 0;
  for (let i = 0; i < list.length; i++) {
    if (job.cancelled) break;
    job.update({ current: nameOf(list[i]), done: i, filesDone: i });
    try { await fn(list[i], i); ok++; } catch (e) { failed.push({ name: nameOf(list[i]), error: errText(e) }); }
    if (i % 5 === 4) await sleep0();
  }
  job.update({ done: list.length, filesDone: list.length });
  job.finish(failed.length && !ok ? 'error' : 'done', failed[0]?.error);
  return { ok, failed, cancelled: job.cancelled };
}
function report(verb, r, extra = {}) {
  if (r.cancelled) return toast(`Stopped after ${plural(r.ok, 'item')}`, extra);
  if (r.failed.length) {
    const first = r.failed[0];
    return toast(`${verb} ${r.ok} of ${r.ok + r.failed.length}. “${first.name}”: ${first.error}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ''}`, { error: !r.ok });
  }
  toast(`${verb} ${plural(r.ok, 'item')}`, { ok: true, ...extra });
}

// ======================================================================
// Pictures: resize, convert, compress, strip, watermark
// ======================================================================
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** a picture decoded to a bitmap, with the camera's rotation applied */
async function loadBitmap(path) {
  const r = await fetch(fileUrl(path));
  if (!r.ok) throw new Error('could not be read');
  const blob = await r.blob();
  try { return await createBitmapImage(blob); } catch { throw new Error('this kind of picture can’t be opened here'); }
}
const createBitmapImage = (blob) => createImageBitmap(blob, { imageOrientation: 'from-image' });

/** the new size of a W×H picture */
export function targetSize(W, H, mode, value) {
  if (mode === 'long') { const s = Math.min(1, value / Math.max(W, H)); return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))]; }
  if (mode === 'width') { const s = Math.min(1, value / W); return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))]; }
  if (mode === 'percent') { const s = Math.max(0.01, value / 100); return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))]; }
  return [W, H];
}

export async function batchPictures(given = sel(), start = {}) {
  if (!gate()) return;
  const pics = real(given).filter((i) => isImageFile(i) && !['psd', 'psb', 'svg'].includes(i.ext));
  if (!pics.length) return toast('Select some pictures first');
  const wm0 = getWatermark();
  const doResize = checkbox('Make smaller', start.resize), doConvert = checkbox('Change the type', start.convert), doWm = checkbox('Put my watermark on them', start.watermark), doStrip = checkbox('Remove camera and location details', start.strip !== false);
  const mode = h('select', { class: 'input small' }, h('option', { value: 'long' }, 'Longest side no more than'), h('option', { value: 'width' }, 'Width no more than'), h('option', { value: 'percent' }, 'Percent of the size'));
  const px = numInput(1920, 1, 20000, 90);
  const unit = h('span', { class: 'hint' }, 'pixels');
  mode.onchange = () => { unit.textContent = mode.value === 'percent' ? '%' : 'pixels'; px.value = mode.value === 'percent' ? 50 : 1920; };
  const fmt = h('select', { class: 'input small' }, h('option', { value: 'keep' }, 'Keep each picture’s own type'), h('option', { value: 'image/jpeg' }, 'JPG'), h('option', { value: 'image/png' }, 'PNG'), h('option', { value: 'image/webp' }, 'WebP'));
  const q = h('input', { type: 'range', min: '30', max: '100', value: '82' });
  const qv = h('span', { class: 'adj-val' }, '82');
  q.oninput = () => { qv.textContent = q.value; };
  const where = h('select', { class: 'input', style: { width: '100%' } }, h('option', { value: 'beside' }, 'Next to the originals, with “ (edited)” added to the name'), h('option', { value: 'sub' }, 'In a new “Edited pictures” folder beside them'));
  const wmLine = h('div', { class: 'row-inline wrap' }, h('span', { class: 'hint' }, wm0.kind === 'text' ? `Your mark: “${wm0.text}”` : 'Your mark: a logo'), h('button', { class: 'btn small', type: 'button', onclick: () => watermarkDialog() }, 'Change my watermark…'));
  const sync = () => { resizeRow.style.display = doResize.i.checked ? '' : 'none'; convRow.style.display = doConvert.i.checked ? '' : 'none'; wmLine.style.display = doWm.i.checked ? '' : 'none'; };
  const resizeRow = h('div', { class: 'row-inline wrap indent' }, mode, px, unit);
  const convRow = h('div', { class: 'stack indent' }, fmt, h('div', { class: 'row-inline' }, h('span', {}, 'Quality'), q, qv, h('span', { class: 'hint' }, 'for JPG and WebP; lower is a smaller file')));
  for (const c of [doResize, doConvert, doWm, doStrip]) c.i.onchange = sync;
  sync();
  const body = h('div', { class: 'stack' },
    h('div', { class: 'hint' }, `${plural(pics.length, 'picture')} chosen. Your originals are never changed: the new pictures are saved as new files.`),
    doResize.el, resizeRow, doConvert.el, convRow, doWm.el, wmLine, doStrip.el, field('Save them', where));
  const ok = await modal({ title: 'Pictures: resize, convert and watermark', body, width: 540, buttons: [cancelBtn, { label: `Make ${plural(pics.length, 'new picture')}`, primary: true, value: true }] });
  if (!ok) return;
  if (!doResize.i.checked && !doConvert.i.checked && !doWm.i.checked && !doStrip.i.checked) return toast('Pick at least one thing to do');
  const wm = getWatermark();
  const wmImg = doWm.i.checked ? await watermarkImage(wm).catch(() => null) : null;
  if (doWm.i.checked && wm.kind === 'image' && !wmImg) return toast('Your watermark logo could not be read. Choose it again in “Change my watermark”.', { error: true });
  const made = [];
  const sub = where.value === 'sub';
  const r = await eachWithProgress('Pictures', pics, async (it) => {
    const bmp = await loadBitmap(it.path);
    try {
      const [W, H] = doResize.i.checked ? targetSize(bmp.width, bmp.height, mode.value, +px.value || 1) : [bmp.width, bmp.height];
      if (W > 16000 || H > 16000) throw new Error('too large');
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      let type = MIME[it.ext] || 'image/png';
      if (doConvert.i.checked && fmt.value !== 'keep') type = fmt.value;
      if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); } // JPG has no see-through
      g.drawImage(bmp, 0, 0, W, H);
      if (doWm.i.checked) drawWatermark(g, W, H, wm, wmImg);
      const url = cv.toDataURL(type, +q.value / 100);
      if (!url.startsWith(`data:${type}`)) throw new Error(`${EXT_OF[type] || type} can’t be made here`);
      const dir = sub ? pjoin(dirname(it.path), 'Edited pictures') : dirname(it.path);
      if (sub) await api('fs:mkdir', dir).catch(() => {});
      const name = `${stem(it.name)}${sub ? '' : ' (edited)'}.${EXT_OF[type]}`;
      const target = await api('fs:uniqueName', dir, name, 'number');
      await api('fs:writeDataUrl', target, url);
      made.push(target);
    } finally { bmp.close?.(); }
  }, (x) => x.name);
  if (made.length) A.pushUndo({ type: 'created', paths: made }, 'Batch pictures');
  report('Made', r);
  refresh();
}

// ======================================================================
// Dates and attributes
// ======================================================================
export async function batchDates(given = sel()) {
  if (!gate()) return;
  const items = real(given);
  if (!items.length) return toast('Select some files or folders first');
  const amount = numInput(2, -100000, 100000, 90);
  const unit = h('select', { class: 'input small' }, ...[['minutes', 60000], ['hours', 3600000], ['days', 86400000], ['weeks', 604800000]].map(([l, v], i) => h('option', { value: String(v), selected: i === 1 }, l)));
  const dir = h('select', { class: 'input small' }, h('option', { value: '1' }, 'later (add)'), h('option', { value: '-1' }, 'earlier (subtract)'));
  const cM = checkbox('Modified', true), cC = checkbox('Created', true), cA = checkbox('Accessed', false);
  const attr = (label) => { const s = h('select', { class: 'input small' }, h('option', { value: '' }, 'Leave as it is'), h('option', { value: '1' }, 'Turn on'), h('option', { value: '0' }, 'Turn off')); return { s, el: h('div', { class: 'row-inline' }, h('span', { style: { minWidth: '90px' } }, label), s) }; };
  const aRO = attr('Read-only'), aHid = attr('Hidden');
  const body = h('div', { class: 'stack' },
    h('div', { class: 'hint' }, `${plural(items.length, 'item')} chosen. Move every date by the same amount, for example to fix photos taken with the camera clock set wrong.`),
    field('Move the dates', h('div', { class: 'row-inline wrap' }, amount, unit, dir)),
    h('div', { class: 'row-inline wrap' }, cM.el, cC.el, cA.el),
    field('Attributes', aRO.el, aHid.el));
  const ok = await modal({ title: 'Dates and attributes', body, width: 480, buttons: [cancelBtn, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  const shift = (+amount.value || 0) * +unit.value * +dir.value;
  const changeAttrs = aRO.s.value !== '' || aHid.s.value !== '';
  if (!shift && !changeAttrs) return toast('Nothing to change');
  const before = [];
  const r = await eachWithProgress('Dates and attributes', items, async (it) => {
    const st = await api('fs:stat', it.path);
    const a = await api('fs:attributes', it.path).catch(() => ({}));
    const prev = { path: it.path, times: { ctime: st.ctime, mtime: st.mtime, atime: st.atime }, attrs: { readonly: !!a.readonly, hidden: !!a.hidden, system: !!a.system, archive: !!a.archive } };
    const next = { ...prev.attrs };
    if (aRO.s.value !== '') next.readonly = aRO.s.value === '1';
    if (aHid.s.value !== '') next.hidden = aHid.s.value === '1';
    // a read-only file refuses new dates: lift that for a moment, then put the final value back
    if (shift && prev.attrs.readonly) await api('fs:setAttributes', [it.path], { ...prev.attrs, readonly: false });
    if (shift) await setDates(it.path, st, shift, cM.i.checked, cC.i.checked, cA.i.checked);
    const wantAttrs = changeAttrs ? next : prev.attrs;
    if (changeAttrs || (shift && prev.attrs.readonly)) await api('fs:setAttributes', [it.path], wantAttrs);
    before.push(prev);
  }, (x) => x.name);
  refresh();
  report('Changed', r, {
    action: before.length ? { label: 'Undo', run: async () => {
      for (const p of before) {
        try { if (p.attrs) await api('fs:setAttributes', [p.path], { ...p.attrs, readonly: false }); await api('fs:setTimes', p.path, p.times); if (p.attrs) await api('fs:setAttributes', [p.path], p.attrs); } catch { /* the file moved or went: nothing to put back */ }
      }
      toast('Dates and attributes put back'); refresh();
    } } : undefined,
  });
}
async function setDates(path, st, shift, m, c, a) {
  if (!shift) return;
  const t = {};
  if (m) t.mtime = st.mtime + shift;
  if (c) t.ctime = st.ctime + shift;
  if (a) t.atime = st.atime + shift;
  if (!Object.keys(t).length) return;
  await api('fs:setTimes', path, t);
}

// ======================================================================
// Pack into folders / flatten
// ======================================================================
const dateFolder = (f, by) => { const d = new Date(f.mtime || f.ctime || Date.now()); const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0'); return by === 'year' ? `${y}` : by === 'day' ? `${y}-${m}-${dd}` : `${y}-${m}`; };
const safeFolderName = (n) => String(n).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || 'Other';

export async function packIntoFolders(given = sel()) {
  if (!gate()) return;
  const files = real(given).filter((i) => !i.isDir);
  if (!files.length) return toast('Select some files first');
  const base = dirname(files[0].path);
  const by = h('select', { class: 'input small' },
    h('option', { value: 'ext' }, 'The file type (jpg, pdf, …)'), h('option', { value: 'kind' }, 'The kind (Pictures, Documents, Music, …)'),
    h('option', { value: 'month' }, 'The month it was changed'), h('option', { value: 'year' }, 'The year it was changed'), h('option', { value: 'day' }, 'The day it was changed'),
    h('option', { value: 'topic' }, 'What the name is about (groups similar names)'), h('option', { value: 'letter' }, 'The first letter of the name'));
  const preview = h('div', { class: 'batch-preview' });
  const plan = async () => {
    const m = new Map();
    if (by.value === 'topic') {
      const g = groupByName(files, { min: 2, folderName: basename(base) });
      for (const [name, list] of g.groups) m.set(name, list);
      if (g.rest?.length) m.set('Other', g.rest);
    } else {
      const key = { ext: (f) => (f.ext || 'No type').toUpperCase(), kind: (f) => kindFolder(f.ext), month: (f) => dateFolder(f, 'month'), year: (f) => dateFolder(f, 'year'), day: (f) => dateFolder(f, 'day'), letter: (f) => { const c = f.name[0].toUpperCase(); return /[A-Z]/.test(c) ? c : /[0-9]/.test(c) ? '0-9' : '#'; } }[by.value];
      for (const [k, list] of groupBy(files, key)) m.set(k, list);
    }
    return m;
  };
  const draw = async () => {
    const m = await plan();
    preview.replaceChildren(...[...m.entries()].slice(0, 12).map(([k, l]) => h('div', {}, `${safeFolderName(k)}  ·  ${plural(l.length, 'file')}`)), ...(m.size > 12 ? [h('div', { class: 'hint' }, `…and ${m.size - 12} more folders`)] : []));
  };
  by.onchange = draw; await draw();
  const ok = await modal({ title: 'Pack into folders', width: 500, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `${plural(files.length, 'file')} chosen. One folder is made for each group, inside “${basename(base)}”, and the files are moved into it.`), field('Make a folder for', by), field('What will happen', preview)), buttons: [cancelBtn, { label: 'Pack them', primary: true, value: true }] });
  if (!ok) return;
  const m = await plan();
  const pairs = [], createdDirs = [];
  const jobs = [...m.entries()].flatMap(([k, list]) => list.map((f) => [safeFolderName(k), f]));
  const r = await eachWithProgress('Pack into folders', jobs, async ([k, f]) => {
    const dir = pjoin(dirname(f.path), k);
    if (!(await api('fs:exists', dir).catch(() => false))) { await api('fs:mkdir', dir); createdDirs.push(dir); }
    const to = await api('fs:uniqueName', dir, f.name, 'number');
    await api('fs:rename', f.path, to);
    pairs.push([f.path, to]);
  }, ([, f]) => f.name);
  A.pushUndo({ type: 'moved', pairs }, 'Pack into folders');
  report('Packed', r);
  refresh();
}

export async function flattenFolders(given = sel()) {
  if (!gate()) return;
  const dirs = real(given).filter((i) => i.isDir);
  if (!dirs.length) return toast('Select the folders to flatten');
  const found = [];
  const walk = async (root, dir) => {
    const r = await api('fs:list', dir).catch(() => ({ items: [] }));
    for (const it of r.items || []) { if (it.isDir) await walk(root, it.path); else if (dir !== root) found.push({ root, ...it }); }
  };
  for (const d of dirs) await walk(d.path, d.path);
  if (!found.length) return toast('There are no files in the folders inside to bring up');
  const rm = checkbox('Then move the emptied folders to the Recycle Bin', true);
  const ok = await modal({ title: 'Flatten folders', width: 480, body: h('div', { class: 'stack' }, h('div', {}, `${plural(found.length, 'file')} inside the folders within ${dirs.length === 1 ? `“${dirs[0].name}”` : plural(dirs.length, 'chosen folder')} will move up into ${dirs.length === 1 ? 'it' : 'their top folder'}.`), h('div', { class: 'hint' }, 'A file whose name is already taken gets a number added. Nothing is overwritten.'), rm.el), buttons: [cancelBtn, { label: 'Flatten', primary: true, value: true }] });
  if (!ok) return;
  const pairs = [];
  const r = await eachWithProgress('Flatten folders', found, async (f) => {
    const to = await api('fs:uniqueName', f.root, f.name, 'number');
    await api('fs:rename', f.path, to);
    pairs.push([f.path, to]);
  }, (f) => f.name);
  A.pushUndo({ type: 'moved', pairs }, 'Flatten folders');
  if (rm.i.checked && !r.failed.length && !r.cancelled) {
    // only folders that are now truly empty
    const empties = [];
    const sweep = async (dir, top) => {
      const l = await api('fs:list', dir).catch(() => ({ items: [] }));
      let left = 0;
      for (const it of l.items || []) { if (it.isDir) { if (!(await sweep(it.path, false))) left++; } else left++; }
      if (!left && !top) empties.push(dir);
      return !left;
    };
    for (const d of dirs) await sweep(d.path, true);
    const top = empties.filter((e) => !empties.some((o) => o !== e && e.startsWith(o + (IS_WIN() ? '\\' : '/'))));
    if (top.length) await A.runJob({ type: 'trash', sources: top });
  }
  report('Moved up', r);
  refresh();
}

// ======================================================================
// Zip each / extract each
// ======================================================================
export async function zipEach(given = sel()) {
  if (!gate()) return;
  const items = real(given);
  if (!items.length) return toast('Select the files or folders to zip');
  const ok = await confirm('Zip each one', `Make ${plural(items.length, 'separate .zip file')}, one for each chosen ${items.every((i) => i.isDir) ? 'folder' : 'item'}, next to the original. The originals stay where they are.`, { ok: 'Zip them' });
  if (!ok) return;
  const made = [];
  const r = await eachWithProgress('Zip each', items, async (it) => {
    const dir = dirname(it.path);
    const out = await api('fs:uniqueName', dir, `${it.isDir ? it.name : stem(it.name) || it.name}.zip`, 'number');
    const j = await A.runJob({ type: 'compress', sources: [it.path], dest: dir, opts: { output: out, format: 'zip' } });
    if (j.status !== 'done') throw new Error(j.error || j.errors?.[0] || 'could not be zipped');
    made.push(out);
  }, (x) => x.name);
  report('Zipped', r);
  refresh();
}

export async function extractEach(given = sel()) {
  if (!gate()) return;
  const arcs = real(given).filter((i) => KINDS.archive.includes(i.ext));
  if (!arcs.length) return toast('Select some archives (.zip, .7z, .rar …)');
  const ok = await confirm('Extract each into its own folder', `${plural(arcs.length, 'archive')} will each be opened into a new folder named after it, next to the archive.`, { ok: 'Extract them' });
  if (!ok) return;
  const r = await eachWithProgress('Extract each', arcs, async (a) => {
    const dir = dirname(a.path);
    const j = await A.runJob({ type: 'extract', sources: [a.path], dest: dir, opts: { smart: false, toFolder: true } });
    if (j.status !== 'done') throw new Error(j.error || j.errors?.[0] || 'could not be extracted');
  }, (x) => x.name);
  report('Extracted', r);
  refresh();
}

// ======================================================================
// Documents: text out of .docx/.pdf/…, merge PDFs
// ======================================================================
export async function documentsToText(given = sel()) {
  if (!gate()) return;
  const docs = real(given).filter((i) => !i.isDir && ['docx', 'doc', 'odt', 'rtf', 'pdf', 'xlsx', 'pptx', 'epub', 'html', 'htm'].includes(i.ext));
  if (!docs.length) return toast('Select some documents (Word, PDF, …) first');
  const fmt = h('select', { class: 'input small' }, h('option', { value: 'txt' }, 'Plain text (.txt)'), h('option', { value: 'md' }, 'Markdown (.md)'));
  const one = checkbox('Also put all of it in one file', false);
  const ok = await modal({ title: 'Text out of documents', width: 460, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, `${plural(docs.length, 'document')} chosen. Each gets a text copy next to it. A scanned PDF with no real text will come out empty (use the OCR tool for those).`), field('Save as', fmt), one.el), buttons: [cancelBtn, { label: 'Get the text', primary: true, value: true }] });
  if (!ok) return;
  const all = [], made = [];
  const r = await eachWithProgress('Text out of documents', docs, async (it) => {
    const text = await api('doc:text', it.path, 5_000_000);
    const body = typeof text === 'string' ? text : text?.text ?? '';
    if (!body.trim()) throw new Error('no text found');
    const out = await api('fs:uniqueName', dirname(it.path), `${stem(it.name)}.${fmt.value}`, 'number');
    await api('fs:writeText', out, fmt.value === 'md' ? `# ${stem(it.name)}\n\n${body}\n` : body);
    made.push(out); all.push(`${fmt.value === 'md' ? '# ' : '===== '}${it.name}${fmt.value === 'md' ? '' : ' ====='}\n\n${body}\n`);
  }, (x) => x.name);
  if (one.i.checked && all.length) {
    const out = await api('fs:uniqueName', dirname(docs[0].path), `All text.${fmt.value}`, 'number');
    await api('fs:writeText', out, all.join('\n\n'));
    made.push(out);
  }
  if (made.length) A.pushUndo({ type: 'created', paths: made }, 'Text out of documents');
  report('Got the text of', r);
  refresh();
}
export async function mergePdfFiles(given = sel()) {
  if (!gate()) return;
  const pdfs = real(given).filter((i) => !i.isDir && i.ext === 'pdf').map((i) => i.path);
  return (await import('./protools.js')).mergePdfs(pdfs);
}

// ======================================================================
// Find & replace inside text files
// ======================================================================
const originals = new Map(); // path -> the text before a replace, for Undo while the window is open
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'cs', 'java', 'kt', 'sh', 'ps1', 'bat', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'log', 'srt', 'vtt', 'sql', 'svg', 'tex', 'rtf']);
async function readUtf8(path) {
  const r = await api('fs:readBuffer', path, 20 * 1024 * 1024);
  const bin = atob(r.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.includes(0)) throw new Error('not a text file');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('not UTF-8 text (left alone so it isn’t damaged)'); }
  return text;
}
export function buildMatcher(find, { regex, caseSens, whole }) {
  if (!find) throw new Error('Type what to find');
  let src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (whole) src = `\\b(?:${src})\\b`;
  return new RegExp(src, 'g' + (caseSens ? '' : 'i') + 'm');
}
export async function findReplaceInFiles(given = sel()) {
  if (!gate()) return;
  let files = [];
  const skipped = [];
  for (const it of real(given)) {
    if (!it.isDir) { files.push(it); continue; }
    const walk = async (dir, depth) => { const l = await api('fs:list', dir).catch(() => ({ items: [] })); for (const c of l.items || []) { if (c.isDir) { if (depth < 6 && !c.name.startsWith('.') && c.name !== 'node_modules') await walk(c.path, depth + 1); } else files.push(c); } };
    await walk(it.path, 0);
  }
  files = files.filter((f) => { const ok = TEXT_EXT.has((f.ext || '').toLowerCase()); if (!ok) skipped.push(f); return ok; });
  if (!files.length) return toast('Select some text files (or a folder of them) first');
  const find = h('input', { class: 'input', placeholder: 'Find', spellcheck: 'false' });
  const repl = h('input', { class: 'input', placeholder: 'Replace with (leave empty to remove)', spellcheck: 'false' });
  for (const i of [find, repl]) i.addEventListener('keydown', (e) => e.stopPropagation());
  const rx = checkbox('Use a pattern (regular expression; $1 and $& work in the replacement)', false), cs = checkbox('Match capitals exactly', false), wh = checkbox('Whole words only', false);
  const list = h('div', { class: 'batch-preview tall' }, h('div', { class: 'hint' }, 'Type something to find, then press “Preview”.'));
  const summary = h('div', { class: 'hint' }, `${plural(files.length, 'text file')} will be searched${skipped.length ? ` (${plural(skipped.length, 'other file')} skipped)` : ''}.`);
  let hits = [];
  const preview = async () => {
    let re;
    try { re = buildMatcher(find.value, { regex: rx.i.checked, caseSens: cs.i.checked, whole: wh.i.checked }); } catch (e) { list.replaceChildren(h('div', { class: 'err' }, errText(e))); return; }
    list.replaceChildren(h('div', { class: 'hint' }, 'Looking…'));
    hits = []; const notes = [];
    let total = 0;
    for (const f of files) {
      try {
        const text = await readUtf8(f.path);
        const ms = [...text.matchAll(re)].filter((m) => m[0].length);
        if (!ms.length) continue;
        total += ms.length;
        const sample = ms.slice(0, 3).map((m) => {
          const s = Math.max(0, m.index - 24), e = Math.min(text.length, m.index + m[0].length + 24);
          const line = (a, b) => text.slice(a, b).replace(/\r?\n/g, '↵');
          return { before: line(s, m.index), match: m[0], after: line(m.index + m[0].length, e), to: m[0].replace(re, repl.value) };
        });
        hits.push({ f, count: ms.length, sample, on: true });
      } catch (e) { notes.push(`${f.name}: ${errText(e)}`); }
    }
    list.replaceChildren();
    for (const hit of hits) {
      const c = h('input', { type: 'checkbox' }); c.checked = true; c.onchange = () => { hit.on = c.checked; };
      list.append(h('div', { class: 'bp-file' }, h('label', { class: 'check' }, c, h('b', {}, ' ' + hit.f.name), h('span', { class: 'hint' }, `  ${plural(hit.count, 'change')}`)),
        ...hit.sample.map((s) => h('div', { class: 'bp-line' }, s.before, h('del', {}, s.match), h('ins', {}, s.to), s.after))));
    }
    if (!hits.length) list.append(h('div', { class: 'hint' }, 'Nothing found.'));
    if (notes.length) list.append(h('div', { class: 'hint' }, `Left alone: ${notes.slice(0, 4).join('; ')}${notes.length > 4 ? ` (+${notes.length - 4} more)` : ''}`));
    summary.textContent = `${plural(total, 'place')} in ${plural(hits.length, 'file')}.`;
  };
  find.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); preview(); } };
  const body = h('div', { class: 'stack' }, h('div', { class: 'row-inline' }, find), h('div', { class: 'row-inline' }, repl), rx.el, cs.el, wh.el,
    h('div', { class: 'row-inline' }, h('button', { class: 'btn small', type: 'button', onclick: preview }, 'Preview'), summary), list);
  const go = await modal({ title: 'Find and replace in files', body, width: 640, className: 'no-enter', buttons: [cancelBtn, { label: 'Replace in the ticked files', primary: true, value: true }] });
  if (!go) return;
  if (!hits.length) await preview();
  const todo = hits.filter((x) => x.on);
  if (!todo.length) return toast('Nothing to replace');
  const re = buildMatcher(find.value, { regex: rx.i.checked, caseSens: cs.i.checked, whole: wh.i.checked });
  originals.clear();
  const r = await eachWithProgress('Find and replace', todo, async ({ f }) => {
    const text = await readUtf8(f.path); // read again: it may have changed since the preview
    const next = text.replace(re, repl.value);
    if (next === text) return;
    originals.set(f.path, text);
    await api('fs:writeText', f.path, next); // written in full beside the file, then swapped in, so a crash never leaves half a file
  }, (x) => x.f.name);
  refresh();
  report('Changed', r, originals.size ? { action: { label: 'Undo', run: undoReplace } } : {});
}
async function undoReplace() {
  let n = 0;
  for (const [p, text] of originals) { try { await api('fs:writeText', p, text); n++; } catch { /* gone or locked */ } }
  originals.clear();
  toast(`Put back ${plural(n, 'file')}`); refresh();
}

// ======================================================================
// Copy paths
// ======================================================================
export async function copyPathsMany(given = sel()) {
  let items = real(given);
  if (!items.length && here()) items = [{ path: here(), name: basename(here()), isDir: true }];
  if (!items.length) return toast('Select some files or folders first');
  const base = dirname(items[0].path);
  const modes = [['full', 'Full path (C:\\Folder\\file.txt)'], ['relative', 'Path inside this folder (sub\\file.txt)'], ['name', 'Just the name'], ['quoted', 'Full path in quotes'], ['unix', 'Forward slashes (C:/Folder/file.txt)'], ['uri', 'A link (file:///C:/Folder/file.txt)'], ['dir', 'The folder it is in']];
  const rs = modes.map(([v, l], i) => radio('pm', v, l, i === 0));
  const join = h('select', { class: 'input small' }, h('option', { value: 'nl' }, 'One per line'), h('option', { value: 'comma' }, 'Separated by commas'), h('option', { value: 'semi' }, 'Separated by semicolons'));
  const out = h('textarea', { class: 'input', rows: '5', readonly: 'true', spellcheck: 'false' });
  const make = () => {
    const mode = rs.find((x) => x.i.checked).i.value;
    const rel = (p) => { const b = base.replace(/[\\/]+$/, ''); return p.toLowerCase().startsWith(b.toLowerCase()) ? p.slice(b.length).replace(/^[\\/]+/, '') : p; };
    const lines = items.map((i) => ({ full: i.path, relative: rel(i.path), name: i.name, quoted: `"${i.path}"`, unix: i.path.replace(/\\/g, '/'), uri: 'file:///' + encodeURI(i.path.replace(/\\/g, '/')).replace(/^\/+/, ''), dir: dirname(i.path) }[mode]));
    const sep = { nl: '\n', comma: ', ', semi: '; ' }[join.value];
    return lines.join(sep);
  };
  const upd = () => { out.value = make(); };
  for (const r of rs) r.i.onchange = upd; join.onchange = upd; upd();
  const ok = await modal({ title: 'Copy paths', width: 520, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, plural(items.length, 'item') + ' chosen.'), ...rs.map((r) => r.el), field('Layout', join), out), buttons: [cancelBtn, { label: 'Copy', primary: true, value: true }] });
  if (!ok) return;
  await api('clip:writeText', make());
  toast(`Copied ${plural(items.length, 'path')}`, { ok: true });
}

/** shortcuts or links to the chosen items, made in the folder shown in the other pane (or one you pick) */
export async function linksInto(given = sel(), kind = 'shortcut') {
  if (!gate()) return;
  const items = real(given);
  if (!items.length) return toast('Select some files or folders first');
  let hint = '';
  try { const o = otherPaneTab(); if (o && o.path && !o.path.startsWith('atlas:')) hint = ` (the other pane shows ${basename(o.path)})`; } catch { /* no second pane */ }
  const dest = await api('dialog:pickFolder', `Make the ${kind}s in…${hint}`);
  if (!dest) return;
  const made = [];
  const r = await eachWithProgress(kind === 'shortcut' ? 'Shortcuts' : 'Links', items, async (it) => {
    if (kind === 'shortcut') { const to = await api('fs:uniqueName', dest, `${it.name}${IS_WIN() ? ' - Shortcut.lnk' : ''}`, 'number'); await api('fs:shortcut', to, it.path); made.push(to); }
    else { const to = await api('fs:uniqueName', dest, it.name, 'number'); await api('fs:symlink', it.path, to, it.isDir ? 'junction' : 'file'); made.push(to); }
  }, (x) => x.name);
  if (made.length) A.pushUndo({ type: 'created', paths: made }, kind === 'shortcut' ? 'Make shortcuts' : 'Make links');
  report('Made', r);
  if (r.failed.length && kind === 'symlink' && /privilege|permission|denied|1314/i.test(r.failed[0].error)) toast('File links need Developer Mode or running as administrator. Shortcuts always work.', { error: true });
  refresh();
}

// ======================================================================
// Checksums
// ======================================================================
export async function checksumsMany(given = sel()) {
  const hist = await import('./history.js');
  return hist.createChecksums(real(given));
}
export async function verifyChecksumsMany(given = sel()) {
  const hist = await import('./history.js');
  const f = real(given).find((i) => /\.(sha256|sha1|md5|sfv)$/i.test(i.name));
  return hist.verifyChecksums(f?.path);
}

// ======================================================================
// Tags and notes
// ======================================================================
const noteKey = (p) => (IS_WIN() ? p.toLowerCase() : p);
export const noteOf = (p) => state.tags.notes?.[noteKey(p)] || '';
export function setNotes(paths, text, mode = 'replace') {
  state.tags.notes ||= {};
  for (const p of paths) {
    const k = noteKey(p), cur = state.tags.notes[k] || '';
    const next = mode === 'append' ? [cur, text].filter(Boolean).join('\n') : text;
    if (next.trim()) state.tags.notes[k] = next; else delete state.tags.notes[k];
  }
  saveTags(); bus.emit('tags');
}
export async function tagsAndNotes(given = sel()) {
  if (!gate()) return;
  const items = real(given);
  if (!items.length) return toast('Select some files or folders first');
  const paths = items.map((i) => i.path);
  const defs = state.tags.defs;
  const add = new Set(), remove = new Set();
  const chips = h('div', { class: 'row-inline wrap' });
  const draw = () => {
    chips.replaceChildren(...defs.map((d) => {
      const have = paths.filter((p) => tagsOf(p).includes(d.id)).length;
      const st = add.has(d.id) ? 'add' : remove.has(d.id) ? 'remove' : '';
      const b = h('button', { class: 'btn small tag-chip' + (st ? ' on' : ''), type: 'button', title: have ? `${have} of ${paths.length} have it now` : 'None have it now', style: { borderColor: d.color } },
        h('span', { class: 'tag-dot', style: { background: d.color, display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', marginRight: '6px' } }), d.name, st === 'add' ? '  + add' : st === 'remove' ? '  − remove' : have ? `  (${have})` : '');
      b.onclick = () => { if (add.has(d.id)) { add.delete(d.id); remove.add(d.id); } else if (remove.has(d.id)) remove.delete(d.id); else add.add(d.id); draw(); };
      return b;
    }));
    if (!defs.length) chips.append(h('span', { class: 'hint' }, 'No tags yet. Make one below.'));
  };
  const newName = h('input', { class: 'input', placeholder: 'New tag name', style: { width: '170px' } });
  const newCol = h('input', { type: 'color', value: '#12a594' });
  const addNew = h('button', { class: 'btn small', type: 'button', onclick: () => { const n = newName.value.trim(); if (!n) return; if (defs.some((d) => d.name.toLowerCase() === n.toLowerCase())) return toast('That tag exists'); const d = { id: 't' + Date.now().toString(36), name: n, color: newCol.value }; defs.push(d); saveTags(); add.add(d.id); newName.value = ''; draw(); } }, 'Make tag');
  newName.addEventListener('keydown', (e) => e.stopPropagation());
  const noteMode = h('select', { class: 'input small' }, h('option', { value: 'none' }, 'Leave notes as they are'), h('option', { value: 'append' }, 'Add this to each note'), h('option', { value: 'replace' }, 'Replace each note with this'), h('option', { value: 'clear' }, 'Remove the notes'));
  const note = h('textarea', { class: 'input', rows: '3', placeholder: 'A note to keep with these files…' });
  note.addEventListener('keydown', (e) => e.stopPropagation());
  const existing = items.length === 1 ? noteOf(items[0].path) : '';
  if (existing) note.value = existing;
  draw();
  const body = h('div', { class: 'stack' }, h('div', { class: 'hint' }, `${plural(items.length, 'item')} chosen. Click a tag once to add it to all of them, again to take it off all of them.`), chips,
    h('div', { class: 'row-inline' }, newName, newCol, addNew), field('Notes', noteMode, note));
  if (existing) noteMode.value = 'replace';
  const ok = await modal({ title: 'Tags and notes', body, width: 520, buttons: [cancelBtn, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  for (const id of add) setTags(paths, id, true);
  for (const id of remove) setTags(paths, id, false);
  if (noteMode.value === 'clear') setNotes(paths, '', 'replace');
  else if (noteMode.value !== 'none') setNotes(paths, note.value.trim(), noteMode.value);
  toast(`Updated ${plural(items.length, 'item')}`, { ok: true });
  refresh();
}

// ======================================================================
// Music tags and stems
// ======================================================================
const isAudio = (i) => !i.isDir && KINDS.audio.includes(i.ext);
export async function musicTags(given = sel()) {
  const files = real(given).filter(isAudio).map((i) => i.path);
  if (!files.length) return toast('Select some music files first');
  return (await import('./tageditor.js')).openTagEditor(files);
}
export async function batchStems(given = sel()) {
  if (!gate()) return;
  let songs = real(given).filter(isAudio);
  for (const d of real(given).filter((i) => i.isDir)) { const l = await api('fs:list', d.path).catch(() => ({ items: [] })); songs.push(...(l.items || []).filter(isAudio)); }
  songs = [...new Map(songs.map((s) => [s.path, s])).values()];
  if (!songs.length) return toast('Select songs or a folder of songs first');
  const all = checkbox('Save all six parts (vocals, drums, bass, guitar, piano, other)', false);
  const where = h('select', { class: 'input', style: { width: '100%' } }, h('option', { value: 'beside' }, 'Next to each song'), h('option', { value: 'one' }, 'Into a new “Stems” folder beside the first song'));
  const ok = await modal({ title: 'Separate vocals and instrumentals', width: 520, body: h('div', { class: 'stack' },
    h('div', { class: 'hint' }, `${plural(songs.length, 'song')} will go through the stem separator one after another. Each gets a “vocals” and an “instrumental” WAV. It runs on this PC, takes a few minutes per song, and you can keep using Dogfile. Songs over 10 minutes are skipped.`), all.el, field('Save them', where)), buttons: [cancelBtn, { label: 'Start', primary: true, value: true }] });
  if (!ok) return;
  let outDir = '';
  if (where.value === 'one') { outDir = pjoin(dirname(songs[0].path), 'Stems'); await api('fs:mkdir', outDir).catch(() => {}); }
  const { separateBatch } = await import('./stems.js');
  const job = clientJob('Stem separation');
  job.update({ total: songs.length, filesTotal: songs.length, done: 0, filesDone: 0 });
  const made = [], fails = [];
  const res = await separateBatch(songs.map((s) => s.path), { allParts: all.i.checked, outDir }, {
    cancelled: () => job.cancelled,
    onSong: (i, n, name) => job.update({ current: name, done: i, filesDone: i }),
    onPart: (k, n) => job.update({ current: `${job.current || ''}`.replace(/ · part.*/, '') + ` · part ${k} of ${n}` }),
    onDone: (p, outs) => made.push(...outs),
    onFail: (p, msg) => fails.push(`${basename(p)}: ${msg}`),
  });
  job.update({ done: songs.length, filesDone: songs.length });
  job.finish(res.failed && !res.done ? 'error' : 'done', fails[0]);
  if (made.length) A.pushUndo({ type: 'created', paths: made }, 'Stem separation');
  toast(job.cancelled ? `Stopped after ${plural(res.done, 'song')}` : `Separated ${plural(res.done, 'song')}${res.failed ? `, ${res.failed} failed (${fails[0]})` : ''}`, { error: !res.done && res.failed > 0, ok: res.done > 0 });
  refresh();
}

// ======================================================================
// The window
// ======================================================================
export const TOOLS = [
  { id: 'pictures', icon: 'image', title: 'Pictures', text: 'Make smaller, change type, compress, take off camera details, add your watermark', run: batchPictures, fits: (s) => s.some((i) => isImageFile(i)) },
  { id: 'dates', icon: 'clock', title: 'Dates and attributes', text: 'Move dates later or earlier; read-only and hidden', run: batchDates, fits: (s) => s.length > 0 },
  { id: 'pack', icon: 'folder', title: 'Pack into folders', text: 'By type, kind, date, topic or first letter', run: packIntoFolders, fits: (s) => s.some((i) => !i.isDir) },
  { id: 'flatten', icon: 'folderOpen', title: 'Flatten folders', text: 'Bring every file up out of the folders inside', run: flattenFolders, fits: (s) => s.some((i) => i.isDir) },
  { id: 'zip', icon: 'zip', title: 'Zip each one', text: 'A separate .zip for every item', run: zipEach, fits: (s) => s.length > 0 },
  { id: 'extract', icon: 'zip', title: 'Extract each one', text: 'Every archive into its own folder', run: extractEach, fits: (s) => s.some((i) => KINDS.archive.includes(i.ext)) },
  { id: 'text', icon: 'page', title: 'Text out of documents', text: 'Word, PDF and more to .txt or .md', run: documentsToText, fits: (s) => s.some((i) => !i.isDir && ['docx', 'doc', 'odt', 'rtf', 'pdf', 'xlsx', 'pptx', 'epub', 'html'].includes(i.ext)) },
  { id: 'merge', icon: 'page', title: 'Merge PDFs', text: 'Join the chosen PDFs into one', run: mergePdfFiles, fits: (s) => s.filter((i) => i.ext === 'pdf').length > 1 },
  { id: 'replace', icon: 'search', title: 'Find and replace in files', text: 'With a preview, patterns allowed, safe saving', run: findReplaceInFiles, fits: (s) => s.length > 0 },
  { id: 'paths', icon: 'copy', title: 'Copy paths', text: 'Full, relative, names, links, one per line', run: copyPathsMany, fits: () => true },
  { id: 'shortcuts', icon: 'link', title: 'Make shortcuts', text: 'Shortcuts to the chosen items in another folder', run: (s) => linksInto(s, 'shortcut'), fits: (s) => s.length > 0 },
  { id: 'links', icon: 'link', title: 'Make links', text: 'Symbolic links (or folder junctions)', run: (s) => linksInto(s, 'symlink'), fits: (s) => s.length > 0 },
  { id: 'sums', icon: 'shieldCheck', title: 'Checksum file', text: 'One file with a fingerprint of everything', run: checksumsMany, fits: (s) => s.length > 0 },
  { id: 'verify', icon: 'shieldCheck', title: 'Verify checksums', text: 'Check files against a .sha256 / .md5 list', run: verifyChecksumsMany, fits: () => true },
  { id: 'tags', icon: 'tag', title: 'Tags and notes', text: 'Colour tags and a shared note for many files', run: tagsAndNotes, fits: (s) => s.length > 0 },
  { id: 'music', icon: 'music', title: 'Music tags', text: 'Artist, album, year, cover for many songs', run: musicTags, fits: (s) => s.some(isAudio) },
  { id: 'stems', icon: 'music', title: 'Vocals and instrumentals', text: 'Separate a whole album or folder', run: batchStems, fits: (s) => s.some((i) => isAudio(i) || i.isDir) },
];

export async function openBatchTools() {
  const items = sel();
  const grid = h('div', { class: 'batch-grid' });
  for (const t of TOOLS) {
    const fits = t.fits(items);
    const b = h('button', { class: 'batch-card' + (fits ? '' : ' dim'), type: 'button', title: fits ? t.text : `${t.text}\n(Select ${t.id === 'merge' ? 'two or more PDFs' : 'the right kind of files'} first)`, html: `${icon(t.icon)}<span class="bc-t">${esc(t.title)}</span><span class="bc-s">${esc(t.text)}</span>` });
    b.onclick = () => { document.querySelector('.batch-modal')?._close?.(null); setTimeout(() => t.run(sel()), 0); };
    grid.append(b);
  }
  const wmBtn = h('button', { class: 'btn small', type: 'button', onclick: () => watermarkDialog() }, 'My watermark…');
  const body = h('div', { class: 'stack' }, h('div', { class: 'hint' }, items.length ? `${plural(items.length, 'item')} selected. Pick what to do with them.` : 'Select files or folders in the file list, then pick what to do. Tools that don’t fit your selection are dimmed.'), grid);
  modal({ title: 'Batch tools', body, width: 720, className: 'batch-modal', buttons: [{ el: wmBtn, left: true }, { label: 'Close', value: null }] });
}
