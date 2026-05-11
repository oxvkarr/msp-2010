param(
    [string]$OutputDir = "",
    [string]$RemoteGatewayUrl = "https://msp-2016.onrender.com",
    [string]$RemoteAssetBaseUrl = "https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev"
)

$ErrorActionPreference = "Stop"

$appDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$winDir = Resolve-Path (Join-Path $appDir "..\..")
$repoDir = Resolve-Path (Join-Path $winDir "..")

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoDir "dist\MSP-Client-Slim"
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$winPath = [System.IO.Path]::GetFullPath($winDir)
$repoPath = [System.IO.Path]::GetFullPath($repoDir)

if ($outputPath -eq $winPath -or $winPath.StartsWith($outputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir cannot be the current client folder: $outputPath"
}

if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath | Out-Null

$runtimeItems = @(
    "MSP.exe",
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
    "locales",
    "swiftshader"
)

foreach ($item in $runtimeItems) {
    $src = Join-Path $winDir $item
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $outputPath $item) -Recurse -Force
    }
}

$targetApp = Join-Path $outputPath "resources\app"
New-Item -ItemType Directory -Path $targetApp | Out-Null

$appItems = @(
    "app.js",
    "main.js",
    "package.json",
    "package-lock.json",
    "msp-db.json",
    "logo.png",
    "pepflashplayer.dll",
    "SAFlashPlayer10.exe",
    "README.md"
)

foreach ($item in $appItems) {
    $src = Join-Path $appDir $item
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $targetApp $item) -Force
    }
}

$targetTools = Join-Path $targetApp "tools"
New-Item -ItemType Directory -Path $targetTools | Out-Null
Copy-Item -LiteralPath (Join-Path $appDir "tools\upload-r2-assets.js") -Destination $targetTools -Force

$nodeModules = Join-Path $appDir "node_modules"
$targetModules = Join-Path $targetApp "node_modules"
New-Item -ItemType Directory -Path $targetModules | Out-Null
$prodModules = @(
    "accepts",
    "amfjs",
    "array-flatten",
    "body-parser",
    "bson",
    "bytes",
    "content-disposition",
    "content-type",
    "cookie",
    "cookie-signature",
    "debug",
    "depd",
    "destroy",
    "dotenv",
    "ee-first",
    "encodeurl",
    "escape-html",
    "etag",
    "express",
    "finalhandler",
    "forwarded",
    "fresh",
    "http-errors",
    "iconv-lite",
    "inherits",
    "ipaddr.js",
    "media-typer",
    "merge-descriptors",
    "methods",
    "memory-pager",
    "mime",
    "mime-db",
    "mime-types",
    "mongodb",
    "mongodb-connection-string-url",
    "ms",
    "negotiator",
    "object-inspect",
    "on-finished",
    "parseurl",
    "path-to-regexp",
    "proxy-addr",
    "qs",
    "range-parser",
    "raw-body",
    "safe-buffer",
    "safer-buffer",
    "send",
    "serve-static",
    "setprototypeof",
    "side-channel",
    "smart-buffer",
    "socks",
    "sparse-bitfield",
    "statuses",
    "toidentifier",
    "tr46",
    "type-is",
    "unpipe",
    "utils-merge",
    "vary",
    "webidl-conversions",
    "whatwg-url"
)

foreach ($module in $prodModules) {
    $src = Join-Path $nodeModules $module
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $targetModules $module) -Recurse -Force
    }
}

# Keep the release robust: copy all installed runtime packages, then remove
# Electron's npm package because the shipped MSP.exe already contains Electron.
Remove-Item -LiteralPath $targetModules -Recurse -Force
New-Item -ItemType Directory -Path $targetModules | Out-Null
Copy-Item -Path (Join-Path $nodeModules "*") -Destination $targetModules -Recurse -Force
foreach ($devModule in @("electron", "@electron")) {
    $target = Join-Path $targetModules $devModule
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

$envContent = @"
MSP_DEBUG=0
MSP_SERVER_ONLY=0
MSP_LOCALE=pl_PL
REMOTE_GATEWAY_URL=$RemoteGatewayUrl
REMOTE_ASSET_BASE_URL=$RemoteAssetBaseUrl
REMOTE_ASSET_CACHE=0
REAL_MSP_PROXY=0
"@
Set-Content -Path (Join-Path $targetApp ".env") -Value $envContent -Encoding ASCII

$readme = @"
MSP Client Slim

Uruchamianie:
1. Odpal MSP.exe.
2. Zaakceptuj komunikat prywatnego serwera.
3. Zaloguj sie testowym kontem admin/admin albo kontem z prywatnej bramy.

Ten klient nie trzyma duzego lokalnego katalogu public/ ani asset-cache.
Assety pobiera z Cloudflare/R2:
$RemoteAssetBaseUrl

Gateway/API:
$RemoteGatewayUrl
"@
Set-Content -Path (Join-Path $outputPath "README-URUCHOM.txt") -Value $readme -Encoding UTF8

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $outputPath -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
Write-Host "Slim client ready: $outputPath"
Write-Host "Size: $sizeMb MB"
