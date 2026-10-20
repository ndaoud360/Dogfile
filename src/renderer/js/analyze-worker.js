// BPM + musical key detection on mono 22.05 kHz PCM.
// Tempo: spectral-flux onset envelope -> autocorrelation with a perceptual tempo prior.
// Key: averaged chroma vector correlated with the Krumhansl-Schmuckler major/minor profiles.
const SR = 22050;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
const hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; };

function tempo(x) {
  const N = 1024, H = 256, w = hann(N);
  const frames = Math.floor((x.length - N) / H);
  if (frames < 200) return null;
  const re = new Float64Array(N), im = new Float64Array(N);
  const bins = 400; // up to ~8.6 kHz
  let prev = new Float64Array(bins);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    const cur = new Float64Array(bins);
    for (let k = 1; k < bins; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); cur[k] = m; const d = m - prev[k]; if (d > 0) flux += d * (k < 12 ? 2 : 1); } // kick/bass region counts double
    env[f] = flux; prev = cur;
  }
  // remove the local mean so steady loudness does not dominate
  const fps = SR / H, win = Math.round(fps * 0.5);
  const hp = new Float64Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) { acc += env[i]; if (i >= win) acc -= env[i - win]; hp[i] = Math.max(0, env[i] - acc / Math.min(i + 1, win)); }
  const minLag = Math.floor((60 * fps) / 210), maxLag = Math.ceil((60 * fps) / 55);
  const top = Math.min(frames - 1, maxLag * 4 + 2);
  const ac = new Float64Array(top + 2);
  for (let lag = 1; lag <= top + 1 && lag < frames; lag++) { let s = 0; for (let i = lag; i < frames; i++) s += hp[i] * hp[i - lag]; ac[lag] = s / (frames - lag); }
  const at = (l) => { const i = Math.floor(l), f = l - i; return i + 1 < ac.length ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
  // a beat period repeats at 2x, 3x, 4x its length too (comb over the autocorrelation)
  const comb = (lag) => { let s = 0, n = 0; for (let k = 1; k <= 4; k++) { const l = lag * k; if (l + 1 >= ac.length) break; s += at(l) / k; n += 1 / k; } return n ? s / n : 0; };
  // 1. strongest periodicity on a fine grid of tempos
  let best = -1, bestBpm = 0;
  for (let bpm = 55; bpm <= 210; bpm += 0.25) { const v = comb((60 * fps) / bpm); if (v > best) { best = v; bestBpm = bpm; } }
  if (!bestBpm) return null;
  // 2. pick the octave (half / same / double) people tap along to: most music sits around 75-150 BPM, so only
  // go faster or slower than that when the rhythm clearly says so
  const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.55, 2));
  let pick = bestBpm, pickScore = -1;
  for (const m of [0.5, 2 / 3, 1, 1.5, 2]) {
    const bpm = bestBpm * m;
    if (bpm < 55 || bpm > 210) continue;
    const sc = comb((60 * fps) / bpm) * prior(bpm) * (m === 1 ? 1 : m === 0.5 || m === 2 ? 0.95 : 0.6);
    if (sc > pickScore) { pickScore = sc; pick = bpm; }
  }
  // 3. refine to 0.05 BPM
  let fine = pick, fineScore = -1;
  for (let bpm = pick - 1.5; bpm <= pick + 1.5; bpm += 0.05) { const v = comb((60 * fps) / bpm); if (v > fineScore) { fineScore = v; fine = bpm; } }
  let mean = 0, cnt = 0; for (let lag = minLag; lag <= maxLag; lag++) { mean += ac[lag]; cnt++; } mean /= cnt || 1;
  const r = Math.round(fine * 10) / 10;
  return { bpm: Math.abs(r - Math.round(r)) < 0.25 ? Math.round(r) : r, confidence: Math.min(1, fineScore / (mean * 2.5 || 1)) };
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Shaath profiles (as used by KeyFinder, popular in DJ software): better than Krumhansl on pop / electronic music
const MAJ = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const MIN = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];
const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
function corr(a, b) { const n = a.length; const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return num / Math.sqrt(da * db || 1); }
function key(x) {
  // HPCP-style chroma: spectral peaks only (no noise floor), tuning-corrected, and every peak also votes for the
  // notes it could be an overtone of. Without that, the 3rd harmonic of each note boosts its fifth and the key
  // comes out a fifth too high (G minor read as D minor).
  const N = 8192, H = 4096, w = hann(N);
  const frames = Math.floor((x.length - N) / H);
  if (frames < 10) return null;
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2);
  const peaks = []; // [freq, mag] per frame
  const tuneHist = new Float64Array(20); // cents offset from A440 in 5-cent steps (-50..+50)
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    let e = 0;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; e += x[o + i] * x[o + i]; }
    if (e / N < 1e-7) { peaks.push(null); continue; } // silence
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    let mx = 0; for (let k = 10; k < 1200; k++) if (mag[k] > mx) mx = mag[k];
    const list = [];
    for (let k = 10; k < 1200; k++) { // ~27 Hz .. 3.2 kHz
      const m = mag[k];
      if (m < mx * 0.02 || m < mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const d = (a - c) / (2 * (a - 2 * b + c) || 1);
      const fr = ((k + (isFinite(d) ? Math.max(-0.5, Math.min(0.5, d)) : 0)) * SR) / N;
      if (fr < 50 || fr > 3000) continue;
      list.push([fr, m]);
      const cents = 1200 * Math.log2(fr / 440); const off = cents - 100 * Math.round(cents / 100);
      tuneHist[Math.min(19, Math.max(0, Math.floor((off + 50) / 5)))] += m;
    }
    peaks.push(list);
  }
  let ti = 0; for (let i = 1; i < 20; i++) if (tuneHist[i] > tuneHist[ti]) ti = i;
  const ref = 440 * Math.pow(2, ((ti * 5 - 50 + 2.5) / 1200));
  const chroma = new Float64Array(12), bass = new Float64Array(12);
  const HW = [1, 0.5, 0.33, 0.25]; // a peak at f may be note f, or the 2nd/3rd/4th harmonic of f/2, f/3, f/4
  for (const list of peaks) {
    if (!list) continue;
    const fr12 = new Float64Array(12), b12 = new Float64Array(12);
    for (const [fr, m] of list) {
      for (let hh = 1; hh <= 4; hh++) {
        const f0 = fr / hh;
        if (f0 < 40) break;
        const semi = 12 * Math.log2(f0 / ref);
        const near = Math.round(semi), dist = Math.abs(semi - near);
        if (dist > 0.5) continue;
        const wgt = Math.cos((dist * Math.PI) / 1) ** 2; // closer to the note centre counts more
        const pc = ((near % 12) + 12 + 9) % 12;
        const v = m * m * HW[hh - 1] * wgt;
        fr12[pc] += v;
        if (hh === 1 && fr < 250) b12[pc] += v;
      }
    }
    const s = fr12.reduce((a, v) => a + v, 0), sb = b12.reduce((a, v) => a + v, 0);
    if (s > 0) for (let i = 0; i < 12; i++) chroma[i] += Math.sqrt(fr12[i] / s);
    if (sb > 0) for (let i = 0; i < 12; i++) bass[i] += Math.sqrt(b12[i] / sb);
  }
  // the bass line says a lot about the tonic: blend it in
  const cmax = Math.max(...chroma) || 1, bmax = Math.max(...bass) || 1;
  const prof = Array.from({ length: 12 }, (_, i) => chroma[i] / cmax + 0.35 * (bass[i] / bmax));
  let best = { r: -2 }, second = -2;
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => prof[(i + t) % 12]);
    for (const [mode, P] of [['major', MAJ], ['minor', MIN]]) {
      const r = corr(rot, P);
      if (r > best.r) { second = best.r; best = { r, tonic: t, mode }; } else if (r > second) second = r;
    }
  }
  const name = NOTES[best.tonic] + (best.mode === 'minor' ? 'm' : '');
  return { key: name, label: `${NOTES[best.tonic]} ${best.mode}`, camelot: (best.mode === 'major' ? CAMELOT_MAJ : CAMELOT_MIN)[best.tonic], confidence: Math.max(0, Math.min(1, best.r * 0.6 + (best.r - second) * 4)) };
}
function loudness(x) {
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / x.length);
  return { rmsDb: Math.round(20 * Math.log10(rms || 1e-9) * 10) / 10, peakDb: Math.round(20 * Math.log10(peak || 1e-9) * 10) / 10 };
}
self.onmessage = (e) => {
  const x = new Float32Array(e.data.buf);
  try {
    const t = tempo(x), k = key(x), l = loudness(x);
    self.postMessage({ id: e.data.id, result: { ...(t || {}), ...(k ? { key: k.key, keyLabel: k.label, camelot: k.camelot, keyConfidence: k.confidence } : {}), ...l } });
  } catch (err) { self.postMessage({ id: e.data.id, error: String(err && err.message || err) }); }
};
