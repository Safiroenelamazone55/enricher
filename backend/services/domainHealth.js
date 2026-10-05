// ─────────────────────────────────────────────────────────────────────
// Salud del dominio de envío: revisa SPF, DKIM, DMARC y MX por DNS.
// Son los registros que le dicen a Gmail/Outlook que un correo que sale desde
// tu dominio es legítimo. Sin ellos (sobre todo SPF y DMARC) los emails en frío
// caen en spam o se rechazan. Solo lee DNS público; no toca el buzón.
// ─────────────────────────────────────────────────────────────────────
const dns = require('dns').promises;

const TIMEOUT_MS = 6000;
function withTimeout(p) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
}
async function txt(name) {
  try { return (await withTimeout(dns.resolveTxt(name))).map(parts => parts.join('')); }
  catch (_) { return []; }
}
async function cname(name) {
  try { return await withTimeout(dns.resolveCname(name)); } catch (_) { return []; }
}

// Registros SPF recomendados por proveedor (para mostrar el texto exacto a pegar).
const SPF_HINT = {
  google:    { include: '_spf.google.com',               ejemplo: 'v=spf1 include:_spf.google.com ~all' },
  microsoft: { include: 'spf.protection.outlook.com',    ejemplo: 'v=spf1 include:spf.protection.outlook.com ~all' },
  zoho:      { include: 'zoho',                          ejemplo: 'v=spf1 include:zoho.com ~all (usa zoho.in, zoho.eu… según tu región)' },
};
const DKIM_SELECTORS = {
  google:    ['google'],
  microsoft: ['selector1', 'selector2'],
  zoho:      ['zoho', 'zmail'],
  otro:      ['default', 'mail', 'dkim', 'k1', 's1', 's2', 'selector1', 'selector2', 'google', 'zoho'],
};

function check(key, label, estado, detalle, consejo) {
  return { key, label, estado, detalle, consejo: consejo || '' };
}

async function checkDomain(domain, provider) {
  domain = String(domain || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) throw new Error('Dominio no válido');
  const prov = SPF_HINT[provider] ? provider : 'otro';
  const checks = [];

  // ── MX ──
  let mx = [];
  try { mx = await withTimeout(dns.resolveMx(domain)); } catch (_) {}
  checks.push(mx.length
    ? check('mx', 'Recepción de correo (MX)', 'ok', `${mx.length} servidor${mx.length > 1 ? 'es' : ''} de correo configurado${mx.length > 1 ? 's' : ''}.`)
    : check('mx', 'Recepción de correo (MX)', 'fail', 'El dominio no tiene servidores de correo (MX).', 'Sin MX no se pueden recibir respuestas ni rebotes. Actívalo en el panel de tu proveedor de correo.'));

  // ── SPF ──
  const spfAll = (await txt(domain)).filter(t => /^v=spf1\b/i.test(t));
  if (!spfAll.length) {
    checks.push(check('spf', 'SPF', 'fail', 'No hay registro SPF.',
      'Crea un registro TXT en la raíz del dominio. ' + (SPF_HINT[prov] ? 'Para tu proveedor: ' + SPF_HINT[prov].ejemplo : 'Pide a tu proveedor el valor SPF que le corresponde.')));
  } else if (spfAll.length > 1) {
    checks.push(check('spf', 'SPF', 'fail', `Hay ${spfAll.length} registros SPF (debe haber uno solo).`, 'Une todos los "include:" en un único registro SPF y borra los demás.'));
  } else {
    const spf = spfAll[0];
    const lookups = (spf.match(/\b(include:|a\b|mx\b|ptr\b|exists:|redirect=)/gi) || []).length;
    const incl = SPF_HINT[prov] && SPF_HINT[prov].include;
    if (/\+all\b|\s\?all\b/i.test(spf)) checks.push(check('spf', 'SPF', 'fail', 'El SPF permite a cualquiera enviar (+all / ?all).', 'Termínalo en ~all o -all.'));
    else if (incl && !spf.toLowerCase().includes(incl)) checks.push(check('spf', 'SPF', 'warn', 'El SPF existe, pero no menciona a tu proveedor de correo.', 'Añade el "include:" de tu proveedor. ' + SPF_HINT[prov].ejemplo));
    else if (lookups > 10) checks.push(check('spf', 'SPF', 'warn', `El SPF hace ${lookups} consultas (el máximo permitido es 10).`, 'Quita servicios que ya no uses del registro SPF.'));
    else checks.push(check('spf', 'SPF', 'ok', 'Correcto: ' + (/\-all\b/i.test(spf) ? 'rechaza lo no autorizado (-all).' : 'marca como sospechoso lo no autorizado (~all).')));
  }

  // ── DKIM ──
  const selectors = DKIM_SELECTORS[prov] || DKIM_SELECTORS.otro;
  let dkimOk = '';
  for (const sel of selectors) {
    const host = `${sel}._domainkey.${domain}`;
    const t = await txt(host);
    if (t.some(x => /v=DKIM1|p=/i.test(x))) { dkimOk = sel; break; }
    if ((await cname(host)).length) { dkimOk = sel; break; }
  }
  checks.push(dkimOk
    ? check('dkim', 'DKIM', 'ok', `Firma encontrada (selector "${dkimOk}").`)
    : check('dkim', 'DKIM', 'warn', 'No encontramos la firma DKIM con los nombres habituales.',
        prov === 'google' ? 'En Google Workspace: Admin → Apps → Gmail → Autenticar correo → genera la clave y publícala en el DNS.'
        : prov === 'microsoft' ? 'En Microsoft 365: Defender → Correo y colaboración → Directivas → DKIM, y publica los dos CNAME (selector1 y selector2).'
        : prov === 'zoho' ? 'En Zoho Mail: Panel de administración → Dominios → DKIM, y publica el TXT que te muestran.'
        : 'Pide a tu proveedor la clave DKIM y publícala. Si ya existe con otro nombre, puede que esta revisión no la vea.'));

  // ── DMARC ──
  const dm = (await txt('_dmarc.' + domain)).filter(t => /^v=DMARC1/i.test(t));
  if (!dm.length) {
    checks.push(check('dmarc', 'DMARC', 'fail', 'No hay registro DMARC.',
      'Crea un TXT en _dmarc.' + domain + ' con: v=DMARC1; p=none; rua=mailto:tucorreo@' + domain + ' (empieza en "none" para solo observar).'));
  } else {
    const p = (dm[0].match(/\bp=(\w+)/i) || [])[1] || '';
    if (/^none$/i.test(p)) checks.push(check('dmarc', 'DMARC', 'warn', 'Existe, pero solo observa (p=none).', 'Es un buen comienzo. Cuando SPF y DKIM estén en verde, súbelo a p=quarantine.'));
    else checks.push(check('dmarc', 'DMARC', 'ok', `Correcto (política ${p || 'definida'}).`));
  }

  const fails = checks.filter(c => c.estado === 'fail').length, warns = checks.filter(c => c.estado === 'warn').length;
  const resumen = fails ? { estado: 'fail', texto: 'Hay que arreglar antes de enviar en volumen' }
    : warns ? { estado: 'warn', texto: 'Casi listo: hay mejoras recomendadas' }
    : { estado: 'ok', texto: 'Listo para enviar' };
  return { domain, provider: prov, checkedAt: new Date().toISOString(), resumen, checks };
}

module.exports = { checkDomain };
