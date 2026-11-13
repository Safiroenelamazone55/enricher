// Formulario de inicio del cliente (página pública, sin cuenta). El borrador se guarda en el servidor, asociado al enlace.
// Nada de lo que escribe el cliente se guarda en el navegador (solo el tema claro/oscuro).
(function () {
  const API = /^(localhost|127\.)/.test(location.hostname) ? 'http://localhost:3000/api' : 'https://api.novacentrax.com/api';
  const token = (location.pathname.split('/').filter(Boolean).pop() || '');
  const $ = id => document.getElementById(id);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/, URL_RE = /^https?:\/\/[^\s<>"']+$/i;
  const TX = {
    es: { title: 'Formulario de inicio', intro: 'Unos datos para arrancar tu piloto. Son unos 10 minutos: se guarda solo y puedes cerrar la página y volver a este mismo enlace cuando quieras.',
      prog: 'Campos obligatorios', req: 'Obligatorio', opt: 'Opcional', choose: 'Elige una opción…', send: 'Enviar', sending: 'Enviando…', saved: 'Guardado', saving: 'Guardando…', saveErr: 'No se pudo guardar. Reintentando…', secSaved: 'Guardada de forma segura. Escribe solo si quieres cambiarla.',
      eReq: 'Este campo es obligatorio.', eReqCk: 'Marca esta casilla para continuar.', eEmail: 'Escribe un correo válido (nombre@empresa.com).', eUrl: 'El enlace debe empezar por http:// o https://',
      sum: 'Faltan campos obligatorios. Revisa los marcados en rojo.', sumSrv: 'No se pudo enviar: revisa los campos marcados en rojo.',
      doneT: 'Recibido', doneP: 'Te escribo en las próximas 48 horas para la reunión de arranque de 30 minutos.', noT: 'Enlace no disponible', noP: 'Este enlace no está disponible. Si crees que es un error, pídeme uno nuevo.', netErr: 'Sin conexión con el servidor. Reintenta en un momento.' },
    en: { title: 'Start form', intro: 'A few details to start your pilot. It takes about 10 minutes: it saves automatically and you can close the page and come back to this same link anytime.',
      prog: 'Required fields', req: 'Required', opt: 'Optional', choose: 'Choose an option…', send: 'Submit', sending: 'Sending…', saved: 'Saved', saving: 'Saving…', saveErr: 'Could not save. Retrying…', secSaved: 'Saved securely. Type only if you want to change it.',
      eReq: 'This field is required.', eReqCk: 'Tick this box to continue.', eEmail: 'Enter a valid email (name@company.com).', eUrl: 'The link must start with http:// or https://',
      sum: 'Some required fields are missing. Check the ones marked in red.', sumSrv: 'Could not submit: check the fields marked in red.',
      doneT: 'Received', doneP: 'I will write to you within 48 hours to set up the 30-minute kick-off meeting.', noT: 'Link unavailable', noP: 'This link is not available. If you think this is a mistake, ask me for a new one.', netErr: 'No connection to the server. Please try again in a moment.' },
  };
  const S = { lang: 'es', secs: [], vals: {}, acs: {}, sec: {}, chg: new Set(), shown: new Set(), timer: null, busy: false, last: '' };
  const t = k => TX[S.lang][k];
  const campos = () => S.secs.flatMap(s => s.campos);
  const lb = c => c[S.lang] || c.es;
  const tx = o => (o ? (o[S.lang] || o.es) : '');

  // ── tema claro / oscuro (única cosa que se guarda en el navegador) ──
  function theme(v) { if (v) { document.documentElement.setAttribute('data-theme', v); try { localStorage.setItem('inicio_theme', v); } catch (_) {} } }
  try { const v = localStorage.getItem('inicio_theme'); if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v); } catch (_) {}
  $('th').onclick = () => { const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); theme(cur === 'dark' ? 'light' : 'dark'); };

  function pantalla(ic, titulo, texto, cls) {
    $('prog').hidden = true;
    $('m').innerHTML = `<div class="center"><div class="ic ${cls || ''}">${ic}</div><h1>${E(titulo)}</h1><p>${E(texto)}</p></div>`;
  }
  function noDisponible() {
    const es = /^es/i.test(navigator.language || 'es'), a = TX[es ? 'es' : 'en'], b = TX[es ? 'en' : 'es'];
    $('prog').hidden = true; document.title = 'NovaCentrax';
    $('m').innerHTML = `<div class="center"><div class="ic no">!</div><h1>${E(a.noT)}</h1><p>${E(a.noP)}</p><p style="margin-top:10px;font-size:14px;opacity:.8">${E(b.noT)} · ${E(b.noP)}</p></div>`;
  }

  // ── validación ──
  const lleno = c => (c.tipo === 'check' ? !!S.acs[c.id] : (String(S.vals[c.id] == null ? '' : S.vals[c.id]).trim() || (c.sensible && S.sec[c.id] && !S.chg.has(c.id) ? 'guardada' : '')));
  function errDe(c) {
    const v = lleno(c);
    if (c.req && !v) return c.tipo === 'check' ? t('eReqCk') : t('eReq');
    if (c.tipo === 'email' && v && !EMAIL_RE.test(v)) return t('eEmail');
    if (c.tipo === 'url' && v && !URL_RE.test(v)) return t('eUrl');
    return '';
  }
  function marca(c) {
    const box = document.querySelector(`.f[data-id="${c.id}"]`); if (!box) return;
    const e = S.shown.has(c.id) ? errDe(c) : '';
    box.classList.toggle('err', !!e); box.querySelector('.em').textContent = e;
    if (c.tipo === 'check') updAck();
  }
  function progreso() {
    const req = campos().filter(c => c.req); let n = 0;
    for (const c of req) { if (lleno(c)) n++; }
    const pct = req.length ? Math.round(n * 100 / req.length) : 0;
    $('pg-b').style.width = pct + '%'; $('pg-n').textContent = `${n}/${req.length} · ${pct} %`; $('pg-t').textContent = t('prog');
  }

  // ── disponibilidad para reuniones: opciones rápidas + personalizado (el valor sigue siendo el texto) ──
  const DISP = {
    es: ['Lunes a viernes, por la mañana (9:00–13:00)', 'Lunes a viernes, por la tarde (14:00–18:00)', 'Lunes a viernes, todo el día (9:00–18:00)', 'Martes a jueves, 10:00–13:00', 'Siempre coordinar antes (cada reunión se agenda previamente contigo)'],
    en: ['Monday to Friday, mornings (9:00–13:00)', 'Monday to Friday, afternoons (14:00–18:00)', 'Monday to Friday, all day (9:00–18:00)', 'Tuesday to Thursday, 10:00–13:00', 'Always coordinate first (each meeting is scheduled with you beforehand)'],
  };
  const dispHtml = (id, v, off) => {
    const L = DISP[S.lang] || DISP.es, en = S.lang === 'en', custom = !!(S.dispCustom || (v && !L.includes(v)));
    const cu = en ? 'Custom…' : 'Personalizado…', ph = en ? 'Choose an option…' : 'Elige una opción…';
    const lab = custom ? (en ? 'Custom' : 'Personalizado') : (v || ph);
    const caret = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    return `<div class="geo geo--dd" id="${id}-dd"><button type="button" class="geo__pre dd-btn${lab === ph ? ' dd-ph' : ''}" id="${id}-btn" aria-haspopup="listbox"><span>${E(lab)}</span>${caret}</button>
      <div class="geo__l" id="${id}-list" role="listbox" hidden>${L.map((x, i) => `<div class="geo__o${!custom && x === v ? ' on' : ''}" role="option" data-d="${i}">${E(x)}</div>`).join('')}<div class="geo__o${custom ? ' on' : ''}" role="option" data-d="c">${cu}</div></div></div>`
      + `<textarea id="${id}" maxlength="2000" ${off} ${custom ? '' : 'hidden'} placeholder="${E(en ? 'Write your days and hours (and time zone)' : 'Escribe tus días y horas (y zona horaria)')}">${E(v)}</textarea>`;
  };
  document.addEventListener('mousedown', e => {
    const dd = $('f-disp-dd'); if (!dd) return;
    const btn = e.target.closest && e.target.closest('#f-disp-btn'), opt = e.target.closest && e.target.closest('#f-disp-list .geo__o');
    const list = $('f-disp-list');
    if (btn) { e.preventDefault(); list.hidden = !list.hidden; return; }
    if (opt) {
      e.preventDefault();
      const ta = $('f-disp'), L = DISP[S.lang] || DISP.es, en = S.lang === 'en';
      if (opt.dataset.d === 'c') { S.dispCustom = true; if (L.includes(ta.value)) ta.value = ''; ta.hidden = false; $('f-disp-btn').firstElementChild.textContent = en ? 'Custom' : 'Personalizado'; setTimeout(() => ta.focus(), 0); }
      else { S.dispCustom = false; ta.value = L[+opt.dataset.d]; ta.hidden = true; $('f-disp-btn').firstElementChild.textContent = ta.value; }
      $('f-disp-btn').classList.remove('dd-ph');
      [...list.children].forEach(x => x.classList.toggle('on', x === opt)); list.hidden = true;
      ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (!dd.contains(e.target)) list.hidden = true;
  });

  // ── acuerdos: una sola casilla «acepto» y el detalle plegado (cada acuerdo sigue guardándose por separado) ──
  const ackT = () => (S.lang === 'en'
    ? { all: 'I have read and accept the pilot terms', more: n => `View the ${n} terms`, less: 'Hide the terms', err: 'Check this box to continue.' }
    : { all: 'He leído y acepto los acuerdos del piloto', more: n => `Ver los ${n} acuerdos`, less: 'Ocultar los acuerdos', err: 'Marca esta casilla para continuar.' });
  const acuerdosHtml = s => {
    const a = ackT(), todos = s.campos.every(c => S.acs[c.id]);
    return `<div class="f" data-id="ack-all"><label class="ck"><input type="checkbox" id="ack-all" ${todos ? 'checked' : ''}><span>${E(a.all)}</span></label><div class="em"></div></div>
      <button type="button" class="ackmore" id="ack-more" aria-expanded="false">${E(a.more(s.campos.length))} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="ackl" id="ack-list" hidden>${s.campos.map(campo).join('')}</div>`;
  };
  function updAck() {
    const cs = campos().filter(c => c.tipo === 'check'), all = $('ack-all'); if (!all) return;
    const ok = cs.every(c => S.acs[c.id]); all.checked = ok;
    const bad = !ok && cs.some(c => S.shown.has(c.id)), box = all.closest('.f');
    box.classList.toggle('err', bad); box.querySelector('.em').textContent = bad ? ackT().err : '';
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#ack-more'); if (!b) return;
    const l = $('ack-list'), open = l.hidden; l.hidden = !open; b.setAttribute('aria-expanded', open ? 'true' : 'false');
    const cs = campos().filter(c => c.tipo === 'check'), a = ackT();
    b.firstChild.textContent = (open ? a.less : a.more(cs.length)) + ' '; b.classList.toggle('open', open);
  });

  // ── pintado ──
  function campo(c) {
    const id = 'f-' + c.id, l = `<label class="l" for="${id}">${E(lb(c))}${c.req ? '<span class="rq" title="' + E(t('req')) + '"> *</span>' : ''}</label>`;
    const ayuda = c.ayuda ? `<p class="help">${E(tx(c.ayuda))}</p>` : '', ej = c.ej ? `<p class="ej">${E(tx(c.ej))}</p>` : '';
    const v = S.vals[c.id] == null ? '' : S.vals[c.id];
    const off = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other"';
    let ctl;
    if (c.tipo === 'check') {
      return `<div class="f" data-id="${c.id}"><label class="ck"><input type="checkbox" id="${id}" ${S.acs[c.id] ? 'checked' : ''}><span>${E(lb(c))}</span></label><div class="em"></div></div>`;
    } else if (c.id === 'disp') ctl = dispHtml(id, v, off);
    else if (c.tipo === 'long') ctl = `<textarea id="${id}" maxlength="2000" ${off}>${E(v)}</textarea>`;
    else if (c.tipo === 'select') ctl = `<select id="${id}"><option value="">${E(t('choose'))}</option>${c.opts.map(o => `<option value="${E(o.v)}"${o.v === v ? ' selected' : ''}>${E(o[S.lang] || o.es)}</option>`).join('')}</select>`;
    else {
      const type = c.tipo === 'email' ? 'email' : c.tipo === 'url' ? 'url' : 'text';   // las contraseñas son texto visible a propósito
      const im = c.tipo === 'email' ? 'email' : c.tipo === 'url' ? 'url' : 'text';
      ctl = `<input id="${id}" type="${type}" inputmode="${im}" maxlength="${c.tipo === 'url' ? 500 : 300}" value="${E(v)}" placeholder="${E(c.sensible && S.sec[c.id] && !S.chg.has(c.id) ? t('secSaved') : (c.ph || ''))}" ${c.tipo === 'secret' ? 'name="x' + Math.random().toString(36).slice(2) + '"' : ''} ${off}>`;
    }
    return `<div class="f" data-id="${c.id}">${l}${ctl}${ayuda}${ej}<div class="em"></div></div>`;
  }
  function paint() {
    document.documentElement.lang = S.lang; document.title = 'NovaCentrax · ' + t('title');
    $('l-es').classList.toggle('on', S.lang === 'es'); $('l-en').classList.toggle('on', S.lang === 'en');
    $('prog').hidden = false;
    $('m').innerHTML = `<div class="hero"><h1>${E(t('title'))}</h1><p>${E(t('intro'))}</p></div>
      ${S.secs.map((s, i) => `<section class="sec"><h2><b>${i + 1}</b>${E(tx(s.titulo))}</h2>${s.intro && !s.campos.some(c => c.tipo === 'check') ? `<p class="intro">${E(tx(s.intro))}</p>` : ''}${s.campos.some(c => c.tipo === 'check') ? acuerdosHtml({ campos: s.campos.filter(c => c.tipo === 'check') }) + s.campos.filter(c => c.tipo !== 'check').map(campo).join('') : s.campos.map(campo).join('')}</section>`).join('')}
      <div class="go"><div class="sum" id="sum"></div><button class="btn" id="go" type="button">${E(t('send'))}</button></div>`;
    $('m').oninput = e => ent(e); $('m').onchange = e => ent(e);
    $('m').onfocusout = e => { const f = e.target.closest && e.target.closest('.f'); if (f) { S.shown.add(f.dataset.id); const c = campos().find(x => x.id === f.dataset.id); if (c) marca(c); } guardar(); };
    $('go').onclick = enviar;
    if (window.GEO) {   // país / ciudad: desplegable con buscador; WhatsApp: prefijo desplegable que sigue al país
      const ph = GEO.phone($('f-wpp'), S.lang, v => { S.vals.wpp = v; });
      GEO.attach($('f-pais'), S.lang, (v, x) => { S.vals.pais = v; if (ph && x) ph.setCountry(x.cc); });
      if (ph && S.vals.pais && !S.vals.wpp) ph.setCountry(GEO.ccDe(S.vals.pais));
    }
    S.shown.forEach(id => { const c = campos().find(x => x.id === id); if (c) marca(c); });
    progreso();
  }
  function ent(e) {
    if (e.target && e.target.id === 'ack-all') {   // casilla única: marca o desmarca todos los acuerdos
      const cs = campos().filter(c => c.tipo === 'check');
      cs.forEach(c => { S.acs[c.id] = e.target.checked; S.shown.add(c.id); const i = $('f-' + c.id); if (i) i.checked = e.target.checked; });
      cs.forEach(marca); updAck(); progreso(); programar(); return;
    }
    const f = e.target.closest && e.target.closest('.f'); if (!f) return;
    const c = campos().find(x => x.id === f.dataset.id); if (!c) return;
    if (c.tipo === 'check') S.acs[c.id] = e.target.checked; else { S.vals[c.id] = e.target.value; if (c.sensible) S.chg.add(c.id); }
    if (e.type === 'change' || S.shown.has(c.id)) { S.shown.add(c.id); marca(c); }
    progreso(); programar();
  }

  // ── guardado automático del borrador en el servidor ──
  const estado = (m, bad) => { const el = $('sv'); el.textContent = m; el.classList.toggle('bad', !!bad); el.classList.add('show'); clearTimeout(estado.t); estado.t = setTimeout(() => el.classList.remove('show'), bad ? 4000 : 1600); };
  const cuerpo = () => ({ token, respuestas: Object.fromEntries(campos().filter(c => c.tipo !== 'check' && (!c.sensible || S.chg.has(c.id))).map(c => [c.id, S.vals[c.id] == null ? '' : S.vals[c.id]])), acuerdos: Object.fromEntries(campos().filter(c => c.tipo === 'check').map(c => [c.id, !!S.acs[c.id]])), idioma: S.lang });
  function programar() { clearTimeout(S.timer); S.timer = setTimeout(guardar, 1500); }
  async function guardar(unload) {
    clearTimeout(S.timer);
    const body = JSON.stringify(cuerpo()); if (body === S.last || S.busy) return;
    try {
      if (!unload) estado(t('saving'));
      const r = await fetch(`${API}/inicio/public/guardar`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!unload, credentials: 'omit', cache: 'no-store' });
      if (r.status === 404) { noDisponible(); return; }
      if (r.status === 409) { pantalla('✓', t('doneT'), t('doneP')); return; }
      if (!r.ok) throw new Error('http');
      S.last = body; if (!unload) estado(t('saved'));
    } catch (_) { if (!unload) { estado(t('saveErr'), true); S.timer = setTimeout(guardar, 4000); } }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.secs.length && !S.busy) guardar(true); });
  window.addEventListener('pagehide', () => { if (S.secs.length && !S.busy) guardar(true); });

  async function enviar() {
    campos().forEach(c => S.shown.add(c.id)); campos().forEach(marca);
    const malos = campos().filter(c => errDe(c)), sum = $('sum');
    if (malos.length) {
      sum.textContent = t('sum'); sum.style.display = 'block';
      const el = document.querySelector(`.f[data-id="${malos[0].id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    sum.style.display = 'none'; S.busy = true; clearTimeout(S.timer);
    const b = $('go'); b.disabled = true; b.textContent = t('sending');
    try {
      const r = await fetch(`${API}/inicio/public/enviar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo()), credentials: 'omit', cache: 'no-store' });
      if (r.status === 404) { noDisponible(); return; }
      if (r.ok) { pantalla('✓', t('doneT'), t('doneP')); window.scrollTo(0, 0); return; }
      const d = await r.json().catch(() => ({}));
      S.busy = false; b.disabled = false; b.textContent = t('send');
      (d.faltan || []).concat(Object.keys(d.formato || {})).forEach(id => S.shown.add(id)); campos().forEach(marca);
      sum.textContent = t('sumSrv'); sum.style.display = 'block';
    } catch (_) { S.busy = false; b.disabled = false; b.textContent = t('send'); sum.textContent = t('netErr'); sum.style.display = 'block'; }
  }

  function idioma(l) { if (S.lang === l) return; S.lang = l; paint(); programar(); }
  $('l-es').onclick = () => idioma('es'); $('l-en').onclick = () => idioma('en');

  (async function init() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) && !/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{14}$/.test(token)) return noDisponible();
    try {
      const r = await fetch(`${API}/inicio/public/abrir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return noDisponible();
      const d = await r.json();
      S.lang = d.idioma === 'en' ? 'en' : 'es';
      if (d.enviado) { $('l-es').classList.toggle('on', S.lang === 'es'); $('l-en').classList.toggle('on', S.lang === 'en'); return pantalla('✓', t('doneT'), t('doneP')); }
      S.secs = d.secciones || []; S.vals = d.respuestas || {}; S.acs = d.acuerdos || {}; S.sec = d.secretos || {};
      S.last = JSON.stringify(cuerpo()); paint();
    } catch (_) { noDisponible(); }
  })();
})();
