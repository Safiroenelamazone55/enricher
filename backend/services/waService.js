'use strict';
// ─────────────────────────────────────────────────────────────────────
// WhatsApp de trabajo (Operaciones) — vía Baileys, NO la API oficial de Meta.
//
// Decisión (ver memoria del proyecto): para "seguimiento responsable y nutrir con
// quien ya abrió conversación" — bajo volumen, contactos ya calientes — Baileys es
// razonable. Si más adelante esto se usa para prospección fría masiva, hay que migrar
// a la API oficial (WhatsApp Business Platform) para no arriesgar el número.
//
// Cómo funciona: Baileys habla directo el protocolo de WhatsApp Web — el número real
// se "vincula" como un dispositivo más (como cuando escaneas el QR desde la compu).
// Sin costo por mensaje, sin aprobación de Meta, sin plantillas.
//
// Una conexión = un socket vivo en memoria (Map connectionId → sock), con sus
// credenciales persistidas en disco (backend/data/wa-sessions/<id>/, gitignored).
// Sobrevive a un `pm2 restart`: al arrancar el server, _resumeAll() reconecta solas
// las conexiones que ya estaban vinculadas, sin pedir un QR nuevo.
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'wa-sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const _socks = new Map();   // connectionId → sock vivo
const _reintentos = new Map(); // connectionId → cuántos cortes seguidos lleva
const MAX_REINTENTOS = 5; // pasado esto, una sesión que nunca llegó a "open" está
                           // muerta (creds corruptas, QR nunca escaneado, etc.) —
                           // mejor dejarla desconectada que reintentar por siempre.

function _sessionDir(id) { return path.join(SESSIONS_DIR, String(id)); }

function _esChatValido(jid) {
  return !!jid && jid !== 'status@broadcast' && !jid.endsWith('@broadcast');
}

// WhatsApp está migrando a "LID" (un id alterno de privacidad, ej. 126044438843646@lid)
// que NO es el número de teléfono real aunque tenga esa forma — es la causa de que antes
// se vieran "números" que no coincidían con el teléfono. sock.signalRepository.lidMapping
// sabe traducir un @lid al @s.whatsapp.net real cuando WhatsApp ya mandó esa relación;
// si todavía no la mandó, se deja el @lid tal cual (se resuelve solo más adelante).
async function _resolverJid(sock, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid);
    if (pn) return pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
  } catch (_) { /* sin mapeo todavía */ }
  return jid;
}

// Directorio de nombres — separado de wa_messages para poder listar "con quién
// puedo escribir" (el "Nuevo chat") sin depender de que ya exista una conversación.
// No pisa un nombre real con uno vacío (p.ej. un mensaje de alguien sin pushName).
async function _guardarContacto(pool, sock, connId, jid, nombre) {
  jid = await _resolverJid(sock, jid);
  if (!_esChatValido(jid) || !nombre) return;
  try {
    await pool.query(`
      INSERT INTO wa_contacts (connection_id, jid, nombre, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (connection_id, jid) DO UPDATE SET nombre=EXCLUDED.nombre, updated_at=NOW()`,
      [connId, jid, nombre]);
  } catch (e) { console.warn('[wa] guardar contacto:', e.message); }
}

async function _guardarMensaje(pool, sock, connId, m) {
  let jid = m.key?.remoteJid || '';
  if (!_esChatValido(jid)) return;
  jid = await _resolverJid(sock, jid);
  const texto = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  // En grupos pushName es quien mandó ESE mensaje puntual, no el grupo — el nombre del
  // grupo en sí llega aparte por 'chats' (ver messaging-history.set) y no se pisa acá.
  const nombre = (!jid.endsWith('@g.us') && m.pushName) ? m.pushName : '';
  if (nombre) await _guardarContacto(pool, sock, connId, jid, nombre);
  if (!texto) return; // v1: solo texto (fotos/audio/etc. quedan fuera por ahora)
  const ts = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date();
  const remitente = jid.endsWith('@g.us') ? (m.pushName || '') : '';
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const replyToId = ctx?.stanzaId || '';
  const replyToTexto = ctx?.quotedMessage?.conversation || ctx?.quotedMessage?.extendedTextMessage?.text || '';
  try {
    await pool.query(`
      INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, nombre, texto, ts, reply_to_id, reply_to_texto)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (connection_id, msg_id) DO NOTHING`,
      [connId, jid, m.key.id, !!m.key.fromMe, remitente, texto, ts, replyToId, replyToTexto]);
  } catch (e) { console.warn('[wa] guardar mensaje:', e.message); }
}

