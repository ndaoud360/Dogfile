// Dogfile Web, the parts that need no page: the URL buttons and turning typed text into an address.
import { state } from './core.js';

export const DEFAULT_WEB_BUTTONS = [
  { name: 'Photopea', url: 'https://www.photopea.com', for: ['image', 'psd'] },
  { name: 'Squoosh', url: 'https://squoosh.app', for: ['image'] },
  { name: 'YouTube', url: 'https://www.youtube.com', for: ['any'] },
  { name: 'GitHub', url: 'https://github.com', for: ['any'] },
  { name: 'Google Drive', url: 'https://drive.google.com', for: ['folder', 'doc'] },
];
export const webButtons = (settings = state.settings) => (Array.isArray(settings.webButtons) ? settings.webButtons : DEFAULT_WEB_BUTTONS).filter((b) => b && b.url);
/** the buttons for what is showing now ("image", "psd", "folder"…): the ones made for it first, then the everywhere ones */
export function buttonsFor(ctxs, settings = state.settings) {
  const want = [].concat(ctxs || []);
  const all = webButtons(settings);
  const mine = all.filter((b) => (b.for || ['any']).some((k) => k !== 'any' && want.includes(k)));
  const any = all.filter((b) => (b.for || ['any']).includes('any'));
  return [...mine, ...any.filter((b) => !mine.includes(b))];
}
export const homePage = (settings = state.settings) => settings.webHome || 'https://duckduckgo.com';

const URLISH = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+)(:\d+)?([/?#]\S*)?$/iu;
/** what was typed in the address bar: an address as it is, a name like "example.com" with https, anything else a search */
export function resolveInput(text, settings = state.settings) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  // a machine on this computer or the home network has no secure address (it is off unless allowed in Settings)
  if (URLISH.test(t)) return (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|\?|#|$)/i.test(t) ? 'http://' : 'https://') + t;
  const s = settings.webSearch || 'https://duckduckgo.com/?q=%s';
  return s.replace('%s', encodeURIComponent(t));
}

