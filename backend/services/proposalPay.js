'use strict';
// Plantilla «Métodos de pago»: una hoja que se adapta a los métodos elegidos, en ES / EN / DE / PT.
const IDX = { es: 0, en: 1, de: 2, pt: 3 };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const logoOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);

// etiquetas de campos estándar (el valor lo escribe el usuario tal cual; las etiquetas sí se traducen)
const FIELDS = {
  holder: ['Titular de la cuenta', 'Account holder', 'Kontoinhaber', 'Titular da conta'],
  account: ['Número de cuenta', 'Account number', 'Kontonummer', 'Número da conta'],
  accountSimple: ['Cuenta simple', 'Simple account', 'Standardkonto', 'Conta simples'],
  cci: ['CCI', 'CCI', 'CCI', 'CCI'],
  type: ['Tipo de cuenta', 'Account type', 'Kontotyp', 'Tipo de conta'],
  routing: ['Número de ruta ACH', 'ACH routing number', 'ACH-Routing-Nummer', 'Número de roteamento ACH'],
  iban: ['IBAN', 'IBAN', 'IBAN', 'IBAN'],
  swift: ['SWIFT / BIC', 'SWIFT / BIC', 'SWIFT / BIC', 'SWIFT / BIC'],
  bank: ['Banco', 'Bank name', 'Bank', 'Banco'],
  address: ['Dirección del banco', 'Bank address', 'Bankadresse', 'Endereço do banco'],
  user: ['Usuario', 'Username', 'Benutzername', 'Usuário'],
  phone: ['Teléfono', 'Phone', 'Telefon', 'Telefone'],
  email: ['Correo', 'Email', 'E-Mail', 'E-mail'],
  link: ['Enlace', 'Link', 'Link', 'Link'],
};
const TYPES = { checking: ['Corriente', 'Checking', 'Girokonto', 'Corrente'], savings: ['Ahorros', 'Savings', 'Sparkonto', 'Poupança'] };
const MONEDAS = {
  USD: ['Dólares (USD)', 'US Dollars (USD)', 'US-Dollar (USD)', 'Dólares (USD)'],
  EUR: ['Euros (EUR)', 'Euros (EUR)', 'Euro (EUR)', 'Euros (EUR)'],
  PEN: ['Soles (PEN)', 'Peruvian Soles (PEN)', 'Peruanische Soles (PEN)', 'Soles (PEN)'],
  GBP: ['Libras (GBP)', 'Pounds Sterling (GBP)', 'Pfund Sterling (GBP)', 'Libras (GBP)'],
};
const FIELD_KEYS = Object.keys(FIELDS), MONEDA_KEYS = Object.keys(MONEDAS), TYPE_KEYS = Object.keys(TYPES);

