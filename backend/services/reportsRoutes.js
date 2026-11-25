'use strict';
// Informes (estilo lemlist): Overview, Campañas, Actividad, Equipo y Llamadas + dashboards personalizados.
// Todo sale de datos reales de Nova: activities (toques manuales y automáticos), lm_messages (+ eventos de apertura/clic),
// li_actions, tel_calls, lm_contacts y las campañas/secuencias. «Representante» = responsable del cliente outbound.
// Filtros comunes: from/to, client, campaign, tags (de campañas), reps (responsables), roles, disp.

const IS_INVITE = `(a.tipo='linkedin_connect' OR ((a.tipo='nota' OR a.tipo LIKE 'linkedin%') AND a.nota ~ '^Paso [0-9]' AND (SELECT st.accion FROM lm_contact_sequences cs JOIN sequence_steps st ON st.sequence_id=cs.sequence_id WHERE cs.contact_id=a.contact_id ORDER BY cs.id DESC, st.dia, st.orden, st.id OFFSET (substring(a.nota from '^Paso ([0-9]+)')::int - 1) LIMIT 1) IN ('invite','invite_nota')))`;
const STEP_ACC = `(SELECT st.accion FROM lm_contact_sequences cs JOIN sequence_steps st ON st.sequence_id=cs.sequence_id WHERE cs.contact_id=a.contact_id AND a.nota ~ '^Paso [0-9]' ORDER BY cs.id DESC, st.dia, st.orden, st.id OFFSET (substring(a.nota from '^Paso ([0-9]+)')::int - 1) LIMIT 1)`;
const CH = `CASE WHEN a.tipo IN ('email_enviado','email') THEN 'email' WHEN a.tipo LIKE 'linkedin%' THEN 'linkedin' WHEN a.tipo='llamada' THEN 'call' WHEN a.canal='whatsapp_llamada' THEN 'wa_call' WHEN a.canal='whatsapp_mensaje' THEN 'wa_msg' ELSE COALESCE((SELECT CASE st.canal WHEN 'whatsapp' THEN (CASE WHEN st.accion IN ('llamada','llamar') THEN 'wa_call' ELSE 'wa_msg' END) WHEN 'call' THEN 'call' WHEN 'linkedin' THEN 'linkedin' WHEN 'email' THEN 'email' END FROM lm_contact_sequences cs JOIN sequence_steps st ON st.sequence_id=cs.sequence_id WHERE cs.contact_id=a.contact_id AND a.nota ~ '^Paso [0-9]' ORDER BY cs.id DESC, st.dia, st.orden, st.id OFFSET (substring(a.nota from '^Paso ([0-9]+)')::int - 1) LIMIT 1), CASE WHEN a.nota ~* 'whatsapp|wpp' THEN (CASE WHEN a.nota ~* 'llamada|call' THEN 'wa_call' ELSE 'wa_msg' END) WHEN a.nota ~* 'llamada|call' THEN 'call' WHEN a.nota ~* 'linkedin|inmail|invitaci' THEN 'linkedin' ELSE 'otros' END) END`;
const RTYPES = 'Interesado|Reunión|Más adelante|Derivó a otro|No interesado|No contactar';
const REPLY = `(a.tipo='respuesta' OR (a.tipo='disposition_change' AND a.nota ~ '→ (${RTYPES})[[:space:]]*$'))`;
const OUT = `a.estado='hecha' AND (a.tipo IN ('email_enviado','linkedin_msg','linkedin_connect','linkedin_visita','llamada') OR a.tipo LIKE 'linkedin%' OR (a.tipo='email' AND a.nota NOT LIKE '[Inbox] Respuesta%' AND a.nota NOT LIKE 'Solicitud de admin%') OR (a.tipo='nota' AND a.nota ~ '^Paso [0-9]'))`;
const KIND = `CASE WHEN (${CH})='email' THEN 'email' WHEN (${CH})='linkedin' THEN (CASE WHEN ${IS_INVITE} THEN 'li_invite' WHEN (a.tipo='linkedin_visita' OR ${STEP_ACC}='visita') THEN 'li_visit' ELSE 'li_msg' END) WHEN (${CH})='wa_msg' THEN 'whatsapp' WHEN (${CH}) IN ('call','wa_call') THEN 'call' ELSE 'otros' END`;
const INTERESADO_EV = `(a.tipo='disposition_change' AND a.nota ~ '→ (Interesado|Reunión)[[:space:]]*$')`;
const TASK_T = `('tarea','followup','revisar_respuesta','seguimiento_inactivo','seguimiento_aviso')`;
const REP = `COALESCE(NULLIF((SELECT oc.responsable FROM outbound_clients oc WHERE oc.id=k.outbound_client_id),''),'Sin responsable')`;
const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const csv = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
const sw = (s, from, to) => s.replace(new RegExp('\\b' + from + '\\.', 'g'), to + '.');

