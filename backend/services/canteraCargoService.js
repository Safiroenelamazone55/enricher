'use strict';
// Prioridad por CARGO — pedido explícito 2026-10-26: en vez de escribir cargos a mano, se listan los cargos que YA existen en los contactos del
// borrador y la usuaria les pone un número (1, 2, 3…). Cada empresa toma como 1.º contacto al que tenga el cargo con el número más bajo, y así
// sucesivamente (cantera_contacts.prioridad = 1, 2, 3…). Los cargos sin número no se priorizan.
//
// Convive con las otras reglas sin pisarlas:
//  · Una prioridad puesta a mano (prioridad>0 y prioridad_auto=false y prioridad_origen<>'cargo') NUNCA se toca; su número se salta.
//  · Lo asignado aquí queda con prioridad_origen='cargo' y prioridad_auto=false: así «Buyer según la empresa» (canteraBuyerService) lo trata
//    como puesto a mano y no lo revierte; y esta función sí puede recalcularlo cuando cambian los números o llegan contactos nuevos.
//  · Empate (mismo número): gana el contacto que llegó primero.

const _n = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Cargos distintos de los contactos del borrador (con empresa), agrupando variantes de escritura («CEO», «ceo», «C.E.O.»).
async function listarCargos(pool, batchId, uid) {
  const { rows } = await pool.query(
    `SELECT cargo, COUNT(*)::int AS n, COUNT(DISTINCT company_id)::int AS emp
       FROM cantera_contacts WHERE batch_id=$1 AND user_id=$2 AND company_id IS NOT NULL AND COALESCE(cargo,'')<>'' GROUP BY cargo`, [batchId, uid]);
  const by = new Map();
  for (const r of rows) {
    const k = _n(r.cargo); if (!k) continue;
    let g = by.get(k); if (!g) { g = { key: k, label: r.cargo, best: 0, contactos: 0, empresas: 0 }; by.set(k, g); }
    g.contactos += r.n; g.empresas = Math.max(g.empresas, r.emp);   // empresas: aproximación por máximo (el exacto no importa en pantalla)
    if (r.n > g.best) { g.best = r.n; g.label = r.cargo; }
  }
  return [...by.values()].map(({ best, ...g }) => g).sort((a, b) => b.contactos - a.contactos || a.label.localeCompare(b.label));
}

async function asignarPorCargo(pool, batchId, uid) {
  const { rows: [b] } = await pool.query('SELECT cargo_ranks FROM cantera_batches WHERE id=$1 AND user_id=$2', [batchId, uid]);
  const ranks = (b && b.cargo_ranks && typeof b.cargo_ranks === 'object') ? b.cargo_ranks : {};
  const { rows: cts } = await pool.query(
    `SELECT id, company_id, cargo, prioridad, prioridad_auto, prioridad_origen FROM cantera_contacts
      WHERE batch_id=$1 AND user_id=$2 AND company_id IS NOT NULL ORDER BY id`, [batchId, uid]);
  const byCo = new Map();
  for (const c of cts) { if (!byCo.has(c.company_id)) byCo.set(c.company_id, []); byCo.get(c.company_id).push(c); }
  const setIds = [], setPri = [], resetIds = [];
  for (const list of byCo.values()) {
    // Lo que ocupa un número y no es de esta función (a mano, o puesto por otra regla) se respeta y su número se salta.
    const ocupados = new Set(list.filter(c => c.prioridad > 0 && c.prioridad_origen !== 'cargo' && !c.prioridad_auto).map(c => c.prioridad));
    const cand = list.filter(c => !(c.prioridad > 0 && c.prioridad_origen !== 'cargo' && !c.prioridad_auto))   // manuales: fuera
      .map(c => ({ c, r: Number(ranks[_n(c.cargo)]) })).filter(x => x.r > 0)
      .sort((a, z) => a.r - z.r || a.c.id - z.c.id);
    let n = 1; const quedan = new Set();
    for (const x of cand) { while (ocupados.has(n)) n++; setIds.push(x.c.id); setPri.push(n); ocupados.add(n); quedan.add(x.c.id); }
    for (const c of list) if (c.prioridad_origen === 'cargo' && !quedan.has(c.id)) resetIds.push(c.id);
    // En una empresa donde SÍ hay cargos con número, tu elección va primero: lo que «Buyer según la empresa» había puesto en automático se libera
    // y esa regla lo vuelve a calcular después, con los números que queden libres.
    if (cand.length) for (const c of list) if (c.prioridad > 0 && c.prioridad_auto && c.prioridad_origen !== 'cargo' && !quedan.has(c.id)) resetIds.push(c.id);
  }
  if (setIds.length) await pool.query(
    `UPDATE cantera_contacts k SET prioridad=t.p, prioridad_auto=false, prioridad_origen='cargo' FROM unnest($1::int[], $2::int[]) AS t(id, p) WHERE k.id=t.id`, [setIds, setPri]);
  if (resetIds.length) await pool.query(`UPDATE cantera_contacts SET prioridad=0, prioridad_auto=false, prioridad_origen='' WHERE id = ANY($1::int[])`, [resetIds]);
  // Resumen: cuántas empresas ya tienen un 1.º contacto y cuántas siguen sin ninguno.
  const { rows: [s] } = await pool.query(
    `SELECT COUNT(*)::int AS empresas, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM cantera_contacts k WHERE k.company_id=c.id AND k.prioridad=1))::int AS con_primero
       FROM cantera_companies c WHERE c.batch_id=$1 AND c.user_id=$2 AND EXISTS (SELECT 1 FROM cantera_contacts k2 WHERE k2.company_id=c.id)`, [batchId, uid]);
  return { asignados: setIds.length, quitados: resetIds.length, empresasConContactos: s.empresas, empresasConPrimero: s.con_primero, empresasSinPrimero: s.empresas - s.con_primero };
}

module.exports = { listarCargos, asignarPorCargo, claveCargo: _n };
