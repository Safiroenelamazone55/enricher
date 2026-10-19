'use strict';
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Cola de envío de WhatsApp: los mensajes salen AL RITMO de cada línea (como el buzón de correo) y nunca se estancan.
//
//  · Los mensajes en cola y los programados viven en wa_messages con estado 'programado' (el chat ya sabe mostrarlos y cancelarlos).
//      via_cola = TRUE  → sale al ritmo de la línea: intervalo (con variación), ventana horaria, días y tope diario.
//      via_cola = FALSE → programado por una persona a una hora exacta: sale a esa hora (sin ritmo), pero con los mismos reintentos.
//  · Un mensaje de cola por línea y por pasada; el siguiente no sale hasta pasado el intervalo desde el anterior.
//  · Cada envío usa un id de WhatsApp generado ANTES: si algo falla a mitad, el reintento usa el mismo id y no se duplica.
//  · Fallos según su tipo: línea caída (espera sin gastar intentos) · número sin WhatsApp (se marca y sigue) · límite de WhatsApp
//    (pausa la línea para protegerla) · otros (reintentos 2/5/15 min). Un mensaje con problema NUNCA frena a los demás.
//  · Cortacircuitos: 3 fallos seguidos pausan SOLO esa línea y lo dice; los mensajes quedan en cola, no se pierden.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const waSvc = require('./waService');

const DEF = { cola_activa: true, intervalo_min: 40, jitter_pct: 30, tope_diario: 15, rampa_on: false, rampa_inicio: 5, rampa_paso: 5, rampa_desde: null, hora_ini: 9, hora_fin: 18, tz: 'America/Lima', dias: '1111100', pausada: false, pausa_motivo: '', fallos_seguidos: 0, proximo_envio_at: null };
const MIN_INTERVALO_MS = 3 * 60 * 1000;     // nunca más rápido que 1 mensaje cada 3 min por línea, aunque se configure menos
const MAX_INTENTOS = 3;
const BACKOFF_MIN = [2, 5, 15];

// ── Zona horaria / ventana ──────────────────────────────────────────────────────────────────────────────────────
const _fmtCache = new Map();
function _fmt(tz) {
  let f = _fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); _fmtCache.set(tz, f); }
  return f;
}
const _DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function partes(date, tz) {
  const o = {};
  _fmt(tz).formatToParts(date).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: o.hour === '24' ? 0 : +o.hour, mi: +o.minute, dow: _DOW[o.weekday] };
}
function _offsetMin(tz, date) {
  const p = partes(date, tz);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60000) * 60000) / 60000;
}
// Hora local (y-mo-d h:mi) en la zona tz → instante real (UTC). Maneja el cambio de horario de verano.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = _offsetMin(tz, new Date(guess));
  let t = guess - off * 60000;
  const off2 = _offsetMin(tz, new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}
const _dayKey = (date, tz) => { const p = partes(date, tz); return p.y + '-' + p.mo + '-' + p.d; };
function enVentana(date, S) {
  const p = partes(date, S.tz);
  return S.dias[p.dow] === '1' && p.h >= S.hora_ini && p.h < S.hora_fin;
}
// Primer instante >= date que cae dentro de la ventana (día permitido y entre hora_ini y hora_fin).
function ajustarVentana(date, S) {
  let t = new Date(date);
  for (let i = 0; i < 16; i++) {
    const p = partes(t, S.tz);
    const permitido = S.dias[p.dow] === '1';
    if (permitido && p.h >= S.hora_ini && p.h < S.hora_fin) return t;
    if (permitido && p.h < S.hora_ini) return zonedToUtc(p.y, p.mo, p.d, S.hora_ini, 0, S.tz);
    // fuera de horario o día no permitido → inicio de la siguiente jornada (se parte del mediodía de mañana para no tropezar con el cambio de hora)
    const manana = new Date(zonedToUtc(p.y, p.mo, p.d, 12, 0, S.tz).getTime() + 24 * 3600 * 1000);
    const q = partes(manana, S.tz);
    t = zonedToUtc(q.y, q.mo, q.d, S.hora_ini, 0, S.tz);
  }
  return t;
}
function _inicioDiaSiguiente(date, S) {
  const p = partes(date, S.tz);
  const manana = new Date(zonedToUtc(p.y, p.mo, p.d, 12, 0, S.tz).getTime() + 24 * 3600 * 1000);
  const q = partes(manana, S.tz);
  return zonedToUtc(q.y, q.mo, q.d, 0, 0, S.tz);
}
function inicioDiaLocal(date, tz) { const p = partes(date, tz); return zonedToUtc(p.y, p.mo, p.d, 0, 0, tz); }


