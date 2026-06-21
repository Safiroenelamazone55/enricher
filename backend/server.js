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
    const result = parseHeaders(req.file.buffer);
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
  const { nombre, empresa, email, telefono, pais, estado, notas, comision_default } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients (user_id, nombre, empresa, email, telefono, pais, estado, notas, comision_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.workspaceOwnerId, nombre.trim(), empresa || '', email || '', telefono || '', pais || '',
       estado || 'activo', notas || '', comision_default || null]
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
  const { nombre, empresa, email, telefono, pais, estado, notas, comision_default } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(
      `UPDATE clients
          SET nombre=$3, empresa=$4, email=$5, telefono=$6, pais=$7,
              estado=$8, notas=$9, comision_default=$10, updated_at=NOW()
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId, nombre.trim(), empresa || '', email || '',
       telefono || '', pais || '', estado || 'activo', notas || '', comision_default || null]
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
              c.nombre AS client_nombre
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
          responsable, responsables, deadline, notas, monto, cobrado, parent_task_id } = req.body;
  if (!titulo?.trim())  return res.status(400).json({ error: 'El título es requerido' });
  if (!project_id)      return res.status(400).json({ error: 'El proyecto es requerido' });
  const respArr = Array.isArray(responsables) ? responsables : (responsable ? [responsable] : []);
  const respFirst = respArr[0] || '';
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks
         (user_id, project_id, titulo, descripcion, estado, prioridad, responsable, responsables, deadline, notas, monto, cobrado, parent_task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.workspaceOwnerId, project_id, titulo.trim(), descripcion || '',
       estado || 'pendiente', prioridad || 'media',
       respFirst, respArr, deadline || null, notas || '',
       monto != null ? +monto : null, cobrado ? true : false,
       parent_task_id || null]
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
          responsable, responsables, deadline, notas, monto, cobrado, parent_task_id } = req.body;
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
              monto=$12, cobrado=$13, parent_task_id=$14, updated_at=NOW()
        WHERE id=$1 AND user_id=$2
        RETURNING *`,
      [req.params.id, req.workspaceOwnerId, project_id, titulo.trim(),
       descripcion || '', estado || 'pendiente', prioridad || 'media',
       respFirst, respArr, deadline || null, notas || '',
       monto != null ? +monto : null, cobrado ? true : false,
       parent_task_id || null]
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
  const { nombre, empresa, email, telefono, pais, cargo, stage, fuente, valor_estimado, notas } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO leads (user_id,nombre,empresa,email,telefono,pais,cargo,stage,fuente,valor_estimado,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.workspaceOwnerId, nombre.trim(), empresa||'', email||'', telefono||'', pais||'', cargo||'',
        stage||'nuevo', fuente||'manual', valor_estimado||null, notas||'']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[leads] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear lead' });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  const { nombre, empresa, email, telefono, pais, cargo, stage, fuente, valor_estimado, notas } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const { rows } = await pool.query(`
      UPDATE leads SET nombre=$1,empresa=$2,email=$3,telefono=$4,pais=$5,cargo=$6,
        stage=$7,fuente=$8,valor_estimado=$9,notas=$10,updated_at=NOW()
      WHERE id=$11 AND user_id=$12 RETURNING *
    `, [nombre.trim(), empresa||'', email||'', telefono||'', pais||'', cargo||'',
        stage||'nuevo', fuente||'manual', valor_estimado||null, notas||'',
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
          monto_neto, fecha_esperada, fecha_pagada, estado, notas } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO payments
        (user_id, client_id, project_id, concepto, monto_bruto, porcentaje,
         monto_neto, fecha_esperada, fecha_pagada, estado, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [req.workspaceOwnerId, client_id || null, project_id || null,
        concepto || '', monto_bruto || 0, porcentaje || null,
        monto_neto || null, fecha_esperada || null, fecha_pagada || null,
        estado || 'pendiente', notas || '']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[mgmt/payments] POST error:', err.message);
    res.status(500).json({ error: 'Error al crear pago' });
  }
});

// ── PUT /api/mgmt/payments/:id ────────────────────────────────────
app.put('/api/mgmt/payments/:id', requireAuth, async (req, res) => {
  const { concepto, client_id, project_id, monto_bruto, porcentaje,
          monto_neto, fecha_esperada, fecha_pagada, estado, notas } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE payments
      SET concepto=$1, client_id=$2, project_id=$3, monto_bruto=$4,
          porcentaje=$5, monto_neto=$6, fecha_esperada=$7, fecha_pagada=$8,
          estado=$9, notas=$10, updated_at=NOW()
      WHERE id=$11 AND user_id=$12
      RETURNING *
    `, [concepto || '', client_id || null, project_id || null, monto_bruto || 0,
        porcentaje || null, monto_neto || null, fecha_esperada || null,
        fecha_pagada || null, estado || 'pendiente', notas || '',
        req.params.id, req.workspaceOwnerId]);
    if (!rows.length) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[mgmt/payments] PUT error:', err.message);
    res.status(500).json({ error: 'Error al actualizar pago' });
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

    const [cntRes, todayRes, urgentRes, projCntRes] = await Promise.all([

      // Count ALL pending tasks for this member (case-insensitive, dual-name)
      pool.query(`
        SELECT COUNT(*) AS total
        FROM tasks
        WHERE user_id = $1
          AND estado != 'completado'
          AND (
            ($2::text IS NOT NULL AND LOWER(responsable) = LOWER($2))
            OR ($3::text IS NOT NULL AND LOWER(responsable) = LOWER($3))
          )
      `, [uid, memberNombre, userDispName]),

      // Tasks due TODAY for this member
      pool.query(`
        SELECT t.id, t.titulo, t.estado, t.prioridad, t.deadline, t.responsable,
               p.nombre AS project_nombre, c.nombre AS client_nombre
        FROM   tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE  t.user_id = $1
          AND  t.estado != 'completado'
          AND  t.deadline = CURRENT_DATE
          AND  (
            ($2::text IS NOT NULL AND LOWER(t.responsable) = LOWER($2))
            OR ($3::text IS NOT NULL AND LOWER(t.responsable) = LOWER($3))
          )
        ORDER BY t.created_at DESC
        LIMIT 20
      `, [uid, memberNombre, userDispName]),

      // Overdue / blocked tasks for this member
      pool.query(`
        SELECT t.id, t.titulo, t.estado, t.prioridad, t.deadline, t.responsable,
               p.nombre AS project_nombre, c.nombre AS client_nombre
        FROM   tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN clients  c ON p.client_id  = c.id
        WHERE  t.user_id = $1
          AND  t.estado != 'completado'
          AND  ((t.deadline IS NOT NULL AND t.deadline < CURRENT_DATE) OR t.estado = 'bloqueado')
          AND  (
            ($2::text IS NOT NULL AND LOWER(t.responsable) = LOWER($2))
            OR ($3::text IS NOT NULL AND LOWER(t.responsable) = LOWER($3))
          )
        ORDER BY
          CASE t.estado WHEN 'bloqueado' THEN 1 ELSE 2 END,
          t.deadline ASC NULLS LAST
        LIMIT 12
      `, [uid, memberNombre, userDispName]),

      // Count active projects for this member (by ID or name, case-insensitive, dual-name)
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
      `UPDATE users SET google_access_token=$1, google_refresh_token=$2, google_token_expiry=$3 WHERE id=$4`,
      [tokens.access_token, tokens.refresh_token,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
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

// ══════════════════════════════════════════════════════════════════
// TIME TRACKING
// ══════════════════════════════════════════════════════════════════

// GET /api/timer/running — restore active timer on page load
app.get('/api/timer/running', requireAuth, async (req, res) => {
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
app.post('/api/timer/start', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    // Close any running entries first
    await pool.query(
      `UPDATE time_entries SET ended_at=NOW(),
         duration_s=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
       WHERE user_id=$1 AND ended_at IS NULL`, [uid]);

    const { task_id } = req.body;
    let taskTitulo = '', projectNombre = '';
    if (task_id) {
      const tr = await pool.query(
        `SELECT t.titulo, p.nombre FROM tasks t
         LEFT JOIN projects p ON p.id=t.project_id
         WHERE t.id=$1`, [task_id]);
      if (tr.rows.length) { taskTitulo = tr.rows[0].titulo || ''; projectNombre = tr.rows[0].nombre || ''; }
    }
    const ins = await pool.query(
      `INSERT INTO time_entries (user_id,task_id,task_titulo,project_nombre,started_at,active_s,idle_s)
       VALUES ($1,$2,$3,$4,NOW(),0,0) RETURNING id, started_at`,
      [uid, task_id || null, taskTitulo, projectNombre]);
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
    const { active_s, idle_s } = req.body;
    await pool.query(
      `UPDATE time_entries SET ended_at=NOW(), active_s=$3, idle_s=$4,
         duration_s=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
       WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`,
      [req.params.id, uid, active_s || 0, idle_s || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/timer/today
app.get('/api/timer/today', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const r = await pool.query(
      `SELECT id, task_id, task_titulo, project_nombre,
              started_at, ended_at, duration_s, active_s, idle_s, notes
       FROM time_entries
       WHERE user_id=$1 AND started_at::date = CURRENT_DATE
       ORDER BY started_at DESC`, [uid]);
    res.json(r.rows);
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
        `SELECT DATE(t.cobrado_at AT TIME ZONE 'UTC')::text AS day,
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
        `SELECT DATE(updated_at AT TIME ZONE 'UTC')::text AS day,
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
        `SELECT DATE(created_at AT TIME ZONE 'UTC')::text AS day,
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
        `SELECT DATE(te.started_at AT TIME ZONE 'UTC')::text AS day,
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
