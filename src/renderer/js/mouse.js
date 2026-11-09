// Mouse gestures, extra mouse buttons and the command wheel.
//
// A trigger is a key you hold and/or a mouse button ("Alt + right button", "the back button", "hold Z").
// - Gestures: hold a trigger and draw with the mouse (←, →, ↑, ↓, two or three of them in a row, or shake it).
//   Each drawn gesture runs a command from the command palette.
// - Mouse buttons: a trigger that is pressed and released with no movement runs a command (the extra buttons of a
//   mouse like the MX Master).
// - The wheel: hold a trigger and six commands open around the pointer; let go over one to run it (or click it).
// Settings > Mouse & wheel. Everything stays off the page until something is set up: no listener runs otherwise.
import { state, bus, h, saveSettings } from './core.js';
import { commands } from './commands.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';

// ---------- what is set up ----------
export const cfg = () => {
  const s = state.settings;
  if (!s.mouse || typeof s.mouse !== 'object') s.mouse = {};
  const m = s.mouse;
  if (!Array.isArray(m.sets)) m.sets = [];
  if (!Array.isArray(m.buttons)) m.buttons = [];
  if (!m.wheel || typeof m.wheel !== 'object') m.wheel = { trigger: null, slots: [] };
  if (!Array.isArray(m.wheel.slots)) m.wheel.slots = [];
  return m;
};
const save = () => { saveSettings(); reload(); };

