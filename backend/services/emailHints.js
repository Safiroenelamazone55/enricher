'use strict';
// Pistas de email para un contacto SIN email: busca en todo el sistema (CRM, Cantera, exclusiones, intentos SMTP) los correos que ya
// se conocen del dominio de su empresa, deduce el patrón que usa esa empresa (nombre.apellido, inicial+apellido…) y lo aplica al contacto.
const dps = require('./domainPatternService');

const FREE = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.es', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'msn.com', 'aol.com', 'gmx.com', 'terra.com', 'telefonica.net']);
const GENERIC = /^(info|contact|contacto|hello|hola|admin|ventas|sales|office|oficina|support|soporte|mail|email|administracion|recepcion|reservas|booking|marketing|rrhh|hr|jobs|prensa|press|team|general|service|servicio|atencion|clientes|customer)\b/i;
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'van', 'von', 'der', 'den', 'da', 'do', 'dos', 'di', 'le', 'el', 'al', 'bin', 'ben']);

const strip = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = s => strip(s).replace(/[^a-z\s'-]/g, ' ').split(/[\s'-]+/).filter(t => t && !PARTICLES.has(t));

// patrones conocidos: etiqueta para mostrar + cómo se arma el correo
const PATTERNS = {
  'first.last': { label: 'nombre.apellido', fn: (f, l) => `${f}.${l}` },
  'firstlast': { label: 'nombreapellido', fn: (f, l) => `${f}${l}` },
  'first_last': { label: 'nombre_apellido', fn: (f, l) => `${f}_${l}` },
  'first-last': { label: 'nombre-apellido', fn: (f, l) => `${f}-${l}` },
  'flast': { label: 'inicial+apellido', fn: (f, l) => `${f[0]}${l}` },
  'f.last': { label: 'inicial.apellido', fn: (f, l) => `${f[0]}.${l}` },
  'f_last': { label: 'inicial_apellido', fn: (f, l) => `${f[0]}_${l}` },
  'first': { label: 'nombre', fn: (f) => f },
  'last': { label: 'apellido', fn: (f, l) => l },
  'first.l': { label: 'nombre.inicial', fn: (f, l) => `${f}.${l[0]}` },
  'firstl': { label: 'nombre+inicial', fn: (f, l) => `${f}${l[0]}` },
  'last.first': { label: 'apellido.nombre', fn: (f, l) => `${l}.${f}` },
  'lastfirst': { label: 'apellidonombre', fn: (f, l) => `${l}${f}` },
  'last.f': { label: 'apellido.inicial', fn: (f, l) => `${l}.${f[0]}` },
  'lastf': { label: 'apellido+inicial', fn: (f, l) => `${l}${f[0]}` },
};
// nombres del servicio de memoria de dominios → claves de aquí
const DPS_MAP = { 'firstname.lastname': 'first.last', 'f+lastname': 'flast', 'firstnamelastname': 'firstlast', 'f.lastname': 'f.last', 'firstname': 'first', 'firstname.l': 'first.l', 'lastname.firstname': 'last.first', 'firstnamel': 'firstl' };

// apellidos posibles de una persona (compuestos: «Pérez García» → perez, garcia, perezgarcia)
function lastOptions(apellido) {
  const t = tokens(apellido); if (!t.length) return [];
  return [...new Set([t[0], t[t.length - 1], t.join('')])];
}
function firstOf(nombre) { const t = tokens(nombre); return t[0] || ''; }

function inferPattern(nombre, apellido, local) {
  const f = firstOf(nombre), lopts = lastOptions(apellido), loc = strip(local);
  if (!f || !lopts.length || !loc) return null;
  for (const [key, p] of Object.entries(PATTERNS)) {
    for (const l of lopts) { if (p.fn(f, l) === loc) return key; }
  }
  return null;
}
function applyPattern(key, nombre, apellido) {
  const p = PATTERNS[key], f = firstOf(nombre), l = lastOptions(apellido)[0];
  if (!p || !f || !l) return '';
  return p.fn(f, l);
}

function hostOf(v) {
  if (!v) return '';
  try { return new URL(/^https?:/i.test(v) ? v : 'http://' + v).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) { return ''; }
}

