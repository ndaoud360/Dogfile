// Free, private AI search: open models (CLIP for pictures/video frames, CLAP for audio) are downloaded once
// from Hugging Face into the user's profile and run locally in the renderer (transformers.js / ONNX Runtime).
// This module handles the downloads, serves the files over atlas://models/… and keeps an embedding cache.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app, net } = require('electron');

const MODELS = {
  clip: { repo: 'Xenova/clip-vit-base-patch32', label: 'Pictures & video (CLIP)', files: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/text_model_quantized.onnx', 'onnx/vision_model_quantized.onnx'], optional: ['special_tokens_map.json'] },
  whisper: { repo: 'Xenova/whisper-base', label: 'Speech to text (Whisper)', files: ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'], optional: ['special_tokens_map.json', 'added_tokens.json'] },
  minilm: { repo: 'Xenova/all-MiniLM-L6-v2', label: 'Text understanding (MiniLM)', files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'], optional: ['special_tokens_map.json'] },
  clap: { repo: 'Xenova/clap-htsat-unfused', label: 'Music & sounds (CLAP)', files: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/text_model_quantized.onnx', 'onnx/audio_model_quantized.onnx'], optional: ['special_tokens_map.json'] },
};
const root = () => process.env.ATLAS_MODELS_DIR || path.join(app.getPath('userData'), 'models');
const dirOf = (k) => path.join(root(), ...MODELS[k].repo.split('/'));
const BASE = process.env.ATLAS_MODEL_BASE || 'https://huggingface.co';

function status() {
  const out = {};
  for (const [k, m] of Object.entries(MODELS)) {
    const need = m.files.filter((f) => !m.optional.includes(f));
    let bytes = 0;
    const ready = need.every((f) => { try { bytes += fs.statSync(path.join(dirOf(k), f)).size; return true; } catch { return false; } });
    out[k] = { ready, bytes, label: m.label, downloading: !!dl[k] && !dl[k].done, progress: dl[k] ? publicDl(dl[k]) : null };
  }
  return out;
}
const dl = {};
const publicDl = (d) => ({ received: d.received, total: d.total, file: d.file, done: d.done, error: d.error });

async function download(k) {
  if (!MODELS[k]) throw new Error('Unknown model');
  if (dl[k] && !dl[k].done) return publicDl(dl[k]);
  const d = dl[k] = { received: 0, total: 0, file: '', done: false, error: null };
  (async () => {
    try {
      const m = MODELS[k];
      const dir = dirOf(k);
      await fsp.mkdir(path.join(dir, 'onnx'), { recursive: true });
      // sizes first, for an honest progress bar
      const sizes = {};
      for (const f of m.files) {
        try { const r = await net.fetch(`${BASE}/${m.repo}/resolve/main/${f}`, { method: 'HEAD' }); sizes[f] = +(r.headers.get('content-length') || r.headers.get('x-linked-size') || 0); } catch { sizes[f] = 0; }
      }
      d.total = Object.values(sizes).reduce((a, b) => a + b, 0);
      for (const f of m.files) {
        const dest = path.join(dir, f);
        if (fs.existsSync(dest) && (!sizes[f] || fs.statSync(dest).size === sizes[f])) { d.received += fs.statSync(dest).size; continue; }
        d.file = f;
        const r = await net.fetch(`${BASE}/${m.repo}/resolve/main/${f}`);
        if (!r.ok) { if (m.optional.includes(f)) continue; throw new Error(`Download failed (${r.status}) for ${f}`); }
        const tmp = dest + '.part';
        const out = fs.createWriteStream(tmp);
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          d.received += value.length;
          if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
        }
        await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
        await fsp.rename(tmp, dest);
      }
      d.done = true; d.file = '';
    } catch (e) { d.error = e.message; d.done = true; }
  })();
  return publicDl(d);
}
async function remove(k) { await fsp.rm(dirOf(k), { recursive: true, force: true }); delete dl[k]; caches.delete(k); try { fs.unlinkSync(cacheFile(k)); } catch {} return true; }

// serve atlas://models/<repo>/<file>
function serve(u) {
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(root(), rel));
  if (!file.startsWith(path.normalize(root()))) return new Response('Forbidden', { status: 403 });
  try {
    const st = fs.statSync(file);
    const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    const body = fs.readFileSync(file);
    return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Access-Control-Allow-Origin': '*' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

// embedding cache: one JSON file per model, key = path|size|mtime -> base64 Float32Array
const caches = new Map();
const cacheFile = (k) => path.join(root(), `cache-${k}.json`);
function cacheOf(k) {
  if (!caches.has(k)) { let o = {}; try { o = JSON.parse(fs.readFileSync(cacheFile(k), 'utf8')); } catch {} caches.set(k, o); }
  return caches.get(k);
}
const saveTimers = {};
function cacheGet(k, keys) { const c = cacheOf(k); const out = {}; for (const key of keys) if (c[key]) out[key] = c[key]; return out; }
function cacheSet(k, entries) {
  const c = cacheOf(k);
  Object.assign(c, entries);
  clearTimeout(saveTimers[k]);
  saveTimers[k] = setTimeout(() => { fs.mkdirSync(root(), { recursive: true }); fs.writeFile(cacheFile(k), JSON.stringify(c), () => {}); }, 1500);
  return true;
}

module.exports = { MODELS, status, download, remove, serve, cacheGet, cacheSet };
