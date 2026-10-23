// Document reminders: the list of documents Dogfile found with a date that matters (passports, licences, insurance,
// warranties, bills…), and when to be reminded. The reading, the watching and the notifications are in the back end
// (backend/src/reminders.rs); this is the window onto them, "Remind me about this…" on a file, and the settings.
import { api, state, bus, h, esc, toast, basename, dirname, saveSettings, onMain, IS_WIN } from './core.js';
import { modal, confirm, closeTopModal } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate } from './pane.js';
import { requirePro } from './license.js';

const KINDS = [
  ['passport', 'Passport', 'globe'], ['license', "Driver's licence", 'user'], ['id', 'ID card', 'user'], ['visa', 'Visa', 'globe'],
  ['card', 'Bank card', 'lock'], ['insurance', 'Insurance', 'shieldCheck'], ['registration', 'Vehicle registration', 'page'],
  ['warranty', 'Warranty', 'shield'], ['lease', 'Lease / contract', 'page'], ['subscription', 'Subscription / membership', 'repeat'],
  ['certificate', 'Certificate', 'star'], ['prescription', 'Prescription', 'note'], ['bill', 'Bill / invoice', 'page'],
  ['ticket', 'Ticket / booking', 'calendar'], ['document', 'Document', 'page'],
];
const kindIcon = (k) => (KINDS.find((x) => x[0] === k) || KINDS.at(-1))[2];
export const INTERVALS = [180, 90, 60, 30, 25, 14, 10, 7, 5, 3, 1, 0];
const DEFAULT_INTERVALS = [60, 25, 10, 5];

/** how this PC writes 03/04: month first (US) or day first, from the Windows region format */
export function dateOrder() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2001, 1, 3));
    const order = parts.filter((p) => ['year', 'month', 'day'].includes(p.type)).map((p) => p.type[0]).join('');
    return order === 'dmy' ? 'dmy' : order === 'ymd' ? 'ymd' : 'mdy';
  } catch { return 'mdy'; }
}
export function remCfg() {
  const c = state.settings.reminders || {};
  return { enabled: !!c.enabled, folders: c.folders || null, intervals: c.intervals || DEFAULT_INTERVALS, dateOrder: c.dateOrder || dateOrder() };
}
async function setCfg(patch) {
  state.settings.reminders = { ...(state.settings.reminders || {}), dateOrder: dateOrder(), ...patch };
  saveSettings();
  // settings are written a moment later: let them land before the back end reads them
  await new Promise((r) => setTimeout(r, 400));
  await api('reminders:apply').catch(() => {});
}

const fmtDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
export function leftText(n, what = 'expires') {
  if (n == null) return '';
  const verb = what === 'due' ? 'Due' : n < 0 ? 'Expired' : 'Expires';
  if (n === 0) return `${verb} today`;
  if (n === 1) return `${verb} tomorrow`;
  if (n === -1) return `${verb} yesterday`;
  if (n < 0) return `${verb} ${-n} days ago`;
  if (n > 120) { const mo = Math.round(n / 30.4); return mo >= 24 ? `${verb} in ${Math.round(n / 365)} years` : `${verb} in ${mo} months`; }
  return `${verb} in ${n} days`;
}
const urgency = (n) => (n == null ? '' : n < 0 ? 'past' : n <= 10 ? 'soon' : n <= 30 ? 'near' : '');

