// Dogfile Web: the URL buttons (sites you open beside what you are looking at) and turning typed text into an address.
import { state, saveSettings, h, bus, toast } from './core.js';
import { modal } from './dialogs.js';

// where a button shows: everywhere, or only for some kinds of things
export const WEB_FOR = [['any', 'Everywhere'], ['folder', 'Folders'], ['image', 'Pictures'], ['psd', 'Photoshop files'], ['video', 'Videos'], ['audio', 'Music'], ['doc', 'Documents']];
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

const URLISH = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i;
/** what was typed in the address bar: an address as it is, a name like "example.com" with https, anything else a search */
export function resolveInput(text, settings = state.settings) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (URLISH.test(t)) return 'https://' + t;
  const s = settings.webSearch || 'https://duckduckgo.com/?q=%s';
  return s.replace('%s', encodeURIComponent(t));
}

/** Settings > Web: the buttons, one row each */
export function editWebButtons() {
  let rows = webButtons().map((b) => ({ name: b.name || '', url: b.url || '', for: [...(b.for || ['any'])] }));
  const list = h('div', {});
  const draw = () => {
    list.innerHTML = '';
    rows.forEach((r, i) => {
      const name = h('input', { type: 'text', value: r.name, placeholder: 'Name', oninput: () => { r.name = name.value; } });
      const url = h('input', { type: 'text', value: r.url, placeholder: 'https://…', oninput: () => { r.url = url.value; } });
      const del = h('button', { class: 'btn', title: 'Remove', onclick: () => { rows.splice(i, 1); draw(); } }, 'Remove');
      const fors = h('div', { class: 'wb-for' }, ...WEB_FOR.map(([k, label]) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = r.for.includes(k);
        cb.addEventListener('change', () => { r.for = cb.checked ? [...new Set([...r.for, k])] : r.for.filter((x) => x !== k); });
        return h('label', {}, cb, label);
      }));
      list.append(h('div', { class: 'wb-row' }, name, url, del), fors);
    });
  };
  draw();
  const body = h('div', {},
    h('div', { class: 'confirm-msg' }, 'These buttons open a site in a web pane beside what you are looking at: Photopea next to a picture or a Photoshop file, for example, so you can drag the file in.'),
    list,
    h('button', { class: 'btn', onclick: () => { rows.push({ name: '', url: 'https://', for: ['any'] }); draw(); } }, 'Add a button'),
    h('div', { class: 'wb-row', style: { marginTop: '14px' } }, h('span', {}, 'Start page'), (() => { const i = h('input', { type: 'text', value: state.settings.webHome || '', placeholder: 'https://duckduckgo.com', oninput: () => { state.settings.webHome = i.value.trim() || undefined; } }); return i; })(), h('span', {})),
    h('label', { class: 'wb-for', style: { border: 0, marginTop: '8px' } }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = !!state.settings.webLocal; c.addEventListener('change', () => { state.settings.webLocal = c.checked; }); return c; })(), 'Allow addresses on this computer and my home network (off is safer: a web page can’t reach them)'),
  );
  return modal({
    title: 'URL buttons', body, width: 620,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', primary: true, run: (close) => {
        const clean = rows.map((r) => ({ name: r.name.trim() || (r.url.replace(/^https?:\/\//, '').split('/')[0]), url: r.url.trim(), for: r.for.length ? r.for : ['any'] })).filter((r) => /^https?:\/\/\S+/i.test(r.url));
        state.settings.webButtons = clean;
        saveSettings();
        bus.emit('settings');
        toast('URL buttons saved');
        close('save');
      } },
    ],
  });
}
