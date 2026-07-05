// ─────────────────────────────────────────────────────────────────────
// Daily Report — reporte diario de outreach (LM Fase A)
//
// Corre cada 10 min; a las 07:00 hora local del workspace (si aún no hay
// reporte de hoy) genera el resumen de AYER + lo que toca HOY:
//   · enviados / aperturas / clics / respuestas de ayer
//   · quiénes respondieron (con extracto)
//   · emails programados y tareas manuales de hoy
//   · alertas: fallos de envío, enrolamientos pausados por email inválido
// Se guarda en lm_daily_reports (data JSONB) y se envía por SES
// (transaccional — el outreach va por Gmail, esto es notificación interna).
// ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

function _localParts(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/Lima', hour: 'numeric', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const g = t => p.find(x => x.type === t)?.value;
    const hour = parseInt(g('hour') ?? '12');
    return { hour: hour === 24 ? 0 : hour, date: `${g('year')}-${g('month')}-${g('day')}` };
  } catch { return { hour: 12, date: new Date().toISOString().slice(0, 10) }; }
}

async function _buildReport(pool, uid, tz) {
  const T = tz || 'America/Lima';
  const [sentQ, opensQ, clicksQ, repliesQ, dueQ, tasksQ, failedQ, pausedQ] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM lm_messages
       WHERE user_id=$1 AND estado IN ('sent','replied','bounced')
         AND (sent_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1`, [uid, T]),
    pool.query(`SELECT COUNT(DISTINCT e.message_id)::int AS n FROM lm_message_events e
       JOIN lm_messages m ON m.id=e.message_id
       WHERE m.user_id=$1 AND e.tipo='open'
         AND (e.created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1`, [uid, T]),
    pool.query(`SELECT COUNT(*)::int AS n FROM lm_message_events e
       JOIN lm_messages m ON m.id=e.message_id
       WHERE m.user_id=$1 AND e.tipo='click'
         AND (e.created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1`, [uid, T]),
    pool.query(`SELECT m.asunto, m.replied_at, k.nombre, k.apellido, k.empresa_nombre,
                       co.nombre AS company_nombre,
                       (SELECT e.url FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='reply'
                         ORDER BY e.created_at DESC LIMIT 1) AS snippet
       FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id
       LEFT JOIN lm_companies co ON co.id=k.company_id
       WHERE m.user_id=$1 AND m.estado='replied'
         AND (m.replied_at AT TIME ZONE $2)::date >= (NOW() AT TIME ZONE $2)::date - 1
       ORDER BY m.replied_at DESC LIMIT 15`, [uid, T]),
    pool.query(`SELECT COUNT(*)::int AS n FROM lm_contact_sequences cs
       JOIN sequences s ON s.id=cs.sequence_id AND s.estado='activa'
       WHERE cs.user_id=$1 AND cs.estado='activo'
         AND (cs.next_action_at IS NULL OR cs.next_action_at <= NOW() + interval '24 hours')`, [uid]),
    pool.query(`SELECT a.canal, a.nota, k.nombre, k.apellido FROM activities a
       JOIN lm_contacts k ON k.id=a.contact_id
       WHERE a.user_id=$1 AND a.estado='pendiente' ORDER BY a.fecha ASC LIMIT 15`, [uid]),
    pool.query(`SELECT COUNT(*)::int AS n FROM lm_messages
       WHERE user_id=$1 AND estado='failed'
         AND (created_at AT TIME ZONE $2)::date >= (NOW() AT TIME ZONE $2)::date - 1`, [uid, T]),
    pool.query(`SELECT COUNT(*)::int AS n FROM lm_contact_sequences
       WHERE user_id=$1 AND estado='pausado' AND paused_reason LIKE 'email_%'`, [uid]),
  ]);
  return {
    ayer: {
      enviados: sentQ.rows[0].n, aperturas: opensQ.rows[0].n,
      clics: clicksQ.rows[0].n, respuestas: repliesQ.rows.length,
    },
    respuestas: repliesQ.rows.map(r => ({
      quien: `${r.nombre || ''} ${r.apellido || ''}`.trim(),
      empresa: r.company_nombre || r.empresa_nombre || '',
      asunto: r.asunto, extracto: (r.snippet || '').slice(0, 200),
    })),
    hoy: { programados: dueQ.rows[0].n, tareas: tasksQ.rows },
    alertas: { fallos: failedQ.rows[0].n, pausados_email: pausedQ.rows[0].n },
  };
}

function _reportHtml(data, fecha) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stat = (n, lbl) =>
    `<td style="padding:12px 16px;text-align:center"><div style="font-size:26px;font-weight:700;color:#0b1e3a">${n}</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">${lbl}</div></td>`;
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e">
    <div style="background:#0b1e3a;border-radius:12px 12px 0 0;padding:18px 24px">
      <span style="color:#c7f04c;font-weight:700;font-size:15px">Nova · Lead Manager</span>
      <span style="color:#9ca3af;font-size:12px;float:right">${fecha}</span>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px 24px">
      <h2 style="margin:0 0 4px;font-size:16px;color:#00804C">Reporte diario de outreach</h2>
      <p style="margin:0 0 14px;font-size:12px;color:#6b7280">Lo que pasó ayer y lo que toca hoy.</p>
      <table style="width:100%;border-collapse:collapse;background:#f6f8f4;border-radius:10px"><tr>
        ${stat(data.ayer.enviados, 'Enviados')}${stat(data.ayer.aperturas, 'Aperturas')}
        ${stat(data.ayer.clics, 'Clics')}${stat(data.ayer.respuestas, 'Respuestas')}
      </tr></table>`;
  if (data.respuestas.length) {
    html += `<h3 style="font-size:13px;margin:18px 0 8px;color:#0b1e3a">💬 Respondieron</h3>`;
    for (const r of data.respuestas) {
      html += `<div style="border-left:3px solid #00804C;padding:6px 12px;margin:6px 0;background:#fafbf9">
        <strong style="font-size:13px">${esc(r.quien)}</strong> <span style="color:#6b7280;font-size:12px">· ${esc(r.empresa)}</span>
        ${r.extracto ? `<div style="font-size:12px;color:#4b5563;margin-top:2px">"${esc(r.extracto)}"</div>` : ''}</div>`;
    }
  }
  html += `<h3 style="font-size:13px;margin:18px 0 8px;color:#0b1e3a">📅 Hoy</h3>
    <p style="font-size:13px;margin:0 0 6px">${data.hoy.programados} emails programados en las próximas 24 h.</p>`;
  if (data.hoy.tareas.length) {
    html += `<ul style="font-size:12px;color:#4b5563;margin:4px 0;padding-left:18px">` +
      data.hoy.tareas.slice(0, 10).map(t =>
        `<li><b>${esc(t.canal || 'tarea')}</b> — ${esc(t.nombre)} ${esc(t.apellido)}: ${esc((t.nota || '').slice(0, 90))}</li>`).join('') + `</ul>`;
  }
  if (data.alertas.fallos || data.alertas.pausados_email) {
    html += `<div style="background:#fef2f2;border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#991b1b">
      ⚠ ${data.alertas.fallos ? `${data.alertas.fallos} envíos fallidos. ` : ''}${data.alertas.pausados_email ? `${data.alertas.pausados_email} contactos pausados por email inválido/sin verificar.` : ''}</div>`;
  }
  html += `<p style="margin:18px 0 0;font-size:11px;color:#9ca3af">Nova · Kiwoc — reporte automático del Lead Manager.</p></div></div>`;
  return html;
}

async function _emailReport(pool, uid, data, fecha) {
  if (!process.env.SES_FROM_EMAIL || !process.env.AWS_ACCESS_KEY_ID) return false;
  const { rows: [u] } = await pool.query(`SELECT email FROM users WHERE id=$1`, [uid]);
  if (!u?.email) return false;
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const ses = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  await ses.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: { ToAddresses: [u.email] },
    Message: {
      Subject: { Data: `📊 Outreach ${fecha}: ${data.ayer.enviados} enviados · ${data.ayer.respuestas} respuestas` },
      Body: { Html: { Data: _reportHtml(data, fecha) },
              Text: { Data: `Ayer: ${data.ayer.enviados} enviados, ${data.ayer.aperturas} aperturas, ${data.ayer.respuestas} respuestas. Hoy: ${data.hoy.programados} programados.` } },
    },
  }));
  return true;
}

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    // Workspaces con settings (aunque el envío esté OFF, el reporte sirve si hubo actividad)
    const { rows: configs } = await pool.query(`SELECT user_id, timezone FROM lm_send_settings`);
    for (const cfg of configs) {
      try {
        const { hour, date } = _localParts(cfg.timezone);
        if (hour < 7) continue; // aún no son las 7 locales
        const { rows: [ex] } = await pool.query(
          `SELECT 1 FROM lm_daily_reports WHERE user_id=$1 AND fecha=$2`, [cfg.user_id, date]);
        if (ex) continue; // ya generado hoy
        const data = await _buildReport(pool, cfg.user_id, cfg.timezone);
        const emailed = await _emailReport(pool, cfg.user_id, data, date).catch(e => {
          console.warn('[daily-report] email:', e.message); return false;
        });
        await pool.query(
          `INSERT INTO lm_daily_reports (user_id, fecha, data, emailed) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, fecha) DO NOTHING`,
          [cfg.user_id, date, JSON.stringify(data), emailed]);
        console.log(`[daily-report] generado para ws=${cfg.user_id} (${date})${emailed ? ' + email' : ''}`);
      } catch (e) { console.warn(`[daily-report] ws ${cfg.user_id}:`, e.message); }
    }
  } catch (e) {
    console.warn('[daily-report] tick:', e.message);
  } finally { _running = false; }
}

function startDailyReport(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 10 * 60 * 1000);
  _timer.unref?.();
  console.log('[daily-report] started (tick 10min, genera a las 07:00 locales)');
}

module.exports = { startDailyReport, tick, _buildReport };
