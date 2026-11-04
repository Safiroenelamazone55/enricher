'use strict';
// Company Overview (4 hojas A4): presentación de la empresa para enviar al cliente. HTML autónomo, listo para imprimir a PDF.
// Misma marca (colores y logos) que el resto de plantillas; texto en español e inglés (alemán y portugués usan el inglés por ahora).
const YEAR = 2026;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const U = id => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1400&q=70`;

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Inter','Segoe UI',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#E7EBF1;padding:24px 0}
.page{position:relative;width:794px;height:1123px;margin:0 auto 24px;background:#fff;overflow:hidden;box-shadow:0 10px 40px rgba(15,23,42,.18);break-after:page;page-break-after:always}
.page:last-of-type{margin-bottom:0;break-after:auto;page-break-after:auto}
.dark{background:var(--navy);color:#fff}
.ph{position:absolute;inset:0;background-size:cover;background-position:center}
.ph:after{content:"";position:absolute;inset:0;background:var(--ov)}
.in{position:relative;z-index:1;height:100%}
.hd{position:absolute;left:64px;right:64px;top:40px;display:flex;align-items:center;justify-content:space-between;z-index:2}
.hd img{height:30px;display:block}.hd .wm{font-weight:700;font-size:18px;letter-spacing:-.02em}
.hd span.r{font-size:10.5px;letter-spacing:.06em;color:var(--mute)}
.dark .hd,.onph .hd{color:#fff}
.dark .hd span.r,.onph .hd span.r{color:rgba(255,255,255,.65)}
.ft{position:absolute;left:64px;right:64px;bottom:34px;display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--mute);z-index:2}
.k{font-size:9.5px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;color:var(--teal)}
.dark .k,.onph .k{color:var(--teal-l)}
h1,h2,h3{letter-spacing:-.03em}
.bar{position:absolute;left:0;right:0;bottom:0;height:34px;display:grid;grid-template-columns:repeat(5,1fr);z-index:3}
.bar i:nth-child(1){background:var(--teal-l)}.bar i:nth-child(2){background:var(--teal)}.bar i:nth-child(3){background:color-mix(in srgb,var(--teal) 78%,#000)}.bar i:nth-child(4){background:color-mix(in srgb,var(--teal) 55%,#000)}.bar i:nth-child(5){background:var(--navy)}
/* portada */
.cv{position:absolute;left:64px;right:64px;top:300px}
.cv .rule{height:2px;width:100%;background:linear-gradient(90deg,var(--teal-l),transparent);margin-bottom:34px}
.cv h1{font-size:68px;line-height:1.02;font-weight:300;color:rgba(255,255,255,.72)}
.cv h1 b{display:block;font-weight:700;color:#fff}
.cv p.sub{margin-top:28px;max-width:470px;font-size:16.5px;line-height:1.6;color:rgba(255,255,255,.78)}
.cv .tag{margin-top:34px;font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.pre{position:absolute;left:64px;right:64px;bottom:98px;padding-top:18px;border-top:1px solid rgba(255,255,255,.25);display:flex;align-items:center;gap:20px}
.pre small{display:block;font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px}
.pre b{font-size:20px;font-weight:600;letter-spacing:-.02em}
.pre img{height:46px;max-width:200px;object-fit:contain}.pre img.cl-blanco{background:var(--navy);padding:8px 14px;border-radius:10px;height:54px}
/* hoja 2 */
.s2{position:absolute;left:64px;right:64px;top:104px}
.r1{display:grid;grid-template-columns:1.15fr .85fr;gap:36px;align-items:start}
.r1 h2{margin-top:10px;font-size:31px;line-height:1.1;font-weight:700}
.r1 p{margin-top:14px;font-size:12.5px;line-height:1.65;color:var(--text)}
.r1 p.m{color:var(--mute)}
.focus{margin-top:6px;padding:22px 24px;background:var(--soft);border-left:3px solid var(--teal);border-radius:0 14px 14px 0}
.focus p{margin-top:10px;font-size:14.5px;line-height:1.55;font-weight:500;color:var(--ink)}
.sec{margin-top:30px;padding-top:22px;border-top:1px solid var(--line)}
.sec h2{margin-top:8px;font-size:21px;font-weight:700}.sec h2 span{color:var(--mute);font-weight:500}
.ar{margin-top:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.ar>div{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff}
.ar .t{padding:14px 16px 13px;color:#fff}
.ar .t i{font-style:normal;font-size:20px;font-weight:700;color:var(--teal-l);letter-spacing:-.02em}
.ar .t small{display:block;margin-top:6px;font-size:9.5px;color:rgba(255,255,255,.65)}
.ar .t b{display:block;margin-top:1px;font-size:13.5px;font-weight:600;line-height:1.25}
.ar .b{padding:14px 16px 16px}
.ar .b p{min-height:30px;font-size:10.8px;line-height:1.5;color:var(--text)}
.ar ul{list-style:none;margin-top:10px}
.ar li{position:relative;padding:5px 0 5px 14px;font-size:10.8px;line-height:1.4;border-top:1px solid var(--line)}
.ar li:before{content:"";position:absolute;left:0;top:11px;width:5px;height:5px;border-radius:50%;background:var(--teal)}
.st{margin-top:14px;display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.st>div{position:relative;padding:14px 13px 15px;background:var(--soft);border-top:2.5px solid var(--teal);border-radius:0 0 10px 10px;min-height:132px}
.st i{font-style:normal;font-size:23px;font-weight:700;color:var(--teal);letter-spacing:-.03em}
.st b{display:block;margin-top:8px;font-size:12.5px;font-weight:700}
.st p{margin-top:6px;font-size:10px;line-height:1.45;color:var(--text)}
/* hoja 3 */
.band{position:absolute;left:0;right:0;top:0;height:372px;overflow:hidden}
.band .ph:after{background:linear-gradient(180deg,rgba(var(--dk-rgb),.88),rgba(var(--dk-rgb),.7))}
.band .tx{position:absolute;left:64px;right:64px;bottom:44px;z-index:2;color:#fff}
.band h2{margin-top:12px;font-size:39px;line-height:1.08;font-weight:700;max-width:560px}
.s3{position:absolute;left:64px;right:64px;top:404px}
.s3 .lead{max-width:560px;font-size:13px;line-height:1.7;color:var(--text)}
.sg{margin-top:18px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.sg>div{display:flex;align-items:center;gap:12px;padding:14px 14px;background:var(--soft);border-radius:12px;font-size:12px;font-weight:600}
.sg i{font-style:normal;font-size:12px;font-weight:700;color:var(--teal)}
.cap{margin-top:34px;padding-top:22px;border-top:1px solid var(--line)}
.cap h2{margin-top:8px;font-size:27px;font-weight:700}
.cp{margin-top:6px}
.cp>div{display:grid;grid-template-columns:64px 1fr;gap:6px;padding:20px 0;border-bottom:1px solid var(--line);align-items:start}
.cp i{font-style:normal;font-size:30px;font-weight:300;color:var(--teal);letter-spacing:-.04em;line-height:1}
.cp b{display:block;font-size:17px;font-weight:700;letter-spacing:-.02em}
.cp p{margin-top:6px;font-size:12.5px;line-height:1.6;color:var(--text);max-width:520px}
/* contacto */
.ct{position:absolute;left:64px;right:64px;top:300px}
.ct h2{margin-top:18px;font-size:46px;line-height:1.1;font-weight:300;color:rgba(255,255,255,.72)}
.ct h2 b{font-weight:700;color:#fff}
.ct p.l{margin-top:26px;max-width:480px;font-size:15.5px;line-height:1.65;color:rgba(255,255,255,.78)}
.cg{margin-top:44px;padding-top:26px;border-top:1px solid rgba(255,255,255,.25);display:grid;grid-template-columns:1.1fr .9fr;gap:28px}
.cg small{display:block;font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--teal-l);font-weight:600;margin-bottom:8px}
.cg a,.cg span{font-size:15px;color:#fff;text-decoration:none;font-weight:500}
.cg .w{margin-top:8px;display:block;font-size:12.5px;color:rgba(255,255,255,.6)}
.ctlogo{position:absolute;left:64px;bottom:96px;z-index:2}.ctlogo img{height:40px;display:block}.ctlogo .wm{font-weight:700;font-size:22px}
@page{size:210mm 297mm;margin:0}
@media print{
  body{background:#fff;padding:0}
  .page{width:210mm;height:296.6mm;margin:0;box-shadow:none}
}
`;

