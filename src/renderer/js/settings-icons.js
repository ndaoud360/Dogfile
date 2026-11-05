// Settings > Colors > Icons: the list of icon themes, and the page of one theme (extension → picture).
import { api, state, h, toast, sys } from './core.js';
import { icon } from './icons.js';
import { modal, prompt, confirm } from './dialogs.js';
import * as IT from './icontheme.js';

/** draws the icon themes into `el`. `back()` returns to the Colors page */
export function buildIconsPage(el, back) {
  let editing = null;
  const head = (title, onBack, onPlus, plusTip) => h('div', { class: 'ic-head' },
    h('button', { class: 'icon-btn', title: 'Back', html: icon('back'), onclick: onBack }),
    h('div', { class: 'ic-title' }, title),
    h('button', { class: 'icon-btn ic-plus', title: plusTip, html: icon('plus'), onclick: onPlus }));
  const draw = () => { el.innerHTML = ''; editing ? drawTheme() : drawList(); };

  const drawList = () => {
    const active = IT.activeName();
    const add = async () => {
      const n = await prompt('New icon theme', '', { label: 'Theme name', placeholder: 'e.g. Neon', validate: (v) => (!v.trim() ? 'Enter a name' : IT.themeNames().includes(v.trim()) || v.trim().toLowerCase() === 'default' ? 'That name is used' : '') });
      if (n && IT.addTheme(n)) draw();
    };
    el.append(head('Icon themes', back, add, 'New icon theme'),
      h('p', { class: 'hint' }, 'Pick a picture for any file type. While a theme is on, those files show your pictures in lists and grids. A theme goes along when you export a color theme.'));
    const list = h('div', { class: 'ic-list' });
    const row = (name, on, onToggle, onOpen, sub) => {
      const cb = h('input', { type: 'checkbox', title: on ? 'On' : 'Turn on' }); cb.checked = on;
      cb.addEventListener('change', onToggle);
      return h('div', { class: 'ic-row' + (on ? ' on' : '') }, cb, h('div', { class: 'ic-name', onclick: onOpen || null }, h('b', {}, name), h('span', { class: 'hint' }, sub)), onOpen ? h('button', { class: 'btn small', onclick: onOpen }, 'Edit') : null);
    };
    list.append(row('Default', !active, () => { IT.setActive(null); draw(); }, null, 'Windows icons when that setting is on, Dogfile’s own otherwise'));
    for (const n of IT.themeNames()) {
      const count = Object.keys(IT.iconsOf(n)).length;
      list.append(row(n, active === n, (e) => { IT.setActive(e.target.checked ? n : null); draw(); }, () => { editing = n; draw(); }, `${count} icon${count === 1 ? '' : 's'}`));
    }
    el.append(list);
  };

  const drawTheme = () => {
    const name = editing;
    if (!IT.themeNames().includes(name)) { editing = null; return draw(); }
    const add = () => addIconDialog(name, draw);
    el.append(head(name, () => { editing = null; draw(); }, add, 'Add an icon'));
    const on = IT.activeName() === name;
    const cb = h('input', { type: 'checkbox' }); cb.checked = on;
    cb.addEventListener('change', () => { IT.setActive(cb.checked ? name : null); });
    el.append(h('div', { class: 'row-inline', style: { margin: '6px 0 10px' } },
      h('label', { class: 'check' }, cb, ' Use this icon theme'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Rename theme', name, { validate: (v) => (!v.trim() ? 'Enter a name' : v.trim() !== name && IT.themeNames().includes(v.trim()) ? 'That name is used' : '') }); if (n && IT.renameTheme(name, n.trim())) { editing = n.trim(); draw(); } } }, 'Rename'),
      h('button', { class: 'btn small danger', onclick: async () => { if (await confirm('Delete this icon theme?', `“${name}” and its pictures will be removed.`, { ok: 'Delete', danger: true })) { IT.deleteTheme(name); editing = null; draw(); } } }, 'Delete')));
    const icons = IT.iconsOf(name);
    const exts = Object.keys(icons).sort();
    if (!exts.length) el.append(h('div', { class: 'hint ic-empty' }, 'Nothing here yet. Press + to pick a file type (like .pdf) and a picture for it.'));
    const list = h('div', { class: 'ic-list' });
    for (const e of exts) {
      list.append(h('div', { class: 'ic-row' }, h('img', { class: 'ic-thumb', src: icons[e], alt: '' }), h('div', { class: 'ic-name' }, h('b', {}, '.' + e)),
        h('button', { class: 'btn small', onclick: () => addIconDialog(name, draw, e) }, 'Change picture'),
        h('button', { class: 'icon-btn small', title: 'Remove', html: icon('trash'), onclick: () => { IT.removeIcon(name, e); draw(); } })));
    }
    el.append(list);
  };
  draw();
}

/** the box that asks for a file type and a picture */
async function addIconDialog(theme, done, fixedExt = '') {
  let data = null;
  const ext = h('input', { class: 'input', value: fixedExt ? '.' + fixedExt : '', placeholder: 'File type, e.g. .pdf', spellcheck: 'false', disabled: !!fixedExt });
  const err = h('div', { class: 'field-error' });
  const prev = h('img', { class: 'ic-preview', alt: '' });
  prev.style.display = 'none';
  const pick = h('button', { class: 'btn', onclick: async () => {
    const [f] = (await api('dialog:openFiles', { title: 'Choose a picture', defaultPath: sys.known.pictures || sys.known.downloads, filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'] }] })) || [];
    if (!f) return;
    try { data = await IT.pictureToIcon(f); prev.src = data; prev.style.display = ''; err.textContent = ''; } catch (e) { err.textContent = e.message || String(e); }
  } }, 'Choose a picture…');
  ext.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('div', { class: 'stack' }, h('label', { class: 'field-label' }, 'File type'), ext, h('label', { class: 'field-label' }, 'Picture'), h('div', { class: 'row-inline' }, pick, prev), err);
  const ok = await modal({ title: fixedExt ? `Picture for .${fixedExt}` : 'Add an icon', body, width: 440, buttons: [{ label: 'Cancel', value: null }, { label: fixedExt ? 'Save' : 'Add', primary: true, run: (close) => {
    const e = IT.cleanExt(ext.value);
    if (!e) { err.textContent = 'Type a file type, like .pdf'; return false; }
    if (!data) { err.textContent = 'Choose a picture'; return false; }
    if (!IT.setIcon(theme, e, data)) { err.textContent = `A theme holds up to ${IT.MAX_ICONS} icons`; return false; }
    close(true);
  } }] });
  if (ok) done();
}
