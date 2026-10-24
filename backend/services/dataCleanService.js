'use strict';
const geo = require('./geoService');

/**
 * dataCleanService.js
 *
 * Reglas de limpieza para datos importados de Empresas/Contactos (Enriquecimiento → Datos).
 * Funciones puras: reciben el valor crudo, devuelven el valor limpio. No tocan la DB —
 * eso lo hace el endpoint POST /api/lm/bulk-clean en server.js, que decide qué cambió.
 */

// ── Nombre de empresa ────────────────────────────────────────────────────────
// Sufijos legales al final del nombre (España, LatAm, UE, anglo). Se quitan en bucle (hasta 3 veces) para casos como
// "Acme Homes S.L.U." o "Acme, S.A. de C.V.". Las formas abreviadas aceptan cualquier mezcla de puntos y espacios:
// "S.L", "SL", "S. L.", "s.l." → dot('sl') genera  s\.?\s*l\.?  (cada letra con punto y espacios opcionales).
function dot(w) { return w.split('').map(c => c + '\\.?').join('\\s*'); }
// Formas largas / con puntos: sin distinguir mayúsculas. El orden importa (las más largas primero).
const CO_LONG = [
  dot('sa') + '\\s*de\\s*' + dot('cv'),                      // S.A. de C.V.
  dot('sderl') + '(?:\\s*de\\s*' + dot('cv') + ')?',        // S. de R.L. [de C.V.]
  dot('slu'), dot('sll'), dot('slne'), dot('sau'), dot('sas'), dot('sac'), dot('scp'), dot('sca'),
  dot('srl'), dot('spa'), dot('sl'), dot('sa'), dot('sc'),
  dot('bv'), dot('nv'), dot('sarl'), dot('llc'), dot('llp'), dot('pty') + '(?:\\s*' + dot('ltd') + ')?',
  's\\.?\\s*coop',                                           // cooperativa
  'c\\.\\s*b\\.',                                            // comunidad de bienes (solo escrita con puntos: "CB" suelto puede ser parte del nombre)
  's\\.\\s*i\\.?',                                           // "S.I": error de tipeo habitual de "S.L."
  'incorporated', 'inc', 'corporation', 'corp', 'limited', 'ltda', 'ltd', 'gmbh', 'plc', 'co',
];
// Formas cortas ambiguas: solo en MAYÚSCULAS y como palabra suelta (así no se confunden con palabras normales).
const CO_UPPER = ['AG', 'AS', 'AB', 'OY', 'ApS', 'KG', 'UG'];
const CO_SUFFIX_RE = new RegExp('[,;.\\s]+(?:' + CO_LONG.join('|') + ')[.\\s]*$', 'i');
const CO_UPPER_RE = new RegExp('[,;.\\s]+(?:' + CO_UPPER.join('|') + ')[.\\s]*$');
const LOWER_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'the', 'of', 'and', 'a']);

