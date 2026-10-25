// Módulo Contenido: de la idea suelta a la pieza publicada y medida.
// Secciones: Hoy · Estrategia · Ideas · Producción · Calendario · Campañas · Biblioteca · Aprobaciones · Publicar · Analítica · Informes · Clientes y pilares.
const ContenidoModule = (() => {
  const ETAPAS = [['idea', 'Idea'], ['desarrollo', 'Desarrollo'], ['texto', 'Texto'], ['diseno', 'Diseño'], ['revision', 'Revisión interna'], ['aprobacion', 'Aprobación cliente'], ['programado', 'Programado'], ['publicado', 'Publicado']];
  const FORMATOS = [['post', 'Post'], ['carrusel', 'Carrusel'], ['reel', 'Reel'], ['story', 'Story'], ['video', 'Video'], ['articulo', 'Artículo'], ['hilo', 'Hilo'], ['otro', 'Otro']];
  const REDES = [['instagram', 'Instagram', 'IG'], ['tiktok', 'TikTok', 'TT'], ['linkedin', 'LinkedIn', 'in'], ['facebook', 'Facebook', 'FB'], ['x', 'X', 'X'], ['youtube', 'YouTube', 'YT'], ['pinterest', 'Pinterest', 'Pin'], ['threads', 'Threads', 'Th'], ['blog', 'Blog', 'Blog'], ['otra', 'Otra', '…']];
  const URL_RED = { instagram: 'https://www.instagram.com/', tiktok: 'https://www.tiktok.com/upload', linkedin: 'https://www.linkedin.com/feed/', facebook: 'https://business.facebook.com/', x: 'https://x.com/compose/post', youtube: 'https://studio.youtube.com/', pinterest: 'https://www.pinterest.com/pin-builder/', threads: 'https://www.threads.net/' };
  const LIMITE = { x: 280, instagram: 2200, tiktok: 2200, linkedin: 3000, facebook: 63000, threads: 500, youtube: 5000, pinterest: 500 };
  const LISTAS = {
    post: ['Imagen o diseño listo', 'Texto revisado', 'Hashtags', 'Enlace o llamado a la acción'],
    carrusel: ['Estructura de las diapositivas', 'Texto de cada diapositiva', 'Diseño de todas', 'Texto de la publicación', 'Revisar ortografía'],
    reel: ['Guion', 'Grabar', 'Editar', 'Subtítulos', 'Portada', 'Música o audio', 'Texto de la publicación'],
    story: ['Imagen o video', 'Texto en pantalla', 'Enlace o sticker'],
    video: ['Guion', 'Grabar', 'Editar', 'Miniatura', 'Título y descripción'],
    articulo: ['Esquema', 'Redacción', 'Imágenes', 'Revisión', 'Título y descripción'],
    hilo: ['Idea central', 'Redactar cada parte', 'Revisar ortografía'],
    otro: ['Contenido listo', 'Revisión'],
  };
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const SECC = {
    'contenido-hoy': ['Hoy', 'Lo que toca ahora: entregas, publicaciones, aprobaciones y huecos.'],
    'contenido-estrategia': ['Estrategia', 'Objetivos, audiencia, tono y reglas de cada cliente: la base de todo lo que se crea.'],
    'contenido-ideas': ['Banco de ideas', 'Anota todo lo que se te ocurra; después lo conviertes en pieza.'],
    contenido: ['Producción', 'Todas las piezas por etapa: arrastra una tarjeta (o pulsa ›) para avanzar.'],
    'contenido-cal': ['Calendario', 'Qué se publica cada día. Arrastra una pieza a otro día para moverla.'],
    'contenido-campanas': ['Campañas', 'Lanzamientos, temporadas y acciones con inicio y fin, y cuánto llevan hecho.'],
    'contenido-biblioteca': ['Biblioteca', 'Imágenes, videos y documentos por cliente, listos para usar en cualquier pieza.'],
    'contenido-aprobaciones': ['Aprobaciones', 'Envía piezas al cliente con un enlace para que apruebe o pida cambios, sin que inicie sesión.'],
    'contenido-publicar': ['Publicar', 'Cola de salida: texto y archivos listos para publicar, y marcar lo que ya salió.'],
    'contenido-analitica': ['Analítica', 'Qué funciona: resultados por red, formato, pilar y pieza.'],
    'contenido-informes': ['Informes', 'El resumen mensual para entregar al cliente, listo para imprimir o guardar en PDF.'],
    'contenido-clientes': ['Clientes y pilares', 'Las cuentas de cada cliente y sus líneas de contenido.'],
  };
  let _D = null, _host = null, _sec = 'contenido-hoy', _f = { client: '', resp: '', q: '' }, _cal = { y: 0, m: 0, sel: '', modo: 'mes', ref: '' }, _p = null, _drag = null, _comments = [];
  let _bib = { client: '', carpeta: '', q: '' }, _an = { client: '', rango: '90' }, _str = { client: 0 }, _pvRed = '', _pick = null, _ap = { client: '', sel: {} }, _inf = { client: '', mes: '' };
  const _e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const _api = () => (typeof API !== 'undefined' ? API : '/api');
  const _lbl = (arr, k) => (arr.find(x => x[0] === k) || [k, k])[1];
  const _pad = n => String(n).padStart(2, '0');
  const _iso = d => d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
  const _hoy = () => _iso(new Date());
  const _d10 = s => String(s || '').slice(0, 10);
  const _fecha = s => { if (!s) return ''; const d = new Date(_d10(s) + 'T00:00:00'); return d.getDate() + ' ' + MESES[d.getMonth()].slice(0, 3).toLowerCase(); };
  const _fechaL = s => { if (!s) return ''; const d = new Date(_d10(s) + 'T00:00:00'); return DIAS[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()].toLowerCase(); };
  const _cli = id => (_D.clients || []).find(c => c.id === id);
  const _cliName = id => { const c = _cli(id); return c ? (c.empresa || c.nombre) : 'Sin cliente'; };
  const _pilar = id => (_D.pillars || []).find(p => p.id === id);
  const _camp = id => (_D.campaigns || []).find(c => c.id === id);
  const _med = id => (_D.media || []).find(m => m.id === id);
  const _ini = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const _hue = s => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const _n = x => Number(x || 0).toLocaleString('es-PE');
  const _redShort = k => (REDES.find(x => x[0] === k) || [0, 0, '·'])[2];
  async function _j(url, opt) {
    const r = await apiFetch(_api() + url, opt);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Error ' + r.status));
    return d;
  }
  const _post = (url, body, method) => _j(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  function _toast(m, t) { if (typeof showBanner === 'function') showBanner(m, t || 'success'); }
  async function _copiar(txt, ok) { try { await navigator.clipboard.writeText(txt); _toast(ok || 'Copiado'); } catch (_) { const t = document.createElement('textarea'); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); _toast(ok || 'Copiado'); } catch (e) { _toast('No se pudo copiar', 'error'); } t.remove(); } }

  async function _load() { _D = await _j('/content/bootstrap'); }
  function _visibles(sinIdeas) {
    const q = _f.q.trim().toLowerCase();
    return (_D.pieces || []).filter(p => (!_f.client || String(p.client_id) === _f.client) && (!_f.resp || p.responsable === _f.resp)
      && (!q || (p.titulo + ' ' + p.brief + ' ' + _cliName(p.client_id)).toLowerCase().includes(q)) && (!sinIdeas || p.estado !== 'idea'));
  }
  const _atrasada = p => p.fecha_plan && _d10(p.fecha_plan) < _hoy() && p.estado !== 'publicado';
  const _clienteOpts = sel => (_D.clients || []).map(c => `<option value="${c.id}"${String(c.id) === String(sel) ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join('');

  // ── Tarjeta de pieza ──
  function _redesHtml(p) { return (p.redes || []).map(r => `<span class="ct-net" title="${_e(_lbl(REDES, r))}">${_e(_redShort(r))}</span>`).join(''); }
  function _card(p) {
    const pil = _pilar(p.pilar_id), cl = _cliName(p.client_id), chk = p.checklist || [], done = chk.filter(i => i.ok).length;
    const i = ETAPAS.findIndex(e => e[0] === p.estado), nx = ETAPAS[i + 1], th = (p.media || []).map(_med).find(m => m && m.tipo === 'imagen');
    return `<div class="ct-card${_atrasada(p) ? ' is-late' : ''}" draggable="true" data-id="${p.id}" ondragstart="ContenidoModule.dragStart(event,${p.id})" onclick="ContenidoModule.abrir(${p.id})">
      ${pil ? `<span class="ct-card__pil" style="background:${_e(pil.color)}" title="${_e(pil.nombre)}"></span>` : ''}
      ${th ? `<img class="ct-card__th" src="${_e(th.url)}" alt="" loading="lazy">` : ''}
      <div class="ct-card__t">${_e(p.titulo)}</div>
      <div class="ct-card__m"><span class="ct-chip" style="--h:${_hue(cl)}">${_e(cl)}</span><span class="ct-fmt">${_e(_lbl(FORMATOS, p.formato))}</span>${_redesHtml(p)}</div>
      ${p.aprob_estado === 'cambios' ? '<div class="ct-flag ct-flag--c">El cliente pidió cambios</div>' : p.aprob_estado === 'pendiente' ? '<div class="ct-flag">Esperando al cliente</div>' : p.aprob_estado === 'aprobado' ? '<div class="ct-flag ct-flag--ok">Aprobada por el cliente</div>' : ''}
      <div class="ct-card__f">
        ${p.fecha_plan ? `<span class="ct-date${_atrasada(p) ? ' is-late' : ''}">${_fecha(p.fecha_plan)}${p.hora_plan ? ' · ' + _e(p.hora_plan) : ''}</span>` : '<span class="ct-date ct-date--no">Sin fecha</span>'}
        ${chk.length ? `<span class="ct-prog">${done}/${chk.length}</span>` : ''}
        ${p.n_comentarios ? `<span class="ct-prog" title="Comentarios">${p.n_comentarios} com.</span>` : ''}
        ${p.responsable ? `<span class="ct-av" title="${_e(p.responsable)}">${_e(_ini(p.responsable))}</span>` : ''}
        ${nx ? `<button type="button" class="ct-next" title="Pasar a «${_e(nx[1])}»" onclick="event.stopPropagation();ContenidoModule.mover(${p.id},'${nx[0]}')">›</button>` : ''}
      </div></div>`;
  }
  function _filtros(extra) {
    const resp = (_D.team || []).map(n => `<option${n === _f.resp ? ' selected' : ''}>${_e(n)}</option>`).join('');
    return `<div class="ct-bar"><input type="search" class="ct-search" placeholder="Buscar pieza o idea…" value="${_e(_f.q)}" oninput="ContenidoModule.filtrar('q',this.value)">
      <select class="ct-sel" onchange="ContenidoModule.filtrar('client',this.value)"><option value="">Todos los clientes</option>${_clienteOpts(_f.client)}</select>
      <select class="ct-sel" onchange="ContenidoModule.filtrar('resp',this.value)"><option value="">Todo el equipo</option>${resp}</select>${extra || ''}</div>`;
  }
  function _stats() {
    const v = _visibles(), hoy = _hoy(), fin = _iso(new Date(Date.now() + 6 * 864e5));
    const sem = v.filter(p => p.fecha_plan && _d10(p.fecha_plan) >= hoy && _d10(p.fecha_plan) <= fin && p.estado !== 'publicado').length;
    return `<div class="ct-stats"><span><b>${v.filter(p => p.estado === 'idea').length}</b> ideas</span><span><b>${sem}</b> esta semana</span><span class="${v.filter(_atrasada).length ? 'is-late' : ''}"><b>${v.filter(_atrasada).length}</b> atrasadas</span><span><b>${v.filter(p => p.estado === 'aprobacion').length}</b> por aprobar</span></div>`;
  }

  // ══ HOY ══
  function _vHoy() {
    const v = (_D.pieces || []), hoy = _hoy(), d = new Date();
    const deHoy = v.filter(p => p.fecha_plan && _d10(p.fecha_plan) === hoy && p.estado !== 'publicado' && p.estado !== 'idea');
    const tarde = v.filter(_atrasada), pend = v.filter(p => p.aprob_estado === 'pendiente' && p.estado !== 'publicado'), camb = v.filter(p => p.aprob_estado === 'cambios' && p.estado !== 'publicado');
    const ideas = v.filter(p => p.estado === 'idea').slice(0, 5);
    const lun = new Date(d); lun.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const semana = [0, 1, 2, 3, 4, 5, 6].map(i => { const x = new Date(lun); x.setDate(lun.getDate() + i); const k = _iso(x); return { k, d: x, n: v.filter(p => p.fecha_plan && _d10(p.fecha_plan) === k && p.estado !== 'idea').length }; });
    const iniSem = _iso(lun), finSem = semana[6].k, huecos = [];
    (_D.clients || []).forEach(c => {
      const fr = ((_D.strategies || {})[c.id] || {}).frecuencia || {};
      Object.entries(fr).forEach(([red, meta]) => { if (!meta) return; const hay = v.filter(p => p.client_id === c.id && (p.redes || []).includes(red) && p.fecha_plan && _d10(p.fecha_plan) >= iniSem && _d10(p.fecha_plan) <= finSem && p.estado !== 'idea').length; if (hay < meta) huecos.push({ c, red, falta: meta - hay, meta }); });
    });
    const kpi = (n, l, cls) => `<div class="ct-kpi ${cls || ''}"><b>${n}</b><span>${l}</span></div>`;
    const lista = (arr, vacio) => arr.length ? `<div class="ct-wrapcards">${arr.map(_card).join('')}</div>` : `<div class="ct-empty ct-empty--s">${vacio}</div>`;
    return `<div class="ct-kpis">${kpi(deHoy.length, 'Para hoy', deHoy.length ? 'is-on' : '')}${kpi(tarde.length, 'Atrasadas', tarde.length ? 'is-bad' : '')}${kpi(pend.length, 'Esperando al cliente')}${kpi(camb.length, 'Con cambios pedidos', camb.length ? 'is-bad' : '')}</div>
      <h4 class="ct-h4">Esta semana</h4><div class="ct-week">${semana.map(s => `<div class="ct-wk${s.k === hoy ? ' is-today' : ''}" onclick="ContenidoModule.irDia('${s.k}')"><small>${DIAS[(s.d.getDay() + 6) % 7]}</small><b>${s.d.getDate()}</b><span>${s.n ? s.n + (s.n === 1 ? ' pieza' : ' piezas') : '—'}</span></div>`).join('')}</div>
      <h4 class="ct-h4">Para hoy</h4>${lista(deHoy, 'Nada programado para hoy.')}
      ${tarde.length ? `<h4 class="ct-h4 is-late">Atrasadas</h4>${lista(tarde)}` : ''}
      ${camb.length ? `<h4 class="ct-h4 is-late">El cliente pidió cambios</h4>${lista(camb)}` : ''}
      ${pend.length ? `<h4 class="ct-h4">Esperando respuesta del cliente</h4>${lista(pend)}` : ''}
      ${huecos.length ? `<h4 class="ct-h4">Huecos de esta semana (según la frecuencia de cada cliente)</h4><div class="ct-gaps">${huecos.map(h => `<div class="ct-gap"><span class="ct-chip" style="--h:${_hue(h.c.empresa || h.c.nombre)}">${_e(h.c.empresa || h.c.nombre)}</span> ${_e(_lbl(REDES, h.red))}: faltan <b>${h.falta}</b> de ${h.meta}<button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.nuevaPara(${h.c.id},'${h.red}')">＋ Pieza</button></div>`).join('')}</div>` : ''}
      ${ideas.length ? `<h4 class="ct-h4">Ideas recientes</h4>${lista(ideas)}` : ''}`;
  }

  // ══ ESTRATEGIA ══
  function _vEstrategia() {
    const cl = _D.clients || [];
    if (!cl.length) return '<div class="ct-empty">Todavía no tienes clientes. Créalos en Operaciones → Clientes y aparecerán aquí.</div>';
    if (!_str.client || !cl.some(c => c.id === _str.client)) _str.client = cl[0].id;
    const s = (_D.strategies || {})[_str.client] || {}, fr = s.frecuencia || {};
    const redesC = [...new Set((_D.accounts || []).filter(a => a.client_id === _str.client).map(a => a.red))];
    const redesFr = redesC.length ? redesC : ['instagram', 'linkedin', 'tiktok', 'facebook'];
    const ta = (k, l, ph, rows) => `<label class="ct-lbl">${l}<textarea id="ct-s-${k}" class="ct-ta" rows="${rows || 3}" placeholder="${_e(ph)}">${_e(s[k] || '')}</textarea></label>`;
    return `<div class="ct-bar"><select class="ct-sel" style="flex-basis:280px" onchange="ContenidoModule.estrCliente(this.value)">${_clienteOpts(_str.client)}</select><span class="ct-hint">Esta información guía las ideas, el texto y los pendientes de cada pieza de este cliente.</span></div>
      <div class="ct-strat">${ta('objetivos', 'Objetivos de contenido', 'Ej. Generar consultas por WhatsApp, posicionarse como experto en…')}
        ${ta('audiencia', 'A quién le hablamos', 'Quién es, qué le preocupa, qué busca, dónde pasa el tiempo…')}
        ${ta('tono', 'Tono de voz', 'Cercano, técnico, divertido… y cómo se expresa la marca.')}
        ${ta('si_decir', 'Siempre decir / destacar', 'Mensajes clave, ventajas, frases de marca.')}
        ${ta('no_decir', 'Nunca decir / evitar', 'Temas prohibidos, palabras que no usa, promesas que no puede hacer.')}
        ${ta('hashtags', 'Hashtags base', '#marca #categoria …', 2)}
        ${ta('competidores', 'Referentes y competencia', 'Cuentas a mirar y qué hacen bien.', 2)}
        ${ta('horarios', 'Mejores horarios', 'Ej. Instagram: martes y jueves 19:00. LinkedIn: lunes 8:30.', 2)}
        ${ta('firma', 'Firma o cierre fijo', 'Texto que se añade al final de las publicaciones.', 2)}
        ${ta('notas', 'Notas', 'Cualquier otra regla o contexto.', 2)}</div>
      <h4 class="ct-h4">Frecuencia objetivo (piezas por semana y red)</h4>
      <div class="ct-freq">${redesFr.map(r => `<label class="ct-fr"><span>${_e(_lbl(REDES, r))}</span><input type="number" min="0" max="50" id="ct-fr-${r}" value="${_e(fr[r] || 0)}" class="ct-in"></label>`).join('')}</div>
      <div class="ct-actions"><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.guardarEstrategia()">Guardar estrategia</button></div>`;
  }
  function estrCliente(v) { _str.client = +v; _pintar(); }
  async function guardarEstrategia() {
    const d = {}; ['objetivos', 'audiencia', 'tono', 'si_decir', 'no_decir', 'hashtags', 'competidores', 'horarios', 'firma', 'notas'].forEach(k => { d[k] = (document.getElementById('ct-s-' + k) || {}).value || ''; });
    d.frecuencia = {}; REDES.forEach(r => { const i = document.getElementById('ct-fr-' + r[0]); if (i) d.frecuencia[r[0]] = parseInt(i.value) || 0; });
    try { _D.strategies[_str.client] = await _post('/content/strategy/' + _str.client, d, 'PUT'); _toast('Estrategia guardada'); } catch (e) { _toast(e.message, 'error'); }
  }

  // ══ TABLERO / IDEAS ══
  function _vTablero() {
    const v = _visibles();
    const cols = ETAPAS.map(([k, l]) => { const items = v.filter(p => p.estado === k);
      return `<section class="ct-col" data-estado="${k}" ondragover="event.preventDefault();this.classList.add('is-over')" ondragleave="this.classList.remove('is-over')" ondrop="ContenidoModule.soltar(event,'${k}')"><header class="ct-col__h"><span>${l}</span><i>${items.length}</i></header><div class="ct-col__b">${items.map(_card).join('') || '<div class="ct-col__e">—</div>'}</div></section>`; }).join('');
    return `${_filtros('<button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.nueva()">＋ Nueva pieza</button>')}${_stats()}<div class="ct-board">${cols}</div>`;
  }
  function _vIdeas() {
    const ideas = _visibles().filter(p => p.estado === 'idea');
    return `<div class="ct-quick"><input id="ct-q-t" class="ct-quick__t" placeholder="Escribe una idea y pulsa Enter…" onkeydown="if(event.key==='Enter')ContenidoModule.capturar()"><select id="ct-q-c" class="ct-sel"><option value="">Sin cliente</option>${_clienteOpts(_f.client)}</select><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.capturar()">Guardar idea</button></div>${_filtros()}
      <div class="ct-ideas">${ideas.length ? ideas.map(p => `<div class="ct-idea" onclick="ContenidoModule.abrir(${p.id})"><div class="ct-idea__t">${_e(p.titulo)}</div><div class="ct-idea__m"><span class="ct-chip" style="--h:${_hue(_cliName(p.client_id))}">${_e(_cliName(p.client_id))}</span><span class="ct-fmt">${_e(_lbl(FORMATOS, p.formato))}</span>${_redesHtml(p)}</div><button type="button" class="btn btn--ghost btn--sm" onclick="event.stopPropagation();ContenidoModule.mover(${p.id},'desarrollo')">Desarrollar ›</button></div>`).join('') : '<div class="ct-empty">Aún no hay ideas. Anota la primera arriba: título corto y listo, la desarrollas después.</div>'}</div>`;
  }

  // ══ CALENDARIO (mes y semana) ══
  function _evHtml(p) {
    const pil = _pilar(p.pilar_id), cp = _camp(p.campaign_id), col = cp ? cp.color : (pil ? pil.color : '');
    return `<div class="ct-ev ct-ev--${_e(p.estado)}" draggable="true" ondragstart="ContenidoModule.dragStart(event,${p.id})" onclick="event.stopPropagation();ContenidoModule.abrir(${p.id})" style="${col ? '--pc:' + _e(col) : ''}" title="${_e(p.titulo)}">${p.hora_plan ? `<b>${_e(p.hora_plan)}</b> ` : ''}${_e(p.titulo)}</div>`;
  }
  function _celda(d, items, extra) {
    const k = _iso(d), hoy = _hoy();
    return `<div class="ct-day${extra || ''}${k === hoy ? ' is-today' : ''}${k === _cal.sel ? ' is-sel' : ''}" ondragover="event.preventDefault()" ondrop="ContenidoModule.soltarDia(event,'${k}')" onclick="ContenidoModule.dia('${k}')">
      <div class="ct-day__n"><span>${d.getDate()}</span><button type="button" class="ct-day__add" title="Nueva pieza este día" onclick="event.stopPropagation();ContenidoModule.nueva('${k}')">＋</button></div>
      ${items.slice(0, _cal.modo === 'semana' ? 30 : 3).map(_evHtml).join('')}${_cal.modo === 'mes' && items.length > 3 ? `<div class="ct-more">+${items.length - 3} más</div>` : ''}
      ${items.length ? `<div class="ct-dots">${items.slice(0, 5).map(p => `<i class="ct-dot ct-dot--${_e(p.estado)}"></i>`).join('')}</div>` : ''}</div>`;
  }
  function _vCal() {
    const now = new Date(); if (!_cal.y) { _cal.y = now.getFullYear(); _cal.m = now.getMonth(); }
    if (!_cal.ref) { const r = new Date(now); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); _cal.ref = _iso(r); }
    const v = _visibles().filter(p => p.fecha_plan), byDay = {};
    v.forEach(p => { const k = _d10(p.fecha_plan); (byDay[k] = byDay[k] || []).push(p); });
    Object.values(byDay).forEach(a => a.sort((x, y) => (x.hora_plan || '99').localeCompare(y.hora_plan || '99')));
    let cells = '', titulo = '';
    if (_cal.modo === 'semana') {
      const ini = new Date(_cal.ref + 'T00:00:00'); const fin = new Date(ini); fin.setDate(ini.getDate() + 6);
      titulo = ini.getDate() + ' ' + MESES[ini.getMonth()].slice(0, 3) + ' – ' + fin.getDate() + ' ' + MESES[fin.getMonth()].slice(0, 3) + ' ' + fin.getFullYear();
      for (let i = 0; i < 7; i++) { const d = new Date(ini); d.setDate(ini.getDate() + i); cells += _celda(d, byDay[_iso(d)] || [], ' is-wk'); }
    } else {
      titulo = MESES[_cal.m] + ' ' + _cal.y;
      const first = new Date(_cal.y, _cal.m, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
      for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const fuera = d.getMonth() !== _cal.m; if (i >= 35 && fuera) break; cells += _celda(d, byDay[_iso(d)] || [], fuera ? ' is-out' : ''); }
    }
    const sinFecha = _visibles().filter(p => !p.fecha_plan && p.estado !== 'idea' && p.estado !== 'publicado');
    const selList = _cal.sel ? (byDay[_cal.sel] || []) : [];
    const camps = (_D.campaigns || []).filter(c => !_f.client || String(c.client_id) === _f.client);
    return `${_filtros()}<div class="ct-calh"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(-1)">‹</button><b>${_e(titulo)}</b><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(1)">›</button><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(0)">Hoy</button>
        <span class="ct-seg"><button type="button" class="${_cal.modo === 'mes' ? 'on' : ''}" onclick="ContenidoModule.modo('mes')">Mes</button><button type="button" class="${_cal.modo === 'semana' ? 'on' : ''}" onclick="ContenidoModule.modo('semana')">Semana</button></span></div>
      ${camps.length ? `<div class="ct-legend">${camps.map(c => `<span><i style="background:${_e(c.color)}"></i>${_e(c.nombre)}</span>`).join('')}</div>` : ''}
      <div class="ct-cal"><div class="ct-wd">${DIAS.map(x => `<span>${x}</span>`).join('')}</div><div class="ct-grid${_cal.modo === 'semana' ? ' is-week' : ''}">${cells}</div></div>
      ${_cal.sel ? `<div class="ct-agenda"><h4>${_e(_fechaL(_cal.sel))} <button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.nueva('${_cal.sel}')">＋ Nueva pieza</button></h4>${selList.map(_card).join('') || '<div class="ct-empty">Nada planificado este día.</div>'}</div>` : ''}
      ${sinFecha.length ? `<div class="ct-agenda"><h4>Sin fecha asignada (${sinFecha.length})</h4><div class="ct-wrapcards">${sinFecha.map(_card).join('')}</div></div>` : ''}`;
  }

  // ══ CAMPAÑAS ══
  function _vCampanas() {
    const cs = (_D.campaigns || []).filter(c => !_f.client || String(c.client_id) === _f.client);
    const cards = cs.map(c => {
      const ps = (_D.pieces || []).filter(p => p.campaign_id === c.id), pub = ps.filter(p => p.estado === 'publicado').length, pct = ps.length ? Math.round(pub / ps.length * 100) : 0;
      const fin = c.fin ? _d10(c.fin) : '', act = (!c.inicio || _d10(c.inicio) <= _hoy()) && (!fin || fin >= _hoy());
      return `<article class="ct-camp" style="--cc:${_e(c.color)}"><header><b>${_e(c.nombre)}</b><span class="ct-badge ${act ? 'is-on' : ''}">${act ? 'En curso' : (fin && fin < _hoy() ? 'Terminada' : 'Próxima')}</span></header>
        <div class="ct-camp__m"><span class="ct-chip" style="--h:${_hue(_cliName(c.client_id))}">${_e(_cliName(c.client_id))}</span><span>${c.inicio ? _fecha(c.inicio) : '—'} → ${c.fin ? _fecha(c.fin) : '—'}</span></div>
        ${c.objetivo ? `<p>${_e(c.objetivo)}</p>` : ''}<div class="ct-bar2"><i style="width:${pct}%"></i></div><small>${pub} de ${ps.length} piezas publicadas</small>
        <div class="ct-actions"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.campania(${c.id})">Editar</button><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.nuevaCamp(${c.id})">＋ Pieza de la campaña</button></div></article>`;
    }).join('');
    return `${_filtros('<button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.campania(0)">＋ Nueva campaña</button>')}<div class="ct-clients">${cards || '<div class="ct-empty">Aún no hay campañas. Crea una para agrupar las piezas de un lanzamiento o temporada.</div>'}</div>`;
  }
  function campania(id) {
    const c = id ? _camp(id) : { id: 0, nombre: '', client_id: _f.client ? +_f.client : null, objetivo: '', inicio: '', fin: '', color: '#3B82F6' };
    document.getElementById('ct-mini')?.remove();
    const m = document.createElement('div'); m.id = 'ct-mini'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="fin-pi-box ct-mbox"><div class="fin-pi-box__hd"><h3>${id ? 'Editar campaña' : 'Nueva campaña'}</h3><button class="fin-pi-x" onclick="document.getElementById('ct-mini').remove()">✕</button></div>
      <div class="flt-body ct-form"><label class="ct-lbl">Nombre<input id="ct-cp-n" class="ct-in" value="${_e(c.nombre)}" placeholder="Ej. Lanzamiento colección verano"></label>
      <label class="ct-lbl">Cliente<select id="ct-cp-c" class="ct-in"><option value="">—</option>${_clienteOpts(c.client_id)}</select></label>
      <div class="ct-row3"><label class="ct-lbl">Inicio<input id="ct-cp-i" type="date" class="ct-in" value="${_e(_d10(c.inicio))}"></label><label class="ct-lbl">Fin<input id="ct-cp-f" type="date" class="ct-in" value="${_e(_d10(c.fin))}"></label><label class="ct-lbl">Color<input id="ct-cp-k" type="color" class="ct-in" value="${_e(c.color)}"></label></div>
      <label class="ct-lbl">Objetivo<textarea id="ct-cp-o" class="ct-ta" rows="3" placeholder="Qué queremos lograr con la campaña">${_e(c.objetivo)}</textarea></label></div>
      <div class="fin-pi-box__ft"><span>${id ? `<button type="button" class="btn btn--ghost btn--sm ct-del" onclick="ContenidoModule.borrarCamp(${id})">Eliminar</button>` : ''}</span><div class="fin-pi-ft-btns"><button class="btn btn--primary btn--sm" onclick="ContenidoModule.guardarCamp(${id})">Guardar</button></div></div></div>`;
    document.body.appendChild(m);
  }
  async function guardarCamp(id) {
    const g = i => document.getElementById(i).value, body = { nombre: g('ct-cp-n'), client_id: g('ct-cp-c') || null, inicio: g('ct-cp-i'), fin: g('ct-cp-f'), color: g('ct-cp-k'), objetivo: g('ct-cp-o') };
    try { const r = await _post('/content/campaigns' + (id ? '/' + id : ''), body, id ? 'PUT' : 'POST'); const i = _D.campaigns.findIndex(c => c.id === r.id); if (i >= 0) _D.campaigns[i] = r; else _D.campaigns.push(r); document.getElementById('ct-mini').remove(); _pintar(); _toast('Campaña guardada'); } catch (e) { _toast(e.message, 'error'); }
  }
  async function borrarCamp(id) { if (!confirm('¿Eliminar la campaña? Las piezas se quedan, sin campaña.')) return; try { await _j('/content/campaigns/' + id, { method: 'DELETE' }); _D.campaigns = _D.campaigns.filter(c => c.id !== id); _D.pieces.forEach(p => { if (p.campaign_id === id) p.campaign_id = null; }); document.getElementById('ct-mini').remove(); _pintar(); } catch (e) { _toast(e.message, 'error'); } }

  // ══ BIBLIOTECA ══
  function _mediaFiltrada() { const q = _bib.q.toLowerCase(); return (_D.media || []).filter(m => (!_bib.client || String(m.client_id) === _bib.client) && (!_bib.carpeta || m.carpeta === _bib.carpeta) && (!q || m.nombre.toLowerCase().includes(q))); }
  function _mediaThumb(m, cls) { return m.tipo === 'imagen' ? `<img src="${_e(m.url)}" alt="" loading="lazy" class="${cls || ''}">` : m.tipo === 'video' ? `<video src="${_e(m.url)}#t=0.1" preload="metadata" muted playsinline class="${cls || ''}"></video>` : `<div class="ct-doc ${cls || ''}">PDF</div>`; }
  function _vBiblioteca() {
    const ms = _mediaFiltrada(), carpetas = [...new Set((_D.media || []).filter(m => !_bib.client || String(m.client_id) === _bib.client).map(m => m.carpeta).filter(Boolean))];
    const uso = id => (_D.pieces || []).filter(p => (p.media || []).includes(id)).length;
    return `<div class="ct-bar"><input type="search" class="ct-search" placeholder="Buscar archivo…" value="${_e(_bib.q)}" oninput="ContenidoModule.bibFiltro('q',this.value)">
        <select class="ct-sel" onchange="ContenidoModule.bibFiltro('client',this.value)"><option value="">Todos los clientes</option>${_clienteOpts(_bib.client)}</select>
        <select class="ct-sel" onchange="ContenidoModule.bibFiltro('carpeta',this.value)"><option value="">Todas las carpetas</option>${carpetas.map(c => `<option${c === _bib.carpeta ? ' selected' : ''}>${_e(c)}</option>`).join('')}</select></div>
      <label class="ct-drop" id="ct-drop" ondragover="event.preventDefault();this.classList.add('is-over')" ondragleave="this.classList.remove('is-over')" ondrop="event.preventDefault();this.classList.remove('is-over');ContenidoModule.subir(event.dataTransfer.files)">
        <input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf" style="display:none" onchange="ContenidoModule.subir(this.files)">
        <b>Arrastra archivos aquí o haz clic para subir</b><span>Imágenes, videos (hasta 90 MB) y PDF. ${_bib.client ? 'Se guardan en ' + _e(_cliName(+_bib.client)) + '.' : 'Elige un cliente arriba para asignarlos.'}</span></label>
      <div class="ct-media">${ms.map(m => `<div class="ct-m" onclick="ContenidoModule.verMedia(${m.id})">${_mediaThumb(m)}<div class="ct-m__i"><span title="${_e(m.nombre)}">${_e(m.nombre)}</span><small>${_e(_cliName(m.client_id))}${uso(m.id) ? ' · en ' + uso(m.id) + ' pieza(s)' : ''}</small></div></div>`).join('') || '<div class="ct-empty" style="grid-column:1/-1">Aún no hay archivos.</div>'}</div>`;
  }
  function bibFiltro(k, v) { _bib[k] = v; _pintar(); if (k === 'q') { const i = _host.querySelector('.ct-search'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } } }
  async function subir(files, opt) {
    files = [...(files || [])]; if (!files.length) return;
    const cid = (opt && opt.client_id) || _bib.client; if (!cid) { _toast('Elige primero un cliente para guardar los archivos', 'error'); return; }
    const fd = new FormData(); files.forEach(f => fd.append('files', f)); fd.append('client_id', cid); if (_bib.carpeta) fd.append('carpeta', _bib.carpeta);
    _toast('Subiendo ' + files.length + ' archivo(s)…', 'info');
    try {
      const r = await apiFetch(_api() + '/content/media', { method: 'POST', body: fd }); const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo subir');
      _D.media = (d.media || []).concat(_D.media || []);
      if (d.skipped && d.skipped.length) _toast('No se aceptó: ' + d.skipped.join(', '), 'error'); else _toast('Archivos subidos');
      if (opt && opt.attach && _p) { _p.media = (_p.media || []).concat((d.media || []).map(m => m.id)); recargar(); } else _pintar();
    } catch (e) { _toast(e.message, 'error'); }
  }
  function verMedia(id) {
    const m = _med(id); if (!m) return; document.getElementById('ct-mini')?.remove();
    const mo = document.createElement('div'); mo.id = 'ct-mini'; mo.className = 'fin-pi-backdrop'; mo.onclick = e => { if (e.target === mo) mo.remove(); };
    const cont = m.tipo === 'imagen' ? `<img src="${_e(m.url)}" alt="" class="ct-mv">` : m.tipo === 'video' ? `<video src="${_e(m.url)}" controls playsinline class="ct-mv"></video>` : `<a href="${_e(m.url)}" target="_blank" rel="noopener" class="btn btn--ghost">Abrir PDF</a>`;
    mo.innerHTML = `<div class="fin-pi-box ct-mbox"><div class="fin-pi-box__hd"><h3 title="${_e(m.nombre)}">${_e(m.nombre)}</h3><button class="fin-pi-x" onclick="document.getElementById('ct-mini').remove()">✕</button></div><div class="flt-body ct-center">${cont}<small>${_e(_cliName(m.client_id))} · ${(m.size / 1048576).toFixed(1)} MB</small></div>
      <div class="fin-pi-box__ft"><span><button type="button" class="btn btn--ghost btn--sm ct-del" onclick="ContenidoModule.borrarMedia(${m.id})">Eliminar</button></span><div class="fin-pi-ft-btns"><button class="btn btn--ghost btn--sm" onclick="ContenidoModule.copiarTxt('${_e(m.url)}')">Copiar enlace</button><a class="btn btn--primary btn--sm" href="${_e(m.url)}" download="${_e(m.nombre)}" target="_blank" rel="noopener">Descargar</a></div></div></div>`;
    document.body.appendChild(mo);
  }
  function copiarTxt(t) { _copiar(t, 'Copiado'); }
  async function borrarMedia(id) { if (!confirm('¿Eliminar este archivo? Se quita también de las piezas que lo usan.')) return; try { await _j('/content/media/' + id, { method: 'DELETE' }); _D.media = _D.media.filter(m => m.id !== id); _D.pieces.forEach(p => { p.media = (p.media || []).filter(x => x !== id); }); document.getElementById('ct-mini')?.remove(); _pintar(); } catch (e) { _toast(e.message, 'error'); } }

  // ══ APROBACIONES ══
  function _vAprobaciones() {
    const elegibles = (_D.pieces || []).filter(p => p.estado !== 'publicado' && p.estado !== 'idea' && (!_ap.client || String(p.client_id) === _ap.client));
    const ap = (_D.approvals || []);
    return `<div class="ct-two"><section class="ct-panel"><h4>Nuevo envío al cliente</h4>
        <div class="ct-bar"><select class="ct-sel" style="flex:1" onchange="ContenidoModule.apCliente(this.value)"><option value="">Elige un cliente</option>${_clienteOpts(_ap.client)}</select></div>
        <div class="ct-pickl">${_ap.client ? (elegibles.map(p => `<label class="ct-pk"><input type="checkbox" ${_ap.sel[p.id] ? 'checked' : ''} onchange="ContenidoModule.apSel(${p.id},this.checked)"><span><b>${_e(p.titulo)}</b><small>${_e(_lbl(ETAPAS, p.estado))}${p.fecha_plan ? ' · ' + _fecha(p.fecha_plan) : ''}${p.aprob_estado ? ' · ' + _e(p.aprob_estado) : ''}</small></span></label>`).join('') || '<div class="ct-empty ct-empty--s">Este cliente no tiene piezas en producción.</div>') : '<div class="ct-empty ct-empty--s">Elige un cliente para ver sus piezas.</div>'}</div>
        <label class="ct-lbl">Título del envío<input id="ct-ap-t" class="ct-in" placeholder="Ej. Contenido de noviembre"></label>
        <div class="ct-actions"><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.apCrear()">Crear enlace para el cliente</button></div></section>
      <section class="ct-panel"><h4>Enlaces enviados</h4>${ap.length ? ap.map(a => { const ps = (_D.pieces || []).filter(p => (a.piece_ids || []).includes(p.id)), c = k => ps.filter(p => p.aprob_estado === k).length, vivo = !a.revoked && new Date(a.expires_at) > new Date();
        return `<div class="ct-apr"><div><b>${_e(a.titulo || 'Sin título')}</b><small>${_e(_cliName(a.client_id))} · ${(a.piece_ids || []).length} piezas · ${_fecha(a.created_at)}</small>
          <div class="ct-apr__s"><span class="ct-badge is-ok">${c('aprobado')} aprobadas</span><span class="ct-badge is-bad">${c('cambios')} con cambios</span><span class="ct-badge">${c('pendiente')} pendientes</span>${vivo ? '' : '<span class="ct-badge">Cerrado</span>'}</div></div>
          <div class="ct-apr__b">${vivo ? `<button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.copiarTxt('${_e(a.url)}')">Copiar enlace</button><a class="btn btn--ghost btn--sm" href="${_e(a.url)}" target="_blank" rel="noopener">Abrir</a><button type="button" class="btn btn--ghost btn--sm ct-del" onclick="ContenidoModule.apRevocar(${a.id})">Cerrar</button>` : ''}</div></div>`; }).join('') : '<div class="ct-empty ct-empty--s">Todavía no has enviado nada.</div>'}</section></div>`;
  }
  function apCliente(v) { _ap.client = v; _ap.sel = {}; _pintar(); }
  function apSel(id, on) { if (on) _ap.sel[id] = 1; else delete _ap.sel[id]; }
  async function apCrear(ids, titulo) {
    ids = ids || Object.keys(_ap.sel).map(Number); if (!ids.length) { _toast('Marca al menos una pieza', 'error'); return; }
    const t = titulo || (document.getElementById('ct-ap-t') || {}).value || '';
    try {
      const r = await _post('/content/approvals', { piece_ids: ids, titulo: t, client_id: _ap.client || null }); (_D.approvals = _D.approvals || []).unshift(r);
      ids.forEach(id => { const p = _D.pieces.find(x => x.id === id); if (p) { p.aprob_estado = 'pendiente'; if (['idea', 'desarrollo', 'texto', 'diseno', 'revision'].includes(p.estado)) p.estado = 'aprobacion'; } });
      _ap.sel = {}; await _copiar(r.url, 'Enlace creado y copiado. Envíaselo al cliente.'); _pintar();
    } catch (e) { _toast(e.message, 'error'); }
  }
  async function apRevocar(id) { if (!confirm('¿Cerrar este enlace? El cliente ya no podrá verlo.')) return; try { await _j('/content/approvals/' + id + '/revoke', { method: 'POST' }); const a = _D.approvals.find(x => x.id === id); if (a) a.revoked = true; _pintar(); } catch (e) { _toast(e.message, 'error'); } }

  // ══ PUBLICAR ══
  function _vPublicar() {
    const hoy = _hoy(), fin = _iso(new Date(Date.now() + 7 * 864e5));
    const cola = _visibles().filter(p => p.estado === 'programado' || (p.estado === 'aprobacion' && p.aprob_estado === 'aprobado'));
    const g = {
      'Atrasadas': cola.filter(p => p.fecha_plan && _d10(p.fecha_plan) < hoy), 'Hoy': cola.filter(p => p.fecha_plan && _d10(p.fecha_plan) === hoy),
      'Próximos 7 días': cola.filter(p => p.fecha_plan && _d10(p.fecha_plan) > hoy && _d10(p.fecha_plan) <= fin), 'Más adelante': cola.filter(p => p.fecha_plan && _d10(p.fecha_plan) > fin), 'Listas, sin fecha': cola.filter(p => !p.fecha_plan),
    };
    const recientes = _visibles().filter(p => p.estado === 'publicado').sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))).slice(0, 8);
    const fila = p => {
      const st = ((_D.strategies || {})[p.client_id] || {}), medias = (p.media || []).map(_med).filter(Boolean);
      const bloques = (p.redes || []).map(r => { const base = (p.copy || {})[r] || ''; const full = (base + (p.hashtags ? '\n\n' + p.hashtags : '') + (st.firma ? '\n\n' + st.firma : '')).trim();
        return `<div class="ct-out"><div class="ct-out__h"><span class="ct-net">${_e(_redShort(r))}</span><b>${_e(_lbl(REDES, r))}</b>${URL_RED[r] ? `<a class="ct-link" href="${_e(URL_RED[r])}" target="_blank" rel="noopener">Abrir ${_e(_lbl(REDES, r))}</a>` : ''}<button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.copiarPub(${p.id},'${r}')">Copiar texto</button></div><pre>${_e(full) || '<sin texto para esta red>'}</pre></div>`; }).join('') || '<div class="ct-empty ct-empty--s">Esta pieza no tiene redes elegidas.</div>';
      return `<div class="ct-pub"><div class="ct-pub__h" onclick="ContenidoModule.abrir(${p.id})"><b>${_e(p.titulo)}</b><span class="ct-chip" style="--h:${_hue(_cliName(p.client_id))}">${_e(_cliName(p.client_id))}</span><span class="ct-date${_atrasada(p) ? ' is-late' : ''}">${p.fecha_plan ? _fecha(p.fecha_plan) + (p.hora_plan ? ' · ' + _e(p.hora_plan) : '') : 'Sin fecha'}</span></div>
        <div class="ct-pub__b">${bloques}
        ${p.primer_comentario ? `<div class="ct-out"><div class="ct-out__h"><b>Primer comentario</b><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.copiarPrimer(${p.id})">Copiar</button></div><pre>${_e(p.primer_comentario)}</pre></div>` : ''}
        ${medias.length ? `<div class="ct-out"><div class="ct-out__h"><b>Archivos (${medias.length})</b></div><div class="ct-thumbs">${medias.map(m => `<a href="${_e(m.url)}" download="${_e(m.nombre)}" target="_blank" rel="noopener" title="Descargar ${_e(m.nombre)}">${_mediaThumb(m)}</a>`).join('')}</div></div>` : ''}
        <div class="ct-actions"><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.marcarPub(${p.id})">Marcar como publicada</button><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.abrir(${p.id})">Editar pieza</button></div></div></div>`;
    };
    return `${_filtros()}<p class="ct-hint">Aquí aparece lo que está <b>programado</b> o ya <b>aprobado por el cliente</b>. Copia el texto, descarga los archivos, publícalo en la red y márcalo como publicado con su enlace.</p>
      ${Object.entries(g).filter(([, a]) => a.length).map(([t, a]) => `<h4 class="ct-h4${t === 'Atrasadas' ? ' is-late' : ''}">${t} (${a.length})</h4>${a.map(fila).join('')}`).join('') || '<div class="ct-empty">No hay nada listo para publicar. Cuando una pieza pase a «Programado» o el cliente la apruebe, aparecerá aquí.</div>'}
      ${recientes.length ? `<h4 class="ct-h4">Publicadas recientemente</h4><div class="ct-wrapcards">${recientes.map(_card).join('')}</div>` : ''}`;
  }
  function copiarPrimer(id) { const p = _D.pieces.find(x => x.id === id); if (p) _copiar(p.primer_comentario || '', 'Comentario copiado'); }
  function copiarPub(id, red) { const p = _D.pieces.find(x => x.id === id); if (!p) return; const st = (_D.strategies || {})[p.client_id] || {}; _copiar(((p.copy || {})[red] || '') + (p.hashtags ? '\n\n' + p.hashtags : '') + (st.firma ? '\n\n' + st.firma : ''), 'Texto copiado'); }
  function marcarPub(id) {
    document.getElementById('ct-mini')?.remove(); const m = document.createElement('div'); m.id = 'ct-mini'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="fin-pi-box ct-mbox"><div class="fin-pi-box__hd"><h3>Marcar como publicada</h3><button class="fin-pi-x" onclick="document.getElementById('ct-mini').remove()">✕</button></div><div class="flt-body ct-form"><label class="ct-lbl">Enlace de la publicación (opcional)<input id="ct-pub-l" class="ct-in" placeholder="https://…"></label><p class="ct-hint">Después podrás anotar sus resultados en Analítica.</p></div><div class="fin-pi-box__ft"><span></span><div class="fin-pi-ft-btns"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('ct-mini').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="ContenidoModule.confirmarPub(${id})">Marcar publicada</button></div></div></div>`;
    document.body.appendChild(m); setTimeout(() => document.getElementById('ct-pub-l')?.focus(), 30);
  }
  async function confirmarPub(id) {
    const l = (document.getElementById('ct-pub-l') || {}).value || '';
    try { const r = await _post('/content/pieces/' + id, { estado: 'publicado', link_publicado: l.trim() }, 'PATCH'); const p = _D.pieces.find(x => x.id === id); if (p) Object.assign(p, r); document.getElementById('ct-mini').remove(); _pintar(); _toast('Marcada como publicada'); } catch (e) { _toast(e.message, 'error'); }
  }

  // ══ ANALÍTICA ══
  const _inter = r => (r.likes || 0) + (r.comentarios || 0) + (r.guardados || 0) + (r.compartidos || 0);
  function _pubs(cid, dias) {
    const lim = dias === 'todo' ? '' : _iso(new Date(Date.now() - (+dias) * 864e5));
    return (_D.pieces || []).filter(p => p.estado === 'publicado' && (!cid || String(p.client_id) === String(cid)) && (!lim || _d10(p.published_at || p.fecha_plan || p.updated_at) >= lim));
  }
  function _suma(arr) { const t = { alcance: 0, interacciones: 0, clics: 0, n: arr.length, conRes: 0 }; arr.forEach(p => { const r = p.resultados || {}; if (r.alcance || r.likes || r.comentarios || r.guardados || r.compartidos || r.clics) t.conRes++; t.alcance += r.alcance || 0; t.interacciones += _inter(r); t.clics += r.clics || 0; }); t.tasa = t.alcance ? (t.interacciones / t.alcance * 100) : 0; return t; }
  function _desglose(arr, keyFn, labelFn) {
    const m = {}; arr.forEach(p => { (keyFn(p) || []).forEach(k => { const o = m[k] = m[k] || { k, n: 0, alcance: 0, inter: 0 }; o.n++; const r = p.resultados || {}; o.alcance += r.alcance || 0; o.inter += _inter(r); }); });
    const rows = Object.values(m).sort((a, b) => b.alcance - a.alcance || b.n - a.n), max = Math.max(1, ...rows.map(r => r.alcance));
    return rows.length ? `<table class="ct-tbl"><thead><tr><th></th><th>Piezas</th><th>Alcance</th><th>Interacciones</th><th>Tasa</th></tr></thead><tbody>${rows.map(r => `<tr><td>${_e(labelFn(r.k))}<div class="ct-bar2"><i style="width:${Math.round(r.alcance / max * 100)}%"></i></div></td><td>${r.n}</td><td>${_n(r.alcance)}</td><td>${_n(r.inter)}</td><td>${r.alcance ? (r.inter / r.alcance * 100).toFixed(1) + '%' : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="ct-empty ct-empty--s">Sin datos todavía.</div>';
  }
  function _vAnalitica() {
    const arr = _pubs(_an.client, _an.rango), t = _suma(arr);
    const top = arr.slice().sort((a, b) => _inter(b.resultados || {}) - _inter(a.resultados || {})).filter(p => _inter(p.resultados || {}) > 0).slice(0, 5);
    const semanas = []; for (let i = 7; i >= 0; i--) { const f = new Date(Date.now() - i * 7 * 864e5); const ini = new Date(f); ini.setDate(f.getDate() - ((f.getDay() + 6) % 7)); const fin = new Date(ini); fin.setDate(ini.getDate() + 6); semanas.push({ l: ini.getDate() + '/' + (ini.getMonth() + 1), n: arr.filter(p => { const k = _d10(p.published_at || p.fecha_plan); return k >= _iso(ini) && k <= _iso(fin); }).length }); }
    const mx = Math.max(1, ...semanas.map(s => s.n));
    return `<div class="ct-bar"><select class="ct-sel" onchange="ContenidoModule.anFiltro('client',this.value)"><option value="">Todos los clientes</option>${_clienteOpts(_an.client)}</select>
        <select class="ct-sel" onchange="ContenidoModule.anFiltro('rango',this.value)">${[['30', 'Últimos 30 días'], ['90', 'Últimos 90 días'], ['365', 'Último año'], ['todo', 'Todo']].map(([k, l]) => `<option value="${k}"${_an.rango === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="ct-kpis"><div class="ct-kpi"><b>${t.n}</b><span>Publicadas</span></div><div class="ct-kpi"><b>${_n(t.alcance)}</b><span>Alcance</span></div><div class="ct-kpi"><b>${_n(t.interacciones)}</b><span>Interacciones</span></div><div class="ct-kpi"><b>${t.tasa ? t.tasa.toFixed(1) + '%' : '—'}</b><span>Tasa de interacción</span></div><div class="ct-kpi"><b>${_n(t.clics)}</b><span>Clics</span></div></div>
      ${t.n && t.conRes < t.n ? `<p class="ct-hint">${t.n - t.conRes} de ${t.n} piezas aún no tienen resultados anotados. Pulsa «Anotar» en la lista de abajo.</p>` : ''}
      <h4 class="ct-h4">Publicaciones por semana</h4><div class="ct-bars">${semanas.map(s => `<div><i style="height:${Math.round(s.n / mx * 70) + 4}px" title="${s.n}"></i><b>${s.n}</b><small>${s.l}</small></div>`).join('')}</div>
      <div class="ct-two"><section class="ct-panel"><h4>Por red</h4>${_desglose(arr, p => p.redes, k => _lbl(REDES, k))}</section><section class="ct-panel"><h4>Por formato</h4>${_desglose(arr, p => [p.formato], k => _lbl(FORMATOS, k))}</section></div>
      <div class="ct-two"><section class="ct-panel"><h4>Por pilar</h4>${_desglose(arr, p => [p.pilar_id ? String(p.pilar_id) : '0'], k => k === '0' ? 'Sin pilar' : ((_pilar(+k) || {}).nombre || 'Pilar'))}</section>
        <section class="ct-panel"><h4>Mejores piezas</h4>${top.length ? top.map((p, i) => `<div class="ct-top" onclick="ContenidoModule.abrir(${p.id})"><b>${i + 1}</b><span>${_e(p.titulo)}<small>${_e(_cliName(p.client_id))} · ${_n(_inter(p.resultados || {}))} interacciones</small></span></div>`).join('') : '<div class="ct-empty ct-empty--s">Anota resultados para ver cuáles funcionan mejor.</div>'}</section></div>
      <h4 class="ct-h4">Piezas publicadas</h4><table class="ct-tbl"><thead><tr><th>Pieza</th><th>Cliente</th><th>Alcance</th><th>Interacc.</th><th></th></tr></thead><tbody>${arr.map(p => { const r = p.resultados || {}; return `<tr><td>${_e(p.titulo)}${p.link_publicado ? ` <a class="ct-link" href="${_e(p.link_publicado)}" target="_blank" rel="noopener">ver</a>` : ''}</td><td>${_e(_cliName(p.client_id))}</td><td>${r.alcance ? _n(r.alcance) : '—'}</td><td>${_inter(r) ? _n(_inter(r)) : '—'}</td><td><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.anotar(${p.id})">Anotar</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="ct-empty">Aún no hay piezas publicadas en este periodo.</td></tr>'}</tbody></table>`;
  }
  function anFiltro(k, v) { _an[k] = v; _pintar(); }
  function anotar(id) {
    const p = _D.pieces.find(x => x.id === id); if (!p) return; const r = p.resultados || {}; document.getElementById('ct-mini')?.remove();
    const campos = [['alcance', 'Alcance'], ['impresiones', 'Impresiones'], ['likes', 'Me gusta'], ['comentarios', 'Comentarios'], ['guardados', 'Guardados'], ['compartidos', 'Compartidos'], ['clics', 'Clics'], ['seguidores', 'Seguidores nuevos']];
    const m = document.createElement('div'); m.id = 'ct-mini'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="fin-pi-box ct-mbox"><div class="fin-pi-box__hd"><h3>Resultados · ${_e(p.titulo)}</h3><button class="fin-pi-x" onclick="document.getElementById('ct-mini').remove()">✕</button></div><div class="flt-body ct-form"><div class="ct-row3">${campos.map(([k, l]) => `<label class="ct-lbl">${l}<input id="ct-r-${k}" type="number" min="0" class="ct-in" value="${_e(r[k] || '')}"></label>`).join('')}</div><label class="ct-lbl">Nota<textarea id="ct-r-nota" class="ct-ta" rows="2" placeholder="Qué aprendimos de esta pieza">${_e(r.nota || '')}</textarea></label></div>
      <div class="fin-pi-box__ft"><span></span><div class="fin-pi-ft-btns"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('ct-mini').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="ContenidoModule.guardarRes(${id})">Guardar</button></div></div></div>`;
    document.body.appendChild(m);
  }
  async function guardarRes(id) {
    const body = {}; ['alcance', 'impresiones', 'likes', 'comentarios', 'guardados', 'compartidos', 'clics', 'seguidores'].forEach(k => { body[k] = (document.getElementById('ct-r-' + k) || {}).value || 0; }); body.nota = (document.getElementById('ct-r-nota') || {}).value || '';
    try { const r = await _post('/content/pieces/' + id + '/resultados', body, 'PUT'); const p = _D.pieces.find(x => x.id === id); if (p) Object.assign(p, r); document.getElementById('ct-mini').remove(); _pintar(); _toast('Resultados guardados'); } catch (e) { _toast(e.message, 'error'); }
  }

  // ══ INFORMES ══
  function _vInformes() {
    const hoy = new Date(); if (!_inf.mes) _inf.mes = hoy.getFullYear() + '-' + _pad(hoy.getMonth() + 1);
    return `<div class="ct-panel" style="max-width:640px"><h4>Informe mensual para el cliente</h4><div class="ct-row3"><label class="ct-lbl" style="grid-column:span 2">Cliente<select class="ct-in" onchange="ContenidoModule.infFiltro('client',this.value)"><option value="">Elige un cliente</option>${_clienteOpts(_inf.client)}</select></label><label class="ct-lbl">Mes<input type="month" class="ct-in" value="${_e(_inf.mes)}" onchange="ContenidoModule.infFiltro('mes',this.value)"></label></div>
      <p class="ct-hint">El informe resume lo publicado en el mes, sus resultados por red y las mejores piezas, y adelanta lo planificado para el mes siguiente. Se abre listo para imprimir o guardar como PDF.</p>
      <div class="ct-actions"><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.generarInforme()">Generar informe</button></div></div>`;
  }
  function infFiltro(k, v) { _inf[k] = v; }
  function generarInforme() {
    if (!_inf.client) { _toast('Elige un cliente', 'error'); return; }
    const cid = +_inf.client, [y, mo] = _inf.mes.split('-').map(Number), ini = _inf.mes + '-01', finD = new Date(y, mo, 0), fin = _iso(finD), sig = new Date(y, mo, 1), sigK = sig.getFullYear() + '-' + _pad(sig.getMonth() + 1);
    const pub = (_D.pieces || []).filter(p => p.client_id === cid && p.estado === 'publicado' && _d10(p.published_at || p.fecha_plan) >= ini && _d10(p.published_at || p.fecha_plan) <= fin);
    const prox = (_D.pieces || []).filter(p => p.client_id === cid && p.estado !== 'publicado' && p.fecha_plan && _d10(p.fecha_plan).startsWith(sigK)).sort((a, b) => _d10(a.fecha_plan).localeCompare(_d10(b.fecha_plan)));
    const t = _suma(pub), nombre = _cliName(cid), top = pub.slice().sort((a, b) => _inter(b.resultados || {}) - _inter(a.resultados || {})).filter(p => _inter(p.resultados || {}) > 0).slice(0, 3);
    const porRed = {}; pub.forEach(p => (p.redes || []).forEach(r => { const o = porRed[r] = porRed[r] || { n: 0, a: 0, i: 0 }; o.n++; const x = p.resultados || {}; o.a += x.alcance || 0; o.i += _inter(x); }));
    const css = 'body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#14211B;max-width:820px;margin:0 auto;padding:36px 28px}h1{font-size:26px;margin:0 0 2px}h2{font-size:15px;margin:28px 0 8px;border-bottom:2px solid #00804C;padding-bottom:4px;text-transform:uppercase;letter-spacing:.05em}.s{color:#6B7770;margin:0 0 18px}.k{display:flex;gap:10px;flex-wrap:wrap}.k div{flex:1;min-width:130px;border:1px solid #E3E8E5;border-radius:8px;padding:12px}.k b{display:block;font-size:22px}.k span{color:#6B7770;font-size:12px}table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid #EEF1EF;text-align:left;font-size:13px}th{color:#6B7770;font-size:11px;text-transform:uppercase}.b{margin-top:22px}@media print{.np{display:none}body{padding:0}}';
    const w = window.open('', '_blank'); if (!w) { _toast('El navegador bloqueó la ventana del informe: permítela e inténtalo de nuevo', 'error'); return; }
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de contenido · ${_e(nombre)} · ${_e(MESES[mo - 1])} ${y}</title><style>${css}</style></head><body>
      <button class="np" onclick="print()" style="float:right;padding:8px 14px;border:0;border-radius:6px;background:#00804C;color:#fff;cursor:pointer">Imprimir / Guardar PDF</button>
      <h1>Informe de contenido</h1><p class="s">${_e(nombre)} · ${_e(MESES[mo - 1])} ${y}</p>
      <h2>Resumen del mes</h2><div class="k"><div><b>${t.n}</b><span>Piezas publicadas</span></div><div><b>${_n(t.alcance)}</b><span>Alcance</span></div><div><b>${_n(t.interacciones)}</b><span>Interacciones</span></div><div><b>${t.tasa ? t.tasa.toFixed(1) + '%' : '—'}</b><span>Tasa de interacción</span></div></div>
      <h2>Por red</h2>${Object.keys(porRed).length ? `<table><tr><th>Red</th><th>Piezas</th><th>Alcance</th><th>Interacciones</th></tr>${Object.entries(porRed).map(([r, o]) => `<tr><td>${_e(_lbl(REDES, r))}</td><td>${o.n}</td><td>${_n(o.a)}</td><td>${_n(o.i)}</td></tr>`).join('')}</table>` : '<p class="s">No hubo publicaciones este mes.</p>'}
      ${top.length ? `<h2>Mejores publicaciones</h2><table>${top.map(p => `<tr><td><b>${_e(p.titulo)}</b><br><span class="s">${_e(_lbl(FORMATOS, p.formato))} · ${(p.redes || []).map(r => _e(_lbl(REDES, r))).join(', ')}</span></td><td>${_n(_inter(p.resultados || {}))} interacciones</td></tr>`).join('')}</table>` : ''}
      <h2>Todo lo publicado</h2>${pub.length ? `<table><tr><th>Fecha</th><th>Pieza</th><th>Redes</th><th>Alcance</th></tr>${pub.sort((a, b) => _d10(a.published_at || a.fecha_plan).localeCompare(_d10(b.published_at || b.fecha_plan))).map(p => `<tr><td>${_fecha(p.published_at || p.fecha_plan)}</td><td>${_e(p.titulo)}</td><td>${(p.redes || []).map(r => _e(_lbl(REDES, r))).join(', ')}</td><td>${(p.resultados || {}).alcance ? _n(p.resultados.alcance) : '—'}</td></tr>`).join('')}</table>` : '<p class="s">Sin publicaciones.</p>'}
      <h2>Planificado para ${_e(MESES[sig.getMonth()])}</h2>${prox.length ? `<table>${prox.map(p => `<tr><td>${_fecha(p.fecha_plan)}</td><td>${_e(p.titulo)}</td><td>${(p.redes || []).map(r => _e(_lbl(REDES, r))).join(', ')}</td></tr>`).join('')}</table>` : '<p class="s">Aún no hay piezas planificadas.</p>'}
      </body></html>`);
    w.document.close();
  }

  // ══ CLIENTES Y PILARES ══
  function _vClientes() {
    const cl = _D.clients || [];
    if (!cl.length) return '<div class="ct-empty">Todavía no tienes clientes. Créalos en Operaciones → Clientes y aparecerán aquí.</div>';
    return `<div class="ct-clients">${cl.map(c => {
      const ac = (_D.accounts || []).filter(a => a.client_id === c.id), pi = (_D.pillars || []).filter(p => p.client_id === c.id), n = (_D.pieces || []).filter(p => p.client_id === c.id);
      const redOpts = REDES.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('');
      return `<article class="ct-cl"><header><span class="ct-chip" style="--h:${_hue(c.empresa || c.nombre)}">${_e(c.empresa || c.nombre)}</span><small>${n.length} piezas · ${n.filter(p => p.estado === 'publicado').length} publicadas</small></header>
        <h5>Cuentas</h5><div class="ct-tags">${ac.map(a => `<span class="ct-tag">${_e(_lbl(REDES, a.red))}${a.handle ? ' · ' + _e(a.handle) : ''}<button type="button" onclick="ContenidoModule.borrarCuenta(${a.id})" aria-label="Quitar">×</button></span>`).join('') || '<em>Sin cuentas</em>'}</div>
        <div class="ct-add"><select id="ct-ar-${c.id}" class="ct-sel">${redOpts}</select><input id="ct-ah-${c.id}" class="ct-search" placeholder="@usuario"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.addCuenta(${c.id})">Añadir</button></div>
        <h5>Pilares de contenido</h5><div class="ct-tags">${pi.map(p => `<span class="ct-tag"><i class="ct-pdot" style="background:${_e(p.color)}"></i>${_e(p.nombre)}<button type="button" onclick="ContenidoModule.borrarPilar(${p.id})" aria-label="Quitar">×</button></span>`).join('') || '<em>Sin pilares</em>'}</div>
        <div class="ct-add"><input id="ct-pn-${c.id}" class="ct-search" placeholder="Ej. Educativo, Producto, Testimonios…"><input id="ct-pc-${c.id}" type="color" class="ct-color" value="#00804C"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.addPilar(${c.id})">Añadir</button></div></article>`;
    }).join('')}</div>`;
  }

  // ── Render principal ──
  async function render(sec) {
    _sec = sec || _sec; const id = _sec === 'contenido' ? 'contenido-body' : _sec + '-body'; _host = document.getElementById(id); if (!_host) return;
    if (!_D) { _host.innerHTML = '<div class="ct-empty">Cargando…</div>'; try { await _load(); } catch (e) { _host.innerHTML = '<div class="ct-empty">No se pudo cargar: ' + _e(e.message) + '</div>'; return; } }
    _pintar();
  }
  function _pintar() {
    if (!_host || !_D) return;
    const [t, s] = SECC[_sec] || SECC.contenido;
    const vistas = { 'contenido-hoy': _vHoy, 'contenido-estrategia': _vEstrategia, 'contenido-ideas': _vIdeas, contenido: _vTablero, 'contenido-cal': _vCal, 'contenido-campanas': _vCampanas, 'contenido-biblioteca': _vBiblioteca, 'contenido-aprobaciones': _vAprobaciones, 'contenido-publicar': _vPublicar, 'contenido-analitica': _vAnalitica, 'contenido-informes': _vInformes, 'contenido-clientes': _vClientes };
    const sx = _host.querySelector('.ct-board') ? _host.querySelector('.ct-board').scrollLeft : 0, sy = _host.closest('.app-main') ? _host.closest('.app-main').scrollTop : 0;
    _host.innerHTML = `<div class="ct"><div class="ct-hd"><h2>${_e(t)}</h2><p>${_e(s)}</p></div>${(vistas[_sec] || _vTablero)()}</div>`;
    const b = _host.querySelector('.ct-board'); if (b) b.scrollLeft = sx; const am = _host.closest('.app-main'); if (am) am.scrollTop = sy;
  }
  function filtrar(k, v) { _f[k] = v; const was = k === 'q'; _pintar(); if (was) { const i = _host.querySelector('.ct-search'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } } }
  function mes(d) {
    const sem = _cal.modo === 'semana';
    if (d === 0) { const n = new Date(); _cal.y = n.getFullYear(); _cal.m = n.getMonth(); _cal.sel = _hoy(); const r = new Date(n); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); _cal.ref = _iso(r); }
    else if (sem) { const r = new Date(_cal.ref + 'T00:00:00'); r.setDate(r.getDate() + 7 * d); _cal.ref = _iso(r); }
    else { _cal.m += d; if (_cal.m < 0) { _cal.m = 11; _cal.y--; } if (_cal.m > 11) { _cal.m = 0; _cal.y++; } }
    _pintar();
  }
  function modo(m) { _cal.modo = m; _pintar(); }
  function dia(k) { _cal.sel = _cal.sel === k ? '' : k; _pintar(); }
  function irDia(k) { _cal.sel = k; const d = new Date(k + 'T00:00:00'); _cal.y = d.getFullYear(); _cal.m = d.getMonth(); if (typeof window._novaSwitchTab === 'function') window._novaSwitchTab('contenido-cal'); }

  // ── Acciones rápidas ──
  async function capturar() {
    const t = document.getElementById('ct-q-t'), c = document.getElementById('ct-q-c'); const titulo = (t.value || '').trim(); if (!titulo) { t.focus(); return; }
    try { const r = await _post('/content/pieces', { titulo, client_id: c.value || null, estado: 'idea' }); _D.pieces.unshift(r); _pintar(); const i = document.getElementById('ct-q-t'); if (i) i.focus(); } catch (e) { _toast(e.message, 'error'); }
  }
  async function mover(id, estado) {
    const p = _D.pieces.find(x => x.id === id); if (!p || p.estado === estado) return; const prev = p.estado; p.estado = estado; _pintar();
    try { const r = await _post('/content/pieces/' + id, { estado }, 'PATCH'); Object.assign(p, r); _pintar(); } catch (e) { p.estado = prev; _pintar(); _toast(e.message, 'error'); }
  }
  function dragStart(ev, id) { _drag = id; try { ev.dataTransfer.setData('text/plain', String(id)); ev.dataTransfer.effectAllowed = 'move'; } catch (_) {} }
  function soltar(ev, estado) { ev.preventDefault(); ev.currentTarget.classList.remove('is-over'); if (_drag) mover(_drag, estado); _drag = null; }
  async function soltarDia(ev, k) {
    ev.preventDefault(); const id = _drag; _drag = null; const p = _D.pieces.find(x => x.id === id); if (!p) return; const prev = p.fecha_plan; p.fecha_plan = k; _pintar();
    try { const r = await _post('/content/pieces/' + id, { fecha_plan: k }, 'PATCH'); Object.assign(p, r); _pintar(); } catch (e) { p.fecha_plan = prev; _pintar(); _toast(e.message, 'error'); }
  }
  async function addCuenta(cid) { const red = document.getElementById('ct-ar-' + cid).value, handle = document.getElementById('ct-ah-' + cid).value; try { _D.accounts.push(await _post('/content/accounts', { client_id: cid, red, handle })); _pintar(); } catch (e) { _toast(e.message, 'error'); } }
  async function borrarCuenta(id) { try { await _j('/content/accounts/' + id, { method: 'DELETE' }); _D.accounts = _D.accounts.filter(a => a.id !== id); _pintar(); } catch (e) { _toast(e.message, 'error'); } }
  async function addPilar(cid) { const nombre = document.getElementById('ct-pn-' + cid).value, color = document.getElementById('ct-pc-' + cid).value; if (!nombre.trim()) { document.getElementById('ct-pn-' + cid).focus(); return; } try { _D.pillars.push(await _post('/content/pillars', { client_id: cid, nombre, color })); _pintar(); } catch (e) { _toast(e.message, 'error'); } }
  async function borrarPilar(id) { if (!confirm('¿Quitar este pilar? Las piezas que lo usan se quedan sin pilar.')) return; try { await _j('/content/pillars/' + id, { method: 'DELETE' }); _D.pillars = _D.pillars.filter(p => p.id !== id); _D.pieces.forEach(p => { if (p.pilar_id === id) p.pilar_id = null; }); _pintar(); } catch (e) { _toast(e.message, 'error'); } }

  // ══ EDITOR DE LA PIEZA (con vista previa por red) ══
  const _vacia = () => ({ id: 0, titulo: '', client_id: _f.client ? +_f.client : null, estado: 'idea', formato: 'post', redes: [], pilar_id: null, responsable: '', fecha_plan: '', hora_plan: '', brief: '', copy: {}, notas: '', checklist: [], enlaces: [], media: [], campaign_id: null, primer_comentario: '', hashtags: '' });
  function nueva(fecha) { _p = _vacia(); if (fecha) { _p.fecha_plan = fecha; _p.estado = 'desarrollo'; } _comments = []; _modal(); }
  function nuevaPara(cid, red) { _p = _vacia(); _p.client_id = cid; _p.redes = [red]; _p.estado = 'desarrollo'; const st = (_D.strategies || {})[cid] || {}; _p.hashtags = st.hashtags || ''; _comments = []; _modal(); }
  function nuevaCamp(id) { const c = _camp(id); _p = _vacia(); _p.campaign_id = id; _p.client_id = c ? c.client_id : null; _p.estado = 'desarrollo'; _comments = []; _modal(); }
  async function abrir(id) {
    const p = _D.pieces.find(x => x.id === id); if (!p) return;
    _p = JSON.parse(JSON.stringify(p)); _p.fecha_plan = p.fecha_plan ? _d10(p.fecha_plan) : ''; _p.media = p.media || []; _comments = []; _modal();
    try { _comments = await _j('/content/pieces/' + id + '/comments'); const b = document.getElementById('ct-cm'); if (b) b.innerHTML = _comentariosHtml(); } catch (_) {}
  }
  function _comentariosHtml() { return (_comments.length ? _comments.map(c => `<div class="ct-cmt"><b>${_e(c.autor || 'Equipo')}</b> <small>${_e(new Date(c.created_at).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</small><div>${_e(c.texto)}</div></div>`).join('') : '<div class="ct-empty ct-empty--s">Sin comentarios.</div>'); }
  function _modal() {
    document.getElementById('ct-modal')?.remove(); _pvRed = '';
    const m = document.createElement('div'); m.id = 'ct-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) cerrar(); };
    m.innerHTML = `<div class="fin-pi-box ct-box"><div class="fin-pi-box__hd"><h3>${_p.id ? 'Pieza' : 'Nueva pieza'}</h3><button class="fin-pi-x" onclick="ContenidoModule.cerrar()">✕</button></div>
      <div class="ct-split"><div class="flt-body ct-form" id="ct-form"></div><aside class="ct-pvw" id="ct-pvw"></aside></div>
      <div class="fin-pi-box__ft"><span>${_p.id ? `<button type="button" class="btn btn--ghost btn--sm ct-del" onclick="ContenidoModule.borrar()">Eliminar</button> <button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.duplicar()">Duplicar</button> <button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.pedirAprob()">Pedir aprobación</button>` : ''}</span>
        <div class="fin-pi-ft-btns"><button class="btn btn--ghost btn--sm" onclick="ContenidoModule.cerrar()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="ContenidoModule.guardar()">Guardar</button></div></div></div>`;
    document.body.appendChild(m); recargar(); setTimeout(() => document.getElementById('ct-f-t')?.focus(), 30);
  }
  function _formHtml() {
    const p = _p, cli = (_D.clients || []).map(c => `<option value="${c.id}"${p.client_id === c.id ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join('');
    const pil = (_D.pillars || []).filter(x => !p.client_id || x.client_id === p.client_id).map(x => `<option value="${x.id}"${p.pilar_id === x.id ? ' selected' : ''}>${_e(x.nombre)}</option>`).join('');
    const cps = (_D.campaigns || []).filter(x => !p.client_id || x.client_id === p.client_id).map(x => `<option value="${x.id}"${p.campaign_id === x.id ? ' selected' : ''}>${_e(x.nombre)}</option>`).join('');
    const etapas = ETAPAS.map(([k, l]) => `<option value="${k}"${p.estado === k ? ' selected' : ''}>${l}</option>`).join('');
    const fmt = FORMATOS.map(([k, l]) => `<option value="${k}"${p.formato === k ? ' selected' : ''}>${l}</option>`).join('');
    const team = (_D.team || []).map(n => `<option${p.responsable === n ? ' selected' : ''}>${_e(n)}</option>`).join('');
    const redes = REDES.map(([k, l]) => `<button type="button" class="ct-pick${p.redes.includes(k) ? ' on' : ''}" onclick="ContenidoModule.red('${k}')">${l}</button>`).join('');
    const st = (_D.strategies || {})[p.client_id] || {};
    const copy = p.redes.length ? p.redes.map(k => { const v = p.copy[k] || '', lim = LIMITE[k]; return `<label class="ct-lbl">${_e(_lbl(REDES, k))} <small id="ct-cc-${k}" class="${lim && v.length > lim ? 'is-over' : ''}">${v.length}${lim ? ' / ' + lim : ''}</small><textarea class="ct-ta" rows="4" oninput="ContenidoModule.copia('${k}',this)" onfocus="ContenidoModule.pvRed('${k}')" placeholder="Texto para ${_e(_lbl(REDES, k))}…">${_e(v)}</textarea></label>`; }).join('') + (p.redes.length > 1 ? `<button type="button" class="btn btn--ghost btn--sm" style="align-self:flex-start" onclick="ContenidoModule.copiarATodas()">Usar el texto de ${_e(_lbl(REDES, p.redes[0]))} en todas las redes</button>` : '') : '<div class="ct-empty ct-empty--s">Elige las redes arriba para escribir el texto de cada una.</div>';
    const chk = p.checklist.map((i, n) => `<div class="ct-chk"><input type="checkbox" ${i.ok ? 'checked' : ''} onchange="ContenidoModule.chk(${n},this.checked)"><span class="${i.ok ? 'is-ok' : ''}">${_e(i.t)}</span><button type="button" onclick="ContenidoModule.chkDel(${n})" aria-label="Quitar">×</button></div>`).join('');
    const enl = p.enlaces.map((i, n) => `<div class="ct-chk"><a href="${_e(i.u)}" target="_blank" rel="noopener">${_e(i.t || i.u)}</a><button type="button" onclick="ContenidoModule.enlDel(${n})" aria-label="Quitar">×</button></div>`).join('');
    const adj = (p.media || []).map(_med).filter(Boolean).map(m => `<div class="ct-att">${_mediaThumb(m)}<button type="button" onclick="ContenidoModule.desadjuntar(${m.id})" aria-label="Quitar">×</button></div>`).join('');
    return `${st.tono || st.no_decir || st.si_decir ? `<div class="ct-guia"><b>Guía de ${_e(_cliName(p.client_id))}</b>${st.tono ? `<span>Tono: ${_e(st.tono)}</span>` : ''}${st.si_decir ? `<span>Decir: ${_e(st.si_decir)}</span>` : ''}${st.no_decir ? `<span class="is-no">Evitar: ${_e(st.no_decir)}</span>` : ''}</div>` : ''}
      <label class="ct-lbl">Título o idea<input id="ct-f-t" class="ct-in" value="${_e(p.titulo)}" oninput="ContenidoModule._s('titulo',this.value)" placeholder="Ej. 3 errores al elegir un colchón"></label>
      <div class="ct-row3"><label class="ct-lbl">Cliente<select class="ct-in" onchange="ContenidoModule._s('client_id',this.value?+this.value:null);ContenidoModule._s('pilar_id',null);ContenidoModule._s('campaign_id',null);ContenidoModule.recargar()"><option value="">Sin cliente</option>${cli}</select></label>
        <label class="ct-lbl">Etapa<select class="ct-in" onchange="ContenidoModule._s('estado',this.value)">${etapas}</select></label>
        <label class="ct-lbl">Formato<select class="ct-in" onchange="ContenidoModule._s('formato',this.value)">${fmt}</select></label></div>
      <div class="ct-lbl">Redes<div class="ct-picks">${redes}</div></div>
      <div class="ct-row3"><label class="ct-lbl">Pilar<select class="ct-in" onchange="ContenidoModule._s('pilar_id',this.value?+this.value:null)"><option value="">—</option>${pil}</select></label>
        <label class="ct-lbl">Campaña<select class="ct-in" onchange="ContenidoModule._s('campaign_id',this.value?+this.value:null)"><option value="">—</option>${cps}</select></label>
        <label class="ct-lbl">Responsable<select class="ct-in" onchange="ContenidoModule._s('responsable',this.value)"><option value="">—</option>${team}</select></label></div>
      <div class="ct-lbl ct-dt">Fecha y hora de publicación<div><input type="date" class="ct-in" value="${_e(p.fecha_plan)}" onchange="ContenidoModule._s('fecha_plan',this.value)"><input type="time" class="ct-in" value="${_e(p.hora_plan)}" onchange="ContenidoModule._s('hora_plan',this.value)"></div></div>
      <label class="ct-lbl">Brief: de qué trata, objetivo y enfoque<textarea class="ct-ta" rows="3" oninput="ContenidoModule._s('brief',this.value)" placeholder="Qué queremos lograr con esta pieza, a quién le habla, idea central…">${_e(p.brief)}</textarea></label>
      <div class="ct-sec">Texto por red</div><div id="ct-copy" class="ct-copyw">${copy}</div>
      <label class="ct-lbl">Hashtags ${st.hashtags ? `<button type="button" class="ct-lk" onclick="ContenidoModule.hashBase()">usar los del cliente</button>` : ''}<textarea class="ct-ta" rows="2" oninput="ContenidoModule._s('hashtags',this.value);ContenidoModule.pv()" placeholder="#marca #tema">${_e(p.hashtags)}</textarea></label>
      <label class="ct-lbl">Primer comentario (opcional)<textarea class="ct-ta" rows="2" oninput="ContenidoModule._s('primer_comentario',this.value)" placeholder="Texto que se pone como primer comentario de la publicación">${_e(p.primer_comentario)}</textarea></label>
      <div class="ct-sec">Archivos de la pieza</div><div class="ct-atts">${adj || '<span class="ct-hint">Sin archivos todavía.</span>'}</div>
      <div class="ct-add"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.elegirMedia()">Elegir de la biblioteca</button><label class="btn btn--ghost btn--sm" style="cursor:pointer">Subir nuevo<input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf" style="display:none" onchange="ContenidoModule.subirAqui(this.files)"></label></div>
      <div class="ct-sec">Pendientes</div><div id="ct-chk">${chk}</div><div class="ct-add"><input id="ct-chk-n" class="ct-in" placeholder="Ej. Grabar video, pedir logo…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.chkAdd()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.chkAdd()">Añadir</button><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.chkSugerida()">Lista sugerida</button></div>
      <div class="ct-sec">Otros archivos y enlaces (Drive, Canva, Figma…)</div><div id="ct-enl">${enl}</div><div class="ct-add"><input id="ct-enl-t" class="ct-in" placeholder="Nombre"><input id="ct-enl-u" class="ct-in" placeholder="https://…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.enlAdd()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.enlAdd()">Añadir</button></div>
      <label class="ct-lbl">Notas internas<textarea class="ct-ta" rows="2" oninput="ContenidoModule._s('notas',this.value)">${_e(p.notas)}</textarea></label>
      ${p.id ? `${p.aprob_estado === 'cambios' ? `<div class="ct-flag ct-flag--c">El cliente pidió cambios: ${_e(p.aprob_nota || '')}</div>` : ''}<label class="ct-lbl">Enlace de la publicación<input class="ct-in" value="${_e(p.link_publicado || '')}" oninput="ContenidoModule._s('link_publicado',this.value)" placeholder="https://…"></label>
      <div class="ct-sec">Comentarios</div><div id="ct-cm">${_comentariosHtml()}</div><div class="ct-add"><input id="ct-cm-n" class="ct-in" placeholder="Escribe un comentario…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.comentar()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.comentar()">Enviar</button></div>` : ''}`;
  }
  function _pvHtml() {
    const p = _p, red = _pvRed && p.redes.includes(_pvRed) ? _pvRed : (p.redes[0] || ''), cn = _cliName(p.client_id), st = (_D.strategies || {})[p.client_id] || {};
    const acc = (_D.accounts || []).find(a => a.client_id === p.client_id && a.red === red), handle = acc && acc.handle ? acc.handle : '@' + cn.toLowerCase().replace(/[^a-z0-9]/g, '');
    const meds = (p.media || []).map(_med).filter(Boolean), txt = ((p.copy || {})[red] || '').trim(), lim = LIMITE[red], largo = lim && txt.length > lim;
    const tabs = p.redes.length > 1 ? `<div class="ct-pvt">${p.redes.map(r => `<button type="button" class="${r === red ? 'on' : ''}" onclick="ContenidoModule.pvRed('${r}')">${_e(_lbl(REDES, r))}</button>`).join('')}</div>` : '';
    if (!red) return '<div class="ct-pvh">Vista previa</div><div class="ct-empty ct-empty--s">Elige una red para ver cómo se verá la publicación.</div>';
    const media = meds.length ? `<div class="ct-pvm ct-pvm--${Math.min(meds.length, 4)}">${meds.slice(0, 4).map(m => _mediaThumb(m)).join('')}${meds.length > 1 ? `<span class="ct-pvn">1/${meds.length}</span>` : ''}</div>` : '';
    return `<div class="ct-pvh">Vista previa</div>${tabs}<div class="ct-pv ct-pv--${_e(red)}"><div class="ct-pv__h"><span class="ct-pv__av" style="--h:${_hue(cn)}">${_e(_ini(cn))}</span><div><b>${_e(cn)}</b><small>${_e(handle)} · ${_e(_lbl(REDES, red))}</small></div></div>
      ${red === 'instagram' || red === 'tiktok' || red === 'pinterest' ? media : ''}<div class="ct-pv__t">${txt ? _e(txt).replace(/\n/g, '<br>') : '<span class="ct-pv__ph">El texto aparecerá aquí…</span>'}${p.hashtags ? `<div class="ct-pv__h2">${_e(p.hashtags)}</div>` : ''}${st.firma ? `<div class="ct-pv__f">${_e(st.firma)}</div>` : ''}</div>
      ${red !== 'instagram' && red !== 'tiktok' && red !== 'pinterest' ? media : ''}<div class="ct-pv__a"><span>Me gusta</span><span>Comentar</span><span>Compartir</span></div></div>
      ${largo ? `<div class="ct-flag ct-flag--c">El texto supera el límite de ${_e(_lbl(REDES, red))} (${txt.length} / ${lim}).</div>` : ''}${p.redes.length && !meds.length && ['instagram', 'tiktok', 'pinterest', 'youtube'].includes(red) ? '<div class="ct-flag">Esta red necesita imagen o video.</div>' : ''}`;
  }
  function pv() { const el = document.getElementById('ct-pvw'); if (el) el.innerHTML = _pvHtml(); }
  function pvRed(k) { _pvRed = k; pv(); }
  function _s(k, v) { _p[k] = v; if (['titulo', 'client_id'].includes(k)) pv(); }
  function recargar() { const f = document.getElementById('ct-form'); if (!f) return; const sy = f.scrollTop; f.innerHTML = _formHtml(); f.scrollTop = sy; pv(); }
  function red(k) { const i = _p.redes.indexOf(k); if (i >= 0) _p.redes.splice(i, 1); else _p.redes.push(k); recargar(); }
  function copia(k, el) { _p.copy[k] = el.value; _pvRed = k; const c = document.getElementById('ct-cc-' + k), lim = LIMITE[k]; if (c) { c.textContent = el.value.length + (lim ? ' / ' + lim : ''); c.classList.toggle('is-over', !!(lim && el.value.length > lim)); } pv(); }
  function copiarATodas() { const base = (_p.copy[_p.redes[0]] || ''); _p.redes.forEach(r => { _p.copy[r] = base; }); recargar(); }
  function hashBase() { const st = (_D.strategies || {})[_p.client_id] || {}; _p.hashtags = st.hashtags || ''; recargar(); }
  function chk(n, ok) { _p.checklist[n].ok = ok; recargar(); }
  function chkDel(n) { _p.checklist.splice(n, 1); recargar(); }
  function chkAdd() { const i = document.getElementById('ct-chk-n'); const t = (i.value || '').trim(); if (!t) return; _p.checklist.push({ t, ok: false }); recargar(); setTimeout(() => document.getElementById('ct-chk-n')?.focus(), 10); }
  function chkSugerida() { (LISTAS[_p.formato] || LISTAS.otro).forEach(t => { if (!_p.checklist.some(i => i.t === t)) _p.checklist.push({ t, ok: false }); }); recargar(); }
  function enlDel(n) { _p.enlaces.splice(n, 1); recargar(); }
  function enlAdd() { const u = (document.getElementById('ct-enl-u').value || '').trim(), t = (document.getElementById('ct-enl-t').value || '').trim(); if (!u) return; _p.enlaces.push({ t, u: /^https?:\/\//i.test(u) ? u : 'https://' + u }); recargar(); }
  function desadjuntar(id) { _p.media = (_p.media || []).filter(x => x !== id); recargar(); }
  async function subirAqui(files) { if (!_p.client_id) { _toast('Elige primero el cliente de la pieza', 'error'); return; } await subir(files, { client_id: _p.client_id, attach: true }); }
  function elegirMedia() {
    _pick = {}; document.getElementById('ct-mini')?.remove();
    const ms = (_D.media || []).filter(m => !_p.client_id || m.client_id === _p.client_id);
    const m = document.createElement('div'); m.id = 'ct-mini'; m.className = 'fin-pi-backdrop'; m.style.zIndex = 10050; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="fin-pi-box ct-mbox ct-mbox--w"><div class="fin-pi-box__hd"><h3>Elegir de la biblioteca</h3><button class="fin-pi-x" onclick="document.getElementById('ct-mini').remove()">✕</button></div><div class="flt-body"><div class="ct-media">${ms.map(x => `<div class="ct-m ct-m--pk${(_p.media || []).includes(x.id) ? ' on' : ''}" data-id="${x.id}" onclick="ContenidoModule.pickMedia(${x.id},this)">${_mediaThumb(x)}<div class="ct-m__i"><span>${_e(x.nombre)}</span></div></div>`).join('') || '<div class="ct-empty" style="grid-column:1/-1">No hay archivos de este cliente. Súbelos con «Subir nuevo».</div>'}</div></div><div class="fin-pi-box__ft"><span></span><div class="fin-pi-ft-btns"><button class="btn btn--primary btn--sm" onclick="ContenidoModule.pickOk()">Añadir a la pieza</button></div></div></div>`;
    document.body.appendChild(m); (_p.media || []).forEach(id => { _pick[id] = 1; });
  }
  function pickMedia(id, el) { if (_pick[id]) { delete _pick[id]; el.classList.remove('on'); } else { _pick[id] = 1; el.classList.add('on'); } }
  function pickOk() { _p.media = Object.keys(_pick).map(Number); document.getElementById('ct-mini').remove(); recargar(); }
  async function comentar() {
    const i = document.getElementById('ct-cm-n'); const texto = (i.value || '').trim(); if (!texto || !_p.id) return;
    try { _comments.push(await _post('/content/pieces/' + _p.id + '/comments', { texto })); i.value = ''; document.getElementById('ct-cm').innerHTML = _comentariosHtml(); const pz = _D.pieces.find(x => x.id === _p.id); if (pz) pz.n_comentarios = (pz.n_comentarios || 0) + 1; } catch (e) { _toast(e.message, 'error'); }
  }
  function cerrar() { document.getElementById('ct-modal')?.remove(); _p = null; }
  async function guardar() {
    if (!(_p.titulo || '').trim()) { _toast('Escribe un título o una idea', 'error'); document.getElementById('ct-f-t')?.focus(); return; }
    try {
      const r = _p.id ? await _post('/content/pieces/' + _p.id, _p, 'PUT') : await _post('/content/pieces', _p);
      const i = _D.pieces.findIndex(x => x.id === r.id); if (i >= 0) _D.pieces[i] = Object.assign(_D.pieces[i], r); else _D.pieces.unshift(r);
      cerrar(); _pintar(); _toast('Guardado');
    } catch (e) { _toast(e.message, 'error'); }
  }
  async function pedirAprob() {
    if (!_p || !_p.id) return; const id = _p.id, t = _p.titulo; await guardar(); if (_p) return;   // si no se pudo guardar, la ventana sigue abierta
    _ap.client = ''; await apCrear([id], t); _pintar();
  }
  async function borrar() {
    if (!_p || !_p.id || !confirm('¿Eliminar esta pieza? No se puede deshacer.')) return;
    try { await _j('/content/pieces/' + _p.id, { method: 'DELETE' }); _D.pieces = _D.pieces.filter(x => x.id !== _p.id); cerrar(); _pintar(); _toast('Pieza eliminada'); } catch (e) { _toast(e.message, 'error'); }
  }
  function duplicar() { if (!_p) return; const c = JSON.parse(JSON.stringify(_p)); c.id = 0; c.titulo = c.titulo + ' (copia)'; c.estado = 'desarrollo'; c.fecha_plan = ''; c.link_publicado = ''; c.aprob_estado = ''; c.checklist.forEach(i => { i.ok = false; }); _p = c; _comments = []; _modal(); }

  return { render, filtrar, mes, modo, dia, irDia, capturar, mover, dragStart, soltar, soltarDia, addCuenta, borrarCuenta, addPilar, borrarPilar, nueva, nuevaPara, nuevaCamp, abrir, cerrar, guardar, pedirAprob, borrar, duplicar, red, copia, copiarATodas, hashBase, chk, chkDel, chkAdd, chkSugerida, enlDel, enlAdd, comentar, recargar, pv, pvRed, _s,
    estrCliente, guardarEstrategia, campania, guardarCamp, borrarCamp, bibFiltro, subir, subirAqui, verMedia, borrarMedia, copiarTxt, desadjuntar, elegirMedia, pickMedia, pickOk, apCliente, apSel, apCrear, apRevocar, copiarPub, copiarPrimer, marcarPub, confirmarPub, anFiltro, anotar, guardarRes, infFiltro, generarInforme };
})();
