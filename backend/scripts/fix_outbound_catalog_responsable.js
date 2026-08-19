'use strict';
// One-off: asigna el responsable del proyecto a las plantillas del catálogo outbound
// y a las tareas ya generadas que quedaron sin nadie asignado (por eso el filtro
// "solo mis tareas" las escondía). El endpoint /outbound-link ya quedó corregido para
// que esto no vuelva a pasar en futuros vínculos.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({ host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: u.pathname.slice(1), ssl: { rejectUnauthorized: false } });

const dry = process.argv.includes('--dry');

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: projs } = await cli.query(
      `SELECT DISTINCT p.id, p.nombre, p.responsable, p.responsables FROM projects p
        JOIN project_recur_subtasks r ON r.project_id = p.id WHERE r.origen='outbound_catalog'`);
    for (const p of projs) {
      const responsable = p.responsable || '';
      const responsables = (p.responsables && p.responsables.length) ? p.responsables : (responsable ? [responsable] : []);
      if (!responsable) { console.log(`Proyecto #${p.id} "${p.nombre}" no tiene responsable — se salta.`); continue; }
      const t1 = await cli.query(
        `UPDATE project_recur_subtasks SET responsable=$1, responsables=$2
          WHERE project_id=$3 AND origen='outbound_catalog' AND (responsable='' OR responsable IS NULL)`,
        [responsable, responsables, p.id]);
      const t2 = await cli.query(
        `UPDATE tasks SET responsable=$1, responsables=$2
          WHERE recur_template_id IN (SELECT id FROM project_recur_subtasks WHERE project_id=$3 AND origen='outbound_catalog')
            AND (responsable='' OR responsable IS NULL)`,
        [responsable, responsables, p.id]);
      console.log(`Proyecto #${p.id} "${p.nombre}" → responsable "${responsable}": ${t1.rowCount} plantilla(s), ${t2.rowCount} tarea(s) ya generadas.`);
    }
    if (dry) { await cli.query('ROLLBACK'); console.log('\nDRY RUN — nada se guardó.'); }
    else     { await cli.query('COMMIT');   console.log('\nGuardado.'); }
  } catch (e) { await cli.query('ROLLBACK'); throw e; }
  finally { cli.release(); await pool.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
