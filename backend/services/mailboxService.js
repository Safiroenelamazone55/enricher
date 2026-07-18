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

function resolveHosts(provider, b) {
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
function _friendlyErr(e) {
  const m = String((e && e.message) || e || '');
  if (/invalid credentials|authentication failed|auth|535|LOGIN failed/i.test(m))
    return 'El proveedor rechazó el usuario o la contraseña. Usa una contraseña de aplicación (no la normal).';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'No se encontró el servidor — revisa el host.';
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(m)) return 'El servidor no respondió (puerto bloqueado o host incorrecto).';
  if (/self signed|certificate/i.test(m)) return 'Problema de certificado TLS del servidor.';
  return m.slice(0, 180);
}

// Prueba SMTP (login real) + IMAP (login + localizar carpeta Enviados).
async function testMailbox(mb, pass) {
  const out = { smtpOk: false, imapOk: false, sentFolder: '', error: '' };
  try { await _transport(mb, pass).verify(); out.smtpOk = true; }
  catch (e) { out.error = 'SMTP: ' + _friendlyErr(e); return out; }
  try {
    const client = await _imapConnect(mb, pass);
    try {
      const boxes = await client.list();
      const sent = boxes.find(x => (x.specialUse || '') === '\\Sent') || boxes.find(x => /sent|enviado/i.test(x.path));
      out.sentFolder = sent ? sent.path : '';
      out.imapOk = true;
    } finally { await client.logout().catch(() => {}); }
  } catch (e) { out.error = 'IMAP: ' + _friendlyErr(e); }
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

module.exports = { PROVIDERS, resolveHosts, encPass, decPass, testMailbox, sendFromMailbox, _friendlyErr };
