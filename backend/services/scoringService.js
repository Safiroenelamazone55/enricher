'use strict';

/**
 * scoringService.js  —  Scoring engine + consensus signal system
 *
 * Public API:
 *   calculateScore(input)        → { score, confidence, breakdown }  [legacy, used for baseScore]
 *   baseScore(candidate, ...)    → number  (pre-SMTP candidate selection)
 *   scoreCandidates(...)         → Array   (backward-compatible wrapper)
 *   assignTier(signals)          → 'verified'|'likely'|'uncertain'|'invalid'
 *   computeConsensusScore(input) → { consensusScore, verifiedBy, flags, disqualified }
 *   isGenericEmail(email)        → boolean
 *   isFreemailDomain(domain)     → boolean
 *   confidenceLabel(score)       → string
 *
 * Signal weights (consensus):
 *   SMTP valid + non-catch-all    → +50
 *   SMTP valid + catch-all        → +15
 *   Scraper exact                 → +60
 *   Scraper pattern               → +20
 *   GitHub exact                  → +40
 *   Bounce verified (real send)   → +40   ← NEW: SES sent, no bounce in 1h
 *   Domain pattern confirmed      → +30
 *   Generic prefix                → −40
 *   SMTP invalid                  → disqualified
 *   Bounce hard-bounce            → disqualified
 */

// ── A. Pattern weights ────────────────────────────────────────────
const PATTERN_WEIGHT = {
  'firstname.lastname':    40,
  'f+lastname':            36,
  'firstnamelastname':     30,
  'f.lastname':            28,
  'firstname.l':           24,
  'firstname':             20,
  'lastname.firstname':    18,
  'firstnamel':            17,
  'lastnamef':             16,
  'lastname':              14,
  'fn1fn2.lastname':       22,
  'fn1.fn2.lastname':      20,
  'fi1fi2lastname':        16,
  'fi1fi2.lastname':       16,
  'fn1+i2.lastname':       15,
  'fn1fn2':                14,
  'firstname.ln1ln2':      22,
  'firstname.ln1.ln2':     20,
  'f+ln1ln2':              17,
  'f.ln1ln2':              16,
  'firstname.ln2':         14,
  'f+ln2':                 12,
  'ln1ln2':                10,
  'fn.ln1.ln2':            17,
  'fi1fi2.ln1ln2':         14,
  'firstname_lastname':    10,
  'firstname-lastname':    10,
  'f_lastname':             8,
  'lastname_firstname':     8,
};
const PATTERN_WEIGHT_DEFAULT = 6;

// ── B. Freemail domains ───────────────────────────────────────────
const FREEMAIL = new Set([
  'gmail.com','googlemail.com','outlook.com','hotmail.com',
  'live.com','msn.com','yahoo.com','yahoo.es','yahoo.co.uk',
  'yahoo.fr','yahoo.com.ar','icloud.com','me.com','mac.com',
  'aol.com','protonmail.com','proton.me','tutanota.com',
  'zoho.com','yandex.com','yandex.ru','mail.ru','gmx.com',
  'gmx.de','web.de','t-online.de','orange.fr','laposte.net',
]);

// ── C. Generic / role-based prefixes ─────────────────────────────
const GENERIC_PREFIXES = new Set([
  'info','contact','support','hello','admin','sales','help','team',
  'office','mail','email','noreply','no-reply','postmaster','webmaster',
  'billing','invoice','legal','hr','jobs','careers','press','media',
  'marketing','newsletter','notifications','alerts','security','abuse',
  'privacy','feedback','request','service','services','general','enquiries',
  'enquiry','questions','reception','accounts','partnerships','partners',
]);

// ── Helpers ───────────────────────────────────────────────────────

function isFreemailDomain(domain) {
  return FREEMAIL.has((domain || '').toLowerCase());
}

/**
 * Returns true if the email's local part looks like a role-based address,
 * not a personal named address.
 */
function isGenericEmail(email) {
  const local  = (email || '').split('@')[0].toLowerCase();
  const prefix = local.split('.')[0].split('-')[0].split('_')[0];
  return GENERIC_PREFIXES.has(prefix) || GENERIC_PREFIXES.has(local);
}

