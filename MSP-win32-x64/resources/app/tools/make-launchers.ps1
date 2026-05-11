$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot
$distDir = Resolve-Path (Join-Path $appDir "..\..")
$playerExe = Join-Path $distDir "MSP.exe"
$debugExe = Join-Path $distDir "MSP-Debug.exe"
$backendVbs = Join-Path $distDir "MSP-Backend.vbs"
$backendStopCmd = Join-Path $distDir "MSP-Backend-Stop.cmd"

if (!(Test-Path $playerExe)) {
    throw "Missing player launcher: $playerExe"
}

Copy-Item -LiteralPath $playerExe -Destination $debugExe -Force

$vbsContent = @'
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = baseDir & "\resources\app"
command = "cmd /c cd /d """ & appDir & """ && set MSP_SERVER_ONLY=1 && npm run start-server"
shell.Run command, 0, False
'@

$stopContent = @'
@echo off
setlocal
set PIDFILE=%~dp0resources\app\msp-server.pid
if not exist "%PIDFILE%" (
  echo Brak pliku PID. Serwer nie jest uruchomiony albo zostal zamkniety.
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
'@

Set-Content -LiteralPath $backendVbs -Value $vbsContent -Encoding ASCII
Set-Content -LiteralPath $backendStopCmd -Value $stopContent -Encoding ASCII

Write-Host "Created player launcher: $playerExe"
Write-Host "Created debug launcher:  $debugExe"
Write-Host "Created backend start:   $backendVbs"
Write-Host "Created backend stop:    $backendStopCmd"
