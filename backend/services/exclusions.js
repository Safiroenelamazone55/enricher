// Lista de exclusión de empresas: empresas (y sus contactos) que NO se deben contactar.
// Alcance (scope): 'global' (todo el workspace) | 'cliente' (todas las campañas y secuencias de ese cliente outbound)
//                  | 'campana' (una campaña) | 'secuencia' (una secuencia).
// Una exclusión = una empresa con: nombre, website, LinkedIn, ciudad, VARIOS dominios (principal + extra) y N contactos
// (nombre, apellido, nombre completo, puesto, nota, email opcional).
// Reconocimiento de una empresa: comparte alguno de sus DOMINIOS (si "match_dominio" no está apagado: las redes/franquicias
// como RE/MAX comparten dominio y se bloquean solo por nombre), su LINKEDIN, o su NOMBRE normalizado (sin tildes ni SL/SA/Ltd).
// Si la exclusión trae ciudad y la empresa también y son distintas, el nombre solo no basta (otra sucursal).
// Reconocimiento de un contacto: su empresa coincide, o su EMAIL es exactamente uno de los emails excluidos, o su email es de
// un dominio excluido, o (sin empresa conocida) coincide nombre + apellido con un contacto excluido.
// Falsos positivos son preferibles a contactar a alguien excluido.

const LEGAL = /\b(s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|s\.?\s?l\.?\s?l\.?|s\.?\s?c\.?\s?p?\.?|c\.?\s?b\.?|ltd\.?|limited|inc\.?|llc|gmbh|sas|srl|s\.r\.l\.|b\.?v\.?|ag|co\.?|corp\.?|corporation|sociedad limitada|sociedad anonima)\s*$/i;
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es', 'icloud.com', 'live.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com', 'aol.com']);

