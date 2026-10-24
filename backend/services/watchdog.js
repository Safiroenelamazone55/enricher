// Agentes de vigilancia: cada agente revisa UNA parte del sistema cada pocos minutos y avisa cuando algo falla.
// No usan IA (no gastan nada): son comprobaciones deterministas contra la base de datos, el servidor y los servicios conectados.
//   estado: ok · warn (atención) · fail (falla) · info (informativo, no genera alerta)
// Una falla se avisa solo tras 2 revisiones seguidas (evita falsas alarmas por un parpadeo) y se resuelve sola cuando vuelve a estar bien.
const os = require('os');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const _ago = d => { if (!d) return 'nunca'; const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };

function _get(url, ms = 12000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = https.get(url, { timeout: ms, headers: { 'User-Agent': 'nova-watchdog' } }, r => {
      let body = ''; r.setEncoding('utf8');
      r.on('data', c => { if (body.length < 400000) body += c; });
      r.on('end', () => resolve({ status: r.statusCode, ms: Date.now() - t0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - t0, error: 'sin respuesta en ' + Math.round(ms / 1000) + ' s' }); });
    req.on('error', e => resolve({ status: 0, ms: Date.now() - t0, error: e.message }));
  });
}

let _logOffset = {};   // archivo → bytes ya leídos (para contar solo errores NUEVOS)

