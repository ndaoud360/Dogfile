// Runs the stem-separation model (HT-Demucs, 6 sources) away from the window, so the window stays usable.
// 'init' loads the model file Dogfile downloaded; 'run' takes one 7.8-second piece of stereo audio
// (left channel, then right) and answers with the six sources (each left, then right).
import * as ort from '../vendor/ort/ort.bundle.min.mjs';

ort.env.wasm.wasmPaths = '/app/vendor/ort/';
ort.env.wasm.numThreads = 1; // more threads need the page to be cross-origin isolated, which Dogfile's pages aren't
ort.env.logLevel = 'warning';
let session = null;
const SEG = 343980;

// what the engine says about a failure goes to the window with the error: it is often the only clue
const notes = [];
for (const k of ['log', 'info', 'warn', 'error']) {
  const was = console[k].bind(console);
  console[k] = (...a) => { notes.push(a.map((x) => (typeof x === 'string' ? x : String(x?.message || x))).join(' ').slice(0, 300)); if (notes.length > 16) notes.shift(); was(...a); };
}
/** the engine sometimes throws a bare number (a memory address) instead of an error: say what that most likely means */
function describe(err, stage) {
  const raw = err?.message ?? err;
  const text = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? `the engine stopped with code ${raw}, which usually means it ran out of memory` : String(raw);
  const clues = notes.filter((n) => !/^\s*$/.test(n)).slice(-6).join(' | ');
  return `${stage}: ${text}${clues ? ` (${clues})` : ''}`;
}

/** the model file, read in pieces so the window can show how far it is */
async function readModel(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The model file couldn’t be read (${r.status}). Download it again from Settings.`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  const bytes = new Uint8Array(total);
  const reader = r.body.getReader();
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, got); got += value.length;
    if (got - last > 4e6) { last = got; onProgress(got / total); }
  }
  if (got !== total) throw new Error('The model file is incomplete. Download it again from Settings.');
  return bytes;
}

self.onmessage = async (e) => {
  const m = e.data;
  let stage = 'Loading the model';
  try {
    if (m.type === 'init') {
      let bytes = await readModel(m.url, (p) => self.postMessage({ id: m.id, progress: p }));
      self.postMessage({ id: m.id, building: true });
      stage = 'Starting the model';
      // one setting per worker: after the engine aborts, its memory is unusable, so the window starts a new worker to try the next one
      const level = m.level || 'all';
      const opts = level === 'all' ? {} : { enableCpuMemArena: false, enableMemPattern: false };
      let last = null;
      try { session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: level, logSeverityLevel: 1, ...opts }); }
      catch (err) { last = err; session = null; console.warn(`model load with ${level} optimisation failed`); }
      bytes = null;
      if (last) throw last;
      self.postMessage({ id: m.id, ready: true });
    } else if (m.type === 'run') {
      stage = 'Separating';
      if (!session) throw new Error('The model isn’t loaded');
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', m.chunk, [1, 2, SEG]) });
      const data = out[session.outputNames[0]].data;
      const copy = new Float32Array(data); // the model's own memory is reused by the next piece
      self.postMessage({ id: m.id, out: copy }, [copy.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: describe(err, stage) });
  }
};
