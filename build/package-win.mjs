// Builds the ready-to-run Windows x64 folder + zip for Dogfile 2 (Tauri):
//   Dogfile.exe (the program with its interface inside, built by GitHub Actions, .github/workflows/app.yml, fetched from the app-bin branch),
//   ffmpeg/ (Dogfile Player), 7zip/ (archives), installer scripts.
// usage: node build/package-win.mjs <Dogfile.exe> <ffmpeg-win64-shared.zip>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// unpack a zip: Windows' own tar (Git's GNU tar, often first on the path in CI, reads "D:" as a remote host)
const unzip = (zip, dir) => {
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]);
  else execFileSync('unzip', ['-q', zip, '-d', dir]);
};
const [exe, ffZip] = process.argv.slice(2);
if (!exe || !fs.existsSync(exe)) { console.error('usage: node build/package-win.mjs <Dogfile.exe> <ffmpeg.zip>'); process.exit(1); }
// DOGFILE_ARCH=arm64 builds the Windows on ARM folder (dist/Dogfile-arm64) next to the x64 one
const ARCH = process.env.DOGFILE_ARCH === 'arm64' ? 'arm64' : 'x64';
const outDir = path.join(root, 'dist', ARCH === 'x64' ? 'Dogfile' : 'Dogfile-arm64');
let ffVersion = null;
if (ARCH === 'x64') fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
else fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.copyFileSync(exe, path.join(outDir, 'Dogfile.exe'));
// the interface is inside Dogfile.exe (build/pack-ui.mjs before the build), so no renderer/ folder ships

// media engine: ffmpeg + ffprobe (shared build) for Dogfile Player, thumbnails and conversions
if (ffZip) {
  const tmp = path.join(root, 'dist', '_ff');
  fs.mkdirSync(tmp, { recursive: true });
  unzip(ffZip, tmp);
  const base = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
  ffVersion = (path.basename(base).match(/-(\d+\.\d+)$/) || path.basename(base).match(/n(\d+\.\d+)/) || [])[1] || 'bundled';
  const ffOut = path.join(outDir, 'ffmpeg');
  fs.mkdirSync(ffOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(base, 'bin'))) if (f !== 'ffplay.exe') fs.copyFileSync(path.join(base, 'bin', f), path.join(ffOut, f));
  if (fs.existsSync(path.join(base, 'LICENSE.txt'))) fs.copyFileSync(path.join(base, 'LICENSE.txt'), path.join(ffOut, 'LICENSE-ffmpeg.txt'));
  fs.writeFileSync(path.join(ffOut, 'README.txt'), 'FFmpeg (https://ffmpeg.org) builds by BtbN (https://github.com/BtbN/FFmpeg-Builds), licensed under the GPL. Used by Dogfile Player to play formats the web view cannot decode natively.\r\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// the assistant's fast engine: llama.cpp's own server program and its libraries (official Windows CPU build)
const llamaZip = process.env.DOGFILE_LLAMA_ZIP;
if (ARCH === 'x64' && llamaZip && fs.existsSync(llamaZip)) {
  const tmp = path.join(root, 'dist', '_llama');
  fs.mkdirSync(tmp, { recursive: true });
  unzip(llamaZip, tmp);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(tmp);
  const server = files.find((f) => path.basename(f).toLowerCase() === 'llama-server.exe');
  if (server) {
    const lOut = path.join(outDir, 'llama');
    fs.mkdirSync(lOut, { recursive: true });
    for (const f of files) {
      const b = path.basename(f);
      if (path.dirname(f) === path.dirname(server) && (/\.dll$/i.test(b) || b.toLowerCase() === 'llama-server.exe' || /^license/i.test(b))) fs.copyFileSync(f, path.join(lOut, b));
    }
    fs.writeFileSync(path.join(lOut, 'README.txt'), 'llama.cpp (https://github.com/ggml-org/llama.cpp), MIT license. Runs the assistant\'s language model on this PC.\r\n');
    console.log('bundled llama-server');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// archive engine: 7-Zip standalone console (7za.exe) for zip / 7z / tar / gz / xz / bz2 / wim / cab
{
  const zOut = path.join(outDir, '7zip');
  fs.mkdirSync(zOut, { recursive: true });
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'win32', '7za.exe'), path.join(zOut, '7za.exe'));
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'LICENSE.txt'), path.join(zOut, 'LICENSE.txt'));
  // the full 7-Zip (7z.exe + 7z.dll) when CI fetched it: opens RAR, ISO, DMG, VHD and the rest too
  const full = process.env.DOGFILE_7Z_FULL || path.join(path.dirname(exe), '7zfull');
  if (fs.existsSync(path.join(full, '7z.exe')) && fs.existsSync(path.join(full, '7z.dll'))) {
    for (const f of ['7z.exe', '7z.dll']) fs.copyFileSync(path.join(full, f), path.join(zOut, f));
    if (fs.existsSync(path.join(full, 'License.txt'))) fs.copyFileSync(path.join(full, 'License.txt'), path.join(zOut, 'LICENSE.txt'));
    console.log('bundled the full 7-Zip');
  }
  fs.writeFileSync(path.join(zOut, 'README.txt'), '7-Zip by Igor Pavlov, https://www.7-zip.org, GNU LGPL (unRAR code under the unRAR license restriction). Used by Dogfile to open and create archives: 7z, ZIP, RAR, ISO, TAR, GZ, XZ, BZ2, WIM, CAB, DMG, VHD and more.\r\n');
}

// which parts are installed (updates only download parts that changed)
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'tauri.conf.json'), 'utf8')).version;
fs.writeFileSync(path.join(outDir, 'components.json'), JSON.stringify({ app: appVersion, arch: ARCH, ...(ffVersion ? { ffmpeg: ffVersion } : {}) }, null, 2));

// installer helpers
for (const f of ['Install Dogfile.cmd', 'Uninstall Dogfile.cmd', 'installer.ps1', 'README.txt']) fs.copyFileSync(path.join(root, 'build', 'win', f), path.join(outDir, f));
console.log('built', outDir);
