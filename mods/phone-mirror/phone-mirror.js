// @dogmod
// @name Phone mirroring
// @description Shows your Android phone on your PC, full resolution and full screen if you like, by USB or Wi-Fi
// @target files
// @permissions run
// @version 1.0
// @author Dogfile
// @icon phone

// Uses scrcpy (free and open source, by Genymobile): fetched once into your user folder the first time, then
// started from Dogfile's terminal. Your phone needs USB debugging turned on once (see "How to set up my phone").
// iPhones can't be mirrored this way: Apple doesn't allow it on Windows.

// ---- settings (Phone mirroring settings…) ----
const DEFAULTS = { quality: 'best', fullscreen: false, audio: true, screenOff: false, awake: true, onTop: false };
const settings = async () => ({ ...DEFAULTS, ...((await dogfile.storage.get('settings')) || {}) });
const QUALITY = {
  best: ['--max-size=0', '--video-bit-rate=20M', '--max-fps=60'],      // the phone's own resolution
  balanced: ['--max-size=1920', '--video-bit-rate=8M', '--max-fps=60'],
  light: ['--max-size=1280', '--video-bit-rate=4M', '--max-fps=30'],   // slow Wi-Fi or older PCs
};

// ---- running PowerShell from the terminal, whatever shell it uses ----
// the script travels encoded, so no quoting can go wrong in cmd or PowerShell
function encode(script) {
  let bin = '';
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bin += String.fromCharCode(c & 255, c >> 8); }
  return btoa(bin);
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Start-Process joins arguments with spaces: a value with spaces in it is put in double quotes
const quoteArg = (a) => (/\s/.test(a) ? a.replace(/^(--[\w-]+=)?(.*)$/, (m, k, v) => `${k || ''}"${v.replace(/"/g, '')}"`) : a);
// finds scrcpy, fetching the latest release the first time
const SETUP = `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Dogfile\\phone-mirror'
$exe = Get-ChildItem -Path $dir -Recurse -Filter scrcpy.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
  Write-Host 'Getting scrcpy (free and open source, by Genymobile). This happens once...'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $rel = Invoke-RestMethod 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest' -Headers @{ 'User-Agent' = 'Dogfile' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { 'win32' } else { 'win64' }
  $asset = $rel.assets | Where-Object { $_.name -like "scrcpy-$arch-*.zip" } | Select-Object -First 1
  if (-not $asset) { throw 'No Windows download found in the latest scrcpy release' }
  $zip = Join-Path $env:TEMP $asset.name
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip
  Expand-Archive $zip -DestinationPath $dir -Force
  Remove-Item $zip
  $exe = Get-ChildItem -Path $dir -Recurse -Filter scrcpy.exe | Select-Object -First 1
  Write-Host "scrcpy $($rel.tag_name) is ready."
}
$adb = Join-Path $exe.DirectoryName 'adb.exe'
`;
async function ps(body) {
  await dogfile.run(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encode(SETUP + body)}`);
}
// scrcpy in its own window: the terminal is free again straight away
async function mirror(extra = [], note = 'Mirroring your phone') {
  const s = await settings();
  const args = [...QUALITY[s.quality] || QUALITY.best, '--window-title=Phone (Dogfile)', ...extra];
  if (s.fullscreen) args.push('--fullscreen');
  if (!s.audio) args.push('--no-audio');
  if (s.screenOff) args.push('--turn-screen-off');
  if (s.awake) args.push('--stay-awake');
  if (s.onTop) args.push('--always-on-top');
  await ps(`
Write-Host ${psq(note + '... (if nothing appears: is the phone connected and USB debugging allowed?)')}
Start-Process -FilePath $exe.FullName -WorkingDirectory $exe.DirectoryName -ArgumentList @(${args.map(quoteArg).map(psq).join(', ')})
`);
  dogfile.ui.toast(`${note}. F11 or Alt+F switches full screen; Ctrl+H is Home, Ctrl+B is Back.`);
}

dogfile.addCommand({
  id: 'mirror-usb', title: 'Mirror my phone (USB)', icon: 'phone',
  run: () => mirror(['--select-usb'], 'Mirroring your phone over USB'),
});

dogfile.addCommand({
  id: 'mirror-wifi', title: 'Mirror my phone over Wi-Fi…', icon: 'phone',
  run: async () => {
    const how = await dogfile.ui.choose('Mirror over Wi-Fi', ['It’s plugged in by USB now (switch it to Wi-Fi)', 'Connect to its address…', 'It was paired before (Android 11+)']);
    if (!how) return;
    if (how.startsWith('It’s plugged')) {
      await dogfile.storage.set('wifi', 'auto');
      return mirror(['--tcpip'], 'Switching your phone to Wi-Fi (you can unplug it once the picture appears)');
    }
    const last = (await dogfile.storage.get('address')) || '';
    const addr = how.startsWith('Connect') ? await dogfile.ui.prompt('Your phone’s address', 'Settings › About phone › Status › IP address (e.g. 192.168.1.23)', last) : last || await dogfile.ui.prompt('Your phone’s address', 'IP address and port shown under Wireless debugging (e.g. 192.168.1.23:41235)', '');
    if (!addr) return;
    await dogfile.storage.set('address', addr.trim());
    return mirror([`--tcpip=${addr.trim()}`], `Connecting to ${addr.trim()}`);
  },
});

dogfile.addCommand({
  id: 'pair', title: 'Pair a phone over Wi-Fi (Android 11+)…', icon: 'phone',
  run: async () => {
    await dogfile.ui.showText('Pair over Wi-Fi', 'On the phone: Settings › Developer options › Wireless debugging › Pair device with pairing code.\nIt shows an address with a port (e.g. 192.168.1.23:37017) and a six-digit code. Keep that screen open, then type them in the next two boxes.\n\nPC and phone must be on the same Wi-Fi.');
    const target = await dogfile.ui.prompt('Pairing address', 'The IP address and port under “Pair device with pairing code”', '');
    if (!target) return;
    const code = await dogfile.ui.prompt('Pairing code', 'The six-digit code', '');
    if (!code) return;
    const connect = await dogfile.ui.prompt('Connect address', 'Now the IP address and port shown at the top of Wireless debugging (it differs from the pairing one)', target.split(':')[0] + ':');
    await ps(`
& $adb pair ${psq(target.trim())} ${psq(code.trim())}
${connect ? `& $adb connect ${psq(connect.trim())}` : ''}
`);
    if (connect) await dogfile.storage.set('address', connect.trim());
    dogfile.ui.toast('Paired. Use “Mirror my phone over Wi-Fi…” › “It was paired before”.');
  },
});

dogfile.addCommand({
  id: 'record', title: 'Record my phone’s screen…', icon: 'record',
  run: async () => {
    const folder = await dogfile.folder();
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
    const name = await dogfile.ui.prompt('Record the phone’s screen', `Saved in ${folder || 'this folder'} when you close the phone window`, `Phone ${stamp}.mp4`);
    if (!name) return;
    const file = (folder ? folder.replace(/[\\/]$/, '') + '\\' : '') + (/\.(mp4|mkv)$/i.test(name) ? name : name + '.mp4');
    await mirror([`--record=${file}`], 'Recording your phone');
  },
});

dogfile.addCommand({
  id: 'stop', title: 'Stop mirroring my phone', icon: 'close',
  run: async () => { await ps(`Get-Process scrcpy -ErrorAction SilentlyContinue | Stop-Process\nWrite-Host 'Stopped.'`); },
});

dogfile.addCommand({
  id: 'settings', title: 'Phone mirroring settings…', icon: 'settings',
  run: async () => {
    const s = await settings();
    const q = await dogfile.ui.choose('Picture quality', ['Best (the phone’s full resolution)', 'Balanced (up to 1920 pixels)', 'Light (for slow Wi-Fi)']);
    if (q) s.quality = q.startsWith('Best') ? 'best' : q.startsWith('Balanced') ? 'balanced' : 'light';
    const yn = async (title, cur) => { const a = await dogfile.ui.choose(`${title} (now: ${cur ? 'yes' : 'no'})`, ['Yes', 'No']); return a ? a === 'Yes' : cur; };
    s.fullscreen = await yn('Start in full screen', s.fullscreen);
    s.audio = await yn('Play the phone’s sound on the PC (Android 11+)', s.audio);
    s.screenOff = await yn('Turn the phone’s own screen off while mirroring', s.screenOff);
    s.awake = await yn('Keep the phone awake while mirroring', s.awake);
    s.onTop = await yn('Keep the phone window on top', s.onTop);
    await dogfile.storage.set('settings', s);
    dogfile.ui.toast('Saved');
  },
});

dogfile.addCommand({
  id: 'help', title: 'How to set up my phone for mirroring', icon: 'info',
  run: () => dogfile.ui.showText('Set up your phone (once)', [
    '1. On the phone: Settings › About phone › tap “Build number” 7 times. Developer options are now on.',
    '2. Settings › System › Developer options › turn on “USB debugging”.',
    '3. Plug the phone into the PC with a USB cable that carries data.',
    '4. On the phone, allow USB debugging for this computer (tick “Always allow”).',
    '5. In Dogfile: Mirror my phone (USB).',
    '',
    'Wi-Fi: with the phone plugged in, use Mirror my phone over Wi-Fi › “It’s plugged in by USB now”, then unplug it. On Android 11 and later you can also pair without a cable (Pair a phone over Wi-Fi).',
    '',
    'In the phone window: F11 or Alt+F full screen · Ctrl+H Home · Ctrl+B Back · Ctrl+S app switcher · Ctrl+O turn the phone screen off · drag files onto the window to copy them to the phone (APKs install).',
    '',
    'The first time, Dogfile fetches scrcpy (free and open source, github.com/Genymobile/scrcpy) into your user folder. iPhones can’t be mirrored this way: Apple doesn’t allow it on Windows.',
  ].join('\n')),
});
