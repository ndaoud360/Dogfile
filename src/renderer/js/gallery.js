// Gallery & media tools: the media filter panel (kind, colour, "looks like this", length, BPM, key), BPM/key
// analysis of a whole folder, video contact sheets, and finding similar videos / songs.
import { api, state, bus, h, esc, toast, fmtSize, basename, dirname } from './core.js';
import { icon } from './icons.js';
import { modal, confirm } from './dialogs.js';
import { activeTab, recompute, renderTabPanes, selectedItems, navigate } from './pane.js';
import * as MM from './mediameta.js';
import * as A from './actions.js';
import { requirePro } from './license.js';

let openPanel = null;
function popover(anchor, content) {
  openPanel?.close();
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'popover' }, content);
  document.body.append(el);
  const w = el.offsetWidth, hh = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
  el.style.top = (r.bottom + 6 + hh > innerHeight - 8 ? Math.max(8, r.top - hh - 6) : r.bottom + 6) + 'px';
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { el.remove(); document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); if (openPanel?.el === el) openPanel = null; };
  setTimeout(() => { document.addEventListener('mousedown', onDown, true); document.addEventListener('keydown', onKey, true); }, 0);
  openPanel = { el, close };
  return openPanel;
}

const CAMELOT = []; for (let n = 1; n <= 12; n++) CAMELOT.push(`${n}A`, `${n}B`);
export function mediaFilterPanel(t, anchor) {
  t.mf = t.mf || {};
  const f = t.mf;
  const apply = () => { recompute(t); renderTabPanes(t); redraw(); };
  const items = t.items || [];
  const has = { pic: items.some(MM.isPic), vid: items.some(MM.isVid), aud: items.some(MM.isAud) };
  const body = h('div', { class: 'mf' });
  const redraw = () => {
    body.innerHTML = '';
    const sec = (title, ...c) => h('div', { class: 'mf-sec' }, h('div', { class: 'mf-h' }, title), ...c);
    const chip = (label, on, run) => { const b = h('button', { class: 'chip' + (on ? ' on' : '') }, label); b.onclick = () => { run(); apply(); }; return b; };
    const kinds = [['all', 'Everything'], has.pic && ['photos', 'Pictures'], has.pic && ['camera', 'Camera photos'], has.pic && ['screenshots', 'Screenshots'], has.pic && ['artwork', 'Artwork'], has.vid && ['videos', 'Videos'], has.aud && ['music', 'Music']].filter(Boolean);
    body.append(sec('Show', h('div', { class: 'mf-row' }, ...kinds.map(([k, l]) => chip(l, (f.kind || 'all') === k, () => { f.kind = k; })))));
    if (has.pic || has.vid) {
      body.append(sec('Colour', h('div', { class: 'mf-row' }, ...MM.COLORS.map(([c, hex]) => { const b = h('button', { class: 'mf-sw' + (f.color === c ? ' on' : ''), title: c, style: { background: hex } }); b.onclick = () => { f.color = f.color === c ? null : c; apply(); }; return b; }))));
      const sel = selectedItems(t).find((i) => MM.isPic(i) || MM.isVid(i));
      const sm = MM.metaOf(sel || {});
      body.append(sec('Looks like', h('div', { class: 'mf-row' },
        f.similar ? chip('Showing look-alikes · clear', true, () => { f.similar = null; }) : chip(sel ? `Pictures that look like “${sel.name}”` : 'Select a picture first', false, () => { if (sm?.hash) f.similar = sm.hash; else toast(sel ? 'Still reading that picture. Try again in a moment.' : 'Select a picture first'); }))));
    }
    if (has.vid || has.aud) {
      const durs = [['', 'Any'], ['0-60', 'Under 1 min'], ['60-300', '1-5 min'], ['300-1200', '5-20 min'], ['1200-', 'Over 20 min']];
      const cur = `${f.minDur || ''}-${f.maxDur || ''}`.replace(/^-$/, '');
      body.append(sec('Length', h('div', { class: 'mf-row' }, ...durs.map(([v, l]) => chip(l, cur === v || (!v && !cur), () => { const [a, b] = v.split('-'); f.minDur = +a || 0; f.maxDur = +b || 0; })))));
    }
    if (has.aud) {
      const num = (k, ph) => { const x = h('input', { class: 'input sm', type: 'number', placeholder: ph, style: { width: '74px' } }); x.value = f[k] || ''; x.onchange = () => { f[k] = +x.value || 0; apply(); }; x.addEventListener('keydown', (e) => e.stopPropagation()); return x; };
      const key = h('select', { class: 'input sm' }, h('option', { value: '' }, 'Any key'), ...CAMELOT.map((c) => h('option', { value: c }, c)));
      key.value = f.key || ''; key.onchange = () => { f.key = key.value || null; apply(); };
      const compat = h('input', { type: 'checkbox' }); compat.checked = !!f.keyCompat; compat.onchange = () => { f.keyCompat = compat.checked; apply(); };
      const analyzed = items.filter(MM.isAud).filter((i) => MM.metaOf(i)?.bpm).length, total = items.filter(MM.isAud).length;
      body.append(sec('BPM', h('div', { class: 'mf-row' }, num('minBpm', 'from'), h('span', { class: 'hint' }, 'to'), num('maxBpm', 'to'))),
        sec('Key', h('div', { class: 'mf-row' }, key, h('label', { class: 'check' }, compat, ' + keys that mix well'))),
        h('div', { class: 'mf-row hint' }, `${analyzed} of ${total} songs analyzed`, analyzed < total ? h('button', { class: 'btn small', onclick: () => { p.close(); analyzeFolder(t); } }, 'Analyze BPM & key') : null));
    }
    body.append(h('div', { class: 'mf-foot' }, h('button', { class: 'btn small', onclick: () => { t.mf = null; recompute(t); renderTabPanes(t); p.close(); } }, 'Clear'), h('span', { class: 'st-spacer' }),
      t.view !== 'gallery' && (has.pic || has.vid) ? h('button', { class: 'btn small', onclick: () => { import('./pane.js').then((m) => m.setView(t, 'gallery')); p.close(); } }, 'Gallery view') : null,
      h('button', { class: 'btn small primary', onclick: () => p.close() }, 'Done')));
  };
  redraw();
  const p = popover(anchor, body);
}

