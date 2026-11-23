// Content script de LinkedIn: (1) vigila avisos de bloqueo en cualquier página y (2) ejecuta UNA acción que le pide el service worker
// (invitar, visitar, escribir, o leer aceptaciones / bandeja / notificaciones).
// Principios: ante la duda NO actúa y lo informa; ante un aviso de LinkedIn se detiene; nunca reintenta un envío;
// todas las pausas y escrituras tienen tiempos humanos al azar. Textos, selectores y patrones vienen de Nova (se corrigen sin reinstalar).
(() => {
  if (window.__novaLi) return; window.__novaLi = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const vis = el => !!(el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
  const R = (codigo, error, detalle, extra) => ({ codigo, error: error || '', detalle: detalle || '', ...(extra || {}) });
  let CFG = null;
  const cargarConfig = () => new Promise(res => { try { chrome.runtime.sendMessage({ cmd: 'config' }, c => res(c || null)); } catch (_) { res(null); } });
  const T = k => (CFG && CFG.textos && CFG.textos[k]) || [];
  const SEL = k => (CFG && CFG.selectores && CFG.selectores[k]) || '';
  const textOf = el => norm((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''));
  const hasAny = (el, words) => words.some(w => textOf(el).includes(w));
  const btns = (root = document) => [...root.querySelectorAll('button, a[role="button"], div[role="button"]')].filter(vis);
  const findBtn = (words, root) => btns(root).find(b => hasAny(b, words));

  // Copia simplificada de la página (sin scripts ni estilos) para poder arreglar un selector cuando LinkedIn cambia algo
  function snapshot() {
    try {
      const e = document.documentElement.cloneNode(true);
      e.querySelectorAll('script, style, svg, noscript, link, iframe, img, video, picture').forEach(x => x.remove());
      return e.outerHTML.replace(/\s+/g, ' ').slice(0, 280000);
    } catch (_) { return ''; }
  }

  // ── Avisos de LinkedIn (patrones que llegan de Nova) ──
  function avisoLinkedIn() {
    const u = location.href, d = (CFG && CFG.deteccion) || { urlPatterns: [], bodyPatterns: [] };
    for (const p of d.urlPatterns || []) if (u.includes(p.pattern)) return p.pageType;
    if (/\/authwall|\/uas\/login|\/login\?|\/login$/.test(u)) return 'sesion_cerrada';
    const txt = String(document.body && document.body.innerText || '').slice(0, 40000);
    for (const p of d.bodyPatterns || []) { try { if (new RegExp(p.source, p.flags || 'i').test(txt)) return p.pageType; } catch (_) {} }
    return null;
  }
  const porAviso = av => av === 'sesion_cerrada' ? R('sesion', av, 'La sesión de LinkedIn se cerró', { snapshot: '' }) : R('restringida', av, 'Aviso de LinkedIn: ' + av, { snapshot: snapshot() });

  // Vigilancia pasiva en cada página de LinkedIn (aunque no se esté ejecutando nada)
  (async () => {
    CFG = await cargarConfig();
    let ultimo = '';
    const mirar = () => {
      if (window.__novaEjecutando) return;
      const av = avisoLinkedIn();
      if (av && av !== 'sesion_cerrada' && av !== ultimo) { ultimo = av; try { chrome.runtime.sendMessage({ cmd: 'alerta', tipo: av, url: location.href }); } catch (_) {} }
    };
    setTimeout(mirar, 2500);
    setInterval(mirar, 20000);
  })();

  // ── Escritura «humana» en un campo (compatible con React) ──
  async function escribir(el, texto) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = v => {
      if (el.isContentEditable) el.textContent = v; else Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    };
    set('');
    let acum = '';
    for (const ch of texto) { acum += ch; set(acum); await sleep(rnd(25, 90)); if (Math.random() < 0.04) await sleep(rnd(200, 600)); }
  }

  // ── Estado del perfil ──
  function estadoPerfil() {
    const main = document.querySelector('main') || document.body;
    const top = main.querySelector('section') || main;
    const grado = norm(top.innerText).match(/·\s*(1st|1\.º|1\.er|1º|2nd|2\.º|2º|3rd|3\.º|3º)/);
    return { pend: findBtn(T('pending'), top), con: findBtn(T('connect'), top), msg: findBtn(T('message'), top), primerGrado: !!(grado && /^1/.test(grado[1])), hayPerfil: /\/in\//.test(location.pathname) && !!([...main.querySelectorAll('h2')].find(h => (h.innerText || '').trim().length > 1) || main.querySelector('h1')) };
  }

  async function invitar(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado', 'No se encontró el perfil (¿enlace roto?)');
    if (p.primerGrado) return R('omitida', 'ya_conectado');
    if (p.pend) return R('omitida', 'ya_pendiente');
    let con = p.con;
    if (!con) {   // «Conectar» a veces está dentro del menú «Más»
      const mas = findBtn(T('more'), document.querySelector('main') || document);
      if (mas) { mas.click(); await sleep(rnd(700, 1400)); con = findBtn(T('connect'), document); }
    }
    if (!con) return R('omitida', 'sin_boton_conectar', 'No hay botón Conectar (perfil restringido o solo seguir)', { snapshot: snapshot() });
    con.click(); await sleep(rnd(900, 1800));
    let av = avisoLinkedIn(); if (av) return porAviso(av);
    if (a.nota) {
      const nota = findBtn(T('addNote'), document);
      if (!nota) return R('fallo', 'sin_boton_nota', 'No apareció «Añadir nota» (¿cuenta gratuita sin notas?)', { snapshot: snapshot() });
      nota.click(); await sleep(rnd(700, 1400));
      const ta = document.querySelector(SEL('notaTextarea'));
      if (!ta) return R('fallo', 'sin_campo_nota', '', { snapshot: snapshot() });
      await escribir(ta, a.nota); await sleep(rnd(600, 1200));
    }
    const dlg = document.querySelector(SEL('modal')) || document;
    const enviar = a.nota ? findBtn(T('send'), dlg) : (findBtn(T('sendNoNote'), dlg) || findBtn(T('send'), dlg));
    if (!enviar) return R('fallo', 'sin_boton_enviar', '', { snapshot: snapshot() });
    if (asistido) return await esperarUsuario(() => !!estadoPerfil().pend, 'Revisa la nota y pulsa «Enviar».');
    enviar.click(); await sleep(rnd(1500, 2800));
    av = avisoLinkedIn(); if (av) return porAviso(av);
    if (estadoPerfil().pend || !document.querySelector(SEL('notaTextarea'))) return R('ok');
    return R('fallo', 'no_confirmado', 'No se pudo confirmar el envío; revisa en LinkedIn antes de repetir', { snapshot: snapshot() });
  }

  async function visitar() {
    if (!estadoPerfil().hayPerfil) return R('omitida', 'perfil_no_encontrado');
    for (let i = 0; i < 3; i++) { window.scrollBy({ top: rnd(250, 700), behavior: 'smooth' }); await sleep(rnd(1200, 3200)); }
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return R('ok');
  }

  async function mensaje(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado');
    if (!p.primerGrado || !p.msg) return R('omitida', 'no_conectado', 'Solo se escribe a conexiones de primer grado');
    p.msg.click(); await sleep(rnd(1200, 2200));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const box = document.querySelector(SEL('cajaMensaje'));
    if (!box) return R('fallo', 'sin_campo_mensaje', '', { snapshot: snapshot() });
    await escribir(box, a.texto); await sleep(rnd(800, 1600));
    if (asistido) return await esperarUsuario(() => !String(box.innerText || '').trim(), 'Revisa el mensaje y pulsa «Enviar».');
    const enviar = document.querySelector(SEL('botonEnviarMensaje')) || findBtn(T('send'), document);
    if (!enviar || enviar.disabled) return R('fallo', 'sin_boton_enviar', '', { snapshot: snapshot() });
    enviar.click(); await sleep(rnd(1500, 2800));
    return String(box.innerText || '').trim() ? R('fallo', 'no_confirmado', 'El texto sigue en el cuadro; revisa en LinkedIn', { snapshot: snapshot() }) : R('ok');
  }

  // ── Lecturas para detectar aceptaciones, respuestas e interacciones (no escriben nada) ──
  async function desplazar(veces) { for (let i = 0; i < veces; i++) { window.scrollBy({ top: rnd(500, 900), behavior: 'smooth' }); await sleep(rnd(1200, 2400)); } }

  // Conexiones recientes: las personas que aceptaron aparecen arriba. La página dice «N connections»; con 0 no hay nada que leer (y no es un fallo).
  async function leerConexiones() {
    await sleep(rnd(1500, 3000)); await desplazar(2);
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const main = document.querySelector('main') || document.body;
    const total = (String(main.innerText || '').match(/(\d[\d.,]*)\s+(connections|conexiones)/i) || [])[1];
    const slugs = new Set();
    main.querySelectorAll('a[href*="/in/"]').forEach(x => { const m = String(x.getAttribute('href') || '').match(/\/in\/([^\/?#]+)/i); if (m) slugs.add(decodeURIComponent(m[1]).toLowerCase()); });
    if (total && Number(String(total).replace(/\D/g, '')) === 0) return R('ok', '', '', { datos: { slugs: [] } });
    if (!slugs.size) return R('fallo', 'sin_datos', 'No se encontraron conexiones en la página', { snapshot: snapshot() });
    return R('ok', '', '', { datos: { slugs: [...slugs].slice(0, 80) } });
  }

  // Bandeja (clases comprobadas en una cuenta real): nombre, último texto y si tiene mensajes sin leer. «propio» = el último mensaje lo escribí yo (Tú: / You:)
  async function leerBandeja() {
    for (let i = 0; i < 16 && !document.querySelector('li.msg-conversation-listitem'); i++) await sleep(800);   // la lista tarda en pintarse
    await sleep(rnd(1200, 2500));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const B = (CFG && CFG.bandeja) || {};
    const nodos = [...document.querySelectorAll(B.item || 'li.msg-conversation-listitem')];
    const vistos = new Set(), conversaciones = [];
    for (const li of nodos) {
      const nombre = String((li.querySelector(B.nombre || '.msg-conversation-card__participant-names, .msg-conversation-listitem__participant-names') || {}).innerText || '').replace(/\s+/g, ' ').trim();
      const extracto = String((li.querySelector(B.extracto || '.msg-conversation-card__message-snippet') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!nombre || vistos.has(nombre + extracto)) continue; vistos.add(nombre + extracto);
      const no_leido = /new notification|notificaci[oó]n(es)? nueva|nuevas? notificaci/i.test(li.innerText || '') || !!li.querySelector('[class*="unread"]');
      conversaciones.push({ nombre, extracto, no_leido, propio: /^(tú|tu|you)\s*:/i.test(extracto) });
    }
    if (!nodos.length && /messaging/.test(location.pathname) && !/no (messages|conversations)|sin mensajes/i.test(document.body.innerText || '')) return R('fallo', 'sin_datos', 'No se encontró la lista de conversaciones', { snapshot: snapshot() });
    return R('ok', '', '', { datos: { conversaciones: conversaciones.slice(0, 50) } });
  }

  // Notificaciones: esa página usa nombres de clase ofuscados y cambiantes, así que se lee por TEXTO: cada notificación termina en su antigüedad (1w, 3h, 2d…)
  async function leerNotificaciones() {
    await sleep(rnd(2000, 3500)); await desplazar(1);
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const main = document.querySelector('main') || document.body;
    const lineas = String(main.innerText || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const esTiempo = x => /^\d+\s?(s|m|h|d|w|mo|y|min|sem|mes|mon|dias?|d[ií]as?|h|hr|hrs)$/i.test(x);
    const items = []; let acum = [];
    for (const l of lineas) { if (esTiempo(l)) { const t = acum.join(' ').replace(/\s+/g, ' ').trim(); if (t.length > 8) items.push({ texto: t.slice(-220) }); acum = []; } else acum.push(l); }
    if (!items.length && !/no (new )?notifications|sin notificaciones/i.test(main.innerText || '')) return R('fallo', 'sin_datos', 'No se encontraron notificaciones', { snapshot: snapshot() });
    return R('ok', '', '', { datos: { items: items.slice(0, 50) } });
  }

  // Modo asistido: el texto queda escrito y la persona pulsa «Enviar». Se detecta que lo hizo (o se agota el tiempo).
  function esperarUsuario(hecho, aviso) {
    return new Promise(res => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:14px;transform:translateX(-50%);background:#0A2540;color:#fff;padding:10px 16px;font:600 14px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center';
      b.innerHTML = '<span>Nova · ' + aviso + '</span><button style="background:#fff;color:#0A2540;border:0;padding:4px 10px;font-weight:600;cursor:pointer">Omitir</button>';
      document.body.appendChild(b);
      let iv = null, to = null;
      const fin = r => { clearInterval(iv); clearTimeout(to); b.remove(); res(r); };
      b.querySelector('button').onclick = () => fin(R('omitida', 'omitida_por_usuario'));
      iv = setInterval(() => { const av = avisoLinkedIn(); if (av) return fin(porAviso(av)); if (hecho()) { clearInterval(iv); setTimeout(() => fin(R('ok')), 1200); } }, 1000);
      to = setTimeout(() => fin(R('omitida', 'sin_accion_usuario', 'No se confirmó en 4 minutos')), 240000);
    });
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (!m || m.cmd !== 'ejecutar') return false;
    (async () => {
      window.__novaEjecutando = true;
      try {
        if (m.config) CFG = m.config; else if (!CFG) CFG = await cargarConfig();
        const av = avisoLinkedIn(); if (av) return send(porAviso(av));
        const a = m.accion;
        const r = a.tipo === 'invite' ? await invitar(a, m.asistido)
          : a.tipo === 'visit' ? await visitar()
          : a.tipo === 'message' ? await mensaje(a, m.asistido)
          : a.tipo === 'check_connections' ? await leerConexiones()
          : a.tipo === 'check_inbox' ? await leerBandeja()
          : a.tipo === 'check_notifications' ? await leerNotificaciones()
          : R('omitida', 'tipo_no_soportado', 'Esta versión no ejecuta ' + a.tipo);
        send(r);
      } catch (e) { send(R('fallo', 'excepcion', String((e && e.message) || e).slice(0, 200), { snapshot: snapshot() })); }
      finally { window.__novaEjecutando = false; }
    })();
    return true;
  });
})();
