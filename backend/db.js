'use strict';

/**
 * db.js — PostgreSQL connection pool (singleton)
 *
 * Uses the `pg` package (node-postgres).
 * Reads DATABASE_URL from the environment — Render injects it
 * automatically when a Postgres database is attached to the service.
 *
 * Usage:
 *   const { pool, initDb } = require('./db');
 *
 *   // Call once at startup (creates tables if they don't exist):
 *   await initDb();
 *
 *   // Run any query:
 *   const { rows } = await pool.query('SELECT ...', [params]);
 *
 * The pool is closed gracefully on SIGINT / SIGTERM so Render's
 * zero-downtime deploys don't leave dangling connections.
 */

const { Pool } = require('pg');

// ── Connection pool ────────────────────────────────────────────────
// ssl: rejectUnauthorized:false  is required for Render's managed
// Postgres (uses a self-signed cert on the internal network).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  max:              10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', err => {
  console.error('[db] unexpected pool error:', err.message);
});

// ── Schema migration ───────────────────────────────────────────────
/**
 * Creates the `verifications` table if it does not already exist.
 * Safe to call on every startup (idempotent).
 */
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set — PostgreSQL storage disabled');
    return;
  }

  try {
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
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      );
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

    console.log('[db] verifications table ready');
  } catch (err) {
    console.error('[db] initDb failed:', err.message);
    throw err;
  }
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

module.exports = { pool, initDb, closeDb };
