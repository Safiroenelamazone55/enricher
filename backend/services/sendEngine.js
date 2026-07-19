// ─────────────────────────────────────────────────────────────────────
// Send Engine — motor de envío automático de secuencias (LM Fase A)
//
// Worker in-process (setInterval 60s). Por cada workspace con envío activado:
//   1. Respeta ventana horaria (timezone local), fin de semana, límite diario
//      y throttle entre envíos. Máx 1 email por workspace por tick.
//   2. Toma el enrolamiento activo más atrasado (next_action_at <= NOW).
//   3. Paso 'email'  → renderiza plantilla, agrega tracking, envía por Gmail.
//      Paso manual   → crea activity pendiente (LinkedIn/llamada/tarea) y avanza.
//   4. NUNCA envía a un contacto con email vacío, sin verificar o inválido:
//      pausa el enrolamiento con paused_reason y crea tarea manual.
//
// Estado persiste en DB (next_action_at): si PM2 reinicia, retoma solo.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

let _timer = null;
let _running = false;

// Estados de verificación con los que SÍ se permite enviar.
// 'manual' = email ingresado/confirmado a mano por la usuaria (se confía sin sonda SMTP).
const SENDABLE_STATUS = ['valid', 'catch-all', 'risky', 'manual'];

// ── A/B: selección de variante — MISMA regla determinista que el frontend ──
// (random: (contact_id + step_id) % n · segment: match de variant_field en targets)
// Así la variante que Jenny ve en la tarea manual y la que envía el motor coinciden.
function stepVariants(st) {
  const v = Array.isArray(st.variants) ? st.variants.filter(x => x && ((x.cuerpo || '').trim() || (x.nombre || '').trim())) : [];
  if (v.length) return v;
  return [{ nombre: 'A', cuerpo: st.plantilla || '', targets: [] }];
}
function pickVariant(st, ctx) {
  const vars = stepVariants(st);
  if (vars.length <= 1) return vars[0];
  const mode = st.variant_mode || 'off';
  if (mode === 'segment' && st.variant_field) {
    const val = String(ctx[st.variant_field] || '').toLowerCase().trim();
    const hit = vars.find(v => (Array.isArray(v.targets) ? v.targets : []).some(t => String(t).toLowerCase().trim() === val));
    return hit || vars[0];
  }
  if (mode === 'random') return vars[Math.abs((ctx.contact_id || 0) + (st.id || 0)) % vars.length];
  return vars[0];
}

// ── Render de plantillas: {{first_name}}, {{company}}, {{title}}, … ──
function renderTemplate(str, ctx) {
  const map = {
    first_name: ctx.nombre, last_name: ctx.apellido,
    full_name:  [ctx.nombre, ctx.apellido].filter(Boolean).join(' '),
    email:      ctx.email,  title: ctx.cargo,
    company:    ctx.company_nombre || ctx.empresa_nombre,
    city:       ctx.ciudad, country: ctx.pais,
    // alias en español (mismas variables)
    nombre: ctx.nombre, apellido: ctx.apellido, cargo: ctx.cargo,
    empresa: ctx.company_nombre || ctx.empresa_nombre, ciudad: ctx.ciudad, pais: ctx.pais,
  };
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    const v = map[k.toLowerCase()];
    return (v == null || v === '') ? '' : String(v);
  });
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Texto plano → HTML: escapa, enlaza URLs (con tracking opcional) y respeta saltos.
function buildHtml({ text, firma, trackToken, apiBase, trackOpens, trackClicks }) {
  let html = _esc(text);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    const href = trackClicks
      ? `${apiBase}/t/c/${trackToken}?url=${encodeURIComponent(url)}`
      : url;
    return `<a href="${href}" style="color:#00804C">${url}</a>`;
  });
  html = html.replace(/\n/g, '<br>');
  let out = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a2e">${html}`;
  if (firma) out += `<br><br>${firma.includes('<') ? firma : _esc(firma).replace(/\n/g, '<br>')}`;
  out += '</div>';
  if (trackOpens) out += `<img src="${apiBase}/t/o/${trackToken}.png" width="1" height="1" alt="" style="display:none">`;
  return out;
}

