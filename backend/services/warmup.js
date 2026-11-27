// ─────────────────────────────────────────────────────────────────
// Salud de los buzones (estilo Lemwarm): puntuación, fase de calentamiento y ajuste automático de la rampa.
// Puntuación (100 en total, como Lemwarm):  DNS 40 · spam del calentamiento 30 · listas negras 20 · edad del dominio 10.
// Lo que todavía no se puede medir (el spam del calentamiento necesita pruebas de bandeja) NO cuenta: la nota se calcula sobre lo medible
// y se dice cuántos puntos hay en juego, para no inventar un número.
// ─────────────────────────────────────────────────────────────────
const dns = require('dns').promises;
const https = require('https');
const { checkDomain } = require('./domainHealth');

const withTimeout = (p, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ── Edad del dominio (RDAP público) ──
function rdapEdad(domain) {
  return new Promise(resolve => {
    const req = https.get(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json' }, timeout: 7000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, { headers: { accept: 'application/rdap+json' }, timeout: 7000 }, r2 => collect(r2, resolve)).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
        return;
      }
      collect(res, resolve);
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  function collect(res, done) {
    let b = ''; res.on('data', d => { b += d; if (b.length > 400000) res.destroy(); });
    res.on('end', () => {
      try {
        const j = JSON.parse(b); const ev = (j.events || []).find(e => /registration/i.test(e.eventAction));
        done(ev && ev.eventDate ? new Date(ev.eventDate) : null);
      } catch (_) { done(null); }
    });
    res.on('error', () => done(null));
  }
}

// ── Listas negras de dominio (DNSBL por DNS). 127.255.255.x = «consulta rechazada» (resolvedor público): no es concluyente. ──
const DNSBLS = [['dbl.spamhaus.org', 'Spamhaus DBL'], ['multi.surbl.org', 'SURBL']];
async function listasNegras(domain) {
  const res = []; let concluyentes = 0;
  for (const [zona, nombre] of DNSBLS) {
    try {
      const ips = await withTimeout(dns.resolve4(`${domain}.${zona}`), 4000);
      const bloqueada = ips.some(ip => /^127\.255\.255\./.test(ip));
      if (bloqueada) { res.push({ lista: nombre, estado: 'sin_respuesta' }); continue; }
      concluyentes++; res.push({ lista: nombre, estado: 'listado', codigo: ips[0] });
    } catch (e) {
      if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) { concluyentes++; res.push({ lista: nombre, estado: 'limpio' }); }
      else res.push({ lista: nombre, estado: 'sin_respuesta' });
    }
  }
  return { listas: res, concluyente: concluyentes > 0, listado: res.some(x => x.estado === 'listado') };
}

const ptsDns = e => e === 'ok' ? 1 : e === 'warn' ? 0.5 : 0;
async function puntuar(domain, provider, prueba) {
  const [salud, nacio, neg] = await Promise.all([
    checkDomain(domain, provider).catch(() => null),
    rdapEdad(domain),
    listasNegras(domain).catch(() => ({ listas: [], concluyente: false, listado: false })),
  ]);
  const by = k => (salud && salud.checks.find(c => c.key === k)) || null;
  const f = [];
  // DNS (40): SPF 15 · DKIM 15 · DMARC 10
  const spf = by('spf'), dkim = by('dkim'), dmarc = by('dmarc');
  if (salud) {
    const pts = Math.round(15 * ptsDns(spf && spf.estado) + 15 * ptsDns(dkim && dkim.estado) + 10 * ptsDns(dmarc && dmarc.estado));
    f.push({ k: 'dns', nombre: 'Configuración del correo (DNS)', pts, max: 40, medido: true,
      detalle: [['SPF', spf], ['DKIM', dkim], ['DMARC', dmarc]].map(([n, c]) => `${n}: ${c ? (c.estado === 'ok' ? 'correcto' : c.estado === 'warn' ? 'mejorable' : 'falta o falla') : '—'}`).join(' · ') });
  } else f.push({ k: 'dns', nombre: 'Configuración del correo (DNS)', pts: 0, max: 40, medido: false, detalle: 'No se pudo consultar el DNS ahora.' });
  // Spam (30): sale de la última prueba de bandeja (Entrada = 1, Promociones = 0,7, Spam o no llegó = 0)
  const sp = require('./placement').puntosDePrueba(prueba);
  if (sp) f.push({ k: 'spam', nombre: 'Colocación en la bandeja', pts: sp.pts, max: 30, medido: true, detalle: `Última prueba: ${prueba.inbox} en Entrada, ${prueba.promociones || 0} en Promociones, ${prueba.spam || 0} en Spam, ${prueba.no_llego || 0} sin llegar (de ${prueba.total} cuentas).` });
  else f.push({ k: 'spam', nombre: 'Colocación en la bandeja', pts: 0, max: 30, medido: false, detalle: 'Se mide con una prueba de bandeja (Warm-up → Pruebas) o con un calentamiento.' });
  // Listas negras (20)
  if (neg.concluyente) f.push({ k: 'listas', nombre: 'Listas negras del dominio', pts: neg.listado ? 0 : 20, max: 20, medido: true, detalle: neg.listas.map(x => `${x.lista}: ${x.estado === 'limpio' ? 'limpio' : x.estado === 'listado' ? 'LISTADO' : 'sin respuesta'}`).join(' · ') });
  else f.push({ k: 'listas', nombre: 'Listas negras del dominio', pts: 0, max: 20, medido: false, detalle: 'Las listas no respondieron desde el servidor; se reintenta.' });
  // Edad (10)
  if (nacio) {
    const meses = (Date.now() - nacio.getTime()) / (30.44 * 864e5);
    const pts = meses >= 24 ? 10 : meses >= 12 ? 7 : meses >= 6 ? 4 : meses >= 1 ? 2 : 0;
    f.push({ k: 'edad', nombre: 'Antigüedad del dominio', pts, max: 10, medido: true, detalle: `Registrado hace ${meses >= 24 ? Math.floor(meses / 12) + ' años' : Math.floor(meses) + ' meses'}.` });
  } else f.push({ k: 'edad', nombre: 'Antigüedad del dominio', pts: 0, max: 10, medido: false, detalle: 'El registro del dominio no la publica.' });
  const disp = f.filter(x => x.medido), maxDisp = disp.reduce((a, x) => a + x.max, 0), pts = disp.reduce((a, x) => a + x.pts, 0);
  const nota = maxDisp ? Math.round(pts / maxDisp * 100) : null;
  const arreglos = salud ? salud.checks.filter(c => c.estado !== 'ok').map(c => ({ nombre: c.label, estado: c.estado, detalle: c.detalle, pasos: c.pasos || [], registro: c.registro && c.registro.valor ? { tipo: c.registro.tipo, nombre: c.registro.nombre, valor: c.registro.valor, actual: c.registro.actual || '' } : null, panel: c.panel || null, nota: c.nota || '' })) : [];
  return { nota, puntos: pts, de: maxDisp, factores: f, arreglos, dns: salud ? { resumen: salud.resumen, dnsHost: salud.dnsHost } : null, revisadoEn: new Date().toISOString() };
}

// Qué hacer según la nota (mismos tramos de Lemwarm: <65 parar e investigar · 65–90 solo calentar · >90 listo)
function consejo(nota) {
  if (nota === null) return { nivel: 'neutro', texto: 'Sin datos suficientes todavía.' };
  if (nota < 65) return { nivel: 'mal', texto: 'Pausa los envíos y arregla primero el DNS o las listas negras.' };
  if (nota < 90) return { nivel: 'ojo', texto: 'Mantén el volumen bajo y sin subirlo de golpe hasta que mejore.' };
  return { nivel: 'ok', texto: 'Listo para enviar. Sube el volumen de forma gradual.' };
}

// Fase según la rampa del buzón: Rampa → Estabilización (14 días al tope) → Activo
function fase(mb) {
  if (mb.daily_limit > 0 && !mb.ramp_on) return { fase: 'limite', texto: 'Límite fijo', detalle: `${mb.daily_limit} correos al día` };
  if (!mb.ramp_on || !mb.ramp_started_on) return { fase: 'sin', texto: 'Sin rampa', detalle: 'El buzón no tiene calentamiento gradual configurado.' };
  const ini = new Date(mb.ramp_started_on + 'T00:00:00Z').getTime(), dias = Math.max(0, Math.floor((Date.now() - ini) / 864e5));
  const semanas = Math.max(0, Math.ceil((mb.ramp_target - mb.ramp_start) / Math.max(1, mb.ramp_step)));
  const finRampa = semanas * 7, finEstab = finRampa + 14;
  if (dias < finRampa) return { fase: 'rampa', texto: 'Subiendo', detalle: `Semana ${Math.floor(dias / 7) + 1} de ${semanas + 1}`, dias, finRampa };
  if (dias < finEstab) return { fase: 'estabilizacion', texto: 'Estabilizando', detalle: `Día ${dias - finRampa + 1} de 14 en el tope`, dias, finRampa };
  return { fase: 'activo', texto: 'Activo', detalle: 'Rampa y estabilización completas', dias, finRampa };
}

// ── Ajuste automático de la rampa (solo buzones con ramp_auto) ──
// Reglas (una evaluación al día por buzón; mira SOLO los envíos desde el último cambio, con un máximo de 14 días):
//  · BAJA si rebota más del 5 % (con al menos 20 envíos medidos): el tope de hoy baja un 30 %, o un 50 % si pasa del 10 %. Mínimo 10.
//  · SUBE +5 si: la rampa ya llegó a su meta, rebota menos del 2 % (al menos 30 envíos), el día de más envíos de la última semana usó ≥ 80 % del cupo,
//    la nota de salud no está por debajo de 65, y aún no llegó al máximo.
//  · Después de CUALQUIER cambio espera 7 días antes de volver a tocar: así el efecto se ve antes de decidir otra vez (si no, bajaría o subiría cada día).
function decidir(x) {
  const tasa = x.n ? x.b / x.n : 0, pc = (tasa * 100).toFixed(1).replace('.', ',');
  const enfria = x.diasCambio !== null && x.diasCambio < 7;
  const mant = det => ({ tipo: 'ramp_mantiene', nuevo: x.target, det });
  if (x.n >= 20 && tasa > 0.05) {
    if (enfria) return mant(`Rebote ${pc} % en ${x.n} envíos, pero el último cambio fue hace ${x.diasCambio} día${x.diasCambio === 1 ? '' : 's'}: se espera a completar 7 días antes de volver a bajar.`);
    const f = tasa >= 0.10 ? 0.5 : 0.7, base = Math.min(x.cap, x.target), nuevo = Math.max(10, Math.floor(base * f));
    if (nuevo >= x.target) return mant(`Rebote ${pc} % en ${x.n} envíos, pero el tope ya está en el mínimo (${x.target}).`);
    return { tipo: 'ramp_baja', nuevo, det: `Rebote ${pc} % en ${x.n} envíos desde el último cambio: el tope baja de ${x.target} a ${nuevo}. Revisa la lista de contactos y el DNS.` };
  }
  if (x.target >= x.techo) return mant(`En el máximo (${x.techo}). Rebote ${pc} % en ${x.n} envíos.`);
  if (x.n < 30) return mant(`Aún hay pocos envíos para decidir (${x.n} de 30 necesarios). Rebote ${pc} %.`);
  if (tasa >= 0.02) return mant(`Rebote ${pc} % en ${x.n} envíos: entre 2 % y 5 %, no sube ni baja.`);
  if (enfria) return mant(`Rebote ${pc} %. El último cambio fue hace ${x.diasCambio} día${x.diasCambio === 1 ? '' : 's'}: se espera a completar 7 días.`);
  if (x.cap < x.target) return mant(`La rampa todavía está subiendo (hoy ${x.cap} de una meta de ${x.target}). Rebote ${pc} %.`);
  if (x.nota !== null && x.nota < 65) return mant(`La nota de salud es ${x.nota} (menos de 65): no sube hasta arreglar el DNS o las listas negras.`);
  if (x.maxDia7 < 0.8 * x.cap) return mant(`Rebote ${pc} %, pero el buzón no usa el cupo (máximo ${x.maxDia7} en un día de la semana, tope ${x.cap}): subirlo no cambiaría nada.`);
  const nuevo = Math.min(x.techo, x.target + 5);
  return { tipo: 'ramp_sube', nuevo, det: `Rebote ${pc} % en ${x.n} envíos y usa el cupo: el tope sube de ${x.target} a ${nuevo}.` };
}

async function evaluarRampasAuto(pool, opts) {
  const seco = !!(opts && opts.seco);   // «seco» = solo calcula, no guarda nada
  const { rows } = await pool.query(`
    SELECT mb.id, mb.email, mb.ramp_target, mb.ramp_techo, mb.ramp_start, nv_mb_cap(mb.id,'America/Lima') AS cap,
           (SELECT MAX(e.created_at) FROM lm_mailbox_events e WHERE e.mailbox_id = mb.id AND e.tipo IN ('ramp_sube','ramp_baja')) AS ult_cambio,
           (SELECT (h.datos->>'nota')::int FROM lm_mailbox_health h WHERE h.mailbox_id = mb.id) AS nota
      FROM lm_mailboxes mb
     WHERE mb.ramp_auto AND mb.ramp_on AND mb.estado IN ('conectado','solo_envio')` + (seco ? '' : `
       AND NOT EXISTS (SELECT 1 FROM lm_mailbox_events e WHERE e.mailbox_id = mb.id AND e.tipo LIKE 'ramp_%' AND e.created_at > NOW() - interval '20 hours')`));
  const out = [];
  for (const r of rows) {
    const desde = r.ult_cambio && Date.now() - new Date(r.ult_cambio).getTime() < 14 * 864e5 ? new Date(r.ult_cambio) : new Date(Date.now() - 14 * 864e5);
    const { rows: [m] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE estado IN ('sent','replied','bounced'))::int AS n, COUNT(*) FILTER (WHERE estado='bounced')::int AS b
        FROM lm_messages WHERE mailbox_id=$1 AND sent_at > $2`, [r.id, desde]);
    const { rows: [u] } = await pool.query(`
      SELECT COALESCE(MAX(c),0)::int AS maxdia FROM (SELECT COUNT(*) c FROM lm_messages WHERE mailbox_id=$1 AND estado IN ('sent','replied','bounced') AND sent_at > NOW() - interval '7 days' GROUP BY (sent_at AT TIME ZONE 'America/Lima')::date) x`, [r.id]);
    const dec = decidir({ cap: r.cap === null ? r.ramp_target : r.cap, target: r.ramp_target, techo: r.ramp_techo, n: m.n, b: m.b, maxDia7: u.maxdia, nota: r.nota === null ? null : r.nota,
      diasCambio: r.ult_cambio ? Math.floor((Date.now() - new Date(r.ult_cambio).getTime()) / 864e5) : null });
    if (!seco) {
      if (dec.nuevo !== r.ramp_target) await pool.query('UPDATE lm_mailboxes SET ramp_target=$1 WHERE id=$2', [dec.nuevo, r.id]);
      await pool.query('INSERT INTO lm_mailbox_events (mailbox_id, tipo, detalle, datos) VALUES ($1,$2,$3,$4)', [r.id, dec.tipo, dec.det, JSON.stringify({ n: m.n, b: m.b, antes: r.ramp_target, despues: dec.nuevo, cap: r.cap })]);
    }
    out.push({ id: r.id, email: r.email, tipo: dec.tipo, det: dec.det, antes: r.ramp_target, despues: dec.nuevo });
  }
  return out;
}

module.exports = { decidir, puntuar, consejo, fase, evaluarRampasAuto, listasNegras, rdapEdad };
