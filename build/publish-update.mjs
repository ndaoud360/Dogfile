// Publishes dist/update/ (made by make-update.mjs) to the public updates repository: the files are pushed to its
// `outbox` branch, and that repository's own workflow turns them into release v<version>, marked latest, so every
// installed Dogfile finds it at .../releases/latest/download/latest.json.
//   node build/publish-update.mjs            (needs git access to the updates repository)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = process.env.DOGFILE_UPDATES_REPO || 'ndaoud360/dogfile-updates';
const dir = path.join(root, 'dist', 'update');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dogfile-outbox-'));
const git = (...a) => execFileSync('git', a, { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });
git('init', '-q', '-b', 'outbox');
for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(work, f));
// the workflow travels with the files (a push runs the workflow found in the pushed commit)
fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
fs.copyFileSync(path.join(root, 'build', 'updates-repo', 'publish.yml'), path.join(work, '.github', 'workflows', 'publish.yml'));
git('add', '-A');
git('-c', 'user.name=Dogfile release', '-c', 'user.email=releases@dogfile.invalid', 'commit', '-qm', `Dogfile ${m.version}`);
git('push', '-qf', `https://github.com/${REPO}.git`, 'outbox');
console.log(`pushed ${m.version}; the release appears at https://github.com/${REPO}/releases in about a minute`);
