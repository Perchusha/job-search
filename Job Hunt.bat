@echo off
setlocal
cd /d "%~dp0"
title Job Hunt

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download it once from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\tsx\dist\cli.mjs" (
  echo.
  echo First launch: installing application files...
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

if not defined JOBHUNT_PORT set "JOBHUNT_PORT=4321"
set "JOBHUNT_HOST=0.0.0.0"

echo.
echo ======================================================
echo   JOB HUNT IS RUNNING
echo ======================================================
echo.
echo   This computer:  http://localhost:%JOBHUNT_PORT%
echo   Same Wi-Fi:
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike 'vEthernet*' } | Select-Object -ExpandProperty IPAddress -Unique"`) do echo                   http://%%I:%JOBHUNT_PORT%
echo.
echo   Close this window to stop the application.
echo ======================================================
echo.

if not defined JOBHUNT_NO_OPEN start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%JOBHUNT_PORT%'"

node.exe "node_modules\tsx\dist\cli.mjs" "src\dashboard.ts"

echo.
echo The application stopped.
pause
