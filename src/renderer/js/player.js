// Dogfile Player: VLC-style media player.
// Plays natively with GPU decoding whenever Chromium can (H.264, HEVC*, VP9, AV1, AAC, MP3, Opus, FLAC…); otherwise
// the bundled ffmpeg remuxes (video copied, audio → AAC) or transcodes (GPU encoder when available) on the fly.
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, debounce, isMediaFile, KINDS, natCmp, fileUrl } from './core.js';
import { icon } from './icons.js';
import { initLicense } from './license.js';
import { showMenu } from './menu.js';
import { modal } from './dialogs.js';
import { applyColors, mediaSettings } from './theme.js';
function applyMediaTheme() {
  const dark = applyColors(mediaSettings(settings));
  if (!EMBED && sys?.platform === 'win32') api('win:overlay', dark ? { color: '#101012', symbolColor: '#c9cacc' } : { color: getComputedStyle(document.documentElement).getPropertyValue('--tabbar').trim() || '#efeff0', symbolColor: '#3a3a3a' });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyMediaTheme());
import { EMBED, pendingFiles, onHost, tellHost, showInFiles, setTitle, onWindowClose, onAsk } from './embed.js';
onWindowClose(async () => true);
import { analyzeAudio, cachedAnalysis } from './audio-analysis.js';

const $ = (id) => document.getElementById(id);
const v = $('v');
let sys = {}, settings = { ...DEFAULT_SETTINGS };
let prefs = { volume: 1, muted: false, eq: { on: false, preset: 'Flat', bands: Array(10).fill(0), preamp: 0 }, repeat: 'off', shuffle: false, subSize: 100, autoResume: 'ask', showList: false, speed: 1 };
let resume = {};
let listTouched = false;

const P = {
  list: [], idx: -1,
  item: null, info: null, vStream: null, aStreams: [], sStreams: [],
  mode: 'direct', offset: 0, duration: 0, audioIdx: 0, sub: null, subDelay: 0, subCues: [],
  ab: null, aspect: 'auto', zoom: 1, triedModes: new Set(), loadSeq: 0,
};

// ---------------- capabilities ----------------
const can = {
  hevc: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
  hevc10: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"'),
  av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"'),
  vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'),
};
const DIRECT_CONTAINERS = /(^|,)(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|ogg|mp3|flac|wav|aac)(,|$)/;
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
function videoOk(s) {
  if (!s) return true;
  const c = s.codec_name, tenBit = /10|12/.test(s.pix_fmt || '');
  if (c === 'h264') return !tenBit; // Hi10P has no GPU path in Chromium
  if (c === 'hevc') return tenBit ? can.hevc10 : can.hevc;
  if (c === 'vp9') return can.vp9;
  if (c === 'vp8' || c === 'theora') return true;
  if (c === 'av1') return can.av1;
  if (c === 'mjpeg' || c === 'png') return false;
  return false;
}
const audioOk = (s, fmt) => !s || DIRECT_AUDIO.has(s.codec_name) || (/^pcm_(s16le|s24le|f32le|u8)$/.test(s.codec_name) && /wav/.test(fmt));

function chooseMode(force) {
  const fmt = P.info?.format?.format_name || '';
  const vs = P.vStream, as = P.aStreams[P.audioIdx];
  if (!P.info) return force || 'direct';
  const vOK = videoOk(vs);
  if (force) return force;
  if (DIRECT_CONTAINERS.test(fmt) && vOK && audioOk(as, fmt) && P.audioIdx === 0) return 'direct';
  if (!sys.ffmpeg) return 'direct';
  if (vOK) return vs ? 'remux' : 'audio';
  return 'transcode';
}

// ---------------- loading ----------------
async function load(i, { startAt = null, autoplay = true } = {}) {
  if (i < 0 || i >= P.list.length) return;
  const seq = ++P.loadSeq;
  P.idx = i;
  const item = P.list[i];
  P.item = item;
  P.info = null; P.vStream = null; P.aStreams = []; P.sStreams = []; P.audioIdx = 0; P.sub = null; P.subCues = []; P.ab = null; P.triedModes = new Set();
  clearSubs();
  $('err').classList.remove('show');
  $('empty').style.display = 'none';
  setBusy(true);
  setTitle(`${item.name} - Dogfile Player`);
  $('pl-name').textContent = item.name;
  renderList();
  try { P.info = await api('media:probe', item.path); } catch (e) { P.info = null; }
  if (seq !== P.loadSeq) return;
  if (P.info) {
    const st = P.info.streams || [];
    P.vStream = st.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null;
    P.aStreams = st.filter((s) => s.codec_type === 'audio');
    P.sStreams = st.filter((s) => s.codec_type === 'subtitle');
    P.duration = parseFloat(P.info.format?.duration) || 0;
    // pick the default / preferred-language audio track
    const def = P.aStreams.findIndex((s) => s.disposition?.default);
    P.audioIdx = def > 0 ? def : 0;
    item.duration = P.duration;
    item.title = P.info.format?.tags?.title || P.info.format?.tags?.TITLE;
  } else P.duration = 0;
  // no details (the media engine couldn't read it): a video file is still a video
  const VIDEO_EXT = [...KINDS.video, 'mkv', 'm2ts', 'mts', 'vob', 'divx', 'f4v', 'asf', 'rmvb'];
  if (!P.vStream && (!P.info || !(P.info.streams || []).length) && VIDEO_EXT.includes((item.path.split('.').pop() || '').toLowerCase())) P.vStream = { codec_type: 'video', guessed: true };
  document.body.classList.toggle('audio-only', !P.vStream);
  document.body.classList.toggle('has-video', !!P.vStream);
  setupAudioView();
  $('edit-panel').classList.remove('open');
  if (TX.path !== item.path) $('tx-panel')?.classList.remove('open');
  tellHost({ type: 'state', kind: P.vStream ? 'video' : 'audio', path: item.path });
  if (!P.vStream) { $('av-tags').innerHTML = ''; showAnalysis(); }
  showLyrics();
  P.mode = chooseMode();
  // resume position
  let t = startAt ?? 0;
  const saved = resume[item.path];
  if (startAt == null && saved && P.duration > 300 && saved > 30 && saved < P.duration - 30) {
    if (prefs.autoResume === 'always') t = saved;
    else if (prefs.autoResume === 'ask') showResumeBanner(saved);
  }
  setSource(t, autoplay);
  autoSubs();
  renderList();
  renderButtons();
  persistListSoon();
}

function streamUrl(t) {
  const q = new URLSearchParams({ p: P.item.path, ss: String(t || 0), a: P.aStreams.length ? String(P.audioIdx) : 'none', v: P.mode === 'transcode' ? 'enc' : P.vStream ? 'copy' : 'none', vc: P.vStream?.codec_name || '' });
  return `${(sys.streamBase || '/')}media/stream?${q}`;
}

function setSource(t = 0, autoplay = true) {
  P.triedModes.add(P.mode);
  ensureAudioGraph();
  const wasRate = prefs.speed || 1;
  if (P.mode === 'direct') {
    P.offset = 0;
    v.src = fileUrl(P.item.path) + (P.item.bust ? `&b=${P.item.bust}` : '');
    if (t > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
  } else {
    P.offset = t;
    v.src = streamUrl(t);
  }
  v.playbackRate = wasRate;
  if (autoplay) v.play().catch(() => {});
  renderModeBadge();
  rebuildCues();
  if (P.mode === 'direct' && P.aStreams.length) scheduleSilenceCheck();
}

function fallback(reason) {
  const order = P.vStream ? ['direct', 'remux', 'transcode'] : ['direct', 'audio'];
  const next = order.find((m) => !P.triedModes.has(m) && (m !== 'remux' || videoOk(P.vStream)));
  if (!next || !sys.ffmpeg) { showError(reason); return; }
  const at = pos();
  P.mode = next;
  osd(next === 'transcode' ? 'Converting video on the fly…' : 'Converting audio on the fly…');
  setSource(at, true);
}

let silenceTimer = null;
function scheduleSilenceCheck() {
  clearTimeout(silenceTimer);
  const seq = P.loadSeq;
  silenceTimer = setTimeout(() => {
    if (seq !== P.loadSeq || P.mode !== 'direct' || v.paused) return;
    // Chromium silently drops unsupported audio (AC3/DTS/TrueHD in MKV/MP4): switch to the ffmpeg path
    if (v.webkitAudioDecodedByteCount === 0 && P.aStreams.length) fallback('No supported audio');
    else if (P.vStream && v.videoWidth === 0 && v.webkitVideoDecodedByteCount === 0) fallback('No supported video');
  }, 2200);
}

v.addEventListener('error', () => { if (!P.item) return; fallback(v.error?.message || 'This file could not be played'); });
v.addEventListener('waiting', () => setBusy(true));
v.addEventListener('playing', () => { setBusy(false); renderButtons(); });
v.addEventListener('canplay', () => setBusy(false));
v.addEventListener('pause', () => { renderButtons(); showControls(); saveResume(); });
v.addEventListener('play', () => { renderButtons(); hideControlsSoon(); });
v.addEventListener('loadedmetadata', () => {
  // the web view found a picture after all: show the video, not the music view
  if (v.videoWidth > 0 && !P.vStream) { P.vStream = { codec_type: 'video', width: v.videoWidth, height: v.videoHeight, guessed: true }; document.body.classList.remove('audio-only'); document.body.classList.add('has-video'); tellHost({ type: 'state', kind: 'video', path: P.item?.path }); }
  applyAspect(); renderTime();
});
v.addEventListener('timeupdate', () => {
  renderTime();
  if (P.ab && P.ab.b != null && pos() >= P.ab.b) seek(P.ab.a);
  saveResumeSoon();
  // remembered as watched / listened to (used by the "Unwatched videos" collection and the assistant)
  if (P.item && P.item._watched !== true && v.duration > 0 && (pos() / v.duration > 0.6 || v.duration - pos() < 60 && pos() > 30)) { P.item._watched = true; api('watched:add', P.item.path).catch(() => {}); }
});
v.addEventListener('ended', () => { if (P.item && !P.item._watched) { P.item._watched = true; api('watched:add', P.item.path).catch(() => {}); } });
v.addEventListener('ended', onEnded);

function onEnded() {
  if (P.item) delete resume[P.item.path];
  if (prefs.repeat === 'one') return seek(0, true);
  const n = nextIndex();
  if (n != null) load(n);
  else { renderButtons(); showControls(); }
}
function nextIndex(dir = 1) {
  if (!P.list.length) return null;
  if (prefs.shuffle && P.list.length > 1) { let r; do { r = Math.floor(Math.random() * P.list.length); } while (r === P.idx); return r; }
  const n = P.idx + dir;
  if (n >= 0 && n < P.list.length) return n;
  if (prefs.repeat === 'all') return (n + P.list.length) % P.list.length;
  return null;
}

// ---------------- time & seeking ----------------
const pos = () => (P.mode === 'direct' ? v.currentTime : P.offset + v.currentTime) || 0;
const dur = () => (P.mode === 'direct' && isFinite(v.duration) ? v.duration : P.duration) || 0;
function seek(t, play) {
  t = Math.max(0, Math.min(dur() ? dur() - 0.25 : t, t));
  const wasPaused = v.paused && !play;
  if (P.mode === 'direct') { v.currentTime = t; if (play) v.play(); }
  else {
    // inside the already-streamed window? just move; otherwise restart ffmpeg at the new point
    const rel = t - P.offset;
    const buf = v.buffered;
    let inside = false;
    for (let i = 0; i < buf.length; i++) if (rel >= buf.start(i) && rel <= buf.end(i) - 0.5) inside = true;
    if (inside) v.currentTime = rel;
    else { setSource(t, !wasPaused); }
    if (play) v.play();
  }
  renderTime();
  rebuildCues();
}
const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };

