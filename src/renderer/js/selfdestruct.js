// Self-destruct: files in a folder go to the Recycle Bin after the time you choose. The settings sit behind a password.
// The engine (rules, password, the once-a-minute check) is backend/src/selfdestruct.rs; this is the window.
import { api, state, h, toast, bus, fmtSize, basename, errText, onMain, isVirtual, isRemote, isMtp } from './core.js';
import { modal, confirm } from './dialogs.js';
import { activeTab } from './pane.js';

const UNITS = [['minutes', 60], ['hours', 3600], ['days', 86400], ['weeks', 604800], ['months', 2592000]];
const PRESETS = [
  ['Pictures', 'jpg, jpeg, png, gif, webp, bmp, heic, avif, svg'],
  ['Videos', 'mp4, mkv, mov, avi, webm, m4v'],
  ['Music', 'mp3, wav, flac, m4a, aac, ogg'],
  ['Documents', 'pdf, doc, docx, xls, xlsx, ppt, pptx, txt, rtf, odt, csv'],
  ['Archives', 'zip, rar, 7z, tar, gz'],
  ['Installers', 'exe, msi, msix, apk'],
];
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const words = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

export function lifespanText(secs) {
  for (const [name, per] of [...UNITS].reverse()) if (secs >= per && secs % per === 0) { const n = secs / per; return `${n} ${n === 1 ? name.replace(/s$/, '') : name}`; }
  return `${Math.round(secs / 60)} minutes`;
}
function untilText(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  const m = Math.round(d / 60000);
  if (m < 60) return `in ${plural(Math.max(1, m), 'minute')}`;
  if (m < 2880) return `in ${plural(Math.round(m / 60), 'hour')}`;
  return `in ${plural(Math.round(m / 1440), 'day')}`;
}
function ruleSummary(r) {
  const who = r.scope === 'new' ? 'New files' : 'Every file';
  const kind = r.typesMode === 'only' ? ` · only ${r.types.join(', ')}` : r.typesMode === 'except' ? ` · all but ${r.types.join(', ')}` : '';
  return `${who} go to the Recycle Bin ${lifespanText(r.ttlSecs)} after they were ${r.basis === 'modified' ? 'last changed' : 'created'}${kind}${r.subfolders ? ' · includes subfolders' : ''}`;
}

// ---------- which folders have a rule (the folder menu and the “keep” item use this) ----------
export async function refreshFolders() {
  try { state.sdFolders = await api('sd:folders'); } catch { state.sdFolders = []; }
}
export function init() {
  refreshFolders();
  onMain('sd:ran', (d) => {
    refreshFolders();
    if (d?.paused) toast(`Self-destruct paused on “${basename(d.folder)}”: a lot of files were about to be removed. Open Self-destruct to look first.`, { error: true, ms: 12000 });
    else if (d?.removed) toast(`Self-destruct moved ${plural(d.removed, 'file')} from “${basename(d.folder)}” to the Recycle Bin.`, { ms: 7000 });
    bus.emit('refreshPanes');
  });
}
/** keep files from ever being removed by a rule (no password: it only keeps more) */
export async function keepFiles(items, on = true) {
  let n = 0;
  for (const it of items) { try { if (await api('sd:keep', it.path, on)) n++; } catch { /* next */ } }
  await refreshFolders();
  toast(n ? (on ? `Kept ${plural(n, 'file')} from self-destruct` : `${plural(n, 'file')} can self-destruct again`) : 'Nothing changed', { ok: !!n });
}

