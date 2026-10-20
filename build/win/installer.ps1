# Atlas Files installer (per-user, no admin needed)
param([switch]$Uninstall, [switch]$Default, [switch]$Quiet)
$ErrorActionPreference = 'Continue'
$AppName   = 'Atlas Files'
$Src       = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest      = Join-Path $env:LOCALAPPDATA 'Programs\Atlas Files'
$Exe       = Join-Path $Dest 'AtlasFiles.exe'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Atlas Files.lnk'
$DesktopLn = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Atlas Files.lnk'
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AtlasFiles'
$DefaultKeys = @(
  'HKCU\Software\Classes\Folder\shell\open\command',
  'HKCU\Software\Classes\Folder\shell\explore\command',
  'HKCU\Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command'
)

function Set-AtlasDefault([string]$exe) {
  foreach ($k in $DefaultKeys) {
    $cmd = if ($k -like '*opennewwindow*') { "`"$exe`"" } else { "`"$exe`" `"%1`"" }
    & reg.exe add $k /ve /t REG_SZ /d $cmd /f | Out-Null
    & reg.exe add $k /v DelegateExecute /t REG_SZ /d '' /f | Out-Null
  }
}
function Remove-AtlasDefault {
  & reg.exe delete 'HKCU\Software\Classes\Folder\shell\open' /f 2>$null | Out-Null
  & reg.exe delete 'HKCU\Software\Classes\Folder\shell\explore' /f 2>$null | Out-Null
  & reg.exe delete 'HKCU\Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}' /f 2>$null | Out-Null
}
function New-Shortcut($path, $target) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path); $s.TargetPath = $target; $s.WorkingDirectory = Split-Path $target; $s.IconLocation = "$target,0"; $s.Description = $AppName; $s.Save()
}

if ($Uninstall) {
  Get-Process AtlasFiles -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-AtlasDefault
  Remove-Item $StartMenu, $DesktopLn -ErrorAction SilentlyContinue
  # right-click verbs added from Settings (Edit with Atlas Notepad / Play with Atlas Player / View with Atlas Photos)
  foreach ($k in @('HKCU\Software\Classes\*\shell\AtlasEdit', 'HKCU\Software\Classes\SystemFileAssociations\video\shell\AtlasPlay', 'HKCU\Software\Classes\SystemFileAssociations\audio\shell\AtlasPlay', 'HKCU\Software\Classes\SystemFileAssociations\image\shell\AtlasView')) { & reg.exe delete $k /f 2>$null | Out-Null }
  Remove-Item $UninstKey -Recurse -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host 'Atlas Files was removed and Windows File Explorer is the default again.' -ForegroundColor Green
  if (-not $Quiet) { Read-Host 'Press Enter to close' | Out-Null }
  exit 0
}

Write-Host "Installing $AppName to $Dest ..." -ForegroundColor Cyan
Get-Process AtlasFiles -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
robocopy $Src $Dest /E /NFL /NDL /NJH /NJS /NP /XF 'Install Atlas Files.cmd' | Out-Null
New-Shortcut $StartMenu $Exe
if (-not $Quiet) { if ((Read-Host 'Create a desktop shortcut? (Y/N)') -match '^[Yy]') { New-Shortcut $DesktopLn $Exe } }

New-Item -Path $UninstKey -Force | Out-Null
Set-ItemProperty $UninstKey DisplayName $AppName
Set-ItemProperty $UninstKey DisplayIcon "$Exe,0"
Set-ItemProperty $UninstKey Publisher 'Atlas'
Set-ItemProperty $UninstKey DisplayVersion '1.5.1'
Set-ItemProperty $UninstKey InstallLocation $Dest
Set-ItemProperty $UninstKey UninstallString "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dest\installer.ps1`" -Uninstall"
Set-ItemProperty $UninstKey NoModify 1 -Type DWord
Set-ItemProperty $UninstKey NoRepair 1 -Type DWord

$makeDefault = $Default
if (-not $Quiet -and -not $Default) { $makeDefault = (Read-Host 'Make Atlas Files the default file manager (folders, Win+E)? (Y/N)') -match '^[Yy]' }
if ($makeDefault) { Set-AtlasDefault $Exe; Write-Host 'Atlas Files is now the default file manager. (Undo any time in Settings > General or by uninstalling.)' -ForegroundColor Green }

Write-Host "Done! Launching $AppName..." -ForegroundColor Green
Start-Process $Exe
if (-not $Quiet) { Start-Sleep -Seconds 2 }
