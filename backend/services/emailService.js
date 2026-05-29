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
const { verifyEmailReoon }  = require('./reoonService');
const { detectDomainPattern,
        learnPattern,
        patternMatchDelta } = require('./domainPatternService');
const { findEmailsFromWebsite }   = require('./emailScraperService');
const { findEmailsBySearch }      = require('./searchScraperService');
const { findEmailOnGitHub }       = require('./githubService');
const { decideBestEmail }         = require('./decisionEngine');
const {
  verifyEmail:           bounceVerify,
  getBounceStatusByEmail,
  recordCatchAll:        bounceCatchAllRecord,
} = require('./bounceVerifierService');

// All candidates are probed via SMTP in parallel — no threshold cutoff.

// ═══════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════

/**
 * @param {boolean} quickMode  Skip SMTP/scraper/GitHub — fast preview only.
 */
async function enrichOneLead(lead, userId = null, tag = null, quickMode = false, discoveryMode = false) {
  console.log('ENRICH-V4 ejecutándose');
  const { firstName, lastName, company = '', linkedinUrl = '' } = lead;

  // ── 1. Domain ────────────────────────────────────────────
  const resolved = resolveDomain(company || linkedinUrl || '');
  const domain   = resolved.domain;
  const warning  = resolved.warning ?? null;

  console.log(`[enrich] ${firstName} ${lastName} | company="${company}" → domain="${domain ?? 'NULL'}"`);

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

  // ── Quick mode OR SMTP disabled: return pattern-only results ──
  // SKIP_SMTP=true is used when port 25 is blocked (e.g. waiting for
  // Hetzner port 25 approval). Avoids SMTP semaphore queue timeouts
  // when processing large batches (2000+ leads in parallel).
  const skipSmtp = quickMode || process.env.SKIP_SMTP === 'true';
  if (skipSmtp) {
    const scored = withBase.map(c =>
      _finalScore(c, firstName, lastName, domain, mxFound,
                  'not-checked', false, null, domainPattern, { emails:[], count:0 }, null, null)
    );
    const decision = decideBestEmail({ candidates: scored, scrapedEmails: [], catchAll: false });
    if (!quickMode && !discoveryMode) {
      // Multi-probe: send top 3 candidates to SES simultaneously.
      // If 2+ survive without bounce → sweep detects catch-all.
      // If only 1 survives → that's the real email.
      // Cascade tail covers candidates 4-21 if all 3 bounce.
      const MAX_PROBES = parseInt(process.env.MAX_SES_PROBES) || 3;
      const nonDisq = scored
        .filter(c => !c.disqualified)
        .sort((a,b) => b.consensusScore - a.consensusScore);
      const probeList  = nonDisq.slice(0, MAX_PROBES);
      const cascadeTail = nonDisq.slice(MAX_PROBES).map(c => ({
        email: c.email, score: c.consensusScore, pattern: c.pattern,
      }));

      if (probeList.length > 0) {
        const leadId  = `${firstName}_${lastName}_${domain}`;
        const leadData = {
          firstName: firstName || '', lastName: lastName || '', isCatchAll: false,
          company: lead.company || '', linkedinUrl: lead.linkedinUrl || '',
          ...(lead._extra      ? { _extra:      lead._extra      } : {}),
          ...(lead._rawColumns ? { _rawColumns: lead._rawColumns } : {}),
        };
        console.log(`[skipSmtp-MULTI] enviando ${probeList.length} probes para ${domain}`);
        probeList.forEach((cand, i) => {
          if (cand.bounceState === 'pending' || cand.bounceState === 'verified') return;
          const remaining = (i === probeList.length - 1) ? cascadeTail : [];
          bounceVerify(cand.email, leadId, userId, remaining, tag, leadData)
            .catch(err => console.warn(`[skipSmtp-SES] ${cand.email}: ${err.message}`));
        });
      }
    }
    return _buildResult(lead, domain, mxFound, mxHost, false, decision, warning, domainPattern, 0);
  }

  // ── No MX → score patterns only (no scraper to avoid timeout) ──
  // Domains without MX rarely yield emails via scraping.
  // Skipping scraper/search/github prevents the 25s timeout that was
  // causing domain="—" and candidates=0 in results.
  if (!mxFound || !mxHost) {
    const scored = withBase.map(c =>
      _finalScore(c, firstName, lastName, domain, mxFound,
                  'not-checked', false, null, domainPattern, { emails:[], count:0 }, null)
    );
    const decision = decideBestEmail({ candidates: scored, scrapedEmails: [], catchAll: false });

    // Still attempt SES — domain may have a mail relay not in MX records
    let bounceVerifyId = null;
    const targetEmail = decision.bestEmail ||
      scored.filter(c => !c.disqualified).sort((a,b) => b.consensusScore - a.consensusScore)[0]?.email;
    if (targetEmail) {
      const leadId  = `${firstName}_${lastName}_${domain}`;
      const leadData = {
        firstName: firstName || '', lastName: lastName || '', isCatchAll: false,
        company: lead.company || '', linkedinUrl: lead.linkedinUrl || '',
        noMxWarning: true,
        ...(lead._extra      ? { _extra:      lead._extra      } : {}),
        ...(lead._rawColumns ? { _rawColumns: lead._rawColumns } : {}),
      };
      const remaining = scored
        .filter(c => c.email !== targetEmail && !c.disqualified)
        .sort((a,b) => b.consensusScore - a.consensusScore)
        .map(c => ({ email: c.email, score: c.consensusScore, pattern: c.pattern }));
      bounceVerify(targetEmail, leadId, userId, remaining, tag, leadData)
        .then(r => { if (r.status === 'sent') bounceVerifyId = r.verifyId; })
        .catch(err => console.warn(`[bounceVerify/noMX] ${targetEmail}: ${err.message}`));
    }

    return _buildResult(lead, domain, mxFound, mxHost, false,
                        decision, warning, domainPattern, 0, bounceVerifyId);
  }

  // ── 6. Probe TOP 5 candidates via SMTP ───────────────────
  // With Reoon handling verification of unknowns, we only need SMTP
  // for the top 5 highest-scoring candidates. This reduces SMTP load
  // from 21 → 5 probes per lead, preventing semaphore bottleneck
  // (168 probes for 8 leads → was causing 45s timeouts).
  // Reoon checks top 7 after SMTP, covering the remaining candidates.
  const SMTP_PROBE_LIMIT = process.env.REOON_API_KEY ? 5 : withBase.length;
  const smtpIndexes = withBase
    .map((_, i) => i)
    .sort((a, b) => (withBase[b].baseScore || 0) - (withBase[a].baseScore || 0))
    .slice(0, SMTP_PROBE_LIMIT);

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

  // ── 8b. Reoon — verify top 7 candidates (Option B strategy) ─
  // Instead of waiting for SES bounce cascade, Reoon checks the top
  // 7 candidates in parallel BEFORE scoring. This finds the correct
  // email pattern upfront, reducing false positives and cascade waste.
  //
  // Priority:
  //   1. If SMTP already returned 'valid' → skip Reoon for that candidate
  //   2. For 'unknown' candidates in top 7 → call Reoon
  //   3. Reoon 'valid' → override smtpMap → scores high → wins decision
  //   4. Reoon 'invalid' → candidate disqualified → not sent to SES
  //   5. Reoon 'catch-all' → domain flagged → no SES for any candidate
  if (process.env.REOON_API_KEY) {
    const REOON_TOP = 7;
    // Sort by baseScore, take top 7 that SMTP didn't already confirm
    const topByScore = [...smtpIndexes]
      .sort((a, b) => (withBase[b].baseScore || 0) - (withBase[a].baseScore || 0))
      .slice(0, REOON_TOP)
      .filter(i => smtpMap.get(i)?.status !== 'valid'); // skip already-confirmed

    if (topByScore.length > 0) {
      console.log(`[reoon] checking top ${topByScore.length} candidates for ${domain}`);
      const reoonResults = await Promise.all(
        topByScore.map(async i => ({
          i,
          result: await verifyEmailReoon(withBase[i].email).catch(() => 'unknown'),
        }))
      );

      let reoonCatchAll = false;
      reoonResults.forEach(({ i, result }) => {
        console.log(`[reoon] ${withBase[i].email} → ${result}`);
        if (result === 'catch-all') { reoonCatchAll = true; }
        if (result !== 'unknown') {
          smtpMap.set(i, {
            ...smtpMap.get(i),
            status: result === 'catch-all' ? 'unknown' : result,
            _reoon: result,
            _reoonCatchAll: result === 'catch-all',
          });
        }
      });

      // If Reoon says domain is catch-all, mark and skip SES
      if (reoonCatchAll) {
        console.log(`[reoon] catch-all confirmed for ${domain} — skipping SES`);
      }
    }
  }

  // ── 9a. Pre-fetch bounce statuses in parallel ─────────────
  // getBounceStatusByEmail is async — must be awaited before the
  // synchronous .map() below, or every bounceState would be a Promise.
  const bounceStatuses = await Promise.all(
    withBase.map(c => getBounceStatusByEmail(c.email).catch(() => null))
  );

  // ── 9. Final consensus score for every candidate ──────────
  const candidates = withBase.map((c, i) => {
    const smtp        = smtpMap.get(i) ?? { status: 'not-checked', code: null };
    const bounceState = bounceStatuses[i];   // resolved: null | 'pending' | 'verified' | 'bounced'
    return _finalScore(c, firstName, lastName, domain, mxFound,
                       smtp.status, isCatchAll, smtp.code, domainPattern, merged, ghResult, bounceState);
  });

  // ── 10. Decision ───────────────────────────────────────────
  const decision = decideBestEmail({ candidates, scrapedEmails: merged.emails, catchAll: isCatchAll });

  // ── 11. Fire bounce verification — multi-probe strategy ───────────
  // DISCOVERY MODE: skip all SES sends — just return pattern results.
  if (discoveryMode) {
    console.log(`[discovery] ${firstName} ${lastName} @ ${domain} — skipping SES`);
    return _buildResult(lead, domain, mxFound, mxHost, isCatchAll,
                        decision, warning, domainPattern, merged?.count ?? 0, null);
  }

  //
  // Problem with single-probe: if the domain silently accepts everything
  // (not detected as catch-all via SMTP), the first candidate never bounces
  // and gets wrongly marked "verified".
  //
  // Solution: send SES to the top MAX_SES_PROBES candidates simultaneously.
  //   • If only ONE survives without a bounce → reliable: that's the real email.
  //   • If MULTIPLE survive → domain accepts everything → auto-flagged catch-all
  //     by the DB sweep (_sweepExpiredPending detects 2+ verified per leadId).
  //
  // Cascade still applies for candidates beyond MAX_SES_PROBES (if all probes
  // bounce, the last probe's remainingCandidates list continues the search).
  //
  // Runs fire-and-forget — does NOT delay the API response.
  let bounceVerifyId = null;
  {
    // All non-disqualified candidates sorted by score (best first)
    const nonDisq = candidates
      .filter(c => !c.disqualified)
      .sort((a, b) => b.consensusScore - a.consensusScore);

    const targetEmail = decision.bestEmail || nonDisq[0]?.email || null;
    console.log(`[bounceVerifier] bestEmail=${decision.bestEmail ?? 'null'} confidence=${decision.confidence} domain=${domain} catchAll=${isCatchAll}`);

    // Check if Reoon already confirmed catch-all
    const reoonConfirmedCatchAll = candidates.some(c => {
      const idx = withBase.findIndex(w => w.email === c.email);
      return smtpMap.get(idx)?._reoonCatchAll === true;
    });

    // Check if Reoon confirmed a specific valid email → use only that for SES
    const reoonValidCandidate = candidates.find(c => {
      const idx = withBase.findIndex(w => w.email === c.email);
      return smtpMap.get(idx)?._reoon === 'valid';
    });

    if (reoonValidCandidate) {
      console.log(`[reoon] confirmed valid: ${reoonValidCandidate.email} — sending single SES (no cascade needed)`);
    }

    if (isCatchAll || reoonConfirmedCatchAll) {
      // Catch-all detected via SMTP or Reoon — record for dashboard without sending SES
      console.log(`[bounceVerifier] SKIP SES (catch-all domain) para ${targetEmail ?? domain} — recording for dashboard`);
      if (targetEmail) {
        const leadData = {
          firstName: firstName || '', lastName: lastName || '', isCatchAll: true,
          company: lead.company || '', linkedinUrl: lead.linkedinUrl || '',
          ...(lead._extra      ? { _extra:      lead._extra      } : {}),
          ...(lead._rawColumns ? { _rawColumns: lead._rawColumns } : {}),
        };
        bounceCatchAllRecord(targetEmail, `${firstName}_${lastName}_${domain}`, userId, tag, leadData)
          .catch(err => console.warn('[catch-all-record] error:', err.message));
      }
    } else if (targetEmail && decision.confidence !== 'guaranteed') {
      // ── Multi-probe: send SES to top N candidates in parallel ──────────
      const leadId  = `${firstName}_${lastName}_${domain}`;
      const leadData = {
        firstName: firstName || '', lastName: lastName || '', isCatchAll: false,
        company: lead.company || '', linkedinUrl: lead.linkedinUrl || '',
        verifiedByReoon: !!reoonValidCandidate,   // true = Reoon confirmed, false = SES only
        ...(lead._extra       ? { _extra:       lead._extra       } : {}),
        ...(lead._rawColumns  ? { _rawColumns:  lead._rawColumns  } : {}),
      };

      // ── Reoon confirmed a valid email → send SES to just that one ──
      // No cascade needed — Reoon already identified the correct email.
      if (reoonValidCandidate) {
        const remaining = nonDisq
          .filter(c => c.email !== reoonValidCandidate.email && !c.disqualified)
          .map(c => ({ email: c.email, score: c.consensusScore, pattern: c.pattern }));
        bounceVerify(reoonValidCandidate.email, leadId, userId, [], tag, leadData)
          .then(r => { if (r.status === 'sent') bounceVerifyId = r.verifyId; })
          .catch(err => console.warn(`[reoon-SES] ${reoonValidCandidate.email}: ${err.message}`));
        return; // skip the multi-probe block below
      }

      const MAX_PROBES  = parseInt(process.env.MAX_SES_PROBES) || 3;
      const probeList   = nonDisq.slice(0, MAX_PROBES);
      const cascadeTail = nonDisq.slice(MAX_PROBES).map(c => ({
        email: c.email, score: c.consensusScore, pattern: c.pattern,
      }));

      console.log(`[MULTI-PROBE] enviando a ${probeList.length} candidatos para ${domain} (cascade tail: ${cascadeTail.length})`);

      probeList.forEach((cand, i) => {
        // Skip candidates already pending or resolved
        if (cand.bounceState === 'pending' || cand.bounceState === 'verified') {
          console.log(`[MULTI-PROBE] skip ${cand.email} (ya ${cand.bounceState})`);
          return;
        }
        // Only the LAST probe carries the cascade tail — prevents duplicate cascades
        const remaining = (i === probeList.length - 1) ? cascadeTail : [];
        bounceVerify(cand.email, leadId, userId, remaining, tag, leadData)
          .then(r => {
            if (r.status === 'sent') {
              console.log(`[MULTI-PROBE] sent probe ${i + 1}/${probeList.length}: ${cand.email} (id: ${r.verifyId})`);
              if (i === 0) bounceVerifyId = r.verifyId;
            } else {
              console.log(`[MULTI-PROBE] ${r.status} para ${cand.email}`);
            }
          })
          .catch(err => console.warn(`[MULTI-PROBE] error para ${cand.email}: ${err.message}`));
      });
    } else if (!targetEmail) {
      console.log(`[bounceVerifier] sin candidatos válidos para verificar en ${domain}`);
    } else {
      console.log(`[bounceVerifier] SKIP (confidence=guaranteed) para ${targetEmail}`);
    }
  }

  return _buildResult(lead, domain, mxFound, mxHost, isCatchAll,
                      decision, warning, domainPattern, merged.count, bounceVerifyId);
}

