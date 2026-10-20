'use strict';
// Módulo Plantillas: marcas (logos/colores), plantillas (una por oferta, con nombre editable) y copias generadas (HTML inmutable por idioma).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { render, LANGS, logoOk } = require('./proposalTemplate');

const SEEDLOGOS = require('./tplSeedLogos');
const hexOk = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : d);
const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const VARIANT = ['blanco', 'negro', 'color'];

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS tpl_brands (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, nombre TEXT NOT NULL, email TEXT DEFAULT '', web TEXT DEFAULT '',
    color_primary TEXT DEFAULT '#0F9F8F', color_light TEXT DEFAULT '#2DD4BF', color_dark TEXT DEFAULT '#0F172A',
    logo_white TEXT, logo_black TEXT, logo_color TEXT, logo_oscuro TEXT DEFAULT 'blanco', logo_claro TEXT DEFAULT 'color',
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tpl_templates (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, nombre TEXT NOT NULL, oferta TEXT DEFAULT '', brand_id INT,
    lang TEXT DEFAULT 'es', defaults JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tpl_copies (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, template_id INT, titulo TEXT NOT NULL, cliente TEXT DEFAULT '', lang TEXT NOT NULL,
    params JSONB DEFAULT '{}'::jsonb, html TEXT NOT NULL, token TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS tpl_copies_user ON tpl_copies (user_id, created_at DESC)');
}

async function seedIfEmpty(pool, uid) {
  const { rows: [c] } = await pool.query('SELECT COUNT(*)::int n FROM tpl_brands WHERE user_id=$1', [uid]);
  if (c.n) return;
  const { rows: [b] } = await pool.query(
    `INSERT INTO tpl_brands (user_id,nombre,email,web,logo_white,logo_color) VALUES ($1,'NovaCentrax','contact@novacentrax.com','novacentrax.com',$2,$3) RETURNING id`,
    [uid, SEEDLOGOS.white, SEEDLOGOS.color]);
  await pool.query(`INSERT INTO tpl_templates (user_id,nombre,oferta,brand_id,lang,defaults) VALUES ($1,$2,$3,$4,'es',$5)`,
    [uid, 'Adquisición comercial B2B', 'Outbound + validación comercial', b.id, JSON.stringify({ fee: 550, plazo: 3, moneda: 'US$' })]);
}

const brandOut = b => ({ ...b, logos: { blanco: !!b.logo_white, negro: !!b.logo_black, color: !!b.logo_color },
  logo_white: undefined, logo_black: undefined, logo_color: undefined,
  prev: { blanco: b.logo_white || null, negro: b.logo_black || null, color: b.logo_color || null } });

function cleanParams(p) {
  p = p || {};
  return { empresa: S(p.empresa, 120), contacto: S(p.contacto, 120), correo: S(p.correo, 160), fee: Math.max(0, parseInt(p.fee, 10) || 0),
    plazo: Math.min(36, Math.max(1, parseInt(p.plazo, 10) || 3)), moneda: S(p.moneda, 6) || 'US$', servicio: S(p.servicio, 80), servicioEm: S(p.servicioEm, 80), inicio: S(p.inicio, 60) };
}

function mount(app, { pool, requireAuth }) {
  init(pool).catch(e => console.error('[tpl] init', e.message));
  const A = requireAuth;
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[tpl]', e.message); res.status(500).json({ error: 'Error interno' }); } };
  const uid = req => req.user.id;

  // ---- marcas
  app.get('/api/tpl/brands', A, wrap(async (req, res) => {
    await seedIfEmpty(pool, uid(req));
    const { rows } = await pool.query('SELECT * FROM tpl_brands WHERE user_id=$1 ORDER BY id', [uid(req)]);
    res.json(rows.map(brandOut));
  }));
  const brandFields = b => ({ nombre: S(b.nombre, 80), email: S(b.email, 160), web: S(b.web, 160), cp: hexOk(b.color_primary, '#0F9F8F'), cl: hexOk(b.color_light, '#2DD4BF'), cd: hexOk(b.color_dark, '#0F172A'),
    lo: VARIANT.includes(b.logo_oscuro) ? b.logo_oscuro : 'blanco', lc: VARIANT.includes(b.logo_claro) ? b.logo_claro : 'color' });
  function logoVal(v) { if (v === null || v === '') return null; return logoOk(v) && v.length < 1500000 ? v : undefined; }
  app.post('/api/tpl/brands', A, wrap(async (req, res) => {
    const f = brandFields(req.body || {}); if (!f.nombre) return res.status(400).json({ error: 'Falta el nombre de la empresa' });
    const { rows: [r] } = await pool.query(`INSERT INTO tpl_brands (user_id,nombre,email,web,color_primary,color_light,color_dark,logo_oscuro,logo_claro) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uid(req), f.nombre, f.email, f.web, f.cp, f.cl, f.cd, f.lo, f.lc]);
    res.json(brandOut(r));
  }));
  app.put('/api/tpl/brands/:id', A, wrap(async (req, res) => {
    const f = brandFields(req.body || {}); if (!f.nombre) return res.status(400).json({ error: 'Falta el nombre de la empresa' });
    const sets = ['nombre=$3', 'email=$4', 'web=$5', 'color_primary=$6', 'color_light=$7', 'color_dark=$8', 'logo_oscuro=$9', 'logo_claro=$10'];
    const vals = [req.params.id, uid(req), f.nombre, f.email, f.web, f.cp, f.cl, f.cd, f.lo, f.lc];
    for (const [k, col] of [['logo_white', 'logo_white'], ['logo_black', 'logo_black'], ['logo_color', 'logo_color']]) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = logoVal(req.body[k]);
        if (v === undefined) return res.status(400).json({ error: 'Logo no válido (PNG, JPG, SVG o WebP, máx. ~1 MB)' });
        vals.push(v); sets.push(`${col}=$${vals.length}`);
      }
    }
    const { rows: [r] } = await pool.query(`UPDATE tpl_brands SET ${sets.join(',')} WHERE id=$1 AND user_id=$2 RETURNING *`, vals);
    if (!r) return res.status(404).json({ error: 'No encontrada' });
    res.json(brandOut(r));
  }));
  app.delete('/api/tpl/brands/:id', A, wrap(async (req, res) => {
    const { rows: [u] } = await pool.query('SELECT COUNT(*)::int n FROM tpl_templates WHERE brand_id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    if (u.n) return res.status(409).json({ error: 'Hay plantillas que usan esta empresa; cámbialas antes de borrarla' });
    await pool.query('DELETE FROM tpl_brands WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  // ---- plantillas (una por oferta)
  const tplOut = t => ({ id: t.id, nombre: t.nombre, oferta: t.oferta, brand_id: t.brand_id, lang: t.lang, defaults: t.defaults || {}, updated_at: t.updated_at, copias: t.copias });
  app.get('/api/tpl/templates', A, wrap(async (req, res) => {
    await seedIfEmpty(pool, uid(req));
    const { rows } = await pool.query(`SELECT t.*, (SELECT COUNT(*)::int FROM tpl_copies c WHERE c.template_id=t.id) copias FROM tpl_templates t WHERE t.user_id=$1 ORDER BY t.id`, [uid(req)]);
    res.json(rows.map(tplOut));
  }));
  async function tplFields(req) {
    const b = req.body || {}; const nombre = S(b.nombre, 100);
    if (!nombre) return { err: 'Ponle un nombre a la plantilla' };
    const { rows: [br] } = await pool.query('SELECT id FROM tpl_brands WHERE id=$1 AND user_id=$2', [parseInt(b.brand_id, 10) || 0, uid(req)]);
    if (!br) return { err: 'Elige una empresa (marca) para la plantilla' };
    const d = cleanParams(b.defaults); delete d.empresa; delete d.contacto; delete d.correo; delete d.inicio;
    return { nombre, oferta: S(b.oferta, 200), brand_id: br.id, lang: LANGS[b.lang] ? b.lang : 'es', defaults: d };
  }
  app.post('/api/tpl/templates', A, wrap(async (req, res) => {
    const f = await tplFields(req); if (f.err) return res.status(400).json({ error: f.err });
    const { rows: [r] } = await pool.query('INSERT INTO tpl_templates (user_id,nombre,oferta,brand_id,lang,defaults) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [uid(req), f.nombre, f.oferta, f.brand_id, f.lang, JSON.stringify(f.defaults)]);
    res.json(tplOut({ ...r, copias: 0 }));
  }));
  app.put('/api/tpl/templates/:id', A, wrap(async (req, res) => {
    const f = await tplFields(req); if (f.err) return res.status(400).json({ error: f.err });
    const { rows: [r] } = await pool.query('UPDATE tpl_templates SET nombre=$3,oferta=$4,brand_id=$5,lang=$6,defaults=$7,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, uid(req), f.nombre, f.oferta, f.brand_id, f.lang, JSON.stringify(f.defaults)]);
    if (!r) return res.status(404).json({ error: 'No encontrada' });
    res.json(tplOut({ ...r, copias: 0 }));
  }));
  app.post('/api/tpl/templates/:id/duplicate', A, wrap(async (req, res) => {
    const { rows: [r] } = await pool.query(`INSERT INTO tpl_templates (user_id,nombre,oferta,brand_id,lang,defaults) SELECT user_id, LEFT(nombre||' (copia)',100), oferta, brand_id, lang, defaults FROM tpl_templates WHERE id=$1 AND user_id=$2 RETURNING *`, [req.params.id, uid(req)]);
    if (!r) return res.status(404).json({ error: 'No encontrada' });
    res.json(tplOut({ ...r, copias: 0 }));
  }));
  app.delete('/api/tpl/templates/:id', A, wrap(async (req, res) => {
    await pool.query('UPDATE tpl_copies SET template_id=NULL WHERE template_id=$1 AND user_id=$2', [req.params.id, uid(req)]);   // las copias generadas se conservan
    await pool.query('DELETE FROM tpl_templates WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  // ---- generar
  async function build(req, tplId, params, lang) {
    const { rows: [t] } = await pool.query('SELECT * FROM tpl_templates WHERE id=$1 AND user_id=$2', [tplId, uid(req)]);
    if (!t) return null;
    const { rows: [b] } = await pool.query('SELECT * FROM tpl_brands WHERE id=$1 AND user_id=$2', [t.brand_id, uid(req)]);
    if (!b) return null;
    const given = {}; for (const k of Object.keys(params || {})) if (params[k] !== '' && params[k] != null) given[k] = params[k];
    const p = cleanParams({ ...(t.defaults || {}), ...given });
    return { t, p, html: render(b, p, lang) };
  }
  app.post('/api/tpl/preview', A, wrap(async (req, res) => {
    const lang = LANGS[req.body.lang] ? req.body.lang : 'es';
    const r = await build(req, parseInt(req.body.template_id, 10), req.body.params, lang);
    if (!r) return res.status(404).json({ error: 'Plantilla o empresa no encontrada' });
    res.json({ html: r.html });
  }));
  app.post('/api/tpl/copies', A, wrap(async (req, res) => {
    const langs = [...new Set((Array.isArray(req.body.langs) ? req.body.langs : [req.body.lang]).filter(l => LANGS[l]))];
    if (!langs.length) return res.status(400).json({ error: 'Elige al menos un idioma' });
    const out = [];
    for (const lang of langs) {
      const r = await build(req, parseInt(req.body.template_id, 10), req.body.params, lang);
      if (!r) return res.status(404).json({ error: 'Plantilla o empresa no encontrada' });
      const titulo = `${r.t.nombre} · ${r.p.empresa || 'Cliente'} · ${lang.toUpperCase()}`;
      const { rows: [c] } = await pool.query('INSERT INTO tpl_copies (user_id,template_id,titulo,cliente,lang,params,html,token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,titulo,cliente,lang,token,created_at',
        [uid(req), r.t.id, titulo, r.p.empresa || '', lang, JSON.stringify(r.p), r.html, crypto.randomBytes(18).toString('hex')]);
      out.push(c);
    }
    res.json(out);
  }));
  app.get('/api/tpl/copies', A, wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT c.id,c.titulo,c.cliente,c.lang,c.token,c.created_at,c.template_id,t.nombre AS plantilla FROM tpl_copies c LEFT JOIN tpl_templates t ON t.id=c.template_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 300`, [uid(req)]);
    res.json(rows);
  }));
  app.patch('/api/tpl/copies/:id', A, wrap(async (req, res) => {
    const titulo = S(req.body.titulo, 160); if (!titulo) return res.status(400).json({ error: 'Falta el título' });
    const { rowCount } = await pool.query('UPDATE tpl_copies SET titulo=$3 WHERE id=$1 AND user_id=$2', [req.params.id, uid(req), titulo]);
    res.json({ ok: !!rowCount });
  }));
  app.delete('/api/tpl/copies/:id', A, wrap(async (req, res) => {
    await pool.query('DELETE FROM tpl_copies WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));
  const sendHtml = (res, html, nombre, descarga) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (descarga) res.setHeader('Content-Disposition', `attachment; filename="${nombre.replace(/[^\w.\- ]+/g, '_')}.html"`);
    res.send(html);
  };
  app.get('/api/tpl/copies/:id/html', A, wrap(async (req, res) => {
    const { rows: [c] } = await pool.query('SELECT titulo,html FROM tpl_copies WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    if (!c) return res.status(404).json({ error: 'No encontrada' });
    sendHtml(res, c.html, c.titulo, req.query.download === '1');
  }));
  // enlace público (sin sesión) para compartir con el cliente: el token es largo e impredecible
  app.get('/api/tpl/public/:token', wrap(async (req, res) => {
    if (!/^[a-f0-9]{36}$/.test(req.params.token)) return res.status(404).send('No encontrada');
    const { rows: [c] } = await pool.query('SELECT html FROM tpl_copies WHERE token=$1', [req.params.token]);
    if (!c) return res.status(404).send('No encontrada');
    sendHtml(res, c.html, 'propuesta', false);
  }));
  app.get('/api/tpl/langs', A, (req, res) => res.json(LANGS));
}

module.exports = { mount };
