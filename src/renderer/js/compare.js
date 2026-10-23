// Compare two files, whatever they are: text and code open side by side in Notepad (edit either side, copy
// changes across, save each); pictures get a visual compare (side by side, a slider, a fade, and a map of the
// pixels that changed); Word, PDF, Excel and PowerPoint files compare their text; anything else is compared
// byte by byte with a hex view of each difference.
import { api, h, esc, toast, basename, fmtSize, fmtDate, fileUrl, KINDS } from './core.js';
import { openTool } from './apptabs.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';

const DOC_EXT = new Set(['docx', 'odt', 'rtf', 'pdf', 'xlsx', 'ods', 'pptx', 'odp']);
const ext = (p) => (/\.([^.\\/]+)$/.exec(p) || [])[1]?.toLowerCase() || '';

/** text or not, from the first 8 KB (no zero bytes, mostly printable) */
async function looksText(p) {
  const b = await api('fs:readBytes', p, 8192).catch(() => []);
  if (!b.length) return true;
  let odd = 0;
  for (const x of b) { if (x === 0) return false; if (x < 9 || (x > 13 && x < 32)) odd++; }
  return odd / b.length < 0.02;
}

/** compare two files: picks the right view for what they are */
export async function compareFiles(a, b) {
  if (!a || !b) return toast('Select two files to compare', { error: true });
  const [sa, sb] = await Promise.all([api('fs:stat', a).catch(() => null), api('fs:stat', b).catch(() => null)]);
  if (!sa || !sb) return toast('One of the files is gone', { error: true });
  if (sa.isDir || sb.isDir) return toast('Pick two files (to compare folders, use Compare folders)', { error: true });
  const ea = ext(a), eb = ext(b);
  if (KINDS.image.includes(ea) && KINDS.image.includes(eb)) return compareImages(a, b, sa, sb);
  if (DOC_EXT.has(ea) || DOC_EXT.has(eb)) return compareDocuments(a, b);
  if ((await looksText(a)) && (await looksText(b))) return openTool('editor', [a, b], { compare: true });
  return compareBinary(a, b);
}

// ---------------------------------------------------------------------------------------------------------------
// a line diff (Myers), then the words that changed inside changed lines

