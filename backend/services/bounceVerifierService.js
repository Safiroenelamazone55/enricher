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
 * CASCADE VERIFICATION
 *   When a hard bounce arrives the handler calls cascadeVerification().
 *   It reads the `remaining_candidates` JSON array stored with the
 *   original verification, pops the first entry, and fires verifyEmail()
 *   for that address with the rest of the list — continuing until either
 *   an address is verified or the list is exhausted.
 *
 * Persistence: PostgreSQL (via db.js / pool).
 *
 * Exports:
 *   verifyEmail(email, leadId, userId, remainingCandidates)
 *   cascadeVerification(bouncedVerifyId)
 *   markBounced(verifyId)        → Promise<{ email, leadId, userId, remaining }>
 *   getBounceStatus(verifyId)
 *   getBounceStatusByEmail(email)
 *   findByMessageId(messageId)
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
  const { SESClient } = require('@aws-sdk/client-ses');
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
 * @param {string}   email
 * @param {string}   leadId             — composite key e.g. "Ana_López_acme.com"
 * @param {number|null} userId          — req.user.id (stored for /api/user/verifications)
 * @param {Array}    remainingCandidates — [{email, score, pattern}] to try after a bounce
 *
 * @returns {Promise<{
 *   status:    'sent'|'error'|'already-pending'|'already-resolved',
 *   verifyId?: string,
 *   messageId?: string,
 *   message?:  string,
 * }>}
 */
async function verifyEmail(email, leadId = '', userId = null, remainingCandidates = [], tag = null, leadData = null) {
  if (!email) return { status: 'error', message: 'email required' };

  const emailLower = email.toLowerCase();

  // ── 1. Cache fast path ───────────────────────────────────────────
  const cached = _cache.get(emailLower);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    if (cached.status === 'pending')
      return { status: 'already-pending',  verifyId: cached.verifyId };
    return   { status: 'already-resolved', verifyId: cached.verifyId,
               resolvedStatus: cached.status };
  }

  // ── 2. DB lookup (covers post-restart state) ─────────────────────
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
    const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
    const response = await _sesClientGet().send(
      new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawEmail, 'utf8') } })
    );
    messageId = response.MessageId || '';
  } catch (err) {
    console.error(`[bounce-verifier] SES send failed for ${email}: ${err.message}`);
    return { status: 'error', message: err.message };
  }

  // ── 5. Persist to PostgreSQL (includes remaining_candidates) ─────
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        `INSERT INTO verifications
           (bounceVerifyId, email, leadId, messageId, status, confidence,
            user_id, remaining_candidates, tag, lead_data)
         VALUES ($1, $2, $3, $4, 'pending', 'pending', $5, $6, $7, $8)
         ON CONFLICT (bounceVerifyId) DO NOTHING`,
        [
          verifyId, email, leadId, messageId,
          userId ?? null,
          JSON.stringify(Array.isArray(remainingCandidates) ? remainingCandidates : []),
          tag ?? null,
          leadData ? JSON.stringify(leadData) : null,
        ]
      );
    } catch (err) {
      console.warn('[bounce-verifier] DB insert failed:', err.message);
    }
  }

  // ── 6. Cache ─────────────────────────────────────────────────────
  _cache.set(emailLower, { verifyId, status: 'pending', ts: Date.now() });

  // ── 7. Auto-mark verified after 1 h ──────────────────────────────
  const timer = setTimeout(() => _autoMarkVerified(verifyId, emailLower), BOUNCE_TIMEOUT_MS);
  timer.unref();

  console.log(`[bounce-verifier] SENT verifyId=${verifyId} to=${email} msgId=${messageId} remaining=${remainingCandidates.length}`);
  return { status: 'sent', verifyId, messageId };
}

/**
 * Cascade verification after a hard bounce.
 *
 * Reads `remaining_candidates` from the bounced row, pops the first
 * entry and fires verifyEmail() with the rest of the list.  Repeats
 * automatically on every subsequent bounce via the same bounce-handler.
 *
 * @param {string} bouncedVerifyId
 */
