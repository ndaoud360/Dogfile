// "What is this?": for a file with no extension, or one you're not sure about, look inside it and say what it is. When
// Dogfile is sure (a known signature, not a guess), it offers to add or fix the extension. Nothing is renamed without a tick
// in the box and the Rename button; the new name is always free (never over another file), and Undo puts it back.
import { api, h, toast, basename, dirname, stem, errText, moveTags, fmtSize, bus } from './core.js';
import { modal } from './dialogs.js';
import { activeTab, selectedItems } from './pane.js';
import * as A from './actions.js';

const MAX = 300;
const real = (items) => items.filter((i) => !i.isDir && !i.virtual && !i.archive && !i.recycle && !i.share && !i.mtp);

/** the file name with the right extension: add it, or swap a wrong one. A name like "notes.v2" with no real type keeps its dot. */
export function renamedWith(name, ext, current) {
  if (!ext) return name;
  if (!current) return `${name}.${ext}`;
  return `${stem(name)}.${ext}`;
}

/** what the answer means for the file: 'right' (already named correctly), 'add', 'fix', 'unsure' (a guess), or 'none' */
export function verdict(info) {
  if (!info || !info.ext) return 'none';
  if (info.matches) return 'right';
  if (!info.sure) return 'unsure';
  return info.current ? 'fix' : 'add';
}

export async function identifyPaths(paths) {
  const out = [];
  for (const p of paths) {
    try { out.push({ path: p, info: await api('file:identify', p) }); }
    catch (e) { out.push({ path: p, error: errText(e) }); }
  }
  return out;
}

export async function whatIsThis(given) {
  const items = given || selectedItems(activeTab());
  const files = real(items);
  if (!files.length) return toast(items.length ? 'Folders have no file type. Select a file.' : 'Select a file first');
  const list = files.slice(0, MAX);
  const rows = (await identifyPaths(list.map((f) => f.path))).map((r) => ({ ...r, name: basename(r.path), v: r.error ? 'error' : verdict(r.info) }));
  const boxes = [];
  const body = h('div', { class: 'stack' });
  const sum = h('div', { class: 'hint' });
  body.append(sum);
  const wrap = h('div', { class: 'wit-list' });
  for (const r of rows) {
    const el = h('div', { class: 'wit-row wit-' + r.v });
    const head = h('div', { class: 'wit-name', title: r.path }, r.name);
    el.append(head);
    if (r.error) {
      el.append(h('div', { class: 'wit-what' }, `Couldn’t read it: ${r.error}`));
    } else {
      const i = r.info;
      const what = h('div', { class: 'wit-what' });
      what.append(h('b', {}, i.label));
      if (i.group && i.group !== 'Other') what.append(h('span', { class: 'wit-group' }, ' · ' + i.group));
      if (i.size != null) what.append(h('span', { class: 'wit-group' }, ' · ' + fmtSize(i.size)));
      el.append(what);
      if (r.v === 'right') el.append(h('div', { class: 'wit-line ok' }, `Its name already fits (.${i.current}).`));
      else if (r.v === 'none') el.append(h('div', { class: 'wit-line' }, i.note || 'Dogfile can’t tell what this is. “Open with” another program may.'));
      else {
        const to = renamedWith(r.name, i.ext, i.current);
        r.to = to;
        const cb = h('input', { type: 'checkbox' });
        cb.checked = r.v === 'add' || r.v === 'fix';
        boxes.push({ r, cb });
        const note = r.v === 'unsure' ? 'A good guess, not certain. ' + (i.note || '') : r.v === 'add' ? 'It has no extension, so Windows doesn’t know what opens it.' : `Named .${i.current}, but inside it is ${i.ext.toUpperCase()}.`;
        el.append(h('div', { class: 'wit-line' }, note));
        el.append(h('label', { class: 'check wit-fix' }, cb, ` Rename to `, h('b', {}, to)));
      }
    }
    wrap.append(el);
  }
  body.append(wrap);
  const fixable = rows.filter((r) => r.to).length;
  const rightN = rows.filter((r) => r.v === 'right').length;
  sum.textContent = (rows.length === 1 ? '' : `${rows.length} files looked at. `) + (fixable ? `${fixable} can be given a proper extension. Tick the ones to rename.` : rightN === rows.length ? 'Everything is named correctly.' : 'Nothing to rename.');
  if (files.length > MAX) body.append(h('div', { class: 'hint' }, `Only the first ${MAX} of ${files.length} files were checked.`));
  const apply = async () => {
    const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.r);
    if (!chosen.length) return toast('Nothing ticked');
    const pairs = [], bad = [];
    for (const r of chosen) {
      try {
        const dir = dirname(r.path);
        const to = await api('fs:uniqueName', dir, r.to, 'number');
        await api('fs:rename', r.path, to);
        moveTags(r.path, to);
        pairs.push([r.path, to]);
      } catch (e) { bad.push(`${r.name}: ${errText(e)}`); }
    }
    if (pairs.length) A.pushUndo({ type: 'renamed', pairs }, pairs.length === 1 ? `Add extension to "${basename(pairs[0][0])}"` : `Add extensions to ${pairs.length} files`);
    toast(bad.length ? `Renamed ${pairs.length}. ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}` : `Renamed ${pairs.length} file${pairs.length === 1 ? '' : 's'}`, { ok: !!pairs.length, error: !pairs.length });
    bus.emit('refreshPanes');
  };
  const buttons = [{ label: 'Close', value: null }];
  if (boxes.length) buttons.push({ label: 'Rename ticked', primary: true, run: async (close) => { await apply(); close(true); } });
  await modal({ title: rows.length === 1 ? 'What is this?' : 'What are these?', body, width: 560, className: 'wit-modal', buttons });
}
