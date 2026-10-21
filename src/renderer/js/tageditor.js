// Music tag editor (MP3 / FLAC / M4A / WAV / OGG…): edit one or many files, cover art, BPM & key from analysis,
// and Auto mode that looks the song up online by its title (iTunes + MusicBrainz, free) or by its sound
// (AcoustID fingerprint, free key) and fills in everything including the album cover.
import { api, h, esc, toast, state, bus } from './core.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';
import { analyzeAudio } from './audio-analysis.js';

const FIELDS = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['album_artist', 'Album artist'], ['date', 'Year'], ['track', 'Track'],
  ['disc', 'Disc'], ['genre', 'Genre'], ['composer', 'Composer'], ['bpm', 'BPM'], ['key', 'Key'], ['comment', 'Comment'],
];
const MIXED = '\u0000mixed';
const base = (p) => p.split(/[\\/]/).pop();
const stem = (p) => base(p).replace(/\.[^.]+$/, '');

// "03 - Daft Punk - One More Time (Official Video) [HD]" -> { artist: 'Daft Punk', title: 'One More Time' }
export function guessFromName(p) {
  let s = stem(p).replace(/[_]+/g, ' ').replace(/\s*[([{](official.*?|lyrics?.*?|audio|video|hd|hq|4k|explicit|remaster(ed)?.*?|\d{3,4}p)[)\]}]/gi, '').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^\d{1,3}\s*[-.)_ ]\s*/, '');
  const parts = s.split(/\s+[-–]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { title: s, artist: '' };
}
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
export function scoreCandidate(c, want, duration) {
  let s = similarity(c.title, want.title) * 2 + (want.artist ? similarity(c.artist, want.artist) * 1.5 : 0.4);
  if (duration && c.duration) { const d = Math.abs(c.duration - duration); s += d < 3 ? 0.8 : d < 10 ? 0.3 : -0.4; }
  if (c.score) s += c.score * 2;
  if (c.art) s += 0.15;
  return s;
}

const artUrl = (p, bust) => `/media/art?p=${encodeURIComponent(p)}&b=${bust || 0}`;

