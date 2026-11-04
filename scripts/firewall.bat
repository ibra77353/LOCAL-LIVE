@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem ============================================================
rem  PrinceLive - إعداد جدار الحماية تلقائياً (Windows 10/11)
rem  يقرأ منافذ البث والمشاهدة من data.json (ومن config.json كاحتياط) ثم يفتحها.
rem    firewall.bat          - السماح على الشبكات الخاصة والمكتبية (الافتراضي)
rem    firewall.bat public   - السماح على كل الشبكات بما فيها العامة
rem    firewall.bat remove   - حذف قواعد PrinceLive من جدار الحماية
rem    firewall.bat quiet    - تشغيل تلقائي (بلا توقف في النهاية) يستخدمه start.bat
rem ============================================================
set "ROOT=%~dp0"
if exist "%ROOT%..\server.js" for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
cd /d "%ROOT%"

rem ---- طلب صلاحيات المسؤول تلقائياً ----
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo يتم طلب صلاحيات المسؤول لإعداد جدار الحماية...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

rem ---- قراءة المنافذ الفعلية من الإعدادات ----
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js') do set "PORTS=%%P"
if not defined PORTS (
  echo تعذر قراءة المنافذ من الإعدادات. تأكد من تثبيت Node.js وإضافته إلى PATH.
  pause
  exit /b 1
)
for /f "tokens=1,2" %%A in ("%PORTS%") do (
  set "NGINX_PORT=%%A"
  set "NODE_PORT=%%B"
)
set "RULE_HTTP=PrinceLive HTTP %NGINX_PORT%"
set "RULE_NODE=PrinceLive API %NODE_PORT%"

set "QUIET="
if /i "%~1"=="quiet" set "QUIET=1"
if /i "%~1"=="remove" goto REMOVE

set "PROFILES=private,domain"
if /i "%~1"=="public" set "PROFILES=any"

echo منفذ المشاهدة (HTTP/HLS): %NGINX_PORT%
echo منفذ لوحة الإدارة/API: %NODE_PORT%

rem حذف القواعد القديمة أولاً ليكون التشغيل قابلاً للتكرار دون تكرار القواعد
netsh advfirewall firewall delete rule name="%RULE_HTTP%" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE_NODE%" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive HTTP LAN Port %NGINX_PORT%" >nul 2>&1

netsh advfirewall firewall add rule name="%RULE_HTTP%" dir=in action=allow protocol=TCP localport=%NGINX_PORT% profile=%PROFILES% enable=yes >nul
if errorlevel 1 (
  echo تعذر فتح منفذ المشاهدة %NGINX_PORT%.
  pause
  exit /b 1
)
netsh advfirewall firewall add rule name="%RULE_NODE%" dir=in action=allow protocol=TCP localport=%NODE_PORT% profile=%PROFILES% enable=yes >nul
if errorlevel 1 (
  echo تعذر فتح منفذ لوحة الإدارة %NODE_PORT%.
  pause
  exit /b 1
)

echo.
echo تم إعداد جدار الحماية بنجاح (الملفات: %PROFILES%).
echo روابط المشاهدة من أجهزة الشبكة:
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4"') do (
  setlocal EnableDelayedExpansion
  set "IP=%%I"
  set "IP=!IP: =!"
  echo    http://!IP!:%NGINX_PORT%/          واجهة المشاهدة
  echo    http://!IP!:%NODE_PORT%/admin     لوحة الإدارة
  endlocal
)
echo.
set "PUBLICNET="
for /f "delims=" %%C in ('powershell -NoProfile -Command "Get-NetConnectionProfile ^| Select-Object -ExpandProperty NetworkCategory"') do if /i "%%C"=="Public" set "PUBLICNET=1"
if defined PUBLICNET echo تنبيه: إحدى شبكاتك مصنّفة عامة ولن تتصل أجهزتها. شغّل firewall.bat public للسماح عليها.
echo لإلغاء السماح: firewall.bat remove
if not defined QUIET pause
exit /b 0

:REMOVE
netsh advfirewall firewall delete rule name="%RULE_HTTP%" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE_NODE%" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive HTTP LAN Port %NGINX_PORT%" >nul 2>&1
echo تم حذف قواعد PrinceLive من جدار الحماية.
if not defined QUIET pause
exit /b 0
