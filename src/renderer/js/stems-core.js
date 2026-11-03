// Stem separation, the parts that are plain maths (no window, no model): how a song is cut into pieces for the model,
// how the pieces are joined again, and the WAV and ZIP files the stems are saved in. stems.js is the window,
// stems-worker.js runs the model. The model is HT-Demucs (6 sources), which takes 7.8 seconds of 44.1 kHz stereo at a time.
export const SAMPLE_RATE = 44100;
export const SEG = 343980; // samples per piece the model takes
export const OVERLAP = 0.25;
/** the order the model returns its sources in */
export const MODEL_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
/** the order they are shown in */
export const STEMS = [
  { key: 'vocals', label: 'Vocals' },
  { key: 'drums', label: 'Drums' },
  { key: 'bass', label: 'Bass' },
  { key: 'guitar', label: 'Guitar' },
  { key: 'piano', label: 'Piano' },
  { key: 'other', label: 'Other' },
];
/** the longest song handled: the stems take about 190 MB of memory per minute */
export const MAX_SECONDS = 600;

/** where each piece starts. Pieces overlap, and the last one is padded with silence */
export function segmentStarts(length, seg = SEG, overlap = OVERLAP) {
  const stride = Math.max(1, Math.floor(seg * (1 - overlap)));
  const starts = [0];
  while (starts[starts.length - 1] + seg < length) starts.push(starts[starts.length - 1] + stride);
  return starts;
}

/** each piece fades in and out (a triangle), so the joins between pieces can't be heard */
export function windowWeights(seg = SEG) {
  const w = new Float32Array(seg), half = seg >> 1;
  for (let i = 0; i < seg; i++) w[i] = i < half ? i + 1 : seg - i;
  const max = half;
  for (let i = 0; i < seg; i++) w[i] /= max;
  return w;
}

/** whatever the file decoded to (mono, stereo, surround) as left and right */
export function toStereo(channels) {
  if (!channels?.length) throw new Error('No audio in this file');
  return [channels[0], channels[1] || channels[0]];
}

/** the model expects a song of ordinary loudness: its mean is removed and its level scaled, and the level put back afterwards
 * (the mean is not: it is a constant offset nobody hears, and it would otherwise sit in every stem) */
export function levelOf(left, right) {
  const n = left.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (left[i] + right[i]) / 2;
  const mean = n ? sum / n : 0;
  let sq = 0;
  for (let i = 0; i < n; i++) { const d = (left[i] + right[i]) / 2 - mean; sq += d * d; }
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  return { mean, std: std > 1e-8 ? std : 1 };
}

/**
 * Splits a song into its sources. runChunk(Float32Array of 2 × SEG, left channel then right) answers with
 * 6 × 2 × SEG numbers (the model's sources in MODEL_ORDER, each left then right). Returns { drums: [left, right], … }.
 */
export async function separate(left, right, runChunk, { onProgress, cancelled, seg = SEG, overlap = OVERLAP } = {}) {
  const L = left.length;
  const { mean, std } = levelOf(left, right);
  const starts = segmentStarts(L, seg, overlap);
  const w = windowWeights(seg);
  const out = MODEL_ORDER.map(() => [new Float32Array(L), new Float32Array(L)]);
  const acc = new Float32Array(L);
  for (let k = 0; k < starts.length; k++) {
    if (cancelled?.()) throw new Error('Stopped');
    const s = starts[k], n = Math.min(seg, L - s);
    const chunk = new Float32Array(2 * seg);
    for (let i = 0; i < n; i++) { chunk[i] = (left[s + i] - mean) / std; chunk[seg + i] = (right[s + i] - mean) / std; }
    const res = await runChunk(chunk);
    if (!res || res.length < MODEL_ORDER.length * 2 * seg) throw new Error('The model gave an unexpected answer');
    for (let i = 0; i < n; i++) acc[s + i] += w[i];
    for (let m = 0; m < MODEL_ORDER.length; m++) {
      for (let c = 0; c < 2; c++) {
        const o = out[m][c], base = (m * 2 + c) * seg;
        for (let i = 0; i < n; i++) o[s + i] += res[base + i] * w[i];
      }
    }
    onProgress?.(k + 1, starts.length);
  }
  const result = {};
  MODEL_ORDER.forEach((key, m) => {
    for (let c = 0; c < 2; c++) { const o = out[m][c]; for (let i = 0; i < L; i++) o[i] = (o[i] / acc[i]) * std; }
    result[key] = out[m];
  });
  return result;
}

/** the stems added up at the volumes given (1 = as separated) */
export function mixdown(stems, gains, length) {
  const l = new Float32Array(length), r = new Float32Array(length);
  for (const [key, ch] of Object.entries(stems)) {
    const g = gains[key] ?? 1;
    if (!g) continue;
    for (let i = 0; i < length; i++) { l[i] += ch[0][i] * g; r[i] += ch[1][i] * g; }
  }
  return [l, r];
}

// ---------- files ----------
/** a 16-bit stereo WAV file */
export function encodeWav(left, right, rate = SAMPLE_RATE) {
  const n = left.length, bytes = n * 4;
  const out = new Uint8Array(44 + bytes), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, bytes, true);
  const pcm = (x) => { const v = Math.max(-1, Math.min(1, x)); return Math.round(v < 0 ? v * 32768 : v * 32767); };
  for (let i = 0, o = 44; i < n; i++, o += 4) { dv.setInt16(o, pcm(left[i]), true); dv.setInt16(o + 2, pcm(right[i]), true); }
  return out;
}

let crcTable = null;
export function crc32(data, crc = 0) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** a ZIP file (stored, not compressed: audio hardly shrinks) as a list of pieces to write one after another */
export function zipParts(entries, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('Too big for a ZIP file');
    const nm = enc.encode(name), crc = crc32(data);
    const head = new Uint8Array(30 + nm.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, day, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    head.set(nm, 30);
    const cen = new Uint8Array(46 + nm.length), c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, day, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, offset, true); cen.set(nm, 46);
    central.push(cen);
    parts.push(head, data);
    offset += head.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

/** characters a Windows file name can't have */
export const safeName = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Song';
