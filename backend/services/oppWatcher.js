// Seguimiento de oportunidades: el CLIENTE hace el seguimiento, Nova se lo recuerda por correo (no le redacta el mensaje).
// Plazos en días hábiles: aviso a los 3, 7 y 14 días sin actividad; a los 21 sugiere cerrar / "más adelante".
// Reunión ya pasada sin resultado → aviso. Un solo correo por cuenta del portal y día.
// APAGADO por defecto: solo envía si OPP_WATCHER_SEND=1 (Jenny quiere revisar primero el mensaje; ver preview()).
const TH = [3, 7, 14, 21];
const CLOSED_DISPO = ['no_interesado', 'no_califica', 'no_contactar', 'derivado', 'no_es_persona', 'mas_adelante'];

function bizDays(from, to) {
  let n = 0; const d = new Date(from); d.setHours(0, 0, 0, 0); const e = new Date(to); e.setHours(0, 0, 0, 0);
  while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const fmtD = (d, lang) => new Date(d).toLocaleDateString(lang === 'es' ? 'es-ES' : lang === 'pt' ? 'pt-BR' : lang === 'de' ? 'de-DE' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });

// Oportunidades abiertas de un cliente con lo que les falta (reunión sin resultado / días sin actividad).
async function pending(pool, cid) {
  const { rows } = await pool.query(`
    SELECT k.id, k.user_id, k.nombre, k.apellido, COALESCE(NULLIF(co.nombre,''),k.empresa_nombre) AS empresa, k.deal_cierre, k.opp_reunion_estado, k.opp_avisos, k.opp_snooze_until,
           GREATEST(COALESCE((SELECT MAX(a.fecha) FROM activities a WHERE a.contact_id=k.id AND a.estado='hecha' AND a.tipo NOT IN ('seguimiento_aviso','disposition_change')), 'epoch'),
                    COALESCE(k.deal_cierre::timestamptz,'epoch'), COALESCE(k.reunion_agendada_at,'epoch')) AS ultimo
      FROM lm_contacts k LEFT JOIN lm_companies co ON co.id=k.company_id
     WHERE k.outbound_client_id=$1 AND COALESCE(k.estado,'') NOT IN ('ganado','perdido') AND COALESCE(k.disposition,'') <> ALL($2)
       AND (k.disposition='reunion' OR k.deal_cierre IS NOT NULL OR k.estado IN ('propuesta','negociacion'))`, [cid, CLOSED_DISPO]);
  const now = new Date(), out = [];
  for (const k of rows) {
    if (k.opp_snooze_until && new Date(k.opp_snooze_until) > now) continue;
    const dias = bizDays(k.ultimo, now);
    let kind = null;
    if (k.deal_cierre && !k.opp_reunion_estado && new Date(k.deal_cierre) <= now && k.opp_avisos === 0) kind = 'reunion';
    else if (k.opp_avisos < TH.length && dias >= TH[k.opp_avisos]) kind = k.opp_avisos === 3 ? 'cierre' : 'dias';
    if (kind) out.push({ ...k, kind, dias, nombre: [k.nombre, k.apellido].filter(Boolean).join(' ') });
  }
  return out;
}

function itemsFor(items, lang) {
  return items.map(i => ({ kind: i.kind === 'reunion' ? 'reunion' : 'dias', nombre: i.nombre, empresa: i.empresa, dias: i.dias,
    fecha: i.deal_cierre ? fmtD(i.deal_cierre, lang) : '', ultimo: fmtD(i.ultimo, lang) }));
}

// Vista previa EXACTA del correo (sin enviar ni marcar nada).
async function preview(pool, cid, lang) {
  const pr = require('./portalRoutes');
  const { rows: [c] } = await pool.query(`SELECT nombre FROM outbound_clients WHERE id=$1`, [cid]);
  const items = await pending(pool, cid);
  const m = require('./portalMail').build('followup', lang || 'es', { cliente: c.nombre, url: 'https://app.novacentrax.com/portal/' + pr.slugOf(c.nombre), items: itemsFor(items, lang || 'es'), brand: {} });
  return { subject: m.subject, html: m.html, text: m.text, n: items.length, items: items.map(i => ({ id: i.id, nombre: i.nombre, empresa: i.empresa, kind: i.kind, dias: i.dias })) };
}

async function tick(pool, force) {
  if (process.env.OPP_WATCHER_SEND !== '1') return { skipped: 'apagado (OPP_WATCHER_SEND != 1)' };
  const pr = require('./portalRoutes');
  const { rows: cls } = await pool.query(`SELECT DISTINCT a.outbound_client_id AS id, oc.timezone FROM client_accounts a JOIN outbound_clients oc ON oc.id=a.outbound_client_id WHERE a.activo`);
  let sent = 0;
  for (const c of cls) {
    // Horario laboral (8–17, lun–vie) en la zona horaria del cliente; sin definir → Nueva York.
    let loc; try { loc = new Date(new Date().toLocaleString('en-US', { timeZone: c.timezone || 'America/New_York' })); } catch (_) { loc = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
    if (!force && (loc.getDay() === 0 || loc.getDay() === 6 || loc.getHours() < 8 || loc.getHours() >= 17)) continue;
    const items = await pending(pool, c.id); if (!items.length) continue;
    const { rows: accs } = await pool.query(`SELECT a.email, a.lang, a.sections, oc.nombre AS cliente FROM client_accounts a JOIN outbound_clients oc ON oc.id=a.outbound_client_id WHERE a.outbound_client_id=$1 AND a.activo`, [c.id]);
    let ok = false;
    for (const a of accs) {
      if (a.sections && a.sections.reuniones === false) continue;
      const lang = a.lang || 'es';
      try {
        await pr.sendClientMail(c.id, 'followup', lang, { to: a.email, cliente: a.cliente, url: 'https://app.novacentrax.com/portal/' + pr.slugOf(a.cliente), items: itemsFor(items, lang) });
        ok = true; sent++;
      } catch (e) { console.warn('[opp-watcher] envío', a.email, e.message); }
    }
    if (!ok) continue;
    for (const i of items) {
      await pool.query(`UPDATE lm_contacts SET opp_avisos=opp_avisos+1 WHERE id=$1`, [i.id]);
      await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'seguimiento_aviso',$4,NOW(),'hecha')`,
        [i.user_id, i.id, c.id, i.kind === 'reunion' ? 'Aviso al cliente: confirmar si se realizó la reunión' : 'Aviso al cliente: ' + i.dias + ' días hábiles sin actividad' + (i.kind === 'cierre' ? ' (sugerir cierre / más adelante)' : '')]);
    }
  }
  return { sent };
}

function start(pool) {
  setInterval(() => tick(pool).catch(e => console.warn('[opp-watcher]', e.message)), 60 * 60 * 1000);
}
module.exports = { start, tick, pending, preview, bizDays };