async function cascadeVerification(bouncedVerifyId) {
  if (!process.env.DATABASE_URL) return;

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT email, leadid AS "leadId", user_id AS "userId",
              remaining_candidates AS "remaining", tag, lead_data AS "leadData"
         FROM verifications WHERE bounceVerifyId = $1`,
      [bouncedVerifyId]
    );
    if (!rows.length) return;
    row = rows[0];
  } catch (err) {
    console.warn('[cascade] DB read failed:', err.message);
    return;
  }

  const remaining = Array.isArray(row.remaining) ? row.remaining : [];

  if (remaining.length === 0) {
    console.log(`[cascade] sin más candidatos para leadId="${row.leadId}" (bounced: ${row.email})`);
    return;
  }

  const [next, ...rest] = remaining;
  console.log(`[cascade] probando siguiente candidato: ${next.email} (score=${next.score ?? '?'}, pattern=${next.pattern ?? '?'}) — quedan ${rest.length} tras este`);

  try {
    const result = await verifyEmail(next.email, row.leadId, row.userId, rest, row.tag ?? null, row.leadData ?? null);
    if (result.status === 'sent') {
      console.log(`[cascade] SENT verifyId=${result.verifyId} para ${next.email}`);
    } else {
      console.log(`[cascade] ${result.status} para ${next.email} — ${result.message ?? result.resolvedStatus ?? ''}`);
      // If already resolved/pending, try the next one immediately
      if (result.status === 'already-resolved' && rest.length > 0) {
        console.log(`[cascade] ${next.email} ya resuelto, saltando al siguiente`);
        await cascadeVerification(bouncedVerifyId);
      }
    }
  } catch (err) {
    console.warn(`[cascade] error enviando a ${next.email}: ${err.message}`);
  }
}

/**
 * Mark a verification as hard-bounced.
 * Returns the full relevant row so the caller can trigger cascade.
 *
 * @param {string} verifyId
 * @returns {Promise<{ email, leadId, userId, remaining } | null>}
 */
async function markBounced(verifyId) {
  let result = null;

  if (process.env.DATABASE_URL) {
    try {
      const { rows } = await pool.query(
        `UPDATE verifications
            SET status = 'bounced', confidence = 'invalid', resolved_at = NOW()
          WHERE bounceVerifyId = $1
          RETURNING email,
                    leadid               AS "leadId",
                    user_id              AS "userId",
                    remaining_candidates AS "remaining"`,
        [verifyId]
      );
      if (rows.length) result = rows[0];
    } catch (err) {
      console.warn('[bounce-verifier] DB markBounced failed:', err.message);
    }
  }

  if (result?.email) {
    _cache.set(result.email.toLowerCase(), { verifyId, status: 'bounced', ts: Date.now() });
  }

  console.log(`[bounce-verifier] HARD BOUNCE verifyId=${verifyId} email=${result?.email ?? '?'}`);
  return result;
}

/**
 * Get status of a verification by verifyId.
 */
async function getBounceStatus(verifyId) {
  if (!process.env.DATABASE_URL) return { status: 'not-found' };
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
 * Fast lookup by email — checks cache first, then DB.
 * @returns {Promise<'verified'|'bounced'|'pending'|null>}
 */
async function getBounceStatusByEmail(email) {
  const emailLower = (email || '').toLowerCase();

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

/**
 * Record a catch-all lead in the verifications table WITHOUT sending SES.
 * Catch-all domains accept every email address — SMTP/SES bounce verification
 * is meaningless for them. We still record the result so the user can see
 * these leads in the verifications dashboard with the "⚠️ Acepta todo" badge.
 *
 * @param {string}      email
 * @param {string}      leadId
 * @param {number|null} userId
 * @param {string|null} tag
 * @param {object|null} leadData   — must include { isCatchAll: true }
 */
async function recordCatchAll(email, leadId, userId, tag, leadData) {
  if (!email || !process.env.DATABASE_URL) return;

  const emailLower = email.toLowerCase();

  // Skip if already recorded (prevents duplicates on repeated enrichments)
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM verifications WHERE lower(email) = $1 LIMIT 1`,
      [emailLower]
    );
    if (rows.length) {
      console.log(`[catch-all-record] already exists for ${email} — skipping`);
      return;
    }
  } catch (_) { /* ignore — proceed with insert */ }

  const verifyId = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO verifications
         (bounceVerifyId, email, leadId, messageId, status, confidence,
          user_id, remaining_candidates, tag, lead_data)
       VALUES ($1, $2, $3, '', 'verified', 'catch-all', $4, '[]'::jsonb, $5, $6)
       ON CONFLICT (bounceVerifyId) DO NOTHING`,
      [
        verifyId, email, leadId,
        userId ?? null,
        tag    ?? null,
        leadData ? JSON.stringify(leadData) : null,
      ]
    );
    console.log(`[catch-all-record] recorded ${email} (leadId=${leadId})`);
  } catch (err) {
    console.warn('[catch-all-record] DB insert failed:', err.message);
  }
}

module.exports = {
  verifyEmail,
  cascadeVerification,
  markBounced,
  getBounceStatus,
  getBounceStatusByEmail,
  findByMessageId,
  recordCatchAll,
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

/**
 * Periodic sweep: mark any verifications that have been 'pending'
 * for more than BOUNCE_TIMEOUT_MS as 'verified'.
 *
 * This is the reliable fallback for when setTimeout timers are lost
 * on server restart (e.g. Render free tier spin-down).
 */
async function _sweepExpiredPending() {
  if (!process.env.DATABASE_URL) return;
  try {
    // ── Step 1: mark expired pending as verified ───────────────────
    const { rows } = await pool.query(
      `UPDATE verifications
          SET status = 'verified', confidence = 'guaranteed', resolved_at = NOW()
        WHERE status = 'pending'
          AND created_at < NOW() - INTERVAL '1 hour'
        RETURNING bounceVerifyId, email`
    );
    if (rows.length > 0) {
      console.log(`[bounce-verifier] SWEEP: auto-verified ${rows.length} expired pending row(s)`);
      rows.forEach(r => {
        _cache.set(r.email.toLowerCase(), { verifyId: r.bounceverifyid, status: 'verified', ts: Date.now() });
      });
    }

    // ── Step 2: detect multi-probe catch-all ──────────────────────
    // If 2+ distinct emails for the same leadId are all verified (and not already
    // flagged as catch-all), it means the domain accepted every probe → catch-all.
    // Update all matching rows to confidence='catch-all' and isCatchAll=true in lead_data.
    const { rows: catchAllRows } = await pool.query(`
      UPDATE verifications
        SET confidence = 'catch-all',
            lead_data  = jsonb_set(
              COALESCE(lead_data, '{}'::jsonb),
              '{isCatchAll}', 'true'::jsonb
            )
      WHERE leadid IN (
        SELECT leadid FROM verifications
        WHERE status    = 'verified'
          AND confidence NOT IN ('catch-all', 'guaranteed')
          AND leadid    IS NOT NULL
          AND leadid    != ''
        GROUP BY leadid
        HAVING COUNT(DISTINCT lower(email)) >= 2
      )
      AND status    = 'verified'
      AND confidence NOT IN ('catch-all', 'guaranteed')
      RETURNING bounceVerifyId, email, leadid
    `);
    if (catchAllRows.length > 0) {
      console.log(`[bounce-verifier] SWEEP: flagged ${catchAllRows.length} row(s) as catch-all (${[...new Set(catchAllRows.map(r => r.leadid))].length} leads)`);
      catchAllRows.forEach(r => {
        _cache.set(r.email.toLowerCase(), { verifyId: r.bounceverifyid, status: 'verified', ts: Date.now() });
      });
    }

  } catch (err) {
    console.warn('[bounce-verifier] _sweepExpiredPending error:', err.message);
  }
}

// Run the sweep every 5 minutes so no verification stays stuck even after a restart
const _sweepInterval = setInterval(_sweepExpiredPending, 5 * 60 * 1000);
if (_sweepInterval.unref) _sweepInterval.unref();
// Also run once shortly after startup to catch anything missed during downtime
setTimeout(_sweepExpiredPending, 10 * 1000).unref();
