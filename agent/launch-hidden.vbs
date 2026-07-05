' Lanza nova-activity.exe SIN ventana de consola (solo queda el icono en la bandeja).
' Usado por el acceso directo y por el arranque con Windows.
Dim sh, fso, dir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\nova-activity.exe"
sh.CurrentDirectory = dir
sh.Run """" & exe & """", 0, False
