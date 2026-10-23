// Dogfile Pro: the 14-day trial, buying, serial numbers (online and offline), the Free vs Pro list, the stars on
// Pro features and the popup when one is used without Pro. The checks that matter happen in the program
// (backend/src/license.rs); this is the interface to them.
import { api, onMain, state, bus, h, esc, saveSettings, toast } from './core.js';
import { icon } from './icons.js';
import { modal } from './dialogs.js';

export const L = { status: null };
const PRICE = () => L.status?.price || '$19.99';

import { FEATURES, PLURAL, PRO_COMMANDS, proForLabel, starHtml } from './pro-marks.js';
export { FEATURES, PRO_COMMANDS, proForLabel, starHtml };

// backend calls refused without Pro, for the popup's wording
const CALL_FEATURE = { versions: 'versions', remote: 'remote', ext: 'features', ai: 'assistant', media: 'convert', work: 'dupes' };

export const isPro = () => !L.status || L.status.pro !== false;
/** a star shows next to Pro features until Pro is bought */
export const showStars = () => !!L.status && !['licensed', 'unconfigured'].includes(L.status.mode);

/** true when the feature can be used now; otherwise explains and offers Pro (and returns false) */
export function requirePro(feature) {
  if (isPro()) return true;
  proRequired(feature);
  return false;
}

// ---------- state ----------
function apply() {
  const b = document.body;
  b.classList.toggle('show-pro-stars', showStars());
  b.classList.toggle('pro-locked', !isPro());
  renderPill();
  bus.emit('license', L.status);
}
let started = false;
export async function initLicense({ test = false } = {}) {
  L.status = await api('license:status').catch(() => null);
  apply();
  if (started) return;
  started = true;
  onMain('license', (s) => {
    const was = L.status?.mode;
    L.status = s;
    apply();
    if (was === 'trial' && s.mode === 'expired' && !test) trialEnded();
  });
  bus.on('proRequired', (call) => proRequired(CALL_FEATURE[String(call).split(':')[0]] || null));
  if (!test && state.settings.welcomed) setTimeout(maybeOffer, 1500);
}
/** at start, or at the end of the welcome tour: offer the trial (a few times at most), or say it has ended */
export function maybeOffer() {
  const s = L.status, S = state.settings;
  if (!s || document.querySelector('.lic-modal')) return;
  if (s.mode === 'none') {
    const n = S.trialOfferCount || 0, last = S.trialOfferAt || 0;
    if (n === 0 || (n < 3 && Date.now() - last > 3 * 86400e3)) { S.trialOfferCount = n + 1; S.trialOfferAt = Date.now(); saveSettings(); offerTrial(); }
  } else if (s.mode === 'expired' && !S.trialEndedShown) trialEnded();
}

// ---------- the pill by the top-right buttons ----------
function renderPill() {
  let pill = document.getElementById('pro-pill');
  const s = L.status;
  const show = s && ['trial', 'expired', 'none'].includes(s.mode);
  if (!show) { pill?.remove(); return; }
  if (!pill) {
    const anchor = document.getElementById('btn-assistant') || document.getElementById('btn-search');
    if (!anchor) return;
    pill = h('button', { class: 'pro-pill', id: 'pro-pill' });
    pill.addEventListener('click', () => (L.status?.mode === 'none' ? offerTrial() : L.status?.mode === 'trial' ? compareDialog() : trialEnded(true)));
    anchor.before(pill);
  }
  const days = s.daysLeft;
  pill.classList.toggle('ending', s.mode === 'trial' && days <= 3);
  pill.innerHTML = s.mode === 'trial' ? `${icon('star')}<span>Pro trial · ${days} day${days === 1 ? '' : 's'} left</span>` : `${icon('star')}<span>Get Pro</span>`;
  pill.title = s.mode === 'trial' ? 'Your Dogfile Pro trial: click to see what’s in Pro or buy it' : 'Dogfile Pro: see what’s included';
}

