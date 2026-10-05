// ─────────────────────────────────────────────────────────────────────
// Recordatorios de reunión — 2 avisos al prospecto (día anterior 10:00 y 30 min antes,
// en la hora DEL PROSPECTO), por email (buzón del cliente, con CC) o WhatsApp, a elección.
// Modo 'auto': el watcher los envía solo. Modo 'revision': deja una tarea en "Hoy" con el
// mensaje listo y se envía con un clic desde la ficha. El enlace/lugar puede ir vacío
// (cuando el cliente lo maneja desde su buzón): la línea simplemente se omite.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let _timer = null, _running = false;

function _offset(ts, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}
// 'YYYY-MM-DDTHH:mm' interpretado en la zona tz → Date UTC
function zonedToUtc(local, tz) {
  const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let g = base;
  for (let i = 0; i < 2; i++) g = base - _offset(g, tz);
  return new Date(g);
}
function _fmt(date, tz, lang) {
  const loc = lang === 'en' ? 'en-US' : 'es-ES';
  const d = new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const h = new Intl.DateTimeFormat(loc, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: lang === 'en' }).format(date);
  const z = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || '';
  return { dia: d, hora: h, zona: z };
}
const _LUGAR = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', telefono: 'Teléfono', presencial: 'Presencial', otro: '' };

// Mensaje por defecto (editable). n = 1 (día anterior) | 2 (30 min antes).
function defaultMessage(m, contactName, n) {
  const lang = m.idioma === 'en' ? 'en' : 'es';
  const f = _fmt(new Date(m.starts_at), m.tz, lang);
  const nom = String(contactName || '').split(' ')[0] || '';
  const enlace = String(m.enlace || '').trim();
  const lugar = lang === 'en' && m.tipo === 'telefono' ? 'Phone' : lang === 'en' && m.tipo === 'presencial' ? 'In person' : (_LUGAR[m.tipo] || '');
  const host = String(m.anfitrion || '').trim();
  if (lang === 'en') {
    const lines = n === 1
      ? [`Hi ${nom},`, '', `Just a quick reminder of our meeting tomorrow, ${f.dia} at ${f.hora} (${f.zona}).`]
      : [`Hi ${nom},`, '', `Our meeting starts in 30 minutes (${f.hora} ${f.zona}).`];
    if (host) lines.push(n === 1 ? `${host} will be joining you.` : '');
    if (enlace) lines.push(`${lugar ? lugar + ': ' : 'Link: '}${enlace}`); else if (lugar) lines.push(`Where: ${lugar}`);
    lines.push('', n === 1 ? 'See you tomorrow!' : 'See you soon!');
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim();
  }
  const lines = n === 1
    ? [`Hola ${nom},`, '', `Te recuerdo nuestra reunión de mañana, ${f.dia} a las ${f.hora} (${f.zona}).`]
    : [`Hola ${nom},`, '', `Nuestra reunión empieza en 30 minutos (${f.hora} ${f.zona}).`];
  if (host) lines.push(n === 1 ? `Te atenderá ${host}.` : '');
  if (enlace) lines.push(`${lugar ? lugar + ': ' : 'Enlace: '}${enlace}`); else if (lugar) lines.push(`Lugar: ${lugar}`);
  lines.push('', n === 1 ? '¡Nos vemos mañana!' : '¡Nos vemos en un momento!');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim();
}
function defaultSubject(m, n) {
  return m.idioma === 'en'
    ? (n === 1 ? 'Reminder: our meeting tomorrow' : 'Our meeting starts in 30 minutes')
    : (n === 1 ? 'Recordatorio: nuestra reunión de mañana' : 'Nuestra reunión empieza en 30 minutos');
}

// Horas de los dos avisos a partir de la reunión. Aviso 1: día anterior 10:00 (hora del prospecto).
function computeReminderTimes(startsAt, tz) {
  const start = new Date(startsAt);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start); // YYYY-MM-DD local
  const prev = new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7) - 1, +p.slice(8, 10)) - 86400000);
  const prevStr = prev.toISOString().slice(0, 10);
  return { rem1_at: zonedToUtc(`${prevStr}T10:00`, tz), rem2_at: new Date(start.getTime() - 30 * 60000) };
}

