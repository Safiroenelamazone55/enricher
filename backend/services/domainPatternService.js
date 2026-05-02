'use strict';

/**
 * domainPatternService.js
 *
 * Persistent domain-pattern memory with:
 *   - Atomic writes  (tmp → rename, no partial writes)
 *   - Corruption guard (bad JSON → empty store, no crash)
 *   - Auto-cleanup   (TTL 7d, runs at startup)
 *   - Size cap       (max 5 000 domains, evicts oldest)
 *   - O(1) access    (in-memory Map as primary index)
 *   - Batch flush    (disk write every DIRTY_FLUSH_THRESHOLD changes)
 *   - Runtime cache  (skips repeated lookups within 1 h)
 *
 * Source labels in output:
 *   "memory"    — loaded from JSON store (survived restart, from real SMTP probes)
 *   "seed"      — pre-seeded pattern from curated company database
 *   "heuristic" — no stored data, statistical prior used
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ─────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, '..', 'data');
const STORE_PATH  = path.join(DATA_DIR, 'domainPatterns.json');
const TMP_PATH    = path.join(DATA_DIR, 'domainPatterns.tmp.json');
const SEED_PATH   = path.join(DATA_DIR, 'seedPatterns.json');

// ── Limits & TTLs ─────────────────────────────────────────────
const PERSISTENT_TTL_MS     = 7 * 24 * 60 * 60 * 1000;  // 7 days
const RUNTIME_TTL_MS        =      60 * 60 * 1000;       // 1 hour
const MAX_DOMAINS           = 5_000;
const DIRTY_FLUSH_THRESHOLD = 10;   // flush after this many pending writes

// ── In-memory index  (O(1) access) ───────────────────────────
// domain → { pattern, confidence, source, updatedAt }
const store = new Map();

// ── Pre-seeded patterns (static, loaded once at boot) ─────────
// domain → { pattern, confidence }
const seedStore = new Map();

// ── Runtime hot-cache ─────────────────────────────────────────
// domain → { likelyPattern, confidence, source, ts }
const hotCache = new Map();

// ── Dirty counter (batch flush) ───────────────────────────────
let dirtyCount = 0;

// ── Global B2B pattern priors ─────────────────────────────────
const GLOBAL_PRIORS = [
  { pattern: 'firstname.lastname',  confidence: 0.55 },
  { pattern: 'f+lastname',          confidence: 0.48 },
  { pattern: 'firstnamelastname',   confidence: 0.38 },
  { pattern: 'f.lastname',          confidence: 0.32 },
  { pattern: 'firstname',           confidence: 0.28 },
  { pattern: 'firstname.l',         confidence: 0.22 },
  { pattern: 'lastname.firstname',  confidence: 0.18 },
  { pattern: 'firstnamel',          confidence: 0.16 },
  { pattern: 'lastnamef',           confidence: 0.14 },
  { pattern: 'lastname',            confidence: 0.12 },
];

const TLD_HINTS = {
  io:  { 'firstname.lastname': 0.08, 'f+lastname': 0.04 },
  ai:  { 'firstname.lastname': 0.08, 'f+lastname': 0.03 },
  dev: { 'firstname.lastname': 0.06 },
  de:  { 'f+lastname': 0.06,  'firstname.lastname': 0.03 },
  fr:  { 'firstname.lastname': 0.05, 'f+lastname': 0.04 },
  mx:  { 'firstname.lastname': 0.07 },
  ar:  { 'firstname.lastname': 0.07 },
  co:  { 'firstname.lastname': 0.05 },
};

// ── Boot sequence ─────────────────────────────────────────────
_boot();
_loadSeedPatterns();

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Return the most likely pattern for a domain.
 * Priority: memory (smtp-confirmed) → seed (curated) → heuristic prior
 *
 * @returns {{ likelyPattern, confidence, source }}
 */
