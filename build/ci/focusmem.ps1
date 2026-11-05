# Memory of the app and its web view with a heavy folder: in front, then after another program has been in front for a while.
param([string]$Exe, [string]$Dir, [string]$Out, [string]$Label)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
function Note($t) { Write-Output "::notice title=mem-$Label::$t" }
function Mem($rootId, $what) {
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootId)
  $procs = Get-Process | Where-Object { $_.ProcessName -eq 'msedgewebview2' -or $_.ProcessName -eq 'dogfile' }
  $sum = 0; $rows = @()
  foreach ($x in $procs) { $b = $x.PrivateMemorySize64 / 1MB; $sum += $b; $rows += ("{0}:{1:N0}" -f $x.ProcessName, $b) }
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE 'dogfile%' OR Name LIKE 'msedgewebview2%'"
  $priv = ($perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
  $t = "{0}: {1} processes, private working set {2:N1} MB (private bytes {3:N0} MB) [{4}]" -f $what, $perf.Count, $priv, $sum, ($rows -join ' ')
  Note $t
  $t
}
$all = @()
$p = Start-Process -FilePath $Exe -ArgumentList "`"$Dir`"" -PassThru
Note "started pid $($p.Id)"
Start-Sleep -Seconds 40
$all += Mem $p.Id "in front after 40 s"
Start-Sleep -Seconds 20
$all += Mem $p.Id "in front after 60 s"
$n = Start-Process notepad -PassThru
Note "notepad started"
Start-Sleep -Seconds 45
$all += Mem $p.Id "behind another program for 45 s"
$all | Set-Content "$Out/$Label.txt"
Get-Process | Where-Object { $_.ProcessName -in 'dogfile','msedgewebview2' } | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Process -Id $n.Id -Force -ErrorAction SilentlyContinue
