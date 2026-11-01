'use strict';
// Hojas de horas (estilo ClickUp) sobre time_entries:
//  · ts_settings: «Cronograma de trabajo» (días y horas laborables, días libres) + aprobaciones (fecha límite y recordatorios).
//  · ts_submissions: hoja semanal enviada por un miembro y su revisión (aprobada / rechazada).
//  · /team: horas por persona y día de una semana (vista «Todas las hojas de horas»).
const TZ = 'America/Lima';
const isoD = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
const isoT = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = s => { const d = new Date(s + 'T12:00:00Z'); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const hrs = (a, b) => Math.max(0, ((+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3))) / 60);

function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS ts_settings (
        user_id INTEGER PRIMARY KEY, dias_laborales INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}', hora_ini TEXT NOT NULL DEFAULT '09:00', hora_fin TEXT NOT NULL DEFAULT '17:00',
        no_laborales JSONB NOT NULL DEFAULT '[]', aprob_activas BOOLEAN NOT NULL DEFAULT FALSE, limite_dia INTEGER NOT NULL DEFAULT 5, limite_hora TEXT NOT NULL DEFAULT '17:00',
        rec_antes_h INTEGER NOT NULL DEFAULT 24, rec_despues_h INTEGER NOT NULL DEFAULT 8, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ts_submissions (
        id SERIAL PRIMARY KEY, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, week_start DATE NOT NULL, status TEXT NOT NULL DEFAULT 'enviada',
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_by INTEGER, reviewed_at TIMESTAMPTZ, nota TEXT NOT NULL DEFAULT '', UNIQUE (user_id, week_start))`);
      await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS facturable BOOLEAN`);
      await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS etiquetas JSONB NOT NULL DEFAULT '[]'::jsonb`);
    } catch (e) { console.warn('[timesheets] init', e.message); }
  })();

  const isAdmin = async (uid, wid) => {
    if (uid === wid) return true;
    const rr = await pool.query(`SELECT rol FROM team_members WHERE user_id=$1 AND email=(SELECT email FROM users WHERE id=$2)`, [wid, uid]);
    return ['admin', 'manager'].includes(rr.rows[0] && rr.rows[0].rol || '');
  };
  const getSettings = async wid => {
    const { rows: [r] } = await pool.query(`SELECT * FROM ts_settings WHERE user_id=$1`, [wid]);
    const s = r || { dias_laborales: [1, 2, 3, 4, 5], hora_ini: '09:00', hora_fin: '17:00', no_laborales: [], aprob_activas: false, limite_dia: 5, limite_hora: '17:00', rec_antes_h: 24, rec_despues_h: 8 };
    return { dias_laborales: s.dias_laborales, hora_ini: s.hora_ini, hora_fin: s.hora_fin, no_laborales: s.no_laborales || [], aprob_activas: !!s.aprob_activas, limite_dia: s.limite_dia, limite_hora: s.limite_hora, rec_antes_h: s.rec_antes_h, rec_despues_h: s.rec_despues_h };
  };
  // capacidad (segundos) de una semana que empieza el lunes ws
  const capacidad = (s, ws) => {
    const libres = new Set((s.no_laborales || []).map(x => x.fecha)), h = hrs(s.hora_ini, s.hora_fin); let tot = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(ws, i), dow = ((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1; if (s.dias_laborales.includes(dow) && !libres.has(d)) tot += h * 3600; }
    return tot;
  };

  app.get('/api/timesheets/settings', requireAuth, async (req, res) => {
    try { const s = await getSettings(req.workspaceOwnerId); res.json({ ...s, admin: await isAdmin(req.user.id, req.workspaceOwnerId) }); }
    catch (e) { res.status(500).json({ error: 'No se pudo cargar la configuración' }); }
  });

  app.put('/api/timesheets/settings', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId, b = req.body || {};
      if (!(await isAdmin(req.user.id, wid))) return res.status(403).json({ error: 'Solo admin' });
      const cur = await getSettings(wid);
      const dias = Array.isArray(b.dias_laborales) ? [...new Set(b.dias_laborales.map(x => parseInt(x, 10)).filter(x => x >= 1 && x <= 7))].sort() : cur.dias_laborales;
      const hi = isoT(b.hora_ini) || cur.hora_ini, hf = isoT(b.hora_fin) || cur.hora_fin;
      if (hrs(hi, hf) <= 0) return res.status(400).json({ error: 'La hora de fin debe ser posterior a la de inicio' });
      const libres = Array.isArray(b.no_laborales) ? b.no_laborales.map(x => ({ fecha: isoD(x && x.fecha), nombre: String(x && x.nombre || '').trim().slice(0, 60) })).filter(x => x.fecha).slice(0, 200) : cur.no_laborales;
      const lim = b.limite_dia != null ? Math.min(7, Math.max(1, parseInt(b.limite_dia, 10) || cur.limite_dia)) : cur.limite_dia;
      const rec = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 168 ? n : d; };
      await pool.query(`INSERT INTO ts_settings (user_id, dias_laborales, hora_ini, hora_fin, no_laborales, aprob_activas, limite_dia, limite_hora, rec_antes_h, rec_despues_h, updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (user_id) DO UPDATE SET dias_laborales=EXCLUDED.dias_laborales, hora_ini=EXCLUDED.hora_ini, hora_fin=EXCLUDED.hora_fin, no_laborales=EXCLUDED.no_laborales, aprob_activas=EXCLUDED.aprob_activas,
          limite_dia=EXCLUDED.limite_dia, limite_hora=EXCLUDED.limite_hora, rec_antes_h=EXCLUDED.rec_antes_h, rec_despues_h=EXCLUDED.rec_despues_h, updated_at=NOW()`,
        [wid, dias, hi, hf, JSON.stringify(libres), b.aprob_activas != null ? !!b.aprob_activas : cur.aprob_activas, lim, isoT(b.limite_hora) || cur.limite_hora, rec(b.rec_antes_h, cur.rec_antes_h), rec(b.rec_despues_h, cur.rec_despues_h)]);
      res.json(await getSettings(wid));
    } catch (e) { console.error('[timesheets] settings', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  // horas por persona y día (lunes a domingo, hora de Lima) + estado de su hoja
  const weekData = async (wid, ws) => {
    const we = addDays(ws, 6), s = await getSettings(wid);
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, COALESCE(tm.nombre, u.name, u.email) AS nombre,
              to_char(te.started_at AT TIME ZONE $4, 'YYYY-MM-DD') AS dia,
              COALESCE(SUM(CASE WHEN te.ended_at IS NULL THEN GREATEST(te.duration_s, EXTRACT(EPOCH FROM (NOW() - te.started_at))::int) ELSE te.duration_s END), 0)::int AS seg,
              COALESCE(SUM(CASE WHEN te.ended_at IS NULL THEN GREATEST(te.duration_s, EXTRACT(EPOCH FROM (NOW() - te.started_at))::int) ELSE te.duration_s END)
                FILTER (WHERE COALESCE(te.facturable, (p.tipo_proyecto='horas' AND COALESCE(p.tarifa_hora,0) > 0))), 0)::int AS fact,
              COUNT(te.id) FILTER (WHERE te.approved) AS aprobadas, COUNT(te.id) AS total
         FROM users u
         LEFT JOIN team_members tm ON tm.email=u.email AND tm.user_id=$1
         LEFT JOIN time_entries te ON te.user_id=u.id AND COALESCE(te.source,'manual_timer') NOT IN ('browser_extension','desktop_agent')
              AND te.started_at >= ($2::date)::timestamp AT TIME ZONE $4 AND te.started_at < (($3::date + 1)::timestamp) AT TIME ZONE $4
         LEFT JOIN tasks t ON t.id=te.task_id LEFT JOIN projects p ON p.id=t.project_id
        WHERE u.workspace_id=$1 OR u.id=$1
        GROUP BY u.id, tm.nombre, u.name, u.email, dia ORDER BY nombre`, [wid, ws, we, TZ]);
    const { rows: subs } = await pool.query(`SELECT user_id, status, nota, submitted_at, reviewed_at FROM ts_submissions WHERE workspace_id=$1 AND week_start=$2`, [wid, ws]);
    const subBy = new Map(subs.map(r => [r.user_id, r])), people = new Map();
    for (const r of rows) {
      if (!people.has(r.user_id)) people.set(r.user_id, { user_id: r.user_id, nombre: r.nombre, dias: {}, total: 0, facturable: 0, aprobadas: 0, entradas: 0 });
      const p = people.get(r.user_id);
      if (r.dia) { p.dias[r.dia] = r.seg; p.total += r.seg; p.facturable += r.fact; p.aprobadas += Number(r.aprobadas); p.entradas += Number(r.total); }
    }
    const cap = capacidad(s, ws);
    return { week_start: ws, capacidad_s: cap, personas: [...people.values()].map(p => { const sb = subBy.get(p.user_id); return { ...p, capacidad_s: cap, excede_s: Math.max(0, p.total - cap), estado: sb ? sb.status : 'pendiente', nota: sb ? sb.nota : '', enviada_at: sb ? sb.submitted_at : null }; }), settings: s };
  };

  app.get('/api/timesheets/team', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId; if (!(await isAdmin(req.user.id, wid))) return res.status(403).json({ error: 'Solo admin' });
      const ws = isoD(req.query.week_start); if (!ws) return res.status(400).json({ error: 'week_start requerido' });
      res.json(await weekData(wid, mondayOf(ws)));
    } catch (e) { console.error('[timesheets] team', e.message); res.status(500).json({ error: 'No se pudo cargar el equipo' }); }
  });

  // mi hoja: estado de envío de la semana
  app.get('/api/timesheets/mine', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId, ws = mondayOf(isoD(req.query.week_start) || new Date().toISOString().slice(0, 10));
      const s = await getSettings(wid);
      const { rows: [sb] } = await pool.query(`SELECT status, nota, submitted_at, reviewed_at FROM ts_submissions WHERE user_id=$1 AND week_start=$2`, [req.user.id, ws]);
      res.json({ week_start: ws, capacidad_s: capacidad(s, ws), settings: s, estado: sb ? sb.status : 'pendiente', nota: sb ? sb.nota : '', enviada_at: sb ? sb.submitted_at : null });
    } catch (e) { res.status(500).json({ error: 'No se pudo cargar' }); }
  });

  app.post('/api/timesheets/submit', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId, ws = mondayOf(isoD((req.body || {}).week_start) || '');
      if (!isoD((req.body || {}).week_start)) return res.status(400).json({ error: 'week_start requerido' });
      const { rows: [cur] } = await pool.query(`SELECT status FROM ts_submissions WHERE user_id=$1 AND week_start=$2`, [req.user.id, ws]);
      if (cur && cur.status === 'aprobada') return res.status(400).json({ error: 'Esta hoja ya fue aprobada' });
      await pool.query(`INSERT INTO ts_submissions (workspace_id, user_id, week_start, status) VALUES ($1,$2,$3,'enviada')
        ON CONFLICT (user_id, week_start) DO UPDATE SET status='enviada', submitted_at=NOW(), reviewed_by=NULL, reviewed_at=NULL, nota=''`, [wid, req.user.id, ws]);
      res.json({ ok: true, estado: 'enviada' });
    } catch (e) { res.status(500).json({ error: 'No se pudo enviar la hoja' }); }
  });

  // revisión de una hoja: aprobar (bloquea sus entradas), rechazar (con nota) o reabrir
  app.post('/api/timesheets/review', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId, b = req.body || {}; if (!(await isAdmin(req.user.id, wid))) return res.status(403).json({ error: 'Solo admin' });
      const uid = parseInt(b.user_id, 10), wsRaw = isoD(b.week_start), accion = String(b.accion || '');
      if (!uid || !wsRaw || !['aprobar', 'rechazar', 'reabrir'].includes(accion)) return res.status(400).json({ error: 'Datos no válidos' });
      const ws = mondayOf(wsRaw), we = addDays(ws, 6);
      const ok = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND (workspace_id=$2 OR id=$2)`, [uid, wid]); if (!ok.rowCount) return res.status(404).json({ error: 'Miembro no encontrado' });
      const status = accion === 'aprobar' ? 'aprobada' : accion === 'rechazar' ? 'rechazada' : 'pendiente';
      const nota = String(b.nota || '').trim().slice(0, 300);
      await pool.query(`INSERT INTO ts_submissions (workspace_id, user_id, week_start, status, reviewed_by, reviewed_at, nota) VALUES ($1,$2,$3,$4,$5,NOW(),$6)
        ON CONFLICT (user_id, week_start) DO UPDATE SET status=EXCLUDED.status, reviewed_by=EXCLUDED.reviewed_by, reviewed_at=NOW(), nota=EXCLUDED.nota`, [wid, uid, ws, status, req.user.id, nota]);
      const aprob = accion === 'aprobar';
      const r = await pool.query(`UPDATE time_entries SET approved=$1, approved_at=$2, approved_by=$3
         WHERE user_id=$4 AND COALESCE(source,'manual_timer') NOT IN ('browser_extension','desktop_agent') AND ended_at IS NOT NULL
           AND started_at >= ($5::date)::timestamp AT TIME ZONE $7 AND started_at < (($6::date + 1)::timestamp) AT TIME ZONE $7`,
        [aprob, aprob ? new Date().toISOString() : null, aprob ? req.user.id : null, uid, ws, we, TZ]);
      res.json({ ok: true, estado: status, entradas: r.rowCount });
    } catch (e) { console.error('[timesheets] review', e.message); res.status(500).json({ error: 'No se pudo guardar la revisión' }); }
  });
  // edición ligera de una entrada (descripción, facturable, etiquetas) sin tocar tarea ni duración.
  // Miembro: solo las suyas y no aprobadas. Admin: cualquiera del espacio.
  app.patch('/api/timer/:id/meta', requireAuth, async (req, res) => {
    try {
      const uid = req.user.id, wid = req.workspaceOwnerId, id = parseInt(req.params.id, 10), b = req.body || {};
      const { rows: [cur] } = await pool.query(`SELECT * FROM time_entries WHERE id=$1`, [id]); if (!cur) return res.status(404).json({ error: 'Entrada no encontrada' });
      const admin = await isAdmin(uid, wid), own = cur.user_id === uid;
      const inWs = admin && (await pool.query(`SELECT 1 FROM users WHERE id=$1 AND (workspace_id=$2 OR id=$2)`, [cur.user_id, wid])).rowCount > 0;
      if (!(own || inWs)) return res.status(403).json({ error: 'Sin permiso' });
      if (own && !admin && cur.approved) return res.status(403).json({ error: 'Entrada aprobada: pide a un admin que la reabra' });
      const notes = b.notes != null ? String(b.notes).slice(0, 1000) : cur.notes;
      const fact = 'facturable' in b ? (b.facturable === null ? null : !!b.facturable) : cur.facturable;
      const etq = Array.isArray(b.etiquetas) ? [...new Set(b.etiquetas.map(x => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, 10) : (cur.etiquetas || []);
      const { rows: [r] } = await pool.query(`UPDATE time_entries SET notes=$2, facturable=$3, etiquetas=$4::jsonb WHERE id=$1 RETURNING id, notes, facturable, etiquetas`, [id, notes, fact, JSON.stringify(etq)]);
      res.json(r);
    } catch (e) { console.error('[timesheets] meta', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });
}
module.exports = { mount };
