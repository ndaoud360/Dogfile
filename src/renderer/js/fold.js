// Folding sidebar: a port of the reference "fold menu" animation:
// the drawer is split into two halves that valley-fold (left half tilts back by θ, right half by −2θ relative
// to it, θ = acos(p)) so the outer edge lands exactly at x = W·p, while the content slides with it, a backing strip
// fills the gap, the hamburger ripples, and the active item's highlight grows in after the drawer opens.
import { state, bus, saveSettings } from './core.js';
import { panelMode, animatePanel } from './panelanim.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // cubic in-out
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp = (v) => Math.max(0, Math.min(1, v));
const DUR = 600;

let burger, rip, animating = false;

export function initFold() {
  burger = document.createElement('button');
  burger.id = 'burger';
  burger.title = 'Collapse / expand sidebar (Ctrl+B)';
  burger.setAttribute('aria-label', 'Menu');
  burger.innerHTML = '<span class="rip"></span><i></i><i></i><i></i>';
  document.body.append(burger);
  rip = burger.querySelector('.rip');
  burger.addEventListener('click', () => toggle());
  bus.on('toggleSidebarAnimated', () => toggle());
  syncBurger();
  bus.on('settings', syncBurger);
  // grow the highlight on first paint
  requestAnimationFrame(() => growHighlight());
  bus.on('sidebarHighlight', () => growHighlight());
}

function syncBurger() { document.body.classList.toggle('side-collapsed', !!state.settings.sidebarCollapsed); }

export function growHighlight() {
  const items = document.querySelectorAll('#side-list .side-item.active');
  document.querySelectorAll('#side-list .side-item.hl-on').forEach((n) => { if (!n.classList.contains('active')) n.classList.remove('hl-on'); });
  items.forEach((n) => { if (!n.classList.contains('hl-on')) { n.classList.remove('hl-on'); void n.offsetWidth; n.classList.add('hl-on'); } });
}

function ripple() {
  const t0 = performance.now();
  burger.classList.add('rippling');
  const step = (now) => {
    const r = (now - t0) / 500;
    if (r > 1) { rip.style.transform = 'scale(0)'; rip.style.opacity = '0'; burger.classList.remove('rippling'); return; }
    rip.style.transform = `scale(${easeOut(clamp(r / 0.35))})`;
    rip.style.opacity = r < 0.6 ? '1' : String(1 - (r - 0.6) / 0.4);
    burger.classList.toggle('lines-white', r < 0.7);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function toggle(open = !!state.settings.sidebarCollapsed) {
  // pressed again while it's moving: turn around from where it is (never ignored, never waits)
  if (anim) { reverse(); return; }
  if (animating) return;
  ripple();
  const mode = panelMode('sidebar');
  const instant = () => { state.settings.sidebarCollapsed = !open; saveSettings(); document.body.classList.toggle('no-sidebar', !open); syncBurger(); bus.emit('sidebarToggled', open); if (open) setTimeout(growHighlight, 30); };
  if (mode === 'none') return instant();
  if (mode === 'slide') { animating = true; animatePanel('sidebar', document.getElementById('sidebar'), open, instant, { edge: 'left' }).finally(() => { animating = false; }); return; }
  run(open); // starts immediately, together with the ripple
}

// The fold layer is made from copies of the sidebar. Making them is the slow part (a big tree of items and icons),
// so they're kept and reused until the sidebar changes: pressing the menu button again and again stays instant.
let fl = null, anim = null;
function sidebarChanged() { if (fl) fl.dirty = true; }
// the highlight growing in and hover states don't make the copies stale
const PASSING = new Set(['hl-on', 'hover', 'hovered', 'rippling']);
const sameClasses = (a, b) => { const f = (x) => (x || '').split(/\s+/).filter((c) => c && !PASSING.has(c)).sort().join(' '); return f(a) === f(b); };
function onSidebarMutations(list) {
  for (const m of list) {
    if (m.type === 'attributes' && m.attributeName === 'class' && sameClasses(m.oldValue, m.target.getAttribute('class'))) continue;
    sidebarChanged();
    return;
  }
}
function buildLayer(side, W, H) {
  const snap = () => { const c = side.cloneNode(true); c.removeAttribute('id'); c.classList.add('fold-snap'); c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); c.style.width = W + 'px'; return c; };
  const layer = document.createElement('div');
  layer.className = 'fold-layer';
  layer.innerHTML = `<div class="fold-back"></div><div class="fold" style="width:${W}px;perspective:${Math.round(1100 * Math.max(1, H / 640))}px"><div class="panel l" style="width:${W / 2}px"><div class="clip"></div><div class="shade"></div><div class="panel r" style="width:${W / 2}px;left:${W / 2}px"><div class="clip"></div><div class="shade"></div></div></div></div>`;
  const [cl, cr] = layer.querySelectorAll('.clip');
  cl.append(snap());
  const right = snap(); right.style.marginLeft = -(W / 2 - 1) + 'px'; cr.append(right);
  const [sl, sr] = layer.querySelectorAll('.shade');
  return { layer, W, H, dirty: false, pl: layer.querySelector('.panel.l'), pr: layer.querySelector('.panel.r'), sl, sr, back: layer.querySelector('.fold-back'), fold: layer.querySelector('.fold') };
}
let watching = false;
function watchSidebar(side) {
  if (watching) return;
  watching = true;
  new MutationObserver(onSidebarMutations).observe(side, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'src', 'title'] });
  window.addEventListener('resize', sidebarChanged);
  bus.on('settings', sidebarChanged);
}

