@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Stops only the PrinceLive Nginx (delegated to scripts\nginx-stop.bat).
set "ROOT=%~dp0"
if not exist "%ROOT%server.js" (
  if exist "%ROOT%..\server.js" (
    for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
  )
)
if not exist "%ROOT%server.js" (
  echo ERROR: server.js not found. Put this BAT in the project root or one subfolder.
  pause
  exit /b 1
)
cd /d "%ROOT%"

if not exist "nginx\nginx.exe" (
  echo ERROR: nginx\nginx.exe not found.
  pause
  exit /b 1
)
call "%ROOT%scripts\nginx-stop.bat"
if errorlevel 1 (
  echo ERROR: Nginx did not stop.
  pause
  exit /b 1
)
pause
exit /b 0