/** [['=' | '-' | '+', item]…] turning a into b */
export function diff(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length;
  // the shared start and end are cut first: diffs are usually small
  let s = 0; while (s < n && s < m && eq(a[s], b[s])) s++;
  let e = 0; while (e < n - s && e < m - s && eq(a[n - 1 - e], b[m - 1 - e])) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e);
  const N = A.length, M = B.length;
  const out = a.slice(0, s).map((x) => ['=', x]);
  if (N * M === 0 || N + M > 40000) {
    // nothing in common left (or too big to search): all of one, then all of the other
    for (const x of A) out.push(['-', x]);
    for (const x of B) out.push(['+', x]);
  } else {
    const V = new Map([[1, 0]]);
    const trace = [];
    let found = false;
    for (let d = 0; d <= N + M && !found; d++) {
      trace.push(new Map(V));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && (V.get(k - 1) ?? -1) < (V.get(k + 1) ?? -1)) ? V.get(k + 1) ?? 0 : (V.get(k - 1) ?? 0) + 1;
        let y = x - k;
        while (x < N && y < M && eq(A[x], B[y])) { x++; y++; }
        V.set(k, x);
        if (x >= N && y >= M) { found = true; break; }
      }
    }
    // walk back through the trace
    const ops = [];
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const Vd = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && (Vd.get(k - 1) ?? -1) < (Vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
      const px = Vd.get(prevK) ?? 0, py = px - prevK;
      while (x > px && y > py) { ops.push(['=', A[x - 1]]); x--; y--; }
      if (d > 0) { if (x === px) ops.push(['+', B[y - 1]]); else ops.push(['-', A[x - 1]]); }
      x = px; y = py;
    }
    while (x > 0 && y > 0) { ops.push(['=', A[x - 1]]); x--; y--; }
    out.push(...ops.reverse());
  }
  for (const x of a.slice(n - e)) out.push(['=', x]);
  return out;
}
const words = (s) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
/** a changed line with its changed words marked */
function markWords(a, b) {
  const d = diff(words(a), words(b));
  const left = d.filter((x) => x[0] !== '+').map(([o, w]) => (o === '-' ? `<mark>${esc(w)}</mark>` : esc(w))).join('');
  const right = d.filter((x) => x[0] !== '-').map(([o, w]) => (o === '+' ? `<mark>${esc(w)}</mark>` : esc(w))).join('');
  return [left, right];
}
/** side-by-side rows: [{ l, r, kind: 'same' | 'change' | 'del' | 'add', ln, rn }] */
export function rowsOf(aLines, bLines) {
  const d = diff(aLines, bLines);
  const rows = [];
  let ln = 0, rn = 0;
  for (let i = 0; i < d.length;) {
    if (d[i][0] === '=') { ln++; rn++; rows.push({ kind: 'same', l: esc(d[i][1]), r: esc(d[i][1]), ln, rn }); i++; continue; }
    const del = [], add = [];
    while (i < d.length && d[i][0] !== '=') { (d[i][0] === '-' ? del : add).push(d[i][1]); i++; }
    for (let j = 0; j < Math.max(del.length, add.length); j++) {
      const a = del[j], b = add[j];
      if (a != null && b != null) { const [l, r] = markWords(a, b); rows.push({ kind: 'change', l, r, ln: ++ln, rn: ++rn }); }
      else if (a != null) rows.push({ kind: 'del', l: esc(a), r: '', ln: ++ln, rn: null });
      else rows.push({ kind: 'add', l: '', r: esc(b), ln: null, rn: ++rn });
    }
  }
  return rows;
}

function head(a, b, sa, sb, extra = '') {
  const side = (p, s) => h('div', { class: 'cf-file', title: p }, h('b', {}, basename(p)), h('span', { class: 'hint' }, `${fmtSize(s?.size || 0)} · ${fmtDate(s?.mtime, 'iso')}${extra && s?.dim ? ` · ${s.dim}` : ''}`));
  return h('div', { class: 'cf-head' }, side(a, sa), h('span', { class: 'cf-vs', html: icon('compare') }), side(b, sb));
}

// ---------------------------------------------------------------------------------------------------------------
// documents: their text, side by side

