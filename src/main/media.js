// Atlas Player media engine.
// Chromium (with GPU decoding) plays H.264 / HEVC* / VP9 / AV1 / AAC / MP3 / Opus / FLAC directly. Everything else
// (AC3/DTS/TrueHD audio, MPEG-2, VC-1, DivX, WMV, WMA, APE, …) is remuxed or transcoded on the fly by a bundled
// ffmpeg and streamed as fragmented MP4 over atlas://media/…: the video stream is copied whenever possible, so 4K
// stays on the GPU and only the audio is converted.
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
let ffDir;
function findFF() {
  if (ffDir !== undefined) return ffDir;
  const cands = [
    process.env.ATLAS_FFMPEG_DIR,
    process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg'),
    path.join(app.getAppPath(), 'vendor', 'ffmpeg', process.platform),
    path.join(app.getAppPath(), '..', 'vendor', 'ffmpeg', process.platform),
  ].filter(Boolean);
  ffDir = cands.find((d) => fs.existsSync(path.join(d, 'ffmpeg' + EXE))) || null;
  return ffDir;
}
const ffmpeg = () => (findFF() ? path.join(findFF(), 'ffmpeg' + EXE) : 'ffmpeg');
const ffprobe = () => (findFF() ? path.join(findFF(), 'ffprobe' + EXE) : 'ffprobe');

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(ffprobe(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { windowsHide: true, maxBuffer: 32 << 20, timeout: 20000 }, (err, out) => {
      if (err) return reject(new Error('Could not read media: ' + (err.message || '').split('\n')[0]));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

// ---- pick the best H.264 encoder once (GPU first) ----
let encoderP = null;
function bestEncoder() {
  if (encoderP) return encoderP;
  const order = IS_WIN ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'] : ['h264_nvenc', 'h264_vaapi', 'libx264'];
  encoderP = (async () => {
    for (const enc of order) {
      if (enc === 'h264_vaapi') continue;
      const ok = await new Promise((r) => {
        const p = spawn(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:d=0.2', '-c:v', enc, '-f', 'null', '-'], { windowsHide: true });
        const t = setTimeout(() => { try { p.kill(); } catch {} r(false); }, 8000);
        p.on('error', () => { clearTimeout(t); r(false); });
        p.on('close', (c) => { clearTimeout(t); r(c === 0); });
      });
      if (ok) return enc;
    }
    return 'libx264';
  })();
  return encoderP;
}
function encArgs(enc) {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'll', '-rc', 'vbr', '-cq', '21', '-b:v', '0'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '22'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'];
    case 'h264_mf': return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-b:v', '14M'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  }
}

const procs = new Set();
function killAll() { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } procs.clear(); }

function streamProcess(args) {
  const p = spawn(ffmpeg(), args, { windowsHide: true });
  procs.add(p);
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  p.on('close', () => procs.delete(p));
  p.on('error', () => procs.delete(p));
  const body = new ReadableStream({
    start(c) {
      p.stdout.on('data', (d) => { try { c.enqueue(new Uint8Array(d)); } catch {} });
      p.stdout.on('end', () => { try { c.close(); } catch {} });
      p.on('error', (e) => { try { c.error(e); } catch {} });
    },
    cancel() { try { p.kill('SIGKILL'); } catch {} },
  });
  return { p, body, getErr: () => err };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

async function handle(req) {
  const u = new URL(req.url);
  const file = u.searchParams.get('p');
  const route = u.pathname.replace(/^\/+/, '');
  if (!file) return new Response('missing', { status: 400 });

  if (route === 'stream') {
    const ss = parseFloat(u.searchParams.get('ss') || '0') || 0;
    const a = u.searchParams.get('a'); // audio stream index (relative) or 'none'
    const vmode = u.searchParams.get('v') || 'copy'; // copy | enc | none
    const vcodec = u.searchParams.get('vc') || '';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    let enc = null;
    if (vmode === 'enc') { enc = await bestEncoder(); args.push('-hwaccel', 'auto'); }
    if (ss > 0) args.push('-ss', String(ss));
    args.push('-i', file);
    if (vmode !== 'none') args.push('-map', '0:V:0?');
    if (a !== 'none') args.push('-map', `0:a:${a || 0}?`);
    args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
    if (vmode === 'copy') { args.push('-c:v', 'copy'); if (vcodec === 'hevc') args.push('-tag:v', 'hvc1'); }
    else if (vmode === 'enc') {
      args.push(...encArgs(enc));
      const soft = enc === 'libx264';
      // keep 4K on GPU encoders; cap software transcodes to 1080p so playback never stutters
      args.push('-vf', soft ? "scale='min(1920,iw)':-2:flags=fast_bilinear,format=yuv420p" : 'format=yuv420p');
      args.push('-g', '60', '-bf', '0');
    }
    if (a !== 'none') args.push('-c:a', 'aac', '-b:a', '384k', '-af', 'aresample=async=1:first_pts=0');
    args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-max_muxing_queue_size', '4096', 'pipe:1');
    const { body } = streamProcess(args);
    return new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': vmode === 'none' ? 'audio/mp4' : 'video/mp4' } });
  }

  if (route === 'sub') {
    // embedded subtitle stream (relative index) or an external subtitle file -> WebVTT
    const s = u.searchParams.get('s');
    const ext = path.extname(file).toLowerCase();
    if (ext === '.vtt') return new Response(fs.readFileSync(file), { headers: { ...CORS, 'Content-Type': 'text/vtt' } });
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-sub_charenc', 'UTF-8', '-i', file];
    if (s != null && s !== '') args.push('-map', `0:s:${s}`);
    args.push('-f', 'webvtt', 'pipe:1');
    // external .srt files are often in legacy encodings: let ffmpeg auto-detect by dropping -sub_charenc for them
    if (s == null || s === '') args.splice(args.indexOf('-sub_charenc'), 2);
    const out = await runBuffer(args, 60000);
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'text/vtt; charset=utf-8' } });
  }

  if (route === 'art') {
    const out = await runBuffer(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=600:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], 15000).catch(() => null);
    if (!out || !out.length) return new Response('', { status: 404, headers: CORS });
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' } });
  }

  if (route === 'still') {
    // decode any image ffmpeg understands (TIFF, PSD, some HEIF/RAW…) to PNG for the photo viewer
    const out = await runBuffer(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'], 30000).catch(() => null);
    if (!out || !out.length) return new Response('', { status: 404, headers: CORS });
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' } });
  }

  if (route === 'pcm') {
    // mono 22.05 kHz float PCM for BPM / key analysis (up to 6 minutes, skipping a short intro)
    const ss = parseFloat(u.searchParams.get('ss') || '0') || 0;
    const t = parseFloat(u.searchParams.get('t') || '360') || 360;
    const sr = [16000, 22050, 44100, 48000].includes(+u.searchParams.get('sr')) ? u.searchParams.get('sr') : '22050';
    const out = await runBuffer(['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-ac', '1', '-ar', sr, '-f', 'f32le', 'pipe:1'], 120000).catch(() => null);
    if (!out || !out.length) return new Response('', { status: 404, headers: CORS });
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'application/octet-stream' } });
  }

  if (route === 'wave') { // waveform picture of a song (gallery mode)
    const w = Math.min(1600, parseInt(u.searchParams.get('w') || '600', 10)), hh = Math.min(600, parseInt(u.searchParams.get('h') || '200', 10));
    const col = /^[0-9a-fA-F]{6}$/.test(u.searchParams.get('c') || '') ? u.searchParams.get('c') : '3b82f6';
    const out = await runBuffer(['-hide_banner', '-loglevel', 'error', '-nostdin', '-t', '600', '-i', file, '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${w}x${hh}:colors=0x${col}:scale=sqrt`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'], 20000).catch(() => null);
    if (!out || !out.length) return new Response('', { status: 404, headers: CORS });
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' } });
  }
  if (route === 'thumb') {
    const t = Math.max(0, parseFloat(u.searchParams.get('t') || '0') || 0);
    const w = parseInt(u.searchParams.get('w') || '200', 10);
    const out = await runBuffer(['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'], 10000).catch(() => null);
    if (!out || !out.length) return new Response('', { status: 404, headers: CORS });
    return new Response(out, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=600' } });
  }
  return new Response('not found', { status: 404 });
}

