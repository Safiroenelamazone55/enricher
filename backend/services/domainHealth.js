// ─────────────────────────────────────────────────────────────────────
// Salud del dominio de envío: revisa SPF, DKIM, DMARC y MX por DNS y dice QUÉ HACER.
// Son los registros que le dicen a Gmail/Outlook que un correo que sale desde
// tu dominio es legítimo. Sin ellos (sobre todo SPF y DMARC) los emails en frío
// caen en spam o se rechazan. Solo lee DNS público; no toca el buzón.
// Cada revisión que no esté en verde trae: pasos, el registro a publicar (tipo, nombre, valor)
// y el panel donde hacerlo.
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

const PROV = {
  google:    { nombre: 'Google Workspace', include: '_spf.google.com', panelDkim: 'https://admin.google.com/ac/apps/gmail/authenticateemail', panelNombre: 'Consola de administración de Google' },
  microsoft: { nombre: 'Microsoft 365',    include: 'spf.protection.outlook.com', panelDkim: 'https://security.microsoft.com/dkimv2', panelNombre: 'Portal de seguridad de Microsoft (Defender)' },
  zoho:      { nombre: 'Zoho Mail',        include: 'zoho.com', panelDkim: 'https://mailadmin.zoho.com/', panelNombre: 'Panel de administración de Zoho' },
};
const DKIM_SELECTORS = {
  google: ['google'], microsoft: ['selector1', 'selector2'], zoho: ['zoho', 'zmail'],
  otro: ['default', 'mail', 'dkim', 'k1', 's1', 's2', 'selector1', 'selector2', 'google', 'zoho'],
};

// ¿Quién administra los DNS del dominio? (para decirte dónde entrar a publicar los registros)
const NS_MAP = [
  [/cloudflare\.com$/i, 'Cloudflare', 'https://dash.cloudflare.com/'], [/domaincontrol\.com$/i, 'GoDaddy', 'https://dcc.godaddy.com/'],
  [/registrar-servers\.com$/i, 'Namecheap', 'https://ap.www.namecheap.com/'], [/awsdns/i, 'Amazon Route 53', 'https://console.aws.amazon.com/route53/'],
  [/googledomains\.com$|squarespacedns\.com$/i, 'Google Domains / Squarespace', 'https://domains.squarespace.com/'], [/hostinger/i, 'Hostinger', 'https://hpanel.hostinger.com/'],
  [/wixdns\.net$/i, 'Wix', 'https://manage.wix.com/'], [/azure-dns/i, 'Azure DNS', 'https://portal.azure.com/'], [/dnsmadeeasy|dyn\.com/i, 'Otro proveedor de DNS', ''],
];
async function dnsHost(domain) {
  try {
    const ns = await withTimeout(dns.resolveNs(domain));
    for (const n of ns) { const m = NS_MAP.find(([re]) => re.test(n)); if (m) return { nombre: m[1], url: m[2], ns }; }
    return { nombre: '', url: '', ns };
  } catch (_) { return { nombre: '', url: '', ns: [] }; }
}

function check(key, label, estado, detalle, extra) {
  return Object.assign({ key, label, estado, detalle, consejo: '', pasos: [], registro: null, panel: null }, extra || {});
}

// Inserta el include del proveedor justo antes del "all" final del SPF actual.
function mergeSpf(actual, include) {
  const inc = 'include:' + include;
  if (actual.toLowerCase().includes(inc)) return actual;
  const m = actual.match(/\s([~\-+?]all)\s*$/i);
  return m ? actual.replace(/\s([~\-+?]all)\s*$/i, ' ' + inc + ' $1') : actual.trim() + ' ' + inc + ' ~all';
}

