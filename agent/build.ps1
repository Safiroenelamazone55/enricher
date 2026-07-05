# ════════════════════════════════════════════════════════════════
# Build de Nova Activity:
#   agent.js  --(Node SEA)-->  dist\nova-activity.exe  (sin requerir Node)
#   + copia probe.ps1 / tray.ps1 / icon.ico junto al exe
#   + (si Inno Setup está instalado) compila Output\NovaActivitySetup.exe
# Requiere: Node 20+ (SEA) e internet la primera vez (descarga postject vía npx).
# Uso: click derecho → "Ejecutar con PowerShell", o:  powershell -ExecutionPolicy Bypass -File build.ps1
# ════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Write-Host "== Nova Activity · build ==" -ForegroundColor Cyan

# 0) icono
if (-not (Test-Path icon.ico)) { Write-Host "[0] Generando icono..."; node make-icon.js }

# 1) blob SEA a partir de agent.js
Write-Host "[1/5] Generando blob SEA (agent.js)..."
node --experimental-sea-config sea-config.json
if (-not (Test-Path sea-prep.blob)) { throw "No se generó sea-prep.blob" }

# 2) dist + copia del runtime de Node como base del .exe
Write-Host "[2/5] Copiando runtime de Node..."
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$node = (Get-Command node).Source
$exe  = Join-Path $dist "nova-activity.exe"
Copy-Item $node $exe -Force

# 3) inyectar el blob dentro del .exe (postject). El sentinel fuse cambia entre versiones
#    de Node, así que lo extraemos del node.exe actual en vez de hardcodearlo.
Write-Host "[3/5] Inyectando el blob (postject)..."
$nodeTxt = [IO.File]::ReadAllText($node, [Text.Encoding]::GetEncoding('ISO-8859-1'))
$fi = $nodeTxt.IndexOf('NODE_SEA_FUSE_')
if ($fi -lt 0) { throw "El node.exe no contiene el fuse de SEA (necesitas Node 20+)." }
$fuse = $nodeTxt.Substring($fi, $nodeTxt.IndexOf(':', $fi) - $fi)
Write-Host "     sentinel fuse: $fuse"
npx --yes postject $exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse $fuse --overwrite
if ($LASTEXITCODE -ne 0) { throw "postject falló (revisa tu conexión: npx descarga postject la primera vez)." }

# 4) copiar recursos junto al .exe
Write-Host "[4/5] Copiando recursos (probe/tray/icono/config de ejemplo)..."
Copy-Item probe.ps1, tray.ps1, icon.ico, config.example.json $dist -Force

# 5) instalador (solo si Inno Setup está)
Write-Host "[5/5] Instalador..."
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { $c = Get-Command ISCC.exe -ErrorAction SilentlyContinue; if ($c) { $iscc = $c.Source } }
if (-not $iscc) { $iscc = (Get-ChildItem "$env:ProgramFiles\Inno Setup*\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup*\ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
if ($iscc) {
  & $iscc installer.iss
  Write-Host "OK  Instalador en:  $root\Output\NovaActivitySetup.exe" -ForegroundColor Green
} else {
  Write-Host "Inno Setup no instalado. El .exe quedó en:  $dist" -ForegroundColor Yellow
  Write-Host "Para el instalador con asistente:  winget install JRSoftware.InnoSetup  y reejecuta build.ps1." -ForegroundColor Yellow
}
Write-Host "Listo." -ForegroundColor Green
