'use strict';
// Configuración de la CAMPAÑA (como la pantalla «Configuración de la campaña» de lemlist): automatización, tracking, remitentes,
// planificación de envío, integración con CRM y general. Se guarda en la campaña y afecta a TODAS sus secuencias.
//
// Qué está conectado de verdad y qué no (la pantalla lo indica con una etiqueta «Próximamente»):
//   ✔ Al responder / al reservar reunión: tarea, continuar / pausar / finalizar, pausar a los de la misma empresa
//   ✔ Tracking de aperturas y clics (por campaña, pisa al ajuste global)
//   ✔ Días de envío, zona horaria e intervalo entre envíos (se copian a las secuencias de la campaña)
//   ✔ Fecha de fin con qué hacer con quien sigue en la secuencia
//   ✔ Remitentes de LinkedIn de la campaña (la extensión solo usa las cuentas elegidas)
//   ✔ Etiquetas
//   ✘ IA al responder, fuera de oficina, vacaciones, lanzamiento automático, baja, enlace compartible, CRM → solo se guardan / «Próximamente»

const DEFAULTS = {
  automatizacion: {
    clic: { tarea: false, progreso: 'continuar' },
    respuesta: { tarea: true, progreso: 'pausar', pausar_empresa: false, ia_puntuar: false, ia_fuera_oficina: false, ia_interesado: false, ia_no_interesado: false },
    reunion: { progreso: 'pausar', pausar_empresa: false },
  },
  tracking: { aperturas: true, clics: true, respuestas: true },
  remitentes: { modo: 'equilibrado' },
  planificacion: { li_modo: 'asistido', li_plan: 'gratis', lanzamiento_auto: false, dias: [1, 2, 3, 4, 5], cada_min: 5, zona: '', fecha_fin: '', al_finalizar: 'terminar', vacaciones_pais: '', vacaciones: [] },
  general: { etiquetas: [], compartir: false, baja: 'email', enlace_baja: false },
};
const PROGRESOS = ['continuar', 'pausar', 'finalizar'];