// ── Zona horaria del destinatario, por el prefijo telefónico de su número ─────────────────────────────────────────
// La ventana de envío se mide en la hora LOCAL del contacto: escribirle a un contacto de España a las 5 a. m. (las 10 p. m. en Lima) es mala
// práctica y más sospechoso para WhatsApp. Países con varias zonas usan su zona principal (+1 → Nueva York). Sin prefijo conocido → zona de la línea.
const _CC = { '1': 'America/New_York', '7': 'Europe/Moscow', '20': 'Africa/Cairo', '27': 'Africa/Johannesburg', '30': 'Europe/Athens', '31': 'Europe/Amsterdam', '32': 'Europe/Brussels', '33': 'Europe/Paris', '34': 'Europe/Madrid', '36': 'Europe/Budapest', '39': 'Europe/Rome', '40': 'Europe/Bucharest', '41': 'Europe/Zurich', '43': 'Europe/Vienna', '44': 'Europe/London', '45': 'Europe/Copenhagen', '46': 'Europe/Stockholm', '47': 'Europe/Oslo', '48': 'Europe/Warsaw', '49': 'Europe/Berlin',
  '51': 'America/Lima', '52': 'America/Mexico_City', '53': 'America/Havana', '54': 'America/Argentina/Buenos_Aires', '55': 'America/Sao_Paulo', '56': 'America/Santiago', '57': 'America/Bogota', '58': 'America/Caracas', '60': 'Asia/Kuala_Lumpur', '61': 'Australia/Sydney', '62': 'Asia/Jakarta', '63': 'Asia/Manila', '64': 'Pacific/Auckland', '65': 'Asia/Singapore', '66': 'Asia/Bangkok', '81': 'Asia/Tokyo', '82': 'Asia/Seoul', '84': 'Asia/Ho_Chi_Minh', '86': 'Asia/Shanghai', '90': 'Europe/Istanbul', '91': 'Asia/Kolkata', '92': 'Asia/Karachi', '93': 'Asia/Kabul', '94': 'Asia/Colombo', '98': 'Asia/Tehran',
  '212': 'Africa/Casablanca', '213': 'Africa/Algiers', '216': 'Africa/Tunis', '233': 'Africa/Accra', '234': 'Africa/Lagos', '254': 'Africa/Nairobi', '351': 'Europe/Lisbon', '352': 'Europe/Luxembourg', '353': 'Europe/Dublin', '354': 'Atlantic/Reykjavik', '358': 'Europe/Helsinki', '370': 'Europe/Vilnius', '371': 'Europe/Riga', '372': 'Europe/Tallinn', '380': 'Europe/Kyiv', '420': 'Europe/Prague', '421': 'Europe/Bratislava',
  '502': 'America/Guatemala', '503': 'America/El_Salvador', '504': 'America/Tegucigalpa', '505': 'America/Managua', '506': 'America/Costa_Rica', '507': 'America/Panama', '591': 'America/La_Paz', '593': 'America/Guayaquil', '595': 'America/Asuncion', '598': 'America/Montevideo', '966': 'Asia/Riyadh', '971': 'Asia/Dubai', '972': 'Asia/Jerusalem', '974': 'Asia/Qatar' };
function tzDeJid(jid) {
  const d = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!String(jid || '').includes('@s.whatsapp.net') && !/^\d+$/.test(String(jid || ''))) return '';   // @lid y grupos: sin número real, sin zona
  if (d.length < 8) return '';
  for (const n of [3, 2, 1]) { const z = _CC[d.slice(0, n)]; if (z) return z; }
  return '';
}

