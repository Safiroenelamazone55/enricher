'use strict';
// «Propuesta comercial development v2»: plantilla con CAMPOS que se rellenan por cliente. Máximo 10 diapositivas, en español sencillo,
// con los cálculos del caso de negocio y las reglas de validación. Mismo diseño que la presentación interactiva (se reutiliza su CSS/JS).
const base = require('./presentationTemplate');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const pn = n => String(n).padStart(2, '0');
const Sx = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// ── números: formato español (3.000 · 0,6) ──
function fmt(n, dec) {
  if (n == null || !isFinite(n)) return '—';
  const d = dec == null ? (Math.abs(n - Math.round(n)) < 1e-9 ? 0 : (Math.abs(n) < 10 ? 1 : 0)) : dec;
  const neg = n < 0; let s = Math.abs(n).toFixed(d); let [i, f] = s.split('.');
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + i + (f ? ',' + f : '');
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
  o.cierre_sin_dato = d.cierre_sin_dato === true || d.cierre_sin_dato === 'true';
  o.incluir_whatsapp = d.incluir_whatsapp === true || d.incluir_whatsapp === 'true';
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

// ── reglas de validación ──
const REQ = [['cliente_nombre', 'Nombre del cliente', p => p.contacto], ['cliente_empresa', 'Empresa del cliente', p => p.empresa], ['cliente_cargo', 'Cargo del cliente', p => p.clienteCargo],
  ['fecha_propuesta', 'Fecha de la propuesta', (p, d) => d.fecha_propuesta], ['validez_dias', 'Validez (días)', (p, d) => d.validez_dias],
  ['oferta_cliente', 'Qué vende el cliente', (p, d) => d.oferta_cliente], ['cliente_ideal', 'A quién quiere venderle', (p, d) => d.cliente_ideal],
  ['valor_cliente', 'Valor de un cliente nuevo (primer año)', (p, d) => (d.valor_cliente ? 'x' : '')],
  ['cierre_pct', 'De cada 10 reuniones, cuántas cierran', (p, d) => (d.cierre_sin_dato || d.cierre_pct != null ? 'x' : '')],
  ['moneda', 'Moneda', p => p.moneda]];
function validate(p) {
  const d = (p && p.dev) || cleanDev({}), faltan = [], avisos = [];
  for (const [k, l, get] of REQ) if (!String(get(p || {}, d) || '').trim()) faltan.push({ k, l });
  const c = calc(p), valor = d.valor_cliente || 0;
  if (!d.ciclo_dias) avisos.push({ nivel: 'amarillo', k: 'sin_ciclo', txt: 'Sin dato previo: no pusiste los días que tarda en firmar. Las diapositivas 2 y 4 dirán «sin dato previo» y no se calcula el mes de la primera venta.' });
  if (d.reuniones_mes_hoy == null) avisos.push({ nivel: 'amarillo', k: 'sin_reuniones', txt: 'Sin dato previo: no pusiste cuántas reuniones nuevas al mes tiene hoy. La diapositiva 2 dirá «sin dato previo». Los cálculos no cambian: usan la meta de 3 reuniones.' });
  const debil = !!valor && c.veces_mensual < 3;
  if (debil) avisos.push({ nivel: 'rojo', k: 'debil', txt: 'Caso débil: no ofrezcas el mensual. Con estos números el ingreso mensual no llega a 3 veces su precio; la propuesta queda solo con el piloto.' });
  if (d.valor_cliente != null && valor > 0 && valor < 2000) avisos.push({ nivel: 'rojo', k: 'valor', txt: 'No encaja con la oferta: un cliente nuevo vale menos de 2.000.' });
  const textos = [p.empresa, p.contacto, p.clienteCargo, p.correo, d.oferta_cliente, d.cliente_ideal, d.dolor_cliente, d.decision_quien, d.decision_plazo, d.resultados_referencia, p.inicio].filter(Boolean).join(' ');
  const cor = textos.match(/\[[^\]]{1,80}\]/g) || [];
  if (cor.length) avisos.push({ nivel: 'amarillo', k: 'corchetes', txt: 'Hay un texto entre [corchetes] sin rellenar: ' + cor.slice(0, 3).join(' ') });
  return { faltan, avisos, debil, c };
}

