'use strict';
/**
 * portalRoutes.js — Portal del cliente (correo + contraseña asignada).
 *
 * AISLAMIENTO: las cuentas de cliente NO usan passport ni la tabla users. La sesión
 * guarda solo req.session.portal = { aid }; requireAuth (equipo) exige
 * req.isAuthenticated(), así que un cliente nunca pasa por endpoints internos.
 * Todas las consultas del portal se filtran por el outbound_client_id de la cuenta.
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const SECTIONS = ['kpis', 'actividad', 'embudo', 'canales', 'paises', 'respuestas', 'reuniones', 'secuencias', 'empresas', 'contactos', 'feed', 'chat'];
const REPLY_DISPOS = `('respondio','reunion','mas_adelante','derivado','no_es_persona','no_interesado','no_contactar')`;
const DISPO_LABEL = { respondio: 'Interesado', reunion: 'Reunión', mas_adelante: 'Más adelante', derivado: 'Derivó a otro', no_es_persona: 'No es la persona', no_interesado: 'No interesado', no_califica: 'No califica', no_contactar: 'No contactar' };

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  try {
    const [v, salt, hash] = String(stored).split('$');
    if (v !== 's1') return false;
    const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
    const b = Buffer.from(hash, 'hex');
    return b.length === h.length && crypto.timingSafeEqual(h, b);
  } catch { return false; }
}
function genPw() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12)).map(x => c[x % c.length]).join('');
}
function defaultSections() { const o = {}; SECTIONS.forEach(k => { o[k] = true; }); return o; }
const PORTAL_URL = 'https://app.novacentrax.com/portal.html';
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Envío best-effort por SES: nunca lanza; devuelve { sent, error }.
async function sendMail(to, subject, html, text) {
  try {
    if (!process.env.SES_FROM_EMAIL || !process.env.AWS_ACCESS_KEY_ID) return { sent: false, error: 'El envío de correo no está configurado' };
    const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
    const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '' } });
    await ses.send(new SendEmailCommand({ Source: process.env.SES_FROM_EMAIL, Destination: { ToAddresses: [to] },
      Message: { Subject: { Data: subject }, Body: { Html: { Data: html }, Text: { Data: text } } } }));
    return { sent: true };
  } catch (e) { console.warn('[portal] correo no enviado:', e.message); return { sent: false, error: e.message }; }
}
const mailShell = (title, body) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0F172A"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}<p style="margin:22px 0 0;font-size:12px;color:#94A3B8">Nova · mensaje automático, no respondas a este correo.</p></div>`;
async function sendInvite(to, nombre, cliente, pw, kind) {
  const t = kind === 'reset' ? 'Tu nueva contraseña del portal' : 'Ya tienes acceso a tu portal';
  const html = mailShell(t, `<p style="margin:0 0 12px">Hola${nombre ? ' ' + escH(nombre) : ''}, este es tu acceso al portal de <b>${escH(cliente)}</b>, donde puedes ver el avance en tiempo real y escribirnos por el chat.</p>
    <div style="background:#F8FAFC;border:1px solid #E1E6EC;padding:12px 14px;margin:0 0 14px;font-size:14px">Usuario: <b>${escH(to)}</b><br>Contraseña temporal: <b style="font-family:monospace">${escH(pw)}</b></div>
    <p style="margin:0 0 14px;font-size:13px;color:#475569">Al entrar por primera vez te pediremos crear tu propia contraseña.</p>
    <a href="${PORTAL_URL}" style="display:inline-block;background:#0B1220;color:#fff;padding:10px 20px;text-decoration:none;font-weight:600">Entrar al portal</a>`);
  return sendMail(to, t + ' — ' + cliente, html, `Acceso al portal de ${cliente}\nEnlace: ${PORTAL_URL}\nUsuario: ${to}\nContraseña temporal: ${pw}\nAl entrar te pediremos crear tu propia contraseña.`);
}
const cleanEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// Consulta reutilizable: destacados (última respuesta, próximas reuniones, señales positivas)
async function highlights(pool, clientId, { withNotes = true } = {}) {
  const base = `FROM lm_contacts k LEFT JOIN lm_companies co ON co.id=k.company_id WHERE k.outbound_client_id=$1`;
  const cols = `k.id AS contact_id, k.nombre, k.apellido, k.cargo, k.linkedin, COALESCE(NULLIF(co.nombre,''),k.empresa_nombre) AS empresa,
                COALESCE(NULLIF(k.pais,''),co.pais) AS pais${withNotes ? ', k.portal_nota' : ''}`;
  const [replies, meetings, positives, counts] = await Promise.all([
    pool.query(`SELECT * FROM (SELECT DISTINCT ON (k.id) ${cols}, a.fecha, a.tipo AS via, a.nota AS raw
                  FROM activities a JOIN lm_contacts k ON k.id=a.contact_id LEFT JOIN lm_companies co ON co.id=k.company_id
                 WHERE k.outbound_client_id=$1 AND a.estado='hecha' AND a.tipo='respuesta'
                 ORDER BY k.id, a.fecha DESC, a.id DESC) t ORDER BY fecha DESC LIMIT 6`, [clientId]),
    pool.query(`SELECT ${cols}, k.deal_cierre AS fecha, COALESCE(k.reunion_agendada_at,k.updated_at) AS agendada, k.deal_valor::float AS valor, k.deal_prob AS prob, k.deal_moneda AS moneda, k.disposition
                  ${base} AND k.deal_cierre >= CURRENT_DATE ORDER BY k.deal_cierre ASC LIMIT 10`, [clientId]),
    pool.query(`SELECT ${cols}, k.disposition,
                       (SELECT MAX(a.fecha) FROM activities a WHERE a.contact_id=k.id AND a.tipo='respuesta') AS ultima
                  ${base} AND k.disposition IN ('respondio','mas_adelante') AND k.deal_cierre IS NULL
                 ORDER BY ultima DESC NULLS LAST LIMIT 20`, [clientId]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE k.disposition IN ('respondio','mas_adelante','reunion'))::int AS positivas,
                       COUNT(*) FILTER (WHERE k.deal_cierre >= CURRENT_DATE)::int AS reuniones_prog
                  ${base}`, [clientId]),
  ]);
  const snip = raw => {
    let t = String(raw || '').replace(/^Respondió a\s*"[^"]*"\s*[—-]\s*/i, '').split(/_{3,}|-{3,}/)[0].replace(/\s+/g, ' ').trim();
    return t.length > 320 ? t.slice(0, 320) + '…' : t;
  };
  return {
    counts: counts.rows[0],
    last_replies: replies.rows.map(r => { const { raw, ...x } = r; return { ...x, snippet: snip(raw) }; }),
    next_meetings: meetings.rows,
    positive_pending: positives.rows.map(r => ({ ...r, estado: DISPO_LABEL[r.disposition] || r.disposition })),
  };
}