function detectDomainPattern(domain) {
  const d = _norm(domain);
  if (!d) return _defaultPrior();

  // ── Hot cache hit ────────────────────────────────────────
  const hot = hotCache.get(d);
  if (hot && Date.now() - hot.ts < RUNTIME_TTL_MS) {
    return { likelyPattern: hot.likelyPattern, confidence: hot.confidence, source: hot.source };
  }

  // ── 1. Persistent store (real SMTP-confirmed data) ───────
  const stored = store.get(d);
  if (stored) {
    if (Date.now() - stored.updatedAt > PERSISTENT_TTL_MS) {
      store.delete(d);
      hotCache.delete(d);
      _markDirty();
    } else {
      const result = { likelyPattern: stored.pattern, confidence: stored.confidence, source: 'memory' };
      hotCache.set(d, { ...result, ts: Date.now() });
      return result;
    }
  }

  // ── 2. Pre-seeded curated patterns ───────────────────────
  const seeded = seedStore.get(d);
  if (seeded) {
    const result = { likelyPattern: seeded.pattern, confidence: seeded.confidence, source: 'seed' };
    hotCache.set(d, { ...result, ts: Date.now() });
    return result;
  }

  // ── 3. Heuristic prior ───────────────────────────────────
  const prior = _computePrior(d);
  hotCache.set(d, { ...prior, ts: Date.now() });
  return prior;
}

/**
 * Record a confirmed pattern from a real SMTP 2xx response.
 * Persists only if new confidence exceeds stored confidence.
 */
function learnPattern(domain, pattern, smtpCode) {
  if (!domain || !pattern) return;
  if (typeof smtpCode !== 'number' || smtpCode < 200 || smtpCode >= 300) return;

  const d        = _norm(domain);
  const existing = store.get(d);
  const now      = Date.now();

  let newConf;

  if (existing?.source === 'smtp-confirmed') {
    if (existing.pattern === pattern) {
      newConf = parseFloat(Math.min(0.93, existing.confidence + 0.04).toFixed(2));
    } else {
      newConf = 0.78;
      if (newConf <= existing.confidence) {
        console.log(`[pattern] skipped override ${d}: conf ${existing.confidence} ≥ ${newConf}`);
        return;
      }
    }
  } else {
    newConf = 0.82;
  }

  const entry = { pattern, confidence: newConf, source: 'smtp-confirmed', updatedAt: now };
  _upsert(d, entry);

  // Invalidate hot cache so next call reflects new data
  hotCache.delete(d);

  console.log(`[pattern] learned ${d} → ${pattern} (${newConf})`);
  _markDirty();
}

/**
 * Signed delta: +4…+15 on match, −1…−5 on mismatch.
 * Scaled by confidence so low-confidence guesses have smaller effect.
 */
function patternMatchDelta(candidatePattern, likelyPattern, confidence) {
  if (!likelyPattern || confidence <= 0) return 0;
  const scale = Math.max(0.3, confidence);
  return candidatePattern === likelyPattern
    ? Math.round(15 * scale)
    : -Math.round(5 * scale);
}

