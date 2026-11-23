'use strict';
// LinkedIn con extensión propia: Nova decide QUÉ acción toca y CUÁNDO; la extensión (instalada en el Chrome de cada
// cuenta) la ejecuta con la sesión de ese perfil y devuelve el resultado. Todos los límites se aplican AQUÍ, en el servidor,
// no en la extensión: una extensión modificada o con un error no puede saltárselos.
//
// Cifras por defecto = guía pública de lemlist (help.lemlist.com, leída 2026-11-23): 20 invitaciones/día, ~100/semana móvil,
// 30 mensajes/día, 30 visitas/día, 100 acciones/día en total, calentamiento +2 invitaciones/día desde 5, cuentas nuevas ~50
// acciones/día, tras una restricción: parar 48 h y reiniciar en 5. LinkedIn no publica sus límites: son estimaciones.
// Confirmado en la pantalla «Límites» de una cuenta real de lemlist (2026-11-23): visitas 30, invitaciones 20, mensajes 30, InMail 5,
// seguimientos 20, retiros de invitación 30, «me gusta» 30 — todos «en 24 h» (ventana móvil, no día natural). Su planificación de envío:
// 9:00–18:00, 5 de 7 días, una acción cada 20 min. Cifras PROPIAS (conservadoras): esperas de 5–20 min y el calentamiento de mensajes/visitas.
// Cuenta gratuita de LinkedIn: 3 invitaciones con nota por mes (guía de lemlist).
const crypto = require('crypto');

const DEF = {
  inv_dia: 20, inv_semana: 100, msg_dia: 30, vis_dia: 30, inmail_dia: 5, total_dia: 100, notas_mes_gratis: 3,
  ramp_activo: true, ramp_inicio: 5, ramp_paso: 2, ramp_dias: 14, total_nuevo: 50,
  hora_ini: 9, hora_fin: 18, dias: [1, 2, 3, 4, 5], gap_min: 300, gap_max: 1200, nota_max: 200, tz: 'America/Lima',
};
const TIPOS = ['invite', 'message', 'visit', 'inmail'];
const CHEQUEOS = ['check_connections', 'check_inbox', 'check_notifications'];   // lecturas que hace la extensión para detectar aceptaciones, respuestas e interacciones
const CHEQUEO_CADA_MIN = { check_connections: 60, check_inbox: 45, check_notifications: 180 };
DEF.chequeos_dia = 30;   // «comprobaciones de red en 24 h»: el valor de la pantalla Límites de lemlist

// Configuración que viaja DESDE el servidor hacia la extensión (como hace lemlist): si LinkedIn cambia su página, se corrige aquí y
// las extensiones lo reciben solas, sin reinstalarlas. Los patrones de bloqueo son los que usa lemlist (leídos en su extensión).
const CONFIG = {
  v: 1,
  textos: {
    connect: ['connect', 'conectar'], pending: ['pending', 'pendiente'], message: ['message', 'mensaje'],
    addNote: ['add a note', 'añadir una nota', 'agregar una nota'], send: ['send', 'enviar'],
    sendNoNote: ['send without a note', 'enviar sin nota'], more: ['more', 'más'],
  },
  selectores: {
    notaTextarea: 'textarea[name="message"], textarea#custom-message, .artdeco-modal textarea',
    cajaMensaje: 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    botonEnviarMensaje: 'button.msg-form__send-button',
    modal: '.artdeco-modal, [role="dialog"]',
  },
  deteccion: {
    urlPatterns: [
      { pattern: '/checkpoint/challenge/', pageType: 'captcha' },
      { pattern: '/checkpoint/lg/login-challenge-submit', pageType: 'identity-verification' },
      { pattern: '/flagship-web/login/login-restriction', pageType: 'login-restriction' },
    ],
    bodyPatterns: [
      { source: 'restricted your account until .+? because we detected the use of software that automates activity', flags: 'i', pageType: 'account-restricted' },
      { source: 'weekly invitation limit|límite semanal de invitaciones', flags: 'i', pageType: 'invitation-limit' },
    ],
  },
  chequeos: {
    check_connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    check_inbox: 'https://www.linkedin.com/messaging/',
    check_notifications: 'https://www.linkedin.com/notifications/',
  },
};
const FALLOS_PAUSA = 3;          // fallos seguidos que pausan la cuenta (algo cambió o LinkedIn avisa)
const PAUSA_RESTRICCION_H = 48;  // tras una restricción / aviso de LinkedIn
const PAUSA_FALLOS_H = 24;
const TAKEN_TIMEOUT_MIN = 10;    // una acción «en curso» que no responde NUNCA se reintenta sola (podría haberse enviado)

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => 'nvli_' + crypto.randomBytes(24).toString('hex');

// ── Hora local de la cuenta ──
function localParts(d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || DEF.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { dow, hour: (parseInt(p.hour, 10) % 24) + parseInt(p.minute, 10) / 60, ymd: `${p.year}-${p.month}-${p.day}` };
}
const daysBetween = (ymd1, ymd2) => Math.round((Date.parse(ymd2 + 'T00:00:00Z') - Date.parse(ymd1 + 'T00:00:00Z')) / 864e5);

// ── Límites efectivos de HOY (calentamiento incluido) ──
function efectivos(a, now) {
  const lp = localParts(now, a.tz);
  const desde = a.ramp_desde ? (a.ramp_desde instanceof Date ? a.ramp_desde.toISOString() : String(a.ramp_desde)).slice(0, 10) : lp.ymd;
  const dia = Math.max(0, daysBetween(desde, lp.ymd));
  const calentando = !!a.ramp_activo && dia < a.ramp_dias;
  let inv = a.inv_dia, msg = a.msg_dia, vis = a.vis_dia, inmail = a.inmail_dia, total = a.total_dia;
  if (a.ramp_activo) {
    inv = Math.min(a.inv_dia, a.ramp_inicio + a.ramp_paso * dia);                       // 5, 7, 9 … hasta el tope (guía de lemlist)
    if (calentando) {
      total = Math.min(a.total_dia, DEF.total_nuevo);                                   // cuentas nuevas: ~50 acciones/día
      msg = Math.min(a.msg_dia, 8 + 2 * dia);                                           // cifra propia
      vis = Math.min(a.vis_dia, 10 + 2 * dia);
      inmail = Math.min(a.inmail_dia, 2 + dia);
    }
  }
  return { inv, inv_semana: a.inv_semana, msg, vis, inmail, total, dia, calentando, local: lp };
}

