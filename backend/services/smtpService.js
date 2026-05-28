'use strict';

/**
 * smtpService.js  — production-grade SMTP verification
 *
 * Pipeline per probe:
 *   1. Try each MX host in priority order (up to MX_FALLBACK_LIMIT)
 *   2. Per MX: try ports in order — 587 (submission) → 25 (SMTP) → 465 (SMTPS)
 *   3. Port 587 / 25: plain TCP + optional STARTTLS upgrade
 *   4. Port 465: implicit TLS (tls.connect)
 *   5. EHLO → MAIL FROM → RCPT TO → QUIT
 *   6. Response classification:
 *        2xx  → valid
 *        550/551/553/554  → invalid   (permanent user-unknown)
 *        421/450/451/452  → greylisted (treat as unknown, not invalid)
 *        other 4xx/5xx   → unknown
 *
 * Anti-greylisting:
 *   Domains that consistently return 4xx are flagged; repeated probes
 *   return 'unknown' immediately rather than wasting connections.
 *
 * Concurrency:
 *   - Global semaphore: max 6 simultaneous TCP connections
 *   - Per-domain rate limit: max 2 concurrent connections to one MX
 *
 * Exports:
 *   verifyEmailSMTP(email, mxHost, allMxRecords?)
 *     → { status, code, message, port, mxHost, tls }
 *   detectCatchAll(domain, mxHost, allMxRecords?)
 *     → boolean
 */

const net = require('net');
const tls = require('tls');

// ── Config ────────────────────────────────────────────────────
const SMTP_TIMEOUT_MS    = parseInt(process.env.SMTP_TIMEOUT)       || 10_000;
const SMTP_FROM          = process.env.SMTP_FROM_EMAIL              || 'probe@verifycheck.internal';
const SMTP_EHLO_DOMAIN   = process.env.SMTP_EHLO_DOMAIN             || 'verifycheck.internal';
const MAX_CONCURRENT     = parseInt(process.env.MAX_CONCURRENT_SMTP) || 20;
const MX_FALLBACK_LIMIT  = 2;   // try at most N MX hosts per probe
const DOMAIN_MAX_CONNS   = 2;   // max simultaneous connections to one domain

// ── Port strategy: tried in this order per MX host ────────────
// Each entry: { port, useTLS, label }
const PORT_STRATEGY = [
  { port: 587, useTLS: false, label: 'submission'  },  // SMTP submission + STARTTLS
  { port: 25,  useTLS: false, label: 'smtp'        },  // Classic SMTP
  { port: 465, useTLS: true,  label: 'smtps'       },  // Implicit TLS (SMTPS)
];

// ── RCPT response codes ───────────────────────────────────────
// Permanent rejection codes → status: 'invalid'
const INVALID_CODES = new Set([550, 551, 552, 553, 554, 555, 503]);

// Temporary / greylist codes → status: 'unknown' (not invalid!)
const GREYLIST_CODES = new Set([421, 450, 451, 452]);

// ─────────────────────────────────────────────────────────────
// Concurrency control
// ─────────────────────────────────────────────────────────────

class Semaphore {
  constructor(max) { this._max = max; this._n = 0; this._q = []; }
  acquire() {
    return new Promise(r => {
      if (this._n < this._max) { this._n++; r(); }
      else this._q.push(r);
    });
  }
  release() {
    this._n--;
    if (this._q.length) { this._n++; this._q.shift()(); }
  }
}

const globalSem  = new Semaphore(MAX_CONCURRENT);
const domainSems = new Map();   // hostname → Semaphore(DOMAIN_MAX_CONNS)

function _getDomainSem(host) {
  if (!domainSems.has(host)) domainSems.set(host, new Semaphore(DOMAIN_MAX_CONNS));
  return domainSems.get(host);
}

// ─────────────────────────────────────────────────────────────
// Caches
// ─────────────────────────────────────────────────────────────

// Catch-all cache: domain → { isCatchAll, ts }
const catchAllCache  = new Map();
const CATCH_ALL_TTL  = 30 * 60 * 1000;

// Greylist tracker: mxHost → { failures, lastSeen }
// If a server keeps returning 4xx we stop hammering it
const greylistTrack  = new Map();
const GREYLIST_THRESHOLD = 4;   // after N consecutive unknown from same host → skip

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Verify a single email address.
 *
 * @param {string}   email
 * @param {string}   primaryMxHost    — first (highest-priority) MX
 * @param {Array}    [allMxRecords]   — full MX list [{exchange,priority}]
 * @returns {Promise<{
 *   status:  'valid'|'invalid'|'unknown',
 *   code:    number|null,
 *   message: string,
 *   port:    number|null,
 *   mxHost:  string|null,
 *   tls:     boolean,
 * }>}
 */
