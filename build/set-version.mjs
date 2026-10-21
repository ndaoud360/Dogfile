// Sets Dogfile's version everywhere it's written: node build/set-version.mjs 2.0.1
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v || '')) { console.error('usage: node build/set-version.mjs 2.0.1'); process.exit(1); }
const edit = (f, re, rep) => { const p = path.join(root, f); const s = fs.readFileSync(p, 'utf8'); const n = s.replace(re, rep); if (n === s) console.warn('unchanged:', f); fs.writeFileSync(p, n); };
for (const f of ['app/Cargo.toml', 'backend/Cargo.toml', 'devserver/Cargo.toml']) edit(f, /^version = "[^"]+"/m, `version = "${v}"`);
edit('app/tauri.conf.json', /"version": "[^"]+"/, `"version": "${v}"`);
edit('package.json', /"version": "[^"]+"/, `"version": "${v}"`);
edit('build/win/installer.ps1', /DisplayVersion '[^']+'/, `DisplayVersion '${v}'`);
console.log('version', v);
