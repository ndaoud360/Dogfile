// The feature API, described once. Used by the API reference panel and the autocomplete / hover hints in Atlas
// Notepad, by the plain-language error messages, by the install check ("your code uses X but doesn't ask for Y"),
// and by build/make-feature-docs.mjs, which writes FEATURES.md from this file so the guide never drifts.
// API version 1: functions here are never renamed or removed; new ones may be added.

export const API_VERSION = 1;

export const PERM_NAMES = { read: 'Read files', write: 'Change files', network: 'Use the internet', run: 'Run commands' };

// where: which apps the call works in ('all' or a list of targets: files, notepad, photos, player)
export const SECTIONS = [
  { id: 'basics', title: 'Adding your tools', intro: 'Every feature starts by adding at least one command. Commands appear in the command palette and the Features menu of the app the feature is made for; with toolbar: true they also get a toolbar button (Notepad, Photos, Player).', items: [
    { name: 'atlas.addCommand', sig: 'atlas.addCommand({ id, title, run, icon?, keys?, toolbar? })', returns: 'nothing', where: 'all',
      desc: 'Adds a command. run(context) is called when the person picks it. In the file browser, context is { selection, folder }; in Notepad, { fileName }.',
      params: [['id', 'Short unique name inside your feature, like "count-words"'], ['title', 'What people see in menus'], ['run', 'async function (context) { … }'], ['icon', 'Optional Atlas icon name, e.g. "star", "image", "code"'], ['keys', 'Optional shortcut, e.g. "Ctrl+Alt+W" (file browser)'], ['toolbar', 'true to add a toolbar button (Notepad, Photos, Player)']],
      example: `atlas.addCommand({\n  id: 'hello',\n  title: 'Say hello',\n  run: async () => atlas.ui.toast('Hello!'),\n});` },
    { name: 'atlas.addMenuItem', sig: 'atlas.addMenuItem({ title, run, when?, icon? })', returns: 'nothing', where: ['files'],
      desc: 'Adds an item to the right-click menu of files and folders. run({ selection, folder }) gets the right-clicked items.',
      params: [['title', 'What people see in the menu'], ['run', 'async function ({ selection, folder }) { … }'], ['when', 'Optional: { files: true } only files, { folders: true } only folders, { ext: ["jpg","png"] } only these types, { single: true } only one item']],
      example: `atlas.addMenuItem({\n  title: 'Copy name',\n  when: { single: true },\n  run: async ({ selection }) => atlas.ui.showText('Name', selection[0].name),\n});` },
    { name: 'atlas.log', sig: 'atlas.log(...values)', returns: 'nothing', where: 'all',
      desc: 'Writes to the feature log (Notepad > Features > API reference > Log). console.log does the same.',
      example: `atlas.log('selected', await atlas.selection());` },
    { name: 'atlas.version', sig: 'atlas.version', returns: 'number', where: 'all', desc: 'The feature API version (1). Atlas never breaks version 1 features.', example: `if (atlas.version >= 1) atlas.log('ok');` },
  ] },
  { id: 'ui', title: 'Talking to the person', intro: 'Messages and questions. They work everywhere and need no permission.', items: [
    { name: 'atlas.ui.toast', sig: 'atlas.ui.toast(text)', returns: 'Promise', where: 'all', desc: 'Shows a short message at the bottom of the window.', example: `atlas.ui.toast('Done');` },
    { name: 'atlas.ui.prompt', sig: 'atlas.ui.prompt(title, label?, value?)', returns: 'Promise<string | null>', where: 'all', desc: 'Asks for a line of text. Gives null if the person cancels.', example: `const name = await atlas.ui.prompt('New name', 'Name', 'Untitled');\nif (name == null) return;` },
    { name: 'atlas.ui.confirm', sig: 'atlas.ui.confirm(title, message)', returns: 'Promise<boolean>', where: 'all', desc: 'Asks a yes/no question.', example: `if (!(await atlas.ui.confirm('Rename 12 files?', 'This adds the date to each name.'))) return;` },
    { name: 'atlas.ui.choose', sig: 'atlas.ui.choose(title, options)', returns: 'Promise<string | null>', where: 'all', desc: 'Lets the person pick one of a few buttons. Gives the chosen text, or null.', example: `const size = await atlas.ui.choose('Size', ['Small', 'Medium', 'Large']);` },
    { name: 'atlas.clipboard.writeText', sig: 'atlas.clipboard.writeText(text)', returns: 'Promise', where: 'all', desc: 'Puts text on the clipboard. Features can’t read the clipboard.', example: `await atlas.clipboard.writeText(paths.join('\\n'));\natlas.ui.toast('Copied');` },
    { name: 'atlas.ui.showText', sig: 'atlas.ui.showText(title, text)', returns: 'Promise', where: 'all', desc: 'Shows longer text in a window the person can read and copy.', example: `atlas.ui.showText('Report', lines.join('\\n'));` },
  ] },
  { id: 'ctx', title: 'Where the person is (file browser)', intro: 'For features made for the file browser (@target files). Items are { path, name, ext, isDir, size, mtime }.', items: [
    { name: 'atlas.selection', sig: 'atlas.selection()', returns: 'Promise<Item[]>', where: ['files'], desc: 'The selected files and folders in the active pane.', example: `const files = (await atlas.selection()).filter((f) => !f.isDir);` },
    { name: 'atlas.folder', sig: 'atlas.folder()', returns: 'Promise<string>', where: ['files'], desc: 'The folder open in the active pane.', example: `const here = await atlas.folder();` },
    { name: 'atlas.navigate', sig: 'atlas.navigate(path)', returns: 'Promise', where: ['files'], desc: 'Opens a folder in the active pane.', example: `atlas.navigate('C:\\\\Users\\\\Public');` },
    { name: 'atlas.refresh', sig: 'atlas.refresh()', returns: 'Promise', where: ['files'], desc: 'Reloads the active pane, e.g. after renaming files.', example: `await atlas.refresh();` },
  ] },
  { id: 'files', title: 'Files', intro: 'Reading needs the read permission; anything that changes files needs write. Ask for them in the header: // @permissions read write', items: [
    { name: 'atlas.files.list', sig: 'atlas.files.list(folder)', returns: 'Promise<Item[]>', perm: 'read', where: 'all', desc: 'What is inside a folder.', example: `const items = await atlas.files.list(await atlas.folder());` },
    { name: 'atlas.files.stat', sig: 'atlas.files.stat(path)', returns: 'Promise<{ isDir, size, mtime, ctime, atime } | null>', perm: 'read', where: 'all', desc: 'Size and dates of a file or folder, or null if it doesn’t exist.', example: `const st = await atlas.files.stat(path);\nif (!st) atlas.ui.toast('Not found');` },
    { name: 'atlas.files.readText', sig: 'atlas.files.readText(path)', returns: 'Promise<string>', perm: 'read', where: 'all', desc: 'Reads a text file (up to 20 MB). Fails for pictures, music and other non-text files.', example: `const text = await atlas.files.readText(file.path);` },
    { name: 'atlas.files.writeText', sig: 'atlas.files.writeText(path, text)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Creates or replaces a text file (UTF-8).', example: `await atlas.files.writeText(folder + '\\\\notes.txt', 'Hello');` },
    { name: 'atlas.files.rename', sig: 'atlas.files.rename(fromPath, toPath)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Renames (or moves within a drive). toPath is the full new path.', example: `await atlas.files.rename(f.path, f.path.replace(/\\.jpeg$/i, '.jpg'));` },
    { name: 'atlas.files.copy', sig: 'atlas.files.copy(paths, destFolder)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Copies files into a folder using the operations queue (progress, conflicts, undo).', example: `await atlas.files.copy(files.map((f) => f.path), 'D:\\\\Backup');` },
    { name: 'atlas.files.move', sig: 'atlas.files.move(paths, destFolder)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Moves files into a folder using the operations queue.', example: `await atlas.files.move(paths, here + '\\\\Old');` },
    { name: 'atlas.files.mkdir', sig: 'atlas.files.mkdir(path)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Creates a folder.', example: `await atlas.files.mkdir(here + '\\\\Sorted');` },
    { name: 'atlas.files.trash', sig: 'atlas.files.trash(paths)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Sends files to the Recycle Bin (never deletes for good).', example: `await atlas.files.trash([file.path]);` },
    { name: 'atlas.files.open', sig: 'atlas.files.open(path)', returns: 'Promise', where: 'all', desc: 'Opens a file the way double-clicking would. Needs no permission.', example: `atlas.files.open(file.path);` },
  ] },
  { id: 'editor', title: 'Atlas Notepad', intro: 'For features made for Notepad (@target notepad). They work on the open document.', items: [
    { name: 'atlas.editor.getText', sig: 'atlas.editor.getText()', returns: 'Promise<string>', where: ['notepad'], desc: 'The whole document.', example: `const text = await atlas.editor.getText();` },
    { name: 'atlas.editor.setText', sig: 'atlas.editor.setText(text)', returns: 'Promise', where: ['notepad'], desc: 'Replaces the whole document (Ctrl+Z undoes it).', example: `await atlas.editor.setText(text.toUpperCase());` },
    { name: 'atlas.editor.getSelection', sig: 'atlas.editor.getSelection()', returns: 'Promise<string>', where: ['notepad'], desc: 'The selected text ("" if nothing is selected).', example: `const sel = await atlas.editor.getSelection();` },
    { name: 'atlas.editor.replaceSelection', sig: 'atlas.editor.replaceSelection(text)', returns: 'Promise', where: ['notepad'], desc: 'Replaces the selected text.', example: `await atlas.editor.replaceSelection(sel.trim());` },
    { name: 'atlas.editor.insert', sig: 'atlas.editor.insert(text)', returns: 'Promise', where: ['notepad'], desc: 'Inserts text at the cursor.', example: `await atlas.editor.insert(new Date().toLocaleString());` },
    { name: 'atlas.editor.fileName', sig: 'atlas.editor.fileName()', returns: 'Promise<string>', where: ['notepad'], desc: 'The document’s path (or its name if it isn’t saved yet).', example: `const name = await atlas.editor.fileName();` },
    { name: 'atlas.editor.getLanguage', sig: 'atlas.editor.getLanguage()', returns: 'Promise<string>', where: ['notepad'], desc: 'The document’s language id, e.g. "javascript", "markdown", "text".', example: `if ((await atlas.editor.getLanguage()) !== 'markdown') return;` },
    { name: 'atlas.editor.setLanguage', sig: 'atlas.editor.setLanguage(id)', returns: 'Promise', where: ['notepad'], desc: 'Changes the highlighting language.', example: `atlas.editor.setLanguage('json');` },
  ] },
  { id: 'photos', title: 'Atlas Photos', intro: 'For features made for the photo editor (@target photos). Pixels are { width, height, data } where data holds 4 numbers per pixel: red, green, blue, alpha (0–255).', items: [
    { name: 'atlas.photos.getImageData', sig: 'atlas.photos.getImageData()', returns: 'Promise<{ width, height, data }>', where: ['photos'], desc: 'The picture’s pixels (opens edit mode if needed).', example: `const img = await atlas.photos.getImageData();` },
    { name: 'atlas.photos.putImageData', sig: 'atlas.photos.putImageData(img)', returns: 'Promise', where: ['photos'], desc: 'Puts changed pixels back (undo works). Save as usual afterwards.', example: `await atlas.photos.putImageData(img);` },
    { name: 'atlas.photos.fileName', sig: 'atlas.photos.fileName()', returns: 'Promise<string>', where: ['photos'], desc: 'The picture’s path.', example: `const p = await atlas.photos.fileName();` },
  ] },
  { id: 'player', title: 'Atlas Player', intro: 'For features made for the player (@target player). Times are in seconds.', items: [
    { name: 'atlas.player.currentFile', sig: 'atlas.player.currentFile()', returns: 'Promise<string>', where: ['player'], desc: 'The path of what is playing.', example: `const p = await atlas.player.currentFile();` },
    { name: 'atlas.player.play', sig: 'atlas.player.play()', returns: 'Promise', where: ['player'], desc: 'Plays.', example: `atlas.player.play();` },
    { name: 'atlas.player.pause', sig: 'atlas.player.pause()', returns: 'Promise', where: ['player'], desc: 'Pauses.', example: `atlas.player.pause();` },
    { name: 'atlas.player.seek', sig: 'atlas.player.seek(seconds)', returns: 'Promise', where: ['player'], desc: 'Jumps to a time.', example: `atlas.player.seek(90);` },
    { name: 'atlas.player.time', sig: 'atlas.player.time()', returns: 'Promise<number>', where: ['player'], desc: 'The current time.', example: `const t = await atlas.player.time();` },
    { name: 'atlas.player.duration', sig: 'atlas.player.duration()', returns: 'Promise<number>', where: ['player'], desc: 'How long the file is.', example: `const d = await atlas.player.duration();` },
  ] },
  { id: 'net', title: 'Internet', intro: 'Features can’t reach the internet directly; they ask Atlas, which needs the network permission.', items: [
    { name: 'atlas.net.fetch', sig: 'atlas.net.fetch(url, { method?, headers?, body? })', returns: 'Promise<{ status, ok, text, headers }>', perm: 'network', where: 'all',
      desc: 'Downloads from a web address (http/https, up to 5 MB, 30 s). Unlike the browser’s fetch it gives back text: use JSON.parse(r.text) for JSON.', example: `const r = await atlas.net.fetch('https://api.github.com/zen');\nif (r.ok) atlas.ui.toast(r.text);` },
  ] },
  { id: 'run', title: 'Running commands', intro: 'Needs the run permission. In the file browser the command runs in the built-in terminal so the person sees it; elsewhere it starts in the background.', items: [
    { name: 'atlas.run', sig: 'atlas.run(command, folder?)', returns: 'Promise', perm: 'run', where: 'all', desc: 'Runs a command line, optionally in a folder.', example: `atlas.run('git status', await atlas.folder());` },
  ] },
  { id: 'storage', title: 'Remembering things', intro: 'A small private store for each feature (settings, last used values). Survives restarts.', items: [
    { name: 'atlas.storage.get', sig: 'atlas.storage.get(key)', returns: 'Promise<any>', where: 'all', desc: 'Reads a value you saved, or null.', example: `const last = (await atlas.storage.get('lastName')) || 'Untitled';` },
    { name: 'atlas.storage.set', sig: 'atlas.storage.set(key, value)', returns: 'Promise', where: 'all', desc: 'Saves a value (anything JSON can hold).', example: `await atlas.storage.set('lastName', name);` },
  ] },
];

