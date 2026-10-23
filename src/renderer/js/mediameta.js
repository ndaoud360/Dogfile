// Media details for gallery mode and media filters: picture size / date taken / camera (from file headers),
// video & song length, dominant colour and a tiny perceptual hash (from thumbnails), BPM / key (from audio
// analysis). Cached on disk so a library is only read once.
import { api, state, bus, KINDS, debounce, IS_WIN, sys } from './core.js';

const meta = new Map(); // key -> {...}
let loaded = false;
const keyOf = (it) => `${it.path}|${it.size || 0}|${Math.round(it.mtime || 0)}`;
const save = debounce(() => {
  const obj = {};
  let n = 0;
  for (const [k, v] of meta) { obj[k] = v; if (++n > 60000) break; }
  api('store:set', 'mediameta', obj);
}, 4000);
async function load() {
  if (loaded) return;
  loaded = true;
  const o = await api('store:get', 'mediameta').catch(() => null);
  if (o) for (const [k, v] of Object.entries(o)) meta.set(k, v);
}
export const isPic = (it) => !it.isDir && KINDS.image.includes(it.ext);
export const isVid = (it) => !it.isDir && (KINDS.video.includes(it.ext) || ['mkv', 'm2ts', 'mts', 'ts', 'vob'].includes(it.ext));
export const isAud = (it) => !it.isDir && KINDS.audio.includes(it.ext);
export const metaOf = (it) => meta.get(keyOf(it)) || null;
export function setMeta(it, patch) { const k = keyOf(it); meta.set(k, { ...(meta.get(k) || {}), ...patch }); save(); }

// ask for whatever is missing, a batch at a time; calls onUpdate when something new arrived
const inflight = new Set();
export async function ensureMeta(items, { onUpdate, audio = true, need = [] } = {}) {
  await load();
  const pics = [], av = [];
  for (const it of items) {
    if (it.isDir || it.virtual || it.archive || it.mtp) continue;
    const k = keyOf(it);
    if (inflight.has(k)) continue;
    const m = meta.get(k);
    // "need": details added later (GPS, codecs) are read again for entries cached before them
    if (isPic(it) && !(m && 'w' in m && need.every((k) => k !== 'gps' || 'gps' in m))) pics.push(it);
    else if ((isVid(it) || (audio && isAud(it))) && !(m && 'dur' in m && need.every((k) => k !== 'vcodec' || 'vcodec' in m))) av.push(it);
  }
  let changed = false;
  // demo mode: the demo songs and videos are empty, so they get believable details instead of being read
  if (sys.demo && sys.demoRoot) {
    const fake = av.filter((it) => it.path.startsWith(sys.demoRoot));
    for (const it of fake) {
      let hsh = 0; for (const ch of it.name) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      if (isAud(it)) { const keys = [['8A', 'A minor'], ['8B', 'C major'], ['9A', 'E minor'], ['5A', 'C minor'], ['11B', 'A major'], ['4A', 'F minor']]; const k = keys[hsh % keys.length]; setMeta(it, { dur: 150 + (hsh % 180), bpm: 82 + (hsh % 70), camelot: k[0], key: k[1], w: 0, h: 0, vcodec: '', acodec: 'mp3' }); }
      else setMeta(it, { dur: 20 + (hsh % 1500), w: hsh % 3 ? 1920 : 3840, h: hsh % 3 ? 1080 : 2160, vcodec: 'h264', acodec: 'aac' });
    }
    if (fake.length) { av.splice(0, av.length, ...av.filter((it) => !fake.includes(it))); changed = true; }
  }
  for (let i = 0; i < pics.length; i += 200) {
    const part = pics.slice(i, i + 200);
    part.forEach((it) => inflight.add(keyOf(it)));
    const r = await api('media:imgMeta', part.map((x) => x.path)).catch(() => []);
    part.forEach((it, j) => { inflight.delete(keyOf(it)); setMeta(it, { w: 0, h: 0, ...(r[j] || {}) }); });
    changed = true;
    onUpdate?.();
  }
  for (let i = 0; i < av.length; i += 16) {
    const part = av.slice(i, i + 16);
    part.forEach((it) => inflight.add(keyOf(it)));
    const r = await api('media:quickProbe', part.map((x) => x.path)).catch(() => []);
    part.forEach((it, j) => { inflight.delete(keyOf(it)); const x = r[j] || {}; const rot = x.rot === 90 || x.rot === 270; setMeta(it, { dur: x.dur || 0, w: rot ? x.h : x.w, h: rot ? x.w : x.h, vcodec: x.vcodec || '', acodec: x.acodec || '' }); });
    changed = true;
    if (i % 64 === 0) onUpdate?.();
  }
  if (changed) onUpdate?.();
  // BPM / key from the audio analysis cache
  if (audio && items.some(isAud)) {
    const { cachedAll } = await import('./audio-analysis.js');
    const c = await cachedAll();
    let n = 0;
    for (const it of items) if (isAud(it) && c[it.path]) { const a = c[it.path]; const m = metaOf(it) || {}; if (m.bpm !== a.bpm || m.camelot !== a.camelot) { setMeta(it, { bpm: a.bpm, key: a.keyLabel, camelot: a.camelot }); n++; } }
    if (n) onUpdate?.();
  }
}

