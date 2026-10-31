// Photo details editor: title, description, people, keywords, rating, the date taken, camera and exposure,
// the location (or removing it), any other tag, and every tag there is, for one photo or many at once
// (JPEG, PNG, HEIC, TIFF, WebP and camera RAW files). Written by ExifTool (backend/src/meta.rs). And the file's
// alternate data streams (NTFS): see, add, remove, and unblock files downloaded from the internet.
import { api, bus, h, esc, toast, basename, fmtSize, IS_WIN } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { requirePro } from './license.js';
import { pushUndo } from './actions.js';

export const PHOTO_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'heic', 'heif', 'tif', 'tiff', 'webp', 'avif', 'jxl', 'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'raf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'erf', 'kdc', 'mef', 'mos', 'mrw', 'rwl', 'iiq', 'psd', 'gif']);
export const isPhoto = (it) => !it.isDir && PHOTO_EXT.has((it.ext || '').toLowerCase());

/** ExifTool is here, or fetched now (Windows) with a progress bar; false if it can't be */
async function ensureTool() {
  let s = await api('meta:status').catch(() => null);
  if (s?.ready) return true;
  if (!s?.windows) { toast('Install ExifTool (exiftool) to edit photo details', { error: true }); return false; }
  const ok = await confirm('Get ExifTool?', 'Editing photo details needs a free tool called ExifTool (about 10 MB). Dogfile downloads it once.', { ok: 'Get it' });
  if (!ok) return false;
  await api('meta:install');
  const bar = h('div', { class: 'tp-fill' });
  const el = h('div', { class: 'toast show tprog' }, h('span', {}, 'Getting ExifTool…'), h('div', { class: 'tp-bar' }, bar));
  document.getElementById('toasts')?.append(el);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      s = await api('meta:status');
      if (s.total) bar.style.width = Math.min(100, (s.received / s.total) * 100) + '%';
      if (!s.downloading) break;
    }
  } finally { el.remove(); }
  if (s.error || !s.ready) { toast(`Couldn’t get ExifTool: ${s.error || 'unknown problem'}`, { error: true }); return false; }
  return true;
}

// the fields on the first page: [label, tags read (first found wins), tags written, kind]
const FIELDS = [
  ['Title', ['XMP-dc:Title', 'IFD0:XPTitle', 'IPTC:ObjectName'], ['XMP-dc:Title', 'IPTC:ObjectName'], 'text'],
  ['Description', ['XMP-dc:Description', 'IFD0:ImageDescription', 'IPTC:Caption-Abstract'], ['XMP-dc:Description', 'IFD0:ImageDescription', 'IPTC:Caption-Abstract'], 'area'],
  ['Keywords', ['XMP-dc:Subject', 'IPTC:Keywords', 'IFD0:XPKeywords'], ['XMP-dc:Subject', 'IPTC:Keywords'], 'list'],
  ['Rating', ['XMP-xmp:Rating', 'IFD0:Rating'], ['XMP-xmp:Rating'], 'rating'],
  ['Author', ['IFD0:Artist', 'XMP-dc:Creator', 'IPTC:By-line'], ['IFD0:Artist', 'XMP-dc:Creator', 'IPTC:By-line'], 'text'],
  ['Copyright', ['IFD0:Copyright', 'XMP-dc:Rights', 'IPTC:CopyrightNotice'], ['IFD0:Copyright', 'XMP-dc:Rights', 'IPTC:CopyrightNotice'], 'text'],
  ['Date taken', ['ExifIFD:DateTimeOriginal', 'XMP-exif:DateTimeOriginal', 'IFD0:ModifyDate'], ['ExifIFD:DateTimeOriginal', 'ExifIFD:CreateDate'], 'date'],
  ['Camera maker', ['IFD0:Make'], ['IFD0:Make'], 'text'],
  ['Camera model', ['IFD0:Model'], ['IFD0:Model'], 'text'],
  ['Lens', ['ExifIFD:LensModel', 'XMP-aux:Lens'], ['ExifIFD:LensModel'], 'text'],
  ['Exposure time', ['ExifIFD:ExposureTime'], ['ExifIFD:ExposureTime'], 'text', 'e.g. 1/250'],
  ['Aperture (f/)', ['ExifIFD:FNumber'], ['ExifIFD:FNumber'], 'text', 'e.g. 2.8'],
  ['ISO', ['ExifIFD:ISO'], ['ExifIFD:ISO'], 'text'],
  ['Focal length', ['ExifIFD:FocalLength'], ['ExifIFD:FocalLength'], 'text', 'e.g. 35 mm'],
  ['Exposure compensation', ['ExifIFD:ExposureCompensation'], ['ExifIFD:ExposureCompensation'], 'text', 'e.g. -0.7'],
  ['Orientation', ['IFD0:Orientation'], ['IFD0:Orientation'], 'orient'],
];
const ORIENT = ['Horizontal (normal)', 'Mirror horizontal', 'Rotate 180', 'Mirror vertical', 'Mirror horizontal and rotate 270 CW', 'Rotate 90 CW', 'Mirror horizontal and rotate 90 CW', 'Rotate 270 CW'];
const first = (tags, names) => { for (const n of names) if (tags[n] != null && tags[n] !== '') return tags[n]; return null; };
const show = (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v));
const num = (v) => (v == null || v === '' ? null : typeof v === 'number' ? v : parseFloat(String(v)));

