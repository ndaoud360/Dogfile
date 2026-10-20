// Office / OpenDocument / RTF previews without Office (Word, Excel, PowerPoint and LibreOffice files), document
// properties you can edit, and personal notes / rating / colour label on any file ("annotations"), kept by Atlas.
import { api, state, bus, h, esc, toast, debounce, IS_WIN, saveSettings } from './core.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';

export const OFFICE = new Set(['docx', 'docm', 'dotx', 'odt', 'ott', 'rtf', 'xlsx', 'xlsm', 'xltx', 'ods', 'pptx', 'pptm', 'potx', 'odp']);
export async function renderOffice(stage, it, { large, alive, addRows }) {
  const d = await api('doc:read', it.path, { maxChars: large ? 400000 : 60000 });
  if (!alive()) return;
  const wrap = h('div', { class: 'pv-doc' + (large ? ' large' : '') });
  if (d.type === 'doc') {
    const page = h('div', { class: 'pv-page' });
    let ul = null;
    for (const b of d.blocks.slice(0, large ? 5000 : 600)) {
      if (b.kind === 'li') { if (!ul) { ul = h('ul'); page.append(ul); } ul.append(h('li', {}, b.text)); continue; }
      ul = null;
      if (b.kind === 'table') { const tb = h('table'); for (const r of b.text.split('\n')) tb.append(h('tr', {}, ...r.split('\t').map((c) => h('td', {}, c)))); page.append(tb); continue; }
      page.append(h(b.kind === 'h1' ? 'h1' : b.kind === 'h2' ? 'h2' : b.kind === 'h3' ? 'h3' : 'p', { class: b.bold && b.kind === 'p' ? 'b' : null }, b.text || ' '));
    }
    wrap.append(page);
    const words = d.blocks.reduce((a, b) => a + (b.text.match(/\S+/g) || []).length, 0);
    addRows([['Words', words.toLocaleString()], d.props?.title && ['Title', d.props.title], d.props?.author && ['Author', d.props.author], d.props?.subject && ['Subject', d.props.subject], d.props?.keywords && ['Keywords', d.props.keywords]]);
  } else if (d.type === 'sheet') {
    const tabs = h('div', { class: 'pv-sheet-tabs' });
    const holder = h('div', { class: 'pv-sheet' });
    const show = (i) => {
      tabs.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
      const s = d.sheets[i];
      const cols = Math.max(1, ...s.rows.map((r) => r.length));
      const col = (n) => { let x = ''; n++; while (n) { const m = (n - 1) % 26; x = String.fromCharCode(65 + m) + x; n = Math.floor((n - 1) / 26); } return x; };
      const tb = h('table', {}, h('tr', {}, h('th'), ...Array.from({ length: cols }, (_, k) => h('th', {}, col(k)))), ...s.rows.map((r, ri) => h('tr', {}, h('th', {}, String(ri + 1)), ...Array.from({ length: cols }, (_, k) => h('td', { class: /^-?[\d.,]+%?$/.test(r[k] || '') ? 'num' : null }, r[k] ?? '')))));
      holder.innerHTML = ''; holder.append(tb);
    };
    d.sheets.forEach((s, i) => tabs.append(h('button', { onclick: () => show(i) }, s.name)));
    wrap.append(holder, tabs);
    if (d.sheets.length) show(0); else wrap.append(h('div', { class: 'hint' }, 'Empty workbook'));
    addRows([['Sheets', String(d.sheets.length)]]);
  } else if (d.type === 'slides') {
    const deck = h('div', { class: 'pv-slides' });
    d.slides.forEach((s, i) => deck.append(h('div', { class: 'pv-slide' }, h('span', { class: 'pv-sn' }, String(i + 1)), h('b', {}, s.title || 'Untitled slide'), ...s.lines.slice(0, 8).map((l) => h('div', {}, l)))));
    wrap.append(deck);
    addRows([['Slides', String(d.slides.length)]]);
  } else {
    wrap.append(h('div', { class: 'pv-page' }, ...String(d.text || '').split(/\n{2,}/).slice(0, 400).map((p) => h('p', {}, p))));
  }
  stage.append(wrap);
  return d;
}
export async function pdfRows(it) {
  try { const d = await api('doc:read', it.path, { maxChars: 4000 }); const p = d.props || {}; return [p.pages && ['Pages', String(p.pages)], p.title && ['Title', p.title], p.author && ['Author', p.author], p.subject && ['Subject', p.subject], p.creator && ['Made with', p.creator]]; } catch { return []; }
}
export async function editDocProps(it) {
  const d = await api('doc:read', it.path, { maxChars: 100 }).catch(() => null);
  const p = d?.props || {};
  const f = {};
  const row = (k, label, ta) => { f[k] = h(ta ? 'textarea' : 'input', { class: 'input', rows: ta ? '3' : null }); f[k].value = p[k] || ''; f[k].addEventListener('keydown', (e) => e.stopPropagation()); return h('label', { class: 'pp-row' }, h('span', {}, label), f[k]); };
  const ok = await modal({ title: `Properties of “${it.name}”`, width: 520, body: h('div', { class: 'stack' }, row('title', 'Title'), row('subject', 'Subject'), row('author', 'Author'), row('keywords', 'Keywords (tags)'), row('description', 'Comments', true), h('div', { class: 'hint' }, 'Saved inside the document, so Word, Excel, PowerPoint and Windows see them too.')), buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: true }] });
  if (!ok) return;
  try { await api('doc:setProps', it.path, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))); toast('Properties saved'); bus.emit('preview'); } catch (e) { toast(`Couldn’t save: ${e.message}`, { error: true }); }
}

