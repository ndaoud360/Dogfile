// What an icon theme from a file or from GitHub may contain. Plain functions, no window (tested without one).
export const MAX_ICONS = 80;
export const MAX_ICON_CHARS = 80000; // one picture as a data address: about 60 KB of PNG
const DATA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const cleanExt = (v) => String(v || '').trim().toLowerCase().replace(/^\*?\./, '').replace(/[^a-z0-9]/g, '').slice(0, 10);

/** an icon theme cut down to extensions with real small PNG pictures (nothing else is ever drawn); null when nothing is usable */
export function sanitizeIconTheme(t) {
  if (!t || typeof t !== 'object' || !t.icons || typeof t.icons !== 'object') return null;
  const icons = {};
  for (const [k, v] of Object.entries(t.icons)) {
    const e = cleanExt(k);
    if (e && e === k.toLowerCase() && typeof v === 'string' && v.length <= MAX_ICON_CHARS && DATA_PNG.test(v) && Object.keys(icons).length < MAX_ICONS) icons[e] = v;
  }
  if (!Object.keys(icons).length) return null;
  return { name: String(t.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40), icons };
}
