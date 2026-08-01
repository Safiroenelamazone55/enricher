// ── Buzones multi-proveedor (SMTP + IMAP) ──────────────────────────────────
// Cada cliente outbound puede tener su buzón real (Google/Microsoft/Zoho/otro).
// Envío por SMTP (nodemailer), lectura por IMAP (imapflow). La contraseña de
// aplicación se guarda cifrada AES-256-GCM; la clave se deriva de MAILBOX_SECRET
// (o SESSION_SECRET) con scrypt — nunca se persiste ni se loggea en claro.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');

const _SECRET = process.env.MAILBOX_SECRET || process.env.SESSION_SECRET || 'enricher-dev-secret-change-in-prod';
const _KEY = crypto.scryptSync(_SECRET, 'nova-mailbox-v1', 32);

function encPass(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['g1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
function decPass(enc) {
  const [v, iv, tag, data] = String(enc || '').split(':');
  if (v !== 'g1') throw new Error('Formato de credencial inválido');
  const d = crypto.createDecipheriv('aes-256-gcm', _KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// Presets por proveedor. Microsoft usa 587+STARTTLS; el resto 465 SSL.
const PROVIDERS = {
  google:    { smtp: ['smtp.gmail.com', 465, true],      imap: ['imap.gmail.com', 993],        sentAuto: true  },
  microsoft: { smtp: ['smtp.office365.com', 587, false], imap: ['outlook.office365.com', 993], sentAuto: false },
  zoho:      { smtp: ['smtp.zoho.com', 465, true],       imap: ['imap.zoho.com', 993],         sentAuto: false },
  otro:      null,
};

// Zoho aloja los datos por región (data center) y CADA región tiene su propio
// servidor SMTP/IMAP. Usar el de la región equivocada hace que el login sea
// rechazado aunque la contraseña de aplicación sea correcta.
const ZOHO_REGIONS = {
  com:      { dominio: 'zoho.com',    etiqueta: 'Global / EE.UU. (.com)' },
  eu:       { dominio: 'zoho.eu',     etiqueta: 'Europa (.eu)' },
  in:       { dominio: 'zoho.in',     etiqueta: 'India (.in)' },
  'com.au': { dominio: 'zoho.com.au', etiqueta: 'Australia (.com.au)' },
  jp:       { dominio: 'zoho.jp',     etiqueta: 'Japón (.jp)' },
  'com.cn': { dominio: 'zoho.com.cn', etiqueta: 'China (.com.cn)' },
  sa:       { dominio: 'zoho.sa',     etiqueta: 'Arabia Saudí (.sa)' },
  ca:       { dominio: 'zohocloud.ca', etiqueta: 'Canadá (.ca)' },
};

// Deriva la región de Zoho a partir de un host ya guardado (para reabrir el form).
function zohoRegionFromHost(host) {
  const h = String(host || '').toLowerCase();
  // Orden por especificidad: primero los sufijos largos (com.au, com.cn) para que
  // no gane 'com' por accidente.
  const claves = Object.keys(ZOHO_REGIONS).sort((a, b) => ZOHO_REGIONS[b].dominio.length - ZOHO_REGIONS[a].dominio.length);
  for (const k of claves) if (h.endsWith(ZOHO_REGIONS[k].dominio)) return k;
  return 'com';
}

function resolveHosts(provider, b) {
  if (provider === 'zoho') {
    const region = ZOHO_REGIONS[b.zoho_region] ? b.zoho_region : 'com';
    const d = ZOHO_REGIONS[region].dominio;
    return { smtp_host: `smtp.${d}`, smtp_port: 465, smtp_secure: true, imap_host: `imap.${d}`, imap_port: 993 };
  }
  const p = PROVIDERS[provider];
  if (p) return { smtp_host: p.smtp[0], smtp_port: p.smtp[1], smtp_secure: p.smtp[2], imap_host: p.imap[0], imap_port: p.imap[1] };
  return {
    smtp_host: String(b.smtp_host || '').trim(), smtp_port: parseInt(b.smtp_port) || 465,
    smtp_secure: (parseInt(b.smtp_port) || 465) !== 587,
    imap_host: String(b.imap_host || '').trim(), imap_port: parseInt(b.imap_port) || 993,
  };
}

function _transport(mb, pass) {
  return nodemailer.createTransport({
    host: mb.smtp_host, port: mb.smtp_port, secure: !!mb.smtp_secure,
    requireTLS: !mb.smtp_secure,
    auth: { user: mb.email, pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

async function _imapConnect(mb, pass) {
  const client = new ImapFlow({
    host: mb.imap_host, port: mb.imap_port, secure: true,
    auth: { user: mb.email, pass },
    logger: false, emitLogs: false,
  });
  await client.connect();
  return client;
}

// Traducción de errores técnicos a mensajes accionables en español.
// Contexto opcional { host, provider } para desambiguar mensajes vagos ("AUTHENTICATE
// failed" significa cosas distintas en Microsoft, Zoho o Gmail).
function _friendlyErr(e, ctx = {}) {
  // imapflow pone el detalle real del servidor en propiedades laterales cuando el
  // .message es genérico ("Command failed"). Preferir esas: son la mina de oro.
  const rawMsg = String((e && e.message) || e || '');
  const detail = e && (e.responseText || e.response) || '';
  const m = String(detail || rawMsg);
  const host = String(ctx.host || '').toLowerCase();
  const prov = String(ctx.provider || '').toLowerCase();

  // ── Zoho ────────────────────────────────────────────────────────────────
  // Zoho manda un mensaje precioso, muy claro, que nos ahorra el trabajo.
  if (/yet to enable IMAP|enable IMAP for your account/i.test(m))
    return 'IMAP está DESHABILITADO en el panel de Zoho para este buzón. '
         + 'Entra a mail.zoho.com → Ajustes (rueda) → Correo → Cuentas de correo → IMAP → activa "IMAP Access". '
         + 'Detalle del servidor: ' + m.slice(0, 200);

  // ── Microsoft 365 ───────────────────────────────────────────────────────
  if (/SmtpClientAuthentication is disabled|SMTP ?AUTH.*disabled|SmtpClientAuthentication/i.test(m))
    return 'El envío SMTP está DESHABILITADO para este buzón en el panel del proveedor. '
         + 'No es la contraseña: el administrador debe activar "SMTP autenticado" para esta cuenta. '
         + 'Detalle del servidor: ' + m.slice(0, 200);
  if (/basic authentication is disabled|BasicAuthBlockedErr|blocked.*basic auth/i.test(m))
    return 'El tenant bloquea la autenticación básica (Security Defaults / acceso condicional). '
         + 'El administrador debe permitirla para este buzón, o habrá que usar OAuth. '
         + 'Detalle del servidor: ' + m.slice(0, 200);
  // Microsoft es intencionalmente vago con IMAP: "AUTHENTICATE failed." sin más.
  // Desde 2022 Microsoft deshabilita autenticación básica en tenants nuevos por default,
  // así que el 90% de las veces es eso, no una contraseña mala.
  if (/AUTHENTICATE failed/i.test(m) && (/office365|outlook\.com|microsoft/i.test(host) || prov === 'microsoft'))
    return 'Microsoft rechazó la autenticación IMAP. Si la contraseña es correcta, casi seguro tu tenant tiene bloqueada '
         + 'la autenticación básica (política por defecto desde 2022). El admin del tenant tiene que activar '
         + '"IMAP con autenticación básica" solo para este buzón, o hay que migrar a OAuth. '
         + 'Detalle: ' + m.slice(0, 180);

  // ── Gmail ───────────────────────────────────────────────────────────────
  if (/application-specific password required|app password/i.test(m))
    return 'Gmail exige una contraseña de aplicación (la normal no sirve con IMAP). '
         + 'Crea una en myaccount.google.com/apppasswords y úsala aquí. Detalle: ' + m.slice(0, 180);

  // ── Genéricos de credenciales ───────────────────────────────────────────
  if (/credentials were incorrect|user name or password is incorrect|LogonDenied/i.test(m))
    return 'Usuario o contraseña incorrectos según el proveedor. Si la cuenta tiene verificación en 2 pasos, '
         + 'necesitas una contraseña de aplicación. Detalle: ' + m.slice(0, 200);
  if (/invalid credentials|authentication failed|LOGIN failed|535/i.test(m))
    return 'El proveedor rechazó el usuario o la contraseña. Detalle del servidor: ' + m.slice(0, 220);

  // ── Red / DNS / TLS ─────────────────────────────────────────────────────
  if (/ENOTFOUND|EAI_AGAIN/i.test(m + ' ' + rawMsg)) return 'No se encontró el servidor — revisa el host.';
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(m + ' ' + rawMsg)) return 'El servidor no respondió (puerto bloqueado o host incorrecto).';
  if (/self signed|certificate/i.test(m)) return 'Problema de certificado TLS del servidor.';

  // Fallback: al menos preferimos el detalle del servidor sobre "Command failed".
  return (detail ? detail : rawMsg).slice(0, 220);
}

// Prueba SMTP (login real) + IMAP (login + localizar carpeta Enviados).
async function testMailbox(mb, pass) {
  const out = { smtpOk: false, imapOk: false, sentFolder: '', error: '' };
  const ctx = { host: mb.smtp_host || mb.imap_host, provider: mb.provider };
  try { await _transport(mb, pass).verify(); out.smtpOk = true; }
  catch (e) { out.error = 'SMTP: ' + _friendlyErr(e, ctx); return out; }
  const ictx = { host: mb.imap_host, provider: mb.provider };
  try {
    const client = await _imapConnect(mb, pass);
    try {
      const boxes = await client.list();
      const sent = boxes.find(x => (x.specialUse || '') === '\\Sent') || boxes.find(x => /sent|enviado/i.test(x.path));
      out.sentFolder = sent ? sent.path : '';
      out.imapOk = true;
    } finally { await client.logout().catch(() => {}); }
  } catch (e) { out.error = 'IMAP: ' + _friendlyErr(e, ictx); }
  return out;
}

// Envía desde el buzón y garantiza la copia en "Enviados" del proveedor
// (append por IMAP cuando el proveedor no la guarda solo, p. ej. Microsoft/Zoho).
async function sendFromMailbox(mb, pass, msg) {
  const mail = {
    from: msg.fromName ? `"${msg.fromName.replace(/"/g, '')}" <${mb.email}>` : mb.email,
    to: msg.to, cc: msg.cc || undefined,
    subject: msg.subject || '', text: msg.text || undefined, html: msg.html || undefined,
    inReplyTo: msg.inReplyTo || undefined, references: msg.references || undefined,
  };
  const raw = await new MailComposer(mail).compile().build();
  const rcpt = [msg.to].concat(msg.cc ? [msg.cc] : []).flat();
  const info = await _transport(mb, pass).sendMail({ envelope: { from: mb.email, to: rcpt }, raw });
  const prov = PROVIDERS[mb.provider];
  if (!(prov && prov.sentAuto)) {
    try {
      const client = await _imapConnect(mb, pass);
      try {
        let folder = mb.sent_folder || '';
        if (!folder) {
          const boxes = await client.list();
          const sent = boxes.find(x => (x.specialUse || '') === '\\Sent') || boxes.find(x => /sent|enviado/i.test(x.path));
          folder = sent ? sent.path : 'Sent';
        }
        await client.append(folder, raw, ['\\Seen']);
      } finally { await client.logout().catch(() => {}); }
    } catch (e) { console.warn('[mailbox] append Enviados falló (el envío SÍ salió):', _friendlyErr(e)); }
  }
  return { messageId: info.messageId || '' };
}

module.exports = { PROVIDERS, ZOHO_REGIONS, zohoRegionFromHost, resolveHosts, encPass, decPass, testMailbox, sendFromMailbox, _friendlyErr };
