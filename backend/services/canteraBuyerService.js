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

// Cada regla elige el CAMPO por el que se evalúa (tamano | pais | industria | ciudad). tamano: rango numérico desde–hasta; los demás: lista de valores (uno por línea, coincidencia por texto). Gana la primera regla que calce.
function bandaPara(reglas, co) {
  const empresa = (co && typeof co === 'object') ? co : { tamano: co };
  return (reglas || []).find(r => {
    const campo = r.campo || 'tamano';
    if (campo === 'tamano') {
      const n = parseTamano(empresa.tamano);
      if (n == null) return false;
      const d = r.desde === '' || r.desde == null ? 0 : Number(r.desde);
      const h = r.hasta === '' || r.hasta == null ? Infinity : Number(r.hasta);
      return n >= d && n <= h;
    }
    const v = _n(empresa[campo]);
    if (!v) return false;
    const vals = String(r.valores || "").split(/\r?\n/).map(_n).filter(Boolean);
    return vals.some(x => v.includes(x));
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
      ? 'SELECT id, tamano, pais, industria, ciudad FROM cantera_companies WHERE batch_id=$1 AND user_id=$2 AND id = ANY($3::int[])'
      : 'SELECT id, tamano, pais, industria, ciudad FROM cantera_companies WHERE batch_id=$1 AND user_id=$2',
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
