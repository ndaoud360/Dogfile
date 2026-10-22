// Packs the interface (src/renderer) into app/gen/ui.pak, which the build compiles into Dogfile.exe: no interface
// files ship beside the program. Dogfile's own scripts and styles are minified first; everything is compressed.
//   node build/pack-ui.mjs [--out <file>] [--unpack <dir>]   (--unpack also writes the packed files to a folder, for tests)
// Format: "DGPK" | u32 LE length of the index | deflated JSON index { name: [offset, length] } | deflated files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const src = path.join(root, 'src', 'renderer');
const out = arg('--out') || path.join(root, 'app', 'gen', 'ui.pak');
const unpack = arg('--unpack');

// esbuild from the project, or from ESBUILD_DIR (CI installs just esbuild there: npm install --prefix <dir> esbuild)
let esbuild = null;
try { esbuild = await import('esbuild'); } catch {
  try { if (process.env.ESBUILD_DIR) esbuild = createRequire(path.join(process.env.ESBUILD_DIR, 'x.js'))('esbuild'); } catch { /* reported below */ }
}
if (!esbuild) {
  if (process.env.CI) { console.error('esbuild is missing (npm install --prefix <dir> esbuild, then ESBUILD_DIR=<dir>)'); process.exit(1); }
  console.warn('warning: esbuild is missing, so scripts are packed without minifying');
}

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.map')) files.push(p); } };
walk(src);
files.sort();

const own = (rel) => !rel.startsWith('vendor/');
let index = {}, blobs = [], off = 0, raw = 0, mini = 0;
for (const f of files) {
  const rel = path.relative(src, f).split(path.sep).join('/');
  let data = fs.readFileSync(f);
  raw += data.length;
  if (esbuild && own(rel) && /\.(js|mjs|css)$/.test(rel)) {
    const loader = rel.endsWith('.css') ? 'css' : 'js';
    const r = await esbuild.transform(data.toString('utf8'), { loader, minify: true, keepNames: true, legalComments: 'none', charset: 'utf8', target: 'chrome110' });
    data = Buffer.from(r.code, 'utf8');
  }
  mini += data.length;
  if (unpack) { const u = path.join(unpack, rel); fs.mkdirSync(path.dirname(u), { recursive: true }); fs.writeFileSync(u, data); }
  const z = zlib.deflateRawSync(data, { level: 9 });
  index[rel] = [off, z.length];
  blobs.push(z);
  off += z.length;
}
const idx = zlib.deflateRawSync(Buffer.from(JSON.stringify(index)), { level: 9 });
const head = Buffer.alloc(8);
head.write('DGPK', 0, 'latin1');
head.writeUInt32LE(idx.length, 4);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([head, idx, ...blobs]));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
console.log(`packed ${files.length} files: ${mb(raw)} → ${mb(mini)} minified → ${mb(fs.statSync(out).size)} in ${path.relative(root, out)}`);