// ---------------- colours ----------------
// named colour families for "filter by colour"
export const COLORS = [
  ['red', '#e5484d'], ['orange', '#f76b15'], ['yellow', '#ffc53d'], ['green', '#30a46c'], ['teal', '#12a594'], ['blue', '#0090ff'],
  ['purple', '#8e4ec6'], ['pink', '#d6409f'], ['brown', '#8d5b3a'], ['black', '#1c1c1f'], ['gray', '#8b8d98'], ['white', '#f4f4f5'],
];
export function colorFamily([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510, d = mx - mn;
  const s = d === 0 ? 0 : d / (255 - Math.abs(mx + mn - 255));
  if (l < 0.16) return 'black';
  if (l > 0.88 && s < 0.35) return 'white';
  if (s < 0.16) return 'gray';
  let hue = 0;
  if (mx === r) hue = ((g - b) / d) % 6; else if (mx === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if ((hue < 40 || hue > 330) && l < 0.42 && s < 0.7 && hue < 40) return 'brown';
  if (hue < 14 || hue >= 345) return 'red';
  if (hue < 40) return 'orange';
  if (hue < 66) return 'yellow';
  if (hue < 160) return 'green';
  if (hue < 190) return 'teal';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return 'pink';
}
const cv = document.createElement('canvas'); cv.width = 16; cv.height = 16;
const cx = cv.getContext('2d', { willReadFrequently: true });
// dominant colour (most common saturated-ish family, weighted) + 64-bit dHash, from a loaded <img>
export function analyzeImage(img, it) {
  try {
    if (!img.naturalWidth) return null;
    cx.clearRect(0, 0, 16, 16);
    cx.drawImage(img, 0, 0, 16, 16);
    const d = cx.getImageData(0, 0, 16, 16).data;
    const fam = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const f = colorFamily([d[i], d[i + 1], d[i + 2]]);
      const w = ['gray', 'black', 'white'].includes(f) ? 0.55 : 1;
      fam.set(f, (fam.get(f) || 0) + w);
    }
    const sorted = [...fam.entries()].sort((a, b) => b[1] - a[1]);
    // small dHash from a 9x8 sample
    cx.drawImage(img, 0, 0, 9, 8);
    const s = cx.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = (y * 9 + x) * 4, q = p + 4; bits += s[p] + s[p + 1] + s[p + 2] > s[q] + s[q + 1] + s[q + 2] ? '1' : '0'; }
    const hash = BigInt('0b' + bits).toString(16).padStart(16, '0');
    const patch = { color: sorted[0]?.[0] || 'gray', colors: sorted.slice(0, 3).filter(([, n]) => n > 20).map(([f]) => f), hash };
    if (it) { const m = metaOf(it); if (!m || m.hash !== hash || !m.colors) setMeta(it, patch); }
    return patch;
  } catch { return null; }
}
export function hashDistance(a, b) {
  if (!a || !b) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// ---------------- auto groups ----------------
const SCREEN_SIZES = new Set(['1920x1080', '2560x1440', '3840x2160', '1366x768', '1440x900', '1536x864', '1280x720', '2880x1800', '1680x1050', '1280x800', '2560x1600', '3440x1440', '1170x2532', '1080x2400', '1080x1920', '1284x2778', '1179x2556', '1290x2796', '1242x2688', '828x1792', '750x1334', '1440x3200', '1080x2340']);
export function galleryKind(it) {
  if (isVid(it)) return 'Videos';
  if (!isPic(it)) return 'Other files';
  const m = metaOf(it) || {};
  const n = it.name.toLowerCase();
  if (/screenshot|screen shot|screen_shot|capture|snip|scrnli|^sc_?\d|^ss_/.test(n)) return 'Screenshots';
  if (m.camera || /^(img|dsc|dscn|dscf|pxl|p\d{7}|gopr|dji|mvimg|photo)[-_ ]?\d/.test(n)) return 'Camera photos';
  if (['psd', 'ai', 'svg', 'xcf', 'kra', 'procreate', 'clip'].includes(it.ext) || /adobe|photoshop|illustrator|krita|gimp|procreate|clip studio|affinity|canva|figma/i.test(m.software || '')) return 'Artwork & graphics';
  if (it.ext === 'png' && SCREEN_SIZES.has(`${m.w}x${m.h}`)) return 'Screenshots';
  if (it.ext === 'png' || it.ext === 'gif' || it.ext === 'webp') return 'Artwork & graphics';
  return 'Other pictures';
}
export const fmtDur = (s) => { if (!s) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
export function takenOf(it) { const m = metaOf(it); return m?.taken || it.mtime || 0; }
export function aspectOf(it) {
  const m = metaOf(it);
  if (m && m.w > 0 && m.h > 0) return Math.max(0.25, Math.min(4, m.w / m.h));
  if (it._aspect) return it._aspect;
  return isVid(it) ? 16 / 9 : isAud(it) ? 2.2 : 4 / 3;
}

// ---------------- media filter ----------------
// t.mf = { kind: 'all'|'photos'|'videos'|'screenshots'|'artwork', color, similar: hash, minDur, maxDur, minBpm, maxBpm, key }
export function mediaFilterActive(t) { const f = t.mf; return !!f && !!(f.color || f.similar || (f.kind && f.kind !== 'all') || f.minDur || f.maxDur || f.minBpm || f.maxBpm || f.key); }
export function mediaFilterTest(t) {
  const f = t.mf;
  if (!mediaFilterActive(t)) return null;
  return (it) => {
    if (it.isDir) return !f.kind || f.kind === 'all';
    const m = metaOf(it) || {};
    if (f.kind && f.kind !== 'all') {
      const k = galleryKind(it);
      if (f.kind === 'photos' && !isPic(it)) return false;
      if (f.kind === 'videos' && !isVid(it)) return false;
      if (f.kind === 'music' && !isAud(it)) return false;
      if (f.kind === 'screenshots' && k !== 'Screenshots') return false;
      if (f.kind === 'camera' && k !== 'Camera photos') return false;
      if (f.kind === 'artwork' && k !== 'Artwork & graphics') return false;
    }
    if (f.color && !(m.colors || [m.color]).includes(f.color)) return false;
    if (f.similar && hashDistance(m.hash, f.similar) > 14) return false;
    if (f.minDur && !(m.dur >= f.minDur)) return false;
    if (f.maxDur && !(m.dur > 0 && m.dur <= f.maxDur)) return false;
    if (f.minBpm && !(m.bpm >= f.minBpm)) return false;
    if (f.maxBpm && !(m.bpm > 0 && m.bpm <= f.maxBpm)) return false;
    if (f.key && m.camelot !== f.key && !(f.keyCompat && compatibleKeys(f.key).includes(m.camelot))) return false;
    return true;
  };
}
// harmonic mixing: same key, ±1 on the wheel, relative major/minor
export function compatibleKeys(c) {
  const m = /^(\d+)([AB])$/.exec(c || '');
  if (!m) return [];
  const n = +m[1], l = m[2];
  const w = (x) => ((x + 11) % 12) + 1;
  return [`${n}${l}`, `${w(n + 1)}${l}`, `${w(n - 1)}${l}`, `${n}${l === 'A' ? 'B' : 'A'}`];
}
bus.on('mediaMetaChanged', () => {});
export { IS_WIN };
