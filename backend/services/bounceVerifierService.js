'use strict';

/**
 * bounceVerifierService.js  —  Real-send email verification via Amazon SES
 *
 * Strategy:
 *   1. Send a minimal real email to the candidate address via SES.
 *   2. SES delivers (or fails) asynchronously:
 *        - Hard bounce within minutes  →  mailbox does NOT exist  →  invalid
 *        - No bounce after 1 hour      →  assumed deliverable     →  valid
 *   3. SES → SNS → POST /api/bounce-handler carries the bounce notification.
 *      We match it back by the original SES MessageId (carried in SNS payload).
 *
 * Why this works where SMTP probing fails:
 *   Google / O365 block RCPT TO probing but they STILL accept the DATA phase
 *   of a real SMTP session, then generate an NDR (bounce) if the mailbox is
 *   absent. SES handles the actual SMTP delivery; we only need to listen for
 *   the resulting SNS notification.
 *
 * State persistence:
 *   In-memory Map + C:\enricher\backend\data\bounceVerifications.json
 *   Entries older than 2 hours are pruned on load.
 *
 * Public API:
 *   verifyEmail(email, leadId)          → Promise<SendResult>
 *   markBounced(verifyId)               → boolean
 *   getBounceStatus(verifyId)           → StatusResult
 *   getBounceStatusByEmail(email)       → 'valid'|'bounced'|'pending'|null
 *   findByMessageId(messageId)          → record | null
 */

const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

// ── Config ────────────────────────────────────────────────────────
const BOUNCE_TIMEOUT_MS = 60 * 60 * 1000;   // 1 hour → auto-mark valid
const MAX_AGE_MS        = 2  * 60 * 60 * 1000; // prune after 2 h
const DATA_DIR          = path.join(__dirname, '..', 'data');
const STORE_FILE        = path.join(DATA_DIR, 'bounceVerifications.json');

