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

// El "chats[].name" que trae el volcado de historial NO siempre llega para todos los
// grupos (varios quedan sin nombre pase lo que pase). sock.groupMetadata(jid) SÍ lo pide
// directo a WhatsApp — más lento pero confiable. Se cachea en memoria por proceso para
// no pedirlo de nuevo en cada mensaje del mismo grupo.
const _gruposConsultados = new Set();
async function _asegurarNombreGrupo(pool, sock, connId, jid) {
  const clave = `${connId}:${jid}`;
  if (_gruposConsultados.has(clave)) return;
  _gruposConsultados.add(clave);
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta?.subject) await _guardarContacto(pool, sock, connId, jid, meta.subject);
  } catch (e) { console.warn(`[wa] groupMetadata ${jid}:`, e.message); }
}

// esHistorial=true (volcado al vincular) nunca cuenta como "no leído" — solo lo que
// llega EN VIVO de ahí en más, y que no sea mío, empieza sin leer.
// "Eliminar para todos" llega como un mensaje NUEVO — un protocolMessage tipo REVOKE
// (type===0, confirmado contra la versión instalada de Baileys) que apunta al key
// del mensaje original. No trae texto propio: si no se intercepta acá, _guardarMensaje
// lo descarta por "sin texto" (líneas de abajo) y el original se queda tal cual en Nova
// aunque ya no exista en WhatsApp — la causa exacta de lo que reportó Jenny.
async function _marcarEliminado(pool, connId, msgId) {
  if (!msgId) return;
  try {
    await pool.query(`UPDATE wa_messages SET eliminado=TRUE WHERE connection_id=$1 AND msg_id=$2`, [connId, msgId]);
    await pool.query(`DELETE FROM wa_reactions WHERE connection_id=$1 AND msg_id=$2`, [connId, msgId]);
  } catch (e) { console.warn('[wa] marcar eliminado:', e.message); }
}

