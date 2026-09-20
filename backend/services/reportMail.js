// Informe semanal (resumen de los últimos 7 días, enviado al equipo del cliente): plantilla ES/EN/DE/PT.
const { esc, shell, btn, T, LANGS, okHex } = require('./portalMail');

const R = {
  es: { subj: (c, r) => `Informe semanal · ${c} · ${r}`, hi: c => `Hola equipo de ${c},`, intro: r => `Este es el resumen de tu prospección de los últimos 7 días (${r}).`,
    kTouch: 'Toques realizados', kReach: 'Contactos alcanzados', kRep: 'Respuestas', kMeet: 'Reuniones agendadas', vs: 'Variación respecto a la semana anterior',
    hSeq: 'Secuencias activas', hSig: 'Empresas con buenas señales', hMeet: 'Próximas reuniones', noSig: 'Aún no hay señales positivas por convertir.', noMeet: 'Todavía no hay reuniones programadas.',
    cta: 'Ver el informe completo', ctaP: 'Revisa los datos de la semana, las empresas, los contactos y el historial completo en tu portal.', close: 'Cualquier duda, responde a este correo o escríbenos por el chat del portal.', more: n => `y ${n} más` },
  en: { subj: (c, r) => `Weekly report · ${c} · ${r}`, hi: c => `Hi ${c} team,`, intro: r => `Here is the summary of your outreach for the last 7 days (${r}).`,
    kTouch: 'Touches made', kReach: 'Contacts reached', kRep: 'Replies', kMeet: 'Meetings booked', vs: 'Change vs. the previous week',
    hSeq: 'Active sequences', hSig: 'Companies with positive signals', hMeet: 'Upcoming meetings', noSig: 'No positive signals to convert yet.', noMeet: 'No meetings scheduled yet.',
    cta: 'View the full report', ctaP: "Check this week's data, companies, contacts and the full history in your portal.", close: 'If you have any questions, reply to this email or message us in the portal chat.', more: n => `and ${n} more` },
  de: { subj: (c, r) => `Wochenbericht · ${c} · ${r}`, hi: c => `Hallo Team von ${c},`, intro: r => `Hier ist die Zusammenfassung Ihrer Ansprache der letzten 7 Tage (${r}).`,
    kTouch: 'Kontaktpunkte', kReach: 'Erreichte Kontakte', kRep: 'Antworten', kMeet: 'Vereinbarte Termine', vs: 'Veränderung ggü. der Vorwoche',
    hSeq: 'Aktive Sequenzen', hSig: 'Unternehmen mit positiven Signalen', hMeet: 'Anstehende Termine', noSig: 'Noch keine positiven Signale.', noMeet: 'Noch keine Termine geplant.',
    cta: 'Vollständigen Bericht ansehen', ctaP: 'Sehen Sie die Daten der Woche, Unternehmen, Kontakte und den gesamten Verlauf in Ihrem Portal.', close: 'Bei Fragen antworten Sie auf diese E-Mail oder schreiben Sie uns im Portal-Chat.', more: n => `und ${n} weitere` },
  pt: { subj: (c, r) => `Relatório semanal · ${c} · ${r}`, hi: c => `Olá equipe da ${c},`, intro: r => `Este é o resumo da sua prospecção dos últimos 7 dias (${r}).`,
    kTouch: 'Contatos realizados', kReach: 'Contatos alcançados', kRep: 'Respostas', kMeet: 'Reuniões agendadas', vs: 'Variação em relação à semana anterior',
    hSeq: 'Sequências ativas', hSig: 'Empresas com bons sinais', hMeet: 'Próximas reuniões', noSig: 'Ainda não há sinais positivos para converter.', noMeet: 'Ainda não há reuniões agendadas.',
    cta: 'Ver o relatório completo', ctaP: 'Confira os dados da semana, as empresas, os contatos e todo o histórico no seu portal.', close: 'Em caso de dúvida, responda a este e-mail ou escreva pelo chat do portal.', more: n => `e mais ${n}` },
};

