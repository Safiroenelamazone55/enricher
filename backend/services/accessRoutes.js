'use strict';
// Acceso con correo + contraseña (para personas con correo de dominio propio, sin Google) y restablecimiento de contraseña.
//  · El admin del workspace crea el acceso desde Configuración → Usuarios: se genera un enlace de un solo uso para que la persona
//    ELIJA su contraseña (el admin nunca la ve ni la escribe) y se envía por correo desde un buzón del workspace
//    (SYSTEM_MAILBOX_EMAIL, por defecto jenny@novacentrax.com). Si el correo no sale, se devuelve el enlace para copiarlo.
//  · Contraseñas: scrypt con sal propia. Tokens de un solo uso: solo se guarda su hash (sha256), nunca el token.
//  · Solo entran por contraseña las cuentas con password_hash (creadas por un admin o que ya la definieron).

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SYSTEM_MAILBOX = (process.env.SYSTEM_MAILBOX_EMAIL || 'jenny@novacentrax.com').toLowerCase();
const APP_URL = (process.env.APP_URL || 'https://app.novacentrax.com').replace(/\/+$/, '');
const okEmail = e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(e) && e.length <= 160;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, saltHex, keyHex] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
    const key = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64);
    const want = Buffer.from(keyHex, 'hex');
    return key.length === want.length && crypto.timingSafeEqual(key, want);
  } catch (_) { return false; }
}
function passwordProblem(pw) {
  const p = String(pw || '');
  if (p.length < 10) return 'La contraseña debe tener al menos 10 caracteres';
  if (p.length > 128) return 'La contraseña es demasiado larga';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Usa letras y al menos un número';
  return '';
}

