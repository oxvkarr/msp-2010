@echo off
setlocal
taskkill /F /T /IM MSP-Debug.exe >nul 2>nul
taskkill /F /T /IM MSP.exe >nul 2>nul
cd /d "%~dp0"
set "MSP_DEBUG=1"
set "MSP_SKIP_REMOTE_WARMUP=1"
npm run start:debug
