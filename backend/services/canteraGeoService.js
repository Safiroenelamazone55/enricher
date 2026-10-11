'use strict';
// Muchas listas (p. ej. Sales Navigator) traen la ubicación de la PERSONA pero no la de la empresa. Cuando la empresa no tiene país/ciudad
// (vacío o "N/A"), se deduce de la ubicación más frecuente de sus contactos: "Alicante, Valencian Community, Spain" → ciudad Alicante, país Spain;
// "Greater Murcia Metropolitan Area" → ciudad Murcia. Nunca pisa un dato real de la empresa.

const _vacio = v => !String(v || '').trim() || /^n\/?a$/i.test(String(v).trim()) || String(v).trim() === '—';

function parseUbicacion(ub) {
  const s = String(ub || '').trim();
  if (_vacio(s)) return { ciudad: '', pais: '' };
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { ciudad: parts[0], pais: parts[parts.length - 1] };
  const m = /^Greater\s+(.+?)(?:\s+Metropolitan)?\s+Area$/i.exec(s) || /^(.+?)\s+Metropolitan\s+Area$/i.exec(s) || /^(.+?)\s+Area$/i.exec(s);
  if (m) return { ciudad: m[1].trim(), pais: '' };
  // Un solo término: normalmente un país ("Spain"); si no se puede saber, se deja como país.
  return { ciudad: '', pais: s };
}

async function derivarUbicacion(pool, batchId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.pais, c.ciudad, c.ubicacion,
           (SELECT k.ubicacion FROM cantera_contacts k
             WHERE k.company_id=c.id AND COALESCE(k.ubicacion,'') NOT IN ('', 'N/A')
             GROUP BY k.ubicacion ORDER BY COUNT(*) DESC, k.ubicacion LIMIT 1) AS ub
      FROM cantera_companies c WHERE c.batch_id=$1`, [batchId]);
  let actualizadas = 0;
  for (const r of rows) {
    if (!r.ub) continue;
    const { ciudad, pais } = parseUbicacion(r.ub);
    const nuevoPais = _vacio(r.pais) ? pais : null;
    const nuevaCiudad = _vacio(r.ciudad) ? ciudad : null;
    const nuevaUb = _vacio(r.ubicacion) ? r.ub : null;
    if (!nuevoPais && !nuevaCiudad && !nuevaUb) continue;
    await pool.query(
      `UPDATE cantera_companies SET pais=COALESCE($1, pais), ciudad=COALESCE($2, ciudad), ubicacion=COALESCE($3, ubicacion) WHERE id=$4`,
      [nuevoPais || null, nuevaCiudad || null, nuevaUb, r.id]);
    actualizadas++;
  }
  return { empresas: rows.length, actualizadas };
}

module.exports = { derivarUbicacion, parseUbicacion };
