@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem إيقاف كامل: أولاً إغلاق البث عبر API، ثم إيقاف Nginx، ثم خادم Node.js.
rem لا تُوقف هذه الملفات إلا عمليات PrinceLive نفسها:
rem   - Nginx: يُحدَّد من مسار nginx\nginx.exe داخل المشروع (scripts\procs.js)
rem   - Node.js: يُحدَّد من سطر الأوامر %ROOT%\server.js أو run\server.pid
rem سجلات التشغيل (logs وnginx\logs) لا تُحذف عند الإيقاف العادي.
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

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH.
  echo        Prince Live processes are identified through scripts\procs.js, which needs Node.js.
  pause
  exit /b 1
)

rem ---- المنافذ: مصدر واحد هو scripts\ports.js (نفس قواعد server.js) ----
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js 2^>nul') do set "PORTS=%%P"
if not defined PORTS (
  echo ERROR: could not read ports from data.json / config.json [scripts\ports.js].
  pause
  exit /b 1
)
for /f "tokens=2" %%P in ("!PORTS!") do set "API_PORT=%%P"

set "STOP_FAILED="
echo Requesting stream stop through the local API on port !API_PORT!...
node -e "const http=require('http'),fs=require('fs');let token='';try{token=fs.readFileSync('run/control.token','utf8').trim()}catch{};if(token.length===0){console.log('run/control.token missing: Node may not be running');process.exit(0)}const r=http.request({host:'127.0.0.1',port:%API_PORT%,path:'/api/stop',method:'POST',timeout:15000,headers:{'X-Control-Token':token,'Content-Length':0}},res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>console.log('HTTP '+res.statusCode+' '+d));});r.on('error',e=>console.log('API not responding: '+e.message));r.on('timeout',()=>{console.log('API timeout after 15s: stopping Node anyway');r.destroy()});r.end();"
echo.

rem ---- إيقاف Nginx الخاص بالمشروع فقط ----
if not exist "nginx\nginx.exe" goto :node
call "%ROOT%scripts\nginx-stop.bat"
if errorlevel 1 (
  echo ERROR: Prince Live nginx.exe is still running. Run this file as Administrator.
  set "STOP_FAILED=1"
)

rem ---- إيقاف خادم Node.js الخاص بالمشروع فقط ----
:node
set "NODE_PID="
for /f "delims=" %%P in ('node scripts\procs.js node-pid !API_PORT! 2^>nul') do set "NODE_PID=%%P"
if defined NODE_PID goto :kill_node
echo Prince Live Node.js is not running.
set "OWNER="
for /f "delims=" %%O in ('node scripts\procs.js port-owner !API_PORT! 2^>nul') do set "OWNER=%%O"
if defined OWNER echo NOTE: port !API_PORT! is used by another program: !OWNER! - it was left untouched.
goto :clean

:kill_node
echo Stopping Prince Live Node.js [PID !NODE_PID!]...
taskkill /PID !NODE_PID! /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
set "NODE_PID="
for /f "delims=" %%P in ('node scripts\procs.js node-pid !API_PORT! 2^>nul') do set "NODE_PID=%%P"
if not defined NODE_PID goto :node_ok
echo ERROR: Prince Live Node.js is still running [PID !NODE_PID!]. Run this file as Administrator.
set "STOP_FAILED=1"
goto :clean
:node_ok
echo Node.js stopped.

:clean
echo.
rem ملفات HLS لم تعد تُعرض بعد الإيقاف: تُحذف حتى لا يظهر بث قديم كمباشر.
if exist "srv\hls" (
  echo Cleaning srv\hls [stale HLS segments of stopped channels]...
  for /d %%D in ("srv\hls\*") do rd /s /q "%%D" >nul 2>&1
  del /q "srv\hls\*" >nul 2>&1
  echo srv\hls cleaned.
)
echo Run logs are kept: logs\server.log and nginx\logs\*.log
echo.

:done
echo.
if defined STOP_FAILED (
  echo Prince Live did NOT stop completely. See the errors above.
  pause
  exit /b 1
)
echo Prince Live stopped.
pause
exit /b 0
