'use strict';

/**
 * searchScraperService.js  — Level 1C: Person-targeted email discovery
 *
 * Three complementary signals (all free, no API keys):
 *
 *  A) Person-specific company URL patterns
 *     Constructs and fetches personalized pages like:
 *       /team/john-smith   /about/john-doe   /people/john
 *     These bio pages often display the person's direct email.
 *
 *  B) Hacker News Algolia search API (free JSON, no auth)
 *     Searches HN comments/posts for "firstname lastname @domain.com"
 *     Authors sometimes post contact info or are mentioned with emails.
 *
 *  C) GitHub username guessing
 *     Constructs common GitHub username patterns from the name, fetches
 *     the GitHub user profile JSON. GitHub profiles often have a public
 *     email field.
 *
 * Signals A–C run in parallel. Results are merged and filtered to
 * personal (non-generic) addresses on the target domain.
 *
 * Cache: 24-hour TTL keyed by firstName|lastName|domain
 *
 * Exports:
 *   findEmailsBySearch(firstName, lastName, domain)
 *     → { emails: string[], count: number, sources: string[] }
 */

const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES   = 200 * 1024;
const CACHE_TTL_MS     = 24 * 60 * 60 * 1000;

// ── Cache ─────────────────────────────────────────────────────
const cache = new Map();

// ── Email regex ───────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ── Generic role prefixes ────────────────────────────────────
const GENERIC_PREFIXES = new Set([
  'info','contact','support','hello','admin','sales','help','team',
  'office','mail','email','noreply','no-reply','postmaster','webmaster',
  'billing','invoice','legal','hr','jobs','careers','press','media',
  'marketing','newsletter','notifications','alerts','security','abuse',
  'privacy','feedback','request','service','services','general','enquiries',
  'enquiry','questions','reception','accounts','partnerships','partners',
  'booking','reservations','orders','returns','complaints','concierge',
  'recruitment','talent','hiring','customerservice','care',
]);

// ═══════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════

/**
 * Find personal emails for a lead using person-targeted discovery.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @returns {Promise<{ emails: string[], count: number, sources: string[] }>}
 */
async function findEmailsBySearch(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return _empty();

  // Use first+last token only (handles compound names like "Ana María López García")
  const fn  = firstName.trim().split(/\s+/)[0].toLowerCase();
  const ln  = lastName.trim().split(/\s+/).pop().toLowerCase();
  const key = `${fn}|${ln}|${domain}`;

  // ── Cache ────────────────────────────────────────────────
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[search] cache hit ${key} (${cached.count} emails)`);
    return { emails: cached.emails, count: cached.count, sources: cached.sources };
  }

  // ── Run all three sources in parallel ────────────────────
  const [bioEmails, hnEmails, ghEmails] = await Promise.all([
    _bioPageScrape(fn, ln, domain),
    _hackerNewsSearch(fn, ln, domain),
    _githubProfileSearch(fn, ln, domain),
  ]);

  // Merge & deduplicate
  const all    = [...new Set([...bioEmails.emails, ...hnEmails.emails, ...ghEmails.emails])];
  const emails = all.filter(e => _isPersonal(e, domain));

  const sources = [
    ...(bioEmails.emails.length  > 0 ? ['bio-page'] : []),
    ...(hnEmails.emails.length   > 0 ? ['hacker-news'] : []),
    ...(ghEmails.emails.length   > 0 ? ['github'] : []),
  ];

  const result = { emails, count: emails.length, sources };
  cache.set(key, { ...result, ts: Date.now() });

  if (emails.length > 0) {
    console.log(`[search] ${fn} ${ln} @ ${domain} → ${emails.length} email(s) via [${sources.join(',')}]: ${emails.slice(0,2).join(', ')}`);
  } else {
    console.log(`[search] ${fn} ${ln} @ ${domain} → no emails found`);
  }

  return result;
}

function getSearchScraperStats() {
  return { cached: cache.size };
}

// ═══════════════════════════════════════════════════════════════
// SOURCE A — Person-specific bio/profile URLs on company site
// ═══════════════════════════════════════════════════════════════

/**
 * Constructs common "person profile" URL patterns for the company website
 * and fetches them looking for an email address belonging to that person.
 *
 * Example patterns:  /team/john-smith  /about/john  /people/john-smith
 */
async function _bioPageScrape(fn, ln, domain) {
  const slug1 = `${fn}-${ln}`;
  const slug2 = `${fn}.${ln}`;
  const slug3 = fn;

  const urls = [
    `https://${domain}/team/${slug1}`,
    `https://${domain}/team/${slug2}`,
    `https://www.${domain}/team/${slug1}`,
    `https://${domain}/about/${slug1}`,
    `https://${domain}/about/team/${slug1}`,
    `https://${domain}/people/${slug1}`,
    `https://${domain}/people/${slug3}`,
    `https://${domain}/leadership/${slug1}`,
    `https://${domain}/staff/${slug1}`,
    `https://${domain}/founders/${slug3}`,
  ];

  const found = new Set();

  for (const url of urls) {
    try {
      const body   = await _fetch(url);
      const emails = _extractEmails(body, domain);

      // Only accept emails that contain the person's name in the local part
      for (const e of emails) {
        const local = e.split('@')[0];
        if (local.includes(fn) || local.includes(ln)) {
          found.add(e);
        }
      }

      if (found.size > 0) break;  // found what we need
    } catch (_) {
      // 404, timeout, etc. — expected
    }
  }

  return { emails: [...found] };
}

