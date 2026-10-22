// Rename studio: a stack of rename steps (find & replace with regular expressions, a name pattern with
// numbering / dates / photo, music and document details, case, add / remove text, extension) with a live
// before → after preview, problem checks, saved presets, "describe it in words", and one-step undo.
import { api, state, bus, h, esc, toast, natCmp, extname, stem, basename, dirname, pjoin, saveSettings, IS_WIN } from './core.js';
import { modal, prompt, interpretRename } from './dialogs.js';
import { icon } from './icons.js';
import * as A from './actions.js';
import * as MM from './mediameta.js';
import { requirePro } from './license.js';

const z = (x, n = 2) => String(x).padStart(n, '0');
const CASES = ['Keep case', 'lowercase', 'UPPERCASE', 'Title Case', 'Sentence case', 'camelCase', 'kebab-case', 'snake_case'];
function applyCase(base, cm) {
  const words = () => base.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_\-.]+/).filter(Boolean);
  if (cm === 'lowercase') return base.toLowerCase();
  if (cm === 'UPPERCASE') return base.toUpperCase();
  if (cm === 'Title Case') return base.replace(/[^\s_\-]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  if (cm === 'Sentence case') return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  if (cm === 'camelCase') return words().map((w, k) => (k ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  if (cm === 'kebab-case') return words().join('-').toLowerCase();
  if (cm === 'snake_case') return words().join('_').toLowerCase();
  return base;
}
const fmtD = (ms, pat = 'yyyy-mm-dd') => { const d = new Date(ms || Date.now()); return pat.replace(/yyyy/g, d.getFullYear()).replace(/yy/g, String(d.getFullYear()).slice(2)).replace(/mm/g, z(d.getMonth() + 1)).replace(/dd/g, z(d.getDate())).replace(/hh/g, z(d.getHours())).replace(/min/g, z(d.getMinutes())).replace(/ss/g, z(d.getSeconds())); };
export const TOKENS = [
  ['{name}', 'current name'], ['{n}', 'number'], ['{n:3}', 'number, 3 digits'], ['{date}', 'date changed (yyyy-mm-dd)'], ['{date:yyyymmdd}', 'any date format'], ['{time}', 'time changed'],
  ['{taken}', 'photo date taken'], ['{taken:yyyy-mm-dd_hh.min}', 'date taken, formatted'], ['{camera}', 'camera'], ['{width}x{height}', 'picture size'], ['{duration}', 'video / song length'],
  ['{artist}', 'song artist'], ['{title}', 'song title'], ['{album}', 'album'], ['{track}', 'track number'], ['{year}', 'song year'], ['{bpm}', 'BPM'], ['{key}', 'musical key'],
  ['{content}', 'title from the document’s contents'], ['{parent}', 'folder name'], ['{created}', 'date created'],
];
// the rename itself, step by step (shared with the AI assistant)
export function computeNames(items, R, extra = {}) {
  let re = null, err = null;
  if (R.find) { try { re = R.regex ? new RegExp(R.find, R.cs ? 'g' : 'gi') : new RegExp(R.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), R.cs ? 'g' : 'gi'); } catch { err = 'That regular expression isn’t valid'; } }
  const start = +R.start || 0, step = +R.step || 1, pad = +R.pad || 0;
  const perFolder = new Map();
  const out = items.map((it, i) => {
    const folder = dirname(it.path);
    const k = R.resetPerFolder ? (perFolder.set(folder, (perFolder.get(folder) ?? -1) + 1), perFolder.get(folder)) : i;
    const num = start + k * step;
    const dotExt = it.isDir ? '' : (extname(it.name) ? '.' + it.name.slice(it.name.lastIndexOf('.') + 1) : '');
    let base = it.isDir || R.withExt ? it.name : stem(it.name);
    const m = MM.metaOf(it) || {};
    const tg = extra.tags?.get(it.path) || {};
    if (R.template) {
      base = R.template.replace(/\{(\w+)(?::([^}]+))?\}/g, (all, tok, arg) => {
        switch (tok) {
          case 'n': return String(num).padStart(+arg || pad || 0, '0');
          case 'name': return base;
          case 'date': return fmtD(it.mtime, arg || 'yyyy-mm-dd');
          case 'created': return fmtD(it.ctime || it.mtime, arg || 'yyyy-mm-dd');
          case 'time': return fmtD(it.mtime, arg || 'hhminss');
          case 'yyyy': return fmtD(it.mtime, 'yyyy'); case 'yy': return fmtD(it.mtime, 'yy'); case 'mm': return fmtD(it.mtime, 'mm'); case 'dd': return fmtD(it.mtime, 'dd');
          case 'hh': return fmtD(it.mtime, 'hh'); case 'min': return fmtD(it.mtime, 'min'); case 'ss': return fmtD(it.mtime, 'ss');
          case 'taken': return fmtD(m.taken || it.mtime, arg || 'yyyy-mm-dd');
          case 'camera': return (m.camera || 'Unknown camera').replace(/[\\/:*?"<>|]/g, '');
          case 'width': return m.w || ''; case 'height': return m.h || '';
          case 'duration': return m.dur ? MM.fmtDur(m.dur).replace(/:/g, '.') : '';
          case 'artist': case 'title': case 'album': case 'genre': return String(tg[tok] || '').replace(/[\\/:*?"<>|]/g, '');
          case 'track': return String(tg.track || '').split('/')[0].padStart(+arg || 2, '0');
          case 'year': return String(tg.date || '').slice(0, 4);
          case 'bpm': return m.bpm ? String(Math.round(m.bpm)) : '';
          case 'key': return m.camelot || '';
          case 'content': return (extra.titles?.get(it.path) || base).replace(/[\\/:*?"<>|]/g, '').slice(0, +arg || 80).trim();
          case 'parent': return basename(folder);
          case 'ext': return '';
          default: return all;
        }
      });
    }
    if (re) base = base.replace(re, R.replace || '');
    if (R.removeNumbers) base = base.replace(/\d+/g, '');
    if (R.removeBrackets) base = base.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]/g, '');
    if (R.insert && R.insertAt != null && R.insertAt !== '') { const p = Math.max(0, Math.min(base.length, +R.insertAt < 0 ? base.length + +R.insertAt + 1 : +R.insertAt)); base = base.slice(0, p) + R.insert + base.slice(p); }
    if (+R.removeCount > 0) { const p = Math.max(0, +R.removeFrom || 0); base = R.removeFromEnd ? base.slice(0, Math.max(0, base.length - p - +R.removeCount)) + base.slice(base.length - p) : base.slice(0, p) + base.slice(p + +R.removeCount); }
    if (R.trim) base = base.replace(/\s+/g, ' ').trim();
    if (R.spaces) base = base.replace(/\s+/g, R.spaces === '-' ? '-' : '_');
    base = applyCase(base, R.caseMode);
    base = (R.prefix || '') + base + (R.suffix || '');
    let ext = dotExt;
    if (!it.isDir && !R.withExt) { if (R.newExt) ext = '.' + R.newExt.replace(/^\./, ''); if (R.extCase === 'lower') ext = ext.toLowerCase(); if (R.extCase === 'upper') ext = ext.toUpperCase(); }
    const name = it.isDir || R.withExt ? base : base + ext;
    return { it, name };
  });
  const seen = new Map();
  for (const o of out) { const k = IS_WIN() ? o.name.toLowerCase() : o.name; seen.set(k, (seen.get(k) || 0) + 1); }
  const renamedFrom = new Set(out.filter((o) => o.name !== o.it.name).map((o) => (IS_WIN() ? o.it.path.toLowerCase() : o.it.path)));
  for (const o of out) {
    const k = IS_WIN() ? o.name.toLowerCase() : o.name;
    o.problem = !o.name.trim() ? 'empty name' : /[<>:"/\\|?*\x00-\x1f]/.test(o.name) ? 'has characters Windows doesn’t allow' : /[. ]$/.test(o.name) ? 'can’t end with a dot or space' : seen.get(k) > 1 ? 'two files would get this name' : null;
    if (!o.problem && o.name !== o.it.name && extra.existing) {
      const target = pjoin(dirname(o.it.path), o.name);
      const tk = IS_WIN() ? target.toLowerCase() : target;
      if (extra.existing.has(tk) && !renamedFrom.has(tk)) o.problem = 'a file with this name is already there';
    }
  }
  return { out, err };
}
// mark the changed part of the new name
function diffHtml(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return esc(b.slice(0, i)) + (b.slice(i, b.length - j) ? `<mark>${esc(b.slice(i, b.length - j))}</mark>` : '') + esc(b.slice(b.length - j));
}

export async function renameStudio(items, initial = {}) {
  if (!requirePro('rename')) return;
  const R = { find: '', replace: '', regex: false, cs: false, withExt: false, template: '', start: 1, step: 1, pad: 0, resetPerFolder: false, caseMode: 'Keep case', prefix: '', suffix: '', trim: false, spaces: '', removeNumbers: false, removeBrackets: false, insert: '', insertAt: '', removeFrom: 0, removeCount: 0, removeFromEnd: false, newExt: '', extCase: '', order: 'name', ...initial };
  const extra = { tags: new Map(), titles: new Map(), existing: new Set() };
  let list = [...items];
  const sortList = () => {
    const by = { name: (a, b) => natCmp(a.name, b.name), mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0), taken: (a, b) => MM.takenOf(a) - MM.takenOf(b), size: (a, b) => (a.size || 0) - (b.size || 0), none: () => 0 }[R.order] || (() => 0);
    list = R.order === 'none' ? [...items] : [...items].sort(by);
  };
  sortList();
  // names already in the folders (to catch "already exists")
  for (const d of new Set(items.map((i) => dirname(i.path)))) { const r = await api('fs:list', d).catch(() => null); for (const x of r?.items || []) extra.existing.add(IS_WIN() ? x.path.toLowerCase() : x.path); }
  const table = h('div', { class: 'rs-table' });
  const status = h('div', { class: 'rs-status' });
  let last = null;
  const run = () => {
    const { out, err } = computeNames(list, R, extra);
    last = out;
    const changes = out.filter((o) => o.name !== o.it.name).length, probs = out.filter((o) => o.problem).length;
    status.className = 'rs-status' + (probs || err ? ' bad' : '');
    status.textContent = err || `${changes} of ${out.length} will change${probs ? ` · ${probs} problem${probs > 1 ? 's' : ''} to fix first` : ''}`;
    table.innerHTML = '<div class="rs-row rs-head"><div>#</div><div>Now</div><div>After</div></div>' + out.slice(0, 1000).map((o, i) => `<div class="rs-row${o.name !== o.it.name ? ' chg' : ''}${o.problem ? ' bad' : ''}" title="${esc(o.it.path)}${o.problem ? '\n' + esc(o.problem) : ''}"><div class="rs-i">${i + 1}</div><div>${esc(o.it.name)}</div><div>${diffHtml(o.it.name, o.name)}${o.problem ? `<small>${esc(o.problem)}</small>` : ''}</div></div>`).join('');
    return err || probs ? null : out;
  };
  // what the pattern needs: photo / music / document details
  const needs = async () => {
    const t = R.template || '';
    if (/\{(taken|camera|width|height|duration|bpm|key)/.test(t) || R.order === 'taken') await MM.ensureMeta(items);
    if (/\{(artist|title|album|track|year|genre)/.test(t)) for (const it of items) if (!extra.tags.has(it.path) && MM.isAud(it)) extra.tags.set(it.path, (await api('tags:read', it.path).catch(() => null))?.tags || {});
    if (/\{content/.test(t)) { const todo = items.filter((it) => !extra.titles.has(it.path)); if (todo.length) { status.textContent = 'Reading documents…'; const r = await api('doc:titles', todo.map((x) => x.path)); todo.forEach((it, i) => extra.titles.set(it.path, r[i] || '')); } }
  };
  const upd = async () => { await needs(); sortList(); run(); };
  // ---- controls ----
  const bind = (el, k, ev = 'input', get = (x) => (x.type === 'checkbox' ? x.checked : x.value)) => { if (el.type === 'checkbox') el.checked = !!R[k]; else el.value = R[k] ?? ''; el.addEventListener(ev, () => { R[k] = get(el); upd(); }); el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
  const inp = (k, ph, w) => bind(h('input', { class: 'input sm', placeholder: ph, spellcheck: 'false', style: w ? { width: w } : { flex: '1', minWidth: '90px' } }), k);
  const num = (k, w = '64px') => { const x = inp(k, '', w); x.type = 'number'; return x; };
  const chk = (k, label) => h('label', { class: 'check' }, bind(h('input', { type: 'checkbox' }), k, 'change'), ' ' + label);
  const sel = (k, opts) => bind(h('select', { class: 'input sm' }, ...opts.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o)))), k, 'change');
  const tpl = inp('template', 'Pattern, e.g. {taken}_{n:3} or {artist} - {title}   (empty keeps names)');
  Object.assign(tpl.style, { flex: 'none', width: '100%' });
  const tokenBtns = h('div', { class: 'rs-tokens' }, ...TOKENS.map(([t, d]) => h('button', { class: 'chip', title: d, onclick: () => { const p = tpl.selectionStart ?? tpl.value.length; tpl.value = tpl.value.slice(0, p) + t + tpl.value.slice(tpl.selectionEnd ?? p); R.template = tpl.value; tpl.focus(); tpl.setSelectionRange(p + t.length, p + t.length); upd(); } }, t)));
  const describe = h('input', { class: 'input', placeholder: 'Or describe it: “replace _ with spaces, title case and number them from 1 with 2 digits”', spellcheck: 'false' });
  const understood = h('div', { class: 'hint' });
  describe.addEventListener('keydown', (e) => e.stopPropagation());
  describe.addEventListener('input', () => {
    const r = interpretRename(describe.value);
    for (const k of ['find', 'replace', 'regex', 'template', 'start', 'step', 'caseMode', 'prefix', 'suffix', 'trim']) if (r[k] != null) R[k] = r[k];
    if (r.spaces) R.spaces = '_';
    if (/\b(contents?|inside)\b/i.test(describe.value)) R.template = '{content}';
    if (/\bdate taken\b/i.test(describe.value) && !/\{taken/.test(R.template)) R.template = `{taken}${R.template ? '_' + R.template : '_{name}'}`;
    understood.textContent = r.notes.length || /contents?|date taken/i.test(describe.value) ? 'Understood: ' + [...r.notes, /contents?/i.test(describe.value) ? 'title from contents' : '', /date taken/i.test(describe.value) ? 'date taken' : ''].filter(Boolean).join(' · ') : '';
    syncInputs(); upd();
  });
  const sec = (title, ...c) => h('div', { class: 'rs-sec' }, h('div', { class: 'rs-st' }, title), h('div', { class: 'rs-sc' }, ...c));
  const controls = h('div', { class: 'rs-controls' });
  const drawControls = () => {
    controls.innerHTML = '';
    controls.append(
      h('div', { class: 'rs-ask' }, h('span', { html: icon('sparkle') }), describe), understood,
      sec('Find & replace', h('div', { class: 'rs-line' }, inp('find', 'Find'), inp('replace', 'Replace with ($1… for regex groups)')), h('div', { class: 'rs-line' }, chk('regex', 'Regular expression'), chk('cs', 'Match case'), chk('withExt', 'Include extension'))),
      sec('Pattern', tpl, tokenBtns, h('div', { class: 'rs-line' }, h('span', { class: 'hint' }, 'Numbers start at'), num('start'), h('span', { class: 'hint' }, 'step'), num('step', '54px'), h('span', { class: 'hint' }, 'digits'), num('pad', '54px'), chk('resetPerFolder', 'Restart in each folder'))),
      sec('Change', h('div', { class: 'rs-line' }, sel('caseMode', CASES), sel('spaces', [['', 'Keep spaces'], ['_', 'Spaces → _'], ['-', 'Spaces → -']]), chk('trim', 'Tidy spaces'), chk('removeNumbers', 'Remove numbers'), chk('removeBrackets', 'Remove (brackets)')),
        h('div', { class: 'rs-line' }, inp('prefix', 'Add at start', '140px'), inp('suffix', 'Add at end', '140px'), inp('insert', 'Insert text', '120px'), h('span', { class: 'hint' }, 'at position'), num('insertAt', '60px')),
        h('div', { class: 'rs-line' }, h('span', { class: 'hint' }, 'Remove'), num('removeCount', '60px'), h('span', { class: 'hint' }, 'characters from position'), num('removeFrom', '60px'), chk('removeFromEnd', 'counting from the end'))),
      sec('Extension', h('div', { class: 'rs-line' }, inp('newExt', 'New extension (optional)', '170px'), sel('extCase', [['', 'Keep'], ['lower', 'lowercase'], ['upper', 'UPPERCASE']]))),
      sec('Order', h('div', { class: 'rs-line' }, h('span', { class: 'hint' }, 'Number files in this order:'), sel('order', [['name', 'Name'], ['mtime', 'Date changed'], ['taken', 'Date taken'], ['size', 'Size'], ['none', 'As selected']]))));
  };
  const syncInputs = () => drawControls();
  drawControls();
  const presets = () => state.settings.renamePresets || {};
  const presetMenu = h('select', { class: 'input sm', title: 'Saved presets' });
  const fillPresets = () => { presetMenu.innerHTML = ''; presetMenu.append(h('option', { value: '' }, 'Presets…')); for (const n of Object.keys(presets())) presetMenu.append(h('option', { value: n }, n)); };
  fillPresets();
  presetMenu.onchange = () => { const p = presets()[presetMenu.value]; if (p) { Object.assign(R, p); drawControls(); upd(); } presetMenu.value = ''; };
  const body = h('div', { class: 'rs' }, h('div', { class: 'rs-left' }, controls), h('div', { class: 'rs-right' }, h('div', { class: 'rs-top' }, status, h('span', { class: 'st-spacer' }), presetMenu, h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Save preset', '', { label: 'Name' }); if (!n) return; state.settings.renamePresets = { ...presets(), [n]: { ...R } }; saveSettings(); fillPresets(); toast('Preset saved'); } }, 'Save preset')), table));
  await upd();
  return modal({ title: `Rename Studio · ${items.length} item${items.length === 1 ? "" : "s"}`, body, width: 1180, className: 'rs-modal', buttons: [
    { label: 'Reset', left: true, run: () => { Object.assign(R, { find: '', replace: '', template: '', prefix: '', suffix: '', caseMode: 'Keep case', spaces: '', trim: false, removeNumbers: false, removeBrackets: false, insert: '', removeCount: 0, newExt: '', extCase: '' }); describe.value = ''; drawControls(); upd(); return false; } },
    { label: 'Cancel', value: null },
    { label: 'Rename', primary: true, run: async (close) => {
      const out = run();
      if (!out) { toast('Fix the problems shown in red first', { error: true }); return false; }
      const pairs = out.filter((o) => o.name !== o.it.name).map((o) => ({ from: o.it.path, to: pjoin(dirname(o.it.path), o.name) }));
      if (!pairs.length) { close(null); return; }
      close(true);
      await A.renamePairs(pairs, `Rename ${pairs.length} item${pairs.length === 1 ? '' : 's'}`);
    } }] });
}
