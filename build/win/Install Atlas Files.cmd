@echo off
title Install Atlas Files
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" %*