// Hora y día actuales en el timezone del workspace.
const _WDX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function _localNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Lima', hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date());
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '12');
    const wd   = parts.find(p => p.type === 'weekday')?.value || 'Mon';
    return { hour: hour === 24 ? 0 : hour, weekend: wd === 'Sat' || wd === 'Sun', wdIdx: _WDX[wd] ?? 0 };
  } catch { return { hour: 12, weekend: false, wdIdx: 0 }; }
}
// ── Días de cadencia permitidos (Lun→Dom, '1'=permitido) ──
function _sanSendDays(v) { const s = String(v || ''); return (/^[01]{7}$/.test(s) && s.includes('1')) ? s : '1111100'; }
function _todayUTC() { const t = new Date(); return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); }
function _rollFwd(d, mask) { const x = new Date(d.getTime()); for (let i = 0; i < 7; i++) { if (mask[(x.getUTCDay() + 6) % 7] === '1') return x; x.setUTCDate(x.getUTCDate() + 1); } return x; }

// Días de espera hasta el próximo paso (espera_dias relativo > diff de 'dia' absoluto).
function _delayDays(cur, next) {
  if (!next) return 0;
  if (next.espera_dias > 0) return next.espera_dias;
  const diff = (next.dia || 1) - (cur?.dia || 1);
  if (diff > 0) return diff;
  return next.canal === 'email' ? 3 : 0; // sin datos: 3 días entre emails, mismo día para tareas
}

async function _pauseEnrollment(pool, enr, reason, taskNote) {
  await pool.query(
    `UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$1 WHERE id=$2`,
    [reason, enr.enr_id]
  );
  if (taskNote) {
    await pool.query(
      `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,'tarea','', $3, NOW(), 'pendiente')`,
      [enr.user_id, enr.contact_id, taskNote]
    );
  }
}

async function _advance(pool, enr, steps, curIdx) {
  const next = steps[curIdx + 1];
  if (!next) {
    await pool.query(
      `UPDATE lm_contact_sequences SET estado='terminado', next_action_at=NULL WHERE id=$1`,
      [enr.enr_id]
    );
    return;
  }
  const days = _delayDays(steps[curIdx], next);
  const mask = _sanSendDays(enr.send_days);
  // fecha base = hoy + days, rodada al próximo día de cadencia permitido
  const base = _todayUTC(); base.setUTCDate(base.getUTCDate() + days);
  const target = _rollFwd(base, mask);
  await pool.query(
    `UPDATE lm_contact_sequences SET paso=$1, next_action_at=$2, paso_date=CURRENT_DATE WHERE id=$3`,
    [curIdx + 2, target.toISOString(), enr.enr_id]
  );
}