const LEAD_TIMEOUT_MS = 45_000; // max 45 s per lead in full mode

async function enrichBatch(leads, userId = null, defaultTag = null, quickMode = false, discoveryMode = false) {
  const uniqueDomains = [...new Set(
    leads.map(l => resolveDomain(l.company || l.linkedinUrl || '').domain).filter(Boolean)
  )];
  // Pre-warm MX cache for all domains in parallel
  await Promise.allSettled(uniqueDomains.map(d => getMxRecords(d)));

  if (quickMode) {
    // Preview: all leads in parallel, no SMTP/scraper/GitHub — very fast
    const results = await Promise.all(leads.map(lead => {
      const leadTag = (typeof lead.tag === 'string' && lead.tag.trim()) ? lead.tag.trim() : defaultTag;
      return enrichOneLead(lead, userId, leadTag, true).catch(err => {
        console.error(`[enrichBatch/quick] ${lead.firstName} ${lead.lastName}: ${err.message}`);
        return _emptyResult(lead, null, false, `Processing error: ${err.message}`);
      });
    }));
    return results;
  }

  // Full mode: parallel with per-lead timeout
  const results = await Promise.all(leads.map(lead => {
    const leadTag = (typeof lead.tag === 'string' && lead.tag.trim())
      ? lead.tag.trim()
      : defaultTag;

    // Resolve domain early so timeout can include it (instead of null)
    const preResolved = resolveDomain(lead.company || lead.linkedinUrl || '');
    const timeout = new Promise(resolve =>
      setTimeout(() => {
        console.warn(`[timeout] ${lead.firstName} ${lead.lastName} @ ${preResolved.domain ?? 'unknown'}`);
        resolve(_emptyResult(lead, preResolved.domain || null, false, 'Timeout'));
      }, LEAD_TIMEOUT_MS)
    );

    return Promise.race([
      enrichOneLead(lead, userId, leadTag, false, discoveryMode).catch(err => {
        console.error(`[enrichBatch] ${lead.firstName} ${lead.lastName}: ${err.message}`);
        return _emptyResult(lead, null, false, `Processing error: ${err.message}`);
      }),
      timeout,
    ]);
  }));

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
                     smtpStatus, catchAll, smtpCode, domainPattern, scrape, ghResult = null, bounceState = null) {

  // ── Scraper signals ───────────────────────────────────────
  const { scraperSignal } = _computeScraperSignal(candidate, scrape, firstName, lastName);
  const scraperExact      = scraperSignal === 'exact-match';
  const scraperPattern    = scraperSignal === 'pattern-match';

  // ── GitHub signal ─────────────────────────────────────────
  // True only when the GitHub result email exactly matches this candidate
  const githubExact = !!(ghResult?.email &&
                         ghResult.email.toLowerCase() === candidate.email.toLowerCase());

  // ── Bounce verification signal ────────────────────────────
  const bounceVerified = bounceState === 'valid';    // real send confirmed deliverable
  const bounceFailed   = bounceState === 'bounced';  // hard bounce → disqualify

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
    catchAll:       !!catchAll,
    scraperExact,
    scraperPattern,
    githubExact,
    bounceVerified,
    bounceFailed,
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
    smtpValid:      flags.smtpValid,
    smtpInvalid:    flags.smtpInvalid || smtpStatus === 'invalid',
    catchAll:       !!catchAll,
    scraperExact,
    scraperPattern,
    githubExact,
    bounceVerified,
    bounceFailed,
    patternMemory:  patternConfirmed,
    patternStrong,
    mxFound:        !!mxFound,
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
    smtpCode:         smtpCode ?? null,
    catchAll,
    patternMatch,
    scraperSignal,
    githubExact,
    githubProfile:    githubExact ? ghResult?.profileUrl : null,
    bounceVerified,
    bounceFailed,
    bounceState:      bounceState ?? null,
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
                      decision, warning, domainPattern, scrapedEmailsFound, bounceVerifyId = null) {
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

    // ── Bounce verification ───────────────────────────────────
    bounceVerifyId:      bounceVerifyId ?? null,
    bounceVerificationPending: !!bounceVerifyId,

    // ── Original file columns (for display in verifications table) ──
    // Passed through so verify-batch and other consumers can store them
    _rawColumns: lead._rawColumns || null,
    _extra:      lead._extra      || null,

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
