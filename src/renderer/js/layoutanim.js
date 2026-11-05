// Layout animations.
//  - Switching a pane's view (Details / Columns / Grid / Gallery / List): the old view slides out and the new one
//    slides in, in the direction of the buttons (moving right along the toolbar slides left, like turning a page).
//  - Switching the pane layout (1 pane, 2 side by side, 2 stacked, 3, 4): panes that stay glide from where they
//    were, and new panes slide in from the edge they are split off.
// Everything is a Web Animation that cleans up after itself, and is skipped when the person asked for reduced motion
// (Settings › Accessibility, or the system setting), so a view change is never delayed or left half-drawn.

const reduced = () => document.body.classList.contains('reduce-motion');
export const VIEW_ORDER = ['details', 'list', 'columns', 'grid', 'gallery'];
const EASE = 'cubic-bezier(.2,.8,.2,1)';
export const SLIDE_MS = 260;

/** +1 when `to` is further along the toolbar than `from` (new view arrives from the right), -1 otherwise */
export function viewDirection(from, to) {
  const a = VIEW_ORDER.indexOf(from), b = VIEW_ORDER.indexOf(to);
  return b >= a ? 1 : -1;
}

/** take a picture of a pane's current view so it can slide out while the new one slides in */
export function snapshotView(el) {
  if (reduced() || !el?.scroller || !el.body?.isConnected) return null;
  const r = el.body.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return null;
  const copy = el.scroller.cloneNode(true);
  copy.classList.add('view-ghost');
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.scrollTop = el.scroller.scrollTop;
  copy.scrollLeft = el.scroller.scrollLeft;
  return { copy, top: el.scroller.scrollTop, left: el.scroller.scrollLeft };
}

/** play the slide on pane `el` (after its new view has been drawn). Returns the animations, or null when skipped. */
export function playViewSlide(el, snap, dir = 1) {
  if (!snap || reduced() || !el?.scroller || !el.body?.isConnected) { snap?.copy?.remove(); return null; }
  const body = el.body;
  const w = Math.max(60, Math.min(body.clientWidth * 0.22, 160)) * dir;
  const prevOverflow = body.style.overflow;
  body.style.overflow = 'hidden';
  body.append(snap.copy);
  snap.copy.scrollTop = snap.top; snap.copy.scrollLeft = snap.left;
  let left = 2;
  const done = () => {
    if (--left > 0) return;
    snap.copy.remove();
    body.style.overflow = prevOverflow;
  };
  const opts = { duration: SLIDE_MS, easing: EASE, fill: 'none' };
  const out = snap.copy.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-w}px)`, opacity: 0 }], opts);
  const inn = el.scroller.animate([{ transform: `translateX(${w}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], opts);
  out.onfinish = out.oncancel = done;
  inn.onfinish = inn.oncancel = done;
  // never leave the copy behind, whatever happens to the animation
  setTimeout(() => { if (snap.copy.isConnected) { left = 1; done(); } }, SLIDE_MS + 400);
  return [out, inn];
}

/** where each pane is now (call before the panes are rebuilt for a new layout) */
export function snapshotPanes(host) {
  if (reduced() || !host) return null;
  const hr = host.getBoundingClientRect();
  return {
    host: hr,
    rects: [...host.querySelectorAll(':scope > .pane')].map((p) => { const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }),
  };
}

