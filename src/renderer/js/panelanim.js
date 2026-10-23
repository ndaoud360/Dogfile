// Panels that come out of an edge (details pane, assistant, ribbon, status bar, terminal, Drop Shelf, activity,
// and the sidebar) open and close with the same paper fold as the sidebar, turned to their edge: left and right
// panels fold sideways, top and bottom ones fold up and down. Each panel can instead slide, or just appear
// (Settings › Appearance › Panel animations).
//
// The fold: the panel is split in two halves along its depth. The half at the edge tilts by θ = acos(p) and the
// far half by −2θ relative to it, so the free edge lands exactly at depth·p, like a sheet folding flat against
// the window edge. Built from snapshots of the real panel, so it works for anything without special code.
import { state } from './core.js';

export const PANELS = {
  sidebar: ['Sidebar', 'left'], preview: ['Details pane', 'right'], assistant: ['Assistant', 'right'],
  ribbon: ['Ribbon', 'top'], status: ['Status bar', 'bottom'], terminal: ['Terminal', 'bottom'],
  shelf: ['Drop Shelf', 'bottom'], ops: ['Activity', 'bottom'],
};
export const MODES = [['fold', 'Fold'], ['slide', 'Slide'], ['none', 'No animation']];
const reduced = () => document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
/** how this panel animates: 'fold' (default), 'slide' or 'none' */
export function panelMode(name) {
  if (reduced()) return 'none';
  const m = state.settings.panelAnims?.[name];
  if (m === 'slide' || m === 'none' || m === 'fold') return m;
  // the old on/off switch for the sidebar fold
  if (name === 'sidebar' && state.settings.foldAnimation === false) return 'slide';
  return 'fold';
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v) => Math.max(0, Math.min(1, v));
const busy = new WeakMap();
// nothing animates while the window is first being put together
let live = false;
setTimeout(() => { live = true; }, 1200);
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

function snapshot(el, w, h) {
  // ids stay: panels are styled by them (#statusbar…); the real panel comes first, so lookups still find it
  const c = el.cloneNode(true);
  c.classList.add('pa-snap');
  Object.assign(c.style, { width: w + 'px', height: h + 'px', position: 'absolute', left: '0', top: '0', margin: '0', display: getComputedStyle(el).display === 'none' ? 'block' : getComputedStyle(el).display, visibility: 'visible', transform: 'none', animation: 'none' });
  // canvases (terminal, charts) come out blank in a copy: show what they hold
  const src = el.querySelectorAll('canvas'), dst = c.querySelectorAll('canvas');
  src.forEach((cv, i) => { try { const d = dst[i]; d.width = cv.width; d.height = cv.height; d.getContext('2d')?.drawImage(cv, 0, 0); } catch {} });
  return c;
}

