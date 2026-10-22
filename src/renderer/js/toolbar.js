// Your own toolbar: any command as a button next to the search box, in the order you like.
// Right-click the bar (or a ribbon button) to add, remove or rearrange; the built-in buttons can be hidden too.
import { state, bus, h, esc, saveSettings } from './core.js';
import { icon } from './icons.js';
import { commands, keysFor } from './commands.js';
import { modal } from './dialogs.js';
import { showMenu } from './menu.js';

const BUILTIN = [['btn-assistant', 'Assistant'], ['btn-search', 'Search'], ['btn-layout', 'Split view'], ['btn-newwin', 'New window']];
const $ = (id) => document.getElementById(id);

export function renderToolbar() {
  let host = $('quick-tools');
  if (!host) {
    host = h('div', { id: 'quick-tools' });
    document.querySelector('#menubar .menubar-spacer')?.after(host);
    document.getElementById('menubar').addEventListener('contextmenu', (e) => {
      if (!e.target.closest('#quick-tools, .top-ic, .menubar-spacer')) return;
      e.preventDefault();
      const id = e.target.closest('[data-cmd]')?.dataset.cmd;
      showMenu([
        id && { label: 'Remove from toolbar', icon: 'close', run: () => setTools(tools().filter((x) => x !== id)) },
        { label: 'Customize toolbar…', icon: 'settings', run: customizeToolbar },
      ], e.clientX, e.clientY);
    });
  }
  host.innerHTML = '';
  for (const id of tools()) {
    const c = commands.get(id);
    if (!c || (c.when && !c.when())) continue;
    const k = keysFor(id)[0];
    const b = h('button', { class: 'icon-btn top-ic' + (c.check?.() ? ' on' : ''), title: `${c.title}${k ? ` (${k})` : ''}`, 'data-cmd': id, html: icon(c.icon || 'command') });
    b.addEventListener('click', () => { c.run(); setTimeout(renderToolbar, 50); });
    host.append(b);
  }
  const hidden = new Set(state.settings.hiddenTopButtons || []);
  for (const [bid] of BUILTIN) { const el = $(bid); if (el) el.style.display = hidden.has(bid) ? 'none' : ''; }
}
const tools = () => (Array.isArray(state.settings.quickTools) ? state.settings.quickTools : []);
function setTools(list) { state.settings.quickTools = [...new Set(list)]; saveSettings(); renderToolbar(); }
export function addToToolbar(id) { if (!tools().includes(id)) setTools([...tools(), id]); }

export async function customizeToolbar() {
  let list = tools().slice();
  const hidden = new Set(state.settings.hiddenTopButtons || []);
  const cur = h('div', { class: 'qt-cur' });
  const search = h('input', { class: 'input', placeholder: 'Find a command to add…', type: 'search' });
  const avail = h('div', { class: 'qt-avail' });
  const all = [...commands.values()].filter((c) => c.title && c.run && !c.hidden).sort((a, b) => (a.cat || '').localeCompare(b.cat || '') || a.title.localeCompare(b.title));
  const drawCur = () => {
    cur.innerHTML = '';
    if (!list.length) cur.append(h('div', { class: 'hint' }, 'No buttons yet — add some from the list below.'));
    list.forEach((id, i) => {
      const c = commands.get(id); if (!c) return;
      cur.append(h('div', { class: 'qt-row' }, h('span', { class: 'qt-ic', html: icon(c.icon || 'command') }), h('span', { class: 'qt-name' }, c.title),
        h('button', { class: 'icon-btn small', title: 'Move left', disabled: i === 0 ? true : null, html: icon('back'), onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; drawCur(); } }),
        h('button', { class: 'icon-btn small', title: 'Move right', disabled: i === list.length - 1 ? true : null, html: icon('forward'), onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; drawCur(); } }),
        h('button', { class: 'icon-btn small', title: 'Remove', html: icon('close'), onclick: () => { list.splice(i, 1); drawCur(); drawAvail(); } })));
    });
  };
  const drawAvail = () => {
    avail.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    let n = 0;
    for (const c of all) {
      if (list.includes(c.id)) continue;
      if (q && !`${c.title} ${c.cat || ''}`.toLowerCase().includes(q)) continue;
      if (++n > 200) break;
      avail.append(h('button', { class: 'qt-row qt-add', title: 'Add to the toolbar', onclick: () => { list.push(c.id); drawCur(); drawAvail(); } }, h('span', { class: 'qt-ic', html: icon(c.icon || 'command') }), h('span', { class: 'qt-name' }, c.title), h('span', { class: 'hint' }, c.cat || ''), h('span', { class: 'qt-plus', html: icon('plus') })));
    }
  };
  search.addEventListener('input', drawAvail);
  const builtins = h('div', { class: 'qt-builtins' }, ...BUILTIN.map(([bid, label]) => { const cb = h('input', { type: 'checkbox' }); cb.checked = !hidden.has(bid); cb.onchange = () => (cb.checked ? hidden.delete(bid) : hidden.add(bid)); return h('label', { class: 'check' }, cb, ' ' + label); }));
  drawCur(); drawAvail();
  const ok = await modal({ title: 'Customize toolbar', width: 560, body: h('div', { class: 'qt' }, h('div', { class: 'field-label' }, 'Your buttons (next to the search box)'), cur, h('div', { class: 'field-label' }, 'Add a button'), search, avail, h('div', { class: 'field-label' }, 'Built-in buttons'), builtins),
    buttons: [{ label: 'Reset', value: 'reset' }, { label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }] });
  if (ok === 'reset') { state.settings.hiddenTopButtons = []; setTools([]); return; }
  if (!ok) return;
  state.settings.hiddenTopButtons = [...hidden];
  setTools(list);
}
bus.on('settings', () => renderToolbar());
