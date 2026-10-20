// Shared BPM / key analysis (used by Dogfile Player and the Audio ribbon tab), cached per file.
import { api } from './core.js';

let worker = null, seq = 0;
const waiting = new Map();
let cache = null;
async function loadCache() { if (!cache) cache = (await api('store:get', 'audio-analysis').catch(() => null)) || {}; return cache; }
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./analyze-worker.js', import.meta.url));
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.result); };
  return worker;
}
export async function cachedAll() { return loadCache(); }
export async function cachedAnalysis(path) { const c = await loadCache(); return c[path] || null; }
export async function analyzeAudio(path, { force = false } = {}) {
  const c = await loadCache();
  const st = await api('fs:stat', path).catch(() => null);
  const sig = st ? `v2|${st.size}|${Math.round(st.mtime)}` : '';
  if (!force && c[path] && c[path].sig === sig) return c[path];
  const r = await fetch(`atlas://media/pcm?p=${encodeURIComponent(path)}&ss=0&t=360`);
  if (!r.ok) throw new Error('Could not decode this audio');
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 22050 * 4 * 5) throw new Error('Audio is too short to analyze');
  const id = ++seq;
  const result = await new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); getWorker().postMessage({ id, buf }, [buf]); });
  result.sig = sig; result.at = Date.now();
  c[path] = result;
  const keys = Object.keys(c); if (keys.length > 3000) delete c[keys[0]];
  api('store:set', 'audio-analysis', c);
  return result;
}
export const fmtAnalysis = (a) => [a.bpm ? `${Math.round(a.bpm)} BPM` : null, a.keyLabel ? `${a.keyLabel} (${a.camelot})` : null].filter(Boolean).join(' · ');