// Migración de una sola vez por conexión: los @lid que se guardaron ANTES de tener el
// mapeo (o antes de este fix) se traducen ahora que el socket ya está abierto y puede
// resolverlos. Idempotente — si no hay nada que resolver, no hace nada.
async function _normalizarLid(pool, sock, connId) {
  try {
    const { rows } = await pool.query(`
      SELECT jid FROM (
        SELECT DISTINCT chat_jid AS jid FROM wa_messages WHERE connection_id=$1 AND chat_jid LIKE '%@lid'
        UNION
        SELECT DISTINCT jid FROM wa_contacts WHERE connection_id=$1 AND jid LIKE '%@lid'
      ) t`, [connId]);
    if (!rows.length) return;
    let resueltos = 0;
    for (const { jid: lid } of rows) {
      const real = await _resolverJid(sock, lid);
      if (real === lid) continue; // todavía sin mapeo
      await pool.query(`UPDATE wa_messages SET chat_jid=$1 WHERE connection_id=$2 AND chat_jid=$3`, [real, connId, lid]);
      const { rows: [existente] } = await pool.query(
        `SELECT 1 FROM wa_contacts WHERE connection_id=$1 AND jid=$2`, [connId, real]);
      if (existente) await pool.query(`DELETE FROM wa_contacts WHERE connection_id=$1 AND jid=$2`, [connId, lid]);
      else await pool.query(`UPDATE wa_contacts SET jid=$1 WHERE connection_id=$2 AND jid=$3`, [real, connId, lid]);
      resueltos++;
    }
    if (resueltos) console.log(`[wa] conexión ${connId}: ${resueltos}/${rows.length} @lid traducidos al número real`);
  } catch (e) { console.warn('[wa] normalizarLid:', e.message); }
}

