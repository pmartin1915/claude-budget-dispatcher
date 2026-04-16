@echo off
:: Budget Dispatcher Dashboard launcher -- pin the shortcut to your taskbar.
:: Starts the dashboard if not running, then opens Chrome.

:: Check if dashboard is already listening on 7380
powershell -NoProfile -Command "try{[void][System.Net.Sockets.TcpClient]::new('127.0.0.1',7380);exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
    start "" chrome http://localhost:7380
    exit /b 0
)

:: Not running -- start it in the background (minimized, no browser)
cd /d "%~dp0.."
start "BudgetDispatcher" /min cmd /c "node scripts\dashboard.mjs --no-open"

:: Give it a moment to bind the port, then open Chrome
ping -n 4 127.0.0.1 >nul 2>&1
start "" chrome http://localhost:7380
