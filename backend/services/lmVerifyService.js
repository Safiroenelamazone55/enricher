// ─────────────────────────────────────────────────────────────────────
// LM Verify Service — auto-enriquecimiento de contactos del Lead Manager
//
// EL DIFERENCIADOR: verificación/enriquecimiento nativo con el pipeline
// propio (DNS MX + catch-all + SMTP + domain-pattern-learning). Sin APIs
// externas de pago.
//
// Cola en memoria con concurrencia 1 (respeta MAX_CONCURRENT_SMTP interno
// del smtpService). Dos modos por contacto:
//   · CON email    → verifica ese email (MX → catch-all → SMTP RCPT).
//   · SIN email    → lo BUSCA con enrichOneLead (patrones + SMTP + scrape)
//                    usando nombre + dominio/website de su empresa.
// Resultado → lm_contacts.email / email_status / email_score / email_verified_at.
// email_status: valid | invalid | catch-all | risky | blocked | unknown
// ─────────────────────────────────────────────────────────────────────

const _queue = [];          // items: { userId, contactId }
const _queued = new Set();  // contactIds en cola (dedupe)
let _working = false;

function queueSize() { return _queue.length + (_working ? 1 : 0); }

function queueVerify(pool, userId, contactIds) {
  let added = 0;
  for (const id of contactIds) {
    const cid = Number(id);
    if (!cid || _queued.has(cid)) continue;
    _queued.add(cid);
    _queue.push({ userId, contactId: cid });
    added++;
  }
  if (added && !_working) _drain(pool).catch(e => console.warn('[lm-verify] drain:', e.message));
  return { queued: added, pending: queueSize() };
}

async function _drain(pool) {
  _working = true;
  try {
    while (_queue.length) {
      const { userId, contactId } = _queue.shift();
      try { await _verifyOne(pool, userId, contactId); }
      catch (e) { console.warn(`[lm-verify] contacto ${contactId}:`, e.message); }
      finally { _queued.delete(contactId); }
    }
  } finally { _working = false; }
}

// Ventana de reuso de intentos SMTP: dentro de estos días NO se re-sondea el mismo email.
const ATTEMPT_TTL_DAYS = 7;

