// Updates: Dogfile doesn't install updates itself, the Microsoft Store does. Dogfile only checks (a few seconds after start
// and every few hours) whether a newer version exists and says so, with a button that opens the Store's updates page;
// and after the Store has updated it, a pop-up says so once and shows what changed (the notes come with the program).
import { api, state, bus, h, esc, toast, fmtDate, saveSettings, sys } from './core.js';
import { modal } from './dialogs.js';

export const U = { status: null, checking: false };
const DAY = 24 * 3600 * 1000;
const STORE_UPDATES = 'ms-windows-store://downloadsandupdates';
const STORE_PAGE = 'https://apps.microsoft.com/search?query=Dogfile';
/** the Store's updates page; a copy that wasn't installed from the Store sends people to Dogfile's Store page */
const openStore = () => api('shell:openExternal', U.status?.store ? STORE_UPDATES : STORE_PAGE).catch(() => api('shell:openExternal', STORE_PAGE));

export async function checkNow({ quiet = true } = {}) {
  if (U.checking) return U.status;
  U.checking = true; bus.emit('updateStatus');
  try { U.status = await api('update:check'); } catch (e) { U.status = { ...(U.status || {}), error: e.message }; }
  U.checking = false; bus.emit('updateStatus');
  if (!quiet && U.status?.error && !U.status.available) toast(U.status.error, { error: true });
  return U.status;
}

// the File menu entry
export function menuItem() {
  const s = U.status;
  if (s?.available) return { label: `Update available (${s.latest})`, icon: 'downloadArrow', tone: 'bad', run: () => openUpdates() };
  if (U.checking) return { label: 'Checking for updates…', icon: 'refresh', run: () => openUpdates() };
  return { label: s?.checked && !s.error ? 'Up to date' : 'Updates', icon: 'check', tone: s?.checked && !s.error ? 'good' : null, run: () => openUpdates() };
}

// the pop-up: Open Microsoft Store / Later (Later waits 24 hours)
let popupOpen = false;
async function maybePopup() {
  const s = U.status;
  if (!s?.available || popupOpen || document.querySelector('.modal-back')) return;
  if ((state.settings.updateSnoozeUntil || 0) > Date.now()) return;
  popupOpen = true;
  const v = await modal({
    title: 'New update available',
    width: 440,
    body: h('div', { class: 'upd-pop' },
      h('div', { class: 'upd-logo' }),
      h('div', {}, h('b', {}, `Dogfile ${s.latest}`), h('div', { class: 'hint' }, `You have ${s.current}. The Microsoft Store installs the update for you; you can also open the Store and update now.`))),
    buttons: [{ label: 'Later', value: 'later' }, { label: 'Open Microsoft Store', primary: true, value: 'update' }],
    closeOnBackdrop: false,
  });
  popupOpen = false;
  if (v === 'update') openStore();
  else { state.settings.updateSnoozeUntil = Date.now() + DAY; saveSettings(); }
}

// a small changelog format: "# heading", "- bullet", blank lines between paragraphs
function notesEl(text) {
  const box = h('div', { class: 'upd-notes' });
  if (!text) { box.append(h('div', { class: 'hint' }, 'No notes for this version.')); return box; }
  let ul = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { ul = null; continue; }
    const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    if (/^#+\s/.test(line)) { ul = null; box.append(h('h4', { html: fmt(line.replace(/^#+\s*/, '')) })); }
    else if (/^[-*•]\s/.test(line)) { if (!ul) { ul = h('ul'); box.append(ul); } ul.append(h('li', { html: fmt(line.replace(/^[-*•]\s*/, '')) })); }
    else { ul = null; box.append(h('p', { html: fmt(line) })); }
  }
  return box;
}

// the Updates window
// exported for tests
export { maybePopup };
export async function openUpdates() {
  const body = h('div', { class: 'upd' });
  const draw = () => {
    const s = U.status || {};
    body.innerHTML = '';
    if (s.available) {
      body.append(
        h('div', { class: 'upd-head bad' }, h('div', {}, h('b', {}, `Dogfile ${s.latest}`), h('div', { class: 'hint' }, `${s.date ? new Date(s.date + 'T12:00:00').toLocaleDateString() + ' · ' : ''}you have ${s.current}`))),
        h('div', { class: 'upd-sec' }, 'What’s new'), notesEl(s.notes),
        h('div', { class: 'hint' }, 'Dogfile is updated by the Microsoft Store.'),
        h('div', { class: 'upd-acts' }, h('button', { class: 'btn primary', onclick: openStore }, 'Open Microsoft Store')));
    } else {
      const ok = s.checked && !s.error;
      body.append(
        h('div', { class: 'upd-head ' + (ok ? 'good' : '') }, h('div', {}, h('b', {}, ok ? 'Dogfile is up to date' : U.checking ? 'Checking for updates…' : 'Updates'), h('div', { class: 'hint' }, `Version ${s.current || sys.version || ''}${s.checked ? ` · checked ${fmtDate(s.checked)}` : ''}`))),
        s.error ? h('div', { class: 'hint upd-err' }, s.error) : null);
      const btn = h('button', { class: 'btn primary', disabled: U.checking ? true : null }, U.checking ? 'Checking…' : 'Check for updates');
      btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Checking…'; await checkNow({ quiet: true }); draw(); };
      body.append(h('div', { class: 'upd-acts' }, h('button', { class: 'btn', onclick: () => showWhatsNew() }, 'What’s new in this version'), btn));
    }
    const auto = h('input', { type: 'checkbox' });
    auto.checked = state.settings.autoUpdates !== false;
    auto.onchange = () => { state.settings.autoUpdates = auto.checked; saveSettings(); };
    body.append(h('label', { class: 'check upd-auto' }, auto, ' Tell me when an update is available'));
  };
  draw();
  const off = bus.on('updateStatus', () => { if (body.isConnected) draw(); });
  await modal({ title: 'Updates', width: 520, body, buttons: [], onClose: () => off() });
}

/** what changed in the version running now (the notes come with the program) */
export async function showWhatsNew({ updated = false } = {}) {
  const r = await api('update:notes').catch(() => null);
  if (!r?.notes) return false;
  await modal({
    title: updated ? 'Dogfile was updated' : 'What’s new',
    width: 520,
    body: h('div', { class: 'upd' },
      h('div', { class: 'upd-head good' }, h('div', {}, h('b', {}, `Dogfile ${r.version}`), h('div', { class: 'hint' }, updated ? 'The update was applied.' : 'This version'))),
      notesEl(r.notes)),
    buttons: [{ label: 'Close', primary: true, value: true }],
  });
  return true;
}

// after an update: say so once, with what changed
async function afterUpdate() {
  const v = sys.version;
  const last = state.settings.lastVersion;
  if (last === v) return;
  state.settings.lastVersion = v;
  saveSettings();
  if (last) {
    // wait until nothing else is open (the welcome tour, a restored dialog)
    for (let i = 0; i < 20 && document.querySelector('.modal-back'); i++) await new Promise((r) => setTimeout(r, 1000));
    await showWhatsNew({ updated: true });
  }
}

export function startUpdates() {
  setTimeout(afterUpdate, 2500);
  const tick = async () => {
    if (state.settings.autoUpdates === false) return;
    const s = await checkNow();
    if (s?.available) maybePopup();
  };
  setTimeout(tick, 8000);
  setInterval(tick, 6 * 3600 * 1000);
  // after "Later", ask again once 24 hours have passed (checked every 30 minutes)
  setInterval(() => { if (state.settings.autoUpdates !== false && U.status?.available) maybePopup(); }, 30 * 60 * 1000);
}