function renderTime() {
  const d = dur(), p = pos();
  $('time').textContent = `${fmt(p)} / ${fmt(d)}`;
  const pct = d ? Math.min(100, (p / d) * 100) : 0;
  $('seek').querySelector('.sk-fill').style.width = pct + '%';
  $('seek').querySelector('.sk-knob').style.left = pct + '%';
  // buffered (direct mode)
  let bufEnd = 0;
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) bufEnd = Math.max(bufEnd, v.buffered.end(i));
  $('seek').querySelector('.sk-buf').style.width = d ? Math.min(100, ((P.mode === 'direct' ? bufEnd : P.offset + bufEnd) / d) * 100) + '%' : '0';
  const ab = $('seek').querySelector('.sk-ab');
  if (P.ab && d) { ab.style.display = 'block'; ab.style.left = (P.ab.a / d) * 100 + '%'; ab.style.width = (((P.ab.b ?? P.ab.a) - P.ab.a) / d) * 100 + '%'; } else ab.style.display = 'none';
}

// seek bar interaction + thumbnail preview
(() => {
  const bar = $('seek'), tip = $('sk-tip'), thumb = $('sk-thumb'), tt = $('sk-time');
  let dragging = false, thumbTimer = null, lastThumb = -1;
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur(); };
  bar.addEventListener('mousemove', (e) => {
    const t = at(e), r = bar.getBoundingClientRect();
    tip.style.display = 'flex'; tt.textContent = fmt(t);
    tip.style.left = Math.max(70, Math.min(r.width - 70, e.clientX - r.left)) + 'px';
    const ch = (P.info?.chapters || []).find((c) => t >= +c.start_time && t < +c.end_time);
    tt.textContent = fmt(t) + (ch?.tags?.title ? ` · ${ch.tags.title}` : '');
    if (P.vStream && sys.ffmpeg && dur() > 0) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => { const k = Math.round(t / Math.max(2, dur() / 200)); if (k === lastThumb) return; lastThumb = k; thumb.src = `/media/thumb?p=${encodeURIComponent(P.item.path)}&t=${t.toFixed(1)}&w=240`; }, 90);
      thumb.style.display = 'block';
    } else thumb.style.display = 'none';
  });
  bar.addEventListener('mouseleave', () => { if (!dragging) tip.style.display = 'none'; });
  bar.addEventListener('mousedown', (e) => {
    dragging = true;
    const move = (ev) => { const t = at(ev); const d = dur(); if (d) { bar.querySelector('.sk-fill').style.width = (t / d) * 100 + '%'; bar.querySelector('.sk-knob').style.left = (t / d) * 100 + '%'; } $('time').textContent = `${fmt(t)} / ${fmt(d)}`; };
    const up = (ev) => { dragging = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); seek(at(ev)); tip.style.display = 'none'; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    move(e);
  });
})();

// ---------------- audio graph: volume boost to 200 %, 10-band EQ, visualizer ----------------
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], Rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5], Pop: [-1, 2, 4, 5, 3, 0, -1, -1, -1, -1],
  Jazz: [4, 3, 1, 2, -2, -2, 0, 1, 3, 4], Classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4], Dance: [6, 5, 2, 0, 0, -2, -2, -2, 0, 0],
  'Bass boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0], 'Treble boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7], Vocal: [-2, -3, -3, 1, 4, 4, 3, 1, 0, -2],
  Loudness: [6, 4, 0, 0, -2, 0, -1, -3, 5, 1], Headphones: [3, 6, 3, -2, -1, 1, 3, 6, 8, 9], 'Large hall': [6, 6, 3, 3, 0, -3, -3, -3, 0, 0], Party: [5, 5, 0, 0, 0, 0, 0, 0, 5, 5],
};
let AG = null;
function ensureAudioGraph() {
  if (AG) { if (AG.ctx.state === 'suspended') AG.ctx.resume(); return; }
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' }) // the least delay between picture and sound;
    const src = ctx.createMediaElementSource(v);
    const pre = ctx.createGain();
    const filters = BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0; return b; });
    const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.78;
    const vol = ctx.createGain();
    src.connect(pre); let node = pre; for (const f of filters) { node.connect(f); node = f; }
    node.connect(analyser); analyser.connect(vol); vol.connect(ctx.destination);
    AG = { ctx, pre, filters, analyser, vol };
    applyEq(); applyVolume();
  } catch (e) { console.warn('audio graph unavailable', e); AG = false; }
}
function applyVolume() {
  const vol = prefs.muted ? 0 : prefs.volume;
  if (AG) { v.volume = 1; AG.vol.gain.setTargetAtTime(vol, AG.ctx.currentTime, 0.015); } else v.volume = Math.min(1, vol);
  $('vol').querySelector('.vol-fill').style.width = (prefs.volume / 2) * 100 + '%';
  $('vol-txt').textContent = Math.round(prefs.volume * 100) + '%';
  $('b-mute').innerHTML = icon(prefs.muted || prefs.volume === 0 ? 'volMute' : prefs.volume < 0.5 ? 'volLow' : 'vol');
  savePrefs();
}
function setVolume(x, show = true) { prefs.volume = Math.max(0, Math.min(2, Math.round(x * 100) / 100)); prefs.muted = false; applyVolume(); if (show) osd(`Volume ${Math.round(prefs.volume * 100)}%`); }
function applyEq() {
  if (!AG) return;
  const on = prefs.eq.on;
  AG.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? prefs.eq.bands[i] : 0, AG.ctx.currentTime, 0.02));
  AG.pre.gain.setTargetAtTime(on ? Math.pow(10, (prefs.eq.preamp || 0) / 20) : 1, AG.ctx.currentTime, 0.02);
}

// visualizer (audio files)
function drawViz() {
  requestAnimationFrame(drawViz);
  if (!document.body.classList.contains('audio-only') || !AG || v.paused) return;
  const c = $('viz'), g = c.getContext('2d');
  const W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = c.clientHeight * devicePixelRatio);
  const data = new Uint8Array(AG.analyser.frequencyBinCount);
  AG.analyser.getByteFrequencyData(data);
  g.clearRect(0, 0, W, H);
  const n = 64, gap = 3 * devicePixelRatio, bw = (W - gap * (n - 1)) / n;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  for (let i = 0; i < n; i++) {
    const lo = Math.floor(Math.pow(i / n, 2) * data.length * 0.7), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 2) * data.length * 0.7));
    let m = 0; for (let k = lo; k < hi; k++) m = Math.max(m, data[k]);
    const bh = Math.max(2 * devicePixelRatio, (m / 255) * H);
    g.fillStyle = accent; g.globalAlpha = 0.35 + (m / 255) * 0.65;
    g.fillRect(i * (bw + gap), H - bh, bw, bh);
  }
  g.globalAlpha = 1;
}
requestAnimationFrame(drawViz);

function setupAudioView() {
  const tags = { ...(P.info?.format?.tags || {}) };
  const tg = (k) => tags[k] || tags[k.toUpperCase()] || tags[k[0].toUpperCase() + k.slice(1)];
  $('av-title').textContent = tg('title') || P.item.name.replace(/\.[^.]+$/, '');
  $('av-artist').textContent = tg('artist') || tg('album_artist') || '';
  $('av-album').textContent = [tg('album'), tg('date')].filter(Boolean).join(' · ');
  const art = $('art');
  art.style.display = 'none';
  const hasPic = (P.info?.streams || []).some((s) => s.disposition?.attached_pic);
  if (!P.vStream && hasPic && sys.ffmpeg) { art.onload = () => (art.style.display = 'block'); art.src = `/media/art?p=${encodeURIComponent(P.item.path)}${P.item.bust ? `&b=${P.item.bust}` : ''}`; }
  else if (!P.vStream) findFolderArt();
}
async function findFolderArt() {
  const dir = P.item.path.replace(/[\\/][^\\/]*$/, '');
  const r = await api('fs:list', dir).catch(() => ({ items: [] }));
  const pic = (r.items || []).find((i) => /^(cover|folder|front|album|albumart.*)\.(jpe?g|png|webp)$/i.test(i.name));
  if (pic) { const art = $('art'); art.onload = () => (art.style.display = 'block'); art.src = fileUrl(pic.path); }
}