function titleCaseName(s) {
  return s.split(/(\s+)/).map((w, i) => {
    if (!w.trim()) return w;
    if (/[\/\d&@.]/.test(w) && w === w.toUpperCase()) return w;            // RE/MAX, 4YOU, S&P: se respetan
    const low = w.toLowerCase();
    if (i > 0 && LOWER_WORDS.has(low)) return low;
    return low.replace(/(^|[-'’])([a-záéíóúñüçãõàèìòùâêîôû])/g, (_, p, c) => p + c.toUpperCase());
  }).join('');
}

function cleanCompanyName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[ ​  ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();                   // comillas envolventes
  for (let i = 0; i < 3; i++) {
    const t = s.replace(CO_SUFFIX_RE, '').replace(CO_UPPER_RE, '');
    if (t === s || !t.trim()) break;                                         // nunca dejar el nombre vacío
    s = t;
  }
  s = s.replace(/^[\s,;:.\-–—|]+|[\s,;:.\-–—|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();                   // comillas que quedaron al descubierto al quitar el sufijo
  // TODO MAYÚSCULAS o todo minúsculas con 2+ palabras → Capitalizado (una sola palabra en mayúsculas suele ser marca: IMMOFY, RE/MAX)
  const letters = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñÜüÇç]/g, '');
  if (letters.length > 3 && /\s/.test(s)) {
    const allUp = s === s.toUpperCase() && s !== s.toLowerCase();
    const allLow = s === s.toLowerCase() && s !== s.toUpperCase();
    if (allUp || allLow) s = titleCaseName(s);
  }
  // Un nombre de empresa siempre empieza con mayúscula ("casaverano real estate" / "iProperty" → "Casaverano…" / "IProperty"); el resto no se toca.
  s = s.replace(/^([a-záéíóúñüçãõàèìòùâêîôû])/, c => c.toUpperCase());
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

// ── Nombres de personas (nombre / apellido) ──────────────────────────────────
// Errores típicos que traen LinkedIn / Apollo / HubSpot: «Sasha (Alexandra)», TODO MAYÚSCULAS, «Dr. Juan», «Ana García, MBA», emojis, comillas.
// Con paréntesis se conserva lo de FUERA (el nombre con que la persona se presenta) y solo si no queda nada se usa lo de dentro.
const NAME_PREFIX_RE = /^(?:dr|dra|doctor|doctora|mr|mrs|ms|miss|mx|sr|sra|srta|ing|lic|licda|prof|eng|arq|mtro|mtra)\.?\s+/i;
const NAME_CRED_RE = /(?:[,;]\s*|\s+)(?:mba|ph\.?\s?d|msc|m\.?sc|cpa|pmp|cfa|esq|m\.?d|dds|cissp|csm|cfp|rn)\.?(?:\s*,?\s*(?:mba|ph\.?\s?d|msc|cpa|pmp|cfa|esq|md|dds|cissp|csm|cfp|rn)\.?)*\s*$/i;
function _nameBase(raw, keepInsideIfEmpty) {
  let s = String(raw == null ? '' : raw).replace(/[ ​  ]/g, ' ');
  s = s.replace(/[\p{Extended_Pictographic}‍️]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const inside = (s.match(/\(([^)]*)\)/) || [])[1] || '';
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s && keepInsideIfEmpty) s = inside.trim();
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  s = s.replace(NAME_PREFIX_RE, '').replace(NAME_CRED_RE, '');
  s = s.replace(/^[\s,;:.\-–—|*_]+|[\s,;:\-–—|*_]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  const letters = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñÜüÇçÃÕÀÈÌÒÙÂÊÎÔÛãõàèìòùâêîôû]/g, '');
  if (letters.length > 1) {
    const allUp = s === s.toUpperCase() && s !== s.toLowerCase();
    const allLow = s === s.toLowerCase() && s !== s.toUpperCase();
    if (allUp || allLow) s = titleCaseName(s);
  }
  return s;
}
const cleanFirstName = raw => _nameBase(raw, true);
const cleanLastName = raw => _nameBase(raw, false);

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

// "https://www.acme.com/" -> "acme.com". Solo para el campo DOMINIO (el sitio web tiene su propio limpiador: cleanWebsite).
function cleanDomain(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim().toLowerCase();
  return s.includes('.') ? s : String(raw).trim();   // «n/a», «-»… no son dominios: se dejan como están
}
// Sitio web = URL completa y segura: "movr.es", "http://www.movr.es/" -> "https://www.movr.es". Va aparte del DOMINIO (que sí es solo "movr.es"):
// el website es el enlace que se abre; el dominio es la clave para cruzar/deduplicar y armar emails. Antes ambos se limpiaban igual y el website perdía su https://.
function cleanWebsite(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
  const slash = s.indexOf('/');
  const host = (slash === -1 ? s : s.slice(0, slash)).trim().toLowerCase();
  const path = slash === -1 ? '' : s.slice(slash).replace(/\/+$/, '');
  if (!host || /\s/.test(host) || !host.includes('.')) return String(raw).trim();
  return 'https://' + host + path;
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
  companies: { nombre: cleanCompanyName, tamano: cleanEmployeeCount, dominio: cleanDomain, website: cleanWebsite, telefono: cleanPhone, pais: geo.normalizeCountry },
  contacts:  { nombre: cleanFirstName, apellido: cleanLastName, cargo: cleanTitle, email: cleanEmail, email_personal: cleanEmail, telefono: cleanPhone, movil: cleanPhone, pais: geo.normalizeCountry },
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
// País e idioma se calculan desde la fila completa (ciudad + región + país): 'row: true' → fn(fila).
// El idioma sale de la ubicación del CONTACTO; si el país tiene varios idiomas de negocio y la ciudad no lo
// resuelve, queda vacío ("por revisar") en vez de adivinar.
const _paisDeFila = r => geo.countryFromPlace(r.ciudad, r.region) || '';
const _idiomaDeFila = r => { const l = geo.languageFor(r.pais, r.ciudad); return l.lang ? (geo.LANG_NAMES[l.lang] || l.lang) : ''; };
const ENRICHERS = {
  contacts: {
    seniority:    { from: 'cargo', fn: inferSeniority },
    departamento: { from: 'cargo', fn: inferDepartamento },
    pais:         { from: 'ciudad', row: true, fn: _paisDeFila },
    idioma:       { from: 'pais', row: true, fn: _idiomaDeFila },
  },
  companies: {
    pais:         { from: 'ciudad', row: true, fn: _paisDeFila },
  },
};
function enrichableFields(entity) { return Object.keys(ENRICHERS[entity] || {}); }
function enrichSource(entity, field) { return (ENRICHERS[entity] || {})[field]?.from || field; }
function enrichValue(entity, field, sourceRaw, row) {
  const cfg = (ENRICHERS[entity] || {})[field];
  if (!cfg) return sourceRaw;
  return cfg.row ? cfg.fn(row || {}) : cfg.fn(sourceRaw);
}
function enrichUsesRow(entity, field) { return !!((ENRICHERS[entity] || {})[field] || {}).row; }

module.exports = {
  cleanCompanyName, cleanTitle, cleanEmployeeCount, cleanDomain, cleanEmail, cleanPhone,
  cleanableFields, cleanValue, enrichUsesRow,
  inferSeniority, inferDepartamento, enrichableFields, enrichSource, enrichValue,
};
