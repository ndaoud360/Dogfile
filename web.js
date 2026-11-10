// Dogfile Web: a plain web browser in a pane. Browser tabs, an address bar, the page. Nothing is kept: no history,
// cookies, passwords or saved logins (the pages live in private web views), no extensions, no sync.
// The pages themselves are native web views (src: app/src/web.rs) laid over the grey stage below the address bar:
// - a tab's web view is only made when the tab is shown, and tabs left alone go to sleep (the view is closed, the
//   address kept) so the browser costs nothing while you work with files;
// - while a menu or dialog is over the page, the page is hidden (a native view would cover it).
import { api, onMain, h, DEFAULT_SETTINGS, toast, errText } from './core.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { applyColors } from './theme.js';
import { FRAME_ID, pendingFiles, onHost, tellHost, onAsk } from './embed.js';
import { buttonsFor, webButtons, homePage, resolveInput } from './webcfg.js';

const $ = (id) => document.getElementById(id);
const PFX = FRAME_ID.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'w';
let SET = { ...DEFAULT_SETTINGS };
const S = { tabs: [], active: null, hidden: false, cover: false, own: false, seq: 0, noticeShown: false };

const tabById = (id) => S.tabs.find((t) => t.id === id);
const act = () => tabById(S.active);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const allowLocal = () => !!SET.webLocal;
const call = (op, id, extra = {}) => api('web:do', op, { id, allowLocal: allowLocal(), ...extra }).catch((e) => ({ ok: false, error: errText(e) }));
const sleepMs = () => Math.max(1, Number(SET.webSleepMinutes) || 5) * 60000;

// ---------- where the native view goes ----------
function stageRect() {
  const r = $('wb-stage').getBoundingClientRect();
  const fr = window.frameElement?.getBoundingClientRect();
  return { x: r.left + (fr?.left || 0), y: r.top + (fr?.top || 0), w: r.width, h: r.height };
}
let lastRect = '';
function syncBounds() {
  const t = act();
  if (!t?.awake || !t.shown) return;
  const r = stageRect();
  const key = [r.x, r.y, r.w, r.h].map(Math.round).join(',');
  if (key === lastRect) return;
  lastRect = key;
  call('bounds', t.id, r);
}

// ---------- which views are awake, shown, asleep ----------
async function wake(t) {
  if (t.awake || t.waking || !t.url) return;
  t.waking = true;
  const r = stageRect();
  const res = await call('open', t.id, { url: t.url, ...r, visible: false });
  t.waking = false;
  if (!res.ok) { setStatus(res.error || 'The page couldn’t be opened', true); if (/web view couldn/i.test(res.error || '')) offerSystemBrowser(t); return; }
  t.awake = true; t.shown = false; t.loading = true;
  refresh();
}
function sleep(t) {
  clearTimeout(t.timer); t.timer = 0;
  if (!t.awake) return;
  call('close', t.id);
  t.awake = false; t.shown = false; t.loading = false;
  renderTabs(); renderStage();
}
function refresh() {
  const covered = S.hidden || S.cover || S.own;
  for (const t of S.tabs) {
    if (!t.awake) continue;
    const want = t.id === S.active && !covered && !!t.url;
    if (want !== t.shown) {
      t.shown = want;
      call('show', t.id, { on: want });
      call('low', t.id, { on: !want });
      if (want) { clearTimeout(t.timer); t.timer = 0; lastRect = ''; syncBounds(); }
    }
    // a page that isn't on show for a while goes to sleep: nothing runs in the background
    if (t.id !== S.active || S.hidden) { if (!t.timer) t.timer = setTimeout(() => sleep(t), sleepMs()); }
    else if (t.timer) { clearTimeout(t.timer); t.timer = 0; }
  }
  const t = act();
  if (t && t.url && !t.awake && !S.hidden) wake(t);
  renderStage();
}

