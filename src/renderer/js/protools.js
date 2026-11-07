// Individual Dogfile Pro utilities. Each command is listed separately in Tools so it is easy to discover.
import { api, basename, dirname, stem, toast, bus, h, fileUrl } from './core.js';
import { prompt, modal } from './dialogs.js';
import { ensureModels, call } from './ai.js';
import { requirePro } from './license.js';

const PDF_FILTER = [{ name: 'PDF documents', extensions: ['pdf'] }];
const IMAGE_FILTER = [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] }];
const VIDEO_FILTER = [{ name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mpeg', 'mpg'] }];
const TEXT_FILTER = [{ name: 'Text and code files', extensions: ['json', 'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'xml', 'svg'] }];
const pick = async (title, filters, multiple = false) => (await api('dialog:openFiles', { title, filters, multiple })) || [];
const save = async (title, name, ext, filter) => api('dialog:saveFile', { title, defaultPath: name, filters: filter || [{ name: ext.toUpperCase(), extensions: [ext] }] });
// every Pro tool here is the same feature; the literal call below is what build/test-renderer.mjs looks for
const pro = async () => { if (!requirePro('proUtilities')) return false; try { await api('pro:authorize'); return true; } catch (e) { toast(e.message || String(e), { error: true }); return false; } };
const writeBytes = async (path, bytes) => {
  let bin = '';
  const CHUNK = 0x6000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  const b64 = btoa(bin), STEP = 512 * 1024;
  for (let i = 0; i < b64.length; i += STEP) await api('fs:writePart', path, b64.slice(i, i + STEP), i > 0);
  await api('fs:finishPart', path);
};
const readBytes = async (path) => {
  const r = await api('fs:readBuffer', path, 256 * 1024 * 1024);
  const b = atob(r.data), out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

// `given`: files already chosen (the selection); the picker opens only when there are none
export async function compressImages(given = []) {
  if (!(await pro('proUtilities'))) return;
  const files = given.length ? given : await pick('Choose pictures to compress', IMAGE_FILTER, true);
  if (!files.length) return;
  const fmt = (await prompt('Image compression', 'webp', { label: 'Output format: webp, jpg or png' }))?.trim().toLowerCase();
  if (!fmt) return;
  if (!['webp', 'jpg', 'jpeg', 'png'].includes(fmt)) return toast('Choose WebP, JPG or PNG', { error: true });
  const q = Number(await prompt('Image quality', '82', { label: 'Quality from 1 to 100 (JPG/WebP)' }));
  const quality = Number.isFinite(q) ? Math.max(1, Math.min(100, Math.round(q))) : 82;
  let done = 0;
  for (const src of files) {
    try {
      const ext = fmt === 'jpeg' ? 'jpg' : fmt;
      const out = await api('fs:uniqueName', dirname(src), `${stem(basename(src))} (compressed).${ext}`, 'number');
      const r = await api('media:processImage', { src, out, format: ext, quality });
      done++;
      toast(`${basename(src)} → ${Math.round(r.bytes / 1024)} KB`);
    } catch (e) { toast(`${basename(src)}: ${e.message || e}`, { error: true }); }
  }
  if (done) { toast(`Compressed ${done} picture${done === 1 ? '' : 's'}`); bus.emit('refreshPanes'); }
}

export async function upscaleImages(given = []) {
  if (!(await pro('proUtilities'))) return;
  const files = given.length ? given : await pick('Choose pictures to upscale', IMAGE_FILTER, true);
  if (!files.length) return;
  const n = Number(await prompt('Upscale pictures', '4000', { label: 'Target longest edge in pixels (up to 20,000)' }));
  if (!Number.isFinite(n) || n < 2 || n > 20000) return toast('Enter a target between 2 and 20,000 pixels', { error: true });
  let done = 0;
  for (const src of files) {
    try {
      const ext = 'png';
      const out = await api('fs:uniqueName', dirname(src), `${stem(basename(src))} (${Math.round(n)}px).${ext}`, 'number');
      await api('media:processImage', { src, out, format: ext, maxSide: Math.round(n), upscaleOnly: true });
      done++;
    } catch (e) { toast(`${basename(src)}: ${e.message || e}`, { error: true }); }
  }
  if (done) { toast(`Upscaled ${done} picture${done === 1 ? '' : 's'} using high-quality Lanczos resampling`); bus.emit('refreshPanes'); }
}

export async function makeGif(given = []) {
  if (!(await pro('proUtilities'))) return;
  const files = given.length >= 2 ? given : await pick('Choose pictures in animation order', IMAGE_FILTER, true);
  if (files.length < 2) return toast('Choose at least two pictures', { error: true });
  const delay = Number(await prompt('GIF frame duration', '120', { label: 'Milliseconds per picture (20–5000)' }));
  if (!Number.isFinite(delay) || delay < 20 || delay > 5000) return toast('Enter a frame duration from 20 to 5000 ms', { error: true });
  const out = await save('Save animated GIF', `${stem(basename(files[0]))}.gif`, 'gif');
  if (!out) return;
  try {
    const r = await api('media:createGif', { inputs: files, out, delayMs: Math.round(delay) });
    toast(`Created GIF · ${r.frames} frames`); bus.emit('refreshPanes');
  } catch (e) { toast(e.message || String(e), { error: true }); }
}

export async function extractAudio(given = []) {
  if (!(await pro('proUtilities'))) return;
  const files = given.length ? given : await pick('Choose videos to extract audio from', VIDEO_FILTER, true);
  if (!files.length) return;
  const { convertMedia } = await import('./mediatools.js');
  await convertMedia(files, 'mp3', { audioOnly: true, bitrate: 192 });
}

// `given`: PDFs already chosen (selected in the folder, or the one that is open); more are asked for when there is only one
export async function mergePdfs(given = []) {
  if (!(await pro('proUtilities'))) return;
  let files = [...given];
  if (files.length < 2) files = [...files, ...(await pick(files.length ? `Choose the PDFs to add after “${basename(files[0])}”` : 'Choose PDFs to merge (in order)', PDF_FILTER, true))];
  if (files.length < 2) return toast('Choose at least two PDF files', { error: true });
  try {
    const { PDFLib } = await import('../vendor/office.js');
    const out = await PDFLib.PDFDocument.create();
    for (const path of files) {
      const src = await PDFLib.PDFDocument.load(await readBytes(path), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const page of pages) out.addPage(page);
    }
    const dest = await save('Save merged PDF', `${stem(basename(files[0]))} (merged).pdf`, 'pdf', PDF_FILTER);
    if (!dest) return;
    await writeBytes(dest, await out.save());
    toast(`Merged ${files.length} PDFs`); bus.emit('refreshPanes');
  } catch (e) { toast(`Couldn’t merge PDFs: ${e.message || e}`, { error: true }); }
}

export async function splitPdf(given = null) {
  if (!(await pro('proUtilities'))) return;
  const path = given || (await pick('Choose a PDF to split', PDF_FILTER))[0];
  if (!path) return;
  try {
    const { PDFLib } = await import('../vendor/office.js');
    const src = await PDFLib.PDFDocument.load(await readBytes(path), { ignoreEncryption: true });
    const count = src.getPageCount();
    const ranges = await prompt('Split PDF', `1-${count}`, { label: `Pages to extract (e.g. 1, 3-5, 8). This creates one PDF per selected page.` });
    if (!ranges) return;
    const pages = new Set();
    for (const part of ranges.split(',')) {
      const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) return toast(`Invalid page range: ${part}`, { error: true });
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a < 1 || b < a || b > count) return toast(`Page range must be between 1 and ${count}`, { error: true });
      for (let i = a; i <= b; i++) pages.add(i - 1);
    }
    const dir = await api('dialog:pickFolder', 'Choose a folder for the split pages');
    if (!dir) return;
    for (const index of [...pages].sort((a, b) => a - b)) {
      const one = await PDFLib.PDFDocument.create();
      const [page] = await one.copyPages(src, [index]); one.addPage(page);
      const dest = await api('fs:uniqueName', dir, `${stem(basename(path))} - page ${index + 1}.pdf`, 'number');
      await writeBytes(dest, await one.save());
    }
    toast(`Saved ${pages.size} PDF page${pages.size === 1 ? '' : 's'}`); bus.emit('refreshPanes');
  } catch (e) { toast(`Couldn’t split PDF: ${e.message || e}`, { error: true }); }
}

export async function minifyCode(given = null) {
  if (!(await pro('proUtilities'))) return;
  const path = given || (await pick('Choose a code or data file to minify', TEXT_FILTER))[0];
  if (!path) return;
  const ext = (path.split('.').pop() || '').toLowerCase();
  try {
    const read = await api('fs:readText', path, 8 * 1024 * 1024);
    const raw = read?.text ?? '';
    if (read?.truncated) return toast('This file is larger than the 8 MB minifier limit', { error: true });
    let min;
    if (ext === 'json') min = JSON.stringify(JSON.parse(raw));
    else if (['css', 'svg'].includes(ext)) min = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*([{}:;,>])\s*/g, '$1').replace(/;}/g, '}').trim();
    else if (['html', 'htm', 'xml'].includes(ext)) min = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/[\t\r\n ]+/g, ' ').trim();
    else return toast('Safe minification is currently available for JSON, CSS, HTML, XML and SVG. JavaScript minification needs a dedicated parser.', { error: true });
    const out = await api('fs:uniqueName', dirname(path), `${stem(basename(path))}.min.${ext}`, 'number');
    await api('fs:writeEncoded', out, min, 'utf8');
    toast(`Minified copy saved: ${basename(out)}`); bus.emit('refreshPanes');
  } catch (e) { toast(`Couldn’t minify: ${e.message || e}`, { error: true }); }
}


// General-purpose local AI background removal. The image and mask stay on this PC.
export async function removeImageBackground(given = []) {
  if (!(await pro('proUtilities'))) return;
  const files = given.length ? given : await pick('Choose pictures for background removal', IMAGE_FILTER, true);
  if (!files.length) return;
  if (!(await ensureModels(['removebg']))) return;
  let done = 0;
  for (const src of files) {
    try {
      const mask = await call({ type: 'removeBackground', url: fileUrl(src) });
      const img = new Image(); img.decoding = 'async'; img.src = fileUrl(src);
      await img.decode();
      const w = img.naturalWidth, hh = img.naturalHeight;
      if (!w || !hh) throw new Error('Could not read the source image dimensions.');
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, hh);
      const frame = ctx.getImageData(0, 0, w, hh), pixels = frame.data;
      const md = mask.data, mw = mask.width, mh = mask.height;
      const channels = Math.max(1, Math.round(md.length / (mw * mh)));
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < mw * mh; i++) { const v = Number(md[i * channels]); if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo;
      for (let y = 0; y < hh; y++) {
        const my = Math.min(mh - 1, Math.floor((y / hh) * mh));
        for (let x = 0; x < w; x++) {
          const mx = Math.min(mw - 1, Math.floor((x / w) * mw));
          const v = Number(md[(my * mw + mx) * channels]);
          pixels[(y * w + x) * 4 + 3] = span > 0 ? Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255))) : 255;
        }
      }
      ctx.putImageData(frame, 0, 0);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Could not encode the transparent PNG.')), 'image/png'));
      const out = await api('fs:uniqueName', dirname(src), `${stem(basename(src))} (no background).png`, 'number');
      await writeBytes(out, new Uint8Array(await blob.arrayBuffer()));
      done++;
    } catch (e) { toast(`${basename(src)}: ${e.message || e}`, { error: true }); }
  }
  if (done) { toast(`Removed backgrounds from ${done} picture${done === 1 ? '' : 's'} · saved transparent PNG copies`); bus.emit('refreshPanes'); }
}

