// Atlas features (extensions): install, run, check permissions. Features are small JavaScript files people write
// in Atlas Notepad (or download from the feature browser). Each one runs in a sandboxed worker (ext-worker.js) and
// can only use what it was allowed when installed: read files, change files, use the network, run commands.
import { api, h, esc, toast, uid } from './core.js';
import { modal, prompt, confirm } from './dialogs.js';
import { icon } from './icons.js';
import * as API from './featureapi.js';

export const TARGETS = { files: 'File browser', notepad: 'Atlas Notepad', photos: 'Atlas Photos', player: 'Atlas Player' };
export const PERMS = {
  read: ['Read files', 'Look at files and folders and read text files'],
  write: ['Change files', 'Create, rename, move, copy, save and recycle files'],
  network: ['Use the internet', 'Send and receive data from websites'],
  run: ['Run commands', 'Run programs and scripts in the built-in terminal (you see them run)'],
};
const NEEDS = { 'files.list': 'read', 'files.stat': 'read', 'files.readText': 'read', 'files.writeText': 'write', 'files.rename': 'write', 'files.copy': 'write', 'files.move': 'write', 'files.mkdir': 'write', 'files.trash': 'write', 'net.fetch': 'network', run: 'run' };

// "// @name Screenplay formatter" style headers at the top of a feature's code
export function parseFeature(code, fallback = {}) {
  const meta = { ...fallback };
  for (const line of String(code).split(/\r?\n/).slice(0, 40)) {
    const m = /^\s*\/\/\s*@([\w-]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'permissions') meta.permissions = v.split(/[\s,]+/).filter((p) => PERMS[p]);
    else if (k === 'target') meta.target = TARGETS[v.trim()] ? v.trim() : meta.target;
    else if (['name', 'description', 'version', 'author', 'icon', 'id'].includes(k)) meta[k] = v.trim();
    else if (k === 'atlas-feature') meta.isFeature = true;
  }
  meta.isFeature = meta.isFeature || /\batlas\.(addCommand|addMenuItem)\b/.test(code);
  meta.permissions = meta.permissions || [];
  meta.target = meta.target || 'files';
  meta.id = meta.id || (meta.name ? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : uid());
  return meta;
}
export const TEMPLATES = {
  files: `// @atlas-feature
// @name My feature
// @description What it does, in one sentence
// @target files
// @permissions read write
// @version 1.0

// Adds a command (Command palette, Features menu) and an item to the right-click menu.
atlas.addCommand({
  id: 'count-words',
  title: 'Count words in selected text files',
  run: async () => {
    const files = await atlas.selection();
    let total = 0;
    for (const f of files) if (!f.isDir) total += ((await atlas.files.readText(f.path)).match(/\\S+/g) || []).length;
    atlas.ui.toast(\`\${total.toLocaleString()} words in \${files.length} file(s)\`);
  },
});

atlas.addMenuItem({
  title: 'Add today’s date to the name',
  when: { files: true },
  run: async ({ selection }) => {
    const d = new Date().toISOString().slice(0, 10);
    for (const f of selection) await atlas.files.rename(f.path, f.path.replace(/([^\\\\/]+?)(\\.[^.\\\\/]*)?$/, \`\${d} $1$2\`));
    atlas.refresh();
  },
});
`,
  notepad: `// @atlas-feature
// @name Screenplay formatter
// @description Formats a plain-text screenplay: scene headings, character names and transitions in capitals
// @target notepad
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'format-screenplay',
  title: 'Format screenplay',
  toolbar: true,
  run: async () => {
    const lines = (await atlas.editor.getText()).split(/\\r?\\n/);
    const out = lines.map((l, i) => {
      const t = l.trim();
      if (/^(int|ext|int\\.\\/ext|i\\/e)[. ]/i.test(t)) return t.toUpperCase();          // scene heading
      if (/(cut to|fade (in|out)|dissolve to):?$/i.test(t)) return ' '.repeat(40) + t.toUpperCase(); // transition
      const next = (lines[i + 1] || '').trim();
      if (t && t.length < 30 && !/[.!?]$/.test(t) && next && lines[i - 1]?.trim() === '') return ' '.repeat(20) + t.toUpperCase(); // character
      return l;
    });
    await atlas.editor.setText(out.join('\\n'));
    atlas.ui.toast('Formatted');
  },
});
`,
  photos: `// @atlas-feature
// @name Sepia
// @description Gives the photo a warm old-photo look
// @target photos
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'sepia',
  title: 'Sepia',
  toolbar: true,
  run: async () => {
    const img = await atlas.photos.getImageData();
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
      d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
      d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
    }
    await atlas.photos.putImageData(img);
  },
});
`,
  player: `// @atlas-feature
// @name Skip intro
// @description Jumps 90 seconds ahead
// @target player
// @permissions
// @version 1.0

atlas.addCommand({ id: 'skip-intro', title: 'Skip intro (+90 s)', toolbar: true, run: async () => atlas.player.seek((await atlas.player.time()) + 90) });
`,
};

