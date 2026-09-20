// Informe semanal para el equipo del cliente: destinatarios, vista previa y envío desde el buzón conectado del cliente.
const fs = require('fs');
const { buildReport } = require('./reportMail');
const { previewPng } = require('./reportImage');

const LANGS = ['es', 'en', 'de', 'pt'];
const LOCALE = { es: 'es-ES', en: 'en-GB', de: 'de-DE', pt: 'pt-BR' };
const TZS = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Santiago', 'Europe/London', 'Europe/Madrid', 'Europe/Berlin', 'UTC'];
const okEmail = e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(e) && e.length <= 160;

function mount(app, { pool, requireAuth, dashHandler, highlights, sendViaClientMailbox, brandFor, trimmedLogo, slugOf, ownsClient }) {
  const iso = d => d.toISOString().slice(0, 10);

  // Datos de los últimos 7 días (mismas cifras que el dashboard del cliente)
  async function reportData(uid, cid, lang) {
    const to = new Date(), from = new Date(Date.now() - 6 * 864e5);
    const dash = await new Promise(resolve => {
      const res = { status() { return res; }, json: b => resolve(b) };
      dashHandler({ query: { from: iso(from), to: iso(to), client: String(cid) }, workspaceOwnerId: uid }, res);
    });
    if (!dash || dash.error) throw new Error('No se pudieron calcular las cifras');
    const hl = await highlights(pool, cid, { withNotes: false });
    const { rows: sq } = await pool.query(`SELECT nombre FROM sequences WHERE outbound_client_id=$1 AND estado='activa' ORDER BY id`, [cid]);
    const { rows: cl } = await pool.query(`SELECT nombre FROM outbound_clients WHERE id=$1`, [cid]);
    const loc = LOCALE[lang] || 'es-ES', fmt = (d, o) => new Date(d).toLocaleDateString(loc, o);
    const cur = (dash.kpi && dash.kpi.cur) || {}, prev = (dash.kpi && dash.kpi.prev) || {}, dl = dash.deals || {};
    const cliente = (cl[0] && cl[0].nombre) || '';
    const brand = await brandFor(cid);
    return {
      cliente, brand,
      rango: `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short' })}`,
      kpi: { touches: cur.touches, contacted: cur.contacted, replies: cur.replies, agendadas: dl.agendadas },
      prev: { touches: prev.touches, contacted: prev.contacted, replies: prev.replies, agendadas: dl.agendadas_prev },
      seqs: sq.map(s => s.nombre),
      positives: (hl.positive_pending || []).map(p => ({ empresa: p.empresa, nombre: [p.nombre, p.apellido].filter(Boolean).join(' '), estado: p.estado })),
      meetings: (hl.next_meetings || []).map(m => ({ empresa: m.empresa, nombre: [m.nombre, m.apellido].filter(Boolean).join(' '), dia: fmt(m.fecha, { day: 'numeric' }), mes: fmt(m.fecha, { month: 'short' }).replace('.', ''), fecha_txt: fmt(m.fecha, { weekday: 'long' }) })),
      url: 'https://app.novacentrax.com' + (lang === 'es' ? '' : '/' + lang) + '/portal/' + slugOf(cliente),
    };
  }

  async function render(uid, cid, lang, note) {
    const d = await reportData(uid, cid, lang);
    d.note = String(note || '').slice(0, 1200);
    const m = buildReport(lang, d);
    const att = [];
    try { att.push({ filename: 'informe.png', content: await previewPng(lang, d, m.accent), cid: 'reportpreview', contentType: 'image/png' }); }
    catch (e) { console.warn('[report] no se pudo generar la imagen:', e.message); m.html = m.html.replace('cid:reportpreview', 'about:blank'); }
    if (d.brand.hasLogo && d.brand.file && fs.existsSync(d.brand.file)) att.push({ filename: 'logo.png', content: await require('./logoUtil').logoPlate(d.brand.file, d.brand.tone, d.brand.bg), cid: 'brandlogo', contentType: 'image/png' });
    if (d.brand.hasWs && d.brand.wsFile && fs.existsSync(d.brand.wsFile)) att.push({ filename: 'nova.png', content: await trimmedLogo(d.brand.wsFile), cid: 'novalogo', contentType: 'image/png' });
    if (!att.some(a => a.cid === 'brandlogo')) m.html = m.html.replace('cid:brandlogo', 'about:blank');
    return { ...m, att, cliente: d.cliente };
  }

  // ── Envío automático programado (una sola vez por día y cliente; hora de Lima) ──
  async function runScheduled() {
    try {
      const { rows } = await pool.query(`
        SELECT r.outbound_client_id AS cid, r.recipients, r.lang, c.user_id AS uid, r.schedule_tz
          FROM client_reports r JOIN outbound_clients c ON c.id=r.outbound_client_id
         WHERE r.schedule_on AND jsonb_array_length(r.recipients) > 0
           AND EXTRACT(DOW FROM (NOW() AT TIME ZONE r.schedule_tz)) = r.schedule_dow
           AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE r.schedule_tz)) >= r.schedule_hour
           AND (r.last_auto_date IS NULL OR r.last_auto_date < (NOW() AT TIME ZONE r.schedule_tz)::date)`);
      for (const r of rows) {
        // reclama el envío del día antes de enviar, para no duplicar ni reintentar en bucle
        const claim = await pool.query(`UPDATE client_reports SET last_auto_date=(NOW() AT TIME ZONE $2)::date
                                         WHERE outbound_client_id=$1 AND (last_auto_date IS NULL OR last_auto_date < (NOW() AT TIME ZONE $2)::date) RETURNING 1`, [r.cid, r.schedule_tz]);
        if (!claim.rows[0]) continue;
        try {
          const rec = cleanList(r.recipients).filter(okEmail);
          const m = await render(r.uid, r.cid, LANGS.includes(r.lang) ? r.lang : 'es', '');
          const out = await sendViaClientMailbox(r.cid, rec, m.subject, m.html, m.text, m.cliente, m.att);
          if (!out.sent) throw new Error(out.error || 'No se pudo enviar');
          await pool.query(`UPDATE client_reports SET last_sent_at=NOW(), last_recipients=$2, last_by='Envío automático', last_error='' WHERE outbound_client_id=$1`, [r.cid, JSON.stringify(rec)]);
          console.log('[report] enviado automáticamente, cliente', r.cid, '->', rec.length, 'destinatarios');
        } catch (e) {
          console.error('[report] envío automático falló, cliente', r.cid, e.message);
          await pool.query(`UPDATE client_reports SET last_error=$2 WHERE outbound_client_id=$1`, [r.cid, String(e.message).slice(0, 300)]).catch(() => {});
        }
      }
    } catch (e) { console.error('[report] programador', e.message); }
  }
  setTimeout(runScheduled, 60 * 1000);
  setInterval(runScheduled, 5 * 60 * 1000);

  const cleanList = arr => [...new Set((Array.isArray(arr) ? arr : []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];

  app.get('/api/lm/reports/:cid', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.cid);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const [st, acc, mb, cl] = await Promise.all([
        pool.query(`SELECT recipients, lang, last_sent_at, last_recipients, last_by, schedule_on, schedule_dow, schedule_hour, schedule_tz, last_error FROM client_reports WHERE outbound_client_id=$1`, [cid]),
        pool.query(`SELECT email, nombre FROM client_accounts WHERE outbound_client_id=$1 AND activo ORDER BY id`, [cid]),
        pool.query(`SELECT email, estado FROM lm_mailboxes WHERE outbound_client_id=$1 AND estado NOT IN ('error') ORDER BY verified_at DESC NULLS LAST, id LIMIT 1`, [cid]),
        pool.query(`SELECT nombre FROM outbound_clients WHERE id=$1`, [cid]),
      ]);
      const s = st.rows[0] || {};
      res.json({ cliente: (cl.rows[0] || {}).nombre || '', recipients: s.recipients || [], lang: s.lang || 'es', last_sent_at: s.last_sent_at || null, last_recipients: s.last_recipients || [], last_by: s.last_by || '', schedule: { on: !!s.schedule_on, dow: s.schedule_dow == null ? 1 : s.schedule_dow, hour: s.schedule_hour == null ? 9 : s.schedule_hour, tz: s.schedule_tz || 'America/Lima', error: s.last_error || '' }, suggested: acc.rows, mailbox: mb.rows[0] || null });
    } catch (e) { console.error('[report] get', e.message); res.status(500).json({ error: 'Error' }); }
  });

  app.put('/api/lm/reports/:cid', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.cid);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const rec = cleanList(req.body && req.body.recipients).filter(okEmail).slice(0, 12);
      const lang = LANGS.includes(req.body && req.body.lang) ? req.body.lang : 'es';
      const sc = (req.body && req.body.schedule) || null;
      let on = null, dow = null, hour = null, tz = 'America/Lima';
      if (sc) {
        tz = TZS.includes(sc.tz) ? sc.tz : 'America/Lima';
        on = !!sc.on; dow = Math.min(6, Math.max(0, parseInt(sc.dow))); hour = Math.min(23, Math.max(0, parseInt(sc.hour)));
        if (isNaN(dow)) dow = 1; if (isNaN(hour)) hour = 9;
        if (on) {
          if (!rec.length) return res.status(400).json({ error: 'Agrega al menos un destinatario para programar el envío' });
          const mb = await pool.query(`SELECT 1 FROM lm_mailboxes WHERE outbound_client_id=$1 AND estado NOT IN ('error') LIMIT 1`, [cid]);
          if (!mb.rows[0]) return res.status(400).json({ error: 'El cliente no tiene un buzón conectado para enviar' });
        }
      }
      await pool.query(`INSERT INTO client_reports (outbound_client_id, user_id, recipients, lang, updated_at) VALUES ($1,$2,$3,$4,NOW())
                        ON CONFLICT (outbound_client_id) DO UPDATE SET recipients=$3, lang=$4, updated_at=NOW()`, [cid, req.workspaceOwnerId, JSON.stringify(rec), lang]);
      if (sc) await pool.query(`UPDATE client_reports SET schedule_on=$2, schedule_dow=$3, schedule_hour=$4, schedule_tz=$5, last_error='' WHERE outbound_client_id=$1`, [cid, on, dow, hour, tz]);
      res.json({ ok: true, recipients: rec, lang });
    } catch (e) { console.error('[report] put', e.message); res.status(500).json({ error: 'Error al guardar' }); }
  });

  // Vista previa: el mismo HTML que se envía (los logos adjuntos se incrustan como imagen)
  app.post('/api/lm/reports/:cid/preview', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.cid);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const lang = LANGS.includes(req.body && req.body.lang) ? req.body.lang : 'es';
      const r = await render(req.workspaceOwnerId, cid, lang, req.body && req.body.note);
      let html = r.html;
      for (const a of r.att) html = html.split('cid:' + a.cid).join('data:image/png;base64,' + Buffer.from(a.content).toString('base64'));
      res.json({ subject: r.subject, html });
    } catch (e) { console.error('[report] preview', e.message); res.status(500).json({ error: 'No se pudo generar la vista previa' }); }
  });

  app.post('/api/lm/reports/:cid/send', requireAuth, async (req, res) => {
    try {
      const cid = parseInt(req.params.cid);
      if (!cid || !(await ownsClient(req.workspaceOwnerId, cid))) return res.status(404).json({ error: 'Cliente no encontrado' });
      const lang = LANGS.includes(req.body && req.body.lang) ? req.body.lang : 'es';
      const rec = cleanList(req.body && req.body.recipients);
      if (!rec.length) return res.status(400).json({ error: 'Agrega al menos un destinatario' });
      if (rec.length > 12) return res.status(400).json({ error: 'Máximo 12 destinatarios' });
      const bad = rec.find(e => !okEmail(e)); if (bad) return res.status(400).json({ error: `Correo no válido: ${bad}` });
      const r = await render(req.workspaceOwnerId, cid, lang, req.body && req.body.note);
      const out = await sendViaClientMailbox(cid, rec, r.subject, r.html, r.text, r.cliente, r.att);
      if (!out.sent) return res.status(502).json({ error: out.error || 'No se pudo enviar' });
      const by = String((req.user && (req.user.name || req.user.nombre || req.user.email)) || '').slice(0, 80);
      await pool.query(`INSERT INTO client_reports (outbound_client_id, user_id, recipients, lang, last_sent_at, last_recipients, last_by, updated_at) VALUES ($1,$2,$3,$4,NOW(),$3,$5,NOW())
                        ON CONFLICT (outbound_client_id) DO UPDATE SET recipients=$3, lang=$4, last_sent_at=NOW(), last_recipients=$3, last_by=$5, updated_at=NOW()`, [cid, req.workspaceOwnerId, JSON.stringify(rec), lang, by]);
      res.json({ ok: true, via: out.via, sent_to: rec, last_sent_at: new Date().toISOString() });
    } catch (e) { console.error('[report] send', e.message); res.status(500).json({ error: 'Error al enviar' }); }
  });
}
module.exports = { mount };