// ---------- tabs ----------
function addTab(url = '', { after = null, activate = true } = {}) {
  const t = { id: `${PFX}_${++S.seq}`, url: '', title: '', loading: false, awake: false, shown: false, timer: 0 };
  if (url) t.url = url;
  const i = after ? S.tabs.indexOf(after) + 1 : S.tabs.length;
  S.tabs.splice(i, 0, t);
  if (activate) select(t);
  else renderTabs();
  return t;
}
function select(t) {
  if (!t) return;
  S.active = t.id;
  renderTabs(); renderBar(); refresh();
  if (!t.url) setTimeout(() => $('wb-start')?.querySelector('input')?.focus(), 30);
}
function closeTab(t) {
  const i = S.tabs.indexOf(t);
  if (i < 0) return;
  clearTimeout(t.timer);
  if (t.awake) call('close', t.id);
  S.tabs.splice(i, 1);
  if (!S.tabs.length) { addTab(''); return; }
  if (S.active === t.id) select(S.tabs[Math.min(i, S.tabs.length - 1)]); else renderTabs();
}
function go(t, text) {
  const url = resolveInput(text, SET);
  if (!url) return;
  api('web:check', url, allowLocal()).then((r) => {
    if (!r?.ok) { setStatus(r?.error || 'That address can’t be opened here', true); return; }
    setStatus('');
    t.url = r.url; t.title = '';
    if (t.awake) call('nav', t.id, { url: r.url }); else { t.loading = true; wake(t); }
    renderTabs(); renderBar(); renderStage();
  });
}