const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
function merge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isObj(extra)) return out;
  for (const k of Object.keys(base)) {
    if (!(k in extra)) continue;
    if (isObj(base[k])) out[k] = merge(base[k], extra[k]);
    else if (Array.isArray(base[k])) out[k] = Array.isArray(extra[k]) ? extra[k] : base[k];
    else if (typeof base[k] === 'boolean') out[k] = !!extra[k];
    else if (typeof base[k] === 'number') out[k] = Number.isFinite(Number(extra[k])) ? Number(extra[k]) : base[k];
    else out[k] = String(extra[k] == null ? '' : extra[k]);
  }
  return out;
}
function sanear(c) {
  const a = c.automatizacion;
  for (const k of ['clic', 'respuesta', 'reunion']) if (!PROGRESOS.includes(a[k].progreso)) a[k].progreso = DEFAULTS.automatizacion[k].progreso;
  const p = c.planificacion;
  p.dias = [...new Set((p.dias || []).map(Number).filter(d => d >= 1 && d <= 7))].sort(); if (!p.dias.length) p.dias = [1, 2, 3, 4, 5];
  p.cada_min = Math.min(240, Math.max(1, Math.round(p.cada_min) || 5));
  p.zona = String(p.zona || '').slice(0, 60); if (p.zona) { try { new Intl.DateTimeFormat('en', { timeZone: p.zona }); } catch (_) { p.zona = ''; } }
  p.fecha_fin = /^\d{4}-\d{2}-\d{2}$/.test(p.fecha_fin) ? p.fecha_fin : '';
  if (!['terminar', 'pausar'].includes(p.al_finalizar)) p.al_finalizar = 'terminar';
  if (!['manual', 'asistido', 'auto'].includes(p.li_modo)) p.li_modo = 'asistido';
  if (!['gratis', 'premium'].includes(p.li_plan)) p.li_plan = 'gratis';
  { const { CALENDARS } = require('./holidays');
    if (!CALENDARS[p.vacaciones_pais]) { p.vacaciones_pais = ''; p.vacaciones = []; }
    else { const validas = new Set(CALENDARS[p.vacaciones_pais].feriados.map(h => h.k)); p.vacaciones = [...new Set((p.vacaciones || []).filter(k => validas.has(k)))]; } }
  c.general.etiquetas = [...new Set((c.general.etiquetas || []).map(x => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, 12);
  if (!['email', 'todo'].includes(c.general.baja)) c.general.baja = 'email';
  if (!['equilibrado', 'propiedad'].includes(c.remitentes.modo)) c.remitentes.modo = 'equilibrado';
  c.tracking.respuestas = true;   // sin esto no se detienen los seguimientos al responder
  return c;
}
const maskDe = dias => [1, 2, 3, 4, 5, 6, 7].map(d => (dias.includes(d) ? '1' : '0')).join('');

async function ensure(pool) {
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS track_opens BOOLEAN`);
  await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS track_clicks BOOLEAN`);
  await pool.query(`CREATE TABLE IF NOT EXISTS campaign_senders (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, ref_id INTEGER NOT NULL, activo BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE (campaign_id, tipo, ref_id))`);
}

// Config efectiva de una campaña; null si nunca se guardó (las campañas antiguas siguen comportándose exactamente como antes)
async function configGuardada(pool, campaignId) {
  if (!campaignId) return null;
  const { rows: [c] } = await pool.query(`SELECT config FROM campaigns WHERE id=$1`, [campaignId]);
  if (!c || !isObj(c.config) || !c.config.guardada) return null;
  return sanear(merge(DEFAULTS, c.config));
}

// Pausa / termina a los contactos de la misma empresa dentro de las secuencias de la campaña
async function accionMismaEmpresa(pool, uid, contactId, campaignId, progreso, motivo) {
  if (progreso === 'continuar') return 0;
  const { rows: [k] } = await pool.query(`SELECT company_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [contactId, uid]);
  if (!k || !k.company_id) return 0;
  const r = await pool.query(
    `UPDATE lm_contact_sequences cs SET estado=$5, paused_reason=CASE WHEN $5='pausado' THEN $6 ELSE '' END
       FROM lm_contacts o, sequences s
      WHERE cs.contact_id=o.id AND o.company_id=$1 AND o.id <> $2 AND cs.sequence_id=s.id AND s.campaign_id=$3 AND cs.user_id=$4 AND cs.estado='activo'`,
    [k.company_id, contactId, campaignId, uid, progreso === 'finalizar' ? 'terminado' : 'pausado', motivo]);
  return r.rowCount;
}

// Ganchos que llama server.js: la campaña decide qué pasa después de una respuesta o de una reunión
async function trasRespuesta(pool, uid, contactId) {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT s.campaign_id FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.user_id=$1 AND cs.contact_id=$2 AND s.campaign_id IS NOT NULL`, [uid, contactId]);
    for (const { campaign_id } of rows) {
      const c = await configGuardada(pool, campaign_id); if (!c) continue;
      const r = c.automatizacion.respuesta;
      if (!r.tarea) await pool.query(`UPDATE activities SET estado='hecha' WHERE user_id=$1 AND contact_id=$2 AND tipo='revisar_respuesta' AND estado='pendiente'`, [uid, contactId]);
      const ids = `(SELECT cs.id FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.user_id=$1 AND cs.contact_id=$2 AND s.campaign_id=$3)`;
      if (r.progreso === 'continuar') await pool.query(`UPDATE lm_contact_sequences SET estado='activo', paused_reason='', next_action_at=NOW() WHERE id IN ${ids} AND estado='pausado' AND paused_reason='reply_received'`, [uid, contactId, campaign_id]);
      else if (r.progreso === 'finalizar') await pool.query(`UPDATE lm_contact_sequences SET estado='terminado', paused_reason='' WHERE id IN ${ids} AND estado IN ('activo','pausado')`, [uid, contactId, campaign_id]);
      if (r.pausar_empresa) await accionMismaEmpresa(pool, uid, contactId, campaign_id, 'pausar', 'respuesta_misma_empresa');
    }
  } catch (e) { console.error('[campaignConfig] trasRespuesta', e.message); }
}
async function trasReunion(pool, uid, contactId) {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT s.campaign_id FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.user_id=$1 AND cs.contact_id=$2 AND s.campaign_id IS NOT NULL`, [uid, contactId]);
    for (const { campaign_id } of rows) {
      const c = await configGuardada(pool, campaign_id); if (!c) continue;
      const r = c.automatizacion.reunion;
      const ids = `(SELECT cs.id FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.user_id=$1 AND cs.contact_id=$2 AND s.campaign_id=$3)`;
      if (r.progreso === 'finalizar') await pool.query(`UPDATE lm_contact_sequences SET estado='terminado', paused_reason='' WHERE id IN ${ids} AND estado IN ('activo','pausado')`, [uid, contactId, campaign_id]);
      else if (r.progreso === 'pausar') await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='reunion_agendada' WHERE id IN ${ids} AND estado='activo'`, [uid, contactId, campaign_id]);
      if (r.pausar_empresa) await accionMismaEmpresa(pool, uid, contactId, campaign_id, 'pausar', 'reunion_misma_empresa');
    }
  } catch (e) { console.error('[campaignConfig] trasReunion', e.message); }
}
async function trasClic(pool, messageId) {
  try {
    const { rows: [m] } = await pool.query(`SELECT m.user_id, m.contact_id, s.campaign_id, m.sequence_id FROM lm_messages m JOIN sequences s ON s.id=m.sequence_id WHERE m.id=$1`, [messageId]);
    if (!m || !m.campaign_id) return;
    const c = await configGuardada(pool, m.campaign_id); if (!c) return;
    const r = c.automatizacion.clic;
    if (r.tarea) {
      const { rows: ya } = await pool.query(`SELECT 1 FROM activities WHERE user_id=$1 AND contact_id=$2 AND tipo='revisar_clic' AND estado='pendiente' LIMIT 1`, [m.user_id, m.contact_id]);
      if (!ya.length) await pool.query(`INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado) VALUES ($1,$2,'revisar_clic','email','Hizo clic en un enlace de tu email: vale la pena escribirle',NOW(),'pendiente')`, [m.user_id, m.contact_id]);
    }
    const ids = `(SELECT cs.id FROM lm_contact_sequences cs JOIN sequences s ON s.id=cs.sequence_id WHERE cs.user_id=$1 AND cs.contact_id=$2 AND s.campaign_id=$3)`;
    if (r.progreso === 'finalizar') await pool.query(`UPDATE lm_contact_sequences SET estado='terminado', paused_reason='' WHERE id IN ${ids} AND estado IN ('activo','pausado')`, [m.user_id, m.contact_id, m.campaign_id]);
    else if (r.progreso === 'pausar') await pool.query(`UPDATE lm_contact_sequences SET estado='pausado', paused_reason='clic_en_enlace' WHERE id IN ${ids} AND estado='activo'`, [m.user_id, m.contact_id, m.campaign_id]);
  } catch (e) { console.error('[campaignConfig] trasClic', e.message); }
}

