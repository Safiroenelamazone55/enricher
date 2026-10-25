'use strict';
// Módulo Contenido: planificación y producción de contenido para redes, de la idea suelta a la pieza publicada.
// Recorrido de una pieza: idea → desarrollo → texto → diseño → revisión → aprobación → programado → publicado.
// (La publicación automática en las redes llega en un bloque posterior; aquí se planifica, produce y da seguimiento.)
const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const ESTADOS = ['idea', 'desarrollo', 'texto', 'diseno', 'revision', 'aprobacion', 'programado', 'publicado'];
const FORMATOS = ['post', 'carrusel', 'reel', 'story', 'video', 'articulo', 'hilo', 'otro'];
const REDES = ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'youtube', 'pinterest', 'threads', 'blog', 'otra'];
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : d);

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS content_accounts (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, red TEXT NOT NULL DEFAULT 'instagram',
    handle TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', notas TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_pillars (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, nombre TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#00804C',
    descripcion TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_pieces (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, titulo TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'idea', formato TEXT NOT NULL DEFAULT 'post', redes JSONB NOT NULL DEFAULT '[]',
    pilar_id INTEGER, responsable TEXT NOT NULL DEFAULT '', fecha_plan DATE, hora_plan TEXT NOT NULL DEFAULT '',
    brief TEXT NOT NULL DEFAULT '', copy JSONB NOT NULL DEFAULT '{}', notas TEXT NOT NULL DEFAULT '',
    checklist JSONB NOT NULL DEFAULT '[]', enlaces JSONB NOT NULL DEFAULT '[]', link_publicado TEXT NOT NULL DEFAULT '',
    orden INTEGER NOT NULL DEFAULT 0, published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS content_pieces_user_idx ON content_pieces (user_id, estado)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS content_pieces_fecha_idx ON content_pieces (user_id, fecha_plan)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_comments (
    id SERIAL PRIMARY KEY, piece_id INTEGER NOT NULL REFERENCES content_pieces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    autor TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

// Normaliza el cuerpo de una pieza (lo que llega del navegador nunca se guarda tal cual).
function pieceFields(b) {
  const redes = (Array.isArray(b.redes) ? b.redes : []).map(r => S(r, 20).toLowerCase()).filter(r => REDES.includes(r));
  const copy = {};
  if (b.copy && typeof b.copy === 'object') for (const [k, v] of Object.entries(b.copy)) { const key = S(k, 20).toLowerCase(); if (REDES.includes(key)) copy[key] = S(v, 6000); }
  const checklist = (Array.isArray(b.checklist) ? b.checklist : []).slice(0, 40).map(i => ({ t: S(i && i.t, 160), ok: !!(i && i.ok) })).filter(i => i.t);
  const enlaces = (Array.isArray(b.enlaces) ? b.enlaces : []).slice(0, 30).map(i => ({ t: S(i && i.t, 120), u: S(i && i.u, 500) })).filter(i => i.u);
  const f = S(b.fecha_plan, 10);
  return {
    titulo: S(b.titulo, 200), client_id: parseInt(b.client_id) || null, estado: ESTADOS.includes(b.estado) ? b.estado : 'idea',
    formato: FORMATOS.includes(b.formato) ? b.formato : 'post', redes, pilar_id: parseInt(b.pilar_id) || null, responsable: S(b.responsable, 80),
    fecha_plan: /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null, hora_plan: /^\d{2}:\d{2}$/.test(S(b.hora_plan, 5)) ? S(b.hora_plan, 5) : '',
    brief: S(b.brief, 6000), copy, notas: S(b.notas, 6000), checklist, enlaces, link_publicado: S(b.link_publicado, 500),
  };
}

function mount(app, { pool, requireAuth }) {
  init(pool).catch(e => console.error('[content] init', e.message));
  const A = requireAuth;
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[content]', e.message); res.status(500).json({ error: 'Error interno' }); } };
  const uid = req => req.workspaceOwnerId || req.user.id;
  // El cliente de una pieza/cuenta/pilar debe ser de este espacio de trabajo.
  async function clientOk(req, cid) {
    if (!cid) return true;
    const { rows } = await pool.query('SELECT 1 FROM clients WHERE id=$1 AND user_id=$2', [cid, uid(req)]);
    return rows.length > 0;
  }

  // Todo lo que la pantalla necesita, en una sola llamada.
  app.get('/api/content/bootstrap', A, wrap(async (req, res) => {
    const u = uid(req);
    const [cl, ac, pi, pc, tm] = await Promise.all([
      pool.query(`SELECT id, nombre, empresa FROM clients WHERE user_id=$1 AND COALESCE(tipo,'cliente') <> 'contacto' AND COALESCE(estado,'activo') <> 'inactivo' ORDER BY LOWER(COALESCE(NULLIF(empresa,''), nombre))`, [u]),
      pool.query('SELECT * FROM content_accounts WHERE user_id=$1 ORDER BY id', [u]),
      pool.query('SELECT * FROM content_pillars WHERE user_id=$1 ORDER BY id', [u]),
      pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM content_comments c WHERE c.piece_id=p.id) AS n_comentarios
                    FROM content_pieces p WHERE p.user_id=$1 ORDER BY p.orden, p.id DESC LIMIT 2000`, [u]),
      pool.query('SELECT nombre FROM team_members WHERE user_id=$1 ORDER BY LOWER(nombre)', [u]).catch(() => ({ rows: [] })),
    ]);
    res.json({ clients: cl.rows, accounts: ac.rows, pillars: pi.rows, pieces: pc.rows, team: tm.rows.map(r => r.nombre), estados: ESTADOS, formatos: FORMATOS, redes: REDES });
  }));

  // ── Piezas
  app.post('/api/content/pieces', A, wrap(async (req, res) => {
    const f = pieceFields(req.body || {});
    if (!f.titulo) return res.status(400).json({ error: 'Escribe un título o una idea' });
    if (!(await clientOk(req, f.client_id))) return res.status(400).json({ error: 'Cliente no válido' });
    const { rows: [r] } = await pool.query(
      `INSERT INTO content_pieces (user_id,client_id,titulo,estado,formato,redes,pilar_id,responsable,fecha_plan,hora_plan,brief,copy,notas,checklist,enlaces,link_publicado)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,$16) RETURNING *`,
      [uid(req), f.client_id, f.titulo, f.estado, f.formato, JSON.stringify(f.redes), f.pilar_id, f.responsable, f.fecha_plan, f.hora_plan, f.brief, JSON.stringify(f.copy), f.notas, JSON.stringify(f.checklist), JSON.stringify(f.enlaces), f.link_publicado]);
    res.json(r);
  }));
  app.put('/api/content/pieces/:id', A, wrap(async (req, res) => {
    const f = pieceFields(req.body || {});
    if (!f.titulo) return res.status(400).json({ error: 'Escribe un título o una idea' });
    if (!(await clientOk(req, f.client_id))) return res.status(400).json({ error: 'Cliente no válido' });
    const { rows: [r] } = await pool.query(
      `UPDATE content_pieces SET client_id=$3,titulo=$4,estado=$5,formato=$6,redes=$7::jsonb,pilar_id=$8,responsable=$9,fecha_plan=$10,hora_plan=$11,brief=$12,copy=$13::jsonb,notas=$14,checklist=$15::jsonb,enlaces=$16::jsonb,link_publicado=$17,
         published_at = CASE WHEN $5='publicado' THEN COALESCE(published_at, NOW()) ELSE NULL END, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, uid(req), f.client_id, f.titulo, f.estado, f.formato, JSON.stringify(f.redes), f.pilar_id, f.responsable, f.fecha_plan, f.hora_plan, f.brief, JSON.stringify(f.copy), f.notas, JSON.stringify(f.checklist), JSON.stringify(f.enlaces), f.link_publicado]);
    if (!r) return res.status(404).json({ error: 'Pieza no encontrada' });
    res.json(r);
  }));
  // Mover entre etapas (arrastrar en el tablero) y/o cambiar la fecha en el calendario, sin tocar el resto de la pieza.
  app.patch('/api/content/pieces/:id', A, wrap(async (req, res) => {
    const b = req.body || {}, sets = [], vals = [req.params.id, uid(req)];
    if (b.estado !== undefined) {
      if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Etapa no válida' });
      vals.push(b.estado); sets.push(`estado=$${vals.length}`);
      sets.push(`published_at = CASE WHEN $${vals.length}='publicado' THEN COALESCE(published_at, NOW()) ELSE NULL END`);
    }
    if (b.fecha_plan !== undefined) {
      const f = S(b.fecha_plan, 10);
      if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: 'Fecha no válida' });
      vals.push(f || null); sets.push(`fecha_plan=$${vals.length}`);
    }
    if (b.orden !== undefined) { vals.push(parseInt(b.orden) || 0); sets.push(`orden=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    const { rows: [r] } = await pool.query(`UPDATE content_pieces SET ${sets.join(',')}, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, vals);
    if (!r) return res.status(404).json({ error: 'Pieza no encontrada' });
    res.json(r);
  }));
  app.delete('/api/content/pieces/:id', A, wrap(async (req, res) => {
    await pool.query('DELETE FROM content_pieces WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  // ── Comentarios internos de una pieza
  async function ownsPiece(req) { const { rows } = await pool.query('SELECT 1 FROM content_pieces WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]); return rows.length > 0; }
  app.get('/api/content/pieces/:id/comments', A, wrap(async (req, res) => {
    if (!(await ownsPiece(req))) return res.status(404).json({ error: 'Pieza no encontrada' });
    const { rows } = await pool.query('SELECT id, autor, texto, created_at FROM content_comments WHERE piece_id=$1 ORDER BY id', [req.params.id]);
    res.json(rows);
  }));
  app.post('/api/content/pieces/:id/comments', A, wrap(async (req, res) => {
    if (!(await ownsPiece(req))) return res.status(404).json({ error: 'Pieza no encontrada' });
    const t = S((req.body || {}).texto, 2000); if (!t) return res.status(400).json({ error: 'Escribe un comentario' });
    const autor = S((req.user && (req.user.name || req.user.email)) || '', 80);
    const { rows: [r] } = await pool.query('INSERT INTO content_comments (piece_id,user_id,autor,texto) VALUES ($1,$2,$3,$4) RETURNING id, autor, texto, created_at', [req.params.id, uid(req), autor, t]);
    await pool.query('UPDATE content_pieces SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json(r);
  }));

  // ── Cuentas (redes de cada cliente) y pilares de contenido
  app.post('/api/content/accounts', A, wrap(async (req, res) => {
    const b = req.body || {}, red = REDES.includes(S(b.red, 20).toLowerCase()) ? S(b.red, 20).toLowerCase() : 'instagram';
    const cid = parseInt(b.client_id) || null; if (!cid || !(await clientOk(req, cid))) return res.status(400).json({ error: 'Elige un cliente' });
    const { rows: [r] } = await pool.query('INSERT INTO content_accounts (user_id,client_id,red,handle,url,notas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [uid(req), cid, red, S(b.handle, 120), S(b.url, 300), S(b.notas, 500)]);
    res.json(r);
  }));
  app.delete('/api/content/accounts/:id', A, wrap(async (req, res) => { await pool.query('DELETE FROM content_accounts WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]); res.json({ ok: true }); }));
  app.post('/api/content/pillars', A, wrap(async (req, res) => {
    const b = req.body || {}, nombre = S(b.nombre, 80); if (!nombre) return res.status(400).json({ error: 'Falta el nombre del pilar' });
    const cid = parseInt(b.client_id) || null; if (!cid || !(await clientOk(req, cid))) return res.status(400).json({ error: 'Elige un cliente' });
    const { rows: [r] } = await pool.query('INSERT INTO content_pillars (user_id,client_id,nombre,color,descripcion) VALUES ($1,$2,$3,$4,$5) RETURNING *', [uid(req), cid, nombre, hex(b.color, '#00804C'), S(b.descripcion, 400)]);
    res.json(r);
  }));
  app.delete('/api/content/pillars/:id', A, wrap(async (req, res) => {
    await pool.query('UPDATE content_pieces SET pilar_id=NULL WHERE pilar_id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    await pool.query('DELETE FROM content_pillars WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));
}

module.exports = { mount, init, ESTADOS, FORMATOS, REDES };
