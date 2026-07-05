' run-hidden.vbs — arranca el agente SIN ventana (para autostart).
' Pone el directorio de trabajo en esta carpeta y lanza "node agent.js" oculto.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node agent.js", 0, False
