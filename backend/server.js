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
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 500;

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
    const results = await enrichBatch(leads, req.user?.id ?? null, jsonTag);
    res.json({ count: results.length, warnings, results });
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
  const filterTag = (typeof req.query.tag === 'string' && req.query.tag.trim())
    ? req.query.tag.trim() : null;

  // DISTINCT ON (leadid) keeps one row per lead.
  // The ORDER BY inside picks the row with best status first:
  //   1 = verified, 2 = pending, 3 = bounced
  // then most recent created_at as tiebreaker.
  // The outer ORDER BY sorts the final list newest-first.
  const baseQuery = `
    SELECT * FROM (
      SELECT DISTINCT ON (leadid)
        bounceVerifyId, email, leadid, status, confidence, tag, lead_data, created_at, resolved_at
      FROM verifications
      WHERE user_id = $1
        ${filterTag ? 'AND lower(tag) = lower($2)' : ''}
      ORDER BY leadid,
        CASE status WHEN 'verified' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at DESC
    ) t
    WHERE status != 'bounced'
    ORDER BY created_at DESC`;

  try {
    const { rows } = await pool.query(
      baseQuery,
      filterTag ? [req.user.id, filterTag] : [req.user.id]
    );
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

// ── GET /api/user/verifications/export ───────────────────────────
// Downloads a CSV of the user's verifications.  Accepts optional ?tag=.
app.get('/api/user/verifications/export', requireAuth, async (req, res) => {
  const { pool } = require('./db');
  const filterTag = (typeof req.query.tag === 'string' && req.query.tag.trim())
    ? req.query.tag.trim() : null;
  try {
    // Same DISTINCT ON logic as the main endpoint — one row per lead, best status first
    const exportQuery = `
      SELECT * FROM (
        SELECT DISTINCT ON (leadid)
          email, leadid, status, confidence, tag, lead_data, created_at, resolved_at
        FROM verifications
        WHERE user_id = $1
          ${filterTag ? 'AND lower(tag) = lower($2)' : ''}
        ORDER BY leadid,
          CASE status WHEN 'verified' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
          created_at DESC
      ) t
      WHERE status != 'bounced'
      ORDER BY created_at DESC`;

    const { rows } = await pool.query(
      exportQuery,
      filterTag ? [req.user.id, filterTag] : [req.user.id]
    );

    // Build CSV — include firstName/lastName from lead_data when available
    const csvEscape = v => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['firstName', 'lastName', 'email', 'status', 'confidence', 'tag', 'createdAt', 'resolvedAt'];
    const lines  = [header.join(',')];
    for (const r of rows) {
      const ld = r.lead_data || {};
      lines.push([
        csvEscape(ld.firstName ?? ''),
        csvEscape(ld.lastName  ?? ''),
        csvEscape(r.email),
        csvEscape(r.status),
        csvEscape(r.confidence),
        csvEscape(r.tag ?? ''),
        csvEscape(r.created_at  ? new Date(r.created_at).toISOString()  : ''),
        csvEscape(r.resolved_at ? new Date(r.resolved_at).toISOString() : ''),
      ].join(','));
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