function render(brand, p, lang, methods) {
  const li = IDX[lang] != null ? IDX[lang] : 0;
  const x = (...a) => (a[li] != null ? a[li] : a[0]);
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || '', mail = b.email || '', tel = b.telefono || '';
  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (el, orden) => { for (const k of [el, ...orden]) if (logoOk(logos[k])) return logos[k]; return ''; };
  const dataW = pick(b.logo_oscuro || 'blanco', ['blanco', 'color', 'negro']);
  const logo = dataW ? `<img class="lg" alt="${esc(marca)}" src="${dataW}">` : `<span class="lg wm">${esc(marca)}</span>`;

  const txt = (m, key) => {                       // texto del método en el idioma; si falta, cae al español (o al primero que exista)
    const t = m.textos || {};
    const o = t[lang] && t[lang][key] != null && (Array.isArray(t[lang][key]) ? t[lang][key].length : String(t[lang][key]).trim()) ? t[lang][key]
      : (t.es && t.es[key] != null ? t.es[key] : ((Object.values(t).find(v => v && v[key]) || {})[key]));
    return o == null ? (key === 'pasos' ? [] : '') : o;
  };
  const fieldHtml = f => {
    const label = f.k === 'custom' ? esc(f.label || '') : esc(FIELDS[f.k] ? FIELDS[f.k][li] : (f.label || ''));
    let v = String(f.value || '');
    if (f.k === 'type' && TYPES[v.toLowerCase()]) v = TYPES[v.toLowerCase()][li];
    let val = esc(v);
    if (f.k === 'link') { const u = /^https?:\/\//i.test(v) ? v : 'https://' + v; val = `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`; }
    return `<div class="fd${f.k === 'address' || f.k === 'iban' ? ' wide' : ''}">${label ? `<span class="fl">${label}</span>` : ''}<span class="fv${f.k === 'link' || f.k === 'phone' || f.k === 'user' ? ' big' : ''}">${val}</span></div>`;
  };
  const acctHtml = (a, single) => `<div class="ac">${a.moneda && MONEDAS[a.moneda] ? `<div class="am">${esc(MONEDAS[a.moneda][li])}</div>` : ''}${(a.fields || []).filter(f => String(f.value || '').trim()).map(fieldHtml).join('')}</div>`;

  const methodHtml = m => {
    const badge = txt(m, 'badge'), nota = txt(m, 'nota'), pasos = txt(m, 'pasos');
    const accts = m.accounts || [];
    return `<section class="mt${m.preferido ? ' pref' : ''}"><div class="mh"><b>${esc(m.nombre)}${m.preferido ? ` · ${x('Método preferido', 'Preferred method', 'Bevorzugte Methode', 'Método preferido')}` : ''}</b>${badge ? `<span class="bd">${esc(badge)}</span>` : ''}</div>
<div class="mb"><div class="ag${accts.length > 1 ? ' two' : ''}">${accts.map(a => acctHtml(a)).join('')}</div>
${nota ? `<div class="nt">${esc(nota)}</div>` : ''}
${pasos.length ? `<div class="hw">${x('Cómo enviar', 'How to send', 'So geht es', 'Como enviar')}</div><ol class="st">${pasos.map((t, i) => `<li><i>${i + 1}</i><span>${esc(t)}</span></li>`).join('')}</ol>` : ''}</div></section>`;
  };

  // pasos finales (los que marcas) + extras
  const contactoTxt = [mail && esc(mail), tel && esc(tel)].filter(Boolean);
  const after = [];
  const ps = p.pasos || {};
  if (ps.comprobante && (mail || tel)) after.push(x(
    `Envía el comprobante de pago a ${esc(mail || tel)}${mail && tel ? ' o por WhatsApp al ' + esc(tel) : ''}.`,
    `Send the proof of payment to ${esc(mail || tel)}${mail && tel ? ' or by WhatsApp to ' + esc(tel) : ''}.`,
    `Senden Sie den Zahlungsnachweis an ${esc(mail || tel)}${mail && tel ? ' oder per WhatsApp an ' + esc(tel) : ''}.`,
    `Envie o comprovante de pagamento para ${esc(mail || tel)}${mail && tel ? ' ou por WhatsApp para ' + esc(tel) : ''}.`));
  if (ps.referencia && p.ref) after.push(x(`Incluye en el mensaje la referencia: <b>${esc(p.ref)}</b>.`, `Include this reference in your message: <b>${esc(p.ref)}</b>.`, `Geben Sie in Ihrer Nachricht die Referenz an: <b>${esc(p.ref)}</b>.`, `Inclua na mensagem a referência: <b>${esc(p.ref)}</b>.`));
  if (ps.plazo) { const h = Math.max(1, parseInt(p.plazoHoras, 10) || 24); after.push(x(`Confirmaremos la recepción del pago en un plazo de ${h} horas hábiles.`, `We will confirm receipt of your payment within ${h} business hours.`, `Wir bestätigen den Zahlungseingang innerhalb von ${h} Geschäftsstunden.`, `Confirmaremos o recebimento do pagamento em até ${h} horas úteis.`)); }
  (Array.isArray(p.extra) ? p.extra : []).forEach(t => { if (String(t).trim()) after.push(esc(String(t).trim().slice(0, 300))); });

  const info = [];
  if (p.cliente) info.push([x('Preparado para', 'Prepared for', 'Erstellt für', 'Preparado para'), esc(p.cliente)]);
  if (p.monto) info.push([x('Monto a pagar', 'Amount due', 'Zu zahlender Betrag', 'Valor a pagar'), esc(p.monto)]);
  if (p.ref) info.push([x('Concepto / referencia', 'Reference', 'Verwendungszweck', 'Referência'), esc(p.ref)]);

  const title = x('Métodos de Pago', 'Payment Methods', 'Zahlungsmethoden', 'Métodos de Pagamento');
  const css = `:root{--navy:${dark};--teal:${prim};--tl:${light};--ink:#0B1220;--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB}
*{box-sizing:border-box;margin:0;padding:0}@page{size:A4;margin:0}html{background:#E9EDF2}
body{font-family:'Inter','Segoe UI',sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:32px 0 60px}
.sheet{width:816px;min-height:1056px;margin:0 auto;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.06),0 12px 40px rgba(15,23,42,.10)}
@media print{html,body{background:#fff;padding:0}.sheet{box-shadow:none;margin:0;width:100%}}
.top{background:var(--navy);display:flex;align-items:stretch;justify-content:space-between;min-height:132px;color:#fff}
.top .l{padding:40px 0 40px 56px;display:flex;align-items:center}.lg{height:34px;display:block}.wm{font-size:24px;font-weight:700;color:#fff;height:auto}
.top .t{display:flex;align-items:center;padding:0 24px;font-size:26px;font-weight:600;letter-spacing:-.02em;text-align:right;line-height:1.15}
.top .c{background:rgba(255,255,255,.06);padding:36px 40px 36px 28px;font-size:11px;line-height:1.7;text-align:right;color:rgba(255,255,255,.75);min-width:230px;display:flex;flex-direction:column;justify-content:center}.top .c b{color:var(--tl);font-weight:600;font-size:12px}
.bar{display:flex;height:34px}.bar i{display:block;flex:1}
.flow{width:100%;border-collapse:collapse}.flow td{padding:0 56px}.sp td{height:30px;padding:0}
.info{display:flex;gap:34px;flex-wrap:wrap;margin-bottom:22px;padding:14px 18px;background:var(--soft);border-left:3px solid var(--teal)}.info div{display:flex;flex-direction:column;gap:2px}.info span{font-size:10px;color:var(--mute);font-weight:500}.info b{font-size:14px;font-weight:600}
.mt{margin-bottom:26px;break-inside:avoid;page-break-inside:avoid}
.mh{display:flex;justify-content:space-between;align-items:stretch;background:var(--navy);color:#fff}.mh b{padding:12px 18px;font-size:14px;font-weight:600}
.mh .bd{background:#334155;padding:0 16px;display:flex;align-items:center;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;text-align:center}.pref .mh .bd{background:var(--teal)}
.mb{padding:16px 0 0}.ag{display:grid;grid-template-columns:1fr;gap:14px}.ag.two{grid-template-columns:1fr 1fr}
.ac{background:var(--soft);border-left:3px solid var(--teal);padding:14px 18px;display:flex;flex-direction:column;gap:9px}.ag.two .ac+.ac{border-left-color:#334155}
.am{font-size:12px;font-weight:600;color:var(--teal)}.ag.two .ac+.ac .am{color:var(--ink)}
.fd{display:flex;flex-direction:column;gap:1px}.fl{font-size:10px;color:var(--mute)}.fv{font-size:13.5px;font-weight:600;word-break:break-word}.fv.big{font-size:16px}.fv a{color:#1D4ED8}
.nt{margin-top:12px;font-size:10.5px;line-height:1.65;color:var(--text);background:var(--soft);padding:11px 14px}
.hw{margin-top:18px;font-size:10px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--teal)}
.st{list-style:none;margin-top:8px}.st li{display:grid;grid-template-columns:30px 1fr;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px;line-height:1.55;color:var(--text)}
.st i{width:24px;height:24px;background:var(--teal);color:#fff;font-style:normal;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}
.af{margin-bottom:22px;break-inside:avoid;page-break-inside:avoid}.af h3{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--teal);font-weight:600}
.ft{border-top:1px solid var(--line);padding:14px 0 0;text-align:center;font-size:11px;color:var(--mute);break-inside:avoid}.ft b{color:var(--ink);font-weight:600;margin-left:8px}`;
  const stripe = [light, prim, prim, dark].map((c, i) => `<i style="background:${c};flex:${[3, 2, 1.4, 2][i]};opacity:${i === 2 ? .8 : 1}"></i>`).join('');
  const html = `<div class="sheet"><div class="top"><div class="l">${logo}</div><div class="t">${esc(title)}</div><div class="c"><b>${esc(marca)}</b>${mail ? `<span>${esc(mail)}</span>` : ''}${tel ? `<span>${esc(tel)}</span>` : ''}</div></div><div class="bar">${stripe}</div>
<table class="flow"><thead><tr class="sp"><td></td></tr></thead><tfoot><tr class="sp"><td></td></tr></tfoot><tbody><tr><td>
${info.length ? `<div class="info">${info.map(r => `<div><span>${r[0]}</span><b>${r[1]}</b></div>`).join('')}</div>` : ''}
${methods.map(methodHtml).join('\n')}
${after.length ? `<div class="af"><h3>${x('Después de pagar', 'After you pay', 'Nach der Zahlung', 'Depois de pagar')}</h3><ol class="st">${after.map((t, i) => `<li><i>${i + 1}</i><span>${t}</span></li>`).join('')}</ol></div>` : ''}
${contactoTxt.length ? `<div class="ft">${x('¿Dudas con el pago? Escríbeme:', 'Questions about your payment? Write to me:', 'Fragen zur Zahlung? Schreiben Sie mir:', 'Dúvidas sobre o pagamento? Escreva-me:')}<b>${contactoTxt.join(' · ')}</b></div>` : ''}
</td></tr></tbody></table></div>`;
  return `<!DOCTYPE html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}${marca ? ' | ' + esc(marca) : ''}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"><style>${css}</style></head><body>${html}</body></html>`;
}

module.exports = { render, FIELD_KEYS, MONEDA_KEYS, TYPE_KEYS };
