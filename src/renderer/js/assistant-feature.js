// Writing a small feature (.dogmod.js) from a description: "a right-click menu item that combines the selected
// .txt files into one master file". Common jobs get finished code; anything else gets a working outline with the
// right header, permissions and menu entry, and a TODO where the work goes. Pure: tested by test-assistant-files.mjs.

const header = ({ name, description, target = 'files', permissions = [] }) => `// @dogmod
// @name ${name}
// @description ${description}
// @target ${target}
// @permissions ${permissions.join(' ')}
// @version 1.0
`;
const extsIn = (s) => [...new Set([...s.matchAll(/(?:^|\s)\*?\.([a-z0-9]{1,8})\b/g)].map((m) => m[1]).filter((e) => !['dogmod', 'js'].includes(e)))];
const menuOrCommand = (s) => (/\bright[- ]click|context menu|menu item\b/.test(s) ? 'menu' : /\bcommand|palette|shortcut\b/.test(s) ? 'command' : 'both');

const RECIPES = [
  // combine / merge text files
  [/\b(combine|merge|join|concatenate|stitch|glue)\b.*\b(files?|texts?|notes?|logs?|\.txt|\.md|\.csv)\b/, (s) => {
    const exts = extsIn(s).length ? extsIn(s) : /\bmarkdown|\.md\b/.test(s) ? ['md'] : /\bcsv\b/.test(s) ? ['csv'] : ['txt'];
    const outName = (/\b(?:called|named|into)\s+["“']?([\w .-]+\.\w{1,6})/i.exec(s) || [])[1] || (/\bmaster\b/.test(s) ? 'Master' : 'Combined') + '.' + exts[0];
    const csv = exts.includes('csv');
    return {
      name: `Combine ${exts.map((e) => '.' + e).join(' / ')} files`,
      summary: `a right-click item, “Combine into ${outName}”, that joins the selected ${exts.map((e) => '.' + e).join(' / ')} files (in name order) into one new file next to them${csv ? ' (the header row only once)' : ', each one under a line with its name'}`,
      code: `${header({ name: `Combine ${exts.map((e) => '.' + e).join(' / ')} files`, description: `Joins the selected ${exts.map((e) => '.' + e).join(' / ')} files into one file, ${outName}, next to them`, permissions: ['read', 'write'] })}
const EXTS = ${JSON.stringify(exts)};
const OUT = ${JSON.stringify(outName)};

async function combine(selection) {
  const files = selection
    .filter((f) => !f.isDir && EXTS.includes(f.name.split('.').pop().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (files.length < 2) return dogfile.ui.toast('Select at least two ' + EXTS.map((e) => '.' + e).join(' / ') + ' files');
  const folder = files[0].path.replace(/[\\\\/][^\\\\/]*$/, '');
  const sep = folder.includes('\\\\') ? '\\\\' : '/';
  // don't overwrite: Combined.txt, Combined (2).txt, …
  let out = folder + sep + OUT, n = 2;
  while (await dogfile.files.stat(out)) out = folder + sep + OUT.replace(/(\\.[^.]+)$/, \` (\${n++})$1\`);
  const parts = [];
  for (const [i, f] of files.entries()) {
    const text = (await dogfile.files.readText(f.path)).replace(/\\s+$/, '');
${csv ? `    // CSV: keep the header row from the first file only
    parts.push(i === 0 ? text : text.split(/\\r?\\n/).slice(1).join('\\n'));` : `    parts.push(\`===== \${f.name} =====\\n\${text}\`);`}
  }
  await dogfile.files.writeText(out, parts.join('${csv ? '\\n' : '\\n\\n'}') + '\\n');
  dogfile.ui.toast(\`Combined \${files.length} files into \${out.split(/[\\\\/]/).pop()}\`);
  dogfile.refresh();
}

${menuOrCommand(s) !== 'command' ? `dogfile.addMenuItem({
  title: 'Combine into ' + OUT,
  when: { files: true, ext: EXTS },
  run: ({ selection }) => combine(selection),
});
` : ''}${menuOrCommand(s) !== 'menu' ? `dogfile.addCommand({
  id: 'combine-files',
  title: 'Combine the selected files into ' + OUT,
  run: async () => combine(await dogfile.selection()),
});
` : ''}`,
    };
  }],
  // count words / lines
  [/\b(counts?|counting|how many)\b.*\b(words?|lines?|characters?)\b/, (s) => ({
    name: 'Count words and lines', summary: 'a right-click item that counts the words, lines and characters in the selected text files',
    code: `${header({ name: 'Count words and lines', description: 'Counts words, lines and characters in the selected text files', permissions: ['read'] })}
dogfile.addMenuItem({
  title: 'Count words and lines',
  when: { files: true },
  run: async ({ selection }) => {
    let words = 0, lines = 0, chars = 0, n = 0;
    for (const f of selection) {
      if (f.isDir) continue;
      try { const t = await dogfile.files.readText(f.path); words += (t.match(/\\S+/g) || []).length; lines += t.split('\\n').length; chars += t.length; n++; } catch { /* not a text file */ }
    }
    dogfile.ui.showText('Count', \`\${n} file(s)\\n\${words.toLocaleString()} words\\n\${lines.toLocaleString()} lines\\n\${chars.toLocaleString()} characters\`);
  },
});
`,
  })],
  // list of names / paths to the clipboard or a file
  [/\b(list|copy|export)\b.*\b(names?|paths?)\b/, (s) => ({
    name: 'List the selected names', summary: 'a right-click item that copies the names (or full paths) of the selected items, one per line',
    code: `${header({ name: 'List the selected names', description: 'Copies the names or full paths of the selected items to the clipboard, one per line', permissions: [] })}
dogfile.addMenuItem({
  title: 'Copy the names as a list',
  when: { files: true },
  run: async ({ selection }) => {
    const how = await dogfile.ui.choose('Copy what?', ['Names', 'Full paths']);
    if (!how) return;
    await dogfile.clipboard.writeText(selection.map((f) => (how === 'Names' ? f.name : f.path)).join('\\n'));
    dogfile.ui.toast(\`Copied \${selection.length} \${how.toLowerCase()}\`);
  },
});
`,
  })],
  // date in the name
  [/\b(date|today)\b.*\b(name|prefix|suffix|rename)\b|\brename\b.*\bdate\b/, (s) => ({
    name: 'Add the date to the name', summary: `a right-click item that adds today’s date ${/\bsuffix|end\b/.test(s) ? 'to the end of' : 'to the start of'} the selected names`,
    code: `${header({ name: 'Add the date to the name', description: 'Adds today’s date to the names of the selected files', permissions: ['write'] })}
dogfile.addMenuItem({
  title: 'Add today’s date to the name',
  when: { files: true },
  run: async ({ selection }) => {
    const d = new Date().toISOString().slice(0, 10);
    for (const f of selection) await dogfile.files.rename(f.path, f.path.replace(/([^\\\\/]+?)(\\.[^.\\\\/]*)?$/, ${/\bsuffix|end\b/.test(s) ? '`$1 ${d}$2`' : '`${d} $1$2`'}));
    dogfile.refresh();
  },
});
`,
  })],
];

export function featureFromRequest(text) {
  const raw = String(text || '');
  const s = raw.toLowerCase();
  for (const [re, make] of RECIPES) if (re.test(s)) return { known: true, ...make(s, raw) };
  // anything else: a working outline
  const what = raw.replace(/^.*?\b(?:that|which|to)\s+(?:adds?\s+(?:a\s+)?(?:right-click\s+)?(?:menu\s+item\s+)?(?:to|that|which)?\s*)?/i, '').replace(/[.?!]+$/, '').trim() || 'does something with the selected files';
  const title = what.charAt(0).toUpperCase() + what.slice(1, 60);
  const w = what.toLowerCase();
  const perms = [/\b(read\w*|open\w*|look\w*|count\w*|find\w*|search\w*|combin\w*|merg\w*|upload\w*|send\w*|check\w*)\b/.test(w) && 'read', /\b(writ\w*|sav\w*|renam\w*|mov\w*|cop\w*|delet\w*|creat\w*|combin\w*|merg\w*|sort\w*|organi[sz]\w*)\b/.test(w) && 'write', /\b(internet|web\w*|download\w*|upload\w*|fetch\w*|api|url|online|server)\b/.test(w) && 'network'].filter(Boolean);
  return {
    known: false, name: title.slice(0, 40), summary: `a right-click item and a command called “${title}”`,
    code: `${header({ name: title.slice(0, 40), description: what, permissions: perms })}
// What you asked for: ${raw.replace(/\n/g, ' ')}
async function run(selection) {
  // TODO: the work goes here. Handy calls:
  //   await dogfile.files.list(folder)        → [{ name, path, isDir, size, mtime }]
  //   await dogfile.files.readText(path)      / await dogfile.files.writeText(path, text)
  //   await dogfile.files.rename(from, to)    / dogfile.files.copy(paths, folder) / dogfile.files.move(paths, folder)
  //   await dogfile.net.fetch(url)            (needs "network" in @permissions)
  //   dogfile.ui.toast('Done')                / await dogfile.ui.prompt('Question', 'Label', 'default')
  dogfile.ui.toast(\`\${selection.length} item(s) selected\`);
  dogfile.refresh();
}

dogfile.addMenuItem({ title: ${JSON.stringify(title)}, when: { files: true }, run: ({ selection }) => run(selection) });
dogfile.addCommand({ id: 'my-feature', title: ${JSON.stringify(title)}, run: async () => run(await dogfile.selection()) });
`,
  };
}
