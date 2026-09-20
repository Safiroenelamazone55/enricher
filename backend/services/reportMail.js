// Informe semanal (resumen de los últimos 7 días, enviado al equipo del cliente): plantilla ES/EN/DE/PT.
const { esc, shell, btn, T, LANGS, okHex, lum } = require('./portalMail');

const R = {
  es: { eyebrow: 'Informe semanal', subj: (c, r) => `Informe semanal · ${c} · ${r}`, hi: c => `Hola equipo de ${c},`, intro: 'Este es el resumen de tu prospección de los últimos 7 días.',
    kTouch: 'Toques realizados', kReach: 'Contactos alcanzados', kRep: 'Respuestas', kMeet: 'Reuniones agendadas', vs: 'Variación respecto a la semana anterior',
    hSeq: 'Secuencias activas', hSig: 'Empresas con buenas señales', hMeet: 'Próximas reuniones', noSig: 'Aún no hay señales positivas por convertir.', noMeet: 'Todavía no hay reuniones programadas.',
    cta: 'Ver el informe completo', ctaP: 'Revisa los datos de la semana, las empresas, los contactos y el historial completo en tu portal.', close: 'Cualquier duda, responde a este correo o escríbenos por el chat del portal.', more: n => `y ${n} más` },
  en: { eyebrow: 'Weekly report', subj: (c, r) => `Weekly report · ${c} · ${r}`, hi: c => `Hi ${c} team,`, intro: 'Here is the summary of your outreach for the last 7 days.',
    kTouch: 'Touches made', kReach: 'Contacts reached', kRep: 'Replies', kMeet: 'Meetings booked', vs: 'Change vs. the previous week',
    hSeq: 'Active sequences', hSig: 'Companies with positive signals', hMeet: 'Upcoming meetings', noSig: 'No positive signals to convert yet.', noMeet: 'No meetings scheduled yet.',
    cta: 'View the full report', ctaP: "Check this week's data, companies, contacts and the full history in your portal.", close: 'If you have any questions, reply to this email or message us in the portal chat.', more: n => `and ${n} more` },
  de: { eyebrow: 'Wochenbericht', subj: (c, r) => `Wochenbericht · ${c} · ${r}`, hi: c => `Hallo Team von ${c},`, intro: 'Hier ist die Zusammenfassung Ihrer Ansprache der letzten 7 Tage.',
    kTouch: 'Kontaktpunkte', kReach: 'Erreichte Kontakte', kRep: 'Antworten', kMeet: 'Vereinbarte Termine', vs: 'Veränderung ggü. der Vorwoche',
    hSeq: 'Aktive Sequenzen', hSig: 'Unternehmen mit positiven Signalen', hMeet: 'Anstehende Termine', noSig: 'Noch keine positiven Signale.', noMeet: 'Noch keine Termine geplant.',
    cta: 'Vollständigen Bericht ansehen', ctaP: 'Sehen Sie die Daten der Woche, Unternehmen, Kontakte und den gesamten Verlauf in Ihrem Portal.', close: 'Bei Fragen antworten Sie auf diese E-Mail oder schreiben Sie uns im Portal-Chat.', more: n => `und ${n} weitere` },
  pt: { eyebrow: 'Relatório semanal', subj: (c, r) => `Relatório semanal · ${c} · ${r}`, hi: c => `Olá equipe da ${c},`, intro: 'Este é o resumo da sua prospecção dos últimos 7 dias.',
    kTouch: 'Contatos realizados', kReach: 'Contatos alcançados', kRep: 'Respostas', kMeet: 'Reuniões agendadas', vs: 'Variação em relação à semana anterior',
    hSeq: 'Sequências ativas', hSig: 'Empresas com bons sinais', hMeet: 'Próximas reuniões', noSig: 'Ainda não há sinais positivos para converter.', noMeet: 'Ainda não há reuniões agendadas.',
    cta: 'Ver o relatório completo', ctaP: 'Confira os dados da semana, as empresas, os contatos e todo o histórico no seu portal.', close: 'Em caso de dúvida, responda a este e-mail ou escreva pelo chat do portal.', more: n => `e mais ${n}` },
};

