// Watermarks: your default mark (text or a logo) saved once, then put on one picture in the photo editor, or on a whole
// selection at once from Batch tools. The mark is stored as where it sits on the picture (fractions, so it lands in the same
// place on any size), how wide it is (a share of the picture's width), its turn and its see-through-ness.
import { state, saveSettings, h, toast } from './core.js';
import { modal } from './dialogs.js';

export const WM_DEFAULT = {
  kind: 'text', text: '© Your name', font: 'Segoe UI', bold: true, color: '#ffffff', shadow: true,
  image: '', // a logo, as a data URL, when kind is "image"
  opacity: 60, // percent
  size: 24, // width of the mark as a percent of the picture's width
  rot: 0, // degrees
  cx: 0.85, cy: 0.93, // centre of the mark, as a fraction of the picture
};

export const getWatermark = () => ({ ...WM_DEFAULT, ...(state.settings.watermark || {}) });
export function saveWatermark(wm) { state.settings.watermark = { ...wm }; saveSettings(); }

const imgCache = new Map();
/** the logo of a mark as something drawable (cached by its data) */
export async function watermarkImage(wm) {
  if (wm.kind !== 'image' || !wm.image) return null;
  if (imgCache.has(wm.image)) return imgCache.get(wm.image);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That logo could not be read')); i.src = wm.image; });
  imgCache.set(wm.image, img);
  return img;
}

/** how big the mark is, in pixels, on a picture `W` wide (its own width and height before turning) */
export function markBox(ctx, W, wm, img) {
  const width = Math.max(4, (wm.size / 100) * W);
  if (wm.kind === 'image' && img) return { w: width, h: width * (img.naturalHeight / img.naturalWidth) };
  // text: find the font size at which the text is `width` wide
  const probe = 100;
  ctx.save();
  ctx.font = `${wm.bold ? 'bold ' : ''}${probe}px "${wm.font}", sans-serif`;
  const m = ctx.measureText(wm.text || ' ').width || 1;
  ctx.restore();
  const fs = (probe * width) / m;
  return { w: width, h: fs * 1.2, fs };
}

