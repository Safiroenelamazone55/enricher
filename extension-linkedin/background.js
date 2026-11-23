// Service worker: pregunta a Nova qué acción toca, abre el perfil, la ejecuta con el content script y devuelve el resultado.
// Nunca envía la cookie de LinkedIn: solo comprueba que existe para saber si la sesión está iniciada.
const VERSION = '0.1.0';
const DEFAULTS = { apiBase: 'https://api.novacentrax.com', token: '', paused: true };
let busy = false;

const get = () => chrome.storage.local.get({ ...DEFAULTS, estado: {} });
const setEstado = async (e) => { const { estado } = await get(); await chrome.storage.local.set({ estado: { ...estado, ...e, t: Date.now() } }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('poll', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('poll', { periodInMinutes: 1 }); });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') tick(); });
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m && m.cmd === 'tick') { tick(true).then(() => send({ ok: true })); return true; }
  return false;
});

async function api(path, body) {
  const { apiBase, token } = await get();
  const r = await fetch(apiBase + '/api/li' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) });
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

async function sesionIniciada() {
  try { return !!(await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' })); } catch (_) { return false; }
}

async function tick(manual) {
  if (busy) return;
  const { token, paused } = await get();
  if (!token) return setEstado({ msg: 'Falta el token. Pégalo en este panel.', nivel: 'warn' });
  if (paused) return setEstado({ msg: 'Extensión en pausa. Actívala en este panel.', nivel: 'warn' });
  busy = true;
  try {
    const sesion = await sesionIniciada();
    const r = await api('/ext/next', { version: VERSION, sesion });
    if (!sesion) return setEstado({ msg: 'Inicia sesión en LinkedIn en este Chrome.', nivel: 'warn' });
    if (!r.accion) return setEstado({ msg: 'Sin acciones ahora: ' + traducir(r.motivo) + (r.espera_s ? ` (reintento en ${Math.ceil(r.espera_s / 60)} min)` : ''), nivel: 'ok' });
    await setEstado({ msg: `Ejecutando: ${r.accion.tipo} → ${r.accion.slug}`, nivel: 'work', accion: r.accion });
    const res = await ejecutar(r.accion, r.modo);
    await api('/ext/result', { id: r.accion.id, ...res });
    if (res.codigo === 'restringida') await chrome.storage.local.set({ paused: true });
    await setEstado({ msg: `Resultado ${r.accion.tipo}: ${res.codigo}${res.error ? ' (' + res.error + ')' : ''}`, nivel: res.codigo === 'ok' ? 'ok' : 'warn', accion: null });
  } catch (e) {
    await setEstado({ msg: 'Error: ' + e.message, nivel: 'err' });
  } finally { busy = false; }
}

function traducir(m) {
  return ({ cola_vacia: 'cola vacía', fuera_de_horario: 'fuera del horario', dia_no_laborable: 'día no laborable', espera_entre_acciones: 'espera entre acciones', tope_total_dia: 'tope total del día', tope_invite_dia: 'tope de invitaciones del día', tope_invitaciones_semana: 'tope semanal de invitaciones', tope_message_dia: 'tope de mensajes del día', tope_visit_dia: 'tope de visitas del día', cuenta_pausada: 'cuenta pausada en Nova', cuenta_restringida: 'cuenta en pausa por restricción', cuenta_desconectada: 'cuenta desconectada', pausa_hasta: 'pausa activa', accion_en_curso: 'acción en curso' })[m] || (m || '');
}

// Abre el perfil (en primer plano si es asistido) y le pide al content script que haga la acción.
async function ejecutar(a, modo) {
  const asistido = modo !== 'auto';
  const tab = await chrome.tabs.create({ url: a.url, active: asistido });
  try {
    await esperarCarga(tab.id, 45000);
    await sleep(2500 + Math.random() * 3000);   // un humano tarda en mirar la página
    let r;
    for (let i = 0; i < 3; i++) {
      try { r = await chrome.tabs.sendMessage(tab.id, { cmd: 'ejecutar', accion: a, asistido }); break; } catch (e) { await sleep(2000); }
    }
    return r || { codigo: 'fallo', error: 'sin_content_script', detalle: 'La página no respondió' };
  } finally {
    if (!asistido) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
  }
}
function esperarCarga(tabId, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(f); rej(new Error('La página tardó demasiado en cargar')); }, ms);
    const f = (id, info) => { if (id === tabId && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(f); res(); } };
    chrome.tabs.onUpdated.addListener(f);
  });
}