const fechaLarga = iso => { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return ''; const M = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']; return `${+m[3]} de ${M[+m[2] - 1]} de ${m[1]}`; };
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
`;

function render(brand, p, lang) {
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'Mi empresa';
  const web = (b.web || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const mail = b.email || '';
  const d = p.dev || cleanDev({});
  const v = validate(p), c = v.c, debil = v.debil;
  const empresa = p.empresa || 'Cliente', contacto = p.contacto || '', cargo = p.clienteCargo || '';
  const sym = p.moneda || 'US$';
  const m$ = n => sym + fmt(n, 0);
  const fecha = d.fecha_propuesta || today();
  const validez = d.validez_dias || 10;
  const clLogo = p.logoCliente && typeof p.logoCliente === 'object' && imgOk(p.logoCliente[p.logoCliente.usar]) ? p.logoCliente[p.logoCliente.usar] : '';
  const fotos = p.fotos !== false;
  const foto = imgOk(p.fotoPortada) ? p.fotoPortada : '';
  const obj = d.reuniones_objetivo || 3, piloto = d.precio_piloto || 500, mensual = d.precio_mensual || 750;
  const real = c.cierre_real, cierre = c.cierre_usado;
  const de10 = fmt(cierre / 10, cierre % 10 ? 1 : 0);

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
  const sup = rango => `<span class="sup">supuesto · ${rango}</span>`;
  const li_ = a => a.map(t => `<li>${t}</li>`).join('');
  const S = [];

  // 1 · portada
  const year = fecha.slice(0, 4);
  const edPhoto = foto || (fotos ? U('1486406146926-c627a92ad1ab') : '');
  const artSvg = `<svg viewBox="0 0 400 520" fill="none"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${prim}"/></linearGradient></defs><g stroke="url(#g1)" stroke-width="1.4" opacity=".7"><path d="M60 120 L190 70 L330 140 L270 260 L120 240 Z"/><path d="M190 70 L270 260"/><path d="M60 120 L270 260"/><path d="M330 140 L120 240"/><path d="M120 240 L180 400 L300 360 L270 260"/></g><g fill="url(#g1)"><circle cx="60" cy="120" r="9"/><circle cx="190" cy="70" r="12"/><circle cx="330" cy="140" r="9"/><circle cx="270" cy="260" r="14"/><circle cx="120" cy="240" r="10"/><circle cx="180" cy="400" r="12"/><circle cx="300" cy="360" r="9"/></g></svg>`;
  const edPh = (n, h, w) => `<li><i>${n}</i><b>${h}</b><span>${w}</span></li>`;
  const precios = debil ? `Piloto de 30 días: ${m$(piloto)}` : `Piloto de 30 días: ${m$(piloto)} · Después, ${m$(mensual)}/mes`;
  const empLen = empresa.length;
  S.push(`<section class="slide cover ed s-light" data-th="light" data-tt="light" data-cv="1"><div class="edph">${edPhoto ? `<i style="background-image:url('${edPhoto}')"></i>` : `<div class="edsvg">${artSvg}</div>`}<ul class="edl">${edPh('01', 'Investigamos', 'Semanas 1–2')}${edPh('02', 'Contactamos', 'Semanas 2–3')}${edPh('03', 'Mejoramos', 'Desde la semana 4')}</ul><span class="edv">${esc(marca)} · Propuesta comercial · ${esc(year)}</span></div><div class="content">
<div class="edt rv" style="--d:0"><span>${esc(fechaLarga(fecha))}</span><span>Propuesta para ${esc(empresa)}</span><span>Válida ${validez} días</span></div>
<div class="edm"><h1 class="rv${empLen > 14 ? ' long' : ''}" style="--d:1">Propuesta para <em>${esc(empresa)}</em></h1>
<p class="sub rv" style="--d:2">${esc(precios)}</p></div>
<div class="edb rv" style="--d:4"><div><small>Para</small><b>${clLogo ? `<img class="cl-${esc(p.logoCliente.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : esc(contacto || '—')}<span>${esc([contacto && clLogo ? contacto : '', cargo].filter(Boolean).join(', ') || (clLogo ? '' : cargo))}</span></b></div>
<div><small>Piloto de 30 días</small><b>${m$(piloto)}<span>Pago único</span></b></div>
<div><small>${debil ? 'Válida' : 'Después'}</small><b>${debil ? validez + ' días' : m$(mensual) + '/mes'}<span>${debil ? 'desde la fecha de envío' : 'Válida ' + validez + ' días'}</span></b></div></div>
</div></section>`);

  // 2 · lo que me contaste
  S.push(`<section class="slide s-soft${fotos ? ' hasband' : ''}" data-th="light" data-tt="${ttAttr}">${hero('1551288049-bebda4e38f71', '01')}<div class="content"><div class="bh"><div class="eyebrow rv">01 · Lo que hablamos</div>
<h2 class="rv" style="--d:1">Lo que me <em>contaste.</em></h2></div>
<div class="cf">
<div class="card rv" style="--d:1"><div class="n">01</div><h3>Qué vendes</h3><p>${esc(d.oferta_cliente) || '—'}</p></div>
<div class="card rv" style="--d:2"><div class="n">02</div><h3>A quién quieres venderle</h3><p>${esc(d.cliente_ideal) || '—'}</p></div>
<div class="card rv" style="--d:3"><div class="n">03</div><h3>Dónde estás hoy</h3><p>${d.reuniones_mes_hoy == null ? 'Reuniones nuevas al mes: sin dato previo' : 'Consigues ' + fmt(d.reuniones_mes_hoy, 0) + ' reuniones nuevas al mes'}${d.cierre_sin_dato || d.cierre_pct == null ? '' : '; de cada 10 cierran ' + de10}.</p></div>
<div class="card rv" style="--d:4"><div class="n">04</div><h3>Lo que vale cerrar</h3><p>Un cliente nuevo te deja ${d.valor_cliente ? m$(d.valor_cliente) : '—'} el primer año y ${d.ciclo_dias ? 'tardas ' + d.ciclo_dias + ' días en firmar' : 'el tiempo hasta firmar: sin dato previo'}${d.decision_quien || d.decision_plazo ? '. Decide ' + esc([d.decision_quien, d.decision_plazo ? 'en ' + d.decision_plazo : ''].filter(Boolean).join(' ')) : ''}.</p></div></div>
${d.dolor_cliente ? `<div class="quote rv" style="--d:5">«${esc(String(d.dolor_cliente).replace(/^["«»“”]+|["«»“”]+$/g, ''))}»</div>` : ''}</div></section>`);

  // 3 · cuánto vale para ti
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">02 · La cuenta</div>
<h2 class="rv" style="--d:1">Cuánto <em>vale</em> para ti.</h2>
<div class="calc">
<div class="r rv" style="--d:2">Reuniones nuevas al mes con nosotros${sup('rango 2–5')}<b>${fmt(obj, 0)}</b></div>
<div class="r rv" style="--d:2">De cada 10 reuniones, cierran${real ? '' : sup('rango 10–30 %')}<b>${de10}</b></div>
<div class="r rv" style="--d:3">Ventas nuevas al mes<b>${fmt(c.ventas_mes)}</b></div>
<div class="r rv" style="--d:3">Lo que vale un cliente nuevo${(d.margen_pct || 100) < 100 ? ' (con tu margen del ' + fmt(d.margen_pct, 0) + ' %)' : ''}<b>${d.valor_cliente ? m$(d.valor_cliente * (d.margen_pct || 100) / 100) : '—'}</b></div>
<div class="r big rv" style="--d:4"><span>Ingreso nuevo cada mes</span><b>${m$(c.ingreso_mes)}</b></div>
${debil ? '' : `<div class="r big rv" style="--d:5"><span>Eso equivale a lo que cuesta el mensual</span><b>${fmt(c.veces_mensual)} veces</b></div>`}</div>
<p class="fm rv" style="--d:6">Los datos marcados «supuesto» son estimaciones nuestras; el resto es lo que tú nos diste.</p></div></section>`);

  // 4 · cuánto tardas en recuperarlo
  const ej = [2000, 4000, 8000, 15000].map(val => ({ val, k: build(val, (d.margen_pct || 100) / 100, cierre / 100, obj, mensual, piloto, null, real) }));
  S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">03 · Recuperarlo</div>
<h2 class="rv" style="--d:1">Cuánto tardas en <em>recuperarlo.</em></h2>
<p class="fm rv" style="--d:2">Inversión ÷ (reuniones × cierre × valor × margen) = ventas que necesitas para cubrirla.</p>
<div class="calc">
<div class="r rv" style="--d:2">Primera venta esperada<b>${c.mes_primera_venta == null ? 'sin dato previo' : 'Mes ' + c.mes_primera_venta}</b></div>
<div class="r rv" style="--d:3">Ventas para cubrir el piloto<b>${fmt(c.ventas_para_cubrir_piloto)}</b></div>
<div class="r rv" style="--d:3">El piloto se paga ${fmt(c.veces_piloto)} veces<b>${m$(piloto)}</b></div>
${debil ? `<div class="r rv" style="--d:4">Tiempo medio hasta firmar<b>${d.ciclo_dias ? d.ciclo_dias + ' días' : '—'}</b></div>` : `<div class="r rv" style="--d:4">El mensual se paga ${fmt(c.veces_mensual)} veces<b>${m$(mensual)}</b></div>`}</div>
<table class="xt rv" style="--d:5"><tr><th>Ejemplo con supuestos · valor de un cliente nuevo</th>${ej.map(e => `<th>${m$(e.val)}</th>`).join('')}</tr>
<tr><td>Ingreso nuevo al mes (${fmt(obj, 0)} reuniones, cierre ${fmt(cierre, 0)} %)</td>${ej.map(e => `<td><b>${m$(e.k.ingreso_mes)}</b></td>`).join('')}</tr>
<tr><td>Veces que cubre el piloto</td>${ej.map(e => `<td><b>${fmt(e.k.veces_piloto)}</b></td>`).join('')}</tr></table>
<p class="disc rv" style="--d:6">Ejemplo con supuestos, no es una promesa de resultado.</p></div></section>`);

  // 5 · qué hacemos
  const refs = (Array.isArray(p.referencias) ? p.referencias : []).filter(r => r && r.nombre).slice(0, 3);
  const refTxt = r => esc(r.nombre) + (r.descripcion ? ' · ' + esc(String(r.descripcion).slice(0, 90)) : '');
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1684610529682-553625a1ffed', ovV(.88, .55))}<div class="content"><div class="eyebrow rv">04 · Qué hacemos</div>
<h2 class="rv" style="--d:1">Qué hacemos, <em>paso a paso.</em></h2>
<div class="tl">
<div class="st rv" style="--d:2"><b class="bn">01</b><small>Semanas 1–2</small><h3>Investigamos</h3><p>Averiguamos cuántas empresas hay, a cuáles llegamos y quién decide en cada una, antes de escribir a nadie.</p></div>
<div class="st rv" style="--d:3"><b class="bn">02</b><small>Semanas 2–3</small><h3>Empezamos a contactar</h3><p>Les escribimos por LinkedIn y correo, hablándoles de lo que de verdad les importa.</p></div>
<div class="st rv" style="--d:4"><b class="bn">03</b><small>Desde la semana 4</small><h3>Mejoramos cada mes</h3><p>Vemos qué respuestas llegan y mejoramos los mensajes y las empresas a las que escribimos.</p></div></div>
<div class="chips rv" style="--d:5"><span class="chip">LinkedIn</span><span class="chip">Correo electrónico</span><span class="chip">Seguimiento automático</span>${d.incluir_whatsapp ? '<span class="chip">WhatsApp</span>' : ''}</div>
${refs.length ? `<p class="cap rv" style="--d:6;margin-top:22px;font-size:13px">Ya lo hicimos para: ${refs.map(refTxt).join(' · ')}${d.resultados_referencia ? ' — ' + esc(d.resultados_referencia) : ''}</p>` : ''}</div></section>`);

  // 6 · tu portal en vivo
  const kp = (l, val, dsc) => `<div><small>${l}</small><b data-count="${val}">${val}</b><i>${dsc}</i></div>`;
  const rowp = (a, b2, c2) => `<div class="rowp"><b>${a}</b><span class="tg">${b2}</span><span>${c2}</span></div>`;
  S.push(`<section class="slide s-dark" data-th="dark">${bgDark}<div class="content"><div class="eyebrow rv">05 · Seguimiento</div>
<h2 class="rv" style="--d:1">Tu operación, <em>visible en vivo.</em></h2>
<div class="portal rv" style="--d:2"><div class="tb"><span>${esc(marca)} · Portal de seguimiento · ${esc(empresa)}</span><span class="lv">Ejemplo ilustrativo</span></div>
<div class="tabs"><button class="tab on" data-t="a">Resumen</button><button class="tab" data-t="b">Oportunidades</button><button class="tab" data-t="c">Empresas</button></div>
<div class="pane on" data-p="a"><div class="kp">${kp('Contactos alcanzados', 240, 'ilustrativo')}${kp('Respuestas', 6, '≈ 2,5 % · ilustrativo')}${kp('Reuniones', 1, 'ilustrativo')}${kp('Toques de contacto', 510, 'ilustrativo')}</div>
<svg class="trend" viewBox="0 0 640 84" preserveAspectRatio="none" width="100%" height="84"><g stroke="#E5E9F0" stroke-width="1"><line x1="0" y1="14" x2="640" y2="14"/><line x1="0" y1="42" x2="640" y2="42"/><line x1="0" y1="70" x2="640" y2="70"/></g><path d="M0 70 C40 66 60 48 100 52 S160 26 210 34 S270 56 320 38 S390 12 440 22 S520 44 560 20 S610 14 640 10" fill="none" stroke="${prim}" stroke-width="2.4"/></svg></div>
<div class="pane" data-p="b"><div class="rows">${rowp('Empresa ejemplo A', 'Reunión pedida', 'Siguiente paso: confirmar horario')}${rowp('Empresa ejemplo B', 'Interesado', 'Siguiente paso: enviar información')}${rowp('Empresa ejemplo C', 'En conversación', 'Siguiente paso: responder una duda')}</div></div>
<div class="pane" data-p="c"><div class="rows">${rowp('Empresa ejemplo A', 'Decisor identificado', 'Mensajes en curso · paso 3 de 5')}${rowp('Empresa ejemplo B', 'Contactado', 'Mensajes en curso · paso 2 de 5')}${rowp('Empresa ejemplo C', 'Respondió', 'Mensajes detenidos a la espera de ti')}</div></div></div>
<p class="cap rv" style="--d:3">Vista ilustrativa con datos de ejemplo: no es lo que se espera de tu campaña. Tendrás acceso desde la semana 1.</p></div></section>`);

  // 7 · qué incluye y qué no
  const inc = ['Un solo producto o servicio para empujar', 'Un tipo de cliente y un mercado para empezar', 'Hasta dos cargos de decisión por empresa', d.incluir_whatsapp ? 'LinkedIn, correo y WhatsApp' : 'LinkedIn y correo electrónico',
    'Investigación, mensajes y seguimiento de las respuestas', 'Reuniones cualificadas con quien decide, medidas y reportadas cada mes', 'Informe mensual y acceso al portal en vivo'];
  const exc = ['Varios productos, mercados o tipos de cliente a la vez', 'Publicidad pagada o redes sociales', 'Atender las reuniones, mandar presupuestos o cerrar la venta', 'Gestión después de la venta', d.incluir_whatsapp ? 'Licencias, dominios o buzones específicos del cliente' : 'WhatsApp (se puede añadir si lo necesitas)', 'Garantía de respuestas, reuniones o ventas'];
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">06 · Alcance</div>
<h2 class="rv" style="--d:1">Qué incluye y <em>qué no.</em></h2>
<div class="terms"><div class="in rv" style="--d:2"><h3>Incluye</h3><ul>${li_(inc.map(esc))}</ul></div><div class="ex rv" style="--d:3"><h3>No incluye</h3><ul>${li_(exc.map(esc))}</ul></div></div>
<p class="disc rv" style="--d:4"><b>No garantizamos respuestas, reuniones ni ventas; el cliente lleva las reuniones, propuestas y cierre.</b></p></div></section>`);

  // 8 · quién hace qué
  S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">07 · Responsabilidades</div>
<h2 class="rv" style="--d:1">Quién hace <em>qué.</em></h2>
<div class="two"><div class="rp dk rv" style="--d:2"><div class="k">Nosotros (${esc(marca)})</div><p>Investigamos, escribimos los mensajes, contactamos por los canales acordados, damos seguimiento a las respuestas, te pasamos las reuniones cualificadas y te enviamos un informe cada mes. Mejoramos todo con lo que vamos viendo.</p></div>
<div class="rp lt rv" style="--d:3"><div class="k">Tú (${esc(empresa)})</div><ul>${li_(['Nos cuentas qué ofreces y apruebas el primer enfoque.', 'Nos das los accesos que haga falta.', 'Respondes a las reuniones en menos de 48 horas.', 'Llevas las reuniones, las propuestas y el cierre.', 'Nos cuentas cómo fueron las conversaciones.'])}</ul></div></div></div></section>`);

  // 9 · inversión
  const sim = `<div class="sim rv" style="--d:2"><div class="k">Piloto de 30 días</div><div class="tot">${esc(m$(piloto))}<small>pago único</small></div><div class="eq">Unos 450 contactos · objetivo: ${fmt(obj, 0)} reuniones cualificadas.<br>Si no llegamos a 2, repetimos el piloto sin coste.</div></div>`;
  const facts = debil
    ? `<div class="facts"><div class="rv" style="--d:3"><small>Después del piloto</small><b style="font-size:21px">Lo decidimos juntos</b><p>Con los resultados a la vista.</p></div></div>`
    : `<div class="facts"><div class="rv" style="--d:3"><small>Mensual</small><b>${esc(m$(mensual))}/mes</b><p>Desde el mes 2, sin permanencia.</p></div>
<div class="rv" style="--d:4"><small>Bonus</small><b>${esc(m$(d.bonus_reunion == null ? 100 : d.bonus_reunion))} por reunión</b><p>Por cada reunión cualificada por encima de ${fmt(d.umbral_bonus == null ? 3 : d.umbral_bonus, 0)}. Sin otra comisión.</p></div></div>`;
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1500632907344-a073709b2448', ovV(.92, .8))}<div class="content"><div class="eyebrow rv">08 · Inversión</div>
<h2 class="rv" style="--d:1">Una inversión <em>clara.</em></h2>
<div class="inv">${sim}${facts}</div></div></section>`);

  // 10 · próximo paso
  const subj = 'Confirmo el piloto de 30 días';
  const body = `Hola,\n\nConfirmo el piloto de 30 días.\n\nPor favor indíquenme los siguientes pasos.\n\nSaludos,\n${contacto}${p.correo ? '\n' + p.correo : ''}`;
  const mailto = mail ? `mailto:${encodeURIComponent(mail).replace(/%40/g, '@')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}` : '#';
  const payInfo = [b.pago_email || mail, b.pago_telefono].filter(Boolean).join(' · ');
  S.push(`<section class="slide close s-dark" data-th="dark">${bgFoto('1521791136064-7986c2920216', ovL(.94, .62))}<div class="content">
