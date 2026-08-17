'use strict';
// ─────────────────────────────────────────────────────────────────────
// Reescribe la instrucción de los pasos de comentario (#15 y #17).
//
// La versión anterior fijaba el tema (rutas, entregas en frío, mermas…) y eso
// produce comentarios que desencajan cuando la publicación va de otra cosa —
// un logro personal, una opinión, una noticia. La instrucción del paso ahora
// solo aporta el CONTEXTO (por qué se comenta); el largo, el tono y el
// "adáptate a lo que sea el post" los impone el prompt de sistema del backend.
//
// Uso: node scripts/reprompt_comment_steps.js [--dry]
// ─────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({ host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { rejectUnauthorized: false } });

const PROMPTS = {
  // #15 · Paso 1 — el comentario va ANTES de la invitación.
  48: [
    'Comento para acercarme a esta persona antes de mandarle la invitación de conexión,',
    'para que cuando le llegue no sea completamente en frío.',
    'El comentario tiene que encajar con la publicación sea del tema que sea:',
    'si es un logro o una buena noticia, felicítalo por algo concreto de lo que consiguió;',
    'si es una opinión, opina; si cuenta un problema o un aprendizaje, reacciona a eso.',
    'No fuerces temas de mi trabajo ni del sector: el objetivo es que me note, no demostrar nada.',
  ].join(' '),
  // #17 · paso único — la invitación YA se envió y está pendiente de aceptar.
  50: [
    'A esta persona ya le envié la invitación de conexión y todavía no la acepta.',
    'Comento para aparecer en su feed con algo que valga la pena leer, y que reconozca mi nombre',
    'cuando revise la solicitud pendiente.',
    'El comentario tiene que encajar con la publicación sea del tema que sea:',
    'si es un logro o una buena noticia, felicítalo por algo concreto de lo que consiguió;',
    'si es una opinión, opina; si cuenta un problema o un aprendizaje, reacciona a eso.',
    'No fuerces temas de mi trabajo ni del sector, y NO menciones la invitación pendiente.',
  ].join(' '),
};

const dry = process.argv.includes('--dry');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    for (const [id, texto] of Object.entries(PROMPTS)) {
      const { rows: [prev] } = await cli.query(
        `SELECT s.id, s.sequence_id, s.canal, s.accion, q.nombre AS seq, s.plantilla
           FROM sequence_steps s JOIN sequences q ON q.id = s.sequence_id WHERE s.id=$1`, [id]);
      if (!prev) { console.log(`⚠ Paso ${id} no existe — lo salto.`); continue; }
      if (prev.canal !== 'linkedin' || prev.accion !== 'comentario') {
        throw new Error(`El paso ${id} no es linkedin/comentario (es ${prev.canal}/${prev.accion}) — abortando por seguridad`);
      }
      await cli.query(`UPDATE sequence_steps SET plantilla=$1 WHERE id=$2`, [texto, id]);
      console.log(`\n✓ Paso ${id} · secuencia #${prev.sequence_id} "${prev.seq}"`);
      console.log(`  antes  (${prev.plantilla.length} car.): ${prev.plantilla.slice(0, 90)}…`);
      console.log(`  ahora  (${texto.length} car.): ${texto.slice(0, 90)}…`);
    }
    if (dry) { await cli.query('ROLLBACK'); console.log('\nDRY RUN — nada se guardó.'); }
    else     { await cli.query('COMMIT');   console.log('\nGuardado.'); }
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
