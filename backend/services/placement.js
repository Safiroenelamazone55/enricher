'use strict';
// Pruebas de bandeja: desde un buzón de un cliente se envía un correo neutro a las cuentas semilla (rol «semilla») y se lee por IMAP
// en qué carpeta cayó en cada una: Entrada, Promociones (solo se distingue en Gmail), Spam, o no llegó.
const crypto = require('crypto');
const mailboxSvc = require('./mailboxService');

const REINTENTOS = 14, ESPERA_INICIAL = 60e3, ESPERA = 90e3;   // ~20 min como máximo esperando que llegue
const aviso = (...a) => console.warn('[placement]', ...a);
const EN_CURSO = new Set();

// Carpeta → resultado. Función pura (se prueba sola).
function clasificar({ path, specialUse, labels }) {
  const p = String(path || ''), su = String(specialUse || '');
  if (su === '\\Junk' || /(^|[\/.\]\s])(spam|junk|bulk|correo no deseado|no deseado|indesead|courrier ind)/i.test(p)) return 'spam';
  if ((labels || []).some(l => /promo/i.test(String(l)))) return 'promociones';
  if (/^inbox$/i.test(p) || /bandeja de entrada|posteingang/i.test(p)) return 'inbox';
  return null;
}

async function buscarEnSemilla(seed, token) {
  const pass = mailboxSvc.decPass(seed.pass_enc);
  const client = await mailboxSvc._imapConnect({ email: seed.email, imap_host: seed.imap_host, imap_port: seed.imap_port, provider: seed.provider }, pass);
  try {
    const cajas = await client.list();
    const orden = [
      ...cajas.filter(b => clasificar({ path: b.path, specialUse: b.specialUse }) === 'spam'),
      ...cajas.filter(b => clasificar({ path: b.path, specialUse: b.specialUse }) === 'inbox'),
    ];
    for (const b of orden) {
      let lock; try { lock = await client.getMailboxLock(b.path, { readOnly: true }); } catch (_) { continue; }
      try {
        const uids = await client.search({ subject: token });
        if (uids && uids.length) {
          let labels = [];
          if (seed.provider === 'google') { try { const m = await client.fetchOne(uids[0], { labels: true }, { uid: true }); labels = m && m.labels ? [...m.labels] : []; } catch (_) {} }
          return { carpeta: clasificar({ path: b.path, specialUse: b.specialUse, labels }) || 'inbox', ruta: b.path };
        }
      } finally { lock.release(); }
    }
    return null;
  } finally { await client.logout().catch(() => {}); }
}

async function lanzar(pool, uid, mailboxId, onListo) {
  const { rows: [mb] } = await pool.query(`SELECT * FROM lm_mailboxes WHERE id=$1 AND user_id=$2 AND estado IN ('conectado','solo_envio')`, [mailboxId, uid]);
  if (!mb) throw Object.assign(new Error('El buzón no está conectado'), { status: 400 });
  const { rows: seeds } = await pool.query(`SELECT * FROM lm_warm_pool WHERE user_id=$1 AND rol='semilla' AND estado='conectado' ORDER BY id`, [uid]);
  if (!seeds.length) throw Object.assign(new Error('Conecta al menos una cuenta semilla (Warm-up → Pruebas).'), { status: 400 });
  const { rows: [rec] } = await pool.query(`SELECT 1 FROM lm_placement_tests WHERE mailbox_id=$1 AND created_at > NOW() - interval '10 minutes' AND estado <> 'listo'`, [mb.id]);
  if (rec) throw Object.assign(new Error('Ya hay una prueba en curso para este buzón.'), { status: 409 });
  const token = 'ref-' + crypto.randomBytes(4).toString('hex');
  const { rows: [t] } = await pool.query(`INSERT INTO lm_placement_tests (user_id, mailbox_id, token, estado) VALUES ($1,$2,$3,'esperando') RETURNING id`, [uid, mb.id, token]);
  const auth = await mailboxSvc.getMailboxAuth(pool, mb);
  for (const s of seeds) {
    try {
      await mailboxSvc.sendFromMailbox(mb, auth, { to: s.email, subject: `Verificación de entrega ${token}`, text: `Hola,\n\nEste es un mensaje de prueba de entregabilidad (${token}). Puedes ignorarlo.\n\nGracias.`, fromName: mb.from_name || undefined });
      await pool.query(`INSERT INTO lm_placement_results (test_id, seed_id, estado) VALUES ($1,$2,'pendiente')`, [t.id, s.id]);
    } catch (e) {
      await pool.query(`INSERT INTO lm_placement_results (test_id, seed_id, estado, error) VALUES ($1,$2,'error',$3)`, [t.id, s.id, String(e.message || e).slice(0, 200)]);
    }
  }
  seguir(pool, t.id, 0, onListo);
  return { id: t.id, token, semillas: seeds.length };
}

