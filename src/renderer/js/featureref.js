// Help for people writing features in Atlas Notepad: autocomplete and hover hints for atlas.*, a searchable API
// reference panel (with examples to insert), a live check of the open feature (missing permissions, names that
// don't exist), and the feature log (what features print, and their errors).
import * as API from './featureapi.js';
import { EXAMPLES } from './featureexamples.js';
import { api, onMain, h, esc, toast } from './core.js';
import { icon } from './icons.js';

const TARGET_NAMES = { files: 'File browser', notepad: 'Notepad', photos: 'Photos', player: 'Player' };
const whereText = (it) => (it.where === 'all' ? 'Works everywhere' : 'Only in ' + it.where.map((w) => TARGET_NAMES[w]).join(', '));

// is this document a feature? (name or header, or uses atlas.addCommand)
export function isFeatureText(text, name = '') {
  return /\.atlasfeature(\.js)?$/i.test(name) || /@atlas-feature|\batlas\.add(Command|MenuItem)\b/.test(text.slice(0, 20000));
}

// ---------------- autocomplete ----------------
function infoNode(it) {
  const d = document.createElement('div');
  d.className = 'fr-info';
  d.innerHTML = `<code>${esc(it.sig)}</code><div>${esc(it.desc)}</div><div class="fr-meta">${it.perm ? `<span class="fr-perm">Needs: ${esc(API.PERM_NAMES[it.perm])}</span>` : ''}<span>${esc(whereText(it))}</span>${it.returns ? `<span>Gives: ${esc(it.returns)}</span>` : ''}</div>`;
  return d;
}
export function completionSource(context) {
  const text = context.state.doc.sliceString(0, Math.min(context.state.doc.length, 20000));
  if (!isFeatureText(text)) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  // header lines
  let m = /^\s*\/\/\s*@([\w-]*)$/.exec(before);
  if (m) return { from: context.pos - m[1].length, options: API.HEADER.map(([k, d]) => ({ label: k.slice(1), type: 'keyword', detail: d, apply: k.slice(1) + ' ' })) };
  m = /^\s*\/\/\s*@target\s+(\w*)$/.exec(before);
  if (m) return { from: context.pos - m[1].length, options: Object.entries(TARGET_NAMES).map(([k, d]) => ({ label: k, type: 'enum', detail: d })) };
  m = /^\s*\/\/\s*@permissions\b.*?(\w*)$/.exec(before);
  if (m) return { from: context.pos - m[1].length, options: Object.entries(API.PERM_NAMES).map(([k, d]) => ({ label: k, type: 'enum', detail: d })) };
  // atlas.something.
  m = /\b(atlas(?:\.\w+)*)\.(\w*)$/.exec(before);
  if (m) {
    const opts = API.membersOf(m[1]).map((o) => o.item
      ? { label: o.label, type: o.type, detail: o.item.perm ? `needs ${o.item.perm}` : '', info: () => infoNode(o.item), boost: o.item.where === 'all' ? 1 : 0 }
      : { label: o.label, type: 'namespace', detail: o.detail });
    return opts.length ? { from: context.pos - m[2].length, options: opts, validFor: /^\w*$/ } : null;
  }
  // "atl" → atlas
  m = /\b(at|atl|atla|atlas)$/.exec(before);
  if (m && context.explicit !== false) return { from: context.pos - m[1].length, options: [{ label: 'atlas', type: 'variable', detail: 'Atlas feature API', boost: 5 }] };
  return null;
}