async function _verifyOne(pool, userId, contactId) {
  const { rows: [c] } = await pool.query(`
    SELECT k.id, k.user_id, k.nombre, k.apellido, k.email, k.email_status, k.empresa_nombre, k.linkedin,
           co.dominio, co.website, co.nombre AS company_nombre
      FROM lm_contacts k
      LEFT JOIN lm_companies co ON co.id = k.company_id
     WHERE k.id=$1 AND k.user_id=$2
  `, [contactId, userId]);
  if (!c) return;

  // Email confirmado a mano: no lo pisamos con una sonda automática.
  if (c.email_status === 'manual') { console.log(`[lm-verify] ${c.email} → manual (respetado, no se re-sondea)`); return; }

  if (c.email) {
    const emailNorm = String(c.email).trim().toLowerCase();
    // 1) Memoria de intentos: si ya sondeamos este email hace poco, reutiliza el resultado.
    const { rows: [prev] } = await pool.query(
      `SELECT status, score, tried_at FROM lm_smtp_attempts
        WHERE user_id=$1 AND email=$2 AND tried_at > NOW() - ($3 || ' days')::interval`,
      [userId, emailNorm, ATTEMPT_TTL_DAYS]);
    let r;
    if (prev) {
      r = { status: prev.status, score: prev.score };
      console.log(`[lm-verify] ${c.email} → ${r.status} (memoria de intento, sin re-sondear)`);
    } else {
      r = await _verifyExisting(c.email);
      await pool.query(
        `INSERT INTO lm_smtp_attempts (user_id, email, status, score, tried_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (user_id, email) DO UPDATE SET status=EXCLUDED.status, score=EXCLUDED.score, tried_at=NOW()`,
        [userId, emailNorm, r.status, r.score]);
      // 2) Patrón confirmado por dominio: un 'valid' real alimenta la memoria de patrones
      //    para que futuros contactos del mismo dominio prueben ese formato PRIMERO.
      if (r.status === 'valid') _learnFromValid(c, emailNorm);
      console.log(`[lm-verify] ${c.email} → ${r.status} (${r.score})`);
    }
    await pool.query(
      `UPDATE lm_contacts SET email_status=$1, email_score=$2, email_verified_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [r.status, r.score, contactId]
    );
    return;
  }

  // Sin email → buscarlo con el pipeline de enriquecimiento completo.
  const companyRef = c.dominio || c.website || c.company_nombre || c.empresa_nombre;
  if (!c.nombre || !companyRef) {
    await pool.query(
      `UPDATE lm_contacts SET email_status='unknown', email_verified_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [contactId]
    );
    return;
  }
  const { enrichOneLead } = require('./emailService');
  const result = await enrichOneLead(
    { firstName: c.nombre, lastName: c.apellido || '', company: companyRef, linkedinUrl: c.linkedin || '' },
    userId, 'lm-auto', false, false
  );
  const best = result?.bestEmail || null;
  if (best) {
    const status = result.isCatchAll ? 'catch-all'
                 : (result.confidence === 'high' ? 'valid' : 'risky');
    const score  = result.topCandidates?.[0]?.score ?? (result.confidence === 'high' ? 85 : 60);
    await pool.query(
      `UPDATE lm_contacts SET email=$1, email_status=$2, email_score=$3,
              email_verified_at=NOW(), fuente='enricher', updated_at=NOW() WHERE id=$4`,
      [best, status, Math.round(score), contactId]
    );
    console.log(`[lm-verify] encontrado ${best} para ${c.nombre} ${c.apellido} → ${status}`);
  } else {
    await pool.query(
      `UPDATE lm_contacts SET email_status='unknown', email_verified_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [contactId]
    );
  }
}

// Verifica un email YA existente: MX → catch-all → SMTP RCPT.
async function _verifyExisting(email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) return { status: 'invalid', score: 0 };
  const { getMxRecords } = require('./dnsService');
  let mx = [];
  try { mx = await getMxRecords(domain); } catch { /* sin MX */ }
  if (!mx.length) return { status: 'invalid', score: 5 };

  const { verifyEmailSMTP, detectCatchAll } = require('./smtpService');
  const primaryMx = mx[0].exchange;
  let isCatchAll = false;
  try { isCatchAll = await detectCatchAll(domain, primaryMx, mx); } catch { /* ignore */ }

  const r = await verifyEmailSMTP(email, primaryMx, mx);
  if (r.status === 'valid')   return isCatchAll ? { status: 'catch-all', score: 65 } : { status: 'valid', score: 90 };
  if (r.status === 'invalid') return { status: 'invalid', score: 10 };
  // unknown: conexión bloqueada / greylisting / sin respuesta definitiva
  if (isCatchAll) return { status: 'catch-all', score: 55 };
  return { status: 'unknown', score: 40 };
}

// Deducción del patrón: genera los candidatos estándar para nombre+apellido en ese dominio
// y, si el email verificado como 'valid' coincide con uno, registra su patrón en la memoria
// por dominio (domainPatternService) — los siguientes contactos de ese dominio lo prueban primero.
function _learnFromValid(c, emailNorm) {
  try {
    if (!c.nombre || !c.apellido) return;
    const domain = emailNorm.split('@')[1]; if (!domain) return;
    const { generateEmails } = require('./emailGenerator');
    const hit = generateEmails(c.nombre, c.apellido, domain).find(x => x.email === emailNorm);
    if (!hit) return;
    const { learnPattern } = require('./domainPatternService');
    learnPattern(domain, hit.pattern, 250);
  } catch (e) { console.warn('[lm-verify] learn:', e.message); }
}

module.exports = { queueVerify, queueSize };
