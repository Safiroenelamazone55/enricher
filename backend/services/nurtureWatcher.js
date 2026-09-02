// ─────────────────────────────────────────────────────────────────────
// Nurture Watcher — crea la tarea "revisar_nurture" cuando llega la fecha de
// retomar un contacto en "mas_adelante" (nurture_at). NUNCA reinscribe sola en
// ninguna secuencia — solo avisa; la reactivación es siempre decisión humana
// (mismo criterio del reply-watcher: se anuncia, no se actúa por la usuaria).
// Corre cada hora — no hay ninguna prisa de minutos como con las respuestas.
// ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    const { rows } = await pool.query(`
      SELECT k.id, k.user_id, k.outbound_client_id, k.nurture_at
        FROM lm_contacts k
       WHERE k.disposition = 'mas_adelante' AND k.nurture_at IS NOT NULL AND k.nurture_at <= CURRENT_DATE
         AND NOT EXISTS (
           SELECT 1 FROM activities a
            WHERE a.contact_id = k.id AND a.tipo = 'revisar_nurture' AND a.estado = 'pendiente'
         )
       LIMIT 200
    `);
    for (const c of rows) {
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,'revisar_nurture',$4,NOW(),'pendiente')`,
        [c.user_id, c.id, c.outbound_client_id, `Llegó la fecha de retomar contacto (${c.nurture_at})`]
      );
    }
    if (rows.length) console.log(`[nurture-watcher] ${rows.length} tarea(s) "revisar_nurture" creada(s)`);
  } catch (e) {
    console.warn('[nurture-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startNurtureWatcher(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 60 * 60 * 1000);
  _timer.unref?.();
  tick(pool); // primera pasada al arrancar, no esperar una hora
  console.log('[nurture-watcher] started (tick 60min)');
}

module.exports = { startNurtureWatcher, tick };
