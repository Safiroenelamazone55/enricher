'use strict';
// Filtros de la Base global al estilo de lemlist («Base de datos de prospectos»): un catálogo de filtros de Personas y de Empresas.
// Cada filtro tiene valores a INCLUIR y a EXCLUIR (etiquetas). Dentro de un filtro, los valores incluidos suman (O); entre filtros se cruzan (Y).
// Los filtros para los que Nova NO tiene dato (años de experiencia, habilidades, plantilla por departamento…) aparecen con la etiqueta «Sin datos».
// «legacy»: filtros que ya existían (país, industria, tamaño…); siguen usando su propio mecanismo en el servidor.

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Conversión de textos del archivo importado a números ──
function parseDinero(t) {   // «$10M - $20M» → 10000000 (límite inferior), «20000000», «3M», «1.2B»
  const m = String(t || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kKmMbB]?)/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}
function parseAnios(t) {    // «1 yr 10 mos» / «9 mos» / «2 años 3 meses» → años
  const s = String(t || '').toLowerCase();
  if (!s) return null;
  const y = (s.match(/(\d+)\s*(?:yr|yrs|year|years|año|años)/) || [])[1], mo = (s.match(/(\d+)\s*(?:mo|mos|month|months|mes|meses)/) || [])[1];
  if (y == null && mo == null) return null;
  return (parseInt(y || 0, 10)) + (parseInt(mo || 0, 10)) / 12;
}
const slugLi = u => { const m = String(u || '').match(/linkedin\.com\/(?:in|sales\/lead)\/([^\/?#]+)/i); return m ? decodeURIComponent(m[1]).toLowerCase() : ''; };
const anioFund = t => { const m = String(t || '').match(/(1[89]\d\d|20\d\d)/); return m ? parseInt(m[1], 10) : null; };
const primerNum = t => { const m = String(t == null ? '' : t).replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };

const CUBOS = {
  fundacion: [['Antes de 1990', 0, 1989], ['1990 – 1999', 1990, 1999], ['2000 – 2009', 2000, 2009], ['2010 – 2014', 2010, 2014], ['2015 – 2019', 2015, 2019], ['2020 o después', 2020, 9999]],
  ingresos: [['Menos de 1 M', 0, 999999], ['1 M – 10 M', 1e6, 9999999], ['10 M – 50 M', 1e7, 49999999], ['50 M – 100 M', 5e7, 99999999], ['100 M – 1 000 M', 1e8, 999999999], ['Más de 1 000 M', 1e9, 1e15]],
  antiguedad: [['Menos de 6 meses', 0, 0.499], ['6 a 12 meses', 0.5, 0.999], ['1 a 2 años', 1, 1.999], ['2 a 5 años', 2, 4.999], ['5 a 10 años', 5, 9.999], ['Más de 10 años', 10, 99]],
  empleados: [['1-10', 1, 10], ['11-50', 11, 50], ['51-200', 51, 200], ['201-500', 201, 500], ['501-1 000', 501, 1000], ['1 001-5 000', 1001, 5000], ['5 001-10 000', 5001, 10000], ['Más de 10 000', 10001, 1e9]],
};

// ── Catálogo ──
const C = [];
const add = (id, label, grupo, ent, tipo, o) => C.push({ id, label, grupo, ent, tipo, ...(o || {}) });
const SIN = (id, label, grupo, ent) => add(id, label, grupo, ent, 'sin', { sin: true });
const full = r => [r.nombre, r.apellido].filter(Boolean).join(' ');

// Filtros propios de Nova (primero, como «Filtros de lemlist»)
add('ya_crm', 'Ya está en tu CRM', 'Filtros de Nova', 'persona', 'bool', { get: r => r.origen === 'crm' });
add('sin_secuencia', 'No está en una secuencia', 'Filtros de Nova', 'persona', 'bool', { get: r => !String(r.secuencias || '').trim() });
add('lista', 'Lista (borrador de Cantera)', 'Filtros de Nova', 'empresa', 'lista', { get: r => r.b_nombre || '' });
// Cargo y experiencia
add('cargo', 'Cargo actual', 'Cargo y experiencia', 'persona', 'texto', { get: r => r.cargo });
add('seniority', 'Antigüedad (nivel)', 'Cargo y experiencia', 'persona', 'lista', { legacy: 'seniority' });
add('antig_puesto', 'Antigüedad en el puesto actual', 'Cargo y experiencia', 'persona', 'cubo', { cubos: CUBOS.antiguedad, num: r => parseAnios(r.c_antiguedad), parcial: 'Solo contactos de Sales Navigator' });
add('departamento', 'Departamento', 'Cargo y experiencia', 'persona', 'lista', { legacy: 'departamento' });
add('kw_perfil', 'Palabra clave en el perfil', 'Cargo y experiencia', 'persona', 'texto', { get: r => [r.cargo, r.departamento, r.seniority, r.empresa, r.industria].join(' '), sug: false });
SIN('anios_exp', 'Años de experiencia', 'Cargo y experiencia', 'persona');
SIN('puesto_anterior', 'Puesto anterior', 'Cargo y experiencia', 'persona');
// Ubicación
add('pais', 'País', 'Ubicación', 'persona', 'lista', { legacy: 'pais' });
add('ciudad', 'Ciudad / Estado', 'Ubicación', 'persona', 'lista', { legacy: 'ciudad' });
add('region', 'Región', 'Ubicación', 'persona', 'lista', { get: r => r.c_region || r.w_region || '' });
// Perfil
add('nombre', 'Nombre completo', 'Perfil', 'persona', 'texto', { get: full });
add('idioma', 'Idiomas', 'Perfil', 'persona', 'lista', { get: r => r.c_idioma || '' });
SIN('habilidades', 'Habilidades', 'Perfil', 'persona');
SIN('centro_educ', 'Nombre del centro educativo', 'Perfil', 'persona');
SIN('titulacion', 'Titulación académica', 'Perfil', 'persona');
SIN('intereses', 'Intereses', 'Perfil', 'persona');
SIN('n_conexiones', 'Número de conexiones', 'Perfil', 'persona');
add('li_url', 'URL de LinkedIn del contacto', 'Perfil', 'persona', 'texto', { get: r => r.c_linkedin, sug: false });
add('li_slug', 'Slug de LinkedIn del contacto', 'Perfil', 'persona', 'texto', { get: r => slugLi(r.c_linkedin), sug: false });
// Información de la empresa
add('empresa', 'Nombre de la empresa', 'Información de la empresa', 'empresa', 'texto', { get: r => r.empresa });
SIN('empresa_anterior', 'Empresa anterior', 'Información de la empresa', 'persona');
add('kw_empresa', 'Palabra clave en empresa', 'Información de la empresa', 'empresa', 'texto', { get: r => [r.empresa, r.industria, r.w_segmento, r.w_desc].join(' '), sug: false });
SIN('empresas_similares', 'Empresas similares', 'Información de la empresa', 'empresa');
add('industria', 'Sector de la empresa', 'Información de la empresa', 'empresa', 'lista', { legacy: 'industria' });
SIN('tipo_empresa', 'Tipo de empresa', 'Información de la empresa', 'empresa');
add('tiene_web', 'Tiene un sitio web', 'Información de la empresa', 'empresa', 'bool', { get: r => !!String(r.w_website || r.dominio || '').trim() });
add('mercado', 'Mercado de la empresa', 'Información de la empresa', 'empresa', 'lista', { get: r => r.w_segmento || '' });
add('fundacion', 'Año de fundación de la empresa', 'Información de la empresa', 'empresa', 'cubo', { cubos: CUBOS.fundacion, num: r => anioFund(r.w_fundada), parcial: 'Pocas empresas traen este dato' });
add('li_empresa', 'URL de LinkedIn de la empresa', 'Información de la empresa', 'empresa', 'texto', { get: r => r.w_linkedin, sug: false });
add('web_url', 'URL del sitio web de la empresa', 'Información de la empresa', 'empresa', 'texto', { get: r => [r.w_website, r.dominio].join(' '), sug: false });
add('empresa_id', 'Empresa actual por _id', 'Información de la empresa', 'empresa', 'texto', { get: r => String(r.lm_company_id || r.company_id || ''), sug: false });
// Ubicación de la empresa
add('pais_empresa', 'País de la empresa', 'Ubicación de la empresa', 'empresa', 'lista', { legacy: 'pais' });
add('region_empresa', 'Región de la empresa', 'Ubicación de la empresa', 'empresa', 'lista', { get: r => r.w_region || '' });
add('ciudad_empresa', 'Ciudad / estado de la empresa', 'Ubicación de la empresa', 'empresa', 'lista', { get: r => r.w_ciudad || '' });
// Tamaño de la empresa y datos financieros
add('tamano', 'Tamaño de la empresa', 'Tamaño de la empresa y datos financieros', 'empresa', 'lista', { legacy: 'tamano' });
add('ingresos', 'Ingresos de la empresa', 'Tamaño de la empresa y datos financieros', 'empresa', 'cubo', { cubos: CUBOS.ingresos, num: r => parseDinero(r.w_ingresos), parcial: 'Pocas empresas traen este dato' });
add('empleados', 'Empleados en LinkedIn', 'Tamaño de la empresa y datos financieros', 'empresa', 'cubo', { cubos: CUBOS.empleados, num: r => primerNum(r.w_empleados), parcial: 'Solo empresas de Sales Navigator' });
SIN('crec_tamano', 'Crecimiento del tamaño de la empresa (6 meses)', 'Tamaño de la empresa y datos financieros', 'empresa');
add('ronda', 'Última ronda de financiación de la empresa', 'Tamaño de la empresa y datos financieros', 'empresa', 'texto', { get: r => r.w_funding });
// Plantilla de equipo
for (const [id, l] of [['pl_soporte', 'Número de personal de atención al cliente'], ['pl_ing', 'Plantilla de ingeniería'], ['pl_fin', 'Personal de finanzas, legal y administración'], ['pl_rrhh', 'Número de personal de recursos humanos'], ['pl_mkt', 'Plantilla de marketing'], ['pl_ops', 'Personal de Operaciones'], ['pl_ventas', 'Número de personal de ventas'],
  ['cr_soporte', 'Crecimiento del servicio de atención al cliente (6 meses)'], ['cr_ing', 'Ingeniería de crecimiento (6 meses)'], ['cr_fin', 'Finanzas, legal y administración en crecimiento (6 meses)'], ['cr_rrhh', 'Crecimiento de recursos humanos (6 meses)'], ['cr_mkt', 'Crecimiento de marketing (6 meses)'], ['cr_ops', 'Crecimiento de Operaciones (6 meses)'], ['cr_ventas', 'Crecimiento de ventas (6 meses)']]) SIN(id, l, 'Plantilla de equipo', 'empresa');
// Tecnologías
add('tecnologias', 'Tecnologías de la empresa', 'Tecnologías de la empresa', 'empresa', 'texto', { get: r => r.w_tecnologias });
SIN('tec_recientes', 'Tecnologías detectadas recientemente (últimos 6 meses)', 'Tecnologías de la empresa', 'empresa');
SIN('tec_aniv', 'Próximo aniversario de tecnología (próximos 6 meses)', 'Tecnologías de la empresa', 'empresa');
// Ofertas de empleo
SIN('of_kw', 'Palabra clave en ofertas de empleo', 'Ofertas de empleo', 'empresa');
SIN('of_titulo', 'Título del puesto abierto', 'Ofertas de empleo', 'empresa');
SIN('of_ubic', 'Ubicación de la oferta de empleo', 'Ofertas de empleo', 'empresa');
SIN('of_fecha', 'Fecha de publicación de la oferta de empleo', 'Ofertas de empleo', 'empresa');
// Datos de LinkedIn
SIN('li_interaccion', 'Interacción en una publicación de LinkedIn', 'Datos de LinkedIn', 'persona');
// Cantera
add('tier', 'Tier', 'Cantera', 'empresa', 'lista', { legacy: 'tier' });
add('paso2', 'Validación profunda', 'Cantera', 'empresa', 'lista', { legacy: 'paso2' });
// Outbound
add('cliente', 'Cliente outbound', 'Outbound', 'empresa', 'lista', { legacy: 'cliente' });
add('secuencia', 'Secuencia', 'Outbound', 'empresa', 'lista', { legacy: 'secuencia' });
add('estado', 'Estado del contacto', 'Outbound', 'persona', 'lista', { legacy: 'estado' });

const MAP = Object.fromEntries(C.map(d => [d.id, d]));
const GRUPOS = [...new Set(C.map(d => d.grupo))];

const vals = (d, r) => { const v = d.get ? d.get(r) : ''; return Array.isArray(v) ? v : [v]; };
const splitLista = v => String(v == null ? '' : v).split(/[,;]/).map(s => s.trim()).filter(Boolean);

// ¿esta fila cumple UN valor de este filtro?
function cumple(d, r, v) {
  if (d.tipo === 'texto') return vals(d, r).some(x => norm(x).includes(norm(v)));
  if (d.tipo === 'lista') return vals(d, r).flatMap(splitLista).some(x => norm(x) === norm(v));
  if (d.tipo === 'bool') return (!!d.get(r) ? 'Sí' : 'No') === v;
  if (d.tipo === 'cubo') { const n = d.num(r); if (n == null) return false; const b = d.cubos.find(c => c[0] === v); return !!b && n >= b[1] && n <= b[2]; }
  return false;
}
// f2 = { id: { inc: [...], exc: [...] } } — solo los filtros NUEVOS (los legacy van por su camino de siempre)
function matchF2(r, f2, skipId) {
  for (const id in f2) {
    if (id === skipId) continue;
    const d = MAP[id], s = f2[id];
    if (!d || d.sin || d.legacy || !s) continue;
    const inc = Array.isArray(s.inc) ? s.inc : [], exc = Array.isArray(s.exc) ? s.exc : [];
    if (inc.length && !inc.some(v => cumple(d, r, v))) return false;
    if (exc.length && exc.some(v => cumple(d, r, v))) return false;
  }
  return true;
}
function parseF2(txt) {
  if (!txt) return null;
  try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}
const tieneValor = (d, r) => {
  if (d.sin) return false;
  if (d.legacy) { const k = d.legacy; const m = { pais: r.pais, industria: r.industria, tamano: r.tamano, tier: r.tier, estado: r.estado, cliente: r.referencia, secuencia: r.secuencias, seniority: r.seniority, departamento: r.departamento, ciudad: r.ciudad, paso2: r.paso2_estado }; return !!String(m[k] || '').trim(); }
  if (d.tipo === 'cubo') return d.num(r) != null;
  if (d.tipo === 'bool') return true;
  return vals(d, r).some(x => String(x == null ? '' : x).trim() !== '');
};
function catalogo(rows) {
  const n = {};
  for (const d of C) n[d.id] = 0;
  for (const r of rows) for (const d of C) if (!d.sin && tieneValor(d, r)) n[d.id]++;
  return C.map(d => ({ id: d.id, label: d.label, grupo: d.grupo, ent: d.ent, tipo: d.tipo, legacy: d.legacy || '', sin: !!d.sin || (n[d.id] === 0), parcial: d.parcial || '', sug: d.sug !== false, cubos: d.cubos ? d.cubos.map(c => c[0]) : null, n: n[d.id] }));
}
function sugerir(rows, id, q) {
  const d = MAP[id]; if (!d || d.sin || d.legacy) return [];
  const qn = norm(q);
  if (d.tipo === 'bool') { const si = rows.filter(r => d.get(r)).length; return [{ value: 'Sí', n: si }, { value: 'No', n: rows.length - si }]; }
  if (d.tipo === 'cubo') { const out = d.cubos.map(c => ({ value: c[0], n: 0 })); for (const r of rows) { const x = d.num(r); if (x == null) continue; const i = d.cubos.findIndex(c => x >= c[1] && x <= c[2]); if (i >= 0) out[i].n++; } return out; }
  if (d.sug === false) return [];
  const cnt = new Map();
  for (const r of rows) {
    const vs = d.tipo === 'lista' ? vals(d, r).flatMap(splitLista) : vals(d, r).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    for (const v of new Set(vs)) { if (!v || (qn && !norm(v).includes(qn))) continue; cnt.set(v, (cnt.get(v) || 0) + 1); }
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, n]) => ({ value, n }));
}

function mount(app, { requireAuth, fetchAll }) {
  app.get('/api/cantera/filtros/catalogo', requireAuth, async (req, res) => {
    try { const rows = await fetchAll(req.workspaceOwnerId); res.json({ grupos: GRUPOS, filtros: catalogo(rows), total: rows.length }); }
    catch (e) { console.error('[canteraFiltros] catálogo', e.message); res.status(500).json({ error: 'No se pudo cargar el catálogo de filtros' }); }
  });
  app.get('/api/cantera/global/sugerir', requireAuth, async (req, res) => {
    try { const rows = await fetchAll(req.workspaceOwnerId); res.json(sugerir(rows, String(req.query.filtro || ''), String(req.query.q || ''))); }
    catch (e) { console.error('[canteraFiltros] sugerir', e.message); res.status(500).json([]); }
  });
}

module.exports = { mount, matchF2, parseF2, catalogo, sugerir, MAP, norm, parseDinero, parseAnios, slugLi };
