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
 *   Google / O365 block RCPT TO probing but STILL accept the DATA phase of a
 *   real SMTP session, then generate an NDR (bounce) if the mailbox is absent.
 *   SES handles the actual SMTP delivery; we only need to listen for the SNS
 *   notification.
 *
 * @aws-sdk/client-ses is required LAZILY (inside _client()) so the server
 * starts normally even if the package is not yet installed.
 *
 * State persistence:
 *   In-memory Map + backend/data/bounceVerifications.json
 *   Entries older than 2 hours are pruned on load.
 *
 * Exports:
 *   verifyEmail(email, leadId)       → Promise<SendResult>
 *   markBounced(verifyId)            → boolean
 *   getBounceStatus(verifyId)        → StatusResult
 *   getBounceStatusByEmail(email)    → 'valid'|'bounced'|'pending'|null
 *   findByMessageId(messageId)       → record | null
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Config ────────────────────────────────────────────────────────
const BOUNCE_TIMEOUT_MS = 60 * 60 * 1000;    // 1 hour → auto-mark valid
const MAX_AGE_MS        = 2  * 60 * 60 * 1000;
const DATA_DIR          = path.join(__dirname, '..', 'data');
const STORE_FILE        = path.join(DATA_DIR, 'bounceVerifications.json');

// ── SES client — LAZY so missing package doesn't crash the server ─
let _sesClient = null;

function _client() {
  if (_sesClient) return _sesClient;
  try {
    // Require is intentionally inside the function (lazy load).
    // If @aws-sdk/client-ses is not installed, verifyEmail() returns
    // { status: 'error' } instead of crashing the process at startup.
    const { SESClient } = require('@aws-sdk/client-ses');
    _sesClient = new SESClient({
      region:      process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
    return _sesClient;
  } catch (err) {
    throw new Error(`@aws-sdk/client-ses not available: ${err.message}`);
  }
}

// ── In-memory state ───────────────────────────────────────────────
// verifyId → { email, leadId, verifyId, messageId, sentAt, status, resolvedAt }
const _store      = new Map();
const _emailIndex = new Map();   // email (lowercase) → verifyId

_loadFromDisk();

// ═══════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Send a minimal verification email to `email`.
 * Non-blocking — the caller does not await the bounce result.
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

  // ── Skip if we already have a result for this address ─────────
  if (_emailIndex.has(key)) {
    const existingId = _emailIndex.get(key);
    const rec        = _store.get(existingId);
    if (rec) {
      if (rec.status === 'pending')
        return { status: 'already-pending',  verifyId: existingId };
      return   { status: 'already-resolved', verifyId: existingId, resolvedStatus: rec.status };
    }
  }

  // ── Guard: credentials + from address ─────────────────────────
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail)
    return { status: 'error', message: 'SES_FROM_EMAIL env var not set' };
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    return { status: 'error', message: 'AWS credentials not set' };

  const verifyId = crypto.randomUUID();

  // ── Build raw MIME with X-Verify-ID header ─────────────────────
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
    const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
    const cmd = new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(rawEmail, 'utf8') },
    });

    const response  = await _client().send(cmd);
    const messageId = response.MessageId || '';

    const record = {
      email,
      leadId,
      verifyId,
      messageId,
      sentAt: Date.now(),
      status: 'pending',
    };
    _store.set(verifyId, record);
    _emailIndex.set(key, verifyId);
    _saveToDisk();

    // Auto-mark valid after 1 hour if no bounce arrives
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

/** @returns {{ status, email?, leadId?, sentAt? }} */
function getBounceStatus(verifyId) {
  const r = _store.get(verifyId);
  if (!r) return { status: 'not-found' };
  return { status: r.status, email: r.email, leadId: r.leadId, sentAt: r.sentAt };
}

/**
 * Fast lookup by email address — used during enrichment scoring.
 * @returns {'valid'|'bounced'|'pending'|null}
 */
function getBounceStatusByEmail(email) {
  const verifyId = _emailIndex.get((email || '').toLowerCase());
  if (!verifyId) return null;
  const record = _store.get(verifyId);
  return record ? record.status : null;
}

/**
 * Find a record by SES MessageId (for SNS bounce matching).
 * SNS bounce notifications include mail.messageId.
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
      const { _timer, ...rest } = v;
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
      if (now - record.sentAt > MAX_AGE_MS) continue;   // prune stale

      _store.set(verifyId, record);
      _emailIndex.set(record.email.toLowerCase(), verifyId);

      if (record.status === 'pending') {
        const remaining = Math.max(0, BOUNCE_TIMEOUT_MS - (now - record.sentAt));
        const timer = setTimeout(() => _autoMarkValid(verifyId), remaining);
        timer.unref();
        record._timer = timer;
      }
    }

    if (_store.size) console.log(`[bounce-verifier] loaded ${_store.size} records from disk`);
  } catch (err) {
    console.warn(`[bounce-verifier] disk load failed: ${err.message}`);
  }
}
