@echo off
setlocal EnableExtensions
rem إيقاف كامل: قنوات البث ثم Nginx ثم خادم Node.js.
rem المنفذ من data.json ورمز التحكّم المحلي من run/control.token بدل تثبيت 3001 أو تجاهل المصادقة.
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

set "API_PORT="
for /f "tokens=2" %%P in ('node scripts\ports.js 2^>nul') do set "API_PORT=%%P"
if not defined API_PORT set "API_PORT=3001"

echo Requesting stream stop through the local API (port %API_PORT%)...
node -e "const http=require('http'),fs=require('fs');let token='';try{token=fs.readFileSync('run/control.token','utf8').trim()}catch{};if(!token){console.log('run/control.token missing: Node may not be running');process.exit(0)}const r=http.request({host:'127.0.0.1',port:(()=>{let p=3001;try{p=Number(require('./data.json').settings.port)||p}catch{}return p})(),path:'/api/stop',method:'POST',timeout:8000,headers:{'X-Control-Token':token,'Content-Length':0}},res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>console.log('HTTP '+res.statusCode+' '+d));});r.on('error',e=>console.log('API not responding: '+e.message));r.on('timeout',()=>{console.log('API timeout after 8s: stopping Node anyway');r.destroy()});r.end();"
echo.

rem Nginx: قد يفشل -s quit إذا كان ملف nginx\logs\nginx.pid قديماً (بعد إغلاق قسري سابق)،
rem فيبقى nginx.exe ماسكاً للمنفذ 80 رغم رسالة "تم الإيقاف". لذلك نتحقق من العملية بعد الأمر.
if not exist "nginx\nginx.exe" goto :node
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 (
  echo Nginx is not running.
  goto :node
)
echo Stopping Nginx...
"nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -s quit
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 goto :nginx_ok
echo Nginx did not exit cleanly; forcing it to close...
taskkill /IM nginx.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 goto :nginx_ok
echo ERROR: nginx.exe is still running. Close it from Task Manager and run this file again.
set "STOP_FAILED=1"
goto :node
:nginx_ok
echo Nginx stopped.

:node
set "NODE_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%API_PORT% .*LISTENING"') do set "NODE_PID=%%p"
if not defined NODE_PID (
  echo Node.js is not running on port %API_PORT%.
  goto :done
)
echo Stopping Node.js (PID %NODE_PID%)...
taskkill /PID %NODE_PID% /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
set "NODE_LEFT="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%API_PORT% .*LISTENING"') do set "NODE_LEFT=%%p"
if not defined NODE_LEFT goto :node_ok
echo ERROR: Node.js is still listening on port %API_PORT% (PID %NODE_LEFT%). Run this file as Administrator.
set "STOP_FAILED=1"
goto :done
:node_ok
echo Node.js stopped.

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
