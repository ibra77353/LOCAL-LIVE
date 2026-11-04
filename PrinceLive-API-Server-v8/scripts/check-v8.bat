@echo off
setlocal
cd /d "%~dp0.."
echo [1/3] Checking Node.js server syntax...
node --check server.js || goto :fail
echo [2/3] Checking admin and viewer scripts...
node --check web\admin.js || goto :fail
node --check web\app.js || goto :fail
echo [3/3] Checking JSON files...
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8').replace(/^\\uFEFF/,'')); JSON.parse(require('fs').readFileSync('data.json','utf8').replace(/^\\uFEFF/,'')); console.log('JSON OK')" || goto :fail
echo.
echo All static checks passed. This does not test physical capture devices or live FFmpeg output.
pause
exit /b 0
:fail
echo.
echo A check failed. Read the error above.
pause
exit /b 1
