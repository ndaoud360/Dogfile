// The feature API, described once. Used by the API reference panel and the autocomplete / hover hints in Dogfile
// Notepad, by the plain-language error messages, by the install check ("your code uses X but doesn't ask for Y"),
// and by build/make-feature-docs.mjs, which writes FEATURES.md from this file so the guide never drifts.
// API version 1: functions here are never renamed or removed; new ones may be added.

export const API_VERSION = 1;

export const PERM_NAMES = { read: 'Read files', write: 'Change files', network: 'Use the internet', run: 'Run commands', hooks: 'Watch and change file operations' };

// where: which apps the call works in ('all' or a list of targets: files, notepad, photos, player)
export const SECTIONS = [
  { id: 'basics', title: 'Adding your tools', intro: 'Every feature starts by adding at least one command. Commands appear in the command palette and the Features menu of the app the feature is made for; with toolbar: true they also get a toolbar button (Notepad, Photos, Player).', items: [
    { name: 'dogfile.addCommand', sig: 'dogfile.addCommand({ id, title, run, icon?, keys?, toolbar? })', returns: 'nothing', where: 'all',
      desc: 'Adds a command. run(context) is called when the person picks it. In the file browser, context is { selection, folder }; in Notepad, { fileName }.',
      params: [['id', 'Short unique name inside your feature, like "count-words"'], ['title', 'What people see in menus'], ['run', 'async function (context) { … }'], ['icon', 'Optional Dogfile icon name, e.g. "star", "image", "code"'], ['keys', 'Optional shortcut, e.g. "Ctrl+Alt+W" (file browser)'], ['toolbar', 'true to add a toolbar button (Notepad, Photos, Player)']],
      example: `dogfile.addCommand({\n  id: 'hello',\n  title: 'Say hello',\n  run: async () => dogfile.ui.toast('Hello!'),\n});` },
    { name: 'dogfile.addMenuItem', sig: 'dogfile.addMenuItem({ title, run, when?, icon? })', returns: 'nothing', where: ['files'],
      desc: 'Adds an item to the right-click menu of files and folders. run({ selection, folder }) gets the right-clicked items.',
      params: [['title', 'What people see in the menu'], ['run', 'async function ({ selection, folder }) { … }'], ['when', 'Optional: { files: true } only files, { folders: true } only folders, { ext: ["jpg","png"] } only these types, { single: true } only one item']],
      example: `dogfile.addMenuItem({\n  title: 'Copy name',\n  when: { single: true },\n  run: async ({ selection }) => dogfile.ui.showText('Name', selection[0].name),\n});` },
    { name: 'dogfile.log', sig: 'dogfile.log(...values)', returns: 'nothing', where: 'all',
      desc: 'Writes to the feature log (Notepad > Features > API reference > Log). console.log does the same.',
      example: `dogfile.log('selected', await dogfile.selection());` },
    { name: 'dogfile.version', sig: 'dogfile.version', returns: 'number', where: 'all', desc: 'The feature API version (1). Dogfile never breaks version 1 features.', example: `if (dogfile.version >= 1) dogfile.log('ok');` },
  ] },
  { id: 'ui', title: 'Talking to the person', intro: 'Messages and questions. They work everywhere and need no permission.', items: [
    { name: 'dogfile.ui.toast', sig: 'dogfile.ui.toast(text)', returns: 'Promise', where: 'all', desc: 'Shows a short message at the bottom of the window.', example: `dogfile.ui.toast('Done');` },
    { name: 'dogfile.ui.prompt', sig: 'dogfile.ui.prompt(title, label?, value?)', returns: 'Promise<string | null>', where: 'all', desc: 'Asks for a line of text. Gives null if the person cancels.', example: `const name = await dogfile.ui.prompt('New name', 'Name', 'Untitled');\nif (name == null) return;` },
    { name: 'dogfile.ui.confirm', sig: 'dogfile.ui.confirm(title, message)', returns: 'Promise<boolean>', where: 'all', desc: 'Asks a yes/no question.', example: `if (!(await dogfile.ui.confirm('Rename 12 files?', 'This adds the date to each name.'))) return;` },
    { name: 'dogfile.ui.choose', sig: 'dogfile.ui.choose(title, options)', returns: 'Promise<string | null>', where: 'all', desc: 'Lets the person pick one of a few buttons. Gives the chosen text, or null.', example: `const size = await dogfile.ui.choose('Size', ['Small', 'Medium', 'Large']);` },
    { name: 'dogfile.clipboard.writeText', sig: 'dogfile.clipboard.writeText(text)', returns: 'Promise', where: 'all', desc: 'Puts text on the clipboard. Features can’t read the clipboard.', example: `await dogfile.clipboard.writeText(paths.join('\\n'));\ndogfile.ui.toast('Copied');` },
    { name: 'dogfile.ui.showText', sig: 'dogfile.ui.showText(title, text)', returns: 'Promise', where: 'all', desc: 'Shows longer text in a window the person can read and copy.', example: `dogfile.ui.showText('Report', lines.join('\\n'));` },
  ] },
  { id: 'ctx', title: 'Where the person is (file browser)', intro: 'For features made for the file browser (@target files). Items are { path, name, ext, isDir, size, mtime }.', items: [
    { name: 'dogfile.selection', sig: 'dogfile.selection()', returns: 'Promise<Item[]>', where: ['files'], desc: 'The selected files and folders in the active pane.', example: `const files = (await dogfile.selection()).filter((f) => !f.isDir);` },
    { name: 'dogfile.folder', sig: 'dogfile.folder()', returns: 'Promise<string>', where: ['files'], desc: 'The folder open in the active pane.', example: `const here = await dogfile.folder();` },
    { name: 'dogfile.navigate', sig: 'dogfile.navigate(path)', returns: 'Promise', where: ['files'], desc: 'Opens a folder in the active pane.', example: `dogfile.navigate('C:\\\\Users\\\\Public');` },
    { name: 'dogfile.refresh', sig: 'dogfile.refresh()', returns: 'Promise', where: ['files'], desc: 'Reloads the active pane, e.g. after renaming files.', example: `await dogfile.refresh();` },
  ] },
  { id: 'files', title: 'Files', intro: 'Reading needs the read permission; anything that changes files needs write. Ask for them in the header: // @permissions read write', items: [
    { name: 'dogfile.files.list', sig: 'dogfile.files.list(folder)', returns: 'Promise<Item[]>', perm: 'read', where: 'all', desc: 'What is inside a folder.', example: `const items = await dogfile.files.list(await dogfile.folder());` },
    { name: 'dogfile.files.stat', sig: 'dogfile.files.stat(path)', returns: 'Promise<{ isDir, size, mtime, ctime, atime } | null>', perm: 'read', where: 'all', desc: 'Size and dates of a file or folder, or null if it doesn’t exist.', example: `const st = await dogfile.files.stat(path);\nif (!st) dogfile.ui.toast('Not found');` },
    { name: 'dogfile.files.readText', sig: 'dogfile.files.readText(path)', returns: 'Promise<string>', perm: 'read', where: 'all', desc: 'Reads a text file (up to 20 MB). Fails for pictures, music and other non-text files.', example: `const text = await dogfile.files.readText(file.path);` },
    { name: 'dogfile.files.writeText', sig: 'dogfile.files.writeText(path, text)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Creates or replaces a text file (UTF-8).', example: `await dogfile.files.writeText(folder + '\\\\notes.txt', 'Hello');` },
    { name: 'dogfile.files.rename', sig: 'dogfile.files.rename(fromPath, toPath)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Renames (or moves within a drive). toPath is the full new path.', example: `await dogfile.files.rename(f.path, f.path.replace(/\\.jpeg$/i, '.jpg'));` },
    { name: 'dogfile.files.copy', sig: 'dogfile.files.copy(paths, destFolder)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Copies files into a folder using the operations queue (progress, conflicts, undo).', example: `await dogfile.files.copy(files.map((f) => f.path), 'D:\\\\Backup');` },
    { name: 'dogfile.files.move', sig: 'dogfile.files.move(paths, destFolder)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Moves files into a folder using the operations queue.', example: `await dogfile.files.move(paths, here + '\\\\Old');` },
    { name: 'dogfile.files.mkdir', sig: 'dogfile.files.mkdir(path)', returns: 'Promise<true>', perm: 'write', where: 'all', desc: 'Creates a folder.', example: `await dogfile.files.mkdir(here + '\\\\Sorted');` },
    { name: 'dogfile.files.trash', sig: 'dogfile.files.trash(paths)', returns: 'Promise<status>', perm: 'write', where: 'all', desc: 'Sends files to the Recycle Bin (never deletes for good).', example: `await dogfile.files.trash([file.path]);` },
    { name: 'dogfile.files.open', sig: 'dogfile.files.open(path)', returns: 'Promise', where: 'all', desc: 'Opens a file the way double-clicking would. Needs no permission.', example: `dogfile.files.open(file.path);` },
  ] },
  { id: 'editor', title: 'Dogfile Notepad', intro: 'For features made for Notepad (@target notepad). They work on the open document.', items: [
    { name: 'dogfile.editor.getText', sig: 'dogfile.editor.getText()', returns: 'Promise<string>', where: ['notepad'], desc: 'The whole document.', example: `const text = await dogfile.editor.getText();` },
    { name: 'dogfile.editor.setText', sig: 'dogfile.editor.setText(text)', returns: 'Promise', where: ['notepad'], desc: 'Replaces the whole document (Ctrl+Z undoes it).', example: `await dogfile.editor.setText(text.toUpperCase());` },
    { name: 'dogfile.editor.getSelection', sig: 'dogfile.editor.getSelection()', returns: 'Promise<string>', where: ['notepad'], desc: 'The selected text ("" if nothing is selected).', example: `const sel = await dogfile.editor.getSelection();` },
    { name: 'dogfile.editor.replaceSelection', sig: 'dogfile.editor.replaceSelection(text)', returns: 'Promise', where: ['notepad'], desc: 'Replaces the selected text.', example: `await dogfile.editor.replaceSelection(sel.trim());` },
    { name: 'dogfile.editor.insert', sig: 'dogfile.editor.insert(text)', returns: 'Promise', where: ['notepad'], desc: 'Inserts text at the cursor.', example: `await dogfile.editor.insert(new Date().toLocaleString());` },
    { name: 'dogfile.editor.fileName', sig: 'dogfile.editor.fileName()', returns: 'Promise<string>', where: ['notepad'], desc: 'The document’s path (or its name if it isn’t saved yet).', example: `const name = await dogfile.editor.fileName();` },
    { name: 'dogfile.editor.getLanguage', sig: 'dogfile.editor.getLanguage()', returns: 'Promise<string>', where: ['notepad'], desc: 'The document’s language id, e.g. "javascript", "markdown", "text".', example: `if ((await dogfile.editor.getLanguage()) !== 'markdown') return;` },
    { name: 'dogfile.editor.setLanguage', sig: 'dogfile.editor.setLanguage(id)', returns: 'Promise', where: ['notepad'], desc: 'Changes the highlighting language.', example: `dogfile.editor.setLanguage('json');` },
  ] },
  { id: 'photos', title: 'Dogfile Photos', intro: 'For features made for the photo editor (@target photos). Pixels are { width, height, data } where data holds 4 numbers per pixel: red, green, blue, alpha (0–255).', items: [
    { name: 'dogfile.photos.getImageData', sig: 'dogfile.photos.getImageData()', returns: 'Promise<{ width, height, data }>', where: ['photos'], desc: 'The picture’s pixels (opens edit mode if needed).', example: `const img = await dogfile.photos.getImageData();` },
    { name: 'dogfile.photos.putImageData', sig: 'dogfile.photos.putImageData(img)', returns: 'Promise', where: ['photos'], desc: 'Puts changed pixels back (undo works). Save as usual afterwards.', example: `await dogfile.photos.putImageData(img);` },
    { name: 'dogfile.photos.fileName', sig: 'dogfile.photos.fileName()', returns: 'Promise<string>', where: ['photos'], desc: 'The picture’s path.', example: `const p = await dogfile.photos.fileName();` },
  ] },
  { id: 'player', title: 'Dogfile Player', intro: 'For features made for the player (@target player). Times are in seconds.', items: [
    { name: 'dogfile.player.currentFile', sig: 'dogfile.player.currentFile()', returns: 'Promise<string>', where: ['player'], desc: 'The path of what is playing.', example: `const p = await dogfile.player.currentFile();` },
    { name: 'dogfile.player.play', sig: 'dogfile.player.play()', returns: 'Promise', where: ['player'], desc: 'Plays.', example: `dogfile.player.play();` },
    { name: 'dogfile.player.pause', sig: 'dogfile.player.pause()', returns: 'Promise', where: ['player'], desc: 'Pauses.', example: `dogfile.player.pause();` },
    { name: 'dogfile.player.seek', sig: 'dogfile.player.seek(seconds)', returns: 'Promise', where: ['player'], desc: 'Jumps to a time.', example: `dogfile.player.seek(90);` },
    { name: 'dogfile.player.time', sig: 'dogfile.player.time()', returns: 'Promise<number>', where: ['player'], desc: 'The current time.', example: `const t = await dogfile.player.time();` },
    { name: 'dogfile.player.duration', sig: 'dogfile.player.duration()', returns: 'Promise<number>', where: ['player'], desc: 'How long the file is.', example: `const d = await dogfile.player.duration();` },
  ] },
  { id: 'net', title: 'Internet', intro: 'Features can’t reach the internet directly; they ask Dogfile, which needs the network permission.', items: [
    { name: 'dogfile.net.fetch', sig: 'dogfile.net.fetch(url, { method?, headers?, body? })', returns: 'Promise<{ status, ok, text, headers }>', perm: 'network', where: 'all',
      desc: 'Downloads from a web address (http/https, up to 5 MB, 30 s). Unlike the browser’s fetch it gives back text: use JSON.parse(r.text) for JSON.', example: `const r = await dogfile.net.fetch('https://api.github.com/zen');\nif (r.ok) dogfile.ui.toast(r.text);` },
  ] },
  { id: 'run', title: 'Running commands', intro: 'Needs the run permission. In the file browser the command runs in the built-in terminal so the person sees it; elsewhere it starts in the background.', items: [
    { name: 'dogfile.run', sig: 'dogfile.run(command, folder?)', returns: 'Promise', perm: 'run', where: 'all', desc: 'Runs a command line, optionally in a folder.', example: `dogfile.run('git status', await dogfile.folder());` },
  ] },
  { id: 'events', title: 'File events (hooks)', intro: 'React to what happens to files, or change it before it happens. Needs the hooks permission (// @permissions hooks). Before-events can answer with changes; after-events are only told. Each listener gets 3 seconds: a slow or failing one is skipped, never blocking the operation.', items: [
    { name: 'dogfile.on', sig: 'dogfile.on(event, async (e) => answer?)', returns: 'nothing', perm: 'hooks', where: ['files'],
      desc: 'Listens for a file event. e has the event name and what it’s about: { sources, dest, type } for copy / move / delete / compress / extract, { path, name, newName } for a rename, { sources, dest, mode } for a drop, { from, to } after a rename, { path } after a folder opens. A before-event listener can answer { cancel: true, reason } to stop it, { dest } to send the files elsewhere, { sources } to take only some, { newName } to change a rename, { mode: "copy" | "move" } for a drop. Events: beforeCopy, beforeMove, beforeDelete, beforeRename, beforeDrop, beforeCompress, beforeExtract, afterCopy, afterMove, afterDelete, afterRename, afterCompress, afterExtract, navigate.',
      params: [['event', 'The event name, e.g. "beforeMove"'], ['listener', 'async function (e) { … } — return nothing to let it go ahead unchanged']],
      example: `// photos dropped anywhere go to Pictures\\Inbox instead
dogfile.on('beforeDrop', async (e) => {
  if (e.sources.every((p) => /\\.(jpe?g|png|heic)$/i.test(p))) return { dest: 'C:\\\\Users\\\\Ana\\\\Pictures\\\\Inbox' };
});

// never delete anything in a folder named "Keep"
dogfile.on('beforeDelete', async (e) => {
  if (e.sources.some((p) => /[\\\\/]Keep[\\\\/]/i.test(p))) return { cancel: true, reason: 'Files in Keep are protected' };
});

// names without spaces
dogfile.on('beforeRename', async (e) => ({ newName: e.newName.replace(/\\s+/g, '-') }));` },
  ] },
  { id: 'storage', title: 'Remembering things', intro: 'A small private store for each feature (settings, last used values). Survives restarts.', items: [
    { name: 'dogfile.storage.get', sig: 'dogfile.storage.get(key)', returns: 'Promise<any>', where: 'all', desc: 'Reads a value you saved, or null.', example: `const last = (await dogfile.storage.get('lastName')) || 'Untitled';` },
    { name: 'dogfile.storage.set', sig: 'dogfile.storage.set(key, value)', returns: 'Promise', where: 'all', desc: 'Saves a value (anything JSON can hold).', example: `await dogfile.storage.set('lastName', name);` },
  ] },
];

