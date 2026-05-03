/**
 * server.js — B2B Email Enricher API
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const https     = require('https');
const http      = require('http');

// ── Service imports (all wrapped so a single missing file
//    never prevents the rest of the server from starting) ─────────
const { enrichOneLead, enrichBatch } = require('./services/emailService');

let _markBounced    = () => false;
let _getBounceStatus = () => ({ status: 'not-found' });
let _findByMessageId = () => null;
try {
  const bv = require('./services/bounceVerifierService');
  _markBounced     = bv.markBounced;
  _getBounceStatus = bv.getBounceStatus;
  _findByMessageId = bv.findByMessageId;
} catch (e) {
  console.warn('[server] bounceVerifierService unavailable:', e.message);
}

const { getMxRecords }                       = require('./services/dnsService');
const { parseLeadsFile, buildResultsExcel,
        buildTemplateExcel }                 = require('./services/excelService');

// ── App setup ─────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT) || 3001;
const ENV  = process.env.NODE_ENV || 'development';
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 500;

// ── CORS manual — MUST be first, before helmet and every route ────
// Allows any *.kiwoc.com or *.pages.dev origin.
// Also reads ALLOWED_ORIGINS env var for extra explicit origins.
const _extraOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().toLowerCase())
  : [];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  const allowed =
    origin === '' ||                                    // server-to-server (no Origin)
    origin.endsWith('.kiwoc.com') ||                    // *.kiwoc.com
    origin === 'https://kiwoc.com' ||                   // apex domain
    origin.endsWith('.pages.dev') ||                    // Cloudflare Pages previews
    origin.endsWith('.onrender.com') ||                 // Render preview deploys
    _extraOrigins.includes('*') ||                      // wildcard in env var
    _extraOrigins.includes(origin.toLowerCase());       // exact match in env var

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin',  origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers','X-Parse-Warnings');
  }

  // Preflight — answer immediately with 200 and stop processing
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
// ROUTES — bounce-handler is FIRST so it can never be shadowed
// =================================================================

// ── POST /api/bounce-handler ──────────────────────────────────────
// Receives SES bounce notifications from SNS.
// Registered before every other route and before the 404 handler.
app.post('/api/bounce-handler', (req, res) => {
  try {
    console.log('[bounce-handler] received');

    // Body parsing: express.json() handles application/json,
    // express.text() handles text/plain (SNS default).
    // Either way we need a plain JS object.
    const sns = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : (req.body || {});

    const type = sns.Type || sns.type || '';

    // SNS subscription confirmation — must GET the SubscribeURL
    if (type === 'SubscriptionConfirmation') {
      const url = sns.SubscribeURL;
      if (url) {
        const driver = url.startsWith('https') ? https : http;
        driver.get(url, r => r.resume()).on('error', () => {});
        console.log('[bounce-handler] SNS subscription confirmed');
      }
      return res.json({ status: 'ok' });
    }

    // Regular notification
    if (type === 'Notification') {
      const message = typeof sns.Message === 'string'
        ? JSON.parse(sns.Message)
        : (sns.Message || {});

      if (message.notificationType === 'Bounce') {
        const bounce = message.bounce || {};
        const mail   = message.mail   || {};

        if (bounce.bounceType === 'Permanent') {
          const record = _findByMessageId(mail.messageId || '');
          if (record) {
            _markBounced(record.verifyId);
            console.log(`[bounce-handler] hard bounce verifyId=${record.verifyId} email=${record.email}`);
          }
        } else {
          console.log(`[bounce-handler] soft bounce ignored (${bounce.bounceType})`);
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[bounce-handler] error:', err.message);
    res.json({ status: 'ok' }); // always 200 so SNS does not retry
  }
});

// ── GET /api/bounce-status/:verifyId ─────────────────────────────
app.get('/api/bounce-status/:verifyId', (req, res) => {
  res.json({ verifyId: req.params.verifyId, ..._getBounceStatus(req.params.verifyId) });
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

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✉  B2B Email Enricher`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  API  → http://localhost:${PORT}`);
  console.log(`  Mode → ${ENV}\n`);

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
