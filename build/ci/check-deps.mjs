// Which DLLs does each program in a folder need to start?  The Microsoft Store refuses a package whose programs need software
// that is neither inside the package nor part of Windows ("doesn't disclose dependencies on non-integrated software":
// MSVCP140.dll was the first one it found missing). This reads the import tables of every .exe / .dll under the given
// paths (no tools needed, runs anywhere) and sorts what they ask for:
//   windows   part of Windows itself (api-ms-win-*, kernel32, user32, the Universal C Runtime that ships with Windows 10…)
//   bundled   a DLL sitting next to the program, or anywhere in the package
//   RUNTIME   the Visual C++ runtime (vcruntime140, msvcp140, vcomp140…): NOT part of Windows. Link it in (crt-static) or ship it.
//   MISSING   something else that is neither in Windows nor in the package
// Exit code 1 when any RUNTIME or MISSING line shows up. `--allow-runtime` turns RUNTIME into a warning (for parts the app
// downloads later, which the Store package doesn't contain). `--selftest` checks the reader on a program made in memory.
//   node build/ci/check-deps.mjs dist/Dogfile
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = /^(vcruntime\d+(_\d+|_threads)?|msvcp\d+(_\d+|_atomic_wait|_codecvt_ids)?|msvcr\d+|vcomp\d+|concrt\d+|vccorlib\d+|libomp\d*(\.\w+)?|mfc\d+\w*)\.dll$/i;
// DLLs every Windows 10/11 has (the list is long on purpose: a missing name here is a false alarm, never a hidden dependency)
const WINDOWS = /^(api-ms-win-.*|ext-ms-.*|ucrtbase|kernel32|kernelbase|user32|gdi32|gdi32full|advapi32|shell32|shlwapi|ole32|oleaut32|combase|comctl32|comdlg32|crypt32|cryptsp|bcrypt|bcryptprimitives|ncrypt|secur32|sspicli|ws2_32|wsock32|mswsock|iphlpapi|dnsapi|winhttp|wininet|urlmon|netapi32|userenv|version|winmm|setupapi|cfgmgr32|powrprof|psapi|dbghelp|dbgcore|imm32|msvcrt|ntdll|rpcrt4|uxtheme|dwmapi|dxgi|d3d9|d3d11|d3d12|d3dcompiler_47|dcomp|d2d1|dwrite|windowscodecs|propsys|shcore|wtsapi32|wintrust|normaliz|msimg32|opengl32|glu32|netapi32|ntmarta|authz|mpr|oledlg|winspool\.drv|wldap32|rstrtmgr|taskschd|wevtapi|pdh|mf|mfplat|mfreadwrite|evr|avrt|dsound|dinput8|xinput1_4|hid|cabinet|fltlib|msi|wbemuuid|virtdisk|uiautomationcore|usp10|d3d10warp|bcp47langs|cldapi|ntshrui|dwmapi|dpapi|credui|ksuser|ole32|winusb)\.(dll|drv)$/i;

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
/** the DLL names a Windows program file asks for (normal imports and delay-loaded ones) */
export function imports(buf) {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = u32(buf, 0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  const nSec = u16(buf, pe + 6), optSize = u16(buf, pe + 20), opt = pe + 24;
  const magic = u16(buf, opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const sec = opt + optSize;
  const rva = (r) => {
    for (let i = 0; i < nSec; i++) {
      const s = sec + i * 40, va = u32(buf, s + 12), raw = u32(buf, s + 20), size = Math.max(u32(buf, s + 8), u32(buf, s + 16));
      if (r >= va && r < va + size) return r - va + raw;
    }
    return -1;
  };
  const str = (o) => { let e = o; while (e < buf.length && buf[e]) e++; return buf.toString('latin1', o, e); };
  const out = new Set();
  const table = (dirIndex, size, nameAt) => {
    const o = dirs + dirIndex * 8;
    if (o + 8 > buf.length || o > sec) return;
    const r = u32(buf, o);
    let p = r ? rva(r) : -1;
    if (p < 0) return;
    for (; p + size <= buf.length; p += size) {
      if (buf.subarray(p, p + size).every((x) => x === 0)) break;
      const n = rva(u32(buf, p + nameAt));
      if (n >= 0) out.add(str(n));
    }
  };
  table(1, 20, 12);   // imports
  table(13, 32, 4);   // delay-load imports
  return [...out];
}

const walk = (d) => fs.statSync(d).isDirectory() ? fs.readdirSync(d).flatMap((n) => walk(path.join(d, n))) : [d];

export function check(paths, { allowRuntime = false } = {}) {
  const files = paths.flatMap(walk).filter((f) => /\.(exe|dll)$/i.test(f));
  const have = new Set(files.map((f) => path.basename(f).toLowerCase()));
  const sys = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : null;
  const rows = [];
  let bad = 0;
  for (const f of files) {
    const dlls = imports(fs.readFileSync(f));
    if (!dlls) continue;
    for (const d of dlls) {
      const n = d.toLowerCase();
      let kind;
      if (have.has(n)) kind = 'bundled';
      else if (RUNTIME.test(n)) kind = 'RUNTIME';
      else if (WINDOWS.test(n) || (sys && fs.existsSync(path.join(sys, d)) && !/^(vc|msvcp|concrt)/i.test(n))) kind = 'windows';
      else kind = 'MISSING';
      rows.push({ file: f, dll: d, kind });
      if (kind === 'MISSING' || (kind === 'RUNTIME' && !allowRuntime)) bad++;
    }
  }
  return { files: files.length, rows, bad };
}

// ---- self-test: a program built in memory that asks for KERNEL32.dll and MSVCP140.dll
function fakePE(names) {
  const b = Buffer.alloc(0x600);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80); b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(1, 0x86); b.writeUInt16LE(240, 0x94);
  const opt = 0x98; b.writeUInt16LE(0x20b, opt);
  const dirs = opt + 112; b.writeUInt32LE(0x1000, dirs + 8); b.writeUInt32LE(40, dirs + 12);
  const sec = opt + 240; b.write('.idata', sec); b.writeUInt32LE(0x400, sec + 8); b.writeUInt32LE(0x1000, sec + 12); b.writeUInt32LE(0x400, sec + 16); b.writeUInt32LE(0x200, sec + 20);
  let name = 0x200 + 20 * (names.length + 1) + 0x40;
  names.forEach((n, i) => { b.writeUInt32LE(0x1000 + (name - 0x200), 0x200 + i * 20 + 12); b.write(n + '\0', name); name += n.length + 1; });
  return b;
}
if (process.argv.includes('--selftest')) {
  const got = imports(fakePE(['KERNEL32.dll', 'MSVCP140.dll']));
  if (JSON.stringify(got) !== JSON.stringify(['KERNEL32.dll', 'MSVCP140.dll'])) { console.error('selftest: read', got); process.exit(1); }
  if (!RUNTIME.test('MSVCP140.dll') || !RUNTIME.test('VCRUNTIME140_1.dll') || !RUNTIME.test('VCOMP140.DLL') || RUNTIME.test('KERNEL32.dll') || RUNTIME.test('ucrtbase.dll') || RUNTIME.test('api-ms-win-crt-runtime-l1-1-0.dll')) { console.error('selftest: runtime names'); process.exit(1); }
  console.log('check-deps selftest ok');
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const allowRuntime = args.includes('--allow-runtime');
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) { console.error('usage: node build/ci/check-deps.mjs <folder or file>… [--allow-runtime]'); process.exit(2); }
  const r = check(paths, { allowRuntime });
  const by = new Map();
  for (const x of r.rows) { const k = `${x.dll.toLowerCase()}|${x.kind}`; if (!by.has(k)) by.set(k, { ...x, from: [] }); by.get(k).from.push(path.basename(x.file)); }
  for (const x of [...by.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.dll.localeCompare(b.dll))) {
    if (x.kind === 'windows' && !process.argv.includes('--all')) continue;
    console.log(`${x.kind.padEnd(8)} ${x.dll.padEnd(28)} ${[...new Set(x.from)].slice(0, 6).join(', ')}${x.from.length > 6 ? ', …' : ''}`);
  }
  console.log(`${r.files} program files read, ${r.rows.filter((x) => x.kind === 'windows').length} imports are part of Windows, ${r.bad} problem${r.bad === 1 ? '' : 's'}`);
  if (!r.files) { console.error('no .exe or .dll found: nothing was checked'); process.exit(1); }
  process.exit(r.bad ? 1 : 0);
}
