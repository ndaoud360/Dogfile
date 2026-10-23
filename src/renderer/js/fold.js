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
  if (animating) return;
  ripple();
  const mode = panelMode('sidebar');
  const instant = () => { state.settings.sidebarCollapsed = !open; saveSettings(); document.body.classList.toggle('no-sidebar', !open); syncBurger(); bus.emit('sidebarToggled', open); if (open) setTimeout(growHighlight, 30); };
  if (mode === 'none') return instant();
  if (mode === 'slide') { animating = true; animatePanel('sidebar', document.getElementById('sidebar'), open, instant, { edge: 'left' }).finally(() => { animating = false; }); return; }
  run(open); // starts immediately, together with the ripple
}

function run(open) {
  animating = true;
  const side = document.getElementById('sidebar');
  const main = document.getElementById('main');
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  const W = side.getBoundingClientRect().width || state.settings.sidebarWidth || 300;
  const H = app.clientHeight;

  // Build the fold layer from two snapshots of the real sidebar.
  document.body.classList.remove('no-sidebar');
  const snap = () => { const c = side.cloneNode(true); c.removeAttribute('id'); c.classList.add('fold-snap'); c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); c.style.width = W + 'px'; return c; };
  const layer = document.createElement('div');
  layer.className = 'fold-layer';
  layer.innerHTML = `<div class="fold-back"></div><div class="fold" style="width:${W}px;perspective:${Math.round(1100 * Math.max(1, H / 640))}px"><div class="panel l" style="width:${W / 2}px"><div class="clip"></div><div class="shade"></div><div class="panel r" style="width:${W / 2}px;left:${W / 2}px"><div class="clip"></div><div class="shade"></div></div></div></div>`;
  const [cl, cr] = layer.querySelectorAll('.clip');
  cl.append(snap());
  const right = snap(); right.style.marginLeft = -(W / 2 - 1) + 'px'; cr.append(right);
  const pl = layer.querySelector('.panel.l'), pr = layer.querySelector('.panel.r');
  const [sl, sr] = layer.querySelectorAll('.shade');
  const back = layer.querySelector('.fold-back');
  const fold = layer.querySelector('.fold');
  app.append(layer);

  // During the animation the content uses the collapsed layout and slides by W·p (like the reference).
  document.body.classList.add('folding', 'no-sidebar');
  main.style.willChange = 'transform';

  const render = (p) => {
    p = clamp(p);
    const th = Math.acos(p);
    pl.style.transform = `rotateY(${th}rad)`;
    pr.style.transform = `rotateY(${-2 * th}rad)`;
    sl.style.opacity = sr.style.opacity = String((1 - p) * 0.9);
    fold.style.visibility = p < 0.004 ? 'hidden' : 'visible';
    back.style.width = W * p + 'px';
    main.style.transform = `translateX(${W * p}px)`;
    // the tab strip makes room for the menu button in step with the fold (58px closed, 18px open)
    tabbar.style.paddingLeft = (58 - 40 * p).toFixed(1) + 'px';
  };
  const from = open ? 0 : 1, to = open ? 1 : 0;
  render(from);
  const t0 = performance.now();
  const step = (now) => {
    const k = clamp((now - t0) / DUR);
    render(from + (to - from) * ease(k));
    if (k < 1) { requestAnimationFrame(step); return; }
    // settle into the real layout
    state.settings.sidebarCollapsed = !open;
    main.style.transform = ''; main.style.willChange = ''; tabbar.style.paddingLeft = '';
    document.body.classList.toggle('no-sidebar', !open);
    document.body.classList.remove('folding');
    layer.remove();
    syncBurger();
    animating = false;
    // only what depends on the sidebar: a full "settings" broadcast restyles every window and app tab
    bus.emit('sidebarToggled', open);
    const later = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    later(() => saveSettings(), { timeout: 1000 });
    if (open) growHighlight();
  };
  requestAnimationFrame(step);
}