async function _contactCtx(pool, m) {
  const { rows: [k] } = await pool.query(`SELECT id, nombre, apellido, email, outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [m.contact_id, m.user_id]);
  return k;
}

// Envía el recordatorio n por el canal elegido. Lanza Error con mensaje claro si no se puede.
async function sendReminder(pool, m, n) {
  const k = await _contactCtx(pool, m);
  if (!k) throw new Error('Contacto no encontrado');
  const texto = (n === 1 ? m.msg1 : m.msg2) || defaultMessage(m, k.nombre, n);
  const asunto = defaultSubject(m, n);
  if (m.canal === 'whatsapp') {
    const { rows: [lk] } = await pool.query(
      `SELECT l.connection_id, l.chat_jid FROM wa_jid_links l JOIN wa_connections c ON c.id=l.connection_id AND c.estado='conectado'
        WHERE l.contact_id=$1 ORDER BY l.created_at DESC LIMIT 1`, [k.id]);
    if (!lk) throw new Error('Este contacto no tiene un WhatsApp conectado y vinculado. Usa email o vincula su chat primero.');
    await require('./waService').enviar(pool, lk.connection_id, lk.chat_jid, texto);
  } else {
    if (!k.email) throw new Error('El contacto no tiene email');
    const { rows: [mb] } = await pool.query(
      `SELECT * FROM lm_mailboxes WHERE user_id=$1 AND outbound_client_id=$2 AND estado IN ('conectado','solo_envio') ORDER BY id LIMIT 1`, [m.user_id, k.outbound_client_id]);
    if (!mb) throw new Error('El cliente de este contacto no tiene buzón conectado');
    const mailboxSvc = require('./mailboxService');
    const auth = await mailboxSvc.getMailboxAuth(pool, mb);
    const cc = String(m.cc || '').split(/[,;]/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@'));
    if (mb.cc_email && !cc.includes(String(mb.cc_email).toLowerCase())) cc.push(String(mb.cc_email).toLowerCase());
    const sent = await mailboxSvc.sendFromMailbox(mb, auth, { to: k.email, cc: cc.length ? cc.join(', ') : undefined, subject: asunto, text: texto, fromName: mb.from_name || undefined });
    await pool.query(
      `INSERT INTO lm_messages (user_id, contact_id, asunto, cuerpo, to_email, estado, sent_at, mailbox_id, smtp_message_id, cc_emails, track_token)
       VALUES ($1,$2,$3,$4,$5,'sent',NOW(),$6,$7,$8,$9)`,
      [m.user_id, k.id, asunto, texto, k.email, mb.id, sent.messageId || '', cc.join(', '), crypto.randomBytes(12).toString('hex')]);
  }
  await pool.query(`UPDATE lm_meetings SET rem${n}_estado='enviado', rem${n}_sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [m.id]);
  await pool.query(`UPDATE activities SET estado='hecha' WHERE contact_id=$1 AND user_id=$2 AND tipo='tarea' AND estado='pendiente' AND nota LIKE $3`, [k.id, m.user_id, `[Reunión #${m.id}·${n}]%`]);
  await pool.query(
    `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, canal, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,$5,NOW(),'hecha')`,
    [m.user_id, k.id, k.outbound_client_id || null, m.canal === 'whatsapp' ? 'whatsapp' : 'email', `Recordatorio de reunión enviado (${n === 1 ? 'día anterior' : '30 min antes'}) por ${m.canal === 'whatsapp' ? 'WhatsApp' : 'email'}`]);
}

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    for (const n of [1, 2]) {
      const { rows } = await pool.query(
        `SELECT * FROM lm_meetings WHERE estado='programada' AND starts_at > NOW() AND rem${n}_estado='pendiente' AND rem${n}_at <= NOW()
          AND rem${n}_at > NOW() - INTERVAL '3 hours' LIMIT 50`);
      for (const m of rows) {
        try {
          if (m.modo === 'auto') await sendReminder(pool, m, n);
          else {
            const k = await _contactCtx(pool, m);
            await pool.query(
              `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'tarea',$4,NOW(),'pendiente')`,
              [m.user_id, m.contact_id, k?.outbound_client_id || null,
               `[Reunión #${m.id}·${n}] Enviar recordatorio de reunión (${n === 1 ? 'día anterior' : '30 min antes'})`]);
            await pool.query(`UPDATE lm_meetings SET rem${n}_estado='tarea', updated_at=NOW() WHERE id=$1`, [m.id]);
          }
        } catch (e) {
          await pool.query(`UPDATE lm_meetings SET rem${n}_estado='error', error=$2, updated_at=NOW() WHERE id=$1`, [m.id, String(e.message).slice(0, 300)]).catch(() => {});
          console.warn('[meeting-reminders]', m.id, n, e.message);
        }
      }
    }
    // Aviso vencido sin enviar (ventana de 3h pasada) → se marca omitido
    await pool.query(`UPDATE lm_meetings SET rem1_estado='omitido' WHERE rem1_estado='pendiente' AND rem1_at <= NOW() - INTERVAL '3 hours'`);
    await pool.query(`UPDATE lm_meetings SET rem2_estado='omitido' WHERE rem2_estado='pendiente' AND (starts_at <= NOW() OR rem2_at <= NOW() - INTERVAL '3 hours')`);
  } catch (e) { console.warn('[meeting-reminders] tick:', e.message); }
  finally { _running = false; }
}

function startMeetingReminders(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), 60 * 1000);
  _timer.unref?.();
  tick(pool);
  console.log('[meeting-reminders] started (tick 60s)');
}

// Hora recomendada para cada aviso, según cuánto falte. Aviso 1: día anterior 10:00 del prospecto; si eso ya pasó,
// la mañana del mismo día (08:00) si da tiempo; si tampoco, ahora mismo (si faltan >3 h); si no, se omite.
// nota1: '' | 'manana' | 'ahora' | 'omitido' (para explicarlo en pantalla).
function recommendTimes(startsAt, tz, now = Date.now()) {
  const start = new Date(startsAt);
  const base = computeReminderTimes(start, tz);
  let rem1_at = base.rem1_at, nota1 = '';
  if (!(rem1_at && rem1_at.getTime() > now + 10 * 60000)) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
    const manana = zonedToUtc(p + 'T08:00', tz);
    if (manana && manana.getTime() > now + 10 * 60000 && start.getTime() - manana.getTime() >= 90 * 60000) { rem1_at = manana; nota1 = 'manana'; }
    else if (start.getTime() - now > 3 * 3600000) { rem1_at = new Date(now + 10 * 60000); nota1 = 'ahora'; }
    else { rem1_at = null; nota1 = 'omitido'; }
  }
  return { rem1_at, rem2_at: base.rem2_at, nota1 };
}

module.exports = { startMeetingReminders, tick, sendReminder, defaultMessage, defaultSubject, computeReminderTimes, recommendTimes, zonedToUtc };
