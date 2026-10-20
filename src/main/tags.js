// Music tag editor backend: read / write ID3 (MP3), Vorbis comments (FLAC/OGG), MP4 atoms (M4A) and RIFF INFO
// (WAV) through ffmpeg, cover art included, plus free online lookups: iTunes Search + MusicBrainz / Cover Art
// Archive by title, and AcoustID audio fingerprints (with a free AcoustID application key).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { net } = require('electron');
const media = require('./media');

const UA = 'AtlasFiles/1.2 ( https://github.com/ )';
const ext = (p) => path.extname(p).slice(1).toLowerCase();
const COVER_OK = new Set(['mp3', 'flac', 'm4a', 'mp4', 'aac', 'alac', 'm4b']);

async function read(file) {
  const info = await media.probe(file);
  const raw = { ...(info.format?.tags || {}) };
  for (const s of info.streams || []) if (s.codec_type === 'audio') Object.assign(raw, Object.fromEntries(Object.entries(s.tags || {}).filter(([k]) => !(k in raw))));
  const lower = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
  const g = (...keys) => { for (const k of keys) if (lower[k] != null && lower[k] !== '') return String(lower[k]); return ''; };
  return {
    tags: {
      title: g('title', 'inam'), artist: g('artist', 'iart'), album: g('album', 'iprd'), album_artist: g('album_artist', 'albumartist', 'album artist'),
      date: g('date', 'year', 'icrd', 'tyer', 'tdrc'), track: g('track', 'tracknumber', 'itrk'), disc: g('disc', 'discnumber'), genre: g('genre', 'ignr'),
      composer: g('composer'), comment: g('comment', 'icmt', 'description'), bpm: g('tbpm', 'bpm'), key: g('tkey', 'initialkey', 'key'),
    },
    hasCover: (info.streams || []).some((s) => s.disposition?.attached_pic),
    coverSupported: COVER_OK.has(ext(file)),
    duration: parseFloat(info.format?.duration) || 0,
    format: info.format?.format_name || '',
  };
}

function run(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(media.ffmpegPath(), args, { windowsHide: true });
    let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout);
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'ffmpeg failed')); });
  });
}

