/**
 * emailGenerator.js
 * Generates ranked email address patterns from a person's name + domain.
 * Returns candidates sorted by probability (rank 1 = most likely).
 *
 * Handles: accents, compound first names, compound last names.
 */

// ── Text normalization ────────────────────────────────────────

function stripAccents(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Tokenize a name string into clean alpha tokens.
 * "Ana-María de la Cruz" → ["ana", "maria", "de", "la", "cruz"]
 */
function tokenize(str) {
  return stripAccents(str)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// Short connective particles that are typically dropped from email addresses
const PARTICLES = new Set(['de','del','la','los','las','el','von','van','di','da','le','les']);

function filterParticles(tokens) {
  return tokens.filter(t => !PARTICLES.has(t));
}

// ── Pattern generation ────────────────────────────────────────

/**
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @returns {Array<{email, localPart, pattern, rank, score}>}
 */
function generateEmails(firstName, lastName, domain) {
  const fnRaw = filterParticles(tokenize(firstName));
  const lnRaw = filterParticles(tokenize(lastName));

  if (fnRaw.length === 0 || lnRaw.length === 0 || !domain) return [];

  const fn1 = fnRaw[0];                   // "ana"
  const fn2 = fnRaw[1] ?? null;           // "maria"
  const ln1 = lnRaw[0];                   // "lopez"
  const ln2 = lnRaw[1] ?? null;           // "garcia"

  const i1 = fn1[0];                      // "a"
  const i2 = fn2 ? fn2[0] : null;         // "m"
  const j1 = ln1[0];                      // "l"
  const j2 = ln2 ? ln2[0] : null;         // "g"

  const list = [];
  let r = 0;

  const add = (lp, pattern) => {
    // Sanitize: only alphanumeric + . _ -
    const safe = String(lp).replace(/[^a-z0-9._-]/g, '');
    if (safe.length < 2 || /^[._-]/.test(safe) || /[._-]$/.test(safe)) return;
    list.push({ localPart: safe, email: `${safe}@${domain}`, pattern, rank: ++r });
  };

  // ── Tier 1 – Most common (enterprise & SMB) ──────────────
  add(`${fn1}.${ln1}`,        'firstname.lastname');       // john.doe
  add(`${i1}${ln1}`,          'f+lastname');               // jdoe
  add(`${fn1}${ln1}`,         'firstnamelastname');        // johndoe
  add(`${fn1}`,               'firstname');                // john
  add(`${i1}.${ln1}`,         'f.lastname');               // j.doe

  // ── Tier 2 – Common variations ───────────────────────────
  add(`${ln1}.${fn1}`,        'lastname.firstname');       // doe.john
  add(`${fn1}.${j1}`,         'firstname.l');              // john.d
  add(`${fn1}${j1}`,          'firstnamel');               // johnd
  add(`${ln1}${i1}`,          'lastnamef');                // doej
  add(`${ln1}`,               'lastname');                 // doe

  // ── Tier 3 – Separator variants ──────────────────────────
  add(`${fn1}_${ln1}`,        'firstname_lastname');
  add(`${fn1}-${ln1}`,        'firstname-lastname');
  add(`${i1}_${ln1}`,         'f_lastname');
  add(`${ln1}_${fn1}`,        'lastname_firstname');

  // ── Tier 4 – Compound first name ─────────────────────────
  if (fn2) {
    add(`${fn1}${fn2}.${ln1}`,       'fn1fn2.lastname');
    add(`${fn1}.${fn2}.${ln1}`,      'fn1.fn2.lastname');
    add(`${i1}${i2}${ln1}`,          'fi1fi2lastname');
    add(`${i1}${i2}.${ln1}`,         'fi1fi2.lastname');
    add(`${fn1}${fn2[0]}.${ln1}`,    'fn1+i2.lastname');
    add(`${fn1}${fn2}`,              'fn1fn2');
  }

  // ── Tier 5 – Compound last name ──────────────────────────
  if (ln2) {
    add(`${fn1}.${ln1}${ln2}`,       'firstname.ln1ln2');
    add(`${fn1}.${ln1}.${ln2}`,      'firstname.ln1.ln2');
    add(`${i1}${ln1}${ln2}`,         'f+ln1ln2');
    add(`${i1}.${ln1}${ln2}`,        'f.ln1ln2');
    add(`${fn1}.${ln2}`,             'firstname.ln2');
    add(`${i1}${ln2}`,               'f+ln2');
    add(`${ln1}${ln2}`,              'ln1ln2');
  }

  // ── Tier 6 – Both compound ───────────────────────────────
  if (fn2 && ln2) {
    add(`${fn1}.${ln1}.${ln2}`,      'fn.ln1.ln2');
    add(`${i1}${i2}.${ln1}${ln2}`,   'fi1fi2.ln1ln2');
  }

  // De-duplicate by email, keep first occurrence (highest rank)
  const seen = new Set();
  return list.filter(c => {
    if (seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
}

module.exports = { generateEmails, tokenize, stripAccents };
