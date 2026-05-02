'use strict';

/**
 * decisionEngine.js
 *
 * Final decision layer using a consensus-based gap model.
 *
 * ── How it works ─────────────────────────────────────────────
 *
 * Each candidate arrives with a pre-computed consensusScore and verifiedBy
 * array (set in emailService._finalScore via scoringService.computeConsensusScore).
 *
 * Decision rules (applied in order):
 *
 *   1. Disqualified candidates (SMTP 5xx/4xx rejection) are removed.
 *   2. Remaining candidates are sorted by consensusScore DESC.
 *   3. Gap check on the top two scores:
 *        gap ≥ 15  →  confidence "high",   return top 1
 *        gap <  15  →  confidence "medium", return top 2–3
 *   4. If no candidate has consensusScore > 0:
 *        confidence "none", bestEmail null
 *
 * ── Consensus score weights (set in scoringService) ──────────
 *   SMTP valid (no catch-all)  +50
 *   SMTP valid (catch-all)     +15
 *   Scraper exact match        +60
 *   Scraper pattern match      +20
 *   Domain pattern confirmed   +30
 *   Generic role-based prefix  −40
 *   SMTP explicit rejection    disqualified
 *
 * Exports:
 *   decideBestEmail({ candidates, scrapedEmails, catchAll })
 *   → { candidates, topCandidates, bestEmail, confidence,
 *       bestTier, bestSource, bestConfidence, verifiedBy }
 */

const CLEAR_WIN_GAP = 15;

// ─────────────────────────────────────────────────────────────
/**
 * @param {{
 *   candidates:    Array,    scored by emailService._finalScore
 *   scrapedEmails: string[],
 *   catchAll:      boolean
 * }} input
 */
function decideBestEmail({ candidates = [], scrapedEmails = [], catchAll = false }) {
  if (!candidates.length) return _empty();

  // ── 1. Split into viable / disqualified ───────────────────
  const viable       = [];
  const disqualified = [];

  for (const c of candidates) {
    if (c.disqualified) disqualified.push(c);
    else                viable.push(c);
  }

  // ── 2. Sort viable by consensusScore DESC, ties by rank ───
  viable.sort((a, b) =>
    (b.consensusScore ?? 0) - (a.consensusScore ?? 0) || (a.rank ?? 99) - (b.rank ?? 99)
  );

  // All candidates (viable + disqualified) sorted for the full list
  const allSorted = [...viable, ...disqualified];

  // ── 3. Confidence / top-N decision ───────────────────────
  const bestScore = viable[0]?.consensusScore ?? 0;

  if (!viable.length || bestScore <= 0) {
    return {
      candidates:     allSorted,
      topCandidates:  [],
      bestEmail:      null,
      confidence:     'none',
      bestTier:       'invalid',
      bestSource:     'inferred',
      bestConfidence: 'low',
      verifiedBy:     [],
    };
  }

  const best   = viable[0];
  const second = viable[1];
  const gap    = bestScore - (second?.consensusScore ?? -Infinity);

  let confidence, topCandidates;

  if (gap >= CLEAR_WIN_GAP) {
    // Clear winner — one email, high confidence
    confidence    = 'high';
    topCandidates = [best];
  } else {
    // No clear winner — surface top 3 with honest medium confidence
    confidence    = 'medium';
    topCandidates = viable.slice(0, 3);
  }

  // ── 4. Derive metadata for the best candidate ────────────
  const verifiedBy = best.verifiedBy ?? [];
  const bestTier   = best.tier ?? 'uncertain';
  const bestSource =
    verifiedBy.includes('smtp')    ? 'smtp'     :
    verifiedBy.includes('scraper') ? 'scraped'  : 'inferred';

  const bestConfidence =
    confidence === 'high'   ? 'very-high' :
    confidence === 'medium' ? 'medium'    : 'low';

  return {
    candidates:     allSorted,
    topCandidates,
    bestEmail:      best.email,
    confidence,
    bestTier,
    bestSource,
    bestConfidence,
    verifiedBy,
  };
}

// ─────────────────────────────────────────────────────────────
function _empty() {
  return {
    candidates:     [],
    topCandidates:  [],
    bestEmail:      null,
    confidence:     'none',
    bestTier:       'invalid',
    bestSource:     'inferred',
    bestConfidence: 'low',
    verifiedBy:     [],
  };
}

module.exports = { decideBestEmail };
