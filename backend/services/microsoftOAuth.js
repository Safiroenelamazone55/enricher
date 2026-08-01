// ─────────────────────────────────────────────────────────────────────
// Microsoft OAuth 2.0 — para buzones Office 365 donde el tenant bloquea
// la autenticación básica IMAP (política default de Microsoft desde 2022).
//
// Flujo delegated (por usuario, sin admin consent):
//   1. buildAuthUrl(state) → URL a la que redirigimos al navegador. La usuaria
//      inicia sesión en Microsoft y consiente los scopes.
//   2. exchangeCode(code) → intercambia el authorization_code por access_token
//      + refresh_token. Ambos se cifran y se guardan en lm_mailboxes.
//   3. refreshAccessToken(refresh_token) → cuando el access_token expira
//      (típicamente cada ~1h), se pide uno nuevo con el refresh_token.
//      Refresh tokens de Microsoft duran ~90 días si se usan; los rotamos aquí.
//
// Multi-tenant ("common"): la app funciona con cualquier tenant Microsoft,
// necesario porque Jenny tiene buzones en tenants distintos (mwhads, tentsoftlab).
//
// Scopes:
//   - offline_access       → necesario para recibir refresh_token
//   - IMAP.AccessAsUser.All → IMAP autenticado por OAuth (XOAUTH2)
//   - SMTP.Send             → SMTP autenticado por OAuth (XOAUTH2)
//   - User.Read             → leer el email/nombre del usuario que se conectó
// ─────────────────────────────────────────────────────────────────────

const TENANT     = 'common';                    // multi-tenant
const AUTHORITY  = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const SCOPES     = ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All',
                    'https://outlook.office.com/SMTP.Send', 'User.Read'];

function _env() {
  const clientId     = process.env.MS_CLIENT_ID     || '';
  const clientSecret = process.env.MS_CLIENT_SECRET || '';
  const redirectUri  = process.env.MS_REDIRECT_URI  || '';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Falta configurar Microsoft OAuth: MS_CLIENT_ID, MS_CLIENT_SECRET y MS_REDIRECT_URI en el .env del backend.');
  }
  return { clientId, clientSecret, redirectUri };
}

// URL a la que hay que redirigir el navegador para arrancar OAuth. `state` viaja
// de ida y vuelta sin modificar: úsalo para atar el flujo a un clientId concreto.
function buildAuthUrl(state) {
  const { clientId, redirectUri } = _env();
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state: state || '',
    prompt: 'select_account',     // deja elegir cuenta aunque haya sesión iniciada
  });
  return `${AUTHORITY}/authorize?${q}`;
}

async function _tokenRequest(body) {
  const r = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const msg = d.error_description || d.error || `HTTP ${r.status}`;
    // Microsoft devuelve un texto largo con \r\n; nos quedamos con la primera línea.
    throw new Error(String(msg).split(/\r?\n/)[0].slice(0, 300));
  }
  return d;
}

// Intercambia el authorization_code por tokens. Devuelve todo lo que el server
// necesita persistir + el email del usuario (para atar al buzón).
async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = _env();
  const d = await _tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
  });
  // Sacar email/nombre del token con Graph (User.Read basta).
  const me = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${d.access_token}` },
  }).then(r => r.json()).catch(() => ({}));
  return {
    access_token:  d.access_token,
    refresh_token: d.refresh_token || '',
    expires_in:    d.expires_in   || 3600,        // segundos
    scope:         d.scope        || SCOPES.join(' '),
    email:         (me.mail || me.userPrincipalName || '').toLowerCase(),
    tenant_id:     me.id ? '' : '',               // id de usuario, no de tenant; lo guardamos vacío por ahora
  };
}

// Refresca el access_token. Microsoft rota el refresh_token cada cierto tiempo,
// así que si viene uno nuevo hay que persistirlo (el server lo hace).
async function refreshAccessToken(refresh_token) {
  const { clientId, clientSecret } = _env();
  const d = await _tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token,
    scope: SCOPES.join(' '),
  });
  return {
    access_token:  d.access_token,
    refresh_token: d.refresh_token || refresh_token,   // si no viene uno nuevo, sigue el mismo
    expires_in:    d.expires_in   || 3600,
    scope:         d.scope        || SCOPES.join(' '),
  };
}

function isConfigured() {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_REDIRECT_URI);
}

module.exports = { SCOPES, buildAuthUrl, exchangeCode, refreshAccessToken, isConfigured };
