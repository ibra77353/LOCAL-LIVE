@echo off
setlocal EnableExtensions EnableDelayedExpansion
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

if not exist "config.json" (
  echo ERROR: config.json not found.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH.
  pause
  exit /b 1
)
if not exist "logs" mkdir "logs"
if not exist "run" mkdir "run"
if not exist "srv\hls" mkdir "srv\hls"
if not exist "srv\uploads" mkdir "srv\uploads"
if not exist "ffmpeg.exe" (
  where ffmpeg >nul 2>nul
  if errorlevel 1 echo WARNING: FFmpeg not found. Put ffmpeg.exe beside server.js or add FFmpeg to PATH.
)

rem ---- المنافذ: مصدر واحد هو scripts\ports.js (نفس قواعد server.js) ----
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js 2^>nul') do set "PORTS=%%P"
if not defined PORTS (
  echo ERROR: could not read ports from data.json / config.json [scripts\ports.js].
  pause
  exit /b 1
)
for /f "tokens=1,2" %%A in ("!PORTS!") do (
  set "FW_PORT=%%A"
  set "API_PORT=%%B"
)

rem ---- جدار الحماية ----
netsh advfirewall firewall show rule name="PrinceLive HTTP !FW_PORT!" >nul 2>&1
if errorlevel 1 (
  echo Setting up Windows Firewall for viewing port !FW_PORT! - approve the UAC prompt...
  call "%ROOT%scripts\firewall.bat" quiet
)

rem ---- خدمة Node.js: لا نعلن النجاح قبل أن يجيب الخادم فعلياً ----
set "START_FAILED="
set "NODE_PID="
for /f "delims=" %%P in ('node scripts\procs.js node-pid !API_PORT! 2^>nul') do set "NODE_PID=%%P"
if defined NODE_PID goto :node_ready
set "OWNER="
for /f "delims=" %%O in ('node scripts\procs.js port-owner !API_PORT! 2^>nul') do set "OWNER=%%O"
if defined OWNER goto :node_busy
echo Starting Prince Live API on port !API_PORT!...
start "Prince Live API" /min /d "%ROOT%" node "%ROOT%server.js"
set "API_OK="
set "API_TRIES=0"

:wait_api
set /a API_TRIES+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod 'http://127.0.0.1:!API_PORT!/api/status' -TimeoutSec 2; if ($r.ok -eq $true -and $r.siteName) { exit 0 } } catch { }; exit 1"
if not errorlevel 1 set "API_OK=1"
if defined API_OK goto :node_ready
if !API_TRIES! GEQ 30 goto :node_failed
timeout /t 1 /nobreak >nul
goto :wait_api

:node_failed
echo ERROR: the Prince Live API did not answer on port !API_PORT! within 30 seconds.
echo        Read logs\server.log for the reason.
set "START_FAILED=1"
goto :nginx

:node_busy
echo ERROR: port !API_PORT! is already used by another program: !OWNER!
echo        The Prince Live API was NOT started. Close that program or change the port.
set "START_FAILED=1"
goto :nginx

:node_ready
echo OK: Node API is running on port !API_PORT!.

rem ---- خدمة Nginx ----
:nginx
if not exist "nginx\nginx.exe" (
  echo WARNING: nginx\nginx.exe not found. The viewer is served by Node.js only.
  goto :summary
)
call "%ROOT%scripts\nginx-dirs.bat"
"nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -t
if errorlevel 1 (
  echo ERROR: Nginx configuration test failed.
  set "START_FAILED=1"
  goto :summary
)
set "NGINX_PID="
for /f "delims=" %%P in ('node scripts\procs.js nginx-pids 2^>nul') do if not defined NGINX_PID set "NGINX_PID=%%P"
if defined NGINX_PID (
  echo OK: Nginx is already running: PID !NGINX_PID!.
) else (
  echo Starting Nginx on port !FW_PORT!...
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf
)
set "NG_PORT_OK="
set "NG_TRIES=0"

:wait_nginx
set /a NG_TRIES+=1
netstat -ano | findstr /R /C:":!FW_PORT! .*LISTENING" >nul 2>&1 && set "NG_PORT_OK=1"
if defined NG_PORT_OK goto :nginx_port_ok
if !NG_TRIES! GEQ 10 goto :nginx_port_failed
timeout /t 1 /nobreak >nul
goto :wait_nginx

:nginx_port_failed
echo ERROR: Nginx is not listening on port !FW_PORT!. Check nginx\logs\error.log
set "START_FAILED=1"
goto :summary

:nginx_port_ok
echo OK: Nginx is listening on port !FW_PORT!.

:summary
echo.
echo ---------------------------------------------
echo Local UI:  http://127.0.0.1:!API_PORT!
echo Nginx UI:  http://127.0.0.1:!FW_PORT!/
echo ---------------------------------------------
if not defined START_FAILED goto :started
echo.
echo Prince Live did NOT start completely. Read the errors above.
pause
exit /b 1

:started
echo.
echo Prince Live is running.
pause
exit /b 0
