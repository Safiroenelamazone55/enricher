// ════════════════════════════════════════════════════════════════
// Nova Activity — Desktop Agent · FASE 3 del Time Tracking de Nova
// ════════════════════════════════════════════════════════════════
// Qué hace:
//   - Lee del SO (vía probe.ps1) la APP en primer plano + el IDLE real.
//   - Arma "segmentos" de uso por app y los envía a Nova como bloques
//     de `app_usage` vía POST /api/timer/ingest (mismo contrato y token
//     que la Browser Extension).
//   - Asocia cada bloque con la TAREA que estás cronometrando (/timer/running).
//   - SOLO captura mientras hay un timer manual corriendo en Nova. Si el timer está
//     apagado (o lo pausas desde la bandeja), el agente no monitorea ni envía nada.
//   - Muestra un icono en la BANDEJA del sistema (tray.ps1) con menú Estado/Pausar/Log/Salir.
//
// Multi-perfil de Chrome: como lee la ventana ACTIVA del sistema operativo, ve cualquier
// perfil de Chrome (y cualquier app), a diferencia de la extensión que es por-perfil.
//
// Qué NO hace (honesto): no lee contenido, no hace keylogging ni capturas.
//   Solo guarda: nombre de la app, título de la ventana y tiempo activo/idle.
//
// Corre como script (node agent.js, Node 18+) o empaquetado como .exe (Node SEA, sin
// requerir Node). Config en config.json (junto al exe / al script).
// ════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── Rutas: si está empaquetado (SEA) usa la carpeta del .exe; si es script, __dirname ──
const sea = (() => { try { return require('node:sea'); } catch { return null; } })();
const IS_PACKAGED = !!(sea && typeof sea.isSea === 'function' && sea.isSea());
const DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

const CONFIG_PATH = path.join(DIR, 'config.json');
const BUFFER_PATH = path.join(DIR, '.buffer.json');
const LOG_PATH    = path.join(DIR, 'agent.log');
const STATUS_PATH = path.join(DIR, '.status');
const CMD_PATH    = path.join(DIR, '.cmd');
const LOCK_PATH   = path.join(DIR, '.lock');

if (typeof fetch !== 'function') {
  console.error('[agente] Necesitas Node 18 o superior (no se encontró fetch).');
  process.exit(1);
}

// ── log a consola + archivo (para "Ver registro" desde la bandeja cuando corre oculto) ──
function log(m) {
  const line = `[${new Date().toLocaleString()}] ${m}`;
  console.log(line);
  try {
    try { const st = fs.statSync(LOG_PATH); if (st.size > 262144) fs.writeFileSync(LOG_PATH, fs.readFileSync(LOG_PATH, 'utf8').slice(-131072)); } catch { /* no existe aún */ }
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch { /* ignore */ }
}

// ── instancia única (evita dos agentes escribiendo a la vez) ──
try {
  const old = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
  if (old && old !== process.pid) { try { process.kill(old, 0); console.error(`[agente] Ya hay una instancia corriendo (PID ${old}). Saliendo.`); process.exit(0); } catch { /* PID muerto: seguimos */ } }
} catch { /* sin lock previo */ }
try { fs.writeFileSync(LOCK_PATH, String(process.pid)); } catch { /* ignore */ }

// ── config ──
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[agente] Falta config.json. Copia config.example.json → config.json y pega tu token.');
    process.exit(1);
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); }   // tolera BOM
  catch (e) { console.error('[agente] config.json no es JSON válido:', e.message); process.exit(1); }
  const cfg = {
    apiBase: (c.apiBase || 'https://api.kiwoc.com/api').replace(/\/+$/, ''),
    webUrl: (c.webUrl || 'https://enricher.kiwoc.com').replace(/\/+$/, ''),
    token: (c.token || '').trim(),
    pollSeconds: +c.pollSeconds || 15,
    idleThresholdSeconds: +c.idleThresholdSeconds || 60,
    minSegmentSeconds: +c.minSegmentSeconds || 15,
    flushSeconds: +c.flushSeconds || 60,
    tray: c.tray !== false,
  };
  if (!cfg.token || /PEGA_AQUI/i.test(cfg.token)) {
    console.error('[agente] config.json no tiene token. Genera uno en Nova → Time Tracking → Fuentes de actividad → Conectar.');
    process.exit(1);
  }
  return cfg;
}
const cfg = loadConfig();

