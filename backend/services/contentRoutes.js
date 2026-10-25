'use strict';
// Módulo Contenido: planificación, producción, aprobación, publicación y medición de contenido para redes.
// Recorrido de una pieza: idea → desarrollo → texto → diseño → revisión → aprobación → programado → publicado.
// La publicación se hace desde aquí (cola «Publicar»: texto y archivos listos, se marca publicada con su enlace);
// la conexión directa a cada red se añade cuando se registren las apps de desarrollador de cada una.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const ESTADOS = ['idea', 'desarrollo', 'texto', 'diseno', 'revision', 'aprobacion', 'programado', 'publicado'];
const FORMATOS = ['post', 'carrusel', 'reel', 'story', 'video', 'articulo', 'hilo', 'otro'];
const REDES = ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'youtube', 'pinterest', 'threads', 'blog', 'otra'];
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : d);
const MEDIA_DIR = path.join(__dirname, '..', 'content_media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (_) {}
const MIME_OK = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|video\/(mp4|quicktime|webm)|application\/pdf)$/i;
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'application/pdf': '.pdf' };

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS content_accounts (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, red TEXT NOT NULL DEFAULT 'instagram',
    handle TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', notas TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
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
  for (const q of [
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS campaign_id INTEGER`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS primer_comentario TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS hashtags TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS resultados JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS aprob_estado TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS aprob_nota TEXT NOT NULL DEFAULT ''`,
  ]) await pool.query(q);
  await pool.query(`CREATE INDEX IF NOT EXISTS content_pieces_user_idx ON content_pieces (user_id, estado)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS content_pieces_fecha_idx ON content_pieces (user_id, fecha_plan)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_comments (
    id SERIAL PRIMARY KEY, piece_id INTEGER NOT NULL REFERENCES content_pieces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    autor TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_media (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, nombre TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT 'imagen', size INTEGER NOT NULL DEFAULT 0, file TEXT NOT NULL, carpeta TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_strategy (
    user_id INTEGER NOT NULL, client_id INTEGER NOT NULL, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, client_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_campaigns (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, nombre TEXT NOT NULL, objetivo TEXT NOT NULL DEFAULT '',
    inicio DATE, fin DATE, color TEXT NOT NULL DEFAULT '#3B82F6', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS content_approvals (
    id SERIAL PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, client_id INTEGER, titulo TEXT NOT NULL DEFAULT '',
    piece_ids JSONB NOT NULL DEFAULT '[]', revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '45 days'))`);
}

const COLS = ['client_id', 'titulo', 'estado', 'formato', 'redes', 'pilar_id', 'responsable', 'fecha_plan', 'hora_plan', 'brief', 'copy', 'notas', 'checklist', 'enlaces', 'link_publicado', 'media', 'campaign_id', 'primer_comentario', 'hashtags'];
const JSONC = new Set(['redes', 'copy', 'checklist', 'enlaces', 'media']);

// Normaliza el cuerpo de una pieza (lo que llega del navegador nunca se guarda tal cual).
function pieceFields(b) {
  const redes = (Array.isArray(b.redes) ? b.redes : []).map(r => S(r, 20).toLowerCase()).filter(r => REDES.includes(r));
  const copy = {};
  if (b.copy && typeof b.copy === 'object') for (const [k, v] of Object.entries(b.copy)) { const key = S(k, 20).toLowerCase(); if (REDES.includes(key)) copy[key] = S(v, 6000); }
  const checklist = (Array.isArray(b.checklist) ? b.checklist : []).slice(0, 40).map(i => ({ t: S(i && i.t, 160), ok: !!(i && i.ok) })).filter(i => i.t);
  const enlaces = (Array.isArray(b.enlaces) ? b.enlaces : []).slice(0, 30).map(i => ({ t: S(i && i.t, 120), u: S(i && i.u, 500) })).filter(i => i.u);
  const media = (Array.isArray(b.media) ? b.media : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20);
  const f = S(b.fecha_plan, 10);
  return {
    titulo: S(b.titulo, 200), client_id: parseInt(b.client_id) || null, estado: ESTADOS.includes(b.estado) ? b.estado : 'idea',
    formato: FORMATOS.includes(b.formato) ? b.formato : 'post', redes, pilar_id: parseInt(b.pilar_id) || null, responsable: S(b.responsable, 80),
    fecha_plan: /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null, hora_plan: /^\d{2}:\d{2}$/.test(S(b.hora_plan, 5)) ? S(b.hora_plan, 5) : '',
    brief: S(b.brief, 6000), copy, notas: S(b.notas, 6000), checklist, enlaces, link_publicado: S(b.link_publicado, 500),
    media, campaign_id: parseInt(b.campaign_id) || null, primer_comentario: S(b.primer_comentario, 2000), hashtags: S(b.hashtags, 1200),
  };
}
const NUM = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };

