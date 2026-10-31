// Modal dialogs: prompt, confirm, conflict resolution, batch rename, properties, select-by-pattern, compress.
import { api, h, esc, fmtSize, fmtDate, basename, dirname, extname, stem, pjoin, typeLabel, state, IS_WIN, toast, natCmp, tagsOf, setTags } from './core.js';
import { icon } from './icons.js';
import { closeMenus } from './menu.js';

const openModals = [];

export function modal({ title, body, buttons = [], width = 460, className = '', onClose, closeOnBackdrop = true, noPadding }) {
  closeMenus(0);
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal ' + className, role: 'dialog', 'aria-modal': 'true', style: { width: typeof width === 'number' ? width + 'px' : width } });
    const close = (v) => { back.remove(); openModals.splice(openModals.indexOf(close), 1); onClose?.(v); resolve(v); };
    const head = h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title || ''), h('button', { class: 'icon-btn', title: 'Close', html: icon('close'), onclick: () => close(null) }));
    const content = h('div', { class: 'modal-body' + (noPadding ? ' np' : '') });
    if (typeof body === 'string') content.innerHTML = body; else if (body) content.append(body);
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      if (b.el) { if (b.left) b.el.classList.add('left'); foot.append(b.el); continue; }
      const btn = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') + (b.left ? ' left' : '') }, b.label);
      btn.addEventListener('click', async () => { if (b.run) { const r = await b.run(close); if (r === false) return; } else close(b.value); });
      foot.append(btn);
    }
    box.append(head, content);
    if (buttons.length) box.append(foot);
    back.append(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back && closeOnBackdrop) close(null); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && !e.target.closest('.no-enter')) {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); foot.querySelector('.primary').click(); }
      }
      e.stopPropagation();
    });
    document.body.append(back);
    openModals.push(close);
    setTimeout(() => { const f = box.querySelector('[autofocus], input, textarea, select, .btn.primary'); f?.focus(); if (f?.select && f.dataset.selectStem) { const v = f.value; const i = v.lastIndexOf('.'); f.setSelectionRange(0, i > 0 ? i : v.length); } else f?.select?.(); }, 20);
    box._close = close;
  });
}
export const anyModalOpen = () => openModals.length > 0;
export const closeTopModal = () => openModals[openModals.length - 1]?.(null);

