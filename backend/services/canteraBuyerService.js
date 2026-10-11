'use strict';
// Buyer por tamaño de empresa — regla DETERMINISTA (sin IA). Cada borrador define bandas de tamaño y, por banda, la lista ordenada de cargos
// (1.º = el primero a contactar). Aquí se asigna cantera_contacts.prioridad (1, 2, 3…) comparando el cargo de cada contacto con esa lista.
// Nunca pisa una prioridad puesta a mano: solo toca contactos con prioridad=0 o cuya prioridad ya fue puesta por esta regla (prioridad_auto).

const _n = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "11-50", "11-50 employees", "1,001-5,000", "10,001+", "2-10" → empleados mínimo de la banda (11, 1001, 10001, 2). null si no se entiende.
function parseTamano(txt) {
  const nums = (String(txt || '').replace(/(\d),(\d)/g, '$1$2').match(/\d+/g) || []).map(Number);
  return nums.length ? nums[0] : null;
}

// Cada regla elige el CAMPO por el que se evalúa. Numéricos (rango desde–hasta): tamano, puntaje. Textuales (lista de valores, uno por línea):
// pais, industria, ciudad (coincidencia por texto), tier_clave, prioridad, confianza (igualdad exacta) y "dato:<nombre>" (un dato extra investigado, por texto). Gana la primera regla que calce.
const _NUM_CAMPOS = ['tamano', 'puntaje'];
const _EXACT_CAMPOS = ['tier_clave', 'prioridad', 'confianza'];
function _valorCampo(empresa, campo) {
  if (campo === 'tamano') return parseTamano(empresa.tamano);
  if (campo === 'puntaje') return empresa.puntaje == null || empresa.puntaje === '' ? null : Number(empresa.puntaje);
  if (campo.startsWith('dato:')) {
    const nm = campo.slice(5).trim().toLowerCase(), de = empresa.datos_extra || {};
    const k = Object.keys(de).find(x => x.trim().toLowerCase() === nm);
    return k ? _n(de[k]) : '';
  }
  return _n(empresa[campo]);
}
function bandaPara(reglas, co) {
  const empresa = (co && typeof co === 'object') ? co : { tamano: co };
  return (reglas || []).find(r => {
    const campo = r.campo || 'tamano';
    const v = _valorCampo(empresa, campo);
    if (_NUM_CAMPOS.includes(campo)) {
      if (v == null || isNaN(v)) return false;
      const d = r.desde === '' || r.desde == null ? 0 : Number(r.desde);
      const h = r.hasta === '' || r.hasta == null ? Infinity : Number(r.hasta);
      return v >= d && v <= h;
    }
    if (!v) return false;
    const vals = String(r.valores || "").split(/\r?\n/).map(_n).filter(Boolean);
    return _EXACT_CAMPOS.includes(campo) ? vals.includes(v) : vals.some(x => v.includes(x));
  }) || null;
}

function cargosDe(regla) {
  return String(regla?.cargos || '').split(/\r?\n/).map(_n).filter(Boolean);
}

async function asignarBuyers(pool, batchId, uid, companyIds) {
  const { rows: [b] } = await pool.query('SELECT reglas_buyer FROM cantera_batches WHERE id=$1 AND user_id=$2', [batchId, uid]);
  const reglas = Array.isArray(b?.reglas_buyer) ? b.reglas_buyer.filter(r => cargosDe(r).length) : [];
  if (!reglas.length) return { empresas: 0, asignados: 0, sinBanda: 0 };
  const { rows: companies } = await pool.query(
    Array.isArray(companyIds) && companyIds.length
      ? 'SELECT id, tamano, pais, industria, ciudad, tier_clave, puntaje, prioridad, confianza, datos_extra FROM cantera_companies WHERE batch_id=$1 AND user_id=$2 AND id = ANY($3::int[])'
      : 'SELECT id, tamano, pais, industria, ciudad, tier_clave, puntaje, prioridad, confianza, datos_extra FROM cantera_companies WHERE batch_id=$1 AND user_id=$2',
    Array.isArray(companyIds) && companyIds.length ? [batchId, uid, companyIds] : [batchId, uid]);
  let empresas = 0, asignados = 0, sinBanda = 0;
  for (const co of companies) {
    const banda = bandaPara(reglas, co);
    if (!banda) { sinBanda++; continue; }
    const cargos = cargosDe(banda);
    const { rows: cts } = await pool.query('SELECT id, cargo, prioridad, prioridad_auto FROM cantera_contacts WHERE company_id=$1 AND user_id=$2 ORDER BY id', [co.id, uid]);
    const manuales = cts.filter(c => c.prioridad > 0 && !c.prioridad_auto);
    const usados = new Set(manuales.map(c => c.prioridad));
    const cand = cts.filter(c => !(c.prioridad > 0 && !c.prioridad_auto)).map(c => {
      const cg = _n(c.cargo);
      const idx = cargos.findIndex(t => cg.includes(t));
      return { c, idx };
    }).filter(x => x.idx >= 0).sort((a, b2) => a.idx - b2.idx || a.c.id - b2.c.id);
    let rank = 1;
    for (const x of cand) {
      while (usados.has(rank)) rank++;
      await pool.query('UPDATE cantera_contacts SET prioridad=$1, prioridad_auto=true WHERE id=$2', [rank, x.c.id]);
      usados.add(rank); asignados++;
    }
    // Los que ya no calzan con la regla y estaban en automático vuelven a "sin prioridad".
    const quedan = new Set(cand.map(x => x.c.id));
    for (const c of cts) if (c.prioridad_auto && !quedan.has(c.id)) await pool.query('UPDATE cantera_contacts SET prioridad=0, prioridad_auto=false WHERE id=$1', [c.id]);
    empresas++;
  }
  return { empresas, asignados, sinBanda };
}

module.exports = { asignarBuyers, parseTamano, bandaPara };
