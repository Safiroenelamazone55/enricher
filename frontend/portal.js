/* Portal del cliente — Nova. Solo lectura + chat. Habla con /api/portal/* (sesión propia). */
(function () {
  'use strict';
  const API = /^(localhost|127\.)/.test(location.hostname) ? 'http://localhost:3000/api' : 'https://api.novacentrax.com/api';
  const root = document.getElementById('pt-root');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { me: null, tab: 'inicio', range: '30d', seq: '', dash: null, hl: null, feed: null, seqs: null, cos: null, cts: null, q: '', co: 0, last: 0, timer: null, chatOpen: false, chat: [], chatLast: 0, unread: 0, charts: [], gran: 'auto' };

  async function api(path, opt) {
    const o = opt || {};
    const r = await fetch(API + path, Object.assign({ credentials: 'include', headers: o.form ? {} : { 'Content-Type': 'application/json' } }, o));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && S.me) { S.me = null; stop(); renderLogin(); }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || 'Error'), { status: r.status });
    return j;
  }

  // ── iconos ──
  const ICO = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    reply: '<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>',
    mailopen: '<path d="M21.2 8.4c.5.4.8 1 .8 1.6v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8c0-.6.3-1.2.8-1.6l8-6a2 2 0 0 1 2.4 0z"/><path d="M22 10l-10 6L2 10"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
    handshake: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
  };
  const ico = (k, sz) => k === 'in' ? '<b class="dash-in">in</b>' : `<svg width="${sz || 18}" height="${sz || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICO[k] || ''}</svg>`;
  const CH = { email: ['Email', '#2563EB', 'mail'], linkedin: ['LinkedIn', '#7C5CE0', 'in'], call: ['Llamada', '#F59E0B', 'phone'], wa_msg: ['WhatsApp · mensajes', '#22A06B', 'chat'], wa_call: ['WhatsApp · llamadas', '#0EA5A4', 'phone'], whatsapp: ['WhatsApp', '#22A06B', 'chat'], otros: ['Otros / tareas', '#B8C0CC', 'dots'], reply: ['Respuesta', '#22A06B', 'reply'], meeting: ['Reunión', '#F59E0B', 'cal'], task: ['Seguimiento', '#94A3B8', 'dots'] };
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const fdate = (d, o) => { try { return new Date(d).toLocaleDateString(PT_I18N.locale(), o || { day: '2-digit', month: 'short' }); } catch (e) { return ''; } };
  const ago = d => { const m = Math.round((Date.now() - new Date(d)) / 60000); if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`; const h = Math.round(m / 60); if (h < 24) return `hace ${h} h`; return fdate(d); };

  // ── idioma ──
  function langBtn(cls) {
    const L = PT_I18N.LANGS;
    return `<div class="pt-lang ${cls || ''}"><button type="button" class="pt-lg" title="Idioma">${L[PT_I18N.lang].code} ▾</button><div class="pt-menu pt-lm">${Object.keys(L).map(k => `<button type="button" data-l="${k}" class="${k === PT_I18N.lang ? 'on' : ''}">${L[k].name}</button>`).join('')}</div></div>`;
  }
  function wireLang() {
    document.querySelectorAll('.pt-lang').forEach(box => {
      const menu = box.querySelector('.pt-lm');
      box.querySelector('.pt-lg').onclick = e => { e.stopPropagation(); menu.classList.toggle('on'); };
      menu.querySelectorAll('button').forEach(b => b.onclick = () => { PT_I18N.set(b.dataset.l, () => { if (S.redraw) S.redraw(); }); });
    });
  }
  document.addEventListener('click', () => document.querySelectorAll('.pt-lm.on').forEach(m => m.classList.remove('on')));

  // ── login ──
  async function loginBrand() {
    const u = parseUrl(); if (!u || !u.slug) return null;
    if (S.lb === undefined || S.lbSlug !== u.slug) { S.lbSlug = u.slug; try { S.lb = await api('/portal/login-brand/' + encodeURIComponent(u.slug)); } catch (e) { S.lb = null; } }
    return S.lb && S.lb.cliente ? S.lb : null;
  }
  async function renderLogin(msg) {
    S.redraw = () => renderLogin(msg);
    const lb = await loginBrand(), u0 = parseUrl();
    const fr = Object.assign({ s: 1, x: 0, y: 0 }, (lb && lb.frame) || {});
    const mark = lb ? (lb.logo ? `<div class="pt-lgbox" style="height:46px;width:170px"><img src="${API}/portal/login-logo/${encodeURIComponent(u0.slug)}?v=${lb.v}" alt="${esc(lb.cliente)}" style="transform:translate(${fr.x}%,${fr.y}%) scale(${fr.s})"></div>` : `<div class="pt-brand">${esc(lb.cliente)}</div>`) : '<div class="pt-brand"><img src="/logo-nova.svg" alt="">Nova</div>';
    root.innerHTML = `<div class="pt-login"${lb ? ` style="background:${esc(lb.header_bg)}"` : ''}><form class="pt-login__card" id="pt-lf">${langBtn('pt-lang--card')}
      ${mark}
      <h1>Portal del cliente</h1><p class="sub">Ingresa con el correo y la contraseña que te asignamos.</p>
      ${msg ? `<div class="${/actualizada/.test(msg) ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Correo electrónico</span><input id="pt-em" type="email" autocomplete="username" required></label>
      <label class="pt-f"><span>Contraseña</span><input id="pt-pw" type="password" autocomplete="current-password" required></label>
      <button class="pt-btn" id="pt-go" type="submit">Ingresar</button>
      <div style="text-align:center;margin-top:14px"><button type="button" class="pt-link" id="pt-fg">¿Olvidaste tu contraseña?</button></div></form></div>`;
    document.getElementById('pt-fg').onclick = () => renderForgot(1, document.getElementById('pt-em').value);
    wireLang();
    document.getElementById('pt-lf').onsubmit = async e => {
      e.preventDefault();
      const b = document.getElementById('pt-go'); b.disabled = true; b.textContent = 'Ingresando…';
      try {
        await api('/portal/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('pt-em').value, password: document.getElementById('pt-pw').value }) });
        boot();
      } catch (er) { renderLogin(er.message); }
    };
  }

  // Recuperar contraseña: 1) correo → 2) código que llega al correo + nueva contraseña
  function renderForgot(step, email, msg, ok) {
    S.redraw = () => renderForgot(step, email, msg, ok);
    root.innerHTML = `<div class="pt-login"><form class="pt-login__card" id="pt-ff">${langBtn('pt-lang--card')}
      <div class="pt-brand"><img src="/logo-nova.svg" alt="">Nova</div>
      <h1>Recuperar contraseña</h1><p class="sub">${step === 1 ? 'Te enviaremos un código de verificación a tu correo.' : 'Escribe el código que te llegó y elige una nueva contraseña (mínimo 10 caracteres).'}</p>
      ${msg ? `<div class="${ok ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Correo electrónico</span><input id="pt-fe" type="email" value="${esc(email || '')}" ${step === 2 ? 'readonly' : ''} required></label>
      ${step === 2 ? `<label class="pt-f"><span>Código de 6 dígitos</span><input id="pt-fc" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
      <label class="pt-f"><span>Nueva contraseña</span><input id="pt-fp" type="password" minlength="10" autocomplete="new-password" required></label>` : ''}
      <button class="pt-btn" type="submit">${step === 1 ? 'Enviar código' : 'Cambiar contraseña'}</button>
      <button class="pt-btn" type="button" id="pt-fb" style="background:#fff;color:#0F172A;border:1px solid #D9DEE3">Volver</button></form></div>`;
    document.getElementById('pt-fb').onclick = () => renderLogin();
    wireLang();
    document.getElementById('pt-ff').onsubmit = async e => {
      e.preventDefault();
      const em = document.getElementById('pt-fe').value;
      try {
        if (step === 1) { await api('/portal/forgot', { method: 'POST', body: JSON.stringify({ email: em }) }); renderForgot(2, em, 'Si el correo tiene acceso, te enviamos un código. Revisa también spam.', true); }
        else { await api('/portal/reset', { method: 'POST', body: JSON.stringify({ email: em, code: document.getElementById('pt-fc').value, nueva: document.getElementById('pt-fp').value }) }); renderLogin('Contraseña actualizada. Ya puedes ingresar.'); }
      } catch (er) { renderForgot(step, em, er.message); }
    };
  }

  function renderChangePw(first, msg, ok) {
    S.redraw = () => renderChangePw(first, msg, ok);
    root.innerHTML = `<div class="pt-login"><form class="pt-login__card" id="pt-pf">${langBtn('pt-lang--card')}
      <div class="pt-brand"><img src="/logo-nova.svg" alt="">Nova</div>
      <h1>${first ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1><p class="sub">${first ? 'Por seguridad, elige una contraseña propia antes de continuar.' : 'Mínimo 10 caracteres.'}</p>
      ${msg ? `<div class="${ok ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Contraseña actual</span><input id="pt-p0" type="password" autocomplete="current-password" required></label>
      <label class="pt-f"><span>Nueva contraseña</span><input id="pt-p1" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="pt-f"><span>Repite la nueva contraseña</span><input id="pt-p2" type="password" autocomplete="new-password" minlength="10" required></label>
      <button class="pt-btn" type="submit">Guardar</button>${first ? '' : '<button class="pt-btn" type="button" id="pt-cx" style="background:#fff;color:#0F172A;border:1px solid #D9DEE3">Volver</button>'}</form></div>`;
    wireLang();
    const cx = document.getElementById('pt-cx'); if (cx) cx.onclick = () => renderApp();
    document.getElementById('pt-pf').onsubmit = async e => {
      e.preventDefault();
      const a = document.getElementById('pt-p0').value, n = document.getElementById('pt-p1').value, n2 = document.getElementById('pt-p2').value;
      if (n !== n2) return renderChangePw(first, 'Las contraseñas nuevas no coinciden');
      try { await api('/portal/password', { method: 'POST', body: JSON.stringify({ actual: a, nueva: n }) }); S.me.must_change = false; S.me.pw_prompt = false; renderApp(); start(); }
      catch (er) { renderChangePw(first, er.message); }
    };
  }

  // ── app ──
  // ── URLs por cliente y sección: /portal/<cliente>/<sección>[/<id>] ──
  const SEC_URL = { inicio: 'resumen', reuniones: 'reuniones', empresas: 'empresas', contactos: 'contactos', secuencias: 'secuencias', actividad: 'actividad' };
  const URL_SEC = Object.fromEntries(Object.entries(SEC_URL).map(([k, v]) => [v, k]));
  function parseUrl() { const m = location.pathname.replace(/\/+$/, '').match(/^\/portal(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/); return m ? { slug: m[1] || '', sec: m[2] || '', id: parseInt(m[3]) || 0 } : null; }
  const tabUrl = tab => '/portal/' + S.me.slug + (tab === 'inicio' ? '' : '/' + SEC_URL[tab]);
  function setUrl(path, replace) { if (!S.me || S.noPush || location.pathname === path) return; try { history[replace ? 'replaceState' : 'pushState'](null, '', path); } catch (e) {} }
  window.addEventListener('popstate', () => {
    if (!S.me) return; const u = parseUrl(); if (!u) return;
    const t = u.sec ? URL_SEC[u.sec] : 'inicio'; if (!t || !tabs().some(x => x[0] === t)) return;
    S.noPush = true;
    try { if (t !== S.tab) { S.tab = t; S.co = 0; S.q = ''; renderApp(); load(true); } if (u.id && (t === 'empresas' || t === 'contactos')) { t === 'empresas' ? openCompany(u.id) : openContact(u.id); } else closeDrawer(); }
    finally { S.noPush = false; }
  });
  async function boot() {
    try { S.me = await api('/portal/me'); } catch (e) { return renderLogin(); }
    const u = parseUrl(); let openId = 0;
    if (u && u.sec && URL_SEC[u.sec] && tabs().some(x => x[0] === URL_SEC[u.sec])) { S.tab = URL_SEC[u.sec]; if (u.id && (S.tab === 'empresas' || S.tab === 'contactos')) openId = u.id; }
    setUrl(tabUrl(S.tab) + (openId ? '/' + openId : ''), true);
    renderApp(); start();
    if (openId) { if (S.tab === 'empresas') openCompany(openId); else openContact(openId); }
    try { if (S.me.lang && !localStorage.getItem('pt_lang') && S.me.lang !== PT_I18N.lang) PT_I18N.set(S.me.lang, () => S.redraw && S.redraw()); } catch (e) {}
    if (S.me.pw_prompt && !sessionStorage.getItem('pt_pw_skip')) showPwReminder();
  }
  function tabs() {
    const s = S.me.sections, t = [['inicio', 'Resumen']];
    if (s.reuniones) t.push(['reuniones', 'Reuniones']);
    if (s.empresas) t.push(['empresas', 'Empresas']);
    if (s.contactos) t.push(['contactos', 'Contactos']);
    if (s.secuencias) t.push(['secuencias', 'Secuencias']);
    if (s.feed) t.push(['actividad', 'Actividad']);
    return t;
  }
  // Aviso NO obligatorio para crear contraseña propia: más tarde (2 semanas, luego cada mes) u omitir
  function showPwReminder() {
    if (document.getElementById('pt-pwm')) return;
    const m = document.createElement('div'); m.id = 'pt-pwm'; m.className = 'pt-modal';
    m.innerHTML = `<div class="pt-modal__box"><button class="pt-modal__x" id="pt-pwx" title="Cerrar">✕</button><h3>Protege tu cuenta</h3><p>Entraste con una contraseña temporal. Te recomendamos crear la tuya propia cuando puedas.</p>
      <div class="pt-modal__b"><button class="pt-btn" id="pt-pw1" style="margin:0">Crear mi contraseña</button><button class="pt-btn" id="pt-pw2" style="margin:0;background:#fff;color:#0F172A;border:1px solid #D9DEE3">Recordármelo más tarde</button></div>
      <div style="text-align:center;margin-top:12px"><button class="pt-link" id="pt-pw3" style="color:#64748B;font-weight:500">Omitir y seguir</button></div></div>`;
    document.body.appendChild(m);
    const close = () => { m.remove(); };
    const skip = () => { try { sessionStorage.setItem('pt_pw_skip', '1'); } catch (e) {} close(); };
    document.getElementById('pt-pwx').onclick = skip; document.getElementById('pt-pw3').onclick = skip;
    document.getElementById('pt-pw1').onclick = () => { close(); renderChangePw(false); };
    document.getElementById('pt-pw2').onclick = async () => { try { await api('/portal/password/snooze', { method: 'POST' }); S.me.pw_prompt = false; } catch (e) {} close(); };
  }
  function renderApp() {
    S.redraw = renderApp;
    setUrl(tabUrl(S.tab));
    stopCharts();
    const br = S.me.branding || {}, hbg = br.header_bg || '#0B1220';
    const lum = (hex => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; })(/^#[0-9a-fA-F]{6}$/.test(hbg) ? hbg : '#0B1220');
    const hfg = lum > 0.45 ? '#0F172A' : '#FFFFFF';
    const fr = Object.assign({ s: 1, x: 0, y: 0 }, (br.frames || {})[br.logo_variant] || {});
    const clientMark = br.has && br.has[br.logo_variant]
      ? `<span class="pt-top__sep"></span><div class="pt-lgbox" title="${esc(S.me.cliente)}"><img src="${API}/portal/branding/logo?v=${br.v || 0}" alt="${esc(S.me.cliente)}" style="transform:translate(${fr.x}%,${fr.y}%) scale(${fr.s})"></div>`
      : `<span class="pt-top__cl">${esc(S.me.cliente)}</span>`;
    const brandMark = br.ws && br.ws.has ? `<div class="pt-brand pt-brand--logo"><img src="${API}/portal/branding/workspace-logo?v=${br.ws.v || 0}" alt="" style="filter:${lum > 0.45 ? 'brightness(0)' : 'none'}"></div>` : '<div class="pt-brand"><img src="/logo-nova.svg" alt="">Nova</div>';
    root.innerHTML = `<div class="pt-top" style="background:${hbg};color:${hfg}">${brandMark}${clientMark}
      <span class="pt-live"><i></i><span id="pt-upd">En vivo</span></span>${langBtn()}
      <div class="pt-user"><button id="pt-um">${esc(S.me.nombre || S.me.email)} ▾</button><div class="pt-menu" id="pt-mn"><div class="em">${esc(S.me.email)}</div><button id="pt-pf">Perfil</button><button id="pt-cp">Cambiar contraseña</button><button id="pt-lo">Cerrar sesión</button></div></div></div>
      <div class="pt-nav">${tabs().map(t => `<button data-t="${t[0]}" class="${S.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
      <div class="pt-main" id="pt-body"></div>
      ${S.me.sections.chat ? `<button class="pt-chat-btn" id="pt-cb">${ico('chat', 18)} Chat rápido <span class="n" id="pt-cn" style="display:none"></span></button>
      <div class="pt-chat" id="pt-cw"><div class="pt-chat__h"><span>Chat con tu equipo</span><button id="pt-cc">✕</button></div><div class="pt-chat__b" id="pt-cm"></div><div class="pt-chat__p" id="pt-cpend"></div><form class="pt-chat__f" id="pt-cf"><button type="button" class="pt-chat__a" id="pt-ca" title="Adjuntar foto o archivo">📎</button><input id="pt-ci" placeholder="Escribe un mensaje…" maxlength="2000" autocomplete="off"><button>Enviar</button></form><input type="file" id="pt-cfile" multiple hidden></div>` : ''}`;
    document.querySelectorAll('.pt-nav button').forEach(b => b.onclick = () => { S.tab = b.dataset.t; S.co = 0; S.q = ''; renderApp(); load(true); });
    wireLang();
    const mn = document.getElementById('pt-mn');
    document.getElementById('pt-um').onclick = e => { e.stopPropagation(); mn.classList.toggle('on'); };
    document.addEventListener('click', () => mn && mn.classList.remove('on'));
    document.getElementById('pt-lo').onclick = async () => { try { await api('/portal/logout', { method: 'POST' }); } catch (e) {} S.me = null; stop(); renderLogin(); };
    document.getElementById('pt-cp').onclick = () => renderChangePw(false);
    document.getElementById('pt-pf').onclick = () => {
      const m = document.createElement('div'); m.className = 'pt-modal'; m.onclick = ev => { if (ev.target === m) m.remove(); };
      m.innerHTML = `<form class="pt-modal__box"><h3>Perfil</h3><label class="pt-f"><span>Nombre</span><input id="pt-pfn" maxlength="120" value="${esc(S.me.nombre || '')}" required></label><label class="pt-f"><span>Correo electrónico</span><input value="${esc(S.me.email)}" disabled></label><div id="pt-pfe" class="pt-err" style="display:none"></div><div class="pt-modal__b"><button class="pt-btn" type="submit">Guardar</button><button type="button" class="pt-link" id="pt-pfx">Cancelar</button></div></form>`;
      root.appendChild(m); m.querySelector('#pt-pfx').onclick = () => m.remove(); m.querySelector('#pt-pfn').focus();
      m.querySelector('form').onsubmit = async ev => {
        ev.preventDefault();
        try { const r = await api('/portal/profile', { method: 'PATCH', body: JSON.stringify({ nombre: m.querySelector('#pt-pfn').value }) }); S.me.nombre = r.nombre; m.remove(); renderApp(); }
        catch (er) { const e = m.querySelector('#pt-pfe'); e.textContent = er.message; e.style.display = ''; }
      };
    };
    if (S.me.sections.chat) {
      document.getElementById('pt-cb').onclick = () => { S.chatOpen = true; S.seenChat = S.chatLast; S.unread = 0; drawChat(); };
      document.getElementById('pt-cc').onclick = () => { S.chatOpen = false; drawChat(); };
      document.getElementById('pt-cf').onsubmit = sendChat;
      const fi = document.getElementById('pt-cfile');
      document.getElementById('pt-ca').onclick = () => fi.click();
      fi.onchange = () => { addFiles(fi.files); fi.value = ''; };
      const cw = document.getElementById('pt-cw');
      document.getElementById('pt-ci').addEventListener('paste', e => { const fs2 = [...(e.clipboardData ? e.clipboardData.files : [])]; if (fs2.length) { e.preventDefault(); addFiles(fs2); } });
      cw.addEventListener('dragover', e => { e.preventDefault(); });
      cw.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
      drawChat();
    }
    paint();
  }

  // ── carga / tiempo real ──
  function start() { stop(); load(false); S.timer = setInterval(() => { if (!document.hidden) load(false); }, 20000); S.ctimer = setInterval(() => { if (!document.hidden && S.me && S.me.sections.chat) pollChat(); }, 4000); }
  function stop() { clearInterval(S.timer); clearInterval(S.ctimer); }
  function stopCharts() { S.charts.forEach(c => { try { c.destroy(); } catch (e) {} }); S.charts = []; }
  function rangeQ() {
    const iso = d => d.toISOString().slice(0, 10), now = new Date(), r = S.range;
    const back = n => { const d = new Date(now); d.setDate(d.getDate() - n + 1); return iso(d); };
    let f = back(30);
    if (r === '7d') f = back(7); else if (r === 'mes') f = iso(new Date(now.getFullYear(), now.getMonth(), 1)); else if (r === 'trim') f = iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)); else if (r === 'ytd') f = now.getFullYear() + '-01-01';
    return `from=${f}&to=${iso(now)}` + (S.seq ? `&sequence=${encodeURIComponent(S.seq)}` : '');
  }
  async function load(force) {
    if (!S.me) return;
    const t = S.tab, s = S.me.sections;
    try {
      if (t === 'inicio') {
        const r = perRanges(), q = (a, b) => `/portal/dashboard?from=${isoL(a)}&to=${isoL(b)}`;
        const [cur, prev, h, u, f, sq, stp, d] = await Promise.all([api(q(r.from, r.to)), api(q(r.pfrom, r.pto)), api('/portal/highlights'), api('/portal/updates'), s.feed ? api('/portal/feed') : null, s.secuencias && !S.seqs ? api('/portal/sequences') : null, s.secuencias ? api('/portal/steps') : null, S.detail ? api('/portal/dashboard?' + rangeQ()) : null]);
        S.wk = { cur, prev, r }; S.hl = h; S.upd = u; S.feed = f; S.steps = stp; if (sq) S.seqs = sq; S.dash = d;
      } else if (t === 'reuniones') S.meet = await api('/portal/meetings');
      else if (t === 'empresas') S.cos = await api('/portal/companies?q=' + encodeURIComponent(S.q));
      else if (t === 'contactos') S.cts = await api(`/portal/contacts?q=${encodeURIComponent(S.q)}&company=${S.co || 0}`);
      else if (t === 'secuencias') { const [a, b] = await Promise.all([api('/portal/sequences'), api('/portal/steps')]); S.seqs = a; S.steps = b; }
      else if (t === 'actividad') S.feed = await api('/portal/feed');
      S.last = Date.now(); paint();
      const u = document.getElementById('pt-upd'); if (u) u.textContent = 'En vivo · actualizado ' + new Date().toLocaleTimeString(PT_I18N.locale(), { hour: '2-digit', minute: '2-digit' });
      if (S.me.sections.chat && force) pollChat();
    } catch (e) { const b = document.getElementById('pt-body'); if (b && !S.dash && !S.cos && !S.cts) b.innerHTML = `<div class="pt-empty">${esc(e.message)}</div>`; }
  }

  // ── pintar ──
  function paint() {
    const b = document.getElementById('pt-body'); if (!b) return;
    stopCharts();
    const t = S.tab;
    if (t === 'inicio') b.innerHTML = S.hl ? inicio() : '<div class="pt-empty">Cargando…</div>';
    else if (t === 'reuniones') b.innerHTML = reuniones();
    else if (t === 'empresas') b.innerHTML = empresas();
    else if (t === 'contactos') b.innerHTML = contactos();
    else if (t === 'secuencias') b.innerHTML = secuencias();
    else if (t === 'actividad') b.innerHTML = `<div class="pt-h"><h2>Actividad en vivo</h2></div><div class="pt-card">${feedHtml(S.feed, 100)}</div>`;
    const se = document.getElementById('pt-search');
    if (se) { se.value = S.q; se.oninput = debounce(() => { S.q = se.value; load(false); }, 350); }
    if (t === 'inicio' && S.detail && S.dash) initCharts();
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  window.PT = {
    range: r => { S.range = r; S.dash = null; paint(); load(false); },
    seq: v => { S.seq = v; S.dash = null; paint(); load(false); },
    gran: v => { S.gran = v; paint(); },
    per: p => { S.per = p; try { localStorage.setItem('pt_per', p); } catch (e) {} S.wk = null; load(false); },
    detail: () => { S.detail = !S.detail; try { localStorage.setItem('pt_detail', S.detail ? '1' : '0'); } catch (e) {} if (S.detail && !S.dash) { paint(); load(false); } else paint(); },
    open: id => openContact(id), openCo: id => openCompany(id), close: () => closeDrawer(), drTab: (t, id) => drTab(t, id),
    cal: d => { if (d === 0) { const n = new Date(); S.cal = { y: n.getFullYear(), m: n.getMonth() }; } else { let m = S.cal.m + d, y = S.cal.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } S.cal = { y, m }; } paint(); },
    goMeet: () => { S.tab = 'reuniones'; renderApp(); load(true); },
    goSeq: () => { S.tab = 'secuencias'; renderApp(); load(true); },
    goCo: id => { S.tab = 'contactos'; S.co = id; S.q = ''; renderApp(); load(true); },
  };

  const badge = (t) => { const c = /Reunión/.test(t) ? 'g' : /Interesado|Respondió|Más adelante/.test(t) ? 'b' : /No interesado|No califica|No contactar/.test(t) ? 'r' : /seguimiento|En pausa/i.test(t) ? 'a' : 'n'; return `<span class="pt-badge pt-b--${c}">${esc(t)}</span>`; };
  const person = r => `${esc(r.nombre)}${r.cargo ? ` <span style="color:#64748B;font-weight:500">· ${esc(r.cargo)}</span>` : ''}`;

  function highlightsHtml() {
    const h = S.hl; if (!h) return '';
    const dtag = d => { const x = new Date(d); return `<div class="pt-date"><b>${x.toLocaleDateString(PT_I18N.locale(), { month: 'short', timeZone: 'UTC' }).replace('.', '').toUpperCase()}</b><span>${x.getUTCDate()}</span></div>`; };
    const money = (v, m) => v ? `${m === 'PEN' ? 'S/' : '$'}${Math.round(v).toLocaleString(PT_I18N.locale())}` : '';
    const rep = h.last_replies.slice(0, 3).map(r => `<div class="pt-item pt-click" onclick="PT.open(${r.contact_id})"><div class="pt-item__t"><span>${person(r)}</span><span style="font-weight:500;color:#94A3B8;font-size:12px">${ago(r.fecha)}</span></div><div class="pt-item__s">${esc(r.empresa || '')}${r.pais ? ' · ' + esc(r.pais) : ''}</div>${r.snippet ? `<div class="pt-item__q">${esc(r.snippet)}</div>` : ''}${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div>`).join('');
    const mt = h.next_meetings.slice(0, 4).map(r => `<div class="pt-item pt-click" style="display:flex;gap:10px" onclick="PT.open(${r.contact_id})"><div>${dtag(r.fecha)}</div><div style="min-width:0;flex:1"><div class="pt-item__t"><span>${esc(r.empresa || '')}</span><span style="color:#15803D">${money(r.valor, r.moneda)}</span></div><div class="pt-item__s">${person(r)}</div>${r.agendada ? `<div class="pt-item__s">Agendada el ${fdate(r.agendada)}</div>` : ''}${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div></div>`).join('');
    const ps = h.positive_pending.slice(0, 5).map(r => `<div class="pt-item pt-click" onclick="PT.open(${r.contact_id})"><div class="pt-item__t"><span>${person(r)}</span>${badge(r.estado)}</div><div class="pt-item__s">${esc(r.empresa || '')}${r.ultima ? ' · respondió ' + ago(r.ultima) : ''}</div>${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div>`).join('');
    const s = S.me.sections;
    return `<div class="pt-hl">
      ${s.respuestas ? `<div class="pt-card"><h3>${ico('reply', 16)} Últimas respuestas</h3>${rep || '<div class="pt-empty">Aún sin respuestas</div>'}</div>` : ''}
      ${s.reuniones ? `<div class="pt-card"><h3 style="justify-content:space-between"><span style="display:flex;gap:8px;align-items:center">${ico('cal', 16)} Próximas reuniones <span class="pt-badge pt-b--g">${h.counts.reuniones_prog}</span></span><button class="pt-link" onclick="PT.goMeet()">Ver calendario →</button></h3>${mt || '<div class="pt-empty">Ninguna reunión programada todavía</div>'}</div>` : ''}
      ${s.respuestas ? `<div class="pt-card"><h3>${ico('handshake', 16)} Señales positivas por convertir <span class="pt-badge pt-b--b">${h.positive_pending.length}</span></h3>${ps || '<div class="pt-empty">Sin señales pendientes</div>'}</div>` : ''}
    </div>`;
  }

  // ── Resumen: 1) mensaje del equipo 2) esta semana/mes 3) atención 4) cómo trabajamos 5) detalle (oculto por defecto) ──
  S.per = (function () { try { return localStorage.getItem('pt_per') === 'month' ? 'month' : 'week'; } catch (e) { return 'week'; } })();
  S.detail = (function () { try { return localStorage.getItem('pt_detail') === '1'; } catch (e) { return false; } })();
  const isoL = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function perRanges() {
    const now = new Date(); now.setHours(12, 0, 0, 0);
    if (S.per === 'month') {
      const f = new Date(now.getFullYear(), now.getMonth(), 1, 12), pf = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12);
      const pend = new Date(now.getFullYear(), now.getMonth(), 0, 12), pt = new Date(pf); pt.setDate(Math.min(now.getDate(), pend.getDate()));
      return { from: f, to: now, pfrom: pf, pto: pt };
    }
    const dow = (now.getDay() + 6) % 7, f = new Date(now); f.setDate(now.getDate() - dow);
    const pf = new Date(f); pf.setDate(f.getDate() - 7); const pt = new Date(pf); pt.setDate(pf.getDate() + dow);
    return { from: f, to: now, pfrom: pf, pto: pt };
  }
  const fshort = d => d.toLocaleDateString(PT_I18N.locale(), { day: 'numeric', month: 'short' });
  function dl(cur, prev) {
    if (!prev && !cur) return '<span class="dash-d dash-d--0">—</span>';
    const diff = prev ? Math.round((cur - prev) / prev * 100) : 100, cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '0';
    return `<span class="dash-d dash-d--${cls}">${diff > 0 ? '▲ +' : diff < 0 ? '▼ -' : '• '}${Math.abs(diff)}%${S.per === 'month' ? ' vs. mes anterior' : ' vs. semana anterior'}</span>`;
  }
  function updatesHtml() {
    const u = S.upd; if (!u || !u.length) return '';
    const one = (x, first) => `<div class="pt-upd${first ? '' : ' pt-upd--old'}"><div class="pt-upd__h"><b>${x.titulo ? esc(x.titulo) : 'Mensaje de tu equipo'}</b><span>${fdate(x.published_at, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div><div class="pt-upd__b">${esc(x.cuerpo)}</div></div>`;
    return `<div class="pt-upd-wrap">${one(u[0], true)}${u.length > 1 ? `<details class="pt-upd-more"><summary>Ver mensajes anteriores</summary>${u.slice(1).map(x => one(x, false)).join('')}</details>` : ''}</div>`;
  }
  function weekHtml() {
    const w = S.wk; if (!w || !w.cur.kpi) return '';
    const c = w.cur.kpi.cur, p = w.prev.kpi ? w.prev.kpi.cur : { contacted: 0, replies: 0, touches: 0 };
    const mc = w.cur.deals ? w.cur.deals.agendadas : null, mp = w.prev.deals ? w.prev.deals.agendadas : 0;
    const tiles = [['Contactos alcanzados', c.contacted, p.contacted, 'users', '#22A06B'], ['Respuestas', c.replies, p.replies, 'reply', '#F59E0B'], mc == null ? null : ['Reuniones agendadas', mc, mp, 'handshake', '#7C5CE0'], ['Toques realizados', c.touches, p.touches, 'send', '#2563EB']].filter(Boolean);
    const sent = `${c.contacted} contactos alcanzados · ${c.replies} respuestas${mc == null ? '' : ' · ' + mc + (mc === 1 ? ' reunión agendada' : ' reuniones agendadas')}`;
    return `<div class="pt-week"><div class="pt-week__h"><div><h2>${S.per === 'month' ? 'Este mes' : 'Esta semana'}</h2><span class="pt-week__r">${fshort(w.r.from)} – ${fshort(w.r.to)}</span></div>
      <div class="dash-seg"><button class="dash-seg__b${S.per === 'week' ? ' on' : ''}" onclick="PT.per('week')">Semana</button><button class="dash-seg__b${S.per === 'month' ? ' on' : ''}" onclick="PT.per('month')">Mes</button></div></div>
      <div class="pt-week__k">${tiles.map(t => `<div class="pt-tile" style="--kc:${t[4]}"><span class="pt-tile__i">${ico(t[3], 18)}</span><div><div class="pt-tile__l">${t[0]}</div><div class="pt-tile__v">${t[1]}</div>${dl(t[1], t[2])}</div></div>`).join('')}</div>
      <p class="pt-week__s">${sent}</p></div>`;
  }
  const STEP_ICO = { linkedin: ['in', '#7C5CE0'], email: ['mail', '#2563EB'], whatsapp: ['chat', '#22A06B'], call: ['phone', '#F59E0B'], task: ['dots', '#94A3B8'] };
  function stepsHtml(q) {
    const tot = q.total || 1;
    return `<div class="pt-steps">${q.steps.map(s => { const m = STEP_ICO[s.canal] || STEP_ICO.task; return `<div class="pt-step"><span class="pt-step__i" style="background:${m[1]}">${ico(m[0], 14)}</span><div class="pt-step__b"><div class="pt-step__t"><b>${s.label}</b><span>Día ${s.dia}</span></div><div class="pt-step__bar"><i style="width:${Math.max(s.reached ? 3 : 0, Math.round(s.reached / tot * 100))}%;background:${m[1]}"></i></div><div class="pt-step__n">${s.reached} completados${s.current ? ' · ' + s.current + ' en este paso' : ''}</div></div></div>`; }).join('')}</div>`;
  }
  const seqBadge = e => e === 'activa' ? '<span class="pt-badge pt-b--g">Activa</span>' : '<span class="pt-badge pt-b--n">En pausa</span>';
  function howHtml() {
    const st = S.steps; if (!st || !st.length) return '';
    const list = st.slice().sort((a, b) => (b.estado === 'activa') - (a.estado === 'activa') || b.total - a.total).slice(0, 2);
    return `<div class="pt-how"><div class="pt-how__h"><h3>Cómo trabajamos</h3>${st.length > 2 ? '<button class="pt-link" onclick="PT.goSeq()">Ver todas las secuencias →</button>' : ''}</div>
      <div class="pt-how__g">${list.map(q => `<div class="pt-card"><div class="pt-item__t"><span>${esc(q.nombre)}</span>${seqBadge(q.estado)}</div><div class="pt-item__s">${q.total} contactos</div>${stepsHtml(q)}</div>`).join('')}</div></div>`;
  }
  function inicio() {
    const s = S.me.sections;
    const seg = [['7d', '7 días'], ['30d', '30 días'], ['mes', 'Este mes'], ['trim', 'Trimestre'], ['ytd', 'YTD']];
    const seqSel = S.seqs && s.secuencias ? `<label class="dash-f${S.seq ? ' is-on' : ''}" style="flex:none;min-width:200px"><select onchange="PT.seq(this.value)"><option value="">Todas las secuencias</option>${S.seqs.map(x => `<option value="${x.id}"${String(S.seq) === String(x.id) ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>` : '';
    const filters = `<div class="dash-filters" style="display:flex;gap:8px;flex-wrap:wrap"><div class="dash-seg">${seg.map(r => `<button class="dash-seg__b${S.range === r[0] ? ' on' : ''}" onclick="PT.range('${r[0]}')">${r[1]}</button>`).join('')}</div>${seqSel}</div>`;
    const detail = S.detail ? (S.dash ? `${filters}${dashBody(S.dash)}${s.feed ? `<div class="pt-card" style="margin-top:14px"><h3>${ico('send', 16)} Actividad reciente</h3>${feedHtml(S.feed, 12)}</div>` : ''}` : '<div class="pt-empty">Cargando…</div>') : '';
    return `<div class="pt-dash">${updatesHtml()}${weekHtml()}${highlightsHtml()}${s.secuencias ? howHtml() : ''}
      <div class="pt-more"><button class="pt-morebtn" onclick="PT.detail()">${S.detail ? 'Ocultar detalle ▴' : 'Ver detalle ▾'}</button></div>${detail}</div>`;
  }

  function delta(cur, prev, pts) {
    if (prev == null || (!prev && !cur)) return '<span class="dash-d dash-d--0">— vs. período anterior</span>';
    const diff = pts ? Math.round((cur - prev) * 10) / 10 : (prev ? Math.round((cur - prev) / prev * 100) : 100);
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '0';
    return `<span class="dash-d dash-d--${cls}">${diff > 0 ? '▲ +' : diff < 0 ? '▼ -' : '• '}${Math.abs(diff)}${pts ? ' pts' : '%'} vs. período anterior</span>`;
  }
  function dashBody(d) {
    if (!d) return '';
    let out = '';
    if (d.kpi) {
      const c = d.kpi.cur, p = d.kpi.prev, rr = pct(c.replies, c.contacted), rrp = pct(p.replies, p.contacted), ar = pct(c.accepts, c.invites), arp = pct(p.accepts, p.invites);
      const KI = [['users', '#22A06B'], ['reply', '#F59E0B'], ['in', '#7C5CE0'], ['mail', '#2563EB'], ['mailopen', '#F59E0B'], ['handshake', '#22A06B']]; let ki = 0;
      const kpi = (l, v, dl, sub) => { const k = KI[ki++]; return `<div class="dash-kpi" style="--kc:${k[1]}"><div class="dash-kpi__top"><span class="dash-kpi__ic">${ico(k[0], 16)}</span><span class="dash-kpi__l">${l}</span></div><div class="dash-kpi__v">${v}</div>${dl}${sub ? `<div class="dash-kpi__s">${sub}</div>` : ''}</div>`; };
      const dl = d.deals;
      out += `<div class="dash-kpis">${kpi('Contactos alcanzados', c.contacted, delta(c.contacted, p.contacted), `${c.touches} toques en total`)}
        ${kpi('Tasa de respuesta', rr + '%', delta(rr, rrp, true), `${c.replies} respondieron`)}
        ${kpi('Aceptación LinkedIn', ar + '%', delta(ar, arp, true), `${c.accepts} de ${c.invites} invitaciones`)}
        ${kpi('Emails enviados', c.emails, delta(c.emails, p.emails), c.bounced ? `${c.bounced} rebotados` : 'sin rebotes')}
        ${kpi('Apertura email', c.sent ? pct(c.opened, c.sent) + '%' : '—', '<span class="dash-d dash-d--0">estimada</span>', `sobre ${c.sent} envíos`)}
        ${dl ? kpi('Reuniones agendadas', dl.agendadas, delta(dl.agendadas, dl.agendadas_prev), dl.programadas ? `${dl.programadas} próxima${dl.programadas > 1 ? 's' : ''}${dl.proximo ? ' · ' + fdate(dl.proximo, { day: '2-digit', month: 'short', timeZone: 'UTC' }) : ''}${dl.valor ? ' · $' + Math.round(dl.valor).toLocaleString(PT_I18N.locale()) : ''}` : 'ninguna programada') : ''}</div>`;
    }
    let row1 = '';
    if (d.daily && d.daily.length || d.funnel) {
      const used = ['email', 'linkedin', 'call', 'wa_msg', 'wa_call', 'otros'].filter(k => (d.daily || []).some(r => r.ch === k));
      const gran = S.gran === 'auto' ? (d.range.days > 60 ? 'week' : 'day') : S.gran;
      const actCard = d.daily && d.daily.length ? `<div class="cp-card"><div class="dash-card-h"><div class="cp-card__t">Actividad por canal</div><label class="dash-f dash-f--sm"><select onchange="PT.gran(this.value)"><option value="day"${gran === 'day' ? ' selected' : ''}>Diario</option><option value="week"${gran === 'week' ? ' selected' : ''}>Semanal</option></select></label></div><div class="dash-legend">${used.map(k => `<span class="dash-lg"><span class="dash-dot" style="background:${CH[k][1]}"></span>${CH[k][0]}</span>`).join('')}</div><div class="dash-chart"><canvas id="pt-daily"></canvas></div></div>` : '';
      let fun = '';
      if (d.funnel) {
        const fn = d.funnel, base = fn.enrolados || 1;
        const st = [['Enrolados', fn.enrolados, '#0F172A', 'users'], ['Contactados', fn.contactados, '#2563EB', 'send'], ['Respondieron', fn.respondieron, '#22A06B', 'reply'], ['Reunión', fn.reuniones, '#F59E0B', 'cal']];
        fun = `<div class="cp-card"><div class="cp-card__t">Embudo</div><div class="dash-funnel">${st.map((x, i) => `<div class="dash-fn"><span class="dash-fn__ic" style="background:${x[2]}">${ico(x[3], 16)}</span><div class="dash-fn__b"><div class="dash-fn__top"><span class="dash-fn__l">${x[0]}</span>${i ? `<span class="dash-fn__c">${pct(x[1], st[i - 1][1])}% ↓</span>` : ''}<span class="dash-fn__n">${x[1]}</span></div><div class="dash-fn__track"><div class="dash-fn__fill" style="width:${Math.max(2, Math.round(x[1] / base * 100))}%;background:${x[2]}"></div></div></div></div>`).join('')}</div></div>`;
      }
      row1 = `<div class="dash-row dash-row--a">${actCard}${fun}</div>`;
    }
    let row2 = '';
    const cards = [];
    if (d.channels && d.channels.length) {
      const tot = d.channels.reduce((n, r) => n + r.touches, 0);
      cards.push(`<div class="cp-card"><div class="cp-card__t">Toques por canal</div><div class="dash-donut"><div class="dash-donut__c"><canvas id="pt-ch"></canvas></div><table class="dash-leg"><tbody>${d.channels.map(r => { const m = CH[r.ch] || CH.otros; return `<tr><td><span class="dash-dot" style="background:${m[1]}"></span>${m[0]}</td><td>${pct(r.touches, tot)}%</td><td>${r.touches}</td></tr>`; }).join('')}<tr class="dash-leg__t"><td>Total</td><td></td><td>${tot}</td></tr></tbody></table></div></div>`);
    }
    if (d.countries && d.countries.length) {
      const tot = d.countries.reduce((n, r) => n + r.contacted, 0), mx = Math.max(1, ...d.countries.map(r => r.contacted));
      cards.push(`<div class="cp-card"><div class="cp-card__t">Países contactados</div><div class="dash-bars">${d.countries.slice(0, 6).map(r => `<div class="dash-bar"><span class="dash-bar__l">${esc(r.pais === 'Sin país' ? 'Unknown' : r.pais)}</span><div class="dash-bar__t"><div class="dash-bar__f" style="width:${Math.max(2, Math.round(r.contacted / mx * 100))}%"></div></div><span class="dash-bar__v">${pct(r.contacted, tot)}%</span></div>`).join('')}</div></div>`);
    }
    if (d.channels && d.channels.length) {
      const rc = {}; (d.replyByCh || []).forEach(r => { rc[r.ch] = r.replies; });
      const rows = d.channels.filter(r => r.contacted), tc = rows.reduce((n, r) => n + r.contacted, 0), tr = rows.reduce((n, r) => n + (rc[r.ch] || 0), 0);
      cards.push(`<div class="cp-card"><div class="cp-card__t">Respuesta por canal</div><div class="clients-table-wrap"><table class="clients-table"><thead><tr><th>Canal</th><th>Contactados</th><th>Respondieron</th><th>Tasa</th></tr></thead><tbody>${rows.map(r => { const m = CH[r.ch] || CH.otros, n = rc[r.ch] || 0, t = pct(n, r.contacted); return `<tr><td><span class="dash-cic" style="background:${m[1]}">${ico(m[2], 12)}</span>${m[0]}</td><td>${r.contacted}</td><td>${n}</td><td class="${t > 0 ? 'dash-good' : 'dash-zero'}">${t}%</td></tr>`; }).join('')}<tr class="dash-tot"><td>Total</td><td>${tc}</td><td>${tr}</td><td class="${tr ? 'dash-good' : 'dash-zero'}">${pct(tr, tc)}%</td></tr></tbody></table></div></div>`);
    }
    if (cards.length) row2 = `<div class="dash-row dash-row--b">${cards.join('')}</div>`;
    let seqT = '';
    if (d.sequences && d.sequences.length) {
      seqT = `<div class="cp-card" style="margin-top:14px"><div class="cp-card__t">Rendimiento por secuencia</div><div class="clients-table-wrap"><table class="clients-table"><thead><tr><th>Secuencia</th><th>Enrol.</th><th>Contact.</th><th>Resp.</th><th>Tasa</th><th>Reun.</th></tr></thead><tbody>${d.sequences.map(s => `<tr><td>${esc(s.nombre)}</td><td>${s.enrolados}</td><td>${s.contactados}</td><td>${s.respuestas}</td><td><b>${pct(s.respuestas, s.contactados)}%</b></td><td>${s.reuniones}</td></tr>`).join('')}</tbody></table></div></div>`;
    }
    return out + row1 + row2 + seqT;
  }
  function initCharts() {
    const d = S.dash; if (typeof Chart === 'undefined' || !d) return;
    const tip = { backgroundColor: '#0F172A', padding: 9, cornerRadius: 0 };
    const days = []; { const a = new Date(d.range.from + 'T00:00:00Z'), b = new Date(d.range.to + 'T00:00:00Z'); for (let x = new Date(a); x <= b && days.length < 400; x.setUTCDate(x.getUTCDate() + 1)) days.push(x.toISOString().slice(0, 10)); }
    const weekly = S.gran === 'auto' ? days.length > 60 : S.gran === 'week';
    const wk = x => { const t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
    const bk = weekly ? [...new Set(days.map(wk))] : days, bo = weekly ? wk : x => x;
    const chs = ['email', 'linkedin', 'call', 'wa_msg', 'wa_call', 'otros'].filter(k => (d.daily || []).some(r => r.ch === k));
    const ax = { x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 8, color: '#94A3B8', font: { size: 10 } } }, y: { stacked: true, beginAtZero: true, border: { display: false }, grid: { color: '#DDE3EA', borderDash: [3, 4], drawTicks: false }, ticks: { precision: 0, maxTicksLimit: 5, color: '#94A3B8', font: { size: 10 }, padding: 8 } } };
    const dc = document.getElementById('pt-daily');
    if (dc) S.charts.push(new Chart(dc.getContext('2d'), { type: 'bar', data: { labels: bk.map(x => x.slice(5)), datasets: chs.map(k => ({ label: PT_I18N.t(CH[k][0]), backgroundColor: CH[k][1], borderSkipped: false, barPercentage: .7, data: bk.map(b => d.daily.filter(r => r.ch === k && bo(r.d) === b).reduce((n, r) => n + r.n, 0)) })) }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip }, scales: ax } }));
    const cc = document.getElementById('pt-ch');
    if (cc && d.channels) S.charts.push(new Chart(cc.getContext('2d'), { type: 'doughnut', data: { labels: d.channels.map(r => PT_I18N.t((CH[r.ch] || CH.otros)[0])), datasets: [{ data: d.channels.map(r => r.touches), backgroundColor: d.channels.map(r => (CH[r.ch] || CH.otros)[1]), borderWidth: 2, borderColor: '#fff' }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { display: false }, tooltip: tip } } }));
  }

  function feedHtml(list, n) {
    if (!list || !list.length) return '<div class="pt-empty">Sin actividad todavía</div>';
    return `<div class="pt-feed">${list.slice(0, n).map(e => { const m = CH[e.canal] || CH.task; return `<div class="pt-ev"><span class="pt-ev__i" style="background:${m[1]}">${ico(m[2], 15)}</span><div><div class="pt-ev__t">${esc(e.texto)}</div><div class="pt-ev__s">${esc(e.nombre)}${e.cargo ? ' · ' + esc(e.cargo) : ''}${e.empresa ? ' — ' + esc(e.empresa) : ''}</div></div><span class="pt-ev__d">${ago(e.fecha)}</span></div>`; }).join('')}</div>`;
  }
  // ── Reuniones: calendario + lista, y ficha del contacto con su historial desde el momento 0 ──
  S.cal = (function () { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
  const dkey = d => { const x = new Date(d); return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0'); };
  const dlong = d => new Date(d).toLocaleDateString(PT_I18N.locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const money2 = (v, m) => v ? (m === 'PEN' ? 'S/' : m === 'EUR' ? '€' : '$') + Math.round(v).toLocaleString(PT_I18N.locale()) : '';
  const meetCls = e => e === 'ganado' ? 'g' : e === 'perdido' ? 'x' : 'b';
  function reuniones() {
    const list = S.meet;
    if (!list) return '<div class="pt-h"><h2>Reuniones</h2></div><div class="pt-empty">Cargando…</div>';
    const { y, m } = S.cal, first = new Date(Date.UTC(y, m, 1)), lead = (first.getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const by = {}; list.forEach(r => { (by[dkey(r.fecha)] = by[dkey(r.fecha)] || []).push(r); });
    const today = dkey(new Date()), monday = new Date(Date.UTC(2024, 0, 1));
    const wd = Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 864e5).toLocaleDateString(PT_I18N.locale(), { weekday: 'short', timeZone: 'UTC' }));
    let cells = ''; const total = Math.ceil((lead + days) / 7) * 7;
    for (let i = 0; i < total; i++) {
      const dn = i - lead + 1, inM = dn >= 1 && dn <= days, k = inM ? y + '-' + String(m + 1).padStart(2, '0') + '-' + String(dn).padStart(2, '0') : '';
      const ms = inM ? (by[k] || []) : [];
      cells += `<div class="pt-cal__c${inM ? '' : ' out'}${k === today ? ' today' : ''}"><span class="pt-cal__n">${inM ? dn : ''}</span>${ms.slice(0, 3).map(r => `<button class="pt-cal__e pt-cal__e--${meetCls(r.etapa)}" onclick="PT.open(${r.contact_id})" title="${esc(r.empresa || r.nombre)}">${esc(r.empresa || r.nombre)}</button>`).join('')}${ms.length > 3 ? `<span class="pt-cal__m">+${ms.length - 3}</span>` : ''}</div>`;
    }
    const label = first.toLocaleDateString(PT_I18N.locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const now = dkey(new Date()), up = list.filter(r => dkey(r.fecha) >= now), past = list.filter(r => dkey(r.fecha) < now).reverse();
    const row = r => `<div class="pt-mrow" onclick="PT.open(${r.contact_id})"><div class="pt-date"><b>${new Date(r.fecha).toLocaleDateString(PT_I18N.locale(), { month: 'short', timeZone: 'UTC' }).replace('.', '').toUpperCase()}</b><span>${new Date(r.fecha).getUTCDate()}</span></div>
      <div style="min-width:0;flex:1"><div class="pt-item__t"><span>${esc(r.empresa || '')}</span><span class="pt-badge pt-b--${r.etapa === 'ganado' ? 'g' : r.etapa === 'perdido' ? 'r' : 'b'}">${esc(r.etapa_label || '')}</span></div><div class="pt-item__s">${esc(r.nombre)}${r.cargo ? ' · ' + esc(r.cargo) : ''}</div>${r.valor ? `<div class="pt-item__s">${money2(r.valor, r.moneda)}${r.prob != null ? ' · ' + r.prob + '%' : ''}</div>` : ''}</div></div>`;
    return `<div class="pt-h"><h2>Reuniones</h2></div>
      <div class="pt-two pt-two--cal"><div class="pt-card"><div class="pt-cal__h"><button class="pt-morebtn" onclick="PT.cal(-1)">‹</button><b>${esc(label)}</b><button class="pt-morebtn" onclick="PT.cal(1)">›</button><button class="pt-morebtn" onclick="PT.cal(0)">Hoy</button></div>
        <div class="pt-cal"><div class="pt-cal__w">${wd.map(x => `<span>${esc(x)}</span>`).join('')}</div><div class="pt-cal__g">${cells}</div></div></div>
        <div class="pt-card"><h3>Próximas</h3>${up.length ? up.map(row).join('') : '<div class="pt-empty">Sin reuniones todavía</div>'}${past.length ? `<h3 style="margin-top:16px">Anteriores</h3>${past.slice(0, 20).map(row).join('')}` : ''}</div></div>`;
  }
  const EV_ICO = { linkedin: ['in', '#7C5CE0'], email: ['mail', '#2563EB'], whatsapp: ['chat', '#22A06B'], whatsapp_call: ['phone', '#0EA5A4'], call: ['phone', '#F59E0B'], task: ['dots', '#94A3B8'] };
  // Ficha con dos vistas conectadas: EMPRESA (historial único de todos sus contactos) y CONTACTO
  S.dr = null;
  function evHtml(e, withWho) {
    const when = new Date(e.fecha).toLocaleDateString(PT_I18N.locale(), { day: 'numeric', month: 'short', year: 'numeric' });
    const who = withWho && e.contact ? `<button class="pt-who" onclick="PT.drTab('contacto',${e.contact_id})">${esc(e.contact)}</button>` : '';
    let ic = ['dots', '#94A3B8'], body = '';
    if (e.kind === 'touch') { ic = EV_ICO[e.canal] || EV_ICO.task; body = `<b>${e.label}</b>${e.first ? ' <span class="pt-badge pt-b--p">Primer contacto</span>' : ''} ${who}`; }
    else if (e.kind === 'added') { ic = ['users', '#0F172A']; body = `<b>Se agregó a</b> ${withWho ? `<button class="pt-who" onclick="PT.drTab('contacto',${e.contact_id})">${esc(e.contact)}</button>` : ''}${e.cargo ? ' <span class="pt-item__s" style="display:inline">· ' + esc(e.cargo) + '</span>' : ''}${e.por ? `<div class="pt-item__s">Derivado por <button class="pt-who" onclick="PT.drTab('contacto',${e.por_id})">${esc(e.por)}</button></div>` : ''}${e.seq ? `<div class="pt-item__s">${esc(e.seq)}</div>` : ''}`; }
    else if (e.kind === 'reply') { ic = ['reply', '#22A06B']; body = `<b>Respondió</b> ${who}${e.text ? `<div class="pt-item__q">${esc(e.text)}</div>` : ''}`; }
    else if (e.kind === 'status') { ic = ['check', '#2563EB']; body = `<b>Estado</b> <span class="pt-badge pt-b--b">${esc(e.label)}</span> ${who}`; }
    else if (e.kind === 'booked') { ic = ['cal', '#F59E0B']; body = `<b>Reunión agendada</b> <span>Para el ${dlong(e.date)}</span> ${who}`; }
    else if (e.kind === 'meeting') { ic = ['cal', '#F59E0B']; body = `<b>Reunión</b> ${who}`; }
    else if (e.kind === 'note') { ic = ['chat', '#2563EB']; body = `<b>Nota de tu equipo</b> ${who}<div class="pt-item__n">${esc(e.text)}</div>`; }
    return `<div class="pt-tl"><span class="pt-tl__i" style="background:${ic[1]}">${ico(ic[0], 14)}</span><div class="pt-tl__b"><div class="pt-tl__t">${body}</div><div class="pt-tl__d">${when}</div></div></div>`;
  }
  function dealBox(dl) {
    return dl ? `<div class="pt-dr__deal"><div><span>Fecha de la reunión</span><b>${dlong(dl.fecha)}</b></div><div><span>Agendada el</span><b>${dlong(dl.agendada)}</b></div>${dl.valor ? `<div><span>Valor</span><b>${money2(dl.valor, dl.moneda)}</b></div>` : ''}${dl.prob != null ? `<div><span>Probabilidad</span><b>${dl.prob}%</b></div>` : ''}</div>` : '';
  }
  function notesBox(notes, withWho) { return notes.length ? `<h3 class="pt-dr__s">Notas y comentarios del deal</h3>${notes.map(n => `<div class="pt-item__n" style="margin-bottom:6px">${esc(n.texto)}<div class="pt-tl__d">${withWho && n.contact ? esc(n.contact) + ' · ' : ''}${new Date(n.fecha).toLocaleDateString(PT_I18N.locale(), { day: 'numeric', month: 'short' })}</div></div>`).join('')}` : ''; }
  function drBody() {
    const D = S.dr;
    if (D.tab === 'empresa') {
      const d = D.co; if (!d) return '<div class="pt-empty">Cargando…</div>';
      const c = d.company;
      const rows = d.contacts.map(k => `<div class="pt-mrow" onclick="PT.drTab('contacto',${k.id})"><div style="min-width:0;flex:1"><div class="pt-item__t"><span>${esc(k.nombre)}</span><span>${k.estado ? badge(k.estado) : (k.reunion ? badge('Reunión agendada') : '')}</span></div><div class="pt-item__s">${esc(k.cargo || '')}</div><div class="pt-item__s">Agregado el ${fdate(k.agregado, { day: 'numeric', month: 'short', year: 'numeric' })}${k.secuencia ? ' · ' + esc(k.secuencia) : ''}</div></div></div>`).join('');
      return `<div class="pt-dr__info">${c.website ? `<span>${esc(c.website.replace(/^https?:\/\//, ''))}</span>` : ''}${c.industria ? `<span>${esc(c.industria)}</span>` : ''}${c.ciudad ? `<span>${esc(c.ciudad)}</span>` : ''}${c.pais ? `<span>${esc(c.pais)}</span>` : ''}</div>
        ${dealBox(d.deal)}${d.deal && d.deal.contact ? `<div class="pt-item__s" style="margin:-6px 0 10px">Reunión con <button class="pt-who" onclick="PT.drTab('contacto',${d.deal.contact_id})">${esc(d.deal.contact)}</button></div>` : ''}
        ${notesBox(d.notes, true)}
        <h3 class="pt-dr__s">Contactos en la empresa (${d.contacts.length})</h3>${rows}
        <h3 class="pt-dr__s">Historial de la empresa</h3>${d.timeline.map(e => evHtml(e, true)).join('') || '<div class="pt-empty">Sin historial todavía</div>'}`;
    }
    const d = D.ct; if (!d) return '<div class="pt-empty">Cargando…</div>';
    const c = d.contact, seqTxt = c.secuencia ? `${esc(c.secuencia)}${c.paso ? ' · paso ' + c.paso : ''}` : '';
    return `<div class="pt-dr__badges">${c.estado ? badge(c.estado) : ''}${c.etapa && c.etapa !== 'Nuevo' && c.etapa !== c.estado ? `<span class="pt-badge pt-b--n">${esc(c.etapa)}</span>` : ''}${c.linkedin ? `<a class="pt-badge pt-b--p" href="${esc(/^https?:/.test(c.linkedin) ? c.linkedin : 'https://' + c.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>` : ''}</div>
      ${dealBox(d.deal)}${c.nota ? `<div class="pt-item__n" style="margin-bottom:10px">${esc(c.nota)}</div>` : ''}${notesBox(d.notes, false)}
      <div class="pt-dr__info">${c.pais ? `<span>${esc(c.pais)}</span>` : ''}${seqTxt ? `<span>${seqTxt}</span>` : ''}</div>
      <h3 class="pt-dr__s">Historial del contacto</h3>${d.timeline.map(e => evHtml(e, false)).join('') || '<div class="pt-empty">Sin historial todavía</div>'}`;
  }
  function drawerHtml() {
    const D = S.dr, hasCo = D.companyId, title = D.tab === 'empresa' ? (D.co ? D.co.company.nombre : '') : (D.ct ? D.ct.contact.nombre : '');
    const sub = D.tab === 'empresa' ? (D.co ? D.co.contacts.length + (D.co.contacts.length === 1 ? ' contacto' : ' contactos') : '') : (D.ct ? [D.ct.contact.cargo, D.ct.contact.empresa].filter(Boolean).join(' · ') : '');
    return `<div class="pt-dr-bg" onclick="PT.close()"></div><aside class="pt-dr"><div class="pt-dr__h"><div style="min-width:0"><h2>${esc(title)}</h2><div class="pt-item__s">${esc(sub)}</div></div><button class="pt-modal__x" style="position:static" onclick="PT.close()" title="Cerrar">✕</button></div>
      ${hasCo && D.hasContact ? `<div class="pt-dr__tabs"><button class="${D.tab === 'empresa' ? 'on' : ''}" onclick="PT.drTab('empresa')">Empresa</button><button class="${D.tab === 'contacto' ? 'on' : ''}" onclick="PT.drTab('contacto')">Contacto</button></div>` : ''}
      <div class="pt-dr__b">${drBody()}</div></aside>`;
  }
  function drPaint() { const b = document.getElementById('pt-drawer'); if (b && S.dr) b.innerHTML = drawerHtml(); }
  async function drLoadCompany(id) { try { S.dr.co = await api('/portal/company/' + id); } catch (e) { S.dr.co = null; S.dr.err = e.message; } }
  async function drLoadContact(id) { try { S.dr.ct = await api('/portal/contact/' + id); S.dr.contactId = id; } catch (e) { S.dr.ct = null; S.dr.err = e.message; } }
  function showDrawer() { closeDrawer(); const box = document.createElement('div'); box.id = 'pt-drawer'; root.appendChild(box); box.innerHTML = '<div class="pt-dr-bg" onclick="PT.close()"></div><aside class="pt-dr"><div class="pt-dr__b"><div class="pt-empty">Cargando…</div></div></aside>'; }
  // Abre desde un contacto: vista Empresa si tiene empresa, para ver todo el recorrido
  async function openContact(id) {
    showDrawer(); S.dr = { tab: 'contacto', contactId: id, hasContact: true }; setUrl('/portal/' + S.me.slug + '/contactos/' + id);
    await drLoadContact(id); if (!S.dr || S.dr.contactId !== id) return;
    if (S.dr.ct && S.dr.ct.contact.company_id) { S.dr.companyId = S.dr.ct.contact.company_id; S.dr.tab = 'empresa'; drPaint(); await drLoadCompany(S.dr.companyId); }
    if (!S.dr.ct && !S.dr.co) { const b = document.querySelector('#pt-drawer .pt-dr__b'); if (b) b.innerHTML = `<div class="pt-empty">${esc(S.dr.err || 'Error')}</div>`; return; }
    drPaint();
  }
  async function openCompany(id) {
    showDrawer(); S.dr = { tab: 'empresa', companyId: id, hasContact: false }; setUrl('/portal/' + S.me.slug + '/empresas/' + id);
    await drLoadCompany(id); if (!S.dr || S.dr.companyId !== id) return;
    if (!S.dr.co) { const b = document.querySelector('#pt-drawer .pt-dr__b'); if (b) b.innerHTML = `<div class="pt-empty">${esc(S.dr.err || 'Error')}</div>`; return; }
    drPaint();
  }
  async function drTab(tab, contactId) {
    if (!S.dr) return;
    if (tab === 'contacto' && contactId && contactId !== S.dr.contactId) { S.dr.hasContact = true; S.dr.tab = 'contacto'; S.dr.ct = null; S.dr.contactId = contactId; drPaint(); await drLoadContact(contactId); }
    S.dr.tab = tab; if (tab === 'contacto') S.dr.hasContact = true; drPaint();
    const b = document.querySelector('#pt-drawer .pt-dr__b'); if (b) b.scrollTop = 0;
  }
  function closeDrawer() { const b = document.getElementById('pt-drawer'); if (b) b.remove(); S.dr = null; if (S.me) setUrl(tabUrl(S.tab), true); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });


  const search = ph => `<input class="pt-search" id="pt-search" placeholder="${ph}">`;
  function empresas() {
    const l = S.cos;
    return `<div class="pt-h"><h2>Empresas ${l ? `<span style="color:#94A3B8;font-weight:500;font-size:15px">(${l.length})</span>` : ''}</h2>${search('Buscar empresa…')}</div><div class="pt-card" style="padding:0;overflow:auto">${!l ? '<div class="pt-empty">Cargando…</div>' : !l.length ? '<div class="pt-empty">Sin empresas</div>' : `<table class="pt-tbl pt-tbl--co"><thead><tr><th>Empresa</th><th>Sector</th><th>Contactos</th><th>Estado</th><th>Nota</th></tr></thead><tbody>${l.map(r => `<tr><td><button class="pt-link" onclick="PT.openCo(${r.id})">${esc(r.nombre)}</button>${r.website ? `<div style="font-size:11.5px"><a href="${esc(/^https?:/.test(r.website) ? r.website : 'https://' + r.website)}" target="_blank" rel="noopener noreferrer">${esc(r.website.replace(/^https?:\/\//, ''))}</a></div>` : ''}</td><td>${esc(r.industria || '—')}</td><td>${r.contactos}</td><td>${badge(r.estado)}</td><td style="max-width:280px;color:#1E3A8A">${esc(r.nota || '')}</td></tr>`).join('')}</tbody></table>`}</div>`;
  }
  function contactos() {
    const l = S.cts;
    return `<div class="pt-h"><h2>Contactos ${l ? `<span style="color:#94A3B8;font-weight:500;font-size:15px">(${l.length})</span>` : ''}${S.co ? ` <button class="pt-link" onclick="PT.goCo(0)">✕ quitar filtro de empresa</button>` : ''}</h2>${search('Buscar contacto o empresa…')}</div><div class="pt-card" style="padding:0;overflow:auto">${!l ? '<div class="pt-empty">Cargando…</div>' : !l.length ? '<div class="pt-empty">Sin contactos</div>' : `<table class="pt-tbl pt-tbl--ct"><thead><tr><th>Contacto</th><th>Cargo</th><th>Empresa</th><th>País</th><th>Estado</th><th>Secuencia</th><th>Último contacto</th><th>Nota</th></tr></thead><tbody>${l.map(r => `<tr><td><div class="pt-nm"><button class="pt-link" title="${esc(r.nombre)}" onclick="PT.open(${r.id})"><b>${esc(r.nombre)}</b></button>${r.linkedin ? `<a class="pt-in" href="${esc(/^https?:/.test(r.linkedin) ? r.linkedin : 'https://' + r.linkedin)}" target="_blank" rel="noopener noreferrer" title="LinkedIn"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>` : ''}</div></td><td title="${esc(r.cargo || '')}">${esc(r.cargo || '—')}</td><td title="${esc(r.empresa || '')}">${esc(r.empresa || '—')}</td><td>${esc(r.pais || '—')}</td><td>${badge(r.estado)}</td><td title="${esc(r.secuencia || '')}">${esc(r.secuencia || '—')}${r.paso ? ` <span style="color:#94A3B8">· paso ${r.paso}</span>` : ''}</td><td>${r.ultimo ? ago(r.ultimo) : '—'}</td><td title="${esc(r.nota || '')}" style="color:#1E3A8A">${esc(r.nota)}</td></tr>`).join('')}</tbody></table>`}</div>`;
  }
  function secuencias() {
    const l = S.seqs, st = S.steps || [];
    if (!l) return '<div class="pt-h"><h2>Secuencias</h2></div><div class="pt-empty">Cargando…</div>';
    if (!l.length) return '<div class="pt-h"><h2>Secuencias</h2></div><div class="pt-empty">Sin secuencias</div>';
    const byId = new Map(st.map(q => [q.id, q]));
    return `<div class="pt-h"><h2>Secuencias</h2></div><div class="pt-how__g pt-how__g--all">${l.map(r => { const q = byId.get(r.id); return `<div class="pt-card"><div class="pt-item__t"><span>${esc(r.nombre)}</span>${seqBadge(r.estado)}</div>
      <div class="pt-seqstats"><span><b>${r.enrolados}</b> Contactos</span><span><b>${r.activos}</b> En curso</span><span><b>${r.terminados}</b> Completadas</span><span><b>${r.respondieron}</b> Respondieron</span></div>${q ? stepsHtml(q) : ''}</div>`; }).join('')}</div>`;
  }
  // ── chat ──
  function drawChat() {
    const w = document.getElementById('pt-cw'), b = document.getElementById('pt-cb'); if (!w) return;
    w.classList.toggle('on', S.chatOpen); b.style.display = S.chatOpen ? 'none' : 'flex';
    const n = document.getElementById('pt-cn'); if (n) { n.style.display = S.unread && !S.chatOpen ? '' : 'none'; n.textContent = S.unread; }
    const m = document.getElementById('pt-cm');
    if (m) { const atEnd = m.scrollHeight - m.scrollTop - m.clientHeight < 60; m.innerHTML = S.chat.length ? S.chat.map(x => `<div class="pt-msg pt-msg--${x.autor === 'cliente' ? 'c' : 'e'}">${x.texto ? esc(x.texto) : ''}${attHtml(x)}<small>${x.autor === 'cliente' ? 'Tú' : esc(x.autor_nombre || 'Equipo')} · ${new Date(x.created_at).toLocaleTimeString(PT_I18N.locale(), { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('') : '<div class="pt-empty">Escríbenos aquí cualquier duda. Te respondemos lo antes posible.</div>'; if (atEnd || !S.chatDrawn) m.scrollTop = m.scrollHeight; S.chatDrawn = true; }
    if (S.chatOpen) { const i = document.getElementById('pt-ci'); if (i && document.activeElement !== i) i.focus(); }
  }
  async function pollChat() {
    try {
      const r = await api('/portal/chat?after=' + S.chatLast);
      if (r.messages.length) { S.chat = S.chat.concat(r.messages.filter(x => !S.chat.some(y => y.id === x.id))); S.chatLast = S.chat[S.chat.length - 1].id; }
      const unreadNow = S.chat.filter(x => x.autor === 'equipo' && x.id > (S.seenChat || 0)).length;
      S.unread = S.chatOpen ? 0 : unreadNow;
      if (S.chatOpen && S.chat.length) S.seenChat = S.chatLast;
      drawChat();
    } catch (e) {}
  }
  // ── adjuntos ──
  S.pend = [];
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  function attHtml(x) {
    if (!x.files || !x.files.length) return '';
    return '<div class="pt-att">' + x.files.map(f => /^image\/(png|jpe?g|gif|webp)$/i.test(f.mime)
      ? `<a href="${API}/portal/file/${f.id}" target="_blank" rel="noopener"><img class="pt-att__img" src="${API}/portal/file/${f.id}" alt="${esc(f.name)}" loading="lazy"></a>`
      : `<a class="pt-att__f" href="${API}/portal/file/${f.id}?dl=1" target="_blank" rel="noopener">📎 ${esc(f.name)} <small>${fmtSize(f.size)}</small></a>`).join('') + '</div>';
  }
  function drawPending() {
    const el = document.getElementById('pt-cpend'); if (!el) return;
    el.style.display = S.pend.length ? 'flex' : 'none';
    el.innerHTML = S.pend.map((f, i) => `<span class="pt-chip">${esc(f.name || 'imagen')} <small>${fmtSize(f.size)}</small> <button type="button" onclick="PT.unpend(${i})">✕</button></span>`).join('');
  }

  // Reduce fotos grandes (celular: 5–10 MB) antes de subirlas: máx. 2000 px, JPEG
  async function _shrinkImg(f) {
    if (!/^image\/(jpeg|png|webp)$/i.test(f.type) || f.size < 1.5 * 1048576) return f;
    try {
      const bmp = await createImageBitmap(f), k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (!b || b.size >= f.size) return f;
      return new File([b], (f.name || 'foto').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) { return f; }
  }
  async function addFiles(list) {
    for (let f of list) {
      f = await _shrinkImg(f);
      if (S.pend.length >= 5) { alert(PT_I18N.t('Máximo 5 archivos por mensaje')); break; }
      if (f.size > 15 * 1048576) { alert((f.name || 'Archivo') + ' supera 15 MB'); continue; }
      S.pend.push(f);
    }
    drawPending();
  }
  window.PT.unpend = i => { S.pend.splice(i, 1); drawPending(); };
  async function sendChat(e) {
    e.preventDefault();
    const inp = document.getElementById('pt-ci'), t = inp.value.trim(), files = S.pend.slice();
    if (!t && !files.length) return;
    inp.value = ''; S.pend = []; drawPending();
    const fd = new FormData(); fd.append('texto', t); files.forEach(f => fd.append('files', f, f.name || 'imagen.png'));
    try { const m = await api('/portal/chat', { method: 'POST', body: fd, form: true }); S.chat.push(m); S.chatLast = m.id; S.seenChat = m.id; drawChat(); const b = document.getElementById('pt-cm'); if (b) b.scrollTop = b.scrollHeight; }
    catch (er) { inp.value = t; S.pend = files; drawPending(); alert(er.message); }
  }

  PT_I18N.observe(root);
  boot();
})();
