// The assistant's language model (backend/src/llm.rs): what it's told about the moment (the folder, the selection,
// what's in the folder, the app in this tab, the last result) and how its steps become Dogfile actions. The model
// only decides what the user wants; Dogfile's own parsers and executors (assistant-parse.js, assistant.js,
// assistant-actions.js) do the work, file names are checked against the real folder, and anything that changes
// files shows a preview and waits for the user.
import { api, state, isVirtual, basename } from './core.js';

const PLACES = { here: 'in this folder', downloads: 'in my downloads', desktop: 'on my desktop', documents: 'in my documents', pictures: 'in my pictures', photos: 'in my pictures', videos: 'in my videos', music: 'in my music', everywhere: 'everywhere', 'this pc': 'everywhere', computer: 'everywhere' };
const APP_LABEL = { editor: 'Notepad', viewer: 'Photos', player: 'Player' };

/** is the model downloaded (and not turned off)? */
export async function brainStatus() {
  try { return await api('llm:status'); } catch { return null; }
}
export const brainOn = (s) => !!s?.available && state.settings.assistantBrain !== false;

/** the few lines the model reads before the request */
export function contextFor({ t, sel, appT, last, pendingAsk }, text) {
  const lines = [];
  const p = t?.path;
  lines.push(`Folder: ${p && !isVirtual(p) ? p : p === 'atlas:home' ? 'Home' : p === 'atlas:thispc' ? 'This PC' : p || 'Home'}`);
  if (sel?.length) lines.push(`Selected: ${sel.slice(0, 15).map((i) => i.name + (i.isDir ? ' (folder)' : '')).join(', ')}${sel.length > 15 ? ` (+${sel.length - 15} more)` : ''}`);
  // what's here: names the request mentions first, so they make the cut in big folders
  const items = (t?.items || []).filter((i) => !i.virtual);
  if (items.length && p && !isVirtual(p)) {
    const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const score = (i) => words.reduce((a, w) => a + (i.name.toLowerCase().includes(w) ? 1 : 0), 0);
    // the names the request mentions, and a handful of others for a sense of the folder: every name costs reading time
    const ranked = [...items].map((i) => [i, score(i)]).sort((a, b) => b[1] - a[1]);
    const hits = ranked.filter(([, sc]) => sc > 0).slice(0, 20).map(([i]) => i);
    const shown = [...hits, ...ranked.filter(([, sc]) => sc === 0).slice(0, Math.max(6, 20 - hits.length)).map(([i]) => i)];
    lines.push(`In this folder: ${shown.map((i) => i.name + (i.isDir ? ' (folder)' : '')).join(', ')}${items.length > shown.length ? ` (+${items.length - shown.length} more)` : ''}`);
  }
  if (appT?.app) lines.push(`Open in this tab: ${APP_LABEL[appT.app] || appT.app}${appT.appPath ? `, ${appT.app === 'editor' ? 'editing' : appT.app === 'player' ? 'playing' : 'showing'} ${basename(appT.appPath)}` : ''}`);
  if (last?.items?.length) lines.push(`Previous result: ${last.items.length} item${last.items.length === 1 ? '' : 's'}${last.items.length <= 8 ? ` (${last.items.map((i) => i.name).join(', ')})` : ''}`);
  if (pendingAsk) lines.push(`Earlier request: ${pendingAsk.request}\nYou asked: ${pendingAsk.question}`);
  lines.push(`Request: ${String(text).trim()}`);
  return lines.join('\n');
}

/** ask the model; { steps, ms } or { error } */
export async function understand(context) {
  try {
    const r = await api('llm:plan', context);
    const steps = Array.isArray(r?.plan?.steps) ? r.plan.steps : null;
    if (!steps?.length) return { error: 'no steps' };
    return { steps, ms: r.ms };
  } catch (e) { return { error: String(e?.message || e) }; }
}

