// ─────────────────────────────────────────────────────────────────────
// Interesado Watcher — seguimiento automático del "Interesado" que deja de responder.
//
// Interesado = conversación real (se marca a mano). Si pasan 7 días desde su última
// respuesta (o desde el último seguimiento) y no hay reunión agendada:
//   1-3. Se crea una tarea 'seguimiento_inactivo' ("Sin respuesta hace X días · N/3");
//        la 3.ª es el mensaje de cierre ("¿lo retomamos más adelante?").
//   Tras el 3.er intento + 7 días más sin respuesta → pasa SOLO a 'mas_adelante' con
//   motivo "Dejó de responder" y retomar en 3 meses (el nurtureWatcher avisa ese día).
// NUNCA pasa a 'no_interesado': el silencio no es un rechazo.
// Si el contacto vuelve a responder, el contador se reinicia solo (ver "followups_efectivos").
// Corre cada hora, igual que nurtureWatcher.
// ─────────────────────────────────────────────────────────────────────

const DIAS_ENTRE_INTENTOS = 7;
const MAX_INTENTOS = 3;
const MESES_NURTURE = 3;
const DIAS_SIN_CLASIFICAR = 3; // aviso si un 'Respondió' lleva N días sin clasificar (y se repite cada N días)

let _timer = null;
let _running = false;

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT k.id, k.user_id, k.outbound_client_id, k.interesado_last_followup_at,
               lr.last_reply,
               GREATEST(lr.last_reply, k.interesado_last_followup_at) AS ultima_senal,
               -- si volvió a responder después del último seguimiento, el conteo arranca de cero
               CASE WHEN k.interesado_last_followup_at IS NULL OR lr.last_reply > k.interesado_last_followup_at
                    THEN 0 ELSE k.interesado_followups END AS followups_efectivos
          FROM lm_contacts k
          LEFT JOIN LATERAL (
            SELECT MAX(a.fecha) AS last_reply FROM activities a
             WHERE a.contact_id = k.id AND a.tipo IN ('respuesta','reunion','conversacion')
          ) lr ON true
         WHERE k.disposition = 'interesado' AND k.reunion_agendada_at IS NULL
           AND k.deal_valor IS NULL AND k.deal_cierre IS NULL AND COALESCE(k.estado,'') NOT IN ('propuesta','negociacion','ganado')
      ) t
      WHERE t.ultima_senal IS NOT NULL
        AND t.ultima_senal <= NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM activities a WHERE a.contact_id = t.id AND a.tipo = 'seguimiento_inactivo' AND a.estado = 'pendiente'
        )
      LIMIT 200
    `, [String(DIAS_ENTRE_INTENTOS)]);

    let tareas = 0, movidos = 0;
    for (const c of rows) {
      const dias = Math.floor((Date.now() - new Date(c.ultima_senal).getTime()) / 86400000);
      if (c.followups_efectivos >= MAX_INTENTOS) {
        // Agotó los intentos → "Más adelante · Dejó de responder", retomar en 3 meses.
        await pool.query(
          `UPDATE lm_contacts
              SET disposition='mas_adelante', nurture_at=(CURRENT_DATE + ($2 || ' months')::interval)::date,
                  nurture_motivo='Dejó de responder', interesado_followups=0, interesado_last_followup_at=NULL, updated_at=NOW()
            WHERE id=$1`, [c.id, String(MESES_NURTURE)]);
        await pool.query(
          `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
           VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
          [c.user_id, c.id, c.outbound_client_id,
           `Automático: Interesado → Más adelante (dejó de responder tras ${MAX_INTENTOS} seguimientos). Retomar en ${MESES_NURTURE} meses.`]);
        movidos++;
      } else {
        const n = c.followups_efectivos + 1;
        const nota = n === MAX_INTENTOS
          ? `Sin respuesta hace ${dias} días · seguimiento ${n}/${MAX_INTENTOS} — mensaje de cierre: "¿lo retomamos más adelante?"`
          : `Sin respuesta hace ${dias} días · seguimiento ${n}/${MAX_INTENTOS}`;
        await pool.query(
          `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
           VALUES ($1,$2,$3,'seguimiento_inactivo',$4,NOW(),'pendiente')`,
          [c.user_id, c.id, c.outbound_client_id, nota]);
        await pool.query(
          `UPDATE lm_contacts SET interesado_followups=$2, interesado_last_followup_at=NOW() WHERE id=$1`, [c.id, n]);
        tareas++;
      }
    }
    // ── "Respondió" sin clasificar: aviso a los 3 días, se repite cada 3 hasta que lo clasifiques ──
    // Al clasificarlo (deja de ser 'respondio') el aviso pendiente se cierra solo.
    await pool.query(`
      UPDATE activities a SET estado='hecha'
       WHERE a.tipo='seguimiento_inactivo' AND a.estado='pendiente' AND a.nota LIKE 'Sin clasificar%'
         AND NOT EXISTS (SELECT 1 FROM lm_contacts k WHERE k.id=a.contact_id AND k.disposition='respondio')`);
    const { rows: sinC } = await pool.query(`
      SELECT k.id, k.user_id, k.outbound_client_id, lr.last_reply
        FROM lm_contacts k
        JOIN LATERAL (SELECT MAX(a.fecha) AS last_reply FROM activities a WHERE a.contact_id=k.id AND a.tipo='respuesta') lr ON true
       WHERE k.disposition='respondio' AND lr.last_reply IS NOT NULL
         AND lr.last_reply <= NOW() - ($1 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM activities a WHERE a.contact_id=k.id AND a.tipo='seguimiento_inactivo' AND a.nota LIKE 'Sin clasificar%'
              AND (a.estado='pendiente' OR a.fecha > NOW() - ($1 || ' days')::interval))
       LIMIT 200`, [String(DIAS_SIN_CLASIFICAR)]);
    for (const c of sinC) {
      const dias = Math.floor((Date.now() - new Date(c.last_reply).getTime()) / 86400000);
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,'seguimiento_inactivo',$4,NOW(),'pendiente')`,
        [c.user_id, c.id, c.outbound_client_id, `Sin clasificar: respondió hace ${dias} días y aún no lo marcas (Interesado, Más adelante, No interesado…)`]);
      tareas++;
    }
    if (tareas || movidos) console.log(`[interesado-watcher] ${tareas} seguimiento(s) creado(s), ${movidos} pasado(s) a Más adelante`);
  } catch (e) {
    console.warn('[interesado-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startInteresadoWatcher(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 60 * 60 * 1000);
  _timer.unref?.();
  tick(pool);
  console.log('[interesado-watcher] started (tick 60min)');
}

module.exports = { startInteresadoWatcher, tick };