async function _guardarMensaje(pool, sock, connId, m, esHistorial) {
  let jid = m.key?.remoteJid || '';
  if (!_esChatValido(jid)) return;
  jid = await _resolverJid(sock, jid);

  const revoke = m.message?.protocolMessage;
  if (revoke && revoke.type === 0) { await _marcarEliminado(pool, connId, revoke.key?.id); return; }

  if (jid.endsWith('@g.us')) _asegurarNombreGrupo(pool, sock, connId, jid).catch(() => {});
  // Reportado por Jenny 2026-09-02: le compartieron una tarjeta de contacto de WhatsApp
  // y no aparecía en absoluto (solo se veían los mensajes de texto alrededor) — contactMessage/
  // contactsArrayMessage no se leían, así que "texto" quedaba vacío y el mensaje se
  // descartaba entero en el "if (!texto) return" de abajo. v1: se guarda como texto
  // legible (sin vCard descargable todavía, igual que fotos/audio quedan fuera por ahora).
  const contactoMsg = m.message?.contactMessage;
  const contactosArr = m.message?.contactsArrayMessage;
  // El número real vive dentro del vCard (línea TEL, con waid= si WhatsApp lo anotó —
  // más confiable que el resto del número porque ya viene sin formato local). Se guarda
  // para poder abrir un chat directo a esa persona con un clic (pedido 2026-09-02).
  const _telDeVcard = vcard => {
    if (!vcard) return '';
    const waid = vcard.match(/waid=(\d+)/);
    if (waid) return waid[1];
    const tel = vcard.match(/TEL[^:]*:([+\d][\d\s-]{6,})/);
    return tel ? tel[1].replace(/\D/g, '') : '';
  };
  let texto = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  let contactPhone = '';
  if (!texto && contactoMsg) {
    texto = `📇 Contacto compartido: ${contactoMsg.displayName || 'sin nombre'}`;
    contactPhone = _telDeVcard(contactoMsg.vcard);
  } else if (!texto && contactosArr) {
    const nombres = (contactosArr.contacts || []).map(c => c.displayName).filter(Boolean);
    texto = `📇 ${nombres.length || (contactosArr.contacts || []).length} contacto(s) compartido(s)${nombres.length ? ': ' + nombres.join(', ') : ''}`;
    // Con varios contactos solo se enlaza el primero — abrir uno con un clic ya cubre
    // el caso real; para el resto Jenny puede pedir el número por chat si hace falta.
    contactPhone = _telDeVcard((contactosArr.contacts || [])[0]?.vcard);
  }
  // En grupos pushName es quien mandó ESE mensaje puntual, no el grupo — el nombre del
  // grupo en sí se pide aparte con groupMetadata (arriba), no se pisa acá.
  const nombre = (!jid.endsWith('@g.us') && m.pushName) ? m.pushName : '';
  if (nombre) await _guardarContacto(pool, sock, connId, jid, nombre);
  if (!texto) return; // v1: solo texto (fotos/audio/etc. quedan fuera por ahora)
  const ts = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date();
  const remitente = jid.endsWith('@g.us') ? (m.pushName || '') : '';
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const replyToId = ctx?.stanzaId || '';
  const replyToTexto = ctx?.quotedMessage?.conversation || ctx?.quotedMessage?.extendedTextMessage?.text || '';
  const leido = esHistorial || !!m.key.fromMe;
  // Reportado por Jenny 2026-08-26: un mensaje entrante nunca llegó a la web aunque sí
  // llegó al teléfono. Causa confirmada: la conexión a la base (Supabase) tiene cortes
  // intermitentes ("Connection terminated due to connection timeout", visto en varios
  // servicios del backend, no solo WhatsApp) — y este INSERT no reintentaba, así que un
  // corte justo en ese instante perdía el mensaje para siempre (nunca vuelve a llegar
  // por WhatsApp). ON CONFLICT DO NOTHING ya lo hace idempotente, así que reintentar es
  // seguro — no genera duplicados si el primer intento en realidad sí se guardó.
  for (let intento = 1; intento <= 3; intento++) {
    try {
      await pool.query(`
        INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, nombre, texto, ts, reply_to_id, reply_to_texto, leido, contact_phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (connection_id, msg_id) DO NOTHING`,
        [connId, jid, m.key.id, !!m.key.fromMe, remitente, texto, ts, replyToId, replyToTexto, leido, contactPhone]);
      break;
    } catch (e) {
      if (intento === 3) { console.warn(`[wa] guardar mensaje (falló tras ${intento} intentos):`, e.message); break; }
      console.warn(`[wa] guardar mensaje, reintento ${intento}/3:`, e.message);
      await new Promise(r => setTimeout(r, 500 * intento));
    }
  }
  // Reabrir un chat "resuelto" cuando llega un mensaje nuevo de la OTRA persona (no al
  // volcado de historial ni a lo que yo mismo mando) — igual que Chatwoot/Intercom: un
  // mensaje nuevo es señal de que hay algo pendiente otra vez, no debe quedar enterrado.
  // Pedido explícito 2026-09-01: si se vuelve a marcar "resuelto" a mano, desaparece de
  // nuevo — eso ya lo hace el filtro de estado, sin nada especial de este lado.
  if (!esHistorial && !m.key.fromMe) {
    await pool.query(
      `UPDATE wa_chat_meta SET estado_conv='abierto', updated_at=NOW() WHERE connection_id=$1 AND chat_jid=$2 AND estado_conv='resuelto'`,
      [connId, jid]).catch(() => {});
    _autoRespondioPorWa(pool, connId, jid, texto).catch(e => console.warn('[wa] autoRespondio:', e.message));
  }
}