function mount(app, { pool, requireAuth, express }) {
  init(pool).catch(e => console.error('[content] init', e.message));
  const A = requireAuth;
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[content]', e.message); res.status(500).json({ error: 'Error interno' }); } };
  const uid = req => req.workspaceOwnerId || req.user.id;
  const BASE = process.env.APP_BASE_URL || 'https://app.novacentrax.com';
  const API_BASE = process.env.API_BASE_URL || 'https://api.novacentrax.com';
  if (express) app.use('/content-media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));
  const mediaUrl = f => `${API_BASE}/content-media/${f}`;
  async function clientOk(req, cid) {
    if (!cid) return true;
    const { rows } = await pool.query('SELECT 1 FROM clients WHERE id=$1 AND user_id=$2', [cid, uid(req)]);
    return rows.length > 0;
  }
  const mediaOut = r => ({ id: r.id, client_id: r.client_id, nombre: r.nombre, mime: r.mime, tipo: r.tipo, size: r.size, carpeta: r.carpeta, url: mediaUrl(r.file), created_at: r.created_at });

  // Todo lo que la pantalla necesita, en una sola llamada.
  app.get('/api/content/bootstrap', A, wrap(async (req, res) => {
    const u = uid(req);
    const [cl, ac, pi, pc, tm, md, st, cp, ap] = await Promise.all([
      pool.query(`SELECT id, nombre, empresa, estado FROM clients WHERE user_id=$1 AND COALESCE(tipo,'cliente') <> 'contacto' ORDER BY (COALESCE(estado,'activo') = 'inactivo'), LOWER(COALESCE(NULLIF(empresa,''), nombre))`, [u]),   // también los inactivos: la propia marca de la agencia suele estarlo
      pool.query('SELECT * FROM content_accounts WHERE user_id=$1 ORDER BY id', [u]),
      pool.query('SELECT * FROM content_pillars WHERE user_id=$1 ORDER BY id', [u]),
      pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM content_comments c WHERE c.piece_id=p.id) AS n_comentarios
                    FROM content_pieces p WHERE p.user_id=$1 ORDER BY p.orden, p.id DESC LIMIT 3000`, [u]),
      pool.query('SELECT nombre FROM team_members WHERE user_id=$1 ORDER BY LOWER(nombre)', [u]).catch(() => ({ rows: [] })),
      pool.query('SELECT * FROM content_media WHERE user_id=$1 ORDER BY id DESC LIMIT 1500', [u]),
      pool.query('SELECT client_id, data FROM content_strategy WHERE user_id=$1', [u]),
      pool.query('SELECT * FROM content_campaigns WHERE user_id=$1 ORDER BY inicio NULLS LAST, id', [u]),
      pool.query(`SELECT id, token, client_id, titulo, piece_ids, revoked, created_at, expires_at FROM content_approvals WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [u]),
    ]);
    res.json({
      clients: cl.rows, accounts: ac.rows, pillars: pi.rows, pieces: pc.rows, team: tm.rows.map(r => r.nombre), media: md.rows.map(mediaOut),
      strategies: Object.fromEntries(st.rows.map(r => [r.client_id, r.data])), campaigns: cp.rows,
      approvals: ap.rows.map(a => ({ ...a, url: `${BASE}/aprobar/${a.token}` })), estados: ESTADOS, formatos: FORMATOS, redes: REDES,
    });
  }));

  // ── Piezas
  function insertSql(f) {
    const vals = COLS.map(c => JSONC.has(c) ? JSON.stringify(f[c]) : f[c]);
    const ph = COLS.map((c, i) => `$${i + 2}${JSONC.has(c) ? '::jsonb' : ''}`);
    return { sql: `INSERT INTO content_pieces (user_id,${COLS.join(',')}) VALUES ($1,${ph.join(',')}) RETURNING *`, vals };
  }
  app.post('/api/content/pieces', A, wrap(async (req, res) => {
    const f = pieceFields(req.body || {});
    if (!f.titulo) return res.status(400).json({ error: 'Escribe un título o una idea' });
    if (!(await clientOk(req, f.client_id))) return res.status(400).json({ error: 'Cliente no válido' });
    const { sql, vals } = insertSql(f);
    const { rows: [r] } = await pool.query(sql, [uid(req), ...vals]);
    res.json(r);
  }));
  app.put('/api/content/pieces/:id', A, wrap(async (req, res) => {
    const f = pieceFields(req.body || {});
    if (!f.titulo) return res.status(400).json({ error: 'Escribe un título o una idea' });
    if (!(await clientOk(req, f.client_id))) return res.status(400).json({ error: 'Cliente no válido' });
    const sets = COLS.map((c, i) => `${c}=$${i + 3}${JSONC.has(c) ? '::jsonb' : ''}`);
    const vals = COLS.map(c => JSONC.has(c) ? JSON.stringify(f[c]) : f[c]);
    const ei = COLS.indexOf('estado') + 3;
    const { rows: [r] } = await pool.query(
      `UPDATE content_pieces SET ${sets.join(',')}, published_at = CASE WHEN $${ei}='publicado' THEN COALESCE(published_at, NOW()) ELSE NULL END, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`, [req.params.id, uid(req), ...vals]);
    if (!r) return res.status(404).json({ error: 'Pieza no encontrada' });
    res.json(r);
  }));
  // Mover entre etapas, cambiar la fecha o marcar publicada, sin tocar el resto de la pieza.
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
    if (b.link_publicado !== undefined) { vals.push(S(b.link_publicado, 500)); sets.push(`link_publicado=$${vals.length}`); }
    if (b.orden !== undefined) { vals.push(parseInt(b.orden) || 0); sets.push(`orden=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    const { rows: [r] } = await pool.query(`UPDATE content_pieces SET ${sets.join(',')}, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, vals);
    if (!r) return res.status(404).json({ error: 'Pieza no encontrada' });
    res.json(r);
  }));
  // Resultados de una pieza ya publicada (se anotan a mano; luego alimentan Analítica e Informes).
  app.put('/api/content/pieces/:id/resultados', A, wrap(async (req, res) => {
    const b = req.body || {};
    const r = { alcance: NUM(b.alcance), impresiones: NUM(b.impresiones), likes: NUM(b.likes), comentarios: NUM(b.comentarios), guardados: NUM(b.guardados), compartidos: NUM(b.compartidos), clics: NUM(b.clics), seguidores: NUM(b.seguidores), nota: S(b.nota, 600) };
    const { rows: [p] } = await pool.query('UPDATE content_pieces SET resultados=$3::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, uid(req), JSON.stringify(r)]);
    if (!p) return res.status(404).json({ error: 'Pieza no encontrada' });
    res.json(p);
  }));
  app.delete('/api/content/pieces/:id', A, wrap(async (req, res) => {
    await pool.query('DELETE FROM content_pieces WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  // ── Comentarios internos
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

  // ── Cuentas, pilares, campañas y estrategia
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
  const campFields = b => { const d = x => (/^\d{4}-\d{2}-\d{2}$/.test(S(x, 10)) ? S(x, 10) : null); return { nombre: S(b.nombre, 100), objetivo: S(b.objetivo, 500), inicio: d(b.inicio), fin: d(b.fin), color: hex(b.color, '#3B82F6'), client_id: parseInt(b.client_id) || null }; };
  app.post('/api/content/campaigns', A, wrap(async (req, res) => {
    const f = campFields(req.body || {}); if (!f.nombre) return res.status(400).json({ error: 'Falta el nombre de la campaña' });
    if (!(await clientOk(req, f.client_id))) return res.status(400).json({ error: 'Cliente no válido' });
    const { rows: [r] } = await pool.query('INSERT INTO content_campaigns (user_id,client_id,nombre,objetivo,inicio,fin,color) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [uid(req), f.client_id, f.nombre, f.objetivo, f.inicio, f.fin, f.color]);
    res.json(r);
  }));
  app.put('/api/content/campaigns/:id', A, wrap(async (req, res) => {
    const f = campFields(req.body || {}); if (!f.nombre) return res.status(400).json({ error: 'Falta el nombre de la campaña' });
    const { rows: [r] } = await pool.query('UPDATE content_campaigns SET client_id=$3,nombre=$4,objetivo=$5,inicio=$6,fin=$7,color=$8 WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, uid(req), f.client_id, f.nombre, f.objetivo, f.inicio, f.fin, f.color]);
    if (!r) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json(r);
  }));
  app.delete('/api/content/campaigns/:id', A, wrap(async (req, res) => {
    await pool.query('UPDATE content_pieces SET campaign_id=NULL WHERE campaign_id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    await pool.query('DELETE FROM content_campaigns WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));
  // Estrategia por cliente: objetivos, audiencia, tono, reglas, hashtags base, frecuencia por red…
  const STR_TXT = ['objetivos', 'audiencia', 'tono', 'si_decir', 'no_decir', 'hashtags', 'competidores', 'horarios', 'firma', 'notas'];
  app.put('/api/content/strategy/:clientId', A, wrap(async (req, res) => {
    const cid = parseInt(req.params.clientId); if (!cid || !(await clientOk(req, cid))) return res.status(400).json({ error: 'Cliente no válido' });
    const b = req.body || {}, d = {};
    for (const k of STR_TXT) d[k] = S(b[k], 3000);
    d.frecuencia = {};
    if (b.frecuencia && typeof b.frecuencia === 'object') for (const [k, v] of Object.entries(b.frecuencia)) if (REDES.includes(k)) d.frecuencia[k] = Math.max(0, Math.min(50, parseInt(v) || 0));
    await pool.query(`INSERT INTO content_strategy (user_id,client_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (user_id,client_id) DO UPDATE SET data=$3::jsonb, updated_at=NOW()`, [uid(req), cid, JSON.stringify(d)]);
    res.json(d);
  }));

  // ── Biblioteca de medios (archivos en disco, URL no adivinable)
  const multer = require('multer');
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 90 * 1024 * 1024, files: 10 } });
  app.post('/api/content/media', A, up.array('files', 10), wrap(async (req, res) => {
    const cid = parseInt((req.body || {}).client_id) || null; if (!(await clientOk(req, cid))) return res.status(400).json({ error: 'Cliente no válido' });
    const carpeta = S((req.body || {}).carpeta, 60), out = [], skipped = [];
    for (const f of req.files || []) {
      if (!MIME_OK.test(f.mimetype)) { skipped.push(f.originalname); continue; }
      const name = crypto.randomBytes(14).toString('hex') + (EXT[f.mimetype.toLowerCase()] || '');
      fs.writeFileSync(path.join(MEDIA_DIR, name), f.buffer);
      const tipo = f.mimetype.startsWith('video') ? 'video' : f.mimetype === 'application/pdf' ? 'documento' : 'imagen';
      const { rows: [r] } = await pool.query('INSERT INTO content_media (user_id,client_id,nombre,mime,tipo,size,file,carpeta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [uid(req), cid, S(f.originalname, 160), f.mimetype, tipo, f.size, name, carpeta]);
      out.push(mediaOut(r));
    }
    res.json({ media: out, skipped });
  }));
  app.delete('/api/content/media/:id', A, wrap(async (req, res) => {
    const { rows: [m] } = await pool.query('DELETE FROM content_media WHERE id=$1 AND user_id=$2 RETURNING file', [req.params.id, uid(req)]);
    if (m) { try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(m.file))); } catch (_) {} }
    await pool.query(`UPDATE content_pieces SET media = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(media) x WHERE (x#>>'{}')::int <> $1), '[]'::jsonb) WHERE user_id=$2 AND media @> to_jsonb($1::int)::jsonb`, [parseInt(req.params.id), uid(req)]).catch(() => {});
    res.json({ ok: true });
  }));

  // ── Aprobaciones: enlace público para que el cliente vea, apruebe o pida cambios (sin iniciar sesión)
  app.post('/api/content/approvals', A, wrap(async (req, res) => {
    const b = req.body || {}, ids = (Array.isArray(b.piece_ids) ? b.piece_ids : []).map(Number).filter(Boolean).slice(0, 60);
    if (!ids.length) return res.status(400).json({ error: 'Elige al menos una pieza' });
    const { rows: ok } = await pool.query('SELECT id, client_id FROM content_pieces WHERE user_id=$1 AND id = ANY($2::int[])', [uid(req), ids]);
    if (!ok.length) return res.status(400).json({ error: 'Piezas no válidas' });
    const token = crypto.randomBytes(18).toString('hex');
    const cid = parseInt(b.client_id) || ok[0].client_id || null;
    const { rows: [a] } = await pool.query('INSERT INTO content_approvals (token,user_id,client_id,titulo,piece_ids) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id, token, client_id, titulo, piece_ids, revoked, created_at, expires_at', [token, uid(req), cid, S(b.titulo, 120), JSON.stringify(ok.map(r => r.id))]);
    await pool.query(`UPDATE content_pieces SET aprob_estado='pendiente', aprob_nota='', estado = CASE WHEN estado IN ('idea','desarrollo','texto','diseno','revision') THEN 'aprobacion' ELSE estado END, updated_at=NOW() WHERE user_id=$1 AND id = ANY($2::int[])`, [uid(req), ok.map(r => r.id)]);
    res.json({ ...a, url: `${BASE}/aprobar/${a.token}` });
  }));
  app.post('/api/content/approvals/:id/revoke', A, wrap(async (req, res) => { await pool.query('UPDATE content_approvals SET revoked=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]); res.json({ ok: true }); }));

  async function aprob(token) {
    if (!/^[a-f0-9]{20,64}$/.test(String(token))) return null;
    const { rows: [a] } = await pool.query('SELECT * FROM content_approvals WHERE token=$1', [token]);
    return a && !a.revoked && new Date(a.expires_at) > new Date() ? a : null;
  }
  app.get('/api/content/public/:token', wrap(async (req, res) => {
    const a = await aprob(req.params.token); if (!a) return res.status(404).json({ error: 'Este enlace ya no está disponible.' });
    const { rows: ps } = await pool.query('SELECT * FROM content_pieces WHERE user_id=$1 AND id = ANY($2::int[]) ORDER BY fecha_plan NULLS LAST, id', [a.user_id, a.piece_ids]);
    const { rows: [cl] } = a.client_id ? await pool.query('SELECT nombre, empresa FROM clients WHERE id=$1', [a.client_id]) : { rows: [{}] };
    const mids = [...new Set(ps.flatMap(p => p.media || []))];
    const { rows: ms } = mids.length ? await pool.query('SELECT * FROM content_media WHERE user_id=$1 AND id = ANY($2::int[])', [a.user_id, mids]) : { rows: [] };
    const mm = new Map(ms.map(m => [m.id, mediaOut(m)]));
    const { rows: cm } = await pool.query('SELECT piece_id, autor, texto, created_at FROM content_comments WHERE piece_id = ANY($1::int[]) ORDER BY id', [ps.map(p => p.id)]);
    res.json({
      titulo: a.titulo, cliente: (cl && (cl.empresa || cl.nombre)) || '',
      pieces: ps.map(p => ({ id: p.id, titulo: p.titulo, formato: p.formato, redes: p.redes, copy: p.copy, hashtags: p.hashtags, primer_comentario: p.primer_comentario, fecha_plan: p.fecha_plan, hora_plan: p.hora_plan,
        aprob_estado: p.aprob_estado, aprob_nota: p.aprob_nota, media: (p.media || []).map(i => mm.get(i)).filter(Boolean), comentarios: cm.filter(c => c.piece_id === p.id) })),
    });
  }));
  app.post('/api/content/public/:token/:pid/decision', wrap(async (req, res) => {
    const a = await aprob(req.params.token); if (!a) return res.status(404).json({ error: 'Este enlace ya no está disponible.' });
    const pid = parseInt(req.params.pid); if (!a.piece_ids.includes(pid)) return res.status(404).json({ error: 'Pieza no encontrada' });
    const b = req.body || {}, dec = b.decision === 'aprobado' ? 'aprobado' : b.decision === 'cambios' ? 'cambios' : '';
    const nota = S(b.nota, 1500), nombre = S(b.nombre, 80) || 'Cliente';
    if (!dec) return res.status(400).json({ error: 'Decisión no válida' });
    if (dec === 'cambios' && !nota) return res.status(400).json({ error: 'Cuéntanos qué cambiarías' });
    const nuevo = dec === 'aprobado' ? `CASE WHEN estado IN ('aprobacion','revision') THEN 'programado' ELSE estado END` : `'revision'`;
    await pool.query(`UPDATE content_pieces SET aprob_estado=$3, aprob_nota=$4, estado=${nuevo}, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [pid, a.user_id, dec, nota]);
    await pool.query('INSERT INTO content_comments (piece_id,user_id,autor,texto) VALUES ($1,$2,$3,$4)', [pid, a.user_id, nombre + ' (cliente)', (dec === 'aprobado' ? 'Aprobó la pieza.' : 'Pidió cambios: ') + (nota ? (dec === 'aprobado' ? ' ' : '') + nota : '')]);
    res.json({ ok: true, decision: dec });
  }));
  app.post('/api/content/public/:token/:pid/comment', wrap(async (req, res) => {
    const a = await aprob(req.params.token); if (!a) return res.status(404).json({ error: 'Este enlace ya no está disponible.' });
    const pid = parseInt(req.params.pid); if (!a.piece_ids.includes(pid)) return res.status(404).json({ error: 'Pieza no encontrada' });
    const t = S((req.body || {}).texto, 1500); if (!t) return res.status(400).json({ error: 'Escribe un comentario' });
    await pool.query('INSERT INTO content_comments (piece_id,user_id,autor,texto) VALUES ($1,$2,$3,$4)', [pid, a.user_id, (S((req.body || {}).nombre, 80) || 'Cliente') + ' (cliente)', t]);
    res.json({ ok: true });
  }));
}

module.exports = { mount, init, ESTADOS, FORMATOS, REDES };