function getCacheStats() {
  let confirmed = 0;
  store.forEach(v => { if (v.source === 'smtp-confirmed') confirmed++; });
  return { runtime: hotCache.size, persisted: store.size, seeded: seedStore.size, confirmed, dirty: dirtyCount };
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — store management
// ═══════════════════════════════════════════════════════════════

/** Insert or update a domain entry, enforcing the size cap. */
function _upsert(domain, entry) {
  if (!store.has(domain) && store.size >= MAX_DOMAINS) {
    _evictOldest();
  }
  store.set(domain, entry);
}

/** Remove the oldest (smallest updatedAt) entries until under cap. */
function _evictOldest() {
  const sorted = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toRemove = Math.max(1, Math.floor(MAX_DOMAINS * 0.05)); // evict 5 % at a time
  for (let i = 0; i < toRemove && i < sorted.length; i++) {
    store.delete(sorted[i][0]);
    hotCache.delete(sorted[i][0]);
  }
  console.log(`[pattern] evicted ${toRemove} oldest entries (cap ${MAX_DOMAINS})`);
}

/** Increment dirty counter; flush if threshold reached. */
function _markDirty() {
  dirtyCount++;
  if (dirtyCount >= DIRTY_FLUSH_THRESHOLD) _flush();
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — disk I/O
// ═══════════════════════════════════════════════════════════════

function _boot() {
  _ensureDataDir();
  _loadStore();
  _cleanExpired();
}

function _loadSeedPatterns() {
  try {
    const raw    = fs.readFileSync(SEED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    let   loaded = 0;
    for (const [domain, entry] of Object.entries(parsed)) {
      if (domain.startsWith('_')) continue;  // skip _meta etc.
      if (domain && entry?.pattern && entry?.confidence) {
        seedStore.set(_norm(domain), { pattern: entry.pattern, confidence: entry.confidence });
        loaded++;
      }
    }
    console.log(`[pattern] seed: loaded ${loaded} curated domain patterns`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pattern] could not load seed patterns: ${err.message}`);
    }
  }
}

function _loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8').trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[pattern] store file had unexpected shape — starting empty');
      return;
    }
    let loaded = 0;
    for (const [domain, entry] of Object.entries(parsed)) {
      if (domain && entry?.pattern && entry?.confidence && entry?.updatedAt) {
        store.set(domain, entry);
        loaded++;
      }
    }
    console.log(`[pattern] loaded ${loaded} domains`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pattern] could not read store (${err.message}) — starting empty`);
    }
  }
}

function _cleanExpired() {
  const cutoff = Date.now() - PERSISTENT_TTL_MS;
  let cleaned  = 0;
  store.forEach((entry, domain) => {
    if (entry.updatedAt < cutoff) {
      store.delete(domain);
      hotCache.delete(domain);
      cleaned++;
    }
  });
  if (cleaned > 0) {
    console.log(`[pattern] cleaned ${cleaned} expired`);
    _flush(); // persist the deletions immediately
  }
}

/**
 * Atomic write: serialize → write tmp → rename over original.
 * If anything fails, the original file is left untouched.
 */
function _flush() {
  try {
    _ensureDataDir();

    // Serialize store Map → plain object
    const obj = {};
    store.forEach((v, k) => { obj[k] = v; });

    const json = JSON.stringify(obj, null, 2);
    fs.writeFileSync(TMP_PATH, json, 'utf8');
    fs.renameSync(TMP_PATH, STORE_PATH);

    dirtyCount = 0;
  } catch (err) {
    console.error(`[pattern] flush failed: ${err.message}`);
    // Attempt to clean up orphaned tmp file
    try { fs.unlinkSync(TMP_PATH); } catch (_) {}
  }
}

function _ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Flush on process exit (drain dirty buffer) ────────────────
process.once('exit',    () => { if (dirtyCount > 0) _flush(); });
process.once('SIGINT',  () => { if (dirtyCount > 0) _flush(); process.exit(0); });
process.once('SIGTERM', () => { if (dirtyCount > 0) _flush(); process.exit(0); });

// ── Heuristic helpers ─────────────────────────────────────────

function _computePrior(domain) {
  const tld    = domain.split('.').pop();
  const hints  = TLD_HINTS[tld] ?? {};
  const ranked = GLOBAL_PRIORS
    .map(p => ({ pattern: p.pattern, confidence: Math.min(0.95, p.confidence + (hints[p.pattern] ?? 0)) }))
    .sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0];
  return { likelyPattern: top.pattern, confidence: parseFloat(top.confidence.toFixed(2)), source: 'heuristic' };
}

function _defaultPrior() {
  return { likelyPattern: GLOBAL_PRIORS[0].pattern, confidence: GLOBAL_PRIORS[0].confidence, source: 'heuristic' };
}

function _norm(domain) {
  return (domain || '').toLowerCase().trim();
}

module.exports = { detectDomainPattern, learnPattern, patternMatchDelta, getCacheStats };