/** the editor for one photo or many */
export async function editPhotoDetails(items) {
  items = items.filter(isPhoto);
  if (!items.length) return toast('Select photos (JPEG, PNG, HEIC, TIFF, RAW…)');
  if (!requirePro('metadata')) return;
  if (!(await ensureTool())) return;
  let tags;
  try { tags = await api('meta:read', items.map((i) => i.path)); } catch (e) { return toast(e.message === 'NEED_EXIFTOOL' ? 'ExifTool is missing' : e.message, { error: true }); }
  const many = items.length > 1;
  const changes = {}; // label -> new value (only what was touched)
  const inputs = {};
  // a field's value: the same in every photo, or "mixed"
  const valueOf = (names) => { const vals = tags.map((t) => show(first(t, names))); return vals.every((v) => v === vals[0]) ? { v: vals[0] } : { mixed: true }; };
  const form = h('div', { class: 'md-form' });
  for (const [label, read, , kind, ph] of FIELDS) {
    const { v, mixed } = valueOf(read);
    let el;
    const touch = (val) => { changes[label] = val; el.classList.add('changed'); };
    if (kind === 'area') { el = h('textarea', { class: 'input', rows: 2, placeholder: mixed ? '(different in each photo)' : '' }); el.value = v || ''; el.oninput = () => touch(el.value); }
    else if (kind === 'rating') {
      el = h('div', { class: 'md-stars' });
      const cur = mixed ? 0 : +v || 0;
      const draw = (n) => { el.innerHTML = ''; for (let i = 1; i <= 5; i++) el.append(h('button', { class: 'md-star' + (i <= n ? ' on' : ''), title: `${i} star${i > 1 ? 's' : ''}`, onclick: () => { const nn = n === i ? 0 : i; touch(nn); draw(nn); } }, '★')); if (mixed && !(label in changes)) el.append(h('span', { class: 'hint' }, ' (different in each)')); };
      draw(cur);
    } else if (kind === 'orient') {
      el = h('select', { class: 'input' }, h('option', { value: '' }, mixed ? '(different in each photo)' : ''), ...ORIENT.map((o) => h('option', { value: o }, o)));
      el.value = mixed ? '' : v || ''; el.onchange = () => touch(el.value || null);
    } else if (kind === 'date') {
      el = h('input', { class: 'input', type: 'datetime-local', step: 1 });
      if (!mixed && v) el.value = String(v).replace(/^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d(:\d\d)?).*$/, '$1-$2-$3T$4');
      if (mixed) el.title = 'Different in each photo';
      el.onchange = () => touch(el.value ? el.value.replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d)(:\d\d)?$/, (m, y, mo, d, hm, s) => `${y}:${mo}:${d} ${hm}${s || ':00'}`) : null);
    } else { el = h('input', { class: 'input', placeholder: mixed ? '(different in each photo)' : ph || '', spellcheck: 'false' }); el.value = v || ''; el.oninput = () => touch(kind === 'list' ? el.value.split(/\s*[,;]\s*/).filter(Boolean) : el.value); }
    el.addEventListener('keydown', (e) => e.stopPropagation());
    inputs[label] = el;
    form.append(h('label', { class: 'md-l' }, label), el);
  }
  // location
  const lat = valueOf(['Composite:GPSLatitude', 'GPS:GPSLatitude']), lon = valueOf(['Composite:GPSLongitude', 'GPS:GPSLongitude']);
  const latIn = h('input', { class: 'input', placeholder: lat.mixed ? '(different)' : 'latitude, e.g. 40.7128', value: lat.mixed ? '' : lat.v });
  const lonIn = h('input', { class: 'input', placeholder: lon.mixed ? '(different)' : 'longitude, e.g. -74.006', value: lon.mixed ? '' : lon.v });
  let gpsChanged = false;
  for (const x of [latIn, lonIn]) { x.oninput = () => { gpsChanged = true; x.classList.add('changed'); }; x.addEventListener('keydown', (e) => e.stopPropagation()); }
  const hasGps = tags.some((t) => t['Composite:GPSLatitude'] != null || t['GPS:GPSLatitude'] != null);
  const mapBtn = !lat.mixed && lat.v && lon.v ? h('button', { class: 'btn small', onclick: () => api('shell:openExternal', `https://www.openstreetmap.org/?mlat=${num(lat.v)}&mlon=${num(lon.v)}#map=15/${num(lat.v)}/${num(lon.v)}`) }, 'Map') : null;
  form.append(h('label', { class: 'md-l' }, 'Location'), h('div', { class: 'row-inline md-gps' }, latIn, lonIn, mapBtn));
  // any other tag
  const extra = [];
  const extraBox = h('div', { class: 'md-extra' });
  const addExtra = () => {
    const t = h('input', { class: 'input', placeholder: 'Tag, e.g. XMP-dc:Source', spellcheck: 'false' }), v = h('input', { class: 'input', placeholder: 'Value (blank removes it)', spellcheck: 'false' });
    for (const x of [t, v]) x.addEventListener('keydown', (e) => e.stopPropagation());
    extra.push([t, v]); extraBox.append(h('div', { class: 'row-inline' }, t, v));
  };
  // every tag, to look through
  const q = h('input', { class: 'input', placeholder: 'Search tags…', spellcheck: 'false' });
  q.addEventListener('keydown', (e) => e.stopPropagation());
  const all = h('div', { class: 'md-all' });
  const drawAll = () => {
    const s = q.value.trim().toLowerCase();
    const t = tags[0] || {};
    const groups = new Map();
    for (const [k, v] of Object.entries(t)) {
      if (k === 'SourceFile') continue;
      const [g, n] = k.includes(':') ? k.split(':') : ['Other', k];
      if (s && !`${k} ${show(v)}`.toLowerCase().includes(s)) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([n, show(v)]);
    }
    all.innerHTML = [...groups].map(([g, rows]) => `<div class="md-g">${esc(g)}</div>${rows.map(([n, v]) => `<div class="md-row"><span>${esc(n)}</span><span title="${esc(v)}">${esc(v.length > 300 ? v.slice(0, 300) + '…' : v)}</span></div>`).join('')}`).join('') || '<div class="hint pad">No tags match.</div>';
  };
  q.oninput = drawAll; drawAll();
  let tab = 'edit';
  const pages = { edit: h('div', { class: 'md-page' }, form, h('div', { class: 'md-sec' }, h('b', {}, 'Another tag'), extraBox, h('button', { class: 'btn small', onclick: addExtra }, 'Add a tag…'))), all: h('div', { class: 'md-page' }, q, all, many ? h('div', { class: 'hint' }, `Showing ${items[0].name}. ${items.length - 1} more selected.`) : null) };
  const seg = h('div', { class: 'seg' });
  const main = h('div', { class: 'md-main' });
  const go = (k) => { tab = k; seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); main.innerHTML = ''; main.append(pages[k]); };
  for (const [k, l] of [['edit', 'Details'], ['all', 'All tags']]) seg.append(h('button', { class: 'seg-btn', 'data-k': k, onclick: () => go(k) }, l));
  go(tab);
  const raw = items.some((i) => /^(cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|orf|raf|rw2|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|rwl|iiq)$/i.test(i.ext || ''));
  const body = h('div', { class: 'md' },
    h('div', { class: 'md-head' }, h('span', { class: 'md-ic', html: icon('camera') }), h('div', {}, h('b', {}, many ? `${items.length} photos` : items[0].name), h('div', { class: 'hint' }, many ? 'Only what you change gets saved. Everything else stays the same.' : `${(items[0].ext || '').toUpperCase()} · ${fmtSize(items[0].size || 0)}`)), h('span', { style: { flex: '1' } }), seg),
    main);
  const write = async (map) => {
    // what each photo had before, so Undo can put it back
    const names = Object.keys(map);
    const before = tags.map((t) => ({ path: t.SourceFile, values: Object.fromEntries(names.map((n) => [n, t[n] ?? null])) }));
    const r = await api('meta:write', items.map((i) => i.path), map, {});
    pushUndo({ type: 'metadata', files: before }, `Edit details of ${many ? `${items.length} photos` : items[0].name}`);
    return r;
  };
  modal({
    title: '', body, width: 680, className: 'md-modal', noPadding: true,
    buttons: [
      { el: h('div', { class: 'row-inline md-left' }, h('button', { class: 'btn', title: 'Take the location (GPS) out of the photos', disabled: !hasGps, onclick: async () => { if (!(await confirm('Remove the location?', `The GPS position comes out of ${many ? `these ${items.length} photos` : 'this photo'}. Nothing else changes.`, { ok: 'Remove' }))) return; try { const r = await api('meta:stripGps', items.map((i) => i.path)); toast(`Location removed from ${r.updated} photo${r.updated === 1 ? '' : 's'}`); bus.emit('refreshPanes'); document.querySelector('.md-modal')?._close?.(null); } catch (e) { toast(e.message, { error: true }); } } }, 'Remove location'), h('button', { class: 'btn', title: 'Take every detail out (orientation and colour kept)', onclick: async () => { if (!(await confirm('Remove all details?', `Camera, date, location, keywords, everything comes out of ${many ? 'these photos' : 'this photo'} (how it's turned and its colours are kept).${raw ? ' RAW files are left alone: they need their details to be developed.' : ''} This can't be undone.`, { ok: 'Remove all', danger: true }))) return; try { const r = await api('meta:stripAll', items.map((i) => i.path)); toast(`Cleaned ${r.updated} photo${r.updated === 1 ? '' : 's'}${r.skippedRaw ? ` (${r.skippedRaw} RAW left alone)` : ''}`); bus.emit('refreshPanes'); document.querySelector('.md-modal')?._close?.(null); } catch (e) { toast(e.message, { error: true }); } } }, 'Remove all')), left: true },
      { label: 'Cancel', value: null },
      { label: 'Save', primary: true, run: async (close) => {
        const map = {};
        for (const [label, , writes] of FIELDS) if (label in changes) { const v = changes[label]; for (const w of writes) map[w] = v === '' ? null : v; }
        if (gpsChanged) {
          const la = num(latIn.value), lo = num(lonIn.value);
          if (latIn.value.trim() === '' && lonIn.value.trim() === '') { map['GPS:GPSLatitude'] = null; map['GPS:GPSLongitude'] = null; }
          else if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) { toast('The location needs a latitude (-90 to 90) and a longitude (-180 to 180)', { error: true }); return false; }
          else { map['GPS:GPSLatitude'] = Math.abs(la); map['GPS:GPSLatitudeRef'] = la < 0 ? 'S' : 'N'; map['GPS:GPSLongitude'] = Math.abs(lo); map['GPS:GPSLongitudeRef'] = lo < 0 ? 'W' : 'E'; }
        }
        for (const [t, v] of extra) { const k = t.value.trim(); if (k) map[k] = v.value === '' ? null : v.value; }
        if (!Object.keys(map).length) return close(null); // nothing changed: just close
        try {
          const r = await write(map);
          toast(`Saved to ${r.updated} photo${r.updated === 1 ? '' : 's'}${r.errors?.length ? ` (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}: ${r.errors[0]})` : ''}`);
          bus.emit('refreshPanes');
        } catch (e) { toast(e.message, { error: true }); return false; }
        close(true);
      } },
    ],
  });
}

