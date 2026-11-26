# Buduje lekka paczke klienta MSP 2010 (Ruffle + Flash emulator) bez Electrona,
# bez Flash Playera, bez debug exe i bez dev node_modules.
#
# Uzycie lokalne:
#   powershell -ExecutionPolicy Bypass -File tools/build-slim.ps1
#
# W GitHub Actions (pobiera Ruffle i uzywa Node z runnera):
#   powershell -ExecutionPolicy Bypass -File tools/build-slim.ps1

[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoDir "dist\MSP-2010"
}

$appDirPath = [System.IO.Path]::GetFullPath((Join-Path $repoDir "MSP-win32-x64\resources\app"))
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)

foreach ($required in @("app.js", "logo.png")) {
    if (-not (Test-Path (Join-Path $appDirPath $required))) {
        throw "Brak pliku $required w $appDirPath"
    }
}

# Zabezpieczenie: jesli app.js wymaga flasha - to nie ten build.
$flashDll = Join-Path $appDirPath "pepflashplayer.dll"
if (Test-Path $flashDll) {
    Write-Host "Uwaga: pepflashplayer.dll istnieje, ale ten build uzywa Ruffle - Flash nie jest kopiowany."
}

if (Test-Path $outputPath) {
    Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. Ruffle (player) + Node.js (runtime serwera) + MSP.exe (launcher)
# ---------------------------------------------------------------------------
$cacheDir = Join-Path $repoDir ".cache\ruffle"
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null

# --- Ruffle ---
$ruffleZip = Join-Path $cacheDir "ruffle-windows-x86_64.zip"
$ruffleExe = Join-Path $cacheDir "ruffle.exe"
if (-not (Test-Path $ruffleExe)) {
    if (-not (Test-Path $ruffleZip)) {
        $ruffleUrl = "https://github.com/ruffle-rs/ruffle/releases/download/v0.8.0/ruffle-0.8.0-windows-x86_64.zip"
        Write-Host "Pobieranie Ruffle 0.8.0..."
        Invoke-WebRequest -Uri $ruffleUrl -OutFile $ruffleZip -UseBasicParsing
    }
    $ruffleExtract = Join-Path $cacheDir "ruffle-extract"
    if (Test-Path $ruffleExtract) { Remove-Item -LiteralPath $ruffleExtract -Recurse -Force }
    New-Item -ItemType Directory -Path $ruffleExtract -Force | Out-Null
    Expand-Archive -LiteralPath $ruffleZip -DestinationPath $ruffleExtract -Force
    $found = Get-ChildItem -LiteralPath $ruffleExtract -Recurse -Filter "ruffle.exe" | Select-Object -First 1
    if (-not $found) { throw "Nie znaleziono ruffle.exe w archiwum Ruffle" }
    Copy-Item -LiteralPath $found.FullName -Destination $ruffleExe -Force
}
Copy-Item -LiteralPath $ruffleExe -Destination (Join-Path $outputPath "ruffle.exe") -Force

# --- Node.js (ten sam, ktory uruchamia build - gwarancja zgodnosci wersji) ---
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "Brak node.exe w PATH - wymagany do buildu i do klienta" }
Copy-Item -LiteralPath $nodeCmd.Source -Destination (Join-Path $outputPath "node.exe") -Force

# --- MSP.exe (lekkie uruchomienie node app.js bez konsoli) ---
$launcherCs = Join-Path $repoDir "tools\MSP-Launcher.cs"
if (-not (Test-Path $launcherCs)) { throw "Brak pliku $launcherCs" }
$cscPath = $null
$cscCmd = Get-Command csc.exe -ErrorAction SilentlyContinue
if ($cscCmd) { $cscPath = $cscCmd.Source }
if (-not $cscPath) {
    $candidates = @(
        "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    $cscPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cscPath) { throw "Brak csc.exe - nie mozna skompilowac MSP.exe" }
$mspExe = Join-Path $outputPath "MSP.exe"
& $cscPath /nologo /target:winexe /out:$mspExe $launcherCs
if ($LASTEXITCODE -ne 0) { throw "Kompilacja MSP.exe zakonczyla sie kodem $LASTEXITCODE" }

# ---------------------------------------------------------------------------
# 2. Pliki aplikacji
# ---------------------------------------------------------------------------
$appOut = Join-Path $outputPath "resources\app"
New-Item -ItemType Directory -Path $appOut -Force | Out-Null

foreach ($file in @("app.js", "logo.png")) {
    Copy-Item -LiteralPath (Join-Path $appDirPath $file) -Destination (Join-Path $appOut $file) -Force
}

$envContent = @"
# MSP 2010 - konfiguracja klienta (wygenerowane automatycznie)
MSP_DEBUG=0
MSP_SERVER_ONLY=0
MSP_LOCALE=pl_PL
REMOTE_ASSET_BASE_URL=https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev/2010
REMOTE_ASSET_CACHE=0
REMOTE_GATEWAY_URL=https://msp-2010-api.onrender.com
USE_REMOTE_GATEWAY=1
REMOTE_GATEWAY_TIMEOUT_MS=20000
"@
Set-Content -LiteralPath (Join-Path $appOut ".env") -Value $envContent -Encoding ASCII

# ---------------------------------------------------------------------------
# 3. Tylko produkcyjne zaleznosci
# ---------------------------------------------------------------------------
$clientPackage = [ordered]@{
    name = "msp-local-2010"
    version = "1.0.0"
    private = $true
    main = "app.js"
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
Write-Host "Slim client (Ruffle) gotowy: $outputPath"
Write-Host "Rozmiar rozpakowany: $sizeMb MB"
Write-Host "Uruchom: $outputPath\MSP.exe"