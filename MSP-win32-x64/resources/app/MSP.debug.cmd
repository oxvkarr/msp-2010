@echo off
setlocal
cd /d "%~dp0"
set "MSP_DEBUG=1"
npm run start:debug
