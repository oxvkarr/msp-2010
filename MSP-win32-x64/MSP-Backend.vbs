Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = baseDir & "\resources\app"
command = "cmd /c cd /d """ & appDir & """ && set MSP_SERVER_ONLY=1 && npm run start-server"
shell.Run command, 0, False
