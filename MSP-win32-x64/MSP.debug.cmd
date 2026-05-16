@echo off
setlocal
set "APP_DIR=%~dp0resources\app"
cd /d "%APP_DIR%"
set "MSP_DEBUG=1"
npm run start:debug
