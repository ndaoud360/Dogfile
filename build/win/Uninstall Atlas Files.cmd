@echo off
title Uninstall Atlas Files
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" -Uninstall
