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

// ── Registro del ERROR EXACTO (pedido explícito 2026-10-26: «debe quedar un registro de exactamente el error que ocurre, así puedo volver y
// optimizar el sistema»). Antes solo se guardaba «N errores… Último: <140 caracteres>». Ahora se leen los bloques completos del registro de errores
// (líneas de texto con su stack, o líneas JSON de pino), se agrupan por «firma» (el mismo error con otros números/ids es el mismo error) y se guarda
// el mensaje COMPLETO, el stack, dónde ocurre (archivo:línea), cuántas veces y cuándo. Queda en el aviso (detalle) y en un registro permanente.
const _crypto = require('crypto');
const _ERR_LINE = /error|exception|unhandled|ECONNREFUSED|ETIMEDOUT/i;
function _normMsg(m) {
  return String(m || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID').replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, 'EMAIL')
    .replace(/\b\d+@(?:lid|s\.whatsapp\.net|g\.us)\b/g, 'JID').replace(/0x[0-9a-f]+/gi, 'HEX').replace(/\b[0-9a-f]{12,}\b/gi, 'HEX').replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
function _origen(frames) {
  const fr = frames || [];
  const own = fr.find(f => !/node_modules|node:internal/.test(f));
  const pick = f => { const m = String(f || '').match(/\(?([^()\s]+?):(\d+):\d+\)?\s*$/); return m ? { file: m[1], line: m[2] } : null; };
  if (own) { const o = pick(own); return o ? (o.file.split(/[\\/]/).slice(-2).join('/') + ':' + o.line) : ''; }
  // Todo el stack es de librerías: se dice de cuál («libsignal › src/session_cipher.js:261»), que es lo que hay que mirar o actualizar.
  const f0 = fr[0] || '', pk = f0.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/), o = pick(f0);
  return o ? ((pk ? pk[1].replace(/\\/g, '/') + ' › ' : '') + o.file.split(/node_modules[\\/][^\\/]+[\\/]/).pop().split(/[\\/]/).slice(-2).join('/') + ':' + o.line) : '';
}
function parseErrores(text) {
  const out = [];
  let cur = null;
  const push = (head, frames) => { if (head) out.push({ head: String(head).trim().slice(0, 2000), frames: (frames || []).slice(0, 14) }); };
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (!l.trim()) continue;
    if (l[0] === '{') {                                       // pino: {"level":50,...,"err":{"type","message","stack"},"msg":"…"}
      let j; try { j = JSON.parse(l); } catch (_) { j = null; }
      if (j && typeof j === 'object') {
        cur = null;
        if (Number(j.level) >= 50) {
          const e = j.err || j.error || {};
          const tipo = e.type || e.name || 'Error', msg = e.message || j.msg || '';
          push(`${tipo}: ${msg}${j.msg && e.message && j.msg !== e.message ? '  [' + j.msg + ']' : ''}`, String(e.stack || '').split('\n').filter(x => /^\s+at\s/.test(x)).map(x => x.trim()));
        }
        continue;
      }
    }
    if (/^\s+at\s/.test(l) && cur) { cur.frames.push(l.trim()); continue; }   // línea de stack del error anterior
    if (_ERR_LINE.test(l)) { cur = { head: l.trim().slice(0, 2000), frames: [] }; out.push(cur); continue; }
    cur = null;
  }
  out.forEach(b => { b.frames = (b.frames || []).slice(0, 14); });
  return out;
}
// Agrupa los bloques por firma: {firma, tipo, mensaje, stack[], origen, veces}
function agruparErrores(blocks) {
  const by = new Map();
  for (const b of blocks) {
    const m = b.head.match(/\b([A-Za-z_$][\w$]*(?:Error|Exception))\b/);   // el primer «XxxError» del texto (p. ej. «Session error:SessionError: …» → SessionError)
    const tipo = m ? m[1] : ((b.head.match(/\b(ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND)\b/) || [])[1] || 'Error');
    const firma = _crypto.createHash('md5').update(tipo + '|' + _normMsg(b.head)).digest('hex').slice(0, 12);
    let g = by.get(firma);
    if (!g) { g = { firma, tipo, mensaje: b.head, stack: b.frames, origen: _origen(b.frames), veces: 0 }; by.set(firma, g); }
    g.veces++;
    if (b.frames.length > g.stack.length) { g.stack = b.frames; g.origen = _origen(b.frames); }
  }
  return [...by.values()].sort((a, z) => z.veces - a.veces);
}
function _mergeErrores(a, b) {
  const by = new Map();
  for (const e of [].concat(a || [], b || [])) {
    if (!e || !e.firma) continue;
    const o = by.get(e.firma);
    if (!o) by.set(e.firma, { ...e }); else { o.veces += e.veces || 0; if ((e.stack || []).length > (o.stack || []).length) { o.stack = e.stack; o.origen = e.origen; } }
  }
  return [...by.values()].sort((x, y) => y.veces - x.veces).slice(0, 15);
}

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
    async run({ pool, uid }) {
      const f = process.env.PM2_ERR_LOG || '/root/.pm2/logs/enricher-backend-error.log';
      let st; try { st = fs.statSync(f); } catch (_) { return { status: 'info', msg: 'No se encontró el registro de errores en este equipo.' }; }
      const prev = _logOffset[f];
      _logOffset[f] = st.size;
      if (prev == null) {
        // Primera lectura tras arrancar: si el registro de errores de este espacio está vacío, se siembra con lo que ya hay en el log del servidor
        // (sin generar aviso), para ver desde el primer día qué errores ocurren. Si ya tenía datos, solo se empieza a vigilar (no se cuenta dos veces).
        try {
          const { rows: [c0] } = await pool.query('SELECT COUNT(*)::int n FROM error_registry WHERE user_id=$1', [uid]);
          if (!c0.n && st.size) {
            const ln = Math.min(st.size, 300000), fd0 = fs.openSync(f, 'r'), b0 = Buffer.alloc(ln); fs.readSync(fd0, b0, 0, ln, st.size - ln); fs.closeSync(fd0);
            const gr = agruparErrores(parseErrores(b0.toString('utf8')));
            for (const g of gr.slice(0, 40)) await pool.query(
              `INSERT INTO error_registry (user_id, firma, tipo, mensaje, stack, origen, veces) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, firma) DO NOTHING`,
              [uid, g.firma, g.tipo, g.mensaje, (g.stack || []).join('\n').slice(0, 6000), g.origen || '', g.veces]);
            return { status: 'ok', msg: `Vigilando el registro de errores. Se anotaron ${gr.length} tipo(s) de error que ya estaban en el servidor.` };
          }
        } catch (e) { console.warn('[watchdog] siembra de errores:', e.message); }
        return { status: 'ok', msg: 'Vigilando el registro de errores desde ahora.' };
      }
      if (st.size < prev) return { status: 'ok', msg: 'Registro reiniciado.' };
      const len = Math.min(st.size - prev, 400000);
      if (!len) return { status: 'ok', msg: 'Sin errores nuevos.' };
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const blocks = parseErrores(buf.toString('utf8'));
      const grupos = agruparErrores(blocks);
      const n = blocks.length;
      if (!n) return { status: 'ok', msg: 'Sin errores nuevos.' };
      // Registro permanente: cada error distinto con su mensaje completo, stack, origen, veces y fechas (un error resuelto que reaparece se reabre).
      try {
        for (const g of grupos.slice(0, 40)) {
          await pool.query(
            `INSERT INTO error_registry (user_id, firma, tipo, mensaje, stack, origen, veces) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (user_id, firma) DO UPDATE SET veces = error_registry.veces + EXCLUDED.veces, ultima_vez = NOW(),
               estado = CASE WHEN error_registry.estado = 'resuelto' THEN 'abierto' ELSE error_registry.estado END,
               stack = CASE WHEN length(EXCLUDED.stack) > length(error_registry.stack) THEN EXCLUDED.stack ELSE error_registry.stack END,
               origen = CASE WHEN error_registry.origen = '' THEN EXCLUDED.origen ELSE error_registry.origen END`,
            [uid, g.firma, g.tipo, g.mensaje, (g.stack || []).join('\n').slice(0, 6000), g.origen || '', g.veces]);
        }
      } catch (e) { console.warn('[watchdog] registro de errores:', e.message); }
      const top = grupos[0], corto = top ? top.mensaje.replace(/\s+/g, ' ').slice(0, 110) : '';
      const detail = { errores: grupos.slice(0, 15), total: n, hasta: new Date().toISOString() };
      const resumen = `${grupos.length} tipo(s) de error distinto(s)${top ? `. El principal (×${top.veces}): ${corto}${top.origen ? ' — en ' + top.origen : ''}` : ''}`;
      if (n >= 40) return { status: 'fail', msg: `${n} errores nuevos en los últimos minutos. ${resumen}`, detail };
      if (n >= 8) return { status: 'warn', msg: `${n} errores nuevos. ${resumen}`, detail };
      return { status: 'ok', msg: `${n} error(es) aislado(s). ${resumen}`, detail };
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
  // Detalle exacto del aviso (errores completos con stack) y registro permanente de errores distintos (ver parseErrores).
  await pool.query(`ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS error_registry (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, firma TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT '', mensaje TEXT NOT NULL DEFAULT '', stack TEXT NOT NULL DEFAULT '', origen TEXT NOT NULL DEFAULT '',
    veces INTEGER NOT NULL DEFAULT 0, primera_vez TIMESTAMPTZ NOT NULL DEFAULT NOW(), ultima_vez TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    estado TEXT NOT NULL DEFAULT 'abierto', nota TEXT NOT NULL DEFAULT '', UNIQUE (user_id, firma))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS error_registry_user_idx ON error_registry (user_id, estado, ultima_vez DESC)`);
}

