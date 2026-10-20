# Dogfile installer (per-user, no admin needed)
param([switch]$Uninstall, [switch]$Default, [switch]$Quiet)
$ErrorActionPreference = 'Continue'
$AppName   = 'Dogfile'
$Src       = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest      = Join-Path $env:LOCALAPPDATA 'Programs\Dogfile'
$Exe       = Join-Path $Dest 'Dogfile.exe'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Dogfile.lnk'
$DesktopLn = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Dogfile.lnk'
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Dogfile'
$DefaultKeys = @(
  'HKCU\Software\Classes\Folder\shell\open\command',
  'HKCU\Software\Classes\Folder\shell\explore\command',
  'HKCU\Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command'
)

function Set-DogfileDefault([string]$exe) {
  foreach ($k in $DefaultKeys) {
    $cmd = if ($k -like '*opennewwindow*') { "`"$exe`"" } else { "`"$exe`" `"%1`"" }
    & reg.exe add $k /ve /t REG_SZ /d $cmd /f | Out-Null
    & reg.exe add $k /v DelegateExecute /t REG_SZ /d '' /f | Out-Null
  }
}
function Remove-DogfileDefault {
  & reg.exe delete 'HKCU\Software\Classes\Folder\shell\open' /f 2>$null | Out-Null
  & reg.exe delete 'HKCU\Software\Classes\Folder\shell\explore' /f 2>$null | Out-Null
  & reg.exe delete 'HKCU\Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}' /f 2>$null | Out-Null
}
function New-Shortcut($path, $target) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path); $s.TargetPath = $target; $s.WorkingDirectory = Split-Path $target; $s.IconLocation = "$target,0"; $s.Description = $AppName; $s.Save()
}

if ($Uninstall) {
  Get-Process Dogfile -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-DogfileDefault
  Remove-Item $StartMenu, $DesktopLn -ErrorAction SilentlyContinue
  # right-click verbs added from Settings (Edit with Dogfile Notepad / Play with Dogfile Player / View with Dogfile Photos)
  foreach ($k in @('HKCU\Software\Classes\*\shell\DogfileEdit', 'HKCU\Software\Classes\SystemFileAssociations\video\shell\DogfilePlay', 'HKCU\Software\Classes\SystemFileAssociations\audio\shell\DogfilePlay', 'HKCU\Software\Classes\SystemFileAssociations\image\shell\DogfileView')) { & reg.exe delete $k /f 2>$null | Out-Null }
  Remove-Item $UninstKey -Recurse -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host 'Dogfile was removed and Windows File Explorer is the default again.' -ForegroundColor Green
  if (-not $Quiet) { Read-Host 'Press Enter to close' | Out-Null }
  exit 0
}

Write-Host "Installing $AppName to $Dest ..." -ForegroundColor Cyan
# Dogfile used to be called Atlas Files: remove the old program (your settings move over on first start)
$OldDest = Join-Path $env:LOCALAPPDATA 'Programs\Atlas Files'
Get-Process AtlasFiles -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Atlas Files.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Atlas Files.lnk') -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AtlasFiles' -Recurse -ErrorAction SilentlyContinue
foreach ($k in @('HKCU\Software\Classes\*\shell\AtlasEdit', 'HKCU\Software\Classes\SystemFileAssociations\video\shell\AtlasPlay', 'HKCU\Software\Classes\SystemFileAssociations\audio\shell\AtlasPlay', 'HKCU\Software\Classes\SystemFileAssociations\image\shell\AtlasView')) { & reg.exe delete $k /f 2>$null | Out-Null }
if (Test-Path $OldDest) { Start-Sleep -Milliseconds 400; Remove-Item $OldDest -Recurse -Force -ErrorAction SilentlyContinue }
Get-Process Dogfile -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
robocopy $Src $Dest /E /NFL /NDL /NJH /NJS /NP /XF 'Install Dogfile.cmd' | Out-Null
New-Shortcut $StartMenu $Exe
if (-not $Quiet) { if ((Read-Host 'Create a desktop shortcut? (Y/N)') -match '^[Yy]') { New-Shortcut $DesktopLn $Exe } }

New-Item -Path $UninstKey -Force | Out-Null
Set-ItemProperty $UninstKey DisplayName $AppName
Set-ItemProperty $UninstKey DisplayIcon "$Exe,0"
Set-ItemProperty $UninstKey Publisher 'Dogfile'
Set-ItemProperty $UninstKey DisplayVersion '1.6.0'
Set-ItemProperty $UninstKey InstallLocation $Dest
Set-ItemProperty $UninstKey UninstallString "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dest\installer.ps1`" -Uninstall"
Set-ItemProperty $UninstKey NoModify 1 -Type DWord
Set-ItemProperty $UninstKey NoRepair 1 -Type DWord

$makeDefault = $Default
if (-not $Quiet -and -not $Default) { $makeDefault = (Read-Host 'Make Dogfile the default file manager (folders, Win+E)? (Y/N)') -match '^[Yy]' }
if ($makeDefault) { Set-DogfileDefault $Exe; Write-Host 'Dogfile is now the default file manager. (Undo any time in Settings > General or by uninstalling.)' -ForegroundColor Green }

Write-Host "Done! Launching $AppName..." -ForegroundColor Green
Start-Process $Exe
if (-not $Quiet) { Start-Sleep -Seconds 2 }