// ---------------- subtitles ----------------
let track = null;
function clearSubs() { P.subCues = []; if (track) { for (const c of [...(track.cues || [])]) track.removeCue(c); track.mode = 'hidden'; } }
function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const ts = (s) => { const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); if (!m) return null; return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]); };
  for (const b of blocks) {
    const lines = b.split('\n');
    const li = lines.findIndex((l) => l.includes('-->'));
    if (li < 0) continue;
    const [a, z] = lines[li].split('-->');
    const s = ts(a), e = ts(z.split(' ').filter(Boolean)[0] || z);
    if (s == null || e == null) continue;
    cues.push({ s, e, t: lines.slice(li + 1).join('\n').replace(/<\/?c[^>]*>/g, '') });
  }
  return cues;
}
function rebuildCues() {
  if (!track) { track = v.addTextTrack('subtitles', 'Dogfile', 'en'); }
  for (const c of [...(track.cues || [])]) track.removeCue(c);
  if (!P.subCues.length) { track.mode = 'hidden'; return; }
  const off = (P.mode === 'direct' ? 0 : P.offset) - P.subDelay;
  for (const c of P.subCues) {
    const s = c.s - off, e = c.e - off;
    if (e <= 0) continue;
    try { const cue = new VTTCue(Math.max(0, s), e, c.t); cue.line = document.body.classList.contains('idle') ? -2 : -5; track.addCue(cue); } catch {}
  }
  track.mode = 'showing';
}
async function setSub(sel) {
  P.sub = sel;
  P.subCues = [];
  if (sel == null) { rebuildCues(); osd('Subtitles off'); renderButtons(); return; }
  const url = sel.file ? `/media/sub?p=${encodeURIComponent(sel.file)}` : `/media/sub?p=${encodeURIComponent(P.item.path)}&s=${sel.index}`;
  try {
    const txt = sel.file && /\.vtt$/i.test(sel.file) ? await (await fetch(fileUrl(sel.file))).text() : await (await fetch(url)).text();
    P.subCues = parseVtt(txt);
    if (!P.subCues.length) toast('That subtitle track has no text (image-based subtitles aren’t supported)', { error: true });
  } catch (e) { toast('Couldn’t load subtitles', { error: true }); }
  rebuildCues();
  osd(`Subtitles: ${sel.label}`);
  renderButtons();
}
const subLabel = (s, i) => [s.tags?.title, s.tags?.language?.toUpperCase(), s.codec_name === 'hdmv_pgs_subtitle' || s.codec_name === 'dvd_subtitle' ? '(image)' : ''].filter(Boolean).join(' · ') || `Track ${i + 1}`;
async function autoSubs() {
  // sidecar subtitles next to the video (movie.srt, movie.en.srt …)
  const item = P.item;
  const dir = item.path.replace(/[\\/][^\\/]*$/, '');
  const stem = item.name.replace(/\.[^.]+$/, '').toLowerCase();
  const r = await api('fs:list', dir).catch(() => ({ items: [] }));
  if (P.item !== item) return;
  item.sidecars = (r.items || []).filter((i) => /\.(srt|vtt|ass|ssa|sub)$/i.test(i.name) && i.name.toLowerCase().startsWith(stem)).map((i) => ({ file: i.path, label: i.name }));
  const forced = P.sStreams.findIndex((s) => s.disposition?.forced);
  if (item.sidecars.length && settings.playerAutoSubs !== false) setSub(item.sidecars[0]);
  else if (forced >= 0) setSub({ index: forced, label: subLabel(P.sStreams[forced], forced) });
  renderButtons();
}
function subMenu() {
  const items = [{ label: 'Off', radio: true, selected: !P.sub, run: () => setSub(null) }];
  P.sStreams.forEach((s, i) => items.push({ label: subLabel(s, i), radio: true, selected: P.sub && P.sub.index === i && !P.sub.file, run: () => setSub({ index: i, label: subLabel(s, i) }) }));
  for (const sc of P.item?.sidecars || []) items.push({ label: sc.label, radio: true, selected: P.sub?.file === sc.file, run: () => setSub(sc) });
  items.push({ separator: true },
    { label: 'Load subtitle file…', icon: 'folderOpen', run: async () => { const f = await api('dialog:openFiles', { title: 'Subtitle file', filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sub'] }] }); if (f[0]) { P.item.sidecars = [...(P.item.sidecars || []), { file: f[0], label: f[0].split(/[\\/]/).pop() }]; setSub(P.item.sidecars[P.item.sidecars.length - 1]); } } },
    { label: `Delay: ${P.subDelay >= 0 ? '+' : ''}${P.subDelay.toFixed(2)} s`, submenu: [
      { label: 'Earlier (−0.1 s)', keys: 'G', run: () => subDelay(-0.1) }, { label: 'Later (+0.1 s)', keys: 'H', run: () => subDelay(0.1) }, { label: 'Reset', run: () => subDelay(-P.subDelay) },
    ] },
    { label: 'Size', submenu: [75, 100, 125, 150, 200].map((n) => ({ label: n + '%', radio: true, selected: prefs.subSize === n, run: () => { prefs.subSize = n; applySubSize(); savePrefs(); } })) });
  return items;
}
function subDelay(d) { P.subDelay = Math.round((P.subDelay + d) * 100) / 100; rebuildCues(); osd(`Subtitle delay ${P.subDelay >= 0 ? '+' : ''}${P.subDelay.toFixed(2)} s`); }
function applySubSize() { document.documentElement.style.setProperty('--sub-size', (prefs.subSize / 100) * 2.6 + 'vh'); }
function cycleSubs() {
  const opts = [null, ...P.sStreams.map((s, i) => ({ index: i, label: subLabel(s, i) })), ...(P.item?.sidecars || [])];
  const cur = opts.findIndex((o) => (o == null && !P.sub) || (o && P.sub && (o.file ? o.file === P.sub.file : o.index === P.sub.index && !P.sub.file)));
  setSub(opts[(cur + 1) % opts.length]);
}

// ---------------- audio tracks ----------------
const audLabel = (s, i) => [s.tags?.title, s.tags?.language?.toUpperCase(), s.codec_name?.toUpperCase(), s.channel_layout || (s.channels ? s.channels + 'ch' : '')].filter(Boolean).join(' · ') || `Track ${i + 1}`;
function setAudio(i) {
  if (i === P.audioIdx) return;
  P.audioIdx = i;
  const t = pos();
  P.triedModes = new Set();
  P.mode = chooseMode();
  setSource(t, !v.paused);
  osd(`Audio: ${audLabel(P.aStreams[i], i)}`);
  renderButtons();
}
function audioMenu() {
  if (!P.aStreams.length) return [{ label: 'No audio tracks', disabled: true }];
  return P.aStreams.map((s, i) => ({ label: audLabel(s, i), radio: true, selected: P.audioIdx === i, run: () => setAudio(i) }));
}

// ---------------- view: aspect, zoom, fullscreen, OSD ----------------
const ASPECTS = ['auto', '16:9', '4:3', '21:9', '1:1', 'fill', 'crop'];
function applyAspect() {
  v.style.objectFit = P.aspect === 'fill' ? 'fill' : P.aspect === 'crop' ? 'cover' : 'contain';
  if (P.aspect.includes(':')) { const [a, b] = P.aspect.split(':').map(Number); v.style.aspectRatio = `${a} / ${b}`; v.style.objectFit = 'fill'; v.style.width = 'auto'; v.style.height = '100%'; v.style.maxWidth = '100%'; }
  else { v.style.aspectRatio = ''; v.style.width = '100%'; v.style.height = '100%'; }
  v.style.transform = P.zoom !== 1 ? `scale(${P.zoom})` : '';
}
function cycleAspect() { P.aspect = ASPECTS[(ASPECTS.indexOf(P.aspect) + 1) % ASPECTS.length]; applyAspect(); osd(`Aspect ratio: ${P.aspect}`); }
async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();
}
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('fs', !!document.fullscreenElement); $('b-full').innerHTML = icon(document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'); });

let osdT = null;
function osd(msg) { const o = $('osd'); o.textContent = msg; o.classList.add('show'); clearTimeout(osdT); osdT = setTimeout(() => o.classList.remove('show'), 1600); }
function flash(ic) { const c = $('center-flash'); c.innerHTML = icon(ic); c.classList.remove('go'); void c.offsetWidth; c.classList.add('go'); }
function setBusy(b) { $('busy').classList.toggle('show', b && !!P.item); }
function showError(msg) {
  setBusy(false);
  const e = $('err'); e.innerHTML = '';
  e.append(h('div', { class: 'err-title' }, 'Can’t play this file'), h('div', { class: 'err-msg' }, msg || ''), sys.ffmpeg ? null : h('div', { class: 'err-msg' }, 'The ffmpeg component is missing, so only natively supported formats can play.'),
    h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: () => api('shell:open', P.item.path) }, 'Open with Windows default app'), P.list.length > 1 ? h('button', { class: 'btn small', onclick: () => { const n = nextIndex(); if (n != null) load(n); } }, 'Skip to next') : null));
  e.classList.add('show');
}
function showResumeBanner(t) {
  const b = $('banner'); b.innerHTML = '';
  b.append(h('span', {}, `Continue from ${fmt(t)}?`), h('button', { class: 'btn small primary', onclick: () => { seek(t, true); b.classList.remove('show'); } }, 'Continue'), h('button', { class: 'btn small', onclick: () => b.classList.remove('show') }, 'Start over'));
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 9000);
}
function renderModeBadge() {
  const b = $('mode-badge');
  const enc = P.mode === 'transcode' ? 'GPU/CPU transcode' : P.mode === 'remux' ? 'Remux · video copied' : P.mode === 'audio' ? 'Audio converted' : 'Native · hardware decode';
  b.textContent = { direct: 'NATIVE', remux: 'REMUX', transcode: 'TRANSCODE', audio: 'CONVERT' }[P.mode] || '';
  b.title = enc;
  b.className = 'mode-' + P.mode;
}

// controls auto-hide
let hideT = null;
function showControls() { document.body.classList.remove('idle'); clearTimeout(hideT); cueLines(); }
// subtitles sit above the controls while they show, and drop to the bottom when they hide
function cueLines() {
  if (!track?.cues) return;
  const line = document.body.classList.contains('idle') ? -2 : -5;
  for (const c of track.cues) if (c.line !== line) c.line = line;
}
function hideControlsSoon() { clearTimeout(hideT); hideT = setTimeout(() => { if (!v.paused && !document.querySelector('.menu') && !$('eq-panel').classList.contains('open') && !$('edit-panel').classList.contains('open') && !document.body.classList.contains('audio-only')) { document.body.classList.add('idle'); cueLines(); } }, 2600); }
document.addEventListener('mousemove', () => { showControls(); if (!v.paused) hideControlsSoon(); });

// ---------------- playlist ----------------
async function setPlaylist(files, { play = true, autoPlaylist = false, append = false } = {}) {
  files = await expandPlaylists(files);
  let items = files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  let start = 0;
  if (autoPlaylist && files.length === 1) {
    const dir = files[0].replace(/[\\/][^\\/]*$/, '');
    const r = await api('fs:list', dir).catch(() => ({ items: [] }));
    const ext = files[0].split('.').pop().toLowerCase();
    const isVid = KINDS.video.includes(ext) || ['mkv', 'm2ts', 'mts', 'vob', 'ts'].includes(ext);
    const sib = (r.items || []).filter((i) => isMediaFile(i) && (KINDS.video.includes(i.ext) || ['mkv', 'm2ts', 'mts', 'vob', 'ts'].includes(i.ext)) === isVid).sort((a, b) => natCmp(a.name, b.name));
    if (sib.length > 1) { items = sib.map((i) => ({ path: i.path, name: i.name })); start = Math.max(0, items.findIndex((i) => i.path === files[0])); }
  }
  if (append) { const at = P.list.length; P.list.push(...items); renderList(); if (P.idx < 0 && play) load(at); return; }
  P.list = items;
  renderList();
  if (play && items.length) load(start);
}
async function expandPlaylists(files) {
  const out = [];
  for (const f of files) {
    if (/\.(m3u8?|pls)$/i.test(f)) {
      try {
        const r = await api('fs:readText', f, 2 * 1024 * 1024);
        const dir = f.replace(/[\\/][^\\/]*$/, '');
        for (let line of r.text.split(/\r?\n/)) {
          line = line.trim();
          if (/^File\d+=/i.test(line)) line = line.replace(/^File\d+=/i, '');
          else if (!line || line.startsWith('#') || /^\[|^\w+=/.test(line)) continue;
          out.push(/^([a-z]:[\\/]|\/|\\\\)/i.test(line) ? line : dir + (sys.sep || '\\') + line.replace(/[\\/]/g, sys.sep || '\\'));
        }
      } catch {}
    } else out.push(f);
  }
  return out;
}
function renderList() {
  const box = $('pl-items');
  $('pl-count').textContent = P.list.length ? `${P.idx + 1} / ${P.list.length}` : '';
  box.innerHTML = P.list.map((it, i) => `<div class="pl-item${i === P.idx ? ' cur' : ''}" data-i="${i}" draggable="false"><span class="pl-n">${i === P.idx ? icon(v.paused ? 'ppause' : 'pplay') : i + 1}</span><span class="pl-t" title="${esc(it.path)}">${esc(it.title || it.name)}</span><span class="pl-d">${it.duration ? fmt(it.duration) : ''}</span></div>`).join('') || '<div class="hint pad">Drop files here</div>';
  box.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}
$('pl-items').addEventListener('dblclick', (e) => { const r = e.target.closest('.pl-item'); if (r) load(+r.dataset.i); });
$('pl-items').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = e.target.closest('.pl-item'); if (!r) return;
  const i = +r.dataset.i, it = P.list[i];
  showMenu([
    { label: 'Play', icon: 'play', run: () => load(i) },
    { label: 'Remove from playlist', icon: 'close', run: () => { P.list.splice(i, 1); if (i < P.idx) P.idx--; else if (i === P.idx) { v.pause(); v.removeAttribute('src'); P.idx = -1; } renderList(); } },
    { label: 'Show in Dogfile', icon: 'folder', run: () => showInFiles(it.path) },
    { label: 'Copy path', icon: 'link', run: () => api('clip:writeText', it.path) },
  ], e.clientX, e.clientY);
});
let dragI = null;
$('pl-items').addEventListener('dragstart', (e) => { const r = e.target.closest('.pl-item'); dragI = r ? +r.dataset.i : null; e.dataTransfer.setData('text/x-pl', String(dragI)); });
$('pl-items').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-pl')) e.preventDefault(); });
$('pl-items').addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes('text/x-pl')) return;
  e.preventDefault(); e.stopPropagation();
  const r = e.target.closest('.pl-item'); if (!r || dragI == null) return;
  const to = +r.dataset.i; const [m] = P.list.splice(dragI, 1); P.list.splice(to, 0, m);
  if (P.idx === dragI) P.idx = to; else if (dragI < P.idx && to >= P.idx) P.idx--; else if (dragI > P.idx && to <= P.idx) P.idx++;
  renderList();
});
const persistListSoon = debounce(() => api('store:set', 'player-session', { list: P.list.map((x) => ({ path: x.path, name: x.name })), idx: P.idx }), 800);
async function savePlaylistFile() {
  const p = await api('dialog:saveFile', { title: 'Save playlist', defaultPath: 'Playlist.m3u8', filters: [{ name: 'Playlist', extensions: ['m3u8'] }] });
  if (!p) return;
  await api('fs:writeText', p, '#EXTM3U\n' + P.list.map((x) => `#EXTINF:${Math.round(x.duration || -1)},${x.title || x.name}\n${x.path}`).join('\n') + '\n');
  toast('Playlist saved');
}

