// Preview pane + Quick Look (Space): images, video, audio, PDF, text/code with line numbers,
// Markdown, CSV tables, JSON, fonts, archive contents, folder summaries and a hex view for binaries.
import { shownPath, api, state, bus, h, esc, fmtSize, fmtDate, typeLabel, kindOf, fileUrl, DECODED_IMG, decodedUrl, KINDS, basename, dirname, isVirtual, tagsOf, toast } from './core.js';
import { openTool } from './apptabs.js';
import { icon, fileArt, folderArt } from './icons.js';
import { markdown } from './md.js';
import { readExif } from './exif.js';
export { markdown };
import { activeTab, selectedItems, paneEls, selectOnly, renderTabPanes } from './pane.js';
import * as A from './actions.js';
import { OFFICE, renderOffice, pdfRows, editDocProps, notesSection, previewMenu } from './docpreview.js';

const TEXT_EXT = new Set([...KINDS.code, 'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'nfo', 'srt', 'vtt', 'reg', 'inf', 'ini', 'cfg', 'properties', 'gitattributes', 'license', 'readme', 'sln', 'csproj', 'vcxproj', 'plist', 'lock', 'toml', 'diff', 'patch', 'tex', 'bib', 'rst', 'adoc', 'svg']);
let seq = 0;

export async function renderPreview(box, it, { large = false } = {}) {
  const my = ++seq;
  box.innerHTML = '';
  if (!it) { box.append(h('div', { class: 'pv-empty' }, h('div', { html: icon('eye') }), h('div', {}, 'Select a file to preview'))); return; }
  const stage = h('div', { class: 'pv-stage' + (large ? ' large' : '') });
  const meta = h('div', { class: 'pv-meta' });
  box.append(stage);
  if (!large) box.append(meta);
  if (it.ext == null && !it.isDir) { const i = (it.name || '').lastIndexOf('.'); it.ext = i > 0 ? it.name.slice(i + 1).toLowerCase() : ''; }
  const k = kindOf(it);
  const url = fileUrl(it.path);
  const addMeta = (rows) => { meta.innerHTML = ''; meta.append(h('div', { class: 'pv-name', title: it.name }, it.name), h('div', { class: 'kv' }, ...rows.filter(Boolean).flatMap(([a, b]) => [h('div', { class: 'k' }, a), h('div', { class: 'v' }, b)]))); };
  const baseRows = () => [
    ['Type', it.drive ? 'Drive' : typeLabel(it)],
    !it.isDir && ['Size', `${fmtSize(it.size)}${it.size >= 1024 ? ` (${(it.size || 0).toLocaleString()} bytes)` : ''}`],
    it.mtime && ['Modified', fmtDate(it.mtime, 'locale')],
    it.ctime && ['Created', fmtDate(it.ctime, 'locale')],
    it.recycle && ['Deleted from', it.recycle.from],
    !isVirtual(it.path) && !it.archive && ['Location', shownPath(dirname(it.path) || '')],
  ];
  addMeta(baseRows());
  if (!large) box.append(h('button', { class: 'icon-btn small pv-menu', title: 'Choose what the preview pane shows', html: icon('more'), onclick: (e) => previewMenu(e.clientX, e.clientY) }));
  if (!large && !it.isDir && !it.virtual && !it.recycle && !it.archive && !isVirtual(it.path)) notesSection(it).then((n) => { if (my === seq) box.append(n); });
  if (!large && !it.virtual && !it.recycle && !it.archive) {
    const actions = h('div', { class: 'pv-actions' },
      h('button', { class: 'btn small', onclick: () => A.openItems([it]) }, 'Open'),
      !it.isDir && h('button', { class: 'btn small', onclick: () => api('shell:openWith', it.path) }, 'Open with…'),
      h('button', { class: 'btn small', onclick: () => A.copyPaths([it]) }, 'Copy path'));
    meta.append(actions);
  }
  if (it.drive) {
    const d = it.drive; const pct = d.total ? (1 - d.free / d.total) * 100 : 0;
    stage.append(h('div', { class: 'pv-drive' }, h('div', { class: 'pv-icon', html: icon('drive') }), h('div', { class: 'usage big' }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'hint' }, `${fmtSize(d.free)} free of ${fmtSize(d.total)} · ${d.fs || ''}`)));
    return;
  }
  if (it.isDir) {
    stage.append(h('div', { class: 'pv-folder', html: folderArt() }));
    if (it.virtual || isVirtual(it.path)) return;
    const r = await api('fs:list', it.path);
    if (my !== seq) return;
    const items = r.items || [];
    const sizeEl = h('span', {}, '…');
    addMeta([...baseRows(), ['Contains', `${items.filter((x) => x.isDir).length} folders, ${items.filter((x) => !x.isDir).length} files`], ['Size', sizeEl]]);
    meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => A.openItems([it]) }, 'Open'), h('button', { class: 'btn small', onclick: () => A.copyPaths([it]) }, 'Copy path')));
    A.folderSize(it.path).then((s) => { if (my === seq) sizeEl.textContent = `${fmtSize(s.total)} · ${s.files.toLocaleString()} files`; });
    const list = h('div', { class: 'pv-list' });
    for (const c of items.slice(0, 60)) list.append(h('div', { class: 'pv-li' }, h('span', { html: icon(c.isDir ? 'folder' : 'page') }), c.name));
    stage.append(list);
    return;
  }
  if (it.archive) { stage.append(h('div', { class: 'pv-art', html: fileArt(it.ext) }), h('div', { class: 'hint center' }, 'Inside an archive. Open it to extract')); return; }
  // online-only (OneDrive and other cloud placeholders): previewing would download the whole file
  if (it.cloud && !it._fetch) {
    stage.append(h('div', { class: 'pv-art', html: fileArt(it.ext) }), h('div', { class: 'hint center' }, 'Online-only file. It isn’t on this PC yet.'), h('div', { class: 'center', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onclick: () => { it._fetch = true; renderPreview(box, it, { large }); } }, 'Download and preview')));
    return;
  }
  try {
    if (k === 'image' && !['psd', 'raw', 'cr2', 'nef', 'dng', 'heic', 'tif', 'tiff'].includes(it.ext)) {
      const img = h('img', { class: 'pv-img', src: url, draggable: 'false', crossorigin: 'anonymous' });
      const transparent = ['png', 'webp', 'gif', 'svg', 'ico', 'avif', 'apng', 'bmp'].includes(it.ext);
      const wrap = h('div', { class: 'pv-imgwrap' + (transparent && state.settings.checker !== false ? ' checker' : '') }, img);
      img.onload = async () => {
        const rows = [...baseRows(), ['Dimensions', `${img.naturalWidth} × ${img.naturalHeight}`]];
        if (['jpg', 'jpeg', 'jfif'].includes(it.ext)) { const ex = await readExif(it.path).catch(() => null); if (ex) rows.push(...ex); }
        if (my !== seq) return;
        addMeta(rows);
        const pal = palette(img);
        if (pal.length && !large) meta.append(h('div', { class: 'pv-palette', title: 'Dominant colors (click to copy)' }, ...pal.map((c) => h('button', { class: 'pv-sw2', style: { background: c }, title: c, onclick: () => { api('clip:writeText', c); toast(`Copied ${c}`); } }))));
        if (transparent && !large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => { state.settings.checker = wrap.classList.toggle('checker'); } }, 'Toggle transparency grid')));
      };
      if (large) { let z = 1; img.addEventListener('wheel', (e) => { e.preventDefault(); z = Math.max(0.2, Math.min(8, z * (e.deltaY < 0 ? 1.15 : 0.87))); img.style.transform = `scale(${z})`; }, { passive: false }); img.addEventListener('dblclick', () => { z = 1; img.style.transform = ''; }); }
      stage.append(wrap);
    } else if (k === 'video') {
      const v = h('video', { class: 'pv-video', src: url, controls: true, preload: 'metadata', autoplay: large ? true : null, muted: !large ? true : null });
      v.onloadedmetadata = () => addMeta([...baseRows(), ['Dimensions', `${v.videoWidth} × ${v.videoHeight}`], ['Duration', fmtDur(v.duration)]]);
      v.onerror = () => thumbOrArt(stage, it);
      stage.append(v);
      if (!large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => openTool('player', [it.path], { play: true }) }, 'Play in Dogfile Player')));
    } else if (k === 'audio') {
      const a = h('audio', { class: 'pv-audio', src: url, controls: true, preload: 'metadata', autoplay: large ? true : null });
      const wave = h('canvas', { class: 'pv-wave', title: 'Click to seek' });
      a.onloadedmetadata = () => addMeta([...baseRows(), ['Duration', fmtDur(a.duration)]]);
      stage.append(wave, a);
      const playBtn = () => { if (!large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => openTool('player', [it.path], { play: true }) }, 'Play in Dogfile Player'))); };
      playBtn();
      waveform(wave, a, url, it, (info) => { if (my === seq) { addMeta([...baseRows(), ['Duration', fmtDur(info.duration)], ['Sample rate', `${(info.sampleRate / 1000).toFixed(1)} kHz`], ['Channels', info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : String(info.channels)], ['Peak level', `${info.peakDb.toFixed(1)} dBFS`]]); playBtn(); } });
    } else if (it.ext === 'pdf') {
      stage.append(h('iframe', { class: 'pv-pdf', src: url + '#toolbar=0&navpanes=0', title: it.name }));
      pdfRows(it).then((rows) => { if (my === seq && rows.length) { addMeta([...baseRows(), ...rows]); if (!large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => A.openItems([it]) }, 'Open'), h('button', { class: 'btn small', onclick: () => editDocProps(it) }, 'Edit properties…'))); } });
    } else if (OFFICE.has(it.ext)) {
      const d = await renderOffice(stage, it, { large, alive: () => my === seq, addRows: (rows) => { if (my === seq) addMeta([...baseRows(), ...rows.filter(Boolean)]); } });
      if (my === seq && !large && d) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => A.openItems([it]) }, 'Open'), !['rtf', 'odt', 'ods', 'odp', 'ott'].includes(it.ext) && h('button', { class: 'btn small', onclick: () => editDocProps(it) }, 'Edit properties…'), h('button', { class: 'btn small', onclick: () => A.copyPaths([it]) }, 'Copy path')));
    } else if (KINDS.model.includes(it.ext) && it.ext !== 'dwg' && !(it.size > 300 * 1048576)) {
      const box = h('div', { class: 'pv-3d' }, h('div', { class: 'pv-3d-hint' }, 'Loading 3D model…'));
      stage.append(box);
      render3D(box, it.path, () => my === seq).catch((e) => { box.innerHTML = `<div class="pv-3d-hint">${e.code === 'NO_CAD' ? 'Open it in Dogfile 3D to see CAD parts' : `Can't show this model: ${esc(e.message)}`}</div>`; });
      if (!large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => A.openAllIn('model', [it.path]) }, 'Open in Dogfile 3D')));
    } else if (KINDS.font.includes(it.ext) && it.ext !== 'fon') {
      const fam = 'pv' + Math.random().toString(36).slice(2);
      const ff = new FontFace(fam, `url("${url}")`);
      await ff.load(); document.fonts.add(ff);
      stage.append(h('div', { class: 'pv-font', style: { fontFamily: fam } }, h('div', { style: { fontSize: '44px' } }, 'Aa Bb Cc'), h('div', { style: { fontSize: '20px' } }, 'The quick brown fox jumps over the lazy dog'), h('div', { style: { fontSize: '15px' } }, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%&*()')));
    } else if (KINDS.archive.includes(it.ext)) {
      const list = await api('archive:list', it.path).catch((e) => ({ error: e.message }));
      if (my !== seq) return;
      if (list.error) { stage.append(h('div', { class: 'hint' }, list.error)); return; }
      const total = list.reduce((a, e) => a + (e.size || 0), 0);
      addMeta([...baseRows(), ['Entries', list.length.toLocaleString()], ['Uncompressed', fmtSize(total)], ['Ratio', total ? `${Math.round((1 - it.size / total) * 100)}%` : '-']]);
      const box2 = h('div', { class: 'pv-list' });
      for (const e of list.slice(0, 400)) box2.append(h('div', { class: 'pv-li' }, h('span', { html: icon(e.isDir ? 'folder' : 'page') }), h('span', { class: 'grow' }, e.path), h('span', { class: 'hint' }, e.isDir ? '' : fmtSize(e.size))));
      stage.append(box2);
    } else if (TEXT_EXT.has(it.ext) || !it.ext || it.size < 2 * 1024 * 1024) {
      const r = await api('fs:readText', it.path, large ? 2 * 1024 * 1024 : 256 * 1024);
      if (my !== seq) return;
      if (r.binary) return hexView(stage, it);
      if (it.ext === 'md' || it.ext === 'markdown') stage.append(h('div', { class: 'pv-md', html: markdown(r.text) }));
      else if (it.ext === 'csv' || it.ext === 'tsv') stage.append(csvTable(r.text, it.ext === 'tsv' ? '\t' : null));
      else if (it.ext === 'json') { let t = r.text; try { t = JSON.stringify(JSON.parse(r.text), null, 2); } catch {} stage.append(await codeViewHL(t, it.name)); }
      else stage.append(await codeViewHL(r.text, it.name));
      if (my !== seq) return;
      const editBtn = () => { if (!large) meta.append(h('div', { class: 'pv-actions' }, h('button', { class: 'btn small', onclick: () => openTool('editor', [it.path]) }, 'Edit in Dogfile Notepad'))); };
      const lines = (r.text.match(/\n/g) || []).length + 1;
      addMeta([...baseRows(), ['Lines', lines.toLocaleString() + (r.truncated ? '+' : '')], ['Encoding', r.text.charCodeAt(0) === 0xfeff ? 'UTF-8 BOM' : 'UTF-8']]);
      if (r.truncated) stage.append(h('div', { class: 'hint center' }, 'Preview truncated'));
      editBtn();
    } else await thumbOrArt(stage, it);
  } catch (e) { stage.innerHTML = ''; stage.append(h('div', { class: 'hint' }, `Can't preview: ${e.message}`)); }
}

async function thumbOrArt(stage, it) {
  const t = DECODED_IMG.has(it.ext) ? decodedUrl(it.path, 800) : await api('thumb:get', it.path, 512);
  stage.innerHTML = '';
  if (t) stage.append(h('img', { class: 'pv-img', src: t }));
  else if (it.size > 0 && it.size < 64 * 1024 * 1024) return hexView(stage, it);
  else stage.append(h('div', { class: 'pv-art', html: fileArt(it.ext) }));
}

async function hexView(stage, it) {
  const bytes = await api('fs:readBytes', it.path, 2048);
  const lines = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const row = bytes.slice(o, o + 16);
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asc = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`<span class="hx-o">${o.toString(16).padStart(8, '0')}</span>  ${esc(hex)}  <span class="hx-a">${esc(asc)}</span>`);
  }
  stage.innerHTML = '';
  stage.append(h('div', { class: 'pv-art small', html: fileArt(it.ext) }), h('pre', { class: 'pv-hex', html: lines.join('\n') }));
}

