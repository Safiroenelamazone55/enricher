# ════════════════════════════════════════════════════════════════
# Nova Activity — icono de bandeja (system tray) para el agente.
# Lo lanza agent.js (powershell -STA -File tray.ps1 -Dir <appdir>).
# Lee <Dir>\.status (JSON que escribe el agente) para el estado/tooltip,
# y escribe <Dir>\.cmd (pause|resume|quit) que el agente lee y ejecuta.
# NO monitorea nada: es solo UI. Requiere Windows (WinForms).
# ════════════════════════════════════════════════════════════════
param(
  [string]$Dir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [string]$Url = "https://enricher.kiwoc.com",
  [string]$Log = ""
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$statusPath = Join-Path $Dir ".status"
$cmdPath    = Join-Path $Dir ".cmd"
$iconPath   = Join-Path $Dir "icon.ico"
if (-not $Log) { $Log = Join-Path $Dir "agent.log" }

function Write-Cmd([string]$c) { try { [System.IO.File]::WriteAllText($cmdPath, $c) } catch {} }

$icon = if (Test-Path $iconPath) { New-Object System.Drawing.Icon $iconPath } else { [System.Drawing.SystemIcons]::Application }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = "Nova Activity"
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miTitle  = New-Object System.Windows.Forms.ToolStripMenuItem "Nova Activity"
$miTitle.Enabled = $false
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem "Estado: iniciando..."
$miStatus.Enabled = $false
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$miPause = New-Object System.Windows.Forms.ToolStripMenuItem "Pausar"
$miLog   = New-Object System.Windows.Forms.ToolStripMenuItem "Ver registro (log)"
$miNova  = New-Object System.Windows.Forms.ToolStripMenuItem "Abrir Nova"
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$miExit  = New-Object System.Windows.Forms.ToolStripMenuItem "Salir"

$script:paused = $false
$miPause.add_Click({ if ($script:paused) { Write-Cmd "resume" } else { Write-Cmd "pause" } })
$miLog.add_Click({ if (Test-Path $Log) { Start-Process notepad.exe $Log } else { [System.Windows.Forms.MessageBox]::Show("Todavia no hay registro.", "Nova Activity") | Out-Null } })
$miNova.add_Click({ Start-Process $Url })
$miExit.add_Click({ Write-Cmd "quit"; $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit() })

$menu.Items.AddRange(@($miTitle, $miStatus, $sep1, $miPause, $miLog, $miNova, $sep2, $miExit))
$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Start-Process $Url })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.add_Tick({
  try {
    if (Test-Path $statusPath) {
      $j = Get-Content $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json
      $label = if ($j.label) { [string]$j.label } else { "..." }
      $script:paused = [bool]$j.paused
      if ($j.ts) {
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$j.ts
        if ($age -gt 40) { $label = "agente sin responder" }
      }
      $miStatus.Text = "Estado: $label"
      $miPause.Text  = if ($script:paused) { "Reanudar" } else { "Pausar" }
      $t = "Nova Activity - $label"
      if ($t.Length -gt 62) { $t = $t.Substring(0, 62) }
      $ni.Text = $t
    }
  } catch {}
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$ni.Visible = $false
$ni.Dispose()
