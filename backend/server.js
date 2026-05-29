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

// ── Database (PostgreSQL) — imported early so initDb() runs at startup ──
const { initDb, findOrCreateUser, findUserById } = require('./db');

// ── Passport Google OAuth strategy ───────────────────────────────
// Loaded lazily so the server starts even if credentials are absent.
function _setupPassport() {
  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

  const callbackURL = 'https://enricher-t04s.onrender.com/api/auth/google/callback';
  console.log('[auth] callbackURL usado:', callbackURL);

  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID     || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      callbackURL,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email  = (profile.emails?.[0]?.value || '').toLowerCase();
        const avatar = profile.photos?.[0]?.value  || '';

        // ── Whitelist check ──────────────────────────────────────
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
        buildResultsExcel,
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
    res.setHeader('Access-Control-Allow-Methods',     'GET, POST, OPTIONS');
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
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   ENV === 'production',   // HTTPS only in prod
    sameSite: ENV === 'production' ? 'none' : 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
  },
}));

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
  if (req.isAuthenticated && req.isAuthenticated()) return next();
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
app.get('/api/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

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
// Returns the authenticated user or { loggedIn: false }.
app.get('/api/auth/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    const { id, email, name, avatar } = req.user;
    return res.json({ loggedIn: true, id, email, name, avatar });
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

    const jobId  = require('crypto').randomUUID();
    const userId = req.user?.id ?? null;
    const tag    = (typeof req.body?.tag === 'string' && req.body.tag.trim()) ? req.body.tag.trim() : null;

    await _jobCreate(jobId, userId, leads.length);

    // Fire and forget — do NOT await
    enrichBatch(leads, userId, tag, false)
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

    const results  = Array.isArray(job.results)  ? job.results  : [];
    const warnings = Array.isArray(job.warnings) ? job.warnings : [];
    res.json({ status: 'done', count: results.length, warnings, results });
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
  if (ids.length > 200) return res.status(400).json({ error: 'Max 200 per retry batch' });

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
  if (ids.length > 200) return res.status(400).json({ error: 'Max 200 per batch' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE verifications
          SET status = 'bounced', confidence = 'dismissed', resolved_at = NOW()
        WHERE bounceVerifyId = ANY($1::text[])
          AND user_id = $2
          AND status  = 'error'`,
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
// STARTUP — init DB then start HTTP server
// =================================================================
async function start() {
  // Create PostgreSQL tables if they don't exist (idempotent)
  await initDb();

  // Bind explicitly to 0.0.0.0 so Render's port scanner detects the
  // server regardless of which network interface it probes.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✉  B2B Email Enricher`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Port → ${PORT} (0.0.0.0)`);
    console.log(`  Mode → ${ENV}`);
    console.log(`  DB   → PostgreSQL ✓`);
    console.log(`  Auth → ${process.env.GOOGLE_CLIENT_ID ? 'Google OAuth ✓' : 'no GOOGLE_CLIENT_ID'}\n`);

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
