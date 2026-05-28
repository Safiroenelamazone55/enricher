'use strict';

/**
 * db.js — PostgreSQL connection pool (singleton)
 *
 * CONNECTION STRATEGY
 * ───────────────────
 * We parse DATABASE_URL manually and pass every parameter explicitly to
 * the pg Pool constructor. This prevents the pg library from falling back
 * to its own environment-variable defaults (PGHOST, PGPORT, PGDATABASE,
 * PGUSER, PGPASSWORD) which can silently redirect connections to
 * 127.0.0.1:5432 when the primary host is unreachable.
 *
 * If DATABASE_URL is missing or unparseable the process exits immediately
 * with a clear message — there is no localhost fallback, ever.
 *
 * RENDER INTERNAL vs EXTERNAL URL
 * ────────────────────────────────
 * Use the "Internal Database URL" shown in Render's database info page.
 * It looks like:
 *   postgresql://user:pass@dpg-xxxxxxxx-a/dbname
 *
 * That hostname (dpg-…-a) is only resolvable from Render services in the
 * SAME REGION. If you see ENOTFOUND, verify both the web service and the
 * database are in the same region (Render dashboard → Settings → Region).
 * If they differ, change the web service region to match, then redeploy.
 *
 * The "External Database URL" (…ohio.render.com:5432) works from anywhere
 * but is slower; use it only as a temporary fallback during debugging.
 */

const { Pool } = require('pg');

// ── 1. Require DATABASE_URL ────────────────────────────────────────
const RAW_URL = process.env.DATABASE_URL;

if (!RAW_URL) {
  console.error(
    '[db] FATAL: DATABASE_URL is not set.\n' +
    '     Add it in Render → Environment (use the Internal Database URL).'
  );
  process.exit(1);
}

// ── 2. Parse the URL — crash clearly if it is malformed ───────────
let _parsed;
try {
  _parsed = new URL(RAW_URL);
} catch (_) {
  console.error('[db] FATAL: DATABASE_URL is not a valid URL:', RAW_URL);
  process.exit(1);
}

const DB_HOST = _parsed.hostname;
const DB_PORT = parseInt(_parsed.port, 10) || 5432;
const DB_USER = decodeURIComponent(_parsed.username);
const DB_PASS = decodeURIComponent(_parsed.password);
const DB_NAME = _parsed.pathname.replace(/^\//, '');

if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.error(
    `[db] FATAL: DATABASE_URL is incomplete.\n` +
    `     host="${DB_HOST}" user="${DB_USER}" db="${DB_NAME}"\n` +
    `     Expected format: postgresql://user:pass@hostname/dbname`
  );
  process.exit(1);
}

console.log(`[db] resolved → host=${DB_HOST} port=${DB_PORT} db=${DB_NAME} user=${DB_USER}`);

// ── 3. Create pool with explicit params — no pg env-var fallback ───
// Passing each field individually means pg has nothing to infer from
// PGHOST / PGPORT / etc., eliminating the 127.0.0.1 fallback path.
const pool = new Pool({
  host:     DB_HOST,
  port:     DB_PORT,
  user:     DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  ssl:      { rejectUnauthorized: false },  // required for Render managed Postgres
  max:                      10,
  idleTimeoutMillis:        30_000,
  connectionTimeoutMillis:   5_000,
});

pool.on('error', err => {
  console.error('[db] unexpected pool error:', err.message);
});

