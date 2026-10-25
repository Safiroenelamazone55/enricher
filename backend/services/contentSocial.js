'use strict';
// Módulo Contenido · conexión directa a las redes y publicación (LinkedIn, Instagram, Facebook, TikTok).
//
// Motor de publicación: @simple-post/sdk — MIT License, Copyright (c) 2026 Vladimir Haltakov (https://github.com/simple-post/core).
// La configuración OAuth de cada red (direcciones, permisos y pasos de intercambio/renovación de tokens) está adaptada de
// simple-post/core (scheduler/lib/oauth), también MIT. Ver backend/THIRD_PARTY_LICENSES/simple-post-LICENSE.txt.
const crypto = require('crypto');
const { encPass, decPass } = require('./mailboxService');

const RED = {
  linkedin: { nombre: 'LinkedIn', auth: 'https://www.linkedin.com/oauth/v2/authorization', token: 'https://www.linkedin.com/oauth/v2/accessToken', scope: 'openid profile email w_member_social', claves: 'Client ID y Client Secret' },
  facebook: { nombre: 'Facebook', auth: 'https://www.facebook.com/v25.0/dialog/oauth', token: 'https://graph.facebook.com/v25.0/oauth/access_token', scope: 'public_profile,pages_show_list,pages_manage_posts,business_management', claves: 'App ID y App Secret' },
  instagram: { nombre: 'Instagram', auth: 'https://www.instagram.com/oauth/authorize', token: 'https://api.instagram.com/oauth/access_token', scope: 'instagram_business_basic,instagram_business_content_publish', claves: 'Instagram App ID y Instagram App Secret' },
  tiktok: { nombre: 'TikTok', auth: 'https://www.tiktok.com/v2/auth/authorize', token: 'https://open.tiktokapis.com/v2/oauth/token/', scope: 'user.info.basic,video.upload,video.publish,user.info.profile', claves: 'Client Key y Client Secret' },
};
const REDES = Object.keys(RED);
const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const SECRET = process.env.MAILBOX_SECRET || process.env.SESSION_SECRET || 'enricher-dev-secret-change-in-prod';
const b64 = x => Buffer.from(x).toString('base64url');

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS social_apps (
    user_id INTEGER NOT NULL, red TEXT NOT NULL, app_id TEXT NOT NULL DEFAULT '', secret_enc TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, red))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS social_connections (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, client_id INTEGER, red TEXT NOT NULL, cuenta TEXT NOT NULL DEFAULT '', ext_id TEXT NOT NULL DEFAULT '',
    access_enc TEXT NOT NULL DEFAULT '', refresh_enc TEXT NOT NULL DEFAULT '', expires_at TIMESTAMPTZ, extra JSONB NOT NULL DEFAULT '{}',
    estado TEXT NOT NULL DEFAULT 'ok', ultimo_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const q of [
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS publicaciones JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS auto_publicar BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS pub_lock TIMESTAMPTZ`,
  ]) await pool.query(q).catch(() => {});   // content_pieces la crea contentRoutes; si aún no existe, se reintenta al reiniciar
}

// «state» firmado: evita que otra persona complete una conexión que no inició.
const signState = o => { const p = b64(JSON.stringify({ ...o, exp: Date.now() + 15 * 60000 })); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
function readState(s) {
  const [p, sig] = String(s || '').split('.'); if (!p || !sig) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (_) { return null; }
}

async function appCreds(pool, uid, red) {
  const { rows: [r] } = await pool.query('SELECT app_id, secret_enc FROM social_apps WHERE user_id=$1 AND red=$2', [uid, red]);
  if (!r || !r.app_id || !r.secret_enc) return null;
  try { return { id: r.app_id, secret: decPass(r.secret_enc) }; } catch (_) { return null; }
}
async function postForm(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(S((d.error_description || (d.error && (d.error.message || d.error)) || d.message || ('HTTP ' + r.status)), 200));
  return d;
}
async function getJson(url, token) {
  const r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(S((d.error && (d.error.message || d.error)) || d.message || ('HTTP ' + r.status), 200));
  return d;
}
const enSeg = s => new Date(Date.now() + (Number(s) || 0) * 1000);

// Completa la conexión: intercambia el código, obtiene la cuenta y guarda los tokens cifrados.
async function completar(pool, st, red, code, creds, redirectUri) {
  const cfg = RED[red], extra = {}, filas = [];
  let tk;
  if (red === 'tiktok') tk = await postForm(cfg.token, { client_key: creds.id, client_secret: creds.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  else tk = await postForm(cfg.token, { client_id: creds.id, client_secret: creds.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  if (red === 'linkedin') {
    const u = await getJson('https://api.linkedin.com/v2/userinfo', tk.access_token);
    filas.push({ cuenta: u.name || 'Perfil de LinkedIn', ext_id: u.sub, access: tk.access_token, refresh: tk.refresh_token || '', expires: enSeg(tk.expires_in || 5184000), extra });
  } else if (red === 'instagram') {
    const l = await getJson('https://graph.instagram.com/access_token?' + new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: creds.secret, access_token: tk.access_token }));
    let pf; try { pf = await getJson('https://graph.instagram.com/me?fields=user_id,username,name', l.access_token); } catch (_) { pf = await getJson('https://graph.instagram.com/me?fields=user_id,username', l.access_token); }
    filas.push({ cuenta: pf.username ? '@' + pf.username : (pf.name || 'Instagram'), ext_id: String(pf.user_id || pf.id), access: l.access_token, refresh: '', expires: enSeg(l.expires_in || 5184000), extra });
  } else if (red === 'facebook') {
    const pg = await getJson('https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token', tk.access_token);
    for (const p of pg.data || []) filas.push({ cuenta: p.name, ext_id: p.id, access: p.access_token, refresh: '', expires: null, extra });   // el token de página no caduca
    if (!filas.length) throw new Error('No se encontraron páginas de Facebook en esa cuenta. Debes ser administradora de la página.');
  } else if (red === 'tiktok') {
    let nombre = 'TikTok'; try { const u = await getJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', tk.access_token); const x = (u.data || {}).user || {}; nombre = x.display_name || x.username || nombre; } catch (_) {}
    filas.push({ cuenta: nombre, ext_id: tk.open_id || '', access: tk.access_token, refresh: tk.refresh_token || '', expires: enSeg(tk.expires_in || 86400), extra: { refresh_expires: tk.refresh_expires_in || null } });
  }
  for (const f of filas) {
    await pool.query('DELETE FROM social_connections WHERE user_id=$1 AND red=$2 AND ext_id=$3 AND COALESCE(client_id,0)=COALESCE($4,0)', [st.u, red, f.ext_id, st.c || null]);
    await pool.query(`INSERT INTO social_connections (user_id,client_id,red,cuenta,ext_id,access_enc,refresh_enc,expires_at,extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [st.u, st.c || null, red, S(f.cuenta, 120), String(f.ext_id || ''), encPass(f.access), f.refresh ? encPass(f.refresh) : '', f.expires, JSON.stringify(f.extra || {})]);
  }
  return filas.length;
}

