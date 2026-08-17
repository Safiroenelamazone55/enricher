'use strict';
// ─────────────────────────────────────────────────────────────────────
// Secuencia #15 — insertar "Comentar una publicación" como Paso 1.
//
// El `paso` de un contacto es una POSICIÓN en la lista ordenada por
// (dia, orden, id) — no el id del paso. Crear el comentario con dia=1 NO lo
// deja primero: empata dia/orden con la invitación y desempata por id (el
// nuevo es mayor), así que quedaría segundo. Por eso movemos la invitación
// a Día 2: el día manda en el orden y queda garantizado.
//
// Efecto en los contactos ya enrolados:
//   · 20 en 'terminado'  → no vuelven a aparecer en Tareas. Intactos.
//   · 42 empresas en cola → al convertirlas el contacto arranca en paso 1 = comentario.
//   · 1 activo (830, Juan Tirado) en paso 2 de una secuencia de 1 paso: hoy es
//     huérfano; con 2 pasos volvería a hacer la invitación. Lo cerramos.
//
// Uso: node scripts/seq15_add_comment_step.js [--dry]
// ─────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({ host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { rejectUnauthorized: false } });

const SEQ = 15;
const INVITE_STEP = 46;   // linkedin/invite_nota, hoy en Día 1
const ORPHAN = 830;       // Juan Tirado Agudo — paso 2 sin paso 2

const PROMPT = [
  'Comenta la publicación aportando una observación concreta desde la operativa de fabricación y',
  'distribución de alimentos: planificación de rutas, entregas en frío, mermas, ventanas de reparto',
  'o gestión de flota. Engancha con algo específico que diga el post — un dato, una decisión o un',
  'problema que mencione — y añade un matiz que solo tendría alguien que ha visto por dentro empresas',
  'del sector. Cierra con una pregunta genuina que invite al autor a responder.',
  'No vendas, no menciones herramientas ni servicios, y no elogies de forma genérica.',
].join(' ');

const dry = process.argv.includes('--dry');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const { rows: [inv] } = await cli.query(
      `SELECT id, user_id, sequence_id, dia, orden, canal, accion FROM sequence_steps WHERE id=$1 AND sequence_id=$2`,
      [INVITE_STEP, SEQ]);
    if (!inv) throw new Error(`No encuentro el paso ${INVITE_STEP} en la secuencia ${SEQ}`);
    console.log(`Paso de invitación actual: id=${inv.id} dia=${inv.dia} orden=${inv.orden} ${inv.canal}/${inv.accion}`);

    // Idempotencia: si el paso de comentario ya existe, no lo dupliques.
    const { rows: yaHay } = await cli.query(
      `SELECT id FROM sequence_steps WHERE sequence_id=$1 AND canal='linkedin' AND accion='comentario'`, [SEQ]);
    if (yaHay.length) {
      console.log(`Ya existe un paso de comentario (id=${yaHay[0].id}) — no creo otro.`);
    } else {
      const { rows: [nuevo] } = await cli.query(`
        INSERT INTO sequence_steps (user_id, sequence_id, dia, orden, canal, accion, titulo, plantilla, cond, hora)
        VALUES ($1,$2,1,1,'linkedin','comentario','Comentario en una publicación',$3,'','')
        RETURNING id`, [inv.user_id, SEQ, PROMPT]);
      console.log(`✓ Paso de comentario creado: id=${nuevo.id} (Día 1, posición 1)`);
    }

    // La invitación pasa a Día 2 — así el orden queda garantizado por el día.
    await cli.query(`UPDATE sequence_steps SET dia=2, orden=2 WHERE id=$1`, [INVITE_STEP]);
    console.log(`✓ Invitación (id=${INVITE_STEP}) movida a Día 2`);

    // El huérfano ya hizo la invitación: cerrarlo para que no la repita.
    const r = await cli.query(
      `UPDATE lm_contact_sequences SET estado='terminado'
        WHERE sequence_id=$1 AND contact_id=$2 AND estado='activo'`, [SEQ, ORPHAN]);
    console.log(`✓ Contacto ${ORPHAN} cerrado (filas: ${r.rowCount})`);

    const { rows: fin } = await cli.query(
      `SELECT id, dia, orden, canal, accion, titulo FROM sequence_steps
        WHERE sequence_id=$1 ORDER BY dia ASC, orden ASC, id ASC`, [SEQ]);
    console.log('\nOrden final de la secuencia:');
    fin.forEach((s, i) => console.log(`  Paso ${i + 1}: id=${s.id} Día ${s.dia} · ${s.canal}/${s.accion} · ${s.titulo}`));

    if (dry) { await cli.query('ROLLBACK'); console.log('\nDRY RUN — nada se guardó.'); }
    else     { await cli.query('COMMIT');   console.log('\nGuardado.'); }
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