// Procesa UN workspace: devuelve true si envió un email (para logging).
async function _tickWorkspace(pool, cfg, apiBase, gmailCallback) {
  const uid = cfg.user_id;
  const { hour, weekend, wdIdx } = _localNow(cfg.timezone);
  if (hour < cfg.window_start || hour >= cfg.window_end) return false;
  if (weekend && !cfg.send_weekends) return false;

  // Límite diario (día local del workspace)
  const { rows: [cnt] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM lm_messages
      WHERE user_id=$1 AND estado IN ('sent','replied','bounced')
        AND (sent_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date`,
    [uid, cfg.timezone || 'America/Lima']
  );
  if (cnt.n >= cfg.daily_limit) return false;

  // Throttle: espacio mínimo entre envíos
  const { rows: [last] } = await pool.query(
    `SELECT MAX(sent_at) AS at FROM lm_messages WHERE user_id=$1 AND sent_at IS NOT NULL`, [uid]
  );
  if (last?.at && (Date.now() - new Date(last.at).getTime()) < cfg.throttle_seconds * 1000) return false;

  // Enrolamiento más atrasado que ya toca (NULL = recién enrolado, también toca).
  // Solo secuencias ACTIVAS: pausar la secuencia detiene todos sus envíos.
  const { rows: [enr] } = await pool.query(`
    SELECT cs.id AS enr_id, cs.user_id, cs.contact_id, cs.sequence_id, cs.paso,
           k.nombre, k.apellido, k.email, k.cargo, k.empresa_nombre, k.ciudad, k.pais,
           k.seniority, k.departamento, k.buyer_role, k.region, k.contact_priority,
           k.email_status, k.disposition, co.nombre AS company_nombre, s.nombre AS seq_nombre, s.send_days,
           s.send_mode, s.send_interval_min
      FROM lm_contact_sequences cs
      JOIN sequences   s  ON s.id = cs.sequence_id AND s.estado = 'activa'
      JOIN lm_contacts k  ON k.id = cs.contact_id
      LEFT JOIN lm_companies co ON co.id = k.company_id
     WHERE cs.user_id = $1 AND cs.estado = 'activo'
       AND (cs.next_action_at IS NULL OR cs.next_action_at <= NOW())
       -- Modo de envío: 'manual' = la secuencia se maneja externamente, el motor NO la toca.
       AND s.send_mode IN ('auto','preaprobado')
       -- Intervalo anti-ráfaga POR SECUENCIA: espera N min desde el último envío de esta secuencia.
       AND NOT EXISTS (
            SELECT 1 FROM lm_messages mi
             WHERE mi.sequence_id = s.id AND mi.sent_at IS NOT NULL
               AND mi.sent_at > NOW() - make_interval(mins => GREATEST(COALESCE(s.send_interval_min,5),1))
           )
       -- Límite diario POR SECUENCIA (buzón del cliente): si esta secuencia ya llegó a su tope hoy,
       -- se salta y el motor sigue con las demás. 0 = sin límite propio (aplica solo el global).
       AND (COALESCE(s.daily_limit, 0) <= 0 OR (
            SELECT COUNT(*) FROM lm_messages m
             WHERE m.sequence_id = s.id AND m.estado IN ('sent','replied','bounced')
               AND (m.sent_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
           ) < s.daily_limit)
     ORDER BY cs.next_action_at ASC NULLS FIRST
     LIMIT 1
  `, [uid, cfg.timezone || 'America/Lima']);
  if (!enr) return false;

  // Días de cadencia de la secuencia: si hoy no es día permitido, reprograma al próximo día permitido.
  const seqMask = _sanSendDays(enr.send_days);
  if (seqMask[wdIdx] !== '1') {
    const base = _todayUTC(); base.setUTCDate(base.getUTCDate() + 1); // desde mañana → garantiza día futuro
    const nextDay = _rollFwd(base, seqMask);
    await pool.query(`UPDATE lm_contact_sequences SET next_action_at=$1 WHERE id=$2`, [nextDay.toISOString(), enr.enr_id]);
    return false;
  }

  // Opt-out / no contactar: nunca tocar.
  if (['no_contactar', 'no_interesado'].includes(enr.disposition)) {
    await _pauseEnrollment(pool, enr, 'disposition_' + enr.disposition, null);
    return false;
  }

  const { rows: steps } = await pool.query(
    `SELECT id, dia, canal, titulo, plantilla, espera_dias, variants, variant_mode, variant_field
       FROM sequence_steps WHERE sequence_id=$1 ORDER BY dia ASC, orden ASC, id ASC`,
    [enr.sequence_id]
  );
  const curIdx = (enr.paso || 1) - 1;
  const step = steps[curIdx];
  if (!step) { // sin pasos restantes → terminado
    await pool.query(`UPDATE lm_contact_sequences SET estado='terminado', next_action_at=NULL WHERE id=$1`, [enr.enr_id]);
    return false;
  }

  // ── Paso manual (linkedin / call / task / whatsapp): crear tarea y avanzar ──
  if (step.canal !== 'email') {
    const LBL = { linkedin: 'LinkedIn', call: 'Llamada', task: 'Tarea', whatsapp: 'WhatsApp' };
    await pool.query(
      `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,'tarea',$3,$4,NOW(),'pendiente')`,
      [uid, enr.contact_id, step.canal,
       `[${enr.seq_nombre} · paso ${enr.paso}] ${LBL[step.canal] || step.canal}: ${renderTemplate(step.titulo, enr) || 'seguimiento'}`]
    );
    await _advance(pool, enr, steps, curIdx);
    return false;
  }

  // ── Paso email: guardas de verificación (el diferenciador) ──
  if (!enr.email) {
    await _pauseEnrollment(pool, enr, 'sin_email',
      `[${enr.seq_nombre}] Contacto sin email — verificar/enriquecer para reanudar`);
    return false;
  }
  if (!SENDABLE_STATUS.includes(enr.email_status)) {
    const reason = enr.email_status === 'invalid' ? 'email_invalido'
                 : enr.email_status === ''        ? 'email_no_verificado'
                 : 'email_' + enr.email_status;
    await _pauseEnrollment(pool, enr, reason,
      `[${enr.seq_nombre}] Email de ${enr.nombre || enr.email} ${enr.email_status === 'invalid' ? 'inválido' : 'sin verificar'} — revisar para reanudar`);
    return false;
  }

  // Personalización con IA: si hay un borrador APROBADO para este contacto+paso, se usa
  // en vez de la plantilla (el diferenciador premium — Fable 5/Haiku ya lo redactó).
  let asunto, cuerpoTxt;
  const { rows: [aiDraft] } = await pool.query(
    `SELECT asunto, cuerpo FROM lm_ai_drafts
      WHERE user_id=$1 AND contact_id=$2 AND step_id=$3 AND status='approved'
      ORDER BY updated_at DESC LIMIT 1`,
    [uid, enr.contact_id, step.id]
  );
  let variantName = '';
  if (aiDraft && (aiDraft.asunto || aiDraft.cuerpo)) {
    // El borrador ya viene personalizado con datos reales; render por si quedó alguna variable.
    asunto    = renderTemplate(aiDraft.asunto, enr) || `(${enr.seq_nombre} — paso ${enr.paso})`;
    cuerpoTxt = renderTemplate(aiDraft.cuerpo, enr);
    variantName = 'IA';
  } else {
    // A/B: elegir variante (misma regla que el frontend) y registrarla para medir conversión.
    const variant = pickVariant(step, enr);
    const multi = stepVariants(step).length > 1;
    asunto    = renderTemplate(step.titulo, enr) || `(${enr.seq_nombre} — paso ${enr.paso})`;
    cuerpoTxt = renderTemplate((variant && variant.cuerpo) || step.plantilla, enr);
    variantName = multi ? String(variant.nombre || 'A') : '';
  }
  const token = crypto.randomBytes(12).toString('hex');

  // ── Modo PRE-APROBADO: el motor deja el email redactado como borrador y espera.
  // Al aprobarlo (o editarlo y aprobarlo) en la UI, _flushApproved lo envía y avanza.
  if (enr.send_mode === 'preaprobado') {
    const { rows: [waiting] } = await pool.query(
      `SELECT id FROM lm_messages WHERE user_id=$1 AND contact_id=$2 AND step_id=$3 AND estado IN ('awaiting','approved') LIMIT 1`,
      [uid, enr.contact_id, step.id]
    );
    if (!waiting) {
      const { rows: [mbq] } = await pool.query(
        `SELECT mb.id FROM lm_mailboxes mb JOIN sequences s ON s.outbound_client_id = mb.outbound_client_id AND s.user_id = mb.user_id
          WHERE s.id=$1 AND mb.user_id=$2 AND mb.estado IN ('conectado','solo_envio') LIMIT 1`, [enr.sequence_id, uid]);
      await pool.query(
        `INSERT INTO lm_messages (user_id, contact_id, sequence_id, step_id, asunto, cuerpo, to_email, estado, track_token, variant, mailbox_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting',$8,$9,$10)`,
        [uid, enr.contact_id, enr.sequence_id, step.id, asunto, cuerpoTxt, enr.email, token, variantName, mbq ? mbq.id : null]
      );
      console.log(`[send-engine] borrador por aprobar → ${enr.email} (${enr.seq_nombre} paso ${enr.paso})`);
    }
    // Patear el enrolamiento para no bloquear el pick del workspace; reintenta luego
    // por si el borrador se descarta sin avanzar. El envío real ocurre al aprobar.
    await pool.query(`UPDATE lm_contact_sequences SET next_action_at = NOW() + interval '12 hours' WHERE id=$1`, [enr.enr_id]);
    return false;
  }

  const html = buildHtml({
    text: cuerpoTxt, firma: cfg.firma, trackToken: token, apiBase,
    trackOpens: cfg.track_opens, trackClicks: cfg.track_clicks,
  });

  // ── Buzón del cliente (F2): si la secuencia pertenece a un cliente con buzón
  // conectado, el envío sale por SU buzón (SMTP). Sin buzón → Gmail del workspace.
  const { rows: [mbx] } = await pool.query(
    `SELECT mb.* FROM lm_mailboxes mb
      JOIN sequences s ON s.outbound_client_id = mb.outbound_client_id AND s.user_id = mb.user_id
     WHERE s.id = $1 AND mb.user_id = $2 AND mb.estado IN ('conectado','solo_envio')
     LIMIT 1`,
    [enr.sequence_id, uid]
  );

  const { rows: [msg] } = await pool.query(
    `INSERT INTO lm_messages (user_id, contact_id, sequence_id, step_id, asunto, cuerpo, to_email, estado, track_token, variant, mailbox_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10) RETURNING id`,
    [uid, enr.contact_id, enr.sequence_id, step.id, asunto, cuerpoTxt, enr.email, token, variantName, mbx ? mbx.id : null]
  );

  try {
    if (mbx) {
      const { decPass, sendFromMailbox } = require('./mailboxService');
      const sent = await sendFromMailbox(mbx, decPass(mbx.pass_enc), {
        to: enr.email, subject: asunto, html,
        text: cuerpoTxt + (cfg.firma ? `\n\n${cfg.firma.replace(/<[^>]+>/g, '')}` : ''),
        fromName: cfg.from_name,
      });
      await pool.query(
        `UPDATE lm_messages SET estado='sent', sent_at=NOW(), smtp_message_id=$1 WHERE id=$2`,
        [sent.messageId || '', msg.id]
      );
    } else {
      const { sendEmail } = require('./gmailService');
      const sent = await sendEmail(pool, uid, gmailCallback, {
        to: enr.email, subject: asunto, html, text: cuerpoTxt + (cfg.firma ? `\n\n${cfg.firma.replace(/<[^>]+>/g, '')}` : ''),
        fromName: cfg.from_name,
      });
      await pool.query(
        `UPDATE lm_messages SET estado='sent', sent_at=NOW(), gmail_message_id=$1, gmail_thread_id=$2 WHERE id=$3`,
        [sent.id || '', sent.threadId || '', msg.id]
      );
    }
    await pool.query( // actividad 'hecha' → alimenta métricas existentes (contactados)
      `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,'email','email',$3,NOW(),'hecha')`,
      [uid, enr.contact_id, `[${enr.seq_nombre} · paso ${enr.paso}] Email enviado: ${asunto}`]
    );
    await _advance(pool, enr, steps, curIdx);
    console.log(`[send-engine] sent → ${enr.email} (${enr.seq_nombre} paso ${enr.paso})`);
    return true;
  } catch (err) {
    const fatal = err.message === 'gmail_not_connected';
    await pool.query(`UPDATE lm_messages SET estado='failed', error=$1 WHERE id=$2`, [err.message.slice(0, 500), msg.id]);
    if (mbx && /535|auth|credentials|login/i.test(err.message)) {
      // El buzón del cliente dejó de autenticar (contraseña revocada, etc.):
      // marcarlo en el buzón para que se vea en la UI. El enrolamiento reintenta
      // en 15 min (si Jenny reconecta el buzón, retoma solo).
      await pool.query(`UPDATE lm_mailboxes SET last_error=$1 WHERE id=$2`,
        [('SMTP: ' + err.message).slice(0, 300), mbx.id]).catch(() => {});
    }
    if (fatal) {
      await _pauseEnrollment(pool, enr, 'gmail_desconectado', null);
    } else {
      // Backoff: reintenta en 15 min sin avanzar de paso (lección del 429)
      await pool.query(`UPDATE lm_contact_sequences SET next_action_at = NOW() + interval '15 minutes' WHERE id=$1`, [enr.enr_id]);
    }
    console.warn(`[send-engine] fail → ${enr.email}: ${err.message}`);
    return false;
  }
}