export async function compareDocuments(a, b) {
  toast('Reading both documents…', { ms: 1500 });
  let ta, tb;
  try { [ta, tb] = await Promise.all([api('doc:text', a, 2_000_000), api('doc:text', b, 2_000_000)]); }
  catch (e) { return toast(`Couldn’t read them: ${e.message}`, { error: true }); }
  const [sa, sb] = await Promise.all([api('fs:stat', a).catch(() => null), api('fs:stat', b).catch(() => null)]);
  const norm = (t) => String(t || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  showTextDiff(a, b, sa, sb, norm(ta), norm(tb), 'Text of the documents (formatting isn’t compared)');
}

function showTextDiff(a, b, sa, sb, la, lb, note) {
  const rows = rowsOf(la, lb);
  const changes = rows.filter((r) => r.kind !== 'same').length;
  const grid = h('div', { class: 'cf-text' });
  let onlyChanges = changes > 0;
  const draw = () => {
    const html = [];
    let hidden = 0;
    const flush = () => { if (hidden) html.push(`<div class="cf-gap">${hidden} unchanged line${hidden === 1 ? '' : 's'}</div>`); hidden = 0; };
    rows.forEach((r, i) => {
      // with "only changes", unchanged lines more than 3 away from a change fold away
      if (onlyChanges && r.kind === 'same') {
        const near = rows.slice(Math.max(0, i - 3), i + 4).some((x) => x.kind !== 'same');
        if (!near) { hidden++; return; }
      }
      flush();
      html.push(`<div class="cf-row ${r.kind}"><span class="cf-n">${r.ln ?? ''}</span><span class="cf-l">${r.l || '&nbsp;'}</span><span class="cf-n">${r.rn ?? ''}</span><span class="cf-r">${r.r || '&nbsp;'}</span></div>`);
    });
    flush();
    grid.innerHTML = html.join('') || '<div class="hint pad">Both are empty.</div>';
  };
  draw();
  let at = -1;
  const jump = (dir) => {
    const ch = [...grid.querySelectorAll('.cf-row:not(.same)')].filter((el, i, all) => !all[i - 1] || all[i - 1] !== el.previousElementSibling);
    if (!ch.length) return;
    at = (at + dir + ch.length) % ch.length;
    ch[at].scrollIntoView({ block: 'center', behavior: 'smooth' });
    grid.querySelectorAll('.cf-row.cur').forEach((x) => x.classList.remove('cur'));
    ch[at].classList.add('cur');
  };
  const only = h('input', { type: 'checkbox', checked: onlyChanges });
  only.onchange = () => { onlyChanges = only.checked; draw(); };
  const body = h('div', { class: 'cf' }, head(a, b, sa, sb),
    h('div', { class: 'cf-bar' }, h('span', { class: 'cf-sum' + (changes ? '' : ' same') }, changes ? `${changes} line${changes === 1 ? '' : 's'} differ` : 'The text is identical'),
      note ? h('span', { class: 'hint' }, note) : null, h('span', { style: { flex: '1' } }),
      h('label', { class: 'check' }, only, ' Only changes'),
      h('button', { class: 'btn small', onclick: () => jump(-1), title: 'Previous change' }, '↑'), h('button', { class: 'btn small', onclick: () => jump(1), title: 'Next change' }, '↓')),
    grid);
  modal({ title: 'Compare', body, width: 'min(1200px, 94vw)', className: 'cf-modal', buttons: [{ label: 'Close', primary: true }] });
  body.addEventListener('keydown', (e) => { if (e.key === 'F7') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });
}

// ---------------------------------------------------------------------------------------------------------------
// pictures

function load(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Couldn’t open the picture')); i.src = src; }); }

export async function compareImages(a, b, sa, sb) {
  let A, B;
  try { [A, B] = await Promise.all([load(fileUrl(a)), load(fileUrl(b))]); } catch (e) { return toast(e.message, { error: true }); }
  sa = { ...sa, dim: `${A.naturalWidth}×${A.naturalHeight}` }; sb = { ...sb, dim: `${B.naturalWidth}×${B.naturalHeight}` };
  let mode = 'slider';
  const stage = h('div', { class: 'ci-stage' });
  const info = h('span', { class: 'cf-sum' });
  const ctl = h('div', { class: 'ci-ctl' });
  const sameSize = A.naturalWidth === B.naturalWidth && A.naturalHeight === B.naturalHeight;
  // the pixel map: both drawn at the same size, the differences in colour over a faded copy
  let diffInfo = null;
  const makeDiff = () => {
    if (diffInfo) return diffInfo;
    const w = Math.min(1600, Math.max(A.naturalWidth, B.naturalWidth)), hh = Math.round(w * (A.naturalHeight / A.naturalWidth));
    const c1 = document.createElement('canvas'), c2 = document.createElement('canvas'), out = document.createElement('canvas');
    for (const c of [c1, c2, out]) { c.width = w; c.height = hh; }
    const x1 = c1.getContext('2d'), x2 = c2.getContext('2d'), xo = out.getContext('2d');
    x1.drawImage(A, 0, 0, w, hh); x2.drawImage(B, 0, 0, w, hh);
    const d1 = x1.getImageData(0, 0, w, hh), d2 = x2.getImageData(0, 0, w, hh), o = xo.createImageData(w, hh);
    let changed = 0;
    for (let i = 0; i < d1.data.length; i += 4) {
      const dd = Math.abs(d1.data[i] - d2.data[i]) + Math.abs(d1.data[i + 1] - d2.data[i + 1]) + Math.abs(d1.data[i + 2] - d2.data[i + 2]) + Math.abs(d1.data[i + 3] - d2.data[i + 3]);
      const g = (d1.data[i] * 0.3 + d1.data[i + 1] * 0.59 + d1.data[i + 2] * 0.11) * 0.35 + 165;
      if (dd > 24) { changed++; o.data[i] = 255; o.data[i + 1] = 0; o.data[i + 2] = 140; o.data[i + 3] = 255; }
      else { o.data[i] = o.data[i + 1] = o.data[i + 2] = g; o.data[i + 3] = 255; }
    }
    xo.putImageData(o, 0, 0);
    diffInfo = { canvas: out, pct: (changed / (w * hh)) * 100 };
    return diffInfo;
  };
  const draw = () => {
    stage.innerHTML = ''; ctl.innerHTML = '';
    stage.className = `ci-stage m-${mode}`;
    const ia = h('img', { src: A.src, draggable: 'false' }), ib = h('img', { src: B.src, draggable: 'false' });
    if (mode === 'side') stage.append(h('div', { class: 'ci-half' }, ia), h('div', { class: 'ci-half' }, ib));
    else if (mode === 'slider' || mode === 'fade') {
      const top = h('div', { class: 'ci-top' }, ib);
      const box = h('div', { class: 'ci-box' }, ia, top);
      stage.append(box);
      const r = h('input', { type: 'range', min: 0, max: 100, value: 50, class: 'ci-range' });
      const set = () => { if (mode === 'slider') { top.style.clipPath = `inset(0 0 0 ${r.value}%)`; top.style.opacity = 1; box.style.setProperty('--x', r.value + '%'); } else { top.style.clipPath = 'none'; top.style.opacity = r.value / 100; } };
      r.oninput = set; set();
      if (mode === 'slider') {
        box.append(h('div', { class: 'ci-line' }));
        box.addEventListener('pointermove', (e) => { if (e.buttons !== 1) return; const rc = box.getBoundingClientRect(); r.value = Math.max(0, Math.min(100, ((e.clientX - rc.left) / rc.width) * 100)); set(); });
        box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); const rc = box.getBoundingClientRect(); r.value = ((e.clientX - rc.left) / rc.width) * 100; set(); });
      }
      ctl.append(h('span', { class: 'hint' }, basename(a)), r, h('span', { class: 'hint' }, basename(b)));
    } else {
      const d = makeDiff();
      d.canvas.className = 'ci-diff';
      stage.append(d.canvas);
      ctl.append(h('span', { class: 'hint' }, 'Pink shows what’s different'));
    }
    const d = mode === 'diff' ? diffInfo : null;
    info.className = 'cf-sum' + (mode === 'diff' && diffInfo?.pct === 0 && sameSize ? ' same' : mode === 'diff' || !sameSize ? '' : ' neutral');
    info.textContent = !sameSize ? `Different sizes (${sa.dim} and ${sb.dim})${d ? ` · about ${d.pct.toFixed(d.pct < 1 ? 2 : 1)}% differs once scaled` : ''}` : d ? (d.pct === 0 ? 'Identical pixels' : `${d.pct.toFixed(d.pct < 1 ? 2 : 1)}% of the pixels differ`) : 'Same size';
  };
  const seg = h('div', { class: 'seg' });
  const modes = [['slider', 'Slider'], ['side', 'Side by side'], ['fade', 'Fade'], ['diff', 'Differences']];
  for (const [k, l] of modes) seg.append(h('button', { class: 'seg-btn' + (k === mode ? ' on' : ''), onclick: (e) => { mode = k; seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); draw(); } }, l));
  draw();
  const body = h('div', { class: 'cf' }, head(a, b, sa, sb, 'dim'), h('div', { class: 'cf-bar' }, seg, h('span', { style: { flex: '1' } }), info), stage, ctl);
  modal({ title: 'Compare pictures', body, width: 'min(1200px, 94vw)', className: 'cf-modal', buttons: [{ label: 'Close', primary: true }] });
}

