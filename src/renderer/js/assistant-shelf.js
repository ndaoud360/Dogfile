// The assistant and the Drop Shelf: with "Use the Drop Shelf" on, a request is about the files on the shelf, and one
// request can treat each kind of file its own way: "reduce the photos to 50%, rename them in order, convert the
// audio to FLAC and overwrite". The plan is shown first; nothing changes until "Do it".
import { api, state, bus, h, basename, dirname, pjoin, stem, fileUrl, saveSettings, KINDS } from './core.js';

export function kindOf(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (!/\.[a-z0-9]{1,5}$/i.test(p)) return 'folder';
  for (const k of ['image', 'audio', 'video']) if (KINDS[k].includes(ext)) return k;
  if (KINDS.document.includes(ext)) return 'doc';
  return 'other';
}
const NOUN = { image: ['photo', 'photos'], audio: ['song', 'songs'], video: ['video', 'videos'], doc: ['document', 'documents'], other: ['file', 'files'], folder: ['folder', 'folders'], all: ['file', 'files'] };
const nounFor = (k, n) => NOUN[k][n === 1 ? 0 : 1];
export const count = (k, n) => `${n} ${nounFor(k, n)}`;
const listJoin = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/** "4 photos, 2 songs and 1 PDF" */
export function describeShelf(paths) {
  const by = {};
  for (const p of paths) { const k = kindOf(p); by[k] = (by[k] || 0) + 1; }
  return listJoin(['image', 'audio', 'video', 'doc', 'other', 'folder'].filter((k) => by[k]).map((k) => count(k, by[k])));
}

// ---------------- understanding the request ----------------
const KIND_WORDS = [
  ['image', /\b(photos?|pictures?|pics?|images?|jpe?gs?|pngs?|screenshots?)\b/],
  ['audio', /\b(audio|songs?|music|tracks?|mp3s?|wavs?|sounds?|recordings?)\b/],
  ['video', /\b(videos?|movies?|clips?|mp4s?|films?)\b/],
  ['doc', /\b(pdfs?|documents?|docs?)\b/],
];
const FORMATS = { image: ['jpg', 'jpeg', 'png', 'webp'], audio: ['flac', 'mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac'], video: ['mp4', 'mkv', 'mov', 'webm'] };
const OP_START = /^(rename|resize|reduce|shrink|scale|downsize|compress|convert|turn|change|make|add|put|play|show|start|zip|move|copy|tag|save|export)\b/;

