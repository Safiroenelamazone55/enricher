// Content script de LinkedIn: ejecuta UNA acción que le pide el service worker (invitar, visitar, mensaje).
// Principios de seguridad: ante la duda NO actúa y lo informa; ante cualquier aviso de LinkedIn se detiene y pide pausa;
// nunca reintenta un envío; todas las pausas y escrituras tienen tiempos humanos al azar.
(() => {
  if (window.__novaLi) return; window.__novaLi = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const vis = el => !!(el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
  const T = {
    connect: ['connect', 'conectar'], pending: ['pending', 'pendiente'], message: ['message', 'mensaje'],
    addNote: ['add a note', 'añadir una nota', 'agregar una nota'], send: ['send', 'enviar'], sendNoNote: ['send without a note', 'enviar sin nota'],
    more: ['more', 'más'],
  };
  const textOf = el => norm((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''));
  const hasAny = (el, words) => words.some(w => textOf(el).includes(w));
  const btns = (root = document) => [...root.querySelectorAll('button, a[role="button"], div[role="button"]')].filter(vis);
  const findBtn = (words, root) => btns(root).find(b => hasAny(b, words));
  const R = (codigo, error, detalle) => ({ codigo, error: error || '', detalle: detalle || '' });

  // ── Detección de avisos de LinkedIn: ante cualquiera, se para todo ──
  function avisoLinkedIn() {
    const u = location.href;
    if (/\/checkpoint\/|\/uas\/|\/authwall|\/login/.test(u)) return /login|authwall|uas/.test(u) ? 'sesion' : 'restringida';
    const txt = norm(document.body.innerText).slice(0, 30000);
    const frases = ['weekly invitation limit', 'límite semanal de invitaciones', "you've reached the weekly", 'has alcanzado el límite', 'unusual activity', 'actividad inusual', 'temporarily restricted', 'restringida temporalmente', "verify you're not a robot", 'verifica que no eres un robot', "let's do a quick security check", 'comprobación de seguridad'];
    return frases.some(f => txt.includes(f)) ? 'restringida' : null;
  }
  const porAviso = av => R(av === 'sesion' ? 'sesion' : 'restringida', av, 'Aviso de LinkedIn');

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
    return { pend: findBtn(T.pending, top), con: findBtn(T.connect, top), msg: findBtn(T.message, top), primerGrado: !!(grado && /^1/.test(grado[1])), hayPerfil: !!main.querySelector('h1') };
  }

  async function invitar(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado', 'No se encontró el perfil (¿enlace roto?)');
    if (p.primerGrado) return R('omitida', 'ya_conectado');
    if (p.pend) return R('omitida', 'ya_pendiente');
    let con = p.con;
    if (!con) {   // «Conectar» a veces está dentro del menú «Más»
      const mas = findBtn(T.more, document.querySelector('main') || document);
      if (mas) { mas.click(); await sleep(rnd(700, 1400)); con = findBtn(T.connect, document); }
    }
    if (!con) return R('omitida', 'sin_boton_conectar', 'No hay botón Conectar (perfil restringido o solo seguir)');
    con.click(); await sleep(rnd(900, 1800));
    let av = avisoLinkedIn(); if (av) return porAviso(av);
    if (a.nota) {
      const nota = findBtn(T.addNote, document);
      if (!nota) return R('fallo', 'sin_boton_nota', 'No apareció «Añadir nota» (¿cuenta gratuita sin notas?)');
      nota.click(); await sleep(rnd(700, 1400));
      const ta = document.querySelector('textarea[name="message"], textarea#custom-message, .artdeco-modal textarea');
      if (!ta) return R('fallo', 'sin_campo_nota');
      await escribir(ta, a.nota); await sleep(rnd(600, 1200));
    }
    const dlg = document.querySelector('.artdeco-modal, [role="dialog"]') || document;
    const enviar = a.nota ? findBtn(T.send, dlg) : (findBtn(T.sendNoNote, dlg) || findBtn(T.send, dlg));
    if (!enviar) return R('fallo', 'sin_boton_enviar');
    if (asistido) return await esperarUsuario(() => !!estadoPerfil().pend, 'Revisa la nota y pulsa «Enviar».');
    enviar.click(); await sleep(rnd(1500, 2800));
    av = avisoLinkedIn(); if (av) return porAviso(av);
    if (estadoPerfil().pend || !document.querySelector('.artdeco-modal textarea')) return R('ok');
    return R('fallo', 'no_confirmado', 'No se pudo confirmar el envío; revisa en LinkedIn antes de repetir');
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
    const box = document.querySelector('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]');
    if (!box) return R('fallo', 'sin_campo_mensaje');
    await escribir(box, a.texto); await sleep(rnd(800, 1600));
    if (asistido) return await esperarUsuario(() => !String(box.innerText || '').trim(), 'Revisa el mensaje y pulsa «Enviar».');
    const enviar = document.querySelector('button.msg-form__send-button') || findBtn(T.send, document);
    if (!enviar || enviar.disabled) return R('fallo', 'sin_boton_enviar');
    enviar.click(); await sleep(rnd(1500, 2800));
    return String(box.innerText || '').trim() ? R('fallo', 'no_confirmado', 'El texto sigue en el cuadro; revisa en LinkedIn') : R('ok');
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
      try {
        const av = avisoLinkedIn(); if (av) return send(porAviso(av));
        const a = m.accion;
        send(a.tipo === 'invite' ? await invitar(a, m.asistido) : a.tipo === 'visit' ? await visitar() : a.tipo === 'message' ? await mensaje(a, m.asistido) : R('omitida', 'tipo_no_soportado', 'Esta versión no ejecuta ' + a.tipo));
      } catch (e) { send(R('fallo', 'excepcion', String((e && e.message) || e).slice(0, 200))); }
    })();
    return true;
  });
})();
