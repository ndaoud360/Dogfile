// Dogfile PSD: open a Photoshop file with its layers. Turn layers on and off, change the one you picked (brightness,
// colours, blur, turn, flip), crop or turn the whole picture, and save: as a copy or over the original. What is saved is
// a PSD with every layer still in it, so Photoshop opens it as it was. The reading and writing is done by the Photoshop
// helper (tools/psd/dogfile_psd.py, run by backend/src/psd.rs); this is the window.
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, fileUrl, fmtSize, basename, errText } from './core.js';
import { icon } from './icons.js';
import './menu.js';
import { applyColors, mediaSettings } from './theme.js';
import { EMBED, pendingFiles, onHost, tellHost, setTitle, onLeave, onWindowClose } from './embed.js';
import { modal, confirm } from './dialogs.js';
import { ensureComponent } from './components.js';

const $ = (id) => document.getElementById(id);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

// the file being looked at
let D = null;
// edits: per layer, what differs from the file; and the whole-picture changes
let ED = new Map();
let DOC = { crop: null, rot: 0, flipH: false, flipV: false };
let SEL = null;
let PREVIEW = null; // { id, canvas }: what the sliders show before "Apply"
let ACCURATE = null; // { url } while the real (Photoshop-style) picture is shown
let UNDO = [], REDO = [];
let HELPER_OK = false; // the helper passed its check once in this window: later files skip the check
let ZOOM = 1, PAN = { x: 0, y: 0 };
let FIT_PENDING = false, FIT_USER = false; // a fit waiting for a size; the person has zoomed or panned themself
let CROPPING = false;
const FOLD = new Set();
const IMGS = new Map();

const BLEND = { NORMAL: 'source-over', PASS_THROUGH: 'source-over', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten', COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' };
const KIND_NAME = { pixel: 'Pixels', group: 'Group', type: 'Text', shape: 'Shape', smartobject: 'Smart object', adjustment: 'Adjustment', solidcolorfill: 'Colour fill', gradientfill: 'Gradient fill', patternfill: 'Pattern fill', artboard: 'Artboard' };
const kindName = (k) => KIND_NAME[k] || (k || 'layer').replace(/^./, (c) => c.toUpperCase());

// ---------- reading layer state ----------
const meta = (id) => D.byId.get(id);
const ed = (id) => ED.get(id) || {};
const eff = (id) => { const m = meta(id), e = ed(id); return { visible: e.visible ?? m.visible, opacity: e.opacity ?? m.opacity, name: e.name ?? m.name, left: e.left ?? m.left, top: e.top ?? m.top, deleted: !!e.deleted }; };
const sourceOf = (id) => (PREVIEW?.id === id ? PREVIEW.canvas : ed(id).canvas || IMGS.get(id) || null);
const dims = (id) => { const s = sourceOf(id); return s ? [s.width, s.height] : [meta(id).width, meta(id).height]; };
const isEdited = (id) => { const e = ed(id); return e.canvas || e.deleted || e.visible != null && e.visible !== meta(id).visible || e.opacity != null && e.opacity !== meta(id).opacity || e.name != null && e.name !== meta(id).name; };
const dirty = () => ED.size > 0 && [...ED.keys()].some(isEdited) || !!DOC.crop || DOC.rot || DOC.flipH || DOC.flipV;
const canEditPixels = (id) => D.canEdit && meta(id).editable && !meta(id).isGroup;
const plainDoc = () => D.layers.every((l) => l.isGroup || (l.kind === 'pixel' && !l.hasMask && !l.hasEffects));

function setEd(id, patch) { ED.set(id, { ...ed(id), ...patch }); }
function snapshot() { return { ED: new Map([...ED].map(([k, v]) => [k, { ...v }])), DOC: { ...DOC, crop: DOC.crop ? [...DOC.crop] : null } }; }
function push() { UNDO.push(snapshot()); if (UNDO.length > 60) UNDO.shift(); REDO = []; }
function restore(s) { ED = new Map([...s.ED].map(([k, v]) => [k, { ...v }])); DOC = { ...s.DOC, crop: s.DOC.crop ? [...s.DOC.crop] : null }; PREVIEW = null; ACCURATE = null; changed(); }
function undo() { if (!UNDO.length) return; REDO.push(snapshot()); restore(UNDO.pop()); }
function redo() { if (!REDO.length) return; UNDO.push(snapshot()); restore(REDO.pop()); }

// ---------- drawing ----------
const blank = (w, h2) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h2); return c; };

function drawList(ctx, ids, W, H) {
  let i = 0;
  while (i < ids.length) {
    const id = ids[i];
    let j = i + 1;
    while (j < ids.length && meta(ids[j]).clipping) j++; // layers clipped to this one
    const e = eff(id);
    if (e.visible && !e.deleted) drawOne(ctx, id, ids.slice(i + 1, j), W, H);
    i = j;
  }
}
function drawOne(ctx, id, clipped, W, H) {
  const m = meta(id), e = eff(id);
  const op = BLEND[m.blend] || 'source-over';
  if (m.isGroup) {
    const kids = (D.kids.get(id) || []);
    if (m.blend === 'PASS_THROUGH' && e.opacity >= 255) { drawList(ctx, kids, W, H); return; }
    const off = blank(W, H);
    drawList(off.getContext('2d'), kids, W, H);
    ctx.save(); ctx.globalAlpha = e.opacity / 255; ctx.globalCompositeOperation = op === 'source-over' && m.blend === 'PASS_THROUGH' ? 'source-over' : op; ctx.drawImage(off, 0, 0); ctx.restore();
    return;
  }
  const src = sourceOf(id);
  if (!src) return;
  if (!clipped.length) {
    ctx.save(); ctx.globalAlpha = e.opacity / 255; ctx.globalCompositeOperation = op; ctx.drawImage(src, e.left, e.top); ctx.restore();
    return;
  }
  // a layer with others clipped to it: they only show where it has pixels
  const off = blank(W, H), oc = off.getContext('2d');
  oc.drawImage(src, e.left, e.top);
  for (const cid of clipped) {
    const ce = eff(cid), cs = sourceOf(cid);
    if (!ce.visible || ce.deleted || !cs) continue;
    oc.save(); oc.globalAlpha = ce.opacity / 255; oc.globalCompositeOperation = 'source-atop'; oc.drawImage(cs, ce.left, ce.top); oc.restore();
  }
  ctx.save(); ctx.globalAlpha = e.opacity / 255; ctx.globalCompositeOperation = op; ctx.drawImage(off, 0, 0); ctx.restore();
}

