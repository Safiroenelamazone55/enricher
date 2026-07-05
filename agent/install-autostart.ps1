<#
  install-autostart.ps1 — hace que el agente arranque solo al iniciar sesión (oculto).
  Crea un acceso directo en la carpeta de Inicio que lanza run-hidden.vbs.

  Instalar:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
  Quitar:    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Nova Activity Agent.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host "Autostart quitado." -ForegroundColor Green }
  else { Write-Host "No estaba instalado." }
  return
}

$vbs = Join-Path $dir 'run-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "No se encontro run-hidden.vbs en $dir" }

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $dir
$s.Description = 'Nova Activity - Desktop Agent'
$s.Save()
Write-Host "Autostart instalado:" -ForegroundColor Green
Write-Host "  $lnk"
Write-Host "Arrancara solo en el proximo inicio de sesion. Para iniciarlo ahora, ejecuta run-hidden.vbs o start.bat."