// ---------------------------------------------------------------------------------------------------------------
// any other file: byte by byte, with a hex view of each difference

export async function compareBinary(a, b) {
  toast('Comparing byte by byte…', { ms: 1500 });
  let r;
  try { r = await api('fs:compareBinary', a, b, 2000); } catch (e) { return toast(e.message, { error: true }); }
  const [sa, sb] = await Promise.all([api('fs:stat', a).catch(() => null), api('fs:stat', b).catch(() => null)]);
  const list = h('div', { class: 'cb-list' });
  const hex = h('div', { class: 'cb-hex' });
  const hx = (n, w = 8) => n.toString(16).toUpperCase().padStart(w, '0');
  const show = async (i) => {
    const [s, e] = r.ranges[i];
    list.querySelectorAll('.cb-item').forEach((x, j) => x.classList.toggle('on', j === i));
    const from = Math.max(0, Math.floor(s / 16) * 16 - 48);
    const len = Math.min(Math.ceil((e - from) / 16) * 16 + 64, 4096);
    const [ba, bb] = await Promise.all([api('fs:readBytes', a, len, from), api('fs:readBytes', b, len, from)]);
    const side = (mine, other) => {
      const lines = [];
      for (let o = 0; o < len; o += 16) {
        if (o >= mine.length && o >= other.length) break;
        let hexs = '', txt = '';
        for (let k = 0; k < 16; k++) {
          const x = mine[o + k], y = other[o + k];
          const bad = x !== y;
          const v = x == null ? '  ' : hx(x, 2);
          hexs += `<span class="${bad ? 'd' : ''}">${v}</span>${k === 7 ? '  ' : ' '}`;
          txt += x == null ? ' ' : `<span class="${bad ? 'd' : ''}">${x >= 32 && x < 127 ? esc(String.fromCharCode(x)) : '.'}</span>`;
        }
        lines.push(`<div><span class="cb-off">${hx(from + o)}</span>  ${hexs} ${txt}</div>`);
      }
      return lines.join('');
    };
    hex.innerHTML = `<div class="cb-col"><b>${esc(basename(a))}</b>${side(ba, bb)}</div><div class="cb-col"><b>${esc(basename(b))}</b>${side(bb, ba)}</div>`;
  };
  r.ranges.forEach(([s, e], i) => list.append(h('button', { class: 'cb-item', onclick: () => show(i) }, h('b', {}, `0x${hx(s)}`), h('span', { class: 'hint' }, e - s === 1 ? '1 byte' : `${(e - s).toLocaleString()} bytes`))));
  const sum = r.identical ? 'The files are identical, byte for byte'
    : `${r.diffBytes.toLocaleString()} byte${r.diffBytes === 1 ? '' : 's'} differ in ${r.ranges.length}${r.truncated ? '+' : ''} place${r.ranges.length === 1 ? '' : 's'}${r.sizeA !== r.sizeB ? ` · sizes differ by ${fmtSize(r.extra)}` : ''}`;
  const body = h('div', { class: 'cf' }, head(a, b, sa, sb),
    h('div', { class: 'cf-bar' }, h('span', { class: 'cf-sum' + (r.identical ? ' same' : '') }, sum)),
    r.identical ? h('div', { class: 'hint pad' }, 'Every byte matches.') : h('div', { class: 'cb' }, list, hex));
  modal({ title: 'Compare files', body, width: 'min(1200px, 94vw)', className: 'cf-modal', buttons: [{ label: 'Close', primary: true }] });
  if (r.ranges.length) show(0);
}