// ---------- pieces ----------
const isOpen = () => !!document.querySelector('.lic-modal');
const errBox = () => h('div', { class: 'lic-err', role: 'alert' });
const showErr = (el, e) => { el.textContent = String(e?.message || e || '').replace(/^Error:\s*/, '').replace(/^PRO_REQUIRED:\s*/, ''); el.style.display = el.textContent ? '' : 'none'; };
const busy = async (btn, label, fn) => {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
};
const link = (label, fn) => h('button', { class: 'lic-link', onclick: fn }, label);
const hero = (title, text) => h('div', { class: 'lic-hero' }, h('div', { class: 'lic-badge', html: icon('star') }), h('h2', {}, title), text ? h('p', {}, text) : null);
const HIGHLIGHTS = [
  ['sparkle', 'AI assistant', 'Find, sort and rename files by asking in plain words'],
  ['layout4', 'Up to four panes', 'Plus folder compare and sync'],
  ['rename', 'Batch rename studio', 'And duplicate and similar-photo finders'],
  ['cloud', 'Cloud, SFTP and FTP', 'Automations, macros, file versions and more'],
];
const highlights = () => h('div', { class: 'lic-hl' }, ...HIGHLIGHTS.map(([ic, t, d]) => h('div', { class: 'lic-hl-row' }, h('span', { class: 'lic-hl-ic', html: icon(ic) }), h('div', {}, h('b', {}, t), h('div', { class: 'hint' }, d)))));

// ---------- the trial offer (end of the welcome tour) ----------
export function offerTrial() {
  if (isOpen()) return;
  const err = errBox(); showErr(err, '');
  return modal({
    title: '', width: 540, className: 'lic-modal', closeOnBackdrop: false,
    body: h('div', { class: 'lic' },
      hero('Try Dogfile Pro free for 14 days', 'Every feature, unlocked. No card needed. When the 14 days are up, buy Pro once or keep using the free version.'),
      highlights(),
      h('div', { class: 'lic-links' }, link('See Free vs Pro', () => compareDialog()), link('I have a serial number', () => enterSerial())),
      err),
    buttons: [
      { label: 'Not now', left: true, value: null },
      { label: `Buy now · ${PRICE()}`, run: (close) => { close(null); buy(); } },
      { label: 'Start free trial', primary: true, run: async (close) => {
        const btn = document.querySelector('.lic-modal .modal-foot .primary');
        try { await busy(btn, 'Starting…', () => api('license:startTrial')); close(true); toast('Your 14-day Dogfile Pro trial has started'); } catch (e) { showErr(err, e); }
        return false;
      } },
    ],
  });
}

// ---------- the trial is over ----------
export function trialEnded(fromPill = false) {
  if (isOpen()) return;
  state.settings.trialEndedShown = true; saveSettings();
  return modal({
    title: '', width: 520, className: 'lic-modal', closeOnBackdrop: fromPill,
    body: h('div', { class: 'lic' },
      hero(fromPill ? 'Get Dogfile Pro' : 'Your Pro trial has ended', fromPill ? 'Buy Pro once and keep every feature.' : 'Thanks for trying Dogfile Pro! Buy it once to keep every Pro feature, or keep using the free version. Nothing of yours changes.'),
      h('div', { class: 'lic-price' }, h('b', {}, PRICE()), h('span', { class: 'hint' }, 'one-time payment · use it on 2 PCs · secure checkout by Stripe')),
      h('div', { class: 'lic-links' }, link('See what’s different in Free', () => compareDialog()), link('Enter serial number', () => enterSerial()))),
    buttons: [
      { label: 'Continue with Free', left: true, value: null },
      { label: `Buy now · ${PRICE()}`, primary: true, run: (close) => { close(null); buy(); } },
    ],
  });
}

// ---------- using a Pro feature without Pro ----------
let lastAsk = 0;
export function proRequired(feature) {
  if (isOpen() || Date.now() - lastAsk < 800) return;
  lastAsk = Date.now();
  const name = FEATURES[feature] || 'This feature';
  const none = L.status?.mode === 'none';
  const err = errBox(); showErr(err, '');
  return modal({
    title: '', width: 480, className: 'lic-modal',
    body: h('div', { class: 'lic' },
      hero(`${name} ${PLURAL.has(feature) ? 'are' : 'is'} part of Dogfile Pro`, none ? 'Start your free 14-day trial to use it now. No card needed.' : `Buy Dogfile Pro once (${PRICE()}, 2 PCs) to unlock it and every other Pro feature.`),
      h('div', { class: 'lic-links' }, link('See Free vs Pro', () => compareDialog()), link('Enter serial number', () => enterSerial())),
      err),
    buttons: none
      ? [{ label: 'Not now', left: true, value: null }, { label: `Buy now · ${PRICE()}`, run: (close) => { close(null); buy(); } }, { label: 'Start free trial', primary: true, run: async (close) => {
        const btn = document.querySelector('.lic-modal .modal-foot .primary');
        try { await busy(btn, 'Starting…', () => api('license:startTrial')); close(true); toast('Your 14-day Dogfile Pro trial has started. Try it again now.'); } catch (e) { showErr(err, e); }
        return false;
      } }]
      : [{ label: 'Not now', left: true, value: null }, { label: `Buy now · ${PRICE()}`, primary: true, run: (close) => { close(null); buy(); } }],
  });
}