// ── estado ──
let segment = null;          // { app, title, start (ms), taskId }
let buffer = loadBuffer();   // bloques cerrados pendientes de enviar
let lastFlush = 0;
let timerOn = false;         // ¿hay un timer manual corriendo en Nova? (gatea el monitoreo)
let timerTaskId = null;      // tarea del timer corriendo (para asociar la actividad)
let userPaused = false;      // ¿el usuario pausó desde la bandeja? (gatea el monitoreo)
let trayProc = null;

function loadBuffer() { try { return JSON.parse(fs.readFileSync(BUFFER_PATH, 'utf8').replace(/^﻿/, '')) || []; } catch { return []; } }
function saveBuffer() { try { fs.writeFileSync(BUFFER_PATH, JSON.stringify(buffer)); } catch { /* ignore */ } }

// ── estado para la bandeja (.status lo lee tray.ps1) ──
function statusLabel() {
  if (userPaused) return 'En pausa (manual)';
  if (!timerOn) return 'Timer apagado - en espera';
  return buffer.length ? `Monitoreando (${buffer.length} pend.)` : 'Monitoreando';
}
function writeStatus() {
  const state = userPaused ? 'user_paused' : (!timerOn ? 'timer_off' : 'monitoring');
  const data = { state, label: statusLabel(), paused: userPaused, pending: buffer.length, ts: Math.floor(Date.now() / 1000) };
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(data)); } catch { /* ignore */ }
}

// ── comandos desde la bandeja (.cmd lo escribe tray.ps1) ──
function pollCmd() {
  let cmd = '';
  try { if (fs.existsSync(CMD_PATH)) { cmd = fs.readFileSync(CMD_PATH, 'utf8').trim(); fs.unlinkSync(CMD_PATH); } } catch { return; }
  if (!cmd) return;
  if (cmd === 'pause')  { if (!userPaused) { userPaused = true;  if (segment) rotate(null); log('pausado desde la bandeja'); writeStatus(); } }
  else if (cmd === 'resume') { if (userPaused) { userPaused = false; log('reanudado desde la bandeja'); writeStatus(); } }
  else if (cmd === 'quit') { log('salir (desde la bandeja)'); shutdown(); }
}

// ── segmentos ──
function rotate(active) {
  const now = Date.now();
  if (segment) {
    const durS = Math.round((now - segment.start) / 1000);
    if (durS >= cfg.minSegmentSeconds) {
      buffer.push({
        app_name: segment.app,
        window_title: segment.title,
        started_at: new Date(segment.start).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_s: durS, active_s: durS, idle_s: 0,
        task_id: segment.taskId || null,   // tarea que estaba corriendo cuando ocurrió el bloque
      });
      saveBuffer();
    }
  }
  segment = active ? { app: active.app, title: active.title, start: now, taskId: timerTaskId } : null;
}

function onSample(s) {
  // Solo se monitorea con timer PRENDIDO en Nova y sin pausa manual. Si no, cierra el
  // segmento en curso y no captura nada (privacidad + evita datos sin tarea).
  if (userPaused || !timerOn) { if (segment) rotate(null); return; }
  const idleS = (s.idleMs || 0) / 1000;
  const active = (idleS < cfg.idleThresholdSeconds && s.app) ? { app: s.app, title: s.title || '' } : null;
  const key = active ? active.app : null;
  const cur = segment ? segment.app : null;
  if (key !== cur) {           // cambió de app, o entró/salió de idle
    rotate(active);
    flush(false);              // intenta enviar enseguida (con debounce)
  } else if (segment && active) {
    segment.title = active.title;   // misma app: actualiza el último título
  }
}

