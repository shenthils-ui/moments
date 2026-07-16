@echo off
setlocal enabledelayedexpansion
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
    echo  Installing dependencies. This happens on first run and after updates,
    echo  and can take a few minutes...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  npm install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
    set NEED_BUILD=1
)

rem --- Decide whether to (re)build ------------------------------------------
rem Rebuild when the built app is missing, or when the code has changed since
rem the last build. We track the built commit so "git pull" then start.bat
rem always runs the latest version instead of a stale dist\.
set NEED_BUILD=%NEED_BUILD%
if not exist dist\server\index.js set NEED_BUILD=1

set CURRENT_COMMIT=
for /f "delims=" %%c in ('git rev-parse HEAD 2^>nul') do set CURRENT_COMMIT=%%c
set BUILT_COMMIT=
if exist dist\.built-commit set /p BUILT_COMMIT=<dist\.built-commit

if defined CURRENT_COMMIT (
    if not "%CURRENT_COMMIT%"=="%BUILT_COMMIT%" set NEED_BUILD=1
) else (
    rem No git available (e.g. ZIP download): rebuild every launch to be safe.
    set NEED_BUILD=1
)

if defined NEED_BUILD (
    echo  Building the latest version...
    echo.
    call npm run build
    if errorlevel 1 (
        echo.
        echo  Build failed. Please report the error above.
        pause
        exit /b 1
    )
    if defined CURRENT_COMMIT >dist\.built-commit echo %CURRENT_COMMIT%
) else (
    echo  Already up to date - starting the existing build.
)

echo.
echo  Starting Moments...
echo  Your photos live in: %cd%\data\photos ^(unless PHOTOS_ROOT is set^)
echo.

start "" http://localhost:3000
node dist\server\index.js
pause