async function verifyEmailSMTP(email, primaryMxHost, allMxRecords = []) {
  const mxHosts = _buildMxList(primaryMxHost, allMxRecords);

  for (const mxHost of mxHosts) {
    const result = await _probeWithFallbackPorts(email, mxHost);

    // If we got a definitive answer (valid or invalid) stop here
    if (result.status === 'valid' || result.status === 'invalid') {
      _resetGreylist(mxHost);
      return result;
    }

    // Track unknowns for greylist detection
    _incrementGreylist(mxHost);
  }

  // All MX hosts returned unknown
  return { status: 'unknown', code: null, message: 'No definitive response from any MX', port: null, mxHost: null, tls: false };
}

/**
 * Detect catch-all on a domain.
 *
 * @param {string}   domain
 * @param {string}   primaryMxHost
 * @param {Array}    [allMxRecords]
 * @returns {Promise<boolean>}
 */
/**
 * Detect catch-all using 3 probes with different patterns.
 *
 * A single probe can give false results — some servers reject obviously-fake
 * addresses (zzznnn) but accept plausible-looking ones. We probe 3 different
 * styles and require 2+ 'valid' responses before declaring catch-all.
 *
 *   Probe 1: zzz_random  — clearly fake, no real-name pattern
 *   Probe 2: firstname.random — looks like a real person
 *   Probe 3: noreply.random  — looks like a service address
 *
 * Result table:
 *   0/3 valid → not catch-all
 *   1/3 valid → inconclusive (treat as not catch-all, but log warning)
 *   2/3 valid → catch-all
 *   3/3 valid → catch-all (strong)
 */