/** the picture with every change (layers on or off, edits, crop, turn) */
function composeAll() {
  const W = D.width, H = D.height;
  const full = blank(W, H);
  if (ACCURATE?.img) full.getContext('2d').drawImage(ACCURATE.img, 0, 0, W, H);
  else drawList(full.getContext('2d'), D.roots, W, H);
  const c = DOC.crop || [0, 0, W, H];
  const cw = c[2] - c[0], ch = c[3] - c[1];
  const turn = DOC.rot % 180 !== 0;
  const out = blank(turn ? ch : cw, turn ? cw : ch);
  const o = out.getContext('2d');
  o.save();
  o.translate(out.width / 2, out.height / 2);
  o.rotate((DOC.rot * Math.PI) / 180);
  o.scale(DOC.flipH ? -1 : 1, DOC.flipV ? -1 : 1);
  o.drawImage(full, c[0], c[1], cw, ch, -cw / 2, -ch / 2, cw, ch);
  o.restore();
  return out;
}

let raf = 0;
function render() {
  if (!D || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const out = composeAll();
    const cv = $('ps-cv');
    cv.width = out.width; cv.height = out.height;
    cv.getContext('2d').drawImage(out, 0, 0);
    placeView();
    drawCropBox();
  });
}
function placeView() { $('ps-view').style.transform = `translate(${PAN.x}px, ${PAN.y}px) scale(${ZOOM})`; $('ps-bar').dataset.zoom = Math.round(ZOOM * 100); renderBar(); }
function fit() {
  if (!D) return;
  const st = $('ps-stage').getBoundingClientRect();
  const c = $('ps-cv');
  const w = c.width || D.width, h2 = c.height || D.height;
  // a tab that is still hidden (or being laid out) has no size yet: fitting to it gave a negative zoom and an empty view,
  // so wait; the stage's resize watcher (wireStage) fits again once it has one
  if (st.width < 80 || st.height < 80) { FIT_PENDING = true; return; }
  FIT_PENDING = false; FIT_USER = false;
  ZOOM = Math.min((st.width - 40) / w, (st.height - 40) / h2, 1);
  PAN = { x: (st.width - w * ZOOM) / 2, y: (st.height - h2 * ZOOM) / 2 };
  placeView();
}

