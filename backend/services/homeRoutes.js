'use strict';
// Inicio / Dashboard: bandeja «Para ti» (respuestas, comentarios asignados, comentarios nuevos), cobros y comentarios asignados.
//  · Los comentarios de una tarea viven en chat_messages (canal «task:<id>»).
//  · «Visto» = inbox_seen (última vez que esa persona abrió los comentarios de la tarea).
//  · Un comentario puede asignarse a alguien (comment_assign) y queda pendiente en su bandeja hasta que lo resuelva.

function mount(app, { pool, requireAuth, permsSvc }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS inbox_seen (user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, task_id))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS comment_assign (
        id SERIAL PRIMARY KEY, workspace_owner_id INTEGER NOT NULL, message_id INTEGER NOT NULL, task_id INTEGER,
        assigned_to_user_id INTEGER NOT NULL, assigned_to_name TEXT NOT NULL DEFAULT '', assigned_by_user_id INTEGER, assigned_by_name TEXT NOT NULL DEFAULT '',
        resolved BOOLEAN NOT NULL DEFAULT FALSE, resolved_at TIMESTAMPTZ, resolved_by_name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS comment_assign_msg_uq ON comment_assign (message_id, assigned_to_user_id) WHERE NOT resolved`);
      await pool.query(`CREATE INDEX IF NOT EXISTS comment_assign_to_idx ON comment_assign (assigned_to_user_id, resolved)`);
    } catch (e) { console.warn('[home] tablas', e.message); }
  })();

  const ping = (req, kind) => { try { const io = req.app.get('io'); if (io) io.to(`ws:${req.workspaceOwnerId}`).emit('home_update', { kind, by: req.user.id }); } catch (_) {} };
  const strip = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  async function who(req) {
    const owner = req.workspaceOwnerId, { rows: [tm] } = await pool.query(`SELECT id, nombre FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`, [owner, req.user.email]);
    return { owner, uid: req.user.id, name: (tm && tm.nombre) || req.user.name || '', memberId: tm ? tm.id : null };
  }

  // ── Bandeja «Para ti» ──
  app.get('/api/home/para-ti', requireAuth, async (req, res) => {
    try {
      const me = await who(req), { owner, uid, name } = me;
      const [com, men, asg] = await Promise.all([
        pool.query(`
          SELECT cm.task_id, t.titulo, t.project_id, p.nombre AS project_nombre, COUNT(*)::int AS n, MAX(cm.created_at) AS last_at,
                 (ARRAY_AGG(cm.content ORDER BY cm.created_at DESC))[1] AS last_content,
                 (ARRAY_AGG(COALESCE(u.name,'') ORDER BY cm.created_at DESC))[1] AS last_by,
                 EXISTS(SELECT 1 FROM chat_messages me WHERE me.workspace_owner_id=$1 AND me.channel='task:'||cm.task_id AND me.sender_id=$3) AS respuesta
            FROM (SELECT id, SUBSTRING(channel FROM 6)::int AS task_id, sender_id, content, created_at FROM chat_messages
                   WHERE workspace_owner_id=$1 AND channel ~ '^task:[0-9]+$' AND sender_id IS DISTINCT FROM $3 AND created_at > NOW() - INTERVAL '30 days') cm
            JOIN tasks t ON t.id=cm.task_id AND t.user_id=$1 AND NOT COALESCE(t.archivada,false)
            LEFT JOIN projects p ON p.id=t.project_id
            LEFT JOIN users u ON u.id=cm.sender_id
            LEFT JOIN inbox_seen s ON s.user_id=$3 AND s.task_id=cm.task_id
           WHERE cm.created_at > COALESCE(s.seen_at, NOW() - INTERVAL '14 days')
             AND ($2 = ANY(COALESCE(t.responsables,'{}')) OR t.responsable=$2 OR t.created_by_name=$2
                  OR EXISTS(SELECT 1 FROM chat_messages me WHERE me.workspace_owner_id=$1 AND me.channel='task:'||t.id AND me.sender_id=$3))
           GROUP BY cm.task_id, t.titulo, t.project_id, p.nombre
           ORDER BY last_at DESC LIMIT 40`, [owner, name, uid]),
        pool.query(`SELECT m.id, m.by_name, m.kind, m.task_id, m.project_id, m.excerpt, m.created_at, t.titulo AS task_titulo, p.nombre AS project_nombre
                      FROM mentions m LEFT JOIN tasks t ON t.id=m.task_id LEFT JOIN projects p ON p.id=m.project_id
                     WHERE m.mentioned_user_id=$1 AND m.read=FALSE ORDER BY m.created_at DESC LIMIT 30`, [uid]).catch(() => ({ rows: [] })),
        pool.query(`SELECT a.id, a.message_id, a.task_id, a.assigned_by_name, a.created_at, cm.content, t.titulo, p.nombre AS project_nombre, t.project_id
                      FROM comment_assign a JOIN chat_messages cm ON cm.id=a.message_id
                      LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN projects p ON p.id=t.project_id
                     WHERE a.workspace_owner_id=$1 AND a.assigned_to_user_id=$2 AND NOT a.resolved ORDER BY a.created_at DESC LIMIT 40`, [owner, uid]),
      ]);
      const cm = x => ({ task_id: x.task_id, titulo: x.titulo, project_nombre: x.project_nombre, n: x.n, at: x.last_at, by: x.last_by, texto: strip(x.last_content) });
      res.json({
        respuestas: [
          ...men.rows.map(m => ({ tipo: 'mencion', id: m.id, task_id: m.task_id, titulo: m.task_titulo, project_nombre: m.project_nombre, by: m.by_name, at: m.created_at, texto: strip(m.excerpt) })),
          ...com.rows.filter(x => x.respuesta).map(x => ({ tipo: 'respuesta', ...cm(x) })),
        ].sort((a, b) => new Date(b.at) - new Date(a.at)),
        asignados: asg.rows.map(a => ({ id: a.id, message_id: a.message_id, task_id: a.task_id, titulo: a.titulo, project_nombre: a.project_nombre, by: a.assigned_by_name, at: a.created_at, texto: strip(a.content) })),
        nuevos: com.rows.filter(x => !x.respuesta).map(x => ({ tipo: 'nuevo', ...cm(x) })),
      });
    } catch (e) { console.error('[home/para-ti]', e.message); res.status(500).json({ error: 'No se pudo cargar tu bandeja' }); }
  });

  // marcar como visto: una tarea, o todo lo pendiente de la bandeja
  app.post('/api/home/seen', requireAuth, async (req, res) => {
    try {
      const me = await who(req), b = req.body || {};
      const ids = b.all ? (await pool.query(`SELECT DISTINCT SUBSTRING(channel FROM 6)::int AS id FROM chat_messages WHERE workspace_owner_id=$1 AND channel ~ '^task:[0-9]+$' AND created_at > NOW() - INTERVAL '30 days'`, [me.owner])).rows.map(r => r.id) : [parseInt(b.task_id, 10)].filter(Boolean);
      for (const id of ids) await pool.query(`INSERT INTO inbox_seen (user_id, task_id, seen_at) VALUES ($1,$2,NOW()) ON CONFLICT (user_id, task_id) DO UPDATE SET seen_at=NOW()`, [me.uid, id]);
      if (b.mencion_id) await pool.query(`UPDATE mentions SET read=TRUE WHERE id=$1 AND mentioned_user_id=$2`, [parseInt(b.mencion_id, 10), me.uid]).catch(() => {});
      if (b.all) await pool.query(`UPDATE mentions SET read=TRUE WHERE mentioned_user_id=$1`, [me.uid]).catch(() => {});
      res.json({ ok: true, n: ids.length });
    } catch (e) { res.status(500).json({ error: 'No se pudo marcar como visto' }); }
  });

  // comentarios asignados de una tarea (para pintar la marca en el detalle)
  app.get('/api/home/assignments', requireAuth, async (req, res) => {
    try {
      const tid = parseInt(req.query.task, 10) || 0, { rows } = await pool.query(`SELECT id, message_id, assigned_to_user_id, assigned_to_name, assigned_by_name, resolved, resolved_by_name FROM comment_assign WHERE workspace_owner_id=$1 AND task_id=$2 ORDER BY id`, [req.workspaceOwnerId, tid]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/home/comments/:msgId/assign', requireAuth, async (req, res) => {
    try {
      const me = await who(req), mid = parseInt(req.params.msgId, 10), memberId = parseInt((req.body || {}).member_id, 10);
      const { rows: [m] } = await pool.query(`SELECT id, channel FROM chat_messages WHERE id=$1 AND workspace_owner_id=$2 AND channel ~ '^task:[0-9]+$'`, [mid, me.owner]);
      if (!m) return res.status(404).json({ error: 'Comentario no encontrado' });
      const { rows: [tm] } = await pool.query(`SELECT id, nombre, email FROM team_members WHERE id=$1 AND user_id=$2`, [memberId, me.owner]);
      if (!tm) return res.status(404).json({ error: 'Persona no encontrada' });
      const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND (workspace_id=$2 OR id=$2) LIMIT 1`, [tm.email, me.owner]);
      if (!u) return res.status(400).json({ error: 'Esa persona aún no tiene acceso a Nova' });
      const taskId = parseInt(m.channel.slice(5), 10);
      await pool.query(`INSERT INTO comment_assign (workspace_owner_id, message_id, task_id, assigned_to_user_id, assigned_to_name, assigned_by_user_id, assigned_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [me.owner, mid, taskId, u.id, tm.nombre, me.uid, me.name]);
      ping(req, 'assign'); res.json({ ok: true });
    } catch (e) { console.error('[home/assign]', e.message); res.status(500).json({ error: 'No se pudo asignar' }); }
  });
  app.post('/api/home/assigned/:id/resolve', requireAuth, async (req, res) => {
    try {
      const me = await who(req), id = parseInt(req.params.id, 10), reabrir = !!(req.body || {}).reabrir;
      const c = permsSvc ? await permsSvc.ctx(req) : { isOwner: true };
      const { rows: [a] } = await pool.query(`SELECT assigned_to_user_id, assigned_by_user_id FROM comment_assign WHERE id=$1 AND workspace_owner_id=$2`, [id, me.owner]);
      if (!a) return res.status(404).json({ error: 'No encontrado' });
      if (![a.assigned_to_user_id, a.assigned_by_user_id].includes(me.uid) && !c.isOwner && c.rol !== 'admin') return res.status(403).json({ error: 'Solo quien lo asignó, quien lo recibió o un administrador' });
      await pool.query(`UPDATE comment_assign SET resolved=$2, resolved_at=CASE WHEN $2 THEN NOW() ELSE NULL END, resolved_by_name=CASE WHEN $2 THEN $3 ELSE '' END WHERE id=$1`, [id, !reabrir, me.name]);
      ping(req, 'resolve'); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo resolver' }); }
  });

  // ── Cobros: por cobrar y próximo cobro (solo con permiso de Finanzas) ──
  app.get('/api/home/cobros', requireAuth, async (req, res) => {
    try {
      const me = await who(req);
      if (permsSvc) { const c = await permsSvc.ctx(req); if (!c.isOwner && !(c.perms.finanzas && c.perms.finanzas.n >= 1)) return res.json({ oculto: true }); }
      const { rows } = await pool.query(`
        SELECT t.id, t.titulo, t.monto::float AS monto, t.estado, t.deadline, t.billing_week, p.nombre AS project_nombre, COALESCE(p.moneda,'USD') AS moneda
          FROM tasks t JOIN projects p ON p.id=t.project_id
         WHERE t.user_id=$1 AND NOT COALESCE(t.archivada,false) AND COALESCE(t.monto,0) > 0 AND NOT t.cobrado AND t.estado <> 'cancelado'
           AND ($2 = ANY(COALESCE(p.responsables,'{}')) OR p.responsable=$2)
         ORDER BY COALESCE(t.billing_week, t.deadline) ASC NULLS LAST, t.id`, [me.owner, me.name]);
      const hechas = rows.filter(r => r.estado === 'completado');
      const total = hechas.reduce((a, r) => a + r.monto, 0), pend = rows.filter(r => r.estado !== 'completado').reduce((a, r) => a + r.monto, 0);
      res.json({ moneda: (rows[0] && rows[0].moneda) || 'USD', por_cobrar: total, n_por_cobrar: hechas.length, en_curso: pend, proximo: rows.find(r => r.estado === 'completado') || rows[0] || null, lista: hechas.slice(0, 5) });
    } catch (e) { console.error('[home/cobros]', e.message); res.status(500).json({ error: 'No se pudieron cargar los cobros' }); }
  });
}
module.exports = { mount };
