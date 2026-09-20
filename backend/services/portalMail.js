// Correos del portal del cliente: plantillas con marca del cliente en ES / EN / DE / PT.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANGS = ['es', 'en', 'de', 'pt'];
const T = {
  es: {
    inviteSubj: c => `Ya tienes acceso a tu portal — ${c}`, resetSubj: c => `Tu nueva contraseña del portal — ${c}`, codeSubj: c => `Tu código de verificación — ${c}`,
    hiInvite: (n, c) => `Hola${n ? ' ' + n : ''}, ya puedes seguir en tiempo real cómo avanza tu prospección en <b>${c}</b>.`,
    hiReset: n => `Hola${n ? ' ' + n : ''}, generamos una nueva contraseña temporal para tu portal.`,
    kUser: 'Usuario', kPass: 'Contraseña temporal', cta: 'Entrar al portal',
    perks: ['Resultados y reuniones en tiempo real', 'Empresas y contactos con su historial', 'Chat directo con tu equipo'],
    tip: 'Puedes crear tu propia contraseña cuando quieras, desde tu perfil en el portal.',
    link: 'Si el botón no funciona, copia este enlace en tu navegador:',
    codeTitle: 'Código de verificación', codeBody: c => `Usa este código para crear una nueva contraseña del portal de <b>${c}</b>. Vence en 15 minutos.`,
    codeText: 'Tu código de verificación es', codeExp: '(vence en 15 minutos)',
    foot: 'Mensaje automático, no respondas a este correo.',
  },
  en: {
    inviteSubj: c => `You now have access to your portal — ${c}`, resetSubj: c => `Your new portal password — ${c}`, codeSubj: c => `Your verification code — ${c}`,
    hiInvite: (n, c) => `Hi${n ? ' ' + n : ''}, you can now follow your outreach progress in real time at <b>${c}</b>.`,
    hiReset: n => `Hi${n ? ' ' + n : ''}, we generated a new temporary password for your portal.`,
    kUser: 'Username', kPass: 'Temporary password', cta: 'Open the portal',
    perks: ['Results and meetings in real time', 'Companies and contacts with their full history', 'Direct chat with your team'],
    tip: 'You can create your own password whenever you like, from your profile in the portal.',
    link: "If the button doesn't work, copy this link into your browser:",
    codeTitle: 'Verification code', codeBody: c => `Use this code to set a new password for the <b>${c}</b> portal. It expires in 15 minutes.`,
    codeText: 'Your verification code is', codeExp: '(expires in 15 minutes)',
    foot: 'Automated message, please do not reply.',
  },
  de: {
    inviteSubj: c => `Ihr Zugang zum Portal ist bereit — ${c}`, resetSubj: c => `Ihr neues Portal-Passwort — ${c}`, codeSubj: c => `Ihr Bestätigungscode — ${c}`,
    hiInvite: (n, c) => `Hallo${n ? ' ' + n : ''}, Sie können den Fortschritt Ihrer Ansprache bei <b>${c}</b> jetzt in Echtzeit verfolgen.`,
    hiReset: n => `Hallo${n ? ' ' + n : ''}, wir haben ein neues temporäres Passwort für Ihr Portal erstellt.`,
    kUser: 'Benutzername', kPass: 'Temporäres Passwort', cta: 'Zum Portal',
    perks: ['Ergebnisse und Termine in Echtzeit', 'Unternehmen und Kontakte mit vollständigem Verlauf', 'Direkter Chat mit Ihrem Team'],
    tip: 'Sie können jederzeit in Ihrem Profil ein eigenes Passwort festlegen.',
    link: 'Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:',
    codeTitle: 'Bestätigungscode', codeBody: c => `Mit diesem Code legen Sie ein neues Passwort für das Portal von <b>${c}</b> fest. Er ist 15 Minuten gültig.`,
    codeText: 'Ihr Bestätigungscode lautet', codeExp: '(15 Minuten gültig)',
    foot: 'Automatische Nachricht, bitte nicht antworten.',
  },
  pt: {
    inviteSubj: c => `Você já tem acesso ao seu portal — ${c}`, resetSubj: c => `Sua nova senha do portal — ${c}`, codeSubj: c => `Seu código de verificação — ${c}`,
    hiInvite: (n, c) => `Olá${n ? ' ' + n : ''}, agora você pode acompanhar em tempo real o andamento da sua prospecção em <b>${c}</b>.`,
    hiReset: n => `Olá${n ? ' ' + n : ''}, geramos uma nova senha temporária para o seu portal.`,
    kUser: 'Usuário', kPass: 'Senha temporária', cta: 'Entrar no portal',
    perks: ['Resultados e reuniões em tempo real', 'Empresas e contatos com todo o histórico', 'Chat direto com a sua equipe'],
    tip: 'Você pode criar sua própria senha quando quiser, no seu perfil dentro do portal.',
    link: 'Se o botão não funcionar, copie este link no seu navegador:',
    codeTitle: 'Código de verificação', codeBody: c => `Use este código para criar uma nova senha do portal de <b>${c}</b>. Ele expira em 15 minutos.`,
    codeText: 'Seu código de verificação é', codeExp: '(expira em 15 minutos)',
    foot: 'Mensagem automática, não responda a este e-mail.',
  },
};
const lum = hex => { const n = parseInt(String(hex || '#0B1220').slice(1), 16) || 0; const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const okHex = h => /^#[0-9a-f]{6}$/i.test(h || '');

// brand: { bg, hasLogo } — el logo va como imagen adjunta (cid:brandlogo)
function shell(brand, inner, L, cliente) {
  const bg = okHex(brand.bg) ? brand.bg : '#0B1220';
  const fg = lum(bg) > 0.45 ? '#0F172A' : '#FFFFFF';
  const head = brand.hasLogo
    ? `<img src="cid:brandlogo" alt="${esc(cliente)}" height="38" style="display:block;height:38px;max-width:220px;border:0">`
    : `<span style="font:700 20px Arial,sans-serif;color:${fg}">${esc(cliente)}</span>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EEF1F6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F6;padding:28px 12px"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #E1E6EC;font-family:Arial,Helvetica,sans-serif;color:#0F172A">
  <tr><td style="background:${bg};padding:22px 28px">${head}</td></tr>
  <tr><td style="padding:30px 28px 8px">${inner}</td></tr>
  <tr><td style="padding:18px 28px 26px;border-top:1px solid #EEF1F6;font-size:11.5px;color:#94A3B8;line-height:1.5">${esc(L.foot)}</td></tr>
  </table></td></tr></table></body></html>`;
}
const btn = (url, label, bg) => {
  const b = okHex(bg) ? bg : '#0B1220';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="background:${b}"><a href="${esc(url)}" style="display:inline-block;padding:13px 30px;color:${lum(b) > 0.45 ? '#0F172A' : '#FFFFFF'};font:700 14px Arial,sans-serif;text-decoration:none">${esc(label)}</a></td></tr></table>`;
};

// kind: 'invite' | 'reset' | 'code'; d: { nombre, cliente, to, pw, code, url, brand }
function build(kind, lang, d) {
  const L = T[LANGS.includes(lang) ? lang : 'es'], c = esc(d.cliente), brand = d.brand || {};
  if (kind === 'code') {
    const inner = `<h1 style="margin:0 0 12px;font-size:22px">${L.codeTitle}</h1><p style="margin:0 0 20px;font-size:14.5px;line-height:1.6;color:#334155">${L.codeBody(c)}</p>
      <div style="background:#F6F8FB;border:1px solid #E1E6EC;padding:18px;text-align:center;font:800 34px 'Courier New',monospace;letter-spacing:9px;color:#0F172A;margin-bottom:22px">${esc(d.code)}</div>`;
    return { subject: L.codeSubj(d.cliente), html: shell(brand, inner, L, d.cliente), text: `${L.codeText} ${d.code} ${L.codeExp}` };
  }
  const reset = kind === 'reset';
  const intro = reset ? L.hiReset(esc(d.nombre)) : L.hiInvite(esc(d.nombre), c);
  const perks = reset ? '' : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${L.perks.map(p => `<tr><td style="padding:3px 10px 3px 0;color:#0F172A;font-size:13.5px;vertical-align:top">✓</td><td style="padding:3px 0;font-size:13.5px;color:#334155;line-height:1.5">${esc(p)}</td></tr>`).join('')}</table>`;
  const inner = `<h1 style="margin:0 0 12px;font-size:22px">${esc(d.cliente)}</h1>
    <p style="margin:0 0 20px;font-size:14.5px;line-height:1.6;color:#334155">${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F8FB;border:1px solid #E1E6EC;margin:0 0 22px"><tr><td style="padding:16px 18px">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748B;margin-bottom:3px">${L.kUser}</div>
      <div style="font-size:15px;font-weight:700;margin-bottom:14px;word-break:break-all">${esc(d.to)}</div>
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748B;margin-bottom:3px">${L.kPass}</div>
      <div style="font:700 19px 'Courier New',monospace;letter-spacing:1px">${esc(d.pw)}</div></td></tr></table>
    ${btn(d.url, L.cta, brand.bg)}
    ${perks}
    <p style="margin:0 0 14px;font-size:13px;color:#64748B;line-height:1.55">${L.tip}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#94A3B8">${L.link}<br><a href="${esc(d.url)}" style="color:#64748B;word-break:break-all">${esc(d.url)}</a></p>`;
  return { subject: reset ? L.resetSubj(d.cliente) : L.inviteSubj(d.cliente), html: shell(brand, inner, L, d.cliente),
    text: `${d.cliente}\n${L.kUser}: ${d.to}\n${L.kPass}: ${d.pw}\n${d.url}\n${L.tip}` };
}
module.exports = { build, LANGS, lum };
