'use strict';
// ─────────────────────────────────────────────────────────────────────
// Secuencia aparte de UN paso: "Comentario post-invitación".
//
// Para los 21 contactos de la secuencia #15 que ya tienen la invitación enviada
// (están en 'terminado'). No se pueden reabrir en la #15: al marcar el comentario
// como hecho avanzarían al Paso 2 y les saldría la invitación por segunda vez.
// Con una secuencia de un solo paso, al completarlo el contacto pasa a
// 'terminado' y no hay siguiente paso que disparar.
//
// Hereda cliente/campaña/zona horaria/días de envío de la #15. send_mode='manual'
// y sin pasos de email → el motor de envío no toca nada de esto.
//
// Uso: node scripts/seq_comentario_post_invitacion.js [--dry]
// ─────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({ host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { rejectUnauthorized: false } });

const ORIGEN = 15;
const NOMBRE = 'ES | T1A | Comentario post-invitación';

const PROMPT = [
  'A este contacto ya se le envió la invitación de LinkedIn y todavía no la acepta.',
  'El objetivo del comentario es aparecer en su feed con algo que valga la pena leer,',
  'para que reconozca el nombre cuando revise la solicitud pendiente.',
  'Comenta aportando una observación concreta desde la operativa de fabricación y distribución',
  'de alimentos: planificación de rutas, entregas en frío, mermas, ventanas de reparto o gestión',
  'de flota. Engancha con algo específico que diga la publicación — un dato, una decisión o un',
  'problema que mencione — y añade un matiz que solo tendría alguien que ha visto por dentro',
  'empresas del sector. Cierra con una pregunta genuina que invite al autor a responder.',
  'No vendas, no menciones herramientas ni servicios, no elogies de forma genérica,',
  'y NO menciones la invitación pendiente.',
].join(' ');

const dry = process.argv.includes('--dry');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const { rows: [src] } = await cli.query(
      `SELECT user_id, outbound_client_id, campaign_id, timezone, send_days, mercado, icp
         FROM sequences WHERE id=$1`, [ORIGEN]);
    if (!src) throw new Error(`No existe la secuencia ${ORIGEN}`);

    // Los que ya recibieron la invitación en la #15 (todos quedaron en 'terminado').
    const { rows: cts } = await cli.query(
      `SELECT cs.contact_id, k.nombre, k.apellido, k.empresa_nombre
         FROM lm_contact_sequences cs JOIN lm_contacts k ON k.id = cs.contact_id
        WHERE cs.sequence_id=$1 AND cs.estado='terminado'
        ORDER BY cs.contact_id`, [ORIGEN]);
    console.log(`Contactos con invitación ya enviada en #${ORIGEN}: ${cts.length}`);
    if (!cts.length) throw new Error('No hay contactos que enrolar');

    // Idempotencia: no crear dos veces la misma secuencia.
    let { rows: [seq] } = await cli.query(
      `SELECT id FROM sequences WHERE user_id=$1 AND nombre=$2`, [src.user_id, NOMBRE]);
    if (seq) {
      console.log(`La secuencia "${NOMBRE}" ya existe (id=${seq.id}) — reuso.`);
    } else {
      ({ rows: [seq] } = await cli.query(`
        INSERT INTO sequences (user_id, outbound_client_id, campaign_id, nombre, objetivo, estado,
                               timezone, send_days, mercado, icp, send_mode, starts_on)
        VALUES ($1,$2,$3,$4,$5,'activa',$6,$7,$8,$9,'manual',CURRENT_DATE)
        RETURNING id`,
        [src.user_id, src.outbound_client_id, src.campaign_id, NOMBRE,
         'Comentar una publicación de contactos que ya tienen la invitación enviada y pendiente de aceptar.',
         src.timezone, src.send_days, src.mercado, src.icp]));
      console.log(`✓ Secuencia creada: id=${seq.id} · "${NOMBRE}"`);
    }

    const { rows: pasos } = await cli.query(
      `SELECT id FROM sequence_steps WHERE sequence_id=$1`, [seq.id]);
    if (pasos.length) {
      console.log(`  Ya tiene ${pasos.length} paso(s) — no creo otro.`);
    } else {
      const { rows: [p] } = await cli.query(`
        INSERT INTO sequence_steps (user_id, sequence_id, dia, orden, canal, accion, titulo, plantilla, cond, hora)
        VALUES ($1,$2,1,1,'linkedin','comentario','Comentario en una publicación',$3,'','')
        RETURNING id`, [src.user_id, seq.id, PROMPT]);
      console.log(`✓ Paso único creado: id=${p.id} · Día 1 · LinkedIn / Comentar una publicación`);
    }

    let n = 0;
    for (const c of cts) {
      const r = await cli.query(`
        INSERT INTO lm_contact_sequences (user_id, contact_id, sequence_id, paso, estado, start_date, paso_date, next_action_at)
        VALUES ($1,$2,$3,1,'activo',CURRENT_DATE,CURRENT_DATE,NOW())
        ON CONFLICT (contact_id, sequence_id) DO NOTHING`, [src.user_id, c.contact_id, seq.id]);
      n += r.rowCount;
    }
    console.log(`✓ Contactos enrolados: ${n} (de ${cts.length}; el resto ya estaba)`);

    const { rows: fin } = await cli.query(
      `SELECT estado, paso, count(*)::int c FROM lm_contact_sequences
        WHERE sequence_id=$1 GROUP BY estado, paso`, [seq.id]);
    console.log('\nEstado final de la secuencia nueva:');
    fin.forEach(f => console.log(`  ${f.estado} paso ${f.paso} → ${f.c}`));
    console.log('\nPrimeros 5 contactos:');
    cts.slice(0, 5).forEach(c => console.log(`  ${c.contact_id} · ${c.nombre} ${c.apellido} · ${c.empresa_nombre}`));

    if (dry) { await cli.query('ROLLBACK'); console.log('\nDRY RUN — nada se guardó.'); }
    else     { await cli.query('COMMIT');   console.log('\nGuardado.'); }
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