let dlg = null; // the open reminders window's close()
/** the reminders window; `focusId` scrolls to one */
export async function openReminders(focusId) {
  if (dlg) { dlg(null); dlg = null; }
  let tab = remCfg().enabled ? 'list' : 'settings';
  let data = null;
  let filter = 'upcoming';
  const body = h('div', { class: 'rem' });
  const head = h('div', { class: 'rem-head' });
  const tabs = h('div', { class: 'seg rem-tabs' });
  const main = h('div', { class: 'rem-main' });
  body.append(head, tabs, main);
  const load = async () => { data = await api('reminders:list').catch(() => ({ items: [], scan: {} })); };
  const drawTabs = () => {
    tabs.innerHTML = '';
    for (const [k, l] of [['list', 'Reminders'], ['settings', 'Settings']]) tabs.append(h('button', { class: 'seg-btn' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, l));
  };
  const drawHead = () => {
    const s = data?.scan || {};
    const cfg = remCfg();
    head.innerHTML = '';
    head.append(h('span', { class: 'rem-bell', html: icon('bell') }),
      h('div', { class: 'rem-head-t' },
        h('b', {}, 'Document reminders'),
        h('span', { class: 'hint' }, !cfg.enabled ? 'Off. Turn it on in Settings.'
          : s.running ? `Reading documents… ${s.done || 0} looked at${s.queued ? `, ${s.queued} to go` : ''}${s.current ? ` · ${basename(s.current)}` : ''}`
            : `Watching ${(data?.folders || []).map((f) => basename(f) || f).join(', ') || 'no folders'} · all on this PC`)));
  };
  const drawList = () => {
    const items = (data?.items || []).filter((it) => filter === 'all' || (!it.dismissed && (it.daysLeft == null || it.daysLeft >= -30)));
    main.append(h('div', { class: 'row-inline rem-tools' },
      ...[['upcoming', 'Coming up'], ['all', 'Everything (incl. done)']].map(([k, l]) => h('button', { class: 'chip' + (filter === k ? ' on' : ''), onclick: () => { filter = k; draw(); } }, l)),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn small', onclick: () => remindAbout(null) }, 'Add one…')));
    if (!items.length) {
      main.append(h('div', { class: 'rem-empty' },
        h('div', { class: 'hint' }, remCfg().enabled
          ? (data?.scan?.running ? 'Nothing found yet. Still reading…' : 'Nothing with an expiry or due date found yet. When a passport scan, insurance card, warranty or bill lands in a watched folder, it shows up here.')
          : 'Turn reminders on and Dogfile looks through your Downloads and Documents for documents that expire, then reminds you before they do.')));
      return;
    }
    const list = h('div', { class: 'rem-list' });
    for (const it of items) {
      const n = it.daysLeft;
      const dateIn = h('input', { type: 'date', class: 'input small rem-date', value: it.date || '' });
      dateIn.onchange = async () => { try { await api('reminders:update', it.id, { date: dateIn.value }); toast('Date changed'); } catch (e) { toast(e.message, { error: true }); } };
      const noteIn = h('input', { class: 'input small rem-note', placeholder: 'Note (e.g. “Ana’s passport”)', value: it.note || '', spellcheck: 'false' });
      noteIn.addEventListener('keydown', (e) => e.stopPropagation());
      noteIn.onchange = () => api('reminders:update', it.id, { note: noteIn.value.trim() });
      const kindSel = h('select', { class: 'input small' }, ...KINDS.map(([k, l]) => h('option', { value: k, selected: k === it.kind }, l)));
      kindSel.onchange = () => api('reminders:update', it.id, { kind: kindSel.value, kindLabel: KINDS.find((x) => x[0] === kindSel.value)[1] });
      const more = h('div', { class: 'rem-more' },
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'hint' }, 'Type'), kindSel, h('label', { class: 'hint' }, 'Date'), dateIn),
        noteIn,
        it.evidence ? h('div', { class: 'rem-ev' }, h('span', { class: 'hint' }, 'Found: '), `“${it.evidence}”`) : null);
      const row = h('div', { class: `rem-row ${urgency(n)}${it.dismissed ? ' done' : ''}`, 'data-id': it.id },
        h('span', { class: 'rem-ic', html: icon(kindIcon(it.kind)) }),
        h('div', { class: 'rem-body' },
          h('div', { class: 'rem-title' }, h('b', {}, it.note || it.kindLabel || 'Document'), it.sure === false ? h('span', { class: 'rem-check', title: 'Dogfile isn’t sure this is the right date: check it' }, 'check the date') : null),
          h('div', { class: 'hint rem-sub' }, `${it.date ? fmtDay(it.date) : 'no date'} · `, h('a', { href: '#', class: 'rem-file' + (it.exists === false ? ' gone' : ''), title: it.path || '', onclick: (e) => { e.preventDefault(); if (!it.path) return; close(); navigate(activeTab(), dirname(it.path), { select: it.path }); } }, it.name || basename(it.path || '') || '—'))),
        h('div', { class: 'rem-left' }, leftText(n, it.what)),
        h('div', { class: 'rem-acts' },
          h('button', { class: 'icon-btn small', title: 'Change the date, type or note', html: icon('rename'), onclick: () => more.classList.toggle('open') }),
          !it.dismissed ? h('button', { class: 'btn small', title: 'Remind me again tomorrow', onclick: async () => { await api('reminders:snooze', it.id, 1); toast('I’ll remind you tomorrow'); } }, 'Tomorrow') : null,
          !it.dismissed ? h('button', { class: 'btn small', title: 'Renewed or paid: no more reminders for this one', onclick: () => api('reminders:update', it.id, { dismissed: true }) }, 'Done') : h('button', { class: 'btn small', onclick: () => api('reminders:update', it.id, { dismissed: false }) }, 'Remind again'),
          h('button', { class: 'icon-btn small', title: 'Remove (Dogfile won’t pick this file again)', html: icon('trash'), onclick: async () => { if (await confirm('Remove this reminder?', esc(it.name || ''), { ok: 'Remove' })) api('reminders:remove', it.id); } })));
      list.append(row, more);
      if (it.id === focusId) setTimeout(() => { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }, 60);
    }
    main.append(list);
  };
  const drawSettings = () => {
    const cfg = remCfg();
    const on = h('input', { type: 'checkbox', class: 'switch', checked: cfg.enabled });
    on.onchange = async () => {
      if (on.checked && !requirePro('reminders')) { on.checked = false; return; }
      await setCfg({ enabled: on.checked });
      await load(); draw();
      if (on.checked) toast('Reminders on: Dogfile is looking through your documents');
    };
    const folders = data?.folders || [];
    const fl = h('div', { class: 'rem-folders' });
    for (const f of folders) fl.append(h('div', { class: 'rem-folder' }, h('span', { html: icon('folder') }), h('span', { class: 'grow', title: f }, f),
      h('button', { class: 'icon-btn small', title: 'Stop watching this folder', html: icon('close'), onclick: async () => { await setCfg({ folders: folders.filter((x) => x !== f) }); await load(); draw(); } })));
    fl.append(h('button', { class: 'btn small', onclick: async () => {
      const p = await api('dialog:pickFolder', 'Watch this folder for documents').catch(() => null);
      if (!p) return;
      if (!folders.includes(p)) await setCfg({ folders: [...folders, p] });
      await load(); draw();
    } }, 'Add a folder…'));
    const ints = new Set(cfg.intervals);
    const chips = h('div', { class: 'row-inline wrap rem-ints' });
    for (const d of INTERVALS) {
      const b = h('button', { class: 'chip' + (ints.has(d) ? ' on' : '') }, d === 0 ? 'On the day' : d === 1 ? '1 day' : `${d} days`);
      b.onclick = async () => { if (ints.has(d)) ints.delete(d); else ints.add(d); b.classList.toggle('on', ints.has(d)); await setCfg({ intervals: [...ints].sort((a, c) => c - a) }); };
      chips.append(b);
    }
    main.append(h('div', { class: 'rem-set' },
      h('label', { class: 'check rem-on' }, on, h('span', {}, h('b', {}, 'Remind me before documents expire'), h('span', { class: 'hint' }, ' Dogfile watches the folders below for new photos, scans and PDFs, reads them on this PC (nothing is uploaded), and finds expiry and due dates.'))),
      h('div', { class: 'rem-sec' }, h('b', {}, 'Folders to watch'), h('div', { class: 'hint' }, 'Subfolders too, a few levels deep.'), fl),
      h('div', { class: 'rem-sec' }, h('b', {}, 'Remind me'), h('div', { class: 'hint' }, 'How long before the date. Each one comes once, as a Windows notification.'), chips),
      h('div', { class: 'rem-sec row-inline wrap' },
        h('button', { class: 'btn small', onclick: () => api('reminders:test').then(() => toast(IS_WIN() ? 'Sent a sample notification' : 'Sent a sample reminder')) }, 'Send a sample notification'),
        h('button', { class: 'btn small', disabled: !cfg.enabled, onclick: async () => { await api('reminders:scanNow', true).catch((e) => toast(e.message, { error: true })); toast('Looking through everything again'); await load(); draw(); } }, 'Look through everything again')),
      h('div', { class: 'hint rem-note-foot' }, `Dates like 03/04/2027 are read ${cfg.dateOrder === 'dmy' ? 'day first (3 April)' : 'month first (March 4)'}, the way this PC writes them. Reminders come while Dogfile is running; turn on “Keep running in the background” (Settings › General) so they come even with no window open. The list is stored encrypted for your Windows account.`)));
  };
  const draw = () => { drawHead(); drawTabs(); main.innerHTML = ''; if (tab === 'list') drawList(); else drawSettings(); };
  await load();
  draw();
  const offs = [bus.on('remindersChanged', async () => { await load(); draw(); })];
  let tick = setInterval(async () => { if (data?.scan?.running) { data.scan = await api('reminders:status').catch(() => data.scan); drawHead(); } }, 1500);
  const close = () => { dlg?.(null); };
  modal({ title: '', body, width: 720, className: 'rem-modal', noPadding: true, buttons: [{ label: 'Close', primary: true }], onClose: () => { offs.forEach((f) => f?.()); clearInterval(tick); tick = null; dlg = null; } });
  dlg = document.querySelector('.rem-modal')?._close || closeTopModal;
}