export const BUTTON_NAMES = ['Left button', 'Middle button', 'Right button', 'Back button', 'Forward button'];
export function keyName(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return ({ AltLeft: 'Alt', AltRight: 'Alt', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Win', MetaRight: 'Win', Space: 'Space', CapsLock: 'Caps Lock', Backquote: '`', Tab: 'Tab' })[code] || code.replace(/^Numpad/, 'Num ');
}
export const triggerLabel = (t) => (!t ? 'Not set' : [keyName(t.code), t.button == null ? '' : BUTTON_NAMES[t.button] || `Button ${t.button + 1}`].filter(Boolean).join(' + '));
const ARROW = { U: '↑', D: '↓', L: '←', R: '→' };
export const gestureLabel = (g) => (g === 'shake' ? 'Shake' : [...g].map((c) => ARROW[c] || c).join(' '));
const cmdTitle = (id) => commands.get(id)?.title || id;

// ---------- the engine ----------
const held = new Set();
let installed = false;
let press = null; // a trigger is down: { kind, ... }
let suppressCtx = 0;
let wheel = null;

const sameMatch = (t, e) => !!t && t.button != null && e.button === t.button && (!t.code || held.has(t.code));
const bySpecific = (a, b) => (b.trigger.code ? 1 : 0) - (a.trigger.code ? 1 : 0);
function run(id) {
  const c = commands.get(id);
  if (!c) return;
  setTimeout(() => { try { if (!c.when || c.when()) c.run(); } catch (e) { console.error(e); } }, 0);
}

export function reload() {
  const m = cfg();
  const wheelOn = m.wheel.trigger && m.wheel.slots.some(Boolean);
  const any = m.on !== false && (m.sets.length || m.buttons.length || wheelOn);
  if (any) install(); else uninstall();
}
function install() {
  if (installed) return;
  installed = true;
  for (const [ev, fn] of LISTENERS) window.addEventListener(ev, fn, true);
}
function uninstall() {
  if (!installed) return;
  installed = false;
  for (const [ev, fn] of LISTENERS) window.removeEventListener(ev, fn, true);
  held.clear(); press = null; closeWheel(true);
}

const BIT = [1, 4, 2, 8, 16]; // MouseEvent.buttons bits for button 0 (left), 1 (middle), 2 (right), 3 (back), 4 (forward)
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
function onKeyDown(e) {
  if (capturing()) return;
  if (!e.repeat) held.add(e.code);
  const w = cfg().wheel;
  if (wheel && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWheel(); return; }
  if (wheel && /^[1-6]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); const id = wheel.slots[+e.key - 1]; closeWheel(); if (id) run(id); return; }
  // a wheel on a key alone: held for a moment so a quick tap still works as a normal shortcut
  if (!e.repeat && w.trigger && w.trigger.button == null && w.trigger.code === e.code && !wheel && !typing(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey) {
    press = { kind: 'wheelKey', code: e.code };
    press.timer = setTimeout(() => { if (press?.kind === 'wheelKey') openWheel(lastX, lastY, 'key'); }, 170);
  }
}
function onKeyUp(e) {
  held.delete(e.code);
  if (press?.kind === 'wheelKey' && press.code === e.code) { clearTimeout(press.timer); press = null; if (wheel) { e.preventDefault(); finishWheel(); } }
}
let lastX = 0, lastY = 0;
function onMove(e) {
  lastX = e.clientX; lastY = e.clientY;
  if (wheel) { hoverWheel(e.clientX, e.clientY); e.stopPropagation(); return; }
  if (press?.kind !== 'gesture') return;
  // the button was let go somewhere we didn't hear about
  if (!(e.buttons & BIT[press.button])) { endGesture(e); return; }
  e.preventDefault(); e.stopPropagation();
  const p = press, last = p.pts[p.pts.length - 1];
  if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return;
  p.pts.push({ x: e.clientX, y: e.clientY });
  if (!p.moved && Math.hypot(e.clientX - p.pts[0].x, e.clientY - p.pts[0].y) > 14) p.moved = true;
  if (p.moved) { drawTrail(p); const g = recognize(p.pts); showHint(e.clientX, e.clientY, g, p.set.gestures[g]); }
}
function onDown(e) {
  if (capturing()) return;
  if (wheel) {
    const seg = e.target?.closest?.('.cw-item');
    e.preventDefault(); e.stopPropagation();
    if (e.button === 0 && seg) { const id = wheel.slots[+seg.dataset.i]; closeWheel(); if (id) run(id); } else if (e.button === 0 || e.button === 2) closeWheel();
    return;
  }
  const m = cfg();
  // the wheel on a mouse button
  if (sameMatch(m.wheel.trigger, e) && m.wheel.slots.some(Boolean)) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    press = { kind: 'wheel', button: e.button };
    openWheel(e.clientX, e.clientY, 'button');
    return;
  }
  const set = m.sets.filter((s) => sameMatch(s.trigger, e) && Object.keys(s.gestures || {}).length).sort(bySpecific)[0];
  const bind = m.buttons.filter((b) => sameMatch(b.trigger, e)).sort(bySpecific)[0];
  if (!set && !bind) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  press = { kind: 'gesture', button: e.button, set: set || { gestures: {} }, bind, pts: [{ x: e.clientX, y: e.clientY }], moved: false };
}
function onUp(e) {
  if (press?.kind === 'wheel' && e.button === press.button) { e.preventDefault(); e.stopPropagation(); press = null; finishWheel(); return; }
  if (press?.kind === 'gesture' && e.button === press.button) { e.preventDefault(); e.stopPropagation(); endGesture(e); }
}
function endGesture(e) {
  const p = press; press = null;
  if (!p) return;
  clearTrail();
  if (p.moved && Object.keys(p.set.gestures).length) {
    const g = recognize(p.pts), id = p.set.gestures[g];
    if (p.button === 2) suppressCtx = Date.now();
    if (id) run(id); else if (g) showHint(e.clientX, e.clientY, g, null, true);
    return;
  }
  if (!p.moved && p.bind) { if (p.button === 2) suppressCtx = Date.now(); run(p.bind.cmd); return; }
  // a plain right click with nothing drawn: the menu opens as always (it only needs the click to be let through)
  if (!p.moved && p.button === 2) return;
}
// the extra buttons also navigate by themselves (Back / Forward): a bound one must not
function onAux(e) { if (cfg().buttons.some((b) => sameMatch(b.trigger, e)) || (press && e.button === press.button)) { e.preventDefault(); e.stopPropagation(); } }
function onCtx(e) { if (Date.now() - suppressCtx < 400 || press?.kind === 'gesture' || wheel) { e.preventDefault(); e.stopPropagation(); } }
function onBlur() { held.clear(); if (press) { clearTimeout(press.timer); press = null; clearTrail(); } closeWheel(true); }
const LISTENERS = [['keydown', onKeyDown], ['keyup', onKeyUp], ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['auxclick', onAux], ['contextmenu', onCtx], ['blur', onBlur]];

// ---------- reading a drawn gesture ----------
/** "L", "RD", "shake"…: the directions of the strokes, in order */
export function recognize(pts) {
  if (!pts || pts.length < 2) return '';
  // shaking: the pointer goes back and forth at least three times
  const reversals = (axis, min) => {
    let dir = 0, extreme = pts[0][axis], n = 0, swing = 0;
    for (const p of pts) {
      const v = p[axis];
      if (!dir) { if (Math.abs(v - extreme) > min) { dir = v > extreme ? 1 : -1; extreme = v; } continue; }
      if ((v - extreme) * dir > 0) { extreme = v; continue; }
      if (Math.abs(v - extreme) > min) { n++; swing = Math.max(swing, Math.abs(v - extreme)); dir = -dir; extreme = v; }
    }
    return { n, swing };
  };
  const rx = reversals('x', 26), ry = reversals('y', 26);
  const ext = (a) => Math.max(...pts.map((p) => p[a])) - Math.min(...pts.map((p) => p[a]));
  if (rx.n >= 3 && ext('y') < ext('x') * 1.1) return 'shake';
  if (ry.n >= 3 && ext('x') < ext('y') * 1.1) return 'shake';
  const segs = [];
  let a = pts[0];
  for (const p of pts) {
    const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    if (d < 16) continue;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U';
    const last = segs[segs.length - 1];
    if (last && last.d === dir) last.len += d; else segs.push({ d: dir, len: d });
    a = p;
  }
  const out = [];
  for (const s of segs) {
    if (s.len < 28) continue;
    if (out.length && out[out.length - 1].d === s.d) out[out.length - 1].len += s.len; else out.push({ ...s });
  }
  return out.slice(0, 3).map((s) => s.d).join('');
}

// ---------- the trail and the hint while drawing ----------
let cv = null, hint = null;
function drawTrail(p) {
  if (!cv) {
    cv = h('canvas', { class: 'mg-trail' });
    cv.width = innerWidth; cv.height = innerHeight;
    document.body.append(cv);
  }
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  c.shadowColor = c.strokeStyle; c.shadowBlur = 8;
  c.beginPath();
  p.pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
  c.stroke();
}
function clearTrail() {
  if (cv) { const el = cv; cv = null; el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }
  if (hint) { const el = hint; hint = null; setTimeout(() => el.remove(), 700); }
}
function showHint(x, y, g, cmd, none) {
  if (!hint) { hint = h('div', { class: 'mg-hint' }); document.body.append(hint); }
  hint.textContent = g ? `${gestureLabel(g)}  ${cmd ? cmdTitle(cmd) : none ? 'no action' : ''}`.trim() : '';
  hint.classList.toggle('none', !cmd);
  hint.style.left = Math.min(x + 16, innerWidth - 200) + 'px';
  hint.style.top = Math.min(y + 18, innerHeight - 40) + 'px';
  if (none) setTimeout(() => { if (hint) { const el = hint; hint = null; el.remove(); } }, 900);
}

// ---------- the wheel ----------
const SEG = 6;
export const DEFAULT_WHEEL = ['back', 'forward', 'newTab', 'closeTab', 'toggleSplit', 'palette'];
function openWheel(x, y, via) {
  const m = cfg();
  const slots = Array.from({ length: SEG }, (_, i) => (commands.has(m.wheel.slots[i]) ? m.wheel.slots[i] : null));
  buildWheel(x, y, slots, via);
}
function buildWheel(x, y, slots, via, preview) {
  closeWheel(true);
  const R = 132, r = 44, size = R * 2 + 16;
  const cx = Math.max(size / 2, Math.min(innerWidth - size / 2, x)), cy = Math.max(size / 2, Math.min(innerHeight - size / 2, y));
  const el = h('div', { id: 'cmd-wheel', style: { left: cx - size / 2 + 'px', top: cy - size / 2 + 'px', width: size + 'px', height: size + 'px' } });
  const mid = size / 2;
  const pt = (rad, deg) => [mid + rad * Math.cos((deg * Math.PI) / 180), mid + rad * Math.sin((deg * Math.PI) / 180)];
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  for (let i = 0; i < SEG; i++) {
    const a0 = -90 + i * 60 - 30 + 1.5, a1 = a0 + 57;
    const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
    svg += `<path class="cw-seg${slots[i] ? '' : ' empty'}" data-i="${i}" d="M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 0 0 ${x3} ${y3} Z"/>`;
  }
  svg += `<circle class="cw-hub" cx="${mid}" cy="${mid}" r="${r - 6}"/></svg>`;
  el.innerHTML = svg;
  const hubText = h('div', { class: 'cw-hubtext' }, preview ? 'Click away to close' : 'Let go to cancel');
  hubText.style.left = hubText.style.top = mid + 'px';
  el.append(hubText);
  slots.forEach((id, i) => {
    const c = id ? commands.get(id) : null;
    const [ix, iy] = pt(88, -90 + i * 60);
    const item = h('div', { class: 'cw-item' + (c ? '' : ' empty'), 'data-i': i, style: { left: ix + 'px', top: iy + 'px', transitionDelay: i * 22 + 'ms' } },
      h('span', { class: 'cw-ic', html: c ? icon(c.icon || 'command') : '' }), h('span', { class: 'cw-t' }, c ? c.title : ''));
    el.append(item);
  });
  document.body.append(el);
  wheel = { el, slots, cx, cy, mid, r, R, hover: -1, hubText, via, preview };
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
}
function hoverWheel(x, y) {
  if (!wheel) return;
  const dx = x - wheel.cx, dy = y - wheel.cy, d = Math.hypot(dx, dy);
  let i = -1;
  if (d > wheel.r - 6 && d < wheel.R + 70) {
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    i = Math.round((((ang + 90) % 360) + 360) % 360 / 60) % SEG;
    if (!wheel.slots[i]) i = -1;
  }
  if (i === wheel.hover) return;
  wheel.hover = i;
  wheel.el.querySelectorAll('.cw-seg, .cw-item').forEach((n) => n.classList.toggle('hot', +n.dataset.i === i));
  wheel.hubText.textContent = i >= 0 ? cmdTitle(wheel.slots[i]) : wheel.preview ? 'Click away to close' : 'Let go to cancel';
}
function finishWheel() {
  if (!wheel) return;
  const id = wheel.hover >= 0 ? wheel.slots[wheel.hover] : null;
  closeWheel();
  if (id) run(id);
}
function closeWheel(now) {
  if (!wheel) return;
  const el = wheel.el;
  wheel = null;
  if (now) { el.remove(); return; }
  el.classList.remove('open'); el.classList.add('closing');
  setTimeout(() => el.remove(), 170);
}

// ---------- Settings > Mouse & wheel ----------
const topClose = () => [...document.querySelectorAll('.modal-back')].pop()?.querySelector('.modal')?._close;
const capturing = () => !!document.querySelector('.mg-cap, .mg-pad');
function pickCommand(title = 'Choose what it does') {
  const list = h('div', { class: 'mg-cmdlist' });
  const q = h('input', { class: 'input', placeholder: 'Search the command palette…', style: { width: '100%' } });
  let close;
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    list.innerHTML = '';
    const all = [...commands.values()].filter((c) => !c.hidden && c.title && (!s || `${c.title} ${c.cat || ''} ${c.id}`.toLowerCase().includes(s)));
    for (const c of all.slice(0, 120)) {
      list.append(h('div', { class: 'mg-cmd', onclick: () => close(c.id) }, h('span', { class: 'mg-ci', html: icon(c.icon || 'command') }), h('span', { class: 'mg-ct' }, c.title), h('span', { class: 'mg-cc' }, c.cat || '')));
    }
    if (!all.length) list.append(h('div', { class: 'hint', style: { padding: '12px' } }, 'No command matches.'));
  };
  q.addEventListener('input', draw);
  draw();
  const p = modal({ title, body: h('div', {}, q, list), width: 520, buttons: [{ label: 'Cancel', value: null }] });
  setTimeout(() => { close = topClose() || (() => {}); }, 0);
  return p;
}
function captureTrigger({ keyOnly = false, needKeyForLeft = true } = {}) {
  let lastKey = null;
  const msg = h('div', { class: 'mg-cap-msg' }, keyOnly ? 'Hold the key or click the mouse button you want. A key alone works too.' : 'Hold a key if you want one, then click the mouse button you want to use.');
  const pad = h('div', { class: 'mg-cap', tabindex: '0' }, h('div', { class: 'mg-cap-big' }, 'Click here with your button…'), msg);
  const err = h('div', { class: 'hint', style: { color: '#ff8a80', minHeight: '18px' } });
  let close;
  const pending = new Promise((resolve) => {
    pad.addEventListener('keydown', (e) => { if (e.key === 'Escape') return; e.preventDefault(); e.stopPropagation(); if (!e.repeat) { lastKey = e.code; pad.querySelector('.mg-cap-big').textContent = keyName(lastKey) + ' …now click, or'; } });
    pad.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.button === 0 && !lastKey && needKeyForLeft) { err.textContent = 'The left button needs a key held with it, so ordinary clicking keeps working.'; return; }
      resolve({ code: lastKey, button: e.button });
      close?.();
    });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('auxclick', (e) => e.preventDefault());
  });
  const buttons = [{ label: 'Cancel', value: null }];
  if (keyOnly) buttons.unshift({ label: 'Use the key alone', primary: true, run: (cl) => { if (!lastKey) { err.textContent = 'Press the key first.'; return false; } cl({ code: lastKey, button: null }); } });
  const modalP = modal({ title: 'Set the trigger', body: h('div', {}, pad, err), width: 480, buttons });
  setTimeout(() => { pad.focus(); close = topClose(); }, 30);
  return Promise.race([modalP, pending]);
}
function recordGesture() {
  const cvs = h('canvas', { width: 360, height: 200, class: 'mg-pad' });
  const out = h('div', { class: 'mg-rec', style: { fontSize: '22px', textAlign: 'center', minHeight: '34px', margin: '8px 0' } }, 'Draw it here');
  const pts = [];
  let down = false, result = '';
  const c = cvs.getContext('2d');
  const redraw = () => { c.clearRect(0, 0, 360, 200); c.lineWidth = 4; c.lineCap = 'round'; c.strokeStyle = '#3b82f6'; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.stroke(); };
  const at = (e) => { const r = cvs.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 360, y: ((e.clientY - r.top) / r.height) * 200 }; };
  cvs.addEventListener('mousedown', (e) => { down = true; pts.length = 0; pts.push(at(e)); result = ''; out.textContent = '…'; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!down) return; pts.push(at(e)); redraw(); }, { passive: true });
  window.addEventListener('mouseup', () => { if (!down) return; down = false; result = recognize(pts); out.textContent = result ? gestureLabel(result) : 'Draw a longer line'; });
  const p = modal({ title: 'Draw the gesture', body: h('div', {}, h('div', { class: 'hint' }, 'Draw a line, or two or three in a row (→ then ↓, say). Shake the mouse back and forth for "Shake". It is the shape that counts, not the size.'), cvs, out), width: 420, buttons: [{ label: 'Cancel', value: null }, { label: 'Use this gesture', primary: true, run: (cl) => { if (!result) return false; cl(result); } }] });
  return p;
}

export function mouseSettings(el, { group, row }) {
  const m = cfg();
  const draw = () => { el.innerHTML = ''; build(); };
  const ctl = (label, fn, cls = '') => h('button', { class: 'btn small ' + cls, onclick: fn }, label);
  const build = () => {
    const on = h('input', { type: 'checkbox', class: 'switch' });
    on.checked = m.on !== false;
    on.addEventListener('change', () => { m.on = on.checked; save(); });
    el.append(
      group('Mouse'),
      row('Mouse gestures and wheel', on, 'Hold a key and a mouse button, then draw or pick. Works over the file panes and the tab strip. Nothing is listening until you set something up.'),
      group('Gestures'),
    );
    if (!m.sets.length) el.append(h('div', { class: 'hint' }, 'A gesture set is one trigger, such as Alt + right button, and the movements you draw while you hold it: left for Back, shake to close the tab…'));
    m.sets.forEach((set, si) => {
      const head = h('div', { class: 'row-inline', style: { gap: '8px', margin: '10px 0 4px', flexWrap: 'wrap' } }, h('b', {}, triggerLabel(set.trigger)),
        ctl('Change trigger', async () => { const t = await captureTrigger(); if (t) { set.trigger = t; save(); draw(); } }),
        ctl('Add a gesture', async () => { const g = await recordGesture(); if (!g) return; const id = await pickCommand(`What does ${gestureLabel(g)} do?`); if (id) { set.gestures[g] = id; save(); draw(); } }),
        ctl('Remove set', () => { m.sets.splice(si, 1); save(); draw(); }, 'danger'));
      el.append(head);
      for (const [g, id] of Object.entries(set.gestures)) {
        el.append(h('div', { class: 'mg-row' }, h('span', { class: 'mg-g' }, gestureLabel(g)), h('span', { class: 'mg-ci', html: icon(commands.get(id)?.icon || 'command') }), h('span', { class: 'mg-ct' }, cmdTitle(id)),
          ctl('Change', async () => { const n = await pickCommand(); if (n) { set.gestures[g] = n; save(); draw(); } }), ctl('Remove', () => { delete set.gestures[g]; save(); draw(); })));
      }
    });
    el.append(h('div', { class: 'row-inline', style: { gap: '8px', marginTop: '10px' } },
      ctl('Add a gesture set…', async () => { const t = await captureTrigger(); if (t) { m.sets.push({ trigger: t, gestures: {} }); save(); draw(); } }, 'primary'),
      ctl('Start with suggestions…', async () => {
        const t = await captureTrigger(); if (!t) return;
        m.sets.push({ trigger: t, gestures: { L: 'back', R: 'forward', U: 'up', D: 'refresh', shake: 'closeTab', DR: 'newTab', UL: 'reopenTab', DL: 'duplicateTab' } });
        save(); draw();
      })));
    el.append(group('Mouse buttons'), h('div', { class: 'hint' }, 'Give an extra button a job, such as a thumb button. A mouse whose software can send a key instead (an F13 to F24 key from Logi Options+, for example) works the same way: hold that key as a trigger above.'));
    m.buttons.forEach((b, bi) => {
      el.append(h('div', { class: 'mg-row' }, h('span', { class: 'mg-g' }, triggerLabel(b.trigger)), h('span', { class: 'mg-ci', html: icon(commands.get(b.cmd)?.icon || 'command') }), h('span', { class: 'mg-ct' }, cmdTitle(b.cmd)),
        ctl('Change', async () => { const n = await pickCommand(); if (n) { b.cmd = n; save(); draw(); } }), ctl('Remove', () => { m.buttons.splice(bi, 1); save(); draw(); })));
    });
    el.append(h('div', { style: { marginTop: '8px' } }, ctl('Set a mouse button…', async () => {
      const t = await captureTrigger(); if (!t) return;
      const id = await pickCommand(`What does ${triggerLabel(t)} do?`); if (!id) return;
      m.buttons = m.buttons.filter((b) => triggerLabel(b.trigger) !== triggerLabel(t));
      m.buttons.push({ trigger: t, cmd: id }); save(); draw();
    }, 'primary')));
    const w = m.wheel;
    el.append(group('Command wheel'), h('div', { class: 'hint' }, 'Hold the trigger and a wheel of six commands opens at the pointer. Move to one and let go, or click it. Use the keys 1 to 6 as well.'),
      row('Trigger', h('div', { class: 'row-inline', style: { gap: '8px' } }, h('b', {}, triggerLabel(w.trigger)), ctl('Set…', async () => { const t = await captureTrigger({ keyOnly: true }); if (t) { w.trigger = t; save(); draw(); } }), w.trigger ? ctl('Clear', () => { w.trigger = null; save(); draw(); }) : null)));
    const grid = h('div', { class: 'mg-slots' });
    for (let i = 0; i < SEG; i++) {
      const id = w.slots[i], c = id ? commands.get(id) : null;
      grid.append(h('div', { class: 'mg-slot' }, h('div', { class: 'mg-sn' }, i + 1), h('span', { class: 'mg-ci', html: c ? icon(c.icon || 'command') : '' }), h('span', { class: 'mg-ct' }, c ? c.title : 'Empty'),
        ctl('Choose', async () => { const n = await pickCommand(`Wheel slot ${i + 1}`); if (n) { w.slots[i] = n; save(); draw(); } }), c ? ctl('Clear', () => { w.slots[i] = null; save(); draw(); }) : null));
    }
    el.append(grid, h('div', { class: 'row-inline', style: { gap: '8px', marginTop: '10px' } },
      ctl('Fill with suggestions', () => { w.slots = DEFAULT_WHEEL.filter((id) => commands.has(id)); save(); draw(); }),
      ctl('Try the wheel', () => {
        const slots = Array.from({ length: SEG }, (_, i) => (commands.has(w.slots[i]) ? w.slots[i] : null));
        setTimeout(() => {
          buildWheel(innerWidth / 2, innerHeight / 2, slots, 'preview', true);
          const move = (ev) => hoverWheel(ev.clientX, ev.clientY);
          const away = (ev) => { if (!ev.target.closest?.('#cmd-wheel')) { window.removeEventListener('mousedown', away, true); window.removeEventListener('mousemove', move); closeWheel(); } };
          window.addEventListener('mousemove', move);
          window.addEventListener('mousedown', away, true);
        }, 50);
      })));
  };
  build();
}

// ---------- start ----------
export function initMouse() {
  reload();
  bus.on('settings', reload);
}