// ---------- the password ----------
function passwordBody(fields, hint) {
  const inputs = fields.map(([label]) => h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: label }));
  const err = h('div', { class: 'field-error' });
  return { inputs, err, el: h('div', {}, hint ? h('div', { class: 'hint', style: { marginBottom: '8px' } }, hint) : null, ...inputs.flatMap((i, k) => [h('label', { class: 'field-label' }, fields[k][0]), i]), err) };
}
async function setupPassword(change = false) {
  const b = passwordBody([[change ? 'New password' : 'Choose a password'], ['Type it again']],
    'This password is asked for whenever you open Self-destruct, so nobody else can change what gets removed. There is no way to recover it; if you forget it, you can reset Self-destruct (that removes all its rules).');
  const v = await modal({
    title: change ? 'Change the password' : 'Protect Self-destruct with a password', width: 440, body: b.el,
    buttons: [{ label: 'Cancel', value: false }, {
      label: change ? 'Change password' : 'Set password', primary: true, run: async (close) => {
        const [a, c] = b.inputs.map((i) => i.value);
        if (a.length < 4) { b.err.textContent = 'Use at least 4 characters'; return false; }
        if (a !== c) { b.err.textContent = 'The two passwords are different'; return false; }
        try { await api('sd:setPassword', a); close(true); } catch (e) { b.err.textContent = errText(e); return false; }
      },
    }],
  });
  return !!v;
}
async function askPassword() {
  const b = passwordBody([['Password']], null);
  let forgot = false;
  const v = await modal({
    title: 'Self-destruct', width: 400, body: b.el,
    buttons: [
      { label: 'Forgot password…', left: true, run: (close) => { forgot = true; close(false); } },
      { label: 'Cancel', value: false },
      {
        label: 'Open', primary: true, run: async (close) => {
          try { if (await api('sd:unlock', b.inputs[0].value)) close(true); else { b.err.textContent = 'That isn’t the password'; b.inputs[0].select(); return false; } } catch (e) { b.err.textContent = errText(e); return false; }
        },
      },
    ],
  });
  if (forgot) {
    if (await confirm('Reset Self-destruct?', 'This removes <b>every Self-destruct rule</b> and the password, so you can start again. Files already in the Recycle Bin stay there. Nothing else is deleted.', { ok: 'Reset', danger: true })) {
      await api('sd:reset'); await refreshFolders(); toast('Self-destruct was reset'); return setupPassword();
    }
    return false;
  }
  return !!v;
}
async function ensureUnlocked() {
  const s = await api('sd:status');
  if (!s.hasPassword) return setupPassword();
  if (s.unlocked) return true;
  return askPassword();
}

// ---------- the rules ----------
export async function open(startFolder = null) {
  if (!(await ensureUnlocked())) return;
  const t = activeTab();
  const here = startFolder || (t && t.path && !t.app && !isVirtual(t.path) && !isRemote(t.path) && !isMtp(t.path) ? t.path : null);
  const box = h('div', { class: 'sd-list' });
  const draw = async () => {
    let r;
    try { r = await api('sd:list'); } catch (e) { box.textContent = errText(e); return; }
    box.innerHTML = '';
    if (!r.rules.length) box.append(h('div', { class: 'confirm-msg' }, 'No folders yet. Add one, choose how long its files stay, and Dogfile moves them to the Recycle Bin when their time is up.'));
    for (const x of r.rules) {
      const state1 = x.needsReview ? 'Paused: a lot was about to be removed' : !x.enabled ? 'Paused' : !x.folderExists ? 'Folder not found' : x.dueNow ? `${plural(x.dueNow, 'file')} due now` : x.nextDue ? `Next: ${untilText(x.nextDue)}` : 'Nothing waiting';
      box.append(h('div', { class: 'sd-rule' + (x.enabled ? '' : ' off') },
        h('div', { class: 'sd-rule-main' },
          h('div', { class: 'sd-rule-folder', title: x.folder }, basename(x.folder) || x.folder, h('span', { class: 'sd-chip' + (x.needsReview ? ' warn' : '') }, state1)),
          h('div', { class: 'hint' }, ruleSummary(x)),
          h('div', { class: 'hint' }, `${x.folder} · ${plural(x.waiting, 'file')} waiting · ${plural(x.totalRemoved, 'file')} removed so far${x.keep.length ? ` · ${plural(x.keep.length, 'file')} kept` : ''}`)),
        h('div', { class: 'sd-rule-actions' },
          h('button', { class: 'btn', onclick: async () => { const s = await editRule(x); if (s) draw(); } }, 'Edit'),
          h('button', { class: 'btn', onclick: async () => { await api('sd:setEnabled', x.id, !x.enabled); await refreshFolders(); draw(); } }, x.enabled ? 'Pause' : 'Resume'),
          h('button', { class: 'btn', title: 'Remove what is due, now', onclick: async () => { await runNow(x); draw(); } }, 'Run now'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirm('Remove this rule?', `Files in “${basename(x.folder)}” will no longer be removed automatically. Nothing is deleted by removing the rule.`, { ok: 'Remove rule' })) { await api('sd:remove', x.id); await refreshFolders(); draw(); } } }, 'Remove'))));
    }
  };
  await draw();
  await modal({
    title: 'Self-destruct', width: 760, className: 'sd-modal',
    body: h('div', {}, h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Files in these folders are moved to the Recycle Bin when their time is up. Nothing is deleted for good, and you can restore anything from the Recycle Bin.'), box),
    buttons: [
      { label: 'Change password…', left: true, run: async () => { await setupPassword(true); return false; } },
      { label: 'Lock and close', run: async (close) => { await api('sd:lock').catch(() => {}); close(null); } },
      { label: 'Add a folder…', primary: true, run: async () => { const s = await editRule(null, here); if (s) draw(); return false; } },
    ],
  });
  refreshFolders();
}