function confidenceLabel(score) {
  if (score >= 85) return 'very-high';
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

// ═══════════════════════════════════════════════════════════════════
// CONSENSUS SIGNAL SYSTEM
// ═══════════════════════════════════════════════════════════════════

/**
 * Consensus voting — each independent data source casts a weighted vote.
 * Returns a raw consensus score (not clamped to 0–100).
 *
 * Signal weights:
 *   SMTP valid + non-catch-all    → +50   (RCPT TO accepted, no catch-all)
 *   SMTP valid + catch-all        → +15   (server accepts everything — weak)
 *   Scraper exact match           → +60   (email found on company website)
 *   Scraper pattern match         → +20   (website emails use same pattern)
 *   GitHub exact                  → +40   (email on public GitHub profile)
 *   Bounce verified               → +40   (sent real email, no bounce in 1h)
 *   Domain pattern confirmed      → +30   (pattern learned from real probes)
 *   Generic role-based prefix     → −40   (not a personal address)
 *   SMTP explicit rejection       → disqualified
 *   Hard bounce                   → disqualified
 *
 * @param {{
 *   smtpStatus:      'valid'|'invalid'|'unknown'|'not-checked',
 *   catchAll:        boolean,
 *   scraperExact:    boolean,
 *   scraperPattern:  boolean,
 *   githubExact:     boolean,
 *   bounceVerified:  boolean,   real SES send confirmed deliverable
 *   bounceFailed:    boolean,   hard bounce → definitely invalid
 *   patternSignal:   boolean,
 *   isGeneric:       boolean,
 *   mxFound:         boolean,
 * }} input
 * @returns {{
 *   consensusScore: number,
 *   verifiedBy:     string[],
 *   flags:          Object,
 *   disqualified:   boolean,
 * }}
 */
function computeConsensusScore({
  smtpStatus      = 'not-checked',
  catchAll        = false,
  scraperExact    = false,
  scraperPattern  = false,
  githubExact     = false,
  bounceVerified  = false,
  bounceFailed    = false,
  patternSignal   = false,
  isGeneric       = false,
  mxFound         = false,
}) {
  const flags = {
    smtpValid:       false,
    smtpCatchAll:    false,
    smtpInvalid:     false,
    scraperExact:    false,
    scraperPattern:  false,
    githubExact:     false,
    bounceVerified:  false,
    bounceFailed:    false,
    patternMatch:    false,
    isGeneric:       false,
  };

  // ── Generic role address → heavy penalty, still shown ────────
  if (isGeneric) {
    flags.isGeneric = true;
    return { consensusScore: -40, verifiedBy: [], flags, disqualified: false };
  }

  // ── Hard bounce → address does NOT exist ─────────────────────
  if (bounceFailed) {
    flags.bounceFailed = true;
    return { consensusScore: -999, verifiedBy: [], flags, disqualified: true };
  }

  // ── SMTP explicit rejection → remove from results ─────────────
  if (smtpStatus === 'invalid') {
    flags.smtpInvalid = true;
    return { consensusScore: -999, verifiedBy: [], flags, disqualified: true };
  }

  // ── No MX → no useful signal ──────────────────────────────────
  if (!mxFound) {
    return { consensusScore: 0, verifiedBy: [], flags, disqualified: false };
  }

  let score = 0;
  const verifiedBy = [];

  // ── SMTP vote ─────────────────────────────────────────────────
  if (smtpStatus === 'valid' && !catchAll) {
    score += 50;
    flags.smtpValid = true;
    verifiedBy.push('smtp');
  } else if (smtpStatus === 'valid' && catchAll) {
    score += 15;
    flags.smtpCatchAll = true;
  }

  // ── Scraper vote ──────────────────────────────────────────────
  if (scraperExact) {
    score += 60;
    flags.scraperExact = true;
    verifiedBy.push('scraper');
  } else if (scraperPattern) {
    score += 20;
    flags.scraperPattern = true;
  }

  // ── GitHub vote ───────────────────────────────────────────────
  if (githubExact) {
    score += 40;
    flags.githubExact = true;
    verifiedBy.push('github');
  }

  // ── Bounce verification vote ──────────────────────────────────
  if (bounceVerified) {
    score += 40;
    flags.bounceVerified = true;
    verifiedBy.push('bounce');
  }

  // ── Pattern vote ──────────────────────────────────────────────
  if (patternSignal) {
    score += 30;
    flags.patternMatch = true;
    verifiedBy.push('pattern');
  }

  return { consensusScore: score, verifiedBy, flags, disqualified: false };
}

// ═══════════════════════════════════════════════════════════════════
// TIER ASSIGNMENT  (used for internal enrichment decision)
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {{
 *   smtpValid, smtpInvalid, catchAll, scraperExact, scraperPattern,
 *   githubExact, bounceVerified, bounceFailed, patternMemory, patternStrong, mxFound
 * }} signals
 * @returns {'verified'|'likely'|'uncertain'|'invalid'}
 */
function assignTier(signals) {
  const {
    smtpValid       = false,
    smtpInvalid     = false,
    catchAll        = false,
    scraperExact    = false,
    scraperPattern  = false,
    githubExact     = false,
    bounceVerified  = false,
    bounceFailed    = false,
    patternMemory   = false,
    patternStrong   = false,
    mxFound         = false,
  } = signals;

  if (smtpInvalid || bounceFailed)              return 'invalid';
  if (!mxFound && !scraperExact
               && !githubExact
               && !bounceVerified)              return 'invalid';
  if (scraperExact)                             return 'verified';
  if (smtpValid && !catchAll)                   return 'verified';
  if (githubExact)                              return 'verified';
  if (bounceVerified)                           return 'verified';

  const softCount = [smtpValid, scraperPattern, patternMemory, patternStrong]
    .filter(Boolean).length;
  if (softCount >= 2) return 'likely';

  return 'uncertain';
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY MULTI-FACTOR SCORING  (used only for pre-SMTP baseScore)
// ═══════════════════════════════════════════════════════════════════

function calculateScore(input) {
  const {
    email      = '',
    pattern    = '',
    firstName  = '',
    lastName   = '',
    domain     = '',
    mxFound    = false,
    smtpStatus = 'not-checked',
    catchAll   = false,
  } = input;

  const bd = {};

  if (FREEMAIL.has(domain.toLowerCase())) {
    return { score: 0, confidence: 'low', breakdown: { freemail: true } };
  }
  if (smtpStatus === 'invalid') {
    return { score: 0, confidence: 'low', breakdown: { smtpInvalid: true } };
  }
  if (!mxFound) {
    return { score: 5, confidence: 'low', breakdown: { noMx: true } };
  }

  let score = 0;

  const pw = PATTERN_WEIGHT[pattern] ?? PATTERN_WEIGHT_DEFAULT;
  score   += pw;
  bd.pattern = { pattern, weight: pw };

  score   += 12;
  bd.mx    = { mxFound, bonus: 12 };

  const fn = firstName.trim();
  const ln = lastName.trim();
  let nameQ = 0;
  if      (fn.length >= 5 && ln.length >= 5) nameQ =  8;
  else if (fn.length >= 3 && ln.length >= 3) nameQ =  4;
  else if (fn.length < 2  || ln.length < 2)  nameQ = -8;
  score   += nameQ;
  bd.nameQuality = { fn: fn.length, ln: ln.length, delta: nameQ };

  const localPart = email.split('@')[0] ?? '';
  let formatDelta = 0;
  if (localPart.includes('_')) { formatDelta -= 6;  bd.underscore = -6; }
  if (localPart.includes('-')) { formatDelta -= 4;  bd.hyphen     = -4; }
  if (localPart.length > 28)   { formatDelta -= 5;  bd.longLocal  = -5; }
  if (localPart.length < 3)    { formatDelta -= 8;  bd.shortLocal = -8; }
  score   += formatDelta;
  if (formatDelta) bd.format = formatDelta;

  const tld = domain.split('.').pop().toLowerCase();
  const domainBonus = ['com','io','co','net','org','ai','dev'].includes(tld) ? 5 : 0;
  score  += domainBonus;
  bd.domain = { tld, bonus: domainBonus };

  score = Math.max(0, Math.min(score, 72));
  bd.preSmtp = score;

  if (smtpStatus === 'valid') {
    score  += 25;
    bd.smtp = { status: 'valid', delta: +25 };
  } else {
    bd.smtp = { status: smtpStatus, delta: 0 };
  }

  if (catchAll) {
    const before = score;
    score = Math.round(score * 0.5);
    bd.catchAll = { before, after: score, multiplier: 0.5 };
  }

  score = Math.max(0, Math.min(score, 97));
  return { score, confidence: confidenceLabel(score), breakdown: bd };
}

function baseScore(candidate, firstName, lastName, domain, mxFound) {
  const { score } = calculateScore({
    email: candidate.email, pattern: candidate.pattern,
    firstName, lastName, domain, mxFound,
    smtpStatus: 'not-checked', catchAll: false,
  });
  return score;
}

function scoreCandidates(candidates, mxFound, firstName, lastName) {
  const domain = candidates[0]?.email.split('@')[1] ?? '';
  return candidates
    .map(c => {
      const { score, confidence, breakdown } = calculateScore({
        email: c.email, pattern: c.pattern,
        firstName, lastName, domain, mxFound,
        smtpStatus: 'not-checked', catchAll: false,
      });
      return { ...c, score, confidence, breakdown };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  calculateScore,
  baseScore,
  scoreCandidates,
  confidenceLabel,
  assignTier,
  computeConsensusScore,
  isGenericEmail,
  isFreemailDomain,
};
