'use strict';

/**
 * bounceVerifierService.js  —  Real-send email verification via Amazon SES
 *
 * Strategy:
 *   1. Send a minimal real email to the candidate address via SES.
 *   2. SES delivers asynchronously:
 *        - Hard bounce within minutes → mailbox absent  → status='bounced'
 *        - No bounce after 1 hour     → assumed live    → status='verified'
 *   3. SES → SNS → POST /api/bounce-handler routes the bounce back.
 *      We match it by the original SES MessageId stored in the DB.
 *
 * Persistence: PostgreSQL (via db.js / pool).
 *   No files are written to disk — safe for Render ephemeral filesystem.
 *
 * In-memory cache: a Map mirrors recent rows so getBounceStatusByEmail()
 *   doesn't hit the DB on every enrichment call.  Cache entries expire
 *   after CACHE_TTL_MS (2 h) or are invalidated on status change.
 *
 * @aws-sdk/client-ses is required LAZILY so the server starts normally
 * even if the package is not installed yet.
 *
 * Exports:
 *   verifyEmail(email, leadId)       → Promise<SendResult>
 *   markBounced(verifyId)            → Promise<boolean>
 *   getBounceStatus(verifyId)        → Promise<StatusResult>
 *   getBounceStatusByEmail(email)    → Promise<'verified'|'bounced'|'pending'|null>
 *   findByMessageId(messageId)       → Promise<record | null>
 */

const crypto = require('crypto');
const { pool } = require('../db');

// ── Config ─────────────────────────────────────────────────────────
const BOUNCE_TIMEOUT_MS = 60 * 60 * 1000;   // 1 h → auto-mark verified
const CACHE_TTL_MS      = 2  * 60 * 60 * 1000;

// ── In-memory cache (email.toLowerCase() → { verifyId, status, ts }) ──
const _cache = new Map();

// ── SES client (lazy) ──────────────────────────────────────────────
let _sesClient = null;

