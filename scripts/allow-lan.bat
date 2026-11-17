@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem Shortcut: delegates to scripts\firewall.bat, which opens the viewer port and the admin panel automatically.
call "%~dp0firewall.bat" %*
exit /b %errorlevel%