// ── ¿Puede la cuenta hacer una acción de este tipo AHORA? ──
// hist: { inv_hoy, msg_hoy, vis_hoy, inmail_hoy, total_hoy, inv_semana, ultima: Date|null }
function evaluar(a, hist, tipo, now, rnd, conNota) {
  now = now || new Date(); rnd = typeof rnd === 'number' ? rnd : Math.random();
  if (a.estado === 'restringida' || a.estado === 'pausada' || a.estado === 'desconectada') {
    if (!(a.pausa_hasta && new Date(a.pausa_hasta) <= now && a.estado !== 'desconectada')) return { ok: false, motivo: 'cuenta_' + a.estado, espera_s: 600 };
  }
  if (a.pausa_hasta && new Date(a.pausa_hasta) > now) return { ok: false, motivo: 'pausa_hasta', espera_s: Math.min(3600, Math.ceil((new Date(a.pausa_hasta) - now) / 1000)) };
  const ef = efectivos(a, now), lp = ef.local;
  if (!(a.dias || DEF.dias).includes(lp.dow)) return { ok: false, motivo: 'dia_no_laborable', espera_s: 3600 };
  if (lp.hour < a.hora_ini || lp.hour >= a.hora_fin) return { ok: false, motivo: 'fuera_de_horario', espera_s: 1800 };
  const esCheck = String(tipo).startsWith('check_');
  if (!esCheck && hist.total_hoy >= ef.total) return { ok: false, motivo: 'tope_total_dia', espera_s: 3600 };
  const caps = esCheck ? [hist.chequeos_hoy || 0, DEF.chequeos_dia] :  { invite: [hist.inv_hoy, ef.inv], message: [hist.msg_hoy, ef.msg], visit: [hist.vis_hoy, ef.vis], inmail: [hist.inmail_hoy, ef.inmail] }[tipo];
  if (!caps) return { ok: false, motivo: 'tipo_desconocido', espera_s: 0 };
  if (caps[0] >= caps[1]) return { ok: false, motivo: 'tope_' + tipo + '_dia', espera_s: 3600 };
  if (tipo === 'invite' && hist.inv_semana >= ef.inv_semana) return { ok: false, motivo: 'tope_invitaciones_semana', espera_s: 3600 };
  if (tipo === 'invite' && conNota && a.plan !== 'premium' && (hist.notas_mes || 0) >= DEF.notas_mes_gratis) return { ok: false, motivo: 'tope_notas_mes_cuenta_gratis', espera_s: 3600 };
  // espera aleatoria entre acciones: nunca ráfagas
  const gap = a.gap_min + rnd * Math.max(0, a.gap_max - a.gap_min);
  if (hist.ultima) {
    const falta = gap - (now - new Date(hist.ultima)) / 1000;
    if (falta > 0) return { ok: false, motivo: 'espera_entre_acciones', espera_s: Math.ceil(falta) };
  }
  return { ok: true, ef };
}

// ── Enlaces de LinkedIn ──
function slugDe(url) {
  const m = String(url || '').trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^\/?#\s]+)/i);
  if (!m) return null;
  let s; try { s = decodeURIComponent(m[1]); } catch (_) { s = m[1]; }
  return s.toLowerCase();
}
const urlDeSlug = s => 'https://www.linkedin.com/in/' + encodeURIComponent(s) + '/';