// ── Ajustes por línea ───────────────────────────────────────────────────────────────────────────────────────────
function _validTz(z) { try { if (typeof z !== 'string' || !z || z.length > 64) return false; new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (_) { return false; } }
async function getSettings(pool, connId) {
  let { rows: [s] } = await pool.query('SELECT * FROM wa_line_settings WHERE connection_id=$1', [connId]);
  if (!s) {
    // Primera vez: hereda la zona horaria del workspace (la de «Configuración → Envío») si existe.
    let tz = DEF.tz;
    try { const { rows: [c] } = await pool.query(`SELECT cfg.timezone FROM wa_connections w LEFT JOIN lm_send_settings cfg ON cfg.user_id = w.user_id WHERE w.id=$1`, [connId]); if (c && _validTz(c.timezone)) tz = c.timezone; } catch (_) {}
    await pool.query('INSERT INTO wa_line_settings (connection_id, tz) VALUES ($1,$2) ON CONFLICT (connection_id) DO NOTHING', [connId, tz]);
    ({ rows: [s] } = await pool.query('SELECT * FROM wa_line_settings WHERE connection_id=$1', [connId]));
  }
  return Object.assign({}, DEF, s);
}
function _num(v, min, max, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; }
async function saveSettings(pool, connId, b) {
  const cur = await getSettings(pool, connId);
  const n = {
    cola_activa: b.cola_activa === undefined ? cur.cola_activa : !!b.cola_activa,
    intervalo_min: _num(b.intervalo_min, 3, 720, cur.intervalo_min),
    jitter_pct: _num(b.jitter_pct, 0, 80, cur.jitter_pct),
    tope_diario: _num(b.tope_diario, 1, 500, cur.tope_diario),
    rampa_on: b.rampa_on === undefined ? cur.rampa_on : !!b.rampa_on,
    rampa_inicio: _num(b.rampa_inicio, 1, 500, cur.rampa_inicio),
    rampa_paso: _num(b.rampa_paso, 0, 200, cur.rampa_paso),
    hora_ini: _num(b.hora_ini, 0, 23, cur.hora_ini),
    hora_fin: _num(b.hora_fin, 1, 24, cur.hora_fin),
    tz: b.tz === undefined ? cur.tz : (_validTz(b.tz) ? b.tz : cur.tz),
    dias: (typeof b.dias === 'string' && /^[01]{7}$/.test(b.dias) && b.dias.includes('1')) ? b.dias : cur.dias,
  };
  if (n.hora_fin <= n.hora_ini) n.hora_fin = Math.min(24, n.hora_ini + 1);
  // La rampa arranca el día que se enciende (si antes estaba apagada).
  const rampaDesde = (n.rampa_on && !cur.rampa_on) ? 'CURRENT_DATE' : (n.rampa_on ? 'rampa_desde' : 'NULL');
  await pool.query(
    `UPDATE wa_line_settings SET cola_activa=$2, intervalo_min=$3, jitter_pct=$4, tope_diario=$5, rampa_on=$6, rampa_inicio=$7, rampa_paso=$8, rampa_desde=${rampaDesde},
            hora_ini=$9, hora_fin=$10, tz=$11, dias=$12, updated_at=NOW() WHERE connection_id=$1`,
    [connId, n.cola_activa, n.intervalo_min, n.jitter_pct, n.tope_diario, n.rampa_on, n.rampa_inicio, n.rampa_paso, n.hora_ini, n.hora_fin, n.tz, n.dias]);
  await replanificar(pool, connId);
  return getSettings(pool, connId);
}
async function pausarLinea(pool, connId, motivo) {
  await getSettings(pool, connId);
  await pool.query(`UPDATE wa_line_settings SET pausada=TRUE, pausa_motivo=$2, updated_at=NOW() WHERE connection_id=$1`, [connId, String(motivo || '').slice(0, 300)]);
  console.warn(`[wa-cola] línea ${connId} PAUSADA: ${motivo}`);
}
async function reanudarLinea(pool, connId) {
  await getSettings(pool, connId);
  await pool.query(`UPDATE wa_line_settings SET pausada=FALSE, pausa_motivo='', fallos_seguidos=0, updated_at=NOW() WHERE connection_id=$1`, [connId]);
  await replanificar(pool, connId);
}

// ── Capacidad y ritmo ───────────────────────────────────────────────────────────────────────────────────────────
function topeEfectivo(S, ahora) {
  let cap = S.tope_diario;
  if (S.rampa_on && S.rampa_desde) {
    const sem = Math.max(0, Math.floor((ahora.getTime() - new Date(S.rampa_desde).getTime()) / (7 * 86400000)));
    cap = Math.min(cap, S.rampa_inicio + S.rampa_paso * sem);   // línea nueva: empieza con pocos y sube cada semana
  }
  return Math.max(1, cap);
}
async function enviadosHoy(pool, connId, S, ahora) {
  const desde = inicioDiaLocal(ahora || new Date(), S.tz);
  const { rows: [r] } = await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE connection_id=$1 AND via_cola AND from_me AND estado='enviado' AND ts >= $2`, [connId, desde]);
  return r ? r.n : 0;
}
// Intervalo con variación. Para planificar usa una variación estable por mensaje (los horarios mostrados no «bailan» en cada replanificación);
// para el envío real usa variación al azar.
function intervaloMs(S, rowId) {
  const j = Math.max(0, Math.min(0.8, S.jitter_pct / 100));
  const u = rowId ? ((rowId * 2654435761) % 4294967296) / 4294967296 : Math.random();
  return Math.max(MIN_INTERVALO_MS, S.intervalo_min * 60000 * (1 + (u * 2 - 1) * j));
}

// Reparte la hora estimada de salida de cada mensaje en cola respetando: intervalo entre mensajes, ventana horaria EN LA HORA DEL CONTACTO,
// días permitidos y tope diario. Un mensaje que por su zona horaria debe esperar (p. ej. un contacto de España de madrugada) NO frena a los demás:
// cada uno toma el primer hueco libre que le sirve.
async function replanificar(pool, connId) {
  const S = await getSettings(pool, connId);
  const { rows } = await pool.query(`SELECT id, tz_destino FROM wa_messages WHERE connection_id=$1 AND estado='programado' AND via_cola ORDER BY id`, [connId]);
  if (!rows.length) return;
  const ahora = new Date();
  const base = new Date(Math.max(ahora.getTime(), S.proximo_envio_at ? new Date(S.proximo_envio_at).getTime() : 0));
  const porDia = {};
  porDia[_dayKey(ahora, S.tz)] = await enviadosHoy(pool, connId, S, ahora);
  const usados = [], ids = [], horas = [];
  for (const r of rows) {
    const Sr = Object.assign({}, S, { tz: r.tz_destino || S.tz });     // ventana y días: hora local del contacto
    const hueco = intervaloMs(S, r.id);
    let c = new Date(base);
    for (let guard = 0; guard < 300; guard++) {
      c = ajustarVentana(c, Sr);
      const k = _dayKey(c, S.tz);                                       // el tope diario cuenta por día de la línea
      if ((porDia[k] || 0) >= topeEfectivo(S, c)) { c = _inicioDiaSiguiente(c, S); continue; }
      const choque = usados.find(u => Math.abs(u - c.getTime()) < hueco);
      if (choque !== undefined) { c = new Date(Math.max(c.getTime() + 1000, choque + hueco)); continue; }
      break;
    }
    const kf = _dayKey(c, S.tz);
    porDia[kf] = (porDia[kf] || 0) + 1;
    usados.push(c.getTime()); ids.push(r.id); horas.push(c.toISOString());
  }
  await pool.query(
    `UPDATE wa_messages m SET scheduled_at = x.t FROM (SELECT unnest($1::int[]) AS id, unnest($2::timestamptz[]) AS t) x WHERE m.id = x.id AND m.estado='programado' AND m.via_cola`,
    [ids, horas]);
}

// ── Encolar ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function encolar(pool, { connId, jid, texto, respondeA, contactId, sequenceId, stepId, origen, userId }) {
  const jidFull = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  // Doble clic / reintento del navegador: el mismo texto al mismo chat ya en cola no se duplica.
  const { rows: [dup] } = await pool.query(
    `SELECT id, scheduled_at FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND via_cola AND estado IN ('programado','enviando') AND texto=$3 LIMIT 1`, [connId, jidFull, texto]);
  if (dup) return { id: dup.id, scheduledAt: dup.scheduled_at, duplicado: true };
  let replyToTexto = '';
  if (respondeA) {
    const { rows: [orig] } = await pool.query(`SELECT texto FROM wa_messages WHERE connection_id=$1 AND chat_jid=$2 AND msg_id=$3`, [connId, jidFull, respondeA]);
    replyToTexto = (orig && orig.texto) || '';
  }
  const placeholder = 'sched_' + require('crypto').randomUUID();
  const { rows: [row] } = await pool.query(
    `INSERT INTO wa_messages (connection_id, chat_jid, msg_id, from_me, texto, ts, reply_to_id, reply_to_texto, estado, scheduled_at, via_cola, contact_id, sequence_id, step_id, origen, tz_destino)
     VALUES ($1,$2,$3,TRUE,$4,NOW(),$5,$6,'programado',NOW(),TRUE,$7,$8,$9,$10,$11) RETURNING id`,
    [connId, jidFull, placeholder, texto, respondeA || '', replyToTexto, contactId || null, sequenceId || null, stepId || null, origen || 'manual', tzDeJid(jidFull)]);
  await replanificar(pool, connId);
  const { rows: [r2] } = await pool.query('SELECT scheduled_at FROM wa_messages WHERE id=$1', [row.id]);
  return { id: row.id, scheduledAt: r2 && r2.scheduled_at };
}

// ── Motor ───────────────────────────────────────────────────────────────────────────────────────────────────────
// El mensaje ya salió: se guarda su id real. Si justo apareció otra fila con ese mismo id (p. ej. una sincronización), se conserva UNA sola.
async function _marcarEnviado(pool, m, msgId) {
  try {
    await pool.query(`UPDATE wa_messages SET msg_id=$2, estado='enviado', ts=NOW(), scheduled_at=NULL, ultimo_error='' WHERE id=$1`, [m.id, msgId]);
  } catch (e) {
    if (e && e.code === '23505') {
      await pool.query(`UPDATE wa_messages SET via_cola=$3, contact_id=$4, sequence_id=$5, step_id=$6, origen=$7 WHERE connection_id=(SELECT connection_id FROM wa_messages WHERE id=$1) AND msg_id=$2`,
        [m.id, msgId, !!m.via_cola, m.contact_id, m.sequence_id, m.step_id, m.origen || '']);
      await pool.query(`DELETE FROM wa_messages WHERE id=$1`, [m.id]);
    } else throw e;
  }
}
async function _manejarFallo(pool, connId, m, intentos, e) {
  const tipo = (e && e.code) || 'otro';
  const msg = String((e && e.message) || 'Error al enviar').slice(0, 300);
  if (tipo === 'sin_conexion') {
    // La línea no estaba lista: no es culpa del mensaje, no gasta intentos.
    await pool.query(`UPDATE wa_messages SET estado='programado', intentos=GREATEST(intentos-1,0), proximo_intento_at=NOW() + INTERVAL '60 seconds', ultimo_error=$2 WHERE id=$1`, [m.id, 'La línea estaba desconectada: se reintenta al reconectar']);
    return;
  }
  if (tipo === 'sin_whatsapp') {
    await pool.query(`UPDATE wa_messages SET estado='error_programado', ultimo_error=$2 WHERE id=$1`, [m.id, 'Ese número no tiene WhatsApp. Revisa el número del contacto.']);
    if (m.contact_id) {
      try {
        const r = await pool.query(`UPDATE lm_contacts SET no_whatsapp=TRUE, updated_at=NOW() WHERE id=$1 AND COALESCE(no_whatsapp,FALSE)=FALSE RETURNING user_id, outbound_client_id`, [m.contact_id]);
        if (r.rowCount) await pool.query(`INSERT INTO activities (user_id, contact_id, outbound_client_id, tipo, nota, fecha, estado) VALUES ($1,$2,$3,'nota',$4,NOW(),'hecha')`,
          [r.rows[0].user_id, m.contact_id, r.rows[0].outbound_client_id || null, 'WhatsApp marcado como número no válido (el número no tiene WhatsApp) → salta sus pasos de WhatsApp']);
      } catch (_) { /* la columna/tabla puede no existir en instalaciones viejas */ }
    }
    if (m.via_cola) await replanificar(pool, connId);
    return;
  }
  if (tipo === 'limite') {
    await pool.query(`UPDATE wa_messages SET estado='programado', intentos=GREATEST(intentos-1,0), proximo_intento_at=NOW() + INTERVAL '30 minutes', ultimo_error=$2 WHERE id=$1`, [m.id, 'WhatsApp limitó los envíos: la línea se pausó para protegerla']);
    await pausarLinea(pool, connId, `WhatsApp limitó los envíos (${msg}). Se pausó la línea para protegerla; reanúdala cuando pase un rato.`);
    return;
  }
  // Error genérico: reintentos con espera creciente; agotados, queda «con problema» y la cola sigue con los demás.
  if (intentos >= MAX_INTENTOS) {
    await pool.query(`UPDATE wa_messages SET estado='error_programado', ultimo_error=$2 WHERE id=$1`, [m.id, msg]);
    if (m.via_cola) await replanificar(pool, connId);
    const { rows: [s] } = await pool.query(`UPDATE wa_line_settings SET fallos_seguidos=fallos_seguidos+1 WHERE connection_id=$1 RETURNING fallos_seguidos`, [connId]);
    if (s && s.fallos_seguidos >= 3) await pausarLinea(pool, connId, `Fallaron ${s.fallos_seguidos} envíos seguidos (último: ${msg}). Revisa la línea y reanuda.`);
  } else {
    const espera = BACKOFF_MIN[Math.min(intentos - 1, BACKOFF_MIN.length - 1)];
    await pool.query(`UPDATE wa_messages SET estado='programado', proximo_intento_at=NOW() + ($2 || ' minutes')::interval, ultimo_error=$3 WHERE id=$1`, [m.id, String(espera), `Intento ${intentos} falló: ${msg}. Reintenta en ${espera} min`]);
  }
}

async function procesarLinea(pool, connId) {
  const S = await getSettings(pool, connId);
  const { rows } = await pool.query(
    `SELECT id, chat_jid, texto, reply_to_id, via_cola, contact_id, sequence_id, step_id, origen, tz_destino FROM wa_messages
      WHERE connection_id=$1 AND estado='programado' AND scheduled_at <= NOW() AND (proximo_intento_at IS NULL OR proximo_intento_at <= NOW())
      ORDER BY via_cola ASC, scheduled_at ASC, id ASC LIMIT 20`, [connId]);
  let salioDeCola = false;
  for (const m of rows) {
    if (m.via_cola) {
      const ahora = new Date();
      if (salioDeCola || S.pausada) continue;                                  // máx. UNO de la cola por pasada; línea pausada: espera (lo en cola no se pierde)
      if (!enVentana(ahora, Object.assign({}, S, { tz: m.tz_destino || S.tz }))) continue;   // fuera de horario/día EN LA HORA DEL CONTACTO: espera su próxima jornada
      if (S.proximo_envio_at && new Date(S.proximo_envio_at) > ahora) continue; // aún no pasó el intervalo desde el anterior
      if (await enviadosHoy(pool, connId, S, ahora) >= topeEfectivo(S, ahora)) continue;   // tope del día alcanzado
    }
    if (!waSvc.estadoSock(connId).abierto) {
      // Línea no lista: no gasta intentos, se vuelve a mirar en 1 min y se pide la reconexión (no bloquea).
      await pool.query(`UPDATE wa_messages SET proximo_intento_at=NOW() + INTERVAL '60 seconds', ultimo_error='La línea está desconectada: se enviará al reconectar' WHERE id=$1`, [m.id]);
      waSvc.esperarListo(pool, connId, 1).catch(() => {});
      break;   // el resto de esta línea tampoco puede salir ahora
    }
    // Reclamo atómico + id de WhatsApp propio (persistido antes de enviar): un tick solapado o un reintento tras un corte nunca duplica.
    const { rows: [c] } = await pool.query(
      `UPDATE wa_messages SET estado='enviando', intentos=intentos+1, proximo_intento_at=NOW(), wa_id = CASE WHEN wa_id='' THEN $2 ELSE wa_id END
        WHERE id=$1 AND estado='programado' RETURNING wa_id, intentos`, [m.id, waSvc.nuevoIdMensaje(connId)]);
    if (!c) continue;
    try {
      const r = await waSvc.enviarSeguro(pool, connId, m.chat_jid, m.texto, { messageId: c.wa_id, respondeA: m.reply_to_id || undefined });
      await _marcarEnviado(pool, m, r.msg_id);
      if (m.via_cola) {
        salioDeCola = true;
        const proximo = new Date(Date.now() + intervaloMs(S));   // intervalo con variación al azar: no salen a intervalos «de reloj»
        await pool.query(`UPDATE wa_line_settings SET proximo_envio_at=$2, fallos_seguidos=0 WHERE connection_id=$1`, [connId, proximo]);
        S.proximo_envio_at = proximo;
        await replanificar(pool, connId);
      } else {
        await pool.query(`UPDATE wa_line_settings SET fallos_seguidos=0 WHERE connection_id=$1`, [connId]);
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));   // varios programados a la misma hora no salen en ráfaga
      }
    } catch (e) {
      console.warn(`[wa-cola] mensaje ${m.id} (línea ${connId}): ${e && e.code ? '[' + e.code + '] ' : ''}${e && e.message}`);
      await _manejarFallo(pool, connId, m, c.intentos, e);
    }
  }
}

let _tickEnCurso = false;
async function tick(pool) {
  if (_tickEnCurso) return;
  _tickEnCurso = true;
  try {
    // Rescate: un envío que quedó «enviando» (el servidor se reinició a mitad) vuelve a la cola. Reintenta con el MISMO id: no duplica.
    await pool.query(`UPDATE wa_messages SET estado='programado' WHERE estado='enviando' AND proximo_intento_at < NOW() - INTERVAL '3 minutes'`);
    const { rows } = await pool.query(
      // Solo líneas que están (o deberían estar) conectadas: una línea desconectada a propósito conserva su cola intacta hasta que se reconecte.
      `SELECT DISTINCT m.connection_id FROM wa_messages m JOIN wa_connections c ON c.id = m.connection_id AND c.estado='conectado'
        WHERE m.estado='programado' AND m.scheduled_at <= NOW() AND (m.proximo_intento_at IS NULL OR m.proximo_intento_at <= NOW())`);
    await Promise.all(rows.map(r => procesarLinea(pool, r.connection_id).catch(e => console.warn(`[wa-cola] línea ${r.connection_id}:`, e.message))));
  } catch (e) { console.warn('[wa-cola] tick:', e.message); }
  finally { _tickEnCurso = false; }
}

// ── Resumen para la pantalla ────────────────────────────────────────────────────────────────────────────────────
async function resumen(pool, connId) {
  const S = await getSettings(pool, connId);
  const ahora = new Date();
  const hoy = await enviadosHoy(pool, connId, S, ahora);
  const { rows: items } = await pool.query(
    `SELECT m.id, m.chat_jid, m.texto, m.estado, m.scheduled_at, m.intentos, m.ultimo_error, m.via_cola, m.contact_id, m.sequence_id,
            COALESCE(NULLIF(TRIM(CONCAT(k.nombre,' ',k.apellido)),''), (SELECT c.nombre FROM wa_contacts c WHERE c.connection_id=m.connection_id AND c.jid=m.chat_jid), '') AS nombre
       FROM wa_messages m LEFT JOIN lm_contacts k ON k.id = m.contact_id
      WHERE m.connection_id=$1 AND m.estado IN ('programado','enviando','error_programado')
      ORDER BY (m.estado='error_programado') DESC, m.scheduled_at ASC, m.id ASC LIMIT 200`, [connId]);
  const { rows: [conn] } = await pool.query('SELECT estado, numero, ultimo_error FROM wa_connections WHERE id=$1', [connId]);
  const st = waSvc.estadoSock(connId);
  const proxima = items.find(i => i.via_cola && i.estado === 'programado');
  return {
    ajustes: S,
    linea: { estado: conn ? conn.estado : '', numero: conn ? conn.numero : '', abierto: st.abierto, conectando: st.conectando, ultimo_error: conn ? conn.ultimo_error : '' },
    hoy: { enviados: hoy, tope: topeEfectivo(S, ahora), en_ventana: enVentana(ahora, S) },
    proximo_envio: proxima ? proxima.scheduled_at : null,
    cola: items.filter(i => i.estado !== 'error_programado').map(i => ({ ...i, texto: String(i.texto || '').slice(0, 220) })),
    atencion: items.filter(i => i.estado === 'error_programado').map(i => ({ ...i, texto: String(i.texto || '').slice(0, 220) })),
  };
}

// ── Rutas ───────────────────────────────────────────────────────────────────────────────────────────────────────
function mount(app, { pool, requireAuth, cargarConexion }) {
  app.get('/api/wa/connections/:id/cola', requireAuth, async (req, res) => {
    try {
      const conn = await cargarConexion(req, res, req.params.id); if (!conn) return;
      if (req.query.ligero === '1') {
        const S = await getSettings(pool, conn.id), ahora = new Date();
        const { rows: [p] } = await pool.query(`SELECT MIN(scheduled_at) AS proximo, COUNT(*)::int AS n FROM wa_messages WHERE connection_id=$1 AND estado='programado' AND via_cola`, [conn.id]);
        return res.json({ cola_activa: S.cola_activa, pausada: S.pausada, pausa_motivo: S.pausa_motivo, intervalo_min: S.intervalo_min, tope: topeEfectivo(S, ahora), hoy: await enviadosHoy(pool, conn.id, S, ahora), en_ventana: enVentana(ahora, S), en_cola: p ? p.n : 0, proximo: p ? p.proximo : null });
      }
      res.json(await resumen(pool, conn.id));
    } catch (e) { console.error('[wa-cola] GET', e.message); res.status(500).json({ error: 'No se pudo cargar la cola' }); }
  });
  app.patch('/api/wa/connections/:id/ajustes', requireAuth, async (req, res) => {
    try {
      const conn = await cargarConexion(req, res, req.params.id); if (!conn) return;
      await saveSettings(pool, conn.id, req.body || {});
      res.json(await resumen(pool, conn.id));
    } catch (e) { console.error('[wa-cola] PATCH ajustes', e.message); res.status(500).json({ error: 'No se pudieron guardar los ajustes' }); }
  });
  app.post('/api/wa/connections/:id/cola/pausa', requireAuth, async (req, res) => {
    try {
      const conn = await cargarConexion(req, res, req.params.id); if (!conn) return;
      if ((req.body || {}).pausar) await pausarLinea(pool, conn.id, String((req.body || {}).motivo || 'Pausada a mano')); else await reanudarLinea(pool, conn.id);
      res.json(await resumen(pool, conn.id));
    } catch (e) { console.error('[wa-cola] pausa', e.message); res.status(500).json({ error: 'No se pudo cambiar el estado de la línea' }); }
  });
  app.post('/api/wa/connections/:id/cola/:rowId/reintentar', requireAuth, async (req, res) => {
    try {
      const conn = await cargarConexion(req, res, req.params.id); if (!conn) return;
      const r = await pool.query(`UPDATE wa_messages SET estado='programado', intentos=0, ultimo_error='', proximo_intento_at=NULL, scheduled_at=NOW() WHERE id=$1 AND connection_id=$2 AND estado='error_programado'`, [req.params.rowId, conn.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'No encontrado o ya no necesita reintento' });
      await replanificar(pool, conn.id);
      res.json({ ok: true });
    } catch (e) { console.error('[wa-cola] reintentar', e.message); res.status(500).json({ error: 'No se pudo reintentar' }); }
  });
  // «Enviar ya»: decisión de una persona de saltarse el ritmo para ESTE mensaje (sale en el próximo ciclo, sin esperar el intervalo).
  app.post('/api/wa/connections/:id/cola/:rowId/enviar-ya', requireAuth, async (req, res) => {
    try {
      const conn = await cargarConexion(req, res, req.params.id); if (!conn) return;
      const r = await pool.query(`UPDATE wa_messages SET via_cola=FALSE, scheduled_at=NOW(), proximo_intento_at=NULL WHERE id=$1 AND connection_id=$2 AND estado IN ('programado','error_programado')`, [req.params.rowId, conn.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'No encontrado o ya salió' });
      await pool.query(`UPDATE wa_messages SET estado='programado', intentos=0, ultimo_error='' WHERE id=$1 AND estado='error_programado'`, [req.params.rowId]);
      await replanificar(pool, conn.id);
      res.json({ ok: true });
    } catch (e) { console.error('[wa-cola] enviar-ya', e.message); res.status(500).json({ error: 'No se pudo enviar ahora' }); }
  });
}

module.exports = { tzDeJid, _procesarLinea: procesarLinea, mount, tick, encolar, replanificar, getSettings, saveSettings, pausarLinea, reanudarLinea, resumen, partes, zonedToUtc, ajustarVentana, enVentana, intervaloMs, topeEfectivo };
