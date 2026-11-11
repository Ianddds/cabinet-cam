@echo off
cd /d "%~dp0"
rem Already running? Just open it.
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:3100/ ) | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto open
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if not exist node_modules (
  echo Cabinet CAM isn't installed yet - run "Install Cabinet CAM.bat" first.
  pause
  exit /b 1
)
start "Cabinet CAM (close this window to stop it)" /min cmd /k "npm start"
rem give the server a moment
powershell -NoProfile -Command "for ($i = 0; $i -lt 20; $i++) { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://localhost:3100/) | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }"
:open
start "" http://localhost:3100
