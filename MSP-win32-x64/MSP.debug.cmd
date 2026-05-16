@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 80,1600 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>nul
taskkill /F /T /IM MSP-Debug.exe >nul 2>nul
taskkill /F /T /IM MSP.exe >nul 2>nul
set "APP_DIR=%~dp0resources\app"
cd /d "%APP_DIR%"
set "MSP_DEBUG=1"
set "MSP_SKIP_REMOTE_WARMUP=1"
set "MSP_ACCEPT_TERMS=1"
npm run start:debug
