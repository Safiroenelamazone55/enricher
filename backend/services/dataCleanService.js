'use strict';

/**
 * dataCleanService.js
 *
 * Reglas de limpieza para datos importados de Empresas/Contactos (Enriquecimiento → Datos).
 * Funciones puras: reciben el valor crudo, devuelven el valor limpio. No tocan la DB —
 * eso lo hace el endpoint POST /api/lm/bulk-clean en server.js, que decide qué cambió.
 */

// Sufijos legales al final del nombre de empresa. Orden importa: los más largos/específicos
// van primero para que no los "coma" una alternativa más corta (ej. "S.A. DE C.V." antes que "S.A.").
const CO_SUFFIXES = [
  's\\.?a\\.?\\s*de\\s*c\\.?v\\.?',
  's\\.?a\\.?c\\.?',
  's\\.?r\\.?l\\.?',
  'l\\.?l\\.?c\\.?',
  'incorporated',
  'inc\\.?',
  'corporation',
  'corp\\.?',
  'ltda\\.?',
  'ltd\\.?',
  'gmbh',
  'plc',
  'llp',
  's\\.?a\\.?',
  'co\\.?',
];
const CO_SUFFIX_RE = new RegExp('[,.\\s]+(' + CO_SUFFIXES.join('|') + ')\\.?\\s*$', 'i');

function cleanCompanyName(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  s = s.replace(CO_SUFFIX_RE, '');
  s = s.replace(/[,.\s]+$/, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function cleanTitle(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  s = s.replace(/^[\-|,;:]+\s*/, '').replace(/\s*[\-|,;:]+$/, '').trim();
  if (!s) return s;
  const isAllUpper = s === s.toUpperCase() && s !== s.toLowerCase();
  const isAllLower = s === s.toLowerCase() && s !== s.toUpperCase();
  if (isAllUpper || isAllLower) {
    s = s.toLowerCase().replace(/(^|\s)([a-záéíóúñ])/g, (_, sp, c) => sp + c.toUpperCase());
  }
  return s;
}

function cleanEmployeeCount(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  const rangeMatch = s.match(/(\d[\d,.]*)\s*[-–—]\s*(\d[\d,.]*)/);
  if (rangeMatch) return `${rangeMatch[1].replace(/[,.]/g, '')}-${rangeMatch[2].replace(/[,.]/g, '')}`;
  const plusMatch = s.match(/(\d[\d,.]*)\s*\+/);
  if (plusMatch) return plusMatch[1].replace(/[,.]/g, '') + '+';
  const single = s.match(/\d[\d,.]*/);
  if (single) return single[0].replace(/[,.]/g, '');
  return s;
}

// "https://www.acme.com/" -> "acme.com". Se aplica a dominio Y a website (website
// se guarda igual de "limpio" — si hace falta la URL completa está el dominio para
// reconstruirla, y así ambos campos quedan comparables/deduplicables).
function cleanDomain(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
  return s.toLowerCase();
}
function cleanEmail(raw) { return String(raw == null ? '' : raw).trim().toLowerCase(); }
// Deja solo dígitos (y el + inicial si lo tenía) — "+51 987-654 321" -> "+51987654321".
function cleanPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  const plus = s.startsWith('+');
  return (plus ? '+' : '') + s.replace(/\D/g, '');
}

// field → limpiador, por entidad.
const CLEANERS = {
  companies: { nombre: cleanCompanyName, tamano: cleanEmployeeCount, dominio: cleanDomain, website: cleanDomain, telefono: cleanPhone },
  contacts:  { cargo: cleanTitle, email: cleanEmail, email_personal: cleanEmail, telefono: cleanPhone, movil: cleanPhone },
};

function cleanableFields(entity) { return Object.keys(CLEANERS[entity] || {}); }
function cleanValue(entity, field, raw) {
  const fn = (CLEANERS[entity] || {})[field];
  return fn ? fn(raw) : raw;
}

// ── Enriquecimiento CALCULADO — se deriva de datos que el contacto ya tiene
// (el cargo), sin llamar a ninguna fuente externa. Primera pieza de "✨ Enriquecer".
const SENIORITY_RULES = [
  [/\b(fundador|fundadora|founder|co-?founder|dueñ[oa]|owner)\b/i, 'founder'],
  [/\b(ceo|cfo|coo|cto|cmo|cro|ciso|chief\s+\w+\s+officer|presidente|president)\b/i, 'c-level'],
  [/\b(vp|v\.p\.|vice\s?president|vicepresidente)\b/i, 'vp'],
  [/\b(director|directora|head\s+of|jefe\s+de|jefa\s+de)\b/i, 'director'],
  [/\b(gerente|manager|encargad[oa])\b/i, 'manager'],
  [/\b(senior|sr\.?\s)/i, 'senior'],
  [/\b(junior|jr\.?\s|asistente|assistant|analista|analyst|coordinador|coordinadora|coordinator|becari[oa]|intern|practicante)\b/i, 'junior'],
];
function inferSeniority(cargo) {
  const s = String(cargo || '');
  for (const [re, val] of SENIORITY_RULES) if (re.test(s)) return val;
  return '';
}
const DEPTO_RULES = [
  [/\b(venta|ventas|sales|comercial|account\s+exec)/i, 'ventas'],
  [/\b(marketing|mercadeo|growth|brand|marca)/i, 'marketing'],
  [/\b(operacion|operations|log[ií]stica|logistics|supply\s+chain|producci[oó]n|production)/i, 'operaciones'],
  [/\b(finanzas|finance|contabilidad|accounting|tesorer[ií]a|treasury)/i, 'finanzas'],
  [/\b(recursos\s+humanos|rrhh|hr\b|human\s+resources|talento|people\s+ops)/i, 'rrhh'],
  [/\b(ti\b|it\b|tecnolog|software|desarroll|developer|engineer|ingenier[ií]a\s+de\s+software|sistemas)/i, 'ti'],
  [/\b(legal|jur[ií]dic)/i, 'legal'],
  [/\b(compras|purchasing|procurement|abastecimiento)/i, 'compras'],
  [/\b(atenci[oó]n\s+al\s+cliente|customer\s+(service|success)|soporte|support)/i, 'servicio al cliente'],
];
function inferDepartamento(cargo) {
  const s = String(cargo || '');
  for (const [re, val] of DEPTO_RULES) if (re.test(s)) return val;
  return '';
}
// Igual que CLEANERS pero derivan un campo A PARTIR DE OTRO (no limpian el mismo
// campo) — por eso llevan su propio nombre de campo fuente.
const ENRICHERS = {
  contacts: {
    seniority:    { from: 'cargo', fn: inferSeniority },
    departamento: { from: 'cargo', fn: inferDepartamento },
  },
};
function enrichableFields(entity) { return Object.keys(ENRICHERS[entity] || {}); }
function enrichSource(entity, field) { return (ENRICHERS[entity] || {})[field]?.from || field; }
function enrichValue(entity, field, sourceRaw) {
  const cfg = (ENRICHERS[entity] || {})[field];
  return cfg ? cfg.fn(sourceRaw) : sourceRaw;
}

module.exports = {
  cleanCompanyName, cleanTitle, cleanEmployeeCount, cleanDomain, cleanEmail, cleanPhone,
  cleanableFields, cleanValue,
  inferSeniority, inferDepartamento, enrichableFields, enrichSource, enrichValue,
};
