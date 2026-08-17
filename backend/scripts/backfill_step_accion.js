'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const url = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: url.hostname,
  port: parseInt(url.port, 10) || 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  ssl: { rejectUnauthorized: false },
});

// Solo canales con lista de Acción del paso en el frontend (_ACCIONES). 'task' no tiene.
function guessAccion(canal, idx, len) {
  if (canal === 'email') {
    if (idx === 0) return 'inicial';
    if (idx === len - 1 && len > 1) return 'cierre';
    return 'seguimiento';
  }
  if (canal === 'linkedin') return idx === 0 ? 'invite_nota' : 'mensaje';
  if (canal === 'whatsapp') return 'mensaje';
  if (canal === 'call') return 'llamada';
  return null;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, sequence_id, dia, canal, orden, accion
    FROM sequence_steps
    ORDER BY sequence_id, dia, orden, id
  `);

  const bySeq = new Map();
  for (const r of rows) {
    if (!bySeq.has(r.sequence_id)) bySeq.set(r.sequence_id, []);
    bySeq.get(r.sequence_id).push(r);
  }

  const updates = []; // {id, accion}
  const counts = {};

  for (const [seqId, steps] of bySeq) {
    const byCanal = new Map();
    for (const s of steps) {
      if (!byCanal.has(s.canal)) byCanal.set(s.canal, []);
      byCanal.get(s.canal).push(s);
    }
    for (const [canal, group] of byCanal) {
      group.forEach((s, idx) => {
        if (s.accion && s.accion.trim() !== '') return; // ya tiene Acción — no tocar
        const guess = guessAccion(canal, idx, group.length);
        if (!guess) return; // canal sin lista de acciones (ej. task)
        updates.push({ id: s.id, accion: guess });
        counts[canal] = (counts[canal] || 0) + 1;
      });
    }
  }

  console.log(`Pasos totales: ${rows.length}`);
  console.log(`Pasos a actualizar: ${updates.length}`);
  console.log('Por canal:', counts);

  const dry = process.argv.includes('--dry');
  if (dry) {
    console.log('DRY RUN — no se escribió nada. Ejemplos:', updates.slice(0, 15));
  } else {
    for (const u of updates) {
      await pool.query(`UPDATE sequence_steps SET accion = $1 WHERE id = $2 AND (accion IS NULL OR accion = '')`, [u.accion, u.id]);
    }
    console.log('Listo — escrito en la base de datos.');
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
