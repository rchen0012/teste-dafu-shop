@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$scriptPath = Join-Path (Get-Location).Path 'finish-deployment.ps1'; Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('\"' + $scriptPath + '\"')) -Wait"
if errorlevel 1 (
  echo Setup did not finish. Right-click finish-deployment.ps1 and run it in an Administrator PowerShell.
  pause
)