function mount(app, { pool, requireAuth, rateLimit, findUserById, mailboxSvc }) {
  // ── Esquema ───────────────────────────────────────────────────────────────
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`)
    .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_pending BOOLEAN NOT NULL DEFAULT false`))
    .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ`))
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS pw_reset_tokens (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL DEFAULT 'reset', expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ, created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`))
    .catch(e => console.error('[access] esquema:', e.message));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => (req.ip || '') + '|' + String((req.body && req.body.email) || '').toLowerCase(),
    message: { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' } });
  const mailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => (req.ip || '') + '|' + String((req.body && req.body.email) || '').toLowerCase(),
    message: { error: 'Ya se pidió un enlace hace poco. Revisa tu correo o espera unos minutos.' } });

  async function newToken(userId, kind, hours, createdBy) {
    await pool.query(`UPDATE pw_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [userId]);   // solo vale el último enlace
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + hours * 3600 * 1000);
    await pool.query(`INSERT INTO pw_reset_tokens (user_id, token_hash, kind, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [userId, sha(token), kind, expires, createdBy || null]);
    return { token, expires, link: `${APP_URL}/?reset=${token}` };
  }

  async function sendMail(ownerId, to, subject, html) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM lm_mailboxes WHERE user_id=$1 AND LOWER(email)=$2 AND estado IN ('conectado','solo_envio') LIMIT 1`, [ownerId, SYSTEM_MAILBOX]);
      if (!rows.length) return { ok: false, error: `El buzón ${SYSTEM_MAILBOX} no está conectado para enviar` };
      const auth = await mailboxSvc.getMailboxAuth(pool, rows[0]);
      await mailboxSvc.sendFromMailbox(rows[0], auth, { to, subject, html, text: html.replace(/<[^>]+>/g, ' '), fromName: 'Nova Centrax' });
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  }
  function mailHtml({ titulo, intro, boton, link, nota }) {
    return `<div style="font-family:Segoe UI,Verdana,sans-serif;max-width:480px;margin:0 auto;color:#1F1D1B;line-height:1.55">
      <h2 style="margin:0 0 12px;font-size:20px">${esc(titulo)}</h2>
      <p style="margin:0 0 18px">${intro}</p>
      <p style="margin:0 0 22px"><a href="${esc(link)}" style="background:#0A84FF;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(boton)}</a></p>
      <p style="margin:0 0 6px;font-size:13px;color:#6b6760">Si el botón no abre, copia este enlace en tu navegador:<br><span style="word-break:break-all">${esc(link)}</span></p>
      <p style="margin:14px 0 0;font-size:13px;color:#6b6760">${nota}</p></div>`;
  }
  const ownerOnly = (req, res) => {
    if (req.user.workspace_id) { res.status(403).json({ error: 'Solo el admin del workspace puede hacer esto' }); return false; }
    return true;
  };

  // ── Públicos: iniciar sesión / pedir enlace / definir contraseña ─────────────
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const password = String((req.body && req.body.password) || '');
      const { rows } = email ? await pool.query(`SELECT id, password_hash FROM users WHERE LOWER(email)=$1 AND password_hash IS NOT NULL LIMIT 1`, [email]) : { rows: [] };
      const ok = rows.length ? await verifyPassword(password, rows[0].password_hash) : (await verifyPassword(password, 'scrypt$00$00'), false);
      if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      const user = await findUserById(rows[0].id);
      req.login(user, err => err ? res.status(500).json({ error: 'No se pudo iniciar la sesión' }) : res.json({ ok: true }));
    } catch (e) { console.error('[access] login', e.message); res.status(500).json({ error: 'No se pudo iniciar sesión' }); }
  });

  // El usuario olvidó su contraseña: siempre responde igual (no revela si el correo existe).
  app.post('/api/auth/forgot', mailLimiter, async (req, res) => {
    res.json({ ok: true, message: 'Si el correo tiene acceso con contraseña, recibirás un enlace para restablecerla.' });
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!okEmail(email)) return;
      const { rows } = await pool.query(`SELECT id, workspace_id, name FROM users WHERE LOWER(email)=$1 AND (password_hash IS NOT NULL OR password_pending) LIMIT 1`, [email]);
      if (!rows.length) return;
      const t = await newToken(rows[0].id, 'reset', 2, null);
      await sendMail(rows[0].workspace_id || rows[0].id, email, 'Restablece tu contraseña de Nova',
        mailHtml({ titulo: 'Restablece tu contraseña', intro: 'Pediste restablecer tu contraseña de Nova. Haz clic para elegir una nueva.', boton: 'Elegir nueva contraseña', link: t.link,
          nota: 'El enlace vale 2 horas y se puede usar una sola vez. Si no lo pediste, ignora este correo: tu contraseña no cambia.' }));
    } catch (e) { console.error('[access] forgot', e.message); }
  });

  async function tokenRow(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
    const { rows } = await pool.query(
      `SELECT t.id, t.user_id, t.kind, u.email, u.name FROM pw_reset_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at > NOW()`, [sha(token)]);
    return rows[0] || null;
  }
  app.get('/api/auth/reset-info', async (req, res) => {
    try {
      const t = await tokenRow(req.query.token);
      if (!t) return res.status(404).json({ error: 'El enlace venció o ya se usó. Pide uno nuevo.' });
      res.json({ ok: true, email: t.email, kind: t.kind });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/auth/reset', loginLimiter, async (req, res) => {
    try {
      const t = await tokenRow(req.body && req.body.token);
      if (!t) return res.status(400).json({ error: 'El enlace venció o ya se usó. Pide uno nuevo.' });
      const bad = passwordProblem(req.body.password);
      if (bad) return res.status(400).json({ error: bad });
      const h = await hashPassword(req.body.password);
      await pool.query(`UPDATE users SET password_hash=$1, password_pending=false, password_set_at=NOW() WHERE id=$2`, [h, t.user_id]);
      await pool.query(`UPDATE pw_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [t.user_id]);
      const user = await findUserById(t.user_id);
      req.login(user, err => err ? res.status(500).json({ error: 'Contraseña guardada, pero no se pudo iniciar la sesión; entra con tu correo.' }) : res.json({ ok: true }));
    } catch (e) { console.error('[access] reset', e.message); res.status(500).json({ error: 'No se pudo guardar la contraseña' }); }
  });

  // ── Admin: dar acceso a una persona / enviar enlace para restablecer ─────────
  app.get('/api/team/access-info', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT LOWER(email) AS email, (password_hash IS NOT NULL) AS has_password, password_pending,
                (google_id NOT LIKE 'local:%') AS has_google
           FROM users WHERE id=$1 OR workspace_id=$1`, [req.workspaceOwnerId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  app.post('/api/team/access', requireAuth, async (req, res) => {
    if (!ownerOnly(req, res)) return;
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      const nombre = String(b.nombre || '').trim();
      if (!okEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido' });
      if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });
      const rol = ['admin', 'manager', 'miembro', 'freelance'].includes(b.rol) ? b.rol : 'miembro';
      const owner = req.workspaceOwnerId;
      let { rows: ur } = await pool.query(`SELECT id, workspace_id, password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1`, [email]);
      let uid;
      if (ur.length) {
        const u = ur[0];
        if (u.id === owner) return res.status(409).json({ error: 'Ese correo es el tuyo (el del dueño del workspace)' });
        if (u.workspace_id !== owner) return res.status(409).json({ error: 'Ese correo ya tiene su propio espacio de trabajo o pertenece a otro. No se puede mezclar.' });
        uid = u.id;
        await pool.query(`UPDATE users SET password_pending=true WHERE id=$1`, [uid]);
      } else {
        const ins = await pool.query(
          `INSERT INTO users (google_id, email, name, avatar, workspace_id, password_pending) VALUES ($1,$2,$3,'',$4,true) RETURNING id`,
          ['local:' + crypto.randomUUID(), email, nombre, owner]);
        uid = ins.rows[0].id;
      }
      const { rows: tm } = await pool.query(`SELECT id FROM team_members WHERE user_id=$1 AND LOWER(email)=$2 LIMIT 1`, [owner, email]);
      if (!tm.length) {
        await pool.query(`INSERT INTO team_members (user_id, nombre, email, rol, cargo, estado) VALUES ($1,$2,$3,$4,$5,'activo')`,
          [owner, nombre, email, rol, String(b.cargo || '').trim()]);
      }
      const t = await newToken(uid, 'invite', 24 * 7, req.user.id);
      const sent = await sendMail(owner, email, 'Te dieron acceso a Nova — crea tu contraseña',
        mailHtml({ titulo: `Hola ${nombre.split(' ')[0]}, ya tienes acceso a Nova`, intro: 'Te agregaron al equipo. Crea tu contraseña para entrar con este correo.', boton: 'Crear mi contraseña', link: t.link,
          nota: 'El enlace vale 7 días y se puede usar una sola vez. Después entrarás desde app.novacentrax.com con tu correo y la contraseña que elijas.' }));
      res.json({ ok: true, link: t.link, expires_at: t.expires, emailed: sent.ok, email_error: sent.ok ? '' : sent.error, from: SYSTEM_MAILBOX });
    } catch (e) { console.error('[access] access', e.message); res.status(500).json({ error: 'No se pudo crear el acceso' }); }
  });

  app.post('/api/team/reset-password', requireAuth, async (req, res) => {
    if (!ownerOnly(req, res)) return;
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const owner = req.workspaceOwnerId;
      const { rows } = await pool.query(`SELECT id, name FROM users WHERE LOWER(email)=$1 AND workspace_id=$2 LIMIT 1`, [email, owner]);
      if (!rows.length) return res.status(404).json({ error: 'Esa persona aún no tiene acceso. Usa «Añadir miembro con acceso».' });
      await pool.query(`UPDATE users SET password_pending=true WHERE id=$1`, [rows[0].id]);
      const t = await newToken(rows[0].id, 'reset', 24, req.user.id);
      const sent = await sendMail(owner, email, 'Restablece tu contraseña de Nova',
        mailHtml({ titulo: 'Restablece tu contraseña', intro: 'El administrador te envió este enlace para que elijas una nueva contraseña de Nova.', boton: 'Elegir nueva contraseña', link: t.link,
          nota: 'El enlace vale 24 horas y se puede usar una sola vez. Si no lo esperabas, ignora este correo.' }));
      res.json({ ok: true, link: t.link, expires_at: t.expires, emailed: sent.ok, email_error: sent.ok ? '' : sent.error, from: SYSTEM_MAILBOX });
    } catch (e) { console.error('[access] reset-password', e.message); res.status(500).json({ error: 'No se pudo generar el enlace' }); }
  });
}

module.exports = { mount };
