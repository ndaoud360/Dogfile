// Your settings on every PC: export them to a file and import them elsewhere, or keep them in a folder that
// syncs (OneDrive, Dropbox, Google Drive, a USB stick…) so every Dogfile using that folder shares them.
import { api, state, bus, sys, toast, saveSettings, saveLibrary, saveTags, fmtDate } from './core.js';

const FILE = 'Dogfile settings.json';
// things that belong to this PC only
const LOCAL = new Set(['lastVersion', 'updateSnoozeUntil', 'settingsSync', 'windowBounds', 'welcomed', 'recentCommands', 'trialOfferCount', 'trialOfferAt', 'trialEndedShown']);
const EXTRA = ['editor-prefs', 'player-prefs', 'filenotes'];

async function bundle() {
  const settings = Object.fromEntries(Object.entries(state.settings).filter(([k]) => !LOCAL.has(k)));
  const extra = {};
  for (const k of EXTRA) { try { const v = await api('store:get', k); if (v != null) extra[k] = v; } catch {} }
  return { dogfile: 'settings', version: sys.version || '', from: state.hostname || '', saved: Date.now(), settings, library: { pinned: state.pinned, workspaces: state.workspaces, folderViews: state.folderViews }, tags: state.tags, extra };
}
async function apply(b, { quiet = false } = {}) {
  // files exported by older versions
  if (b && b.type === 'atlas-settings') b = { dogfile: 'settings', settings: b.settings, tags: b.tags, library: { pinned: b.pinned, workspaces: b.workspaces } };
  if (!b || b.dogfile !== 'settings' || typeof b.settings !== 'object') throw new Error('This isn’t a Dogfile settings file');
  const keep = Object.fromEntries(Object.entries(state.settings).filter(([k]) => LOCAL.has(k)));
  state.settings = { ...state.settings, ...b.settings, ...keep };
  saveSettings();
  if (b.library) { if (Array.isArray(b.library.pinned)) state.pinned = b.library.pinned; if (b.library.workspaces) state.workspaces = b.library.workspaces; if (b.library.folderViews) state.folderViews = b.library.folderViews; saveLibrary(); }
  if (b.tags?.defs) { state.tags = { defs: b.tags.defs, map: { ...(state.tags.map || {}), ...(b.tags.map || {}) } }; saveTags(); }
  for (const [k, v] of Object.entries(b.extra || {})) if (EXTRA.includes(k)) await api('store:set', k, v);
  bus.emit('settings'); bus.emit('theme'); bus.emit('sidebar'); bus.emit('tags');
  if (!quiet) toast(`Settings imported${b.from ? ` from ${b.from}` : ''}`);
}

export async function exportSettings() {
  const p = await api('dialog:saveFile', { title: 'Export settings', defaultPath: FILE, filters: [{ name: 'Dogfile settings', extensions: ['json'] }] });
  if (!p) return;
  await api('fs:writeText', p, JSON.stringify(await bundle(), null, 2));
  toast('Settings exported');
}
export async function importSettings() {
  const [p] = await api('dialog:openFiles', { title: 'Import settings', filters: [{ name: 'Dogfile settings', extensions: ['json'] }] });
  if (!p) return;
  try { await apply(JSON.parse((await api('fs:readText', p, 8 * 1048576)).text)); } catch (e) { toast(e.message, { error: true }); }
}

// ---- a synced folder ----
const sep = () => sys.sep || '\\';
const syncPath = () => { const f = state.settings.settingsSync?.folder; return f ? f.replace(/[\\/]+$/, '') + sep() + FILE : null; };
let lastSig = '', timer = null, busy = false;
const sigOf = (b) => JSON.stringify([b.settings, b.library, b.tags, b.extra]);
export async function chooseSyncFolder() {
  const f = await api('dialog:pickFolder', { title: 'Keep settings in this folder (for example in OneDrive)' });
  if (!f) return;
  state.settings.settingsSync = { folder: f, applied: 0 };
  saveSettings();
  const p = syncPath();
  const st = await api('fs:stat', p).catch(() => null);
  if (st) { await pull(true); toast('Using the settings found in that folder'); }
  else { await push(true); toast('Settings saved to that folder; other PCs can use it too'); }
  startSync();
}
export function stopSync() { state.settings.settingsSync = null; saveSettings(); clearInterval(timer); timer = null; toast('Settings are no longer synced'); }
async function push(force) {
  const p = syncPath(); if (!p) return;
  const b = await bundle();
  const sig = sigOf(b);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  await api('fs:writeText', p, JSON.stringify(b, null, 2));
  state.settings.settingsSync = { ...state.settings.settingsSync, applied: b.saved };
  saveSettings();
}
async function pull(force) {
  const p = syncPath(); if (!p) return false;
  let b;
  try { b = JSON.parse((await api('fs:readText', p, 8 * 1048576)).text); } catch { return false; }
  if (!force && (b.saved || 0) <= (state.settings.settingsSync?.applied || 0)) return false;
  await apply(b, { quiet: true });
  lastSig = sigOf(await bundle());
  state.settings.settingsSync = { ...state.settings.settingsSync, applied: b.saved || Date.now() };
  saveSettings();
  if (!force) toast(`Settings updated from ${b.from || 'another PC'}`);
  return true;
}
async function tick() {
  if (busy || !syncPath()) return;
  busy = true;
  try { if (!(await pull(false))) await push(false); } catch {} finally { busy = false; }
}
export function startSync() {
  if (!state.settings.settingsSync?.folder) return;
  clearInterval(timer);
  timer = setInterval(tick, 30000);
  setTimeout(tick, 3000);
}
export function syncStatus() {
  const s = state.settings.settingsSync;
  return s?.folder ? `Synced through ${s.folder}${s.applied ? ` · last ${fmtDate(s.applied)}` : ''}` : 'Not synced';
}