// ---------------- buttons & menus ----------------
function renderButtons() {
  $('b-play').innerHTML = icon(v.paused || !P.item ? 'pplay' : 'ppause');
  $('b-stop').innerHTML = icon('pstop'); $('b-prev').innerHTML = icon('pprev'); $('b-next').innerHTML = icon('pnext');
  $('b-audio').innerHTML = icon('audioTrack'); $('b-audio').classList.toggle('dim', P.aStreams.length < 2);
  $('b-subs').innerHTML = icon('cc'); $('b-subs').classList.toggle('on', !!P.sub);
  $('b-lyrics').innerHTML = icon('lyrics'); $('b-lyrics').classList.toggle('on', !!prefs.lyrics); $('b-lyrics').hidden = !document.body.classList.contains('audio-only');
  $('b-eq').innerHTML = icon('sliders'); $('b-eq').classList.toggle('on', !!prefs.eq.on);
  $('b-loop').innerHTML = icon(prefs.repeat === 'one' ? 'repeatOne' : 'repeat'); $('b-loop').classList.toggle('on', prefs.repeat !== 'off');
  $('b-list').innerHTML = icon('listMusic'); $('b-list').classList.toggle('on', !!prefs.showList);
  $('b-more').innerHTML = icon('more');
  $('b-edit').innerHTML = icon('scissors'); $('b-edit').classList.toggle('dim', !P.item);
  $('b-full').innerHTML = icon(document.fullscreenElement ? 'fullscreenExit' : 'fullscreen');
  $('b-speed').textContent = (Math.round((prefs.speed || 1) * 100) / 100) + '×';
  $('pl-shuffle').innerHTML = icon('shuffle'); $('pl-shuffle').classList.toggle('on', !!prefs.shuffle);
  $('pl-add').innerHTML = icon('plus'); $('pl-more').innerHTML = icon('more');
  // on a narrow window the playlist floats over the video, so it only opens when you ask for it
  document.body.classList.toggle('show-list', !!prefs.showList && (innerWidth >= 640 || listTouched));
  renderList();
}
function togglePlay() { if (!P.item) { if (P.list.length) load(Math.max(0, P.idx)); else openFiles(); return; } if (v.paused) { v.play(); flash('pplay'); } else { v.pause(); flash('ppause'); } }
function stop() { v.pause(); saveResume(); seek(0); renderButtons(); }
function setSpeed(s) { prefs.speed = Math.max(0.25, Math.min(4, Math.round(s * 100) / 100)); v.playbackRate = prefs.speed; v.preservesPitch = true; osd(`Speed ${prefs.speed}×`); renderButtons(); savePrefs(); }
function cycleRepeat() { prefs.repeat = { off: 'all', all: 'one', one: 'off' }[prefs.repeat]; osd({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[prefs.repeat]); renderButtons(); savePrefs(); }
function frameStep(dir = 1) {
  const fps = (() => { const r = P.vStream?.avg_frame_rate || P.vStream?.r_frame_rate || '30/1'; const [a, b] = r.split('/').map(Number); return a && b ? a / b : 30; })();
  v.pause(); v.currentTime = Math.max(0, v.currentTime + dir / fps); osd(dir > 0 ? 'Next frame' : 'Previous frame');
}
function abLoop() {
  if (!P.ab) { P.ab = { a: pos(), b: null }; osd(`Loop A: ${fmt(P.ab.a)} . Press again to set B`); }
  else if (P.ab.b == null) { P.ab.b = Math.max(P.ab.a + 0.5, pos()); osd(`Looping ${fmt(P.ab.a)} → ${fmt(P.ab.b)}`); seek(P.ab.a); }
  else { P.ab = null; osd('A-B loop off'); }
  renderTime();
}
async function screenshot() {
  if (!P.vStream || !v.videoWidth) return toast('Nothing to capture');
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const dir = await api('media:shotDir');
  const name = `${P.item.name.replace(/\.[^.]+$/, '')} ${fmt(pos()).replace(/:/g, '-')}.png`;
  const p = `${dir}${sys.sep}${name}`;
  await api('fs:writeDataUrl', p, c.toDataURL('image/png'));
  toast(`Screenshot saved to ${dir}`, { action: { label: 'Show', run: () => showInFiles(p) } });
}
const frac = (r) => { const [a, b] = String(r || '').split('/').map(Number); return a && b ? a / b : 0; };
function mediaInfo() {
  if (!P.info) return toast('No media information');
  const f = P.info.format || {};
  const rows = [['File', P.item.path], ['Container', f.format_long_name || f.format_name], ['Duration', fmt(+f.duration)], ['Size', f.size ? (f.size / 1048576).toFixed(1) + ' MB' : ''], ['Bitrate', f.bit_rate ? Math.round(f.bit_rate / 1000) + ' kb/s' : ''], ['Playback', $('mode-badge').title]];
  for (const s of P.info.streams || []) {
    if (s.codec_type === 'video') rows.push([`Video #${s.index}`, `${s.codec_long_name || s.codec_name} · ${s.width}×${s.height} · ${s.pix_fmt || ''} · ${frac(s.avg_frame_rate) ? frac(s.avg_frame_rate).toFixed(2) + ' fps' : ''}${s.color_transfer === 'smpte2084' ? ' · HDR10' : s.color_transfer === 'arib-std-b67' ? ' · HLG' : ''}`]);
    if (s.codec_type === 'audio') rows.push([`Audio #${s.index}`, `${s.codec_long_name || s.codec_name} · ${s.channel_layout || s.channels + 'ch'} · ${s.sample_rate} Hz${s.tags?.language ? ' · ' + s.tags.language : ''}`]);
    if (s.codec_type === 'subtitle') rows.push([`Subtitle #${s.index}`, `${s.codec_name}${s.tags?.language ? ' · ' + s.tags.language : ''}${s.tags?.title ? ' · ' + s.tags.title : ''}`]);
  }
  for (const [k, val] of Object.entries(f.tags || {}).slice(0, 12)) rows.push([k, val]);
  modal({ title: 'Media information', width: 620, body: h('div', { class: 'kv' }, ...rows.filter((r) => r[1]).flatMap(([k, val]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(val))])), buttons: [{ label: 'Close', primary: true, value: true }] });
}
function moreMenu(x, y) {
  const fcmds = plFeatures?.commands() || [];
  showMenu([
    { label: 'Open files…', icon: 'folderOpen', keys: 'Ctrl+O', run: openFiles },
    { label: 'Features', icon: 'puzzle', submenu: () => [...fcmds.map((c) => ({ label: c.title, icon: c.icon || 'puzzle', run: () => c.run({}) })), fcmds.length && { separator: true }, { label: 'Add a feature in Notepad…', icon: 'plus', run: () => api('ext:install', { create: 'player' }) }, { label: 'Manage features…', icon: 'settings', run: () => api('ext:install', { manage: true }) }].filter(Boolean) },
    { label: 'Open folder…', icon: 'folder', run: openFolder },
    { separator: true },
    { label: 'Audio track', icon: 'audioTrack', submenu: audioMenu },
    { label: 'Subtitles', icon: 'cc', submenu: subMenu },
    { label: 'Speed', submenu: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4].map((s) => ({ label: s + '×', radio: true, selected: prefs.speed === s, run: () => setSpeed(s) })) },
    { label: 'Aspect ratio', submenu: ASPECTS.map((a) => ({ label: a === 'auto' ? 'Default' : a === 'fill' ? 'Stretch to fill' : a === 'crop' ? 'Crop to fill' : a, radio: true, selected: P.aspect === a, run: () => { P.aspect = a; applyAspect(); } })) },
    { label: 'Zoom', submenu: [1, 1.1, 1.25, 1.5, 2].map((z) => ({ label: Math.round(z * 100) + '%', radio: true, selected: P.zoom === z, run: () => { P.zoom = z; applyAspect(); } })) },
    { label: 'A-B repeat', keys: '\\', run: abLoop },
    { label: 'Jump to time…', keys: 'Ctrl+T', run: jumpTo },
    P.info?.chapters?.length && { label: 'Chapters', submenu: P.info.chapters.map((c, i) => ({ label: c.tags?.title || `Chapter ${i + 1}`, keys: fmt(+c.start_time), run: () => seek(+c.start_time, true) })) },
    { separator: true },
    { label: 'Edit / trim…', icon: 'scissors', keys: 'Ctrl+K', run: openEdit },
    { label: 'Transcript (speech to text)', icon: 'cc', keys: 'Alt+T', run: openTranscript },
    { label: 'Equalizer', icon: 'sliders', keys: 'Ctrl+E', run: () => $('b-eq').click() },
    { label: 'Playlist', icon: 'listMusic', keys: 'Ctrl+L', checked: !!prefs.showList, run: () => $('b-list').click() },
    { label: 'Repeat', icon: 'repeat', submenu: [['off', 'Off'], ['all', 'All'], ['one', 'One']].map(([k, l]) => ({ label: l, radio: true, selected: prefs.repeat === k, run: () => { prefs.repeat = k; renderButtons(); savePrefs(); } })) },
    { label: 'Volume', submenu: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((x) => ({ label: Math.round(x * 100) + '%', radio: true, selected: Math.abs(prefs.volume - x) < 0.01, run: () => setVolume(x) })) },
    !P.vStream && P.item && { label: 'Detect BPM & key', icon: 'music', run: () => showAnalysis(true) },
    !P.vStream && P.item && { label: 'Edit tags…', icon: 'tag', run: () => import('./tageditor.js').then((m) => m.openTagEditor([P.item.path])).then(() => { P.item.bust = Date.now(); setupAudioView(); }) },
    { label: 'Take screenshot', icon: 'camera', keys: 'Shift+S', run: screenshot },
    { label: 'Picture-in-picture', run: () => (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture().catch(() => toast('Picture-in-picture isn’t available for this video'))) },
    !EMBED && { label: 'Always on top', icon: 'pin', run: async () => { const on = await api('win:control', 'ontop'); osd(on ? 'Always on top' : 'Normal window'); } },
    { label: 'Media information', icon: 'info', keys: 'I', run: mediaInfo },
    { separator: true },
    { label: 'Resume playback', submenu: [['ask', 'Ask'], ['always', 'Always'], ['never', 'Never']].map(([k, l]) => ({ label: l, radio: true, selected: prefs.autoResume === k, run: () => { prefs.autoResume = k; savePrefs(); } })) },
    { label: 'Open with Windows default app', run: () => P.item && api('shell:open', P.item.path) },
    { label: 'Show in Dogfile', icon: 'folder', run: () => P.item && showInFiles(P.item.path) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', keys: 'F1', run: shortcutsHelp },
  ], x, y, { alignRight: true });
}
async function jumpTo() {
  const { prompt } = await import('./dialogs.js');
  const r = await prompt('Jump to time', fmt(pos()), { label: 'Time (h:mm:ss, mm:ss or seconds)' });
  if (!r) return;
  const t = r.split(':').reverse().reduce((a, x, i) => a + (+x || 0) * Math.pow(60, i), 0);
  seek(t, true);
}
function shortcutsHelp() {
  const keys = [['Space', 'Play / pause'], ['F / double-click', 'Fullscreen'], ['Esc', 'Exit fullscreen'], ['← / →', 'Back / forward 10 s'], ['Shift + ← / →', '3 s'], ['Ctrl + ← / →', '1 minute'], ['↑ / ↓ / wheel', 'Volume (up to 200 %)'], ['M', 'Mute'], ['N / P', 'Next / previous'], ['S', 'Stop'], ['[ / ] / =', 'Slower / faster / normal speed'], ['E / Shift+E', 'Next / previous frame'], ['B', 'Cycle audio track'], ['V', 'Cycle subtitles'], ['G / H', 'Subtitle delay − / +'], ['A', 'Cycle aspect ratio'], ['\\', 'A-B repeat'], ['L', 'Repeat mode'], ['Ctrl+T', 'Jump to time'], ['Shift+S', 'Screenshot'], ['I', 'Media information'], ['Ctrl+L', 'Playlist'], ['Ctrl+E', 'Equalizer'], ['Ctrl+O', 'Open files'], ['1 – 9', 'Jump to 10 % – 90 %']];
  modal({ title: 'Keyboard shortcuts', width: 460, body: h('div', { class: 'kv' }, ...keys.flatMap(([k, d]) => [h('div', { class: 'k' }, h('kbd', {}, k)), h('div', { class: 'v' }, d)])), buttons: [{ label: 'Close', primary: true, value: true }] });
}
async function openFiles() { const f = await api('dialog:openFiles', { title: 'Open media' }); if (f.length) setPlaylist(f, { play: true, autoPlaylist: f.length === 1 }); }
async function openFolder() {
  const d = await api('dialog:pickFolder', 'Open folder'); if (!d) return;
  const r = await api('fs:list', d);
  const files = (r.items || []).filter(isMediaFile).sort((a, b) => natCmp(a.name, b.name)).map((i) => i.path);
  if (files.length) setPlaylist(files); else toast('No media files in that folder');
}

