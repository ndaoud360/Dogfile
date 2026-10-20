// Organizing engine shared by Tidy up, folder automations and the AI assistant.
// - groupByName: finds the "topics" in file names (dog breeds, projects, clients, shows...) and puts every file in
//   the single most fitting group. Words that always appear together become one phrase ("Golden Retriever"),
//   words that cut across groups ("puppy", "beach") lose to the words that are specific to a group, and names
//   written without separators ("GoldenRetriever01") still match.
// - matchExisting: sends files to subfolders that already exist when their names fit ("poodle_2.jpg" -> "Poodles").
// - kind / date / size folders and simple when→then rules.
import { KINDS } from './core.js';

export const STOP = new Set(('the a an and or of for to in on at by with from new copy final draft version ver rev img image dsc dscn dcim pxl vid mov movie photo photos pic pics picture pictures video videos audio file files document doc docs untitled scan scanned download downloads setup installer install x64 x86 amd64 win windows full hd uhd 4k 1080p 720p 480p official edit edited export exported jpg jpeg png gif mp4 mp3 wav pdf zip rar part temp tmp backup bak old orig original screenshot screen shot capture snap whatsapp signal telegram wa img_ dji gopro iphone android pixel samsung').split(' '));
const MONTHS = new Set('jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december'.split(' '));