const TRANSLATION_LANGUAGES = [
  ['en', 'English'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['fr', 'French'], ['es', 'Spanish'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi'],
  ['tr', 'Turkish'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['fa', 'Persian'], ['ur', 'Urdu'],
  ['vi', 'Vietnamese'], ['th', 'Thai'], ['id', 'Indonesian'], ['ms', 'Malay'], ['sv', 'Swedish'], ['no', 'Norwegian'],
  ['da', 'Danish'], ['fi', 'Finnish'], ['cs', 'Czech'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['el', 'Greek'],
  ['he', 'Hebrew'], ['sw', 'Swahili'], ['ta', 'Tamil'], ['bn', 'Bengali'], ['tl', 'Filipino / Tagalog'], ['ca', 'Catalan'],
  ['hr', 'Croatian'], ['sk', 'Slovak'], ['bg', 'Bulgarian'], ['sr', 'Serbian'], ['sl', 'Slovenian'], ['et', 'Estonian'],
  ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['af', 'Afrikaans'], ['az', 'Azerbaijani'], ['kk', 'Kazakh'], ['uz', 'Uzbek'],
];
const languageSelect = (value) => h('select', { class: 'input' }, ...TRANSLATION_LANGUAGES.map(([code, name]) => h('option', { value: code, selected: code === value }, name)));

export async function translateText() {
  if (!(await pro('proUtilities'))) return;
  const source = h('textarea', { class: 'input', rows: 7, placeholder: 'Type or paste text to translate…', spellcheck: 'true' });
  const target = h('textarea', { class: 'input', rows: 7, readonly: true, placeholder: 'Your translation will appear here.' });
  const from = languageSelect('en'), to = languageSelect('es');
  const status = h('div', { class: 'hint' }, 'Runs locally on your PC. The first use downloads the translation model (about 650 MB).');
  const swap = h('button', { class: 'btn small', type: 'button', onclick: () => { const v = from.value; from.value = to.value; to.value = v; } }, 'Swap languages');
  const loadFile = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    const [path] = await pick('Open a text file to translate', [{ name: 'Text documents', extensions: ['txt', 'md', 'csv', 'json', 'html', 'xml'] }]);
    if (!path) return;
    try { const r = await api('fs:readText', path, 1024 * 1024); if (r?.truncated) throw new Error('This file is larger than 1 MB.'); source.value = r?.text || ''; }
    catch (e) { toast(e.message || String(e), { error: true }); }
  } }, 'Open text file…');
  const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    if (!target.value) return;
    try { await navigator.clipboard.writeText(target.value); toast('Translation copied'); }
    catch { target.focus(); target.select(); toast('Select the translation and copy it.'); }
  } }, 'Copy translation');
  const body = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { gap: '8px', alignItems: 'end' } }, h('div', { class: 'grow' }, h('div', { class: 'field-label' }, 'From'), from), h('div', { class: 'grow' }, h('div', { class: 'field-label' }, 'To'), to), swap),
    h('div', { class: 'row', style: { gap: '8px' } }, loadFile),
    h('div', {}, h('div', { class: 'field-label' }, 'Original text'), source),
    h('div', {}, h('div', { class: 'field-label' }, 'Translation'), target),
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } }, status, copy));
  await modal({ title: 'Translate text', width: 760, className: 'translate-modal', body, buttons: [
    { label: 'Close', value: null },
    { label: 'Translate', primary: true, run: async () => {
      const text = source.value.trim();
      if (!text) { status.textContent = 'Enter or open some text first.'; return false; }
      if (text.length > 12000) { status.textContent = 'Please keep each translation under 12,000 characters.'; return false; }
      if (from.value === to.value) { target.value = text; status.textContent = 'Source and target languages are the same.'; return false; }
      status.textContent = 'Preparing the offline translation model…';
      if (!(await ensureModels(['translate']))) { status.textContent = 'Model download was cancelled or failed. You can try again.'; return false; }
      try {
        const paragraphs = text.split(/(\n\s*\n)/);
        const chunks = [];
        for (const part of paragraphs) {
          if (/^\n\s*\n$/.test(part) || part.length <= 1100) { chunks.push(part); continue; }
          const sentences = part.match(/[^.!?。！？]+[.!?。！？]?\s*/g) || [part];
          let chunk = '';
          for (const sentence of sentences) {
            if (chunk && (chunk.length + sentence.length > 1100)) { chunks.push(chunk); chunk = ''; }
            chunk += sentence;
          }
          if (chunk) chunks.push(chunk);
        }
        const translated = [];
        let count = 0;
        for (const chunk of chunks) {
          if (!chunk.trim()) { translated.push(chunk); continue; }
          translated.push(await call({ type: 'translate', text: chunk, srcLang: from.value, tgtLang: to.value }));
          count++;
          status.textContent = `Translating locally… ${count} of ${chunks.filter((x) => x.trim()).length}`;
        }
        target.value = translated.join('');
        status.textContent = 'Translation complete. Your text stayed on this PC.';
      } catch (e) { status.textContent = `Translation failed: ${e.message || e}`; }
      return false;
    } },
  ] });
}