/** glide the rebuilt panes from where they were; panes that did not exist before slide in from the edge */
export function playPaneLayout(host, snap) {
  if (!snap || reduced() || !host) return null;
  const panes = [...host.querySelectorAll(':scope > .pane')];
  const out = [];
  panes.forEach((p, i) => {
    const r = p.getBoundingClientRect();
    const old = snap.rects[i];
    let from;
    if (old) {
      from = { transform: `translate(${old.x - r.left}px, ${old.y - r.top}px)`, opacity: 0.85 };
    } else {
      // a new pane: it comes in from the side (or the bottom) of the pane it was split from
      const wide = r.width >= r.height * 1.1;
      from = { transform: wide ? `translateX(${Math.min(r.width, 280)}px)` : `translateY(${Math.min(r.height, 220)}px)`, opacity: 0 };
    }
    const a = p.animate([from, { transform: 'translate(0,0)', opacity: 1 }], { duration: SLIDE_MS + 40, easing: EASE, fill: 'none' });
    out.push(a);
  });
  const prev = host.style.overflow;
  host.style.overflow = 'hidden';
  const restore = () => { host.style.overflow = prev; };
  Promise.allSettled(out.map((a) => a.finished)).then(restore);
  setTimeout(restore, SLIDE_MS + 500);
  return out;
}

// ---------- dragging several files ----------
/** how many cards a dragged group shows (the badge carries the real count) */
export const MAX_CARDS = 3;
const FAN = [{ x: 0, y: 0, r: 0 }, { x: 5, y: 4, r: 3.5 }, { x: 10, y: 8, r: 7 }];

/**
 * Build the ghost for a multi-item drag: up to three cards stacked into a fan plus a count badge.
 * `from` are the on-screen boxes of the selected items; the cards fly out of them into the stack (a "gathering" effect).
 */
export function buildStackGhost(count, names, from, at) {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost multi';
  const stack = document.createElement('div');
  stack.className = 'dg-stack';
  const n = Math.min(MAX_CARDS, count);
  const cards = [];
  for (let k = n - 1; k >= 0; k--) {
    const c = document.createElement('div');
    c.className = 'dg-card';
    c.style.zIndex = String(n - k);
    c.dataset.k = String(k);
    if (k === 0) c.textContent = names[0] || '';
    stack.append(c);
    cards[k] = c;
  }
  const badge = document.createElement('span');
  badge.className = 'dg-count';
  badge.textContent = String(count);
  const op = document.createElement('span');
  op.className = 'dg-op';
  ghost.append(stack, badge, op);
  cards.forEach((c, k) => { const f = FAN[k] || FAN[FAN.length - 1]; c.style.setProperty('--fx', f.x + 'px'); c.style.setProperty('--fy', f.y + 'px'); c.style.setProperty('--fr', f.r + 'deg'); });
  ghost._play = () => gather(ghost, cards, badge, from, at);
  return ghost;
}

function gather(ghost, cards, badge, from, at) {
  if (reduced()) return [];
  const anims = [];
  cards.forEach((c, k) => {
    if (!c) return;
    const f = FAN[k] || FAN[FAN.length - 1];
    const src = from[k] || from[0];
    // start over the item itself (relative to where the ghost is placed), end in the fan
    const dx = src ? src.x + src.w / 2 - at.x - 40 : 0, dy = src ? src.y + src.h / 2 - at.y - 12 : 0;
    anims.push(c.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(1.1)`, opacity: 0.2 },
      { transform: `translate(${f.x}px, ${f.y}px) rotate(${f.r}deg) scale(1)`, opacity: 1 },
    ], { duration: 320 + k * 60, easing: 'cubic-bezier(.2,.9,.25,1.1)', fill: 'backwards' }));
  });
  anims.push(badge.animate([{ transform: 'scale(0)' }, { transform: 'scale(1.25)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 380, delay: 120, easing: 'ease-out', fill: 'backwards' }));
  return anims;
}

/** the ghost folds into the target it was dropped on, then goes */
export function absorbGhost(ghost, onDone) {
  if (!ghost?.isConnected || reduced()) { onDone?.(); return null; }
  const base = ghost.style.transform || '';
  const a = ghost.animate([{ transform: `${base} scale(1)`, opacity: 1 }, { transform: `${base} scale(.4)`, opacity: 0 }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
  a.onfinish = a.oncancel = () => onDone?.();
  setTimeout(() => onDone?.(), 400);
  return a;
}
