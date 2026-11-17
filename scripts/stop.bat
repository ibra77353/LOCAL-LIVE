@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Full stop: close the streams through the API first, then stop Nginx, then the Node.js server.
rem These files stop only PrinceLive's own processes:
rem   - Nginx: identified by the project's nginx\nginx.exe path (scripts\procs.js)
rem   - Node.js: identified by the %ROOT%\server.js command line or run\server.pid
rem Run logs (logs and nginx\logs) are not deleted by a normal stop.
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

rem ---- Ports: single source is scripts\ports.js (same rules as server.js) ----
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

rem ---- Stop only this project's Nginx ----
if not exist "nginx\nginx.exe" goto :node
call "%ROOT%scripts\nginx-stop.bat"
if errorlevel 1 (
  echo ERROR: Prince Live nginx.exe is still running. Run this file as Administrator.
  set "STOP_FAILED=1"
)

rem ---- Stop only this project's Node.js server ----
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
rem HLS files are no longer served after a stop: delete them so an old stream cannot look live.
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
