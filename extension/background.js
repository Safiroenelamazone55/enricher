// ════════════════════════════════════════════════════════════════
// Nova Activity — Browser Extension · FASE 2 del Time Tracking de Nova
// ════════════════════════════════════════════════════════════════
// Qué hace:
//   - Detecta el DOMINIO de la pestaña activa de la ventana enfocada.
//   - Detecta el IDLE REAL del navegador/sistema (chrome.idle).
//   - Arma "segmentos" de uso por sitio y los envía a Nova como bloques
//     de `website_usage` vía POST /api/timer/ingest (el contrato ya existe).
//   - Asocia cada bloque con la TAREA que estás cronometrando en Nova
//     (lee /timer/running para tomar el task_id del timer activo).
//
// Qué NO hace (por diseño, honesto):
//   - No lee el contenido de las páginas, no hace keylogging ni capturas.
//   - Solo guarda: dominio, título de la pestaña y tiempo. Nada más.
//
// Roadmap: la Fase 3 (Desktop Agent) usará el mismo /timer/ingest con
//   source 'desktop_agent' y activity_type 'app_usage'.
// ════════════════════════════════════════════════════════════════

const DEFAULTS = { apiBase: 'https://api.kiwoc.com/api', enabled: true };
const MIN_SEGMENT_S    = 15;   // ignora micro-visitas (<15s)
const IDLE_THRESHOLD_S = 60;   // el sistema pasa a "idle" tras 60s sin actividad

// La API de Nova vive SIEMPRE en api.kiwoc.com/api. Corrige el error común de
// haber guardado la URL de la web (enricher.kiwoc.com / app / www) en vez de la API.
function normalizeApi(raw) {
  let v = (raw || '').trim();
  if (!v) return DEFAULTS.apiBase;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (/(^|\.)kiwoc\.com$/i.test(u.hostname)) return DEFAULTS.apiBase;
    let path = u.pathname.replace(/\/+$/, '');
    if (!/\/api$/i.test(path)) path += '/api';
    return u.origin + path;
  } catch { return DEFAULTS.apiBase; }
}

function setup() {
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_S);
  chrome.alarms.create('flush', { periodInMinutes: 1 });   // SW efímero: alarma de respaldo
}
chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...cfg });
  setup();
});
chrome.runtime.onStartup.addListener(setup);

function domainOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;   // ignora chrome://, about:, file://…
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

async function getActive() {
  let win;
  try { win = await chrome.windows.getLastFocused(); } catch { win = null; }
  if (!win || !win.focused) return null;   // Chrome no está enfocado → no contamos (evita inflar el tiempo)
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || !tab.url) return null;
  const domain = domainOf(tab.url);
  return domain ? { domain, title: tab.title || '' } : null;
}

// Cierra el segmento en curso (si dura lo suficiente lo pasa al buffer) y abre el siguiente.
async function rotate(toActive) {
  const { segment, buffer = [] } = await chrome.storage.local.get(['segment', 'buffer']);
  const now = Date.now();
  let buf = buffer;
  if (segment) {
    const durS = Math.round((now - segment.start) / 1000);
    if (durS >= MIN_SEGMENT_S) {
      buf = buffer.concat([{
        website_domain: segment.domain,
        window_title:   segment.title,
        started_at: new Date(segment.start).toISOString(),
        ended_at:   new Date(now).toISOString(),
        duration_s: durS, active_s: durS, idle_s: 0,
      }]);
    }
  }
  await chrome.storage.local.set({ segment: toActive ? { ...toActive, start: now } : null, buffer: buf });
}

// Recalcula el contexto activo (respeta enabled + idle) y rota el segmento.
async function onContextChange() {
  const { enabled } = await chrome.storage.local.get(['enabled']);
  let active = null;
  if (enabled) {
    const state = await chrome.idle.queryState(IDLE_THRESHOLD_S);
    if (state === 'active') active = await getActive();
  }
  await rotate(active);
}

// Cada cambio de contexto (pestaña, foco, idle) cierra el segmento y sincroniza enseguida
// (con un pequeño debounce); la alarma de 1 min garantiza el envío aunque no cambies de pestaña.
async function onActivity() { await onContextChange(); flush(false); }
chrome.tabs.onActivated.addListener(onActivity);
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.url && tab.active) onActivity(); });
chrome.windows.onFocusChanged.addListener(onActivity);
chrome.idle.onStateChanged.addListener(onActivity);
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'flush') { await onContextChange(); await flush(true); } });

// Envía los bloques acumulados a Nova. Usa la sesión de Nova del navegador (credentials:include).
async function flush(force) {
  const { apiBase: rawApiBase, enabled, buffer = [], extToken = '', lastFlush = 0 } = await chrome.storage.local.get(['apiBase', 'enabled', 'buffer', 'extToken', 'lastFlush']);
  const apiBase = normalizeApi(rawApiBase);   // enruta a api.kiwoc.com/api aunque esté mal guardado
  if (apiBase !== rawApiBase) chrome.storage.local.set({ apiBase });
  if (!enabled || !buffer.length) return;
  if (!force && Date.now() - lastFlush < 20000) return;   // debounce: no reenvía en ráfaga al cambiar de pestaña
  // Token de extensión (Fase 2.1) si existe; si no, cae a la cookie de sesión de Nova.
  const auth = extToken ? { 'Authorization': 'Bearer ' + extToken } : {};

  // Tarea activa en Nova → asociar la actividad web con ella (si hay timer corriendo).
  let taskId = null;
  try {
    const r = await fetch(`${apiBase}/timer/running`, { credentials: 'include', headers: auth });
    if (r.ok) { const d = await r.json(); if (d.running) taskId = d.taskId || null; }
  } catch { /* sin conexión: reintenta luego */ }

  const remaining = [];
  for (const b of buffer) {
    try {
      const res = await fetch(`${apiBase}/timer/ingest`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ source: 'browser_extension', activity_type: 'website_usage', task_id: taskId, ...b }),
      });
      if (!res.ok) remaining.push(b);   // 401 u otro error → reintenta luego
    } catch { remaining.push(b); }
  }
  await chrome.storage.local.set({ buffer: remaining, lastFlush: Date.now() });
}

// El popup puede pedir un flush manual.
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === 'flush') { flush(true).then(() => reply({ ok: true })); return true; }
});
