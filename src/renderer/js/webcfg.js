// Dogfile Web: the URL buttons (sites you open beside what you are looking at) and turning typed text into an address.
import { state, saveSettings, h, bus, toast } from './core.js';
import { webButtons } from './webaddr.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';

// where a button shows: everywhere, or only for some kinds of things
export const WEB_FOR = [['any', 'Everywhere'], ['folder', 'Folders'], ['image', 'Pictures'], ['psd', 'Photoshop files'], ['video', 'Videos'], ['audio', 'Music'], ['doc', 'Documents']];
export { DEFAULT_WEB_BUTTONS, webButtons, buttonsFor, homePage, resolveInput } from './webaddr.js';

/** Settings > Web: the buttons, one row each */
export function editWebButtons() {
  let rows = webButtons().map((b) => ({ name: b.name || '', url: b.url || '', for: [...(b.for || ['any'])] }));
  const list = h('div', { class: 'wbe-list' });
  const draw = () => {
    list.innerHTML = '';
    rows.forEach((r, i) => {
      const name = h('input', { class: 'input wbe-name', type: 'text', value: r.name, placeholder: 'Name', 'aria-label': 'Button name', oninput: () => { r.name = name.value; } });
      const url = h('input', { class: 'input wbe-url', type: 'text', value: r.url, placeholder: 'https://…', 'aria-label': 'Web address', spellcheck: 'false', oninput: () => { url.classList.toggle('bad', !!url.value.trim() && !/^https?:\/\/\S+/i.test(url.value.trim())); r.url = url.value; } });
      const del = h('button', { class: 'icon-btn wbe-del', title: 'Remove this button', 'aria-label': 'Remove this button', html: icon('close'), onclick: () => { rows.splice(i, 1); draw(); } });
      const chips = h('div', { class: 'wbe-chips' }, ...WEB_FOR.map(([k, label]) => {
        const chip = h('button', { type: 'button', class: 'wbe-chip' + (r.for.includes(k) ? ' on' : ''), 'aria-pressed': String(r.for.includes(k)) }, label);
        chip.addEventListener('click', () => {
          r.for = r.for.includes(k) ? r.for.filter((x) => x !== k) : [...new Set([...r.for, k])];
          chip.classList.toggle('on', r.for.includes(k)); chip.setAttribute('aria-pressed', String(r.for.includes(k)));
        });
        return chip;
      }));
      list.append(h('div', { class: 'wbe-card' }, h('div', { class: 'wbe-top' }, name, url, del), h('div', { class: 'wbe-show' }, h('span', { class: 'wbe-lbl' }, 'Show it for'), chips)));
    });
    if (!rows.length) list.append(h('div', { class: 'hint' }, 'No buttons yet. Add one below.'));
  };
  draw();
  const home = h('input', { class: 'input', type: 'text', value: state.settings.webHome || '', placeholder: 'https://duckduckgo.com', spellcheck: 'false', });
  const local = h('input', { type: 'checkbox' });
  local.checked = !!state.settings.webLocal;
    const body = h('div', { class: 'wbe' },
    h('p', { class: 'wbe-intro' }, 'Each button opens a site in a web pane beside what you are looking at, such as Photopea next to a picture or a Photoshop file, so you can drag the file in.'),
    list,
    h('button', { class: 'btn with-ic wbe-add', onclick: () => { rows.push({ name: '', url: 'https://', for: ['any'] }); draw(); list.lastElementChild?.querySelector('.wbe-name')?.focus(); } }, h('span', { html: icon('plus') }), 'Add a button'),
    h('div', { class: 'wbe-sec' }, 'Browser'),
    h('label', { class: 'wbe-field' }, h('span', { class: 'wbe-lbl' }, 'Start page'), home),
    h('label', { class: 'wbe-check' }, local, h('span', {}, h('b', {}, 'Allow addresses on this computer and my home network'), h('span', { class: 'hint' }, 'Off is safer: a web page can’t reach your computer or router.'))),
  );
  return modal({
    title: 'URL buttons', body, width: 640,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', primary: true, run: (close) => {
        const clean = rows.map((r) => ({ name: r.name.trim() || (r.url.replace(/^https?:\/\//, '').split('/')[0]), url: r.url.trim(), for: r.for.length ? r.for : ['any'] })).filter((r) => /^https?:\/\/\S+/i.test(r.url));
        state.settings.webButtons = clean;
        state.settings.webHome = home.value.trim() || undefined; // only when saved: Cancel changes nothing
        state.settings.webLocal = local.checked;
        saveSettings();
        bus.emit('settings');
        toast('URL buttons saved');
        close('save');
      } },
    ],
  });
}
