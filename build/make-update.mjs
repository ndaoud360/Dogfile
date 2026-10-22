// Makes an update for Dogfile's auto-updater from a packaged folder (node build/package-win.mjs first):
//   node build/make-update.mjs <version> <notes.md> [--ffmpeg]
// Writes dist/update/: Dogfile-<version>-app.zip (the program, interface, 7-Zip, installer), optionally
// ffmpeg-<ver>.zip, and latest.json. Upload all of them to a release named v<version> in the public
// ndaoud360/dogfile-updates repository (node build/publish-update.mjs does that); installed copies see
// latest.json at .../releases/latest/download/latest.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version, notesFile, ...flags] = process.argv.slice(2);
if (!version || !notesFile) { console.error('usage: node build/make-update.mjs <version> <notes.md> [--ffmpeg]'); process.exit(1); }
const REPO = process.env.DOGFILE_UPDATES_REPO || 'ndaoud360/dogfile-updates';
const pkg = path.join(root, 'dist', 'Dogfile');
const out = path.join(root, 'dist', 'update');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const comps = JSON.parse(fs.readFileSync(path.join(pkg, 'components.json'), 'utf8'));
if (comps.app !== version) { console.error(`dist/Dogfile is version ${comps.app}, not ${version}: set the version in app/tauri.conf.json, backend/Cargo.toml and app/Cargo.toml, build, and package again`); process.exit(1); }

const zipOf = (name, dir, entries) => { const f = path.join(out, name); execFileSync('zip', ['-qr', '-9', f, ...entries], { cwd: dir }); return f; };
const info = (id, ver, file) => ({ id, version: ver, url: `https://github.com/${REPO}/releases/download/v${version}/${path.basename(file)}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: fs.statSync(file).size });

const appEntries = fs.readdirSync(pkg).filter((n) => n !== 'ffmpeg' && n !== 'data' && n !== 'portable.txt');
const packages = [info('app', version, zipOf(`Dogfile-${version}-app.zip`, pkg, appEntries))];
if (flags.includes('--ffmpeg') && comps.ffmpeg) packages.push(info('ffmpeg', comps.ffmpeg, zipOf(`ffmpeg-${comps.ffmpeg}.zip`, pkg, ['ffmpeg'])));

// Windows on ARM, when dist/Dogfile-arm64 was packaged too
const armDir = path.join(root, 'dist', 'Dogfile-arm64');
if (fs.existsSync(path.join(armDir, 'components.json'))) {
  const ac = JSON.parse(fs.readFileSync(path.join(armDir, 'components.json'), 'utf8'));
  if (ac.app === version) {
    packages.push({ ...info('app', version, zipOf(`Dogfile-${version}-arm64-app.zip`, armDir, fs.readdirSync(armDir).filter((n) => n !== 'ffmpeg' && n !== 'data' && n !== 'portable.txt'))), arch: 'arm64' });
    if (flags.includes('--ffmpeg') && ac.ffmpeg) packages.push({ ...info('ffmpeg', ac.ffmpeg, zipOf(`ffmpeg-${ac.ffmpeg}-arm64.zip`, armDir, ['ffmpeg'])), arch: 'arm64' });
  }
}
const manifest = { version, date: new Date().toISOString().slice(0, 10), notes: fs.readFileSync(notesFile, 'utf8').trim(), packages };
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
