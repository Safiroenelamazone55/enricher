/**
 * dnsService.js
 * MX record lookup with in-memory TTL cache.
 * Uses Node built-in dns.promises — zero external deps.
 */

const dns = require('dns').promises;

const TTL_MS  = (parseInt(process.env.MX_CACHE_TTL_MIN) || 60) * 60 * 1000;
const TIMEOUT = parseInt(process.env.DNS_TIMEOUT) || 4000;
const cache   = new Map(); // domain → { records: [], ts: number }

/**
 * Resolve MX records for a domain, sorted by priority.
 * Returns [] if no MX exists. Never throws for DNS-level errors.
 *
 * @param {string} domain
 * @returns {Promise<Array<{exchange:string, priority:number}>>}
 */
async function getMxRecords(domain) {
  if (!domain) return [];

  const hit = cache.get(domain);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.records;

  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns_timeout')), TIMEOUT)),
    ]);
    const sorted = records
      .filter(r => r.exchange)
      .sort((a, b) => a.priority - b.priority);

    cache.set(domain, { records: sorted, ts: Date.now() });
    return sorted;
  } catch (err) {
    const knownEmpty = ['ENODATA','ENOTFOUND','ESERVFAIL','EREFUSED','ENOTIMP','dns_timeout'];
    if (knownEmpty.some(c => err.message.includes(c) || err.code === c)) {
      cache.set(domain, { records: [], ts: Date.now() });
      return [];
    }
    throw err;
  }
}

/**
 * Quick boolean: does the domain have at least one MX record?
 */
async function hasMx(domain) {
  const records = await getMxRecords(domain);
  return records.length > 0;
}

function cacheStats() {
  return { entries: cache.size };
}

module.exports = { getMxRecords, hasMx, cacheStats };
