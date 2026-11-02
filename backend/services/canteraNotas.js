'use strict';
// Notas de un borrador de Cantera: documento libre («información importante») + hilo de comentarios, notas y bloqueos con etiquetas.
const mentionSvc = require('./mentionService');
const TIPOS = ['comentario', 'nota', 'bloqueo'];
function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS cantera_docs (batch_id INTEGER PRIMARY KEY, html TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS cantera_notas (
        id SERIAL PRIMARY KEY, batch_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tipo TEXT NOT NULL DEFAULT 'comentario',
        texto TEXT NOT NULL DEFAULT '', etiquetas JSONB NOT NULL DEFAULT '[]', autor_id INTEGER, autor_nombre TEXT NOT NULL DEFAULT '',
        resuelto BOOLEAN NOT NULL DEFAULT FALSE, fijado BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS cantera_notas_batch_idx ON cantera_notas (batch_id, created_at DESC)`);
    } catch (e) { console.warn('[cantera-notas] init', e.message); }
  })();
  const batch = async (req, res) => {
    const { rows: [b] } = await pool.query('SELECT id, nombre FROM cantera_batches WHERE id=$1 AND user_id=$2', [req.params.id, req.workspaceOwnerId]);
    if (!b) { res.status(404).json({ error: 'Borrador no encontrado' }); return null; }
    return b;
  };
  const tags = a => (Array.isArray(a) ? a : []).map(x => String(x).trim().slice(0, 24)).filter(Boolean).slice(0, 8);

  app.get('/api/cantera/batches/:id/notas', requireAuth, async (req, res) => {
    try {
      if (!await batch(req, res)) return;
      const [d, n] = await Promise.all([
        pool.query('SELECT html, updated_by, updated_at FROM cantera_docs WHERE batch_id=$1', [req.params.id]),
        pool.query('SELECT * FROM cantera_notas WHERE batch_id=$1 ORDER BY fijado DESC, created_at DESC LIMIT 300', [req.params.id])]);
      res.json({ doc: d.rows[0] || { html: '', updated_by: '', updated_at: null }, items: n.rows, yo: req.user.id });
    } catch (e) { console.error('[cantera-notas] get', e.message); res.status(500).json({ error: 'No se pudieron cargar las notas' }); }
  });
  app.put('/api/cantera/batches/:id/doc', requireAuth, async (req, res) => {
    try {
      if (!await batch(req, res)) return;
      const html = String((req.body && req.body.html) || '').slice(0, 200000);
      await pool.query(`INSERT INTO cantera_docs (batch_id, html, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
        ON CONFLICT (batch_id) DO UPDATE SET html=EXCLUDED.html, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [req.params.id, html, req.user.name || '']);
      res.json({ ok: true });
    } catch (e) { console.error('[cantera-notas] doc', e.message); res.status(500).json({ error: 'No se pudo guardar el documento' }); }
  });
  app.post('/api/cantera/batches/:id/notas', requireAuth, async (req, res) => {
    try {
      const b = await batch(req, res); if (!b) return;
      const tipo = TIPOS.includes(req.body && req.body.tipo) ? req.body.tipo : 'comentario';
      const texto = String((req.body && req.body.texto) || '').trim().slice(0, 4000);
      if (!texto) return res.status(400).json({ error: 'Escribe algo' });
      const { rows: [r] } = await pool.query(
        `INSERT INTO cantera_notas (batch_id, user_id, tipo, texto, etiquetas, autor_id, autor_nombre) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
        [b.id, req.workspaceOwnerId, tipo, texto, JSON.stringify(tags(req.body.etiquetas)), req.user.id, req.user.name || '']);
      if (texto.includes('@')) mentionSvc.process(pool, { wid: req.workspaceOwnerId, user: req.user, kind: 'project_comment', projectId: null, text: `[Cantera · ${b.nombre}] ${texto}` }).catch(() => {});
      res.json(r);
    } catch (e) { console.error('[cantera-notas] post', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });
  app.patch('/api/cantera/notas/:nid', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, set = [], vals = [];
      if (typeof b.resuelto === 'boolean') { vals.push(b.resuelto); set.push(`resuelto=$${vals.length}`); }
      if (typeof b.fijado === 'boolean') { vals.push(b.fijado); set.push(`fijado=$${vals.length}`); }
      if (typeof b.texto === 'string' && b.texto.trim()) { vals.push(b.texto.trim().slice(0, 4000)); set.push(`texto=$${vals.length}`); }
      if (Array.isArray(b.etiquetas)) { vals.push(JSON.stringify(tags(b.etiquetas))); set.push(`etiquetas=$${vals.length}::jsonb`); }
      if (!set.length) return res.status(400).json({ error: 'Nada que cambiar' });
      vals.push(req.params.nid, req.workspaceOwnerId);
      const { rows: [r] } = await pool.query(`UPDATE cantera_notas SET ${set.join(',')}, updated_at=NOW() WHERE id=$${vals.length - 1} AND user_id=$${vals.length} RETURNING *`, vals);
      if (!r) return res.status(404).json({ error: 'No encontrada' });
      res.json(r);
    } catch (e) { console.error('[cantera-notas] patch', e.message); res.status(500).json({ error: 'No se pudo actualizar' }); }
  });
  app.delete('/api/cantera/notas/:nid', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM cantera_notas WHERE id=$1 AND user_id=$2', [req.params.nid, req.workspaceOwnerId]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo borrar' }); }
  });
}
module.exports = { mount };