function run(open) {
  animating = true;
  const side = document.getElementById('sidebar');
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  watchSidebar(side);
  const H = app.clientHeight;
  document.body.classList.remove('no-sidebar');
  const W = side.getBoundingClientRect().width || state.settings.sidebarWidth || 300;
  if (!fl || fl.dirty || Math.abs(fl.W - W) > 0.5 || fl.H !== H) { fl?.layer.remove(); fl = buildLayer(side, W, H); }
  // (our own class changes below don't count as the sidebar changing)
  const L = fl;
  if (!L.layer.isConnected) app.append(L.layer);
  L.layer.style.display = '';

  // During the animation the content's real width follows the fold, so files re-flow smoothly the whole way
  // (sliding it and fixing its width at the end made everything jump once the fold finished).
  document.body.classList.add('folding', 'no-sidebar');

  const render = (p) => {
    p = clamp(p);
    const th = Math.acos(p);
    L.pl.style.transform = `rotateY(${th}rad)`;
    L.pr.style.transform = `rotateY(${-2 * th}rad)`;
    L.sl.style.opacity = L.sr.style.opacity = String((1 - p) * 0.9);
    L.fold.style.visibility = p < 0.004 ? 'hidden' : 'visible';
    L.back.style.width = W * p + 'px';
    app.style.gridTemplateColumns = `${(W * p).toFixed(1)}px minmax(0, 1fr)`;
    // the tab strip makes room for the menu button in step with the fold (58px closed, 18px open)
    tabbar.style.paddingLeft = (58 - 40 * p).toFixed(1) + 'px';
  };
  anim = { p: open ? 0 : 1, from: open ? 0 : 1, to: open ? 1 : 0, t0: performance.now(), dur: DUR, render };
  render(anim.p);
  const step = (now) => {
    const a = anim;
    const k = clamp((now - a.t0) / a.dur);
    a.p = a.from + (a.to - a.from) * ease(k);
    render(a.p);
    if (k < 1) { requestAnimationFrame(step); return; }
    const opened = a.to === 1;
    anim = null;
    // settle into the real layout
    state.settings.sidebarCollapsed = !opened;
    app.style.gridTemplateColumns = ''; tabbar.style.paddingLeft = '';
    document.body.classList.toggle('no-sidebar', !opened);
    document.body.classList.remove('folding');
    L.layer.style.display = 'none'; // kept for next time
    syncBurger();
    animating = false;
    // only what depends on the sidebar: a full "settings" broadcast restyles every window and app tab
    bus.emit('sidebarToggled', opened);
    const later = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    later(() => saveSettings(), { timeout: 1000 });
    if (opened) growHighlight();
  };
  requestAnimationFrame(step);
}
function reverse() {
  const a = anim;
  if (!a) return;
  ripple();
  a.from = a.p; a.to = a.to === 1 ? 0 : 1;
  a.dur = Math.max(120, DUR * Math.abs(a.to - a.from));
  a.t0 = performance.now();
}
