// Stem separator (Dogfile Player): splits a song into vocals, drums, bass, guitar, piano and the rest, with a volume for
// each, a preview of what you chose, and an export of the stems (one WAV, or several in a ZIP) beside the song.
// The model (HT-Demucs, 6 sources) is downloaded once like Dogfile's other AI models and runs on this PC, in stems-worker.js.
import { api, h, toast, fileUrl, errText } from './core.js';
import { modal } from './dialogs.js';
import { requirePro } from './license.js';
import { icon } from './icons.js';
import { ensureModels } from './ai.js';
import { showInFiles } from './embed.js';
import { SAMPLE_RATE, STEMS, MAX_SECONDS, separate, toStereo, mixdown, encodeWav, zipParts, safeName } from './stems-core.js';

const MODEL_URL = '/models/StemSplitio/htdemucs-6s-onnx/htdemucs_6s_fp16weights.onnx';
const KEEP_MS = 5 * 60 * 1000;
let kept = null; // the last song's stems stay for a few minutes, so closing and reopening the window doesn't start over

const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------- the model, in a worker ----------
function makeWorker(level) {
  const w = new Worker(new URL('./stems-worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const waiting = new Map();
  const failAll = (err) => { for (const p of waiting.values()) p.rej(err); waiting.clear(); };
  w.onmessage = (e) => {
    const p = waiting.get(e.data.id);
    if (!p) return;
    if (e.data.progress != null || e.data.building) { p.onStatus?.(e.data); return; } // the model is still being read or built
    waiting.delete(e.data.id);
    e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data);
  };
  w.onerror = (e) => failAll(new Error(e.message || 'The stem separator stopped unexpectedly'));
  const call = (msg, transfer, onStatus) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej, onStatus }); w.postMessage({ ...msg, id }, transfer || []); });
  return {
    init: (onStatus) => call({ type: 'init', url: MODEL_URL, level }, null, onStatus),
    run: async (chunk) => (await call({ type: 'run', chunk }, [chunk.buffer])).out,
    stop: () => { w.terminate(); failAll(new Error('Stopped')); },
  };
}
/** the model engine. Building the model needs a lot of memory, so it starts with the settings that need the least and,
 * if the engine gives up, tries again in a fresh worker with the next ones. */
function makeEngine() {
  let cur = null, stopped = false;
  return {
    async init(onStatus) {
      const errors = [];
      for (const level of ['disabled', 'basic', 'all']) {
        if (stopped) throw new Error('Stopped');
        cur = makeWorker(level);
        try { await cur.init(onStatus); return; }
        catch (e) { cur.stop(); cur = null; if (stopped || /Stopped/.test(e.message)) throw e; errors.push(e.message); if (!/Aborted|memory|code \d+/i.test(e.message)) break; }
      }
      throw new Error(errors[errors.length - 1] + (errors.length > 1 ? ` (tried ${errors.length} ways)` : ''));
    },
    run: (chunk) => cur.run(chunk),
    stop() { stopped = true; cur?.stop(); },
  };
}

// ---------- reading the song ----------
async function decodeSong(path) {
  const r = await fetch(fileUrl(path));
  if (!r.ok) throw new Error('The song couldn’t be read.');
  const bytes = await r.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); // decoding at 44.1 kHz resamples whatever the file has
  try { return await ctx.decodeAudioData(bytes); }
  catch { throw new Error('Dogfile couldn’t read the sound in this file. Stems work with MP3, WAV, FLAC, M4A/AAC and OGG/Opus songs.'); }
  finally { ctx.close().catch(() => {}); }
}

// ---------- playing the preview ----------
function makePreview(buffers) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const gains = {};
  for (const k of Object.keys(buffers)) { gains[k] = ctx.createGain(); gains[k].connect(master); }
  const duration = Object.values(buffers)[0].duration;
  let nodes = [], startedAt = 0, offset = 0, playing = false, token = 0;
  const stopNodes = () => { token++; for (const n of nodes) { n.onended = null; try { n.stop(); } catch { /* not started */ } n.disconnect(); } nodes = []; };
  const position = () => Math.min(duration, playing ? offset + ctx.currentTime - startedAt : offset);
  return {
    duration, gains,
    get playing() { return playing; },
    position,
    async play(from = offset) {
      await ctx.resume();
      stopNodes();
      offset = from >= duration - 0.05 ? 0 : from; startedAt = ctx.currentTime; playing = true;
      const my = token;
      nodes = Object.entries(buffers).map(([k, b]) => { const s = ctx.createBufferSource(); s.buffer = b; s.connect(gains[k]); s.start(0, offset); return s; });
      nodes[0].onended = () => { if (token === my) { playing = false; offset = 0; } };
    },
    pause() { offset = position(); playing = false; stopNodes(); },
    seek(t) { if (playing) this.play(t); else offset = t; },
    setGain(k, v) { gains[k].gain.setTargetAtTime(v, ctx.currentTime, 0.015); },
    close() { playing = false; stopNodes(); ctx.close().catch(() => {}); },
  };
}

