// Multiverse: try a reorganisation of a folder in a "what if" copy first. Nothing on disk changes until "Make it real",
// and that is checked (the folder must still be as it was), done in a way that can be reversed, and can be undone.
// The engine is backend/src/multiverse; this is only the window.
import { api, h, toast, basename, bus, esc } from './core.js';
import { modal, prompt } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, loadTab } from './pane.js';

const NAME_BAD = /[<>:"/\\|?*\u0000-\u001f]/;
const kindWord = { moved: 'Moved', renamed: 'Renamed', new: 'New', copy: 'Copy' };
const nameOf = (p) => String(p).split('/').pop();
const parentOf = (p) => { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const joinP = (a, b) => (a ? `${a}/${b}` : b);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** what a change says, in words */
export function describe(o) {
  const op = o.op;
  switch (op.op) {
    case 'move': return parentOf(op.from) === parentOf(op.to) ? `Rename “${nameOf(op.from)}” to “${nameOf(op.to)}”` : `Move “${op.from}” to “${parentOf(op.to) || 'the top'}”${nameOf(op.from) !== nameOf(op.to) ? ` as “${nameOf(op.to)}”` : ''}`;
    case 'delete': return `Delete “${op.path}” (to the Recycle Bin)`;
    case 'mkdir': return `New folder “${op.path}”`;
    case 'copy': return `Copy “${op.from}” to “${op.to}”`;
    default: return '';
  }
}
export function validName(n) {
  if (!n || !n.trim()) return 'A name can’t be empty';
  if (NAME_BAD.test(n)) return 'A name can’t contain < > : " / \\ | ? *';
  if (/[ .]$/.test(n)) return 'A name can’t end with a space or a dot';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n.trim())) return 'Windows keeps that name for itself';
  return '';
}