// ---------------- equalizer panel ----------------
function renderEq() {
  const p = $('eq-panel');
  p.innerHTML = '';
  const on = h('input', { type: 'checkbox', class: 'switch' }); on.checked = prefs.eq.on;
  on.onchange = () => { prefs.eq.on = on.checked; applyEq(); savePrefs(); renderButtons(); };
  const preset = h('select', { class: 'input' }, ...Object.keys(EQ_PRESETS).map((k) => h('option', { value: k }, k)), h('option', { value: 'Custom' }, 'Custom'));
  preset.value = EQ_PRESETS[prefs.eq.preset] ? prefs.eq.preset : 'Custom';
  preset.onchange = () => { if (EQ_PRESETS[preset.value]) { prefs.eq.bands = [...EQ_PRESETS[preset.value]]; prefs.eq.preset = preset.value; prefs.eq.on = true; on.checked = true; applyEq(); savePrefs(); renderEq(); renderButtons(); } };
  const sliders = h('div', { class: 'eq-bands' });
  const mk = (label, val, set) => {
    const s = h('input', { type: 'range', min: '-12', max: '12', step: '0.5', value: String(val), orient: 'vertical' });
    const out = h('span', { class: 'eq-val' }, (val > 0 ? '+' : '') + val);
    s.oninput = () => { set(+s.value); out.textContent = (+s.value > 0 ? '+' : '') + s.value; prefs.eq.on = true; on.checked = true; applyEq(); savePrefs(); renderButtons(); };
    return h('div', { class: 'eq-band' }, out, s, h('span', { class: 'eq-f' }, label));
  };
  sliders.append(mk('Pre', prefs.eq.preamp || 0, (x) => (prefs.eq.preamp = x)));
  BANDS.forEach((f, i) => sliders.append(mk(f >= 1000 ? f / 1000 + 'k' : String(f), prefs.eq.bands[i], (x) => { prefs.eq.bands[i] = x; prefs.eq.preset = 'Custom'; preset.value = 'Custom'; })));
  p.append(...[h('div', { class: 'eq-head' }, h('b', {}, 'Equalizer'), h('label', { class: 'check' }, on, ' Enabled'), preset, h('button', { class: 'icon-btn small', title: 'Close', html: icon('close'), onclick: () => p.classList.remove('open') })), sliders,
    AG === false ? h('div', { class: 'hint' }, 'Audio effects are unavailable for this source.') : null].filter(Boolean));
}

// ---------------- edit: trim, remove / extract audio, convert ----------------
const ED = { a: 0, b: 0, mode: 'fast', format: 'same', removeAudio: false, normalize: false, job: null };
const AUDIO_OUT = ['mp3', 'm4a', 'flac', 'wav', 'ogg'];
function openEdit() {
  if (!P.item) return toast('Open a file first');
  if (!sys.ffmpeg) return toast('Editing needs the bundled ffmpeg component', { error: true });
  const d = dur();
  if (!ED.path || ED.path !== P.item.path) Object.assign(ED, { path: P.item.path, a: 0, b: d, format: 'same', removeAudio: false, normalize: false });
  $('eq-panel').classList.remove('open');
  renderEdit();
  $('edit-panel').classList.add('open');
  showControls();
}
function parseTime(s) { return String(s).trim().split(':').reverse().reduce((a, x, i) => a + (parseFloat(x) || 0) * Math.pow(60, i), 0); }
const fmtMs = (s) => { s = Math.max(0, s || 0); const ms = Math.round((s % 1) * 10); return fmt(s) + '.' + ms; };
function renderEdit() {
  const p = $('edit-panel');
  p.innerHTML = '';
  const d = dur() || ED.b || 0;
  const ext = (P.item.path.split('.').pop() || '').toLowerCase();
  const isAudio = !P.vStream;
  // trim bar
  const bar = h('div', { class: 'ed-bar' }, h('div', { class: 'ed-range' }), h('div', { class: 'ed-h a', title: 'Start' }), h('div', { class: 'ed-h b', title: 'End' }), h('div', { class: 'ed-play' }));
  const paint = () => {
    const pa = d ? (ED.a / d) * 100 : 0, pb = d ? (ED.b / d) * 100 : 100;
    bar.querySelector('.ed-range').style.left = pa + '%'; bar.querySelector('.ed-range').style.width = Math.max(0, pb - pa) + '%';
    bar.querySelector('.a').style.left = pa + '%'; bar.querySelector('.b').style.left = pb + '%';
    inA.value = fmtMs(ED.a); inB.value = fmtMs(ED.b); lenT.textContent = `Length ${fmtMs(Math.max(0, ED.b - ED.a))}`;
  };
  const tick = () => { if (!p.classList.contains('open')) return; bar.querySelector('.ed-play').style.left = (d ? (pos() / d) * 100 : 0) + '%'; requestAnimationFrame(tick); };
  bar.addEventListener('mousedown', (e) => {
    const r = bar.getBoundingClientRect();
    const t = () => Math.max(0, Math.min(d, ((e2.clientX - r.left) / r.width) * d));
    let e2 = e;
    const which = e.target.classList.contains('a') ? 'a' : e.target.classList.contains('b') ? 'b' : Math.abs(t() - ED.a) < Math.abs(t() - ED.b) ? 'a' : 'b';
    const move = (ev) => { e2 = ev; const v2 = t(); if (which === 'a') ED.a = Math.min(v2, ED.b - 0.1); else ED.b = Math.max(v2, ED.a + 0.1); paint(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); seek(which === 'a' ? ED.a : Math.max(ED.a, ED.b - 2)); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); move(e);
  });
  const inA = h('input', { class: 'input small ed-time', value: fmtMs(ED.a) });
  const inB = h('input', { class: 'input small ed-time', value: fmtMs(ED.b) });
  inA.onchange = () => { ED.a = Math.max(0, Math.min(parseTime(inA.value), ED.b - 0.1)); paint(); };
  inB.onchange = () => { ED.b = Math.min(d || Infinity, Math.max(parseTime(inB.value), ED.a + 0.1)); paint(); };
  const lenT = h('span', { class: 'ed-len' });
  const setBtn = (k) => h('button', { class: 'btn small', title: 'Use the current playback position', onclick: () => { const t = pos(); if (k === 'a') ED.a = Math.min(t, ED.b - 0.1); else ED.b = Math.max(t, ED.a + 0.1); paint(); } }, k === 'a' ? 'Set start [I]' : 'Set end [O]');
  const preview = h('button', { class: 'btn small', onclick: () => { P.ab = { a: ED.a, b: ED.b }; seek(ED.a, true); osd('Previewing the trimmed part'); } }, 'Preview');
  // options
  const fmtSel = h('select', { class: 'input small' },
    h('option', { value: 'same' }, `Same as original (.${ext})`),
    ...(isAudio ? [] : [h('option', { value: 'mp4' }, 'MP4 video'), h('option', { value: 'mkv' }, 'MKV video')]),
    ...AUDIO_OUT.map((x) => h('option', { value: x }, `${x.toUpperCase()} audio${isAudio ? '' : ' (extract)'}`)));
  fmtSel.value = ED.format;
  const modeSel = h('select', { class: 'input small' }, h('option', { value: 'fast' }, 'Fast (no re-encode, cuts on keyframes)'), h('option', { value: 'precise' }, 'Precise (re-encode, frame-accurate)'));
  modeSel.value = ED.mode;
  const noAudio = h('input', { type: 'checkbox', checked: ED.removeAudio });
  const norm = h('input', { type: 'checkbox', checked: ED.normalize });
  const sync = () => {
    ED.format = fmtSel.value; ED.mode = modeSel.value; ED.removeAudio = noAudio.checked; ED.normalize = norm.checked;
    const audioOut = AUDIO_OUT.includes(ED.format) || (ED.format === 'same' && isAudio);
    modeRow.style.display = audioOut ? 'none' : ''; noARow.style.display = audioOut ? 'none' : '';
    overBtn.disabled = ED.format !== 'same' && ED.format !== ext;
    overBtn.title = overBtn.disabled ? 'Overwrite needs the same format as the original' : 'Replace the original file';
  };
  fmtSel.onchange = modeSel.onchange = noAudio.onchange = norm.onchange = sync;
  const modeRow = h('label', { class: 'ed-opt' }, h('span', {}, 'Cut'), modeSel);
  const noARow = h('label', { class: 'check' }, noAudio, ' Remove audio');
  const prog = h('div', { class: 'ed-prog' }, h('div', { class: 'ed-prog-fill' }), h('span', { class: 'ed-prog-t' }));
  const copyBtn = h('button', { class: 'btn small primary', onclick: () => runExport(false, prog) }, 'Save as copy');
  const overBtn = h('button', { class: 'btn small', onclick: () => runExport(true, prog) }, 'Overwrite original');
  p.append(
    h('div', { class: 'eq-head' }, h('b', {}, 'Edit'), h('span', { class: 'ed-sub' }, P.item.name), h('button', { class: 'icon-btn small', title: 'Close', html: icon('close'), onclick: () => { p.classList.remove('open'); P.ab = null; renderTime(); } })),
    bar,
    h('div', { class: 'ed-row' }, h('span', { class: 'ed-lbl' }, 'Start'), inA, setBtn('a'), h('span', { class: 'ed-lbl' }, 'End'), inB, setBtn('b'), lenT, h('span', { class: 'ctl-spacer' }), preview, h('button', { class: 'btn small', onclick: () => { ED.a = 0; ED.b = d; paint(); } }, 'Reset')),
    h('div', { class: 'ed-row' }, h('label', { class: 'ed-opt' }, h('span', {}, 'Save as'), fmtSel), modeRow),
    h('div', { class: 'ed-row' }, noARow, h('label', { class: 'check' }, norm, ' Normalize loudness')),
    prog,
    h('div', { class: 'ed-row end' }, h('span', { class: 'hint' }, 'Fast cuts snap to the nearest keyframe. Use Precise for exact frames.'), h('span', { class: 'ctl-spacer' }), overBtn, copyBtn));
  paint(); sync(); tick();
}
async function runExport(overwrite, prog) {
  if (ED.job) return;
  const it = P.item;
  const ext = (it.path.split('.').pop() || '').toLowerCase();
  const outExt = ED.format === 'same' ? ext : ED.format;
  const dir = it.path.replace(/[\\/][^\\/]*$/, '');
  const stem = it.name.replace(/\.[^.]+$/, '');
  const trimmed = ED.a > 0.05 || ED.b < dur() - 0.05;
  let out;
  if (overwrite) {
    const { confirm } = await import('./dialogs.js');
    if (!(await confirm('Overwrite original?', `Replace <b>${esc(it.name)}</b> with the edited version? This can't be undone.`, { ok: 'Overwrite', danger: true }))) return;
    out = it.path;
  } else out = await api('fs:uniqueName', dir, `${stem} (${trimmed ? 'trimmed' : 'edited'}).${outExt}`, 'number');
  const resumeAt = Math.max(0, pos() - ED.a);
  if (overwrite) { v.pause(); v.removeAttribute('src'); v.load(); }
  const o = { src: it.path, out, start: ED.a > 0.05 ? ED.a : 0, end: ED.b < dur() - 0.05 ? ED.b : 0, duration: dur(), mode: ED.mode, removeAudio: ED.removeAudio, normalize: ED.normalize, overwrite, hasVideo: !!P.vStream, audioOnly: AUDIO_OUT.includes(outExt), audioTrack: P.audioIdx, convert: outExt !== ext };
  if (overwrite) { o.overwrite = true; }
  const fill = prog.querySelector('.ed-prog-fill'), txt = prog.querySelector('.ed-prog-t');
  prog.classList.add('on');
  let id;
  try { id = await api('media:export', o); } catch (e) { prog.classList.remove('on'); return toast(e.message, { error: true }); }
  ED.job = id;
  const cancel = h('button', { class: 'link', onclick: () => api('media:cancel', id) }, 'Cancel');
  txt.replaceChildren('Saving… ', cancel);
  const st = await new Promise((resolve) => {
    const iv = setInterval(async () => {
      const s = await api('media:job', id);
      if (!s) { clearInterval(iv); resolve({ error: 'Lost track of the job' }); return; }
      fill.style.width = s.pct.toFixed(1) + '%';
      if (s.done) { clearInterval(iv); resolve(s); }
    }, 300);
  });
  ED.job = null;
  prog.classList.remove('on'); fill.style.width = '0';
  if (st.error) { toast(st.error === 'Cancelled' ? 'Cancelled' : `Couldn't save: ${st.error}`, { error: st.error !== 'Cancelled' }); if (overwrite) load(P.idx, { startAt: resumeAt + ED.a }); return; }
  const name = out.split(/[\\/]/).pop();
  if (overwrite) { it.bust = Date.now(); ED.path = null; $('edit-panel').classList.remove('open'); P.ab = null; await load(P.idx, { startAt: Math.min(resumeAt, (ED.b - ED.a) - 1) }); toast('Saved'); }
  else toast(`Saved ${name}`, { action: { label: 'Play it', run: () => { P.list.splice(P.idx + 1, 0, { path: out, name }); load(P.idx + 1); } } });
  tellHost({ type: 'refresh', path: dir });
}