function normName(s) {
  let x = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' y ');
  x = x.replace(/[’'`´"]/g, '').replace(/[.,;:()\[\]\-_/\\|]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) x = x.replace(LEGAL, '').trim();
  return x;
}
function normPerson(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`´".,;:()\-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s(]/)[0].trim();
  if (!/\./.test(s) || FREEMAIL.has(s)) return '';
  return s;
}
function linkedinSlug(raw) {
  const m = String(raw || '').toLowerCase().match(/linkedin\.com\/(?:company|school)\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : '';
}
function normPlace(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(greater|metropolitan|area|provincia de|province)\b/g, ' ').replace(/[.,;:()\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Campos derivados que se guardan junto a cada exclusión. row.dominios (array) + row.dominio + row.website, en ese orden de prioridad.
function keysOf(row) {
  const doms = [];
  [].concat(row.dominios || [], [row.dominio, row.website]).forEach(d => { const n = normDomain(d); if (n && !doms.includes(n)) doms.push(n); });
  return {
    nombre_norm: normName(row.nombre),
    dominio: doms[0] || '',
    dominios_extra: doms.slice(1),
    linkedin_slug: linkedinSlug(row.linkedin),
    ciudad_norm: normPlace(row.ciudad),
  };
}
function domainsOf(ex) {
  if (ex.match_dominio === false) return [];
  return [ex.dominio].concat(ex.dominios_extra || []).filter(Boolean);
}

// ¿Esta empresa coincide con esta exclusión? → 'dominio' | 'linkedin' | 'nombre' | null
function matchCompany(ex, co) {
  const exDoms = domainsOf(ex);
  const cDom = [normDomain(co.dominio), normDomain(co.website)].filter(Boolean);
  if (exDoms.length && cDom.some(d => exDoms.includes(d))) return 'dominio';
  const slug = linkedinSlug(co.linkedin);
  if (ex.linkedin_slug && slug && slug === ex.linkedin_slug) return 'linkedin';
  const nm = normName(co.nombre || co.empresa_nombre);
  if (ex.nombre_norm && nm && nm === ex.nombre_norm) {
    const cc = normPlace(co.ciudad);
    if (ex.ciudad_norm && cc && ex.ciudad_norm !== cc) return null;   // misma marca, otra sucursal
    return 'nombre';
  }
  return null;
}

// ¿Este CONTACTO está excluido por la exclusión? (por su empresa o por sus propios datos)
function matchContact(ex, k) {
  const byCo = matchCompany(ex, { nombre: k.co_nombre || k.empresa_nombre, dominio: k.dominio, website: k.website, linkedin: k.linkedin, ciudad: k.ciudad });
  if (byCo) return byCo;
  const email = String(k.email || '').trim().toLowerCase();
  const email2 = String(k.email_personal || '').trim().toLowerCase();
  const cts = ex.contactos || [];
  if (email || email2) {
    if (cts.some(c => c.email && [email, email2].includes(String(c.email).trim().toLowerCase()))) return 'email';
    const ed = normDomain(email);
    if (ed && domainsOf(ex).includes(ed)) return 'dominio_email';
  }
  if (!k.company_id && !k.co_nombre && !k.empresa_nombre) {
    const full = normPerson((k.nombre || '') + ' ' + (k.apellido || ''));
    if (full && (k.apellido || '').trim() && cts.some(c => c.apellido && normPerson(c.nombre_completo || ((c.nombre || '') + ' ' + (c.apellido || ''))) === full)) return 'contacto';
  }
  return null;
}

async function resolveCtx(pool, uid, ctx) {
  const out = { clientId: ctx.clientId || null, campaignIds: ctx.campaignId ? [ctx.campaignId] : [], sequenceId: ctx.sequenceId || null };
  if (ctx.sequenceId) {
    const r = (await pool.query(`SELECT campaign_id, outbound_client_id FROM sequences WHERE id=$1 AND user_id=$2`, [ctx.sequenceId, uid])).rows[0];
    if (r) { if (r.campaign_id) out.campaignIds.push(r.campaign_id); out.clientId = out.clientId || r.outbound_client_id || null; }
  }
  if (ctx.campaignId && !out.clientId) {
    const r = (await pool.query(`SELECT outbound_client_id FROM campaigns WHERE id=$1 AND user_id=$2`, [ctx.campaignId, uid])).rows[0];
    if (r) out.clientId = r.outbound_client_id || null;
  }
  return out;
}

async function _attachContacts(pool, rows) {
  if (!rows.length) return rows;
  const cts = (await pool.query(`SELECT * FROM lm_exclusion_contacts WHERE exclusion_id = ANY($1::int[]) ORDER BY orden, id`, [rows.map(r => r.id)])).rows;
  const by = new Map();
  cts.forEach(c => { if (!by.has(c.exclusion_id)) by.set(c.exclusion_id, []); by.get(c.exclusion_id).push(c); });
  rows.forEach(r => { r.contactos = by.get(r.id) || []; });
  return rows;
}

// Exclusiones que aplican a un contexto (secuencia / campaña / cliente), con sus contactos.
async function loadApplicable(pool, uid, ctx) {
  const c = await resolveCtx(pool, uid, ctx);
  const { rows } = await pool.query(
    `SELECT * FROM lm_exclusions WHERE user_id=$1 AND (
        scope='global'
        OR (scope='cliente'   AND outbound_client_id IS NOT NULL AND outbound_client_id=$2)
        OR (scope='campana'   AND campaign_id = ANY($3::int[]))
        OR (scope='secuencia' AND sequence_id IS NOT NULL AND sequence_id=$4)
     )`, [uid, c.clientId, c.campaignIds, c.sequenceId]);
  return _attachContacts(pool, rows);
}

function firstMatchContact(exs, k) {
  for (const ex of exs) { const how = matchContact(ex, k); if (how) return { ex, how }; }
  return null;
}
function firstMatch(exs, co) {
  for (const ex of exs) { const how = matchCompany(ex, co); if (how) return { ex, how }; }
  return null;
}

// Separa contactos permitidos / excluidos para un contexto.
async function filterContacts(pool, uid, contactIds, ctx) {
  const exs = await loadApplicable(pool, uid, ctx);
  if (!exs.length || !contactIds.length) return { allowed: contactIds.slice(), excluded: [] };
  const { rows } = await pool.query(
    `SELECT k.id, k.nombre, k.apellido, k.email, k.email_personal, k.company_id, k.empresa_nombre,
            co.nombre AS co_nombre, co.dominio, co.website, co.linkedin, co.ciudad
       FROM lm_contacts k LEFT JOIN lm_companies co ON co.id = k.company_id
      WHERE k.user_id=$1 AND k.id = ANY($2::int[])`, [uid, contactIds]);
  const byId = new Map(rows.map(r => [r.id, r]));
  const allowed = [], excluded = [];
  for (const id of contactIds) {
    const r = byId.get(id);
    if (!r) { allowed.push(id); continue; }
    const m = firstMatchContact(exs, r);
    if (m) excluded.push({ id, nombre: [r.nombre, r.apellido].filter(Boolean).join(' '), empresa: r.co_nombre || r.empresa_nombre || '', motivo: m.ex.motivo || m.ex.categoria || '', lista: m.ex.lista || '', scope: m.ex.scope, how: m.how });
    else allowed.push(id);
  }
  return { allowed, excluded };
}

async function filterCompanies(pool, uid, companyIds, ctx) {
  const exs = await loadApplicable(pool, uid, ctx);
  if (!exs.length || !companyIds.length) return { allowed: companyIds.slice(), excluded: [] };
  const { rows } = await pool.query(`SELECT id, nombre, dominio, website, linkedin, ciudad FROM lm_companies WHERE user_id=$1 AND id = ANY($2::int[])`, [uid, companyIds]);
  const byId = new Map(rows.map(r => [r.id, r]));
  const allowed = [], excluded = [];
  for (const id of companyIds) {
    const r = byId.get(id);
    const m = r ? firstMatch(exs, r) : null;
    if (m) excluded.push({ id, empresa: r.nombre, motivo: m.ex.motivo || m.ex.categoria || '', lista: m.ex.lista || '', scope: m.ex.scope, how: m.how });
    else allowed.push(id);
  }
  return { allowed, excluded };
}

// Guardia del motor de envío: ¿esta inscripción activa pertenece a una empresa/contacto excluido para su secuencia?
async function isEnrollmentExcluded(pool, enr) {
  const exs = await loadApplicable(pool, enr.user_id, { sequenceId: enr.sequence_id, clientId: enr.outbound_client_id });
  if (!exs.length) return false;
  const r = (await pool.query(
    `SELECT k.id, k.nombre, k.apellido, k.email, k.email_personal, k.company_id, k.empresa_nombre,
            co.nombre AS co_nombre, co.dominio, co.website, co.linkedin, co.ciudad
       FROM lm_contacts k LEFT JOIN lm_companies co ON co.id = k.company_id WHERE k.id=$1`, [enr.contact_id])).rows[0];
  return r ? !!firstMatchContact(exs, r) : false;
}

// Al crear exclusiones: pausa lo que ya está en marcha para esas empresas/contactos dentro del alcance de cada exclusión.
async function pauseExistingFor(pool, uid, newExclusions) {
  if (!newExclusions.length) return { paused: 0, queue: 0 };
  await _attachContacts(pool, newExclusions);
  const { rows } = await pool.query(
    `SELECT cs.id AS enr_id, cs.sequence_id, k.id AS contact_id, k.nombre, k.apellido, k.email, k.email_personal, k.company_id, k.empresa_nombre,
            s.campaign_id, s.outbound_client_id, co.nombre AS co_nombre, co.dominio, co.website, co.linkedin, co.ciudad
       FROM lm_contact_sequences cs
       JOIN lm_contacts k ON k.id = cs.contact_id
       JOIN sequences s ON s.id = cs.sequence_id
       LEFT JOIN lm_companies co ON co.id = k.company_id
      WHERE cs.user_id=$1 AND cs.estado IN ('activo','pausado') AND COALESCE(cs.paused_reason,'') <> 'excluida'`, [uid]);
  const inScope = (ex, r) => ex.scope === 'global'
    || (ex.scope === 'cliente' && r.outbound_client_id && ex.outbound_client_id === r.outbound_client_id)
    || (ex.scope === 'campana' && r.campaign_id && ex.campaign_id === r.campaign_id)
    || (ex.scope === 'secuencia' && ex.sequence_id === r.sequence_id);
  const ids = [];
  for (const r of rows) if (newExclusions.some(ex => inScope(ex, r) && matchContact(ex, r))) ids.push(r.enr_id);
  if (ids.length) {
    await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='excluida' WHERE id = ANY($1::int[])`, [ids]);
    // Borradores/aprobados pendientes de esos contactos: no deben salir.
    await pool.query(
      `UPDATE lm_messages m SET estado='failed', error='No enviado: la empresa está en la lista de exclusión'
         FROM lm_contact_sequences cs
        WHERE cs.id = ANY($1::int[]) AND m.contact_id = cs.contact_id AND m.sequence_id = cs.sequence_id AND m.estado IN ('awaiting','approved')`, [ids]);
  }
  // Cola "Empresa primero": las pendientes de esas empresas se descartan.
  const q = (await pool.query(
    `SELECT qs.id, qs.sequence_id, co.nombre, co.dominio, co.website, co.linkedin, co.ciudad, s.campaign_id, s.outbound_client_id
       FROM lm_company_sequences qs JOIN lm_companies co ON co.id = qs.company_id JOIN sequences s ON s.id = qs.sequence_id
      WHERE qs.user_id=$1 AND qs.estado='pendiente'`, [uid])).rows;
  const qids = q.filter(r => newExclusions.some(ex => inScope(ex, r) && matchCompany(ex, r))).map(r => r.id);
  if (qids.length) await pool.query(`UPDATE lm_company_sequences SET estado='descartada' WHERE id = ANY($1::int[])`, [qids]);
  return { paused: ids.length, queue: qids.length };
}

module.exports = { normName, normPerson, normDomain, linkedinSlug, normPlace, keysOf, domainsOf, matchCompany, matchContact, loadApplicable, filterContacts, filterCompanies, isEnrollmentExcluded, pauseExistingFor, _attachContacts };
