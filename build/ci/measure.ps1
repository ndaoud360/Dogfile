# Start a program, wait, then report the memory and CPU of it and every process it started (web view, GPU…).
# usage: measure.ps1 -Exe path -ArgList "args" -Label name -Out dir [-Seconds 25] [-Shot]
param([string]$Exe, [string]$ArgList = '', [string]$Label, [string]$Out, [int]$Seconds = 25, [switch]$Shot)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
$p = Start-Process -FilePath $Exe -ArgumentList $ArgList -PassThru
Start-Sleep -Seconds $Seconds
function Tree($rootId) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootId)
  do { $n = $ids.Count; foreach ($x in $all) { if ($ids.Contains([int]$x.ParentProcessId)) { [void]$ids.Add([int]$x.ProcessId) } } } while ($ids.Count -ne $n)
  # WebView2 runs its processes under its own parent; count the ones that belong to this program's web view
  foreach ($x in $all) { if ($x.Name -eq 'msedgewebview2.exe') { [void]$ids.Add([int]$x.ProcessId) } }
  $ids
}
function Sample($ids) {
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) }
  $procs = $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
  [pscustomobject]@{ perf = $perf; procs = $procs }
}
$ids = Tree $p.Id
$s1 = Sample $ids
$cpu1 = ($s1.procs | Measure-Object CPU -Sum).Sum
Start-Sleep -Seconds 10
$s2 = Sample $ids
$cpu2 = ($s2.procs | Measure-Object CPU -Sum).Sum
$rows = foreach ($x in $s2.perf) { "{0,-22} pid {1,6}: private working set {2,7:N1} MB, working set {3,7:N1} MB" -f $x.Name, $x.IDProcess, ($x.WorkingSetPrivate/1MB), ($x.WorkingSet/1MB) }
$priv = ($s2.perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
$ws = ($s2.perf | Measure-Object WorkingSet -Sum).Sum / 1MB
$commit = ($s2.procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
$idle = $cpu2 - $cpu1
$sum = "{0}: {1} processes, private working set (Task Manager 'Memory') {2:N1} MB, working set {3:N1} MB, private bytes {4:N1} MB, CPU while idle {5:N2} s over 10 s" -f $Label, $s2.perf.Count, $priv, $ws, $commit, $idle
if ($Shot) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save("$Out/$Label.png", [System.Drawing.Imaging.ImageFormat]::Png)
}
($rows + $sum) | Set-Content "$Out/$Label.txt"
Write-Output "::notice title=$Label::$(($rows + $sum) -join '%0A')"
foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