/** the fold layer over `rect`; render(p) shows it opened by p (0 = flat against the edge, 1 = fully open) */
function foldLayer(el, rect, edge) {
  const horiz = edge === 'left' || edge === 'right';
  const W = rect.width, H = rect.height, D = horiz ? W : H;
  const bg = getComputedStyle(el).backgroundColor;
  const layer = document.createElement('div');
  layer.className = 'pa-layer';
  Object.assign(layer.style, { left: rect.left + 'px', top: rect.top + 'px', width: W + 'px', height: H + 'px' });
  // the 3D part has its own stage, so the flat backing behind it never covers the folding halves
  const stage = document.createElement('div');
  stage.className = 'pa-stage';
  stage.style.perspective = Math.round(1100 * Math.max(1, (horiz ? H : W) / 640)) + 'px';
  const back = document.createElement('div');
  back.className = 'pa-back';
  back.style.background = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : 'var(--bg-body)';
  // the half at the edge ("near") holds the half away from it ("far")
  const near = document.createElement('div'), far = document.createElement('div');
  near.className = 'pa-panel'; far.className = 'pa-panel';
  const half = D / 2;
  const box = (n, pos) => Object.assign(n.style, horiz ? { width: half + 'px', height: H + 'px', top: '0' } : { height: half + 'px', width: W + 'px', left: '0' }, pos);
  // near sits against the edge; far sits on near's inner side
  if (edge === 'left') { box(near, { left: '0' }); box(far, { left: half + 'px' }); near.style.transformOrigin = 'left center'; far.style.transformOrigin = 'left center'; }
  if (edge === 'right') { box(near, { left: half + 'px' }); box(far, { left: -half + 'px' }); near.style.transformOrigin = 'right center'; far.style.transformOrigin = 'right center'; }
  if (edge === 'top') { box(near, { top: '0' }); box(far, { top: half + 'px' }); near.style.transformOrigin = 'center top'; far.style.transformOrigin = 'center top'; }
  if (edge === 'bottom') { box(near, { top: half + 'px' }); box(far, { top: -half + 'px' }); near.style.transformOrigin = 'center bottom'; far.style.transformOrigin = 'center bottom'; }
  // each half shows its part of the panel
  const fill = (n, offset) => {
    const clip = document.createElement('div'); clip.className = 'pa-clip';
    const s = snapshot(el, W, H);
    s.style[horiz ? 'left' : 'top'] = -offset + 'px';
    clip.append(s);
    const shade = document.createElement('div'); shade.className = 'pa-shade';
    n.append(clip, shade);
    return shade;
  };
  const nearOff = edge === 'right' || edge === 'bottom' ? half : 0;
  const farOff = edge === 'right' || edge === 'bottom' ? 0 : half;
  const sn = fill(near, nearOff), sf = fill(far, farOff);
  near.append(far);
  stage.append(near);
  layer.append(back, stage);
  document.body.append(layer);
  // which way each half turns so the free edge folds back away from the viewer
  const sign = edge === 'left' || edge === 'bottom' ? 1 : -1;
  const rot = horiz ? 'rotateY' : 'rotateX';
  const render = (p) => {
    p = clamp(p);
    const th = Math.acos(p);
    near.style.transform = `${rot}(${sign * th}rad)`;
    far.style.transform = `${rot}(${-2 * sign * th}rad)`;
    sn.style.opacity = sf.style.opacity = String((1 - p) * 0.85);
    near.style.visibility = p < 0.004 ? 'hidden' : 'visible';
    // the backing grows from the edge with the fold
    const d = D * p;
    Object.assign(back.style, horiz ? { width: d + 'px', height: H + 'px', top: '0', [edge]: '0' } : { height: d + 'px', width: W + 'px', left: '0', [edge]: '0' });
  };
  return { layer, render };
}
/** the slide layer: the panel's snapshot moving in from its edge */
function slideLayer(el, rect, edge) {
  const layer = document.createElement('div');
  layer.className = 'pa-layer pa-slide';
  Object.assign(layer.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', overflow: 'hidden' });
  const s = snapshot(el, rect.width, rect.height);
  layer.append(s);
  document.body.append(layer);
  const horiz = edge === 'left' || edge === 'right';
  const D = horiz ? rect.width : rect.height;
  const dir = edge === 'left' || edge === 'top' ? -1 : 1;
  const render = (p) => { s.style.transform = `${horiz ? 'translateX' : 'translateY'}(${dir * D * (1 - clamp(p))}px)`; };
  return { layer, render };
}

function play(render, from, to, dur) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    render(from);
    const step = (now) => {
      const k = clamp((now - t0) / dur);
      render(from + (to - from) * ease(k));
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * The real space a panel takes, set by hand while it animates, so whatever sits beside it slides along smoothly
 * instead of jumping when the panel appears or goes. null gives the space back to the stylesheet.
 */
function sizer(name, el, edge) {
  if (name === 'preview') {
    const ws = document.getElementById('workspace');
    return (px) => { ws.style.gridTemplateColumns = px == null ? '' : `1fr ${px > 0.5 ? 1 : 0}px ${px}px`; };
  }
  // overlays (assistant, activity) float over everything: nothing beside them moves
  const pos = getComputedStyle(el).position;
  if (pos === 'absolute' || pos === 'fixed') return () => {};
  const prop = edge === 'left' || edge === 'right' ? 'width' : 'height';
  const minProp = prop === 'width' ? 'minWidth' : 'minHeight';
  return (px) => {
    if (px == null) { el.style[prop] = ''; el.style[minProp] = ''; el.style.overflow = ''; el.style.flexBasis = ''; return; }
    el.style[prop] = px + 'px'; el.style[minProp] = '0px'; el.style.flexBasis = 'auto'; el.style.overflow = 'hidden';
  };
}

/**
 * Show or hide a panel with its animation. `apply()` makes the real change (classes, layout); `el` is the panel.
 * Showing: the panel is measured where it will sit, then its space grows from nothing while it folds open.
 * Hiding: it folds shut while its space shrinks away, and only then is it really hidden.
 */
export async function animatePanel(name, el, show, apply, { edge = PANELS[name]?.[1] || 'left', dur, applied = false } = {}) {
  const mode = panelMode(name);
  if (!el || mode === 'none' || busy.get(el) || !live) { apply(); return; }
  const visible = () => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).display !== 'none' ? r : null; };
  const was = applied ? null : visible();
  if (!applied && show === !!was) { apply(); return; }
  const size = sizer(name, el, edge);
  const horiz = edge === 'left' || edge === 'right';
  busy.set(el, true);
  try {
    let rect;
    // everything up to the first frame happens before anything is painted: no flash of the panel
    if (show) {
      if (!applied) apply();
      size(null);
      rect = visible();
      if (!rect) return;
      size(0);
      el.style.visibility = 'hidden';
    } else rect = was;
    const D = horiz ? rect.width : rect.height;
    const L = (mode === 'slide' ? slideLayer : foldLayer)(el, rect, edge);
    const time = dur || (mode === 'slide' ? 260 : Math.round(Math.min(560, 380 + D * 0.4)));
    const step = (p) => { L.render(p); size(D * clamp(p)); };
    if (show) {
      await play(step, 0, 1, time);
    } else {
      el.style.visibility = 'hidden';
      await play(step, 1, 0, time);
      apply();
    }
    size(null);
    el.style.visibility = '';
    // the layer goes on the next frame, once the real panel is painted underneath: no blink at the end
    await frame();
    L.layer.remove();
    window.dispatchEvent(new Event('resize'));
  } finally { busy.delete(el); }
}

/** a body class that shows or hides a panel, animated when it changes */
export function panelClass(name, el, cls, on, opts) {
  const has = document.body.classList.contains(cls);
  if (has === on) return;
  // the class "shows" the panel unless it's a no-… class (no-status hides the status bar)
  const showing = cls.startsWith('no-') ? !on : on;
  return animatePanel(name, el, showing, () => document.body.classList.toggle(cls, on), opts);
}
