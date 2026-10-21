// Context / dropdown menus with submenus, async items, checkmarks, shortcut hints and keyboard nav.
import { h, esc } from './core.js';
import { icon } from './icons.js';

let stack = [];

export function closeMenus(depth = 0) {
  while (stack.length > depth) { const m = stack.pop(); m.el.remove(); m.onClose?.(); }
}

function placeAt(el, x, y, alignRight) {
  const r = el.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  let left = alignRight ? x - r.width : x;
  let top = y;
  if (left + r.width > W - 6) left = Math.max(6, W - r.width - 6);
  if (left < 6) left = 6;
  if (top + r.height > H - 6) top = Math.max(6, H - r.height - 6);
  if (top < 6) top = 6;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

export async function showMenu(items, x, y, opts = {}) {
  const depth = opts.depth || 0;
  closeMenus(depth);
  if (typeof items === 'function') items = await items();
  items = (items || []).filter((i) => i && !i.hidden);
  // collapse duplicate/leading/trailing separators
  const clean = [];
  for (const it of items) { if (it.separator && (!clean.length || clean[clean.length - 1].separator)) continue; clean.push(it); }
  while (clean.length && clean[clean.length - 1].separator) clean.pop();
  const el = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  let hoverTimer = null;
  let active = -1;
  const rows = [];
  clean.forEach((it, idx) => {
    if (it.separator) { el.append(h('div', { class: 'menu-sep' })); return; }
    if (it.header) { el.append(h('div', { class: 'menu-header' }, it.header)); return; }
    if (it.custom) { el.append(it.custom); return; }
    const row = h('div', { class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.tone ? ' tone-' + it.tone : ''), role: 'menuitem' });
    row.innerHTML = `<span class="mi-icon">${it.checked ? icon('check') : it.radio ? (it.selected ? '<span class="dot"></span>' : '') : it.swatch ? `<span class="swatch" style="background:${it.swatch}"></span>` : it.img ? `<img src="${it.img}">` : it.icon ? icon(it.icon) : ''}</span><span class="mi-label">${esc(it.label)}</span>${it.keys ? `<span class="mi-keys">${esc(it.keys)}</span>` : ''}${it.submenu ? `<span class="mi-sub">${icon('chevronRight')}</span>` : ''}`;
    const openSub = () => {
      if (!it.submenu || it.disabled) return;
      const r = row.getBoundingClientRect();
      showMenu(it.submenu, r.right - 4, r.top - 5, { depth: depth + 1, parentRow: row, path: [...(opts.path || []), it.label], kind: opts.kind });
    };
    row.addEventListener('mouseenter', () => {
      setActive(rows.indexOf(row));
      clearTimeout(hoverTimer);
      if (it.submenu) hoverTimer = setTimeout(openSub, 180); else hoverTimer = setTimeout(() => closeMenus(depth + 1), 200);
    });
    row.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) { openSub(); return; }
      if (!it.keepOpen) closeMenus(0);
      if (opts.kind && it.run) window.__atlasBus?.emit('menuRun', { kind: opts.kind, path: [...(opts.path || []), it.label] });
      it.run?.(e);
    });
    row._item = it; row._open = openSub;
    rows.push(row);
    el.append(row);
  });
  function setActive(i) {
    rows.forEach((r) => r.classList.remove('active'));
    active = i;
    if (rows[i]) { rows[i].classList.add('active'); rows[i].scrollIntoView({ block: 'nearest' }); }
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); let i = active; do { i = (i + 1) % rows.length; } while (rows[i]._item.disabled && i !== active); setActive(i); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); let i = active < 0 ? rows.length : active; do { i = (i - 1 + rows.length) % rows.length; } while (rows[i]._item.disabled && i !== active); setActive(i); }
    else if (e.key === 'ArrowRight' && rows[active]?._item.submenu) { e.preventDefault(); rows[active]._open(); setTimeout(() => { const sub = stack[depth + 1]; sub?.el.focus(); sub?.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); }, 30); }
    else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); closeMenus(depth); stack[depth - 1]?.el.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rows[active]?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenus(depth > 0 ? depth : 0); if (depth > 0) stack[depth - 1]?.el.focus(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      // access key: first letter
      const ch = e.key.toLowerCase();
      const start = active + 1;
      for (let k = 0; k < rows.length; k++) { const i = (start + k) % rows.length; if (rows[i]._item.label.toLowerCase().startsWith(ch)) { setActive(i); break; } }
    }
    e.stopPropagation();
  });
  document.body.append(el);
  placeAt(el, x, y, opts.alignRight);
  stack.push({ el, onClose: opts.onClose });
  el.focus({ preventScroll: true });
  if (opts.selectFirst) setActive(0);
  return el;
}

document.addEventListener('mousedown', (e) => {
  if (!stack.length) return;
  if (!e.target.closest?.('.menu')) closeMenus(0);
}, true);
window.addEventListener('blur', () => closeMenus(0));
window.addEventListener('resize', () => closeMenus(0));
