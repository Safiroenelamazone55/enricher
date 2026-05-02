/**
 * server.js — B2B Email Enricher API
 * Runs entirely on Node.js built-ins + minimal npm deps.
 * No external verification APIs.
 */

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const multer       = require('multer');
const path         = require('path');

const { enrichOneLead,
        enrichBatch }       = require('./services/emailService');
const { getMxRecords,
        cacheStats }        = require('./services/dnsService');
const { getCacheStats: patternCacheStats } = require('./services/domainPatternService');
const { resolveDomain }     = require('./services/domainResolver');
const { parseLeadsFile,
        buildResultsExcel,
        buildTemplateExcel } = require('./services/excelService');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3001;
const ENV  = process.env.NODE_ENV || 'development';
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT) || 500;

// ── Middleware ───────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods:          ['GET', 'POST', 'OPTIONS'],
  allowedHeaders:   ['Content-Type', 'Authorization'],
  exposedHeaders:   ['X-Parse-Warnings'],
  credentials:      false,
}));
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — wait a moment.' },
});
app.use('/api/', limiter);

// ── Multer (file uploads — memory storage) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname) ||
               file.mimetype.includes('spreadsheet') ||
               file.mimetype.includes('csv') ||
               file.mimetype.includes('excel') ||
               file.mimetype.includes('officedocument');
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files allowed'), ok);
  },
});

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── POST /api/enrich  ─────────────────────────────────────
// Single lead enrichment (JSON body)
// Body: { firstName, lastName, company }
app.post('/api/enrich', async (req, res) => {
  const { firstName, lastName, company } = req.body ?? {};

  if (!firstName || !lastName || !company) {
    return res.status(400).json({ error: 'firstName, lastName and company are required.' });
  }

  try {
    const result = await enrichOneLead({ firstName, lastName, company });
    res.json(result);
  } catch (err) {
    console.error('[/api/enrich]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/batch  ───────────────────────────────
// Batch enrichment from JSON array
// Body: { leads: [{firstName, lastName, company}, ...] }
app.post('/api/enrich/batch', async (req, res) => {
  const leads = req.body?.leads;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: '`leads` array is required.' });
  }
  if (leads.length > BATCH_LIMIT) {
    return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
  }

  try {
    const results = await enrichBatch(leads);
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[/api/enrich/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/enrich/upload  ──────────────────────────────
// Upload Excel → enrich → return Excel
app.post('/api/enrich/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype);
    if (leads.length === 0) {
      return res.status(400).json({ error: 'No leads found in file.', warnings });
    }
    if (leads.length > BATCH_LIMIT) {
      return res.status(400).json({ error: `File has ${leads.length} rows, max is ${BATCH_LIMIT}.` });
    }

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

// ── POST /api/enrich/upload-json  ────────────────────────
// Same as /upload but returns JSON — used by preview table
app.post('/api/enrich/upload-json', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const { leads, warnings } = parseLeadsFile(req.file.buffer, req.file.mimetype);
    if (leads.length > BATCH_LIMIT) {
      return res.status(400).json({ error: `Max ${BATCH_LIMIT} leads per request.` });
    }
    const results = await enrichBatch(leads);
    res.json({ count: results.length, warnings, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/template  ────────────────────────────────────
// Download a blank template Excel
app.get('/api/template', (_req, res) => {
  const buf = buildTemplateExcel();
  res.setHeader('Content-Disposition', 'attachment; filename="enricher-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── GET /api/domain-info  ─────────────────────────────────
// Quick MX check for a single domain
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

// ── GET /health  ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── 404 / error  ──────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.includes('Only .xlsx')) return res.status(400).json({ error: err.message });
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════
// enrichOneLead + enrichBatch are now in services/emailService.js
// ═══════════════════════════════════════════════════════════

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✉  B2B Email Enricher`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  API  → http://localhost:${PORT}`);
  console.log(`  Mode → ${ENV}\n`);

  // Keep-alive ping (Render free tier sleeps after 15 min inactivity)
  if (ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    const url      = `${process.env.RENDER_EXTERNAL_URL}/health`;
    const interval = 14 * 60 * 1000; // every 14 minutes
    const https    = require('https');
    const http     = require('http');
    const driver   = url.startsWith('https') ? https : http;

    setInterval(() => {
      driver.get(url, res => {
        console.log(`[keep-alive] ${url} → ${res.statusCode}`);
        res.resume();
      }).on('error', err => {
        console.warn(`[keep-alive] ping failed: ${err.message}`);
      });
    }, interval);

    console.log(`  Keep-alive → pinging every 14 min\n`);
  }
});
