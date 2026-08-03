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

// Decodifica el payload de un JWT (parte central en base64url). No verifica
// la firma — solo leemos los claims que Microsoft firmó, sirve para extraer
// email/upn/tenant sin llamar a Graph. Devuelve {} si no es JWT válido.
function _decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return {};
    // base64url → base64 + padding
    let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (_) { return {}; }
}

// Intercambia el authorization_code por tokens. Devuelve todo lo que el server
// necesita persistir + el email/tenant del usuario.
//
// Ojo: el access_token que Microsoft nos entrega es para outlook.office.com
// (por los scopes IMAP.AccessAsUser.All y SMTP.Send), NO para Graph. Un fetch
// a graph.microsoft.com/v1.0/me con este token da 401. En vez de pelearnos con
// eso, leemos el email directo del JWT del access_token — Microsoft ya mete
// upn/preferred_username/email como claims firmados. Si por algún motivo el
// token no es JWT (raro pero posible), intentamos Graph con un token nuevo
// obtenido usando el refresh_token para scope Graph.
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

  const claims = _decodeJwtPayload(d.access_token);
  let email = String(claims.email || claims.upn || claims.preferred_username || claims.unique_name || '').toLowerCase();
  const tenant_id = String(claims.tid || '');

  // Fallback: pedir un token nuevo específicamente para Graph y llamar /me.
  // Solo si el JWT no traía email (raro). Aprovecha el refresh_token.
  if (!email && d.refresh_token) {
    try {
      const graphTok = await _tokenRequest({
        client_id: clientId, client_secret: clientSecret,
        grant_type: 'refresh_token', refresh_token: d.refresh_token,
        scope: 'https://graph.microsoft.com/User.Read',
      });
      const me = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${graphTok.access_token}` },
      }).then(r => r.json()).catch(() => ({}));
      email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    } catch (_) { /* deja email vacío; el llamador decidirá */ }
  }

  return {
    access_token:  d.access_token,
    refresh_token: d.refresh_token || '',
    expires_in:    d.expires_in   || 3600,
    scope:         d.scope        || SCOPES.join(' '),
    email,
    tenant_id,
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