const CHECKS = [
  { key: 'base_datos', name: 'Base de datos', area: 'Servidor', every: 5,
    desc: 'La base de datos responde y no va lenta.',
    async run({ pool }) {
      const t0 = Date.now();
      try { await pool.query('SELECT 1'); } catch (e) { return { status: 'fail', msg: 'La base de datos no responde: ' + e.message }; }
      const ms = Date.now() - t0;
      return ms > 1500 ? { status: 'warn', msg: `La base de datos responde lento (${ms} ms).` } : { status: 'ok', msg: `Responde en ${ms} ms.` };
    } },
  { key: 'servidor', name: 'Servidor (RAM y disco)', area: 'Servidor', every: 10,
    desc: 'Memoria y espacio en disco de la VPS.',
    async run() {
      let ramPct = null, diskPct = null;
      try {
        const mi = fs.readFileSync('/proc/meminfo', 'utf8');
        const tot = +(mi.match(/MemTotal:\s+(\d+)/) || [])[1], av = +(mi.match(/MemAvailable:\s+(\d+)/) || [])[1];
        if (tot && av) ramPct = Math.round((1 - av / tot) * 100);
      } catch (_) { ramPct = Math.round((1 - os.freemem() / os.totalmem()) * 100); }
      try { const out = execSync('df --output=pcent /', { encoding: 'utf8', timeout: 3000 }); diskPct = parseInt(out.trim().split('\n')[1], 10); } catch (_) {}
      const bits = [`RAM ${ramPct == null ? '—' : ramPct + '%'}`, `disco ${diskPct == null ? '—' : diskPct + '%'}`].join(' · ');
      if ((diskPct != null && diskPct >= 95) || (ramPct != null && ramPct >= 95)) return { status: 'fail', msg: `Casi sin recursos: ${bits}.` };
      if ((diskPct != null && diskPct >= 88) || (ramPct != null && ramPct >= 90)) return { status: 'warn', msg: `Recursos al límite: ${bits}.` };
      return { status: 'ok', msg: bits + '.' };
    } },
  { key: 'app_web', name: 'Aplicación web y API', area: 'Conexiones', every: 5,
    desc: 'Que app.novacentrax.com cargue y que la API responda desde internet.',
    async run() {
      const [app, api] = await Promise.all([_get('https://app.novacentrax.com/'), _get('https://api.novacentrax.com/health')]);
      const fails = [];
      if (app.status !== 200 || !/app\.js/.test(app.body || '')) fails.push('la aplicación web no carga (' + (app.error || 'HTTP ' + app.status) + ')');
      if (api.status !== 200) fails.push('la API no responde (' + (api.error || 'HTTP ' + api.status) + ')');
      if (fails.length) return { status: 'fail', msg: 'Desde internet: ' + fails.join(' y ') + '.' };
      return { status: app.ms > 4000 || api.ms > 4000 ? 'warn' : 'ok', msg: `Web ${app.ms} ms · API ${api.ms} ms.` };
    } },
  { key: 'buzones', name: 'Buzones de correo', area: 'Correo', every: 5,
    desc: 'Cada buzón conectado: que el vigilante IMAP lea respuestas y no tenga errores.',
    async run({ pool, uid }) {
      const { rows } = await pool.query(`SELECT email, estado, last_error, last_checked_at FROM lm_mailboxes WHERE user_id=$1 ORDER BY id`, [uid]);
      if (!rows.length) return { status: 'info', msg: 'No hay buzones conectados.' };
      const fails = [], warns = [];
      for (const m of rows) {
        if (m.estado === 'conectado') {
          const stale = !m.last_checked_at || Date.now() - new Date(m.last_checked_at).getTime() > 20 * 60000;
          if (stale) fails.push(`${m.email}: el vigilante no revisa desde hace ${_ago(m.last_checked_at)}`);
          else if (m.last_error) warns.push(`${m.email}: ${String(m.last_error).slice(0, 90)}`);
        } else if (m.estado === 'solo_envio') warns.push(`${m.email}: solo envía, no lee respuestas${m.last_error ? ' (' + String(m.last_error).slice(0, 70) + ')' : ''}`);
        else fails.push(`${m.email}: ${m.estado}${m.last_error ? ' · ' + String(m.last_error).slice(0, 90) : ''}`);
      }
      if (fails.length) return { status: 'fail', msg: fails.join(' | '), detail: { fails, warns } };
      if (warns.length) return { status: 'warn', msg: warns.join(' | '), detail: { warns } };
      return { status: 'ok', msg: `${rows.length} buzón(es) conectado(s) y al día.` };
    } },
  { key: 'envios_email', name: 'Envíos de email', area: 'Correo', every: 10,
    desc: 'Envíos fallidos y correos programados que no salen.',
    async run({ pool, uid }) {
      const { rows: [f] } = await pool.query(`SELECT COUNT(*)::int n FROM lm_messages WHERE user_id=$1 AND estado='failed' AND COALESCE(sent_at, scheduled_at, created_at) > NOW() - INTERVAL '24 hours'`, [uid]).catch(() => ({ rows: [{ n: 0 }] }));
      const { rows: [o] } = await pool.query(`SELECT COUNT(*)::int n, MIN(scheduled_at) first FROM lm_messages WHERE user_id=$1 AND estado='scheduled' AND scheduled_at < NOW() - INTERVAL '30 hours'`, [uid]).catch(() => ({ rows: [{ n: 0 }] }));
      if (f.n >= 5) return { status: 'fail', msg: `${f.n} envíos fallaron en las últimas 24 h.` };
      if (o.n) return { status: 'warn', msg: `${o.n} correo(s) programado(s) llevan más de 30 h sin salir (el más viejo: ${_ago(o.first)}).` };
      if (f.n) return { status: 'warn', msg: `${f.n} envío(s) fallaron en las últimas 24 h.` };
      return { status: 'ok', msg: 'Sin envíos fallidos ni atascados.' };
    } },
  { key: 'rebotes', name: 'Rebotes de correo', area: 'Correo', every: 60,
    desc: 'Porcentaje de rebotes de los últimos 7 días (protege la reputación del dominio).',
    async run({ pool, uid }) {
      const { rows: [r] } = await pool.query(`SELECT COUNT(*) FILTER (WHERE estado IN ('sent','replied','bounced'))::int env, COUNT(*) FILTER (WHERE estado='bounced')::int reb FROM lm_messages WHERE user_id=$1 AND sent_at > NOW() - INTERVAL '7 days'`, [uid]);
      if (r.env < 20) return { status: 'ok', msg: `Pocos envíos esta semana (${r.env}) para medir.` };
      const pct = Math.round((r.reb / r.env) * 1000) / 10;
      if (pct >= 10) return { status: 'fail', msg: `Rebotes altos: ${pct}% (${r.reb} de ${r.env}). Pausa y revisa la lista.` };
      if (pct >= 5) return { status: 'warn', msg: `Rebotes elevados: ${pct}% (${r.reb} de ${r.env}).` };
      return { status: 'ok', msg: `Rebotes ${pct}% (${r.reb} de ${r.env}).` };
    } },
  { key: 'whatsapp', name: 'WhatsApp', area: 'WhatsApp', every: 5,
    desc: 'Líneas vinculadas conectadas y cola de mensajes sin atascos.',
    async run({ pool, uid }) {
      const { rows: lines } = await pool.query(`SELECT id, nombre, numero, estado FROM wa_connections WHERE user_id=$1 AND archivada_at IS NULL ORDER BY id`, [uid]);
      if (!lines.length) return { status: 'info', msg: 'No hay líneas de WhatsApp vinculadas.' };
      const down = lines.filter(l => l.estado !== 'conectado');
      const { rows: [q] } = await pool.query(`SELECT COUNT(*)::int n, MIN(scheduled_at) first FROM wa_messages m JOIN wa_connections c ON c.id=m.connection_id WHERE c.user_id=$1 AND m.estado='programado' AND m.via_cola AND m.scheduled_at < NOW() - INTERVAL '3 hours' AND c.estado='conectado'`, [uid]).catch(() => ({ rows: [{ n: 0 }] }));
      if (down.length) return { status: 'fail', msg: down.map(l => `${l.nombre || 'Línea'} ${l.numero ? '(' + l.numero + ') ' : ''}está ${l.estado === 'esperando_qr' ? 'esperando QR' : 'desconectada'}`).join(' | ') + '. Vuelve a vincularla.' };
      if (q.n) return { status: 'warn', msg: `${q.n} mensaje(s) en cola llevan más de 3 h vencidos (el más viejo: ${_ago(q.first)}).` };
      return { status: 'ok', msg: `${lines.length} línea(s) conectada(s), cola al día.` };
    } },
  { key: 'errores_servidor', name: 'Errores del servidor', area: 'Servidor', every: 5,
    desc: 'Cuenta los errores nuevos en el registro del servidor desde la última revisión.',
    async run() {
      const f = process.env.PM2_ERR_LOG || '/root/.pm2/logs/enricher-backend-error.log';
      let st; try { st = fs.statSync(f); } catch (_) { return { status: 'info', msg: 'No se encontró el registro de errores en este equipo.' }; }
      const prev = _logOffset[f];
      _logOffset[f] = st.size;
      if (prev == null) return { status: 'ok', msg: 'Vigilando el registro de errores desde ahora.' };
      if (st.size < prev) return { status: 'ok', msg: 'Registro reiniciado.' };
      const len = Math.min(st.size - prev, 400000);
      if (!len) return { status: 'ok', msg: 'Sin errores nuevos.' };
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(l => /error|exception|unhandled|ECONNREFUSED|ETIMEDOUT/i.test(l));
      const sample = lines.slice(-1)[0] ? lines.slice(-1)[0].replace(/\s+/g, ' ').slice(0, 140) : '';
      if (lines.length >= 40) return { status: 'fail', msg: `${lines.length} errores nuevos en los últimos minutos. Último: ${sample}` };
      if (lines.length >= 8) return { status: 'warn', msg: `${lines.length} errores nuevos. Último: ${sample}` };
      return { status: 'ok', msg: lines.length ? `${lines.length} error(es) aislado(s).` : 'Sin errores nuevos.' };
    } },
  { key: 'integraciones', name: 'Integraciones pendientes', area: 'Conexiones', every: 60,
    desc: 'Claves o conexiones que faltan y dejan funciones apagadas.',
    async run() {
      const faltan = [];
      if (!process.env.ANTHROPIC_API_KEY) faltan.push('IA de Claude (comentarios de LinkedIn)');
      if (!process.env.MS_CLIENT_ID) faltan.push('Microsoft OAuth (buzones Outlook)');
      return faltan.length ? { status: 'info', msg: 'Sin configurar: ' + faltan.join(', ') + '.' } : { status: 'ok', msg: 'Todas las integraciones configuradas.' };
    } },
];