// ── SES client (lazy) ─────────────────────────────────────────────
let _sesClient = null;
function _client() {
  if (!_sesClient) {
    _sesClient = new SESClient({
      region:      process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
  }
  return _sesClient;
}

// ── In-memory state ───────────────────────────────────────────────
// verifyId → { email, leadId, verifyId, messageId, sentAt, status, resolvedAt }
const _store = new Map();

// email (lowercase) → verifyId  (fast reverse lookup)
const _emailIndex = new Map();

_loadFromDisk();

// ═══════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Send a minimal verification email to `email`.
 * Non-blocking — caller does not await the bounce result.
 *
 * @param {string} email   Candidate address to verify
 * @param {string} leadId  Opaque ID for cross-referencing
 * @returns {Promise<{
 *   status:     'sent'|'error'|'already-pending'|'already-resolved',
 *   verifyId?:  string,
 *   messageId?: string,
 *   message?:   string,
 * }>}
 */
async function verifyEmail(email, leadId = '') {
  if (!email) return { status: 'error', message: 'email required' };

  const key = email.toLowerCase();

  // ── Skip if we already have a result for this address ────────
  if (_emailIndex.has(key)) {
    const existingId = _emailIndex.get(key);
    const rec        = _store.get(existingId);
    if (rec) {
      if (rec.status === 'pending')  return { status: 'already-pending',  verifyId: existingId };
      if (rec.status !== 'pending')  return { status: 'already-resolved', verifyId: existingId, resolvedStatus: rec.status };
    }
  }

  // ── Guard: credentials must be present ───────────────────────
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    return { status: 'error', message: 'SES_FROM_EMAIL env var not set' };
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { status: 'error', message: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set' };
  }

  const verifyId = crypto.randomUUID();

  // ── Build raw MIME with custom X-Verify-ID header ────────────
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

  try {
    const cmd = new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(rawEmail, 'utf8') },
    });

    const response  = await _client().send(cmd);
    const messageId = response.MessageId || '';

    // ── Store record ─────────────────────────────────────────
    const record = {
      email,
      leadId,
      verifyId,
      messageId,
      sentAt:   Date.now(),
      status:   'pending',
    };
    _store.set(verifyId, record);
    _emailIndex.set(key, verifyId);
    _saveToDisk();

    // ── Auto-mark valid after 1 hour if no bounce arrives ─────
    const timer = setTimeout(() => _autoMarkValid(verifyId), BOUNCE_TIMEOUT_MS);
    timer.unref();
    record._timer = timer;

    console.log(`[bounce-verifier] SENT verifyId=${verifyId} to=${email} msgId=${messageId}`);
    return { status: 'sent', verifyId, messageId };

  } catch (err) {
    console.error(`[bounce-verifier] SES send failed for ${email}: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

/**
 * Mark a verification as hard-bounced.
 * Called by the SNS bounce handler in server.js.
 *
 * @param {string} verifyId
 * @returns {boolean}  true if record found and updated
 */
function markBounced(verifyId) {
  const record = _store.get(verifyId);
  if (!record) return false;

  if (record._timer) clearTimeout(record._timer);
  record.status     = 'bounced';
  record.resolvedAt = Date.now();
  _saveToDisk();

  console.log(`[bounce-verifier] HARD BOUNCE verifyId=${verifyId} email=${record.email}`);
  return true;
}

/**
 * @param {string} verifyId
 * @returns {{ status: 'pending'|'valid'|'bounced'|'not-found', email?: string, leadId?: string, sentAt?: number }}
 */
function getBounceStatus(verifyId) {
  const r = _store.get(verifyId);
  if (!r) return { status: 'not-found' };
  return { status: r.status, email: r.email, leadId: r.leadId, sentAt: r.sentAt };
}

/**
 * Fast lookup by email address — used during enrichment scoring.
 *
 * @param {string} email
 * @returns {'valid'|'bounced'|'pending'|null}  null = never verified
 */
function getBounceStatusByEmail(email) {
  const verifyId = _emailIndex.get((email || '').toLowerCase());
  if (!verifyId) return null;
  const record = _store.get(verifyId);
  return record ? record.status : null;
}

/**
 * Look up a record by SES MessageId (for SNS bounce matching).
 * The SNS bounce notification includes mail.messageId.
 *
 * @param {string} messageId  SES MessageId (e.g. "EXAMPLE7c191be45-…")
 * @returns {object|null}
 */
function findByMessageId(messageId) {
  for (const record of _store.values()) {
    if (record.messageId === messageId) return record;
  }
  return null;
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

function _autoMarkValid(verifyId) {
  const record = _store.get(verifyId);
  if (!record || record.status !== 'pending') return;

  record.status     = 'valid';
  record.resolvedAt = Date.now();
  _saveToDisk();

  console.log(`[bounce-verifier] AUTO-VALID (no bounce in 1h) verifyId=${verifyId} email=${record.email}`);
}

function _saveToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of _store) {
      const { _timer, ...rest } = v;   // don't serialize the timer handle
      obj[k] = rest;
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn(`[bounce-verifier] disk write failed: ${err.message}`);
  }
}

function _loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const now  = Date.now();

    for (const [verifyId, record] of Object.entries(data)) {
      // Prune stale entries (> 2 hours old)
      if (now - record.sentAt > MAX_AGE_MS) continue;

      _store.set(verifyId, record);
      _emailIndex.set(record.email.toLowerCase(), verifyId);

      // Re-arm auto-valid timer for still-pending records
      if (record.status === 'pending') {
        const remaining = Math.max(0, BOUNCE_TIMEOUT_MS - (now - record.sentAt));
        const timer = setTimeout(() => _autoMarkValid(verifyId), remaining);
        timer.unref();
        record._timer = timer;
      }
    }

    if (_store.size) {
      console.log(`[bounce-verifier] loaded ${_store.size} records from disk`);
    }
  } catch (err) {
    console.warn(`[bounce-verifier] disk load failed: ${err.message}`);
  }
}
