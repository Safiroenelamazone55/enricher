'use strict';
// Módulo «Soluciones»: gestión (dentro de Nova, solo para la dueña/admin) de las
// licencias de los productos de pago que se venden por fuera de Nova — por ahora
// el LinkedIn Sales Scraper. Los endpoints que valida la EXTENSIÓN del comprador
// son públicos y viven en extScraperLicense.js; estos de aquí SÍ requieren sesión
// de Nova, porque son para que Jenny vea/genere/revoque desde el software.
const { ensureTable, genKey } = require('./extScraperLicense');

const PRODUCTS = [
  { id: 'li-scraper', nombre: 'LinkedIn Sales Scraper', tipo: 'Extensión de Chrome', precio: 'USD 39 (pago único)' },
];

function mount(app, { pool, requireAuth }) {
  app.get('/api/soluciones/products', requireAuth, (req, res) => res.json(PRODUCTS));

  app.get('/api/soluciones/licenses', requireAuth, async (req, res) => {
    try {
      await ensureTable(pool);
      const product = (req.query.product || 'li-scraper').trim();
      const { rows } = await pool.query(
        `SELECT license_key, email, status, max_devices, devices, note, created_at, last_check_at, support_until
         FROM ext_licenses WHERE product=$1 ORDER BY created_at DESC`, [product]);
      res.json(rows);
    } catch (e) { console.error('[soluciones] list', e.message); res.status(500).json({ error: 'No se pudieron cargar las licencias' }); }
  });

  app.post('/api/soluciones/licenses', requireAuth, async (req, res) => {
    try {
      await ensureTable(pool);
      const product = (req.body?.product || 'li-scraper').trim();
      const email = String(req.body?.email || '').trim();
      const maxDevices = Math.max(1, parseInt(req.body?.max_devices, 10) || 2);
      const note = String(req.body?.note || '').trim();
      if (!email) return res.status(400).json({ error: 'Falta el email del comprador' });
      const key = genKey();
      const { rows } = await pool.query(
        `INSERT INTO ext_licenses (product, license_key, email, max_devices, note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [product, key, email, maxDevices, note]);
      res.status(201).json(rows[0]);
    } catch (e) { console.error('[soluciones] create', e.message); res.status(500).json({ error: 'No se pudo crear la licencia' }); }
  });

  app.post('/api/soluciones/licenses/:key/revoke', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`UPDATE ext_licenses SET status='revoked' WHERE license_key=$1 RETURNING *`, [req.params.key.toUpperCase()]);
      if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error al revocar' }); }
  });

  app.post('/api/soluciones/licenses/:key/activate', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`UPDATE ext_licenses SET status='active' WHERE license_key=$1 RETURNING *`, [req.params.key.toUpperCase()]);
      if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error al reactivar' }); }
  });

  app.post('/api/soluciones/licenses/:key/reset-devices', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`UPDATE ext_licenses SET devices='[]'::jsonb WHERE license_key=$1 RETURNING *`, [req.params.key.toUpperCase()]);
      if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error al reiniciar equipos' }); }
  });

  app.post('/api/soluciones/licenses/:key/renew', requireAuth, async (req, res) => {
    try {
      const months = Math.max(1, parseInt(req.body?.months, 10) || 9);
      const { rows } = await pool.query(
        `UPDATE ext_licenses SET support_until = GREATEST(support_until, NOW()) + ($2 || ' months')::interval WHERE license_key=$1 RETURNING *`,
        [req.params.key.toUpperCase(), months]);
      if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error al renovar soporte' }); }
  });
}

module.exports = { mount };
