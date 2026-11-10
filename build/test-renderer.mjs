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

// ---------- 1b. every Pro feature is checked somewhere ----------
// (the engine refuses a list of calls on its own; this is the window's side: a feature that is on the Free vs Pro
// page but is never asked about would simply be free)
const { FEATURES } = await import('../src/renderer/js/pro-marks.js');
const allSrc = Object.entries(src).filter(([f]) => f !== 'license.js').map(([, s]) => s).join('\n');
for (const key of Object.keys(FEATURES)) ok(allSrc.includes(`requirePro('${key}')`), `Pro feature “${key}” is checked with requirePro('${key}') somewhere`, key);
for (const [cmd, feat] of Object.entries((await import('../src/renderer/js/pro-marks.js')).PRO_COMMANDS)) ok(feat in FEATURES, `PRO_COMMANDS.${cmd} names a feature that exists`, feat);

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

// ---------- 3. stem separation maths ----------
const sc = await import('../src/renderer/js/stems-core.js');
{
  const { SEG, segmentStarts, windowWeights, separate, encodeWav, zipParts, crc32, safeName, mixdown, MODEL_ORDER, STEMS } = sc;
  eq(JSON.stringify(segmentStarts(SEG)), '[0]', 'stems: a song that fits one piece is one piece');
  eq(segmentStarts(SEG + 1).length, 2, 'stems: one sample more needs a second piece');
  const st = segmentStarts(SEG * 5 + 17);
  ok(st.at(-1) + SEG >= SEG * 5 + 17, 'stems: the pieces reach the end of the song', st.at(-1));
  ok(st.every((s, i) => i === 0 || s - st[i - 1] === Math.floor(SEG * 0.75)), 'stems: pieces start 75% of a piece apart', st.slice(0, 3));
  const w = windowWeights(1000);
  ok(w[0] > 0 && w[499] === 1 && w[999] > 0 && w.every((x) => x > 0 && x <= 1), 'stems: the fade weights are a triangle between 0 and 1', [w[0], w[499], w[999]]);
  eq(STEMS.length, 6, 'stems: six stems are shown');
  eq([...MODEL_ORDER].sort().join(), STEMS.map((x) => x.key).sort().join(), 'stems: the model order and the shown stems are the same six');
  // a pretend model that returns the whole input as "drums" and half of it as "vocals": joining the pieces must give the song back
  const seg = 1000, len = 3 * seg + 345;
  const left = Float32Array.from({ length: len }, (_, i) => Math.sin(i / 17) * 0.4 + 0.05), right = Float32Array.from({ length: len }, (_, i) => Math.cos(i / 29) * 0.3);
  const fake = async (chunk) => {
    const o = new Float32Array(6 * 2 * seg);
    for (let c = 0; c < 2; c++) for (let i = 0; i < seg; i++) { o[(0 * 2 + c) * seg + i] = chunk[c * seg + i]; o[(MODEL_ORDER.indexOf('vocals') * 2 + c) * seg + i] = chunk[c * seg + i] / 2; }
    return o;
  };
  let steps = 0;
  const r = await separate(left, right, fake, { seg, onProgress: () => steps++ });
  let worst = 0;
  const { mean } = sc.levelOf(left, right); // the song without its constant offset comes back
  for (let i = 0; i < len; i++) worst = Math.max(worst, Math.abs(r.drums[0][i] - (left[i] - mean)), Math.abs(r.drums[1][i] - (right[i] - mean)), Math.abs(r.vocals[0][i] - (left[i] - mean) / 2));
  ok(worst < 1e-4, 'stems: pieces joined back together give the song (the sources add up)', worst);
  ok(steps === segmentStarts(len, seg).length && r.bass[0].every((x) => Math.abs(x) < 1e-6), 'stems: progress is reported for every piece; a silent source stays silent', steps);
  let threw = '';
  try { await separate(left, right, fake, { seg, cancelled: () => true }); } catch (e) { threw = e.message; }
  eq(threw, 'Stopped', 'stems: stopping ends the work');
  threw = '';
  try { await separate(left, right, async () => new Float32Array(10), { seg }); } catch (e) { threw = e.message; }
  ok(/unexpected/.test(threw), 'stems: a wrong-sized answer from the model is an error, not noise', threw);
  const mixed = mixdown({ drums: r.drums, vocals: r.vocals }, { drums: 1, vocals: 0 }, len);
  ok(Math.abs(mixed[0][100] - (left[100] - mean)) < 1e-4, 'stems: a stem at zero volume is left out of the mix', mixed[0][100]);
  // files
  const wav = encodeWav(Float32Array.of(0, 1, -1, 0.5), Float32Array.of(0, -1, 1, 0));
  const dv = new DataView(wav.buffer);
  eq(String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12)), 'RIFFWAVE', 'stems: WAV header');
  eq(wav.length, 44 + 16, 'stems: WAV size');
  eq([dv.getInt16(44 + 4, true), dv.getInt16(44 + 6, true), dv.getInt16(44 + 8, true)].join(), '32767,-32768,-32768', 'stems: WAV samples are 16-bit and clipped, not wrapped');
  eq(dv.getUint32(24, true), 44100, 'stems: WAV sample rate');
  eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'stems: CRC-32 check value');
  const files = [{ name: 'Song (vocals).wav', data: wav }, { name: 'Sóng – bass.wav', data: new Uint8Array(1000).map((_, i) => i * 7) }];
  const zip = zipParts(files, new Date(2026, 10, 2, 12, 30, 10));
  const all = new Uint8Array(zip.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of zip) { all.set(p, o); o += p.length; }
  const zv = new DataView(all.buffer), eocd = all.length - 22;
  eq(zv.getUint32(eocd, true), 0x06054b50, 'stems: ZIP ends with its end record');
  eq(zv.getUint16(eocd + 10, true), 2, 'stems: ZIP lists both files');
  let cp = zv.getUint32(eocd + 16, true), good = 0;
  for (let i = 0; i < 2; i++) {
    const nlen = zv.getUint16(cp + 28, true), size = zv.getUint32(cp + 24, true), lho = zv.getUint32(cp + 42, true), crc = zv.getUint32(cp + 16, true);
    const name = new TextDecoder().decode(all.slice(cp + 46, cp + 46 + nlen));
    const lnl = zv.getUint16(lho + 26, true), data = all.slice(lho + 30 + lnl, lho + 30 + lnl + size);
    if (name === files[i].name && data.length === files[i].data.length && crc32(data) === crc && crc === zv.getUint32(lho + 14, true) && data.every((b, j) => b === files[i].data[j])) good++;
    cp += 46 + nlen;
  }
  eq(good, 2, 'stems: each ZIP entry has its name, size, CRC and bytes right');
  eq(safeName('AC/DC: Back In Black?.mp3 '), 'AC_DC_ Back In Black_.mp3', 'stems: file names lose characters Windows refuses');
  globalThis.__zipForCheck = all;
}