// ---------- Free vs Pro ----------
const COMPARE = [
  ['Tabs, split panes, previews and instant search', 1],
  ['Copy, move, rename, zip and unzip', 1],
  ['Notepad, Photos, Player and the 3D viewer', 1],
  ['Phone transfer over Wi-Fi, compare two files', 1],
  ['Tags, colours, notes, themes and demo mode', 1],
  ['AI assistant: ask in plain words', 0],
  ['Three and four panes, folder compare and sync', 0],
  ['Batch rename studio', 0],
  ['Duplicate and similar-photo finders', 0],
  ['Disk space map and cleanup', 0],
  ['Automations, macros, file events and versions', 0],
  ['Cloud (S3, B2, Google Cloud…), SFTP and FTP', 0],
  ['Document reminders and photo details', 0],
  ['Convert media, read text in images, custom features, 3D textures', 0],
];
export function compareDialog() {
  const mode = L.status?.mode;
  const yes = `<span class="lic-yes">${icon('check')}</span>`, no = '<span class="lic-no">–</span>';
  const table = h('table', { class: 'lic-table' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Free'), h('th', { class: 'pro' }, h('span', { html: icon('star') }), 'Pro'))),
    h('tbody', {}, ...COMPARE.map(([t, free]) => h('tr', { class: free ? '' : 'is-pro' }, h('td', {}, t), h('td', { html: free ? yes : no }), h('td', { class: 'pro', html: yes })))));
  const buttons = [{ label: 'Close', left: true, value: null }];
  if (mode === 'none') buttons.push({ label: 'Start free trial', run: async (close) => { try { await api('license:startTrial'); close(true); toast('Your 14-day Dogfile Pro trial has started'); } catch (e) { toast(String(e?.message || e)); } return false; } });
  if (mode !== 'licensed' && mode !== 'unconfigured') buttons.push({ label: `Buy now · ${PRICE()}`, primary: true, run: (close) => { close(null); document.querySelectorAll('.lic-modal').forEach((m) => m.closest('.modal-back')?.remove()); buy(); } });
  return modal({
    title: 'Dogfile Free and Pro', width: 520, className: 'lic-compare',
    body: h('div', { class: 'lic' }, table, h('p', { class: 'hint lic-foot' }, mode === 'licensed' ? 'You have Dogfile Pro: everything is unlocked.' : `Pro is a one-time payment of ${PRICE()} and works on 2 PCs.${mode === 'trial' ? ` Your trial has ${L.status.daysLeft} day${L.status.daysLeft === 1 ? '' : 's'} left.` : ''}`)),
    buttons,
  });
}

// ---------- buying ----------
export async function buy() {
  const err = errBox(); showErr(err, '');
  const msg = h('p', {}, 'Opening the secure payment page in your browser…');
  let stop = false, session = null;
  const done = modal({
    title: '', width: 470, className: 'lic-modal', closeOnBackdrop: false,
    body: h('div', { class: 'lic' }, hero('Finish buying in your browser', null), msg,
      h('div', { class: 'lic-wait' }, h('span', { class: 'spinner' }), h('span', {}, 'Dogfile activates by itself as soon as the payment goes through.')),
      h('p', { class: 'hint' }, 'Payments are processed securely by Stripe. Dogfile never sees your card details.'),
      h('div', { class: 'lic-links' }, link('Open the payment page again', () => session && api('shell:openExternal', session.url))), err),
    buttons: [
      { label: 'I have my serial number', left: true, run: (close) => { stop = true; close(null); enterSerial(); } },
      { label: 'Cancel', value: null },
    ],
    onClose: () => { stop = true; },
  });
  try {
    session = await api('license:checkout');
    await api('shell:openExternal', session.url);
    msg.textContent = 'Pay on the Stripe page that opened in your browser. Your serial number is also emailed to you.';
  } catch (e) { showErr(err, e); msg.textContent = 'The payment page couldn’t be opened.'; return done; }
  const until = Date.now() + 45 * 60e3;
  while (!stop && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    if (stop) break;
    try {
      const r = await api('license:claim', session.session);
      if (r?.serial) { stop = true; document.querySelectorAll('.lic-modal').forEach((m) => m.closest('.modal-back')?.remove()); welcomePro(r.serial); break; }
      if (r?.error) { showErr(err, r.error); break; }
    } catch (e) { showErr(err, e); }
  }
  return done;
}
function welcomePro(serial) {
  return modal({
    title: '', width: 470, className: 'lic-modal',
    body: h('div', { class: 'lic' }, hero('Welcome to Dogfile Pro!', 'Everything is unlocked on this PC. Thank you for supporting Dogfile.'),
      serial ? h('div', { class: 'lic-serial' }, h('span', { class: 'hint' }, 'Your serial number'), h('code', {}, serial), h('button', { class: 'btn small', onclick: () => { api('clip:writeText', serial); toast('Serial number copied'); } }, 'Copy')) : null,
      h('p', { class: 'hint' }, 'It’s also in your email. It works on 2 PCs: on the other one, choose Settings › Licence › Enter serial number.')),
    buttons: [{ label: 'Great', primary: true, value: true }],
  });
}

// ---------- serial numbers ----------
export function enterSerial(prefill = '') {
  document.querySelectorAll('.lic-modal').forEach((m) => m.closest('.modal-back')?.remove());
  const input = h('input', { class: 'input lic-input', placeholder: 'DOGF-XXXXX-XXXXX-XXXXX-XXXXX', spellcheck: 'false', autocomplete: 'off', value: prefill, autofocus: true });
  const err = errBox(); showErr(err, '');
  return modal({
    title: '', width: 480, className: 'lic-modal',
    body: h('div', { class: 'lic' }, hero('Enter your serial number', 'You’ll find it in the email you got after buying Dogfile Pro.'), input, err,
      h('div', { class: 'lic-links' }, link('This PC isn’t online? Activate offline', () => { const v = input.value; document.querySelectorAll('.lic-modal').forEach((m) => m.closest('.modal-back')?.remove()); offlineDialog(v); }))),
    buttons: [
      { label: 'Cancel', left: true, value: null },
      { label: 'Activate', primary: true, run: async (close) => {
        const btn = document.querySelector('.lic-modal .modal-foot .primary');
        if (!input.value.trim()) { input.focus(); return false; }
        try { await busy(btn, 'Activating…', () => api('license:activate', input.value.trim())); close(true); welcomePro(input.value.trim().toUpperCase()); } catch (e) { showErr(err, e); }
        return false;
      } },
    ],
  });
}

export async function offlineDialog(serial = '') {
  const serialIn = h('input', { class: 'input lic-input', placeholder: 'DOGF-XXXXX-XXXXX-XXXXX-XXXXX', spellcheck: 'false', value: serial });
  const urlBox = h('code', { class: 'lic-url' }, 'Enter your serial number above first');
  const code = h('textarea', { class: 'input lic-code', rows: 4, spellcheck: 'false', placeholder: 'Paste or type the activation code here (XXXXX-XXXXX-…)' });
  const err = errBox(); showErr(err, '');
  let url = '';
  const update = async () => {
    try { const r = await api('license:offlineRequest', serialIn.value.trim()); url = r.url; urlBox.textContent = url; showErr(err, ''); } catch (e) { url = ''; urlBox.textContent = 'Enter your serial number above first'; if (serialIn.value.trim().length > 10) showErr(err, e); }
  };
  serialIn.addEventListener('input', () => update());
  if (serial) update();
  const step = (n, ...kids) => h('div', { class: 'lic-step' }, h('span', { class: 'lic-num' }, String(n)), h('div', {}, ...kids));
  return modal({
    title: 'Activate offline', width: 560, className: 'lic-modal lic-offline',
    body: h('div', { class: 'lic' },
      step(1, h('b', {}, 'Your serial number'), serialIn),
      step(2, h('b', {}, 'On a phone or another computer with internet, open this link'), urlBox,
        h('div', { class: 'lic-row' },
          h('button', { class: 'btn small', onclick: () => { if (url) { api('clip:writeText', url); toast('Link copied'); } } }, 'Copy link'),
          h('button', { class: 'btn small', onclick: async () => { if (!url) return; const f = await api('dialog:saveFile', { title: 'Save the activation link', defaultPath: 'Dogfile activation link.txt' }); if (f) { await api('fs:writeText', f, `Open this link on a device with internet to get your Dogfile Pro activation code:\r\n\r\n${url}\r\n`); toast('Saved'); } } }, 'Save link as a file…')),
        h('div', { class: 'hint' }, `It shows an activation code made for this PC only (PC ID ${esc(L.status?.machine || '')}).`)),
      step(3, h('b', {}, 'Enter the activation code'), code,
        h('div', { class: 'lic-row' }, h('button', { class: 'btn small', onclick: async () => { const f = await api('dialog:openFiles', { title: 'Open the activation code file', filters: [{ name: 'Text', extensions: ['txt'] }] }); const p = Array.isArray(f) ? f[0] : f; if (p) code.value = await api('fs:readText', p); } }, 'Open activation file…'))),
      err),
    buttons: [
      { label: 'Cancel', left: true, value: null },
      { label: 'Activate', primary: true, run: async (close) => {
        if (!code.value.trim()) { code.focus(); return false; }
        try { await api('license:offlineApply', code.value); close(true); welcomePro(null); } catch (e) { showErr(err, e); }
        return false;
      } },
    ],
  });
}

// ---------- Settings › Licence ----------
export async function licenseSettings(el, row) {
  const s = L.status = await api('license:status').catch(() => L.status);
  if (!s) { el.append(h('p', { class: 'hint' }, 'The licence information couldn’t be read.')); return; }
  const btn = (label, fn, cls = '') => h('button', { class: 'btn small ' + cls, onclick: fn }, label);
  const redraw = () => { el.innerHTML = ''; licenseSettings(el, row); };
  const off = bus.on('license', () => { off(); if (el.isConnected) redraw(); });
  const titles = {
    licensed: ['Dogfile Pro', 'Activated on this PC. Thank you!'],
    trial: ['Pro trial', `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left. Everything is unlocked until then.`],
    expired: ['Free version', 'Your Pro trial has ended. Buy Pro to unlock every feature again.'],
    none: ['Free version', 'Try every Pro feature free for 14 days, no card needed.'],
    unconfigured: ['Development build', 'Licensing isn’t set up in this copy, so everything is unlocked.'],
  }[s.mode] || ['', ''];
  el.append(h('div', { class: 'lic-card ' + s.mode }, h('span', { class: 'lic-badge', html: icon('star') }), h('div', {}, h('b', {}, titles[0]), h('div', { class: 'hint' }, titles[1]))));
  const acts = h('div', { class: 'stack' });
  if (s.mode === 'none') acts.append(btn('Start free trial', async (e) => { try { await busy(e.target, 'Starting…', () => api('license:startTrial')); toast('Your 14-day Dogfile Pro trial has started'); } catch (x) { toast(String(x?.message || x)); } }, 'primary'));
  if (s.mode !== 'licensed' && s.mode !== 'unconfigured') acts.append(btn(`Buy now · ${PRICE()}`, () => buy(), s.mode === 'none' ? '' : 'primary'), btn('Enter serial number…', () => enterSerial()), btn('Activate offline…', () => offlineDialog()));
  acts.append(btn('Free vs Pro', () => compareDialog()));
  el.append(row('Licence', acts));
  if (s.mode === 'licensed') {
    el.append(
      row('Serial number', h('code', {}, s.serial || '')),
      s.email ? row('Bought by', h('span', {}, s.email)) : '',
      row('Move to another PC', btn('Deactivate this PC…', async (e) => {
        const { confirm } = await import('./dialogs.js');
        if (!(await confirm('Deactivate this PC?', 'Dogfile Pro will be turned off on this PC, freeing its place so you can activate your serial number on another PC (2 at a time).', { danger: true, ok: 'Deactivate' }))) return;
        try { await busy(e.target, 'Deactivating…', () => api('license:deactivate')); toast('This PC was deactivated'); } catch (x) { toast(String(x?.message || x)); }
      }, 'danger'), 'Your serial number works on 2 PCs at a time. Deactivate one before activating a third.'),
      row('Check the licence', btn('Check now', async (e) => { await busy(e.target, 'Checking…', () => api('license:refresh')); toast('Licence checked'); }), s.lastCheck ? `Last checked ${new Date(s.lastCheck * 1000).toLocaleDateString()}.` : ''),
    );
  }
  el.append(row('This PC’s ID', h('div', { class: 'stack' }, h('code', {}, s.machine), btn('Copy', () => { api('clip:writeText', s.machine); toast('Copied'); })), 'Used to tie your licence to this PC. It’s a code made from the hardware, nothing personal.'));
}

// ---------- the stars ----------
/** the star HTML for a command (shown only until Pro is bought, by CSS) */
export const starFor = (id) => (PRO_COMMANDS[id] ? starHtml : '');
