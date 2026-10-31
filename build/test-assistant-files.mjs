// node build/test-assistant-files.mjs — checks how the assistant reads requests about files and Dogfile itself
// (the request list in docs: finding, space, moving, renaming, tags, archives, versions, apps, terminal,
// settings, help, features). Each case says what the request should become.
import { parseRequest, camelotOf } from '../src/renderer/js/assistant-parse.js';
import { matchIntent, parseSchedule, parseAutomation } from '../src/renderer/js/assistant-intents.js';
import { parseAppRequest } from '../src/renderer/js/assistant-apps.js';
import { interpretRename } from '../src/renderer/js/rename-words.js';
import { featureFromRequest } from '../src/renderer/js/assistant-feature.js';

let pass = 0, fail = 0;
const ok = (cond, name, got) => { if (cond) pass++; else { fail++; console.log('FAIL', name, '\n     got:', JSON.stringify(got).slice(0, 400)); } };
const P = (t, sel = false) => parseRequest(t, { hasSelection: sel, now: new Date(2026, 9, 22, 12).getTime() });
const I = (t) => matchIntent(t);
const ops = (app, t) => parseAppRequest(app, t);

// ---------- 1. finding files: plans ----------
const plans = [
  ['Find all PDFs about taxes from last year.', (p) => p.exts.includes('pdf') && p.topic.includes('taxes') && new Date(p.after).getFullYear() === 2025],
  ["Find Word documents that mention 'Q3 budget proposal' inside the text.", (p) => p.exts.includes('docx') && p.topic.includes('q3 budget proposal') && p.inside],
  ['Show me spreadsheets created in the last 30 days larger than 10 MB.', (p) => p.exts.includes('xlsx') && p.createdAfter && !p.after && p.minSize === 10 * 1048576 && !p.topic.length],
  ['Find all files on my C: drive modified today.', (p) => p.scope === 'drive:C' && p.after && !p.topic.length],
  ['Search every drive for files matching the regex ^INV-[0-9]{4}\\.pdf$.', (p) => p.scope === 'everywhere' && p.regex === '^INV-[0-9]{4}\\.pdf$'],
  ['Find all .env or configuration files in my projects folder.', (p) => p.exts.includes('env') && p.exts.includes('ini') && p.folderName === 'projects'],
  ["Find markdown files that contain the phrase 'TODO' or 'FIXME'.", (p) => p.exts.includes('md') && p.topic.includes('todo') && p.topic.includes('fixme') && p.inside],
  ["Show me all files I downloaded this week that aren't images.", (p) => p.scope === 'downloads' && p.after && p.excludeExts?.includes('jpg') && !p.exts.length],
  ['Find all .exe and .msi installers across my Downloads and Desktop folders.', (p) => p.exts.join() === 'exe,msi' && p.scopes?.join() === 'downloads,desktop'],
  ['Search inside .json files for the key apiKey.', (p) => p.exts.join() === 'json' && p.contentText === 'apiKey' && p.inside],
  ['Find pictures of a dog on grass.', (p) => p.kinds.includes('image') && p.topic.join(' ') === 'dog grass'],
  ['Show me all pictures Where the dominant color is blue.', (p) => p.color === 'blue'],
  ['Find all photos taken with my Sony camera or an iPhone.', (p) => p.cameras?.join() === 'sony,iphone'],
  ['Find photos taken in 2024 that have GPS location data.', (p) => p.gps && new Date(p.takenAfter).getFullYear() === 2024 && !p.after && !p.topic.length],
  ['Show me all portrait-orientation photos wider than 2000 pixels.', (p) => p.orient === 'portrait' && p.minW === 2000],
  ['Find all songs in my Music folder around 120 BPM.', (p) => p.scope === 'music' && p.minBpm === 116 && p.maxBpm === 124],
  ['Show me songs in the key of G minor or compatible keys.', (p) => p.key === '6A' && p.keyCompat],
  ['Find videos longer than 20 minutes that are encoded in HEVC.', (p) => p.minDur === 1200 && p.vcodec === 'hevc'],
  ['Find all audio files shorter than 30 seconds (sound effects).', (p) => p.maxDur === 30 && p.kinds.includes('audio')],
  // ---------- 2. space & counting ----------
  ['How much space do videos take up in this folder?', (p) => p.action === 'size' && p.scope === 'here' && p.kinds.includes('video')],
  ['Count how many .jpg and .png files are in this directory and all its subfolders.', (p) => p.action === 'count' && p.exts.join() === 'jpg,png' && p.scope === 'here' && p.recursive],
  ['What are the top 20 largest files on my D: drive?', (p) => p.top === 20 && p.sortBy === 'size' && p.scope === 'drive:D' && !p.minSize],
  ['Find exact duplicate files in this folder using hash checking and keep only the newest in each group.', (p) => p.duplicates && p.action === 'find'],
  ['Find old versions of the same document in my Documents folder.', (p) => p.oldVersions && p.scope === 'documents'],
  ['Find all empty folders inside this directory and delete them.', (p) => p.emptyDirs && p.action === 'delete' && p.scope === 'here'],
  ['Find temporary files, .tmp files, and old installers older than a year and preview them before deleting.', (p) => p.action === 'delete' && p.exts.includes('tmp') && p.exts.includes('exe') && p.before && !p.topic.length],
  ["Show me large files I haven't opened in over 6 months.", (p) => p.notOpenedBefore && p.minSize === 100 * 1048576],
  // ---------- 3. moving & organizing ----------
  ['Move all screenshots from Downloads to Pictures\\Screens.', (p) => p.action === 'move' && p.scope === 'downloads' && p.dest === 'Pictures\\Screens' && p.kinds.includes('screenshot')],
  ['Copy all .mp3 and .flac files from this folder and its subfolders into Music\\Unsorted.', (p) => p.action === 'copy' && p.exts.join() === 'mp3,flac' && p.recursive && p.dest === 'Music\\Unsorted'],
  ['Move all PDFs here into folders organized by the year they were created.', (p) => p.action === 'group' && p.groupBy === 'byYear' && p.exts.join() === 'pdf' && !p.createdAfter],
  ['Put each selected file into its own individual folder named after the file.', (p) => p.action === 'group' && p.groupBy === 'own' && p.scope === 'selection'],
  ['Collect all .psd files from these three folders into the Drop Shelf so I can move them together.', (p) => p.action === 'shelf' && p.exts.join() === 'psd' && !p.topic.length],
  ['Group these files by topic based on their filenames (e.g., put poodle photos into the Poodles folder).', (p) => p.action === 'group' && p.groupBy === 'byName' && !p.kinds.length],
  // ---------- 4. renaming ----------
  ['Rename these PDFs using their actual text contents (like the document title or invoice heading).', (p) => p.action === 'rename' && p.renameMode === 'content'],
  ["Rename all photos in this folder by their EXIF 'Date Taken' in YYYY-MM-DD_HH-mm format.", (p) => p.action === 'rename' && p.scope === 'here' && p.exts.includes('jpg') && !p.topic.length],
  ['Add today\'s date as a prefix to all selected files.', (p) => p.action === 'rename' && !p.after],
  ['Replace spaces with underscores and convert all filenames here to lowercase.', (p) => p.action === 'rename' && p.scope === 'here'],
  ['Remove everything inside brackets [...] or parentheses (...) from these video filenames.', (p) => p.action === 'rename' && p.exts.includes('mp4')],
  ['Number these files sequentially as Project_ Asset_001, 002, 003.', (p) => p.action === 'rename'],
  ['Change the file extension of all .jpeg files here to .jpg.', (p) => p.action === 'rename' && p.exts.join() === 'jpeg' && p.newExt === 'jpg'],
  // ---------- 5/6 ----------
  ['Tag all selected files Red and Blue.', (p) => p.action === 'tag' && p.tags.join() === 'red,blue'],
  ['Zip these selected files into Project_Backup.zip.', (p) => p.action === 'zip' && p.zipName === 'Project_Backup.zip'],
];
for (const [t, test] of plans) { const p = P(t, /selected|these|this file/.test(t)); ok(test(p), 'plan: ' + t, p); }

