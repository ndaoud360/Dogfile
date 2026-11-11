// Big parts of Dogfile that are downloaded the first time they're needed (the media engine, text recognition, the AI
// runtime): ask once, show the progress, and carry on with what the person was doing. The backend (components.rs)
// checks every download against a checksum written into the program when it was built.
import { api, h, esc, toast, sys } from './core.js';
import { confirm } from './dialogs.js';

const fmtMB = (b) => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
const asking = new Map(); // one question at a time per part, however many things want it at once

/** whether the part is here */
export async function componentReady(name) {
  const s = await api('components:status').catch(() => null);
  return !!s?.[name]?.ready;
}

/** Make sure a part is installed. Asks first (naming its size and what it's for), then downloads with a progress bar.
 * `what` says what the person was doing ("Playing this video"). Resolves true when the part is ready, false when they
 * said no, it isn't available in this copy of Dogfile, or the download failed (a message says which). */
export function ensureComponent(name, what = '') {
  if (!asking.has(name)) asking.set(name, run(name, what).finally(() => asking.delete(name)));
  return asking.get(name);
}

async function run(name, what) {
  let all = await api('components:status').catch(() => null);
  const c = all?.[name];
  if (!c) return false;
  if (c.ready) return true;
  if (!c.downloadable) { toast(`${c.label} isn’t part of this copy of Dogfile. Reinstall Dogfile from the Microsoft Store or the website.`, { error: true }); return false; }
  if (!c.downloading) {
    const ok = await confirm(`Download ${esc(c.label)}?`,
      `${what ? esc(what) + ' needs' : 'This needs'} a one-time download of <b>${esc(c.label)}</b> (about ${fmtMB(c.bytes)}). It ${esc(c.why)}. It is saved on this PC and checked before it’s used; your files never leave your PC.`, { ok: 'Download' });
    if (!ok) return false;
    const r = await api('components:install', name).catch((e) => ({ error: e.message || String(e) }));
    if (r?.error) { toast(r.error, { error: true }); return false; }
  }
  const fill = h('div', { class: 'tp-fill' }), txt = h('span', {}, `Downloading ${c.label}…`);
  const el = h('div', { class: 'toast show tprog' }, txt, h('div', { class: 'tp-bar' }, fill));
  document.getElementById('toasts')?.append(el);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      all = await api('components:status');
      const s = all[name];
      if (s.ready) break;
      if (s.error) throw new Error(s.error);
      if (!s.downloading) throw new Error('The download didn’t finish');
      const pct = s.total ? Math.min(100, (s.received / s.total) * 100) : 5;
      fill.style.width = (s.stage === 'Installing' ? 100 : pct) + '%';
      txt.textContent = s.stage === 'Installing' ? `Installing ${c.label}…` : `Downloading ${c.label}… ${fmtMB(s.received)}${s.total ? ' of ' + fmtMB(s.total) : ''}`;
    }
    if (name === 'ffmpeg') sys.ffmpeg = true;
    toast(`${c.label} is ready`);
    return true;
  } catch (e) { toast(`Couldn’t download ${c.label}: ${e.message}`, { error: true }); return false; }
  finally { el.remove(); }
}
