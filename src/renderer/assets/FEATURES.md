# Making features for Atlas Files

Features are small JavaScript files that add your own tools to Atlas: commands in the file browser and its right-click menu, toolbar buttons in Atlas Notepad, filters in Atlas Photos, buttons in Atlas Player. You write them in Atlas Notepad, install them with one click, and can share them as `.atlasfeature` files or through the feature browser.

This guide covers feature API version 1. Atlas keeps version 1 working: functions are never renamed or removed, only added.

## Contents

1. [Your first feature](#your-first-feature)
2. [The header](#the-header)
3. [Permissions](#permissions)
4. [The sandbox](#the-sandbox)
5. [Testing and the log](#testing-and-the-log)
6. [API reference](#api-reference)
7. [Examples](#examples)
8. [Sharing: export, import and the feature browser](#sharing-export-import-and-the-feature-browser)
9. [Rules for the feature browser](#rules-for-the-feature-browser)
10. [Common errors](#common-errors)

## Your first feature

1. Open **Atlas Notepad** and choose **Features (puzzle-piece button) > Add a feature…**
2. Pick a blank starter or one of the examples and press **Open in Notepad**. Atlas saves it in its *Features* folder so your work is never lost.
3. Change the code. Type `atlas.` for suggestions; hover any `atlas.…` name for help; press **F1** for the reference panel.
4. Press **Features > Install**. Atlas shows what the feature may do and asks you to confirm.
5. Use it: file-browser features appear in the command palette (Ctrl+Shift+P), the **Features** menu and the right-click menu; Notepad, Photos and Player features appear under their **Features** button (and on the toolbar with `toolbar: true`).

To change a feature later, edit the file and press **Install** again; it updates in place. **Manage features** (File > Features) turns features on and off, opens their code, exports and removes them.

```js
// @atlas-feature
// @name Copy paths as a list
// @description Copies the full paths of the selected items, one per line
// @target files
// @permissions
// @version 1.0

atlas.addMenuItem({
  title: 'Copy paths as a list',
  icon: 'copy',
  run: async ({ selection }) => {
    await atlas.clipboard.writeText(selection.map((f) => f.path).join('\n'));
    atlas.ui.toast(selection.length + ' path(s) copied');
  },
});
```

## The header

The `// @` lines at the top describe the feature. Atlas reads the first 40 lines.

| Line | Meaning |
| --- | --- |
| `// @atlas-feature` | Marks the file as a feature (first line) |
| `// @name` | The feature’s name, shown in menus and the feature browser |
| `// @description` | One sentence about what it does |
| `// @target` | Where it runs: files, notepad, photos or player |
| `// @permissions` | Any of: read write network run (leave empty for none) |
| `// @version` | Your version number, e.g. 1.0 (raise it when you update) |
| `// @author` | Your name (optional) |
| `// @icon` | An Atlas icon name for its button (optional) |

## Permissions

A feature can always show messages, ask questions, work inside its own app (the open document, picture or video) and copy text to the clipboard. Anything beyond that needs a permission, listed on the `// @permissions` line and shown to the person before they install:

| Permission | Name people see | Allows |
| --- | --- | --- |
| `read` | Read files | `atlas.files.list`, `stat`, `readText` |
| `write` | Change files | `atlas.files.writeText`, `rename`, `copy`, `move`, `mkdir`, `trash` |
| `network` | Use the internet | `atlas.net.fetch` |
| `run` | Run commands | `atlas.run` |

Ask only for what you use: people trust features that ask for less, and the **Check** tab in Notepad (F1) warns about permissions you ask for but don't use. If your code calls something its header doesn't ask for, **Install** offers to add it.

## The sandbox

Each feature runs in its own sandboxed worker:

- It can't see Atlas's windows or other features, and has no access to Node.js, `require`, `import` or `importScripts`.
- It can't reach the internet directly (`fetch` and `XMLHttpRequest` are blocked); `atlas.net.fetch` goes through Atlas and needs the `network` permission.
- Every `atlas.*` call is checked against the permissions the person approved. Deleting always goes to the Recycle Bin, and copies and moves use Atlas's operations queue, so they show progress, ask about name clashes and can be undone.
- All `atlas.*` functions return Promises: use `await`.

## Testing and the log

- `atlas.log(...)` or `console.log(...)` write to the **Log** tab of the help panel in Notepad (F1). Errors from features show there too, with the line number in your file.
- The **Check** tab lists problems before you install: missing permissions, names that don't exist (with a suggestion), functions that don't work where the feature runs, and features that add no command.
- Errors are written for people: `atlas.files.delete doesn't exist. Did you mean atlas.files.trash?`

## API reference

### Adding your tools

Every feature starts by adding at least one command. Commands appear in the command palette and the Features menu of the app the feature is made for; with toolbar: true they also get a toolbar button (Notepad, Photos, Player).

#### `atlas.addCommand({ id, title, run, icon?, keys?, toolbar? })`

Adds a command. run(context) is called when the person picks it. In the file browser, context is { selection, folder }; in Notepad, { fileName }.

| Option | Meaning |
| --- | --- |
| `id` | Short unique name inside your feature, like "count-words" |
| `title` | What people see in menus |
| `run` | async function (context) { … } |
| `icon` | Optional Atlas icon name, e.g. "star", "image", "code" |
| `keys` | Optional shortcut, e.g. "Ctrl+Alt+W" (file browser) |
| `toolbar` | true to add a toolbar button (Notepad, Photos, Player) |

- **Gives:** nothing
- **Works in:** everywhere

```js
atlas.addCommand({
  id: 'hello',
  title: 'Say hello',
  run: async () => atlas.ui.toast('Hello!'),
});
```

#### `atlas.addMenuItem({ title, run, when?, icon? })`

Adds an item to the right-click menu of files and folders. run({ selection, folder }) gets the right-clicked items.

| Option | Meaning |
| --- | --- |
| `title` | What people see in the menu |
| `run` | async function ({ selection, folder }) { … } |
| `when` | Optional: { files: true } only files, { folders: true } only folders, { ext: ["jpg","png"] } only these types, { single: true } only one item |

- **Gives:** nothing
- **Works in:** File browser

```js
atlas.addMenuItem({
  title: 'Copy name',
  when: { single: true },
  run: async ({ selection }) => atlas.ui.showText('Name', selection[0].name),
});
```

#### `atlas.log(...values)`

Writes to the feature log (Notepad > Features > API reference > Log). console.log does the same.

- **Gives:** nothing
- **Works in:** everywhere

```js
atlas.log('selected', await atlas.selection());
```

#### `atlas.version`

The feature API version (1). Atlas never breaks version 1 features.

- **Gives:** number
- **Works in:** everywhere

```js
if (atlas.version >= 1) atlas.log('ok');
```

### Talking to the person

Messages and questions. They work everywhere and need no permission.

#### `atlas.ui.toast(text)`

Shows a short message at the bottom of the window.

- **Gives:** Promise
- **Works in:** everywhere

```js
atlas.ui.toast('Done');
```

#### `atlas.ui.prompt(title, label?, value?)`

Asks for a line of text. Gives null if the person cancels.

- **Gives:** Promise<string | null>
- **Works in:** everywhere

```js
const name = await atlas.ui.prompt('New name', 'Name', 'Untitled');
if (name == null) return;
```

#### `atlas.ui.confirm(title, message)`

Asks a yes/no question.

- **Gives:** Promise<boolean>
- **Works in:** everywhere

```js
if (!(await atlas.ui.confirm('Rename 12 files?', 'This adds the date to each name.'))) return;
```

#### `atlas.ui.choose(title, options)`

Lets the person pick one of a few buttons. Gives the chosen text, or null.

- **Gives:** Promise<string | null>
- **Works in:** everywhere

```js
const size = await atlas.ui.choose('Size', ['Small', 'Medium', 'Large']);
```

#### `atlas.clipboard.writeText(text)`

Puts text on the clipboard. Features can’t read the clipboard.

- **Gives:** Promise
- **Works in:** everywhere

```js
await atlas.clipboard.writeText(paths.join('\n'));
atlas.ui.toast('Copied');
```

#### `atlas.ui.showText(title, text)`

Shows longer text in a window the person can read and copy.

- **Gives:** Promise
- **Works in:** everywhere

```js
atlas.ui.showText('Report', lines.join('\n'));
```

### Where the person is (file browser)

For features made for the file browser (@target files). Items are { path, name, ext, isDir, size, mtime }.

#### `atlas.selection()`

The selected files and folders in the active pane.

- **Gives:** Promise<Item[]>
- **Works in:** File browser

```js
const files = (await atlas.selection()).filter((f) => !f.isDir);
```

#### `atlas.folder()`

The folder open in the active pane.

- **Gives:** Promise<string>
- **Works in:** File browser

```js
const here = await atlas.folder();
```

#### `atlas.navigate(path)`

Opens a folder in the active pane.

- **Gives:** Promise
- **Works in:** File browser

```js
atlas.navigate('C:\\Users\\Public');
```

#### `atlas.refresh()`

Reloads the active pane, e.g. after renaming files.

- **Gives:** Promise
- **Works in:** File browser

```js
await atlas.refresh();
```

### Files

Reading needs the read permission; anything that changes files needs write. Ask for them in the header: // @permissions read write

#### `atlas.files.list(folder)`

What is inside a folder.

- **Gives:** Promise<Item[]>
- **Works in:** everywhere
- **Needs:** `read` (Read files)

```js
const items = await atlas.files.list(await atlas.folder());
```

#### `atlas.files.stat(path)`

Size and dates of a file or folder, or null if it doesn’t exist.

- **Gives:** Promise<{ isDir, size, mtime, ctime, atime } | null>
- **Works in:** everywhere
- **Needs:** `read` (Read files)

```js
const st = await atlas.files.stat(path);
if (!st) atlas.ui.toast('Not found');
```

#### `atlas.files.readText(path)`

Reads a text file (up to 20 MB). Fails for pictures, music and other non-text files.

- **Gives:** Promise<string>
- **Works in:** everywhere
- **Needs:** `read` (Read files)

```js
const text = await atlas.files.readText(file.path);
```

#### `atlas.files.writeText(path, text)`

Creates or replaces a text file (UTF-8).

- **Gives:** Promise<true>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.writeText(folder + '\\notes.txt', 'Hello');
```

#### `atlas.files.rename(fromPath, toPath)`

Renames (or moves within a drive). toPath is the full new path.

- **Gives:** Promise<true>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.rename(f.path, f.path.replace(/\.jpeg$/i, '.jpg'));
```

#### `atlas.files.copy(paths, destFolder)`

Copies files into a folder using the operations queue (progress, conflicts, undo).

- **Gives:** Promise<status>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.copy(files.map((f) => f.path), 'D:\\Backup');
```

#### `atlas.files.move(paths, destFolder)`

Moves files into a folder using the operations queue.

- **Gives:** Promise<status>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.move(paths, here + '\\Old');
```

#### `atlas.files.mkdir(path)`

Creates a folder.

- **Gives:** Promise<true>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.mkdir(here + '\\Sorted');
```

#### `atlas.files.trash(paths)`

Sends files to the Recycle Bin (never deletes for good).

- **Gives:** Promise<status>
- **Works in:** everywhere
- **Needs:** `write` (Change files)

```js
await atlas.files.trash([file.path]);
```

#### `atlas.files.open(path)`

Opens a file the way double-clicking would. Needs no permission.

- **Gives:** Promise
- **Works in:** everywhere

```js
atlas.files.open(file.path);
```

### Atlas Notepad

For features made for Notepad (@target notepad). They work on the open document.

#### `atlas.editor.getText()`

The whole document.

- **Gives:** Promise<string>
- **Works in:** Atlas Notepad

```js
const text = await atlas.editor.getText();
```

#### `atlas.editor.setText(text)`

Replaces the whole document (Ctrl+Z undoes it).

- **Gives:** Promise
- **Works in:** Atlas Notepad

```js
await atlas.editor.setText(text.toUpperCase());
```

#### `atlas.editor.getSelection()`

The selected text ("" if nothing is selected).

- **Gives:** Promise<string>
- **Works in:** Atlas Notepad

```js
const sel = await atlas.editor.getSelection();
```

#### `atlas.editor.replaceSelection(text)`

Replaces the selected text.

- **Gives:** Promise
- **Works in:** Atlas Notepad

```js
await atlas.editor.replaceSelection(sel.trim());
```

#### `atlas.editor.insert(text)`

Inserts text at the cursor.

- **Gives:** Promise
- **Works in:** Atlas Notepad

```js
await atlas.editor.insert(new Date().toLocaleString());
```

#### `atlas.editor.fileName()`

The document’s path (or its name if it isn’t saved yet).

- **Gives:** Promise<string>
- **Works in:** Atlas Notepad

```js
const name = await atlas.editor.fileName();
```

#### `atlas.editor.getLanguage()`

The document’s language id, e.g. "javascript", "markdown", "text".

- **Gives:** Promise<string>
- **Works in:** Atlas Notepad

```js
if ((await atlas.editor.getLanguage()) !== 'markdown') return;
```

#### `atlas.editor.setLanguage(id)`

Changes the highlighting language.

- **Gives:** Promise
- **Works in:** Atlas Notepad

```js
atlas.editor.setLanguage('json');
```

### Atlas Photos

For features made for the photo editor (@target photos). Pixels are { width, height, data } where data holds 4 numbers per pixel: red, green, blue, alpha (0–255).

#### `atlas.photos.getImageData()`

The picture’s pixels (opens edit mode if needed).

- **Gives:** Promise<{ width, height, data }>
- **Works in:** Atlas Photos

```js
const img = await atlas.photos.getImageData();
```

#### `atlas.photos.putImageData(img)`

Puts changed pixels back (undo works). Save as usual afterwards.

- **Gives:** Promise
- **Works in:** Atlas Photos

```js
await atlas.photos.putImageData(img);
```

#### `atlas.photos.fileName()`

The picture’s path.

- **Gives:** Promise<string>
- **Works in:** Atlas Photos

```js
const p = await atlas.photos.fileName();
```

### Atlas Player

For features made for the player (@target player). Times are in seconds.

#### `atlas.player.currentFile()`

The path of what is playing.

- **Gives:** Promise<string>
- **Works in:** Atlas Player

```js
const p = await atlas.player.currentFile();
```

#### `atlas.player.play()`

Plays.

- **Gives:** Promise
- **Works in:** Atlas Player

```js
atlas.player.play();
```

#### `atlas.player.pause()`

Pauses.

- **Gives:** Promise
- **Works in:** Atlas Player

```js
atlas.player.pause();
```

#### `atlas.player.seek(seconds)`

Jumps to a time.

- **Gives:** Promise
- **Works in:** Atlas Player

```js
atlas.player.seek(90);
```

#### `atlas.player.time()`

The current time.

- **Gives:** Promise<number>
- **Works in:** Atlas Player

```js
const t = await atlas.player.time();
```

#### `atlas.player.duration()`

How long the file is.

- **Gives:** Promise<number>
- **Works in:** Atlas Player

```js
const d = await atlas.player.duration();
```

### Internet

Features can’t reach the internet directly; they ask Atlas, which needs the network permission.

#### `atlas.net.fetch(url, { method?, headers?, body? })`

Downloads from a web address (http/https, up to 5 MB, 30 s). Unlike the browser’s fetch it gives back text: use JSON.parse(r.text) for JSON.

- **Gives:** Promise<{ status, ok, text, headers }>
- **Works in:** everywhere
- **Needs:** `network` (Use the internet)

```js
const r = await atlas.net.fetch('https://api.github.com/zen');
if (r.ok) atlas.ui.toast(r.text);
```

### Running commands

Needs the run permission. In the file browser the command runs in the built-in terminal so the person sees it; elsewhere it starts in the background.

#### `atlas.run(command, folder?)`

Runs a command line, optionally in a folder.

- **Gives:** Promise
- **Works in:** everywhere
- **Needs:** `run` (Run commands)

```js
atlas.run('git status', await atlas.folder());
```

### Remembering things

A small private store for each feature (settings, last used values). Survives restarts.

#### `atlas.storage.get(key)`

Reads a value you saved, or null.

- **Gives:** Promise<any>
- **Works in:** everywhere

```js
const last = (await atlas.storage.get('lastName')) || 'Untitled';
```

#### `atlas.storage.set(key, value)`

Saves a value (anything JSON can hold).

- **Gives:** Promise
- **Works in:** everywhere

```js
await atlas.storage.set('lastName', name);
```

## Examples

All of these are in Atlas: **Features > Add a feature…** in Notepad, or the **Examples** tab of the help panel (F1).

### Copy paths as a list (File browser)

Right-click files to copy their full paths, one per line.

```js
// @atlas-feature
// @name Copy paths as a list
// @description Copies the full paths of the selected items, one per line
// @target files
// @permissions
// @version 1.0

atlas.addMenuItem({
  title: 'Copy paths as a list',
  icon: 'copy',
  run: async ({ selection }) => {
    await atlas.clipboard.writeText(selection.map((f) => f.path).join('\n'));
    atlas.ui.toast(selection.length + ' path(s) copied');
  },
});
```

### Find & replace in names (File browser)

Asks what to find and what to put instead, shows a preview, then renames.

```js
// @atlas-feature
// @name Find and replace in names
// @description Replaces text in the names of the selected files, after showing a preview
// @target files
// @permissions write
// @version 1.0

atlas.addCommand({
  id: 'find-replace-names',
  title: 'Find and replace in names…',
  run: async () => {
    const items = await atlas.selection();
    if (!items.length) return atlas.ui.toast('Select some files first');
    const find = await atlas.ui.prompt('Find and replace in names', 'Find');
    if (!find) return;
    const repl = await atlas.ui.prompt('Find and replace in names', 'Replace with', '');
    if (repl == null) return;

    // work out the new names first, so the person can check them
    const changes = items
      .map((f) => ({ f, name: f.name.split(find).join(repl) }))
      .filter((c) => c.name !== c.f.name && c.name.trim());
    if (!changes.length) return atlas.ui.toast('No names contain “' + find + '”');
    const preview = changes.slice(0, 15).map((c) => c.f.name + '  →  ' + c.name).join('\n');
    if (!(await atlas.ui.confirm('Rename ' + changes.length + ' item(s)?', preview + (changes.length > 15 ? '\n…' : '')))) return;

    for (const c of changes) {
      const folder = c.f.path.slice(0, c.f.path.length - c.f.name.length);
      await atlas.files.rename(c.f.path, folder + c.name);
    }
    await atlas.refresh();
    atlas.ui.toast('Renamed ' + changes.length + ' item(s)');
  },
});
```

### Add today’s date to names (File browser)

Right-click files to put today’s date (like 2026-10-19) in front of their names.

```js
// @atlas-feature
// @name Add today's date to names
// @description Puts today's date (YYYY-MM-DD) in front of the selected files' names
// @target files
// @permissions write
// @version 1.0

atlas.addMenuItem({
  title: 'Add today’s date to the name',
  when: { files: true },
  run: async ({ selection }) => {
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    for (const f of selection) {
      const folder = f.path.slice(0, f.path.length - f.name.length);
      await atlas.files.rename(f.path, folder + today + ' ' + f.name);
    }
    await atlas.refresh();
  },
});
```

### Count words in text files (File browser)

Totals the words in the selected text files.

```js
// @atlas-feature
// @name Count words
// @description Counts the words in the selected text files
// @target files
// @permissions read
// @version 1.0

atlas.addCommand({
  id: 'count-words',
  title: 'Count words in selected files',
  run: async () => {
    const files = (await atlas.selection()).filter((f) => !f.isDir);
    const lines = [];
    let total = 0;
    for (const f of files) {
      try {
        const n = ((await atlas.files.readText(f.path)).match(/\S+/g) || []).length;
        total += n;
        lines.push(n.toLocaleString().padStart(10) + '  ' + f.name);
      } catch {
        lines.push('   (skipped)  ' + f.name + ' isn’t a text file');
      }
    }
    atlas.ui.showText('Word count', lines.join('\n') + '\n\n' + total.toLocaleString().padStart(10) + '  total');
  },
});
```

### Put each file in its own folder (File browser)

Makes a folder named after each selected file and moves the file into it.

```js
// @atlas-feature
// @name Folder for each file
// @description Makes a folder named after each selected file and moves the file into it
// @target files
// @permissions read write
// @version 1.0

atlas.addMenuItem({
  title: 'Put each in its own folder',
  when: { files: true },
  run: async ({ selection, folder }) => {
    const sep = folder.includes('\\') ? '\\' : '/';
    for (const f of selection) {
      const base = f.name.replace(/\.[^.]*$/, '');      // name without the extension
      const target = folder + sep + base;
      if (!(await atlas.files.stat(target))) await atlas.files.mkdir(target);
      await atlas.files.move([f.path], target);
    }
    await atlas.refresh();
  },
});
```

### Largest files report (File browser)

Lists the 20 biggest files in the current folder.

```js
// @atlas-feature
// @name Largest files
// @description Lists the 20 biggest files in the current folder
// @target files
// @permissions read
// @version 1.0

const size = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' bytes';

atlas.addCommand({
  id: 'largest-files',
  title: 'Show the largest files here',
  run: async () => {
    const items = (await atlas.files.list(await atlas.folder())).filter((i) => !i.isDir);
    items.sort((a, b) => b.size - a.size);
    const top = items.slice(0, 20).map((i) => size(i.size).padStart(9) + '  ' + i.name);
    atlas.ui.showText('Largest files', top.join('\n') || 'No files here');
  },
});
```

### Screenplay formatter (Atlas Notepad)

Puts scene headings, character names and transitions in capitals and lines them up.

```js
// @atlas-feature
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
    const lines = (await atlas.editor.getText()).split(/\r?\n/);
    const out = lines.map((l, i) => {
      const t = l.trim();
      if (/^(int|ext|int\.\/ext|i\/e)[. ]/i.test(t)) return t.toUpperCase();                         // scene heading
      if (/(cut to|fade (in|out)|dissolve to):?$/i.test(t)) return ' '.repeat(40) + t.toUpperCase();   // transition
      const next = (lines[i + 1] || '').trim();
      if (t && t.length < 30 && !/[.!?]$/.test(t) && next && (lines[i - 1] || '').trim() === '') return ' '.repeat(20) + t.toUpperCase(); // character
      return l;
    });
    await atlas.editor.setText(out.join('\n'));
    atlas.ui.toast('Formatted');
  },
});
```

### CSV to Markdown table (Atlas Notepad)

Turns selected comma-separated lines into a Markdown table.

```js
// @atlas-feature
// @name CSV to Markdown table
// @description Turns the selected comma-separated lines into a Markdown table
// @target notepad
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'csv-to-table',
  title: 'CSV to Markdown table',
  icon: 'viewGrid',
  run: async () => {
    const text = (await atlas.editor.getSelection()) || (await atlas.editor.getText());
    const rows = text.trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim()));
    if (rows.length < 2) return atlas.ui.toast('Select at least two lines of CSV');
    const line = (r) => '| ' + r.join(' | ') + ' |';
    const table = [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
    if (await atlas.editor.getSelection()) await atlas.editor.replaceSelection(table);
    else await atlas.editor.setText(table);
    await atlas.editor.setLanguage('markdown');
  },
});
```

### Insert date and time (Atlas Notepad)

A toolbar button that types the current date and time at the cursor.

```js
// @atlas-feature
// @name Insert date and time
// @description Inserts the current date and time at the cursor
// @target notepad
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'insert-now',
  title: 'Insert date and time',
  icon: 'clock',
  toolbar: true,
  run: () => atlas.editor.insert(new Date().toLocaleString()),
});
```

### Look up a word (Atlas Notepad)

Looks up the selected word in a free online dictionary (uses the internet).

```js
// @atlas-feature
// @name Look up a word
// @description Shows the dictionary meaning of the selected word (dictionaryapi.dev, free)
// @target notepad
// @permissions network
// @version 1.0

atlas.addCommand({
  id: 'define',
  title: 'Look up the selected word',
  icon: 'search',
  run: async () => {
    const word = (await atlas.editor.getSelection()).trim();
    if (!word) return atlas.ui.toast('Select a word first');
    const r = await atlas.net.fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!r.ok) return atlas.ui.toast('No meaning found for “' + word + '”');
    const entries = JSON.parse(r.text);                 // net.fetch gives text: parse JSON yourself
    const out = [];
    for (const e of entries) for (const m of e.meanings) {
      out.push(m.partOfSpeech.toUpperCase());
      m.definitions.slice(0, 3).forEach((d, i) => out.push('  ' + (i + 1) + '. ' + d.definition));
    }
    atlas.ui.showText(word, out.join('\n'));
  },
});
```

### Sepia (Atlas Photos)

Gives the photo a warm old-photo look.

```js
// @atlas-feature
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
    const d = img.data;                                  // red, green, blue, alpha for each pixel
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
      d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
      d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
    }
    await atlas.photos.putImageData(img);
  },
});
```

### Pixelate (Atlas Photos)

Turns the photo into big square blocks; asks how big.

```js
// @atlas-feature
// @name Pixelate
// @description Turns the photo into square blocks
// @target photos
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'pixelate',
  title: 'Pixelate',
  toolbar: true,
  run: async () => {
    const pick = await atlas.ui.choose('Block size', ['Small', 'Medium', 'Large']);
    if (!pick) return;
    const img = await atlas.photos.getImageData();
    const { width: w, height: h, data: d } = img;
    const size = Math.max(2, Math.round(Math.max(w, h) / { Small: 120, Medium: 60, Large: 25 }[pick]));
    for (let y = 0; y < h; y += size) for (let x = 0; x < w; x += size) {
      const i = (y * w + x) * 4;                         // colour of the block's top-left pixel
      for (let yy = y; yy < Math.min(y + size, h); yy++) for (let xx = x; xx < Math.min(x + size, w); xx++) {
        const j = (yy * w + xx) * 4;
        d[j] = d[i]; d[j + 1] = d[i + 1]; d[j + 2] = d[i + 2];
      }
    }
    await atlas.photos.putImageData(img);
  },
});
```

### Skip intro (Atlas Player)

A button that jumps ahead; remembers how far you like to skip.

```js
// @atlas-feature
// @name Skip intro
// @description Jumps ahead by a number of seconds you choose (remembered)
// @target player
// @permissions
// @version 1.1

