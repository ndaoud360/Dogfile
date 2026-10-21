// Dogfile Photos: fast photo viewer with a queue, slideshow and fullscreen, plus a basic editor
// (adjustments, filter presets, crop, rotate/flip, draw & text, resize) that saves as a copy or overwrites.
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, debounce, KINDS, natCmp, fileUrl, fmtSize, fmtDate } from './core.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { modal, confirm, prompt } from './dialogs.js';
import { applyColors, mediaSettings } from './theme.js';
function applyMediaTheme() {
  const dark = applyColors(mediaSettings(settings));
  if (!EMBED && sys?.platform === 'win32') api('win:overlay', dark ? { color: '#101012', symbolColor: '#c9cacc' } : { color: getComputedStyle(document.documentElement).getPropertyValue('--tabbar').trim() || '#efeff0', symbolColor: '#3a3a3a' });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyMediaTheme());
import { readExif } from './exif.js';
import { EMBED, pendingFiles, onHost, tellHost, showInFiles, setTitle } from './embed.js';

const $ = (id) => document.getElementById(id);
const NATIVE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'apng']);
const IMAGE_EXT = new Set([...KINDS.image, 'heif', 'jxl', 'tga', 'dds', 'exr', 'hdr', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef']);
const isImage = (p) => IMAGE_EXT.has((p.split('.').pop() || '').toLowerCase());
let sys = {}, settings = { ...DEFAULT_SETTINGS };
const V = { list: [], idx: -1, zoom: 'fit', scale: 1, rot: 0, flipH: false, flipV: false, panX: 0, panY: 0, nat: { w: 0, h: 0 }, layer: 'a', slideshow: false, timer: null, shuffle: false, showQueue: true, showInfo: false, seq: 0 };
let E = null; // editor state

// ---------------- loading ----------------
const bust = new Map(); // path -> stamp, so an overwritten file is not served from cache
async function srcFor(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const b = bust.has(p) ? `&b=${bust.get(p)}` : '';
  if (NATIVE.has(ext)) return fileUrl(p) + b;
  if (sys.platform === 'win32') { const t = await api('thumb:get', p, 2560).catch(() => null); if (t) return t; }
  return `/media/still?p=${encodeURIComponent(p)}${b}`;
}
async function show(i, { fade = false } = {}) {
  if (!V.list.length) { $('vw-empty').style.display = ''; return; }
  if (E && E.dirty && !(await confirm('Discard edits?', 'You have unsaved edits. Leave the editor and discard them?', { ok: 'Discard', danger: true }))) return;
  if (E) exitEdit(true);
  clearOcr();
  i = (i + V.list.length) % V.list.length;
  V.idx = i;
  const it = V.list[i];
  const seq = ++V.seq;
  $('vw-empty').style.display = 'none';
  setTitle(`${it.name} - Dogfile Photos`);
  $('vw-name').textContent = it.name;
  $('vw-count').textContent = `${i + 1} / ${V.list.length}`;
  const next = V.layer === 'a' ? $('img-b') : $('img-a');
  const cur = V.layer === 'a' ? $('img-a') : $('img-b');
  const src = await srcFor(it.path);
  if (seq !== V.seq) return;
  next.classList.add('no-anim');
  next.style.opacity = '0';
  next.onload = () => {
    if (seq !== V.seq) return;
    V.nat = { w: next.naturalWidth, h: next.naturalHeight };
    V.rot = 0; V.flipH = V.flipV = false; V.panX = V.panY = 0; V.zoom = 'fit';
    V.layer = V.layer === 'a' ? 'b' : 'a';
    layout();
    requestAnimationFrame(() => {
      next.classList.toggle('no-anim', !fade); cur.classList.toggle('no-anim', !fade);
      next.style.opacity = '1'; cur.style.opacity = '0';
    });
    renderInfo(); renderQueue(); preload();
    tellHost({ type: 'state', kind: 'photo' });
  };
  next.onerror = () => { if (seq === V.seq) osd(`Can't show ${it.name}`); };
  next.src = src;
}
function preload() { for (const d of [1, -1]) { const it = V.list[(V.idx + d + V.list.length) % V.list.length]; if (it) srcFor(it.path).then((s) => { const im = new Image(); im.src = s; }); } }
const curImg = () => (V.layer === 'a' ? $('img-a') : $('img-b'));

// ---------------- view transform (zoom / pan / rotate / flip) ----------------
function fitScale() {
  const st = $('vw-stage');
  const rotated = V.rot % 180 !== 0;
  const w = rotated ? V.nat.h : V.nat.w, hh = rotated ? V.nat.w : V.nat.h;
  if (!w || !hh) return 1;
  return Math.min(1, (st.clientWidth - 40) / w, (st.clientHeight - 40) / hh);
}
function layout() {
  V.scale = V.zoom === 'fit' ? fitScale() : V.zoom;
  for (const im of [$('img-a'), $('img-b')]) {
    if (im !== curImg() && !E) continue;
    im.style.width = V.nat.w + 'px'; im.style.height = V.nat.h + 'px';
    im.style.transform = `translate(-50%, -50%) translate(${V.panX}px, ${V.panY}px) rotate(${V.rot}deg) scale(${V.scale * (V.flipH ? -1 : 1)}, ${V.scale * (V.flipV ? -1 : 1)})`;
  }
  $('vw-stage').classList.toggle('zoomed', V.zoom !== 'fit' && V.scale > fitScale() + 0.001);
  const ol = $('vw-ocr');
  if (ol) { ol.style.width = V.nat.w + 'px'; ol.style.height = V.nat.h + 'px'; ol.style.transform = curImg().style.transform; }
  renderBar();
}

// ---------------- OCR: select and copy the text in a photo or screenshot (Tesseract, runs offline) ----------------
let ocrWorker = null, OCR = null;
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  const mod = await import('../vendor/tesseract/tesseract.esm.min.js');
  const createWorker = mod.createWorker || mod.default.createWorker;
  const base = new URL('../vendor/tesseract/', import.meta.url).href;
  ocrWorker = await createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', workerBlobURL: false, gzip: true, cacheMethod: 'none' });
  return ocrWorker;
}
function clearOcr() { OCR = null; $('vw-ocr')?.remove(); document.body.classList.remove('ocr-on'); $('vw-ocr-panel')?.remove(); }
async function runOcr() {
  const it = V.list[V.idx];
  if (!it || !V.nat.w) return;
  if (OCR && OCR.path === it.path) { clearOcr(); renderBar(); return; }
  clearOcr();
  osd('Reading text…');
  document.body.classList.add('ocr-busy');
  try {
    const c = document.createElement('canvas'); c.width = V.nat.w; c.height = V.nat.h;
    c.getContext('2d').drawImage(curImg(), 0, 0);
    const w = await getOcr();
    const { data } = await w.recognize(c.toDataURL('image/png'), {}, { text: true, blocks: true });
    if (V.list[V.idx] !== it) return;
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) { for (const wd of l.words || []) if (wd.confidence > 35 && wd.text.trim()) words.push(wd); words.push({ br: true }); }
    const text = (data.text || '').trim();
    OCR = { path: it.path, text };
    if (!text) { osd('No text found'); return; }
    // invisible, selectable words laid exactly over the photo
    const layer = h('div', { id: 'vw-ocr' });
    for (const wd of words) {
      if (wd.br) { layer.append(document.createElement('br')); continue; }
      const { x0, y0, x1, y1 } = wd.bbox;
      const sp = h('span', { class: 'ocr-w', style: { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px', fontSize: Math.max(6, (y1 - y0) * 0.9) + 'px' } }, wd.text + ' ');
      layer.append(sp);
    }
    $('vw-layers').append(layer);
    document.body.classList.add('ocr-on');
    const ta = h('textarea', { class: 'ocr-text', readonly: true, spellcheck: 'false' }); ta.value = text;
    const panel = h('div', { id: 'vw-ocr-panel', class: 'vw-panel show' },
      h('div', { class: 'ocr-head' }, h('b', {}, 'Text in this image'), h('button', { class: 'icon-btn small', title: 'Close', html: icon('close'), onclick: () => { clearOcr(); renderBar(); } })),
      ta, h('div', { class: 'row-inline' }, h('button', { class: 'btn small primary', onclick: () => { api('clip:writeText', text); toast('Text copied'); } }, 'Copy all'),
        h('button', { class: 'btn small', onclick: async () => { const dir = it.path.replace(/[\\/][^\\/]*$/, ''); const out = await api('fs:uniqueName', dir, it.name.replace(/\.[^.]+$/, '') + ' (text).txt', 'number'); await api('fs:writeText', out, text); toast('Saved ' + out.split(/[\\/]/).pop()); } }, 'Save as .txt')),
      h('div', { class: 'hint' }, 'You can also drag across the photo to select words, then Ctrl+C.'));
    $('vw-stage').append(panel);
    layout();
    osd(`${words.filter((x) => !x.br).length} words found`);
  } catch (e) { toast(`Couldn’t read text: ${e.message}`, { error: true }); }
  finally { document.body.classList.remove('ocr-busy'); renderBar(); }
}
function setZoom(z, cx, cy) {
  const old = V.scale;
  const nz = Math.max(0.05, Math.min(16, z));
  if (cx != null) { const st = $('vw-stage').getBoundingClientRect(); const dx = cx - (st.left + st.width / 2) - V.panX, dy = cy - (st.top + st.height / 2) - V.panY; V.panX -= dx * (nz / old - 1); V.panY -= dy * (nz / old - 1); }
  V.zoom = nz;
  if (Math.abs(nz - fitScale()) < 0.01) { V.zoom = 'fit'; V.panX = V.panY = 0; }
  layout();
  osd(`${Math.round(nz * 100)}%`);
}
const rotate = (d) => { V.rot = (V.rot + d + 360) % 360; V.panX = V.panY = 0; layout(); };
const flip = () => { V.flipH = !V.flipH; layout(); };

// ---------------- slideshow ----------------
function toggleSlideshow(on = !V.slideshow) {
  V.slideshow = on;
  clearInterval(V.timer);
  if (on) {
    if (!document.fullscreenElement && settings.slideshowFullscreen !== false) document.documentElement.requestFullscreen().catch(() => {});
    V.timer = setInterval(() => show(V.shuffle ? Math.floor(Math.random() * V.list.length) : V.idx + 1, { fade: true }), (settings.slideshowSeconds || 4) * 1000);
    osd(`Slideshow · every ${settings.slideshowSeconds || 4}s`);
  } else osd('Slideshow stopped');
  document.body.classList.toggle('slideshow', on);
  renderBar();
}

// ---------------- queue ----------------
async function setQueue(files, { autoPlaylist = false, append = false, slideshow = false } = {}) {
  files = files.filter(isImage);
  let items = files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  let start = 0;
  if (autoPlaylist && files.length === 1) {
    const dir = files[0].replace(/[\\/][^\\/]*$/, '');
    const r = await api('fs:list', dir).catch(() => ({ items: [] }));
    const sib = (r.items || []).filter((i) => !i.isDir && isImage(i.path)).sort((a, b) => natCmp(a.name, b.name));
    if (sib.length > 1) { items = sib.map((i) => ({ path: i.path, name: i.name })); start = Math.max(0, items.findIndex((i) => i.path === files[0])); }
  }
  if (append) { V.list.push(...items); renderQueue(); if (V.idx < 0) show(0); return; }
  V.list = items;
  renderQueue();
  if (items.length) { await show(start); if (slideshow) toggleSlideshow(true); } else $('vw-empty').style.display = '';
}
const thumbs = new Map();
function renderQueue() {
  $('q-count').textContent = V.list.length ? `${V.idx + 1} / ${V.list.length}` : '';
  const box = $('q-items');
  box.innerHTML = V.list.map((it, i) => `<div class="q-item${i === V.idx ? ' cur' : ''}" data-i="${i}" draggable="true" title="${esc(it.name)}"><img data-p="${esc(it.path)}" alt="" loading="lazy"><span>${esc(it.name)}</span></div>`).join('') || '<div class="hint pad">Drop photos here</div>';
  box.querySelectorAll('img[data-p]').forEach(async (im) => {
    const p = im.dataset.p;
    let u = thumbs.get(p);
    if (!u) { u = sys.platform === 'win32' ? await api('thumb:get', p, 200).catch(() => null) : null; if (!u) u = NATIVE.has((p.split('.').pop() || '').toLowerCase()) ? fileUrl(p) : `/media/thumb?p=${encodeURIComponent(p)}&w=200`; thumbs.set(p, u); }
    im.src = u;
  });
  box.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}
$('q-items').addEventListener('click', (e) => { const r = e.target.closest('.q-item'); if (r) show(+r.dataset.i); });
$('q-items').addEventListener('contextmenu', (e) => {
  e.preventDefault(); const r = e.target.closest('.q-item'); if (!r) return; const i = +r.dataset.i, it = V.list[i];
  showMenu([
    { label: 'Show', run: () => show(i) },
    { label: 'Remove from queue', icon: 'close', run: () => { V.list.splice(i, 1); if (i < V.idx) V.idx--; renderQueue(); if (i === V.idx) show(Math.min(i, V.list.length - 1)); } },
    { label: 'Show in Dogfile', icon: 'folder', run: () => showInFiles(it.path) },
    { label: 'Copy path', icon: 'link', run: () => api('clip:writeText', it.path) },
  ], e.clientX, e.clientY);
});
let dragQ = null;
$('q-items').addEventListener('dragstart', (e) => { const r = e.target.closest('.q-item'); dragQ = r ? +r.dataset.i : null; e.dataTransfer.setData('text/x-q', '1'); });
$('q-items').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-q')) e.preventDefault(); });
$('q-items').addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes('text/x-q')) return; e.preventDefault(); e.stopPropagation();
  const r = e.target.closest('.q-item'); if (!r || dragQ == null) return; const to = +r.dataset.i;
  const cur = V.list[V.idx]; const [m] = V.list.splice(dragQ, 1); V.list.splice(to, 0, m); V.idx = V.list.indexOf(cur); renderQueue();
});

