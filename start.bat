@echo off
setlocal
title LANShare
cd /d "%~dp0"

rem UTF-8 code page, otherwise the QR code prints as garbage characters.
chcp 65001 >nul

echo.
echo   Starting LANShare...
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   Node.js is not installed.
    echo.
    echo   Install it from https://nodejs.org  ^(pick the LTS version^),
    echo   then run this file again.
    echo.
    pause
    exit /b 1
)

rem Install dependencies on first run, or after package.json changes.
if not exist "node_modules\express\package.json" (
    echo   First run - installing dependencies. This takes a minute.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   Dependency install failed. Check your internet connection
        echo   and run this file again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

node server.js
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
    echo.
    echo   LANShare stopped with an error ^(code %EXITCODE%^).
    echo.
    pause
)

endlocal
