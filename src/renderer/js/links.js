// Linked files (backend/src/links.rs): "See what's linked" and the warning before moving, renaming or deleting a
// file that other files use.
import { api, state, h, basename, dirname, shownPath } from './core.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';

const where = (p) => shownPath(p);
function reveal(p, close) {
  close?.();
  import('./pane.js').then((P) => P.navigate(P.activeTab(), dirname(p), { select: p }));
}

/** "See what's linked": who uses this file, and what it uses */
export async function showLinks(item) {
  const r = await api('links:of', item.path).catch((e) => ({ error: e.message }));
  let close = null;
  const row = (x, missing) => h('button', { class: 'lk-row' + (missing ? ' missing' : ''), title: where(x.path), onclick: () => !missing && reveal(x.path, close) },
    h('span', { class: 'lk-ic', html: icon(missing ? 'close' : 'page') }),
    h('span', { class: 'lk-name' }, x.name),
    h('span', { class: 'lk-dir' }, missing ? 'not found' : x.kind ? `${x.kind} · ${where(x.dir)}` : where(x.dir)));
  const body = h('div', { class: 'lk' });
  if (r.error) body.append(h('p', {}, r.error));
  else {
    const usedBy = r.usedBy || [], uses = r.uses || [];
    const other = usedBy.filter((x) => dirname(x.path).toLowerCase() !== dirname(item.path).toLowerCase()).length;
    body.append(h('div', { class: 'lk-sec' },
      h('div', { class: 'lk-h' }, usedBy.length && other ? h('span', { class: 'ln-dot' }) : null, h('b', {}, usedBy.length ? `Used by ${usedBy.length} file${usedBy.length === 1 ? '' : 's'}` : 'Not used by any file Dogfile knows of'),
        usedBy.length ? h('div', { class: 'hint lk-sub' }, other ? `${other} in another folder. Moving, renaming or deleting ${item.name} breaks ${other === 1 ? 'that link' : 'those links'}.` : 'All in the same folder.') : null),
      ...usedBy.map((x) => row(x))));
    if (r.kind || uses.length) {
      const missing = uses.filter((x) => x.missing).length;
      body.append(h('div', { class: 'lk-sec' },
        h('div', { class: 'lk-h' }, h('b', {}, `Uses ${uses.length} file${uses.length === 1 ? '' : 's'}`), missing ? h('div', { class: 'hint bad lk-sub' }, `${missing} can’t be found`) : null),
        ...uses.slice(0, 300).map((x) => row(x, x.missing)), uses.length > 300 ? h('div', { class: 'hint' }, `and ${uses.length - 300} more`) : null));
    }
    body.append(h('p', { class: 'hint lk-foot' }, `Dogfile reads web pages, style sheets, playlists, Ableton Live, REAPER and FL Studio projects, Shotcut, Kdenlive and Premiere Pro projects, 3D models and shortcuts. ${r.scanning ? 'It’s looking through your folders now.' : ''}`));
  }
  const p = modal({ title: `What’s linked: ${item.name}`, width: 600, className: 'lk-modal', body, buttons: [{ label: 'Look through everything again', left: true, run: async () => { await api('links:scan').catch(() => {}); close?.(); showLinks(item); return false; } }, { label: 'Close', primary: true, value: null }] });
  close = document.querySelector('.lk-modal')?._close;
  return p;
}

/**
 * Before moving, renaming or deleting: if other files use these, say what would break and ask.
 * op: 'move' | 'rename' | 'delete'. Resolves true to go ahead.
 */
export async function linkGuard(paths, op) {
  if (state.settings.linkedFiles === false || !paths?.length) return true;
  let r;
  try { r = await Promise.race([api('links:check', { paths, op }), new Promise((res) => setTimeout(() => res(null), 1500))]); } catch { return true; }
  const probs = r?.problems || [];
  if (!probs.length) return true;
  const verb = { move: 'Move', rename: 'Rename', delete: 'Delete' }[op] || 'Go ahead';
  const list = h('div', { class: 'lk' });
  for (const pb of probs.slice(0, 6)) {
    if (pb.kind === 'usedBy') {
      const users = pb.users.map((u) => u.name);
      const inner = pb.files > 1 ? `${pb.files} files inside ${pb.name} are used` : `${pb.name} is used`;
      list.append(h('div', { class: 'lk-warn' }, h('span', { class: 'ln-dot' }),
        h('div', {}, h('b', {}, `${inner} by ${users.length + (pb.moreUsers || 0)} file${users.length + (pb.moreUsers || 0) === 1 ? '' : 's'}`),
          h('div', { class: 'hint' }, `${pb.users.slice(0, 4).map((u) => `${u.name} (${u.kind}, in ${basename(u.dir) || u.dir})`).join(', ')}${users.length > 4 || pb.moreUsers ? ` and ${users.length - 4 + (pb.moreUsers || 0)} more` : ''}. ${op === 'delete' ? 'They’ll show it as missing.' : 'They won’t find it at its new place.'}`))));
    } else {
      list.append(h('div', { class: 'lk-warn' }, h('span', { class: 'lk-ic', html: icon('pageLinked') }),
        h('div', {}, h('b', {}, `${pb.name} uses ${pb.count} file${pb.count === 1 ? '' : 's'} that stay${pb.count === 1 ? 's' : ''} behind`),
          h('div', { class: 'hint' }, `${pb.targets.slice(0, 4).join(', ')}${pb.count > 4 ? ` and ${pb.count - 4} more` : ''}. Links written as relative paths will point nowhere after the move. Moving the files together keeps them working.`))));
    }
  }
  if (probs.length > 6) list.append(h('div', { class: 'hint' }, `and ${probs.length - 6} more`));
  const v = await modal({ title: op === 'delete' ? 'Other files use this' : 'This will break links', width: 560, className: 'lk-modal', body: list,
    buttons: [{ label: 'Cancel', value: false }, { label: `${verb} anyway`, primary: true, danger: op === 'delete', value: true }] });
  return v === true;
}
