@echo off
rem --- ASCII only: cmd parses .bat with the OEM codepage. ---
rem 默认只删程序，保留配置与记忆；要连配置一起删，运行：
rem   node installer\uninstall.mjs --from-state --purge
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode

:run
echo.
echo   This removes the installed program (app\runtime\cache).
echo   Your settings in data\ and your memory in %%USERPROFILE%%\.dsh\surfcore are kept.
echo.
pause
"%NODE%" installer\uninstall.mjs --from-state
echo.
pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Download: https://nodejs.org/
echo.
pause
exit /b 1
