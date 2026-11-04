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
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 (
  echo Nginx is not running.
  pause
  exit /b 0
)
echo Stopping Nginx...
"nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -s quit
rem التحقق بعد الأمر: -s quit لا يُنهي nginx إن كان ملف الـ pid قديماً.
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 goto :ok
echo Nginx did not exit cleanly; forcing it to close...
taskkill /IM nginx.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 goto :ok
echo ERROR: nginx.exe is still running. Close it from Task Manager.
pause
exit /b 1
:ok
echo Nginx stopped.
pause
exit /b 0
