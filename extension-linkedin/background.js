// Service worker de «FLOW».
//  · Pregunta a Nova qué acción toca, abre el perfil, la ejecuta con el content script y devuelve el resultado.
//  · Comprueba que el LinkedIn de este Chrome es la cuenta correcta (identidad) y se lo dice a Nova.
//  · Vigila TODAS las pestañas de LinkedIn: si aparece un captcha, una verificación o una restricción, o LinkedIn cierra la sesión,
//    avisa a Nova (que pausa la cuenta) y se pausa a sí misma.
//  · Recibe de Nova la configuración (textos, selectores, patrones de bloqueo): si LinkedIn cambia su página, se corrige en el servidor.
// Nunca envía la cookie de LinkedIn: solo comprueba que existe para saber si la sesión está iniciada.
const VERSION = '0.10.0';
const DEFAULTS = { apiBase: 'https://api.novacentrax.com', token: '', paused: true };
const CONFIG_DEFECTO = {
  v: 0,
  textos: { connect: ['connect', 'conectar'], pending: ['pending', 'pendiente'], message: ['message', 'mensaje'], addNote: ['add a note', 'añadir una nota', 'agregar una nota'], send: ['send', 'enviar'], sendNoNote: ['send without a note', 'enviar sin nota'], more: ['more', 'más'] },
  selectores: { notaTextarea: 'textarea[name="message"], textarea#custom-message, .artdeco-modal textarea', cajaMensaje: 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]', botonEnviarMensaje: 'button.msg-form__send-button', modal: '.artdeco-modal, [role="dialog"]' },
  deteccion: {
    urlPatterns: [{ pattern: '/checkpoint/challenge/', pageType: 'captcha' }, { pattern: '/checkpoint/lg/login-challenge-submit', pageType: 'identity-verification' }, { pattern: '/flagship-web/login/login-restriction', pageType: 'login-restriction' }],
    bodyPatterns: [{ source: 'restricted your account until .+? because we detected the use of software that automates activity', flags: 'i', pageType: 'account-restricted' }],
  },
  chequeos: { check_connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/', check_inbox: 'https://www.linkedin.com/messaging/', check_notifications: 'https://www.linkedin.com/notifications/' },
};
let busy = false;

const get = () => chrome.storage.local.get({ ...DEFAULTS, estado: {}, config: null, identidad: { slug: '', t: 0 } });
const setEstado = async (e) => { const { estado } = await get(); await chrome.storage.local.set({ estado: { ...estado, ...e, t: Date.now() } }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfg = async () => (await get()).config || CONFIG_DEFECTO;

// El sondeo NO es un reloj fijo de 60 s (eso deja un patrón perfecto): cada ciclo agenda el siguiente a 28–80 s al azar.
// Una alarma de seguridad cada 2 min lo reanima si el service worker se durmió.
let lastTick = 0;
const armar = () => chrome.alarms.create('poll', { delayInMinutes: (28 + Math.random() * 52) / 60 });
const iniciarAlarmas = () => { armar(); chrome.alarms.create('poll_safe', { periodInMinutes: 2 }); };
chrome.runtime.onInstalled.addListener(iniciarAlarmas);
chrome.runtime.onStartup.addListener(iniciarAlarmas);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});   // el icono abre el desplegable ancho (popup); el panel lateral es opcional desde el botón «Panel lateral»
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') tick(); else if (a.name === 'poll_safe' && Date.now() - lastTick > 150000) tick(); });

// ── Registro de errores: lo ve la persona en la pestaña «Errores» y se guarda también en Nova (para poder decir «falló X») ──
const MAX_ERR = 150;
async function logErr(nivel, tipo, msg, ctx) {
  try {
    const { errores } = await chrome.storage.local.get({ errores: [] });
    const it = { t: Date.now(), nivel, tipo, msg: String(msg || '').slice(0, 400), ctx: ctx || null, v: VERSION };
    const last = errores[0];
    if (last && last.tipo === tipo && last.msg === it.msg && it.t - last.t < 120000) { last.n = (last.n || 1) + 1; last.t = it.t; } else errores.unshift(it);
    await chrome.storage.local.set({ errores: errores.slice(0, MAX_ERR) });
    if (nivel !== 'info' && tipo !== 'red') api('/ext/log', { nivel, tipo, msg: it.msg, ctx: it.ctx, version: VERSION }).catch(() => {});
  } catch (_) {}
}
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (!m) return false;
  if (m.cmd === 'tick') { tick(true).then(() => send({ ok: true })); return true; }
  if (m.cmd === 'config') { cfg().then(send); return true; }
  if (m.cmd === 'puente') { puente(m.orden, m.datos || {}).then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'par_estado') { parEstado().then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'par_vincular') { parVincular(m.datos || {}).then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'activar') { activar(!!m.datos).then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'probar') { probar().then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'cola') { api('/ext/cola', {}).then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'abrirPanel') { chrome.sidePanel.open({ tabId: _s.tab && _s.tab.id }).then(() => send({ ok: true })).catch(e => send({ ok: false, error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'comentario') { api('/ext/comentario', { id: m.id, post: m.post }).then(send).catch(e => send({ error: String(e && e.message || e) })); return true; }
  if (m.cmd === 'alerta') { alertar(m.tipo, m.url).then(() => send({ ok: true })); return true; }
  return false;
});

async function api(path, body) {
  const { apiBase, token } = await get();
  const r = await fetch(apiBase + '/api/li' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) });
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (!r.ok) { const e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; e.path = path; throw e; }
  return d;
}
// El resultado de una acción YA ejecutada no se puede perder (si no, Nova la daría por fallida y pausaría la secuencia): se reintenta
// con espera creciente y, si sigue sin haber red, queda guardado para enviarlo en el siguiente ciclo.
async function enviarResultado(id, res) {
  for (const espera of [0, 2000, 6000, 15000, 30000]) {
    if (espera) await sleep(espera);
    try { await api('/ext/result', { id, ...res }); await chrome.storage.local.remove('resultadoPendiente'); return true; } catch (e) { if (e.status && e.status < 500) { await logErr('error', 'resultado_rechazado', `Nova rechazó el resultado de la acción ${id}: ${e.message}`, { id, codigo: res.codigo }); return false; } }
  }
  await chrome.storage.local.set({ resultadoPendiente: { id, res, t: Date.now() } });
  await logErr('aviso', 'resultado_pendiente', `No pude avisar a Nova del resultado de la acción ${id}; lo reintento en el próximo ciclo`, { id, codigo: res.codigo });
  return false;
}

