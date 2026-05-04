'use strict';

/**
 * db.js — PostgreSQL connection pool (singleton)
 *
 * Reads DATABASE_URL from the environment. If the variable is absent the
 * process exits immediately with a clear message — there is no fallback to
 * localhost and the server never starts in a broken state.
 *
 * Usage:
 *   const { pool, initDb } = require('./db');
 *   await initDb();                          // call once at startup
 *   const { rows } = await pool.query(...); // run any query
 */

const { Pool } = require('pg');

// ── Fail fast if DATABASE_URL is missing ──────────────────────────
// pg silently connects to 127.0.0.1:5432 when connectionString is
// undefined. We prevent that by crashing early with a clear message.
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    '[db] FATAL: DATABASE_URL environment variable is not set.\n' +
    '     Set it in Render → Environment before starting the server.'
  );
  process.exit(1);
}

// ── Connection pool ────────────────────────────────────────────────
// ssl.rejectUnauthorized:false is required for Render's managed
// Postgres (self-signed cert on the internal network).
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max:                     10,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis:  5_000,
});

pool.on('error', err => {
  console.error('[db] unexpected pool error:', err.message);
});

// ── Schema migration ───────────────────────────────────────────────
/**
 * Creates all required tables if they do not already exist.
 * Safe to call on every startup (idempotent).
 */
async function initDb() {
  console.log('[db] connecting to:', DATABASE_URL.replace(/:([^:@]+)@/, ':***@'));

  try {
    // ── users table (Google OAuth) ─────────────────────────────
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

    // ── verifications table ────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        bounceVerifyId  TEXT        PRIMARY KEY,
        email           TEXT        NOT NULL,
        leadId          TEXT        NOT NULL DEFAULT '',
        messageId       TEXT        NOT NULL DEFAULT '',
        status          TEXT        NOT NULL
                          CHECK (status IN ('pending', 'verified', 'bounced'))
                          DEFAULT 'pending',
        confidence      TEXT        NOT NULL DEFAULT 'pending',
        user_id         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      );
    `);

    // Add user_id column if the table already existed without it
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    // Index on email for fast getBounceStatusByEmail() lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_email_idx
        ON verifications (lower(email));
    `);

    // Index on messageId for fast SNS bounce matching
    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_messageid_idx
        ON verifications (messageId);
    `);

    console.log('[db] tables ready (users, verifications)');
  } catch (err) {
    console.error('[db] initDb failed:', err.message);
    throw err;
  }
}

// ── User helpers ───────────────────────────────────────────────────

/**
 * Upsert a Google user — insert on first login, update name/avatar on return.
 */
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

/** Find a user by internal integer id (used by Passport deserializeUser). */
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
  try {
    await pool.end();
    console.log('[db] pool closed');
  } catch (err) {
    console.error('[db] pool close error:', err.message);
  }
}

process.on('SIGINT',  () => closeDb().finally(() => process.exit(0)));
process.on('SIGTERM', () => closeDb().finally(() => process.exit(0)));

module.exports = { pool, initDb, closeDb, findOrCreateUser, findUserById };
