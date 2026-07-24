// ── Slack: varios workspaces a la vez ────────────────────────────────────────
// La idea es dejar de saltar de un Slack de cliente a otro: cada workspace se
// conecta con su propio token y aquí se ven todos juntos.
//
// Por qué un token por workspace y no una sola app distribuida: desde mayo de 2025
// Slack recorta conversations.history/replies a 1 petición por minuto para las apps
// "distribuidas fuera del Marketplace". Las apps internas de un workspace mantienen
// los límites normales, así que crear una app POR workspace deja cada instalación
// del lado bueno de esa frontera.
//
// Se prefiere el token de USUARIO (xoxp-) sobre el de bot: un bot solo ve los canales
// a los que se le invita —habría que invitarlo a cada canal ya existente— y sus
// mensajes salen a nombre de la app. Con el de usuario se ve lo mismo que ve ella y
// los mensajes salen a su nombre, que es lo que importa hablando con clientes.
//
// El token nunca se guarda en claro: se cifra con el mismo AES-256-GCM que usan las
// contraseñas de los buzones.
const { encPass, decPass } = require('./mailboxService');

const API = 'https://slack.com/api';

async function _call(token, metodo, params = {}, method = 'GET') {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  let url = `${API}/${metodo}`;
  if (method === 'GET') {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    if ([...qs].length) url += `?${qs}`;
  } else {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(params);
  }
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(_errorClaro(d.error || `HTTP ${r.status}`));
  return d;
}

// Los errores de Slack son códigos secos ("invalid_auth"); aquí se traducen a algo
// que se pueda leer sin abrir la documentación.
function _errorClaro(code) {
  const M = {
    invalid_auth:        'El token no es válido o fue revocado',
    account_inactive:    'El token pertenece a una cuenta desactivada',
    token_revoked:       'El token fue revocado desde Slack',
    not_authed:          'Falta el token',
    missing_scope:       'A la app le faltan permisos — revisa los scopes y reinstálala',
    ratelimited:         'Slack está limitando las peticiones; reintenta en un momento',
    channel_not_found:   'El canal no existe o la app no fue invitada a él',
    not_in_channel:      'La app no está en ese canal — invítala con /invite',
    is_archived:         'El canal está archivado',
    name_taken:          'Ya existe un canal con ese nombre',
    restricted_action:   'El workspace no permite esta acción a las apps',
  };
  return M[code] || `Slack: ${code}`;
}

// Comprueba el token y devuelve de qué workspace es. Se llama ANTES de guardarlo:
// no tiene sentido almacenar un token que no funciona.
async function verificar(token) {
  const d = await _call(token, 'auth.test');
  return {
    team_id:   d.team_id || '',
    team_name: d.team    || '',
    user_id:   d.user_id || '',
    bot_id:    d.bot_id  || '',
    tipo:      d.bot_id ? 'bot' : 'user',
    url:       d.url     || '',
  };
}

const token = ws => decPass(ws.token_enc);

// Todo lo que se puede abrir: canales públicos y privados, mensajes directos (im) y
// grupos de directos (mpim). Sin 'im' no aparecían las conversaciones con el equipo,
// que es justo donde se habla del día a día.
async function canales(ws, { limit = 300, cursor } = {}) {
  const d = await _call(token(ws), 'conversations.list', {
    types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit, cursor,
  });
  return { canales: d.channels || [], cursor: d.response_metadata?.next_cursor || '' };
}

// Miembros del workspace — es lo que permite ver "mi equipo" y resolver las menciones.
async function miembros(ws, { limit = 200, cursor } = {}) {
  const d = await _call(token(ws), 'users.list', { limit, cursor });
  // El indice incluye a TODOS —bots y desactivados— porque un mensaje directo puede
  // ser con alguien que ya dejo el workspace, y sin su nombre la conversacion
  // aparecia como "Directo".
  const indice = {};
  (d.members || []).forEach(u => { indice[u.id] = u.profile?.real_name || u.real_name || u.name || ''; });
  return {
    miembros: (d.members || [])
      .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
      .map(u => ({
        id: u.id, nombre: u.profile?.real_name || u.name || '',
        usuario: u.name, email: u.profile?.email || '',
        avatar: u.profile?.image_72 || '', tz: u.tz || '', admin: !!u.is_admin,
      })),
    indice,
    cursor: d.response_metadata?.next_cursor || '',
  };
}

// No leídos. Slack no ofrece un total por workspace: unread_count_display llega en
// conversations.info, uno por canal. Para no gastar el presupuesto de peticiones se
// consultan solo los canales donde se está dentro, de 6 en 6, y el resultado se
// guarda un minuto.
const _cacheNL = new Map();   // wsId -> { at, datos }
async function noLeidos(ws, canales) {
  const guardado = _cacheNL.get(ws.id);
  if (guardado && Date.now() - guardado.at < 60_000) return guardado.datos;

  const propios = canales.filter(c => c.is_member || c.is_im || c.is_mpim).slice(0, 60);
  const porCanal = {};      // id -> nº sin leer
  const actividad = {};     // id -> ts del ultimo mensaje (para ordenar por reciente)
  let total = 0;
  for (let i = 0; i < propios.length; i += 6) {
    const lote = propios.slice(i, i + 6);
    const res = await Promise.all(lote.map(c =>
      _call(token(ws), 'conversations.info', { channel: c.id })
        .then(d => ({ id: c.id, n: d.channel?.unread_count_display || 0, ts: d.channel?.latest?.ts || null }))
        .catch(() => ({ id: c.id, n: 0, ts: null }))));   // un canal que falle no tumba el resto
    for (const r of res) { if (r.n) { porCanal[r.id] = r.n; total += r.n; } if (r.ts) actividad[r.id] = r.ts; }
  }
  const datos = { total, porCanal, actividad };
  _cacheNL.set(ws.id, { at: Date.now(), datos });
  return datos;
}

