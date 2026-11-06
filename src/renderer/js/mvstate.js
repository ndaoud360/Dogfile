// Multiverse Mode, the part everything else asks: is one open, and is this place inside it?
// (Kept apart from multiverse mode's window so the file actions and the folder view can ask without importing it.)
import { state, normalize } from './core.js';

const flat = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export const mvActive = () => !!state.mv;
export const mvRoot = () => state.mv?.root || '';
export const mvName = () => { const r = mvRoot().replace(/[\\/]+$/, ''); return r.split(/[\\/]/).pop() || r; };

/** inside the Multiverse folder (the folder itself counts unless `strict`) */
export function mvInside(p, strict = false) {
  if (!state.mv) return true;
  const r = flat(normalize(state.mv.root)), q = flat(normalize(p));
  return strict ? q.startsWith(r + '/') : q === r || q.startsWith(r + '/');
}

export const mvStayMessage = () => `Stay within “${mvName()}” or exit Multiverse.`;

/** why a file job may not run in this Multiverse (or '' when it may) */
export function mvJobBlocked(spec) {
  if (!state.mv) return '';
  const src = spec.sources || [];
  if (['move', 'trash', 'delete'].includes(spec.type) && src.some((s) => !mvInside(s, true))) return mvStayMessage();
  if (['copy', 'move', 'extract', 'compress'].includes(spec.type) && spec.dest && !mvInside(spec.dest)) return mvStayMessage();
  return '';
}
