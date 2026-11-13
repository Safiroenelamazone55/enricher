'use strict';
// «Propuesta y acuerdo comercial»: documento formal en hojas A4 (para imprimir o guardar como PDF y firmar), con la MISMA información
// de la propuesta post-llamada de ese cliente (lo conversado, método, alcance, responsabilidades, inversión) pero maquetada como documento:
// cláusulas numeradas, tablas, sin fotos, solo el color de la marca, y una hoja de firma. Idiomas: es · en · pt · it.
const dv = require('./devProposalTemplate');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'Inter','Segoe UI',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#E7EBF1;padding:24px 0}
.page{position:relative;width:794px;height:1123px;margin:0 auto 24px;background:#fff;overflow:hidden;box-shadow:0 10px 40px rgba(15,23,42,.18);break-after:page;page-break-after:always}
.page:last-of-type{margin-bottom:0;break-after:auto;page-break-after:auto}
.hd{position:absolute;left:64px;right:64px;top:36px;display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:2px solid var(--navy)}
.hd img{height:26px;display:block}.hd .wm{font-weight:800;font-size:16px;letter-spacing:-.02em;color:var(--navy)}
.hd .r{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);text-align:right;line-height:1.5}
.ft{position:absolute;left:64px;right:64px;bottom:30px;display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--line);font-size:9.5px;color:var(--mute)}
.body{position:absolute;left:64px;right:64px;top:96px;bottom:74px;display:flex;flex-direction:column;gap:20px}
.body>*{flex:0 0 auto}
#flow{width:794px;margin:0 auto;background:#fff;padding:24px 64px;display:flex;flex-direction:column;gap:20px}
h2{display:flex;gap:10px;align-items:baseline;font-size:15px;font-weight:800;letter-spacing:-.01em;color:var(--navy);padding-bottom:6px;border-bottom:1px solid var(--line)}
h2 i{font-style:normal;color:var(--teal);font-weight:800;font-size:13px}
p,li{font-size:12px;line-height:1.62;color:var(--text)}
p+p{margin-top:6px}
.sec>p,.sec>ul,.sec>table,.sec>.two,.sec>.note{margin-top:9px}
.sec>h2+*{margin-top:10px}
ul{list-style:none}
li{position:relative;padding:2.5px 0 2.5px 14px}
li:before{content:"";position:absolute;left:2px;top:10px;width:4px;height:4px;border-radius:50%;background:var(--teal)}
table.kv{width:100%;border-collapse:collapse}
table.kv td{padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;line-height:1.5;vertical-align:top;color:var(--text)}
table.kv td:first-child{width:170px;padding-right:14px;font-weight:700;color:var(--navy)}
table.kv td b{color:var(--ink)}
table.kv.num td:last-child{text-align:right;white-space:nowrap}
.two{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.two h3{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--teal);padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.two .box{padding:14px 16px;background:var(--soft);border-left:3px solid var(--teal)}
.two .box h3{border:0;padding-bottom:2px}
.note{font-size:10.5px;line-height:1.55;color:var(--mute)}
.q{margin-top:10px;padding:10px 14px;border-left:3px solid var(--teal);background:var(--soft);font-size:12px;font-style:italic;color:var(--navy)}
.steps{width:100%;border-collapse:collapse}
.steps td{padding:9px 0;border-bottom:1px solid var(--line);vertical-align:top;font-size:12px;line-height:1.5}
.steps td.n{width:34px;font-weight:800;color:var(--teal)}.steps td.w{width:130px;text-align:right;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
.steps b{display:block;color:var(--navy);margin-bottom:2px}
/* portada */
.cv{position:absolute;left:64px;right:64px;top:230px}
.cv .k{font-size:10.5px;font-weight:800;letter-spacing:.3em;text-transform:uppercase;color:var(--teal)}
.cv h1{margin-top:18px;font-size:44px;line-height:1.06;font-weight:800;letter-spacing:-.04em;color:var(--navy);max-width:640px}
.cv h1 em{font-style:normal;color:var(--teal)}
.cv .ln{margin-top:28px;height:3px;width:64px;background:var(--teal)}
.cv .for{margin-top:22px;font-size:16px;color:var(--text)}.cv .for b{color:var(--ink)}
.meta{position:absolute;left:64px;right:64px;bottom:110px;border-top:2px solid var(--navy)}
.meta>div{display:grid;grid-template-columns:170px 1fr;gap:14px;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px}
.meta b{font-weight:700;color:var(--mute);font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding-top:2px}
.meta span{color:var(--ink);font-weight:500}.meta img{height:34px;max-width:170px;object-fit:contain}
/* firma */
.sig{display:grid;grid-template-columns:1fr 1fr;gap:34px}
.sig h3{font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--teal)}
.sig .who{margin-top:6px;font-size:14px;font-weight:800;color:var(--navy);min-height:20px}
.sig .cg{font-size:11.5px;color:var(--text);min-height:17px}
.sig .ln{margin-top:64px;border-bottom:1.5px solid var(--ink);position:relative;height:1px}
.sig .ln.s{margin-top:34px}
.sig .ln img{position:absolute;left:4px;bottom:3px;max-height:60px;max-width:220px;object-fit:contain}
.sig .cap{margin-top:5px;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
@page{size:210mm 297mm;margin:0}
@media print{body{background:#fff;padding:0}.page{width:210mm;height:296.6mm;margin:0;box-shadow:none}}
`;

function render(brand, p, langIn) {
  const lang = dv.LANGS[langIn] ? langIn : 'es';
  const x = (es, en, pt, it) => (lang === 'en' ? en : lang === 'pt' ? pt : lang === 'it' ? it : es);
  const F = (n, dec) => dv.fmt(n, dec, lang);
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'NovaCentrax', mail = b.email || '';
  const web = (b.web || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const d = p.dev || dv.cleanDev({});
  const v = dv.validate(p), c = v.c, debil = v.debil;
  const empresa = String(p.empresa || '').trim() || x('Cliente', 'Client', 'Cliente', 'Cliente'), contacto = String(p.contacto || '').trim(), cargo = String(p.clienteCargo || '').trim();
  const sym = p.moneda || 'US$';
  const m$ = n => sym + F(n, 0);
  const m$d = n => sym + F(n, Math.abs(n - Math.round(n)) < 1e-9 ? 0 : 2);
  const fecha = d.fecha_propuesta || new Date().toISOString().slice(0, 10), validez = d.validez_dias || 10;
  const hasta = dv.fechaLarga(dv.sumDays(fecha, validez), lang), fechaTxt = dv.fechaLarga(fecha, lang);
  const piloto = d.precio_piloto || 500, mensual = d.precio_mensual || 750, obj = d.reuniones_objetivo || 3;
  const real = c.cierre_real, cierre = c.cierre_usado;
  const semanal = d.modalidad_pago === 'semanal', cuota = piloto / 4, nav = !!d.incluir_salesnav, wa = !!d.incluir_whatsapp;
  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (el, orden) => { for (const k of [el, ...orden]) if (imgOk(logos[k])) return logos[k]; return ''; };
  const logoC = pick(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const brandH = logoC ? `<img alt="${esc(marca)}" src="${logoC}">` : `<span class="wm">${esc(marca)}</span>`;
  const clLogo = p.logoCliente && typeof p.logoCliente === 'object' && imgOk(p.logoCliente[p.logoCliente.usar]) ? p.logoCliente[p.logoCliente.usar] : '';
  const canales = wa ? x('LinkedIn, correo y WhatsApp', 'LinkedIn, email and WhatsApp', 'LinkedIn, e-mail e WhatsApp', 'LinkedIn, email e WhatsApp') : x('LinkedIn y correo electrónico', 'LinkedIn and email', 'LinkedIn e e-mail', 'LinkedIn ed email');
  const li_ = a => a.map(t => `<li>${esc(t)}</li>`).join('');
  const wk = (a, z) => `${x('Semanas', 'Weeks', 'Semanas', 'Settimane')} ${a}–${z}`;
  const wkFrom = n => x(`Desde la semana ${n}`, `From week ${n}`, `A partir da semana ${n}`, `Dalla settimana ${n}`);
  const sec = (n, t, inner) => `<div class="sec"><h2><i>${n}</i>${t}</h2>${inner}</div>`;
  const kv = rows => `<table class="kv">${rows.filter(Boolean).map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`;

  const pagoLargo = semanal
    ? x(`${m$(piloto)} repartidos en las 4 semanas del mes: ${m$d(cuota)} por semana, que se paga el viernes de la misma semana trabajada (semana trabajada, semana pagada).`,
      `${m$(piloto)} split across the 4 weeks of the month: ${m$d(cuota)} per week, paid on the Friday of the same week worked (week worked, week paid).`,
      `${m$(piloto)} divididos nas 4 semanas do mês: ${m$d(cuota)} por semana, pago na sexta-feira da mesma semana trabalhada (semana trabalhada, semana paga).`,
      `${m$(piloto)} suddivisi nelle 4 settimane del mese: ${m$d(cuota)} a settimana, da pagare il venerdì della stessa settimana lavorata (settimana lavorata, settimana pagata).`)
    : x(`${m$(piloto)} en un solo pago, para comenzar.`, `${m$(piloto)} in a single payment, to get started.`, `${m$(piloto)} em um único pagamento, para começar.`, `${m$(piloto)} in un unico pagamento, per iniziare.`);
  const navTxt = x('LinkedIn Sales Navigator: US$50/mes con 60 % de descuento, se suma a la factura.', 'LinkedIn Sales Navigator: US$50/month at 60% off, added to the invoice.', 'LinkedIn Sales Navigator: US$50/mês com 60 % de desconto, somado à fatura.', 'LinkedIn Sales Navigator: US$50/mese con il 60 % di sconto, aggiunto alla fattura.');
  const payInfo = [b.pago_email, b.pago_telefono].filter(Boolean).join(' · ');
  const bonus = d.bonus_reunion == null ? 100 : d.bonus_reunion, umbral = F(d.umbral_bonus == null ? 3 : d.umbral_bonus, 0);

  // ── quién firma por la empresa: uno de los firmantes cargados en «Empresas y logos», todos, o uno escrito a mano
  const fl = Array.isArray(b.firmantes) ? b.firmantes : [], sel = String(d.firmantes_sel || '');
  let signers = [];
  if (sel === 'otro' || (!sel && d.firmante_nombre)) signers = [{ nombre: d.firmante_nombre, cargo: d.firmante_cargo, firma: '' }];
  else if (sel === 'all') signers = fl;
  else if (sel) signers = fl.filter(f => f.id === sel);
  if (!signers.length) signers = fl.length ? [fl[0]] : [{ nombre: '', cargo: '', firma: '' }];
  const sigBlock = (h, who, cg, img) => `<div><h3>${esc(h)}</h3><div class="who">${esc(who)}</div><div class="cg">${esc(cg)}</div><div class="ln">${img ? `<img alt="" src="${img}">` : ''}</div><div class="cap">${x('Firma', 'Signature', 'Assinatura', 'Firma')}</div><div class="ln s"></div><div class="cap">${x('Fecha', 'Date', 'Data', 'Data')}</div></div>`;

  let coverInner = ''; const flow = [];   // la portada es fija; el resto son secciones que se reparten por las hojas según lo que quepa
  const page = (inner, cover) => {
    if (cover) { coverInner = inner; return; }
    String(inner).split(/(?=<div class="sec">)/).map(s => s.trim()).filter(Boolean).forEach(pt => { if (pt.startsWith('<div class="sec">')) flow.push(pt); else if (flow.length) flow[flow.length - 1] += pt; });
  };

  // ── Portada
  page(`<div class="cv"><div class="k">${x('Propuesta y acuerdo comercial', 'Commercial proposal and agreement', 'Proposta e acordo comercial', 'Proposta e accordo commerciale')}</div>
<h1>${x('Piloto de adquisición <em>comercial B2B</em>', 'B2B <em>commercial acquisition</em> pilot', 'Piloto de aquisição <em>comercial B2B</em>', 'Progetto pilota di acquisizione <em>commerciale B2B</em>')}</h1>
<div class="ln"></div><p class="for">${x('Preparado para', 'Prepared for', 'Preparado para', 'Preparato per')} <b>${esc(empresa)}</b></p></div>
<div class="meta">
<div><b>${x('Cliente', 'Client', 'Cliente', 'Cliente')}</b><span>${clLogo ? `<img alt="${esc(empresa)}" src="${clLogo}">` : esc(empresa)}</span></div>
${contacto ? `<div><b>${x('Contacto', 'Contact', 'Contato', 'Contatto')}</b><span>${esc(contacto)}${cargo ? ', ' + esc(cargo) : ''}</span></div>` : ''}
<div><b>${x('Preparado por', 'Prepared by', 'Preparado por', 'Preparato da')}</b><span>${esc(marca)}</span></div>
<div><b>${x('Fecha', 'Date', 'Data', 'Data')}</b><span>${esc(fechaTxt)}</span></div>
<div><b>${x('Válida hasta', 'Valid until', 'Válida até', 'Valida fino al')}</b><span>${esc(hasta)}</span></div>
</div>`, true);

  // ── 1 · lo conversado, 2 · objeto, 3 · cómo trabajamos
  const hayV = !!d.valor_cliente, valCli = hayV ? m$(d.valor_cliente) : '—';
  const icp = String(d.cliente_ideal || '').trim() === dv.ICP_DEFAULT.es ? dv.ICP_DEFAULT[lang] : d.cliente_ideal;
  const cierran = d.cierre_sin_dato || d.cierre_pct == null ? '' : x('; de cada 10 cierran ', '; out of every 10, ', '; de cada 10, fecham ', '; su 10 ne chiudono ') + F(cierre / 10, cierre % 10 ? 1 : 0) + (lang === 'en' ? ' close' : '');
  const hoy = d.reuniones_mes_hoy == null
    ? x('Reuniones nuevas al mes: sin dato previo.', 'New meetings per month: no prior data.', 'Novas reuniões por mês: sem dado prévio.', 'Nuovi incontri al mese: nessun dato precedente.')
    : x(`Consigue ${F(d.reuniones_mes_hoy, 0)} reunión(es) nueva(s) al mes${cierran}.`, `Gets ${F(d.reuniones_mes_hoy, 0)} new meeting(s) per month${cierran}.`, `Consegue ${F(d.reuniones_mes_hoy, 0)} nova(s) reunião(ões) por mês${cierran}.`, `Ottiene ${F(d.reuniones_mes_hoy, 0)} nuovo/i incontro/i al mese${cierran}.`);
  const ciclo = d.ciclo_dias ? x(`${d.ciclo_dias} días para firmar`, `${d.ciclo_dias} days to sign`, `${d.ciclo_dias} dias para fechar`, `${d.ciclo_dias} giorni per firmare`) : x('ciclo de venta estimado entre 30 y 60 días', 'sales cycle estimated at 30 to 60 days', 'ciclo de vendas estimado entre 30 e 60 dias', 'ciclo di vendita stimato tra 30 e 60 giorni');
  const decide = (d.decision_quien || d.decision_plazo) ? ' ' + x('Decide ', 'Decision made by ', 'Decide ', 'Decide ') + esc([d.decision_quien, d.decision_plazo ? x('en ', 'within ', 'em ', 'entro ') + d.decision_plazo : ''].filter(Boolean).join(' ')) + '.' : '';
  const q = d.dolor_cliente ? `<div class="q">«${esc(String(d.dolor_cliente).replace(/^["«»“”]+|["«»“”]+$/g, ''))}»</div>` : '';
  const refs = (Array.isArray(p.referencias) ? p.referencias : []).filter(r => r && r.nombre).slice(0, 3);
  const refLine = refs.length ? `<p class="note">${x('Ya lo hicimos para:', 'We have already done this for:', 'Já fizemos isso para:', 'Lo abbiamo già fatto per:')} ${refs.map(r => esc(r.nombre) + (r.descripcion ? ' · ' + esc(String(r.descripcion).slice(0, 90)) : '')).join(' · ')}${d.resultados_referencia ? ' — ' + esc(d.resultados_referencia) : ''}</p>` : '';
  const etapas = [
    [x('Investigamos', 'We research', 'Pesquisamos', 'Analizziamo'), x('Averiguamos cuántas empresas hay, a cuáles llegamos y quién decide en cada una, antes de escribir a nadie.', 'We find out how many companies there are, which ones we can reach and who decides at each, before writing to anyone.', 'Descobrimos quantas empresas existem, a quais chegamos e quem decide em cada uma, antes de escrever a alguém.', 'Verifichiamo quante aziende ci sono, quali raggiungiamo e chi decide in ciascuna, prima di scrivere a qualcuno.'), wk(1, 2)],
    [x('Empezamos a contactar', 'We start reaching out', 'Começamos a entrar em contato', 'Iniziamo a contattare'), x('Les escribimos por LinkedIn y correo, hablándoles de lo que de verdad les importa.', 'We write to them on LinkedIn and by email, talking about what really matters to them.', 'Escrevemos por LinkedIn e e-mail, falando do que realmente importa para eles.', 'Scriviamo su LinkedIn e via email, parlando di ciò che a loro interessa davvero.'), wk(2, 3)],
    [x('Mejoramos cada mes', 'We improve every month', 'Melhoramos a cada mês', 'Miglioriamo ogni mese'), x('Vemos qué respuestas llegan y mejoramos los mensajes y las empresas a las que escribimos.', 'We look at which replies come in and improve the messages and the companies we write to.', 'Vemos quais respostas chegam e melhoramos as mensagens e as empresas para as quais escrevemos.', 'Vediamo quali risposte arrivano e miglioriamo i messaggi e le aziende a cui scriviamo.'), wkFrom(4)]];
  page(`${sec('1', x('Resumen de lo conversado', 'Summary of our conversation', 'Resumo da nossa conversa', 'Riepilogo di quanto discusso'), kv([
      [x('Qué vende', 'What you sell', 'O que vende', 'Cosa vende'), esc(d.oferta_cliente) || '—'],
      [x('A quién quiere venderle', 'Who you want to sell to', 'Para quem quer vender', 'A chi vuole vendere'), esc(icp) || '—'],
      [x('Dónde está hoy', 'Where you are today', 'Onde está hoje', 'Dove si trova oggi'), esc(hoy)],
      [x('Lo que vale cerrar', 'What a close is worth', 'Quanto vale fechar', 'Quanto vale chiudere'), x(`Cada cliente nuevo le deja ${esc(valCli)}; ${esc(ciclo)}.`, `Each new client brings ${esc(valCli)}; ${esc(ciclo)}.`, `Cada novo cliente rende ${esc(valCli)}; ${esc(ciclo)}.`, `Ogni nuovo cliente porta ${esc(valCli)}; ${esc(ciclo)}.`) + decide]]) + q)}
${sec('2', x('Objeto del acuerdo', 'Purpose of the agreement', 'Objeto do acordo', 'Oggetto dell\'accordo'), `<p>${x(`${esc(marca)} prestará a ${esc(empresa)} un piloto de 30 días de adquisición comercial B2B (investigación del mercado, contacto por ${esc(canales)}, seguimiento de las respuestas y mejora continua), en los términos de este documento.`, `${esc(marca)} will provide ${esc(empresa)} with a 30-day B2B commercial acquisition pilot (market research, outreach via ${esc(canales)}, reply follow-up and continuous improvement), under the terms of this document.`, `A ${esc(marca)} prestará à ${esc(empresa)} um piloto de 30 dias de aquisição comercial B2B (pesquisa de mercado, contato por ${esc(canales)}, acompanhamento das respostas e melhoria contínua), nos termos deste documento.`, `${esc(marca)} fornirà a ${esc(empresa)} un progetto pilota di 30 giorni di acquisizione commerciale B2B (ricerca di mercato, contatto tramite ${esc(canales)}, follow-up delle risposte e miglioramento continuo), nei termini di questo documento.`)}</p>`)}
${sec('3', x('Cómo trabajamos', 'How we work', 'Como trabalhamos', 'Come lavoriamo'), `<table class="steps">${etapas.map((e, i) => `<tr><td class="n">0${i + 1}</td><td><b>${esc(e[0])}</b>${esc(e[1])}</td><td class="w">${esc(e[2])}</td></tr>`).join('')}</table>${refLine}`)}`);

  // ── 4 · alcance, 5 · responsabilidades
  const inc = [x('Un solo producto o servicio para empujar', 'A single product or service to push', 'Um único produto ou serviço para promover', 'Un solo prodotto o servizio da promuovere'), x('Un tipo de cliente y un mercado para empezar', 'One type of client and one market to start', 'Um tipo de cliente e um mercado para começar', 'Un tipo di cliente e un mercato per iniziare'), x('Hasta dos cargos de decisión por empresa', 'Up to two decision-maker roles per company', 'Até dois cargos de decisão por empresa', 'Fino a due ruoli decisionali per azienda'), canales, x('Investigación, mensajes y seguimiento de las respuestas', 'Research, messages and follow-up of replies', 'Pesquisa, mensagens e acompanhamento das respostas', 'Ricerca, messaggi e follow-up delle risposte'), x('Reuniones cualificadas con quien decide, medidas y reportadas cada mes', 'Qualified meetings with the decision-maker, measured and reported every month', 'Reuniões qualificadas com quem decide, medidas e reportadas a cada mês', 'Incontri qualificati con chi decide, misurati e riportati ogni mese'), x('Informe mensual y acceso al portal de seguimiento en vivo', 'Monthly report and live tracking portal access', 'Relatório mensal e acesso ao portal de acompanhamento ao vivo', 'Report mensile e accesso al portale di monitoraggio in tempo reale')];
  const exc = [x('Varios productos, mercados o tipos de cliente a la vez', 'Several products, markets or client types at once', 'Vários produtos, mercados ou tipos de cliente ao mesmo tempo', 'Più prodotti, mercati o tipi di cliente contemporaneamente'), x('Publicidad pagada o redes sociales', 'Paid advertising or social media', 'Publicidade paga ou redes sociais', 'Pubblicità a pagamento o social media'), x('Atender las reuniones, mandar presupuestos o cerrar la venta', 'Attending the meetings, sending quotes or closing the sale', 'Atender as reuniões, enviar orçamentos ou fechar a venda', 'Gestire gli incontri, inviare preventivi o chiudere la vendita'), x('Gestión después de la venta', 'Post-sale management', 'Gestão após a venda', 'Gestione post-vendita'), wa ? x('Licencias, dominios o buzones específicos del cliente', 'Licenses, domains or mailboxes specific to the client', 'Licenças, domínios ou caixas de e-mail específicos do cliente', 'Licenze, domini o caselle specifiche del cliente') : x('WhatsApp (se puede añadir si lo necesitas)', 'WhatsApp (can be added if you need it)', 'WhatsApp (pode ser adicionado se você precisar)', 'WhatsApp (si può aggiungere se serve)'), x('Garantía de respuestas, reuniones o ventas', 'Guarantee of replies, meetings or sales', 'Garantia de respostas, reuniões ou vendas', 'Garanzia di risposte, incontri o vendite')];
  const tu = [x('Nos cuentas qué ofreces y apruebas el primer enfoque.', 'You tell us what you offer and approve the first approach.', 'Você nos conta o que oferece e aprova a primeira abordagem.', 'Ci racconti cosa offri e approvi il primo approccio.'), x('Nos das los accesos que haga falta.', 'You give us the access we need.', 'Você nos dá os acessos necessários.', 'Ci dai gli accessi necessari.'), x('Respondes a las reuniones en menos de 48 horas.', 'You reply to meeting requests within 48 hours.', 'Você responde às reuniões em menos de 48 horas.', 'Rispondi agli incontri entro 48 ore.'), x('Llevas las reuniones, las propuestas y el cierre.', 'You handle the meetings, proposals and closing.', 'Você conduz as reuniões, as propostas e o fechamento.', 'Gestisci gli incontri, le proposte e la chiusura.'), x('Nos cuentas cómo fueron las conversaciones.', 'You tell us how the conversations went.', 'Você nos conta como foram as conversas.', 'Ci racconti come sono andate le conversazioni.')];
  const nosotros = x('Investigamos, escribimos los mensajes, contactamos por los canales acordados, damos seguimiento a las respuestas, te pasamos las reuniones cualificadas y te enviamos un informe cada mes. Mejoramos todo con lo que vamos viendo.', 'We research, write the messages, reach out through the agreed channels, follow up on replies, hand you the qualified meetings and send you a report every month. We improve everything based on what we see.', 'Pesquisamos, escrevemos as mensagens, entramos em contato pelos canais combinados, acompanhamos as respostas, passamos a você as reuniões qualificadas e enviamos um relatório a cada mês. Melhoramos tudo com o que vamos vendo.', 'Analizziamo, scriviamo i messaggi, contattiamo tramite i canali concordati, seguiamo le risposte, ti passiamo gli incontri qualificati e ti inviamo un report ogni mese. Miglioriamo tutto in base a ciò che osserviamo.');
  page(`${sec('4', x('Alcance del servicio', 'Scope of the service', 'Escopo do serviço', 'Ambito del servizio'), `<div class="two"><div><h3>${x('Incluye', 'Included', 'Inclui', 'Incluso')}</h3><ul>${li_(inc)}</ul></div><div><h3>${x('No incluye', 'Not included', 'Não inclui', 'Non incluso')}</h3><ul>${li_(exc)}</ul></div></div>`)}
${sec('5', x('Responsabilidades de cada parte', 'Responsibilities of each party', 'Responsabilidades de cada parte', 'Responsabilità di ciascuna parte'), `<div class="two"><div class="box"><h3>${esc(marca)}</h3><p>${esc(nosotros)}</p></div><div class="box"><h3>${esc(empresa)}</h3><ul>${li_(tu)}</ul></div></div>`)}`);

  // ── 6 · inversión y forma de pago, 7 · objetivo, 8 · vigencia
  const cal = semanal ? `<table class="kv num">${[1, 2, 3, 4].map(n => `<tr><td>${x('Semana', 'Week', 'Semana', 'Settimana')} ${n}</td><td>${x('Viernes de la semana ' + n, 'Friday of week ' + n, 'Sexta-feira da semana ' + n, 'Venerdì della settimana ' + n)}</td><td>${esc(m$d(cuota))}</td></tr>`).join('').replace(/<td>([^<]*)<\/td><td>([^<]*)<\/td><td>/g, '<td>$1</td><td style="text-align:left;font-weight:400;color:var(--text)">$2</td><td>')}</table>` : '';
  page(`${sec('6', x('Inversión y forma de pago', 'Investment and payment', 'Investimento e forma de pagamento', 'Investimento e modalità di pagamento'), kv([
      [x('Piloto de 30 días', '30-day pilot', 'Piloto de 30 dias', 'Progetto pilota di 30 giorni'), `<b>${esc(m$(piloto))}</b>`],
      [x('Forma de pago', 'Payment method', 'Forma de pagamento', 'Modalità di pagamento'), esc(pagoLargo)],
      nav ? [x('Servicio opcional', 'Optional service', 'Serviço opcional', 'Servizio opzionale'), esc(navTxt)] : null,
      [x('Después del piloto', 'After the pilot', 'Depois do piloto', 'Dopo il progetto pilota'), debil ? x('Lo decidimos juntos, con los resultados a la vista.', 'We decide together, with the results in front of us.', 'Decidimos juntos, com os resultados à vista.', 'Decidiamo insieme, con i risultati sotto gli occhi.') : x(`${esc(m$(mensual))}/mes desde el mes 2, sin permanencia.`, `${esc(m$(mensual))}/month from month 2, no lock-in.`, `${esc(m$(mensual))}/mês a partir do mês 2, sem fidelidade.`, `${esc(m$(mensual))}/mese dal mese 2, senza vincoli.`)],
      debil ? null : ['Bonus', x(`${esc(m$(bonus))} por cada reunión cualificada por encima de ${umbral}. Sin otra comisión.`, `${esc(m$(bonus))} for each qualified meeting above ${umbral}. No other commission.`, `${esc(m$(bonus))} por cada reunião qualificada acima de ${umbral}. Sem outra comissão.`, `${esc(m$(bonus))} per ogni incontro qualificato oltre ${umbral}. Nessun'altra commissione.`)],
      payInfo ? [x('Datos de pago', 'Payment details', 'Dados de pagamento', 'Dati di pagamento'), esc(payInfo)] : null,
      [x('Inicio', 'Start', 'Início', 'Inizio'), p.inicio ? esc(p.inicio) : x('Se acuerda al firmar.', 'Agreed when signing.', 'Combinado ao assinar.', 'Concordato alla firma.')]]) + (semanal ? `<p class="note" style="margin-top:12px">${x('Calendario de pagos', 'Payment schedule', 'Calendário de pagamentos', 'Calendario dei pagamenti')}</p>${cal}` : ''))}
${sec('7', x('Objetivo del piloto', 'Pilot goal', 'Meta do piloto', 'Obiettivo del progetto pilota'), `<p>${x(`Unos 450 contactos; objetivo: ${F(obj, 0)} reuniones cualificadas. Si no llegamos a 2, repetimos el piloto sin coste.`, `About 450 contacts; goal: ${F(obj, 0)} qualified meetings. If we do not reach 2, we repeat the pilot at no cost.`, `Cerca de 450 contatos; meta: ${F(obj, 0)} reuniões qualificadas. Se não chegarmos a 2, repetimos o piloto sem custo.`, `Circa 450 contatti; obiettivo: ${F(obj, 0)} incontri qualificati. Se non arriviamo a 2, ripetiamo il progetto pilota senza costi.`)}</p>`)}
${sec('8', x('Vigencia', 'Validity', 'Vigência', 'Validità'), `<p>${x(`Esta propuesta es válida hasta el ${esc(hasta)}. Al firmar, las dos partes aceptan lo descrito en este documento: el alcance (4), las responsabilidades (5) y la inversión con su forma de pago (6).`, `This proposal is valid until ${esc(hasta)}. By signing, both parties accept what is described in this document: the scope (4), the responsibilities (5) and the investment with its payment method (6).`, `Esta proposta é válida até ${esc(hasta)}. Ao assinar, as duas partes aceitam o descrito neste documento: o escopo (4), as responsabilidades (5) e o investimento com a forma de pagamento (6).`, `Questa proposta è valida fino al ${esc(hasta)}. Firmando, le due parti accettano quanto descritto in questo documento: l'ambito (4), le responsabilità (5) e l'investimento con la modalità di pagamento (6).`)}</p>`)}`);

  // ── Anexo informativo: cuánto vale para el cliente (estimaciones, no promesa)
  const fg = dv.fuga(p), mg = (d.margen_pct || 100) / 100, valNeto = d.valor_cliente ? d.valor_cliente * mg : 0;
  const supuesto = x('supuesto', 'assumption', 'suposto', 'ipotesi');
  const alMes = x('al mes', 'per month', 'por mês', 'al mese'), alAnio = x('al año', 'per year', 'por ano', 'all\'anno');
  if (hayV || fg) {
    const ej = [2000, 4000, 8000, 15000].map(val => ({ val, k: dv.build(val, mg, cierre / 100, obj, mensual, piloto, null, real) }));
    const tA = hayV ? kv([
      [x('Reuniones nuevas al mes con nosotros', 'New meetings per month with us', 'Novas reuniões por mês conosco', 'Nuovi incontri al mese con noi'), `${F(obj, 0)} <span class="note">(${supuesto} · ${x('rango 2–5', 'range 2–5', 'faixa 2–5', 'intervallo 2–5')})</span>`],
      [x('De ellas, acaban en cliente', 'Of those, end up as a client', 'Delas, viram cliente', 'Di questi, diventano cliente'), `${F(cierre, 0)} %${real ? '' : ` <span class="note">(${supuesto} · ${x('rango 10–30 %', 'range 10–30%', 'faixa 10–30 %', 'intervallo 10–30 %')})</span>`}`],
      [x('Lo que vale un cliente nuevo', 'What a new client is worth', 'Quanto vale um novo cliente', 'Quanto vale un nuovo cliente'), esc(m$(valNeto))],
      [x('Ingreso nuevo estimado', 'Estimated new revenue', 'Nova receita estimada', 'Nuovo ricavo stimato'), `<b>${esc(m$(c.ingreso_mes))}</b> ${alMes} · ${esc(m$(c.ingreso_mes * 12))} ${alAnio}`]]) : '';
    const tB = fg ? kv([
      [x('Horas a la semana buscando clientes', 'Hours a week looking for clients', 'Horas por semana buscando clientes', 'Ore a settimana a cercare clienti'), `${F(fg.h)} h${fg.supH ? ` <span class="note">(${supuesto} · ${x('rango 10–25 h', 'range 10–25 h', 'faixa 10–25 h', 'intervallo 10–25 h')})</span>` : ''}`],
      [x('Lo que vale una hora', 'What an hour is worth', 'Quanto vale uma hora', 'Quanto vale un\'ora'), `${esc(m$(fg.v))}${fg.supV ? ` <span class="note">(${supuesto})</span>` : ''}`],
      [x('Coste de hacerlo a mano', 'Cost of doing it by hand', 'Custo de fazer à mão', 'Costo di farlo a mano'), `<b>${esc(m$(fg.coste_tiempo_mes))}</b> ${alMes} · ${esc(m$(fg.coste_tiempo_anio))} ${alAnio}`]]) : '';
    const tC = hayV ? `<table class="kv num"><tr><td>${x('Valor de un cliente nuevo', 'Value of a new client', 'Valor de um novo cliente', 'Valore di un nuovo cliente')}</td>${ej.map(e => `<td><b>${esc(m$(e.val))}</b></td>`).join('')}</tr>
<tr><td>${x('Ingreso nuevo al mes', 'New revenue per month', 'Nova receita por mês', 'Nuovo ricavo al mese')}</td>${ej.map(e => `<td>${esc(m$(e.k.ingreso_mes))}</td>`).join('')}</tr>
<tr><td>${x('Veces que cubre el piloto', 'Times it covers the pilot', 'Vezes que cobre o piloto', 'Volte che copre il progetto pilota')}</td>${ej.map(e => `<td>${F(e.k.veces_piloto)}</td>`).join('')}</tr></table>` : '';
    page(`${hayV ? sec('A', x('Lo que hoy deja de ganar', 'What you miss out on today', 'O que deixa de ganhar hoje', 'Quello che oggi non guadagna'), tA) : ''}
${fg ? sec(hayV ? 'B' : 'A', x('Lo que cuesta hacerlo a mano', 'What it costs to do it by hand', 'Quanto custa fazer à mão', 'Quanto costa farlo a mano'), tB) : ''}
${hayV ? sec(fg ? 'C' : 'B', x('Ejemplo con supuestos', 'Example with assumptions', 'Exemplo com suposições', 'Esempio con ipotesi'), tC) : ''}
<p class="note">${x('Anexo informativo. Los datos marcados «supuesto» son estimaciones nuestras; el resto es lo que el cliente nos dio. No es una promesa de resultado.', 'Informative annex. Figures marked “assumption” are our estimates; the rest is what the client gave us. Not a promise of results.', 'Anexo informativo. Os dados marcados como «suposto» são estimativas nossas; o resto é o que o cliente nos passou. Não é uma promessa de resultado.', 'Allegato informativo. I dati contrassegnati «ipotesi» sono nostre stime; il resto è quello che il cliente ci ha fornito. Non è una promessa di risultato.')}</p>`);
  }

  // ── Hoja de firma
  const hoyTxt = '';
  page(`${sec('9', x('Aceptación y firma', 'Acceptance and signature', 'Aceitação e assinatura', 'Accettazione e firma'), `<p>${x(`Las partes aceptan esta propuesta y acuerdo comercial, que incluye la modalidad de pago indicada en la cláusula 6${nav ? ' y el servicio opcional de LinkedIn Sales Navigator' : ''}.`, `The parties accept this commercial proposal and agreement, which includes the payment method set out in clause 6${nav ? ' and the optional LinkedIn Sales Navigator service' : ''}.`, `As partes aceitam esta proposta e acordo comercial, que inclui a forma de pagamento indicada na cláusula 6${nav ? ' e o serviço opcional de LinkedIn Sales Navigator' : ''}.`, `Le parti accettano questa proposta e accordo commerciale, che include la modalità di pagamento indicata nella clausola 6${nav ? ' e il servizio opzionale di LinkedIn Sales Navigator' : ''}.`)}</p>
<div class="sig" style="margin-top:34px;grid-template-columns:repeat(${signers.length + 1},1fr)">${signers.map(f => sigBlock(marca, f.nombre, f.cargo, imgOk(f.firma) ? f.firma : '')).join('')}${sigBlock(empresa, contacto, cargo, '')}</div>`)}`);

  const titulo = x('Propuesta y acuerdo comercial', 'Commercial proposal and agreement', 'Proposta e acordo comercial', 'Proposta e accordo commerciale');
  const hdr = `${brandH}<span class="r">${esc(titulo)}<br>${esc(empresa)}</span>`;
  const ftr = `<span>${x('Confidencial · preparada para ', 'Confidential · prepared for ', 'Confidencial · preparada para ', 'Riservato · preparata per ')}${esc(empresa)}</span><span class="pn"></span>`;
  const html = `<section class="page"><div class="hd">${brandH}<span class="r">${esc(titulo)}</span></div>${coverInner}<div class="ft">${ftr}</div></section>
<div id="flow">${flow.join('\n')}</div>
<template id="tpl-hd">${hdr}</template><template id="tpl-ft">${ftr}</template>`;
  const PAG = `(function(){var PG=${JSON.stringify(x('Página', 'Page', 'Página', 'Pagina'))};function run(){var flow=document.getElementById('flow');if(!flow)return;var secs=[].slice.call(flow.children),hd=document.getElementById('tpl-hd').innerHTML,ft=document.getElementById('tpl-ft').innerHTML;
function np(){var pg=document.createElement('section');pg.className='page';pg.innerHTML='<div class="hd">'+hd+'</div><div class="body"></div><div class="ft">'+ft+'</div>';flow.parentNode.insertBefore(pg,flow);return pg.querySelector('.body')}
var body=np();secs.forEach(function(s){body.appendChild(s);if(body.scrollHeight>body.clientHeight+1&&body.children.length>1){body.removeChild(s);body=np();body.appendChild(s)}});
flow.parentNode.removeChild(flow);var all=document.querySelectorAll('.page');[].forEach.call(all,function(p,i){var n=p.querySelector('.pn');if(n)n.textContent=PG+' '+(i+1)+' / '+all.length});
document.body.classList.add('ready');try{parent.postMessage({acuerdoH:document.documentElement.scrollHeight},'*')}catch(e){}}
(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(run);addEventListener('load',function(){setTimeout(function(){try{parent.postMessage({acuerdoH:document.documentElement.scrollHeight},'*')}catch(e){}},300)})})();`;
  const rootVars = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#7C8AA0;--line:#E2E8F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--tl-rgb:${rgb(light)};--pr-rgb:${rgb(prim)}}`;
  const title = dv.archivo(b, p, lang, { acuerdo: true });
  return `<!DOCTYPE html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${rootVars}${CSS}</style></head><body>
${html}
<script>${PAG}</script></body></html>`;
}

module.exports = { render };
