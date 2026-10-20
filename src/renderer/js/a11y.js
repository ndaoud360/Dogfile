// Accessibility & keyboard mode: screen reader announcements (folder, focused item, selection, finished
// operations), F6 to move between the sidebar, address bar, files, preview and assistant, arrow-key navigation in
// the sidebar and tab strip, clear focus rings, larger text, high contrast and reduced motion (Settings).
import { state, bus, h, fmtSize, typeLabel, basename, virtualTitle, isVirtual } from './core.js';
import { activeTab, paneEls } from './pane.js';

let live = null;
export function announce(text, assertive = false) {
  if (state.settings.a11yAnnounce === false || !text) return;
  if (!live) return;
  const el = assertive ? live.a : live.p;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}
export function applyA11y() {
  const S = state.settings, b = document.body;
  b.classList.toggle('kbd-always', S.focusRings === 'always');
  b.classList.toggle('high-contrast', !!S.highContrast);
  const rm = S.reduceMotion;
  b.classList.toggle('reduce-motion', rm === true || rm === 'true' || (rm !== false && rm !== 'false' && matchMedia('(prefers-reduced-motion: reduce)').matches));
  b.classList.toggle('big-targets', !!S.bigTargets);
}
function init() {
  live = { p: h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' }), a: h('div', { class: 'sr-only', 'aria-live': 'assertive', role: 'alert' }) };
  document.body.append(live.p, live.a);
  const toasts = document.getElementById('toasts');
  if (toasts) { toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite'); }
  // keyboard users get focus rings, mouse users don't (unless "always")
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'F6') document.body.classList.add('kbd'); }, true);
  document.addEventListener('mousedown', () => document.body.classList.remove('kbd'), true);
  // every icon-only button gets a name for screen readers from its tooltip
  const label = (root) => root.querySelectorAll?.('button[title]:not([aria-label]), [role=button][title]:not([aria-label])').forEach((b) => { if (!b.textContent.trim()) b.setAttribute('aria-label', b.title); });
  label(document);
  let pending = false;
  new MutationObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; label(document); }); }).observe(document.body, { childList: true, subtree: true });
  // landmarks
  document.getElementById('sidebar')?.setAttribute('aria-label', 'Places');
  document.getElementById('panes')?.setAttribute('role', 'main');
  document.getElementById('preview')?.setAttribute('aria-label', 'Preview');
  document.getElementById('statusbar')?.setAttribute('role', 'contentinfo');
  sidebarKeys();
  tabKeys();
  applyA11y();
}
// announcements
bus.on('loaded', (t) => { if (t !== activeTab()) return; announce(`${t.path?.startsWith('atlas:') ? virtualTitle(t.path) : basename(t.path) || t.path}, ${t.shown?.length ?? t.items?.length ?? 0} items`); });
bus.on('selection', (t) => {
  if (!document.body.classList.contains('kbd') || t !== activeTab()) return;
  const n = t.sel?.size || 0;
  const it = t.focus != null ? t.shown?.[t.indexOf?.get(t.focus)] : null;
  if (it) announce(`${it.name}, ${it.isDir ? 'folder' : typeLabel(it)}${it.isDir || it.size == null ? '' : ', ' + fmtSize(it.size)}, ${(t.indexOf.get(t.focus) ?? 0) + 1} of ${t.shown.length}${n > 1 ? `, ${n} selected` : t.sel.has(t.focus) ? ', selected' : ''}`);
  else if (n) announce(`${n} selected`);
});
bus.on('jobDone', (j) => announce(`${j.title}: ${j.status === 'done' ? 'finished' : j.status}`));
bus.on('settings', applyA11y);

// F6: next area (sidebar → address bar → files → preview → assistant → status bar)
export function cycleRegion(back = false) {
  const t = activeTab();
  const pe = paneEls[state.activePane];
  const regions = [
    () => document.querySelector('#side-list .side-item.active') || document.querySelector('#side-list .side-item'),
    () => pe?.nav?.querySelector('.crumbs, .addr, input') || pe?.nav,
    () => pe?.body,
    () => (state.settings.showPreview ? document.querySelector('#preview button, #preview [tabindex], #preview') : null),
    () => (document.body.classList.contains('assistant-open') ? document.querySelector('#assistant .as-input') : null),
    () => document.querySelector('#statusbar button'),
  ];
  const cur = regions.findIndex((r) => { const el = r(); return el && (el === document.activeElement || el.contains?.(document.activeElement) || document.activeElement?.closest?.('#side-list') && el.closest?.('#side-list')); });
  for (let k = 1; k <= regions.length; k++) {
    const i = (cur + (back ? -k : k) + regions.length * 2) % regions.length;
    const el = regions[i]();
    if (el && el.offsetParent !== null) { if (!el.hasAttribute('tabindex') && !/^(INPUT|BUTTON|TEXTAREA|SELECT|A)$/.test(el.tagName)) el.setAttribute('tabindex', '-1'); el.focus(); announce(['Sidebar', 'Address bar', `Files, ${t ? (isVirtual(t.path) ? virtualTitle(t.path) : basename(t.path)) : ''}`, 'Preview', 'Assistant', 'Status bar'][i]); return; }
  }
}
// arrow keys in the sidebar
function sidebarKeys() {
  const side = document.getElementById('side-list');
  if (!side) return;
  side.setAttribute('role', 'tree');
  side.addEventListener('keydown', (e) => {
    const rows = [...side.querySelectorAll('.side-item')].filter((x) => x.offsetParent !== null);
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = rows.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rows[i].click(); return; }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const tw = rows[i].querySelector('.twisty'); if (tw && tw.classList.contains('open') === (e.key === 'ArrowLeft')) { e.preventDefault(); tw.click(); } return; }
    else if (e.key === 'Escape') { paneEls[state.activePane]?.body.focus(); return; }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = rows[i].getBoundingClientRect(); rows[i].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 30, clientY: r.bottom })); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
    rows[j].focus();
    announce(rows[j].querySelector('.si-label')?.textContent || rows[j].title || '');
  });
}
// arrow keys in the tab strip
function tabKeys() {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  tabs.addEventListener('keydown', (e) => {
    const all = [...tabs.querySelectorAll('.tab')];
    const i = all.indexOf(document.activeElement?.closest?.('.tab'));
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]; n.focus(); announce(n.textContent.trim()); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); all[i].click(); }
    else if (e.key === 'Delete') { e.preventDefault(); all[i].querySelector('.tab-close')?.click(); }
  });
  const mark = () => tabs.querySelectorAll('.tab').forEach((t) => { t.setAttribute('role', 'tab'); t.tabIndex = t.classList.contains('active') ? 0 : -1; t.setAttribute('aria-selected', String(t.classList.contains('active'))); });
  new MutationObserver(mark).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  mark();
}
setTimeout(init, 0);
