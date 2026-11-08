// Makes the downloadable parts of Dogfile (backend/src/components.rs): zips of the media engine, text recognition and
// the AI runtime, named after their checksums so an old program always finds the exact file it was built with.
//   node build/make-components.mjs <out dir> [--ffmpeg <ffmpeg-win64-shared.zip>] [--psd <dogfile-psd.zip>] [--web-only]
// Writes <out dir>/<name>-<first 12 of sha256>.zip and <out dir>/components.json { name: { file, sha256, size } }.
// CI uploads the zips to the "components" release and puts each address, checksum and size into the build's environment
// (DOGFILE_FFMPEG_…, DOGFILE_OCR_…, DOGFILE_ORT_…, DOGFILE_PSD_…).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const ffZip = opt('--ffmpeg');
const psdZip = opt('--psd');
const out = path.resolve(argv[0] || path.join(root, 'dist', 'components'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(out, '_'));

const win = process.platform === 'win32';
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const unzip = (zip, dir) => (win ? execFileSync(tar, ['-xf', zip, '-C', dir]) : execFileSync('unzip', ['-q', zip, '-d', dir]));
/** zip the files (paths inside `dir`) into `file`, in a fixed order with a fixed date: the same parts always make the same
 * zip, so CI doesn't upload a new copy of an unchanged part every time */
const zip = (file, dir, names) => {
  const all = names.flatMap((n) => (fs.statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)).map((f) => path.relative(dir, f).split(path.sep).join('/')) : [n])).sort();
  const when = new Date('2020-01-01T00:00:00Z');
  for (const f of all) fs.utimesSync(path.join(dir, f), when, when);
  if (win) execFileSync(tar, ['-a', '-cf', file, '-C', dir, ...all]);
  else execFileSync('zip', ['-q', '-9', '-X', file, ...all], { cwd: dir });
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const made = {};
const publish = (name, file) => {
  const sha = sha256(file);
  const final = path.join(out, `${name}-${sha.slice(0, 12)}.zip`);
  fs.renameSync(file, final);
  made[name] = { file: path.basename(final), sha256: sha, size: fs.statSync(final).size };
  console.log(`${name}: ${path.basename(final)} ${(made[name].size / 1048576).toFixed(1)} MB`);
};

// text recognition and the AI runtime: the interface's own vendor folders, unpacked next to each other at run time
const vendor = path.join(root, 'src', 'renderer', 'vendor');
for (const [name, folder] of [['ocr', 'tesseract'], ['ort', 'ort']]) {
  const f = path.join(tmp, `${name}.zip`);
  const stage = path.join(tmp, `stage-${name}`);
  fs.cpSync(path.join(vendor, folder), path.join(stage, folder), { recursive: true });
  zip(f, stage, [folder]);
  publish(name, f);
}

// the Photoshop helper: the folder PyInstaller made (dogfile-psd.exe and its libraries), already zipped by CI
if (psdZip) {
  const f = path.join(tmp, 'psd.zip');
  fs.copyFileSync(psdZip, f);
  publish('psd', f);
}

// the media engine: ffmpeg + ffprobe and their libraries (no ffplay), flat, with the licence
if (ffZip) {
  const x = path.join(tmp, 'ff'); fs.mkdirSync(x);
  unzip(ffZip, x);
  const base = fs.readdirSync(x).map((d) => path.join(x, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
  if (!base) { console.error('no bin/ffmpeg.exe in ' + ffZip); process.exit(1); }
  const stage = path.join(tmp, 'ffstage'); fs.mkdirSync(stage);
  for (const f of fs.readdirSync(path.join(base, 'bin'))) if (f !== 'ffplay.exe') fs.copyFileSync(path.join(base, 'bin', f), path.join(stage, f));
  if (fs.existsSync(path.join(base, 'LICENSE.txt'))) fs.copyFileSync(path.join(base, 'LICENSE.txt'), path.join(stage, 'LICENSE-ffmpeg.txt'));
  fs.writeFileSync(path.join(stage, 'README.txt'), 'FFmpeg (https://ffmpeg.org) builds by BtbN (https://github.com/BtbN/FFmpeg-Builds), licensed under the GPL; the source is at https://github.com/FFmpeg/FFmpeg. Downloaded by Dogfile the first time it plays or converts a format Windows can\'t handle by itself.\r\n');
  const f = path.join(tmp, 'ffmpeg.zip');
  zip(f, stage, fs.readdirSync(stage));
  publish('ffmpeg', f);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(out, 'components.json'), JSON.stringify(made, null, 2));