// ---------------- hover ----------------
export function hoverAt(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const re = /\batlas(?:\.\w+)+/g;
  let m;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index, to = from + m[0].length;
    if (pos < from || pos > to) continue;
    // the part up to the hovered word: atlas.files.readText → hover on "files" shows the section
    const upto = line.text.slice(m.index, pos - line.from).length;
    const rest = m[0].slice(upto).split('.')[0];
    const name = m[0].slice(0, upto) + rest;
    const it = API.BY_NAME.get(name);
    if (it) return { pos: from, end: to, create: () => ({ dom: infoNode(it) }) };
    const sec = API.SECTIONS.find((s) => s.items.some((i) => i.name.startsWith(name + '.')));
    if (sec) return { pos: from, end: to, create: () => { const d = document.createElement('div'); d.className = 'fr-info'; d.innerHTML = `<b>${esc(sec.title)}</b><div>${esc(sec.intro)}</div>`; return { dom: d }; } };
    const sug = API.suggest(name);
    return { pos: from, end: to, create: () => { const d = document.createElement('div'); d.className = 'fr-info fr-bad'; d.innerHTML = `<b>${esc(name)}</b> doesn’t exist.${sug ? ` Did you mean <code>${esc(sug)}</code>?` : ''}`; return { dom: d }; } };
  }
  return null;
}