// ── Esquema ──
async function ensure(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS li_accounts (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, nombre TEXT NOT NULL DEFAULT '', outbound_client_id INTEGER,
    token_hash TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pausada', motivo TEXT NOT NULL DEFAULT '', pausa_hasta TIMESTAMPTZ,
    modo TEXT NOT NULL DEFAULT 'asistido',
    inv_dia INTEGER NOT NULL DEFAULT 20, inv_semana INTEGER NOT NULL DEFAULT 100, msg_dia INTEGER NOT NULL DEFAULT 30, vis_dia INTEGER NOT NULL DEFAULT 30,
    inmail_dia INTEGER NOT NULL DEFAULT 5, total_dia INTEGER NOT NULL DEFAULT 100,
    ramp_activo BOOLEAN NOT NULL DEFAULT TRUE, ramp_inicio INTEGER NOT NULL DEFAULT 5, ramp_paso INTEGER NOT NULL DEFAULT 2, ramp_dias INTEGER NOT NULL DEFAULT 14, ramp_desde DATE,
    hora_ini REAL NOT NULL DEFAULT 9, hora_fin REAL NOT NULL DEFAULT 18, dias INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}', tz TEXT NOT NULL DEFAULT 'America/Lima',
    gap_min INTEGER NOT NULL DEFAULT 300, gap_max INTEGER NOT NULL DEFAULT 1200, fallos_seguidos INTEGER NOT NULL DEFAULT 0,
    ultimo_visto TIMESTAMPTZ, ext_version TEXT NOT NULL DEFAULT '', li_nombre TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'gratis'`);
  await pool.query(`ALTER TABLE li_accounts ALTER COLUMN inmail_dia SET DEFAULT 5, ALTER COLUMN gap_min SET DEFAULT 300, ALTER COLUMN gap_max SET DEFAULT 1200`);
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS li_slug TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE li_actions ADD COLUMN IF NOT EXISTS snapshot TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE li_actions ADD COLUMN IF NOT EXISTS datos JSONB`);
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS linkedin_auto BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_li_accounts_token ON li_accounts (token_hash)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS li_actions (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES li_accounts(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, slug TEXT NOT NULL, url TEXT NOT NULL, contact_id INTEGER, sequence_id INTEGER, step_id INTEGER,
    nota TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'queued',
    error TEXT NOT NULL DEFAULT '', detalle TEXT NOT NULL DEFAULT '', not_before TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), taken_at TIMESTAMPTZ, done_at TIMESTAMPTZ)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS li_actions_acc_idx ON li_actions (account_id, estado, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS li_actions_slug_idx ON li_actions (user_id, slug, tipo)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS li_events (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES li_accounts(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', detalle TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

// ── Contadores (día local de la cuenta, y 7 días móviles para invitaciones) ──
async function historial(pool, a, now) {
  const { rows: [r] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE tipo='invite'  AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS inv_hoy,
       COUNT(*) FILTER (WHERE tipo='message' AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS msg_hoy,
       COUNT(*) FILTER (WHERE tipo='visit'   AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS vis_hoy,
       COUNT(*) FILTER (WHERE tipo='inmail'  AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS inmail_hoy,
       COUNT(*) FILTER (WHERE tipo NOT LIKE 'check\_%' AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS total_hoy,
       COUNT(*) FILTER (WHERE tipo='invite' AND done_at > $2::timestamptz - INTERVAL '7 days')::int AS inv_semana,
       COUNT(*) FILTER (WHERE tipo='invite' AND nota <> '' AND done_at > $2::timestamptz - INTERVAL '30 days')::int AS notas_mes,
       COUNT(*) FILTER (WHERE tipo LIKE 'check\_%' AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS chequeos_hoy,
       MAX(COALESCE(done_at, taken_at)) AS ultima
     FROM li_actions WHERE account_id=$1 AND (estado='done' OR estado='taken')`, [a.id, now.toISOString()]);
  return r;
}

async function pausar(pool, accId, horas, estado, motivo, resetRamp) {
  await pool.query(
    `UPDATE li_accounts SET estado=$2, motivo=$3, pausa_hasta=NOW() + ($4 || ' hours')::interval,
       ramp_desde = CASE WHEN $5 THEN (NOW() AT TIME ZONE tz)::date ELSE ramp_desde END WHERE id=$1`,
    [accId, estado, motivo, String(horas), !!resetRamp]);
}

const normNombre = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const slugRegex = slug => '/in/' + String(slug || '').replace(/[^a-z0-9\-_%]/gi, '') + '/?$';
// «Ana Pérez ha visto tu perfil» / «Ana Pérez viewed your profile» → { nombre, tipo }
function parseNotificacion(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{3,70}?)\s+(viewed your profile|ha visto tu perfil|vio tu perfil|reacted to|reaccion[oó] a|commented on|coment[oó]|liked|le gust[oó]|mentioned you|te mencion[oó]|accepted your invitation|acept[oó] tu invitaci[oó]n|started following you|empez[oó] a seguirte)/i);
  if (!m) return null;
  const x = m[2].toLowerCase();
  const tipo = /profile|perfil/.test(x) ? 'visita_perfil' : /follow|seguirte/.test(x) ? 'seguidor' : /accept/.test(x) ? 'aceptada' : 'interaccion';
  return { nombre: m[1].trim(), tipo };
}

function mount(app, { pool, requireAuth, applyDisposition }) {
  const aplicar = async (uid, cid, body) => { try { return applyDisposition ? await applyDisposition(uid, cid, body) : null; } catch (e) { console.error('[li] disposición', e.message); return null; } };
  const sendEngine = () => require('./sendEngine');
  const pausarInscripcion = async (a, motivo, nota) => {
    if (!a.contact_id || !a.sequence_id) return;
    const r = await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$4 WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado='activo'`, [a.user_id, a.contact_id, a.sequence_id, motivo]);
    if (r.rowCount) await pool.query(`INSERT INTO activities (user_id, contact_id, tipo, nota, fecha, estado) VALUES ($1,$2,'pausa_secuencia',$3,NOW(),'hecha')`, [a.user_id, a.contact_id, nota]).catch(() => {});
  };
  const nota = (a, texto) => a.contact_id ? pool.query(`INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado) VALUES ($1,$2,'nota','linkedin',$3,NOW(),'hecha')`, [a.user_id, a.contact_id, texto]).catch(() => {}) : null;

  // Avanza la inscripción tras un paso hecho. Caso especial: tras una invitación, si los pasos que siguen solo aplican a quien ACEPTA y aún no aceptó,
  // la inscripción NO termina: queda en espera (pausada: «esperando_aceptacion») y se reanuda sola cuando se detecta la aceptación.
  async function avanzar(ac) {
    const se = sendEngine();
    try {
      if (ac.tipo === 'invite') {
        const { rows: steps } = await pool.query(`SELECT id, dia, canal, espera_dias, cond, cond_step_id FROM sequence_steps WHERE sequence_id=$1 ORDER BY dia ASC, orden ASC, id ASC`, [ac.sequence_id]);
        const cur = steps.findIndex(x => x.id === ac.step_id);
        const { rows: [k] } = await pool.query(`SELECT disposition, li_aceptado_at FROM lm_contacts WHERE id=$1`, [ac.contact_id]);
        const later = steps.slice(cur + 1);
        const eff = await se.nextEffIdx(pool, steps, { contact_id: ac.contact_id, disposition: k && k.disposition, li_aceptado_at: k && k.li_aceptado_at }, cur + 1);
        if (cur >= 0 && eff < 0 && later.some(x => x.cond === 'replied') && !(k && k.li_aceptado_at)) {
          await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='esperando_aceptacion', paso_date=CURRENT_DATE WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado='activo'`, [ac.user_id, ac.contact_id, ac.sequence_id]);
          return;
        }
      }
      await se.advancePastStep(pool, ac.user_id, ac.contact_id, ac.sequence_id, ac.step_id);
    } catch (e) { console.error('[li] avanzar', e.message); }
  }

  // Contactos que esta cuenta ha tocado en los últimos 60 días (para casar nombres de bandeja y notificaciones)
  async function contactosDeCuenta(a) {
    const { rows } = await pool.query(
      `SELECT DISTINCT k.id, k.nombre, k.apellido, k.linkedin FROM li_actions x JOIN lm_contacts k ON k.id = x.contact_id
        WHERE x.account_id=$1 AND x.estado='done' AND x.tipo IN ('invite','message','inmail') AND x.done_at > NOW() - INTERVAL '60 days'`, [a.id]);
    return rows.map(r => ({ ...r, full: normNombre([r.nombre, r.apellido].join(' ')) })).filter(r => r.full.includes(' '));
  }
  async function eventoNuevo(a, tipo, slug, detalle) {
    const { rows } = await pool.query(`SELECT 1 FROM li_events WHERE account_id=$1 AND tipo=$2 AND slug=$3 AND detalle=$4 AND created_at > NOW() - INTERVAL '7 days' LIMIT 1`, [a.id, tipo, slug || '', detalle || '']);
    if (rows.length) return false;
    await pool.query(`INSERT INTO li_events (user_id, account_id, tipo, slug, detalle) VALUES ($1,$2,$3,$4,$5)`, [a.user_id, a.id, tipo, slug || '', String(detalle || '').slice(0, 500)]);
    return true;
  }

  // Resultado de una lectura de la extensión: aceptaciones, respuestas, interacciones
  async function procesarChequeo(a, tipo, datos) {
    const out = { aceptadas: 0, respuestas: 0, interacciones: 0 };
    if (tipo === 'check_connections') {
      const slugs = (Array.isArray(datos && datos.slugs) ? datos.slugs : []).map(x => String(x).toLowerCase()).slice(0, 200);
      if (!slugs.length) return out;
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (x.slug) x.slug, x.contact_id, x.sequence_id FROM li_actions x
          WHERE x.account_id=$1 AND x.tipo='invite' AND x.estado='done' AND x.slug = ANY($2::text[]) AND x.done_at > NOW() - INTERVAL '60 days' ORDER BY x.slug, x.done_at DESC`, [a.id, slugs]);
      for (const r of rows) {
        if (!(await eventoNuevo(a, 'aceptada', r.slug, 'conexión aceptada'))) continue;
        out.aceptadas++;
        if (r.contact_id) await aplicar(a.user_id, r.contact_id, { disposition: 'aceptado', canal: 'linkedin', nota: 'Detectado automáticamente por la extensión de LinkedIn', sequence_id: r.sequence_id || undefined });
      }
    } else if (tipo === 'check_inbox') {
      const conv = (Array.isArray(datos && datos.conversaciones) ? datos.conversaciones : []).slice(0, 60);
      const nuevos = conv.filter(c => c && c.nombre && c.no_leido && !c.propio);
      if (!nuevos.length) return out;
      const cts = await contactosDeCuenta(a);
      for (const c of nuevos) {
        const n = normNombre(c.nombre), k = cts.find(x => x.full === n);
        if (!k) continue;
        const extracto = String(c.extracto || '').slice(0, 300);
        if (!(await eventoNuevo(a, 'respuesta', slugDe(k.linkedin) || '', extracto || 'respuesta'))) continue;
        out.respuestas++;
        await aplicar(a.user_id, k.id, { disposition: 'respondio', canal: 'linkedin', nota: 'Respondió por LinkedIn' + (extracto ? ': «' + extracto.slice(0, 200) + '»' : '') });
      }
    } else if (tipo === 'check_notifications') {
      const items = (Array.isArray(datos && datos.items) ? datos.items : []).slice(0, 60).map(i => parseNotificacion(i && i.texto)).filter(Boolean);
      if (!items.length) return out;
      const cts = await contactosDeCuenta(a);
      for (const it of items) {
        const k = cts.find(x => x.full === normNombre(it.nombre));
        if (!k) continue;
        const slug = slugDe(k.linkedin) || '';
        if (!(await eventoNuevo(a, it.tipo, slug, it.nombre + ' · ' + it.tipo))) continue;
        out.interacciones++;
        if (it.tipo === 'aceptada') await aplicar(a.user_id, k.id, { disposition: 'aceptado', canal: 'linkedin', nota: 'Detectado en las notificaciones de LinkedIn' });
        else await pool.query(`INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado) VALUES ($1,$2,'nota','linkedin',$3,NOW(),'hecha')`, [a.user_id, k.id, it.tipo === 'visita_perfil' ? 'Visitó tu perfil de LinkedIn' : it.tipo === 'seguidor' ? 'Empezó a seguirte en LinkedIn' : 'Interactuó contigo en LinkedIn']).catch(() => {});
      }
    }
    return out;
  }

  // Cada minuto: (1) encola las lecturas de detección y (2) convierte en acciones los pasos de LinkedIn de las secuencias automáticas
  async function puenteTick() {
    try {
      // (2a) Limpieza: acciones en cola de una inscripción que ya no está activa
      await pool.query(`UPDATE li_actions x SET estado='cancelled', detalle='La secuencia ya no está activa para esta persona' WHERE x.estado='queued' AND x.sequence_id IS NOT NULL AND x.contact_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id AND s.estado='activa' WHERE cs.contact_id=x.contact_id AND cs.sequence_id=x.sequence_id AND cs.estado='activo')`);
      // Quien lleva 21 días sin aceptar la invitación sale de la secuencia (la espera no es eterna)
      await pool.query(`UPDATE lm_contact_sequences SET estado='terminado', paused_reason='' WHERE estado='pausado' AND paused_reason='esperando_aceptacion' AND paso_date < CURRENT_DATE - 21`);
      // (1) Lecturas de detección, solo en cuentas conectadas y activas, y solo si hay algo que esperar
      const { rows: cuentas } = await pool.query(`SELECT * FROM li_accounts WHERE estado='activa' AND ultimo_visto > NOW() - INTERVAL '10 minutes'`);
      for (const a of cuentas) {
        for (const t of CHEQUEOS) {
          const { rows: [ya] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND tipo=$2 AND (estado IN ('queued','taken') OR created_at > NOW() - ($3 || ' minutes')::interval) LIMIT 1`, [a.id, t, String(CHEQUEO_CADA_MIN[t])]);
          if (ya) continue;
          const filtro = t === 'check_connections' ? `tipo='invite'` : t === 'check_inbox' ? `tipo IN ('invite','message','inmail')` : `tipo IN ('invite','message','inmail')`;
          const { rows: [hay] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND estado='done' AND ${filtro} AND done_at > NOW() - INTERVAL '45 days' LIMIT 1`, [a.id]);
          if (!hay) continue;
          await pool.query(`INSERT INTO li_actions (user_id, account_id, tipo, slug, url) VALUES ($1,$2,$3,'-',$4)`, [a.user_id, a.id, t, CONFIG.chequeos[t]]);
        }
      }
      // (2b) Pasos de LinkedIn de secuencias con «LinkedIn automático»
      const { rows: pend } = await pool.query(`
        SELECT cs.id AS enr_id, cs.user_id, cs.contact_id, cs.sequence_id, cs.paso, s.outbound_client_id, s.send_days, s.nombre AS seq_nombre,
               st.id AS step_id, st.accion, st.plantilla, st.asunto, st.variants, st.variant_mode, st.variant_field, st.canal, st.cond, st.cond_step_id,
               k.nombre, k.apellido, k.cargo, k.empresa_nombre, k.ciudad, k.pais, k.linkedin, k.idioma, k.idiomas, k.company_id, k.disposition, k.li_aceptado_at
          FROM lm_contact_sequences cs
          JOIN sequences s ON s.id = cs.sequence_id AND s.estado = 'activa' AND s.linkedin_auto
          JOIN lm_contacts k ON k.id = cs.contact_id
          JOIN LATERAL (SELECT * FROM sequence_steps ss WHERE ss.sequence_id = cs.sequence_id ORDER BY ss.dia ASC, ss.orden ASC, ss.id ASC OFFSET GREATEST(cs.paso - 1, 0) LIMIT 1) st ON TRUE
         WHERE cs.estado = 'activo' AND (cs.next_action_at IS NULL OR cs.next_action_at <= NOW()) AND st.canal = 'linkedin'
           AND st.accion IN ('invite_nota','invite','mensaje','visita')
           AND NOT EXISTS (SELECT 1 FROM li_actions a WHERE a.contact_id = cs.contact_id AND a.step_id = st.id)
         ORDER BY cs.next_action_at ASC NULLS FIRST LIMIT 40`);
      const se = sendEngine();
      for (const e of pend) {
        // ¿El paso aplica a esta persona (condición de aceptó / respondió)? Si no, se salta
        if (!(await se.condMatch(pool, { cond: e.cond, cond_step_id: e.cond_step_id }, { contact_id: e.contact_id, disposition: e.disposition, li_aceptado_at: e.li_aceptado_at }))) { await se.advancePastStep(pool, e.user_id, e.contact_id, e.sequence_id, e.step_id); continue; }
        const slug = slugDe(e.linkedin);
        if (!slug) { await pausarInscripcion(e, 'linkedin_sin_url', 'Secuencia pausada: este contacto no tiene un enlace de LinkedIn válido.'); continue; }
        const { rows: cuentasC } = await pool.query(`SELECT a.*, (SELECT COUNT(*) FROM li_actions q WHERE q.account_id=a.id AND q.estado='queued')::int AS cola FROM li_accounts a WHERE a.user_id=$1 AND a.outbound_client_id=$2 AND a.estado IN ('activa','pausada') ORDER BY cola ASC LIMIT 1`, [e.user_id, e.outbound_client_id || 0]);
        if (!cuentasC.length) continue;   // sin cuenta ligada a este cliente: el paso sigue siendo manual
        const acc = cuentasC[0];
        const { rows: ex } = await pool.query(`SELECT 1 FROM lm_exclusions WHERE user_id=$1 AND linkedin_slug=$2 AND (scope='global' OR (scope='cliente' AND outbound_client_id=$3)) LIMIT 1`, [e.user_id, slug, e.outbound_client_id || 0]).catch(() => ({ rows: [] }));
        if (ex.length) { await pausarInscripcion(e, 'disposition_no_contactar', 'Secuencia pausada: la persona está en tus exclusiones.'); continue; }
        const tipo = e.accion === 'mensaje' ? 'message' : e.accion === 'visita' ? 'visit' : 'invite';
        let texto = '';
        if (tipo !== 'visit') {
          const ctx = await se.attachCustom(pool, { ...e, contact_id: e.contact_id, user_id: e.user_id }, e.user_id);
          const v = se.pickVariant({ id: e.step_id, plantilla: e.plantilla, variants: e.variants, variant_mode: e.variant_mode, variant_field: e.variant_field }, ctx);
          texto = se.renderTemplate((v && v.cuerpo) || e.plantilla || '', ctx).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if (tipo === 'message' && !texto) { await pausarInscripcion(e, 'linkedin_sin_texto', 'Secuencia pausada: el paso de mensaje de LinkedIn no tiene texto.'); continue; }
          if (tipo === 'invite' && e.accion === 'invite_nota' && texto.length > DEF.nota_max) { await pausarInscripcion(e, 'linkedin_nota_larga', `Secuencia pausada: la nota de la invitación mide ${texto.length} caracteres y el máximo es ${DEF.nota_max}.`); continue; }
        }
        await pool.query(
          `INSERT INTO li_actions (user_id, account_id, tipo, slug, url, contact_id, sequence_id, step_id, nota, texto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [e.user_id, acc.id, tipo, slug, urlDeSlug(slug), e.contact_id, e.sequence_id, e.step_id, tipo === 'invite' && e.accion === 'invite_nota' ? texto : '', tipo === 'message' ? texto : '']);
      }
    } catch (e) { console.error('[li] puente', e.message); }
  }
  setInterval(puenteTick, 60 * 1000).unref();
  ensure(pool).catch(e => console.error('[li] esquema', e.message));
  const num = (v, d, mn, mx) => { const n = Number(v); return Number.isFinite(n) ? Math.min(mx, Math.max(mn, Math.round(n))) : d; };
  const publica = a => { const { token_hash, ...r } = a; return r; };

  // ───────── Lado Nova (sesión web) ─────────
  app.get('/api/li/accounts', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM li_accounts WHERE user_id=$1 ORDER BY id`, [req.workspaceOwnerId]);
      const now = new Date(), out = [];
      for (const a of rows) {
        const h = await historial(pool, a, now), ef = efectivos(a, now);
        const { rows: [q] } = await pool.query(`SELECT COUNT(*) FILTER (WHERE estado='queued')::int AS cola, COUNT(*) FILTER (WHERE estado='failed')::int AS fallos FROM li_actions WHERE account_id=$1 AND created_at > NOW() - INTERVAL '7 days'`, [a.id]);
        out.push({ ...publica(a), hoy: h, efectivos: { inv: ef.inv, inv_semana: ef.inv_semana, msg: ef.msg, vis: ef.vis, inmail: ef.inmail, total: ef.total, dia_calentamiento: ef.dia, calentando: ef.calentando }, cola: q.cola, fallos_7d: q.fallos,
          conectada: !!(a.ultimo_visto && now - new Date(a.ultimo_visto) < 5 * 60 * 1000) });
      }
      res.json(out);
    } catch (e) { console.error('[li] accounts', e.message); res.status(500).json({ error: 'No se pudieron cargar las cuentas' }); }
  });

  app.post('/api/li/accounts', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, token = newToken();
      const { rows: [a] } = await pool.query(
        `INSERT INTO li_accounts (user_id, nombre, outbound_client_id, token_hash, estado, motivo, ramp_desde, tz)
         VALUES ($1,$2,$3,$4,'pausada','Recién creada: conecta la extensión y actívala', (NOW() AT TIME ZONE $5)::date, $5) RETURNING *`,
        [req.workspaceOwnerId, String(b.nombre || 'Cuenta LinkedIn').slice(0, 80), parseInt(b.outbound_client_id, 10) || null, hash(token), String(b.tz || DEF.tz)]);
      res.json({ ...publica(a), token });   // el token solo se muestra ahora
    } catch (e) { console.error('[li] create', e.message); res.status(500).json({ error: 'No se pudo crear la cuenta' }); }
  });

  app.put('/api/li/accounts/:id', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10);
      const { rows: [cur] } = await pool.query(`SELECT * FROM li_accounts WHERE id=$1 AND user_id=$2`, [id, req.workspaceOwnerId]);
      if (!cur) return res.status(404).json({ error: 'Cuenta no encontrada' });
      const v = {
        nombre: b.nombre !== undefined ? String(b.nombre).slice(0, 80) : cur.nombre,
        outbound_client_id: b.outbound_client_id !== undefined ? (parseInt(b.outbound_client_id, 10) || null) : cur.outbound_client_id,
        modo: b.modo === 'auto' ? 'auto' : (b.modo === 'asistido' ? 'asistido' : cur.modo),
        // Los topes nunca superan el doble de la guía: un error de tecleo no puede poner la cuenta en riesgo.
        inv_dia: num(b.inv_dia, cur.inv_dia, 0, 40), inv_semana: num(b.inv_semana, cur.inv_semana, 0, 150), msg_dia: num(b.msg_dia, cur.msg_dia, 0, 60),
        vis_dia: num(b.vis_dia, cur.vis_dia, 0, 60), inmail_dia: num(b.inmail_dia, cur.inmail_dia, 0, 30), total_dia: num(b.total_dia, cur.total_dia, 0, 150),
        ramp_activo: b.ramp_activo !== undefined ? !!b.ramp_activo : cur.ramp_activo, ramp_inicio: num(b.ramp_inicio, cur.ramp_inicio, 1, 20), ramp_paso: num(b.ramp_paso, cur.ramp_paso, 0, 5),
        ramp_dias: num(b.ramp_dias, cur.ramp_dias, 0, 60),
        hora_ini: num(b.hora_ini, cur.hora_ini, 0, 23), hora_fin: num(b.hora_fin, cur.hora_fin, 1, 24), tz: b.tz ? String(b.tz).slice(0, 60) : cur.tz,
        dias: Array.isArray(b.dias) ? b.dias.map(Number).filter(d => d >= 1 && d <= 7) : cur.dias,
        plan: b.plan === 'premium' ? 'premium' : (b.plan === 'gratis' ? 'gratis' : cur.plan),
        gap_min: num(b.gap_min, cur.gap_min, 20, 3600), gap_max: num(b.gap_max, cur.gap_max, 20, 7200),
      };
      if (v.gap_max < v.gap_min) v.gap_max = v.gap_min;
      try { new Intl.DateTimeFormat('en', { timeZone: v.tz }); } catch (_) { return res.status(400).json({ error: 'Zona horaria no válida' }); }
      let estado = cur.estado, motivo = cur.motivo, pausa = cur.pausa_hasta, ramp = cur.ramp_desde;
      if (b.accion === 'activar') { estado = 'activa'; motivo = ''; pausa = null; }
      if (b.accion === 'pausar') { estado = 'pausada'; motivo = 'Pausada manualmente'; pausa = null; }
      if (b.accion === 'reiniciar_calentamiento') ramp = new Date().toISOString().slice(0, 10);
      if (b.accion === 'reiniciar_identidad') { await pool.query(`UPDATE li_accounts SET li_slug='' WHERE id=$1`, [id]); pausa = null; estado = 'pausada'; motivo = 'Identidad reiniciada: activa la cuenta cuando estés listo'; }
      const { rows: [a] } = await pool.query(
        `UPDATE li_accounts SET nombre=$3, outbound_client_id=$4, modo=$5, inv_dia=$6, inv_semana=$7, msg_dia=$8, vis_dia=$9, inmail_dia=$10, total_dia=$11,
           ramp_activo=$12, ramp_inicio=$13, ramp_paso=$14, ramp_dias=$15, hora_ini=$16, hora_fin=$17, tz=$18, dias=$19, gap_min=$20, gap_max=$21, plan=$27,
           estado=$22, motivo=$23, pausa_hasta=$24, ramp_desde=$25, fallos_seguidos=CASE WHEN $26 THEN 0 ELSE fallos_seguidos END
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [id, req.workspaceOwnerId, v.nombre, v.outbound_client_id, v.modo, v.inv_dia, v.inv_semana, v.msg_dia, v.vis_dia, v.inmail_dia, v.total_dia,
          v.ramp_activo, v.ramp_inicio, v.ramp_paso, v.ramp_dias, v.hora_ini, v.hora_fin, v.tz, v.dias, v.gap_min, v.gap_max, estado, motivo, pausa, ramp, b.accion === 'activar', v.plan]);
      res.json(publica(a));
    } catch (e) { console.error('[li] update', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  app.post('/api/li/accounts/:id/token', requireAuth, async (req, res) => {
    try {
      const token = newToken();
      const r = await pool.query(`UPDATE li_accounts SET token_hash=$3, estado='pausada', motivo='Token nuevo: reconecta la extensión', ultimo_visto=NULL WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId, hash(token)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
      res.json({ token });
    } catch (e) { res.status(500).json({ error: 'No se pudo regenerar el token' }); }
  });

  app.delete('/api/li/accounts/:id', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(`DELETE FROM li_accounts WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId]);
      res.json({ ok: !!r.rowCount });
    } catch (e) { res.status(500).json({ error: 'No se pudo eliminar' }); }
  });

  app.get('/api/li/queue', requireAuth, async (req, res) => {
    try {
      const acc = parseInt(req.query.account_id, 10) || 0;
      const { rows } = await pool.query(
        `SELECT id, account_id, tipo, slug, url, contact_id, nota, texto, estado, error, detalle, created_at, taken_at, done_at
           FROM li_actions WHERE user_id=$1 AND ($2=0 OR account_id=$2) ORDER BY id DESC LIMIT 200`, [req.workspaceOwnerId, acc]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'No se pudo cargar la cola' }); }
  });

  // Encolar una acción. Aquí se aplican las protecciones de contenido (duplicados, exclusiones, longitud de la nota).
  app.post('/api/li/queue', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, uid = req.workspaceOwnerId;
      const tipo = String(b.tipo || '');
      if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de acción no válido' });
      const { rows: [a] } = await pool.query(`SELECT * FROM li_accounts WHERE id=$1 AND user_id=$2`, [parseInt(b.account_id, 10) || 0, uid]);
      if (!a) return res.status(400).json({ error: 'Elige una cuenta de LinkedIn conectada' });
      const slug = slugDe(b.url);
      if (!slug) return res.status(400).json({ error: 'El enlace debe ser un perfil de LinkedIn (linkedin.com/in/…)' });
      const nota = String(b.nota || '').trim(), texto = String(b.texto || '').trim();
      if (tipo === 'invite' && nota.length > DEF.nota_max) return res.status(400).json({ error: `La nota de la invitación tiene ${nota.length} caracteres; el máximo es ${DEF.nota_max}. Acórtala.` });
      if ((tipo === 'message' || tipo === 'inmail') && !texto) return res.status(400).json({ error: 'Falta el texto del mensaje' });
      // Exclusiones (global o del cliente de la cuenta)
      const { rows: ex } = await pool.query(
        `SELECT 1 FROM lm_exclusions WHERE user_id=$1 AND linkedin_slug=$2 AND (scope='global' OR (scope='cliente' AND outbound_client_id=$3)) LIMIT 1`, [uid, slug, a.outbound_client_id || 0]).catch(() => ({ rows: [] }));
      if (ex.length) return res.status(409).json({ error: 'Esta persona está en tu lista de exclusiones' });
      // Sin duplicados: la misma persona no recibe dos veces lo mismo, ni desde otra cuenta del espacio
      const { rows: dup } = await pool.query(
        `SELECT id, estado FROM li_actions WHERE user_id=$1 AND slug=$2 AND tipo=$3 AND tipo <> 'message' AND tipo <> 'inmail' AND estado IN ('queued','taken','done') LIMIT 1`, [uid, slug, tipo]);
      if (dup.length) return res.status(409).json({ error: tipo === 'invite' ? 'A esta persona ya se le envió o encoló una invitación' : 'Esta visita ya está encolada o hecha' });
      const { rows: [r] } = await pool.query(
        `INSERT INTO li_actions (user_id, account_id, tipo, slug, url, contact_id, sequence_id, step_id, nota, texto, not_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [uid, a.id, tipo, slug, urlDeSlug(slug), parseInt(b.contact_id, 10) || null, parseInt(b.sequence_id, 10) || null, parseInt(b.step_id, 10) || null, nota, texto, b.not_before || null]);
      res.json({ ok: true, id: r.id });
    } catch (e) { console.error('[li] queue', e.message); res.status(500).json({ error: 'No se pudo encolar' }); }
  });

  app.delete('/api/li/queue/:id', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(`UPDATE li_actions SET estado='cancelled' WHERE id=$1 AND user_id=$2 AND estado='queued'`, [parseInt(req.params.id, 10), req.workspaceOwnerId]);
      res.json({ ok: !!r.rowCount });
    } catch (e) { res.status(500).json({ error: 'No se pudo cancelar' }); }
  });

  // ───────── Lado extensión (token de cuenta) ─────────
  async function liAuth(req, res, next) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(nvli_[a-f0-9]+)$/i);
    if (!m) return res.status(401).json({ error: 'Token no válido' });
    try {
      const { rows: [a] } = await pool.query(`SELECT * FROM li_accounts WHERE token_hash=$1`, [hash(m[1])]);
      if (!a) return res.status(401).json({ error: 'Token no válido o revocado' });
      req.liAcc = a; next();
    } catch (_) { res.status(500).json({ error: 'Error' }); }
  }

  // La extensión pregunta cada ~30–60 s. Responde con UNA acción o con cuánto esperar y por qué.
  app.post('/api/li/ext/next', liAuth, async (req, res) => {
    const a = req.liAcc, b = req.body || {};
    try {
      const now = new Date();
      await pool.query(`UPDATE li_accounts SET ultimo_visto=NOW(), ext_version=$2, li_nombre=CASE WHEN $3 <> '' THEN $3 ELSE li_nombre END WHERE id=$1`, [a.id, String(b.version || '').slice(0, 20), String(b.li_nombre || '').slice(0, 120)]);
      // Identidad: la primera sesión de LinkedIn que se ve queda como la de esta cuenta. Si luego cambia (token pegado en el Chrome
      // equivocado, otra cuenta iniciada), la cuenta se PAUSA y no se ejecuta nada.
      const slugVisto = String(b.li_slug || '').toLowerCase().slice(0, 120);
      if (slugVisto) {
        if (!a.li_slug) { await pool.query(`UPDATE li_accounts SET li_slug=$2 WHERE id=$1`, [a.id, slugVisto]); a.li_slug = slugVisto; }
        else if (a.li_slug !== slugVisto) {
          await pausar(pool, a.id, 24 * 365, 'pausada', `Cuenta distinta: este Chrome tiene abierto «${slugVisto}» y la cuenta estaba ligada a «${a.li_slug}». Revisa el token o reinicia la identidad`, false);
          return res.json({ accion: null, espera_s: 600, motivo: 'cuenta_distinta', config: CONFIG });
        }
      }
      if (b.sesion === false) {
        await pool.query(`UPDATE li_accounts SET estado='desconectada', motivo='La sesión de LinkedIn de ese Chrome no está iniciada' WHERE id=$1 AND estado = 'activa'`, [a.id]);
        return res.json({ accion: null, espera_s: 600, motivo: 'sesion_cerrada', config: CONFIG });
      }
      if (a.estado === 'desconectada') await pool.query(`UPDATE li_accounts SET estado='activa', motivo='' WHERE id=$1`, [a.id]), a.estado = 'activa';
      // Una acción «en curso» sin respuesta se marca fallida: no se reintenta (podría haberse enviado)
      await pool.query(`UPDATE li_actions SET estado='failed', error='sin_respuesta', detalle='La extensión no confirmó el resultado; revisa en LinkedIn antes de repetir' WHERE account_id=$1 AND estado='taken' AND taken_at < NOW() - ($2 || ' minutes')::interval`, [a.id, String(TAKEN_TIMEOUT_MIN)]);
      if (a.estado !== 'activa' && !(a.pausa_hasta && new Date(a.pausa_hasta) <= now)) return res.json({ accion: null, espera_s: 300, motivo: 'cuenta_' + a.estado, config: CONFIG });
      if (a.estado !== 'activa') { await pool.query(`UPDATE li_accounts SET estado='activa', motivo='', pausa_hasta=NULL WHERE id=$1`, [a.id]); a.estado = 'activa'; a.pausa_hasta = null; }
      const { rows: [enCurso] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND estado='taken' LIMIT 1`, [a.id]);
      if (enCurso) return res.json({ accion: null, espera_s: 60, motivo: 'accion_en_curso' });
      const hist = await historial(pool, a, now);
      const { rows: cola } = await pool.query(`SELECT * FROM li_actions WHERE account_id=$1 AND estado='queued' AND (not_before IS NULL OR not_before <= NOW()) ORDER BY id LIMIT 30`, [a.id]);
      if (!cola.length) return res.json({ accion: null, espera_s: 60, motivo: 'cola_vacia', config: CONFIG });
      let mejor = null, espera = 3600, motivo = '';
      const rnd = Math.random();
      for (const q of cola) {
        // Si la persona ya respondió, salió o la secuencia se pausó mientras esperaba en la cola, la acción se cancela
        if (q.sequence_id && q.contact_id) {
          const { rows: [vivo] } = await pool.query(`SELECT 1 FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id AND s.estado='activa' WHERE cs.contact_id=$1 AND cs.sequence_id=$2 AND cs.estado='activo'`, [q.contact_id, q.sequence_id]);
          if (!vivo) { await pool.query(`UPDATE li_actions SET estado='cancelled', detalle='La secuencia ya no está activa para esta persona' WHERE id=$1`, [q.id]); continue; }
        }
        const ev = evaluar(a, hist, q.tipo, now, rnd, !!(q.nota && q.nota.trim()));
        if (ev.ok) { mejor = q; break; }
        if (ev.espera_s < espera) { espera = ev.espera_s; motivo = ev.motivo; }
      }
      if (!mejor) return res.json({ accion: null, espera_s: espera, motivo, config: CONFIG });
      const { rowCount } = await pool.query(`UPDATE li_actions SET estado='taken', taken_at=NOW() WHERE id=$1 AND estado='queued'`, [mejor.id]);
      if (!rowCount) return res.json({ accion: null, espera_s: 15, motivo: 'reintentar' });
      res.json({ accion: { id: mejor.id, tipo: mejor.tipo, url: mejor.url || CONFIG.chequeos[mejor.tipo] || '', slug: mejor.slug, nota: mejor.nota, texto: mejor.texto }, modo: a.modo, config: CONFIG });
    } catch (e) { console.error('[li] next', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // Resultado de una acción. Códigos: ok | omitida (ya conectado, pendiente, no encontrada…) | restringida | sesion | fallo
  app.post('/api/li/ext/result', liAuth, async (req, res) => {
    const a = req.liAcc, b = req.body || {};
    try {
      const id = parseInt(b.id, 10) || 0, codigo = String(b.codigo || 'fallo');
      const { rows: [ac] } = await pool.query(`SELECT * FROM li_actions WHERE id=$1 AND account_id=$2`, [id, a.id]);
      if (!ac) return res.status(404).json({ error: 'Acción no encontrada' });
      const det = String(b.detalle || '').slice(0, 500);
      const snap = String(b.snapshot || '').slice(0, 300000);
      let extra = null;
      if (codigo === 'ok') {
        await pool.query(`UPDATE li_actions SET estado='done', done_at=NOW(), error='', detalle=$2, datos=$3::jsonb WHERE id=$1`, [id, det, b.datos ? JSON.stringify(b.datos).slice(0, 200000) : null]);
        await pool.query(`UPDATE li_accounts SET fallos_seguidos=0 WHERE id=$1`, [a.id]);
        if (String(ac.tipo).startsWith('check_')) extra = await procesarChequeo(a, ac.tipo, b.datos);
        else if (ac.contact_id && ac.sequence_id && ac.step_id) {
          const rot = { invite: 'Invitación de LinkedIn enviada' + (ac.nota ? ' con nota' : ''), message: 'Mensaje de LinkedIn enviado', visit: 'Perfil de LinkedIn visitado' }[ac.tipo] || 'Acción de LinkedIn hecha';
          await nota(ac, rot + ' (automático, extensión)');
          await avanzar(ac);
        }
      } else if (codigo === 'omitida') {
        await pool.query(`UPDATE li_actions SET estado='skipped', done_at=NOW(), error=$2, detalle=$3 WHERE id=$1`, [id, String(b.error || 'omitida').slice(0, 60), det]);
        if (!String(ac.tipo).startsWith('check_') && ac.contact_id && ac.sequence_id) {
          if (b.error === 'ya_conectado' && ac.tipo === 'invite') {
            await aplicar(ac.user_id, ac.contact_id, { disposition: 'aceptado', canal: 'linkedin', nota: 'Ya estaba conectado en LinkedIn', sequence_id: ac.sequence_id });
            if (ac.step_id) await avanzar({ ...ac, tipo: 'visit' });
          } else if (b.error === 'ya_pendiente' && ac.tipo === 'invite') {
            if (ac.step_id) await avanzar(ac);
          } else {
            await pausarInscripcion(ac, 'linkedin_omitido', `Secuencia pausada: la extensión no pudo ejecutar el paso de LinkedIn (${b.error || 'omitido'}${det ? ': ' + det : ''}). Revísalo.`);
          }
        }
      } else if (codigo === 'restringida') {
        // LinkedIn avisó, pidió captcha o dijo «límite alcanzado»: se para TODO 48 h y el calentamiento vuelve a empezar
        await pool.query(`UPDATE li_actions SET estado='failed', error='restringida', detalle=$2, snapshot=$3 WHERE id=$1`, [id, det, snap]);
        await pausar(pool, a.id, PAUSA_RESTRICCION_H, 'restringida', 'LinkedIn mostró un aviso o límite: pausa de 48 h. Entra a mano, revisa el aviso y reduce los topes', true);
      } else if (codigo === 'sesion') {
        await pool.query(`UPDATE li_actions SET estado='queued', taken_at=NULL WHERE id=$1`, [id]);   // no llegó a ejecutarse: vuelve a la cola
        await pool.query(`UPDATE li_accounts SET estado='desconectada', motivo='La sesión de LinkedIn se cerró' WHERE id=$1`, [a.id]);
      } else {
        await pool.query(`UPDATE li_actions SET estado='failed', error=$2, detalle=$3, snapshot=$4 WHERE id=$1`, [id, String(b.error || 'fallo').slice(0, 60), det, snap]);
        if (!String(ac.tipo).startsWith('check_')) await pausarInscripcion(ac, 'linkedin_fallo', `Secuencia pausada: falló un paso de LinkedIn (${b.error || 'fallo'}). Puede haberse enviado: revisa en LinkedIn antes de repetir.`);
        const esLectura = String(ac.tipo).startsWith('check_');   // una lectura que no encuentra datos no cuenta como fallo de la cuenta
        const { rows: [u] } = esLectura ? { rows: [null] } : await pool.query(`UPDATE li_accounts SET fallos_seguidos = fallos_seguidos + 1 WHERE id=$1 RETURNING fallos_seguidos`, [a.id]);
        if (u && u.fallos_seguidos >= FALLOS_PAUSA) await pausar(pool, a.id, PAUSA_FALLOS_H, 'pausada', `${FALLOS_PAUSA} fallos seguidos: pausa automática de 24 h. Puede que LinkedIn haya cambiado su página o haya un aviso`, false);
      }
      res.json({ ok: true, extra });
    } catch (e) { console.error('[li] result', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // Alertas que la extensión ve en cualquier pestaña de LinkedIn (aunque no esté ejecutando nada): verificación, captcha, restricción, sesión cerrada.
  app.post('/api/li/ext/alert', liAuth, async (req, res) => {
    try {
      const a = req.liAcc, b = req.body || {}, tipo = String(b.tipo || '').slice(0, 40), det = `${tipo}: ${String(b.url || '').slice(0, 200)}`;
      await pool.query(`INSERT INTO li_events (user_id, account_id, tipo, slug, detalle) VALUES ($1,$2,'alerta','',$3)`, [a.user_id, a.id, det]);
      if (tipo === 'sesion_cerrada') {
        await pool.query(`UPDATE li_accounts SET estado='desconectada', motivo='LinkedIn cerró la sesión de este Chrome' WHERE id=$1 AND estado='activa'`, [a.id]);
      } else if (['captcha', 'identity-verification', 'login-restriction', 'account-restricted', 'invitation-limit'].includes(tipo)) {
        await pausar(pool, a.id, PAUSA_RESTRICCION_H, 'restringida', `LinkedIn mostró «${tipo}»: pausa de 48 h. Entra a mano, revisa el aviso y reduce los topes`, true);
      }
      res.json({ ok: true });
    } catch (e) { console.error('[li] alert', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // «LinkedIn automático» por secuencia + feed de eventos para el panel
  app.put('/api/li/sequence/:id', requireAuth, async (req, res) => {
    try {
      const auto = !!(req.body || {}).auto;
      const { rows: [sq] } = await pool.query(`UPDATE sequences SET linkedin_auto=$3 WHERE id=$1 AND user_id=$2 RETURNING id, linkedin_auto, outbound_client_id`, [parseInt(req.params.id, 10), req.workspaceOwnerId, auto]);
      if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
      const { rows: [cu] } = await pool.query(`SELECT COUNT(*)::int AS n FROM li_accounts WHERE user_id=$1 AND outbound_client_id=$2`, [req.workspaceOwnerId, sq.outbound_client_id || 0]);
      res.json({ ok: true, auto: sq.linkedin_auto, cuentas_del_cliente: cu.n });
    } catch (e) { res.status(500).json({ error: 'No se pudo guardar' }); }
  });
  app.get('/api/li/events', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT e.id, e.account_id, e.tipo, e.slug, e.detalle, e.created_at FROM li_events e WHERE e.user_id=$1 ORDER BY e.id DESC LIMIT 60`, [req.workspaceOwnerId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.get('/api/li/queue/:id/snapshot', requireAuth, async (req, res) => {
    try {
      const { rows: [r] } = await pool.query(`SELECT snapshot FROM li_actions WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId]);
      res.type('text/plain').send(r ? r.snapshot : '');
    } catch (e) { res.status(500).send(''); }
  });

  // Eventos que la extensión observa (invitación aceptada, respuesta recibida…)
  app.post('/api/li/ext/event', liAuth, async (req, res) => {
    try {
      const b = req.body || {}, tipo = String(b.tipo || '').slice(0, 30), slug = slugDe(b.url) || String(b.slug || '').toLowerCase().slice(0, 120);
      if (!['aceptada', 'respuesta'].includes(tipo)) return res.status(400).json({ error: 'Evento no válido' });
      await pool.query(`INSERT INTO li_events (user_id, account_id, tipo, slug, detalle) VALUES ($1,$2,$3,$4,$5)`, [req.liAcc.user_id, req.liAcc.id, tipo, slug, String(b.detalle || '').slice(0, 500)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
}

module.exports = { mount, evaluar, efectivos, localParts, slugDe, DEF, hash };
