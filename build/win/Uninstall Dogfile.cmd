@echo off
title Uninstall Dogfile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" -Uninstall
