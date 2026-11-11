@echo off
title Cabinet CAM - update
cd /d "%~dp0"
echo.
echo  To update: close the "Cabinet CAM" window. Open the new cabinet-cam.zip,
echo  copy everything inside its "Cabinet CAM" folder into this folder and
echo  replace the files (your .env, tools, settings, remnants and jobs are not
echo  in the zip, so they're kept). Then press any key here.
pause >nul
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call npm install --no-fund --no-audit
echo.
echo  Updated. Start it from the desktop icon, then press Ctrl+Shift+R in the browser once.
pause
