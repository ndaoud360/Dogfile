// Writes FEATURES.md (the guide for people making Dogfile features) from src/renderer/js/featureapi.js and
// featureexamples.js, so the written guide always matches the in-app reference. Run: node build/make-feature-docs.mjs
import { writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = await import(pathToFileURL(path.join(root, 'src/renderer/js/featureapi.js')));
const { EXAMPLES } = await import(pathToFileURL(path.join(root, 'src/renderer/js/featureexamples.js')));
const T = { files: 'File browser', notepad: 'Dogfile Notepad', photos: 'Dogfile Photos', player: 'Dogfile Player' };
const where = (it) => (it.where === 'all' ? 'everywhere' : it.where.map((w) => T[w]).join(', '));

const out = [];
const p = (...l) => out.push(...l);
p('# Making features for Dogfile', '',
  'Features are small JavaScript files that add your own tools to Dogfile: commands in the file browser and its right-click menu, toolbar buttons in Dogfile Notepad, filters in Dogfile Photos, buttons in Dogfile Player. You write them in Dogfile Notepad, install them with one click, and can share them as `.dogmod` files or through the feature browser.', '',
  `This guide covers feature API version ${API.API_VERSION}. Dogfile keeps version 1 working: functions are never renamed or removed, only added.`, '',
  '## Contents', '', '1. [Your first feature](#your-first-feature)', '2. [The header](#the-header)', '3. [Permissions](#permissions)', '4. [The sandbox](#the-sandbox)', '5. [Testing and the log](#testing-and-the-log)', '6. [API reference](#api-reference)', '7. [Examples](#examples)', '8. [Sharing: export, import and the feature browser](#sharing-export-import-and-the-feature-browser)', '9. [Rules for the feature browser](#rules-for-the-feature-browser)', '10. [Common errors](#common-errors)', '',
  '## Your first feature', '',
  '1. Open **Dogfile Notepad** and choose **Features (puzzle-piece button) > Add a feature…**',
  '2. Pick a blank starter or one of the examples and press **Open in Notepad**. Dogfile saves it in its *Features* folder so your work is never lost.',
  '3. Change the code. Type `dogfile.` for suggestions; hover any `dogfile.…` name for help; press **F1** for the reference panel.',
  '4. Press **Features > Install**. Dogfile shows what the feature may do and asks you to confirm.',
  '5. Use it: file-browser features appear in the command palette (Ctrl+Shift+P), the **Features** menu and the right-click menu; Notepad, Photos and Player features appear under their **Features** button (and on the toolbar with `toolbar: true`).', '',
  'To change a feature later, edit the file and press **Install** again; it updates in place. **Manage features** (File > Features) turns features on and off, opens their code, exports and removes them.', '',
  '```js', EXAMPLES.find((e) => e.id === 'copy-paths').code.trim(), '```', '',
  '## The header', '', 'The `// @` lines at the top describe the feature. Dogfile reads the first 40 lines.', '', '| Line | Meaning |', '| --- | --- |', ...API.HEADER.map(([k, d]) => `| \`// ${k}\` | ${d} |`), '',
  '## Permissions', '',
  'A feature can always show messages, ask questions, work inside its own app (the open document, picture or video) and copy text to the clipboard. Anything beyond that needs a permission, listed on the `// @permissions` line and shown to the person before they install:', '',
  '| Permission | Name people see | Allows |', '| --- | --- | --- |',
  '| `read` | Read files | `dogfile.files.list`, `stat`, `readText` |',
  '| `write` | Change files | `dogfile.files.writeText`, `rename`, `copy`, `move`, `mkdir`, `trash` |',
  '| `network` | Use the internet | `dogfile.net.fetch` |',
  '| `run` | Run commands | `dogfile.run` |', '',
  'Ask only for what you use: people trust features that ask for less, and the **Check** tab in Notepad (F1) warns about permissions you ask for but don\'t use. If your code calls something its header doesn\'t ask for, **Install** offers to add it.', '',
  '## The sandbox', '',
  'Each feature runs in its own sandboxed worker:', '',
  '- It can\'t see Dogfile\'s windows or other features, and has no access to Node.js, `require`, `import` or `importScripts`.',
  '- It can\'t reach the internet directly (`fetch` and `XMLHttpRequest` are blocked); `dogfile.net.fetch` goes through Dogfile and needs the `network` permission.',
  '- Every `dogfile.*` call is checked against the permissions the person approved. Deleting always goes to the Recycle Bin, and copies and moves use Dogfile\'s operations queue, so they show progress, ask about name clashes and can be undone.',
  '- All `dogfile.*` functions return Promises: use `await`.', '',
  '## Testing and the log', '',
  '- `dogfile.log(...)` or `console.log(...)` write to the **Log** tab of the help panel in Notepad (F1). Errors from features show there too, with the line number in your file.',
  '- The **Check** tab lists problems before you install: missing permissions, names that don\'t exist (with a suggestion), functions that don\'t work where the feature runs, and features that add no command.',
  '- Errors are written for people: `dogfile.files.delete doesn\'t exist. Did you mean dogfile.files.trash?`', '',
  '## API reference', '');
for (const s of API.SECTIONS) {
  p(`### ${s.title}`, '', s.intro, '');
  for (const it of s.items) {
    p(`#### \`${it.sig}\``, '', it.desc, '');
    if (it.params) { p('| Option | Meaning |', '| --- | --- |', ...it.params.map(([k, d]) => `| \`${k}\` | ${d} |`), ''); }
    p(`- **Gives:** ${it.returns}`, `- **Works in:** ${where(it)}`, ...(it.perm ? [`- **Needs:** \`${it.perm}\` (${API.PERM_NAMES[it.perm]})`] : []), '', '```js', it.example, '```', '');
  }
}
p('## Examples', '', 'All of these are in Dogfile: **Features > Add a feature…** in Notepad, or the **Examples** tab of the help panel (F1).', '');
for (const e of EXAMPLES) p(`### ${e.title} (${T[e.target]})`, '', e.blurb, '', '```js', e.code.trim(), '```', '');
p('## Sharing: export, import and the feature browser', '',
  '- **Export:** Notepad > Features > *Export this feature…*, or the export button in Manage features, saves a `.dogmod` file (JSON with the code and header details). Send it to anyone.',
  '- **Import:** double-click a `.dogmod` file, or Manage features > *Import…*. Dogfile always shows the permissions and the code before installing.',
  '- **Feature browser** (File > Features > Browse features): finds features published on GitHub (free). To publish, sign in under Settings > Features with a GitHub token (stored encrypted on your PC), then use *Upload*. Dogfile creates a public repository with your feature and tags it so others can find it. To update, raise `@version` and upload again; people who installed it can press *Check for an update*.', '',
  '## Rules for the feature browser', '',
  '1. **Say what it does.** The name and description must match what the code does.',
  '2. **Ask for the least.** Only the permissions the feature needs.',
  '3. **No surprises.** Don\'t change, move or recycle files the person didn\'t choose, and confirm before changing many files.',
  '4. **No hidden internet use.** Only contact the sites the feature is about, and never send file contents, paths or personal data anywhere the description doesn\'t mention.',
  '5. **No obfuscated or minified code.** People must be able to read what they install.',
  '6. **Your own work.** Only publish code you have the right to share.', '',
  'Features that break these rules may be reported and removed. Remember that anyone can publish: install only features you trust, and read the code when you can.', '',
  '## Common errors', '',
  '| Message | What to do |', '| --- | --- |',
  '| `dogfile.files.writeText() needs the "Change files" permission` | Add `write` to `// @permissions`, then Install again (Notepad offers to do it). |',
  '| `dogfile.x.y doesn\'t exist. Did you mean …?` | Use the suggested name, or look it up with F1. |',
  '| `dogfile.editor.getText() doesn\'t work in File browser` | The function belongs to another app: change `// @target`, or use a function for this app. |',
  '| `Not a text file` | `readText` only reads text; skip pictures, music and other files (`try { … } catch {}`). |',
  '| `addCommand needs { id, title, run }` | Give every command an id, a title and a run function. |',
  '| Nothing happens | Check the Log tab (F1) for errors, and that the feature is turned on in Manage features. |', '');
writeFileSync(path.join(root, 'FEATURES.md'), out.join('\n'));
writeFileSync(path.join(root, 'src/renderer/assets/FEATURES.md'), out.join('\n')); // shipped with the app (Feature guide)
console.log('FEATURES.md', out.length, 'lines');
