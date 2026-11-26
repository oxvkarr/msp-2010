# Buduje lekka paczke klienta MSP 2010 (Electron + Flash) bez debug exe,
# bez dev node_modules i bez lokalnej bazy msp-db.json.
#
# Uzycie lokalne (korzysta z runtime Electron lezacego w MSP-win32-x64):
#   powershell -ExecutionPolicy Bypass -File tools/build-slim.ps1 -RuntimeDir MSP-win32-x64
#
# W GitHub Actions (pobiera czysty Electron 11.5.0):
#   powershell -ExecutionPolicy Bypass -File tools/build-slim.ps1

[CmdletBinding()]
param(
    [string]$OutputDir = "",
    [string]$ElectronVersion = "11.5.0",
    [string]$RuntimeDir = "",
    [string]$AppDir = "",
    [switch]$IncludeLocalDb,
    [switch]$Developer
)

$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($AppDir)) {
    $AppDir = Join-Path $repoDir "MSP-win32-x64\resources\app"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    if ($Developer) {
        $OutputDir = Join-Path $repoDir "dist\MSP-2010-Dev"
    } else {
        $OutputDir = Join-Path $repoDir "dist\MSP-2010"
    }
}

$appDirPath = [System.IO.Path]::GetFullPath($AppDir)
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)

foreach ($required in @("app.js", "main.js", "pepflashplayer.dll")) {
    if (-not (Test-Path (Join-Path $appDirPath $required))) {
        throw "Brak pliku $required w $appDirPath. Jesli to pepflashplayer.dll, uruchom: git lfs pull"
    }
}

$flashDll = Get-Item -LiteralPath (Join-Path $appDirPath "pepflashplayer.dll")
if ($flashDll.Length -lt 1MB) {
    throw "pepflashplayer.dll ma tylko $($flashDll.Length) bajtow - to pointer Git LFS. Uruchom: git lfs pull"
}

if (Test-Path $outputPath) {
    Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. Runtime Electron
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $cacheDir = Join-Path $repoDir ".cache\electron"
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $zipPath = Join-Path $cacheDir "electron-v$ElectronVersion-win32-x64.zip"
    $runtimePath = Join-Path $cacheDir "electron-v$ElectronVersion-win32-x64"

    if (-not (Test-Path (Join-Path $runtimePath "electron.exe"))) {
        if (-not (Test-Path $zipPath)) {
            $url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
            Write-Host "Pobieranie Electron $ElectronVersion..."
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        }
        if (Test-Path $runtimePath) {
            Remove-Item -LiteralPath $runtimePath -Recurse -Force
        }
        New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
        $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
        if ($tar) {
            & $tar.Source -xf $zipPath -C $runtimePath
            if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie rozpakowac Electron (tar $LASTEXITCODE)" }
        } else {
            Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimePath -Force
        }
        $nested = Get-ChildItem -LiteralPath $runtimePath -Directory |
            Where-Object { (Test-Path (Join-Path $_.FullName "electron.exe")) -or (Test-Path (Join-Path $_.FullName "MSP.exe")) } |
            Select-Object -First 1
        if ($nested) {
            $runtimePath = $nested.FullName
        }
    }
    $RuntimeDir = $runtimePath
}

$runtimePath = [System.IO.Path]::GetFullPath($RuntimeDir)
$runtimeExe = Join-Path $runtimePath "electron.exe"
if (-not (Test-Path $runtimeExe)) {
    $runtimeExe = Join-Path $runtimePath "MSP.exe"
}
if (-not (Test-Path $runtimeExe)) {
    throw "Brak electron.exe (ani MSP.exe) w $runtimePath"
}

$runtimeFiles = @(
    "icudtl.dat",
    "libEGL.dll",
    "libGLESv2.dll",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "snapshot_blob.bin",
    "v8_context_snapshot.bin",
    "ffmpeg.dll",
    "d3dcompiler_47.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
    "vk_swiftshader_icd.json",
    "LICENSES.chromium.html"
)

foreach ($file in $runtimeFiles) {
    $source = Join-Path $runtimePath $file
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $outputPath $file) -Force
    }
}

Copy-Item -LiteralPath $runtimeExe -Destination (Join-Path $outputPath "MSP.exe") -Force

$localesOut = Join-Path $outputPath "locales"
New-Item -ItemType Directory -Path $localesOut -Force | Out-Null
foreach ($locale in @("en-US.pak", "pl.pak")) {
    $source = Join-Path $runtimePath "locales\$locale"
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $localesOut $locale) -Force
    }
}

# ---------------------------------------------------------------------------
# 2. Pliki aplikacji
# ---------------------------------------------------------------------------
$appOut = Join-Path $outputPath "resources\app"
New-Item -ItemType Directory -Path $appOut -Force | Out-Null

foreach ($file in @("app.js", "main.js", "logo.png", "pepflashplayer.dll")) {
    Copy-Item -LiteralPath (Join-Path $appDirPath $file) -Destination (Join-Path $appOut $file) -Force
}
if ($IncludeLocalDb -and (Test-Path (Join-Path $appDirPath "msp-db.json"))) {
    Copy-Item -LiteralPath (Join-Path $appDirPath "msp-db.json") -Destination (Join-Path $appOut "msp-db.json") -Force
}

$debugFlag = if ($Developer) { "1" } else { "0" }
$devModeFlag = if ($Developer) { "1" } else { "0" }
$envContent = @"
# MSP 2010 - konfiguracja klienta (wygenerowane automatycznie)
MSP_DEBUG=$debugFlag
MSP_DEV_MODE=$devModeFlag
MSP_SERVER_ONLY=0
MSP_LOCALE=pl_PL
REMOTE_ASSET_BASE_URL=https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev/2010
REMOTE_ASSET_CACHE=0
REMOTE_GATEWAY_URL=https://msp-2010-api.onrender.com
USE_REMOTE_GATEWAY=1
REMOTE_GATEWAY_TIMEOUT_MS=20000
# Opcjonalnie: MongoDB Atlas (trwały zapis kont/postaci). Zostaw puste = lokalny JSON.
MONGODB_URI=
MONGO_URI=
"@
Set-Content -LiteralPath (Join-Path $appOut ".env") -Value $envContent -Encoding ASCII

# ---------------------------------------------------------------------------
# 3. Tylko produkcyjne zaleznosci
# ---------------------------------------------------------------------------
$clientPackage = [ordered]@{
    name = "msp-local-2010"
    version = "1.0.0"
    private = $true
    main = "main.js"
    dependencies = [ordered]@{
        amfjs = "1.3.1"
        dotenv = "17.4.2"
        express = "4.22.2"
        mongodb = "4.17.2"
    }
}
$clientPackage | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $appOut "package.json") -Encoding UTF8

Push-Location $appOut
try {
    Write-Host "Instalowanie zaleznosci produkcyjnych..."
    & npm.cmd install --omit=dev --omit=optional --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        throw "npm install zakonczyl sie kodem $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$nodeModules = Join-Path $appOut "node_modules"
if (-not (Test-Path (Join-Path $nodeModules "express"))) {
    throw "Brak node_modules/express po instalacji"
}

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $outputPath -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ""
Write-Host "Slim client (Electron) gotowy: $outputPath"
Write-Host "Rozmiar rozpakowany: $sizeMb MB"
Write-Host "Uruchom: $outputPath\MSP.exe"