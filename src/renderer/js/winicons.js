// The icons Windows shows for files (the app's picture for a .docx, the zip icon, a program's own icon). Used by the file
// lists and the file picker. One picture is kept per file type and size; when Windows has none, `fallback` supplies Dogfile's own.
import { state, IS_WIN } from './core.js';

const cache = new Map();
/** whether file lists should show the Windows icons (the setting is on and this is Windows) */
export const winIconsOn = () => !!state.settings?.useWindowsIcons && !!IS_WIN();

const ownKey = ['exe', 'lnk', 'ico', 'url', 'appref-ms', 'msc', 'cpl', 'scr'];
const extOf = (p) => { const m = /\.([^.\\/:|]+)$/.exec(String(p)); return m ? m[1].toLowerCase() : ''; };

/** Fill in every `<img data-icon="path">` (add the class `big` for the large picture). `fallback(path, big)` returns html. */
export function loadWinIcons(imgs, fallback) {
  for (const img of imgs) (async () => {
    await null; // the picture may be put on the page in the same breath as this call
    const p = img.dataset.icon;
    const e = extOf(p);
    const size = img.classList.contains('big') ? 'large' : 'normal';
    const key = (ownKey.includes(e) || !e ? p : '.' + e) + '|' + size;
    let u = cache.get(key);
    if (u === undefined) {
      u = await window.atlas.invoke('icon:get', p, size).catch(() => null);
      if (u) cache.set(key, u);
    }
    if (!img.isConnected) return;
    if (u) img.src = u;
    else { const t = document.createElement('template'); t.innerHTML = fallback(p, size === 'large'); img.replaceWith(t.content.firstElementChild); }
  })();
}