// Renueva el acceso si hace falta. LinkedIn no renueva solo: hay que volver a conectar cuando caduca.
async function frescos(pool, c) {
  const exp = c.expires_at ? new Date(c.expires_at).getTime() : 0, creds = await appCreds(pool, c.user_id, c.red);
  if (c.red === 'instagram' && exp && exp - Date.now() < 7 * 864e5 && exp > Date.now()) {
    try { const r = await getJson('https://graph.instagram.com/refresh_access_token?' + new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: decPass(c.access_enc) })); c.access_enc = encPass(r.access_token); c.expires_at = enSeg(r.expires_in || 5184000); await pool.query('UPDATE social_connections SET access_enc=$2, expires_at=$3 WHERE id=$1', [c.id, c.access_enc, c.expires_at]); } catch (_) {}
  } else if (c.red === 'tiktok' && c.refresh_enc && creds && exp && exp - Date.now() < 10 * 60000) {
    try { const r = await postForm(RED.tiktok.token, { client_key: creds.id, client_secret: creds.secret, grant_type: 'refresh_token', refresh_token: decPass(c.refresh_enc) }); c.access_enc = encPass(r.access_token); if (r.refresh_token) c.refresh_enc = encPass(r.refresh_token); c.expires_at = enSeg(r.expires_in || 86400); await pool.query('UPDATE social_connections SET access_enc=$2, refresh_enc=$3, expires_at=$4, estado=\'ok\', ultimo_error=\'\' WHERE id=$1', [c.id, c.access_enc, c.refresh_enc, c.expires_at]); }
    catch (e) { await pool.query('UPDATE social_connections SET estado=\'caducada\', ultimo_error=$2 WHERE id=$1', [c.id, S(e.message, 200)]); throw new Error('TikTok pide volver a conectar la cuenta: ' + e.message); }
  }
  if (c.expires_at && new Date(c.expires_at).getTime() < Date.now() && c.red !== 'facebook') {
    await pool.query('UPDATE social_connections SET estado=\'caducada\' WHERE id=$1', [c.id]);
    throw new Error('La conexión con ' + RED[c.red].nombre + ' caducó. Vuelve a conectar la cuenta en Contenido → Conexiones.');
  }
  return c;
}
function credencialesSdk(c) {
  const tok = decPass(c.access_enc);
  if (c.red === 'linkedin') return { accessToken: tok, memberId: c.ext_id };
  if (c.red === 'instagram') return { accessToken: tok, businessAccountId: c.ext_id, graphApi: 'instagram', ...(c.expires_at ? { expiresAt: new Date(c.expires_at).getTime() } : {}) };
  if (c.red === 'facebook') return { pageAccessToken: tok, pageId: c.ext_id };
  return { accessToken: tok };
}

