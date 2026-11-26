param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$SevenZip = ""
)

$ErrorActionPreference = "Stop"
# NSIS ustawia cwd na folder instalacji - wyjdz z niego, zeby moc go wyczyscic.
Set-Location -LiteralPath $env:TEMP
$extension = [System.IO.Path]::GetExtension(($Url -split '\?')[0])
if ([string]::IsNullOrWhiteSpace($extension)) {
    $extension = ".zip"
}
$archive = Join-Path $env:TEMP ("msp-2010-" + [guid]::NewGuid().ToString("N") + $extension)

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Pobieranie: $Url"

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 --silent --show-error -o $archive $Url
        if ($LASTEXITCODE -ne 0) {
            throw "curl zakonczyl sie kodem $LASTEXITCODE"
        }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $archive -UseBasicParsing
    }

    if (-not (Test-Path $archive)) {
        throw "Nie pobrano archiwum."
    }
    if ((Get-Item $archive).Length -lt 10MB) {
        throw "Pobrany plik jest za maly - to prawdopodobnie blad serwera."
    }

    if (Test-Path $OutDir) {
        Remove-Item -LiteralPath $OutDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    if ($SevenZip -and (Test-Path $SevenZip) -and $extension -eq ".7z") {
        Write-Host "Rozpakowywanie (7-Zip)..."
        & $SevenZip x -y "-o$OutDir" $archive
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip zakonczyl sie kodem $LASTEXITCODE"
        }
    } else {
        $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
        if ($tar) {
            & $tar.Source -xf $archive -C $OutDir
            if ($LASTEXITCODE -ne 0) {
                throw "Rozpakowywanie zakonczylo sie kodem $LASTEXITCODE"
            }
        } else {
            Expand-Archive -LiteralPath $archive -DestinationPath $OutDir -Force
        }
    }

    if (-not (Test-Path (Join-Path $OutDir "MSP.exe"))) {
        throw "Po rozpakowaniu brakuje MSP.exe."
    }

    Write-Host "Pobrano i rozpakowano pomyslnie."
    exit 0
} catch {
    Write-Host ("BLAD: " + $_.Exception.Message)
    exit 1
} finally {
    if (Test-Path $archive) {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}