// ── Envíos programados (Inbox): despacha los 'scheduled' vencidos ──
// Corren FUERA de la ventana/límites del workspace: la usuaria eligió esa hora
// a propósito (p. ej. la ventana recomendada del país del prospecto).
async function _flushScheduled(pool) {
  const { rows: due } = await pool.query(`
    SELECT m.id, m.user_id, m.contact_id, m.asunto, m.cuerpo, m.to_email, m.in_reply_to, m.mailbox_id,
           mb.id AS mb_ok, mb.email AS mb_email, mb.pass_enc, mb.smtp_host, mb.smtp_port, mb.smtp_secure,
           mb.imap_host, mb.imap_port, mb.provider, mb.sent_folder, mb.estado AS mb_estado,
           cfg.from_name
      FROM lm_messages m
      LEFT JOIN lm_mailboxes mb ON mb.id = m.mailbox_id
      LEFT JOIN lm_send_settings cfg ON cfg.user_id = m.user_id
     WHERE m.estado='scheduled' AND m.scheduled_at <= NOW()
     ORDER BY m.scheduled_at ASC
     LIMIT 10
  `);
  for (const m of due) {
    try {
      if (!m.mb_ok || !['conectado', 'solo_envio'].includes(m.mb_estado)) {
        throw new Error('El buzón ya no está conectado');
      }
      const { decPass, sendFromMailbox } = require('./mailboxService');
      const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a2e">${esc(m.cuerpo).replace(/\n/g, '<br>')}</div>`;
      const mb = { id: m.mb_ok, email: m.mb_email, pass_enc: m.pass_enc, smtp_host: m.smtp_host, smtp_port: m.smtp_port,
                   smtp_secure: m.smtp_secure, imap_host: m.imap_host, imap_port: m.imap_port, provider: m.provider, sent_folder: m.sent_folder };
      const sent = await sendFromMailbox(mb, decPass(m.pass_enc), {
        to: m.to_email, subject: m.asunto, text: m.cuerpo, html,
        fromName: m.from_name || undefined,
        inReplyTo: m.in_reply_to || undefined,
        references: m.in_reply_to || undefined,
      });
      await pool.query(`UPDATE lm_messages SET estado='sent', sent_at=NOW(), smtp_message_id=$1 WHERE id=$2`,
        [sent.messageId || '', m.id]);
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
         VALUES ($1,$2,'email','email',$3,NOW(),'hecha')`,
        [m.user_id, m.contact_id, `[Inbox] Respuesta programada enviada: ${m.asunto}`]);
      console.log(`[send-engine] scheduled → ${m.to_email} ("${m.asunto}")`);
    } catch (err) {
      await pool.query(`UPDATE lm_messages SET estado='failed', error=$1 WHERE id=$2`,
        [err.message.slice(0, 500), m.id]).catch(() => {});
      console.warn(`[send-engine] scheduled fail → ${m.to_email}: ${err.message}`);
    }
  }
}

// ── Avanza un enrolamiento saltando el paso indicado (aprobación enviada o descartada) ──
async function advancePastStep(pool, userId, contactId, sequenceId, stepId) {
  const { rows: [enr] } = await pool.query(
    `SELECT cs.id AS enr_id, cs.user_id, cs.contact_id, s.send_days
       FROM lm_contact_sequences cs JOIN sequences s ON s.id = cs.sequence_id
      WHERE cs.user_id=$1 AND cs.contact_id=$2 AND cs.sequence_id=$3 AND cs.estado='activo'`,
    [userId, contactId, sequenceId]);
  if (!enr) return false;
  const { rows: steps } = await pool.query(
    `SELECT id, dia, canal, espera_dias FROM sequence_steps WHERE sequence_id=$1 ORDER BY dia ASC, orden ASC, id ASC`,
    [sequenceId]);
  const curIdx = steps.findIndex(x => x.id === stepId);
  if (curIdx < 0) return false;
  await _advance(pool, enr, steps, curIdx);
  return true;
}

// ── Envíos pre-aprobados: despacha los 'approved' respetando el intervalo por secuencia ──
async function _flushApproved(pool, apiBase) {
  const { rows: due } = await pool.query(`
    SELECT DISTINCT ON (m.sequence_id)
           m.id, m.user_id, m.contact_id, m.sequence_id, m.step_id, m.asunto, m.cuerpo, m.to_email, m.track_token,
           mb.id AS mb_ok, mb.email AS mb_email, mb.pass_enc, mb.smtp_host, mb.smtp_port, mb.smtp_secure,
           mb.imap_host, mb.imap_port, mb.provider, mb.sent_folder, mb.estado AS mb_estado,
           cfg.from_name, cfg.firma, cfg.track_opens, cfg.track_clicks
      FROM lm_messages m
      JOIN sequences s ON s.id = m.sequence_id
      LEFT JOIN lm_mailboxes mb ON mb.id = m.mailbox_id
      LEFT JOIN lm_send_settings cfg ON cfg.user_id = m.user_id
     WHERE m.estado='approved'
       AND NOT EXISTS (
            SELECT 1 FROM lm_messages mi
             WHERE mi.sequence_id = m.sequence_id AND mi.sent_at IS NOT NULL
               AND mi.sent_at > NOW() - make_interval(mins => GREATEST(COALESCE(s.send_interval_min,5),1))
           )
     ORDER BY m.sequence_id, m.created_at ASC
  `);
  for (const m of due) {
    try {
      if (!m.mb_ok || !['conectado', 'solo_envio'].includes(m.mb_estado)) throw new Error('El buzón ya no está conectado');
      const { decPass, sendFromMailbox } = require('./mailboxService');
      const html = buildHtml({
        text: m.cuerpo, firma: m.firma, trackToken: m.track_token, apiBase,
        trackOpens: !!apiBase && m.track_opens, trackClicks: !!apiBase && m.track_clicks,
      });
      const mb = { id: m.mb_ok, email: m.mb_email, pass_enc: m.pass_enc, smtp_host: m.smtp_host, smtp_port: m.smtp_port,
                   smtp_secure: m.smtp_secure, imap_host: m.imap_host, imap_port: m.imap_port, provider: m.provider, sent_folder: m.sent_folder };
      const sent = await sendFromMailbox(mb, decPass(m.pass_enc), {
        to: m.to_email, subject: m.asunto, html,
        text: m.cuerpo + (m.firma ? `\n\n${String(m.firma).replace(/<[^>]+>/g, '')}` : ''),
        fromName: m.from_name || undefined,
      });
      await pool.query(`UPDATE lm_messages SET estado='sent', sent_at=NOW(), smtp_message_id=$1 WHERE id=$2`,
        [sent.messageId || '', m.id]);
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
         VALUES ($1,$2,'email','email',$3,NOW(),'hecha')`,
        [m.user_id, m.contact_id, `[Aprobado] Email enviado: ${m.asunto}`]);
      await advancePastStep(pool, m.user_id, m.contact_id, m.sequence_id, m.step_id);
      console.log(`[send-engine] approved → ${m.to_email} ("${m.asunto}")`);
    } catch (err) {
      await pool.query(`UPDATE lm_messages SET estado='failed', error=$1 WHERE id=$2`,
        [err.message.slice(0, 500), m.id]).catch(() => {});
      console.warn(`[send-engine] approved fail → ${m.to_email}: ${err.message}`);
    }
  }
}