// BPM & key for every song in the folder (one at a time, in the background)
export async function analyzeFolder(t = activeTab()) {
  const songs = (t.items || []).filter((i) => MM.isAud(i) && !MM.metaOf(i)?.bpm);
  if (!songs.length) return toast('Every song here is already analyzed');
  const { analyzeAudio } = await import('./audio-analysis.js');
  let done = 0, stop = false;
  const host = document.getElementById('toasts');
  const txt = h('span', {}, `Analyzing BPM & key… 0 of ${songs.length}`);
  const fill = h('div', { class: 'tp-fill' });
  const el = h('div', { class: 'toast show tprog' }, txt, h('div', { class: 'tp-bar' }, fill), h('button', { class: 'link', onclick: () => { stop = true; } }, 'Stop'));
  host?.append(el);
  for (const it of songs) {
    if (stop) break;
    try { const a = await analyzeAudio(it.path); MM.setMeta(it, { bpm: a.bpm, key: a.keyLabel, camelot: a.camelot }); } catch {}
    done++;
    txt.textContent = `Analyzing BPM & key… ${done} of ${songs.length}`;
    fill.style.width = (done / songs.length) * 100 + '%';
    if (done % 4 === 0) { recompute(t); renderTabPanes(t, true); }
  }
  el.remove();
  recompute(t); renderTabPanes(t, true);
  toast(`Analyzed ${done} song${done === 1 ? '' : 's'}. Sort or filter by BPM and key from the Media filter or the Sort menu.`);
}

export async function contactSheets(items) {
  if (!requirePro('convert')) return;
  const vids = items.filter(MM.isVid);
  if (!vids.length) return toast('Select one or more videos');
  let made = [];
  const { progressToast } = await import('./mediatools.js');
  let cancelled = false, jobId = null;
  const p = progressToast(`Making a contact sheet…`, () => { cancelled = true; if (jobId) api('media:sheetCancel', jobId); });
  const off = window.atlas.on('media:sheetProgress', (m) => { if (m.jobId === jobId) p.set(((vids.indexOf(cur) + m.done / m.total) / vids.length) * 100); });
  let cur = null;
  for (const v of vids) {
    if (cancelled) break;
    cur = v; jobId = 'sheet-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    p.set((vids.indexOf(v) / vids.length) * 100, `Contact sheet for “${v.name}”${vids.length > 1 ? ` (${vids.indexOf(v) + 1} of ${vids.length})` : ''}…`);
    try { made.push(await api('media:contactSheet', v.path, { cols: 4, rows: 4, jobId })); } catch (e) { if (!cancelled) toast(`${v.name}: ${e.message}`, { error: true }); }
  }
  off?.(); p.done();
  if (cancelled) toast('Contact sheet cancelled');
  if (made.length) {
    toast(`Saved ${made.length} contact sheet${made.length === 1 ? '' : 's'}`, { action: { label: 'Show', run: () => navigate(activeTab(), dirname(made[0]), { select: made[0] }) } });
    bus.emit('refreshPanes');
  }
}