export async function openTagEditor(paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const infos = [];
  for (const p of paths) { try { infos.push({ p, ...(await api('tags:read', p)) }); } catch (e) { toast(`${base(p)}: ${e.message}`, { error: true }); } }
  if (!infos.length) return;
  const multi = infos.length > 1;
  // field values: same in all files, or mixed
  const values = {};
  for (const [k] of FIELDS) { const vs = new Set(infos.map((i) => i.tags[k] || '')); values[k] = vs.size === 1 ? [...vs][0] : MIXED; }
  const inputs = {};
  const changed = new Set();
  const grid = h('div', { class: 'tg-grid' });
  for (const [k, label] of FIELDS) {
    const inp = h(k === 'comment' ? 'textarea' : 'input', { class: 'input tg-in', spellcheck: 'false', rows: k === 'comment' ? '2' : null });
    if (values[k] === MIXED) { inp.placeholder = '(different in each file, leave to keep)'; inp.value = ''; } else inp.value = values[k];
    inp.addEventListener('input', () => { changed.add(k); inp.classList.add('changed'); });
    inputs[k] = inp;
    grid.append(h('label', { class: 'tg-l tg-' + k }, h('span', {}, label), inp));
  }
  const setField = (k, v) => { if (v == null || v === '') return; inputs[k].value = String(v); changed.add(k); inputs[k].classList.add('changed'); };

  // cover
  let cover; // undefined keep, null remove, dataURL replace
  const coverOk = infos.every((i) => i.coverSupported);
  const coverImg = h('img', { class: 'tg-cover-img', alt: '' });
  const coverBox = h('div', { class: 'tg-cover' }, coverImg, h('div', { class: 'tg-cover-none', html: `${icon('music')}<span>No cover</span>` }));
  const showCover = (src) => { if (src) { coverImg.src = src; coverBox.classList.add('has'); } else { coverImg.removeAttribute('src'); coverBox.classList.remove('has'); } };
  coverImg.onerror = () => coverBox.classList.remove('has');
  if (!multi && infos[0].hasCover) showCover(artUrl(infos[0].p, Date.now()));
  else if (multi && infos.every((i) => i.hasCover)) showCover(artUrl(infos[0].p, Date.now()));
  const pickCover = async () => {
    const [f] = await api('dialog:openFiles', { title: 'Choose cover art', filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (!f) return;
    const im = await loadImg(`/f/?p=${encodeURIComponent(f)}`);
    cover = toJpeg(im); showCover(cover);
  };
  const pasteCover = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) { const t = it.types.find((x) => x.startsWith('image/')); if (t) { const b = await it.getType(t); const im = await loadImg(URL.createObjectURL(b)); cover = toJpeg(im); showCover(cover); return; } }
      toast('No image on the clipboard');
    } catch { toast('Couldn’t read the clipboard', { error: true }); }
  };
  const coverBtns = h('div', { class: 'tg-cover-btns' },
    h('button', { class: 'btn small', disabled: !coverOk, onclick: pickCover }, 'Choose…'),
    h('button', { class: 'btn small', disabled: !coverOk, onclick: pasteCover }, 'Paste'),
    h('button', { class: 'btn small', disabled: !coverOk, onclick: () => { cover = null; showCover(null); } }, 'Remove'));
  const coverNote = coverOk ? null : h('div', { class: 'hint' }, 'WAV and OGG files can’t hold cover art.');

  // auto panel
  const results = h('div', { class: 'tg-results' });
  const status = h('div', { class: 'hint tg-status' });
  const query = h('input', { class: 'input', spellcheck: 'false', placeholder: 'Artist and song title' });
  const g0 = multi ? {} : (infos[0].tags.title ? { title: infos[0].tags.title, artist: infos[0].tags.artist } : guessFromName(infos[0].p));
  query.value = [g0.artist, g0.title].filter(Boolean).join(' - ');
  const apply = async (c) => {
    for (const k of ['title', 'artist', 'album', 'album_artist', 'date', 'genre', 'track', 'disc']) if (!multi || !['title', 'track'].includes(k)) setField(k, c[k]);
    if (c.art && coverOk) {
      status.textContent = 'Downloading cover art…';
      try { cover = await api('tags:fetchArt', c.art); showCover(cover); status.textContent = `Filled in from ${c.source}. Review, then Save.`; } catch (e) { status.textContent = `Filled in from ${c.source} (no cover art: ${e.message})`; }
    } else status.textContent = `Filled in from ${c.source}. Review, then Save.`;
  };
  const showResults = (list, want) => {
    results.innerHTML = '';
    if (!list.length) { results.append(h('div', { class: 'hint pad' }, 'No matches. Try a different spelling, or identify by sound.')); return; }
    const dur = multi ? 0 : infos[0].duration;
    list = list.map((c) => ({ c, s: scoreCandidate(c, want, dur) })).sort((a, b) => b.s - a.s).slice(0, 14).map((x) => x.c);
    for (const c of list) {
      const im = h('img', { class: 'tg-r-art', alt: '', loading: 'lazy' });
      if (c.thumb) api('tags:fetchArt', c.thumb).then((u) => (im.src = u)).catch(() => im.classList.add('none')); else im.classList.add('none');
      const row = h('div', { class: 'tg-r' }, im, h('div', { class: 'tg-r-t' }, h('b', {}, c.title || '?'), h('span', {}, [c.artist, c.album, c.date].filter(Boolean).join(' · ')), h('i', {}, c.source + (c.duration ? ` · ${Math.floor(c.duration / 60)}:${String(Math.round(c.duration % 60)).padStart(2, '0')}` : ''))), h('button', { class: 'btn small', onclick: () => apply(c) }, 'Use'));
      results.append(row);
    }
  };
  const searchByName = async () => {
    const q = query.value.trim();
    if (!q) return;
    status.textContent = 'Searching iTunes and MusicBrainz…';
    const parts = q.split(/\s+-\s+/);
    const want = parts.length > 1 ? { artist: parts[0], title: parts.slice(1).join(' - ') } : { title: q };
    try { const list = await api('tags:lookup', { query: q.replace(/\s+-\s+/g, ' '), ...want }); status.textContent = list.length ? 'Pick the right match:' : ''; showResults(list, want); }
    catch (e) { status.textContent = `Search failed: ${e.message}`; }
  };
  const searchBySound = async () => {
    status.textContent = 'Listening to the song and asking AcoustID…';
    try { const key = state.settings.acoustidKey || (await api('store:get', 'settings'))?.acoustidKey || '';
      const list = await api('tags:identify', infos[0].p, key); status.textContent = list.length ? 'Matches by sound:' : 'No match by sound.'; showResults(list, guessFromName(infos[0].p)); }
    catch (e) { status.textContent = e.message.replace(/^.*Error: /, ''); }
  };
  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); searchByName(); } });
  const fillAnalysis = async () => {
    status.textContent = 'Detecting BPM & key…';
    try { const a = await analyzeAudio(infos[0].p); if (a.bpm) setField('bpm', Math.round(a.bpm)); if (a.key) setField('key', a.key); status.textContent = `BPM ${Math.round(a.bpm || 0)}, key ${a.keyLabel || '?'} (${a.camelot || ''})`; }
    catch (e) { status.textContent = e.message; }
  };
  const autoPanel = multi
    ? h('div', { class: 'tg-auto' }, h('div', { class: 'tg-sec' }, 'Auto'), h('div', { class: 'hint' }, `Look up all ${infos.length} songs online by their names and review the matches before saving.`), h('button', { class: 'btn small primary', onclick: async () => { const r = await autoTagMany(infos); if (r) closeFn?.(null); } }, 'Auto-tag all…'))
    : h('div', { class: 'tg-auto' }, h('div', { class: 'tg-sec' }, 'Auto'),
      h('div', { class: 'row-inline tg-q' }, query, h('button', { class: 'btn small primary', onclick: searchByName }, 'Find by name')),
      h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: searchBySound, title: 'Identify the song from its audio (AcoustID, needs a free key in Settings)' }, 'Identify by sound'), h('button', { class: 'btn small', onclick: fillAnalysis }, 'Fill BPM & key')),
      status, results);

  const body = h('div', { class: 'tg' },
    h('div', { class: 'tg-left' }, coverBox, coverBtns, coverNote, multi ? h('div', { class: 'hint' }, `${infos.length} files. Only the fields you change are saved.`) : h('div', { class: 'hint tg-file', title: infos[0].p }, base(infos[0].p))),
    h('div', { class: 'tg-mid' }, grid),
    h('div', { class: 'tg-right' }, autoPanel));
  let closeFn = null;
  const p = modal({
    title: multi ? `Edit tags · ${infos.length} songs` : `Edit tags · ${base(infos[0].p)}`, body, width: 1080, className: 'tg-modal',
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, run: async (close) => {
      const ch = {};
      for (const k of changed) ch[k] = inputs[k].value.trim();
      if (!Object.keys(ch).length && cover === undefined) { close(null); return; }
      let ok = 0;
      for (const i of infos) {
        try { await api('tags:write', i.p, ch, cover); ok++; } catch (e) { toast(`${base(i.p)}: ${String(e.message).replace(/^.*Error: /, '')}`, { error: true }); }
      }
      if (ok) toast(`Saved tags for ${ok} file${ok > 1 ? 's' : ''}`);
      bus.emit('refreshPanes');
      close(true);
    } }],
  });
  setTimeout(() => { closeFn = body.closest('.modal')?._close; }, 30);
  return p;
}

