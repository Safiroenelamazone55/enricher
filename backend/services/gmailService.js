// ─────────────────────────────────────────────────────────────────────
// Gmail Service — envío de outreach + lectura de threads (detección de respuestas)
//
// Reutiliza los tokens google_* de la tabla users (mismo patrón que Google
// Calendar en server.js). La conexión Gmail pide gmail.send + gmail.readonly
// con include_granted_scopes, así un solo refresh token cubre Calendar y Gmail.
// El remitente SIEMPRE es la cuenta Google conectada ('me').
// ─────────────────────────────────────────────────────────────────────

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function _oauth2(callbackUrl) {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl
  );
}

// Cliente Gmail autenticado del usuario, o null si no conectó / faltan scopes.
async function getGmailClient(pool, userId, callbackUrl) {
  const { google } = require('googleapis');
  const { rows } = await pool.query(
    `SELECT google_access_token, google_refresh_token, google_token_expiry, google_scopes
       FROM users WHERE id=$1`,
    [userId]
  );
  if (!rows[0]?.google_refresh_token) return null;
  if (!(rows[0].google_scopes || '').includes('gmail.send')) return null;
  const auth = _oauth2(callbackUrl);
  auth.setCredentials({
    access_token:  rows[0].google_access_token,
    refresh_token: rows[0].google_refresh_token,
    expiry_date:   rows[0].google_token_expiry ? new Date(rows[0].google_token_expiry).getTime() : null,
  });
  auth.on('tokens', async tokens => {
    if (tokens.access_token) {
      await pool.query(
        `UPDATE users SET google_access_token=$1, google_token_expiry=$2 WHERE id=$3`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
      );
    }
  });
  return google.gmail({ version: 'v1', auth });
}

// RFC 2047: asunto con UTF-8 (tildes, ñ) seguro en headers.
function _encodeHeader(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function _buildMime({ fromName, fromEmail, to, subject, html, text }) {
  const boundary = 'lm_' + Math.random().toString(36).slice(2);
  const from = fromName ? `${_encodeHeader(fromName)} <${fromEmail}>` : fromEmail;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${_encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '', 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || '', 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Envía un email por la cuenta conectada. Devuelve { id, threadId } de Gmail.
async function sendEmail(pool, userId, callbackUrl, { to, subject, html, text, fromName }) {
  const gmail = await getGmailClient(pool, userId, callbackUrl);
  if (!gmail) throw new Error('gmail_not_connected');
  const { rows } = await pool.query(`SELECT email FROM users WHERE id=$1`, [userId]);
  const fromEmail = rows[0]?.email || 'me';
  const raw = _buildMime({ fromName, fromEmail, to, subject, html, text });
  const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { id: data.id, threadId: data.threadId };
}

// ¿El thread tiene una respuesta de alguien que NO es la cuenta conectada?
// Devuelve { replied, from, snippet, at } — replied=false si solo hay mensajes propios.
async function checkThreadForReply(pool, userId, callbackUrl, threadId) {
  const gmail = await getGmailClient(pool, userId, callbackUrl);
  if (!gmail) return { replied: false };
  const { rows } = await pool.query(`SELECT email FROM users WHERE id=$1`, [userId]);
  const ownEmail = (rows[0]?.email || '').toLowerCase();
  const { data } = await gmail.users.threads.get({
    userId: 'me', id: threadId, format: 'metadata',
    metadataHeaders: ['From', 'Date'],
  });
  for (const msg of data.messages || []) {
    const fromHdr = (msg.payload?.headers || []).find(h => h.name === 'From')?.value || '';
    const fromEmail = (fromHdr.match(/<([^>]+)>/)?.[1] || fromHdr).trim().toLowerCase();
    if (fromEmail && fromEmail !== ownEmail) {
      const dateHdr = (msg.payload?.headers || []).find(h => h.name === 'Date')?.value || '';
      return { replied: true, from: fromHdr, snippet: msg.snippet || '', at: dateHdr ? new Date(dateHdr) : new Date() };
    }
  }
  return { replied: false };
}

// Estado de conexión Gmail (para el frontend).
async function gmailStatus(pool, userId) {
  const { rows } = await pool.query(
    `SELECT email, google_refresh_token IS NOT NULL AS has_token, google_scopes FROM users WHERE id=$1`,
    [userId]
  );
  const connected = !!rows[0]?.has_token && (rows[0].google_scopes || '').includes('gmail.send');
  return { connected, email: connected ? rows[0].email : null };
}

module.exports = { GMAIL_SCOPES, getGmailClient, sendEmail, checkThreadForReply, gmailStatus };