function buildReport(lang, d) {
  const l = LANGS.includes(lang) ? lang : 'es', X = R[l], L = T[l], brand = d.brand || {};
  const bg = okHex(brand.bg) ? brand.bg : '#0B1220';
  const delta = (cur, prev) => {
    cur = +cur || 0; prev = +prev || 0;
    if (!prev && !cur) return '';
    if (!prev) return `<span style="color:#15803D">▲ +${cur}</span>`;
    const p = Math.round((cur - prev) / prev * 100);
    if (!p) return '<span style="color:#64748B">= 0%</span>';
    return p > 0 ? `<span style="color:#15803D">▲ +${p}%</span>` : `<span style="color:#B45309">▼ ${p}%</span>`;
  };
  const cell = (n, label, dl, last) => `<td width="25%" style="padding:12px 6px;text-align:center;${last ? '' : 'border-right:1px solid #E1E6EC;'}vertical-align:top"><div style="font:800 26px Arial,sans-serif;color:#0F172A;line-height:1.1">${esc(n)}</div><div style="font:11px Arial,sans-serif;color:#64748B;margin:4px 0 3px">${esc(label)}</div><div style="font:11px Arial,sans-serif;min-height:13px">${dl}</div></td>`;
  const k = d.kpi || {}, p = d.prev || {};
  const kpis = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F8FB;border:1px solid #E1E6EC;margin:0 0 6px"><tr>${cell(k.touches || 0, X.kTouch, delta(k.touches, p.touches))}${cell(k.contacted || 0, X.kReach, delta(k.contacted, p.contacted))}${cell(k.replies || 0, X.kRep, delta(k.replies, p.replies))}${cell(k.agendadas || 0, X.kMeet, delta(k.agendadas, p.agendadas), true)}</tr></table><div style="font:11px Arial,sans-serif;color:#94A3B8;margin:0 0 22px">${esc(X.vs)}</div>`;
  const h = t => `<div style="font:700 12.5px Arial,sans-serif;color:#0F172A;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">${esc(t)}</div>`;
  const li = (a, b) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EEF1F6;font:13.5px Arial,sans-serif;color:#0F172A">${a}</td><td align="right" style="padding:6px 0 6px 12px;border-bottom:1px solid #EEF1F6;font:12px Arial,sans-serif;color:#64748B;white-space:nowrap">${b}</td></tr>`;
  const tbl = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${rows}</table>`;
  const nameCell = s => `<b>${esc(s.empresa || s.nombre)}</b>${s.empresa && s.nombre ? ` <span style="color:#64748B">· ${esc(s.nombre)}</span>` : ''}`;
  const more = (arr, n) => arr.length > n ? li(`<span style="color:#64748B">${esc(X.more(arr.length - n))}</span>`, '') : '';
  const seqs = d.seqs || [], sig = d.positives || [], meet = d.meetings || [];
  const secSeq = seqs.length ? h(`${X.hSeq} (${seqs.length})`) + tbl(seqs.slice(0, 6).map(s => li(esc(s), '')).join('') + more(seqs, 6)) : '';
  const secSig = h(`${X.hSig}${sig.length ? ` (${sig.length})` : ''}`) + (sig.length
    ? tbl(sig.slice(0, 6).map(s => li(nameCell(s), esc(s.estado || ''))).join('') + more(sig, 6))
    : `<p style="margin:0 0 20px;font:13.5px Arial,sans-serif;color:#64748B">${esc(X.noSig)}</p>`);
  const secMeet = h(X.hMeet) + (meet.length
    ? tbl(meet.slice(0, 6).map(m => li(nameCell(m), esc(m.fecha_txt || ''))).join('') + more(meet, 6))
    : `<p style="margin:0 0 20px;font:13.5px Arial,sans-serif;color:#64748B">${esc(X.noMeet)}</p>`);
  const note = d.note ? `<div style="border-left:3px solid ${bg};background:#F6F8FB;padding:10px 14px;margin:0 0 20px;font:14px/1.6 Arial,sans-serif;color:#334155;white-space:pre-line">${esc(d.note)}</div>` : '';
  const inner = `<p style="margin:0 0 6px;font:700 18px Arial,sans-serif;color:#0F172A">${esc(X.hi(d.cliente))}</p>
    <p style="margin:0 0 20px;font:14.5px/1.6 Arial,sans-serif;color:#334155">${esc(X.intro(d.rango))}</p>${note}${kpis}${secSeq}${secSig}${secMeet}
    <p style="margin:6px 0 14px;font:13.5px/1.6 Arial,sans-serif;color:#334155">${esc(X.ctaP)}</p>${btn(d.url, X.cta, brand.bg)}
    <p style="margin:0;font:13px/1.6 Arial,sans-serif;color:#64748B">${esc(X.close)}</p>`;
  const text = `${X.hi(d.cliente)}\n\n${X.intro(d.rango)}\n${X.kTouch}: ${k.touches || 0} · ${X.kReach}: ${k.contacted || 0} · ${X.kRep}: ${k.replies || 0} · ${X.kMeet}: ${k.agendadas || 0}\n\n${X.cta}: ${d.url}`;
  return { subject: X.subj(d.cliente, d.rango), html: shell(brand, inner, L, d.cliente), text };
}
module.exports = { buildReport };