// ---------- drawing ----------
const letter = (t) => (hostOf(t.url) || '·')[0].toUpperCase();
const label = (t) => t.title || hostOf(t.url) || 'New tab';
function renderTabs() {
  const el = $('wb-tabs');
  el.innerHTML = '';
  for (const t of S.tabs) {
    const x = h('button', { class: 'wb-x', title: 'Close tab', html: icon('close'), onclick: (e) => { e.stopPropagation(); closeTab(t); } });
    const tab = h('div', { class: 'wb-tab' + (t.id === S.active ? ' on' : '') + (t.loading ? ' loading' : '') + (t.url && !t.awake ? ' asleep' : ''), title: t.url || 'New tab', onclick: () => select(t) }, h('span', { class: 'wb-dot' }, t.url ? letter(t) : ''), h('span', { class: 'wb-t' }, label(t)), x);
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.append(tab);
  }
  el.append(h('button', { id: 'wb-plus', title: 'New tab', html: icon('plus'), onclick: () => addTab('') }));
  const n = act();
  tellHost({ type: 'title', title: n && n.url ? `${label(n)} - Dogfile Web` : 'Dogfile Web' });
}
function renderBar() {
  const t = act();
  const bar = $('wb-bar');
  const keep = document.activeElement?.id === 'wb-url';
  if (keep) { if (t) t.draft = $('wb-url').value; return; }
  bar.innerHTML = '';
  const B = (ic, title, run, extra = {}) => h('button', { class: 'icon-btn', title, html: icon(ic), onclick: run, ...extra });
  const url = h('input', { id: 'wb-url', type: 'text', spellcheck: 'false', placeholder: 'Search or type a web address', value: t?.url || '', autocomplete: 'off' });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { go(act(), url.value); url.blur(); } else if (e.key === 'Escape') { url.value = act()?.url || ''; url.blur(); } });
  url.addEventListener('focus', () => url.select());
  url.addEventListener('blur', () => { const c = act(); if (c) url.value = c.url || ''; });
  bar.append(
    B('back', 'Back', () => t?.awake && call('back', t.id)),
    B('forward', 'Forward', () => t?.awake && call('forward', t.id)),
    t?.loading ? B('close', 'Stop', () => call('stop', t.id)) : B('refresh', 'Reload', () => (t?.awake ? call('reload', t.id) : t?.url && wake(t))),
    B('home', 'Start page', () => go(act(), homePage(SET))),
    h('div', { id: 'wb-urlbox' }, h('span', { html: icon(t?.url?.startsWith('https:') ? 'globeLock' : 'globe') }), url),
    B('link', 'Open in your browser', () => { const c = act(); if (c?.url) api('shell:openExternal', c.url); }),
    B('star', 'Sites', (e) => sitesMenu(e.currentTarget)),
  );
}
function sitesMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const items = webButtons(SET).map((b) => ({ label: b.name, icon: 'globe', run: () => go(act(), b.url) }));
  items.push({ separator: true }, { label: 'Edit URL buttons…', icon: 'settings', run: () => tellHost({ type: 'key', cmd: 'webButtons' }) });
  showMenu(items, r.right, r.bottom + 4, { alignRight: true });
}
function renderStage() {
  const t = act();
  const st = $('wb-start'), asleep = $('wb-asleep');
  const start = !!t && !t.url;
  st.classList.toggle('on', start);
  if (start && !st.dataset.built) st.dataset.built = '1';
  if (start) buildStart(st);
  asleep.classList.toggle('on', !!t && !!t.url && !t.awake);
  asleep.textContent = t && t.url && !t.awake ? 'Waking this page…' : '';
  const n = $('wb-notice');
  n.classList.toggle('on', !S.noticeShown);
  if (!S.noticeShown && !n.firstChild) {
    n.append(h('span', { html: icon('globeLock') }), h('span', { class: 'grow' }, 'Private: Dogfile Web keeps no history, cookies, passwords or logins. Closing this tab forgets everything. Downloads you save stay in your Downloads folder.'), h('button', { class: 'btn', onclick: () => { S.noticeShown = true; n.classList.remove('on'); n.innerHTML = ''; syncBounds(); } }, 'Got it'));
  }
  setTimeout(() => syncBounds(), 0);
}
function buildStart(st) {
  if (st._sig === JSON.stringify(webButtons(SET))) return;
  st._sig = JSON.stringify(webButtons(SET));
  st.innerHTML = '';
  const q = h('input', { class: 'wb-search', type: 'text', placeholder: 'Search or type a web address', spellcheck: 'false' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(act(), q.value); });
  const tiles = h('div', { class: 'wb-tiles' }, ...webButtons(SET).map((b) => h('div', { class: 'wb-tile', title: b.url, onclick: () => go(act(), b.url) }, h('div', { class: 'wb-dot' }, (b.name || '?')[0].toUpperCase()), h('div', { class: 'nm' }, b.name))));
  st.append(h('h1', {}, 'Dogfile Web'), h('p', {}, 'A plain browser beside your files. Drag files from the other pane onto a page that takes them. Nothing is saved.'), q, tiles, h('p', { style: { marginTop: '22px' } }, h('span', { class: 'wb-link', onclick: () => tellHost({ type: 'key', cmd: 'webButtons' }) }, 'Edit these buttons')));
}
let statusTimer = 0;
function setStatus(msg, bad = false, ...actions) {
  const el = $('wb-status');
  clearTimeout(statusTimer);
  el.innerHTML = '';
  el.classList.toggle('on', !!msg);
  el.classList.toggle('bad', !!bad);
  if (!msg) { setTimeout(() => syncBounds(), 0); return; }
  el.append(h('span', { class: 'grow' }, msg), ...actions, h('span', { class: 'wb-link', onclick: () => setStatus('') }, 'Dismiss'));
  if (!actions.length) statusTimer = setTimeout(() => setStatus(''), 9000);
  setTimeout(() => syncBounds(), 0);
}
function offerSystemBrowser(t) {
  setStatus('Dogfile Web couldn’t start here.', true, h('span', { class: 'wb-link', onclick: () => { if (t.url) api('shell:openExternal', t.url); } }, 'Open in your browser'));
}

