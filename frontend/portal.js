/* Portal del cliente — Nova. Solo lectura + chat. Habla con /api/portal/* (sesión propia). */
(function () {
  'use strict';
  const API = /^(localhost|127\.)/.test(location.hostname) ? 'http://localhost:3000/api' : 'https://api.novacentrax.com/api';
  const root = document.getElementById('pt-root');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { me: null, tab: 'inicio', range: '30d', seq: '', dash: null, hl: null, feed: null, seqs: null, cos: null, cts: null, q: '', co: 0, last: 0, timer: null, chatOpen: false, chat: [], chatLast: 0, unread: 0, charts: [], gran: 'auto' };
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  async function api(path, opt) {
    const r = await fetch(API + path, Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json' } }, opt || {}));
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
  const CH = { email: ['Email', '#2563EB', 'mail'], linkedin: ['LinkedIn', '#7C5CE0', 'in'], call: ['Llamada', '#F59E0B', 'phone'], whatsapp: ['WhatsApp', '#22A06B', 'chat'], otros: ['Otros / tareas', '#B8C0CC', 'dots'], reply: ['Respuesta', '#22A06B', 'reply'], meeting: ['Reunión', '#F59E0B', 'cal'], task: ['Seguimiento', '#94A3B8', 'dots'] };
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const fdate = (d, o) => { try { return new Date(d).toLocaleDateString('es-ES', o || { day: '2-digit', month: 'short' }); } catch (e) { return ''; } };
  const ago = d => { const m = Math.round((Date.now() - new Date(d)) / 60000); if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`; const h = Math.round(m / 60); if (h < 24) return `hace ${h} h`; return fdate(d); };

  // ── login ──
  function renderLogin(msg) {
    root.innerHTML = `<div class="pt-login"><form class="pt-login__card" id="pt-lf">
      <div class="pt-brand"><img src="logo-nova.svg" alt="">Nova</div>
      <h1>Portal del cliente</h1><p class="sub">Ingresa con el correo y la contraseña que te asignamos.</p>
      ${msg ? `<div class="${/actualizada/.test(msg) ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Correo electrónico</span><input id="pt-em" type="email" autocomplete="username" required></label>
      <label class="pt-f"><span>Contraseña</span><input id="pt-pw" type="password" autocomplete="current-password" required></label>
      <button class="pt-btn" id="pt-go" type="submit">Ingresar</button>
      <div style="text-align:center;margin-top:14px"><button type="button" class="pt-link" id="pt-fg">¿Olvidaste tu contraseña?</button></div></form></div>`;
    document.getElementById('pt-fg').onclick = () => renderForgot(1, document.getElementById('pt-em').value);
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
    root.innerHTML = `<div class="pt-login"><form class="pt-login__card" id="pt-ff">
      <div class="pt-brand"><img src="logo-nova.svg" alt="">Nova</div>
      <h1>Recuperar contraseña</h1><p class="sub">${step === 1 ? 'Te enviaremos un código de verificación a tu correo.' : 'Escribe el código que te llegó y elige una nueva contraseña (mínimo 10 caracteres).'}</p>
      ${msg ? `<div class="${ok ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Correo electrónico</span><input id="pt-fe" type="email" value="${esc(email || '')}" ${step === 2 ? 'readonly' : ''} required></label>
      ${step === 2 ? `<label class="pt-f"><span>Código de 6 dígitos</span><input id="pt-fc" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
      <label class="pt-f"><span>Nueva contraseña</span><input id="pt-fp" type="password" minlength="10" autocomplete="new-password" required></label>` : ''}
      <button class="pt-btn" type="submit">${step === 1 ? 'Enviar código' : 'Cambiar contraseña'}</button>
      <button class="pt-btn" type="button" id="pt-fb" style="background:#fff;color:#0F172A;border:1px solid #D9DEE3">Volver</button></form></div>`;
    document.getElementById('pt-fb').onclick = () => renderLogin();
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
    root.innerHTML = `<div class="pt-login"><form class="pt-login__card" id="pt-pf">
      <div class="pt-brand"><img src="logo-nova.svg" alt="">Nova</div>
      <h1>${first ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1><p class="sub">${first ? 'Por seguridad, elige una contraseña propia antes de continuar.' : 'Mínimo 10 caracteres.'}</p>
      ${msg ? `<div class="${ok ? 'pt-ok' : 'pt-err'}">${esc(msg)}</div>` : ''}
      <label class="pt-f"><span>Contraseña actual</span><input id="pt-p0" type="password" autocomplete="current-password" required></label>
      <label class="pt-f"><span>Nueva contraseña</span><input id="pt-p1" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="pt-f"><span>Repite la nueva contraseña</span><input id="pt-p2" type="password" autocomplete="new-password" minlength="10" required></label>
      <button class="pt-btn" type="submit">Guardar</button>${first ? '' : '<button class="pt-btn" type="button" id="pt-cx" style="background:#fff;color:#0F172A;border:1px solid #D9DEE3">Volver</button>'}</form></div>`;
    const cx = document.getElementById('pt-cx'); if (cx) cx.onclick = () => renderApp();
    document.getElementById('pt-pf').onsubmit = async e => {
      e.preventDefault();
      const a = document.getElementById('pt-p0').value, n = document.getElementById('pt-p1').value, n2 = document.getElementById('pt-p2').value;
      if (n !== n2) return renderChangePw(first, 'Las contraseñas nuevas no coinciden');
      try { await api('/portal/password', { method: 'POST', body: JSON.stringify({ actual: a, nueva: n }) }); S.me.must_change = false; renderApp(); start(); }
      catch (er) { renderChangePw(first, er.message); }
    };
  }

  // ── app ──
  async function boot() {
    try { S.me = await api('/portal/me'); } catch (e) { return renderLogin(); }
    if (S.me.must_change) return renderChangePw(true);
    renderApp(); start();
  }
  function tabs() {
    const s = S.me.sections, t = [['inicio', 'Resumen']];
    if (s.empresas) t.push(['empresas', 'Empresas']);
    if (s.contactos) t.push(['contactos', 'Contactos']);
    if (s.secuencias) t.push(['secuencias', 'Secuencias']);
    if (s.feed) t.push(['actividad', 'Actividad']);
    return t;
  }
  function renderApp() {
    stopCharts();
    root.innerHTML = `<div class="pt-top"><div class="pt-brand"><img src="logo-nova.svg" alt="">Nova</div><span class="pt-top__cl">${esc(S.me.cliente)}</span>
      <span class="pt-live"><i></i><span id="pt-upd">En vivo</span></span>
      <div class="pt-user"><button id="pt-um">${esc(S.me.nombre || S.me.email)} ▾</button><div class="pt-menu" id="pt-mn"><div class="em">${esc(S.me.email)}</div><button id="pt-cp">Cambiar contraseña</button><button id="pt-lo">Cerrar sesión</button></div></div></div>
      <div class="pt-nav">${tabs().map(t => `<button data-t="${t[0]}" class="${S.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
      <div class="pt-main" id="pt-body"></div>
      ${S.me.sections.chat ? `<button class="pt-chat-btn" id="pt-cb">${ico('chat', 18)} Chat rápido <span class="n" id="pt-cn" style="display:none"></span></button>
      <div class="pt-chat" id="pt-cw"><div class="pt-chat__h"><span>Chat con tu equipo</span><button id="pt-cc">✕</button></div><div class="pt-chat__b" id="pt-cm"></div><form class="pt-chat__f" id="pt-cf"><input id="pt-ci" placeholder="Escribe un mensaje…" maxlength="2000" autocomplete="off"><button>Enviar</button></form></div>` : ''}`;
    document.querySelectorAll('.pt-nav button').forEach(b => b.onclick = () => { S.tab = b.dataset.t; S.co = 0; S.q = ''; renderApp(); load(true); });
    const mn = document.getElementById('pt-mn');
    document.getElementById('pt-um').onclick = e => { e.stopPropagation(); mn.classList.toggle('on'); };
    document.addEventListener('click', () => mn && mn.classList.remove('on'));
    document.getElementById('pt-lo').onclick = async () => { try { await api('/portal/logout', { method: 'POST' }); } catch (e) {} S.me = null; stop(); renderLogin(); };
    document.getElementById('pt-cp').onclick = () => renderChangePw(false);
    if (S.me.sections.chat) {
      document.getElementById('pt-cb').onclick = () => { S.chatOpen = true; S.seenChat = S.chatLast; S.unread = 0; drawChat(); };
      document.getElementById('pt-cc').onclick = () => { S.chatOpen = false; drawChat(); };
      document.getElementById('pt-cf').onsubmit = sendChat;
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
        const [d, h, f, sq] = await Promise.all([api('/portal/dashboard?' + rangeQ()), api('/portal/highlights'), s.feed ? api('/portal/feed') : null, s.secuencias && !S.seqs ? api('/portal/sequences') : null]);
        S.dash = d; S.hl = h; S.feed = f; if (sq) S.seqs = sq;
      } else if (t === 'empresas') S.cos = await api('/portal/companies?q=' + encodeURIComponent(S.q));
      else if (t === 'contactos') S.cts = await api(`/portal/contacts?q=${encodeURIComponent(S.q)}&company=${S.co || 0}`);
      else if (t === 'secuencias') S.seqs = await api('/portal/sequences');
      else if (t === 'actividad') S.feed = await api('/portal/feed');
      S.last = Date.now(); paint();
      const u = document.getElementById('pt-upd'); if (u) u.textContent = 'En vivo · actualizado ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      if (S.me.sections.chat && force) pollChat();
    } catch (e) { const b = document.getElementById('pt-body'); if (b && !S.dash && !S.cos && !S.cts) b.innerHTML = `<div class="pt-empty">${esc(e.message)}</div>`; }
  }

  // ── pintar ──
  function paint() {
    const b = document.getElementById('pt-body'); if (!b) return;
    stopCharts();
    const t = S.tab;
    if (t === 'inicio') b.innerHTML = S.dash ? inicio() : '<div class="pt-empty">Cargando…</div>';
    else if (t === 'empresas') b.innerHTML = empresas();
    else if (t === 'contactos') b.innerHTML = contactos();
    else if (t === 'secuencias') b.innerHTML = secuencias();
    else if (t === 'actividad') b.innerHTML = `<div class="pt-h"><h2>Actividad en vivo</h2></div><div class="pt-card">${feedHtml(S.feed, 100)}</div>`;
    const se = document.getElementById('pt-search');
    if (se) { se.value = S.q; se.oninput = debounce(() => { S.q = se.value; load(false); }, 350); }
    if (t === 'inicio' && S.dash) initCharts();
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  window.PT = {
    range: r => { S.range = r; S.dash = null; paint(); load(false); },
    seq: v => { S.seq = v; S.dash = null; paint(); load(false); },
    gran: v => { S.gran = v; paint(); },
    goCo: id => { S.tab = 'contactos'; S.co = id; S.q = ''; renderApp(); load(true); },
  };

  const badge = (t) => { const c = /Reunión/.test(t) ? 'g' : /Interesado|Respondió|Más adelante/.test(t) ? 'b' : /No interesado|No califica|No contactar/.test(t) ? 'r' : /seguimiento|En pausa/i.test(t) ? 'a' : 'n'; return `<span class="pt-badge pt-b--${c}">${esc(t)}</span>`; };
  const person = r => `${esc(r.nombre)}${r.cargo ? ` <span style="color:#64748B;font-weight:500">· ${esc(r.cargo)}</span>` : ''}`;

  function highlightsHtml() {
    const h = S.hl; if (!h) return '';
    const dtag = d => { const x = new Date(d); return `<div class="pt-date"><b>${MES[x.getUTCMonth()].toUpperCase()}</b><span>${x.getUTCDate()}</span></div>`; };
    const money = (v, m) => v ? `${m === 'PEN' ? 'S/' : '$'}${Math.round(v).toLocaleString('es-ES')}` : '';
    const rep = h.last_replies.slice(0, 3).map(r => `<div class="pt-item"><div class="pt-item__t"><span>${person(r)}</span><span style="font-weight:500;color:#94A3B8;font-size:12px">${ago(r.fecha)}</span></div><div class="pt-item__s">${esc(r.empresa || '')}${r.pais ? ' · ' + esc(r.pais) : ''}</div>${r.snippet ? `<div class="pt-item__q">${esc(r.snippet)}</div>` : ''}${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div>`).join('');
    const mt = h.next_meetings.slice(0, 4).map(r => `<div class="pt-item" style="display:flex;gap:10px"><div>${dtag(r.fecha)}</div><div style="min-width:0;flex:1"><div class="pt-item__t"><span>${esc(r.empresa || '')}</span><span style="color:#15803D">${money(r.valor, r.moneda)}</span></div><div class="pt-item__s">${person(r)}</div>${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div></div>`).join('');
    const ps = h.positive_pending.slice(0, 5).map(r => `<div class="pt-item"><div class="pt-item__t"><span>${person(r)}</span>${badge(r.estado)}</div><div class="pt-item__s">${esc(r.empresa || '')}${r.ultima ? ' · respondió ' + ago(r.ultima) : ''}</div>${r.portal_nota ? `<div class="pt-item__n">${esc(r.portal_nota)}</div>` : ''}</div>`).join('');
    const s = S.me.sections;
    return `<div class="pt-hl">
      ${s.respuestas ? `<div class="pt-card"><h3>${ico('reply', 16)} Últimas respuestas</h3>${rep || '<div class="pt-empty">Aún sin respuestas</div>'}</div>` : ''}
      ${s.reuniones ? `<div class="pt-card"><h3>${ico('cal', 16)} Próximas reuniones <span class="pt-badge pt-b--g">${h.counts.reuniones_prog}</span></h3>${mt || '<div class="pt-empty">Ninguna reunión programada todavía</div>'}</div>` : ''}
      ${s.respuestas ? `<div class="pt-card"><h3>${ico('handshake', 16)} Señales positivas por convertir <span class="pt-badge pt-b--b">${h.positive_pending.length}</span></h3>${ps || '<div class="pt-empty">Sin señales pendientes</div>'}</div>` : ''}
    </div>`;
  }

  function inicio() {
    const d = S.dash, s = S.me.sections;
    const seg = [['7d', '7 días'], ['30d', '30 días'], ['mes', 'Este mes'], ['trim', 'Trimestre'], ['ytd', 'YTD']];
    const seqSel = S.seqs && s.secuencias ? `<label class="dash-f${S.seq ? ' is-on' : ''}" style="flex:none;min-width:200px"><select onchange="PT.seq(this.value)"><option value="">Todas las secuencias</option>${S.seqs.map(x => `<option value="${x.id}"${String(S.seq) === String(x.id) ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>` : '';
    const filters = `<div class="dash-filters" style="display:flex;gap:8px;flex-wrap:wrap"><div class="dash-seg">${seg.map(r => `<button class="dash-seg__b${S.range === r[0] ? ' on' : ''}" onclick="PT.range('${r[0]}')">${r[1]}</button>`).join('')}</div>${seqSel}</div>`;
    return `<div class="pt-dash">${highlightsHtml()}${filters}${dashBody(d)}${s.feed ? `<div class="pt-card" style="margin-top:14px"><h3>${ico('send', 16)} Actividad reciente</h3>${feedHtml(S.feed, 12)}</div>` : ''}</div>`;
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
        ${dl ? kpi('Reuniones / deals', dl.meetings, `<span class="dash-d dash-d--0">${dl.programadas ? dl.programadas + ' programada' + (dl.programadas > 1 ? 's' : '') + (dl.proximo ? ' · próx. ' + fdate(dl.proximo, { day: '2-digit', month: 'short', timeZone: 'UTC' }) : '') : 'sin programar'}</span>`, dl.valor ? `$${Math.round(dl.valor).toLocaleString('es-ES')} · pond. $${Math.round(dl.ponderado).toLocaleString('es-ES')}` : '') : ''}</div>`;
    }
    let row1 = '';
    if (d.daily && d.daily.length || d.funnel) {
      const used = ['email', 'linkedin', 'call', 'whatsapp', 'otros'].filter(k => (d.daily || []).some(r => r.ch === k));
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
      cards.push(`<div class="cp-card"><div class="cp-card__t">Países contactados</div><div class="dash-bars">${d.countries.slice(0, 6).map(r => `<div class="dash-bar"><span class="dash-bar__l">${esc(r.pais)}</span><div class="dash-bar__t"><div class="dash-bar__f" style="width:${Math.max(2, Math.round(r.contacted / mx * 100))}%"></div></div><span class="dash-bar__v">${pct(r.contacted, tot)}%</span></div>`).join('')}</div></div>`);
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
    const chs = ['email', 'linkedin', 'call', 'whatsapp', 'otros'].filter(k => (d.daily || []).some(r => r.ch === k));
    const ax = { x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 8, color: '#94A3B8', font: { size: 10 } } }, y: { stacked: true, beginAtZero: true, border: { display: false }, grid: { color: '#DDE3EA', borderDash: [3, 4], drawTicks: false }, ticks: { precision: 0, maxTicksLimit: 5, color: '#94A3B8', font: { size: 10 }, padding: 8 } } };
    const dc = document.getElementById('pt-daily');
    if (dc) S.charts.push(new Chart(dc.getContext('2d'), { type: 'bar', data: { labels: bk.map(x => x.slice(5)), datasets: chs.map(k => ({ label: CH[k][0], backgroundColor: CH[k][1], borderSkipped: false, barPercentage: .7, data: bk.map(b => d.daily.filter(r => r.ch === k && bo(r.d) === b).reduce((n, r) => n + r.n, 0)) })) }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip }, scales: ax } }));
    const cc = document.getElementById('pt-ch');
    if (cc && d.channels) S.charts.push(new Chart(cc.getContext('2d'), { type: 'doughnut', data: { labels: d.channels.map(r => (CH[r.ch] || CH.otros)[0]), datasets: [{ data: d.channels.map(r => r.touches), backgroundColor: d.channels.map(r => (CH[r.ch] || CH.otros)[1]), borderWidth: 2, borderColor: '#fff' }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { display: false }, tooltip: tip } } }));
  }

  function feedHtml(list, n) {
    if (!list || !list.length) return '<div class="pt-empty">Sin actividad todavía</div>';
    return `<div class="pt-feed">${list.slice(0, n).map(e => { const m = CH[e.canal] || CH.task; return `<div class="pt-ev"><span class="pt-ev__i" style="background:${m[1]}">${ico(m[2], 15)}</span><div><div class="pt-ev__t">${esc(e.texto)}</div><div class="pt-ev__s">${esc(e.nombre)}${e.cargo ? ' · ' + esc(e.cargo) : ''}${e.empresa ? ' — ' + esc(e.empresa) : ''}</div></div><span class="pt-ev__d">${ago(e.fecha)}</span></div>`; }).join('')}</div>`;
  }
  const search = ph => `<input class="pt-search" id="pt-search" placeholder="${ph}">`;
  function empresas() {
    const l = S.cos;
    return `<div class="pt-h"><h2>Empresas ${l ? `<span style="color:#94A3B8;font-weight:500;font-size:15px">(${l.length})</span>` : ''}</h2>${search('Buscar empresa…')}</div><div class="pt-card" style="padding:0;overflow:auto">${!l ? '<div class="pt-empty">Cargando…</div>' : !l.length ? '<div class="pt-empty">Sin empresas</div>' : `<table class="pt-tbl"><thead><tr><th>Empresa</th><th>País</th><th>Sector</th><th>Contactos</th><th>Estado</th><th>Nota</th></tr></thead><tbody>${l.map(r => `<tr><td><button class="pt-link" onclick="PT.goCo(${r.id})">${esc(r.nombre)}</button>${r.website ? `<div style="font-size:11.5px"><a href="${esc(/^https?:/.test(r.website) ? r.website : 'https://' + r.website)}" target="_blank" rel="noopener noreferrer">${esc(r.website.replace(/^https?:\/\//, ''))}</a></div>` : ''}</td><td>${esc(r.pais || '—')}</td><td>${esc(r.industria || '—')}</td><td>${r.contactos}</td><td>${badge(r.estado)}</td><td style="max-width:280px;color:#1E3A8A">${esc(r.nota || '')}</td></tr>`).join('')}</tbody></table>`}</div>`;
  }
  function contactos() {
    const l = S.cts;
    return `<div class="pt-h"><h2>Contactos ${l ? `<span style="color:#94A3B8;font-weight:500;font-size:15px">(${l.length})</span>` : ''}${S.co ? ` <button class="pt-link" onclick="PT.goCo(0)">✕ quitar filtro de empresa</button>` : ''}</h2>${search('Buscar contacto o empresa…')}</div><div class="pt-card" style="padding:0;overflow:auto">${!l ? '<div class="pt-empty">Cargando…</div>' : !l.length ? '<div class="pt-empty">Sin contactos</div>' : `<table class="pt-tbl"><thead><tr><th>Contacto</th><th>Cargo</th><th>Empresa</th><th>País</th><th>Estado</th><th>Secuencia</th><th>Último contacto</th><th>Nota</th></tr></thead><tbody>${l.map(r => `<tr><td><b>${esc(r.nombre)}</b>${r.linkedin ? ` <a href="${esc(/^https?:/.test(r.linkedin) ? r.linkedin : 'https://' + r.linkedin)}" target="_blank" rel="noopener noreferrer" title="LinkedIn">in</a>` : ''}</td><td>${esc(r.cargo || '—')}</td><td>${esc(r.empresa || '—')}</td><td>${esc(r.pais || '—')}</td><td>${badge(r.estado)}</td><td style="max-width:200px">${esc(r.secuencia || '—')}${r.paso ? ` <span style="color:#94A3B8">· paso ${r.paso}</span>` : ''}</td><td>${r.ultimo ? ago(r.ultimo) : '—'}</td><td style="max-width:260px;color:#1E3A8A">${esc(r.nota)}</td></tr>`).join('')}</tbody></table>`}</div>`;
  }
  function secuencias() {
    const l = S.seqs;
    return `<div class="pt-h"><h2>Secuencias</h2></div><div class="pt-card" style="padding:0;overflow:auto">${!l ? '<div class="pt-empty">Cargando…</div>' : !l.length ? '<div class="pt-empty">Sin secuencias</div>' : `<table class="pt-tbl"><thead><tr><th>Secuencia</th><th>Estado</th><th>Contactos</th><th>En curso</th><th>Completadas</th><th>Respondieron</th></tr></thead><tbody>${l.map(r => `<tr><td><b>${esc(r.nombre)}</b></td><td>${badge(r.estado === 'activa' ? 'En seguimiento' : 'En pausa')}</td><td>${r.enrolados}</td><td>${r.activos}</td><td>${r.terminados}</td><td>${r.respondieron}</td></tr>`).join('')}</tbody></table>`}</div>`;
  }

  // ── chat ──
  function drawChat() {
    const w = document.getElementById('pt-cw'), b = document.getElementById('pt-cb'); if (!w) return;
    w.classList.toggle('on', S.chatOpen); b.style.display = S.chatOpen ? 'none' : 'flex';
    const n = document.getElementById('pt-cn'); if (n) { n.style.display = S.unread && !S.chatOpen ? '' : 'none'; n.textContent = S.unread; }
    const m = document.getElementById('pt-cm');
    if (m) { const atEnd = m.scrollHeight - m.scrollTop - m.clientHeight < 60; m.innerHTML = S.chat.length ? S.chat.map(x => `<div class="pt-msg pt-msg--${x.autor === 'cliente' ? 'c' : 'e'}">${esc(x.texto)}<small>${x.autor === 'cliente' ? 'Tú' : esc(x.autor_nombre || 'Equipo')} · ${new Date(x.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('') : '<div class="pt-empty">Escríbenos aquí cualquier duda. Te respondemos lo antes posible.</div>'; if (atEnd || !S.chatDrawn) m.scrollTop = m.scrollHeight; S.chatDrawn = true; }
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
  async function sendChat(e) {
    e.preventDefault();
    const i = document.getElementById('pt-ci'), t = i.value.trim(); if (!t) return;
    i.value = '';
    try { const m = await api('/portal/chat', { method: 'POST', body: JSON.stringify({ texto: t }) }); S.chat.push(m); S.chatLast = m.id; S.seenChat = m.id; drawChat(); const b = document.getElementById('pt-cm'); if (b) b.scrollTop = b.scrollHeight; }
    catch (er) { i.value = t; alert(er.message); }
  }

  boot();
})();
