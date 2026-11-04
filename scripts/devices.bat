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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=Get-Content -Raw -Encoding UTF8 'data.json' | ConvertFrom-Json; $ff=$d.settings.ffmpegPath; if (-not $ff) {$ff='ffmpeg'}; if (-not [IO.Path]::IsPathRooted($ff)) {$ff=Join-Path (Get-Location) $ff}; if (-not (Test-Path $ff)) {Write-Host ('ERROR: FFmpeg not found: '+$ff); exit 2}; & $ff -hide_banner -list_devices true -f dshow -i dummy 2>&1; Write-Host 'A non-zero FFmpeg exit code during device listing can be normal.'"
pause