const F = "font-family:Arial,Helvetica,sans-serif;";
const PILL = { interesado: ['#DBEAFE', '#1D4ED8'], reunion: ['#DCFCE7', '#15803D'], reunión: ['#DCFCE7', '#15803D'], propuesta: ['#FEF3C7', '#B45309'], negociacion: ['#FEF3C7', '#B45309'], negociación: ['#FEF3C7', '#B45309'] };
const pill = t => { const c = PILL[String(t || '').toLowerCase()] || ['#E0F2FE', '#0369A1']; return `<span style="display:inline-block;padding:3px 10px;border-radius:20px;background:${c[0]};color:${c[1]};${F}font-size:11.5px;font-weight:700;white-space:nowrap">${esc(t)}</span>`; };
const initial = s => esc(String(s || '?').trim().charAt(0).toUpperCase() || '?');

// Texto del correo: redactado como un mensaje personal (párrafos cortos, cifras dentro de la frase)
const list = (arr, and) => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' ' + and + ' ' + arr[arr.length - 1];
const COPY = {
  es: {
    hi: c => `Hola equipo de ${c},`,
    lead: (d, k) => { const r = k.replies || 0, t = k.touches || 0, c = k.contacted || 0, a = k.agendadas || 0;
      const hook = r > 0 ? `Buenas noticias: esta semana recibimos ${r} ${r === 1 ? 'respuesta' : 'respuestas'}.` : t > 0 ? 'Semana de siembra: seguimos sembrando contactos y aún no llegaron respuestas.' : 'Semana tranquila: no hubo actividad de envíos.';
      return hook + (t > 0 ? ` En total hicimos ${t} toques a ${c} contactos (${d.rango})` + (a ? ` y ${a === 1 ? 'quedó agendada 1 reunión' : 'quedaron agendadas ' + a + ' reuniones'}.` : '.') : ''); },
    subj: (d, k, n) => (k.replies || 0) > 0 || n ? `Tu semana en ${d.cliente}: ${k.replies || 0} ${(k.replies || 0) === 1 ? 'respuesta' : 'respuestas'}${n ? ' · ' + n + (n === 1 ? ' empresa con buenas señales' : ' empresas con buenas señales') : ''}` : `Resumen semanal de ${d.cliente} · ${d.rango}`,
    sig: (n, names) => n ? `Hay ${n} ${n === 1 ? 'empresa con buenas señales' : 'empresas con buenas señales'}: ${list(names, 'y')}.` : '',
    meet: m => m ? `La próxima reunión es con ${m.empresa || m.nombre}, el ${m.fecha_txt} ${m.dia} de ${m.mes}.` : '',
    seq: n => n ? `Tenemos ${n} ${n === 1 ? 'secuencia activa' : 'secuencias activas'} en marcha.` : '',
    below: 'Abajo te dejo una vista previa. En tu portal encuentras el detalle completo: las acciones, las secuencias activas, las empresas y los contactos.',
    cta: 'Abrir el informe completo', close: 'Si tienes cualquier duda, respóndeme por aquí o escríbenos por el chat del portal.', bye: 'Saludos,', team: 'Equipo Novacentrax', by: 'Portal de seguimiento por Novacentrax',
  },
  en: {
    hi: c => `Hi ${c} team,`,
    lead: (d, k) => { const r = k.replies || 0, t = k.touches || 0, c = k.contacted || 0, a = k.agendadas || 0;
      const hook = r > 0 ? `Good news: we received ${r} ${r === 1 ? 'reply' : 'replies'} this week.` : t > 0 ? "A seeding week: we keep reaching out and no replies have come in yet." : 'A quiet week: there was no outreach activity.';
      return hook + (t > 0 ? ` In total we made ${t} touches to ${c} contacts (${d.rango})` + (a ? ` and ${a === 1 ? '1 meeting was booked' : a + ' meetings were booked'}.` : '.') : ''); },
    subj: (d, k, n) => (k.replies || 0) > 0 || n ? `Your week at ${d.cliente}: ${k.replies || 0} ${(k.replies || 0) === 1 ? 'reply' : 'replies'}${n ? ' · ' + n + (n === 1 ? ' company showing good signals' : ' companies showing good signals') : ''}` : `Weekly summary for ${d.cliente} · ${d.rango}`,
    sig: (n, names) => n ? `${n} ${n === 1 ? 'company is' : 'companies are'} showing good signals: ${list(names, 'and')}.` : '',
    meet: m => m ? `The next meeting is with ${m.empresa || m.nombre}, on ${m.fecha_txt}, ${m.mes} ${m.dia}.` : '',
    seq: n => n ? `We have ${n} active ${n === 1 ? 'sequence' : 'sequences'} running.` : '',
    below: "Below is a quick preview. In your portal you'll find the full detail: actions, active sequences, companies and contacts.",
    cta: 'Open the full report', close: 'If you have any questions, just reply to this email or message us in the portal chat.', bye: 'Best,', team: 'The Novacentrax team', by: 'Tracking portal by Novacentrax',
  },
  de: {
    hi: c => `Hallo Team von ${c},`,
    lead: (d, k) => { const r = k.replies || 0, t = k.touches || 0, c = k.contacted || 0, a = k.agendadas || 0;
      const hook = r > 0 ? `Gute Nachrichten: Diese Woche erhielten wir ${r} ${r === 1 ? 'Antwort' : 'Antworten'}.` : t > 0 ? 'Eine Aussaat-Woche: Wir bleiben dran, Antworten gibt es noch keine.' : 'Eine ruhige Woche: Es gab keine Versandaktivität.';
      return hook + (t > 0 ? ` Insgesamt hatten wir ${t} Kontaktpunkte bei ${c} Kontakten (${d.rango})` + (a ? ` und ${a === 1 ? 'ein Termin wurde' : a + ' Termine wurden'} vereinbart.` : '.') : ''); },
    subj: (d, k, n) => (k.replies || 0) > 0 || n ? `Ihre Woche bei ${d.cliente}: ${k.replies || 0} ${(k.replies || 0) === 1 ? 'Antwort' : 'Antworten'}${n ? ' · ' + n + (n === 1 ? ' Unternehmen mit guten Signalen' : ' Unternehmen mit guten Signalen') : ''}` : `Wochenzusammenfassung für ${d.cliente} · ${d.rango}`,
    sig: (n, names) => n ? `${n} ${n === 1 ? 'Unternehmen zeigt' : 'Unternehmen zeigen'} gute Signale: ${list(names, 'und')}.` : '',
    meet: m => m ? `Der nächste Termin ist mit ${m.empresa || m.nombre}, am ${m.fecha_txt}, ${m.dia}. ${m.mes}.` : '',
    seq: n => n ? `Aktuell laufen ${n} aktive ${n === 1 ? 'Sequenz' : 'Sequenzen'}.` : '',
    below: 'Unten sehen Sie eine kurze Vorschau. In Ihrem Portal finden Sie alle Details: Aktionen, aktive Sequenzen, Unternehmen und Kontakte.',
    cta: 'Vollständigen Bericht öffnen', close: 'Bei Fragen antworten Sie einfach auf diese E-Mail oder schreiben Sie uns im Portal-Chat.', bye: 'Viele Grüße', team: 'Das Novacentrax-Team', by: 'Tracking-Portal von Novacentrax',
  },
  pt: {
    hi: c => `Olá equipe da ${c},`,
    lead: (d, k) => { const r = k.replies || 0, t = k.touches || 0, c = k.contacted || 0, a = k.agendadas || 0;
      const hook = r > 0 ? `Boas notícias: esta semana recebemos ${r} ${r === 1 ? 'resposta' : 'respostas'}.` : t > 0 ? 'Semana de plantio: seguimos plantando contatos e ainda não chegaram respostas.' : 'Semana tranquila: não houve atividade de envios.';
      return hook + (t > 0 ? ` No total fizemos ${t} contatos com ${c} pessoas (${d.rango})` + (a ? ` e ${a === 1 ? '1 reunião foi agendada' : a + ' reuniões foram agendadas'}.` : '.') : ''); },
    subj: (d, k, n) => (k.replies || 0) > 0 || n ? `Sua semana na ${d.cliente}: ${k.replies || 0} ${(k.replies || 0) === 1 ? 'resposta' : 'respostas'}${n ? ' · ' + n + (n === 1 ? ' empresa com bons sinais' : ' empresas com bons sinais') : ''}` : `Resumo semanal de ${d.cliente} · ${d.rango}`,
    sig: (n, names) => n ? `${n} ${n === 1 ? 'empresa está com bons sinais' : 'empresas estão com bons sinais'}: ${list(names, 'e')}.` : '',
    meet: m => m ? `A próxima reunião é com ${m.empresa || m.nombre}, em ${m.fecha_txt}, ${m.dia} de ${m.mes}.` : '',
    seq: n => n ? `Temos ${n} ${n === 1 ? 'sequência ativa' : 'sequências ativas'} em andamento.` : '',
    below: 'Abaixo vai uma prévia. No seu portal você encontra o detalhe completo: as ações, as sequências ativas, as empresas e os contatos.',
    cta: 'Abrir o relatório completo', close: 'Em caso de dúvida, é só responder a este e-mail ou escrever pelo chat do portal.', bye: 'Abraços,', team: 'Equipe Novacentrax', by: 'Portal de acompanhamento por Novacentrax',
  },
};
const ALT = { es: 'Vista previa del informe semanal', en: 'Weekly report preview', de: 'Vorschau des Wochenberichts', pt: 'Prévia do relatório semanal' };

