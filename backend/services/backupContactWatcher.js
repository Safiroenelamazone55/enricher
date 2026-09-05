// ─────────────────────────────────────────────────────────────────────
// Backup Contact Watcher — avisa cuando el contacto Principal de una empresa
// terminó su secuencia SIN respuesta y todavía hay un contacto Secundario de
// esa misma empresa esperando (nunca enrolado). Pedido explícito 2026-09-05:
// "si él no me contesta, ¿hay alguien más esperando?". NUNCA activa al
// siguiente sola — solo avisa; activar es siempre decisión humana (mismo
// criterio que nurtureWatcher/reply-watcher).
// Corre cada hora — no hay prisa de minutos, la secuencia ya terminó.
// ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT k.id, k.user_id, k.outbound_client_id
        FROM lm_contact_sequences cs
        JOIN lm_contacts k ON k.id = cs.contact_id
       WHERE cs.estado = 'terminado'
         AND k.contact_priority = 'Primario'
         AND k.company_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM lm_contacts nx
            WHERE nx.company_id = k.company_id AND nx.user_id = k.user_id AND nx.id <> k.id
              AND nx.contact_priority = 'Secundario'
              AND NOT EXISTS (SELECT 1 FROM lm_contact_sequences cs2 WHERE cs2.contact_id = nx.id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM activities a
            WHERE a.contact_id = k.id AND a.tipo = 'contacto_esperando' AND a.estado = 'pendiente'
         )
       LIMIT 200
    `);
    for (const c of rows) {
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,'contacto_esperando',$4,NOW(),'pendiente')`,
        [c.user_id, c.id, c.outbound_client_id, 'Terminó la secuencia sin respuesta — hay otro contacto de esta empresa esperando.']
      );
    }
    if (rows.length) console.log(`[backup-contact-watcher] ${rows.length} tarea(s) "contacto_esperando" creada(s)`);
  } catch (e) {
    console.warn('[backup-contact-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startBackupContactWatcher(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 60 * 60 * 1000);
  _timer.unref?.();
  tick(pool);
  console.log('[backup-contact-watcher] started (tick 60min)');
}

module.exports = { startBackupContactWatcher, tick };
