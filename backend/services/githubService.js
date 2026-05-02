'use strict';

/**
 * githubService.js  —  GitHub email discovery
 *
 * Uses the GitHub REST API (api.github.com) with an authenticated token
 * (process.env.GITHUB_TOKEN) to find a person's work email.
 *
 * Four strategies evaluated in order (first match wins):
 *
 *   1. Username guessing
 *      Builds common GitHub login patterns from first+last name,
 *      fetches each profile JSON, and checks if the public email
 *      matches the target domain. Fastest when the person uses
 *      their real name as their GitHub handle.
 *
 *   2. Org member lookup
 *      Resolves the company's GitHub organization from the domain
 *      (domain → try common org slugs), lists its public members,
 *      and for each member fetches the full profile.
 *      Works well for open-source-active companies (Stripe, Shopify…).
 *
 *   3. Name search + domain filter
 *      POST /search/users?q={firstName}+{lastName}+{domain}
 *      Fetches profiles of the top N results and checks the email field.
 *
 *   4. Commits search
 *      GET /search/commits?q=author-name:{firstName}+{lastName}&per_page=15
 *      Scans commit author emails for a match on the target domain.
 *      Requires the "cloak-preview" media type.
 *
 * Authentication:
 *   Reads process.env.GITHUB_TOKEN, sends as "Authorization: Bearer <token>".
 *   Without a token the service is skipped entirely (logs a warning once).
 *   With a token: 5 000 req/hour for core API, 30 req/min for search.
 *
 * Cache: 24-hour TTL keyed by firstName|lastName|domain.
 *
 * Exports:
 *   findEmailOnGitHub(firstName, lastName, domain)
 *     → Promise<{
 *         email: string,
 *         login: string,
 *         profileUrl: string,
 *         displayName: string,
 *         source: string   // 'username-guess'|'org-member'|'name-search'|'commit'
 *       } | null>
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS   = 7_000;
const CACHE_TTL_MS       = 24 * 60 * 60 * 1000;
const MAX_PROFILE_CHECKS = 8;     // max profile fetches per search result set
const MAX_ORG_MEMBERS    = 30;    // max org members to scan
const API_BASE           = 'api.github.com';

// ── Cache ─────────────────────────────────────────────────────
const cache        = new Map();
let   tokenWarned  = false;

// ─────────────────────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────────────────────

/**
 * Find a GitHub user whose public email belongs to the target domain
 * and whose display name resembles firstName + lastName.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @returns {Promise<{ email, login, profileUrl, displayName, source } | null>}
 */
async function findEmailOnGitHub(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return null;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (!tokenWarned) {
      console.warn('[github] GITHUB_TOKEN not set — skipping GitHub email discovery');
      tokenWarned = true;
    }
    return null;
  }

  const fn  = firstName.trim().split(/\s+/)[0].toLowerCase();
  const ln  = lastName.trim().split(/\s+/).pop().toLowerCase();
  const key = `gh|${fn}|${ln}|${domain}`;

  // ── Cache ────────────────────────────────────────────────
  if (cache.has(key)) {
    const c = cache.get(key);
    if (Date.now() - c.ts < CACHE_TTL_MS) {
      if (c.result) console.log(`[github] cache hit ${key} → ${c.result.email}`);
      return c.result;
    }
  }

  let result = null;

  // ── Strategy 1: username guessing (fastest) ──────────────
  result = await _guessUsername(fn, ln, domain, token);
  if (result) return _cache(key, result);

  // ── Strategy 2: org member lookup ────────────────────────
  result = await _orgMemberLookup(fn, ln, domain, token);
  if (result) return _cache(key, result);

  // ── Strategy 3: name + domain search ─────────────────────
  result = await _nameSearch(fn, ln, domain, token);
  if (result) return _cache(key, result);

  // ── Strategy 4: commits search ───────────────────────────
  result = await _commitsSearch(fn, ln, domain, token);
  if (result) return _cache(key, result);

  console.log(`[github] ${fn} ${ln} @ ${domain} → no match`);
  return _cache(key, null);
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 1 — username guessing
// ─────────────────────────────────────────────────────────────

