// window.atlas: how the interface talks to Dogfile's back end (Rust). Loaded first in every page.
//   invoke(name, ...args) -> Promise      a call (files, copies, search, media…)
//   on(channel, fn) -> unsubscribe        events from the back end (folder changed, copy progress…)
//   startDrag(paths)                      drag files out to Explorer, the desktop, mail…
// In the app, events arrive through window.__dogEvent; in a plain browser (development) as server-sent events.
(function () {
  if (window.atlas) return;
  const qs = new URLSearchParams(location.search);
  let top = window;
  try { while (top.parent && top.parent !== top && top.parent.__dogWin) top = top.parent; } catch {}
  const isTop = top === window;
  const page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  const win = isTop ? (qs.get('w') || (page === 'index' ? 'main-1' : page + '-1')) : top.__dogWin;
  window.__dogWin = win;
  const inApp = /(^|\.)dogfile\.localhost$/.test(location.hostname) || location.protocol === 'dogfile:';

  // Calls that start a job answer with its id, and the job's events can overtake that answer (they travel
  // separately). While such a call is on its way, events wait, so the caller is listening for its id first.
  const STARTERS = /^(work:start|ops:start|pty:spawn|media:(job|contactSheet|export)|remote:(get|put)|ai:download|tags:identify)$/;
  let starting = 0;
  const held = [];
  const flush = () => { if (starting) return; while (held.length) { const [c, d] = held.shift(); deliver(c, d); } };
  const H = { inc: () => { starting++; }, dec: () => { starting = Math.max(0, starting - 1); flush(); } };
  if (isTop) window.__dogHold = H;
  async function invoke(name, ...args) {
    // a missing last argument stays missing (not null), like the old IPC
    while (args.length && args[args.length - 1] === undefined) args.pop();
    const st = STARTERS.test(name);
    const hold = isTop ? H : top.__dogHold; // app tabs (iframes) hold their window's events
    if (st) hold?.inc();
    try {
      const r = await fetch('/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dog-win': win }, body: JSON.stringify({ name, args, win }) });
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Failed');
      return j.v;
    } finally {
      // let the caller's code after `await` run (and start listening) before the held events go out
      if (st) setTimeout(() => hold?.dec(), 0);
    }
  }

  const listeners = new Map();
  function dispatch(c, d) {
    if (c === 'dogfile:drag') return nativeDrag(d);
    if (starting || held.length) { held.push([c, d]); if (!starting) flush(); return; }
    deliver(c, d);
  }
  function deliver(c, d) {
    const s = listeners.get(c);
    if (s) for (const fn of [...s]) { try { fn(d); } catch (e) { console.error(e); } }
  }
  function on(c, fn) {
    // events go to the window's main page only (embedded app tabs get theirs from it)
    if (!isTop) return () => {};
    if (!listeners.has(c)) listeners.set(c, new Set());
    listeners.get(c).add(fn);
    return () => listeners.get(c)?.delete(fn);
  }
  if (isTop) {
    window.__dogEvent = dispatch;
    if (!inApp) {
      const es = new EventSource('/events?w=' + encodeURIComponent(win));
      es.onmessage = (e) => { try { const m = JSON.parse(e.data); dispatch(m.c, m.d); } catch {} };
    }
  }

  // files dragged in from Explorer: the app reports them with their position; the page decides where they go
  function nativeDrag(d) {
    const k = window.devicePixelRatio || 1;
    const detail = { type: d.type, paths: d.paths || [], x: (d.x || 0) / k, y: (d.y || 0) / k };
    window.dispatchEvent(new CustomEvent('dogfile:nativedrag', { detail }));
  }

  window.atlas = {
    invoke,
    on,
    startDrag: (paths) => { invoke('win:dragOut', paths).catch(() => {}); },
    pathForFile: (file) => (file && file.path) || null,
    win,
    inApp,
  };

  // Dragging inside the page (tabs, playlists, sidebar pins). The app takes over the system's drag and drop so it
  // can report files dragged in from Explorer with their paths, and that stops the browser's own drag and drop
  // reaching the page. So in the app, drags that start on the page are run here instead: the same dragstart /
  // dragenter / dragover / dragleave / drop / dragend events, driven by the mouse.
  if (inApp) {
    let poly = null;
    const fire = (type, target, src, init = {}) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: src.dt, clientX: src.x, clientY: src.y, screenX: src.sx, screenY: src.sy, ctrlKey: src.ctrl, shiftKey: src.shift, altKey: src.alt, ...init });
      ev.__dog = true;
      target.dispatchEvent(ev);
      return ev;
    };
    const end = (drop) => {
      const p = poly; poly = null;
      if (!p) return;
      window.removeEventListener('mousemove', p.move, true); window.removeEventListener('mouseup', p.up, true); window.removeEventListener('keydown', p.key, true);
      document.documentElement.classList.remove('dog-dragging');
      if (drop && p.over && p.accepted) fire('drop', p.over, p);
      else if (p.over) fire('dragleave', p.over, p);
      fire('dragend', p.src, p);
    };
    window.addEventListener('dragstart', (e) => {
      if (e.__dog || (!e.isTrusted && !e.__dogTest)) return;
      // the system drag would swallow the rest of the gesture: cancel it and run our own
      e.preventDefault(); e.stopImmediatePropagation();
      const src = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      if (!src) return;
      const p = { src, dt: new DataTransfer(), x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, over: null, accepted: false };
      const st = fire('dragstart', src, p);
      if (st.defaultPrevented) return; // the page runs this drag itself (files)
      poly = p;
      document.documentElement.classList.add('dog-dragging');
      p.move = (ev) => {
        if (!ev.buttons) { end(true); return; }
        Object.assign(p, { x: ev.clientX, y: ev.clientY, sx: ev.screenX, sy: ev.screenY, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey });
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (el !== p.over) {
          if (p.over) fire('dragleave', p.over, p, { relatedTarget: el });
          if (el) fire('dragenter', el, p);
          p.over = el;
        }
        p.dt.dropEffect = 'none';
        p.accepted = !!el && fire('dragover', el, p).defaultPrevented;
        fire('drag', src, p);
      };
      p.up = (ev) => { Object.assign(p, { x: ev.clientX, y: ev.clientY }); end(true); };
      p.key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); end(false); } };
      window.addEventListener('mousemove', p.move, true); window.addEventListener('mouseup', p.up, true); window.addEventListener('keydown', p.key, true);
    }, true);
    const css = document.createElement('style');
    css.textContent = 'html.dog-dragging, html.dog-dragging * { cursor: grabbing !important; user-select: none !important; } html.dog-dragging iframe { pointer-events: none !important; }';
    document.head ? document.head.append(css) : document.addEventListener('DOMContentLoaded', () => document.head.append(css));
  }

  // window edges: the app has no system frame, so the outer few pixels resize the window
  if (inApp && isTop) {
    const D = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' };
    const mk = () => {
      const box = document.createElement('div');
      box.id = 'dog-resize';
      const B = 5, C = 10;
      const spots = { n: `top:0;left:${C}px;right:${C}px;height:${B}px;cursor:ns-resize`, s: `bottom:0;left:${C}px;right:${C}px;height:${B}px;cursor:ns-resize`, w: `left:0;top:${C}px;bottom:${C}px;width:${B}px;cursor:ew-resize`, e: `right:0;top:${C}px;bottom:${C}px;width:${B}px;cursor:ew-resize`,
        nw: `left:0;top:0;width:${C}px;height:${C}px;cursor:nwse-resize`, ne: `right:0;top:0;width:${C}px;height:${C}px;cursor:nesw-resize`, sw: `left:0;bottom:0;width:${C}px;height:${C}px;cursor:nesw-resize`, se: `right:0;bottom:0;width:${C}px;height:${C}px;cursor:nwse-resize` };
      for (const [k, s] of Object.entries(spots)) {
        const d = document.createElement('div');
        d.style.cssText = `position:fixed;z-index:2147483646;${s}`;
        d.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); invoke('win:startResize', D[k]); } });
        box.append(d);
      }
      document.body.append(box);
    };
    document.body ? mk() : document.addEventListener('DOMContentLoaded', mk);
    // maximized windows have no edges to drag
    const sync = (m) => { const b = document.getElementById('dog-resize'); if (b) b.style.display = m ? 'none' : ''; };
    on('win:state', (s) => sync(!!s?.maximized));
    invoke('win:control', 'isMaximized').then(sync).catch(() => {});
  }

  // title bars: areas styled "-webkit-app-region: drag" move the window; double-click maximizes
  if (inApp && isTop) {
    const region = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.matches('button, input, select, textarea, a, [contenteditable=""], [contenteditable="true"], .tab')) return 'no-drag';
        const cs = getComputedStyle(n);
        const v = cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || cs.webkitAppRegion || cs.appRegion;
        if (v === 'drag' || v === 'no-drag') return v;
      }
      return '';
    };
    // a double-click on a title bar maximizes (as with a system title bar) and goes no further
    let eatDbl = false;
    window.addEventListener('dblclick', (e) => { if (eatDbl) { eatDbl = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      if (region(e.target) !== 'drag') return;
      if (e.detail >= 2) { invoke('win:control', 'max'); e.preventDefault(); eatDbl = true; return; }
      invoke('win:startDrag');
    });
  }
})();
