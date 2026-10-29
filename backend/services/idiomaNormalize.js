'use strict';
// Unifica los nombres de idioma guardados: «Inglese», «English» y «Inglés» pasan a ser «Inglés» (y así para italiano, portugués, francés, alemán, catalán…).
// Corre al arrancar y cada hora; solo toca lo que realmente cambia. Así los grupos, los filtros y los mensajes por idioma ven un solo nombre.
const geo = require('./geoService');

async function run(pool) {
  let cambios = 0;
  for (const tabla of ['lm_contacts', 'cantera_contacts']) {
    try {
      const { rows } = await pool.query(`SELECT DISTINCT idioma FROM ${tabla} WHERE COALESCE(idioma,'') <> ''`);
      for (const r of rows) {
        const n = geo.normalizeLanguage(r.idioma);
        if (n && n !== r.idioma) { const u = await pool.query(`UPDATE ${tabla} SET idioma=$1 WHERE idioma=$2`, [n, r.idioma]); cambios += u.rowCount || 0; }
      }
      // Lista de idiomas del contacto (principal, 2.º, 3.º, 4.º…): [{idioma, nivel}]
      const { rows: js } = await pool.query(`SELECT id, idiomas FROM ${tabla} WHERE idiomas IS NOT NULL AND jsonb_typeof(idiomas)='array' AND jsonb_array_length(idiomas) > 0`);
      for (const r of js) {
        let changed = false;
        const arr = r.idiomas.map(x => {
          if (x && typeof x === 'object' && x.idioma) { const n = geo.normalizeLanguage(x.idioma); if (n && n !== x.idioma) { changed = true; return Object.assign({}, x, { idioma: n }); } }
          else if (typeof x === 'string') { const n = geo.normalizeLanguage(x); if (n && n !== x) { changed = true; return n; } }
          return x;
        });
        if (changed) { await pool.query(`UPDATE ${tabla} SET idiomas=$1::jsonb WHERE id=$2`, [JSON.stringify(arr), r.id]); cambios++; }
      }
    } catch (e) { console.warn('[idiomas]', tabla, e.message); }
  }
  if (cambios) console.log(`[idiomas] ${cambios} registro(s) unificados`);
  return cambios;
}
module.exports = { run };
