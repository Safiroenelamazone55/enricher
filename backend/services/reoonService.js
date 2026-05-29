'use strict';

/**
 * reoonService.js — Email verification via Reoon Email Verifier API
 *
 * Used as fallback when SMTP from Render returns 'unknown' (IP blocked).
 * Reoon uses clean IPs → gets definitive valid/invalid/catch-all answers.
 *
 * API docs: https://reoon.com/email-verifier/api/
 * Mode: power (SMTP verification, more accurate)
 */

const REOON_API_KEY = process.env.REOON_API_KEY || '';
const REOON_TIMEOUT = 25_000; // 25s per verification

// Simple in-memory cache to avoid re-verifying same email
const _cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Verify a single email via Reoon API.
 * Returns: 'valid' | 'invalid' | 'catch-all' | 'unknown'
 */
async function verifyEmailReoon(email) {
  if (!REOON_API_KEY) return 'unknown';
  if (!email) return 'unknown';

  const emailLower = email.toLowerCase();

  // Cache hit
  const cached = _cache.get(emailLower);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[reoon] cache hit: ${emailLower} → ${cached.result}`);
    return cached.result;
  }

  try {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(emailLower)}&key=${REOON_API_KEY}&mode=power`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REOON_TIMEOUT);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[reoon] HTTP ${res.status} for ${emailLower}`);
      return 'unknown';
    }

    const data = await res.json();
    console.log(`[reoon] ${emailLower} → status="${data.status}" mx="${data.mx_found}"`);

    // Map Reoon status to our internal status
    let result;
    switch (data.status) {
      case 'valid':
      case 'safe':          // Reoon uses "safe" for deliverable emails
        result = 'valid';
        break;
      case 'invalid':
      case 'disposable':
      case 'role_based_catch_all':
        result = 'invalid';
        break;
      case 'catch_all':
        result = 'catch-all';
        break;
      default:
        result = 'unknown';
    }

    _cache.set(emailLower, { result, ts: Date.now() });
    return result;

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[reoon] timeout for ${emailLower}`);
    } else {
      console.warn(`[reoon] error for ${emailLower}: ${err.message}`);
    }
    return 'unknown';
  }
}

/**
 * Verify multiple emails in parallel (max 5 concurrent to respect rate limits).
 * Returns Map<email, result>
 */
async function verifyEmailsBatch(emails) {
  const results = new Map();
  const CONCURRENCY = 5;

  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const batch = emails.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async email => ({ email, result: await verifyEmailReoon(email) }))
    );
    batchResults.forEach(({ email, result }) => results.set(email.toLowerCase(), result));
  }

  return results;
}

module.exports = { verifyEmailReoon, verifyEmailsBatch };