// similar videos (frames that look alike) and songs (same length & tempo & key, or same sound fingerprint)
export async function findSimilarMedia(t = activeTab()) {
  if (!requirePro('dupes')) return;
  const vids = (t.items || []).filter(MM.isVid), auds = (t.items || []).filter(MM.isAud);
  if (vids.length + auds.length < 2) return toast('This folder needs at least two videos or songs');
  const status = h('div', { class: 'hint' }, 'Reading media…');
  const list = h('div', { class: 'dupe-list' });
  let cancelled = false;
  const work = (async () => {
    await MM.ensureMeta([...vids, ...auds]);
    const groups = [];
    // videos: hash a frame at 25% / 50% / 75%
    const im = new Image(); im.crossOrigin = 'anonymous';
    const load = (src) => new Promise((res) => { im.onload = () => res(true); im.onerror = () => res(false); im.src = src; });
    const vh = [];
    for (let i = 0; i < vids.length && !cancelled; i++) {
      const v = vids[i], m = MM.metaOf(v) || {};
      status.textContent = `Looking at videos… ${i + 1} of ${vids.length}`;
      const hs = [];
      for (const f of [0.25, 0.5, 0.75]) { if (await load(`/media/thumb?p=${encodeURIComponent(v.path)}&t=${((m.dur || 10) * f).toFixed(1)}&w=96`)) hs.push(MM.analyzeImage(im)?.hash); }
      vh.push({ it: v, hs: hs.filter(Boolean), dur: m.dur || 0 });
    }
    const used = new Set();
    for (const a of vh) {
      if (used.has(a)) continue;
      const g = [a];
      for (const b of vh) if (b !== a && !used.has(b) && Math.abs(a.dur - b.dur) < Math.max(3, a.dur * 0.03) && a.hs.length && b.hs.length && a.hs.filter((x, k) => MM.hashDistance(x, b.hs[k]) <= 12).length >= Math.min(2, a.hs.length)) g.push(b);
      if (g.length > 1) { g.forEach((x) => used.add(x)); groups.push({ kind: 'Videos', items: g.map((x) => x.it), why: 'same length and the same frames' }); }
    }
    // songs: same length (±2 s) and, when analyzed, same tempo and key
    const ua = new Set();
    for (const a of auds) {
      if (ua.has(a)) continue;
      const ma = MM.metaOf(a) || {};
      if (!ma.dur) continue;
      const g = [a];
      for (const b of auds) {
        if (b === a || ua.has(b)) continue;
        const mb = MM.metaOf(b) || {};
        if (Math.abs((mb.dur || 0) - ma.dur) > 2) continue;
        if (ma.bpm && mb.bpm && (Math.abs(ma.bpm - mb.bpm) > 1.5 || ma.camelot !== mb.camelot)) continue;
        const na = a.name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, ''), nb = b.name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '');
        if (!(ma.bpm && mb.bpm) && !(na.includes(nb.slice(0, 8)) || nb.includes(na.slice(0, 8)))) continue;
        g.push(b);
      }
      if (g.length > 1) { g.forEach((x) => ua.add(x)); groups.push({ kind: 'Songs', items: g, why: ma.bpm ? 'same length, tempo and key' : 'same length and a similar name' }); }
    }
    status.textContent = groups.length ? `${groups.length} set${groups.length === 1 ? '' : 's'} of similar media. Untick what you want to keep (the first in each set is kept by default).` : 'No similar videos or songs found.';
    list.innerHTML = '';
    groups.forEach((g, gi) => list.append(h('div', { class: 'dupe-group' }, h('div', { class: 'dg-head' }, `${g.kind}: ${g.why}`), ...g.items.map((it, fi) => h('label', { class: 'dg-file' }, h('input', { type: 'checkbox', 'data-g': gi, 'data-f': fi, checked: fi > 0 }), h('span', {}, it.name), h('span', { class: 'hint' }, `${MM.fmtDur(MM.metaOf(it)?.dur)} · ${fmtSize(it.size || 0)}${MM.metaOf(it)?.bpm ? ` · ${Math.round(MM.metaOf(it).bpm)} BPM ${MM.metaOf(it).camelot || ''}` : ''}`))))));
    list._groups = groups;
  })();
  await modal({ title: `Similar videos & songs in ${basename(t.path)}`, width: 760, body: h('div', { class: 'stack' }, status, list), onClose: () => { cancelled = true; }, buttons: [
    { label: 'Close', value: null },
    { label: 'Recycle checked', primary: true, danger: true, run: async (c) => {
      const g = list._groups || [];
      const paths = [...list.querySelectorAll('input:checked')].map((x) => g[x.dataset.g].items[x.dataset.f].path);
      if (!paths.length) return false;
      if (!(await confirm('Recycle similar media?', `Move ${paths.length} files to the Recycle Bin?`))) return false;
      await A.runJob({ type: 'trash', sources: paths });
      c(true);
    } }] });
  await work.catch(() => {});
}
bus.on('analyzeFolderAudio', () => analyzeFolder());
