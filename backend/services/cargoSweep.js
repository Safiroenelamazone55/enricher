'use strict';
// Limpieza segura del CARGO de los contactos: quita «at Empresa…», «| Empresa», «@ Empresa» y el nombre de la empresa (que viene pegado del perfil de
// LinkedIn y se queda desactualizado cuando se corrige el nombre de la empresa). El texto original se guarda en raw['Cargo original'].
const { limpiarCargo } = require('./cargoNormalService');

async function run(pool) {
  let n = 0;
  for (const t of [{ tabla: 'lm_contacts', emp: 'empresa_nombre' }, { tabla: 'cantera_contacts', emp: null }]) {
    try {
      const q = t.emp
        ? `SELECT id, cargo, ${t.emp} AS emp, raw FROM lm_contacts WHERE cargo ~* '(\s+at\s+|\s[|@]\s)' LIMIT 2000`
        : `SELECT k.id, k.cargo, c.nombre AS emp, k.raw FROM cantera_contacts k LEFT JOIN cantera_companies c ON c.id=k.company_id WHERE k.cargo ~* '(\s+at\s+|\s[|@]\s)' LIMIT 2000`;
      const { rows } = await pool.query(q);
      for (const r of rows) {
        const nuevo = limpiarCargo(r.cargo, r.emp, { seguro: true });
        if (!nuevo || nuevo === r.cargo) continue;
        const raw = (r.raw && typeof r.raw === 'object') ? r.raw : {};
        if (!raw['Cargo original']) raw['Cargo original'] = r.cargo;
        await pool.query(`UPDATE ${t.tabla} SET cargo=$1, raw=$2::jsonb WHERE id=$3`, [nuevo, JSON.stringify(raw), r.id]); n++;
      }
    } catch (e) { console.warn('[cargo-sweep]', t.tabla, e.message); }
  }
  if (n) console.log(`[cargo-sweep] ${n} cargo(s) limpiados`);
  return n;
}
module.exports = { run };