// Consulta el estado del timer manual en Nova → gatea el monitoreo (timerOn) y la tarea a asociar.
async function refreshTimer() {
  try {
    const r = await fetch(`${cfg.apiBase}/timer/running`, { headers: { 'Authorization': 'Bearer ' + cfg.token } });
    if (r.ok) {
      const d = await r.json();
      const was = timerOn;
      timerOn = !!d.running;
      timerTaskId = d.running ? (d.taskId || null) : null;
      if (was !== timerOn) { log(timerOn ? 'timer PRENDIDO → monitoreando actividad' : 'timer apagado → en pausa (no captura)'); writeStatus(); }
    }
  } catch { /* sin red: mantiene el último estado conocido */ }
}

// ── envío a Nova ── (cada bloque ya trae su task_id, capturado mientras el timer estaba prendido)
async function flush(force) {
  if (!buffer.length) return;
  if (!force && Date.now() - lastFlush < 20000) return;   // debounce
  const auth = { 'Authorization': 'Bearer ' + cfg.token };
  const remaining = [];
  for (const b of buffer) {
    try {
      const res = await fetch(`${cfg.apiBase}/timer/ingest`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...b, source: 'desktop_agent', activity_type: 'app_usage', task_id: b.task_id || null }),
      });
      if (!res.ok) remaining.push(b);   // 401 u otro error → reintenta luego
    } catch { remaining.push(b); }
  }
  const sent = buffer.length - remaining.length;
  buffer = remaining; saveBuffer(); lastFlush = Date.now();
  if (sent) { log(`enviados ${sent} bloque(s) · pendientes: ${buffer.length}`); writeStatus(); }
}

// ── probe (PowerShell persistente: app activa + idle real) ──
function startProbe() {
  const ps = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'probe.ps1'), '-Interval', String(cfg.pollSeconds)],
    { windowsHide: true });
  let acc = '';
  ps.stdout.on('data', d => {
    acc += d.toString();
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl).trim();
      acc = acc.slice(nl + 1);
      if (line) { try { onSample(JSON.parse(line)); } catch { /* línea corrupta */ } }
    }
  });
  ps.stderr.on('data', d => log('probe: ' + d.toString().trim()));
  ps.on('exit', code => { log(`probe terminó (code ${code}); reiniciando en 5s`); setTimeout(startProbe, 5000); });
  return ps;
}

// ── bandeja (tray.ps1: icono + menú). Es solo UI; si falla, el agente sigue igual. ──
function startTray() {
  if (!cfg.tray || process.platform !== 'win32' || process.env.NOVA_NO_TRAY) return null;
  const trayScript = path.join(DIR, 'tray.ps1');
  if (!fs.existsSync(trayScript)) return null;
  try {
    trayProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', trayScript, '-Dir', DIR, '-Url', cfg.webUrl, '-Log', LOG_PATH],
      { windowsHide: true });
    trayProc.on('exit', () => { trayProc = null; });
  } catch (e) { log('no se pudo iniciar la bandeja: ' + e.message); }
  return trayProc;
}

// ── arranque ──
log(`Nova Activity Agent · ${cfg.apiBase} · poll ${cfg.pollSeconds}s · idle ${cfg.idleThresholdSeconds}s · solo con timer PRENDIDO · ${buffer.length} pendientes${IS_PACKAGED ? ' · (exe)' : ''}`);
writeStatus();
startTray();
startProbe();
refreshTimer();
setInterval(refreshTimer, 12000);                          // revisa cada 12s si el timer está prendido/apagado
setInterval(() => flush(true), cfg.flushSeconds * 1000);
setInterval(pollCmd, 1500);                                // comandos de la bandeja (pausar/reanudar/salir)
setInterval(writeStatus, 5000);                            // refresca el estado que ve la bandeja

// cierre limpio: cierra el segmento en curso, manda lo que quede, apaga la bandeja
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  log('cerrando…');
  rotate(null);
  await flush(true);
  try { if (trayProc) trayProc.kill(); } catch { /* ignore */ }
  try { fs.unlinkSync(STATUS_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
