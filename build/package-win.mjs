// Builds a ready-to-run Windows x64 folder + zip from the Electron prebuilt and our sources.
// usage: node build/package-win.mjs <electron-win32-x64.zip>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const zip = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist', 'Dogfile');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
execFileSync('unzip', ['-q', zip, '-d', outDir]);

// app payload
const res = path.join(outDir, 'resources');
fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
const app = path.join(res, 'app');
fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, author: pkg.author, license: pkg.license }, null, 2));

// exe: rename + icon + version info
const exe = path.join(outDir, 'Dogfile.exe');
fs.renameSync(path.join(outDir, 'electron.exe'), exe);
const exeData = PELibrary.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
const resData = PELibrary.NtExecutableResource.from(exeData);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'build', 'icon.ico')));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resData.entries, 1, 1033, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(resData.entries)[0];
const [a, b, c] = pkg.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Dogfile', ProductName: 'Dogfile', CompanyName: 'Dogfile', InternalName: 'Dogfile',
  OriginalFilename: 'Dogfile.exe', LegalCopyright: 'MIT License', FileVersion: pkg.version, ProductVersion: pkg.version,
});
vi.outputToResourceEntries(resData.entries);
resData.outputResource(exeData);
fs.writeFileSync(exe, Buffer.from(exeData.generate()));

// built-in terminal: node-pty (N-API prebuilt for Windows x64, no rebuild needed)
const ptySrc = path.join(root, 'node_modules', 'node-pty');
const ptyDst = path.join(app, 'node_modules', 'node-pty');
fs.mkdirSync(ptyDst, { recursive: true });
for (const f of ['package.json', 'LICENSE']) if (fs.existsSync(path.join(ptySrc, f))) fs.copyFileSync(path.join(ptySrc, f), path.join(ptyDst, f));
fs.cpSync(path.join(ptySrc, 'lib'), path.join(ptyDst, 'lib'), { recursive: true, filter: (s) => !s.endsWith('.map') && !s.includes('.test.') });
fs.cpSync(path.join(ptySrc, 'prebuilds', 'win32-x64'), path.join(ptyDst, 'prebuilds', 'win32-x64'), { recursive: true, filter: (s) => !s.endsWith('.pdb') });

// media engine: ffmpeg + ffprobe (shared build) for Dogfile Player
const ffZip = process.argv[3];
if (ffZip) {
  const tmp = path.join(root, 'dist', '_ff');
  execFileSync('unzip', ['-q', ffZip, '-d', tmp]);
  const base = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
  const ffOut = path.join(res, 'ffmpeg');
  fs.mkdirSync(ffOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(base, 'bin'))) if (f !== 'ffplay.exe') fs.copyFileSync(path.join(base, 'bin', f), path.join(ffOut, f));
  if (fs.existsSync(path.join(base, 'LICENSE.txt'))) fs.copyFileSync(path.join(base, 'LICENSE.txt'), path.join(ffOut, 'LICENSE-ffmpeg.txt'));
  fs.writeFileSync(path.join(ffOut, 'README.txt'), 'FFmpeg (https://ffmpeg.org) builds by BtbN (https://github.com/BtbN/FFmpeg-Builds), licensed under the GPL. Used by Dogfile Player to play formats Chromium cannot decode natively.\r\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// archive engine: 7-Zip standalone console (7za.exe) for zip / 7z / tar / gz / xz / bz2 / wim / cab
{
  const zOut = path.join(res, '7zip');
  fs.mkdirSync(zOut, { recursive: true });
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'win32', '7za.exe'), path.join(zOut, '7za.exe'));
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'LICENSE.txt'), path.join(zOut, 'LICENSE.txt'));
  fs.writeFileSync(path.join(zOut, 'README.txt'), '7-Zip standalone console (7za) by Igor Pavlov, https://www.7-zip.org, GNU LGPL. Used by Dogfile for creating and editing archives. Installing the full 7-Zip adds more formats (RAR, ISO and others) automatically.\r\n');
}

// native engine (core/, built for Windows by GitHub Actions; see .github/workflows/build.yml)
{
  const coreExe = [path.join(root, 'bin', 'dogfile-core.exe'), process.argv[4]].filter(Boolean).find((p) => fs.existsSync(p));
  if (coreExe) { fs.mkdirSync(path.join(app, 'bin'), { recursive: true }); fs.copyFileSync(coreExe, path.join(app, 'bin', 'dogfile-core.exe')); }
  else console.warn('warning: bin/dogfile-core.exe not found; the app will use the JavaScript fallback');
}

// installer helpers
for (const f of ['Install Dogfile.cmd', 'Uninstall Dogfile.cmd', 'installer.ps1', 'README.txt']) fs.copyFileSync(path.join(root, 'build', 'win', f), path.join(outDir, f));
console.log('built', outDir);
