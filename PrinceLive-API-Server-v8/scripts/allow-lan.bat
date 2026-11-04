@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem اختصار متوافق: يفوّض العمل إلى scripts\firewall.bat الذي يفتح منفذ المشاهدة ولوحة الإدارة تلقائياً.
call "%~dp0firewall.bat" %*
exit /b %errorlevel%