// ---------- actions the assistant recognises ----------
const intents = [
  ['Find photos that look like this selected image.', 'similarTo'],
  ['Find screenshots vs. camera photos vs. artwork in this folder.', 'classifyPics'],
  ['Break down the storage space in this folder by file type and age.', 'cleanup'],
  ['Open the Disk Space Analyzer treemap for my C: drive.', 'analyze'],
  ['Calculate the exact total size of the files I have selected right now.', 'selSize'],
  ['Scan my Pictures folder for similar-looking burst photos so I can review and delete the extras.', 'similarPics'],
  ['Empty my Recycle Bin and tell me how much space was recovered.', 'emptyRecycle'],
  ['Copy the selected files to the other open pane, skipping identical files and replacing older ones.', 'toOtherPane', (x) => x.conflict === 'newer' && x.mode === 'copy'],
  ['Create a symbolic link to this folder on my Desktop.', 'symlink', (x) => x.where === 'desktop'],
  ['Tidy up this messy folder and preview where everything will go with reasons.', 'declutter'],
  ['Group this view by file kind, or group these files by tag.', 'viewGroup', (x) => x.by === 'type'],
  ['Flatten this folder so I can see every file inside all subfolders in a single list.', 'flatten'],
  ['Create an automation rule for my Downloads folder: whenever a .zip arrives, move it to Archives; whenever a .dmg or .exe arrives, tag it Red.', 'automation', (x) => x.rules.length === 2 && x.rules[0].action.type === 'move' && x.rules[0].action.target === 'Archives' && x.rules[1].action.tag === 'red' && x.rules[1].conditions[0].value === 'dmg, exe'],
  ['Create an automation that recycles .log files in this folder once they are older than 14 days.', 'automation', (x) => x.rules[0].action.type === 'recycle' && x.rules[0].conditions.some((c) => c.field === 'age' && c.num === 14)],
  ["Create a Smart Collection in my sidebar for all files tagged 'Urgent' or rated 5 stars.", 'collection', (x) => x.tags.includes('Urgent') && x.stars === 5],
  ['Save my current rename pattern as a preset in Rename Studio.', 'renamePreset'],
  ['Auto-tag the files in this folder based on their type and content.', 'autoTag'],
  ['Write my Dogfile tags directly into the Windows file properties of these JPG and Word files so File Explorer can see them.', 'writeTags'],
  ['Give all selected photos a 5-star rating and a Green color label.', 'rate', (x) => x.stars === 5 && x.label === 'green'],
  ["Add a note to this selected contract PDF saying 'Waiting on legal signature from Sarah'.", 'note', (x) => x.text === 'Waiting on legal signature from Sarah'],
  ['Add a folder note to the top of this project directory with a to-do checklist: [ ] Draft spec, [ ] Review assets, [ ] Ship build.', 'folderNote', (x) => x.items.join('|') === 'Draft spec|Review assets|Ship build'],
  ['Change the Author and Title properties on these Word .docx and PDF files.', 'docProps', (x) => x.fields.join() === 'author,title'],
  ['Auto-fill the missing artist, album, and cover art for these MP3s using MusicBrainz / iTunes.', 'songDetails', (x) => !x.identify],
  ['Identify this untagged audio file by its sound using AcoustID.', 'songDetails', (x) => x.identify],
  ['Analyze the BPM and musical key for every song in this folder.', 'analyzeAudio'],
  ['Extract this .rar or .iso file into its own clean folder.', 'extract', (x) => x.ownFolder],
  ['Convert this .rar archive into a .7z or .zip file.', 'convertArchive', (x) => x.format === '7z'],
  ['Test this archive to make sure none of the files inside are corrupted.', 'testArchive'],
  ['Delete the thumbs.db file from inside this .zip without extracting the whole archive.', 'archiveDelete', (x) => x.name === 'thumbs.db'],
  ['Save a snapshot version of this file before I edit it.', 'snapshot'],
  ['Turn on automatic version tracking for this spreadsheet so every save is backed up.', 'trackVersions', (x) => x.on],
  ['Restore the version of this file from yesterday at 3 PM.', 'restoreVersion'],
  ['Generate a .sha256 checksum file for all files in this release folder.', 'makeChecksums', (x) => x.algo === 'sha256'],
  ['Verify this .sha256 file and tell me if any files have been altered or corrupted.', 'verifyChecksums'],
  ['Show me my file operation history from earlier today and undo the folder rename I did 20 minutes ago.', 'history', (x) => x.undo && x.what === 'renamed' && x.minutesAgo === 20 && x.folder],
  ['Tell me what program or process is currently locking this file so I can delete it.', 'whoLocks'],
  ['Batch convert all .png and .webp pictures in this folder into .jpg.', 'convertImages', (x) => x.format === 'jpg'],
  ['Rotate these photos 90 degrees clockwise and flip them horizontally.', 'transformPics', (x) => x.rotate === 90 && x.flipH && !x.flipV],
  ['Generate a text transcript (speech-to-text) of this lecture video.', 'transcript'],
  ['Make a video contact sheet (thumbnail grid preview) of this movie file.', 'contactSheet'],
  ['Convert all .flac and .wav audio files in this folder to 320kbps .mp3.', 'convertMedia', (x) => x.format === 'mp3' && x.bitrate === 320],
  ['Open the built-in terminal drawer right here in the active folder.', 'terminal', (x) => x.drawer],
  ['Run this .ps1 / .py / .bat script in the terminal.', 'runScript'],
  ['Open an Administrator PowerShell window in this directory.', 'adminShell', (x) => x.kind === 'powershell'],
  ['Copy the full paths of all selected files formatted with forward slashes (or as a JSON array / quoted list).', 'copyPaths', (x) => x.fmt === 'forward'],
  ['Show me which files in this Git repository have uncommitted changes.', 'gitStatus'],
  ['Open this folder in my code editor (VS Code / Cursor).', 'codeEditor'],
  ['Show me the hexadecimal binary view of this .exe or .bin file.', 'hex'],
  ['Compare and sync my local build folder with the backup folder on my D: drive (mirror left to right).', 'compare', (x) => x.mirror],
  ['Switch Dogfile and all open apps (Notepad, Photos, Player) to Dark Mode.', 'theme', (x) => x.theme === 'dark'],
  ['Switch to Touch Mode density so the rows are bigger for my touchscreen.', 'density', (x) => x.density === 'touch'],
  ['Switch the interface from Full mode to Simple mode to hide advanced ribbon buttons.', 'uiMode', (x) => x.mode === 'simple'],
  ["Turn on 'Show hidden files' and 'Show file extensions'.", 'toggles', (x) => x.set.showHidden === true && x.set.showExtensions === true],
  ['Turn on folder size badges so I can see how big every subfolder is immediately.', 'toggles', (x) => x.set.folderSizes === true],
  ['Change my current view to a 4-pane grid layout (Ctrl+Alt+5) and turn on Sync Browsing between panes.', 'layout', (x) => x.panes === 4 && x.sync === true],
  ["Switch to the 'Development' or 'Music' profile.", 'profile', (x) => x.name === 'Development'],
  ["Save all my currently open tabs, split panes, and Notepad files as a Workspace called 'Tax Prep'.", 'workspace', (x) => x.save && x.name === 'Tax Prep'],
  ['Export all my Dogfile settings, tags, and custom colors to a backup file.', 'exportSettings'],
  ['Connect to my NAS SMB share or SFTP server and mount it in the sidebar.', 'connect', (x) => x.type === 'smb' && x.both],
  ['Add my Google Drive / OneDrive / S3 account without installing their desktop sync app, and leave cloud-only files un-downloaded during searches.', 'connect', (x) => x.type === 'gdrive' && x.cloudOnlyNote],
  ['Record a macro of my next steps and set it to run automatically every Friday at 5 PM (or whenever new files land in my Inbox folder).', 'macro', (x) => x.trigger.mode === 'weekly' && x.trigger.day === 5 && x.trigger.at === '17:00' && x.trigger.folder === 'inbox'],
  ['How do I use Dialog Jump (Ctrl+G) to jump to my current Dogfile folder inside another program\'s Save dialog?', 'help'],
  ['What is the keyboard shortcut to select files by pattern or open the Drop Shelf?', 'help'],
  ['Why did my file copy fail, and how do I retry only the failed files in the Operations Queue?', 'help'],
  ['How do I set Dogfile Player as the default app for .mkv files and Dogfile as my default Windows file manager (Win+E)?', 'help'],
  ['Write a custom .dogmod feature script using the atlas.files API that adds a right-click menu item to combine selected .txt files into one master file.', 'writeFeature'],
  ['Check my .dogmod script for missing header permissions and explain what atlas.net.fetch needs to work.', 'checkFeature', (x) => x.api === 'atlas.net.fetch'],
  ['turn on the glass sidebar', 'glass', (x) => x.on],
  ['turn off the aero sidebar', 'glass', (x) => !x.on],
];
for (const [t, id, test] of intents) { const x = I(t); ok(x?.id === id && (!test || test(x)), `intent ${id}: ${t}`, x); }
// requests that must stay plain file searches (no action steals them)
for (const t of plans.map((p) => p[0]).filter((t) => !/^(Tag|Zip|Change the file extension)/.test(t))) { const x = I(t); ok(!x, 'no intent: ' + t, x); }