export const HEADER = [
  ['@atlas-feature', 'Marks the file as a feature (first line)'],
  ['@name', 'The feature’s name, shown in menus and the feature browser'],
  ['@description', 'One sentence about what it does'],
  ['@target', 'Where it runs: files, notepad, photos or player'],
  ['@permissions', 'Any of: read write network run (leave empty for none)'],
  ['@version', 'Your version number, e.g. 1.0 (raise it when you update)'],
  ['@author', 'Your name (optional)'],
  ['@icon', 'An Atlas icon name for its button (optional)'],
];

export const ALL = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.id })));
export const BY_NAME = new Map(ALL.map((i) => [i.name, i]));
const shortName = (n) => n.replace(/^atlas\./, '');
export const method = (n) => BY_NAME.get('atlas.' + n);

// members of "atlas", "atlas.files", … for autocomplete
export function membersOf(prefix) {
  const out = new Map();
  const p = prefix ? prefix + '.' : 'atlas.';
  for (const i of ALL) {
    if (!i.name.startsWith(p)) continue;
    const rest = i.name.slice(p.length);
    const head = rest.split('.')[0];
    if (rest.includes('.')) { if (!out.has(head)) out.set(head, { label: head, type: 'namespace', detail: SECTIONS.find((s) => s.items.some((x) => x.name.startsWith(p + head + '.')))?.title || '' }); }
    else out.set(head, { label: head, type: i.sig.includes('(') ? 'function' : 'property', item: i });
  }
  return [...out.values()];
}

