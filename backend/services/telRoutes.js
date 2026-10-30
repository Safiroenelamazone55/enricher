'use strict';
// Telefonía (llamadas reales) — opción A: el número del cliente sigue con SU operador; Nova llama desde el navegador mostrando ese número.
//  · Proveedor: Twilio (SDK de voz en el navegador). Las credenciales las escribe el equipo en Nova (Clientes outbound → Telefonía);
//    se guardan cifradas (mismo cifrado que las contraseñas de buzón). Nunca se piden por chat ni van al repositorio.
//  · Cada línea = un número del cliente verificado como identificador de llamada (Twilio llama una vez al número y dicta un código).
//  · Las llamadas salen SOLO por una línea verificada del cliente del contacto, y nunca a contactos marcados «No contactar».
//  · Cada llamada queda registrada en el contacto (actividad «llamada»: duración y resultado). Sin grabación.
//  · Las entradas quedan en el teléfono del cliente (su línea no se toca): Nova no recibe llamadas en esta opción.

const crypto = require('crypto');
const https = require('https');
const express = require('express');

const API_BASE = (process.env.API_BASE_URL || 'https://api.novacentrax.com').replace(/\/+$/, '');
const urlenc = express.urlencoded({ extended: false, limit: '64kb' });
const xmlEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const e164 = n => { let t = String(n || '').trim().replace(/[^\d+]/g, ''); if (t.startsWith('00')) t = '+' + t.slice(2); return /^\+\d{8,15}$/.test(t) ? t : ''; };
const b64u = b => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function jwt(payload, secret) {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' })), p = b64u(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + s;
}

