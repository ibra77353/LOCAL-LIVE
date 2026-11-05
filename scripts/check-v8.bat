@echo off
setlocal
cd /d "%~dp0.."
echo [1/4] Checking Node.js server syntax...
node --check server.js || goto :fail
echo [2/4] Checking admin, viewer, and helper scripts...
node --check web\admin.js || goto :fail
node --check web\viewer.js || goto :fail
node --check scripts\ports.js || goto :fail
node --check scripts\procs.js || goto :fail
node --check scripts\test-stop.js || goto :fail
node --check scripts\verify-v8.js || goto :fail
echo [3/4] Checking JSON files...
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8').replace(/^\\uFEFF/,'')); JSON.parse(require('fs').readFileSync('data.json','utf8').replace(/^\\uFEFF/,'')); console.log('JSON OK')" || goto :fail
echo [4/4] Checking Windows scripts consistency...
node scripts\verify-v8.js || goto :fail
echo.
echo All static checks passed. This does not test physical capture devices or live FFmpeg output.
pause
exit /b 0
:fail
echo.
echo A check failed. Read the error above.
pause
exit /b 1
