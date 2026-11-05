@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem إعادة تشغيل Nginx: تحقق من الإعدادات، ثم إيقاف نسخة PrinceLive فقط وإعادة تشغيلها.
rem لا يُستخدم "nginx -s reload" لأنه يعتمد على ملف pid قد يحمل معرّف عملية أخرى.
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
  echo ERROR: config test failed; restart cancelled.
  pause
  exit /b 1
)

call "%ROOT%scripts\nginx-stop.bat"
if errorlevel 1 (
  echo ERROR: could not stop the running Prince Live Nginx; restart cancelled.
  pause
  exit /b 1
)

echo Starting Nginx...
"nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf
if errorlevel 1 (
  echo ERROR: Nginx failed to start. Check nginx\logs\error.log
  pause
  exit /b 1
)

rem المنفذ من نفس المصدر الذي يقرأه الخادم وبقية السكربتات
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js 2^>nul') do set "PORTS=%%P"
if not defined PORTS (
  echo ERROR: could not read ports from data.json / config.json [scripts\ports.js].
  pause
  exit /b 1
)
set "FW_PORT="
for /f "tokens=1" %%P in ("!PORTS!") do set "FW_PORT=%%P"
set "NG_PORT_OK="
set "NG_TRIES=0"

:wait_nginx
set /a NG_TRIES+=1
netstat -ano | findstr /R /C:":!FW_PORT! .*LISTENING" >nul 2>&1 && set "NG_PORT_OK=1"
if defined NG_PORT_OK goto :nginx_ready
if !NG_TRIES! GEQ 10 goto :nginx_failed
timeout /t 1 /nobreak >nul
goto :wait_nginx

:nginx_failed
echo ERROR: Nginx is not listening on port !FW_PORT!.
pause
exit /b 1

:nginx_ready
echo Nginx restarted and listening on port !FW_PORT!.
pause
exit /b 0