const META = CHECKS.map(c => ({ key: c.key, name: c.name, area: c.area, desc: c.desc, every: c.every }));

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS watchdog_agents (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE, last_run_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'pendiente', message TEXT NOT NULL DEFAULT '',
    detail JSONB NOT NULL DEFAULT '{}', fail_count INTEGER NOT NULL DEFAULT 0, open_event_id INTEGER, last_alert_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, key))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS watchdog_events (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, severity TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, dismissed BOOLEAN NOT NULL DEFAULT FALSE)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS watchdog_events_user_idx ON watchdog_events (user_id, created_at DESC)`);
}

async function runOne(pool, uid, check, emit) {
  let res;
  try { res = await check.run({ pool, uid }); }
  catch (e) { res = { status: 'fail', msg: 'El agente no pudo revisar: ' + e.message }; }
  const status = ['ok', 'warn', 'fail', 'info'].includes(res.status) ? res.status : 'ok';
  const { rows: [ag] } = await pool.query(`SELECT * FROM watchdog_agents WHERE user_id=$1 AND key=$2`, [uid, check.key]);
  const bad = status === 'warn' || status === 'fail';
  const failCount = bad ? (ag ? ag.fail_count : 0) + 1 : 0;
  let openId = ag ? ag.open_event_id : null, lastAlert = ag ? ag.last_alert_at : null;
  if (bad && failCount >= 2) {
    const worse = ag && ag.status === 'warn' && status === 'fail';
    const due = !lastAlert || Date.now() - new Date(lastAlert).getTime() > 6 * 3600000;
    if (!openId || worse) {
      if (openId) await pool.query(`UPDATE watchdog_events SET resolved_at=NOW() WHERE id=$1`, [openId]);
      const { rows: [ev] } = await pool.query(`INSERT INTO watchdog_events (user_id,key,severity,message) VALUES ($1,$2,$3,$4) RETURNING id`, [uid, check.key, status, res.msg]);
      openId = ev.id; lastAlert = new Date();
      if (emit) emit(uid, 'system_alert', { key: check.key, name: check.name, severity: status, message: res.msg });
    } else if (due) {
      lastAlert = new Date();
      await pool.query(`UPDATE watchdog_events SET message=$2 WHERE id=$1`, [openId, res.msg]);
      if (emit) emit(uid, 'system_alert', { key: check.key, name: check.name, severity: status, message: res.msg, recordatorio: true });
    } else await pool.query(`UPDATE watchdog_events SET message=$2 WHERE id=$1`, [openId, res.msg]);
  }
  if (!bad && openId) {
    await pool.query(`UPDATE watchdog_events SET resolved_at=NOW() WHERE id=$1`, [openId]);
    openId = null;
    if (emit) emit(uid, 'system_alert', { key: check.key, name: check.name, severity: 'ok', message: 'Resuelto: ' + res.msg });
  }
  await pool.query(`
    INSERT INTO watchdog_agents (user_id,key,last_run_at,status,message,detail,fail_count,open_event_id,last_alert_at) VALUES ($1,$2,NOW(),$3,$4,$5::jsonb,$6,$7,$8)
    ON CONFLICT (user_id,key) DO UPDATE SET last_run_at=NOW(), status=$3, message=$4, detail=$5::jsonb, fail_count=$6, open_event_id=$7, last_alert_at=$8`,
    [uid, check.key, status, res.msg, JSON.stringify(res.detail || {}), failCount, openId, lastAlert]);
  return { key: check.key, status, message: res.msg };
}

async function _workspaces(pool) {
  const { rows } = await pool.query(`SELECT DISTINCT user_id FROM (SELECT user_id FROM lm_mailboxes UNION SELECT user_id FROM wa_connections UNION SELECT user_id FROM watchdog_agents) x WHERE user_id IS NOT NULL`);
  return rows.map(r => r.user_id);
}

async function tick(pool, emit) {
  const uids = await _workspaces(pool);
  for (const uid of uids) {
    const { rows } = await pool.query(`SELECT key, enabled, last_run_at FROM watchdog_agents WHERE user_id=$1`, [uid]);
    const st = new Map(rows.map(r => [r.key, r]));
    for (const c of CHECKS) {
      const s = st.get(c.key);
      if (s && s.enabled === false) continue;
      if (s && s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < c.every * 60000 - 20000) continue;
      await runOne(pool, uid, c, emit);
    }
  }
}

function startWatchdog(pool, { emit } = {}) {
  init(pool).then(() => {
    setTimeout(() => tick(pool, emit).catch(e => console.warn('[watchdog]', e.message)), 45000);
    setInterval(() => tick(pool, emit).catch(e => console.warn('[watchdog]', e.message)), 60000);
    console.log('[watchdog] agentes de vigilancia activos (' + CHECKS.length + ')');
  }).catch(e => console.warn('[watchdog] no iniciado:', e.message));
}

// Rutas: estado de los agentes, revisar ahora, activar/desactivar y descartar un aviso.
function mount(app, { pool, requireAuth }) {
  app.get('/api/watchdog', requireAuth, async (req, res) => {
    try {
      const uid = req.workspaceOwnerId;
      const { rows } = await pool.query(`SELECT key, enabled, last_run_at, status, message, detail, open_event_id FROM watchdog_agents WHERE user_id=$1`, [uid]);
      const by = new Map(rows.map(r => [r.key, r]));
      const agents = META.map(m => Object.assign({}, m, by.get(m.key) || { enabled: true, status: 'pendiente', message: 'Aún no se ha revisado.', last_run_at: null }));
      const { rows: events } = await pool.query(`SELECT id, key, severity, message, created_at, resolved_at, dismissed FROM watchdog_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`, [uid]);
      res.json({ agents, events });
    } catch (e) { console.error('[watchdog] GET', e.message); res.status(500).json({ error: 'No se pudo leer el estado de los agentes' }); }
  });
  app.post('/api/watchdog/:key/run', requireAuth, async (req, res) => {
    const c = CHECKS.find(x => x.key === req.params.key); if (!c) return res.status(404).json({ error: 'Agente no encontrado' });
    try { res.json(await runOne(pool, req.workspaceOwnerId, c, null)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/watchdog/run-all', requireAuth, async (req, res) => {
    try { const out = []; for (const c of CHECKS) out.push(await runOne(pool, req.workspaceOwnerId, c, null)); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/watchdog/:key', requireAuth, async (req, res) => {
    const c = CHECKS.find(x => x.key === req.params.key); if (!c) return res.status(404).json({ error: 'Agente no encontrado' });
    try {
      await pool.query(`INSERT INTO watchdog_agents (user_id,key,enabled) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET enabled=$3`, [req.workspaceOwnerId, c.key, !!(req.body || {}).enabled]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/watchdog/events/:id/dismiss', requireAuth, async (req, res) => {
    try { await pool.query(`UPDATE watchdog_events SET dismissed=TRUE WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id), req.workspaceOwnerId]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { startWatchdog, runOne, CHECKS, META, init, mount };
