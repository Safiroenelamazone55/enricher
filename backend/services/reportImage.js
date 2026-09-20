// Vista previa del informe semanal como imagen (PNG): las cifras y los bloques principales, listos para incrustar en el correo.
const X = {
  es: { eyebrow: 'Informe semanal', kTouch: 'Toques realizados', kReach: 'Contactos alcanzados', kRep: 'Respuestas', kMeet: 'Reuniones agendadas', hSeq: 'Secuencias activas', hSig: 'Buenas señales', hMeet: 'Próximas reuniones', none: 'Sin novedades', vs: 'vs. semana anterior' },
  en: { eyebrow: 'Weekly report', kTouch: 'Touches made', kReach: 'Contacts reached', kRep: 'Replies', kMeet: 'Meetings booked', hSeq: 'Active sequences', hSig: 'Positive signals', hMeet: 'Upcoming meetings', none: 'Nothing yet', vs: 'vs. previous week' },
  de: { eyebrow: 'Wochenbericht', kTouch: 'Kontaktpunkte', kReach: 'Erreichte Kontakte', kRep: 'Antworten', kMeet: 'Vereinbarte Termine', hSeq: 'Aktive Sequenzen', hSig: 'Positive Signale', hMeet: 'Anstehende Termine', none: 'Noch nichts', vs: 'ggü. Vorwoche' },
  pt: { eyebrow: 'Relatório semanal', kTouch: 'Contatos realizados', kReach: 'Contatos alcançados', kRep: 'Respostas', kMeet: 'Reuniões agendadas', hSeq: 'Sequências ativas', hSig: 'Bons sinais', hMeet: 'Próximas reuniões', none: 'Sem novidades', vs: 'vs. semana anterior' },
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const FONT = "font-family=\"DejaVu Sans, Arial, Helvetica, sans-serif\"";

function delta(cur, prev) {
  cur = +cur || 0; prev = +prev || 0;
  if (!prev && !cur) return { t: ' ', c: '#94A3B8' };
  if (!prev) return { t: `▲ +${cur}`, c: '#15803D' };
  const p = Math.round((cur - prev) / prev * 100);
  if (!p) return { t: '= 0%', c: '#94A3B8' };
  return p > 0 ? { t: `▲ +${p}%`, c: '#15803D' } : { t: `▼ ${p}%`, c: '#B45309' };
}

function svg(lang, d, accent) {
  const L = X[X[lang] ? lang : 'es'], W = 1040, H = 600;
  const k = d.kpi || {}, p = d.prev || {};
  const tiles = [[k.touches, p.touches, L.kTouch], [k.contacted, p.contacted, L.kReach], [k.replies, p.replies, L.kRep], [k.agendadas, p.agendadas, L.kMeet]].map(([cur, prev, label], i) => {
    const x = 40 + i * 245, dl = delta(cur, prev);
    return `<rect x="${x}" y="140" width="225" height="165" fill="#F6F8FB"/><rect x="${x}" y="140" width="225" height="6" fill="${accent}"/>
      <text x="${x + 112}" y="222" text-anchor="middle" ${FONT} font-size="60" font-weight="700" fill="#0F172A">${esc(cur || 0)}</text>
      <text x="${x + 112}" y="256" text-anchor="middle" ${FONT} font-size="17" fill="#64748B">${esc(cut(label, 22))}</text>
      <text x="${x + 112}" y="284" text-anchor="middle" ${FONT} font-size="16" font-weight="700" fill="${dl.c}">${esc(dl.t)}</text>`;
  }).join('');
  const seqs = d.seqs || [], sig = d.positives || [], meet = d.meetings || [];
  const line = (arr, y, x, f) => arr.slice(0, 3).map((v, i) => `<text x="${x}" y="${y + i * 30}" ${FONT} font-size="17" fill="#334155">• ${esc(cut(f(v), 27))}</text>`).join('');
  const panel = (i, title, n, lines) => {
    const x = 40 + i * 330;
    return `<rect x="${x}" y="335" width="300" height="230" fill="#FFFFFF" stroke="#E1E6EC" stroke-width="2"/>
      <text x="${x + 24}" y="375" ${FONT} font-size="17" font-weight="700" fill="#0F172A">${esc(cut(title, 26))}</text>
      <text x="${x + 24}" y="440" ${FONT} font-size="54" font-weight="700" fill="${accent}">${esc(n)}</text>
      ${lines || `<text x="${x + 24}" y="490" ${FONT} font-size="16" fill="#94A3B8">${esc(L.none)}</text>`}`;
  };
  const p1 = panel(0, L.hSeq, seqs.length, seqs.length ? line(seqs, 485, 64, s => s) : '');
  const p2 = panel(1, L.hSig, sig.length, sig.length ? line(sig, 485, 394, s => `${s.empresa || s.nombre}${s.estado ? ' · ' + s.estado : ''}`) : '');
  const p3 = panel(2, L.hMeet, meet.length, meet.length ? line(meet, 485, 724, m => `${m.dia || ''} ${m.mes || ''} · ${m.empresa || m.nombre}`) : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>
    <text x="40" y="62" ${FONT} font-size="15" font-weight="700" letter-spacing="2.5" fill="#64748B">${esc(L.eyebrow.toUpperCase())} · ${esc(String(d.rango || '').toUpperCase())}</text>
    <text x="40" y="112" ${FONT} font-size="38" font-weight="700" fill="#0F172A">${esc(cut(d.cliente, 34))}</text>
    ${tiles}
    <text x="40" y="325" ${FONT} font-size="13" fill="#94A3B8">${esc(L.vs)}</text>
    ${p1}${p2}${p3}
  </svg>`;
}

// PNG a doble resolución para que se vea nítido en pantallas retina
async function previewPng(lang, d, accent) {
  const sharp = require('sharp');
  return sharp(Buffer.from(svg(lang, d, accent)), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}
module.exports = { previewPng, svg };
