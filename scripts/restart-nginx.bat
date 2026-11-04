@echo off
setlocal EnableExtensions
rem Find project root whether this BAT is in the root or a subfolder.
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
call "%ROOT%scripts\nginx-dirs.bat"
"nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -t
if errorlevel 1 (
  echo ERROR: config test failed; reload cancelled.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 (
  echo Nginx is not running. Starting it...
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf
) else (
  echo Reloading Nginx...
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -s reload
)
if errorlevel 1 echo WARNING: Check nginx\logs\error.log.
pause