// Diseño de "correo normal": sin franja de color ni tarjetas; logo pequeño arriba, texto plano, imagen y firma
function buildReport(lang, d) {
  const l = LANGS.includes(lang) ? lang : 'es', X = R[l], C = COPY[l], brand = d.brand || {};
  const bg = okHex(brand.bg) ? brand.bg : '#0B1220';
  const accent = lum(bg) > 0.6 ? '#2563EB' : bg;
  const k = d.kpi || {};
  const sig = (d.positives || []).map(p => p.empresa || p.nombre).filter(Boolean).slice(0, 3);
  const bold = t => String(t).split(d.rango).map(part => esc(part).replace(/(\d+)/g, '<b>$1</b>')).join(esc(d.rango));
  const P = t => t ? `<p style="margin:0 0 16px;${F}font-size:15.5px;line-height:1.7;color:#1E293B">${bold(t)}</p>` : '';
  const note = d.note ? `<p style="margin:0 0 14px;${F}font-size:15px;line-height:1.65;color:#1E293B;white-space:pre-line">${esc(d.note)}</p>` : '';
  const logo = brand.hasLogo ? `<img src="cid:brandlogo" alt="${esc(d.cliente)}" height="30" style="display:block;height:30px;max-width:180px;border:0;margin:0 0 22px">` : '';
  const img = `<a href="${esc(d.url)}" style="text-decoration:none"><img src="cid:reportpreview" alt="${esc(ALT[l])}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #E1E6EC;margin:4px 0 20px"></a>`;
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:${accent}"><a href="${esc(d.url)}" style="display:inline-block;padding:11px 24px;color:${lum(accent) > 0.45 ? '#0F172A' : '#FFFFFF'};${F}font-size:14px;font-weight:700;text-decoration:none">${esc(C.cta)}</a></td></tr></table>`;
  const body = `<div style="max-width:560px;margin:0 auto;padding:28px 20px">${logo}
    <p style="margin:0 0 14px;${F}font-size:15px;line-height:1.65;color:#1E293B">${esc(C.hi(d.cliente))}</p>
    ${note}${P(C.lead(d, k))}${P([C.sig(sig.length ? (d.positives || []).length : 0, sig), C.meet((d.meetings || [])[0])].filter(Boolean).join(' '))}${P([C.seq((d.seqs || []).length), C.below].filter(Boolean).join(' '))}
    ${img}${button}
    <p style="margin:0 0 18px;${F}font-size:15px;line-height:1.65;color:#1E293B">${esc(C.close)}</p>
    <p style="margin:0;${F}font-size:15px;line-height:1.5;color:#1E293B">${esc(C.bye)}<br><b>${esc(C.team)}</b></p>
    <p style="margin:26px 0 0;padding-top:14px;border-top:1px solid #EEF1F6;${F}font-size:11.5px;color:#94A3B8">${esc(C.by)}</p></div>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#FFFFFF">${body}</body></html>`;
  const text = [C.hi(d.cliente), '', C.lead(d, k), C.sig(sig.length ? (d.positives || []).length : 0, sig), C.meet((d.meetings || [])[0]), C.seq((d.seqs || []).length), '', `${C.cta}: ${d.url}`, '', C.bye, C.team].filter((x, j, a) => x !== '' || a[j - 1] !== '').join('\n');
  return { subject: C.subj(d, k, (d.positives || []).length), html, text, accent };
}
module.exports = { buildReport };
