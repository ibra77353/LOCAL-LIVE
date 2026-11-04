@echo off
setlocal EnableExtensions
rem إيقاف كامل: قنوات البث ثم Nginx ثم خادم Node.js.
rem المنفذ وبيانات الإدارة تُقرأ من config.json بدل تثبيت 3001 أو تجاهل المصادقة.
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
for /f "delims=" %%P in ('node -e "const c=require('./config.json');process.stdout.write(String(Number(c.port)||3001))"') do set "API_PORT=%%P"
if not defined API_PORT set "API_PORT=3001"

echo Requesting stream stop through the local API (port %API_PORT%)...
node -e "const http=require('http'),c=require('./config.json');const auth=Buffer.from(String((c.admin&&c.admin.user)||c.adminUsername||'admin')+':'+String((c.admin&&c.admin.defaultPassword)||c.adminPassword||'')).toString('base64');const r=http.request({host:'127.0.0.1',port:Number(c.port)||3001,path:'/api/stop',method:'POST',headers:{Authorization:'Basic '+auth,'Content-Length':0}},res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>console.log('HTTP '+res.statusCode+' '+d));});r.on('error',e=>console.log('API not responding: '+e.message));r.end();"
echo.

if not exist "nginx\nginx.exe" goto :stopnode
tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
if errorlevel 1 (
  echo Nginx is not running.
) else (
  echo Stopping Nginx...
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -s quit
)

:stopnode
set "NODE_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%API_PORT% .*LISTENING"') do set "NODE_PID=%%p"
if defined NODE_PID (
  echo Stopping Node.js (PID %NODE_PID%)...
  taskkill /PID %NODE_PID% /T /F >nul
) else (
  echo Node.js is not running on port %API_PORT%.
)
echo.
echo Prince Live stopped.
pause
exit /b 0
