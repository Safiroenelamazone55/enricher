'use strict';
// Company Overview (5 hojas A4, una idea por hoja): presentación de la empresa para enviar al cliente. HTML autónomo, listo para imprimir a PDF.
// Misma marca (colores y logos) que el resto de plantillas; texto en español e inglés (alemán y portugués usan el inglés por ahora).
const YEAR = 2026;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const U = id => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1400&q=70`;

// Escala tipográfica única: etiqueta 10 · cuerpo 12.5–13 · destacado 16 · título 50 · cifra 64
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Inter','Segoe UI',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#E7EBF1;padding:24px 0}
.page{position:relative;width:794px;height:1123px;margin:0 auto 24px;background:#fff;overflow:hidden;box-shadow:0 10px 40px rgba(15,23,42,.18);break-after:page;page-break-after:always}
.page:last-of-type{margin-bottom:0;break-after:auto;page-break-after:auto}
.dark{background:var(--navy);color:#fff}
.ph{position:absolute;inset:0;background-size:cover;background-position:center;background-color:var(--navy)}
.ph:after{content:"";position:absolute;inset:0;background:var(--ov)}
.in{position:relative;z-index:1;height:100%}
.hd{position:absolute;left:64px;right:64px;top:40px;display:flex;align-items:center;justify-content:space-between;z-index:2}
.hd img{height:30px;display:block}.hd .wm{font-weight:700;font-size:18px;letter-spacing:-.02em}
.hd span.r{font-size:10px;letter-spacing:.08em;color:var(--mute)}
.dark .hd,.onph .hd{color:#fff}.dark .hd span.r,.onph .hd span.r{color:rgba(255,255,255,.62)}
.ft{position:absolute;left:64px;right:64px;bottom:34px;display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--mute);z-index:2}
.k{font-size:10px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;color:var(--teal)}
.dark .k,.onph .k{color:var(--teal-l)}
h1,h2{font-weight:700;letter-spacing:-.04em}
.h1{margin-top:16px;font-size:50px;line-height:1.04}
.h1 em{font-style:normal;color:var(--teal)}
.lead{margin-top:22px;max-width:520px;font-size:16px;line-height:1.65;color:var(--text)}
.bar{position:absolute;left:0;right:0;bottom:0;height:34px;display:grid;grid-template-columns:repeat(5,1fr);z-index:3}
.bar i:nth-child(1){background:var(--teal-l)}.bar i:nth-child(2){background:var(--teal)}.bar i:nth-child(3){background:color-mix(in srgb,var(--teal) 78%,#000)}.bar i:nth-child(4){background:color-mix(in srgb,var(--teal) 55%,#000)}.bar i:nth-child(5){background:var(--navy)}
.body{position:absolute;left:64px;right:64px;top:112px}
/* 1 · portada */
.cv{position:absolute;left:64px;right:64px;top:300px}
.cv .rule{height:2px;width:100%;background:linear-gradient(90deg,var(--teal-l),transparent);margin-bottom:34px}
.cv h1{font-size:68px;line-height:1.02;font-weight:300;color:rgba(255,255,255,.72);letter-spacing:-.04em}
.cv h1 b{display:block;font-weight:700;color:#fff}
.cv p.sub{margin-top:28px;max-width:470px;font-size:16.5px;line-height:1.6;color:rgba(255,255,255,.78)}
.cv .tag{margin-top:34px;font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.pre{position:absolute;left:64px;right:64px;bottom:98px;padding-top:18px;border-top:1px solid rgba(255,255,255,.25)}
.pre small{display:block;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px}
.pre b{font-size:20px;font-weight:600}.pre img{height:46px;max-width:200px;object-fit:contain}.pre img.cl-blanco{background:var(--navy);padding:8px 14px;border-radius:10px;height:54px}
/* 2 · quiénes somos */
.pic{position:relative;margin-top:40px;height:340px;border-radius:22px;overflow:hidden;background:var(--navy)}
.pic .ph{border-radius:22px}
.pic .cap{position:absolute;left:30px;right:30px;bottom:26px;z-index:2;color:#fff;font-size:26px;line-height:1.15;font-weight:600;letter-spacing:-.03em}
.pic .cap small{display:block;margin-bottom:10px;font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.facts{margin-top:42px;display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-top:1.5px solid var(--ink)}
.facts>div{padding:18px 22px 0 0}
.facts>div+div{padding-left:22px;border-left:1px solid var(--line)}
.facts b{display:block;font-size:44px;line-height:1;font-weight:700;letter-spacing:-.05em;color:var(--teal)}
.facts p{margin-top:12px;font-size:12.5px;line-height:1.55;color:var(--text)}
/* 3 · qué hacemos */
.cols{margin-top:42px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.col{border:1px solid var(--line);border-radius:18px;overflow:hidden;background:#fff}
.col .t{padding:20px 20px 18px;color:#fff;min-height:156px}
.col .t i{font-style:normal;font-size:46px;font-weight:300;line-height:1;letter-spacing:-.05em;color:var(--teal-l)}
.col .t b{display:block;margin-top:14px;font-size:22px;font-weight:700;letter-spacing:-.03em}
.col .t small{display:block;margin-top:4px;font-size:11px;color:rgba(255,255,255,.68)}
.col ul{list-style:none;padding:8px 20px 14px;min-height:262px}
.col li{padding:20px 0;border-top:1px solid var(--line)}.col li:first-child{border-top:0}
.col li b{display:block;font-size:14px;font-weight:700;letter-spacing:-.015em}
.col li span{display:block;margin-top:5px;font-size:12px;line-height:1.5;color:var(--text)}
.goal{margin-top:18px;padding:36px 34px;background:var(--navy);border-radius:18px;color:#fff;position:relative;overflow:hidden}
.goal:before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--teal-l)}
.goal .k{color:var(--teal-l)}
.goal b{display:block;margin-top:12px;font-size:36px;line-height:1.1;font-weight:700;letter-spacing:-.04em}
.goal p{margin-top:12px;max-width:560px;font-size:13px;line-height:1.6;color:rgba(255,255,255,.8)}
/* 4 · cómo trabajamos */
.steps{margin-top:30px;border-top:1.5px solid var(--ink)}
.steps>div{display:grid;grid-template-columns:96px 1fr;gap:10px;padding:27px 0;border-bottom:1px solid var(--line);align-items:start}
.steps i{font-style:normal;font-size:50px;font-weight:300;line-height:1;letter-spacing:-.05em;color:var(--teal)}
.steps b{display:block;font-size:20px;font-weight:700;letter-spacing:-.03em}
.steps p{margin-top:7px;max-width:500px;font-size:13px;line-height:1.6;color:var(--text)}
.work{margin-top:36px;padding:28px 28px 26px;background:var(--soft);border-radius:18px}
.work .g{margin-top:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.work b{display:block;font-size:14px;font-weight:700;letter-spacing:-.015em}
.work p{margin-top:6px;font-size:11.5px;line-height:1.55;color:var(--text)}
.work .g>div{padding-top:14px;border-top:2px solid var(--teal)}
/* 5 · contacto */
.ct{position:absolute;left:64px;right:64px;top:300px}
.ct h2{margin-top:18px;font-size:46px;line-height:1.1;font-weight:300;color:rgba(255,255,255,.72)}
.ct h2 b{font-weight:700;color:#fff}
.ct p.l{margin-top:26px;max-width:480px;font-size:16px;line-height:1.65;color:rgba(255,255,255,.78)}
.cg{margin-top:44px;padding-top:26px;border-top:1px solid rgba(255,255,255,.25);display:grid;grid-template-columns:1.1fr .9fr;gap:28px}
.cg small{display:block;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--teal-l);font-weight:600;margin-bottom:8px}
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
  const dkr = rgb(dark);
  const bgPh = (id, ov) => `<div class="ph" style="${fotos ? `background-image:url('${U(id)}');` : ''}--ov:${ov}"></div>`;
  const hdr = (logo, right) => `<div class="hd">${logo}<span class="r">${right}</span></div>`;
  const rt = `Company Overview · ${YEAR}`;
  const foot = n => `<div class="ft"><span>${esc(web)}</span><span>${n}</span></div>`;
  const bar = '<div class="bar"><i></i><i></i><i></i><i></i><i></i></div>';

  // ── 1 · portada
  const pre = empresa || clLogo
    ? `<div class="pre"><small>${t('Preparado para', 'Prepared for')}</small>${clLogo ? `<img class="cl-${esc(lc.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : `<b>${esc(empresa)}</b>`}</div>`
    : '';
  const p1 = `<section class="page dark onph">${bgPh('1486406146926-c627a92ad1ab', `linear-gradient(180deg,rgba(${dkr},.9) 0%,rgba(${dkr},.78) 55%,rgba(${dkr},.95) 100%)`)}
<div class="in">${hdr(lgW, '')}
<div class="cv"><div class="rule"></div><h1>${t('Creamos sistemas de <b>crecimiento</b> B2B', 'We build B2B <b>growth</b> systems')}</h1>
<p class="sub">${t('Ayudamos a las empresas B2B a conseguir clientes con un sistema comercial que se valida, se estructura y se escala.', 'We help B2B companies win customers with a commercial system that is validated, structured and scaled.')}</p>
<div class="tag">Company Overview · ${YEAR}</div></div>${pre}</div>${bar}</section>`;

  // ── 2 · quiénes somos
  const p2 = `<section class="page">${hdr(lgC, rt)}<div class="body">
<div class="k">${t('Quiénes somos', 'Who we are')}</div>
<h1 class="h1">${t('Ayudamos a empresas B2B a <em>conseguir clientes.</em>', 'We help B2B companies <em>win customers.</em>')}</h1>
<p class="lead">${t('Validamos el mercado, estructuramos el proceso comercial y lo escalamos. Una agencia de crecimiento que ejecuta junto a tu equipo.', 'We validate the market, structure the commercial process and scale it. A growth agency that executes alongside your team.')}</p>
<div class="pic">${bgPh('1557804506-669a67965ba0', `linear-gradient(180deg,rgba(${dkr},.05) 25%,rgba(${dkr},.85) 100%)`)}<div class="cap"><small>${t('Nuestro enfoque', 'Our approach')}</small>${t('Operamos como parte de tu equipo.', 'We operate as part of your team.')}</div></div>
<div class="facts">
<div><b>2022</b><p>${t('Agencia de crecimiento B2B con base en Perú, desde 2022.', 'B2B growth agency based in Peru, since 2022.')}</p></div>
<div><b>10–50</b><p>${t('Equipos de 10 a 50 personas, de cualquier sector B2B.', 'Teams of 10 to 50 people, in any B2B sector.')}</p></div>
<div><b>${t('1 meta', '1 goal')}</b><p>${t('Que tu empresa consiga clientes de forma ordenada.', 'For your company to win customers in an orderly way.')}</p></div>
</div></div>${foot(2)}</section>`;

  // ── 3 · qué hacemos
  const fase = (n, h, small, bg, items) => `<div class="col"><div class="t" style="background:${bg}"><i>${n}</i><b>${h}</b><small>${small}</small></div><ul>${items.map(([a, d]) => `<li><b>${a}</b><span>${d}</span></li>`).join('')}</ul></div>`;
  const p3 = `<section class="page">${hdr(lgC, rt)}<div class="body">
<div class="k">${t('Qué hacemos', 'What we do')}</div>
<h1 class="h1">${t('Validar. Estructurar. <em>Escalar.</em>', 'Validate. Structure. <em>Scale.</em>')}</h1>
<p class="lead">${t('Cinco servicios conectados, un solo objetivo: conseguir clientes B2B.', 'Five connected services, one goal: winning B2B customers.')}</p>
<div class="cols">
${fase('01', t('Validar', 'Validate'), t('Antes de invertir', 'Before investing'), 'var(--navy)', [[t('Estudio de mercado', 'Market research'), t('Sabes a quién venderle, cuánto vale y qué decirle.', 'You know who to sell to, how much it is worth and what to say.')]])}
${fase('02', t('Estructurar', 'Structure'), t('Un proceso que funciona', 'A process that works'), 'color-mix(in srgb,var(--navy) 78%,#5b6b85)', [[t('Prospección de clientes', 'Customer prospecting'), t('Llegamos a las empresas correctas y agendamos reuniones.', 'We reach the right companies and book meetings.')], [t('CRM y ventas', 'CRM &amp; sales'), t('Un proceso ordenado que no pierde ningún cliente.', 'An organized process that never loses a customer.')]])}
${fase('03', t('Escalar', 'Scale'), t('Más alcance, más clientes', 'More reach, more customers'), 'color-mix(in srgb,var(--teal) 60%,var(--navy))', [[t('Redes sociales', 'Social media'), t('Presencia que genera consultas, no solo likes.', 'A presence that generates inquiries, not just likes.')], [t('Publicidad online', 'Online advertising'), t('Anuncios que se miden en clientes, no en clics.', 'Ads measured in customers, not clicks.')]])}
</div>
<div class="goal"><div class="k">${t('El resultado', 'The result')}</div><b>${t('Optimización comercial', 'Commercial optimization')}</b><p>${t('Los cinco servicios trabajan juntos para que tu empresa consiga clientes de forma ordenada, y para que el sistema mejore cada mes.', 'All five services work together so your company wins customers in an orderly way, and so the system improves every month.')}</p></div>
</div>${foot(3)}</section>`;

  // ── 4 · cómo trabajamos
  const step = (n, h, d) => `<div><i>${n}</i><span><b>${h}</b><p>${d}</p></span></div>`;
  const w3 = (h, d) => `<div><b>${h}</b><p>${d}</p></div>`;
  const p4 = `<section class="page">${hdr(lgC, rt)}<div class="body">
<div class="k">${t('Cómo trabajamos', 'How we work')}</div>
<h1 class="h1">${t('Un proceso claro, medible y <em>en mejora continua.</em>', 'A clear, measurable process, <em>always improving.</em>')}</h1>
<div class="steps">
${step('01', t('Investigamos y definimos objetivos', 'We research and set goals'), t('Analizamos el mercado, el negocio, la competencia y las oportunidades para definir objetivos claros.', 'We analyze the market, the business, the competition and the opportunities to set clear goals.'))}
${step('02', t('Diseñamos la estrategia', 'We design the strategy'), t('Definimos los canales, mensajes, prioridades y acciones necesarias para captar clientes.', 'We define the channels, messages, priorities and actions needed to win customers.'))}
${step('03', t('Implementamos el sistema', 'We implement the system'), t('Creamos y conectamos los procesos, contenidos y herramientas que sostienen la operación.', 'We build and connect the processes, content and tools that sustain the operation.'))}
${step('04', t('Medimos y optimizamos', 'We measure and optimize'), t('Analizamos los resultados, detectamos oportunidades y mejoramos el sistema de forma continua.', 'We analyze results, spot opportunities and improve the system continuously.'))}
</div>
<div class="work"><div class="k">${t('Ejecutamos. Tú decides.', 'We execute. You decide.')}</div><div class="g">
${w3(t('Ejecutamos, no solo asesoramos', 'We execute, not just advise'), t('Nuestro equipo investiga, contacta, publica y da seguimiento; tú apruebas.', 'Our team researches, reaches out, publishes and follows up; you approve.'))}
${w3(t('Metas por escrito', 'Written goals'), t('Las acordamos al empezar y las medimos cada mes: contactos, respuestas y reuniones.', 'We agree on them up front and measure monthly: contacts, replies and meetings.'))}
${w3(t('Empezamos donde estés', 'We start where you are'), t('Una llamada para entender tu negocio. Si no sabes por dónde empezar, arrancamos con un estudio de mercado.', 'One call to understand your business. If you do not know where to start, we begin with a market study.'))}
</div></div></div>${foot(4)}</section>`;

  // ── 5 · contacto
  const p5 = `<section class="page dark onph">${bgPh('1500632907344-a073709b2448', `linear-gradient(180deg,rgba(${dkr},.93) 0%,rgba(${dkr},.86) 60%,rgba(${dkr},.96) 100%)`)}
<div class="in">${hdr(lgW, rt)}
<div class="ct"><div class="k">${t('¿Hablamos?', 'Let’s talk?')}</div>
<h2>${t('Cuéntanos tu <b>proyecto</b> y te decimos por dónde <b>empezar</b>.', 'Tell us about your <b>project</b> and we will tell you where to <b>start</b>.')}</h2>
<p class="l">${t('Agenda un diagnóstico y construyamos juntos un sistema para conseguir clientes de forma ordenada.', 'Book a diagnosis and let us build together a system to win customers in an orderly way.')}</p>
<div class="cg"><div><small>Email</small><a href="mailto:${esc(mail)}">${esc(mail)}</a><span class="w">${esc(web)} · ${t('Perú', 'Peru')}</span></div><div><small>WhatsApp</small><a href="https://wa.me/${esc(tel.replace(/\D/g, ''))}">${esc(tel)}</a></div></div></div>
<div class="ctlogo">${lgW}</div></div>${bar}</section>`;

  const title = `${marca} · Company Overview ${YEAR}${empresa ? ' · ' + empresa : ''}`;
  const root = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--dk-rgb:${dkr}}`;
  return `<!DOCTYPE html>\n<html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${root}${CSS}</style></head><body>${p1}${p2}${p3}${p4}${p5}</body></html>`;
}

module.exports = { render };
