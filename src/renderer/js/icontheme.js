// Icon themes: a name and, for each file extension, a picture the person chose. One theme at a time can be on; while it is,
// those files show its picture in file lists and grids instead of the Windows or Dogfile icon. Settings > Colors > Icons.
// The pictures are kept as small PNGs inside the settings, so a theme goes with an exported color theme.
import { state, saveSettings, bus, fileUrl } from './core.js';
import { MAX_ICONS, MAX_ICON_CHARS, cleanExt, sanitizeIconTheme } from './iconsafe.js';

export { MAX_ICONS, MAX_ICON_CHARS, cleanExt, sanitizeIconTheme };

const themes = () => (state.settings.iconThemes = state.settings.iconThemes && typeof state.settings.iconThemes === 'object' ? state.settings.iconThemes : {});
export const themeNames = () => Object.keys(themes());
export const iconsOf = (name) => themes()[name]?.icons || {};
export const activeName = () => (state.settings.iconTheme && themes()[state.settings.iconTheme] ? state.settings.iconTheme : null);
/** the picture for a file extension in the theme that is on, or null */
export const customIcon = (ext) => { const n = activeName(); return n ? themes()[n].icons[String(ext || '').toLowerCase()] || null : null; };

function changed() {
  saveSettings(); bus.emit('settings');
  import('./pane.js').then((m) => m.renderAll());
}
export function addTheme(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n || themes()[n]) return null;
  themes()[n] = { icons: {} };
  saveSettings();
  return n;
}
export function renameTheme(old, name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n || (n !== old && themes()[n])) return false;
  themes()[n] = themes()[old]; if (n !== old) delete themes()[old];
  if (state.settings.iconTheme === old) state.settings.iconTheme = n;
  saveSettings();
  return true;
}
export function deleteTheme(name) {
  delete themes()[name];
  if (state.settings.iconTheme === name) state.settings.iconTheme = null;
  changed();
}
/** turn a theme on (only one at a time), or null for the default icons */
export function setActive(name) { state.settings.iconTheme = name && themes()[name] ? name : null; changed(); }
export function setIcon(name, ext, dataUrl) {
  const t = themes()[name], e = cleanExt(ext);
  if (!t || !e) return false;
  if (!t.icons[e] && Object.keys(t.icons).length >= MAX_ICONS) return false;
  t.icons[e] = dataUrl;
  if (state.settings.iconTheme === name) changed(); else saveSettings();
  return true;
}
export function removeIcon(name, ext) {
  const t = themes()[name];
  if (!t) return;
  delete t.icons[ext];
  if (state.settings.iconTheme === name) changed(); else saveSettings();
}
/** the theme that is on, for an exported color theme: { name, icons } or null */
export function exportActive() {
  const n = activeName();
  return n && Object.keys(themes()[n].icons).length ? { name: n, icons: { ...themes()[n].icons } } : null;
}
/** an icon theme that came with a color theme: kept under a free name and turned on. Returns its name, or null */
export function adopt(t) {
  const c = sanitizeIconTheme(t);
  if (!c) return null;
  let n = c.name || 'Shared icons', i = 2;
  const base = n;
  // the same pictures under the same name are already here
  if (themes()[n] && JSON.stringify(themes()[n].icons) === JSON.stringify(c.icons)) { setActive(n); return n; }
  while (themes()[n]) n = `${base} ${i++}`;
  themes()[n] = { icons: c.icons };
  setActive(n);
  return n;
}

/** a picture file → a small square-ish PNG (at most 128 px, transparency kept) as a data address */
export async function pictureToIcon(path) {
  const img = new Image();
  img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That picture can’t be read')); img.src = fileUrl(path); });
  const w = img.naturalWidth || 128, h = img.naturalHeight || 128;
  const k = Math.min(1, 128 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  if (url.length > MAX_ICON_CHARS) throw new Error('That picture is too detailed for an icon; try a simpler or smaller one');
  return url;
}
