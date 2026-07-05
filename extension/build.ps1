<#
  build.ps1 - Empaqueta la extension "Nova Activity" en un ZIP listo para repartir.

  Uso (desde esta carpeta):
    powershell -ExecutionPolicy Bypass -File build.ps1           # construye el ZIP
    powershell -ExecutionPolicy Bypass -File build.ps1 -Icons    # regenera iconos antes (requiere Node)

  Genera (la version se lee de manifest.json):
    nova-activity-extension.zip    -> "ultimo" (comodo para repartir)
    nova-activity-v<version>.zip   -> release archivado por version

  Incluye SOLO los archivos de runtime + INSTALL.md. Ignora build.ps1,
  make-icons.js, README.md y PUBLISHING.md (no se reparten).
#>
param([switch]$Icons)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

# 1) (opcional) regenerar iconos PNG
if ($Icons) {
  Write-Host "Regenerando iconos..." -ForegroundColor Cyan
  & node (Join-Path $root 'icons\make-icons.js')
}

# 2) version desde el manifest
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$ver = $manifest.version
if (-not $ver) { throw "No se encontro 'version' en manifest.json" }
Write-Host ("Empaquetando Nova Activity v" + $ver) -ForegroundColor Cyan

# 3) archivos que SI van en el paquete (clave = ruta dentro del zip, valor = ruta local)
$map = [ordered]@{
  'manifest.json'     = 'manifest.json'
  'background.js'     = 'background.js'
  'popup.html'        = 'popup.html'
  'popup.css'         = 'popup.css'
  'popup.js'          = 'popup.js'
  'INSTALL.md'        = 'INSTALL.md'
  'icons/icon16.png'  = 'icons\icon16.png'
  'icons/icon32.png'  = 'icons\icon32.png'
  'icons/icon48.png'  = 'icons\icon48.png'
  'icons/icon128.png' = 'icons\icon128.png'
}

# 4) validar que todo exista antes de empaquetar
$missing = @()
foreach ($e in $map.GetEnumerator()) {
  if (-not (Test-Path (Join-Path $root $e.Value))) { $missing += $e.Value }
}
if ($missing.Count) { throw ("Faltan archivos: " + ($missing -join ', ')) }

# 5) construir los dos ZIPs
Add-Type -AssemblyName System.IO.Compression.FileSystem
$targets = @(
  (Join-Path $root 'nova-activity-extension.zip'),
  (Join-Path $root ("nova-activity-v$ver.zip"))
)
foreach ($zip in $targets) {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $fs = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
  foreach ($e in $map.GetEnumerator()) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($fs, (Join-Path $root $e.Value), $e.Key, 'Optimal') | Out-Null
  }
  $fs.Dispose()
}

# 6) verificar el resultado
$check = [System.IO.Compression.ZipFile]::OpenRead($targets[0])
$count = $check.Entries.Count
$hasManifest = ($check.Entries | Where-Object { $_.FullName -eq 'manifest.json' }).Count -eq 1
$check.Dispose()
if (-not $hasManifest) { throw "El ZIP no tiene manifest.json en la raiz" }

Write-Host ""
Write-Host "Listo:" -ForegroundColor Green
foreach ($zip in $targets) {
  $kb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
  Write-Host ("  " + (Split-Path $zip -Leaf) + "  ($kb KB, $count archivos)")
}