// ---------------- transcript: speech to text with Whisper (free, offline after a one-time download) ----------------
const TX = { path: null, chunks: [], busy: false };
const fmtTs = (s, ms) => { s = Math.max(0, s || 0); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), mm = Math.round((s % 1) * 1000); return ms ? `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(mm).padStart(3, '0')}` : (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
function toSrt(chunks) { return chunks.map((c, i) => `${i + 1}\n${fmtTs(c.start, true)} --> ${fmtTs(c.end ?? c.start + 3, true)}\n${c.text.trim()}\n`).join('\n'); }
async function openTranscript() {
  if (!P.item) return toast('Play something first');
  if (!sys.ffmpeg) return toast('Transcripts need the bundled ffmpeg component', { error: true });
  const panel = $('tx-panel');
  panel.classList.add('open');
  if (TX.path === P.item.path && TX.chunks.length) return renderTranscript();
  const ai = await import('./ai.js');
  const it = P.item;
  const st = await api('fs:stat', it.path).catch(() => null);
  const key = `${it.path}|${st?.size || 0}|${Math.round(st?.mtime || 0)}`;
  const cached = (await api('ai:cacheGet', 'whisper', [key]))[key];
  if (cached) { try { Object.assign(TX, { path: it.path, chunks: JSON.parse(cached) }); return renderTranscript(); } catch {} }
  renderTranscript('Getting ready…');
  if (!(await ai.ensureModels(['whisper']))) { renderTranscript('Transcripts need the free Whisper model.'); return; }
  TX.busy = true; TX.stop = false; TX.path = it.path; TX.chunks = [];
  const total = dur() || P.duration || 0;
  const SEG = 60; // one minute at a time: text appears as it goes and the progress keeps moving
  const t0 = Date.now();
  try {
    // the first piece is short, so the first words show up sooner
    for (let off = 0, seg = 20; off < Math.max(total, 1); off += seg, seg = SEG) {
      if (P.item !== it || TX.stop) break;
      const spent = (Date.now() - t0) / 1000;
      const left = off > 0 && total ? (spent / off) * (total - off) : null;
      renderTranscript(`Listening… ${fmt(off)} of ${fmt(total)}${left ? ` · about ${Math.ceil(left / 60)} min left` : ' · the first minute takes longest'}`);
      const r = await fetch(`/media/pcm?p=${encodeURIComponent(it.path)}&ss=${off}&t=${seg}&sr=16000`);
      if (!r.ok) break;
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 16000 * 4 * 0.5) break;
      const res = await ai.call({ type: 'transcribe', buffer: buf, language: prefs.txLang && prefs.txLang !== 'auto' ? prefs.txLang : 'english' }, [buf]);
      for (const c of res.chunks) TX.chunks.push({ start: (c.start ?? 0) + off, end: c.end != null ? c.end + off : null, text: c.text });
      renderTranscript();
      resyncAV();
      if (!total) break;
    }
    if (!TX.stop && P.item === it) api('ai:cacheSet', 'whisper', { [key]: JSON.stringify(TX.chunks) });
  } catch (e) { renderTranscript(`Couldn’t transcribe: ${e.message}`); }
  finally { TX.busy = false; renderTranscript(); resyncAV(); }
}
// Heavy work beside the video (the transcript's speech model) can leave the sound running behind the picture: the
// browser's audio path keeps the delay it built up. Jumping to the same moment empties it and puts them back together.
function resyncAV() {
  if (!P.item || v.paused || P.mode !== 'direct' || !v.duration) return;
  try { v.currentTime = v.currentTime; } catch {}
}
function renderTranscript(msg) {
  const panel = $('tx-panel');
  panel.innerHTML = '';
  const search = h('input', { class: 'input tx-search', placeholder: 'Search the transcript…', spellcheck: 'false' });
  const list = h('div', { class: 'tx-list' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const c of TX.chunks) {
      if (q && !c.text.toLowerCase().includes(q)) continue;
      const row = h('div', { class: 'tx-row' }, h('span', { class: 'tx-t' }, fmtTs(c.start)), h('span', { class: 'tx-x' }, c.text.trim()));
      row.onclick = () => seek(c.start, true);
      list.append(row);
    }
    if (!list.children.length && !msg) list.append(h('div', { class: 'hint pad' }, q ? 'No matches' : TX.busy ? '' : 'No speech found.'));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const lang = h('select', { class: 'input tx-lang', title: 'Spoken language' }, ...[['english', 'English'], ['spanish', 'Spanish'], ['french', 'French'], ['german', 'German'], ['italian', 'Italian'], ['portuguese', 'Portuguese'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['chinese', 'Chinese'], ['russian', 'Russian'], ['arabic', 'Arabic'], ['hindi', 'Hindi']].map(([v, l]) => h('option', { value: v }, l)));
  lang.value = prefs.txLang && prefs.txLang !== 'auto' ? prefs.txLang : 'english';
  lang.onchange = () => { prefs.txLang = lang.value; savePrefs(); };
  const has = TX.chunks.length > 0;
  panel.append(...[
    h('div', { class: 'eq-head' }, h('b', {}, 'Transcript'), lang, h('button', { class: 'icon-btn small', title: 'Close', html: icon('close'), onclick: () => panel.classList.remove('open') })),
    msg ? h('div', { class: 'tx-msg' }, TX.busy ? h('span', { class: 'av-spin' }) : null, msg, TX.busy ? h('button', { class: 'btn small', onclick: () => { TX.stop = true; renderTranscript('Stopping after this minute…'); } }, 'Stop') : null) : null,
    has ? search : null, list,
    h('div', { class: 'row-inline tx-actions' },
      h('button', { class: 'btn small', disabled: !has, onclick: () => { P.subCues = TX.chunks.map((c) => ({ s: c.start, e: c.end ?? c.start + 3, t: c.text.trim() })); P.sub = { label: 'Transcript', file: '' }; rebuildCues(); renderButtons(); osd('Showing transcript as subtitles'); } }, 'Show as subtitles'),
      h('button', { class: 'btn small', disabled: !has, onclick: async () => { const out = P.item.path.replace(/\.[^.\\/]+$/, '') + '.srt'; const exists = await api('fs:stat', out); const target = exists ? await api('fs:uniqueName', P.item.path.replace(/[\\/][^\\/]*$/, ''), P.item.name.replace(/\.[^.]+$/, '') + '.srt', 'number') : out; await api('fs:writeText', target, toSrt(TX.chunks)); toast(`Saved ${target.split(/[\\/]/).pop()}`); } }, 'Save .srt'),
      h('button', { class: 'btn small', disabled: !has, onclick: () => { api('clip:writeText', TX.chunks.map((c) => c.text.trim()).join(' ')); toast('Transcript copied'); } }, 'Copy text'),
      h('button', { class: 'btn small', disabled: TX.busy, onclick: async () => { const st = await api('fs:stat', P.item.path).catch(() => null); await api('ai:cacheSet', 'whisper', { [`${P.item.path}|${st?.size || 0}|${Math.round(st?.mtime || 0)}`]: '' }); TX.path = null; TX.chunks = []; openTranscript(); } }, 'Redo'))].filter(Boolean));
  draw();
}

// ---------------- lyrics ----------------
// The words of the song beside the cover, scrolling with it when they're timed (an .lrc file beside the song, words
// saved inside the file, or LRCLIB's free lyrics library, looked up by artist, title, album and length).
const LY = { path: null, lines: [], synced: false, cur: -1, userScroll: 0 };
function toggleLyrics() {
  prefs.lyrics = !prefs.lyrics; savePrefs(); renderButtons(); showLyrics();
  osd(prefs.lyrics ? 'Lyrics on' : 'Lyrics off');
}
function parseLrc(text) {
  const out = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function showLyrics(force = false) {
  const box = $('lyrics');
  const on = !!prefs.lyrics && document.body.classList.contains('audio-only') && !!P.item;
  document.body.classList.toggle('lyrics-on', on);
  if (!on) return;
  const it = P.item;
  if (LY.path === it.path && !force) return;
  LY.path = it.path; LY.lines = []; LY.cur = -1;
  box.innerHTML = '<div class="ly-msg">Looking for the words…</div>';
  const r = await api('media:lyrics', it.path, force).catch(() => null);
  if (P.item !== it) return;
  box.innerHTML = '';
  if (!r || !r.text) {
    const msg = r?.instrumental ? 'This one has no words (instrumental).' : r?.source === 'offline' ? 'Couldn’t reach the lyrics library. Check the internet connection.' : 'No words found for this song.';
    box.append(h('div', { class: 'ly-msg' }, msg), h('button', { class: 'btn small', onclick: () => showLyrics(true) }, 'Look again'), h('div', { class: 'ly-hint' }, 'Tip: put an .lrc file with the same name beside the song to use your own.'));
    return;
  }
  LY.synced = !!r.synced;
  LY.lines = LY.synced ? parseLrc(r.text) : r.text.replace(/\r/g, '').split('\n').map((x) => ({ t: null, text: x.replace(/\[[^\]]*\]/g, '').trim() }));
  for (const [i, l] of LY.lines.entries()) {
    const row = h('div', { class: 'ly-line' + (l.text ? '' : ' gap') }, l.text || '♪');
    if (LY.synced) row.onclick = () => { seek(l.t, true); LY.userScroll = 0; };
    row.dataset.i = i;
    box.append(row);
  }
  box.append(h('div', { class: 'ly-src' }, r.source === 'lrclib' ? 'Lyrics from LRCLIB' : r.source === 'tags' ? 'Lyrics saved in the file' : 'Lyrics from the .lrc file'));
  box.classList.toggle('synced', LY.synced);
  box.scrollTop = 0;
  syncLyrics();
}
function syncLyrics() {
  if (!document.body.classList.contains('lyrics-on') || !LY.lines.length) return;
  const box = $('lyrics');
  const now = pos();
  if (!LY.synced) {
    // plain words: drift down with the song, unless you've just scrolled yourself
    if (Date.now() - LY.userScroll > 5000 && dur() > 0) box.scrollTop = Math.max(0, (box.scrollHeight - box.clientHeight) * Math.min(1, now / dur()) - 0);
    return;
  }
  let i = -1;
  for (let k = 0; k < LY.lines.length; k++) { if (LY.lines[k].t <= now + 0.2) i = k; else break; }
  if (i === LY.cur) return;
  box.querySelector('.ly-line.cur')?.classList.remove('cur');
  LY.cur = i;
  const row = i >= 0 ? box.children[i] : null;
  row?.classList.add('cur');
  if (row && Date.now() - LY.userScroll > 4000) box.scrollTo({ top: row.offsetTop - box.clientHeight * 0.38, behavior: 'smooth' });
}
setTimeout(() => { const box = $('lyrics'); if (box) { box.addEventListener('wheel', () => { LY.userScroll = Date.now(); }, { passive: true }); box.addEventListener('touchmove', () => { LY.userScroll = Date.now(); }, { passive: true }); } }, 0);
v.addEventListener('timeupdate', syncLyrics);
v.addEventListener('seeked', () => { LY.cur = -2; syncLyrics(); });

// ---------------- BPM & key ----------------
async function showAnalysis(force = false) {
  const it = P.item; if (!it) return;
  const box = $('av-tags');
  box.innerHTML = '';
  const cached = !force && (await cachedAnalysis(it.path));
  const put = (a) => {
    if (P.item !== it) return;
    box.innerHTML = '';
    if (a.bpm) box.append(h('span', { class: 'av-chip', title: 'Tempo (beats per minute)' }, h('b', {}, String(Math.round(a.bpm))), ' BPM'));
    if (a.keyLabel) box.append(h('span', { class: 'av-chip', title: 'Musical key (Camelot wheel code for harmonic mixing)' }, h('b', {}, a.keyLabel), ` · ${a.camelot}`));
    if (a.rmsDb != null) box.append(h('span', { class: 'av-chip dim', title: 'Average loudness / peak level' }, `${a.rmsDb} dB RMS · peak ${a.peakDb} dB`));
    box.append(h('button', { class: 'av-chip link', title: 'Analyze again', onclick: () => showAnalysis(true) }, 'Re-analyze'));
    tellHost({ type: 'state', kind: 'audio', path: it.path, analysis: a });
  };
  if (cached) return put(cached);
  if (!sys.ffmpeg) return;
  box.append(h('span', { class: 'av-chip dim' }, h('span', { class: 'av-spin' }), 'Detecting BPM & key…'));
  try { put(await analyzeAudio(it.path, { force })); } catch (e) { if (P.item === it) box.innerHTML = `<span class="av-chip dim">${esc(e.message)}</span>`; }
}

// ---------------- persistence ----------------
const savePrefs = debounce(() => api('store:set', 'player-prefs', prefs), 400);
function saveResume() { if (!P.item || dur() < 300) return; const p = pos(); if (p > 30 && p < dur() - 30) resume[P.item.path] = Math.round(p); else delete resume[P.item.path]; const keys = Object.keys(resume); if (keys.length > 300) delete resume[keys[0]]; api('store:set', 'player-resume', resume); }
const saveResumeSoon = debounce(saveResume, 5000);

// ---------------- wiring ----------------
function wire() {
  $('b-play').onclick = togglePlay; $('b-stop').onclick = stop;
  $('b-prev').onclick = () => { if (pos() > 3) return seek(0); const n = nextIndex(-1); if (n != null) load(n); };
  $('b-next').onclick = () => { const n = nextIndex(1); if (n != null) load(n); };
  $('b-mute').onclick = () => { prefs.muted = !prefs.muted; applyVolume(); osd(prefs.muted ? 'Muted' : 'Unmuted'); };
  $('b-full').onclick = toggleFullscreen;
  $('b-speed').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4].map((s) => ({ label: s + '×', radio: true, selected: prefs.speed === s, run: () => setSpeed(s) })), r.left, r.top - 330); };
  $('b-audio').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(audioMenu(), r.left, r.top - 10 - Math.min(300, 32 * (P.aStreams.length || 1))); };
  $('b-lyrics').onclick = () => toggleLyrics();
  $('b-subs').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(subMenu(), r.left, r.top - 260); };
  $('b-eq').onclick = () => { renderEq(); $('edit-panel').classList.remove('open'); $('eq-panel').classList.toggle('open'); };
  $('b-edit').onclick = () => ($('edit-panel').classList.contains('open') ? $('edit-panel').classList.remove('open') : openEdit());
  $('b-loop').onclick = cycleRepeat;
  $('b-list').onclick = () => { listTouched = true; prefs.showList = !(prefs.showList && document.body.classList.contains('show-list')); savePrefs(); renderButtons(); };
  window.addEventListener('resize', debounce(renderButtons, 100));
  $('b-more').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); moreMenu(r.right, r.top - 500); };
  $('pl-shuffle').onclick = () => { prefs.shuffle = !prefs.shuffle; osd(prefs.shuffle ? 'Shuffle on' : 'Shuffle off'); savePrefs(); renderButtons(); };
  $('pl-add').onclick = async () => { const f = await api('dialog:openFiles', { title: 'Add to playlist' }); if (f.length) setPlaylist(f, { append: true }); };
  $('pl-more').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([
    { label: 'Add folder…', icon: 'folder', run: async () => { const d = await api('dialog:pickFolder', 'Add folder'); if (!d) return; const r2 = await api('fs:list', d); setPlaylist((r2.items || []).filter(isMediaFile).sort((a, b) => natCmp(a.name, b.name)).map((i) => i.path), { append: true }); } },
    { label: 'Sort by name', run: () => { const cur = P.list[P.idx]; P.list.sort((a, b) => natCmp(a.name, b.name)); P.idx = P.list.indexOf(cur); renderList(); } },
    { label: 'Save playlist…', run: savePlaylistFile },
    { label: 'Clear', icon: 'trash', run: () => { v.pause(); v.removeAttribute('src'); v.load(); P.list = []; P.idx = -1; P.item = null; renderList(); $('empty').style.display = ''; document.body.classList.remove('audio-only'); } },
  ], r.right, r.bottom + 4, { alignRight: true }); };
  $('em-open').onclick = openFiles; $('em-folder').onclick = openFolder;
  // volume slider (0 – 200 %)
  const vol = $('vol');
  const setFrom = (e) => { const r = vol.getBoundingClientRect(); setVolume(((e.clientX - r.left) / r.width) * 2, true); };
  vol.addEventListener('mousedown', (e) => { setFrom(e); const mv = (ev) => setFrom(ev); const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); });
  // stage
  const stage = $('stage');
  let clickT = null;
  stage.addEventListener('click', (e) => { if (e.target !== v && e.target.id !== 'audio-view' && !e.target.closest('#audio-view')) return; clearTimeout(clickT); clickT = setTimeout(togglePlay, 220); });
  stage.addEventListener('dblclick', (e) => { if (e.target.closest('#controls')) return; clearTimeout(clickT); toggleFullscreen(); });
  stage.addEventListener('wheel', (e) => { if (e.target.closest('#controls') && !e.target.closest('#vol')) return; e.preventDefault(); setVolume(prefs.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
  stage.addEventListener('contextmenu', (e) => { e.preventDefault(); moreMenu(e.clientX + 230, e.clientY); });
  // drag & drop
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('drop');
    const paths = [...e.dataTransfer.files].map((f) => window.atlas.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const subs = paths.filter((p) => /\.(srt|vtt|ass|ssa)$/i.test(p));
    if (subs.length && P.item) { P.item.sidecars = [...(P.item.sidecars || []), ...subs.map((f) => ({ file: f, label: f.split(/[\\/]/).pop() }))]; setSub(P.item.sidecars[P.item.sidecars.length - 1]); }
    const media = paths.filter((p) => !/\.(srt|vtt|ass|ssa)$/i.test(p));
    if (media.length) setPlaylist(media, { play: !e.target.closest('#playlist') || !P.list.length, append: !!e.target.closest('#playlist'), autoPlaylist: media.length === 1 && !e.target.closest('#playlist') });
  });
  // keyboard (VLC-style)
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.modal-back') || document.querySelector('.menu')) return;
    const k = e.key, c = e.ctrlKey || e.metaKey;
    const step = e.shiftKey ? 3 : c ? 60 : 10;
    let handled = true;
    if (k === ' ' || k === 'MediaPlayPause' || k === 'k') togglePlay();
    else if (k === 'ArrowRight') { seek(pos() + step); osd(`+${step} s`); }
    else if (k === 'ArrowLeft') { seek(pos() - step); osd(`−${step} s`); }
    else if (k === 'ArrowUp') setVolume(prefs.volume + 0.05);
    else if (k === 'ArrowDown') setVolume(prefs.volume - 0.05);
    else if (k === 'f' || k === 'F11' || (k === 'Enter' && e.altKey)) toggleFullscreen();
    else if (k === 'Escape' && document.fullscreenElement) document.exitFullscreen();
    else if (k === 'm') $('b-mute').click();
    else if (k === 'n' || k === 'MediaTrackNext') $('b-next').click();
    else if (k === 'p' || k === 'MediaTrackPrevious') $('b-prev').click();
    else if (k === 's' && !c) stop();
    else if (k === 'S' && e.shiftKey) screenshot();
    else if (k === '[' || k === '-') setSpeed((prefs.speed || 1) - 0.1);
    else if (k === ']' || k === '+') setSpeed((prefs.speed || 1) + 0.1);
    else if (k === '=') setSpeed(1);
    else if (k === 'e') frameStep(1);
    else if (k === 'E') frameStep(-1);
    else if (k === 'b') { if (P.aStreams.length > 1) setAudio((P.audioIdx + 1) % P.aStreams.length); else osd('Only one audio track'); }
    else if (k === 'v') cycleSubs();
    else if (k === 'y') toggleLyrics();
    else if (k === 'g') subDelay(-0.1);
    else if (k === 'h') subDelay(0.1);
    else if (k === 'a' && !c) cycleAspect();
    else if (k === '\\') abLoop();
    else if (k === 'l' && !c) cycleRepeat();
    else if (e.altKey && k.toLowerCase() === 't') openTranscript();
    else if (k === 'i' && $('edit-panel').classList.contains('open')) { ED.a = Math.min(pos(), ED.b - 0.1); renderEdit(); }
    else if (k === 'o' && $('edit-panel').classList.contains('open')) { ED.b = Math.max(pos(), ED.a + 0.1); renderEdit(); }
    else if (c && k.toLowerCase() === 'k') openEdit();
    else if (k === 'i') mediaInfo();
    else if (k === 't' && !c) osd(`${fmt(pos())} / ${fmt(dur())}`);
    else if (c && k.toLowerCase() === 't') jumpTo();
    else if (c && k.toLowerCase() === 'o') openFiles();
    else if (c && k.toLowerCase() === 'l') $('b-list').click();
    else if (c && k.toLowerCase() === 'e') $('b-eq').click();
    else if (k === 'F1' || k === '?') shortcutsHelp();
    else if (/^[0-9]$/.test(k) && !c && dur()) seek((dur() * +k) / 10);
    else handled = false;
    if (handled) { e.preventDefault(); showControls(); if (!v.paused) hideControlsSoon(); }
  });
  navigator.mediaSession?.setActionHandler?.('nexttrack', () => $('b-next').click());
  navigator.mediaSession?.setActionHandler?.('previoustrack', () => $('b-prev').click());
}

