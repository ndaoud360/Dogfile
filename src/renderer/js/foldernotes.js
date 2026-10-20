// Folder notes: a ".folder.md" file in a folder shows as a pinned note (with clickable to-do checkboxes) at the top
// of that folder. Create one from the background right-click menu or the command palette ("Add folder note").
import { api, state, bus, h, esc, toast, pjoin, isVirtual } from './core.js';
import { icon } from './icons.js';
import { markdown } from './md.js';
import { confirm } from './dialogs.js';

const NOTE = '.folder.md';
const cache = new Map(); // folder -> { mtime, text }
const collapsed = new Set();

function notePath(t) { return pjoin(t.path, NOTE); }
function hasNote(t) { return !isVirtual(t.path) && (t.items || []).some((i) => i.name === NOTE); }

async function render({ el, t }) {
  let box = el.root.querySelector(':scope > .folder-note');
  if (state.settings.folderNotes === false || !t.path || t.app || !hasNote(t)) { box?.remove(); return; }
  const item = t.items.find((i) => i.name === NOTE);
  let c = cache.get(t.path);
  if (!c || c.mtime !== item.mtime) {
    const r = await api('fs:readText', notePath(t), 256 * 1024).catch(() => null);
    if (!r || r.binary) { box?.remove(); return; }
    c = { mtime: item.mtime, text: r.text };
    cache.set(t.path, c);
  }
  if (!box) { box = h('div', { class: 'folder-note' }); el.root.insertBefore(box, el.body); }
  if (box.dataset.key === t.path + '|' + c.mtime + '|' + collapsed.has(t.path) && !box.classList.contains('editing')) return;
  box.dataset.key = t.path + '|' + c.mtime + '|' + collapsed.has(t.path);
  draw(box, t, c);
}

function draw(box, t, c) {
  box.classList.remove('editing');
  box.innerHTML = '';
  const isCol = collapsed.has(t.path);
  const lines = c.text.split(/\r?\n/);
  const firstLine = (lines.find((l) => l.trim()) || 'Folder note').replace(/^#+\s*/, '').slice(0, 80);
  const head = h('div', { class: 'fn-head' },
    h('button', { class: 'fn-toggle', title: isCol ? 'Show note' : 'Hide note', html: icon('chevronRight') + `<span>${esc(isCol ? firstLine : 'Folder note')}</span>`, onclick: () => { isCol ? collapsed.delete(t.path) : collapsed.add(t.path); box.dataset.key = ''; draw(box, t, c); } }),
    h('span', { class: 'fn-spacer' }),
    h('button', { class: 'icon-btn small', title: 'Edit note', html: icon('rename'), onclick: () => edit(box, t, c) }),
    h('button', { class: 'icon-btn small', title: 'Delete note', html: icon('trash'), onclick: async () => { if (await confirm('Delete folder note?', 'Move this folder’s note to the Recycle Bin?', { ok: 'Delete', danger: true })) { await api('fs:trash', notePath(t)); cache.delete(t.path); bus.emit('refreshPanes'); } } }));
  box.classList.toggle('collapsed', isCol);
  box.append(head);
  if (isCol) return;
  const body = h('div', { class: 'fn-body pv-md' });
  body.innerHTML = markdown(c.text.replace(/^\s*[-*] \[( |x|X)\] /gm, (m, x) => m.replace(/\[( |x|X)\]/, x.trim() ? '☑' : '☐')));
  // make the checklist interactive: clicking a box toggles it in the file
  let k = 0;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) { const n = walker.currentNode; if (/^[☐☑]/.test(n.nodeValue.trimStart())) hits.push(n); }
  for (const n of hits) {
    const idx = k++;
    const done = n.nodeValue.trimStart().startsWith('☑');
    const cb = h('input', { type: 'checkbox', class: 'fn-check' });
    cb.checked = done;
    cb.onchange = async () => {
      let i = -1;
      const out = c.text.split(/\r?\n/).map((l) => { if (/^\s*[-*] \[( |x|X)\] /.test(l) && ++i === idx) return l.replace(/\[( |x|X)\]/, cb.checked ? '[x]' : '[ ]'); return l; });
      c.text = out.join(c.text.includes('\r\n') ? '\r\n' : '\n');
      await api('fs:writeText', notePath(t), c.text);
      n.parentElement?.classList.toggle('fn-done', cb.checked);
    };
    n.nodeValue = n.nodeValue.replace(/^(\s*)[☐☑]\s?/, '$1');
    n.parentElement.insertBefore(cb, n);
    n.parentElement.classList.toggle('fn-done', done);
  }
  body.querySelectorAll('a[href]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (/^https?:/.test(a.href)) api('shell:openExternal', a.href); }));
  box.append(body);
}

function edit(box, t, c) {
  box.classList.add('editing');
  box.innerHTML = '';
  const ta = h('textarea', { class: 'fn-edit', spellcheck: 'true' });
  ta.value = c.text;
  const save = async () => { c.text = ta.value; await api('fs:writeText', notePath(t), c.text); box.dataset.key = ''; draw(box, t, c); bus.emit('refreshPanes'); };
  ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 's' && e.ctrlKey) { e.preventDefault(); save(); } if (e.key === 'Escape') draw(box, t, c); });
  box.append(h('div', { class: 'fn-head' }, h('b', {}, 'Folder note'), h('span', { class: 'hint' }, 'Markdown. Use “- [ ] task” for a checklist. Ctrl+S saves.'), h('span', { class: 'fn-spacer' }), h('button', { class: 'btn small', onclick: () => draw(box, t, c) }, 'Cancel'), h('button', { class: 'btn small primary', onclick: save }, 'Save')), ta);
  ta.focus();
}

export async function addFolderNote(t) {
  if (!t?.path || isVirtual(t.path)) return toast('Open a folder first');
  const p = notePath(t);
  if (!(await api('fs:stat', p))) await api('fs:writeText', p, `# ${t.path.split(/[\\/]/).pop() || 'Notes'}\n\nNotes about this folder.\n\n- [ ] First task\n- [ ] Second task\n`);
  collapsed.delete(t.path);
  cache.delete(t.path);
  bus.emit('refreshPanes');
  setTimeout(() => { const box = document.querySelector('.pane.active .folder-note'); const c = cache.get(t.path); if (box && c) edit(box, t, c); }, 500);
}

bus.on('paneRendered', (x) => { render(x).catch(() => {}); });
bus.on('addFolderNote', (t) => addFolderNote(t));
