// Time travel (View > Time travel): a slider that shows the folder as it was (backend/src/timeline.rs). Files that are
// gone show as ghosts (right-click › Revive), changed files are marked and show what changed on hover, and folders
// glow warmer the busier they've been. Recording started when this version was installed.
import { api, bus, h, toast, fmtSize, fmtDate, isVirtual, isMtp, isRemote, TEXT_EXTS, fileUrl, KINDS, extname } from './core.js';
import { icon } from './icons.js';
import { activeTab, loadTab, paneEls, paneTab, renderTabPanes } from './pane.js';

const can = (t) => t && !t.app && !isVirtual(t.path) && !isMtp(t.path) && !isRemote(t.path);

export async function toggleTimeTravel(t = activeTab()) {
  if (!can(t)) return toast('Time travel works in folders on this PC', { error: true });
  if (t.tt) { t.tt = null; t.ttHeat = null; await loadTab(t); bus.emit('status'); return; }
  const { requirePro } = await import('./license.js');
  if (!requirePro('timetravel')) return;
  t.tt = { at: null, points: [], now: Date.now() };
  await refreshPoints(t);
  renderTabPanes(t);
  loadHeat(t);
  bus.emit('status');
}
async function refreshPoints(t) {
  const r = await api('timeline:points', t.path).catch(() => null);
  if (!t.tt) return;
  t.tt.points = (r?.points || []).map((p) => ({ ...p, t: p.t * 1000 }));
  t.tt.now = (r?.now || Date.now() / 1000) * 1000;
}
// busy folders glow warmer: changes a week over the last month
async function loadHeat(t) {
  const dirs = (t.items || []).filter((i) => i.isDir && !i.virtual).map((i) => i.path);
  if (!dirs.length) { t.ttHeat = null; return; }
  const r = await api('timeline:heat', dirs).catch(() => null);
  if (!t.tt) return;
  t.ttHeat = r || null;
  renderTabPanes(t, true);
}
export function heatClass(t, it) {
  const v = t.tt && t.ttHeat?.[it.path];
  if (!v) return '';
  return ` heat${v >= 30 ? 4 : v >= 10 ? 3 : v >= 3 ? 2 : 1}`;
}
// when a folder loads with time travel on: its points and heat (the slider keeps its time across folders)
bus.on('loaded', (t) => { if (t?.tt && can(t)) { refreshPoints(t).then(() => renderTabPanes(t, true)); loadHeat(t); } });