function fmtDur(s) { if (!isFinite(s)) return '-'; s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); }

// syntax-highlighted, read-only code preview (CodeMirror, loaded on demand)
let CMmod = null, hlMod = null;
async function codeViewHL(text, name) {
  if (text.length > 600000) return codeView(text);
  try {
    CMmod = CMmod || (await import('../vendor/cm.js'));
    hlMod = hlMod || (await import('./cmtheme.js'));
    const C = CMmod, L = C.langForName(name);
    const box = h('div', { class: 'pv-cm' });
    new C.EditorView({ parent: box, state: C.EditorState.create({ doc: text, extensions: [C.lineNumbers(), C.foldGutter(), C.EditorState.readOnly.of(true), C.EditorView.editable.of(false), C.syntaxHighlighting(hlMod.hlStyle), C.highlightSpecialChars(), L.load ? L.load() : [], C.EditorView.lineWrapping] }) });
    return box;
  } catch (e) { console.warn(e); return codeView(text); }
}

// audio waveform (decoded with WebAudio) with click-to-seek and a moving playhead
async function waveform(canvas, audio, url, it, onInfo) {
  if (it.size > 80 * 1024 * 1024) { canvas.remove(); return; }
  let buf;
  try { const ab = await (await fetch(url)).arrayBuffer(); const ctx = new OfflineAudioContext(1, 1, 44100); buf = await ctx.decodeAudioData(ab); } catch { canvas.remove(); return; }
  if (!canvas.isConnected) return;
  const W = (canvas.width = Math.round((canvas.clientWidth || 300) * devicePixelRatio)), H = (canvas.height = Math.round((canvas.clientHeight || 90) * devicePixelRatio));
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  const peaks = new Float32Array(W);
  let peak = 0;
  for (let x = 0; x < W; x++) { let m = 0; const s0 = x * step; for (let i = 0; i < step; i += 4) { const v = Math.abs(data[s0 + i] || 0); if (v > m) m = v; } peaks[x] = m; if (m > peak) peak = m; }
  onInfo?.({ duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, peakDb: 20 * Math.log10(peak || 1e-9) });
  const g = canvas.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#3b82f6', dim = cs.getPropertyValue('--text-4').trim() || '#bbb';
  const bar = Math.max(1, Math.round(1.5 * devicePixelRatio));
  const draw = () => {
    if (!canvas.isConnected) return;
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    g.clearRect(0, 0, W, H);
    for (let x = 0; x < W; x += bar * 2) { const hh = Math.max(bar, (peaks[x] / (peak || 1)) * H * 0.92); g.fillStyle = x / W <= p ? accent : dim; g.fillRect(x, (H - hh) / 2, bar, hh); }
    if (!audio.paused) requestAnimationFrame(draw);
  };
  draw();
  audio.addEventListener('play', draw); audio.addEventListener('seeked', draw); audio.addEventListener('timeupdate', draw);
  canvas.addEventListener('click', (e) => { const r = canvas.getBoundingClientRect(); if (audio.duration) { audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; draw(); } });
}