// Pedido 2026-09-02: lo mismo que ya hace replyWatcher.js para email (detectar la
// respuesta sola, sin que Jenny tenga que marcarla a mano) pero para WhatsApp — un
// mensaje entrante de un número que coincide con un contacto de Lead Manager pausa
// SUS secuencias activas (estado='respondido') y marca la disposición.
async function _autoRespondioPorWa(pool, connId, jid, texto) {
  if (jid.endsWith('@g.us')) return; // grupos no son un contacto de secuencia
  const digits = jid.replace(/\D/g, '');
  if (digits.length < 6) return;
  const { rows: [conn] } = await pool.query(`SELECT user_id FROM wa_connections WHERE id=$1`, [connId]);
  if (!conn) return;
  const { rows: [contacto] } = await pool.query(
    `SELECT id, disposition FROM lm_contacts
      WHERE user_id=$1 AND regexp_replace(COALESCE(telefono,''),'[^0-9]','','g') <> ''
        AND ( regexp_replace(COALESCE(telefono,''),'[^0-9]','','g') LIKE '%' || right($2,8)
              OR $2 LIKE '%' || right(regexp_replace(COALESCE(telefono,''),'[^0-9]','','g'),8) )
      LIMIT 1`,
    [conn.user_id, digits]);
  if (!contacto) return;
  const paused = await pool.query(
    `UPDATE lm_contact_sequences SET estado='respondido', paused_reason='respondio', next_action_at=NULL
      WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`,
    [conn.user_id, contacto.id]);
  if (!paused.rowCount) return; // nada activo que pausar — no era parte de una secuencia en curso
  await pool.query(
    `UPDATE lm_contacts SET disposition='respondio', updated_at=NOW() WHERE id=$1 AND (disposition='' OR disposition IS NULL)`,
    [contacto.id]);
  await pool.query(
    `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
     VALUES ($1,$2,'respuesta','whatsapp',$3,NOW(),'hecha')`,
    [conn.user_id, contacto.id, `Respondió por WhatsApp${texto ? ' — ' + texto.slice(0, 200) : ''}`]);
  console.log(`[wa] respuesta detectada en contacto ${contacto.id} → auto-pausa (${paused.rowCount} secuencias)`);
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
      // Si ya se etiquetó/fijó/asignó/anotó el chat ANTES de que llegara el mapeo (el
      // watchdog reintenta cada 3 min, no es instantáneo), esas filas quedaban huérfanas
      // colgando del @lid viejo — se migran al jid real, sin pisar nada si el real ya
      // tenía su propio meta/tag (entonces se descarta el del @lid, no se sobreescribe).
      await pool.query(
        `INSERT INTO wa_chat_meta (connection_id, chat_jid, pinned, snooze_until, asignado_a, estado_conv)
         SELECT connection_id, $1, pinned, snooze_until, asignado_a, estado_conv FROM wa_chat_meta
          WHERE connection_id=$2 AND chat_jid=$3
         ON CONFLICT (connection_id, chat_jid) DO NOTHING`, [real, connId, lid]);
      await pool.query(`DELETE FROM wa_chat_meta WHERE connection_id=$1 AND chat_jid=$2`, [connId, lid]);
      await pool.query(
        `INSERT INTO wa_chat_tags (connection_id, chat_jid, tag_id)
         SELECT connection_id, $1, tag_id FROM wa_chat_tags WHERE connection_id=$2 AND chat_jid=$3
         ON CONFLICT (connection_id, chat_jid, tag_id) DO NOTHING`, [real, connId, lid]);
      await pool.query(`DELETE FROM wa_chat_tags WHERE connection_id=$1 AND chat_jid=$2`, [connId, lid]);
      await pool.query(`UPDATE wa_chat_notes SET chat_jid=$1 WHERE connection_id=$2 AND chat_jid=$3`, [real, connId, lid]);
      resueltos++;
    }
    if (resueltos) console.log(`[wa] conexión ${connId}: ${resueltos}/${rows.length} @lid traducidos al número real`);
  } catch (e) { console.warn('[wa] normalizarLid:', e.message); }
}

