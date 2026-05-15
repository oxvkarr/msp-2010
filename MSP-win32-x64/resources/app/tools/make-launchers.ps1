$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot
$distDir = Resolve-Path (Join-Path $appDir "..\..")
$electronDistDir = Join-Path $appDir "node_modules\electron\dist"
$playerExe = Join-Path $distDir "MSP.exe"
$debugExe = Join-Path $distDir "MSP-Debug.exe"
$backendVbs = Join-Path $distDir "MSP-Backend.vbs"
$backendStopCmd = Join-Path $distDir "MSP-Backend-Stop.cmd"
$runtimeFiles = @(
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "d3dcompiler_47.dll",
    "ffmpeg.dll",
    "icudtl.dat",
    "libEGL.dll",
    "libGLESv2.dll",
    "LICENSES.chromium.html",
    "resources.pak",
    "snapshot_blob.bin",
    "v8_context_snapshot.bin",
    "version",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll"
)

if (!(Test-Path $electronDistDir)) {
    throw "Missing Electron runtime folder: $electronDistDir"
}

if (!(Test-Path $playerExe)) {
    Copy-Item -LiteralPath (Join-Path $electronDistDir "electron.exe") -Destination $playerExe -Force
}

foreach ($fileName in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $electronDistDir $fileName) -Destination (Join-Path $distDir $fileName) -Force
}

foreach ($dirName in @("locales", "swiftshader")) {
    Copy-Item -LiteralPath (Join-Path $electronDistDir $dirName) -Destination (Join-Path $distDir $dirName) -Recurse -Force
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