// dominant colors of an image
function palette(img) {
  try {
    const c = document.createElement('canvas'); const S = 64; c.width = S; c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 128) continue; const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); const b = buckets.get(k) || [0, 0, 0, 0]; b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++; buckets.set(k, b); }
    const sorted = [...buckets.values()].sort((a, b) => b[3] - a[3]).map((b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3]]);
    const out = [];
    for (const c2 of sorted) { if (out.every((o) => Math.hypot(o[0] - c2[0], o[1] - c2[1], o[2] - c2[2]) > 48)) out.push(c2); if (out.length >= 6) break; }
    return out.map((c2) => '#' + c2.map((x) => Math.round(x).toString(16).padStart(2, '0')).join(''));
  } catch { return []; }
}

function codeView(text) {
  const lines = text.split(/\r?\n/).slice(0, 6000);
  const pre = h('div', { class: 'pv-code' });
  pre.innerHTML = `<div class="ln">${lines.map((_, i) => i + 1).join('\n')}</div><pre>${esc(lines.join('\n'))}</pre>`;
  return pre;
}

function csvTable(text, delim) {
  const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 300);
  if (!delim) delim = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';' : ',';
  const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === delim) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
  const t = h('table', { class: 'pv-table' });
  t.innerHTML = rows.map((r, i) => `<tr>${parse(r).map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
  return h('div', { class: 'pv-tablewrap' }, t);
}


// ---------------- Preview pane wiring ----------------
let pane;
export function initPreview(el) {
  pane = el;
  const update = () => {
    if (!state.settings.showPreview) return;
    const t = activeTab();
    const sel = t ? selectedItems(t) : [];
    const it = sel.length === 1 ? sel[0] : t?.focus ? t.shown[t.indexOf.get(t.focus)] : null;
    const key = it ? it.path + '|' + it.mtime : '';
    if (key === pane._key) return;
    pane._key = key;
    if (sel.length > 1) { pane.innerHTML = ''; const total = sel.reduce((a, i) => a + (i.size || 0), 0); pane.append(h('div', { class: 'pv-empty' }, h('div', { html: icon('selectAll') }), h('div', {}, `${sel.length} items selected`), h('div', { class: 'hint' }, fmtSize(total)))); return; }
    renderPreview(pane, it);
  };
  const deb = debounceFrame(update);
  bus.on('selection', deb); bus.on('activePane', deb); bus.on('loaded', deb);
  bus.on('preview', () => { pane._key = null; update(); });
  bus.on('renderMiniPreview', ({ el, item }) => renderPreview(el, item));
  // resizer
  const rz = document.getElementById('preview-resizer');
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const W = window.innerWidth;
    const move = (ev) => { state.settings.previewWidth = Math.max(220, Math.min(900, W - ev.clientX)); document.documentElement.style.setProperty('--pv-w', state.settings.previewWidth + 'px'); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); import('./core.js').then((c) => c.saveSettings()); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}
function debounceFrame(fn) { let r = null, tm = null; return () => { cancelAnimationFrame(r); clearTimeout(tm); tm = setTimeout(() => (r = requestAnimationFrame(fn)), 60); }; }

// ---------------- Quick Look ----------------
let ql = null;
export function quickLook() {
  if (ql) return closeQuickLook();
  const t = activeTab();
  if (!t) return;
  const it = t.focus ? t.shown[t.indexOf.get(t.focus)] : selectedItems(t)[0];
  if (!it) return;
  const back = h('div', { class: 'ql-back' });
  const box = h('div', { class: 'ql' });
  const head = h('div', { class: 'ql-head' });
  const body = h('div', { class: 'ql-body' });
  box.append(head, body);
  back.append(box);
  document.body.append(back);
  let cur = it;
  const show = (x) => {
    cur = x;
    head.innerHTML = '';
    head.append(h('div', { class: 'ql-title' }, x.name, h('span', { class: 'hint' }, `  ${x.isDir ? '' : fmtSize(x.size)}  ${fmtDate(x.mtime)}`)),
      h('button', { class: 'btn small', onclick: () => { closeQuickLook(); A.openItems([x]); } }, 'Open'),
      h('button', { class: 'icon-btn', html: icon('close'), onclick: closeQuickLook }));
    renderPreview(body, x, { large: true });
  };
  show(it);
  const key = (e) => {
    if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); closeQuickLook(); return; }
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const i = t.indexOf.get(cur.path) ?? 0;
      const n = t.shown[i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1)];
      if (n) { selectOnly(t, n.path); renderTabPanes(t, true); bus.emit('selection', t); show(n); }
    }
    if (e.key === 'Enter') { e.preventDefault(); closeQuickLook(); A.openItems([cur]); }
  };
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeQuickLook(); });
  window.addEventListener('keydown', key, true);
  ql = { back, key };
}
export function closeQuickLook() {
  if (!ql) return;
  window.removeEventListener('keydown', ql.key, true);
  ql.back.querySelectorAll('video,audio').forEach((m) => m.pause());
  ql.back.remove();
  ql = null;
  const el = paneEls[state.activePane]; el?.body.focus();
}
export const quickLookOpen = () => !!ql;

// ---------- 3D models: everything Dogfile 3D opens (CAD once its reader is installed); drag to rotate, wheel to zoom ----------
async function render3D(box, path, alive) {
  const { three, loadModel } = await import('./model-load.js');
  const T = await three();
  if (!alive()) return;
  const r = await loadModel(path, { maxTex: 1024, quality: 'low' });
  if (!alive()) return;
  const W = Math.max(200, box.clientWidth || 300), H = Math.max(180, box.clientHeight || 260);
  const renderer = new T.WebGLRenderer({ antialias: (devicePixelRatio || 1) < 1.5, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); renderer.setSize(W, H);
  renderer.toneMapping = T.NeutralToneMapping;
  const scene = new T.Scene();
  const cam = new T.PerspectiveCamera(40, W / H, 0.01, 10000);
  scene.add(new T.HemisphereLight(0xffffff, 0x666677, 2.2));
  const dl = new T.DirectionalLight(0xffffff, 1.6); dl.position.set(3, 5, 4); scene.add(dl);
  const obj = new T.Group(); obj.add(r.object);
  if (r.zUp && !r.flat) r.object.rotation.x = -Math.PI / 2;
  obj.traverse((m) => { if (m.isSkinnedMesh) m.frustumCulled = false; if (m.isMesh && !m.material) m.material = new T.MeshStandardMaterial({ color: 0xb8bcc6 }); });
  scene.add(obj);
  const bb = new T.Box3().setFromObject(obj), size = bb.getSize(new T.Vector3()), center = bb.getCenter(new T.Vector3());
  obj.position.sub(center);
  const rad = Math.max(size.length() / 2, 1e-6);
  const dist = rad / Math.sin((cam.fov * Math.PI) / 360);
  if (r.flat) cam.position.set(0, 0, dist); else cam.position.copy(new T.Vector3(1, 0.75, 1.3).normalize().multiplyScalar(dist));
  cam.near = dist / 1000; cam.far = dist * 50; cam.updateProjectionMatrix();
  const ctl = new T.OrbitControls(cam, renderer.domElement); ctl.enableDamping = true; ctl.autoRotate = !r.flat; ctl.autoRotateSpeed = 1.2;
  renderer.domElement.addEventListener('pointerdown', () => (ctl.autoRotate = false));
  // the first animation plays
  const mixer = r.animations.length ? new T.AnimationMixer(r.object) : null;
  if (mixer) mixer.clipAction(r.animations[0]).play();
  box.innerHTML = ''; box.append(renderer.domElement);
  const ro = new ResizeObserver(() => { const w = box.clientWidth, hh = box.clientHeight; if (w && hh) { renderer.setSize(w, hh); cam.aspect = w / hh; cam.updateProjectionMatrix(); } });
  ro.observe(box);
  let last = performance.now();
  const loop = (now) => {
    if (!box.isConnected || !alive()) { ro.disconnect(); mixer?.stopAllAction(); obj.traverse((o) => { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap']) m[k]?.dispose?.(); m.dispose?.(); } }); renderer.dispose(); renderer.forceContextLoss(); return; }
    const dt = Math.min(0.1, ((now || last) - last) / 1000); last = now || last;
    mixer?.update(dt);
    ctl.update(); renderer.render(scene, cam); requestAnimationFrame(loop);
  };
  loop();
}
