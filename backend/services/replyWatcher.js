// ─────────────────────────────────────────────────────────────────────
// Reply Watcher — detección de respuestas + auto-pausa (LM Fase A)
//
// Cada 5 min revisa los threads de Gmail de mensajes enviados (últimos 30
// días, aún sin respuesta). Si alguien que NO es la cuenta conectada
// escribió en el thread:
//   1. lm_messages.estado='replied' + replied_at + evento 'reply'
//   2. AUTO-PAUSA: lm_contact_sequences → estado='respondido' (todas las
//      secuencias activas de ese contacto — no seguir enviando jamás tras respuesta)
//   3. disposition='respondio' en el contacto + activity tipo 'respuesta'
//      (alimenta las métricas existentes de la secuencia)
// ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

async function tick(pool, gmailCallback) {
  if (_running) return;
  _running = true;
  try {
    // Mensajes enviados con thread, sin respuesta detectada, últimos 30 días.
    const { rows: msgs } = await pool.query(`
      SELECT m.id, m.user_id, m.contact_id, m.gmail_thread_id, m.asunto,
             k.nombre, k.apellido
        FROM lm_messages m
        JOIN lm_contacts k ON k.id = m.contact_id
       WHERE m.estado = 'sent' AND m.gmail_thread_id <> ''
         AND m.sent_at > NOW() - interval '30 days'
       ORDER BY m.sent_at DESC
       LIMIT 100
    `);
    if (!msgs.length) return;

    const { checkThreadForReply } = require('./gmailService');
    const seenThreads = new Map(); // thread → resultado (evita llamadas duplicadas)

    for (const m of msgs) {
      try {
        let result = seenThreads.get(m.gmail_thread_id);
        if (!result) {
          result = await checkThreadForReply(pool, m.user_id, gmailCallback, m.gmail_thread_id);
          seenThreads.set(m.gmail_thread_id, result);
          await new Promise(r => setTimeout(r, 300)); // suave con la API de Gmail
        }
        if (!result.replied) continue;

        await pool.query(
          `UPDATE lm_messages SET estado='replied', replied_at=$1 WHERE id=$2`,
          [result.at || new Date(), m.id]
        );
        await pool.query(
          `INSERT INTO lm_message_events (message_id, tipo, url) VALUES ($1,'reply',$2)`,
          [m.id, (result.snippet || '').slice(0, 500)]
        );
        // AUTO-PAUSA en TODAS las secuencias activas del contacto.
        const paused = await pool.query(
          `UPDATE lm_contact_sequences
              SET estado='respondido', paused_reason='respondio', next_action_at=NULL
            WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`,
          [m.user_id, m.contact_id]
        );
        await pool.query(
          `UPDATE lm_contacts SET disposition='respondio', updated_at=NOW()
            WHERE id=$1 AND (disposition='' OR disposition IS NULL)`,
          [m.contact_id]
        );
        await pool.query(
          `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
           VALUES ($1,$2,'respuesta','email',$3,NOW(),'hecha')`,
          [m.user_id, m.contact_id,
           `Respondió a "${m.asunto}"${result.snippet ? ' — ' + result.snippet.slice(0, 200) : ''}`]
        );
        console.log(`[reply-watcher] respuesta de ${m.nombre || ''} ${m.apellido || ''} → auto-pausa (${paused.rowCount} secuencias)`);
      } catch (e) {
        // token vencido / thread borrado / cuota: seguir con el resto
        if (!/invalid_grant|gmail_not_connected/.test(e.message)) {
          console.warn(`[reply-watcher] msg ${m.id}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[reply-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startReplyWatcher(pool, { gmailCallback }) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool, gmailCallback), 5 * 60 * 1000);
  _timer.unref?.();
  console.log('[reply-watcher] started (tick 5min)');
}

module.exports = { startReplyWatcher, tick };
