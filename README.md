# MSP 2010

Lekki klient prywatnego serwera **MSP 2010** (MovieStarPlanet 2010) oparty na Electronie i Flash Playerze.

## Pobieranie

[![Pobierz instalator](https://img.shields.io/badge/Pobierz-MSP--2010--Setup.exe-2ea44f?style=for-the-badge&logo=windows)](https://github.com/oxvkarr/msp-2010/releases/latest/download/MSP-2010-Setup.exe)

- **Instalator** – `MSP-2010-Setup.exe` (ok. 480 KB). Podczas instalacji pobiera najnowszą, odchudzoną paczkę gry (ok. 56 MB).
- **Wersja portable** – [`MSP-2010-Slim-win64.zip`](https://github.com/oxvkarr/msp-2010/releases/latest/download/MSP-2010-Slim-win64.zip) (ok. 86 MB). Rozpakuj i uruchom `MSP.exe`.
- **Mniejsza paczka** – [`MSP-2010-Slim-win64.7z`](https://github.com/oxvkarr/msp-2010/releases/latest/download/MSP-2010-Slim-win64.7z) (ok. 56 MB, wymaga 7-Zip).

Wszystkie wersje: [Releases](https://github.com/oxvkarr/msp-2010/releases/latest).

### Instalacja

1. Pobierz `MSP-2010-Setup.exe`.
2. Uruchom plik. Jeśli pojawi się SmartScreen, kliknij **Więcej informacji** → **Uruchom mimo to** (instalator nie jest podpisany certyfikatem).
3. Kliknij **Dalej**. Instalator pobierze grę i utworzy skróty na pulpicie i w menu Start.

Wymagania: **Windows 10/11 x64** i połączenie z internetem.

## Dlaczego to jest lekkie?

W repozytorium i w instalatorze nie ma:

- drugiego pliku `MSP-Debug.exe` (oszczędność ok. 126 MB),
- ciezkiego Electrona i Flash Playera (`pepflashplayer.dll`, ok. 130 MB) - zamiast nich uzywany jest **Ruffle**, emulator Flash napisany w Rust,
- deweloperskich `node_modules` i Electrona z npm (ok. 200 MB),
- lokalnej bazy `msp-db.json` z kontami testowymi,
- zbędnych tłumaczeń Electrona i plików zbiorczych.

Zostaje tylko to, co potrzebne do uruchomienia gry: Ruffle, Node.js, serwer lokalny i kilka modułów Node. Assety gry (SWF, obrazki, dźwięki) są pobierane z Cloudflare R2, a nie trzymane w paczce.

## Co jest w środku

```
MSP-win32-x64/resources/app/
  app.js              lokalny serwer Express (AMF, SOAP, assety) + uruchamianie Ruffle
  logo.png
installer/
  MSP-2010.nsi        lekki instalator NSIS (pobiera paczkę z GitHuba)
  install.ps1         pobieranie i rozpakowanie paczki
tools/
  build-slim.ps1      buduje odchudzoną paczkę klienta (Ruffle + Node)
  MSP-Launcher.cs     zrodlo lekkiego launcher MSP.exe
.github/workflows/
  release.yml         GitHub Actions: buduje ZIP i instalator, publikuje release
```

W zbudowanej paczce klienta (dist/MSP-2010):
  MSP.exe             launcher (uruchamia node app.js bez konsoli)
  ruffle.exe          emulator Flash (Ruffle)
  node.exe            runtime Node.js
  resources/app/      serwer + zaleznosci Node

## Budowanie lokalnie

Wymagania: Node.js 20+, .NET Framework (csc.exe, jest w Windows), 7-Zip (opcjonalnie) i NSIS (opcjonalnie, do instalatora).

```powershell
# Build (pobiera Ruffle i Node, kompiluje MSP.exe):
powershell -ExecutionPolicy Bypass -File tools/build-slim.ps1
```

Gotowy klient trafi do `dist\MSP-2010`. Uruchom `dist\MSP-2010\MSP.exe`.

Instalator (wymaga NSIS):

```powershell
& "C:\Program Files (x86)\NSIS\makensis.exe" /DOUTDIR="$PWD\dist" installer\MSP-2010.nsi
```

## Automatyczne wydania

Każda zmiana w `app.js`, `main.js`, `installer/` lub `tools/build-slim.ps1` na gałęzi `main` uruchamia GitHub Actions. Workflow:

1. pobiera Electron 11.5.0,
2. buduje odchudzoną paczkę i pakuje ją do ZIP,
3. kompiluje instalator NSIS,
4. publikuje pliki w release **latest**.

Instalator zawsze pobiera najnowszą paczkę z:

```text
https://github.com/oxvkarr/msp-2010/releases/latest/download/MSP-2010-Slim-win64.7z
```

## Uwagi

- To nieoficjalny, prywatny serwer. Nie używaj haseł z prawdziwego konta MovieStarPlanet.
- Klient nie jest podpisany cyfrowo, dlatego Windows może pokazać SmartScreen.
- Flash Player nie jest juz potrzebny: uzywany jest Ruffle (`ruffle.exe`), emulator Flash napisany w Rust.