// permissions the code uses (from atlas.* calls) — for the install check
export function permsUsed(code) {
  const used = new Map();
  for (const m of String(code).matchAll(/\batlas\.([\w.]+)\s*\(/g)) {
    const it = BY_NAME.get('atlas.' + m[1]);
    if (it?.perm && !used.has(it.perm)) used.set(it.perm, it.name);
  }
  return used; // perm -> first function that needs it
}
// calls the code makes that don't exist or don't work in this target
export function problems(code, target) {
  const out = [];
  const seen = new Set();
  for (const m of String(code).matchAll(/\batlas\.([\w.]+)\s*\(/g)) {
    const n = 'atlas.' + m[1];
    if (seen.has(n)) continue; seen.add(n);
    const it = BY_NAME.get(n);
    if (!it) out.push({ name: n, text: `${n} doesn’t exist${suggest(n) ? ` — did you mean ${suggest(n)}?` : ''}` });
    else if (it.where !== 'all' && target && !it.where.includes(target)) out.push({ name: n, text: `${n} only works in ${it.where.map((w) => ({ files: 'the file browser', notepad: 'Notepad', photos: 'Photos', player: 'Player' }[w])).join(', ')}, but this feature’s @target is ${target}` });
  }
  return out;
}
export function suggest(n) {
  const parts = n.split('.');
  const last = parts.pop().toLowerCase();
  const pool = ALL.filter((i) => i.name.startsWith(parts.join('.') + '.')).map((i) => i.name);
  const alias = { delete: 'trash', remove: 'trash', read: 'readText', write: 'writeText', save: 'writeText', ls: 'list', readdir: 'list', mkdirp: 'mkdir', alert: 'toast', message: 'toast', ask: 'prompt', get: 'getText', set: 'setText', exists: 'stat' };
  const want = alias[last];
  const best = pool.find((p) => p.split('.').pop().toLowerCase() === want) || pool.find((p) => p.toLowerCase().includes(last)) || ALL.find((i) => i.name.split('.').pop().toLowerCase() === last)?.name;
  return best || null;
}
export const describePerm = (p) => PERM_NAMES[p] || p;
export { shortName };
