@echo off
title Aperture
cd /d "%~dp0"
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Start Docker Desktop, wait until it says running, then open this file again.
  pause
  exit /b 1
)
call npm run setup
if errorlevel 1 (
  echo Setup failed. Copy the messages above and send them to Claude.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 25 >nul & start http://localhost:3100"
call npm run dev
pause
