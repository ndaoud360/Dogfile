// AI search worker: turns text, pictures and sounds into comparable vectors with open models running locally.
// CLIP (pictures, video frames) and CLAP (music, sounds). Models load from /models/ (downloaded once).
import { env, pipeline, AutoTokenizer, AutoProcessor, RawImage, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, ClapTextModelWithProjection, ClapAudioModelWithProjection } from '../vendor/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = '/app/vendor/ort/';
env.backends.onnx.wasm.numThreads = 1;

const REPO = { clip: 'Xenova/clip-vit-base-patch32', clap: 'Xenova/clap-htsat-unfused', whisper: 'Xenova/whisper-base', minilm: 'Xenova/all-MiniLM-L6-v2' };
const loaded = {};
const opts = { dtype: 'q8', device: 'wasm' };
async function load(kind, part) {
  const key = kind + ':' + part;
  if (!loaded[key]) {
    loaded[key] = (async () => {
      const repo = REPO[kind];
      if (part === 'text') return { tok: await AutoTokenizer.from_pretrained(repo), model: await (kind === 'clip' ? CLIPTextModelWithProjection : ClapTextModelWithProjection).from_pretrained(repo, opts) };
      return { proc: await AutoProcessor.from_pretrained(repo), model: await (kind === 'clip' ? CLIPVisionModelWithProjection : ClapAudioModelWithProjection).from_pretrained(repo, opts) };
    })();
    loaded[key].catch(() => delete loaded[key]);
  }
  return loaded[key];
}
function rows(t) {
  // tensor [n, d] -> array of normalized Float32Array
  const [n, d] = t.dims;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(t.data.subarray ? t.data.subarray(i * d, (i + 1) * d) : Array.prototype.slice.call(t.data, i * d, (i + 1) * d));
    let s = 0; for (let k = 0; k < d; k++) s += v[k] * v[k];
    s = Math.sqrt(s) || 1; for (let k = 0; k < d; k++) v[k] /= s;
    out.push(v);
  }
  return out;
}

async function embedText(kind, texts) {
  const { tok, model } = await load(kind, 'text');
  const inputs = tok(texts, { padding: true, truncation: true });
  const out = await model(inputs);
  return rows(out.text_embeds);
}
async function embedImages(urls) {
  const { proc, model } = await load('clip', 'vision');
  const res = [];
  for (const u of urls) {
    try {
      const img = await RawImage.read(u);
      const inputs = await proc(img);
      const out = await model(inputs);
      res.push(rows(out.image_embeds)[0]);
    } catch (e) { res.push(null); }
  }
  return res;
}
async function embedAudio(buffers) {
  const { proc, model } = await load('clap', 'audio');
  const res = [];
  for (const b of buffers) {
    try {
      const inputs = await proc(new Float32Array(b), { sampling_rate: 48000 });
      const out = await model(inputs);
      res.push(rows(out.audio_embeds)[0]);
    } catch (e) { res.push(null); }
  }
  return res;
}

// speech to text with timestamps (Whisper); audio is 16 kHz mono
let asr = null;
async function transcribe(buffer, language) {
  if (!asr) asr = pipeline('automatic-speech-recognition', REPO.whisper, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm' });
  const p = await asr.catch((e) => { asr = null; throw e; });
  const out = await p(new Float32Array(buffer), { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, ...(language && language !== 'auto' ? { language, task: 'transcribe' } : {}) });
  return { text: out.text, chunks: (out.chunks || []).map((c) => ({ start: c.timestamp[0], end: c.timestamp[1], text: c.text })) };
}
// sentence vectors for file names / text (MiniLM), used by folder cleanup
let fe = null;
async function embedSentences(texts) {
  if (!fe) fe = pipeline('feature-extraction', REPO.minilm, { dtype: 'q8', device: 'wasm' });
  const p = await fe.catch((e) => { fe = null; throw e; });
  const out = await p(texts, { pooling: 'mean', normalize: true });
  return rows(out);
}

self.onmessage = async (e) => {
  const { id, type, kind, texts, urls, buffers } = e.data;
  try {
    let result;
    if (type === 'text') result = await embedText(kind, texts);
    else if (type === 'image') result = await embedImages(urls);
    else if (type === 'audio') result = await embedAudio(buffers);
    else if (type === 'warm') { await load(kind, 'text'); result = true; }
    else if (type === 'transcribe') result = await transcribe(e.data.buffer, e.data.language);
    else if (type === 'sentences') result = await embedSentences(texts);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