function mount(app, { pool, requireAuth, tzOfUser }) {
  pool.query(`CREATE TABLE IF NOT EXISTS report_views (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, created_by INTEGER, nombre TEXT NOT NULL, icono TEXT NOT NULL DEFAULT 'chart', visibilidad TEXT NOT NULL DEFAULT 'todos', widgets JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch(e => console.error('[reports] schema', e.message));

  // Opciones de los filtros: representantes (con rol) y etiquetas de campañas
  app.get('/api/lm/reports/filters', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId;
      const [oc, tm, tg] = await Promise.all([
        pool.query(`SELECT DISTINCT responsable FROM outbound_clients WHERE user_id=$1 AND COALESCE(responsable,'')<>''`, [uid]),
        pool.query(`SELECT nombre, rol FROM team_members WHERE user_id=$1`, [uid]),
        pool.query(`SELECT DISTINCT unnest(tags) AS t FROM campaigns WHERE user_id=$1 ORDER BY 1`, [uid]),
      ]);
      const rol = new Map(tm.rows.map(r => [String(r.nombre || '').toLowerCase(), String(r.rol || '').toLowerCase() === 'admin' ? 'admin' : 'member']));
      const reps = oc.rows.map(r => ({ nombre: r.responsable, rol: rol.get(String(r.responsable).toLowerCase()) || 'member' }));
      res.json({ reps, tags: tg.rows.map(r => r.t) });
    } catch (e) { console.error('[reports] filters', e.message); res.status(500).json({ error: 'No se pudieron cargar los filtros' }); }
  });

  // Dashboards personalizados (vistas): propias y las compartidas con todo el equipo
  app.get('/api/lm/report-views', requireAuth, async (req, res) => {
    try {
      const me = (req.user && req.user.id) || 0;
      const { rows } = await pool.query(`SELECT id, nombre, icono, visibilidad, widgets, created_by, (created_by=$2) AS mia FROM report_views WHERE user_id=$1 AND (visibilidad='todos' OR created_by=$2) ORDER BY id`, [req.workspaceOwnerId, me]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las vistas' }); }
  });
  const sanW = w => (Array.isArray(w) ? w : []).map(x => String(x).slice(0, 40)).slice(0, 40);
  app.post('/api/lm/report-views', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, nombre = String(b.nombre || '').trim().slice(0, 60);
      if (!nombre) return res.status(400).json({ error: 'Ponle un nombre a la vista' });
      const { rows: [v] } = await pool.query(`INSERT INTO report_views (user_id, created_by, nombre, icono, visibilidad, widgets) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id, nombre, icono, visibilidad, widgets, created_by, TRUE AS mia`,
        [req.workspaceOwnerId, (req.user && req.user.id) || null, nombre, String(b.icono || 'chart').slice(0, 20), b.visibilidad === 'yo' ? 'yo' : 'todos', JSON.stringify(sanW(b.widgets))]);
      res.status(201).json(v);
    } catch (e) { res.status(500).json({ error: 'No se pudo crear la vista' }); }
  });
  app.patch('/api/lm/report-views/:id', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, me = (req.user && req.user.id) || 0;
      const { rows: [cur] } = await pool.query('SELECT * FROM report_views WHERE id=$1 AND user_id=$2', [req.params.id, req.workspaceOwnerId]);
      if (!cur) return res.status(404).json({ error: 'Vista no encontrada' });
      if (cur.visibilidad === 'yo' && cur.created_by !== me) return res.status(403).json({ error: 'No es tu vista' });
      const nombre = b.nombre !== undefined ? String(b.nombre).trim().slice(0, 60) || cur.nombre : cur.nombre;
      const { rows: [v] } = await pool.query(`UPDATE report_views SET nombre=$3, icono=$4, visibilidad=$5, widgets=$6::jsonb WHERE id=$1 AND user_id=$2 RETURNING id, nombre, icono, visibilidad, widgets, created_by, (created_by=$7) AS mia`,
        [req.params.id, req.workspaceOwnerId, nombre, b.icono !== undefined ? String(b.icono).slice(0, 20) : cur.icono, b.visibilidad ? (b.visibilidad === 'yo' ? 'yo' : 'todos') : cur.visibilidad, JSON.stringify(b.widgets !== undefined ? sanW(b.widgets) : cur.widgets), me]);
      res.json(v);
    } catch (e) { res.status(500).json({ error: 'No se pudo guardar la vista' }); }
  });
  app.delete('/api/lm/report-views/:id', requireAuth, async (req, res) => {
    try {
      const me = (req.user && req.user.id) || 0;
      const { rowCount } = await pool.query(`DELETE FROM report_views WHERE id=$1 AND user_id=$2 AND (visibilidad='todos' OR created_by=$3)`, [req.params.id, req.workspaceOwnerId, me]);
      if (!rowCount) return res.status(404).json({ error: 'Vista no encontrada' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo eliminar la vista' }); }
  });

  app.get('/api/lm/reports/:tab', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, q = req.query, tab = req.params.tab;
      if (!['overview', 'campaigns', 'activity', 'team', 'calls'].includes(tab)) return res.status(404).json({ error: 'Informe no encontrado' });
      let tz = 'America/Lima'; try { const t = tzOfUser && await tzOfUser(req.user && req.user.id); if (t && /^[A-Za-z_\/+\-0-9]+$/.test(t)) tz = t; } catch (_) {}
      const today = new Date();
      const to = iso(q.to) ? q.to : today.toISOString().slice(0, 10);
      const from = iso(q.from) ? q.from : new Date(today.getTime() - 29 * 864e5).toISOString().slice(0, 10);
      const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5) + 1);
      const pFrom = new Date(new Date(from).getTime() - days * 864e5).toISOString().slice(0, 10), pTo = new Date(new Date(from).getTime() - 864e5).toISOString().slice(0, 10);
      const workdays = (f, t) => { let n = 0; for (let d = new Date(f + 'T12:00:00'); d <= new Date(t + 'T12:00:00'); d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; } return Math.max(1, n); };
      const dayDiv = q.workdays === '1' ? workdays(from, to) : days;
      const params = [uid], P = v => { params.push(v); return '$' + params.length; };
      let kw = 'k.user_id=$1';
      const client = parseInt(q.client); if (client) kw += ` AND k.outbound_client_id=${P(client)}`;
      const camp = parseInt(q.campaign), tags = csv(q.tags), cc = [];
      if (camp) cc.push(`s2.campaign_id=${P(camp)}`);
      if (tags.length) cc.push(`c2.tags && ${P(tags)}::text[]`);
      if (cc.length) kw += ` AND EXISTS(SELECT 1 FROM lm_contact_sequences x JOIN sequences s2 ON s2.id=x.sequence_id JOIN campaigns c2 ON c2.id=s2.campaign_id WHERE x.contact_id=k.id AND ${cc.join(' AND ')})`;
      let reps = csv(q.reps); const roles = csv(q.roles);
      if (roles.length) {
        const { rows } = await pool.query(`SELECT nombre FROM team_members WHERE user_id=$1 AND (CASE WHEN LOWER(rol)='admin' THEN 'admin' ELSE 'member' END) = ANY($2::text[])`, [uid, roles]);
        const names = rows.map(r => r.nombre); reps = reps.length ? reps.filter(n => names.includes(n)) : names; if (!reps.length) reps = ['\u0001ninguno'];
      }
      if (reps.length) kw += ` AND EXISTS(SELECT 1 FROM outbound_clients oc2 WHERE oc2.id=k.outbound_client_id AND oc2.responsable = ANY(${P(reps)}::text[]))`;
      if (q.disp) kw += ` AND k.disposition=${P(String(q.disp).slice(0, 40))}`;
      const base = `FROM activities a JOIN lm_contacts k ON k.id=a.contact_id WHERE ${kw}`;
      const inR = (col, f, t) => `${col}::date BETWEEN '${f}'::date AND '${t}'::date`;
      // Cada consulta recibe solo los parámetros que usa (Postgres exige que coincidan con los $N del SQL)
      const Q = (sql) => { let m = 0; sql.replace(/\$(\d+)/g, (_, n) => { m = Math.max(m, +n); return _; }); return pool.query(sql, params.slice(0, m)).then(r => r.rows); };
      const lit = arr => 'ARRAY[' + arr.map(x => "'" + String(x).replace(/'/g, "''") + "'").join(',') + ']::text[]';
      const one = async (sql) => (await Q(sql))[0] || {};

      // ── bloques reutilizables ──
      const periodStats = async (f, t) => one(`SELECT
        (SELECT COUNT(DISTINCT a.contact_id) ${base} AND ${OUT} AND ${inR('a.fecha', f, t)})::int AS intentados,
        (SELECT COUNT(DISTINCT m.contact_id) FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND m.estado='bounced' AND ${inR('m.sent_at', f, t)})::int AS bounce,
        (SELECT COUNT(DISTINCT a.contact_id) ${base} AND a.tipo='disposition_change' AND a.nota ~ '→ No interesado[[:space:]]*$' AND ${inR('a.fecha', f, t)})::int AS nointeresa,
        (SELECT COUNT(DISTINCT k.id) FROM lm_contacts k WHERE ${kw} AND (k.disposition='no_contactar' OR k.email_opt_out) AND ${inR('k.updated_at', f, t)})::int AS baja`);
      const taskStats = async (f, t) => one(`SELECT
        COUNT(*) FILTER (WHERE a.tipo IN ${TASK_T} AND ${inR('a.created_at', f, t)})::int AS creadas,
        COUNT(*) FILTER (WHERE a.tipo IN ${TASK_T} AND a.estado='hecha' AND ${inR('a.fecha', f, t)})::int AS hechas,
        COUNT(*) FILTER (WHERE a.tipo='paso_omitido' AND ${inR('a.fecha', f, t)})::int AS ignoradas
        ${base}`);
      const firstReach = async (cond) => (await Q(`SELECT d::text AS d, COUNT(*)::int AS n FROM (SELECT a.contact_id, MIN(a.fecha)::date AS d ${base} AND ${cond} GROUP BY a.contact_id) t WHERE d BETWEEN '${from}'::date AND '${to}'::date GROUP BY d ORDER BY d`));
      const timeline = async () => {
        const [c, r, i, m] = await Promise.all([firstReach(OUT), firstReach(REPLY), firstReach(INTERESADO_EV), firstReach(`(a.tipo='reunion' OR (a.tipo='disposition_change' AND a.nota ~ '→ Reunión[[:space:]]*$'))`)]);
        return { contactados: c, respondidos: r, interesados: i, reuniones: m };
      };
      const campaigns = async () => {
        const cw = [`c.user_id=$1`, `c.estado<>'archivada'`];
        if (client) cw.push(`c.outbound_client_id=${client}`);
        if (camp) cw.push(`c.id=${camp}`);
        if (tags.length) cw.push(`c.tags && ${lit(tags)}`);
        if (reps.length) cw.push(`EXISTS(SELECT 1 FROM outbound_clients oc3 WHERE oc3.id=c.outbound_client_id AND oc3.responsable = ANY(${lit(reps)}))`);
        const list = await Q(`SELECT c.id, c.nombre, c.canal, c.estado, c.tags, oc.nombre AS cliente, COALESCE(NULLIF(oc.responsable,''),'Sin responsable') AS rep FROM campaigns c LEFT JOIN outbound_clients oc ON oc.id=c.outbound_client_id WHERE ${cw.join(' AND ')} ORDER BY c.id DESC`);
        if (!list.length) return [];
        const ap = "ARRAY[" + list.map(c => parseInt(c.id)).join(',') + "]";
        const chw = q.canal && ['email', 'linkedin', 'whatsapp'].includes(q.canal) ? ` AND (${CH})='${q.canal === 'whatsapp' ? 'wa_msg' : q.canal}'` : '';
        const [act, msg] = await Promise.all([
          Q(`SELECT s.campaign_id AS cid, COUNT(DISTINCT cs.contact_id)::int AS enrolados,
                    COUNT(DISTINCT a.contact_id) FILTER (WHERE ${OUT}${chw} AND ${inR('a.fecha', from, to)})::int AS contactados,
                    COUNT(DISTINCT a.contact_id) FILTER (WHERE ${REPLY} AND ${inR('a.fecha', from, to)})::int AS respondidos,
                    COUNT(DISTINCT k.id) FILTER (WHERE k.disposition IN ('interesado','reunion'))::int AS interesados
               FROM sequences s JOIN lm_contact_sequences cs ON cs.sequence_id=s.id JOIN lm_contacts k ON k.id=cs.contact_id
               LEFT JOIN activities a ON a.contact_id=k.id AND a.fecha >= COALESCE((cs.start_date + TIME '12:00')::timestamptz, cs.created_at)
              WHERE s.user_id=$1 AND s.campaign_id = ANY(${ap}::int[]) GROUP BY s.campaign_id`),
          Q(`SELECT s.campaign_id AS cid, COUNT(*) FILTER (WHERE m.estado IN ('sent','replied','bounced'))::int AS enviados, COUNT(*) FILTER (WHERE m.estado='bounced')::int AS rebotados
               FROM lm_messages m JOIN sequences s ON s.id=m.sequence_id WHERE m.user_id=$1 AND s.campaign_id = ANY(${ap}::int[]) AND ${inR('m.sent_at', from, to)} GROUP BY s.campaign_id`),
        ]);
        const A = new Map(act.map(r => [r.cid, r])), M = new Map(msg.map(r => [r.cid, r]));
        return list.map(c => ({ ...c, enrolados: (A.get(c.id) || {}).enrolados || 0, contactados: (A.get(c.id) || {}).contactados || 0, respondidos: (A.get(c.id) || {}).respondidos || 0, interesados: (A.get(c.id) || {}).interesados || 0, enviados: (M.get(c.id) || {}).enviados || 0, rebotados: (M.get(c.id) || {}).rebotados || 0 }));
      };
      const outKinds = () => Q(`SELECT DISTINCT a.contact_id AS cid, ${KIND} AS kind, k.disposition AS disp, (k.li_aceptado_at IS NOT NULL) AS acc ${base} AND ${OUT} AND ${inR('a.fecha', from, to)}`);
      const setOf = rows => new Set(rows.map(r => r.cid));
      const out = { range: { from, to, days, prevFrom: pFrom, prevTo: pTo }, tz };

      if (tab === 'overview') {
        const [rows, rep, bnc, eng, ps, pp, ts, tp, open, tl, cp] = await Promise.all([
          outKinds(),
          Q(`SELECT DISTINCT a.contact_id AS cid ${base} AND ${REPLY} AND ${inR('a.fecha', from, to)}`),
          Q(`SELECT DISTINCT m.contact_id AS cid FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND m.estado='bounced' AND ${inR('m.sent_at', from, to)}`),
          Q(`SELECT DISTINCT m.contact_id AS cid FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND ${inR('m.sent_at', from, to)} AND EXISTS(SELECT 1 FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo IN ('open','click'))`),
          periodStats(from, to), periodStats(pFrom, pTo), taskStats(from, to), taskStats(pFrom, pTo),
          one(`SELECT COUNT(*) FILTER (WHERE a.estado='pendiente' AND a.tipo IN ${TASK_T})::int AS abiertas, COUNT(*) FILTER (WHERE a.estado='pendiente' AND a.tipo IN ${TASK_T} AND a.fecha < NOW())::int AS vencidas ${base}`),
          timeline(), campaigns(),
        ]);
        const R = setOf(rep), B = setOf(bnc), E = setOf(eng), ct = {};
        ['email', 'li_msg', 'li_invite', 'li_visit', 'whatsapp', 'call'].forEach(k => { ct[k] = { k, intentados: 0, entregados: 0, comprometidos: 0, respondidos: 0, interesados: 0, rebotados: 0 }; });
        rows.forEach(r => { const o = ct[r.kind]; if (!o) return; o.intentados++; if (r.kind === 'email' && B.has(r.cid)) o.rebotados++; else o.entregados++; if ((r.kind === 'email' && E.has(r.cid)) || (r.kind === 'li_invite' && r.acc)) o.comprometidos++; if (R.has(r.cid)) o.respondidos++; if (['interesado', 'reunion'].includes(r.disp)) o.interesados++; });
        Object.assign(out, { channelTable: Object.values(ct), problems: { cur: ps, prev: pp }, tasks: { cur: ts, prev: tp, ...open }, timeline: tl, campaigns: cp });
      } else if (tab === 'campaigns') {
        const [cp, tl, coh, stepsEm, stepsOt] = await Promise.all([
          campaigns(), timeline(),
          Q(`SELECT date_trunc('week', cs.created_at)::date::text AS semana, COUNT(DISTINCT cs.contact_id)::int AS enrolados,
                    COUNT(DISTINCT cs.contact_id) FILTER (WHERE EXISTS(SELECT 1 FROM activities a WHERE a.contact_id=cs.contact_id AND ${OUT} AND a.fecha>=cs.created_at))::int AS contactados,
                    COUNT(DISTINCT cs.contact_id) FILTER (WHERE EXISTS(SELECT 1 FROM activities a WHERE a.contact_id=cs.contact_id AND ${REPLY} AND a.fecha>=cs.created_at))::int AS respondidos,
                    COUNT(DISTINCT cs.contact_id) FILTER (WHERE k.disposition IN ('interesado','reunion'))::int AS interesados
               FROM lm_contact_sequences cs JOIN lm_contacts k ON k.id=cs.contact_id WHERE ${kw} AND ${inR('cs.created_at', from, to)} GROUP BY 1 ORDER BY 1`),
          Q(`SELECT st.canal, st.accion, COUNT(*)::int AS intentos, COUNT(*) FILTER (WHERE m.estado='replied' OR m.replied_at IS NOT NULL)::int AS respondidos, COUNT(*) FILTER (WHERE m.estado='bounced')::int AS rebotados
               FROM lm_messages m JOIN sequence_steps st ON st.id=m.step_id JOIN lm_contacts k ON k.id=m.contact_id
              WHERE m.user_id=$1 AND ${kw} AND m.estado IN ('sent','replied','bounced') AND ${inR('m.sent_at', from, to)} GROUP BY 1,2`),
          Q(`SELECT st.canal, st.accion, COUNT(*)::int AS intentos,
                    COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM activities r WHERE r.contact_id=a.contact_id AND ${sw(REPLY, 'a', 'r')} AND r.fecha>=a.fecha))::int AS respondidos, 0 AS rebotados
               FROM activities a JOIN lm_contacts k ON k.id=a.contact_id
               JOIN LATERAL (SELECT st2.canal, st2.accion FROM lm_contact_sequences cs JOIN sequence_steps st2 ON st2.sequence_id=cs.sequence_id WHERE cs.contact_id=a.contact_id ORDER BY cs.id DESC, st2.dia, st2.orden, st2.id OFFSET (substring(a.nota from '^Paso ([0-9]+)')::int - 1) LIMIT 1) st ON TRUE
              WHERE ${kw} AND a.estado='hecha' AND a.nota ~ '^Paso [0-9]' AND a.tipo<>'email_enviado' AND st.canal<>'email' AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
        ]);
        Object.assign(out, { campaigns: cp, timeline: tl, cohorts: coh, steps: [...stepsEm, ...stepsOt] });
      } else if (tab === 'activity') {
        const kpi = async (f, t) => one(`SELECT COUNT(*) FILTER (WHERE ${OUT})::int AS toques, COUNT(DISTINCT a.contact_id) FILTER (WHERE ${OUT})::int AS contactados,
              COUNT(DISTINCT a.contact_id) FILTER (WHERE ${REPLY})::int AS respuestas, COUNT(*) FILTER (WHERE ${OUT} AND ${IS_INVITE})::int AS invitaciones,
              COUNT(*) FILTER (WHERE ${OUT} AND (${CH})='email')::int AS emails, COUNT(*) FILTER (WHERE ${OUT} AND (${CH}) IN ('call','wa_call'))::int AS llamadas,
              COUNT(*) FILTER (WHERE ${OUT} AND (${CH})='wa_msg')::int AS whatsapps ${base} AND ${inR('a.fecha', f, t)}`);
        const cap = async () => {
          const [mb, li, wa, per, wl] = await Promise.all([
            Q(`SELECT mb.id, mb.email, mb.estado, mb.daily_limit, mb.ramp_on, mb.ramp_target FROM lm_mailboxes mb WHERE mb.user_id=$1${client ? ` AND mb.outbound_client_id=${client}` : ''}`),
            Q(`SELECT id, nombre, estado, total_dia FROM li_accounts WHERE user_id=$1${client ? ` AND outbound_client_id=${client}` : ''}`).catch(() => []),
            Q(`SELECT w.id FROM wa_connections w WHERE w.user_id=$1 AND w.archivada_at IS NULL${client ? ` AND w.outbound_client_id=${client}` : ''}`).catch(() => []),
            Q(`SELECT ${KIND} AS kind, COUNT(*)::int AS n ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1`),
            Q(`SELECT COUNT(*)::int AS n FROM (SELECT 1) t WHERE FALSE`),
          ]);
          const N = k => (per.find(r => r.kind === k) || {}).n || 0, avg = n => Math.round(n / dayDiv * 10) / 10;
          return {
            email: { avg: avg(N('email')), limit: mb.reduce((n, x) => n + (x.daily_limit || (x.ramp_on ? x.ramp_target : 0) || 0), 0), senders: mb.length, ids: mb.map(x => x.id) },
            linkedin: { avg: avg(N('li_invite') + N('li_msg') + N('li_visit')), limit: li.reduce((n, x) => n + (x.total_dia || 0), 0), senders: li.length, accounts: li.length },
            whatsapp: { avg: avg(N('whatsapp')), limit: wa.length * 15, senders: wa.length },
            sms: { avg: 0, limit: 0, senders: 0 }, calls: { avg: avg(N('call')) },
          };
        };
        const [kc, kp, vol, churn, capacity, heat, repHeat] = await Promise.all([
          kpi(from, to), kpi(pFrom, pTo),
          Q(`SELECT a.fecha::date::text AS d, ${KIND} AS kind, COUNT(*)::int AS n ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1,2 ORDER BY 1`),
          Q(`SELECT a.fecha::date::text AS d, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND (a.tipo='pausa_secuencia' OR (a.tipo='disposition_change' AND a.nota ~ '→ (No interesado|No contactar|No califica)[[:space:]]*$')) AND ${inR('a.fecha', from, to)} GROUP BY 1 ORDER BY 1`),
          cap(),
          Q(`SELECT ${KIND} AS kind, EXTRACT(DOW FROM a.fecha AT TIME ZONE '${tz}')::int AS dow, EXTRACT(HOUR FROM a.fecha AT TIME ZONE '${tz}')::int AS hr, COUNT(*)::int AS n ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1,2,3`),
          Q(`SELECT EXTRACT(DOW FROM a.fecha AT TIME ZONE '${tz}')::int AS dow, EXTRACT(HOUR FROM a.fecha AT TIME ZONE '${tz}')::int AS hr, COUNT(*)::int AS n ${base} AND ${REPLY} AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
        ]);
        Object.assign(out, { kpi: { cur: kc, prev: kp }, volume: vol, churn, capacity, heat, replyHeat: repHeat });
      } else if (tab === 'team') {
        const wk = `date_trunc('week', a.fecha)::date::text`;
        const [rows, rep, intr, tasks, bnc, eng, interEv, calls, capLi, capMb, trOut, trRep, trInt, trBnc, trEng] = await Promise.all([
          Q(`SELECT ${REP} AS rep, ${KIND} AS kind, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
          Q(`SELECT ${REP} AS rep, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${REPLY} AND ${inR('a.fecha', from, to)} GROUP BY 1`),
          Q(`SELECT ${REP} AS rep, COUNT(DISTINCT a.contact_id) FILTER (WHERE k.disposition IN ('interesado','reunion'))::int AS interesados, COUNT(DISTINCT a.contact_id)::int AS intentados ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1`),
          Q(`SELECT ${REP} AS rep, COUNT(*) FILTER (WHERE a.estado='pendiente' AND a.tipo IN ${TASK_T})::int AS abiertas, COUNT(*) FILTER (WHERE a.estado='pendiente' AND a.tipo IN ${TASK_T} AND a.fecha<NOW())::int AS vencidas,
                    COUNT(*) FILTER (WHERE a.estado='hecha' AND a.tipo IN ${TASK_T} AND ${inR('a.fecha', from, to)})::int AS hechas, COUNT(*) FILTER (WHERE a.tipo='paso_omitido' AND ${inR('a.fecha', from, to)})::int AS ignoradas,
                    COUNT(*) FILTER (WHERE a.tipo IN ${TASK_T} AND ${inR('a.created_at', from, to)})::int AS creadas ${base} GROUP BY 1`),
          Q(`SELECT ${sw(REP, 'k', 'k')} AS rep, COUNT(DISTINCT m.contact_id)::int AS n FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND m.estado='bounced' AND ${inR('m.sent_at', from, to)} GROUP BY 1`),
          Q(`SELECT ${REP} AS rep, COUNT(DISTINCT m.contact_id)::int AS n FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND ${inR('m.sent_at', from, to)} AND EXISTS(SELECT 1 FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo IN ('open','click')) GROUP BY 1`),
          Q(`SELECT ${REP} AS rep, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${INTERESADO_EV} AND ${inR('a.fecha', from, to)} GROUP BY 1`),
          Q(`SELECT COALESCE(NULLIF(c.member,''),'Sin asignar') AS rep, COUNT(*)::int AS realizadas, COUNT(*) FILTER (WHERE COALESCE(c.duracion,0)>0)::int AS conectadas, COALESCE(ROUND(AVG(c.duracion) FILTER (WHERE COALESCE(c.duracion,0)>0)),0)::int AS dur FROM tel_calls c WHERE c.user_id=$1 AND ${inR('c.started_at', from, to)}${client ? ` AND c.outbound_client_id=${client}` : ''} GROUP BY 1`).catch(() => []),
          Q(`SELECT COALESCE(NULLIF(oc.responsable,''),'Sin responsable') AS rep, COALESCE(SUM(la.total_dia),0)::int AS limite, COUNT(la.id)::int AS cuentas FROM outbound_clients oc JOIN li_accounts la ON la.outbound_client_id=oc.id WHERE oc.user_id=$1 GROUP BY 1`).catch(() => []),
          Q(`SELECT COALESCE(NULLIF(oc.responsable,''),'Sin responsable') AS rep, COALESCE(SUM(COALESCE(mb.daily_limit, CASE WHEN mb.ramp_on THEN mb.ramp_target END, 0)),0)::int AS limite, COUNT(mb.id)::int AS buzones FROM outbound_clients oc JOIN lm_mailboxes mb ON mb.outbound_client_id=oc.id WHERE oc.user_id=$1 GROUP BY 1`).catch(() => []),
          Q(`SELECT ${REP} AS rep, ${wk} AS w, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${OUT} AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
          Q(`SELECT ${REP} AS rep, ${wk} AS w, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${REPLY} AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
          Q(`SELECT ${REP} AS rep, ${wk} AS w, COUNT(DISTINCT a.contact_id)::int AS n ${base} AND ${INTERESADO_EV} AND ${inR('a.fecha', from, to)} GROUP BY 1,2`),
          Q(`SELECT ${REP} AS rep, date_trunc('week', m.sent_at)::date::text AS w, COUNT(DISTINCT m.contact_id)::int AS n FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND m.estado='bounced' AND ${inR('m.sent_at', from, to)} GROUP BY 1,2`),
          Q(`SELECT ${REP} AS rep, date_trunc('week', m.sent_at)::date::text AS w, COUNT(DISTINCT m.contact_id)::int AS n FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id WHERE m.user_id=$1 AND ${kw} AND ${inR('m.sent_at', from, to)} AND EXISTS(SELECT 1 FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo IN ('open','click')) GROUP BY 1,2`),
        ]);
        const { rows: tm } = await pool.query('SELECT nombre, rol FROM team_members WHERE user_id=$1', [uid]);
        const roleOf = n => { const m = tm.find(x => String(x.nombre).toLowerCase() === String(n).toLowerCase()); return m ? (String(m.rol).toLowerCase() === 'admin' ? 'admin' : 'member') : 'member'; };
        const names = new Set([...rows.map(r => r.rep), ...rep.map(r => r.rep), ...tasks.map(r => r.rep), ...intr.map(r => r.rep)]);
        const get = (arr, r, k, d = 0) => ((arr.find(x => x.rep === r) || {})[k]) || d;
        const reps = [...names].sort().map(r => {
          const kinds = {}; rows.filter(x => x.rep === r).forEach(x => { kinds[x.kind] = x.n; });
          const intentados = get(intr, r, 'intentados'), bnc_ = get(bnc, r, 'n');
          return { nombre: r, rol: roleOf(r), kinds, intentados, entregados: Math.max(0, intentados - bnc_), comprometidos: get(eng, r, 'n'), respondidos: get(rep, r, 'n'), interesados: get(interEv, r, 'n') || get(intr, r, 'interesados'),
            tareas: { abiertas: get(tasks, r, 'abiertas'), vencidas: get(tasks, r, 'vencidas'), hechas: get(tasks, r, 'hechas'), ignoradas: get(tasks, r, 'ignoradas'), creadas: get(tasks, r, 'creadas') },
            llamadas: { realizadas: get(calls, r, 'realizadas'), conectadas: get(calls, r, 'conectadas'), dur: get(calls, r, 'dur') },
            capacidad: { li_limite: get(capLi, r, 'limite'), li_cuentas: get(capLi, r, 'cuentas'), em_limite: get(capMb, r, 'limite'), em_buzones: get(capMb, r, 'buzones'), li_prom: Math.round(((kinds.li_invite || 0) + (kinds.li_msg || 0) + (kinds.li_visit || 0)) / dayDiv * 10) / 10, em_prom: Math.round((kinds.email || 0) / dayDiv * 10) / 10 } };
        });
        const merge = (arrs) => { const m = {}; Object.entries(arrs).forEach(([met, a]) => a.forEach(x => { const k = x.rep + '|' + x.w; (m[k] = m[k] || { rep: x.rep, w: x.w })[met] = x.n; })); return Object.values(m).sort((a, b) => a.w < b.w ? -1 : 1); };
        const trends = merge({ intentado: trOut, respondido: trRep, interesado: trInt, rebotado: trBnc, comprometido: trEng });
        Object.assign(out, { reps, trends });
      } else {
        const [calls, manual, daily] = await Promise.all([
          Q(`SELECT c.id, c.estado, c.duracion, c.resultado, c.nota, c.started_at, COALESCE(NULLIF(c.member,''),'Sin asignar') AS rep, c.to_number, TRIM(k.nombre||' '||COALESCE(k.apellido,'')) AS contacto, c.contact_id
               FROM tel_calls c LEFT JOIN lm_contacts k ON k.id=c.contact_id WHERE c.user_id=$1 AND ${inR('c.started_at', from, to)}${client ? ` AND c.outbound_client_id=${client}` : ''} ORDER BY c.started_at DESC LIMIT 200`).catch(() => []),
          Q(`SELECT a.id, a.fecha, a.nota, ${REP} AS rep, a.contact_id, TRIM(k.nombre||' '||COALESCE(k.apellido,'')) AS contacto ${base} AND a.estado='hecha' AND (a.tipo='llamada' OR (${OUT} AND (${CH}) IN ('call','wa_call'))) AND ${inR('a.fecha', from, to)} ORDER BY a.fecha DESC LIMIT 200`),
          Q(`SELECT a.fecha::date::text AS d, COUNT(*)::int AS n ${base} AND a.estado='hecha' AND (a.tipo='llamada' OR (${OUT} AND (${CH}) IN ('call','wa_call'))) AND ${inR('a.fecha', from, to)} GROUP BY 1 ORDER BY 1`),
        ]);
        const conect = calls.filter(c => (c.duracion || 0) > 0);
        const durs = conect.map(c => c.duracion);
        Object.assign(out, { telefonia: calls, manuales: manual, porDia: daily, resumen: { realizadas: calls.length + manual.length, desdeNova: calls.length, registradas: manual.length, conectadas: conect.length, dur_media: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0 } });
      }
      res.json(out);
    } catch (e) { console.error('[reports]', req.params.tab, e.message); res.status(500).json({ error: 'No se pudo cargar el informe' }); }
  });
}
module.exports = { mount };