/** match the names the model gave against what's selected, in this folder, or in the last result */
export function resolveNames(names, pools) {
  const all = pools.flat().filter(Boolean);
  const found = [], missing = [];
  for (const raw of names || []) {
    const n = String(raw).trim().toLowerCase();
    if (!n) continue;
    const stem = (s) => s.replace(/\.[^.]+$/, '');
    const hit = all.find((i) => i.name.toLowerCase() === n)
      || all.find((i) => stem(i.name.toLowerCase()) === n)
      || all.find((i) => stem(i.name.toLowerCase()) === stem(n))
      || (() => { const c = all.filter((i) => i.name.toLowerCase().startsWith(n)); return c.length === 1 ? c[0] : null; })();
    if (hit && !found.includes(hit)) found.push(hit); else if (!hit) missing.push(String(raw).trim());
  }
  return { found, missing };
}

const VERB = { find: 'find', select: 'find', open: 'open', move: 'move', copy: 'copy', delete: 'delete', zip: 'zip', rename: 'rename', tag: 'tag', group: 'organize', shelf: 'put on the drop shelf', count: 'how many', size: 'how much space do' };
const isPath = (s) => /^([a-z]:[\\/]?|\\\\|\/|~[\\/])/i.test(String(s || '').trim());

/** a files step as a sentence for Dogfile's request parser (which reads filters, dates, sizes, places…),
 *  plus what the parsed plan must be forced to (the model's understanding wins over the parser's guesses) */
export function sentenceFor(step, { onSelection }) {
  const a = step.action;
  const what = String(step.what || '').trim();
  const where = String(step.where || '').trim();
  const to = String(step.to || '').trim();
  const parts = [VERB[a] || 'find'];
  if (onSelection) parts.push(a === 'count' || a === 'size' ? 'of these' : 'these');
  if (what) parts.push(what);
  if (a === 'size') parts.push('take');
  let folder = null;
  if (!onSelection && where) {
    const k = where.toLowerCase().replace(/^(my|the)\s+/, '').replace(/\s+folder$/, '');
    if (PLACES[k]) parts.push(PLACES[k]);
    else if (isPath(where)) folder = where;
    else if (!['selection', 'previous'].includes(k)) parts.push(`in my ${where} folder`);
  }
  if ((a === 'move' || a === 'copy') && to) parts.push(`to ${to}`);
  if (a === 'zip' && to) parts.push(`as ${/\.(zip|7z|tar|tgz|tar\.gz)$/i.test(to) ? to : to + '.zip'}`);
  if (a === 'group' && to) parts.push(/^own/i.test(to) ? 'into their own folders' : `by ${to}`);
  if (a === 'rename' && to) parts.push(to);
  if (a === 'tag' && to) parts.push(to.split(/\s*(?:,|\band\b)\s*/).map((x) => (/^(red|orange|yellow|green|blue|purple|gr[ae]y)$/i.test(x) ? x : `"${x}"`)).join(' and '));
  return { sentence: parts.join(' ').replace(/\s+/g, ' ').trim(), folder };
}

/** one line saying what a step will do, for the step list */
export function describeStep(s) {
  const q = (x) => `“${x}”`;
  switch (s.do) {
    case 'files': {
      const verb = { find: 'Find', select: 'Select', open: 'Open', move: 'Move', copy: 'Copy', delete: 'Recycle', zip: 'Zip', rename: 'Rename', tag: 'Tag', group: 'Sort into folders', shelf: 'Put on the Drop Shelf', count: 'Count', size: 'Measure', new_folder: 'New folder' }[s.action] || 'Files';
      const obj = s.action === 'new_folder' ? q(s.to || 'New folder') : s.names?.length ? s.names.map(q).join(', ') : s.what || (s.where === 'previous' ? 'those' : s.where === 'selection' ? 'the selection' : 'files');
      const tail = s.action === 'move' || s.action === 'copy' ? (s.to ? ` → ${s.to}` : '') : s.action === 'zip' && s.to ? ` as ${s.to}` : s.action === 'tag' && s.to ? ` ${s.to}` : s.action === 'rename' && s.to ? `: ${s.to}` : '';
      return `${verb} ${obj}${tail}`;
    }
    case 'feature': return `${s.id}${s.detail ? `: ${s.detail}` : ''}`;
    case 'go': return `Go to ${s.place}`;
    case 'app': return s.request;
    case 'write': return `Write ${s.request}`;
    case 'help': return s.question;
    case 'ask': return 'A question';
    default: return s.text || '';
  }
}
