/**
 * server.js — B2B Email Enricher API
 */

require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const session   = require('express-session');
const passport  = require('passport');
const https     = require('https');
const http      = require('http');
const { Server: SocketIOServer } = require('socket.io');

// ── Database (PostgreSQL) — imported early so initDb() runs at startup ──
const { pool, initDb, findOrCreateUser, findUserById } = require('./db');

// ── Passport Google OAuth strategy ───────────────────────────────
// Loaded lazily so the server starts even if credentials are absent.
function _setupPassport() {
  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

  const callbackURL = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/api/auth/google/callback`
    : `${process.env.API_BASE_URL || 'https://api.kiwoc.com'}/api/auth/google/callback`;
  console.log('[auth] callbackURL usado:', callbackURL);

  passport.use(new GoogleStrategy(
    {
      clientID:          process.env.GOOGLE_CLIENT_ID     || '',
      clientSecret:      process.env.GOOGLE_CLIENT_SECRET || '',
      callbackURL,
      passReqToCallback: true,
    },
    async (req, _accessToken, _refreshToken, profile, done) => {
      try {
        const email  = (profile.emails?.[0]?.value || '').toLowerCase();
        const avatar = profile.photos?.[0]?.value  || '';
        const joinToken = req.session?.pendingJoinToken;

        // ── Invite-based join: bypass whitelist ──────────────────
        if (joinToken) {
          const { rows: invites } = await pool.query(
            `SELECT * FROM workspace_invites
              WHERE token=$1 AND used=false AND expires_at > NOW()`,
            [joinToken]
          );
          if (invites.length > 0) {
            const invite = invites[0];
            const user = await findOrCreateUser({
              googleId: profile.id, email,
              name: profile.displayName || '', avatar,
            });
            if (!user.workspace_id) {
              await pool.query(
                `UPDATE users SET workspace_id=$1 WHERE id=$2`,
                [invite.workspace_owner_id, user.id]
              );
            }
            await pool.query(
              `UPDATE workspace_invites SET used=true WHERE id=$1`,
              [invite.id]
            );
            // Auto-create team_member using invite metadata (nombre, cargo, nivel)
            const { rows: tmExist } = await pool.query(
              `SELECT id FROM team_members WHERE user_id=$1 AND email=$2`,
              [invite.workspace_owner_id, email]
            );
            if (!tmExist.length) {
              const tmNombre = invite.nombre || profile.displayName || email.split('@')[0];
              const tmCargo  = invite.cargo  || '';
              const tmRol    = invite.nivel  || 'miembro';
              await pool.query(
                `INSERT INTO team_members (user_id, nombre, email, rol, cargo, estado)
                 VALUES ($1,$2,$3,$4,$5,'activo')`,
                [invite.workspace_owner_id, tmNombre, email, tmRol, tmCargo]
              );
            }
            req.session.pendingJoinToken = null;
            const updated = await findUserById(user.id);
            console.log(`[auth] workspace join ok — ${email} joined workspace ${invite.workspace_owner_id}`);
            return done(null, updated);
          }
          // Token invalid/expired — fall through to normal auth
          req.session.pendingJoinToken = null;
        }

        // ── Existing workspace member re-login (no token needed) ─
        const { rows: memberRows } = await pool.query(
          `SELECT id, workspace_id FROM users WHERE google_id=$1 AND workspace_id IS NOT NULL`,
          [profile.id]
        );
        if (memberRows.length > 0) {
          const user = memberRows[0];
          // Repair: if team_member record was never created (e.g. due to old bug), create it now
          const { rows: tmCheck } = await pool.query(
            `SELECT id FROM team_members WHERE user_id=$1 AND email=$2`,
            [user.workspace_id, email]
          );
          if (!tmCheck.length) {
            await pool.query(
              `INSERT INTO team_members (user_id, nombre, email, rol, estado)
               VALUES ($1,$2,$3,'miembro','activo')`,
              [user.workspace_id, profile.displayName || email.split('@')[0], email]
            );
            console.log(`[auth] auto-repaired missing team_member for ${email}`);
          }
          const freshUser = await findUserById(user.id);
          console.log(`[auth] workspace member re-login: ${email}`);
          return done(null, freshUser);
        }

        // ── Whitelist check (only for new/owner logins) ──────────
        const allowedRaw = process.env.ALLOWED_EMAILS || '';
        if (allowedRaw.trim()) {
          const whitelist = allowedRaw
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(Boolean);
          if (!whitelist.includes(email)) {
            console.warn(`[auth] blocked login attempt: ${email} not in ALLOWED_EMAILS`);
            return done(null, false, { message: 'unauthorized' });
          }
        }

        const user = await findOrCreateUser({
          googleId: profile.id,
          email,
          name:   profile.displayName || '',
          avatar,
        });
        // Auto-create admin team_member for owner on first login
        await pool.query(`
          INSERT INTO team_members (user_id, nombre, email, rol, cargo, estado)
          SELECT $1,
                 COALESCE(NULLIF($2,''), split_part($3,'@',1)),
                 $3, 'admin', 'Propietario', 'activo'
          WHERE NOT EXISTS (
            SELECT 1 FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($3)
          )
        `, [user.id, profile.displayName || '', email]);
        done(null, user);
      } catch (err) {
        done(err, null);
      }
    }
  ));

  // Store only the integer user id in the session
  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await findUserById(id);
      done(null, user ?? false);
    } catch (err) {
      done(err, null);
    }
  });
}

// ── Service imports (defensive — a broken service never kills the server) ──
const { enrichOneLead, enrichBatch } = require('./services/emailService');

let _markBounced          = async () => null;
let _getBounceStatus      = async () => ({ status: 'not-found' });
let _findByMessageId      = async () => null;
let _cascadeVerification  = async () => {};
let _verifyEmail          = async () => ({ status: 'error', message: 'bounceVerifierService unavailable' });
try {
  const bv = require('./services/bounceVerifierService');
  _markBounced          = bv.markBounced;
  _getBounceStatus      = bv.getBounceStatus;
  _findByMessageId      = bv.findByMessageId;
  _cascadeVerification  = bv.cascadeVerification;
  _verifyEmail          = bv.verifyEmail;
} catch (e) {
  console.warn('[server] bounceVerifierService unavailable:', e.message);
}

const { getMxRecords }                    = require('./services/dnsService');
const { parseLeadsFile, parseHeaders,
        buildResultsExcel, buildCleanExcel,
        buildTemplateExcel }              = require('./services/excelService');

// ── App ───────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT) || 3001;
const ENV  = process.env.NODE_ENV || 'development';
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 2000;

// Trust Render's reverse proxy (required for secure cookies + correct IP)
app.set('trust proxy', 1);

// ── CORS — first middleware, before everything else ───────────────
// Allows any *.kiwoc.com, *.pages.dev, *.onrender.com origin.
// Also honours the ALLOWED_ORIGINS env var for additional origins.
// When credentials:true the origin must be explicit (never '*').
const _extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().toLowerCase())
  : [];

function _isAllowedOrigin(origin) {
  if (!origin) return true;
  const o = origin.toLowerCase();
  return (
    o === 'https://kiwoc.com'        ||
    o.endsWith('.kiwoc.com')         ||
    o === 'https://novacentrax.com'  ||
    o.endsWith('.novacentrax.com')   ||
    o.endsWith('.pages.dev')         ||
    o.endsWith('.onrender.com')      ||
    _extraOrigins.includes('*')      ||
    _extraOrigins.includes(o)
  );
}

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (_isAllowedOrigin(origin)) {
    // Must be the exact origin (not '*') when credentials are involved
    res.setHeader('Access-Control-Allow-Origin',      origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',     'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',     'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers',    'X-Parse-Warnings');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '512kb' }));

// ── Session ───────────────────────────────────────────────────────
// sameSite:'none' + secure:true are required for cross-site cookies
// (Cloudflare Pages frontend ↔ Render backend).
const SESSION_SECRET = process.env.SESSION_SECRET || 'enricher-dev-secret-change-in-prod';
// Las sesiones vivian en memoria: cada despliegue del backend echaba a todo el
// mundo. Ahora se guardan en Postgres, asi que reiniciar no cierra la sesion.
let _sessionStore;
try {
  const PgSession = require('connect-pg-simple')(session);
  _sessionStore = new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
  _sessionStore.on('error', err => console.error('[session] store:', err.message));
  console.log('[session] almacenadas en Postgres (user_sessions)');
} catch (e) {
  console.warn('[session] connect-pg-simple no disponible, se usa memoria:', e.message);
}
const sessionMiddleware = session({
  store:             _sessionStore,
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   ENV === 'production',
    sameSite: ENV === 'production' ? 'none' : 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

// ── Passport ──────────────────────────────────────────────────────
try {
  _setupPassport();
  app.use(passport.initialize());
  app.use(passport.session());
  console.log('[auth] Passport + Google OAuth configured');
} catch (e) {
  console.warn('[auth] passport setup failed (GOOGLE_CLIENT_ID/SECRET missing?):', e.message);
}

// ── Rate limiter ──────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — wait a moment.' },
});
app.use('/api/', limiter);

// ── File upload ───────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname) ||
               file.mimetype.includes('spreadsheet') ||
               file.mimetype.includes('csv') ||
               file.mimetype.includes('excel') ||
               file.mimetype.includes('officedocument');
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files allowed'), ok);
  },
});

// Subidas a Slack: cualquier tipo de archivo (documentos, imagenes, audio), sin el
// filtro de solo-Excel que usa el importador. El limite lo pone el plan de Slack.
const uploadSlack = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
});

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    // workspace_id set = member; null = workspace owner
    req.workspaceOwnerId = req.user.workspace_id || req.user.id;
    return next();
  }
  res.status(401).json({ error: 'Authentication required. Please log in.' });
}

// Acepta sesión web O un token de extensión (Bearer) — usado por endpoints del timer
// que la Browser Extension / Desktop Agent consumen sin cookies (Fase 2.1).
async function requireAuthOrToken(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    req.workspaceOwnerId = req.user.workspace_id || req.user.id;
    return next();
  }
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      const hash = require('crypto').createHash('sha256').update(m[1].trim()).digest('hex');
      const { rows } = await pool.query(
        `UPDATE ext_tokens SET last_used_at=NOW() WHERE token_hash=$1 AND revoked=false RETURNING user_id`, [hash]);
      if (rows[0]) { req.user = { id: rows[0].user_id }; req.workspaceOwnerId = rows[0].user_id; return next(); }
    } catch (_) { /* cae a 401 */ }
  }
  res.status(401).json({ error: 'Authentication required.' });
}

// =================================================================
// ROUTES
// =================================================================

// ── POST /api/bounce-handler ──────────────────────────────────────
// Receives SES bounce notifications forwarded by Amazon SNS.
// Registered FIRST — never shadowed by any other route.
app.post('/api/bounce-handler', async (req, res) => {
  try {
    console.log('[bounce-handler] received');

    const sns  = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : (req.body || {});
    const type = sns.Type || sns.type || '';

    // SNS subscription confirmation
    if (type === 'SubscriptionConfirmation') {
      const url = sns.SubscribeURL;
      if (url) {
        const driver = url.startsWith('https') ? https : http;
        driver.get(url, r => r.resume()).on('error', () => {});
        console.log('[bounce-handler] SNS subscription confirmed');
      }
      return res.json({ status: 'ok' });
    }

    // Regular delivery notification
    if (type === 'Notification') {
      const message = typeof sns.Message === 'string'
        ? JSON.parse(sns.Message)
        : (sns.Message || {});

      if (message.notificationType === 'Bounce') {
        const bounce = message.bounce || {};
        const mail   = message.mail   || {};

        if (bounce.bounceType === 'Permanent') {
          const record = await _findByMessageId(mail.messageId || '');
          if (record) {
            await _markBounced(record.verifyId);
            console.log(`[bounce-handler] hard bounce verifyId=${record.verifyId} email=${record.email}`);
            // Cascade: try next candidate for this lead in the background
            _cascadeVerification(record.verifyId)
              .catch(err => console.warn('[cascade] unhandled error:', err.message));
          } else {
            console.warn(`[bounce-handler] no record for msgId=${mail.messageId}`);
          }
        } else {
          console.log(`[bounce-handler] soft bounce ignored (${bounce.bounceType})`);
        }
      }

      // ── DSN delivery confirmation ─────────────────────────────────
      // When the receiving server sends a delivery receipt (DSN), SES forwards
      // it as a 'Delivery' notification. This means the email was confirmed
      // delivered — mark immediately as 'guaranteed' without waiting 1 hour.
      if (message.notificationType === 'Delivery') {
        const mail = message.mail || {};
        const record = await _findByMessageId(mail.messageId || '');
        if (record) {
          const { pool } = require('./db');
          await pool.query(
            `UPDATE verifications
                SET status='verified', confidence='guaranteed', resolved_at=NOW()
              WHERE bounceVerifyId=$1 AND status='pending'`,
            [record.verifyId]
          );
          console.log(`[bounce-handler] DSN delivery confirmed verifyId=${record.verifyId} email=${record.email}`);
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[bounce-handler] error:', err.message);
    res.json({ status: 'ok' });   // always 200 so SNS does not retry
  }
});

// ── GET /api/bounce-status/:verifyId ─────────────────────────────
app.get('/api/bounce-status/:verifyId', async (req, res) => {
  const { verifyId } = req.params;
  const result = await _getBounceStatus(verifyId);

  if (result.status === 'not-found') {
    return res.status(404).json({ error: 'ID not found' });
  }

  res.json({ verifyId, ...result });
});

// ── GET /health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// =================================================================
// AUTH ROUTES
// =================================================================

// ── GET /api/auth/google ──────────────────────────────────────────
// Redirects to Google consent screen.
// Captures ?join=TOKEN into session so the strategy can process it.
app.get('/api/auth/google', (req, res, next) => {
  if (req.query.join) req.session.pendingJoinToken = req.query.join;
  // prompt=select_account: Google SIEMPRE muestra el selector de cuenta (no auto-entra en
  // silencio). Da control al usuario con varias cuentas y evita el "abre solo al hacer clic".
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next);
});

// ── GET /api/auth/google/callback ─────────────────────────────────
// Uses a custom callback instead of the shorthand middleware so we can
// handle two edge cases gracefully:
//
//   1. invalid_grant (TokenError) — Google authorization codes are
//      single-use. If the browser retries the callback URL (network
//      hiccup, Render health-check redirect, etc.) the second attempt
//      fails with invalid_grant. We check whether a valid session
//      already exists and, if so, redirect to the frontend as if the
//      login just succeeded — no error shown to the user.
//
//   2. Whitelist rejection — strategy calls done(null, false) →
//      redirect with ?error=unauthorized.
app.get('/api/auth/google/callback', (req, res, next) => {
  // Fast path: code already redeemed and session is live
  if (req.isAuthenticated && req.isAuthenticated()) {
    console.log('[auth] callback hit with live session — skipping OAuth exchange');
    return res.redirect(FRONTEND_URL + '?auth=ok');
  }

  passport.authenticate('google', { session: true }, (err, user) => {
    if (err) {
      // Log the error but don't crash — check if a session was established
      // by an earlier attempt (race condition / double-callback)
      console.warn('[auth] OAuth error:', err.message);
      if (req.isAuthenticated && req.isAuthenticated()) {
        return res.redirect(FRONTEND_URL + '?auth=ok');
      }
      return res.redirect(FRONTEND_URL + '?error=auth_failed');
    }

    if (!user) {
      // done(null, false) — whitelist rejection
      return res.redirect(FRONTEND_URL + '?error=unauthorized');
    }

    req.login(user, loginErr => {
      if (loginErr) return next(loginErr);
      console.log(`[auth] login ok — user ${user.email}`);
      res.redirect(FRONTEND_URL + '?auth=ok');
    });
  })(req, res, next);
});

// ── GET /api/auth/me ──────────────────────────────────────────────
// Returns the authenticated user with workspace info.
app.get('/api/auth/me', async (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    const { id, email, name, avatar, workspace_id } = req.user;
    const workspaceOwnerId = workspace_id || id;
    const isOwner = !workspace_id;
    let workspaceName = name;
    let companyName   = '';
    let companyLogo   = '';
    let memberNombre = name;
    let memberRol    = isOwner ? 'admin' : 'miembro';
    let memberId     = null;
    try {
      const { rows } = await pool.query(
        `SELECT name, company_name, company_logo FROM workspaces WHERE owner_id = $1`,
        [workspaceOwnerId]
      );
      if (rows.length) {
        workspaceName = rows[0].name;
        companyName   = rows[0].company_name || '';
        companyLogo   = rows[0].company_logo || '';
      }
    } catch (_) {}
    try {
      const { rows: tm } = await pool.query(
        `SELECT id, nombre, rol FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
        [workspaceOwnerId, email]
      );
      if (tm.length) {
        memberNombre = tm[0].nombre || name;
        memberRol    = tm[0].rol    || memberRol;
        memberId     = tm[0].id;
      }
    } catch (_) {}
    return res.json({ loggedIn: true, id, email, name, avatar, workspace_id, workspaceName, companyName, companyLogo, isOwner, memberNombre, memberRol, memberId });
  }
  res.json({ loggedIn: false });
});

// ── GET /api/auth/logout ──────────────────────────────────────────
app.get('/api/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ loggedIn: false });
    });
  });
});

// =================================================================
// DEBUG ROUTES  (temporary — remove before GA)
// =================================================================

// ── GET /api/debug/bounce-test ────────────────────────────────────
app.get('/api/debug/bounce-test', async (req, res) => {
  const testEmail = req.query.email || 'test@kiwoc.com';
  const testLeadId = 'debug_test_lead';
  console.log(`[debug/bounce-test] forcing verifyEmail for ${testEmail}`);
  try {
    const result = await _verifyEmail(testEmail, testLeadId, null, []);
    console.log(`[debug/bounce-test] result:`, result);
    res.json({ testEmail, result });
  } catch (err) {
    console.error(`[debug/bounce-test] error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/debug/bounce ─────────────────────────────────────────
// Alias simplificado. Acepta ?email= opcional (default: debug@kiwoc.com).
// Devuelve diagnóstico completo: resultado de verifyEmail + env vars presentes.
// Sin autenticación — ELIMINAR ANTES DE GA.
app.get('/api/debug/bounce', async (req, res) => {
  const testEmail  = req.query.email || 'debug@kiwoc.com';
  const testLeadId = 'debug_bounce_lead';

  const envCheck = {
    SES_FROM_EMAIL:       !!process.env.SES_FROM_EMAIL,
    AWS_ACCESS_KEY_ID:    !!process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY:!!process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION:           process.env.AWS_REGION || '(no seteado — usará us-east-1)',
    DATABASE_URL:         !!process.env.DATABASE_URL,
  };

  console.log(`[debug/bounce] env check:`, envCheck);
  console.log(`[debug/bounce] calling verifyEmail for ${testEmail}`);

  try {
    const result = await _verifyEmail(testEmail, testLeadId, null, []);
    console.log(`[debug/bounce] result:`, result);
    res.json({ testEmail, envCheck, result });
  } catch (err) {
    console.error(`[debug/bounce] error:`, err.message);
    res.status(500).json({ testEmail, envCheck, error: err.message });
  }
});

// =================================================================
// ENRICHMENT ROUTES  (protected — require authentication)
// =================================================================

// ── POST /api/enrich ──────────────────────────────────────────────
app.post('/api/enrich', requireAuth, async (req, res) => {
  const { firstName, lastName, company, tag } = req.body ?? {};
  if (!firstName || !lastName || !company)
    return res.status(400).json({ error: 'firstName, lastName and company are required.' });
  try {
    const cleanTag = (typeof tag === 'string' && tag.trim()) ? tag.trim() : null;
    res.json(await enrichOneLead({ firstName, lastName, company }, req.user?.id ?? null, cleanTag));
  } catch (err) {
    console.error('[/api/enrich]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/batch ────────────────────────────────────────
app.post('/api/enrich/batch', requireAuth, async (req, res) => {
  const { leads, tag } = req.body ?? {};
  if (!Array.isArray(leads) || leads.length === 0)
    return res.status(400).json({ error: '`leads` array is required.' });
  if (leads.length > BATCH_LIMIT)
    return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
  try {
    const cleanTag = (typeof tag === 'string' && tag.trim()) ? tag.trim() : null;
    const results = await enrichBatch(leads, req.user?.id ?? null, cleanTag);
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[/api/enrich/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/parse-headers ───────────────────────────────
// ── POST /api/enrich/repair-lead-data ────────────────────────────
// Patches verifications records that are missing _rawColumns / _extra.
// The client sends the batchResults (which now include _rawColumns from
// _buildResult) and we find matching DB records by email+userId and update
// their lead_data to add the missing columns.
app.post('/api/enrich/repair-lead-data', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) return res.status(400).json({ error: 'results required' });

  let updated = 0;
  for (const r of results) {
    if (!r.bestEmail || (!r._rawColumns && !r._extra)) continue;
    try {
      const patch = {};
      if (r._rawColumns) patch._rawColumns = r._rawColumns;
      if (r._extra)      patch._extra      = r._extra;
      patch.firstName = r.firstName || '';
      patch.lastName  = r.lastName  || '';
      patch.company   = r.company   || '';

      // Only update records that have no _rawColumns in lead_data yet
      const { rowCount } = await pool.query(
        `UPDATE verifications
            SET lead_data = lead_data || $1::jsonb
          WHERE lower(email) = $2
            AND user_id = $3
            AND (lead_data->>'_rawColumns') IS NULL`,
        [JSON.stringify(patch), r.bestEmail.toLowerCase(), req.user.id]
      );
      updated += rowCount;
    } catch (err) {
      console.warn('[repair-lead-data] error for', r.bestEmail, err.message);
    }
  }
  res.json({ updated, total: results.length });
});

// ── POST /api/enrich/verify-batch ────────────────────────────────
// Sends SES verification for the best email of each enriched lead.
// Accepts the results array from a completed batch job.
app.post('/api/enrich/verify-batch', requireAuth, async (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  const tag     = (typeof req.body?.tag === 'string' && req.body.tag.trim()) ? req.body.tag.trim() : null;
  if (!results.length) return res.status(400).json({ error: 'results array required' });

  const { verifyEmail, recordCatchAll } = require('./services/bounceVerifierService');
  const userId = req.user?.id ?? null;
  let sent = 0, skipped = 0, catchAll = 0;

  for (const r of results) {
    const email = r.bestEmail;
    if (!email) { skipped++; continue; }

    // Catch-all domains: record without SES send
    if (r.isCatchAll) {
      const leadData = {
        firstName: r.firstName || '', lastName: r.lastName || '',
        isCatchAll: true, company: r.company || '',
        ...(r.leadData || {}),
      };
      await recordCatchAll(email, `${r.firstName}_${r.lastName}_${r.domain}`, userId, r.tag || tag, leadData)
        .catch(() => {});
      catchAll++;
      continue;
    }

    const leadData = {
      firstName: r.firstName || '', lastName: r.lastName || '',
      isCatchAll: false, company: r.company || '',
      noMxWarning: !r.mxFound,
      // Include original file columns so verifications table shows all fields
      ...( r._rawColumns ? { _rawColumns: r._rawColumns } : {}),
      ...( r._extra      ? { _extra:      r._extra      } : {}),
    };
    const remaining = (r.candidates || [])
      .filter(c => c.email !== email && !c.disqualified)
      .sort((a,b) => (b.score||0) - (a.score||0))
      .map(c => ({ email: c.email, score: c.score, pattern: c.pattern }));

    const result = await verifyEmail(
      email,
      `${r.firstName}_${r.lastName}_${r.domain}`,
      userId,
      remaining,
      r.tag || tag,
      leadData
    ).catch(() => ({ status: 'error' }));

    if (result.status === 'sent' || result.status === 'already-pending') sent++;
    else skipped++;
  }

  res.json({ sent, skipped, catchAll, total: results.length });
});

// Reads only the first row of an uploaded file and returns column
// names plus auto-detected field suggestions.
app.post('/api/enrich/parse-headers', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const result = parseHeaders(req.file.buffer, req.file.originalname || '');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/enrich/upload ───────────────────────────────────────
app.post('/api/enrich/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    let customMapping = null;
    if (req.body?.mapping) {
      try { customMapping = JSON.parse(req.body.mapping); } catch (_) {}
    }
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype, customMapping);
    if (leads.length === 0)
      return res.status(400).json({ error: 'No leads found in file.', warnings });
    if (leads.length > BATCH_LIMIT)
      return res.status(400).json({ error: `File has ${leads.length} rows, max is ${BATCH_LIMIT}.` });
    console.log(`[upload] Processing ${leads.length} leads from "${req.file.originalname}"`);
    const batchTag = (typeof req.body?.tag === 'string' && req.body.tag.trim()) ? req.body.tag.trim() : null;
    const results  = await enrichBatch(leads, req.user?.id ?? null, batchTag);
    const xlsBuf   = buildResultsExcel(results);
    const filename = `enriched_${Date.now()}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('X-Parse-Warnings', JSON.stringify(warnings));
    res.send(xlsBuf);
  } catch (err) {
    console.error('[/api/enrich/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/upload-json ─────────────────────────────────
app.post('/api/enrich/upload-json', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    let customMapping = null;
    if (req.body?.mapping) {
      try { customMapping = JSON.parse(req.body.mapping); } catch (_) {}
    }
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype, customMapping);
    if (leads.length > BATCH_LIMIT)
      return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
    const jsonTag = (typeof req.body?.tag === 'string' && req.body.tag.trim()) ? req.body.tag.trim() : null;
    // upload-json is used for preview only → quickMode skips SMTP/scraper/GitHub
    const results = await enrichBatch(leads, req.user?.id ?? null, jsonTag, true);
    res.json({ count: results.length, warnings, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Async job store — DB-backed ──────────────────────────────────
// Jobs are persisted in batch_jobs table so they survive server restarts.
// In-memory xlsBuffer cache: jobId → Buffer (lost on restart, rebuilt on demand)
const _xlsCache = new Map();

async function _jobCreate(jobId, userId, total) {
  const { pool } = require('./db');
  await pool.query(
    `INSERT INTO batch_jobs (job_id, user_id, status, total)
     VALUES ($1, $2, 'running', $3)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, userId ?? null, total]
  );
}

async function _jobDone(jobId, results, warnings, xlsBuffer) {
  const { pool } = require('./db');
  _xlsCache.set(jobId, xlsBuffer);
  await pool.query(
    `UPDATE batch_jobs
        SET status='done', results=$2, warnings=$3, finished_at=NOW()
      WHERE job_id=$1`,
    [jobId, JSON.stringify(results), JSON.stringify(warnings ?? [])]
  );
}

async function _jobError(jobId, errMsg) {
  const { pool } = require('./db');
  await pool.query(
    `UPDATE batch_jobs SET status='error', error=$2, finished_at=NOW() WHERE job_id=$1`,
    [jobId, errMsg]
  );
}

async function _notifyBatchDone(userId, count, jobId) {
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail || !userId) return;
  try {
    const user = await findUserById(userId);
    if (!user?.email) return;
    const { SendEmailCommand } = require('@aws-sdk/client-ses');
    const { SESClient } = require('@aws-sdk/client-ses');
    const ses = new SESClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
    const appUrl = process.env.APP_URL || 'https://enricher-ix3b.onrender.com';
    await ses.send(new SendEmailCommand({
      Source: fromEmail,
      Destination: { ToAddresses: [user.email] },
      Message: {
        Subject: { Data: `✅ Tu batch de ${count} leads está listo — Enricher` },
        Body: {
          Html: { Data: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937">
              <h2 style="margin:0 0 12px;font-size:1.1rem;color:#111827">Tu enriquecimiento terminó 🎉</h2>
              <p style="margin:0 0 16px;color:#374151">
                Se procesaron <strong>${count} leads</strong> correctamente.
                Entra al dashboard para ver y descargar los resultados.
              </p>
              <a href="${appUrl}" style="display:inline-block;background:#4f46e5;color:#fff;
                 padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem">
                Ver resultados →
              </a>
              <p style="margin:20px 0 0;font-size:.75rem;color:#9ca3af">
                Enricher B2B · Este mensaje es automático, no respondas.
              </p>
            </div>
          `},
          Text: { Data: `Tu batch de ${count} leads terminó. Entra a ${appUrl} para descargar los resultados.` },
        },
      },
    }));
    console.log(`[notify] email enviado a ${user.email} — ${count} leads`);
  } catch (err) {
    console.warn('[notify] email failed:', err.message);
  }
}

async function _jobGet(jobId) {
  const { pool } = require('./db');
  const { rows } = await pool.query(
    `SELECT job_id, user_id, status, total, results, warnings, error, created_at
       FROM batch_jobs WHERE job_id=$1`,
    [jobId]
  );
  return rows[0] ?? null;
}

// ─── Chat channel email notifications (2-minute debounce) ─────────────────
const _chatNotifPending = new Map();
// Key: `${wid}:${channel}` → { timer, msgs: [{senderName, content, at}], senderIds: Set }

function _scheduleChatNotif(pool, wid, channel, senderUserId, senderName, content) {
  if (!process.env.SES_FROM_EMAIL || !process.env.AWS_ACCESS_KEY_ID) return;
  const key     = `${wid}:${channel}`;
  const pending = _chatNotifPending.get(key) || { msgs: [], senderIds: new Set() };
  if (pending.timer) clearTimeout(pending.timer);
  pending.msgs.push({ senderName, content, at: new Date() });
  pending.senderIds.add(senderUserId);
  pending.timer = setTimeout(() => {
    _chatNotifPending.delete(key);
    _sendChatNotifEmail(pool, wid, channel, pending.msgs, pending.senderIds)
      .catch(e => console.warn('[chat-notif]', e.message));
  }, 2 * 60 * 1000);
  _chatNotifPending.set(key, pending);
}

async function _sendChatNotifEmail(pool, wid, channel, msgs, senderIds) {
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const ses = new SESClient({
    region:      process.env.AWS_REGION      || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  // Workspace members to notify (only those with an email)
  const { rows: members } = await pool.query(
    `SELECT email, nombre FROM team_members
      WHERE user_id=$1 AND estado='activo' AND email IS NOT NULL AND email <> ''`,
    [wid]
  );

  // Sender emails → exclude from recipients
  const { rows: sndUsers } = await pool.query(
    `SELECT email FROM users WHERE id = ANY($1::int[])`,
    [[...senderIds]]
  );
  const sndEmails = new Set(sndUsers.map(u => (u.email || '').toLowerCase()));
  const recipients = members.filter(m => !sndEmails.has((m.email || '').toLowerCase()));
  if (!recipients.length) return;

  // Friendly channel label
  let channelLabel = `#${channel}`;
  if (channel.startsWith('project:')) {
    const pid = Number(channel.split(':')[1]);
    const { rows: p } = await pool.query(`SELECT nombre FROM projects WHERE id=$1 AND user_id=$2`, [pid, wid]);
    if (p[0]) channelLabel = `#${p[0].nombre}`;
  } else if (channel.startsWith('client:')) {
    const cid = Number(channel.split(':')[1]);
    const { rows: c } = await pool.query(`SELECT nombre FROM clients WHERE id=$1 AND user_id=$2`, [cid, wid]);
    if (c[0]) channelLabel = `#${c[0].nombre}`;
  }

  const uniqueSenders = [...new Set(msgs.map(m => m.senderName))];
  const sendersLabel  = uniqueSenders.length === 1
    ? uniqueSenders[0]
    : `${uniqueSenders.slice(0, -1).join(', ')} y ${uniqueSenders.at(-1)}`;

  const appUrl    = process.env.APP_URL || FRONTEND_URL;
  const fromEmail = process.env.SES_FROM_EMAIL;
  const esc       = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const previewRows = msgs.slice(-5).map(m => {
    const initials = m.senderName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const time     = m.at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `
      <tr><td style="padding:7px 0;vertical-align:top">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="width:30px;height:30px;background:#F8B13F;border-radius:50%;color:#fff;
                      font-weight:700;font-size:.68rem;text-align:center;line-height:30px;flex-shrink:0">
            ${initials}
          </div>
          <div style="flex:1">
            <span style="font-size:.72rem;font-weight:600;color:#78716C">${esc(m.senderName)}</span>
            <span style="font-size:.68rem;color:#A8A29E;margin-left:5px">${time}</span>
            <div style="font-size:.85rem;color:#1C1917;line-height:1.5;margin-top:2px;word-break:break-word">
              ${esc(m.content)}
            </div>
          </div>
        </div>
      </td></tr>`;
  }).join('');

  const subject = `💬 ${sendersLabel} en ${channelLabel} — Nova`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#F9F5F2;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
    <div style="max-width:520px;margin:32px auto;border-radius:14px;overflow:hidden;
                box-shadow:0 4px 24px rgba(0,0,0,.08);background:#fff;border:1px solid #E5E1D8">
      <div style="background:linear-gradient(135deg,#F8B13F 0%,#E8921A 100%);padding:22px 28px">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:44px;height:44px;background:rgba(255,255,255,.25);border-radius:11px;
                      text-align:center;line-height:44px;font-size:22px">💬</div>
          <div>
            <div style="color:#fff;font-weight:700;font-size:1.05rem">Nuevo mensaje en Nova</div>
            <div style="color:rgba(255,255,255,.85);font-size:.78rem;margin-top:2px">${channelLabel}</div>
          </div>
        </div>
      </div>
      <div style="padding:24px 28px">
        <p style="margin:0 0 18px;font-size:.9rem;color:#57534E;line-height:1.5">
          <strong style="color:#1C1917">${esc(sendersLabel)}</strong>
          envió${msgs.length > 1 ? ` ${msgs.length} mensajes` : ' un mensaje'} en
          <strong style="color:#1C1917">${channelLabel}</strong>
        </p>
        <div style="background:#FAFAF8;border:1px solid #EDEAE4;border-radius:10px;padding:14px 18px;margin-bottom:20px">
          <table style="width:100%;border-collapse:collapse">${previewRows}</table>
        </div>
        <a href="${appUrl}"
           style="display:inline-block;background:#F8B13F;color:#fff;padding:11px 24px;
                  border-radius:8px;text-decoration:none;font-weight:600;font-size:.88rem">
          Ver conversación →
        </a>
      </div>
      <div style="background:#F9F5F2;border-top:1px solid #EDEAE4;padding:14px 28px;text-align:center">
        <p style="margin:0;font-size:.72rem;color:#A8A29E">
          Nova · Notificación automática de ${channelLabel}<br>No respondas a este correo.
        </p>
      </div>
    </div>
  </body></html>`;

  const text = `${sendersLabel} en ${channelLabel}:\n\n${msgs.slice(-5).map(m=>`[${m.senderName}] ${m.content}`).join('\n')}\n\nVer: ${appUrl}`;

  for (const m of recipients) {
    try {
      await ses.send(new SendEmailCommand({
        Source:      fromEmail,
        Destination: { ToAddresses: [m.email] },
        Message: {
          Subject: { Data: subject },
          Body: { Html: { Data: html }, Text: { Data: text } },
        },
      }));
      console.log(`[chat-notif] → ${m.email} (${channelLabel})`);
    } catch (err) {
      console.warn(`[chat-notif] failed ${m.email}:`, err.message);
    }
  }
}

// ── POST /api/enrich/upload-async ────────────────────────────────
// Starts full enrichment in the background; returns jobId immediately.
// Job state is persisted in DB — survives server restarts.
app.post('/api/enrich/upload-async', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    let customMapping = null;
    if (req.body?.mapping) { try { customMapping = JSON.parse(req.body.mapping); } catch (_) {} }
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype, customMapping);
    if (leads.length > BATCH_LIMIT)
      return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });

    const jobId        = require('crypto').randomUUID();
    const userId       = req.user?.id ?? null;
    const tag          = (typeof req.body?.tag       === 'string' && req.body.tag.trim())       ? req.body.tag.trim()       : null;
    const discoveryMode = req.body?.batchMode === 'discovery'; // true = skip SES verification

    if (discoveryMode) console.log(`[batch] Modo Descubrimiento — SES desactivado`);
    else               console.log(`[batch] Modo Verificación — SES activo`);

    await _jobCreate(jobId, userId, leads.length);

    // Fire and forget — do NOT await
    enrichBatch(leads, userId, tag, false, discoveryMode)
      .then(async results => {
        const xlsBuffer = buildResultsExcel(results);
        await _jobDone(jobId, results, warnings, xlsBuffer);
        console.log(`[async-job] ${jobId} done — ${results.length} leads`);
        // ── Dolor 4: notify user by email when batch finishes ──────
        _notifyBatchDone(userId, results.length, jobId).catch(() => {});
      })
      .catch(async err => {
        await _jobError(jobId, err.message);
        console.error(`[async-job] ${jobId} error:`, err.message);
      });

    res.json({ jobId, count: leads.length, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/enrich/job/:jobId ───────────────────────────────────
// Poll job status. Returns results when done, or triggers Excel download.
app.get('/api/enrich/job/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await _jobGet(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
    if (job.user_id !== null && job.user_id !== req.user?.id)
      return res.status(403).json({ error: 'Forbidden.' });

    if (job.status === 'running') return res.json({ status: 'running' });
    if (job.status === 'error')   return res.json({ status: 'error', error: job.error });

    // Done — check if client wants JSON or Excel
    const format = req.query.format || 'json';
    if (format === 'xlsx') {
      // Try in-memory cache first; rebuild from DB results if cache was lost (restart)
      let xlsBuf = _xlsCache.get(job.job_id);
      if (!xlsBuf && job.results) {
        xlsBuf = buildResultsExcel(Array.isArray(job.results) ? job.results : []);
        _xlsCache.set(job.job_id, xlsBuf);
      }
      if (!xlsBuf) return res.status(404).json({ error: 'Excel not available.' });
      const filename = `enriched_${Date.now()}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(Buffer.from(xlsBuf));
    }

    // Clean download
    if (format === 'xlsx-clean') {
      const results = Array.isArray(job.results) ? job.results : [];
      const cleanBuf = buildCleanExcel(results);
      const filename = `limpio_${Date.now()}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(Buffer.from(cleanBuf));
    }

    const results  = Array.isArray(job.results)  ? job.results  : [];
    const warnings = Array.isArray(job.warnings) ? job.warnings : [];
    res.json({ status: 'done', count: results.length, warnings, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/enrich/jobs ─────────────────────────────────────────
// Returns the last 20 batch jobs for the authenticated user.
app.get('/api/enrich/jobs', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  try {
    const { rows } = await pool.query(
      `SELECT job_id, status, total, error, created_at, finished_at
         FROM batch_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [req.user.id]
    );
    res.json({ jobs: rows.map(r => ({
      jobId:      r.job_id,
      status:     r.status,
      total:      r.total,
      error:      r.error ?? null,
      createdAt:  r.created_at,
      finishedAt: r.finished_at ?? null,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/user/verifications/tags ─────────────────────────────
// Returns the distinct non-null tags used by the authenticated user,
// sorted alphabetically. Used to populate the filter datalist.
app.get('/api/user/verifications/tags', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT tag
         FROM verifications
        WHERE user_id = $1 AND tag IS NOT NULL AND tag <> ''
        ORDER BY tag`,
      [req.user.id]
    );
    res.json({ tags: rows.map(r => r.tag) });
  } catch (err) {
    console.error('[/api/user/verifications/tags]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/user/verifications ──────────────────────────────────
// Returns ONE row per lead (grouped by leadId), showing the best result:
//   verified > pending > bounced
// So cascade attempts (multiple bounced + one verified) collapse into
// a single row showing the verified email — no confusion.
// Accepts optional ?tag= filter (case-insensitive).
app.get('/api/user/verifications', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const filterTag    = (typeof req.query.tag    === 'string' && req.query.tag.trim())    ? req.query.tag.trim()    : null;
  const filterFrom   = (typeof req.query.from   === 'string' && req.query.from.trim())   ? req.query.from.trim()   : null;
  const filterTo     = (typeof req.query.to     === 'string' && req.query.to.trim())     ? req.query.to.trim()     : null;
  const filterStatus     = (typeof req.query.status === 'string' && req.query.status.trim()) ? req.query.status.trim() : null;
  const isCatchAllFilter = filterStatus === 'catch-all';
  const isBouncedFilter  = filterStatus === 'bounced';
  const isReoonFilter    = filterStatus === 'reoon';
  const isSesFilter      = filterStatus === 'ses';
  const realStatusFilter = (!isCatchAllFilter && !isBouncedFilter && !isReoonFilter && !isSesFilter)
    ? (filterStatus && ['pending','verified','error'].includes(filterStatus) ? filterStatus : null)
    : null;

  // ── Inner query: dedup by leadid + filter by date/tag ────────────
  const params       = [req.user.id];
  const innerClauses = [];
  if (filterTag)  { params.push(filterTag);                innerClauses.push(`lower(tag) = lower($${params.length})`); }
  if (filterFrom) { params.push(filterFrom + ' 00:00:00'); innerClauses.push(`created_at >= $${params.length}::timestamptz`); }
  if (filterTo)   { params.push(filterTo   + ' 23:59:59'); innerClauses.push(`created_at <= $${params.length}::timestamptz`); }
  const innerWhere = innerClauses.length ? 'AND ' + innerClauses.join(' AND ') : '';

  // ── Outer query: status filter ────────────────────────────────────
  const outerClauses = [];
  if (realStatusFilter)      { params.push(realStatusFilter); outerClauses.push(`status = $${params.length}`); }
  else if (isCatchAllFilter) { outerClauses.push(`confidence = 'catch-all'`); }
  else if (isBouncedFilter)  { outerClauses.push(`status = 'bounced'`); }
  else if (isReoonFilter)    { outerClauses.push(`status = 'verified' AND (lead_data->>'verifiedByReoon')::boolean = true`); }
  else if (isSesFilter)      { outerClauses.push(`status = 'verified' AND (lead_data->>'verifiedByReoon' IS NULL OR lead_data->>'verifiedByReoon' = 'false') AND confidence != 'catch-all'`); }
  else                       { outerClauses.push(`status != 'bounced'`); }
  const outerWhere = 'WHERE ' + outerClauses.join(' AND ');

  const baseQuery = `
    SELECT * FROM (
      SELECT DISTINCT ON (leadid)
        bounceVerifyId, email, leadid, status, confidence, tag, lead_data, created_at, resolved_at
      FROM verifications
      WHERE user_id = $1 ${innerWhere}
      ORDER BY leadid,
        CASE status WHEN 'verified' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at DESC
    ) t
    ${outerWhere}
    ORDER BY created_at DESC`;

  try {
    const { rows } = await pool.query(baseQuery, params);
    res.json({
      count: rows.length,
      verifications: rows.map(r => ({
        bounceVerifyId: r.bounceverifyid,
        email:          r.email,
        status:         r.status,
        confidence:     r.confidence,
        tag:            r.tag       ?? null,
        leadData:       r.lead_data ?? null,
        createdAt:      r.created_at,
        resolvedAt:     r.resolved_at,
      })),
    });
  } catch (err) {
    console.error('[/api/user/verifications]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/user/verifications/retry ───────────────────────────
// Re-sends SES verification for a list of bounceVerifyIds owned by the user.
// Resets each record to pending so the 1-hour bounce window restarts fresh.
app.post('/api/user/verifications/retry', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const ids = Array.isArray(req.body?.verifyIds) ? req.body.verifyIds : [];
  if (!ids.length) return res.status(400).json({ error: 'verifyIds array required' });
  if (ids.length > 5000) return res.status(400).json({ error: 'Max 5000 per retry batch' });

  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) return res.status(500).json({ error: 'SES_FROM_EMAIL not configured' });

  // Load records — only the ones belonging to this user
  let rows;
  try {
    const { rows: r } = await pool.query(
      `SELECT bounceVerifyId, email, leadId, tag, lead_data, remaining_candidates
         FROM verifications
        WHERE bounceVerifyId = ANY($1::text[])
          AND user_id = $2
          AND status = 'error'`,   // only allow retrying failed sends, not pending/verified
      [ids, req.user.id]
    );
    rows = r;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
  const { SESClient } = require('@aws-sdk/client-ses');
  const ses = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
  });

  let sent = 0, failed = 0;
  for (const row of rows) {
    try {
      const verifyId  = row.bounceverifyid;
      const boundary  = `----=_Part_${verifyId.replace(/-/g,'').slice(0,16)}`;
      const rawEmail  = [
        `From: ${fromEmail}`,
        `To: ${row.email}`,
        `Subject: Delivery Verification`,
        `MIME-Version: 1.0`,
        `X-Verify-ID: ${verifyId}`,
        ...(process.env.SES_CONFIG_SET ? [`X-SES-CONFIGURATION-SET: ${process.env.SES_CONFIG_SET}`] : []),
        `Disposition-Notification-To: ${fromEmail}`,
        `Return-Receipt-To: ${fromEmail}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `This is an automated deliverability verification message. You may safely disregard this email.`,
        `--${boundary}--`,
      ].join('\r\n');

      const response = await ses.send(
        new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawEmail, 'utf8') } })
      );
      const newMessageId = response.MessageId || '';

      // Reset the record: new messageId, back to pending, fresh timestamp
      await pool.query(
        `UPDATE verifications
            SET status      = 'pending',
                confidence  = 'pending',
                messageId   = $2,
                created_at  = NOW(),
                resolved_at = NULL
          WHERE bounceVerifyId = $1`,
        [verifyId, newMessageId]
      );
      sent++;
    } catch (err) {
      console.warn(`[retry] failed for ${row.email}: ${err.message}`);
      failed++;
    }
  }

  res.json({ sent, failed, total: rows.length });
});

// ── POST /api/user/verifications/dismiss ─────────────────────────
// Immediately marks error rows as 'bounced' (confidence='dismissed') so
// they disappear from the dashboard. No waiting, no re-send.
app.post('/api/user/verifications/dismiss', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const ids = Array.isArray(req.body?.verifyIds) ? req.body.verifyIds : [];
  if (!ids.length) return res.status(400).json({ error: 'verifyIds array required' });
  if (ids.length > 5000) return res.status(400).json({ error: 'Max 5000 per batch' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE verifications
          SET status = 'bounced', confidence = 'dismissed', resolved_at = NOW()
        WHERE bounceVerifyId = ANY($1::text[])
          AND user_id = $2`,
      [ids, req.user.id]
    );
    res.json({ dismissed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/user/verifications/export ───────────────────────────
// Downloads a CSV of the user's verifications.  Accepts optional ?tag=.
app.get('/api/user/verifications/export', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const filterTag  = (typeof req.query.tag  === 'string' && req.query.tag.trim())  ? req.query.tag.trim()  : null;
  const filterFrom = (typeof req.query.from === 'string' && req.query.from.trim()) ? req.query.from.trim() : null;
  const filterTo   = (typeof req.query.to   === 'string' && req.query.to.trim())   ? req.query.to.trim()   : null;

  const filterStatus = (typeof req.query.status === 'string' && req.query.status.trim()) ? req.query.status.trim() : null;
  const isCatchAllFilterExp = filterStatus === 'catch-all';
  const realStatusFilterExp = isCatchAllFilterExp ? null
    : (filterStatus && ['pending','verified','error'].includes(filterStatus) ? filterStatus : null);

  const params       = [req.user.id];
  const innerClauses = [];
  if (filterTag)  { params.push(filterTag);                innerClauses.push(`lower(tag) = lower($${params.length})`); }
  if (filterFrom) { params.push(filterFrom + ' 00:00:00'); innerClauses.push(`created_at >= $${params.length}::timestamptz`); }
  if (filterTo)   { params.push(filterTo   + ' 23:59:59'); innerClauses.push(`created_at <= $${params.length}::timestamptz`); }
  const innerWhere = innerClauses.length ? 'AND ' + innerClauses.join(' AND ') : '';

  const expOuterClauses = [];
  if (realStatusFilterExp)  { params.push(realStatusFilterExp); expOuterClauses.push(`status = $${params.length}`); }
  else if (isCatchAllFilterExp) { expOuterClauses.push(`confidence = 'catch-all'`); }
  else { expOuterClauses.push(`status != 'bounced'`); }
  const expOuterWhere = 'WHERE ' + expOuterClauses.join(' AND ');

  try {
    const exportQuery = `
      SELECT * FROM (
        SELECT DISTINCT ON (leadid)
          email, leadid, status, confidence, tag, lead_data, created_at, resolved_at
        FROM verifications
        WHERE user_id = $1 ${innerWhere}
        ORDER BY leadid,
          CASE status WHEN 'verified' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
          created_at DESC
      ) t
      ${expOuterWhere}
      ORDER BY created_at DESC`;

    const { rows } = await pool.query(exportQuery, params);

    // Build CSV — include firstName/lastName from lead_data when available
    const csvEscape = v => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Collect original column headers in original file order using _rawColumns.
    // Falls back to _extra keys for older records that don't have _rawColumns.
    const colHeaderSet = new Set();
    const colHeaders   = [];
    for (const r of rows) {
      const ld  = r.lead_data || {};
      const raw = Array.isArray(ld._rawColumns) ? ld._rawColumns : null;
      if (raw) {
        raw.forEach(({ header }) => {
          if (!colHeaderSet.has(header)) { colHeaderSet.add(header); colHeaders.push(header); }
        });
      } else {
        Object.keys(ld._extra || {}).forEach(k => {
          if (!colHeaderSet.has(k)) { colHeaderSet.add(k); colHeaders.push(k); }
        });
      }
    }

    // Enrichment result columns first, then ALL original file columns in order
    const fixedHeaders = ['emailVerificado', 'estado', 'aceptaTodo', 'confianza', 'etiqueta', 'fechaCreacion', 'fechaResolucion'];
    const header = [...fixedHeaders, ...colHeaders];
    const lines  = [header.join(',')];

    for (const r of rows) {
      const ld         = r.lead_data || {};
      const isCatchAll = !!(ld.isCatchAll);
      const statusLabel = isCatchAll ? 'acepta-todo' : r.status;

      // Build a map of header→value from _rawColumns (original order + values)
      const rawMap = {};
      if (Array.isArray(ld._rawColumns)) {
        ld._rawColumns.forEach(({ header, value }) => { rawMap[header] = value; });
      } else {
        Object.assign(rawMap, ld._extra || {});
      }

      const fixedValues = [
        csvEscape(r.email),
        csvEscape(statusLabel),
        csvEscape(isCatchAll ? 'Sí' : 'No'),
        csvEscape(r.confidence),
        csvEscape(r.tag ?? ''),
        csvEscape(r.created_at  ? new Date(r.created_at).toISOString()  : ''),
        csvEscape(r.resolved_at ? new Date(r.resolved_at).toISOString() : ''),
      ];
      const originalValues = colHeaders.map(h => csvEscape(rawMap[h] ?? ''));
      lines.push([...fixedValues, ...originalValues].join(','));
    }
    const csv      = lines.join('\r\n');
    const filename = `verificaciones_${Date.now()}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // BOM so Excel opens UTF-8 correctly
    res.send('﻿' + csv);
  } catch (err) {
    console.error('[/api/user/verifications/export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/template ─────────────────────────────────────────────
// Template download is public (no auth required)
app.get('/api/template', (_req, res) => {
  const buf = buildTemplateExcel();
  res.setHeader('Content-Disposition', 'attachment; filename="enricher-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── GET /api/domain-info ──────────────────────────────────────────
app.get('/api/domain-info', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain param required.' });
  try {
    const mx = await getMxRecords(domain);
    res.json({ domain, mxFound: mx.length > 0, mxRecords: mx.map(r => r.exchange) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// MANAGEMENT — CLIENTS
// =================================================================

// ── GET /api/mgmt/clients ─────────────────────────────────────────
app.get('/api/mgmt/clients', requireAuth, async (req, res) => {
  try {
    // POTENCIAL vs CLIENTE. Toda oportunidad da de alta una fila en clients, asi que
    // la cartera se llenaba de gente con la que aun no se trabaja. No hace falta una
    // columna nueva: se deduce, y asi el ascenso a cliente es automatico el dia que
    // la oportunidad se gana o que se le abre un proyecto.
    //   potencial = viene de una oportunidad + ninguna ganada + sin proyectos
    const { rows } = await pool.query(
      `SELECT c.*,
              COALESCE(o.n, 0)      AS oportunidades,
              COALESCE(o.abiertas, 0) AS oportunidades_abiertas,
              o.etapa               AS etapa_oportunidad,
              COALESCE(p.n, 0)      AS proyectos,
              (COALESCE(o.n,0) > 0 AND COALESCE(o.ganadas,0) = 0 AND COALESCE(p.n,0) = 0) AS potencial
         FROM clients c
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE estado = 'ganada')::int AS ganadas,
                  COUNT(*) FILTER (WHERE estado NOT IN ('ganada','perdida','archivada'))::int AS abiertas,
                  (ARRAY_AGG(etapa_actual ORDER BY created_at DESC))[1] AS etapa
             FROM opportunities WHERE client_id = c.id AND user_id = c.user_id) o ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS n FROM projects
            WHERE client_id = c.id AND user_id = c.user_id) p ON TRUE
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/clients] GET error:', err.message);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// ── POST /api/mgmt/clients ────────────────────────────────────────
app.post('/api/mgmt/clients', requireAuth, async (req, res) => {
  const { nombre, empresa, email, telefono, pais, estado, notas, comision_default,
          cargo, sitio_web, linkedin, industria, pais_empresa, ciudad, notas_empresa, tipo } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients
         (user_id, nombre, empresa, email, telefono, pais, estado, notas, comision_default,
          cargo, sitio_web, linkedin, industria, pais_empresa, ciudad, notas_empresa, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [req.workspaceOwnerId, nombre.trim(), empresa || '', email || '', telefono || '',
       pais || '', estado || 'activo', notas || '', comision_default || null,
       cargo || '', sitio_web || '', linkedin || '', industria || '',
       pais_empresa || '', ciudad || '', notas_empresa || '',
       tipo === 'contacto' ? 'contacto' : 'cliente']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/clients] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ── GET /api/mgmt/clients/:id ─────────────────────────────────────
app.get('/api/mgmt/clients/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM clients WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/clients] GET/:id error:', err.message);
    res.status(500).json({ error: 'Error al obtener cliente' });
  }
});

// ── PUT /api/mgmt/clients/:id ─────────────────────────────────────
app.put('/api/mgmt/clients/:id', requireAuth, async (req, res) => {
  const { nombre, empresa, email, telefono, pais, estado, notas, comision_default,
          cargo, sitio_web, linkedin, industria, pais_empresa, ciudad, notas_empresa } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(
      `UPDATE clients
          SET nombre=$3, empresa=$4, email=$5, telefono=$6, pais=$7,
              estado=$8, notas=$9, comision_default=$10, updated_at=NOW(),
              cargo=$11, sitio_web=$12, linkedin=$13, industria=$14,
              pais_empresa=$15, ciudad=$16, notas_empresa=$17
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId, nombre.trim(), empresa || '', email || '',
       telefono || '', pais || '', estado || 'activo', notas || '', comision_default || null,
       cargo || '', sitio_web || '', linkedin || '', industria || '',
       pais_empresa || '', ciudad || '', notas_empresa || '']
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/clients] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

// ── DELETE /api/mgmt/clients/:id ──────────────────────────────────
app.delete('/api/mgmt/clients/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM clients WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/clients] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar cliente' });
  }
});

// ── GET /api/mgmt/clients/:id/contacts ───────────────────────────
app.get('/api/mgmt/clients/:id/contacts', requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { rows: client } = await pool.query(
      `SELECT id FROM clients WHERE id=$1 AND user_id=$2`, [clientId, req.workspaceOwnerId]
    );
    if (!client.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const { rows } = await pool.query(
      `SELECT * FROM client_contacts WHERE client_id=$1 ORDER BY created_at ASC`, [clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[clients/contacts] GET error:', err.message);
    res.status(500).json({ error: 'Error al obtener contactos' });
  }
});

// ── POST /api/mgmt/clients/:id/contacts ──────────────────────────
app.post('/api/mgmt/clients/:id/contacts', requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { rows: client } = await pool.query(
      `SELECT id FROM clients WHERE id=$1 AND user_id=$2`, [clientId, req.workspaceOwnerId]
    );
    if (!client.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const { nombre = '', email = '', telefono = '', cargo = '' } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO client_contacts(client_id,nombre,email,telefono,cargo)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [clientId, nombre, email, telefono, cargo]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[clients/contacts] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear contacto' });
  }
});

// ── PUT /api/mgmt/clients/:id/contacts/:contactId ────────────────
app.put('/api/mgmt/clients/:id/contacts/:contactId', requireAuth, async (req, res) => {
  try {
    const clientId   = parseInt(req.params.id);
    const contactId  = parseInt(req.params.contactId);
    const { rows: client } = await pool.query(
      `SELECT id FROM clients WHERE id=$1 AND user_id=$2`, [clientId, req.workspaceOwnerId]
    );
    if (!client.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const { nombre = '', email = '', telefono = '', cargo = '' } = req.body;
    const { rows } = await pool.query(
      `UPDATE client_contacts SET nombre=$1,email=$2,telefono=$3,cargo=$4
       WHERE id=$5 AND client_id=$6 RETURNING *`,
      [nombre, email, telefono, cargo, contactId, clientId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[clients/contacts] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar contacto' });
  }
});

// ── DELETE /api/mgmt/clients/:id/contacts/:contactId ─────────────
app.delete('/api/mgmt/clients/:id/contacts/:contactId', requireAuth, async (req, res) => {
  try {
    const clientId   = parseInt(req.params.id);
    const contactId  = parseInt(req.params.contactId);
    const { rows: client } = await pool.query(
      `SELECT id FROM clients WHERE id=$1 AND user_id=$2`, [clientId, req.workspaceOwnerId]
    );
    if (!client.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    await pool.query(
      `DELETE FROM client_contacts WHERE id=$1 AND client_id=$2`, [contactId, clientId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients/contacts] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar contacto' });
  }
});

// =================================================================
// MANAGEMENT — PROJECTS
// =================================================================

// ── GET /api/mgmt/projects ────────────────────────────────────────
app.get('/api/mgmt/projects', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, c.nombre AS client_nombre, c.empresa AS client_empresa
         FROM projects p
         LEFT JOIN clients c ON p.client_id = c.id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/projects] GET error:', err.message);
    res.status(500).json({ error: 'Error al obtener proyectos' });
  }
});

// ── POST /api/mgmt/projects ───────────────────────────────────────
app.post('/api/mgmt/projects', requireAuth, async (req, res) => {
  const { nombre, client_id, descripcion, estado, responsable, responsable_id, responsables,
          fecha_inicio, fecha_fin, valor_total, prioridad,
          tipo_proyecto, moneda, tarifa_hora, horas_estimadas, horas_semanales, horario_semanal,
          comision } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!client_id)      return res.status(400).json({ error: 'El cliente es requerido' });
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    const { rows } = await pool.query(
      `INSERT INTO projects
         (user_id, client_id, nombre, descripcion, estado, responsable, responsable_id, responsables,
          fecha_inicio, fecha_fin, valor_total, prioridad,
          tipo_proyecto, moneda, tarifa_hora, horas_estimadas, horas_semanales, horario_semanal,
          comision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [req.workspaceOwnerId, client_id, nombre.trim(), descripcion || '', estado || 'activo',
       respFirst, responsable_id || null, respArr,
       fecha_inicio || null, fecha_fin || null, valor_total || null, prioridad || 'media',
       tipo_proyecto || 'fijo', moneda || 'USD',
       tarifa_hora || null, horas_estimadas || null, horas_semanales || null, horario_semanal || '',
       comision || null]
    );
    // Contacto que consigue su primer proyecto → se promueve a cliente (y vuelve a activo).
    try {
      await pool.query(
        `UPDATE clients SET tipo='cliente', estado=CASE WHEN COALESCE(estado,'activo')='inactivo' THEN 'activo' ELSE estado END
         WHERE id=$1 AND user_id=$2 AND COALESCE(tipo,'cliente')='contacto'`,
        [client_id, req.workspaceOwnerId]);
    } catch (e) { console.warn('[mgmt/projects] promote contacto→cliente:', e.message); }

    // Canal de Slack para el proyecto nuevo, en el workspace marcado por defecto
    // (Novacentrax). Best-effort: si Slack falla, el proyecto se crea igual y el
    // canal se puede ligar despues a mano.
    let slack_channel = null;
    try {
      const { rows: [ws] } = await pool.query(
        `SELECT * FROM slack_workspaces WHERE user_id=$1 AND es_default_proyectos=true LIMIT 1`,
        [req.workspaceOwnerId]);
      if (ws) {
        const { rows: [cli] } = await pool.query(`SELECT nombre, empresa FROM clients WHERE id=$1`, [client_id]);
        const base = [cli ? (cli.nombre || cli.empresa) : '', nombre].filter(Boolean).join(' ');
        const chName = slackSvc.normalizarNombre(base, 'pj');
        const ch = await slackSvc.crearCanal(ws, chName);
        await pool.query(`UPDATE projects SET slack_channel_id=$1, slack_ws_id=$2 WHERE id=$3`,
          [ch.id, ws.id, rows[0].id]);
        slack_channel = ch.name;
      }
    } catch (e) { console.warn('[mgmt/projects] no se pudo crear el canal de Slack:', e.message); }

    res.status(201).json({ ...rows[0], slack_channel });
  } catch (err) {
    console.error('[mgmt/projects] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear proyecto' });
  }
});

// ── GET /api/mgmt/projects/:id ────────────────────────────────────
app.get('/api/mgmt/projects/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, c.nombre AS client_nombre, c.empresa AS client_empresa
         FROM projects p
         LEFT JOIN clients c ON p.client_id = c.id
        WHERE p.id = $1 AND p.user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] GET/:id error:', err.message);
    res.status(500).json({ error: 'Error al obtener proyecto' });
  }
});

// ── PUT /api/mgmt/projects/:id ────────────────────────────────────
app.put('/api/mgmt/projects/:id', requireAuth, async (req, res) => {
  const { nombre, client_id, descripcion, estado, responsable, responsable_id, responsables,
          fecha_inicio, fecha_fin, valor_total, prioridad,
          tipo_proyecto, moneda, tarifa_hora, horas_estimadas, horas_semanales, horario_semanal,
          comision } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!client_id)      return res.status(400).json({ error: 'El cliente es requerido' });
  // Si el caller NO envía responsable(s), se conservan los actuales (no se borran por omisión).
  const touchResp = responsables !== undefined || responsable !== undefined;
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    const { rows } = await pool.query(
      `UPDATE projects
          SET client_id=$3, nombre=$4, descripcion=$5, estado=$6,
              responsable=CASE WHEN $21 THEN $7 ELSE responsable END,
              responsable_id=$8,
              responsables=CASE WHEN $21 THEN $9::text[] ELSE responsables END,
              fecha_inicio=$10, fecha_fin=$11,
              valor_total=$12, prioridad=$13, tipo_proyecto=$14, moneda=$15,
              tarifa_hora=$16, horas_estimadas=$17, horas_semanales=$18, horario_semanal=$19,
              comision=$20, updated_at=NOW()
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId, client_id, nombre.trim(),
       descripcion || '', estado || 'activo', respFirst, responsable_id || null, respArr,
       fecha_inicio || null, fecha_fin || null, valor_total || null, prioridad || 'media',
       tipo_proyecto || 'fijo', moneda || 'USD',
       tarifa_hora || null, horas_estimadas || null, horas_semanales || null, horario_semanal || '',
       comision || null, touchResp]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar proyecto' });
  }
});

// ── PATCH /api/mgmt/projects/:id/estado — cambio de estado seguro (no full-row) ──
// Al COMPLETAR: si el cliente queda sin ningún proyecto activo, pasa a 'inactivo'
// automáticamente (regla de Jenny: cerró su único proyecto → cliente inactivo).
app.patch('/api/mgmt/projects/:id/estado', requireAuth, async (req, res) => {
  const wid = req.workspaceOwnerId;
  const estado = String((req.body || {}).estado || '');
  if (!['activo', 'completado', 'pausado', 'cancelado'].includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
  try {
    const { rows } = await pool.query(
      `UPDATE projects SET estado=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id, nombre, estado, client_id`,
      [estado, req.params.id, wid]);
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });

    // Cerrar el proyecto archiva su canal de Slack, si tiene uno ligado. Best-effort:
    // un fallo de Slack no debe impedir el cambio de estado. Solo aplica a proyectos
    // con canal enlazado (los de Novacentrax que normalizamos), asi que queda acotado
    // a ese workspace sin logica extra.
    if (['completado', 'cancelado'].includes(estado)) {
      try {
        const { rows: [pj] } = await pool.query(
          `SELECT slack_channel_id, slack_ws_id FROM projects WHERE id=$1 AND user_id=$2`,
          [req.params.id, wid]);
        if (pj && pj.slack_channel_id && pj.slack_ws_id) {
          const w = await _slackWs(wid, pj.slack_ws_id);
          if (w) await slackSvc.archivarCanal(w, pj.slack_channel_id);
        }
      } catch (e) { console.warn('[projects/estado] no se pudo archivar el canal:', e.message); }
    }

    let client_inactivated = false, client_nombre = '';
    if (estado === 'completado' && rows[0].client_id) {
      const act = await pool.query(
        `SELECT COUNT(*)::int AS n FROM projects WHERE user_id=$1 AND client_id=$2 AND estado='activo'`,
        [wid, rows[0].client_id]);
      if ((act.rows[0]?.n || 0) === 0) {
        const cu = await pool.query(
          `UPDATE clients SET estado='inactivo' WHERE id=$1 AND user_id=$2 AND COALESCE(estado,'activo') <> 'inactivo' RETURNING nombre`,
          [rows[0].client_id, wid]);
        if (cu.rows[0]) { client_inactivated = true; client_nombre = cu.rows[0].nombre; }
      }
    }
    res.json({ ok: true, ...rows[0], client_inactivated, client_nombre });
  } catch (err) {
    console.error('[projects/estado]', err.message);
    res.status(500).json({ error: 'Error al cambiar el estado del proyecto' });
  }
});

// ── PATCH /api/mgmt/projects/:id/fechas — ampliar plazo (solo fechas, seguro) ──
app.patch('/api/mgmt/projects/:id/fechas', requireAuth, async (req, res) => {
  const b = req.body || {};
  const okd = v => v === null || v === '' || /^\d{4}-\d{2}-\d{2}/.test(String(v));
  if (b.fecha_fin !== undefined && !okd(b.fecha_fin)) return res.status(400).json({ error: 'fecha_fin no válida' });
  if (b.fecha_inicio !== undefined && !okd(b.fecha_inicio)) return res.status(400).json({ error: 'fecha_inicio no válida' });
  try {
    const sets = [], vals = [req.params.id, req.workspaceOwnerId];
    if (b.fecha_fin !== undefined) sets.push(`fecha_fin=$${vals.push(b.fecha_fin || null)}`);
    if (b.fecha_inicio !== undefined) sets.push(`fecha_inicio=$${vals.push(b.fecha_inicio || null)}`);
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at=NOW()');
    const { rows } = await pool.query(`UPDATE projects SET ${sets.join(',')} WHERE id=$1 AND user_id=$2 RETURNING id, fecha_inicio, fecha_fin`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[projects/fechas]', err.message);
    res.status(500).json({ error: 'Error al actualizar las fechas' });
  }
});

// ── PATCH /api/mgmt/projects/:id/valor — valor total (Conciliación) ──
app.patch('/api/mgmt/projects/:id/valor', requireAuth, async (req, res) => {
  const { valor_total } = req.body;
  const v = (valor_total === null || valor_total === '' || valor_total === undefined)
    ? null : Math.max(0, +valor_total || 0);
  try {
    const { rows } = await pool.query(
      `UPDATE projects SET valor_total=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 RETURNING id, valor_total`,
      [v, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] PATCH valor error:', err.message);
    res.status(500).json({ error: 'Error al actualizar el valor' });
  }
});

// ── PATCH /api/mgmt/projects/:id/descripcion — nota pública ───────
app.patch('/api/mgmt/projects/:id/descripcion', requireAuth, async (req, res) => {
  const { descripcion } = req.body;
  const uid = req.workspaceOwnerId;
  // Resolve display name: team member nombre first, fallback to user.name
  let displayName = req.user.name || '';
  try {
    const { rows: tm } = await pool.query(
      `SELECT nombre FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [uid, req.user.email]
    );
    if (tm.length && tm[0].nombre) displayName = tm[0].nombre;
  } catch (_) {}
  try {
    const { rows } = await pool.query(
      `UPDATE projects
          SET descripcion=$3, descripcion_updated_by=$4, descripcion_updated_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, uid, descripcion || '', displayName]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] PATCH descripcion error:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// ── PATCH /api/mgmt/projects/:id/links — archivos / enlaces ───────
app.patch('/api/mgmt/projects/:id/links', requireAuth, async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'links debe ser un arreglo' });
  try {
    const { rows } = await pool.query(
      `UPDATE projects SET links=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.workspaceOwnerId, JSON.stringify(links)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] PATCH links error:', err.message);
    res.status(500).json({ error: 'Error al guardar enlaces' });
  }
});

// ── DELETE /api/mgmt/projects/:id ─────────────────────────────────
app.delete('/api/mgmt/projects/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM projects WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/projects] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar proyecto' });
  }
});

// =================================================================
// MANAGEMENT — TASKS
// =================================================================

// ── GET /api/mgmt/tasks ───────────────────────────────────────────
app.get('/api/mgmt/tasks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
              p.nombre AS project_nombre,
              c.nombre AS client_nombre,
              COALESCE((
                SELECT json_agg(json_build_object('id', dt.id, 'titulo', dt.titulo, 'estado', dt.estado) ORDER BY dt.titulo)
                  FROM task_dependencies td JOIN tasks dt ON dt.id = td.depends_on_id
                 WHERE td.task_id = t.id
              ), '[]'::json) AS waiting_on,
              -- Horas realmente trackeadas en la tarea Y sus subtareas (para comparar
              -- lo trabajado contra la meta de horas de la semana en Finanzas).
              COALESCE((
                SELECT ROUND(SUM(te.duration_s)::numeric / 3600, 2)
                  FROM time_entries te
                 WHERE te.user_id = t.user_id
                   AND (te.task_id = t.id OR te.task_id IN (SELECT s.id FROM tasks s WHERE s.parent_task_id = t.id))
              ), 0) AS horas_track
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE t.user_id = $1
        ORDER BY
          CASE t.estado
            WHEN 'bloqueado'   THEN 1
            WHEN 'pendiente'   THEN 2
            WHEN 'en_progreso' THEN 3
            WHEN 'completado'  THEN 4
            ELSE 5
          END,
          t.deadline ASC NULLS LAST,
          t.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/tasks] GET error:', err.message);
    res.status(500).json({ error: 'Error al obtener tareas' });
  }
});

// ── POST /api/mgmt/tasks ──────────────────────────────────────────
app.post('/api/mgmt/tasks', requireAuth, async (req, res) => {
  const { titulo, project_id, descripcion, estado, prioridad,
          responsable, responsables, deadline, fecha_inicio, notas, monto, cobrado, parent_task_id,
          plan_dias, plan_horas, plan_hora } = req.body;
  if (!titulo?.trim())  return res.status(400).json({ error: 'El título es requerido' });
  if (!project_id)      return res.status(400).json({ error: 'El proyecto es requerido' });
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks
         (user_id, project_id, titulo, descripcion, estado, prioridad, responsable, responsables, deadline, fecha_inicio, notas, monto, cobrado, parent_task_id, plan_dias, plan_horas, plan_hora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [req.workspaceOwnerId, project_id, titulo.trim(), descripcion || '',
       estado || 'pendiente', prioridad || 'media',
       respFirst, respArr, deadline || null, fecha_inicio || null, notas || '',
       monto != null ? +monto : null, cobrado ? true : false,
       parent_task_id || null,
       plan_dias || '', plan_horas != null && plan_horas !== '' ? +plan_horas : null, plan_hora != null && plan_hora !== '' ? +plan_hora : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/tasks] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear tarea' });
  }
});

// ── GET /api/mgmt/tasks/:id ───────────────────────────────────────
app.get('/api/mgmt/tasks/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, p.nombre AS project_nombre, c.nombre AS client_nombre
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE t.id = $1 AND t.user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/tasks] GET/:id error:', err.message);
    res.status(500).json({ error: 'Error al obtener tarea' });
  }
});

// ── PUT /api/mgmt/tasks/:id ───────────────────────────────────────
app.put('/api/mgmt/tasks/:id', requireAuth, async (req, res) => {
  const { titulo, project_id, descripcion, estado, prioridad,
          responsable, responsables, deadline, fecha_inicio, notas, monto, cobrado, parent_task_id } = req.body;
  if (!titulo?.trim())  return res.status(400).json({ error: 'El título es requerido' });
  if (!project_id)      return res.status(400).json({ error: 'El proyecto es requerido' });
  if (parent_task_id && String(parent_task_id) === String(req.params.id))
    return res.status(400).json({ error: 'Una tarea no puede ser subtarea de sí misma' });
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    // Al mover una subtarea de una tarea a otra cambian DOS padres: el que la pierde
    // (puede quedar completo) y el que la recibe. Guardamos el viejo antes del UPDATE.
    const { rows: [antes] } = await pool.query(
      `SELECT parent_task_id FROM tasks WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    const padreViejo = antes ? antes.parent_task_id : null;
    const { rows } = await pool.query(
      `UPDATE tasks
          SET project_id=$3, titulo=$4, descripcion=$5, estado=$6,
              prioridad=$7, responsable=$8, responsables=$9, deadline=$10, notas=$11,
              monto=$12, cobrado=$13, parent_task_id=$14, fecha_inicio=$15, updated_at=NOW()
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId, project_id, titulo.trim(),
       descripcion || '', estado || 'pendiente', prioridad || 'media',
       respFirst, respArr, deadline || null, notas || '',
       monto != null ? +monto : null, cobrado ? true : false,
       parent_task_id || null, fecha_inicio || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    const parentEstado = await _syncParentEstado(req.workspaceOwnerId, rows[0].parent_task_id);
    if (padreViejo && padreViejo !== rows[0].parent_task_id) await _syncParentEstado(req.workspaceOwnerId, padreViejo);
    res.json({ ...rows[0], parent_estado: parentEstado, parent_id: rows[0].parent_task_id || null });
  } catch (err) {
    console.error('[mgmt/tasks] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar tarea' });
  }
});

// ── Coherencia padre ↔ subtareas ─────────────────────────────────
// Si TODAS las subtareas quedan completadas, la tarea padre se completa sola (si no,
// aparecía al 100 % pero seguía en "Pendiente"). Si se reabre una subtarea, el padre
// vuelve a abrirse. Devuelve el nuevo estado del padre, o null si no cambió.
async function _syncParentEstado(uid, parentId) {
  if (!parentId) return null;
  const { rows: [p] } = await pool.query(`SELECT id, estado FROM tasks WHERE id=$1 AND user_id=$2`, [parentId, uid]);
  if (!p) return null;
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE estado='completado')::int AS ok
       FROM tasks WHERE parent_task_id=$1 AND user_id=$2`, [parentId, uid]);
  if (!c.n) return null;
  const todas = c.ok === c.n;
  if (todas && p.estado !== 'completado') {
    await pool.query(`UPDATE tasks SET estado='completado', updated_at=NOW() WHERE id=$1`, [parentId]);
    return 'completado';
  }
  if (!todas && p.estado === 'completado') {
    await pool.query(`UPDATE tasks SET estado='en_progreso', updated_at=NOW() WHERE id=$1`, [parentId]);
    return 'en_progreso';
  }
  return null;
}

// ── PATCH /api/mgmt/tasks/:id/status ─────────────────────────────
app.patch('/api/mgmt/tasks/:id/status', requireAuth, async (req, res) => {
  const { estado } = req.body;
  const VALID = ['pendiente', 'en_progreso', 'bloqueado', 'completado'];
  if (!VALID.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET estado=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.workspaceOwnerId, estado]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    // Al mover una subtarea, el padre se pone al día (y viceversa si se reabre).
    const parentEstado = await _syncParentEstado(req.workspaceOwnerId, rows[0].parent_task_id);
    res.json({ ...rows[0], parent_estado: parentEstado, parent_id: rows[0].parent_task_id || null });
  } catch (err) {
    console.error('[tasks/status] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

// ── Dependencias entre tareas (ClickUp): :id ESPERA A depends_on_id ──
async function _taskWaitingOn(taskId) {
  const { rows } = await pool.query(
    `SELECT dt.id, dt.titulo, dt.estado
       FROM task_dependencies td JOIN tasks dt ON dt.id = td.depends_on_id
      WHERE td.task_id = $1 ORDER BY dt.titulo`, [taskId]);
  return rows;
}
// POST /api/mgmt/tasks/:id/deps  body { depends_on_id }
app.post('/api/mgmt/tasks/:id/deps', requireAuth, async (req, res) => {
  const taskId = +req.params.id, depId = +(req.body?.depends_on_id);
  if (!taskId || !depId || taskId === depId) return res.status(400).json({ error: 'Dependencia inválida' });
  try {
    const chk = await pool.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE id IN ($1,$2) AND user_id=$3`,
      [taskId, depId, req.workspaceOwnerId]);
    if (chk.rows[0].n !== 2) return res.status(404).json({ error: 'Tarea no encontrada' });
    const cyc = await pool.query(`SELECT 1 FROM task_dependencies WHERE task_id=$1 AND depends_on_id=$2`, [depId, taskId]);
    if (cyc.rows.length) return res.status(400).json({ error: 'Eso crearía una dependencia circular' });
    await pool.query(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1,$2)
                      ON CONFLICT (task_id, depends_on_id) DO NOTHING`, [taskId, depId]);
    res.status(201).json({ waiting_on: await _taskWaitingOn(taskId) });
  } catch (err) {
    console.error('[tasks/deps] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear dependencia' });
  }
});
// DELETE /api/mgmt/tasks/:id/deps/:depId
app.delete('/api/mgmt/tasks/:id/deps/:depId', requireAuth, async (req, res) => {
  try {
    const own = await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND user_id=$2`, [+req.params.id, req.workspaceOwnerId]);
    if (!own.rows.length) return res.status(404).json({ error: 'Tarea no encontrada' });
    await pool.query(`DELETE FROM task_dependencies WHERE task_id=$1 AND depends_on_id=$2`, [+req.params.id, +req.params.depId]);
    res.json({ waiting_on: await _taskWaitingOn(+req.params.id) });
  } catch (err) {
    console.error('[tasks/deps] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al quitar dependencia' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/estado-financiero ──────────────────
app.patch('/api/mgmt/tasks/:id/estado-financiero', requireAuth, async (req, res) => {
  const { estado_financiero } = req.body;
  const VALID = ['sin_revisar', 'por_conciliar', 'conciliado', 'facturable', 'facturado', 'cobro_pendiente', 'cobrado', 'observado'];
  if (!VALID.includes(estado_financiero)) return res.status(400).json({ error: 'Estado financiero inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET estado_financiero=$3, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING id, estado_financiero`,
      [req.params.id, req.workspaceOwnerId, estado_financiero]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/estado-financiero] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar estado financiero' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/deadline ───────────────────────────
app.patch('/api/mgmt/tasks/:id/deadline', requireAuth, async (req, res) => {
  const { deadline } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET deadline=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 RETURNING id, titulo, deadline`,
      [deadline || null, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/deadline] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar deadline' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/fecha-inicio (inicio del rango, tareas padre) ──
app.patch('/api/mgmt/tasks/:id/fecha-inicio', requireAuth, async (req, res) => {
  const { fecha_inicio } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET fecha_inicio=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 RETURNING id, titulo, fecha_inicio, deadline`,
      [fecha_inicio || null, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/fecha-inicio] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar fecha de inicio' });
  }
});

// Color del proyecto en el calendario. Lo elige la usuaria; si no hay, se calcula uno.
app.patch('/api/mgmt/projects/:id/color', requireAuth, async (req, res) => {
  const c = String(req.body?.color || '').trim();
  if (c && !/^#[0-9A-Fa-f]{6}$/.test(c)) return res.status(400).json({ error: 'Color inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE projects SET color=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id, color`,
      [c || null, req.params.id, req.workspaceOwnerId]);
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[projects/color] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al guardar el color' });
  }
});

// ── Excepciones del plan recurrente ──────────────────────────────────────────
// Mover el bloque de UN día ("solo este evento") sin tocar la semana entera.
// GET  ?desde=&hasta=  → las excepciones de esa ventana, para pintarlas en el calendario.
app.get('/api/mgmt/plan-overrides', requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT id, task_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, hora, minutos, skip
         FROM task_plan_overrides
        WHERE user_id=$1 ${desde ? 'AND fecha >= $2' : ''} ${hasta ? `AND fecha <= $${desde ? 3 : 2}` : ''}
        ORDER BY fecha`,
      [req.workspaceOwnerId, ...(desde ? [desde] : []), ...(hasta ? [hasta] : [])]
    );
    res.json(rows);
  } catch (err) {
    console.error('[plan-overrides] GET error:', err.message);
    res.status(500).json({ error: 'Error al leer las excepciones del plan' });
  }
});

// PUT → mueve (o salta) ese día concreto. Upsert por (tarea, fecha).
app.put('/api/mgmt/plan-overrides', requireAuth, async (req, res) => {
  const { task_id, fecha, hora, minutos, skip } = req.body;
  if (!task_id || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) {
    return res.status(400).json({ error: 'Falta la tarea o la fecha' });
  }
  try {
    const { rows: [t] } = await pool.query(`SELECT id FROM tasks WHERE id=$1 AND user_id=$2`, [task_id, req.workspaceOwnerId]);
    if (!t) return res.status(404).json({ error: 'Tarea no encontrada' });
    const h = (hora != null && hora !== '') ? Math.max(0, Math.min(23, Math.round(+hora))) : null;
    const m = (minutos != null && minutos !== '') ? Math.max(15, Math.min(1440, Math.round(+minutos))) : null;
    const { rows } = await pool.query(
      `INSERT INTO task_plan_overrides (user_id, task_id, fecha, hora, minutos, skip)
            VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (task_id, fecha)
       DO UPDATE SET hora=EXCLUDED.hora, minutos=EXCLUDED.minutos, skip=EXCLUDED.skip
       RETURNING id, task_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, hora, minutos, skip`,
      [req.workspaceOwnerId, task_id, fecha, h, m, !!skip]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[plan-overrides] PUT error:', err.message);
    res.status(500).json({ error: 'Error al mover el bloque' });
  }
});

// DELETE → vuelve al plan de la tarea para ese día.
app.delete('/api/mgmt/plan-overrides', requireAuth, async (req, res) => {
  const { task_id, fecha } = req.body || {};
  try {
    await pool.query(`DELETE FROM task_plan_overrides WHERE user_id=$1 AND task_id=$2 AND fecha=$3`,
      [req.workspaceOwnerId, task_id, fecha]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[plan-overrides] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al restaurar el plan' });
  }
});

// "Este y los siguientes": cambia la hora del plan a partir de una fecha. Para que el pasado
// no se mueva con él, antes de tocar el plan se clavan como excepciones los días ya ocurridos
// con la hora vieja (acotado a 60 días atrás: más lejos ya es historia que nadie mira).
app.put('/api/mgmt/tasks/:id/plan-hora-desde', requireAuth, async (req, res) => {
  const { fecha, hora, minutos } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return res.status(400).json({ error: 'Falta la fecha' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query(
      `SELECT id, plan_dias, plan_horas, plan_hora, TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS ini
         FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, req.workspaceOwnerId]);
    if (!t) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarea no encontrada' }); }

    const dias = String(t.plan_dias || '').split(',').map(s => +s.trim()).filter(n => n >= 0 && n <= 6);
    if (t.plan_hora != null && dias.length) {
      const desde = new Date(fecha + 'T00:00:00');
      const tope  = new Date(desde); tope.setDate(tope.getDate() - 60);
      let cur = t.ini ? new Date(t.ini + 'T00:00:00') : new Date(tope);
      if (cur < tope) cur = tope;
      for (; cur < desde; cur.setDate(cur.getDate() + 1)) {
        if (!dias.includes((cur.getDay() + 6) % 7)) continue;
        const ds = cur.toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO task_plan_overrides (user_id, task_id, fecha, hora, minutos)
                VALUES ($1,$2,$3,$4,NULL) ON CONFLICT (task_id, fecha) DO NOTHING`,
          [req.workspaceOwnerId, t.id, ds, t.plan_hora]);
      }
    }
    // A partir de esta fecha manda el plan nuevo: las excepciones futuras sobran.
    await client.query(`DELETE FROM task_plan_overrides WHERE user_id=$1 AND task_id=$2 AND fecha >= $3`,
      [req.workspaceOwnerId, t.id, fecha]);
    const h = (hora != null && hora !== '') ? Math.max(0, Math.min(23, Math.round(+hora))) : null;
    const { rows } = await client.query(
      `UPDATE tasks SET plan_hora=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3
       RETURNING id, titulo, plan_dias, plan_horas, plan_hora`, [h, t.id, req.workspaceOwnerId]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[plan-hora-desde] PUT error:', err.message);
    res.status(500).json({ error: 'Error al mover el plan' });
  } finally { client.release(); }
});

// ── PATCH /api/mgmt/tasks/:id/plan (plan de trabajo recurrente: días + meta horas + hora) ──
app.patch('/api/mgmt/tasks/:id/plan', requireAuth, async (req, res) => {
  const { plan_dias, plan_horas, plan_hora } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET plan_dias=$1, plan_horas=$2, plan_hora=$3, updated_at=NOW()
       WHERE id=$4 AND user_id=$5 RETURNING id, titulo, plan_dias, plan_horas, plan_hora`,
      [plan_dias || '',
       (plan_horas != null && plan_horas !== '') ? +plan_horas : null,
       (plan_hora != null && plan_hora !== '') ? +plan_hora : null,
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/plan] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar el plan' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/horario (programación en Calendario) ──
// prog_inicio = hora a la que planeo trabajarla · prog_min = duración · prog_fecha = día.
// NO toca deadline. Sin hora → limpia duración (vuelve al panel "Sin hora asignada").
app.patch('/api/mgmt/tasks/:id/horario', requireAuth, async (req, res) => {
  let { prog_fecha, prog_inicio, prog_min } = req.body;
  prog_fecha  = prog_fecha || null;
  prog_inicio = (prog_inicio && /^\d{1,2}:\d{2}/.test(prog_inicio)) ? String(prog_inicio).slice(0, 5) : null;
  prog_min    = (prog_inicio && prog_min != null && +prog_min > 0) ? Math.min(Math.round(+prog_min), 1440) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET prog_fecha=$1, prog_inicio=$2, prog_min=$3, updated_at=NOW()
       WHERE id=$4 AND user_id=$5 RETURNING id, titulo, prog_fecha, prog_inicio, prog_min`,
      [prog_fecha, prog_inicio, prog_min, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/horario] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al programar tarea' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/responsable ────────────────────────
app.patch('/api/mgmt/tasks/:id/responsable', requireAuth, async (req, res) => {
  const { responsable } = req.body;
  try {
    const respArr = responsable ? [responsable] : [];
    const { rows } = await pool.query(
      `UPDATE tasks SET responsable=$1, responsables=$2, updated_at=NOW()
       WHERE id=$3 AND user_id=$4 RETURNING id, titulo, responsable`,
      [responsable || '', respArr, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/responsable] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al asignar responsable' });
  }
});

// ── PATCH /api/mgmt/tasks/:id/billing ────────────────────────────
// Facturación por tarea. Independiente del tiempo registrado (Time Tracking) — editar aquí NUNCA toca time_entries.
// cobrado_fecha / en_cuenta_fecha (YYYY-MM-DD) permiten retro-datar cobros ("esto lo cobré la semana pasada").
app.patch('/api/mgmt/tasks/:id/billing', requireAuth, async (req, res) => {
  const { monto, cobrado, cobrado_fecha, en_cuenta, en_cuenta_fecha } = req.body;
  // Fecha "YYYY-MM-DD" → timestamp al mediodía UTC (evita corrimientos de día al agrupar en America/Bogota)
  const _midday = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d + 'T12:00:00Z' : null;
  try {
    const sets = [];
    const vals = [req.params.id, req.workspaceOwnerId];
    if (monto !== undefined) sets.push(`monto=$${vals.push(monto === null || monto === '' ? null : +monto)}`);
    if (cobrado !== undefined) {
      sets.push(`cobrado=$${vals.push(!!cobrado)}`);
      if (cobrado) sets.push(`cobrado_at=$${vals.push(_midday(cobrado_fecha) || new Date().toISOString())}`);
      else { sets.push('cobrado_at=NULL'); sets.push('en_cuenta=FALSE'); sets.push('en_cuenta_at=NULL'); }
    } else if (cobrado_fecha !== undefined) {
      // corregir solo la fecha de un cobro ya marcado
      const md = _midday(cobrado_fecha);
      if (md) sets.push(`cobrado_at=$${vals.push(md)}`);
    }
    if (en_cuenta !== undefined) {
      sets.push(`en_cuenta=$${vals.push(!!en_cuenta)}`);
      if (en_cuenta) sets.push(`en_cuenta_at=$${vals.push(_midday(en_cuenta_fecha) || new Date().toISOString())}`);
      else sets.push('en_cuenta_at=NULL');
    } else if (en_cuenta_fecha !== undefined) {
      const md = _midday(en_cuenta_fecha);
      if (md) sets.push(`en_cuenta_at=$${vals.push(md)}`);
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at=NOW()');
    const { rows } = await pool.query(
      `UPDATE tasks SET ${sets.join(',')} WHERE id=$1 AND user_id=$2 RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tasks/billing] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar facturación' });
  }
});

// ── Nomenclatura de las semanas de trabajo ──────────────────────────
// Título: "ABREV · 20–26 jul" (o "ABREV · 29 jun – 5 jul" si cruza de mes).
const _MES_AB = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const _STOPW = /^(de|del|la|el|los|las|y|para|con|por|the|of|for|and|to|a|an|in)$/i;
// Abreviatura automática: palabras cortas tal cual (B2B), largas a 3 letras (Adquisicion→ADQ).
function _abrevProyecto(nombre) {
  return String(nombre || '').replace(/[^\wáéíóúñÁÉÍÓÚÑ\s-]/gi, ' ')
    .split(/[\s-]+/).filter(w => w && !_STOPW.test(w)).slice(0, 3)
    .map(w => (w.length <= 4 ? w : w.slice(0, 3)).toUpperCase()).join(' ') || 'PROY';
}
// Lunes (0) y domingo (6) de la semana que contiene la fecha dada.
function _semanaDe(fechaStr) {
  const d = new Date(String(fechaStr).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  const dow = (d.getUTCDay() + 6) % 7;
  const lun = new Date(d); lun.setUTCDate(d.getUTCDate() - dow);
  const dom = new Date(lun); dom.setUTCDate(lun.getUTCDate() + 6);
  return { lun, dom };
}
function _tituloSemana(proyecto, fechaAncla) {
  const s = _semanaDe(fechaAncla); if (!s) return null;
  const ab = (proyecto.abrev || '').trim() || _abrevProyecto(proyecto.nombre);
  const rango = s.lun.getUTCMonth() === s.dom.getUTCMonth()
    ? `${s.lun.getUTCDate()}–${s.dom.getUTCDate()} ${_MES_AB[s.dom.getUTCMonth()]}`
    : `${s.lun.getUTCDate()} ${_MES_AB[s.lun.getUTCMonth()]} – ${s.dom.getUTCDate()} ${_MES_AB[s.dom.getUTCMonth()]}`;
  return `${ab} · ${rango}`;
}

// ── Semana de TRABAJO automática ────────────────────────────────────
// Crea la tarea contenedora de la semana heredando el plan (días/horas/hora) de la
// semana anterior del mismo proyecto. Idempotente por (project_id, semana_week).
async function _ensureWeeklyTaskCore(wid, ws) {
  // UNA sola tarea semanal por proyecto: es el contenedor del trabajo Y el cobro de esa
  // semana (así lo usa Jenny desde siempre). Se crea si el proyecto tiene la semana
  // automática o el cobro semanal; si hay precio_semanal, la tarea lleva el monto.
  const projs = (await pool.query(
    `SELECT id, nombre, abrev, responsable, responsables, precio_semanal, cobro_semanal,
            plan_dias, plan_horas, plan_hora, tipo_proyecto, tarifa_hora FROM projects
      WHERE user_id=$1 AND (semana_auto=TRUE OR cobro_semanal=TRUE) AND estado='activo'`, [wid])).rows;
  const s = _semanaDe(ws); if (!s) return { created: [], checked: 0 };
  const lunStr = s.lun.toISOString().slice(0, 10), domStr = s.dom.toISOString().slice(0, 10);
  const created = [];
  for (const p of projs) {
    // Idempotente por semana, mire billing_week o semana_week (evita duplicar con lo viejo).
    const ex = await pool.query(
      `SELECT id FROM tasks WHERE user_id=$1 AND project_id=$2 AND (semana_week=$3 OR billing_week=$3) LIMIT 1`,
      [wid, p.id, lunStr]);
    if (ex.rows.length) continue;
    // Plan: manda el del PROYECTO (se define una vez); si no tiene, se hereda de la
    // última semana que sí lo tenga.
    const prev = (p.plan_dias || '') !== ''
      ? { plan_dias: p.plan_dias, plan_horas: p.plan_horas, plan_hora: p.plan_hora }
      : ((await pool.query(
          `SELECT plan_dias, plan_horas, plan_hora FROM tasks
            WHERE user_id=$1 AND project_id=$2 AND parent_task_id IS NULL AND plan_dias <> ''
            ORDER BY COALESCE(fecha_inicio, deadline) DESC NULLS LAST LIMIT 1`, [wid, p.id])).rows[0] || {});
    const respArr = (p.responsables && p.responsables.length) ? p.responsables : (p.responsable ? [p.responsable] : []);
    // billing_week se llena también cuando el proyecto cobra por semana: así esta misma
    // tarea es la del cobro y no se crea otra aparte.
    const bw = p.cobro_semanal ? lunStr : null;
    // Monto de la semana. En contratos POR HORAS el importe es tarifa × meta de horas
    // (lo pactado), no un precio suelto: así el cobro refleja el contrato aunque las
    // horas trabajadas queden por debajo. Se puede ajustar a mano en Finanzas.
    const montoSemana = !p.cobro_semanal ? null
      : (p.tipo_proyecto === 'horas' && p.tarifa_hora > 0 && (prev.plan_horas || p.plan_horas) > 0)
        ? +(p.tarifa_hora * (prev.plan_horas || p.plan_horas)).toFixed(2)
        : (p.precio_semanal || null);
    const ins = await pool.query(
      `INSERT INTO tasks (user_id, project_id, titulo, estado, prioridad, responsable, responsables,
                          fecha_inicio, deadline, semana_week, billing_week, monto, plan_dias, plan_horas, plan_hora)
       VALUES ($1,$2,$3,'pendiente','media',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, titulo, project_id`,
      [wid, p.id, _tituloSemana(p, lunStr), respArr[0] || '', respArr, lunStr, domStr, lunStr,
       bw, montoSemana,
       prev.plan_dias || '', prev.plan_horas ?? null, prev.plan_hora ?? null]);
    created.push(ins.rows[0]);
  }
  return { created, checked: projs.length };
}

// POST /api/mgmt/tasks/ensure-weekly — respaldo del cron; lo dispara la vista de Tareas.
app.post('/api/mgmt/tasks/ensure-weekly', requireAuth, async (req, res) => {
  const ws = String((req.body || {}).week_start || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return res.status(400).json({ error: 'week_start (YYYY-MM-DD) requerido' });
  try {
    const r = await _ensureWeeklyTaskCore(req.workspaceOwnerId, ws);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[tasks/ensure-weekly]', err.message);
    res.status(500).json({ error: 'Error al crear la tarea semanal' });
  }
});

// POST /api/mgmt/tasks/rename-weeks — normaliza los títulos de las semanas ya existentes
// al formato "ABREV · fechas". dry=true devuelve el preview sin tocar nada.
app.post('/api/mgmt/tasks/rename-weeks', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const dry = !!(req.body || {}).dry;
  const soloProyecto = parseInt((req.body || {}).project_id) || null;
  try {
    const projs = (await pool.query(
      `SELECT id, nombre, abrev FROM projects WHERE user_id=$1 ${soloProyecto ? 'AND id=$2' : ''}`,
      soloProyecto ? [uid, soloProyecto] : [uid])).rows;
    const cambios = [];
    for (const p of projs) {
      const tks = (await pool.query(
        `SELECT id, titulo, fecha_inicio::text AS fi, deadline::text AS dl FROM tasks
          WHERE user_id=$1 AND project_id=$2 AND parent_task_id IS NULL AND titulo ~* '^\\s*semana\\s'
          ORDER BY COALESCE(fecha_inicio, deadline)`, [uid, p.id])).rows;
      for (const t of tks) {
        const ancla = t.fi || t.dl; if (!ancla) continue;
        const nuevo = _tituloSemana(p, ancla);
        if (!nuevo || nuevo === t.titulo) continue;
        cambios.push({ id: t.id, proyecto: p.nombre, antes: t.titulo, despues: nuevo });
        if (!dry) {
          const s = _semanaDe(ancla);
          await pool.query(`UPDATE tasks SET titulo=$1, semana_week=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4`,
            [nuevo, s.lun.toISOString().slice(0, 10), t.id, uid]);
        }
      }
    }
    res.json({ ok: true, dry, total: cambios.length, cambios });
  } catch (err) {
    console.error('[tasks/rename-weeks]', err.message);
    res.status(500).json({ error: 'Error al renombrar las semanas' });
  }
});

// ── Facturación semanal: creación de la tarea de cobro de la semana ─
// Idempotente por (project_id, billing_week=lunes). Título: "Cobro semanal · 20–24 jul".
// El cobro semanal ya NO crea una tarea aparte ("Cobro semanal · 20–24 jul"): rompía la
// nomenclatura y duplicaba la fila en Finanzas junto a la semana de trabajo. Ahora hay UNA
// sola tarea semanal ("ABREV · 20–26 jul") que lleva el monto — como se venía usando.
async function _ensureWeeklyCore(wid, ws) {
  return _ensureWeeklyTaskCore(wid, ws);
}

// POST /api/mgmt/billing/ensure-weekly — la vista de Facturación lo dispara al cargar (respaldo del cron)
app.post('/api/mgmt/billing/ensure-weekly', requireAuth, async (req, res) => {
  const ws = String((req.body || {}).week_start || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return res.status(400).json({ error: 'week_start (YYYY-MM-DD, lunes) requerido' });
  try {
    const r = await _ensureWeeklyCore(req.workspaceOwnerId, ws);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[billing/ensure-weekly]', err.message);
    res.status(500).json({ error: 'Error al crear las tareas semanales' });
  }
});

// ── Recurrencia MENSUAL/TRIMESTRAL del contenedor (recur_freq) ─────
// La cadencia SEMANAL (default de recur_freq, o sea TODOS los proyectos existentes)
// sigue 100% en _ensureWeeklyTaskCore arriba, sin tocar — billing_week/cobro_semanal
// viven ahí y no se mezclan con esto. Esto solo corre para proyectos que explícitamente
// eligieron recur_freq='monthly'|'quarterly' (opt-in, nadie lo tiene hoy).
function _anchorFor(freq, refDateStr) {
  const d = new Date(String(refDateStr).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  if (freq === 'monthly') {
    return {
      start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
      end:   new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
    };
  }
  if (freq === 'quarterly') {
    const q = Math.floor(d.getUTCMonth() / 3);
    return {
      start: new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)),
      end:   new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0)),
    };
  }
  const s = _semanaDe(refDateStr);
  return s ? { start: s.lun, end: s.dom } : null;
}
function _tituloPeriodo(proyecto, freq, anchor) {
  const ab = (proyecto.abrev || '').trim() || _abrevProyecto(proyecto.nombre);
  if (freq === 'monthly') return `${ab} · ${_MES_AB[anchor.start.getUTCMonth()]} ${anchor.start.getUTCFullYear()}`;
  const q = Math.floor(anchor.start.getUTCMonth() / 3) + 1;
  return `${ab} · T${q} ${anchor.start.getUTCFullYear()}`;
}
async function _ensureRecurringContainerCore(wid, freq, refDateStr) {
  if (freq === 'weekly') return { created: [], checked: 0 }; // ese caso lo cubre _ensureWeeklyTaskCore
  const anchor = _anchorFor(freq, refDateStr);
  if (!anchor) return { created: [], checked: 0 };
  const startStr = anchor.start.toISOString().slice(0, 10), endStr = anchor.end.toISOString().slice(0, 10);
  const projs = (await pool.query(
    `SELECT id, nombre, abrev, responsable, responsables, plan_dias, plan_horas, plan_hora
       FROM projects WHERE user_id=$1 AND semana_auto=TRUE AND recur_freq=$2 AND estado='activo'`,
    [wid, freq])).rows;
  const created = [];
  for (const p of projs) {
    const ex = await pool.query(
      `SELECT id FROM tasks WHERE user_id=$1 AND project_id=$2 AND parent_task_id IS NULL AND fecha_inicio=$3 LIMIT 1`,
      [wid, p.id, startStr]);
    if (ex.rows.length) continue;
    const respArr = (p.responsables && p.responsables.length) ? p.responsables : (p.responsable ? [p.responsable] : []);
    const ins = await pool.query(
      `INSERT INTO tasks (user_id, project_id, titulo, estado, prioridad, responsable, responsables,
                          fecha_inicio, deadline, plan_dias, plan_horas, plan_hora)
       VALUES ($1,$2,$3,'pendiente','media',$4,$5,$6,$7,$8,$9,$10) RETURNING id, titulo, project_id`,
      [wid, p.id, _tituloPeriodo(p, freq, anchor), respArr[0] || '', respArr, startStr, endStr,
       p.plan_dias || '', p.plan_horas ?? null, p.plan_hora ?? null]);
    created.push(ins.rows[0]);
  }
  return { created, checked: projs.length };
}

// ── Subtareas recurrentes (project_recur_subtasks) ──────────────────
// Antes solo existía "copiar subtareas de la semana anterior" (manual, TasksModule.
// copiarSemanaAnterior). Esto las genera solas, con SU PROPIA cadencia — puede ser
// semanal aunque el contenedor sea mensual, por ejemplo. Se anclan bajo el contenedor
// VIGENTE del proyecto (el que cubre la fecha de hoy); si no hay ninguno, se saltan
// (no hay dónde colgarlas).
async function _ensureRecurSubtasksCore(wid, freq, refDateStr) {
  const anchor = _anchorFor(freq, refDateStr);
  if (!anchor) return { created: [], checked: 0 };
  const startStr = anchor.start.toISOString().slice(0, 10);
  const tpls = (await pool.query(
    `SELECT * FROM project_recur_subtasks WHERE user_id=$1 AND activo=TRUE AND freq=$2`, [wid, freq])).rows;
  const created = [];
  for (const t of tpls) {
    const ex = await pool.query(
      `SELECT id FROM tasks WHERE recur_template_id=$1 AND recur_anchor=$2 LIMIT 1`, [t.id, startStr]);
    if (ex.rows.length) continue;
    const cont = (await pool.query(
      `SELECT id, deadline FROM tasks WHERE user_id=$1 AND project_id=$2 AND parent_task_id IS NULL
         AND fecha_inicio<=$3 AND deadline>=$3 ORDER BY fecha_inicio DESC LIMIT 1`,
      [wid, t.project_id, refDateStr])).rows[0];
    if (!cont) continue;
    const respArr = (t.responsables && t.responsables.length) ? t.responsables : (t.responsable ? [t.responsable] : []);
    const ins = await pool.query(
      `INSERT INTO tasks (user_id, project_id, parent_task_id, titulo, descripcion, estado, prioridad,
                          responsable, responsables, deadline, recur_template_id, recur_anchor)
       VALUES ($1,$2,$3,$4,$5,'pendiente',$6,$7,$8,$9,$10,$11) RETURNING id, titulo, project_id`,
      [wid, t.project_id, cont.id, t.titulo, t.descripcion || '', t.prioridad || 'media',
       respArr[0] || '', respArr, cont.deadline, t.id, startStr]);
    created.push(ins.rows[0]);
  }
  return { created, checked: tpls.length };
}

// Cron: cada hora revisa (hora de Lima). El domingo ya crea la tarea de la SEMANA ENTRANTE
// ("todos los domingos pasada la medianoche"), y de lunes a sábado asegura la semana en curso.
async function _weeklyBillingTick() {
  try {
    const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // YYYY-MM-DD en Lima
    const d = new Date(ymd + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0=Dom
    const mon = new Date(d);
    if (dow === 0) mon.setUTCDate(d.getUTCDate() + 1);           // domingo → lunes de mañana
    else mon.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));       // resto → lunes de esta semana
    const ws = mon.toISOString().slice(0, 10);
    // UNA sola pasada: _ensureWeeklyTaskCore ya cubre los proyectos con semana automática
    // y los que cobran por semana (esa misma tarea lleva el monto).
    const owners = (await pool.query(
      `SELECT DISTINCT user_id FROM projects WHERE (semana_auto=TRUE OR cobro_semanal=TRUE) AND estado='activo'`)).rows;
    for (const o of owners) {
      const r = await _ensureWeeklyTaskCore(o.user_id, ws);
      if (r.created.length) console.log(`[semana-auto] user ${o.user_id}: ${r.created.length} semana(s) para ${ws} — ${r.created.map(x => x.titulo).join(', ')}`);
    }
    // Contenedores mensuales/trimestrales — opt-in, no toca nada de lo de arriba.
    for (const freq of ['monthly', 'quarterly']) {
      const owners2 = (await pool.query(
        `SELECT DISTINCT user_id FROM projects WHERE semana_auto=TRUE AND recur_freq=$1 AND estado='activo'`, [freq])).rows;
      for (const o of owners2) {
        const r = await _ensureRecurringContainerCore(o.user_id, freq, ymd);
        if (r.created.length) console.log(`[recur-${freq}] user ${o.user_id}: ${r.created.length} período(s) — ${r.created.map(x => x.titulo).join(', ')}`);
      }
    }
    // Subtareas recurrentes — independientes de la cadencia del contenedor.
    for (const freq of ['weekly', 'monthly', 'quarterly']) {
      const owners3 = (await pool.query(
        `SELECT DISTINCT user_id FROM project_recur_subtasks WHERE activo=TRUE AND freq=$1`, [freq])).rows;
      for (const o of owners3) {
        const r = await _ensureRecurSubtasksCore(o.user_id, freq, ymd);
        if (r.created.length) console.log(`[recur-sub-${freq}] user ${o.user_id}: ${r.created.length} subtarea(s)`);
      }
    }
  } catch (e) { console.error('[semana-auto]', e.message); }
}
setInterval(_weeklyBillingTick, 60 * 60 * 1000);
setTimeout(_weeklyBillingTick, 20 * 1000); // al arrancar (con margen para la migración)

// ── PATCH /api/mgmt/projects/:id/billing-cfg ──────────────────────
// Config de cobro del proyecto (endpoint dedicado: el PUT full-row NO toca estos campos).
// reparto: [{nombre, pct}] — proyecto compartido con % exacto (ej. 30-70); [] o null = 100% del responsable.
app.patch('/api/mgmt/projects/:id/billing-cfg', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const sets = [], vals = [req.params.id, req.workspaceOwnerId];
    if (b.cobro_semanal !== undefined) sets.push(`cobro_semanal=$${vals.push(!!b.cobro_semanal)}`);
    if (b.semana_auto !== undefined) sets.push(`semana_auto=$${vals.push(!!b.semana_auto)}`);
    if (b.abrev !== undefined) sets.push(`abrev=$${vals.push(String(b.abrev || '').trim().slice(0, 24))}`);
    // Plan de trabajo del proyecto (lo hereda cada semana que se crea)
    if (b.plan_dias !== undefined) sets.push(`plan_dias=$${vals.push(String(b.plan_dias || '').split(',').map(s => s.trim()).filter(s => /^[0-6]$/.test(s)).join(','))}`);
    if (b.plan_horas !== undefined) sets.push(`plan_horas=$${vals.push(b.plan_horas === null || b.plan_horas === '' ? null : +b.plan_horas)}`);
    if (b.plan_hora !== undefined) sets.push(`plan_hora=$${vals.push(b.plan_hora === null || b.plan_hora === '' ? null : Math.max(0, Math.min(23, parseInt(b.plan_hora))))}`);
    if (b.precio_semanal !== undefined) sets.push(`precio_semanal=$${vals.push(b.precio_semanal === null || b.precio_semanal === '' ? null : +b.precio_semanal)}`);
    if (b.recur_freq !== undefined) sets.push(`recur_freq=$${vals.push(['weekly', 'monthly', 'quarterly'].includes(b.recur_freq) ? b.recur_freq : 'weekly')}`);
    if (b.reparto !== undefined) {
      const rep = Array.isArray(b.reparto)
        ? b.reparto.map(r => ({ nombre: String(r.nombre || '').trim(), pct: Math.max(0, Math.min(100, +r.pct || 0)) })).filter(r => r.nombre)
        : [];
      sets.push(`reparto=$${vals.push(rep.length ? JSON.stringify(rep) : null)}`);
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at=NOW()');
    const { rows } = await pool.query(
      `UPDATE projects SET ${sets.join(',')} WHERE id=$1 AND user_id=$2 RETURNING id, cobro_semanal, precio_semanal, reparto, semana_auto, abrev, plan_dias, plan_horas, plan_hora, recur_freq`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[projects/billing-cfg]', err.message);
    res.status(500).json({ error: 'Error al guardar la configuración de cobro' });
  }
});

// ── Plantillas de subtareas recurrentes (project_recur_subtasks) ───
const _RECUR_FREQS = ['weekly', 'monthly', 'quarterly'];

app.get('/api/mgmt/projects/:id/recur-subtasks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM project_recur_subtasks WHERE project_id=$1 AND user_id=$2 ORDER BY orden, id`,
      [req.params.id, req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) {
    console.error('[recur-subtasks] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar las plantillas recurrentes' });
  }
});

app.post('/api/mgmt/projects/:id/recur-subtasks', requireAuth, async (req, res) => {
  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  if (!titulo) return res.status(400).json({ error: 'Título requerido' });
  const freq = _RECUR_FREQS.includes(b.freq) ? b.freq : 'weekly';
  const responsables = Array.isArray(b.responsables) ? b.responsables.filter(Boolean) : (b.responsable ? [b.responsable] : []);
  try {
    const { rows } = await pool.query(
      `INSERT INTO project_recur_subtasks (user_id, project_id, titulo, descripcion, prioridad, responsable, responsables, freq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.workspaceOwnerId, req.params.id, titulo, String(b.descripcion || ''), b.prioridad || 'media',
       responsables[0] || '', responsables, freq]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[recur-subtasks] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear la plantilla recurrente' });
  }
});

app.put('/api/mgmt/recur-subtasks/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  if (!titulo) return res.status(400).json({ error: 'Título requerido' });
  const freq = _RECUR_FREQS.includes(b.freq) ? b.freq : 'weekly';
  const responsables = Array.isArray(b.responsables) ? b.responsables.filter(Boolean) : (b.responsable ? [b.responsable] : []);
  try {
    const { rows } = await pool.query(
      `UPDATE project_recur_subtasks SET titulo=$1, descripcion=$2, prioridad=$3, responsable=$4, responsables=$5, freq=$6
        WHERE id=$7 AND user_id=$8 RETURNING *`,
      [titulo, String(b.descripcion || ''), b.prioridad || 'media', responsables[0] || '', responsables, freq,
       req.params.id, req.workspaceOwnerId]);
    if (!rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[recur-subtasks] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar la plantilla recurrente' });
  }
});

app.patch('/api/mgmt/recur-subtasks/:id/activo', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE project_recur_subtasks SET activo=$1 WHERE id=$2 AND user_id=$3 RETURNING *`,
      [!!(req.body || {}).activo, req.params.id, req.workspaceOwnerId]);
    if (!rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[recur-subtasks/activo] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar la plantilla' });
  }
});

app.delete('/api/mgmt/recur-subtasks/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM project_recur_subtasks WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[recur-subtasks] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar la plantilla' });
  }
});

// Backfill manual — no esperar el cron cada hora al recién crear una plantilla.
app.post('/api/mgmt/projects/:id/recur-subtasks/:tid/generar-ahora', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM project_recur_subtasks WHERE id=$1 AND project_id=$2 AND user_id=$3`,
      [req.params.tid, req.params.id, req.workspaceOwnerId]);
    const tpl = rows[0];
    if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    await _ensureRecurSubtasksCore(req.workspaceOwnerId, tpl.freq, ymd);
    const anchor = _anchorFor(tpl.freq, ymd);
    const startStr = anchor ? anchor.start.toISOString().slice(0, 10) : null;
    const chk = await pool.query(
      `SELECT id, titulo FROM tasks WHERE recur_template_id=$1 AND recur_anchor=$2 LIMIT 1`, [tpl.id, startStr]);
    if (chk.rows[0]) return res.json({ ok: true, creada: chk.rows[0] });
    return res.json({ ok: true, creada: null, aviso: 'No hay una tarea contenedora vigente en este proyecto para este período — activa "Trabajo semanal/mensual/trimestral" primero.' });
  } catch (err) {
    console.error('[recur-subtasks/generar-ahora] error:', err.message);
    res.status(500).json({ error: 'Error al generar la subtarea' });
  }
});

// ── DELETE /api/mgmt/tasks/:id ────────────────────────────────────
app.delete('/api/mgmt/tasks/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/tasks] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar tarea' });
  }
});

// =================================================================
// MANAGEMENT — MEETINGS
// =================================================================

// ── GET /api/mgmt/meetings ────────────────────────────────────────
app.get('/api/mgmt/meetings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM meetings WHERE user_id=$1 ORDER BY fecha ASC, hora_inicio ASC NULLS LAST`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/mgmt/meetings ───────────────────────────────────────
app.post('/api/mgmt/meetings', requireAuth, async (req, res) => {
  const { titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado, recordatorio_min } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO meetings (user_id, titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado, recordatorio_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.workspaceOwnerId, titulo||'', fecha,
       hora_inicio||null, hora_fin||null,
       descripcion||'', link||'',
       JSON.stringify(Array.isArray(attendees) ? attendees : []),
       estado||'programada', recordatorio_min || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/mgmt/meetings/:id ────────────────────────────────────
app.put('/api/mgmt/meetings/:id', requireAuth, async (req, res) => {
  const { titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado, recordatorio_min } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE meetings
       SET titulo=$1, fecha=$2, hora_inicio=$3, hora_fin=$4,
           descripcion=$5, link=$6, attendees=$7, estado=$8, recordatorio_min=$9,
           recordatorio_enviado=FALSE
       WHERE id=$10 AND user_id=$11 RETURNING *`,
      [titulo||'', fecha,
       hora_inicio||null, hora_fin||null,
       descripcion||'', link||'',
       JSON.stringify(Array.isArray(attendees) ? attendees : []),
       estado||'programada', recordatorio_min || null,
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/mgmt/meetings/:id ─────────────────────────────────
app.delete('/api/mgmt/meetings/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM meetings WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================================================================
// MANAGEMENT — TIME OFF
// =================================================================

// ── GET /api/mgmt/time-off ────────────────────────────────────────
app.get('/api/mgmt/time-off', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, tm.nombre AS member_nombre, tm.cargo AS member_cargo
       FROM   time_off t
       JOIN   team_members tm ON tm.id = t.member_id
       WHERE  t.user_id = $1
       ORDER  BY t.fecha_inicio ASC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/mgmt/time-off ───────────────────────────────────────
app.post('/api/mgmt/time-off', requireAuth, async (req, res) => {
  const { member_id, fecha_inicio, fecha_fin, motivo, notas } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO time_off (user_id, member_id, fecha_inicio, fecha_fin, motivo, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceOwnerId, member_id, fecha_inicio, fecha_fin,
       motivo || 'Vacaciones', notas || '']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/mgmt/time-off/:id ────────────────────────────────────
app.put('/api/mgmt/time-off/:id', requireAuth, async (req, res) => {
  const { member_id, fecha_inicio, fecha_fin, motivo, notas } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE time_off
       SET member_id=$1, fecha_inicio=$2, fecha_fin=$3, motivo=$4, notas=$5
       WHERE id=$6 AND user_id=$7 RETURNING *`,
      [member_id, fecha_inicio, fecha_fin,
       motivo || 'Vacaciones', notas || '',
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/mgmt/time-off/:id ─────────────────────────────────
app.delete('/api/mgmt/time-off/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM time_off WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================================================================
// MANAGEMENT — TEAM
// =================================================================

// ── GET /api/mgmt/team ────────────────────────────────────────────
app.get('/api/mgmt/team', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT tm.*,
             COUNT(t.id) FILTER (WHERE t.estado != 'completado') AS tareas_activas,
             COUNT(t.id)                                          AS tareas_total
      FROM   team_members tm
      LEFT JOIN tasks t ON LOWER(TRIM(t.responsable)) = LOWER(TRIM(tm.nombre))
                        AND t.user_id = $1
      WHERE  tm.user_id = $1
      GROUP  BY tm.id
      ORDER  BY LOWER(tm.nombre)
    `, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/team] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar equipo' });
  }
});

// ── POST /api/mgmt/team ───────────────────────────────────────────
app.post('/api/mgmt/team', requireAuth, async (req, res) => {
  const { nombre, email, rol, cargo, estado, notas } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO team_members (user_id, nombre, email, rol, cargo, estado, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req.workspaceOwnerId, nombre.trim(), email || '', rol || 'miembro', cargo || '', estado || 'activo', notas || '']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/team] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear miembro' });
  }
});

// ── PUT /api/mgmt/team/:id ────────────────────────────────────────
app.put('/api/mgmt/team/:id', requireAuth, async (req, res) => {
  const { nombre, email, rol, cargo, estado, notas } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      UPDATE team_members
      SET nombre=$1, email=$2, rol=$3, cargo=$4, estado=$5, notas=$6, updated_at=NOW()
      WHERE id=$7 AND user_id=$8 RETURNING *
    `, [nombre.trim(), email || '', rol || 'miembro', cargo || '', estado || 'activo', notas || '', req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Miembro no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/team] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar miembro' });
  }
});

// ── DELETE /api/mgmt/team/:id ─────────────────────────────────────
app.delete('/api/mgmt/team/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM team_members WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Miembro no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/team] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar miembro' });
  }
});

// =================================================================
// LEADS — LEAD MANAGER
// =================================================================

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[leads] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar leads' });
  }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  const { nombre, empresa, email, telefono, pais, cargo, stage, fuente, valor_estimado, notas, outbound_client_id, campaign_id } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO leads (user_id,nombre,empresa,email,telefono,pais,cargo,stage,fuente,valor_estimado,notas,outbound_client_id,campaign_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.workspaceOwnerId, nombre.trim(), empresa||'', email||'', telefono||'', pais||'', cargo||'',
        stage||'nuevo', fuente||'manual', valor_estimado||null, notas||'', outbound_client_id||null, campaign_id||null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[leads] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear lead' });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  const { nombre, empresa, email, telefono, pais, cargo, stage, fuente, valor_estimado, notas, outbound_client_id, campaign_id } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      UPDATE leads SET nombre=$1,empresa=$2,email=$3,telefono=$4,pais=$5,cargo=$6,
        stage=$7,fuente=$8,valor_estimado=$9,notas=$10,outbound_client_id=$11,campaign_id=$12,updated_at=NOW()
      WHERE id=$13 AND user_id=$14 RETURNING *
    `, [nombre.trim(), empresa||'', email||'', telefono||'', pais||'', cargo||'',
        stage||'nuevo', fuente||'manual', valor_estimado||null, notas||'', outbound_client_id||null, campaign_id||null,
        req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Lead no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[leads] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar lead' });
  }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM leads WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Lead no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[leads] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar lead' });
  }
});

app.post('/api/leads/:id/convert', requireAuth, async (req, res) => {
  try {
    const { rows: lr } = await pool.query(
      `SELECT * FROM leads WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]
    );
    if (!lr.length) return res.status(404).json({ error: 'Lead no encontrado' });
    const l = lr[0];
    const { rows: cr } = await pool.query(`
      INSERT INTO clients (user_id,nombre,empresa,email,telefono,pais,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req.workspaceOwnerId, l.nombre, l.empresa, l.email, l.telefono, l.pais, l.notas]);
    await pool.query(`UPDATE leads SET stage='ganado',updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ client: cr[0] });
  } catch (err) {
    console.error('[leads] convert error:', err.message);
    res.status(500).json({ error: 'Error al convertir lead' });
  }
});

// =================================================================
// LEAD MANAGER — OUTBOUND CLIENTS (unidad principal del módulo)
// =================================================================
const OBC_ESTADOS = ['preparacion', 'activo', 'pausado', 'cerrado'];

app.get('/api/outbound-clients', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM outbound_clients WHERE user_id=$1 ORDER BY created_at DESC`, [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[obc] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar clientes outbound' });
  }
});

app.post('/api/outbound-clients', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = OBC_ESTADOS.includes(b.estado) ? b.estado : 'preparacion';
  try {
    const { rows } = await pool.query(`
      INSERT INTO outbound_clients (user_id,nombre,estado,responsable,canal,website,mercado,icp,proxima_accion,notas,from_email,cc_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [req.workspaceOwnerId, b.nombre.trim(), estado, b.responsable||'', b.canal||'', b.website||'',
        b.mercado||'', b.icp||'', b.proxima_accion||'', b.notas||'', _lmS(b.from_email), _lmS(b.cc_email)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[obc] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear cliente outbound' });
  }
});

app.put('/api/outbound-clients/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = OBC_ESTADOS.includes(b.estado) ? b.estado : 'preparacion';
  try {
    const { rows } = await pool.query(`
      UPDATE outbound_clients SET nombre=$1,estado=$2,responsable=$3,canal=$4,website=$5,
        mercado=$6,icp=$7,proxima_accion=$8,notas=$9,from_email=$10,cc_email=$11,updated_at=NOW()
      WHERE id=$12 AND user_id=$13 RETURNING *
    `, [b.nombre.trim(), estado, b.responsable||'', b.canal||'', b.website||'',
        b.mercado||'', b.icp||'', b.proxima_accion||'', b.notas||'', _lmS(b.from_email), _lmS(b.cc_email), req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente outbound no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[obc] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar cliente outbound' });
  }
});

app.delete('/api/outbound-clients/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM outbound_clients WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Cliente outbound no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[obc] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar cliente outbound' });
  }
});

// =================================================================
// LEAD MANAGER — EMPRESAS + CONTACTOS (directorio importable estilo Apollo/HubSpot)
// =================================================================
function _lmS(v) { return (v == null ? '' : String(v)).trim(); }
function _lmNormDomain(raw) {
  let s = _lmS(raw).toLowerCase();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop();               // email → dominio
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split(/[\/?#]/)[0].trim();
  return s;
}

// ── Empresas (lm_companies) ────────────────────────────────────────
const LM_CUSTOM_KEYS = Array.from({ length: 10 }, (_, i) => `campo${i + 1}`);
const LM_CO_COLS = ['nombre','dominio','website','industria','tamano','ingresos','telefono','linkedin','linkedin_sales_nav','ciudad','region','pais','fundada','direccion','codigo_postal','descripcion','tecnologias','funding','target_tier','segmento','analisis','notas', ...LM_CUSTOM_KEYS];
app.get('/api/lm/companies', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM lm_contacts k WHERE k.company_id = c.id)::int AS contact_count
      FROM lm_companies c WHERE c.user_id=$1 ORDER BY c.nombre ASC, c.id DESC
    `, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[lm-co] GET', err.message); res.status(500).json({ error: 'Error al cargar empresas' }); }
});
app.post('/api/lm/companies', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!_lmS(b.nombre) && !_lmS(b.dominio)) return res.status(400).json({ error: 'Nombre o dominio requerido' });
  try {
    const vals = LM_CO_COLS.map(k => k === 'dominio' ? _lmNormDomain(b.dominio) : _lmS(b[k]));
    const { rows } = await pool.query(`
      INSERT INTO lm_companies (user_id,${LM_CO_COLS.join(',')},outbound_client_id)
      VALUES ($1,${LM_CO_COLS.map((_, i) => '$' + (i + 2)).join(',')},$${LM_CO_COLS.length + 2}) RETURNING *
    `, [req.workspaceOwnerId, ...vals, b.outbound_client_id || null]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[lm-co] POST', err.message); res.status(500).json({ error: 'Error al crear empresa' }); }
});
app.put('/api/lm/companies/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const vals = LM_CO_COLS.map(k => k === 'dominio' ? _lmNormDomain(b.dominio) : _lmS(b[k]));
    const set = LM_CO_COLS.map((k, i) => `${k}=$${i + 1}`).join(',');
    const { rows } = await pool.query(`
      UPDATE lm_companies SET ${set}, outbound_client_id=$${LM_CO_COLS.length + 1}, updated_at=NOW()
      WHERE id=$${LM_CO_COLS.length + 2} AND user_id=$${LM_CO_COLS.length + 3} RETURNING *
    `, [...vals, b.outbound_client_id || null, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    // El nombre de empresa vive duplicado en lm_contacts.empresa_nombre (snapshot de import) —
    // sin esto, editar el nombre acá dejaba desincronizados a sus contactos.
    if (_lmS(b.nombre)) await pool.query(`UPDATE lm_contacts SET empresa_nombre=$1, updated_at=NOW() WHERE user_id=$2 AND company_id=$3`, [_lmS(b.nombre), req.workspaceOwnerId, req.params.id]);
    res.json(rows[0]);
  } catch (err) { console.error('[lm-co] PUT', err.message); res.status(500).json({ error: 'Error al actualizar empresa' }); }
});
app.delete('/api/lm/companies/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_companies WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json({ ok: true });
  } catch (err) { console.error('[lm-co] DELETE', err.message); res.status(500).json({ error: 'Error al eliminar empresa' }); }
});
// Borrado en lote de empresas (1 request → evita el rate-limit). with_contacts=true también borra sus contactos.
app.post('/api/lm/companies/bulk-delete', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const withContacts = (req.body || {}).with_contacts === true || (req.body || {}).with_contacts === 'true';
  if (!ids.length) return res.status(400).json({ error: 'Sin empresas seleccionadas' });
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    let contactsDeleted = 0;
    if (withContacts) {
      const r = await cl.query(`DELETE FROM lm_contacts WHERE user_id=$1 AND company_id = ANY($2::int[])`, [uid, ids]);
      contactsDeleted = r.rowCount;
    } else {
      // desligar contactos para que no bloquee la FK
      await cl.query(`UPDATE lm_contacts SET company_id=NULL WHERE user_id=$1 AND company_id = ANY($2::int[])`, [uid, ids]);
    }
    const d = await cl.query(`DELETE FROM lm_companies WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, ids]);
    await cl.query('COMMIT');
    res.json({ deleted: d.rowCount, contactsDeleted, requested: ids.length });
  } catch (err) { await cl.query('ROLLBACK').catch(() => {}); console.error('[lm-co] BULK', err.message); res.status(500).json({ error: 'Error al eliminar empresas' }); }
  finally { cl.release(); }
});

// ── Campos personalizados (Field 1..10 renombrables, Empresas/Contactos) ──
// Un slot solo "existe" para el usuario si tiene label — el front filtra por eso.
app.get('/api/lm/custom-fields', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT entity, field_key, label FROM lm_custom_field_labels WHERE user_id=$1`, [req.workspaceOwnerId]);
    const byKey = new Map(rows.map(r => [r.entity + ':' + r.field_key, r.label]));
    const build = entity => LM_CUSTOM_KEYS.map(k => ({ entity, field_key: k, label: byKey.get(entity + ':' + k) || '' }));
    res.json({ company: build('company'), contact: build('contact') });
  } catch (err) { console.error('[lm-cf] GET', err.message); res.status(500).json({ error: 'Error al cargar campos personalizados' }); }
});
app.put('/api/lm/custom-fields', requireAuth, async (req, res) => {
  const entity = String((req.body || {}).entity || '');
  const fieldKey = String((req.body || {}).field_key || '');
  const label = _lmS((req.body || {}).label);
  if (!['company', 'contact'].includes(entity)) return res.status(400).json({ error: 'Entidad inválida' });
  if (!LM_CUSTOM_KEYS.includes(fieldKey)) return res.status(400).json({ error: 'Campo inválido' });
  try {
    await pool.query(`
      INSERT INTO lm_custom_field_labels (user_id, entity, field_key, label) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, entity, field_key) DO UPDATE SET label=$4
    `, [req.workspaceOwnerId, entity, fieldKey, label]);
    res.json({ ok: true });
  } catch (err) { console.error('[lm-cf] PUT', err.message); res.status(500).json({ error: 'Error al guardar' }); }
});

// ── Limpiar en bloque (Enriquecimiento → Datos) ──
// Modo preview (default): calcula qué cambiaría sin escribir nada. apply:true sí escribe.
// Si se limpia el nombre de una empresa, sincroniza lm_contacts.empresa_nombre (duplicado
// plano) de sus contactos para que no quede desincronizado en ningún lado.
app.post('/api/lm/bulk-clean', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const b = req.body || {};
  const entity = b.entity === 'companies' ? 'companies' : (b.entity === 'contacts' ? 'contacts' : '');
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  const { cleanableFields, cleanValue } = require('./services/dataCleanService');
  const allowed = cleanableFields(entity);
  const fields = (Array.isArray(b.fields) ? b.fields : []).filter(f => allowed.includes(f));
  const apply = !!b.apply;
  if (!entity) return res.status(400).json({ error: 'Entidad inválida' });
  if (!ids.length) return res.status(400).json({ error: 'Sin filas seleccionadas' });
  if (!fields.length) return res.status(400).json({ error: 'Sin campos para limpiar' });
  const table = entity === 'companies' ? 'lm_companies' : 'lm_contacts';
  try {
    const { rows } = await pool.query(
      `SELECT id, ${fields.join(',')} FROM ${table} WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, ids]);
    const changes = [];
    for (const row of rows) {
      for (const field of fields) {
        const before = row[field] == null ? '' : String(row[field]);
        const after = cleanValue(entity, field, before);
        if (after !== before) changes.push({ id: row.id, campo: field, antes: before, despues: after });
      }
    }
    if (!apply) return res.json({ preview: true, changes });
    let syncedNames = 0;
    for (const ch of changes) {
      await pool.query(`UPDATE ${table} SET ${ch.campo}=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [ch.despues, ch.id, uid]);
      if (entity === 'companies' && ch.campo === 'nombre') {
        const r = await pool.query(`UPDATE lm_contacts SET empresa_nombre=$1, updated_at=NOW() WHERE user_id=$2 AND company_id=$3`, [ch.despues, uid, ch.id]);
        syncedNames += r.rowCount;
      }
    }
    res.json({ preview: false, applied: changes.length, syncedNames, changes });
  } catch (err) { console.error('[lm-clean]', err.message); res.status(500).json({ error: 'Error al limpiar' }); }
});

// ── Cola de empresas ("empresa primero", estilo LinkedIn Sales Navigator) ──
// Puente entre "ya califiqué la empresa" y "ya tengo a la persona": lm_company_sequences
// SIEMPRE representa "falta encontrar al decisor en LinkedIn". Al agregar el contacto
// encontrado (endpoint /convert) el contacto arranca en **Paso 1** del pipeline normal:
// encontrar al decisor no es hacer el Paso 1, solo desbloquearlo. Así la secuencia puede
// empezar con cualquier acción (comentar una publicación, invitación, lo que sea) y el
// contacto nuevo la recibe sin re-enrolar nada.
app.post('/api/lm/companies/bulk-enroll', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const b = req.body || {};
  const ids = Array.isArray(b.company_ids) ? b.company_ids.map(Number).filter(Boolean) : [];
  const seqId = parseInt(b.sequence_id);
  if (!ids.length) return res.status(400).json({ error: 'Sin empresas seleccionadas' });
  if (!seqId) return res.status(400).json({ error: 'Falta la secuencia' });
  try {
    const sq = (await pool.query(`SELECT drip_per_day, send_days, starts_on::text AS starts_on FROM sequences WHERE id=$1 AND user_id=$2`, [seqId, uid])).rows[0];
    if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
    if (await _seqHasDirectContacts(uid, seqId)) return res.status(400).json({ error: 'Esta secuencia ya tiene contactos enrolados directamente — no se puede usar como Empresa primero. Elige otra secuencia (o crea una nueva) para la cola de empresas.' });
    // Solo empresas del usuario que no estén ya en la cola de esta secuencia.
    const already = new Set((await pool.query(`SELECT company_id FROM lm_company_sequences WHERE user_id=$1 AND sequence_id=$2 AND company_id = ANY($3::int[])`, [uid, seqId, ids])).rows.map(r => r.company_id));
    const valid = new Set((await pool.query(`SELECT id FROM lm_companies WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, ids])).rows.map(r => r.id));
    const toAdd = ids.filter(id => valid.has(id) && !already.has(id));
    if (!toAdd.length) return res.json({ added: 0, requested: ids.length, spread_days: 0 });
    // ── Mismo "arranque escalonado · X por día" que ya usan los contactos (_lmAddMembership) ──
    const drip = Math.max(0, parseInt(sq.drip_per_day) || 0);
    const mask = _sanSendDays(sq.send_days);
    const usedByDate = {};
    (await pool.query(`SELECT due_date::text d, COUNT(*)::int n FROM lm_company_sequences WHERE user_id=$1 AND sequence_id=$2 AND due_date >= CURRENT_DATE GROUP BY due_date`, [uid, seqId]))
      .rows.forEach(r => { usedByDate[r.d] = r.n; });
    let base = _todayUTC();
    if (sq.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(sq.starts_on)) {
      const [y, mo, d] = sq.starts_on.split('-').map(Number);
      const so = new Date(Date.UTC(y, mo - 1, d));
      if (so > base) base = so;
    }
    const perDay = drip > 0 ? drip : Infinity;
    const dates = [];
    let slot = 0, cur = _nthAllowed(base, 0, mask), curStr = _ymd(cur), inDay = usedByDate[curStr] || 0;
    for (let i = 0; i < toAdd.length; i++) {
      while (inDay >= perDay) { slot++; cur = _nthAllowed(base, slot, mask); curStr = _ymd(cur); inDay = usedByDate[curStr] || 0; }
      dates.push(curStr); inDay++;
    }
    const r = await pool.query(`
      INSERT INTO lm_company_sequences (user_id, company_id, sequence_id, due_date)
      SELECT $1, t.cid, $2, t.sd::date
      FROM unnest($3::int[], $4::text[]) AS t(cid, sd)
      ON CONFLICT (company_id, sequence_id) DO NOTHING
    `, [uid, seqId, toAdd, dates]);
    res.json({ added: r.rowCount, requested: ids.length, spread_days: new Set(dates).size, per_day: drip });
  } catch (err) { console.error('[lm-co-seq] bulk-enroll', err.message); res.status(500).json({ error: 'Error al enrolar empresas' }); }
});
app.get('/api/lm/sequences/:id/pending-companies', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.id AS company_sequence_id, cs.estado, cs.created_at, cs.due_date::text AS due_date,
             c.id AS company_id, c.nombre, c.dominio, c.linkedin, c.linkedin_sales_nav, c.industria, c.tamano, c.pais, c.target_tier, c.segmento
        FROM lm_company_sequences cs JOIN lm_companies c ON c.id = cs.company_id
       WHERE cs.user_id=$1 AND cs.sequence_id=$2 AND cs.estado='pendiente'
       ORDER BY cs.due_date ASC NULLS LAST, cs.created_at ASC`, [req.workspaceOwnerId, req.params.id]);
    res.json(rows);
  } catch (err) { console.error('[lm-co-seq] pending', err.message); res.status(500).json({ error: 'Error al cargar empresas pendientes' }); }
});
// Conteo real por estado — el tab "Empresas" mostraba solo cs.estado='pendiente'
// (la cola de trabajo) como si fuera el total de empresas de la secuencia, lo que
// hacía parecer que el número no bajaba aunque ya se hubieran trabajado varias.
app.get('/api/lm/sequences/:id/companies-stats', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT estado, COUNT(*)::int AS n
        FROM lm_company_sequences
       WHERE user_id=$1 AND sequence_id=$2
       GROUP BY estado`, [req.workspaceOwnerId, req.params.id]);
    const out = { total: 0, pendiente: 0, trabajada: 0, descartada: 0 };
    for (const r of rows) { out[r.estado] = r.n; out.total += r.n; }
    res.json(out);
  } catch (err) { console.error('[lm-co-seq] companies-stats', err.message); res.status(500).json({ error: 'Error al cargar estadísticas de empresas' }); }
});
app.patch('/api/lm/company-sequences/:id', requireAuth, async (req, res) => {
  const estado = String((req.body || {}).estado || '');
  if (!['pendiente', 'trabajada', 'descartada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE lm_company_sequences SET estado=$1 WHERE id=$2 AND user_id=$3 RETURNING *`,
      [estado, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { console.error('[lm-co-seq] PATCH', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});
// role='primario' (default): ya se le mandó la invitación LinkedIn en esta misma acción
// → arranca YA en Paso 2, activo, con actividad registrada. role='secundario': persona de
// respaldo detectada en la misma empresa, se guarda linkeada pero SIN enrolar todavía —
// Jenny la activa a mano (flujo normal de "Enrolar contacto") si el primario no responde.
// Se puede llamar más de una vez por fila (agregar principal Y secundario) — solo se exige
// 'pendiente' la PRIMERA vez; de ahí en adelante solo se bloquea si ya la descartó.
// Agregar el contacto encontrado. Si es PRINCIPAL, además lo enrola en la secuencia en el
// Paso 1 mismo (activo, next_action_at=ahora) y saca la empresa de la cola — de ahí en
// adelante el contacto sigue el flujo normal de tareas (ficha del contacto + "✓ Hecha →
// siguiente", igual que cualquier otro paso), en vez de un botón aparte de "marcar hecho"
// aquí. Si es secundario, solo se crea el contacto — el modal se queda abierto.
app.post('/api/lm/company-sequences/:id/add-contact', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const b = req.body || {};
  const role = b.role === 'secundario' ? 'secundario' : 'primario';
  if (!_lmS(b.nombre) && !_lmS(b.apellido) && !_lmS(b.email)) return res.status(400).json({ error: 'Nombre o email requerido' });
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const cq = (await cl.query(
      `SELECT cs.id, cs.company_id, cs.sequence_id, cs.estado FROM lm_company_sequences cs WHERE cs.id=$1 AND cs.user_id=$2 FOR UPDATE`, [req.params.id, uid])).rows[0];
    if (!cq) { await cl.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
    if (cq.estado === 'descartada') { await cl.query('ROLLBACK'); return res.status(400).json({ error: 'Esta empresa está descartada — reactívala primero' }); }
    // Red de seguridad contra doble-clic/doble-envío: el FOR UPDATE de arriba ya serializa
    // solicitudes concurrentes para esta misma empresa — si la primera ya creó este mismo
    // LinkedIn, la segunda reusa ese contacto en vez de duplicarlo.
    const li = _lmS(b.linkedin);
    let contact = li ? (await cl.query(
      `SELECT * FROM lm_contacts WHERE user_id=$1 AND company_id=$2 AND linkedin=$3 LIMIT 1`, [uid, cq.company_id, li])).rows[0] : null;
    if (!contact) {
      // estado SIEMPRE 'nuevo' al crearlo — recién agregarlo no es "ya lo contacté", eso
      // pasa cuando de verdad se marca la tarea (Paso 1) como hecha. El resto del sistema
      // nunca mueve `estado` solo; es manual (igual que cualquier otro contacto).
      const vals = LM_CT_COLS.map(k =>
        k === 'estado' ? 'nuevo' :
        k === 'fuente' ? 'cola_empresas' :
        k === 'contact_priority' ? (role === 'primario' ? 'Primario' : 'Secundario') :
        _lmS(b[k]));
      const { rows: ctRows } = await cl.query(`
        INSERT INTO lm_contacts (user_id,${LM_CT_COLS.join(',')},company_id,outbound_client_id)
        VALUES ($1,${LM_CT_COLS.map((_, i) => '$' + (i + 2)).join(',')},$${LM_CT_COLS.length + 2},$${LM_CT_COLS.length + 3}) RETURNING *
      `, [uid, ...vals, cq.company_id, b.outbound_client_id || null]);
      contact = ctRows[0];
    }
    if (role === 'primario') {
      // Si ya había otro principal para esta empresa (ej. Jenny agrega dos candidatos como
      // principal en la misma visita, sin haber guardado todavía), lo desmarca y pausa su
      // enrolamiento — evita dos "principales" activos a la vez para una misma empresa.
      await cl.query(`UPDATE lm_contacts SET contact_priority='Secundario' WHERE user_id=$1 AND company_id=$2 AND contact_priority='Primario' AND id<>$3`, [uid, cq.company_id, contact.id]);
      await cl.query(`
        UPDATE lm_contact_sequences SET estado='pausado'
        WHERE user_id=$1 AND sequence_id=$2 AND estado='activo' AND contact_id IN (
          SELECT id FROM lm_contacts WHERE user_id=$1 AND company_id=$3 AND id<>$4
        )
      `, [uid, cq.sequence_id, cq.company_id, contact.id]);
      // paso=1 (NO paso 2): la tarea de verdad — enviar la invitación — todavía no está hecha,
      // solo se encontró al decisor. next_action_at=ahora para que aparezca de inmediato como
      // tarea vencida/hoy en su ficha.
      await cl.query(`
        INSERT INTO lm_contact_sequences (user_id, contact_id, sequence_id, paso, estado, start_date, paso_date, next_action_at)
        VALUES ($1,$2,$3,1,'activo',CURRENT_DATE,CURRENT_DATE,NOW())
        ON CONFLICT (contact_id, sequence_id) DO UPDATE SET estado='activo', next_action_at=NOW()
      `, [uid, contact.id, cq.sequence_id]);
      if (cq.estado === 'pendiente') await cl.query(`UPDATE lm_company_sequences SET estado='trabajada' WHERE id=$1`, [cq.id]);
    }
    await cl.query('COMMIT');
    if (b.auto_verify !== false && contact.email) {
      try { const { queueVerify } = require('./services/lmVerifyService'); queueVerify(pool, uid, [contact.id]); } catch (e) { console.warn('[lm-co-seq] auto-verify:', e.message); }
    }
    const nombreCompleto = [contact.nombre, contact.apellido].filter(Boolean).join(' ') || contact.email || `#${contact.id}`;
    res.status(201).json({ contact, nombre: nombreCompleto, role });
  } catch (err) { await cl.query('ROLLBACK').catch(() => {}); console.error('[lm-co-seq] add-contact', err.message); res.status(500).json({ error: 'Error al agregar el contacto' }); }
  finally { cl.release(); }
});
// Elegir como principal a un contacto que YA existe para esta empresa (ej. quedó de una
// sesión anterior, o vino de un import) — sin crear uno nuevo. Hace lo mismo que agregar
// como principal: lo marca Primario (y desmarca a cualquier otro que lo fuera), lo enrola
// en el Paso 1, y saca la empresa de la cola.
app.post('/api/lm/company-sequences/:id/select-primary', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const contactId = parseInt(req.body?.contact_id);
  if (!contactId) return res.status(400).json({ error: 'Falta el contacto' });
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const cq = (await cl.query(
      `SELECT cs.id, cs.company_id, cs.sequence_id, cs.estado FROM lm_company_sequences cs WHERE cs.id=$1 AND cs.user_id=$2 FOR UPDATE`, [req.params.id, uid])).rows[0];
    if (!cq) { await cl.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
    if (cq.estado === 'descartada') { await cl.query('ROLLBACK'); return res.status(400).json({ error: 'Esta empresa está descartada — reactívala primero' }); }
    const contact = (await cl.query(`SELECT id, nombre, apellido, email FROM lm_contacts WHERE id=$1 AND user_id=$2 AND company_id=$3`, [contactId, uid, cq.company_id])).rows[0];
    if (!contact) { await cl.query('ROLLBACK'); return res.status(404).json({ error: 'Contacto no encontrado en esta empresa' }); }
    await cl.query(`UPDATE lm_contacts SET contact_priority='Secundario' WHERE user_id=$1 AND company_id=$2 AND contact_priority='Primario' AND id<>$3`, [uid, cq.company_id, contact.id]);
    await cl.query(`UPDATE lm_contacts SET contact_priority='Primario' WHERE id=$1`, [contact.id]);
    // Si otro contacto de esta misma empresa ya había quedado activo en esta secuencia (ej.
    // se agregó primero como principal y Jenny cambió de opinión con la estrella antes de
    // Guardar), lo pausa — evita dos tareas activas "principales" a la vez para una empresa.
    await cl.query(`
      UPDATE lm_contact_sequences SET estado='pausado'
      WHERE user_id=$1 AND sequence_id=$2 AND estado='activo' AND contact_id IN (
        SELECT id FROM lm_contacts WHERE user_id=$1 AND company_id=$3 AND id<>$4
      )
    `, [uid, cq.sequence_id, cq.company_id, contact.id]);
    await cl.query(`
      INSERT INTO lm_contact_sequences (user_id, contact_id, sequence_id, paso, estado, start_date, paso_date, next_action_at)
      VALUES ($1,$2,$3,1,'activo',CURRENT_DATE,CURRENT_DATE,NOW())
      ON CONFLICT (contact_id, sequence_id) DO UPDATE SET estado='activo', next_action_at=NOW()
    `, [uid, contact.id, cq.sequence_id]);
    if (cq.estado === 'pendiente') await cl.query(`UPDATE lm_company_sequences SET estado='trabajada' WHERE id=$1`, [cq.id]);
    await cl.query('COMMIT');
    const nombreCompleto = [contact.nombre, contact.apellido].filter(Boolean).join(' ') || contact.email || `#${contact.id}`;
    res.json({ ok: true, contact_id: contact.id, nombre: nombreCompleto });
  } catch (err) { await cl.query('ROLLBACK').catch(() => {}); console.error('[lm-co-seq] select-primary', err.message); res.status(500).json({ error: 'Error al continuar' }); }
  finally { cl.release(); }
});

// ── Contactos (lm_contacts) ────────────────────────────────────────
const LM_CT_COLS = ['nombre','apellido','email','email_personal','telefono','movil','cargo','seniority','departamento','linkedin','empresa_nombre','ciudad','region','pais','estado','fuente','contact_priority','buyer_role','analisis','notas', ...LM_CUSTOM_KEYS];
app.get('/api/lm/contacts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT k.*, co.nombre AS company_nombre, co.dominio AS company_dominio,
        co.website AS company_website, co.industria AS company_industria, co.tamano AS company_tamano,
        co.ingresos AS company_ingresos, co.ciudad AS company_ciudad, co.pais AS company_pais, co.target_tier AS company_target_tier, co.segmento AS company_segmento,
        COALESCE((SELECT json_agg(json_build_object('id', s.id, 'nombre', s.nombre, 'paso', cs.paso, 'estado', cs.estado, 'enrolled_at', COALESCE((cs.start_date + TIME '12:00')::timestamptz, cs.created_at), 'paso_date', cs.paso_date::text, 'contact_sequence_id', cs.id, 'paused_reason', cs.paused_reason, 'next_action_at', cs.next_action_at) ORDER BY s.nombre)
                  FROM lm_contact_sequences cs JOIN sequences s ON s.id = cs.sequence_id
                  WHERE cs.contact_id = k.id), '[]') AS sequences,
        COALESCE((SELECT json_agg(json_build_object('id', cp.id, 'nombre', cp.nombre) ORDER BY cp.nombre)
                  FROM lm_contact_campaigns cc JOIN campaigns cp ON cp.id = cc.campaign_id
                  WHERE cc.contact_id = k.id), '[]') AS campaigns
      FROM lm_contacts k LEFT JOIN lm_companies co ON co.id = k.company_id
      WHERE k.user_id=$1 ORDER BY k.created_at DESC, k.id DESC
    `, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[lm-ct] GET', err.message); res.status(500).json({ error: 'Error al cargar contactos' }); }
});
app.post('/api/lm/contacts', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!_lmS(b.nombre) && !_lmS(b.apellido) && !_lmS(b.email)) return res.status(400).json({ error: 'Nombre o email requerido' });
  try {
    const vals = LM_CT_COLS.map(k => k === 'estado' ? (_lmS(b.estado) || 'nuevo') : k === 'fuente' ? (_lmS(b.fuente) || 'manual') : _lmS(b[k]));
    const { rows } = await pool.query(`
      INSERT INTO lm_contacts (user_id,${LM_CT_COLS.join(',')},company_id,outbound_client_id)
      VALUES ($1,${LM_CT_COLS.map((_, i) => '$' + (i + 2)).join(',')},$${LM_CT_COLS.length + 2},$${LM_CT_COLS.length + 3}) RETURNING *
    `, [req.workspaceOwnerId, ...vals, b.company_id || null, b.outbound_client_id || null]);
    // Auto-enriquecimiento: verificar (o buscar) el email en background, sin bloquear la respuesta.
    if (b.auto_verify !== false) {
      try {
        const { queueVerify } = require('./services/lmVerifyService');
        queueVerify(pool, req.workspaceOwnerId, [rows[0].id]);
      } catch (e) { console.warn('[lm-ct] auto-verify:', e.message); }
    }
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[lm-ct] POST', err.message); res.status(500).json({ error: 'Error al crear contacto' }); }
});
app.put('/api/lm/contacts/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const prev = (await pool.query(`SELECT email, data_issue FROM lm_contacts WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId])).rows[0];
    const vals = LM_CT_COLS.map(k => _lmS(b[k]));
    const set = LM_CT_COLS.map((k, i) => `${k}=$${i + 1}`).join(',');
    const { rows } = await pool.query(`
      UPDATE lm_contacts SET ${set}, company_id=$${LM_CT_COLS.length + 1}, outbound_client_id=$${LM_CT_COLS.length + 2}, updated_at=NOW()
      WHERE id=$${LM_CT_COLS.length + 3} AND user_id=$${LM_CT_COLS.length + 4} RETURNING *
    `, [...vals, b.company_id || null, b.outbound_client_id || null, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
    // Si el email CAMBIÓ (p. ej. corrigiendo uno que rebotó), el estado anterior deja de valer:
    // se resetea a "sin verificar" y se re-verifica en background.
    const oldE = String((prev && prev.email) || '').trim().toLowerCase();
    const newE = String(rows[0].email || '').trim().toLowerCase();
    if (oldE !== newE) {
      await pool.query(`UPDATE lm_contacts SET email_status='', email_score=NULL, email_verified_at=NULL WHERE id=$1`, [rows[0].id]);
      rows[0].email_status = ''; rows[0].email_score = null; rows[0].email_verified_at = null;
      if (newE && b.auto_verify !== false) {
        try { const { queueVerify } = require('./services/lmVerifyService'); queueVerify(pool, req.workspaceOwnerId, [rows[0].id]); } catch (e) { console.warn('[lm-ct] re-verify:', e.message); }
      }
    }
    // Auto-reanudar "Por corregir": si el dato que faltaba ya está, se limpia y reanuda su(s) secuencia(s).
    const di = prev && prev.data_issue;
    if (di === 'falta_email' && newE || di === 'falta_linkedin' && String(rows[0].linkedin || '').trim()) {
      await pool.query(`UPDATE lm_contacts SET data_issue='' WHERE id=$1`, [rows[0].id]);
      await pool.query(`UPDATE lm_contact_sequences SET estado='activo', paused_reason='' WHERE user_id=$1 AND contact_id=$2 AND estado='pausado' AND paused_reason LIKE 'dato_%'`, [req.workspaceOwnerId, rows[0].id]);
      rows[0].data_issue = '';
    }
    res.json(rows[0]);
  } catch (err) { console.error('[lm-ct] PUT', err.message); res.status(500).json({ error: 'Error al actualizar contacto' }); }
});
app.delete('/api/lm/contacts/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_contacts WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[lm-ct] DELETE', err.message); res.status(500).json({ error: 'Error al eliminar contacto' }); }
});
// Borrado en lote de contactos (1 request → evita el rate-limit). company_ids: empresas que quedan vacías y también se borran.
app.post('/api/lm/contacts/bulk-delete', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const ids     = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const coIds   = Array.isArray((req.body || {}).company_ids) ? req.body.company_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Sin contactos seleccionados' });
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const d = await cl.query(`DELETE FROM lm_contacts WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, ids]);
    let companiesDeleted = 0;
    if (coIds.length) {
      // solo borra las empresas que realmente quedaron sin ningún contacto
      const dc = await cl.query(
        `DELETE FROM lm_companies WHERE user_id=$1 AND id = ANY($2::int[])
           AND NOT EXISTS (SELECT 1 FROM lm_contacts k WHERE k.company_id = lm_companies.id)`,
        [uid, coIds]);
      companiesDeleted = dc.rowCount;
    }
    await cl.query('COMMIT');
    res.json({ deleted: d.rowCount, companiesDeleted, requested: ids.length });
  } catch (err) { await cl.query('ROLLBACK').catch(() => {}); console.error('[lm-ct] BULK', err.message); res.status(500).json({ error: 'Error al eliminar contactos' }); }
  finally { cl.release(); }
});

// ── Pertenencias en lote: añadir contactos a secuencia / campaña ──
// ── Días de cadencia permitidos (Lun→Dom, '1'=permitido) ──
function _sanSendDays(v) { const s = String(v || ''); return (/^[01]{7}$/.test(s) && s.includes('1')) ? s : '1111100'; }
function _sanHora(v) { const s = String(v || '').trim(); const m = s.match(/^(\d{1,2}):(\d{2})$/); if (!m) return ''; const h = +m[1], mi = +m[2]; return (h >= 0 && h < 24 && mi >= 0 && mi < 60) ? String(h).padStart(2, '0') + ':' + m[2] : ''; }
// Condición de rama de un paso: '' (todos) | 'replied' (respondió/aceptó) | 'no_reply' (no respondió).
function _sanCond(v) { return ['replied', 'no_reply'].includes(v) ? v : ''; }
// Acción del paso dentro del canal (invitación con/sin nota, mensaje, follow, comentario…)
function _sanAccion(v) { return ['invite_nota', 'invite', 'mensaje', 'follow', 'comentario', 'visita', 'llamada', 'voicemail'].includes(v) ? v : ''; }
// ── Pipeline automático del contacto (estilo Apollo) ──
// El estado avanza SOLO hacia adelante según la actividad: 1er paso completado → contactado;
// disposición respondió/reunión → respondio; no interesado/no contactar → perdido.
// Nunca retrocede ni saca a nadie de 'ganado' — lo manual (propuesta/negociación/ganado) manda.
const LM_STAGE_ORDER = ['nuevo', 'contactado', 'respondio', 'propuesta', 'negociacion', 'ganado', 'perdido'];
async function _lmAdvanceStage(uid, cid, target) {
  try {
    const cur = (await pool.query(`SELECT estado FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid])).rows[0];
    if (!cur || cur.estado === 'ganado') return null;
    const a = LM_STAGE_ORDER.indexOf(cur.estado || 'nuevo'), b = LM_STAGE_ORDER.indexOf(target);
    if (b < 0 || a >= b) return null;
    await pool.query(`UPDATE lm_contacts SET estado=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [target, cid, uid]);
    return target;
  } catch (e) { console.error('[lm-stage]', e.message); return null; }
}
function _sanDate(v) { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
// today (fecha local del server como UTC-midnight, para aritmética de días sin tz-shift)
function _todayUTC() { const t = new Date(); return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); }
// avanza una fecha (UTC-midnight) hasta caer en un día permitido por la máscara
function _rollFwd(d, mask) { const x = new Date(d.getTime()); for (let i = 0; i < 7; i++) { if (mask[(x.getUTCDay() + 6) % 7] === '1') return x; x.setUTCDate(x.getUTCDate() + 1); } return x; }
// el k-ésimo (0-based) día permitido a partir de 'start'
function _nthAllowed(start, k, mask) { let x = _rollFwd(start, mask); for (let c = 0; c < k; c++) { x.setUTCDate(x.getUTCDate() + 1); x = _rollFwd(x, mask); } return x; }
function _ymd(d) { return d.toISOString().slice(0, 10); }

// ── Modalidad de secuencia: "Empresa primero" (cola) y "Contacto directo" no se mezclan en
// la misma secuencia. Se infiere del uso real, sin campo nuevo: en cuanto una secuencia tiene
// un contacto enrolado directamente ya no admite empresas en cola, y viceversa. Los contactos
// creados vía cola de empresas (fuente='cola_empresas') no cuentan como "enrolamiento directo".
async function _seqHasDirectContacts(uid, sid) {
  return !!(await pool.query(`
    SELECT 1 FROM lm_contact_sequences cs JOIN lm_contacts c ON c.id = cs.contact_id
     WHERE cs.user_id=$1 AND cs.sequence_id=$2 AND COALESCE(c.fuente,'') <> 'cola_empresas' LIMIT 1
  `, [uid, sid])).rowCount;
}
async function _seqHasCompanyQueue(uid, sid) {
  return !!(await pool.query(`SELECT 1 FROM lm_company_sequences WHERE user_id=$1 AND sequence_id=$2 LIMIT 1`, [uid, sid])).rowCount;
}
async function _lmAddMembership(req, res, kind) {
  const uid = req.workspaceOwnerId;
  const b = req.body || {};
  const ids = Array.isArray(b.contact_ids) ? b.contact_ids.map(Number).filter(Boolean) : [];
  const targetId = parseInt(kind === 'sequence' ? b.sequence_id : b.campaign_id);
  if (!ids.length) return res.status(400).json({ error: 'Sin contactos seleccionados' });
  if (!targetId) return res.status(400).json({ error: 'Falta la ' + (kind === 'sequence' ? 'secuencia' : 'campaña') });
  const table  = kind === 'sequence' ? 'lm_contact_sequences' : 'lm_contact_campaigns';
  const col    = kind === 'sequence' ? 'sequence_id' : 'campaign_id';
  const parent = kind === 'sequence' ? 'sequences' : 'campaigns';
  try {
    const ok = (await pool.query(`SELECT 1 FROM ${parent} WHERE id=$1 AND user_id=$2`, [targetId, uid])).rowCount;
    if (!ok) return res.status(404).json({ error: (kind === 'sequence' ? 'Secuencia' : 'Campaña') + ' no encontrada' });
    if (kind === 'sequence' && await _seqHasCompanyQueue(uid, targetId)) {
      return res.status(400).json({ error: 'Esta secuencia está en modalidad Empresa primero — agrega contactos desde la pestaña Empresas (＋ Agregar contacto), no por enrolamiento directo.' });
    }
    if (kind !== 'sequence') {
      const r = await pool.query(`
        INSERT INTO ${table} (user_id, contact_id, ${col})
        SELECT $1, c.id, $2 FROM lm_contacts c WHERE c.user_id=$1 AND c.id = ANY($3::int[])
        ON CONFLICT (contact_id, ${col}) DO NOTHING
      `, [uid, targetId, ids]);
      return res.json({ added: r.rowCount, requested: ids.length });
    }
    // ── Secuencia: arranque escalonado (drip) + días de cadencia ──
    const sq = (await pool.query(`SELECT drip_per_day, send_days, starts_on::text AS starts_on FROM sequences WHERE id=$1 AND user_id=$2`, [targetId, uid])).rows[0] || {};
    const drip = Math.max(0, parseInt(sq.drip_per_day) || 0);
    const mask = _sanSendDays(sq.send_days);
    // Solo contactos que existen y que NO estén ya enrolados (para no gastar cupos ni reiniciar su reloj).
    const already = new Set((await pool.query(`SELECT contact_id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND contact_id = ANY($3::int[])`, [uid, targetId, ids])).rows.map(r => r.contact_id));
    const exist = new Set((await pool.query(`SELECT id FROM lm_contacts WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, ids])).rows.map(r => r.id));
    let toAdd = ids.filter(id => exist.has(id) && !already.has(id));
    if (!toAdd.length) return res.json({ added: 0, requested: ids.length, spread_days: 0 });

    // ── Regla outbound: 1 persona por empresa A LA VEZ ──
    // Omite contactos cuya empresa ya tiene OTRA persona activa en cualquier secuencia
    // (y duplicados de empresa dentro del mismo lote). body.force=true ignora la regla.
    const skipped = [];
    if (!b.force) {
      const info = (await pool.query(`SELECT id, company_id, nombre, apellido, empresa_nombre FROM lm_contacts WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, toAdd])).rows;
      const byId = new Map(info.map(c => [c.id, c]));
      const compIds = [...new Set(info.map(c => c.company_id).filter(Boolean))];
      const busy = new Map(); // company_id → nombre de la persona ya activa
      if (compIds.length) {
        (await pool.query(`
          SELECT DISTINCT ON (k.company_id) k.company_id, k.nombre, k.apellido
            FROM lm_contact_sequences cs JOIN lm_contacts k ON k.id = cs.contact_id
           WHERE cs.user_id=$1 AND cs.estado='activo' AND k.company_id = ANY($2::int[]) AND NOT (k.id = ANY($3::int[]))
        `, [uid, compIds, toAdd])).rows.forEach(r => busy.set(r.company_id, [r.nombre, r.apellido].filter(Boolean).join(' ') || '(sin nombre)'));
      }
      const seenComp = new Set();
      const pass = [];
      for (const id of toAdd) {
        const c = byId.get(id); const co = c && c.company_id;
        const nm = c ? ([c.nombre, c.apellido].filter(Boolean).join(' ') || '(sin nombre)') : String(id);
        if (co && busy.has(co)) { skipped.push({ id, nombre: nm, empresa: c.empresa_nombre || '', con: busy.get(co) }); continue; }
        if (co) { if (seenComp.has(co)) { skipped.push({ id, nombre: nm, empresa: c.empresa_nombre || '', con: 'otro contacto del mismo lote' }); continue; } seenComp.add(co); }
        pass.push(id);
      }
      toAdd = pass;
      if (!toAdd.length) return res.json({ added: 0, requested: ids.length, spread_days: 0, skipped_company: skipped });
    }

    // Cupos ya usados por fecha (para encadenar tandas sin pasar el límite/día permitido).
    const usedByDate = {};
    (await pool.query(`SELECT start_date::text d, COUNT(*)::int n FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND start_date >= CURRENT_DATE GROUP BY start_date`, [uid, targetId]))
      .rows.forEach(r => { usedByDate[r.d] = r.n; });
    // Base de arranque = hoy, o la fecha de inicio de la secuencia si es futura.
    let base = _todayUTC();
    if (sq.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(sq.starts_on)) {
      const [y, mo, d] = sq.starts_on.split('-').map(Number);
      const so = new Date(Date.UTC(y, mo - 1, d));
      if (so > base) base = so;
    }
    const perDay = drip > 0 ? drip : Infinity;
    const dates = [];
    let slot = 0, cur = _nthAllowed(base, 0, mask), curStr = _ymd(cur), inDay = usedByDate[curStr] || 0;
    for (let i = 0; i < toAdd.length; i++) {
      while (inDay >= perDay) { slot++; cur = _nthAllowed(base, slot, mask); curStr = _ymd(cur); inDay = usedByDate[curStr] || 0; }
      dates.push(curStr); inDay++;
    }
    // next_action_at = medianoche del día de arranque → el motor de envío toma los de hoy de inmediato y difiere los futuros.
    const r = await pool.query(`
      INSERT INTO ${table} (user_id, contact_id, ${col}, start_date, next_action_at)
      SELECT $1, t.cid, $2, t.sd::date, t.sd::timestamptz
      FROM unnest($3::int[], $4::text[]) AS t(cid, sd)
      ON CONFLICT (contact_id, ${col}) DO NOTHING
    `, [uid, targetId, toAdd, dates]);
    const spreadDays = new Set(dates).size;
    res.json({ added: r.rowCount, requested: ids.length, spread_days: spreadDays, per_day: drip, skipped_company: skipped });
  } catch (err) { console.error('[lm-mem]', err.message); res.status(500).json({ error: 'Error al añadir' }); }
}
// Re-ancla start_date/next_action_at de los enrolamientos que AÚN NO empiezan (paso 1,
// activos) con la cadencia/fecha/drip ACTUALES de la secuencia. Se llama solo al guardar
// la secuencia con cambios: sin esto, activar fines de semana DESPUÉS de enrolar dejaba
// las fechas viejas congeladas (ej. programado para el lunes aunque S/D ya estén permitidos).
async function _reanchorPendingEnrollments(uid, sid) {
  const sq = (await pool.query(`SELECT drip_per_day, send_days, starts_on::text AS starts_on FROM sequences WHERE id=$1 AND user_id=$2`, [sid, uid])).rows[0];
  if (!sq) return 0;
  const drip = Math.max(0, parseInt(sq.drip_per_day) || 0);
  const perDay = drip > 0 ? drip : Infinity;
  const mask = _sanSendDays(sq.send_days);
  const { rows: enrs } = await pool.query(
    `SELECT id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND estado='activo' AND paso=1
      ORDER BY start_date ASC NULLS FIRST, created_at ASC, id ASC`, [uid, sid]);
  if (!enrs.length) return 0;
  let base = _todayUTC();
  if (sq.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(sq.starts_on)) {
    const [y, mo, d] = sq.starts_on.split('-').map(Number);
    const so = new Date(Date.UTC(y, mo - 1, d));
    if (so > base) base = so;
  }
  const ids = [], dates = [];
  let slot = 0, cur = _nthAllowed(base, 0, mask), curStr = _ymd(cur), inDay = 0;
  for (const e of enrs) {
    while (inDay >= perDay) { slot++; cur = _nthAllowed(base, slot, mask); curStr = _ymd(cur); inDay = 0; }
    ids.push(e.id); dates.push(curStr); inDay++;
  }
  await pool.query(
    `UPDATE lm_contact_sequences cs SET start_date=t.sd::date, next_action_at=t.sd::timestamptz
      FROM unnest($1::int[],$2::text[]) AS t(id,sd) WHERE cs.id=t.id`, [ids, dates]);
  return ids.length;
}

// Reparte de nuevo los contactos AÚN SIN EMPEZAR (paso=1, activos) según drip_per_day y send_days.
// Útil cuando cambias el arranque escalonado DESPUÉS de haber enrolado (las fechas ya asignadas no se recalculan solas).
app.post('/api/lm/sequences/:id/redistribute', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, sid = parseInt(req.params.id);
  try {
    const sq = (await pool.query(`SELECT drip_per_day, send_days, starts_on::text AS starts_on FROM sequences WHERE id=$1 AND user_id=$2`, [sid, uid])).rows[0];
    if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
    const drip = Math.max(0, parseInt(sq.drip_per_day) || 0);
    if (!drip) return res.status(400).json({ error: 'Define primero “Arranque escalonado · X por día” en la secuencia' });
    const mask = _sanSendDays(sq.send_days);
    let base = _todayUTC();
    if (sq.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(sq.starts_on)) { const [y, mo, d] = sq.starts_on.split('-').map(Number); const so = new Date(Date.UTC(y, mo - 1, d)); if (so > base) base = so; }

    const allDates = new Set();
    const { rows: enrs } = await pool.query(`SELECT id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND estado='activo' AND paso=1 ORDER BY start_date ASC NULLS FIRST, created_at ASC, id ASC`, [uid, sid]);
    let updatedContacts = 0;
    if (enrs.length) {
      const ids = [], dates = [];
      let slot = 0, cur = _nthAllowed(base, 0, mask), curStr = _ymd(cur), inDay = 0;
      for (const e of enrs) {
        while (inDay >= drip) { slot++; cur = _nthAllowed(base, slot, mask); curStr = _ymd(cur); inDay = 0; }
        ids.push(e.id); dates.push(curStr); inDay++;
      }
      dates.forEach(d => allDates.add(d));
      await pool.query(`UPDATE lm_contact_sequences cs SET start_date=t.sd::date, next_action_at=t.sd::timestamptz FROM unnest($1::int[],$2::text[]) AS t(id,sd) WHERE cs.id=t.id`, [ids, dates]);
      updatedContacts = ids.length;
    }

    // Cola de empresas ("Empresa primero"): mismo reparto, pero sobre due_date de las pendientes.
    const { rows: coRows } = await pool.query(`SELECT id FROM lm_company_sequences WHERE user_id=$1 AND sequence_id=$2 AND estado='pendiente' ORDER BY due_date ASC NULLS FIRST, created_at ASC, id ASC`, [uid, sid]);
    let updatedCos = 0;
    if (coRows.length) {
      const ids2 = [], dates2 = [];
      let slot2 = 0, cur2 = _nthAllowed(base, 0, mask), curStr2 = _ymd(cur2), inDay2 = 0;
      for (const r2 of coRows) {
        while (inDay2 >= drip) { slot2++; cur2 = _nthAllowed(base, slot2, mask); curStr2 = _ymd(cur2); inDay2 = 0; }
        ids2.push(r2.id); dates2.push(curStr2); inDay2++;
      }
      dates2.forEach(d => allDates.add(d));
      await pool.query(`UPDATE lm_company_sequences cs SET due_date=t.sd::date FROM unnest($1::int[],$2::text[]) AS t(id,sd) WHERE cs.id=t.id`, [ids2, dates2]);
      updatedCos = ids2.length;
    }

    res.json({ updated: updatedContacts + updatedCos, updatedContacts, updatedCompanies: updatedCos, spread_days: allDates.size, per_day: drip });
  } catch (err) { console.error('[lm-seq-redist]', err.message); res.status(500).json({ error: 'Error al repartir' }); }
});
// Deshacer el último "Hecha": retrocede un paso (o reactiva si estaba terminado), re-ancla la fecha
// y borra la actividad de completado falsa. Para cuando marcas por error sin haber hecho la tarea.
app.post('/api/lm/sequences/:id/contacts/:cid/rollback', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, sid = parseInt(req.params.id), cid = parseInt(req.params.cid);
  try {
    const enr = (await pool.query(`SELECT id, paso, estado FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND contact_id=$3`, [uid, sid, cid])).rows[0];
    if (!enr) return res.status(404).json({ error: 'Enrolamiento no encontrado' });
    let newPaso = enr.paso || 1;
    if (enr.estado === 'terminado') { /* reactivar en el último paso hecho */ }
    else if ((enr.paso || 1) > 1) { newPaso = (enr.paso || 1) - 1; }
    else return res.status(400).json({ error: 'Ya está en el primer paso; no hay nada que deshacer.' });
    await pool.query(`UPDATE lm_contact_sequences SET paso=$1, estado='activo', paso_date=NULL, next_action_at=NOW() WHERE id=$2`, [newPaso, enr.id]);
    // Borra la última actividad de completado de paso de este contacto (la que se creó por error).
    const del = await pool.query(
      `DELETE FROM activities WHERE id = (
         SELECT id FROM activities WHERE user_id=$1 AND contact_id=$2 AND estado='hecha' AND nota LIKE 'Paso %'
         ORDER BY fecha DESC, id DESC LIMIT 1) RETURNING id`,
      [uid, cid]);
    res.json({ paso: newPaso, estado: 'activo', activity_deleted: del.rowCount });
  } catch (err) { console.error('[lm-seq-rollback]', err.message); res.status(500).json({ error: 'Error al deshacer' }); }
});
app.post('/api/lm/contacts/add-to-sequence', requireAuth, (req, res) => _lmAddMembership(req, res, 'sequence'));
app.post('/api/lm/contacts/add-to-campaign', requireAuth, (req, res) => _lmAddMembership(req, res, 'campaign'));
// Disposición outbound: marca el contacto, registra actividad y (si aplica) lo pausa en TODAS sus secuencias activas.
// ── Disposiciones outbound, en 3 grupos que SUMAN al total (sin solaparse) ──
//   Positivos : respondio · reunion · mas_adelante   → hay señal comercial
//   Derivados : derivado · no_es_persona             → la persona no sirve, la CUENTA sí
//   Descartados: no_interesado · no_califica · no_contactar
// 'aceptado' = aceptó la invitación de LinkedIn — NO es una respuesta. Antes se
// marcaba con 'respondio' (mismo valor que "Interesado"), así que aceptar una conexión
// inflaba las respuestas/leads sin que la persona hubiera contestado nada todavía.
const LM_DISP_LBL = {
  aceptado: 'Aceptó en LinkedIn', respondio: 'Interesado', reunion: 'Reunión agendada', mas_adelante: 'Contactar más adelante',
  derivado: 'Derivó a otro contacto', no_es_persona: 'No es la persona — se agregó a otro',
  no_interesado: 'No interesado', no_califica: 'No califica (fuera de ICP)', no_contactar: 'No contactar (opt-out)',
};
// tipo 'aceptacion' es DISTINTO de 'respuesta' a propósito: así no se cuenta como
// respuesta en /sequences/:id/metrics ni en la pestaña "Respuestas" del cliente.
const LM_DISP_TIPO = { aceptado: 'aceptacion', respondio: 'respuesta', reunion: 'reunion', mas_adelante: 'respuesta', derivado: 'respuesta', no_es_persona: 'nota' };
// Etapa del pipeline por disposición. null = no mover (derivados y aceptado: aceptar
// una conexión no es todavía una señal comercial, así que no adelanta la etapa).
const LM_STAGE_BY_DISP = {
  aceptado: null, respondio: 'respondio', reunion: 'respondio', mas_adelante: 'respondio',
  derivado: null, no_es_persona: null,
  no_interesado: 'perdido', no_califica: 'perdido', no_contactar: 'perdido',
};
// Disposiciones que sacan al contacto de la cola activa (pausan su secuencia).
const LM_DISP_EXIT = ['reunion', 'mas_adelante', 'derivado', 'no_es_persona', 'no_interesado', 'no_califica', 'no_contactar'];

// ── Estabilización del núcleo de secuencias (v2, Bloque A+B) ──────────────────
// Separación estricta:
//   respondio  → SIEMPRE pausa el enrolamiento activo (paused_reason='reply_received').
//                Crea UNA sola tarea "revisar_respuesta" pendiente (idempotente).
//                NO re-enruta automáticamente por cond='replied' — decisión humana.
//   aceptado   → NO pausa. Registra la aceptación. Re-enruta al primer paso replied
//                del canal principal (cuando existe) para continuar por LinkedIn.
//                No crea tarea de "revisar respuesta" (no es una respuesta real).
//   exit disp  → pausa por 'disposition_<X>' (no_interesado, no_contactar, …).
//
// Idempotencia: cada acción secundaria verifica su equivalente antes de crear.
// yaDisparo se aplica solo al re-enrutado de aceptado (evita saltar dos veces).
app.post('/api/lm/contacts/:id/disposition', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const disp = _lmS((req.body || {}).disposition);
  const nota = _lmS((req.body || {}).nota);
  const seqId = (req.body || {}).sequence_id ? (parseInt((req.body).sequence_id) || null) : null;
  try {
    const before = await pool.query(`SELECT disposition, outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid]);
    if (!before.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    const oldDisp = before.rows[0].disposition || '';
    const obcId = before.rows[0].outbound_client_id || null;

    // Idempotencia clave: si el estado no cambió y no viene una nota nueva,
    // no ejecutamos efectos secundarios — solo tocamos updated_at.
    const noChange = disp === oldDisp;
    if (noChange && !nota) {
      await pool.query(`UPDATE lm_contacts SET updated_at=NOW() WHERE id=$1 AND user_id=$2`, [cid, uid]);
      return res.json({ ok: true, disposition: disp, paused: 0, rerouted: 0, stage: null, no_change: true });
    }

    await pool.query(`UPDATE lm_contacts SET disposition=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [disp, cid, uid]);

    let paused = 0, rerouted = 0, review_task_id = null;

    // Registrar el CAMBIO de disposition (solo cuando hay transición real).
    if (disp !== oldDisp) {
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,'disposition_change',$4,NOW(),'hecha')`,
        [uid, cid, obcId,
         `Estado: ${LM_DISP_LBL[oldDisp] || oldDisp || '(sin estado)'} → ${LM_DISP_LBL[disp] || disp || '(sin estado)'}`]
      ).catch(() => {});
    }

    // ── RESPONDIO (real o marcado a mano): pausar siempre + crear tarea de revisión ──
    if (disp === 'respondio') {
      // 1. Pausar TODOS los enrolamientos activos con paused_reason claro.
      const rp = seqId
        ? await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='reply_received' WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado='activo'`, [uid, cid, seqId])
        : await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='reply_received' WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`, [uid, cid]);
      paused = rp.rowCount;
      if (paused > 0) {
        await pool.query(
          `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
           VALUES ($1,$2,$3,'pausa_secuencia',$4,NOW(),'hecha')`,
          [uid, cid, obcId, `Secuencia pausada (${paused}) — motivo: respuesta recibida. Requiere decisión humana para reanudar.`]
        ).catch(() => {});
      }
      // 2. Crear UNA tarea de revisión (idempotente).
      const { rows: existing } = await pool.query(
        `SELECT id FROM activities WHERE user_id=$1 AND contact_id=$2 AND tipo='revisar_respuesta' AND estado='pendiente' LIMIT 1`,
        [uid, cid]);
      if (existing.length) {
        review_task_id = existing[0].id;
      } else {
        const ins = await pool.query(
          `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, canal, nota, fecha, estado)
           VALUES ($1,$2,$3,'revisar_respuesta','email',$4,NOW(),'pendiente') RETURNING id`,
          [uid, cid, obcId, `Revisar respuesta del contacto${nota ? ' — ' + nota : ''}`]);
        review_task_id = ins.rows[0].id;
      }
    }
    // ── ACEPTADO (LinkedIn accepted): NO pausa. Re-enruta al canal principal si hay ──
    else if (disp === 'aceptado') {
      // yaDisparo solo aplica AQUÍ (para no re-enrutar dos veces si ya se aceptó antes).
      if (oldDisp !== 'aceptado') {
        const seqs = seqId
          ? [seqId]
          : (await pool.query(`SELECT sequence_id FROM lm_contact_sequences WHERE user_id=$1 AND contact_id=$2 AND estado IN ('activo','pausado')`, [uid, cid])).rows.map(r => r.sequence_id);
        for (const sq of seqs) {
          const { rows: sqRow } = await pool.query(`SELECT preferred_channel, nombre FROM sequences WHERE id=$1 AND user_id=$2`, [sq, uid]);
          const pref = (sqRow[0]?.preferred_channel) || '';
          const seqName = sqRow[0]?.nombre || `#${sq}`;
          const steps = (await pool.query(`SELECT id, cond, canal, titulo FROM sequence_steps WHERE sequence_id=$1 AND user_id=$2 ORDER BY dia ASC, orden ASC, id ASC`, [sq, uid])).rows;
          // Prioriza canal preferido; fallback a primer replied de cualquier canal.
          let fr = -1;
          if (pref) fr = steps.findIndex(s => (s.cond || '') === 'replied' && s.canal === pref);
          if (fr < 0) fr = steps.findIndex(s => (s.cond || '') === 'replied');
          const { rows: prevRow } = await pool.query(`SELECT paso, estado FROM lm_contact_sequences WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3`, [uid, cid, sq]);
          const pasoPrev = prevRow[0]?.paso || null;
          const estadoPrev = prevRow[0]?.estado || null;
          if (fr >= 0 && (pasoPrev == null || fr + 1 > pasoPrev)) {
            // Solo re-enrutar HACIA ADELANTE (nunca "atrás" a pasos ya ejecutados).
            const r = await pool.query(`UPDATE lm_contact_sequences SET paso=$1, paso_date=CURRENT_DATE, estado='activo', paused_reason='' WHERE user_id=$2 AND contact_id=$3 AND sequence_id=$4 AND estado IN ('activo','pausado')`, [fr + 1, uid, cid, sq]);
            rerouted += r.rowCount;
            if (r.rowCount) {
              const stTarget = steps[fr];
              const canalStr = stTarget.canal.charAt(0).toUpperCase() + stTarget.canal.slice(1);
              await pool.query(
                `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
                 VALUES ($1,$2,$3,'reruta',$4,NOW(),'hecha')`,
                [uid, cid, obcId,
                 `🔀 Re-enrutado en "${seqName}"${pasoPrev ? ` del paso ${pasoPrev}` : ''} al paso ${fr + 1} (${canalStr}${stTarget.titulo ? ' — ' + String(stTarget.titulo).slice(0, 60) : ''}) porque el contacto aceptó la conexión de LinkedIn${pref ? ` · canal preferido: ${pref}` : ''}.`]
              ).catch(() => {});
            }
          }
        }
      }
    }
    // ── EXIT dispositions (no_interesado, no_contactar, etc.): pausar ──────────
    else if (LM_DISP_EXIT.includes(disp)) {
      const rp = seqId
        ? await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$4 WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado='activo'`, [uid, cid, seqId, 'disposition_' + disp])
        : await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$3 WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`, [uid, cid, 'disposition_' + disp]);
      paused = rp.rowCount;
      // Al pasar a un estado terminal (no_interesado etc.), cerrar tarea pendiente
      // de revisión si existía (ya no requiere decisión — el humano decidió).
      await pool.query(
        `UPDATE activities SET estado='hecha' WHERE user_id=$1 AND contact_id=$2 AND tipo='revisar_respuesta' AND estado='pendiente'`,
        [uid, cid]).catch(() => {});
    }

    // "Más adelante": guarda cuándo hay que retomarlo (nurturing).
    if (disp === 'mas_adelante') {
      await pool.query(`UPDATE lm_contacts SET nurture_at=$1 WHERE id=$2 AND user_id=$3`,
        [_sanDate((req.body || {}).nurture_at), cid, uid]);
    }

    // Actividad tipada por disposition (respuesta/reunion/aceptacion/nota) — SOLO
    // en el primer paso a esa disposition (idempotente por transición). Sin la
    // guarda se creaba una actividad extra cada vez que se re-guardaba el mismo estado.
    if (disp && disp !== oldDisp) {
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,$4,$5,NOW(),'hecha')`,
        [uid, cid, obcId, LM_DISP_TIPO[disp] || 'nota',
         `Disposición: ${LM_DISP_LBL[disp] || disp}${nota ? ' — ' + nota : ''}`]);
    }
    // La disposición alimenta el pipeline (solo hacia adelante).
    const stage = disp ? await _lmAdvanceStage(uid, cid, LM_STAGE_BY_DISP[disp]) : null;
    res.json({ ok: true, disposition: disp, paused, rerouted, stage, review_task_id });
  } catch (err) { console.error('[lm-disp]', err.message); res.status(500).json({ error: 'Error al actualizar disposición' }); }
});
// ── Reanudar manualmente una secuencia pausada (Bloque B: decisión humana) ─────
// Solo aplica a enrolamientos pausados. Registra el evento en activities.
// Opcional body { next_action_at }: si viene, la próxima acción sale en esa fecha;
// si no, sale ahora. Cierra la tarea de "revisar_respuesta" pendiente asociada.
app.post('/api/lm/contacts/:id/resume-sequence', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = parseInt(req.params.id);
  const seqId = (req.body || {}).sequence_id ? (parseInt(req.body.sequence_id) || null) : null;
  const nextAt = _sanDate((req.body || {}).next_action_at);
  const nextIso = nextAt ? new Date(nextAt).toISOString() : null;
  try {
    const q = seqId
      ? await pool.query(
          `UPDATE lm_contact_sequences SET estado='activo', paused_reason='',
                  next_action_at=COALESCE($4::timestamptz, NOW())
            WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado IN ('pausado','respondido')
          RETURNING sequence_id, paso`,
          [uid, cid, seqId, nextIso])
      : await pool.query(
          `UPDATE lm_contact_sequences SET estado='activo', paused_reason='',
                  next_action_at=COALESCE($3::timestamptz, NOW())
            WHERE user_id=$1 AND contact_id=$2 AND estado IN ('pausado','respondido')
          RETURNING sequence_id, paso`,
          [uid, cid, nextIso]);
    const resumed = q.rowCount;
    if (resumed > 0) {
      const { rows: [oc] } = await pool.query(`SELECT outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid]);
      await pool.query(
        `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado)
         VALUES ($1,$2,$3,'reanudacion_secuencia',$4,NOW(),'hecha')`,
        [uid, cid, oc?.outbound_client_id || null,
         `Secuencia reanudada manualmente (${resumed})${nextAt ? ` — próxima acción: ${nextAt}` : ''}.`]
      ).catch(() => {});
      // Cerrar tarea de revisión pendiente (ya no requiere decisión — se decidió).
      await pool.query(
        `UPDATE activities SET estado='hecha' WHERE user_id=$1 AND contact_id=$2 AND tipo='revisar_respuesta' AND estado='pendiente'`,
        [uid, cid]).catch(() => {});
    }
    res.json({ ok: true, resumed });
  } catch (err) { console.error('[lm-resume]', err.message); res.status(500).json({ error: 'Error al reanudar secuencia' }); }
});

// ── Inbox de tareas prioritarias (Bloque D: 4 categorías iniciales) ──────────
// Devuelve una lista plana con cada tarea etiquetada por category y reason_code,
// sin duplicados entre categorías (respuestas > aprobaciones > vencidas > hoy).
app.get('/api/lm/tasks/inbox', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  try {
    // 1. RESPUESTAS pendientes de revisar (tarea real, no solo disposition).
    const { rows: reps } = await pool.query(`
      SELECT a.id, a.contact_id, a.outbound_client_id, a.fecha AS due_at, a.nota AS reason,
             k.nombre, k.apellido, k.email,
             (SELECT sequence_id FROM lm_contact_sequences cs2
                WHERE cs2.contact_id=k.id AND cs2.estado IN ('respondido','pausado','activo')
                ORDER BY cs2.created_at DESC NULLS LAST, cs2.id DESC LIMIT 1) AS sequence_id,
             (SELECT paso FROM lm_contact_sequences cs2
                WHERE cs2.contact_id=k.id AND cs2.estado IN ('respondido','pausado','activo')
                ORDER BY cs2.created_at DESC NULLS LAST, cs2.id DESC LIMIT 1) AS paso
        FROM activities a JOIN lm_contacts k ON k.id=a.contact_id
       WHERE a.user_id=$1 AND a.tipo='revisar_respuesta' AND a.estado='pendiente'
       ORDER BY a.fecha ASC`, [uid]);

    // Contactos ya representados en respuestas (para no duplicarlos en otras cats).
    const respContactIds = new Set(reps.map(r => r.contact_id));

    // 2. APROBACIONES pendientes (borradores email en 'awaiting') — próximos 3 días.
    const { rows: apps } = await pool.query(`
      SELECT m.id, m.contact_id, m.sequence_id, m.step_id, m.scheduled_at AS due_at,
             m.to_email AS reason, k.nombre, k.apellido, k.email,
             s.outbound_client_id, s.campaign_id
        FROM lm_messages m
        JOIN lm_contacts k ON k.id=m.contact_id
        JOIN sequences s ON s.id=m.sequence_id
       WHERE m.user_id=$1 AND m.estado='awaiting'
         AND (m.scheduled_at IS NULL OR m.scheduled_at <= NOW() + interval '3 days')
       ORDER BY m.scheduled_at ASC NULLS FIRST`, [uid]);

    // 3. VENCIDAS (actividades pendientes con fecha pasada) — excluir contactos con
    //    respuesta pendiente (aparecen prioritariamente ahí, no se duplican).
    const { rows: over } = await pool.query(`
      SELECT a.id, a.contact_id, a.outbound_client_id, a.canal, a.fecha AS due_at, a.nota AS reason,
             k.nombre, k.apellido, k.email
        FROM activities a JOIN lm_contacts k ON k.id=a.contact_id
       WHERE a.user_id=$1 AND a.tipo IN ('tarea','followup') AND a.estado='pendiente'
         AND a.fecha < NOW() - interval '1 day'
       ORDER BY a.fecha ASC`, [uid]);

    // 4. HOY (actividades pendientes con fecha de hoy y no vencidas aún).
    const { rows: today } = await pool.query(`
      SELECT a.id, a.contact_id, a.outbound_client_id, a.canal, a.fecha AS due_at, a.nota AS reason,
             k.nombre, k.apellido, k.email
        FROM activities a JOIN lm_contacts k ON k.id=a.contact_id
       WHERE a.user_id=$1 AND a.tipo IN ('tarea','followup') AND a.estado='pendiente'
         AND a.fecha >= NOW() - interval '1 day' AND a.fecha <= NOW() + interval '1 day'
       ORDER BY a.fecha ASC`, [uid]);

    // 5. FALLOS Y BLOQUEOS — mensajes que fallaron o rebotaron en los últimos 14 días.
    const { rows: fails } = await pool.query(`
      SELECT m.id, m.contact_id, m.sequence_id, m.step_id, COALESCE(m.sent_at, m.created_at) AS due_at,
             COALESCE(m.error,'') AS reason, k.nombre, k.apellido, k.email,
             s.outbound_client_id, s.campaign_id
        FROM lm_messages m
        JOIN lm_contacts k ON k.id=m.contact_id
        LEFT JOIN sequences s ON s.id=m.sequence_id
       WHERE m.user_id=$1 AND m.estado IN ('failed','bounced')
         AND COALESCE(m.sent_at, m.created_at) > NOW() - interval '14 days'
       ORDER BY due_at DESC`, [uid]);

    // 6. DATOS OBLIGATORIOS FALTANTES — contactos pausados por falta/error de dato.
    const { rows: dataIssues } = await pool.query(`
      SELECT k.id AS contact_id, k.outbound_client_id, k.nombre, k.apellido, k.email, k.data_issue AS reason
        FROM lm_contacts k WHERE k.user_id=$1 AND k.data_issue <> ''
       ORDER BY k.updated_at DESC NULLS LAST`, [uid]);

    // 7. LINKEDIN ACEPTADO CON SIGUIENTE ACCIÓN — aceptó la invitación y tiene una secuencia activa esperando el siguiente paso.
    const { rows: liAccepted } = await pool.query(`
      SELECT DISTINCT k.id AS contact_id, k.outbound_client_id, k.nombre, k.apellido, k.email,
             cs.sequence_id, cs.next_action_at AS due_at
        FROM lm_contacts k JOIN lm_contact_sequences cs ON cs.contact_id=k.id AND cs.user_id=k.user_id
       WHERE k.user_id=$1 AND k.disposition='aceptado' AND cs.estado='activo'
       ORDER BY due_at ASC NULLS LAST`, [uid]);

    const nameOf = r => [r.nombre, r.apellido].filter(Boolean).join(' ') || r.email || `#${r.contact_id}`;
    const mk = (r, category, task_type, reason_code) => ({
      category, task_type, reason_code,
      activity_id: r.id, message_id: r.id,
      contact_id: r.contact_id, contact_name: nameOf(r), email: r.email,
      outbound_client_id: r.outbound_client_id || null,
      sequence_id: r.sequence_id || null, step_id: r.step_id || null,
      campaign_id: r.campaign_id || null,
      channel: r.canal || 'email', due_at: r.due_at, status: 'pendiente',
      source: 'nova', reason: (r.reason || '').slice(0, 220),
    });

    const list = [];
    for (const r of reps)  list.push(mk(r, 'respuestas',    'review_reply', 'reply_pending'));
    // Aprobaciones: si el contacto ya tiene tarea de respuesta, saltar (respuestas prioriza)
    for (const r of apps)  if (!respContactIds.has(r.contact_id)) list.push({ ...mk(r, 'aprobaciones', 'approve_email', 'draft_awaiting'), message_id: r.id, activity_id: null });
    for (const r of fails) if (!respContactIds.has(r.contact_id)) list.push({ ...mk(r, 'fallos', 'resolve_failure', 'send_failed'), message_id: r.id, activity_id: null });
    for (const r of over)  if (!respContactIds.has(r.contact_id)) list.push(mk(r, 'vencidas',      'manual_touch', 'overdue'));
    for (const r of today) if (!respContactIds.has(r.contact_id)) list.push(mk(r, 'hoy',           'manual_touch', 'due_today'));
    // LinkedIn aceptado y Datos faltantes van al final — no compiten con lo urgente, solo se agregan si el contacto no salió ya en otra categoría.
    const seenSoFar = new Set(list.map(x => x.contact_id));
    for (const r of liAccepted) if (!seenSoFar.has(r.contact_id)) { list.push({ ...mk(r, 'linkedin_aceptado', 'next_step', 'li_accepted'), message_id: null, activity_id: null }); seenSoFar.add(r.contact_id); }
    for (const r of dataIssues) if (!seenSoFar.has(r.contact_id)) { list.push({ ...mk(r, 'datos_faltantes', 'fix_data', 'missing_data'), message_id: null, activity_id: null }); seenSoFar.add(r.contact_id); }

    const counts = list.reduce((a, x) => ((a[x.category] = (a[x.category] || 0) + 1), a), {});
    res.json({ ok: true, counts, items: list });
  } catch (err) { console.error('[lm-tasks-inbox]', err.message); res.status(500).json({ error: 'Error al cargar inbox de tareas' }); }
});

// ── Derivación: el lead no es la persona correcta → se registra al contacto NUEVO de la
// MISMA empresa (te lo dio él, o lo conseguiste tú) y se enrola en la misma secuencia
// desde el paso 1. El original NO se marca como perdido: la cuenta sigue viva.
app.post('/api/lm/contacts/:id/refer', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = parseInt(req.params.id);
  const b = req.body || {};
  const nombre = _lmS(b.nombre), apellido = _lmS(b.apellido), email = _lmS(b.email).toLowerCase();
  const disp = b.disposition === 'no_es_persona' ? 'no_es_persona' : 'derivado';
  if (!nombre && !email) return res.status(400).json({ error: 'Indica al menos el nombre o el email del nuevo contacto' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [orig] } = await client.query(
      `SELECT id, nombre, apellido, company_id, empresa_nombre, outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid]);
    if (!orig) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Contacto no encontrado' }); }
    const nomOrig = [orig.nombre, orig.apellido].filter(Boolean).join(' ') || 'el contacto anterior';

    // Si ya existe un contacto con ese email en el workspace, se reutiliza (no se duplica).
    let nuevo = null;
    if (email) {
      const { rows } = await client.query(`SELECT * FROM lm_contacts WHERE user_id=$1 AND LOWER(email)=$2 LIMIT 1`, [uid, email]);
      nuevo = rows[0] || null;
    }
    if (!nuevo) {
      const { rows: [ins] } = await client.query(`
        INSERT INTO lm_contacts (user_id, company_id, nombre, apellido, email, telefono, movil, cargo, linkedin,
                                 empresa_nombre, outbound_client_id, estado, fuente, referred_by, notas)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'nuevo','derivado',$12,$13) RETURNING *`,
        [uid, orig.company_id, nombre, apellido, email, _lmS(b.telefono), _lmS(b.movil), _lmS(b.cargo), _lmS(b.linkedin),
         orig.empresa_nombre, orig.outbound_client_id, cid, `Referido por ${nomOrig}`]);
      nuevo = ins;
    } else {
      await client.query(`UPDATE lm_contacts SET referred_by=COALESCE(referred_by,$1), company_id=COALESCE(company_id,$2), updated_at=NOW() WHERE id=$3`,
        [cid, orig.company_id, nuevo.id]);
    }

    // El nuevo referido NO se enrola automáticamente (requiere acción humana explícita después
    // de crearlo/vincularlo) — se informan las secuencias del original como sugerencia para el frontend.
    let enrolado = 0;
    const { rows: origSeqs } = await client.query(
      `SELECT DISTINCT sequence_id FROM lm_contact_sequences WHERE user_id=$1 AND contact_id=$2`, [uid, cid]);
    if (b.auto_enroll === true) {
      for (const s of origSeqs) {
        const r = await client.query(
          `INSERT INTO lm_contact_sequences (user_id, contact_id, sequence_id, paso, estado, start_date, next_action_at)
           VALUES ($1,$2,$3,1,'activo',CURRENT_DATE,NOW()) ON CONFLICT (contact_id, sequence_id) DO NOTHING`,
          [uid, nuevo.id, s.sequence_id]);
        enrolado += r.rowCount;
      }
    }

    // El original sale de la cola (sin marcarse como perdido) y queda la traza en ambos.
    const nomNuevo = [nombre, apellido].filter(Boolean).join(' ') || email;
    await client.query(`UPDATE lm_contacts SET disposition=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [disp, cid, uid]);
    await client.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$3 WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`,
      [uid, cid, 'disposition_' + disp]);
    await client.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'respuesta',$4,NOW(),'hecha')`,
      [uid, cid, orig.outbound_client_id, `Disposición: ${LM_DISP_LBL[disp]} → ${nomNuevo}${_lmS(b.nota) ? ' — ' + _lmS(b.nota) : ''}`]);
    await client.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, nuevo.id, orig.outbound_client_id, `Referido por ${nomOrig} (misma empresa)`]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, contacto: nuevo, enrolado, disposition: disp, suggested_sequence_ids: origSeqs.map(s => s.sequence_id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[lm-refer]', err.message);
    res.status(500).json({ error: 'Error al registrar el contacto derivado' });
  } finally { client.release(); }
});

// Deal (capa financiera del pipeline): valor estimado, moneda, probabilidad y fecha de cierre.
// El PUT completo del contacto usa LM_CT_COLS y NO toca estas columnas.
app.patch('/api/lm/contacts/:id/deal', requireAuth, async (req, res) => {
  const b = req.body || {};
  const valor = (b.valor === '' || b.valor == null) ? null : Number(b.valor);
  const probN = (b.prob === '' || b.prob == null) ? null : parseInt(b.prob, 10);
  const prob = Number.isFinite(probN) ? Math.max(0, Math.min(100, probN)) : null;
  const moneda = ['USD', 'PEN', 'EUR'].includes(b.moneda) ? b.moneda : 'USD';
  const cierre = b.cierre ? String(b.cierre).slice(0, 10) : null;
  if (valor != null && (!isFinite(valor) || valor < 0)) return res.status(400).json({ error: 'Valor inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE lm_contacts SET deal_valor=$1, deal_moneda=$2, deal_prob=$3, deal_cierre=$4, updated_at=NOW()
       WHERE id=$5 AND user_id=$6 RETURNING id, deal_valor, deal_moneda, deal_prob, deal_cierre`,
      [valor, moneda, prob, cierre, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json(rows[0]);
  } catch (err) { console.error('[lm-deal]', err.message); res.status(500).json({ error: 'Error al guardar el deal' }); }
});
// Canal LinkedIn no válido (perfil falso/inactivo): NO saca al contacto de la secuencia —
// el motor de tareas salta sus pasos de LinkedIn y sigue por la ruta de email. value=false revierte.
app.post('/api/lm/contacts/:id/no-linkedin', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const value = !!(req.body || {}).value;
  try {
    const r = await pool.query(`UPDATE lm_contacts SET no_linkedin=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING outbound_client_id`, [value, cid, uid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, cid, r.rows[0].outbound_client_id || null, value ? 'LinkedIn marcado como no válido (perfil falso/inactivo) → sigue solo por email' : 'LinkedIn habilitado de nuevo para este contacto']);
    res.json({ ok: true, no_linkedin: value });
  } catch (err) { console.error('[lm-noli]', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});
// Mismo patrón que no-linkedin, para WhatsApp y Llamada (número presente pero confirmado incorrecto).
app.post('/api/lm/contacts/:id/no-whatsapp', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const value = !!(req.body || {}).value;
  try {
    const r = await pool.query(`UPDATE lm_contacts SET no_whatsapp=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING outbound_client_id`, [value, cid, uid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, cid, r.rows[0].outbound_client_id || null, value ? 'WhatsApp marcado como número no válido → salta sus pasos de WhatsApp' : 'WhatsApp habilitado de nuevo para este contacto']);
    res.json({ ok: true, no_whatsapp: value });
  } catch (err) { console.error('[lm-nowa]', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});
app.post('/api/lm/contacts/:id/no-phone', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const value = !!(req.body || {}).value;
  try {
    const r = await pool.query(`UPDATE lm_contacts SET no_phone=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING outbound_client_id`, [value, cid, uid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, cid, r.rows[0].outbound_client_id || null, value ? 'Teléfono marcado como número no válido → salta sus pasos de llamada' : 'Teléfono habilitado de nuevo para este contacto']);
    res.json({ ok: true, no_phone: value });
  } catch (err) { console.error('[lm-nophone]', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});
// Estado manual del email: 'bounced' (rebotó — pausa sus secuencias para corregirlo),
// 'manual' (ingresado/confirmado a mano → enviable) o '' (volver a "sin verificar").
app.post('/api/lm/contacts/:id/email-status', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const status = String((req.body || {}).status || '');
  if (!['bounced', 'manual', ''].includes(status)) return res.status(400).json({ error: 'Estado no válido' });
  try {
    const r = await pool.query(
      `UPDATE lm_contacts SET email_status=$1, email_score=$2, email_verified_at=${status ? 'NOW()' : 'NULL'}, updated_at=NOW()
       WHERE id=$3 AND user_id=$4 RETURNING email, outbound_client_id`,
      [status, status === 'manual' ? 75 : status === 'bounced' ? 0 : null, cid, uid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    let paused = 0;
    if (status === 'bounced') {
      const p = await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='email_rebotado' WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`, [uid, cid]);
      paused = p.rowCount;
    }
    const nota = status === 'bounced' ? `Email rebotó: ${r.rows[0].email || '—'} — corregir y reanudar`
               : status === 'manual' ? `Email confirmado manualmente: ${r.rows[0].email || '—'}`
               : 'Estado de email restablecido a "sin verificar"';
    await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, cid, r.rows[0].outbound_client_id || null, nota]);
    res.json({ ok: true, email_status: status, paused });
  } catch (err) { console.error('[lm-estat]', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});

// "Por corregir": falta/está mal un dato para poder contactar (falta_email | falta_linkedin |
// dato_incorrecto). Pausa sus secuencias y lo deja en Contactos → "Por corregir". issue='' reanuda.
app.post('/api/lm/contacts/:id/data-issue', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const issue = String((req.body || {}).issue || '');
  const note = String((req.body || {}).note || '').slice(0, 500);
  if (!['falta_email', 'falta_linkedin', 'dato_incorrecto', ''].includes(issue)) return res.status(400).json({ error: 'Motivo no válido' });
  try {
    const r = await pool.query(`UPDATE lm_contacts SET data_issue=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING outbound_client_id`, [issue, cid, uid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    let paused = 0, resumed = 0;
    if (issue) {
      const p = await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason=$1 WHERE user_id=$2 AND contact_id=$3 AND estado='activo'`, ['dato_' + issue, uid, cid]);
      paused = p.rowCount;
    } else {
      const p = await pool.query(`UPDATE lm_contact_sequences SET estado='activo', paused_reason='' WHERE user_id=$1 AND contact_id=$2 AND estado='pausado' AND paused_reason LIKE 'dato_%'`, [uid, cid]);
      resumed = p.rowCount;
    }
    const L = { falta_email: 'Falta email', falta_linkedin: 'Falta LinkedIn', dato_incorrecto: 'Dato incorrecto' };
    const nota = issue ? `Marcado "Por corregir": ${L[issue]}${note ? ' — ' + note : ''} (pausado; corregir y reanudar)` : 'Dato corregido — secuencia(s) reanudada(s)';
    await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
      [uid, cid, r.rows[0].outbound_client_id || null, nota]);
    res.json({ ok: true, data_issue: issue, paused, resumed });
  } catch (err) { console.error('[lm-datai]', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});

// ── Contactos enrolados en una secuencia (progreso) ──
app.get('/api/lm/sequences/:id/contacts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.contact_id, cs.paso, cs.estado, COALESCE((cs.start_date + TIME '12:00')::timestamptz, cs.created_at) AS enrolled_at, cs.paso_date::text AS paso_date,
        k.nombre, k.apellido, k.email, k.cargo, k.company_id, k.region, k.pais, co.nombre AS company_nombre
      FROM lm_contact_sequences cs
      JOIN lm_contacts k ON k.id = cs.contact_id
      LEFT JOIN lm_companies co ON co.id = k.company_id
      WHERE cs.user_id=$1 AND cs.sequence_id=$2
      ORDER BY cs.created_at DESC
    `, [req.workspaceOwnerId, req.params.id]);
    res.json(rows);
  } catch (err) { console.error('[lm-seq-ct] GET', err.message); res.status(500).json({ error: 'Error al cargar contactos' }); }
});
app.patch('/api/lm/sequences/:id/contacts/:cid', requireAuth, async (req, res) => {
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.estado != null) { vals.push(String(b.estado).slice(0, 20)); sets.push(`estado=$${vals.length}`); }
  // Al avanzar de paso se sella paso_date=HOY: el siguiente paso se agenda desde el día en que
  // realmente completaste este (un retraso corre toda la cadencia, no la comprime).
  if (b.paso != null) { vals.push(parseInt(b.paso) || 1); sets.push(`paso=$${vals.length}`); sets.push(`paso_date=CURRENT_DATE`); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  vals.push(req.workspaceOwnerId, req.params.id, req.params.cid);
  try {
    const { rows } = await pool.query(`UPDATE lm_contact_sequences SET ${sets.join(',')} WHERE user_id=$${vals.length - 2} AND sequence_id=$${vals.length - 1} AND contact_id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Enrolamiento no encontrado' });
    // Completó al menos el paso 1 (avanza de paso o termina) → el contacto ya fue contactado.
    const stage = ((b.paso != null && (parseInt(b.paso) || 1) > 1) || b.estado === 'terminado')
      ? await _lmAdvanceStage(req.workspaceOwnerId, req.params.cid, 'contactado') : null;
    res.json({ ...rows[0], stage });
  } catch (err) { console.error('[lm-seq-ct] PATCH', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});
app.delete('/api/lm/sequences/:id/contacts/:cid', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND contact_id=$3`, [req.workspaceOwnerId, req.params.id, req.params.cid]);
    if (!rowCount) return res.status(404).json({ error: 'Enrolamiento no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[lm-seq-ct] DEL', err.message); res.status(500).json({ error: 'Error al quitar' }); }
});
app.get('/api/lm/sequences/:id/metrics', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, sid = req.params.id;
  try {
    const { rows } = await pool.query(`
      WITH enr AS (SELECT contact_id, estado FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2)
      SELECT
        (SELECT COUNT(*) FROM enr)::int AS enrolados,
        (SELECT COUNT(*) FROM enr WHERE estado='terminado')::int AS terminados,
        (SELECT COUNT(*) FROM enr WHERE estado='activo')::int AS activos,
        (SELECT COUNT(*) FROM enr WHERE estado='pausado')::int AS pausados,
        (SELECT COUNT(DISTINCT a.contact_id) FROM activities a WHERE a.user_id=$1 AND a.estado='hecha' AND a.contact_id IN (SELECT contact_id FROM enr))::int AS contactados,
        (SELECT COUNT(DISTINCT a.contact_id) FROM activities a WHERE a.user_id=$1 AND a.tipo='respuesta' AND a.contact_id IN (SELECT contact_id FROM enr))::int AS respuestas,
        (SELECT COUNT(DISTINCT a.contact_id) FROM activities a WHERE a.user_id=$1 AND a.tipo='aceptacion' AND a.contact_id IN (SELECT contact_id FROM enr))::int AS aceptaciones,
        (SELECT COUNT(DISTINCT a.contact_id) FROM activities a WHERE a.user_id=$1 AND a.tipo='reunion' AND a.contact_id IN (SELECT contact_id FROM enr))::int AS reuniones
    `, [uid, sid]);
    res.json(rows[0] || {});
  } catch (err) { console.error('[lm-seq-met] GET', err.message); res.status(500).json({ error: 'Error al cargar métricas' }); }
});

// ═══════════════════════════════════════════════════════════════════
// ── Buzones por cliente (SMTP/IMAP multi-proveedor) ──
const mailboxSvc = require('./services/mailboxService');
app.get('/api/lm/mailboxes', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, outbound_client_id, email, provider, smtp_host, smtp_port, imap_host, imap_port, estado, last_error, verified_at, signature_html, from_name FROM lm_mailboxes WHERE user_id=$1 ORDER BY id`, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[mailbox] GET', err.message); res.status(500).json({ error: 'Error al cargar buzones' }); }
});
app.post('/api/lm/mailboxes', requireAuth, async (req, res) => {
  const b = req.body || {};
  const cid = parseInt(b.outbound_client_id) || null;
  const email = String(b.email || '').trim().toLowerCase();
  const pass = String(b.password || '').trim();
  const provider = ['google', 'microsoft', 'zoho', 'otro'].includes(b.provider) ? b.provider : 'otro';
  if (!cid || !email || !pass) return res.status(400).json({ error: 'Cliente, correo y contraseña son obligatorios' });
  const hosts = mailboxSvc.resolveHosts(provider, b);
  if (!hosts.smtp_host || !hosts.imap_host) return res.status(400).json({ error: 'Faltan los servidores SMTP/IMAP para este proveedor' });
  const mb = { email, provider, ...hosts };
  try {
    const t = await mailboxSvc.testMailbox(mb, pass);
    // SMTP es obligatorio; IMAP puede faltar (Microsoft 365 ya no acepta IMAP con contraseña)
    // → se guarda como 'solo_envio' y la lectura llega con la pieza OAuth (F2).
    if (!t.smtpOk) return res.status(400).json({ error: t.error || 'No se pudo conectar el buzón' });
    const estado = t.imapOk ? 'conectado' : 'solo_envio';
    const lastErr = t.imapOk ? '' : (t.error || 'IMAP no disponible');
    const { rows } = await pool.query(`
      INSERT INTO lm_mailboxes (user_id, outbound_client_id, email, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, pass_enc, estado, last_error, sent_folder, verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (user_id, outbound_client_id) DO UPDATE SET
        email=EXCLUDED.email, provider=EXCLUDED.provider, smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port,
        smtp_secure=EXCLUDED.smtp_secure, imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port,
        pass_enc=EXCLUDED.pass_enc, estado=EXCLUDED.estado, last_error=EXCLUDED.last_error, sent_folder=EXCLUDED.sent_folder,
        -- Al reconectar (o cambiar de cuenta) el cursor IMAP se re-ancla en el próximo tick
        imap_uidvalidity=CASE WHEN lm_mailboxes.email <> EXCLUDED.email THEN 0 ELSE lm_mailboxes.imap_uidvalidity END,
        imap_last_uid   =CASE WHEN lm_mailboxes.email <> EXCLUDED.email THEN 0 ELSE lm_mailboxes.imap_last_uid    END,
        verified_at=NOW()
      RETURNING id, outbound_client_id, email, provider, estado, last_error, verified_at
    `, [req.workspaceOwnerId, cid, email, provider, hosts.smtp_host, hosts.smtp_port, hosts.smtp_secure, hosts.imap_host, hosts.imap_port, mailboxSvc.encPass(pass), estado, lastErr, t.sentFolder || '']);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[mailbox] POST', err.message); res.status(500).json({ error: 'Error al guardar el buzón' }); }
});
app.post('/api/lm/mailboxes/:id/test', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM lm_mailboxes WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Buzón no encontrado' });
    const mb = rows[0];
    // Auth: pass (basic) o accessToken (OAuth). getMailboxAuth refresca token si toca.
    const auth = await mailboxSvc.getMailboxAuth(pool, mb);
    const t = await mailboxSvc.testMailbox(mb, auth);
    let sent = false;
    if (t.smtpOk && (req.body || {}).send_test) {
      await mailboxSvc.sendFromMailbox(mb, auth, {
        to: mb.email, subject: '✓ Prueba de Nova — buzón conectado',
        text: `Este buzón (${mb.email}) quedó conectado a Nova.\nEnvío por SMTP funcionando${t.imapOk ? ' y lectura por IMAP también. Esta copia debe aparecer en tu carpeta Enviados.' : '. La lectura automática (IMAP) queda pendiente — actívala reconectando por OAuth.'}`,
      });
      sent = true;
    }
    const estado = t.smtpOk ? (t.imapOk ? 'conectado' : 'solo_envio') : 'error';
    await pool.query(`UPDATE lm_mailboxes SET estado=$1, last_error=$2, verified_at=CASE WHEN $3 THEN NOW() ELSE verified_at END WHERE id=$4`,
      [estado, t.smtpOk && t.imapOk ? '' : (t.error || ''), t.smtpOk, mb.id]);
    res.json({ ...t, estado, sent });
  } catch (err) { console.error('[mailbox] TEST', err.message); res.status(500).json({ error: 'Error al probar el buzón' }); }
});
// Firma HTML por buzón (independiente por cliente outbound). Reemplaza la
// firma global del user cuando este buzón envía. Guarda tal cual el HTML —
// puede llevar <img base64>, links, estilos inline. Límite generoso (512KB)
// para acomodar imágenes base64 típicas de firma.
app.put('/api/lm/mailboxes/:id/signature', requireAuth, async (req, res) => {
  try {
    const html = String((req.body || {}).signature_html || '');
    if (html.length > 524288) return res.status(400).json({ error: 'La firma pesa más de 512KB — reduce el tamaño de la imagen (usa una URL en vez de base64, o comprímela).' });
    const fromName = String((req.body || {}).from_name || '').trim().slice(0, 120);
    const { rowCount } = await pool.query(
      `UPDATE lm_mailboxes SET signature_html=$1, from_name=$2 WHERE id=$3 AND user_id=$4`,
      [html, fromName, req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Buzón no encontrado' });
    res.json({ ok: true, length: html.length, from_name: fromName });
  } catch (err) { console.error('[mailbox] signature PUT', err.message); res.status(500).json({ error: 'Error al guardar la firma' }); }
});

app.delete('/api/lm/mailboxes/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_mailboxes WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Buzón no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[mailbox] DELETE', err.message); res.status(500).json({ error: 'Error al quitar el buzón' }); }
});

// ── OAuth Microsoft para buzones (F4) ─────────────────────────────
// Flujo: el frontend abre en popup /api/lm/mailboxes/oauth/microsoft/start?client=N.
// Redirigimos a Microsoft; después de que la usuaria consiente, Microsoft vuelve a
// /callback. Ahí intercambiamos el código por tokens, upsert-eamos el buzón (una
// fila por outbound_client + email), verificamos IMAP/SMTP y cerramos el popup con
// un postMessage para que el padre recargue la lista.
app.get('/api/lm/mailboxes/oauth/microsoft/status', requireAuth, (_req, res) => {
  const ms = require('./services/microsoftOAuth');
  res.json({ configured: ms.isConfigured() });
});

app.get('/api/lm/mailboxes/oauth/microsoft/start', requireAuth, (req, res) => {
  try {
    const ms = require('./services/microsoftOAuth');
    if (!ms.isConfigured()) {
      return res.status(500).send('Microsoft OAuth no está configurado. Falta MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REDIRECT_URI en el .env del backend.');
    }
    const clientId = parseInt(req.query.client, 10);
    if (!clientId) return res.status(400).send('Falta el parámetro ?client=');
    // Firmamos el state para que en el callback sepamos a qué cliente outbound
    // asignar el buzón, sin que el navegador pueda cambiarlo.
    const state = _signState({ uid: req.workspaceOwnerId, clientId, ts: Date.now() });
    res.redirect(ms.buildAuthUrl(state));
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

function _signState(obj) {
  const crypto = require('crypto');
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'nova-fallback').update(payload).digest('base64url');
  return payload + '.' + sig;
}
function _verifyState(state) {
  const crypto = require('crypto');
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'nova-fallback').update(payload).digest('base64url');
  if (expect !== sig) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
}

// ── Plantillas de solicitud de admin consent (ES/EN) ─────────────────
// Placeholders soportados: {{admin_consent_url}}, {{cliente_nombre}},
// {{buzon_email}}, {{yo_nombre}}, {{yo_email}}. El frontend las muestra en el
// modal como opción de partida; la usuaria puede editarlas antes de enviar.
const ADMIN_CONSENT_TEMPLATES = {
  es: {
    label: 'Español',
    subject: 'Aprobación en Microsoft 365 para {{buzon_email}}',
    body_html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1F1D1B;line-height:1.65;font-size:14px;max-width:640px">

<p>Hola,</p>

<p>Estamos configurando el buzón <b>{{buzon_email}}</b> en <b>Nova</b>, la plataforma con la que gestionamos el outreach comercial de <b>{{cliente_nombre}}</b>.</p>

<p><b>¿Para qué necesitamos el acceso?</b><br>
Nova va a <b>enviar los correos de la campaña</b> desde ese buzón y <b>leer las respuestas</b> que lleguen — así ningún prospecto interesado se pierde en la bandeja y el equipo puede darle seguimiento a tiempo desde un solo lugar.</p>

<p>Como Microsoft 365 bloquea por defecto a las apps externas del tenant, necesitamos tu <b>revisión y aprobación como administrador</b> para autorizar la app "Nova outreach". Es un trámite único.</p>

<p style="margin:28px 0;text-align:center">
  <a href="{{admin_consent_url}}" style="background:#0062CC;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Aprobar acceso →</a>
</p>

<p>Al darle clic al botón:</p>
<ol style="margin:4px 0 16px 22px;padding:0">
  <li>Se abre <b>login.microsoftonline.com</b>. Inicia sesión con tu cuenta admin del tenant.</li>
  <li>Verás una pantalla que dice <b>"Permisos solicitados"</b> con el nombre de la app (Nova outreach).</li>
  <li>Revisa los permisos y clic en <b>Aceptar</b>.</li>
  <li>La ventana se cierra sola — listo.</li>
</ol>

<p>Es un solo trámite y no se repite. Tu aprobación autoriza a la app en el tenant, pero cada persona que quiera conectar su buzón sigue dando su propio consentimiento individual — no conecta buzones por sí sola.</p>

<p>La app pide cuatro permisos estándar delegados de Microsoft: leer y enviar correo del usuario que se conecte, más los tokens de sesión habituales. Solo aplican a los buzones cuyos dueños den consent individual.</p>

<p>Para aprobarlo debes ser <b>Global Administrator</b>, <b>Cloud Application Administrator</b> o <b>Application Administrator</b> del tenant.</p>

<p style="color:#6C6862;font-size:13px">La app aparecerá como "Publisher not verified" — es normal, es una herramienta propia que aún no pasó la verificación opcional de publisher de Microsoft.</p>

<p style="margin-top:24px">Cualquier duda, respóndeme y lo vemos. Gracias.</p>

<p style="margin-top:20px;color:#6C6862;font-size:13px">— {{yo_nombre}}</p>

</div>`,
  },
  en: {
    label: 'English',
    subject: 'Microsoft 365 approval for {{buzon_email}}',
    body_html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1F1D1B;line-height:1.65;font-size:14px;max-width:640px">

<p>Hi,</p>

<p>We're setting up the mailbox <b>{{buzon_email}}</b> in <b>Nova</b>, the platform we use to manage <b>{{cliente_nombre}}</b>'s outbound operation.</p>

<p><b>Why do we need access?</b><br>
Nova will <b>send the campaign emails</b> from that mailbox and <b>read the replies</b> that come in — so no interested prospect gets lost in the inbox and the team can follow up on time from a single place.</p>

<p>Since Microsoft 365 blocks external apps in the tenant by default, we need your <b>review and approval as admin</b> to authorize the "Nova outreach" app. It's a one-time step.</p>

<p style="margin:28px 0;text-align:center">
  <a href="{{admin_consent_url}}" style="background:#0062CC;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Approve access →</a>
</p>

<p>When you click the button:</p>
<ol style="margin:4px 0 16px 22px;padding:0">
  <li><b>login.microsoftonline.com</b> opens. Sign in with your admin account for the tenant.</li>
  <li>You'll see a <b>"Permissions requested"</b> screen with the app name (Nova outreach).</li>
  <li>Review the permissions and click <b>Accept</b>.</li>
  <li>The window closes on its own — done.</li>
</ol>

<p>It's a one-time step. Your approval authorizes the app in the tenant, but each person who wants to connect their mailbox still grants their own individual consent — it doesn't connect mailboxes on its own.</p>

<p>The app requests four standard delegated Microsoft permissions: read and send email for the connecting user, plus the usual session tokens. They only apply to mailboxes whose owners give individual consent.</p>

<p>To approve you need to be <b>Global Administrator</b>, <b>Cloud Application Administrator</b> or <b>Application Administrator</b> of the tenant.</p>

<p style="color:#6C6862;font-size:13px">The app will appear as "Publisher not verified" — that's normal, it's a proprietary tool that hasn't gone through Microsoft's optional publisher verification yet.</p>

<p style="margin-top:24px">Any questions, reply and we'll go over it. Thanks.</p>

<p style="margin-top:20px;color:#6C6862;font-size:13px">— {{yo_nombre}}</p>

</div>`,
  },
};

// Marca manualmente un buzón como needs_admin_consent — para el caso en que la
// usuaria cierre el popup de Microsoft antes de que Microsoft haga el redirect
// al callback (típico cuando aparece el mensaje "Se necesita la aprobación del
// administrador" y cierra la ventana). Crea el registro placeholder si no existe.
app.post('/api/lm/mailboxes/mark-admin-consent-required', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const clientId = parseInt((req.body || {}).outbound_client_id, 10);
  if (!clientId) return res.status(400).json({ error: 'Falta outbound_client_id' });
  try {
    const hosts = mailboxSvc.resolveHosts('microsoft', {});
    // Si ya existe un buzón para este cliente, SOLO marcamos el flag y no
    // tocamos su config (auth_method, estado, hosts, credenciales, etc.). Es
    // clave para no romper buzones que ya tenían auth básica funcionando en
    // 'solo_envio' — el consent es adicional, no reemplaza lo que ya hay.
    // Si no existe, sí creamos un placeholder con estado 'error'.
    await pool.query(
      `INSERT INTO lm_mailboxes (user_id, outbound_client_id, email, provider, auth_method, oauth_provider,
                                 smtp_host, smtp_port, smtp_secure, imap_host, imap_port,
                                 estado, needs_admin_consent, last_error)
            VALUES ($1,$2,'','microsoft','oauth','microsoft',$3,$4,$5,$6,$7,'error',TRUE,$8)
       ON CONFLICT (user_id, outbound_client_id)
       DO UPDATE SET needs_admin_consent=TRUE`,
      [uid, clientId, hosts.smtp_host, hosts.smtp_port, hosts.smtp_secure, hosts.imap_host, hosts.imap_port,
       'Falta aprobación del admin del tenant Microsoft. Envíale la solicitud desde la tarjeta del buzón.']);
    const { rows } = await pool.query(
      `SELECT id FROM lm_mailboxes WHERE user_id=$1 AND outbound_client_id=$2`, [uid, clientId]);
    res.json({ ok: true, mailbox_id: rows[0]?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET plantillas + URL de admin consent listo (para renderizar el preview) +
// opciones de "Enviar desde" (Gmail + buzones SMTP en estado enviable).
app.get('/api/lm/mailboxes/:id/admin-consent-templates', requireAuth, async (req, res) => {
  try {
    const uid = req.workspaceOwnerId;
    const { rows } = await pool.query(
      `SELECT m.email, m.outbound_client_id, m.needs_admin_consent, m.admin_consent_requested_at, m.admin_consent_sent_to,
              oc.nombre AS cliente_nombre, oc.from_email AS oc_from_email, oc.cc_email AS oc_cc_email,
              u.name AS yo_nombre, u.email AS yo_email
         FROM lm_mailboxes m
         LEFT JOIN outbound_clients oc ON oc.id = m.outbound_client_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id=$1 AND m.user_id=$2`, [req.params.id, uid]);
    if (!rows.length) return res.status(404).json({ error: 'Buzón no encontrado' });
    const mb = rows[0];
    const clientId = process.env.MS_CLIENT_ID || '';
    const redirectUri = process.env.MS_REDIRECT_URI || '';
    // El state firmado nos deja identificar el user + outbound_client en el callback
    // (el flow /adminconsent lo devuelve tal cual). Sin esto no sabemos qué buzón
    // limpiar cuando el admin aprueba.
    const acState = clientId ? _signState({ uid, clientId: mb.outbound_client_id, ts: Date.now(), kind: 'admin' }) : '';
    const admin_consent_url = clientId
      ? `https://login.microsoftonline.com/common/adminconsent?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(acState)}`
      : '';

    // Opciones "Enviar desde": Gmail conectado + cualquier buzón con SMTP OK.
    // Incluye el propio buzón (aunque tenga IMAP roto): SMTP suele funcionar cuando
    // el estado es 'solo_envio' o 'conectado', y para mandar un correo con eso basta.
    const from_options = [];
    try {
      const { gmailStatus } = require('./services/gmailService');
      const gs = await gmailStatus(pool, uid);
      if (gs.connected && gs.email) {
        from_options.push({ id: 'gmail', email: gs.email, provider: 'gmail', label: `Gmail — ${gs.email}` });
      }
    } catch (_) {}
    const { rows: mbs } = await pool.query(
      `SELECT m.id, m.email, m.provider, m.estado, oc.nombre AS cliente_nombre
         FROM lm_mailboxes m LEFT JOIN outbound_clients oc ON oc.id=m.outbound_client_id
        WHERE m.user_id=$1 AND m.estado IN ('conectado','solo_envio') AND m.email <> ''
        ORDER BY m.id`, [uid]);
    for (const x of mbs) {
      from_options.push({
        id: x.id, email: x.email, provider: x.provider, estado: x.estado,
        label: `${x.email} (${x.cliente_nombre || x.provider})${x.estado === 'solo_envio' ? ' — solo envío' : ''}`,
      });
    }

    // Nombre corto: solo el primer nombre. "Jenny" firma mejor que "Jenny Obregon
    // Barzola" y coincide con cómo la usuaria se presenta a sus clientes.
    const yoNombreCorto = String(mb.yo_nombre || '').trim().split(/\s+/)[0] || '';

    // Firmantes disponibles: el usuario logueado + todos los team_members activos
    // del workspace. La usuaria elige quién firma el correo (uno de los tres
    // responsables del proyecto, por ejemplo). Solo se usa el primer nombre.
    const signers = [];
    if (yoNombreCorto) {
      signers.push({ id: 'me', nombre: yoNombreCorto, nombre_full: mb.yo_nombre, email: mb.yo_email || '', cargo: '', source: 'yo' });
    }
    try {
      const { rows: tms } = await pool.query(
        `SELECT id, nombre, email, cargo FROM team_members
          WHERE user_id=$1 AND estado='activo' AND nombre <> '' ORDER BY nombre`, [uid]);
      for (const t of tms) {
        const first = String(t.nombre).trim().split(/\s+/)[0];
        // Evitar duplicar al usuario logueado si también está en team_members
        if (signers.some(s => (s.email || '').toLowerCase() === (t.email || '').toLowerCase() && t.email)) continue;
        signers.push({ id: 't' + t.id, nombre: first, nombre_full: t.nombre, email: t.email || '', cargo: t.cargo || '', source: 'team' });
      }
    } catch (_) {}

    // Destinatarios sugeridos: correos que ya están asociados al cliente outbound.
    // La usuaria puede elegir uno con clic y también añadir emails libres.
    const to_options = [];
    if (mb.oc_from_email) to_options.push({ email: mb.oc_from_email, label: 'Buzón del cliente', source: 'from_email' });
    if (mb.oc_cc_email && mb.oc_cc_email !== mb.oc_from_email) {
      to_options.push({ email: mb.oc_cc_email, label: 'CC del cliente', source: 'cc_email' });
    }

    res.json({
      buzon_email: mb.email || '(pendiente)',
      cliente_nombre: mb.cliente_nombre || '',
      yo_nombre: yoNombreCorto,
      yo_email: mb.yo_email || '',
      admin_consent_url,
      already_sent_to: mb.admin_consent_sent_to || '',
      already_sent_at: mb.admin_consent_requested_at,
      templates: ADMIN_CONSENT_TEMPLATES,
      from_options,
      signers,
      to_options,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST envía el correo al admin del cliente pidiéndole el consent.
// from_mailbox_id (opcional):
//   'gmail'  → Gmail conectado del user
//   <número> → id de un lm_mailbox del user (validado)
//   omitido  → auto (Gmail si hay, si no primer buzón enviable distinto al target)
app.post('/api/lm/mailboxes/:id/request-admin-consent', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const b = req.body || {};
  const { subject, body_html, from_mailbox_id } = b;
  // Retrocompat: admin_email (string) sigue funcionando; to_emails (array) es lo nuevo.
  const toArr = Array.isArray(b.to_emails) && b.to_emails.length
    ? b.to_emails
    : (b.admin_email ? [b.admin_email] : []);
  const ccArr = Array.isArray(b.cc_emails) ? b.cc_emails : [];
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim());
  const toClean = toArr.map(x => String(x).trim()).filter(Boolean);
  const ccClean = ccArr.map(x => String(x).trim()).filter(Boolean);
  if (!toClean.length || !subject || !body_html) return res.status(400).json({ error: 'Faltan destinatarios (Para), asunto o cuerpo.' });
  const badTo = toClean.find(e => !validEmail(e));
  if (badTo) return res.status(400).json({ error: `Destinatario inválido: ${badTo}` });
  const badCc = ccClean.find(e => !validEmail(e));
  if (badCc) return res.status(400).json({ error: `CC inválido: ${badCc}` });
  const admin_email = toClean[0]; // para el registro admin_consent_sent_to (compat)
  const toStr = toClean.join(', ');
  const ccStr = ccClean.length ? ccClean.join(', ') : undefined;
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS yo_nombre, u.email AS yo_email
         FROM lm_mailboxes m LEFT JOIN users u ON u.id=m.user_id
        WHERE m.id=$1 AND m.user_id=$2`, [req.params.id, uid]);
    if (!rows.length) return res.status(404).json({ error: 'Buzón no encontrado' });
    const mb = rows[0];

    let sent_from = '';
    let sendErr = null;

    // Selección explícita del buzón de envío (elegido por la usuaria en el desplegable).
    if (from_mailbox_id === 'gmail') {
      try {
        const { gmailStatus, sendEmail } = require('./services/gmailService');
        const gs = await gmailStatus(pool, uid);
        if (!gs.connected || !gs.email) throw new Error('Gmail no está conectado en tu cuenta');
        await sendEmail(pool, uid, GMAIL_CALLBACK, {
          to: toStr, cc: ccStr, subject, html: body_html, text: body_html.replace(/<[^>]+>/g, ' '),
          fromName: mb.yo_nombre || '',
        });
        sent_from = gs.email;
      } catch (e) { sendErr = e; }
    } else if (from_mailbox_id) {
      const { rows: sr } = await pool.query(
        `SELECT * FROM lm_mailboxes WHERE id=$1 AND user_id=$2 AND estado IN ('conectado','solo_envio')`,
        [parseInt(from_mailbox_id, 10), uid]);
      if (!sr.length) return res.status(400).json({ error: 'El buzón elegido no existe o no puede enviar correos.' });
      const sender = sr[0];
      try {
        const auth = await mailboxSvc.getMailboxAuth(pool, sender);
        await mailboxSvc.sendFromMailbox(sender, auth, {
          to: toStr, cc: ccStr, subject, html: body_html, text: body_html.replace(/<[^>]+>/g, ' '),
          fromName: mb.yo_nombre || '',
        });
        sent_from = sender.email;
      } catch (e) { sendErr = e; }
    } else {
      // Modo auto (retrocompat): Gmail primero, si no primer buzón enviable distinto al target.
      try {
        const { gmailStatus, sendEmail } = require('./services/gmailService');
        const gs = await gmailStatus(pool, uid);
        if (gs.connected && gs.email) {
          await sendEmail(pool, uid, GMAIL_CALLBACK, {
            to: toStr, cc: ccStr, subject, html: body_html, text: body_html.replace(/<[^>]+>/g, ' '),
            fromName: mb.yo_nombre || '',
          });
          sent_from = gs.email;
        }
      } catch (e) { sendErr = e; }
      if (!sent_from) {
        const { rows: mbs } = await pool.query(
          `SELECT * FROM lm_mailboxes WHERE user_id=$1 AND estado IN ('conectado','solo_envio') AND id<>$2 ORDER BY id LIMIT 1`,
          [uid, mb.id]);
        if (mbs.length) {
          const sender = mbs[0];
          const auth = await mailboxSvc.getMailboxAuth(pool, sender);
          await mailboxSvc.sendFromMailbox(sender, auth, {
            to: toStr, cc: ccStr, subject, html: body_html, text: body_html.replace(/<[^>]+>/g, ' '),
            fromName: mb.yo_nombre || '',
          });
          sent_from = sender.email;
        }
      }
    }

    if (!sent_from) {
      return res.status(400).json({
        error: 'No se pudo enviar el correo.' + (sendErr ? ' Detalle: ' + sendErr.message : ' No hay ningún buzón conectado disponible.')
      });
    }

    // Guardamos la lista completa de destinatarios en admin_consent_sent_to (TO + CC
     // separados por " · " para verlo compacto en la tarjeta).
    const sentToLabel = toStr + (ccStr ? '  ·  CC: ' + ccStr : '');
    await pool.query(
      `UPDATE lm_mailboxes SET admin_consent_requested_at=NOW(), admin_consent_sent_to=$1 WHERE id=$2`,
      [sentToLabel, mb.id]);
    await pool.query(
      `INSERT INTO activities (user_id, outbound_client_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,'email','email',$3,NOW(),'hecha')`,
      [uid, mb.outbound_client_id,
       `Solicitud de admin consent enviada a ${sentToLabel} para conectar ${mb.email || 'el buzón Microsoft'} (desde ${sent_from})`]);
    res.status(201).json({ ok: true, sent_from, sent_to: toClean, sent_cc: ccClean, sent_at: new Date().toISOString() });
  } catch (e) {
    console.error('[admin-consent] request error:', e.message);
    res.status(500).json({ error: 'No se pudo enviar la solicitud: ' + e.message });
  }
});

// Callback público (Microsoft redirige aquí sin cookies de sesión); la seguridad la
// da el state firmado con SESSION_SECRET.
app.get('/api/lm/mailboxes/oauth/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  // kind: 'ok' | 'err' | 'consent_required'. En consent_required, el popup manda un
  // postMessage con needsAdminConsent:true para que el frontend abra el flujo de
  // solicitud al admin en vez de mostrar solo un error.
  const _closePopup = (kind, msg, extra = {}) => `<!doctype html><meta charset="utf-8">
<title>${kind === 'ok' ? 'Buzón conectado' : (kind === 'consent_required' ? 'Se requiere aprobación del admin' : 'Error conectando buzón')}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;padding:40px;text-align:center;color:#1f1d1b}</style>
<h2>${kind === 'ok' ? '✓ Buzón conectado' : (kind === 'consent_required' ? '⏳ Falta aprobación del admin del cliente' : '⚠ No se pudo conectar')}</h2>
<p>${String(msg || '').replace(/</g, '&lt;').slice(0, 500)}</p>
<p style="color:#918c85;font-size:13px">Esta ventana se cerrará sola…</p>
<script>
try { window.opener && window.opener.postMessage({ source:'nova-oauth-ms', ok:${kind === 'ok'}, needsAdminConsent:${kind === 'consent_required'}, msg:${JSON.stringify(String(msg || ''))}, extra:${JSON.stringify(extra)} }, '*'); } catch(e){}
setTimeout(()=>window.close(), ${kind === 'ok' ? 1200 : 3500});
</script>`;
  // Detecta el "AADSTS65001 / consent_required" que Microsoft devuelve cuando el
  // tenant del cliente no permite user consent para apps sin verificar. Marca el
  // buzón (crea el registro si no existía) y devuelve un popup especial que
  // dispara el flujo de "solicitar aprobación al admin".
  const _handleConsentRequired = async (st, detail) => {
    if (!st) return _closePopup('err', detail || 'Se necesita aprobación del admin, pero no pude identificar el cliente.');
    try {
      const hosts = mailboxSvc.resolveHosts('microsoft', {});
      // Si ya hay buzón para este cliente, SOLO agregar el flag de admin consent.
      // No tocar auth_method/estado/credenciales — un buzón con basic funcionando en
      // 'solo_envio' debe seguir enviando por SMTP mientras se espera el consent.
      // Solo si no existe, crear placeholder con estado='error'.
      await pool.query(
        `INSERT INTO lm_mailboxes (user_id, outbound_client_id, email, provider, auth_method, oauth_provider,
                                   smtp_host, smtp_port, smtp_secure, imap_host, imap_port,
                                   estado, needs_admin_consent, last_error)
              VALUES ($1,$2,'','microsoft','oauth','microsoft',$3,$4,$5,$6,$7,'error',TRUE,$8)
         ON CONFLICT (user_id, outbound_client_id)
         DO UPDATE SET needs_admin_consent=TRUE`,
        [st.uid, st.clientId, hosts.smtp_host, hosts.smtp_port, hosts.smtp_secure, hosts.imap_host, hosts.imap_port,
         'Falta aprobación del admin del tenant Microsoft. Envíale la solicitud desde la tarjeta del buzón.']);
      return _closePopup('consent_required',
        'El tenant Microsoft del cliente exige que un administrador apruebe la app "Nova outreach" antes de que puedas conectar el buzón. Nova ya te va a ofrecer enviar un correo con el link de aprobación al admin.',
        { clientId: st.clientId });
    } catch (dbErr) {
      console.error('[oauth-ms] consent flag save error:', dbErr.message);
      return _closePopup('err', 'Se necesita aprobación del admin, y además falló guardar el estado: ' + dbErr.message);
    }
  };
  try {
    const st = state ? _verifyState(state) : null;
    if (error) {
      const combined = ((error_description || '') + ' ' + (error || '')).toLowerCase();
      if (combined.includes('aadsts65001') || error === 'consent_required' || combined.includes('admin')) {
        return res.send(await _handleConsentRequired(st, error_description || error));
      }
      throw new Error(error_description || error);
    }
    // Flow /adminconsent: Microsoft NO devuelve code/state normal, sino
    // ?admin_consent=True&tenant=<guid>&state=<lo-que-mandamos>. Detectarlo antes
    // de validar code/state; quien abre este URL suele ser el ADMIN del cliente,
    // no la usuaria de Nova — mostramos un mensaje limpio y marcamos el buzón
    // como aprobado para que al reintentar el OAuth normal, ya pase.
    const adminConsentGranted = String(req.query.admin_consent || '').toLowerCase() === 'true';
    if (adminConsentGranted) {
      const tenantId = String(req.query.tenant || '');
      if (st && st.uid && st.clientId) {
        // Limpiar el flag needs_admin_consent para ESE buzón concreto.
        await pool.query(
          `UPDATE lm_mailboxes SET needs_admin_consent=FALSE, oauth_tenant_id=$1,
                  last_error='Aprobación del admin recibida. Puedes reintentar la conexión OAuth.'
            WHERE user_id=$2 AND outbound_client_id=$3`,
          [tenantId, st.uid, st.clientId]);
      } else if (tenantId) {
        // Sin state (URL manipulada, admin sin state, etc.): limpiar flag de todos
        // los buzones cuyo oauth_tenant_id coincida (best effort).
        await pool.query(
          `UPDATE lm_mailboxes SET needs_admin_consent=FALSE,
                  last_error='Aprobación del admin recibida. Puedes reintentar la conexión OAuth.'
            WHERE oauth_tenant_id=$1`, [tenantId]);
      }
      return res.send(_closePopup('ok',
        '¡Gracias! La aprobación quedó registrada para el tenant ' + (tenantId || '(sin id)') +
        '. Ya puedes cerrar esta ventana — quien te envió la solicitud podrá terminar de conectar el buzón sin más aprobaciones.'));
    }
    if (!code || !state) throw new Error('Falta code o state');
    if (!st) throw new Error('state inválido o firma no coincide');
    const ms = require('./services/microsoftOAuth');
    const tok = await ms.exchangeCode(code);
    if (!tok.email) throw new Error('No se pudo leer el email del usuario (falta scope User.Read).');

    const emailLc = tok.email.toLowerCase();
    const expiresAt = new Date(Date.now() + (tok.expires_in * 1000));
    const hosts = mailboxSvc.resolveHosts('microsoft', {});
    await pool.query(
      `INSERT INTO lm_mailboxes (user_id, outbound_client_id, email, provider, auth_method, oauth_provider,
                                 smtp_host, smtp_port, smtp_secure, imap_host, imap_port,
                                 oauth_access_enc, oauth_refresh_enc, oauth_expires_at, oauth_scopes,
                                 estado, verified_at)
            VALUES ($1,$2,$3,'microsoft','oauth','microsoft',$4,$5,$6,$7,$8,$9,$10,$11,$12,'nuevo',NOW())
       ON CONFLICT (user_id, outbound_client_id)
       DO UPDATE SET email=EXCLUDED.email, provider='microsoft', auth_method='oauth', oauth_provider='microsoft',
                     smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port, smtp_secure=EXCLUDED.smtp_secure,
                     imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port,
                     oauth_access_enc=EXCLUDED.oauth_access_enc, oauth_refresh_enc=EXCLUDED.oauth_refresh_enc,
                     oauth_expires_at=EXCLUDED.oauth_expires_at, oauth_scopes=EXCLUDED.oauth_scopes,
                     last_error='', verified_at=NOW()`,
      [st.uid, st.clientId, emailLc,
       hosts.smtp_host, hosts.smtp_port, hosts.smtp_secure, hosts.imap_host, hosts.imap_port,
       mailboxSvc.encPass(tok.access_token), mailboxSvc.encPass(tok.refresh_token), expiresAt, tok.scope]
    );
    // Verificar SMTP+IMAP en el momento para dejar el estado limpio.
    const { rows } = await pool.query(`SELECT * FROM lm_mailboxes WHERE user_id=$1 AND outbound_client_id=$2`, [st.uid, st.clientId]);
    const mb = rows[0];
    const auth = await mailboxSvc.getMailboxAuth(pool, mb);
    const t = await mailboxSvc.testMailbox(mb, auth);
    const estado = t.smtpOk ? (t.imapOk ? 'conectado' : 'solo_envio') : 'error';
    await pool.query(`UPDATE lm_mailboxes SET estado=$1, last_error=$2, sent_folder=$3 WHERE id=$4`,
      [estado, t.error || '', t.sentFolder || '', mb.id]);
    res.send(_closePopup('ok', `${emailLc} — ${estado === 'conectado' ? 'SMTP e IMAP OK' : (t.error || 'solo envío')}`));
  } catch (e) {
    console.error('[oauth-ms] callback error:', e.message);
    const m = String(e.message || '').toLowerCase();
    if (m.includes('aadsts65001') || m.includes('consent_required') || m.includes('admin')) {
      try {
        const st = state ? _verifyState(state) : null;
        return res.send(await _handleConsentRequired(st, e.message));
      } catch (_) {}
    }
    res.send(_closePopup('err', e.message));
  }
});

// ── Inbox unificado (Mailboxes F3): hilos por contacto entre lo enviado
// (lm_messages) y lo recibido por el vigilante IMAP (lm_inbox_messages). ──

// Lista de hilos: 1 fila por contacto con actividad de correo. El frontend
// arma las pestañas con estos campos (last_in_at vs last_out_at, bounces…).
// Contadores de la barra lateral. Existian en el frontend, pero se calculaban a
// partir de listas que solo se cargan al ENTRAR en cada seccion: al abrir el modulo
// no habia datos y las insignias salian vacias. Esto los da de una, y barato.
app.get('/api/lm/nav-counts', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  try {
    const [inbox, acts, aprob, leads] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int n FROM lm_inbox_messages
                   WHERE user_id=$1 AND NOT leido AND tipo='reply'`, [uid]),
      pool.query(`SELECT COUNT(*)::int n FROM activities
                   WHERE user_id=$1 AND estado='pendiente' AND fecha::date <= CURRENT_DATE`, [uid]),
      pool.query(`SELECT COUNT(*)::int n FROM lm_messages
                   WHERE user_id=$1 AND estado='awaiting'`, [uid]),
      pool.query(`SELECT COUNT(*)::int n FROM lm_contacts
                   WHERE user_id=$1 AND disposition IN ('respondio','reunion')`, [uid]),
    ]);
    res.json({ inbox: inbox.rows[0].n, tasks: acts.rows[0].n + aprob.rows[0].n, leads: leads.rows[0].n });
  } catch (err) {
    console.error('[lm/nav-counts] error:', err.message);
    res.json({ inbox: 0, tasks: 0, leads: 0 });   // una insignia no debe tumbar el modulo
  }
});

app.get('/api/lm/inbox/threads', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH inx AS (
        SELECT contact_id,
               MAX(received_at) FILTER (WHERE tipo IN ('reply','ooo','equipo'))  AS last_in_at,
               COUNT(*)         FILTER (WHERE NOT leido AND tipo='reply')::int   AS unread,
               COUNT(*)         FILTER (WHERE tipo='bounce')::int                AS bounces
          FROM lm_inbox_messages
         WHERE user_id=$1 AND contact_id IS NOT NULL
         GROUP BY contact_id
      ),
      outx AS (
        SELECT contact_id, MAX(sent_at) AS last_out_at, COUNT(*)::int AS sent_count
          FROM lm_messages
         WHERE user_id=$1 AND estado IN ('sent','replied','bounced')
         GROUP BY contact_id
      )
      SELECT k.id AS contact_id, k.nombre, k.apellido, k.email, k.cargo,
             COALESCE(NULLIF(k.empresa_nombre,''), co.nombre, '') AS empresa,
             k.estado AS pipeline, k.disposition, k.outbound_client_id,
             oc.nombre AS cliente, mb.email AS buzon,
             i.last_in_at, COALESCE(i.unread,0) AS unread, COALESCE(i.bounces,0) AS bounces,
             o.last_out_at, COALESCE(o.sent_count,0) AS sent_count,
             li.asunto AS last_asunto, li.cuerpo AS last_snippet, li.tipo AS last_in_tipo
        FROM lm_contacts k
        LEFT JOIN inx  i ON i.contact_id = k.id
        LEFT JOIN outx o ON o.contact_id = k.id
        LEFT JOIN lm_companies co ON co.id = k.company_id
        LEFT JOIN outbound_clients oc ON oc.id = k.outbound_client_id
        LEFT JOIN lm_mailboxes mb ON mb.outbound_client_id = k.outbound_client_id AND mb.user_id = k.user_id
        LEFT JOIN LATERAL (
          SELECT asunto, LEFT(cuerpo, 160) AS cuerpo, tipo
            FROM lm_inbox_messages
           WHERE contact_id = k.id AND tipo IN ('reply','ooo','equipo')
           ORDER BY received_at DESC LIMIT 1
        ) li ON TRUE
       WHERE k.user_id=$1 AND (i.contact_id IS NOT NULL OR o.contact_id IS NOT NULL)
       ORDER BY GREATEST(COALESCE(i.last_in_at,'epoch'), COALESCE(o.last_out_at,'epoch')) DESC
       LIMIT 400
    `, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[inbox] THREADS', err.message); res.status(500).json({ error: 'Error al cargar el inbox' }); }
});

// Hilo completo de un contacto: entrantes + salientes en orden cronológico.
// Abrirlo marca como leídos los mensajes entrantes de ese contacto.
app.get('/api/lm/inbox/thread/:contactId', requireAuth, async (req, res) => {
  const cid = parseInt(req.params.contactId);
  if (!cid) return res.status(400).json({ error: 'Contacto inválido' });
  try {
    const { rows: msgs } = await pool.query(`
      SELECT * FROM (
        SELECT 'out' AS dir, m.id, m.asunto, m.cuerpo, COALESCE(m.sent_at, m.scheduled_at) AS at, m.estado, '' AS tipo,
               COALESCE(s.nombre,'') AS seq_nombre, m.step_id, mb.email AS buzon
          FROM lm_messages m
          LEFT JOIN sequences s ON s.id = m.sequence_id
          LEFT JOIN lm_mailboxes mb ON mb.id = m.mailbox_id
         WHERE m.user_id=$1 AND m.contact_id=$2 AND m.estado IN ('sent','replied','bounced','failed','scheduled')
        UNION ALL
        SELECT 'in', im.id, im.asunto, im.cuerpo, im.received_at, '', im.tipo, '', NULL, im.from_email
          FROM lm_inbox_messages im
         WHERE im.user_id=$1 AND im.contact_id=$2
        UNION ALL
        SELECT 'note', n.id, '', n.texto, n.created_at, '', 'nota', '', NULL, n.autor
          FROM lm_notes n
         WHERE n.user_id=$1 AND n.contact_id=$2
        UNION ALL
        SELECT 'fwd', f.id, f.asunto, f.cuerpo, f.sent_at, '', 'fwd', '', NULL, f.to_email
          FROM lm_forwards f
         WHERE f.user_id=$1 AND f.contact_id=$2
      ) t ORDER BY at ASC NULLS FIRST
    `, [req.workspaceOwnerId, cid]);
    await pool.query(`UPDATE lm_inbox_messages SET leido=TRUE WHERE user_id=$1 AND contact_id=$2 AND NOT leido`,
      [req.workspaceOwnerId, cid]);
    const { rows: [contact] } = await pool.query(`
      SELECT k.id, k.nombre, k.apellido, k.email, k.cargo,
             COALESCE(NULLIF(k.empresa_nombre,''), co.nombre, '') AS empresa,
             k.estado AS pipeline, k.disposition, k.outbound_client_id,
             oc.nombre AS cliente, mb.id AS mailbox_id, mb.email AS buzon, mb.estado AS buzon_estado,
             (SELECT s.nombre FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id
               WHERE cs.contact_id=k.id AND cs.user_id=$1 ORDER BY cs.created_at DESC LIMIT 1) AS seq_nombre,
             (SELECT cs.estado FROM lm_contact_sequences cs
               WHERE cs.contact_id=k.id AND cs.user_id=$1 ORDER BY cs.created_at DESC LIMIT 1) AS seq_estado
        FROM lm_contacts k
        LEFT JOIN lm_companies co ON co.id = k.company_id
        LEFT JOIN outbound_clients oc ON oc.id = k.outbound_client_id
        LEFT JOIN lm_mailboxes mb ON mb.outbound_client_id = k.outbound_client_id AND mb.user_id = k.user_id
       WHERE k.id=$2 AND k.user_id=$1
    `, [req.workspaceOwnerId, cid]);
    // A quien iria la respuesta: se calcula aqui para que la usuaria lo VEA antes
    // de escribir, en vez de descubrirlo cuando ya se envio.
    let destinatarios = { to: contact?.email ? [contact.email] : [], cc: [] };
    if (contact) {
      const { rows: [li] } = await pool.query(
        `SELECT from_email, to_emails, cc_emails FROM lm_inbox_messages
          WHERE user_id=$1 AND contact_id=$2 AND tipo IN ('reply','ooo')
          ORDER BY received_at DESC LIMIT 1`, [req.workspaceOwnerId, cid]);
      const { rows: [mbx] } = await pool.query(
        `SELECT mb.email, COALESCE(oc.cc_email,'') AS cc_email
           FROM lm_mailboxes mb LEFT JOIN outbound_clients oc ON oc.id = mb.outbound_client_id
          WHERE mb.outbound_client_id=$1 AND mb.user_id=$2 LIMIT 1`,
        [contact.outbound_client_id, req.workspaceOwnerId]);
      const lista = t => String(t || '').split(/[,;]/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@'));
      const mios = new Set([String(mbx?.email || '').toLowerCase(), String(mbx?.cc_email || '').toLowerCase()].filter(Boolean));
      const to = [String(contact.email || '').toLowerCase()].filter(Boolean);
      if (li?.from_email && !mios.has(li.from_email.toLowerCase()) && !to.includes(li.from_email.toLowerCase())) to.push(li.from_email.toLowerCase());
      let cc = li ? [...lista(li.to_emails), ...lista(li.cc_emails)].filter(a => !mios.has(a) && !to.includes(a)) : [];
      if (mbx?.cc_email) cc.push(String(mbx.cc_email).toLowerCase());
      destinatarios = { to, cc: [...new Set(cc)].filter(a => !to.includes(a)) };
    }
    res.json({ contact: contact || null, messages: msgs, destinatarios });
  } catch (err) { console.error('[inbox] THREAD', err.message); res.status(500).json({ error: 'Error al cargar el hilo' }); }
});

// Nota interna sobre un contacto (modo "Nota" del Inbox) — NUNCA se manda como
// email, solo queda visible para el equipo dentro del mismo hilo. Sirve para
// preguntas/comentarios internos (ej. "¿qué le contesto a esto?") sin arriesgar
// que le llegue nada al prospecto por error.
app.post('/api/lm/inbox/note', requireAuth, async (req, res) => {
  const b = req.body || {};
  const cid = parseInt(b.contact_id);
  const texto = String(b.texto || '').trim();
  if (!cid || !texto) return res.status(400).json({ error: 'Falta el contacto o el texto' });
  try {
    const { rows: [k] } = await pool.query(
      `SELECT id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, req.workspaceOwnerId]);
    if (!k) return res.status(404).json({ error: 'Contacto no encontrado' });
    const { rows: tm } = await pool.query(
      `SELECT id, nombre FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [req.workspaceOwnerId, req.user.email]);
    const memberId = tm[0]?.id || null;
    const autor = tm[0]?.nombre || req.user.name || 'Equipo';
    const { rows: [nota] } = await pool.query(
      `INSERT INTO lm_notes (user_id, contact_id, member_id, autor, texto)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, autor, texto, created_at`,
      [req.workspaceOwnerId, cid, memberId, autor, texto]);
    res.json({ ok: true, nota });
  } catch (err) { console.error('[inbox] NOTE', err.message); res.status(500).json({ error: 'No se pudo guardar la nota' }); }
});

// Responder desde el buzón del cliente (threading real con In-Reply-To).
app.post('/api/lm/inbox/reply', requireAuth, async (req, res) => {
  const b = req.body || {};
  const cid = parseInt(b.contact_id);
  const cuerpo = String(b.cuerpo || '').trim();
  if (!cid || !cuerpo) return res.status(400).json({ error: 'Falta el contacto o el mensaje' });
  try {
    const { rows: [k] } = await pool.query(
      `SELECT k.*, mb.id AS mb_id FROM lm_contacts k
        LEFT JOIN lm_mailboxes mb ON mb.outbound_client_id = k.outbound_client_id
             AND mb.user_id = k.user_id AND mb.estado IN ('conectado','solo_envio')
       WHERE k.id=$1 AND k.user_id=$2`, [cid, req.workspaceOwnerId]);
    if (!k) return res.status(404).json({ error: 'Contacto no encontrado' });
    if (!k.email) return res.status(400).json({ error: 'El contacto no tiene email' });
    if (!k.mb_id) return res.status(400).json({ error: 'El cliente de este contacto no tiene buzón conectado' });
    const { rows: [mb] } = await pool.query(`SELECT * FROM lm_mailboxes WHERE id=$1`, [k.mb_id]);

    // Threading: responder al último entrante (Message-ID + asunto con Re:).
    const { rows: [lastIn] } = await pool.query(
      `SELECT message_id, asunto, from_email, to_emails, cc_emails FROM lm_inbox_messages
        WHERE user_id=$1 AND contact_id=$2 AND tipo IN ('reply','ooo')
        ORDER BY received_at DESC LIMIT 1`, [req.workspaceOwnerId, cid]);

    // Responder a TODOS: quien escribio + los que iban en Para y en CC. Si solo se
    // contestara al contacto, la gente en copia se cae del hilo sin enterarse.
    const _lista = t => String(t || '').split(/[,;]/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@'));
    const _mios = new Set([String(mb.email || '').toLowerCase(), String(mb.cc_email || '').toLowerCase()].filter(Boolean));
    const replyAll = b.reply_all !== false;
    const to = [String(k.email).toLowerCase()];
    if (lastIn?.from_email && !_mios.has(String(lastIn.from_email).toLowerCase())) {
      const f = String(lastIn.from_email).toLowerCase();
      if (!to.includes(f)) to.push(f);
    }
    let cc = [];
    if (replyAll && lastIn) {
      cc = [..._lista(lastIn.to_emails), ..._lista(lastIn.cc_emails)]
        .filter(a => !_mios.has(a) && !to.includes(a));
    }
    if (Array.isArray(b.cc)) cc = b.cc.map(x => String(x).trim().toLowerCase()).filter(x => x.includes('@'));
    // El CC fijo del cliente (lo que ya hacia el motor) se respeta siempre.
    if (mb.cc_email && !cc.includes(String(mb.cc_email).toLowerCase())) cc.push(String(mb.cc_email).toLowerCase());
    cc = [...new Set(cc)].filter(a => !to.includes(a));
    let asunto = String(b.asunto || '').trim();
    if (!asunto) asunto = lastIn?.asunto ? (/^re:/i.test(lastIn.asunto) ? lastIn.asunto : `Re: ${lastIn.asunto}`) : '(sin asunto)';

    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a2e">${esc(cuerpo).replace(/\n/g, '<br>')}</div>`;

    // ── Envío programado: se guarda 'scheduled' y el motor lo despacha al vencer ──
    const schedAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (schedAt && !isNaN(schedAt) && schedAt.getTime() > Date.now() + 30 * 1000) {
      const { rows: [msg] } = await pool.query(
        `INSERT INTO lm_messages (user_id, contact_id, asunto, cuerpo, to_email, estado, scheduled_at, mailbox_id, in_reply_to, cc_emails)
         VALUES ($1,$2,$3,$4,$5,'scheduled',$6,$7,$8,$9) RETURNING id, asunto, cuerpo, scheduled_at`,
        [req.workspaceOwnerId, cid, asunto, cuerpo, to.join(', '), schedAt.toISOString(), mb.id, lastIn?.message_id || '', cc.join(', ')]);
      return res.status(201).json({ ok: true, scheduled: true, message: msg });
    }

    const auth = await mailboxSvc.getMailboxAuth(pool, mb);
    const sent = await mailboxSvc.sendFromMailbox(mb, auth, {
      to: to.join(', '), cc: cc.length ? cc.join(', ') : undefined,
      subject: asunto, text: cuerpo, html,
      fromName: String(b.from_name || '').trim() || mb.from_name || undefined,
      inReplyTo: lastIn?.message_id || undefined,
      references: lastIn?.message_id || undefined,
    });
    const { rows: [msg] } = await pool.query(
      `INSERT INTO lm_messages (user_id, contact_id, asunto, cuerpo, to_email, estado, sent_at, mailbox_id, smtp_message_id)
       VALUES ($1,$2,$3,$4,$5,'sent',NOW(),$6,$7) RETURNING id, asunto, cuerpo, sent_at`,
      [req.workspaceOwnerId, cid, asunto, cuerpo, to.join(', '), mb.id, sent.messageId || '']);
    await pool.query(
      `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,'email','email',$3,NOW(),'hecha')`,
      [req.workspaceOwnerId, cid, `[Inbox] Respuesta enviada: ${asunto}`]);
    res.status(201).json({ ok: true, message: msg, to, cc });
  } catch (err) {
    console.error('[inbox] REPLY', err.message);
    res.status(500).json({ error: mailboxSvc._friendlyErr(err) });
  }
});

// Reenviar (Forward): manda por email real el mensaje que se está viendo del
// hilo a alguien que NO es el prospecto (un compañero, alguien nuevo) — sale
// del MISMO buzón, así que si esa persona responde, el vigilante IMAP ya lo
// captura solo en este mismo hilo (tipo='equipo'). Se guarda en lm_forwards,
// separado de lm_messages, para no contar como "ya le respondí al prospecto".
app.post('/api/lm/inbox/forward', requireAuth, async (req, res) => {
  const b = req.body || {};
  const cid = parseInt(b.contact_id);
  const to = String(b.to || '').trim();
  const texto = String(b.texto || '').trim();
  if (!cid || !to) return res.status(400).json({ error: 'Falta el contacto o el destinatario' });
  try {
    const { rows: [k] } = await pool.query(
      `SELECT k.*, mb.id AS mb_id FROM lm_contacts k
        LEFT JOIN lm_mailboxes mb ON mb.outbound_client_id = k.outbound_client_id
             AND mb.user_id = k.user_id AND mb.estado IN ('conectado','solo_envio')
       WHERE k.id=$1 AND k.user_id=$2`, [cid, req.workspaceOwnerId]);
    if (!k) return res.status(404).json({ error: 'Contacto no encontrado' });
    if (!k.mb_id) return res.status(400).json({ error: 'El cliente de este contacto no tiene buzón conectado' });
    const { rows: [mb] } = await pool.query(`SELECT * FROM lm_mailboxes WHERE id=$1`, [k.mb_id]);

    const origAsunto = String(b.orig_asunto || '').trim();
    const origCuerpo = String(b.orig_cuerpo || '');
    const origFrom   = String(b.orig_from || '').trim();
    const origAt     = b.orig_at ? new Date(b.orig_at) : null;
    const origAtStr  = origAt && !isNaN(origAt) ? origAt.toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    const asunto = origAsunto ? (/^fwd:/i.test(origAsunto) ? origAsunto : `Fwd: ${origAsunto}`) : 'Fwd: (sin asunto)';
    const cuerpo = `${texto}${texto ? '\n\n' : ''}---------- Mensaje reenviado ----------\n`
      + `${origFrom ? `De: ${origFrom}\n` : ''}${origAtStr ? `Fecha: ${origAtStr}\n` : ''}${origAsunto ? `Asunto: ${origAsunto}\n` : ''}\n${origCuerpo}`;

    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a2e">${esc(texto).replace(/\n/g, '<br>')}`
      + `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #ddd;color:#555;font-size:13px">`
      + `<b>---------- Mensaje reenviado ----------</b><br>`
      + `${origFrom ? `De: ${esc(origFrom)}<br>` : ''}${origAtStr ? `Fecha: ${esc(origAtStr)}<br>` : ''}${origAsunto ? `Asunto: ${esc(origAsunto)}<br>` : ''}`
      + `<br>${esc(origCuerpo).replace(/\n/g, '<br>')}</div></div>`;

    const auth = await mailboxSvc.getMailboxAuth(pool, mb);
    const sent = await mailboxSvc.sendFromMailbox(mb, auth, {
      to, subject: asunto, text: cuerpo, html,
      fromName: mb.from_name || undefined,
    });
    const { rows: [fwd] } = await pool.query(
      `INSERT INTO lm_forwards (user_id, contact_id, mailbox_id, to_email, asunto, cuerpo, smtp_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, to_email, asunto, cuerpo, sent_at`,
      [req.workspaceOwnerId, cid, mb.id, to, asunto, texto, sent.messageId || '']);
    res.status(201).json({ ok: true, fwd });
  } catch (err) {
    console.error('[inbox] FORWARD', err.message);
    res.status(500).json({ error: mailboxSvc._friendlyErr(err) });
  }
});

// Marcar el hilo como no leido: abrirlo lo marca leido automaticamente, y a veces
// solo se echa un vistazo y se quiere dejar pendiente.
app.patch('/api/lm/inbox/thread/:contactId/unread', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE lm_inbox_messages SET leido=FALSE
        WHERE user_id=$1 AND contact_id=$2 AND tipo='reply'
          AND id = (SELECT id FROM lm_inbox_messages
                     WHERE user_id=$1 AND contact_id=$2 AND tipo='reply'
                     ORDER BY received_at DESC LIMIT 1)`,
      [req.workspaceOwnerId, req.params.contactId]);
    res.json({ ok: true, unread: rowCount });
  } catch (err) {
    console.error('[inbox] unread', err.message);
    res.status(500).json({ error: 'No se pudo marcar como no leído' });
  }
});

// ── Aprobaciones (modo pre-aprobado): borradores que el motor dejó esperando ──
app.get('/api/lm/sequences/:id/approvals', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.contact_id, m.step_id, m.asunto, m.cuerpo, m.to_email, m.estado, m.created_at, m.scheduled_at,
             k.nombre, k.apellido, k.cargo, COALESCE(NULLIF(k.empresa_nombre,''), co.nombre, '') AS empresa,
             st.dia AS paso_dia, st.titulo AS paso_titulo, COALESCE(st.cc_off, FALSE) AS cc_off
        FROM lm_messages m
        JOIN lm_contacts k ON k.id = m.contact_id
        LEFT JOIN lm_companies co ON co.id = k.company_id
        LEFT JOIN sequence_steps st ON st.id = m.step_id
       WHERE m.user_id=$1 AND m.sequence_id=$2 AND m.estado IN ('awaiting','approved')
       ORDER BY m.created_at ASC
    `, [req.workspaceOwnerId, req.params.id]);
    res.json(rows);
  } catch (err) { console.error('[approvals] GET', err.message); res.status(500).json({ error: 'Error al cargar aprobaciones' }); }
});
// Lista GLOBAL de borradores por aprobar (para la lista de Tareas comerciales).
app.get('/api/lm/approvals', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.sequence_id, m.contact_id, m.asunto, m.to_email, m.scheduled_at,
             s.nombre AS seq_nombre,
             k.nombre, k.apellido, COALESCE(NULLIF(k.empresa_nombre,''), co.nombre, '') AS empresa
        FROM lm_messages m
        JOIN sequences s ON s.id = m.sequence_id
        JOIN lm_contacts k ON k.id = m.contact_id
        LEFT JOIN lm_companies co ON co.id = k.company_id
       WHERE m.user_id=$1 AND m.estado='awaiting'
       ORDER BY m.scheduled_at ASC NULLS FIRST, m.created_at ASC
       LIMIT 100
    `, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[approvals] GET all', err.message); res.status(500).json({ error: 'Error al cargar aprobaciones' }); }
});
// action: 'save' (editar sin aprobar) | 'approve' (sale en el próximo tick, espaciado
// por el intervalo de la secuencia) | 'discard' (no se envía y el contacto avanza de paso).
app.put('/api/lm/approvals/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const action = ['save', 'approve', 'discard'].includes(b.action) ? b.action : 'save';
  try {
    const { rows: [m] } = await pool.query(
      `SELECT * FROM lm_messages WHERE id=$1 AND user_id=$2 AND estado IN ('awaiting','approved')`,
      [req.params.id, req.workspaceOwnerId]);
    if (!m) return res.status(404).json({ error: 'Ese borrador ya salió o no existe' });
    if (action === 'discard') {
      await pool.query(`DELETE FROM lm_messages WHERE id=$1`, [m.id]);
      const { advancePastStep } = require('./services/sendEngine');
      await advancePastStep(pool, req.workspaceOwnerId, m.contact_id, m.sequence_id, m.step_id);
      return res.json({ ok: true, discarded: true });
    }
    const asunto = String(b.asunto ?? m.asunto).trim() || m.asunto;
    const cuerpo = String(b.cuerpo ?? m.cuerpo);
    const estado = action === 'approve' ? 'approved' : 'awaiting';
    const { rows: [upd] } = await pool.query(
      `UPDATE lm_messages SET asunto=$1, cuerpo=$2, estado=$3 WHERE id=$4 RETURNING id, asunto, cuerpo, estado`,
      [asunto, cuerpo, estado, m.id]);
    res.json({ ok: true, message: upd });
  } catch (err) { console.error('[approvals] PUT', err.message); res.status(500).json({ error: 'Error al actualizar el borrador' }); }
});

// Cancelar un envío programado (solo mientras siga 'scheduled').
app.delete('/api/lm/inbox/scheduled/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM lm_messages WHERE id=$1 AND user_id=$2 AND estado='scheduled'`,
      [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Ese envío ya salió o no existe' });
    res.json({ ok: true });
  } catch (err) { console.error('[inbox] SCHED DEL', err.message); res.status(500).json({ error: 'Error al cancelar' }); }
});

// LM FASE A — motor de envío: settings, tracking, mensajes, verificación
// ═══════════════════════════════════════════════════════════════════

// ── Tracking público (sin auth: lo llaman los clientes de correo) ──
const _TRACK_PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
app.get('/t/o/:token.png', async (req, res) => {
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store, max-age=0' });
  res.end(_TRACK_PX);
  try {
    const { rows: [m] } = await pool.query(`SELECT id, sent_at FROM lm_messages WHERE track_token=$1`, [req.params.token]);
    if (m) {
      // Anti-inflado de aperturas: los proxies de imágenes (Gmail/Apple) y los escáneres
      // antispam disparan el píxel al ENTREGAR el correo y en cada re-render de la vista.
      // 1) Se ignoran "aperturas" en los primeros 90s tras el envío (prefetch, no humano).
      // 2) Se deduplica: máx. 1 apertura registrada por mensaje cada 15 minutos.
      if (m.sent_at && Date.now() - new Date(m.sent_at).getTime() < 90 * 1000) return;
      await pool.query(
        `INSERT INTO lm_message_events (message_id, tipo, ip, user_agent)
         SELECT $1, 'open', $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM lm_message_events
             WHERE message_id=$1 AND tipo='open' AND created_at > NOW() - interval '15 minutes')`,
        [m.id, (req.headers['x-forwarded-for'] || req.ip || '').slice(0, 100), (req.headers['user-agent'] || '').slice(0, 300)]
      );
    }
  } catch (e) { /* tracking nunca rompe nada */ }
});
app.get('/t/c/:token', async (req, res) => {
  const url = String(req.query.url || '');
  // solo redirigir a http(s) — nunca javascript: u otros esquemas
  const safe = /^https?:\/\//i.test(url) ? url : 'https://kiwoc.com';
  res.redirect(302, safe);
  try {
    const { rows: [m] } = await pool.query(`SELECT id FROM lm_messages WHERE track_token=$1`, [req.params.token]);
    if (m) await pool.query(
      `INSERT INTO lm_message_events (message_id, tipo, url, ip, user_agent) VALUES ($1,'click',$2,$3,$4)`,
      [m.id, safe.slice(0, 800), (req.headers['x-forwarded-for'] || req.ip || '').slice(0, 100), (req.headers['user-agent'] || '').slice(0, 300)]
    );
  } catch (e) { /* tracking nunca rompe nada */ }
});

// ── Configuración de envío (singleton por workspace, patrón fin_config) ──
app.get('/api/lm/send-settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM lm_send_settings WHERE user_id=$1`, [req.workspaceOwnerId]);
    res.json(rows[0] || {
      user_id: req.workspaceOwnerId, enabled: false, from_name: '', daily_limit: 30,
      throttle_seconds: 90, window_start: 9, window_end: 18, send_weekends: false,
      timezone: 'America/Lima', firma: '', track_opens: true, track_clicks: true,
    });
  } catch (err) { console.error('[lm-send-cfg] GET', err.message); res.status(500).json({ error: 'Error al cargar configuración' }); }
});
app.put('/api/lm/send-settings', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query(`
      INSERT INTO lm_send_settings (user_id, enabled, from_name, daily_limit, throttle_seconds,
                                    window_start, window_end, send_weekends, timezone, firma,
                                    track_opens, track_clicks, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        enabled=$2, from_name=$3, daily_limit=$4, throttle_seconds=$5, window_start=$6,
        window_end=$7, send_weekends=$8, timezone=$9, firma=$10, track_opens=$11,
        track_clicks=$12, updated_at=NOW()
      RETURNING *
    `, [req.workspaceOwnerId, !!b.enabled, String(b.from_name || '').slice(0, 120),
        Math.min(Math.max(parseInt(b.daily_limit) || 30, 1), 200),
        Math.min(Math.max(parseInt(b.throttle_seconds) || 90, 30), 3600),
        Math.min(Math.max(parseInt(b.window_start) ?? 9, 0), 23),
        Math.min(Math.max(parseInt(b.window_end) ?? 18, 1), 24),
        !!b.send_weekends, String(b.timezone || 'America/Lima').slice(0, 60),
        String(b.firma || '').slice(0, 4000), b.track_opens !== false, b.track_clicks !== false]);
    res.json(rows[0]);
  } catch (err) { console.error('[lm-send-cfg] PUT', err.message); res.status(500).json({ error: 'Error al guardar configuración' }); }
});

// ── Mensajes enviados (con conteo de opens/clicks por mensaje) ──
app.get('/api/lm/messages', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const cid = parseInt(req.query.contact_id) || null;
  const sid = parseInt(req.query.sequence_id) || null;
  const lim = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.contact_id, m.sequence_id, m.step_id, m.asunto, m.to_email, m.estado,
             m.error, m.sent_at, m.replied_at, m.created_at,
             k.nombre, k.apellido, s.nombre AS seq_nombre,
             (SELECT COUNT(*)::int FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='open')  AS opens,
             (SELECT COUNT(*)::int FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='click') AS clicks
        FROM lm_messages m
        JOIN lm_contacts k ON k.id = m.contact_id
        LEFT JOIN sequences s ON s.id = m.sequence_id
       WHERE m.user_id=$1
         AND ($2::int IS NULL OR m.contact_id=$2)
         AND ($3::int IS NULL OR m.sequence_id=$3)
       ORDER BY m.created_at DESC LIMIT $4
    `, [uid, cid, sid, lim]);
    res.json(rows);
  } catch (err) { console.error('[lm-msgs] GET', err.message); res.status(500).json({ error: 'Error al cargar mensajes' }); }
});

// "Acciones del lead": línea de tiempo real de cada email enviado a este contacto —
// cuándo se mandó, cada apertura (con hora) y cada clic (con hora y qué link) — no
// solo el conteo agregado que ya devuelve /api/lm/messages. Los eventos ya se
// capturan hace rato en lm_message_events (pixel de apertura + redirect de clics);
// esto solo expone esa data cruda para mostrarla como historial.
app.get('/api/lm/contacts/:id/track-events', requireAuth, async (req, res) => {
  const cid = parseInt(req.params.id);
  if (!cid) return res.status(400).json({ error: 'Contacto inválido' });
  try {
    const { rows: messages } = await pool.query(
      `SELECT m.id, m.asunto, m.to_email, m.cc_emails, m.estado, m.sent_at, mb.email AS mailbox_email
        FROM lm_messages m LEFT JOIN lm_mailboxes mb ON mb.id = m.mailbox_id
        WHERE m.user_id=$1 AND m.contact_id=$2 AND m.sent_at IS NOT NULL
        ORDER BY m.sent_at DESC LIMIT 50`, [req.workspaceOwnerId, cid]);
    const ids = messages.map(m => m.id);
    let events = [];
    if (ids.length) {
      const { rows } = await pool.query(
        `SELECT message_id, tipo, url, created_at FROM lm_message_events
          WHERE message_id = ANY($1) ORDER BY created_at ASC`, [ids]);
      events = rows;
    }
    const byMsg = new Map(messages.map(m => [m.id, { ...m, events: [] }]));
    for (const e of events) { const m = byMsg.get(e.message_id); if (m) m.events.push(e); }

    // También los RECIBIDOS (respuestas reales, auto-respuestas, mensajes del
    // equipo) — Jenny quiere ver la correspondencia completa acá, no solo lo
    // que se mandó.
    const { rows: received } = await pool.query(
      `SELECT i.id, i.asunto, i.from_email, i.to_emails, i.cc_emails, i.tipo, i.received_at, mb.email AS mailbox_email
        FROM lm_inbox_messages i LEFT JOIN lm_mailboxes mb ON mb.id = i.mailbox_id
        WHERE i.user_id=$1 AND i.contact_id=$2 ORDER BY i.received_at DESC LIMIT 50`,
      [req.workspaceOwnerId, cid]);

    res.json({ sent: [...byMsg.values()], received });
  } catch (err) { console.error('[track-events] GET', err.message); res.status(500).json({ error: 'Error al cargar el historial' }); }
});

// ── Verificación/enriquecimiento de contactos (cola con el pipeline propio) ──
app.post('/api/lm/contacts/verify-email', requireAuth, (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Sin contactos seleccionados' });
  if (ids.length > 500) return res.status(400).json({ error: 'Máximo 500 contactos por lote' });
  const { queueVerify } = require('./services/lmVerifyService');
  res.json(queueVerify(pool, req.workspaceOwnerId, ids));
});

// ── Card "Hoy": qué pasa hoy en el outreach ──
app.get('/api/lm/today', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  try {
    const [cfg, dueQ, sentQ, repliesQ, tasksQ, failedQ] = await Promise.all([
      pool.query(`SELECT * FROM lm_send_settings WHERE user_id=$1`, [uid]),
      pool.query(`
        SELECT COUNT(*)::int AS n FROM lm_contact_sequences cs
          JOIN sequences s ON s.id=cs.sequence_id AND s.estado='activa'
         WHERE cs.user_id=$1 AND cs.estado='activo'
           AND (cs.next_action_at IS NULL OR cs.next_action_at <= NOW() + interval '24 hours')`, [uid]),
      pool.query(`
        SELECT COUNT(*)::int AS n FROM lm_messages
         WHERE user_id=$1 AND estado IN ('sent','replied') AND sent_at::date = CURRENT_DATE`, [uid]),
      pool.query(`
        SELECT m.id, m.asunto, m.replied_at, k.id AS contact_id, k.nombre, k.apellido,
               k.empresa_nombre, co.nombre AS company_nombre,
               (SELECT e.url FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='reply' ORDER BY e.created_at DESC LIMIT 1) AS snippet
          FROM lm_messages m JOIN lm_contacts k ON k.id=m.contact_id
          LEFT JOIN lm_companies co ON co.id=k.company_id
         WHERE m.user_id=$1 AND m.estado='replied' AND m.replied_at > NOW() - interval '48 hours'
         ORDER BY m.replied_at DESC LIMIT 10`, [uid]),
      pool.query(`
        SELECT a.id, a.canal, a.nota, a.fecha, k.id AS contact_id, k.nombre, k.apellido
          FROM activities a JOIN lm_contacts k ON k.id=a.contact_id
         WHERE a.user_id=$1 AND a.estado='pendiente'
         ORDER BY a.fecha ASC LIMIT 20`, [uid]),
      pool.query(`
        SELECT COUNT(*)::int AS n FROM lm_messages
         WHERE user_id=$1 AND estado='failed' AND created_at > NOW() - interval '48 hours'`, [uid]),
    ]);
    const { gmailStatus } = require('./services/gmailService');
    const gmail = await gmailStatus(pool, uid);
    res.json({
      settings:     cfg.rows[0] || { enabled: false },
      gmail,
      due_24h:      dueQ.rows[0].n,
      sent_today:   sentQ.rows[0].n,
      daily_limit:  cfg.rows[0]?.daily_limit ?? 30,
      replies:      repliesQ.rows,
      manual_tasks: tasksQ.rows,
      failed_48h:   failedQ.rows[0].n,
    });
  } catch (err) { console.error('[lm-today] GET', err.message); res.status(500).json({ error: 'Error al cargar resumen' }); }
});

// ── LM · A/B (Fase B3): métricas por variante de cada paso email ──
// Combina: envíos AUTOMÁTICOS (lm_messages: funnel completo con opens/clics/replies)
// + touches MANUALES (activities.variant: enviados, y respuestas atribuidas a la
// última variante tocada del contacto antes de responder).
app.get('/api/lm/sequences/:id/ab-metrics', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, sid = parseInt(req.params.id);
  try {
    const { rows: steps } = await pool.query(
      `SELECT id, dia, titulo, canal, variants, variant_mode FROM sequence_steps
        WHERE sequence_id=$1 ORDER BY dia ASC, orden ASC, id ASC`, [sid]);

    // Automático: funnel por paso+variante desde lm_messages
    const { rows: auto } = await pool.query(`
      SELECT m.step_id, m.variant,
             COUNT(*) FILTER (WHERE m.estado IN ('sent','replied','bounced'))::int AS enviados,
             COUNT(DISTINCT m.id) FILTER (WHERE EXISTS (SELECT 1 FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='open'))::int AS aperturas,
             COUNT(DISTINCT m.id) FILTER (WHERE EXISTS (SELECT 1 FROM lm_message_events e WHERE e.message_id=m.id AND e.tipo='click'))::int AS clics,
             COUNT(*) FILTER (WHERE m.estado='replied')::int AS respuestas
        FROM lm_messages m
       WHERE m.user_id=$1 AND m.sequence_id=$2 AND m.variant <> ''
       GROUP BY m.step_id, m.variant`, [uid, sid]);

    // Manual: enviados por variante (activities de contactos enrolados en esta secuencia)
    const { rows: manual } = await pool.query(`
      WITH enrolled AS (SELECT contact_id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2)
      SELECT a.variant, COUNT(*)::int AS enviados, COUNT(DISTINCT a.contact_id)::int AS contactos
        FROM activities a
       WHERE a.user_id=$1 AND a.variant <> '' AND a.estado='hecha'
         AND a.contact_id IN (SELECT contact_id FROM enrolled)
       GROUP BY a.variant`, [uid, sid]);

    // Manual: respuestas atribuidas a la ÚLTIMA variante tocada antes de la respuesta
    const { rows: manualReplies } = await pool.query(`
      WITH enrolled AS (SELECT contact_id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2),
      first_reply AS (
        SELECT a.contact_id, MIN(a.created_at) AS at FROM activities a
         WHERE a.user_id=$1 AND a.tipo='respuesta'
           AND a.contact_id IN (SELECT contact_id FROM enrolled)
         GROUP BY a.contact_id)
      SELECT lastv.variant, COUNT(DISTINCT r.contact_id)::int AS respuestas
        FROM first_reply r
        JOIN LATERAL (
          SELECT t.variant FROM activities t
           WHERE t.user_id=$1 AND t.contact_id=r.contact_id AND t.variant <> '' AND t.created_at <= r.at
           ORDER BY t.created_at DESC LIMIT 1) lastv ON TRUE
       GROUP BY lastv.variant`, [uid, sid]);

    res.json({ steps, auto, manual, manual_replies: manualReplies });
  } catch (err) { console.error('[lm-ab] GET', err.message); res.status(500).json({ error: 'Error al cargar métricas A/B' }); }
});

// ── LM · Personalización con IA (Fable 5 alto valor · Haiku volumen) ──
app.get('/api/lm/ai/settings', requireAuth, async (req, res) => {
  try {
    const { getSettings } = require('./services/aiPersonalizeService');
    res.json(await getSettings(pool, req.workspaceOwnerId));
  } catch (err) { console.error('[lm-ai-cfg] GET', err.message); res.status(500).json({ error: 'Error al cargar configuración de IA' }); }
});
app.put('/api/lm/ai/settings', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query(`
      INSERT INTO lm_ai_settings (user_id, enabled, monthly_budget_usd, model_high, model_volume, idioma, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        enabled=$2, monthly_budget_usd=$3, model_high=$4, model_volume=$5, idioma=$6, updated_at=NOW()
      RETURNING *
    `, [req.workspaceOwnerId, b.enabled !== false,
        Math.min(Math.max(parseFloat(b.monthly_budget_usd) || 20, 0), 100000),
        String(b.model_high || 'claude-fable-5').slice(0, 60),
        String(b.model_volume || 'claude-haiku-4-5').slice(0, 60),
        String(b.idioma || 'auto').slice(0, 30)]);
    res.json(rows[0]);
  } catch (err) { console.error('[lm-ai-cfg] PUT', err.message); res.status(500).json({ error: 'Error al guardar configuración de IA' }); }
});
// Encolar personalización (1 o varios contactos). tier opcional ('alto'|'volumen'); si falta, se auto-decide.
app.post('/api/lm/ai/personalize', requireAuth, (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.contact_ids) ? b.contact_ids.map(Number).filter(Boolean)
            : (b.contact_id ? [Number(b.contact_id)] : []);
  if (!ids.length) return res.status(400).json({ error: 'Sin contactos' });
  if (ids.length > 200) return res.status(400).json({ error: 'Máximo 200 por lote' });
  const stepId = b.step_id ? (parseInt(b.step_id) || null) : null;
  const seqId  = b.sequence_id ? (parseInt(b.sequence_id) || null) : null;
  const tier   = (b.tier === 'alto' || b.tier === 'volumen') ? b.tier : null;
  const { queuePersonalize } = require('./services/aiPersonalizeService');
  const items = ids.map(contactId => ({ contactId, stepId, sequenceId: seqId, tier }));
  res.json(queuePersonalize(pool, req.workspaceOwnerId, items));
});
app.get('/api/lm/ai/drafts', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const cid = parseInt(req.query.contact_id) || null;
  const sid = parseInt(req.query.sequence_id) || null;
  try {
    const { rows } = await pool.query(`
      SELECT d.*, k.nombre, k.apellido, k.empresa_nombre, co.nombre AS company_nombre
        FROM lm_ai_drafts d
        JOIN lm_contacts k ON k.id = d.contact_id
        LEFT JOIN lm_companies co ON co.id = k.company_id
       WHERE d.user_id=$1
         AND ($2::int IS NULL OR d.contact_id=$2)
         AND ($3::int IS NULL OR d.sequence_id=$3)
       ORDER BY d.created_at DESC LIMIT 300
    `, [uid, cid, sid]);
    res.json(rows);
  } catch (err) { console.error('[lm-ai-drafts] GET', err.message); res.status(500).json({ error: 'Error al cargar borradores' }); }
});
app.put('/api/lm/ai/drafts/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.asunto != null) { vals.push(String(b.asunto).slice(0, 300)); sets.push(`asunto=$${vals.length}`); }
  if (b.cuerpo != null) { vals.push(String(b.cuerpo).slice(0, 4000)); sets.push(`cuerpo=$${vals.length}`); }
  if (b.status != null && ['draft', 'approved', 'discarded'].includes(b.status)) { vals.push(b.status); sets.push(`status=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  vals.push(req.workspaceOwnerId, req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE lm_ai_drafts SET ${sets.join(',')}, updated_at=NOW()
        WHERE user_id=$${vals.length - 1} AND id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Borrador no encontrado' });
    res.json(rows[0]);
  } catch (err) { console.error('[lm-ai-drafts] PUT', err.message); res.status(500).json({ error: 'Error al actualizar borrador' }); }
});
app.delete('/api/lm/ai/drafts/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_ai_drafts WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Borrador no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[lm-ai-drafts] DEL', err.message); res.status(500).json({ error: 'Error al eliminar borrador' }); }
});

// ── LM · Comentario de LinkedIn generado con IA ────────────────────
// Jenny pega la publicación, la IA redacta el comentario con la instrucción
// del paso. Ella copia, pega en LinkedIn a mano y marca la tarea como hecha.
app.post('/api/lm/ai/comment', requireAuth, async (req, res) => {
  const b = req.body || {};
  const contactId = parseInt(b.contact_id) || 0;
  if (!contactId) return res.status(400).json({ error: 'Falta el contacto' });
  try {
    const { generateComment } = require('./services/aiPersonalizeService');
    res.json(await generateComment(pool, req.workspaceOwnerId, {
      contactId,
      stepId:     parseInt(b.step_id) || null,
      sequenceId: parseInt(b.sequence_id) || null,
      prompt:     String(b.prompt || '').slice(0, 4000),
      post:       String(b.post || '').slice(0, 12000),
    }));
  } catch (err) {
    console.error('[lm-ai-comment]', err.message);
    res.status(400).json({ error: err.message || 'No se pudo generar el comentario' });
  }
});
// Registrar en el historial del contacto el comentario que Jenny copió.
// Idempotente por contacto+día: regenerar y volver a copiar actualiza la misma fila.
app.post('/api/lm/ai/comment/log', requireAuth, async (req, res) => {
  const b = req.body || {};
  const uid = req.workspaceOwnerId;
  const cid = parseInt(b.contact_id) || 0;
  const texto = String(b.comentario || '').trim().slice(0, 2000);
  if (!cid || !texto) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const { rows: [k] } = await pool.query(
      `SELECT outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid]);
    if (!k) return res.status(404).json({ error: 'Contacto no encontrado' });
    const nota = `💬 Comentario en LinkedIn: ${texto}`;
    const { rows: prev } = await pool.query(
      `SELECT id FROM activities
        WHERE user_id=$1 AND contact_id=$2 AND tipo='comentario_li' AND fecha::date = CURRENT_DATE
        ORDER BY id DESC LIMIT 1`, [uid, cid]);
    if (prev.length) {
      await pool.query(`UPDATE activities SET nota=$1, fecha=NOW() WHERE id=$2`, [nota, prev[0].id]);
      return res.json({ ok: true, id: prev[0].id, updated: true });
    }
    const { rows: [ins] } = await pool.query(
      `INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, canal, nota, fecha, estado)
       VALUES ($1,$2,$3,'comentario_li','linkedin',$4,NOW(),'hecha') RETURNING id`,
      [uid, cid, k.outbound_client_id || null, nota]);
    res.json({ ok: true, id: ins.id });
  } catch (err) {
    console.error('[lm-ai-comment-log]', err.message);
    res.status(500).json({ error: 'No se pudo registrar el comentario' });
  }
});

// ── Importación con mapeo (Excel/CSV → empresas + contactos) ───────
const LM_IMPORT_MAX = 5000;
app.post('/api/lm/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });
  const uid       = req.workspaceOwnerId;
  const target    = req.body?.target === 'companies' ? 'companies' : 'contacts';
  const obcId     = req.body?.outbound_client_id ? (parseInt(req.body.outbound_client_id) || null) : null;
  const hasHeader = req.body?.hasHeader !== '0' && req.body?.hasHeader !== 'false';
  // Activo por defecto: si el contacto/empresa ya existe (por ID/email, o por dominio/nombre de
  // empresa), se actualiza en vez de duplicarse. Si se apaga, las filas que ya existen se saltan tal cual.
  const updateExisting = req.body?.updateExisting !== '0' && req.body?.updateExisting !== 'false';
  let mapping = {};
  try { mapping = JSON.parse(req.body?.mapping || '{}') || {}; } catch (_) {}

  let rows;
  try {
    // Lectura robusta compartida con parse-headers: corrige encoding CP1252
    // (tildes rotas) y detecta separador ';'/'\t' de Excel en español.
    const { readTabular } = require('./services/excelService');
    rows = readTabular(req.file.buffer, req.file.originalname || '');
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el archivo: ' + e.message });
  }
  if (!rows.length) return res.status(400).json({ error: 'El archivo está vacío.' });

  const headerRow = (rows[0] || []).map(h => _lmS(h));
  const dataRows  = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length > LM_IMPORT_MAX)
    return res.status(400).json({ error: `El archivo tiene ${dataRows.length} filas; el máximo por importación es ${LM_IMPORT_MAX}.` });

  const colMap = {}; const ignored = new Set();
  for (const [idxStr, field] of Object.entries(mapping)) {
    const idx = parseInt(idxStr); if (isNaN(idx)) continue;
    if (field === '__ignore__') { ignored.add(idx); continue; }
    if (field) colMap[idx] = field;
  }

  const summary = { rows: 0, contactsCreated: 0, contactsUpdated: 0, contactsSkipped: 0, companiesCreated: 0, companiesUpdated: 0, companiesSkipped: 0, errors: [] };
  const coCache = new Map();
  async function _co(f) {
    const dominio = _lmNormDomain(f.dominio || f.website || '');
    const nombre  = _lmS(f.nombre);
    if (!dominio && !nombre) return null;
    const key = dominio ? 'd:' + dominio : 'n:' + nombre.toLowerCase();
    if (coCache.has(key)) return coCache.get(key);
    let found;
    if (dominio) found = (await pool.query(`SELECT id FROM lm_companies WHERE user_id=$1 AND dominio=$2 LIMIT 1`, [uid, dominio])).rows[0];
    else         found = (await pool.query(`SELECT id FROM lm_companies WHERE user_id=$1 AND dominio='' AND LOWER(nombre)=$2 LIMIT 1`, [uid, nombre.toLowerCase()])).rows[0];
    if (found) {
      coCache.set(key, found.id);
      // Actualiza los campos de la empresa YA existente (antes solo se enlazaba sin tocar sus datos).
      // Solo se pisan los campos que vienen con valor — una celda vacía nunca borra datos.
      if (updateExisting) {
        const sets = []; const vals = [found.id, uid];
        const upd = {
          nombre, website: _lmS(f.website), industria: _lmS(f.industria), tamano: _lmS(f.tamano), ingresos: _lmS(f.ingresos),
          telefono: _lmS(f.telefono), linkedin: _lmS(f.linkedin), ciudad: _lmS(f.ciudad), region: _lmS(f.region), pais: _lmS(f.pais),
          fundada: _lmS(f.fundada), direccion: _lmS(f.direccion), codigo_postal: _lmS(f.codigo_postal), descripcion: _lmS(f.descripcion),
          tecnologias: _lmS(f.tecnologias), funding: _lmS(f.funding), target_tier: _lmS(f.target_tier), segmento: _lmS(f.segmento), analisis: _lmS(f.analisis),
        };
        for (const [k, v] of Object.entries(upd)) if (v) sets.push(`${k}=$${vals.push(v)}`);
        if (sets.length) {
          sets.push('updated_at=NOW()');
          await pool.query(`UPDATE lm_companies SET ${sets.join(',')} WHERE id=$1 AND user_id=$2`, vals);
          summary.companiesUpdated++;
        } else summary.companiesSkipped++;
      } else summary.companiesSkipped++;
      return found.id;
    }
    const ins = await pool.query(`
      INSERT INTO lm_companies (user_id,nombre,dominio,website,industria,tamano,ingresos,telefono,linkedin,ciudad,region,pais,fundada,direccion,codigo_postal,descripcion,tecnologias,funding,target_tier,segmento,analisis,outbound_client_id,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id
    `, [uid, nombre || dominio, dominio, _lmS(f.website), _lmS(f.industria), _lmS(f.tamano), _lmS(f.ingresos),
        _lmS(f.telefono), _lmS(f.linkedin), _lmS(f.ciudad), _lmS(f.region), _lmS(f.pais), _lmS(f.fundada),
        _lmS(f.direccion), _lmS(f.codigo_postal), _lmS(f.descripcion), _lmS(f.tecnologias), _lmS(f.funding), _lmS(f.target_tier), _lmS(f.segmento), _lmS(f.analisis), obcId, _lmS(f.notas)]);
    coCache.set(key, ins.rows[0].id); summary.companiesCreated++; return ins.rows[0].id;
  }

  for (const row of dataRows) {
    if (!Array.isArray(row) || row.every(c => !_lmS(c))) continue;
    summary.rows++;
    const f = {}; const raw = {};
    const maxLen = Math.max(row.length, headerRow.length);
    for (let idx = 0; idx < maxLen; idx++) {
      const val = _lmS(row[idx]);
      if (colMap[idx]) { const k = colMap[idx]; f[k] = f[k] ? `${f[k]} ${val}` : val; }
      else if (!ignored.has(idx) && val) { raw[headerRow[idx] || `Columna ${idx + 1}`] = val; }
    }
    try {
      if (target === 'companies') {
        const id = await _co(f);
        if (id && Object.keys(raw).length) await pool.query(`UPDATE lm_companies SET raw = raw || $1::jsonb WHERE id=$2`, [JSON.stringify(raw), id]);
      } else {
        let nombre = _lmS(f.nombre), apellido = _lmS(f.apellido);
        if (!nombre && !apellido && _lmS(f.nombre_completo)) {
          const parts = _lmS(f.nombre_completo).split(/\s+/);
          nombre = parts.shift() || ''; apellido = parts.join(' ');
        }
        const email = _lmS(f.email).toLowerCase();
        // ── UPSERT: si ya existe (por ID del export, o por email) se ACTUALIZA — no se duplica.
        // Solo se pisan los campos que VIENEN con valor: una celda vacía nunca borra datos.
        let existing = null;
        const idStr = _lmS(f.id);
        if (/^\d+$/.test(idStr)) {
          existing = (await pool.query(`SELECT id, email FROM lm_contacts WHERE user_id=$1 AND id=$2 LIMIT 1`, [uid, parseInt(idStr, 10)])).rows[0] || null;
        }
        if (!existing && email) {
          existing = (await pool.query(`SELECT id, email FROM lm_contacts WHERE user_id=$1 AND LOWER(email)=$2 LIMIT 1`, [uid, email])).rows[0] || null;
        }
        if (existing) {
          if (!updateExisting) { summary.contactsSkipped++; continue; }
          const sets = []; const vals = [existing.id, uid];
          const upd = {
            nombre, apellido,
            email_personal: _lmS(f.email_personal), telefono: _lmS(f.telefono), movil: _lmS(f.movil),
            cargo: _lmS(f.cargo), seniority: _lmS(f.seniority), departamento: _lmS(f.departamento),
            linkedin: _lmS(f.linkedin), ciudad: _lmS(f.ciudad), region: _lmS(f.region), pais: _lmS(f.pais),
            estado: _lmS(f.estado), fuente: _lmS(f.fuente),
            contact_priority: _lmS(f.contact_priority), buyer_role: _lmS(f.buyer_role), analisis: _lmS(f.analisis), notas: _lmS(f.notas),
          };
          for (const [k, v] of Object.entries(upd)) if (v) sets.push(`${k}=$${vals.push(v)}`);
          // Email nuevo/corregido → se actualiza y su verificación vuelve a "sin verificar"
          if (email && email !== String(existing.email || '').trim().toLowerCase()) {
            sets.push(`email=$${vals.push(email)}`);
            sets.push(`email_status=''`, 'email_score=NULL', 'email_verified_at=NULL');
          }
          // Empresa: si el archivo trae datos de empresa, se resuelve/crea y se re-enlaza
          if (_lmS(f.co_nombre) || _lmS(f.co_dominio) || _lmS(f.co_website)) {
            const cid2 = await _co({
              nombre: f.co_nombre, dominio: f.co_dominio, website: f.co_website, industria: f.co_industria,
              tamano: f.co_tamano, ingresos: f.co_ingresos, telefono: f.co_telefono, linkedin: f.co_linkedin,
              ciudad: f.co_ciudad, region: f.co_region, pais: f.co_pais, direccion: f.co_direccion,
              codigo_postal: f.co_cp, fundada: f.co_fundada, descripcion: f.co_descripcion,
              tecnologias: f.co_tecnologias, funding: f.co_funding, target_tier: f.co_target_tier, segmento: f.co_segmento, analisis: f.co_analisis,
            });
            if (cid2) { sets.push(`company_id=$${vals.push(cid2)}`); if (_lmS(f.co_nombre)) sets.push(`empresa_nombre=$${vals.push(_lmS(f.co_nombre))}`); }
          }
          if (Object.keys(raw).length) sets.push(`raw = COALESCE(raw,'{}'::jsonb) || $${vals.push(JSON.stringify(raw))}::jsonb`);
          if (sets.length) {
            sets.push('updated_at=NOW()');
            await pool.query(`UPDATE lm_contacts SET ${sets.join(',')} WHERE id=$1 AND user_id=$2`, vals);
            summary.contactsUpdated++;
          } else {
            summary.contactsSkipped++;   // fila sin nada nuevo
          }
          continue;
        }
        const companyId = await _co({
          nombre: f.co_nombre, dominio: f.co_dominio, website: f.co_website, industria: f.co_industria,
          tamano: f.co_tamano, ingresos: f.co_ingresos, telefono: f.co_telefono, linkedin: f.co_linkedin,
          ciudad: f.co_ciudad, region: f.co_region, pais: f.co_pais, direccion: f.co_direccion,
          codigo_postal: f.co_cp, fundada: f.co_fundada, descripcion: f.co_descripcion,
          tecnologias: f.co_tecnologias, funding: f.co_funding, target_tier: f.co_target_tier, segmento: f.co_segmento,
        });
        await pool.query(`
          INSERT INTO lm_contacts (user_id,company_id,nombre,apellido,email,email_personal,telefono,movil,cargo,seniority,departamento,linkedin,empresa_nombre,ciudad,region,pais,estado,fuente,contact_priority,buyer_role,analisis,outbound_client_id,notas,raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        `, [uid, companyId, nombre, apellido, email, _lmS(f.email_personal), _lmS(f.telefono), _lmS(f.movil), _lmS(f.cargo), _lmS(f.seniority), _lmS(f.departamento),
            _lmS(f.linkedin), _lmS(f.co_nombre), _lmS(f.ciudad), _lmS(f.region), _lmS(f.pais), _lmS(f.estado) || 'nuevo', _lmS(f.fuente) || 'import', _lmS(f.contact_priority), _lmS(f.buyer_role), _lmS(f.analisis), obcId, _lmS(f.notas), JSON.stringify(raw)]);
        summary.contactsCreated++;
      }
    } catch (e) {
      if (summary.errors.length < 10) summary.errors.push(`Fila ${summary.rows}: ${e.message}`);
    }
  }
  res.json(summary);
});

// ── Plantillas / Assets (lm_templates) ─────────────────────────────
const LM_TPL_COLS = ['nombre', 'canal', 'tipo', 'asunto', 'cuerpo', 'tags', 'sequence_ids'];
app.get('/api/lm/templates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM lm_templates WHERE user_id=$1 ORDER BY updated_at DESC, id DESC`, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[lm-tpl] GET', err.message); res.status(500).json({ error: 'Error al cargar plantillas' }); }
});
app.post('/api/lm/templates', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!_lmS(b.nombre)) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const vals = LM_TPL_COLS.map(k => _lmS(b[k]));
    const { rows } = await pool.query(
      `INSERT INTO lm_templates (user_id,${LM_TPL_COLS.join(',')}) VALUES ($1,${LM_TPL_COLS.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING *`,
      [req.workspaceOwnerId, ...vals]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[lm-tpl] POST', err.message); res.status(500).json({ error: 'Error al crear plantilla' }); }
});
app.put('/api/lm/templates/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const vals = LM_TPL_COLS.map(k => _lmS(b[k]));
    const set = LM_TPL_COLS.map((k, i) => `${k}=$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `UPDATE lm_templates SET ${set}, updated_at=NOW() WHERE id=$${LM_TPL_COLS.length + 1} AND user_id=$${LM_TPL_COLS.length + 2} RETURNING *`,
      [...vals, req.params.id, req.workspaceOwnerId]);
    if (!rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(rows[0]);
  } catch (err) { console.error('[lm-tpl] PUT', err.message); res.status(500).json({ error: 'Error al guardar plantilla' }); }
});
app.delete('/api/lm/templates/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM lm_templates WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ ok: true });
  } catch (err) { console.error('[lm-tpl] DELETE', err.message); res.status(500).json({ error: 'Error al eliminar plantilla' }); }
});

// ── Campañas (Fase 2) ──────────────────────────────────────────────
const CMP_ESTADOS = ['draft', 'activa', 'pausada', 'cerrada'];
app.get('/api/campaigns', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM campaigns WHERE user_id=$1 ORDER BY created_at DESC`, [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[cmp] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar campañas' });
  }
});
app.post('/api/campaigns', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = CMP_ESTADOS.includes(b.estado) ? b.estado : 'draft';
  try {
    const { rows } = await pool.query(`
      INSERT INTO campaigns (user_id,outbound_client_id,nombre,estado,mercado,icp,canal,canal_secundario,objetivo,fecha_inicio,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.workspaceOwnerId, b.outbound_client_id || null, b.nombre.trim(), estado, b.mercado||'', b.icp||'',
        b.canal||'', b.canal_secundario||'', b.objetivo||'', b.fecha_inicio||null, b.notas||'']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[cmp] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear campaña' });
  }
});
app.put('/api/campaigns/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = CMP_ESTADOS.includes(b.estado) ? b.estado : 'draft';
  try {
    const { rows } = await pool.query(`
      UPDATE campaigns SET outbound_client_id=$1,nombre=$2,estado=$3,mercado=$4,icp=$5,canal=$6,
        canal_secundario=$7,objetivo=$8,fecha_inicio=$9,notas=$10,updated_at=NOW()
      WHERE id=$11 AND user_id=$12 RETURNING *
    `, [b.outbound_client_id || null, b.nombre.trim(), estado, b.mercado||'', b.icp||'', b.canal||'',
        b.canal_secundario||'', b.objetivo||'', b.fecha_inicio||null, b.notas||'', req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[cmp] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar campaña' });
  }
});
app.delete('/api/campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM campaigns WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[cmp] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar campaña' });
  }
});

// ── Secuencias + pasos (Fase 3) ────────────────────────────────────
const SEQ_ESTADOS  = ['draft', 'activa', 'pausada', 'archivada'];
const STEP_CANALES = ['email', 'linkedin', 'call', 'task', 'whatsapp'];

// Saneo del modo de envío por secuencia (manual = externo, default).
const SEQ_SEND_MODES = ['manual', 'auto', 'preaprobado'];
function _sanSendMode(v) { return SEQ_SEND_MODES.includes(v) ? v : 'manual'; }
function _sanInterval(v) { const n = parseInt(v); return (n >= 1 && n <= 1440) ? n : 5; }
// Canal preferido de la secuencia para re-enrutar al aceptar/responder.
function _sanPreferredChannel(v) { return ['linkedin', 'email'].includes(v) ? v : ''; }

app.get('/api/sequences', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, s.starts_on::text AS starts_on,
             (SELECT COUNT(*)::int FROM lm_messages m WHERE m.sequence_id = s.id AND m.estado='awaiting') AS awaiting
        FROM sequences s WHERE s.user_id=$1 ORDER BY s.created_at DESC`, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[seq] GET error:', err.message); res.status(500).json({ error: 'Error al cargar secuencias' }); }
});
app.post('/api/sequences', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = SEQ_ESTADOS.includes(b.estado) ? b.estado : 'draft';
  try {
    const drip = Math.max(0, parseInt(b.drip_per_day) || 0);
    const sendDays = _sanSendDays(b.send_days);
    const dLim = Math.max(0, parseInt(b.daily_limit) || 0);
    const { rows } = await pool.query(`
      INSERT INTO sequences (user_id,outbound_client_id,campaign_id,nombre,objetivo,estado,timezone,drip_per_day,send_days,starts_on,daily_limit,mercado,icp,notas,send_mode,send_interval_min,auto_activar,preferred_channel,target_role_1,target_role_2)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *
    `, [req.workspaceOwnerId, b.outbound_client_id || null, b.campaign_id || null, b.nombre.trim(), b.objetivo || '', estado, b.timezone || '', drip, sendDays, _sanDate(b.starts_on), dLim, b.mercado || '', b.icp || '', b.notas || '', _sanSendMode(b.send_mode), _sanInterval(b.send_interval_min), !!b.auto_activar, _sanPreferredChannel(b.preferred_channel), b.target_role_1 || '', b.target_role_2 || '']);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[seq] POST error:', err.message); res.status(500).json({ error: 'Error al crear secuencia' }); }
});
app.put('/api/sequences/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const estado = SEQ_ESTADOS.includes(b.estado) ? b.estado : 'draft';
  try {
    const drip = Math.max(0, parseInt(b.drip_per_day) || 0);
    const sendDays = _sanSendDays(b.send_days);
    const dLim = Math.max(0, parseInt(b.daily_limit) || 0);
    // Estado previo para detectar cambios de cadencia/fecha/drip (→ re-anclar fechas).
    const { rows: [old] } = await pool.query(
      `SELECT send_days, starts_on::text AS starts_on, drip_per_day FROM sequences WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]);
    const { rows } = await pool.query(`
      UPDATE sequences SET outbound_client_id=$1,campaign_id=$2,nombre=$3,objetivo=$4,estado=$5,timezone=$6,drip_per_day=$7,send_days=$8,starts_on=$9,daily_limit=$10,mercado=$11,icp=$12,notas=$13,send_mode=$14,send_interval_min=$15,auto_activar=$16,preferred_channel=$17,target_role_1=$18,target_role_2=$19,updated_at=NOW()
      WHERE id=$20 AND user_id=$21 RETURNING *
    `, [b.outbound_client_id || null, b.campaign_id || null, b.nombre.trim(), b.objetivo || '', estado, b.timezone || '', drip, sendDays, _sanDate(b.starts_on), dLim, b.mercado || '', b.icp || '', b.notas || '', _sanSendMode(b.send_mode), _sanInterval(b.send_interval_min), !!b.auto_activar, _sanPreferredChannel(b.preferred_channel), b.target_role_1 || '', b.target_role_2 || '', req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Secuencia no encontrada' });
    // Cambió la cadencia, la fecha de inicio o el drip → recalcular las fechas de los
    // que aún no empiezan (paso 1). Sin esto, activar S/D después de enrolar no movía nada.
    let reanchored = 0;
    if (old && (_sanSendDays(old.send_days) !== sendDays
             || String(old.starts_on || '') !== String(_sanDate(b.starts_on) || '')
             || (parseInt(old.drip_per_day) || 0) !== drip)) {
      reanchored = await _reanchorPendingEnrollments(req.workspaceOwnerId, rows[0].id).catch(e => { console.warn('[seq] reanchor:', e.message); return 0; });
      if (reanchored) console.log(`[seq] "${rows[0].nombre}": ${reanchored} enrolamiento(s) re-anclados por cambio de cadencia/fecha`);
    }
    res.json({ ...rows[0], reanchored });
  } catch (err) { console.error('[seq] PUT error:', err.message); res.status(500).json({ error: 'Error al actualizar secuencia' }); }
});
app.delete('/api/sequences/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM sequences WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Secuencia no encontrada' });
    res.json({ ok: true });
  } catch (err) { console.error('[seq] DELETE error:', err.message); res.status(500).json({ error: 'Error al eliminar secuencia' }); }
});

// ── Pausar/reactivar TODO de una vez ────────────────────────────────
// Pausar la secuencia por sí sola frena el motor (ver JOIN s.estado='activa' en
// sendEngine), pero NO toca el estado de cada contacto — sus tareas manuales
// seguían apareciendo en la pestaña "Tareas". Esto pausa ambas cosas juntas.
// paused_reason='pausada_manual' marca CUÁLES se pausaron por esto (a diferencia
// de los que ya estaban pausados por respuesta/rebote/dato faltante), para que
// "reactivar todo" solo revierta lo que esta acción pausó.
app.post('/api/sequences/:id/pause-all', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  try {
    const { rows: sRows } = await pool.query(
      `UPDATE sequences SET estado='pausada', updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id`,
      [req.params.id, uid]);
    if (!sRows.length) return res.status(404).json({ error: 'Secuencia no encontrada' });
    const { rowCount } = await pool.query(
      `UPDATE lm_contact_sequences SET estado='pausado', paused_reason='pausada_manual'
        WHERE user_id=$1 AND sequence_id=$2 AND estado='activo'`,
      [uid, req.params.id]);
    res.json({ ok: true, paused: rowCount });
  } catch (err) { console.error('[seq] pause-all error:', err.message); res.status(500).json({ error: 'Error al pausar todo' }); }
});
app.post('/api/sequences/:id/resume-all', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  try {
    const { rows: sRows } = await pool.query(
      `UPDATE sequences SET estado='activa', updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id`,
      [req.params.id, uid]);
    if (!sRows.length) return res.status(404).json({ error: 'Secuencia no encontrada' });
    // Solo reactiva lo que "Pausar todo" pausó — no toca pausas por respuesta/rebote/dato faltante/manuales de antes.
    const { rowCount } = await pool.query(
      `UPDATE lm_contact_sequences SET estado='activo', paused_reason='', next_action_at=NOW()
        WHERE user_id=$1 AND sequence_id=$2 AND estado='pausado' AND paused_reason='pausada_manual'`,
      [uid, req.params.id]);
    res.json({ ok: true, resumed: rowCount });
  } catch (err) { console.error('[seq] resume-all error:', err.message); res.status(500).json({ error: 'Error al reactivar todo' }); }
});

app.get('/api/sequence-steps', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM sequence_steps WHERE user_id=$1 ORDER BY dia ASC, orden ASC, id ASC`, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[step] GET error:', err.message); res.status(500).json({ error: 'Error al cargar pasos' }); }
});
app.post('/api/sequence-steps', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.sequence_id) return res.status(400).json({ error: 'sequence_id requerido' });
  const canal = STEP_CANALES.includes(b.canal) ? b.canal : 'email';
  try {
    const { rows } = await pool.query(`
      INSERT INTO sequence_steps (user_id,sequence_id,dia,canal,titulo,plantilla,variants,variant_mode,variant_field,orden,hora,cond,accion,asunto,cc_off,reply_to_prev)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
    `, [req.workspaceOwnerId, b.sequence_id, parseInt(b.dia) || 1, canal, b.titulo || '', b.plantilla || '', JSON.stringify(Array.isArray(b.variants) ? b.variants : []), b.variant_mode || 'off', b.variant_field || '', parseInt(b.orden) || 0, _sanHora(b.hora), _sanCond(b.cond), _sanAccion(b.accion), String(b.asunto || '').slice(0, 500), !!b.cc_off, !!b.reply_to_prev]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[step] POST error:', err.message); res.status(500).json({ error: 'Error al crear paso' }); }
});
app.put('/api/sequence-steps/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const canal = STEP_CANALES.includes(b.canal) ? b.canal : 'email';
  try {
    const { rows } = await pool.query(`
      UPDATE sequence_steps SET dia=$1,canal=$2,titulo=$3,plantilla=$4,variants=$5,variant_mode=$6,variant_field=$7,orden=$8,hora=$9,cond=$10,accion=$11,asunto=$12,cc_off=$13,reply_to_prev=$14 WHERE id=$15 AND user_id=$16 RETURNING *
    `, [parseInt(b.dia) || 1, canal, b.titulo || '', b.plantilla || '', JSON.stringify(Array.isArray(b.variants) ? b.variants : []), b.variant_mode || 'off', b.variant_field || '', parseInt(b.orden) || 0, _sanHora(b.hora), _sanCond(b.cond), _sanAccion(b.accion), String(b.asunto || '').slice(0, 500), !!b.cc_off, !!b.reply_to_prev, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Paso no encontrado' });

    // Re-generar los borradores 'awaiting' de este step con la nueva plantilla/asunto.
    // Los borradores son snapshots del momento en que se crearon: al editar el paso,
    // los que aún no se han enviado deben tomar el texto nuevo (y sus variables se
    // re-resuelven por contacto). Los 'approved' NO se tocan (ya fueron revisados).
    let refreshed = 0;
    if (canal === 'email') {
      try {
        const st = rows[0];
        const { renderTemplate, pickVariant } = require('./services/sendEngine');
        const { rows: drafts } = await pool.query(`
          SELECT m.id, m.contact_id,
                 k.nombre, k.apellido, k.email, k.cargo, k.empresa_nombre, k.ciudad, k.pais,
                 k.seniority, k.departamento, k.buyer_role, k.region, k.contact_priority,
                 co.nombre AS company_nombre
            FROM lm_messages m
            JOIN lm_contacts k ON k.id=m.contact_id
            LEFT JOIN lm_companies co ON co.id=k.company_id
           WHERE m.step_id=$1 AND m.user_id=$2 AND m.estado='awaiting'`,
          [st.id, req.workspaceOwnerId]);
        for (const d of drafts) {
          const ctx = d; // renderTemplate lee k.* / company_nombre desde ctx
          const variant = pickVariant(st, ctx);
          const asu = renderTemplate((variant && variant.asunto) || st.asunto || 'Seguimiento — {{company}}', ctx)
                    || `Seguimiento — ${ctx.company_nombre || ctx.empresa_nombre || ctx.nombre}`;
          const cue = renderTemplate((variant && variant.cuerpo) || st.plantilla, ctx);
          await pool.query(`UPDATE lm_messages SET asunto=$1, cuerpo=$2 WHERE id=$3`, [asu, cue, d.id]);
          refreshed++;
        }
      } catch (e) { console.warn('[step] refresh drafts warn:', e.message); }
    }
    res.json({ ...rows[0], drafts_refreshed: refreshed });
  } catch (err) { console.error('[step] PUT error:', err.message); res.status(500).json({ error: 'Error al actualizar paso' }); }
});
app.delete('/api/sequence-steps/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM sequence_steps WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Paso no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[step] DELETE error:', err.message); res.status(500).json({ error: 'Error al eliminar paso' }); }
});

// ── Actividades / tareas comerciales (Fase 4) ──────────────────────
app.get('/api/activities', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM activities WHERE user_id=$1 ORDER BY fecha DESC, id DESC`, [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) { console.error('[act] GET error:', err.message); res.status(500).json({ error: 'Error al cargar actividades' }); }
});
app.post('/api/activities', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.tipo) return res.status(400).json({ error: 'tipo requerido' });
  const estado = b.estado === 'pendiente' ? 'pendiente' : 'hecha';
  try {
    const { rows } = await pool.query(`
      INSERT INTO activities (user_id,lead_id,contact_id,outbound_client_id,campaign_id,tipo,canal,nota,fecha,estado,sentimiento,variant)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [req.workspaceOwnerId, b.lead_id || null, b.contact_id || null, b.outbound_client_id || null, b.campaign_id || null,
        String(b.tipo).slice(0, 40), b.canal || '', b.nota || '', b.fecha || new Date().toISOString(), estado, b.sentimiento || '',
        String(b.variant || '').slice(0, 60)]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[act] POST error:', err.message); res.status(500).json({ error: 'Error al crear actividad' }); }
});
app.put('/api/activities/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const estado = b.estado === 'pendiente' ? 'pendiente' : 'hecha';
  try {
    const { rows } = await pool.query(`
      UPDATE activities SET lead_id=$1,outbound_client_id=$2,campaign_id=$3,tipo=$4,canal=$5,nota=$6,fecha=$7,estado=$8,sentimiento=$9
      WHERE id=$10 AND user_id=$11 RETURNING *
    `, [b.lead_id || null, b.outbound_client_id || null, b.campaign_id || null, String(b.tipo || 'nota').slice(0, 40),
        b.canal || '', b.nota || '', b.fecha || new Date().toISOString(), estado, b.sentimiento || '', req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Actividad no encontrada' });
    res.json(rows[0]);
  } catch (err) { console.error('[act] PUT error:', err.message); res.status(500).json({ error: 'Error al actualizar actividad' }); }
});
app.delete('/api/activities/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM activities WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Actividad no encontrada' });
    res.json({ ok: true });
  } catch (err) { console.error('[act] DELETE error:', err.message); res.status(500).json({ error: 'Error al eliminar actividad' }); }
});

// ── Actividades por contacto (Lead Manager) ──
app.get('/api/lm/contacts/:id/activities', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM activities WHERE user_id=$1 AND contact_id=$2 ORDER BY fecha DESC, id DESC`, [req.workspaceOwnerId, req.params.id]);
    res.json(rows);
  } catch (err) { console.error('[lm-act] GET', err.message); res.status(500).json({ error: 'Error al cargar actividades' }); }
});
app.patch('/api/lm/activities/:id', requireAuth, async (req, res) => {
  const estado = req.body?.estado === 'pendiente' ? 'pendiente' : 'hecha';
  try {
    const { rows } = await pool.query(`UPDATE activities SET estado=$1 WHERE id=$2 AND user_id=$3 RETURNING *`, [estado, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Actividad no encontrada' });
    res.json(rows[0]);
  } catch (err) { console.error('[lm-act] PATCH', err.message); res.status(500).json({ error: 'Error al actualizar' }); }
});

// =================================================================
// MANAGEMENT — PAYMENTS (FINANZAS)
// =================================================================

// ── GET /api/mgmt/payments ────────────────────────────────────────
app.get('/api/mgmt/payments', requireAuth, async (req, res) => {
  const pid = parseInt(req.query.project_id) || null;
  try {
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT
          pm.id               AS id,
          NULL::int           AS task_id,
          'manual'            AS source,
          pm.concepto         AS concepto,
          pm.client_id        AS client_id,
          pm.project_id       AS project_id,
          pm.estado           AS estado,
          pm.fecha_esperada   AS fecha_esperada,
          pm.fecha_pagada     AS fecha_pagada,
          pm.monto_bruto      AS monto_bruto,
          pm.porcentaje       AS porcentaje,
          pm.monto_neto       AS monto_neto,
          pm.canal            AS canal,
          pm.comision_monto   AS comision_monto,
          pm.moneda           AS moneda,
          pm.tipo_cambio      AS tipo_cambio,
          pm.costo_extra      AS costo_extra,
          pm.notas            AS notas,
          pm.created_at       AS created_at,
          c.nombre            AS client_nombre,
          c.empresa           AS client_empresa,
          c.comision_default  AS client_comision,
          p.nombre            AS project_nombre,
          p.moneda            AS project_moneda
        FROM   payments pm
        LEFT JOIN clients  c ON pm.client_id  = c.id
        LEFT JOIN projects p ON pm.project_id = p.id
        WHERE  pm.user_id = $1

        UNION ALL

        SELECT
          NULL::int            AS id,
          t.id                 AS task_id,
          'task'               AS source,
          t.titulo             AS concepto,
          p2.client_id         AS client_id,
          t.project_id         AS project_id,
          'cobrado'            AS estado,
          NULL::date           AS fecha_esperada,
          t.cobrado_at::date   AS fecha_pagada,
          t.monto              AS monto_bruto,
          NULL::numeric        AS porcentaje,
          t.monto              AS monto_neto,
          ''                   AS canal,
          NULL::numeric        AS comision_monto,
          ''                   AS moneda,
          NULL::numeric        AS tipo_cambio,
          NULL::numeric        AS costo_extra,
          t.notas              AS notas,
          t.created_at         AS created_at,
          c2.nombre            AS client_nombre,
          c2.empresa           AS client_empresa,
          c2.comision_default  AS client_comision,
          p2.nombre            AS project_nombre,
          p2.moneda            AS project_moneda
        FROM   tasks t
        LEFT JOIN projects p2 ON t.project_id = p2.id
        LEFT JOIN clients  c2 ON p2.client_id = c2.id
        WHERE  t.user_id = $1 AND t.cobrado = true AND t.monto IS NOT NULL AND t.monto > 0
      ) combined
      ${pid ? 'WHERE project_id = $2' : ''}
      ORDER BY
        CASE estado
          WHEN 'pendiente' THEN 1
          WHEN 'vencido'   THEN 2
          WHEN 'cobrado'   THEN 3
          ELSE 4
        END,
        fecha_esperada ASC NULLS LAST,
        created_at DESC
    `, pid ? [req.workspaceOwnerId, pid] : [req.workspaceOwnerId]);
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/payments] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar pagos' });
  }
});

// ── POST /api/mgmt/payments ───────────────────────────────────────
app.post('/api/mgmt/payments', requireAuth, async (req, res) => {
  const { concepto, client_id, project_id, monto_bruto, porcentaje,
          monto_neto, fecha_esperada, fecha_pagada, estado, notas, canal, comision_monto,
          moneda, tipo_cambio, costo_extra, disponibilidad } = req.body;
  const disp = ['disponible', 'liberacion'].includes(disponibilidad) ? disponibilidad : 'disponible';
  try {
    const { rows } = await pool.query(`
      INSERT INTO payments
        (user_id, client_id, project_id, concepto, monto_bruto, porcentaje,
         monto_neto, fecha_esperada, fecha_pagada, estado, notas, canal, comision_monto,
         moneda, tipo_cambio, costo_extra, disponibilidad)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [req.workspaceOwnerId, client_id || null, project_id || null,
        concepto || '', monto_bruto || 0, porcentaje || null,
        monto_neto || null, fecha_esperada || null, fecha_pagada || null,
        estado || 'pendiente', notas || '', canal || '',
        (comision_monto != null && comision_monto !== '') ? comision_monto : null,
        moneda || '', (tipo_cambio != null && tipo_cambio !== '') ? tipo_cambio : null,
        (costo_extra != null && costo_extra !== '') ? costo_extra : null, disp]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/payments] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear pago' });
  }
});

// ── PUT /api/mgmt/payments/:id ────────────────────────────────────
app.put('/api/mgmt/payments/:id', requireAuth, async (req, res) => {
  const { concepto, client_id, project_id, monto_bruto, porcentaje,
          monto_neto, fecha_esperada, fecha_pagada, estado, notas, canal, comision_monto,
          moneda, tipo_cambio, costo_extra, disponibilidad } = req.body;
  const disp = ['disponible', 'liberacion'].includes(disponibilidad) ? disponibilidad : 'disponible';
  try {
    const { rows } = await pool.query(`
      UPDATE payments
      SET concepto=$1, client_id=$2, project_id=$3, monto_bruto=$4,
          porcentaje=$5, monto_neto=$6, fecha_esperada=$7, fecha_pagada=$8,
          estado=$9, notas=$10, canal=$11, comision_monto=$12,
          moneda=$13, tipo_cambio=$14, costo_extra=$15, disponibilidad=$16, updated_at=NOW()
      WHERE id=$17 AND user_id=$18
      RETURNING *
    `, [concepto || '', client_id || null, project_id || null, monto_bruto || 0,
        porcentaje || null, monto_neto || null, fecha_esperada || null,
        fecha_pagada || null, estado || 'pendiente', notas || '',
        canal || '', (comision_monto != null && comision_monto !== '') ? comision_monto : null,
        moneda || '', (tipo_cambio != null && tipo_cambio !== '') ? tipo_cambio : null,
        (costo_extra != null && costo_extra !== '') ? costo_extra : null, disp,
        req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/payments] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar pago' });
  }
});

// ── PATCH /api/mgmt/payments/:id/disponibilidad (toggle liberación ↔ disponible) ──
app.patch('/api/mgmt/payments/:id/disponibilidad', requireAuth, async (req, res) => {
  const disp = ['disponible', 'liberacion'].includes(req.body.disponibilidad) ? req.body.disponibilidad : 'disponible';
  try {
    const { rows } = await pool.query(
      `UPDATE payments SET disponibilidad=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
      [disp, req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/payments/disponibilidad] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar disponibilidad' });
  }
});

// ── DELETE /api/mgmt/payments/:id ─────────────────────────────────
app.delete('/api/mgmt/payments/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM payments WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/payments] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar pago' });
  }
});

// =================================================================
// MANAGEMENT — FINANCE CONFIG (impuestos, reserva, socios, equipo)
// =================================================================

// ── GET /api/mgmt/fin-config ──────────────────────────────────────
app.get('/api/mgmt/fin-config', requireAuth, async (req, res) => {
  try {
    const cfgQ = await pool.query(
      `SELECT impuesto_pct, reserva_pct, comision_pct, costos_operativos,
              moneda_principal, periodo_default
         FROM fin_config WHERE user_id = $1`,
      [req.workspaceOwnerId]
    );
    const config = cfgQ.rows[0] || {
      impuesto_pct: 0, reserva_pct: 0, comision_pct: 0, costos_operativos: 0,
      moneda_principal: 'USD', periodo_default: 'mes',
    };
    const memQ = await pool.query(
      `SELECT tm.id     AS member_id,
              tm.nombre  AS nombre,
              tm.cargo   AS cargo,
              tm.estado  AS estado,
              COALESCE(fc.es_socio,    FALSE)     AS es_socio,
              COALESCE(fc.socio_pct,   0)         AS socio_pct,
              COALESCE(fc.socio_regla, 'despues') AS socio_regla,
              COALESCE(fc.tipo_pago,   'manual')  AS tipo_pago,
              COALESCE(fc.monto_pago,  0)         AS monto_pago,
              COALESCE(fc.moneda_pago, 'USD')     AS moneda_pago
         FROM team_members tm
         LEFT JOIN fin_member_config fc
                ON fc.member_id = tm.id AND fc.user_id = $1
        WHERE tm.user_id = $1
        ORDER BY tm.nombre ASC`,
      [req.workspaceOwnerId]
    );
    res.json({ config, members: memQ.rows });
  } catch (err) {
    console.error('[mgmt/fin-config] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar configuración financiera' });
  }
});

// ── PUT /api/mgmt/fin-config ──────────────────────────────────────
app.put('/api/mgmt/fin-config', requireAuth, async (req, res) => {
  const { impuesto_pct, reserva_pct, comision_pct, costos_operativos,
          moneda_principal, periodo_default } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO fin_config
         (user_id, impuesto_pct, reserva_pct, comision_pct, costos_operativos,
          moneda_principal, periodo_default, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         impuesto_pct      = EXCLUDED.impuesto_pct,
         reserva_pct       = EXCLUDED.reserva_pct,
         comision_pct      = EXCLUDED.comision_pct,
         costos_operativos = EXCLUDED.costos_operativos,
         moneda_principal  = EXCLUDED.moneda_principal,
         periodo_default   = EXCLUDED.periodo_default,
         updated_at        = NOW()
       RETURNING *`,
      [req.workspaceOwnerId,
       impuesto_pct || 0, reserva_pct || 0, comision_pct || 0, costos_operativos || 0,
       moneda_principal || 'USD',
       periodo_default === 'semana' ? 'semana' : 'mes']
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/fin-config] PUT error:', err.message);
    res.status(500).json({ error: 'Error al guardar configuración financiera' });
  }
});

// ── PUT /api/mgmt/fin-config/member/:memberId ─────────────────────
app.put('/api/mgmt/fin-config/member/:memberId', requireAuth, async (req, res) => {
  const memberId = parseInt(req.params.memberId, 10);
  const { es_socio, socio_pct, socio_regla, tipo_pago, monto_pago, moneda_pago } = req.body;
  const VALID_TIPO = ['sueldo_mensual', 'sueldo_semanal', 'por_proyecto', 'comision', 'manual'];
  try {
    const own = await pool.query(
      `SELECT 1 FROM team_members WHERE id = $1 AND user_id = $2`,
      [memberId, req.workspaceOwnerId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Miembro no encontrado' });

    const { rows } = await pool.query(
      `INSERT INTO fin_member_config
         (user_id, member_id, es_socio, socio_pct, socio_regla,
          tipo_pago, monto_pago, moneda_pago, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (user_id, member_id) DO UPDATE SET
         es_socio    = EXCLUDED.es_socio,
         socio_pct   = EXCLUDED.socio_pct,
         socio_regla = EXCLUDED.socio_regla,
         tipo_pago   = EXCLUDED.tipo_pago,
         monto_pago  = EXCLUDED.monto_pago,
         moneda_pago = EXCLUDED.moneda_pago,
         updated_at  = NOW()
       RETURNING *`,
      [req.workspaceOwnerId, memberId,
       !!es_socio, socio_pct || 0,
       socio_regla === 'antes' ? 'antes' : 'despues',
       VALID_TIPO.includes(tipo_pago) ? tipo_pago : 'manual',
       monto_pago || 0, moneda_pago || 'USD']
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/fin-config] PUT member error:', err.message);
    res.status(500).json({ error: 'Error al guardar configuración del miembro' });
  }
});

// =================================================================
// MANAGEMENT — PAGOS INTERNOS (abonos a socios / equipo / colaboradores)
// =================================================================

const PI_TIPOS   = ['socio', 'equipo', 'colaborador', 'comision', 'bono', 'reembolso'];
const PI_ESTADOS = ['pendiente', 'programado', 'pagado', 'observado'];
const PI_PERIODOS = ['semana', 'mes', 'proyecto'];

// ── GET /api/mgmt/pagos-internos ──────────────────────────────────
app.get('/api/mgmt/pagos-internos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pi.*, tm.nombre AS member_nombre
         FROM pagos_internos pi
         LEFT JOIN team_members tm ON pi.member_id = tm.id
        WHERE pi.user_id = $1
        ORDER BY
          CASE pi.estado WHEN 'pendiente' THEN 1 WHEN 'programado' THEN 2
                         WHEN 'observado' THEN 3 WHEN 'pagado' THEN 4 ELSE 5 END,
          pi.fecha_pago DESC NULLS LAST,
          pi.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/pagos-internos] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar pagos internos' });
  }
});

// ── POST /api/mgmt/pagos-internos ─────────────────────────────────
app.post('/api/mgmt/pagos-internos', requireAuth, async (req, res) => {
  const { member_id, persona, tipo, periodo_tipo, periodo_ref, monto, moneda,
          fecha_pago, metodo, referencia, nota, estado } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pagos_internos
         (user_id, member_id, persona, tipo, periodo_tipo, periodo_ref, monto, moneda,
          fecha_pago, metodo, referencia, nota, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.workspaceOwnerId, member_id || null, (persona || '').trim(),
       PI_TIPOS.includes(tipo) ? tipo : 'equipo',
       PI_PERIODOS.includes(periodo_tipo) ? periodo_tipo : 'mes', periodo_ref || '',
       monto || 0, moneda || 'USD', fecha_pago || null, metodo || '', referencia || '',
       nota || '', PI_ESTADOS.includes(estado) ? estado : 'pendiente']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/pagos-internos] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear pago interno' });
  }
});

// ── PUT /api/mgmt/pagos-internos/:id ──────────────────────────────
app.put('/api/mgmt/pagos-internos/:id', requireAuth, async (req, res) => {
  const { member_id, persona, tipo, periodo_tipo, periodo_ref, monto, moneda,
          fecha_pago, metodo, referencia, nota, estado } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE pagos_internos SET
         member_id=$1, persona=$2, tipo=$3, periodo_tipo=$4, periodo_ref=$5,
         monto=$6, moneda=$7, fecha_pago=$8, metodo=$9, referencia=$10, nota=$11,
         estado=$12, updated_at=NOW()
       WHERE id=$13 AND user_id=$14 RETURNING *`,
      [member_id || null, (persona || '').trim(),
       PI_TIPOS.includes(tipo) ? tipo : 'equipo',
       PI_PERIODOS.includes(periodo_tipo) ? periodo_tipo : 'mes', periodo_ref || '',
       monto || 0, moneda || 'USD', fecha_pago || null, metodo || '', referencia || '',
       nota || '', PI_ESTADOS.includes(estado) ? estado : 'pendiente',
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pago interno no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/pagos-internos] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar pago interno' });
  }
});

// ── DELETE /api/mgmt/pagos-internos/:id ───────────────────────────
app.delete('/api/mgmt/pagos-internos/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM pagos_internos WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Pago interno no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/pagos-internos] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar pago interno' });
  }
});

// =================================================================
// MANAGEMENT — GASTOS / CAJA (fin_movimientos: gastos operativos + aportes a caja)
// =================================================================
const MOV_TIPOS        = ['gasto', 'aporte'];
const MOV_ESTADOS      = ['pendiente', 'pagado', 'reembolsable', 'reembolsado', 'cancelado'];
const MOV_PAGADO_DESDE = ['caja', 'cobro', 'socio_a', 'socio_b', 'personal', 'otro'];
const MOV_ORIGEN       = ['cobro', 'aporte_socio', 'ajuste', 'otro'];

app.get('/api/mgmt/fin-movimientos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, p.nombre AS project_nombre, c.nombre AS client_nombre
         FROM fin_movimientos m
         LEFT JOIN projects p ON m.project_id = p.id
         LEFT JOIN clients  c ON m.client_id  = c.id
        WHERE m.user_id = $1
        ORDER BY m.fecha DESC NULLS LAST, m.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/fin-movimientos] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar movimientos' });
  }
});

app.post('/api/mgmt/fin-movimientos', requireAuth, async (req, res) => {
  const b = req.body || {};
  const tipo  = MOV_TIPOS.includes(b.tipo) ? b.tipo : 'gasto';
  const monto = Math.max(0, parseFloat(b.monto) || 0);   // sin negativos
  try {
    const { rows } = await pool.query(
      `INSERT INTO fin_movimientos
         (user_id, tipo, concepto, categoria, proveedor, monto, moneda, tipo_cambio,
          fecha, estado, pagado_desde, origen, project_id, client_id, responsable, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.workspaceOwnerId, tipo, (b.concepto || '').trim(), b.categoria || '', b.proveedor || '',
       monto, b.moneda || 'USD', b.tipo_cambio ? +b.tipo_cambio : null, b.fecha || null,
       tipo === 'gasto'  ? (MOV_ESTADOS.includes(b.estado) ? b.estado : 'pagado') : 'registrado',
       tipo === 'gasto'  ? (MOV_PAGADO_DESDE.includes(b.pagado_desde) ? b.pagado_desde : 'caja') : '',
       tipo === 'aporte' ? (MOV_ORIGEN.includes(b.origen) ? b.origen : 'ajuste') : '',
       b.project_id || null, b.client_id || null, b.responsable || '', b.nota || '']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/fin-movimientos] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear movimiento' });
  }
});

app.put('/api/mgmt/fin-movimientos/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const tipo  = MOV_TIPOS.includes(b.tipo) ? b.tipo : 'gasto';
  const monto = Math.max(0, parseFloat(b.monto) || 0);
  try {
    const { rows } = await pool.query(
      `UPDATE fin_movimientos SET
         tipo=$1, concepto=$2, categoria=$3, proveedor=$4, monto=$5, moneda=$6, tipo_cambio=$7,
         fecha=$8, estado=$9, pagado_desde=$10, origen=$11, project_id=$12, client_id=$13,
         responsable=$14, nota=$15, updated_at=NOW()
       WHERE id=$16 AND user_id=$17 RETURNING *`,
      [tipo, (b.concepto || '').trim(), b.categoria || '', b.proveedor || '', monto, b.moneda || 'USD',
       b.tipo_cambio ? +b.tipo_cambio : null, b.fecha || null,
       tipo === 'gasto'  ? (MOV_ESTADOS.includes(b.estado) ? b.estado : 'pagado') : 'registrado',
       tipo === 'gasto'  ? (MOV_PAGADO_DESDE.includes(b.pagado_desde) ? b.pagado_desde : 'caja') : '',
       tipo === 'aporte' ? (MOV_ORIGEN.includes(b.origen) ? b.origen : 'ajuste') : '',
       b.project_id || null, b.client_id || null, b.responsable || '', b.nota || '',
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/fin-movimientos] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar movimiento' });
  }
});

app.patch('/api/mgmt/fin-movimientos/:id/estado', requireAuth, async (req, res) => {
  const estado = MOV_ESTADOS.includes(req.body.estado) ? req.body.estado : 'pagado';
  try {
    const { rows } = await pool.query(
      `UPDATE fin_movimientos SET estado=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
      [estado, req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/fin-movimientos/estado] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

app.delete('/api/mgmt/fin-movimientos/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM fin_movimientos WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/fin-movimientos] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar movimiento' });
  }
});

// =================================================================
// MANAGEMENT — OPORTUNIDADES (procesos pre-proyecto)
// =================================================================

const OPP_ESTADOS = ['activa', 'nueva', 'en_proceso', 'esperando', 'entrevista', 'propuesta', 'piloto', 'ganada', 'perdida', 'rechazada', 'archivada'];
const OPP_ETAPAS  = ['aplicacion', 'conversacion', 'preseleccion', 'revision', 'entrevista', 'piloto', 'propuesta', 'contrato'];
// Estados de tareas internas: idénticos a tareas normales (pendiente/en_progreso/completado/bloqueado)
const OPP_TASK_ESTADOS = ['pendiente', 'en_progreso', 'completado', 'bloqueado'];
const normOppTaskEstado = e => {
  if (e === 'completada') e = 'completado';   // legacy
  return OPP_TASK_ESTADOS.includes(e) ? e : 'pendiente';
};

// ── GET /api/mgmt/opportunities ───────────────────────────────────
app.get('/api/mgmt/opportunities', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, c.nombre AS client_nombre, c.empresa AS client_empresa
         FROM opportunities o
         LEFT JOIN clients c ON o.client_id = c.id
        WHERE o.user_id = $1
        ORDER BY
          CASE o.estado WHEN 'archivada' THEN 5
                        WHEN 'perdida' THEN 4 WHEN 'rechazada' THEN 4
                        WHEN 'ganada' THEN 3 ELSE 1 END,
          o.updated_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[mgmt/opportunities] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar oportunidades' });
  }
});

// ── POST /api/mgmt/opportunities ──────────────────────────────────
app.post('/api/mgmt/opportunities', requireAuth, async (req, res) => {
  const { titulo, cliente, client_id, canal, estado, etapa_actual, prioridad,
          responsable, proxima_accion, descripcion, notas, valor_estimado, moneda,
          fecha_aplicacion, etapas } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ error: 'El título es requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO opportunities
         (user_id, titulo, cliente, client_id, canal, estado, etapa_actual, prioridad,
          responsable, proxima_accion, descripcion, notas, valor_estimado, moneda, fecha_aplicacion, etapas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.workspaceOwnerId, titulo.trim(), cliente || '', client_id || null, canal || '',
       OPP_ESTADOS.includes(estado) ? estado : 'activa',
       OPP_ETAPAS.includes(etapa_actual) ? etapa_actual : 'aplicacion',
       prioridad || 'media', responsable || '', proxima_accion || '', descripcion || '',
       notas || '', (valor_estimado != null && valor_estimado !== '') ? valor_estimado : null,
       moneda || 'USD', fecha_aplicacion || null, etapas ? JSON.stringify(etapas) : '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/opportunities] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear oportunidad' });
  }
});

// ── GET /api/mgmt/opportunities/:id ───────────────────────────────
app.get('/api/mgmt/opportunities/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, c.nombre AS client_nombre, c.empresa AS client_empresa
         FROM opportunities o LEFT JOIN clients c ON o.client_id = c.id
        WHERE o.id = $1 AND o.user_id = $2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/opportunities] GET/:id error:', err.message);
    res.status(500).json({ error: 'Error al cargar oportunidad' });
  }
});

// ── PUT /api/mgmt/opportunities/:id ───────────────────────────────
app.put('/api/mgmt/opportunities/:id', requireAuth, async (req, res) => {
  const { titulo, cliente, client_id, canal, estado, etapa_actual, prioridad,
          responsable, proxima_accion, descripcion, notas, valor_estimado, moneda,
          fecha_aplicacion, etapas, propuesta, links } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ error: 'El título es requerido' });
  try {
    const { rows } = await pool.query(
      `UPDATE opportunities SET
         titulo=$1, cliente=$2, client_id=$3, canal=$4, estado=$5, etapa_actual=$6,
         prioridad=$7, responsable=$8, proxima_accion=$9, descripcion=$10, notas=$11,
         valor_estimado=$12, moneda=$13, fecha_aplicacion=$14, etapas=$15,
         propuesta=$16, links=$17, updated_at=NOW()
       WHERE id=$18 AND user_id=$19 RETURNING *`,
      [titulo.trim(), cliente || '', client_id || null, canal || '',
       OPP_ESTADOS.includes(estado) ? estado : 'activa',
       OPP_ETAPAS.includes(etapa_actual) ? etapa_actual : 'aplicacion',
       prioridad || 'media', responsable || '', proxima_accion || '', descripcion || '',
       notas || '', (valor_estimado != null && valor_estimado !== '') ? valor_estimado : null,
       moneda || 'USD', fecha_aplicacion || null, etapas ? JSON.stringify(etapas) : '{}',
       propuesta || '', JSON.stringify(Array.isArray(links) ? links : []),
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/opportunities] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar oportunidad' });
  }
});

// ── POST /api/mgmt/opportunities/:id/proyecto ─────────────────────
// Abrir el proyecto es lo que convierte la oportunidad en trabajo real. Aqui es
// donde el POTENCIAL se vuelve cliente: no hace falta marcarlo a mano porque la
// regla de Clientes ya mira si tiene proyectos. Si el cliente no existia todavia
// se da de alta ahora, con el nombre que se escribio en la oportunidad.
app.post('/api/mgmt/opportunities/:id/proyecto', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [o] } = await client.query(
      `SELECT * FROM opportunities WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, uid]);
    if (!o) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Oportunidad no encontrada' }); }
    if (o.project_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta oportunidad ya tiene un proyecto abierto', project_id: o.project_id });
    }

    // Cliente: el que ya estuviera enlazado; si no, se busca por nombre antes de
    // crear uno nuevo — asi no se duplica a quien ya esta en la cartera.
    let clientId = o.client_id;
    const nombreCli = String(o.cliente || '').trim();
    if (!clientId && nombreCli) {
      const { rows: [ya] } = await client.query(
        `SELECT id FROM clients WHERE user_id=$1
           AND (LOWER(TRIM(nombre))=LOWER($2) OR LOWER(TRIM(empresa))=LOWER($2)) LIMIT 1`, [uid, nombreCli]);
      if (ya) clientId = ya.id;
      else {
        const { rows: [nuevo] } = await client.query(
          `INSERT INTO clients (user_id, nombre, estado, notas)
           VALUES ($1,$2,'activo',$3) RETURNING id`,
          [uid, nombreCli, `Alta desde la oportunidad "${o.titulo}"`]);
        clientId = nuevo.id;
      }
    }

    const nombreProy = String(req.body?.nombre || o.titulo || 'Proyecto').trim();
    const { rows: [proy] } = await client.query(
      `INSERT INTO projects (user_id, client_id, nombre, descripcion, estado, responsable,
                             valor_total, moneda, fecha_inicio)
       VALUES ($1,$2,$3,$4,'activo',$5,$6,$7,CURRENT_DATE)
       RETURNING id, nombre, client_id`,
      [uid, clientId, nombreProy, o.descripcion || '', o.responsable || '',
       o.valor_estimado != null ? o.valor_estimado : null, o.moneda || 'USD']);

    await client.query(
      `UPDATE opportunities SET project_id=$1, client_id=COALESCE(client_id,$2),
              estado='ganada', updated_at=NOW() WHERE id=$3`,
      [proy.id, clientId, o.id]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, project: proy, client_id: clientId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[opp/proyecto] error:', err.message);
    res.status(500).json({ error: 'No se pudo abrir el proyecto' });
  } finally { client.release(); }
});

// ── PATCH /api/mgmt/opportunities/:id/etapa ───────────────────────
app.patch('/api/mgmt/opportunities/:id/etapa', requireAuth, async (req, res) => {
  const { etapa_actual } = req.body;
  if (!OPP_ETAPAS.includes(etapa_actual)) return res.status(400).json({ error: 'Etapa inválida' });
  try {
    const { rows } = await pool.query(
      `UPDATE opportunities SET etapa_actual=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
      [etapa_actual, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/opportunities] PATCH etapa error:', err.message);
    res.status(500).json({ error: 'Error al cambiar etapa' });
  }
});

// ── PATCH /api/mgmt/opportunities/:id/estado ──────────────────────
app.patch('/api/mgmt/opportunities/:id/estado', requireAuth, async (req, res) => {
  const { estado } = req.body;
  if (!OPP_ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE opportunities SET estado=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
      [estado, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/opportunities] PATCH estado error:', err.message);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// ── DELETE /api/mgmt/opportunities/:id (no borra proyectos creados) ─
app.delete('/api/mgmt/opportunities/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM opportunities WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mgmt/opportunities] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar oportunidad' });
  }
});

// ── Tareas internas de oportunidad (pre-proyecto, NO tareas de proyecto) ──
app.get('/api/mgmt/opportunities/:oid/tasks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM opportunity_tasks WHERE opportunity_id=$1 AND user_id=$2 ORDER BY created_at ASC`,
      [req.params.oid, req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[opportunity-tasks] GET error:', err.message);
    res.status(500).json({ error: 'Error al cargar tareas internas' });
  }
});

app.post('/api/mgmt/opportunities/:oid/tasks', requireAuth, async (req, res) => {
  const { titulo, etapa, estado, prioridad, responsable, fecha_limite, notas, presupuesto, horas_estimadas } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ error: 'El título es requerido' });
  try {
    const own = await pool.query(`SELECT 1 FROM opportunities WHERE id=$1 AND user_id=$2`, [req.params.oid, req.workspaceOwnerId]);
    if (!own.rows.length) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    const { rows } = await pool.query(
      `INSERT INTO opportunity_tasks
         (user_id, opportunity_id, titulo, etapa, estado, prioridad, responsable, fecha_limite, notas, presupuesto, horas_estimadas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.workspaceOwnerId, req.params.oid, titulo.trim(),
       OPP_ETAPAS.includes(etapa) ? etapa : '',
       normOppTaskEstado(estado),
       prioridad || 'media', responsable || '', fecha_limite || null, notas || '',
       (presupuesto != null && presupuesto !== '') ? presupuesto : null,
       (horas_estimadas != null && horas_estimadas !== '') ? horas_estimadas : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[opportunity-tasks] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear tarea interna' });
  }
});

app.put('/api/mgmt/opportunity-tasks/:id', requireAuth, async (req, res) => {
  const { titulo, etapa, estado, prioridad, responsable, fecha_limite, notas, presupuesto, horas_estimadas } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE opportunity_tasks SET titulo=$1, etapa=$2, estado=$3, prioridad=$4,
         responsable=$5, fecha_limite=$6, notas=$7, presupuesto=$8, horas_estimadas=$9, updated_at=NOW()
       WHERE id=$10 AND user_id=$11 RETURNING *`,
      [titulo || '', OPP_ETAPAS.includes(etapa) ? etapa : '',
       normOppTaskEstado(estado),
       prioridad || 'media', responsable || '', fecha_limite || null, notas || '',
       (presupuesto != null && presupuesto !== '') ? presupuesto : null,
       (horas_estimadas != null && horas_estimadas !== '') ? horas_estimadas : null,
       req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[opportunity-tasks] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar tarea interna' });
  }
});

app.patch('/api/mgmt/opportunity-tasks/:id/estado', requireAuth, async (req, res) => {
  const estado = normOppTaskEstado(req.body.estado);
  try {
    const { rows } = await pool.query(
      `UPDATE opportunity_tasks SET estado=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id, estado`,
      [estado, req.params.id, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[opportunity-tasks] PATCH error:', err.message);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

app.delete('/api/mgmt/opportunity-tasks/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM opportunity_tasks WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[opportunity-tasks] DELETE error:', err.message);
    res.status(500).json({ error: 'Error al eliminar tarea interna' });
  }
});

// ── GET /api/mgmt/opportunity-tasks — todas (para el Dashboard) ────
app.get('/api/mgmt/opportunity-tasks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ot.*, o.titulo AS opp_titulo, o.estado AS opp_estado, o.cliente AS opp_cliente
         FROM opportunity_tasks ot
         JOIN opportunities o ON ot.opportunity_id = o.id
        WHERE ot.user_id = $1
        ORDER BY (ot.estado = 'completada'), ot.fecha_limite ASC NULLS LAST, ot.created_at DESC`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[opportunity-tasks] GET all error:', err.message);
    res.status(500).json({ error: 'Error al cargar tareas de oportunidades' });
  }
});

// =================================================================
// MANAGEMENT — DASHBOARD
// =================================================================

// ── GET /api/mgmt/dashboard ───────────────────────────────────────
app.get('/api/mgmt/dashboard', requireAuth, async (req, res) => {
  const uid          = req.workspaceOwnerId;
  const userDispName = req.user.name || null;   // display name from users table
  try {
    // Resolve team_member record by email (case-insensitive)
    let memberNombre = null;
    let memberId     = null;
    try {
      const { rows: tm } = await pool.query(
        `SELECT id, nombre FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
        [uid, req.user.email]
      );
      if (tm.length) { memberNombre = tm[0].nombre || null; memberId = tm[0].id || null; }
    } catch (_) {}
    // Always have at least the display name as fallback
    if (!memberNombre) memberNombre = userDispName;

    console.log('[dashboard] uid=%s email=%s memberId=%s memberNombre=%j userDispName=%j',
      uid, req.user.email, memberId, memberNombre, userDispName);

    // Quick diagnostic: see what responsable values actually exist for this workspace
    const { rows: respSample } = await pool.query(
      `SELECT DISTINCT responsable FROM tasks WHERE user_id=$1 AND responsable IS NOT NULL LIMIT 20`,
      [uid]
    );
    console.log('[dashboard] responsable values in DB:', respSample.map(r => r.responsable));

    // Helper: member-match condition for a tasks query (checks both responsable string
    // and responsables[] array, dual-name: memberNombre + userDispName).
    // $N_NAME1 = memberNombre, $N_NAME2 = userDispName (same indices across all queries)
    const _memberMatch = (alias = 't') => `(
      ($2::text IS NOT NULL AND LOWER(${alias}.responsable) = LOWER($2))
      OR ($3::text IS NOT NULL AND LOWER(${alias}.responsable) = LOWER($3))
      OR ($2::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(${alias}.responsables) _r WHERE LOWER(_r) = LOWER($2)))
      OR ($3::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(${alias}.responsables) _r WHERE LOWER(_r) = LOWER($3)))
    )`;

    const [cntRes, todayRes, urgentRes, projCntRes] = await Promise.all([

      // Count ALL pending tasks (main + subtasks) assigned to this member
      pool.query(`
        SELECT COUNT(*) AS total
        FROM tasks t
        WHERE t.user_id = $1
          AND t.estado != 'completado'
          AND ${_memberMatch('t')}
      `, [uid, memberNombre, userDispName]),

      // Tasks due TODAY for this member
      pool.query(`
        SELECT t.id, t.titulo, t.estado, t.prioridad, t.deadline, t.responsable,
               t.responsables, t.parent_task_id,
               p.nombre AS project_nombre, c.nombre AS client_nombre
        FROM   tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE  t.user_id = $1
          AND  t.estado != 'completado'
          AND  t.deadline = CURRENT_DATE
          AND  ${_memberMatch('t')}
        ORDER BY t.created_at DESC
        LIMIT 20
      `, [uid, memberNombre, userDispName]),

      // Overdue / blocked tasks for this member
      pool.query(`
        SELECT t.id, t.titulo, t.estado, t.prioridad, t.deadline, t.responsable,
               t.responsables, t.parent_task_id,
               p.nombre AS project_nombre, c.nombre AS client_nombre
        FROM   tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE  t.user_id = $1
          AND  t.estado != 'completado'
          AND  ((t.deadline IS NOT NULL AND t.deadline < CURRENT_DATE) OR t.estado = 'bloqueado')
          AND  ${_memberMatch('t')}
        ORDER BY
          CASE t.estado WHEN 'bloqueado' THEN 1 ELSE 2 END,
          t.deadline ASC NULLS LAST
        LIMIT 12
      `, [uid, memberNombre, userDispName]),

      // Count active projects for this member (by ID or name, dual-name)
      pool.query(`
        SELECT COUNT(*) AS total
        FROM projects
        WHERE user_id = $1
          AND estado = 'activo'
          AND (
            ($2::int IS NOT NULL AND responsable_id = $2)
            OR ($3::text IS NOT NULL AND LOWER(responsable) = LOWER($3))
            OR ($4::text IS NOT NULL AND LOWER(responsable) = LOWER($4))
          )
      `, [uid, memberId, memberNombre, userDispName])
    ]);

    res.json({
      tareas_count:    parseInt(cntRes.rows[0].total)     || 0,
      tareas_hoy:      todayRes.rows,
      tareas_urgentes: urgentRes.rows,
      proyectos_count: parseInt(projCntRes.rows[0].total) || 0,
    });
  } catch (err) {
    console.error('[mgmt/dashboard] error:', err.message);
    res.status(500).json({ error: 'Error al cargar dashboard' });
  }
});

// ── GET /api/mgmt/integrity ───────────────────────────────────────
app.get('/api/mgmt/integrity', requireAuth, async (req, res) => {
  const wid = req.workspaceOwnerId;
  try {
    const [clientsNoProj, projNoTasks, tasksNoDeadline, tasksNoResp] = await Promise.all([
      pool.query(
        `SELECT c.id, c.nombre, c.empresa
         FROM clients c
         WHERE c.user_id = $1
         AND COALESCE(c.tipo, 'cliente') <> 'contacto'   -- contactos (sin ser clientes) no generan esta alerta
         AND COALESCE(c.estado, 'activo') <> 'inactivo'
         AND NOT EXISTS (
           SELECT 1 FROM projects p
           WHERE p.client_id = c.id AND p.user_id = $1
         )
         ORDER BY c.nombre`,
        [wid]
      ),
      pool.query(
        `SELECT p.id, p.nombre, c.nombre AS client_nombre
         FROM projects p
         LEFT JOIN clients c ON p.client_id = c.id
         WHERE p.user_id = $1 AND p.estado = 'activo'
         AND NOT EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.project_id = p.id AND t.user_id = $1
         )
         ORDER BY p.nombre`,
        [wid]
      ),
      pool.query(
        `SELECT t.id, t.titulo, t.responsable,
                p.nombre AS project_nombre, c.nombre AS client_nombre
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         LEFT JOIN clients  c ON p.client_id  = c.id
         WHERE t.user_id = $1
         AND t.estado NOT IN ('completado','cancelado')
         AND t.deadline IS NULL
         ORDER BY t.created_at DESC`,
        [wid]
      ),
      pool.query(
        `SELECT t.id, t.titulo, t.deadline
         FROM tasks t
         WHERE t.user_id = $1
         AND t.estado NOT IN ('completado','cancelado')
         AND (t.responsable IS NULL OR t.responsable = '')
         AND (t.responsables IS NULL OR array_length(t.responsables, 1) IS NULL)
         ORDER BY t.created_at DESC`,
        [wid]
      ),
    ]);
    res.json({
      clientes_sin_proyecto: clientsNoProj.rows,
      proyectos_sin_tareas:  projNoTasks.rows,
      tareas_sin_deadline:   tasksNoDeadline.rows,
      tareas_sin_responsable: tasksNoResp.rows,
      total: clientsNoProj.rows.length + projNoTasks.rows.length +
             tasksNoDeadline.rows.length + tasksNoResp.rows.length,
    });
  } catch (err) {
    console.error('[mgmt/integrity] error:', err.message);
    res.status(500).json({ error: 'Error al calcular integridad' });
  }
});

// =================================================================
// WORKSPACE
// =================================================================

// ── GET /api/workspace ────────────────────────────────────────────
app.get('/api/workspace', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM workspaces WHERE owner_id = $1`,
      [req.workspaceOwnerId]
    );
    if (!rows.length) {
      const owner = await findUserById(req.workspaceOwnerId);
      const { rows: created } = await pool.query(
        `INSERT INTO workspaces (owner_id, name) VALUES ($1, $2)
         ON CONFLICT (owner_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING *`,
        [req.workspaceOwnerId, owner?.name || 'Mi Workspace']
      );
      return res.json(created[0]);
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/workspace ────────────────────────────────────────────
app.put('/api/workspace', requireAuth, async (req, res) => {
  if (req.user.workspace_id) return res.status(403).json({ error: 'Solo el admin puede modificar el workspace' });
  const { name, company_name, company_logo } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  // Limit logo size to 2MB (base64 ~2.7M chars)
  if (company_logo && company_logo.length > 2_800_000)
    return res.status(400).json({ error: 'El logo no puede superar 2 MB' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO workspaces (owner_id, name, company_name, company_logo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) DO UPDATE
         SET name=$2, company_name=$3, company_logo=$4, updated_at=NOW()
       RETURNING *`,
      [req.user.id, name.trim(), (company_name || '').trim(), company_logo || '']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/workspace/members ────────────────────────────────────
app.get('/api/workspace/members', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, avatar, workspace_id
         FROM users
        WHERE id = $1 OR workspace_id = $1
        ORDER BY id`,
      [req.workspaceOwnerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/workspace/invite ────────────────────────────────────
app.post('/api/workspace/invite', requireAuth, async (req, res) => {
  if (req.user.workspace_id) return res.status(403).json({ error: 'Solo el admin puede invitar' });
  const { email, nombre, cargo, nivel } = req.body;
  if (!email?.trim())  return res.status(400).json({ error: 'El email es requerido' });
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const crypto  = require('crypto');
    const token   = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO workspace_invites (workspace_owner_id, email, token, expires_at, nombre, cargo, nivel)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.id, email.trim().toLowerCase(), token, expires,
       nombre.trim(), (cargo || '').trim(), nivel || 'miembro']
    );
    const inviteUrl = `${FRONTEND_URL}?join=${token}`;
    res.json({ ok: true, invite_url: inviteUrl, expires_at: expires });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/workspace/accept-invite ────────────────────────────
// For users already logged in who click an invite link.
app.post('/api/workspace/accept-invite', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  if (req.user.workspace_id) return res.json({ ok: true, already_member: true });
  try {
    const { rows: invites } = await pool.query(
      `SELECT * FROM workspace_invites WHERE token=$1 AND used=false AND expires_at > NOW()`,
      [token]
    );
    if (!invites.length) return res.status(400).json({ error: 'Invitación inválida o expirada' });
    const invite = invites[0];
    await pool.query(`UPDATE users SET workspace_id=$1 WHERE id=$2`, [invite.workspace_owner_id, req.user.id]);
    await pool.query(`UPDATE workspace_invites SET used=true WHERE id=$1`, [invite.id]);
    const { rows: tmExist } = await pool.query(
      `SELECT id FROM team_members WHERE user_id=$1 AND email=$2`,
      [invite.workspace_owner_id, req.user.email]
    );
    if (!tmExist.length) {
      await pool.query(
        `INSERT INTO team_members (user_id, nombre, email, rol, estado)
         VALUES ($1,$2,$3,'miembro','activo')`,
        [invite.workspace_owner_id, req.user.name || req.user.email.split('@')[0], req.user.email]
      );
    }
    const updated = await findUserById(req.user.id);
    await new Promise((resolve, reject) => req.logIn(updated, e => e ? reject(e) : resolve()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// CHAT — REST (history) + Socket.io (real-time)
// =================================================================

// ── GET /api/chat/messages/:channel ──────────────────────────────
app.get('/api/chat/messages/:channel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
        FROM chat_messages m
        LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.workspace_owner_id = $1 AND m.channel = $2
       ORDER BY m.created_at ASC
       LIMIT 120
    `, [req.workspaceOwnerId, req.params.channel]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/messages/:channel — enviar sin socket (usado por la
//    pagina de detalle de tarea: channel = 'task:<id>'; el chat de equipo
//    normal sigue mandando por socket.io, ver send_message mas abajo) ──
app.post('/api/chat/messages/:channel', requireAuth, async (req, res) => {
  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Mensaje vacío' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (workspace_owner_id, channel, sender_id, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.workspaceOwnerId, req.params.channel, req.user.id, content]
    );
    res.status(201).json({ ...rows[0], sender_name: req.user.name, sender_avatar: req.user.avatar || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/chat/messages/:id/pin — toggle pin ────────────────
app.patch('/api/chat/messages/:id/pin', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE chat_messages
          SET pinned    = NOT pinned,
              pinned_at = CASE WHEN NOT pinned THEN NOW() ELSE NULL END
        WHERE id = $1 AND workspace_owner_id = $2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/pinned/:channel — list pinned messages ──────────
app.get('/api/chat/pinned/:channel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.*, u.name AS sender_name
        FROM chat_messages m
        LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.workspace_owner_id = $1 AND m.channel = $2 AND m.pinned = TRUE
       ORDER BY m.pinned_at DESC
       LIMIT 50
    `, [req.workspaceOwnerId, req.params.channel]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR INTEGRATION
// ═══════════════════════════════════════════════════════════════════

const GCAL_SCOPES   = ['https://www.googleapis.com/auth/calendar.events'];
const GCAL_CALLBACK = (process.env.API_BASE_URL || 'https://api.kiwoc.com') + '/api/gcal/callback';
// URL pública del frontend. Se toma de la env FRONTEND_URL; default = kiwoc (sin cambio hasta el
// cutover a app.novacentrax.com — ahí solo se define la env, no se toca el código).
const FRONTEND_URL  = (process.env.FRONTEND_URL || 'https://enricher.kiwoc.com').replace(/\/+$/, '');

function _gcalOAuth2() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GCAL_CALLBACK
  );
}

async function _gcalClient(userId) {
  const { google } = require('googleapis');
  const { rows } = await pool.query(
    `SELECT google_access_token, google_refresh_token, google_token_expiry FROM users WHERE id=$1`,
    [userId]
  );
  if (!rows[0]?.google_refresh_token) return null;
  const auth = _gcalOAuth2();
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
  return google.calendar({ version: 'v3', auth });
}

app.get('/api/gcal/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT google_refresh_token IS NOT NULL AS connected FROM users WHERE id=$1`,
    [req.user.id]
  );
  res.json({ connected: !!rows[0]?.connected });
});

app.get('/api/gcal/connect', requireAuth, (req, res) => {
  const auth = _gcalOAuth2();
  const url  = auth.generateAuthUrl({
    access_type: 'offline',
    scope: GCAL_SCOPES,
    prompt: 'consent',
    include_granted_scopes: true, // conserva scopes ya concedidos (ej. gmail.send)
    state: String(req.user.id),
  });
  res.redirect(url);
});

app.get('/api/gcal/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.redirect(`${FRONTEND_URL}?gcal=error`);
  try {
    const auth = _gcalOAuth2();
    const { tokens } = await auth.getToken(code);
    await pool.query(
      `UPDATE users SET google_access_token=$1, google_refresh_token=$2, google_token_expiry=$3,
              google_scopes=$4 WHERE id=$5`,
      [tokens.access_token, tokens.refresh_token,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null,
       tokens.scope || '', userId]
    );
    res.redirect(`${FRONTEND_URL}?gcal=ok`);
  } catch (e) {
    console.error('[gcal] callback error:', e.message);
    res.redirect(`${FRONTEND_URL}?gcal=error`);
  }
});

app.post('/api/gcal/disconnect', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE users SET google_access_token=NULL, google_refresh_token=NULL, google_token_expiry=NULL WHERE id=$1`,
    [req.user.id]
  );
  res.json({ ok: true });
});

app.get('/api/gcal/events', requireAuth, async (req, res) => {
  try {
    const cal = await _gcalClient(req.user.id);
    if (!cal) return res.json({ connected: false, events: [] });
    const { start, end } = req.query;
    const response = await cal.events.list({
      calendarId: 'primary',
      timeMin: start || new Date().toISOString(),
      timeMax: end   || new Date(Date.now() + 7 * 86400000).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });
    const events = (response.data.items || []).map(ev => ({
      id:     ev.id,
      title:  ev.summary || '(Sin título)',
      start:  ev.start?.dateTime || ev.start?.date,
      end:    ev.end?.dateTime   || ev.end?.date,
      allDay: !ev.start?.dateTime,
      link:   ev.hangoutLink || ev.htmlLink || null,
    }));
    res.json({ connected: true, events });
  } catch (e) {
    console.error('[gcal] events error:', e.message);
    res.json({ connected: true, events: [] });
  }
});

app.post('/api/gcal/sync-task', requireAuth, async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  try {
    const cal = await _gcalClient(req.user.id);
    if (!cal) return res.json({ connected: false });
    const { rows } = await pool.query(
      `SELECT t.*, p.nombre as project_nombre, c.nombre as client_nombre
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE t.id=$1 AND t.user_id=$2`,
      [taskId, req.workspaceOwnerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarea no encontrada' });
    const t = rows[0];
    const deadline = t.deadline ? String(t.deadline).split('T')[0] : null;
    const eventBody = {
      summary: t.titulo,
      description: [t.descripcion, t.project_nombre && `Proyecto: ${t.project_nombre}`, t.client_nombre && `Cliente: ${t.client_nombre}`].filter(Boolean).join('\n'),
      start: deadline ? { date: deadline } : { dateTime: new Date().toISOString(), timeZone: 'America/Bogota' },
      end:   deadline ? { date: deadline } : { dateTime: new Date(Date.now() + 3600000).toISOString(), timeZone: 'America/Bogota' },
      colorId: t.estado === 'completado' ? '8' : t.estado === 'bloqueado' ? '11' : '5',
    };
    let gcalEventId = t.gcal_event_id;
    if (gcalEventId) {
      try { await cal.events.update({ calendarId: 'primary', eventId: gcalEventId, requestBody: eventBody }); }
      catch (_) { const c = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody }); gcalEventId = c.data.id; }
    } else {
      const c = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
      gcalEventId = c.data.id;
    }
    await pool.query(`UPDATE tasks SET gcal_event_id=$1 WHERE id=$2`, [gcalEventId, taskId]);
    res.json({ ok: true, gcalEventId });
  } catch (e) {
    console.error('[gcal] sync-task error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =================================================================
// SLACK — varios workspaces conectados a la vez
// =================================================================
const slackSvc = require('./services/slackService');

// Rol del usuario que hace la petición DENTRO de ese workspace (el dueño de la
// cuenta siempre es 'admin'; para invitados se busca en team_members por email).
async function _resolveRol(req) {
  if (!req.user.workspace_id) return 'admin';
  try {
    const { rows } = await pool.query(
      `SELECT rol FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [req.workspaceOwnerId, req.user.email]);
    return rows[0]?.rol || 'miembro';
  } catch (_) { return 'miembro'; }
}

// Lista de workspaces. NUNCA devuelve el token, solo si esta conectado.
// Cada espacio tiene una visibilidad ('todos'/'admin'/'solo_yo') — se filtra
// aquí según quién pregunta, no solo por pertenecer al mismo workspace de Nova.
app.get('/api/slack/workspaces', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, team_id, team_name, etiqueta, token_tipo, bot_user_id, estado,
              ultimo_error, created_at, icon_url, visibilidad, connected_by, slack_user_id
         FROM slack_workspaces WHERE user_id=$1 ORDER BY created_at`,
      [req.workspaceOwnerId]);
    // Backfill perezoso: los workspaces conectados antes de tener icon_url o
    // slack_user_id se completan solos en la primera carga, sin reconectarlos.
    const faltantes = rows.filter(w => !w.icon_url || !w.slack_user_id);
    if (faltantes.length) {
      const { rows: tokens } = await pool.query(
        `SELECT id, token_enc FROM slack_workspaces WHERE id = ANY($1::int[])`,
        [faltantes.map(w => w.id)]);
      await Promise.all(tokens.map(async t => {
        const w = faltantes.find(x => x.id === t.id); if (!w) return;
        if (!w.icon_url) {
          try {
            const info = await slackSvc.teamInfoFromEnc(t.token_enc);
            if (info.icon_url) { await pool.query(`UPDATE slack_workspaces SET icon_url=$1 WHERE id=$2`, [info.icon_url, t.id]); w.icon_url = info.icon_url; }
          } catch (_) {}
        }
        if (!w.slack_user_id) {
          try {
            const info = await slackSvc.verificarFromEnc(t.token_enc);
            if (info.user_id) { await pool.query(`UPDATE slack_workspaces SET slack_user_id=$1 WHERE id=$2`, [info.user_id, t.id]); w.slack_user_id = info.user_id; }
          } catch (_) {}
        }
      }));
    }
    const rol = await _resolveRol(req);
    const visibles = rows.filter(w =>
      w.visibilidad === 'solo_yo' ? w.connected_by === req.user.id
      : w.visibilidad === 'admin' ? (rol === 'admin' || w.connected_by === req.user.id)
      : true);
    res.json(visibles);
  } catch (err) {
    console.error('[slack] list:', err.message);
    res.status(500).json({ error: 'Error al leer los workspaces' });
  }
});

// Conectar uno. El token se COMPRUEBA contra Slack antes de guardarlo: si no sirve,
// no se almacena nada. Se guarda cifrado, igual que las contrasenas de los buzones.
app.post('/api/slack/workspaces', requireAuth, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const etiqueta = String(req.body?.etiqueta || '').trim();
  if (!/^xox[bpe]-/.test(token)) {
    return res.status(400).json({ error: 'Eso no parece un token de Slack (empieza por xoxb- o xoxp-)' });
  }
  try {
    const info = await slackSvc.verificar(token);
    let iconUrl = '';
    try { iconUrl = (await slackSvc.teamInfo(token)).icon_url; } catch (_) {}
    // connected_by/visibilidad solo se fijan en el INSERT inicial — reconectar
    // (mismo team_id) no le cambia el dueño ni la visibilidad a nadie más.
    const visibilidad = ['todos', 'admin', 'solo_yo'].includes(req.body?.visibilidad) ? req.body.visibilidad : 'todos';
    const { rows } = await pool.query(
      `INSERT INTO slack_workspaces (user_id, team_id, team_name, etiqueta, token_enc, token_tipo, bot_user_id, estado, icon_url, visibilidad, connected_by, slack_user_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'conectado',$8,$9,$10,$11)
       ON CONFLICT (user_id, team_id)
       DO UPDATE SET token_enc=EXCLUDED.token_enc, token_tipo=EXCLUDED.token_tipo,
                     team_name=EXCLUDED.team_name, etiqueta=EXCLUDED.etiqueta,
                     bot_user_id=EXCLUDED.bot_user_id, estado='conectado', ultimo_error='',
                     icon_url=EXCLUDED.icon_url, slack_user_id=EXCLUDED.slack_user_id
       RETURNING id, team_id, team_name, etiqueta, token_tipo, estado, icon_url, visibilidad, connected_by, slack_user_id`,
      [req.workspaceOwnerId, info.team_id, info.team_name, etiqueta || info.team_name,
       slackSvc.encPass(token), info.tipo, info.bot_id || '', iconUrl, visibilidad, req.user.id, info.user_id || '']);
    res.status(201).json({ ok: true, workspace: rows[0], info });
  } catch (err) {
    console.error('[slack] connect:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Cambiar quién puede ver este espacio conectado — solo quien lo conectó o un admin.
app.patch('/api/slack/workspaces/:id/visibilidad', requireAuth, async (req, res) => {
  const visibilidad = String(req.body?.visibilidad || '');
  if (!['todos', 'admin', 'solo_yo'].includes(visibilidad)) {
    return res.status(400).json({ error: 'Valor de visibilidad inválido' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT connected_by FROM slack_workspaces WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    const rol = await _resolveRol(req);
    if (rows[0].connected_by !== req.user.id && rol !== 'admin') {
      return res.status(403).json({ error: 'Solo quien lo conectó o un admin puede cambiar esto' });
    }
    await pool.query(`UPDATE slack_workspaces SET visibilidad=$1 WHERE id=$2`, [visibilidad, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[slack] visibilidad:', err.message);
    res.status(500).json({ error: 'No se pudo actualizar' });
  }
});

app.delete('/api/slack/workspaces/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM slack_workspaces WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.workspaceOwnerId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[slack] delete:', err.message);
    res.status(500).json({ error: 'No se pudo desconectar' });
  }
});

// Helper: trae el workspace con su token descifrado, o null.
async function _slackWs(uid, id) {
  const { rows: [w] } = await pool.query(
    `SELECT * FROM slack_workspaces WHERE id=$1 AND user_id=$2`, [id, uid]);
  return w || null;
}

// Los archivos de Slack (url_private, thumb_*) exigen el Bearer token del
// workspace para verse — un <img>/<video>/<audio> directo a esa URL da 401
// porque el navegador no puede mandar ese header. Este proxy hace el fetch
// con el token y lo retransmite. Solo se aceptan URLs de *.slack.com para
// que esto no se pueda usar como proxy abierto a cualquier sitio.
app.get('/api/slack/workspaces/:id/archivo-proxy', requireAuth, async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https:\/\/[a-z0-9.-]+\.slack\.com\//i.test(url)) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const token = mailboxSvc.decPass(w.token_enc);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(r.status).json({ error: 'No se pudo cargar el archivo' });
    res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('[slack] archivo-proxy:', e.message);
    res.status(500).json({ error: 'Error al cargar el archivo' });
  }
});

// Equipo del workspace: es lo que permite ver a la gente y resolver las menciones.
app.get('/api/slack/workspaces/:id/miembros', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.json(await slackSvc.miembros(w));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/slack/workspaces/:id/canales', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.json(await slackSvc.canales(w, { cursor: req.query.cursor }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Reaccionar a un mensaje.
app.post('/api/slack/workspaces/:id/canales/:canal/reaccion', requireAuth, async (req, res) => {
  const { ts, emoji, quitar } = req.body || {};
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    if (quitar) await slackSvc.quitarReaccion(w, req.params.canal, ts, emoji);
    else        await slackSvc.reaccionar(w, req.params.canal, ts, emoji);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Anclar / desanclar.
app.post('/api/slack/workspaces/:id/canales/:canal/anclar', requireAuth, async (req, res) => {
  const { ts, quitar } = req.body || {};
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    if (quitar) await slackSvc.desanclar(w, req.params.canal, ts);
    else        await slackSvc.anclar(w, req.params.canal, ts);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Mensajes anclados del canal.
app.get('/api/slack/workspaces/:id/canales/:canal/anclados', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.json({ anclados: await slackSvc.anclados(w, req.params.canal) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Subir documento o audio. El binario no se guarda en Nova: va directo a Slack.
app.post('/api/slack/workspaces/:id/canales/:canal/archivo', requireAuth, uploadSlack.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo' });
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const f = await slackSvc.subirArchivo(w, req.params.canal, req.file.buffer,
      req.file.originalname || 'archivo', req.body?.comentario || '', req.body?.thread_ts || '');
    res.status(201).json({ ok: true, file: { id: f.id, name: f.name } });
  } catch (err) {
    console.error('[slack] archivo:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Marcar un canal como no leido.
app.post('/api/slack/workspaces/:id/canales/:canal/no-leido', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    await slackSvc.marcarNoLeido(w, req.params.canal);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Mapa canal_de_slack -> proyecto, para el menu contextual del canal (ver proyecto,
// ver tareas...). Solo los proyectos que tienen canal ligado.
app.get('/api/slack/workspaces/:id/vinculos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slack_channel_id, id AS project_id, nombre, estado
         FROM projects
        WHERE user_id=$1 AND slack_ws_id=$2 AND slack_channel_id IS NOT NULL`,
      [req.workspaceOwnerId, req.params.id]);
    const mapa = {};
    rows.forEach(r => { mapa[r.slack_channel_id] = { projectId: r.project_id, nombre: r.nombre, estado: r.estado }; });
    res.json(mapa);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Renombrar un canal y (opcional) ligarlo a un proyecto. Es lo que usa la
// normalizacion de una vez, y tambien la automatizacion al crear un proyecto.
app.post('/api/slack/workspaces/:id/canales/:canal/renombrar', requireAuth, async (req, res) => {
  const { nombre, projectId } = req.body || {};
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const ch = await slackSvc.renombrarCanal(w, req.params.canal, nombre);
    if (projectId) {
      await pool.query(`UPDATE projects SET slack_channel_id=$1, slack_ws_id=$2 WHERE id=$3 AND user_id=$4`,
        [req.params.canal, w.id, projectId, req.workspaceOwnerId]);
    }
    res.json({ ok: true, canal: ch.name });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Archivar un canal (proyectos viejos) o cerrar un directo. dm:true => se cierra en
// vez de archivar, porque Slack no archiva directos.
app.post('/api/slack/workspaces/:id/canales/:canal/archivar-canal', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const r = await slackSvc.archivarCanal(w, req.params.canal, { dm: !!(req.body && req.body.dm) });
    res.json({ ok: true, cerrado: !!r.cerrado });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Guardados del workspace (stars.list). Sección "Guardados" del riel.
app.get('/api/slack/workspaces/:id/guardados', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.json({ items: await slackSvc.guardados(w) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Marcar una conversacion como leida en Slack (al abrirla desde aqui). El
// respaldo propio (slack_leido_override) se guarda SIEMPRE con la hora real,
// sin importar si conversations.mark de Slack tuvo éxito — en conversaciones
// fuera del historial de ~90 días (plan gratis) Slack nunca deja de reportarlas
// como sin leer, así que lo que manda para el badge es nuestra propia hora.
app.post('/api/slack/workspaces/:id/canales/:canal/leido', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    await slackSvc.marcarLeido(w, req.params.canal);
    await pool.query(
      `INSERT INTO slack_leido_override (workspace_id, canal_id, marcado_at)
            VALUES ($1,$2,NOW())
       ON CONFLICT (workspace_id, canal_id) DO UPDATE SET marcado_at=NOW()`,
      [w.id, req.params.canal]);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// No leidos del workspace: el numero que va sobre la letra en el riel. Se
// cruza con slack_leido_override para no repetir conversaciones que YA
// marcamos leídas y donde no hay actividad de Slack más nueva que esa hora —
// aunque Slack siga reportando unread_count_display=1 para ellas.
app.get('/api/slack/workspaces/:id/no-leidos', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const { canales } = await slackSvc.canales(w);
    const datos = await slackSvc.noLeidos(w, canales);
    const { rows: overrides } = await pool.query(
      `SELECT canal_id, EXTRACT(EPOCH FROM marcado_at) AS marcado_epoch FROM slack_leido_override WHERE workspace_id=$1`, [w.id]);
    const marcados = {}; overrides.forEach(o => { marcados[o.canal_id] = parseFloat(o.marcado_epoch); });
    let total = 0;
    const porCanal = {};
    for (const [canalId, n] of Object.entries(datos.porCanal || {})) {
      const marcado = marcados[canalId];
      const actividadEpoch = datos.actividad?.[canalId] ? parseFloat(datos.actividad[canalId]) : null;
      if (marcado !== undefined && (actividadEpoch === null || actividadEpoch <= marcado)) continue;
      porCanal[canalId] = n; total += n;
    }
    res.json({ total, porCanal, actividad: datos.actividad || {} });
  } catch (err) {
    console.error('[slack] no-leidos:', err.message);
    res.json({ total: 0, porCanal: {} });   // una insignia no debe romper el chat
  }
});

// Mensajes de un canal. No se guardan: se leen de Slack en el momento, que es
// justo lo que Jenny pidio (que la memoria la ponga Slack, no su base).
app.get('/api/slack/workspaces/:id/canales/:canal/mensajes', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    const d = await slackSvc.historial(w, req.params.canal,
      { limit: Math.min(+req.query.limit || 50, 200), cursor: req.query.cursor });
    res.json(d);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Un hilo completo (el primer mensaje es el que lo abrio).
app.get('/api/slack/workspaces/:id/canales/:canal/hilo/:ts', requireAuth, async (req, res) => {
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.json(await slackSvc.hilo(w, req.params.canal, req.params.ts));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Enviar. Con thread_ts la respuesta entra DENTRO del hilo, no suelta en el canal.
app.post('/api/slack/workspaces/:id/canales/:canal/mensajes', requireAuth, async (req, res) => {
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'El mensaje está vacío' });
  try {
    const w = await _slackWs(req.workspaceOwnerId, req.params.id);
    if (!w) return res.status(404).json({ error: 'Workspace no encontrado' });
    res.status(201).json(await slackSvc.enviar(w, req.params.canal, texto,
      { thread_ts: req.body?.thread_ts }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/gcal/meet ───────────────────────────────────────────
// Crea la junta como evento de Google Calendar CON enlace de Meet. Se hace aqui y
// no en Slack porque en el plan gratuito de Slack las llamadas son solo de dos
// personas. El enlace se guarda en meetings.link, que el calendario ya usa para
// pintar "Unirse a reunion".
app.post('/api/gcal/meet', requireAuth, async (req, res) => {
  const { meetingId } = req.body || {};
  if (!meetingId) return res.status(400).json({ error: 'Falta la reunión' });
  try {
    const cal = await _gcalClient(req.user.id);
    if (!cal) return res.status(409).json({ error: 'Conecta Google Calendar primero', connected: false });
    const { rows: [m] } = await pool.query(
      `SELECT * FROM meetings WHERE id=$1 AND user_id=$2`, [meetingId, req.workspaceOwnerId]);
    if (!m) return res.status(404).json({ error: 'Reunión no encontrada' });

    const dia = String(m.fecha).split('T')[0];
    const ini = m.hora_inicio ? String(m.hora_inicio).slice(0, 5) : '09:00';
    const fin = m.hora_fin    ? String(m.hora_fin).slice(0, 5)
                              : `${String(Math.min(23, +ini.slice(0, 2) + 1)).padStart(2, '0')}:${ini.slice(3)}`;
    let invitados = [];
    try { invitados = JSON.parse(m.attendees || '[]'); } catch (_) {}
    const correos = (Array.isArray(invitados) ? invitados : [])
      .map(x => (typeof x === 'string' ? x : x && x.email) || '')
      .filter(e => e.includes('@')).map(email => ({ email }));

    const { data } = await cal.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,                 // sin esto Google ignora la peticion de Meet
      requestBody: {
        summary: m.titulo || 'Reunión',
        description: m.descripcion || '',
        start: { dateTime: `${dia}T${ini}:00`, timeZone: process.env.TZ_DEFAULT || 'America/Lima' },
        end:   { dateTime: `${dia}T${fin}:00`, timeZone: process.env.TZ_DEFAULT || 'America/Lima' },
        attendees: correos.length ? correos : undefined,
        conferenceData: {
          createRequest: { requestId: `nova-${meetingId}-${Date.now()}`,
                           conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      },
    });
    const link = data.hangoutLink
      || (data.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || '';
    if (!link) return res.status(502).json({ error: 'Google no devolvió enlace de Meet' });
    await pool.query(`UPDATE meetings SET link=$1 WHERE id=$2`, [link, meetingId]);
    res.json({ ok: true, link, eventId: data.id });
  } catch (e) {
    console.error('[gcal] meet error:', e.message);
    res.status(500).json({ error: /invalid_grant/i.test(e.message)
      ? 'Google Calendar perdió la autorización — reconéctalo'
      : e.message });
  }
});

app.delete('/api/gcal/sync-task/:taskId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT gcal_event_id FROM tasks WHERE id=$1 AND user_id=$2`, [req.params.taskId, req.workspaceOwnerId]);
    const eventId = rows[0]?.gcal_event_id;
    if (eventId) {
      const cal = await _gcalClient(req.user.id);
      if (cal) await cal.events.delete({ calendarId: 'primary', eventId }).catch(() => {});
      await pool.query(`UPDATE tasks SET gcal_event_id=NULL WHERE id=$1`, [req.params.taskId]);
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

// ═══════════════════════════════════════════════════════════════════
// LM GMAIL — conexión de la cuenta de envío (outreach)
// Mismo token store que Calendar (users.google_*); include_granted_scopes
// hace que un solo refresh token cubra Calendar + Gmail.
// ═══════════════════════════════════════════════════════════════════

const GMAIL_CALLBACK = (process.env.API_BASE_URL || 'https://api.kiwoc.com') + '/api/lm/gmail/callback';

app.get('/api/lm/gmail/status', requireAuth, async (req, res) => {
  const { gmailStatus } = require('./services/gmailService');
  res.json(await gmailStatus(pool, req.user.id));
});

app.get('/api/lm/gmail/connect', requireAuth, (req, res) => {
  const { GMAIL_SCOPES } = require('./services/gmailService');
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, GMAIL_CALLBACK
  );
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    prompt: 'consent',
    include_granted_scopes: true, // conserva calendar.events si ya estaba
    state: String(req.user.id),
  });
  res.redirect(url);
});

app.get('/api/lm/gmail/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.redirect(`${FRONTEND_URL}?gmail=error`);
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, GMAIL_CALLBACK
    );
    const { tokens } = await auth.getToken(code);
    await pool.query(
      `UPDATE users SET google_access_token=$1, google_refresh_token=$2, google_token_expiry=$3,
              google_scopes=$4 WHERE id=$5`,
      [tokens.access_token, tokens.refresh_token,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null,
       tokens.scope || '', userId]
    );
    res.redirect(`${FRONTEND_URL}?gmail=ok`);
  } catch (e) {
    console.error('[lm-gmail] callback error:', e.message);
    res.redirect(`${FRONTEND_URL}?gmail=error`);
  }
});

// ══════════════════════════════════════════════════════════════════
// TIME TRACKING
// ══════════════════════════════════════════════════════════════════

// GET /api/timer/running — restore active timer on page load
// POST /api/timer/ext-token — genera un token para la Browser Extension / Desktop Agent.
// Requiere sesión web (lo pide Nova desde el dashboard). El token en claro se devuelve UNA vez.
app.post('/api/timer/ext-token', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    const token  = 'nova_ext_' + crypto.randomBytes(24).toString('hex');
    const hash   = crypto.createHash('sha256').update(token).digest('hex');
    const label  = (req.body && req.body.label ? String(req.body.label) : 'Browser Extension').slice(0, 60);
    await pool.query(`INSERT INTO ext_tokens (user_id, token_hash, label) VALUES ($1,$2,$3)`, [req.user.id, hash, label]);
    res.status(201).json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/timer/running', requireAuthOrToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const r = await pool.query(
      `SELECT id, started_at, active_s, idle_s, task_id, task_titulo
       FROM time_entries WHERE user_id=$1 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`, [uid]);
    if (r.rows.length === 0) return res.json({ running: false });
    const e = r.rows[0];
    res.json({ running: true, entryId: e.id, startedAt: e.started_at,
               activeS: e.active_s, idleS: e.idle_s,
               taskId: e.task_id, taskTitle: e.task_titulo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/timer/start
// Time Tracking — enums de fuente/actividad (ver db.js). Web app solo emite manual_timer.
const TT_SOURCES = ['manual_timer', 'nova_web', 'browser_extension', 'desktop_agent', 'calendar_block', 'imported'];
const TT_TYPES   = ['active_work', 'idle', 'break', 'meeting', 'app_usage', 'website_usage', 'unknown'];

app.post('/api/timer/start', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    // Close any running entries first
    await pool.query(
      `UPDATE time_entries SET ended_at=NOW(),
         duration_s=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
       WHERE user_id=$1 AND ended_at IS NULL`, [uid]);

    const { task_id, task_titulo, project_nombre, metadata } = req.body;
    // El timer manual de la web siempre es manual_timer / active_work (sin simular fuentes externas).
    const source = TT_SOURCES.includes(req.body.source) ? req.body.source : 'manual_timer';
    const activityType = TT_TYPES.includes(req.body.activity_type) ? req.body.activity_type : 'active_work';
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    // Contexto explícito (p.ej. tareas de oportunidad, que no viven en la tabla tasks).
    let taskTitulo = (task_titulo || '').trim();
    let projectNombre = (project_nombre || '').trim();
    // La FK time_entries.task_id → tasks(id) es estricta. Verificamos que el task_id exista;
    // si no (tarea borrada, subtarea inconsistente, id de otra tabla, etc.) lo dejamos en null y
    // registramos por título, así el timer SIEMPRE arranca en vez de fallar con 500 en silencio.
    let validTaskId = task_id || null;
    if (validTaskId) {
      const tr = await pool.query(
        `SELECT t.titulo, p.nombre FROM tasks t
         LEFT JOIN projects p ON p.id=t.project_id
         WHERE t.id=$1`, [validTaskId]);
      if (tr.rows.length) {
        if (!taskTitulo)    taskTitulo    = tr.rows[0].titulo || '';
        if (!projectNombre) projectNombre = tr.rows[0].nombre || '';
      } else {
        validTaskId = null;   // el id no existe en tasks → registra por título
      }
    }
    const ins = await pool.query(
      `INSERT INTO time_entries (user_id,task_id,task_titulo,project_nombre,started_at,active_s,idle_s,source,activity_type,metadata)
       VALUES ($1,$2,$3,$4,NOW(),0,0,$5,$6,$7) RETURNING id, started_at`,
      [uid, validTaskId, taskTitulo, projectNombre, source, activityType, JSON.stringify(meta)]);
    const e = ins.rows[0];
    res.json({ entryId: e.id, startedAt: e.started_at, taskTitulo, projectNombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/timer/:id/pulse — heartbeat every 30s
app.patch('/api/timer/:id/pulse', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { active_s, idle_s } = req.body;
    await pool.query(
      `UPDATE time_entries SET active_s=$3, idle_s=$4,
         duration_s=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
       WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`,
      [req.params.id, uid, active_s || 0, idle_s || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/timer/:id/stop
app.post('/api/timer/:id/stop', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { active_s, idle_s, ended_at } = req.body;
    // ended_at opcional (auto-stop por inactividad / cierre de timer viejo): retro-data el fin.
    // Validado: parseable y no en el futuro (>1min). GREATEST evita duración negativa.
    let end = null;
    if (ended_at) { const d = new Date(ended_at); if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 60000) end = d.toISOString(); }
    await pool.query(
      `UPDATE time_entries
         SET ended_at   = GREATEST(started_at, COALESCE($5::timestamptz, NOW())),
             active_s   = $3, idle_s = $4,
             duration_s = EXTRACT(EPOCH FROM (GREATEST(started_at, COALESCE($5::timestamptz, NOW())) - started_at))::INTEGER
       WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`,
      [req.params.id, uid, active_s || 0, idle_s || 0, end]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/today
app.get('/api/timer/today', requireAuthOrToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const r = await pool.query(
      `SELECT id, task_id, task_titulo, project_nombre,
              started_at, ended_at, duration_s, active_s, idle_s, notes,
              source, activity_type, metadata
       FROM time_entries
       WHERE user_id=$1 AND started_at::date = CURRENT_DATE
       ORDER BY started_at DESC`, [uid]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/entries?start=&end=  — entries COMPLETOS (con metadata) en un rango
// arbitrario; alimenta la vista de Time Tracking por Día/Semana/Mes/Personalizado.
app.get('/api/timer/entries', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const wid = req.workspaceOwnerId;
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const member = (req.query.member || '').trim();
    // Enriquecemos cada entrada con la tarifa/moneda/tipo del proyecto (vía tarea → proyecto)
    // para poder calcular horas → dinero en el reporte de facturación por horas.
    const sel = `SELECT te.id, te.user_id, te.task_id, te.task_titulo, te.project_nombre,
              te.started_at, te.ended_at, te.duration_s, te.active_s, te.idle_s, te.notes,
              te.source, te.activity_type, te.metadata, te.approved, te.approved_at, te.approved_by,
              t.project_id, p.nombre AS proj_nombre, p.tarifa_hora, p.moneda, p.tipo_proyecto,
              c.nombre AS client_nombre
       FROM time_entries te
       LEFT JOIN tasks t     ON t.id = te.task_id
       LEFT JOIN projects p  ON p.id = t.project_id
       LEFT JOIN clients c   ON c.id = p.client_id`;

    // Ver el detalle de OTRO miembro (o de todo el equipo): solo admin (owner o admin/manager).
    if (member && member !== 'me') {
      let isAdmin = (uid === wid);
      if (!isAdmin) {
        const rr = await pool.query(
          `SELECT rol FROM team_members WHERE user_id=$1 AND email=(SELECT email FROM users WHERE id=$2)`,
          [wid, uid]);
        isAdmin = ['admin', 'manager'].includes(rr.rows[0]?.rol || '');
      }
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

      if (member === 'all') {
        const r = await pool.query(
          `${sel} WHERE te.user_id IN (SELECT id FROM users WHERE workspace_id=$1 OR id=$1)
             AND te.started_at >= $2 AND te.started_at <= $3 ORDER BY te.started_at DESC`, [wid, start, end]);
        return res.json(r.rows);
      }
      // resolver nombre del miembro → user_id dentro del workspace
      const mr = await pool.query(
        `SELECT u.id FROM users u
         LEFT JOIN team_members tm ON tm.email=u.email AND tm.user_id=$1
         WHERE (u.workspace_id=$1 OR u.id=$1)
           AND lower(COALESCE(tm.nombre, u.name, u.email)) = lower($2) LIMIT 1`, [wid, member]);
      if (!mr.rows.length) return res.json([]);
      const r = await pool.query(
        `${sel} WHERE te.user_id=$1 AND te.started_at >= $2 AND te.started_at <= $3 ORDER BY te.started_at DESC`,
        [mr.rows[0].id, start, end]);
      return res.json(r.rows);
    }

    const r = await pool.query(
      `${sel} WHERE te.user_id=$1 AND te.started_at >= $2 AND te.started_at <= $3 ORDER BY te.started_at DESC`,
      [uid, start, end]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/timer/ingest — receptor de actividad de FUENTES EXTERNAS (Fase 2/3).
// Lo consumirán la Browser Extension (website_usage) y el Desktop Agent (app_usage / idle real).
// La web app NO llama aquí; solo deja el contrato listo. No hay detección desde el navegador.
app.post('/api/timer/ingest', requireAuthOrToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const b = req.body || {};
    const source = TT_SOURCES.includes(b.source) ? b.source : null;
    if (!source || source === 'manual_timer') {
      return res.status(400).json({ error: 'source externo requerido (browser_extension | desktop_agent | calendar_block | imported)' });
    }
    const activityType = TT_TYPES.includes(b.activity_type) ? b.activity_type : 'unknown';
    if (!b.started_at) return res.status(400).json({ error: 'started_at requerido' });
    // appName / websiteDomain / windowTitle / confidence viajan dentro de metadata por ahora.
    const meta = Object.assign({}, b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
      b.app_name ? { appName: b.app_name } : {}, b.website_domain ? { websiteDomain: b.website_domain } : {},
      b.window_title ? { windowTitle: b.window_title } : {}, b.confidence != null ? { confidence: b.confidence } : {});
    const { rows } = await pool.query(
      `INSERT INTO time_entries
         (user_id, task_id, task_titulo, project_nombre, started_at, ended_at, duration_s, active_s, idle_s, source, activity_type, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [uid, b.task_id || null, b.task_titulo || '', b.project_nombre || '',
       b.started_at, b.ended_at || null, +b.duration_s || 0, +b.active_s || 0, +b.idle_s || 0,
       source, activityType, JSON.stringify(meta)]);
    res.status(201).json({ id: rows[0].id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/report?start=&end=
app.get('/api/timer/report', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [totalR, byDayR, byTaskR] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(duration_s),0) AS total_s FROM time_entries
         WHERE user_id=$1 AND started_at>=$2 AND started_at<=$3 AND ended_at IS NOT NULL`,
        [uid, start, end]),
      pool.query(
        `SELECT DATE(started_at) AS day, COALESCE(SUM(duration_s),0) AS duration_s,
                COALESCE(SUM(active_s),0) AS active_s
         FROM time_entries
         WHERE user_id=$1 AND started_at>=$2 AND started_at<=$3 AND ended_at IS NOT NULL
         GROUP BY day ORDER BY day`, [uid, start, end]),
      pool.query(
        `SELECT task_id, task_titulo, COALESCE(SUM(duration_s),0) AS total_s,
                COALESCE(SUM(active_s),0) AS active_s
         FROM time_entries
         WHERE user_id=$1 AND started_at>=$2 AND started_at<=$3 AND ended_at IS NOT NULL
         GROUP BY task_id, task_titulo ORDER BY total_s DESC LIMIT 20`,
        [uid, start, end]),
    ]);

    // Build full 7-day array (Mon-Sun)
    const startDate = new Date(start);
    const byDayMap = {};
    for (const row of byDayR.rows) byDayMap[row.day.toISOString().split('T')[0]] = row;
    const today = new Date().toISOString().split('T')[0];
    const byDay = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startDate.getTime() + i * 86400000);
      const key = d.toISOString().split('T')[0];
      const row = byDayMap[key] || {};
      return { day: key, duration_s: Number(row.duration_s || 0),
               active_s: Number(row.active_s || 0), isToday: key === today };
    });

    res.json({
      totalS: Number(totalR.rows[0].total_s),
      byDay,
      byTask: byTaskR.rows.map(r => ({ ...r, total_s: Number(r.total_s), active_s: Number(r.active_s) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/daily?start=&end=  — total trabajado POR DÍA en un rango (heatmap del dashboard).
// Un cuadrito por día. Solo entradas cerradas; devuelve solo los días con registro.
app.get('/api/timer/daily', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { start, end, active_only } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    // active_only: excluye la navegación web de la extensión (website_usage) → solo trabajo activo.
    const activeClause = active_only ? " AND activity_type <> 'website_usage'" : '';
    // Las fuentes de EVIDENCIA (extensión/agente) confirman actividad DENTRO de las sesiones
    // manuales; sumarlas duplicaría el mismo minuto (bug 2026-07-13: 4h34m reales → 7h39m).
    const r = await pool.query(
      `SELECT DATE(started_at) AS day, COALESCE(SUM(duration_s),0) AS duration_s
       FROM time_entries
       WHERE user_id=$1 AND started_at>=$2 AND started_at<=$3 AND ended_at IS NOT NULL${activeClause}
         AND COALESCE(source,'manual_timer') NOT IN ('browser_extension','desktop_agent')
       GROUP BY day ORDER BY day`, [uid, start, end]);
    res.json(r.rows.map(row => ({ day: row.day.toISOString().split('T')[0], duration_s: Number(row.duration_s) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/entries?start=&end=  — individual entries for calendar
app.get('/api/timer/entries', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const r = await pool.query(
      `SELECT id, task_id, task_titulo, project_nombre,
              started_at, ended_at, duration_s, active_s, notes
       FROM time_entries
       WHERE user_id=$1 AND started_at>=$2 AND started_at<$3
       ORDER BY started_at ASC`,
      [uid, start, end]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/team — admin only (workspace owner or admin member)
app.get('/api/timer/team', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const wid = req.workspaceOwnerId;
    // Allow workspace owner or members with admin/manager role
    if (uid !== wid) {
      const roleRow = await pool.query(
        `SELECT rol FROM team_members WHERE user_id=$1 AND email=(SELECT email FROM users WHERE id=$2)`,
        [wid, uid]);
      const rol = roleRow.rows[0]?.rol || '';
      if (!['admin', 'manager'].includes(rol)) return res.status(403).json({ error: 'Admin only' });
    }

    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    // total_s/sessions = solo sesiones propias (manual/bloques/importado); la evidencia
    // (extensión/agente) aporta active_s pero no suma horas ni cuenta como sesión.
    const r = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(tm.nombre, u.name, u.email) AS nombre,
              COALESCE(SUM(te.duration_s) FILTER (WHERE COALESCE(te.source,'manual_timer') NOT IN ('browser_extension','desktop_agent')),0) AS total_s,
              COALESCE(SUM(te.active_s),0) AS active_s,
              COUNT(te.id) FILTER (WHERE COALESCE(te.source,'manual_timer') NOT IN ('browser_extension','desktop_agent')) AS sessions
       FROM users u
       LEFT JOIN time_entries te ON te.user_id=u.id
         AND te.started_at>=$2 AND te.started_at<=$3 AND te.ended_at IS NOT NULL
       LEFT JOIN team_members tm ON tm.email=u.email AND tm.user_id=$1
       WHERE u.workspace_id=$1 OR u.id=$1
       GROUP BY u.id, tm.nombre, u.name, u.email
       ORDER BY total_s DESC`, [wid, start, end]);

    res.json(r.rows.map(r => ({
      userId: r.user_id, nombre: r.nombre,
      totalS: Number(r.total_s), activeS: Number(r.active_s), sessions: Number(r.sessions),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: ¿uid es admin del workspace wid? (owner o rol admin/manager en team_members)
async function _isWsAdmin(uid, wid) {
  if (uid === wid) return true;
  const rr = await pool.query(`SELECT rol FROM team_members WHERE user_id=$1 AND email=(SELECT email FROM users WHERE id=$2)`, [wid, uid]);
  return ['admin', 'manager'].includes(rr.rows[0]?.rol || '');
}

// DELETE /api/timer/:id — borrar sesión (propia y NO aprobada; el admin puede borrar cualquiera del workspace)
app.delete('/api/timer/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id, wid = req.workspaceOwnerId;
    const admin = await _isWsAdmin(uid, wid);
    const r = admin
      ? await pool.query(`DELETE FROM time_entries WHERE id=$1 AND user_id IN (SELECT id FROM users WHERE workspace_id=$2 OR id=$2)`, [req.params.id, wid])
      : await pool.query(`DELETE FROM time_entries WHERE id=$1 AND user_id=$2 AND approved=FALSE`, [req.params.id, uid]);
    if (!r.rowCount) return res.status(403).json({ error: 'No se puede eliminar (aprobada o sin permiso)' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/timer/:id — editar una sesión (tarea/proyecto, inicio, duración, tipo, notas).
// Miembro: solo las suyas y NO aprobadas. Admin: cualquiera del workspace.
app.put('/api/timer/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id, wid = req.workspaceOwnerId, id = req.params.id;
    const b = req.body || {};
    const cur = (await pool.query(`SELECT * FROM time_entries WHERE id=$1`, [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Sesión no encontrada' });
    const admin = await _isWsAdmin(uid, wid);
    const own = cur.user_id === uid;
    const inWs = admin && (await pool.query(`SELECT 1 FROM users WHERE id=$1 AND (workspace_id=$2 OR id=$2)`, [cur.user_id, wid])).rowCount > 0;
    if (!(own || inWs)) return res.status(403).json({ error: 'Sin permiso' });
    if (own && !admin && cur.approved) return res.status(403).json({ error: 'Sesión aprobada: pide a un admin que la reabra' });

    let taskId = b.task_id != null && b.task_id !== '' ? parseInt(b.task_id, 10) : null;
    let taskTit = String(b.task_titulo != null ? b.task_titulo : cur.task_titulo || '');
    let projNom = String(b.project_nombre != null ? b.project_nombre : cur.project_nombre || '');
    if (taskId) {
      const t = (await pool.query(`SELECT t.titulo, p.nombre AS proj FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=$1`, [taskId])).rows[0];
      if (!t) { taskId = null; } else { taskTit = t.titulo || taskTit; if (t.proj) projNom = t.proj; }
    }
    const started = b.started_at ? new Date(b.started_at) : new Date(cur.started_at);
    if (isNaN(started.getTime())) return res.status(400).json({ error: 'Fecha de inicio no válida' });
    let dur = b.duration_s != null ? Math.round(Number(b.duration_s)) : cur.duration_s;
    if (!isFinite(dur) || dur < 0) dur = cur.duration_s;
    const ended = new Date(started.getTime() + dur * 1000);
    const act = ['active_work', 'idle', 'break', 'meeting'].includes(b.activity_type) ? b.activity_type : cur.activity_type;
    const notes = b.notes != null ? String(b.notes).slice(0, 1000) : cur.notes;

    const r = await pool.query(
      `UPDATE time_entries SET task_id=$1, task_titulo=$2, project_nombre=$3, started_at=$4, ended_at=$5,
         duration_s=$6, active_s=$6, idle_s=0, activity_type=$7, notes=$8
       WHERE id=$9 RETURNING *`,
      [taskId, taskTit, projNom, started.toISOString(), ended.toISOString(), dur, act, notes, id]);
    res.json(r.rows[0]);
  } catch (e) { console.error('[timer-edit]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/timer/:id/approve  { approved } — aprobar/desaprobar una sesión (solo admin)
app.post('/api/timer/:id/approve', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id, wid = req.workspaceOwnerId;
    if (!(await _isWsAdmin(uid, wid))) return res.status(403).json({ error: 'Solo admin' });
    const approved = !!(req.body || {}).approved;
    const r = await pool.query(
      `UPDATE time_entries SET approved=$1, approved_at=$2, approved_by=$3
       WHERE id=$4 AND user_id IN (SELECT id FROM users WHERE workspace_id=$5 OR id=$5)
       RETURNING id, approved, approved_at, approved_by`,
      [approved, approved ? new Date().toISOString() : null, approved ? uid : null, req.params.id, wid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Sesión no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/timer/approve-bulk  { ids:[], approved } — aprobar/desaprobar varias (solo admin)
app.post('/api/timer/approve-bulk', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id, wid = req.workspaceOwnerId;
    if (!(await _isWsAdmin(uid, wid))) return res.status(403).json({ error: 'Solo admin' });
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    const approved = !!b.approved;
    if (!ids.length) return res.json({ ok: true, count: 0 });
    const r = await pool.query(
      `UPDATE time_entries SET approved=$1, approved_at=$2, approved_by=$3
       WHERE id = ANY($4::int[]) AND user_id IN (SELECT id FROM users WHERE workspace_id=$5 OR id=$5)`,
      [approved, approved ? new Date().toISOString() : null, approved ? uid : null, ids, wid]);
    res.json({ ok: true, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/analytics/summary?start=&end=&prev_start=&prev_end= ──
app.get('/api/analytics/summary', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const wid = req.workspaceOwnerId;
    const { start, end, prev_start, prev_end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const hasPrev = !!(prev_start && prev_end);

    // Facturación del dashboard por miembro: solo cobros de los proyectos donde el miembro es responsable.
    const memberQ = String(req.query.member || '').trim();
    let memberName = '';
    if (memberQ === 'me') {
      const mr = await pool.query(
        `SELECT COALESCE(tm.nombre, u.name, u.email) AS nombre
         FROM users u LEFT JOIN team_members tm ON tm.email=u.email AND tm.user_id=$1
         WHERE u.id=$2`, [wid, uid]);
      memberName = (mr.rows[0]?.nombre || '').trim();
    } else if (memberQ && memberQ !== 'all') {
      memberName = memberQ;
    }
    // Peso del miembro en el proyecto: si hay reparto ([{nombre,pct}]) manda el %, si no,
    // 100% para el/los responsables. Proyecto compartido 30-70 → cada quien ve SU parte.
    const pctExpr = `(CASE
        WHEN jsonb_array_length(COALESCE(p.reparto, '[]'::jsonb)) > 0 THEN
          COALESCE((SELECT (r->>'pct')::numeric FROM jsonb_array_elements(p.reparto) r WHERE LOWER(r->>'nombre') = LOWER($4) LIMIT 1), 0)
        WHEN LOWER(COALESCE(p.responsable, '')) = LOWER($4)
          OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.responsables, '{}')) rr WHERE LOWER(rr) = LOWER($4)) THEN 100
        ELSE 0 END) / 100.0`;
    const revWhere = memberName ? ` AND ${pctExpr} > 0` : '';
    const revSum   = memberName ? `SUM(t.monto * ${pctExpr})` : `SUM(t.monto)`;
    const revCurParams  = memberName ? [wid, start, end, memberName] : [wid, start, end];
    const revPrevParams = memberName ? [wid, prev_start, prev_end, memberName] : [wid, prev_start, prev_end];

    const [
      revCur, revPrev,
      tasksDoneSeries, tasksDonePrevTotal,
      tasksCreatedSeries,
      tasksByMember,
      timeByCur,
      timeDailyCur, timePrevTotal,
      pipelineRes, pendingRes, cobradoCountRes,
    ] = await Promise.all([
      // Revenue — tasks marked cobrado in current period, grouped by day+currency
      pool.query(
        `SELECT DATE(t.cobrado_at AT TIME ZONE 'America/Bogota')::text AS day,
                COALESCE(p.moneda, 'USD') AS moneda,
                COALESCE(${revSum}, 0) AS total
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         WHERE t.user_id=$1 AND t.cobrado=true
           AND t.cobrado_at >= $2 AND t.cobrado_at < $3${revWhere}
         GROUP BY 1, 2 ORDER BY 1, 2`,
        revCurParams
      ),
      // Revenue — previous period total per currency (for badge)
      hasPrev
        ? pool.query(
            `SELECT COALESCE(p.moneda, 'USD') AS moneda,
                    COALESCE(${revSum}, 0) AS total
             FROM tasks t
             LEFT JOIN projects p ON t.project_id = p.id
             WHERE t.user_id=$1 AND t.cobrado=true
               AND t.cobrado_at >= $2 AND t.cobrado_at < $3${revWhere}
             GROUP BY 1`,
            revPrevParams
          )
        : Promise.resolve({ rows: [] }),
      // Tasks completed — daily series (current)
      pool.query(
        `SELECT DATE(updated_at AT TIME ZONE 'America/Bogota')::text AS day,
                COUNT(*) AS count
         FROM tasks
         WHERE user_id=$1 AND estado='completado'
           AND updated_at >= $2 AND updated_at < $3
         GROUP BY 1 ORDER BY 1`,
        [wid, start, end]
      ),
      // Tasks completed — previous period total
      hasPrev
        ? pool.query(
            `SELECT COUNT(*) AS count
             FROM tasks
             WHERE user_id=$1 AND estado='completado'
               AND updated_at >= $2 AND updated_at < $3`,
            [wid, prev_start, prev_end]
          )
        : Promise.resolve({ rows: [{ count: 0 }] }),
      // Tasks created — daily series (current)
      pool.query(
        `SELECT DATE(created_at AT TIME ZONE 'America/Bogota')::text AS day,
                COUNT(*) AS count
         FROM tasks
         WHERE user_id=$1
           AND created_at >= $2 AND created_at < $3
         GROUP BY 1 ORDER BY 1`,
        [wid, start, end]
      ),
      // Tasks by team member (completed this period + overdue)
      pool.query(
        `SELECT NULLIF(TRIM(responsable), '') AS nombre,
                COUNT(*) FILTER (WHERE estado='completado'
                  AND updated_at >= $2 AND updated_at < $3) AS completed,
                COUNT(*) FILTER (WHERE deadline < NOW()::date
                  AND estado NOT IN ('completado')) AS overdue
         FROM tasks
         WHERE user_id=$1
           AND NULLIF(TRIM(responsable), '') IS NOT NULL
         GROUP BY 1
         HAVING COUNT(*) FILTER (WHERE estado='completado'
                    AND updated_at >= $2 AND updated_at < $3) > 0
             OR COUNT(*) FILTER (WHERE deadline < NOW()::date
                    AND estado NOT IN ('completado')) > 0
         ORDER BY completed DESC`,
        [wid, start, end]
      ),
      // Time — by member (workspace team)
      pool.query(
        `SELECT COALESCE(tm.nombre, u.name, u.email) AS nombre,
                COALESCE(SUM(te.active_s), 0)   AS active_s,
                COALESCE(SUM(te.duration_s), 0) AS total_s
         FROM users u
         LEFT JOIN time_entries te ON te.user_id = u.id
           AND te.started_at >= $2 AND te.started_at < $3
           AND te.ended_at IS NOT NULL
         LEFT JOIN team_members tm ON tm.email = u.email AND tm.user_id = $1
         WHERE u.workspace_id = $1 OR u.id = $1
         GROUP BY 1
         HAVING COALESCE(SUM(te.duration_s), 0) > 0
         ORDER BY active_s DESC`,
        [wid, start, end]
      ),
      // Time — daily series (workspace total)
      pool.query(
        `SELECT DATE(te.started_at AT TIME ZONE 'America/Bogota')::text AS day,
                COALESCE(SUM(te.active_s), 0) AS active_s
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         WHERE (u.workspace_id = $1 OR u.id = $1)
           AND te.started_at >= $2 AND te.started_at < $3
           AND te.ended_at IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        [wid, start, end]
      ),
      // Time — previous period total (for badge)
      hasPrev
        ? pool.query(
            `SELECT COALESCE(SUM(te.active_s), 0) AS total_active_s
             FROM time_entries te
             JOIN users u ON u.id = te.user_id
             WHERE (u.workspace_id = $1 OR u.id = $1)
               AND te.started_at >= $2 AND te.started_at < $3
               AND te.ended_at IS NOT NULL`,
            [wid, prev_start, prev_end]
          )
        : Promise.resolve({ rows: [{ total_active_s: 0 }] }),
      // Pipeline — active projects grouped by currency
      pool.query(
        `SELECT COALESCE(moneda, 'USD') AS moneda,
                COALESCE(SUM(valor_total), 0) AS pipeline,
                COUNT(*) AS count
         FROM projects
         WHERE user_id=$1 AND estado='activo'
         GROUP BY 1`,
        [wid]
      ),
      // Pending billing — tasks with monto set but not yet cobrado, grouped by currency
      pool.query(
        `SELECT COALESCE(p.moneda, 'USD') AS moneda,
                COALESCE(SUM(t.monto), 0) AS total
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         WHERE t.user_id=$1 AND t.cobrado IS NOT TRUE AND t.monto IS NOT NULL AND t.monto > 0
         GROUP BY 1`,
        [wid]
      ),
      // Cobrado count — tasks marked cobrado in current period (regardless of monto)
      pool.query(
        `SELECT COUNT(*) AS cobrado_count
         FROM tasks
         WHERE user_id=$1 AND cobrado=true
           AND cobrado_at >= $2 AND cobrado_at < $3`,
        [wid, start, end]
      ),
    ]);

    // Aggregate revenue by currency
    const revByCur = {}, prevRevByCur = {}, revByDay = {};
    for (const r of revCur.rows) {
      const mon = r.moneda || 'USD', amt = parseFloat(r.total) || 0;
      revByCur[mon] = (revByCur[mon] || 0) + amt;
      revByDay[r.day] = (revByDay[r.day] || 0) + amt;
    }
    for (const r of revPrev.rows) {
      const mon = r.moneda || 'USD';
      prevRevByCur[mon] = (prevRevByCur[mon] || 0) + (parseFloat(r.total) || 0);
    }
    const revTotal    = Object.values(revByCur).reduce((s, v) => s + v, 0);
    const revSeries   = Object.entries(revByDay).sort(([a],[b]) => a.localeCompare(b))
                          .map(([day, total]) => ({ date: day, total }));

    // Aggregate pipeline by currency
    const pipByCur = {}, pendByCur = {};
    let pipelineCount = 0;
    for (const r of pipelineRes.rows) {
      const mon = r.moneda || 'USD';
      pipByCur[mon] = (pipByCur[mon] || 0) + (parseFloat(r.pipeline) || 0);
      pipelineCount += parseInt(r.count) || 0;
    }
    for (const r of pendingRes.rows) {
      const mon = r.moneda || 'USD';
      pendByCur[mon] = (pendByCur[mon] || 0) + (parseFloat(r.total) || 0);
    }
    const pipelineTotal = Object.values(pipByCur).reduce((s, v) => s + v, 0);
    const pendingTotal  = Object.values(pendByCur).reduce((s, v) => s + v, 0);

    const tasksDoneTotal    = tasksDoneSeries.rows.reduce((s, r) => s + parseInt(r.count), 0);
    const tasksDonePrevTot  = parseInt(tasksDonePrevTotal.rows[0]?.count || 0);
    const teamActiveS  = timeByCur.rows.reduce((s, r) => s + parseInt(r.active_s), 0);
    const teamPrevS    = parseInt(timePrevTotal.rows[0]?.total_active_s || 0);
    const cobradoCount = parseInt(cobradoCountRes.rows[0]?.cobrado_count || 0);

    res.json({
      revenue: {
        series:        revSeries,
        total:         revTotal,
        by_currency:   revByCur,
        prev_by_currency: prevRevByCur,
        cobrado_count: cobradoCount,
      },
      pipeline: {
        total:          pipelineTotal,
        by_currency:    pipByCur,
        count:          pipelineCount,
        pending:        pendingTotal,
        pending_by_currency: pendByCur,
      },
      tasks: {
        completed_series: tasksDoneSeries.rows.map(r => ({ date: r.day, count: parseInt(r.count) })),
        created_series:   tasksCreatedSeries.rows.map(r => ({ date: r.day, count: parseInt(r.count) })),
        by_member:        tasksByMember.rows.map(r => ({
          nombre:    r.nombre,
          completed: parseInt(r.completed),
          overdue:   parseInt(r.overdue),
        })),
        total_completed: tasksDoneTotal,
        prev_completed:  tasksDonePrevTot,
      },
      time: {
        by_member: timeByCur.rows.map(r => ({
          nombre:   r.nombre,
          active_s: parseInt(r.active_s),
          total_s:  parseInt(r.total_s),
        })),
        daily_series:   timeDailyCur.rows.map(r => ({ date: r.day, active_s: parseInt(r.active_s) })),
        total_active_s: teamActiveS,
        prev_active_s:  teamPrevS,
      },
    });
  } catch (e) {
    console.error('[analytics/summary] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/mgmt/exchange-rates ─────────────────────────────────
app.get('/api/mgmt/exchange-rates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT exchange_rates FROM users WHERE id=$1', [req.workspaceOwnerId]
    );
    res.json(rows[0]?.exchange_rates || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/mgmt/exchange-rates ─────────────────────────────────
app.put('/api/mgmt/exchange-rates', requireAuth, async (req, res) => {
  try {
    const rates = req.body;
    if (typeof rates !== 'object' || Array.isArray(rates))
      return res.status(400).json({ error: 'Invalid rates object' });
    await pool.query(
      'UPDATE users SET exchange_rates=$1 WHERE id=$2',
      [JSON.stringify(rates), req.workspaceOwnerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 404 / global error ────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.includes('Only .xlsx'))
    return res.status(400).json({ error: err.message });
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// =================================================================
// STARTUP — init DB, wire Socket.io, start HTTP server
// =================================================================

// Wrap Express in a raw HTTP server so Socket.io can share it
const httpServer = http.createServer(app);

async function start() {
  await initDb();

  // ── Socket.io setup ──────────────────────────────────────────
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, _isAllowedOrigin(origin) ? (origin || '*') : false),
      credentials: true,
    },
    // Fall back to long-polling if WebSocket upgrade is blocked by nginx
    transports: ['polling', 'websocket'],
  });

  // Auth middleware: parse session cookie → look up user
  const wrap = mw => (socket, next) => mw(socket.request, {}, next);
  io.use(wrap(sessionMiddleware));
  io.use(async (socket, next) => {
    try {
      const userId = socket.request.session?.passport?.user;
      if (!userId) return next(new Error('Not authenticated'));
      const user = await findUserById(userId);
      if (!user) return next(new Error('User not found'));
      socket.workspaceOwnerId = user.workspace_id || user.id;
      socket.userId   = user.id;
      socket.userName = user.name || user.email;
      socket.userAvatar = user.avatar || '';
      next();
    } catch (err) {
      next(new Error('Auth error'));
    }
  });

  io.on('connection', socket => {
    const wid = socket.workspaceOwnerId;
    // Auto-join workspace room so owner can broadcast to all members
    socket.join(`ws:${wid}`);

    // Client subscribes to a specific channel
    socket.on('join_channel', channel => {
      // Leave previously joined channel rooms
      [...socket.rooms]
        .filter(r => r.startsWith(`ch:${wid}:`))
        .forEach(r => socket.leave(r));
      socket.join(`ch:${wid}:${channel}`);
    });

    // Client sends a message
    socket.on('send_message', async ({ channel, content, reply_to }) => {
      if (!channel || !content?.trim()) return;
      try {
        const replyJson = reply_to ? JSON.stringify(reply_to) : null;
        const { rows } = await pool.query(
          `INSERT INTO chat_messages (workspace_owner_id, channel, sender_id, content, reply_to)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [wid, channel, socket.userId, content.trim(), replyJson]
        );
        const msg = {
          ...rows[0],
          sender_name:   socket.userName,
          sender_avatar: socket.userAvatar,
        };
        // Emit to all workspace members so anyone gets notified,
        // even if viewing a different channel right now
        io.to(`ws:${wid}`).emit('new_message', msg);

        // Schedule a 2-minute delayed email to members who aren't the sender
        _scheduleChatNotif(pool, wid, channel, socket.userId, socket.userName, content.trim());
      } catch (err) {
        socket.emit('chat_error', { message: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected uid=${socket.userId}`);
    });

    console.log(`[socket] connected uid=${socket.userId} ws=${wid}`);
  });

  // ── Recordatorios de reuniones: cada minuto, revisa qué reuniones entraron
  //    en su ventana "recordatorio_min antes de la hora de inicio" y avisa por
  //    socket a todo el workspace. recordatorio_enviado evita que se repita.
  setInterval(async () => {
    try {
      const tz = process.env.TZ_DEFAULT || 'America/Lima';
      const { rows } = await pool.query(`
        SELECT id, user_id, titulo, fecha, hora_inicio, link
          FROM meetings
         WHERE recordatorio_min IS NOT NULL
           AND recordatorio_enviado = FALSE
           AND estado <> 'cancelada'
           AND hora_inicio IS NOT NULL
           AND (fecha + hora_inicio) AT TIME ZONE $1 - (recordatorio_min * INTERVAL '1 minute') <= NOW()
           AND (fecha + hora_inicio) AT TIME ZONE $1 > NOW()
      `, [tz]);
      for (const m of rows) {
        io.to(`ws:${m.user_id}`).emit('meeting_reminder', {
          id: m.id, titulo: m.titulo, fecha: m.fecha, hora_inicio: m.hora_inicio, link: m.link,
        });
        await pool.query(`UPDATE meetings SET recordatorio_enviado = TRUE WHERE id = $1`, [m.id]);
      }
    } catch (e) { console.error('[meetings] recordatorio job:', e.message); }
  }, 60 * 1000);

  // ── LM Fase A: workers de outreach (persisten estado en DB, PM2-safe) ──
  try {
    const apiBase = process.env.API_BASE_URL || 'https://api.kiwoc.com';
    require('./services/sendEngine').startSendEngine(pool, { apiBase, gmailCallback: GMAIL_CALLBACK });
    require('./services/replyWatcher').startReplyWatcher(pool, { gmailCallback: GMAIL_CALLBACK });
    require('./services/imapWatcher').startImapWatcher(pool);
    require('./services/dailyReport').startDailyReport(pool);
  } catch (e) { console.warn('[lm-workers] no iniciados:', e.message); }

  // ── HTTP server listen ───────────────────────────────────────
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✉  B2B Email Enricher`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Port → ${PORT} (0.0.0.0)`);
    console.log(`  Mode → ${ENV}`);
    console.log(`  DB   → PostgreSQL ✓`);
    console.log(`  Auth → ${process.env.GOOGLE_CLIENT_ID ? 'Google OAuth ✓' : 'no GOOGLE_CLIENT_ID'}`);
    console.log(`  WS   → Socket.io ✓\n`);

    if (ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
      const url    = `${process.env.RENDER_EXTERNAL_URL}/health`;
      const driver = url.startsWith('https') ? https : http;
      setInterval(() => {
        driver.get(url, r => {
          console.log(`[keep-alive] ${url} → ${r.statusCode}`);
          r.resume();
        }).on('error', e => console.warn(`[keep-alive] ping failed: ${e.message}`));
      }, 14 * 60 * 1000);
      console.log(`  Keep-alive → pinging every 14 min\n`);
    }
  });
}

start().catch(err => {
  console.error('[startup] fatal error:', err.message);
  process.exit(1);
});
