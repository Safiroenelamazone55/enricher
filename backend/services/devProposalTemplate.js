'use strict';
// «Propuesta comercial development v2»: plantilla con CAMPOS que se rellenan por cliente. Máximo 10 diapositivas, en lenguaje sencillo,
// con los cálculos del caso de negocio y las reglas de validación. Mismo diseño que la presentación interactiva (se reutiliza su CSS/JS).
// Idiomas del documento del cliente: es · en · pt · it (los avisos de validación para quien la prepara quedan en español).
const base = require('./presentationTemplate');

const LANGS = { es: 'Español', en: 'English', pt: 'Português', it: 'Italiano' };
// Texto por defecto de «A quién quiere venderle»: si se deja tal cual, en el documento sale en el idioma elegido.
const ICP_DEFAULT = { es: 'Tenemos en cuenta lo aprendido en proyectos anteriores, pero no lo damos por hecho: lo validamos con inteligencia comercial y definimos tu cliente ideal (ICP) contigo.', en: "We take into account what we learned in previous projects, but we don't take it for granted: we validate it with commercial intelligence and define your ideal client (ICP) together with you.", pt: 'Levamos em conta o que aprendemos em projetos anteriores, mas não o damos por certo: validamos com inteligência comercial e definimos seu cliente ideal (ICP) junto com você.', it: 'Teniamo conto di quanto appreso nei progetti precedenti, ma non lo diamo per scontato: lo convalidiamo con intelligence commerciale e definiamo il tuo cliente ideale (ICP) insieme a te.' };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const pn = n => String(n).padStart(2, '0');
const Sx = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// ── números: español/portugués/italiano (3.000 · 0,6) e inglés (3,000 · 0.6) ──
function fmt(n, dec, lang) {
  if (n == null || !isFinite(n)) return '—';
  const d = dec == null ? (Math.abs(n - Math.round(n)) < 1e-9 ? 0 : (Math.abs(n) < 10 ? 1 : 0)) : dec;
  const neg = n < 0; let s = Math.abs(n).toFixed(d); let [i, f] = s.split('.');
  const en = lang === 'en';
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, en ? ',' : '.');
  return (neg ? '-' : '') + i + (f ? (en ? '.' : ',') + f : '');
}
const num = v => { if (v === '' || v == null) return null; const x = parseFloat(String(v).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(x) ? x : null; };
const today = () => new Date().toISOString().slice(0, 10);

// Campos propios de esta plantilla (los datos del cliente —empresa, contacto, cargo, correo, moneda— viven en los campos habituales del documento).
function cleanDev(d) {
  d = d || {}; const o = {};
  for (const [k, n] of [['oferta_cliente', 200], ['cliente_ideal', 200], ['dolor_cliente', 240], ['decision_quien', 80], ['decision_plazo', 60], ['resultados_referencia', 300]]) o[k] = Sx(d[k], n);
  o.fecha_propuesta = /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_propuesta || '')) ? d.fecha_propuesta : today();
  const N = (k, def, lo, hi) => { const v = num(d[k]); o[k] = v == null ? (def === undefined ? null : def) : Math.min(hi, Math.max(lo, v)); };
  N('reuniones_mes_hoy', null, 0, 10000); N('valor_cliente', null, 0, 1e9); N('cierre_pct', null, 0, 100); N('ciclo_dias', null, 0, 1000);
  N('validez_dias', 10, 1, 180); N('margen_pct', 100, 1, 100); N('reuniones_objetivo', 3, 1, 100); N('cierre_supuesto_pct', 20, 1, 100);
  N('precio_piloto', 500, 1, 1e8); N('precio_mensual', 750, 1, 1e8); N('bonus_reunion', 100, 0, 1e8); N('umbral_bonus', 3, 0, 1000);
  N('horas_semana_prospeccion', null, 0, 168); N('valor_hora', null, 0, 1e6);
  o.horas_origen = d.horas_origen === 'real' ? 'real' : 'supuesto';
  o.usar_supuesto_horas = d.usar_supuesto_horas === true || d.usar_supuesto_horas === 'true';
  o.cierre_sin_dato = d.cierre_sin_dato === true || d.cierre_sin_dato === 'true';
  o.incluir_whatsapp = d.incluir_whatsapp === true || d.incluir_whatsapp === 'true';
  o.diseno_anterior = d.diseno_anterior === true || d.diseno_anterior === 'true';   // por defecto: diseño «Suizo-Estudio»; con esto se usa el anterior
  o.estilo_sobrio = d.estilo_sobrio === true || d.estilo_sobrio === 'true';   // opcional: diapositivas claras y lisas, sin fondos oscuros (por defecto se usa el diseño original)
  return o;
}

// ── cálculos automáticos ──
function calc(p) {
  const d = (p && p.dev) || cleanDev({});
  const valor = d.valor_cliente || 0, margen = (d.margen_pct == null ? 100 : d.margen_pct) / 100;
  const real = d.cierre_pct != null && !d.cierre_sin_dato;
  const cierre = (real ? d.cierre_pct : (d.cierre_supuesto_pct == null ? 20 : d.cierre_supuesto_pct)) / 100;
  return build(valor, margen, cierre, d.reuniones_objetivo || 3, d.precio_mensual || 750, d.precio_piloto || 500, d.ciclo_dias, real);
}
function build(valor, margen, cierre, objetivo, mensual, piloto, ciclo, real) {
  const ventas = objetivo * cierre, ingreso = ventas * valor * margen;
  return { cierre_real: !!real, cierre_usado: cierre * 100, ventas_mes: ventas, ingreso_mes: ingreso,
    veces_mensual: mensual ? ingreso / mensual : 0, veces_piloto: piloto ? ingreso / piloto : 0,
    ventas_para_cubrir_piloto: valor * margen ? piloto / (valor * margen) : null,
    mes_primera_venta: ciclo == null ? null : Math.ceil(1 + ciclo / 30),
    ticket_minimo_3x: objetivo * cierre * margen ? 3 * mensual / (objetivo * cierre * margen) : null };
}

// «Fuga de tiempo del fundador»: dato de apoyo. NO suma al ingreso nuevo ni entra en veces_mensual / veces_piloto / la regla de 3×.
// Devuelve null (el bloque se oculta) si no hay horas ni valor de la hora, ni se activó «usar supuesto».
const FUGA_H = 20, FUGA_V = 15, FUGA_SEM = 4.3;
function fuga(p) {
  const d = (p && p.dev) || {};
  const usar = d.usar_supuesto_horas === true || d.usar_supuesto_horas === 'true';
  let h = d.horas_semana_prospeccion, v = d.valor_hora, hDef = false, vDef = false;
  if (!(h > 0) && usar) { h = FUGA_H; hDef = true; }
  if (!(v > 0) && usar) { v = FUGA_V; vDef = true; }
  if (!(h > 0) || !(v > 0)) return null;
  const sup = d.horas_origen !== 'real';
  const horas_mes = h * FUGA_SEM, coste_mes = horas_mes * v;
  return { h, v, horas_mes, coste_tiempo_mes: coste_mes, coste_tiempo_anio: coste_mes * 12, supH: sup || hDef, supV: sup || vDef, realH: !sup && !hDef };
}

// ── reglas de validación ──
const REQ = [['cliente_nombre', 'Nombre del cliente', p => p.contacto], ['cliente_empresa', 'Empresa del cliente', p => p.empresa], ['cliente_cargo', 'Cargo del cliente', p => p.clienteCargo],
  ['fecha_propuesta', 'Fecha de la propuesta', (p, d) => d.fecha_propuesta], ['validez_dias', 'Validez (días)', (p, d) => d.validez_dias],
  ['oferta_cliente', 'Qué vende el cliente', (p, d) => d.oferta_cliente], ['cliente_ideal', 'A quién quiere venderle', (p, d) => d.cliente_ideal],
  ['valor_cliente', 'Lo que te deja un cliente nuevo', (p, d) => (d.valor_cliente ? 'x' : '')],
  ['cierre_pct', 'De cada 10 reuniones, cuántas cierran', (p, d) => (d.cierre_sin_dato || d.cierre_pct != null ? 'x' : '')],
  ['moneda', 'Moneda', p => p.moneda]];
