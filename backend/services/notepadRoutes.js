'use strict';
// Bloc de notas personal (panel de la barra superior): notas privadas por persona, con archivo y enlace a tarea.
function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS user_notes (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, cuerpo TEXT NOT NULL DEFAULT '',
        archivada BOOLEAN NOT NULL DEFAULT FALSE, task_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS user_notes_user_idx ON user_notes (user_id, archivada, updated_at DESC)`);
    } catch (e) { console.warn('[notepad] init', e.message); }
  })();

  const clip = s => String(s == null ? '' : s).slice(0, 50000);

  app.get('/api/notes', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, cuerpo, archivada, task_id, created_at, updated_at FROM user_notes
          WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 500`, [req.user.id]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'No se pudieron cargar las notas' }); }
  });

  app.post('/api/notes', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: [n] } = await pool.query(
        `INSERT INTO user_notes (user_id, cuerpo, created_at, updated_at) VALUES ($1,$2,COALESCE($3::timestamptz,NOW()),COALESCE($3::timestamptz,NOW()))
         RETURNING id, cuerpo, archivada, task_id, created_at, updated_at`,
        [req.user.id, clip(b.cuerpo), b.created_at && !isNaN(Date.parse(b.created_at)) ? b.created_at : null]);
      res.json(n);
    } catch (e) { res.status(500).json({ error: 'No se pudo crear la nota' }); }
  });

  app.patch('/api/notes/:id', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: [n] } = await pool.query(
        `UPDATE user_notes SET
           cuerpo    = COALESCE($3, cuerpo),
           archivada = COALESCE($4::boolean, archivada),
           task_id   = CASE WHEN $5::boolean THEN $6::int ELSE task_id END,
           updated_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE updated_at END
         WHERE id=$1 AND user_id=$2
         RETURNING id, cuerpo, archivada, task_id, created_at, updated_at`,
        [parseInt(req.params.id, 10), req.user.id,
         b.cuerpo === undefined ? null : clip(b.cuerpo),
         b.archivada === undefined ? null : !!b.archivada,
         b.task_id !== undefined, b.task_id == null ? null : parseInt(b.task_id, 10)]);
      if (!n) return res.status(404).json({ error: 'Nota no encontrada' });
      res.json(n);
    } catch (e) { res.status(500).json({ error: 'No se pudo guardar la nota' }); }
  });

  app.delete('/api/notes/:id', requireAuth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM user_notes WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id, 10), req.user.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo eliminar la nota' }); }
  });
}
module.exports = { mount };
