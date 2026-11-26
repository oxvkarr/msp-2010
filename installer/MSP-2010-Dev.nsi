Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef OUTDIR
  !define OUTDIR "..\dist"
!endif

!define APP_NAME "MSP 2010 Dev"
!define APP_EXE "MSP.exe"
!define APP_VERSION "1.0.0"
!ifndef APP_URL
  !define APP_URL "https://github.com/oxvkarr/msp-2010/releases/latest/download/MSP-2010-Dev-Slim-win64.7z"
!endif
!define PROJECT_URL "https://github.com/oxvkarr/msp-2010"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MSP2010Dev"

Name "${APP_NAME}"
OutFile "${OUTDIR}\MSP-2010-Dev-Setup.exe"
InstallDir "$LOCALAPPDATA\MSP 2010 Dev"
InstallDirRegKey HKCU "Software\MSP2010Dev" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 16
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "${__FILEDIR__}\msp.ico"
!define MUI_UNICON "${__FILEDIR__}\msp.ico"
!define MUI_WELCOMEPAGE_TITLE "Instalacja MSP 2010 (Dev)"
!define MUI_WELCOMEPAGE_TEXT "Instalator pobierze najnowsza wersje developerska klienta MSP 2010 (z trybem debug) (ok. 60-80 MB) i zainstaluje ja w wybranym folderze.$\r$\n$\r$\nZamknij gre przed instalacja.$\r$\n$\r$\nKliknij Dalej, aby kontynuowac."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Uruchom MSP 2010 (Dev)"
!define MUI_FINISHPAGE_LINK "Projekt na GitHubie"
!define MUI_FINISHPAGE_LINK_LOCATION "${PROJECT_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Polish"

Section "MSP 2010" SecInstall
    SectionIn RO
    SetOutPath "$INSTDIR"
    SetOverwrite on

    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=$PLUGINSDIR\install.ps1 "${__FILEDIR__}\install.ps1"
    File /oname=$PLUGINSDIR\7zr.exe "${__FILEDIR__}\7zr.exe"

    DetailPrint "Pobieranie najnowszej wersji MSP 2010..."
    DetailPrint "To moze potrwac kilka minut (ok. 60 MB)."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\install.ps1" -Url "${APP_URL}" -OutDir "$INSTDIR" -SevenZip "$PLUGINSDIR\7zr.exe"'
    Pop $0

    ${If} $0 != "0"
        MessageBox MB_ICONSTOP|MB_OK "Nie udalo sie zainstalowac MSP 2010.$\r$\n$\r$\nSprawdz polaczenie z internetem i sprobuj ponownie.$\r$\nKod bledu: $0"
        Abort
    ${EndIf}

    File /oname=$INSTDIR\msp.ico "${__FILEDIR__}\msp.ico"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    CreateDirectory "$SMPROGRAMS\MSP 2010 Dev"
    CreateShortcut "$SMPROGRAMS\MSP 2010 Dev\MSP 2010 Dev.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\msp.ico" 0
    CreateShortcut "$DESKTOP\MSP 2010 Dev.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\msp.ico" 0

    WriteRegStr HKCU "Software\MSP2010Dev" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "oxvkarr"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
    Delete "$DESKTOP\MSP 2010 Dev.lnk"
    Delete "$SMPROGRAMS\MSP 2010 Dev\MSP 2010 Dev.lnk"
    RMDir "$SMPROGRAMS\MSP 2010 Dev"

    DeleteRegKey HKCU "${UNINST_KEY}"
    DeleteRegKey HKCU "Software\MSP2010Dev"

    RMDir /r "$INSTDIR"
SectionEnd