// ---------------- notes, rating & colour label on any file ----------------
let notes = null;
const keyOf = (p) => (IS_WIN() ? p.toLowerCase() : p);
const saveNotes = debounce(() => api('store:set', 'filenotes', notes), 600);
export async function loadNotes() { if (!notes) notes = (await api('store:get', 'filenotes').catch(() => null)) || {}; return notes; }
export function noteOf(p) { return notes?.[keyOf(p)] || null; }
export function setNote(p, patch) {
  const k = keyOf(p);
  const n = { ...(notes[k] || {}), ...patch, at: Date.now() };
  if (!n.text && !n.rating && !n.label) delete notes[k]; else notes[k] = n;
  saveNotes();
  bus.emit('fileNotes', p);
}
// notes follow files when Atlas moves or renames them
bus.on('historyAdd', async (rec) => {
  if (!rec.pairs) return;
  await loadNotes();
  let changed = false;
  for (const [a, b] of rec.pairs) { const ka = keyOf(a); for (const k of Object.keys(notes)) if (k === ka || k.startsWith(ka + (IS_WIN() ? '\\' : '/'))) { notes[keyOf(b) + k.slice(ka.length)] = notes[k]; delete notes[k]; changed = true; } }
  if (changed) saveNotes();
});
const LABELS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6'];
export async function notesSection(it) {
  await loadNotes();
  const n = noteOf(it.path) || {};
  const box = h('div', { class: 'pv-notes' });
  const stars = h('div', { class: 'pv-stars', role: 'radiogroup', 'aria-label': 'Rating' });
  const drawStars = (r) => { stars.innerHTML = ''; for (let i = 1; i <= 5; i++) { const b = h('button', { class: 'pv-star' + (i <= r ? ' on' : ''), title: `${i} star${i > 1 ? 's' : ''}`, 'aria-checked': String(i === r), role: 'radio', html: '★' }); b.onclick = () => { const v = (noteOf(it.path)?.rating || 0) === i ? 0 : i; setNote(it.path, { rating: v }); drawStars(v); }; stars.append(b); } };
  drawStars(n.rating || 0);
  const labels = h('div', { class: 'pv-labels' }, ...LABELS.map((c) => { const b = h('button', { class: 'pv-lbl' + (n.label === c ? ' on' : ''), style: { background: c }, title: 'Colour label' }); b.onclick = () => { const v = noteOf(it.path)?.label === c ? null : c; setNote(it.path, { label: v }); labels.querySelectorAll('.pv-lbl').forEach((x) => x.classList.toggle('on', x === b && !!v)); }; return b; }));
  const ta = h('textarea', { class: 'pv-note', rows: '3', placeholder: 'Add a note about this file…', spellcheck: 'true' });
  ta.value = n.text || '';
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  ta.addEventListener('input', debounce(() => setNote(it.path, { text: ta.value }), 400));
  box.append(h('div', { class: 'pv-sec-h' }, 'Notes'), h('div', { class: 'row-inline' }, stars, h('span', { class: 'st-spacer' }), labels), ta);
  return box;
}

// ---------------- customizing the preview panel ----------------
export const PV_SECTIONS = [['stage', 'Preview'], ['info', 'Details'], ['palette', 'Colours (pictures)'], ['actions', 'Buttons'], ['notes', 'Notes & rating']];
export function applyPreviewPrefs() {
  const p = state.settings.previewSections || {};
  const el = document.getElementById('preview');
  if (!el) return;
  for (const [k] of PV_SECTIONS) el.classList.toggle('pv-hide-' + k, p[k] === false);
  el.classList.toggle('pv-tall', !!state.settings.previewTall);
}
export function previewMenu(x, y) {
  import('./menu.js').then(({ showMenu }) => showMenu([
    { header: 'Show in the preview pane' },
    ...PV_SECTIONS.map(([k, l]) => ({ label: l, checked: (state.settings.previewSections || {})[k] !== false, run: () => { state.settings.previewSections = { ...(state.settings.previewSections || {}), [k]: (state.settings.previewSections || {})[k] === false }; saveSettings(); applyPreviewPrefs(); } })),
    { separator: true },
    { label: 'Bigger preview', checked: !!state.settings.previewTall, run: () => { state.settings.previewTall = !state.settings.previewTall; saveSettings(); applyPreviewPrefs(); } },
  ], x, y));
}
bus.on('settings', applyPreviewPrefs);
setTimeout(applyPreviewPrefs, 500);
