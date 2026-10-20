'use strict';
// Plantilla de propuesta comercial: genera un HTML autónomo (8 páginas A4) en ES / EN / DE / PT.
// Marca, colores y logos son parámetros; el HTML resultante no depende del sistema (se puede guardar, enviar o imprimir a PDF).
const fs = require('fs');
const path = require('path');

const CSS = require('./proposalCss');
const LANGS = { es: 'Español', en: 'English', de: 'Deutsch', pt: 'Português' };
const IDX = { es: 0, en: 1, de: 2, pt: 3 };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const logoOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);

function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// brand: {nombre,email,web,color_primary,color_light,color_dark,logo_white,logo_black,logo_color,logo_oscuro,logo_claro}
// p: {empresa,contacto,correo,fee,plazo,moneda,servicio,servicioEm,inicio}
function render(brand, p, lang) {
  const li = IDX[lang] != null ? IDX[lang] : 0;
  const x = (...a) => (a[li] != null ? a[li] : a[0]);
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'Mi empresa';
  const web = (b.web || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const mail = b.email || '';
  const empresa = p.empresa || 'Cliente';
  const contacto = p.contacto || '';
  const sym = p.moneda || 'US$';
  const fee = Math.max(0, parseInt(p.fee, 10) || 0);
  const meses = Math.max(1, parseInt(p.plazo, 10) || 3);
  const clLogo = p.logoCliente && typeof p.logoCliente === 'object' && logoOk(p.logoCliente[p.logoCliente.usar]) ? p.logoCliente[p.logoCliente.usar] : '';
  const feeNum = sym + money(fee);
  const modeloTxt = p.modelo ? esc(p.modelo) : x('Fee fijo + comisiones', 'Fixed fee + commissions', 'Fixhonorar + Provisionen', 'Fee fixo + comissões');
  const notaPago = p.nota ? esc(p.nota) : x('Pago al inicio de cada periodo.', 'Paid at the start of each period.', 'Zahlung zu Beginn jeder Periode.', 'Pagamento no início de cada período.');
  const feeMes = feeNum + ' ' + x('/ mes', '/ month', '/ Monat', '/ mês');
  const mesesTxt = meses + ' ' + (meses === 1 ? x('mes', 'month', 'Monat', 'mês') : x('meses', 'months', 'Monate', 'meses'));

  // logo según el fondo: cada fondo tiene una variante elegida; si falta, cae a otra disponible; sin logos, nombre en texto
  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (elegido, orden) => {
    for (const k of [elegido, ...orden]) if (logoOk(logos[k])) return logos[k];
    return '';
  };
  const dataW = pick(b.logo_oscuro || 'blanco', ['blanco', 'color', 'negro']);
  const dataC = pick(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const logoW = dataW ? `<img class="logo" alt="${esc(marca)}" src="${dataW}">` : `<span class="logo wm" style="color:#fff">${esc(marca)}</span>`;
  const logoC = dataC ? `<img class="logo" alt="${esc(marca)}" src="${dataC}">` : `<span class="logo wm" style="color:var(--ink)">${esc(marca)}</span>`;
  const logoPf = dataW ? `<img alt="${esc(marca)}" src="${dataW}">` : `<span style="color:#fff;font-size:11px;font-weight:600">${esc(marca)}</span>`;

  const foot = x('Propuesta de Servicio Comercial B2B', 'B2B Commercial Service Proposal', 'B2B-Vertriebsdienstleistung – Angebot', 'Proposta de Serviço Comercial B2B');
  const hd = (tag) => `<div class="hd">${logoC}<span class="tag">${esc(tag)}</span></div>`;
  const ft = n => `<div class="ft"><span>${foot}</span><b>${n}</b></div>`;
  const sec = x('Sección', 'Section', 'Abschnitt', 'Seção');

  const titulo = p.servicio
    ? `${esc(p.servicio)} <em>${esc(p.servicioEm || '')}</em>`
    : x('Sistema de Adquisición <em>Comercial B2B</em>', 'B2B Commercial <em>Acquisition System</em>', 'B2B-<em>Vertriebssystem</em>', 'Sistema de Aquisição <em>Comercial B2B</em>');

  const subj = x('Inicio del Servicio Comercial B2B', 'Start of the B2B Commercial Service', 'Start der B2B-Vertriebsdienstleistung', 'Início do Serviço Comercial B2B');
  const body = x(
    'Hola,\n\nQuiero iniciar el servicio comercial.\n\nPor favor indíquenme la información necesaria para comenzar.\n\nQuedo atento a los siguientes pasos.\n\nSaludos,\n',
    'Hello,\n\nI would like to start the commercial service.\n\nPlease let me know what information you need to get started.\n\nLooking forward to the next steps.\n\nBest regards,\n',
    'Guten Tag,\n\nich möchte die Vertriebsdienstleistung starten.\n\nBitte teilen Sie mir mit, welche Informationen Sie zum Start benötigen.\n\nIch freue mich auf die nächsten Schritte.\n\nMit freundlichen Grüßen\n',
    'Olá,\n\nQuero iniciar o serviço comercial.\n\nPor favor, indiquem-me as informações necessárias para começar.\n\nAguardo os próximos passos.\n\nAtenciosamente,\n'
  ) + contacto + (p.correo ? '\n' + p.correo : '');
  const mailto = mail ? `mailto:${encodeURIComponent(mail).replace(/%40/g, '@')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}` : '#';

  const idxItems = [
    [x('Así arrancamos', 'How we start', 'So starten wir', 'Como começamos'), x('Research comercial (semanas 1–2), inicio del contacto (semanas 2–3) y optimización desde la semana 4.', 'Commercial research (weeks 1–2), outreach start (weeks 2–3) and optimization from week 4.', 'Marktrecherche (Wochen 1–2), Beginn der Ansprache (Wochen 2–3) und Optimierung ab Woche 4.', 'Pesquisa comercial (semanas 1–2), início do contato (semanas 2–3) e otimização a partir da semana 4.')],
    [x('Cómo salimos al mercado', 'How we go to market', 'Wie wir an den Markt gehen', 'Como vamos ao mercado'), x('Ejecución coordinada, recorrido de cada cuenta y optimización continua.', 'Coordinated execution, the journey of each account and continuous optimization.', 'Koordinierte Umsetzung, der Weg jedes Accounts und laufende Optimierung.', 'Execução coordenada, jornada de cada conta e otimização contínua.')],
    [x('Tu portal de seguimiento en vivo', 'Your live tracking portal', 'Ihr Live-Tracking-Portal', 'Seu portal de acompanhamento ao vivo'), x('Visibilidad permanente de la actividad, las respuestas y las oportunidades.', 'Permanent visibility of activity, replies and opportunities.', 'Dauerhafte Transparenz über Aktivität, Antworten und Opportunities.', 'Visibilidade permanente da atividade, das respostas e das oportunidades.')],
    [x('Entregables y responsabilidades', 'Deliverables and responsibilities', 'Ergebnisse und Verantwortlichkeiten', 'Entregáveis e responsabilidades'), x('Qué recibes cada mes y qué hace cada parte.', 'What you receive each month and what each party does.', 'Was Sie jeden Monat erhalten und was jede Seite übernimmt.', 'O que você recebe a cada mês e o que cada parte faz.')],
    [x('Alcance e inversión', 'Scope and investment', 'Umfang und Investition', 'Escopo e investimento'), x('Qué incluye el servicio, qué no, y la inversión mensual.', 'What the service includes, what it does not, and the monthly investment.', 'Was die Leistung umfasst, was nicht, und die monatliche Investition.', 'O que o serviço inclui, o que não inclui e o investimento mensal.')],
    [x('Próximo paso', 'Next step', 'Nächster Schritt', 'Próximo passo'), x('Cómo iniciamos.', 'How we get started.', 'So legen wir los.', 'Como iniciamos.')],
  ];
  const idxHtml = idxItems.map((r, i) => `<div class="ir"><span class="n">0${i + 1}</span><div><h3>${r[0]}</h3><p>${r[1]}</p></div><span class="pg">0${i + 3}</span></div>`).join('\n');

  const rs = (n, h, pTxt, res) => `<div class="rs"><span class="n">${n}</span><div><h3>${h}</h3><p>${pTxt}</p></div><div class="out">${x('Resultado', 'Outcome', 'Ergebnis', 'Resultado')}<b>${res}</b></div></div>`;
  const phase = (w, t) => `<div class="ph"><b>${w}</b> ${t}</div>`;

  const step = (n, h, s) => `<div class="step"><i>${n}</i><b>${h}</b><span>${s}</span></div>`;
  const kp = (l, v, d, mute) => `<div><small>${l}</small><b>${v}</b><i${mute ? ' style="color:#94A3B8"' : ''}>${d}</i></div>`;
  const dl = (n, t) => `<div><b>${n}</b><span>${t}</span></div>`;
  const li_ = a => a.map(t => `<li>${t}</li>`).join('');
  const st = (n, t) => `<div class="st"><i>${n}</i><span>${t}</span></div>`;
  const est = x('estimada', 'estimated', 'geschätzt', 'estimada'), estp = x('estimado', 'estimated', 'geschätzt', 'estimado');

  const pages = [];

  // 1 · portada
  pages.push(`<section class="page cover"><div class="hd">${logoW}<div class="for"><small>${x('Preparada para', 'Prepared for', 'Erstellt für', 'Preparada para')}</small>${clLogo ? `<img class="cl${p.logoCliente.usar === 'blanco' ? ' cl--w' : ''}" alt="${esc(empresa)}" src="${clLogo}">` : `<span>${esc(empresa.toUpperCase())}</span>`}</div></div>
<div class="main"><div class="kick">${x('Propuesta comercial', 'Commercial proposal', 'Geschäftsangebot', 'Proposta comercial')}</div><h1>${titulo}</h1>
<p class="sub">${x('Investigación, prospección y ejecución multicanal para generar oportunidades comerciales de forma estructurada, medible y constante.', 'Research, prospecting and multichannel execution to generate sales opportunities in a structured, measurable and consistent way.', 'Recherche, Prospektion und Multichannel-Umsetzung, um Vertriebschancen strukturiert, messbar und kontinuierlich zu erzeugen.', 'Pesquisa, prospecção e execução multicanal para gerar oportunidades comerciais de forma estruturada, mensurável e constante.')}</p></div>
<div class="meta">
<div><div class="l">${x('Contacto principal', 'Main contact', 'Hauptansprechpartner', 'Contato principal')}</div><div class="v"><span>${esc(contacto)}</span><br><span class="em">${esc(p.correo || '')}</span></div></div>
<div><div class="l">${x('Duración', 'Duration', 'Laufzeit', 'Duração')}</div><div class="v">${x('Mensual', 'Monthly', 'Monatlich', 'Mensal')}<br>${esc(p.inicio || x('Inicio por definir', 'Start date to be defined', 'Startdatum offen', 'Início a definir'))}</div></div>
<div><div class="l">${x('Inversión', 'Investment', 'Investition', 'Investimento')}</div><div class="v"><span>${feeMes}</span><br>${modeloTxt}</div></div>
</div></section>`);

  // 2 · índice
  pages.push(`<section class="page">${hd(x('Contenido', 'Contents', 'Inhalt', 'Conteúdo'))}
<div class="body"><div class="eyebrow">${x('Contenido', 'Contents', 'Inhalt', 'Conteúdo')}</div><h2>${x('Índice', 'Index', 'Inhaltsverzeichnis', 'Índice')}</h2>
<p class="lead">${x('Qué haremos, cómo lo ejecutamos, cómo lo verás y bajo qué condiciones.', 'What we will do, how we run it, how you will see it and under what terms.', 'Was wir tun, wie wir es umsetzen, wie Sie es verfolgen und zu welchen Bedingungen.', 'O que faremos, como executamos, como você acompanha e sob quais condições.')}</p>
<div class="idx">${idxHtml}</div></div>${ft('02')}</section>`);

  // 3 · arranque
  pages.push(`<section class="page t3">${hd('01 · ' + idxItems[0][0])}
<div class="body"><div class="eyebrow">${sec} 01</div>
<h2>${x('Lo primero que <em>haremos.</em>', 'What we will do <em>first.</em>', 'Das machen wir <em>zuerst.</em>', 'O que faremos <em>primeiro.</em>')}</h2>
<p class="lead">${x('Empezamos con un research comercial para validar la oferta y el mercado real. Las primeras semanas ordenan todo antes de contactar a nadie.', 'We start with commercial research to validate the offer and the real market. The first weeks put everything in order before anyone is contacted.', 'Wir beginnen mit einer Marktrecherche, um Angebot und realen Markt zu validieren. Die ersten Wochen ordnen alles, bevor jemand kontaktiert wird.', 'Começamos com uma pesquisa comercial para validar a oferta e o mercado real. As primeiras semanas organizam tudo antes de contatar alguém.')}</p>
<div class="road">
${phase(x('Semanas 1–2', 'Weeks 1–2', 'Wochen 1–2', 'Semanas 1–2'), x('Research comercial', 'Commercial research', 'Marktrecherche', 'Pesquisa comercial'))}
${rs(1, x('Clarificamos la oferta', 'We clarify the offer', 'Wir schärfen das Angebot', 'Esclarecemos a oferta'), x('Definimos qué servicio impulsar y qué problema resuelve. Si la oferta aún no está clara, te sugerimos por dónde comenzar.', 'We define which service to push and what problem it solves. If the offer is not yet clear, we suggest where to begin.', 'Wir legen fest, welche Leistung wir vorantreiben und welches Problem sie löst. Ist das Angebot noch unklar, schlagen wir einen Einstieg vor.', 'Definimos qual serviço impulsionar e que problema ele resolve. Se a oferta ainda não estiver clara, sugerimos por onde começar.'), x('Oferta prioritaria e hipótesis comercial', 'Priority offer and commercial hypothesis', 'Prioritäres Angebot und Vertriebshypothese', 'Oferta prioritária e hipótese comercial'))}
${rs(2, x('Definimos a quién nos dirigimos', 'We define who we target', 'Wir definieren die Zielgruppe', 'Definimos a quem nos dirigimos'), x('Sector, tamaño, ubicación y señales de oportunidad, con criterios claros de inclusión y descarte.', 'Industry, size, location and opportunity signals, with clear inclusion and exclusion criteria.', 'Branche, Größe, Standort und Chancensignale mit klaren Ein- und Ausschlusskriterien.', 'Setor, porte, localização e sinais de oportunidade, com critérios claros de inclusão e descarte.'), x('Perfil de cliente ideal (ICP)', 'Ideal customer profile (ICP)', 'Ideales Kundenprofil (ICP)', 'Perfil de cliente ideal (ICP)'))}
${rs(3, x('Dimensionamos el mercado', 'We size the market', 'Wir vermessen den Markt', 'Dimensionamos o mercado'), x('Antes de contactar, validamos el universo real con TAM, SAM y SOM: cuántas empresas existen, cuántas encajan y cuántas podemos alcanzar.', 'Before reaching out, we validate the real universe with TAM, SAM and SOM: how many companies exist, how many fit and how many we can reach.', 'Vor der Ansprache validieren wir das reale Universum mit TAM, SAM und SOM: wie viele Unternehmen es gibt, wie viele passen und wie viele wir erreichen können.', 'Antes de contatar, validamos o universo real com TAM, SAM e SOM: quantas empresas existem, quantas se encaixam e quantas podemos alcançar.'), x('Universo de mercado validado', 'Validated market universe', 'Validiertes Marktuniversum', 'Universo de mercado validado'))}
${rs(4, x('Investigamos cuentas y decisores', 'We research accounts and decision-makers', 'Wir recherchieren Accounts und Entscheider', 'Pesquisamos contas e decisores'), x('Priorizamos empresas con encaje real, sin duplicados, e identificamos hasta dos cargos por empresa.', 'We prioritize companies with a real fit, without duplicates, and identify up to two roles per company.', 'Wir priorisieren Unternehmen mit echter Passung, ohne Duplikate, und identifizieren bis zu zwei Rollen pro Unternehmen.', 'Priorizamos empresas com encaixe real, sem duplicados, e identificamos até dois cargos por empresa.'), x('Base de cuentas y decisores', 'Account and decision-maker base', 'Account- und Entscheiderbasis', 'Base de contas e decisores'))}
${phase(x('Semanas 2–3', 'Weeks 2–3', 'Wochen 2–3', 'Semanas 2–3'), x('Inicio del contacto', 'Outreach start', 'Beginn der Ansprache', 'Início do contato'))}
${rs(5, x('Iniciamos las conversaciones', 'We start the conversations', 'Wir starten die Gespräche', 'Iniciamos as conversas'), x('Lanzamos la secuencia de LinkedIn y correo de forma progresiva, con mensajes basados en lo que validamos.', 'We launch the LinkedIn and email sequence progressively, with messages based on what we validated.', 'Wir starten die LinkedIn- und E-Mail-Sequenz schrittweise, mit Nachrichten auf Basis des Validierten.', 'Lançamos a sequência de LinkedIn e e-mail de forma progressiva, com mensagens baseadas no que validamos.'), x('Primeras conversaciones en curso', 'First conversations under way', 'Erste Gespräche laufen', 'Primeiras conversas em andamento'))}
${phase(x('Semana 4 en adelante', 'Week 4 onward', 'Ab Woche 4', 'A partir da semana 4'), x('Optimización', 'Optimization', 'Optimierung', 'Otimização'))}
${rs(6, x('Optimizamos y ajustamos', 'We optimize and adjust', 'Wir optimieren und justieren', 'Otimizamos e ajustamos'), x('Mejoramos mensajes, segmentos y decisores según las respuestas reales. El ICP y la priorización se ajustan de forma progresiva, con evidencia del mercado.', 'We improve messages, segments and decision-makers based on real replies. The ICP and prioritization are adjusted progressively, with market evidence.', 'Wir verbessern Nachrichten, Segmente und Entscheider anhand realer Antworten. ICP und Priorisierung werden schrittweise mit Marktevidenz angepasst.', 'Melhoramos mensagens, segmentos e decisores com base nas respostas reais. O ICP e a priorização são ajustados progressivamente, com evidências do mercado.'), x('Campaña afinada con datos', 'Campaign fine-tuned with data', 'Mit Daten optimierte Kampagne', 'Campanha refinada com dados'))}
</div></div>${ft('03')}</section>`);

  // 4 · ejecución
  pages.push(`<section class="page">${hd('02 · ' + idxItems[1][0])}
<div class="body"><div class="eyebrow">${sec} 02</div>
<h2>${x('Una secuencia coordinada, <em>no campañas sueltas.</em>', 'A coordinated sequence, <em>not isolated campaigns.</em>', 'Eine koordinierte Sequenz, <em>keine einzelnen Kampagnen.</em>', 'Uma sequência coordenada, <em>não campanhas soltas.</em>')}</h2>
<p class="lead">${x('Cada contacto sigue un recorrido ordenado y medible. Cuando hay una respuesta, la secuencia se detiene y la conversación continúa con contexto.', 'Each contact follows an orderly, measurable journey. When there is a reply, the sequence stops and the conversation continues with context.', 'Jeder Kontakt durchläuft einen geordneten, messbaren Ablauf. Bei einer Antwort stoppt die Sequenz und das Gespräch geht mit Kontext weiter.', 'Cada contato segue uma jornada ordenada e mensurável. Quando há uma resposta, a sequência é interrompida e a conversa continua com contexto.')}</p>
<div class="inc"><span class="t">${x('Canales incluidos en este plan', 'Channels included in this plan', 'In diesem Plan enthaltene Kanäle', 'Canais incluídos neste plano')}</span><span class="chip">LinkedIn</span><span class="chip">${x('Correo electrónico', 'Email', 'E-Mail', 'E-mail')}</span></div>
<div class="cyc"><div class="k">${x('Cómo trabaja cada cuenta', 'How each account is worked', 'Wie jeder Account bearbeitet wird', 'Como cada conta é trabalhada')}</div>
<div class="flow">
${step(1, x('Preparación', 'Preparation', 'Vorbereitung', 'Preparação'), x('Prospectos validados e incorporación progresiva', 'Validated prospects and progressive onboarding', 'Validierte Interessenten, schrittweise aufgenommen', 'Prospects validados e incorporação progressiva'))}
${step(2, x('Ejecución', 'Execution', 'Umsetzung', 'Execução'), x('Contacto, seguimiento y registro de actividad', 'Outreach, follow-up and activity logging', 'Ansprache, Nachfassen und Aktivitätsprotokoll', 'Contato, acompanhamento e registro de atividade'))}
${step(3, x('Contexto', 'Context', 'Kontext', 'Contexto'), x('Las acciones pendientes se detienen ante una respuesta', 'Pending actions stop when a reply arrives', 'Offene Aktionen stoppen bei einer Antwort', 'As ações pendentes param diante de uma resposta'))}
${step(4, x('Clasificación', 'Classification', 'Klassifizierung', 'Classificação'), x('Respuestas, objeciones, interés y descartes', 'Replies, objections, interest and disqualifications', 'Antworten, Einwände, Interesse und Absagen', 'Respostas, objeções, interesse e descartes'))}
${step(5, 'Pipeline', x('Actualización de estado y cambio de decisor', 'Status update and decision-maker change', 'Statusaktualisierung und Entscheiderwechsel', 'Atualização de status e troca de decisor'))}
${step(6, x('Entrega', 'Handover', 'Übergabe', 'Entrega'), x('Oportunidades con historial y próxima acción', 'Opportunities with history and next action', 'Opportunities mit Historie und nächster Aktion', 'Oportunidades com histórico e próxima ação'))}
</div></div>
<div class="opt"><div class="k">${x('Mejora permanente', 'Ongoing improvement', 'Ständige Verbesserung', 'Melhoria permanente')}</div><h3>${x('Optimización continua', 'Continuous optimization', 'Laufende Optimierung', 'Otimização contínua')}</h3>
<p>${x('La campaña será supervisada de forma continua. Revisaremos calidad de empresas, precisión de decisores, aceptaciones de LinkedIn, entregabilidad, respuestas, objeciones, rendimiento de mensajes, motivos de descarte y sectores con mejores señales.', 'The campaign will be monitored continuously. We will review company quality, decision-maker accuracy, LinkedIn acceptances, deliverability, replies, objections, message performance, disqualification reasons and the sectors with the best signals.', 'Die Kampagne wird laufend überwacht. Wir prüfen Unternehmensqualität, Genauigkeit der Entscheider, LinkedIn-Annahmen, Zustellbarkeit, Antworten, Einwände, Nachrichtenleistung, Absagegründe und Branchen mit den besten Signalen.', 'A campanha será supervisionada continuamente. Revisaremos qualidade das empresas, precisão dos decisores, aceitações no LinkedIn, entregabilidade, respostas, objeções, desempenho das mensagens, motivos de descarte e setores com melhores sinais.')}</p>
<p>${x('Los cambios se realizarán de manera progresiva y basados en evidencia.', 'Changes will be made progressively and based on evidence.', 'Änderungen erfolgen schrittweise und auf Basis von Evidenz.', 'As mudanças serão feitas de maneira progressiva e baseadas em evidências.')}</p></div>
<div class="k" style="font-size:10px;font-weight:600;color:var(--teal);margin:30px 0 -6px">${x('Revisión mensual', 'Monthly review', 'Monatliche Überprüfung', 'Revisão mensal')}</div><div class="rev">
<div><b>${x('Continuar', 'Continue', 'Fortsetzen', 'Continuar')}</b><span>${x('Escalar el enfoque que demuestre mejores señales.', 'Scale the approach that shows the best signals.', 'Den Ansatz mit den besten Signalen ausbauen.', 'Escalar a abordagem que mostrar melhores sinais.')}</span></div>
<div><b>${x('Ajustar', 'Adjust', 'Anpassen', 'Ajustar')}</b><span>${x('Refinar oferta, mercado, decisor o mensaje.', 'Refine the offer, market, decision-maker or message.', 'Angebot, Markt, Entscheider oder Botschaft verfeinern.', 'Refinar oferta, mercado, decisor ou mensagem.')}</span></div>
<div><b>${x('Detener', 'Stop', 'Beenden', 'Encerrar')}</b><span>${x('Descartar una hipótesis con baja afinidad.', 'Drop a hypothesis with low fit.', 'Eine Hypothese mit geringer Passung verwerfen.', 'Descartar uma hipótese com baixa afinidade.')}</span></div>
</div></div>${ft('04')}</section>`);

  // 5 · portal
  pages.push(`<section class="page">${hd('03 · ' + x('Portal de seguimiento', 'Tracking portal', 'Tracking-Portal', 'Portal de acompanhamento'))}
<div class="body"><div class="eyebrow">${sec} 03</div>
<h2>${x('Tu operación, <em>visible en vivo.</em>', 'Your operation, <em>visible live.</em>', 'Ihr Geschäft, <em>live sichtbar.</em>', 'Sua operação, <em>visível ao vivo.</em>')}</h2>
<p class="lead">${x('Incluimos acceso a un portal privado donde ves en tiempo real qué se hace, quién responde y qué oportunidades avanzan, sin esperar a un informe.', 'We include access to a private portal where you see in real time what is being done, who replies and which opportunities advance, without waiting for a report.', 'Wir bieten Zugang zu einem privaten Portal, in dem Sie in Echtzeit sehen, was getan wird, wer antwortet und welche Opportunities vorankommen – ohne auf einen Bericht zu warten.', 'Incluímos acesso a um portal privado onde você vê em tempo real o que é feito, quem responde e quais oportunidades avançam, sem esperar por um relatório.')}</p>
<div class="pf"><div class="top">${logoPf}<span class="live">${x('En vivo · actualizado hoy', 'Live · updated today', 'Live · heute aktualisiert', 'Ao vivo · atualizado hoje')}</span></div>
<div class="tabs"><span class="on">${x('Resumen', 'Overview', 'Übersicht', 'Resumo')}</span><span>${x('Oportunidades', 'Opportunities', 'Opportunities', 'Oportunidades')}</span><span>${x('Empresas', 'Companies', 'Unternehmen', 'Empresas')}</span><span>${x('Contactos', 'Contacts', 'Kontakte', 'Contatos')}</span><span>${x('Secuencias', 'Sequences', 'Sequenzen', 'Sequências')}</span><span>${x('Actividad', 'Activity', 'Aktivität', 'Atividade')}</span><span>${x('Prospección', 'Prospecting', 'Prospektion', 'Prospecção')}</span></div>
<div class="kp">
${kp(x('Contactos alcanzados', 'Contacts reached', 'Erreichte Kontakte', 'Contatos alcançados'), 240, '▲ +18%')}
${kp(x('Respuestas', 'Replies', 'Antworten', 'Respostas'), 21, '▲ +12%')}
${kp(x('Oportunidades', 'Opportunities', 'Opportunities', 'Oportunidades'), 4, '▲ +1')}
${kp(x('Toques de contacto', 'Touchpoints', 'Kontaktpunkte', 'Pontos de contato'), 510, '▲ +22%')}
${kp(x('Apertura de correo', 'Email open rate', 'E-Mail-Öffnungsrate', 'Abertura de e-mail'), '41%', est, true)}
${kp(x('Clics', 'Clicks', 'Klicks', 'Cliques'), '6%', estp, true)}</div>
<div class="ch2"><div class="h">${x('Tendencia', 'Trend', 'Trend', 'Tendência')}<span>● ${x('Contactos alcanzados', 'Contacts reached', 'Erreichte Kontakte', 'Contatos alcançados')} &nbsp; ● ${x('Tasa de respuesta', 'Reply rate', 'Antwortquote', 'Taxa de resposta')}</span></div>
<svg viewBox="0 0 640 120" width="100%" height="190" preserveAspectRatio="none"><g stroke="#E5E9F0" stroke-width="1"><line x1="0" y1="20" x2="640" y2="20"/><line x1="0" y1="60" x2="640" y2="60"/><line x1="0" y1="100" x2="640" y2="100"/></g>
<path d="M0 100 C40 96 60 70 100 74 S160 40 210 50 S270 80 320 56 S390 20 440 34 S520 62 560 30 S610 24 640 18" fill="none" stroke="${prim}" stroke-width="2"/>
<path d="M0 104 C50 102 80 92 130 88 S210 96 260 80 S340 70 400 74 S480 52 540 58 S610 50 640 44" fill="none" stroke="#7C5CE6" stroke-width="2"/></svg></div></div>
<p class="cap">${x('Vista ilustrativa con datos de ejemplo.', 'Illustrative view with sample data.', 'Illustrative Ansicht mit Beispieldaten.', 'Visualização ilustrativa com dados de exemplo.')}</p>
<div class="f3"><div><b>${x('Actividad al día', 'Up-to-date activity', 'Aktuelle Aktivität', 'Atividade em dia')}</b><span>${x('Contactos, respuestas y seguimientos actualizados de forma continua.', 'Contacts, replies and follow-ups updated continuously.', 'Kontakte, Antworten und Nachfassaktionen laufend aktualisiert.', 'Contatos, respostas e acompanhamentos atualizados continuamente.')}</span></div><div><b>${x('Cuentas y oportunidades', 'Accounts and opportunities', 'Accounts und Opportunities', 'Contas e oportunidades')}</b><span>${x('Empresas, decisores y reuniones en calendario, con etapa y valor estimado.', 'Companies, decision-makers and scheduled meetings, with stage and estimated value.', 'Unternehmen, Entscheider und geplante Termine mit Phase und geschätztem Wert.', 'Empresas, decisores e reuniões agendadas, com etapa e valor estimado.')}</span></div><div><b>${x('Secuencias y resultados', 'Sequences and results', 'Sequenzen und Ergebnisse', 'Sequências e resultados')}</b><span>${x('Qué mensaje se envió, cuándo y qué respuesta generó.', 'Which message was sent, when and what reply it generated.', 'Welche Nachricht wann gesendet wurde und welche Antwort sie auslöste.', 'Qual mensagem foi enviada, quando e que resposta gerou.')}</span></div></div>
<div class="why" style="margin-top:22px"><b>${x('Acceso desde la semana 1.', 'Access from week 1.', 'Zugang ab Woche 1.', 'Acesso desde a semana 1.')}</b> ${x('Recomendamos empezar a interpretar las métricas entre las semanas 4 y 6, cuando la secuencia ya acumula volumen suficiente de contactos y respuestas.', 'We recommend starting to interpret the metrics between weeks 4 and 6, once the sequence has accumulated enough contacts and replies.', 'Wir empfehlen, die Kennzahlen zwischen Woche 4 und 6 zu interpretieren, wenn die Sequenz genügend Kontakte und Antworten gesammelt hat.', 'Recomendamos começar a interpretar as métricas entre as semanas 4 e 6, quando a sequência já acumula volume suficiente de contatos e respostas.')}</div>
</div>${ft('05')}</section>`);

  // 6 · entregables
  pages.push(`<section class="page">${hd('04 · ' + idxItems[3][0])}
<div class="body"><div class="eyebrow">${sec} 04</div>
<h2>${x('El servicio deja activos comerciales <em>reutilizables.</em>', 'The service leaves <em>reusable</em> commercial assets.', 'Die Leistung hinterlässt <em>wiederverwendbare</em> Vertriebsassets.', 'O serviço deixa ativos comerciais <em>reutilizáveis.</em>')}</h2>
<p class="lead">${x('Además de la ejecución mensual, el cliente recibe información organizada para dar seguimiento a las oportunidades y tomar decisiones comerciales.', 'Besides the monthly execution, the client receives organized information to follow up on opportunities and make commercial decisions.', 'Neben der monatlichen Umsetzung erhält der Kunde aufbereitete Informationen, um Opportunities nachzuverfolgen und Vertriebsentscheidungen zu treffen.', 'Além da execução mensal, o cliente recebe informações organizadas para acompanhar as oportunidades e tomar decisões comerciais.')}</p>
<div class="dl">
${dl('01', x('Oferta prioritaria evaluada e hipótesis comercial.', 'Evaluated priority offer and commercial hypothesis.', 'Bewertetes prioritäres Angebot und Vertriebshypothese.', 'Oferta prioritária avaliada e hipótese comercial.'))}
${dl('02', x('ICP documentado y criterios de inclusión y descarte.', 'Documented ICP and inclusion and exclusion criteria.', 'Dokumentiertes ICP sowie Ein- und Ausschlusskriterien.', 'ICP documentado e critérios de inclusão e descarte.'))}
${dl('03', x('Universo de mercado validado (TAM, SAM y SOM).', 'Validated market universe (TAM, SAM and SOM).', 'Validiertes Marktuniversum (TAM, SAM und SOM).', 'Universo de mercado validado (TAM, SAM e SOM).'))}
${dl('04', x('Base de cuentas investigadas y decisores identificados.', 'Base of researched accounts and identified decision-makers.', 'Basis recherchierter Accounts und identifizierter Entscheider.', 'Base de contas pesquisadas e decisores identificados.'))}
${dl('05', x('Secuencia multicanal y hasta dos enfoques comerciales.', 'Multichannel sequence and up to two commercial approaches.', 'Multichannel-Sequenz und bis zu zwei Vertriebsansätze.', 'Sequência multicanal e até duas abordagens comerciais.'))}
${dl('06', x('Historial de actividad, respuestas y objeciones.', 'History of activity, replies and objections.', 'Verlauf von Aktivität, Antworten und Einwänden.', 'Histórico de atividade, respostas e objeções.'))}
${dl('07', x('Pipeline organizado y acceso al portal de seguimiento en vivo.', 'Organized pipeline and access to the live tracking portal.', 'Organisierte Pipeline und Zugang zum Live-Tracking-Portal.', 'Pipeline organizado e acesso ao portal de acompanhamento ao vivo.'))}
${dl('08', x('Informes mensuales de actividad comercial.', 'Monthly commercial activity reports.', 'Monatliche Berichte zur Vertriebsaktivität.', 'Relatórios mensais de atividade comercial.'))}
${dl('09', x('Playbook inicial y recomendaciones comerciales.', 'Initial playbook and commercial recommendations.', 'Erstes Playbook und Vertriebsempfehlungen.', 'Playbook inicial e recomendações comerciais.'))}
</div>
<div class="two">
<div class="rp dk"><div class="k">${x('Responsabilidad de ', 'Responsibility of ', 'Verantwortung von ', 'Responsabilidade da ')}${esc(marca)}</div><p>${x('Estrategia, investigación, mensajes, configuración de secuencia, ejecución multicanal, seguimientos, actualización del CRM, supervisión, análisis y entrega de oportunidades.', 'Strategy, research, messaging, sequence setup, multichannel execution, follow-ups, CRM updates, supervision, analysis and delivery of opportunities.', 'Strategie, Recherche, Nachrichten, Sequenz-Setup, Multichannel-Umsetzung, Nachfassen, CRM-Pflege, Überwachung, Analyse und Übergabe der Opportunities.', 'Estratégia, pesquisa, mensagens, configuração da sequência, execução multicanal, acompanhamentos, atualização do CRM, supervisão, análise e entrega de oportunidades.')}</p></div>
<div class="rp lt"><div class="k">${x('Responsabilidad del cliente', 'Client responsibility', 'Verantwortung des Kunden', 'Responsabilidade do cliente')}</div>
<ul class="l">${li_([
    x('Proporcionar información sobre servicios y proyectos.', 'Provide information about services and projects.', 'Informationen zu Leistungen und Projekten bereitstellen.', 'Fornecer informações sobre serviços e projetos.'),
    x('Colaborar en la selección de la oferta.', 'Collaborate in selecting the offer.', 'Bei der Auswahl des Angebots mitwirken.', 'Colaborar na seleção da oferta.'),
    x('Facilitar accesos y aprobar el enfoque inicial.', 'Provide access and approve the initial approach.', 'Zugänge bereitstellen und den ersten Ansatz freigeben.', 'Facilitar acessos e aprovar a abordagem inicial.'),
    x('Responder oportunamente a las oportunidades.', 'Respond promptly to opportunities.', 'Auf Opportunities zeitnah reagieren.', 'Responder oportunamente às oportunidades.'),
    x('Gestionar reuniones, propuestas, negociación y cierre.', 'Handle meetings, proposals, negotiation and closing.', 'Termine, Angebote, Verhandlung und Abschluss übernehmen.', 'Gerenciar reuniões, propostas, negociação e fechamento.'),
    x('Comunicar el resultado de las conversaciones.', 'Report the outcome of the conversations.', 'Das Ergebnis der Gespräche zurückmelden.', 'Comunicar o resultado das conversas.')])}</ul></div>
</div></div>${ft('06')}</section>`);

  // 7 · alcance e inversión
  pages.push(`<section class="page t7">${hd('05 · ' + idxItems[4][0])}
<div class="body"><div class="eyebrow">${sec} 05</div>
<h2>${x('Un alcance delimitado para <em>aprender con precisión.</em>', 'A defined scope to <em>learn with precision.</em>', 'Ein klar umrissener Umfang, um <em>präzise zu lernen.</em>', 'Um escopo delimitado para <em>aprender com precisão.</em>')}</h2>
<div class="terms">
<div><h3>${x('Incluye', 'Includes', 'Enthalten', 'Inclui')}</h3><ul class="l">${li_([
    x('Una oferta prioritaria', 'One priority offer', 'Ein prioritäres Angebot', 'Uma oferta prioritária'),
    x('Un ICP principal', 'One main ICP', 'Ein Haupt-ICP', 'Um ICP principal'),
    x('Un mercado inicial', 'One initial market', 'Ein Startmarkt', 'Um mercado inicial'),
    x('Hasta dos cargos decisores', 'Up to two decision-maker roles', 'Bis zu zwei Entscheiderrollen', 'Até dois cargos decisores'),
    x('LinkedIn y correo electrónico', 'LinkedIn and email', 'LinkedIn und E-Mail', 'LinkedIn e e-mail'),
    x('Hasta dos enfoques relacionados', 'Up to two related approaches', 'Bis zu zwei verwandte Ansätze', 'Até duas abordagens relacionadas'),
    x('Estrategia, investigación, validación y mensajes', 'Strategy, research, validation and messaging', 'Strategie, Recherche, Validierung und Nachrichten', 'Estratégia, pesquisa, validação e mensagens'),
    x('Ejecución, seguimiento, CRM e informes', 'Execution, follow-up, CRM and reports', 'Umsetzung, Nachfassen, CRM und Berichte', 'Execução, acompanhamento, CRM e relatórios'),
    x('Acceso al portal de seguimiento en vivo', 'Access to the live tracking portal', 'Zugang zum Live-Tracking-Portal', 'Acesso ao portal de acompanhamento ao vivo')])}</ul></div>
<div class="ex"><h3>${x('No incluye', 'Does not include', 'Nicht enthalten', 'Não inclui')}</h3><ul class="l">${li_([
    x('Varias ofertas, mercados o ICP simultáneos', 'Several simultaneous offers, markets or ICPs', 'Mehrere gleichzeitige Angebote, Märkte oder ICPs', 'Várias ofertas, mercados ou ICPs simultâneos'),
    x('Publicidad pagada o gestión de redes sociales', 'Paid advertising or social media management', 'Bezahlte Werbung oder Social-Media-Management', 'Publicidade paga ou gestão de redes sociais'),
    x('Producción de contenido', 'Content production', 'Content-Produktion', 'Produção de conteúdo'),
    x('Reuniones comerciales o demostraciones', 'Sales meetings or demos', 'Vertriebstermine oder Demos', 'Reuniões comerciais ou demonstrações'),
    x('Presupuestos, negociación o cierre', 'Quotes, negotiation or closing', 'Angebote, Verhandlung oder Abschluss', 'Orçamentos, negociação ou fechamento'),
    x('Gestión posterior a la venta', 'Post-sale management', 'Betreuung nach dem Verkauf', 'Gestão pós-venda'),
    x('Garantía de respuestas, reuniones o ventas', 'Guarantee of replies, meetings or sales', 'Garantie für Antworten, Termine oder Verkäufe', 'Garantia de respostas, reuniões ou vendas'),
    x('Licencias, dominios o buzones externos específicos', 'Specific external licenses, domains or mailboxes', 'Spezifische externe Lizenzen, Domains oder Postfächer', 'Licenças, domínios ou caixas de e-mail externos específicos')])}</ul></div>
</div>
<p class="disc">${x('Los resultados dependerán también de la claridad de la propuesta de valor, la respuesta del mercado y la capacidad del cliente para atender las conversaciones, presentar su oferta y cerrar las oportunidades.', 'Results will also depend on the clarity of the value proposition, the market response and the client\'s ability to handle conversations, present its offer and close opportunities.', 'Die Ergebnisse hängen auch von der Klarheit des Wertversprechens, der Marktreaktion und der Fähigkeit des Kunden ab, Gespräche zu führen, sein Angebot zu präsentieren und Chancen abzuschließen.', 'Os resultados também dependerão da clareza da proposta de valor, da resposta do mercado e da capacidade do cliente de atender as conversas, apresentar sua oferta e fechar as oportunidades.')}</p>
<div class="why"><b>${x('Plazo recomendado: ', 'Recommended term: ', 'Empfohlene Laufzeit: ', 'Prazo recomendado: ')}${mesesTxt}.</b> ${x('Es el tiempo que toma completar el ciclo: validar la oferta y el mercado, activar el contacto y optimizar el enfoque con datos reales.', 'This is the time it takes to complete the cycle: validate the offer and market, start outreach and optimize the approach with real data.', 'So lange dauert der vollständige Zyklus: Angebot und Markt validieren, die Ansprache starten und den Ansatz mit realen Daten optimieren.', 'É o tempo necessário para completar o ciclo: validar a oferta e o mercado, ativar o contato e otimizar a abordagem com dados reais.')}</div>
<div class="price">
<div><div class="k">${x('Tarifa mensual', 'Monthly fee', 'Monatliche Gebühr', 'Tarifa mensal')}</div><div class="big">${feeNum}</div><div class="sm">${notaPago}</div></div>
<div><div class="k">${x('Plazo recomendado', 'Recommended term', 'Empfohlene Laufzeit', 'Prazo recomendado')}</div><div class="big">${mesesTxt}</div><div class="sm">${x('Ciclo completo: validar, activar y optimizar.', 'Full cycle: validate, activate and optimize.', 'Kompletter Zyklus: validieren, aktivieren und optimieren.', 'Ciclo completo: validar, ativar e otimizar.')}</div></div>
<div class="full"><div class="k">${x('Modelo de compensación', 'Compensation model', 'Vergütungsmodell', 'Modelo de remuneração')}</div><div class="mid">${modeloTxt}</div>${p.modelo ? '' : `<div class="sm">${x('Las comisiones se aplican adicionalmente al fee mensual.', 'Commissions apply in addition to the monthly fee.', 'Provisionen fallen zusätzlich zur monatlichen Gebühr an.', 'As comissões são aplicadas adicionalmente ao fee mensal.')}</div>`}</div>
</div></div>${ft('07')}</section>`);

  // 8 · cierre
  pages.push(`<section class="page close"><div class="hd">${logoW}<span class="tag" style="color:rgba(255,255,255,.55)">${x('Próximo paso con ', 'Next step with ', 'Nächster Schritt mit ', 'Próximo passo com ')}<span style="color:#fff;font-weight:600">${esc(empresa.toUpperCase())}</span></span></div>
<div class="inner"><div class="eyebrow">${x('Inicio del servicio', 'Service start', 'Start der Leistung', 'Início do serviço')}</div>
<h2>${x('Comencemos a generar <em>oportunidades</em> comerciales.', 'Let\'s start generating commercial <em>opportunities.</em>', 'Lassen Sie uns beginnen, Vertriebs-<em>chancen</em> zu erzeugen.', 'Vamos começar a gerar <em>oportunidades</em> comerciais.')}</h2>
<p class="lead">${x('Confirma el inicio del servicio. A partir de ahí definiremos el perfil de cliente ideal, prepararemos los mensajes y construiremos el primer bloque de cuentas objetivo.', 'Confirm the start of the service. From there we will define the ideal customer profile, prepare the messages and build the first block of target accounts.', 'Bestätigen Sie den Start der Leistung. Danach definieren wir das ideale Kundenprofil, bereiten die Nachrichten vor und bauen den ersten Block an Ziel-Accounts auf.', 'Confirme o início do serviço. A partir daí definiremos o perfil de cliente ideal, prepararemos as mensagens e construiremos o primeiro bloco de contas-alvo.')}</p>
<div class="cta-row"><a class="btn" target="_blank" rel="noopener noreferrer" href="${esc(mailto)}">${x('Comenzar ahora ↗', 'Get started ↗', 'Jetzt starten ↗', 'Começar agora ↗')}</a>
<div class="facts"><div><b>${x('Duración', 'Duration', 'Laufzeit', 'Duração')}</b>${x(mesesTxt + ' recomendados', mesesTxt + ' recommended', mesesTxt + ' empfohlen', mesesTxt + ' recomendados')}</div><div><b>${x('Inversión', 'Investment', 'Investition', 'Investimento')}</b><span>${feeMes}</span>${p.modelo ? ' · ' + esc(p.modelo) : ' + ' + x('comisiones', 'commissions', 'Provisionen', 'comissões')}</div><div><b>${x('Inicio', 'Start', 'Start', 'Início')}</b>${x('Al confirmar', 'Upon confirmation', 'Nach Bestätigung', 'Ao confirmar')}</div></div></div>
<div class="steps">
${st('01', x('Confirmar el inicio del servicio.', 'Confirm the start of the service.', 'Start der Leistung bestätigen.', 'Confirmar o início do serviço.'))}
${st('02', x('Definir el perfil de cliente ideal y compartir la información necesaria.', 'Define the ideal customer profile and share the necessary information.', 'Das ideale Kundenprofil definieren und die nötigen Informationen teilen.', 'Definir o perfil de cliente ideal e compartilhar as informações necessárias.'))}
${st('03', x('Preparar mensajes, cuentas objetivo e iniciar la ejecución.', 'Prepare messages, target accounts and start execution.', 'Nachrichten und Ziel-Accounts vorbereiten und die Umsetzung starten.', 'Preparar mensagens, contas-alvo e iniciar a execução.'))}
</div>
<p class="rep">${esc(marca)} ${x('informará mensualmente los avances, las respuestas obtenidas y las oportunidades transferidas.', 'will report monthly on progress, replies obtained and opportunities handed over.', 'berichtet monatlich über Fortschritte, erhaltene Antworten und übergebene Opportunities.', 'informará mensalmente os avanços, as respostas obtidas e as oportunidades transferidas.')}</p></div>
<div class="foot"><div>${esc(marca)}<br>${esc(mail)}<br>${esc(web)}</div><div class="conf">${x('Confidencial', 'Confidential', 'Vertraulich', 'Confidencial')}<br>${x('Preparada para ', 'Prepared for ', 'Erstellt für ', 'Preparada para ')}${esc(empresa)} · 08</div></div></section>`);

  const rootVars = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--tl-rgb:${rgb(light)};--sans:'Inter','Segoe UI',sans-serif}`;
  const title = `${x('Propuesta Comercial B2B', 'B2B Commercial Proposal', 'B2B-Geschäftsangebot', 'Proposta Comercial B2B')} | ${empresa}`;
  return `<!DOCTYPE html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${rootVars}\n${CSS}\n.wm{font-weight:700;font-size:18px;letter-spacing:-.02em;height:auto}
.logo{height:30px}.cover .logo{height:40px}.cover .for .cl{display:block;margin:6px 0 0 auto;max-height:46px;max-width:180px;object-fit:contain;background:#fff;padding:9px 14px;border-radius:6px}.cover .for .cl--w{background:none;padding:0;border-radius:0;max-height:52px}.pf .ch2 svg{height:168px}.dl div{min-height:66px;padding-top:14px;padding-bottom:14px}.two{margin-top:20px}.rp{padding:22px 24px}.t3 .road .rs{padding:6px 0}.t3 .lead{margin-top:12px}</style></head><body>\n${pages.join('\n')}\n</body></html>`;
}

module.exports = { render, LANGS, logoOk };