function render(brand, p, lang) {
  const b = brand || {}, prm = p || {};
  const es = lang === 'es';
  const t = (a, e) => (es ? a : e);
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'NovaCentrax';
  const web = (b.web || 'novacentrax.com').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const mail = b.email || 'contact@novacentrax.com';
  const tel = b.telefono || '+51 936 524 876';
  const fotos = prm.fotos !== false;
  const empresa = String(prm.empresa || '').trim();
  const lc = prm.logoCliente && typeof prm.logoCliente === 'object' ? prm.logoCliente : {};
  const clLogo = imgOk(lc[lc.usar]) ? lc[lc.usar] : '';
  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (elegido, orden) => { for (const k of [elegido, ...orden]) if (imgOk(logos[k])) return logos[k]; return ''; };
  const imgW = pick(b.logo_oscuro || 'blanco', ['blanco', 'color', 'negro']);
  const imgC = pick(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const lgW = imgW ? `<img alt="${esc(marca)}" src="${imgW}">` : `<span class="wm">${esc(marca)}</span>`;
  const lgC = imgC ? `<img alt="${esc(marca)}" src="${imgC}">` : `<span class="wm">${esc(marca)}</span>`;
  const ph = (id, ov, cls) => (fotos ? `<div class="ph${cls ? ' ' + cls : ''}" style="background-image:url('${U(id)}');--ov:${ov}"></div>` : '');
  const dkr = rgb(dark);
  const hdr = (logo, right) => `<div class="hd">${logo}<span class="r">${right}</span></div>`;
  const rt = `Company Overview · ${YEAR}`;
  const foot = n => `<div class="ft"><span>${esc(web)}</span><span>${n}</span></div>`;
  const bar = '<div class="bar"><i></i><i></i><i></i><i></i><i></i></div>';
  const li = a => a.map(x => `<li>${x}</li>`).join('');

  // ── hoja 1 · portada
  const pre = empresa || clLogo
    ? `<div class="pre"><div><small>${t('Preparado para', 'Prepared for')}</small>${clLogo ? `<img class="cl-${esc(lc.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : `<b>${esc(empresa)}</b>`}</div></div>`
    : '';
  const p1 = `<section class="page dark onph"><div class="ph" style="${fotos ? `background-image:url('${U('1486406146926-c627a92ad1ab')}');` : ''}--ov:linear-gradient(180deg,rgba(${dkr},.9) 0%,rgba(${dkr},.78) 55%,rgba(${dkr},.95) 100%)"></div>
<div class="in">${hdr(lgW, '')}
<div class="cv"><div class="rule"></div><h1>${t('Sistemas de <b>Crecimiento</b> y Operación', 'Growth &amp; <b>Operations</b> Systems')}</h1>
<p class="sub">${t('Sistemas para empresas B2B que quieren adquirir más clientes, operar con claridad y escalar con estructura.', 'Systems for B2B companies that want to win more customers, operate with clarity and scale with structure.')}</p>
<div class="tag">Company Overview · ${YEAR}</div></div>${pre}</div>${bar}</section>`;

  // ── hoja 2 · quiénes somos, qué hacemos, cómo trabajamos
  const area = (l, bg, small, title, desc, items) => `<div><div class="t" style="background:${bg}"><i>${l}</i><small>${small}</small><b>${title}</b></div><div class="b"><p>${desc}</p><ul>${li(items)}</ul></div></div>`;
  const step = (n, h, d) => `<div><i>${n}</i><b>${h}</b><p>${d}</p></div>`;
  const p2 = `<section class="page">${hdr(lgC, rt)}<div class="s2">
<div class="r1"><div><div class="k">${t('Quiénes somos', 'Who we are')}</div><h2>${t('Una sola empresa. Un solo sistema.', 'One company. One system.')}</h2>
<p>${t('NovaCentrax ayuda a empresas B2B a mejorar su adquisición comercial, estructura operativa y visibilidad mediante sistemas, automatización y ejecución enfocada en resultados.', 'NovaCentrax helps B2B companies improve their commercial acquisition, operating structure and visibility through systems, automation and results-focused execution.')}</p>
<p class="m">${t('No ofrecemos servicios aislados. Construimos un ecosistema que conecta crecimiento, operación e infraestructura digital.', 'We do not offer isolated services. We build an ecosystem that connects growth, operations and digital infrastructure.')}</p></div>
<div class="focus"><div class="k">${t('Nuestro enfoque', 'Our approach')}</div><p>${t('Identificamos fricciones, diseñamos sistemas a medida y ejecutamos para generar resultados medibles.', 'We identify friction, design tailored systems and execute to deliver measurable results.')}</p></div></div>
<div class="sec"><div class="k">${t('Qué hacemos', 'What we do')}</div><h2>${t('Tres áreas. Un ecosistema.', 'Three areas. One ecosystem.')}</h2>
<div class="ar">
${area('A', `var(--navy)`, t('Sistemas de', 'Commercial'), t('Crecimiento Comercial', 'Growth Systems'), t('Flujos que generan y califican demanda de forma predecible.', 'Flows that generate and qualify demand predictably.'), [t('Outbound systems &amp; lead generation', 'Outbound systems &amp; lead generation'), t('CRM &amp; estructura de pipeline', 'CRM &amp; pipeline structure'), t('Funnel &amp; acquisition workflows', 'Funnel &amp; acquisition workflows'), t('Secuencias de contacto automatizadas', 'Automated contact sequences')])}
${area('B', `color-mix(in srgb,var(--navy) 78%,#5b6b85)`, t('Operación y', 'Operations &amp;'), t('Visibilidad Interna', 'Internal Visibility'), t('Infraestructura interna para operar con claridad y datos accionables.', 'Internal infrastructure to operate with clarity and actionable data.'), [t('Implementación Odoo ERP', 'Odoo ERP implementation'), t('Dashboards &amp; reporting ejecutivo', 'Dashboards &amp; executive reporting'), t('KPIs y visibilidad de negocio', 'KPIs &amp; business visibility'), t('Process mapping &amp; optimización', 'Process mapping &amp; optimization')])}
${area('C', `color-mix(in srgb,var(--teal) 60%,var(--navy))`, t('Infraestructura', 'Digital'), t('Digital', 'Infrastructure'), t('Activos digitales que conectan, convierten y automatizan operaciones.', 'Digital assets that connect, convert and automate operations.'), [t('Websites &amp; landing pages', 'Websites &amp; landing pages'), t('Automatizaciones e integraciones', 'Automations &amp; integrations'), t('Sistemas internos operativos', 'Internal operating systems'), t('Arquitectura de herramientas', 'Tool architecture')])}
</div></div>
<div class="sec"><div class="k">${t('Cómo trabajamos', 'How we work')}</div><h2>${t('Un proceso sistemático.', 'A systematic process.')} <span>${t('Reproducible y medible.', 'Repeatable and measurable.')}</span></h2>
<div class="st">
${step('01', t('Análisis', 'Analysis'), t('Diagnóstico comercial y operativo. Mapeamos fricciones.', 'Commercial and operational diagnosis. We map friction.'))}
${step('02', t('Diseño', 'Design'), t('Arquitectura del sistema: flujos, herramientas y estructura.', 'System architecture: flows, tools and structure.'))}
${step('03', t('Ejecución', 'Execution'), t('Implementamos con velocidad y precisión.', 'We implement with speed and precision.'))}
${step('04', t('Medición', 'Measurement'), t('KPIs, reportes y visibilidad total.', 'KPIs, reports and full visibility.'))}
${step('05', t('Optimización', 'Optimization'), t('Iteramos. Escalamos lo que funciona.', 'We iterate. We scale what works.'))}
</div></div></div>${foot(2)}</section>`;

  // ── hoja 3 · enfoque B2B, sectores, capacidades
  const sect = [t('SaaS &amp; Software B2B', 'SaaS &amp; B2B Software'), t('Servicios Profesionales', 'Professional Services'), t('Consultoría &amp; Advisory', 'Consulting &amp; Advisory'), t('Training &amp; Educación', 'Training &amp; Education'), t('Empresas Técnicas', 'Technical Companies'), t('Negocios Operativos', 'Operating Businesses')];
  const cap = (n, h, d) => `<div><i>${n}</i><span><b>${h}</b><p>${d}</p></span></div>`;
  const p3 = `<section class="page onph"><div class="band">${ph('1572021335469-31706a17aaef', '', '')}${fotos ? '' : `<div class="ph" style="background:var(--navy)"></div>`}
${hdr(lgW, rt)}<div class="tx"><div class="k">${t('Enfoque B2B', 'B2B focus')}</div><h2>${t('Construido para empresas que necesitan estructura.', 'Built for companies that need structure.')}</h2></div></div>
<div class="s3"><p class="lead">${t('Ciclos de venta largos, múltiples decisores y necesidad de procesos sólidos. Trabajamos con empresas que quieren crecer sin perder control operativo.', 'Long sales cycles, multiple decision-makers and a need for solid processes. We work with companies that want to grow without losing operational control.')}</p>
<div class="sec" style="margin-top:26px"><div class="k">${t('Sectores', 'Sectors')}</div><div class="sg">${sect.map((s, i) => `<div><i>${String(i + 1).padStart(2, '0')}</i>${s}</div>`).join('')}</div></div>
<div class="cap"><div class="k">${t('Capacidades &amp; resultados', 'Capabilities &amp; results')}</div><h2>${t('Sistemas que funcionan.', 'Systems that work.')}</h2>
<div class="cp">
${cap('01', t('Adquisición Comercial', 'Commercial Acquisition'), t('Outbound estructurado, CRM activo y pipelines que generan oportunidades reales.', 'Structured outbound, active CRM and pipelines that generate real opportunities.'))}
${cap('02', t('Claridad Operativa', 'Operational Clarity'), t('Dashboards, KPIs y procesos que dan visibilidad real sobre el negocio.', 'Dashboards, KPIs and processes that give real visibility into the business.'))}
${cap('03', t('Infraestructura Escalable', 'Scalable Infrastructure'), t('Automatizaciones y sistemas internos que eliminan fricción y soportan el crecimiento.', 'Automations and internal systems that remove friction and support growth.'))}
</div></div></div>${foot(3).replace('class="ft"', 'class="ft" style="z-index:3"')}</section>`;

  // ── hoja 4 · contacto
  const p4 = `<section class="page dark onph"><div class="ph" style="${fotos ? `background-image:url('${U('1500632907344-a073709b2448')}');` : ''}--ov:linear-gradient(180deg,rgba(${dkr},.93) 0%,rgba(${dkr},.86) 60%,rgba(${dkr},.96) 100%)"></div>
<div class="in">${hdr(lgW, rt)}
<div class="ct"><div class="k">${t('¿Hablamos?', 'Let’s talk?')}</div>
<h2>${t('Si necesitas mejorar tu <b>estructura comercial, visibilidad operativa</b> o sistemas de adquisición,', 'If you need to improve your <b>commercial structure, operational visibility</b> or acquisition systems,')}</h2>
<p class="l">${t('podemos ayudarte a identificar los cuellos de botella y construir procesos más escalables.', 'we can help you identify bottlenecks and build more scalable processes.')}</p>
<div class="cg"><div><small>Email</small><a href="mailto:${esc(mail)}">${esc(mail)}</a><span class="w">${esc(web)}</span></div><div><small>WhatsApp</small><a href="https://wa.me/${esc(tel.replace(/\D/g, ''))}">${esc(tel)}</a></div></div></div>
<div class="ctlogo">${lgW}</div></div>${bar}</section>`;

  const title = `${marca} · Company Overview ${YEAR}${empresa ? ' · ' + empresa : ''}`;
  const root = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--dk-rgb:${dkr}}`;
  return `<!DOCTYPE html>\n<html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${root}${CSS}</style></head><body>${p1}${p2}${p3}${p4}</body></html>`;
}

module.exports = { render };