// ---------------- info ----------------
async function renderInfo() {
  const box = $('vw-info');
  box.classList.toggle('show', V.showInfo);
  if (!V.showInfo) return;
  const it = V.list[V.idx]; if (!it) return;
  const st = await api('fs:stat', it.path).catch(() => null);
  const rows = [['Name', it.name], ['Dimensions', `${V.nat.w} × ${V.nat.h} (${((V.nat.w * V.nat.h) / 1e6).toFixed(1)} MP)`], ['Size', st ? fmtSize(st.size) : ''], ['Modified', st ? fmtDate(st.mtime, 'locale') : ''], ['Folder', it.path.replace(/[\\/][^\\/]*$/, '')]];
  if (/\.(jpe?g|jfif)$/i.test(it.path)) { const ex = await readExif(it.path).catch(() => null); if (ex) rows.push(...ex); }
  box.innerHTML = '';
  box.append(h('div', { class: 'kv' }, ...rows.filter((r) => r[1]).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])));
}

// ---------------- editor ----------------
const ADJ = [['brightness', 'Brightness', 0, 200, 100], ['contrast', 'Contrast', 0, 200, 100], ['saturate', 'Saturation', 0, 300, 100], ['hue', 'Hue', -180, 180, 0], ['blur', 'Blur', 0, 20, 0], ['grayscale', 'Black & white', 0, 100, 0], ['sepia', 'Sepia', 0, 100, 0], ['invert', 'Invert', 0, 100, 0], ['vignette', 'Vignette', 0, 100, 0]];
const PRESET_FX = {
  Original: {}, Vivid: { saturate: 145, contrast: 110 }, Mono: { grayscale: 100 }, Noir: { grayscale: 100, contrast: 145, brightness: 90, vignette: 40 },
  Vintage: { sepia: 45, contrast: 90, saturate: 80, vignette: 35 }, Warm: { sepia: 22, saturate: 120, hue: -6 }, Cool: { hue: 12, saturate: 90, brightness: 104 },
  Fade: { contrast: 80, brightness: 110, saturate: 75 }, Dramatic: { contrast: 135, saturate: 115, vignette: 45 }, Punch: { contrast: 125, saturate: 130, brightness: 104 },
};
const defaultAdj = () => Object.fromEntries(ADJ.map(([k, , , , d]) => [k, d]));
const filterStr = (a) => `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturate}%) hue-rotate(${a.hue}deg) blur(${a.blur}px) grayscale(${a.grayscale}%) sepia(${a.sepia}%) invert(${a.invert}%)`;
const isDefaultAdj = (a) => ADJ.every(([k, , , , d]) => a[k] === d);
const cloneCanvas = (c) => { const n = document.createElement('canvas'); n.width = c.width; n.height = c.height; n.getContext('2d').drawImage(c, 0, 0); return n; };