// Un solo interruptor: activa la extensión Y la cuenta en Nova (salvo pausas por restricción, que Nova no levanta sola)
async function activar(on) {
  if (!on) { await chrome.storage.local.set({ paused: true }); await setEstado({ msg: 'Pausada por ti. No se ejecuta nada.', nivel: 'warn', motivo: 'pausa_local' }); return { ok: true }; }
  await chrome.storage.local.set({ paused: false });
  let r = {}; try { r = await api('/ext/activar', {}); } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok === false && !r.error) await setEstado({ msg: 'Nova mantiene esta cuenta en pausa: ' + (r.motivo || 'restricción'), nivel: 'err', motivo: 'cuenta_restringida' });
  tick(true);
  return { ok: true, nova: r };
}

// Solo para pruebas o tras un fallo: salta la espera sorteada y deja que la siguiente acción salga ya
async function probar() {
  try { await api('/ext/activar', { prueba: true }); } catch (e) { await logErr('aviso', 'probar', 'No pude saltar la espera: ' + e.message); }
  await tick(true); return { ok: true };
}

async function sesionIniciada() {
  try { return !!(await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' })); } catch (_) { return false; }
}

// ── Identidad: ¿qué cuenta de LinkedIn hay abierta en este Chrome? ──
// «/in/me/» solo se resuelve DENTRO de la página (no con fetch): se abre una pestaña en segundo plano y se lee a dónde llega. Se cachea 6 h.
let _idP = null;
function leerIdentidadUnica() { if (!_idP) _idP = leerIdentidad().finally(() => { _idP = null; }); return _idP; }
async function leerIdentidad() {
  const { identidad } = await get();
  if (identidad && identidad.slug && Date.now() - identidad.t < (identidad.ttl || 6 * 3600 * 1000)) return identidad.slug;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/in/me/', active: false });
    for (let i = 0; i < 20; i++) {
      await sleep(600);
      const t = await chrome.tabs.get(tab.id);
      const m = String(t.url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
      if (m && m[1].toLowerCase() !== 'me') { const slug = decodeURIComponent(m[1]).toLowerCase(); await chrome.storage.local.set({ identidad: { slug, t: Date.now(), ttl: (5 + Math.random() * 4) * 3600e3 } }); return slug; }   // se vuelve a leer cada 5–9 h (no a una hora fija)
    }
  } catch (_) {} finally { if (tab) chrome.tabs.remove(tab.id).catch(() => {}); }
  return (identidad && identidad.slug) || '';
}

// ── Alertas: bloqueo o sesión cerrada, en cualquier pestaña de LinkedIn ──
const avisadas = new Map();
async function alertar(tipo, url) {
  const { token } = await get();
  if (!token) return;
  const clave = tipo + '|' + String(url || '').split('?')[0];
  if (avisadas.get(clave) && Date.now() - avisadas.get(clave) < 10 * 60 * 1000) return;
  avisadas.set(clave, Date.now());
  await chrome.storage.local.set({ paused: true });   // la propia extensión se detiene hasta que la reactives a mano
  await setEstado({ msg: `LinkedIn mostró «${tipo}». Extensión en pausa: entra a LinkedIn, revisa el aviso y reactívala.`, nivel: 'err' });
  await logErr('error', 'alerta_linkedin', `LinkedIn mostró «${tipo}»: la extensión se pausó sola`, { tipo, url: String(url || '').slice(0, 160) });
  try { await api('/ext/alert', { tipo, url: String(url || '').slice(0, 300), ua: navigator.userAgent }); } catch (_) {}
}
chrome.tabs.onUpdated.addListener(async (_id, info, tab) => {
  const url = info.url || (info.status === 'complete' ? tab.url : '');
  if (!url || !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(url)) return;
  const c = await cfg();
  for (const p of (c.deteccion && c.deteccion.urlPatterns) || []) if (url.includes(p.pattern)) { alertar(p.pageType, url); return; }
});
// LinkedIn cierra una sesión respondiendo con «li_at=delete me» (o Clear-Site-Data): se avisa para no seguir enviando a ciegas
try {
  chrome.webRequest.onHeadersReceived.addListener(det => {
    for (const h of det.responseHeaders || []) {
      const n = (h.name || '').toLowerCase(), v = String(h.value || '');
      if ((n === 'set-cookie' && /li_at=delete me/i.test(v)) || (n === 'clear-site-data' && /"cookies"|"\*"/.test(v))) { alertar('sesion_cerrada', det.url); return; }
    }
  }, { urls: ['*://*.linkedin.com/*'] }, ['responseHeaders', 'extraHeaders']);
} catch (_) {}

let fallosRed = 0;
async function tick(manual) { lastTick = Date.now(); try { await tickInner(manual); } finally { armar(); } }
async function tickInner(manual) {
  if (busy) return;
  const { token, paused } = await get();
  if (!token) return setEstado({ msg: 'Falta el token. Pégalo en este panel.', nivel: 'warn' });
  if (paused) return setEstado({ msg: 'Extensión en pausa. Actívala en este panel.', nivel: 'warn' });
  busy = true;
  try {
    const { resultadoPendiente: pend } = await chrome.storage.local.get({ resultadoPendiente: null });
    if (pend) { if (Date.now() - pend.t > 6 * 3600e3) await chrome.storage.local.remove('resultadoPendiente'); else await enviarResultado(pend.id, pend.res); }
    const sesion = await sesionIniciada();
    const slug = sesion ? await leerIdentidad() : '';
    const r = await api('/ext/next', { version: VERSION, sesion, li_slug: slug });
    fallosRed = 0;
    if (r.config && r.config.v !== undefined) await chrome.storage.local.set({ config: r.config });
    if (!sesion) { await logErr('aviso', 'sin_sesion_linkedin', 'No hay sesión de LinkedIn iniciada en este Chrome'); return setEstado({ msg: 'Inicia sesión en LinkedIn en este Chrome.', nivel: 'warn' }); }
    if (!r.accion && ['cuenta_distinta', 'sesion_cerrada'].includes(r.motivo)) await logErr('error', r.motivo, traducir(r.motivo), { slug });
    if (!r.accion) return setEstado({ msg: 'Sin acciones ahora: ' + traducir(r.motivo) + (r.espera_s ? ` (reintento en ${Math.ceil(r.espera_s / 60)} min)` : ''), nivel: r.motivo === 'cuenta_distinta' ? 'err' : 'ok', slug, motivo: r.motivo || '', resumen: r.resumen || null, ...(r.modo ? { modo: r.modo } : {}) });
    await setEstado({ msg: `Ejecutando: ${r.accion.tipo} → ${r.accion.slug}` + (r.modo === 'auto' ? ' (automático)' : ' (asistido: tú pulsas «Enviar» si es invitación o mensaje)'), nivel: 'work', accion: r.accion, slug, modo: r.modo || '' });
    // Si abrir la página o hablar con ella falla, igual se informa a Nova (si no, la acción quedaría «en curso» y se daría por fallida a los 10 min)
    let res; try { res = await ejecutar(r.accion, r.modo); } catch (e) { res = { codigo: 'fallo', error: /tard/i.test(e.message) ? 'pagina_lenta' : 'excepcion_extension', detalle: String(e && e.message || e).slice(0, 200) }; }
    if (res.codigo !== 'ok') await logErr(res.codigo === 'omitida' ? 'aviso' : 'error', 'accion_' + (res.error || res.codigo), `${r.accion.tipo} → ${r.accion.slug}: ${res.codigo}${res.error ? ' (' + res.error + ')' : ''}${res.detalle ? ' — ' + res.detalle : ''}`, { tipo: r.accion.tipo, slug: r.accion.slug, codigo: res.codigo, error: res.error, detalle: res.detalle });
    await enviarResultado(r.accion.id, res);
    if (res.codigo === 'restringida') await chrome.storage.local.set({ paused: true });
    await setEstado({ msg: `Resultado ${r.accion.tipo}: ${res.codigo}${res.error ? ' (' + res.error + ')' : ''}`, nivel: res.codigo === 'ok' ? 'ok' : 'warn', accion: null });
  } catch (e) {
    // Un 5xx o un corte de red es del lado de Nova/internet, no de LinkedIn: se reintenta solo y solo se muestra en rojo si se repite
    const red = (e.status && e.status >= 500) || /Failed to fetch|NetworkError|Load failed/i.test(String(e.message));
    if (red) {
      fallosRed++;
      const grave = fallosRed >= 5;
      await logErr(grave ? 'error' : 'aviso', 'red', `Nova no respondió (${e.message})${e.path ? ' en ' + e.path : ''} · intento ${fallosRed}`, { status: e.status || 0, path: e.path || '' });
      await setEstado({ msg: grave ? `Nova no responde desde hace ${fallosRed} intentos (${e.message}). Sigo reintentando.` : `Nova no respondió (${e.message}). Reintento automático…`, nivel: grave ? 'err' : 'warn', resumen: null });
    } else {
      await logErr('error', 'ciclo', e.message, { path: e.path || '', status: e.status || 0 });
      await setEstado({ msg: 'Error: ' + e.message, nivel: 'err' });
    }
  } finally { busy = false; }
}

function traducir(m) {
  return ({ cola_vacia: 'cola vacía', fuera_de_horario: 'fuera del horario', dia_no_laborable: 'día no laborable', espera_entre_acciones: 'espera entre acciones', tope_total_dia: 'tope total del día', tope_invite_dia: 'tope de invitaciones del día', tope_invitaciones_semana: 'tope semanal de invitaciones', tope_message_dia: 'tope de mensajes del día', tope_visit_dia: 'tope de visitas del día', tope_notas_mes_cuenta_gratis: 'tope mensual de notas (cuenta gratuita)', cuenta_pausada: 'cuenta pausada en Nova', cuenta_restringida: 'cuenta en pausa por restricción', cuenta_desconectada: 'cuenta desconectada', cuenta_distinta: 'ESTE CHROME TIENE OTRA CUENTA DE LINKEDIN: revisa el token', pausa_hasta: 'pausa activa', pausa_descanso: 'pausa de descanso (a propósito, cambia cada día)', accion_en_curso: 'acción en curso' })[m] || (m || '');
}

// Abre el perfil (en primer plano si es asistido y es una acción real) y le pide al content script que la haga.
async function ejecutar(a, modo) {
  const esCheck = String(a.tipo).startsWith('check_');
  const asistido = !esCheck && modo !== 'auto';
  const url = a.url || (await cfg()).chequeos[a.tipo];
  const tab = await chrome.tabs.create({ url, active: asistido });
  try {
    await esperarCarga(tab.id, 45000);
    await sleep(2500 + Math.random() * 6500);   // un humano tarda en mirar la página (2,5–9 s, nunca igual)
    let r;
    for (let i = 0; i < 3; i++) {
      try { r = await chrome.tabs.sendMessage(tab.id, { cmd: 'ejecutar', accion: a, asistido, config: await cfg() }); break; } catch (e) { await sleep(2000); }
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


// ── Órdenes que llegan desde la página de Nova (vincular sin copiar tokens) ──
async function puente(orden, datos) {
  const { token, paused, estado } = await get();
  if (orden === 'hello') {
    const sesion = await sesionIniciada();
    const { identidad } = await get();
    const slug = sesion && identidad && identidad.slug ? identidad.slug : '';
    if (sesion && !slug) leerIdentidadUnica().catch(() => {});   // se lee en segundo plano: el próximo «hello» ya la trae (la respuesta tiene que ser inmediata)
    return { instalada: true, version: VERSION, sesion_linkedin: sesion, li_slug: slug, vinculada: !!token, pausada: paused };
  }
  if (orden === 'vincular') {
    if (!/^nvli_[a-f0-9]+$/i.test(String(datos.token || ''))) return { error: 'token_invalido' };
    await chrome.storage.local.set({ token: datos.token, paused: true, estado: {}, identidad: { slug: '', t: 0 } });
    return { ok: true };
  }
  if (orden === 'activar') {
    if (!token && !datos.token) return { error: 'sin_vincular' };
    if (datos.activa) await activar(true); else await chrome.storage.local.set({ paused: true });
    return { ok: true, pausada: !datos.activa };
  }
  if (orden === 'estado') return { vinculada: !!token, pausada: paused, estado };
  return { error: 'orden_desconocida' };
}


// ── Vinculación desde la propia extensión: se usa la sesión de Nova de este Chrome, sin copiar tokens ──
async function novaFetch(path, opts) {
  const { apiBase } = await get();
  const r = await fetch(apiBase + '/api' + path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, data: d };
}
async function parEstado() {
  const sesion = await sesionIniciada();
  const slug = sesion ? await leerIdentidadUnica() : '';
  let nova = null;
  try { nova = await novaFetch('/li/pair/accounts'); } catch (e) { return { nova: 'sin_conexion', sesion_linkedin: sesion, li_slug: slug }; }
  if (nova.status === 401) return { nova: 'sin_sesion', sesion_linkedin: sesion, li_slug: slug };
  if (nova.status !== 200) return { nova: 'error', detalle: (nova.data && nova.data.error) || ('HTTP ' + nova.status), sesion_linkedin: sesion, li_slug: slug };
  return { nova: 'ok', sesion_linkedin: sesion, li_slug: slug, cuentas: nova.data.cuentas || [], clientes: nova.data.clientes || [], usuario: nova.data.usuario || '' };
}
async function parVincular(d) {
  const slug = (await sesionIniciada()) ? await leerIdentidadUnica() : '';
  const body = d.account_id ? { account_id: d.account_id, li_slug: slug } : { nueva: { nombre: d.nombre || 'Cuenta LinkedIn', outbound_client_id: d.cliente_id || null }, li_slug: slug };
  const r = await novaFetch('/li/pair', { method: 'POST', body: JSON.stringify(body) });
  if (r.status !== 200 || !r.data.token) return { error: (r.data && r.data.error) || ('HTTP ' + r.status) };
  await chrome.storage.local.set({ token: r.data.token, paused: true, estado: { msg: 'Cuenta vinculada. Pulsa Activar cuando quieras empezar.', nivel: 'ok', t: Date.now(), slug }, identidad: { slug, t: Date.now() } });
  return { ok: true, cuenta: r.data.cuenta, slug };
}


// Los scripts de una extensión no entran en pestañas que ya estaban abiertas al instalarla o recargarla: se inyecta el puente en las pestañas de Nova abiertas
async function inyectarPuente() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://app.novacentrax.com/*' });
    for (const t of tabs) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['puente.js'] }).catch(() => {});
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(inyectarPuente);
chrome.runtime.onStartup.addListener(inyectarPuente);
inyectarPuente();
