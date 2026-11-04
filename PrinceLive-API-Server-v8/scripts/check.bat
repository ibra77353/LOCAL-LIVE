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
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c=Get-Content -Raw -Encoding UTF8 'config.json' | ConvertFrom-Json; $d=Get-Content -Raw -Encoding UTF8 'data.json' | ConvertFrom-Json; Write-Host 'OK: valid JSON'; Write-Host ('Config: host='+$c.host+' / Node port='+$d.settings.port); Write-Host ('FFmpeg: '+$d.settings.ffmpegPath); Write-Host ('Nginx: '+$d.settings.nginxPath); Write-Host ('Output: '+$d.settings.outputWidth+'x'+$d.settings.outputHeight+' / '+$d.settings.outputFps+' FPS'); Write-Host ('Sources: '+@($d.sources).Count+'  Channels: '+@($d.channels).Count); if (@($d.sources).Count -gt 0) { Write-Host ('Video device: '+$d.sources[0].videoDevice); Write-Host ('Audio device: '+$d.sources[0].audioDevice) } } catch { Write-Host ('ERROR: '+$_.Exception.Message); exit 1 }"
echo.
echo ==== Nginx ====
if exist "nginx\nginx.exe" call "%ROOT%scripts\nginx-dirs.bat"
if exist "nginx\nginx.exe" ("nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -t) else echo MISSING: nginx\nginx.exe
echo.
set "API_PORT="
set "NGINX_PORT="
for /f "tokens=1,2" %%A in ('node scripts\ports.js') do (
  set "NGINX_PORT=%%A"
  set "API_PORT=%%B"
)
if not defined API_PORT set "API_PORT=3001"
if not defined NGINX_PORT set "NGINX_PORT=80"
echo ==== Listening ports %NGINX_PORT% and %API_PORT% ====
netstat -ano | findstr /R /C:":%NGINX_PORT% .*LISTENING" /C:":%API_PORT% .*LISTENING"
pause