/** "Remind me about this…": read the file, show what was found, let the person fix it */
export async function remindAbout(item) {
  if (!requirePro('reminders')) return;
  let found = { kind: 'document', kindLabel: 'Document', date: null };
  if (item && !item.isDir) {
    toast('Reading the document…');
    try { found = await api('reminders:analyze', item.path); } catch (e) { found.error = e.message; }
  }
  const kindSel = h('select', { class: 'input' }, ...KINDS.map(([k, l]) => h('option', { value: k, selected: k === found.kind }, l)));
  const date = h('input', { type: 'date', class: 'input', value: found.date || '' });
  const what = h('select', { class: 'input' }, h('option', { value: 'expires', selected: found.what !== 'due' }, 'Expires'), h('option', { value: 'due', selected: found.what === 'due' }, 'Is due'));
  const note = h('input', { class: 'input', placeholder: 'Note (optional)', spellcheck: 'false' });
  note.addEventListener('keydown', (e) => e.stopPropagation());
  const info = found.date
    ? h('div', { class: 'rem-found' }, h('span', { html: icon('check') }), ` Found ${found.kindLabel.toLowerCase()}, ${found.what === 'due' ? 'due' : 'expiring'} ${fmtDay(found.date)}`, found.evidence ? h('div', { class: 'hint' }, `“${found.evidence}”`) : null)
    : h('div', { class: 'hint' }, item ? (found.error ? `Couldn’t read it (${found.error}). Pick the date yourself.` : 'No expiry or due date found in it. Pick the date yourself.') : 'Pick a date to be reminded about.');
  const body = h('div', { class: 'stack rem-add' }, item ? h('div', { class: 'rem-file-line' }, h('span', { html: icon('page') }), h('b', {}, item.name)) : null, info,
    h('div', { class: 'row-inline' }, kindSel, what, date), note);
  modal({
    title: 'Remind me about this', body, width: 480,
    buttons: [{ label: 'Cancel' }, { label: 'Add reminder', primary: true, run: async () => {
      if (!date.value) { toast('Pick a date', { error: true }); return false; }
      try {
        await api('reminders:add', { path: item?.path || '', name: item?.name || note.value.trim() || 'Reminder', kind: kindSel.value, kindLabel: KINDS.find((x) => x[0] === kindSel.value)[1], date: date.value, what: what.value, note: note.value.trim(), evidence: found.evidence || '' });
        if (!remCfg().enabled) await setCfg({ enabled: true });
        toast(`I’ll remind you ${remCfg().intervals.length ? `${Math.max(...remCfg().intervals)} days before` : 'on the day'}`);
      } catch (e) { toast(e.message, { error: true }); return false; }
    } }],
  });
}

// from the back end: a reminder is due (also shown by Windows), the list changed, a notification was clicked
onMain('reminders:due', (r) => toast(`${r.title} — ${r.body}`, { action: { label: 'Open', run: () => openReminders(r.id) }, ms: 12000 }));
onMain('reminders:changed', () => bus.emit('remindersChanged'));
onMain('reminders:scan', () => bus.emit('remindersChanged'));
onMain('reminders:open', (r) => openReminders(r?.id));
// keep the date order in step with Windows' region format
if (state.settings?.reminders?.enabled && state.settings.reminders.dateOrder !== dateOrder()) setCfg({});
