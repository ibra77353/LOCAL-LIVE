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

echo ==== Node.js ====
where node
if errorlevel 1 echo ERROR: Node.js not found in PATH.
node --version 2>nul
echo.
echo ==== Project files ====
if exist "server.js" (echo OK: server.js) else echo MISSING: server.js
if exist "config.json" (echo OK: config.json) else echo MISSING: config.json
echo.
echo ==== Config JSON and stream settings ====
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c=Get-Content -Raw -Encoding UTF8 'config.json' | ConvertFrom-Json; Write-Host 'OK: valid JSON'; Write-Host ('FFmpeg: '+$c.ffmpegPath); Write-Host ('Video device: '+$c.videoDevice); Write-Host ('Audio device: '+$c.audioDevice); Write-Host ('Output: '+$c.outputWidth+'x'+$c.outputHeight+' / '+$c.outputFps+' FPS / '+$c.videoBitrate); } catch { Write-Host ('ERROR: '+$_.Exception.Message); exit 1 }"
echo.
echo ==== Nginx ====
if exist "nginx\nginx.exe" ("nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -t) else echo MISSING: nginx\nginx.exe
echo.
set "API_PORT="
for /f "delims=" %%P in ('node -e "const c=require('./config.json');process.stdout.write(String(Number(c.port)||3001))"') do set "API_PORT=%%P"
set "NGINX_PORT="
for /f "delims=" %%P in ('node -e "const c=require('./config.json');process.stdout.write(String(Number(c.nginxPort)||80))"') do set "NGINX_PORT=%%P"
if not defined API_PORT set "API_PORT=3001"
if not defined NGINX_PORT set "NGINX_PORT=80"
echo ==== Listening ports %NGINX_PORT% and %API_PORT% ====
netstat -ano | findstr /R /C:":%NGINX_PORT% .*LISTENING" /C:":%API_PORT% .*LISTENING"
pause