const when = (ms) => {
  const d = new Date(ms), today = new Date();
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === new Date(today - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

/** go to a time (null = now) */
async function goTo(t, at) {
  const pts = t.tt.points;
  if (at != null && pts.length && at >= pts[pts.length - 1].t) at = null;
  t.tt.at = at;
  await loadTab(t, { soft: true });
}

// the bar under the pane's tools
bus.on('paneRendered', ({ el, t }) => {
  let bar = el.root.querySelector(':scope > .tt-bar');
  if (!t?.tt || t.app) { bar?.remove(); el.root.classList.remove('tt-on'); return; }
  el.root.classList.add('tt-on');
  if (!bar) { bar = h('div', { class: 'tt-bar' }); el.root.insertBefore(bar, el.body); }
  drawBar(bar, t);
  wireHover(el);
});
function drawBar(bar, t) {
  const pts = t.tt.points;
  const first = pts[0]?.t ?? t.tt.now;
  const now = Math.max(t.tt.now, pts[pts.length - 1]?.t || 0);
  const span = Math.max(1, now - first);
  const cur = t.tt.at ?? now;
  bar.innerHTML = '';
  const track = h('div', { class: 'tt-track' });
  const maxC = Math.max(1, ...pts.map((p) => p.changes || 0));
  for (const p of pts) {
    const x = ((p.t - first) / span) * 100;
    track.append(h('i', { class: 'tt-tick' + (p.first ? ' first' : ''), style: { left: `${x}%`, height: `${p.first ? 100 : 30 + 70 * Math.min(1, (p.changes || 0) / maxC)}%` }, title: `${when(p.t)}${p.first ? ' · recording started' : ` · ${p.changes} change${p.changes === 1 ? '' : 's'}`}` }));
  }
  const range = h('input', { type: 'range', class: 'tt-range', min: '0', max: '1000', step: '1', value: String(Math.round(((cur - first) / span) * 1000)), 'aria-label': 'Time', 'aria-valuetext': t.tt.at ? when(cur) : 'Now' });
  const label = h('b', { class: 'tt-when' }, t.tt.at ? when(cur) : 'Now');
  // the slider snaps to the moments something changed
  const snap = (v) => { const ms = first + (v / 1000) * span; let best = null; for (const p of pts) if (p.t <= ms + span * 0.004) best = p; return best && ms < now - span * 0.004 ? best.t : null; };
  let tm = null;
  range.addEventListener('input', () => { const s = snap(+range.value); label.textContent = s ? when(s) : 'Now'; clearTimeout(tm); tm = setTimeout(() => goTo(t, s), 160); });
  range.addEventListener('keydown', (e) => e.stopPropagation());
  const step = (dir) => {
    const at = t.tt.at ?? Infinity;
    if (dir < 0) { const p = [...pts].reverse().find((x) => x.t < at - 1); if (p) goTo(t, p.t); }
    else { const p = pts.find((x) => x.t > at + 1); goTo(t, p && p !== pts[pts.length - 1] ? p.t : null); }
  };
  const stats = t.tt.at ? (() => { const g = (t.items || []).filter((i) => i.tt === 'gone').length, c = (t.items || []).filter((i) => i.tt === 'changed').length; return [g && `${g} gone since`, c && `${c} changed since`, t.ttAdded && `${t.ttAdded} added since (hidden)`].filter(Boolean).join(' · '); })() : '';
  bar.append(
    h('span', { class: 'tt-ic', html: icon('history') }),
    h('div', { class: 'tt-main' },
      h('div', { class: 'tt-top' }, label, h('span', { class: 'hint tt-stats' }, pts.length > 1 ? stats || (t.tt.at ? 'Nothing here has changed since' : '') : `Recording started ${pts[0] ? when(pts[0].t) : 'just now'}. Changes show up here as they happen.`)),
      h('div', { class: 'tt-slide' }, track, range)),
    h('button', { class: 'icon-btn small', title: 'Earlier change', disabled: pts.length < 2, html: icon('back'), onclick: () => step(-1) }),
    h('button', { class: 'icon-btn small', title: 'Later change', disabled: !t.tt.at, html: icon('forward'), onclick: () => step(1) }),
    h('button', { class: 'btn small', disabled: !t.tt.at, onclick: () => goTo(t, null) }, 'Now'),
    h('button', { class: 'icon-btn small', title: 'Close time travel', html: icon('close'), onclick: () => toggleTimeTravel(t) }));
}

/** the folder as it was, for loadTab */
export async function itemsAt(t, p) {
  const r = await api('timeline:at', { dir: p, t: t.tt.at / 1000 });
  t.ttAdded = r.addedSince || 0;
  if (r.before) toast('Dogfile hadn’t recorded this folder yet at that time');
  return (r.items || []).map((i) => ({ ...i, ext: i.isDir ? '' : extname(i.name), ghost: i.tt === 'gone' }));
}
export function ttClasses(t, it) {
  if (!t.tt) return '';
  return (it.tt === 'gone' ? ' tt-ghost' : it.tt === 'changed' ? ' tt-changed' : '') + heatClass(t, it);
}

/** Revive: from the Recycle Bin (where it was deleted from), else the newest saved version */
export async function revive(items) {
  let ok = 0; const missing = [];
  for (const it of items) {
    try {
      await api('recycle:restoreOriginal', [it.path]).catch(() => null);
      if (await api('fs:exists', it.path)) { ok++; continue; }
      const v = await api('versions:list', it.path).catch(() => []);
      if (v?.length) { await api('versions:restore', it.path, v[0].id, {}); ok++; continue; }
      missing.push(it.name);
    } catch (e) { missing.push(`${it.name} (${e.message})`); }
  }
  if (ok) toast(`Revived ${ok} item${ok === 1 ? '' : 's'}`);
  if (missing.length) toast(`${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}: not in the Recycle Bin or Versions, so ${missing.length === 1 ? 'it' : 'they'} can’t come back`, { error: true, ms: 8000 });
  const t = activeTab();
  if (t) await loadTab(t, { soft: true });
}

// ---- what changed, on hover ----
let tip = null, hoverTm = null;
function hideTip() { clearTimeout(hoverTm); tip?.remove(); tip = null; }
function wireHover(el) {
  if (el._ttHover) return;
  el._ttHover = true;
  el.inner.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.cell.tt-changed, .cell.tt-ghost');
    if (!cell) { if (!e.target.closest('.tt-tip')) hideTip(); return; }
    if (tip?.dataset.ix === cell.dataset.ix) return;
    hideTip();
    hoverTm = setTimeout(() => showTip(el, cell), 450);
  });
  el.inner.addEventListener('mouseleave', hideTip);
  el.scroller.addEventListener('scroll', hideTip, { passive: true });
}
async function showTip(el, cell) {
  const pane = paneEls.indexOf(el);
  const tab = pane >= 0 ? paneTab(pane) : activeTab();
  const it = tab?.shown?.[+cell.dataset.ix];
  if (!it || !tab.tt?.at) return;
  const r = cell.getBoundingClientRect();
  tip = h('div', { class: 'tt-tip', 'data-ix': cell.dataset.ix });
  const line = (k, size, mt) => h('div', { class: 'tt-line' }, h('span', { class: 'hint' }, k), `${size != null ? fmtSize(size) : ''}${mt ? ` · ${fmtDate(mt)}` : ''}`);
  tip.append(h('b', {}, it.name));
  if (it.tt === 'gone') tip.append(h('div', { class: 'hint' }, 'Gone now. Right-click › Revive brings it back from the Recycle Bin or Versions.'), line('Then', it.size, it.mtime));
  else tip.append(line('Then', it.size, it.mtime), line('Now', it.nowSize, it.nowMtime));
  document.body.append(tip);
  const place = () => { if (!tip) return; const w = tip.offsetWidth, hh = tip.offsetHeight; tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + 24))}px`; tip.style.top = `${r.bottom + 6 + hh > innerHeight ? Math.max(8, r.top - hh - 6) : r.bottom + 6}px`; };
  place();
  if (it.tt !== 'changed' || it.isDir) return;
  // a saved version from that time shows exactly what changed
  const vs = await api('versions:list', it.path).catch(() => []);
  if (!tip) return;
  const v = (vs || []).find((x) => x.at <= tab.tt.at + 60000) || null;
  const ext = (it.ext || '').toLowerCase();
  if (!v) { tip.append(h('div', { class: 'hint tt-nov' }, 'Keep versions of a file (Tools › Versions) to see exactly what changed.')); place(); return; }
  if (KINDS.image.includes(ext) && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) {
    tip.append(h('div', { class: 'tt-imgs' }, h('figure', {}, h('img', { src: fileUrl(v.file) }), h('figcaption', {}, 'Then')), h('figure', {}, h('img', { src: fileUrl(it.path) + `?t=${Date.now()}` }), h('figcaption', {}, 'Now'))));
  } else if (TEXT_EXTS.has(ext) || ['txt', 'md', 'csv', 'json', 'html', 'css', 'js'].includes(ext)) {
    const [a, b] = await Promise.all([api('fs:readText', v.file).catch(() => ''), api('fs:readText', it.path).catch(() => '')]);
    if (!tip) return;
    tip.append(diffView(String(a?.text ?? a), String(b?.text ?? b)));
  } else tip.append(h('div', { class: 'hint' }, `A version from ${when(v.at)} is saved: Right-click › Versions to compare or bring it back.`));
  place();
}
/** a short line diff: what was removed and added (first few lines of each) */
function diffView(a, b) {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  const inB = new Map(), inA = new Map();
  for (const l of B) inB.set(l, (inB.get(l) || 0) + 1);
  for (const l of A) inA.set(l, (inA.get(l) || 0) + 1);
  const removed = [], added = [];
  for (const l of A) { if (inB.get(l)) inB.set(l, inB.get(l) - 1); else removed.push(l); }
  for (const l of B) { if (inA.get(l)) inA.set(l, inA.get(l) - 1); else added.push(l); }
  const box = h('div', { class: 'tt-diff' }, h('div', { class: 'hint' }, `${removed.length} line${removed.length === 1 ? '' : 's'} removed · ${added.length} added`));
  for (const l of removed.slice(0, 6)) box.append(h('div', { class: 'del' }, `− ${l}`));
  for (const l of added.slice(0, 6)) box.append(h('div', { class: 'add' }, `+ ${l}`));
  return box;
}