// ---------- saving ----------
async function writeParts(path, parts) {
  const CH = 3 * 1024 * 1024; // a multiple of 3, so every piece is whole base64 by itself
  let first = true;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += CH) {
      const piece = part.subarray(i, i + CH);
      let s = '';
      for (let j = 0; j < piece.length; j += 0x8000) s += String.fromCharCode.apply(null, piece.subarray(j, j + 0x8000));
      await api('fs:writePart', path, btoa(s), !first);
      first = false;
    }
  }
  await api('fs:finishPart', path);
}

// ---------- a whole folder or album, one song after another ----------
/**
 * Separate many songs with one loaded model. For each song it writes, next to it (or into `outDir`), a vocals file and an
 * instrumental file (everything but the vocals) as WAV, or all six parts when `allParts` is on.
 * `ctl`: { cancelled(), onSong(index, total, name), onPart(k, n), onDone(path, outputs), onFail(path, message) }.
 */
export async function separateBatch(paths, { allParts = false, outDir = '' } = {}, ctl = {}) {
  if (!requirePro('stems')) return { done: 0, failed: 0 };
  if (!(await ensureModels(['stems']))) return { done: 0, failed: 0 };
  let engine = makeEngine(), done = 0, failed = 0;
  try {
    ctl.onSong?.(0, paths.length, 'Loading the model…');
    await engine.init(() => {});
    for (let i = 0; i < paths.length; i++) {
      if (ctl.cancelled?.()) break;
      const path = paths[i], file = path.split(/[\\/]/).pop(), song = file.replace(/\.[^.]+$/, '');
      ctl.onSong?.(i, paths.length, file);
      try {
        const audio = await decodeSong(path);
        if (audio.duration > MAX_SECONDS) throw new Error(`longer than ${MAX_SECONDS / 60} minutes`);
        const [left, right] = toStereo(Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, k) => audio.getChannelData(k)));
        const result = await separate(left, right, engine.run, { cancelled: () => ctl.cancelled?.(), onProgress: (k, n) => ctl.onPart?.(k, n) });
        if (ctl.cancelled?.()) break;
        const dir = outDir || path.replace(/[\\/][^\\/]*$/, '');
        const wav = (pair) => encodeWav(pair[0], pair[1]);
        const outs = [];
        const put = async (label, pair) => {
          const target = await api('fs:uniqueName', dir, `${safeName(song)} (${label}).wav`, 'number');
          await writeParts(target, [wav(pair)]);
          outs.push(target);
        };
        if (allParts) for (const s of STEMS) await put(s.label.toLowerCase(), result[s.key]);
        else {
          await put('vocals', result.vocals);
          const gains = Object.fromEntries(STEMS.map((s) => [s.key, s.key === 'vocals' ? 0 : 1]));
          const [l, r] = mixdown(Object.fromEntries(STEMS.map((s) => [s.key, result[s.key]])), gains, audio.length);
          await put('instrumental', [l, r]);
        }
        done++; ctl.onDone?.(path, outs);
      } catch (e) {
        if (/Stopped/.test(e.message || '')) break;
        failed++; ctl.onFail?.(path, errText(e));
      }
    }
  } finally { engine.stop(); }
  return { done, failed };
}

