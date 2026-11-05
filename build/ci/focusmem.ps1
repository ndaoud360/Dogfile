# Memory of the app and its web view with a heavy folder: in front, then after another program has been in front for a while.
param([string]$Exe, [string]$Dir, [string]$Out, [string]$Label)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
function Tree($rootId) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($rootId)
  do { $n = $ids.Count; foreach ($x in $all) { if ($ids.Contains([int]$x.ParentProcessId)) { [void]$ids.Add([int]$x.ProcessId) } } } while ($ids.Count -ne $n)
  foreach ($x in $all) { if ($x.Name -eq 'msedgewebview2.exe') { [void]$ids.Add([int]$x.ProcessId) } }
  $ids
}
function Mem($ids, $what) {
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) }
  $priv = ($perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
  $rows = foreach ($x in $perf) { "  {0,-18} private {1,7:N1} MB" -f $x.Name, ($x.WorkingSetPrivate/1MB) }
  ("{0}: {1} processes, private working set {2:N1} MB`n{3}" -f $what, $perf.Count, $priv, ($rows -join "`n"))
}
$p = Start-Process -FilePath $Exe -ArgumentList "`"$Dir`"" -PassThru
Start-Sleep -Seconds 45
$ids = Tree $p.Id
$a = Mem $ids "$Label in front, after 45 s"
Start-Sleep -Seconds 20
$b = Mem (Tree $p.Id) "$Label in front, after 65 s"
$n = Start-Process notepad -PassThru   # takes the front
Start-Sleep -Seconds 50
$c = Mem (Tree $p.Id) "$Label behind another program for 50 s"
($a, $b, $c) -join "`n" | Set-Content "$Out/$Label.txt"
Get-Content "$Out/$Label.txt"
foreach ($i in (Tree $p.Id)) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $n.Id -Force -ErrorAction SilentlyContinue
