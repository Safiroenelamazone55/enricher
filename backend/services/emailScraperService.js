'use strict';

/**
 * emailScraperService.js
 *
 * Fetches public web pages for a domain and extracts real personal email
 * addresses using regex. Zero external APIs — Node built-in https/http only.
 *
 * URL strategy (3 tiers, evaluated in order):
 *   Tier 1 — homepage + contact  (fast, often has footer emails)
 *   Tier 2 — team / people pages (highest signal: named personal emails)
 *   Tier 3 — about / company     (fallback)
 *
 * Early-stop rules:
 *   • Stop as soon as EARLY_STOP_PERSONAL personal emails are found
 *   • Never fetch more than MAX_URLS_PER_DOMAIN pages
 *   • Each page limited to MAX_BODY_BYTES to avoid slow large pages
 *
 * Scraped emails are used as strong signals:
 *   - Exact name match  → +60 consensus points (verified)
 *   - Pattern match     → +20 consensus points + feeds learnPattern()
 *
 * Exports:
 *   findEmailsFromWebsite(domain) → { emails, count, urls }
 *   getScraperStats()
 */

const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 3_000;                 // 3 s per page (was 6 s)
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_BODY_BYTES      = 200 * 1024;            // 200 KB per page (was 400 KB)
const MAX_EMAILS          = 50;                    // cap returned emails
const EARLY_STOP_PERSONAL = 3;                     // stop after this many personal emails (was 5)
const MAX_URLS_PER_DOMAIN = 4;                     // never fetch more than this (was 12)

// ── Cache: domain → { emails, count, urls, ts } ──────────────
const cache = new Map();

// ── Email regex ───────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ── URL templates — ordered by signal quality ─────────────────
//
// Tier 1: Homepage + contact (fast, covers most small companies)
// Tier 2: Team / people pages (highest yield for personal emails)
// Tier 3: About + company fallbacks
//
// {domain} is replaced at runtime. www variants are included for
// the highest-value pages only to avoid redundant fetches.
const URL_TIERS = [
  // ── Tier 1: Quick wins ─────────────────────────────────────
  'https://{domain}',
  'https://www.{domain}',
  'https://{domain}/contact',
  'https://{domain}/contact-us',
  'https://www.{domain}/contact',

  // ── Tier 2: Team / people pages (best for named emails) ────
  'https://{domain}/team',
  'https://www.{domain}/team',
  'https://{domain}/our-team',
  'https://{domain}/about/team',
  'https://{domain}/people',
  'https://{domain}/leadership',
  'https://{domain}/management',
  'https://{domain}/executives',
  'https://{domain}/founders',
  'https://{domain}/board',
  'https://{domain}/staff',
  'https://{domain}/who-we-are',

  // ── Tier 3: About / company fallbacks ──────────────────────
  'https://{domain}/about',
  'https://www.{domain}/about',
  'https://{domain}/about-us',
  'https://{domain}/company',
  'https://{domain}/company/about',
  'https://{domain}/company/team',
];

// ── Noise patterns — appear in HTML/CSS/JS, not real addresses
const NOISE_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf|eot|otf|ico)$/i,
  /sentry\.io$/i,
  /cloudflare\.com$/i,
  /schema\.org$/i,
  /w3\.org$/i,
  /example\.com$/i,
  /yourdomain\./i,
  /domain\.com$/i,
];

// ── Generic role-based prefixes — not a real named person ────
const GENERIC_PREFIXES = new Set([
  'info','contact','support','hello','admin','sales','help','team',
  'office','mail','email','noreply','no-reply','postmaster','webmaster',
  'billing','invoice','legal','hr','jobs','careers','press','media',
  'marketing','newsletter','notifications','alerts','security','abuse',
  'privacy','feedback','request','service','services','general','enquiries',
  'enquiry','questions','reception','accounts','partnerships','partners',
  'booking','reservations','orders','returns','complaints','concierge',
  'recruitment','talent','hiring','internships','customerservice','care',
]);

// ═══════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════

