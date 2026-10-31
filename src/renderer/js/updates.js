// Updates: a check a few seconds after start and every few hours; a "New update available" pop-up (again every
// 24 hours after "Later"); the Updates window with the changelog and "Update now"; and the File menu entry
// (red when an update is waiting, green when up to date).
import { api, state, bus, h, esc, toast, fmtSize, fmtDate, saveSettings, onMain, sys } from './core.js';
import { modal } from './dialogs.js';

export const U = { status: null, checking: false };
const DAY = 24 * 3600 * 1000;

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

// the pop-up: Update / Later (Later waits 24 hours)
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
      h('div', {}, h('b', {}, `Dogfile ${s.latest}`), h('div', { class: 'hint' }, `You have ${s.current}.${s.size ? ` Download: ${fmtSize(s.size)}.` : ''}`))),
    buttons: [{ label: 'Later', value: 'later' }, { label: 'Update', primary: true, value: 'update' }],
    closeOnBackdrop: false,
  });
  popupOpen = false;
  if (v === 'update') openUpdates();
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
        h('div', { class: 'upd-head bad' }, h('div', {}, h('b', {}, `Dogfile ${s.latest}`), h('div', { class: 'hint' }, `${s.date ? new Date(s.date + 'T12:00:00').toLocaleDateString() + ' · ' : ''}you have ${s.current}${s.size ? ` · ${fmtSize(s.size)} to download` : ''}`))),
        h('div', { class: 'upd-sec' }, 'What’s new'), notesEl(s.notes));
      const bar = h('div', { class: 'tp-bar upd-bar' }, h('div', { class: 'tp-fill' }));
      const msg = h('div', { class: 'hint upd-msg' });
      const go = h('button', { class: 'btn primary' }, s.canInstall === false ? 'Download' : 'Update now');
      const cancel = h('button', { class: 'btn', style: { display: 'none' } }, 'Cancel');
      cancel.onclick = () => api('update:cancel');
      go.onclick = async () => {
        go.disabled = true; cancel.style.display = ''; bar.style.display = 'block'; msg.textContent = 'Downloading…';
        const off = onMain('update:progress', (p) => {
          if (p.stage === 'download') { bar.firstChild.style.width = Math.round((p.done / Math.max(1, p.total)) * 100) + '%'; msg.textContent = `Downloading… ${fmtSize(p.done)} of ${fmtSize(p.total)}`; }
          else if (p.stage === 'unpack') msg.textContent = 'Getting it ready…';
        });
        try {
          await api('update:download');
          off?.();
          bar.firstChild.style.width = '100%';
          if (s.canInstall === false) { msg.textContent = 'Downloaded. Installing updates works on Windows.'; return; }
          msg.textContent = 'Restarting Dogfile to finish the update…';
          cancel.style.display = 'none';
          // open tabs come back after the restart
          bus.emit('saveSession');
          await new Promise((r) => setTimeout(r, 800));
          await api('update:install');
        } catch (e) { off?.(); msg.textContent = e.message; go.disabled = false; cancel.style.display = 'none'; go.textContent = 'Try again'; }
      };
      body.append(bar, msg, h('div', { class: 'upd-acts' }, cancel, go));
    } else {
      const ok = s.checked && !s.error;
      body.append(
        h('div', { class: 'upd-head ' + (ok ? 'good' : '') }, h('div', {}, h('b', {}, ok ? 'Dogfile is up to date' : U.checking ? 'Checking for updates…' : 'Updates'), h('div', { class: 'hint' }, `Version ${s.current || sys.version || ''}${s.checked ? ` · checked ${fmtDate(s.checked)}` : ''}`))),
        s.error ? h('div', { class: 'hint upd-err' }, s.error) : null);
      const btn = h('button', { class: 'btn primary', disabled: U.checking ? true : null }, U.checking ? 'Checking…' : 'Check for updates');
      btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Checking…'; await checkNow({ quiet: true }); draw(); };
      body.append(h('div', { class: 'upd-acts' }, btn));
    }
    const auto = h('input', { type: 'checkbox' });
    auto.checked = state.settings.autoUpdates !== false;
    auto.onchange = () => { state.settings.autoUpdates = auto.checked; saveSettings(); };
    body.append(h('label', { class: 'check upd-auto' }, auto, ' Check for updates automatically'));
  };
  draw();
  const off = bus.on('updateStatus', () => { if (body.isConnected && !body.querySelector('.upd-bar[style*="block"]')) draw(); });
  await modal({ title: 'Updates', width: 520, body, buttons: [], onClose: () => off() });
}

// after an update: say so once
function afterUpdate() {
  const v = sys.version;
  const last = state.settings.lastVersion;
  if (last !== v) {
    state.settings.lastVersion = v;
    saveSettings();
    if (last) toast(`Dogfile was updated to ${v}`, { action: { label: 'What’s new', run: () => { checkNow().then(() => openUpdates()); } } });
  }
}

export function startUpdates() {
  afterUpdate();
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
