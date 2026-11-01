// node build/test-renderer.mjs — checks for the window code that don't need a window:
//  1. every name imported from another module in src/renderer/js is exported there (a removed or renamed export
//     otherwise only shows up as a blank window or a broken button at run time)
//  2. the path helpers in core.js, which decide what is inside what before moves, copies and deletes
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname as pdir } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/renderer/js/core.js';

let pass = 0, fail = 0;
const ok = (cond, name, got) => { if (cond) pass++; else { fail++; console.log('FAIL', name, '\n     got:', JSON.stringify(got)); } };
const eq = (got, want, name) => ok(got === want, `${name} → ${JSON.stringify(want)}`, got);

// ---------- 1. imports resolve ----------
const dir = join(pdir(fileURLToPath(import.meta.url)), '../src/renderer/js');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const exportsOf = {};
for (const [f, s] of Object.entries(src)) {
  const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) names.add(k); }
  // `export const { a, b } = …` and `export * from` can't be listed this simply: such modules are skipped
  if (/export\s+\*|export\s+(?:const|let)\s*\{/.test(s)) names.add('*');
  exportsOf[f] = names;
}
for (const [f, s] of Object.entries(src)) {
  const check = (list, target, sepRe, how) => {
    const have = exportsOf[target];
    if (!have) return ok(false, `${f} ${how} ./${target}, which doesn't exist`, target);
    if (have.has('*')) return;
    for (const n of list.split(',')) { const k = n.trim().split(sepRe)[0].trim(); if (k) ok(have.has(k), `${f} ${how} “${k}” from ./${target}`, [...have].length); }
  };
  for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)'/g)) check(m[1], m[2], /\s+as\s+/, 'imports');
  for (const m of s.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\('\.\/([\w.-]+\.js)'\)/g)) check(m[1], m[2], /\s*:\s*/, 'loads');
}

// ---------- 2. path helpers ----------
const { sys, normalize, dirname, basename, extname, stem, samePath, isInside, pjoin, expandUserPath } = core;
const asWindows = () => { sys.platform = 'win32'; sys.sep = '\\'; };
const asLinux = () => { sys.platform = 'linux'; sys.sep = '/'; };

asWindows();
eq(normalize('c:/Users/Ann/'), 'C:\\Users\\Ann', 'normalize: slashes, drive case, trailing separator');
eq(normalize('d:'), 'D:\\', 'normalize: bare drive');
eq(normalize('C:\\'), 'C:\\', 'normalize: drive root keeps its separator');
eq(normalize('\\\\srv\\share\\'), '\\\\srv\\share', 'normalize: network share');
eq(dirname('C:\\Users\\Ann'), 'C:\\Users', 'dirname');
eq(dirname('C:\\Users'), 'C:\\', 'dirname: up to the drive');
eq(dirname('C:\\'), 'atlas:thispc', 'dirname: a drive sits in This PC');
eq(dirname('\\\\srv\\share\\x'), '\\\\srv\\share', 'dirname: inside a share');
eq(dirname('\\\\srv\\share'), '\\\\srv', 'dirname: a share sits in its computer');
eq(dirname('atlas:recent'), null, 'dirname: virtual folders have none');
eq(basename('C:\\a\\b.txt'), 'b.txt', 'basename');
eq(basename('C:\\'), 'C:', 'basename: drive');
eq(basename('C:\\a\\b\\'), 'b', 'basename: trailing separator');
eq(pjoin('C:\\', 'x'), 'C:\\x', 'pjoin: at a root');
eq(pjoin('C:\\a', 'x'), 'C:\\a\\x', 'pjoin');
eq(extname('a.TXT'), 'txt', 'extname: lower case');
eq(extname('.env'), '', 'extname: a dot file has no extension');
eq(extname('notes'), '', 'extname: none');
eq(stem('a.b.c'), 'a.b', 'stem: only the last extension');
eq(stem('.env'), '.env', 'stem: dot file');
ok(samePath('C:\\Ann\\', 'c:/ann'), 'samePath: case, slashes and trailing separator don’t matter on Windows');
ok(!samePath('C:\\Ann', ''), 'samePath: empty is never the same');
ok(isInside('C:\\a\\b', 'C:\\a'), 'isInside: child');
ok(isInside('c:\\A\\b\\c', 'C:\\a'), 'isInside: deeper, other case');
ok(!isInside('C:\\ab', 'C:\\a'), 'isInside: a name that only starts the same is not inside');
ok(!isInside('C:\\a', 'C:\\a'), 'isInside: a folder is not inside itself');
ok(isInside('C:\\x', 'C:\\'), 'isInside: a drive root');
ok(!isInside('D:\\a', 'C:\\'), 'isInside: another drive');
ok(!isInside('atlas:recent', 'C:\\'), 'isInside: virtual folders are never inside');
sys.known = { home: 'C:\\Users\\Ann', appData: 'C:\\Users\\Ann\\AppData\\Roaming', downloads: 'C:\\Users\\Ann\\Downloads' };
eq(expandUserPath('%USERPROFILE%\\x'), 'C:\\Users\\Ann\\x', 'expandUserPath: %USERPROFILE%');
eq(expandUserPath('%localappdata%'), 'C:\\Users\\Ann\\AppData\\Local', 'expandUserPath: %LOCALAPPDATA% from AppData');
eq(expandUserPath('~\\docs'), 'C:\\Users\\Ann\\docs', 'expandUserPath: ~');
eq(expandUserPath('shell:downloads'), 'C:\\Users\\Ann\\Downloads', 'expandUserPath: shell: alias');
eq(expandUserPath(' "%NOPE%\\x" '), '%NOPE%\\x', 'expandUserPath: unknown variables and quotes');

asLinux();
eq(normalize('/home/ann/'), '/home/ann', 'normalize (Linux)');
eq(dirname('/home/ann'), '/home', 'dirname (Linux)');
eq(dirname('/home'), '/', 'dirname (Linux): up to the root');
eq(dirname('/'), null, 'dirname (Linux): root has none');
ok(!isInside('/home/annex', '/home/ann'), 'isInside (Linux): name prefix');
ok(isInside('/home/ann/x', '/home/ann/'), 'isInside (Linux): parent with a trailing slash');
ok(!samePath('/Home', '/home'), 'samePath (Linux): case matters');
asWindows();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