// ---------------- header editing ----------------
export function readHeader(text) {
  const meta = { permissions: [] };
  for (const l of text.split(/\r?\n/).slice(0, 40)) {
    const m = /^\s*\/\/\s*@([\w-]+)\s*(.*)$/.exec(l);
    if (!m) continue;
    if (m[1] === 'permissions') meta.permissions = m[2].split(/[\s,]+/).filter((p) => API.PERM_NAMES[p]);
    else meta[m[1]] = m[2].trim();
  }
  return meta;
}
// returns the new text with perms added to the // @permissions line (or a new line after @target / at the top)
export function addPermissions(text, perms) {
  const lines = text.split('\n');
  const i = lines.findIndex((l, n) => n < 40 && /^\s*\/\/\s*@permissions\b/.test(l));
  if (i >= 0) {
    const have = (lines[i].replace(/^\s*\/\/\s*@permissions/, '').split(/[\s,]+/)).filter(Boolean);
    lines[i] = '// @permissions ' + [...new Set([...have, ...perms])].join(' ');
  } else {
    const t = lines.findIndex((l, n) => n < 40 && /^\s*\/\/\s*@target\b/.test(l));
    lines.splice(t >= 0 ? t + 1 : (/@atlas-feature/.test(lines[0]) ? 1 : 0), 0, '// @permissions ' + perms.join(' '));
  }
  return lines.join('\n');
}
export function checkDoc(text) {
  const meta = readHeader(text);
  const target = meta.target || 'files';
  const used = API.permsUsed(text);
  const missing = [...used].filter(([p]) => !meta.permissions.includes(p)).map(([perm, fn]) => ({ perm, fn }));
  const unused = meta.permissions.filter((p) => !used.has(p) && !(p === 'read' && /files\.(list|stat|readText)/.test(text)));
  return { meta, target, missing, unused, problems: API.problems(text, target), noCommand: !/\batlas\.add(Command|MenuItem)\s*\(/.test(text) };
}

// ---------------- the panel ----------------
// opts: { getText(), setText(text), insert(text), getName(), close(), install(), openExample(ex) }
export function createPanel(host, opts) {
  let tab = 'ref';
  let query = '';
  const logs = [];
  host.innerHTML = '';
  const tabs = h('div', { class: 'fr-tabs', role: 'tablist' });
  const body = h('div', { class: 'fr-body' });
  const head = h('div', { class: 'fr-head' },
    h('span', { class: 'fr-title', html: icon('book') + '<span>Feature help</span>' }),
    h('button', { class: 'icon-btn small', title: 'Close (F1)', html: icon('close'), onclick: () => opts.close() }));
  host.append(head, tabs, body);
  const TABS = [['ref', 'Reference'], ['check', 'Check'], ['examples', 'Examples'], ['log', 'Log']];
  const drawTabs = () => {
    tabs.innerHTML = '';
    for (const [k, l] of TABS) {
      const n = k === 'log' ? logs.filter((x) => x.level === 'error' && !x.seen).length : k === 'check' ? countIssues() : 0;
      tabs.append(h('button', { class: 'fr-tab' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; draw(); } }, l, n ? h('span', { class: 'fr-count' }, String(n)) : null));
    }
  };
  const countIssues = () => { const t = opts.getText(); if (!isFeatureText(t, opts.getName())) return 0; const c = checkDoc(t); return c.missing.length + c.problems.length + (c.noCommand ? 1 : 0); };

  function drawRef() {
    const search = h('input', { class: 'input fr-search', type: 'search', placeholder: 'Search, e.g. rename, pixels, toast', value: query });
    search.oninput = () => { query = search.value; list(); };
    const out = h('div', { class: 'fr-list' });
    const list = () => {
      out.innerHTML = '';
      const q = query.trim().toLowerCase();
      if (!q) {
        out.append(h('div', { class: 'fr-intro' },
          h('p', {}, 'A feature is a small JavaScript file. The lines starting with // @ at the top describe it; the code adds commands with ', h('code', {}, 'atlas.addCommand'), '. Type ', h('code', {}, 'atlas.'), ' for suggestions, and hover a name for help.'),
          h('div', { class: 'fr-sec-title' }, 'Header lines'),
          h('table', { class: 'fr-table' }, ...API.HEADER.map(([k, d]) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, d)))),
          h('div', { class: 'fr-guide' }, h('button', { class: 'btn small', onclick: () => opts.openGuide?.() }, 'Read the full guide'), h('span', { class: 'hint' }, 'Permissions, the sandbox, sharing, and rules for the feature browser.'))));
      }
      for (const s of API.SECTIONS) {
        const items = s.items.filter((i) => !q || (i.name + ' ' + i.desc + ' ' + s.title).toLowerCase().includes(q));
        if (!items.length) continue;
        const sec = h('details', { class: 'fr-sec', open: q || s.id === 'basics' ? '' : null }, h('summary', {}, s.title, h('span', { class: 'fr-n' }, String(items.length))));
        if (!q) sec.append(h('p', { class: 'fr-sec-intro' }, s.intro));
        for (const it of items) sec.append(itemCard(it));
        out.append(sec);
      }
      if (!out.children.length) out.append(h('div', { class: 'hint pad' }, `Nothing matches “${query}”.`));
    };
    list();
    body.append(search, out);
    setTimeout(() => search.focus(), 0);
  }
  function itemCard(it) {
    return h('div', { class: 'fr-item' },
      h('code', { class: 'fr-sig' }, it.sig),
      h('div', { class: 'fr-desc' }, it.desc),
      it.params ? h('table', { class: 'fr-table' }, ...it.params.map(([k, d]) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, d)))) : null,
      h('div', { class: 'fr-meta' }, it.perm ? h('span', { class: 'fr-perm' }, 'Needs: ' + API.PERM_NAMES[it.perm]) : null, h('span', {}, whereText(it)), it.returns && it.returns !== 'nothing' ? h('span', {}, 'Gives: ' + it.returns) : null),
      h('div', { class: 'fr-ex' }, h('pre', {}, it.example),
        h('div', { class: 'fr-ex-acts' },
          h('button', { class: 'btn small', title: 'Insert at the cursor', onclick: () => opts.insert(it.example + '\n') }, 'Insert'),
          h('button', { class: 'btn small', onclick: () => { api('clip:writeText', it.example); toast('Copied', { ms: 1000 }); } }, 'Copy'))));
  }
  function drawCheck() {
    const text = opts.getText();
    if (!isFeatureText(text, opts.getName())) {
      body.append(h('div', { class: 'fr-empty' }, h('p', {}, 'This document isn’t a feature yet.'), h('button', { class: 'btn primary', onclick: () => opts.newFeature() }, 'Add a feature…')));
      return;
    }
    const c = checkDoc(text);
    const row = (ok, title, detail, action) => h('div', { class: 'fr-check ' + (ok === 'warn' ? 'warn' : ok ? 'ok' : 'bad') }, h('span', { class: 'fr-dot', html: icon(ok === true ? 'check' : 'info') }), h('div', {}, h('b', {}, title), detail ? h('div', { class: 'hint' }, detail) : null, action || null));
    body.append(h('div', { class: 'fr-list' },
      row(c.meta.name ? true : false, c.meta.name ? `Name: ${c.meta.name}` : 'No name', c.meta.name ? null : 'Add a line: // @name My feature'),
      row(true, `Runs in: ${TARGET_NAMES[c.target] || c.target}`, c.meta.target ? null : 'No @target line, so it runs in the file browser.'),
      row(c.noCommand ? false : true, c.noCommand ? 'It doesn’t add any command' : 'Adds commands', c.noCommand ? 'Use atlas.addCommand({ id, title, run }) so people can run it.' : null),
      row(c.missing.length ? false : true, c.missing.length ? 'Missing permissions' : `Permissions: ${c.meta.permissions.length ? c.meta.permissions.map((p) => API.PERM_NAMES[p]).join(', ') : 'none needed'}`,
        c.missing.length ? c.missing.map((x) => `${x.fn}() needs “${API.PERM_NAMES[x.perm]}”`).join('. ') + '.' : null,
        c.missing.length ? h('button', { class: 'btn small', onclick: () => { opts.setText(addPermissions(opts.getText(), c.missing.map((x) => x.perm))); draw(); } }, 'Add to the header') : null),
      c.unused.length ? row('warn', 'Asks for more than it uses', `It asks for “${c.unused.map((p) => API.PERM_NAMES[p]).join('”, “')}” but doesn’t seem to use ${c.unused.length > 1 ? 'them' : 'it'}. People trust features that ask for less.`) : null,
      ...c.problems.map((p) => row(false, p.text)),
      h('div', { class: 'fr-check-acts' }, h('button', { class: 'btn primary', onclick: () => opts.install() }, 'Install'), h('span', { class: 'hint' }, 'Installing again updates it.'))));
  }
  function drawExamples() {
    const out = h('div', { class: 'fr-list' });
    for (const [t, name] of Object.entries(TARGET_NAMES)) {
      const ex = EXAMPLES.filter((e) => e.target === t);
      if (!ex.length) continue;
      out.append(h('div', { class: 'fr-sec-title' }, name));
      for (const e of ex) {
        const perms = readHeader(e.code).permissions;
        out.append(h('div', { class: 'fr-exrow' }, h('div', {}, h('b', {}, e.title), h('div', { class: 'hint' }, e.blurb), perms.length ? h('div', { class: 'fr-meta' }, h('span', { class: 'fr-perm' }, 'Needs: ' + perms.map((p) => API.PERM_NAMES[p]).join(', '))) : null),
          h('button', { class: 'btn small', onclick: () => opts.openExample(e) }, 'Open')));
      }
    }
    body.append(out);
  }
  function drawLog() {
    const out = h('div', { class: 'fr-log' });
    logs.forEach((l) => { l.seen = true; });
    if (!logs.length) out.append(h('div', { class: 'hint pad' }, 'Nothing yet. What features print with atlas.log() or console.log(), and any errors they hit, appear here.'));
    for (const l of logs.slice(-300)) out.append(h('div', { class: 'fr-logline ' + l.level }, h('span', { class: 'fr-time' }, new Date(l.t).toLocaleTimeString()), h('b', {}, l.feature), h('span', {}, l.text)));
    body.append(h('div', { class: 'fr-log-acts' }, h('button', { class: 'btn small', onclick: () => api('ext:clearLogs') }, 'Clear')), out);
    setTimeout(() => { out.scrollTop = out.scrollHeight; }, 0);
  }
  function draw() {
    body.innerHTML = '';
    drawTabs();
    ({ ref: drawRef, check: drawCheck, examples: drawExamples, log: drawLog })[tab]();
  }
  api('ext:logs').then((l) => { logs.push(...(l || []).map((x) => ({ ...x, seen: true }))); if (tab === 'log') draw(); }).catch(() => {});
  onMain('ext:log', (e) => { if (e.clear) logs.length = 0; else logs.push(e); if (tab === 'log') draw(); else drawTabs(); });
  draw();
  return { show: (t) => { if (t) tab = t; draw(); }, refreshCheck: () => { if (tab === 'check') draw(); else drawTabs(); }, get tab() { return tab; } };
}
