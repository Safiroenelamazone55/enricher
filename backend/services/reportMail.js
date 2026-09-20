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

function buildReport(lang, d) {
  const l = LANGS.includes(lang) ? lang : 'es', X = R[l], L = T[l], brand = d.brand || {};
  const bg = okHex(brand.bg) ? brand.bg : '#0B1220';
  // acento: el color de la marca si es oscuro/medio; si es muy claro, un azul neutro
  const accent = lum(bg) > 0.6 ? '#2563EB' : bg;

  const delta = (cur, prev) => {
    cur = +cur || 0; prev = +prev || 0;
    if (!prev && !cur) return '&nbsp;';
    if (!prev) return `<span style="color:#15803D">▲ +${cur}</span>`;
    const p = Math.round((cur - prev) / prev * 100);
    if (!p) return '<span style="color:#94A3B8">= 0%</span>';
    return p > 0 ? `<span style="color:#15803D">▲ +${p}%</span>` : `<span style="color:#B45309">▼ ${p}%</span>`;
  };
  const kcell = (n, label, dl) => `<td width="24%" valign="top" style="background:#F6F8FB;border-top:3px solid ${accent};padding:14px 6px 12px;text-align:center"><div style="${F}font-size:30px;font-weight:800;color:#0F172A;line-height:1">${esc(n)}</div><div style="${F}font-size:11.5px;color:#64748B;margin:7px 0 5px;line-height:1.3">${esc(label)}</div><div style="${F}font-size:11.5px;font-weight:700">${dl}</div></td>`;
  const k = d.kpi || {}, p = d.prev || {};
  const kpis = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${kcell(k.touches || 0, X.kTouch, delta(k.touches, p.touches))}<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>${kcell(k.contacted || 0, X.kReach, delta(k.contacted, p.contacted))}<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>${kcell(k.replies || 0, X.kRep, delta(k.replies, p.replies))}<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>${kcell(k.agendadas || 0, X.kMeet, delta(k.agendadas, p.agendadas))}</tr></table>
    <div style="${F}font-size:11px;color:#94A3B8;margin:8px 0 28px">${esc(X.vs)}</div>`;

  const h = (t, n) => `<div style="${F}font-size:15px;font-weight:800;color:#0F172A;margin:0 0 10px">${esc(t)}${n ? ` <span style="display:inline-block;margin-left:4px;padding:1px 8px;border-radius:20px;background:#EEF1F6;color:#475569;font-size:11.5px;font-weight:700;vertical-align:middle">${n}</span>` : ''}</div>`;
  const wrap = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;border-top:1px solid #EEF1F6">${rows}</table>`;
  const moreRow = (arr, n) => arr.length > n ? `<tr><td colspan="3" style="padding:9px 0;${F}font-size:12.5px;color:#64748B">${esc(X.more(arr.length - n))}</td></tr>` : '';
  const empty = t => `<p style="margin:0 0 28px;${F}font-size:13.5px;color:#64748B">${esc(t)}</p>`;

  const seqs = d.seqs || [], sig = d.positives || [], meet = d.meetings || [];
  const secSeq = seqs.length ? h(X.hSeq, seqs.length) + wrap(seqs.slice(0, 6).map(s => `<tr><td width="14" valign="top" style="padding:9px 0;border-bottom:1px solid #EEF1F6;${F}font-size:14px;color:${accent}">•</td><td colspan="2" style="padding:9px 0;border-bottom:1px solid #EEF1F6;${F}font-size:13.5px;color:#0F172A;line-height:1.4">${esc(s)}</td></tr>`).join('') + moreRow(seqs, 6)) : '';

  const avatar = s => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;border-radius:17px;background:#EEF1F6;${F}font-size:14px;font-weight:800;color:#334155">${initial(s)}</td></tr></table>`;
  const secSig = h(X.hSig, sig.length || '') + (sig.length ? wrap(sig.slice(0, 6).map(s => `<tr><td width="46" valign="middle" style="padding:10px 0;border-bottom:1px solid #EEF1F6">${avatar(s.empresa || s.nombre)}</td><td valign="middle" style="padding:10px 8px 10px 0;border-bottom:1px solid #EEF1F6;${F}line-height:1.35"><div style="font-size:14px;font-weight:700;color:#0F172A">${esc(s.empresa || s.nombre)}</div>${s.empresa && s.nombre ? `<div style="font-size:12.5px;color:#64748B">${esc(s.nombre)}</div>` : ''}</td><td align="right" valign="middle" style="padding:10px 0;border-bottom:1px solid #EEF1F6">${pill(s.estado)}</td></tr>`).join('') + moreRow(sig, 6)) : empty(X.noSig));

  const tile = m => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="44" align="center" style="width:44px;background:${accent};padding:5px 0 4px;${F}font-size:10px;font-weight:700;letter-spacing:.08em;color:#FFFFFF;text-transform:uppercase">${esc(m.mes || '')}</td></tr><tr><td align="center" style="border:1px solid #E1E6EC;border-top:0;padding:3px 0 5px;${F}font-size:18px;font-weight:800;color:#0F172A">${esc(m.dia || '')}</td></tr></table>`;
  const secMeet = h(X.hMeet, meet.length || '') + (meet.length ? wrap(meet.slice(0, 6).map(m => `<tr><td width="60" valign="middle" style="padding:10px 0;border-bottom:1px solid #EEF1F6">${tile(m)}</td><td valign="middle" colspan="2" style="padding:10px 0;border-bottom:1px solid #EEF1F6;${F}line-height:1.35"><div style="font-size:14px;font-weight:700;color:#0F172A">${esc(m.empresa || m.nombre)}</div>${m.empresa && m.nombre ? `<div style="font-size:12.5px;color:#64748B">${esc(m.nombre)}${m.fecha_txt ? ' · ' + esc(m.fecha_txt) : ''}</div>` : (m.fecha_txt ? `<div style="font-size:12.5px;color:#64748B">${esc(m.fecha_txt)}</div>` : '')}</td></tr>`).join('') + moreRow(meet, 6)) : empty(X.noMeet));

  const note = d.note ? `<div style="border-left:3px solid ${accent};background:#F6F8FB;padding:12px 16px;margin:0 0 24px;${F}font-size:14px;line-height:1.65;color:#334155;white-space:pre-line">${esc(d.note)}</div>` : '';
  const inner = `<div style="${F}font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#64748B;margin:0 0 10px">${esc(X.eyebrow)} · ${esc(d.rango)}</div>
    <div style="${F}font-size:24px;font-weight:800;color:#0F172A;line-height:1.25;margin:0 0 8px">${esc(X.hi(d.cliente))}</div>
    <p style="margin:0 0 24px;${F}font-size:15px;line-height:1.6;color:#475569">${esc(X.intro)}</p>${note}${kpis}${secSeq}${secSig}${secMeet}
    <div style="border-top:1px solid #EEF1F6;padding-top:22px"><p style="margin:0 0 14px;${F}font-size:13.5px;line-height:1.6;color:#475569">${esc(X.ctaP)}</p>${btn(d.url, X.cta, brand.bg)}
    <p style="margin:0;${F}font-size:13px;line-height:1.6;color:#64748B">${esc(X.close)}</p></div>`;
  const text = `${X.hi(d.cliente)}\n\n${X.intro} (${d.rango})\n${X.kTouch}: ${k.touches || 0} · ${X.kReach}: ${k.contacted || 0} · ${X.kRep}: ${k.replies || 0} · ${X.kMeet}: ${k.agendadas || 0}\n\n${X.cta}: ${d.url}`;
  return { subject: X.subj(d.cliente, d.rango), html: shell(brand, inner, L, d.cliente), text };
}
module.exports = { buildReport };