function mount(app, { pool, requireAuth, mailboxSvc }) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS tel_settings (user_id INTEGER PRIMARY KEY, account_sid TEXT NOT NULL DEFAULT '', api_key_sid TEXT NOT NULL DEFAULT '', api_secret_enc TEXT NOT NULL DEFAULT '', twiml_app_sid TEXT NOT NULL DEFAULT '', hook_key TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS tel_lines (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, outbound_client_id INTEGER REFERENCES outbound_clients(id) ON DELETE CASCADE, numero TEXT NOT NULL, etiqueta TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'pendiente', codigo TEXT NOT NULL DEFAULT '', caller_id_sid TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tel_lines_num_uq ON tel_lines (user_id, numero)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS tel_calls (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, contact_id INTEGER, outbound_client_id INTEGER, line_id INTEGER, call_sid TEXT NOT NULL DEFAULT '', to_number TEXT NOT NULL DEFAULT '', from_number TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'iniciada', duracion INTEGER NOT NULL DEFAULT 0, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ, resultado TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', member TEXT NOT NULL DEFAULT '')`);
      await pool.query(`CREATE INDEX IF NOT EXISTS tel_calls_sid_idx ON tel_calls (call_sid)`);
    } catch (e) { console.warn('[tel] tablas', e.message); }
  })();

  const loadCfg = async uid => {
    const { rows: [r] } = await pool.query(`SELECT * FROM tel_settings WHERE user_id=$1`, [uid]);
    if (!r || !r.account_sid || !r.api_key_sid || !r.api_secret_enc) return null;
    let secret = ''; try { secret = mailboxSvc.decPass(r.api_secret_enc); } catch (_) { return null; }
    return { ...r, secret };
  };
  const tw = (cfg, method, path, form) => new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : '';
    const req = https.request({ hostname: 'api.twilio.com', path: `/2010-04-01/Accounts/${cfg.account_sid}${path}`, method, auth: `${cfg.api_key_sid}:${cfg.secret}`, timeout: 15000,
      headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let d = ''; res.on('data', c => { d += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Twilio no respondió')));
    if (form) req.write(body); req.end();
  });
  const hookUrl = k => `${API_BASE}/api/tel/voice?k=${k}`;

  // ── Configuración (credenciales) ──
  app.get('/api/tel/config', requireAuth, async (req, res) => {
    try {
      const { rows: [r] } = await pool.query(`SELECT * FROM tel_settings WHERE user_id=$1`, [req.workspaceOwnerId]);
      res.json({ configured: !!(r && r.account_sid && r.api_key_sid && r.api_secret_enc && r.twiml_app_sid), account_sid: r ? r.account_sid : '', api_key_sid: r ? r.api_key_sid : '',
        twiml_app_sid: r ? r.twiml_app_sid : '', has_secret: !!(r && r.api_secret_enc), hook_url: r && r.hook_key ? hookUrl(r.hook_key) : '' });
    } catch (e) { console.error('[tel] config', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.put('/api/tel/config', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, b = req.body || {};
      const sid = String(b.account_sid || '').trim(), key = String(b.api_key_sid || '').trim(), app_ = String(b.twiml_app_sid || '').trim(), sec = String(b.api_secret || '').trim();
      if (!/^AC[0-9a-f]{32}$/i.test(sid)) return res.status(400).json({ error: 'El Account SID debe empezar por AC y tener 34 caracteres' });
      if (!/^SK[0-9a-f]{32}$/i.test(key)) return res.status(400).json({ error: 'El API Key SID debe empezar por SK y tener 34 caracteres' });
      if (app_ && !/^AP[0-9a-f]{32}$/i.test(app_)) return res.status(400).json({ error: 'El TwiML App SID debe empezar por AP y tener 34 caracteres' });
      const { rows: [cur] } = await pool.query(`SELECT * FROM tel_settings WHERE user_id=$1`, [uid]);
      let secEnc = cur ? cur.api_secret_enc : '';
      if (sec) secEnc = mailboxSvc.encPass(sec);
      if (!secEnc) return res.status(400).json({ error: 'Falta el API Secret' });
      // Se prueban las credenciales contra Twilio antes de guardarlas
      const test = await tw({ account_sid: sid, api_key_sid: key, secret: sec || mailboxSvc.decPass(secEnc) }, 'GET', '.json');
      if (test.status !== 200) return res.status(400).json({ error: 'Twilio no aceptó esas credenciales (revisa el Account SID, el API Key y el Secret)' });
      const hook = (cur && cur.hook_key) || crypto.randomBytes(18).toString('hex');
      await pool.query(`INSERT INTO tel_settings (user_id, account_sid, api_key_sid, api_secret_enc, twiml_app_sid, hook_key, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (user_id) DO UPDATE SET account_sid=$2, api_key_sid=$3, api_secret_enc=$4, twiml_app_sid=$5, hook_key=$6, updated_at=NOW()`, [uid, sid, key, secEnc, app_, hook]);
      res.json({ ok: true, hook_url: hookUrl(hook) });
    } catch (e) { console.error('[tel] config PUT', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });

  // ── Líneas (números de los clientes) ──
  app.get('/api/tel/lines', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT l.id, l.outbound_client_id, oc.nombre AS cliente, l.numero, l.etiqueta, l.estado, l.codigo FROM tel_lines l LEFT JOIN outbound_clients oc ON oc.id=l.outbound_client_id WHERE l.user_id=$1 ORDER BY l.id`, [req.workspaceOwnerId]);
      const cfg = await loadCfg(req.workspaceOwnerId);
      res.json({ configured: !!(cfg && cfg.twiml_app_sid), lines: rows });
    } catch (e) { console.error('[tel] lines', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/tel/lines', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, b = req.body || {};
      const cid = parseInt(b.outbound_client_id, 10), num = e164(b.numero);
      if (!cid) return res.status(400).json({ error: 'Elige el cliente' });
      if (!num) return res.status(400).json({ error: 'Escribe el número con prefijo de país, por ejemplo +34911222333' });
      const cfg = await loadCfg(uid); if (!cfg) return res.status(400).json({ error: 'Primero guarda las credenciales de Twilio' });
      const { rows: [oc] } = await pool.query(`SELECT id FROM outbound_clients WHERE id=$1 AND user_id=$2`, [cid, uid]); if (!oc) return res.status(404).json({ error: 'Cliente no encontrado' });
      // ¿ya verificado en Twilio?
      const ex = await tw(cfg, 'GET', `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(num)}`);
      const found = ex.json && ex.json.outgoing_caller_ids && ex.json.outgoing_caller_ids[0];
      let estado = 'pendiente', codigo = '', sid = '';
      if (found) { estado = 'verificado'; sid = found.sid; }
      else {
        const v = await tw(cfg, 'POST', '/OutgoingCallerIds.json', { PhoneNumber: num, FriendlyName: String(b.etiqueta || ('Nova · cliente ' + cid)).slice(0, 60) });
        if (v.status >= 300) return res.status(400).json({ error: (v.json && v.json.message) || 'Twilio no pudo iniciar la verificación' });
        codigo = String(v.json.validation_code || '');
      }
      const { rows: [l] } = await pool.query(`INSERT INTO tel_lines (user_id, outbound_client_id, numero, etiqueta, estado, codigo, caller_id_sid) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (user_id, numero) DO UPDATE SET outbound_client_id=$2, etiqueta=$4, estado=$5, codigo=$6, caller_id_sid=$7 RETURNING id, outbound_client_id, numero, etiqueta, estado, codigo`,
        [uid, cid, num, String(b.etiqueta || '').slice(0, 60), estado, codigo, sid]);
      res.status(201).json(l);
    } catch (e) { console.error('[tel] line POST', e.message); res.status(500).json({ error: 'No se pudo añadir la línea' }); }
  });
  app.post('/api/tel/lines/:id/refresh', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId;
      const { rows: [l] } = await pool.query(`SELECT * FROM tel_lines WHERE id=$1 AND user_id=$2`, [req.params.id, uid]); if (!l) return res.status(404).json({ error: 'Línea no encontrada' });
      const cfg = await loadCfg(uid); if (!cfg) return res.status(400).json({ error: 'Faltan las credenciales de Twilio' });
      const ex = await tw(cfg, 'GET', `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(l.numero)}`);
      const found = ex.json && ex.json.outgoing_caller_ids && ex.json.outgoing_caller_ids[0];
      if (found) await pool.query(`UPDATE tel_lines SET estado='verificado', caller_id_sid=$2, codigo='' WHERE id=$1`, [l.id, found.sid]);
      res.json({ id: l.id, estado: found ? 'verificado' : 'pendiente' });
    } catch (e) { console.error('[tel] refresh', e.message); res.status(500).json({ error: 'Error' }); }
  });
  app.delete('/api/tel/lines/:id', requireAuth, async (req, res) => {
    try { await pool.query(`DELETE FROM tel_lines WHERE id=$1 AND user_id=$2`, [req.params.id, req.workspaceOwnerId]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'Error' }); }
  });

  // ── Token del teléfono del navegador (solo si el cliente tiene una línea verificada) ──
  app.get('/api/tel/token', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, cid = parseInt(req.query.client, 10) || 0;
      const cfg = await loadCfg(uid); if (!cfg || !cfg.twiml_app_sid) return res.status(400).json({ error: 'Telefonía sin configurar' });
      const { rows } = await pool.query(`SELECT id, numero FROM tel_lines WHERE user_id=$1 AND outbound_client_id=$2 AND estado='verificado' ORDER BY id`, [uid, cid]);
      if (!rows.length) return res.status(400).json({ error: 'Este cliente no tiene una línea verificada' });
      const now = Math.floor(Date.now() / 1000);
      const token = jwt({ jti: cfg.api_key_sid + '-' + now, iss: cfg.api_key_sid, sub: cfg.account_sid, nbf: now, exp: now + 3600,
        grants: { identity: 'u' + uid + '-m' + (req.user && req.user.id || 0), voice: { incoming: { allow: false }, outgoing: { application_sid: cfg.twiml_app_sid } } } }, cfg.secret);
      res.json({ token, lines: rows });
    } catch (e) { console.error('[tel] token', e.message); res.status(500).json({ error: 'Error' }); }
  });

  // ── Webhooks de Twilio (públicos; se identifican con la clave k de la URL) ──
  const userByKey = async k => { if (!k || String(k).length < 20) return null; const { rows: [r] } = await pool.query(`SELECT user_id FROM tel_settings WHERE hook_key=$1`, [String(k)]); return r ? r.user_id : null; };
  const xml = (res, body) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response>' + body + '</Response>');
  app.post('/api/tel/voice', urlenc, async (req, res) => {
    try {
      const uid = await userByKey(req.query.k); if (!uid) return res.status(403).send('forbidden');
      const b = req.body || {}, to = e164(b.To), lineId = parseInt(b.LineId, 10) || 0, contactId = parseInt(b.ContactId, 10) || 0;
      if (!to || !lineId) return xml(res, '<Say language="es-ES">Llamada no válida.</Say><Hangup/>');
      const { rows: [line] } = await pool.query(`SELECT * FROM tel_lines WHERE id=$1 AND user_id=$2 AND estado='verificado'`, [lineId, uid]);
      if (!line) return xml(res, '<Say language="es-ES">Esta línea no está verificada.</Say><Hangup/>');
      let k = null;
      if (contactId) { ({ rows: [k] } = await pool.query(`SELECT id, outbound_client_id, disposition FROM lm_contacts WHERE id=$1 AND user_id=$2`, [contactId, uid])); }
      if (k && k.disposition === 'no_contactar') return xml(res, '<Say language="es-ES">Este contacto está marcado como no contactar.</Say><Hangup/>');
      if (k && k.outbound_client_id && line.outbound_client_id && k.outbound_client_id !== line.outbound_client_id) return xml(res, '<Say language="es-ES">La línea no corresponde al cliente de este contacto.</Say><Hangup/>');
      await pool.query(`INSERT INTO tel_calls (user_id, contact_id, outbound_client_id, line_id, call_sid, to_number, from_number, estado, member) VALUES ($1,$2,$3,$4,$5,$6,$7,'iniciada',$8)`,
        [uid, k ? k.id : null, line.outbound_client_id, line.id, String(b.CallSid || ''), to, line.numero, String(b.From || '').replace(/^client:/, '')]);
      xml(res, `<Dial callerId="${xmlEsc(line.numero)}" answerOnBridge="true" timeout="40" action="${xmlEsc(API_BASE + '/api/tel/dial-done?k=' + req.query.k)}"><Number>${xmlEsc(to)}</Number></Dial>`);
    } catch (e) { console.error('[tel] voice', e.message); xml(res, '<Say language="es-ES">Error al iniciar la llamada.</Say><Hangup/>'); }
  });
  app.post('/api/tel/dial-done', urlenc, async (req, res) => {
    try {
      const uid = await userByKey(req.query.k); if (!uid) return res.status(403).send('forbidden');
      const b = req.body || {};
      await pool.query(`UPDATE tel_calls SET estado=$2, duracion=$3, ended_at=NOW() WHERE user_id=$1 AND call_sid=$4`, [uid, String(b.DialCallStatus || 'completed'), parseInt(b.DialCallDuration, 10) || 0, String(b.CallSid || '')]);
      xml(res, '');
    } catch (e) { console.error('[tel] dial-done', e.message); xml(res, ''); }
  });

  // ── Resultado de la llamada → actividad del contacto ──
  app.post('/api/tel/result', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId, b = req.body || {};
      const cid = parseInt(b.contact_id, 10) || 0, sid = String(b.call_sid || '');
      const resultado = String(b.resultado || '').slice(0, 40), nota = String(b.nota || '').slice(0, 1000);
      const { rows: [k] } = await pool.query(`SELECT id, outbound_client_id FROM lm_contacts WHERE id=$1 AND user_id=$2`, [cid, uid]); if (!k) return res.status(404).json({ error: 'Contacto no encontrado' });
      let dur = parseInt(b.duracion, 10) || 0;
      if (sid) {
        const { rows: [c] } = await pool.query(`UPDATE tel_calls SET resultado=$3, nota=$4, duracion=GREATEST(duracion,$5) WHERE user_id=$1 AND call_sid=$2 RETURNING duracion`, [uid, sid, resultado, nota, dur]);
        if (c) dur = c.duracion;
      }
      const m = Math.floor(dur / 60), s = dur % 60;
      const txt = `Llamada${resultado ? ' · ' + resultado : ''}${dur ? ` · ${m}:${String(s).padStart(2, '0')} min` : ''}${nota ? ' — ' + nota : ''}`;
      await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, canal, nota, fecha, estado) VALUES ($1,$2,$3,'llamada','llamada',$4,NOW(),'hecha')`, [uid, k.id, k.outbound_client_id || null, txt]);
      res.json({ ok: true });
    } catch (e) { console.error('[tel] result', e.message); res.status(500).json({ error: 'No se pudo registrar la llamada' }); }
  });
}

module.exports = { mount };