// ---------------- running features in a page ----------------
// target: which app this page is; provide: page-specific methods ('editor.getText', 'ctx.selection'…)
export function startFeatures({ target, getSettings, provide = {}, onChange }) {
  const running = new Map(); // id -> { worker, feature, commands: [], menus: [] }
  let runSeq = 0;
  const runs = new Map();
  const host = {
    commands: () => [...running.values()].flatMap((r) => r.commands.map((c) => ({ ...c, feature: r.feature, run: (ctx) => runCmd(r, c.id, ctx) }))),
    menus: () => [...running.values()].flatMap((r) => r.menus.map((c) => ({ ...c, feature: r.feature, run: (ctx) => runCmd(r, c.id, ctx) }))),
    errors: new Map(),
    reload,
  };
  function runCmd(r, cmd, ctx) {
    return new Promise((resolve) => { const runId = ++runSeq; runs.set(runId, resolve); r.worker.postMessage({ type: 'run', cmd, runId, ctx: ctx ? JSON.parse(JSON.stringify(ctx)) : {} }); });
  }
  async function handle(r, m) {
    const f = r.feature;
    const need = NEEDS[m.method];
    if (need && !(f.permissions || []).includes(need)) throw new Error(`atlas.${m.method}() needs the “${PERMS[need][0]}” permission. Add “${need}” to the // @permissions line at the top of the feature, then install it again.`);
    const a = m.args;
    switch (m.method) {
      case 'ui.toast': toast(`${f.name}: ${a[0]}`); return null;
      case 'ui.prompt': return prompt(a[0] || f.name, a[2], { label: a[1] });
      case 'ui.confirm': return confirm(a[0] || f.name, esc(a[1]));
      case 'ui.choose': return modal({ title: a[0] || f.name, width: 420, body: h('div', { class: 'stack' }), buttons: [...a[1].map((o) => ({ label: o, value: o })), { label: 'Cancel', value: null }] });
      case 'ui.showText': return modal({ title: a[0] || f.name, width: 640, body: h('pre', { class: 'ext-pre' }, a[1]), buttons: [{ label: 'Close', primary: true, value: true }] }).then(() => null);
      case 'files.list': return (await api('fs:list', a[0])).items?.map((i) => ({ name: i.name, path: i.path, isDir: i.isDir, size: i.size, mtime: i.mtime }));
      case 'files.stat': return api('fs:stat', a[0]);
      case 'files.readText': { const r2 = await api('fs:readText', a[0], 20 * 1048576); if (r2.binary) throw new Error('Not a text file'); return r2.text; }
      case 'files.writeText': await api('fs:writeText', a[0], a[1]); return true;
      case 'files.rename': await api('fs:rename', a[0], a[1]); return true;
      case 'files.mkdir': await api('fs:mkdir', a[0]); return true;
      case 'files.copy': case 'files.move': case 'files.trash': {
        const spec = m.method === 'files.trash' ? { type: 'trash', sources: [].concat(a[0]) } : { type: m.method === 'files.copy' ? 'copy' : 'move', sources: [].concat(a[0]), dest: a[1] };
        if (provide.runJob) return provide.runJob(spec).then((j) => j.status);
        const id = await api('ops:start', spec); return id;
      }
      case 'files.open': return provide.open ? provide.open(a[0]) : api('shell:open', a[0]);
      case 'net.fetch': return api('ext:fetch', a[0], a[1] || {});
      case 'run': if (provide.run) return provide.run(a[0], a[1]); return api('shell:runCommand', a[0], a[1]);
      case 'clipboard.writeText': await api('clip:writeText', a[0]); return true;
      case 'storage.get': { const all = (await api('store:get', 'ext-storage')) || {}; const v = all[f.id]?.[a[0]]; return v !== undefined ? v : ((getSettings().extStorage || {})[f.id]?.[a[0]] ?? null); }
      case 'storage.set': { const all = (await api('store:get', 'ext-storage')) || {}; all[f.id] = { ...(all[f.id] || {}), [a[0]]: a[1] }; await api('store:set', 'ext-storage', all); return true; }
      default:
        if (provide[m.method]) return provide[m.method](...a);
        throw new Error(`atlas.${m.method}() doesn’t work in ${TARGETS[target]}. Check the feature’s // @target line.`);
    }
  }
  function start(feature) {
    const worker = new Worker(new URL('./ext-worker.js', import.meta.url));
    const r = { worker, feature, commands: [], menus: [] };
    worker.onmessage = async (e) => {
      const m = e.data || {};
      if (m.type === 'call') { try { worker.postMessage({ type: 'reply', id: m.id, result: await handle(r, m) }); } catch (err) { worker.postMessage({ type: 'reply', id: m.id, error: String(err.message || err) }); } }
      else if (m.type === 'register') { (m.kind === 'command' ? r.commands : r.menus).push(m.def); onChange?.(); }
      else if (m.type === 'done') { const res = runs.get(m.runId); runs.delete(m.runId); if (m.error) { const e2 = friendly(m.error + '\n' + (m.stack || '')); log(feature, e2, 'error'); toast(`${feature.name}: ${e2}`, { error: true, ms: 8000 }); } res?.(m.result); }
      else if (m.type === 'error') { const e2 = friendly(m.error); host.errors.set(feature.id, e2); log(feature, e2, 'error'); toast(`The feature “${feature.name}” has an error: ${e2.split('\n')[0]}`, { error: true, ms: 8000 }); }
      else if (m.type === 'log') { console.log(`[feature ${feature.name}]`, m.text); log(feature, m.text, 'log'); }
    };
    worker.onerror = (e) => { host.errors.set(feature.id, e.message); log(feature, e.message, 'error'); toast(`The feature “${feature.name}” stopped: ${e.message}`, { error: true }); };
    worker.postMessage({ type: 'load', id: feature.id, code: feature.code });
    running.set(feature.id, r);
  }
  const log = (feature, text, level) => { api('ext:log', { feature: feature.name || feature.id, id: feature.id, target, text: String(text).slice(0, 4000), level, t: Date.now() }).catch(() => {}); };
  let sig = '';
  function reload() {
    const list = (getSettings().extensions || []).filter((f) => f.enabled !== false && (f.target || 'files') === target);
    const nsig = list.map((f) => f.id + ':' + (f.version || '') + ':' + (f.code || '').length + ':' + (f.permissions || []).join(',')).join('|');
    if (nsig === sig) return;
    sig = nsig;
    for (const r of running.values()) r.worker.terminate();
    running.clear();
    for (const f of list) start(f);
    onChange?.();
  }
  reload();
  return host;
}