async function checkDomain(domain, provider) {
  domain = String(domain || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) throw new Error('Dominio no válido');
  const prov = PROV[provider] ? provider : 'otro';
  const P = PROV[prov] || null;
  const checks = [];
  const host = await dnsHost(domain);
  const dnsPanel = host.nombre ? { nombre: 'Panel de DNS de ' + host.nombre, url: host.url } : null;

  // ── MX ──
  let mx = [];
  try { mx = await withTimeout(dns.resolveMx(domain)); } catch (_) {}
  checks.push(mx.length
    ? check('mx', 'Recepción de correo (MX)', 'ok', `${mx.length} servidor${mx.length > 1 ? 'es' : ''} de correo configurado${mx.length > 1 ? 's' : ''}.`)
    : check('mx', 'Recepción de correo (MX)', 'fail', 'El dominio no tiene servidores de correo (MX).', {
        pasos: ['Entra al panel de tu proveedor de correo y copia los registros MX que te indica.', 'Publícalos en el DNS del dominio.', 'Sin MX no llegan respuestas ni rebotes.'], panel: dnsPanel }));

  // ── SPF ──
  const spfAll = (await txt(domain)).filter(t => /^v=spf1\b/i.test(t));
  if (!spfAll.length) {
    const nuevo = P ? `v=spf1 include:${P.include} ~all` : 'v=spf1 ~all';
    checks.push(check('spf', 'SPF', 'fail', 'No hay registro SPF.', {
      pasos: ['Entra al panel de DNS del dominio.', 'Crea un registro TXT con el nombre y el valor de abajo.', 'Guarda. Puede tardar de unos minutos a unas horas en verse.'],
      registro: { tipo: 'TXT', nombre: '@ (el dominio mismo)', valor: nuevo, actual: '' }, panel: dnsPanel }));
  } else if (spfAll.length > 1) {
    checks.push(check('spf', 'SPF', 'fail', `Hay ${spfAll.length} registros SPF (debe haber uno solo).`, {
      pasos: ['Entra al panel de DNS del dominio.', 'Une todos los "include:" en UN solo registro TXT que empiece con v=spf1.', 'Borra los demás registros SPF.'],
      registro: { tipo: 'TXT', nombre: '@ (el dominio mismo)', valor: spfAll.map(s => (s.match(/include:[^\s]+/gi) || []).join(' ')).join(' ').trim() ? 'v=spf1 ' + [...new Set(spfAll.flatMap(s => s.match(/include:[^\s]+/gi) || []))].join(' ') + ' ~all' : 'v=spf1 ~all', actual: spfAll.join('\n') }, panel: dnsPanel }));
  } else {
    const spf = spfAll[0];
    const lookups = (spf.match(/\b(include:|a\b|mx\b|ptr\b|exists:|redirect=)/gi) || []).length;
    const incl = P && P.include;
    if (/\+all\b|\s\?all\b/i.test(spf)) {
      checks.push(check('spf', 'SPF', 'fail', 'El SPF permite a cualquiera enviar (+all / ?all).', {
        pasos: ['Edita ese registro TXT en el DNS.', 'Cambia el final por ~all.'],
        registro: { tipo: 'TXT', nombre: '@ (el dominio mismo)', valor: spf.replace(/[+?]all\s*$/i, '~all'), actual: spf }, panel: dnsPanel }));
    } else if (incl && !spf.toLowerCase().includes(incl)) {
      checks.push(check('spf', 'SPF', 'warn', `El SPF existe, pero no incluye a ${P.nombre}, el proveedor de este buzón.`, {
        pasos: ['Entra al panel de DNS del dominio.', 'Edita el registro TXT que empieza con v=spf1 (NO crees otro).', 'Reemplaza su valor por el "Registro nuevo" de abajo, que conserva lo que ya tenías y añade a tu proveedor.', 'Guarda y pulsa "Volver a revisar" en unos minutos.'],
        registro: { tipo: 'TXT', nombre: '@ (el dominio mismo)', valor: mergeSpf(spf, incl), actual: spf }, panel: dnsPanel }));
    } else if (lookups > 10) {
      checks.push(check('spf', 'SPF', 'warn', `El SPF hace ${lookups} consultas (el máximo permitido es 10).`, {
        pasos: ['Revisa los "include:" de ese registro y quita los de servicios que ya no uses.'], registro: { tipo: 'TXT', nombre: '@ (el dominio mismo)', valor: '', actual: spf }, panel: dnsPanel }));
    } else checks.push(check('spf', 'SPF', 'ok', 'Correcto: ' + (/\-all\b/i.test(spf) ? 'rechaza lo no autorizado (-all).' : 'marca como sospechoso lo no autorizado (~all).'), { registro: { actual: spf } }));
  }

  // ── DKIM ──
  const selectors = DKIM_SELECTORS[prov] || DKIM_SELECTORS.otro;
  let dkimOk = '';
  for (const sel of selectors) {
    const hostN = `${sel}._domainkey.${domain}`;
    if ((await txt(hostN)).some(x => /v=DKIM1|p=/i.test(x)) || (await cname(hostN)).length) { dkimOk = sel; break; }
  }
  if (dkimOk) checks.push(check('dkim', 'DKIM', 'ok', `Firma encontrada (selector "${dkimOk}").`));
  else {
    const pasosDkim = prov === 'google'
      ? ['Abre la Consola de administración de Google (botón de abajo).', 'Elige tu dominio y pulsa "Generar nuevo registro".', 'Google te muestra un nombre (google._domainkey) y un valor largo. Cópialos.', 'Publícalos en el DNS del dominio como registro TXT.', 'Vuelve a la consola de Google y pulsa "Iniciar autenticación".']
      : prov === 'microsoft'
      ? ['Abre el portal de seguridad de Microsoft (botón de abajo).', 'Elige tu dominio. Si DKIM está apagado, verás dos registros CNAME: selector1._domainkey y selector2._domainkey, con sus valores.', 'Cópialos y publícalos en el DNS del dominio, como dos registros CNAME.', 'Espera unos minutos y activa el interruptor "Firmar mensajes de este dominio con firmas DKIM".']
      : prov === 'zoho'
      ? ['Abre el panel de administración de Zoho (botón de abajo).', 'Ve a Dominios → tu dominio → DKIM, y agrega un selector.', 'Zoho te muestra un nombre y un valor TXT. Publícalos en el DNS del dominio.', 'Vuelve a Zoho y pulsa "Verificar".']
      : ['Pide a tu proveedor de correo la clave DKIM de tu dominio.', 'Publícala en el DNS como te la indique (normalmente un registro TXT).'];
    checks.push(check('dkim', 'DKIM', 'warn', 'No encontramos la firma DKIM con los nombres habituales (puede existir con otro nombre).', {
      pasos: pasosDkim, panel: P ? { nombre: P.panelNombre, url: P.panelDkim } : dnsPanel,
      registro: prov === 'microsoft' ? { tipo: 'CNAME (dos)', nombre: `selector1._domainkey y selector2._domainkey`, valor: 'Te lo muestra el portal de Microsoft (depende de tu cuenta)', actual: '' }
              : prov === 'google' ? { tipo: 'TXT', nombre: 'google._domainkey', valor: 'Te lo muestra la consola de Google (depende de tu cuenta)', actual: '' } : null,
      nota: 'Esto no se puede generar desde Nova: la clave la crea tu proveedor para tu cuenta.' }));
  }

  // ── DMARC ──
  const dm = (await txt('_dmarc.' + domain)).filter(t => /^v=DMARC1/i.test(t));
  if (!dm.length) {
    checks.push(check('dmarc', 'DMARC', 'fail', 'No hay registro DMARC.', {
      pasos: ['Entra al panel de DNS del dominio.', 'Crea un registro TXT con el nombre y el valor de abajo.', 'Empieza en "none": solo observa y no bloquea nada, así que es seguro.', 'Cambia tucorreo@ por un correo tuyo donde quieras recibir los reportes.'],
      registro: { tipo: 'TXT', nombre: '_dmarc', valor: `v=DMARC1; p=none; rua=mailto:tucorreo@${domain}`, actual: '' }, panel: dnsPanel }));
  } else {
    const p = (dm[0].match(/\bp=(\w+)/i) || [])[1] || '';
    if (/^none$/i.test(p)) {
      checks.push(check('dmarc', 'DMARC', 'warn', 'Existe, pero solo observa (p=none). Es un buen comienzo.', {
        pasos: ['Primero deja SPF y DKIM en verde.', 'Luego edita este registro y cambia p=none por p=quarantine; pct=25 (así solo aplica al 25 % de los mensajes sospechosos).', 'Si no ves problemas en unas semanas, sube pct a 100.'],
        registro: { tipo: 'TXT', nombre: '_dmarc', valor: dm[0].replace(/\bp=none\b/i, 'p=quarantine; pct=25'), actual: dm[0] }, panel: dnsPanel,
        nota: 'No es urgente: puedes enviar con p=none. Mejora la protección contra suplantación.' }));
    } else checks.push(check('dmarc', 'DMARC', 'ok', `Correcto (política ${p || 'definida'}).`, { registro: { actual: dm[0] } }));
  }

  const fails = checks.filter(c => c.estado === 'fail').length, warns = checks.filter(c => c.estado === 'warn').length;
  const resumen = fails ? { estado: 'fail', texto: 'Hay que arreglar antes de enviar en volumen' }
    : warns ? { estado: 'warn', texto: 'Casi listo: hay mejoras recomendadas' }
    : { estado: 'ok', texto: 'Listo para enviar' };
  return { domain, provider: prov, proveedorNombre: P ? P.nombre : '', dnsHost: host.nombre, checkedAt: new Date().toISOString(), resumen, checks };
}

module.exports = { checkDomain };