// ---------- 7. inside Notepad, Photos and the Player ----------
const apps = [
  ['editor', 'Remove all empty lines, sort the remaining lines alphabetically, and remove duplicates.', ['lines:removeEmpty', 'lines:sortAsc', 'lines:unique']],
  ['editor', "Replace all British spellings like 'colour' and 'analyse' with US English, then convert headings to Title Case.", ['spelling:us', 'case:title']],
  ['editor', 'Format and prettify this minified JSON (or minify it for production).', ['json:']],
  ['editor', 'Convert these selected CSV lines into a clean Markdown table.', ['table:md']],
  ['editor', 'Encode this selected text into Base64 (or URL-decode this string).', ['encode:base64']],
  ['editor', 'How many words, lines, and characters are in this document?', ['count:']],
  ['editor', 'Compare this open text file with config.backup.json and jump to the differences.', ['compareWith:']],
  ['editor', "Convert this file's encoding to UTF-8 without BOM and change line endings from CRLF to LF.", ['encoding:', 'eol:']],
  ['viewer', 'Erase all drawings on this photo and apply the Sepia filter.', ['clearDrawing:', 'adjust:']],
  ['viewer', 'Resize this image to 800 pixels wide while keeping the aspect ratio.', ['resize:']],
  ['viewer', 'Crop this photo to a 1:1 square centered on the image.', ['cropAspect:', 'applyCrop:']],
  ['viewer', 'Extract and copy all readable text from this screenshot using OCR.', ['ocr:']],
  ['viewer', 'Pixelate the selected area with a block size of 15 and save as a copy.', ['pixelate:', 'saveCopy:']],
  ['viewer', 'Rotate these photos 90 degrees clockwise and flip them horizontally.', ['rotateR:', 'flip:']],
  ['player', 'Play this video at 1.5x speed, skip ahead 30 seconds, and lower the volume by 20%.', ['speed:', 'seek:', 'volume:']],
  ['player', 'Generate a text transcript (speech-to-text) of this lecture video.', ['transcript:']],
  ['player', 'Make a video contact sheet (thumbnail grid preview) of this movie file.', ['contactSheet:']],
  ['player', 'Trim this video from 01:15 to 04:30 using a fast lossless cut.', ['trim:']],
  ['player', 'Set an A-B repeat loop between 00:45 and 01:10 so I can practice this guitar solo.', ['ab:']],
  ['player', 'Delay the subtitles by 500ms so they match the audio.', ['subDelay:']],
];
const key = (s) => `${s.op}:${s.arg?.fn || (['case', 'spelling', 'table'].includes(s.op) ? s.arg?.to : s.op === 'encode' ? s.arg?.kind : '') || ''}`;
for (const [app, t, want] of apps) { const r = ops(app, t); const got = r.steps.map(key); ok(r.rest.length === 0 && got.join() === want.join(), `${app}: ${t}`, { got, rest: r.rest }); }
{ const r = ops('player', 'Play this video at 1.5x speed, skip ahead 30 seconds, and lower the volume by 20%.'); ok(r.steps[0].arg.set === 1.5 && r.steps[1].arg.by === 30 && r.steps[2].arg.delta === -20, 'player numbers', r.steps); }
{ const r = ops('player', 'Trim this video from 01:15 to 04:30 using a fast lossless cut.'); ok(r.steps[0].arg.from === 75 && r.steps[0].arg.to === 270 && r.steps[0].arg.mode === 'fast', 'trim times', r.steps); }
{ const r = ops('player', 'Set an A-B repeat loop between 00:45 and 01:10 so I can practice this guitar solo.'); ok(r.steps[0].arg.a === 45 && r.steps[0].arg.b === 70, 'ab times', r.steps); }
{ const r = ops('player', 'Delay the subtitles by 500ms so they match the audio.'); ok(r.steps[0].arg.by === 0.5, 'sub delay', r.steps); }
{ const r = ops('viewer', 'Pixelate the selected area with a block size of 15 and save as a copy.'); ok(r.steps[0].arg.block === 15, 'pixelate block', r.steps); }
{ const r = ops('editor', "Convert this file's encoding to UTF-8 without BOM and change line endings from CRLF to LF."); ok(r.steps[0].arg.enc === 'utf8' && r.steps[1].arg.kind === 'lf', 'encoding + eol', r.steps); }
{ const r = ops('editor', 'Compare this open text file with config.backup.json and jump to the differences.'); ok(r.steps[0].arg.file === 'config.backup.json', 'compare file', r.steps); }