export function prompt(title, value = '', opts = {}) {
  const input = h('input', { class: 'input', value, spellcheck: 'false', placeholder: opts.placeholder || '', 'data-select-stem': opts.selectStem ? '1' : null });
  const err = h('div', { class: 'field-error' });
  const body = h('div', {}, opts.label ? h('label', { class: 'field-label' }, opts.label) : null, input, err, opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
  return modal({
    title, body, width: opts.width || 440,
    buttons: [{ label: 'Cancel', value: null }, {
      label: opts.ok || 'OK', primary: true, run: (close) => {
        const v = input.value;
        const e = opts.validate?.(v);
        if (e) { err.textContent = e; return false; }
        close(v);
      },
    }],
  });
}

export function confirm(title, message, opts = {}) {
  return modal({
    title, body: h('div', { class: 'confirm-msg', html: message }), width: opts.width || 420,
    buttons: [{ label: opts.cancel || 'Cancel', value: false }, { label: opts.ok || 'OK', primary: true, danger: opts.danger, value: true }],
  }).then((v) => !!v);
}

export function alertBox(title, message) {
  return modal({ title, body: h('div', { class: 'confirm-msg', html: message }), buttons: [{ label: 'OK', primary: true, value: true }] });
}

// ---------- conflict ----------
export function conflictDialog(info) {
  const name = basename(info.dst);
  const card = (label, size, mtime, path) => h('div', { class: 'cf-card' },
    h('div', { class: 'cf-label' }, label),
    h('div', { class: 'cf-path', title: path }, dirname(path) || ''),
    h('div', { class: 'cf-meta' }, `${size != null ? fmtSize(size) : ''} · ${fmtDate(mtime)}`));
  const newer = info.srcMtime > info.dstMtime ? 'The file you are copying is newer.' : info.srcMtime < info.dstMtime ? 'The file already there is newer.' : 'Both have the same date.';
  const all = h('input', { type: 'checkbox', id: 'cf-all' });
  const body = h('div', { class: 'conflict' },
    h('p', {}, h('b', {}, name), ' already exists in the destination.'),
    h('div', { class: 'cf-cards' }, card('Incoming', info.srcSize, info.srcMtime, info.src), card('Existing', info.dstSize, info.dstMtime, info.dst)),
    h('p', { class: 'hint' }, newer),
    h('label', { class: 'check' }, all, ' Do this for all conflicts'));
  return modal({
    title: 'Replace or skip files', body, width: 520, closeOnBackdrop: false,
    buttons: [
      { label: 'Cancel job', left: true, run: (c) => c({ action: 'cancel' }) },
      { label: 'Skip', run: (c) => c({ action: 'skip', applyAll: all.checked }) },
      { label: 'Keep newer', run: (c) => c({ action: 'newer', applyAll: all.checked }) },
      { label: 'Skip if identical', run: (c) => c({ action: 'skipIdentical', applyAll: all.checked }) },
      { label: 'Keep both', run: (c) => c({ action: 'keepBoth', applyAll: all.checked }) },
      { label: 'Replace', primary: true, run: (c) => c({ action: 'replace', applyAll: all.checked }) },
    ],
  }).then((v) => v || { action: 'skip' });
}

// ---------- batch rename ----------
export async function batchRenameDialog(items, doRename) {
  const f = {
    find: h('input', { class: 'input', placeholder: 'Find (text or regex)' }),
    replace: h('input', { class: 'input', placeholder: 'Replace with ($1, $2 … for regex groups)' }),
    regex: h('input', { type: 'checkbox' }), cs: h('input', { type: 'checkbox' }), ext: h('input', { type: 'checkbox' }),
    template: h('input', { class: 'input', placeholder: 'e.g. Holiday_{n:3}_{date}{ext}   (leave blank to keep names)' }),
    start: h('input', { class: 'input small', type: 'number', value: '1' }), step: h('input', { class: 'input small', type: 'number', value: '1' }),
    caseMode: h('select', { class: 'input' }, ...['Keep case', 'lowercase', 'UPPERCASE', 'Title Case', 'Sentence case', 'camelCase', 'kebab-case', 'snake_case'].map((c) => h('option', {}, c))),
    prefix: h('input', { class: 'input', placeholder: 'Prefix' }), suffix: h('input', { class: 'input', placeholder: 'Suffix (before extension)' }),
    trim: h('input', { type: 'checkbox' }), spaces: h('input', { type: 'checkbox' }),
  };
  const sorted = [...items].sort((a, b) => natCmp(a.name, b.name));
  const table = h('div', { class: 'br-table' });
  const status = h('div', { class: 'hint' });
  const compute = () => {
    let re = null;
    if (f.find.value) {
      try { re = f.regex.checked ? new RegExp(f.find.value, f.cs.checked ? 'g' : 'gi') : new RegExp(f.find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f.cs.checked ? 'g' : 'gi'); }
      catch { status.textContent = 'Invalid regular expression'; return null; }
    }
    const start = +f.start.value || 0, step = +f.step.value || 1;
    const out = sorted.map((it, i) => {
      const ext = it.isDir ? '' : extname(it.name);
      const dotExt = ext ? '.' + it.name.slice(it.name.lastIndexOf('.') + 1) : '';
      let base = it.isDir || f.ext.checked ? it.name : stem(it.name);
      if (f.template.value) {
        const d = new Date(it.mtime || Date.now());
        const z = (x) => String(x).padStart(2, '0');
        base = f.template.value
          .replace(/\{n(?::(\d+))?\}/g, (m, w) => String(start + i * step).padStart(+w || 0, '0'))
          .replace(/\{name\}/g, base)
          .replace(/\{date\}/g, `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`)
          .replace(/\{yyyy\}/g, d.getFullYear()).replace(/\{yy\}/g, String(d.getFullYear()).slice(2)).replace(/\{mm\}/g, z(d.getMonth() + 1)).replace(/\{dd\}/g, z(d.getDate()))
          .replace(/\{hh\}/g, z(d.getHours())).replace(/\{min\}/g, z(d.getMinutes())).replace(/\{ss\}/g, z(d.getSeconds()))
          .replace(/\{time\}/g, `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`)
          .replace(/\{parent\}/g, basename(dirname(it.path)))
          .replace(/\{ext\}/g, '');
      }
      if (re) base = base.replace(re, f.replace.value);
      if (f.trim.checked) base = base.trim();
      if (f.spaces.checked) base = base.replace(/\s+/g, '_');
      const cm = f.caseMode.value;
      const words = () => base.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_\-]+/).filter(Boolean);
      if (cm === 'lowercase') base = base.toLowerCase();
      else if (cm === 'UPPERCASE') base = base.toUpperCase();
      else if (cm === 'Title Case') base = base.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      else if (cm === 'Sentence case') base = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
      else if (cm === 'camelCase') base = words().map((w, k) => (k ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
      else if (cm === 'kebab-case') base = words().join('-').toLowerCase();
      else if (cm === 'snake_case') base = words().join('_').toLowerCase();
      base = f.prefix.value + base + f.suffix.value;
      const name = it.isDir || f.ext.checked ? base : base + dotExt;
      return { it, name };
    });
    const seen = new Map();
    let conflicts = 0, changes = 0;
    for (const o of out) { const k = o.name.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
    for (const o of out) {
      o.dup = seen.get(o.name.toLowerCase()) > 1;
      o.bad = !o.name || /[<>:"/\\|?*\x00-\x1f]/.test(o.name) || /[. ]$/.test(o.name);
      if (o.dup || o.bad) conflicts++;
      if (o.name !== o.it.name) changes++;
    }
    status.textContent = `${changes} of ${out.length} will change${conflicts ? ` · ${conflicts} problem${conflicts > 1 ? 's' : ''}` : ''}`;
    status.classList.toggle('err', !!conflicts);
    table.innerHTML = '<div class="br-row br-head"><div>Current name</div><div>New name</div></div>' + out.slice(0, 500).map((o) => `<div class="br-row ${o.name !== o.it.name ? 'chg' : ''} ${o.dup || o.bad ? 'bad' : ''}"><div>${esc(o.it.name)}</div><div>${esc(o.name)}</div></div>`).join('');
    return conflicts ? null : out;
  };
  Object.values(f).forEach((el) => el.addEventListener('input', compute));
  // "Describe it": plain-English instructions fill in the options below (live preview)
  const describe = h('input', { class: 'input br-describe', placeholder: 'Describe it, e.g. “format as YYYY-MM-DD_Invoice and lowercase everything”', spellcheck: 'false' });
  const understood = h('div', { class: 'hint br-understood' });
  describe.addEventListener('input', () => { const r = interpretRename(describe.value); applyInterpretation(f, r); understood.textContent = r.notes.length ? 'Understood: ' + r.notes.join(' · ') : describe.value.trim() ? 'Try words like: lowercase, replace X with Y, remove X, add X at the start, number them from 1 with 3 digits, format as YYYY-MM-DD_{name}' : ''; compute(); });
  const row = (...c) => h('div', { class: 'br-line' }, ...c);
  const body = h('div', { class: 'batch-rename' },
    h('div', { class: 'br-ask' }, describe, understood),
    row(f.find, f.replace),
    row(h('label', { class: 'check' }, f.regex, ' Regex'), h('label', { class: 'check' }, f.cs, ' Match case'), h('label', { class: 'check' }, f.ext, ' Include extension'), h('label', { class: 'check' }, f.trim, ' Trim'), h('label', { class: 'check' }, f.spaces, ' Spaces → _')),
    row(f.template, h('span', { class: 'hint' }, 'Start'), f.start, h('span', { class: 'hint' }, 'Step'), f.step),
    row(f.prefix, f.suffix, f.caseMode),
    h('div', { class: 'hint' }, 'Tokens: {n} {n:3} {name} {date} {yyyy} {mm} {dd} {time} {parent}'),
    table, status);
  compute();
  return modal({
    title: `Rename ${items.length} items`, body, width: 760,
    buttons: [{ label: 'Cancel', value: null }, {
      label: 'Rename', primary: true, run: async (close) => {
        const out = compute();
        if (!out) return false;
        await doRename(out.filter((o) => o.name !== o.it.name).map((o) => ({ from: o.it.path, to: pjoin(dirname(o.it.path), o.name) })));
        close(true);
      },
    }],
  });
}

// plain-English rename instructions -> batch rename options
export { interpretRename } from './rename-words.js';
import { interpretRename } from './rename-words.js';
function applyInterpretation(f, r) {
  f.find.value = r.find ?? ''; f.replace.value = r.replace ?? ''; f.regex.checked = !!r.regex;
  f.template.value = r.template ?? ''; f.start.value = String(r.start ?? 1); f.step.value = String(r.step ?? 1);
  f.caseMode.value = r.caseMode || 'Keep case'; f.prefix.value = r.prefix ?? ''; f.suffix.value = r.suffix ?? '';
  f.trim.checked = !!r.trim; f.spaces.checked = !!r.spaces;
}

// ---------- select by pattern ----------
export function selectPatternDialog() {
  const input = h('input', { class: 'input', placeholder: '*.jpg;*.png   or   /regex/' });
  const mode = h('select', { class: 'input' }, h('option', { value: 'replace' }, 'Select matching'), h('option', { value: 'add' }, 'Add matching to selection'), h('option', { value: 'remove' }, 'Deselect matching'));
  return modal({ title: 'Select by pattern', body: h('div', { class: 'stack' }, input, mode, h('div', { class: 'hint' }, 'Wildcards * and ?, separate multiple with ;, wrap in /…/ for a regular expression.')), buttons: [{ label: 'Cancel', value: null }, { label: 'Select', primary: true, run: (c) => c({ pattern: input.value, mode: mode.value }) }] });
}

export function patternToTest(pattern) {
  pattern = pattern.trim();
  if (/^\/.*\/[a-z]*$/.test(pattern)) { const i = pattern.lastIndexOf('/'); const re = new RegExp(pattern.slice(1, i), pattern.slice(i + 1) || 'i'); return (n) => re.test(n); }
  const parts = pattern.split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
  return (n) => parts.some((r) => r.test(n));
}

// ---------- compress ----------
// sizes to split an archive into (7-Zip volume sizes)
const SPLITS = [['', 'Don’t split'], ['10m', '10 MB'], ['25m', '25 MB (email)'], ['100m', '100 MB'], ['650m', '650 MB (CD)'], ['700m', '700 MB (CD)'], ['4092m', '4 GB (FAT32 USB stick)'], ['4480m', '4.7 GB (DVD)'], ['8100m', '8.5 GB (dual-layer DVD)'], ['23800m', '25 GB (Blu-ray)'], ['custom', 'Custom size…']];
const DICTS = ['', '64k', '1m', '4m', '16m', '32m', '64m', '128m', '256m', '512m', '1024m', '1536m'];
/** the Compress dialog: format, level; and (More options) method, dictionary, solid, threads, splitting,
 *  password or keyfile, encryption, excludes, recycling the originals. The last choices are remembered. */
export function compressDialog(defaultName, has7z) {
  const last = state.settings.compressLast || {};
  const sel = (opts, v) => { const x = h('select', { class: 'input' }, ...opts.map(([k, l]) => h('option', { value: k }, l))); x.value = v ?? opts[0][0]; return x; };
  const name = h('input', { class: 'input', value: defaultName });
  const fmt = sel([['zip', 'ZIP'], ['7z', '7Z'], ['tar', 'TAR'], ['tar.gz', 'TAR.GZ'], ['tar.xz', 'TAR.XZ'], ['tar.bz2', 'TAR.BZ2'], ['wim', 'WIM']].filter(([k]) => has7z || !['wim'].includes(k)), last.format || 'zip');
  const level = sel([['', 'Default'], ['0', 'Store (no compression)'], ['1', 'Fastest'], ['3', 'Fast'], ['5', 'Normal'], ['7', 'Maximum'], ['9', 'Ultra']], last.level ?? '');
  const method = h('select', { class: 'input' });
  const dict = sel(DICTS.map((d) => [d, d ? d.replace(/(\d+)k$/, '$1 KB').replace(/(\d+)m$/, '$1 MB') : 'Default']), last.dictionary ?? '');
  const solid = sel([['', 'Default'], ['on', 'Solid (smallest)'], ['off', 'Not solid (each file on its own)'], ['1g', 'Blocks of 1 GB'], ['256m', 'Blocks of 256 MB'], ['e', 'One block per file type']], last.solid ?? '');
  const threads = sel([['', 'All cores'], ...[1, 2, 4, 8, 16].map((n) => [String(n), `${n} thread${n === 1 ? '' : 's'}`])], last.threads ? String(last.threads) : '');
  const split = sel(SPLITS, SPLITS.some(([k]) => k === last.volume) ? last.volume : last.volume ? 'custom' : '');
  const splitCustom = h('input', { class: 'input', placeholder: 'e.g. 2000 (MB)', value: last.volume && !SPLITS.some(([k]) => k === last.volume) ? String(last.volume).replace(/m$/, '') : '' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: has7z ? 'Password (optional)' : 'Password requires 7-Zip', disabled: !has7z, autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Type it again', disabled: !has7z, autocomplete: 'new-password' });
  let keyfile = '';
  const keyLabel = h('span', { class: 'hint ellipsis' }, 'No keyfile');
  const keyBtn = h('button', { class: 'btn small', disabled: !has7z, onclick: async () => { const [f] = (await api('dialog:openFiles', { title: 'Choose a keyfile (any file you won’t change)' })) || []; if (f) { keyfile = f; keyLabel.textContent = basename(f); keyClear.style.display = ''; } } }, 'Use a keyfile…');
  const keyClear = h('button', { class: 'icon-btn small', title: 'No keyfile', html: icon('close'), style: { display: 'none' }, onclick: () => { keyfile = ''; keyLabel.textContent = 'No keyfile'; keyClear.style.display = 'none'; } });
  const encNames = h('input', { type: 'checkbox', checked: last.encryptNames !== false });
  const zipCrypto = h('input', { type: 'checkbox', checked: !!last.zipCrypto });
  const exclude = h('input', { class: 'input', placeholder: 'e.g. *.tmp, Thumbs.db, node_modules', value: last.exclude || '' });
  const recycle = h('input', { type: 'checkbox', checked: false });
  const fill = () => {
    const f = fmt.value;
    const m = f === '7z' ? [['', 'LZMA2 (default)'], ['LZMA', 'LZMA'], ['PPMd', 'PPMd (good for text)'], ['BZip2', 'BZip2'], ['Copy', 'Copy (no compression)']]
      : f === 'zip' ? [['', 'Deflate (default, opens anywhere)'], ['Deflate64', 'Deflate64'], ['BZip2', 'BZip2'], ['LZMA', 'LZMA'], ['PPMd', 'PPMd']] : [['', 'Default']];
    const keep = method.value || last.method || '';
    method.innerHTML = ''; for (const [k, l] of m) method.append(h('option', { value: k }, l));
    method.value = m.some(([k]) => k === keep) ? keep : '';
    const z7 = has7z && !/^tar\./.test(f);
    for (const el of [method, dict, threads, split, pw, pw2, keyBtn]) el.disabled = !z7 || (el === method && m.length === 1);
    solid.disabled = !(z7 && f === '7z');
    encNames.parentElement.style.display = f === '7z' ? '' : 'none';
    zipCrypto.parentElement.style.display = f === 'zip' ? '' : 'none';
    splitCustom.style.display = split.value === 'custom' ? '' : 'none';
  };
  fmt.onchange = fill; split.onchange = fill;
  const more = h('div', { class: 'cz-more' + (last.open ? ' open' : '') },
    h('div', { class: 'cz-grid' },
      h('label', {}, 'Method'), method, h('label', {}, 'Dictionary size'), dict,
      h('label', {}, 'Solid'), solid, h('label', {}, 'Threads'), threads,
      h('label', {}, 'Split into pieces'), h('div', { class: 'row-inline' }, split, splitCustom)),
    h('div', { class: 'cz-sec' }, h('b', {}, 'Protection'),
      h('div', { class: 'row2' }, pw, pw2),
      h('div', { class: 'row-inline' }, keyBtn, keyLabel, keyClear),
      h('div', { class: 'hint' }, 'Any file you never change, like a photo, can be a second key. Without it the archive won’t open, so keep a copy safe.'),
      h('label', { class: 'check' }, encNames, ' Hide the file names too (7Z)'),
      h('label', { class: 'check' }, zipCrypto, ' Use old ZipCrypto (weaker, only for very old programs)')),
    h('div', { class: 'cz-sec' }, h('b', {}, 'Leave out'), exclude),
    h('label', { class: 'check' }, recycle, ' Move the originals to the Recycle Bin afterwards'));
  const toggle = h('button', { class: 'link cz-toggle', onclick: () => { more.classList.toggle('open'); toggle.textContent = more.classList.contains('open') ? 'Fewer options' : 'More options…'; } }, last.open ? 'Fewer options' : 'More options…');
  fill();
  return modal({
    title: 'Compress', width: 520,
    body: h('div', { class: 'stack cz' }, h('label', { class: 'field-label' }, 'Archive name'), name, h('div', { class: 'row2' }, fmt, level), toggle, more,
      has7z ? null : h('div', { class: 'hint' }, 'Tip: 7-Zip unlocks passwords, compression levels, splitting and more formats.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, run: (c) => {
      if (pw.value !== pw2.value) { toast('The two passwords don’t match', { error: true }); return false; }
      const volume = split.value === 'custom' ? (/^\d+$/.test(splitCustom.value.trim()) ? `${splitCustom.value.trim()}m` : '') : split.value;
      const r = { name: name.value.trim(), format: fmt.value, level: level.value === '' ? null : +level.value, password: pw.value || null, keyfile: keyfile || null,
        method: method.value || null, dictionary: dict.value || null, solid: solid.disabled ? null : solid.value || null, threads: threads.value ? +threads.value : null, volume: volume || null,
        encryptNames: encNames.checked, zipCrypto: zipCrypto.checked, exclude: exclude.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean), recycleAfter: recycle.checked };
      // remember the choices (never the password or keyfile)
      state.settings.compressLast = { format: r.format, level: r.level, method: r.method, dictionary: r.dictionary, solid: r.solid, threads: r.threads, volume: r.volume, encryptNames: r.encryptNames, zipCrypto: r.zipCrypto, exclude: exclude.value, open: more.classList.contains('open') };
      import('./core.js').then((m) => m.saveSettings());
      c(r);
    } }],
  });
}

/** an archive that needs a password: ask for it (or a keyfile) */
export function archivePasswordDialog(file) {
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'off' });
  let keyfile = '';
  const keyLabel = h('span', { class: 'hint ellipsis' }, '');
  return modal({
    title: 'This archive is protected', width: 440,
    body: h('div', { class: 'stack' }, h('div', {}, `${basename(file)} needs its password.`), pw,
      h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: async () => { const [f] = (await api('dialog:openFiles', { title: 'Choose the keyfile' })) || []; if (f) { keyfile = f; keyLabel.textContent = basename(f); } } }, 'Use a keyfile…'), keyLabel),
      h('div', { class: 'hint' }, 'If it was made with a keyfile, choose that file here too.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Extract', primary: true, run: (c) => c({ password: pw.value, keyfile: keyfile || null }) }],
  });
}

