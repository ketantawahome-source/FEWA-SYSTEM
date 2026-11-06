@echo off
rem Starts the FEWA system at http://localhost:5600/ and opens it in the browser.
rem All data is kept in PostgreSQL (connection details in db-config.json).
rem Keep this window open while using the system; close it to stop the server.
title FEWA System Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed. Download it from https://nodejs.org and run this file again.
    pause
    exit /b 1
)

rem The PostgreSQL driver: installed the first time (needs the internet once)
if not exist "node_modules\pg" (
    echo Installing the PostgreSQL driver...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo The PostgreSQL driver could not be installed. Check the internet connection and try again.
        pause
        exit /b 1
    )
)

rem Started by Windows at sign-in ("FEWA System Server" shortcut in the Startup folder, with "startup"):
rem the browser is not opened then
if /i not "%~1"=="startup" start "" "http://localhost:5600/"

rem Settings > System Update stops the server with code 3 after downloading new code: it is started again here
:run
node server.mjs 5600
if errorlevel 3 if not errorlevel 4 (
    echo.
    echo System update installed - starting the FEWA system again...
    echo.
    goto run
)
pause