function runBuffer(args, timeout) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), args, { windowsHide: true });
    const chunks = [];
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout);
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', () => { clearTimeout(t); resolve(Buffer.concat(chunks)); });
  });
}

async function screenshotTo(dir) {
  const d = dir || path.join(app.getPath('pictures'), 'Atlas Screenshots');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------------- export jobs: trim, remove/extract audio, convert ----------------
const jobs = new Map();
let jobSeq = 0;
const AUDIO_CODECS = { mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], m4a: ['-c:a', 'aac', '-b:a', '256k'], aac: ['-c:a', 'aac', '-b:a', '256k'], flac: ['-c:a', 'flac'], wav: ['-c:a', 'pcm_s16le'], ogg: ['-c:a', 'libvorbis', '-q:a', '6'], opus: ['-c:a', 'libopus', '-b:a', '160k'] };
async function exportMedia(o) {
  const id = ++jobSeq;
  const outExt = path.extname(o.out).slice(1).toLowerCase();
  const audioOnly = !!AUDIO_CODECS[outExt] && (o.audioOnly || !o.hasVideo);
  const start = Math.max(0, +o.start || 0), end = +o.end || 0;
  const len = end > start ? end - start : Math.max(0, (+o.duration || 0) - start);
  const precise = o.mode === 'precise' || audioOnly || o.normalize || (o.convert && !o.copyOk);
  const args = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  if (end > start) args.push('-t', len.toFixed(3));
  args.push('-i', o.src);
  const mp4ish = ['mp4', 'm4v', 'mov'].includes(outExt);
  if (audioOnly) {
    args.push('-vn', '-map', '0:a:' + (o.audioTrack || 0), ...(AUDIO_CODECS[outExt] || []));
    if (outExt === 'mp3') args.push('-id3v2_version', '3');
    args.push('-map_metadata', '0');
  } else {
    args.push('-map', '0:v:0?');
    if (!o.removeAudio) args.push('-map', mp4ish ? '0:a?' : '0:a?');
    if (!mp4ish && !o.removeAudio) args.push('-map', '0:s?');
    if (precise) {
      const enc = o.gpu === false ? 'libx264' : await bestEncoder();
      args.push(...(enc === 'libx264' ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'] : encArgs(enc)), '-pix_fmt', 'yuv420p');
      if (!o.removeAudio) args.push('-c:a', 'aac', '-b:a', '256k');
      if (!mp4ish) args.push('-c:s', 'copy');
    } else args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    if (o.removeAudio) args.push('-an');
    if (mp4ish) args.push('-movflags', '+faststart', '-sn');
  }
  if (o.normalize) args.push('-af', 'loudnorm=I=-14:TP=-1:LRA=11');
  let target = o.out;
  if (o.overwrite) target = path.join(path.dirname(o.out), `.${path.basename(o.out)}.atlas-tmp.${outExt}`);
  args.push(target);
  const job = { id, pct: 0, done: false, error: null, out: o.out };
  jobs.set(id, job);
  const p = spawn(ffmpeg(), args, { windowsHide: true });
  job.proc = p;
  let err = '';
  p.stdout.on('data', (d) => {
    const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
    if (m && len > 0) { const us = +m[m.length - 1].split('=')[1]; job.pct = Math.min(99, (us / 1e6 / len) * 100); }
  });
  p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
  p.on('error', (e) => { job.done = true; job.error = e.message; });
  p.on('close', async (code) => {
    if (job.cancelled) { try { fs.unlinkSync(target); } catch {} job.done = true; job.error = 'Cancelled'; return; }
    if (code !== 0) { try { fs.unlinkSync(target); } catch {} job.done = true; job.error = (err.trim().split('\n').pop() || 'ffmpeg failed') ; return; }
    if (o.overwrite) {
      // the player releases the file first; retry briefly in case Windows still holds a handle
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) { try { fs.renameSync(target, o.out); ok = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
      if (!ok) { job.done = true; job.error = 'The original file is in use, so it could not be replaced. The edit was kept next to it.'; try { fs.renameSync(target, o.out.replace(/(\.[^.]+)$/, ' (edited)$1')); } catch {} return; }
    }
    job.pct = 100; job.done = true;
  });
  return id;
}
function jobStatus(id) { const j = jobs.get(id); if (!j) return null; const { proc, ...pub } = j; if (j.done) setTimeout(() => jobs.delete(id), 60000); return pub; }
function cancelJob(id) { const j = jobs.get(id); if (j && !j.done) { j.cancelled = true; try { j.proc.kill('SIGKILL'); } catch {} } }

module.exports = { ffmpegPath: ffmpeg, runBuffer, exportMedia, jobStatus, cancelJob, probe, handle, killAll, bestEncoder, available: () => !!findFF() || false, screenshotTo };