function _sesClientGet() {
  if (_sesClient) return _sesClient;
  const { SESClient } = require('@aws-sdk/client-ses');   // lazy
  _sesClient = new SESClient({
    region:      process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
  });
  return _sesClient;
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Send a minimal verification email and insert a row in `verifications`.
 *
 * @returns {Promise<{
 *   status:    'sent'|'error'|'already-pending'|'already-resolved',
 *   verifyId?: string,
 *   messageId?: string,
 *   message?:  string,
 * }>}
 */
async function verifyEmail(email, leadId = '') {
  if (!email) return { status: 'error', message: 'email required' };

  const emailLower = email.toLowerCase();

  // ── 1. Check cache first (fast path) ────────────────���───────────
  const cached = _cache.get(emailLower);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    if (cached.status === 'pending')
      return { status: 'already-pending',  verifyId: cached.verifyId };
    return   { status: 'already-resolved', verifyId: cached.verifyId,
               resolvedStatus: cached.status };
  }

  // ── 2. Check DB (covers post-restart lookups) ────────────────────
  if (process.env.DATABASE_URL) {
    try {
      const { rows } = await pool.query(
        `SELECT bounceVerifyId, status FROM verifications
          WHERE lower(email) = $1
          ORDER BY created_at DESC LIMIT 1`,
        [emailLower]
      );
      if (rows.length) {
        const row = rows[0];
        _cache.set(emailLower, { verifyId: row.bounceverifyid, status: row.status, ts: Date.now() });
        if (row.status === 'pending')
          return { status: 'already-pending',  verifyId: row.bounceverifyid };
        return   { status: 'already-resolved', verifyId: row.bounceverifyid,
                   resolvedStatus: row.status };
      }
    } catch (err) {
      console.warn('[bounce-verifier] DB lookup failed:', err.message);
    }
  }

  // ── 3. Guard: env vars ───────────────────────────────────────────
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail)
    return { status: 'error', message: 'SES_FROM_EMAIL env var not set' };
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    return { status: 'error', message: 'AWS credentials not set' };

  const verifyId = crypto.randomUUID();

  // ── 4. Build and send raw MIME email ────────────────────────────
  const rawEmail = [
    `From: ${fromEmail}`,
    `To: ${email}`,
    `Subject: Delivery Test`,
    `MIME-Version: 1.0`,
    `X-Verify-ID: ${verifyId}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    `This is an automated deliverability test. You may disregard this message.`,
  ].join('\r\n');

  let messageId = '';
  try {
    const { SendRawEmailCommand } = require('@aws-sdk/client-ses');   // lazy
    const response = await _sesClientGet().send(
      new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawEmail, 'utf8') } })
    );
    messageId = response.MessageId || '';
  } catch (err) {
    console.error(`[bounce-verifier] SES send failed for ${email}: ${err.message}`);
    return { status: 'error', message: err.message };
  }

  // ── 5. Persist to PostgreSQL ─────────────────────────────────────
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        `INSERT INTO verifications
           (bounceVerifyId, email, leadId, messageId, status, confidence)
         VALUES ($1, $2, $3, $4, 'pending', 'pending')
         ON CONFLICT (bounceVerifyId) DO NOTHING`,
        [verifyId, email, leadId, messageId]
      );
    } catch (err) {
      console.warn('[bounce-verifier] DB insert failed:', err.message);
      // Continue — in-memory timer still works as fallback
    }
  }

  // ── 6. Update in-memory cache ────────────────────────────────────
  _cache.set(emailLower, { verifyId, status: 'pending', ts: Date.now() });

  // ── 7. Auto-mark verified after 1 h (no bounce = deliverable) ────
  const timer = setTimeout(() => _autoMarkVerified(verifyId, emailLower), BOUNCE_TIMEOUT_MS);
  timer.unref();

  console.log(`[bounce-verifier] SENT verifyId=${verifyId} to=${email} msgId=${messageId}`);
  return { status: 'sent', verifyId, messageId };
}

/**
 * Mark a verification as hard-bounced.
 * Called by the SNS bounce handler in server.js.
 *
 * @param {string} verifyId
 * @returns {Promise<boolean>}
 */
async function markBounced(verifyId) {
  let email = null;

  if (process.env.DATABASE_URL) {
    try {
      const { rows } = await pool.query(
        `UPDATE verifications
            SET status = 'bounced', confidence = 'invalid', resolved_at = NOW()
          WHERE bounceVerifyId = $1
          RETURNING email`,
        [verifyId]
      );
      if (rows.length) email = rows[0].email;
    } catch (err) {
      console.warn('[bounce-verifier] DB markBounced failed:', err.message);
    }
  }

  // Invalidate cache entry
  if (email) {
    _cache.set(email.toLowerCase(), { verifyId, status: 'bounced', ts: Date.now() });
  }

  console.log(`[bounce-verifier] HARD BOUNCE verifyId=${verifyId} email=${email ?? '?'}`);
  return !!email;
}

/**
 * Get status of a verification by verifyId.
 * Returns the row from PostgreSQL (or a not-found stub if DB is unavailable).
 *
 * @param {string} verifyId
 * @returns {Promise<{ status, confidence, email?, created_at? }>}
 */
async function getBounceStatus(verifyId) {
  if (!process.env.DATABASE_URL) {
    return { status: 'not-found' };
  }
  try {
    const { rows } = await pool.query(
      `SELECT bounceVerifyId, email, status, confidence, created_at, resolved_at
         FROM verifications WHERE bounceVerifyId = $1`,
      [verifyId]
    );
    if (!rows.length) return { status: 'not-found' };
    const r = rows[0];
    return {
      status:     r.status,
      confidence: r.confidence,
      email:      r.email,
      createdAt:  r.created_at,
      resolvedAt: r.resolved_at,
    };
  } catch (err) {
    console.warn('[bounce-verifier] getBounceStatus DB error:', err.message);
    return { status: 'not-found' };
  }
}

/**
 * Fast lookup by email — used during enrichment scoring.
 * Checks cache first, then DB.
 *
 * @returns {Promise<'verified'|'bounced'|'pending'|null>}
 */
async function getBounceStatusByEmail(email) {
  const emailLower = (email || '').toLowerCase();

  // Cache hit
  const cached = _cache.get(emailLower);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.status;

  if (!process.env.DATABASE_URL) return null;

  try {
    const { rows } = await pool.query(
      `SELECT bounceVerifyId, status FROM verifications
        WHERE lower(email) = $1
        ORDER BY created_at DESC LIMIT 1`,
      [emailLower]
    );
    if (!rows.length) return null;
    const row = rows[0];
    _cache.set(emailLower, { verifyId: row.bounceverifyid, status: row.status, ts: Date.now() });
    return row.status;
  } catch (err) {
    console.warn('[bounce-verifier] getBounceStatusByEmail DB error:', err.message);
    return null;
  }
}

/**
 * Find a verification record by SES MessageId.
 * Used by the SNS bounce handler to match back to the verifyId.
 *
 * @param {string} messageId  SES MessageId from SNS notification
 * @returns {Promise<{ verifyId, email } | null>}
 */
async function findByMessageId(messageId) {
  if (!messageId || !process.env.DATABASE_URL) return null;
  try {
    const { rows } = await pool.query(
      `SELECT bounceVerifyId, email FROM verifications WHERE messageId = $1 LIMIT 1`,
      [messageId]
    );
    if (!rows.length) return null;
    return { verifyId: rows[0].bounceverifyid, email: rows[0].email };
  } catch (err) {
    console.warn('[bounce-verifier] findByMessageId DB error:', err.message);
    return null;
  }
}

module.exports = {
  verifyEmail,
  markBounced,
  getBounceStatus,
  getBounceStatusByEmail,
  findByMessageId,
};

// ═══════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════

async function _autoMarkVerified(verifyId, emailLower) {
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        `UPDATE verifications
            SET status = 'verified', confidence = 'guaranteed', resolved_at = NOW()
          WHERE bounceVerifyId = $1 AND status = 'pending'`,
        [verifyId]
      );
    } catch (err) {
      console.warn('[bounce-verifier] _autoMarkVerified DB error:', err.message);
    }
  }
  _cache.set(emailLower, { verifyId, status: 'verified', ts: Date.now() });
  console.log(`[bounce-verifier] AUTO-VERIFIED (no bounce in 1h) verifyId=${verifyId}`);
}