/** draw the mark on a picture of W×H pixels */
export function drawWatermark(ctx, W, H, wm, img) {
  if (wm.kind === 'image' ? !img : !(wm.text || '').trim()) return;
  const b = markBox(ctx, W, wm, img);
  ctx.save();
  ctx.globalAlpha = Math.max(0.02, Math.min(1, wm.opacity / 100));
  ctx.translate(wm.cx * W, wm.cy * H);
  ctx.rotate((wm.rot * Math.PI) / 180);
  if (wm.kind === 'image') ctx.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h);
  else {
    ctx.font = `${wm.bold ? 'bold ' : ''}${b.fs}px "${wm.font}", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (wm.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = b.fs * 0.12; ctx.shadowOffsetX = b.fs * 0.03; ctx.shadowOffsetY = b.fs * 0.04; }
    ctx.fillStyle = wm.color;
    ctx.fillText(wm.text, 0, 0);
  }
  ctx.restore();
}

/**
 * The controls for a mark (text or logo, colour, size, see-through, turn, shadow), shared by the photo editor's Watermark tab
 * and the "my default watermark" window. `onChange(wm)` is called on every change; returns { el, get, set }.
 */
export function watermarkControls(initial, onChange) {
  let wm = { ...initial };
  const set = (patch, redraw = true) => { wm = { ...wm, ...patch }; if (redraw) onChange?.(wm); };
  const root = h('div', { class: 'stack wm-controls' });
  const kind = h('div', { class: 'seg' });
  const text = h('input', { class: 'input', value: wm.text, placeholder: 'Your name, a site or “© 2026”', spellcheck: 'false' });
  text.addEventListener('keydown', (e) => e.stopPropagation());
  text.oninput = () => set({ text: text.value });
  const font = h('select', { class: 'input small' }, ...['Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Brush Script MT'].map((f) => h('option', { value: f, selected: f === wm.font }, f)));
  font.onchange = () => set({ font: font.value });
  const bold = h('input', { type: 'checkbox', checked: wm.bold }); bold.onchange = () => set({ bold: bold.checked });
  const shadow = h('input', { type: 'checkbox', checked: wm.shadow }); shadow.onchange = () => set({ shadow: shadow.checked });
  const color = h('input', { type: 'color', value: wm.color }); color.oninput = () => set({ color: color.value });
  const textBox = h('div', { class: 'stack' }, text,
    h('div', { class: 'row-inline wrap' }, font, color, h('label', { class: 'check' }, bold, h('span', {}, 'Bold')), h('label', { class: 'check' }, shadow, h('span', {}, 'Shadow'))));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', style: { display: 'none' } });
  const logoName = h('span', { class: 'hint' }, wm.image ? 'Logo chosen' : 'No logo chosen yet');
  file.onchange = () => {
    const f = file.files[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('Pick a logo under 8 MB', { error: true });
    const r = new FileReader(); r.onload = () => { logoName.textContent = f.name; set({ image: String(r.result), kind: 'image' }); drawKind(); }; r.readAsDataURL(f);
  };
  const imgBox = h('div', { class: 'row-inline' }, h('button', { class: 'btn small', type: 'button', onclick: () => file.click() }, 'Choose logo…'), logoName, file);
  const drawKind = () => {
    kind.innerHTML = '';
    for (const [k, l] of [['text', 'Text'], ['image', 'Logo']]) {
      const b = h('button', { class: 'seg-btn' + (wm.kind === k ? ' on' : ''), type: 'button' }, l);
      b.onclick = () => { set({ kind: k }); drawKind(); };
      kind.append(b);
    }
    textBox.style.display = wm.kind === 'text' ? '' : 'none';
    imgBox.style.display = wm.kind === 'image' ? '' : 'none';
  };
  const slider = (label, key, min, max, step = 1, suffix = '') => {
    const val = h('span', { class: 'adj-val' }, `${wm[key]}${suffix}`);
    const s = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(wm[key]) });
    s.oninput = () => { set({ [key]: +s.value }); val.textContent = `${s.value}${suffix}`; };
    s.ondblclick = () => { s.value = WM_DEFAULT[key]; s.oninput(); };
    return { el: h('div', { class: 'adj' }, h('div', { class: 'adj-top' }, h('span', {}, label), val), s), sync: () => { s.value = String(wm[key]); val.textContent = `${wm[key]}${suffix}`; } };
  };
  const sizeS = slider('Size (share of the picture’s width)', 'size', 3, 90, 1, '%');
  const opS = slider('Opacity', 'opacity', 5, 100, 1, '%');
  const rotS = slider('Turn', 'rot', -180, 180, 1, '°');
  drawKind();
  root.append(kind, textBox, imgBox, sizeS.el, opS.el, rotS.el);
  return {
    el: root,
    get: () => ({ ...wm }),
    // the picture's own drag/resize/turn changed the mark: bring the sliders along
    set: (patch) => { wm = { ...wm, ...patch }; sizeS.sync(); opS.sync(); rotS.sync(); },
  };
}

/** Settings → "My default watermark": make it once, see it on a sample, save it */
export function watermarkDialog(sample) {
  const wm0 = getWatermark();
  const stage = h('div', { class: 'wm-stage' });
  const cv = document.createElement('canvas');
  cv.width = 640; cv.height = 400;
  stage.append(cv);
  let cur = wm0, token = 0;
  const paint = async () => {
    const my = ++token;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 640, 400); grad.addColorStop(0, '#5b86a8'); grad.addColorStop(1, '#2d4256');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 400);
    if (sample) { try { g.drawImage(sample, 0, 0, 640, 400); } catch { /* the gradient stays */ } }
    const img = await watermarkImage(cur).catch(() => null);
    if (my === token) drawWatermark(g, 640, 400, cur, img);
  };
  // place it by dragging on the sample
  let drag = null;
  cv.style.touchAction = 'none';
  cv.onpointerdown = (e) => { drag = true; cv.setPointerCapture(e.pointerId); move(e); };
  cv.onpointermove = (e) => { if (drag) move(e); };
  cv.onpointerup = () => { drag = null; };
  const move = (e) => { const r = cv.getBoundingClientRect(); cur = { ...cur, cx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), cy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; ctl.set({}); paint(); };
  const ctl = watermarkControls(wm0, (w) => { cur = { ...w, cx: cur.cx, cy: cur.cy }; paint(); });
  paint();
  const body = h('div', { class: 'wm-dialog' }, stage, h('div', { class: 'hint' }, 'Drag on the picture to place it. Any picture you add it to gets it at this size, turn and place.'), ctl.el);
  modal({
    title: 'My default watermark', body, width: 540,
    buttons: [{ label: 'Cancel' }, { label: 'Save as my default', primary: true, run: async (close) => {
      saveWatermark({ ...ctl.get(), cx: cur.cx, cy: cur.cy });
      toast('Watermark saved'); close();
    } }],
  });
}
