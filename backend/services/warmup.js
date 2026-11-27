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
async function puntuar(domain, provider) {
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
  // Spam del calentamiento (30): aún sin datos
  f.push({ k: 'spam', nombre: 'Spam del calentamiento', pts: 0, max: 30, medido: false, detalle: 'Se medirá con las pruebas de bandeja y el calentamiento (todavía no activos).' });
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
  return { nota, puntos: pts, de: maxDisp, factores: f, dns: salud ? { resumen: salud.resumen, dnsHost: salud.dnsHost } : null, revisadoEn: new Date().toISOString() };
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
// Cada día, con los últimos 14 días: pocos rebotes y usando el cupo → sube el tope de 5 en 5 hasta el techo; muchos rebotes → lo baja un 30 %.
async function evaluarRampasAuto(pool) {
  const { rows } = await pool.query(`SELECT mb.id, mb.email, mb.ramp_target, mb.ramp_techo, mb.ramp_start,
        (SELECT COUNT(*)::int FROM lm_messages m WHERE m.mailbox_id = mb.id AND m.estado IN ('sent','replied','bounced') AND m.sent_at > NOW() - interval '14 days') AS n14,
        (SELECT COUNT(*)::int FROM lm_messages m WHERE m.mailbox_id = mb.id AND m.estado = 'bounced' AND m.sent_at > NOW() - interval '14 days') AS b14,
        (SELECT COUNT(*)::int FROM lm_messages m WHERE m.mailbox_id = mb.id AND m.estado IN ('sent','replied','bounced') AND m.sent_at > NOW() - interval '7 days') AS n7
      FROM lm_mailboxes mb
     WHERE mb.ramp_auto AND mb.ramp_on AND mb.estado IN ('conectado','solo_envio')
       AND NOT EXISTS (SELECT 1 FROM lm_mailbox_events e WHERE e.mailbox_id = mb.id AND e.tipo LIKE 'ramp_%' AND e.created_at > NOW() - interval '20 hours')`);
  const out = [];
  for (const r of rows) {
    const tasa = r.n14 ? r.b14 / r.n14 : 0, usoDia = r.n7 / 7;
    let nuevo = r.ramp_target, tipo = 'ramp_mantiene', det = `Rebote ${(tasa * 100).toFixed(1)} % en ${r.n14} envíos (14 días): sin cambios.`;
    if (r.n14 >= 20 && tasa > 0.05) { nuevo = Math.max(10, Math.floor(r.ramp_target * 0.7)); tipo = 'ramp_baja'; det = `Rebote ${(tasa * 100).toFixed(1)} % en ${r.n14} envíos: el tope baja de ${r.ramp_target} a ${nuevo}.`; }
    else if (r.n14 >= 30 && tasa < 0.02 && usoDia >= r.ramp_target * 0.7 && r.ramp_target < r.ramp_techo) { nuevo = Math.min(r.ramp_techo, r.ramp_target + 5); tipo = 'ramp_sube'; det = `Rebote ${(tasa * 100).toFixed(1)} % en ${r.n14} envíos y usa el cupo: el tope sube de ${r.ramp_target} a ${nuevo}.`; }
    if (nuevo !== r.ramp_target) await pool.query('UPDATE lm_mailboxes SET ramp_target=$1 WHERE id=$2', [nuevo, r.id]);
    await pool.query('INSERT INTO lm_mailbox_events (mailbox_id, tipo, detalle, datos) VALUES ($1,$2,$3,$4)', [r.id, tipo, det, JSON.stringify({ n14: r.n14, b14: r.b14, antes: r.ramp_target, despues: nuevo })]);
    out.push({ id: r.id, email: r.email, tipo, det });
  }
  return out;
}

module.exports = { puntuar, consejo, fase, evaluarRampasAuto, listasNegras, rdapEdad };