/** take the location out of photos, straight away */
export async function removeLocation(items) {
  items = items.filter(isPhoto);
  if (!items.length) return toast('Select photos');
  if (!(await ensureTool())) return;
  try { const r = await api('meta:stripGps', items.map((i) => i.path)); toast(r.updated ? `Location removed from ${r.updated} photo${r.updated === 1 ? '' : 's'}` : 'None of them had a location'); }
  catch (e) { toast(e.message, { error: true }); }
}

// ---------------------------------------------------------------------------------------------------------------
// alternate data streams

const STREAM_HELP = { 'Zone.Identifier': 'Windows’ “downloaded from the internet” mark (what makes files blocked)', 'SmartScreen': 'SmartScreen’s check result', 'com.dropbox.attrs': 'Dropbox’s own notes', 'encryptable': 'Windows Search’s note', 'favicon': 'a website icon saved with a shortcut', 'AFP_AfpInfo': 'Mac file information', 'OECustomProperty': 'Outlook Express data' };
/** the hidden streams of one or more files */
export async function streamsDialog(items) {
  if (!IS_WIN()) return toast('Alternate data streams are a Windows (NTFS) feature');
  items = items.filter((i) => !i.isDir);
  if (!items.length) return toast('Select files');
  const body = h('div', { class: 'as2' });
  const view = h('div', { class: 'as2-view' });
  let map = {};
  const load = async () => { map = await api('meta:streamsMany', items.map((i) => i.path)); };
  const draw = () => {
    body.innerHTML = '';
    const files = Object.keys(map);
    const total = files.reduce((n, p) => n + map[p].length, 0);
    const zones = files.filter((p) => map[p].some((s) => s.name === 'Zone.Identifier'));
    body.append(h('div', { class: 'as2-head' }, h('b', {}, total ? `${total} hidden stream${total === 1 ? '' : 's'} in ${files.length} of ${items.length} file${items.length === 1 ? '' : 's'}` : `No hidden streams in ${items.length === 1 ? items[0].name : `these ${items.length} files`}`), h('span', { style: { flex: '1' } }),
      zones.length ? h('button', { class: 'btn small', title: 'Remove the “downloaded from the internet” mark', onclick: async () => { const r = await api('meta:streamRemove', zones, 'Zone.Identifier'); toast(`Unblocked ${r.removed} file${r.removed === 1 ? '' : 's'}`); await load(); draw(); } }, `Unblock ${zones.length}`) : null,
      total ? h('button', { class: 'btn small danger', onclick: async () => { if (!(await confirm('Remove every hidden stream?', 'This removes the hidden extras. The files themselves stay the same.', { ok: 'Remove', danger: true }))) return; const r = await api('meta:streamRemove', files, '*'); toast(`Removed ${r.removed} stream${r.removed === 1 ? '' : 's'}`); await load(); draw(); } }, 'Remove all') : null));
    const list = h('div', { class: 'as2-list' });
    for (const p of files) {
      list.append(h('div', { class: 'as2-file' }, h('span', { html: icon('page') }), h('b', { title: p }, basename(p))));
      for (const s of map[p]) {
        const row = h('div', { class: 'as2-row' }, h('span', { class: 'as2-n' }, s.name), h('span', { class: 'hint' }, `${fmtSize(s.size)}${STREAM_HELP[s.name] ? ` · ${STREAM_HELP[s.name]}` : ''}`), h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn small', onclick: async () => {
            const r = await api('meta:streamRead', p, s.name, 65536).catch((e) => ({ error: e.message }));
            view.innerHTML = '';
            const bytes = r.data ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : [];
            view.append(h('div', { class: 'as2-vh' }, h('b', {}, `${basename(p)}:${s.name}`), h('span', { class: 'hint' }, r.error || `${fmtSize(r.size)}${r.size > bytes.length ? ' (start shown)' : ''}`)),
              h('pre', {}, r.text != null ? r.text : [...bytes.slice(0, 4096)].map((b, i) => (i % 16 === 0 ? `\n${i.toString(16).padStart(6, '0')}  ` : '') + b.toString(16).padStart(2, '0')).join(' ').trim()));
          } }, 'View'),
          h('button', { class: 'icon-btn small', title: 'Remove this stream', html: icon('trash'), onclick: async () => { await api('meta:streamRemove', [p], s.name); await load(); draw(); } }));
        list.append(row);
      }
    }
    body.append(list, view);
    if (items.length === 1) {
      const n = h('input', { class: 'input', placeholder: 'New stream name', spellcheck: 'false' }), t = h('input', { class: 'input', placeholder: 'Its text', spellcheck: 'false' });
      for (const x of [n, t]) x.addEventListener('keydown', (e) => e.stopPropagation());
      body.append(h('div', { class: 'row-inline as2-add' }, n, t, h('button', { class: 'btn small', onclick: async () => { try { await api('meta:streamWrite', items[0].path, n.value.trim(), t.value); toast('Stream added'); await load(); draw(); } catch (e) { toast(e.message, { error: true }); } } }, 'Add')));
    }
  };
  await load(); draw();
  modal({ title: 'Hidden streams', body, width: 640, buttons: [{ label: 'Close', primary: true }] });
}