// ---------- the window ----------
export async function openStems({ path, time = 0 }) {
  if (!requirePro('stems')) return;
  const file = path.split(/[\\/]/).pop();
  const song = file.replace(/\.[^.]+$/, '');
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  const st = await api('fs:stat', path).catch(() => null);
  const songKey = `${path}|${st?.size || 0}|${Math.round(st?.mtime || 0)}`;

  let engine = null, stopped = false, preview = null, buffers = null, length = 0, busy = false, tick = null;

  // --- what's on screen ---
  const intro = h('div', { class: 'st-intro' },
    h('p', {}, 'Splits ', h('b', {}, song), ' into vocals, drums, bass, guitar, piano and everything else. Then set a volume for each, listen to the result, and save the parts you want.'),
    h('p', { class: 'st-note' }, 'It runs on this PC and your song never leaves it. A typical song takes a few minutes, and Dogfile stays usable meanwhile. It needs a one-time model download (about 140 MB) and about 1.5 GB of free memory.'),
    h('button', { class: 'btn primary', onclick: () => start() }, 'Separate this song'));
  const barFill = h('div', { class: 'st-fill' });
  const progText = h('div', { class: 'st-ptext' }, '');
  const cancelBtn = h('button', { class: 'btn small', onclick: () => { stopped = true; engine?.stop(); } }, 'Cancel');
  const prog = h('div', { class: 'st-prog', hidden: true }, progText, h('div', { class: 'st-bar' }, barFill), cancelBtn);

  const rows = {};
  const mixer = h('div', { class: 'st-mixer', hidden: true });
  const exportBtn = h('button', { class: 'btn primary', hidden: true, disabled: true, onclick: () => doExport() }, 'Save');
  const savedLine = h('div', { class: 'st-saved' });
  const playBtn = h('button', { class: 'btn small st-play', title: 'Preview what you chose', html: icon('pplay'), onclick: () => togglePreview() });
  const seek = h('input', { type: 'range', class: 'st-seek', min: 0, max: 1000, value: 0, oninput: () => { if (preview) preview.seek((seek.value / 1000) * preview.duration); updateClock(); } });
  const clock = h('span', { class: 'st-clock' }, '0:00');

  const body = h('div', { class: 'st-body' }, intro, prog, mixer, savedLine);
  // keys typed here shouldn't also control the song underneath (Escape still closes the window)
  body.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

  const showProgress = (text, pct) => {
    intro.hidden = true; mixer.hidden = true; prog.hidden = false; progText.textContent = text; cancelBtn.hidden = false;
    progText.classList.remove('st-err'); prog.querySelectorAll('.st-back').forEach((b) => b.remove());
    barFill.parentElement.classList.toggle('indeterminate', pct == null); // no percentage to show: the bar slides instead of sitting empty
    barFill.style.width = pct == null ? '' : pct + '%';
  };

  function updateClock() {
    if (!preview) return;
    const p = preview.position();
    clock.textContent = `${fmtTime(p)} / ${fmtTime(preview.duration)}`;
    if (document.activeElement !== seek) seek.value = String(Math.round((p / preview.duration) * 1000));
    playBtn.innerHTML = icon(preview.playing ? 'ppause' : 'pplay');
  }
  function togglePreview() {
    if (!preview) return;
    if (preview.playing) preview.pause(); else preview.play();
    updateClock();
  }
  function updateExportLabel() {
    const n = STEMS.filter((s) => rows[s.key].chk.checked).length + (rows.mix.chk.checked ? 1 : 0);
    exportBtn.disabled = busy || n === 0;
    exportBtn.textContent = n === 0 ? 'Pick something to save' : n === 1 ? 'Save as a WAV file' : `Save ${n} files in a ZIP`;
  }

  function buildMixer() {
    mixer.replaceChildren();
    preview = makePreview(buffers);
    const mk = (key, label, checked, gain) => {
      const chk = h('input', { type: 'checkbox', title: 'Save this one', onchange: updateExportLabel });
      chk.checked = checked;
      const val = h('span', { class: 'st-val' }, '100%');
      const slider = h('input', { type: 'range', class: 'st-vol', min: 0, max: 150, value: 100, 'aria-label': `${label} volume`, oninput: () => {
        val.textContent = slider.value + '%';
        if (preview.gains[key]) preview.setGain(key, slider.value / 100);
      } });
      slider.addEventListener('dblclick', () => { slider.value = '100'; slider.dispatchEvent(new Event('input')); });
      rows[key] = { chk, slider };
      return h('label', { class: 'st-row' }, chk, h('span', { class: 'st-name' }, label), gain ? slider : h('span', { class: 'st-spacer' }), gain ? val : h('span'));
    };
    for (const s of STEMS) mixer.append(mk(s.key, s.label, true, true));
    rows.mix = { chk: h('input', { type: 'checkbox', title: 'Save the mix', onchange: updateExportLabel }) };
    mixer.append(h('label', { class: 'st-row st-mixrow' }, rows.mix.chk, h('span', { class: 'st-name' }, 'The mix I made'), h('span', { class: 'st-hint' }, 'all of the above, at the volumes shown')));
    mixer.append(h('div', { class: 'st-transport' }, playBtn, seek, clock));
    mixer.append(h('div', { class: 'st-note' }, 'The sliders change the preview and “The mix I made”. The separate stems are saved at full volume. Double-click a slider to reset it.'));
    seek.value = '0';
    prog.hidden = true; intro.hidden = true; mixer.hidden = false;
    exportBtn.hidden = false;
    updateExportLabel();
    preview.seek(Math.min(Math.max(0, time), preview.duration - 1));
    tick = setInterval(updateClock, 200);
    updateClock();
  }

  async function start() {
    if (busy) return;
    busy = true; stopped = false; savedLine.textContent = '';
    try {
      if (kept?.key === songKey) { clearTimeout(kept.timer); buffers = kept.buffers; length = kept.length; kept = null; buildMixer(); return; }
      showProgress('Getting the model ready…');
      if (!(await ensureModels(['stems']))) { prog.hidden = true; intro.hidden = false; return; }
      showProgress('Reading the song…');
      const audio = await decodeSong(path);
      if (stopped) throw new Error('Stopped');
      if (audio.duration > MAX_SECONDS) throw new Error(`This song is ${fmtTime(audio.duration)} long. Songs up to ${MAX_SECONDS / 60} minutes can be separated (the parts need a lot of memory).`);
      const [left, right] = toStereo(Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i)));
      length = audio.length;
      showProgress('Loading the model…', 2);
      engine = makeEngine();
      await engine.init((s) => {
        // reading the file has a real percentage; building it in memory doesn't, so the bar moves back and forth
        if (s.building) showProgress('Starting the model… this can take a minute', null);
        else showProgress(`Loading the model… ${Math.round(s.progress * 100)}%`, 2 + s.progress * 30);
      });
      if (stopped) throw new Error('Stopped');
      const t0 = performance.now();
      const result = await separate(left, right, engine.run, {
        cancelled: () => stopped,
        onProgress: (k, n) => {
          const per = (performance.now() - t0) / k, left = Math.max(0, Math.round(((n - k) * per) / 1000));
          showProgress(`Separating… part ${k} of ${n}${k < n ? ` · about ${left >= 60 ? Math.round(left / 60) + ' min' : left + ' s'} left` : ''}`, (k / n) * 100);
        },
      });
      engine.stop(); engine = null; // frees the model's memory
      showProgress('Almost done…', 100);
      buffers = {};
      for (const s of STEMS) {
        const b = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
        b.copyToChannel(result[s.key][0], 0); b.copyToChannel(result[s.key][1], 1);
        buffers[s.key] = b;
        delete result[s.key];
      }
      buildMixer();
    } catch (e) {
      engine?.stop(); engine = null;
      if (/Stopped/.test(e.message || '')) { prog.hidden = true; intro.hidden = false; }
      else {
        showProgress(errText(e), 0);
        progText.classList.add('st-err'); // selectable, so it can be copied
        cancelBtn.hidden = true;
        prog.append(h('button', { class: 'btn small st-back', onclick: () => { prog.hidden = true; intro.hidden = false; } }, 'Back'));
        console.error('stems', e);
      }
    } finally { busy = false; if (buffers) updateExportLabel(); }
  }

  async function doExport() {
    if (busy || !buffers) return;
    const picked = STEMS.filter((s) => rows[s.key].chk.checked), wantMix = rows.mix.chk.checked;
    const count = picked.length + (wantMix ? 1 : 0);
    if (!count) return;
    busy = true; exportBtn.disabled = true; exportBtn.textContent = 'Saving…'; savedLine.textContent = '';
    try {
      const data = (b) => [b.getChannelData(0), b.getChannelData(1)];
      const files = picked.map((s) => ({ name: `${safeName(song)} (${s.label.toLowerCase()}).wav`, make: () => { const [l, r] = data(buffers[s.key]); return encodeWav(l, r); } }));
      if (wantMix) files.push({ name: `${safeName(song)} (mix).wav`, make: () => {
        const gains = Object.fromEntries(STEMS.map((s) => [s.key, rows[s.key].slider.value / 100]));
        const [l, r] = mixdown(Object.fromEntries(STEMS.map((s) => [s.key, data(buffers[s.key])])), gains, length);
        return encodeWav(l, r);
      } });
      let target;
      if (files.length === 1) {
        target = await api('fs:uniqueName', dir, files[0].name, 'number');
        await writeParts(target, [files[0].make()]);
      } else {
        target = await api('fs:uniqueName', dir, `${safeName(song)} (stems).zip`, 'number');
        await writeParts(target, zipParts(files.map((f) => ({ name: f.name, data: f.make() }))));
      }
      const shown = target.split(/[\\/]/).pop();
      savedLine.replaceChildren(`Saved ${shown} next to the song. `, h('button', { class: 'link', onclick: () => showInFiles(target) }, 'Show in folder'));
      toast(`Saved ${shown}`, { ok: true, action: { label: 'Show in folder', run: () => showInFiles(target) } });
    } catch (e) {
      savedLine.textContent = '';
      toast(`Couldn’t save: ${errText(e)}`, { error: true });
    } finally { busy = false; updateExportLabel(); }
  }

  const cleanup = () => {
    stopped = true; clearInterval(tick); engine?.stop(); engine = null;
    preview?.close(); preview = null;
    if (buffers) { clearTimeout(kept?.timer); kept = { key: songKey, buffers, length, timer: setTimeout(() => { kept = null; }, KEEP_MS) }; buffers = null; }
  };
  await modal({
    title: 'Stem separator', body, width: 560, className: 'stems-modal', closeOnBackdrop: false,
    buttons: [{ el: exportBtn }, { label: 'Close', value: null }],
    onClose: cleanup,
  });
}