// ═══════════════════════════════════════════════════════════════
// SOURCE B — Hacker News Algolia search API
// ═══════════════════════════════════════════════════════════════

/**
 * Uses the free Algolia-powered HN search API to find HN posts/comments
 * that mention both the person's name and their domain. Extracts any
 * email addresses that appear in the text content.
 */
async function _hackerNewsSearch(fn, ln, domain) {
  // Search for posts/comments mentioning name + domain
  const query = encodeURIComponent(`${fn} ${ln} ${domain}`);
  const url   = `https://hn.algolia.com/api/v1/search?query=${query}&tags=comment,story&hitsPerPage=10`;

  try {
    const body = await _fetch(url);
    const data = JSON.parse(body);
    const hits = data.hits ?? [];

    const emails = new Set();
    for (const hit of hits) {
      // Check story_text, comment_text fields
      const text = [hit.story_text, hit.comment_text, hit.title, hit.url]
        .filter(Boolean).join(' ');

      _extractEmails(text, domain).forEach(e => emails.add(e));
    }

    return { emails: [...emails] };
  } catch (_) {
    return { emails: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// SOURCE C — GitHub profile lookup by username guessing
// ═══════════════════════════════════════════════════════════════

/**
 * Constructs common GitHub username patterns from the person's name,
 * fetches the GitHub user JSON (no auth needed), and returns the
 * public email if it matches the target domain.
 */
async function _githubProfileSearch(fn, ln, domain) {
  const candidates = [
    `${fn}${ln}`,          // johnsmith
    `${fn}-${ln}`,         // john-smith
    `${fn}.${ln}`,         // john.smith
    `${fn[0]}${ln}`,       // jsmith
    `${fn}`,               // john  (single-name handles — less reliable)
    `${fn}_${ln}`,         // john_smith
    `${fn}${ln[0]}`,       // johns
  ];

  for (const username of candidates) {
    try {
      const url  = `https://api.github.com/users/${encodeURIComponent(username)}`;
      const body = await _fetch(url, 0, { 'User-Agent': 'Enricher/1.0', 'Accept': 'application/vnd.github.v3+json' });
      const user = JSON.parse(body);

      if (user.email && user.email.endsWith('@' + domain)) {
        console.log(`[search] GitHub ${username} → ${user.email}`);
        return { emails: [user.email.toLowerCase()] };
      }
    } catch (_) {
      // 404 or rate-limit — try next pattern
    }
  }

  return { emails: [] };
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL helpers
// ═══════════════════════════════════════════════════════════════

function _isPersonal(email, domain) {
  if (!email.endsWith('@' + domain)) return false;
  const local  = email.split('@')[0];
  if (local.length < 2 || local.length > 64) return false;
  if (/^\d+$/.test(local)) return false;
  const prefix = local.split('.')[0].split('-')[0].split('_')[0];
  return !GENERIC_PREFIXES.has(prefix) && !GENERIC_PREFIXES.has(local);
}

function _extractEmails(text, domain) {
  const raw = text.match(EMAIL_RE) ?? [];
  return [...new Set(
    raw
      .map(e => e.toLowerCase().replace(/\.+$/, ''))
      .filter(e => _isPersonal(e, domain))
  )];
}

/**
 * Simple HTTP/HTTPS fetcher with timeout + size cap.
 * Optional extraHeaders for GitHub API, etc.
 */
function _fetch(url, redirectCount = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const driver  = parsed.protocol === 'https:' ? https : http;
    let   settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; req.destroy(); reject(new Error('timeout')); }
    }, FETCH_TIMEOUT_MS);

    const req = driver.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...extraHeaders,
      },
      timeout: FETCH_TIMEOUT_MS,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location && redirectCount < 2) {
        clearTimeout(timer);
        settled = true;
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.origin}${res.headers.location}`;
        _fetch(next, redirectCount + 1, extraHeaders).then(resolve).catch(reject);
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
        if (bytes > MAX_BODY_BYTES) res.destroy();
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

function _empty() {
  return { emails: [], count: 0, sources: [] };
}

module.exports = { findEmailsBySearch, getSearchScraperStats };