function validate(p) {
  const d = (p && p.dev) || cleanDev({}), faltan = [], avisos = [];
  for (const [k, l, get] of REQ) if (!String(get(p || {}, d) || '').trim()) faltan.push({ k, l });
  const c = calc(p), valor = d.valor_cliente || 0;
  if (!d.ciclo_dias) avisos.push({ nivel: 'amarillo', k: 'sin_ciclo', txt: 'No pusiste los días que tarda en firmar: se usa un estimado de 30 a 60 días y las diapositivas 2 y 3 lo muestran como estimado («depende de tu ciclo de venta»). Si el cliente te lo da, escríbelo y se sustituye.' });
  if (d.reuniones_mes_hoy == null) avisos.push({ nivel: 'amarillo', k: 'sin_reuniones', txt: 'Sin dato previo: no pusiste cuántas reuniones nuevas al mes tiene hoy. La diapositiva 2 dirá «sin dato previo». Los cálculos no cambian: usan la meta de 3 reuniones.' });
  const debil = !!valor && c.veces_mensual < 3;
  if (debil) avisos.push({ nivel: 'rojo', k: 'debil', txt: 'Caso débil: no ofrezcas el mensual. Con estos números el ingreso mensual no llega a 3 veces su precio; la propuesta queda solo con el piloto.' });
  if (d.valor_cliente != null && valor > 0 && valor < 2000) avisos.push({ nivel: 'rojo', k: 'valor', txt: 'No encaja con la oferta: un cliente nuevo vale menos de 2.000.' });
  const textos = [p.empresa, p.contacto, p.clienteCargo, p.correo, d.oferta_cliente, d.cliente_ideal, d.dolor_cliente, d.decision_quien, d.decision_plazo, d.resultados_referencia, p.inicio].filter(Boolean).join(' ');
  const cor = textos.match(/\[[^\]]{1,80}\]/g) || [];
  if (cor.length) avisos.push({ nivel: 'amarillo', k: 'corchetes', txt: 'Hay un texto entre [corchetes] sin rellenar: ' + cor.slice(0, 3).join(' ') });
  return { faltan, avisos, debil, c };
}

const MESES = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] };
const fechaLarga = (iso, lang) => {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return '';
  const mes = (MESES[lang] || MESES.es)[+m[2] - 1], d = +m[3];
  return lang === 'en' ? `${mes} ${d}, ${m[1]}` : lang === 'it' ? `${d} ${mes} ${m[1]}` : `${d} de ${mes} de ${m[1]}`;
};
const sumDays = (iso, n) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const EXTRA = `
.calc{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.calc .r{background:var(--cd);border:1px solid var(--cdb);border-radius:18px;padding:14px 22px;font-size:15px;line-height:1.35;color:var(--tx)}
.calc .r b{display:block;margin-top:4px;font-size:30px;font-weight:600;letter-spacing:-.035em;color:var(--hd)}
.calc .r.big{grid-column:span 2;border-color:var(--teal);display:flex;align-items:center;justify-content:space-between;gap:20px}
.calc .r.big b{margin:0;font-size:38px}
.sup{display:inline-block;margin-left:8px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#B45309;background:#FEF3C7;border-radius:99px;padding:2px 9px;vertical-align:middle}
.quote{margin-top:20px;border-left:3px solid var(--teal);padding:4px 0 4px 20px;font-size:22px;line-height:1.45;color:var(--hd);font-style:italic;max-width:900px}
.fm{margin-top:14px;font-size:15px;color:var(--tx)}
.xt{width:100%;border-collapse:collapse;margin-top:10px;font-size:14.5px;color:var(--tx)}
.xt th,.xt td{padding:8px 14px;text-align:right;border-bottom:1px solid var(--ln)}.xt th:first-child,.xt td:first-child{text-align:left}
.xt th{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);font-weight:600}.xt td b{color:var(--hd);font-weight:600}
.cf{margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cf .card{padding:18px 24px}.cf .card h3{margin-top:8px;font-size:18px}.cf .card p{margin-top:6px;font-size:14.5px;line-height:1.45}
.dolor{margin-top:18px}
.disc{font-size:14px}
.s-light .sim .tot,.s-soft .sim .tot{color:var(--hd)}
.s-light .sim .k,.s-soft .sim .k,.s-light .facts small,.s-soft .facts small,.s-light .steps i,.s-soft .steps i{color:var(--teal)}
.s-light .cap,.s-soft .cap{color:var(--mute);font-size:13.5px}
.s-light .portal{box-shadow:0 12px 34px rgba(15,23,42,.12);border:1px solid var(--ln)}
h2+.fuga{margin-top:26px}h2+.fm{margin-top:12px}
.calc.c3{grid-template-columns:repeat(3,1fr);margin-top:10px}.calc.c3 .r{padding:10px 18px}.calc.c3 .r b{font-size:26px}
.calc.c4{grid-template-columns:repeat(4,1fr);margin-top:12px;gap:10px}.calc.c4 .r{padding:12px 16px;font-size:15px}.calc.c4 .r b{font-size:27px}
.calc .r .rg{display:block;margin-top:2px;font-size:13px;color:var(--mute)}
.fuga{margin-top:14px;font-size:13px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--mute)}
.formula{display:flex;align-items:stretch;gap:8px;margin-top:8px;flex-wrap:wrap}
.formula .fac{flex:1 1 150px;background:var(--cd);border:1px solid var(--cdb);border-radius:16px;padding:8px 14px}
.formula .fac b{display:block;font-size:28px;font-weight:600;letter-spacing:-.035em;color:var(--hd);line-height:1.15}
.formula .fac span{display:block;margin-top:2px;font-size:14px;line-height:1.3;color:var(--tx)}
.formula .fac .rg{font-size:12.5px;color:#B45309;font-weight:600;letter-spacing:.03em}
.formula .fac.res{border-color:var(--teal);box-shadow:0 0 0 1px var(--teal) inset}
.formula .op{align-self:center;font-size:24px;color:var(--mute);font-weight:300}
.vs{margin-top:14px;display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:stretch}
.vs>div{border-radius:18px;padding:10px 20px;border:1px solid var(--cdb);background:var(--cd)}
.vs small{display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);font-weight:700}
.vs b{display:block;margin-top:2px;font-size:32px;font-weight:600;letter-spacing:-.035em;color:var(--hd)}
.vs b span{margin-left:6px;font-size:14px;font-weight:500;color:var(--mute);letter-spacing:0}
.vs i{display:block;margin-top:4px;font-size:15px;font-style:normal;color:var(--tx)}
.vs-b{border-color:var(--teal)!important}.vs-b i{color:var(--hd);font-weight:600}
.vs .vs-x{display:flex;align-items:center;border:0!important;background:none!important;padding:0!important;font-size:14px;font-weight:700;color:var(--mute);text-transform:uppercase}
@media(max-width:760px){.vs{grid-template-columns:1fr}.vs .vs-x{justify-content:center}.formula .op{width:100%;text-align:center}}

`;


