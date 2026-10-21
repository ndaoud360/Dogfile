// AI search: "photos of a dog running on grass", "songs with piano", "find the video where I'm riding a bicycle".
// Free and private: open models run on this PC. Pictures and video frames use CLIP, music and sounds use CLAP.
// Embeddings are cached, so a folder is only analyzed once.
import { api, state, bus, h, esc, toast, KINDS, IS_WIN, fileUrl, basename } from './core.js';
import { confirm, modal } from './dialogs.js';

// ---------------- understanding the request ----------------
const IMG_WORDS = /\b(photos?|pictures?|pics?|images?|screenshots?|selfies?|wallpapers?)\b/i;
const VID_WORDS = /\b(videos?|clips?|movies?|footage|recordings?)\b/i;
const AUD_WORDS = /\b(songs?|music|tracks?|audio|sounds?|recordings? of sound|beats?|tunes?)\b/i;
export function looksLikeAiQuery(q) {
  q = q.trim();
  if (q.length < 8 || /[*?\\/]|\.\w{2,4}$/.test(q)) return false;
  const words = q.split(/\s+/).length;
  return words >= 3 && (IMG_WORDS.test(q) || VID_WORDS.test(q) || AUD_WORDS.test(q) || /^(find|show|search)\b/i.test(q));
}
export function parseQuery(q) {
  const kinds = new Set();
  if (IMG_WORDS.test(q)) kinds.add('image');
  if (VID_WORDS.test(q)) kinds.add('video');
  if (AUD_WORDS.test(q)) kinds.add('audio');
  if (!kinds.size) { kinds.add('image'); kinds.add('video'); }
  // "the photo where…", "a picture of a speaker", "one video": the person expects one or a few results
  const single = /\b(the|that|one|a|an)\s+(photo|picture|pic|image|video|clip|song|track|screenshot)\b/i.test(q) && !/\b(all|every|any)\b/i.test(q);
  let s = ' ' + q.trim().replace(/[?.!]+$/, '') + ' ';
  s = s.replace(/^\s*(please\s+)?(find|show|search( for)?|get|look for|where( is| are)?)\s+(me\s+)?(all\s+|the\s+|my\s+|some\s+|any\s+)?/i, ' ');
  s = s.replace(/\b(?:(?:a|an|the|some|any|all|one|of)\s+)?(?:photos?|pictures?|pics?|images?|screenshots?|videos?|clips?|movies?|footage|songs?|music|tracks?|audio|sounds?)(?:\s+(?:of|with|showing|containing|where|that have|that has|in which|which|that))?\b/gi, ' ');
  s = s.replace(/^\s*(of|with|that have|that has|showing|containing|where|in which|from|which|that)\b/i, ' ');
  s = s.replace(/\b(i'?m|i am|i was|me)\b/gi, 'a person').replace(/\bmy\b/gi, 'a').replace(/\btaken\b/gi, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  const subject = s || q.trim();
  return {
    kinds, single, subject,
    image: /^(at|in|on|during|under|near|from)\b/i.test(subject) ? [`a photo taken ${subject}`, `a photo ${subject}`] : [`a photo of ${subject}`, `${subject}`],
    video: /^(at|in|on|during|under|near|from)\b/i.test(subject) ? [`a video taken ${subject}`, `a video frame ${subject}`] : [`a video frame of ${subject}`, `${subject}`],
    audio: [`music with ${subject}`.replace(/with (with|of) /, 'with '), `the sound of ${subject}`, subject],
  };
}

// generic "everything else" descriptions: a file only counts as a match when the request describes it better than
// all of these do (zero-shot classification), which stops a search for one object from returning every photo
const NEG_IMAGE = ['a photo', 'a photo of a person', 'a photo of people', 'a selfie', 'a photo of a room', 'a photo of an object', 'a screenshot of a computer screen', 'a document with text', 'a photo of food', 'a photo of a landscape', 'a photo of a building', 'a photo of an animal', 'a photo of a car', 'a drawing', 'a logo', 'a blurry photo', 'a pattern', 'a photo of plants'];
const NEG_AUDIO = ['music', 'a song', 'speech', 'a person talking', 'noise', 'silence', 'electronic music', 'a beat', 'ambient sound'];
export function negatives(kind, subject) {
  const sw = new Set(subject.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  return (kind === 'audio' ? NEG_AUDIO : NEG_IMAGE).filter((n) => !n.toLowerCase().split(/[^a-z]+/).some((w) => sw.has(w) || sw.has(w.replace(/s$/, '')) || sw.has(w + 's')));
}

// ---------------- models ----------------
let worker = null, seq = 0;
const waiting = new Map();
export function call(msg, transfer) {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.result); };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'AI worker failed')); waiting.clear(); worker = null; };
  }
  const id = ++seq;
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []); }).finally(() => {
    // the models take a few hundred MB: let them go after two idle minutes (they reload in a second or two)
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!waiting.size && worker) { worker.terminate(); worker = null; } }, 120000);
  });
}
let idleTimer = null;
const fmtMB = (b) => (b / 1048576).toFixed(0) + ' MB';
export async function ensureModels(need) {
  let st = await api('ai:status');
  const missing = need.filter((k) => !st[k].ready);
  if (!missing.length) return true;
  const names = missing.map((k) => st[k].label).join(' and ');
  if (!st[missing[0]].downloading) {
    const ok = await confirm('Download free AI models?', `This feature runs privately on this PC with free open models. It needs a one-time download of <b>${esc(names)}</b> (about ${missing.map((k) => ({ clip: 150, clap: 190, whisper: 80, minilm: 25 }[k] || 50)).reduce((a, b) => a + b, 0)} MB) from Hugging Face. Nothing about your files is sent anywhere.`, { ok: 'Download' });
    if (!ok) return false;
    for (const k of missing) await api('ai:download', k);
  }
  // progress toast
  const host = document.getElementById('toasts');
  const fill = h('div', { class: 'tp-fill' }), txt = h('span', {}, 'Downloading AI models…');
  const el = h('div', { class: 'toast show tprog' }, txt, h('div', { class: 'tp-bar' }, fill));
  host?.append(el);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      st = await api('ai:status');
      const ps = missing.map((k) => st[k].progress || {});
      const err = ps.find((p) => p.error);
      if (err) throw new Error(err.error);
      const rec = ps.reduce((a, p) => a + (p.received || 0), 0), tot = ps.reduce((a, p) => a + (p.total || 0), 0);
      fill.style.width = tot ? Math.min(100, (rec / tot) * 100) + '%' : '5%';
      txt.textContent = `Downloading AI models… ${fmtMB(rec)}${tot ? ' of ' + fmtMB(tot) : ''}`;
      if (missing.every((k) => st[k].ready)) break;
      if (ps.every((p) => p.done) && !missing.every((k) => st[k].ready)) throw new Error('Download incomplete');
    }
    return true;
  } catch (e) { toast(`AI model download failed: ${e.message}`, { error: true }); return false; }
  finally { el.remove(); }
}

