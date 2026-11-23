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
  if (hist.total_hoy >= ef.total) return { ok: false, motivo: 'tope_total_dia', espera_s: 3600 };
  const caps = { invite: [hist.inv_hoy, ef.inv], message: [hist.msg_hoy, ef.msg], visit: [hist.vis_hoy, ef.vis], inmail: [hist.inmail_hoy, ef.inmail] }[tipo];
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
       COUNT(*) FILTER (WHERE done_at > $2::timestamptz - INTERVAL '24 hours')::int AS total_hoy,
       COUNT(*) FILTER (WHERE tipo='invite' AND done_at > $2::timestamptz - INTERVAL '7 days')::int AS inv_semana,
       COUNT(*) FILTER (WHERE tipo='invite' AND nota <> '' AND done_at > $2::timestamptz - INTERVAL '30 days')::int AS notas_mes,
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

function mount(app, { pool, requireAuth }) {
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
      if (b.sesion === false) {
        await pool.query(`UPDATE li_accounts SET estado='desconectada', motivo='La sesión de LinkedIn de ese Chrome no está iniciada' WHERE id=$1 AND estado = 'activa'`, [a.id]);
        return res.json({ accion: null, espera_s: 600, motivo: 'sesion_cerrada' });
      }
      if (a.estado === 'desconectada') await pool.query(`UPDATE li_accounts SET estado='activa', motivo='' WHERE id=$1`, [a.id]), a.estado = 'activa';
      // Una acción «en curso» sin respuesta se marca fallida: no se reintenta (podría haberse enviado)
      await pool.query(`UPDATE li_actions SET estado='failed', error='sin_respuesta', detalle='La extensión no confirmó el resultado; revisa en LinkedIn antes de repetir' WHERE account_id=$1 AND estado='taken' AND taken_at < NOW() - ($2 || ' minutes')::interval`, [a.id, String(TAKEN_TIMEOUT_MIN)]);
      if (a.estado !== 'activa' && !(a.pausa_hasta && new Date(a.pausa_hasta) <= now)) return res.json({ accion: null, espera_s: 300, motivo: 'cuenta_' + a.estado });
      if (a.estado !== 'activa') { await pool.query(`UPDATE li_accounts SET estado='activa', motivo='', pausa_hasta=NULL WHERE id=$1`, [a.id]); a.estado = 'activa'; a.pausa_hasta = null; }
      const { rows: [enCurso] } = await pool.query(`SELECT 1 FROM li_actions WHERE account_id=$1 AND estado='taken' LIMIT 1`, [a.id]);
      if (enCurso) return res.json({ accion: null, espera_s: 60, motivo: 'accion_en_curso' });
      const hist = await historial(pool, a, now);
      const { rows: cola } = await pool.query(`SELECT * FROM li_actions WHERE account_id=$1 AND estado='queued' AND (not_before IS NULL OR not_before <= NOW()) ORDER BY id LIMIT 30`, [a.id]);
      if (!cola.length) return res.json({ accion: null, espera_s: 60, motivo: 'cola_vacia' });
      let mejor = null, espera = 3600, motivo = '';
      const rnd = Math.random();
      for (const q of cola) {
        const ev = evaluar(a, hist, q.tipo, now, rnd, !!(q.nota && q.nota.trim()));
        if (ev.ok) { mejor = q; break; }
        if (ev.espera_s < espera) { espera = ev.espera_s; motivo = ev.motivo; }
      }
      if (!mejor) return res.json({ accion: null, espera_s: espera, motivo });
      const { rowCount } = await pool.query(`UPDATE li_actions SET estado='taken', taken_at=NOW() WHERE id=$1 AND estado='queued'`, [mejor.id]);
      if (!rowCount) return res.json({ accion: null, espera_s: 15, motivo: 'reintentar' });
      res.json({ accion: { id: mejor.id, tipo: mejor.tipo, url: mejor.url, slug: mejor.slug, nota: mejor.nota, texto: mejor.texto }, modo: a.modo });
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
      if (codigo === 'ok') {
        await pool.query(`UPDATE li_actions SET estado='done', done_at=NOW(), error='', detalle=$2 WHERE id=$1`, [id, det]);
        await pool.query(`UPDATE li_accounts SET fallos_seguidos=0 WHERE id=$1`, [a.id]);
      } else if (codigo === 'omitida') {
        await pool.query(`UPDATE li_actions SET estado='skipped', done_at=NOW(), error=$2, detalle=$3 WHERE id=$1`, [id, String(b.error || 'omitida').slice(0, 60), det]);
      } else if (codigo === 'restringida') {
        // LinkedIn avisó, pidió captcha o dijo «límite alcanzado»: se para TODO 48 h y el calentamiento vuelve a empezar
        await pool.query(`UPDATE li_actions SET estado='failed', error='restringida', detalle=$2 WHERE id=$1`, [id, det]);
        await pausar(pool, a.id, PAUSA_RESTRICCION_H, 'restringida', 'LinkedIn mostró un aviso o límite: pausa de 48 h. Entra a mano, revisa el aviso y reduce los topes', true);
      } else if (codigo === 'sesion') {
        await pool.query(`UPDATE li_actions SET estado='queued', taken_at=NULL WHERE id=$1`, [id]);   // no llegó a ejecutarse: vuelve a la cola
        await pool.query(`UPDATE li_accounts SET estado='desconectada', motivo='La sesión de LinkedIn se cerró' WHERE id=$1`, [a.id]);
      } else {
        await pool.query(`UPDATE li_actions SET estado='failed', error=$2, detalle=$3 WHERE id=$1`, [id, String(b.error || 'fallo').slice(0, 60), det]);
        const { rows: [u] } = await pool.query(`UPDATE li_accounts SET fallos_seguidos = fallos_seguidos + 1 WHERE id=$1 RETURNING fallos_seguidos`, [a.id]);
        if (u && u.fallos_seguidos >= FALLOS_PAUSA) await pausar(pool, a.id, PAUSA_FALLOS_H, 'pausada', `${FALLOS_PAUSA} fallos seguidos: pausa automática de 24 h. Puede que LinkedIn haya cambiado su página o haya un aviso`, false);
      }
      res.json({ ok: true });
    } catch (e) { console.error('[li] result', e.message); res.status(500).json({ error: 'Error' }); }
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
