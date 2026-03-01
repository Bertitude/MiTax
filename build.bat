@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  LunchMoney Importer — Windows build script
REM  Run this to produce a Windows installer in the dist/ folder.
REM ─────────────────────────────────────────────────────────────────────────

echo.
echo  LunchMoney Importer — Build
echo  ================================
echo.

REM Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed.
    echo  Download it from: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  Node.js: %NODE_VER%

REM Install / update dependencies
echo.
echo  Installing dependencies...
call npm install
if errorlevel 1 (
    echo  [ERROR] npm install failed.
    pause
    exit /b 1
)

REM Build Windows installer
echo.
echo  Building Windows installer...
call npm run build:win
if errorlevel 1 (
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo  ================================================================
echo   Build complete!  Installer is in the dist\ folder.
echo  ================================================================
echo.
explorer dist
pause