// ---------- layers panel ----------
function renderLayers() {
  tellState();
  const box = $('ps-layers');
  box.innerHTML = '';
  if (!D) return;
  box.append(h('div', { class: 'ps-tools ps-dup' },
    h('button', { class: 'btn small', onclick: () => setAllVisible(true) }, 'Show all'),
    h('button', { class: 'btn small', onclick: () => setAllVisible(false) }, 'Hide all'),
    h('button', { class: 'btn small' + (ACCURATE ? ' primary' : ''), title: 'Draw the picture the way Photoshop does (adjustment layers, fills and effects included). It follows the layers you turn on and off.', onclick: toggleAccurate }, 'Accurate preview')));
  if (D.warnings.length) box.append(h('div', { class: 'ps-note' }, ...D.warnings));
  const row = (id, depth) => {
    const m = meta(id), e = eff(id);
    const kids = D.kids.get(id) || [];
    const r = h('div', { class: 'ps-layer' + (SEL === id ? ' sel' : '') + (e.visible ? '' : ' off'), style: { paddingLeft: 4 + depth * 14 + 'px' }, title: `${e.name}\n${kindName(m.kind)} · ${m.blend.toLowerCase().replace(/_/g, ' ')} · ${Math.round((e.opacity / 255) * 100)}%` },
      m.isGroup ? h('span', { class: 'ps-fold', onclick: (ev) => { ev.stopPropagation(); FOLD.has(id) ? FOLD.delete(id) : FOLD.add(id); renderLayers(); } }, FOLD.has(id) ? '▸' : '▾') : h('span', { class: 'ps-fold' }),
      h('button', { class: 'ps-eye', title: 'Show or hide this layer (Alt+click: show only this one)', html: icon(e.visible ? 'eye' : 'eyeOff'), onclick: (ev) => { ev.stopPropagation(); if (ev.altKey) solo(id); else toggle(id); } }),
      h('span', { class: 'ps-lname' }, e.name),
      isEdited(id) ? h('span', { class: 'ps-edited', title: 'Changed since you opened it' }) : null,
      m.kind !== 'pixel' ? h('span', { class: 'ps-kind' }, kindName(m.kind)) : null);
    r.addEventListener('click', () => select(id));
    r.addEventListener('dblclick', () => rename(id));
    box.append(r);
    if (m.isGroup && !FOLD.has(id)) for (const k of [...kids].reverse()) row(k, depth + 1);
  };
  for (const id of [...D.roots].reverse()) row(id, 0);
}
function toggle(id) { push(); setEd(id, { visible: !eff(id).visible }); changed(); }
function solo(id) {
  push();
  for (const l of D.layers) if (!l.isGroup) setEd(l.id, { visible: l.id === id });
  // a layer is only seen when its groups are on too
  let p = meta(id).parent;
  while (p != null) { setEd(p, { visible: true }); p = meta(p).parent; }
  changed();
}
function setAllVisible(on) { push(); for (const l of D.layers) setEd(l.id, { visible: on }); changed(); }
async function rename(id) {
  const box = h('input', { class: 'input', value: eff(id).name, spellcheck: 'false' });
  const v = await modal({ title: 'Rename layer', width: 380, body: box, buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', primary: true, run: (close) => close(box.value.trim() || null) }] });
  if (v && v !== eff(id).name) { push(); setEd(id, { name: v }); changed(); }
}
function select(id) { SEL = id; PREVIEW = null; renderLayers(); renderSide(); }

function changed() { ACCURATE = ACCURATE && accurateStale() ? ACCURATE : ACCURATE; render(); renderLayers(); renderSide(); renderBar(); updateTitle(); if (ACCURATE) accurateSoon(); }
const accurateStale = () => false;

// ---------- the accurate preview (the file as Photoshop draws it) ----------
let accTimer = 0;
async function toggleAccurate() {
  if (ACCURATE) { ACCURATE = null; changed(); return; }
  ACCURATE = { img: null, busy: true };
  tellState(); renderLayers();
  await refreshAccurate();
}
function accurateSoon() { clearTimeout(accTimer); accTimer = setTimeout(refreshAccurate, 350); }
async function refreshAccurate() {
  if (!ACCURATE) return;
  const hide = [], show = [];
  for (const l of D.layers) { const v = eff(l.id).visible; if (v && !l.visible) show.push(l.id); if (!v && l.visible) hide.push(l.id); }
  busy('Drawing the picture the way Photoshop does…');
  try {
    const r = await api('psd:render', D.path, { hide, show, max: 4096 }, D.dir);
    const img = await load(fileUrl(r.path));
    if (!ACCURATE) return;
    ACCURATE.img = img; ACCURATE.busy = false;
    render();
  } catch (e) { ACCURATE = null; toast(errText(e), { error: true }); changed(); } finally { busy(null); }
}
const load = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('A picture could not be loaded')); i.src = url; });

// ---------- changing the picked layer ----------
const ADJ0 = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, gray: false, sepia: false, invert: false };
let ADJ = { ...ADJ0 };
const filterOf = (a) => `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturate}%) hue-rotate(${a.hue}deg) blur(${a.blur}px)${a.gray ? ' grayscale(1)' : ''}${a.sepia ? ' sepia(1)' : ''}${a.invert ? ' invert(1)' : ''}`;
const isNeutral = (a) => Object.keys(ADJ0).every((k) => a[k] === ADJ0[k]);

