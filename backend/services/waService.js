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

const _socks = new Map(); // connectionId → sock vivo

function _sessionDir(id) { return path.join(SESSIONS_DIR, String(id)); }

async function _connect(pool, id) {
  // Import perezoso: Baileys es pesado y solo hace falta cuando de verdad se usa esto.
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    require('@whiskeysockets/baileys');

  const dir = _sessionDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  const sock = makeWASocket({ auth: state, syncFullHistory: false });
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
        const numero = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] : '';
        await pool.query(
          `UPDATE wa_connections SET estado='conectado', numero=$1, qr_actual='', connected_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [numero, id]);
        console.log(`[wa] conexión ${id} vinculada (${numero})`);
      }
      if (connection === 'close') {
        _socks.delete(id);
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          // Vinculación revocada desde el teléfono (o "cerrar sesión" nuestro) — hay
          // que escanear un QR nuevo. Se limpia la sesión en disco para no arrastrar
          // credenciales muertas.
          await pool.query(
            `UPDATE wa_connections SET estado='desconectado', qr_actual='', numero='', updated_at=NOW() WHERE id=$1`,
            [id]);
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[wa] conexión ${id} cerró sesión — hace falta un QR nuevo`);
        } else {
          // Cualquier otro corte (red, reinicio del servidor, etc.) se reintenta solo.
          console.log(`[wa] conexión ${id} se cortó, reintentando…`);
          setTimeout(() => _connect(pool, id).catch(e => console.warn('[wa] reconectar:', e.message)), 3000);
        }
      }
    } catch (e) { console.warn('[wa] connection.update:', e.message); }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return; // solo mensajes nuevos en vivo, no el volcado de historial
    for (const m of ev.messages) {
      try {
        const jid = m.key?.remoteJid || '';
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // v1: solo chats 1:1
        const texto = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (!texto) continue; // v1: solo texto (fotos/audio/etc. quedan fuera por ahora)
        const nombre = m.pushName || '';
        const ts = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date();
        await pool.query(`
          INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, nombre, texto, ts)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id, msg_id) DO NOTHING`,
          [id, jid, m.key.id, !!m.key.fromMe, nombre, texto, ts]);
      } catch (e) { console.warn('[wa] guardar mensaje:', e.message); }
    }
  });

  return sock;
}

async function iniciar(pool, id) {
  if (_socks.has(id)) return; // ya está corriendo
  await _connect(pool, id);
}

async function enviar(pool, id, jid, texto) {
  const sock = _socks.get(id);
  if (!sock) throw new Error('Este WhatsApp no está conectado ahora mismo');
  const jidFull = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const res = await sock.sendMessage(jidFull, { text: texto });
  await pool.query(`
    INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, texto, ts)
    VALUES ($1,$2,$3,TRUE,$4,NOW()) ON CONFLICT (connection_id, msg_id) DO NOTHING`,
    [id, jidFull, res.key.id, texto]);
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