async function runNow(x) {
  const p = await api('sd:preview', x).catch((e) => { toast(errText(e), { error: true }); return null; });
  if (!p) return;
  if (!p.dueNow) { toast('Nothing is due yet', { ok: true }); return; }
  if (!(await confirm('Remove what is due?', `${plural(p.dueNow, 'file')} in “${basename(x.folder)}” will go to the Recycle Bin now.<br><br>${fileList(p.due, 6)}`, { ok: 'Move to the Recycle Bin', danger: true }))) return;
  try { const r = await api('sd:runNow', x.id); toast(`${plural(r.removed, 'file')} moved to the Recycle Bin${r.failed ? `, ${r.failed} couldn’t be moved (in use?)` : ''}`, { ok: true }); bus.emit('refreshPanes'); } catch (e) { toast(errText(e), { error: true }); }
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function fileList(items, n) {
  return items.slice(0, n).map((i) => `• ${esc(basename(i.path))} <span class="hint">${fmtSize(i.size)}</span>`).join('<br>') + (items.length > n ? `<br><span class="hint">and ${(items.length - n).toLocaleString()} more</span>` : '');
}

/** add a rule (existing === null) or change one */
async function editRule(existing, folder = null) {
  const r = existing ? { ...existing } : { folder: folder || '', enabled: true, ttlSecs: 7 * 86400, basis: 'created', scope: 'new', freshStart: true, subfolders: false, typesMode: 'all', types: [], nameHas: [], nameNot: [], minSizeMb: 0, keep: [] };
  let unit = [...UNITS].reverse().find(([, per]) => r.ttlSecs >= per && r.ttlSecs % per === 0) || UNITS[1];
  const folderIn = h('input', { class: 'input', value: r.folder, placeholder: 'Choose a folder, like Downloads', spellcheck: 'false' });
  const pick = h('button', { class: 'btn', onclick: async () => { const d = await api('dialog:pickFolder', 'Folder for Self-destruct'); if (d) folderIn.value = d; } }, 'Choose…');
  const num = h('input', { class: 'input sd-num', type: 'number', min: '1', value: String(Math.max(1, Math.round(r.ttlSecs / unit[1]))) });
  const unitSel = h('select', { class: 'input sd-unit' }, ...UNITS.map(([n]) => h('option', { value: n, ...(n === unit[0] ? { selected: '' } : {}) }, n)));
  const radio = (name, value, label, hint, checked) => h('label', { class: 'sd-radio' }, h('input', { type: 'radio', name, value, ...(checked ? { checked: '' } : {}) }), h('span', {}, label, hint ? h('span', { class: 'hint' }, ' ' + hint) : null));
  const scopeBox = h('div', {}, radio('sd-scope', 'new', 'New files only', '(files that arrive after you turn this on)', r.scope === 'new'), radio('sd-scope', 'all', 'Every file in the folder', '(including what is already there)', r.scope === 'all'));
  const fresh = h('label', { class: 'sd-check' }, h('input', { type: 'checkbox', ...(r.freshStart ? { checked: '' } : {}) }), ' Files already there start their time now (instead of using their real age)');
  const basisSel = h('select', { class: 'input' }, h('option', { value: 'created', ...(r.basis === 'created' ? { selected: '' } : {}) }, 'When the file was created (a download counts from when it arrived)'), h('option', { value: 'modified', ...(r.basis === 'modified' ? { selected: '' } : {}) }, 'When the file was last changed'));
  const typeBox = h('div', {}, radio('sd-types', 'all', 'Every kind of file', '', r.typesMode === 'all'), radio('sd-types', 'only', 'Only these types', '', r.typesMode === 'only'), radio('sd-types', 'except', 'Everything except these types', '', r.typesMode === 'except'));
  const typesIn = h('input', { class: 'input', value: r.types.join(', '), placeholder: 'e.g. zip, exe, png', spellcheck: 'false' });
  const presets = h('div', { class: 'sd-presets' }, ...PRESETS.map(([n, list]) => h('button', { class: 'sd-preset', type: 'button', title: list, onclick: () => { const have = new Set(words(typesIn.value).map((x) => x.toLowerCase())); for (const e of words(list)) have.add(e); typesIn.value = [...have].join(', '); const o = typeBox.querySelector('input[value=all]'); if (o.checked) typeBox.querySelector('input[value=only]').checked = true; } }, '+ ' + n)));
  const hasIn = h('input', { class: 'input', value: r.nameHas.join(', '), placeholder: 'only names with these words (optional)', spellcheck: 'false' });
  const notIn = h('input', { class: 'input', value: r.nameNot.join(', '), placeholder: 'never remove names with these words (optional)', spellcheck: 'false' });
  const sizeIn = h('input', { class: 'input sd-num', type: 'number', min: '0', value: String(r.minSizeMb || 0) });
  const subs = h('label', { class: 'sd-check' }, h('input', { type: 'checkbox', ...(r.subfolders ? { checked: '' } : {}) }), ' Include the folders inside it');
  const out = h('div', { class: 'sd-preview' });
  const read = () => ({
    ...r, folder: folderIn.value.trim(), ttlSecs: Math.max(1, Number(num.value) || 1) * UNITS.find(([n]) => n === unitSel.value)[1],
    basis: basisSel.value, scope: scopeBox.querySelector('input:checked').value, freshStart: fresh.querySelector('input').checked,
    typesMode: typeBox.querySelector('input:checked').value, types: words(typesIn.value), nameHas: words(hasIn.value), nameNot: words(notIn.value),
    minSizeMb: Math.max(0, Number(sizeIn.value) || 0), subfolders: subs.querySelector('input').checked,
  });
  const showPreview = async () => {
    out.textContent = 'Looking…';
    try {
      const p = await api('sd:preview', read());
      out.innerHTML = `<b>${plural(p.dueNow, 'file')}</b> would go to the Recycle Bin right away${p.dueNow ? ':<br>' + fileList(p.due, 6) : '.'}<br><span class="hint">${plural(p.waiting, 'more file')} waiting${p.next[0] ? `; the next goes ${untilText(p.next[0].due)}` : ''}.</span>`;
      return p;
    } catch (e) { out.textContent = errText(e); return null; }
  };
  const body = h('div', { class: 'sd-form' },
    h('label', { class: 'field-label' }, 'Folder'), h('div', { class: 'sd-row' }, folderIn, pick), subs,
    h('label', { class: 'field-label' }, 'Files stay for'), h('div', { class: 'sd-row' }, num, unitSel),
    h('label', { class: 'field-label' }, 'Counted from'), basisSel,
    h('label', { class: 'field-label' }, 'Applies to'), scopeBox, fresh,
    h('label', { class: 'field-label' }, 'Which files'), typeBox, typesIn, presets, hasIn, notIn,
    h('div', { class: 'sd-row' }, h('label', { class: 'field-label', style: { margin: 0 } }, 'Only files bigger than (MB)'), sizeIn),
    h('div', { class: 'hint' }, 'Files still downloading, hidden and system files, and anything you mark “Keep from self-destruct” are never touched.'),
    out);
  const saved = await modal({
    title: existing ? 'Edit this rule' : 'Self-destruct for a folder', width: 600, className: 'sd-modal', body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Preview', run: async () => { await showPreview(); return false; } },
      {
        label: existing ? 'Save' : 'Start', primary: true, run: async (close) => {
          const draft = read();
          const p = await showPreview();
          if (!p) return false;
          if (p.dueNow && !(await confirm('Some files go right away', `${plural(p.dueNow, 'file')} are already past their time and will be moved to the Recycle Bin as soon as you save.<br><br>${fileList(p.due, 8)}`, { ok: 'Save and move them', danger: true }))) return false;
          try { close(await api('sd:save', draft)); } catch (e) { out.textContent = errText(e); return false; }
        },
      },
    ],
  });
  if (saved) { await refreshFolders(); toast(existing ? 'Saved' : `Self-destruct is on for “${basename(saved.folder)}”`, { ok: true }); }
  return saved;
}
