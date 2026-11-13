'use strict';
// «Formulario de inicio» del cliente: enlace público con token por cliente (sin cuenta), borrador en servidor, y el módulo interno
// «Inicios de cliente» (tabla tipo Excel + ficha). Las contraseñas se cifran en reposo (AES-256-GCM, clave en variables de entorno)
// y cada vez que alguien las muestra, copia o exporta queda registrado. NUNCA van a logs, correos de aviso ni URLs.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const SC = require('./inicioSchema');

const BASE = () => (process.env.PUBLIC_APP_URL || 'https://app.novacentrax.com').replace(/\/$/, '');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;                      // 32 bytes aleatorios en base64url = 43 caracteres (256 bits)
const DIAS_VALIDEZ = 15, DIAS_ACCESOS = 45;
const ESTADOS = ['sin_enviar', 'enviado', 'en_curso', 'recibido', 'revisado', 'portal'];
const ESTADO_L = { sin_enviar: 'Sin enviar', enviado: 'Enviado', en_curso: 'En curso', recibido: 'Recibido', revisado: 'Revisado', portal: 'Portal activo' };
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
const mkSlug = base => {   // «empresa-» + 14 caracteres al azar (~69 bits): legible y no adivinable
  const b = String(base || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'cliente';
  const al = 'abcdefghjkmnpqrstuvwxyz23456789'; let r = '';
  for (const x of crypto.randomBytes(14)) r += al[x % al.length];
  return b + '-' + r;
};
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{14}$/;
const huella = t => crypto.createHash('sha256').update(String(t)).digest('hex');   // en la base de datos NO queda el token en claro
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── cifrado a nivel de campo ──
// La clave sale SOLO del entorno (INICIO_SECRET, o en su defecto MAILBOX_SECRET / SESSION_SECRET). Sin clave no se guarda ningún secreto.
let _key = null;
function key() {
  if (_key) return _key;
  const s = process.env.INICIO_SECRET || process.env.MAILBOX_SECRET || process.env.SESSION_SECRET;
  if (!s) throw new Error('Falta INICIO_SECRET en el entorno: no se pueden guardar contraseñas');
  _key = crypto.scryptSync(s, 'nova-inicio-v1', 32); return _key;
}
function cifrar(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const d = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['i1', iv.toString('base64'), c.getAuthTag().toString('base64'), d.toString('base64')].join(':');
}
function descifrar(enc) {
  const [v, iv, tag, d] = String(enc || '').split(':');
  if (v !== 'i1') throw new Error('Formato de secreto inválido');
  const x = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  x.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([x.update(Buffer.from(d, 'base64')), x.final()]).toString('utf8');
}

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS inicio_cliente (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, cliente_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    token TEXT UNIQUE NOT NULL, estado TEXT NOT NULL DEFAULT 'sin_enviar', idioma TEXT NOT NULL DEFAULT 'es',
    prefill JSONB NOT NULL DEFAULT '{}'::jsonb, respuestas JSONB NOT NULL DEFAULT '{}'::jsonb, acuerdos JSONB NOT NULL DEFAULT '{}'::jsonb,
    nota_interna TEXT NOT NULL DEFAULT '', revocado BOOLEAN NOT NULL DEFAULT FALSE, expira_en TIMESTAMPTZ NOT NULL,
    enlace_enviado_en TIMESTAMPTZ, creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(), actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enviado_en TIMESTAMPTZ, revisado_por INTEGER, revisado_en TIMESTAMPTZ, accesos_borrados_en TIMESTAMPTZ,
    outbound_client_id INTEGER, portal_account_id INTEGER, portal_activado_en TIMESTAMPTZ, ultimo_recordatorio TIMESTAMPTZ)`);
  await pool.query('ALTER TABLE inicio_cliente ADD COLUMN IF NOT EXISTS token_enc TEXT');
  // enlace legible: /formulario/<empresa>-<código largo al azar> (el enlace largo antiguo /inicio/<token> sigue funcionando)
  // envío principal del espacio de trabajo: buzón y línea de WhatsApp desde los que salen los formularios y recordatorios
  await pool.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS envio_buzon_id INTEGER');
  await pool.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS envio_wa_id INTEGER');
  await pool.query('ALTER TABLE inicio_cliente ADD COLUMN IF NOT EXISTS slug TEXT');
  // el correo con que se creó al cliente ya no se rellena en el formulario: pasa a una clave interna
  await pool.query("UPDATE inicio_cliente SET prefill = (prefill - 'mailInf') || jsonb_build_object('mailContacto', prefill->>'mailInf') WHERE prefill ? 'mailInf'");
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS inicio_cliente_slug ON inicio_cliente (slug)');
  try {
    const { rows: sin } = await pool.query('SELECT id, prefill, respuestas FROM inicio_cliente WHERE slug IS NULL');
    for (const r of sin) await pool.query('UPDATE inicio_cliente SET slug=$1 WHERE id=$2', [mkSlug(((r.respuestas || {}).razon) || ((r.prefill || {}).empresa)), r.id]);
  } catch (e) { console.error('[inicio] slugs:', e.message); }
  await pool.query('CREATE INDEX IF NOT EXISTS inicio_cliente_user ON inicio_cliente (user_id, creado_en DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS inicio_cliente_cliente ON inicio_cliente (cliente_id)');
  await pool.query(`CREATE TABLE IF NOT EXISTS inicio_auditoria (
    id SERIAL PRIMARY KEY, inicio_id INTEGER NOT NULL REFERENCES inicio_cliente(id) ON DELETE CASCADE, user_id INTEGER, quien TEXT NOT NULL DEFAULT '',
    accion TEXT NOT NULL, campo TEXT NOT NULL DEFAULT '', ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS inicio_aud_idx ON inicio_auditoria (inicio_id, ts DESC)');
  // Datos de facturación y comunicación que pasan a la ficha del cliente al marcar «Revisado»
  for (const c of ['razon_social', 'nif', 'direccion_fiscal', 'email_informes', 'canal_preferido', 'whatsapp', 'idioma_preferido', 'logo_url', 'sales_navigator'])
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ${c} TEXT NOT NULL DEFAULT ''`);
}

// Valores en claro de las respuestas, con los secretos como marca de «guardado» (sirve para validar y calcular el progreso sin descifrar)
function plano(r) {
  const o = { ...(r || {}) };
  for (const id of SC.SENSIBLES) if (o[id]) o[id] = '•';
  return o;
}
const acuerdosBool = a => Object.fromEntries(Object.keys(a || {}).map(k => [k, !!a[k]]));

// ── correo del sistema (Amazon SES, igual que el resto de avisos) ──
async function correoSistema(to, subject, html, text, cc) {
  const from = process.env.SES_FROM_EMAIL;
  if (!from || !process.env.AWS_ACCESS_KEY_ID) return { sent: false, error: 'El correo del sistema no está configurado' };
  try {
    const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
    const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '' } });
    await ses.send(new SendEmailCommand({ Source: from, Destination: { ToAddresses: [to], ...(cc && cc.length ? { CcAddresses: cc } : {}) }, Message: { Subject: { Data: subject }, Body: { Html: { Data: html }, Text: { Data: text } } } }));
    return { sent: true };
  } catch (e) { console.warn('[inicio] correo no enviado:', e.message); return { sent: false, error: 'No se pudo enviar el correo' }; }
}
const marco = (titulo, cuerpo, btn) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2937"><div style="background:#0b2a5b;color:#fff;border-radius:12px 12px 0 0;padding:16px 22px;font-weight:700;letter-spacing:.02em">NovaCentrax</div>
<div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px;padding:22px"><h2 style="margin:0 0 12px;font-size:18px;color:#0b2a5b">${esc(titulo)}</h2>${cuerpo}${btn ? `<p style="margin:22px 0 4px"><a href="${esc(btn.url)}" style="background:#00b8ab;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(btn.txt)}</a></p>` : ''}</div></div>`;

function mount(app, { pool, requireAuth, permsSvc, puedeVerWa }) {
  init(pool).then(() => { setTimeout(borrarVencidos, 60000); setInterval(borrarVencidos, 3600000); }).catch(e => console.error('[inicio] init:', e.message));

  const uidOf = req => req.workspaceOwnerId;
  const quienDe = req => String((req.user && (req.user.name || req.user.email)) || 'usuario').slice(0, 120);
  const audit = (inicioId, req, accion, campo) => { const u = req && req.user; return pool.query('INSERT INTO inicio_auditoria (inicio_id,user_id,quien,accion,campo) VALUES ($1,$2,$3,$4,$5)', [inicioId, u ? u.id : null, u ? quienDe(req) : 'sistema', accion, campo || '']).catch(() => {}); };
  const urlDe = r => { if (r.slug) return `${BASE()}/formulario/${r.slug}`; try { return `${BASE()}/inicio/${descifrar(r.token_enc)}`; } catch (_) { return ''; } };
  // Datos sensibles (ver/copiar/exportar/borrar accesos, activar portal): solo administración (nivel 3), no managers
  async function soloAdmin(req, res) {
    try { const c = await permsSvc.ctx(req); if (c.perms.inicios && c.perms.inicios.n >= 3) return true; } catch (_) {}
    res.status(403).json({ error: 'Solo administración puede ver o gestionar accesos' }); return false;
  }
  const vigente = r => !r.revocado && new Date(r.expira_en) > new Date();

  // ══════════════ PÚBLICO (sin sesión): el cliente completa su formulario ══════════════
  const nada = (req, res) => { res.set('Cache-Control', 'no-store'); res.status(404).json({ error: 'no_disponible' }); };   // misma respuesta para inválido, caducado o revocado
  // Tras Cloudflare, req.ip sería la IP del borde (compartida por miles de personas): se usa la IP real que Cloudflare entrega
  const ipReal = req => String(req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 64);
  const limFallos = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skipSuccessfulRequests: true, keyGenerator: ipReal, standardHeaders: true, legacyHeaders: false, message: { error: 'no_disponible' } });
  const limGeneral = rateLimit({ windowMs: 10 * 60 * 1000, max: 240, keyGenerator: ipReal, standardHeaders: true, legacyHeaders: false, message: { error: 'demasiadas_peticiones' } });
  const tamano = (req, res, next) => (parseInt(req.headers['content-length'], 10) > 65536 ? res.status(413).json({ error: 'demasiado_grande' }) : next());
  const pub = [tamano, limGeneral, limFallos, (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }); next(); }];
  async function porToken(req) {
    const tk = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    let r;
    if (TOKEN_RE.test(tk)) ({ rows: [r] } = await pool.query('SELECT * FROM inicio_cliente WHERE token=$1', [huella(tk)]));
    else if (SLUG_RE.test(tk)) ({ rows: [r] } = await pool.query('SELECT * FROM inicio_cliente WHERE slug=$1', [tk]));
    else return null;
    return r && vigente(r) ? r : null;
  }
  const marca = r => ({ idioma: r.idioma });
  function respuestasParaCliente(r) {
    const o = { ...(r.prefill || {}), ...(r.respuestas || {}) };
    for (const id of SC.SENSIBLES) delete o[id];   // nunca se devuelven al navegador, ni siquiera al dueño del enlace
    delete o.mailContacto;   // el correo con que creamos al cliente es interno: no se rellena en el formulario
    return o;
  }
  const yaEnviado = r => ['recibido', 'revisado', 'portal'].includes(r.estado);

  app.post('/api/inicio/public/abrir', pub, async (req, res) => {
    try {
      const r = await porToken(req); if (!r) return nada(req, res);
      // logo y nombre de la empresa del espacio de trabajo (los de «Plantillas → Empresas»), para que el formulario no muestre un logo desactualizado
      let empresa = null;
      try { const { rows: [b] } = await pool.query('SELECT nombre, logo_white, logo_color FROM tpl_brands WHERE user_id=$1 ORDER BY id LIMIT 1', [r.user_id]); if (b) empresa = { nombre: b.nombre, logo: b.logo_white || b.logo_color || null }; } catch (_) {}
      if (yaEnviado(r)) return res.json({ enviado: true, ...marca(r), empresa });
      res.json({ enviado: false, ...marca(r), empresa, secciones: SC.publico(), respuestas: respuestasParaCliente(r), secretos: Object.fromEntries(SC.SENSIBLES.map(id => [id, !!(r.respuestas || {})[id]])),
        acuerdos: Object.fromEntries(Object.keys(r.acuerdos || {}).map(k => [k, true])), expira_en: r.expira_en });
    } catch (e) { console.error('[inicio] get público:', e.message); res.status(500).json({ error: 'error' }); }
  });

  // Aplica lo que manda el cliente a un registro: solo campos conocidos, limpios; los secretos se cifran
  function aplicar(r, body) {
    const resp = { ...(r.respuestas || {}) }, ac = { ...(r.acuerdos || {}) }, b = body || {};
    const given = b.respuestas && typeof b.respuestas === 'object' ? b.respuestas : {};
    for (const c of SC.CAMPOS) {
      if (c.tipo === 'check') continue;
      if (!(c.id in given)) continue;
      const v = SC.limpiar(c, given[c.id]);
      if (c.sensible) { if (v) resp[c.id] = cifrar(v); else delete resp[c.id]; }
      else if (v) resp[c.id] = v; else delete resp[c.id];
    }
    const ga = b.acuerdos && typeof b.acuerdos === 'object' ? b.acuerdos : {};
    for (const id of SC.ACUERDOS) if (id in ga) { if (ga[id] === true || ga[id] === 'true') ac[id] = ac[id] || new Date().toISOString(); else delete ac[id]; }
    return { resp, ac, idioma: b.idioma === 'en' ? 'en' : (b.idioma === 'es' ? 'es' : r.idioma) };
  }
  app.put('/api/inicio/public/guardar', pub, async (req, res) => {
    try {
      const r = await porToken(req); if (!r) return nada(req, res);
      if (yaEnviado(r)) return res.status(409).json({ error: 'enviado' });
      const { resp, ac, idioma } = aplicar(r, req.body);
      await pool.query(`UPDATE inicio_cliente SET respuestas=$2, acuerdos=$3, idioma=$4, actualizado_en=NOW(), estado=CASE WHEN estado IN ('sin_enviar','enviado') THEN 'en_curso' ELSE estado END WHERE id=$1`, [r.id, JSON.stringify(resp), JSON.stringify(ac), idioma]);
      res.json({ ok: true, guardado: new Date().toISOString() });
    } catch (e) { console.error('[inicio] guardar borrador:', e.message); res.status(500).json({ error: 'error' }); }
  });
  app.post('/api/inicio/public/enviar', pub, async (req, res) => {
    try {
      const r = await porToken(req); if (!r) return nada(req, res);
      if (yaEnviado(r)) return res.json({ ok: true, enviado: true });
      const { resp, ac, idioma } = aplicar(r, req.body);
      const v = SC.validar(plano(resp), acuerdosBool(ac));
      if (!v.ok) { await pool.query('UPDATE inicio_cliente SET respuestas=$2, acuerdos=$3, idioma=$4, actualizado_en=NOW() WHERE id=$1', [r.id, JSON.stringify(resp), JSON.stringify(ac), idioma]); return res.status(400).json({ error: 'incompleto', faltan: v.faltan, formato: v.formato }); }
      await pool.query(`UPDATE inicio_cliente SET respuestas=$2, acuerdos=$3, idioma=$4, estado='recibido', enviado_en=NOW(), actualizado_en=NOW() WHERE id=$1`, [r.id, JSON.stringify(resp), JSON.stringify(ac), idioma]);
      avisarRecibido(r, resp).catch(e => console.warn('[inicio] aviso:', e.message));
      res.json({ ok: true, enviado: true });
    } catch (e) { console.error('[inicio] enviar:', e.message); res.status(500).json({ error: 'error' }); }
  });

  // Aviso a la dueña: quién lo completó. Sin contraseñas.
  async function avisarRecibido(r, resp) {
    const quien = resp.razon || (r.prefill || {}).empresa || 'Un cliente', persona = resp.contacto || '', correo = resp.mailInf || '';
    try { require('./notify').push(r.user_id, { kind: 'inicio', para: r.user_id, titulo: 'Formulario de inicio recibido', texto: [quien, persona].filter(Boolean).join(' · '), inicio_id: r.id }); } catch (_) {}
    const { rows: [u] } = await pool.query('SELECT email FROM users WHERE id=$1', [r.user_id]);
    if (!u || !u.email) return;
    const cuerpo = `<p style="margin:0 0 12px;color:#374151"><b>${esc(quien)}</b> completó su formulario de inicio.</p><table style="font-size:14px;color:#374151"><tr><td style="padding:2px 14px 2px 0;color:#6b7280">Contacto</td><td>${esc(persona) || '—'}</td></tr><tr><td style="padding:2px 14px 2px 0;color:#6b7280">Correo</td><td>${esc(correo) || '—'}</td></tr><tr><td style="padding:2px 14px 2px 0;color:#6b7280">Recibido</td><td>${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</td></tr></table><p style="margin:14px 0 0;color:#6b7280;font-size:13px">Los accesos no se incluyen en este correo: ábrelos desde «Inicios de cliente».</p>`;
    await correoSistema(u.email, `Formulario de inicio recibido — ${quien}`, marco('Formulario de inicio recibido', cuerpo, { url: BASE() + '/', txt: 'Abrir Inicios de cliente' }), `${quien} completó su formulario de inicio. Ábrelo en ${BASE()}/ (Inicios de cliente). Los accesos no van en este correo.`);
  }

  // ══════════════ INTERNO ══════════════
  const own = async (req, id) => { const { rows: [r] } = await pool.query('SELECT * FROM inicio_cliente WHERE id=$1 AND user_id=$2', [id, uidOf(req)]); return r; };
  const sinCache = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  app.use('/api/inicios', sinCache);

  function fila(r, extra) {
    const p = plano(r.respuestas), ac = acuerdosBool(r.acuerdos);
    return { id: r.id, cliente_id: r.cliente_id, estado: r.estado, estado_l: ESTADO_L[r.estado] || r.estado, idioma: r.idioma,
      empresa: p.razon || (r.prefill || {}).empresa || '', contacto: p.contacto || (r.prefill || {}).contacto || '',
      enviado_en: r.enviado_en, canal: p.canal || '', mailInf: p.mailInf || '', salesnav: p.salesnav || '', mailEstado: p.mailEstado || '',
      atiende: p.atiende || '', progreso: SC.progreso(p, ac), revisado: !!r.revisado_en, revisado_en: r.revisado_en,
      vigente: vigente(r), revocado: r.revocado, expira_en: r.expira_en, accesos_borrados: !!r.accesos_borrados_en, actualizado_en: r.actualizado_en, ...(extra || {}) };
  }
  app.get('/api/inicios/schema', requireAuth, (req, res) => res.json({ secciones: SC.publico(), estados: ESTADOS.map(k => ({ k, l: ESTADO_L[k] })), sensibles: SC.SENSIBLES, acuerdos: SC.ACUERDOS }));
  app.get('/api/inicios', requireAuth, async (req, res) => {
    try { const { rows } = await pool.query('SELECT * FROM inicio_cliente WHERE user_id=$1 ORDER BY actualizado_en DESC LIMIT 1000', [uidOf(req)]); res.json(rows.map(r => { const P = plano({ ...(r.prefill || {}), ...(r.respuestas || {}) }); for (const k of SC.SENSIBLES) delete P[k]; return fila(r, { v: P }); })); }
    catch (e) { console.error('[inicios] lista:', e.message); res.status(500).json({ error: 'Error al cargar' }); }
  });
  // Cliente (si existe) por inicio, para el botón «Crear enlace de inicio» en su ficha
  app.get('/api/inicios/por-cliente/:cid', requireAuth, async (req, res) => {
    try { const { rows: [r] } = await pool.query('SELECT * FROM inicio_cliente WHERE cliente_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [parseInt(req.params.cid, 10) || 0, uidOf(req)]); res.json(r ? { ...fila(r), url: urlDe(r) } : null); }
    catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  // Crear enlace: un enlace por cliente. Si ya hay uno vigente se devuelve; si caducó o se revocó, se emite uno nuevo.
  app.post('/api/inicios', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, uid = uidOf(req); let cid = parseInt(b.cliente_id, 10) || null;
      let cli = null;
      // «Crear cliente nuevo»: se crea (o se reutiliza si ya existe) en Operaciones → Clientes, con el permiso de Inicios (no exige el de Clientes)
      if (!cid && b.crear_cliente) {
        const emp = String(b.empresa || '').trim().slice(0, 200), con = String(b.contacto || '').trim().slice(0, 200), mail = String(b.correo || '').trim().toLowerCase().slice(0, 200);
        if (!emp && !con) return res.status(400).json({ error: 'Escribe la empresa o el nombre del contacto' });
        const nombre = con || emp;
        const { rows: [dup] } = mail
          ? await pool.query("SELECT * FROM clients WHERE user_id=$1 AND LOWER(TRIM(email))=$2 LIMIT 1", [uid, mail])
          : await pool.query("SELECT * FROM clients WHERE user_id=$1 AND LOWER(TRIM(nombre))=LOWER($2) AND LOWER(TRIM(COALESCE(empresa,'')))=LOWER($3) LIMIT 1", [uid, nombre, emp]);
        if (dup) cid = dup.id;
        else { const { rows: [nc] } = await pool.query("INSERT INTO clients (user_id, nombre, empresa, email, estado, tipo) VALUES ($1,$2,$3,$4,'activo','cliente') RETURNING id", [uid, nombre, emp, mail]); cid = nc.id; }
      }
      if (cid) { const { rows: [c] } = await pool.query('SELECT * FROM clients WHERE id=$1 AND user_id=$2', [cid, uid]); if (!c) return res.status(404).json({ error: 'Cliente no encontrado' }); cli = c; }
      else if (!String(b.empresa || '').trim()) return res.status(400).json({ error: 'Elige un cliente o escribe el nombre de la empresa' });
      if (cid) {
        const { rows: [ex] } = await pool.query('SELECT * FROM inicio_cliente WHERE cliente_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1', [cid, uid]);
        if (ex && vigente(ex)) return res.json({ ...fila(ex), url: urlDe(ex), existente: true });
        if (ex) { // caducado o revocado: se renueva con un token nuevo
          const t = nuevoToken();
          await pool.query(`UPDATE inicio_cliente SET token=$2, token_enc=$3, slug=$4, revocado=FALSE, expira_en=NOW()+interval '${DIAS_VALIDEZ} days' WHERE id=$1`, [ex.id, huella(t), cifrar(t), mkSlug((ex.prefill || {}).empresa)]);
          await audit(ex.id, req, 'enlace_renovado', ''); const r2 = await own(req, ex.id); return res.json({ ...fila(r2), url: urlDe(r2), renovado: true });
        }
      }
      const prefill = cli
        ? { empresa: cli.empresa || cli.nombre || '', contacto: cli.nombre || '', mailContacto: cli.email || '', web: cli.sitio_web || '', pais: cli.pais_empresa || cli.pais || '', razon: cli.razon_social || cli.empresa || '' }
        : { empresa: String(b.empresa).trim().slice(0, 200), contacto: String(b.contacto || '').trim().slice(0, 200), mailContacto: String(b.correo || '').trim().slice(0, 200) };
      const pre = { ...prefill }; if (!pre.razon) pre.razon = pre.empresa;
      for (const k of Object.keys(pre)) if (!pre[k]) delete pre[k];
      const idioma = b.idioma === 'en' ? 'en' : 'es'; if (idioma === 'en') pre.idioma = 'en'; else pre.idioma = 'es';
      const t0 = nuevoToken();
      const { rows: [r] } = await pool.query(`INSERT INTO inicio_cliente (user_id, cliente_id, token, token_enc, idioma, prefill, expira_en, slug) VALUES ($1,$2,$3,$4,$5,$6, NOW()+interval '${DIAS_VALIDEZ} days', $7) RETURNING *`, [uid, cid, huella(t0), cifrar(t0), idioma, JSON.stringify(pre), mkSlug(pre.empresa)]);
      await audit(r.id, req, 'enlace_creado', '');
      res.json({ ...fila(r), url: urlDe(r) });
    } catch (e) { console.error('[inicios] crear:', e.message); res.status(500).json({ error: 'No se pudo crear el enlace' }); }
  });

  app.get('/api/inicios/export.csv', requireAuth, async (req, res) => {
    try {
      const accesos = req.query.accesos === '1';
      if (accesos && !(await soloAdmin(req, res))) return;
      if (accesos && req.query.confirmar !== '1') return res.status(400).json({ error: 'Confirma que quieres incluir los accesos' });
      const { rows } = await pool.query('SELECT * FROM inicio_cliente WHERE user_id=$1 ORDER BY actualizado_en DESC', [uidOf(req)]);
      const cols = SC.CAMPOS.filter(c => c.tipo !== 'check' && (accesos || !c.sensible));
      const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const head = ['Estado', 'Enviado', 'Revisado', 'Progreso %', ...cols.map(c => c.es), ...SC.ACUERDOS.map(id => id + ' (fecha)')];
      const out = [head.map(cell).join(',')];
      for (const r of rows) {
        const resp = { ...(r.prefill || {}), ...(r.respuestas || {}) };
        const val = c => { if (!resp[c.id]) return ''; if (!c.sensible) return c.tipo === 'select' ? ((c.opts.find(o => o.v === resp[c.id]) || {}).es || resp[c.id]) : resp[c.id]; try { return descifrar(resp[c.id]); } catch (_) { return ''; } };
        out.push([ESTADO_L[r.estado], r.enviado_en ? new Date(r.enviado_en).toISOString().slice(0, 16).replace('T', ' ') : '', r.revisado_en ? new Date(r.revisado_en).toISOString().slice(0, 10) : '', SC.progreso(plano(r.respuestas), acuerdosBool(r.acuerdos)), ...cols.map(val), ...SC.ACUERDOS.map(id => (r.acuerdos || {})[id] || '')].map(cell).join(','));
        if (accesos) await audit(r.id, req, 'exportar_accesos', SC.SENSIBLES.join(','));
      }
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inicios-de-cliente${accesos ? '-con-accesos' : ''}.csv"` });
      res.send('﻿' + out.join('\r\n'));
    } catch (e) { console.error('[inicios] csv:', e.message); res.status(500).json({ error: 'No se pudo exportar' }); }
  });

  app.get('/api/inicios/:id', requireAuth, async (req, res) => {
    try {
      const r = await own(req, parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: 'No encontrado' });
      const resp = { ...(r.prefill || {}), ...(r.respuestas || {}) }, set = {};
      for (const id of SC.SENSIBLES) { set[id] = !!(r.respuestas || {})[id]; delete resp[id]; }
      const p = plano(r.respuestas), v = SC.validar({ ...(r.prefill || {}), ...p }, acuerdosBool(r.acuerdos));
      let cliente = null; if (r.cliente_id) { const { rows: [c] } = await pool.query('SELECT id, nombre, empresa FROM clients WHERE id=$1', [r.cliente_id]); cliente = c || null; }
      const { rows: aud } = await pool.query('SELECT quien, accion, campo, ts FROM inicio_auditoria WHERE inicio_id=$1 ORDER BY ts DESC LIMIT 40', [r.id]);
      res.json({ ...fila(r), url: urlDe(r), respuestas: resp, secretos: set, acuerdos: r.acuerdos || {}, nota_interna: r.nota_interna, faltan: v.faltan, formato: v.formato,
        completo: v.ok, cliente, auditoria: aud, enlace_enviado_en: r.enlace_enviado_en, portal_activado_en: r.portal_activado_en, ultimo_recordatorio: r.ultimo_recordatorio });
    } catch (e) { console.error('[inicios] ficha:', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // Editar cualquier campo desde la ficha (solo los que vienen); los secretos se cifran y se anota la edición
  app.put('/api/inicios/:id', requireAuth, async (req, res) => {
    try {
      const r = await own(req, parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: 'No encontrado' });
      const b = req.body || {};
      if (Object.keys(b.respuestas || {}).some(id => SC.SENSIBLES.includes(id)) && !(await soloAdmin(req, res))) return;
      const { resp, ac } = aplicar(r, { respuestas: b.respuestas, acuerdos: b.acuerdos });
      const tocados = Object.keys(b.respuestas || {}).filter(id => SC.SENSIBLES.includes(id));
      await pool.query('UPDATE inicio_cliente SET respuestas=$2, acuerdos=$3, nota_interna=COALESCE($4,nota_interna), actualizado_en=NOW() WHERE id=$1', [r.id, JSON.stringify(resp), JSON.stringify(ac), b.nota_interna == null ? null : String(b.nota_interna).slice(0, 4000)]);
      for (const id of tocados) await audit(r.id, req, 'editar_secreto', id);
      res.json({ ok: true });
    } catch (e) { console.error('[inicios] editar:', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  // Mostrar / copiar una contraseña: siempre queda anotado quién y cuándo
  app.post('/api/inicios/:id/secreto', requireAuth, async (req, res) => {
    try {
      const r = await own(req, parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: 'No encontrado' });
      if (!(await soloAdmin(req, res))) return;
      const campo = String((req.body || {}).campo || ''), accion = (req.body || {}).accion === 'copiar' ? 'copiar' : 'mostrar';
      if (!SC.SENSIBLES.includes(campo)) return res.status(400).json({ error: 'Campo no válido' });
      const enc = (r.respuestas || {})[campo]; if (!enc) return res.status(404).json({ error: 'Sin valor guardado' });
      const valor = descifrar(enc); await audit(r.id, req, accion + '_secreto', campo);
      res.json({ valor });
    } catch (e) { console.error('[inicios] secreto:', e.message); res.status(500).json({ error: 'No se pudo leer' }); }
  });

  const simple = (ruta, fn) => app.post('/api/inicios/:id/' + ruta, requireAuth, async (req, res) => {
    try { const r = await own(req, parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: 'No encontrado' }); await fn(req, res, r); }
    catch (e) { console.error('[inicios] ' + ruta + ':', e.message); if (!res.headersSent) res.status(500).json({ error: 'No se pudo completar la acción' }); }
  });
  simple('renovar', async (req, res, r) => {   // amplía 15 días; si estaba revocado se emite un token nuevo
    if (r.revocado || !r.token_enc) { const t = nuevoToken(); await pool.query('UPDATE inicio_cliente SET token=$2, token_enc=$3, slug=$4 WHERE id=$1', [r.id, huella(t), cifrar(t), mkSlug(((r.respuestas || {}).razon) || (r.prefill || {}).empresa)]); }
    await pool.query(`UPDATE inicio_cliente SET revocado=FALSE, expira_en=NOW()+interval '${DIAS_VALIDEZ} days' WHERE id=$1`, [r.id]);
    await audit(r.id, req, r.revocado ? 'enlace_renovado_nuevo' : 'enlace_renovado', ''); const n = await own(req, r.id); res.json({ ...fila(n), url: urlDe(n) });
  });
  simple('idioma', async (req, res, r) => {   // idioma del formulario que verá el cliente
    const l = (req.body || {}).idioma === 'en' ? 'en' : 'es';
    await pool.query("UPDATE inicio_cliente SET idioma=$2, prefill=COALESCE(prefill,'{}'::jsonb) || jsonb_build_object('idioma',$2::text) WHERE id=$1", [r.id, l]);
    await audit(r.id, req, 'idioma_cambiado', l); res.json({ ok: true, idioma: l });
  });
  simple('revocar', async (req, res, r) => { await pool.query('UPDATE inicio_cliente SET revocado=TRUE WHERE id=$1', [r.id]); await audit(r.id, req, 'enlace_revocado', ''); res.json({ ok: true }); });
  simple('marcar-enviado', async (req, res, r) => {
    await pool.query(`UPDATE inicio_cliente SET enlace_enviado_en=NOW(), estado=CASE WHEN estado='sin_enviar' THEN 'enviado' ELSE estado END WHERE id=$1`, [r.id]);
    await audit(r.id, req, 'enlace_enviado', ''); res.json({ ok: true });
  });
  // Recordatorio con los puntos pendientes: saluda por el nombre y lista lo que aún no está contestado (obligatorio u opcional)
  const pendientesDe = (r, en) => {
    const P = plano({ ...(r.prefill || {}), ...(r.respuestas || {}) });
    return SC.CAMPOS.filter(c => c.tipo !== 'check' && !String(P[c.id] == null ? '' : P[c.id]).trim()).map(c => (en ? c.en : c.es) + (c.req ? '' : (en ? ' (optional)' : ' (opcional)')));
  };
  // ── Enviar el formulario / recordar lo pendiente, por correo o WhatsApp: plantilla ES/EN editable, remitente y momento a la vista ──
  const plantilla = (r, en, tipo, conLista) => {
    const R = { ...(r.prefill || {}), ...(r.respuestas || {}) }, nombre = String(R.contacto || '').trim().split(/[\s,]+/)[0];
    const pend = pendientesDe(r, en), enviado = yaEnviado(r), f = new Date(r.expira_en).toISOString().slice(0, 10), hola = (en ? 'Hi' : 'Hola') + (nombre ? ' ' + nombre : '');
    const L = pend.map(x => '- ' + x).join('\n');
    if (enviado && !pend.length) return { asunto: en ? 'Thank you for completing your form' : 'Gracias por completar tu formulario', gracias: true, pend, enviado,
      cuerpo: en ? `${hola},\n\nThank you for completing your form: we now have everything we need to get started. Within 48 hours we will write to you through the channel you chose to confirm the next steps.`
        : `${hola},\n\nGracias por completar tu formulario: ya tenemos todo lo que necesitamos para comenzar. En las próximas 48 horas te escribimos por el canal que elegiste para confirmar los siguientes pasos.` };
    if (tipo === 'recordatorio') return { asunto: en ? 'Pending points for your NovaCentrax start' : 'Puntos pendientes para tu inicio con NovaCentrax', pend, enviado,
      cuerpo: en ? `${hola},\n\nWe are happy to get started. A quick reminder: we still have the following points pending:\n${L}\n\n${enviado ? 'Please send them soon through the communication channel you chose.' : `Please send them soon; the form saves itself and you can come back to the same link anytime. The link is personal and works until ${f}.`}`
        : `${hola},\n\nEstamos felices de comenzar. Un recordatorio rápido: tenemos pendientes los siguientes puntos:\n${L}\n\n${enviado ? 'Envíanoslos pronto por el canal de comunicación que elegiste.' : `Recuerda enviarlo pronto; el formulario se guarda solo y puedes volver al mismo enlace cuando quieras. El enlace es personal y funciona hasta el ${f}.`}` };
    const lista = conLista && pend.length && pend.length < SC.CAMPOS.filter(c => c.tipo !== 'check').length ? L : '';
    return { asunto: en ? 'Your start form with NovaCentrax' : 'Tu formulario de inicio con NovaCentrax', pend, enviado,
      cuerpo: en ? `${hola},\n\nWe are happy to get started. To start your pilot we need a few details: it takes about 10 minutes, it saves itself and you can come back to the same link anytime.${lista ? '\n\nWe still have the following points pending:\n' + lista : ''}\n\nPlease send it soon. The link is personal and works until ${f}.`
        : `${hola},\n\nEstamos felices de comenzar. Para arrancar tu piloto necesitamos unos datos del formulario: son unos 10 minutos, se guarda solo y puedes volver al mismo enlace cuando quieras.${lista ? '\n\nTenemos pendientes los siguientes puntos:\n' + lista : ''}\n\nRecuerda enviarlo pronto. El enlace es personal y funciona hasta el ${f}.` };
  };
  const soloDigitos = t => String(t || '').replace(/[^\d]/g, '');
  // Quién puede usar qué remitente depende de su nivel: buzones = nivel de Outreach ≥ 2; WhatsApp = nivel de WhatsApp ≥ 2 y que la línea sea visible para esa persona
  async function nivelDe(req, mod) { try { const c = await permsSvc.ctx(req); return (c.perms[mod] && c.perms[mod].n) || 0; } catch (_) { return 0; } }
  async function remitentesDe(req, canal) {
    let pr = {}; try { const { rows: [w] } = await pool.query('SELECT envio_buzon_id, envio_wa_id FROM workspaces WHERE owner_id=$1', [uidOf(req)]); pr = w || {}; } catch (_) {}
    if (canal === 'wa') {
      if ((await nivelDe(req, 'whatsapp')) < 2) return [];
      const { rows: todas } = await pool.query(`SELECT id, nombre, numero, connected_by, visibilidad, visibilidad_niveles, visibilidad_miembros FROM wa_connections WHERE user_id=$1 AND estado='conectado' ORDER BY (id=$2) DESC, id`, [uidOf(req), pr.envio_wa_id || 0]);
      const rows = []; for (const c of todas) { try { if (!puedeVerWa || await puedeVerWa(req, c)) rows.push(c); } catch (_) {} }
      return rows.map(x => ({ id: x.id, label: `${x.nombre}${x.numero ? ' · +' + soloDigitos(x.numero) : ''}${x.id === pr.envio_wa_id ? ' (principal)' : ''}` }));
    }
    if ((await nivelDe(req, 'outreach')) < 2) return [];
    const { rows } = await pool.query(`SELECT m.id, m.email, c.nombre AS cliente FROM lm_mailboxes m LEFT JOIN outbound_clients c ON c.id=m.outbound_client_id WHERE m.user_id=$1 AND m.estado IN ('conectado','solo_envio') ORDER BY (m.id=$2) DESC, (m.email ILIKE '%novacentrax%') DESC, m.id`, [uidOf(req), pr.envio_buzon_id || 0]);
    return rows.map(x => ({ id: x.id, label: x.email + (x.cliente ? ' · ' + x.cliente : '') + (x.id === pr.envio_buzon_id ? ' (principal)' : '') }));
  }
  app.get('/api/inicios/:id/mensaje', requireAuth, async (req, res) => {
    try {
      const r = await own(req, parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: 'No encontrado' });
      const canal = req.query.canal === 'wa' ? 'wa' : 'correo', tipo = req.query.tipo === 'recordatorio' ? 'recordatorio' : 'formulario';
      const en = (req.query.idioma || r.idioma) === 'en', pl = plantilla(r, en, tipo, req.query.lista !== '0'), R = { ...(r.prefill || {}), ...(r.respuestas || {}) };
      let to = '';
      if (canal === 'wa') {
        to = String(R.wpp || '').trim();
        if (!to && r.cliente_id) { const { rows: [c] } = await pool.query('SELECT telefono FROM clients WHERE id=$1 AND user_id=$2', [r.cliente_id, uidOf(req)]); to = c ? String(c.telefono || '').trim() : ''; }
      } else to = String(R.mailInf || R.mailContacto || '').trim();
      res.json({ canal, tipo, to, idioma: en ? 'en' : 'es', asunto: pl.asunto, cuerpo: pl.cuerpo, pendientes: pl.pend, enviado: pl.enviado, gracias: !!pl.gracias, vigente: vigente(r),
        remitentes: await remitentesDe(req, canal), cuando: 'inmediato' });
    } catch (e) { console.error('[inicios] mensaje plantilla:', e.message); res.status(500).json({ error: 'No se pudo preparar el mensaje' }); }
  });
  // Configuración → Integraciones: elegir el buzón y la línea de WhatsApp principales del espacio
  app.get('/api/workspace/envio', requireAuth, async (req, res) => {
    try {
      const { rows: [w] } = await pool.query('SELECT envio_buzon_id, envio_wa_id FROM workspaces WHERE owner_id=$1', [uidOf(req)]);
      const bz = await remitentesDe(req, 'correo'), wa = await remitentesDe(req, 'wa');
      res.json({ buzon_id: (w || {}).envio_buzon_id || null, wa_id: (w || {}).envio_wa_id || null, buzones: bz.map(x => ({ id: x.id, label: x.label.replace(' (principal)', '') })), lineas: wa.map(x => ({ id: x.id, label: x.label.replace(' (principal)', '') })) });
    } catch (e) { console.error('[inicios] envio:', e.message); res.status(500).json({ error: 'No se pudo cargar' }); }
  });
  app.put('/api/workspace/envio', requireAuth, async (req, res) => {
    try {
      if (req.user.workspace_id) return res.status(403).json({ error: 'Solo el admin puede cambiar el envío principal' });
      const b = req.body || {}, bz = parseInt(b.buzon_id, 10) || null, wa = parseInt(b.wa_id, 10) || null;
      if (bz) { const { rows } = await pool.query('SELECT 1 FROM lm_mailboxes WHERE id=$1 AND user_id=$2', [bz, uidOf(req)]); if (!rows.length) return res.status(404).json({ error: 'Ese buzón no existe' }); }
      if (wa) { const { rows } = await pool.query('SELECT 1 FROM wa_connections WHERE id=$1 AND user_id=$2', [wa, uidOf(req)]); if (!rows.length) return res.status(404).json({ error: 'Esa línea no existe' }); }
      await pool.query('UPDATE workspaces SET envio_buzon_id=$2, envio_wa_id=$3 WHERE owner_id=$1', [uidOf(req), bz, wa]);
      res.json({ ok: true });
    } catch (e) { console.error('[inicios] envio guardar:', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });
  simple('enviar-mensaje', async (req, res, r) => {
    if (!vigente(r)) return res.status(409).json({ error: 'El enlace está caducado o revocado: renuévalo primero' });
    const b = req.body || {}, en = b.idioma === 'en', canal = b.canal === 'wa' ? 'wa' : 'correo', texto = String(b.cuerpo || '').trim().slice(0, 6000), enviado = yaEnviado(r), url = urlDe(r);
    if (!texto) return res.status(400).json({ error: 'El mensaje está vacío' });
    const remId = parseInt(b.remitente_id, 10) || null;
    let destino = '';
    if (canal === 'wa') {
      const num = soloDigitos(b.to);
      if (num.length < 8 || num.length > 15) return res.status(400).json({ error: 'Escribe el número con el prefijo del país (por ejemplo +51 987654321)' });
      if (!remId) return res.status(400).json({ error: 'Elige desde qué WhatsApp se envía' });
      const { rows: [cx] } = await pool.query(`SELECT id, estado, connected_by, visibilidad, visibilidad_niveles, visibilidad_miembros FROM wa_connections WHERE id=$1 AND user_id=$2`, [remId, uidOf(req)]);
      if (!cx) return res.status(404).json({ error: 'Esa línea de WhatsApp no existe' });
      if ((await nivelDe(req, 'whatsapp')) < 2 || (puedeVerWa && !(await puedeVerWa(req, cx)))) return res.status(403).json({ error: 'No tienes acceso a ese WhatsApp' });
      if (cx.estado !== 'conectado') return res.status(409).json({ error: 'Esa línea de WhatsApp no está conectada' });
      try { await require('./waService').enviar(pool, cx.id, num, texto + (enviado ? '' : '\n\n' + url)); }
      catch (e) { console.warn('[inicio] WhatsApp no enviado:', e.message); return res.status(502).json({ error: 'No se pudo enviar por WhatsApp: ' + String(e.message || 'error').slice(0, 140) }); }
      destino = '+' + num;
    } else {
      const to = String(b.to || '').trim(), asunto = String(b.asunto || '').trim().slice(0, 200);
      if (!SC.EMAIL_RE.test(to)) return res.status(400).json({ error: 'Escribe un correo válido para el destinatario' });
      if (!asunto) return res.status(400).json({ error: 'Falta el asunto' });
      const cc = [...new Set(String(b.cc || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
      if (cc.length > 5) return res.status(400).json({ error: 'Máximo 5 correos en copia (CC)' });
      const ccMal = cc.find(x => !SC.EMAIL_RE.test(x)); if (ccMal) return res.status(400).json({ error: `El correo en copia «${ccMal}» no es válido` });
      const html = texto.split(/\n{2,}/).map(par => {
        const ls = par.split('\n'), items = ls.filter(l => /^\s*-\s+/.test(l)), pre = ls.filter(l => !/^\s*-\s+/.test(l));
        return (pre.length ? `<p style="margin:0 0 12px;color:#374151">${esc(pre.join('\n')).replace(/\n/g, '<br>')}</p>` : '')
          + (items.length ? `<ul style="margin:0 0 12px;padding-left:20px;color:#374151">${items.map(l => `<li style="margin:3px 0">${esc(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>` : '');
      }).join('');
      const cuerpoHtml = marco(en ? 'Your start form' : 'Tu formulario de inicio', html, enviado ? null : { url, txt: en ? 'Complete the form' : 'Completar el formulario' });
      const plano_ = `${texto}${enviado ? '' : '\n\n' + url}`;
      if (remId) {   // desde un buzón conectado (SMTP): sale con la firma y queda en su carpeta Enviados
        const { rows: [mb] } = await pool.query(`SELECT * FROM lm_mailboxes WHERE id=$1 AND user_id=$2`, [remId, uidOf(req)]);
        if (!mb) return res.status(404).json({ error: 'Ese buzón no existe' });
        if ((await nivelDe(req, 'outreach')) < 2) return res.status(403).json({ error: 'Tu nivel no permite enviar desde buzones' });
        try { const mbSvc = require('./mailboxService'); const auth = await mbSvc.getMailboxAuth(pool, mb); await mbSvc.sendFromMailbox(mb, auth, { to, cc: cc.length ? cc : undefined, subject: asunto, html: cuerpoHtml, text: plano_, fromName: 'NovaCentrax' }); }
        catch (e) { console.warn('[inicio] buzón no envió:', e.message); return res.status(502).json({ error: 'No se pudo enviar desde ese buzón: ' + String(e.message || 'error').slice(0, 140) }); }
      } else {
        const out = await correoSistema(to, asunto, cuerpoHtml, plano_, cc);
        if (!out.sent) return res.status(503).json({ error: (out.error || 'No se pudo enviar') + '. Prueba eligiendo un buzón conectado.', url });
      }
      destino = to + (cc.length ? ' (CC ' + cc.join(', ') + ')' : '');
    }
    await pool.query(`UPDATE inicio_cliente SET ultimo_recordatorio=NOW(), enlace_enviado_en=COALESCE(enlace_enviado_en,NOW()), estado=CASE WHEN estado='sin_enviar' THEN 'enviado' ELSE estado END WHERE id=$1`, [r.id]);
    await audit(r.id, req, 'mensaje_enviado', (canal === 'wa' ? 'WhatsApp ' : 'Correo ') + destino); res.json({ ok: true });
  });

  simple('recordatorio', async (req, res, r) => {   // correo al cliente con su enlace y lo que falta
    if (!vigente(r)) return res.status(409).json({ error: 'El enlace está caducado o revocado: renuévalo primero' });
    const en = r.idioma === 'en', pend = pendientesDe(r, en), enviado = yaEnviado(r);
    if (enviado && !pend.length) return res.status(409).json({ error: 'El cliente ya envió el formulario y no tiene puntos pendientes' });
    const to = String((req.body || {}).to || (r.respuestas || {}).mailInf || (r.prefill || {}).mailContacto || (r.prefill || {}).mailInf || '').trim();
    if (!SC.EMAIL_RE.test(to)) return res.status(400).json({ error: 'Falta el correo del cliente (escríbelo en el campo o en la ficha)' });
    const url = urlDe(r), pct = SC.progreso(plano({ ...(r.prefill || {}), ...(r.respuestas || {}) }), acuerdosBool(r.acuerdos));
    const R = { ...(r.prefill || {}), ...(r.respuestas || {}) }, nombre = String(R.contacto || '').trim().split(/[\s,]+/)[0];
    const lista = pend.length ? `<ul style="margin:0 0 12px;padding-left:20px;color:#374151">${pend.slice(0, 30).map(x => `<li style="margin:3px 0">${esc(x)}</li>`).join('')}</ul>` : '';
    const asunto = en ? 'Pending points for your NovaCentrax start' : 'Puntos pendientes para tu inicio con NovaCentrax';
    const hola = en ? `<p style="margin:0 0 12px;color:#374151">We are happy to get started${nombre ? ', ' + esc(nombre) : ''}.</p>` : `<p style="margin:0 0 12px;color:#374151">Estamos felices de comenzar${nombre ? ', ' + esc(nombre) : ''}.</p>`;
    const cuerpo = hola + (pend.length
      ? `<p style="margin:0 0 8px;color:#374151">${en ? 'We still have the following points pending:' : 'Tenemos pendientes los siguientes puntos:'}</p>${lista}`
      : `<p style="margin:0 0 12px;color:#374151">${en ? 'We need a few details to start your pilot.' : 'Necesitamos unos datos para arrancar tu piloto.'}</p>`)
      + `<p style="margin:0 0 12px;color:#374151">${en ? 'Please send them soon' : 'Recuerda enviarlo pronto'}${enviado ? (en ? ' through the communication channel you chose.' : ' por el canal de comunicación que elegiste.') : (en ? `; you can save and come back anytime${pct ? ` (you are at ${pct}%)` : ''}.` : `; puedes guardar y volver cuando quieras${pct ? ` (llevas un ${pct} %)` : ''}.`)}</p>`
      + (enviado ? '' : `<p style="margin:0;color:#6b7280;font-size:13px">${en ? 'The link is personal and works until' : 'El enlace es personal y funciona hasta el'} ${esc(new Date(r.expira_en).toISOString().slice(0, 10))}.</p>`);
    const texto = `${asunto}\n${pend.join('\n')}${enviado ? '' : '\n' + url}`;
    const out = await correoSistema(to, asunto, marco(en ? 'Your start form' : 'Tu formulario de inicio', cuerpo, enviado ? null : { url, txt: en ? 'Complete the form' : 'Completar el formulario' }), texto);
    if (!out.sent) return res.status(503).json({ error: out.error || 'No se pudo enviar', url });
    await pool.query(`UPDATE inicio_cliente SET ultimo_recordatorio=NOW(), enlace_enviado_en=COALESCE(enlace_enviado_en,NOW()), estado=CASE WHEN estado='sin_enviar' THEN 'enviado' ELSE estado END WHERE id=$1`, [r.id]);
    await audit(r.id, req, 'recordatorio_enviado', ''); res.json({ ok: true });
  });

  // «Revisado»: pasa facturación y comunicación a la ficha de cliente existente (sin duplicarla) o la crea
  simple('revisar', async (req, res, r) => {
    if (r.estado !== 'recibido') return res.status(409).json({ error: r.estado === 'revisado' || r.estado === 'portal' ? 'Ya está revisado' : 'El cliente aún no ha enviado el formulario' });
    const p = plano(r.respuestas), v = SC.validar({ ...(r.prefill || {}), ...p }, acuerdosBool(r.acuerdos));
    if (!v.ok) return res.status(409).json({ error: 'Faltan campos obligatorios', faltan: v.faltan });
    const R = { ...(r.prefill || {}), ...(r.respuestas || {}) }, uid = uidOf(req);
    const nombreDe = (R.contacto || '').split(',')[0].trim();
    let cid = r.cliente_id;
    if (!cid) {   // buscar una existente por correo o empresa antes de crear
      const { rows: [ex] } = await pool.query(`SELECT id FROM clients WHERE user_id=$1 AND ((LOWER(email)=LOWER($2) AND $2<>'') OR LOWER(empresa)=LOWER($3) OR LOWER(razon_social)=LOWER($3)) ORDER BY id LIMIT 1`, [uid, R.mailInf || R.mailContacto || '', R.razon || '']);
      cid = ex ? ex.id : null;
    }
    if (!cid) {
      const { rows: [c] } = await pool.query(`INSERT INTO clients (user_id, nombre, empresa, email, tipo) VALUES ($1,$2,$3,$4,'cliente') RETURNING id`, [uid, nombreDe || R.razon || 'Cliente', R.razon || '', R.mailInf || '']);
      cid = c.id;
    }
    await pool.query(`UPDATE clients SET razon_social=$2, nif=$3, direccion_fiscal=$4, email_informes=$5, canal_preferido=$6, whatsapp=$7, idioma_preferido=$8, logo_url=$9, sales_navigator=$10,
      empresa=CASE WHEN empresa='' THEN $11 ELSE empresa END, email=CASE WHEN email='' THEN $5 ELSE email END, sitio_web=CASE WHEN sitio_web='' THEN $12 ELSE sitio_web END,
      pais=CASE WHEN pais='' THEN $13 ELSE pais END, nombre=CASE WHEN nombre='' THEN $14 ELSE nombre END, updated_at=NOW() WHERE id=$1 AND user_id=$15`,
      [cid, R.razon || '', R.nif || '', R.dir || '', R.mailInf || '', R.canal || '', R.wpp || '', R.idioma || r.idioma, R.logo || '', R.salesnav || '', R.razon || '', R.web || '', R.pais || '', nombreDe, uid]);
    await pool.query(`UPDATE inicio_cliente SET estado='revisado', revisado_por=$2, revisado_en=NOW(), cliente_id=$3 WHERE id=$1`, [r.id, req.user.id, cid]);
    await audit(r.id, req, 'revisado', ''); res.json({ ok: true, cliente_id: cid });
  });

  // Compuerta del portal: solo con estado «Revisado» y todos los obligatorios completos
  simple('portal', async (req, res, r) => {
    if (!(await soloAdmin(req, res))) return;
    const p = plano(r.respuestas), v = SC.validar({ ...(r.prefill || {}), ...p }, acuerdosBool(r.acuerdos));
    if (r.estado === 'portal') return res.status(409).json({ error: 'El acceso al portal ya está activo' });
    if (r.estado !== 'revisado' || !v.ok) return res.status(409).json({ error: 'Primero marca el formulario como «Revisado» (con todos los obligatorios completos)' });
    const R = { ...(r.prefill || {}), ...(r.respuestas || {}) }, uid = uidOf(req), email = String(R.mailInf || R.mailContacto || '').trim().toLowerCase();
    const portal = require('./portalRoutes');
    const empresa = R.razon || (r.prefill || {}).empresa || 'Cliente';
    let { rows: [oc] } = await pool.query('SELECT id FROM outbound_clients WHERE user_id=$1 AND LOWER(nombre)=LOWER($2) ORDER BY id LIMIT 1', [uid, empresa]);
    if (!oc) ({ rows: [oc] } = await pool.query(`INSERT INTO outbound_clients (user_id, nombre, estado, website) VALUES ($1,$2,'preparacion',$3) RETURNING id`, [uid, empresa, R.web || '']));
    const pw = portal.genPw();
    let acc;
    try {
      ({ rows: [acc] } = await pool.query(`INSERT INTO client_accounts (user_id, outbound_client_id, email, nombre, password_hash, sections, lang, pw_remind_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+interval '14 days') RETURNING id`,
        [uid, oc.id, email, (R.contacto || '').split(',')[0].trim().slice(0, 120), portal.hashPw(pw), JSON.stringify(portal.defaultSections()), r.idioma === 'en' ? 'en' : 'es']));
    } catch (e) { if (String(e.message).includes('client_accounts_email_uq')) return res.status(409).json({ error: 'Ya existe una cuenta del portal con ese correo' }); throw e; }
    await pool.query(`UPDATE inicio_cliente SET estado='portal', outbound_client_id=$2, portal_account_id=$3, portal_activado_en=NOW() WHERE id=$1`, [r.id, oc.id, acc.id]);
    let invite = null; try { invite = await portal.sendClientMail(oc.id, 'invite', r.idioma === 'en' ? 'en' : 'es', { to: email, nombre: (R.contacto || '').split(',')[0].trim(), cliente: empresa, pw, url: 'https://app.novacentrax.com/portal/' + portal.slugOf(empresa) }); } catch (e) { invite = { sent: false, error: e.message }; }
    await audit(r.id, req, 'portal_activado', '');
    res.json({ ok: true, email, password: pw, invite });     // la contraseña temporal solo se muestra ahora
  });

  async function borrarAccesos(id, req, motivo) {
    const { rows: [r] } = await pool.query('SELECT respuestas FROM inicio_cliente WHERE id=$1', [id]);
    const resp = { ...((r && r.respuestas) || {}) }; let n = 0;
    for (const s of SC.SENSIBLES) if (resp[s]) { delete resp[s]; n++; }
    await pool.query('UPDATE inicio_cliente SET respuestas=$2, accesos_borrados_en=NOW(), actualizado_en=NOW() WHERE id=$1', [id, JSON.stringify(resp)]);
    await audit(id, req, motivo, SC.SENSIBLES.join(',')); return n;
  }
  simple('borrar-accesos', async (req, res, r) => { if (!(await soloAdmin(req, res))) return; const n = await borrarAccesos(r.id, req, 'accesos_borrados'); res.json({ ok: true, borrados: n }); });

  // Borrado automático: a los 45 días o al cerrar el piloto (lo que ocurra antes)
  async function borrarVencidos() {
    try {
      const { rows } = await pool.query(`SELECT i.id FROM inicio_cliente i WHERE i.accesos_borrados_en IS NULL AND (i.respuestas ? 'liPass' OR i.respuestas ? 'mailPass')
        AND (COALESCE(i.enviado_en, i.actualizado_en) < NOW() - interval '${DIAS_ACCESOS} days' OR i.outbound_client_id IN (SELECT id FROM outbound_clients WHERE estado='cerrado'))`);
      for (const x of rows) await borrarAccesos(x.id, null, 'accesos_borrados_auto');
      if (rows.length) console.log(`[inicio] accesos borrados automáticamente: ${rows.length}`);
    } catch (e) { console.warn('[inicio] borrado automático:', e.message); }
  }
}

module.exports = { mount, cifrar, descifrar };