function enterEdit(tool = 'adjust') {
  const it = V.list[V.idx];
  if (!it || !V.nat.w) return;
  if (V.slideshow) toggleSlideshow(false);
  const img = curImg();
  // bake the current view rotation / flip into the working image
  const rotated = V.rot % 180 !== 0;
  const work = document.createElement('canvas');
  work.width = rotated ? V.nat.h : V.nat.w; work.height = rotated ? V.nat.w : V.nat.h;
  const g = work.getContext('2d');
  g.translate(work.width / 2, work.height / 2); g.rotate((V.rot * Math.PI) / 180); g.scale(V.flipH ? -1 : 1, V.flipV ? -1 : 1);
  g.drawImage(img, -V.nat.w / 2, -V.nat.h / 2);
  g.setTransform(1, 0, 0, 1, 0, 0); // later drawing (pen, text) works in plain picture pixels
  E = { work, adj: defaultAdj(), tool, undo: [], redo: [], dirty: V.rot !== 0 || V.flipH, draw: { color: '#ff3b30', size: 8, opacity: 100, mode: 'pen' }, crop: null, aspect: 'free' };
  try { work.getContext('2d').getImageData(0, 0, 1, 1); } catch { toast('This image can’t be edited (protected source)', { error: true }); E = null; return; }
  document.body.classList.add('editing');
  renderTools(); renderBar(); drawCanvas();
  tellHost({ type: 'state', kind: 'photo', editing: true });
}
function exitEdit(silent) {
  E = null;
  document.body.classList.remove('editing', 'cropping', 'drawing');
  $('vw-tools').innerHTML = '';
  renderBar(); layout();
  if (!silent) tellHost({ type: 'state', kind: 'photo', editing: false });
}
function pushHistory() { E.undo.push(cloneCanvas(E.work)); if (E.undo.length > (E.work.width * E.work.height > 16e6 ? 6 : 15)) E.undo.shift(); E.redo = []; E.dirty = true; }
function undo() { if (!E || !E.undo.length) return; if (!isDefaultAdj(E.adj)) { E.adj = defaultAdj(); renderTools(); drawCanvas(); return; } E.redo.push(E.work); E.work = E.undo.pop(); drawCanvas(); renderBar(); }
function redo() { if (!E || !E.redo.length) return; E.undo.push(E.work); E.work = E.redo.pop(); drawCanvas(); renderBar(); }

// Bake pending adjustments into the working image
function bakeAdjust() {
  if (!E || isDefaultAdj(E.adj)) return;
  pushHistory();
  const out = document.createElement('canvas'); out.width = E.work.width; out.height = E.work.height;
  const g = out.getContext('2d');
  g.filter = filterStr(E.adj);
  g.drawImage(E.work, 0, 0);
  g.filter = 'none';
  if (E.adj.vignette > 0) vignette(g, out.width, out.height, E.adj.vignette / 100);
  E.work = out;
  E.adj = defaultAdj();
  renderTools();
}
function vignette(g, w, hh, k) {
  const r = Math.hypot(w, hh) / 2;
  const grad = g.createRadialGradient(w / 2, hh / 2, r * (1 - 0.75 * k) * 0.55, w / 2, hh / 2, r);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, `rgba(0,0,0,${0.85 * k})`);
  g.fillStyle = grad; g.fillRect(0, 0, w, hh);
}