// Actualiza un aviso abierto: mensaje nuevo y el detalle acumulado (los errores de cada revisión se suman por firma).
async function _updEvent(pool, id, res) {
  if (!res.detail || !res.detail.errores) { await pool.query(`UPDATE watchdog_events SET message=$2 WHERE id=$1`, [id, res.msg]); return; }
  const { rows: [e] } = await pool.query(`SELECT detail FROM watchdog_events WHERE id=$1`, [id]);
  const det = { ...res.detail, errores: _mergeErrores((e && e.detail && e.detail.errores) || [], res.detail.errores), total: ((e && e.detail && e.detail.total) || 0) + (res.detail.total || 0) };
  await pool.query(`UPDATE watchdog_events SET message=$2, detail=$3::jsonb WHERE id=$1`, [id, res.msg, JSON.stringify(det)]);
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
      // El aviso nace tras 2 revisiones malas: el detalle junta lo de la revisión anterior y lo de esta.
      const _prev = (ag && ag.detail && ag.detail.errores) || [];
      const _det = res.detail ? { ...res.detail, errores: _mergeErrores(_prev, res.detail.errores) } : {};
      const { rows: [ev] } = await pool.query(`INSERT INTO watchdog_events (user_id,key,severity,message,detail) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`, [uid, check.key, status, res.msg, JSON.stringify(_det)]);
      openId = ev.id; lastAlert = new Date();
      if (emit) emit(uid, 'system_alert', { key: check.key, name: check.name, severity: status, message: res.msg });
    } else if (due) {
      lastAlert = new Date();
      await _updEvent(pool, openId, res);
      if (emit) emit(uid, 'system_alert', { key: check.key, name: check.name, severity: status, message: res.msg, recordatorio: true });
    } else await _updEvent(pool, openId, res);
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
      const { rows: events } = await pool.query(`SELECT id, key, severity, message, detail, created_at, resolved_at, dismissed FROM watchdog_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`, [uid]);
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
  // Registro permanente de errores distintos (con mensaje completo, stack, origen, veces y fechas) y su seguimiento.
  app.get('/api/watchdog/errors', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, tipo, mensaje, stack, origen, veces, primera_vez, ultima_vez, estado, nota FROM error_registry WHERE user_id=$1
          ORDER BY (estado='abierto') DESC, ultima_vez DESC LIMIT 150`, [req.workspaceOwnerId]);
      res.json(rows);
    } catch (e) { console.error('[watchdog] errors', e.message); res.status(500).json({ error: 'No se pudo leer el registro de errores' }); }
  });
  app.patch('/api/watchdog/errors/:id', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, sets = [], vals = [parseInt(req.params.id), req.workspaceOwnerId];
      if (['abierto', 'resuelto', 'ignorado'].includes(b.estado)) sets.push(`estado=$${vals.push(b.estado)}`);
      if (typeof b.nota === 'string') sets.push(`nota=$${vals.push(b.nota.slice(0, 1000))}`);
      if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
      const r = await pool.query(`UPDATE error_registry SET ${sets.join(',')} WHERE id=$1 AND user_id=$2`, vals);
      res.json({ ok: true, actualizado: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/watchdog/events/:id/dismiss', requireAuth, async (req, res) => {
    try { await pool.query(`UPDATE watchdog_events SET dismissed=TRUE WHERE id=$1 AND user_id=$2`, [parseInt(req.params.id), req.workspaceOwnerId]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { startWatchdog, runOne, CHECKS, META, init, mount, parseErrores, agruparErrores };