// batch: look every song up by name, pick the best match, let the user review, then write
async function autoTagMany(infos) {
  const rows = infos.map((i) => ({ i, want: i.tags.title ? { title: i.tags.title, artist: i.tags.artist } : guessFromName(i.p), match: null, use: h('input', { type: 'checkbox' }), cell: h('td', { class: 'dim' }, h('span', { class: 'mini-spin' })) }));
  const table = h('table', { class: 'an-table' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'File'), h('th', {}, 'Best match'))), h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, r.use), h('td', { class: 'nm', title: r.i.p }, base(r.i.p)), r.cell))));
  const withArt = h('input', { type: 'checkbox', checked: true });
  const go = modal({ title: 'Auto-tag', width: 860, body: h('div', { class: 'an-wrap' }, table, h('label', { class: 'check', style: { marginTop: '10px' } }, withArt, ' Also download album covers')), buttons: [{ label: 'Cancel', value: null }, { label: 'Save checked', primary: true, value: true }] });
  (async () => {
    for (const r of rows) {
      try {
        const list = await api('tags:lookup', { query: [r.want.artist, r.want.title].filter(Boolean).join(' '), ...r.want });
        const best = list.map((c) => ({ c, s: scoreCandidate(c, r.want, r.i.duration) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s > 1.2) { r.match = best.c; r.use.checked = best.s > 2; r.cell.className = ''; r.cell.textContent = `${best.c.artist} · ${best.c.title}${best.c.album ? ' · ' + best.c.album : ''} (${best.c.source})`; }
        else { r.cell.textContent = 'No confident match'; }
      } catch (e) { r.cell.textContent = e.message; }
      await new Promise((res) => setTimeout(res, 1100)); // MusicBrainz asks for at most one request a second
    }
  })();
  if (!(await go)) return false;
  let ok = 0;
  for (const r of rows) {
    if (!r.use.checked || !r.match) continue;
    const c = r.match;
    const ch = {}; for (const k of ['title', 'artist', 'album', 'album_artist', 'date', 'genre', 'track', 'disc']) if (c[k]) ch[k] = c[k];
    let cover;
    if (withArt.checked && c.art && r.i.coverSupported) { try { cover = await api('tags:fetchArt', c.art); } catch {} }
    try { await api('tags:write', r.i.p, ch, cover); ok++; } catch (e) { toast(`${base(r.i.p)}: ${e.message}`, { error: true }); }
  }
  toast(`Tagged ${ok} song${ok === 1 ? '' : 's'}`);
  bus.emit('refreshPanes');
  return true;
}

function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('Can’t read that image')); im.src = src; }); }
function toJpeg(im) {
  const max = 1200; let w = im.naturalWidth, hh = im.naturalHeight;
  if (Math.max(w, hh) > max) { const k = max / Math.max(w, hh); w = Math.round(w * k); hh = Math.round(hh * k); }
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  c.getContext('2d').drawImage(im, 0, 0, w, hh);
  return c.toDataURL('image/jpeg', 0.92);
}

bus.on('editTags', (paths) => openTagEditor(paths));
