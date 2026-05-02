/**
 * smtpService.js
 * Real SMTP verification via native TCP (net module).
 * Performs: EHLO → MAIL FROM → RCPT TO → QUIT
 * Never issues DATA — no emails are sent.
 *
 * Exports:
 *   verifyEmailSMTP(email, mxHost)  → { status, code, message }
 *   detectCatchAll(domain, mxHost)  → boolean
 */

'use strict';

const net = require('net');

// ── Config ────────────────────────────────────────────────────
const SMTP_TIMEOUT_MS  = parseInt(process.env.SMTP_TIMEOUT)    || 8000;
const SMTP_FROM        = process.env.SMTP_FROM_EMAIL           || 'probe@verifycheck.internal';
const SMTP_EHLO_DOMAIN = process.env.SMTP_EHLO_DOMAIN          || 'verifycheck.internal';
const SMTP_PORT        = 25;

// ── Concurrency semaphore (max 2 simultaneous connections) ────
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SMTP) || 2;

class Semaphore {
  constructor(max) {
    this._max   = max;
    this._count = 0;
    this._queue = [];
  }
  acquire() {
    return new Promise(resolve => {
      if (this._count < this._max) { this._count++; resolve(); }
      else this._queue.push(resolve);
    });
  }
  release() {
    this._count--;
    if (this._queue.length) { this._count++; this._queue.shift()(); }
  }
}

const sem = new Semaphore(MAX_CONCURRENT);

// ── Catch-all cache (domain → { isCatchAll, ts }) ────────────
const catchAllCache   = new Map();
const CATCH_ALL_TTL   = 30 * 60 * 1000; // 30 min

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Verify a single email address via SMTP handshake.
 *
 * @param {string} email    - e.g. john.doe@acme.com
 * @param {string} mxHost   - resolved MX hostname
 * @returns {Promise<{ status: 'valid'|'invalid'|'unknown', code: number|null, message: string }>}
 */
async function verifyEmailSMTP(email, mxHost) {
  await sem.acquire();
  try {
    return await _probe(email, mxHost);
  } finally {
    sem.release();
  }
}

/**
 * Detect whether a domain accepts all addresses (catch-all).
 * Result is cached per domain for 30 minutes.
 *
 * @param {string} domain
 * @param {string} mxHost
 * @returns {Promise<boolean>}
 */
async function detectCatchAll(domain, mxHost) {
  const cached = catchAllCache.get(domain);
  if (cached && Date.now() - cached.ts < CATCH_ALL_TTL) {
    return cached.isCatchAll;
  }

  // Probe a random address that cannot possibly exist
  const random = `zzz${Math.random().toString(36).slice(2, 14)}@${domain}`;
  let isCatchAll = false;

  await sem.acquire();
  try {
    const result = await _probe(random, mxHost);
    isCatchAll = result.status === 'valid';
  } catch (_) {
    isCatchAll = false;
  } finally {
    sem.release();
  }

  catchAllCache.set(domain, { isCatchAll, ts: Date.now() });
  return isCatchAll;
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL: raw SMTP probe
// ═══════════════════════════════════════════════════════════════

/**
 * Open a TCP connection and run the SMTP handshake.
 * Returns before sending DATA — purely a recipient probe.
 *
 * Steps:
 *   ← 220 banner
 *   → EHLO <domain>
 *   ← 250 ...
 *   → MAIL FROM:<probe>
 *   ← 250 OK
 *   → RCPT TO:<email>
 *   ← 250 (valid) | 550 (invalid) | other (unknown)
 *   → QUIT
 *   ← 221
 *
 * @param {string} email
 * @param {string} mxHost
 * @returns {Promise<{ status, code, message }>}
 */
function _probe(email, mxHost) {
  return Promise.race([
    _runSession(email, mxHost),
    _timedOut(),
  ]);
}

function _timedOut() {
  return new Promise(resolve =>
    setTimeout(() => resolve({ status: 'unknown', code: null, message: 'SMTP connection timed out' }),
      SMTP_TIMEOUT_MS)
  );
}

function _runSession(email, mxHost) {
  return new Promise(resolve => {

    let rxBuf    = '';
    let step     = 'banner'; // banner → ehlo → mailfrom → rcptto → quit
    let resolved = false;

    const finish = result => {
      if (!resolved) {
        resolved = true;
        try { sock.destroy(); } catch (_) {}
        resolve(result);
      }
    };

    const sock = net.createConnection({ host: mxHost, port: SMTP_PORT });
    sock.setEncoding('utf8');
    sock.setTimeout(SMTP_TIMEOUT_MS);

    sock.on('error', err => {
      const msg = err.code === 'ECONNREFUSED'
        ? 'Connection refused — port 25 blocked'
        : `Network error: ${err.message}`;
      finish({ status: 'unknown', code: null, message: msg });
    });

    sock.on('timeout', () =>
      finish({ status: 'unknown', code: null, message: 'Socket timeout' })
    );

    sock.on('close', () =>
      finish({ status: 'unknown', code: null, message: 'Connection closed unexpectedly' })
    );

    // ── Accumulate data and process complete SMTP response lines ──
    sock.on('data', chunk => {
      rxBuf += chunk;

      // Split on CRLF, keep trailing partial line in buffer
      const lines = rxBuf.split('\r\n');
      rxBuf = lines.pop();

      for (const line of lines) {
        if (!line) continue;
        _handleLine(line, step, sock, email, finish, newStep => { step = newStep; });
      }
    });

    // Alias for legibility
    function _write(cmd) {
      try { if (!sock.destroyed) sock.write(cmd + '\r\n'); }
      catch (_) { finish({ status: 'unknown', code: null, message: 'Write error' }); }
    }

    function _handleLine(line, currentStep, socket, targetEmail, done, setStep) {
      if (line.length < 3) return;

      const code       = parseInt(line.slice(0, 3), 10);
      if (isNaN(code)) return;

      // SMTP multi-line: "250-text" = continuation, "250 text" = terminal
      const isTerminal = line[3] === ' ' || line.length === 3;
      if (!isTerminal) return; // wait for the last line of a multi-line response

      const text = line.slice(4).trim();

      switch (currentStep) {

        case 'banner':
          if (code === 220) {
            _write(`EHLO ${SMTP_EHLO_DOMAIN}`);
            setStep('ehlo');
          } else {
            done({ status: 'unknown', code, message: `Unexpected banner: ${text}` });
          }
          break;

        case 'ehlo':
          if (code === 250 || code === 220) {
            _write(`MAIL FROM:<${SMTP_FROM}>`);
            setStep('mailfrom');
          } else {
            done({ status: 'unknown', code, message: `EHLO rejected (${code}): ${text}` });
          }
          break;

        case 'mailfrom':
          if (code === 250) {
            _write(`RCPT TO:<${targetEmail}>`);
            setStep('rcptto');
          } else {
            done({ status: 'unknown', code, message: `MAIL FROM rejected (${code}): ${text}` });
          }
          break;

        case 'rcptto': {
          // ── Core decision ──────────────────────────────────
          let status;
          if (code >= 200 && code < 300) {
            status = 'valid';
          } else if (code >= 500 && code < 600) {
            status = 'invalid';       // 550 no such user, 553 etc.
          } else {
            status = 'unknown';       // 4xx greylist/temp-fail, anything else
          }

          _write('QUIT');
          setStep('quit');
          done({ status, code, message: text });
          break;
        }

        case 'quit':
          done({ status: 'unknown', code, message: 'Reached QUIT step unexpectedly' });
          break;
      }
    }
  });
}

module.exports = { verifyEmailSMTP, detectCatchAll };