// error text a person can act on: "x is not a function" / "doesn't exist" get a suggestion; line numbers point into the feature
export function friendly(err) {
  let t = String(err || '');
  const nf = /(atlas(?:\.\w+)+) doesn’t exist/.exec(t) || /(atlas(?:\.\w+)+) is not a function/.exec(t);
  if (nf) { const s = API.suggest(nf[1]); t = `${nf[1]} doesn’t exist.${s ? ` Did you mean ${s}?` : ''} See Features > API reference in Atlas Notepad.`; }
  const ln = /atlas-feature-[^:]+\.js:(\d+)/.exec(String(err));
  if (ln && !/line \d+/.test(t)) t = t.split('\n')[0] + ` (line ${Math.max(1, +ln[1] - 3)})`;
  return t.split('\n')[0];
}
// what a feature's code needs that its header doesn't ask for, and calls that won't work where it runs
export function checkCode(code, meta) {
  const used = API.permsUsed(code);
  const missing = [...used].filter(([p]) => !(meta.permissions || []).includes(p)).map(([p, fn]) => ({ perm: p, fn }));
  return { missing, problems: API.problems(code, meta.target) };
}

// ---------------- installing ----------------
export async function reviewInstall(code, { source = 'Atlas Notepad', meta: m0 } = {}) {
  const meta = { ...parseFeature(code), ...(m0 || {}) };
  const perms = meta.permissions || [];
  const body = h('div', { class: 'stack' },
    h('div', { class: 'ext-head' }, h('span', { class: 'ext-ic', html: icon('puzzle') }), h('div', {}, h('b', {}, meta.name || 'Untitled feature'), h('div', { class: 'hint' }, `${meta.description || ''}${meta.author ? ` · by ${meta.author}` : ''}${meta.version ? ` · version ${meta.version}` : ''}`))),
    h('div', {}, h('b', {}, 'Adds to: '), TARGETS[meta.target] || meta.target),
    h('div', {}, h('b', {}, 'It will be allowed to:'), perms.length ? h('ul', { class: 'ext-perms' }, ...perms.map((p) => h('li', {}, h('b', {}, PERMS[p][0]), ' — ', PERMS[p][1]))) : h('div', { class: 'hint' }, 'Nothing beyond its own app: no file, internet or command access.')),
    ...(() => { const c = checkCode(code, meta); const w = [...c.missing.map((x) => `${x.fn}() needs the “${PERMS[x.perm][0]}” permission, which the header doesn’t ask for, so that part will be refused.`), ...c.problems.map((x) => x.text + (/[?.]$/.test(x.text) ? '' : '.'))]; return w.length ? [h('div', { class: 'ext-warn' }, h('b', {}, 'Heads up'), h('ul', {}, ...w.map((x) => h('li', {}, x))))] : []; })(),
    h('div', { class: 'hint' }, `From: ${source}. Features run in a sandbox and can only do what is listed above. Only install features from people you trust; read the code below if you can.`),
    h('details', {}, h('summary', {}, 'Show the code'), h('pre', { class: 'ext-pre' }, code)));
  const ok = await modal({ title: 'Install this feature?', width: 640, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Install', primary: true, value: true }] });
  return ok ? { ...meta, code, permissions: perms } : null;
}
export function featureFile(f) {
  return JSON.stringify({ atlasFeature: 1, id: f.id, name: f.name, description: f.description || '', version: f.version || '1.0', author: f.author || '', target: f.target, permissions: f.permissions || [], code: f.code }, null, 2);
}
export function readFeatureFile(text) {
  try { const j = JSON.parse(text); if (j.atlasFeature && j.code) return j; } catch {}
  return { code: text, ...parseFeature(text) };
}

// "Add a feature": a blank starter for each app, or one of the ready-made examples.
// Resolves { code, name, target, action: 'open' | 'install' } or null.
export async function pickStarter(prefer) {
  const { EXAMPLES } = await import('./featureexamples.js');
  let filter = prefer && TARGETS[prefer] ? prefer : 'all';
  let chosen = null;
  const chips = h('div', { class: 'seg fp-seg' });
  const grid = h('div', { class: 'fp-grid' });
  const starters = Object.keys(TARGETS).map((t) => ({ id: 'blank-' + t, target: t, title: `Blank ${TARGETS[t]} feature`, blurb: 'A short starter with comments, to write your own.', code: TEMPLATES[t], blank: true }));
  const all = [...starters, ...EXAMPLES];
  const draw = () => {
    chips.innerHTML = '';
    for (const [k, l] of [['all', 'All'], ...Object.entries(TARGETS)]) chips.append(h('button', { class: 'seg-btn' + (filter === k ? ' on' : ''), onclick: () => { filter = k; draw(); } }, l));
    grid.innerHTML = '';
    for (const e of all.filter((x) => filter === 'all' || x.target === filter)) {
      const perms = parseFeature(e.code).permissions;
      const card = h('button', { class: 'fp-card' + (chosen === e ? ' on' : '') + (e.blank ? ' blank' : ''), ondblclick: () => { chosen = e; document.querySelector('.fp-modal')?._close?.('open'); }, onclick: () => { chosen = e; draw(); } },
        h('div', { class: 'fp-card-top' }, h('span', { class: 'fp-ic', html: icon(e.blank ? 'plus' : 'puzzle') }), h('b', {}, e.title)),
        h('div', { class: 'fp-blurb' }, e.blurb),
        h('div', { class: 'fp-tags' }, h('span', {}, TARGETS[e.target]), ...perms.map((p) => h('span', { class: 'perm' }, PERMS[p][0]))));
      grid.append(card);
    }
  };
  draw();
  const body = h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Pick a starting point. “Open in Notepad” lets you read and change it first; “Install” adds it right away. Features are small JavaScript files that run in a sandbox and only get the access listed on them.'), chips, grid);
  const res = await modal({ title: 'Add a feature', width: 760, className: 'fp-modal', body, buttons: [
    { label: 'Cancel', value: null },
    { label: 'Install', run: (close) => (chosen ? close('install') : (toast('Pick one first'), false)) },
    { label: 'Open in Notepad', primary: true, run: (close) => (chosen ? close('open') : (toast('Pick one first'), false)) }] });
  if (!res || !chosen) return null;
  return { code: chosen.code, name: parseFeature(chosen.code).name || chosen.title, target: chosen.target, action: res };
}