// changes: { title: 'x', ... } (only changed fields; '' clears). cover: undefined = keep, null = remove, dataURL = replace
async function write(file, changes = {}, cover) {
  const e = ext(file);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tag-'));
  const out = path.join(path.dirname(file), `.${path.basename(file)}.atlas-tag.${e}`);
  try {
    const args = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-i', file];
    let coverFile = null;
    if (typeof cover === 'string' && cover.startsWith('data:image/')) {
      if (!COVER_OK.has(e)) throw new Error(`.${e} files can't store cover art. Convert to MP3, FLAC or M4A to add one.`);
      const m = cover.match(/^data:image\/(\w+);base64,(.*)$/);
      coverFile = path.join(tmpDir, 'cover.' + (m[1] === 'png' ? 'png' : 'jpg'));
      fs.writeFileSync(coverFile, Buffer.from(m[2], 'base64'));
      args.push('-i', coverFile);
    }
    args.push('-map', '0:a');
    if (coverFile) args.push('-map', '1:0');
    else if (cover !== null && COVER_OK.has(e)) args.push('-map', '0:v?');
    args.push('-c', 'copy', '-map_metadata', '0');
    if (coverFile) args.push('-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    const id3 = e === 'mp3';
    const keyMap = { bpm: id3 ? 'TBPM' : e === 'm4a' ? 'tmpo' : 'BPM', key: id3 ? 'TKEY' : 'INITIALKEY' };
    for (const [k, v] of Object.entries(changes)) args.push('-metadata', `${keyMap[k] || k}=${v ?? ''}`);
    if (id3) args.push('-id3v2_version', '3', '-write_id3v1', '1');
    if (e === 'wav') args.push('-write_bext', '0');
    args.push(out);
    await run(args);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) { try { fs.renameSync(out, file); ok = true; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    if (!ok) throw new Error('The file is in use (is it playing?). Close it and try again.');
    return true;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
  }
}

async function getJson(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// title / artist lookup: iTunes Search (great artwork) + MusicBrainz (open data, Cover Art Archive)
async function lookup({ query, title, artist, album }) {
  const term = (query || [artist, title].filter(Boolean).join(' ')).trim();
  if (!term) return [];
  const out = [];
  const jobs = [];
  jobs.push(getJson(`https://itunes.apple.com/search?media=music&entity=song&limit=12&term=${encodeURIComponent(term)}`).then((j) => {
    for (const r of j.results || []) out.push({
      source: 'iTunes', title: r.trackName || '', artist: r.artistName || '', album: r.collectionName || '', album_artist: r.collectionArtistName || r.artistName || '',
      date: (r.releaseDate || '').slice(0, 4), genre: r.primaryGenreName || '', track: r.trackNumber ? `${r.trackNumber}${r.trackCount ? '/' + r.trackCount : ''}` : '', disc: r.discNumber ? String(r.discNumber) : '',
      art: (r.artworkUrl100 || '').replace(/100x100bb/, '600x600bb'), thumb: r.artworkUrl100 || '', duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : 0,
    });
  }).catch(() => {}));
  const mbq = title ? `recording:"${title.replace(/"/g, '')}"${artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : ''}` : term;
  jobs.push(getJson(`https://musicbrainz.org/ws/2/recording/?fmt=json&limit=8&query=${encodeURIComponent(mbq)}`).then((j) => {
    for (const r of j.recordings || []) {
      const rel = (r.releases || []).find((x) => x.status === 'Official') || (r.releases || [])[0];
      out.push({
        source: 'MusicBrainz', title: r.title || '', artist: (r['artist-credit'] || []).map((a) => a.name + (a.joinphrase || '')).join(''), album: rel?.title || '',
        album_artist: (rel?.['artist-credit'] || r['artist-credit'] || []).map((a) => a.name + (a.joinphrase || '')).join(''), date: (rel?.date || r['first-release-date'] || '').slice(0, 4), genre: '',
        track: rel?.media?.[0]?.track?.[0]?.number || '', disc: '', art: rel ? `https://coverartarchive.org/release/${rel.id}/front-500` : '', thumb: rel ? `https://coverartarchive.org/release/${rel.id}/front-250` : '',
        duration: r.length ? r.length / 1000 : 0, mbid: r.id,
      });
    }
  }).catch(() => {}));
  await Promise.all(jobs);
  return out;
}

// audio fingerprint -> AcoustID -> MusicBrainz recordings (needs a free AcoustID application key)
async function identify(file, key) {
  if (!key) throw new Error('Add your free AcoustID key in Settings > Tools & apps to identify songs by sound.');
  const tmp = path.join(os.tmpdir(), `atlas-fp-${Date.now()}.txt`);
  try {
    await run(['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-i', file, '-t', '120', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'base64', tmp], 60000);
    const fp = fs.readFileSync(tmp, 'utf8').trim();
    if (!fp || fp.length < 20) throw new Error('Could not fingerprint this file (is the audio long enough?)');
    const info = await media.probe(file).catch(() => null);
    let dur = Math.round(parseFloat(info?.format?.duration) || 0);
    if (!dur) dur = 120;
    // POST (form-encoded): a 2-minute fingerprint is too long to send reliably in a URL
    const body = new URLSearchParams({ client: String(key).trim(), format: 'json', meta: 'recordings releasegroups compress', duration: String(dur), fingerprint: fp });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let j;
    try {
      const r = await net.fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: ctrl.signal });
      j = await r.json().catch(() => null);
      if (!j) throw new Error(`AcoustID answered HTTP ${r.status}`);
    } finally { clearTimeout(timer); }
    if (j.status !== 'ok') {
      const code = j.error?.code, msg = j.error?.message || 'AcoustID lookup failed';
      // code 4 = invalid API key. The key on the AcoustID account page is a *user* key (for submitting); lookups need an *application* key
      if (code === 4 || /api key/i.test(msg)) throw new Error('AcoustID rejected the key. Lookups need an application API key: sign in at acoustid.org, choose “Register a new application” (free), and paste that key in Settings > Tools & apps. The key shown on your account page is a user key and won’t work here.');
      throw new Error(`AcoustID: ${msg}`);
    }
    const out = [];
    for (const r of (j.results || []).sort((a, b) => b.score - a.score)) {
      for (const rec of r.recordings || []) {
        const rg = (rec.releasegroups || [])[0];
        out.push({ source: `AcoustID ${Math.round(r.score * 100)}%`, title: rec.title || '', artist: (rec.artists || []).map((a) => a.name + (a.joinphrase || '')).join(''), album: rg?.title || '', album_artist: '', date: '', genre: '', track: '', disc: '',
          art: rg ? `https://coverartarchive.org/release-group/${rg.id}/front-500` : '', thumb: rg ? `https://coverartarchive.org/release-group/${rg.id}/front-250` : '', mbid: rec.id, score: r.score });
      }
    }
    return out.slice(0, 15);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// download cover art (only from the services above) and return it as a data URL
const ART_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(mzstatic\.com|coverartarchive\.org|archive\.org)\//i;
async function fetchArt(url) {
  if (!ART_HOSTS.test(url)) throw new Error('Unsupported image source');
  const r = await net.fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`No cover art (${r.status})`);
  const type = r.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//.test(type)) throw new Error('Not an image');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error('Image too large');
  return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
}

module.exports = { read, write, lookup, identify, fetchArt };