// display geometry for the edit canvas
function geom() {
  const c = $('vw-canvas');
  const W = c.clientWidth, H = c.clientHeight;
  const s = Math.min((W - 40) / E.work.width, (H - 40) / E.work.height, 1);
  const dw = E.work.width * s, dh = E.work.height * s;
  return { s, x: (W - dw) / 2, y: (H - dh) / 2, dw, dh, W, H };
}
function drawCanvas() {
  if (!E) return;
  const c = $('vw-canvas');
  const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  const G = geom();
  E.lastG = { ...G, cw: c.clientWidth, ch: c.clientHeight };
  g.imageSmoothingQuality = 'high';
  g.filter = filterStr(E.adj);
  g.drawImage(E.work, G.x, G.y, G.dw, G.dh);
  g.filter = 'none';
  if (E.adj.vignette > 0) { g.save(); g.translate(G.x, G.y); vignette(g, G.dw, G.dh, E.adj.vignette / 100); g.restore(); }
  if (E.tool === 'crop') positionCrop();
  renderBar();
}

// ---- crop ----
function startCrop() {
  bakeAdjust();
  const G = geom();
  E.crop = { x: G.x, y: G.y, w: G.dw, h: G.dh };
  applyAspect();
  document.body.classList.add('cropping');
  positionCrop();
}
function applyAspect() {
  if (!E.crop) return;
  const G = geom();
  const ratio = E.aspect === 'free' ? null : E.aspect === 'original' ? E.work.width / E.work.height : E.aspect.split(':').reduce((a, b) => +a / +b);
  if (!ratio) return;
  let w = G.dw, hh = w / ratio;
  if (hh > G.dh) { hh = G.dh; w = hh * ratio; }
  E.crop = { x: G.x + (G.dw - w) / 2, y: G.y + (G.dh - hh) / 2, w, h: hh };
  positionCrop();
}
function positionCrop() {
  const box = $('vw-crop').querySelector('.crop-box');
  if (!E?.crop) return;
  Object.assign(box.style, { left: E.crop.x + 'px', top: E.crop.y + 'px', width: E.crop.w + 'px', height: E.crop.h + 'px' });
}
(() => {
  const layer = $('vw-crop');
  layer.addEventListener('pointerdown', (e) => {
    if (!E?.crop) return;
    e.preventDefault();
    const handle = e.target.classList.contains('h') ? [...e.target.classList].find((c) => c.length === 2) : e.target.closest('.crop-box') ? 'move' : null;
    if (!handle) return;
    const G = geom();
    const start = { ...E.crop }, sx = e.clientX, sy = e.clientY;
    const ratio = E.aspect === 'free' ? null : E.aspect === 'original' ? E.work.width / E.work.height : E.aspect.split(':').reduce((a, b) => +a / +b);
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let { x, y, w, h: hh } = start;
      if (handle === 'move') { x = Math.max(G.x, Math.min(G.x + G.dw - w, x + dx)); y = Math.max(G.y, Math.min(G.y + G.dh - hh, y + dy)); }
      else {
        if (handle.includes('e')) w = start.w + dx;
        if (handle.includes('w')) { w = start.w - dx; x = start.x + dx; }
        if (handle.includes('s')) hh = start.h + dy;
        if (handle.includes('n')) { hh = start.h - dy; y = start.y + dy; }
        if (ratio) { if (handle.includes('n')) y = start.y + start.h - w / ratio; hh = w / ratio; }
        w = Math.max(20, w); hh = Math.max(20, hh);
        x = Math.max(G.x, x); y = Math.max(G.y, y);
        w = Math.min(w, G.x + G.dw - x); hh = Math.min(hh, G.y + G.dh - y);
      }
      E.crop = { x, y, w, h: hh };
      positionCrop();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
})();
function applyCrop() {
  if (!E?.crop) return;
  const G = geom();
  const sx = Math.round((E.crop.x - G.x) / G.s), sy = Math.round((E.crop.y - G.y) / G.s);
  const sw = Math.round(E.crop.w / G.s), sh = Math.round(E.crop.h / G.s);
  if (sw < 2 || sh < 2) return;
  pushHistory();
  const out = document.createElement('canvas'); out.width = sw; out.height = sh;
  out.getContext('2d').drawImage(E.work, sx, sy, sw, sh, 0, 0, sw, sh);
  E.work = out;
  E.crop = null; document.body.classList.remove('cropping');
  E.tool = 'adjust'; renderTools(); drawCanvas();
  osd(`Cropped to ${sw} × ${sh}`);
}

// ---- rotate / flip / resize ----
function transformWork(kind) {
  bakeAdjust(); pushHistory();
  const src = E.work;
  const out = document.createElement('canvas');
  const quarter = kind === 'left' || kind === 'right';
  out.width = quarter ? src.height : src.width; out.height = quarter ? src.width : src.height;
  const g = out.getContext('2d');
  g.translate(out.width / 2, out.height / 2);
  if (kind === 'left') g.rotate(-Math.PI / 2); else if (kind === 'right') g.rotate(Math.PI / 2); else if (kind === '180') g.rotate(Math.PI);
  else if (kind === 'flipH') g.scale(-1, 1); else if (kind === 'flipV') g.scale(1, -1);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  E.work = out; drawCanvas();
}
function resizeWork(w, hh) {
  bakeAdjust(); pushHistory();
  let src = E.work;
  // step down in halves for a smooth result
  while (src.width / 2 > w && src.height / 2 > hh) { const half = document.createElement('canvas'); half.width = Math.round(src.width / 2); half.height = Math.round(src.height / 2); const hg = half.getContext('2d'); hg.imageSmoothingQuality = 'high'; hg.drawImage(src, 0, 0, half.width, half.height); src = half; }
  const out = document.createElement('canvas'); out.width = w; out.height = hh;
  const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, hh);
  E.work = out; drawCanvas(); renderTools(); osd(`Resized to ${w} × ${hh}`);
}

// ---- draw & text ----
(() => {
  const c = $('vw-canvas');
  let drawing = false, last = null, base = null;
  // map the pointer to picture pixels using the geometry the canvas was last drawn with (the canvas can be
  // stretched by a layout change before it redraws, which made strokes land away from the pointer)
  const toImg = (e) => {
    const r = c.getBoundingClientRect(); const G = E.lastG || geom();
    const kx = r.width / (G.cw || r.width), ky = r.height / (G.ch || r.height);
    const P = { x: ((e.clientX - r.left) / kx - G.x) / G.s, y: ((e.clientY - r.top) / ky - G.y) / G.s }; return P;
  };
  new ResizeObserver(() => { if (E && (c.clientWidth !== E.lastG?.cw || c.clientHeight !== E.lastG?.ch)) drawCanvas(); }).observe(c);
  c.addEventListener('pointerdown', async (e) => {
    if (!E || E.tool !== 'draw') return;
    const p = toImg(e);
    if (E.draw.mode === 'text') {
      const t = await prompt('Add text', '', { label: 'Text' });
      if (!t) return;
      bakeAdjust(); pushHistory();
      const g = E.work.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = E.draw.opacity / 100; g.fillStyle = E.draw.color;
      g.font = `600 ${Math.max(12, E.draw.size * 5)}px Inter, Segoe UI, sans-serif`; g.textBaseline = 'top';
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 4;
      t.split('\n').forEach((line, i) => g.fillText(line, p.x, p.y + i * E.draw.size * 6));
      g.globalAlpha = 1; g.shadowBlur = 0;
      drawCanvas(); return;
    }
    bakeAdjust(); pushHistory();
    base = E.undo[E.undo.length - 1];
    drawing = true; last = p; c.setPointerCapture(e.pointerId);
    stroke(p, p);
  });
  c.addEventListener('pointermove', (e) => { if (!drawing) return; const p = toImg(e); stroke(last, p); last = p; });
  c.addEventListener('pointerup', () => { drawing = false; });
  function stroke(a, b) {
    const g = E.work.getContext('2d');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = E.draw.size * (E.draw.mode === 'marker' ? 3 : 1) * Math.max(1, E.work.width / 1600);
    if (E.draw.mode === 'eraser') { g.strokeStyle = g.createPattern(base, 'no-repeat'); g.globalAlpha = 1; }
    else { g.strokeStyle = E.draw.color; g.globalAlpha = E.draw.mode === 'marker' ? Math.min(0.4, E.draw.opacity / 100) : E.draw.opacity / 100; }
    if (E.draw.mode === 'marker') g.globalCompositeOperation = 'multiply';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.restore();
    drawCanvas();
  }
})();

// ---- save ----
async function save(mode) {
  if (!E) return;
  bakeAdjust();
  const it = V.list[V.idx];
  const ext = (it.path.split('.').pop() || '').toLowerCase();
  const fmtSel = E.format || 'keep';
  let outExt = fmtSel === 'keep' ? ext : fmtSel;
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(outExt)) outExt = 'png';
  const mime = outExt === 'png' ? 'image/png' : outExt === 'webp' ? 'image/webp' : 'image/jpeg';
  const data = E.work.toDataURL(mime, (E.quality || 92) / 100);
  const dir = it.path.replace(/[\\/][^\\/]*$/, '');
  const stem = it.name.replace(/\.[^.]+$/, '');
  let target;
  if (mode === 'overwrite') {
    if (!(await confirm('Overwrite original?', `Replace <b>${esc(it.name)}</b> with the edited image? This can’t be undone (photo metadata such as camera info isn’t kept).`, { ok: 'Overwrite', danger: true }))) return;
    target = outExt === ext || (outExt === 'jpg' && ext === 'jpeg') ? it.path : `${dir}${sys.sep}${stem}.${outExt}`;
  } else target = await api('fs:uniqueName', dir, `${stem} (edited).${outExt}`, 'number');
  await api('fs:writeDataUrl', target, data);
  E.dirty = false;
  thumbs.delete(target); bust.set(target, Date.now());
  toast(mode === 'overwrite' ? 'Saved' : `Saved a copy: ${target.split(/[\\/]/).pop()}`, { action: { label: 'Show', run: () => showInFiles(target) } });
  if (mode !== 'overwrite') { V.list.splice(V.idx + 1, 0, { path: target, name: target.split(/[\\/]/).pop() }); exitEdit(); show(V.idx + 1); }
  else { exitEdit(); show(V.idx); }
}