// ── 4. Schema migration ────────────────────────────────────────────
async function initDb() {
  // Smoke-test the connection before running DDL so the error message
  // names the real host instead of a pg internal address.
  let client;
  try {
    client = await pool.connect();
    console.log('[db] connection established');
  } catch (err) {
    console.error(
      `[db] FATAL: cannot connect to ${DB_HOST}:${DB_PORT} — ${err.message}\n` +
      `     If you see ENOTFOUND, check that the Render web service and the\n` +
      `     database are in the SAME region (Render dashboard → Settings → Region).\n` +
      `     Then paste the "Internal Database URL" into the DATABASE_URL env var.`
    );
    throw err;
  } finally {
    client?.release();
  }

  try {
    // ── users table (Google OAuth) ───────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL      PRIMARY KEY,
        google_id   TEXT        UNIQUE NOT NULL,
        email       TEXT        NOT NULL,
        name        TEXT        NOT NULL DEFAULT '',
        avatar      TEXT        NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id);
    `);

    // ── verifications table ──────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        bounceVerifyId  TEXT        PRIMARY KEY,
        email           TEXT        NOT NULL,
        leadId          TEXT        NOT NULL DEFAULT '',
        messageId       TEXT        NOT NULL DEFAULT '',
        status          TEXT        NOT NULL
                          CHECK (status IN ('pending', 'verified', 'bounced', 'error'))
                          DEFAULT 'pending',
        confidence      TEXT        NOT NULL DEFAULT 'pending',
        user_id         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      );
    `);

    // Allow 'error' status on existing tables (safe: IF NOT EXISTS equivalent via DO block)
    await pool.query(`
      DO $$
      BEGIN
        ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_status_check;
        ALTER TABLE verifications ADD CONSTRAINT verifications_status_check
          CHECK (status IN ('pending','verified','bounced','error'));
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);

    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    // Ordered list of remaining candidates to try after a hard bounce (cascade)
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS remaining_candidates JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    // User-defined label for grouping / filtering verifications
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS tag TEXT;
    `);

    // Full lead data snapshot (firstName, lastName, company, + any extra CRM fields)
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS lead_data JSONB;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_email_idx
        ON verifications (lower(email));
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_messageid_idx
        ON verifications (messageId);
    `);

    // ── batch_jobs table ─────────────────────────────────────────
    // Persists background enrichment jobs so they survive server restarts.
    // Previously stored in-memory (_jobs Map) which was lost on Render restart.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        job_id      TEXT        PRIMARY KEY,
        user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        status      TEXT        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','done','error')),
        total       INTEGER     NOT NULL DEFAULT 0,
        results     JSONB,
        warnings    JSONB,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS batch_jobs_user_idx ON batch_jobs (user_id);
    `);

    // Auto-clean jobs older than 7 days to keep the table small
    await pool.query(`
      DELETE FROM batch_jobs WHERE created_at < NOW() - INTERVAL '7 days';
    `);

    // ── Dolor 1: mark stuck jobs as error on startup ──────────────
    // If the server restarted while a job was running, it stays 'running'
    // forever. Mark any job older than 2 hours as error so the frontend
    // shows a clear message instead of spinning indefinitely.
    const { rows: stuckJobs } = await pool.query(`
      UPDATE batch_jobs
         SET status = 'error',
             error  = 'El servidor se reinició durante el procesamiento. Vuelve a subir el archivo.',
             finished_at = NOW()
       WHERE status = 'running'
         AND created_at < NOW() - INTERVAL '2 hours'
       RETURNING job_id
    `);
    if (stuckJobs.length > 0)
      console.log(`[db] cleared ${stuckJobs.length} stuck job(s) from previous run`);

    // ── Dolor 5: index on leadid for sweep performance ────────────
    // The catch-all sweep does GROUP BY leadid — without an index it
    // does a full table scan. Partial index (non-null leadid only).
    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_leadid_status_idx
        ON verifications (leadid, status)
        WHERE leadid IS NOT NULL AND leadid != '';
    `);

    console.log('[db] tables ready (users, verifications, batch_jobs)');
  } catch (err) {
    console.error('[db] initDb failed:', err.message);
    throw err;
  }
}

// ── User helpers ───────────────────────────────────────────────────

async function findOrCreateUser({ googleId, email, name, avatar }) {
  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, name, avatar)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE
       SET email  = EXCLUDED.email,
           name   = EXCLUDED.name,
           avatar = EXCLUDED.avatar
     RETURNING id, google_id, email, name, avatar, created_at`,
    [googleId, email, name || '', avatar || '']
  );
  return rows[0];
}

async function findUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, google_id, email, name, avatar, created_at
       FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function closeDb() {
  try { await pool.end(); console.log('[db] pool closed'); }
  catch (err) { console.error('[db] pool close error:', err.message); }
}

process.on('SIGINT',  () => closeDb().finally(() => process.exit(0)));
process.on('SIGTERM', () => closeDb().finally(() => process.exit(0)));

module.exports = { pool, initDb, closeDb, findOrCreateUser, findUserById };