async function baseCanvasOf(id) {
  const e = ed(id);
  if (e.canvas) return e.canvas;
  // the layer's own pixels (without its mask and effects), fetched the first time it is edited
  if (!e.raw) {
    const r = await api('psd:raw', D.path, id, D.dir);
    const img = await load(fileUrl(r.png));
    const c = blank(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
    ED.set(id, { ...ed(id), raw: c, rawLeft: r.left, rawTop: r.top });
  }
  return ed(id).raw;
}
async function previewAdjust() {
  if (SEL == null || !canEditPixels(SEL)) return;
  if (isNeutral(ADJ)) { PREVIEW = null; render(); return; }
  const id = SEL;
  const base = await baseCanvasOf(id);
  if (SEL !== id) return;
  const pad = Math.ceil(ADJ.blur * 3);
  const c = blank(base.width + pad * 2, base.height + pad * 2);
  const g = c.getContext('2d');
  g.filter = filterOf(ADJ); g.drawImage(base, pad, pad); g.filter = 'none';
  c.dataset.pad = String(pad);
  PREVIEW = { id, canvas: c, pad };
  // blur grows the layer a little, so it moves back by the same amount
  PREVIEW.canvas._off = pad;
  render();
}
async function applyAdjust() {
  if (!PREVIEW) return;
  push();
  const { id, canvas, pad } = PREVIEW;
  const e = ed(id);
  const left = (e.canvas ? e.left : e.rawLeft ?? meta(id).left) - pad, top = (e.canvas ? e.top : e.rawTop ?? meta(id).top) - pad;
  setEd(id, { canvas, left, top });
  PREVIEW = null; ADJ = { ...ADJ0 };
  changed();
}
async function turnLayer(kind) {
  if (SEL == null || !canEditPixels(SEL)) return;
  const id = SEL;
  if (meta(id).hasMask) { toast('This layer has a mask, so it can’t be turned here. Edit it in Photoshop.', { error: true }); return; }
  const base = await baseCanvasOf(id);
  const e = ed(id);
  const left = e.canvas ? e.left : e.rawLeft ?? meta(id).left, top = e.canvas ? e.top : e.rawTop ?? meta(id).top;
  const w = base.width, h2 = base.height, cx = left + w / 2, cy = top + h2 / 2;
  const turn = kind === 'cw' || kind === 'ccw';
  const out = blank(turn ? h2 : w, turn ? w : h2);
  const g = out.getContext('2d');
  g.translate(out.width / 2, out.height / 2);
  if (kind === 'cw') g.rotate(Math.PI / 2); else if (kind === 'ccw') g.rotate(-Math.PI / 2);
  else if (kind === 'h') g.scale(-1, 1); else g.scale(1, -1);
  g.drawImage(base, -w / 2, -h2 / 2);
  push();
  setEd(id, { canvas: out, left: Math.round(cx - out.width / 2), top: Math.round(cy - out.height / 2) });
  PREVIEW = null; changed();
}
function deleteLayer() {
  if (SEL == null) return;
  push(); setEd(SEL, { deleted: true, visible: false }); SEL = null; changed();
}
function setOpacity(pct) { setEd(SEL, { opacity: Math.round((pct / 100) * 255) }); render(); renderLayers(); }

// ---------- the side panel ----------
function slider(label, key, min, max, step, unit = '') {
  const out = h('span', {}, String(ADJ[key]) + unit);
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(ADJ[key]) });
  input.addEventListener('input', () => { ADJ[key] = Number(input.value); out.textContent = input.value + unit; previewAdjust(); });
  return h('div', { class: 'ps-row' }, h('span', {}, label), input, out);
}
function check(label, key) {
  const c = h('input', { type: 'checkbox', ...(ADJ[key] ? { checked: '' } : {}) });
  c.addEventListener('change', () => { ADJ[key] = c.checked; previewAdjust(); });
  return h('label', { class: 'sd-check' }, c, ' ' + label);
}
function renderSide() {
  tellState();
  const box = $('ps-side');
  box.innerHTML = '';
  if (!D) return;
  const id = SEL;
  if (id == null || !D.byId.has(id)) {
    box.append(h('div', { class: 'ps-h' }, 'Layer'), h('div', { class: 'ps-note' }, 'Click a layer to change it. The eye turns a layer on or off. Alt+click an eye to see only that layer.'));
  } else {
    const m = meta(id), e = eff(id);
    box.append(h('div', { class: 'ps-h' }, 'Layer'), h('div', {}, h('b', {}, e.name)), h('div', { class: 'ps-note' }, `${kindName(m.kind)} · ${m.blend.toLowerCase().replace(/_/g, ' ')}${m.hasMask ? ' · has a mask' : ''}${m.hasEffects ? ' · has effects' : ''}`));
    const op = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round((e.opacity / 255) * 100)) });
    const opOut = h('span', {}, Math.round((e.opacity / 255) * 100) + '%');
    op.addEventListener('input', () => { opOut.textContent = op.value + '%'; setOpacity(Number(op.value)); });
    op.addEventListener('change', () => { /* one undo step per drag */ });
    op.addEventListener('pointerdown', () => push());
    box.append(h('div', { class: 'ps-row' }, h('span', {}, 'Opacity'), op, opOut));
    box.append(h('div', { class: 'ps-tools' }, h('button', { class: 'btn small', onclick: () => rename(id) }, 'Rename'), h('button', { class: 'btn small danger', onclick: deleteLayer }, 'Delete layer')));
    if (!m.isGroup) {
      if (!canEditPixels(id)) {
        box.append(h('div', { class: 'ps-note' }, D.canEdit ? `This is a ${kindName(m.kind).toLowerCase()} layer. Dogfile keeps it exactly as it is, so you can turn it on or off, rename it and change its opacity. Edit it in Photoshop.` : `This file is in ${D.mode} colour, so it can be looked at but not edited here.`));
      } else {
        box.append(h('div', { class: 'ps-h' }, 'Change this layer'),
          slider('Brightness', 'brightness', 0, 250, 1, '%'), slider('Contrast', 'contrast', 0, 250, 1, '%'), slider('Saturation', 'saturate', 0, 300, 1, '%'), slider('Hue', 'hue', -180, 180, 1, '°'), slider('Blur', 'blur', 0, 30, 0.5, ' px'),
          h('div', { class: 'ps-tools' }, check('Black and white', 'gray'), check('Sepia', 'sepia'), check('Invert', 'invert')),
          h('div', { class: 'ps-tools' }, h('button', { class: 'btn small primary', onclick: applyAdjust }, 'Apply'), h('button', { class: 'btn small', onclick: () => { ADJ = { ...ADJ0 }; PREVIEW = null; render(); renderSide(); } }, 'Reset')),
          h('div', { class: 'ps-tools ps-dup' }, ...[['ccw', '⟲ Turn left'], ['cw', '⟳ Turn right'], ['h', '⇋ Flip'], ['v', '⇅ Flip']].map(([k, t]) => h('button', { class: 'btn small', title: m.hasMask ? 'This layer has a mask' : '', onclick: () => turnLayer(k) }, t))));
      }
    }
  }
  // the whole picture
  const plain = plainDoc();
  box.append(h('div', { class: 'ps-h ps-dup' }, 'Whole picture'),
    h('div', { class: 'ps-tools ps-dup' },
      h('button', { class: 'btn small' + (CROPPING ? ' primary' : ''), disabled: !D.canEdit || !plainDoc() ? '' : null, title: !plain ? 'Cropping is for files made only of pixel layers. Text, shapes and smart objects keep their place in their own data, which Dogfile doesn’t rewrite.' : 'Drag on the picture to choose what to keep', onclick: toggleCrop }, CROPPING ? 'Drag to crop…' : 'Crop'),
      DOC.crop ? h('button', { class: 'btn small', onclick: () => { push(); DOC.crop = null; changed(); } }, 'Clear crop') : null),
    h('div', { class: 'ps-tools ps-dup' }, ...[['⟲ Turn left', () => turnDoc(-90)], ['⟳ Turn right', () => turnDoc(90)], ['⇋ Flip', () => flipDoc('h')], ['⇅ Flip', () => flipDoc('v')]].map(([t, fn]) => h('button', { class: 'btn small', ...(!D.canEdit || !plain ? { disabled: '', title: 'Turning the whole picture is for files made only of plain pixel layers (no text, shapes, smart objects, masks or effects). Turn a single layer instead.' } : {}), onclick: fn }, t))));
}
function turnDoc(deg) { push(); DOC.rot = ((DOC.rot + deg) % 360 + 360) % 360; DOC.crop = null; changed(); setTimeout(fit, 30); }
function flipDoc(k) { push(); if (k === 'h') DOC.flipH = !DOC.flipH; else DOC.flipV = !DOC.flipV; changed(); }
function renderBar() {
  const bar = $('ps-bar');
  if (!D) { bar.textContent = ''; return; }
  const c = DOC.crop;
  const w = c ? c[2] - c[0] : D.width, h2 = c ? c[3] - c[1] : D.height, turn = DOC.rot % 180 !== 0;
  bar.textContent = `${turn ? h2 : w} × ${turn ? w : h2} px · ${plural(D.layers.filter((l) => !l.isGroup).length, 'layer')} · ${D.depth}-bit ${D.mode} · ${Math.round(ZOOM * 100)}%${dirty() ? ' · unsaved changes' : ''}`;
}

