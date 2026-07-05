# probe.ps1 — sonda nativa de Windows para Nova Activity (Desktop Agent / Fase 3).
# Emite una línea JSON {"app","title","idleMs"} cada -Interval segundos.
# Solo lee: nombre del proceso en primer plano, título de la ventana y el idle real
# del sistema (GetLastInputInfo). NO lee contenido, teclas ni hace capturas.
param([int]$Interval = 15)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NovaProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static long IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    GetLastInputInfo(ref i);
    return (long)((uint)Environment.TickCount - i.dwTime);
  }
}
"@

while ($true) {
  try {
    $h = [NovaProbe]::GetForegroundWindow()
    $procId = 0
    [void][NovaProbe]::GetWindowThreadProcessId($h, [ref]$procId)
    $sb = New-Object System.Text.StringBuilder 512
    [void][NovaProbe]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    $app = ''
    if ($procId -gt 4) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) { $app = $p.ProcessName }
    }
    $obj = @{ app = $app; title = $title; idleMs = [NovaProbe]::IdleMs() }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine('{"app":"","title":"","idleMs":0}')
  }
  Start-Sleep -Seconds $Interval
}
