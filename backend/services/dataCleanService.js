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

// field → limpiador, por entidad. Solo estos campos son "limpiables" en esta primera entrega.
const CLEANERS = {
  companies: { nombre: cleanCompanyName, tamano: cleanEmployeeCount },
  contacts:  { cargo: cleanTitle },
};

function cleanableFields(entity) { return Object.keys(CLEANERS[entity] || {}); }
function cleanValue(entity, field, raw) {
  const fn = (CLEANERS[entity] || {})[field];
  return fn ? fn(raw) : raw;
}

module.exports = { cleanCompanyName, cleanTitle, cleanEmployeeCount, cleanableFields, cleanValue };