// ---------- crop ----------
function toggleCrop() { CROPPING = !CROPPING; $('ps-stage').classList.toggle('cropping', CROPPING); renderSide(); }
function drawCropBox() {
  const box = $('ps-crop');
  box.style.display = 'none';
}
let cropDrag = null;
function stagePoint(ev) {
  const r = $('ps-stage').getBoundingClientRect();
  const c = DOC.crop || [0, 0, D.width, D.height];
  const x = (ev.clientX - r.left - PAN.x) / ZOOM, y = (ev.clientY - r.top - PAN.y) / ZOOM;
  return { x: Math.round(Math.max(0, Math.min($('ps-cv').width, x))), y: Math.round(Math.max(0, Math.min($('ps-cv').height, y))), c };
}
// ---------- moving a layer (Ctrl + drag) ----------
// the picture on screen has the crop / turn / flip applied; these go back from a point (or a movement) on it to the file's own pixels
function docMap(x, y, vector) {
  const c = DOC.crop || [0, 0, D.width, D.height], cw = c[2] - c[0], ch = c[3] - c[1];
  const turn = DOC.rot % 180 !== 0, ow = turn ? ch : cw, oh = turn ? cw : ch;
  let dx = vector ? x : x - ow / 2, dy = vector ? y : y - oh / 2;
  const a = (-DOC.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  [dx, dy] = [dx * co - dy * si, dx * si + dy * co];
  if (DOC.flipH) dx = -dx;
  if (DOC.flipV) dy = -dy;
  return vector ? [dx, dy] : [dx + cw / 2 + c[0], dy + ch / 2 + c[1]];
}
/** the top layer that has a visible pixel under this point of the file (or null) */
function layerAt(x, y) {
  const probe = blank(1, 1), g = probe.getContext('2d', { willReadFrequently: true });
  const shown = (id) => { for (let p = id; p != null; p = meta(p).parent) { const e = eff(p); if (!e.visible || e.deleted) return false; } return true; };
  const topDown = [];
  const walk = (ids) => { for (const id of [...ids].reverse()) { topDown.push(meta(id)); if (meta(id).isGroup) walk(D.kids.get(id) || []); } };
  walk(D.roots);
  for (const l of topDown) {
    if (l.isGroup || !shown(l.id)) continue;
    const src = sourceOf(l.id);
    if (!src) continue;
    const e = eff(l.id), px = Math.floor(x - e.left), py = Math.floor(y - e.top);
    if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
    g.clearRect(0, 0, 1, 1); g.drawImage(src, -px, -py);
    if (g.getImageData(0, 0, 1, 1).data[3] > 8) return l.id;
  }
  return null;
}
let moving = null;
async function startMove(ev) {
  const r = $('ps-stage').getBoundingClientRect();
  const cx = (ev.clientX - r.left - PAN.x) / ZOOM, cy = (ev.clientY - r.top - PAN.y) / ZOOM;
  const [fx, fy] = docMap(cx, cy);
  const id = layerAt(fx, fy) ?? (SEL != null && D.byId.has(SEL) ? SEL : null);
  if (id == null) { toast('Ctrl+drag moves the layer under the pointer: there is none here.'); return; }
  if (!canEditPixels(id)) { toast(D.canEdit ? `“${eff(id).name}” is a ${kindName(meta(id).kind).toLowerCase()} layer. Dogfile keeps it where it is; move it in Photoshop.` : `This file is in ${D.mode} colour, so it can be looked at but not edited here.`, { error: true }); return; }
  if (meta(id).hasMask) { toast('This layer has a mask, so it can’t be moved here. Move it in Photoshop.', { error: true }); return; }
  if (SEL !== id) select(id);
  const m = { id, x0: ev.clientX, y0: ev.clientY, l0: eff(id).left, t0: eff(id).top, base: null, started: false };
  moving = m;
  $('ps-stage').classList.add('moving');
  try { m.base = await baseCanvasOf(id); } catch (e) { moving = null; $('ps-stage').classList.remove('moving'); toast(errText(e), { error: true }); }
}
function doMove(ev) {
  const m = moving;
  if (!m || !m.base) return;
  const [vx, vy] = docMap((ev.clientX - m.x0) / ZOOM, (ev.clientY - m.y0) / ZOOM, true);
  const left = m.l0 + Math.round(vx), top = m.t0 + Math.round(vy);
  if (!m.started) { if (left === m.l0 && top === m.t0) return; push(); m.started = true; }
  const e = ed(m.id);
  setEd(m.id, { canvas: e.canvas || m.base, left, top });
  PREVIEW = null;
  render();
}
function endMove() {
  const m = moving;
  moving = null;
  $('ps-stage').classList.remove('moving');
  if (m?.started) changed();
}

function wireStage() {
  const st = $('ps-stage');
  // the picture follows the window until the person zooms or moves it themself (and fits once the tab first has a size)
  if (window.ResizeObserver) new ResizeObserver(() => { if (D && (FIT_PENDING || !FIT_USER)) fit(); }).observe(st);
  st.addEventListener('pointerdown', () => { FIT_USER = true; });
  st.addEventListener('wheel', (ev) => {
    if (!D) return;
    ev.preventDefault();
    const r = st.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const z = Math.max(0.05, Math.min(16, ZOOM * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    PAN.x = mx - ((mx - PAN.x) / ZOOM) * z; PAN.y = my - ((my - PAN.y) / ZOOM) * z; ZOOM = z; FIT_USER = true; placeView();
  }, { passive: false });
  let pan = null;
  st.addEventListener('pointerdown', (ev) => {
    if (!D) return;
    try { st.setPointerCapture(ev.pointerId); } catch { /* a synthetic event has no pointer to capture */ }
    if ((ev.ctrlKey || ev.metaKey) && !CROPPING) { startMove(ev); return; }
    if (CROPPING) { const p = stagePoint(ev); cropDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
    pan = { x: ev.clientX - PAN.x, y: ev.clientY - PAN.y };
  });
  st.addEventListener('pointermove', (ev) => {
    if (moving) { doMove(ev); return; }
    if (cropDrag) {
      const p = stagePoint(ev); cropDrag.x1 = p.x; cropDrag.y1 = p.y;
      const box = $('ps-crop');
      box.style.display = 'block';
      box.style.left = Math.min(cropDrag.x0, cropDrag.x1) + 'px'; box.style.top = Math.min(cropDrag.y0, cropDrag.y1) + 'px';
      box.style.width = Math.abs(cropDrag.x1 - cropDrag.x0) + 'px'; box.style.height = Math.abs(cropDrag.y1 - cropDrag.y0) + 'px';
    } else if (pan) { PAN = { x: ev.clientX - pan.x, y: ev.clientY - pan.y }; placeView(); }
  });
  st.addEventListener('pointerup', () => {
    if (moving) endMove();
    if (cropDrag) {
      const d = cropDrag; cropDrag = null; $('ps-crop').style.display = 'none';
      const l = Math.min(d.x0, d.x1), t = Math.min(d.y0, d.y1), r = Math.max(d.x0, d.x1), b = Math.max(d.y0, d.y1);
      if (r - l >= 8 && b - t >= 8) {
        // what was dragged is on the picture as shown (no turn yet when cropping), so it is also the place in the file
        push();
        const o = DOC.crop || [0, 0, D.width, D.height];
        DOC.crop = [o[0] + l, o[1] + t, o[0] + r, o[1] + b];
        CROPPING = false; $('ps-stage').classList.remove('cropping');
        changed(); setTimeout(fit, 30);
      }
    }
    pan = null;
  });
  st.addEventListener('dblclick', () => fit());
}

// ---------- opening ----------
// the loading screen: a message and a bar. `frac` 0..1 fills the bar; without it the bar slides back and forth (the
// helper reads the whole file in one go, so there is no count to show until the layers start loading)
function busy(msg, frac) {
  const b = $('ps-busy');
  b.classList.toggle('on', !!msg);
  b.querySelector('.msg').textContent = msg || '';
  const bar = b.querySelector('.bar'), fill = b.querySelector('.fill');
  bar.classList.toggle('indeterminate', frac == null);
  fill.style.width = frac == null ? '' : Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}
function empty(html) { const e = $('ps-empty'); e.innerHTML = ''; if (html) e.append(html); }
function updateTitle() { const n = D ? basename(D.path) : 'Dogfile PSD'; $('ps-name').textContent = n + (dirty() ? ' •' : ''); $('ps-sub').textContent = D ? `${plural(D.layers.filter((l) => !l.isGroup).length, 'layer')}` : ''; setTitle(n); renderActions(); }

export async function openFile(path) {
  if (D && dirty() && !(await confirm('Close this file?', 'You have changes that aren’t saved.', { ok: 'Close without saving', danger: true }))) return;
  empty(null); busy('Checking the Photoshop helper…');
  const status = HELPER_OK ? { ready: true } : await api('psd:status').catch(() => ({ ready: false }));
  busy(null);
  if (status.ready) HELPER_OK = true;
  if (!status.ready && status.installed) {
    empty(h('div', {}, h('div', { class: 'confirm-msg' }, 'The Photoshop helper is installed but doesn’t work: ' + (status.error || 'unknown problem')), h('div', { class: 'ps-note' }, 'Update Dogfile to get a fixed copy, or open the flat picture meanwhile.'), h('div', { class: 'ps-tools', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => openFile(path) }, 'Try again'), h('button', { class: 'btn', onclick: () => api('tool:open', 'viewer', [path], {}) }, 'Open the flat picture instead'))));
    return;
  }
  if (!status.ready) {
    if (!(await ensureComponent('psd', 'Opening a Photoshop file with its layers'))) {
      empty(h('div', {}, h('div', { class: 'confirm-msg' }, 'Photoshop layers need a one-time download.'), h('div', { class: 'ps-tools', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => openFile(path) }, 'Try again'), h('button', { class: 'btn', onclick: () => api('tool:open', 'viewer', [path], {}) }, 'Open the flat picture instead'))));
      return;
    }
  }
  closeCurrent();
  empty(null); busy(`Loading ${basename(path)}… reading the layers (large files take a few seconds)`);
  let info;
  try { info = await api('psd:open', path); } catch (e) {
    busy(null);
    empty(h('div', {}, h('div', { class: 'confirm-msg' }, errText(e)), h('div', { class: 'ps-tools', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => api('tool:open', 'viewer', [path], {}) }, 'Open the flat picture instead'))));
    return;
  }
  D = { path, ...info, byId: new Map(), kids: new Map(), roots: [] };
  for (const l of D.layers) D.byId.set(l.id, l);
  for (const l of D.layers) {
    if (l.parent == null) D.roots.push(l.id);
    else { if (!D.kids.has(l.parent)) D.kids.set(l.parent, []); D.kids.get(l.parent).push(l.id); }
  }
  ED = new Map(); DOC = { crop: null, rot: 0, flipH: false, flipV: false }; SEL = null; PREVIEW = null; ACCURATE = null; UNDO = []; REDO = []; IMGS.clear();
  let done = 0;
  busy(`Loading layers… 0 of ${D.layers.filter((l) => l.png).length}`, 0.3);
  const jobs = D.layers.filter((l) => l.png);
  const total = jobs.length;
  const queue = [...jobs];
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      try { IMGS.set(l.id, await load(fileUrl(l.png))); } catch { /* the layer stays out of the picture */ }
      busy(`Loading layers… ${++done} of ${total}`, 0.3 + 0.7 * (done / Math.max(1, total)));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  busy(null);
  render(); renderLayers(); renderSide(); updateTitle();
  setTimeout(fit, 30);
  // adjustment layers and fills change what is under them, which only the real drawing shows
  if (D.adjustmentIds?.length) { ACCURATE = { img: null }; renderLayers(); refreshAccurate(); toast('This file has adjustment layers, so the picture is drawn the way Photoshop does (Accurate preview).', { ms: 6000 }); }
  if (!D.layers.length) toast('This file has no layers; it is shown as one picture.');
}
function closeCurrent() { if (D?.dir) api('psd:clean', D.dir).catch(() => {}); }

// ---------- saving ----------
async function save() {
  if (!D) return;
  if (!dirty()) { toast('Nothing has changed'); return; }
  const choice = await modal({
    title: 'Save the Photoshop file', width: 480,
    body: h('div', { class: 'confirm-msg' }, 'Every layer stays in the saved PSD, so Photoshop opens it as it was. Choose how to save it:'),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Overwrite the original', value: 'over' }, { label: 'Save as a copy…', primary: true, value: 'copy' }],
  });
  if (!choice) return;
  let dest = D.path;
  if (choice === 'copy') {
    const stem = basename(D.path).replace(/\.[^.]+$/, ''), ext = (D.path.match(/\.[^.\\/]+$/) || ['.psd'])[0];
    dest = await api('dialog:saveFile', { title: 'Save a copy', defaultPath: `${stem} (edited)${ext}`, filters: [{ name: 'Photoshop', extensions: [ext.slice(1)] }] });
    if (!dest) return;
  } else if (!(await confirm('Overwrite the original?', 'The file is replaced with this version. A copy of the original is kept first, in Dogfile’s backup folder.', { ok: 'Overwrite' }))) return;
  busy('Saving…');
  try {
    const layers = {};
    for (const l of D.layers) {
      const e = ed(l.id), m = l, patch = {};
      if (e.deleted) { patch.delete = true; layers[l.id] = patch; continue; }
      if (e.visible != null && e.visible !== m.visible) patch.visible = e.visible;
      if (e.opacity != null && e.opacity !== m.opacity) patch.opacity = e.opacity;
      if (e.name != null && e.name !== m.name) patch.name = e.name;
      if (e.canvas) {
        const file = `${D.dir}${D.dir.includes('\\') ? '\\' : '/'}edit-${l.id}.png`;
        await api('fs:writeDataUrl', file, e.canvas.toDataURL('image/png'));
        patch.pixels = file; patch.left = e.left; patch.top = e.top;
      }
      if (Object.keys(patch).length) layers[l.id] = patch;
    }
    const doc = {};
    if (DOC.crop) doc.crop = DOC.crop;
    if (DOC.rot) doc.rotate = DOC.rot;
    if (DOC.flipH) doc.flipH = true;
    if (DOC.flipV) doc.flipV = true;
    const r = await api('psd:save', { src: D.path, dest, layers, doc }, D.dir);
    toast(`Saved ${basename(dest)} with ${plural(r.layers, 'layer')}${r.backup ? '. The original was kept as a backup' : ''}`, { ok: true, ms: 6000 });
    if (dest === D.path) await reopen(dest); else { UNDO = []; REDO = []; ED = new Map(); DOC = { crop: null, rot: 0, flipH: false, flipV: false }; await reopen(dest); }
  } catch (e) { toast(errText(e), { error: true, ms: 9000 }); } finally { busy(null); }
}
async function reopen(path) { ED = new Map(); DOC = { crop: null, rot: 0, flipH: false, flipV: false }; await openFile(path); }

async function exportFlat() {
  if (!D) return;
  const stem = basename(D.path).replace(/\.[^.]+$/, '');
  const dest = await api('dialog:saveFile', { title: 'Save a flat picture', defaultPath: `${stem}.png`, filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }] });
  if (!dest) return;
  const jpg = /\.jpe?g$/i.test(dest);
  const c = composeAll();
  if (jpg) { const f = blank(c.width, c.height); const g = f.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, f.width, f.height); g.drawImage(c, 0, 0); await api('fs:writeDataUrl', dest, f.toDataURL('image/jpeg', 0.92)); } else await api('fs:writeDataUrl', dest, c.toDataURL('image/png'));
  toast(`Saved ${basename(dest)}`, { ok: true });
}

