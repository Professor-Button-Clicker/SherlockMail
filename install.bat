@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo    SherlockMail - Forensic Email Collection Tool
echo    Automated Setup Script
echo ============================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js is NOT installed.
    echo     Node.js is required to run SherlockMail.
    echo.

    :: Try winget first
    where winget >nul 2>nul
    if !errorlevel! equ 0 (
        echo [*] Installing Node.js via winget...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if !errorlevel! neq 0 (
            echo [!] Automatic install failed.
            echo     Please install Node.js manually from https://nodejs.org/
            echo     Then re-run this script.
            pause
            exit /b 1
        )
        echo [+] Node.js installed. You may need to restart this terminal.
        echo     Close this window, open a new terminal, and re-run install.bat
        pause
        exit /b 0
    ) else (
        echo [!] winget not available for automatic install.
        echo     Please install Node.js manually:
        echo     https://nodejs.org/
        echo     Then re-run this script.
        pause
        exit /b 1
    )
) else (
    for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
    echo [+] Node.js found: !NODE_VER!
)

:: Check for npm
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] npm not found. It should come with Node.js.
    echo     Please reinstall Node.js from https://nodejs.org/
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
    echo [+] npm found: !NPM_VER!
)

echo.
echo [*] Installing dependencies (this includes Electron)...
echo     This may take a few minutes on first install.
echo.

call npm install
if %errorlevel% neq 0 (
    echo.
    echo [!] npm install failed. Check the errors above.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo    Setup Complete!
echo ============================================================
echo.
echo    To launch SherlockMail, run:
echo        npm start
echo.
echo    Or double-click "start.bat" in this folder.
echo.
echo ============================================================
pause
