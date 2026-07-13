@echo off
setlocal
title Moments
cd /d "%~dp0"

echo.
echo  Moments - your family photo library
echo  ------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js is not installed on this PC.
    echo.
    echo  Please install the LTS version from https://nodejs.org
    echo  ^(click the big green button, then Next-Next-Finish^),
    echo  then double-click start.bat again.
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo  First run: installing dependencies. This happens only once
    echo  and can take a few minutes...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  npm install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

if not exist dist\server\index.js (
    echo  First run: building the app...
    echo.
    call npm run build
    if errorlevel 1 (
        echo.
        echo  Build failed. Please report the error above.
        pause
        exit /b 1
    )
)

echo  Starting Moments...
echo  Your photos live in: %cd%\data\photos ^(unless PHOTOS_ROOT is set^)
echo.

start "" http://localhost:3000
node dist\server\index.js
pause
