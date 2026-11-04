'use strict';
// Propuesta formal y acuerdo comercial (hojas A4): documento sobrio, sin fotos, que se acepta y se firma por las dos partes.
// El texto de alcance, método, entregables y responsabilidades es el mismo de la presentación interactiva (se copió de ahí: si cambia allá, hay que cambiarlo aquí).
// Español e inglés completos; alemán y portugués usan el inglés por ahora.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const money = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Inter','Segoe UI',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#E7EBF1;padding:24px 0}
.page{position:relative;width:794px;height:1123px;margin:0 auto 24px;background:#fff;overflow:hidden;box-shadow:0 10px 40px rgba(15,23,42,.18);break-after:page;page-break-after:always}
.page:last-of-type{margin-bottom:0;break-after:auto;page-break-after:auto}
.hd{position:absolute;left:64px;right:64px;top:38px;display:flex;align-items:center;justify-content:space-between;padding-bottom:14px;border-bottom:1px solid var(--line)}
.hd img{height:26px;display:block}.hd .wm{font-weight:700;font-size:16px;letter-spacing:-.02em}
.hd span.r{font-size:10px;letter-spacing:.06em;color:var(--mute)}
.ft{position:absolute;left:64px;right:64px;bottom:34px;display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--mute)}
.body{position:absolute;left:64px;right:64px;top:100px;bottom:80px}
h2{font-size:17px;font-weight:700;letter-spacing:-.02em;color:var(--ink);display:flex;gap:10px;align-items:baseline}
h2 i{font-style:normal;color:var(--teal);font-weight:600}
.cl{margin-top:22px}.cl:first-child{margin-top:0}
.cl p,.cl li{font-size:11.6px;line-height:1.62;color:var(--text)}
.cl p{margin-top:8px}
.cl ul{margin-top:8px;list-style:none}
.cl li{position:relative;padding:3px 0 3px 15px}
.cl li:before{content:"";position:absolute;left:2px;top:10px;width:4px;height:4px;border-radius:50%;background:var(--teal)}
.sub{margin-top:14px;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.two{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:22px}
.tb{margin-top:10px;border-top:1.5px solid var(--ink)}
.tb>div{display:grid;grid-template-columns:190px 1fr;gap:14px;padding:9px 0;border-bottom:1px solid var(--line);font-size:11.6px;line-height:1.5}
.tb b{font-weight:600;color:var(--ink)}.tb span{color:var(--text)}
.ph3{margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.ph3>div{padding:12px 14px;background:var(--soft);border-top:2px solid var(--teal)}
.ph3 small{display:block;font-size:9.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--teal)}
.ph3 b{display:block;margin-top:5px;font-size:12.5px;font-weight:700}
.ph3 p{margin-top:5px;font-size:10.8px;line-height:1.5;color:var(--text)}
.n4{margin-top:10px;border-top:1.5px solid var(--ink)}
.n4>div{display:grid;grid-template-columns:28px 1fr 210px;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);align-items:start}
.n4 i{font-style:normal;font-size:11px;font-weight:600;color:var(--teal);padding-top:1px}
.n4 b{font-size:11.6px;font-weight:700}.n4 p{margin-top:2px;font-size:10.8px;line-height:1.5;color:var(--text)}
.n4 em{font-style:normal;font-size:10.8px;color:var(--text)}.n4 em small{display:block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-bottom:2px}
.n6{margin-top:8px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px}
.n6>div{font-size:10.8px;line-height:1.5;color:var(--text);padding-top:7px;border-top:1px solid var(--line)}
.n6 b{display:block;color:var(--ink);font-size:11.4px}
.dl{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:0 26px}
.dl>div{display:grid;grid-template-columns:22px 1fr;padding:6px 0;border-bottom:1px solid var(--line);font-size:11.2px;line-height:1.45;color:var(--text)}
.dl i{font-style:normal;font-weight:600;color:var(--teal);font-size:10.5px;padding-top:1px}
.note{margin-top:10px;font-size:10.4px;line-height:1.55;color:var(--mute)}
/* portada */
.cv{position:absolute;left:64px;right:64px;top:210px}
.cv .k{font-size:10.5px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;color:var(--teal)}
.cv h1{margin-top:18px;font-size:46px;line-height:1.05;font-weight:700;letter-spacing:-.04em;max-width:640px}
.cv h1 em{font-style:normal;color:var(--teal)}
.cv .ln{margin-top:30px;height:3px;width:64px;background:var(--teal)}
.cv p{margin-top:24px;max-width:500px;font-size:14px;line-height:1.65;color:var(--text)}
.meta{position:absolute;left:64px;right:64px;bottom:120px;border-top:1.5px solid var(--ink)}
.meta>div{display:grid;grid-template-columns:170px 1fr;gap:14px;padding:11px 0;border-bottom:1px solid var(--line);font-size:12px}
.meta b{font-weight:600;color:var(--mute);font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding-top:2px}
.meta span{color:var(--ink);font-weight:500}.meta img{height:34px;max-width:170px;object-fit:contain}.meta img.cl-blanco{background:var(--navy);padding:6px 12px;border-radius:6px;height:42px}
/* firma */
.sum{margin-top:14px;padding:16px 18px;background:var(--soft);border-left:3px solid var(--teal)}
.sum .tb{margin-top:0;border-top:0}.sum .tb>div{padding:7px 0;grid-template-columns:170px 1fr}
.sig{margin-top:26px;display:grid;grid-template-columns:1fr 1fr;gap:34px}
.sig h3{font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--teal)}
.sig .who{margin-top:6px;font-size:14px;font-weight:700;letter-spacing:-.02em}
.sig .row{margin-top:20px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.sig .row b{display:block;margin-top:5px;min-height:20px;font-size:12px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink);border-bottom:1px solid var(--ink);padding-bottom:3px}
.sig .row.firma b{min-height:70px}
@page{size:210mm 297mm;margin:0}
@media print{body{background:#fff;padding:0}.page{width:210mm;height:296.6mm;margin:0;box-shadow:none}}
`;

function render(brand, p, lang) {
  const b = brand || {}, prm = p || {};
  const es = lang === 'es';
  const t = (a, e) => (es ? a : e);
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'NovaCentrax';
  const web = (b.web || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const empresa = String(prm.empresa || '').trim() || t('Cliente', 'Client');
  const contacto = String(prm.contacto || '').trim(), correo = String(prm.correo || '').trim();
  const sym = String(prm.moneda || 'US$'), fee = Math.max(0, parseInt(prm.fee, 10) || 0), meses = Math.min(36, Math.max(1, parseInt(prm.plazo, 10) || 3));
  const validez = Math.min(180, Math.max(1, parseInt(prm.validez, 10) || 15));
  const preaviso = Math.min(180, Math.max(1, parseInt(prm.preaviso, 10) || 15));
  const jur = String(prm.jurisdiccion || '').trim() || t('Perú', 'Peru');
  const lc = prm.logoCliente && typeof prm.logoCliente === 'object' ? prm.logoCliente : {};
  const clLogo = imgOk(lc[lc.usar]) ? lc[lc.usar] : '';
  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pickL = (elegido, orden) => { for (const k of [elegido, ...orden]) if (imgOk(logos[k])) return logos[k]; return ''; };
  const imgC = pickL(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const lgC = imgC ? `<img alt="${esc(marca)}" src="${imgC}">` : `<span class="wm">${esc(marca)}</span>`;
  const hoy = new Date().toLocaleDateString(es ? 'es-PE' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const com = Math.min(100, Math.max(0, parseFloat(prm.comision) || 0)), comTxt = String(com).replace('.', es ? ',' : '.') + '%';
  const comBase = esc(String(prm.comisionBase || '').trim()) || t('el valor de cada venta cerrada con una oportunidad generada por el servicio', 'the value of each sale closed with an opportunity generated by the service');
  const modelo = com > 0 ? t(`Tarifa fija mensual + ${comTxt} de comisión`, `Fixed monthly fee + ${comTxt} commission`) : t('Tarifa fija mensual, sin comisión', 'Fixed monthly fee, no commission');
  const notaPago = prm.nota ? esc(prm.nota) : t('Pago al inicio de cada periodo mensual.', 'Paid at the start of each monthly period.');
  const titulo = prm.servicio ? `${esc(prm.servicio)} <em>${esc(prm.servicioEm || '')}</em>` : t('Sistema de Adquisición <em>Comercial B2B</em>', 'B2B Commercial <em>Acquisition System</em>');
  const feeTxt = `${esc(sym)}${money(fee)}`, totalTxt = `${esc(sym)}${money(fee * meses)}`;
  const inicio = prm.inicio ? esc(prm.inicio) : t('A la fecha de firma', 'On the signing date');
  const li = a => a.map(x => `<li>${x}</li>`).join('');
  const hdr = `<div class="hd">${lgC}<span class="r">${t('Propuesta y acuerdo comercial', 'Commercial proposal and agreement')} · ${esc(empresa)}</span></div>`;
  const ft = n => `<div class="ft"><span>${esc(marca)}${web ? ' · ' + esc(web) : ''} · ${t('Confidencial', 'Confidential')}</span><span>${n}</span></div>`;
  const row = (k, v) => `<div><b>${k}</b><span>${v}</span></div>`;

  // ── 1 · portada
  const p1 = `<section class="page"><div class="hd">${lgC}<span class="r">${t('Confidencial', 'Confidential')}</span></div>
<div class="cv"><div class="k">${t('Propuesta y acuerdo comercial', 'Commercial proposal and agreement')}</div><h1>${titulo}</h1><div class="ln"></div>
<p>${t('Investigación, prospección y ejecución multicanal para generar oportunidades comerciales de forma estructurada, medible y constante.', 'Research, prospecting and multichannel execution to generate sales opportunities in a structured, measurable and consistent way.')}</p></div>
<div class="meta">${row(t('Preparada para', 'Prepared for'), clLogo ? `<img class="cl-${esc(lc.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : esc(empresa)).replace('<span>', '<span style="display:flex;align-items:center;gap:14px">')}
${row(t('Contacto', 'Contact'), contacto ? esc(contacto) + (correo ? ' · ' + esc(correo) : '') : '—')}
${row(t('Fecha de emisión', 'Issue date'), esc(hoy))}
${row(t('Validez de la propuesta', 'Proposal validity'), `${validez} ${t('días desde su emisión', 'days from issue')}`)}
${row(t('Presentada por', 'Presented by'), esc(marca))}</div></section>`;

  // ── 2 · objeto y alcance
  const incl = [t('Una oferta prioritaria', 'One priority offer'), t('Un ICP principal y un mercado inicial', 'One main ICP and one initial market'), t('Hasta dos cargos decisores', 'Up to two decision-maker roles'), t('LinkedIn y correo electrónico', 'LinkedIn and email'), t('Hasta dos enfoques relacionados', 'Up to two related approaches'), t('Estrategia, investigación, validación y mensajes', 'Strategy, research, validation and messaging'), t('Ejecución, seguimiento, CRM e informes', 'Execution, follow-up, CRM and reports'), t('Acceso al portal en vivo', 'Access to the live portal')];
  const excl = [t('Varias ofertas, mercados o ICP simultáneos', 'Several simultaneous offers, markets or ICPs'), t('Publicidad pagada o gestión de redes sociales', 'Paid advertising or social media management'), t('Producción de contenido', 'Content production'), t('Reuniones comerciales o demostraciones', 'Sales meetings or demos'), t('Presupuestos, negociación o cierre', 'Quotes, negotiation or closing'), t('Gestión posterior a la venta', 'Post-sale management'), t('Garantía de respuestas, reuniones o ventas', 'Guarantee of replies, meetings or sales'), t('Licencias, dominios o buzones externos específicos', 'Specific external licenses, domains or mailboxes')];
  const p2 = `<section class="page">${hdr}<div class="body">
<div class="cl"><h2><i>1.</i>${t('Objeto de la propuesta', 'Purpose of the proposal')}</h2>
<p>${t(`${esc(marca)} prestará a ${esc(empresa)} un servicio de adquisición comercial B2B: investigación del mercado, definición del cliente ideal, prospección multicanal y gestión de las respuestas, con seguimiento y optimización mensual. Esta propuesta describe el alcance, el método, las responsabilidades de cada parte y las condiciones económicas; al ser firmada por ambas partes se convierte en el acuerdo comercial que rige el servicio.`, `${esc(marca)} will provide ${esc(empresa)} with a B2B commercial acquisition service: market research, ideal customer definition, multichannel prospecting and reply management, with monthly follow-up and optimization. This proposal describes the scope, the method, each party’s responsibilities and the economic terms; once signed by both parties it becomes the commercial agreement governing the service.`)}</p></div>
<div class="cl"><h2><i>2.</i>${t('Alcance del servicio', 'Scope of the service')}</h2>
<div class="two"><div><div class="sub" style="margin-top:0">${t('Incluye', 'Includes')}</div><ul>${li(incl)}</ul></div><div><div class="sub" style="margin-top:0">${t('No incluye', 'Does not include')}</div><ul>${li(excl)}</ul></div></div>
<p class="note">${t('Los resultados dependerán también de la claridad de la propuesta de valor, la respuesta del mercado y la capacidad del cliente para atender las conversaciones.', 'Results will also depend on the clarity of the value proposition, the market response and the client’s ability to handle the conversations.')}</p></div>
<div class="cl"><h2><i>3.</i>${t('Responsabilidades de cada parte', 'Responsibilities of each party')}</h2>
<div class="two"><div><div class="sub" style="margin-top:0">${esc(marca)}</div><p style="margin-top:6px">${t('Estrategia, investigación, mensajes, configuración de secuencia, ejecución multicanal, seguimientos, clasificación de respuestas, reportes mensuales y optimización continua.', 'Strategy, research, messaging, sequence setup, multichannel execution, follow-ups, reply classification, monthly reporting and continuous optimization.')}</p></div>
<div><div class="sub" style="margin-top:0">${esc(empresa)}</div><ul>${li([t('Proporcionar información sobre servicios y proyectos.', 'Provide information about services and projects.'), t('Colaborar en la selección de la oferta.', 'Collaborate in selecting the offer.'), t('Facilitar accesos y aprobar el enfoque inicial.', 'Provide access and approve the initial approach.'), t('Responder oportunamente a las oportunidades.', 'Respond promptly to opportunities.'), t('Gestionar reuniones, propuestas, negociación y cierre.', 'Handle meetings, proposals, negotiation and closing.'), t('Comunicar el resultado de las conversaciones.', 'Report the outcome of the conversations.')])}</ul></div></div></div>
</div>${ft(2)}</section>`;

  // ── 3 · método y plazos
  const n4 = (n, h, d, r) => `<div><i>${n}</i><span><b>${h}</b><p>${d}</p></span><em><small>${t('Resultado', 'Outcome')}</small>${r}</em></div>`;
  const n6 = (h, d) => `<div><b>${h}</b>${d}</div>`;
  const p3 = `<section class="page">${hdr}<div class="body">
<div class="cl"><h2><i>4.</i>${t('Método y plazos', 'Method and timeline')}</h2>
<div class="ph3">
<div><small>${t('Semanas 1–2', 'Weeks 1–2')}</small><b>${t('Research comercial', 'Commercial research')}</b><p>${t('Validamos la oferta, el mercado y las cuentas antes de contactar a nadie.', 'We validate the offer, the market and the accounts before contacting anyone.')}</p></div>
<div><small>${t('Semanas 2–3', 'Weeks 2–3')}</small><b>${t('Inicio del contacto', 'Outreach start')}</b><p>${t('Lanzamos la secuencia de LinkedIn y correo de forma progresiva, con mensajes basados en lo que validamos.', 'We launch the LinkedIn and email sequence progressively, with messages based on what we validated.')}</p></div>
<div><small>${t('Semana 4 en adelante', 'Week 4 onward')}</small><b>${t('Optimización', 'Optimization')}</b><p>${t('Mejoramos mensajes, segmentos y decisores según las respuestas reales, con evidencia del mercado.', 'We improve messages, segments and decision-makers based on real replies, with market evidence.')}</p></div></div></div>
<div class="cl"><div class="sub" style="margin-top:0">${t('Fase 1 · Research comercial (semanas 1–2)', 'Phase 1 · Commercial research (weeks 1–2)')}</div>
<div class="n4">
${n4('01', t('Clarificamos la oferta', 'We clarify the offer'), t('Qué servicio impulsar y qué problema resuelve. Si no está clara, te sugerimos por dónde comenzar.', 'Which service to push and what problem it solves. If it is not clear yet, we suggest where to start.'), t('Oferta prioritaria e hipótesis comercial', 'Priority offer and commercial hypothesis'))}
${n4('02', t('Definimos a quién nos dirigimos', 'We define who we target'), t('Sector, tamaño, ubicación y señales de oportunidad, con criterios claros de inclusión y descarte.', 'Industry, size, location and opportunity signals, with clear inclusion and exclusion criteria.'), t('Perfil de cliente ideal (ICP)', 'Ideal customer profile (ICP)'))}
${n4('03', t('Dimensionamos el mercado', 'We size the market'), t('Validamos el universo real con TAM, SAM y SOM: cuántas empresas existen, cuántas encajan y cuántas podemos alcanzar.', 'We validate the real universe with TAM, SAM and SOM: how many companies exist, fit and are reachable.'), t('Universo de mercado validado', 'Validated market universe'))}
${n4('04', t('Investigamos cuentas y decisores', 'We research accounts and decision-makers'), t('Priorizamos empresas con encaje real, sin duplicados, e identificamos hasta dos cargos por empresa.', 'We prioritize companies with a real fit, without duplicates, and identify up to two roles per company.'), t('Base de cuentas y decisores', 'Account and decision-maker base'))}
</div></div>
<div class="cl"><div class="sub" style="margin-top:0">${t('Fase 2 · Cómo se trabaja cada cuenta', 'Phase 2 · How each account is worked')}</div>
<div class="n6">
${n6(t('1 · Preparación', '1 · Preparation'), t('Prospectos validados e incorporación progresiva, para no saturar a nadie.', 'Validated prospects and progressive onboarding, so nobody is overloaded.'))}
${n6(t('2 · Ejecución', '2 · Execution'), t('Contacto, seguimiento y registro de toda la actividad.', 'Outreach, follow-up and logging of all activity.'))}
${n6(t('3 · Contexto', '3 · Context'), t('Cuando hay una respuesta, las acciones pendientes se detienen y la conversación sigue con contexto.', 'When a reply arrives, pending actions stop and the conversation continues with context.'))}
${n6(t('4 · Clasificación', '4 · Classification'), t('Respuestas, objeciones, interés y descartes, ordenados.', 'Replies, objections, interest and disqualifications, organized.'))}
${n6(t('5 · Embudo', '5 · Pipeline'), t('Actualización de estado y cambio de decisor cuando hace falta.', 'Status update and decision-maker change when needed.'))}
${n6(t('6 · Entrega', '6 · Handover'), t('Oportunidades con historial completo y próxima acción definida.', 'Opportunities with full history and a defined next action.'))}
</div></div>
<div class="cl"><div class="sub" style="margin-top:0">${t('Optimización continua y revisión mensual', 'Continuous optimization and monthly review')}</div>
<p>${t('Supervisamos la campaña de forma continua: calidad de empresas, precisión de decisores, aceptaciones de LinkedIn, entregabilidad, respuestas, objeciones y rendimiento de mensajes. Cada mes se revisa y se decide: <b>continuar</b> (escalar el enfoque con mejores señales), <b>ajustar</b> (refinar oferta, mercado, decisor o mensaje) o <b>detener</b> (descartar una hipótesis con baja afinidad).', 'We supervise the campaign continuously: company quality, decision-maker accuracy, LinkedIn acceptances, deliverability, replies, objections and message performance. Every month we review and decide: <b>continue</b> (scale the approach with the best signals), <b>adjust</b> (refine the offer, market, decision-maker or message) or <b>stop</b> (drop a hypothesis with low fit).')}</p></div>
</div>${ft(3)}</section>`;

  // ── 4 · entregables
  const ent = [t('Oferta prioritaria evaluada e hipótesis comercial.', 'Evaluated priority offer and commercial hypothesis.'), t('ICP documentado y criterios de inclusión y descarte.', 'Documented ICP and inclusion and exclusion criteria.'), t('Universo de mercado validado (TAM, SAM y SOM).', 'Validated market universe (TAM, SAM and SOM).'), t('Base de cuentas investigadas y decisores identificados.', 'Base of researched accounts and identified decision-makers.'), t('Secuencia multicanal y hasta dos enfoques comerciales.', 'Multichannel sequence and up to two commercial approaches.'), t('Historial de actividad, respuestas y objeciones.', 'History of activity, replies and objections.'), t('Embudo organizado y acceso al portal en vivo.', 'Organized pipeline and access to the live portal.'), t('Informes mensuales de actividad comercial.', 'Monthly commercial activity reports.'), t('Guía comercial inicial y recomendaciones.', 'Initial playbook and commercial recommendations.')];
  const p4 = `<section class="page">${hdr}<div class="body">
<div class="cl"><h2><i>5.</i>${t('Entregables', 'Deliverables')}</h2>
<div class="dl">${ent.map((x, i) => `<div><i>${String(i + 1).padStart(2, '0')}</i><span>${x}</span></div>`).join('')}</div>
<p class="note">${t('El acceso al portal en vivo está disponible desde la semana 1. Recomendamos interpretar las métricas entre las semanas 4 y 6.', 'Access to the live portal is available from week 1. We recommend reading the metrics between weeks 4 and 6.')}</p></div>
<div class="cl"><h2><i>6.</i>${t('Inversión y condiciones de pago', 'Investment and payment terms')}</h2>
<div class="tb">
${row(t('Tarifa mensual', 'Monthly fee'), `<b>${feeTxt}</b> ${t('por mes', 'per month')}`)}
${row(t('Plazo', 'Term'), `${meses} ${meses === 1 ? t('mes', 'month') : t('meses', 'months')}`)}
${row(t('Total del plazo', 'Total for the term'), `<b>${totalTxt}</b> (${feeTxt} × ${meses})`)}
${row(t('Modelo de compensación', 'Compensation model'), modelo)}
${row(t('Comisión', 'Commission'), com > 0 ? `<b>${comTxt}</b> ${t('sobre', 'on')} ${comBase}` : t('0 % · no hay comisión por ventas', '0% · no sales commission'))}
${row(t('Forma y fecha de pago', 'Payment method and date'), notaPago)}
${row(t('Inicio del servicio', 'Service start'), inicio)}
</div>
<p class="note">${com > 0 ? t(`La comisión de ${comTxt} se calcula sobre ${comBase}, y se paga una vez que el cliente cobra la venta. Se suma a la tarifa mensual y no la reemplaza. `, `The ${comTxt} commission is calculated on ${comBase}, and is paid once the client collects the sale. It is added to the monthly fee and does not replace it. `) : ''}${t('Los montos no incluyen impuestos aplicables ni costos de herramientas, licencias, dominios o buzones de terceros.', 'Amounts do not include applicable taxes or the cost of third-party tools, licenses, domains or mailboxes.')}</p></div>
</div>${ft(4)}</section>`;

  // ── 5 · condiciones generales
  const c = (n, h, tx) => `<div class="cl"><h2><i>${n}</i>${h}</h2><p>${tx}</p></div>`;
  const p5 = `<section class="page">${hdr}<div class="body">
${c('7.', t('Vigencia y terminación', 'Term and termination'), t(`El acuerdo rige desde la fecha de firma y durante el plazo indicado en la cláusula 6 (${meses} ${meses === 1 ? 'mes' : 'meses'}). Al terminar el plazo, las partes podrán renovarlo por escrito. Cualquiera de las partes puede terminarlo con un preaviso escrito de ${preaviso} días; se pagará el servicio prestado hasta la fecha efectiva de terminación.`, `The agreement applies from the signing date and for the term set out in clause 6 (${meses} ${meses === 1 ? 'month' : 'months'}). At the end of the term the parties may renew it in writing. Either party may terminate it with ${preaviso} days’ written notice; the service provided up to the effective termination date shall be paid.`))}
${c('8.', t('Sin garantía de resultados', 'No guarantee of results'), t('La prospección B2B depende del mercado, de la oferta y de la capacidad del cliente para atender las conversaciones. NovaCentrax se compromete a ejecutar el servicio con diligencia y método, pero no garantiza un número de respuestas, reuniones ni ventas.'.replace('NovaCentrax', esc(marca)), 'B2B prospecting depends on the market, the offer and the client’s ability to handle the conversations. NovaCentrax commits to deliver the service with diligence and method, but does not guarantee a number of replies, meetings or sales.'.replace('NovaCentrax', esc(marca))))}
${c('9.', t('Confidencialidad', 'Confidentiality'), t('Cada parte mantendrá en reserva la información no pública de la otra a la que acceda por este acuerdo (incluidas listas de cuentas, mensajes, métricas y precios) y solo la usará para ejecutar el servicio. Esta obligación continúa después de terminado el acuerdo.', 'Each party shall keep confidential the other’s non-public information accessed under this agreement (including account lists, messages, metrics and prices) and use it only to perform the service. This obligation continues after the agreement ends.'))}
${c('10.', t('Propiedad de los entregables', 'Ownership of deliverables'), t('Una vez pagado el servicio, el cliente puede usar los entregables descritos en la cláusula 5 (ICP, base de cuentas, secuencias, mensajes e informes) para su propio negocio. Las metodologías, plantillas, herramientas y el portal de NovaCentrax siguen siendo de NovaCentrax.'.replace(/NovaCentrax/g, esc(marca)), 'Once the service is paid, the client may use the deliverables described in clause 5 (ICP, account base, sequences, messages and reports) for its own business. NovaCentrax’s methodologies, templates, tools and portal remain NovaCentrax’s property.'.replace(/NovaCentrax/g, esc(marca))))}
${c('11.', t('Datos personales', 'Personal data'), t('Las partes tratarán los datos personales de los contactos comerciales conforme a la normativa aplicable y solo para la prospección B2B objeto de este acuerdo, respetando las solicitudes de baja o de no contacto.', 'The parties shall process the personal data of business contacts in accordance with applicable law and only for the B2B prospecting covered by this agreement, honoring opt-out and do-not-contact requests.'))}
${c('12.', t('Comunicaciones', 'Communications'), t(`Las comunicaciones se harán por correo electrónico a los contactos indicados en la portada${correo ? ` (${esc(correo)})` : ''} y a los que cada parte informe por escrito.`, `Communications shall be made by email to the contacts shown on the cover${correo ? ` (${esc(correo)})` : ''} and to those each party notifies in writing.`))}
${c('13.', t('Ley aplicable', 'Governing law'), t(`Este acuerdo se rige por las leyes de ${esc(jur)}. Las partes procurarán resolver amistosamente cualquier diferencia antes de acudir a las instancias que correspondan.`, `This agreement is governed by the laws of ${esc(jur)}. The parties shall seek to resolve any dispute amicably before resorting to the competent bodies.`))}
</div>${ft(5)}</section>`;

  // ── 6 · aceptación y firma
  const nombreMarca = String(prm.firmante || '').trim(), cargoMarca = String(prm.firmanteCargo || '').trim();
  const p6 = `<section class="page">${hdr}<div class="body">
<div class="cl"><h2><i>14.</i>${t('Aceptación del acuerdo', 'Acceptance of the agreement')}</h2>
<p>${t(`Con su firma, ${esc(empresa)} y ${esc(marca)} aceptan esta propuesta y las condiciones que contiene como el acuerdo comercial que rige el servicio.`, `By signing, ${esc(empresa)} and ${esc(marca)} accept this proposal and the conditions it contains as the commercial agreement governing the service.`)}</p></div>
<div class="sum"><div class="tb">
${row(t('Servicio', 'Service'), t('Sistema de adquisición comercial B2B', 'B2B commercial acquisition system'))}
${row(t('Cliente', 'Client'), esc(empresa))}
${row(t('Tarifa mensual', 'Monthly fee'), `<b>${feeTxt}</b> · ${modelo}`)}
${row(t('Comisión', 'Commission'), com > 0 ? `<b>${comTxt}</b> ${t('sobre', 'on')} ${comBase}` : t('0 %', '0%'))}
${row(t('Plazo y total', 'Term and total'), `${meses} ${meses === 1 ? t('mes', 'month') : t('meses', 'months')} · <b>${totalTxt}</b>`)}
${row(t('Inicio', 'Start'), inicio)}
${row(t('Validez de la propuesta', 'Proposal validity'), `${validez} ${t('días desde el', 'days from')} ${esc(hoy)}`)}
</div></div>
<div class="sig">
<div><h3>${t('Por el cliente', 'For the client')}</h3><div class="who">${esc(empresa)}</div>
<div class="row">${t('Nombre', 'Name')}<b>${esc(contacto)}</b></div><div class="row">${t('Cargo', 'Title')}<b>${esc(prm.clienteCargo || '')}</b></div>
<div class="row firma">${t('Firma', 'Signature')}<b></b></div><div class="row">${t('Fecha y lugar', 'Date and place')}<b></b></div></div>
<div><h3>${t('Por la agencia', 'For the agency')}</h3><div class="who">${esc(marca)}</div>
<div class="row">${t('Nombre', 'Name')}<b>${esc(nombreMarca)}</b></div><div class="row">${t('Cargo', 'Title')}<b>${esc(cargoMarca)}</b></div>
<div class="row firma">${t('Firma', 'Signature')}<b></b></div><div class="row">${t('Fecha y lugar', 'Date and place')}<b></b></div></div>
</div>
<p class="note" style="margin-top:34px">${t('Se firma en dos ejemplares o en formato electrónico. Una copia firmada, escaneada o enviada por correo tiene el mismo efecto entre las partes.', 'Signed in two copies or electronically. A signed copy, scanned or sent by email, has the same effect between the parties.')}</p>
</div>${ft(6)}</section>`;

  const title = `${marca} · ${t('Propuesta y acuerdo comercial', 'Commercial proposal and agreement')} · ${empresa}`;
  const root = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light}}`;
  return `<!DOCTYPE html>\n<html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${root}${CSS}</style></head><body>${p1}${p2}${p3}${p4}${p5}${p6}</body></html>`;
}

module.exports = { render };