atlas.addCommand({
  id: 'skip-intro',
  title: 'Skip intro',
  toolbar: true,
  run: async () => {
    const secs = (await atlas.storage.get('seconds')) || 90;
    atlas.player.seek((await atlas.player.time()) + secs);
  },
});

atlas.addCommand({
  id: 'skip-intro-set',
  title: 'Skip intro: change how far',
  run: async () => {
    const v = await atlas.ui.prompt('Skip intro', 'Seconds to skip', (await atlas.storage.get('seconds')) || 90);
    if (v && +v > 0) { await atlas.storage.set('seconds', +v); atlas.ui.toast('Skips ' + v + ' seconds'); }
  },
});
```

### Jump to 10% steps (Atlas Player)

Jumps to 10%, 20%, 30%… of the file, like quick chapters.

```js
// @atlas-feature
// @name Jump by tenths
// @description Jumps to 10%, 20%, 30%… of what's playing
// @target player
// @permissions
// @version 1.0

atlas.addCommand({
  id: 'jump-tenths',
  title: 'Jump to…',
  toolbar: true,
  icon: 'forward',
  run: async () => {
    const options = ['10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'];
    const pick = await atlas.ui.choose('Jump to', options);
    if (!pick) return;
    atlas.player.seek((await atlas.player.duration()) * parseInt(pick) / 100);
  },
});
```

## Sharing: export, import and the feature browser

- **Export:** Notepad > Features > *Export this feature…*, or the export button in Manage features, saves a `.atlasfeature` file (JSON with the code and header details). Send it to anyone.
- **Import:** double-click a `.atlasfeature` file, or Manage features > *Import…*. Atlas always shows the permissions and the code before installing.
- **Feature browser** (File > Features > Browse features): finds features published on GitHub (free). To publish, sign in under Settings > Features with a GitHub token (stored encrypted on your PC), then use *Upload*. Atlas creates a public repository with your feature and tags it so others can find it. To update, raise `@version` and upload again; people who installed it can press *Check for an update*.

## Rules for the feature browser

1. **Say what it does.** The name and description must match what the code does.
2. **Ask for the least.** Only the permissions the feature needs.
3. **No surprises.** Don't change, move or recycle files the person didn't choose, and confirm before changing many files.
4. **No hidden internet use.** Only contact the sites the feature is about, and never send file contents, paths or personal data anywhere the description doesn't mention.
5. **No obfuscated or minified code.** People must be able to read what they install.
6. **Your own work.** Only publish code you have the right to share.

Features that break these rules may be reported and removed. Remember that anyone can publish: install only features you trust, and read the code when you can.

## Common errors

| Message | What to do |
| --- | --- |
| `atlas.files.writeText() needs the "Change files" permission` | Add `write` to `// @permissions`, then Install again (Notepad offers to do it). |
| `atlas.x.y doesn't exist. Did you mean …?` | Use the suggested name, or look it up with F1. |
| `atlas.editor.getText() doesn't work in File browser` | The function belongs to another app: change `// @target`, or use a function for this app. |
| `Not a text file` | `readText` only reads text; skip pictures, music and other files (`try { … } catch {}`). |
| `addCommand needs { id, title, run }` | Give every command an id, a title and a run function. |
| Nothing happens | Check the Log tab (F1) for errors, and that the feature is turned on in Manage features. |
