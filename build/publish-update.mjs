// Publishes dist/update/ (made by make-update.mjs) as release v<version> in the public updates repository,
// marked as the latest release, so every installed Dogfile finds it. Needs the GitHub CLI (gh) signed in with
// access to that repository.  usage: node build/publish-update.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = process.env.DOGFILE_UPDATES_REPO || 'ndaoud360/dogfile-updates';
const dir = path.join(root, 'dist', 'update');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
const tag = `v${m.version}`;
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const release = JSON.parse(gh('api', '-X', 'POST', `repos/${REPO}/releases`, '-f', `tag_name=${tag}`, '-f', `name=Dogfile ${m.version}`, '-f', `body=${m.notes}`, '-F', 'make_latest=true'));
for (const f of fs.readdirSync(dir)) {
  const file = path.join(dir, f);
  console.log('uploading', f);
  execFileSync('curl', ['-sSf', '-X', 'POST', '-H', `Authorization: Bearer ${gh('auth', 'token').trim()}`, '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${file}`,
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f)}`], { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log('published', release.html_url);
