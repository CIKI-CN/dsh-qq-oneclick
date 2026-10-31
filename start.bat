@echo off
rem --- Keep this file ASCII-only. cmd parses .bat with the OEM codepage,
rem --- so Chinese text in a UTF-8 .bat breaks the parser. User-facing
rem --- Chinese lives in the web wizard, not here.
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
"%NODE%" installer\server.mjs --open
if errorlevel 1 pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo.
echo   This wizard needs Node.js 22.13 or newer.
echo   Download: https://nodejs.org/
echo.
echo   Or unzip a portable Node into: runtime\node\
echo   then run this file again.
echo.
start "" "https://nodejs.org/"
pause
exit /b 1
