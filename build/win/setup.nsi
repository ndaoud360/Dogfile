; Dogfile setup program (per-user, no admin needed). Built by CI with NSIS:
;   makensis /DVERSION=2.1.0 /DSRC=dist\Dogfile /DOUT=Dogfile-Setup-2.1.0.exe build\win\setup.nsi
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "2.0.0"
!endif
!ifndef SRC
  !define SRC "..\..\dist\Dogfile"
!endif
!ifndef OUT
  !define OUT "Dogfile-Setup-${VERSION}.exe"
!endif
!ifndef ARCH
  !define ARCH "x64"
!endif

Name "Dogfile"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Dogfile"
InstallDirRegKey HKCU "Software\Dogfile" "InstallDir"
BrandingText "Dogfile ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Dogfile"
VIAddVersionKey "FileDescription" "Dogfile setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Dogfile"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!define MUI_ICON "..\..\app\icons\icon.ico"
!define MUI_UNICON "..\..\app\icons\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install Dogfile"
!define MUI_WELCOMEPAGE_TEXT "Dogfile is a fast file manager for Windows with tabs, split panes, instant search, and built-in Notepad, Photos and Player.$\r$\n$\r$\nIt installs just for you; no administrator rights needed."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Dogfile.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Dogfile"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dogfile"
!define WV2 "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Function .onInit
  ; one copy at a time: close a running Dogfile first (it saves its tabs)
  nsExec::Exec 'taskkill /IM Dogfile.exe'
  Sleep 400
FunctionEnd

Section "Dogfile (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  nsExec::Exec 'taskkill /F /IM Dogfile.exe'
  File /r /x "Install Dogfile.cmd" /x "Uninstall Dogfile.cmd" /x "installer.ps1" "${SRC}\*.*"
  ; installed by this setup program: updates are applied in place
  Delete "$INSTDIR\portable.txt"
  WriteRegStr HKCU "Software\Dogfile" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall Dogfile.exe"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "Dogfile"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "Dogfile"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\Dogfile.exe"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall Dogfile.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\Uninstall Dogfile.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" $0
  CreateShortCut "$SMPROGRAMS\Dogfile.lnk" "$INSTDIR\Dogfile.exe" "" "$INSTDIR\Dogfile.exe" 0
  ; Dogfile draws its windows with Microsoft Edge WebView2 (part of Windows 11 and up-to-date Windows 10)
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WV2}" "pv"
  StrCmp $0 "" 0 wv_ok
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2}" "pv"
  StrCmp $0 "" 0 wv_ok
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2}" "pv"
  StrCmp $0 "" 0 wv_ok
  DetailPrint "Installing Microsoft Edge WebView2 Runtime…"
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$f=Join-Path $$env:TEMP ''MicrosoftEdgeWebview2Setup.exe''; Invoke-WebRequest ''https://go.microsoft.com/fwlink/p/?LinkId=2124703'' -OutFile $$f -UseBasicParsing; Start-Process $$f -ArgumentList ''/silent /install'' -Wait"'
  wv_ok:
  ; Dogfile used to be called Atlas Files: remove the old program's shortcuts (settings move over on first start)
  Delete "$SMPROGRAMS\Atlas Files.lnk"
  Delete "$DESKTOP\Atlas Files.lnk"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortCut "$DESKTOP\Dogfile.lnk" "$INSTDIR\Dogfile.exe" "" "$INSTDIR\Dogfile.exe" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Dogfile, its Notepad, Photos and Player, the media engine (FFmpeg) and 7-Zip."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A Dogfile icon on your desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM Dogfile.exe'
  Sleep 500
  ; give Explorer back what Dogfile took over (default file manager, right-click verbs)
  DeleteRegKey HKCU "Software\Classes\Folder\shell\open"
  DeleteRegKey HKCU "Software\Classes\Folder\shell\explore"
  DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
  DeleteRegKey HKCU "Software\Classes\*\shell\DogfileEdit"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\video\shell\DogfilePlay"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\audio\shell\DogfilePlay"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\DogfileView"
  Delete "$SMPROGRAMS\Dogfile.lnk"
  Delete "$DESKTOP\Dogfile.lnk"
  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\Dogfile"
  ; your settings stay in %APPDATA%\Dogfile unless you remove them yourself
  RMDir /r "$INSTDIR"
SectionEnd
