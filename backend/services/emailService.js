'use strict';

/**
 * emailService.js — Enrichment orchestrator
 *
 * Pipeline per lead:
 *   1.  Resolve domain
 *   2.  DNS MX lookup (cached)
 *   3.  Generate candidates (3–14 per lead)
 *   4.  Detect domain pattern (cached / learned)
 *   5.  Base score all candidates (legacy DNS scoring for SMTP selection)
 *   6.  Select up to SMTP_MIN_TOP + high-base-score candidates for probing
 *   7.  Parallel: catch-all + SMTP probes + website scrape + search scrape + GitHub
 *   8.  Learn confirmed patterns from SMTP + scraper
 *   9.  Final consensus score for every candidate
 *   10. Decision: gap-based confidence (high / medium / none)
 *   11. Return bestEmail, confidence, topCandidates, verifiedBy
 */

const { resolveDomain }     = require('./domainResolver');
const { generateEmails }    = require('./emailGenerator');
const { getMxRecords }      = require('./dnsService');
const {
  baseScore,
  assignTier,
  computeConsensusScore,
  isGenericEmail,
  isFreemailDomain,
}                           = require('./scoringService');
const { verifyEmailSMTP,
        detectCatchAll }    = require('./smtpService');
const { detectDomainPattern,
        learnPattern,
        patternMatchDelta } = require('./domainPatternService');
const { findEmailsFromWebsite } = require('./emailScraperService');
const { findEmailsBySearch }    = require('./searchScraperService');
const { findEmailOnGitHub }     = require('./githubService');
const { decideBestEmail }   = require('./decisionEngine');

// All candidates are probed via SMTP in parallel — no threshold cutoff.

// ═══════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════

async function enrichOneLead(lead) {
  const { firstName, lastName, company = '', linkedinUrl = '' } = lead;

  // ── 1. Domain ────────────────────────────────────────────
  const resolved = resolveDomain(company || linkedinUrl || '');
  const domain   = resolved.domain;
  const warning  = resolved.warning ?? null;

  if (!domain) return _emptyResult(lead, null, false, warning ?? 'Could not resolve domain.');

  // ── 2. DNS MX ─────────────────────────────────────────────
  let mxRecords = [];
  try { mxRecords = await getMxRecords(domain); }
  catch (err) { console.warn(`[DNS] ${domain}: ${err.message}`); }

  const mxFound = mxRecords.length > 0;
  const mxHost  = mxFound ? mxRecords[0].exchange : null;

  // ── Freemail guard ────────────────────────────────────────
  if (isFreemailDomain(domain)) {
    return _emptyResult(lead, domain, false, 'Freemail domain — not a B2B target.');
  }

  // ── 3. Generate candidates ────────────────────────────────
  const raw = generateEmails(firstName, lastName, domain);
  if (!raw.length) return _emptyResult(lead, domain, mxFound, 'No email patterns could be generated.');

  // ── 4. Detect domain pattern ──────────────────────────────
  const domainPattern = detectDomainPattern(domain);
  console.log(`[domain-pattern] ${domain}: ${domainPattern.likelyPattern} (${domainPattern.source}, ${domainPattern.confidence})`);

  // ── 5. Base score (legacy DNS scoring for SMTP selection) ─
  const withBase = raw.map(c => {
    const dns   = baseScore(c, firstName, lastName, domain, mxFound);
    const delta = patternMatchDelta(c.pattern, domainPattern.likelyPattern, domainPattern.confidence);
    return { ...c, baseScore: Math.max(0, Math.min(dns + delta, 72)) };
  }).sort((a, b) => b.baseScore - a.baseScore);

  // ── No MX → finalize without SMTP ────────────────────────
  if (!mxFound || !mxHost) {
    const [scrape, searchResult, ghResult] = await Promise.all([
      _safeScrape(domain),
      _safeSearch(firstName, lastName, domain),
      _safeGitHub(firstName, lastName, domain),
    ]);
    const merged = _mergeScrape(scrape, searchResult);
    const scored = withBase.map(c =>
      _finalScore(c, firstName, lastName, domain, mxFound,
                  'not-checked', false, null, domainPattern, merged, ghResult)
    );
    const decision = decideBestEmail({ candidates: scored, scrapedEmails: merged.emails, catchAll: false });
    return _buildResult(lead, domain, mxFound, mxHost, false,
                        decision, warning, domainPattern, merged.count);
  }

  // ── 6. Probe ALL candidates via SMTP ─────────────────────
  // Every candidate gets a probe — the verified one (250 OK) wins
  // regardless of its statistical rank. Runs fully in parallel so
  // total wall-clock time = single probe timeout, not N × timeout.
  const smtpIndexes = withBase.map((_, i) => i);

  // ── 7. Parallel: catch-all + ALL SMTP probes + scrapers + GitHub ─
  const [isCatchAll, scrape, searchResult, ghResult, ...smtpResultsArr] = await Promise.all([
    _safeCatchAll(domain, mxHost, mxRecords),
    _safeScrape(domain),
    _safeSearch(firstName, lastName, domain),
    _safeGitHub(firstName, lastName, domain),
    ...smtpIndexes.map(i => _safeSmtpProbe(withBase[i].email, mxHost, mxRecords)),
  ]);
  const merged = _mergeScrape(scrape, searchResult);

  const smtpMap = new Map();
  smtpIndexes.forEach((candidateIdx, resultIdx) => {
    smtpMap.set(candidateIdx, smtpResultsArr[resultIdx]);
  });

  // ── 8. Learn from SMTP + scraper ──────────────────────────
  smtpIndexes.forEach(i => {
    const smtp = smtpMap.get(i);
    if (smtp?.status === 'valid' && smtp.code >= 200 && smtp.code < 300) {
      learnPattern(domain, withBase[i].pattern, smtp.code);
    }
  });
  _learnFromScraper(domain, merged);

  // ── 9. Final consensus score for every candidate ──────────
  const candidates = withBase.map((c, i) => {
    const smtp = smtpMap.get(i) ?? { status: 'not-checked', code: null };
    return _finalScore(c, firstName, lastName, domain, mxFound,
                       smtp.status, isCatchAll, smtp.code, domainPattern, merged, ghResult);
  });

  // ── 10. Decision ───────────────────────────────────────────
  const decision = decideBestEmail({ candidates, scrapedEmails: merged.emails, catchAll: isCatchAll });

  return _buildResult(lead, domain, mxFound, mxHost, isCatchAll,
                      decision, warning, domainPattern, merged.count);
}

