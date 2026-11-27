// Content script de LinkedIn: (1) vigila avisos de bloqueo en cualquier página y (2) ejecuta UNA acción que le pide el service worker
// (invitar, visitar, escribir, o leer aceptaciones / bandeja / notificaciones).
// Principios: ante la duda NO actúa y lo informa; ante un aviso de LinkedIn se detiene; nunca reintenta un envío;
// todas las pausas y escrituras tienen tiempos humanos al azar. Textos, selectores y patrones vienen de Nova (se corrigen sin reinstalar).
(() => {
  if (window.__novaLi) return; window.__novaLi = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const vis = el => !!(el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
  const R = (codigo, error, detalle, extra) => ({ codigo, error: error || '', detalle: detalle || '', ...(extra || {}) });
  let CFG = null;
  // Migas de pan: si la acción se cuelga, el service worker las pide para saber hasta dónde llegó
  const _t0 = Date.now(), traza = [];
  const marca = s => { traza.push(Math.round((Date.now() - _t0) / 1000) + 's ' + s); if (traza.length > 30) traza.shift(); };
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
    if (document.hidden) {
      if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('delete'); document.execCommand('insertText', false, texto); }
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, texto);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      }
      return;
    }
    if (el.isContentEditable) {
      document.execCommand('selectAll'); document.execCommand('delete'); await sleep(rnd(150, 400));
      for (const ch of texto) { document.execCommand('insertText', false, ch); await sleep(rnd(25, 90)); if (Math.random() < 0.04) await sleep(rnd(200, 600)); }
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = v => {
      if (el.isContentEditable) el.textContent = v; else Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    };
    set('');
    let acum = '';
    for (const ch of texto) { acum += ch; set(acum); await sleep(rnd(25, 90)); if (Math.random() < 0.04) await sleep(rnd(200, 600)); }
  }

  // ── Acciones visibles en la tarjeta del perfil ──
  // «Conectar» es un enlace con aria-label «Invite X to connect»; se exige esa forma (o el texto exacto) para NO pulsar enlaces como «500+ connections» o «X is a mutual connection».
  const conectarVisible = root => [...root.querySelectorAll('button, a, [role="button"]')].filter(vis).find(e => {
    const t = norm(e.innerText), al = norm(e.getAttribute('aria-label'));
    return /^invite .* to connect$|^invitar a .* a conectar$|^conectar con /.test(al) || T('connect').includes(t);
  });
  const pendienteVisible = root => [...root.querySelectorAll('button, a, [role="button"]')].filter(vis).find(e => {
    const t = norm(e.innerText), al = norm(e.getAttribute('aria-label'));
    return T('pending').includes(t) || /^pending|^pendiente/.test(al);
  });
  const mensajeVisible = root => [...root.querySelectorAll('button, a, [role="button"]')].filter(vis).find(e => {
    const t = norm(e.innerText), al = norm(e.getAttribute('aria-label'));
    return T('message').includes(t) || /^message |^enviar mensaje|^mensaje a /.test(al);
  });
  const raicesDeep = () => { const out = [document]; const walk = r => r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) { out.push(e.shadowRoot); walk(e.shadowRoot); } }); walk(document); return out; };
  const deepAll = (sel, filtro) => { const out = []; for (const r of raicesDeep()) r.querySelectorAll(sel).forEach(e => { if (vis(e) && (!filtro || filtro(e))) out.push(e); }); return out; };
  const esMas = b => { const t = norm(b.innerText), al = norm(b.getAttribute('aria-label')); return t === 'more' || t === 'más' || t === 'mas' || /^(more|más|mas) actions?$|^más acciones$|^more$/.test(al); };
  async function abrirMenuMas() {
    const main = document.querySelector('main') || document, top = main.querySelector('section') || main;
    const mas = btns(top).find(esMas) || btns(main).find(esMas);
    if (!mas) return null;
    mas.click(); await sleep(rnd(700, 1400));
    return [...document.querySelectorAll('[role="menu"], .artdeco-dropdown__content, .artdeco-dropdown__content-inner')].filter(vis).pop() || null;
  }

  // ── Estado del perfil ──
  function estadoPerfil() {
    const main = document.querySelector('main') || document.body;
    const top = main.querySelector('section') || main;
    const grado = norm(top.innerText).match(/·\s*(1st|1\.º|1\.er|1º|2nd|2\.º|2º|3rd|3\.º|3º)/);
    return { pend: pendienteVisible(top), con: conectarVisible(top), msg: mensajeVisible(top), primerGrado: !!(grado && /^1/.test(grado[1])), hayPerfil: /\/in\//.test(location.pathname) && !!([...main.querySelectorAll('h2')].find(h => (h.innerText || '').trim().length > 1) || main.querySelector('h1')) };
  }

  async function invitar(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado', 'No se encontró el perfil (¿enlace roto?)');
    if (p.primerGrado) return R('omitida', 'ya_conectado');
    if (p.pend) return R('omitida', 'ya_pendiente');
    let con = p.con;
    if (!con) {   // «Conectar» a veces está dentro del menú «Más»
      {
        const menu = await abrirMenuMas();
        const empieza = el => { const t = norm(el.innerText || el.getAttribute('aria-label')); return T('connect').some(w => t === w || t.startsWith(w + ' ')) && !/(disconnect|desconectar|remove|quitar|eliminar)/.test(t); };
        if (menu) con = [...menu.querySelectorAll('[role="menuitem"], li, button, a, div[role="button"]')].filter(vis).find(empieza) || null;
      }
    }
    if (!con) return R('omitida', 'sin_boton_conectar', 'No hay botón Conectar (perfil restringido o solo seguir)', { snapshot: snapshot() });
    con.click();
    const dlgAbierto = () => [...document.querySelectorAll('dialog, [role="dialog"], .artdeco-modal')].filter(vis).pop() || null;
    const enDlg = (root, words) => [...root.querySelectorAll('button, a, [role="button"]')].filter(vis).find(e => hasAny(e, words));
    const exacto = (root, words) => [...root.querySelectorAll('button')].filter(vis).find(e => !e.disabled && words.some(w => norm(e.innerText) === w || norm(e.getAttribute('aria-label')) === w));
    let dlg = null;
    for (let i = 0; i < 14 && !dlg; i++) { await sleep(500); dlg = dlgAbierto(); }
    await sleep(rnd(600, 1300));
    let av = avisoLinkedIn(); if (av) return porAviso(av);
    if (!dlg) { await sleep(1500); if (estadoPerfil().pend) return R('ok'); return R('fallo', 'sin_ventana_invitacion', 'No apareció la ventana de invitación', { snapshot: snapshot() }); }
    if (a.nota) {
      const todos = () => [...document.querySelectorAll('dialog, [role="dialog"], .artdeco-modal')].filter(vis);
      const nota = todos().map(d => enDlg(d, T('addNote'))).find(Boolean);
      if (!nota) return R('fallo', 'sin_boton_nota', 'No apareció «Añadir nota» (¿cuenta gratuita sin notas?)', { snapshot: snapshot() });
      nota.click();
      // el cuadro de la nota tarda en dibujarse (más aún con la pestaña en segundo plano): se espera hasta 15 s
      let ta = null;
      for (let i = 0; i < 30 && !ta; i++) {
        await sleep(500);
        ta = todos().map(d => d.querySelector('[contenteditable="true"], [role="textbox"], textarea')).find(Boolean) || document.querySelector(SEL('notaTextarea')) || null;
      }
      if (!ta) return R('fallo', 'sin_campo_nota', '', { snapshot: snapshot() });
      dlg = ta.closest('dialog, [role="dialog"], .artdeco-modal') || dlgAbierto() || dlg;
      await sleep(rnd(400, 900));
      await escribir(ta, a.nota); await sleep(rnd(600, 1200));
    }
    const enviar = a.nota ? exacto(dlg, T('send')) : (exacto(dlg, T('sendNoNote')) || exacto(dlg, T('send')));
    if (!enviar) return R('fallo', 'sin_boton_enviar', 'No se pudo pulsar «Enviar» (¿la nota pasa del máximo?)', { snapshot: snapshot() });
    if (asistido) return await esperarUsuario(() => !!estadoPerfil().pend, 'Revisa la nota y pulsa «Enviar».');
    enviar.click();
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      av = avisoLinkedIn(); if (av) return porAviso(av);
      if (estadoPerfil().pend || !dlgAbierto()) { await sleep(1200); return R('ok'); }
    }
    return R('fallo', 'no_confirmado', 'No se pudo confirmar el envío; revisa en LinkedIn antes de repetir', { snapshot: snapshot() });
  }

  async function visitar() {
    if (!estadoPerfil().hayPerfil) return R('omitida', 'perfil_no_encontrado');
    const n = Math.round(rnd(2, 5));   // número de desplazamientos distinto cada vez, con alguna vuelta hacia arriba y pausas largas de lectura
    const oculta = document.hidden;     // pestaña en segundo plano: Chrome frena sus temporizadores → desplazamientos instantáneos y pausas cortas (la «lectura» ya la hizo el service worker)
    marca('visitar: ' + n + ' desplazamientos' + (oculta ? ' (pestaña oculta)' : ''));
    for (let i = 0; i < n; i++) { window.scrollBy({ top: (Math.random() < 0.18 ? -1 : 1) * rnd(180, 760), behavior: oculta ? 'auto' : 'smooth' }); marca('desplazamiento ' + (i + 1)); await sleep(oculta ? rnd(250, 700) : rnd(1100, 4200) + (Math.random() < 0.15 ? rnd(2500, 6000) : 0)); }
    marca('visitar: terminado');
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return R('ok');
  }

  async function mensaje(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado');
    if (!p.primerGrado || !p.msg) return R('omitida', 'no_conectado', 'Solo se escribe a conexiones de primer grado');
    const nombre = norm((document.querySelector('main h1') || {}).innerText);
    p.msg.click(); await sleep(rnd(1400, 2400));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const selCaja = SEL('cajaMensaje') || 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]';
    let burbuja = null, box = null;
    for (let i = 0; i < 12 && !box; i++) {
      await sleep(500);
      const bs = deepAll('.msg-overlay-conversation-bubble');
      burbuja = bs.find(b => nombre && norm(b.innerText).includes(nombre)) || null;
      box = burbuja ? burbuja.querySelector(selCaja) : null;
    }
    if (!box) { box = deepAll(selCaja)[0] || null; burbuja = box ? (box.closest('.msg-overlay-conversation-bubble') || box.closest('form') || box.parentElement) : null; }
    if (!box) return R('fallo', 'sin_campo_mensaje', '', { snapshot: snapshot() });
    await escribir(box, a.texto); await sleep(rnd(800, 1600));
    if (asistido) return await esperarUsuario(() => !String(box.innerText || '').trim(), 'Revisa el mensaje y pulsa «Enviar».');
    const ambito = burbuja || document;
    const enviar = ambito.querySelector(SEL('botonEnviarMensaje') || 'button.msg-form__send-button') || [...ambito.querySelectorAll('button')].filter(vis).find(b => /^send$|^enviar$/.test(norm(b.innerText)));
    if (!enviar || enviar.disabled) return R('fallo', 'sin_boton_enviar', '', { snapshot: snapshot() });
    enviar.click();
    for (let i = 0; i < 14; i++) { await sleep(500); if (!String(box.innerText || '').trim()) { await sleep(1000); return R('ok'); } }
    return R('fallo', 'no_confirmado', 'El texto sigue en el cuadro; revisa en LinkedIn', { snapshot: snapshot() });
  }

  // ── Publicaciones: reaccionar y comentar ──
  // Se abre «Actividad» de la persona y se elige su publicación más reciente (no las que solo reaccionó o comentó). Si no hay una (o es más vieja que la ventana
  // del paso), devuelve «omitida · sin_publicacion» y Nova hace el plan B (seguir el perfil).
  const POST_SEL = () => SEL('post') || '[data-urn^="urn:li:activity"], .feed-shared-update-v2, div.occludable-update';
  const edadDias = t => {
    const m = norm(t).match(/(\d+)\s*(s|seg|min|m|h|d|sem|w|mes|mo|a|y|yr|año)\b/);
    if (!m) return null; const n = Number(m[1]), u = m[2];
    return /^(s|seg|min|h)$/.test(u) ? 0 : u === 'm' ? 0 : /^(d)$/.test(u) ? n : /^(sem|w)$/.test(u) ? n * 7 : /^(mes|mo)$/.test(u) ? n * 30 : n * 365;
  };
  async function buscarPost(a) {
    const maxDias = Number((a.params && a.params.post_dias) || 0);
    for (let i = 0; i < 8; i++) {
      const ps = [...document.querySelectorAll(POST_SEL())].filter(vis);
      for (const p of ps) {
        const cab = norm((p.querySelector('.update-components-header, .feed-shared-actor__description--minimal') || {}).innerText || '');
        if (/\b(likes this|loves this|celebrates this|supports this|finds this|commented on|le gusta esto|comentó|comentaron)\b/.test(cab)) continue;   // actividad AJENA, no una publicación suya
        const sub = (p.querySelector('.update-components-actor__sub-description, .feed-shared-actor__sub-description') || {}).innerText || '';
        const dias = edadDias(sub);
        if (maxDias > 0 && dias != null && dias > maxDias) return null;   // el post más reciente ya es demasiado viejo
        return p;
      }
      if (/hasn.t posted|no ha publicado|nothing to see|aún no hay|no recent/i.test(String(document.body.innerText || '').slice(0, 20000)) && i >= 2) return null;
      await sleep(1500);
    }
    return null;
  }
  const textoPost = p => { const t = p.querySelector('.update-components-text, .feed-shared-update-v2__description, .feed-shared-text, .break-words'); return String((t && t.innerText) || p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000); };

  async function reaccionar(a, asistido) {
    if (!/\/in\//.test(location.pathname)) return R('omitida', 'perfil_no_encontrado');
    const p = await buscarPost(a);
    if (!p) return R('omitida', 'sin_publicacion', 'La persona no tiene una publicación reciente para reaccionar');
    p.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(rnd(1800, 3800));
    const trig = p.querySelector(SEL('reaccionBoton') || 'button.react-button__trigger, button[aria-label^="React"], button[aria-label^="Reaccionar"]') || findBtn(T('like'), p);
    if (!trig) return R('fallo', 'sin_boton_reaccion', 'No encontré el botón de reaccionar', { snapshot: snapshot() });
    if (trig.getAttribute('aria-pressed') === 'true') return R('omitida', 'ya_reaccionado', 'Ya había reaccionado a esa publicación');
    const hecho = () => trig.getAttribute('aria-pressed') === 'true' || /unlike|quitar|reacted|has reaccionado/.test(textOf(trig));
    const cual = String(a.texto || '').trim();
    const pal = (CFG && CFG.reacciones && CFG.reacciones[cual]) || null;
    if (asistido) { trig.scrollIntoView({ block: 'center' }); trig.style.outline = '3px solid #316BFE'; return await esperarUsuario(hecho, 'Reacciona a la publicación' + (cual && pal ? ' (' + cual.replace('_', ' ') + ')' : '') + '.'); }
    if (pal && cual !== 'recomendar') {
      trig.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); trig.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); await sleep(rnd(1200, 2000));
      const op = btns(document).find(b => hasAny(b, pal));
      if (op) { op.click(); await sleep(rnd(1200, 2200)); return hecho() ? R('ok') : R('fallo', 'no_confirmado', 'No se pudo confirmar la reacción', { snapshot: snapshot() }); }
    }
    trig.click(); await sleep(rnd(1200, 2200));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return hecho() ? R('ok') : R('fallo', 'no_confirmado', 'No se pudo confirmar la reacción', { snapshot: snapshot() });
  }

  async function seguir(a, asistido) {
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado');
    const top = (document.querySelector('main') || document).querySelector('section') || document;
    if (findBtn(T('following'), top)) return R('omitida', 'ya_siguiendo', 'Ya sigue a esta persona');
    let seg = findBtn(T('follow'), top);
    if (!seg) {   // «Seguir» a veces está dentro del menú «Más»
      const menu = await abrirMenuMas();
      if (menu) seg = [...menu.querySelectorAll('[role="menuitem"], div.artdeco-dropdown__item, li, button, a')].filter(vis).find(x => { const t = norm(x.innerText || x.getAttribute('aria-label')); return T('follow').some(w => t === w || t.startsWith(w + ' ')) && !hasAny(x, T('following')); }) || null;
    }
    if (!seg) return R('omitida', 'sin_boton_seguir', 'No hay botón Seguir (perfil sin modo seguir)', { snapshot: snapshot() });
    if (asistido) { seg.scrollIntoView({ block: 'center' }); seg.style.outline = '3px solid #316BFE'; return await esperarUsuario(() => !!findBtn(T('following'), document), 'Pulsa «Seguir».'); }
    seg.click(); await sleep(rnd(1400, 2600));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return findBtn(T('following'), document) || !document.contains(seg) ? R('ok') : R('fallo', 'no_confirmado', 'No se pudo confirmar que se siguió', { snapshot: snapshot() });
  }

  const pedirComentario = (id, post) => new Promise(res => { try { chrome.runtime.sendMessage({ cmd: 'comentario', id, post }, r => res(r || { error: 'sin_respuesta' })); } catch (e) { res({ error: String(e) }); } });
  async function comentar(a, asistido) {
    if (!/\/in\//.test(location.pathname)) return R('omitida', 'perfil_no_encontrado');
    const p = await buscarPost(a);
    if (!p) return R('omitida', 'sin_publicacion', 'La persona no tiene una publicación reciente para comentar');
    p.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(rnd(2200, 4500));   // «lee» la publicación
    const cuerpo = textoPost(p);
    if (cuerpo.length < 20) return R('omitida', 'sin_publicacion', 'La publicación no tiene texto que comentar');
    const g = await pedirComentario(a.id, cuerpo);
    if (g.error || !g.comentario) return R('omitida', /clave|api|presupuesto|desactivada/i.test(String(g.error || '')) ? 'sin_clave_ia' : 'sin_comentario_ia', String(g.error || 'La IA no devolvió un comentario'));
    const btn = p.querySelector(SEL('botonComentar') || 'button.comment-button, button[aria-label^="Comment"], button[aria-label^="Comentar"]') || findBtn(T('comment'), p);
    if (!btn) return R('fallo', 'sin_boton_comentar', '', { snapshot: snapshot() });
    btn.click(); await sleep(rnd(1200, 2400));
    const caja = p.querySelector(SEL('cajaComentario') || '.comments-comment-box__form .ql-editor, div.ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]') || document.querySelector('.comments-comment-box .ql-editor');
    if (!caja) return R('fallo', 'sin_campo_comentario', '', { snapshot: snapshot() });
    await escribir(caja, g.comentario); await sleep(rnd(900, 1800));
    const datos = { comentario: g.comentario };
    if (asistido) { const r = await esperarUsuario(() => !String(caja.innerText || '').trim().replace(/\u200b/g, ''), 'Revisa el comentario y pulsa «Comentar».'); return r.codigo === 'ok' ? { ...r, datos } : r; }
    const form = caja.closest('form, .comments-comment-box') || document;
    const env = form.querySelector(SEL('botonEnviarComentario') || 'button.comments-comment-box__submit-button, button[type="submit"]') || findBtn(T('comment'), form);
    if (!env || env.disabled) return R('fallo', 'sin_boton_enviar', '', { snapshot: snapshot() });
    env.click(); await sleep(rnd(1800, 3200));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return !String(caja.innerText || '').trim().replace(/\u200b/g, '') ? { ...R('ok'), datos } : R('fallo', 'no_confirmado', 'El comentario sigue en el cuadro; revisa en LinkedIn', { snapshot: snapshot() });
  }

  // InMail (cuenta Premium / Sales Navigator): desde el perfil, el botón «Mensaje» de alguien que no es conexión abre el redactor de InMail con asunto.
  // Paso 2 (pestaña de Sales Navigator): rellena asunto y mensaje y envía
  async function inmailSales(a, asistido) {
    let asunto = null, cuerpo = null;
    for (let i = 0; i < 30 && !(asunto && cuerpo); i++) {
      await sleep(500);
      asunto = [...document.querySelectorAll('input')].filter(vis).find(e => /subject|asunto/i.test((e.placeholder || '') + (e.getAttribute('aria-label') || '')));
      cuerpo = [...document.querySelectorAll('textarea[name="message"], textarea')].filter(vis).find(e => !e.disabled);
    }
    const pagina = norm(document.body.innerText || '').slice(0, 60000);
    if (/\b(0|no) (of \d+ )?inmail credits|\b0 of \d+ credits|out of inmail credits|sin cr[eé]ditos de inmail/.test(pagina)) return R('omitida', 'sin_inmail', 'LinkedIn no ofrece InMail (sin créditos o la suscripción venció)', { snapshot: snapshot() });
    if (!asunto || !cuerpo) return R('omitida', 'sin_inmail', 'No apareció el redactor de InMail (¿la cuenta no tiene InMail?)', { snapshot: snapshot() });
    await escribir(asunto, String(a.nota || 'Hola').slice(0, 200)); await sleep(rnd(500, 1100));
    await escribir(cuerpo, a.texto); await sleep(rnd(800, 1600));
    if (asistido) return await esperarUsuario(() => !String(cuerpo.value || '').trim(), 'Revisa el InMail y pulsa «Enviar».');
    const enviar = [...document.querySelectorAll('button')].filter(vis).find(b => /^send$|^enviar$/.test(norm(b.innerText)));
    if (!enviar || enviar.disabled) return R('fallo', 'sin_boton_enviar', 'No se pudo pulsar «Enviar» (¿falta el asunto o el texto es largo?)', { snapshot: snapshot() });
    enviar.click();
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const av = avisoLinkedIn(); if (av) return porAviso(av);
      if (!document.contains(cuerpo) || !String(cuerpo.value || '').trim()) { await sleep(1200); return R('ok'); }
    }
    return R('fallo', 'no_confirmado', 'No se pudo confirmar el envío del InMail; revisa en LinkedIn antes de repetir', { snapshot: snapshot() });
  }
  // Paso 1 (perfil): pulsa «Mensaje» (visible o dentro de «Más»). LinkedIn abre Sales Navigator en otra pestaña y el service worker sigue allí.
  async function inmail(a, asistido) {
    if (/^\/sales\//.test(location.pathname)) return await inmailSales(a, asistido);
    const p = estadoPerfil();
    if (!p.hayPerfil) return R('omitida', 'perfil_no_encontrado');
    if (p.primerGrado) return R('omitida', 'ya_conectado', 'Ya es conexión: no hace falta InMail');
    let msg = p.msg;
    if (!msg) {
      const menu = await abrirMenuMas();
      if (menu) msg = [...menu.querySelectorAll('[role="menuitem"], li, a, button')].filter(vis).find(e => /^message |^mensaje /.test(norm(e.innerText || e.getAttribute('aria-label')))) || null;
    }
    if (!msg) return R('omitida', 'sin_inmail', 'No hay botón de mensaje/InMail (la cuenta no tiene InMail disponible)');
    msg.click(); await sleep(rnd(1200, 2000));
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    return R('abierto');
  }

  // ── Lecturas para detectar aceptaciones, respuestas e interacciones (no escriben nada) ──
  async function desplazar(veces) { for (let i = 0; i < veces; i++) { window.scrollBy({ top: rnd(500, 900), behavior: 'smooth' }); await sleep(rnd(1200, 2400)); } }

  // Conexiones recientes: las personas que aceptaron aparecen arriba. La página dice «N connections»; con 0 no hay nada que leer (y no es un fallo).
  // «Connected on November 26, 2026» / «Conectado el 26 de noviembre de 2026» → '2026-11-26'
  const MESES = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  function fechaConexion(txt) {
    let m = String(txt || '').match(/Connected on ([A-Za-z]+) (\d{1,2}), (\d{4})/i);
    if (m && MESES[m[1].toLowerCase()]) return iso(m[3], MESES[m[1].toLowerCase()], m[2]);
    m = String(txt || '').match(/Conectad[oa]s? el (\d{1,2}) de ([a-záéíóú]+)(?: de)? (\d{4})/i);
    if (m && MESES[m[2].toLowerCase()]) return iso(m[3], MESES[m[2].toLowerCase()], m[1]);
    return null;
  }
  const slugDeHref = h => { const m = String(h || '').match(/\/in\/([^\/?#]+)/i); if (!m) return ''; try { return decodeURIComponent(m[1]).toLowerCase(); } catch (_) { return m[1].toLowerCase(); } };
  // Cada tarjeta de la lista: el slug de la persona y el día en que se conectaron (se sube hasta la tarjeta que contiene a UNA sola persona)
  function parseConexiones(main) {
    const vistos = new Set(), out = [];
    main.querySelectorAll('a[href*="/in/"]').forEach(x => {
      const slug = slugDeHref(x.getAttribute('href')); if (!slug || vistos.has(slug)) return;
      vistos.add(slug);
      let card = x, fecha = null;
      for (let k = 0; k < 8 && card.parentElement; k++) {
        card = card.parentElement;
        const otros = new Set([...card.querySelectorAll('a[href*="/in/"]')].map(y => slugDeHref(y.getAttribute('href'))).filter(Boolean));
        if (otros.size > 1) break;
        fecha = fechaConexion(card.innerText); if (fecha) break;
      }
      out.push({ slug, fecha });
    });
    return out;
  }
  // Normal: las primeras ~10 conexiones (las que acaban de aceptar), sin bajar de más. Profunda: hasta ~100, solo la primera vez que se vincula la cuenta.
  async function leerConexiones(profundo) {
    await sleep(rnd(1500, 3000));
    const av0 = avisoLinkedIn(); if (av0) return porAviso(av0);
    const main0 = document.querySelector('main') || document.body, oculta = document.hidden;
    const contar = () => new Set([...main0.querySelectorAll('a[href*="/in/"]')].map(y => slugDeHref(y.getAttribute('href'))).filter(Boolean)).size;
    // La lista carga de a pocas: se baja hasta que deja de crecer (máx. ~100 conexiones), porque antes solo se veían las 10 primeras
    let ultimo = -1, igual = 0;
    for (let i = 0; i < (profundo ? 9 : 1) && igual < 2; i++) {
      const n = contar(); igual = n === ultimo ? igual + 1 : 0; ultimo = n;
      if (n >= (profundo ? 100 : 10)) break;   // en la lectura normal, si ya se ven 10 no se baja nada
      const mas = [...main0.querySelectorAll('button')].find(b => /^(show more results|ver más resultados|mostrar más resultados)$/i.test(String(b.innerText || '').trim()) && vis(b));
      if (mas) mas.click();
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: oculta ? 'auto' : 'smooth' });
      await sleep(oculta ? rnd(900, 1500) : rnd(1500, 2600));
    }
    const av = avisoLinkedIn(); if (av) return porAviso(av);
    const main = document.querySelector('main') || document.body;
    const total = (String(main.innerText || '').match(/(\d[\d.,]*)\s+(connections|conexiones)/i) || [])[1];
    const conexiones = parseConexiones(main).slice(0, profundo ? 120 : 30);
    if (total && Number(String(total).replace(/\D/g, '')) === 0) return R('ok', '', '', { datos: { slugs: [], conexiones: [] } });
    if (!conexiones.length) return R('fallo', 'sin_datos', 'No se encontraron conexiones en la página', { snapshot: snapshot() });
    return R('ok', '', '', { datos: { slugs: conexiones.map(c => c.slug), conexiones } });
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

  // ── Datos del prospecto que se ve en pantalla (para el panel «Prospecto» de FLOW) ──
  // Solo LEE lo que ya está visible en el perfil; no hace clics ni peticiones. LinkedIn no usa <h1>: el nombre es el primer <h2> de la tarjeta superior.
  function leerPerfil() {
    const m = location.pathname.match(/^\/in\/([^/?#]+)/);
    if (!m) return { hayPerfil: false };
    const main = document.querySelector('main');
    if (!main) return { hayPerfil: false, slug: decodeURIComponent(m[1]).toLowerCase(), cargando: true };
    const h = [...main.querySelectorAll('h1, h2')].find(e => (e.innerText || '').trim().length > 1);
    if (!h) return { hayPerfil: false, slug: decodeURIComponent(m[1]).toLowerCase(), cargando: true };
    const sec = h.closest('section') || main;
    const nombre = (h.innerText || '').trim().replace(/\s+/g, ' ');
    const ruido = /^(not added to|no a[ñn]adid|verify|verifica|·$|\(?(he|she|they|él|ella)\b|1st|2nd|3rd|1\.º|2\.º|3\.º|1\.er|\d+\s*(connections|conexiones|followers|seguidores)|open to|add section|add profile|enhance|message|mensaje|connect|conectar|follow|seguir|more|más|pending|pendiente|resources|recursos|contact info|informaci[oó]n de contacto)/i;
    const lineas = (sec.innerText || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const iNom = lineas.indexOf(nombre);
    const ic = lineas.findIndex(l => /^(contact info|informaci[oó]n de contacto)$/i.test(l));
    const cuerpo = lineas.slice(iNom + 1, ic > 0 ? ic : iNom + 8).filter(l => !ruido.test(l));
    // cuerpo = [titular, ubicación] (la ubicación es la última línea antes de «Contact info»)
    const ubicacion = cuerpo.length > 1 ? cuerpo[cuerpo.length - 1] : '';
    const titular = cuerpo.length > 1 ? cuerpo.slice(0, -1).join(' ') : (cuerpo[0] || '');
    let empresa = '';
    if (ic > 0) { const c = lineas[ic + 1]; if (c && !ruido.test(c) && !/connections|conexiones|followers|seguidores/i.test(c)) empresa = c; }
    if (!empresa) { const mm = titular.match(/(?:\bat\b|\ben\b|@)\s+([^|·•\n]+?)(?:\s*[|·•]|$)/i); if (mm) empresa = mm[1].trim(); }
    const foto = [...sec.querySelectorAll('img')].find(i => i.width >= 80 && !/cover|portada/i.test(i.alt || ''));
    const grado = ((sec.innerText || '').match(/·\s*(1st|1\.º|1\.er|1º|2nd|2\.º|2º|3rd|3\.º|3º)/) || [])[1] || '';
    return { hayPerfil: true, slug: decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, ''), nombre, titular, empresa, ubicacion, grado, foto: foto ? foto.src : '' };
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m && m.cmd === 'diagnostico') {
      (async () => { let bat = null; try { const b = await navigator.getBattery(); bat = { nivel: Math.round(b.level * 100), cargando: b.charging }; } catch (_) {} send({ visibilidad: document.visibilityState, listo: document.readyState, bateria: bat, ejecutando: !!window.__novaEjecutando, traza: traza.slice(-10) }); })();
      return true;
    }
    if (m && m.cmd === 'perfil') { try { send(leerPerfil()); } catch (e) { send({ hayPerfil: false, error: String((e && e.message) || e) }); } return false; }
    if (!m || m.cmd !== 'ejecutar') return false;
    (async () => {
      window.__novaEjecutando = true; marca('ejecutar ' + (m.accion && m.accion.tipo));
      try {
        if (m.config) CFG = m.config; else if (!CFG) CFG = await cargarConfig();
        const av = avisoLinkedIn(); if (av) return send(porAviso(av));
        const a = m.accion;
        const r = a.tipo === 'invite' ? await invitar(a, m.asistido)
          : a.tipo === 'visit' ? await visitar()
          : a.tipo === 'message' ? await mensaje(a, m.asistido)
          : a.tipo === 'react' ? await reaccionar(a, m.asistido)
          : a.tipo === 'follow' ? await seguir(a, m.asistido)
          : a.tipo === 'comment' ? await comentar(a, m.asistido)
          : a.tipo === 'inmail' ? await inmail(a, m.asistido)
          : a.tipo === 'check_connections' ? await leerConexiones(!!m.profundo)
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
