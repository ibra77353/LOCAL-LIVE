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
if not exist "srv\hls" mkdir "srv\hls"
if not exist "srv\uploads" mkdir "srv\uploads"
if not exist "ffmpeg.exe" (
  where ffmpeg >nul 2>nul
  if errorlevel 1 echo WARNING: FFmpeg not found. Put ffmpeg.exe beside server.js or add FFmpeg to PATH.
)
for /f %%P in ('node -e "const c=require('./config.json');process.stdout.write(String(c.port||3001))"') do set "API_PORT=%%P"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null=Invoke-RestMethod 'http://127.0.0.1:%API_PORT%/api/status' -TimeoutSec 2; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting Prince Live API on port %API_PORT%...
  start "Prince Live API" /min cmd /c "cd /d ""%ROOT%"" && node server.js"
  timeout /t 2 /nobreak >nul
) else echo Node API is already responding on port %API_PORT%
if exist "nginx\nginx.exe" (
  "nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf -t
  if errorlevel 1 (
    echo ERROR: Nginx configuration test failed.
    pause
    exit /b 1
  )
  tasklist /FI "IMAGENAME eq nginx.exe" 2>nul | find /I "nginx.exe" >nul
  if errorlevel 1 ("nginx\nginx.exe" -p "%ROOT%nginx/" -c conf/nginx.conf) else echo Nginx is already running.
) else echo WARNING: nginx\nginx.exe not found.
echo.
echo Local UI: http://127.0.0.1:%API_PORT%
echo Nginx UI: http://127.0.0.1/
pause
