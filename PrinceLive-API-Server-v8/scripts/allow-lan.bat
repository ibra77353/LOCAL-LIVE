@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem فتح منفذ Nginx الفعلي من config.json بدل تثبيت المنفذ 80.
set "ROOT=%~dp0"
if exist "%ROOT%..\server.js" for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
cd /d "%ROOT%"
set "NGINX_PORT="
for /f "delims=" %%P in ('node -e "const c=require('./config.json');process.stdout.write(String(Number(c.nginxPort)||80))"') do set "NGINX_PORT=%%P"
if not defined NGINX_PORT set "NGINX_PORT=80"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo يجب تشغيل هذا الملف كمسؤول.
  pause
  exit /b 1
)
netsh advfirewall firewall add rule name="PrinceLive HTTP LAN Port %NGINX_PORT%" dir=in action=allow protocol=TCP localport=%NGINX_PORT% profile=private
if errorlevel 1 (
  echo تعذر إضافة قاعدة جدار الحماية.
) else (
  echo تم السماح باتصالات الشبكة الخاصة إلى Prince Live على المنفذ %NGINX_PORT%.
)
pause
