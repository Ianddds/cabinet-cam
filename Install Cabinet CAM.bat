@echo off
setlocal
title Cabinet CAM - install
cd /d "%~dp0"
echo.
echo  Cabinet CAM - one-time setup
echo  ============================
echo.

rem ---- 1. Node.js 22 or newer ----
set "NODE="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
if defined NODEV (
  for /f "tokens=1 delims=." %%m in ("%NODEV:~1%") do if %%m GEQ 22 set "NODE=node"
)
if not defined NODE (
  echo  Installing Node.js LTS ^(needs internet; Windows may ask for permission^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  node -v >nul 2>&1 || (
    echo.
    echo  Could not install Node.js automatically.
    echo  Install the LTS version from https://nodejs.org, then run this file again.
    pause
    exit /b 1
  )
)
echo  Node.js:
node -v

rem ---- 2. The app's packages ----
echo.
echo  Installing the app's packages...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo  npm install failed - check the internet connection and run this file again.
  pause
  exit /b 1
)

rem ---- 3. Onshape keys (.env) ----
if exist ".env" (
  echo.
  echo  Found .env - keeping it.
) else (
  echo.
  echo  Onshape API keys: create them at https://dev-portal.onshape.com - API keys
  echo  ^(read access is enough^). Paste each one and press Enter.
  echo  Leave them blank to fill in later: copy .env.example to .env and edit it.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$a = Read-Host ' Access key'; $s = Read-Host ' Secret key';" ^
    "$t = Get-Content -Raw '.env.example';" ^
    "$t = $t -replace '(?m)^ONSHAPE_ACCESS_KEY=.*$', ('ONSHAPE_ACCESS_KEY=' + $a.Trim()) -replace '(?m)^ONSHAPE_SECRET_KEY=.*$', ('ONSHAPE_SECRET_KEY=' + $s.Trim());" ^
    "Set-Content -Path '.env' -Value $t -NoNewline"
)

rem ---- 4. Desktop icon ----
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell; $l = $w.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Cabinet CAM.lnk'));" ^
  "$l.TargetPath = '%~dp0Start Cabinet CAM.bat'; $l.WorkingDirectory = '%~dp0'; $l.IconLocation = 'shell32.dll,12'; $l.WindowStyle = 7; $l.Save()"

echo.
echo  Done. A "Cabinet CAM" icon is on the desktop - double-click it to start.
echo.
choice /c YN /m " Start Cabinet CAM now"
if errorlevel 2 exit /b 0
call "%~dp0Start Cabinet CAM.bat"
