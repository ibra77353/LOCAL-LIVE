@echo off
rem Creates the Nginx runtime temp directories before any "nginx -t" or start.
rem nginx on Windows fails with CreateDirectory() "...\nginx/temp/client_body_temp"
rem when the temp folder is missing (the ZIP ships nginx/temp/.gitkeep, this is a guard).
rem CRLF line endings + a single-line loop: cmd.exe mis-parses a multi-line for-block
rem inside an LF-only .bat file, so the folders could silently stay missing.
if not exist "nginx\temp" mkdir "nginx\temp" >nul 2>&1
for %%D in (client_body_temp proxy_temp fastcgi_temp uwsgi_temp scgi_temp) do if not exist "nginx\temp\%%D" mkdir "nginx\temp\%%D" >nul 2>&1
exit /b 0