export async function open(startFolder) {
  const tab = activeTab();
  const here = startFolder || tab?.path;
  let list = await api('mv:list');
  let view = null;       // the open reality
  let busy = false;
  const open_ = new Set(['']); // folders shown open
  let sel = null;        // selected row path
  const root = h('div', { class: 'mvr' });
  const picker = h('select', { class: 'input mv-pick', title: 'Your what-if copies' });
  const setBusy = (b) => { busy = b; root.classList.toggle('busy', b); };

  const call = async (name, ...a) => {
    setBusy(true);
    try { return await api(name, ...a); }
    catch (e) { toast(String(e?.message || e), { error: true, ms: 8000 }); return null; }
    finally { setBusy(false); }
  };
  let shownId = null;
  const show = (v) => {
    if (v) {
      view = v;
      // folders holding a change are shown open, so what happened can be seen at once
      if (shownId !== v.id || v.ops.length) for (const r of v.rows) if (r.c) for (let p = parentOf(r.p); p; p = parentOf(p)) open_.add(p);
      shownId = v.id;
    }
    draw();
  };

  async function refreshList(selectId) {
    list = await api('mv:list');
    picker.innerHTML = '';
    picker.append(h('option', { value: '' }, list.length ? 'Choose a what-if copy…' : 'No what-if copies yet'));
    for (const r of list) picker.append(h('option', { value: r.id, selected: r.id === (selectId ?? view?.id) }, `${r.name}${r.applied ? ' (made real)' : ''}`));
  }
  picker.onchange = async () => {
    if (!picker.value) { view = null; draw(); return; }
    show(await call('mv:view', picker.value));
  };

  async function create() {
    const folder = here && !String(here).startsWith('atlas:') ? here : null;
    if (!folder) return toast('Open the folder you want to try changes on first');
    const name = await prompt('New what-if copy', `What if: ${basename(folder) || folder}`, { label: `A copy of “${basename(folder) || folder}” to try changes on. Nothing in the real folder changes.` });
    if (!name) return;
    const v = await call('mv:create', folder, name);
    if (!v) return;
    await refreshList(v.id);
    open_.clear(); open_.add('');
    show(v);
  }

  /** the change commands: each asks the engine, which refuses what can't be done and says why */
  async function addOps(group, ops) {
    if (!view || view.applied) return;
    const r = await call('mv:addOps', view.id, group, ops);
    if (!r) return;
    if (r.rejected?.length) toast(r.rejected.length === 1 ? r.rejected[0].why : `${plural(r.rejected.length, 'change')} couldn’t be made: ${r.rejected[0].why}`, { error: true, ms: 7000 });
    show(r.view);
  }
  const preset = async (kind) => {
    if (!view || view.applied) return;
    const scope = sel && view.rows.find((r) => r.p === sel && r.k === 'dir') ? sel : '';
    const r = await call('mv:preset', view.id, kind, scope);
    if (!r) return;
    if (r.empty) toast('Nothing to change there');
    else if (r.rejected?.length) toast(`${plural(r.rejected.length, 'change')} left out: ${r.rejected[0].why}`, { error: true });
    show(r.view);
  };
  const folders = () => ['', ...view.rows.filter((r) => r.k === 'dir').map((r) => r.p)];
  const pickFolder = (title, exclude) => {
    const sel2 = h('select', { class: 'input', size: 12, style: { width: '100%' } });
    for (const f of folders()) {
      if (exclude && (f === exclude || f.startsWith(exclude + '/'))) continue;
      const depth = f ? f.split('/').length : 0;
      sel2.append(h('option', { value: f }, ' '.repeat(depth) + (f ? nameOf(f) : `${basename(view.root) || view.root} (top)`)));
    }
    sel2.value = '';
    return modal({ title, body: sel2, width: 420, buttons: [{ label: 'Cancel', value: null }, { label: 'Choose', primary: true, run: (c) => c(sel2.value ?? '') }] });
  };
  const ask = async (title, value, label) => {
    for (let err = ''; ;) {
      const v = await prompt(title, value, { label: err || label });
      if (v == null) return null;
      err = validName(v.trim());
      if (!err) return v.trim();
      value = v;
    }
  };
  const rowActions = {
    async rename(p) { const n = await ask('Rename', nameOf(p), 'New name'); if (n && n !== nameOf(p)) addOps('Rename', [{ op: 'move', from: p, to: joinP(parentOf(p), n) }]); },
    async moveTo(p) { const f = await pickFolder(`Move “${nameOf(p)}” to…`, view.rows.find((r) => r.p === p)?.k === 'dir' ? p : null); if (f != null && f !== parentOf(p)) addOps('Move', [{ op: 'move', from: p, to: joinP(f, nameOf(p)) }]); },
    async copyTo(p) { const f = await pickFolder(`Copy “${nameOf(p)}” to…`, view.rows.find((r) => r.p === p)?.k === 'dir' ? p : null); if (f == null) return; const n = f === parentOf(p) ? await ask('Name of the copy', `${nameOf(p)} copy`, 'Name') : nameOf(p); if (n) addOps('Copy', [{ op: 'copy', from: p, to: joinP(f, n) }]); },
    delete(p) { addOps('Delete', [{ op: 'delete', path: p }]); },
    async newFolder(p) { const n = await ask('New folder', 'New folder', 'Folder name'); if (n) { open_.add(p); addOps('New folder', [{ op: 'mkdir', path: joinP(p, n) }]); } },
  };

  async function toggle(ids, on) { const v = await call('mv:toggle', view.id, ids, on); if (v) show(v); }
  async function removeOps(ids) { const v = await call('mv:removeOps', view.id, ids); if (v) show(v); }

  // ---------- drawing ----------
  const treeBox = h('div', { class: 'mv-tree', tabindex: '0' });
  const changesBox = h('div', { class: 'mv-changes' });
  const banner = h('div', { class: 'mv-banner' });
  const status = h('div', { class: 'mv-status' });
  const quick = h('div', { class: 'mv-quick' });
  let dragging = null;

  function drawTree() {
    treeBox.innerHTML = '';
    const rows = view.rows;
    const kids = new Map();
    for (const r of rows) { const p = parentOf(r.p); (kids.get(p) || kids.set(p, []).get(p)).push(r); }
    const sortKids = (a) => a.sort((x, y) => (x.k === 'dir' ? 0 : 1) - (y.k === 'dir' ? 0 : 1) || nameOf(x.p).localeCompare(nameOf(y.p), undefined, { numeric: true, sensitivity: 'base' }));
    const rootRow = h('div', { class: 'mv-row root' + (sel === '' ? ' sel' : ''), 'data-p': '' }, h('span', { class: 'mv-ic', html: icon('folderOpen') }), h('b', {}, basename(view.root) || view.root), h('span', { class: 'mv-sub' }, `${plural(rows.length, 'item')}`));
    wireRow(rootRow, '', true);
    treeBox.append(rootRow);
    const count = { n: 0 };
    const walk = (p, depth) => {
      for (const r of sortKids(kids.get(p) || [])) {
        if (count.n++ > 3000) return;
        const isDir = r.k === 'dir';
        const opened = open_.has(r.p);
        const row = h('div', { class: 'mv-row' + (r.c ? ' ' + r.c : '') + (sel === r.p ? ' sel' : ''), 'data-p': r.p, style: { '--d': depth } },
          isDir ? h('button', { class: 'mv-tw', html: icon(opened ? 'chevronDown' : 'chevronRight'), title: opened ? 'Close' : 'Open', onclick: (e) => { e.stopPropagation(); opened ? open_.delete(r.p) : open_.add(r.p); drawTree(); } }) : h('span', { class: 'mv-tw' }),
          h('span', { class: 'mv-ic', html: icon(isDir ? 'folder' : r.k === 'link' ? 'link' : 'page') }),
          h('span', { class: 'mv-name' }, nameOf(r.p)),
          r.c ? h('span', { class: 'mv-badge ' + r.c, title: r.o ? `Was “${r.o}”` : '' }, kindWord[r.c]) : null,
          r.k === 'link' ? h('span', { class: 'mv-badge lock', title: 'A link or a folder Dogfile can’t look into. A what-if copy never changes it.' }, 'Left alone') : null);
        wireRow(row, r.p, isDir, r);
        treeBox.append(row);
        if (isDir && opened) walk(r.p, depth + 1);
      }
    };
    walk('', 1);
    if (view.gone.length) {
      treeBox.append(h('div', { class: 'mv-sep' }, 'Would be removed (to the Recycle Bin)'));
      for (const g of view.gone) treeBox.append(h('div', { class: 'mv-row gone', title: 'Still in the real folder. It goes to the Recycle Bin only when you make this real.' }, h('span', { class: 'mv-tw' }), h('span', { class: 'mv-ic', html: icon(g.k === 'dir' ? 'folder' : 'page') }), h('span', { class: 'mv-name' }, g.p)));
    }
  }
  function wireRow(row, p, isDir, r) {
    const editable = !view.applied;
    row.addEventListener('click', () => { sel = p; treeBox.querySelectorAll('.mv-row.sel').forEach((x) => x.classList.remove('sel')); row.classList.add('sel'); drawQuick(); });
    if (isDir && p) row.addEventListener('dblclick', () => { open_.has(p) ? open_.delete(p) : open_.add(p); drawTree(); });
    if (!editable) return;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); sel = p; drawTree(); rowMenu(e, p, isDir, r); });
    if (p && r?.k !== 'link') {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { dragging = p; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p); });
      row.addEventListener('dragend', () => { dragging = null; treeBox.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });
    }
    if (isDir) {
      row.addEventListener('dragover', (e) => { if (dragging == null || dragging === p || p.startsWith(dragging + '/') || parentOf(dragging) === p) return; e.preventDefault(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('drop');
        const from = dragging; dragging = null;
        if (from == null || from === p) return;
        open_.add(p);
        addOps('Move', [{ op: 'move', from, to: joinP(p, nameOf(from)) }]);
      });
    }
  }
  async function rowMenu(e, p, isDir, r) {
    const { showMenu } = await import('./menu.js');
    const items = [];
    if (p && r?.k !== 'link') items.push({ label: 'Rename…', icon: 'rename', run: () => rowActions.rename(p) }, { label: 'Move to…', icon: 'moveTo', run: () => rowActions.moveTo(p) }, { label: 'Copy to…', icon: 'copyTo', run: () => rowActions.copyTo(p) });
    if (isDir) items.push({ label: 'New folder inside…', icon: 'newFolder', run: () => rowActions.newFolder(p) });
    if (isDir) items.push({ separator: true }, { label: 'Sort what’s in it by type', icon: 'wand', run: () => { sel = p; preset('type'); } }, { label: 'Sort what’s in it by month', icon: 'calendar', run: () => { sel = p; preset('month'); } });
    if (p && r?.k !== 'link') items.push({ separator: true }, { label: 'Delete (to the Recycle Bin)', icon: 'trash', danger: true, run: () => rowActions.delete(p) });
    showMenu(items, e.clientX, e.clientY);
  }

  function drawQuick() {
    quick.innerHTML = '';
    if (!view || view.applied) return;
    const scopeName = sel ? `in “${nameOf(sel)}”` : 'in the top folder';
    const btn = (label, ic, run, title) => h('button', { class: 'btn small', title, html: `${icon(ic)}<span>${esc(label)}</span>`, onclick: run });
    quick.append(
      btn('Sort by type', 'wand', () => preset('type'), `Put the loose files ${scopeName} into Images, Documents, Videos…`),
      btn('Sort by month', 'calendar', () => preset('month'), `Put the loose files ${scopeName} into folders by the month they were changed`),
      btn('Flatten', 'flatten', () => preset('flatten'), `Bring every file out of the folders ${scopeName} into it`),
      h('span', { class: 'mv-sep-v' }),
      btn('New folder', 'newFolder', () => rowActions.newFolder(sel && view.rows.find((x) => x.p === sel && x.k === 'dir') ? sel : sel ? parentOf(sel) : ''), 'Make a folder'),
      btn('Rename', 'rename', () => sel && rowActions.rename(sel), 'Rename the selected item'),
      btn('Move to…', 'moveTo', () => sel && rowActions.moveTo(sel), 'Move the selected item'),
      btn('Copy to…', 'copyTo', () => sel && rowActions.copyTo(sel), 'Copy the selected item'),
      btn('Delete', 'trash', () => sel && rowActions.delete(sel), 'Delete the selected item (to the Recycle Bin, when it’s made real)'));
    const has = !!sel;
    quick.querySelectorAll('button').forEach((b, i) => { if (i >= 4 && !has) b.disabled = true; });
  }

  function drawChanges() {
    changesBox.innerHTML = '';
    if (!view.ops.length) { changesBox.append(h('div', { class: 'mv-empty' }, 'No changes yet. Use the buttons above, drag things onto folders, or right-click an item.')); return; }
    // consecutive changes of one kind of action sit together
    const groups = [];
    for (const o of view.ops) { const g = groups[groups.length - 1]; if (g && g.name === o.group) g.ops.push(o); else groups.push({ name: o.group, ops: [o] }); }
    for (const g of groups) {
      const onAll = g.ops.every((o) => o.on);
      const gcb = h('input', { type: 'checkbox', checked: onAll, disabled: !!view.applied, title: 'Switch all of these on or off' });
      gcb.onchange = () => toggle(g.ops.map((o) => o.id), gcb.checked);
      const del = h('button', { class: 'icon-btn', title: 'Remove these changes', html: icon('close'), disabled: !!view.applied, onclick: () => removeOps(g.ops.map((o) => o.id)) });
      const det = h('details', { class: 'mv-group', open: g.ops.length <= 12 },
        h('summary', {}, gcb, h('b', {}, g.name), h('span', { class: 'mv-count' }, plural(g.ops.length, 'change')), del),
        ...g.ops.slice(0, 500).map((o) => {
          const cb = h('input', { type: 'checkbox', checked: o.on, disabled: !!view.applied });
          cb.onchange = () => toggle([o.id], cb.checked);
          return h('label', { class: 'mv-op ' + o.state, title: o.why || '' }, cb, h('span', {}, describe(o)), o.state === 'blocked' ? h('em', {}, o.why) : null);
        }),
        g.ops.length > 500 ? h('div', { class: 'hint' }, `…and ${g.ops.length - 500} more`) : null);
      changesBox.append(det);
    }
  }

  function draw() {
    root.classList.toggle('empty', !view);
    if (!view) {
      treeBox.innerHTML = ''; changesBox.innerHTML = ''; quick.innerHTML = ''; banner.innerHTML = ''; status.textContent = '';
      banner.append(h('div', { class: 'mv-intro' }, h('b', {}, 'Try a reorganisation without risk.'), ' A what-if copy is a pretend version of a folder. Sort it, rename, move, delete and copy as much as you like and look at the result. Nothing in the real folder changes until you make it real, and then you can undo it.',
        h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: create }, 'New what-if copy of this folder'))));
      refreshButtons();
      return;
    }
    banner.innerHTML = '';
    if (view.applied) banner.append(h('div', { class: 'mv-note ok' }, `These changes are real. ${view.applied.notes?.length ? view.applied.notes.join(' ') + ' ' : ''}If you change your mind, Undo puts everything back.`));
    else if (!view.canDelete && view.ops.some((o) => o.state === 'blocked' && /Recycle Bin/.test(o.why || ''))) banner.append(h('div', { class: 'mv-note warn' }, 'This drive has no Recycle Bin, so deleting isn’t offered here (nothing is ever deleted for good).'));
    const s = view.stats;
    const bits = [s.moved && `${s.moved} moved`, s.renamed && `${s.renamed} renamed`, s.new && `${s.new} new folder${s.new === 1 ? '' : 's'}`, s.copies && `${s.copies} cop${s.copies === 1 ? 'y' : 'ies'}`, s.deleted && `${s.deleted} to the Recycle Bin`].filter(Boolean);
    status.innerHTML = '';
    status.append(h('span', {}, bits.length ? bits.join(' · ') : 'No changes'), s.blocked ? h('span', { class: 'mv-bad' }, ` · ${plural(s.blocked, 'change')} can’t be made`) : null);
    drawTree(); drawChanges(); drawQuick(); refreshButtons();
  }

  // ---------- making it real, and undo ----------
  async function makeReal() {
    if (!view || view.applied || busy) return;
    if (!view.stats.on) return toast('There’s nothing switched on to make');
    const c = await call('mv:check', view.id);
    if (!c) return;
    if (!c.ok) return showDrift(c.drift);
    const s = view.stats;
    const lines = [s.moved + s.renamed ? `${plural(s.moved + s.renamed, 'item')} moved or renamed` : '', s.new ? `${plural(s.new, 'folder')} made` : '', s.copies ? `${s.copies} cop${s.copies === 1 ? 'y' : 'ies'} made` : '', s.deleted ? `${plural(s.deleted, 'item')} sent to the Recycle Bin` : ''].filter(Boolean);
    const ok = await modal({ title: 'Make it real?', width: 520, body: h('div', { class: 'stack' },
      h('div', { class: 'confirm-msg' }, `This changes the real folder “${basename(view.root) || view.root}”:`), h('ul', { class: 'mv-list' }, ...lines.map((l) => h('li', {}, l))),
      h('div', { class: 'hint' }, 'Nothing is replaced and nothing is deleted for good. If anything goes wrong part way, everything is put back. Afterwards you can undo it.')),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Make it real', primary: true, value: true }] });
    if (!ok) return;
    const r = await call('mv:apply', view.id);
    if (!r) return;
    if (r.ok) {
      show(r.view);
      toast(`Done. ${r.notes?.length ? r.notes[0] : 'You can undo this from the Multiverse.'}`, { ms: 6000 });
      if (tab) loadTab(tab, { soft: true });
      refreshList(view.id);
      return;
    }
    if (r.kind === 'drift') return showDrift(r.drift);
    await modal({ title: r.kind === 'failed' ? 'Nothing was changed' : 'Couldn’t make it real', width: 520, body: h('div', { class: 'stack' }, h('div', { class: 'confirm-msg' }, r.message), ...(r.problems?.length ? [h('ul', { class: 'mv-list' }, ...r.problems.map((p) => h('li', {}, p)))] : [])), buttons: [{ label: 'OK', primary: true, value: true }] });
    if (tab) loadTab(tab, { soft: true });
  }
  async function showDrift(list) {
    const again = await modal({ title: 'The folder has changed', width: 540, body: h('div', { class: 'stack' },
      h('div', { class: 'confirm-msg' }, 'Something in the real folder is different from when this what-if copy was made, so nothing was done:'), h('ul', { class: 'mv-list' }, ...list.slice(0, 12).map((p) => h('li', {}, p)), list.length > 12 ? h('li', {}, `…and ${list.length - 12} more`) : null),
      h('div', { class: 'hint' }, 'Look at the folder again to bring the what-if copy up to date. Your changes are kept, and any that no longer fit are marked.')),
      buttons: [{ label: 'Close', value: false }, { label: 'Look at the folder again', primary: true, value: true }] });
    if (again) { const v = await call('mv:rebase', view.id); if (v) show(v); }
  }
  async function undo() {
    if (!view?.applied || busy) return;
    const ok = await modal({ title: 'Undo these changes?', width: 480, body: h('div', { class: 'confirm-msg' }, 'Everything is put back where it was, and anything that went to the Recycle Bin is restored. If something in the folder has changed since, nothing is touched.'), buttons: [{ label: 'Cancel', value: false }, { label: 'Undo', primary: true, value: true }] });
    if (!ok) return;
    const r = await call('mv:undo', view.id);
    if (!r) return;
    if (r.view) show(r.view);
    if (tab) loadTab(tab, { soft: true });
    if (r.ok) { toast('Put back the way it was', { ms: 5000 }); refreshList(view.id); return; }
    await modal({ title: r.kind === 'blocked' ? 'Nothing was undone' : 'Undo stopped', width: 540, body: h('div', { class: 'stack' }, h('div', { class: 'confirm-msg' }, r.message), h('ul', { class: 'mv-list' }, ...(r.problems || []).map((p) => h('li', {}, p)))), buttons: [{ label: 'OK', primary: true, value: true }] });
  }
  async function discard() {
    if (!view) return;
    const real = !!view.applied;
    const ok = await modal({ title: 'Discard this what-if copy?', width: 460, body: h('div', { class: 'confirm-msg' }, real ? 'Its changes were made real. If you discard it here, they can no longer be undone from the Multiverse (the Recycle Bin still has what was deleted).' : 'This only removes the pretend copy. The real folder isn’t touched.'), buttons: [{ label: 'Cancel', value: false }, { label: 'Discard', danger: true, primary: true, value: true }] });
    if (!ok) return;
    if (await call('mv:discard', view.id, real) != null) { view = null; sel = null; await refreshList(''); draw(); }
  }
  async function again() { const v = await call('mv:rebase', view.id); if (v) { show(v); toast('Looked at the folder again'); } }

  const bNew = h('button', { class: 'btn', onclick: create, title: 'Start a what-if copy of the open folder' }, 'New…');
  const bRename = h('button', { class: 'btn', title: 'Rename this what-if copy', onclick: async () => { const n = await prompt('Rename', view.name, { label: 'Name' }); if (n) { await call('mv:rename', view.id, n); view.name = n; refreshList(view.id); } } }, 'Rename');
  const bDiscard = h('button', { class: 'btn', onclick: discard, title: 'Remove this what-if copy (the real folder isn’t touched)' }, 'Discard');
  const bAgain = h('button', { class: 'btn', onclick: again, title: 'Look at the real folder again. Your changes stay; any that no longer fit are marked.' }, 'Look again');
  const bReal = h('button', { class: 'btn primary', onclick: makeReal }, 'Make it real…');
  const bUndo = h('button', { class: 'btn', onclick: undo }, 'Undo');
  function refreshButtons() {
    const has = !!view;
    for (const b of [bRename, bDiscard]) b.style.display = has ? '' : 'none';
    bAgain.style.display = has && !view.applied ? '' : 'none';
    bReal.style.display = has && !view.applied ? '' : 'none';
    bUndo.style.display = has && view.applied ? '' : 'none';
    bReal.disabled = !has || !view?.stats?.on;
  }

  root.append(
    h('div', { class: 'mv-top' }, picker, bNew, bRename, bDiscard),
    banner,
    quick,
    h('div', { class: 'mv-main' }, h('div', { class: 'mv-col' }, h('div', { class: 'mv-h' }, 'What it would look like'), treeBox), h('div', { class: 'mv-col' }, h('div', { class: 'mv-h' }, 'Changes'), changesBox)),
    status);

  await refreshList('');
  // open the copy of this folder if there is one, otherwise show the start page
  const mine = list.find((r) => r.root === here && !r.applied);
  if (mine) { picker.value = mine.id; show(await api('mv:view', mine.id).catch(() => null)); } else draw();
  await modal({ title: 'Multiverse', body: root, width: 1100, className: 'mv-modal', noPadding: true, closeOnBackdrop: false, buttons: [{ el: bAgain, left: true }, { el: bUndo }, { label: 'Close', value: null }, { el: bReal }] });
}

/** at start: finish or reverse anything an interrupted run left half done */
export async function recoverAtStart() {
  try {
    const r = await api('mv:recover');
    for (const x of r || []) {
      if (x.result === 'reversed') toast('A Multiverse change was interrupted last time, and Dogfile put everything back as it was.', { ms: 9000 });
      else if (x.result === 'finished') toast('A Multiverse change was interrupted last time, and Dogfile finished it. You can undo it from the Multiverse.', { ms: 9000 });
      else toast(`A Multiverse change was interrupted and needs attention: ${x.problems?.[0] || ''}`, { error: true, ms: 12000 });
    }
  } catch { /* nothing to recover */ }
}
bus.on('multiverse', () => open());