/** { steps: [{ op, kind, …}], overwrite, rest: [clauses it didn't understand] } */
export function parseShelfRequest(text) {
  let s = ` ${String(text).toLowerCase().replace(/[“”]/g, '"')} `;
  const overwrite = /\b(overwrite|overwriting|replace (?:the )?(?:originals?|files?|them)|replacing (?:the )?(?:originals?|them)|in place)\b/.test(s);
  s = s.replace(/\b(?:and )?(?:overwrite|overwriting)(?: (?:the )?(?:originals?|files?|them))?\b|\b(?:and )?(?:replace|replacing) (?:the )?(?:originals?|files?|them)\b|\bin place\b/g, ' ');
  // clauses: commas, "then", and "and" before a new action
  const parts = s.split(/\s*(?:,|;|\bthen\b|\band then\b|\.\s)\s*/).flatMap((c) => c.split(/\s+and\s+(?=(?:also\s+)?(?:rename|resize|reduce|shrink|scale|downsize|compress|convert|turn|change|make|add|put|play|show|start|save|export)\b)/));
  const steps = [], rest = [];
  let lastKind = null;
  for (let raw of parts) {
    const c = raw.replace(/^\s*(?:and|also|please|then)\s+/, '').replace(/\s+/g, ' ').trim();
    if (!c) continue;
    let kind = KIND_WORDS.find(([, re]) => re.test(c))?.[0] || null;
    // "them" / "all of them" / "everything" means the files the last step was about (or all of them)
    // "all" / "everything" means every file; "them", or no kind at all, means the files the last step was about
    if (!kind && /\b(all of them|everything|every file|each file|all the files|all files)\b/.test(c)) kind = 'all';
    if (!kind) kind = lastKind;
    let step = null;
    const fmt = c.match(/\b(?:to|into|as|in)\s+(?:an?\s+)?\.?(flac|mp3|wav|ogg|opus|m4a|aac|mp4|mkv|mov|webm|jpe?g|png|webp)\b/)?.[1];
    if (/\bslide ?show\b/.test(c)) step = { op: 'slideshow', kind: 'image' };
    else if (/\b(playlist|play (?:them|it|all|the|these|those|everything|my)|play$|listen to)\b/.test(c)) step = { op: 'play', kind: kind && kind !== 'all' ? kind : 'media' };
    else if (/\brename\b/.test(c)) {
      const order = /\b(by date|oldest first|by age|chronological)\b/.test(c) ? 'date' : /\b(by name|alphabetical)\b/.test(c) ? 'name' : 'shelf';
      const base = c.match(/\b(?:to|as|called|named)\s+"?([a-z0-9][a-z0-9 _'&-]{0,40}?)"?\s*(?:$|\b(?:sequentially|in order|numbered|with numbers|by date|by name|1\b|01\b|one by one|starting))/)?.[1]?.trim();
      step = { op: 'rename', kind: kind || 'all', base: base && !/^(sequential|order|numbers?)$/.test(base) ? base : null, order };
    } else if (/\b(resize|reduce|shrink|scale|downsize|smaller|compress)\b/.test(c) && !fmt) {
      const pct = +(c.match(/(\d{1,3})\s*%/)?.[1] || (/\bhalf\b/.test(c) ? 50 : /\bquarter\b/.test(c) ? 25 : 0));
      const box = c.match(/\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/);
      const wide = c.match(/\b(\d{2,5})\s*(?:px|pixels)?\s*(?:wide|width|across|on the long(?:est)? side|long)\b/) || c.match(/\b(?:width|wide)\s*(?:of\s*)?(\d{2,5})\b/);
      step = { op: 'resize', kind: 'image', pct: pct > 0 && pct < 100 ? pct : 0, maxSide: box ? Math.max(+box[1], +box[2]) : wide ? +wide[1] : 0 };
      if (!step.pct && !step.maxSide) step.pct = 50;
    } else if (fmt && /\b(convert|turn|change|save|export|make|encode|transcode)\b/.test(c)) {
      const f = fmt === 'jpeg' ? 'jpg' : fmt;
      const fk = Object.keys(FORMATS).find((k) => FORMATS[k].includes(f));
      step = { op: 'convert', kind: kind && kind !== 'all' ? kind : fk, format: f };
    }
    if (step) { steps.push(step); lastKind = step.kind === 'media' ? 'all' : step.kind; } else if (OP_START.test(c) || c.split(' ').length > 1) rest.push(c);
  }
  return { steps, overwrite, rest };
}

// ---------------- the plan, in words ----------------
function pick(items, kind) {
  if (kind === 'all') return items.filter((p) => kindOf(p) !== 'folder');
  if (kind === 'media') return items.filter((p) => ['audio', 'video'].includes(kindOf(p)));
  return items.filter((p) => kindOf(p) === kind);
}
const pad = (n, total) => String(n).padStart(Math.max(2, String(total).length), '0');
const DEFAULT_BASE = { image: 'Photo', audio: 'Track', video: 'Video', doc: 'Document', all: 'File', other: 'File' };
const cap = (s) => s.replace(/\b[a-z]/g, (m) => m.toUpperCase());

