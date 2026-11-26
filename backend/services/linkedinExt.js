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
  react_dia: 30, follow_dia: 25, comment_dia: 12, hora_ini: 9, hora_fin: 18, dias: [1, 2, 3, 4, 5], gap_min: 300, gap_max: 1200, nota_max: 200, tz: 'America/Lima',
};
const TIPOS = ['invite', 'message', 'visit', 'inmail'];
const CHEQUEOS = ['check_connections', 'check_inbox', 'check_notifications'];   // lecturas que hace la extensión para detectar aceptaciones, respuestas e interacciones
const CHEQUEO_CADA_MIN = { check_connections: 60, check_inbox: 45, check_notifications: 180 };
DEF.chequeos_dia = 30;   // «comprobaciones de red en 24 h»: el valor de la pantalla Límites de lemlist

// Configuración que viaja DESDE el servidor hacia la extensión (como hace lemlist): si LinkedIn cambia su página, se corrige aquí y
// las extensiones lo reciben solas, sin reinstalarlas. Los patrones de bloqueo son los que usa lemlist (leídos en su extensión).
const CONFIG = {
  v: 3,
  bandeja: { item: 'li.msg-conversation-listitem', nombre: '.msg-conversation-card__participant-names, .msg-conversation-listitem__participant-names', extracto: '.msg-conversation-card__message-snippet' },   // comprobado en una cuenta real el 2026-11-23
  textos: {
    connect: ['connect', 'conectar'], pending: ['pending', 'pendiente'], message: ['message', 'mensaje'],
    addNote: ['add a note', 'añadir una nota', 'agregar una nota'], send: ['send', 'enviar'],
    sendNoNote: ['send without a note', 'enviar sin nota'], more: ['more', 'más'],
    like: ['react like', 'like', 'recomendar', 'me gusta', 'reaccionar'], follow: ['follow', 'seguir'], following: ['following', 'siguiendo'], comment: ['comment', 'comentar'],
  },
  reacciones: { recomendar: ['react like', 'like', 'recomendar'], celebrar: ['celebrate', 'celebrar'], apoyar: ['support', 'apoyar'], me_encanta: ['love', 'me encanta'], interesante: ['insightful', 'interesante'] },
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

// ── Huella: nada de rutinas idénticas día tras día ──
// Cada DÍA (estable durante ese día, distinto del siguiente) la cuenta tiene su propio perfil: cuánto hace (72–100 % de los topes),
// a qué hora arranca (hasta 45 min después de abrir el horario), cuándo termina (hasta 30 min antes) y una pausa de descanso a mediodía de 30–75 min.
const hrand = s => parseInt(crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8), 16) / 0x100000000;
function perfilDia(a, ymd) {
  const k = x => hrand(a.id + '|' + ymd + '|' + x);
  let ini = a.hora_ini + 0.75 * k('i'), fin = a.hora_fin - 0.5 * k('e');
  if (fin - ini < 1) { ini = a.hora_ini; fin = a.hora_fin; }
  let pausa = null;
  if (fin - ini >= 6) { const d = 0.5 + 0.75 * k('d'), s = 12 + 1.5 * k('p'); if (s > ini + 1 && s + d < fin - 1) pausa = [s, s + d]; }
  return { ini, fin, pausa, f: 0.72 + 0.28 * k('f') };
}
const fmtH = h => { const m = Math.round(h * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

// ── ¿Cuándo vuelve a abrir el horario de la cuenta? (para decirle a la persona a qué hora empieza) ──
function proximaVentana(a, now) {
  const dias = a.dias || DEF.dias, tz = a.tz, lp0 = localParts(now, tz);
  const enPausa = (pd, h) => !!(pd.pausa && h >= pd.pausa[0] && h < pd.pausa[1]);
  const dentro = p => { const pd = perfilDia(a, p.ymd); return dias.includes(p.dow) && p.hour >= pd.ini && p.hour < pd.fin && !enPausa(pd, p.hour); };
  const pd0 = perfilDia(a, lp0.ymd);
  if (dentro(lp0)) return { en_ventana: true, fin: pd0.fin, finTxt: fmtH(pd0.fin) };
  if (dias.includes(lp0.dow) && lp0.hour >= pd0.ini && lp0.hour < pd0.fin && enPausa(pd0, lp0.hour)) return { en_ventana: false, descanso: true, ts: new Date(now.getTime() + (pd0.pausa[1] - lp0.hour) * 3600e3).toISOString(), dia: 'hoy', hora: fmtH(pd0.pausa[1]), fin: pd0.fin, finTxt: fmtH(pd0.fin), tz };
  const DOW = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  for (let m = 15; m <= 8 * 24 * 60; m += 15) {
    const t = new Date(now.getTime() + m * 60000), p = localParts(t, tz);
    if (dentro(p)) { const pd = perfilDia(a, p.ymd), diff = daysBetween(lp0.ymd, p.ymd); return { en_ventana: false, ts: new Date(t.getTime() - (p.hour - pd.ini) * 3600e3).toISOString(), dia: diff === 0 ? 'hoy' : diff === 1 ? 'mañana' : DOW[p.dow], hora: fmtH(pd.ini), fin: pd.fin, finTxt: fmtH(pd.fin), tz }; }
  }
  return { en_ventana: false, sin_dias: true };
}
// Si una hora estimada cae dentro de la pausa de descanso de ese día, se mueve al final de la pausa (así las horas estimadas no prometen trabajo durante el descanso)
function saltarPausa(ms, a) {
  for (let i = 0; i < 3; i++) {
    const lp = localParts(new Date(ms), a.tz), pd = perfilDia(a, lp.ymd);
    if (pd.pausa && lp.hour >= pd.pausa[0] && lp.hour < pd.pausa[1]) ms += Math.ceil((pd.pausa[1] - lp.hour) * 3600e3) + 60e3; else break;
  }
  return ms;
}
// Lo que la persona ve en el panel cuando no hay nada que hacer AHORA: cuánto hay en cola, qué viene y cuándo empieza.
async function resumenCola(pool, a, now) {
  const [{ rows: [c] }, { rows: prox }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE tipo='visit')::int AS visit, COUNT(*) FILTER (WHERE tipo='invite')::int AS invite, COUNT(*) FILTER (WHERE tipo='message')::int AS message, COUNT(*) FILTER (WHERE tipo='inmail')::int AS inmail FROM li_actions WHERE account_id=$1 AND estado='queued' AND tipo IN ('visit','invite','message','inmail','react','follow','comment')`, [a.id]),
    pool.query(`SELECT q.sequence_id, q.tipo, TRIM(COALESCE(k.nombre,'')||' '||COALESCE(k.apellido,'')) AS nombre, q.slug FROM li_actions q LEFT JOIN lm_contacts k ON k.id=q.contact_id WHERE q.account_id=$1 AND q.estado='queued' AND q.tipo IN ('visit','invite','message','inmail','react','follow','comment') ORDER BY q.id LIMIT 10`, [a.id]),
  ]);
  let tzPrim = null;
  if (prox[0] && prox[0].sequence_id) { const { rows: [sq] } = await pool.query(`SELECT timezone FROM sequences WHERE id=$1`, [prox[0].sequence_id]); tzPrim = sq && sq.timezone || null; }
  const tzR = tzPrim || a.tz, aR = tzPrim ? { ...a, tz: tzPrim } : a, ptr = proximaVentana(aR, now);
  const gapS = Math.max(60, await mediaReparto(pool, aR, prox[0] ? prox[0].tipo : 'visit', false) || ((a.gap_min || 300) + (a.gap_max || 1200)) / 2);
  let t0 = Math.max(now.getTime(), a.proxima_accion_at ? new Date(a.proxima_accion_at).getTime() : 0);
  if (ptr && !ptr.en_ventana && ptr.ts) t0 = Math.max(t0, new Date(ptr.ts).getTime());
  const lpHoy = localParts(now, tzR), pdHoy = perfilDia(aR, lpHoy.ymd);
  let cur = t0;
  const proxEst = prox.map((r, i) => { cur = saltarPausa(cur, aR); const ts = new Date(cur), lp = localParts(ts, tzR); cur += gapS * 1000 * (0.85 + (i % 3) * 0.15); return { tipo: r.tipo, quien: r.nombre || r.slug, ts: ts.toISOString(), hoy: lp.ymd === lpHoy.ymd && lp.hour < pdHoy.fin }; });
  return { en_cola: c.n, por_tipo: { visit: c.visit, invite: c.invite, message: c.message, inmail: c.inmail }, proximas: proxEst, ventana: proximaVentana(tzPrim ? { ...a, tz: tzPrim } : a, now), topes: { inv: a.inv_dia, msg: a.msg_dia, vis: a.vis_dia } };
}

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
  // El tope de HOY es un 72–100 % del configurado (distinto cada día): hacer exactamente el máximo todos los días es una huella muy clara.
  const pd = perfilDia(a, lp.ymd), esc = x => Math.max(1, Math.round(x * pd.f));
  return { inv: esc(inv), inv_semana: a.inv_semana, msg: esc(msg), vis: esc(vis), inmail: esc(inmail), react: esc(a.react_dia != null ? a.react_dia : DEF.react_dia), follow: esc(a.follow_dia != null ? a.follow_dia : DEF.follow_dia), comment: esc(a.comment_dia != null ? a.comment_dia : DEF.comment_dia), total: esc(total), dia, calentando, local: lp, perfil: pd };
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
  const pd = ef.perfil;
  if (lp.hour < pd.ini || lp.hour >= pd.fin) return { ok: false, motivo: 'fuera_de_horario', espera_s: 1800 };
  if (pd.pausa && lp.hour >= pd.pausa[0] && lp.hour < pd.pausa[1]) return { ok: false, motivo: 'pausa_descanso', espera_s: Math.max(60, Math.ceil((pd.pausa[1] - lp.hour) * 3600)) };
  const esCheck = String(tipo).startsWith('check_');
  if (!esCheck && hist.total_hoy >= ef.total) return { ok: false, motivo: 'tope_total_dia', espera_s: 3600 };
  const caps = esCheck ? [hist.chequeos_hoy || 0, DEF.chequeos_dia] :  { invite: [hist.inv_hoy, ef.inv], message: [hist.msg_hoy, ef.msg], visit: [hist.vis_hoy, ef.vis], inmail: [hist.inmail_hoy, ef.inmail], react: [hist.react_hoy, ef.react], follow: [hist.follow_hoy, ef.follow], comment: [hist.comment_hoy, ef.comment] }[tipo];
  if (!caps) return { ok: false, motivo: 'tipo_desconocido', espera_s: 0 };
  if (caps[0] >= caps[1]) return { ok: false, motivo: 'tope_' + tipo + '_dia', espera_s: 3600 };
  if (tipo === 'invite' && hist.inv_semana >= ef.inv_semana) return { ok: false, motivo: 'tope_invitaciones_semana', espera_s: 3600 };
  if (tipo === 'invite' && conNota && a.plan !== 'premium' && (hist.notas_mes || 0) >= DEF.notas_mes_gratis) return { ok: false, motivo: 'tope_notas_mes_cuenta_gratis', espera_s: 3600 };
  // Espera entre acciones: la hora de la próxima se SORTEA UNA SOLA VEZ al terminar la anterior (proxima_accion_at) y se respeta.
  // (Antes se volvía a sortear en cada sondeo: eso empujaba las acciones hacia el mínimo y las dejaba casi a intervalos regulares.)
  if (a.proxima_accion_at) {
    const t = new Date(a.proxima_accion_at);
    if (t > now) return { ok: false, motivo: 'espera_entre_acciones', espera_s: Math.ceil((t - now) / 1000) };
  } else if (hist.ultima) {
    const gap = a.gap_min + rnd * Math.max(0, a.gap_max - a.gap_min);
    const falta = gap - (now - new Date(hist.ultima)) / 1000;
    if (falta > 0) return { ok: false, motivo: 'espera_entre_acciones', espera_s: Math.ceil(falta) };
  }
  return { ok: true, ef };
}
// Segundos de espera hasta la próxima acción. Nunca un número redondo ni constante: uniforme entre el mínimo y el máximo de la cuenta,
// con un 12 % de «pausas largas» (como quien se distrae) y algo de ruido en segundos.
// «media» = lo que toca para REPARTIR el resto del tope del día en lo que queda de horario (así trabaja lemlist: ~1 acción cada 21 min, repartidas
// por toda la jornada y no en ráfagas al empezar). Alrededor de esa media se varía ±30 %, con alguna pausa larga y ruido en segundos.
function siguienteEspera(a, media) {
  const mn = Math.max(20, a.gap_min || 300), tope = Math.max(4 * (a.gap_max || 1200), mn);
  const m = Math.min(Math.max(media || ((a.gap_min || 300) + (a.gap_max || 1200)) / 2, mn), tope);
  let s = m * (0.7 + Math.random() * 0.6);
  if (Math.random() < 0.08) s *= 1.3 + Math.random() * 0.7;
  return Math.round(Math.max(mn, s) + (Math.random() * 2 - 1) * 17 + Math.random());
}
// Media de espera que reparte lo que falta del tope del día de ESE tipo de acción en lo que queda del horario de hoy.
async function mediaReparto(pool, a, tipo, sumaUna) {
  try {
    const ahora = new Date(), ef = efectivos(a, ahora), hist = await historial(pool, a, ahora);
    const usado = ({ invite: hist.inv_hoy, message: hist.msg_hoy, visit: hist.vis_hoy, inmail: hist.inmail_hoy, react: hist.react_hoy, follow: hist.follow_hoy, comment: hist.comment_hoy })[tipo], cap = ({ invite: ef.inv, message: ef.msg, visit: ef.vis, inmail: ef.inmail, react: ef.react, follow: ef.follow, comment: ef.comment })[tipo];
    if (usado == null || !cap) return 0;
    const pd = ef.perfil; let resto = pd.fin - ef.local.hour;
    if (pd.pausa && ef.local.hour < pd.pausa[1]) resto -= pd.pausa[1] - Math.max(ef.local.hour, pd.pausa[0]);   // el descanso no cuenta como tiempo de trabajo
    const restoDia = Math.max(0, resto) * 3600, quedan = Math.max(1, cap - usado - (sumaUna ? 1 : 0));
    return restoDia > 0 ? restoDia / quedan : 0;
  } catch (_) { return 0; }
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
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS proxima_accion_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS li_ext_log (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER, nivel TEXT NOT NULL DEFAULT 'error', tipo TEXT NOT NULL DEFAULT '', msg TEXT NOT NULL DEFAULT '', ctx JSONB, version TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS li_ext_log_idx ON li_ext_log (user_id, created_at DESC)`);
  await pool.query(`ALTER TABLE li_actions ADD COLUMN IF NOT EXISTS snapshot TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE li_actions ADD COLUMN IF NOT EXISTS datos JSONB`);
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS linkedin_auto BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS li_plan TEXT NOT NULL DEFAULT 'gratis'`).catch(() => {});   // tipo de cuenta de LinkedIn de la campaña: 'gratis' | 'premium' (Premium / Sales Navigator: permite InMail)
  await pool.query(`ALTER TABLE li_actions ADD COLUMN IF NOT EXISTS params JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS react_dia INTEGER NOT NULL DEFAULT 30`).catch(() => {});
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS follow_dia INTEGER NOT NULL DEFAULT 25`).catch(() => {});
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS comment_dia INTEGER NOT NULL DEFAULT 12`).catch(() => {});
  await pool.query(`ALTER TABLE li_accounts ADD COLUMN IF NOT EXISTS inmail_bloqueado_hasta TIMESTAMPTZ`).catch(() => {});
  // Modo de LinkedIn POR CAMPAÑA/SECUENCIA ('asistido' | 'auto'); antes era de la cuenta. Migración única: hereda 'auto' si la cuenta del cliente lo era.
  const { rows: [hadCol] } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='sequences' AND column_name='li_modo'`).catch(() => ({ rows: [] }));
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS li_modo TEXT NOT NULL DEFAULT 'asistido'`).catch(() => {});
  if (!hadCol) await pool.query(`UPDATE sequences s SET li_modo='auto' WHERE s.linkedin_auto AND EXISTS (SELECT 1 FROM li_accounts a WHERE a.outbound_client_id = s.outbound_client_id AND a.modo='auto')`).catch(() => {});
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
       COUNT(*) FILTER (WHERE tipo='react'   AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS react_hoy,
       COUNT(*) FILTER (WHERE tipo='follow'  AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS follow_hoy,
       COUNT(*) FILTER (WHERE tipo='comment' AND done_at > $2::timestamptz - INTERVAL '24 hours')::int AS comment_hoy,
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
          // Las lecturas de control (conexiones, bandeja, notificaciones) tampoco van a intervalos fijos: pasado el 70 % del período se
          // dispara con una probabilidad por minuto, así llegan en momentos distintos cada vez.
          const { rows: [ya] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND tipo=$2 AND (estado IN ('queued','taken') OR created_at > NOW() - ($3 || ' minutes')::interval) LIMIT 1`, [a.id, t, String(Math.round(CHEQUEO_CADA_MIN[t] * 0.7))]);
          if (ya) continue;
          if (Math.random() > Math.min(1, 1 / (CHEQUEO_CADA_MIN[t] * 0.3))) continue;
          const filtro = t === 'check_connections' ? `tipo='invite'` : t === 'check_inbox' ? `tipo IN ('invite','message','inmail')` : `tipo IN ('invite','message','inmail')`;
          const { rows: [hay] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND estado='done' AND ${filtro} AND done_at > NOW() - INTERVAL '45 days' LIMIT 1`, [a.id]);
          if (!hay) continue;
          await pool.query(`INSERT INTO li_actions (user_id, account_id, tipo, slug, url) VALUES ($1,$2,$3,'-',$4)`, [a.user_id, a.id, t, CONFIG.chequeos[t]]);
        }
      }
      // (2b) Pasos de LinkedIn de secuencias con «LinkedIn automático»
      const { rows: pend } = await pool.query(`
        SELECT cs.id AS enr_id, cs.user_id, cs.contact_id, cs.sequence_id, cs.paso, s.drip_per_day, s.timezone AS seq_tz, s.outbound_client_id, s.campaign_id, s.send_days, s.nombre AS seq_nombre,
               st.id AS step_id, st.accion, st.plantilla, st.asunto, st.post_dias, st.reaccion, s.li_plan, st.variants, st.variant_mode, st.variant_field, st.canal, st.cond, st.cond_step_id,
               k.nombre, k.apellido, k.cargo, k.empresa_nombre, k.ciudad, k.pais, k.linkedin, k.idioma, k.idiomas, k.company_id, k.disposition, k.li_aceptado_at
          FROM lm_contact_sequences cs
          JOIN sequences s ON s.id = cs.sequence_id AND s.estado = 'activa' AND s.linkedin_auto
          JOIN lm_contacts k ON k.id = cs.contact_id
          JOIN LATERAL (SELECT * FROM sequence_steps ss WHERE ss.sequence_id = cs.sequence_id ORDER BY ss.dia ASC, ss.orden ASC, ss.id ASC OFFSET GREATEST(cs.paso - 1, 0) LIMIT 1) st ON TRUE
         WHERE cs.estado = 'activo' AND (cs.next_action_at IS NULL OR cs.next_action_at <= NOW()) AND st.canal = 'linkedin'
           AND st.accion IN ('invite_nota','invite','mensaje','visita','like','follow','comentario','inmail')
           AND NOT EXISTS (SELECT 1 FROM li_actions a WHERE a.contact_id = cs.contact_id AND a.step_id = st.id)
         ORDER BY (cs.paso > 1) DESC, cs.next_action_at ASC NULLS FIRST LIMIT 40`);
      const se = sendEngine();
      const cupoEntrada = new Map();   // «contactos que entran por día» (drip): cuántos del primer paso caben todavía hoy en cada secuencia
      for (const e of pend) {
        if (e.paso <= 1 && e.drip_per_day > 0) {
          const ck = e.sequence_id + ':' + e.step_id;
          if (!cupoEntrada.has(ck)) {
            const { rows: [u] } = await pool.query(`SELECT COUNT(*)::int AS n FROM li_actions WHERE sequence_id=$1 AND step_id=$2 AND (estado IN ('queued','taken') OR (estado='done' AND done_at >= ((NOW() AT TIME ZONE $3)::date::timestamp AT TIME ZONE $3)))`, [e.sequence_id, e.step_id, e.seq_tz || 'America/Lima']).catch(() => ({ rows: [{ n: 0 }] }));
            cupoEntrada.set(ck, e.drip_per_day - u.n);
          }
          if (cupoEntrada.get(ck) <= 0) continue;
          cupoEntrada.set(ck, cupoEntrada.get(ck) - 1);
        }
        // ¿El paso aplica a esta persona (condición de aceptó / respondió)? Si no, se salta
        if (!(await se.condMatch(pool, { cond: e.cond, cond_step_id: e.cond_step_id }, { contact_id: e.contact_id, disposition: e.disposition, li_aceptado_at: e.li_aceptado_at }))) { await se.advancePastStep(pool, e.user_id, e.contact_id, e.sequence_id, e.step_id); continue; }
        if (e.accion === 'comentario' && !process.env.ANTHROPIC_API_KEY) continue;   // sin clave de IA: se hace a mano (la secuencia muestra el aviso)
        if (e.accion === 'inmail' && e.li_plan !== 'premium') continue;              // campaña con cuenta gratuita: InMail a mano
        const slug = slugDe(e.linkedin);
        if (!slug) { await pausarInscripcion(e, 'linkedin_sin_url', 'Secuencia pausada: este contacto no tiene un enlace de LinkedIn válido.'); continue; }
        const { rows: cuentasC } = await pool.query(`SELECT a.*, (SELECT COUNT(*) FROM li_actions q WHERE q.account_id=a.id AND q.estado='queued')::int AS cola FROM li_accounts a WHERE a.user_id=$1 AND a.outbound_client_id=$2 AND a.estado IN ('activa','pausada')
           AND (NOT EXISTS (SELECT 1 FROM campaign_senders c1 WHERE c1.campaign_id=$3 AND c1.tipo='linkedin') OR EXISTS (SELECT 1 FROM campaign_senders c2 WHERE c2.campaign_id=$3 AND c2.tipo='linkedin' AND c2.ref_id=a.id AND c2.activo))
         ORDER BY cola ASC LIMIT 1`, [e.user_id, e.outbound_client_id || 0, e.campaign_id || 0]);
        if (!cuentasC.length) continue;   // sin cuenta ligada a este cliente: el paso sigue siendo manual
        const acc = cuentasC[0];
        if (e.accion === 'inmail' && acc.inmail_bloqueado_hasta && new Date(acc.inmail_bloqueado_hasta) > new Date()) continue;   // sin créditos / suscripción vencida: InMail a mano mientras dure el bloqueo
        const { rows: ex } = await pool.query(`SELECT 1 FROM lm_exclusions WHERE user_id=$1 AND linkedin_slug=$2 AND (scope='global' OR (scope='cliente' AND outbound_client_id=$3)) LIMIT 1`, [e.user_id, slug, e.outbound_client_id || 0]).catch(() => ({ rows: [] }));
        if (ex.length) { await pausarInscripcion(e, 'disposition_no_contactar', 'Secuencia pausada: la persona está en tus exclusiones.'); continue; }
        const tipo = e.accion === 'mensaje' ? 'message' : e.accion === 'visita' ? 'visit' : e.accion === 'like' ? 'react' : e.accion === 'follow' ? 'follow' : e.accion === 'comentario' ? 'comment' : e.accion === 'inmail' ? 'inmail' : 'invite';
        let texto = '', params = null, urlAccion = urlDeSlug(slug);
        if (tipo === 'react' || tipo === 'comment') { params = { post_dias: e.post_dias || 0 }; urlAccion = urlDeSlug(slug) + 'recent-activity/all/'; }
        if (tipo === 'react') texto = e.reaccion || '';
        if (tipo === 'comment') {
          const ctx0 = await se.attachCustom(pool, { ...e, contact_id: e.contact_id, user_id: e.user_id }, e.user_id);
          params.prompt = se.renderTemplate(e.plantilla || '', ctx0).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 6000);
        }
        if (tipo === 'message' || tipo === 'invite' || tipo === 'inmail') {
          const ctx = await se.attachCustom(pool, { ...e, contact_id: e.contact_id, user_id: e.user_id }, e.user_id);
          const v = se.pickVariant({ id: e.step_id, plantilla: e.plantilla, variants: e.variants, variant_mode: e.variant_mode, variant_field: e.variant_field }, ctx);
          texto = se.renderTemplate((v && v.cuerpo) || e.plantilla || '', ctx).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if ((tipo === 'message' || tipo === 'inmail') && !texto) { await pausarInscripcion(e, 'linkedin_sin_texto', 'Secuencia pausada: el paso de mensaje de LinkedIn no tiene texto.'); continue; }
          if (tipo === 'invite' && e.accion === 'invite_nota' && texto.length > DEF.nota_max) { await pausarInscripcion(e, 'linkedin_nota_larga', `Secuencia pausada: la nota de la invitación mide ${texto.length} caracteres y el máximo es ${DEF.nota_max}.`); continue; }
        }
        await pool.query(
          `INSERT INTO li_actions (user_id, account_id, tipo, slug, url, contact_id, sequence_id, step_id, nota, texto, params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [e.user_id, acc.id, tipo, slug, urlAccion, e.contact_id, e.sequence_id, e.step_id, tipo === 'invite' && e.accion === 'invite_nota' ? texto : (tipo === 'inmail' ? String(e.asunto || '').slice(0, 200) : ''), (tipo === 'message' || tipo === 'inmail') ? texto : (tipo === 'react' ? texto : ''), params ? JSON.stringify(params) : null]);
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
        out.push({ ...publica(a), hoy: h, efectivos: { inv: ef.inv, inv_semana: ef.inv_semana, msg: ef.msg, vis: ef.vis, inmail: ef.inmail, react: ef.react, follow: ef.follow, comment: ef.comment, total: ef.total, dia_calentamiento: ef.dia, calentando: ef.calentando }, cola: q.cola, fallos_7d: q.fallos,
          conectada: !!(a.ultimo_visto && now - new Date(a.ultimo_visto) < 5 * 60 * 1000) });
      }
      res.json(out);
    } catch (e) { console.error('[li] accounts', e.message); res.status(500).json({ error: 'No se pudieron cargar las cuentas' }); }
  });

  app.post('/api/li/accounts', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, token = newToken();
      const { rows: [a] } = await pool.query(
        `INSERT INTO li_accounts (user_id, nombre, outbound_client_id, token_hash, estado, motivo, ramp_desde, tz, li_slug)
         VALUES ($1,$2,$3,$4,'pausada','Recién creada: conecta la extensión y actívala', (NOW() AT TIME ZONE $5)::date, $5, $6) RETURNING *`,
        [req.workspaceOwnerId, String(b.nombre || 'Cuenta LinkedIn').slice(0, 80), parseInt(b.outbound_client_id, 10) || null, hash(token), String(b.tz || DEF.tz), String(b.li_slug || '').toLowerCase().slice(0, 120)]);
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
      { const rd = num(b.react_dia, cur.react_dia != null ? cur.react_dia : 30, 0, 60), fd = num(b.follow_dia, cur.follow_dia != null ? cur.follow_dia : 25, 0, 60), cd = num(b.comment_dia, cur.comment_dia != null ? cur.comment_dia : 12, 0, 30);
        await pool.query(`UPDATE li_accounts SET react_dia=$2, follow_dia=$3, comment_dia=$4 WHERE id=$1`, [id, rd, fd, cd]); a.react_dia = rd; a.follow_dia = fd; a.comment_dia = cd; }
      if (b.accion === 'activar') await pool.query(`UPDATE li_accounts SET proxima_accion_at = NOW() + ($2 || ' seconds')::interval WHERE id=$1`, [id, String(180 + Math.floor(Math.random() * 360))]);   // sin acción instantánea al activar
      res.json(publica(a));
    } catch (e) { console.error('[li] update', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  app.post('/api/li/accounts/:id/token', requireAuth, async (req, res) => {
    try {
      const token = newToken();
      const slugNuevo = String((req.body || {}).li_slug || '').toLowerCase().slice(0, 120);
      const r = await pool.query(`UPDATE li_accounts SET token_hash=$3, estado='pausada', motivo='Reconectada: actívala cuando estés lista', ultimo_visto=NULL, li_slug=CASE WHEN $4 <> '' THEN $4 ELSE li_slug END, pausa_hasta=NULL WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId, hash(token), slugNuevo]);
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

  // ───────── Vinculación desde la propia extensión (sesión de Nova, sin copiar tokens) ─────────
  // La extensión usa la sesión de Nova de ese Chrome para ver las cuentas, elegir o crear una y recibir su token directamente.
  app.get('/api/li/pair/accounts', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId;
      const { rows: cuentas } = await pool.query(`SELECT a.id, a.nombre, a.li_slug, a.estado, a.outbound_client_id, c.nombre AS cliente, (a.ultimo_visto > NOW() - INTERVAL '5 minutes') AS conectada FROM li_accounts a LEFT JOIN outbound_clients c ON c.id=a.outbound_client_id WHERE a.user_id=$1 ORDER BY a.id`, [uid]);
      const { rows: clientes } = await pool.query(`SELECT id, nombre FROM outbound_clients WHERE user_id=$1 AND COALESCE(estado,'') <> 'cerrado' ORDER BY nombre`, [uid]);
      res.json({ ok: true, cuentas, clientes, usuario: (req.user && (req.user.email || req.user.nombre || req.user.name)) || '' });
    } catch (e) { console.error('[li] pair accounts', e.message); res.status(500).json({ error: 'No se pudieron cargar las cuentas' }); }
  });
  app.post('/api/li/pair', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, b = req.body || {}, token = newToken();
      const slug = String(b.li_slug || '').toLowerCase().slice(0, 120);
      if (parseInt(b.account_id, 10)) {
        const r = await pool.query(`UPDATE li_accounts SET token_hash=$3, estado='pausada', motivo='Reconectada desde la extensión: actívala cuando estés lista', ultimo_visto=NULL, li_slug=CASE WHEN $4 <> '' THEN $4 ELSE li_slug END, pausa_hasta=NULL WHERE id=$1 AND user_id=$2 RETURNING id, nombre`, [parseInt(b.account_id, 10), uid, hash(token), slug]);
        if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
        return res.json({ ok: true, token, cuenta: r.rows[0] });
      }
      // Reinstalar la extensión NO debe crear una segunda cuenta de la misma persona de LinkedIn (doblaría los topes: cada cuenta cuenta los suyos).
      if (slug) {
        const { rows: [ya] } = await pool.query(`SELECT id, nombre FROM li_accounts WHERE user_id=$1 AND li_slug=$2 ORDER BY id LIMIT 1`, [uid, slug]);
        if (ya) {
          await pool.query(`UPDATE li_accounts SET token_hash=$2, estado='pausada', motivo='Reconectada desde la extensión: actívala cuando estés lista', ultimo_visto=NULL, pausa_hasta=NULL WHERE id=$1`, [ya.id, hash(token)]);
          return res.json({ ok: true, token, cuenta: ya, reutilizada: true });
        }
      }
      const n = b.nueva || {};
      const { rows: [a] } = await pool.query(
        `INSERT INTO li_accounts (user_id, nombre, outbound_client_id, token_hash, estado, motivo, ramp_desde, tz, li_slug)
         VALUES ($1,$2,$3,$4,'pausada','Conectada desde la extensión: actívala cuando estés lista', (NOW() AT TIME ZONE $5)::date, $5, $6) RETURNING id, nombre`,
        [uid, String(n.nombre || 'Cuenta LinkedIn').slice(0, 80), parseInt(n.outbound_client_id, 10) || null, hash(token), DEF.tz, slug]);
      res.json({ ok: true, token, cuenta: a });
    } catch (e) { console.error('[li] pair', e.message); res.status(500).json({ error: 'No se pudo vincular' }); }
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
      let modoRes = null;   // el modo es de la campaña (secuencia) de la acción, no de la cuenta
      const sinAccion = async (espera_s, motivo) => res.json({ accion: null, espera_s, motivo, modo: modoRes, resumen: await resumenCola(pool, a, new Date()), config: CONFIG });
      const hist = await historial(pool, a, now);
      // Reparto justo: se mezclan las secuencias (las 6 más antiguas de cada una, de la 1.ª a la 6.ª) para que una campaña con 80 acciones en cola no deje sin turno a otra recién activada
      const { rows: cola } = await pool.query(`SELECT * FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(x.sequence_id, 0) ORDER BY x.id) AS rn FROM li_actions x WHERE x.account_id=$1 AND x.estado='queued' AND (x.not_before IS NULL OR x.not_before <= NOW())) q WHERE q.rn <= 6 ORDER BY q.rn, q.id LIMIT 30`, [a.id]);
      if (!cola.length) return sinAccion(60, 'cola_vacia');
      // El horario (días, hora de inicio/fin, pausa) se mide en la zona horaria de la CAMPAÑA (la de su secuencia), no en la de la cuenta; si la secuencia no tiene, vale la de la cuenta.
      const seqIds = [...new Set(cola.map(q => q.sequence_id).filter(Boolean))];
      const tzSeq = {};
      const modoSeq = {};
      if (seqIds.length) (await pool.query(`SELECT id, timezone, li_modo FROM sequences WHERE id = ANY($1::int[])`, [seqIds])).rows.forEach(r => { if (r.timezone) tzSeq[r.id] = r.timezone; modoSeq[r.id] = r.li_modo === 'auto' ? 'auto' : 'asistido'; });
      modoRes = modoSeq[cola[0].sequence_id] || 'asistido';
      let mejor = null, espera = 3600, motivo = ''; const oks = [];
      const rnd = Math.random();
      for (const q of cola) {
        // Si la persona ya respondió, salió o la secuencia se pausó mientras esperaba en la cola, la acción se cancela
        if (q.sequence_id && q.contact_id) {
          const { rows: [vivo] } = await pool.query(`SELECT 1 FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id AND s.estado='activa' WHERE cs.contact_id=$1 AND cs.sequence_id=$2 AND cs.estado='activo'`, [q.contact_id, q.sequence_id]);
          if (!vivo) { await pool.query(`UPDATE li_actions SET estado='cancelled', detalle='La secuencia ya no está activa para esta persona' WHERE id=$1`, [q.id]); continue; }
        }
        const ev = evaluar(tzSeq[q.sequence_id] ? { ...a, tz: tzSeq[q.sequence_id] } : a, hist, q.tipo, now, rnd, !!(q.nota && q.nota.trim()));
        if (ev.ok) { oks.push(q); if (oks.length >= 8) break; continue; }
        if (ev.espera_s < espera) { espera = ev.espera_s; motivo = ev.motivo; }
      }
      // No se recorre la lista siempre en el mismo orden (id 1, 2, 3…): se elige entre las primeras permitidas, con preferencia por las más antiguas.
      if (oks.length) mejor = oks[Math.floor(Math.pow(Math.random(), 1.6) * oks.length)];
      if (!mejor) return sinAccion(espera, motivo);
      const { rowCount } = await pool.query(`UPDATE li_actions SET estado='taken', taken_at=NOW() WHERE id=$1 AND estado='queued'`, [mejor.id]);
      if (!rowCount) return res.json({ accion: null, espera_s: 15, motivo: 'reintentar' });
      res.json({ accion: { id: mejor.id, tipo: mejor.tipo, url: mejor.url || CONFIG.chequeos[mejor.tipo] || '', slug: mejor.slug, nota: mejor.nota, texto: mejor.texto, params: mejor.params || null }, modo: modoSeq[mejor.sequence_id] || 'asistido', config: CONFIG });
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
      // Se sortea aquí (al TERMINAR, no al empezar) cuánto falta para la próxima acción: así el intervalo no incluye lo que tardes en pulsar «Enviar».
      if (codigo !== 'sesion') {
        if (String(ac.tipo).startsWith('check_')) await pool.query(`UPDATE li_accounts SET proxima_accion_at = GREATEST(COALESCE(proxima_accion_at, NOW()), NOW() + ($2 || ' seconds')::interval) WHERE id=$1`, [a.id, String(30 + Math.floor(Math.random() * 60))]);
        else {
          const { rows: [sig] } = await pool.query(`SELECT tipo FROM li_actions WHERE account_id=$1 AND estado='queued' AND tipo IN ('invite','message','visit','inmail','react','follow','comment') ORDER BY id LIMIT 1`, [a.id]);
          const media = await mediaReparto(pool, a, sig ? sig.tipo : ac.tipo, codigo === 'ok');
          await pool.query(`UPDATE li_accounts SET proxima_accion_at = NOW() + ($2 || ' seconds')::interval WHERE id=$1`, [a.id, String(siguienteEspera(a, media))]);
        }
      }
      if (codigo === 'ok') {
        await pool.query(`UPDATE li_actions SET estado='done', done_at=NOW(), error='', detalle=$2, datos=$3::jsonb WHERE id=$1`, [id, det, b.datos ? JSON.stringify(b.datos).slice(0, 200000) : null]);
        await pool.query(`UPDATE li_accounts SET fallos_seguidos=0 WHERE id=$1`, [a.id]);
        if (String(ac.tipo).startsWith('check_')) extra = await procesarChequeo(a, ac.tipo, b.datos);
        else if (ac.contact_id && ac.sequence_id && ac.step_id) {
          const rot = { invite: 'Invitación de LinkedIn enviada' + (ac.nota ? ' con nota' : ''), message: 'Mensaje de LinkedIn enviado', visit: 'Perfil de LinkedIn visitado', react: 'Reaccionó a una publicación en LinkedIn', follow: ac.params && ac.params.fallback_de ? 'Siguió el perfil en LinkedIn (no tenía publicación reciente)' : 'Siguió el perfil en LinkedIn', comment: 'Comentó una publicación en LinkedIn' + (b.datos && b.datos.comentario ? ': «' + String(b.datos.comentario).slice(0, 300) + '»' : ''), inmail: 'InMail de LinkedIn enviado' }[ac.tipo] || 'Acción de LinkedIn hecha';
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
          } else if (['react', 'comment'].includes(ac.tipo) && b.error === 'sin_publicacion') {
            // Plan B: la persona no tiene publicación (reciente) → se la sigue en vez de reaccionar/comentar
            await pool.query(`INSERT INTO li_actions (user_id, account_id, tipo, slug, url, contact_id, sequence_id, step_id, params) VALUES ($1,$2,'follow',$3,$4,$5,$6,$7,$8::jsonb)`,
              [ac.user_id, ac.account_id, ac.slug, urlDeSlug(ac.slug), ac.contact_id, ac.sequence_id, ac.step_id, JSON.stringify({ fallback_de: ac.tipo })]);
            await nota(ac, 'Sin publicación reciente para ' + (ac.tipo === 'react' ? 'reaccionar' : 'comentar') + ': se la seguirá en su lugar');
          } else if (ac.tipo === 'follow' && b.error === 'ya_siguiendo') {
            if (ac.step_id) await avanzar(ac);
          } else if (ac.tipo === 'react' && b.error === 'ya_reaccionado') {
            if (ac.step_id) await avanzar(ac);
          } else if (ac.tipo === 'inmail' && b.error === 'ya_conectado') {
            if (ac.step_id) await avanzar(ac);
          } else if (ac.tipo === 'inmail' && b.error === 'sin_inmail') {
            // Bloqueo SOLO de InMail: sin créditos / suscripción vencida / cuenta gratuita. El paso queda como tarea manual y lo demás sigue igual.
            await pool.query(`UPDATE li_accounts SET inmail_bloqueado_hasta = NOW() + INTERVAL '24 hours' WHERE id=$1`, [ac.account_id]);
            await pool.query(`INSERT INTO li_events (user_id, account_id, tipo, slug, detalle) VALUES ($1,$2,'alerta',$3,$4)`, [ac.user_id, ac.account_id, ac.slug, 'InMail no disponible (sin créditos o suscripción vencida): los pasos de InMail pasan a manual 24 h']).catch(() => {});
            await nota(ac, 'InMail no disponible (sin créditos o suscripción vencida): este paso queda como tarea manual');
          } else if (ac.tipo === 'comment' && ['sin_clave_ia', 'sin_comentario_ia'].includes(b.error)) {
            await nota(ac, 'No se pudo generar el comentario con IA (' + (b.detalle || b.error) + '): este paso queda como tarea manual');
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

  // Un solo interruptor: al pulsar «Activar» en la extensión también se activa la cuenta en Nova. NO levanta pausas por restricción/alerta (esas llevan fecha).
  // Lista de Outreach completa para el panel de la extensión: lo ya hecho hoy + toda la cola con hora estimada y campaña.
  app.post('/api/li/ext/cola', liAuth, async (req, res) => {
    try {
      const a = req.liAcc, now = new Date();
      const { rows: hechas } = await pool.query(`SELECT q.tipo, q.estado, q.done_at, TRIM(COALESCE(k.nombre,'')||' '||COALESCE(k.apellido,'')) AS nombre, q.slug, s.nombre AS campana
        FROM li_actions q LEFT JOIN lm_contacts k ON k.id=q.contact_id LEFT JOIN sequences s ON s.id=q.sequence_id
        WHERE q.account_id=$1 AND q.tipo IN ('visit','invite','message','inmail','react','follow','comment') AND q.estado IN ('done','failed','skipped') AND q.done_at > NOW() - INTERVAL '24 hours' ORDER BY q.done_at DESC LIMIT 25`, [a.id]);
      const { rows: cola } = await pool.query(`SELECT q.id, q.sequence_id, q.tipo, q.estado, TRIM(COALESCE(k.nombre,'')||' '||COALESCE(k.apellido,'')) AS nombre, q.slug, s.nombre AS campana, s.timezone AS tz
        FROM li_actions q LEFT JOIN lm_contacts k ON k.id=q.contact_id LEFT JOIN sequences s ON s.id=q.sequence_id
        WHERE q.account_id=$1 AND q.estado IN ('queued','taken') AND q.tipo IN ('visit','invite','message','inmail','react','follow','comment') ORDER BY q.id LIMIT 80`, [a.id]);
      const tz = (cola[0] && cola[0].tz) || a.tz, aR = { ...a, tz }, ptr = proximaVentana(aR, now);
      const gapS = Math.max(60, await mediaReparto(pool, aR, cola[0] ? cola[0].tipo : 'visit', false) || ((a.gap_min || 300) + (a.gap_max || 1200)) / 2);
      let t0 = Math.max(now.getTime(), a.proxima_accion_at ? new Date(a.proxima_accion_at).getTime() : 0);
      if (ptr && !ptr.en_ventana && ptr.ts) t0 = Math.max(t0, new Date(ptr.ts).getTime());
      const lpHoy = localParts(now, tz), pdHoy = perfilDia(aR, lpHoy.ymd);
      let cur = t0;
      res.json({
        hechas: hechas.map(r => ({ tipo: r.tipo, estado: r.estado, quien: r.nombre || r.slug, campana: r.campana || '', t: r.done_at })),
        cola: cola.map((r, i) => { cur = saltarPausa(cur, aR); const ts = new Date(cur), lp = localParts(ts, tz); cur += gapS * 1000 * (0.85 + (i % 3) * 0.15); return { tipo: r.tipo, quien: r.nombre || r.slug, campana: r.campana || '', en_curso: r.estado === 'taken', ts: ts.toISOString(), hoy: lp.ymd === lpHoy.ymd && lp.hour < pdHoy.fin }; }),
        total: cola.length,
      });
    } catch (e) { console.error('[li] cola', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // La extensión pide el texto del comentario (IA) con el contenido real de la publicación. Sin clave de IA o sin presupuesto → error y el paso queda manual.
  app.post('/api/li/ext/comentario', liAuth, async (req, res) => {
    try {
      const a = req.liAcc, b = req.body || {};
      if (!process.env.ANTHROPIC_API_KEY) return res.json({ error: 'Falta la clave de IA (ANTHROPIC_API_KEY) en el servidor' });
      const { rows: [ac] } = await pool.query(`SELECT * FROM li_actions WHERE id=$1 AND account_id=$2 AND tipo='comment'`, [parseInt(b.id, 10) || 0, a.id]);
      if (!ac || !ac.contact_id) return res.json({ error: 'Acción no encontrada' });
      const { generateComment } = require('./aiPersonalizeService');
      const r = await generateComment(pool, ac.user_id, { contactId: ac.contact_id, stepId: ac.step_id, sequenceId: ac.sequence_id, prompt: String((ac.params && ac.params.prompt) || '').slice(0, 8000), post: String(b.post || '').slice(0, 12000), identidadIncluida: false });
      res.json({ comentario: r.comentario });
    } catch (e) { res.json({ error: String(e.message || 'No se pudo generar el comentario').slice(0, 200) }); }
  });

  // Datos para proyectar la carga de una secuencia contra los topes diarios (la proyección se calcula en la pantalla)
  app.get('/api/li/sequence/:id/capacidad-datos', requireAuth, async (req, res) => {
    try {
      const sid = parseInt(req.params.id, 10), uid = req.workspaceOwnerId;
      const { rows: [sq] } = await pool.query(`SELECT id, outbound_client_id, drip_per_day, send_days, starts_on, timezone FROM sequences WHERE id=$1 AND user_id=$2`, [sid, uid]);
      if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
      const { rows: steps } = await pool.query(`SELECT st.id, st.dia, st.canal, st.accion, st.cond, c.canal AS cond_canal, c.accion AS cond_accion FROM sequence_steps st LEFT JOIN sequence_steps c ON c.id = st.cond_step_id WHERE st.sequence_id=$1 ORDER BY st.dia ASC, st.orden ASC, st.id ASC`, [sid]);
      const { rows: cuentas } = await pool.query(`SELECT * FROM li_accounts WHERE user_id=$1 AND outbound_client_id=$2 AND estado IN ('activa','pausada','desconectada') ORDER BY id`, [uid, sq.outbound_client_id || 0]);
      const sum = k => cuentas.reduce((t, a) => t + (Number(a[k]) || 0), 0);
      const sinCuenta = !cuentas.length;
      const caps = sinCuenta ? { inv: DEF.inv_dia, inv_semana: DEF.inv_semana, msg: DEF.msg_dia, vis: DEF.vis_dia, inmail: DEF.inmail_dia, react: DEF.react_dia, follow: DEF.follow_dia, comment: DEF.comment_dia, total: DEF.total_dia }
        : { inv: sum('inv_dia'), inv_semana: sum('inv_semana'), msg: sum('msg_dia'), vis: sum('vis_dia'), inmail: sum('inmail_dia'), react: sum('react_dia'), follow: sum('follow_dia'), comment: sum('comment_dia'), total: sum('total_dia') };
      const a0 = cuentas[0];
      const ramp = a0 && a0.ramp_activo ? { activo: true, inicio: a0.ramp_inicio, paso: a0.ramp_paso, dias: a0.ramp_dias, dia_actual: Math.max(0, daysBetween(String(a0.ramp_desde || '').slice(0, 10) || localParts(new Date(), a0.tz).ymd, localParts(new Date(), a0.tz).ymd)), total_nuevo: DEF.total_nuevo } : { activo: false };
      const { rows: [ct] } = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE estado='activo')::int AS activos FROM lm_contact_sequences WHERE sequence_id=$1`, [sid]);
      // Los límites son del CLIENTE (sus cuentas de LinkedIn), no de la campaña: lo que ya consumen las demás secuencias automáticas activas se descuenta
      const { rows: otras } = await pool.query(`SELECT s.id, s.nombre, s.drip_per_day, (SELECT COUNT(*)::int FROM lm_contact_sequences x WHERE x.sequence_id=s.id AND x.estado='activo') AS activos FROM sequences s WHERE s.user_id=$1 AND s.outbound_client_id=$2 AND s.id<>$3 AND s.estado='activa' AND s.linkedin_auto`, [uid, sq.outbound_client_id || 0, sid]);
      const reservado = { inv: 0, vis: 0, msg: 0, inmail: 0, react: 0, follow: 0, comment: 0 };
      const MAPA = { visita: 'vis', invite: 'inv', invite_nota: 'inv', mensaje: 'msg', inmail: 'inmail', like: 'react', follow: 'follow', comentario: 'comment' };
      for (const o of otras) {
        const { rows: os } = await pool.query(`SELECT st.accion, st.cond, c.canal AS cond_canal FROM sequence_steps st LEFT JOIN sequence_steps c ON c.id = st.cond_step_id WHERE st.sequence_id=$1 AND st.canal='linkedin'`, [o.id]);
        const ritmo = o.drip_per_day || Math.min(10, o.activos || 0);
        for (const p of os) { const k = MAPA[p.accion]; if (!k) continue; const f = p.cond === 'replied' ? 0.3 : p.cond === 'no_reply' ? 0.7 : 1; reservado[k] += ritmo * f; }
      }
      const real7d = { inv: 0, vis: 0, msg: 0, inmail: 0, react: 0, follow: 0, comment: 0 };
      if (cuentas.length) {
        const { rows: rr } = await pool.query(`SELECT tipo, COUNT(*)::int AS n FROM li_actions WHERE account_id = ANY($1::int[]) AND estado='done' AND sequence_id IS DISTINCT FROM $2 AND done_at > NOW() - INTERVAL '7 days' AND tipo IN ('visit','invite','message','inmail','react','follow','comment') GROUP BY tipo`, [cuentas.map(a => a.id), sid]);
        const T = { visit: 'vis', invite: 'inv', message: 'msg', inmail: 'inmail', react: 'react', follow: 'follow', comment: 'comment' };
        rr.forEach(r => { real7d[T[r.tipo]] = +(r.n / 5).toFixed(1); });
      }
      Object.keys(reservado).forEach(k => { reservado[k] = Math.round(Math.max(reservado[k], real7d[k]) * 10) / 10; });
      const { rows: [qo] } = cuentas.length ? await pool.query(`SELECT COUNT(*)::int AS n FROM li_actions WHERE account_id = ANY($1::int[]) AND estado='queued' AND sequence_id IS DISTINCT FROM $2`, [cuentas.map(a => a.id), sid]) : { rows: [{ n: 0 }] };
      // Avance real: contactos que ya pasaron el paso 1 (con su paso actual) y lo que las cuentas ya hicieron HOY
      const { rows: av } = await pool.query("SELECT paso, estado='activo' AS activo, COUNT(*)::int AS n FROM lm_contact_sequences WHERE sequence_id=$1 AND paso > 1 GROUP BY 1,2", [sid]);
      const hoy = { inv: 0, vis: 0, msg: 0, inmail: 0, react: 0, follow: 0, comment: 0 };
      if (cuentas.length) {
        const tz0 = a0.tz || DEF.tz, { rows: hh } = await pool.query("SELECT tipo, COUNT(*)::int AS n FROM li_actions WHERE account_id = ANY($1::int[]) AND estado='done' AND done_at >= ((NOW() AT TIME ZONE $2)::date::timestamp AT TIME ZONE $2) GROUP BY tipo", [cuentas.map(a => a.id), tz0]);
        const T2 = { visit: 'vis', invite: 'inv', message: 'msg', inmail: 'inmail', react: 'react', follow: 'follow', comment: 'comment' };
        hh.forEach(r => { if (T2[r.tipo]) hoy[T2[r.tipo]] = r.n; });
      }
      // Invitaciones de ESTA secuencia en los 6 días anteriores (el tope semanal cuenta una ventana de 7 días): [hace 6 días … ayer]
      const inv_hist = [0, 0, 0, 0, 0, 0];
      if (cuentas.length) {
        const tz1 = a0.tz || DEF.tz, { rows: ih } = await pool.query("SELECT ((NOW() AT TIME ZONE $3)::date - (done_at AT TIME ZONE $3)::date) AS ago, COUNT(*)::int AS n FROM li_actions WHERE sequence_id=$1 AND account_id = ANY($2::int[]) AND tipo='invite' AND estado='done' AND done_at >= (((NOW() AT TIME ZONE $3)::date - 6)::timestamp AT TIME ZONE $3) GROUP BY 1", [sid, cuentas.map(a => a.id), tz1]);
        ih.forEach(r => { const ago = Number(r.ago); if (ago >= 1 && ago <= 6) inv_hist[6 - ago] = r.n; });
      }
      // Lo que de verdad pasó en los últimos 7 días (todas las acciones de las cuentas del cliente) y cuánto cabe aún HOY en lo que queda de horario
      const pasado = []; let resto_hoy = null;
      if (cuentas.length) {
        const tz2 = a0.tz || DEF.tz, dias2 = a0.dias || DEF.dias, lpN = localParts(new Date(), tz2);
        const { rows: ph } = await pool.query("SELECT ((NOW() AT TIME ZONE $2)::date - (done_at AT TIME ZONE $2)::date) AS ago, tipo, COUNT(*)::int AS n FROM li_actions WHERE account_id = ANY($1::int[]) AND estado='done' AND tipo IN ('visit','invite','message','inmail','react','follow','comment') AND done_at >= (((NOW() AT TIME ZONE $2)::date - 7)::timestamp AT TIME ZONE $2) GROUP BY 1,2", [cuentas.map(a => a.id), tz2]);
        for (let ago = 7; ago >= 1; ago--) {
          const t = new Date(Date.parse(lpN.ymd + 'T00:00:00Z') - ago * 864e5), dow = t.getUTCDay() === 0 ? 7 : t.getUTCDay(), row = { ymd: t.toISOString().slice(0, 10), laborable: dias2.includes(dow), vis: 0, inv: 0, msg: 0, inmail: 0, otros: 0, total: 0 };
          ph.filter(r => Number(r.ago) === ago).forEach(r => { const k = { visit: 'vis', invite: 'inv', message: 'msg', inmail: 'inmail' }[r.tipo] || 'otros'; row[k] += r.n; row.total += r.n; });
          pasado.push(row);
        }
        resto_hoy = 0;
        for (const a of cuentas) {
          const lp = localParts(new Date(), a.tz || DEF.tz);
          if (!(a.dias || DEF.dias).includes(lp.dow) || !['activa'].includes(a.estado)) continue;
          const pd = perfilDia(a, lp.ymd); let h = pd.fin - Math.max(lp.hour, pd.ini);
          if (pd.pausa && lp.hour < pd.pausa[1]) h -= pd.pausa[1] - Math.max(lp.hour, pd.pausa[0]);
          if (h > 0) resto_hoy += Math.floor(h * 3600 / (Math.max(20, a.gap_min || 300) * 1.1));
        }
      }
      // Ritmo máximo por horario y espera mínima entre acciones (una sola acción a la vez por cuenta): ~1,5 h menos por el arranque/cierre aleatorio y el descanso
      const ritmo_max = cuentas.length ? cuentas.reduce((t, a) => t + Math.floor(Math.max(1, (a.hora_fin - a.hora_ini) - ((a.hora_fin - a.hora_ini) >= 6 ? 1.5 : 0.6)) * 3600 / (Math.max(20, a.gap_min || 300) * 1.1)), 0) : null;
      res.json({ avance: av, hoy, inv_hist, pasado, resto_hoy, ritmo_max, otras: { secuencias: otras.map(o => ({ id: o.id, nombre: o.nombre, activos: o.activos })), reservado, real7d, en_cola: qo.n }, steps, caps, cuentas: cuentas.length, sin_cuenta: sinCuenta, ramp, drip: sq.drip_per_day || 0, send_days: sq.send_days || '1111100', starts_on: sq.starts_on, tz: sq.timezone || '', contactos: ct });
    } catch (e) { console.error('[li] capacidad', e.message); res.status(500).json({ error: 'No se pudo cargar' }); }
  });

  // Avisos de una secuencia: qué pasos de LinkedIn no se pueden automatizar ahora y se harán a mano
  app.get('/api/li/sequence/:id/avisos', requireAuth, async (req, res) => {
    try {
      const sid = parseInt(req.params.id, 10);
      const { rows: [sq] } = await pool.query(`SELECT id, linkedin_auto, li_plan, li_modo, outbound_client_id FROM sequences WHERE id=$1 AND user_id=$2`, [sid, req.workspaceOwnerId]);
      if (!sq || !sq.linkedin_auto) return res.json({ avisos: [] });
      const { rows: st } = await pool.query(`SELECT accion, COUNT(*)::int AS n FROM sequence_steps WHERE sequence_id=$1 AND canal='linkedin' AND accion IN ('comentario','inmail') GROUP BY accion`, [sid]);
      const n = x => (st.find(r => r.accion === x) || {}).n || 0, avisos = [];
      if (n('comentario') && !process.env.ANTHROPIC_API_KEY) avisos.push({ tipo: 'comentario', msg: 'Falta la clave de IA en el servidor: los pasos «Comentar una publicación» se harán a mano (aparecen como tarea).' });
      if (n('inmail') && sq.li_plan !== 'premium') avisos.push({ tipo: 'inmail', msg: 'La campaña tiene cuenta de LinkedIn gratuita: los pasos de InMail se harán a mano. Si tienes Premium o Sales Navigator, márcalo en la configuración de la campaña.' });
      if (n('inmail') && sq.li_plan === 'premium') {
        const { rows: [bl] } = await pool.query(`SELECT MAX(inmail_bloqueado_hasta) AS h FROM li_accounts WHERE user_id=$1 AND outbound_client_id=$2`, [req.workspaceOwnerId, sq.outbound_client_id || 0]);
        if (bl && bl.h && new Date(bl.h) > new Date()) avisos.push({ tipo: 'inmail', msg: 'LinkedIn no ofreció InMail en el último intento (sin créditos o la suscripción venció): los pasos de InMail van a mano hasta ' + new Date(bl.h).toLocaleString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) + '. El resto de pasos sigue normal.' });
      }
      res.json({ avisos });
    } catch (e) { res.json({ avisos: [] }); }
  });

  app.post('/api/li/ext/activar', liAuth, async (req, res) => {
    try {
      const a = req.liAcc;
      if (a.estado === 'restringida' || (a.estado === 'pausada' && a.pausa_hasta && new Date(a.pausa_hasta) > new Date())) return res.json({ ok: false, estado: a.estado, motivo: a.motivo });
      if (a.estado === 'pausada' || a.estado === 'desconectada') await pool.query(`UPDATE li_accounts SET estado='activa', motivo='', pausa_hasta=NULL WHERE id=$1`, [a.id]);
      // Al activar NO sale una acción al instante (huella clara: «lo prendí y ya hizo algo»): se sortea una espera de 3–9 min.
      // Solo en modo prueba (botón «Probar ahora») se salta la espera.
      const prueba = !!(req.body && req.body.prueba);
      await pool.query(prueba ? `UPDATE li_accounts SET proxima_accion_at = NOW() - INTERVAL '1 second' WHERE id=$1` : `UPDATE li_accounts SET proxima_accion_at = NOW() + ($2 || ' seconds')::interval WHERE id=$1`, prueba ? [a.id] : [a.id, String(180 + Math.floor(Math.random() * 360))]);
      res.json({ ok: true, estado: 'activa', prueba });
    } catch (e) { console.error('[li] activar', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // Registro de errores de la extensión (para que la persona pueda decir «falló X» y se vea qué pasó). Solo texto corto, nunca datos de LinkedIn.
  app.post('/api/li/ext/log', liAuth, async (req, res) => {
    try {
      const a = req.liAcc, b = req.body || {};
      const items = (Array.isArray(b.items) ? b.items : [b]).slice(0, 20);
      for (const it of items) {
        const ctx = it.ctx && typeof it.ctx === 'object' ? JSON.stringify(it.ctx).slice(0, 4000) : null;
        await pool.query(`INSERT INTO li_ext_log (user_id, account_id, nivel, tipo, msg, ctx, version) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [a.user_id, a.id, ['error', 'aviso', 'info'].includes(it.nivel) ? it.nivel : 'error', String(it.tipo || '').slice(0, 60), String(it.msg || '').slice(0, 600), ctx, String(it.version || '').slice(0, 20)]);
      }
      await pool.query(`DELETE FROM li_ext_log WHERE account_id=$1 AND id NOT IN (SELECT id FROM li_ext_log WHERE account_id=$1 ORDER BY id DESC LIMIT 500)`, [a.id]);
      res.json({ ok: true });
    } catch (e) { console.error('[li] log', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.get('/api/li/ext-log', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT l.id, l.nivel, l.tipo, l.msg, l.ctx, l.version, l.created_at, a.nombre AS cuenta FROM li_ext_log l LEFT JOIN li_accounts a ON a.id=l.account_id WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 200`, [req.workspaceOwnerId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'No se pudo cargar el registro' }); }
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
      const mb = (req.body || {}).modo, modo = mb === 'auto' ? 'auto' : 'asistido', auto = mb ? mb !== 'manual' : !!(req.body || {}).auto;
      const { rows: [sq] } = await pool.query(`UPDATE sequences SET linkedin_auto=$3, li_modo=$4, li_plan=COALESCE($5, li_plan) WHERE id=$1 AND user_id=$2 RETURNING id, linkedin_auto, li_modo, outbound_client_id`, [parseInt(req.params.id, 10), req.workspaceOwnerId, auto, modo, ['gratis', 'premium'].includes((req.body || {}).plan) ? req.body.plan : null]);
      if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
      const { rows: [cu] } = await pool.query(`SELECT COUNT(*)::int AS n FROM li_accounts WHERE user_id=$1 AND outbound_client_id=$2`, [req.workspaceOwnerId, sq.outbound_client_id || 0]);
      res.json({ ok: true, auto: sq.linkedin_auto, modo: sq.li_modo, cuentas_del_cliente: cu.n });
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