async function enrichBatch(leads) {
  const uniqueDomains = [...new Set(
    leads.map(l => resolveDomain(l.company || l.linkedinUrl || '').domain).filter(Boolean)
  )];
  await Promise.allSettled(uniqueDomains.map(d => getMxRecords(d)));

  const results = [];
  for (const lead of leads) {
    try {
      results.push(await enrichOneLead(lead));
    } catch (err) {
      console.error(`[enrichBatch] ${lead.firstName} ${lead.lastName}: ${err.message}`);
      results.push(_emptyResult(lead, null, false, `Processing error: ${err.message}`));
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — final scoring
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the consensus-based final score for one candidate.
 * Replaces the old multi-factor linear scoring for the output.
 */
function _finalScore(candidate, firstName, lastName, domain, mxFound,
                     smtpStatus, catchAll, smtpCode, domainPattern, scrape, ghResult = null) {

  // ── Scraper signals ───────────────────────────────────────
  const { scraperSignal } = _computeScraperSignal(candidate, scrape, firstName, lastName);
  const scraperExact      = scraperSignal === 'exact-match';
  const scraperPattern    = scraperSignal === 'pattern-match';

  // ── GitHub signal ─────────────────────────────────────────
  // True only when the GitHub result email exactly matches this candidate
  const githubExact = !!(ghResult?.email &&
                         ghResult.email.toLowerCase() === candidate.email.toLowerCase());

  // ── Pattern signal ────────────────────────────────────────
  const patternMatch     = candidate.pattern === domainPattern.likelyPattern;
  const patternConfirmed = domainPattern.source === 'memory' ||
                           domainPattern.source === 'smtp-confirmed' ||
                           domainPattern.source === 'seed';
  const patternStrong    = (domainPattern.confidence ?? 0) >= 0.75;
  const patternSignal    = patternMatch && (patternConfirmed || patternStrong);

  // ── Generic / freemail check ──────────────────────────────
  const isGeneric = isGenericEmail(candidate.email);

  // ── Consensus score ───────────────────────────────────────
  const { consensusScore, verifiedBy, flags, disqualified } = computeConsensusScore({
    smtpStatus,
    catchAll:      !!catchAll,
    scraperExact,
    scraperPattern,
    githubExact,
    patternSignal,
    isGeneric,
    mxFound,
  });

  // Normalized display score for UI (0–100)
  const score = disqualified ? 0 : Math.max(0, Math.min(consensusScore, 100));

  // Per-candidate confidence label
  const confidence =
    score >= 80 ? 'very-high' :
    score >= 50 ? 'high'      :
    score >= 20 ? 'medium'    : 'low';

  // Tier
  const signals = {
    smtpValid:     flags.smtpValid,
    smtpInvalid:   flags.smtpInvalid || smtpStatus === 'invalid',
    catchAll:      !!catchAll,
    scraperExact,
    scraperPattern,
    githubExact,
    patternMemory:  patternConfirmed,
    patternStrong,
    mxFound:       !!mxFound,
  };
  const tier = assignTier(signals);

  return {
    email:          candidate.email,
    localPart:      candidate.localPart,
    pattern:        candidate.pattern,
    rank:           candidate.rank,
    score,
    consensusScore,
    confidence,
    tier,
    signals,
    flags,
    verifiedBy,
    disqualified,
    isGeneric,
    smtpStatus,
    smtpCode:       smtpCode ?? null,
    catchAll,
    patternMatch,
    scraperSignal,
    githubExact,
    githubProfile:  githubExact ? ghResult?.profileUrl : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — scraper signal (name-aware exact match)
// ═══════════════════════════════════════════════════════════════

/**
 * Returns scraperSignal: 'exact-match' | 'pattern-match' | 'no-match' | 'none'
 *
 * Exact match requires the scraped email to contain the lead's first or last
 * name so we don't count generic addresses (info@, contact@) as "found".
 */
function _computeScraperSignal(candidate, scrape, firstName, lastName) {
  if (!scrape || scrape.count === 0) return { scraperSignal: 'none' };

  if (scrape.emails.includes(candidate.email)) {
    const fn    = (firstName || '').toLowerCase();
    const ln    = (lastName  || '').toLowerCase();
    const local = candidate.email.split('@')[0].toLowerCase();
    const hasName = (fn.length >= 2 && local.includes(fn)) ||
                    (ln.length >= 2 && local.includes(ln));
    if (hasName) return { scraperSignal: 'exact-match' };
    return { scraperSignal: 'no-match' };  // generic scraped email — skip
  }

  const inferredPatterns = scrape.emails.map(_inferPattern);
  if (inferredPatterns.includes(candidate.pattern)) {
    return { scraperSignal: 'pattern-match' };
  }

  return { scraperSignal: 'no-match' };
}

/**
 * Rough pattern inference from a scraped email's local part structure.
 */
function _inferPattern(email) {
  const local    = email.split('@')[0].toLowerCase();
  const dotParts = local.split('.');

  if (dotParts.length === 2 && dotParts[0].length > 1 && dotParts[1].length > 1)
    return 'firstname.lastname';
  if (dotParts.length === 2 && dotParts[0].length === 1)
    return 'f.lastname';
  if (/^[a-z][a-z]{2,}$/.test(local) && local.length <= 12 && !local.includes('.'))
    return 'f+lastname';
  if (local.includes('_')) return 'firstname_lastname';
  if (local.includes('-')) return 'firstname-lastname';
  if (local.length > 8 && !local.includes('.')) return 'firstnamelastname';
  return 'firstname';
}

/**
 * When scraped emails are found, learn the inferred pattern for this domain.
 */
function _learnFromScraper(domain, scrape) {
  if (!scrape || scrape.count === 0) return;
  const inferred = _inferPattern(scrape.emails[0]);
  learnPattern(domain, inferred, 200);
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — safe wrappers
// ═══════════════════════════════════════════════════════════════

async function _safeScrape(domain) {
  try { return await findEmailsFromWebsite(domain); }
  catch (err) {
    console.warn(`[scraper] ${domain}: ${err.message}`);
    return { emails: [], count: 0, urls: [] };
  }
}

async function _safeCatchAll(domain, mxHost, allMxRecords = []) {
  try {
    const result = await detectCatchAll(domain, mxHost, allMxRecords);
    console.log(`[catch-all] ${domain}: ${result}`);
    return result;
  } catch (err) {
    console.warn(`[catch-all] ${domain}: ${err.message}`);
    return false;
  }
}

async function _safeSearch(firstName, lastName, domain) {
  try { return await findEmailsBySearch(firstName, lastName, domain); }
  catch (err) {
    console.warn(`[search-scraper] ${domain}: ${err.message}`);
    return { emails: [], count: 0, queries: [] };
  }
}

async function _safeGitHub(firstName, lastName, domain) {
  try {
    const r = await findEmailOnGitHub(firstName, lastName, domain);
    if (r) console.log(`[github] ${firstName} ${lastName} @ ${domain} → ${r.email} (${r.source})`);
    return r;
  } catch (err) {
    console.warn(`[github] ${domain}: ${err.message}`);
    return null;
  }
}

/**
 * Merge website scrape results with search-engine scrape results.
 * Deduplicates and sums counts.
 */
function _mergeScrape(scrape, search) {
  const combined = [...new Set([...scrape.emails, ...search.emails])];
  return {
    emails: combined,
    count:  combined.length,
    urls:   scrape.urls,
  };
}

async function _safeSmtpProbe(email, mxHost, allMxRecords = []) {
  try {
    const r = await verifyEmailSMTP(email, mxHost, allMxRecords);
    const tlsTag = r.tls ? ' TLS' : '';
    console.log(`[SMTP] ${email} → ${r.status} (${r.code ?? '—'}) port=${r.port ?? '?'}${tlsTag}`);
    return r;
  } catch (err) {
    console.warn(`[SMTP] ${email}: ${err.message}`);
    return { status: 'unknown', code: null };
  }
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — result builders
// ═══════════════════════════════════════════════════════════════

function _buildResult(lead, domain, mxFound, mxHost, isCatchAll,
                      decision, warning, domainPattern, scrapedEmailsFound) {
  return {
    // ── Lead info ────────────────────────────────────────────
    firstName:           lead.firstName || '',
    lastName:            lead.lastName  || '',
    company:             lead.company   || '',

    // ── Domain metadata ──────────────────────────────────────
    domain,
    mxFound,
    mxHost,
    isCatchAll,
    detectedPattern:     domainPattern?.likelyPattern ?? null,
    patternConfidence:   domainPattern?.confidence    ?? null,
    patternSource:       domainPattern?.source        ?? null,
    scrapedEmailsFound:  scrapedEmailsFound ?? 0,

    // ── Primary API output ────────────────────────────────────
    bestEmail:           decision.bestEmail,
    confidence:          decision.confidence,          // 'high' | 'medium' | 'none'
    verifiedBy:          decision.verifiedBy,          // ['smtp','scraper','pattern']
    topCandidates:       decision.topCandidates,       // 1–3 recommended emails

    // ── Extended metadata ─────────────────────────────────────
    bestScore:           decision.topCandidates[0]?.consensusScore ?? 0,
    bestTier:            decision.bestTier,
    bestSource:          decision.bestSource,
    bestConfidence:      decision.bestConfidence,

    // ── Full ranked candidate list ────────────────────────────
    candidates:          decision.candidates,          // all, sorted by consensusScore

    warning,
  };
}

function _emptyResult(lead, domain, mxFound, warning) {
  return {
    firstName: lead.firstName || '', lastName: lead.lastName || '',
    company:   lead.company   || '',
    domain, mxFound, mxHost: null,
    isCatchAll:       false,
    detectedPattern:  null, patternConfidence: null, patternSource: null,
    scrapedEmailsFound: 0,
    bestEmail:        null,
    confidence:       'none',
    verifiedBy:       [],
    topCandidates:    [],
    bestScore:        0,
    bestTier:         'invalid',
    bestSource:       'inferred',
    bestConfidence:   'low',
    candidates:       [],
    warning,
  };
}

module.exports = { enrichOneLead, enrichBatch };