// ---------- news from the web views ----------
onMain('web:event', (ev) => {
  const t = tabById(ev.id);
  if (!t) return;
  if (ev.type === 'load') {
    t.loading = ev.state === 'start';
    if (ev.url && !/^about:/.test(ev.url)) t.url = ev.url;
    if (ev.state === 'start') t.title = t.title && hostOf(t.url) === hostOf(ev.url) ? t.title : '';
    renderTabs(); if (t.id === S.active) renderBar();
  } else if (ev.type === 'title') {
    t.title = ev.title || '';
    if (ev.url) t.url = ev.url;
    renderTabs(); if (t.id === S.active) renderBar();
  } else if (ev.type === 'newtab') {
    addTab(ev.url, { after: t });
  } else if (ev.type === 'blocked') {
    setStatus('Blocked: ' + String(ev.url).slice(0, 90) + ' (only web addresses are opened here)', true);
  } else if (ev.type === 'download') {
    if (ev.state === 'start') { toast(`Downloading ${ev.name}…`); if (ev.risky) setStatus(`“${ev.name}” is a program or script. Only run it if you trust the site it came from.`, true); }
    else if (ev.state === 'done') setStatus('Downloaded', false, ...(ev.path ? [h('span', { class: 'wb-link', onclick: () => api('shell:showInExplorer', ev.path, true) }, 'Show in folder')] : []));
    else setStatus('The download didn’t finish', true);
  }
});

// ---------- the host tab ----------
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.atlasHost !== true) return;
  if (m.type === 'cover') { S.cover = !!m.on; refresh(); }
  else if (m.type === 'layout') { const was = S.hidden; S.hidden = m.visible === false; if (was !== S.hidden) refresh(); else syncBounds(); }
  else if (m.type === 'open' && m.url) { openUrl(m.url); }
});
function openUrl(url) {
  const t = act();
  if (t && !t.url) go(t, url); else go(addTab('', { after: t }), url);
}
onHost({
  settings: (s) => { SET = { ...DEFAULT_SETTINGS, ...s }; applyColors(SET); const st = $('wb-start'); if (st) st._sig = ''; renderStage(); },
  cmd: (id, arg) => {
    const t = act();
    if (id === 'newTab') addTab('');
    else if (id === 'closeTab' && t) closeTab(t);
    else if (id === 'back' && t) call('back', t.id);
    else if (id === 'forward' && t) call('forward', t.id);
    else if (id === 'reload' && t) (t.awake ? call('reload', t.id) : wake(t));
    else if (id === 'home') go(t, homePage(SET));
    else if (id === 'address') $('wb-url')?.focus();
    else if (id === 'open' && arg) openUrl(arg);
    else if (id === 'sites') sitesMenu($('wb-urlbox'));
    else if (id === 'sleepAll') for (const x of S.tabs) if (x.id !== S.active) sleep(x);
  },
});
onAsk(async (op, arg) => {
  const t = act();
  if (op === 'open' && arg?.url) { openUrl(arg.url); return { ok: true, msg: 'Opened' }; }
  if (op === 'where') return { ok: true, msg: t?.url || 'Start page' };
  return { ok: false, msg: 'Not available here' };
});

// our own menus and dialogs sit over the page: hide it while they are open
new MutationObserver(() => { const own = !!document.querySelector('.menu, .modal-back'); if (own !== S.own) { S.own = own; refresh(); } }).observe(document.body, { childList: true });
new ResizeObserver(() => { syncBounds(); }).observe($('wb-stage'));
window.addEventListener('resize', () => syncBounds());
window.addEventListener('pagehide', () => { api('web:do', 'closeAll', { prefix: PFX + '_' }).catch(() => {}); });

async function boot() {
  const st = await api('store:get', 'settings');
  SET = { ...DEFAULT_SETTINGS, ...(st || {}) };
  applyColors(SET);
  const pending = await pendingFiles();
  addTab('', { activate: false });
  select(S.tabs[0]);
  if (pending?.url) go(S.tabs[0], pending.url);
  document.body.classList.add('ready');
}
boot().catch((e) => console.error(e));
