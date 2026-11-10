// The command wheel: hold a trigger (a key, a mouse button, or a key with a mouse button) and six commands from the
// command palette open around the pointer; let go over one to run it (or click it, or press 1 to 6).
// Any mouse button works, the extra buttons of a mouse like the MX Master included.
// Settings > Mouse & wheel. Nothing listens until a trigger and a command are set: no listener runs otherwise.
import { state, bus, h, saveSettings } from './core.js';
import { commands } from './commands.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';

export const cfg = () => {
  const s = state.settings;
  if (!s.mouse || typeof s.mouse !== 'object') s.mouse = {};
  const m = s.mouse;
  delete m.sets; delete m.buttons; // mouse gestures were taken out
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
const cmdTitle = (id) => commands.get(id)?.title || id;

// Keys the wheel can't use, and why (shown when someone picks one)
const MODIFIER = /^(Alt|Control|Shift)(Left|Right)$/;
export function keyProblem(code) {
  if (/^Meta/.test(code)) return 'Windows keeps the Windows key for itself (it opens the Start menu), so Dogfile can’t use it. Choose another key.';
  if (['Escape', 'Enter', 'NumpadEnter', 'Tab', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen', 'ContextMenu', 'F10'].includes(code)) return `${keyName(code)} is needed for everyday use (typing, moving around or Windows itself). Choose another key, such as Alt, Ctrl, Shift, a letter or F13 to F24.`;
  return '';
}

// ---------- the engine ----------
const held = new Set();
let installed = false;
let press = null; // a trigger is down: { kind: 'wheel' | 'wheelKey', ... }
let suppressCtx = 0;
let wheel = null;
let lastX = 0, lastY = 0;

const sameMatch = (t, e) => !!t && t.button != null && e.button === t.button && (!t.code || held.has(t.code));
function run(id) {
  const c = commands.get(id);
  if (!c) return;
  setTimeout(() => { try { if (!c.when || c.when()) c.run(); } catch (e) { console.error(e); } }, 0);
}
export function reload() {
  const w = cfg().wheel;
  const any = cfg().on !== false && w.trigger && w.slots.some(Boolean);
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
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
// other modifiers held besides the trigger key itself (the Alt key alone has altKey set while it is down)
const otherMods = (e, code) => (e.ctrlKey && !/^Control/.test(code)) || (e.altKey && !/^Alt/.test(code)) || (e.metaKey && !/^Meta/.test(code));

function onKeyDown(e) {
  if (capturing()) return;
  if (!e.repeat) held.add(e.code);
  const w = cfg().wheel;
  const mine = w.trigger && w.trigger.button == null && w.trigger.code === e.code;
  if (wheel && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWheel(); return; }
  if (wheel && /^[1-6]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); const id = wheel.slots[+e.key - 1]; closeWheel(); if (id) run(id); return; }
  if (!mine) return;
  // keep Windows from using the key (Alt would move to the menu bar) whenever it is the wheel's key
  if (MODIFIER.test(e.code) || wheel) e.preventDefault();
  // a wheel on a key alone: held for a moment so a quick tap still works as a normal shortcut
  if (!e.repeat && !wheel && !typing(e.target) && !otherMods(e, e.code)) {
    press = { kind: 'wheelKey', code: e.code };
    press.timer = setTimeout(() => { if (press?.kind === 'wheelKey') openWheel(lastX, lastY, 'key'); }, 170);
  }
}
function onKeyUp(e) {
  held.delete(e.code);
  const w = cfg().wheel;
  if (w.trigger && w.trigger.button == null && w.trigger.code === e.code && MODIFIER.test(e.code) && (wheel || press?.kind === 'wheelKey')) e.preventDefault(); // no menu bar after Alt
  if (press?.kind === 'wheelKey' && press.code === e.code) { clearTimeout(press.timer); press = null; if (wheel) { e.preventDefault(); finishWheel(); } }
}
function onMove(e) {
  lastX = e.clientX; lastY = e.clientY;
  if (wheel) { hoverWheel(e.clientX, e.clientY); e.stopPropagation(); }
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
  if (sameMatch(m.wheel.trigger, e) && m.wheel.slots.some(Boolean)) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    press = { kind: 'wheel', button: e.button };
    openWheel(e.clientX, e.clientY, 'button');
  }
}
function onUp(e) {
  if (press?.kind === 'wheel' && e.button === press.button) {
    e.preventDefault(); e.stopPropagation();
    if (e.button === 2) suppressCtx = Date.now(); // the right button's menu must not open as the wheel closes
    press = null; finishWheel();
  }
}
// the extra buttons also navigate by themselves (Back / Forward): the wheel's own must not
function onAux(e) { if (sameMatch(cfg().wheel.trigger, e) || (press && e.button === press.button)) { e.preventDefault(); e.stopPropagation(); } }
function onCtx(e) { if (Date.now() - suppressCtx < 400 || wheel) { e.preventDefault(); e.stopPropagation(); } }
function onBlur() { held.clear(); if (press) { clearTimeout(press.timer); press = null; } closeWheel(true); }
const LISTENERS = [['keydown', onKeyDown], ['keyup', onKeyUp], ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['auxclick', onAux], ['contextmenu', onCtx], ['blur', onBlur]];

// ---------- the wheel ----------
const SEG = 6;
export const DEFAULT_WHEEL = ['back', 'forward', 'newTab', 'closeTab', 'toggleSplit', 'palette'];
const R = 150, HUB = 48, LABEL_R = 104; // outer edge, centre hole, where the icon and name of each slice sit
function openWheel(x, y, via) {
  const m = cfg();
  const slots = Array.from({ length: SEG }, (_, i) => (commands.has(m.wheel.slots[i]) ? m.wheel.slots[i] : null));
  buildWheel(x, y, slots, via);
}
function buildWheel(x, y, slots, via, preview) {
  closeWheel(true);
  const size = R * 2 + 8;
  const cx = Math.max(size / 2, Math.min(innerWidth - size / 2, x)), cy = Math.max(size / 2, Math.min(innerHeight - size / 2, y));
  const el = h('div', { id: 'cmd-wheel', style: { left: cx - size / 2 + 'px', top: cy - size / 2 + 'px', width: size + 'px', height: size + 'px' } });
  const mid = size / 2;
  const pt = (rad, deg) => [mid + rad * Math.cos((deg * Math.PI) / 180), mid + rad * Math.sin((deg * Math.PI) / 180)];
  let svg = `<svg class="cw-bg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  for (let i = 0; i < SEG; i++) {
    const a0 = -90 + i * 60 - 30 + 1.2, a1 = a0 + 57.6;
    const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(HUB, a1), [x3, y3] = pt(HUB, a0);
    svg += `<path class="cw-seg${slots[i] ? '' : ' empty'}" data-i="${i}" d="M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${HUB} ${HUB} 0 0 0 ${x3} ${y3} Z"/>`;
  }
  svg += `<circle class="cw-hub" cx="${mid}" cy="${mid}" r="${HUB - 7}"/></svg>`;
  el.innerHTML = `<div class="cw-shadow"></div>` + svg;
  const hubText = h('div', { class: 'cw-hubtext' }, preview ? 'Click away to close' : 'Let go to cancel');
  hubText.style.left = hubText.style.top = mid + 'px';
  el.append(hubText);
  slots.forEach((id, i) => {
    const c = id ? commands.get(id) : null;
    const [ix, iy] = pt(LABEL_R, -90 + i * 60);
    el.append(h('div', { class: 'cw-item' + (c ? '' : ' empty'), 'data-i': i, style: { left: ix + 'px', top: iy + 'px', transitionDelay: i * 18 + 'ms' } },
      h('span', { class: 'cw-ic', html: c ? icon(c.icon || 'command') : '' }), h('span', { class: 'cw-t' }, c ? c.title : '')));
  });
  document.body.append(el);
  document.body.classList.add('wheel-open'); // pages and app tabs must not catch the pointer while the wheel is open
  bus.emit('coverNow');
  wheel = { el, slots, cx, cy, mid, hover: -1, hubText, via, preview };
  requestAnimationFrame(() => el.classList.add('open'));
}
function hoverWheel(x, y) {
  if (!wheel) return;
  const dx = x - wheel.cx, dy = y - wheel.cy, d = Math.hypot(dx, dy);
  let i = -1;
  if (d > HUB - 7 && d < R + 80) {
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    i = Math.round((((ang + 90) % 360) + 360) % 360 / 60) % SEG;
    if (!wheel.slots[i]) i = -1;
  }
  if (i === wheel.hover) return;
  wheel.hover = i;
  for (const n of wheel.el.querySelectorAll('.cw-seg, .cw-item')) n.classList.toggle('hot', +n.dataset.i === i);
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
  document.body.classList.remove('wheel-open');
  bus.emit('coverNow');
  if (now) { el.remove(); return; }
  el.classList.remove('open'); el.classList.add('closing');
  setTimeout(() => el.remove(), 150);
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
function captureTrigger({ keyOnly = true, needKeyForLeft = true } = {}) {
  let lastKey = null;
  const msg = h('div', { class: 'mg-cap-msg' }, 'Press a key, or click a mouse button (the extra thumb buttons work too). To use a key with a mouse button, hold the key and click.');
  const pad = h('div', { class: 'mg-cap', tabindex: '0' }, h('div', { class: 'mg-cap-big' }, 'Click here with your button…'), msg);
  const err = h('div', { class: 'hint', style: { color: '#ff8a80', minHeight: '18px' } });
  let close;
  const pending = new Promise((resolve) => {
    pad.addEventListener('keydown', (e) => { if (e.key === 'Escape') return; e.preventDefault(); e.stopPropagation(); if (e.repeat) return; const bad = keyProblem(e.code); if (bad) { lastKey = null; err.textContent = bad; pad.querySelector('.mg-cap-big').textContent = 'Click here with your button…'; return; } err.textContent = ''; lastKey = e.code; pad.querySelector('.mg-cap-big').textContent = keyName(lastKey) + ' …now click, or'; });
    pad.addEventListener('keyup', (e) => e.preventDefault());
    pad.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.button === 0 && !lastKey && needKeyForLeft) { err.textContent = 'The left button needs a key held with it, so ordinary clicking keeps working.'; return; }
      if (e.button === 2 && !lastKey) { err.textContent = 'The right button needs a key held with it, so the right-click menu keeps working.'; return; }
      resolve({ code: lastKey, button: e.button });
      close?.();
    });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('auxclick', (e) => e.preventDefault());
  });
  const buttons = [{ label: 'Cancel', value: null }];
  buttons.unshift({ label: 'Use the key alone', primary: true, run: (cl) => { if (!lastKey) { err.textContent = 'Press the key first.'; return false; } cl({ code: lastKey, button: null }); } });
  const modalP = modal({ title: 'Set the trigger', body: h('div', {}, pad, err), width: 480, buttons });
  setTimeout(() => { pad.focus(); close = topClose(); }, 30);
  return Promise.race([modalP, pending]);
}
export function mouseSettings(el, { group, row }) {
  const m = cfg();
  const draw = () => { el.innerHTML = ''; build(); };
  const ctl = (label, fn, cls = '') => h('button', { class: 'btn small ' + cls, onclick: fn }, label);
  const build = () => {
    const on = h('input', { type: 'checkbox', class: 'switch' });
    on.checked = m.on !== false;
    on.addEventListener('change', () => { m.on = on.checked; save(); });
    const w = m.wheel;
    el.append(
      group('Command wheel'),
      row('Command wheel', on, 'Hold the trigger and six commands open around the pointer. Move to one and let go, click it, or press 1 to 6. Nothing is listening until you set a trigger and a command.'),
      row('Trigger', h('div', { class: 'row-inline', style: { gap: '8px' } }, h('b', {}, triggerLabel(w.trigger)), ctl('Set…', async () => { const t = await captureTrigger(); if (t) { w.trigger = t; save(); draw(); } }), w.trigger ? ctl('Clear', () => { w.trigger = null; save(); draw(); }) : null)),
      h('div', { class: 'hint' }, 'Any key or any mouse button works, including the extra buttons of your mouse. The Windows key is kept by Windows, so it can’t be used. The plain left and right buttons need a key held with them so ordinary clicking keeps working.'),
    );
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

export function initMouse() {
  reload();
  bus.on('settings', reload);
}