/**
 * Find real personal email addresses on a domain's public web pages.
 *
 * @param {string} domain   e.g. "acme.com"
 * @returns {Promise<{ emails: string[], count: number, urls: string[] }>}
 */
async function findEmailsFromWebsite(domain) {
  if (!domain) return _empty();

  // ── Cache check ──────────────────────────────────────────
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[scraper] cache hit ${domain} (${cached.count} emails)`);
    return { emails: cached.emails, count: cached.count, urls: cached.urls };
  }

  const foundEmails = new Set();
  const successUrls = [];
  let   fetchCount  = 0;

  for (const tpl of URL_TIERS) {
    // Hard cap on total fetches per domain
    if (fetchCount >= MAX_URLS_PER_DOMAIN) break;

    const url = tpl.replace('{domain}', domain);
    fetchCount++;

    try {
      const body    = await _fetch(url);
      const matches = _extractEmails(body, domain);

      if (matches.length > 0) {
        matches.forEach(e => foundEmails.add(e));
        successUrls.push(url);
        console.log(`[scraper] ${url} → ${matches.length} personal email(s)`);
      }

      // Early stop: enough personal emails found
      if (foundEmails.size >= EARLY_STOP_PERSONAL) break;

    } catch (_err) {
      // Per-URL errors are expected (timeouts, 404s, bot blocks) — skip silently
    }
  }

  const emails = [...foundEmails].slice(0, MAX_EMAILS);
  const result = { emails, count: emails.length, urls: successUrls };

  cache.set(domain, { ...result, ts: Date.now() });

  if (emails.length > 0) {
    const preview = emails.slice(0, 3).join(', ') + (emails.length > 3 ? '…' : '');
    console.log(`[scraper] ${domain} → ${emails.length} personal email(s) across ${successUrls.length} page(s): ${preview}`);
  } else {
    console.log(`[scraper] ${domain} → no personal emails found (${fetchCount} pages checked)`);
  }

  return result;
}

function getScraperStats() {
  return { cached: cache.size };
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch a URL and return the response body as a string.
 * Respects timeout and max body size. Follows one redirect.
 */
function _fetch(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const driver  = parsed.protocol === 'https:' ? https : http;
    let   settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; req.destroy(); reject(new Error('timeout')); }
    }, FETCH_TIMEOUT_MS);

    const req = driver.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, res => {
      // Follow one redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location && redirectCount < 2) {
        clearTimeout(timer);
        settled = true;
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.origin}${res.headers.location}`;
        _fetch(next, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        clearTimeout(timer);
        settled = true;
        res.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let body  = '';
      let bytes = 0;

      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        body  += chunk;
        if (bytes > MAX_BODY_BYTES) {
          res.destroy();  // we have enough content
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(body); }
      });
      res.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });
    });

    req.on('error', err => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

/**
 * Extract and filter personal (non-generic) domain-matching emails from HTML.
 */
function _extractEmails(html, domain) {
  const raw = html.match(EMAIL_RE) ?? [];

  return [...new Set(
    raw
      .map(e => e.toLowerCase().replace(/\.+$/, ''))    // strip trailing dots
      .filter(e => {
        // Must belong to this exact domain
        if (!e.endsWith('@' + domain)) return false;
        // Reject known noise patterns (asset URLs, CDN hostnames, etc.)
        if (NOISE_PATTERNS.some(re => re.test(e))) return false;
        // Basic sanity checks on local part length
        const local = e.split('@')[0];
        if (local.length < 2 || local.length > 64) return false;
        // Reject generic role-based addresses
        const prefix = local.split('.')[0].split('-')[0].split('_')[0];
        if (GENERIC_PREFIXES.has(prefix) || GENERIC_PREFIXES.has(local)) return false;
        // Must look like a real name: at least one segment ≥ 2 chars, no digits only
        if (/^\d+$/.test(local)) return false;
        return true;
      })
  )];
}

function _empty() {
  return { emails: [], count: 0, urls: [] };
}

module.exports = { findEmailsFromWebsite, getScraperStats };