async function hintsFor(pool, uid, contactId) {
  const { rows: [k] } = await pool.query('SELECT id, nombre, apellido, company_id, empresa_nombre FROM lm_contacts WHERE id=$1 AND user_id=$2', [contactId, uid]);
  if (!k) return null;
  let co = {};
  if (k.company_id) co = (await pool.query('SELECT nombre, dominio, website FROM lm_companies WHERE id=$1 AND user_id=$2', [k.company_id, uid])).rows[0] || {};
  let domain = hostOf(co.dominio) || hostOf(co.website);
  let domainSource = domain ? 'empresa' : '';
  if (!domain && k.company_id) {   // sin dominio en la empresa: el de otros contactos de la misma empresa
    const { rows } = await pool.query("SELECT lower(split_part(email,'@',2)) d, COUNT(*)::int n FROM lm_contacts WHERE user_id=$1 AND company_id=$2 AND email LIKE '%@%' GROUP BY 1 ORDER BY 2 DESC", [uid, k.company_id]);
    const d = rows.map(r => r.d).find(x => x && !FREE.has(x));
    if (d) { domain = d; domainSource = 'otros contactos de la empresa'; }
  }
  const out = { contacto: { id: k.id, nombre: k.nombre, apellido: k.apellido }, empresa: co.nombre || k.empresa_nombre || '', domain, domainSource, known: [], generico: [], suggestions: [], existing: null, reference: null };
  if (!domain) return out;

  const like = '%@' + domain;
  const [a, b, c, d] = await Promise.all([
    pool.query("SELECT nombre, apellido, email, email_status FROM lm_contacts WHERE user_id=$1 AND lower(email) LIKE $2 AND id<>$3", [uid, like, k.id]),
    pool.query("SELECT nombre, apellido, email FROM cantera_contacts WHERE user_id=$1 AND lower(email) LIKE $2", [uid, like]).catch(() => ({ rows: [] })),
    pool.query("SELECT nombre, apellido, email FROM lm_exclusion_contacts WHERE user_id=$1 AND lower(email) LIKE $2", [uid, like]).catch(() => ({ rows: [] })),
    pool.query("SELECT email, status FROM lm_smtp_attempts WHERE user_id=$1 AND lower(email) LIKE $2", [uid, like]).catch(() => ({ rows: [] })),
  ]);
  // Lo que el sistema SABE de cada correo: respondió, lo abrieron/clicaron, se envió sin rebotar, rebotó, verificación SMTP.
  const { rows: evRows } = await pool.query(
    `SELECT lower(m.to_email) AS email,
            bool_or(m.estado='replied' OR m.replied_at IS NOT NULL) AS replied,
            bool_or(m.estado='bounced') AS bounced,
            bool_or(m.estado IN ('sent','replied')) AS sent,
            bool_or(EXISTS (SELECT 1 FROM lm_message_events ev WHERE ev.message_id=m.id AND ev.tipo IN ('open','click'))) AS opened
       FROM lm_messages m WHERE m.user_id=$1 AND lower(m.to_email) LIKE $2 GROUP BY 1`, [uid, like]).catch(() => ({ rows: [] }));
  const ev = new Map(evRows.map(r => [r.email, r]));
  const seen = new Set(), bad = new Set();
  d.rows.forEach(r => { if (/^(invalid|undeliverable|bounce)/i.test(r.status || '')) bad.add(String(r.email).toLowerCase()); });
  evRows.forEach(r => { if (r.bounced && !r.replied && !r.opened) bad.add(r.email); });
  const smtpOk = new Set(d.rows.filter(r => /^(valid|verified)/i.test(r.status || '')).map(r => String(r.email).toLowerCase()));
  const push = (r, source) => {
    const email = String(r.email || '').trim().toLowerCase(); if (!email || seen.has(email)) return; seen.add(email);
    const local = email.split('@')[0];
    const e = ev.get(email) || {};
    const verified = /^(valid|verified)/i.test(r.email_status || '') || smtpOk.has(email);
    const estado = /^(invalid|undeliverable|bounce)/i.test(r.email_status || '') || bad.has(email) ? 'malo' : '';
    // calidad de la evidencia (0–1): respondió > lo abrieron > verificado por SMTP > enviado sin rebote > solo existe en el CRM
    const q = estado === 'malo' ? 0 : e.replied ? 1 : e.opened ? 0.93 : verified ? 0.85 : e.sent ? 0.6 : 0.45;
    const prueba = e.replied ? 'respondió' : e.opened ? 'abierto' : verified ? 'verificado' : e.sent ? 'entregado' : 'sin comprobar';
    if (GENERIC.test(local)) { out.generico.push(email); return; }
    const pattern = inferPattern(r.nombre, r.apellido, local);
    out.known.push({ email, nombre: [r.nombre, r.apellido].filter(Boolean).join(' '), source, estado, pattern, q, prueba });
  };
  a.rows.forEach(r => push(r, 'CRM')); b.rows.forEach(r => push(r, 'Cantera')); c.rows.forEach(r => push(r, 'Exclusiones'));
  d.rows.forEach(r => push({ email: r.email, nombre: '', apellido: '', email_status: r.status }, 'Intentos de envío'));

  // ¿ya existe el correo de ESTA persona en algún lado? (mismo nombre y apellido en ese dominio)
  const fN = firstOf(k.nombre), lN = lastOptions(k.apellido);
  out.existing = out.known.find(x => x.nombre && strip(x.nombre).includes(fN) && lN.some(l => strip(x.nombre).includes(l))) || null;

  // patrón dominante entre los correos con nombre conocido
  const good = out.known.filter(x => x.pattern && x.estado !== 'malo');
  const groups = {};
  good.forEach(x => { (groups[x.pattern] = groups[x.pattern] || []).push(x); });
  const total = good.length;
  const badPat = {};   // patrones que ya rebotaron en este dominio
  out.known.filter(x => x.pattern && x.estado === 'malo').forEach(x => { badPat[x.pattern] = (badPat[x.pattern] || 0) + 1; });
  out.suggestions = Object.entries(groups).map(([pat, list]) => {
    const email = applyPattern(pat, k.nombre, k.apellido);
    const qs = list.map(x => x.q), qmax = Math.max(...qs), qmean = qs.reduce((x, y) => x + y, 0) / qs.length;
    const quality = 0.6 * qmax + 0.4 * qmean;                        // cuánto se ha comprobado que ese patrón llega
    const share = list.length / (total + (badPat[pat] || 0));         // qué parte de los correos del dominio lo usa (los rebotados restan)
    const sizeF = 0.55 + 0.45 * (1 - Math.pow(0.5, list.length));     // 1 ejemplo pesa poco; 3 o más, mucho
    const pct = Math.max(5, Math.min(98, Math.round(100 * (0.55 * share + 0.45 * quality) * sizeF)));
    const tally = { respondio: list.filter(x => x.prueba === 'respondió').length, abierto: list.filter(x => x.prueba === 'abierto').length, verificado: list.filter(x => x.prueba === 'verificado').length, entregado: list.filter(x => x.prueba === 'entregado').length };
    return { pattern: pat, label: PATTERNS[pat].label, email: email ? email + '@' + domain : '', pct, nivel: pct >= 80 ? 'alta' : pct >= 50 ? 'media' : 'baja', count: list.length, of: total, tally,
      examples: list.slice().sort((x, y) => y.q - x.q).slice(0, 3).map(x => ({ email: x.email, prueba: x.prueba })), bad: bad.has((email + '@' + domain).toLowerCase()) };
  }).filter(x => x.email).sort((x, y) => y.pct - x.pct).slice(0, 3);

  // sin evidencia propia: lo que el sistema recuerda del dominio (no confirmado)
  if (!out.suggestions.length) {
    try {
      const r = dps.detectDomainPattern(domain), pat = DPS_MAP[r && r.likelyPattern];
      if (pat && r.source !== 'heuristic') { const e = applyPattern(pat, k.nombre, k.apellido); if (e) { const pct = Math.round(Math.min(r.source === 'memory' ? 70 : 55, (r.confidence || 0.5) * 100 * 0.8)); out.reference = { pattern: pat, label: PATTERNS[pat].label, email: e + '@' + domain, source: r.source === 'memory' ? 'confirmado antes por SMTP (sin envíos propios)' : 'base curada del sistema', pct, nivel: pct >= 80 ? 'alta' : pct >= 50 ? 'media' : 'baja' }; } }
    } catch (_) { /* sin referencia */ }
  }
  return out;
}

function mount(app, { pool, requireAuth }) {
  app.get('/api/lm/contacts/:id/email-hints', requireAuth, async (req, res) => {
    try {
      const h = await hintsFor(pool, req.workspaceOwnerId, parseInt(req.params.id, 10));
      if (!h) return res.status(404).json({ error: 'Contacto no encontrado' });
      res.json(h);
    } catch (e) { console.error('[email-hints]', e.message); res.status(500).json({ error: 'No se pudo consultar' }); }
  });
}

module.exports = { mount, hintsFor, inferPattern, applyPattern };