async function _connect(pool, id) {
  // Import perezoso: Baileys es pesado y solo hace falta cuando de verdad se usa esto.
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    require('@whiskeysockets/baileys');

  const dir = _sessionDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  // syncFullHistory:true (es el default de la librería, lo dejamos explícito) es lo
  // que hace que WhatsApp mande los chats/contactos/mensajes recientes al vincular
  // — sin esto la conexión queda "en blanco" aunque el teléfono sí tenga historial.
  // No trae TODO el historial desde siempre: Baileys igual filtra el tipo de sync
  // más pesado (HistorySyncType.FULL) por default.
  const sock = makeWASocket({ auth: state, syncFullHistory: true });
  _socks.set(id, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    try {
      if (qr) {
        const qrPng = await QRCode.toDataURL(qr);
        await pool.query(
          `UPDATE wa_connections SET estado='esperando_qr', qr_actual=$1, updated_at=NOW() WHERE id=$2`,
          [qrPng, id]);
      }
      if (connection === 'open') {
        _reintentos.delete(id); // ya conectó bien — se olvida cualquier corte anterior
        const numero = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] : '';
        await pool.query(
          `UPDATE wa_connections SET estado='conectado', numero=$1, qr_actual='', connected_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [numero, id]);
        console.log(`[wa] conexión ${id} vinculada (${numero})`);
        _normalizarLid(pool, sock, id).catch(e => console.warn('[wa] normalizarLid:', e.message));
      }
      if (connection === 'close') {
        _socks.delete(id);
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const intentos = (_reintentos.get(id) || 0) + 1;
        if (loggedOut || intentos > MAX_REINTENTOS) {
          // Vinculación revocada desde el teléfono (o "cerrar sesión" nuestro), o una
          // sesión que nunca prendió tras varios intentos — hay que escanear un QR
          // nuevo. Se limpia la sesión en disco para no arrastrar credenciales muertas.
          _reintentos.delete(id);
          await pool.query(
            `UPDATE wa_connections SET estado='desconectado', qr_actual='', numero='', updated_at=NOW() WHERE id=$1`,
            [id]);
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(loggedOut
            ? `[wa] conexión ${id} cerró sesión — hace falta un QR nuevo`
            : `[wa] conexión ${id} no logró conectar tras ${MAX_REINTENTOS} intentos — se deja desconectada`);
        } else {
          // Cualquier otro corte (red, reinicio del servidor, etc.) se reintenta solo.
          _reintentos.set(id, intentos);
          console.log(`[wa] conexión ${id} se cortó, reintentando… (${intentos}/${MAX_REINTENTOS})`);
          setTimeout(() => _connect(pool, id).catch(e => console.warn('[wa] reconectar:', e.message)), 3000);
        }
      }
    } catch (e) { console.warn('[wa] connection.update:', e.message); }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    // 'notify' = mensajes nuevos en vivo. El volcado de historial llega aparte,
    // por 'messaging-history.set' (abajo) — así no se procesan dos veces.
    if (ev.type !== 'notify') return;
    for (const m of ev.messages) await _guardarMensaje(pool, sock, id, m);
  });

  // Se dispara una vez tras conectar (puede repetirse en tandas: progress/isLatest)
  // con lo que el teléfono ya trae: contactos guardados y mensajes recientes de cada
  // chat. Es lo que llena "chats previos" sin que Jenny tenga que escribir primero.
  sock.ev.on('messaging-history.set', async (ev) => {
    try {
      const { chats, contacts, messages } = ev || {};
      console.log(`[wa] historial recibido (conexión ${id}): ${contacts?.length || 0} contactos, ${chats?.length || 0} chats, ${messages?.length || 0} mensajes`);
      for (const c of (contacts || [])) {
        const nombre = c.name || c.notify || c.verifiedName || '';
        await _guardarContacto(pool, sock, id, c.id, nombre);
      }
      // El nombre de un grupo (el asunto) viene por acá, no por 'contacts' — un grupo
      // no es un contacto individual. En 1:1 sirve de respaldo si 'contacts' no trajo nombre.
      for (const c of (chats || [])) {
        if (c.name) await _guardarContacto(pool, sock, id, c.id, c.name);
      }
      for (const m of (messages || [])) await _guardarMensaje(pool, sock, id, m);
    } catch (e) { console.warn('[wa] messaging-history.set:', e.message); }
  });

  const _sincronizarContactos = async (contactos) => {
    for (const c of (contactos || [])) {
      const nombre = c.name || c.notify || c.verifiedName || '';
      if (c.id) await _guardarContacto(pool, sock, id, c.id, nombre);
    }
  };
  sock.ev.on('contacts.upsert', _sincronizarContactos);
  sock.ev.on('contacts.update', _sincronizarContactos);

  return sock;
}

async function iniciar(pool, id) {
  if (_socks.has(id)) return; // ya está corriendo
  await _connect(pool, id);
}

async function enviar(pool, id, jid, texto, respondeA) {
  const sock = _socks.get(id);
  if (!sock) throw new Error('Este WhatsApp no está conectado ahora mismo');
  const jidFull = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

  let quoted;
  if (respondeA) {
    const { rows: [orig] } = await pool.query(
      `SELECT msg_id, from_me, texto FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND msg_id=$3`,
      [id, jidFull, respondeA]);
    // Objeto mínimo que Baileys necesita para armar el "responder a" — no hace falta
    // el mensaje completo original, solo su key + el texto que va a mostrar citado.
    if (orig) quoted = { key: { remoteJid: jidFull, id: orig.msg_id, fromMe: orig.from_me }, message: { conversation: orig.texto } };
  }

  const res = await sock.sendMessage(jidFull, { text: texto }, quoted ? { quoted } : undefined);
  await pool.query(`
    INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, texto, ts, reply_to_id, reply_to_texto)
    VALUES ($1,$2,$3,TRUE,$4,NOW(),$5,$6) ON CONFLICT (connection_id, msg_id) DO NOTHING`,
    [id, jidFull, res.key.id, texto, quoted ? respondeA : '', quoted ? quoted.message.conversation : '']);
  return { jid: jidFull, msg_id: res.key.id };
}

async function desconectar(pool, id) {
  const sock = _socks.get(id);
  if (sock) { try { await sock.logout(); } catch (_) { /* logout dispara connection.update igual */ } }
  _socks.delete(id);
  fs.rmSync(_sessionDir(id), { recursive: true, force: true });
  await pool.query(
    `UPDATE wa_connections SET estado='desconectado', qr_actual='', numero='', updated_at=NOW() WHERE id=$1`, [id]);
}

// Al arrancar el server: retoma las conexiones que ya estaban vinculadas (o esperando
// QR) sin que Jenny tenga que volver a escanear cada vez que se reinicia PM2.
async function reanudarTodas(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM wa_connections WHERE estado IN ('conectado','esperando_qr')`);
    for (const r of rows) {
      iniciar(pool, r.id).catch(e => console.warn(`[wa] reanudar ${r.id}:`, e.message));
    }
  } catch (e) { console.warn('[wa] reanudarTodas:', e.message); }
}

module.exports = { iniciar, enviar, desconectar, reanudarTodas };
