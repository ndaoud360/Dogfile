// Sandbox for Atlas features (user-made extensions). Each feature runs in its own worker: no access to the page,
// to Node, or to the network directly. Everything goes through the `atlas` object below, and Atlas checks every
// call against the permissions the person approved when installing the feature.
let seq = 0;
const waiting = new Map();
const handlers = new Map(); // command id -> function
const call = (method, ...args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); postMessage({ type: 'call', id, method, args }); });
const log = (...a) => postMessage({ type: 'log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

const atlas = Object.freeze({
  version: 1,
  // registering things
  addCommand(def) { if (!def || !def.id || typeof def.run !== 'function') throw new Error('addCommand needs { id, title, run }'); handlers.set(def.id, def.run); postMessage({ type: 'register', kind: 'command', def: { id: def.id, title: def.title || def.id, icon: def.icon || 'puzzle', keys: def.keys || null, toolbar: !!def.toolbar } }); },
  addMenuItem(def) { if (!def || typeof def.run !== 'function') throw new Error('addMenuItem needs { title, run }'); const id = def.id || 'menu-' + (++seq); handlers.set(id, def.run); postMessage({ type: 'register', kind: 'menu', def: { id, title: def.title || id, icon: def.icon || 'puzzle', when: def.when || null } }); },
  // talking to the person
  ui: Object.freeze({
    toast: (text) => call('ui.toast', String(text)),
    prompt: (title, label, value) => call('ui.prompt', String(title || ''), String(label || ''), value == null ? '' : String(value)),
    confirm: (title, message) => call('ui.confirm', String(title || ''), String(message || '')),
    choose: (title, options) => call('ui.choose', String(title || ''), (options || []).map(String)),
    showText: (title, text) => call('ui.showText', String(title || ''), String(text || '')),
  }),
  // files (needs the "read" / "write" permission)
  files: Object.freeze({
    list: (dir) => call('files.list', dir), stat: (p) => call('files.stat', p),
    readText: (p) => call('files.readText', p), writeText: (p, text) => call('files.writeText', p, String(text)),
    rename: (from, to) => call('files.rename', from, to), copy: (paths, dest) => call('files.copy', paths, dest), move: (paths, dest) => call('files.move', paths, dest),
    mkdir: (p) => call('files.mkdir', p), trash: (paths) => call('files.trash', paths), open: (p) => call('files.open', p),
  }),
  // where you are in Atlas
  selection: () => call('ctx.selection'), folder: () => call('ctx.folder'), navigate: (p) => call('ctx.navigate', p), refresh: () => call('ctx.refresh'),
  // Atlas Notepad (features made for the Notepad)
  editor: Object.freeze({
    getText: () => call('editor.getText'), setText: (t) => call('editor.setText', String(t)),
    getSelection: () => call('editor.getSelection'), replaceSelection: (t) => call('editor.replaceSelection', String(t)), insert: (t) => call('editor.insert', String(t)),
    fileName: () => call('editor.fileName'), getLanguage: () => call('editor.getLanguage'), setLanguage: (id) => call('editor.setLanguage', String(id)),
  }),
  // Atlas Photos (features made for the photo editor): pixels as { width, height, data: Uint8ClampedArray RGBA }
  photos: Object.freeze({ getImageData: () => call('photos.getImageData'), putImageData: (img) => call('photos.putImageData', img), fileName: () => call('photos.fileName') }),
  // Atlas Player
  player: Object.freeze({ currentFile: () => call('player.currentFile'), play: () => call('player.play'), pause: () => call('player.pause'), seek: (s) => call('player.seek', +s), time: () => call('player.time'), duration: () => call('player.duration') }),
  // network (needs the "network" permission): returns { status, text } — JSON: JSON.parse(r.text)
  net: Object.freeze({ fetch: (url, opts) => call('net.fetch', String(url), opts ? { method: opts.method, headers: opts.headers, body: opts.body == null ? undefined : String(opts.body) } : {}) }),
  // run a command in the built-in terminal (needs the "run" permission; the person sees it run)
  run: (command, cwd) => call('run', String(command), cwd),
  // copy text (no permission needed: features can put text on the clipboard but never read it)
  clipboard: Object.freeze({ writeText: (t) => call('clipboard.writeText', String(t)) }),
  // a little storage of the feature's own
  storage: Object.freeze({ get: (k) => call('storage.get', String(k)), set: (k, v) => call('storage.set', String(k), v) }),
  log,
});
// a friendly error for names that don't exist (atlas.files.delete → "doesn't exist", with a suggestion from Atlas)
const SKIP = new Set(['then', 'toJSON', 'constructor', 'prototype', 'valueOf', 'toString', 'inspect', 'nodeType', 'length']);
const guard = (obj, path) => {
  const copy = {};
  for (const [k, v] of Object.entries(obj)) copy[k] = v && typeof v === 'object' ? guard(v, path + '.' + k) : v;
  return new Proxy(copy, {
    get(t, k) { if (typeof k === 'symbol' || SKIP.has(k) || k in t) return t[k]; throw new Error(`${path}.${k} doesn’t exist`); },
    set: () => false, defineProperty: () => false, deleteProperty: () => false,
  });
};
const guarded = guard(atlas, 'atlas');
self.atlas = guarded;
self.console = { log, info: log, warn: log, error: log, debug: log };

onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'reply') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.result); } return; }
  if (m.type === 'load') {
    try {
      // the feature's code, as a function of `atlas` (no other globals from Atlas are reachable)
      const fn = new Function('atlas', 'self', 'globalThis', 'postMessage', 'importScripts', `"use strict";\n${m.code}\n//# sourceURL=atlas-feature-${m.id}.js`);
      await fn(guarded, undefined, undefined, undefined, undefined);
      postMessage({ type: 'loaded' });
    } catch (err) { postMessage({ type: 'error', error: String(err && err.stack || err) }); }
    return;
  }
  if (m.type === 'run') {
    const fn = handlers.get(m.cmd);
    try { const r = fn ? await fn(m.ctx || {}) : undefined; postMessage({ type: 'done', runId: m.runId, result: r === undefined ? null : r }); }
    catch (err) { postMessage({ type: 'done', runId: m.runId, error: String(err && err.message || err), stack: String(err && err.stack || '') }); }
  }
};
