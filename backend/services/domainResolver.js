/**
 * domainResolver.js
 * Extracts a clean registrable domain from any input:
 *   - Regular URLs:           https://www.acme.com/about  → acme.com
 *   - LinkedIn company URLs:  linkedin.com/company/acme   → slug returned, domain attempted
 *   - LinkedIn profile URLs:  linkedin.com/in/john-doe    → null (no domain info)
 *   - Bare domains:           acme.com                    → acme.com
 *   - Already clean:          acme.io                     → acme.io
 */

/**
 * Remove diacritics and lowercase.
 */
function clean(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Strip www/www2 prefix from hostname.
 */
function stripWww(hostname) {
  return hostname.replace(/^www\d*\./, '');
}

/**
 * Main resolver. Returns { domain, source, warning? }
 *
 * @param {string} input - URL, LinkedIn URL, or bare domain
 * @returns {{ domain: string|null, source: string, warning?: string }}
 */
function resolveDomain(input) {
  if (!input || typeof input !== 'string') {
    return { domain: null, source: 'empty' };
  }

  const raw = input.trim();

  // ── LinkedIn company page ─────────────────────────────────
  // linkedin.com/company/acme-corp  →  we try acme-corp.com as a guess
  const liCompany = raw.match(/linkedin\.com\/company\/([a-z0-9][a-z0-9-]*)/i);
  if (liCompany) {
    const slug = clean(liCompany[1]).replace(/-/g, '');
    return {
      domain: null,            // can't reliably derive domain from slug alone
      linkedinSlug: liCompany[1],
      source: 'linkedin-company',
      warning: 'LinkedIn company URL detected — provide the company website for domain resolution.',
    };
  }

  // ── LinkedIn profile (personal) ───────────────────────────
  if (/linkedin\.com\/in\//i.test(raw)) {
    return {
      domain: null,
      source: 'linkedin-profile',
      warning: 'LinkedIn personal profile URL — no domain can be extracted. Provide company website.',
    };
  }

  // ── Add protocol if missing so URL can parse it ───────────
  let urlStr = raw;
  if (!/^https?:\/\//i.test(urlStr)) urlStr = 'http://' + urlStr;

  try {
    const { hostname } = new URL(urlStr);
    if (!hostname || hostname.length < 3) throw new Error('empty hostname');
    const domain = stripWww(hostname.toLowerCase());
    // Never use social/public platforms as email domains
    const BLOCKED_DOMAINS = ['linkedin.com','facebook.com','twitter.com','instagram.com',
      'youtube.com','apollo.io','salesforce.com','hubspot.com','crunchbase.com',
      'zoominfo.com','google.com','microsoft.com','app.apollo.io'];
    if (BLOCKED_DOMAINS.some(b => domain === b || domain.endsWith('.'+b))) {
      return { domain: null, source: 'blocked-platform', warning: `Platform domain ignored: ${domain}` };
    }
    return { domain, source: 'url' };
  } catch (_) {
    // Fallback: manual strip
    let s = raw.replace(/^https?:\/\//i, '');
    s = s.replace(/^www\d*\./, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    if (s.includes('.') && s.length > 3) {
      return { domain: s.toLowerCase(), source: 'manual' };
    }
    return { domain: null, source: 'unresolvable', warning: `Cannot extract domain from: "${raw}"` };
  }
}

module.exports = { resolveDomain };
