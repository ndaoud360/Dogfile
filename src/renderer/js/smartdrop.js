// Smart drop: look at what was dropped and where, and suggest the most useful action (extract archives, sort
// with the folder's automation, put files into subfolders whose names match, sort a mixed pile by type…).
// With nothing special to suggest, the drop just happens as usual (Settings > Files > Smart drop).
import { api, state, h, toast, basename, dirname, pjoin, KINDS, extname, saveSettings } from './core.js';
import { showMenu } from './menu.js';
import * as A from './actions.js';

export async function smartDrop(paths, dir, move, x, y) {
  const mode = state.settings.smartDrop || 'smart';
  const verb = move ? 'Move' : 'Copy';
  const names = paths.map((p) => basename(p));
  const exts = names.map((n) => extname(n));
  const sugg = [];
  const files = paths.map((p, i) => ({ path: p, name: names[i], ext: exts[i], size: 0, mtime: Date.now() }));
  // archives → extract
  const arcs = paths.filter((p, i) => KINDS.archive.includes(exts[i]) && !/\.(exe|msi)$/i.test(p));
  if (arcs.length && arcs.length === paths.length) {
    sugg.push({ label: arcs.length === 1 ? `Extract “${basename(arcs[0])}” here` : `Extract ${arcs.length} archives here`, icon: 'extract', why: 'archive', run: () => A.runJob({ type: 'extract', sources: arcs, dest: dir, opts: { smart: true } }) });
    sugg.push({ label: arcs.length === 1 ? `Extract to a folder “${basename(arcs[0]).replace(/\.(tar\.)?[^.]+$/, '')}”` : 'Extract each to its own folder', icon: 'folderOpen', run: () => A.runJob({ type: 'extract', sources: arcs, dest: dir, opts: { smart: false, toFolder: true } }) });
  }
  // the folder has an automation → move in and let it sort
  const auto = (state.settings.automations || []).find((a) => a.folder === dir && a.on !== false);
  let r = null;
  if (auto?.rules?.length) {
    const { planRules } = await import('./organize.js');
    r = r || await api('fs:list', dir).catch(() => null);
    const plan = planRules(auto.rules, files, { existingDirs: (r?.items || []).filter((i) => i.isDir).map((i) => i.name), folderName: basename(dir) });
    if (plan.length) sugg.push({ label: `${verb} and sort with this folder’s rules (${plan.length})`, icon: 'automation', why: 'rules', run: async () => { const j = await A.transfer(paths, dir, move ? 'move' : 'copy'); if (j?.status === 'done') { const { execute } = await import('./rules.js'); const moved = plan.map((p) => ({ ...p, file: { ...p.file, path: pjoin(dir, p.file.name) } })); await execute(dir, moved); } } });
  }
  // subfolders whose names match the files (poodle_3.jpg → Poodles)
  r = r || await api('fs:list', dir).catch(() => null);
  const sub = (r?.items || []).filter((i) => i.isDir).map((i) => i.name);
  if (sub.length && paths.length) {
    const { matchExisting } = await import('./organize.js');
    const m = matchExisting(files, sub);
    const n = [...m.groups.values()].reduce((a, l) => a + l.length, 0);
    if (n) sugg.push({ label: `${verb} into matching folders (${[...m.groups.keys()].slice(0, 3).join(', ')}${m.groups.size > 3 ? '…' : ''})`, icon: 'folder', why: 'match', run: async () => {
      for (const [d, l] of m.groups) await A.transfer(l.map((f) => f.path), pjoin(dir, d), move ? 'move' : 'copy');
      if (m.rest.length) await A.transfer(m.rest.map((f) => f.path), dir, move ? 'move' : 'copy');
    } });
  }
  // a mixed pile of many files → sort by type
  const kinds = new Set(files.map((f) => (KINDS.image.includes(f.ext) ? 'p' : KINDS.video.includes(f.ext) ? 'v' : KINDS.audio.includes(f.ext) ? 'a' : f.ext)));
  if (paths.length >= 8 && kinds.size >= 3) sugg.push({ label: `${verb} and sort into folders by type`, icon: 'wand', why: 'mixed', run: async () => {
    const { kindFolder } = await import('./organize.js');
    const g = new Map(); for (const f of files) { const k = kindFolder(f.ext); if (!g.has(k)) g.set(k, []); g.get(k).push(f.path); }
    for (const [k, l] of g) { const d = pjoin(dir, k); if (!(await api('fs:stat', d))) await api('fs:mkdir', d); await A.transfer(l, d, move ? 'move' : 'copy'); }
  } });
  // pictures dropped on a folder of pictures from another drive: copying is safer
  if (!sugg.length && mode !== 'ask') return false;
  const usual = { label: `${verb} here`, icon: move ? 'cut' : 'copy', keys: 'usual', run: () => A.transfer(paths, dir, move ? 'move' : 'copy') };
  const other = { label: `${move ? 'Copy' : 'Move'} here instead`, icon: move ? 'copy' : 'cut', run: () => A.transfer(paths, dir, move ? 'copy' : 'move') };
  const items = [
    { header: `${paths.length} item${paths.length === 1 ? '' : 's'} → ${basename(dir) || dir}` },
    ...sugg.map((s0, i) => ({ ...s0, keys: i === 0 ? 'suggested' : undefined })),
    { separator: true }, usual, other,
    { label: 'Compress here (zip)', icon: 'zip', run: () => A.compressTo(paths, dir) },
    { separator: true },
    { label: mode === 'ask' ? 'Only ask when there’s a suggestion' : 'Don’t suggest, just move or copy', icon: 'settings', run: () => { state.settings.smartDrop = mode === 'ask' ? 'smart' : 'off'; saveSettings(); toast(state.settings.smartDrop === 'off' ? 'Smart drop is off (Settings > Files to turn it back on)' : 'Smart drop will only ask when it has a suggestion'); usual.run(); } },
  ];
  showMenu(items, x, y);
  return true;
}