// ---------- renaming in words ----------
const rn = [
  ["Rename all photos in this folder by their EXIF 'Date Taken' in YYYY-MM-DD_HH-mm format.", (r) => r.template === '{taken:yyyy-mm-dd_hh-min}'],
  ['Rename these MP3 files using their ID3 tags as TrackNumber - Artist - Title.', (r) => r.template === '{track} - {artist} - {title}'],
  ["Add today's date as a prefix to all selected files.", (r) => /^\d{4}-\d{2}-\d{2} $/.test(r.prefix)],
  ['Replace spaces with underscores and convert all filenames here to lowercase.', (r) => r.spaces && r.caseMode === 'lowercase'],
  ['Remove everything inside brackets [...] or parentheses (...) from these video filenames.', (r) => r.regex && r.find && r.replace === ''],
  ['Number these files sequentially as Project_ Asset_001, 002, 003.', (r) => r.template === 'Project_Asset_{n:3}' && r.start === 1],
  ['Change the file extension of all .jpeg files here to .jpg.', (r) => r.newExt === 'jpg'],
];
for (const [t, test] of rn) { const r = interpretRename(t); ok(test(r), 'rename: ' + t, r); }

// ---------- helpers ----------
ok(camelotOf('g', 'minor') === '6A' && camelotOf('c', 'major') === '8B' && camelotOf('f#', 'm') === '11A', 'camelot', null);
{ const s = parseSchedule('every day at 8:30 am'); ok(s.mode === 'daily' && s.at === '08:30', 'schedule daily', s); }
{ const s = parseSchedule('every 30 minutes'); ok(s.mode === 'every' && s.minutes === 30, 'schedule every', s); }
{ const r = parseAutomation('whenever a PDF arrives, move it to Documents\\PDFs'); ok(r[0]?.conditions[0].value === 'Documents' && r[0].action.target === 'Documents\\PDFs', 'automation by kind', r); }
{ const f = featureFromRequest('Write a custom .dogmod feature script using the atlas.files API that adds a right-click menu item to combine selected .txt files into one master file.'); ok(f.known && /addMenuItem/.test(f.code) && /@permissions read write/.test(f.code) && /'txt'|"txt"/.test(f.code) && /Master\.txt/.test(f.code), 'feature: combine', f.name); try { new Function(f.code.replace(/^\/\/.*$/gm, '')); pass++; } catch (e) { fail++; console.log('FAIL feature code does not parse', e.message); } }
{ const f = featureFromRequest('make a feature that uploads the selected photos to my website'); ok(!f.known && /@permissions.*network/.test(f.code) && /TODO/.test(f.code), 'feature: outline', f.code.slice(0, 200)); try { new Function(f.code.replace(/^\/\/.*$/gm, '')); pass++; } catch (e) { fail++; console.log('FAIL outline does not parse', e.message); } }

console.log(fail ? `${fail} failed, ${pass} passed` : `all ${pass} passed`);
process.exit(fail ? 1 : 0);