async function historial(ws, canal, { limit = 50, cursor } = {}) {
  const d = await _call(token(ws), 'conversations.history', { channel: canal, limit, cursor });
  return { mensajes: d.messages || [], hayMas: !!d.has_more, cursor: d.response_metadata?.next_cursor || '' };
}

// Un hilo completo. El primer elemento es el mensaje que lo abrió.
async function hilo(ws, canal, ts, { limit = 100 } = {}) {
  const d = await _call(token(ws), 'conversations.replies', { channel: canal, ts, limit });
  return { mensajes: d.messages || [] };
}

// thread_ts convierte el envío en una respuesta dentro del hilo, en vez de un
// mensaje suelto en el canal.
async function enviar(ws, canal, texto, { thread_ts } = {}) {
  const d = await _call(token(ws), 'chat.postMessage',
    { channel: canal, text: texto, thread_ts: thread_ts || undefined }, 'POST');
  return { ts: d.ts, canal: d.channel };
}

// Mensaje directo: primero se abre la conversación con esa persona, y se escribe
// en el canal que devuelve.
async function directo(ws, usuarioId, texto) {
  const c = await _call(token(ws), 'conversations.open', { users: usuarioId }, 'POST');
  return enviar(ws, c.channel.id, texto);
}

// Slack exige nombres en minúscula, sin espacios ni acentos y como máximo 80
// caracteres, así que normalizar no es una preferencia: es un requisito suyo.
function normalizarNombre(texto, prefijo = 'pj') {
  const base = String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 78 - prefijo.length);
  return `${prefijo}-${base || 'sin-nombre'}`.slice(0, 80);
}

async function crearCanal(ws, nombre, { privado = false } = {}) {
  const d = await _call(token(ws), 'conversations.create',
    { name: nombre, is_private: privado }, 'POST');
  return d.channel;
}

// Reaccionar a un mensaje (emoji por su nombre de Slack, ej. 'thumbsup').
async function reaccionar(ws, canal, ts, emoji) {
  await _call(token(ws), 'reactions.add', { channel: canal, timestamp: ts, name: emoji }, 'POST');
  return true;
}
async function quitarReaccion(ws, canal, ts, emoji) {
  await _call(token(ws), 'reactions.remove', { channel: canal, timestamp: ts, name: emoji }, 'POST');
  return true;
}

// Anclar / desanclar un mensaje del canal.
async function anclar(ws, canal, ts)   { await _call(token(ws), 'pins.add',    { channel: canal, timestamp: ts }, 'POST'); return true; }
async function desanclar(ws, canal, ts){ await _call(token(ws), 'pins.remove', { channel: canal, timestamp: ts }, 'POST'); return true; }
async function anclados(ws, canal) {
  const d = await _call(token(ws), 'pins.list', { channel: canal });
  return (d.items || []).filter(i => i.message).map(i => i.message);
}

// Subir un archivo (documento o audio) a un canal. Usa files.uploadV2 en dos pasos:
// se pide una URL de subida, se sube el binario y se confirma. El método antiguo
// files.upload quedó obsoleto en 2025.
async function subirArchivo(ws, canal, buffer, nombre, comentario, thread_ts) {
  const tk = token(ws);
  // getUploadURLExternal quiere los datos como form-urlencoded, no JSON.
  const q = new URLSearchParams({ filename: nombre, length: String(buffer.length) });
  const upR = await fetch(`${API}/files.getUploadURLExternal?${q}`, {
    headers: { Authorization: `Bearer ${tk}` } });
  const up = await upR.json();
  if (!up.ok) throw new Error(_errorClaro(up.error || 'no upload url'));
  // El binario se sube al upload_url como multipart, con el campo 'file'.
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), nombre);
  const put = await fetch(up.upload_url, { method: 'POST', body: fd });
  if (!put.ok) throw new Error('No se pudo subir el archivo a Slack');
  const done = await _call(tk, 'files.completeUploadExternal', {
    files: [{ id: up.file_id, title: nombre }],
    channel_id: canal,
    initial_comment: comentario || undefined,
    thread_ts: thread_ts || undefined,
  }, 'POST');
  return done.files?.[0] || { id: up.file_id };
}

// Marcar un canal como NO leido: se mueve el marcador de lectura al mensaje
// ANTERIOR al ultimo, para que Slack lo cuente como pendiente otra vez.
async function marcarNoLeido(ws, canalId) {
  const h = await _call(token(ws), 'conversations.history', { channel: canalId, limit: 2 });
  const msgs = h.messages || [];
  const ts = (msgs[1] || msgs[0] || {}).ts;   // el penultimo, o el ultimo si solo hay uno
  if (!ts) return false;
  await _call(token(ws), 'conversations.mark', { channel: canalId, ts }, 'POST');
  return true;
}

async function renombrarCanal(ws, canalId, nombre) {
  const d = await _call(token(ws), 'conversations.rename', { channel: canalId, name: nombre }, 'POST');
  return d.channel;
}

async function archivarCanal(ws, canalId) {
  await _call(token(ws), 'conversations.archive', { channel: canalId }, 'POST');
  return true;
}

module.exports = {
  encPass, verificar, canales, miembros, noLeidos, historial, hilo,
  enviar, directo, crearCanal, archivarCanal, normalizarNombre, _errorClaro,
  reaccionar, quitarReaccion, anclar, desanclar, anclados, subirArchivo, renombrarCanal, marcarNoLeido,
};