export function describeStep(st, n, overwrite) {
  const what2 = st.kind === 'media' ? `${n} song${n === 1 ? '' : 's'} and video${n === 1 ? '' : 's'}` : count(st.kind, n);
  if (st.op === 'resize') return `Resize ${count('image', n)} to ${st.pct ? st.pct + '%' : `${st.maxSide} px on the long side`}${overwrite ? ', replacing them (the originals are kept in Versions)' : ' as copies'}`;
  if (st.op === 'convert') return `Convert ${count(st.kind, n)} to ${st.format.toUpperCase()}${overwrite ? ' and send the originals to the Recycle Bin' : ', keeping the originals'}`;
  if (st.op === 'rename') { const b = cap(st.base || DEFAULT_BASE[st.kind] || 'File'); return `Rename ${count(st.kind, n)} to ${b} ${pad(1, n)}${n > 1 ? ` … ${b} ${pad(n, n)}` : ''}${st.order === 'date' ? ', oldest first' : st.order === 'name' ? ', by name' : ''}`; }
  if (st.op === 'play') return `Play ${st.kind === 'media' ? what2 : count(st.kind, n)} in Dogfile Player`;
  if (st.op === 'slideshow') return `Show ${count('image', n)} as a slideshow in Dogfile Photos`;
  return `${cap(st.op)} ${count(st.kind, n)}`;
}

// ---------------- doing it ----------------
async function loadImage(p) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('This picture can’t be opened')); im.src = (/\.(jpe?g|png|gif|webp|bmp|ico|svg|avif|jfif)$/i.test(p) ? fileUrl(p) : `/media/still?p=${encodeURIComponent(p)}`) + (fileUrl(p).includes('?') ? '&' : '?') + 't=' + Date.now(); });
}
async function resizeOne(p, st, overwrite) {
  const img = await loadImage(p);
  let w = img.naturalWidth, hh = img.naturalHeight;
  const k = st.pct ? st.pct / 100 : Math.min(1, st.maxSide / Math.max(w, hh));
  if (k >= 1) return p; // already that small
  w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const g = c.getContext('2d');
  const ext = (p.split('.').pop() || '').toLowerCase();
  const fmt = ['png', 'webp'].includes(ext) ? ext : 'jpg';
  if (fmt === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, hh);
  const data = c.toDataURL({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt], 0.9);
  const sameFormat = fmt === ext || (fmt === 'jpg' && ['jpg', 'jpeg', 'jfif'].includes(ext));
  if (overwrite && sameFormat) {
    await api('versions:save', p, 'Before resizing').catch(() => {});
    await api('fs:writeDataUrl', p, data);
    return p;
  }
  const out = await api('fs:uniqueName', dirname(p), `${stem(basename(p))} (${st.pct ? st.pct + '%' : st.maxSide + 'px'}).${fmt}`, 'number');
  await api('fs:writeDataUrl', out, data);
  if (overwrite) await api('fs:trash', p).catch(() => {});
  return out;
}

