@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem  PrinceLive - automatic Windows Firewall setup (Windows 10/11)
rem  Reads both ports from data.json (config.json as fallback) and opens them:
rem    - viewer port  (Nginx, HTTP/HLS)
rem    - admin/API port (Node.js)
rem
rem    firewall.bat          - Allow on private and domain networks (default)
rem    firewall.bat public   - Allow on every network, including public
rem    firewall.bat remove   - Remove every PrinceLive firewall rule
rem    firewall.bat quiet    - Unattended run (no pause at the end), used by start.bat
rem  Options can be combined, in any order: firewall.bat public quiet
rem
rem  Exit codes: 0 = rules applied or removed; any other code = failure (the exit code
rem  of the elevated copy is returned to the caller).
rem ============================================================
set "ROOT=%~dp0"
if exist "%ROOT%..\server.js" for %%I in ("%ROOT%..") do set "ROOT=%%~fI\"
cd /d "%ROOT%"

rem ---- Arguments: quiet / public / remove, in any order ----
set "QUIET="
set "ALLOW_PUBLIC="
set "ACTION=add"
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="quiet" (
  set "QUIET=1"
  shift
  goto :parse_args
)
if /i "%~1"=="public" (
  set "ALLOW_PUBLIC=1"
  shift
  goto :parse_args
)
if /i "%~1"=="remove" (
  set "ACTION=remove"
  shift
  goto :parse_args
)
echo ERROR: unknown argument "%~1".
echo Usage: firewall.bat [quiet] [public] [remove]
pause
exit /b 1
:args_done

rem ---- Elevation: run this same file as administrator and wait for it ----
net session >nul 2>&1
if not errorlevel 1 goto :elevated
echo Requesting administrator rights to set up the firewall...
set "PRINCELIVE_BAT=%~f0"
set "PRINCELIVE_DIR=%~dp0"
set "PRINCELIVE_ARGS=%*"
rem The path and the arguments travel through environment variables, so a project
rem path with spaces, commas or an apostrophe (C:\Users\O'Brien\My Folder) cannot
rem break the PowerShell command. -Wait plus $p.ExitCode forwards the real result
rem of the elevated copy instead of reporting success before anything happened.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $a=$env:PRINCELIVE_ARGS; if ([string]::IsNullOrWhiteSpace($a)) { $p=Start-Process -FilePath $env:PRINCELIVE_BAT -WorkingDirectory $env:PRINCELIVE_DIR -Verb RunAs -Wait -PassThru } else { $p=Start-Process -FilePath $env:PRINCELIVE_BAT -WorkingDirectory $env:PRINCELIVE_DIR -ArgumentList $a -Verb RunAs -Wait -PassThru }; exit $p.ExitCode"
set "ELEV_RC=!errorlevel!"
if "!ELEV_RC!"=="0" exit /b 0
echo ERROR: the administrator copy did not finish the firewall setup [exit code !ELEV_RC!].
echo        If the UAC prompt was cancelled, right-click firewall.bat and choose "Run as administrator".
if not defined QUIET pause
exit /b !ELEV_RC!
:elevated

rem ---- Removing rules does not need the ports, so it also works without Node.js ----
if /i "!ACTION!"=="remove" goto :remove_rules

call :read_ports
if errorlevel 1 exit /b 1

set "RULE_HTTP=PrinceLive HTTP !NGINX_PORT!"
set "RULE_API=PrinceLive API !NODE_PORT!"
set "FAILED="

rem ---- Delete every PrinceLive rule first, including rules of ports no longer used ----
call :purge_rules
if errorlevel 1 (
  echo WARNING: not every old PrinceLive rule could be removed.
  set "FAILED=1"
)

set "PROFILES=private,domain"
if defined ALLOW_PUBLIC set "PROFILES=any"

echo Viewer port (HTTP/HLS): !NGINX_PORT!
echo Admin panel/API port: !NODE_PORT!
echo Rule profiles: !PROFILES!

call :add_rule "!RULE_HTTP!" !NGINX_PORT! "PrinceLive viewer (HTTP/HLS)"
if errorlevel 1 set "FAILED=1"
if /i "!NODE_PORT!"=="!NGINX_PORT!" (
  echo NOTE: the admin panel uses the same port as the viewer, so one rule covers both.
) else (
  call :add_rule "!RULE_API!" !NODE_PORT! "PrinceLive admin panel and API"
  if errorlevel 1 set "FAILED=1"
)

call :verify_rule "!RULE_HTTP!"
if errorlevel 1 set "FAILED=1"
if /i not "!NODE_PORT!"=="!NGINX_PORT!" (
  call :verify_rule "!RULE_API!"
  if errorlevel 1 set "FAILED=1"
)

echo.
if defined FAILED (
  echo ERROR: the PrinceLive firewall rules are incomplete [viewer !NGINX_PORT!, API !NODE_PORT!].
  echo        Run firewall.bat as administrator and read the messages above.
  if not defined QUIET pause
  exit /b 1
)
echo Firewall rules added successfully (profiles: !PROFILES!).
echo Viewing links from other devices on the network:
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%I"
  set "IP=!IP: =!"
  echo    http://!IP!:!NGINX_PORT!/          viewer
  echo    http://!IP!:!NODE_PORT!/admin     admin panel
)
echo.
set "PUBLICNET="
for /f "delims=" %%C in ('powershell -NoProfile -Command "Get-NetConnectionProfile ^| Select-Object -ExpandProperty NetworkCategory"') do if /i "%%C"=="Public" set "PUBLICNET=1"
if defined PUBLICNET if not defined ALLOW_PUBLIC echo WARNING: one of your networks is set to Public, so its devices cannot connect. Run firewall.bat public to allow it.
echo To remove the rules: firewall.bat remove
if not defined QUIET pause
exit /b 0

