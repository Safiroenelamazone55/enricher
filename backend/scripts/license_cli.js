#!/usr/bin/env node
'use strict';
// CLI para gestionar licencias del LinkedIn Sales Scraper, sin pasar por Nova.
// Uso (desde backend/, en el servidor):
//   node scripts/license_cli.js generate <email> [maxDevices=2] [nota]
//   node scripts/license_cli.js list
//   node scripts/license_cli.js revoke <KEY>
//   node scripts/license_cli.js activate <KEY>      (reactivar una revocada)
//   node scripts/license_cli.js reset-devices <KEY>  (libera los dispositivos activados, p.ej. el comprador cambió de PC)
//   node scripts/license_cli.js renew <KEY> [meses=9]  (extiende el soporte/actualizaciones — NO afecta si la extensión funciona, es venta de pago único)
require('dotenv').config();
const { pool } = require('../db');
const { ensureTable, genKey } = require('../services/extScraperLicense');

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  await ensureTable(pool);

  if (cmd === 'generate') {
    const [email, maxDevicesArg, ...noteParts] = args;
    if (!email) { console.error('Uso: generate <email> [maxDevices=2] [nota]'); process.exit(1); }
    const maxDevices = parseInt(maxDevicesArg, 10) || 2;
    const note = noteParts.join(' ');
    const key = genKey();
    const { rows } = await pool.query(
      `INSERT INTO ext_licenses (product, license_key, email, max_devices, note) VALUES ('li-scraper',$1,$2,$3,$4) RETURNING support_until`,
      [key, email, maxDevices, note]);
    console.log('Licencia creada:');
    console.log('  Clave:        ', key);
    console.log('  Email:        ', email);
    console.log('  Max. equipos: ', maxDevices);
    console.log('  Soporte hasta:', rows[0].support_until.toISOString().slice(0, 10), '(incluido en el pago único; después es renovación opcional)');
  } else if (cmd === 'list') {
    const { rows } = await pool.query(
      `SELECT license_key, email, status, max_devices, jsonb_array_length(devices) AS n_devices, note, created_at, last_check_at, support_until,
              (support_until > NOW()) AS support_active
       FROM ext_licenses WHERE product='li-scraper' ORDER BY created_at DESC`);
    if (!rows.length) console.log('(sin licencias todavía)');
    for (const r of rows) {
      const soporte = r.support_active ? `soporte hasta ${r.support_until.toISOString().slice(0, 10)}` : `soporte vencido (${r.support_until.toISOString().slice(0, 10)})`;
      console.log(`${r.license_key}  ${r.status.padEnd(8)}  ${r.email.padEnd(28)}  ${r.n_devices}/${r.max_devices} equipos  ${soporte}  ${r.note || ''}`);
    }
  } else if (cmd === 'renew') {
    const [key, monthsArg] = args;
    if (!key) { console.error('Uso: renew <KEY> [meses=9]'); process.exit(1); }
    const months = parseInt(monthsArg, 10) || 9;
    const { rows, rowCount } = await pool.query(
      `UPDATE ext_licenses SET support_until = GREATEST(support_until, NOW()) + ($2 || ' months')::interval WHERE license_key=$1 RETURNING support_until`,
      [key.toUpperCase(), months]);
    console.log(rowCount ? `Soporte extendido hasta ${rows[0].support_until.toISOString().slice(0, 10)}.` : 'No se encontró esa clave.');
  } else if (cmd === 'revoke') {
    const [key] = args;
    if (!key) { console.error('Uso: revoke <KEY>'); process.exit(1); }
    const { rowCount } = await pool.query(`UPDATE ext_licenses SET status='revoked' WHERE license_key=$1`, [key.toUpperCase()]);
    console.log(rowCount ? 'Licencia revocada.' : 'No se encontró esa clave.');
  } else if (cmd === 'activate') {
    const [key] = args;
    if (!key) { console.error('Uso: activate <KEY>'); process.exit(1); }
    const { rowCount } = await pool.query(`UPDATE ext_licenses SET status='active' WHERE license_key=$1`, [key.toUpperCase()]);
    console.log(rowCount ? 'Licencia reactivada.' : 'No se encontró esa clave.');
  } else if (cmd === 'reset-devices') {
    const [key] = args;
    if (!key) { console.error('Uso: reset-devices <KEY>'); process.exit(1); }
    const { rowCount } = await pool.query(`UPDATE ext_licenses SET devices='[]'::jsonb WHERE license_key=$1`, [key.toUpperCase()]);
    console.log(rowCount ? 'Dispositivos liberados — se puede activar en un equipo nuevo.' : 'No se encontró esa clave.');
  } else {
    console.log('Comandos: generate <email> [maxDevices] [nota] | list | revoke <KEY> | activate <KEY> | reset-devices <KEY>');
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
