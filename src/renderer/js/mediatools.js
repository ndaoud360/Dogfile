// Media helpers for the main window: batch audio/video conversion (ffmpeg), BPM/key results,
// image format conversion and desktop background.
import { api, h, esc, toast, basename, dirname, stem, bus, IS_WIN, fileUrl } from './core.js';
import { modal } from './dialogs.js';
import { analyzeAudio, fmtAnalysis } from './audio-analysis.js';

function progressToast(title) {
  const host = document.getElementById('toasts');
  const fill = h('div', { class: 'tp-fill' });
  const txt = h('span', {}, title);
  const el = h('div', { class: 'toast show tprog' }, txt, h('div', { class: 'tp-bar' }, fill));
  host.append(el);
  return { set: (pct, t) => { fill.style.width = pct + '%'; if (t) txt.textContent = t; }, done: () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); } };
}
async function waitJob(id, onPct) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 350));
    const s = await api('media:job', id);
    if (!s) return { error: 'Lost track of the job' };
    onPct?.(s.pct);
    if (s.done) return s;
  }
}

// convert audio / video files with ffmpeg; copies are written next to the originals
export async function convertMedia(paths, format, { normalize = false, audioOnly = false } = {}) {
  if (!paths.length) return;
  const p = progressToast(`Converting ${paths.length === 1 ? basename(paths[0]) : paths.length + ' files'}…`);
  let ok = 0;
  const made = [];
  for (let i = 0; i < paths.length; i++) {
    const src = paths[i];
    const info = await api('media:probe', src).catch(() => null);
    const hasVideo = !!info?.streams?.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const duration = parseFloat(info?.format?.duration) || 0;
    const ext = format;
    const suffix = normalize ? ' (normalized)' : '';
    const out = await api('fs:uniqueName', dirname(src), `${stem(basename(src)) || basename(src)}${suffix}.${ext}`, 'number');
    const spec = { src, out, duration, hasVideo, audioOnly: audioOnly || ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'].includes(ext), normalize, mode: 'fast', convert: true, copyOk: ['mp4', 'mkv', 'mov'].includes(ext) };
    const prog = (pct) => p.set(((i + pct / 100) / paths.length) * 100, `Converting ${basename(src)} (${i + 1}/${paths.length})…`);
    let st = await waitJob(await api('media:export', spec), prog);
    // stream copy can fail when the codecs don't fit the new container: re-encode instead
    if (st.error && spec.copyOk && st.error !== 'Cancelled') st = await waitJob(await api('media:export', { ...spec, copyOk: false, mode: 'precise' }), prog);
    if (st.error) toast(`${basename(src)}: ${st.error}`, { error: true }); else { ok++; made.push(out); }
  }
  p.done();
  if (ok) toast(`Converted ${ok} file${ok > 1 ? 's' : ''} to ${format.toUpperCase()}`);
  bus.emit('refreshPanes');
  return made;
}

// BPM / key for a set of audio files, shown as a table that fills in as results arrive
export async function analyzeDialog(paths) {
  const rows = paths.map((p) => {
    const bpm = h('td', { class: 'num' }, h('span', { class: 'mini-spin' })), key = h('td', {}, ''), cam = h('td', {}, ''), loud = h('td', { class: 'dim' }, '');
    return { p, tr: h('tr', {}, h('td', { class: 'nm', title: p }, basename(p)), bpm, key, cam, loud), bpm, key, cam, loud };
  });
  const table = h('table', { class: 'an-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'BPM'), h('th', {}, 'Key'), h('th', {}, 'Camelot'), h('th', {}, 'Loudness'))), h('tbody', {}, ...rows.map((r) => r.tr)));
  const results = [];
  const copyBtn = { label: 'Copy as text', run: () => { api('clip:writeText', results.map((r) => `${basename(r.p)}\t${r.a ? fmtAnalysis(r.a) : ''}`).join('\r\n')); toast('Copied'); return false; } };
  modal({ title: 'BPM & key', width: 720, body: h('div', { class: 'an-wrap' }, table, h('div', { class: 'hint' }, 'Tempo and key are estimated from the audio. Camelot codes help with harmonic mixing: neighbours (8A, 9A, 8B) mix well.')), buttons: [copyBtn, { label: 'Close', primary: true, value: true }] });
  for (const r of rows) {
    try {
      const a = await analyzeAudio(r.p);
      results.push({ p: r.p, a });
      r.bpm.textContent = a.bpm ? String(Math.round(a.bpm)) : '?';
      r.key.textContent = a.keyLabel || '?'; r.cam.textContent = a.camelot || '';
      r.loud.textContent = a.rmsDb != null ? `${a.rmsDb} dB` : '';
    } catch (e) { r.bpm.textContent = ''; r.key.textContent = e.message; r.key.className = 'dim'; }
  }
}

// image conversion via canvas (JPEG / PNG / WebP), copies next to the originals
export async function convertImages(paths, format, { maxSide = 0 } = {}) {
  const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format];
  let ok = 0;
  for (const p of paths) {
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('Can’t decode')); im.src = /\.(jpe?g|png|gif|webp|bmp|ico|svg|avif|jfif)$/i.test(p) ? fileUrl(p) : `atlas://media/still?p=${encodeURIComponent(p)}`; });
      let w = img.naturalWidth, hh = img.naturalHeight;
      if (maxSide && Math.max(w, hh) > maxSide) { const k = maxSide / Math.max(w, hh); w = Math.round(w * k); hh = Math.round(hh * k); }
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      const g = c.getContext('2d');
      if (format === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
      g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, hh);
      const out = await api('fs:uniqueName', dirname(p), `${stem(basename(p))}${maxSide ? ` (${maxSide}px)` : ''}.${format}`, 'number');
      await api('fs:writeDataUrl', out, c.toDataURL(mime, 0.92));
      ok++;
    } catch (e) { toast(`${basename(p)}: ${e.message}`, { error: true }); }
  }
  if (ok) toast(`Saved ${ok} image${ok > 1 ? 's' : ''} as ${format.toUpperCase()}`);
  bus.emit('refreshPanes');
}

export async function setWallpaper(p) {
  if (!IS_WIN()) return toast('Setting the desktop background works on Windows');
  try { await api('shell:wallpaper', p); toast('Desktop background set'); } catch (e) { toast(e.message, { error: true }); }
}

bus.on('analyzeAudio', (paths) => analyzeDialog(paths));
