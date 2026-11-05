# Memory of the app and its web view with a heavy folder: in front, then after another program has been in front for a while.
param([string]$Exe, [string]$Dir, [string]$Out, [string]$Label)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
function Note($t) { Write-Host "::notice title=mem-$Label::$t" }
function Mem($what) {
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -like 'dogfile*' -or $_.Name -like 'msedgewebview2*' }
  $priv = ($perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
  $rows = foreach ($x in $perf) { "{0} {1:N0}" -f $x.Name, ($x.WorkingSetPrivate/1MB) }
  $t = "{0}: {1} processes, private working set {2:N1} MB [{3}]" -f $what, $perf.Count, $priv, ($rows -join ', ')
  Note $t
  return $t
}
$all = @()
$p = Start-Process -FilePath $Exe -ArgumentList "`"$Dir`"" -PassThru
Note "started pid $($p.Id)"
Start-Sleep -Seconds 40
$all += Mem "in front after 40 s"
Start-Sleep -Seconds 20
$all += Mem "in front after 60 s"
$n = Start-Process "$env:WINDIR\System32\notepad.exe" -PassThru
Note "notepad started"
Start-Sleep -Seconds 45
$all += Mem "behind another program for 45 s"
$all | Set-Content "$Out/$Label.txt"
Get-Process | Where-Object { $_.ProcessName -in 'dogfile','msedgewebview2' } | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Process -Id $n.Id -Force -ErrorAction SilentlyContinue
