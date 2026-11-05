// Lock a file or folder with a password, and unlock it again (backend/src/lock.rs). A locked item is one encrypted
// .dflock file; the original is removed once the locked copy has been checked. There is no way back without the password.
import { api, h, esc, toast } from './core.js';
import { modal } from './dialogs.js';

export const LOCK_EXT = 'dflock';
export const isLocked = (it) => !it?.isDir && /\.dflock$/i.test(it?.name || it?.path || '');
export const canLock = (it) => !!it && !it.virtual && !it.mtp && !it.archive && !it.drive && !it.remote && !String(it.path || '').startsWith('atlas:') && !isLocked(it);

/** runs a lock/unlock job with a progress toast; resolves to [{ from, to, error }] */
export async function runJob(op, paths, password) {
  const id = await api('lock:start', op, paths, password);
  const fill = h('div', { class: 'tp-fill' }), txt = h('span', {}, op === 'lock' ? 'Locking…' : 'Unlocking…');
  const el = h('div', { class: 'toast show tprog' }, h('div', { class: 'tp-row' }, txt, h('button', { class: 'btn small', onclick: () => api('lock:cancel', id) }, 'Cancel')), h('div', { class: 'tp-bar' }, fill));
  document.getElementById('toasts')?.append(el);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await api('lock:status', id);
      fill.style.width = Math.min(100, (s.done / s.total) * 100) + '%';
      txt.textContent = `${op === 'lock' ? 'Locking' : 'Unlocking'} ${s.current || ''}…`;
      if (!s.running) return s.results;
    }
  } finally { el.remove(); } // the folder watcher shows the change
}

/** the password dialog. `again`: ask twice (when locking). Resolves to the password, or null */
function askPassword({ title, again, error, ok, intro }) {
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Type it again' });
  const err = h('div', { class: 'field-error' }, error || '');
  const show = h('input', { type: 'checkbox' });
  show.onchange = () => { pw.type = pw2.type = show.checked ? 'text' : 'password'; };
  for (const el of [pw, pw2]) el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') document.querySelector('.modal .btn.primary')?.click(); });
  const body = h('div', { class: 'stack' }, intro ? h('div', { class: 'confirm-msg', html: intro }) : null, pw, again ? pw2 : null, h('label', { class: 'check' }, show, ' Show the password'), err);
  setTimeout(() => pw.focus(), 50);
  return modal({ title, body, width: 460, buttons: [{ label: 'Cancel', value: null }, { label: ok, primary: true, run: (close) => {
    if (!pw.value) { err.textContent = 'Enter a password'; return false; }
    if (again && pw.value !== pw2.value) { err.textContent = 'The two passwords don’t match'; return false; }
    close(pw.value);
  } }] });
}

const nameOf = (p) => String(p).split(/[\\/]/).pop();
function report(op, results) {
  const ok = results.filter((r) => !r.error), bad = results.filter((r) => r.error);
  if (ok.length && !bad.length) toast(op === 'lock' ? (ok.length === 1 ? `Locked as “${nameOf(ok[0].to)}”` : `Locked ${ok.length} items`) : (ok.length === 1 ? `Unlocked “${nameOf(ok[0].to)}”` : `Unlocked ${ok.length} items`), { ms: 5000 });
  for (const b of bad) if (b.error !== 'Cancelled') toast(`${nameOf(b.from)}: ${b.error}`, { error: true, ms: 9000 });
}

/** the dialog for locking: the items, a password typed twice, and a warning that there is no way back without it */
export async function lockItems(items) {
  const real = items.filter(canLock);
  if (!real.length) return toast('These can’t be locked', { error: true });
  const what = real.length === 1 ? `“${esc(real[0].name)}”` : `${real.length} items`;
  const pw = await askPassword({ title: 'Lock with a password', again: true, ok: 'Lock',
    intro: `Lock ${what}? It becomes one encrypted file${real.length > 1 ? ' each' : ''} that only this password opens, and the original is removed once the locked copy has been checked. <b>Dogfile can’t recover a forgotten password.</b>` });
  if (pw == null) return;
  const results = await runJob('lock', real.map((i) => i.path), pw);
  report('lock', results);
  return results;
}

/** the dialog for unlocking; a wrong password asks again */
export async function unlockItems(items) {
  const locked = items.filter(isLocked);
  if (!locked.length) return;
  let error = '';
  for (;;) {
    const pw = await askPassword({ title: locked.length === 1 ? `Unlock “${locked[0].name}”` : `Unlock ${locked.length} items`, again: false, ok: 'Unlock', error });
    if (pw == null) return;
    const results = await runJob('unlock', locked.map((i) => i.path), pw);
    const wrong = results.filter((r) => r.error === 'Wrong password');
    if (!wrong.length) { report('unlock', results); return results; }
    report('unlock', results.filter((r) => r.error !== 'Wrong password'));
    error = 'That password didn’t open it. Try again.';
    locked.splice(0, locked.length, ...locked.filter((i) => wrong.some((w) => w.from === i.path)));
  }
}

/** for the assistant: lock or unlock without the dialogs (the password came from the person's own words) */
export async function lockWithPassword(op, paths, password) {
  const results = await runJob(op, paths, password);
  report(op, results);
  return results;
}