async function _guessUsername(fn, ln, domain, token) {
  const patterns = [
    `${fn}${ln}`,          // johnsmith
    `${fn}-${ln}`,         // john-smith
    `${fn}.${ln}`,         // john.smith
    `${fn[0]}${ln}`,       // jsmith
    `${fn}_${ln}`,         // john_smith
    `${ln}${fn}`,          // smithjohn
    `${ln}-${fn}`,         // smith-john
    `${fn[0]}-${ln}`,      // j-smith
  ].filter(u => u.length >= 3);

  for (const username of patterns) {
    try {
      const profile = await _apiGet(`/users/${encodeURIComponent(username)}`, token);
      if (!profile || profile.message) continue;

      const email = (profile.email || '').toLowerCase().trim();
      if (email.endsWith('@' + domain)) {
        console.log(`[github] strategy=username-guess login=${profile.login} → ${email}`);
        return _buildResult(email, profile, 'username-guess');
      }
    } catch (_) { /* 404/timeout — expected */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 2 — org member lookup
// ─────────────────────────────────────────────────────────────

/**
 * Try to find the company's GitHub organization by guessing the org slug
 * from the domain, then list public members and check each profile.
 */
async function _orgMemberLookup(fn, ln, domain, token) {
  // Build candidate org slugs from the domain (e.g. stripe.com → stripe, stripecom)
  const base  = domain.split('.')[0].toLowerCase();
  const slugs = [base, `${base}hq`, `${base}-inc`, `the${base}`];

  for (const slug of slugs) {
    try {
      // Verify the org exists
      const org = await _apiGet(`/orgs/${encodeURIComponent(slug)}`, token);
      if (!org || org.message) continue;

      // List public members (paginated, first page only)
      const members = await _apiGet(
        `/orgs/${encodeURIComponent(slug)}/members?per_page=${MAX_ORG_MEMBERS}`,
        token
      );
      if (!Array.isArray(members)) continue;

      for (const member of members) {
        try {
          const profile = await _apiGet(`/users/${encodeURIComponent(member.login)}`, token);
          if (!profile) continue;

          const email = (profile.email || '').toLowerCase().trim();
          if (!email.endsWith('@' + domain)) continue;

          // Name match: display name must contain fn or ln
          if (_nameMatches(profile.name, fn, ln)) {
            console.log(`[github] strategy=org-member org=${slug} login=${profile.login} → ${email}`);
            return _buildResult(email, profile, 'org-member');
          }
        } catch (_) { /* skip this member */ }
      }
    } catch (_) { /* org not found */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 3 — name + domain keyword search
// ─────────────────────────────────────────────────────────────

async function _nameSearch(fn, ln, domain, token) {
  try {
    const q    = encodeURIComponent(`${fn} ${ln} ${domain} in:name,login,company`);
    const data = await _apiGet(`/search/users?q=${q}&per_page=${MAX_PROFILE_CHECKS}`, token);
    if (!data?.items?.length) return null;

    for (const item of data.items.slice(0, MAX_PROFILE_CHECKS)) {
      try {
        const profile = await _apiGet(`/users/${encodeURIComponent(item.login)}`, token);
        if (!profile) continue;

        const email = (profile.email || '').toLowerCase().trim();
        if (email.endsWith('@' + domain)) {
          console.log(`[github] strategy=name-search login=${profile.login} → ${email}`);
          return _buildResult(email, profile, 'name-search');
        }
      } catch (_) { /* skip */ }
    }
  } catch (err) {
    if (err.message.includes('rate limit')) throw err;  // propagate so caller can handle
    console.warn(`[github] name-search error: ${err.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 4 — commits search (finds emails from git history)
// ─────────────────────────────────────────────────────────────

/**
 * Search public commits authored by this person.
 * The commit author email is sometimes the corporate address.
 */
async function _commitsSearch(fn, ln, domain, token) {
  try {
    const q    = encodeURIComponent(`author-name:${fn} ${ln}`);
    const data = await _apiGet(
      `/search/commits?q=${q}&per_page=20`,
      token,
      { 'Accept': 'application/vnd.github.cloak-preview+json' }
    );
    if (!data?.items?.length) return null;

    for (const item of data.items) {
      const email = (item.commit?.author?.email || '').toLowerCase().trim();
      if (!email.endsWith('@' + domain)) continue;

      const authorName = item.commit?.author?.name || '';
      if (!_nameMatches(authorName, fn, ln)) continue;

      // Try to fetch the GitHub user profile for the committer
      const login      = item.author?.login || null;
      const profileUrl = login
        ? `https://github.com/${login}`
        : `https://github.com/search?q=${encodeURIComponent(fn + ' ' + ln)}&type=users`;

      console.log(`[github] strategy=commit login=${login || '?'} → ${email}`);
      return {
        email,
        login:       login || '',
        profileUrl,
        displayName: authorName,
        source:      'commit',
      };
    }
  } catch (err) {
    if (err.message.includes('rate limit')) throw err;
    console.warn(`[github] commits-search error: ${err.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _nameMatches(displayName, fn, ln) {
  if (!displayName) return false;
  const d = displayName.toLowerCase();
  return d.includes(fn) || d.includes(ln);
}

function _buildResult(email, profile, source) {
  return {
    email,
    login:       profile.login       || '',
    profileUrl:  profile.html_url    || `https://github.com/${profile.login}`,
    displayName: profile.name        || profile.login || '',
    source,
  };
}

function _cache(key, result) {
  cache.set(key, { result, ts: Date.now() });
  return result;
}

// ─────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────

/**
 * Authenticated GET to api.github.com.
 * Returns parsed JSON, null on 404, or throws on error/rate-limit.
 */
function _apiGet(path, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; req.destroy(); reject(new Error('timeout')); }
    }, FETCH_TIMEOUT_MS);

    const options = {
      hostname: API_BASE,
      path,
      method:   'GET',
      headers: {
        'User-Agent':    'Enricher/1.0',
        'Accept':        'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        ...extraHeaders,
      },
    };

    const req = https.request(options, res => {
      // Rate limit hit
      if (res.statusCode === 403 || res.statusCode === 429) {
        clearTimeout(timer);
        settled = true;
        res.destroy();
        const reset = res.headers['x-ratelimit-reset'];
        reject(new Error(`GitHub rate limit (resets ${reset ? new Date(reset * 1000).toISOString() : '?'})`));
        return;
      }

      if (res.statusCode === 404 || res.statusCode === 422) {
        clearTimeout(timer);
        settled = true;
        res.destroy();
        resolve(null);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        settled = true;
        res.destroy();
        reject(new Error(`HTTP ${res.statusCode} for ${path}`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try   { resolve(JSON.parse(body)); }
        catch { reject(new Error('JSON parse error')); }
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

    req.end();
  });
}

function getGitHubStats() {
  return { cached: cache.size };
}

module.exports = { findEmailOnGitHub, getGitHubStats };