async function openDialog() {
  const f = await api('dialog:openFiles', { title: 'Open a Photoshop file', filters: [{ name: 'Photoshop', extensions: ['psd', 'psb'] }] });
  if (f?.[0]) openFile(f[0]);
}

// what turn / flip works on: the picked layer, or (nothing picked) the whole picture; null when it can't be done
function xformTarget() {
  if (!D || !D.canEdit) return null;
  if (SEL != null && D.byId.has(SEL)) return canEditPixels(SEL) && !meta(SEL).hasMask ? 'layer' : null;
  return plainDoc() ? 'picture' : null;
}
function xform(layerKind, docFn) { const t = xformTarget(); if (t === 'layer') turnLayer(layerKind); else if (t === 'picture') docFn(); }

// what the main window's ribbon (PSD tab) needs to know to show its buttons as on or off
let stateTimer = 0;
function tellState() {
  if (!EMBED) return;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const plain = !!D && D.canEdit && plainDoc();
    tellHost({ type: 'state', kind: 'psd', path: D?.path || null, open: !!D, canUndo: UNDO.length > 0, canRedo: REDO.length > 0, dirty: !!D && !!dirty(),
      wholeOk: plain, cropping: CROPPING, hasCrop: !!DOC.crop, accurate: !!ACCURATE,
      xform: xformTarget(), hasLayer: !!D && SEL != null });
  }, 30);
}

