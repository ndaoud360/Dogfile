// Search documents by meaning: type what you are looking for ("the lease that lets me keep a cat", "notes about the budget
// meeting") and find text, Markdown, PDF, Word and similar files about it, even when they never use those words.
// It runs on this PC with the small sentence model Dogfile already uses (nothing is uploaded). Each file is read once and
// remembered, so the next search in that folder is quick.
import { api, h, esc, toast, basename, errText, isVirtual, isRemote, isMtp } from './core.js';
import { modal } from './dialogs.js';
import { activeTab } from './pane.js';

const TEXT = new Set(['txt', 'md', 'markdown', 'rst', 'org', 'log', 'tex', 'html', 'htm', 'xml', 'srt', 'vtt', 'rtf']);
const DOCS = new Set(['pdf', 'docx', 'odt', 'rtf']);
const MAX_FILES = 4000;
const MAX_CHUNKS = 40; // per file (about the first 3,500 words)
const MAX_SIZE = 40 * 1048576;
const CHUNK = 110, STEP = 90;

// ---------- what is remembered about each file ----------
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('dogfile-semsearch', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
let dbp = null;
const db = () => (dbp ||= idb());
async function getRec(key) { try { const d = await db(); return await new Promise((res) => { const q = d.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
async function putRec(key, v) { try { const d = await db(); await new Promise((res) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(v, key); t.oncomplete = res; t.onerror = res; }); } catch { /* it is only a cache */ } }
export async function forgetAll() { try { const d = await db(); await new Promise((res) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').clear(); t.oncomplete = res; t.onerror = res; }); } catch { /* nothing to forget */ } }

const quant = (v) => { const q = new Int8Array(v.length); for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127))); return q; };
const dotq = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / (127 * 127); };

export function chunksOf(text, title) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length && out.length < MAX_CHUNKS; i += STEP) out.push(words.slice(i, i + CHUNK).join(' '));
  if (!out.length && title) out.push(title);
  if (out.length && title) out[0] = `${title}. ${out[0]}`; // the file name says something about it too
  return out;
}

// ---------- finding the files ----------
async function gather(root, status) {
  const files = [];
  const queue = [[root, 0]];
  while (queue.length && files.length < MAX_FILES) {
    const [dir, depth] = queue.shift();
    const r = await api('fs:list', dir).catch(() => null);
    for (const it of r?.items || []) {
      if (it.isDir) { if (depth < 8 && !it.name.startsWith('.') && !/^(node_modules|\.git|\$RECYCLE\.BIN)$/i.test(it.name)) queue.push([it.path, depth + 1]); continue; }
      const ext = (it.ext || (it.name.includes('.') ? it.name.split('.').pop() : '')).toLowerCase();
      if ((TEXT.has(ext) || DOCS.has(ext)) && (it.size || 0) <= MAX_SIZE && (it.size || 0) > 0) files.push({ ...it, ext });
      if (files.length >= MAX_FILES) break;
    }
    status(`Finding documents… ${files.length}`);
  }
  return files;
}
async function textOf(f) {
  try {
    if (DOCS.has(f.ext)) return (await api('doc:text', f.path, 150000)) || '';
    const r = await api('fs:readText', f.path, 300000);
    return r.binary ? '' : r.text || '';
  } catch { return ''; }
}

// ---------- the window ----------
export async function open(startFolder = null) {
  const t = activeTab();
  const folder = startFolder || (t && t.path && !t.app && !isVirtual(t.path) && !isRemote(t.path) && !isMtp(t.path) ? t.path : null);
  if (!folder) return toast('Open a folder on this PC first. The search looks in it and the folders inside it.');
  const ai = await import('./ai.js');
  const q = h('input', { class: 'input', placeholder: 'Describe what you are looking for…', spellcheck: 'true' });
  const status = h('div', { class: 'hint' }, 'Reads the text, Markdown, PDF and Word files in this folder and the folders inside it. The first search takes a little while; after that it is quick.');
  const results = h('div', { class: 'ss-results' });
  const go = h('button', { class: 'btn primary' }, 'Search');
  let seq = 0;
  const setStatus = (s) => { status.textContent = s; };

  async function search() {
    const query = q.value.trim();
    if (!query) return;
    const my = ++seq;
    const alive = () => my === seq && status.isConnected;
    results.innerHTML = '';
    go.disabled = true;
    try {
      setStatus('Preparing…');
      if (!(await ai.ensureModels(['minilm']))) { setStatus('Search by meaning needs a small model (about 25 MB, downloaded once).'); return; }
      const files = await gather(folder, (s) => alive() && setStatus(s));
      if (!files.length) { setStatus('No text, Markdown, PDF or Word files found here.'); return; }
      const index = []; // { file, chunks: [text], vecs: [Int8Array] }
      let done = 0, fresh = 0;
      for (const f of files) {
        if (!alive()) return;
        const key = `${f.path}|${f.size}|${Math.round(f.mtime || 0)}`;
        let rec = await getRec(key);
        if (!rec) {
          const text = await textOf(f);
          const chunks = chunksOf(text, basename(f.path).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
          let vecs = [];
          if (chunks.length) {
            const out = await ai.call({ type: 'sentences', texts: chunks });
            vecs = out.map(quant);
          }
          rec = { chunks, vecs };
          await putRec(key, rec);
          fresh++;
        }
        index.push({ file: f, ...rec });
        if (++done % 8 === 0 || done === files.length) setStatus(`Reading documents… ${done} of ${files.length}${fresh ? ` (${fresh} new)` : ' (remembered)'}`);
      }
      if (!alive()) return;
      setStatus('Matching…');
      const qv = quant((await ai.call({ type: 'sentences', texts: [query] }))[0]);
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const ranked = [];
      for (const e of index) {
        let best = -1, bi = 0;
        for (let i = 0; i < e.vecs.length; i++) {
          let s = dotq(qv, e.vecs[i]);
          const low = e.chunks[i].toLowerCase();
          s += Math.min(0.1, words.filter((w) => low.includes(w)).length * 0.03); // exact words help a little
          if (s > best) { best = s; bi = i; }
        }
        if (best > 0.2) ranked.push({ ...e, score: best, snippet: e.chunks[bi] });
      }
      ranked.sort((a, b) => b.score - a.score);
      setStatus(ranked.length ? `${Math.min(ranked.length, 60)} best matches among ${files.length.toLocaleString()} documents` : `Nothing close to that among ${files.length.toLocaleString()} documents. Try describing it differently.`);
      const hi = (s) => words.reduce((acc, w) => acc.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'), esc(s));
      results.innerHTML = '';
      for (const r of ranked.slice(0, 60)) {
        const pct = Math.max(1, Math.min(99, Math.round(r.score * 100)));
        results.append(h('div', { class: 'ss-row' },
          h('div', { class: 'ss-score', title: 'How close the meaning is' }, pct + '%'),
          h('div', { class: 'ss-main' },
            h('div', { class: 'ss-name', onclick: () => import('./actions.js').then((A) => A.openItems([r.file])) }, r.file.name),
            h('div', { class: 'hint ss-path' }, r.file.path),
            h('div', { class: 'ss-snip', html: hi(r.snippet.slice(0, 260)) + (r.snippet.length > 260 ? '…' : '') })),
          h('button', { class: 'btn small', title: 'Show it in its folder', onclick: () => import('./pane.js').then((P) => P.navigate(activeTab(), r.file.path.replace(/[\\/][^\\/]*$/, ''), { select: r.file.path })) }, 'Show')));
      }
    } catch (e) { setStatus(`The search failed: ${errText(e)}`); } finally { go.disabled = false; }
  }
  go.onclick = search;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  setTimeout(() => q.focus(), 50);
  await modal({
    title: `Search by meaning in “${basename(folder) || folder}”`, width: 760, className: 'ss-modal',
    body: h('div', {}, h('div', { class: 'sd-row' }, q, go), status, results),
    buttons: [{ label: 'Forget what it remembers', left: true, run: async () => { await forgetAll(); toast('Cleared. The next search reads the files again.'); return false; } }, { label: 'Close', primary: true, value: null }],
    onClose: () => { seq++; },
  });
}