export function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
const stemOf = (name) => name.replace(/\.[^.]{1,6}$/, '');
// words of a file name, cleaned and singular
export function nameWords(name, extraStop) {
  return stemOf(name)
    .replace(/([a-z])([A-Z][a-z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-zÀ-ɏ]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !MONTHS.has(w) && !(extraStop && extraStop.has(w)))
    .map(singular)
    .filter((w) => w.length > 2 && !STOP.has(w) && !(extraStop && extraStop.has(w)));
}
const squash = (name) => stemOf(name).toLowerCase().replace(/[^a-zÀ-ɏ]+/g, '');
const title = (s) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Group files by the topic in their names.
 * @returns {{groups: Map<string, item[]>, rest: item[], why: Map<item, string>}}
 */
export function groupByName(files, { min = 2, maxFrac = 0.7, folderName = '' } = {}) {
  const extra = new Set(nameWords(folderName || ''));
  for (const w of [...extra]) extra.add(singular(w));
  const N = files.length;
  const words = new Map(files.map((f) => [f, nameWords(f.name, extra)]));
  // candidate keys: single words and adjacent word pairs
  const sets = new Map(); // key -> Set(files)
  const add = (k, f) => { let s = sets.get(k); if (!s) sets.set(k, (s = new Set())); s.add(f); };
  for (const [f, ws] of words) {
    const seen = new Set();
    ws.forEach((w, i) => { if (!seen.has(w)) { seen.add(w); add(w, f); } if (i + 1 < ws.length && ws[i + 1] !== w) { const b = w + ' ' + ws[i + 1]; if (!seen.has(b)) { seen.add(b); add(b, f); } } });
  }
  // names written together ("GoldenRetriever", "golden_retriever01") match the phrase too
  const squashed = new Map(files.map((f) => [f, squash(f.name)]));
  for (const [k, s] of sets) {
    if (s.size < min) continue;
    const joined = k.replace(/ /g, '');
    if (joined.length < 4) continue;
    for (const f of files) if (!s.has(f) && (squashed.get(f).includes(joined))) s.add(f);
  }
  const limit = N <= 4 ? N : Math.max(min, Math.floor(N * maxFrac));
  let cands = [...sets.entries()].filter(([, s]) => s.size >= min && s.size <= limit);
  // identical file sets: keep the longest phrase ("golden retriever" over "golden" and "retriever")
  const bySig = new Map();
  for (const [k, s] of cands) {
    const sig = [...s].map((f) => files.indexOf(f)).sort((a, b) => a - b).join(',');
    const cur = bySig.get(sig);
    if (!cur || k.split(' ').length > cur[0].split(' ').length) bySig.set(sig, [k, s]);
  }
  cands = [...bySig.values()];
  // a pair is only useful when it is more than its first word (otherwise it splits a real group)
  cands = cands.filter(([k, s]) => !k.includes(' ') || !cands.some(([k2, s2]) => !k2.includes(' ') && k.split(' ').includes(k2) && s2.size > s.size && [...s].every((f) => s2.has(f)) && s2.size - s.size < Math.max(2, s.size * 0.25)));
  // how specific is a key: the share of its files that no other key claims
  const claims = new Map(files.map((f) => [f, 0]));
  for (const [, s] of cands) for (const f of s) claims.set(f, claims.get(f) + 1);
  const score = new Map();
  for (const [k, s] of cands) {
    let only = 0;
    for (const f of s) if (claims.get(f) === 1) only++;
    // overlap with other keys that are themselves specific means this key is a cross-cutting word ("puppy")
    let cross = 0;
    for (const [k2, s2] of cands) { if (k2 === k || k2.includes(k) || k.includes(k2)) continue; let o = 0; for (const f of s) if (s2.has(f)) o++; if (o) cross += o / s.size; }
    score.set(k, only / s.size - 0.35 * cross + 0.02 * Math.log2(s.size) + (k.includes(' ') ? 0.03 : 0));
  }
  const groups = new Map(), why = new Map(), rest = [];
  const assign = () => {
    groups.clear(); why.clear(); rest.length = 0;
    for (const f of files) {
      let best = null, bs = -Infinity;
      for (const [k, s] of cands) if (s.has(f)) { const sc = score.get(k); if (sc > bs || (sc === bs && s.size > sets.get(best)?.size)) { bs = sc; best = k; } }
      if (!best) { rest.push(f); continue; }
      if (!groups.has(best)) groups.set(best, []);
      groups.get(best).push(f);
      why.set(f, `“${best}” in the name`);
    }
  };
  assign();
  // groups that ended up too small give their files back; repeat until stable
  for (let i = 0; i < 4; i++) {
    const small = [...groups.entries()].filter(([, l]) => l.length < min).map(([k]) => k);
    if (!small.length) break;
    cands = cands.filter(([k]) => !small.includes(k));
    assign();
  }
  // keep the way people wrote it ("ProjectX", "NASA") when names are not all lowercase
  const orig = new Map();
  for (const f of files) for (const w of stemOf(f.name).replace(/([a-z])([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z\u00c0-\u024f]+/)) { if (w.length < 3) continue; const k = singular(w.toLowerCase()); if (w !== w.toLowerCase() && w !== w.toUpperCase() || (w === w.toUpperCase() && w.length <= 5)) { if (!orig.has(k)) orig.set(k, w.length > k.length && w.toLowerCase().startsWith(k) ? w.slice(0, k.length) : w); } }
  const label = (k) => k.split(' ').map((w) => { const o = orig.get(w); return o && o.toLowerCase() === w && o !== title(w) ? o : title(w); }).join(' ');
  const out = new Map();
  for (const [k, l] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) out.set(label(k), l);
  return { groups: out, rest, why };
}

/** Files whose names fit an existing subfolder ("poodle 3.jpg" -> "Poodles"). Returns Map(folderName -> items). */
export function matchExisting(files, folderNames) {
  const keys = folderNames.map((n) => {
    const ws = nameWords(n);
    return { n, ws, joined: ws.join('') };
  }).filter((k) => k.ws.length && k.joined.length >= 3);
  const out = new Map(), rest = [], why = new Map();
  for (const f of files) {
    const ws = new Set(nameWords(f.name));
    const sq = squash(f.name);
    let best = null, bl = 0;
    for (const k of keys) {
      const hit = k.ws.every((w) => ws.has(w)) || (k.joined.length >= 4 && sq.includes(k.joined));
      if (hit && k.joined.length > bl) { best = k; bl = k.joined.length; }
    }
    if (!best) { rest.push(f); continue; }
    if (!out.has(best.n)) out.set(best.n, []);
    out.get(best.n).push(f);
    why.set(f, `matches the “${best.n}” folder`);
  }
  return { groups: out, rest, why };
}

// ---------------- kind / date / size ----------------
export const KIND_FOLDERS = [
  ['Pictures', (e) => KINDS.image.includes(e)], ['Videos', (e) => KINDS.video.includes(e) || ['mkv', 'm2ts', 'ts'].includes(e)], ['Music', (e) => KINDS.audio.includes(e)],
  ['Documents', (e) => ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub', 'fdx', 'fountain'].includes(e)], ['Spreadsheets', (e) => ['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(e)],
  ['Presentations', (e) => ['ppt', 'pptx', 'key', 'odp'].includes(e)], ['Archives', (e) => KINDS.archive.includes(e)], ['Installers', (e) => ['exe', 'msi', 'msix', 'appx', 'dmg', 'apk', 'msixbundle'].includes(e)],
  ['Code', (e) => ['js', 'ts', 'py', 'cs', 'cpp', 'c', 'h', 'java', 'go', 'rs', 'json', 'html', 'css', 'sh', 'ps1', 'bat', 'xml', 'yml', 'yaml'].includes(e)],
  ['Fonts', (e) => ['ttf', 'otf', 'woff', 'woff2'].includes(e)], ['Design', (e) => ['psd', 'ai', 'fig', 'sketch', 'xd', 'svg', 'blend', 'indd'].includes(e)], ['3D', (e) => ['obj', 'fbx', 'stl', 'glb', 'gltf', '3mf', 'ply'].includes(e)], ['Torrents', (e) => e === 'torrent'],
];
export const kindFolder = (ext) => (KIND_FOLDERS.find(([, f]) => f((ext || '').toLowerCase())) || ['Other'])[0];
export function groupBy(files, keyFn) { const m = new Map(); for (const f of files) { const k = keyFn(f); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(f); } return m; }
export const monthFolder = (f) => { const d = new Date(f.mtime || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const yearFolder = (f) => String(new Date(f.mtime || Date.now()).getFullYear());
export const sizeFolder = (f) => { const s = f.size || 0; return s < 1048576 ? 'Small (under 1 MB)' : s < 104857600 ? 'Medium (1-100 MB)' : s < 1073741824 ? 'Large (100 MB-1 GB)' : 'Huge (over 1 GB)'; };

// ---------------- rules ----------------
// condition: { field: 'ext'|'kind'|'size'|'name'|'age'|'any', op, value }
export const SIZE_UNITS = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
export function testCondition(c, f) {
  const v = c.value;
  switch (c.field) {
    case 'any': return true;
    case 'ext': { const list = String(v || '').toLowerCase().split(/[\s,;]+/).map((x) => x.replace(/^\*?\./, '')).filter(Boolean); return list.includes((f.ext || '').toLowerCase()); }
    case 'kind': return kindFolder(f.ext) === v;
    case 'size': { const n = (+c.num || 0) * (SIZE_UNITS[c.unit || 'MB'] || 1); return c.op === '<' ? f.size < n : c.op === '>=' ? f.size >= n : c.op === '<=' ? f.size <= n : f.size > n; }
    case 'name': {
      const n = f.name.toLowerCase(), s = String(v || '').toLowerCase();
      if (c.op === 'starts') return n.startsWith(s);
      if (c.op === 'ends') return stemOf(n).endsWith(s);
      if (c.op === 'regex') { try { return new RegExp(v, 'i').test(f.name); } catch { return false; } }
      if (c.op === 'not') return !n.includes(s);
      return n.includes(s);
    }
    case 'age': { const days = (Date.now() - (f.mtime || 0)) / 86400000; return c.op === '<' ? days < +c.num : days > +c.num; }
    default: return false;
  }
}
export function ruleMatches(rule, f) {
  const cs = rule.conditions || [];
  if (!cs.length) return true;
  return rule.match === 'any' ? cs.some((c) => testCondition(c, f)) : cs.every((c) => testCondition(c, f));
}
export function describeCondition(c) {
  if (c.field === 'any') return 'any file';
  if (c.field === 'ext') return `extension is ${c.value}`;
  if (c.field === 'kind') return `it is in ${c.value}`;
  if (c.field === 'size') return `size ${c.op || '>'} ${c.num} ${c.unit || 'MB'}`;
  if (c.field === 'name') return `name ${{ starts: 'starts with', ends: 'ends with', regex: 'matches', not: 'does not contain' }[c.op] || 'contains'} “${c.value}”`;
  if (c.field === 'age') return `${c.op === '<' ? 'changed in the last' : 'not changed for'} ${c.num} days`;
  return '';
}
export function describeAction(a) {
  return { move: `move into “${a.target}”`, copy: `copy to “${a.target}”`, tag: `tag ${a.tag}`, recycle: 'move to the Recycle Bin', byKind: 'sort into folders by type', byName: 'sort into folders by name (topic)', byMonth: 'sort into month folders', byYear: 'sort into year folders', bySize: 'sort into size folders' }[a.type] || a.type;
}

/**
 * Plan what an automation does to some files. Returns [{ file, dest (folder name or absolute path), action, why }].
 * existingDirs: names of the subfolders already in the folder.
 */
export function planRules(rules, files, { existingDirs = [], folderName = '' } = {}) {
  const plan = [];
  let left = files.slice();
  for (const rule of rules.filter((r) => r.on !== false)) {
    const hit = left.filter((f) => ruleMatches(rule, f));
    if (!hit.length) continue;
    const a = rule.action || {};
    const take = (f, dest, why) => plan.push({ file: f, dest, action: a.type === 'copy' ? 'copy' : a.type === 'recycle' ? 'recycle' : a.type === 'tag' ? 'tag' : 'move', tag: a.tag, why: why || describeRule(rule) });
    if (a.type === 'byName') {
      const ex = matchExisting(hit, existingDirs);
      for (const [d, l] of ex.groups) for (const f of l) take(f, d, ex.why.get(f));
      const g = groupByName(ex.rest, { min: a.min || 2, folderName });
      for (const [d, l] of g.groups) for (const f of l) take(f, d, g.why.get(f));
      const done = new Set(plan.map((p) => p.file));
      left = left.filter((f) => !done.has(f));
      continue;
    }
    for (const f of hit) {
      if (a.type === 'byKind') take(f, kindFolder(f.ext), `it’s ${kindFolder(f.ext).toLowerCase()}`);
      else if (a.type === 'byMonth') take(f, monthFolder(f));
      else if (a.type === 'byYear') take(f, yearFolder(f));
      else if (a.type === 'bySize') take(f, sizeFolder(f));
      else take(f, a.target || '');
    }
    const done = new Set(hit);
    left = left.filter((f) => !done.has(f));
  }
  return plan;
}
export const describeRule = (r) => `If ${(r.conditions || []).length ? (r.conditions || []).map(describeCondition).join(r.match === 'any' ? ' or ' : ' and ') : 'any file'}, ${describeAction(r.action || {})}`;