function renderActions() {
  tellState();
  const a = $('ps-actions');
  a.innerHTML = '';
  const b = (ic, label, fn, dis) => h('button', { class: 'btn small', title: label, ...(dis ? { disabled: '' } : {}), onclick: fn }, h('span', { html: icon(ic) }), ' ' + label);
  a.append(b('folderOpen', 'Open…', openDialog),
    b('undo', 'Undo', undo, !UNDO.length), b('redo', 'Redo', redo, !REDO.length),
    b('image', 'Save flat picture…', exportFlat, !D),
    h('button', { class: 'btn small primary', ...(D && dirty() ? {} : { disabled: '' }), onclick: save }, h('span', { html: icon('save') }), ' Save…'));
}

// ---------- start ----------
async function boot() {
  const sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  document.body.classList.toggle('in-tab', !!EMBED);
  const st = await api('store:get', 'settings');
  if ((st?.language || 'auto') !== 'en') import('./i18n.js').then((m) => m.initI18n(st?.language || 'auto')).catch(() => {});
  const settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  applyColors(mediaSettings(settings));
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  wireStage(); renderActions(); renderBar();
  const pending = await pendingFiles();
  // a file is on its way: no "open a file" screen flashing before it
  if (!pending?.files?.length) { busy(null); empty(h('div', {}, h('div', { class: 'ps-h' }, 'Dogfile PSD'), h('div', { class: 'confirm-msg' }, 'Open a Photoshop file (.psd or .psb) to see its layers.'), h('button', { class: 'btn primary', onclick: openDialog }, 'Open a file…'))); }
  else busy('Opening…');
  if (pending?.files?.length) await openFile(pending.files[0]);
  document.body.classList.add('ready');
}
window.addEventListener('keydown', (e) => {
  const c = e.ctrlKey || e.metaKey;
  if (c && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (c && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (c && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  else if (e.key === '0' && c) { e.preventDefault(); fit(); }
  else if (e.key === 'Escape' && SEL != null && !CROPPING) { SEL = null; PREVIEW = null; renderLayers(); renderSide(); }
});
const leave = async () => (D && dirty() ? confirm('Close this file?', 'You have changes that aren’t saved.', { ok: 'Close without saving', danger: true }) : true);
onLeave(leave); onWindowClose(leave);
onMain('psd:open', ({ files }) => files?.[0] && openFile(files[0]));
onMain('settings:changed', (s) => { applyColors(mediaSettings({ ...DEFAULT_SETTINGS, ...s })); });
// the ribbon's buttons (see ctxribbon.js): each does what the matching button in the window does
const RIBBON = {
  open: openDialog, save, saveFlat: exportFlat, undo, redo,
  crop: () => { if (D && D.canEdit && plainDoc()) toggleCrop(); },
  clearCrop: () => { if (DOC.crop) { push(); DOC.crop = null; changed(); } },
  turnL: () => xform('ccw', () => turnDoc(-90)), turnR: () => xform('cw', () => turnDoc(90)),
  flipH: () => xform('h', () => flipDoc('h')), flipV: () => xform('v', () => flipDoc('v')),
  showAll: () => D && setAllVisible(true), hideAll: () => D && setAllVisible(false), accurate: () => D && toggleAccurate(),
  fit: () => fit(),
};
onHost({ open: (m) => m.files?.[0] && openFile(m.files[0]), cmd: (id) => RIBBON[id]?.() });
window.addEventListener('pagehide', closeCurrent);
boot().catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#f66">${esc(e.stack || e.message)}</pre>`; });
