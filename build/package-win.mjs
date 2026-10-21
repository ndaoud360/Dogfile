// Builds the ready-to-run Windows x64 folder + zip for Dogfile 2 (Tauri):
//   Dogfile.exe (built by GitHub Actions, .github/workflows/app.yml, fetched from the app-bin branch),
//   renderer/ (the interface), ffmpeg/ (Dogfile Player), 7zip/ (archives), installer scripts.
// usage: node build/package-win.mjs <Dogfile.exe> <ffmpeg-win64-shared.zip>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [exe, ffZip] = process.argv.slice(2);
if (!exe || !fs.existsSync(exe)) { console.error('usage: node build/package-win.mjs <Dogfile.exe> <ffmpeg.zip>'); process.exit(1); }
const outDir = path.join(root, 'dist', 'Dogfile');
let ffVersion = null;
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.copyFileSync(exe, path.join(outDir, 'Dogfile.exe'));
// the interface (development-only files left out)
fs.cpSync(path.join(root, 'src', 'renderer'), path.join(outDir, 'renderer'), { recursive: true, filter: (s) => !s.endsWith('.map') });

// media engine: ffmpeg + ffprobe (shared build) for Dogfile Player, thumbnails and conversions
if (ffZip) {
  const tmp = path.join(root, 'dist', '_ff');
  execFileSync('unzip', ['-q', ffZip, '-d', tmp]);
  const base = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
  ffVersion = (path.basename(base).match(/-(\d+\.\d+)$/) || path.basename(base).match(/n(\d+\.\d+)/) || [])[1] || 'bundled';
  const ffOut = path.join(outDir, 'ffmpeg');
  fs.mkdirSync(ffOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(base, 'bin'))) if (f !== 'ffplay.exe') fs.copyFileSync(path.join(base, 'bin', f), path.join(ffOut, f));
  if (fs.existsSync(path.join(base, 'LICENSE.txt'))) fs.copyFileSync(path.join(base, 'LICENSE.txt'), path.join(ffOut, 'LICENSE-ffmpeg.txt'));
  fs.writeFileSync(path.join(ffOut, 'README.txt'), 'FFmpeg (https://ffmpeg.org) builds by BtbN (https://github.com/BtbN/FFmpeg-Builds), licensed under the GPL. Used by Dogfile Player to play formats the web view cannot decode natively.\r\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// archive engine: 7-Zip standalone console (7za.exe) for zip / 7z / tar / gz / xz / bz2 / wim / cab
{
  const zOut = path.join(outDir, '7zip');
  fs.mkdirSync(zOut, { recursive: true });
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'win32', '7za.exe'), path.join(zOut, '7za.exe'));
  fs.copyFileSync(path.join(root, 'vendor', '7zip', 'LICENSE.txt'), path.join(zOut, 'LICENSE.txt'));
  fs.writeFileSync(path.join(zOut, 'README.txt'), '7-Zip standalone console (7za) by Igor Pavlov, https://www.7-zip.org, GNU LGPL. Used by Dogfile for creating and editing archives. Installing the full 7-Zip adds more formats (RAR, ISO and others) automatically.\r\n');
}

// which parts are installed (updates only download parts that changed)
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'tauri.conf.json'), 'utf8')).version;
fs.writeFileSync(path.join(outDir, 'components.json'), JSON.stringify({ app: appVersion, ...(ffVersion ? { ffmpeg: ffVersion } : {}) }, null, 2));

// installer helpers
for (const f of ['Install Dogfile.cmd', 'Uninstall Dogfile.cmd', 'installer.ps1', 'README.txt']) fs.copyFileSync(path.join(root, 'build', 'win', f), path.join(outDir, f));
console.log('built', outDir);
