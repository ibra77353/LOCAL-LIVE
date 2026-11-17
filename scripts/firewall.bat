@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem ============================================================
rem  PrinceLive - automatic Windows Firewall setup (Windows 10/11)
rem  Reads the viewer/streaming ports from data.json (config.json as fallback) and opens them.
rem    firewall.bat          - Allow on private and domain networks (default)
rem    firewall.bat public   - Allow on every network, including public
rem    firewall.bat remove   - Remove the PrinceLive firewall rules
rem    firewall.bat quiet    - Unattended run (no pause at the end), used by start.bat
rem ============================================================
set "ROOT=%~dp0"
if exist "%ROOT%..\server.js" for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
cd /d "%ROOT%"

rem ---- Request administrator rights automatically ----
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator rights to set up the firewall...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

rem ---- Read the actual ports from the settings ----
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js') do set "PORTS=%%P"
if not defined PORTS (
  echo Could not read the ports from the settings. Make sure Node.js is installed and in PATH.
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

echo Viewer port (HTTP/HLS): %NGINX_PORT%
echo Admin panel/API port: %NODE_PORT%

rem Delete the old rules first so the script can run again without duplicating rules
netsh advfirewall firewall delete rule name="%RULE_HTTP%" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE_NODE%" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive HTTP LAN Port %NGINX_PORT%" >nul 2>&1

netsh advfirewall firewall add rule name="%RULE_HTTP%" dir=in action=allow protocol=TCP localport=%NGINX_PORT% profile=%PROFILES% enable=yes >nul
if errorlevel 1 (
  echo Could not open the viewer port %NGINX_PORT%.
  pause
  exit /b 1
)
netsh advfirewall firewall add rule name="%RULE_NODE%" dir=in action=allow protocol=TCP localport=%NODE_PORT% profile=%PROFILES% enable=yes >nul
if errorlevel 1 (
  echo Could not open the admin panel port %NODE_PORT%.
  pause
  exit /b 1
)

echo.
echo Firewall rules added successfully (profiles: %PROFILES%).
echo Viewing links from other devices on the network:
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4"') do (
  setlocal EnableDelayedExpansion
  set "IP=%%I"
  set "IP=!IP: =!"
  echo    http://!IP!:%NGINX_PORT%/          viewer
  echo    http://!IP!:%NODE_PORT%/admin     admin panel
  endlocal
)
echo.
set "PUBLICNET="
for /f "delims=" %%C in ('powershell -NoProfile -Command "Get-NetConnectionProfile ^| Select-Object -ExpandProperty NetworkCategory"') do if /i "%%C"=="Public" set "PUBLICNET=1"
if defined PUBLICNET echo WARNING: one of your networks is set to Public, so its devices cannot connect. Run firewall.bat public to allow it.
echo To remove the rules: firewall.bat remove
if not defined QUIET pause
exit /b 0

:REMOVE
netsh advfirewall firewall delete rule name="%RULE_HTTP%" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE_NODE%" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive HTTP LAN Port %NGINX_PORT%" >nul 2>&1
echo PrinceLive firewall rules removed.
if not defined QUIET pause
exit /b 0
