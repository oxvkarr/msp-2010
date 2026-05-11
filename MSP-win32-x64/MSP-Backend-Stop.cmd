@echo off
setlocal
set PIDFILE=%~dp0resources\app\msp-server.pid
if not exist "%PIDFILE%" (
  echo Brak pliku PID. Serwer nie jest uruchomiony albo zostal juz zamkniety.
  pause
  exit /b 1
)
set /p MSP_PID=<"%PIDFILE%"
taskkill /PID %MSP_PID% /F
if errorlevel 1 (
  echo Nie udalo sie zamknac procesu %MSP_PID%.
  pause
  exit /b 1
)
del "%PIDFILE%" >nul 2>nul
echo Serwer MSP zostal zatrzymany.
pause
