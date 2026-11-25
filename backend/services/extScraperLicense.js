'use strict';
// Licencias del "LinkedIn Sales Scraper" (producto de pago, independiente de Nova).
// Endpoints PÚBLICOS a propósito: quien compra la extensión no tiene cuenta en Nova.
// La gestión (generar/revocar claves) se hace con el script backend/scripts/license_cli.js
// por SSH — a propósito NO hay panel dentro del software, es un producto aparte.
const crypto = require('crypto');

let _ready = null;
function ensureTable(pool) {
  if (!_ready) {
    _ready = pool.query(`CREATE TABLE IF NOT EXISTS ext_licenses (
        id SERIAL PRIMARY KEY,
        product TEXT NOT NULL DEFAULT 'li-scraper',
        license_key TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 2,
        devices JSONB NOT NULL DEFAULT '[]'::jsonb,
        note TEXT NOT NULL DEFAULT '',
        -- Venta es pago único: esto NO bloquea el uso de la extensión al vencer.
        -- Es solo la fecha hasta la que el comprador tiene actualizaciones/soporte
        -- incluidos; sirve para saber a quién ofrecerle una renovación de soporte.
        support_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '9 months'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_check_at TIMESTAMPTZ
      )`)
      .then(() => pool.query(`ALTER TABLE ext_licenses ADD COLUMN IF NOT EXISTS support_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '9 months')`))
      .catch(e => { _ready = null; throw e; });
  }
  return _ready;
}

function genKey() {
  // formato legible tipo XXXX-XXXX-XXXX-XXXX (base32 simplificado, sin 0/O/1/I para evitar confusión al tipear)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

function mount(app, { pool }) {
  // ── Activar: primera vez que corre la extensión en ese dispositivo, registra el device_id ──
  app.post('/api/license/activate', async (req, res) => {
    try {
      await ensureTable(pool);
      const product = (req.body?.product || 'li-scraper').trim();
      const key = (req.body?.key || '').trim().toUpperCase();
      const deviceId = (req.body?.device_id || '').trim();
      if (!key || !deviceId) return res.status(400).json({ ok: false, reason: 'bad_request' });

      const { rows } = await pool.query(
        `SELECT * FROM ext_licenses WHERE license_key=$1 AND product=$2`, [key, product]);
      const lic = rows[0];
      if (!lic) return res.json({ ok: false, reason: 'not_found' });
      if (lic.status !== 'active') return res.json({ ok: false, reason: 'revoked' });

      const devices = Array.isArray(lic.devices) ? lic.devices : [];
      if (!devices.includes(deviceId)) {
        if (devices.length >= lic.max_devices) return res.json({ ok: false, reason: 'device_limit', max_devices: lic.max_devices });
        devices.push(deviceId);
        await pool.query(`UPDATE ext_licenses SET devices=$1::jsonb, last_check_at=NOW() WHERE id=$2`, [JSON.stringify(devices), lic.id]);
      } else {
        await pool.query(`UPDATE ext_licenses SET last_check_at=NOW() WHERE id=$1`, [lic.id]);
      }
      // support_until es informativo: NUNCA bloquea el uso (venta es pago único).
      res.json({ ok: true, support_until: lic.support_until, support_active: new Date(lic.support_until) > new Date() });
    } catch (e) { console.error('[license] activate', e.message); res.status(500).json({ ok: false, reason: 'server_error' }); }
  });

  // ── Verificación periódica: NO registra dispositivos nuevos, solo confirma que sigue activa en ESE device ──
  app.post('/api/license/check', async (req, res) => {
    try {
      await ensureTable(pool);
      const product = (req.body?.product || 'li-scraper').trim();
      const key = (req.body?.key || '').trim().toUpperCase();
      const deviceId = (req.body?.device_id || '').trim();
      if (!key || !deviceId) return res.status(400).json({ ok: false, reason: 'bad_request' });

      const { rows } = await pool.query(
        `SELECT * FROM ext_licenses WHERE license_key=$1 AND product=$2`, [key, product]);
      const lic = rows[0];
      if (!lic) return res.json({ ok: false, reason: 'not_found' });
      if (lic.status !== 'active') return res.json({ ok: false, reason: 'revoked' });
      const devices = Array.isArray(lic.devices) ? lic.devices : [];
      if (!devices.includes(deviceId)) return res.json({ ok: false, reason: 'device_not_activated' });

      await pool.query(`UPDATE ext_licenses SET last_check_at=NOW() WHERE id=$1`, [lic.id]);
      res.json({ ok: true, support_until: lic.support_until, support_active: new Date(lic.support_until) > new Date() });
    } catch (e) { console.error('[license] check', e.message); res.status(500).json({ ok: false, reason: 'server_error' }); }
  });
}

module.exports = { mount, ensureTable, genKey };