// ---------- 4. colour readability ----------
{
  const T = await import('../src/renderer/js/theme.js');
  const K = await import('../src/renderer/js/contrast.js');
  eq(K.ratio('#000000', '#ffffff'), 21, 'contrast: black on white is 21');
  for (const [n, p] of Object.entries(T.PRESETS)) eq(K.findProblems(p, p.accent).length, 0, `contrast: the built-in theme “${n}” is readable`);
  const bad = { light: { '--text': '#fafafa', '--side-text': '#252525', '--side-bg': '#222222' }, dark: { '--bg-body': '#e0e0e0', '--accent': '#1b1c1f' } };
  ok(K.findProblems(bad).length >= 4, 'contrast: text that matches its background is found');
  const fixed = K.adjust(bad);
  eq(K.findProblems(fixed.colors).length, 0, 'contrast: the adjusted colors are all readable');
  ok(fixed.changes.length > 0, 'contrast: the adjustment lists what it changed');
  let left = 0; const keys = Object.keys(T.DEFAULT_COLORS.light);
  for (let i = 0; i < 200; i++) { const rnd = () => '#' + [0, 0, 0].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(''); const t = { light: {}, dark: {} }; for (const m of ['light', 'dark']) for (const k of keys) if (Math.random() < 0.5) t[m][k] = rnd(); if (K.findProblems(K.adjust(t).colors).length) left++; }
  eq(left, 0, 'contrast: random colour mixes always end up readable');
  const s = K.sanitizeTheme({ name: '<b>x</b>', light: { '--text': '#123456', '--bg': 'url(http://evil)', '--nope': '#ffffff' }, dark: 'x', accent: 'red', shadowStrength: 9 });
  eq(JSON.stringify(s.light), '{"--text":"#123456"}', 'themes: only known colour names with #rrggbb values are kept');
  eq(s.shadowStrength, 2.5, 'themes: shadow strength is limited'); ok(!s.name.includes('<'), 'themes: the name loses markup characters'); eq(s.accent, undefined, 'themes: a colour name that isn’t #rrggbb is dropped');
  eq(K.sanitizeTheme({ light: {} }), null, 'themes: an empty theme is refused');
  {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const t = K.sanitizeTheme({ light: {}, iconTheme: { name: '<i>Neon</i>', icons: { PDF: png, pdf: png, '.docx': png, 'a/b': png, xlsx: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', txt: 'http://evil/x.png', md: png, 'toolongextension': png } } });
    ok(t && t.iconTheme, 'icon themes: an icon theme alone is a usable theme', t);
    eq(Object.keys(t.iconTheme.icons).sort().join(), 'md,pdf', 'icon themes: only real extensions with PNG pictures are kept (no svg, no web addresses, no paths)');
    eq(t.iconTheme.name, 'iNeon/i', 'icon themes: the name is cleaned');
    eq(K.sanitizeTheme({ light: {}, iconTheme: { icons: { pdf: 'data:image/png;base64,' + 'A'.repeat(90000) } } }), null, 'icon themes: a huge picture is refused');
  }
}

// the web pane's address bar
{
  const { resolveInput, buttonsFor } = await import('../src/renderer/js/webaddr.js');
  const S = {};
  eq(resolveInput('example.com', S), 'https://example.com', 'web: a name gets https');
  eq(resolveInput('localhost:3000', S), 'http://localhost:3000', 'web: this computer gets http (https has no certificate there)');
  eq(resolveInput('192.168.1.5/x', S), 'http://192.168.1.5/x', 'web: a home network address gets http');
  eq(resolveInput('münchen.de', S), 'https://münchen.de', 'web: a name with letters outside A-Z is an address, not a search');
  eq(resolveInput('hello world', S), 'https://duckduckgo.com/?q=hello%20world', 'web: words are a search');
  eq(resolveInput('C:\\Windows', S), 'https://duckduckgo.com/?q=C%3A%5CWindows', 'web: a file path is a search, never opened');
  eq(resolveInput('https://a.b/c', S), 'https://a.b/c', 'web: a full address is kept');
  eq(buttonsFor(['image'], { webButtons: [{ name: 'a', url: 'https://a', for: ['any'] }, { name: 'p', url: 'https://p', for: ['image'] }] }).map((b) => b.name).join(), 'p,a', 'web: buttons made for the thing come first');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