export const HEADER = [
  ['@dogmod', 'Marks the file as a Dogfile mod (first line)'],
  ['@name', 'The feature’s name, shown in menus and the feature browser'],
  ['@description', 'One sentence about what it does'],
  ['@target', 'Where it runs: files, notepad, photos or player'],
  ['@permissions', 'Any of: read write network run hooks (leave empty for none)'],
  ['@version', 'Your version number, e.g. 1.0 (raise it when you update)'],
  ['@author', 'Your name (optional)'],
  ['@icon', 'An Dogfile icon name for its button (optional)'],
];

export const ALL = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.id })));
export const BY_NAME = new Map(ALL.map((i) => [i.name, i]));
const shortName = (n) => n.replace(/^(?:dogfile|atlas)\./, '');
// mods written for Atlas used `atlas.`: same API
const norm = (n) => n.replace(/^atlas\./, 'dogfile.');
export const method = (n) => BY_NAME.get('dogfile.' + n);

// members of "dogfile", "dogfile.files", … for autocomplete
export function membersOf(prefix) {
  const out = new Map();
  const p = prefix ? norm(prefix) + '.' : 'dogfile.';
  for (const i of ALL) {
    if (!i.name.startsWith(p)) continue;
    const rest = i.name.slice(p.length);
    const head = rest.split('.')[0];
    if (rest.includes('.')) { if (!out.has(head)) out.set(head, { label: head, type: 'namespace', detail: SECTIONS.find((s) => s.items.some((x) => x.name.startsWith(p + head + '.')))?.title || '' }); }
    else out.set(head, { label: head, type: i.sig.includes('(') ? 'function' : 'property', item: i });
  }
  return [...out.values()];
}

