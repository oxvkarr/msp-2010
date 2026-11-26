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
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Url -OutFile $archive -UseBasicParsing
    }

    if (-not (Test-Path $archive)) {
        throw "Nie pobrano archiwum."
    }
    if ((Get-Item $archive).Length -lt 10MB) {
        throw "Pobrany plik jest za maly - to prawdopodobnie blad serwera."
    }

    # Never terminate unrelated Node/Electron apps or erase a user-selected directory.
    $targetExe = [System.IO.Path]::GetFullPath((Join-Path $OutDir 'MSP.exe'))
    $running = Get-Process -Name MSP -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and [string]::Equals($_.Path, $targetExe, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    if ($running) { throw 'Zamknij MSP 2010 przed instalacja.' }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    $extracted = $false
    if ($extension -eq ".7z") {
        # Proba 1: dolaczony 7zr.exe
        $sevenCandidates = @($SevenZip)
        # Proba 2: systemowy 7-Zip
        $systemSeven = "C:\Program Files\7-Zip\7z.exe"
        if (Test-Path $systemSeven) { $sevenCandidates += $systemSeven }
        $systemSeven86 = "C:\Program Files (x86)\7-Zip\7z.exe"
        if (Test-Path $systemSeven86) { $sevenCandidates += $systemSeven86 }

        foreach ($sz in $sevenCandidates) {
            if (-not $sz -or -not (Test-Path $sz)) { continue }
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Write-Host "Rozpakowywanie (7-Zip): $sz (proba $attempt)"
                & $sz x -y -aoa "-o$OutDir" $archive
                if ($LASTEXITCODE -eq 0) {
                    $extracted = $true
                    break
                }
                Write-Host "7-Zip ($sz) zakonczyl sie kodem $LASTEXITCODE, ponawiam..."
                Start-Sleep -Seconds 2
            }
            if ($extracted) { break }
        }
        if (-not $extracted) {
            throw "Nie udalo sie rozpakowac archiwum .7z (sprobowano: $($sevenCandidates -join ', '))."
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