// ── Auto-activación por fecha: 'inicia el 5 de agosto' → ese día pasa a activa sola ──
async function _autoActivate(pool) {
  const { rows } = await pool.query(`
    UPDATE sequences SET estado='activa', updated_at=NOW()
     WHERE auto_activar AND estado IN ('draft','pausada')
       AND starts_on IS NOT NULL AND starts_on <= CURRENT_DATE
     RETURNING id, nombre`);
  for (const s of rows) console.log(`[send-engine] auto-activada: "${s.nombre}" (llegó su fecha de inicio)`);
}

async function tick(pool, apiBase, gmailCallback) {
  if (_running) return; // no solapar ticks
  _running = true;
  try {
    await _autoActivate(pool).catch(e => console.warn('[send-engine] auto-activar:', e.message));
    await _flushScheduled(pool).catch(e => console.warn('[send-engine] scheduled:', e.message));
    await _flushApproved(pool, apiBase).catch(e => console.warn('[send-engine] approved:', e.message));
    const { rows: configs } = await pool.query(`SELECT * FROM lm_send_settings WHERE enabled = TRUE`);
    for (const cfg of configs) {
      try { await _tickWorkspace(pool, cfg, apiBase, gmailCallback); }
      catch (e) { console.warn(`[send-engine] workspace ${cfg.user_id}:`, e.message); }
    }
  } catch (e) {
    console.warn('[send-engine] tick:', e.message);
  } finally { _running = false; }
}

function startSendEngine(pool, { apiBase, gmailCallback }) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool, apiBase, gmailCallback), 60 * 1000);
  _timer.unref?.();
  console.log('[send-engine] started (tick 60s)');
}

module.exports = { startSendEngine, tick, renderTemplate, buildHtml, SENDABLE_STATUS, pickVariant, stepVariants, advancePastStep };
