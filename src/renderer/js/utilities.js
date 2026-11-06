// Contextual generators and media actions, opened from their native Dogfile locations.
import { api, h, state, toast, basename, dirname, isVirtual, fileUrl } from './core.js';
import { modal } from './dialogs.js';
import { activeTab } from './pane.js';

const $ = (tag, attrs = {}, ...children) => h(tag, attrs, ...children);
const field = (label, control, hint = '') => $('label', { class: 'util-field' },
  $('span', { class: 'util-label' }, label), control, hint ? $('span', { class: 'hint' }, hint) : null);
const btn = (label, run, primary = false) => $('button', { class: `btn${primary ? ' primary' : ''}`, onclick: run }, label);
const setStatus = (el, text, error = false) => { el.textContent = text; el.classList.toggle('util-error', error); };
const activeFolder = () => {
  const t = activeTab();
  return t?.path && !isVirtual(t.path) ? t.path : '';
};
const savePath = async (title, defaultPath, ext, label) => api('dialog:saveFile', {
  title, defaultPath, filters: [{ name: label, extensions: [ext] }],
});

async function imageToPng(svg, size = 512) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

function csvRows(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => v !== '') || !rows.length) rows.push(row);
  return rows;
}
function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => [...first].filter((c) => c === ch).length;
  const delimiter = count('\t') > count(',') ? '\t' : ',';
  const rows = csvRows(text.replace(/^\uFEFF/, ''), delimiter).filter((r) => r.some((v) => v.trim() !== ''));
  if (!rows.length) return [];
  const headers = [];
  const used = new Set();
  rows[0].forEach((raw, i) => {
    let name = raw.trim() || `column_${i + 1}`, base = name, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name); headers.push(name);
  });
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ''])));
}
function extractPalette(img, limit = 8) {
  const c = document.createElement('canvas'), size = 96;
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size).data, buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) || [0, 0, 0, 0];
    b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
    buckets.set(key, b);
  }
  const sorted = [...buckets.values()].sort((a, b) => b[3] - a[3]).map((b) => b.slice(0, 3).map((v) => v / b[3]));
  const out = [];
  for (const color of sorted) {
    if (out.every((o) => Math.hypot(o[0] - color[0], o[1] - color[1], o[2] - color[2]) > 42)) out.push(color);
    if (out.length >= limit) break;
  }
  return out.map((rgb) => ({ rgb: rgb.map((v) => Math.round(v)), hex: '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') }));
}
function drawCover(title, subtitle) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 800;
  const c = canvas.getContext('2d');
  const grad = c.createLinearGradient(0, 800, 1200, 0);
  grad.addColorStop(0, '#101b32'); grad.addColorStop(.55, '#273f63'); grad.addColorStop(1, '#816b9c');
  c.fillStyle = grad; c.fillRect(0, 0, 1200, 800);
  c.globalAlpha = .14; c.strokeStyle = '#fff'; c.lineWidth = 2;
  for (let i = -800; i < 1600; i += 70) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 800, 800); c.stroke(); }
  c.globalAlpha = .12; c.fillStyle = '#fff';
  [[980,150,180],[1040,650,250],[180,700,170]].forEach(([x,y,r]) => { c.beginPath(); c.arc(x,y,r,0,Math.PI*2); c.fill(); });
  c.globalAlpha = 1;
  // simple folder mark
  c.fillStyle = 'rgba(255,255,255,.9)';
  c.beginPath(); c.moveTo(110,180); c.lineTo(300,180); c.lineTo(350,230); c.lineTo(520,230); c.lineTo(520,390); c.lineTo(110,390); c.closePath(); c.fill();
  c.fillStyle = 'rgba(255,255,255,.17)';
  c.beginPath(); c.roundRect(110,250,410,240,26); c.fill();
  c.fillStyle = '#fff'; c.font = '600 24px Inter, Segoe UI, sans-serif'; c.fillText('DOGFILE  /  COLLECTION', 110, 565);
  c.font = '700 68px Inter, Segoe UI, sans-serif';
  const safeTitle = String(title || 'My Collection').slice(0, 34);
  c.fillText(safeTitle, 110, 650, 960);
  c.font = '400 28px Inter, Segoe UI, sans-serif'; c.globalAlpha = .85;
  c.fillText(String(subtitle || 'A place for the things that matter').slice(0, 70), 114, 710, 950);
  return canvas.toDataURL('image/png');
}

