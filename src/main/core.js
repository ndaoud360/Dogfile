// Bridge to dogfile-core, the native engine (core/ in the source, bin/dogfile-core.exe in the app). It runs as one
// background process; requests and replies are JSON lines. If it's missing or keeps crashing, Dogfile falls back
// to the JavaScript versions of everything, so the app always works.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

let proc = null;
let seq = 0;
let crashes = 0;
let disabled = false;
const pending = new Map(); // id -> { onMsg }
const listeners = new Set(); // id 0 events (index status)
let lastConfig = null;
let info = null;

function binPath() {
  const exe = process.platform === 'win32' ? 'dogfile-core.exe' : 'dogfile-core';
  const cands = [
    path.join(__dirname, '..', '..', 'bin', exe), // packaged: resources/app/bin
    path.join(__dirname, '..', '..', 'core', 'target', 'release', exe), // from source
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

function start() {
  if (proc || disabled) return proc;
  const bin = binPath();
  if (!bin) { disabled = true; return null; }
  try {
    proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch { disabled = true; proc = null; return null; }
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!m.id) { for (const fn of listeners) try { fn(m); } catch {} return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'done' || m.type === 'error') pending.delete(m.id);
    p.onMsg(m);
  });
  proc.on('exit', () => {
    proc = null;
    for (const [id, p] of pending) p.onMsg({ id, type: 'error', error: 'The search engine stopped. Try again.' });
    pending.clear();
    if (++crashes > 3) { disabled = true; return; }
    setTimeout(() => { if (lastConfig) request('index.configure', { ...lastConfig, rescan: false }).catch(() => {}); }, 500);
  });
  proc.stdin.on('error', () => {});
  return proc;
}

/** Send a request; onMsg gets every message (results / progress / done / error). Returns the id. */
function send(cmd, args, onMsg) {
  if (!start()) return null;
  const id = ++seq;
  pending.set(id, { onMsg });
  proc.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
  return id;
}
/** Request with a single answer. */
function request(cmd, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const id = send(cmd, args, (m) => {
      if (m.type === 'done') { clearTimeout(timer); resolve(m); }
      else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
    });
    if (id == null) return reject(new Error('dogfile-core is not available'));
    if (timeoutMs) timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
  });
}
function cancel(id) { if (proc && id) proc.stdin.write(JSON.stringify({ id: ++seq, cmd: 'cancel', args: { target: id } }) + '\n'); }
function available() { return !!start(); }
function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function ping() {
  if (info) return info;
  try { info = await request('ping', {}, 5000); } catch { info = null; }
  return info;
}
async function configureIndex(cfg) {
  lastConfig = cfg;
  return request('index.configure', cfg);
}
function stop() {
  if (!proc) return;
  try { proc.stdin.write(JSON.stringify({ id: ++seq, cmd: 'shutdown', args: {} }) + '\n'); } catch {}
  const p = proc;
  setTimeout(() => { try { p.kill(); } catch {} }, 3000);
}

module.exports = { send, request, cancel, available, onEvent, ping, configureIndex, stop, binPath };
