'use strict';
// Exclusiones AUTOMÁTICAS por deals (pedido 2026-10-29): si una empresa tiene un deal en curso con un cliente (Reunión, Propuesta,
// Negociación) o ya fue ganado, esa empresa se excluye SOLO para ese cliente: así nadie más de la empresa entra en una de sus secuencias.
//  · Deal perdido  → la exclusión se libera pasados DEAL_ESPERA_DIAS (para no volver a escribirles al día siguiente de un «no»).
//  · Deal ganado   → la exclusión se queda (la empresa ya es cliente).
//  · Al crearla se PAUSA lo que ya estuviera en marcha para esa empresa y cliente.
//  · Al liberarla se REANUDA lo que se había pausado por esa exclusión (si ninguna otra sigue aplicando).
//  · No pisa las exclusiones manuales, y si la quitas a mano mientras el deal sigue vivo, no vuelve a crearse.
const excl = require('./exclusions');

const DEAL_ESPERA_DIAS = 90;
let _ready = false;

async function ensure(pool) {
  if (_ready) return;
  await pool.query(`ALTER TABLE lm_exclusions ADD COLUMN IF NOT EXISTS auto_origen TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE lm_exclusions ADD COLUMN IF NOT EXISTS auto_company_id INTEGER`);
  await pool.query(`ALTER TABLE lm_exclusions ADD COLUMN IF NOT EXISTS auto_release_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lm_deal_excl_off (user_id INTEGER NOT NULL, outbound_client_id INTEGER NOT NULL, company_id INTEGER NOT NULL, PRIMARY KEY (user_id, outbound_client_id, company_id))`);
  _ready = true;
}

// ¿Es un deal real? (mismo criterio que el tablero de Deals)
const DEAL_SQL = `(k.deal_valor IS NOT NULL OR k.deal_cierre IS NOT NULL OR k.reunion_agendada_at IS NOT NULL OR k.disposition='reunion'
                   OR k.estado IN ('propuesta','negociacion','ganado')
                   OR EXISTS (SELECT 1 FROM activities a WHERE a.contact_id=k.id AND a.tipo='reunion'))`;

async function sync(pool, uid) {
  await ensure(pool);
  const { rows: deals } = await pool.query(
    `SELECT k.id, k.nombre, k.apellido, k.estado, k.outbound_client_id AS client_id, k.company_id,
            co.nombre AS co_nombre, co.dominio, co.website, co.linkedin, co.ciudad, co.pais
       FROM lm_contacts k JOIN lm_companies co ON co.id = k.company_id
      WHERE k.user_id=$1 AND k.outbound_client_id IS NOT NULL AND k.company_id IS NOT NULL AND ${DEAL_SQL}`, [uid]);
  const groups = new Map();   // "cliente:empresa" → { client, company, activos[], perdidos[] }
  for (const d of deals) {
    const key = d.client_id + ':' + d.company_id;
    const g = groups.get(key) || { client: d.client_id, company: d.company_id, co: d, activos: [], perdidos: [] };
    const nm = [d.nombre, d.apellido].filter(Boolean).join(' ');
    if (d.estado === 'perdido') g.perdidos.push(nm); else g.activos.push({ nm, etapa: d.estado === 'propuesta' ? 'Propuesta' : d.estado === 'negociacion' ? 'Negociación' : d.estado === 'ganado' ? 'Ganado' : 'Reunión' });
    groups.set(key, g);
  }
  const { rows: autos } = await pool.query(`SELECT * FROM lm_exclusions WHERE user_id=$1 AND auto_origen='deal'`, [uid]);
  const autoBy = new Map(autos.map(e => [e.outbound_client_id + ':' + e.auto_company_id, e]));
  const off = new Set((await pool.query(`SELECT outbound_client_id, company_id FROM lm_deal_excl_off WHERE user_id=$1`, [uid])).rows.map(r => r.outbound_client_id + ':' + r.company_id));
  const created = [], released = [];
  const manualCache = new Map();

  for (const [key, g] of groups) {
    const ex = autoBy.get(key);
    if (g.activos.length) {
      const a = g.activos[0], etapa = g.activos.some(x => x.etapa === 'Ganado') ? 'Ganado' : a.etapa;
      const nota = `Automática · deal ${etapa}: ${g.activos.map(x => x.nm).join(', ')}`;
      if (ex) { await pool.query(`UPDATE lm_exclusions SET auto_release_at=NULL, nota=$2, categoria=$3 WHERE id=$1`, [ex.id, nota, 'Deal en curso · automática']); continue; }
      if (off.has(key)) continue;   // la quitaste a mano con el deal vivo: se respeta
      // Si ya hay una exclusión manual que cubre esta empresa para este cliente, no se duplica.
      if (!manualCache.has(g.client)) manualCache.set(g.client, await excl.loadApplicable(pool, uid, { clientId: g.client }));
      const co = { nombre: g.co.co_nombre, dominio: g.co.dominio, website: g.co.website, linkedin: g.co.linkedin, ciudad: g.co.ciudad };
      if (manualCache.get(g.client).some(e => !e.auto_origen && excl.matchCompany(e, co))) continue;
      const k = excl.keysOf({ nombre: g.co.co_nombre, dominio: g.co.dominio, website: g.co.website, linkedin: g.co.linkedin, ciudad: g.co.ciudad });
      const ins = await pool.query(
        `INSERT INTO lm_exclusions (user_id,nombre,nombre_norm,dominio,dominios_extra,linkedin_slug,ciudad,ciudad_norm,pais,motivo,lista,scope,outbound_client_id,website,categoria,nota,match_dominio,auto_origen,auto_company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Deal en curso','Deals','cliente',$10,$11,$12,$13,TRUE,'deal',$14) RETURNING *`,
        [uid, g.co.co_nombre, k.nombre_norm, k.dominio, k.dominios_extra || [], k.linkedin_slug, g.co.ciudad || '', k.ciudad_norm, g.co.pais || '', g.client, g.co.website || '', 'Deal en curso · automática', nota, g.company]);
      created.push(ins.rows[0]);
    } else {
      await pool.query(`DELETE FROM lm_deal_excl_off WHERE user_id=$1 AND outbound_client_id=$2 AND company_id=$3`, [uid, g.client, g.company]);   // sin deal vivo: se olvida el «quitada a mano»
    }
    if (!g.activos.length && ex) {
      // Solo quedan deals perdidos: se libera tras la espera.
      if (!ex.auto_release_at) await pool.query(`UPDATE lm_exclusions SET auto_release_at = NOW() + ($2 || ' days')::interval, nota=$3 WHERE id=$1`, [ex.id, String(DEAL_ESPERA_DIAS), `Automática · deal perdido: se libera en ${DEAL_ESPERA_DIAS} días`]);
      else if (new Date(ex.auto_release_at) <= new Date()) released.push(ex);
    }
  }
  // Exclusiones automáticas cuyo deal ya no existe (se eliminó): también se programa su liberación.
  for (const ex of autos) {
    if (groups.has(ex.outbound_client_id + ':' + ex.auto_company_id)) continue;
    if (!ex.auto_release_at) await pool.query(`UPDATE lm_exclusions SET auto_release_at = NOW() + ($2 || ' days')::interval, nota=$3 WHERE id=$1`, [ex.id, String(DEAL_ESPERA_DIAS), `Automática · el deal ya no existe: se libera en ${DEAL_ESPERA_DIAS} días`]);
    else if (new Date(ex.auto_release_at) <= new Date()) released.push(ex);
  }
  let paused = null;
  if (created.length) paused = await excl.pauseExistingFor(pool, uid, created);
  let resumed = 0;
  for (const ex of released) resumed += await release(pool, uid, ex);
  return { creadas: created.length, liberadas: released.length, pausados: paused ? paused.paused : 0, reanudados: resumed };
}

