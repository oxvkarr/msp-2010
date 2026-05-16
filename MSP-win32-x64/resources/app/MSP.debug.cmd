@echo off
setlocal
cd /d "%~dp0"
set "MSP_DEBUG=1"
set "MSP_SKIP_REMOTE_WARMUP=1"
npm run start:debug
