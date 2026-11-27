'use strict';
// Módulo «Warm-up» (estilo Lemwarm): salud y calentamiento de los buzones de los clientes + grupo de buzones de calentamiento.
const W = require('./warmup');
const mailboxSvc = require('./mailboxService');

const TZ = 'America/Lima';
const aviso = (...a) => console.warn('[warmup]', ...a);

function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS ramp_auto BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS ramp_techo INTEGER NOT NULL DEFAULT 60`);
      await pool.query(`CREATE TABLE IF NOT EXISTS lm_mailbox_events (id SERIAL PRIMARY KEY, mailbox_id INTEGER NOT NULL REFERENCES lm_mailboxes(id) ON DELETE CASCADE, tipo TEXT NOT NULL, detalle TEXT NOT NULL DEFAULT '', datos JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS lm_mailbox_events_mb_idx ON lm_mailbox_events (mailbox_id, created_at DESC)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS lm_mailbox_health (mailbox_id INTEGER PRIMARY KEY REFERENCES lm_mailboxes(id) ON DELETE CASCADE, datos JSONB NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS lm_warm_pool (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'otro',
        smtp_host TEXT NOT NULL DEFAULT '', smtp_port INTEGER NOT NULL DEFAULT 465, smtp_secure BOOLEAN NOT NULL DEFAULT TRUE,
        imap_host TEXT NOT NULL DEFAULT '', imap_port INTEGER NOT NULL DEFAULT 993, pass_enc TEXT NOT NULL DEFAULT '',
        estado TEXT NOT NULL DEFAULT 'probando', last_error TEXT NOT NULL DEFAULT '', sent_folder TEXT NOT NULL DEFAULT '',
        verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS lm_warm_pool_email_uq ON lm_warm_pool (user_id, lower(email))`);
      await pool.query(`ALTER TABLE lm_warm_pool ADD COLUMN IF NOT EXISTS rol TEXT NOT NULL DEFAULT 'grupo'`);   // 'grupo' = calienta a los demás · 'semilla' = solo recibe las pruebas de bandeja
    } catch (e) { aviso('tablas', e.message); }
  })();

  // Ajuste automático de la rampa: se evalúa cada 2 h; cada buzón se evalúa como mucho una vez al día
  const evalRampas = async () => { try { const r = await W.evaluarRampasAuto(pool); if (r.length) console.log('[warmup] rampa auto:', r.map(x => `${x.email}: ${x.tipo}`).join(' · ')); } catch (e) { aviso('rampa auto', e.message); } };
  setTimeout(evalRampas, 60 * 1000); setInterval(evalRampas, 2 * 3600e3);

  // ── Buzones de clientes con su salud ──
  async function filas(uid) {
    const { rows } = await pool.query(`
      SELECT mb.id, mb.email, mb.provider, mb.estado, mb.last_error, mb.outbound_client_id, oc.nombre AS cliente,
             mb.daily_limit, mb.ramp_on, mb.ramp_start, mb.ramp_step, mb.ramp_target, mb.ramp_auto, mb.ramp_techo, to_char(mb.ramp_started_on,'YYYY-MM-DD') AS ramp_started_on,
             nv_mb_cap(mb.id,$2) AS cap_hoy, nv_mb_sent(mb.id,$2) AS enviados_hoy,
             (SELECT COUNT(*)::int FROM lm_messages m WHERE m.mailbox_id=mb.id AND m.estado IN ('sent','replied','bounced') AND m.sent_at > NOW() - interval '14 days') AS n14,
             (SELECT COUNT(*)::int FROM lm_messages m WHERE m.mailbox_id=mb.id AND m.estado='bounced' AND m.sent_at > NOW() - interval '14 days') AS b14,
             h.datos AS salud, h.checked_at AS salud_en
        FROM lm_mailboxes mb LEFT JOIN outbound_clients oc ON oc.id = mb.outbound_client_id LEFT JOIN lm_mailbox_health h ON h.mailbox_id = mb.id
       WHERE mb.user_id=$1 AND mb.email <> '' ORDER BY oc.nombre NULLS LAST, mb.id`, [uid, TZ]);
    const ev = rows.length ? (await pool.query(`SELECT mailbox_id, tipo, detalle, created_at FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY created_at DESC) rn FROM lm_mailbox_events WHERE mailbox_id = ANY($1::int[])) x WHERE rn <= 5 ORDER BY created_at DESC`, [rows.map(r => r.id)])).rows : [];
    return rows.map(r => ({
      ...r, tasa_rebote: r.n14 ? Math.round(r.b14 / r.n14 * 1000) / 10 : null, fase: W.fase(r),
      consejo: r.salud ? W.consejo(r.salud.nota) : null,
      eventos: ev.filter(e => e.mailbox_id === r.id).map(e => ({ tipo: e.tipo, detalle: e.detalle, at: e.created_at })),
    }));
  }
  async function revisar(mb) {
    const dom = String(mb.email).split('@')[1];
    const datos = await W.puntuar(dom, mb.provider);
    await pool.query(`INSERT INTO lm_mailbox_health (mailbox_id, datos, checked_at) VALUES ($1,$2,NOW()) ON CONFLICT (mailbox_id) DO UPDATE SET datos=EXCLUDED.datos, checked_at=NOW()`, [mb.id, JSON.stringify(datos)]);
    return datos;
  }

  app.get('/api/lm/warmup/buzones', requireAuth, async (req, res) => {
    try {
      const lista = await filas(req.workspaceOwnerId);
      // las revisiones viejas (>12 h) o inexistentes se refrescan en segundo plano
      lista.filter(b => !b.salud_en || Date.now() - new Date(b.salud_en).getTime() > 12 * 3600e3).slice(0, 8).forEach(b => revisar(b).catch(e => aviso('revisar', b.email, e.message)));
      res.json(lista);
    } catch (e) { aviso('buzones', e.message); res.status(500).json({ error: 'No se pudo cargar los buzones' }); }
  });
  app.post('/api/lm/warmup/buzones/:id/revisar', requireAuth, async (req, res) => {
    try {
      const { rows: [mb] } = await pool.query(`SELECT id, email, provider FROM lm_mailboxes WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
      if (!mb) return res.status(404).json({ error: 'Buzón no encontrado' });
      const datos = await revisar(mb); res.json({ salud: datos, consejo: W.consejo(datos.nota) });
    } catch (e) { aviso('revisar', e.message); res.status(500).json({ error: 'No se pudo revisar el buzón' }); }
  });
  app.put('/api/lm/warmup/buzones/:id/auto', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, techo = Math.min(Math.max(parseInt(b.techo) || 60, 10), 200);
      const { rowCount } = await pool.query(`UPDATE lm_mailboxes SET ramp_auto=$3, ramp_techo=$4 WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId, !!b.auto, techo]);
      if (!rowCount) return res.status(404).json({ error: 'Buzón no encontrado' });
      await pool.query(`INSERT INTO lm_mailbox_events (mailbox_id, tipo, detalle) VALUES ($1,$2,$3)`, [req.params.id, b.auto ? 'auto_on' : 'auto_off', b.auto ? `Ajuste automático activado (techo ${techo} al día).` : 'Ajuste automático desactivado.']);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  // ── Grupo de buzones de calentamiento (los que irán calentando a los demás) ──
  const publico = r => ({ id: r.id, rol: r.rol, email: r.email, provider: r.provider, estado: r.estado, last_error: r.last_error, verified_at: r.verified_at, created_at: r.created_at });
  app.get('/api/lm/warmup/pool', requireAuth, async (req, res) => {
    try { const { rows } = await pool.query(`SELECT * FROM lm_warm_pool WHERE user_id=$1 ORDER BY id`, [req.workspaceOwnerId]); res.json(rows.map(publico)); }
    catch (e) { res.status(500).json({ error: 'No se pudo cargar el grupo' }); }
  });
  async function probarFila(id) {
    const { rows: [r] } = await pool.query(`SELECT * FROM lm_warm_pool WHERE id=$1`, [id]); if (!r) return;
    try {
      const pass = mailboxSvc.decPass ? mailboxSvc.decPass(r.pass_enc) : null;
      const t = await mailboxSvc.testMailbox({ email: r.email, provider: r.provider, smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_secure: r.smtp_secure, imap_host: r.imap_host, imap_port: r.imap_port }, pass);
      const estado = !t.smtpOk ? 'error' : (t.imapOk ? 'conectado' : 'solo_envio');
      await pool.query(`UPDATE lm_warm_pool SET estado=$1, last_error=$2, sent_folder=$3, verified_at=CASE WHEN $4 THEN NOW() ELSE verified_at END WHERE id=$5`, [estado, t.smtpOk && t.imapOk ? '' : (t.error || 'No se pudo conectar'), t.sentFolder || '', t.smtpOk, id]);
    } catch (e) { await pool.query(`UPDATE lm_warm_pool SET estado='error', last_error=$1 WHERE id=$2`, [String(e.message || e).slice(0, 300), id]).catch(() => {}); }
  }
  // Importación en lote: guarda todo cifrado y prueba cada buzón en segundo plano (la pantalla consulta el avance)
  app.post('/api/lm/warmup/pool/importar', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, provider = ['google', 'microsoft', 'zoho', 'otro'].includes(b.provider) ? b.provider : 'otro';
      const filasIn = (Array.isArray(b.filas) ? b.filas : []).map(f => ({ email: String(f.email || '').trim().toLowerCase(), password: String(f.password || '').trim() })).filter(f => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) && f.password);
      if (!filasIn.length) return res.status(400).json({ error: 'No hay filas válidas (correo y contraseña de aplicación).' });
      if (filasIn.length > 40) return res.status(400).json({ error: 'Importa hasta 40 buzones por vez.' });
      const hosts = mailboxSvc.resolveHosts(provider, { zoho_region: b.zoho_region || 'com', smtp_host: b.smtp_host, smtp_port: b.smtp_port, imap_host: b.imap_host, imap_port: b.imap_port });
      if (!hosts.smtp_host || !hosts.imap_host) return res.status(400).json({ error: 'Faltan los servidores SMTP/IMAP para este proveedor.' });
      const ids = [];
      for (const f of filasIn) {
        const { rows: [r] } = await pool.query(`INSERT INTO lm_warm_pool (user_id, email, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, pass_enc, estado, last_error, rol)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'probando','',$10)
            ON CONFLICT (user_id, lower(email)) DO UPDATE SET provider=EXCLUDED.provider, smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port, smtp_secure=EXCLUDED.smtp_secure,
              imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port, pass_enc=EXCLUDED.pass_enc, estado='probando', last_error='', rol=EXCLUDED.rol RETURNING id`,
          [req.workspaceOwnerId, f.email, provider, hosts.smtp_host, hosts.smtp_port, hosts.smtp_secure, hosts.imap_host, hosts.imap_port, mailboxSvc.encPass(f.password), b.rol === 'semilla' ? 'semilla' : 'grupo']);
        ids.push(r.id);
      }
      res.status(202).json({ ok: true, total: ids.length });
      // pruebas en segundo plano, de 3 en 3
      (async () => { const cola = ids.slice(); await Promise.all([0, 1, 2].map(async () => { while (cola.length) await probarFila(cola.shift()); })); })().catch(e => aviso('importar', e.message));
    } catch (e) { aviso('importar', e.message); res.status(500).json({ error: 'No se pudo importar' }); }
  });
  app.post('/api/lm/warmup/pool/:id/probar', requireAuth, async (req, res) => {
    const { rows: [r] } = await pool.query(`SELECT id FROM lm_warm_pool WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    await pool.query(`UPDATE lm_warm_pool SET estado='probando' WHERE id=$1`, [r.id]); res.status(202).json({ ok: true }); probarFila(r.id);
  });
  app.delete('/api/lm/warmup/pool/:id', requireAuth, async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM lm_warm_pool WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]);
    res.status(rowCount ? 200 : 404).json({ ok: !!rowCount });
  });
}
module.exports = { mount };