function renderTools() {
  const box = $('vw-tools');
  if (!E) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  const tabs = h('div', { class: 'seg vw-seg' });
  for (const [k, l, ic] of [['adjust', 'Adjust', 'sliders'], ['filters', 'Filters', 'palette'], ['crop', 'Crop', 'treemap'], ['rotate', 'Rotate', 'refresh'], ['draw', 'Draw', 'rename'], ['resize', 'Resize', 'zoomIn']]) {
    const b = h('button', { class: 'seg-btn' + (E.tool === k ? ' on' : ''), title: l, html: `${icon(ic)}<span>${l}</span>` });
    b.onclick = () => { if (E.tool === 'crop' && k !== 'crop') { E.crop = null; document.body.classList.remove('cropping'); } if (k !== 'adjust' && k !== 'filters') bakeAdjust(); E.tool = k; document.body.classList.toggle('drawing', k === 'draw'); renderTools(); if (k === 'crop') startCrop(); drawCanvas(); };
    tabs.append(b);
  }
  box.append(tabs);
  const panel = h('div', { class: 'vw-tool-panel' });
  if (E.tool === 'adjust') {
    for (const [k, label, min, max, def] of ADJ) {
      const val = h('span', { class: 'adj-val' }, String(E.adj[k]));
      const s = h('input', { type: 'range', min: String(min), max: String(max), value: String(E.adj[k]) });
      s.oninput = () => { E.adj[k] = +s.value; val.textContent = s.value; E.dirty = true; drawCanvas(); };
      s.ondblclick = () => { E.adj[k] = def; s.value = def; val.textContent = def; drawCanvas(); };
      panel.append(h('div', { class: 'adj' }, h('div', { class: 'adj-top' }, h('span', {}, label), val), s));
    }
    panel.append(h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: () => { E.adj = defaultAdj(); renderTools(); drawCanvas(); } }, 'Reset sliders'), h('button', { class: 'btn small primary', onclick: () => { bakeAdjust(); drawCanvas(); } }, 'Apply')), h('div', { class: 'hint' }, 'Double-click a slider to reset it.'));
  } else if (E.tool === 'filters') {
    const grid = h('div', { class: 'fx-grid' });
    const small = document.createElement('canvas'); const ratio = E.work.width / E.work.height; small.width = 120; small.height = Math.round(120 / ratio);
    small.getContext('2d').drawImage(E.work, 0, 0, small.width, small.height);
    for (const [name, fx] of Object.entries(PRESET_FX)) {
      const a = { ...defaultAdj(), ...fx };
      const cv = document.createElement('canvas'); cv.width = small.width; cv.height = small.height;
      const g = cv.getContext('2d'); g.filter = filterStr(a); g.drawImage(small, 0, 0); g.filter = 'none'; if (a.vignette) vignette(g, cv.width, cv.height, a.vignette / 100);
      const b = h('button', { class: 'fx' }, cv, h('span', {}, name));
      b.onclick = () => { E.adj = a; E.dirty = true; drawCanvas(); grid.querySelectorAll('.fx').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
      grid.append(b);
    }
    panel.append(grid, h('div', { class: 'row-inline' }, h('button', { class: 'btn small primary', onclick: () => { bakeAdjust(); drawCanvas(); } }, 'Apply filter')), h('div', { class: 'hint' }, 'Fine-tune it afterwards in Adjust.'));
  } else if (E.tool === 'crop') {
    const asp = h('div', { class: 'chips' });
    for (const [k, l] of [['free', 'Free'], ['original', 'Original'], ['1:1', 'Square'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['9:16', '9:16'], ['5:4', '5:4']]) {
      const b = h('button', { class: 'chip' + (E.aspect === k ? ' on' : '') }, l);
      b.onclick = () => { E.aspect = k; asp.querySelectorAll('.chip').forEach((x) => x.classList.remove('on')); b.classList.add('on'); applyAspect(); };
      asp.append(b);
    }
    panel.append(h('div', { class: 'field-label' }, 'Aspect ratio'), asp, h('div', { class: 'row-inline', style: { marginTop: '12px' } }, h('button', { class: 'btn small', onclick: () => { startCrop(); } }, 'Reset'), h('button', { class: 'btn small primary', onclick: applyCrop }, 'Apply crop')), h('div', { class: 'hint' }, 'Drag the box or its corners. Press Enter to apply.'));
  } else if (E.tool === 'rotate') {
    const B = (ic, l, k) => h('button', { class: 'btn small tool-btn', onclick: () => transformWork(k), html: `${icon(ic)}<span>${l}</span>` });
    panel.append(B('undo', 'Rotate left', 'left'), B('redo', 'Rotate right', 'right'), B('refresh', 'Rotate 180°', '180'), B('swap', 'Flip horizontal', 'flipH'), B('swap', 'Flip vertical', 'flipV'));
  } else if (E.tool === 'draw') {
    const modes = h('div', { class: 'seg' });
    for (const [k, l] of [['pen', 'Pen'], ['marker', 'Highlighter'], ['eraser', 'Eraser'], ['text', 'Text']]) { const b = h('button', { class: 'seg-btn' + (E.draw.mode === k ? ' on' : '') }, l); b.onclick = () => { E.draw.mode = k; renderTools(); }; modes.append(b); }
    const col = h('input', { type: 'color', value: E.draw.color }); col.oninput = () => (E.draw.color = col.value);
    const sw = h('div', { class: 'chips' }, ...['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#000000'].map((c) => h('button', { class: 'pv-sw2', style: { background: c }, onclick: () => { E.draw.color = c; col.value = c; } })));
    const size = h('input', { type: 'range', min: '1', max: '60', value: String(E.draw.size) }); size.oninput = () => (E.draw.size = +size.value);
    const op = h('input', { type: 'range', min: '10', max: '100', value: String(E.draw.opacity) }); op.oninput = () => (E.draw.opacity = +op.value);
    panel.append(modes, h('div', { class: 'field-label' }, 'Color'), h('div', { class: 'row-inline' }, col, sw), h('div', { class: 'field-label' }, 'Size'), size, h('div', { class: 'field-label' }, 'Opacity'), op, h('div', { class: 'hint' }, E.draw.mode === 'text' ? 'Click on the photo where the text should go.' : E.draw.mode === 'eraser' ? 'Erases your drawing back to the photo.' : 'Draw directly on the photo.'));
  } else if (E.tool === 'resize') {
    const w = h('input', { class: 'input small', type: 'number', value: String(E.work.width) });
    const hh = h('input', { class: 'input small', type: 'number', value: String(E.work.height) });
    const lock = h('input', { type: 'checkbox', checked: true });
    const ratio = E.work.width / E.work.height;
    w.oninput = () => { if (lock.checked) hh.value = Math.round(+w.value / ratio); };
    hh.oninput = () => { if (lock.checked) w.value = Math.round(+hh.value * ratio); };
    const pct = h('div', { class: 'chips' }, ...[25, 50, 75].map((p) => h('button', { class: 'chip', onclick: () => { w.value = Math.round((E.work.width * p) / 100); hh.value = Math.round((E.work.height * p) / 100); } }, p + '%')), ...[1920, 1280].map((px) => h('button', { class: 'chip', onclick: () => { w.value = px; hh.value = Math.round(px / ratio); } }, px + ' wide')));
    panel.append(h('div', { class: 'row-inline' }, w, h('span', {}, '×'), hh, h('span', { class: 'hint' }, 'px')), h('label', { class: 'check' }, lock, ' Keep proportions'), pct, h('div', { class: 'row-inline', style: { marginTop: '10px' } }, h('button', { class: 'btn small primary', onclick: () => { const W = Math.max(1, +w.value | 0), H = Math.max(1, +hh.value | 0); resizeWork(W, H); } }, 'Resize')));
  }
  // save format
  const fmt = h('select', { class: 'input' }, ...[['keep', 'Same format'], ['jpg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']].map(([v, l]) => h('option', { value: v }, l)));
  fmt.value = E.format || 'keep'; fmt.onchange = () => (E.format = fmt.value);
  const q = h('input', { type: 'range', min: '50', max: '100', value: String(E.quality || 92) }); q.oninput = () => (E.quality = +q.value);
  box.append(panel, h('div', { class: 'vw-save' }, h('div', { class: 'field-label' }, 'Save as'), fmt, h('div', { class: 'field-label' }, 'Quality (JPEG / WebP)'), q));
}

// ---------------- bottom bar ----------------
function renderBar() {
  const bar = $('vw-bar');
  bar.innerHTML = '';
  const B = (ic, title, fn, cls = '') => { const b = h('button', { class: 'pb ' + cls, title, html: icon(ic) }); b.onclick = fn; return b; };
  if (E) {
    bar.append(B('undo', 'Undo (Ctrl+Z)', undo, E.undo.length || !isDefaultAdj(E.adj) ? '' : 'dim'), B('redo', 'Redo (Ctrl+Y)', redo, E.redo.length ? '' : 'dim'),
      h('span', { class: 'vw-dims' }, `${E.work.width} × ${E.work.height}`), h('span', { class: 'ctl-spacer' }),
      h('button', { class: 'btn small', onclick: async () => { if (E.dirty && !(await confirm('Discard edits?', 'Leave the editor without saving?', { ok: 'Discard', danger: true }))) return; exitEdit(); } }, 'Cancel'),
      h('button', { class: 'btn small', onclick: () => save('overwrite') }, 'Overwrite original'),
      h('button', { class: 'btn small primary', onclick: () => save('copy') }, 'Save as copy'));
    return;
  }
  const zoomTxt = h('button', { class: 'pb txt', title: 'Zoom (click to fit)', onclick: () => { V.zoom = 'fit'; V.panX = V.panY = 0; layout(); } }, V.nat.w ? Math.round(V.scale * 100) + '%' : '');
  const secs = h('select', { class: 'vw-secs', title: 'Seconds per photo' }, ...[2, 3, 4, 5, 8, 10, 15, 30].map((n) => h('option', { value: String(n) }, n + 's')));
  secs.value = String(settings.slideshowSeconds || 4);
  secs.onchange = () => { settings.slideshowSeconds = +secs.value; api('store:set', 'settings', settings); if (V.slideshow) toggleSlideshow(true); };
  bar.append(
    B('listMusic', 'Queue (Q)', () => { if (innerWidth < 600) { V.showQueue = true; document.body.classList.remove('no-queue'); document.body.classList.toggle('queue-open'); } else { V.showQueue = !V.showQueue; document.body.classList.toggle('no-queue', !V.showQueue); } setTimeout(layout, 20); }, V.showQueue ? 'on' : ''),
    B('pprev', 'Previous (←)', () => show(V.idx - 1)), B('pnext', 'Next (→)', () => show(V.idx + 1)),
    h('span', { class: 'bar-sep' }),
    B('zoomOut', 'Zoom out (-)', () => setZoom(V.scale / 1.25), 'hide-sm'), zoomTxt, B('zoomIn', 'Zoom in (+)', () => setZoom(V.scale * 1.25), 'hide-sm'),
    B('max', 'Actual size (1)', () => { V.panX = V.panY = 0; setZoom(1); }, 'hide-sm'),
    h('span', { class: 'bar-sep' }),
    B('undo', 'Rotate left (Shift+R)', () => rotate(-90), 'hide-sm'), B('redo', 'Rotate right (R)', () => rotate(90), 'hide-xs'), B('swap', 'Flip (H)', flip, 'hide-sm'),
    h('span', { class: 'ctl-spacer' }),
    B(V.slideshow ? 'ppause' : 'pplay', V.slideshow ? 'Stop slideshow (Space)' : 'Slideshow (Space)', () => toggleSlideshow(), V.slideshow ? 'on' : ''), secs,
    B('shuffle', 'Shuffle slideshow', () => { V.shuffle = !V.shuffle; osd(V.shuffle ? 'Shuffle on' : 'Shuffle off'); renderBar(); }, (V.shuffle ? 'on ' : '') + 'hide-sm'),
    h('span', { class: 'bar-sep hide-sm' }),
    ...(vwFeatures?.commands() || []).filter((c) => c.toolbar).map((c) => B(c.icon || 'puzzle', `${c.title} (${c.feature.name})`, () => c.run({}), 'hide-sm')),
    B('puzzle', 'Features: your own photo tools', (e) => featureMenuVw(e), 'hide-xs'),
    B('scan', 'Copy text from image (T)', runOcr, (OCR ? 'on ' : '') + 'hide-xs'),
    B('info', 'Info (I)', () => { V.showInfo = !V.showInfo; renderInfo(); renderBar(); }, (V.showInfo ? 'on ' : '') + 'hide-xs'),
    h('span', { class: 'bar-sep hide-xs' }),
    B('trash', 'Delete (Del)', del, 'hide-xs'),
    B(document.fullscreenElement ? 'fullscreenExit' : 'fullscreen', 'Fullscreen (F)', toggleFs),
    h('button', { class: 'btn small primary vw-edit', onclick: () => enterEdit(), html: `${icon('rename')}<span>Edit</span>` }));
}
async function toggleFs() { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('fs', !!document.fullscreenElement); setTimeout(() => { layout(); if (E) drawCanvas(); }, 60); });
async function del() {
  const it = V.list[V.idx]; if (!it) return;
  if (!(await confirm('Delete photo?', `Move <b>${esc(it.name)}</b> to the Recycle Bin?`, { ok: 'Delete', danger: true }))) return;
  try { await api('fs:trash', it.path); } catch (e) { return toast(e.message, { error: true }); }
  V.list.splice(V.idx, 1);
  renderQueue();
  if (V.list.length) show(Math.min(V.idx, V.list.length - 1)); else { $('vw-empty').style.display = ''; curImg().removeAttribute('src'); }
}
let osdT;
function osd(t) { const o = $('vw-osd'); o.textContent = t; o.classList.add('show'); clearTimeout(osdT); osdT = setTimeout(() => o.classList.remove('show'), 1300); }