// permissions the code uses (from dogfile.* calls) — for the install check
export function permsUsed(code) {
  const used = new Map();
  for (const m of String(code).matchAll(/\b(?:dogfile|atlas)\.([\w.]+)\s*\(/g)) {
    const it = BY_NAME.get('dogfile.' + m[1]);
    if (it?.perm && !used.has(it.perm)) used.set(it.perm, it.name);
  }
  return used; // perm -> first function that needs it
}
// calls the code makes that don't exist or don't work in this target
export function problems(code, target) {
  const out = [];
  const seen = new Set();
  for (const m of String(code).matchAll(/\b(?:dogfile|atlas)\.([\w.]+)\s*\(/g)) {
    const n = 'dogfile.' + m[1];
    if (seen.has(n)) continue; seen.add(n);
    const it = BY_NAME.get(n);
    if (!it) out.push({ name: n, text: `${n} doesn’t exist${suggest(n) ? ` — did you mean ${suggest(n)}?` : ''}` });
    else if (it.where !== 'all' && target && !it.where.includes(target)) out.push({ name: n, text: `${n} only works in ${it.where.map((w) => ({ files: 'the file browser', notepad: 'Notepad', photos: 'Photos', player: 'Player' }[w])).join(', ')}, but this feature’s @target is ${target}` });
  }
  return out;
}
export function suggest(n) {
  const parts = norm(n).split('.');
  const last = parts.pop().toLowerCase();
  const pool = ALL.filter((i) => i.name.startsWith(parts.join('.') + '.')).map((i) => i.name);
  const alias = { delete: 'trash', remove: 'trash', read: 'readText', write: 'writeText', save: 'writeText', ls: 'list', readdir: 'list', mkdirp: 'mkdir', alert: 'toast', message: 'toast', ask: 'prompt', get: 'getText', set: 'setText', exists: 'stat' };
  const want = alias[last];
  const best = pool.find((p) => p.split('.').pop().toLowerCase() === want) || pool.find((p) => p.toLowerCase().includes(last)) || ALL.find((i) => i.name.split('.').pop().toLowerCase() === last)?.name;
  return best || null;
}
export const describePerm = (p) => PERM_NAMES[p] || p;
export { shortName };