:remove_rules
set "FAILED="
call :purge_rules
if errorlevel 1 set "FAILED=1"

:removed
if defined FAILED (
  echo ERROR: some PrinceLive firewall rules are still present.
  if not defined QUIET pause
  exit /b 1
)
echo PrinceLive firewall rules removed.
if not defined QUIET pause
exit /b 0

rem ---- Reads the viewer port and the admin/API port from the settings ----
:read_ports
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH, so the ports cannot be read.
  if not defined QUIET pause
  exit /b 1
)
set "PORTS="
for /f "delims=" %%P in ('node scripts\ports.js 2^>nul') do set "PORTS=%%P"
if not defined PORTS (
  echo ERROR: could not read the ports from data.json / config.json [scripts\ports.js].
  if not defined QUIET pause
  exit /b 1
)
set "NGINX_PORT="
set "NODE_PORT="
for /f "tokens=1,2" %%A in ("!PORTS!") do (
  set "NGINX_PORT=%%A"
  set "NODE_PORT=%%B"
)
if not defined NODE_PORT set "NODE_PORT=!NGINX_PORT!"
if not defined NGINX_PORT (
  echo ERROR: the settings did not provide a viewer port [scripts\ports.js].
  if not defined QUIET pause
  exit /b 1
)
exit /b 0

rem ---- Removes every PrinceLive rule, whatever port it was created for ----
:purge_rules
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-NetFirewallRule -DisplayName 'PrinceLive*' -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction Stop } catch { exit 1 }"
if not errorlevel 1 exit /b 0
rem Fallback for a system without the NetSecurity module: delete the rule names
rem this project uses. Rules created for a port that is no longer configured can
rem only be found by name here, so the PowerShell path above is the reliable one.
netsh advfirewall firewall delete rule name="PrinceLive HTTP !NGINX_PORT!" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive API !NODE_PORT!" >nul 2>&1
netsh advfirewall firewall delete rule name="PrinceLive HTTP LAN Port !NGINX_PORT!" >nul 2>&1
netsh advfirewall firewall show rule name="PrinceLive HTTP !NGINX_PORT!" >nul 2>&1
if not errorlevel 1 exit /b 1
netsh advfirewall firewall show rule name="PrinceLive API !NODE_PORT!" >nul 2>&1
if not errorlevel 1 exit /b 1
exit /b 0

rem ---- Adds one inbound TCP rule; returns 1 when the port could not be opened ----
rem Delayed expansion is used for every value inside a parenthesised block: a
rem description such as "PrinceLive viewer (HTTP/HLS)" contains a closing
rem parenthesis that percent-expansion would let terminate the block early.
:add_rule
set "ADD_NAME=%~1"
set "ADD_PORT=%~2"
set "ADD_DESC=%~3"
netsh advfirewall firewall add rule name="%ADD_NAME%" dir=in action=allow protocol=TCP localport=%ADD_PORT% profile=%PROFILES% enable=yes description="%ADD_DESC%" >nul
if errorlevel 1 (
  echo ERROR: could not open port !ADD_PORT! [!ADD_DESC!].
  exit /b 1
)
exit /b 0

rem ---- Confirms the rule really exists (netsh returns 1 when nothing matches) ----
:verify_rule
set "VERIFY_NAME=%~1"
netsh advfirewall firewall show rule name="%VERIFY_NAME%" >nul 2>&1
if errorlevel 1 (
  echo ERROR: the rule "!VERIFY_NAME!" is missing, so that port stays blocked.
  exit /b 1
)
exit /b 0