// Quita la exclusión automática y reanuda lo que ella había pausado (si ninguna otra exclusión sigue aplicando).
async function release(pool, uid, ex) {
  await pool.query(`DELETE FROM lm_exclusions WHERE id=$1 AND user_id=$2`, [ex.id, uid]);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.contact_id, cs.sequence_id, s.outbound_client_id
       FROM lm_contact_sequences cs JOIN sequences s ON s.id = cs.sequence_id JOIN lm_contacts k ON k.id = cs.contact_id
      WHERE cs.user_id=$1 AND cs.estado='pausado' AND cs.paused_reason='excluida' AND s.outbound_client_id=$2 AND k.company_id=$3`, [uid, ex.outbound_client_id, ex.auto_company_id]);
  let n = 0;
  for (const r of rows) {
    const aun = await excl.isEnrollmentExcluded(pool, { user_id: uid, sequence_id: r.sequence_id, outbound_client_id: r.outbound_client_id, contact_id: r.contact_id });
    if (aun) continue;
    await pool.query(`UPDATE lm_contact_sequences SET estado='activo', paused_reason='' WHERE id=$1`, [r.id]); n++;
  }
  return n;
}

// Para sync inmediato tras un cambio (con pausa de 4 s para agrupar varios cambios seguidos)
const _timers = new Map();
function syncSoon(pool, uid) {
  if (_timers.has(uid)) return;
  _timers.set(uid, setTimeout(() => { _timers.delete(uid); sync(pool, uid).catch(e => console.warn('[deal-excl]', e.message)); }, 4000));
}
// Todos los workspaces (cada hora y al arrancar)
async function syncAll(pool) {
  try { await ensure(pool); const { rows } = await pool.query(`SELECT DISTINCT user_id FROM lm_contacts WHERE outbound_client_id IS NOT NULL AND company_id IS NOT NULL`); for (const r of rows) { try { await sync(pool, r.user_id); } catch (e) { console.warn('[deal-excl]', e.message); } } }
  catch (e) { console.warn('[deal-excl] syncAll', e.message); }
}
// Si quitas a mano una exclusión automática mientras el deal sigue vivo, que no vuelva a crearse
async function rememberManualRemoval(pool, uid, ids) {
  await ensure(pool);
  await pool.query(`INSERT INTO lm_deal_excl_off (user_id, outbound_client_id, company_id)
     SELECT user_id, outbound_client_id, auto_company_id FROM lm_exclusions WHERE user_id=$1 AND id = ANY($2::int[]) AND auto_origen='deal' AND outbound_client_id IS NOT NULL AND auto_company_id IS NOT NULL AND auto_release_at IS NULL
     ON CONFLICT DO NOTHING`, [uid, ids]);
}

module.exports = { sync, syncSoon, syncAll, rememberManualRemoval, DEAL_ESPERA_DIAS };
