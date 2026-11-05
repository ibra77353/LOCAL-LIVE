@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem يُوقف عمليات Nginx التي تخص هذا المشروع فقط، وينتظر خروجها.
rem التمييز يتم بمسار nginx\nginx.exe داخل المشروع (scripts\procs.js) وليس بالاسم،
rem حتى لا يتأثر أي Nginx آخر يعمل على الجهاز.
rem رموز الخروج: 0 = أُوقف أو لم يكن يعمل، 1 = ما زال يعمل، 2 = nginx.exe غير موجود.
set "ROOT=%~dp0"
if not exist "%ROOT%..\server.js" (
  if not exist "%ROOT%server.js" (
    echo ERROR: project root not found.
    exit /b 2
  )
)
if exist "%ROOT%..\server.js" for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
cd /d "%ROOT%"
if not exist "nginx\nginx.exe" exit /b 2

call :list_pids
if not defined NGINX_PIDS (
  echo Prince Live Nginx is not running.
  exit /b 0
)
echo Stopping Prince Live Nginx [PIDs:!NGINX_PIDS!]...

rem nginx -s quit يقرأ المعرّف من nginx\logs\nginx.pid، فنستخدمه فقط عندما يكون
rem هذا المعرّف من عمليات المشروع، وإلا فقد نرسل الإشارة إلى عملية أخرى.
set "NGINX_PIDFILE="
if exist "nginx\logs\nginx.pid" for /f "usebackq delims=" %%P in ("nginx\logs\nginx.pid") do set "NGINX_PIDFILE=%%P"
set "QUIT_OK="
set "NGINX_LIST=!NGINX_PIDS! "
if defined NGINX_PIDFILE echo !NGINX_LIST!| findstr /C:" !NGINX_PIDFILE! " >nul 2>&1 && set "QUIT_OK=1"
if defined QUIT_OK (
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -s quit >nul 2>&1
  timeout /t 2 /nobreak >nul
) else (
  echo Nginx pid file is missing or belongs to another process; closing by verified PID.
)

call :list_pids
if not defined NGINX_PIDS goto :stopped
echo Nginx did not exit cleanly; forcing the Prince Live processes to close...
for %%P in (!NGINX_PIDS!) do taskkill /PID %%P /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
call :list_pids
if not defined NGINX_PIDS goto :stopped
echo ERROR: Prince Live nginx.exe is still running [PIDs:!NGINX_PIDS!]. Close it from Task Manager.
exit /b 1

:stopped
echo Nginx stopped.
exit /b 0

:list_pids
set "NGINX_PIDS="
for /f "delims=" %%P in ('node scripts\procs.js nginx-pids 2^>nul') do set "NGINX_PIDS=!NGINX_PIDS! %%P"
exit /b 0
