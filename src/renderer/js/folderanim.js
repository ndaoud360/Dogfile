// Opening and closing folders: a short animation as a folder's contents appear (Settings › Appearance › Folder
// animation). Opening goes into a folder; closing goes back up. Effects:
//   fade · slide · zoom (from the item clicked) · cascade (items arrive one after another) ·
//   unfold (like a foldable phone opening: the view opens out from a centre hinge and the items cascade outward
//   from it; closing folds the content back toward the hinge)
// Cells keep their own position (a transform): the motion is added on top (composite: 'add').
import { state } from './core.js';

export const FOLDER_ANIMS = [
  ['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['cascade', 'Cascade'], ['unfold', 'Unfold (foldable)'],
];
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const FLUID = 'cubic-bezier(.16,1,.3,1)';

let lastPointer = null;
addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() }; }, true);

const reduced = () => document.body.classList.contains('reduce-motion');
export const folderAnimation = () => (reduced() ? 'none' : state.settings.folderAnimation || 'fade');

/** which way a move from `prev` to `next` goes: into a folder, or back up */
export function directionOf(prev, next) {
  if (!prev || !next) return 'open';
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const a = norm(prev), b = norm(next);
  if (a.startsWith(b) && a !== b) return 'close';
  return 'open';
}

const cellsOf = (el) => [...el.inner.children].filter((n) => n.classList.contains('cell'));
const visible = (el, cells) => {
  const r = el.scroller.getBoundingClientRect();
  return cells.filter((c) => { const b = c.getBoundingClientRect(); return b.bottom > r.top - 40 && b.top < r.bottom + 40; });
};

/** play `kind` (or the chosen one) on pane element `el` after its folder has rendered */
export function playFolderAnim(el, dir = 'open', kind = folderAnimation(), { origin = null } = {}) {
  if (!el?.inner || kind === 'none') return null;
  const inner = el.inner;
  const open = dir !== 'close';
  // where the click was, for zoom
  const o = origin || (lastPointer && Date.now() - lastPointer.at < 1200 ? lastPointer : null);
  const box = el.scroller.getBoundingClientRect();
  const anims = [];
  const done = () => Promise.all(anims.map((a) => a.finished.catch(() => {})));
  if (kind === 'fade') {
    anims.push(inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 170, easing: 'ease-out' }));
  } else if (kind === 'slide') {
    const d = open ? 28 : -28;
    anims.push(inner.animate([{ opacity: 0, transform: `translateX(${d}px)` }, { opacity: 1, transform: 'none' }], { duration: 230, easing: EASE }));
  } else if (kind === 'zoom') {
    const ox = o ? o.x - box.left + el.scroller.scrollLeft : box.width / 2;
    const oy = o ? o.y - box.top + el.scroller.scrollTop : box.height / 3;
    inner.style.transformOrigin = `${ox}px ${oy}px`;
    anims.push(inner.animate(open
      ? [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: EASE }));
    done().then(() => { inner.style.transformOrigin = ''; });
  } else if (kind === 'cascade') {
    const cells = visible(el, cellsOf(el)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const step = Math.max(6, Math.min(18, 320 / Math.max(1, cells.length)));
    const dy = open ? 14 : -14;
    cells.forEach((c, i) => anims.push(c.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, delay: i * step, easing: EASE, fill: 'backwards', composite: 'add' })));
    if (!cells.length) anims.push(inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 170 }));
  } else if (kind === 'unfold') {
    // the hinge is the centre of the view; the inner display "opens" around it, and the items flow outward from the
    // hinge to their places, the ones nearest the hinge first. Closing is the reverse: content arrives from beyond
    // the edges and settles inward, as if folding back onto the cover screen.
    const cells = visible(el, cellsOf(el));
    // the hinge: the middle of the items themselves (they're laid out from the left, not centred in the pane)
    const rects = cells.map((c) => c.getBoundingClientRect());
    const lo = rects.length ? Math.min(...rects.map((r) => r.left)) : box.left, hi = rects.length ? Math.max(...rects.map((r) => r.right)) : box.right;
    const cx = (lo + hi) / 2;
    const half = Math.max(1, (hi - lo) / 2);
    inner.style.perspective = '1400px';
    inner.style.perspectiveOrigin = '50% 40%';
    for (const c of cells) {
      const b = c.getBoundingClientRect();
      const off = (b.left + b.width / 2 - cx) / half; // -1 (left edge) … 0 (hinge) … 1 (right edge)
      const dist = Math.min(1, Math.abs(off));
      const side = off < 0 ? -1 : 1;
      const delay = (open ? dist : 1 - dist) * 240;
      const from = open
        ? { opacity: 0, transform: `translateX(${-off * half * 0.55}px) rotateY(${side * 38}deg) scale(.82)` }
        : { opacity: 0, transform: `translateX(${off * half * 0.22}px) rotateY(${-side * 22}deg) scale(1.06)` };
      anims.push(c.animate([from, { opacity: 1, transform: 'translateX(0) rotateY(0deg) scale(1)' }], { duration: open ? 560 : 440, delay, easing: FLUID, fill: 'backwards', composite: 'add' }));
    }
    // the view itself opens like a hinged screen: narrow (the cover display) to full width
    inner.style.transformOrigin = `${cx - box.left + el.scroller.scrollLeft}px 50%`;
    anims.push(inner.animate(open
      ? [{ transform: 'scaleX(.62)', opacity: 0.35 }, { transform: 'scaleX(1)', opacity: 1 }]
      : [{ transform: 'scaleX(1.12)', opacity: 0.4 }, { transform: 'scaleX(1)', opacity: 1 }], { duration: open ? 520 : 420, easing: FLUID }));
    // a soft line of light along the hinge as it opens
    const glow = document.createElement('div');
    glow.className = 'hinge-glow';
    glow.style.left = `${cx - box.left}px`;
    el.body.append(glow);
    anims.push(glow.animate([{ opacity: open ? 0.9 : 0.5, transform: 'scaleY(.6)' }, { opacity: 0, transform: 'scaleY(1)' }], { duration: open ? 600 : 420, easing: 'ease-out' }));
    done().then(() => { glow.remove(); inner.style.perspective = ''; inner.style.perspectiveOrigin = ''; inner.style.transformOrigin = ''; });
  }
  return done();
}
