// ─────────────────────────────────────────────────────────────────────
// Followup Watcher — recordatorio de inactividad, PRENDIDO DE FÁBRICA.
// Pedido explícito 2026-09-02: "necesito que el sistema me recuerde por defecto,
// sin que yo tenga que configurarlo, pero que pueda desactivarlo si quiero" — el
// sistema debe actuar como un cerebro que avisa, no como una lista pasiva.
//
// Alcance v1: cubre el email automático del motor (lm_messages.sent_at) — es el
// canal donde de verdad puede pasar "se mandó y nadie se dio cuenta que no hay
// respuesta". Los pasos manuales (WhatsApp/llamada/LinkedIn) ya tienen su propia
// fecha visible en Tareas comerciales el día que tocan — no se duplica ese aviso
// acá. Si más adelante hace falta ampliarlo a WhatsApp, es la misma idea con
// wa_messages + wa_jid_links.
//
// followup_hours vive en lm_send_settings (24 por defecto, 0 = apagado). NO
// pausa nada ni cambia disposition — es solo un aviso, la decisión sigue siendo
// de la usuaria (mismo criterio de reply-watcher y nurture-watcher).
// ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (m.contact_id)
             m.contact_id, m.user_id, k.outbound_client_id, m.sent_at, m.asunto
        FROM lm_messages m
        JOIN lm_contacts k ON k.id = m.contact_id
        JOIN lm_contact_sequences cs ON cs.contact_id = k.id AND cs.sequence_id = m.sequence_id AND cs.estado = 'activo'
        LEFT JOIN lm_send_settings s ON s.user_id = m.user_id
       WHERE m.estado = 'sent'
         AND COALESCE(k.disposition, '') = ''
         AND COALESCE(s.followup_hours, 24) > 0
         AND m.sent_at <= NOW() - (COALESCE(s.followup_hours, 24) || ' hours')::interval
         AND (cs.next_action_at IS NULL OR cs.next_action_at > NOW() + interval '12 hours')
         AND NOT EXISTS (
           SELECT 1 FROM activities a
            WHERE a.contact_id = m.contact_id AND a.tipo = 'seguimiento_inactivo'
              AND a.estado = 'pendiente' AND a.fecha >= m.sent_at
         )
       ORDER BY m.contact_id, m.sent_at DESC
       LIMIT 200
    `);
    for (const r of rows) {
      const horas = Math.round((Date.now() - new Date(r.sent_at).getTime()) / 3600000);
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, canal, nota, fecha, estado)
         VALUES ($1,$2,$3,'seguimiento_inactivo','email',$4,NOW(),'pendiente')`,
        [r.user_id, r.contact_id, r.outbound_client_id,
         `Sin respuesta hace ${horas}h${r.asunto ? ` a "${r.asunto}"` : ''} — considera escribirle o llamarlo`]
      );
    }
    if (rows.length) console.log(`[followup-watcher] ${rows.length} recordatorio(s) de inactividad creado(s)`);
  } catch (e) {
    console.warn('[followup-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startFollowupWatcher(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 60 * 60 * 1000);
  _timer.unref?.();
  tick(pool);
  console.log('[followup-watcher] started (tick 60min)');
}

module.exports = { startFollowupWatcher, tick };