export function openUtilities(kind = 'all', options = {}) {
  const body = $('div', { class: 'util-hub' });
  const include = (name) => kind === 'all' || kind === name;
  if (kind === 'all') body.append($('p', { class: 'hint' }, 'Small, offline-first tools for everyday file work. Generated files are saved locally.'));

  // QR code
  const qrCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '▦'), $('div', {}, $('b', {}, 'QR code to PNG'), $('div', { class: 'hint' }, 'Turn text, a URL, or contact details into a shareable QR image.'))));
  const qrInput = $('textarea', { class: 'input util-area', rows: 3, placeholder: 'https://example.com' });
  const qrPreview = $('div', { class: 'util-preview' }, $('span', { class: 'hint' }, 'Your QR code will appear here'));
  const qrStatus = $('div', { class: 'hint util-status' });
  let qrPng = null;
  qrCard.append(field('Content', qrInput), $('div', { class: 'util-actions' },
    btn('Generate QR', async () => {
      const value = qrInput.value.trim();
      if (!value) return setStatus(qrStatus, 'Enter something to encode.', true);
      try {
        setStatus(qrStatus, 'Generating…');
        const svg = await api('util:qrSvg', value);
        qrPng = await imageToPng(svg, 640);
        qrPreview.innerHTML = '';
        const img = $('img', { class: 'util-qr-img', src: qrPng, alt: 'Generated QR code' });
        qrPreview.append(img);
        setStatus(qrStatus, 'Ready · 640 × 640 PNG');
      } catch (e) { setStatus(qrStatus, e.message || String(e), true); }
    }, true),
    btn('Save PNG', async () => {
      if (!qrPng) return setStatus(qrStatus, 'Generate a QR code first.', true);
      const path = await savePath('Save QR code', 'qr-code.png', 'png', 'PNG image');
      if (path) { await api('fs:writeDataUrl', path, qrPng); setStatus(qrStatus, `Saved ${basename(path)}`); }
    })),
    qrPreview, qrStatus);
  if (include('qr')) body.append(qrCard);

  // Palette extractor
  const paletteCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '◉'), $('div', {}, $('b', {}, 'Image color palette'), $('div', { class: 'hint' }, 'Extract a larger palette with HEX and RGB values.'))));
  const palPreview = $('div', { class: 'util-palette' }, $('span', { class: 'hint' }, 'Choose an image to extract its colors'));
  const palStatus = $('div', { class: 'hint util-status' });
  let palette = [];
  const loadPalette = async (path) => {
    if (!path) return;
    try {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = fileUrl(path); });
      palette = extractPalette(img);
      palPreview.innerHTML = '';
      palette.forEach((p) => palPreview.append($('button', { class: 'util-swatch', title: `Copy ${p.hex}`, style: { background: p.hex }, onclick: async () => { await api('clip:writeText', p.hex); toast(`Copied ${p.hex}`); } }, $('span', {}, p.hex), $('small', {}, p.rgb.join(', ')))));
      setStatus(palStatus, `${basename(path)} · ${palette.length} colors · click a swatch to copy HEX`);
    } catch (e) { setStatus(palStatus, `Couldn’t read that image: ${e.message || e}`, true); }
  };
  paletteCard.append($('div', { class: 'util-actions' },
    btn('Choose image', async () => {
      const files = await api('dialog:openFiles', { title: 'Choose an image', filters: [{ name: 'Pictures', extensions: ['png','jpg','jpeg','webp','bmp','gif','tif','tiff','avif','ico'] }] });
      await loadPalette(files?.[0]);
    }, true),
    btn('Copy palette', async () => {
      if (!palette.length) return setStatus(palStatus, 'Choose an image first.', true);
      await api('clip:writeText', palette.map((p) => `${p.hex}  RGB(${p.rgb.join(', ')})`).join('\n'));
      setStatus(palStatus, 'Palette copied to clipboard.');
    }),
    btn('Save .txt', async () => {
      if (!palette.length) return setStatus(palStatus, 'Choose an image first.', true);
      const path = await savePath('Save color palette', 'image-palette.txt', 'txt', 'Text file');
      if (path) { await api('fs:writeText', path, palette.map((p) => `${p.hex}  RGB(${p.rgb.join(', ')})`).join('\n')); setStatus(palStatus, `Saved ${basename(path)}`); }
    })),
    palPreview, palStatus);
  if (include('palette')) { body.append(paletteCard); if (options.path) setTimeout(() => loadPalette(options.path), 0); }

  // Exact-size file generator
  const sizeCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '▤'), $('div', {}, $('b', {}, 'Exact-size blank file'), $('div', { class: 'hint' }, 'Create zero-filled test files up to 1 GiB.'))));
  const sizeName = $('input', { class: 'input', value: 'test-file.bin', placeholder: 'test-file.bin' });
  const sizeBytes = $('input', { class: 'input', type: 'number', min: '0', max: String(1024 ** 3), value: '1048576' });
  const sizeStatus = $('div', { class: 'hint util-status' });
  sizeCard.append(field('File name', sizeName), field('Size in bytes', sizeBytes, '1 MiB = 1,048,576 bytes · maximum 1 GiB'), $('div', { class: 'util-actions' },
    btn('Create in current folder', async () => {
      const folder = options.folder || activeFolder(), name = sizeName.value.trim(), bytes = Number(sizeBytes.value);
      if (!folder) return setStatus(sizeStatus, 'Open a real folder in Dogfile first.', true);
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return setStatus(sizeStatus, 'Enter a file name, not a path.', true);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 ** 3) return setStatus(sizeStatus, 'Enter a whole number from 0 to 1,073,741,824.', true);
      try {
        const path = await api('fs:uniqueName', folder, name, 'number');
        const result = await api('fs:createSized', path, bytes);
        setStatus(sizeStatus, `Created ${basename(result.path)} · ${Number(result.size).toLocaleString()} bytes`);
      } catch (e) { setStatus(sizeStatus, e.message || String(e), true); }
    }, true)), sizeStatus);
  if (include('blank')) body.append(sizeCard);

  // CSV to JSON
  const csvCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '⇄'), $('div', {}, $('b', {}, 'CSV to JSON'), $('div', { class: 'hint' }, 'Use the first row as object keys; quoted commas and newlines are supported.'))));
  const csvStatus = $('div', { class: 'hint util-status' });
  let csvJson = null;
  csvCard.append($('div', { class: 'util-actions' },
    btn('Choose CSV / TSV', async () => {
      const files = await api('dialog:openFiles', { title: 'Choose a CSV or TSV file', filters: [{ name: 'Delimited text', extensions: ['csv','tsv','txt'] }] });
      const path = files?.[0]; if (!path) return;
      try {
        const r = await api('fs:readText', path, 20 * 1024 * 1024);
        csvJson = JSON.stringify(parseCsv(r.text || ''), null, 2);
        setStatus(csvStatus, `Converted ${basename(path)} · ${JSON.parse(csvJson).length} rows`);
      } catch (e) { csvJson = null; setStatus(csvStatus, e.message || String(e), true); }
    }, true),
    btn('Save JSON', async () => {
      if (!csvJson) return setStatus(csvStatus, 'Choose a CSV file first.', true);
      const path = await savePath('Save converted JSON', 'converted.json', 'json', 'JSON file');
      if (path) { await api('fs:writeText', path, csvJson + '\n'); setStatus(csvStatus, `Saved ${basename(path)}`); }
    }),
    btn('Copy JSON', async () => {
      if (!csvJson) return setStatus(csvStatus, 'Choose a CSV file first.', true);
      await api('clip:writeText', csvJson); setStatus(csvStatus, 'JSON copied to clipboard.');
    })), csvStatus);
  if (include('csv')) body.append(csvCard);

  // Lorem Ipsum
  const loremCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '¶'), $('div', {}, $('b', {}, 'Lorem Ipsum'), $('div', { class: 'hint' }, 'Generate placeholder copy and copy it in one click.'))));
  const loremCount = $('input', { class: 'input', type: 'number', min: '10', max: '2000', value: '120' });
  const loremOutput = $('textarea', { class: 'input util-area', rows: 4, placeholder: 'Generated text appears here' });
  const loremStatus = $('div', { class: 'hint util-status' });
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit voluptate velit esse cillum dolore eu fugiat nulla pariatur'.split(' ');
  loremCard.append(field('Word count', loremCount, '10–2,000 words'), $('div', { class: 'util-actions' },
    btn('Generate', () => {
      const n = Math.max(10, Math.min(2000, Math.floor(Number(loremCount.value) || 120)));
      const out = Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ');
      loremOutput.value = out.charAt(0).toUpperCase() + out.slice(1) + '.';
      setStatus(loremStatus, `${n} words generated.`);
    }, true),
    btn('Copy text', async () => { if (!loremOutput.value) return setStatus(loremStatus, 'Generate text first.', true); await api('clip:writeText', loremOutput.value); setStatus(loremStatus, 'Copied to clipboard.'); })),
    loremOutput, loremStatus);
  if (include('lorem')) body.append(loremCard);

  // Folder cover artwork
  const coverCard = $('section', { class: 'util-card' },
    $('div', { class: 'util-card-head' }, $('span', { class: 'util-icon' }, '▣'), $('div', {}, $('b', {}, 'Folder cover artwork'), $('div', { class: 'hint' }, 'Create a polished 1200 × 800 cover image and save it inside a folder.'))));
  const initialFolder = options.folder || (options.path ? dirname(options.path) : activeFolder());
  const coverFolder = $('input', { class: 'input', value: initialFolder, placeholder: 'Choose a folder…', readonly: true });
  const coverTitle = $('input', { class: 'input', value: initialFolder ? basename(initialFolder) : 'My Collection' });
  const coverSub = $('input', { class: 'input', value: 'A place for the things that matter' });
  const coverPreview = $('div', { class: 'util-cover-preview' });
  const coverStatus = $('div', { class: 'hint util-status' });
  let coverPng = null;
  const renderCover = () => { coverPng = drawCover(coverTitle.value, coverSub.value); coverPreview.innerHTML = ''; coverPreview.append($('img', { src: coverPng, alt: 'Folder cover artwork preview' })); };
  coverCard.append(field('Destination folder', $('div', { class: 'util-actions' }, coverFolder, btn('Choose…', async () => {
    const folder = await api('dialog:pickFolder', 'Choose a folder for the cover artwork');
    if (folder) { coverFolder.value = folder; if (!coverTitle.value || coverTitle.value === 'My Collection') coverTitle.value = basename(folder); renderCover(); }
  }))),
    field('Cover title', coverTitle), field('Subtitle', coverSub),
    $('div', { class: 'util-actions' }, btn('Preview', renderCover), btn('Save cover.png', async () => {
      if (!coverFolder.value) return setStatus(coverStatus, 'Choose a destination folder.', true);
      renderCover();
      try {
        const target = await api('fs:uniqueName', coverFolder.value, 'folder-cover.png', 'number');
        await api('fs:writeDataUrl', target, coverPng);
        setStatus(coverStatus, `Saved ${basename(target)} in the selected folder.`);
      } catch (e) { setStatus(coverStatus, e.message || String(e), true); }
    }, true)),
    coverPreview, coverStatus);
  if (include('cover')) body.append(coverCard);
  renderCover();

  const titles = { all: 'Tools', qr: 'QR code generator', palette: 'Image color palette', blank: 'Create blank file', csv: 'CSV / TSV to JSON', lorem: 'Lorem Ipsum generator', cover: 'Folder cover artwork' };
  return modal({ title: titles[kind] || 'Tools', body, width: kind === 'all' ? 900 : 620, className: 'util-modal', buttons: [{ label: 'Close', value: true }] });
}