async function resumir(pool, testId) {
  const { rows } = await pool.query(`SELECT estado, COUNT(*)::int n FROM lm_placement_results WHERE test_id=$1 GROUP BY estado`, [testId]);
  return Object.fromEntries(rows.map(r => [r.estado, r.n]));
}

// Revisa las semillas que faltan; repite hasta que lleguen todas o se acaben los intentos
async function seguir(pool, testId, intento, onListo) {
  if (EN_CURSO.has(testId) && intento === 0) return;
  EN_CURSO.add(testId);
  setTimeout(async () => {
    try {
      const { rows: [t] } = await pool.query(`SELECT * FROM lm_placement_tests WHERE id=$1`, [testId]);
      if (!t || t.estado === 'listo') { EN_CURSO.delete(testId); return; }
      const { rows: pend } = await pool.query(`SELECT r.id, r.seed_id, s.* FROM lm_placement_results r JOIN lm_warm_pool s ON s.id = r.seed_id WHERE r.test_id=$1 AND r.estado='pendiente'`, [testId]);
      for (const s of pend) {
        try {
          const f = await buscarEnSemilla(s, t.token);
          if (f) await pool.query(`UPDATE lm_placement_results SET estado=$1, carpeta=$2, checked_at=NOW() WHERE test_id=$3 AND seed_id=$4`, [f.carpeta, f.ruta, testId, s.seed_id]);
          else if (intento >= REINTENTOS) await pool.query(`UPDATE lm_placement_results SET estado='no_llego', checked_at=NOW() WHERE test_id=$1 AND seed_id=$2`, [testId, s.seed_id]);
        } catch (e) {
          if (intento >= REINTENTOS) await pool.query(`UPDATE lm_placement_results SET estado='error', error=$1, checked_at=NOW() WHERE test_id=$2 AND seed_id=$3`, [String(e.message || e).slice(0, 200), testId, s.seed_id]);
        }
      }
      const { rows: [quedan] } = await pool.query(`SELECT COUNT(*)::int n FROM lm_placement_results WHERE test_id=$1 AND estado='pendiente'`, [testId]);
      if (!quedan.n) {
        await pool.query(`UPDATE lm_placement_tests SET estado='listo', resumen=$2, terminado_at=NOW() WHERE id=$1`, [testId, JSON.stringify(await resumir(pool, testId))]);
        EN_CURSO.delete(testId); if (onListo) onListo(t);
      } else { EN_CURSO.add(testId); seguir(pool, testId, intento + 1, onListo); }
    } catch (e) { aviso('seguir', e.message); EN_CURSO.delete(testId); }
  }, intento === 0 ? ESPERA_INICIAL : ESPERA);
}

// Tras un reinicio del servidor: retoma las pruebas que quedaron esperando
async function retomar(pool, onListo) {
  const { rows } = await pool.query(`SELECT id FROM lm_placement_tests WHERE estado='esperando' AND created_at > NOW() - interval '40 minutes'`);
  rows.forEach(r => seguir(pool, r.id, 1, onListo));
  await pool.query(`UPDATE lm_placement_tests SET estado='listo', resumen='{}' WHERE estado='esperando' AND created_at <= NOW() - interval '40 minutes'`);
}

// Puntos de «spam del calentamiento» (30) a partir de la última prueba: Entrada = 1, Promociones = 0,7, Spam / no llegó = 0
function puntosDePrueba(prueba) {
  if (!prueba || !prueba.total) return null;
  const rate = (prueba.inbox + 0.7 * (prueba.promociones || 0)) / prueba.total;
  return { pts: Math.round(30 * rate), tasa: Math.round(rate * 100) };
}

module.exports = { clasificar, lanzar, seguir, retomar, resumir, puntosDePrueba, buscarEnSemilla };