<div><div class="eyebrow rv">Próximo paso con ${esc(marca)}</div>
<h2 class="rv" style="--d:1">Confirmemos el <em>piloto.</em></h2>
<p class="lead rv" style="--d:2">Una sola cosa: confirma que arrancamos. Esta propuesta es válida hasta el ${esc(fechaLarga(sumDays(fecha, validez)))}.</p>
<a class="cta rv" style="--d:3" target="_blank" rel="noopener noreferrer" href="${esc(mailto)}">Confirmar el piloto <span>↗</span></a></div>
<div class="steps"><div class="rv" style="--d:3"><i>01</i><span>Confirmas el piloto${d.decision_quien ? ' (decide ' + esc(d.decision_quien) + (d.decision_plazo ? ', ' + esc(d.decision_plazo) : '') + ')' : ''}.</span></div>
<div class="rv" style="--d:4"><i>02</i><span>Pago del piloto: ${esc(m$(piloto))}.${payInfo ? ' Datos de pago: ' + esc(payInfo) + '.' : ''}</span></div>
<div class="rv" style="--d:5"><i>03</i><span>Fecha de inicio: ${p.inicio ? esc(p.inicio) : 'la acordamos al confirmar'}.</span></div></div></div>
<div class="foot"><span>${esc(marca)}${mail ? ' · ' + esc(mail) : ''}${web ? ' · ' + esc(web) : ''}</span><span>Confidencial · preparada para ${esc(empresa)}</span></div></section>`);

  const total = S.length;
  const dots = S.map((_, i) => `<button class="dot" aria-label="${i + 1}"></button>`).join('');
  const rootVars = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--tl-rgb:${rgb(light)};--pr-rgb:${rgb(prim)};--dk-rgb:${rgb(dark)};--sans:'Inter','Segoe UI',system-ui,sans-serif}`;
  const title = archivo(b, p);
  return `<!DOCTYPE html>\n<html lang="es" data-deck="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${rootVars}${base.CSS}${EXTRA}</style></head><body>
<div class="hint">Gira el teléfono para ver mejor la presentación</div>
<div class="deck" id="deck" data-th="dark" data-tt="dark"><div class="stage" id="stage">
<div class="bar" id="bar"></div>
<div class="top"><div class="brand"><span class="bw">${brandW}</span><span class="bc">${brandC}</span></div><div class="r"><span class="cnt"><b id="cur">01</b> <i>/ ${pn(total)}</i></span><button class="btn-fs" id="fs" type="button">⛶ Presentar</button></div></div>
${S.join('\n')}
<button class="arr l" id="prev" aria-label="←">‹</button><button class="arr r" id="next" aria-label="→">›</button>
<div class="nav">${dots}</div>
</div></div>
<script>${base.JS}</script></body></html>`;
}

// «Propuesta NovaCentrax – Empresa – 2026-11-07»: nombre del PDF (el navegador lo toma del título del documento)
function archivo(brand, p) {
  const d = (p && p.dev) || {};
  return `Propuesta ${(brand && brand.nombre) || 'NovaCentrax'} – ${(p && p.empresa) || 'Cliente'} – ${d.fecha_propuesta || today()}`;
}

module.exports = { render, cleanDev, calc, validate, archivo, REQ };
