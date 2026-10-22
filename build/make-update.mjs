// Makes an update for Dogfile's auto-updater. An update is just the program: Dogfile.exe carries its interface
// inside (build/pack-ui.mjs), and 7-Zip / ffmpeg stay as the setup program installed them.
//   node build/make-update.mjs <version> <notes.md> [--x64 <Dogfile.exe>] [--arm64 <Dogfile.exe>] [--setup <setup.exe>]
// Writes dist/update/: Dogfile-<version>-app.zip (Dogfile.exe only), Dogfile-<version>-arm64-app.zip,
// Dogfile-<version>-setup.exe and latest.json. build/publish-update.mjs turns them into a release of the public
// ndaoud360/dogfile-updates repository, where installed copies find .../releases/latest/download/latest.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const x64 = opt('--x64') || path.join(root, 'dist', 'Dogfile', 'Dogfile.exe');
const arm = opt('--arm64');
const setup = opt('--setup');
const [version, notesFile] = argv;
if (!version || !notesFile) { console.error('usage: node build/make-update.mjs <version> <notes.md> [--x64 exe] [--arm64 exe] [--setup setup.exe]'); process.exit(1); }
const REPO = process.env.DOGFILE_UPDATES_REPO || 'ndaoud360/dogfile-updates';
const out = path.join(root, 'dist', 'update');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const info = (id, file) => ({ id, version, url: `https://github.com/${REPO}/releases/download/v${version}/${path.basename(file)}`, sha256: sha(file), size: fs.statSync(file).size });
// the zip holds Dogfile.exe and nothing else
const zipExe = (exe, name) => {
  if (!fs.existsSync(exe)) { console.error('missing ' + exe); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(out, '_'));
  fs.copyFileSync(exe, path.join(tmp, 'Dogfile.exe'));
  const f = path.join(out, name);
  execFileSync('zip', ['-q', '-9', f, 'Dogfile.exe'], { cwd: tmp });
  fs.rmSync(tmp, { recursive: true, force: true });
  return f;
};
const packages = [info('app', zipExe(x64, `Dogfile-${version}-app.zip`))];
// Windows on ARM goes in "otherPackages": Dogfile 2.0.x reads only "packages" and would install every "app" there
const otherPackages = arm ? [{ ...info('app', zipExe(arm, `Dogfile-${version}-arm64-app.zip`)), arch: 'arm64' }] : [];
if (setup) fs.copyFileSync(setup, path.join(out, `Dogfile-${version}-setup.exe`));
const manifest = { version, date: new Date().toISOString().slice(0, 10), notes: fs.readFileSync(notesFile, 'utf8').trim(), packages, otherPackages };
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