// ---------------- input ----------------
function wire() {
  $('vw-prev').innerHTML = icon('chevronRight'); $('vw-next').innerHTML = icon('chevronRight');
  $('vw-prev').onclick = () => show(V.idx - 1); $('vw-next').onclick = () => show(V.idx + 1);
  $('q-add').innerHTML = icon('plus');
  $('q-add').onclick = async () => { const f = await api('dialog:openFiles', { title: 'Add photos' }); if (f.length) setQueue(f, { append: true }); };
  $('vw-open').onclick = async () => { const f = await api('dialog:openFiles', { title: 'Open photos' }); if (f.length) setQueue(f, { autoPlaylist: f.length === 1 }); };
  const st = $('vw-stage');
  st.addEventListener('wheel', (e) => { if (E) return; e.preventDefault(); if (e.ctrlKey || V.zoom !== 'fit' || true) setZoom(V.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });
  st.addEventListener('dblclick', (e) => { if (E || e.target.closest('.vw-nav')) return; if (V.zoom === 'fit') setZoom(1, e.clientX, e.clientY); else { V.zoom = 'fit'; V.panX = V.panY = 0; layout(); } });
  st.addEventListener('pointerdown', (e) => {
    if (E || e.button !== 0 || e.target.closest('.vw-nav, #vw-info, #vw-empty, #vw-ocr, #vw-ocr-panel')) return;
    if (V.zoom === 'fit') return;
    const sx = e.clientX, sy = e.clientY, px = V.panX, py = V.panY;
    st.classList.add('panning');
    const move = (ev) => { V.panX = px + ev.clientX - sx; V.panY = py + ev.clientY - sy; layout(); };
    const up = () => { st.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  st.addEventListener('contextmenu', (e) => {
    e.preventDefault(); const it = V.list[V.idx]; if (!it) return;
    showMenu([
      { label: 'Edit', icon: 'rename', keys: 'E', run: () => enterEdit() },
      { label: V.slideshow ? 'Stop slideshow' : 'Start slideshow', icon: 'pplay', keys: 'Space', run: () => toggleSlideshow() },
      { label: 'Fullscreen', icon: 'fullscreen', keys: 'F', run: toggleFs },
      { separator: true },
      { label: 'Rotate right', icon: 'redo', keys: 'R', run: () => rotate(90) }, { label: 'Rotate left', icon: 'undo', keys: 'Shift+R', run: () => rotate(-90) }, { label: 'Flip', icon: 'swap', keys: 'H', run: flip },
      { separator: true },
      { label: 'Copy text from image', icon: 'scan', keys: 'T', run: runOcr },
      { label: 'Copy image', icon: 'copy', run: async () => { try { const c = document.createElement('canvas'); c.width = V.nat.w; c.height = V.nat.h; c.getContext('2d').drawImage(curImg(), 0, 0); const blob = await new Promise((r) => c.toBlob(r)); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Image copied'); } catch { toast('Couldn’t copy this image', { error: true }); } } },
      { label: 'Copy path', icon: 'link', run: () => api('clip:writeText', it.path) },
      { label: 'Show in Dogfile', icon: 'folder', run: () => showInFiles(it.path) },
      { label: 'Open with Windows default app', run: () => api('shell:open', it.path) },
      { label: 'Info', icon: 'info', keys: 'I', run: () => { V.showInfo = !V.showInfo; renderInfo(); } },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, keys: 'Del', run: del },
    ], e.clientX, e.clientY);
  });
  window.addEventListener('resize', debounce(() => { layout(); if (E) drawCanvas(); }, 40));
  new ResizeObserver(debounce(() => { layout(); if (E) drawCanvas(); }, 30)).observe($('vw-stage'));
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.modal-back, .menu')) return;
    const k = e.key, c = e.ctrlKey || e.metaKey;
    let hd = true;
    if (E) {
      if (c && k.toLowerCase() === 'z') undo();
      else if (c && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) redo();
      else if (c && k.toLowerCase() === 's') save(e.shiftKey ? 'overwrite' : 'copy');
      else if (k === 'Enter' && E.tool === 'crop') applyCrop();
      else if (k === 'Escape') { if (E.tool === 'crop') { E.crop = null; document.body.classList.remove('cropping'); E.tool = 'adjust'; renderTools(); drawCanvas(); } else $('vw-bar').querySelector('.btn')?.click(); }
      else hd = false;
    } else if (k === 'ArrowRight' || k === 'PageDown' || k === 'ArrowDown') show(V.idx + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'ArrowUp') show(V.idx - 1);
    else if (k === 'Home') show(0);
    else if (k === 'End') show(V.list.length - 1);
    else if (k === ' ') toggleSlideshow();
    else if (k === 'f' || k === 'F11') toggleFs();
    else if (k === 'Escape') { if (V.slideshow) toggleSlideshow(false); else if (document.fullscreenElement) document.exitFullscreen(); else hd = false; }
    else if (k === '+' || k === '=') setZoom(V.scale * 1.25);
    else if (k === '-') setZoom(V.scale / 1.25);
    else if (k === '0') { V.zoom = 'fit'; V.panX = V.panY = 0; layout(); }
    else if (k === '1') setZoom(1);
    else if (k === 'r') rotate(90);
    else if (k === 'R') rotate(-90);
    else if (k === 'h') flip();
    else if (k === 'e') enterEdit();
    else if (k === 'i') { V.showInfo = !V.showInfo; renderInfo(); renderBar(); }
    else if (k === 't') runOcr();
    else if (k === 'q') { V.showQueue = !V.showQueue; document.body.classList.toggle('no-queue', !V.showQueue); setTimeout(layout, 20); }
    else if (k === 'Delete') del();
    else hd = false;
    if (hd) e.preventDefault();
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (paths.length) setQueue(paths, { append: !!e.target.closest('#vw-queue'), autoPlaylist: paths.length === 1 && !e.target.closest('#vw-queue') });
  });
}

// commands from the host tab's contextual ribbon
function cmd(id) {
  const map = {
    ocr: runOcr,
    prev: () => show(V.idx - 1), next: () => show(V.idx + 1), slideshow: () => toggleSlideshow(), fullscreen: toggleFs, edit: () => (E ? null : enterEdit()),
    rotateL: () => (E ? transformWork('left') : rotate(-90)), rotateR: () => (E ? transformWork('right') : rotate(90)), flip: () => (E ? transformWork('flipH') : flip()),
    zoomIn: () => setZoom(V.scale * 1.25), zoomOut: () => setZoom(V.scale / 1.25), fit: () => { V.zoom = 'fit'; V.panX = V.panY = 0; layout(); }, info: () => { V.showInfo = !V.showInfo; renderInfo(); renderBar(); },
    delete: del, saveCopy: () => save('copy'), overwrite: () => save('overwrite'), crop: () => { if (!E) enterEdit('crop'); E.tool = 'crop'; renderTools(); startCrop(); }, draw: () => { if (!E) enterEdit(); E.tool = 'draw'; document.body.classList.add('drawing'); renderTools(); },
    filters: () => { if (!E) enterEdit(); E.tool = 'filters'; renderTools(); }, undo, redo, queue: () => { V.showQueue = !V.showQueue; document.body.classList.toggle('no-queue', !V.showQueue); setTimeout(layout, 20); },
  };
  map[id]?.();
}

// ---------------- features (user-made photo tools) ----------------
let vwFeatures = null;
function featureMenuVw(e) {
  const cmds = vwFeatures?.commands() || [];
  const r = e.currentTarget.getBoundingClientRect();
  showMenu([...(cmds.length ? [{ header: 'Your features' }, ...cmds.map((c) => ({ label: c.title, icon: c.icon || 'puzzle', run: () => c.run({}) })), { separator: true }] : []),
    { label: 'Add a feature in Notepad…', icon: 'plus', run: () => api('ext:install', { create: 'photos' }) }, { label: 'Manage features…', icon: 'settings', run: () => api('ext:install', { manage: true }) }, { label: 'Browse features…', icon: 'store', run: () => api('ext:install', { store: true }) }], r.left, r.top - 8);
}
async function startViewerFeatures() {
  const X = await import('./extensions.js');
  vwFeatures = X.startFeatures({
    target: 'photos', getSettings: () => settings, onChange: () => renderBar(),
    provide: {
      'photos.fileName': () => V.list[V.idx] || '',
      'photos.getImageData': () => { if (!E) enterEdit('adjust'); if (!E) throw new Error('This picture can’t be edited'); bakeAdjust(); return E.work.getContext('2d').getImageData(0, 0, E.work.width, E.work.height); },
      'photos.putImageData': (img) => {
        if (!E) enterEdit('adjust');
        if (!E || !img?.width || !img?.height || !img.data) throw new Error('putImageData needs { width, height, data }');
        pushHistory();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
        E.work = c; drawCanvas(); renderBar();
        return true;
      },
    },
  });
}

async function boot() {
  sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  const st = await api('store:get', 'settings');
  settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  applyMediaTheme();
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  wire(); renderBar();
  const pending = await pendingFiles();
  if (pending?.files?.length) await setQueue(pending.files, { autoPlaylist: !!pending.autoPlaylist || pending.files.length === 1, slideshow: !!pending.slideshow });
  document.body.classList.add('ready');
}
onMain('viewer:open', ({ files, autoPlaylist, slideshow }) => setQueue(files, { autoPlaylist: autoPlaylist || files.length === 1, slideshow }));
onMain('settings:changed', (s) => { settings = { ...settings, ...s }; applyMediaTheme(); vwFeatures?.reload(); });
onHost({ open: (m) => setQueue(m.files, { autoPlaylist: m.autoPlaylist || m.files.length === 1, append: !!m.append, slideshow: !!m.slideshow }), cmd, settings: (s) => { settings = { ...settings, ...s }; applyMediaTheme(); vwFeatures?.reload(); } });
window.__vw = { V, get E() { return E; }, show, enterEdit, save, setQueue, cmd, transformWork, applyCrop, startCrop };
boot().then(() => startViewerFeatures()).catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#f66">${esc(e.stack || e.message)}</pre>`; });