async function detectCatchAll(domain, primaryMxHost, allMxRecords = []) {
  const cached = catchAllCache.get(domain);
  if (cached && Date.now() - cached.ts < CATCH_ALL_TTL) return cached.isCatchAll;

  const rnd = () => Math.random().toString(36).slice(2, 10);
  const probeAddresses = [
    `zzz_${rnd()}@${domain}`,                   // clearly fake
    `firstname.${rnd()}@${domain}`,             // plausible person
    `noreply.${rnd()}@${domain}`,               // plausible service
  ];

  // Run all 3 probes in parallel
  const results = await Promise.all(
    probeAddresses.map(addr =>
      verifyEmailSMTP(addr, primaryMxHost, allMxRecords)
        .catch(() => ({ status: 'unknown' }))
    )
  );

  const validCount = results.filter(r => r.status === 'valid').length;
  const isCatchAll = validCount >= 2;  // require 2+ to avoid false positives

  console.log(`[catch-all] ${domain}: ${validCount}/3 probes valid → isCatchAll=${isCatchAll}`);
  catchAllCache.set(domain, { isCatchAll, ts: Date.now() });
  return isCatchAll;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — port fallback loop
// ─────────────────────────────────────────────────────────────

/**
 * Try each port in PORT_STRATEGY order for a single MX host.
 * Returns the first definitive result, or the last result if all are unknown.
 */
async function _probeWithFallbackPorts(email, mxHost) {
  // Skip this host entirely if it's been consistently greylisting
  if (_isGreylisted(mxHost)) {
    return { status: 'unknown', code: null, message: `${mxHost} consistently greylisting — skipped`, port: null, mxHost, tls: false };
  }

  let lastResult = { status: 'unknown', code: null, message: 'No ports succeeded', port: null, mxHost, tls: false };

  for (const { port, useTLS, label } of PORT_STRATEGY) {
    await globalSem.acquire();
    const domSem = _getDomainSem(mxHost);
    await domSem.acquire();

    try {
      const result = await Promise.race([
        _runSession(email, mxHost, port, useTLS),
        _timeout(`${mxHost}:${port}`),
      ]);

      lastResult = { ...result, port, mxHost, label };

      // Connection refused on this port → try next port
      if (result.message?.includes('ECONNREFUSED') ||
          result.message?.includes('port blocked')  ||
          result.message?.includes('ETIMEDOUT')) {
        continue;
      }

      // Definitive answer → stop
      if (result.status === 'valid' || result.status === 'invalid') {
        return lastResult;
      }

      // Server responded (even if unknown) on this port — no need to try others
      // Exception: banner-level rejection (e.g. 421 Service unavailable) — try next port
      if (result.code && !GREYLIST_CODES.has(result.code)) {
        return lastResult;
      }

    } catch (_) {
      // ignore per-port errors, try next
    } finally {
      domSem.release();
      globalSem.release();
    }
  }

  return lastResult;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — SMTP session
// ─────────────────────────────────────────────────────────────

/**
 * Open TCP (or TLS) connection to mxHost:port and run full SMTP handshake.
 *
 * For port 587/25 with STARTTLS:
 *   220 → EHLO → check for STARTTLS in 250 capabilities
 *   if STARTTLS available: STARTTLS → TLS upgrade → EHLO again → MAIL FROM → RCPT TO → QUIT
 *   if STARTTLS absent:    plain MAIL FROM → RCPT TO → QUIT
 *
 * For port 465 (implicit TLS):
 *   TLS connect → 220 → EHLO → MAIL FROM → RCPT TO → QUIT
 */
function _runSession(email, mxHost, port, useImplicitTLS) {
  return new Promise(resolve => {
    let rxBuf        = '';
    let step         = 'banner';
    let resolved     = false;
    let isTLS        = useImplicitTLS;
    let capabilities = [];

    const finish = (status, code, message) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ status, code: code ?? null, message: message ?? '', tls: isTLS });
    };

    // ── Open socket ──────────────────────────────────────────
    let sock;
    try {
      if (useImplicitTLS) {
        sock = tls.connect({ host: mxHost, port, rejectUnauthorized: false });
      } else {
        sock = net.createConnection({ host: mxHost, port });
      }
    } catch (err) {
      return resolve({ status: 'unknown', code: null, message: err.message, tls: false });
    }

    sock.setEncoding('utf8');
    sock.setTimeout(SMTP_TIMEOUT_MS);

    sock.on('error', err => {
      const msg = err.code === 'ECONNREFUSED' ? `ECONNREFUSED on port ${port}`
                : err.code === 'ETIMEDOUT'    ? `ETIMEDOUT on port ${port}`
                : err.message;
      finish('unknown', null, msg);
    });

    sock.on('timeout', () => finish('unknown', null, `Socket timeout on ${mxHost}:${port}`));
    sock.on('close',   () => finish('unknown', null, 'Connection closed'));

    // ── Data handler ─────────────────────────────────────────
    const onData = chunk => {
      rxBuf += chunk;
      const lines = rxBuf.split('\r\n');
      rxBuf = lines.pop();

      for (const line of lines) {
        if (!line || line.length < 3) continue;
        const code       = parseInt(line.slice(0, 3), 10);
        if (isNaN(code)) continue;
        const isTerminal = line[3] === ' ' || line.length === 3;

        // Collect capability lines from EHLO response (250-)
        if (step === 'ehlo' && !isTerminal && code === 250) {
          capabilities.push(line.slice(4).trim().toLowerCase());
        }

        if (!isTerminal) continue; // wait for terminal line of multi-line response
        if (step === 'ehlo' && code === 250) {
          capabilities.push(line.slice(4).trim().toLowerCase());
        }

        _handleLine(code, line.slice(4).trim());
      }
    };

    sock.on('data', onData);

    // ── Write helper ─────────────────────────────────────────
    const write = cmd => {
      try { if (!sock.destroyed) sock.write(cmd + '\r\n'); }
      catch (_) { finish('unknown', null, 'Write error'); }
    };

    // ── State machine ─────────────────────────────────────────
    function _handleLine(code, text) {
      switch (step) {

        // ── 220 banner ───────────────────────────────────────
        case 'banner':
          if (code === 220) {
            capabilities = [];
            write(`EHLO ${SMTP_EHLO_DOMAIN}`);
            step = 'ehlo';
          } else if (code === 421 || code === 554) {
            finish('unknown', code, `Banner rejection: ${text}`);
          } else {
            finish('unknown', code, `Unexpected banner code ${code}: ${text}`);
          }
          break;

        // ── EHLO response ────────────────────────────────────
        case 'ehlo':
          if (code === 250) {
            // Try STARTTLS upgrade on plain connections (ports 587/25)
            if (!isTLS && capabilities.includes('starttls')) {
              write('STARTTLS');
              step = 'starttls';
            } else {
              write(`MAIL FROM:<${SMTP_FROM}>`);
              step = 'mailfrom';
            }
          } else if (code === 500 || code === 502) {
            // Server doesn't support EHLO — fall back to HELO
            write(`HELO ${SMTP_EHLO_DOMAIN}`);
            step = 'helo';
          } else {
            finish('unknown', code, `EHLO rejected: ${text}`);
          }
          break;

        // ── HELO fallback ────────────────────────────────────
        case 'helo':
          if (code === 250) {
            write(`MAIL FROM:<${SMTP_FROM}>`);
            step = 'mailfrom';
          } else {
            finish('unknown', code, `HELO rejected: ${text}`);
          }
          break;

        // ── STARTTLS negotiation ─────────────────────────────
        case 'starttls':
          if (code === 220) {
            // Upgrade the socket to TLS
            const upgraded = tls.connect({
              socket:                sock,
              host:                  mxHost,
              rejectUnauthorized:    false,
            });

            upgraded.setEncoding('utf8');
            upgraded.setTimeout(SMTP_TIMEOUT_MS);
            upgraded.on('error',   err => finish('unknown', null, `TLS error: ${err.message}`));
            upgraded.on('timeout', ()  => finish('unknown', null, 'TLS socket timeout'));

            // Detach from plain socket, attach to TLS socket
            sock.removeListener('data', onData);
            upgraded.on('data', onData);
            sock = upgraded;
            isTLS = true;

            // Re-send EHLO on the new TLS session
            capabilities = [];
            write(`EHLO ${SMTP_EHLO_DOMAIN}`);
            step = 'ehlo-tls';
          } else {
            // STARTTLS rejected — proceed plain
            write(`MAIL FROM:<${SMTP_FROM}>`);
            step = 'mailfrom';
          }
          break;

        // ── EHLO after STARTTLS ──────────────────────────────
        case 'ehlo-tls':
          if (code === 250) {
            write(`MAIL FROM:<${SMTP_FROM}>`);
            step = 'mailfrom';
          } else {
            finish('unknown', code, `EHLO (post-TLS) rejected: ${text}`);
          }
          break;

        // ── MAIL FROM ────────────────────────────────────────
        case 'mailfrom':
          if (code === 250) {
            write(`RCPT TO:<${email}>`);
            step = 'rcptto';
          } else if (code === 530 || code === 535) {
            // Auth required — server won't answer without login
            finish('unknown', code, `Auth required on ${mxHost}:${port}`);
          } else {
            finish('unknown', code, `MAIL FROM rejected: ${text}`);
          }
          break;

        // ── RCPT TO ——— the money line ───────────────────────
        case 'rcptto': {
          let status;
          if (code >= 200 && code < 300) {
            status = 'valid';
          } else if (INVALID_CODES.has(code)) {
            status = 'invalid';           // hard bounce — user does not exist
          } else if (GREYLIST_CODES.has(code)) {
            status = 'unknown';           // temporary — could be real
          } else if (code >= 500) {
            status = 'invalid';           // other permanent 5xx
          } else {
            status = 'unknown';
          }

          write('QUIT');
          step = 'quit';
          finish(status, code, text);
          break;
        }

        case 'quit':
          // ignore 221 after finish() already called
          break;
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — helpers
// ─────────────────────────────────────────────────────────────

function _timeout(label) {
  return new Promise(resolve =>
    setTimeout(
      () => resolve({ status: 'unknown', code: null, message: `Timeout: ${label}`, tls: false }),
      SMTP_TIMEOUT_MS + 500   // slightly longer than socket timeout so socket fires first
    )
  );
}

/** Build ordered list of MX hosts to try, capped at MX_FALLBACK_LIMIT. */
function _buildMxList(primary, allMxRecords) {
  const sorted = [...(allMxRecords || [])]
    .sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10))
    .map(r => r.exchange)
    .filter(Boolean);

  // Always start with the caller-supplied primary (may already be first in list)
  const list = primary ? [primary, ...sorted.filter(h => h !== primary)] : sorted;

  // Deduplicate while preserving order
  const seen = new Set();
  return list.filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
             .slice(0, MX_FALLBACK_LIMIT);
}

// ── Greylist tracker ─────────────────────────────────────────

function _isGreylisted(host) {
  const t = greylistTrack.get(host);
  return t && t.failures >= GREYLIST_THRESHOLD;
}

function _incrementGreylist(host) {
  const t = greylistTrack.get(host) || { failures: 0 };
  t.failures++;
  t.lastSeen = Date.now();
  greylistTrack.set(host, t);
}

function _resetGreylist(host) {
  greylistTrack.delete(host);
}

module.exports = { verifyEmailSMTP, detectCatchAll };
