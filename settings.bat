@echo off
rem --- ASCII only: cmd parses .bat with the OEM codepage. ---
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
"%NODE%" installer\server.mjs --settings
if errorlevel 1 pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Download: https://nodejs.org/
echo.
pause
exit /b 1
