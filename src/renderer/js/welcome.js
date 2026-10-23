// First-run welcome: pick Simple or Full, learn the five things worth knowing, optionally make Dogfile the default.
// Reopen any time from File > Welcome tour.
import { api, state, bus, h, saveSettings, IS_WIN, toast } from './core.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';

export async function showWelcome() {
  const S = state.settings;
  let step = 0;
  let mode = S.welcomed ? S.uiMode : 'simple';
  const body = h('div', { class: 'wl' });
  const dots = h('div', { class: 'wl-dots' });
  const card = (ic, title, text) => h('div', { class: 'wl-card' }, h('span', { class: 'wl-ic', html: icon(ic) }), h('div', {}, h('b', {}, title), h('div', { class: 'hint' }, text)));
  const steps = [
    () => h('div', { class: 'wl-step' },
      h('div', { class: 'wl-hero' }, h('div', { class: 'wl-logo' }), h('h2', {}, 'Welcome to Dogfile'), h('p', { class: 'hint' }, 'A fast file manager with everything built in. Choose how much you want to see; you can change this any time in Settings.')),
      h('div', { class: 'wl-modes' },
        ...[['simple', 'Simple', 'Clean menus with the everyday things: open, copy, move, rename, zip, search. Extra tools wait under “More”.', 'home'], ['full', 'Full', 'Every tool in the ribbon and menus: split panes, terminal, hashes, batch tools and more.', 'command']].map(([k, l, d, ic]) => {
          const b = h('button', { class: 'wl-mode' + (mode === k ? ' on' : '') }, h('span', { class: 'wl-ic', html: icon(ic) }), h('b', {}, l), h('span', { class: 'hint' }, d));
          b.onclick = () => { mode = k; body.querySelectorAll('.wl-mode').forEach((x) => x.classList.toggle('on', x === b)); };
          return b;
        }))),
    () => h('div', { class: 'wl-step' }, h('h3', {}, 'Five things worth knowing'),
      card('plus', 'Tabs and split view', 'Ctrl+T opens a tab. Drag a tab to the side of the window to see two folders at once (up to four).'),
      card('eye', 'Quick Look', 'Select a file and press Space to preview it: photos, videos, music, PDFs, text and more.'),
      card('search', 'Search, or just ask', 'Ctrl+E searches, even by what’s in a photo. Or press ✨ (Ctrl+J) and just ask, like “PDFs about taxes from last year”.'),
      card('more', 'Right-click for everything', 'Zip, convert, edit tags, compare, open with the built-in Notepad, Player or Photos.'),
      card('command', 'Can’t find something?', 'Press Ctrl+Shift+P and type what you want to do. Every action is in there.')),
    () => h('div', { class: 'wl-step' }, h('h3', {}, 'Make it yours'),
      h('div', { class: 'wl-row' }, h('span', {}, 'Theme'), (() => { const w = h('div', { class: 'seg' }); for (const [v, l] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) { const b = h('button', { class: 'seg-btn' + (S.theme === v ? ' on' : '') }, l); b.onclick = () => { S.theme = v; saveSettings(); bus.emit('theme'); w.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); }; w.append(b); } return w; })()),
      h('div', { class: 'wl-row' }, h('span', {}, 'Open built-in apps as tabs'), (() => { const c = h('input', { type: 'checkbox', class: 'switch' }); c.checked = !!S.toolsInTabs; c.onchange = () => { S.toolsInTabs = c.checked; saveSettings(); }; return c; })()),
      IS_WIN() ? h('div', { class: 'wl-row' }, h('span', {}, 'Use Dogfile instead of File Explorer'), h('button', { class: 'btn small', onclick: async () => { const r = await api('default:set', true); toast(r ? 'Dogfile is now the default file manager' : 'Couldn’t change the default'); } }, 'Make default')) : null,
      h('p', { class: 'hint' }, 'Everything else lives in File > Settings, and the settings have a search box.')),
  ];
  const render = () => {
    body.innerHTML = '';
    body.append(steps[step](), dots);
    dots.innerHTML = '';
    steps.forEach((_, i) => dots.append(h('span', { class: i === step ? 'on' : '' })));
    back.style.visibility = step ? 'visible' : 'hidden';
    next.textContent = step === steps.length - 1 ? 'Start using Dogfile' : 'Next';
  };
  const finish = () => {
    const first = !S.welcomed;
    S.uiMode = mode; S.welcomed = true; saveSettings(); bus.emit('settings'); document.body.classList.toggle('ui-simple', mode === 'simple');
    // the end of the first welcome: offer the Pro trial
    if (first) setTimeout(() => import('./license.js').then((m) => m.maybeOffer()), 350);
  };
  let back, next;
  const p = modal({
    title: '', body, width: 620, className: 'wl-modal', closeOnBackdrop: false,
    buttons: [
      { label: 'Skip', left: true, run: (close) => { finish(); close(true); } },
      { label: 'Back', run: () => { step = Math.max(0, step - 1); render(); return false; } },
      { label: 'Next', primary: true, run: (close) => { if (step === 0) { S.uiMode = mode; bus.emit('settings'); } if (step < steps.length - 1) { step++; render(); return false; } finish(); close(true); } },
    ],
    onClose: () => { if (!S.welcomed) finish(); },
  });
  setTimeout(() => { const btns = body.closest('.modal')?.querySelectorAll('.modal-foot .btn'); if (btns) { back = btns[1]; next = btns[2]; render(); } }, 0);
  back = { style: {} }; next = {};
  render();
  return p;
}
