'use strict';
// Enlaces y relaciones de una tarea (panel «Relaciones» y «Enlaces» de la pantalla de tarea).
//  · task_links: URLs pegadas en la tarea (documentos, Figma, GitHub, Drive…).
//  · task_relations: tarea ↔ tarea. tipo 'relacion' (simétrica), 'custom' (con nombre propio) y
//    'bloquea' (dependencia: task_id bloquea a other_id; para other_id es «esperando a»).
const TIPOS = ['relacion', 'custom', 'bloquea'];

function cleanUrl(v) {
  let u = String(v || '').trim().slice(0, 1000); if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return null; return { url: x.toString(), host: x.hostname.replace(/^www\./, '') }; } catch (_) { return null; }
}

function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS task_links (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, url TEXT NOT NULL, titulo TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS task_links_task ON task_links(task_id)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS task_relations (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, other_id INTEGER NOT NULL, tipo TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (task_id, other_id, tipo))`);
      await pool.query(`CREATE INDEX IF NOT EXISTS task_relations_task ON task_relations(task_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS task_relations_other ON task_relations(other_id)`);
    } catch (e) { console.warn('[task-links] init', e.message); }
  })();

  const owns = async (id, wid) => (await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND user_id=$2`, [id, wid])).rowCount > 0;

  // enlaces + relaciones de una tarea
  app.get('/api/mgmt/tasks/:id/links', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), wid = req.workspaceOwnerId;
      if (!(await owns(id, wid))) return res.status(404).json({ error: 'Tarea no encontrada' });
      const { rows: links } = await pool.query(`SELECT id, url, titulo, created_by, created_at FROM task_links WHERE task_id=$1 AND user_id=$2 ORDER BY id`, [id, wid]);
      const { rows } = await pool.query(
        `SELECT r.id, r.tipo, r.label, CASE WHEN r.task_id=$1 THEN 'sale' ELSE 'entra' END AS dir,
                o.id AS oid, o.titulo AS otitulo, o.estado AS oestado, p.nombre AS oproyecto
           FROM task_relations r
           JOIN tasks o ON o.id = CASE WHEN r.task_id=$1 THEN r.other_id ELSE r.task_id END AND o.user_id=$2
           LEFT JOIN projects p ON p.id=o.project_id
          WHERE (r.task_id=$1 OR r.other_id=$1) AND r.user_id=$2 ORDER BY r.id`, [id, wid]);
      res.json({ links, relaciones: rows.map(r => ({ id: r.id, tipo: r.tipo, label: r.label, dir: r.dir, other: { id: r.oid, titulo: r.otitulo, estado: r.oestado, project_nombre: r.oproyecto || '' } })) });
    } catch (e) { console.error('[task-links] get', e.message); res.status(500).json({ error: 'No se pudieron cargar los enlaces' }); }
  });

  app.post('/api/mgmt/tasks/:id/links', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), wid = req.workspaceOwnerId, b = req.body || {};
      if (!(await owns(id, wid))) return res.status(404).json({ error: 'Tarea no encontrada' });
      const u = cleanUrl(b.url); if (!u) return res.status(400).json({ error: 'Pega una dirección web válida (http o https)' });
      const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM task_links WHERE task_id=$1 AND user_id=$2`, [id, wid]);
      if (c.n >= 30) return res.status(400).json({ error: 'Máximo 30 enlaces por tarea' });
      const titulo = String(b.titulo || '').trim().slice(0, 120) || u.host;
      const { rows: [l] } = await pool.query(`INSERT INTO task_links (user_id, task_id, url, titulo, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, titulo, created_by, created_at`, [wid, id, u.url, titulo, (req.user && req.user.name) || '']);
      res.status(201).json(l);
    } catch (e) { console.error('[task-links] post', e.message); res.status(500).json({ error: 'No se pudo agregar el enlace' }); }
  });

  app.delete('/api/mgmt/task-links/:id', requireAuth, async (req, res) => {
    try { await pool.query(`DELETE FROM task_links WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'No se pudo quitar el enlace' }); }
  });

  // relación nueva: task_id (:id) → other_id
  app.post('/api/mgmt/tasks/:id/relations', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), wid = req.workspaceOwnerId, b = req.body || {}, other = parseInt(b.other_id, 10), tipo = String(b.tipo || '');
      if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de relación no válido' });
      if (!other || other === id) return res.status(400).json({ error: 'Elige otra tarea' });
      if (!(await owns(id, wid)) || !(await owns(other, wid))) return res.status(404).json({ error: 'Tarea no encontrada' });
      const label = tipo === 'custom' ? String(b.label || '').trim().slice(0, 60) : '';
      if (tipo === 'custom' && !label) return res.status(400).json({ error: 'Ponle un nombre a la relación personalizada' });
      // ya existe en cualquier sentido (las relaciones simétricas no se duplican al revés)
      const dup = await pool.query(`SELECT 1 FROM task_relations WHERE user_id=$1 AND tipo=$2 AND ((task_id=$3 AND other_id=$4) OR ($2<>'bloquea' AND task_id=$4 AND other_id=$3))`, [wid, tipo, id, other]);
      if (dup.rowCount) return res.status(400).json({ error: 'Estas tareas ya están relacionadas así' });
      if (tipo === 'bloquea') { const inv = await pool.query(`SELECT 1 FROM task_relations WHERE user_id=$1 AND tipo='bloquea' AND task_id=$2 AND other_id=$3`, [wid, other, id]); if (inv.rowCount) return res.status(400).json({ error: 'Ya existe la dependencia en sentido contrario' }); }
      const { rows: [r] } = await pool.query(`INSERT INTO task_relations (user_id, task_id, other_id, tipo, label, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [wid, id, other, tipo, label, (req.user && req.user.name) || '']);
      res.status(201).json(r);
    } catch (e) { console.error('[task-links] rel', e.message); res.status(500).json({ error: 'No se pudo relacionar' }); }
  });

  app.delete('/api/mgmt/task-relations/:id', requireAuth, async (req, res) => {
    try { await pool.query(`DELETE FROM task_relations WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.workspaceOwnerId]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'No se pudo quitar la relación' }); }
  });
}
module.exports = { mount, cleanUrl };
