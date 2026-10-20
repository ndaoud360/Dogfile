// Windows integration helpers: a persistent PowerShell host (so shell calls are fast),
// drives, recycle bin, shell verbs (the classic right-click menu), properties dialogs,
// registry for "default file manager", shortcuts, attributes and timestamps.
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

class PowerShellHost {
  constructor() { this.proc = null; this.queue = []; this.busy = false; this.buf = ''; this.cur = null; }
  ensure() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    this.proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.buf = '';
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      if (this.cur) { this.cur.reject(new Error('PowerShell exited')); this.cur = null; }
      this.busy = false; this.proc = null; this._pump();
    });
    this.proc.stdin.write("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'\n");
  }
  _onData(d) {
    this.buf += d;
    const marker = '<<<ATLAS-END>>>';
    let i;
    while (this.cur && (i = this.buf.indexOf(marker)) >= 0) {
      const out = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + marker.length).replace(/^\r?\n/, '');
      const job = this.cur; this.cur = null; this.busy = false;
      clearTimeout(job.timer);
      job.resolve(out.trim());
      this._pump();
    }
  }
  run(script, timeoutMs = 30000) {
    if (!IS_WIN) return Promise.reject(new Error('Windows only'));
    return new Promise((resolve, reject) => { this.queue.push({ script, resolve, reject, timeoutMs }); this._pump(); });
  }
  _pump() {
    if (this.busy || !this.queue.length) return;
    this.ensure();
    const job = this.queue.shift();
    this.busy = true; this.cur = job;
    const wrapped = `try { ${job.script} } catch { Write-Output ('{"__error":' + ($_.Exception.Message | ConvertTo-Json -Compress) + '}') }`;
    const b64 = Buffer.from(wrapped, 'utf8').toString('base64');
    job.timer = setTimeout(() => {
      try { this.proc.kill(); } catch {}
      job.reject(new Error('PowerShell timeout'));
    }, job.timeoutMs);
    this.proc.stdin.write(`iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); [Console]::Out.WriteLine('<<<ATLAS-END>>>')\n`);
  }
  async json(script, timeoutMs) {
    const out = await this.run(script, timeoutMs);
    if (!out) return null;
    let v;
    try { v = JSON.parse(out); }
    catch {
      // tolerate stray console noise: parse the last JSON-looking line
      const line = out.split(/\r?\n/).reverse().find((l) => /^\s*[\[{"]/.test(l));
      v = line ? JSON.parse(line) : null;
    }
    if (v && v.__error) throw new Error(v.__error);
    return v;
  }
  dispose() { try { this.proc && this.proc.kill(); } catch {} }
}

const ps = new PowerShellHost();

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: opts.encoding || 'utf8', ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

// ---------- Drives ----------
async function listDrives() {
  if (!IS_WIN) {
    const st = await fs.promises.statfs('/').catch(() => null);
    const out = [{ path: '/', name: 'File System', label: '', type: 'fixed', total: st ? st.blocks * st.bsize : 0, free: st ? st.bavail * st.bsize : 0 }];
    for (const base of ['/mnt', '/media']) {
      try { for (const d of fs.readdirSync(base)) { const p = path.join(base, d); const s = await fs.promises.statfs(p).catch(() => null); out.push({ path: p, name: d, label: d, type: 'removable', total: s ? s.blocks * s.bsize : 0, free: s ? s.bavail * s.bsize : 0 }); } } catch {}
    }
    return out;
  }
  let drives = [];
  try {
    const list = await ps.json("Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType,ProviderName,FileSystem | ConvertTo-Json -Compress");
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    const types = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram' };
    drives = arr.map((d) => ({
      path: d.DeviceID + '\\', letter: d.DeviceID, label: d.VolumeName || '', type: types[d.DriveType] || 'fixed',
      total: Number(d.Size) || 0, free: Number(d.FreeSpace) || 0, fs: d.FileSystem || '', provider: d.ProviderName || '',
      name: (d.VolumeName || (d.DriveType === 3 ? 'Local Disk' : d.DriveType === 4 ? (d.ProviderName || 'Network') : d.DriveType === 2 ? 'USB Drive' : d.DriveType === 5 ? 'DVD Drive' : 'Drive')) + ` (${d.DeviceID})`,
    }));
  } catch {
    for (let c = 65; c <= 90; c++) {
      const p = String.fromCharCode(c) + ':\\';
      try { const s = await fs.promises.statfs(p); drives.push({ path: p, letter: p.slice(0, 2), name: `Drive (${p.slice(0, 2)})`, label: '', type: 'fixed', total: s.blocks * s.bsize, free: s.bavail * s.bsize }); } catch {}
    }
  }
  // Phones, cameras, media players (MTP / WPD): they live in the "This PC" shell namespace, not as drive letters.
  try { drives.push(...(await portableDevices())); } catch {}
  return drives;
}

async function portableDevices() {
  if (!IS_WIN) return [];
  const r = await ps.json(`$sh=New-Object -ComObject Shell.Application; @($sh.Namespace(17).Items() | Where-Object { $_.IsFolder -and -not $_.IsFileSystem } | ForEach-Object { [pscustomobject]@{ name=$_.Name; type=$_.Type } }) | ConvertTo-Json -Compress`);
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  return arr.filter((d) => d.name).map((d) => ({ path: `atlas:mtp|${d.name}|`, name: d.name, label: d.name, type: 'portable', devType: d.type || 'Portable device', total: 0, free: 0 }));
}

// ---------- MTP (phones/cameras) via the Shell namespace ----------
// Paths look like  atlas:mtp|<device name>|<folder>/<sub>/<file>
function mtpParts(p) { const i = p.indexOf('|'), j = p.indexOf('|', i + 1); const dev = p.slice(i + 1, j < 0 ? undefined : j); const rest = j < 0 ? '' : p.slice(j + 1); return [dev, ...rest.split('/').filter(Boolean)]; }
const PS_MTP = `
function Find-AtlasChild($folder, $n) { foreach ($x in $folder.Items()) { if ($x.Name -eq $n) { return $x }; $fn = $x.ExtendedProperty('System.FileName'); if ($fn -and $fn -eq $n) { return $x } }; return $null }
function Get-AtlasFolder($parts) { $sh = New-Object -ComObject Shell.Application; $f = $sh.Namespace(17); foreach ($n in $parts) { $it = Find-AtlasChild $f $n; if (-not $it) { throw "Not found: $n" }; $f = $it.GetFolder }; return $f }
function Get-AtlasItem($parts) { if ($parts.Count -le 1) { $parent = (New-Object -ComObject Shell.Application).Namespace(17) } else { $parent = Get-AtlasFolder ($parts[0..($parts.Count - 2)]) }; $it = Find-AtlasChild $parent $parts[-1]; if (-not $it) { throw "Not found: $($parts[-1])" }; return $it }
function Get-AtlasName($x) { $fn = $x.ExtendedProperty('System.FileName'); if ($fn) { return $fn }; return $x.Name }
`;
const psArr = (parts) => '@(' + parts.map(psQuote).join(',') + ')';

async function mtpList(p) {
  const parts = mtpParts(p);
  const r = await ps.json(`${PS_MTP}; $f = Get-AtlasFolder ${psArr(parts)}; @($f.Items() | ForEach-Object { $sz = 0; try { $sz = [int64]$_.ExtendedProperty('System.Size') } catch {}; $md = ''; try { $md = $_.ModifyDate.ToString('o') } catch {}; [pscustomobject]@{ name = (Get-AtlasName $_); isDir = [bool]$_.IsFolder; size = $sz; mtime = $md } }) | ConvertTo-Json -Compress`, 60000);
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  const base = p.endsWith('|') ? p : p + '/';
  return arr.map((x) => ({ name: x.name, path: base + x.name, isDir: !!x.isDir, size: x.isDir ? null : Number(x.size) || 0, mtime: Date.parse(x.mtime) || 0, ctime: 0, ext: x.isDir ? '' : path.extname(x.name).slice(1).toLowerCase(), hidden: false, mtp: true }));
}

async function waitStable(target, expectedSize, timeoutMs = 30 * 60 * 1000) {
  const t0 = Date.now(); let last = -1, stableSince = 0;
  while (Date.now() - t0 < timeoutMs) {
    let size = -1;
    try { const st = await fs.promises.stat(target); size = st.isDirectory() ? await dirBytes(target) : st.size; } catch {}
    if (size >= 0 && (expectedSize == null || size >= expectedSize)) {
      if (size === last) { if (!stableSince) stableSince = Date.now(); if (Date.now() - stableSince > 1200) return true; } else stableSince = 0;
    }
    last = size;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function dirBytes(d) { let n = 0; for (const e of await fs.promises.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? await dirBytes(f) : (await fs.promises.stat(f).catch(() => ({ size: 0 }))).size; } return n; }

async function mtpCopyOut(paths, destDir, onProgress) {
  const out = [];
  for (const [i, p] of paths.entries()) {
    const parts = mtpParts(p);
    onProgress?.(i, parts[parts.length - 1]);
    const r = await ps.json(`${PS_MTP}; $it = Get-AtlasItem ${psArr(parts)}; $sz = 0; try { $sz = [int64]$it.ExtendedProperty('System.Size') } catch {}; (New-Object -ComObject Shell.Application).Namespace(${psQuote(destDir)}).CopyHere($it, 16); @{ name = (Get-AtlasName $it); size = $sz; dir = [bool]$it.IsFolder } | ConvertTo-Json -Compress`, 60000);
    const target = path.join(destDir, r.name);
    await waitStable(target, r.dir ? null : r.size);
    out.push(target);
  }
  return out;
}

async function mtpCopyIn(localPaths, mtpDir, onProgress) {
  const parts = mtpParts(mtpDir);
  for (const [i, lp] of localPaths.entries()) {
    onProgress?.(i, path.basename(lp));
    await ps.json(`${PS_MTP}; $f = Get-AtlasFolder ${psArr(parts)}; $f.CopyHere(${psQuote(lp)}, 16); '{}'`, 60000);
    // wait until the device reports the item
    const name = path.basename(lp);
    const t0 = Date.now();
    while (Date.now() - t0 < 30 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      const items = await mtpList(mtpDir).catch(() => []);
      const hit = items.find((x) => x.name === name);
      if (hit && (hit.isDir || !fs.statSync(lp).isFile() || hit.size >= fs.statSync(lp).size)) break;
    }
  }
  return true;
}

async function mtpDelete(paths) {
  for (const p of paths) await ps.json(`${PS_MTP}; $it = Get-AtlasItem ${psArr(mtpParts(p))}; $it.InvokeVerb('delete'); '{}'`, 120000);
  return true;
}
async function mtpMkdir(dir, name) { await ps.json(`${PS_MTP}; $f = Get-AtlasFolder ${psArr(mtpParts(dir))}; $f.NewFolder(${psQuote(name)}); '{}'`); return true; }
async function mtpRename(p, newName) { await ps.json(`${PS_MTP}; $it = Get-AtlasItem ${psArr(mtpParts(p))}; $it.Name = ${psQuote(newName)}; '{}'`); return true; }

// ---------- "Who is locking this file?" (Windows Restart Manager) ----------
const RM_CS = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Diagnostics;
public static class AtlasRm {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  const int CCH_RM_MAX_APP_NAME = 255; const int CCH_RM_MAX_SVC_NAME = 63;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName; public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static List<string> Who(string[] paths) {
    var res = new List<string>(); uint h; string key = Guid.NewGuid().ToString();
    if (RmStartSession(out h, 0, key) != 0) return res;
    try {
      if (RmRegisterResources(h, (uint)paths.Length, paths, 0, null, 0, null) != 0) return res;
      uint needed = 0, n = 0, reasons = 0; int r = RmGetList(h, out needed, ref n, null, ref reasons);
      if (r == 234) { var info = new RM_PROCESS_INFO[needed]; n = needed; if (RmGetList(h, out needed, ref n, info, ref reasons) == 0) { for (int i = 0; i < n; i++) res.Add(info[i].Process.dwProcessId + "|" + info[i].strAppName); } }
    } finally { RmEndSession(h); }
    return res;
  }
}`;
async function whoLocks(paths) {
  if (!IS_WIN) return [];
  const list = '@(' + paths.map(psQuote).join(',') + ')';
  const b64 = Buffer.from(RM_CS, 'utf8').toString('base64');
  const r = await ps.json(`if (-not ('AtlasRm' -as [type])) { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) }; @([AtlasRm]::Who(${list}) | ForEach-Object { $a = $_.Split('|', 2); $p = Get-Process -Id ([int]$a[0]) -ErrorAction SilentlyContinue; [pscustomobject]@{ pid = [int]$a[0]; name = $a[1]; exe = $(if ($p) { $p.Path } else { '' }) } }) | ConvertTo-Json -Compress`, 60000);
  return Array.isArray(r) ? r : r ? [r] : [];
}
async function killProcess(pid) { if (!IS_WIN) return false; await run('taskkill.exe', ['/PID', String(pid), '/F']); return true; }

// ---------- "Edit with Dogfile Notepad" / "Play with Dogfile Player" in the Windows right-click menu ----------
async function setShellVerbs(exe, enable) {
  if (!IS_WIN) return false;
  const edit = 'HKCU\\Software\\Classes\\*\\shell\\DogfileEdit', play = 'HKCU\\Software\\Classes\\SystemFileAssociations\\video\\shell\\DogfilePlay', playA = 'HKCU\\Software\\Classes\\SystemFileAssociations\\audio\\shell\\DogfilePlay', view = 'HKCU\\Software\\Classes\\SystemFileAssociations\\image\\shell\\DogfileView';
  // the old Atlas Files entries go either way
  for (const k of ['HKCU\\Software\\Classes\\*\\shell\\AtlasEdit', 'HKCU\\Software\\Classes\\SystemFileAssociations\\video\\shell\\AtlasPlay', 'HKCU\\Software\\Classes\\SystemFileAssociations\\audio\\shell\\AtlasPlay', 'HKCU\\Software\\Classes\\SystemFileAssociations\\image\\shell\\AtlasView']) await run('reg.exe', ['delete', k, '/f']);
  if (enable) {
    await run('reg.exe', ['add', edit, '/ve', '/d', 'Edit with Dogfile Notepad', '/f']);
    await run('reg.exe', ['add', edit, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
    await run('reg.exe', ['add', edit + '\\command', '/ve', '/d', `"${exe}" --edit "%1"`, '/f']);
    for (const k of [play, playA]) {
      await run('reg.exe', ['add', k, '/ve', '/d', 'Play with Dogfile Player', '/f']);
      await run('reg.exe', ['add', k, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
      await run('reg.exe', ['add', k + '\\command', '/ve', '/d', `"${exe}" --play "%1"`, '/f']);
    }
    await run('reg.exe', ['add', view, '/ve', '/d', 'View with Dogfile Photos', '/f']);
    await run('reg.exe', ['add', view, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
    await run('reg.exe', ['add', view + '\\command', '/ve', '/d', `"${exe}" --view "%1"`, '/f']);
  } else for (const k of [edit, play, playA, view]) await run('reg.exe', ['delete', k, '/f']);
  return true;
}

async function ejectDrive(letter) {
  return ps.json(`(New-Object -ComObject Shell.Application).Namespace(17).ParseName(${psQuote(letter)}).InvokeVerb('Eject'); '{}'`);
}

// ---------- Hidden / system attributes ----------
async function attrSets(dir) {
  if (!IS_WIN) return { hidden: null, system: null };
  const get = async (flag) => {
    const target = /^[a-zA-Z]:\\?$/.test(dir) ? dir.slice(0, 2) + '\\' : dir.replace(/\\+$/, '');
    const r = await run('cmd.exe', ['/u', '/c', 'dir', `/a:${flag}`, '/b', target], { encoding: 'buffer' });
    if (!r.stdout) return new Set();
    return new Set(r.stdout.toString('utf16le').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  };
  const [hidden, system] = await Promise.all([get('h'), get('s')]);
  return { hidden, system };
}

async function getAttributes(p) {
  if (!IS_WIN) return { readonly: false, hidden: path.basename(p).startsWith('.'), system: false, archive: false };
  const r = await ps.json(`$i=Get-Item -LiteralPath ${psQuote(p)} -Force; @{a=[int]$i.Attributes; c=$i.CreationTime.ToString('o')} | ConvertTo-Json -Compress`);
  const a = r.a;
  return { readonly: !!(a & 1), hidden: !!(a & 2), system: !!(a & 4), archive: !!(a & 32), compressed: !!(a & 2048), encrypted: !!(a & 16384), created: r.c };
}

async function setAttributes(paths, attrs) {
  if (!IS_WIN) return true;
  for (const p of paths) {
    const args = [];
    for (const [k, f] of [['readonly', 'R'], ['hidden', 'H'], ['system', 'S'], ['archive', 'A']]) if (k in attrs) args.push((attrs[k] ? '+' : '-') + f);
    if (args.length) await run('attrib.exe', [...args, p]);
  }
  return true;
}

async function setCreationTime(p, iso) {
  if (!IS_WIN) return false;
  await ps.json(`(Get-Item -LiteralPath ${psQuote(p)} -Force).CreationTime=[datetime]::Parse(${psQuote(iso)}); '{}'`);
  return true;
}

// ---------- Shell verbs (classic context menu entries incl. 3rd-party like 7-Zip) ----------
function nsParse(p) {
  const dir = path.dirname(p);
  const name = path.basename(p);
  if (/^[a-zA-Z]:\\?$/.test(p)) return `(New-Object -ComObject Shell.Application).Namespace(17).ParseName(${psQuote(p.slice(0, 2))})`;
  return `(New-Object -ComObject Shell.Application).Namespace(${psQuote(dir)}).ParseName(${psQuote(name)})`;
}

async function shellVerbs(p) {
  if (!IS_WIN) return [];
  const r = await ps.json(`$f=${nsParse(p)}; @($f.Verbs() | ForEach-Object { $_.Name } | Where-Object { $_ -and $_.Trim() }) | ConvertTo-Json -Compress`);
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  return arr;
}

async function invokeVerb(p, verbName) {
  if (!IS_WIN) return false;
  await ps.json(`$f=${nsParse(p)}; $v=$f.Verbs() | Where-Object { $_.Name -eq ${psQuote(verbName)} } | Select-Object -First 1; if ($v) { $v.DoIt() }; '{}'`, 60000);
  return true;
}

async function showProperties(paths) {
  if (!IS_WIN) return false;
  if (paths.length === 1) {
    await ps.json(`${nsParse(paths[0])}.InvokeVerb('properties'); '{}'`);
  } else {
    // Multi-select properties: use the same folder; Shell supports InvokeVerbEx on a FolderItems collection via SelectItem is UI only;
    // fall back to opening each (capped) .
    for (const p of paths.slice(0, 8)) await ps.json(`${nsParse(p)}.InvokeVerb('properties'); '{}'`);
  }
  return true;
}

// ---------- Recycle bin ----------
async function recycleList() {
  if (!IS_WIN) return [];
  const r = await ps.json(`$rb=(New-Object -ComObject Shell.Application).Namespace(10); @($rb.Items() | ForEach-Object { [pscustomobject]@{ name=$_.Name; path=$_.Path; isDir=$_.IsFolder; size=[int64]$_.Size; from=$_.ExtendedProperty('System.Recycle.DeletedFrom'); deleted=([datetime]$_.ExtendedProperty('System.Recycle.DateDeleted')).ToString('o'); modified=$_.ModifyDate.ToString('o') } }) | ConvertTo-Json -Compress -Depth 3`, 60000);
  return Array.isArray(r) ? r : r ? [r] : [];
}

async function recycleRestore(recyclePaths) {
  if (!IS_WIN) return false;
  const list = '@(' + recyclePaths.map(psQuote).join(',') + ')';
  await ps.json(`$want=${list}; $rb=(New-Object -ComObject Shell.Application).Namespace(10); foreach ($i in @($rb.Items())) { if ($want -contains $i.Path) { $i.InvokeVerb('undelete') } }; '{}'`, 120000);
  return true;
}

// Restore by original location (used by Undo of "move to recycle bin")
async function recycleRestoreOriginal(originalPaths) {
  if (!IS_WIN) return false;
  const list = '@(' + originalPaths.map((p) => psQuote(p.toLowerCase())).join(',') + ')';
  await ps.json(`$want=${list}; $rb=(New-Object -ComObject Shell.Application).Namespace(10); $items=@($rb.Items()) | Sort-Object { $_.ExtendedProperty('System.Recycle.DateDeleted') } -Descending; $done=@{}; foreach ($i in $items) { $orig=(Join-Path $i.ExtendedProperty('System.Recycle.DeletedFrom') $i.Name).ToLower(); if (($want -contains $orig) -and -not $done[$orig]) { $i.InvokeVerb('undelete'); $done[$orig]=1 } }; '{}'`, 120000);
  return true;
}

async function recycleDeleteForever(recyclePaths) {
  if (!IS_WIN) return false;
  for (const p of recyclePaths) { try { await fs.promises.rm(p, { recursive: true, force: true }); } catch {} }
  return true;
}

async function recycleEmpty() {
  if (!IS_WIN) return false;
  await ps.json(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue; '{}'`, 300000);
  return true;
}

// ---------- Shortcuts ----------
async function createShortcut(lnkPath, target) {
  if (!IS_WIN) { await fs.promises.symlink(target, lnkPath.replace(/\.lnk$/i, '')); return true; }
  const { shell } = require('electron');
  return shell.writeShortcutLink(lnkPath, 'create', { target, cwd: path.dirname(target) });
}

// ---------- Clipboard file lists (interop with Explorer & other apps) ----------
async function clipboardSetFiles(paths, cut) {
  if (!IS_WIN) return false;
  const list = '@(' + paths.map(psQuote).join(',') + ')';
  // Use .NET so we can set the Preferred DropEffect (cut = 2, copy = 5) like Explorer does.
  await ps.json(`Add-Type -AssemblyName System.Windows.Forms; $sc=New-Object System.Collections.Specialized.StringCollection; foreach($p in ${list}){[void]$sc.Add($p)}; $d=New-Object System.Windows.Forms.DataObject; $d.SetFileDropList($sc); $ms=New-Object System.IO.MemoryStream; $ms.Write([BitConverter]::GetBytes([int]${cut ? 2 : 5}),0,4); $d.SetData('Preferred DropEffect',$ms); [System.Windows.Forms.Clipboard]::SetDataObject($d,$true); '{}'`);
  return true;
}

async function clipboardGetFiles() {
  if (!IS_WIN) return { paths: [], cut: false };
  const r = await ps.json(`Add-Type -AssemblyName System.Windows.Forms; $d=[System.Windows.Forms.Clipboard]::GetDataObject(); $files=@(); $cut=$false; if ($d -and $d.GetDataPresent('FileDrop')) { $files=@($d.GetData('FileDrop')); $s=$d.GetData('Preferred DropEffect'); if ($s) { $b=New-Object byte[] 4; [void]$s.Read($b,0,4); $cut=([BitConverter]::ToInt32($b,0) -band 2) -ne 0 } }; @{paths=$files; cut=$cut} | ConvertTo-Json -Compress`);
  return { paths: r && r.paths ? (Array.isArray(r.paths) ? r.paths : [r.paths]) : [], cut: !!(r && r.cut) };
}

// ---------- Default file manager (registry) ----------
// Same keys used by the Files app: Folder\shell\open, Folder\shell\explore and the Win+E handler CLSID.
const REG_KEYS = [
  'HKCU\\Software\\Classes\\Folder\\shell\\open\\command',
  'HKCU\\Software\\Classes\\Folder\\shell\\explore\\command',
  'HKCU\\Software\\Classes\\CLSID\\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\\shell\\opennewwindow\\command',
];

async function isDefault(exe) {
  if (!IS_WIN) return false;
  const r = await run('reg.exe', ['query', REG_KEYS[0], '/ve']);
  return !r.err && r.stdout.toLowerCase().includes(path.basename(exe).toLowerCase());
}

async function setDefault(exe, enable) {
  if (!IS_WIN) return false;
  if (enable) {
    for (const key of REG_KEYS) {
      const cmd = key.includes('opennewwindow') ? `"${exe}"` : `"${exe}" "%1"`;
      await run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']);
      await run('reg.exe', ['add', key, '/v', 'DelegateExecute', '/t', 'REG_SZ', '/d', '', '/f']);
    }
  } else {
    await run('reg.exe', ['delete', 'HKCU\\Software\\Classes\\Folder\\shell\\open', '/f']);
    await run('reg.exe', ['delete', 'HKCU\\Software\\Classes\\Folder\\shell\\explore', '/f']);
    await run('reg.exe', ['delete', 'HKCU\\Software\\Classes\\CLSID\\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}', '/f']);
  }
  return isDefault(exe);
}

// ---------- Terminals / launching ----------
async function which(cmd) {
  const r = await run(IS_WIN ? 'where.exe' : 'which', [cmd]);
  if (r.err) return null;
  return r.stdout.split(/\r?\n/)[0].trim() || null;
}

async function openTerminal(dir, kind = 'auto', admin = false) {
  const opts = { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false };
  if (!IS_WIN) {
    for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      if (await which(t)) { spawn(t, [], opts).unref(); return true; }
    }
    return false;
  }
  if (admin) {
    const exe = kind === 'cmd' ? 'cmd.exe' : (await which('wt.exe')) && kind !== 'powershell' ? 'wt.exe' : 'powershell.exe';
    const args = exe === 'wt.exe' ? `-d "${dir}"` : exe === 'cmd.exe' ? `/k cd /d "${dir}"` : `-NoExit -Command Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
    await ps.json(`Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(args)} -Verb RunAs; '{}'`).catch(() => {});
    return true;
  }
  if ((kind === 'auto' || kind === 'wt') && (await which('wt.exe'))) { spawn('wt.exe', ['-d', dir], opts).unref(); return true; }
  if (kind === 'cmd') { spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${dir}"`], { ...opts, shell: false }).unref(); return true; }
  if (kind === 'pwsh' && (await which('pwsh.exe'))) { spawn('cmd.exe', ['/c', 'start', 'pwsh.exe', '-NoExit', '-WorkingDirectory', dir], opts).unref(); return true; }
  spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`], opts).unref();
  return true;
}

async function runAsAdmin(p) {
  if (!IS_WIN) return false;
  await ps.json(`Start-Process -FilePath ${psQuote(p)} -WorkingDirectory ${psQuote(path.dirname(p))} -Verb RunAs; '{}'`).catch(() => {});
  return true;
}

function openWith(p) {
  if (!IS_WIN) return false;
  spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function showInExplorer(p, select) {
  if (!IS_WIN) { require('electron').shell.showItemInFolder(p); return true; }
  // Bypass our own default-handler registration by calling explorer.exe directly.
  spawn('explorer.exe', select ? [`/select,${p}`] : [p], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

async function netView(server) {
  if (!IS_WIN) return [];
  const r = await run('net.exe', ['view', server, '/all']);
  if (r.err) return [];
  const lines = r.stdout.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{5,}/.test(l));
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^(\S.*?)\s{2,}(Disk|Print|IPC)/i);
    if (m && /disk/i.test(m[2])) out.push(m[1].trim());
  }
  return out;
}

// Network neighborhood (computers, media servers, printers, routers) - the same list File Explorer's "Network" shows
let netCache = { at: 0, list: [] };
async function discoverNetwork(force) {
  if (!force && Date.now() - netCache.at < 60000 && netCache.list.length) return netCache.list;
  const { ssdpDiscover } = require('./netdiscover');
  // The shell's Network folder fills in as Windows' discovery runs, so enumerate, give it a moment, then read it again.
  const shellList = IS_WIN ? ps.json(`$sh = New-Object -ComObject Shell.Application; $ns = $sh.Namespace(18); if (-not $ns) { '[]' } else { $null = @($ns.Items()); Start-Sleep -Milliseconds 2500; $ns = $sh.Namespace(18); @($ns.Items() | ForEach-Object { [pscustomobject]@{ name = $_.Name; path = $_.Path; type = $_.Type } }) | ConvertTo-Json -Compress }`, 60000).catch(() => null) : Promise.resolve([]);
  const [r, upnp] = await Promise.all([shellList, ssdpDiscover().catch(() => [])]);
  const arr = (Array.isArray(r) ? r : r ? [r] : []).filter((x) => x && x.name);
  const names = new Set(arr.map((x) => x.name.toLowerCase()));
  for (const d of upnp) if (!names.has(d.name.toLowerCase())) { names.add(d.name.toLowerCase()); arr.push({ name: d.name, path: '', type: d.type, url: d.url, ip: d.ip, model: d.model, source: 'ssdp' }); }
  netCache = { at: Date.now(), list: arr };
  return netCache.list;
}
async function openNetworkItem(name) {
  if (!IS_WIN) return false;
  await ps.json(`$ns = (New-Object -ComObject Shell.Application).Namespace(18); foreach ($i in $ns.Items()) { if ($i.Name -eq ${psQuote(name)}) { $i.InvokeVerb(); break } }; '{}'`, 30000);
  return true;
}

async function mappedDrives() {
  if (!IS_WIN) return [];
  const r = await run('net.exe', ['use']);
  if (r.err) return [];
  const out = [];
  for (const l of r.stdout.split(/\r?\n/)) {
    const m = l.match(/\s([A-Z]:)\s+(\\\\\S+)/);
    if (m) out.push({ letter: m[1], remote: m[2] });
  }
  return out;
}

// ---------- desktop background ----------
async function setWallpaper(file) {
  if (!IS_WIN) return false;
  await ps.json(`Add-Type -Namespace AtlasNs -Name Wp -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d);' -ErrorAction SilentlyContinue; [AtlasNs.Wp]::SystemParametersInfo(20, 0, ${psQuote(file)}, 3) | Out-Null; '"ok"'`);
  return true;
}

module.exports = {
  setWallpaper,
  IS_WIN, ps, run, which, psQuote, listDrives, ejectDrive, attrSets, getAttributes, setAttributes, setCreationTime,
  shellVerbs, invokeVerb, showProperties, recycleList, recycleRestore, recycleRestoreOriginal, recycleDeleteForever, recycleEmpty,
  createShortcut, clipboardSetFiles, clipboardGetFiles, isDefault, setDefault, openTerminal, runAsAdmin, openWith,
  showInExplorer, netView, mappedDrives, portableDevices, mtpList, mtpCopyOut, mtpCopyIn, mtpDelete, mtpMkdir, mtpRename,
  whoLocks, killProcess, setShellVerbs, discoverNetwork, openNetworkItem,
};
