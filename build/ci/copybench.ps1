# Copy speed: Dogfile next to the copy tools people compare it with, on the same files and the same disk.
# usage: copybench.ps1 -Exe target/release/dogfile.exe -Out dir
# Three sets: one big file, a folder of medium files, and a folder of thousands of small files. Each tool copies
# each set into a fresh folder; the source is read once before the first run so every tool starts from the same
# cache state. Results go to copybench.txt and a notice.
param([string]$Exe, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
$root = Join-Path $env:RUNNER_TEMP 'bench'
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
$src = Join-Path $root 'src'
New-Item -ItemType Directory -Force "$src/big", "$src/medium", "$src/small" | Out-Null
$rnd = New-Object System.Random 7
$buf = New-Object byte[] (8MB); $rnd.NextBytes($buf)
# big: one 3 GB file
$fs = [IO.File]::Create("$src/big/movie.mkv"); for ($i = 0; $i -lt 384; $i++) { $fs.Write($buf, 0, $buf.Length) }; $fs.Close()
# medium: 40 files of 40 MB
for ($f = 0; $f -lt 40; $f++) { $fs = [IO.File]::Create("$src/medium/photo-raw-$f.dng"); for ($i = 0; $i -lt 5; $i++) { $fs.Write($buf, ($f * 997) % 1MB, 8MB - 1MB) }; $fs.Close() }
# small: 5,000 files of 1–64 KB in 50 folders
for ($d = 0; $d -lt 50; $d++) {
  $dir = "$src/small/folder $d"; New-Item -ItemType Directory -Force $dir | Out-Null
  for ($f = 0; $f -lt 100; $f++) { $n = 1024 + (($d * 131 + $f * 977) % 64512); $b = New-Object byte[] $n; [Array]::Copy($buf, ($f * 4099) % (7MB), $b, 0, $n); [IO.File]::WriteAllBytes("$dir/file $f.txt", $b) }
}
$sets = @('big', 'medium', 'small')
$bytes = @{}; foreach ($s in $sets) { $bytes[$s] = (Get-ChildItem -Recurse -File "$src/$s" | Measure-Object Length -Sum).Sum }
# read everything once, so no tool gets a colder or warmer start than the others
foreach ($s in $sets) { Get-ChildItem -Recurse -File "$src/$s" | ForEach-Object { $null = [IO.File]::ReadAllBytes($_.FullName).Length } }

function Wipe($p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue; [GC]::Collect() }
function Check($s, $dst) {
  $n = (Get-ChildItem -Recurse -File $dst -ErrorAction SilentlyContinue | Measure-Object Length -Sum)
  if ($n.Sum -ne $bytes[$s]) { return " (INCOMPLETE: $([math]::Round($n.Sum / 1MB)) of $([math]::Round($bytes[$s] / 1MB)) MB)" }
  ''
}
# every run starts with nothing waiting to be written, so no tool pays for the one before it; afterwards the time to
# get everything onto the disk is added for the "on disk" column (a tool can report done while Windows still writes)
$drive = (Get-Item $root).PSDrive.Name
function Flush { $sw = [Diagnostics.Stopwatch]::StartNew(); try { Write-VolumeCache -DriveLetter $drive -ErrorAction Stop } catch { } ; $sw.Elapsed.TotalSeconds }
$rows = @()
function Row($tool, $s, $sec, $disk, $note) {
  $mbs = if ($sec -gt 0) { [math]::Round($bytes[$s] / 1MB / $sec) } else { 0 }
  $script:rows += ('{0,-24} {1,-7} done {2,6:N2} s {3,6} MB/s   on disk {4,6:N2} s{5}' -f $tool, $s, $sec, $mbs, $disk, $note)
}
function Timed($tool, $s, $dst, [scriptblock]$run) {
  Wipe $dst; $null = Flush
  $sw = [Diagnostics.Stopwatch]::StartNew(); & $run; $done = $sw.Elapsed.TotalSeconds
  $null = Flush; $disk = $sw.Elapsed.TotalSeconds
  Row $tool $s $done $disk (Check $s $dst); Wipe $dst
}

# Dogfile runs inside the app: started once per copy, portable, with its data in a scratch folder
Remove-Item -Recurse -Force target/release/data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force target/release/data | Out-Null
New-Item -ItemType File -Force target/release/portable.txt | Out-Null
Set-Content target/release/data/settings.json '{"welcomed":true,"indexEnabled":false}'
$esc = { param($p) ((Resolve-Path -LiteralPath (Split-Path $p)).Path + '\' + (Split-Path -Leaf $p)) -replace '\\', '\\' }
function Dogfile($label, $s, $workers) {
  $dst = "$root/dog-$s"; Wipe $dst; $null = Flush
  $log = "$Out/copybench-app.log"; Remove-Item $log -ErrorAction SilentlyContinue
  $js = (Get-Content -Raw build/ci/copybench.js).Replace('__WORKERS__', "$workers").Replace('__SRC__', (& $esc "$src/$s")).Replace('__DEST__', (& $esc $dst))
  $env:ATLAS_TEST = '1'; $env:DOGFILE_TEST_LOG = $log; $env:ATLAS_SHOT_DELAY = '2500'
  $env:ATLAS_STEPS = (ConvertTo-Json -Compress -Depth 3 @(@{ js = $js; wait = 600000 }))
  $p = Start-Process -FilePath $Exe -PassThru
  # the clock for "on disk" starts when the app reports done: its own time, plus flushing once it has quit
  $deadline = (Get-Date).AddMinutes(10); $line = $null
  while (-not $line -and (Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 50; if (Test-Path $log) { $line = Get-Content $log | Where-Object { $_ -like 'BENCH *' } | Select-Object -First 1 } }
  $flush = Flush
  if (-not $p.WaitForExit(30000)) { Stop-Process -Id $p.Id -Force }
  Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item Env:ATLAS_TEST, Env:DOGFILE_TEST_LOG, Env:ATLAS_STEPS, Env:ATLAS_SHOT_DELAY
  if ($line -match '^BENCH ([\d.]+) (.*)$') {
    $sec = [double]$Matches[1]
    Row $label $s $sec ($sec + $flush) $(if ($Matches[2] -ne 'done') { " ($($Matches[2]))" } else { '' })
  } else { $script:rows += "$label $s : no result$(if (Test-Path $log) { ' (' + ((Get-Content $log) -join ' / ') + ')' })" }
  $null = Check $s $dst; Wipe $dst
}

foreach ($s in $sets) {
  Dogfile 'Dogfile' $s 8
  if ($s -eq 'small') { Dogfile 'Dogfile, 4 at a time' $s 4; Dogfile 'Dogfile, 16 at a time' $s 16 }
  foreach ($mt in @(8, 1)) { Timed "robocopy /MT:$mt" $s "$root/robo$mt-$s" { $null = robocopy "$src/$s" "$root/robo$mt-$s" /E /MT:$mt /R:0 /W:0 /NFL /NDL /NJH /NJS /NP } }
  Timed 'Copy-Item' $s "$root/copyitem-$s" { Copy-Item -Recurse "$src/$s" "$root/copyitem-$s" }
  # File Explorer's own copy engine (the shell's CopyHere: no dialog, no questions); it returns before it's done,
  # so "done" is when every byte is there
  Timed 'File Explorer' $s "$root/explorer-$s" {
    New-Item -ItemType Directory -Force "$root/explorer-$s" | Out-Null
    $shell = New-Object -ComObject Shell.Application
    $shell.Namespace((Resolve-Path "$root/explorer-$s").Path).CopyHere((Resolve-Path "$src/$s").Path, 4 + 16 + 512 + 1024)
    $deadline = (Get-Date).AddMinutes(6)
    do { Start-Sleep -Milliseconds 50; $have = (Get-ChildItem -Recurse -File "$root/explorer-$s" -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } while ($have -lt $bytes[$s] -and (Get-Date) -lt $deadline)
  }
}

$head = "big: 1 file, $([math]::Round($bytes.big / 1GB, 1)) GB · medium: 40 files, $([math]::Round($bytes.medium / 1MB)) MB · small: 5,000 files, $([math]::Round($bytes.small / 1MB)) MB · write cache emptied before each run"
$all = @($head) + @($rows)
$all | Set-Content "$Out/copybench.txt"
Write-Output "::notice title=copy speed::$($all -join '%0A')"
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