// ---------------- boot ----------------
// ---------------- features (user-made player tools) ----------------
let plFeatures = null;
async function startPlayerFeatures() {
  const X = await import('./extensions.js');
  plFeatures = X.startFeatures({
    target: 'player', getSettings: () => settings,
    provide: {
      'player.currentFile': () => P.item?.path || '', 'player.play': () => { v.play(); return true; }, 'player.pause': () => { v.pause(); return true; },
      'player.seek': (t) => { seek(Math.max(0, +t || 0)); return true; }, 'player.time': () => pos(), 'player.duration': () => P.duration || (Number.isFinite(v.duration) ? v.duration : 0),
    },
  });
}
export function playerFeatureMenu(x, y) {
  const cmds = plFeatures?.commands() || [];
  showMenu([...(cmds.length ? [{ header: 'Your features' }, ...cmds.map((c) => ({ label: c.title, icon: c.icon || 'puzzle', run: () => c.run({}) })), { separator: true }] : []),
    { label: 'Add a feature in Notepad…', icon: 'plus', run: () => api('ext:install', { create: 'player' }) }, { label: 'Manage features…', icon: 'settings', run: () => api('ext:install', { manage: true }) }], x, y);
}

async function boot() {
  sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  const [st, pr, rs, sess] = await Promise.all([api('store:get', 'settings'), api('store:get', 'player-prefs'), api('store:get', 'player-resume'), api('store:get', 'player-session')]);
  if ((st?.language || 'auto') !== 'en') import('./i18n.js').then((m) => m.initI18n(st?.language || 'auto')).catch(() => {});
  settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  prefs = { ...prefs, ...(pr || {}), eq: { ...prefs.eq, ...((pr && pr.eq) || {}) } };
  resume = rs || {};
  applyMediaTheme();
  applySubSize();
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  wire();
  applyVolume();
  renderButtons();
  const pending = await pendingFiles();
  if (pending?.files?.length) await setPlaylist(pending.files, { play: pending.play !== false, autoPlaylist: !!pending.autoPlaylist });
  else if (sess?.list?.length) { P.list = sess.list; P.idx = -1; renderList(); }
  document.body.classList.add('ready');
}
onMain('player:open', ({ files, play, autoPlaylist }) => setPlaylist(files, { play: play !== false, autoPlaylist: !!autoPlaylist }));
onMain('settings:changed', (s) => { settings = { ...settings, ...s }; applyMediaTheme(); plFeatures?.reload(); });
onHost({
  open: (m) => setPlaylist(m.files || [], { play: m.play !== false && !m.append, autoPlaylist: !!m.autoPlaylist, append: !!m.append }),
  settings: (s) => { settings = { ...settings, ...s }; applyMediaTheme(); plFeatures?.reload(); },
  cmd: (id) => ({
    transcript: openTranscript,
    tags: () => P.item && import('./tageditor.js').then((m) => m.openTagEditor([P.item.path])).then(() => { P.item.bust = Date.now(); setupAudioView(); }),
    play: togglePlay, stop, next: () => $('b-next').click(), prev: () => $('b-prev').click(), edit: openEdit, analyze: () => showAnalysis(true), fullscreen: toggleFullscreen,
    screenshot, info: mediaInfo, eq: () => $('b-eq').click(), list: () => $('b-list').click(), shuffle: () => $('pl-shuffle').click(), loop: cycleRepeat, ab: abLoop,
    extract: () => { openEdit(); ED.format = 'mp3'; renderEdit(); }, speedUp: () => setSpeed((prefs.speed || 1) + 0.1), speedDown: () => setSpeed((prefs.speed || 1) - 0.1),
  }[id]?.()),
});
// the assistant: "louder", "play at 1.5x", "skip 30 seconds", "go to 2:15", "mute"
onAsk(async (op, a = {}) => {
  if (op === 'context') return { ok: true, name: P.item?.name || '', path: P.item?.path || '', kind: P.item ? (v.videoWidth ? 'video' : 'audio') : '', playing: !v.paused, pos: pos(), dur: dur() };
  if (!P.item && !['play', 'open'].includes(op)) return { ok: false, msg: 'Nothing is playing' };
  switch (op) {
    case 'volume': setVolume(a.set != null ? a.set / 100 : (prefs.volume ?? 1) + (a.delta || 0) / 100); return { ok: true, msg: `Volume ${Math.round(prefs.volume * 100)}%` };
    case 'mute': prefs.muted = a.on !== false; applyVolume(); osd(prefs.muted ? 'Muted' : 'Unmuted'); return { ok: true, msg: prefs.muted ? 'Muted' : 'Unmuted' };
    case 'speed': setSpeed(a.set ?? (prefs.speed || 1) + (a.delta || 0)); return { ok: true, msg: `Speed ${prefs.speed}×` };
    case 'seek': { const d = dur(); let t = a.to != null ? a.to : pos() + (a.by || 0); if (a.pct != null) t = (d * a.pct) / 100; t = Math.max(0, d ? Math.min(d - 0.5, t) : t); seek(t); const f = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`; return { ok: true, msg: `At ${f(t)}${d ? ` of ${f(d)}` : ''}` }; }
    case 'pause': if (!v.paused) togglePlay(); return { ok: true, msg: 'Paused' };
    case 'resume': if (v.paused) togglePlay(); return { ok: true, msg: 'Playing' };
    case 'open': openFiles(); return { ok: true, msg: 'Choose what to play' };
    // "set an A-B loop between 0:45 and 1:10"
    case 'ab': if (a.a != null) { const b = a.b != null ? a.b : Math.min(dur(), a.a + 10); P.ab = { a: a.a, b: Math.max(a.a + 0.5, b) }; seek(P.ab.a); renderTime(); osd(`Looping ${fmt(P.ab.a)} → ${fmt(P.ab.b)}`); return { ok: true, msg: `Looping ${fmt(P.ab.a)} → ${fmt(P.ab.b)}` }; } break;
    case 'abOff': P.ab = null; renderTime(); return { ok: true, msg: 'A-B loop off' };
    // "delay the subtitles by 500 ms" (positive = later)
    case 'subDelay': { if (a.set != null) P.subDelay = 0; subDelay(a.set != null ? a.set : a.by || 0); return { ok: true, msg: `Subtitle delay ${P.subDelay >= 0 ? '+' : ''}${P.subDelay.toFixed(2)} s${P.sub == null && !P.subCues.length ? ' (turn subtitles on to see it)' : ''}` }; }
    // "trim from 1:15 to 4:30 (fast / lossless)": opens Edit with the part chosen; save = make the file now
    case 'trim': {
      if (!sys.ffmpeg) return { ok: false, msg: 'Trimming needs the bundled ffmpeg component' };
      openEdit();
      const d = dur();
      ED.a = Math.max(0, Math.min(d, a.from || 0)); ED.b = a.to ? Math.max(ED.a + 0.2, Math.min(d || a.to, a.to)) : d;
      ED.mode = a.mode === 'precise' ? 'precise' : 'fast';
      renderEdit();
      if (a.save) { runExport(false, document.querySelector('#edit-panel .ed-prog')); return { ok: true, msg: `Saving ${fmt(ED.a)} → ${fmt(ED.b)} as a new file (${ED.mode === 'fast' ? 'fast, no re-encode' : 'precise'})` }; }
      return { ok: true, msg: `Trim ${fmt(ED.a)} → ${fmt(ED.b)} is ready in Edit. Press Save copy` };
    }
  }
  const c = { play: togglePlay, stop, next: () => $('b-next').click(), prev: () => $('b-prev').click(), edit: openEdit, analyze: () => showAnalysis(true), fullscreen: toggleFullscreen, screenshot, info: mediaInfo, eq: () => $('b-eq').click(), list: () => $('b-list').click(), shuffle: () => $('pl-shuffle').click(), loop: cycleRepeat, ab: abLoop, transcript: openTranscript, extract: () => { openEdit(); ED.format = 'mp3'; renderEdit(); } }[op];
  if (!c) return { ok: false, msg: `I can’t do “${op}” in the player` };
  await c();
  return { ok: true };
});
window.addEventListener('beforeunload', () => saveResume());
window.__pl = { P, ED, TX, openTranscript, openEdit, runExport, showAnalysis, v, load, seek, setAudio, setSub, pos, dur, get AG() { return AG; }, prefs };
boot().then(() => { initLicense({ test: true }); return startPlayerFeatures(); }).catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#f66">${esc(e.stack || e.message)}</pre>`; });