// ---------- properties (our own, multi-select aware, with hashes/attributes/timestamps/tags) ----------
export async function propertiesDialog(items, helpers) {
  const single = items.length === 1 ? items[0] : null;
  const tabs = h('div', { class: 'seg' });
  const pane = h('div', { class: 'props-pane' });
  const sections = {};
  const addTab = (id, label, render) => {
    const b = h('button', { class: 'seg-btn', onclick: () => { tabs.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); pane.innerHTML = ''; render(pane); } }, label);
    tabs.append(b); sections[id] = b;
  };
  const kv = (rows) => h('div', { class: 'kv' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));

  addTab('general', 'General', async (el) => {
    const sizeEl = h('span', {}, 'Calculating…');
    const countEl = h('span', {}, '');
    const thumb = h('div', { class: 'props-thumb' });
    helpers.renderThumb(thumb, single || items[0]);
    // the name can be changed right here, like in Windows
    let nameEl;
    if (single && !single.virtual && !single.archive && !single.recycle && !single.drive) {
      nameEl = h('input', { class: 'input props-name-input', value: single.name, spellcheck: 'false', title: 'Type a new name and press Enter', 'data-select-stem': '1' });
      const commit = async () => {
        const nn = nameEl.value.trim();
        if (!nn || nn === single.name) { nameEl.value = single.name; return; }
        if (/[\\/:*?"<>|]/.test(nn)) { toast('A name can’t contain \\ / : * ? " < > |', { error: true }); nameEl.value = single.name; return; }
        const to = pjoin(dirname(single.path), nn);
        try { const A = await import('./actions.js'); await A.renamePairs([{ from: single.path, to }], 'Rename'); single.path = to; single.name = nn; helpers.refresh(); }
        catch (e) { toast(`Couldn’t rename: ${e.message}`, { error: true }); nameEl.value = single.name; }
      };
      nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); } if (e.key === 'Escape') { nameEl.value = single.name; } });
      nameEl.addEventListener('blur', commit);
    } else nameEl = h('div', { class: 'props-name' }, single ? single.name : `${items.length} items`);
    el.append(h('div', { class: 'props-headline' }, thumb, h('div', { class: 'grow' }, nameEl, h('div', { class: 'hint' }, single ? typeLabel(single) : 'Multiple items'))));
    el.append(kv([
      ['Location', single ? dirname(single.path) || '' : dirname(items[0].path) || ''],
      ['Size', sizeEl],
      ['Contains', countEl],
      single && ['Created', fmtDate(single.ctime, 'locale')],
      single && ['Modified', fmtDate(single.mtime, 'locale')],
      single && single.atime && ['Accessed', fmtDate(single.atime, 'locale')],
      single?.isLink && ['Link target', h('span', { class: 'mono' }, '…')],
    ]));
    const tagRow = h('div', { class: 'tag-row' });
    const renderTags = () => {
      tagRow.innerHTML = '';
      const cur = new Set(items.flatMap((i) => tagsOf(i.path)));
      for (const t of state.tags.defs) {
        tagRow.append(h('button', { class: 'tag-chip' + (cur.has(t.id) ? ' on' : ''), style: { '--tag': t.color }, onclick: () => { setTags(items.map((i) => i.path), t.id, !cur.has(t.id)); renderTags(); } }, h('span', { class: 'tdot' }), t.name));
      }
    };
    renderTags();
    el.append(h('div', { class: 'field-label' }, 'Tags'), tagRow);
    let total = 0, files = 0, dirs = 0;
    for (const it of items) {
      if (it.isDir) { const r = await helpers.folderSize(it.path); total += r.total; files += r.files; dirs += r.dirs + 1; } else { total += it.size || 0; files++; }
    }
    sizeEl.textContent = `${fmtSize(total)} (${total.toLocaleString()} bytes)`;
    countEl.textContent = `${files.toLocaleString()} files, ${Math.max(0, dirs - (single?.isDir ? 1 : 0)).toLocaleString()} folders`;
  });

  if (single && !single.isDir) {
    addTab('hashes', 'Hashes', (el) => {
      const out = h('div', { class: 'kv mono' });
      const cmp = h('input', { class: 'input', placeholder: 'Paste a hash to compare…' });
      const res = h('div', { class: 'hint' });
      el.append(h('button', { class: 'btn', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'Computing…';
        try {
          const r = await api('fs:hash', single.path, ['md5', 'sha1', 'sha256', 'sha512']);
          out.innerHTML = '';
          for (const [k, v] of Object.entries(r)) out.append(h('div', { class: 'k' }, k.toUpperCase()), h('div', { class: 'v hashv', title: 'Click to copy', onclick: () => { api('clip:writeText', v); toast(`${k.toUpperCase()} copied`); } }, v));
          const check = () => { const v = cmp.value.trim().toLowerCase(); if (!v) { res.textContent = ''; return; } const hit = Object.entries(r).find(([, x]) => x === v); res.textContent = hit ? `✓ Matches ${hit[0].toUpperCase()}` : '✗ No match'; res.className = 'hint ' + (hit ? 'ok' : 'err'); };
          cmp.oninput = check; check();
        } catch (er) { out.textContent = er.message; }
        e.target.remove();
      } }, 'Compute MD5 / SHA-1 / SHA-256 / SHA-512'), out, cmp, res);
    });
  }

  // title, author and the like, saved inside the file itself (documents, PDFs, music and videos)
  const ex = single && !single.isDir ? (single.ext || (single.name.includes('.') ? single.name.split('.').pop().toLowerCase() : '')) : '';
  const DOCS = ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm'];
  const MEDIA = ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav', 'wma', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'];
  if (single && !single.virtual && !single.archive && (DOCS.includes(ex) || ex === 'pdf' || MEDIA.includes(ex))) {
    addTab('details', 'Details', async (el) => {
      const isMedia = MEDIA.includes(ex);
      const isVideo = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'].includes(ex);
      const fields = isMedia ? [['title', 'Title'], ['artist', isVideo ? 'Author / artist' : 'Artist'], ...(isVideo ? [] : [['album', 'Album']]), ['comment', 'Comments']] : [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords']];
      const cur = isMedia ? await api('tags:read', single.path).catch(() => ({})) : (await api('doc:read', single.path, { maxChars: 50 }).catch(() => ({})))?.props || {};
      const vals = isMedia ? (cur.tags || cur || {}) : cur;
      const inputs = {};
      for (const [k, label] of fields) { inputs[k] = h('input', { class: 'input', value: vals[k] || vals[k.toUpperCase()] || '' }); inputs[k].addEventListener('keydown', (e) => e.stopPropagation()); }
      el.append(kv(fields.map(([k, label]) => [label, inputs[k]])),
        h('div', { class: 'hint' }, isMedia ? 'Saved inside the file, so players and Windows show them too.' : ex === 'pdf' ? 'Saved inside the PDF (readers and Windows show them).' : 'Saved inside the document, so Office and Windows see them too.'),
        h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = 'Saving…';
          const out = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
          try {
            if (isMedia) await api(isVideo ? 'media:setMeta' : 'tags:write', single.path, out);
            else await api('doc:setProps', single.path, out);
            toast('Details saved');
          } catch (err) { toast(`Couldn’t save: ${err.message}`, { error: true }); }
          b.disabled = false; b.textContent = 'Save';
        } }, 'Save')));
    });
  }

  addTab('attrs', 'Attributes', async (el) => {
    const a = single ? await api('fs:attributes', single.path).catch(() => ({})) : {};
    const boxes = {};
    for (const [k, label] of [['readonly', 'Read-only'], ['hidden', 'Hidden'], ['system', 'System'], ['archive', 'Ready for archiving']]) {
      boxes[k] = h('input', { type: 'checkbox' }); boxes[k].checked = !!a[k];
      el.append(h('label', { class: 'check block' }, boxes[k], ' ' + label));
    }
    const dtl = (ms) => { if (!ms) return ''; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 19); };
    const tc = h('input', { class: 'input', type: 'datetime-local', step: '1', value: single ? dtl(single.ctime) : '' });
    const tm = h('input', { class: 'input', type: 'datetime-local', step: '1', value: single ? dtl(single.mtime) : '' });
    const ta = h('input', { class: 'input', type: 'datetime-local', step: '1', value: single ? dtl(single.atime) : '' });
    el.append(h('div', { class: 'field-label' }, 'Timestamps'), kv([['Created', tc], ['Modified', tm], ['Accessed', ta]]));
    el.append(h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: async () => {
      const attrs = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.checked]));
      await api('fs:setAttributes', items.map((i) => i.path), attrs);
      for (const it of items) await api('fs:setTimes', it.path, { ctime: tc.value ? Date.parse(tc.value) : null, mtime: tm.value ? Date.parse(tm.value) : null, atime: ta.value ? Date.parse(ta.value) : null }).catch(() => {});
      toast('Attributes saved');
      helpers.refresh();
    } }, 'Apply')));
  });

  if (IS_WIN()) addTab('windows', 'Windows', (el) => {
    el.append(h('p', { class: 'hint' }, 'Open the classic Windows properties sheet for security, sharing, previous versions, compatibility and details.'),
      h('button', { class: 'btn', onclick: () => api('shell:properties', items.map((i) => i.path)) }, 'Open Windows Properties'));
  });

  const body = h('div', { class: 'props' }, tabs, pane);
  setTimeout(() => sections.general.click(), 0);
  return modal({ title: single ? `${single.name} Properties` : 'Properties', body, width: 520, buttons: [{ label: 'Close', primary: true, value: true }] });
}
