'use strict';
// Agenda del calendario: prioridades por persona (tareas fijadas arriba del panel) y tipo de bloque de las reuniones
// (evento · tiempo de concentración · no disponible).
function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS agenda_prioridades (user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, orden INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, task_id))`);
      await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'evento'`);
      await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS task_id INTEGER`);
    } catch (e) { console.warn('[agenda] init', e.message); }
  })();

  app.get('/api/agenda/prioridades', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT task_id FROM agenda_prioridades WHERE user_id=$1 ORDER BY orden, created_at`, [req.user.id]);
      res.json(rows.map(r => r.task_id));
    } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las prioridades' }); }
  });

  // reemplaza la lista completa (orden = posición en el arreglo)
  app.put('/api/agenda/prioridades', requireAuth, async (req, res) => {
    try {
      const wid = req.workspaceOwnerId, ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(x => parseInt(x, 10)).filter(Boolean))].slice(0, 25);
      const ok = ids.length ? (await pool.query(`SELECT id FROM tasks WHERE id = ANY($1::int[]) AND user_id=$2`, [ids, wid])).rows.map(r => r.id) : [];
      const limpios = ids.filter(i => ok.includes(i));
      await pool.query('BEGIN');
      await pool.query(`DELETE FROM agenda_prioridades WHERE user_id=$1`, [req.user.id]);
      for (let i = 0; i < limpios.length; i++) await pool.query(`INSERT INTO agenda_prioridades (user_id, task_id, orden) VALUES ($1,$2,$3)`, [req.user.id, limpios[i], i]);
      await pool.query('COMMIT');
      res.json(limpios);
    } catch (e) { await pool.query('ROLLBACK').catch(() => {}); console.error('[agenda] prioridades', e.message); res.status(500).json({ error: 'No se pudieron guardar las prioridades' }); }
  });
}
module.exports = { mount };