// Publica una pieza en las redes pedidas (o en todas las que tenga). Nunca vuelve a publicar en una red donde ya salió.
async function publicarPieza(pool, uid, pieceId, soloRedes) {
  const { post } = require('@simple-post/sdk');
  const { rows: [p] } = await pool.query('SELECT * FROM content_pieces WHERE id=$1 AND user_id=$2', [pieceId, uid]);
  if (!p) throw new Error('Pieza no encontrada');
  const { rows: [st] } = p.client_id ? await pool.query('SELECT data FROM content_strategy WHERE user_id=$1 AND client_id=$2', [uid, p.client_id]) : { rows: [] };
  const firma = (st && st.data && st.data.firma) || '';
  const API_BASE = process.env.API_BASE_URL || 'https://api.novacentrax.com';
  const { rows: meds } = (p.media || []).length ? await pool.query('SELECT * FROM content_media WHERE user_id=$1 AND id = ANY($2::int[])', [uid, p.media]) : { rows: [] };
  const media = (p.media || []).map(id => meds.find(m => m.id === id)).filter(m => m && m.tipo !== 'documento').map(m => ({ type: m.tipo === 'video' ? 'video' : 'image', url: `${API_BASE}/content-media/${m.file}` }));
  const pub = { ...(p.publicaciones || {}) };
  const redes = (soloRedes && soloRedes.length ? soloRedes : p.redes || []).filter(r => REDES.includes(r));
  if (!redes.length) throw new Error('La pieza no tiene redes con conexión directa (LinkedIn, Instagram, Facebook o TikTok).');
  for (const red of redes) {
    if (pub[red] && pub[red].ok) continue;
    try {
      const { rows: [c] } = await pool.query(`SELECT * FROM social_connections WHERE user_id=$1 AND red=$2 AND estado='ok' AND (client_id=$3 OR client_id IS NULL) ORDER BY (client_id IS NULL), id DESC LIMIT 1`, [uid, red, p.client_id]);
      if (!c) throw new Error('No hay una cuenta de ' + RED[red].nombre + ' conectada para este cliente.');
      await frescos(pool, c);
      const texto = [((p.copy || {})[red] || '').trim() || p.titulo, p.hashtags, firma].filter(Boolean).join('\n\n');
      const opciones = { credentials: credencialesSdk(c) };
      if (red === 'tiktok') opciones.publishMode = 'draft';   // al buzón de TikTok: se termina de publicar en la app (la publicación directa exige auditoría)
      const res = await post({ content: { text: texto, ...(media.length ? { media } : {}) }, platforms: [red], options: { [red]: opciones } });
      const r = res.get(red) || {};
      if (r.error && r.error !== 'NO_ERROR') throw new Error(S(r.message || r.error, 300));
      pub[red] = { ok: true, id: r.id || '', url: r.url || '', at: new Date().toISOString(), cuenta: c.cuenta, borrador: red === 'tiktok' };
    } catch (e) { pub[red] = { ok: false, error: S(e.message, 300), at: new Date().toISOString() }; }
  }
  const todas = (p.redes || []).filter(r => REDES.includes(r)), okTodas = todas.length > 0 && todas.every(r => pub[r] && pub[r].ok);
  const link = Object.values(pub).map(x => x && x.url).find(Boolean) || p.link_publicado || '';
  const { rows: [out] } = await pool.query(
    `UPDATE content_pieces SET publicaciones=$3::jsonb, link_publicado=$4, estado = CASE WHEN $5 THEN 'publicado' ELSE estado END, published_at = CASE WHEN $5 THEN COALESCE(published_at, NOW()) ELSE published_at END, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
    [pieceId, uid, JSON.stringify(pub), link, okTodas]);
  return out;
}

function mount(app, { pool, requireAuth }) {
  init(pool).catch(e => console.error('[social] init', e.message));
  setTimeout(() => init(pool).catch(() => {}), 10000);   // reintento: content_pieces la crea contentRoutes al arrancar
  const A = requireAuth, uid = req => req.workspaceOwnerId || req.user.id;
  const BASE = process.env.APP_BASE_URL || 'https://app.novacentrax.com', API_BASE = process.env.API_BASE_URL || 'https://api.novacentrax.com';
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[social]', e.message); res.status(500).json({ error: S(e.message, 200) || 'Error interno' }); } };
  const redirectUri = red => `${API_BASE}/api/content/social/callback/${red}`;

  app.get('/api/content/social', A, wrap(async (req, res) => {
    const u = uid(req);
    const [ap, cn] = await Promise.all([pool.query('SELECT red, app_id, secret_enc FROM social_apps WHERE user_id=$1', [u]), pool.query('SELECT id, client_id, red, cuenta, estado, ultimo_error, expires_at, created_at FROM social_connections WHERE user_id=$1 ORDER BY id', [u])]);
    res.json({ redes: REDES.map(r => ({ red: r, nombre: RED[r].nombre, claves: RED[r].claves, scope: RED[r].scope, redirect: redirectUri(r), configurada: ap.rows.some(a => a.red === r && a.app_id && a.secret_enc), app_id: (ap.rows.find(a => a.red === r) || {}).app_id || '' })), conexiones: cn.rows });
  }));
  app.put('/api/content/social/apps/:red', A, wrap(async (req, res) => {
    const red = req.params.red; if (!REDES.includes(red)) return res.status(400).json({ error: 'Red no válida' });
    const id = S((req.body || {}).app_id, 200), secret = S((req.body || {}).secret, 400);
    if (!id) return res.status(400).json({ error: 'Falta el ID de la app' });
    const { rows: [prev] } = await pool.query('SELECT secret_enc FROM social_apps WHERE user_id=$1 AND red=$2', [uid(req), red]);
    if (!secret && !(prev && prev.secret_enc)) return res.status(400).json({ error: 'Falta el secreto de la app' });
    await pool.query(`INSERT INTO social_apps (user_id,red,app_id,secret_enc) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,red) DO UPDATE SET app_id=$3, secret_enc=CASE WHEN $4 <> '' THEN $4 ELSE social_apps.secret_enc END, updated_at=NOW()`, [uid(req), red, id, secret ? encPass(secret) : '']);
    res.json({ ok: true });
  }));
  app.delete('/api/content/social/apps/:red', A, wrap(async (req, res) => { if (!REDES.includes(req.params.red)) return res.status(400).json({ error: 'Red no válida' }); await pool.query('DELETE FROM social_apps WHERE user_id=$1 AND red=$2', [uid(req), req.params.red]); res.json({ ok: true }); }));
  // Devuelve la dirección de autorización de la red; el navegador abre esa ventana y la red vuelve al callback.
  app.get('/api/content/social/connect/:red', A, wrap(async (req, res) => {
    const red = req.params.red; if (!REDES.includes(red)) return res.status(400).json({ error: 'Red no válida' });
    const creds = await appCreds(pool, uid(req), red); if (!creds) return res.status(400).json({ error: 'Primero guarda el ID y el secreto de la app de ' + RED[red].nombre + '.' });
    const cid = parseInt(req.query.client_id) || null;
    const q = { redirect_uri: redirectUri(red), scope: RED[red].scope, response_type: 'code', state: signState({ u: uid(req), c: cid, r: red }) };
    if (red === 'tiktok') q.client_key = creds.id; else q.client_id = creds.id;
    if (red === 'instagram') { q.enable_fb_login = '0'; q.force_authentication = '1'; }
    res.json({ url: RED[red].auth + '?' + new URLSearchParams(q).toString() });
  }));
  app.get('/api/content/social/callback/:red', wrap(async (req, res) => {
    const red = req.params.red, fin = (ok, msg) => res.redirect(`${BASE}/?tab=contenido-conexiones&conexion=${ok ? 'ok' : 'error'}&red=${encodeURIComponent(red)}&msg=${encodeURIComponent(S(msg, 200))}`);
    const st = readState(req.query.state);
    if (!REDES.includes(red) || !st || st.r !== red) return fin(false, 'El enlace de conexión no es válido o caducó. Inténtalo de nuevo.');
    if (req.query.error) return fin(false, S(req.query.error_description || req.query.error, 200));
    try {
      const creds = await appCreds(pool, st.u, red); if (!creds) return fin(false, 'Faltan las claves de la app.');
      const n = await completar(pool, st, red, String(req.query.code || '').replace(/#_$/, ''), creds, redirectUri(red));
      fin(true, n + (n === 1 ? ' cuenta conectada' : ' cuentas conectadas'));
    } catch (e) { fin(false, e.message); }
  }));
  app.delete('/api/content/social/connections/:id', A, wrap(async (req, res) => { await pool.query('DELETE FROM social_connections WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]); res.json({ ok: true }); }));
  app.put('/api/content/social/connections/:id', A, wrap(async (req, res) => {
    const cid = parseInt((req.body || {}).client_id) || null; await pool.query('UPDATE social_connections SET client_id=$3 WHERE id=$1 AND user_id=$2', [req.params.id, uid(req), cid]); res.json({ ok: true });
  }));
  app.put('/api/content/pieces/:id/auto', A, wrap(async (req, res) => {
    const { rows: [r] } = await pool.query('UPDATE content_pieces SET auto_publicar=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id, auto_publicar', [req.params.id, uid(req), !!(req.body || {}).auto]);
    if (!r) return res.status(404).json({ error: 'Pieza no encontrada' }); res.json(r);
  }));
  app.post('/api/content/pieces/:id/publish', A, wrap(async (req, res) => {
    const redes = Array.isArray((req.body || {}).redes) ? req.body.redes.map(String) : [];
    res.json(await publicarPieza(pool, uid(req), parseInt(req.params.id), redes));
  }));
}

// Programador: cada minuto publica las piezas «programadas» con publicación automática cuya hora ya llegó (hasta 24 h de margen).
function startScheduler(pool) {
  const tz = process.env.TZ_DEFAULT || 'America/Lima';
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id FROM content_pieces WHERE auto_publicar AND estado='programado' AND fecha_plan IS NOT NULL
           AND ((fecha_plan::text || ' ' || COALESCE(NULLIF(hora_plan,''),'09:00'))::timestamp AT TIME ZONE $1) <= NOW()
           AND ((fecha_plan::text || ' ' || COALESCE(NULLIF(hora_plan,''),'09:00'))::timestamp AT TIME ZONE $1) > NOW() - INTERVAL '24 hours'
           AND (pub_lock IS NULL OR pub_lock < NOW() - INTERVAL '10 minutes') LIMIT 10`, [tz]);
      for (const r of rows) {
        const { rowCount } = await pool.query(`UPDATE content_pieces SET pub_lock=NOW() WHERE id=$1 AND (pub_lock IS NULL OR pub_lock < NOW() - INTERVAL '10 minutes')`, [r.id]);
        if (!rowCount) continue;
        try { await publicarPieza(pool, r.user_id, r.id); } catch (e) { console.error('[social] auto', r.id, e.message); }
      }
    } catch (e) { if (!/content_pieces|pub_lock|auto_publicar/.test(e.message)) console.error('[social] scheduler', e.message); }
  }, 60000);
  console.log('[social] programador de publicaciones activo');
}

module.exports = { mount, startScheduler, publicarPieza, REDES };