function mount(app, { pool, requireAuth, dashHandler }) {
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos.' } });
  const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados mensajes seguidos.' } });

  async function requirePortal(req, res, next) {
    try {
      const aid = req.session && req.session.portal && req.session.portal.aid;
      if (!aid) return res.status(401).json({ error: 'Inicia sesión' });
      const { rows } = await pool.query(
        `SELECT a.*, c.nombre AS cliente FROM client_accounts a JOIN outbound_clients c ON c.id=a.outbound_client_id WHERE a.id=$1 AND a.activo`, [aid]);
      if (!rows[0]) { delete req.session.portal; return res.status(401).json({ error: 'Inicia sesión' }); }
      req.portal = rows[0];
      req.portalSections = { ...defaultSections(), ...(rows[0].sections || {}) };
      next();
    } catch (e) { res.status(500).json({ error: 'Error de sesión' }); }
  }
  const need = key => (req, res, next) => req.portalSections[key] ? next() : res.status(403).json({ error: 'Sección no disponible' });

  // ── Auth ──
  app.post('/api/portal/login', loginLimiter, async (req, res) => {
    try {
      const email = cleanEmail(req.body && req.body.email), pw = String((req.body && req.body.password) || '');
      const fail = () => res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      if (!okEmail(email) || !pw) return fail();
      const { rows } = await pool.query(`SELECT * FROM client_accounts WHERE LOWER(email)=$1`, [email]);
      const a = rows[0];
      if (!a || !a.activo) return fail();
      if (a.locked_until && new Date(a.locked_until) > new Date()) return res.status(429).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos. Prueba en unos minutos.' });
      if (!checkPw(pw, a.password_hash)) {
        const n = a.failed_attempts + 1;
        await pool.query(`UPDATE client_accounts SET failed_attempts=CASE WHEN $2>=5 THEN 0 ELSE $2 END, locked_until=CASE WHEN $2>=5 THEN NOW()+interval '15 minutes' ELSE NULL END WHERE id=$1`, [a.id, n]);
        return fail();
      }
      await pool.query(`UPDATE client_accounts SET failed_attempts=0, locked_until=NULL, last_login=NOW() WHERE id=$1`, [a.id]);
      const set = () => { req.session.portal = { aid: a.id }; req.session.save(err => err ? res.status(500).json({ error: 'No se pudo iniciar sesión' }) : res.json({ ok: true, must_change: a.must_change })); };
      if (req.session.passport) return set();           // no pisar una sesión de equipo en el mismo navegador
      req.session.regenerate(err => { if (err) return res.status(500).json({ error: 'No se pudo iniciar sesión' }); set(); });
    } catch (e) { console.error('[portal] login', e.message); res.status(500).json({ error: 'Error al iniciar sesión' }); }
  });
  app.post('/api/portal/logout', (req, res) => { if (req.session) delete req.session.portal; res.json({ ok: true }); });
  // ── Olvidé mi contraseña: código de 6 dígitos por correo ──
  const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos.' } });
  const hashCode = c => crypto.createHash('sha256').update(String(c)).digest('hex');
  app.post('/api/portal/forgot', forgotLimiter, async (req, res) => {
    try {
      const email = cleanEmail(req.body && req.body.email);
      const generic = () => res.json({ ok: true, message: 'Si el correo tiene acceso, te enviamos un código de verificación.' });
      if (!okEmail(email)) return generic();
      const { rows } = await pool.query(`SELECT a.id, a.nombre, c.nombre AS cliente FROM client_accounts a JOIN outbound_clients c ON c.id=a.outbound_client_id WHERE LOWER(a.email)=$1 AND a.activo`, [email]);
      if (rows[0]) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await pool.query(`UPDATE client_accounts SET reset_code_hash=$2, reset_expires=NOW()+interval '15 minutes', reset_attempts=0 WHERE id=$1`, [rows[0].id, hashCode(code)]);
        await sendMail(email, 'Tu código de verificación — ' + rows[0].cliente,
          mailShell('Código de verificación', `<p style="margin:0 0 12px">Usa este código para crear una nueva contraseña del portal de <b>${escH(rows[0].cliente)}</b>. Vence en 15 minutos.</p><div style="font-size:30px;font-weight:800;letter-spacing:6px;background:#F8FAFC;border:1px solid #E1E6EC;padding:14px;text-align:center">${code}</div><p style="margin:14px 0 0;font-size:13px;color:#64748B">Si no lo pediste, ignora este correo.</p>`),
          'Tu código de verificación es ' + code + ' (vence en 15 minutos).');
      }
      generic();
    } catch (e) { console.error('[portal] forgot', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/portal/reset', forgotLimiter, async (req, res) => {
    try {
      const email = cleanEmail(req.body && req.body.email), code = String((req.body && req.body.code) || '').trim(), nueva = String((req.body && req.body.nueva) || '');
      const bad = () => res.status(400).json({ error: 'Código incorrecto o vencido' });
      if (!okEmail(email) || !/^\d{6}$/.test(code)) return bad();
      if (nueva.length < 10) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
      const { rows } = await pool.query(`SELECT id, reset_code_hash, reset_expires, reset_attempts FROM client_accounts WHERE LOWER(email)=$1 AND activo`, [email]);
      const a = rows[0];
      if (!a || !a.reset_code_hash || !a.reset_expires || new Date(a.reset_expires) < new Date() || a.reset_attempts >= 5) return bad();
      if (hashCode(code) !== a.reset_code_hash) { await pool.query(`UPDATE client_accounts SET reset_attempts=reset_attempts+1 WHERE id=$1`, [a.id]); return bad(); }
      await pool.query(`UPDATE client_accounts SET password_hash=$2, must_change=FALSE, failed_attempts=0, locked_until=NULL, reset_code_hash=NULL, reset_expires=NULL, reset_attempts=0 WHERE id=$1`, [a.id, hashPw(nueva)]);
      res.json({ ok: true });
    } catch (e) { console.error('[portal] reset', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.get('/api/portal/me', requirePortal, (req, res) => {
    const a = req.portal;
    res.json({ email: a.email, nombre: a.nombre, cliente: a.cliente, must_change: a.must_change, sections: req.portalSections });
  });
  app.post('/api/portal/password', requirePortal, async (req, res) => {
    try {
      const actual = String((req.body && req.body.actual) || ''), nueva = String((req.body && req.body.nueva) || '');
      if (!checkPw(actual, req.portal.password_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
      if (nueva.length < 10) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
      if (nueva === actual) return res.status(400).json({ error: 'Elige una contraseña distinta a la actual' });
      await pool.query(`UPDATE client_accounts SET password_hash=$2, must_change=FALSE WHERE id=$1`, [req.portal.id, hashPw(nueva)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error al cambiar la contraseña' }); }
  });

  // ── Datos (solo del cliente de la cuenta) ──
  app.get('/api/portal/dashboard', requirePortal, (req, res) => {
    const S = req.portalSections, cid = req.portal.outbound_client_id;
    req.workspaceOwnerId = req.portal.user_id;
    req.query = { from: req.query.from, to: req.query.to, sequence: req.query.sequence, channel: req.query.channel, country: req.query.country, client: String(cid) };
    const send = res.json.bind(res);
    res.json = body => {                                    // recorta según secciones habilitadas
      if (body && !body.error) {
        if (!S.kpis) body.kpi = null;
        if (!S.actividad) body.daily = [];
        if (!S.embudo) body.funnel = null;
        if (!S.canales) { body.channels = []; body.replyByCh = []; body.replyDays = null; }
        if (!S.paises) body.countries = [];
        if (!S.respuestas) { body.recent = []; body.dispo = []; body.heatAuto = []; }
        if (!S.reuniones) body.deals = null;
        if (!S.secuencias) body.sequences = [];
        body.clients = [];
        body.portal = true;
      }
      return send(body);
    };
    return dashHandler(req, res);
  });

  app.get('/api/portal/highlights', requirePortal, async (req, res) => {
    try {
      const h = await highlights(pool, req.portal.outbound_client_id);
      const S = req.portalSections;
      if (!S.respuestas) h.last_replies = [];
      if (!S.reuniones) h.next_meetings = [];
      res.json(h);
    } catch (e) { console.error('[portal] highlights', e.message); res.status(500).json({ error: 'Error' }); }
  });

  app.get('/api/portal/companies', requirePortal, need('empresas'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80);
      const { rows } = await pool.query(`
        SELECT co.id, co.nombre, co.pais, co.ciudad, co.industria, co.tamano, co.website,
               COUNT(k.id)::int AS contactos,
               BOOL_OR(k.disposition IN ${REPLY_DISPOS}) AS respondio,
               BOOL_OR(k.deal_cierre IS NOT NULL) AS con_reunion,
               BOOL_OR(EXISTS(SELECT 1 FROM lm_contact_sequences cs WHERE cs.contact_id=k.id AND cs.estado='activo')) AS en_curso,
               MAX(k.portal_nota) FILTER (WHERE COALESCE(k.portal_nota,'')<>'') AS nota
          FROM lm_companies co JOIN lm_contacts k ON k.company_id=co.id
         WHERE k.outbound_client_id=$1 AND ($2='' OR co.nombre ILIKE '%'||$2||'%')
         GROUP BY co.id ORDER BY BOOL_OR(k.deal_cierre IS NOT NULL) DESC, BOOL_OR(k.disposition IN ${REPLY_DISPOS}) DESC, co.nombre LIMIT 500`, [req.portal.outbound_client_id, q]);
      res.json(rows.map(r => ({ ...r, estado: r.con_reunion ? 'Reunión' : r.respondio ? 'Respondió' : r.en_curso ? 'En seguimiento' : 'Pendiente' })));
    } catch (e) { console.error('[portal] companies', e.message); res.status(500).json({ error: 'Error' }); }
  });

  app.get('/api/portal/contacts', requirePortal, need('contactos'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80), co = parseInt(req.query.company) || 0;
      const { rows } = await pool.query(`
        SELECT k.id, k.nombre, k.apellido, k.cargo, k.linkedin, k.disposition, k.deal_cierre, k.portal_nota,
               co.id AS company_id, COALESCE(NULLIF(co.nombre,''),k.empresa_nombre) AS empresa, COALESCE(NULLIF(k.pais,''),co.pais) AS pais,
               (SELECT s.nombre||'|'||cs.estado||'|'||cs.paso FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.contact_id=k.id ORDER BY cs.id DESC LIMIT 1) AS seq,
               (SELECT MAX(a.fecha) FROM activities a WHERE a.contact_id=k.id AND a.estado='hecha' AND a.tipo IN ('email_enviado','email','linkedin_msg','linkedin_connect','llamada','respuesta')) AS ultimo
          FROM lm_contacts k LEFT JOIN lm_companies co ON co.id=k.company_id
         WHERE k.outbound_client_id=$1 AND ($2='' OR (k.nombre||' '||k.apellido||' '||COALESCE(co.nombre,k.empresa_nombre,'')) ILIKE '%'||$2||'%') AND ($3=0 OR k.company_id=$3)
         ORDER BY (k.deal_cierre IS NOT NULL) DESC, (k.disposition IN ('respondio','mas_adelante','reunion')) DESC, ultimo DESC NULLS LAST LIMIT 300`, [req.portal.outbound_client_id, q, co]);
      res.json(rows.map(r => {
        const [sn, se, sp] = String(r.seq || '||').split('|');
        return { id: r.id, nombre: [r.nombre, r.apellido].filter(Boolean).join(' '), cargo: r.cargo, linkedin: r.linkedin, empresa: r.empresa, company_id: r.company_id, pais: r.pais,
          estado: r.deal_cierre ? 'Reunión agendada' : (DISPO_LABEL[r.disposition] || (se === 'activo' ? 'En seguimiento' : se === 'terminado' ? 'Secuencia completada' : se ? 'En pausa' : 'Pendiente')),
          secuencia: sn || '', paso: sp ? parseInt(sp) : null, ultimo: r.ultimo, nota: r.portal_nota || '' };
      }));
    } catch (e) { console.error('[portal] contacts', e.message); res.status(500).json({ error: 'Error' }); }
  });

  app.get('/api/portal/sequences', requirePortal, need('secuencias'), async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT s.id, s.nombre, s.estado,
               COUNT(DISTINCT cs.contact_id)::int AS enrolados,
               COUNT(DISTINCT cs.contact_id) FILTER (WHERE cs.estado='activo')::int AS activos,
               COUNT(DISTINCT cs.contact_id) FILTER (WHERE cs.estado='terminado')::int AS terminados,
               COUNT(DISTINCT cs.contact_id) FILTER (WHERE cs.estado='respondido')::int AS respondieron
          FROM sequences s LEFT JOIN lm_contact_sequences cs ON cs.sequence_id=s.id
         WHERE s.outbound_client_id=$1 AND s.estado<>'draft' GROUP BY s.id ORDER BY s.id DESC`, [req.portal.outbound_client_id]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  app.get('/api/portal/feed', requirePortal, need('feed'), async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT a.id, a.tipo, a.fecha, a.nota, k.id AS contact_id, k.nombre, k.apellido, k.cargo, COALESCE(NULLIF(co.nombre,''),k.empresa_nombre) AS empresa
          FROM activities a JOIN lm_contacts k ON k.id=a.contact_id LEFT JOIN lm_companies co ON co.id=k.company_id
         WHERE k.outbound_client_id=$1 AND a.estado='hecha'
           AND (a.tipo IN ('email_enviado','linkedin_msg','linkedin_connect','linkedin_visita','llamada','respuesta','aceptacion','reunion')
                OR (a.tipo='email' AND a.nota NOT LIKE '[Inbox] Respuesta%' AND a.nota NOT LIKE 'Solicitud de admin%')
                OR (a.tipo='nota' AND a.nota ~ '^Paso [0-9]'))
         ORDER BY a.fecha DESC, a.id DESC LIMIT 40`, [req.portal.outbound_client_id]);
      const label = r => {
        const t = r.tipo, n = String(r.nota || '');
        if (t === 'respuesta') return ['reply', 'Respondió'];
        if (t === 'aceptacion') return ['linkedin', 'Aceptó la invitación de LinkedIn'];
        if (t === 'reunion') return ['meeting', 'Reunión'];
        if (t === 'linkedin_connect') return ['linkedin', 'Invitación de LinkedIn enviada'];
        if (t === 'linkedin_visita') return ['linkedin', 'Visita al perfil de LinkedIn'];
        if (t.startsWith('linkedin')) return ['linkedin', 'Mensaje de LinkedIn enviado'];
        if (t === 'llamada') return ['call', 'Llamada realizada'];
        if (t === 'email' || t === 'email_enviado') return ['email', 'Email enviado'];
        if (/whatsapp|wpp/i.test(n)) return ['whatsapp', 'Mensaje de WhatsApp'];
        if (/llamada|call/i.test(n)) return ['call', 'Llamada realizada'];
        if (/linkedin|inmail|invitaci/i.test(n)) return ['linkedin', 'Contacto por LinkedIn'];
        return ['task', 'Seguimiento realizado'];
      };
      res.json(rows.map(r => { const [canal, texto] = label(r); return { id: r.id, canal, texto, fecha: r.fecha, contact_id: r.contact_id, nombre: [r.nombre, r.apellido].filter(Boolean).join(' '), cargo: r.cargo, empresa: r.empresa }; }));
    } catch (e) { console.error('[portal] feed', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // ── Chat (cliente) ──
  app.get('/api/portal/chat', requirePortal, need('chat'), async (req, res) => {
    try {
      const after = parseInt(req.query.after) || 0, cid = req.portal.outbound_client_id;
      const { rows } = await pool.query(`SELECT id, autor, autor_nombre, texto, created_at FROM portal_messages WHERE outbound_client_id=$1 AND id>$2 ORDER BY id ASC LIMIT 200`, [cid, after]);
      if (rows.some(r => r.autor === 'equipo')) await pool.query(`UPDATE portal_messages SET leido_cliente=TRUE WHERE outbound_client_id=$1 AND autor='equipo' AND NOT leido_cliente`, [cid]);
      const unread = await pool.query(`SELECT COUNT(*)::int AS n FROM portal_messages WHERE outbound_client_id=$1 AND autor='equipo' AND NOT leido_cliente`, [cid]);
      res.json({ messages: rows, unread: unread.rows[0].n });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/portal/chat', requirePortal, need('chat'), chatLimiter, async (req, res) => {
    try {
      const texto = String((req.body && req.body.texto) || '').trim().slice(0, 2000);
      if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
      const { rows } = await pool.query(`INSERT INTO portal_messages (outbound_client_id, autor, autor_nombre, texto, leido_cliente) VALUES ($1,'cliente',$2,$3,TRUE) RETURNING id, autor, autor_nombre, texto, created_at`,
        [req.portal.outbound_client_id, req.portal.nombre || req.portal.email, texto]);
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  // ══ Lado equipo (Nova): gestionar cuentas, notas y chat ══
  const ownsClient = async (uid, cid) => { const { rows } = await pool.query(`SELECT 1 FROM outbound_clients WHERE id=$1 AND user_id=$2`, [cid, uid]); return !!rows[0]; };

  app.get('/api/lm/portal/accounts', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.query.client);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const { rows } = await pool.query(`SELECT id, email, nombre, activo, must_change, sections, last_login, created_at, locked_until FROM client_accounts WHERE outbound_client_id=$1 ORDER BY id`, [cid]);
      res.json({ accounts: rows.map(r => ({ ...r, sections: { ...defaultSections(), ...(r.sections || {}) } })), sections: SECTIONS });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/lm/portal/accounts', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, cid = parseInt(b.outbound_client_id), email = cleanEmail(b.email);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (!okEmail(email)) return res.status(400).json({ error: 'Correo no válido' });
      const given = String(b.password || '');
      if (given && given.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      const pw = given || genPw();
      const { rows } = await pool.query(
        `INSERT INTO client_accounts (user_id, outbound_client_id, email, nombre, password_hash, sections) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, nombre`,
        [req.workspaceOwnerId, cid, email, String(b.nombre || '').slice(0, 120), hashPw(pw), JSON.stringify(defaultSections())]);
      let invite = null;
      if (b.send_invite) { const { rows: cl } = await pool.query(`SELECT nombre FROM outbound_clients WHERE id=$1`, [cid]); invite = await sendInvite(email, rows[0].nombre, (cl[0] || {}).nombre || 'tu empresa', pw, 'new'); }
      res.json({ ...rows[0], password: pw, invite });         // la contraseña solo se muestra ahora
    } catch (e) {
      if (String(e.message).includes('client_accounts_email_uq')) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
      console.error('[portal] create', e.message); res.status(500).json({ error: 'Error al crear la cuenta' });
    }
  });
  app.patch('/api/lm/portal/accounts/:id', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id), b = req.body || {};
      const { rows: cur } = await pool.query(`SELECT a.* FROM client_accounts a JOIN outbound_clients c ON c.id=a.outbound_client_id WHERE a.id=$1 AND c.user_id=$2`, [id, req.workspaceOwnerId]);
      if (!cur[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
      const sections = b.sections ? Object.fromEntries(SECTIONS.map(k => [k, !!b.sections[k]])) : cur[0].sections;
      let email = cur[0].email;
      if (b.email != null) { email = cleanEmail(b.email); if (!okEmail(email)) return res.status(400).json({ error: 'Correo no válido' }); }
      try {
        await pool.query(`UPDATE client_accounts SET activo=$2, nombre=$3, sections=$4, email=$5 WHERE id=$1`,
          [id, b.activo == null ? cur[0].activo : !!b.activo, b.nombre == null ? cur[0].nombre : String(b.nombre).slice(0, 120), JSON.stringify(sections), email]);
      } catch (e) { if (String(e.message).includes('client_accounts_email_uq')) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' }); throw e; }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/lm/portal/accounts/:id/reset', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id), pw = genPw();
      const { rows } = await pool.query(`UPDATE client_accounts a SET password_hash=$3, must_change=TRUE, failed_attempts=0, locked_until=NULL FROM outbound_clients c WHERE a.id=$1 AND c.id=a.outbound_client_id AND c.user_id=$2 RETURNING a.email, a.nombre, c.nombre AS cliente`, [id, req.workspaceOwnerId, hashPw(pw)]);
      if (!rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
      const invite = req.body && req.body.send ? await sendInvite(rows[0].email, rows[0].nombre, rows[0].cliente, pw, 'reset') : null;
      res.json({ password: pw, invite });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.delete('/api/lm/portal/accounts/:id', requireAuth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM client_accounts a USING outbound_clients c WHERE a.id=$1 AND c.id=a.outbound_client_id AND c.user_id=$2`, [parseInt(req.params.id), req.workspaceOwnerId]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  // Destacados + notas para el cliente (lo que tú decides mostrar)
  app.get('/api/lm/portal/highlights', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.query.client);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      res.json(await highlights(pool, cid));
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.patch('/api/lm/portal/nota', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.body && req.body.contact_id), nota = String((req.body && req.body.nota) || '').slice(0, 600);
      const { rowCount } = await pool.query(`UPDATE lm_contacts SET portal_nota=$3 WHERE id=$1 AND user_id=$2`, [id, req.workspaceOwnerId, nota]);
      if (!rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  // Chat (equipo)
  app.get('/api/lm/portal/chat/:client', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.client), after = parseInt(req.query.after) || 0;
      if (!(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const { rows } = await pool.query(`SELECT id, autor, autor_nombre, texto, created_at FROM portal_messages WHERE outbound_client_id=$1 AND id>$2 ORDER BY id ASC LIMIT 300`, [cid, after]);
      await pool.query(`UPDATE portal_messages SET leido_equipo=TRUE WHERE outbound_client_id=$1 AND autor='cliente' AND NOT leido_equipo`, [cid]);
      res.json({ messages: rows });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/lm/portal/chat/:client', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.client), texto = String((req.body && req.body.texto) || '').trim().slice(0, 2000);
      if (!texto || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(400).json({ error: 'Mensaje no válido' });
      const { rows } = await pool.query(`INSERT INTO portal_messages (outbound_client_id, autor, autor_nombre, texto, leido_equipo) VALUES ($1,'equipo',$2,$3,TRUE) RETURNING id, autor, autor_nombre, texto, created_at`,
        [cid, (req.user && req.user.name) || 'Equipo', texto]);
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
  app.get('/api/lm/portal/unread', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT m.outbound_client_id AS client_id, COUNT(*)::int AS n FROM portal_messages m JOIN outbound_clients c ON c.id=m.outbound_client_id
                                          WHERE c.user_id=$1 AND m.autor='cliente' AND NOT m.leido_equipo GROUP BY 1`, [req.workspaceOwnerId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
  });
}

module.exports = { mount, hashPw, checkPw };
