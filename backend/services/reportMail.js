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

const INTRO2 = {
  es: 'Aquí encuentras las acciones de esta semana, las secuencias activas y las empresas con buenas señales. Abajo tienes una pequeña vista previa; el detalle completo está en tu portal.',
  en: 'Here you will find this week\'s actions, your active sequences and the companies showing good signals. Below is a small preview; the full detail is in your portal.',
  de: 'Hier finden Sie die Aktionen dieser Woche, Ihre aktiven Sequenzen und die Unternehmen mit guten Signalen. Unten sehen Sie eine kleine Vorschau; alle Details finden Sie in Ihrem Portal.',
  pt: 'Aqui você encontra as ações desta semana, as sequências ativas e as empresas com bons sinais. Abaixo, uma pequena prévia; o detalhe completo está no seu portal.',
};
const ALT = { es: 'Vista previa del informe semanal', en: 'Weekly report preview', de: 'Vorschau des Wochenberichts', pt: 'Prévia do relatório semanal' };

function buildReport(lang, d) {
  const l = LANGS.includes(lang) ? lang : 'es', X = R[l], L = T[l], brand = d.brand || {};
  const bg = okHex(brand.bg) ? brand.bg : '#0B1220';
  const accent = lum(bg) > 0.6 ? '#2563EB' : bg;
  const note = d.note ? `<div style="border-left:3px solid ${accent};background:#F6F8FB;padding:12px 16px;margin:0 0 22px;${F}font-size:14px;line-height:1.65;color:#334155;white-space:pre-line">${esc(d.note)}</div>` : '';
  const img = `<a href="${esc(d.url)}" style="text-decoration:none"><img src="cid:reportpreview" alt="${esc(ALT[l])}" width="504" style="display:block;width:100%;max-width:504px;height:auto;border:1px solid #E1E6EC"></a>`;
  const inner = `<div style="${F}font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#64748B;margin:0 0 10px">${esc(X.eyebrow)} · ${esc(d.rango)}</div>
    <div style="${F}font-size:24px;font-weight:800;color:#0F172A;line-height:1.25;margin:0 0 10px">${esc(X.hi(d.cliente))}</div>
    <p style="margin:0 0 22px;${F}font-size:15px;line-height:1.65;color:#475569">${esc(INTRO2[l])}</p>${note}
    ${img}
    <div style="height:22px;line-height:22px;font-size:0">&nbsp;</div>${btn(d.url, X.cta, brand.bg)}
    <p style="margin:0 0 6px;${F}font-size:13px;line-height:1.6;color:#64748B">${esc(X.close)}</p>`;
  const k = d.kpi || {};
  const text = `${X.hi(d.cliente)}\n\n${INTRO2[l]}\n(${d.rango}) ${X.kTouch}: ${k.touches || 0} · ${X.kReach}: ${k.contacted || 0} · ${X.kRep}: ${k.replies || 0} · ${X.kMeet}: ${k.agendadas || 0}\n\n${X.cta}: ${d.url}`;
  return { subject: X.subj(d.cliente, d.rango), html: shell(brand, inner, L, d.cliente), text, accent };
}
module.exports = { buildReport };