/** Show the plan for `text` on the shelf's files in `card`; false when the request isn't one of these */
export async function shelfRequest(text, card, { scrollDown = () => {}, isStopped = () => false } = {}) {
  const items = [...(state.settings.shelf || [])];
  const { steps, overwrite, rest } = parseShelfRequest(text);
  if (!steps.length) return false;
  const plan = steps.map((st) => ({ st, files: pick(items, st.kind) }));
  const none = plan.filter((x) => !x.files.length);
  card.append(h('p', {}, `On the Drop Shelf: ${describeShelf(items)}. Here’s the plan:`));
  const ol = h('ol', { class: 'as-shelfsteps' }, ...plan.map(({ st, files }) => h('li', { class: files.length ? '' : 'skip' }, files.length ? describeStep(st, files.length, overwrite) : `${cap(st.op)}: there are no ${nounFor(st.kind === 'media' ? 'all' : st.kind, 2)} on the shelf`)));
  card.append(ol);
  if (rest.length) card.append(h('p', { class: 'hint' }, `I didn’t understand: “${rest.join('”, “')}”. I’ll leave that out.`));
  if (none.length === plan.length) return true;
  const go = h('button', { class: 'btn small primary' }, 'Do it');
  const cancel = h('button', { class: 'btn small' }, 'Cancel');
  const acts = h('div', { class: 'as-acts' }, go, cancel);
  card.append(acts);
  scrollDown();
  await new Promise((res) => { go.onclick = () => res(true); cancel.onclick = () => res(false); });
  acts.remove();
  // the shelf follows the files: a renamed or converted file replaces its old path
  let cur = items.slice();
  const swap = (from, to) => { cur = cur.map((x) => (x === from ? to : x)); };
  const lis = [...ol.children];
  for (let i = 0; i < plan.length; i++) {
    if (isStopped()) break;
    const { st } = plan[i];
    const li = lis[i];
    const files = pick(cur, st.kind);
    if (!files.length) continue;
    li.classList.add('doing');
    let ok = 0; const errs = [];
    try {
      if (st.op === 'resize') {
        for (const p of files) { if (isStopped()) break; try { swap(p, await resizeOne(p, st, overwrite)); ok++; } catch (e) { errs.push(`${basename(p)}: ${e.message}`); } }
      } else if (st.op === 'convert') {
        const { convertOne } = await import('./mediatools.js');
        if (st.kind === 'image') {
          for (const p of files) {
            if (isStopped()) break;
            try {
              const img = await loadImage(p); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
              const g = c.getContext('2d'); if (st.format === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(img, 0, 0);
              const out = await api('fs:uniqueName', dirname(p), `${stem(basename(p))}.${st.format}`, 'number');
              await api('fs:writeDataUrl', out, c.toDataURL({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[st.format], 0.92));
              if (overwrite) await api('fs:trash', p).catch(() => {});
              swap(p, out); ok++;
            } catch (e) { errs.push(`${basename(p)}: ${e.message}`); }
          }
        } else {
          for (let k = 0; k < files.length && !isStopped(); k++) {
            const p = files[k];
            if ((p.split('.').pop() || '').toLowerCase() === st.format) { ok++; continue; }
            try {
              const out = await convertOne(p, st.format, { onPct: (pct) => { li.style.setProperty('--pct', `${Math.round(((k + pct / 100) / files.length) * 100)}%`); } });
              if (overwrite) await api('fs:trash', p).catch(() => {});
              swap(p, out); ok++;
            } catch (e) { errs.push(`${basename(p)}: ${e.message}`); }
          }
        }
      } else if (st.op === 'rename') {
        let order = files.slice();
        if (st.order !== 'shelf') {
          const stats = await Promise.all(order.map((p) => api('fs:stat', p).catch(() => null)));
          const m = new Map(order.map((p, k) => [p, stats[k]]));
          order.sort(st.order === 'date' ? (a, b) => (m.get(a)?.mtime || 0) - (m.get(b)?.mtime || 0) : (a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));
        }
        const base = cap(st.base || DEFAULT_BASE[st.kind] || 'File');
        const pairs = order.map((p, k) => { const ext = basename(p).includes('.') ? '.' + p.split('.').pop() : ''; return { from: p, to: pjoin(dirname(p), `${base} ${pad(k + 1, order.length)}${ext}`) }; });
        const A = await import('./actions.js');
        const done = await A.renamePairs(pairs, `Rename ${pairs.length} files from the Drop Shelf`);
        for (const [from, to] of done || []) swap(from, to);
        ok = done?.length || 0;
      } else if (st.op === 'play') {
        const { openTool } = await import('./apptabs.js');
        openTool('player', files, { play: true, inTab: true });
        ok = files.length;
      } else if (st.op === 'slideshow') {
        const { openTool } = await import('./apptabs.js');
        openTool('viewer', files, { slideshow: true, inTab: true });
        ok = files.length;
      }
    } catch (e) { errs.push(e.message || String(e)); }
    li.classList.remove('doing');
    li.classList.add(errs.length && !ok ? 'failed' : 'done');
    if (errs.length) li.append(h('div', { class: 'hint' }, errs.slice(0, 3).join(' · ') + (errs.length > 3 ? ` and ${errs.length - 3} more` : '')));
    scrollDown();
  }
  state.settings.shelf = cur;
  saveSettings();
  bus.emit('shelfChanged');
  bus.emit('refreshPanes');
  card.append(h('p', {}, isStopped() ? 'Stopped. The shelf shows the files as they are now.' : 'Done. The shelf now holds the new files.'));
  scrollDown();
  return true;
}
