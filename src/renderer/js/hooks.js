// File events for features and macros. Before a copy, move, delete, rename, drop, compress or extract happens,
// features that listen (dogfile.on('beforeMove', …)) get to look at it and change where it goes, which files it
// takes, the new name, copy-or-move, or stop it with a reason. Afterwards they (and macros with an event trigger)
// hear what happened. A feature that takes too long or fails is skipped, never blocking the operation.
import { bus } from './core.js';

export const BEFORE = {
  beforeCopy: 'Before files are copied', beforeMove: 'Before files are moved', beforeDelete: 'Before files are deleted or recycled',
  beforeRename: 'Before a file is renamed', beforeDrop: 'Before files dropped with the mouse are copied or moved',
  beforeCompress: 'Before files are compressed', beforeExtract: 'Before archives are extracted',
};
export const AFTER = {
  afterCopy: 'After files were copied', afterMove: 'After files were moved', afterDelete: 'After files were deleted or recycled',
  afterRename: 'After a file was renamed', afterCompress: 'After files were compressed', afterExtract: 'After archives were extracted',
  navigate: 'After a folder was opened',
};
export const EVENTS = { ...BEFORE, ...AFTER };

// each source runs its listeners for an event and answers [{ feature, result }]
const sources = new Set();
export function addHookSource(fn) { sources.add(fn); return () => sources.delete(fn); }
export const hasListeners = () => sources.size > 0;

/** ask the listeners; gives the payload as they left it, or { cancel: true, reason, by } */
export async function before(event, payload) {
  let p = { ...payload };
  for (const src of sources) {
    let results = [];
    try { results = await src(event, p); } catch { continue; }
    for (const { feature, result: r } of results || []) {
      if (!r || typeof r !== 'object') continue;
      if (r.cancel) return { ...p, cancel: true, reason: String(r.reason || `Stopped by the feature “${feature}”`), by: feature };
      // only what makes sense for this event can be changed, and only to sensible values
      if ('dest' in p && typeof r.dest === 'string' && r.dest.trim()) p.dest = r.dest.trim();
      if (Array.isArray(p.sources) && Array.isArray(r.sources)) { const ok = new Set(p.sources); p.sources = r.sources.filter((x) => ok.has(x)); }
      if ('newName' in p && typeof r.newName === 'string' && r.newName.trim() && !/[\\/:*?"<>|]/.test(r.newName)) p.newName = r.newName.trim();
      if ('mode' in p && (r.mode === 'copy' || r.mode === 'move')) p.mode = r.mode;
    }
  }
  return p;
}
/** tell the listeners (and macros) what happened; nothing waits for them */
export function after(event, payload) {
  for (const src of sources) Promise.resolve().then(() => src(event, payload)).catch(() => {});
  bus.emit('fileEvent', { event, ...payload });
}

// a folder opened (once per change of folder in each tab)
const lastPath = new WeakMap();
bus.on('loaded', (t) => {
  if (!t?.path || lastPath.get(t) === t.path) return;
  lastPath.set(t, t.path);
  if (sources.size) after('navigate', { path: t.path });
});
