@echo off
setlocal EnableExtensions
rem Unified device report for Windows: lists the DirectShow video/audio devices
rem through the same capture layer the server uses (lib/capture/dshow.js), then
rem prints each video device's supported modes and the recommended settings.
rem UTF-8 code page so localized (Arabic) device names display correctly.
chcp 65001 >nul
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

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH.
  pause
  exit /b 1
)
if not exist "config.json" (
  echo ERROR: config.json not found.
  pause
  exit /b 1
)

node scripts\devices.js %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo A non-zero FFmpeg exit code during device listing can be normal.
pause
exit /b %RC%