const SUIZO = `
:root{--teal:#2563EB;--teal-l:#7AA5FF;--tl-rgb:122,165,255;--pr-rgb:37,99,235;--sans:'Manrope','Inter','Segoe UI',system-ui,sans-serif}
body,.deck,.slide{font-family:'Manrope','Inter','Segoe UI',system-ui,sans-serif}
h1,h2,h3,.fac b,.vs b,.calc .r b,.sim .tot,.facts b,.bn,.edb b{font-family:'Archivo','Manrope','Segoe UI',sans-serif}
.slide:not(.cover) h2{font-weight:800;letter-spacing:-.045em;line-height:1;padding-top:16px;border-top:6px solid var(--hd)}
.slide.s-dark:not(.cover) h2{border-top-color:#fff}
.slide h2 em,.cover h1 em{font-style:normal}
.cover h1{font-family:'Archivo','Manrope',sans-serif;font-weight:800;letter-spacing:-.045em}
.eyebrow{font-weight:800;letter-spacing:.14em}
.slide.s-light,.slide.s-soft{background:#F4F6FB;--hd:#0B1530;--tx:#33405E;--ln:#0B1530;--cd:#fff;--cdb:#0B1530;--mute:#5B6785}
.s-light .formula .fac,.s-soft .formula .fac,.s-light .calc .r,.s-soft .calc .r,.s-light .card,.s-soft .card,.s-light .vs>div,.s-soft .vs>div,.s-light .steps div,.s-soft .steps div,.s-light .facts>div,.s-soft .facts>div,.s-light .sim,.s-soft .sim,.s-light .tile,.s-soft .tile{border:2px solid #0B1530;border-radius:8px;box-shadow:none;background:#fff}
.s-light .formula .fac.res,.s-soft .formula .fac.res,.s-light .calc .r.big,.s-soft .calc .r.big,.s-light .vs>div.vs-b,.s-soft .vs>div.vs-b{background:#2563EB;border-color:#2563EB;box-shadow:none}
.s-light .top .brand,.s-soft .top .brand,.s-light .cnt,.s-soft .cnt{color:#0B1530}.s-light .cnt i,.s-soft .cnt i{color:#5B6785}
.s-light .btn-fs,.s-soft .btn-fs{color:#0B1530;border-color:#0B153055;background:transparent}
.s-light .formula .fac.res b,.s-soft .formula .fac.res b,.s-light .formula .fac.res span,.s-soft .formula .fac.res span,.s-light .vs-b b,.s-soft .vs-b b,.s-light .vs-b i,.s-soft .vs-b i,.s-light .vs-b small,.s-soft .vs-b small,.s-light .vs-b span,.s-soft .vs-b span,.s-light .calc .r.big b,.s-soft .calc .r.big b{color:#fff}
.s-light .formula .fac.res .rg,.s-soft .formula .fac.res .rg{color:#DCE7FF}
.s-light .xt th,.s-soft .xt th{color:#0B1530}.s-light .xt td,.s-soft .xt td{border-bottom-color:#0B153033}
.s-light .chip,.s-soft .chip{border:2px solid #0B1530;background:#fff;color:#0B1530}
.s-light::before,.s-soft::before{content:"";position:absolute;left:0;top:0;bottom:0;width:14px;background:#2563EB}
`;
function render(brand, p, langIn) {
  const lang = LANGS[langIn] ? langIn : 'es';
  // x(es, en, pt, it): el texto en el idioma del documento
  const x = (es, en, pt, it) => (lang === 'en' ? en : lang === 'pt' ? pt : lang === 'it' ? it : es);
  const F = (n, dec) => fmt(n, dec, lang);
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'Mi empresa';
  const web = (b.web || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const mail = b.email || '';
  const d = p.dev || cleanDev({});
  const v = validate(p), c = v.c, debil = v.debil;
  const empresa = p.empresa || x('Cliente', 'Client', 'Cliente', 'Cliente'), contacto = p.contacto || '', cargo = p.clienteCargo || '';
  const sym = p.moneda || 'US$';
  const m$ = n => sym + F(n, 0);
  const fecha = d.fecha_propuesta || today();
  const validez = d.validez_dias || 10;
  const clLogo = p.logoCliente && typeof p.logoCliente === 'object' && imgOk(p.logoCliente[p.logoCliente.usar]) ? p.logoCliente[p.logoCliente.usar] : '';
  const fotos = p.fotos !== false;
  const foto = imgOk(p.fotoPortada) ? p.fotoPortada : '';
  const obj = d.reuniones_objetivo || 3, piloto = d.precio_piloto || 500, mensual = d.precio_mensual || 750;
  const real = c.cierre_real, cierre = c.cierre_usado;
  const de10 = F(cierre / 10, cierre % 10 ? 1 : 0);
  const sinDato = x('sin dato previo', 'no prior data', 'sem dado prévio', 'nessun dato precedente');
  const dias = n => `${n} ${x('días', 'days', 'dias', 'giorni')}`;
  const veces = n => (Math.abs(n - 1) < 1e-9 ? `1 ${x('vez', 'time', 'vez', 'volta')}` : `${F(n)} ${x('veces', 'times', 'vezes', 'volte')}`);
  const pilotLbl = x('Piloto de 30 días', '30-day pilot', 'Piloto de 30 dias', 'Progetto progetto pilota di 30 giorni');
  const perMes = x('/mes', '/month', '/mês', '/mese');

  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (elegido, orden) => { for (const k of [elegido, ...orden]) if (imgOk(logos[k])) return logos[k]; return ''; };
  const dataW = pick(b.logo_oscuro || 'blanco', ['blanco', 'color', 'negro']), dataC = pick(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const brandW = dataW ? `<img alt="${esc(marca)}" src="${dataW}">` : `<span class="wm">${esc(marca)}</span>`;
  const brandC = dataC ? `<img alt="${esc(marca)}" src="${dataC}">` : `<span class="wm">${esc(marca)}</span>`;

  const U = id => `https://images.unsplash.com/photo-${id}?fm=jpg&fit=crop&w=1600&q=70`;
  const dkr = rgb(dark);
  const ovV = (a, b2) => `linear-gradient(180deg,rgba(${dkr},${a}) 0%,rgba(${dkr},${b2}) 100%)`;
  const ovL = (a, b2) => `linear-gradient(90deg,rgba(${dkr},${a}) 0%,rgba(${dkr},${b2}) 100%)`;
  const bgDark = `<div class="bg"><div class="blob a"></div><div class="blob b"></div><div class="grid"></div></div>`;
  const bgFoto = (id, ov) => (fotos ? `<div class="bgph" style="background-image:url('${U(id)}');--ov:${ov}"></div><div class="bg"><div class="blob a"></div></div>` : bgDark);
  const hero = (id, n) => (fotos ? `<div class="hero"><i style="background-image:url('${U(id)}')"></i><b>${n}</b></div>` : '');
  const ttAttr = fotos ? 'dark' : 'light';
  const sup = rango => `<span class="sup">${x('supuesto', 'assumption', 'suposto', 'ipotesi')} · ${rango}</span>`;
  const rangoTxt = (a, z, pct) => `${x('rango', 'range', 'faixa', 'intervallo')} ${a}–${z}${pct ? ' %' : ''}`;
  const supOnly = () => `<span class="sup">${x('supuesto', 'assumption', 'suposto', 'ipotesi')}</span>`;
  const li_ = a => a.map(t => `<li>${t}</li>`).join('');
  const S = [];

  // 1 · portada
  const year = fecha.slice(0, 4);
  const edPhoto = foto || (fotos ? U('1486406146926-c627a92ad1ab') : '');
  const artSvg = `<svg viewBox="0 0 400 520" fill="none"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${prim}"/></linearGradient></defs><g stroke="url(#g1)" stroke-width="1.4" opacity=".7"><path d="M60 120 L190 70 L330 140 L270 260 L120 240 Z"/><path d="M190 70 L270 260"/><path d="M60 120 L270 260"/><path d="M330 140 L120 240"/><path d="M120 240 L180 400 L300 360 L270 260"/></g><g fill="url(#g1)"><circle cx="60" cy="120" r="9"/><circle cx="190" cy="70" r="12"/><circle cx="330" cy="140" r="9"/><circle cx="270" cy="260" r="14"/><circle cx="120" cy="240" r="10"/><circle cx="180" cy="400" r="12"/><circle cx="300" cy="360" r="9"/></g></svg>`;
  const edPh = (n, h, w) => `<li><i>${n}</i><b>${h}</b><span>${w}</span></li>`;
  const wk = (a, z) => `${x('Semanas', 'Weeks', 'Semanas', 'Settimane')} ${a}–${z}`;
  const wkFrom = n => x(`Desde la semana ${n}`, `From week ${n}`, `A partir da semana ${n}`, `Dalla settimana ${n}`);
  const precios = debil ? `${pilotLbl}: ${m$(piloto)}` : `${pilotLbl}: ${m$(piloto)} · ${x('Después', 'Then', 'Depois', 'Poi')}, ${m$(mensual)}${perMes}`;
  const empLen = empresa.length;
  const propPara = x('Propuesta para', 'Proposal for', 'Proposta para', 'Proposta per');
  const validaN = n => x(`Válida ${n} días`, `Valid for ${n} days`, `Válida por ${n} dias`, `Valida ${n} giorni`);
  S.push(`<section class="slide cover ed s-light" data-th="light" data-tt="light" data-cv="1"><div class="edph">${edPhoto ? `<i style="background-image:url('${edPhoto}')"></i>` : `<div class="edsvg">${artSvg}</div>`}<ul class="edl">${edPh('01', x('Investigamos', 'We research', 'Pesquisamos', 'Analizziamo'), wk(1, 2))}${edPh('02', x('Contactamos', 'We reach out', 'Entramos em contato', 'Contattiamo'), wk(2, 3))}${edPh('03', x('Mejoramos', 'We improve', 'Melhoramos', 'Miglioriamo'), wkFrom(4))}</ul><span class="edv">${esc(marca)} · ${x('Propuesta comercial', 'Commercial proposal', 'Proposta comercial', 'Proposta commerciale')} · ${esc(year)}</span></div><div class="content">
<div class="edt rv" style="--d:0"><span>${esc(fechaLarga(fecha, lang))}</span><span>${propPara} ${esc(empresa)}</span><span>${validaN(validez)}</span></div>
<div class="edm"><h1 class="rv${empLen > 14 ? ' long' : ''}" style="--d:1">${propPara} <em>${esc(empresa)}</em></h1>
<p class="sub rv" style="--d:2">${esc(precios)}</p></div>
<div class="edb rv" style="--d:4"><div><small>${x('Para', 'For', 'Para', 'Per')}</small><b>${clLogo ? `<img class="cl-${esc(p.logoCliente.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : esc(contacto || '—')}<span>${esc([contacto && clLogo ? contacto : '', cargo].filter(Boolean).join(', ') || (clLogo ? '' : cargo))}</span></b></div>
<div><small>${pilotLbl}</small><b>${m$(piloto)}<span>${x('Pago único', 'One-time payment', 'Pagamento único', 'Pagamento unico')}</span></b></div>
<div><small>${debil ? x('Válida', 'Valid', 'Válida', 'Valida') : x('Después', 'Then', 'Depois', 'Poi')}</small><b>${debil ? dias(validez) : m$(mensual) + perMes}<span>${debil ? x('desde la fecha de envío', 'from the date sent', 'a partir da data de envio', 'dalla data di invio') : validaN(validez)}</span></b></div></div>
</div></section>`);

  // 2 · lo que me contaste
  const cierran = d.cierre_sin_dato || d.cierre_pct == null ? '' : x('; de cada 10 cierran ', '; out of every 10, ', '; de cada 10, fecham ', '; su 10 ne chiudono ') + de10 + (lang === 'en' ? ' close' : '');
  const decide = d.decision_quien || d.decision_plazo
    ? x('. Decide ', '. The decision is made by ', '. Decide ', '. Decide ') + esc([d.decision_quien, d.decision_plazo ? x('en ', 'within ', 'em ', 'entro ') + d.decision_plazo : ''].filter(Boolean).join(' '))
    : '';
  const cicloTxt = d.ciclo_dias
    ? x(`tardas ${d.ciclo_dias} días en firmar`, `it takes you ${d.ciclo_dias} days to sign`, `você leva ${d.ciclo_dias} dias para fechar`, `impieghi ${d.ciclo_dias} giorni per firmare`)
    : x('tu ciclo de venta (lo estimamos entre 30 y 60 días) marca cuándo llega la primera venta', 'your sales cycle (we estimate 30 to 60 days) sets when the first sale lands', 'o seu ciclo de vendas (estimamos entre 30 e 60 dias) define quando chega a primeira venda', 'il tuo ciclo di vendita (lo stimiamo tra 30 e 60 giorni) determina quando arriva la prima vendita');
  const valCli = d.valor_cliente ? m$(d.valor_cliente) : '—';
  const fg = fuga(p);
  const qOpen = lang === 'en' ? '“' : '«', qClose = lang === 'en' ? '”' : '»';
  S.push(`<section class="slide s-soft${fotos ? ' hasband' : ''}" data-th="light" data-tt="${ttAttr}">${hero('1551288049-bebda4e38f71', '01')}<div class="content"><div class="bh"><div class="eyebrow rv">01 · ${x('Lo que hablamos', 'What we discussed', 'O que conversamos', 'Di cosa abbiamo parlato')}</div>
<h2 class="rv" style="--d:1">${x('Lo que me <em>contaste.</em>', 'What you <em>told me.</em>', 'O que você <em>me contou.</em>', 'Quello che <em>mi hai detto.</em>')}</h2></div>
<div class="cf">
<div class="card rv" style="--d:1"><div class="n">01</div><h3>${x('Qué vendes', 'What you sell', 'O que você vende', 'Cosa vendi')}</h3><p>${esc(d.oferta_cliente) || '—'}</p></div>
<div class="card rv" style="--d:2"><div class="n">02</div><h3>${x('A quién quieres venderle', 'Who you want to sell to', 'Para quem você quer vender', 'A chi vuoi vendere')}</h3><p>${esc(String(d.cliente_ideal || '').trim() === ICP_DEFAULT.es ? ICP_DEFAULT[lang] : d.cliente_ideal) || '—'}</p></div>
<div class="card rv" style="--d:3"><div class="n">03</div><h3>${x('Dónde estás hoy', 'Where you are today', 'Onde você está hoje', 'Dove sei oggi')}</h3><p>${d.reuniones_mes_hoy == null
    ? x('Reuniones nuevas al mes: sin dato previo', 'New meetings per month: no prior data', 'Novas reuniões por mês: sem dado prévio', 'Nuovi incontri al mese: nessun dato precedente')
    : (d.reuniones_mes_hoy === 1 ? x('Consigues 1 reunión nueva al mes', 'You get 1 new meeting per month', 'Você consegue 1 nova reunião por mês', 'Ottieni 1 nuovo incontro al mese') : x(`Consigues ${F(d.reuniones_mes_hoy, 0)} reuniones nuevas al mes`, `You get ${F(d.reuniones_mes_hoy, 0)} new meetings per month`, `Você consegue ${F(d.reuniones_mes_hoy, 0)} novas reuniões por mês`, `Ottieni ${F(d.reuniones_mes_hoy, 0)} nuovi incontri al mese`))}${cierran}.${fg && fg.realH ? ' ' + x(`Dedicas ${F(fg.h)} horas a la semana a buscar clientes.`, `You spend ${F(fg.h)} hours a week looking for clients.`, `Você dedica ${F(fg.h)} horas por semana a buscar clientes.`, `Dedichi ${F(fg.h)} ore a settimana a cercare clienti.`) : ''}</p></div>
<div class="card rv" style="--d:4"><div class="n">04</div><h3>${x('Lo que vale cerrar', 'What a close is worth', 'Quanto vale fechar', 'Quanto vale chiudere')}</h3><p>${x(`Cada cliente nuevo te deja ${valCli} y `, `Each new client brings you ${valCli} and `, `Cada novo cliente rende ${valCli} e `, `Ogni nuovo cliente ti porta ${valCli} e `)}${cicloTxt}${decide}.</p></div></div>
${d.dolor_cliente ? `<div class="quote rv" style="--d:5">${qOpen}${esc(String(d.dolor_cliente).replace(/^["«»“”]+|["«»“”]+$/g, ''))}${qClose}</div>` : ''}</div></section>`);

  // 3 · la cuenta: lo que hoy se deja de ganar y lo que cuesta hacerlo a mano (cada fuga como una fórmula: factor × factor = resultado)
  const Fd = n => F(n, Math.abs(n - Math.round(n)) < 1e-9 ? 0 : 1);
  const mg = (d.margen_pct || 100) / 100, valNeto = d.valor_cliente ? d.valor_cliente * mg : 0;
  const hayValor = !!d.valor_cliente;   // sin el valor de un cliente nuevo no se puede calcular el ingreso: se muestra «sin dato previo», no ceros
  const fac = (val, lbl, rg, cls) => `<div class="fac${cls ? ' ' + cls : ''}"><b>${val}</b><span>${lbl}</span>${rg ? `<span class="rg">${rg}</span>` : ''}</div>`;
  const opx = t => `<div class="op">${t}</div>`;
  const supR = r => `${x('supuesto', 'assumption', 'suposto', 'ipotesi')} · ${r}`;
  const alMes = x('al mes', 'per month', 'por mês', 'al mese'), alAnio = x('Al año', 'Per year', 'Por ano', "All'anno");
  const stripA = `<p class="fuga rv" style="--d:2">${x('Reuniones que hoy no tienes', 'Meetings you do not have today', 'Reuniões que você não tem hoje', 'Incontri che oggi non hai')} · ${x('lo que dejas de ganar', 'what you are missing out on', 'o que você deixa de ganhar', 'quello che non guadagni')}</p>
<div class="formula rv" style="--d:2">${fac(F(obj, 0), x('reuniones nuevas al mes con nosotros', 'new meetings per month with us', 'novas reuniões por mês conosco', 'nuovi incontri al mese con noi'), supR(rangoTxt(2, 5)), '')}${opx('×')}
${fac(F(cierre, 0) + ' %', x('de las reuniones acaban en cliente', 'of meetings end up as a client', 'das reuniões viram cliente', 'degli incontri diventano cliente'), real ? '' : supR(rangoTxt('10', '30', true)), '')}${opx('×')}
${fac(valNeto ? m$(valNeto) : '—', x('lo que vale un cliente nuevo', 'what a new client is worth', 'quanto vale um novo cliente', 'quanto vale un nuovo cliente') + ((d.margen_pct || 100) < 100 ? x(` (con tu margen del ${F(d.margen_pct, 0)} %)`, ` (at your ${F(d.margen_pct, 0)} % margin)`, ` (com sua margem de ${F(d.margen_pct, 0)} %)`, ` (con il tuo margine del ${F(d.margen_pct, 0)} %)`) : ''), '', '')}${opx('=')}
${fac(hayValor ? m$(c.ingreso_mes) : '—', hayValor ? alMes : sinDato, x('ingreso nuevo', 'new revenue', 'nova receita', 'nuovo ricavo'), 'res')}</div>
<p class="fm rv" style="--d:3">${F(obj, 0)} × ${F(cierre, 0)} % = ${F(c.ventas_mes)} ${x('ventas nuevas al mes', 'new sales per month', 'novas vendas por mês', 'nuove vendite al mese')}${hayValor ? `; ${F(c.ventas_mes)} × ${m$(valNeto)} = ${m$(c.ingreso_mes)} ${alMes}. <b>${alAnio}: ${m$(c.ingreso_mes * 12)}.</b>` : '.'}</p>`;
  const stripB = !fg ? '' : `<p class="fuga rv" style="--d:4">${x('Tu tiempo, o el de tu equipo, buscando clientes a mano', 'Your time, or your team’s, looking for clients by hand', 'Seu tempo, ou o da sua equipe, buscando clientes à mão', 'Il tuo tempo, o quello del tuo team, per cercare clienti a mano')} · ${x('lo que cuesta hacerlo tú', 'what it costs to do it yourself', 'quanto custa fazer você mesmo', 'quanto costa farlo tu')}</p>
<div class="formula rv" style="--d:4">${fac(F(fg.h) + ' h', x('horas a la semana: buscar, escribir, seguimientos y reuniones previas', 'hours a week: searching, writing, follow-ups and prep meetings', 'horas por semana: buscar, escrever, acompanhamentos e reuniões prévias', 'ore a settimana: ricerca, scrittura, follow-up e incontri preliminari'), fg.supH ? supR(rangoTxt(5, 20) + ' h') : '', '')}${opx('×')}
${fac(F(FUGA_SEM, 1), x('semanas que tiene un mes', 'weeks in a month', 'semanas que tem um mês', 'settimane in un mese'), '', '')}${opx('×')}
${fac(m$(fg.v), x('lo que vale una hora', 'what an hour is worth', 'quanto vale uma hora', 'quanto vale un’ora'), fg.supV ? x('supuesto', 'assumption', 'suposto', 'ipotesi') : '', '')}${opx('=')}
${fac(m$(fg.coste_tiempo_mes), alMes, x('coste en tiempo', 'cost in time', 'custo em tempo', 'costo in tempo'), 'res')}</div>
<p class="fm rv" style="--d:5">${F(fg.h)} h × ${F(FUGA_SEM, 1)} = ${Fd(fg.horas_mes)} ${x('horas al mes', 'hours per month', 'horas por mês', 'ore al mese')}; ${Fd(fg.horas_mes)} × ${m$(fg.v)} = ${m$(fg.coste_tiempo_mes)} ${alMes}. <b>${alAnio}: ${m$(fg.coste_tiempo_anio)}.</b>${fg.supH || fg.supV ? ` <i>${x('Estimación nuestra; si me das tu cifra real, la sustituyo.', 'Our estimate; if you give me your real figure, I will replace it.', 'Estimativa nossa; se você me passar o seu número real, eu o substituo.', 'Nostra stima; se mi dai la tua cifra reale, la sostituisco.')}</i>` : ''}</p>`;
  // Comparación honesta: solo aparece si hacerlo a mano cuesta de verdad MÁS que lo que se ofrece (el mensual; si el caso es débil, el piloto).
  const ofrecido = debil ? piloto : mensual;
  const aMano = fg ? fg.coste_tiempo_mes : 0;
  const cuestaMas = !!fg && aMano > ofrecido;
  const vsHtml = !cuestaMas ? '' : `<div class="vs rv" style="--d:6"><div class="vs-a"><small>${x('Hacerlo tú o tu equipo', 'Doing it yourself or with your team', 'Fazer você ou sua equipe', 'Farlo tu o il tuo team')}</small><b>${m$(aMano)}<span>${alMes}</span></b><i>${x('en tiempo, y sin que nadie te asegure reuniones', 'in time, with no one assuring meetings', 'em tempo, sem que ninguém garanta reuniões', 'in tempo, senza che nessuno assicuri incontri')}</i></div>
<div class="vs-x">${x('vs', 'vs', 'vs', 'vs')}</div>
<div class="vs-b"><small>${x('Con', 'With', 'Com', 'Con')} ${esc(marca)}</small><b>${m$(ofrecido)}<span>${debil ? x('piloto, pago único', 'pilot, one-time', 'piloto, pagamento único', 'pilota, pagamento unico') : alMes}</span></b><i>${x(`Hacerlo a mano te cuesta ≈ ${veces(aMano / ofrecido)} más`, `Doing it by hand costs you ≈ ${veces(aMano / ofrecido)} more`, `Fazer à mão custa ≈ ${veces(aMano / ofrecido)} mais`, `Farlo a mano ti costa ≈ ${veces(aMano / ofrecido)} in più`)}</i></div></div>`;
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">02 · ${x('La cuenta', 'The numbers', 'A conta', 'Il conto')}</div>
<h2 class="rv" style="--d:1">${x('Lo que hoy <em>dejas de ganar.</em>', 'What you <em>miss out on</em> today.', 'O que você <em>deixa de ganhar</em> hoje.', 'Quello che oggi <em>non guadagni.</em>')}</h2>
${stripA}
${stripB}
<p class="fm rv" style="--d:7;margin-top:12px;font-size:14px">${x('Los datos marcados «supuesto» son estimaciones nuestras; el resto es lo que tú nos diste. No es una promesa de resultado.', 'Figures marked “assumption” are our estimates; the rest is what you gave us. Not a promise of results.', 'Os dados marcados como «suposto» são estimativas nossas; o resto é o que você nos passou. Não é uma promessa de resultado.', 'I dati contrassegnati «ipotesi» sono nostre stime; il resto è quello che ci hai fornito. Non è una promessa di risultato.')}</p></div></section>`);

  // 4 · recuperarlo: la inversión se recupera, y hacerlo a mano cuesta más
  const ej = [2000, 4000, 8000, 15000].map(val => ({ val, k: build(val, mg, cierre / 100, obj, mensual, piloto, null, real) }));
  const unaVenta = c.ventas_para_cubrir_piloto != null && c.ventas_para_cubrir_piloto <= 1;
  const card3 = (t, v2, sub) => `<div class="r rv" style="--d:3">${t}<b>${v2}</b>${sub ? `<span class="rg">${sub}</span>` : ''}</div>`;
  const vz = n => (hayValor ? veces(n) : '—');
  // Primera venta: nunca como promesa. Con el ciclo del cliente: «hacia el mes N». Sin él: un rango estimado (ciclo de 30 a 60 días) y se marca como estimado.
  const mesDe = dd => Math.ceil(1 + dd / 30);
  const m1 = mesDe(30), m2 = mesDe(60), mReal = d.ciclo_dias ? mesDe(d.ciclo_dias) : null;
  const primeraTxt = mReal != null
    ? x(`Hacia el mes ${mReal}`, `Around month ${mReal}`, `Por volta do mês ${mReal}`, `Verso il mese ${mReal}`)
    : x(`Mes ${m1}–${m2}`, `Month ${m1}–${m2}`, `Mês ${m1}–${m2}`, `Mese ${m1}–${m2}`);
  const primeraSub = x('depende de tu ciclo de venta', 'depends on your sales cycle', 'depende do seu ciclo de vendas', 'dipende dal tuo ciclo di vendita') + (mReal != null ? '' : ' · ' + x('estimado', 'estimate', 'estimativa', 'stima'));
  const cicloVal = d.ciclo_dias ? dias(d.ciclo_dias) : `≈ 30–60 ${x('días', 'days', 'dias', 'giorni')}`;
  const cicloSub = x('marca cuándo llega la primera venta', 'sets when the first sale lands', 'define quando chega a primeira venda', 'determina quando arriva la prima vendita') + (d.ciclo_dias ? '' : ' · ' + x('estimado', 'estimate', 'estimativa', 'stima'));
  S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">03 · ${x('Recuperarlo', 'Payback', 'Recuperar', 'Recuperarlo')}</div>
<h2 class="rv" style="--d:1">${x('Una inversión que <em>se recupera.</em>', 'An investment that <em>pays itself back.</em>', 'Um investimento que <em>se recupera.</em>', 'Un investimento che <em>si recupera.</em>')}</h2>
<p class="fm rv" style="--d:2">${unaVenta && hayValor ? x('Con una sola venta nueva cubres el piloto. ', 'A single new sale covers the pilot. ', 'Uma única venda nova cobre o piloto. ', 'Una sola nuova vendita copre il progetto pilota. ') : ''}${x('Inversión ÷ (reuniones × cierre × valor × margen) = ventas que necesitas para cubrirla.', 'Investment ÷ (meetings × close rate × value × margin) = sales you need to cover it.', 'Investimento ÷ (reuniões × fechamento × valor × margem) = vendas necessárias para cobri-lo.', 'Investimento ÷ (incontri × chiusura × valore × margine) = vendite necessarie per coprirlo.')}</p>
${vsHtml}
<div class="calc c4">
${card3(x('Primera venta posible', 'First sale could land', 'Primeira venda possível', 'Prima vendita possibile'), primeraTxt, primeraSub)}
${card3(x('Ventas para cubrir el piloto', 'Sales to cover the pilot', 'Vendas para cobrir o piloto', 'Vendite per coprire il progetto pilota'), hayValor ? F(c.ventas_para_cubrir_piloto) : '—', '')}
${card3(x(`El piloto se paga ${vz(c.veces_piloto)}`, `The pilot pays for itself ${vz(c.veces_piloto)}`, `O piloto se paga ${vz(c.veces_piloto)}`, `Il progetto pilota si ripaga ${vz(c.veces_piloto)}`), m$(piloto), '')}
${debil ? card3(x('Tu ciclo de venta', 'Your sales cycle', 'Seu ciclo de vendas', 'Il tuo ciclo di vendita'), cicloVal, cicloSub) : card3(x(`El mensual se paga ${vz(c.veces_mensual)}`, `The monthly fee pays for itself ${vz(c.veces_mensual)}`, `A mensalidade se paga ${vz(c.veces_mensual)}`, `Il canone mensile si ripaga ${vz(c.veces_mensual)}`), m$(mensual), '')}</div>
<table class="xt rv" style="--d:5"><tr><th>${x('Ejemplo con supuestos · valor de un cliente nuevo', 'Example with assumptions · value of a new client', 'Exemplo com suposições · valor de um novo cliente', 'Esempio con ipotesi · valore di un nuovo cliente')}</th>${ej.map(e => `<th>${m$(e.val)}</th>`).join('')}</tr>
<tr><td>${x(`Ingreso nuevo al mes (${F(obj, 0)} reuniones, cierre ${F(cierre, 0)} %)`, `New revenue per month (${F(obj, 0)} meetings, ${F(cierre, 0)} % close rate)`, `Nova receita por mês (${F(obj, 0)} reuniões, fechamento de ${F(cierre, 0)} %)`, `Nuovo ricavo al mese (${F(obj, 0)} incontri, chiusura ${F(cierre, 0)} %)`)}</td>${ej.map(e => `<td><b>${m$(e.k.ingreso_mes)}</b></td>`).join('')}</tr>
<tr><td>${x('Veces que cubre el piloto', 'Times it covers the pilot', 'Vezes que cobre o piloto', 'Volte che copre il progetto pilota')}</td>${ej.map(e => `<td><b>${F(e.k.veces_piloto)}</b></td>`).join('')}</tr></table>
<p class="disc rv" style="--d:6">${x('Ejemplo con supuestos, no es una promesa de resultado.', 'Example based on assumptions; not a promise of results.', 'Exemplo com suposições, não é uma promessa de resultado.', 'Esempio basato su ipotesi, non è una promessa di risultato.')}</p></div></section>`);

  // 5 · qué hacemos
  const refs = (Array.isArray(p.referencias) ? p.referencias : []).filter(r => r && r.nombre).slice(0, 3);
  const refTxt = r => esc(r.nombre) + (r.descripcion ? ' · ' + esc(String(r.descripcion).slice(0, 90)) : '');
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1684610529682-553625a1ffed', ovV(.88, .55))}<div class="content"><div class="eyebrow rv">04 · ${x('Qué hacemos', 'What we do', 'O que fazemos', 'Cosa facciamo')}</div>
<h2 class="rv" style="--d:1">${x('Qué hacemos, <em>paso a paso.</em>', 'What we do, <em>step by step.</em>', 'O que fazemos, <em>passo a passo.</em>', 'Cosa facciamo, <em>passo dopo passo.</em>')}</h2>
<div class="tl">
<div class="st rv" style="--d:2"><b class="bn">01</b><small>${wk(1, 2)}</small><h3>${x('Investigamos', 'We research', 'Pesquisamos', 'Analizziamo')}</h3><p>${x('Averiguamos cuántas empresas hay, a cuáles llegamos y quién decide en cada una, antes de escribir a nadie.', 'We find out how many companies there are, which ones we can reach and who decides at each, before writing to anyone.', 'Descobrimos quantas empresas existem, a quais chegamos e quem decide em cada uma, antes de escrever a alguém.', 'Verifichiamo quante aziende ci sono, quali raggiungiamo e chi decide in ciascuna, prima di scrivere a qualcuno.')}</p></div>
<div class="st rv" style="--d:3"><b class="bn">02</b><small>${wk(2, 3)}</small><h3>${x('Empezamos a contactar', 'We start reaching out', 'Começamos a entrar em contato', 'Iniziamo a contattare')}</h3><p>${x('Les escribimos por LinkedIn y correo, hablándoles de lo que de verdad les importa.', 'We write to them on LinkedIn and by email, talking about what really matters to them.', 'Escrevemos por LinkedIn e e-mail, falando do que realmente importa para eles.', 'Scriviamo su LinkedIn e via email, parlando di ciò che a loro interessa davvero.')}</p></div>
<div class="st rv" style="--d:4"><b class="bn">03</b><small>${wkFrom(4)}</small><h3>${x('Mejoramos cada mes', 'We improve every month', 'Melhoramos a cada mês', 'Miglioriamo ogni mese')}</h3><p>${x('Vemos qué respuestas llegan y mejoramos los mensajes y las empresas a las que escribimos.', 'We look at which replies come in and improve the messages and the companies we write to.', 'Vemos quais respostas chegam e melhoramos as mensagens e as empresas para as quais escrevemos.', 'Vediamo quali risposte arrivano e miglioriamo i messaggi e le aziende a cui scriviamo.')}</p></div></div>
<div class="chips rv" style="--d:5"><span class="chip">LinkedIn</span><span class="chip">${x('Correo electrónico', 'Email', 'E-mail', 'Email')}</span><span class="chip">${x('Seguimiento automático', 'Automatic follow-up', 'Acompanhamento automático', 'Follow-up automatico')}</span>${d.incluir_whatsapp ? '<span class="chip">WhatsApp</span>' : ''}</div>
${refs.length ? `<p class="cap rv" style="--d:6;margin-top:22px;font-size:13px">${x('Ya lo hicimos para:', 'We have already done this for:', 'Já fizemos isso para:', 'Lo abbiamo già fatto per:')} ${refs.map(refTxt).join(' · ')}${d.resultados_referencia ? ' — ' + esc(d.resultados_referencia) : ''}</p>` : ''}</div></section>`);

  // 6 · tu portal en vivo
  const ilus = x('ilustrativo', 'illustrative', 'ilustrativo', 'illustrativo');
  const kp = (l, val, dsc) => `<div><small>${l}</small><b data-count="${val}">${val}</b><i>${dsc}</i></div>`;
  const rowp = (a, b2, c2) => `<div class="rowp"><b>${a}</b><span class="tg">${b2}</span><span>${c2}</span></div>`;
  const ex = l => `${x('Empresa ejemplo', 'Sample company', 'Empresa exemplo', 'Azienda esempio')} ${l}`;
  const sig = t => `${x('Siguiente paso: ', 'Next step: ', 'Próximo passo: ', 'Prossimo passo: ')}${t}`;
  const paso = n => x(`Mensajes en curso · paso ${n} de 5`, `Messages in progress · step ${n} of 5`, `Mensagens em andamento · passo ${n} de 5`, `Messaggi in corso · passo ${n} di 5`);
  S.push(`<section class="slide s-dark" data-th="dark">${bgDark}<div class="content"><div class="eyebrow rv">05 · ${x('Seguimiento', 'Tracking', 'Acompanhamento', 'Monitoraggio')}</div>
<h2 class="rv" style="--d:1">${x('Tu operación, <em>visible en vivo.</em>', 'Your campaign, <em>visible live.</em>', 'Sua operação, <em>visível ao vivo.</em>', 'La tua operazione, <em>visibile in diretta.</em>')}</h2>
<div class="portal rv" style="--d:2"><div class="tb"><span>${esc(marca)} · ${x('Portal de seguimiento', 'Tracking portal', 'Portal de acompanhamento', 'Portale di monitoraggio')} · ${esc(empresa)}</span><span class="lv">${x('Ejemplo ilustrativo', 'Illustrative example', 'Exemplo ilustrativo', 'Esempio illustrativo')}</span></div>
<div class="tabs"><button class="tab on" data-t="a">${x('Resumen', 'Summary', 'Resumo', 'Riepilogo')}</button><button class="tab" data-t="b">${x('Oportunidades', 'Opportunities', 'Oportunidades', 'Opportunità')}</button><button class="tab" data-t="c">${x('Empresas', 'Companies', 'Empresas', 'Aziende')}</button></div>
<div class="pane on" data-p="a"><div class="kp">${kp(x('Contactos alcanzados', 'Contacts reached', 'Contatos alcançados', 'Contatti raggiunti'), 240, ilus)}${kp(x('Respuestas', 'Replies', 'Respostas', 'Risposte'), 6, '≈ ' + F(2.5) + ' % · ' + ilus)}${kp(x('Reuniones', 'Meetings', 'Reuniões', 'Incontri'), 1, ilus)}${kp(x('Toques de contacto', 'Touchpoints', 'Pontos de contato', 'Punti di contatto'), 510, ilus)}</div>
<svg class="trend" viewBox="0 0 640 84" preserveAspectRatio="none" width="100%" height="84"><g stroke="#E5E9F0" stroke-width="1"><line x1="0" y1="14" x2="640" y2="14"/><line x1="0" y1="42" x2="640" y2="42"/><line x1="0" y1="70" x2="640" y2="70"/></g><path d="M0 70 C40 66 60 48 100 52 S160 26 210 34 S270 56 320 38 S390 12 440 22 S520 44 560 20 S610 14 640 10" fill="none" stroke="${prim}" stroke-width="2.4"/></svg></div>
<div class="pane" data-p="b"><div class="rows">${rowp(ex('A'), x('Reunión pedida', 'Meeting requested', 'Reunião solicitada', 'Incontro richiesto'), sig(x('confirmar horario', 'confirm the time', 'confirmar horário', 'confermare l\'orario')))}${rowp(ex('B'), x('Interesado', 'Interested', 'Interessado', 'Interessato'), sig(x('enviar información', 'send information', 'enviar informações', 'inviare informazioni')))}${rowp(ex('C'), x('En conversación', 'In conversation', 'Em conversa', 'In conversazione'), sig(x('responder una duda', 'answer a question', 'responder a uma dúvida', 'rispondere a un dubbio')))}</div></div>
<div class="pane" data-p="c"><div class="rows">${rowp(ex('A'), x('Decisor identificado', 'Decision-maker identified', 'Decisor identificado', 'Decisore individuato'), paso(3))}${rowp(ex('B'), x('Contactado', 'Contacted', 'Contatado', 'Contattato'), paso(2))}${rowp(ex('C'), x('Respondió', 'Replied', 'Respondeu', 'Ha risposto'), x('Mensajes detenidos a la espera de ti', 'Messages paused, waiting for you', 'Mensagens pausadas, aguardando você', 'Messaggi in pausa, in attesa di te'))}</div></div></div>
<p class="cap rv" style="--d:3">${x('Vista ilustrativa con datos de ejemplo: no es lo que se espera de tu campaña. Tendrás acceso desde la semana 1.', 'Illustrative view with sample data: not what is expected from your campaign. You will have access from week 1.', 'Visão ilustrativa com dados de exemplo: não é o que se espera da sua campanha. Você terá acesso desde a semana 1.', 'Vista illustrativa con dati di esempio: non è ciò che ci si aspetta dalla tua campagna. Avrai accesso dalla settimana 1.')}</p></div></section>`);

  // 7 · qué incluye y qué no
  const wa = !!d.incluir_whatsapp;
  const inc = [
    x('Un solo producto o servicio para empujar', 'A single product or service to push', 'Um único produto ou serviço para promover', 'Un solo prodotto o servizio da promuovere'),
    x('Un tipo de cliente y un mercado para empezar', 'One type of client and one market to start', 'Um tipo de cliente e um mercado para começar', 'Un tipo di cliente e un mercato per iniziare'),
    x('Hasta dos cargos de decisión por empresa', 'Up to two decision-maker roles per company', 'Até dois cargos de decisão por empresa', 'Fino a due ruoli decisionali per azienda'),
    wa ? x('LinkedIn, correo y WhatsApp', 'LinkedIn, email and WhatsApp', 'LinkedIn, e-mail e WhatsApp', 'LinkedIn, email e WhatsApp') : x('LinkedIn y correo electrónico', 'LinkedIn and email', 'LinkedIn e e-mail', 'LinkedIn ed email'),
    x('Investigación, mensajes y seguimiento de las respuestas', 'Research, messages and follow-up of replies', 'Pesquisa, mensagens e acompanhamento das respostas', 'Ricerca, messaggi e follow-up delle risposte'),
    x('Reuniones cualificadas con quien decide, medidas y reportadas cada mes', 'Qualified meetings with the decision-maker, measured and reported every month', 'Reuniões qualificadas com quem decide, medidas e reportadas a cada mês', 'Incontri qualificati con chi decide, misurati e riportati ogni mese'),
    x('Informe mensual y acceso al portal en vivo', 'Monthly report and live portal access', 'Relatório mensal e acesso ao portal ao vivo', 'Report mensile e accesso al portale in tempo reale')];
  const exc = [
    x('Varios productos, mercados o tipos de cliente a la vez', 'Several products, markets or client types at once', 'Vários produtos, mercados ou tipos de cliente ao mesmo tempo', 'Più prodotti, mercati o tipi di cliente contemporaneamente'),
    x('Publicidad pagada o redes sociales', 'Paid advertising or social media', 'Publicidade paga ou redes sociais', 'Pubblicità a pagamento o social media'),
    x('Atender las reuniones, mandar presupuestos o cerrar la venta', 'Attending the meetings, sending quotes or closing the sale', 'Atender as reuniões, enviar orçamentos ou fechar a venda', 'Gestire gli incontri, inviare preventivi o chiudere la vendita'),
    x('Gestión después de la venta', 'Post-sale management', 'Gestão após a venda', 'Gestione post-vendita'),
    wa ? x('Licencias, dominios o buzones específicos del cliente', 'Licenses, domains or mailboxes specific to the client', 'Licenças, domínios ou caixas de e-mail específicos do cliente', 'Licenze, domini o caselle specifiche del cliente') : x('WhatsApp (se puede añadir si lo necesitas)', 'WhatsApp (can be added if you need it)', 'WhatsApp (pode ser adicionado se você precisar)', 'WhatsApp (si può aggiungere se serve)'),
    x('Garantía de respuestas, reuniones o ventas', 'Guarantee of replies, meetings or sales', 'Garantia de respostas, reuniões ou vendas', 'Garanzia di risposte, incontri o vendite')];
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">06 · ${x('Alcance', 'Scope', 'Escopo', 'Ambito')}</div>
<h2 class="rv" style="--d:1">${x('Qué incluye y <em>qué no.</em>', 'What is included and <em>what is not.</em>', 'O que inclui e <em>o que não.</em>', 'Cosa include e <em>cosa no.</em>')}</h2>
<div class="terms"><div class="in rv" style="--d:2"><h3>${x('Incluye', 'Included', 'Inclui', 'Incluso')}</h3><ul>${li_(inc.map(esc))}</ul></div><div class="ex rv" style="--d:3"><h3>${x('No incluye', 'Not included', 'Não inclui', 'Non incluso')}</h3><ul>${li_(exc.map(esc))}</ul></div></div>
<p class="disc rv" style="--d:4"><b>${x('No garantizamos respuestas, reuniones ni ventas; el cliente lleva las reuniones, propuestas y cierre.', 'We do not guarantee replies, meetings or sales; the client handles the meetings, proposals and closing.', 'Não garantimos respostas, reuniões nem vendas; o cliente conduz as reuniões, propostas e o fechamento.', 'Non garantiamo risposte, incontri né vendite; il cliente gestisce gli incontri, le proposte e la chiusura.')}</b></p></div></section>`);

  // 8 · quién hace qué
  const tu = [
    x('Nos cuentas qué ofreces y apruebas el primer enfoque.', 'You tell us what you offer and approve the first approach.', 'Você nos conta o que oferece e aprova a primeira abordagem.', 'Ci racconti cosa offri e approvi il primo approccio.'),
    x('Nos das los accesos que haga falta.', 'You give us the access we need.', 'Você nos dá os acessos necessários.', 'Ci dai gli accessi necessari.'),
    x('Respondes a las reuniones en menos de 48 horas.', 'You reply to meeting requests within 48 hours.', 'Você responde às reuniões em menos de 48 horas.', 'Rispondi agli incontri entro 48 ore.'),
    x('Llevas las reuniones, las propuestas y el cierre.', 'You handle the meetings, proposals and closing.', 'Você conduz as reuniões, as propostas e o fechamento.', 'Gestisci gli incontri, le proposte e la chiusura.'),
    x('Nos cuentas cómo fueron las conversaciones.', 'You tell us how the conversations went.', 'Você nos conta como foram as conversas.', 'Ci racconti come sono andate le conversazioni.')];
  S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">07 · ${x('Responsabilidades', 'Responsibilities', 'Responsabilidades', 'Responsabilità')}</div>
<h2 class="rv" style="--d:1">${x('Quién hace <em>qué.</em>', 'Who does <em>what.</em>', 'Quem faz <em>o quê.</em>', 'Chi fa <em>cosa.</em>')}</h2>
<div class="two"><div class="rp dk rv" style="--d:2"><div class="k">${x('Nosotros', 'We', 'Nós', 'Noi')} (${esc(marca)})</div><p>${x('Investigamos, escribimos los mensajes, contactamos por los canales acordados, damos seguimiento a las respuestas, te pasamos las reuniones cualificadas y te enviamos un informe cada mes. Mejoramos todo con lo que vamos viendo.', 'We research, write the messages, reach out through the agreed channels, follow up on replies, hand you the qualified meetings and send you a report every month. We improve everything based on what we see.', 'Pesquisamos, escrevemos as mensagens, entramos em contato pelos canais combinados, acompanhamos as respostas, passamos a você as reuniões qualificadas e enviamos um relatório a cada mês. Melhoramos tudo com o que vamos vendo.', 'Analizziamo, scriviamo i messaggi, contattiamo tramite i canali concordati, seguiamo le risposte, ti passiamo gli incontri qualificati e ti inviamo un report ogni mese. Miglioriamo tutto in base a ciò che osserviamo.')}</p></div>
<div class="rp lt rv" style="--d:3"><div class="k">${x('Tú', 'You', 'Você', 'Tu')} (${esc(empresa)})</div><ul>${li_(tu)}</ul></div></div></div></section>`);

  // 9 · inversión
  const sim = `<div class="sim rv" style="--d:2"><div class="k">${pilotLbl}</div><div class="tot">${esc(m$(piloto))}<small>${x('pago único', 'one-time payment', 'pagamento único', 'pagamento unico')}</small></div><div class="eq">${x(`Unos 450 contactos · objetivo: ${F(obj, 0)} reuniones cualificadas.<br>Si no llegamos a 2, repetimos el piloto sin coste.`, `About 450 contacts · goal: ${F(obj, 0)} qualified meetings.<br>If we do not reach 2, we repeat the pilot at no cost.`, `Cerca de 450 contatos · meta: ${F(obj, 0)} reuniões qualificadas.<br>Se não chegarmos a 2, repetimos o piloto sem custo.`, `Circa 450 contatti · obiettivo: ${F(obj, 0)} incontri qualificati.<br>Se non arriviamo a 2, ripetiamo il progetto pilota senza costi.`)}</div></div>`;
  const facts = debil
    ? `<div class="facts"><div class="rv" style="--d:3"><small>${x('Después del piloto', 'After the pilot', 'Depois do piloto', 'Dopo il progetto pilota')}</small><b style="font-size:21px">${x('Lo decidimos juntos', 'We decide together', 'Decidimos juntos', 'Decidiamo insieme')}</b><p>${x('Con los resultados a la vista.', 'With the results in front of us.', 'Com os resultados à vista.', 'Con i risultati sotto gli occhi.')}</p></div></div>`
    : `<div class="facts"><div class="rv" style="--d:3"><small>${x('Mensual', 'Monthly', 'Mensal', 'Mensile')}</small><b>${esc(m$(mensual))}${perMes}</b><p>${x('Desde el mes 2, sin permanencia.', 'From month 2, no lock-in.', 'A partir do mês 2, sem fidelidade.', 'Dal mese 2, senza vincoli.')}</p></div>
<div class="rv" style="--d:4"><small>Bonus</small><b>${esc(m$(d.bonus_reunion == null ? 100 : d.bonus_reunion))} ${x('por reunión', 'per meeting', 'por reunião', 'per incontro')}</b><p>${(() => { const u = F(d.umbral_bonus == null ? 3 : d.umbral_bonus, 0); return x(`Por cada reunión cualificada por encima de ${u}. Sin otra comisión.`, `For each qualified meeting above ${u}. No other commission.`, `Por cada reunião qualificada acima de ${u}. Sem outra comissão.`, `Per ogni incontro qualificato oltre ${u}. Nessun'altra commissione.`); })()}</p></div></div>`;
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1500632907344-a073709b2448', ovV(.92, .8))}<div class="content"><div class="eyebrow rv">08 · ${x('Inversión', 'Investment', 'Investimento', 'Investimento')}</div>
<h2 class="rv" style="--d:1">${x('Una inversión <em>clara.</em>', 'A <em>clear</em> investment.', 'Um investimento <em>claro.</em>', 'Un investimento <em>chiaro.</em>')}</h2>
<div class="inv">${sim}${facts}</div></div></section>`);

  // 10 · próximo paso
  const subj = x('Confirmo el piloto de 30 días', 'I confirm the 30-day pilot', 'Confirmo o piloto de 30 dias', 'Confermo il progetto pilota di 30 giorni');
  const body = x('Hola,\n\nConfirmo el piloto de 30 días.\n\nPor favor indíquenme los siguientes pasos.\n\nSaludos,\n', 'Hello,\n\nI confirm the 30-day pilot.\n\nPlease let me know the next steps.\n\nBest regards,\n', 'Olá,\n\nConfirmo o piloto de 30 dias.\n\nPor favor, indiquem-me os próximos passos.\n\nAtenciosamente,\n', 'Buongiorno,\n\nConfermo il progetto pilota di 30 giorni.\n\nVi prego di indicarmi i prossimi passi.\n\nCordiali saluti,\n') + contacto + (p.correo ? '\n' + p.correo : '');
  const mailto = mail ? `mailto:${encodeURIComponent(mail).replace(/%40/g, '@')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}` : '#';
  const payInfo = [b.pago_email || mail, b.pago_telefono].filter(Boolean).join(' · ');
  const decideP = d.decision_quien ? ' (' + x('decide ', 'decided by ', 'decide ', 'decide ') + esc(d.decision_quien) + (d.decision_plazo ? ', ' + esc(d.decision_plazo) : '') + ')' : '';
  S.push(`<section class="slide close s-dark" data-th="dark">${bgFoto('1521791136064-7986c2920216', ovL(.94, .62))}<div class="content">
<div><div class="eyebrow rv">${x('Próximo paso con', 'Next step with', 'Próximo passo com', 'Prossimo passo con')} ${esc(marca)}</div>
<h2 class="rv" style="--d:1">${x('Confirmemos el <em>piloto.</em>', 'Let us confirm the <em>pilot.</em>', 'Vamos confirmar o <em>piloto.</em>', 'Confermiamo il <em>progetto pilota.</em>')}</h2>
<p class="lead rv" style="--d:2">${x('Una sola cosa: confirma que arrancamos. Esta propuesta es válida hasta el ', 'Just one thing: confirm that we start. This proposal is valid until ', 'Apenas uma coisa: confirme que começamos. Esta proposta é válida até ', 'Una sola cosa: conferma che partiamo. Questa proposta è valida fino al ')}${esc(fechaLarga(sumDays(fecha, validez), lang))}.</p>
<a class="cta rv" style="--d:3" target="_blank" rel="noopener noreferrer" href="${esc(mailto)}">${x('Confirmar el piloto', 'Confirm the pilot', 'Confirmar o piloto', 'Confermare il progetto pilota')} <span>↗</span></a></div>
<div class="steps"><div class="rv" style="--d:3"><i>01</i><span>${x('Confirmas el piloto', 'You confirm the pilot', 'Você confirma o piloto', 'Confermi il progetto pilota')}${decideP}.</span></div>
<div class="rv" style="--d:4"><i>02</i><span>${x('Pago del piloto: ', 'Pilot payment: ', 'Pagamento do piloto: ', 'Pagamento del progetto pilota: ')}${esc(m$(piloto))}.${payInfo ? ' ' + x('Datos de pago: ', 'Payment details: ', 'Dados de pagamento: ', 'Dati di pagamento: ') + esc(payInfo) + '.' : ''}</span></div>
<div class="rv" style="--d:5"><i>03</i><span>${x('Fecha de inicio: ', 'Start date: ', 'Data de início: ', 'Data di inizio: ')}${p.inicio ? esc(p.inicio) : x('la acordamos al confirmar', 'we agree on it when you confirm', 'combinamos ao confirmar', 'la concordiamo alla conferma')}.</span></div></div></div>
<div class="foot"><span>${esc(marca)}${mail ? ' · ' + esc(mail) : ''}${web ? ' · ' + esc(web) : ''}</span><span>${x('Confidencial · preparada para ', 'Confidential · prepared for ', 'Confidencial · preparada para ', 'Riservato · preparata per ')}${esc(empresa)}</span></div></section>`);

  const total = S.length;
  const dots = S.map((_, i) => `<button class="dot" aria-label="${i + 1}"></button>`).join('');
  const rootVars = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--tl-rgb:${rgb(light)};--pr-rgb:${rgb(prim)};--dk-rgb:${rgb(dark)};--sans:'Inter','Segoe UI',system-ui,sans-serif}`;
  const title = archivo(b, p, lang);
  return `<!DOCTYPE html>\n<html lang="${lang}" data-deck="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
${d.diseno_anterior ? '' : '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;800&family=Manrope:wght@400;600;800&display=swap" rel="stylesheet">'}
<style>${rootVars}${base.CSS}${EXTRA}${d.diseno_anterior ? '' : SUIZO}</style></head><body>
<div class="hint">${x('Gira el teléfono para ver mejor la presentación', 'Rotate your phone for a better view', 'Gire o telefone para ver melhor a apresentação', 'Ruota il telefono per vedere meglio la presentazione')}</div>
<div class="deck" id="deck" data-th="dark" data-tt="dark"><div class="stage" id="stage">
<div class="bar" id="bar"></div>
<div class="top"><div class="brand"><span class="bw">${brandW}</span><span class="bc">${brandC}</span></div><div class="r"><span class="cnt"><b id="cur">01</b> <i>/ ${pn(total)}</i></span><button class="btn-fs" id="fs" type="button">⛶ ${x('Presentar', 'Present', 'Apresentar', 'Presenta')}</button></div></div>
${S.map((sec, i) => (i === 0 || !d.estilo_sobrio ? sec : sec.replace(/class="slide( close)? s-dark"/, 'class="slide$1 s-light"').replace(/data-th="dark"/, 'data-th="light"').replace(/<div class="bgph"[^>]*><\/div>/g, '').replace(/<div class="bg">(?:<div class="[^"]*"><\/div>)+<\/div>/g, ''))).join('\n')}
<button class="arr l" id="prev" aria-label="←">‹</button><button class="arr r" id="next" aria-label="→">›</button>
<div class="nav">${dots}</div>
</div></div>
<script>${base.JS}</script></body></html>`;
}

// «Propuesta NovaCentrax – Empresa – 2026-11-07»: nombre del PDF (el navegador lo toma del título del documento)
function archivo(brand, p, lang) {
  const d = (p && p.dev) || {};
  const w = lang === 'en' ? 'Proposal' : (lang === 'pt' || lang === 'it') ? 'Proposta' : 'Propuesta';
  return `${w} ${(brand && brand.nombre) || 'NovaCentrax'} – ${(p && p.empresa) || (lang === 'en' ? 'Client' : 'Cliente')} – ${d.fecha_propuesta || today()}`;
}

module.exports = { render, cleanDev, calc, fuga, validate, archivo, REQ, LANGS };