// ---------------- vectors ----------------
const b64 = (v) => { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const keyOf = (it, extra = '') => `${it.path}|${it.size || 0}|${Math.round(it.mtime || 0)}${extra}`;

const NATIVE_IMG = /\.(jpe?g|jfif|png|gif|webp|bmp|avif)$/i;
async function imageSource(it) {
  if (IS_WIN()) { const t = await api('thumb:get', it.path, 256).catch(() => null); if (t) return t; }
  return NATIVE_IMG.test(it.path) && (it.size || 0) < 25e6 ? fileUrl(it.path) : `/media/thumb?p=${encodeURIComponent(it.path)}&w=320`;
}

const isImg = (i) => !i.isDir && KINDS.image.includes(i.ext);
const isVid = (i) => !i.isDir && (KINDS.video.includes(i.ext) || ['mkv', 'm2ts', 'mts', 'ts', 'vob'].includes(i.ext));
const isAud = (i) => !i.isDir && KINDS.audio.includes(i.ext);

// ---------------- search ----------------
// t: the search tab; items are filled in and re-ranked as analysis progresses
export async function runAiSearch(t, query, roots) {
  const P = parseQuery(query);
  const need = [...new Set([...P.kinds].map((k) => (k === 'audio' ? 'clap' : 'clip')))];
  const mySeq = (t._aiSeq = (t._aiSeq || 0) + 1);
  const alive = () => t._aiSeq === mySeq && t.path?.includes('ai=1');
  t._aiStop = () => { t._aiSeq++; t._aiStop = null; t.searchInfo = { running: false, text: 'Stopped' }; bus.emit('aiSearchUpdate', t); };
  t.searchInfo = { running: true, text: 'Preparing AI search…' };
  bus.emit('aiSearchUpdate', t);
  if (!(await ensureModels(need))) { if (alive()) { t._aiStop = null; t.searchInfo = { running: false, text: 'AI search needs its models. Try again any time.' }; bus.emit('aiSearchUpdate', t); } return; }
  if (!alive()) return;
  // 1. candidate files
  const exts = [...(P.kinds.has('image') ? KINDS.image : []), ...(P.kinds.has('video') ? [...KINDS.video, 'mkv', 'm2ts', 'mts', 'ts'] : []), ...(P.kinds.has('audio') ? KINDS.audio : [])];
  t.searchInfo = { running: true, text: 'Finding files…' }; bus.emit('aiSearchUpdate', t);
  const files = await new Promise(async (resolve) => {
    const found = [];
    const id = await api('work:start', { type: 'search', roots, query: '', kind: 'file', extensions: [...new Set(exts)].join(','), includeHidden: false, recursive: true, maxResults: 20000, skipDirs: ['node_modules', '.git', '__pycache__', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)'] });
    t._aiStop = () => { t._aiSeq++; t._aiStop = null; api('work:cancel', id); t.items = []; t.searchInfo = { running: false, text: 'Stopped' }; bus.emit('aiSearchUpdate', t); resolve(found); };
    bus.emit('aiWorkStarted', { id, onMsg: (m) => { if (m.type === 'results') found.push(...m.items); else if (m.type === 'done' || m.type === 'error') resolve(found); } });
  });
  for (const f of files) if (!f.ext) f.ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  if (!alive()) return;
  t._aiStop = () => { t._aiSeq++; t._aiStop = null; t.searchInfo = { running: false, text: 'Stopped' }; bus.emit('aiSearchUpdate', t); };
  if (!files.length) { t.items = []; t.searchInfo = { running: false, text: 'No matching file types in this folder.' }; bus.emit('aiSearchUpdate', t); return; }
  // 2. text vectors
  const textVec = {};
  try {
    if (need.includes('clip')) { const v = await call({ type: 'text', kind: 'clip', texts: P.kinds.has('video') && !P.kinds.has('image') ? P.video : P.image }); textVec.clip = v; }
    if (need.includes('clap')) textVec.clap = await call({ type: 'text', kind: 'clap', texts: P.audio });
  } catch (e) { t.searchInfo = { running: false, text: `AI search failed: ${e.message}` }; bus.emit('aiSearchUpdate', t); return; }
  try {
    if (need.includes('clip')) textVec.clipNeg = await call({ type: 'text', kind: 'clip', texts: negatives('image', P.subject) });
    if (need.includes('clap')) textVec.clapNeg = await call({ type: 'text', kind: 'clap', texts: negatives('audio', P.subject) });
  } catch { /* scores fall back to raw similarity */ }
  // returns the best similarity plus how clearly the request beats the generic descriptions (0..1)
  const score = (model, vecs) => {
    const tv = textVec[model], nv = textVec[model + 'Neg'] || [];
    const scale = model === 'clap' ? 30 : 100;
    let best = -1, prob = 0;
    for (const v of vecs) {
      let s = -1; for (const q of tv) s = Math.max(s, dot(v, q));
      let z = 1; for (const n of nv) z += Math.exp(scale * (dot(v, n) - s));
      best = Math.max(best, s); prob = Math.max(prob, 1 / z);
    }
    return { s: best, p: nv.length ? prob : 1 };
  };
  const put = (it, model, vecs, suffix) => { const r = score(model, vecs); scored.set(it.path, { ...it, aiScore: r.s, aiProb: r.p, _aiKind: suffix === '|a' ? 'audio' : 'image' }); };
  // 3. cached vectors, then analyze the rest
  const imgs = files.filter((f) => P.kinds.has('image') && isImg(f)), vids = files.filter((f) => P.kinds.has('video') && isVid(f)), auds = files.filter((f) => P.kinds.has('audio') && isAud(f));
  const scored = new Map();
  const total = imgs.length + vids.length + auds.length;
  let done = 0;
  const started = Date.now();
  const publish = (final) => {
    if (final !== 'stopped' && !alive()) return;
    const arr = [...scored.values()].sort((a, b) => b.aiProb * 0.5 + b.aiScore * 5 - (a.aiProb * 0.5 + a.aiScore * 5));
    t._aiTop = arr.slice(0, 5).map((i) => i.name + ':' + i.aiScore.toFixed(3));
    const best = arr.reduce((m, i) => Math.max(m, i.aiScore), 0);
    // CLIP/CLAP similarities are small numbers: keep what is clearly above noise, close to the best match, and
    // described better by the request than by any generic description ("a photo of a room", "a person"...)
    const floor = (k) => (k === 'audio' ? 0.18 : 0.205);
    const minP = P.single ? 0.5 : 0.35;
    const keep = arr.filter((i) => i.aiScore >= floor(i._aiKind) && i.aiScore >= best - (P.single ? 0.03 : 0.05) && i.aiProb >= minP).slice(0, P.single ? 8 : 300);
    t.items = keep.map((i) => ({ ...i, subtitle: `${Math.round(Math.max(0, Math.min(1, i.aiProb)) * 100)}% match` }));
    t.sort = { key: 'match', dir: -1 };
    t.searchInfo = final
      ? { running: false, text: `${final === 'stopped' ? 'Stopped · ' : ''}${keep.length} match${keep.length === 1 ? '' : 'es'} for “${P.subject}” · ${total.toLocaleString()} files checked in ${((Date.now() - started) / 1000).toFixed(1)}s` }
      : { running: true, text: `AI is looking… ${done.toLocaleString()} of ${total.toLocaleString()} · ${keep.length} match${keep.length === 1 ? '' : 'es'} so far` };
    bus.emit('aiSearchUpdate', t);
  };
  // Stop button: keep what was found so far
  t._aiStop = () => { if (!alive()) return; t._aiSeq++; t._aiStop = null; publish('stopped'); };
  const groups = [['clip', imgs, ''], ['clip', vids, '|v4'], ['clap', auds, '|a']];
  for (const [model, list, suffix] of groups) {
    if (!list.length) continue;
    const keys = list.map((it) => keyOf(it, suffix));
    const cached = await api('ai:cacheGet', model, keys);
    const todo = [];
    list.forEach((it, i) => {
      const c = cached[keys[i]];
      if (c) { put(it, model, c.split(',').map(unb64), suffix); done++; }
      else todo.push([it, keys[i]]);
    });
    publish(false);
    let last = Date.now(), batch = {};
    for (const [it, key] of todo) {
      if (!alive()) return;
      let vecs = [];
      try {
        if (suffix === '') { const [v] = await call({ type: 'image', urls: [await imageSource(it)] }); if (v) vecs = [v]; }
        else if (suffix === '|v4') {
          const info = await api('media:probe', it.path).catch(() => null);
          const dur = parseFloat(info?.format?.duration) || 0;
          const ts = dur > 4 ? [0.1, 0.35, 0.6, 0.85].map((f) => (dur * f).toFixed(1)) : ['0'];
          const res = await call({ type: 'image', urls: ts.map((s) => `/media/thumb?p=${encodeURIComponent(it.path)}&t=${s}&w=320`) });
          vecs = res.filter(Boolean);
        } else {
          const info = await api('media:probe', it.path).catch(() => null);
          const dur = parseFloat(info?.format?.duration) || 0;
          const starts = dur > 60 ? [dur * 0.25, dur * 0.55] : [0];
          const bufs = [];
          for (const s of starts) { const r = await fetch(`/media/pcm?p=${encodeURIComponent(it.path)}&ss=${s.toFixed(1)}&t=10&sr=48000`); if (r.ok) bufs.push(await r.arrayBuffer()); }
          if (bufs.length) vecs = (await call({ type: 'audio', buffers: bufs }, bufs)).filter(Boolean);
        }
      } catch (e) { if (/worker|wasm|onnx|model/i.test(e.message) && !vecs.length && done === 0) { t.searchInfo = { running: false, text: `AI search failed: ${e.message}` }; bus.emit('aiSearchUpdate', t); return; } }
      done++;
      if (vecs.length) {
        batch[key] = vecs.map(b64).join(',');
        put(it, model, vecs, suffix);
      }
      if (Date.now() - last > 700) { last = Date.now(); publish(false); api('ai:cacheSet', model, batch); batch = {}; }
    }
    if (Object.keys(batch).length) api('ai:cacheSet', model, batch);
  }
  if (alive()) { t._aiStop = null; publish(true); }
}

// Settings > Tools: manage downloaded models
export async function modelsDialog() {
  const st = await api('ai:status');
  const rows = Object.entries(st).map(([k, s]) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('div', {}, s.label), h('div', { class: 'hint' }, s.ready ? `Installed · ${fmtMB(s.bytes)}` : 'Not downloaded')),
    h('div', { class: 'set-ctl row-inline' }, s.ready ? h('button', { class: 'btn small', onclick: async () => { await api('ai:remove', k); toast('Removed'); } }, 'Remove') : h('button', { class: 'btn small primary', onclick: () => ensureModels([k]) }, 'Download'))));
  modal({ title: 'AI search models', width: 520, body: h('div', {}, ...rows, h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Models: CLIP ViT-B/32 and CLAP (HTSAT), open source, run on this PC. Analysis results are cached so each file is only looked at once.')), buttons: [{ label: 'Close', primary: true, value: true }] });
}
