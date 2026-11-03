// Runs the stem-separation model (HT-Demucs, 6 sources) away from the window, so the window stays usable.
// 'init' loads the model file Dogfile downloaded; 'run' takes one 7.8-second piece of stereo audio
// (left channel, then right) and answers with the six sources (each left, then right).
import * as ort from '../vendor/ort/ort.bundle.min.mjs';

ort.env.wasm.wasmPaths = '/app/vendor/ort/';
ort.env.wasm.numThreads = 1; // more threads need the page to be cross-origin isolated, which Dogfile's pages aren't
let session = null;
const SEG = 343980;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const r = await fetch(m.url);
      if (!r.ok) throw new Error(`The model file couldn’t be read (${r.status}). Download it again from Settings.`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      self.postMessage({ id: m.id, ready: true });
    } else if (m.type === 'run') {
      if (!session) throw new Error('The model isn’t loaded');
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', m.chunk, [1, 2, SEG]) });
      const data = out[session.outputNames[0]].data;
      const copy = new Float32Array(data); // the model's own memory is reused by the next piece
      self.postMessage({ id: m.id, out: copy }, [copy.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