// ¿Hoy (en la zona horaria del prospecto) es feriado del país que la campaña configuró? null si no aplica/no es feriado.
async function holidayHoy(pool, campaignId, tz) {
  if (!campaignId) return null;
  const cfg = await configGuardada(pool, campaignId);
  if (!cfg || !cfg.planificacion.vacaciones_pais || !cfg.planificacion.vacaciones.length) return null;
  const { holidayOn } = require('./holidays');
  // "Hoy" en la zona horaria del prospecto, no en UTC del servidor — un feriado es por calendario local.
  let hoy;
  try { const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const g = k => (p.find(x => x.type === k) || {}).value; hoy = new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day'))); } catch (_) { hoy = new Date(); }
  return holidayOn(cfg.planificacion.vacaciones_pais, cfg.planificacion.vacaciones, hoy);
}

// Fecha de fin: al llegar, quien sigue en las secuencias de la campaña termina o se pausa
async function tickFin(pool) {
  try {
    const { rows } = await pool.query(`SELECT id, user_id, config FROM campaigns WHERE config->>'guardada'='true' AND COALESCE(config->'planificacion'->>'fecha_fin','') <> '' AND COALESCE(config->>'fin_aplicado','') <> 'true' AND (config->'planificacion'->>'fecha_fin')::date <= CURRENT_DATE`);
    for (const c of rows) {
      const modo = (c.config.planificacion || {}).al_finalizar === 'pausar' ? 'pausar' : 'terminar';
      const r = await pool.query(
        `UPDATE lm_contact_sequences cs SET estado=$3, paused_reason=CASE WHEN $3='pausado' THEN 'campana_finalizada' ELSE '' END
           FROM sequences s WHERE cs.sequence_id=s.id AND s.campaign_id=$1 AND cs.user_id=$2 AND cs.estado IN ('activo','pausado') AND COALESCE(cs.paused_reason,'') <> 'reply_received'`, [c.id, c.user_id, modo === 'pausar' ? 'pausado' : 'terminado']);
      await pool.query(`UPDATE campaigns SET config = jsonb_set(config, '{fin_aplicado}', 'true'::jsonb), estado=CASE WHEN estado='activa' THEN 'cerrada' ELSE estado END WHERE id=$1`, [c.id]);
      console.log(`[campaignConfig] campaña ${c.id}: fecha de fin alcanzada (${modo}, ${r.rowCount} inscripciones)`);
    }
  } catch (e) { console.error('[campaignConfig] fin', e.message); }
}

function mount(app, { pool, requireAuth }) {
  ensure(pool).catch(e => console.error('[campaignConfig] esquema', e.message));
  setInterval(() => tickFin(pool), 30 * 60 * 1000).unref();
  setTimeout(() => tickFin(pool), 60 * 1000).unref();

  async function cargar(req, res) {
    const id = parseInt(req.params.id, 10) || 0;
    const { rows: [c] } = await pool.query(`SELECT * FROM campaigns WHERE id=$1 AND user_id=$2`, [id, req.workspaceOwnerId]);
    if (!c) { res.status(404).json({ error: 'Campaña no encontrada' }); return null; }
    return c;
  }

  // Remitentes de un cliente outbound (email, WhatsApp, LinkedIn): lo que ve «Conectar remitente» en el menú del cliente
  app.get('/api/outbound-clients/:id/senders', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, cid = parseInt(req.params.id, 10) || 0;
      const { rows: [cl] } = await pool.query(`SELECT id, nombre FROM outbound_clients WHERE id=$1 AND user_id=$2`, [cid, uid]);
      if (!cl) return res.status(404).json({ error: 'Cliente no encontrado' });
      const { rows: em } = await pool.query(`SELECT id, email, provider, estado, last_error FROM lm_mailboxes WHERE user_id=$1 AND outbound_client_id=$2 ORDER BY id`, [uid, cid]);
      const { rows: wa } = await pool.query(`SELECT w.id, w.nombre, w.numero, w.estado FROM wa_connections w WHERE w.user_id=$1 AND w.archivada_at IS NULL AND (w.outbound_client_id=$2 OR EXISTS (SELECT 1 FROM wa_connection_clients x WHERE x.connection_id=w.id AND x.outbound_client_id=$2)) ORDER BY w.id`, [uid, cid]).catch(() => ({ rows: [] }));
      res.json({ cliente: cl, email: em, whatsapp: wa });
    } catch (e) { console.error('[campaignConfig] senders', e.message); res.status(500).json({ error: 'No se pudieron cargar los remitentes' }); }
  });

  app.get('/api/campaigns/:id/config', requireAuth, async (req, res) => {
    try {
      const c = await cargar(req, res); if (!c) return;
      const uid = req.workspaceOwnerId, cid = c.outbound_client_id || 0;
      const cfg = sanear(merge(DEFAULTS, isObj(c.config) ? c.config : {}));
      const { rows: sel } = await pool.query(`SELECT tipo, ref_id, activo FROM campaign_senders WHERE campaign_id=$1`, [c.id]);
      const elegido = (tipo, id) => { if (!sel.length) return true; const r = sel.find(x => x.tipo === tipo && x.ref_id === id); return r ? r.activo : false; };
      const { rows: em } = await pool.query(`SELECT id, email, provider, estado FROM lm_mailboxes WHERE user_id=$1 AND outbound_client_id=$2 ORDER BY id`, [uid, cid]);
      const { rows: wa } = await pool.query(`SELECT w.id, w.nombre, w.numero, w.estado FROM wa_connections w WHERE w.user_id=$1 AND w.archivada_at IS NULL AND (w.outbound_client_id=$2 OR EXISTS (SELECT 1 FROM wa_connection_clients x WHERE x.connection_id=w.id AND x.outbound_client_id=$2)) ORDER BY w.id`, [uid, cid]).catch(() => ({ rows: [] }));
      const { rows: li } = await pool.query(`SELECT id, nombre, li_slug, estado, modo, plan, ultimo_visto FROM li_accounts WHERE user_id=$1 AND outbound_client_id=$2 ORDER BY id`, [uid, cid]).catch(() => ({ rows: [] }));
      const { rows: ws } = await pool.query(`SELECT window_start, window_end, send_weekends, timezone, track_opens, track_clicks FROM lm_send_settings WHERE user_id=$1`, [uid]);
      const { rows: seqs } = await pool.query(`SELECT s.id, s.nombre, s.estado, s.send_days, s.timezone, s.send_interval_min, s.send_mode, s.linkedin_auto, s.li_modo, s.li_plan, s.track_opens, s.track_clicks, (SELECT COUNT(*)::int FROM lm_contact_sequences x WHERE x.sequence_id=s.id AND x.estado='activo') AS activos FROM sequences s WHERE s.campaign_id=$1 AND s.user_id=$2 ORDER BY s.id`, [c.id, uid]);
      // Campaña sin configuración guardada: se parte de lo que YA tienen sus secuencias (así guardar sin tocar nada no cambia el comportamiento actual)
      { const guard = isObj(c.config) && isObj(c.config.planificacion) && c.config.planificacion.li_modo; const q0 = seqs[0];
        if (!guard && q0) cfg.planificacion.li_modo = q0.linkedin_auto ? (q0.li_modo === 'auto' ? 'auto' : 'asistido') : 'manual';
        if (!(isObj(c.config) && isObj(c.config.planificacion) && c.config.planificacion.li_plan) && q0) cfg.planificacion.li_plan = q0.li_plan === 'premium' ? 'premium' : 'gratis'; }
      if (!(isObj(c.config) && c.config.guardada)) {
        const q0 = seqs[0];
        if (q0) {
          const m = String(q0.send_days || '1111100');
          if (/^[01]{7}$/.test(m)) cfg.planificacion.dias = [1, 2, 3, 4, 5, 6, 7].filter(d => m[d - 1] === '1');
          if (q0.send_interval_min > 0) cfg.planificacion.cada_min = q0.send_interval_min;
          cfg.planificacion.zona = q0.timezone || '';
        }
        if (ws[0]) { cfg.tracking.aperturas = ws[0].track_opens !== false; cfg.tracking.clics = ws[0].track_clicks !== false; }
      }
      res.json({
        campana: { id: c.id, nombre: c.nombre, outbound_client_id: c.outbound_client_id, estado: c.estado }, config: cfg, guardada: !!(isObj(c.config) && c.config.guardada),
        remitentes: {
          email: em.map(x => ({ id: x.id, email: x.email, proveedor: x.provider, estado: x.estado, activo: elegido('email', x.id) })),
          whatsapp: wa.map(x => ({ id: x.id, nombre: x.nombre, numero: x.numero, estado: x.estado, activo: elegido('whatsapp', x.id) })),
          linkedin: li.map(x => ({ id: x.id, nombre: x.nombre, slug: x.li_slug, estado: x.estado, modo: x.modo, plan: x.plan, conectada: !!(x.ultimo_visto && Date.now() - new Date(x.ultimo_visto) < 300000), activo: elegido('linkedin', x.id) })),
        },
        global: ws[0] || {}, secuencias: seqs,
      });
    } catch (e) { console.error('[campaignConfig] GET', e.message); res.status(500).json({ error: 'No se pudo cargar la configuración' }); }
  });

  app.put('/api/campaigns/:id/config', requireAuth, async (req, res) => {
    const cx = await pool.connect();
    try {
      const c = await cargar(req, res); if (!c) { cx.release(); return; }
      const b = req.body || {}, uid = req.workspaceOwnerId;
      const cfg = sanear(merge(DEFAULTS, isObj(b.config) ? b.config : {}));
      await cx.query('BEGIN');
      await cx.query(`UPDATE campaigns SET config = $2::jsonb, updated_at=NOW() WHERE id=$1`, [c.id, JSON.stringify({ ...cfg, guardada: true, fin_aplicado: (c.config && c.config.fin_aplicado && c.config.planificacion && c.config.planificacion.fecha_fin === cfg.planificacion.fecha_fin) ? true : false })]);
      // Se copia a las secuencias de la campaña lo que el motor ya entiende
      await cx.query(
        `UPDATE sequences SET send_days=$3, send_interval_min=$4, timezone=CASE WHEN $5 <> '' THEN $5 ELSE timezone END, track_opens=$6, track_clicks=$7
          WHERE campaign_id=$1 AND user_id=$2 AND ($8::int[] IS NULL OR id = ANY($8::int[]))`,
        [c.id, uid, maskDe(cfg.planificacion.dias), cfg.planificacion.cada_min, cfg.planificacion.zona, cfg.tracking.aperturas, cfg.tracking.clics,
          Array.isArray(b.aplicar_a) ? b.aplicar_a.map(x => parseInt(x, 10)).filter(Boolean) : null]);
      await cx.query(`UPDATE sequences SET linkedin_auto=($3 <> 'manual'), li_modo=CASE WHEN $3='auto' THEN 'auto' ELSE 'asistido' END, li_plan=$4 WHERE campaign_id=$1 AND user_id=$2`, [c.id, uid, cfg.planificacion.li_modo, cfg.planificacion.li_plan]);
      if (Array.isArray(b.remitentes)) {
        await cx.query(`DELETE FROM campaign_senders WHERE campaign_id=$1`, [c.id]);
        for (const r of b.remitentes) {
          if (!['email', 'whatsapp', 'linkedin'].includes(r.tipo)) continue;
          await cx.query(`INSERT INTO campaign_senders (user_id, campaign_id, tipo, ref_id, activo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (campaign_id, tipo, ref_id) DO UPDATE SET activo=EXCLUDED.activo`, [uid, c.id, r.tipo, parseInt(r.ref_id, 10) || 0, !!r.activo]);
        }
      }
      await cx.query('COMMIT');
      res.json({ ok: true, config: cfg });
    } catch (e) { await cx.query('ROLLBACK').catch(() => {}); console.error('[campaignConfig] PUT', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
    finally { cx.release(); }
  });
}

module.exports = { mount, trasRespuesta, trasReunion, trasClic, configGuardada, holidayHoy, DEFAULTS, merge, sanear, maskDe };
