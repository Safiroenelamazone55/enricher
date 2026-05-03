/**
 * server.js — B2B Email Enricher API
 */

require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const https     = require('https');
const http      = require('http');

// ── Database (PostgreSQL) — imported early so initDb() runs at startup ──
const { initDb } = require('./db');

// ── Service imports (defensive — a broken service never kills the server) ──
const { enrichOneLead, enrichBatch } = require('./services/emailService');

let _markBounced         = async () => false;
let _getBounceStatus     = async () => ({ status: 'not-found' });
let _findByMessageId     = async () => null;
try {
  const bv = require('./services/bounceVerifierService');
  _markBounced         = bv.markBounced;
  _getBounceStatus     = bv.getBounceStatus;
  _findByMessageId     = bv.findByMessageId;
} catch (e) {
  console.warn('[server] bounceVerifierService unavailable:', e.message);
}

const { getMxRecords }                    = require('./services/dnsService');
const { parseLeadsFile, buildResultsExcel,
        buildTemplateExcel }              = require('./services/excelService');

// ── App ───────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT) || 3001;
const ENV  = process.env.NODE_ENV || 'development';
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 500;

// ── CORS — first middleware, before everything else ───────────────
// Allows any *.kiwoc.com, *.pages.dev, *.onrender.com origin.
// Also honours the ALLOWED_ORIGINS env var for additional origins.
const _extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().toLowerCase())
  : [];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed =
    origin === '' ||
    origin.endsWith('.kiwoc.com') ||
    origin === 'https://kiwoc.com' ||
    origin.endsWith('.pages.dev') ||
    origin.endsWith('.onrender.com') ||
    _extraOrigins.includes('*') ||
    _extraOrigins.includes(origin.toLowerCase());

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin',   origin || '*');
    res.setHeader('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-Parse-Warnings');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '512kb' }));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — wait a moment.' },
});
app.use('/api/', limiter);

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
          // Find the verification record by SES MessageId → update DB
          const record = await _findByMessageId(mail.messageId || '');
          if (record) {
            await _markBounced(record.verifyId);
            console.log(`[bounce-handler] hard bounce verifyId=${record.verifyId} email=${record.email}`);
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
// Query current status of a bounce verification from PostgreSQL.
// Response:
//   { verifyId, status: 'pending'|'verified'|'bounced', confidence, ... }
//   or { error: 'ID not found' } with HTTP 404
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

// ── POST /api/enrich ──────────────────────────────────────────────
app.post('/api/enrich', async (req, res) => {
  const { firstName, lastName, company } = req.body ?? {};
  if (!firstName || !lastName || !company)
    return res.status(400).json({ error: 'firstName, lastName and company are required.' });
  try {
    res.json(await enrichOneLead({ firstName, lastName, company }));
  } catch (err) {
    console.error('[/api/enrich]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/batch ────────────────────────────────────────
app.post('/api/enrich/batch', async (req, res) => {
  const leads = req.body?.leads;
  if (!Array.isArray(leads) || leads.length === 0)
    return res.status(400).json({ error: '`leads` array is required.' });
  if (leads.length > BATCH_LIMIT)
    return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
  try {
    const results = await enrichBatch(leads);
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[/api/enrich/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/upload ───────────────────────────────────────
app.post('/api/enrich/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype);
    if (leads.length === 0)
      return res.status(400).json({ error: 'No leads found in file.', warnings });
    if (leads.length > BATCH_LIMIT)
      return res.status(400).json({ error: `File has ${leads.length} rows, max is ${BATCH_LIMIT}.` });
    console.log(`[upload] Processing ${leads.length} leads from "${req.file.originalname}"`);
    const results  = await enrichBatch(leads);
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
app.post('/api/enrich/upload-json', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype);
    if (leads.length > BATCH_LIMIT)
      return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
    const results = await enrichBatch(leads);
    res.json({ count: results.length, warnings, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/template ─────────────────────────────────────────────
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

  app.listen(PORT, () => {
    console.log(`\n  ✉  B2B Email Enricher`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  API  → http://localhost:${PORT}`);
    console.log(`  Mode → ${ENV}`);
    console.log(`  DB   → ${process.env.DATABASE_URL ? 'PostgreSQL ✓' : 'no DATABASE_URL'}\n`);

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
