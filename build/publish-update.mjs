// Publishes dist/update/ (made by make-update.mjs) as release v<version> of the public updates repository, marked
// latest, so every installed Dogfile finds it at .../releases/latest/download/latest.json. Only the release is
// created there (its files: the program zips, the setup program, latest.json): no commits, no source.
//   GH_TOKEN=<token that can write to the updates repository> node build/publish-update.mjs
// Run by the publish job in .github/workflows/app.yml when a v<version> tag is pushed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DOGFILE_UPDATES_REPO || 'ndaoud360/dogfile-updates';
const dir = path.join(root, 'dist', 'update');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
// nothing but the program goes public
for (const f of files.filter((f) => f.endsWith('.zip'))) {
  const list = execFileSync('unzip', ['-Z1', f], { encoding: 'utf8' }).trim().split('\n');
  if (list.join() !== 'Dogfile.exe') { console.error(`${path.basename(f)} holds more than Dogfile.exe: ${list.slice(0, 5).join(', ')}`); process.exit(1); }
}
const notes = path.join(dir, '..', 'notes.md');
fs.writeFileSync(notes, m.notes);
const gh = (...a) => execFileSync('gh', a, { stdio: ['ignore', 'inherit', 'inherit'] });
const pre = m.version.includes('-');
let exists = true;
try { execFileSync('gh', ['release', 'view', 'v' + m.version, '-R', REPO], { stdio: 'ignore' }); } catch { exists = false; }
if (exists) gh('release', 'upload', 'v' + m.version, ...files, '--clobber', '-R', REPO);
else gh('release', 'create', 'v' + m.version, ...files, '-R', REPO, '--target', 'main', '--title', `Dogfile ${m.version}`, '--notes-file', notes, ...(pre ? ['--prerelease', '--latest=false'] : ['--latest']));
console.log(`published Dogfile ${m.version} at https://github.com/${REPO}/releases/tag/v${m.version}`);
