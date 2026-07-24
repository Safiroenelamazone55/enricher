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

// Canales visibles para la app (públicos y privados donde esté invitada).
async function canales(ws, { limit = 200, cursor } = {}) {
  const d = await _call(token(ws), 'conversations.list', {
    types: 'public_channel,private_channel', exclude_archived: true, limit, cursor,
  });
  return { canales: d.channels || [], cursor: d.response_metadata?.next_cursor || '' };
}

// Miembros del workspace — es lo que permite ver "mi equipo" y resolver las menciones.
async function miembros(ws, { limit = 200, cursor } = {}) {
  const d = await _call(token(ws), 'users.list', { limit, cursor });
  return {
    miembros: (d.members || [])
      .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
      .map(u => ({
        id: u.id, nombre: u.profile?.real_name || u.name || '',
        usuario: u.name, email: u.profile?.email || '',
        avatar: u.profile?.image_72 || '', tz: u.tz || '', admin: !!u.is_admin,
      })),
    cursor: d.response_metadata?.next_cursor || '',
  };
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

async function archivarCanal(ws, canalId) {
  await _call(token(ws), 'conversations.archive', { channel: canalId }, 'POST');
  return true;
}

module.exports = {
  encPass, verificar, canales, miembros, historial, hilo,
  enviar, directo, crearCanal, archivarCanal, normalizarNombre, _errorClaro,
};