// Grupos que ya tienen mensajes guardados pero se quedaron sin nombre (el volcado de
// historial no siempre lo trae) — se completan pidiéndolo directo a WhatsApp.
async function _backfillNombresGrupo(pool, sock, connId) {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT m.chat_jid FROM wa_messages m
      LEFT JOIN wa_contacts c ON c.connection_id = m.connection_id AND c.jid = m.chat_jid
       WHERE m.connection_id=$1 AND m.chat_jid LIKE '%@g.us' AND COALESCE(c.nombre,'') = ''`,
      [connId]);
    for (const { chat_jid } of rows) await _asegurarNombreGrupo(pool, sock, connId, chat_jid);
    if (rows.length) console.log(`[wa] conexión ${connId}: ${rows.length} grupo(s) revisados para completar nombre`);
  } catch (e) { console.warn('[wa] backfillNombresGrupo:', e.message); }
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
        _backfillNombresGrupo(pool, sock, id).catch(e => console.warn('[wa] backfillNombresGrupo:', e.message));
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
          // Se loguea el código/motivo real (antes solo decía "se cortó" sin más detalle)
          // — necesario para diagnosticar cortes frecuentes como el de 2026-08-26.
          _reintentos.set(id, intentos);
          console.log(`[wa] conexión ${id} se cortó, reintentando… (${intentos}/${MAX_REINTENTOS}) — código ${code || '?'}: ${lastDisconnect?.error?.message || 'sin detalle'}`);
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

  // Reacciones (👍❤️😂...) puestas desde el OTRO lado (el teléfono de la contraparte,
  // o el mío si reacciono desde el celular en vez de acá). key = el mensaje original
  // reaccionado; reaction.key.fromMe distingue si fui yo o la otra persona.
  sock.ev.on('messages.reaction', async (reacciones) => {
    for (const r of (reacciones || [])) {
      try {
        const jid = await _resolverJid(sock, r.key?.remoteJid || '');
        const msgId = r.key?.id;
        const emoji = r.reaction?.text || '';
        const deMi = !!r.reaction?.key?.fromMe;
        if (!msgId || !_esChatValido(jid)) continue;
        if (!emoji) {
          await pool.query(`DELETE FROM wa_reactions WHERE connection_id=$1 AND msg_id=$2 AND from_me=$3`, [id, msgId, deMi]);
        } else {
          await pool.query(`
            INSERT INTO wa_reactions (connection_id, chat_jid, msg_id, from_me, emoji, updated_at)
            VALUES ($1,$2,$3,$4,$5,NOW())
            ON CONFLICT (connection_id, msg_id, from_me) DO UPDATE SET emoji=EXCLUDED.emoji, updated_at=NOW()`,
            [id, jid, msgId, deMi, emoji]);
        }
      } catch (e) { console.warn('[wa] reacción entrante:', e.message); }
    }
  });

  // Se dispara una vez tras conectar (puede repetirse en tandas: progress/isLatest)
  // con lo que el teléfono ya trae: contactos guardados y mensajes recientes de cada
  // chat. Es lo que llena "chats previos" sin que Jenny tenga que escribir primero.
  sock.ev.on('messaging-history.set', async (ev) => {
    try {
      const { chats, contacts, messages } = ev || {};
      console.log(`[wa] historial recibido (conexión ${id}): ${contacts?.length || 0} contactos, ${chats?.length || 0} chats, ${messages?.length || 0} mensajes`);
      // Igual restricción que abajo para chats[]: un @lid sin mapeo todavía puede traer
      // un nombre cruzado de otra identidad (confirmado en producción 2026-08-26 — un
      // cliente real, Juan, quedó guardado como "NovaCentraX", el nombre del workspace,
      // vía este mismo loop). Para @lid confiamos SOLO en el pushName de sus mensajes
      // reales (_guardarMensaje) — nunca en el contacts[] del volcado de historial.
      for (const c of (contacts || [])) {
        if (String(c.id || '').endsWith('@lid')) continue;
        const nombre = c.name || c.notify || c.verifiedName || '';
        await _guardarContacto(pool, sock, id, c.id, nombre);
      }
      // El nombre de un grupo (el asunto) viene por acá, no por 'contacts' — un grupo
      // no es un contacto individual. Restringido a @g.us: para jids @lid (identificador
      // de WhatsApp scoped al grupo, NO el número real) c.name puede traer el nombre DEL
      // GRUPO en vez del contacto — confirmado en producción (2026-08-26: dos chats 1:1
      // quedaron mostrando "Novacentrax", nombre de un grupo real, prestado por este
      // fallback). El nombre real de un 1:1 sale de 'contacts'/pushName, nunca de acá.
      for (const c of (chats || [])) {
        if (c.name && String(c.id || '').endsWith('@g.us')) await _guardarContacto(pool, sock, id, c.id, c.name);
      }
      for (const m of (messages || [])) await _guardarMensaje(pool, sock, id, m, true);
    } catch (e) { console.warn('[wa] messaging-history.set:', e.message); }
  });

  const _sincronizarContactos = async (contactos) => {
    for (const c of (contactos || [])) {
      if (!c.id || String(c.id).endsWith('@lid')) continue; // ver comentario en messaging-history.set
      const nombre = c.name || c.notify || c.verifiedName || '';
      await _guardarContacto(pool, sock, id, c.id, nombre);
    }
  };
  sock.ev.on('contacts.upsert', _sincronizarContactos);
  sock.ev.on('contacts.update', _sincronizarContactos);

  // Respaldo del caso de arriba: algunas versiones/momentos entregan la eliminación
  // como una ACTUALIZACIÓN del mensaje existente en vez de un protocolMessage nuevo
  // (messageStubType===1 confirmado contra la versión instalada, o directamente
  // update.message===null).
  sock.ev.on('messages.update', async (updates) => {
    for (const u of (updates || [])) {
      try {
        const eliminado = u.update?.messageStubType === 1 || u.update?.message === null;
        if (eliminado) await _marcarEliminado(pool, id, u.key?.id);
      } catch (e) { console.warn('[wa] messages.update (revoke):', e.message); }
    }
  });

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

// Foto (pegada/adjunta, editada o no en el navegador). El archivo ya está guardado
// en disco por el endpoint (mediaUrl) — acá solo se manda por Baileys y se deja
// el registro con caption=texto, igual que un mensaje normal.
async function enviarImagen(pool, id, jid, buffer, mimetype, caption, mediaUrl, respondeA) {
  const sock = _socks.get(id);
  if (!sock) throw new Error('Este WhatsApp no está conectado ahora mismo');
  const jidFull = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

  let quoted;
  if (respondeA) {
    const { rows: [orig] } = await pool.query(
      `SELECT msg_id, from_me, texto FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND msg_id=$3`,
      [id, jidFull, respondeA]);
    if (orig) quoted = { key: { remoteJid: jidFull, id: orig.msg_id, fromMe: orig.from_me }, message: { conversation: orig.texto } };
  }

  const res = await sock.sendMessage(jidFull, { image: buffer, mimetype, caption: caption || undefined }, quoted ? { quoted } : undefined);
  await pool.query(`
    INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, texto, ts, reply_to_id, reply_to_texto, media_url, media_type)
    VALUES ($1,$2,$3,TRUE,$4,NOW(),$5,$6,$7,'image') ON CONFLICT (connection_id, msg_id) DO NOTHING`,
    [id, jidFull, res.key.id, caption || '', quoted ? respondeA : '', quoted ? quoted.message.conversation : '', mediaUrl]);
  return { jid: jidFull, msg_id: res.key.id };
}

// emoji='' quita la reacción que yo había puesto (toggle, ver frontend).
async function reaccionar(pool, id, jid, msgId, emoji) {
  const sock = _socks.get(id);
  if (!sock) throw new Error('Este WhatsApp no está conectado ahora mismo');
  const jidFull = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const { rows: [orig] } = await pool.query(
    `SELECT msg_id, from_me FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND msg_id=$3`,
    [id, jidFull, msgId]);
  if (!orig) throw new Error('No se encontró el mensaje a reaccionar');
  const key = { remoteJid: jidFull, id: orig.msg_id, fromMe: orig.from_me };
  await sock.sendMessage(jidFull, { react: { text: emoji, key } });
  if (!emoji) {
    await pool.query(`DELETE FROM wa_reactions WHERE connection_id=$1 AND msg_id=$2 AND from_me=TRUE`, [id, msgId]);
  } else {
    await pool.query(`
      INSERT INTO wa_reactions (connection_id, chat_jid, msg_id, from_me, emoji, updated_at)
      VALUES ($1,$2,$3,TRUE,$4,NOW())
      ON CONFLICT (connection_id, msg_id, from_me) DO UPDATE SET emoji=EXCLUDED.emoji, updated_at=NOW()`,
      [id, jidFull, msgId, emoji]);
  }
}

// Pide al teléfono que reenvíe historial más antiguo de UN chat puntual — para cuando
// un mensaje real nunca llegó a guardarse (bug ya corregido, o un error de descifrado
// puntual de WhatsApp con jids "@lid", visto en los logs) y no hay forma de recuperarlo
// con lo que ya está en la base. Usa fetchMessageHistory de Baileys sobre el socket YA
// conectado; los mensajes que traiga vuelven a pasar por _guardarMensaje (esHistorial),
// así que si algo faltaba, ahora sí se guarda — y lo que ya estaba, ON CONFLICT lo ignora.
async function resincronizarChat(pool, id, jid) {
  const sock = _socks.get(id);
  if (!sock) throw new Error('Este WhatsApp no está conectado ahora mismo');
  if (typeof sock.fetchMessageHistory !== 'function') throw new Error('Esta versión de Baileys no soporta pedir historial bajo demanda');
  const { rows: [oldest] } = await pool.query(
    `SELECT msg_id, from_me, ts FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 ORDER BY ts ASC LIMIT 1`,
    [id, jid]);
  if (!oldest) throw new Error('No hay ningún mensaje guardado de este chat para anclar la búsqueda');
  const key = { remoteJid: jid, id: oldest.msg_id, fromMe: oldest.from_me };
  await sock.fetchMessageHistory(80, key, new Date(oldest.ts).getTime()); // oldestMsgTimestampMs, en MILISEGUNDOS
}

async function desconectar(pool, id) {
  const sock = _socks.get(id);
  if (sock) { try { await sock.logout(); } catch (_) { /* logout dispara connection.update igual */ } }
  _socks.delete(id);
  fs.rmSync(_sessionDir(id), { recursive: true, force: true });
  await pool.query(
    `UPDATE wa_connections SET estado='desconectado', qr_actual='', numero='', updated_at=NOW() WHERE id=$1`, [id]);
}

// Envía los mensajes programados que ya cumplieron su hora. A diferencia del correo
// (que solo necesita las credenciales guardadas), acá hace falta que el socket siga
// vivo AHORA MISMO — si se desconectó el WhatsApp, se marca error en vez de perderlo.
async function flushProgramados(pool) {
  try {
    const { rows: due } = await pool.query(`
      SELECT id, connection_id, chat_jid, texto, reply_to_id FROM wa_messages
       WHERE estado='programado' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 20`);
    for (const m of due) {
      // Reclamo atómico antes de mandar: si un tick se demora más de 30s (conexión
      // lenta) y se solapa con el siguiente, esto evita que los dos manden el MISMO
      // programado — solo el que gana este UPDATE sigue adelante.
      const { rowCount } = await pool.query(`UPDATE wa_messages SET estado='enviando' WHERE id=$1 AND estado='programado'`, [m.id]);
      if (!rowCount) continue; // otro tick (o una cancelación) ya se lo llevó
      const sock = _socks.get(m.connection_id);
      if (!sock) {
        await pool.query(`UPDATE wa_messages SET estado='error_programado' WHERE id=$1`, [m.id]);
        console.warn(`[wa] programado ${m.id}: la conexión ${m.connection_id} no está conectada ahora, no se pudo enviar`);
        continue;
      }
      try {
        let quoted;
        if (m.reply_to_id) {
          const { rows: [orig] } = await pool.query(
            `SELECT msg_id, from_me, texto FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND msg_id=$3`,
            [m.connection_id, m.chat_jid, m.reply_to_id]);
          if (orig) quoted = { key: { remoteJid: m.chat_jid, id: orig.msg_id, fromMe: orig.from_me }, message: { conversation: orig.texto } };
        }
        const res = await sock.sendMessage(m.chat_jid, { text: m.texto }, quoted ? { quoted } : undefined);
        await pool.query(
          `UPDATE wa_messages SET msg_id=$1, estado='enviado', ts=NOW() WHERE id=$2`,
          [res.key.id, m.id]);
      } catch (e) {
        await pool.query(`UPDATE wa_messages SET estado='error_programado' WHERE id=$1`, [m.id]);
        console.warn(`[wa] programado ${m.id} falló:`, e.message);
      }
    }
  } catch (e) { console.warn('[wa] flushProgramados:', e.message); }
}

let _tickerProgramados = null;

// Guardia contra sockets "zombie": el WebSocket de Baileys puede morir en silencio
// (el servidor de WhatsApp corta sin avisar, o un corte de red se traga el cierre)
// SIN disparar 'connection.update' close — Baileys nunca se entera, así que nuestra
// lógica de reconexión automática (arriba, en el propio evento close) tampoco corre.
// _socks sigue teniendo la referencia muerta para siempre, e iniciar() la respeta
// ("ya está corriendo") y no hace nada — la única salida hoy era un pm2 restart a
// mano. Confirmado en producción (2026-08-26): dos conexiones dejaron de recibir
// mensajes en vivo sin ningún log de corte. Cada 3 min se revisa el WebSocket real
// (sock.ws.isOpen — getter propio de Baileys sobre el readyState nativo) de cada
// conexión activa; si no está abierto, se fuerza sock.end() (cierre local, SIN
// logout) para que Baileys dispare el close de verdad y entre la reconexión
// automática que ya existe.
async function _watchdogTick(pool) {
  for (const [id, sock] of _socks) {
    try {
      if (!sock?.ws?.isOpen) { // undefined también entra acá — no arriesgar un false positive de "vivo"
        console.warn(`[wa] watchdog: conexión ${id} tiene el socket muerto — forzando reconexión`);
        _socks.delete(id);
        try { sock.end(new Error('watchdog: socket no está abierto')); } catch (_) {}
        setTimeout(() => iniciar(pool, id).catch(e => console.warn(`[wa] watchdog reconectar ${id}:`, e.message)), 1000);
        continue;
      }
      // _normalizarLid antes solo corría al ABRIR la conexión — un @lid que llegó sin
      // mapeo todavía (WhatsApp lo manda con algo de retraso) se quedaba huérfano para
      // siempre mientras la conexión siguiera viva días sin reconectar: un contacto YA
      // asignado aparecía como chat NUEVO en "Sin asignar" cada vez que WhatsApp le
      // enrutaba un mensaje por LID en vez de por el número real (bug reportado por
      // Jenny 2026-08-26: la respuesta de un contacto llegó como chat separado, sin
      // asignar, aunque el hilo real ya estaba asignado a ella). Reintentar cada 3 min
      // en cada conexión viva hace que se auto-corrija solo, sin esperar un reconnect.
      _normalizarLid(pool, sock, id).catch(e => console.warn(`[wa] watchdog normalizarLid ${id}:`, e.message));
    } catch (e) { console.warn(`[wa] watchdog ${id}:`, e.message); }
  }
}
let _tickerWatchdog = null;

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
  if (!_tickerProgramados) _tickerProgramados = setInterval(() => flushProgramados(pool), 30000);
  if (!_tickerWatchdog) _tickerWatchdog = setInterval(() => _watchdogTick(pool), 3 * 60 * 1000);
}

module.exports = { iniciar, enviar, enviarImagen, reaccionar, desconectar, reanudarTodas, resincronizarChat };
