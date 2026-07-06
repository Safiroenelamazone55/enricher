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
const sessionMiddleware = session({
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
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
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
    return res.redirect('https://enricher.kiwoc.com?auth=ok');
  }

  passport.authenticate('google', { session: true }, (err, user) => {
    if (err) {
      // Log the error but don't crash — check if a session was established
      // by an earlier attempt (race condition / double-callback)
      console.warn('[auth] OAuth error:', err.message);
      if (req.isAuthenticated && req.isAuthenticated()) {
        return res.redirect('https://enricher.kiwoc.com?auth=ok');
      }
      return res.redirect('https://enricher.kiwoc.com?error=auth_failed');
    }

    if (!user) {
      // done(null, false) — whitelist rejection
      return res.redirect('https://enricher.kiwoc.com?error=unauthorized');
    }

    req.login(user, loginErr => {
      if (loginErr) return next(loginErr);
      console.log(`[auth] login ok — user ${user.email}`);
      res.redirect('https://enricher.kiwoc.com?auth=ok');
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

  const appUrl    = process.env.APP_URL || 'https://enricher.kiwoc.com';
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

  const subject = `💬 ${sendersLabel} en ${channelLabel} — Kiwoc`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#F9F5F2;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
    <div style="max-width:520px;margin:32px auto;border-radius:14px;overflow:hidden;
                box-shadow:0 4px 24px rgba(0,0,0,.08);background:#fff;border:1px solid #E5E1D8">
      <div style="background:linear-gradient(135deg,#F8B13F 0%,#E8921A 100%);padding:22px 28px">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:44px;height:44px;background:rgba(255,255,255,.25);border-radius:11px;
                      text-align:center;line-height:44px;font-size:22px">💬</div>
          <div>
            <div style="color:#fff;font-weight:700;font-size:1.05rem">Nuevo mensaje en Kiwoc</div>
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
          Kiwoc · Notificación automática de ${channelLabel}<br>No respondas a este correo.
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
    const { rows } = await pool.query(
      `SELECT * FROM clients WHERE user_id = $1 ORDER BY created_at DESC`,
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
          cargo, sitio_web, linkedin, industria, pais_empresa, ciudad, notas_empresa } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients
         (user_id, nombre, empresa, email, telefono, pais, estado, notas, comision_default,
          cargo, sitio_web, linkedin, industria, pais_empresa, ciudad, notas_empresa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.workspaceOwnerId, nombre.trim(), empresa || '', email || '', telefono || '',
       pais || '', estado || 'activo', notas || '', comision_default || null,
       cargo || '', sitio_web || '', linkedin || '', industria || '',
       pais_empresa || '', ciudad || '', notas_empresa || '']
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
    res.status(201).json(rows[0]);
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
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    const { rows } = await pool.query(
      `UPDATE projects
          SET client_id=$3, nombre=$4, descripcion=$5, estado=$6,
              responsable=$7, responsable_id=$8, responsables=$9,
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
       comision || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/projects] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar proyecto' });
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
              ), '[]'::json) AS waiting_on
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
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/tasks] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar tarea' });
  }
});

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
    res.json(rows[0]);
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
app.patch('/api/mgmt/tasks/:id/billing', requireAuth, async (req, res) => {
  const { monto, cobrado } = req.body;
  try {
    const sets = [];
    const vals = [req.params.id, req.workspaceOwnerId];
    if (monto !== undefined) sets.push(`monto=$${vals.push(monto === null || monto === '' ? null : +monto)}`);
    if (cobrado !== undefined) {
      sets.push(`cobrado=$${vals.push(!!cobrado)}`);
      sets.push(cobrado ? `cobrado_at=NOW()` : `cobrado_at=NULL`);
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
  const { titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO meetings (user_id, titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.workspaceOwnerId, titulo||'', fecha,
       hora_inicio||null, hora_fin||null,
       descripcion||'', link||'',
       JSON.stringify(Array.isArray(attendees) ? attendees : []),
       estado||'programada']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/mgmt/meetings/:id ────────────────────────────────────
app.put('/api/mgmt/meetings/:id', requireAuth, async (req, res) => {
  const { titulo, fecha, hora_inicio, hora_fin, descripcion, link, attendees, estado } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE meetings
       SET titulo=$1, fecha=$2, hora_inicio=$3, hora_fin=$4,
           descripcion=$5, link=$6, attendees=$7, estado=$8
       WHERE id=$9 AND user_id=$10 RETURNING *`,
      [titulo||'', fecha,
       hora_inicio||null, hora_fin||null,
       descripcion||'', link||'',
       JSON.stringify(Array.isArray(attendees) ? attendees : []),
       estado||'programada',
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
const LM_CO_COLS = ['nombre','dominio','website','industria','tamano','ingresos','telefono','linkedin','ciudad','region','pais','fundada','direccion','codigo_postal','descripcion','tecnologias','funding','target_tier','segmento','notas'];
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

// ── Contactos (lm_contacts) ────────────────────────────────────────
const LM_CT_COLS = ['nombre','apellido','email','email_personal','telefono','movil','cargo','seniority','departamento','linkedin','empresa_nombre','ciudad','region','pais','estado','fuente','contact_priority','buyer_role','notas'];
app.get('/api/lm/contacts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT k.*, co.nombre AS company_nombre, co.dominio AS company_dominio,
        co.website AS company_website, co.industria AS company_industria, co.tamano AS company_tamano,
        co.ingresos AS company_ingresos, co.ciudad AS company_ciudad, co.pais AS company_pais, co.target_tier AS company_target_tier, co.segmento AS company_segmento,
        COALESCE((SELECT json_agg(json_build_object('id', s.id, 'nombre', s.nombre, 'paso', cs.paso, 'estado', cs.estado, 'enrolled_at', COALESCE((cs.start_date + TIME '12:00')::timestamptz, cs.created_at), 'paso_date', cs.paso_date::text) ORDER BY s.nombre)
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
    const vals = LM_CT_COLS.map(k => _lmS(b[k]));
    const set = LM_CT_COLS.map((k, i) => `${k}=$${i + 1}`).join(',');
    const { rows } = await pool.query(`
      UPDATE lm_contacts SET ${set}, company_id=$${LM_CT_COLS.length + 1}, outbound_client_id=$${LM_CT_COLS.length + 2}, updated_at=NOW()
      WHERE id=$${LM_CT_COLS.length + 3} AND user_id=$${LM_CT_COLS.length + 4} RETURNING *
    `, [...vals, b.company_id || null, b.outbound_client_id || null, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
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
function _sanDate(v) { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
// today (fecha local del server como UTC-midnight, para aritmética de días sin tz-shift)
function _todayUTC() { const t = new Date(); return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); }
// avanza una fecha (UTC-midnight) hasta caer en un día permitido por la máscara
function _rollFwd(d, mask) { const x = new Date(d.getTime()); for (let i = 0; i < 7; i++) { if (mask[(x.getUTCDay() + 6) % 7] === '1') return x; x.setUTCDate(x.getUTCDate() + 1); } return x; }
// el k-ésimo (0-based) día permitido a partir de 'start'
function _nthAllowed(start, k, mask) { let x = _rollFwd(start, mask); for (let c = 0; c < k; c++) { x.setUTCDate(x.getUTCDate() + 1); x = _rollFwd(x, mask); } return x; }
function _ymd(d) { return d.toISOString().slice(0, 10); }

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
    const toAdd = ids.filter(id => exist.has(id) && !already.has(id));
    if (!toAdd.length) return res.json({ added: 0, requested: ids.length, spread_days: 0 });

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
    res.json({ added: r.rowCount, requested: ids.length, spread_days: spreadDays, per_day: drip });
  } catch (err) { console.error('[lm-mem]', err.message); res.status(500).json({ error: 'Error al añadir' }); }
}
// Reparte de nuevo los contactos AÚN SIN EMPEZAR (paso=1, activos) según drip_per_day y send_days.
// Útil cuando cambias el arranque escalonado DESPUÉS de haber enrolado (las fechas ya asignadas no se recalculan solas).
app.post('/api/lm/sequences/:id/redistribute', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, sid = parseInt(req.params.id);
  try {
    const sq = (await pool.query(`SELECT drip_per_day, send_days, starts_on::text AS starts_on FROM sequences WHERE id=$1 AND user_id=$2`, [sid, uid])).rows[0];
    if (!sq) return res.status(404).json({ error: 'Secuencia no encontrada' });
    const drip = Math.max(0, parseInt(sq.drip_per_day) || 0);
    if (!drip) return res.status(400).json({ error: 'Define primero “Arranque escalonado · contactos por día” en la secuencia' });
    const mask = _sanSendDays(sq.send_days);
    const { rows: enrs } = await pool.query(`SELECT id FROM lm_contact_sequences WHERE user_id=$1 AND sequence_id=$2 AND estado='activo' AND paso=1 ORDER BY start_date ASC NULLS FIRST, created_at ASC, id ASC`, [uid, sid]);
    if (!enrs.length) return res.json({ updated: 0, spread_days: 0, per_day: drip });
    let base = _todayUTC();
    if (sq.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(sq.starts_on)) { const [y, mo, d] = sq.starts_on.split('-').map(Number); const so = new Date(Date.UTC(y, mo - 1, d)); if (so > base) base = so; }
    const ids = [], dates = [];
    let slot = 0, cur = _nthAllowed(base, 0, mask), curStr = _ymd(cur), inDay = 0;
    for (const e of enrs) {
      while (inDay >= drip) { slot++; cur = _nthAllowed(base, slot, mask); curStr = _ymd(cur); inDay = 0; }
      ids.push(e.id); dates.push(curStr); inDay++;
    }
    await pool.query(`UPDATE lm_contact_sequences cs SET start_date=t.sd::date, next_action_at=t.sd::timestamptz FROM unnest($1::int[],$2::text[]) AS t(id,sd) WHERE cs.id=t.id`, [ids, dates]);
    res.json({ updated: ids.length, spread_days: new Set(dates).size, per_day: drip });
  } catch (err) { console.error('[lm-seq-redist]', err.message); res.status(500).json({ error: 'Error al repartir' }); }
});
app.post('/api/lm/contacts/add-to-sequence', requireAuth, (req, res) => _lmAddMembership(req, res, 'sequence'));
app.post('/api/lm/contacts/add-to-campaign', requireAuth, (req, res) => _lmAddMembership(req, res, 'campaign'));
// Disposición outbound: marca el contacto, registra actividad y (si aplica) lo pausa en TODAS sus secuencias activas.
app.post('/api/lm/contacts/:id/disposition', requireAuth, async (req, res) => {
  const uid = req.workspaceOwnerId, cid = req.params.id;
  const disp = _lmS((req.body || {}).disposition);
  const nota = _lmS((req.body || {}).nota);
  const seqId = (req.body || {}).sequence_id ? (parseInt((req.body).sequence_id) || null) : null;
  const EXIT = ['respondio', 'reunion', 'no_interesado', 'no_contactar'];
  try {
    const upd = await pool.query(`UPDATE lm_contacts SET disposition=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id, outbound_client_id`, [disp, cid, uid]);
    if (!upd.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    let paused = 0;
    if (disp && EXIT.includes(disp) && seqId) {
      const r = await pool.query(`UPDATE lm_contact_sequences SET estado='pausado' WHERE user_id=$1 AND contact_id=$2 AND sequence_id=$3 AND estado='activo'`, [uid, cid, seqId]);
      paused = r.rowCount;
    }
    if (disp) {
      const LBL = { respondio: 'Respondió', reunion: 'Reunión agendada', no_interesado: 'No interesado', no_contactar: 'No contactar (opt-out)' };
      const tipoMap = { respondio: 'respuesta', reunion: 'reunion', no_interesado: 'nota', no_contactar: 'nota' };
      await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,$4,$5,NOW(),'hecha')`,
        [uid, cid, upd.rows[0].outbound_client_id || null, tipoMap[disp] || 'nota', `Disposición: ${LBL[disp] || disp}${nota ? ' — ' + nota : ''}`]);
    }
    res.json({ ok: true, disposition: disp, paused: paused });
  } catch (err) { console.error('[lm-disp]', err.message); res.status(500).json({ error: 'Error al actualizar disposición' }); }
});

// ── Contactos enrolados en una secuencia (progreso) ──
app.get('/api/lm/sequences/:id/contacts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.contact_id, cs.paso, cs.estado, COALESCE((cs.start_date + TIME '12:00')::timestamptz, cs.created_at) AS enrolled_at, cs.paso_date::text AS paso_date,
        k.nombre, k.apellido, k.email, k.cargo, k.company_id, co.nombre AS company_nombre
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
    res.json(rows[0]);
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
        (SELECT COUNT(DISTINCT a.contact_id) FROM activities a WHERE a.user_id=$1 AND a.tipo='reunion' AND a.contact_id IN (SELECT contact_id FROM enr))::int AS reuniones
    `, [uid, sid]);
    res.json(rows[0] || {});
  } catch (err) { console.error('[lm-seq-met] GET', err.message); res.status(500).json({ error: 'Error al cargar métricas' }); }
});

// ═══════════════════════════════════════════════════════════════════
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
    const { rows: [m] } = await pool.query(`SELECT id FROM lm_messages WHERE track_token=$1`, [req.params.token]);
    if (m) await pool.query(
      `INSERT INTO lm_message_events (message_id, tipo, ip, user_agent) VALUES ($1,'open',$2,$3)`,
      [m.id, (req.headers['x-forwarded-for'] || req.ip || '').slice(0, 100), (req.headers['user-agent'] || '').slice(0, 300)]
    );
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

// ── Importación con mapeo (Excel/CSV → empresas + contactos) ───────
const LM_IMPORT_MAX = 5000;
app.post('/api/lm/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });
  const uid       = req.workspaceOwnerId;
  const target    = req.body?.target === 'companies' ? 'companies' : 'contacts';
  const obcId     = req.body?.outbound_client_id ? (parseInt(req.body.outbound_client_id) || null) : null;
  const hasHeader = req.body?.hasHeader !== '0' && req.body?.hasHeader !== 'false';
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

  const summary = { rows: 0, contactsCreated: 0, contactsSkipped: 0, companiesCreated: 0, companiesMatched: 0, errors: [] };
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
    if (found) { coCache.set(key, found.id); summary.companiesMatched++; return found.id; }
    const ins = await pool.query(`
      INSERT INTO lm_companies (user_id,nombre,dominio,website,industria,tamano,ingresos,telefono,linkedin,ciudad,region,pais,fundada,direccion,codigo_postal,descripcion,tecnologias,funding,target_tier,segmento,outbound_client_id,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id
    `, [uid, nombre || dominio, dominio, _lmS(f.website), _lmS(f.industria), _lmS(f.tamano), _lmS(f.ingresos),
        _lmS(f.telefono), _lmS(f.linkedin), _lmS(f.ciudad), _lmS(f.region), _lmS(f.pais), _lmS(f.fundada),
        _lmS(f.direccion), _lmS(f.codigo_postal), _lmS(f.descripcion), _lmS(f.tecnologias), _lmS(f.funding), _lmS(f.target_tier), _lmS(f.segmento), obcId, _lmS(f.notas)]);
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
        if (email) {
          const dup = (await pool.query(`SELECT id FROM lm_contacts WHERE user_id=$1 AND LOWER(email)=$2 LIMIT 1`, [uid, email])).rows[0];
          if (dup) { summary.contactsSkipped++; continue; }
        }
        const companyId = await _co({
          nombre: f.co_nombre, dominio: f.co_dominio, website: f.co_website, industria: f.co_industria,
          tamano: f.co_tamano, ingresos: f.co_ingresos, telefono: f.co_telefono, linkedin: f.co_linkedin,
          ciudad: f.co_ciudad, region: f.co_region, pais: f.co_pais, direccion: f.co_direccion,
          codigo_postal: f.co_cp, fundada: f.co_fundada, descripcion: f.co_descripcion,
          tecnologias: f.co_tecnologias, funding: f.co_funding, target_tier: f.co_target_tier, segmento: f.co_segmento,
        });
        await pool.query(`
          INSERT INTO lm_contacts (user_id,company_id,nombre,apellido,email,email_personal,telefono,movil,cargo,seniority,departamento,linkedin,empresa_nombre,ciudad,region,pais,estado,fuente,contact_priority,buyer_role,outbound_client_id,notas,raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        `, [uid, companyId, nombre, apellido, email, _lmS(f.email_personal), _lmS(f.telefono), _lmS(f.movil), _lmS(f.cargo), _lmS(f.seniority), _lmS(f.departamento),
            _lmS(f.linkedin), _lmS(f.co_nombre), _lmS(f.ciudad), _lmS(f.region), _lmS(f.pais), _lmS(f.estado) || 'nuevo', _lmS(f.fuente) || 'import', _lmS(f.contact_priority), _lmS(f.buyer_role), obcId, _lmS(f.notas), JSON.stringify(raw)]);
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

app.get('/api/sequences', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT *, starts_on::text AS starts_on FROM sequences WHERE user_id=$1 ORDER BY created_at DESC`, [req.workspaceOwnerId]);
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
      INSERT INTO sequences (user_id,outbound_client_id,campaign_id,nombre,objetivo,estado,timezone,drip_per_day,send_days,starts_on,daily_limit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.workspaceOwnerId, b.outbound_client_id || null, b.campaign_id || null, b.nombre.trim(), b.objetivo || '', estado, b.timezone || '', drip, sendDays, _sanDate(b.starts_on), dLim]);
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
    const { rows } = await pool.query(`
      UPDATE sequences SET outbound_client_id=$1,campaign_id=$2,nombre=$3,objetivo=$4,estado=$5,timezone=$6,drip_per_day=$7,send_days=$8,starts_on=$9,daily_limit=$10,updated_at=NOW()
      WHERE id=$11 AND user_id=$12 RETURNING *
    `, [b.outbound_client_id || null, b.campaign_id || null, b.nombre.trim(), b.objetivo || '', estado, b.timezone || '', drip, sendDays, _sanDate(b.starts_on), dLim, req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Secuencia no encontrada' });
    res.json(rows[0]);
  } catch (err) { console.error('[seq] PUT error:', err.message); res.status(500).json({ error: 'Error al actualizar secuencia' }); }
});
app.delete('/api/sequences/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM sequences WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!rowCount) return res.status(404).json({ error: 'Secuencia no encontrada' });
    res.json({ ok: true });
  } catch (err) { console.error('[seq] DELETE error:', err.message); res.status(500).json({ error: 'Error al eliminar secuencia' }); }
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
      INSERT INTO sequence_steps (user_id,sequence_id,dia,canal,titulo,plantilla,variants,variant_mode,variant_field,orden,hora)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.workspaceOwnerId, b.sequence_id, parseInt(b.dia) || 1, canal, b.titulo || '', b.plantilla || '', JSON.stringify(Array.isArray(b.variants) ? b.variants : []), b.variant_mode || 'off', b.variant_field || '', parseInt(b.orden) || 0, _sanHora(b.hora)]);
    res.status(201).json(rows[0]);
  } catch (err) { console.error('[step] POST error:', err.message); res.status(500).json({ error: 'Error al crear paso' }); }
});
app.put('/api/sequence-steps/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const canal = STEP_CANALES.includes(b.canal) ? b.canal : 'email';
  try {
    const { rows } = await pool.query(`
      UPDATE sequence_steps SET dia=$1,canal=$2,titulo=$3,plantilla=$4,variants=$5,variant_mode=$6,variant_field=$7,orden=$8,hora=$9 WHERE id=$10 AND user_id=$11 RETURNING *
    `, [parseInt(b.dia) || 1, canal, b.titulo || '', b.plantilla || '', JSON.stringify(Array.isArray(b.variants) ? b.variants : []), b.variant_mode || 'off', b.variant_field || '', parseInt(b.orden) || 0, _sanHora(b.hora), req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Paso no encontrado' });
    res.json(rows[0]);
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
      ORDER BY
        CASE estado
          WHEN 'pendiente' THEN 1
          WHEN 'vencido'   THEN 2
          WHEN 'cobrado'   THEN 3
          ELSE 4
        END,
        fecha_esperada ASC NULLS LAST,
        created_at DESC
    `, [req.workspaceOwnerId]);
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
    const inviteUrl = `https://enricher.kiwoc.com?join=${token}`;
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
const FRONTEND_URL  = 'https://enricher.kiwoc.com';

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
    const sel = `SELECT te.id, te.task_id, te.task_titulo, te.project_nombre,
              te.started_at, te.ended_at, te.duration_s, te.active_s, te.idle_s, te.notes,
              te.source, te.activity_type, te.metadata,
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
    const r = await pool.query(
      `SELECT DATE(started_at) AS day, COALESCE(SUM(duration_s),0) AS duration_s
       FROM time_entries
       WHERE user_id=$1 AND started_at>=$2 AND started_at<=$3 AND ended_at IS NOT NULL${activeClause}
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

    const r = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(tm.nombre, u.name, u.email) AS nombre,
              COALESCE(SUM(te.duration_s),0) AS total_s,
              COALESCE(SUM(te.active_s),0) AS active_s,
              COUNT(te.id) AS sessions
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

// DELETE /api/timer/:id — delete an entry
app.delete('/api/timer/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM time_entries WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]);
    res.json({ ok: true });
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
                COALESCE(SUM(t.monto), 0) AS total
         FROM tasks t
         LEFT JOIN projects p ON t.project_id = p.id
         WHERE t.user_id=$1 AND t.cobrado=true
           AND t.cobrado_at >= $2 AND t.cobrado_at < $3
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [wid, start, end]
      ),
      // Revenue — previous period total per currency (for badge)
      hasPrev
        ? pool.query(
            `SELECT COALESCE(p.moneda, 'USD') AS moneda,
                    COALESCE(SUM(t.monto), 0) AS total
             FROM tasks t
             LEFT JOIN projects p ON t.project_id = p.id
             WHERE t.user_id=$1 AND t.cobrado=true
               AND t.cobrado_at >= $2 AND t.cobrado_at < $3
             GROUP BY 1`,
            [wid, prev_start, prev_end]
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

  // ── LM Fase A: workers de outreach (persisten estado en DB, PM2-safe) ──
  try {
    const apiBase = process.env.API_BASE_URL || 'https://api.kiwoc.com';
    require('./services/sendEngine').startSendEngine(pool, { apiBase, gmailCallback: GMAIL_CALLBACK });
    require('./services/replyWatcher').startReplyWatcher(pool, { gmailCallback: GMAIL_CALLBACK });
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
