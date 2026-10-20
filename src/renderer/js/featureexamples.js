// Ready-to-use example features, shown in "Add a feature". Each one is a complete, working feature people can
// install as is or open in Notepad and change. Keep them short and commented: they're how most people learn.
const ex = (id, target, title, blurb, code) => ({ id, target, title, blurb, code: code.trim() + '\n' });

export const EXAMPLES = [
  // ---------------- file browser ----------------
  ex('copy-paths', 'files', 'Copy paths as a list', 'Right-click files to copy their full paths, one per line.', String.raw`
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
`),
  ex('find-replace-names', 'files', 'Find & replace in names', 'Asks what to find and what to put instead, shows a preview, then renames.', String.raw`
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
`),
  ex('date-prefix', 'files', 'Add today’s date to names', 'Right-click files to put today’s date (like 2026-10-19) in front of their names.', String.raw`
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
`),
  ex('word-count', 'files', 'Count words in text files', 'Totals the words in the selected text files.', String.raw`
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
`),
  ex('folder-per-file', 'files', 'Put each file in its own folder', 'Makes a folder named after each selected file and moves the file into it.', String.raw`
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
`),
  ex('largest-files', 'files', 'Largest files report', 'Lists the 20 biggest files in the current folder.', String.raw`
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
`),

  // ---------------- Notepad ----------------
  ex('screenplay', 'notepad', 'Screenplay formatter', 'Puts scene headings, character names and transitions in capitals and lines them up.', String.raw`
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
`),
  ex('csv-table', 'notepad', 'CSV to Markdown table', 'Turns selected comma-separated lines into a Markdown table.', String.raw`
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
`),
  ex('timestamp', 'notepad', 'Insert date and time', 'A toolbar button that types the current date and time at the cursor.', String.raw`
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
`),
  ex('define-word', 'notepad', 'Look up a word', 'Looks up the selected word in a free online dictionary (uses the internet).', String.raw`
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
`),

  // ---------------- Photos ----------------
  ex('sepia', 'photos', 'Sepia', 'Gives the photo a warm old-photo look.', String.raw`
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
`),
  ex('pixelate', 'photos', 'Pixelate', 'Turns the photo into big square blocks; asks how big.', String.raw`
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
`),

  // ---------------- Player ----------------
  ex('skip-intro', 'player', 'Skip intro', 'A button that jumps ahead; remembers how far you like to skip.', String.raw`
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
`),
  ex('chapters', 'player', 'Jump to 10% steps', 'Jumps to 10%, 20%, 30%… of the file, like quick chapters.', String.raw`
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
`),
];
