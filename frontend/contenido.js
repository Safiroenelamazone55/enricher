// Módulo Contenido: de la idea suelta a la pieza publicada. Tablero por etapas, banco de ideas, calendario y clientes/pilares.
const ContenidoModule = (() => {
  const ETAPAS = [['idea', 'Idea'], ['desarrollo', 'Desarrollo'], ['texto', 'Texto'], ['diseno', 'Diseño'], ['revision', 'Revisión interna'], ['aprobacion', 'Aprobación cliente'], ['programado', 'Programado'], ['publicado', 'Publicado']];
  const FORMATOS = [['post', 'Post'], ['carrusel', 'Carrusel'], ['reel', 'Reel'], ['story', 'Story'], ['video', 'Video'], ['articulo', 'Artículo'], ['hilo', 'Hilo'], ['otro', 'Otro']];
  const REDES = [['instagram', 'Instagram', 'IG'], ['tiktok', 'TikTok', 'TT'], ['linkedin', 'LinkedIn', 'in'], ['facebook', 'Facebook', 'FB'], ['x', 'X', 'X'], ['youtube', 'YouTube', 'YT'], ['pinterest', 'Pinterest', 'Pin'], ['threads', 'Threads', 'Th'], ['blog', 'Blog', 'Blog'], ['otra', 'Otra', '…']];
  const LIMITE = { x: 280, instagram: 2200, tiktok: 2200, linkedin: 3000, facebook: 63000, threads: 500, youtube: 5000, pinterest: 500 };
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  let _D = null, _host = null, _sec = 'contenido', _f = { client: '', resp: '', q: '' }, _cal = { y: 0, m: 0, sel: '' }, _p = null, _drag = null, _comments = [];
  const _e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const _api = () => (typeof API !== 'undefined' ? API : '/api');
  const _lbl = (arr, k) => (arr.find(x => x[0] === k) || [k, k])[1];
  const _iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const _hoy = () => _iso(new Date());
  const _fecha = s => { if (!s) return ''; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return d.getDate() + ' ' + MESES[d.getMonth()].slice(0, 3).toLowerCase(); };
  const _cli = id => (_D.clients || []).find(c => c.id === id);
  const _cliName = id => { const c = _cli(id); return c ? (c.empresa || c.nombre) : 'Sin cliente'; };
  const _pilar = id => (_D.pillars || []).find(p => p.id === id);
  const _ini = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const _hue = s => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  async function _j(url, opt) {
    const r = await apiFetch(_api() + url, opt);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Error ' + r.status));
    return d;
  }
  const _post = (url, body, method) => _j(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  function _toast(m, t) { if (typeof showBanner === 'function') showBanner(m, t || 'success'); }

  // ── Datos y filtros ──
  async function _load() { _D = await _j('/content/bootstrap'); }
  function _visibles(sinIdeas) {
    const q = _f.q.trim().toLowerCase();
    return (_D.pieces || []).filter(p => (!_f.client || String(p.client_id) === _f.client) && (!_f.resp || p.responsable === _f.resp)
      && (!q || (p.titulo + ' ' + p.brief + ' ' + _cliName(p.client_id)).toLowerCase().includes(q)) && (!sinIdeas || p.estado !== 'idea'));
  }
  const _atrasada = p => p.fecha_plan && String(p.fecha_plan).slice(0, 10) < _hoy() && !['publicado'].includes(p.estado);

  // ── Piezas de la interfaz ──
  function _redesHtml(p) { return (p.redes || []).map(r => `<span class="ct-net" title="${_e(_lbl(REDES, r))}">${_e((REDES.find(x => x[0] === r) || [0, 0, '·'])[2])}</span>`).join(''); }
  function _card(p) {
    const pil = _pilar(p.pilar_id), cl = _cliName(p.client_id), chk = p.checklist || [], done = chk.filter(i => i.ok).length;
    const i = ETAPAS.findIndex(e => e[0] === p.estado), nx = ETAPAS[i + 1];
    return `<div class="ct-card${_atrasada(p) ? ' is-late' : ''}" draggable="true" data-id="${p.id}" ondragstart="ContenidoModule.dragStart(event,${p.id})" onclick="ContenidoModule.abrir(${p.id})">
      ${pil ? `<span class="ct-card__pil" style="background:${_e(pil.color)}" title="${_e(pil.nombre)}"></span>` : ''}
      <div class="ct-card__t">${_e(p.titulo)}</div>
      <div class="ct-card__m"><span class="ct-chip" style="--h:${_hue(cl)}">${_e(cl)}</span><span class="ct-fmt">${_e(_lbl(FORMATOS, p.formato))}</span>${_redesHtml(p)}</div>
      <div class="ct-card__f">
        ${p.fecha_plan ? `<span class="ct-date${_atrasada(p) ? ' is-late' : ''}">${_fecha(p.fecha_plan)}${p.hora_plan ? ' · ' + _e(p.hora_plan) : ''}</span>` : '<span class="ct-date ct-date--no">Sin fecha</span>'}
        ${chk.length ? `<span class="ct-prog">${done}/${chk.length}</span>` : ''}
        ${p.n_comentarios ? `<span class="ct-prog" title="Comentarios">${p.n_comentarios} com.</span>` : ''}
        ${p.responsable ? `<span class="ct-av" title="${_e(p.responsable)}">${_e(_ini(p.responsable))}</span>` : ''}
        ${nx ? `<button type="button" class="ct-next" title="Pasar a «${_e(nx[1])}»" onclick="event.stopPropagation();ContenidoModule.mover(${p.id},'${nx[0]}')">›</button>` : ''}
      </div></div>`;
  }
  function _filtros(extra) {
    const clientes = (_D.clients || []).map(c => `<option value="${c.id}"${String(c.id) === _f.client ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join('');
    const resp = (_D.team || []).map(n => `<option${n === _f.resp ? ' selected' : ''}>${_e(n)}</option>`).join('');
    return `<div class="ct-bar">
      <input type="search" class="ct-search" placeholder="Buscar pieza o idea…" value="${_e(_f.q)}" oninput="ContenidoModule.filtrar('q',this.value)">
      <select class="ct-sel" onchange="ContenidoModule.filtrar('client',this.value)"><option value="">Todos los clientes</option>${clientes}</select>
      <select class="ct-sel" onchange="ContenidoModule.filtrar('resp',this.value)"><option value="">Todo el equipo</option>${resp}</select>
      ${extra || ''}</div>`;
  }
  function _stats() {
    const v = _visibles(), hoy = _hoy(), fin = _iso(new Date(Date.now() + 6 * 864e5));
    const sem = v.filter(p => p.fecha_plan && String(p.fecha_plan).slice(0, 10) >= hoy && String(p.fecha_plan).slice(0, 10) <= fin && p.estado !== 'publicado').length;
    const att = v.filter(_atrasada).length, apr = v.filter(p => p.estado === 'aprobacion').length, ideas = v.filter(p => p.estado === 'idea').length;
    return `<div class="ct-stats"><span><b>${ideas}</b> ideas</span><span><b>${sem}</b> esta semana</span><span class="${att ? 'is-late' : ''}"><b>${att}</b> atrasadas</span><span><b>${apr}</b> por aprobar</span></div>`;
  }

  // ── Vistas ──
  function _vTablero() {
    const v = _visibles();
    const cols = ETAPAS.map(([k, l]) => {
      const items = v.filter(p => p.estado === k);
      return `<section class="ct-col" data-estado="${k}" ondragover="event.preventDefault();this.classList.add('is-over')" ondragleave="this.classList.remove('is-over')" ondrop="ContenidoModule.soltar(event,'${k}')">
        <header class="ct-col__h"><span>${l}</span><i>${items.length}</i></header>
        <div class="ct-col__b">${items.map(_card).join('') || '<div class="ct-col__e">—</div>'}</div></section>`;
    }).join('');
    return `${_filtros('<button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.nueva()">＋ Nueva pieza</button>')}${_stats()}<div class="ct-board">${cols}</div>`;
  }
  function _vIdeas() {
    const ideas = _visibles().filter(p => p.estado === 'idea');
    const cli = (_D.clients || []).map(c => `<option value="${c.id}"${String(c.id) === _f.client ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join('');
    return `<div class="ct-quick"><input id="ct-q-t" class="ct-quick__t" placeholder="Escribe una idea y pulsa Enter…" onkeydown="if(event.key==='Enter')ContenidoModule.capturar()">
        <select id="ct-q-c" class="ct-sel"><option value="">Sin cliente</option>${cli}</select><button type="button" class="btn btn--primary btn--sm" onclick="ContenidoModule.capturar()">Guardar idea</button></div>
      ${_filtros()}
      <div class="ct-ideas">${ideas.length ? ideas.map(p => `<div class="ct-idea" onclick="ContenidoModule.abrir(${p.id})">
          <div class="ct-idea__t">${_e(p.titulo)}</div><div class="ct-idea__m"><span class="ct-chip" style="--h:${_hue(_cliName(p.client_id))}">${_e(_cliName(p.client_id))}</span><span class="ct-fmt">${_e(_lbl(FORMATOS, p.formato))}</span>${_redesHtml(p)}</div>
          <button type="button" class="btn btn--ghost btn--sm" onclick="event.stopPropagation();ContenidoModule.mover(${p.id},'desarrollo')">Desarrollar ›</button></div>`).join('')
        : '<div class="ct-empty">Aún no hay ideas. Anota la primera arriba: título corto y listo, la desarrollas después.</div>'}</div>`;
  }
  function _vCal() {
    const now = new Date(); if (!_cal.y) { _cal.y = now.getFullYear(); _cal.m = now.getMonth(); }
    const first = new Date(_cal.y, _cal.m, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const v = _visibles().filter(p => p.fecha_plan), byDay = {};
    v.forEach(p => { const k = String(p.fecha_plan).slice(0, 10); (byDay[k] = byDay[k] || []).push(p); });
    const hoy = _hoy(); let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const k = _iso(d), items = byDay[k] || [], fuera = d.getMonth() !== _cal.m;
      if (i >= 35 && fuera) break;
      cells += `<div class="ct-day${fuera ? ' is-out' : ''}${k === hoy ? ' is-today' : ''}${k === _cal.sel ? ' is-sel' : ''}" ondragover="event.preventDefault()" ondrop="ContenidoModule.soltarDia(event,'${k}')" onclick="ContenidoModule.dia('${k}')">
        <div class="ct-day__n"><span>${d.getDate()}</span><button type="button" class="ct-day__add" title="Nueva pieza este día" onclick="event.stopPropagation();ContenidoModule.nueva('${k}')">＋</button></div>
        ${items.slice(0, 3).map(p => { const pil = _pilar(p.pilar_id); return `<div class="ct-ev ct-ev--${_e(p.estado)}" draggable="true" ondragstart="ContenidoModule.dragStart(event,${p.id})" onclick="event.stopPropagation();ContenidoModule.abrir(${p.id})" style="${pil ? '--pc:' + _e(pil.color) : ''}">${_e(p.titulo)}</div>`; }).join('')}
        ${items.length > 3 ? `<div class="ct-more">+${items.length - 3} más</div>` : ''}
        ${items.length ? `<div class="ct-dots">${items.slice(0, 5).map(p => `<i class="ct-dot ct-dot--${_e(p.estado)}"></i>`).join('')}</div>` : ''}</div>`;
    }
    const sinFecha = _visibles().filter(p => !p.fecha_plan && p.estado !== 'idea' && p.estado !== 'publicado');
    const selList = _cal.sel ? (byDay[_cal.sel] || []) : [];
    return `${_filtros()}
      <div class="ct-calh"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(-1)">‹</button><b>${MESES[_cal.m]} ${_cal.y}</b><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(1)">›</button><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.mes(0)">Hoy</button></div>
      <div class="ct-cal"><div class="ct-wd">${DIAS.map(x => `<span>${x}</span>`).join('')}</div><div class="ct-grid">${cells}</div></div>
      ${_cal.sel ? `<div class="ct-agenda"><h4>${_fecha(_cal.sel)} <button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.nueva('${_cal.sel}')">＋ Nueva pieza</button></h4>${selList.map(_card).join('') || '<div class="ct-empty">Nada planificado este día.</div>'}</div>` : ''}
      ${sinFecha.length ? `<div class="ct-agenda"><h4>Sin fecha asignada (${sinFecha.length})</h4><div class="ct-wrapcards">${sinFecha.map(_card).join('')}</div></div>` : ''}`;
  }
  function _vClientes() {
    const cl = _D.clients || [];
    if (!cl.length) return '<div class="ct-empty">Todavía no tienes clientes. Créalos en Operaciones → Clientes y aparecerán aquí.</div>';
    return `<div class="ct-clients">${cl.map(c => {
      const ac = (_D.accounts || []).filter(a => a.client_id === c.id), pi = (_D.pillars || []).filter(p => p.client_id === c.id), n = (_D.pieces || []).filter(p => p.client_id === c.id);
      const redOpts = REDES.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('');
      return `<article class="ct-cl"><header><span class="ct-chip" style="--h:${_hue(c.empresa || c.nombre)}">${_e(c.empresa || c.nombre)}</span><small>${n.length} piezas · ${n.filter(p => p.estado === 'publicado').length} publicadas</small></header>
        <h5>Cuentas</h5><div class="ct-tags">${ac.map(a => `<span class="ct-tag">${_e(_lbl(REDES.map(r => [r[0], r[1]]), a.red))}${a.handle ? ' · ' + _e(a.handle) : ''}<button type="button" onclick="ContenidoModule.borrarCuenta(${a.id})" aria-label="Quitar">×</button></span>`).join('') || '<em>Sin cuentas</em>'}</div>
        <div class="ct-add"><select id="ct-ar-${c.id}" class="ct-sel">${redOpts}</select><input id="ct-ah-${c.id}" class="ct-search" placeholder="@usuario"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.addCuenta(${c.id})">Añadir</button></div>
        <h5>Pilares de contenido</h5><div class="ct-tags">${pi.map(p => `<span class="ct-tag" style="--pc:${_e(p.color)}"><i class="ct-pdot" style="background:${_e(p.color)}"></i>${_e(p.nombre)}<button type="button" onclick="ContenidoModule.borrarPilar(${p.id})" aria-label="Quitar">×</button></span>`).join('') || '<em>Sin pilares</em>'}</div>
        <div class="ct-add"><input id="ct-pn-${c.id}" class="ct-search" placeholder="Ej. Educativo, Producto, Testimonios…"><input id="ct-pc-${c.id}" type="color" class="ct-color" value="#00804C"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.addPilar(${c.id})">Añadir</button></div></article>`;
    }).join('')}</div>`;
  }

  // ── Render principal ──
  const TITULOS = { contenido: ['Tablero', 'Todas las piezas por etapa: arrastra una tarjeta (o pulsa ›) para avanzar.'], 'contenido-ideas': ['Banco de ideas', 'Anota todo lo que se te ocurra; después lo conviertes en pieza.'], 'contenido-cal': ['Calendario', 'Qué se publica cada día. Arrastra una pieza a otro día para moverla.'], 'contenido-clientes': ['Clientes y pilares', 'Las cuentas de cada cliente y sus líneas de contenido.'] };
  async function render(sec) {
    _sec = sec || _sec; const id = _sec === 'contenido' ? 'contenido-body' : _sec + '-body'; _host = document.getElementById(id); if (!_host) return;
    if (!_D) { _host.innerHTML = '<div class="ct-empty">Cargando…</div>'; try { await _load(); } catch (e) { _host.innerHTML = '<div class="ct-empty">No se pudo cargar: ' + _e(e.message) + '</div>'; return; } }
    _pintar();
  }
  function _pintar() {
    if (!_host || !_D) return;
    const [t, s] = TITULOS[_sec] || TITULOS.contenido;
    const body = _sec === 'contenido-ideas' ? _vIdeas() : _sec === 'contenido-cal' ? _vCal() : _sec === 'contenido-clientes' ? _vClientes() : _vTablero();
    const sy = _host.querySelector('.ct-board') ? _host.querySelector('.ct-board').scrollLeft : 0;
    _host.innerHTML = `<div class="ct"><div class="ct-hd"><h2>${_e(t)}</h2><p>${_e(s)}</p></div>${body}</div>`;
    const b = _host.querySelector('.ct-board'); if (b) b.scrollLeft = sy;
  }
  function filtrar(k, v) { _f[k] = v; const act = document.activeElement, was = act && act.classList.contains('ct-search') && k === 'q'; _pintar(); if (was) { const i = _host.querySelector('.ct-search'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } } }
  function mes(d) { if (d === 0) { const n = new Date(); _cal.y = n.getFullYear(); _cal.m = n.getMonth(); _cal.sel = _hoy(); } else { _cal.m += d; if (_cal.m < 0) { _cal.m = 11; _cal.y--; } if (_cal.m > 11) { _cal.m = 0; _cal.y++; } } _pintar(); }
  function dia(k) { _cal.sel = _cal.sel === k ? '' : k; _pintar(); }

  // ── Acciones rápidas ──
  async function capturar() {
    const t = document.getElementById('ct-q-t'), c = document.getElementById('ct-q-c'); const titulo = (t.value || '').trim(); if (!titulo) { t.focus(); return; }
    try { const r = await _post('/content/pieces', { titulo, client_id: c.value || null, estado: 'idea' }); _D.pieces.unshift(r); _pintar(); const i = document.getElementById('ct-q-t'); if (i) i.focus(); }
    catch (e) { _toast(e.message, 'error'); }
  }
  async function mover(id, estado) {
    const p = _D.pieces.find(x => x.id === id); if (!p || p.estado === estado) return; const prev = p.estado; p.estado = estado; _pintar();
    try { const r = await _post('/content/pieces/' + id, { estado }, 'PATCH'); Object.assign(p, r); _pintar(); }
    catch (e) { p.estado = prev; _pintar(); _toast(e.message, 'error'); }
  }
  function dragStart(ev, id) { _drag = id; try { ev.dataTransfer.setData('text/plain', String(id)); ev.dataTransfer.effectAllowed = 'move'; } catch (_) {} }
  function soltar(ev, estado) { ev.preventDefault(); ev.currentTarget.classList.remove('is-over'); if (_drag) mover(_drag, estado); _drag = null; }
  async function soltarDia(ev, k) {
    ev.preventDefault(); const id = _drag; _drag = null; const p = _D.pieces.find(x => x.id === id); if (!p) return; const prev = p.fecha_plan; p.fecha_plan = k; _pintar();
    try { const r = await _post('/content/pieces/' + id, { fecha_plan: k }, 'PATCH'); Object.assign(p, r); _pintar(); } catch (e) { p.fecha_plan = prev; _pintar(); _toast(e.message, 'error'); }
  }
  async function addCuenta(cid) {
    const red = document.getElementById('ct-ar-' + cid).value, handle = document.getElementById('ct-ah-' + cid).value;
    try { _D.accounts.push(await _post('/content/accounts', { client_id: cid, red, handle })); _pintar(); } catch (e) { _toast(e.message, 'error'); }
  }
  async function borrarCuenta(id) { try { await _j('/content/accounts/' + id, { method: 'DELETE' }); _D.accounts = _D.accounts.filter(a => a.id !== id); _pintar(); } catch (e) { _toast(e.message, 'error'); } }
  async function addPilar(cid) {
    const nombre = document.getElementById('ct-pn-' + cid).value, color = document.getElementById('ct-pc-' + cid).value;
    if (!nombre.trim()) { document.getElementById('ct-pn-' + cid).focus(); return; }
    try { _D.pillars.push(await _post('/content/pillars', { client_id: cid, nombre, color })); _pintar(); } catch (e) { _toast(e.message, 'error'); }
  }
  async function borrarPilar(id) { if (!confirm('¿Quitar este pilar? Las piezas que lo usan se quedan sin pilar.')) return; try { await _j('/content/pillars/' + id, { method: 'DELETE' }); _D.pillars = _D.pillars.filter(p => p.id !== id); _D.pieces.forEach(p => { if (p.pilar_id === id) p.pilar_id = null; }); _pintar(); } catch (e) { _toast(e.message, 'error'); } }

  // ── Ventana de la pieza ──
  function nueva(fecha) { _p = { id: 0, titulo: '', client_id: _f.client ? +_f.client : null, estado: fecha ? 'desarrollo' : 'idea', formato: 'post', redes: [], pilar_id: null, responsable: '', fecha_plan: fecha || '', hora_plan: '', brief: '', copy: {}, notas: '', checklist: [], enlaces: [] }; _comments = []; _modal(); }
  async function abrir(id) {
    const p = _D.pieces.find(x => x.id === id); if (!p) return;
    _p = JSON.parse(JSON.stringify(p)); _p.fecha_plan = p.fecha_plan ? String(p.fecha_plan).slice(0, 10) : ''; _comments = []; _modal();
    try { _comments = await _j('/content/pieces/' + id + '/comments'); const b = document.getElementById('ct-cm'); if (b) b.innerHTML = _comentariosHtml(); } catch (_) {}
  }
  function _comentariosHtml() { return (_comments.length ? _comments.map(c => `<div class="ct-cmt"><b>${_e(c.autor || 'Equipo')}</b> <small>${_e(new Date(c.created_at).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</small><div>${_e(c.texto)}</div></div>`).join('') : '<div class="ct-empty ct-empty--s">Sin comentarios.</div>'); }
  function _modal() {
    document.getElementById('ct-modal')?.remove();
    const p = _p, cli = (_D.clients || []).map(c => `<option value="${c.id}"${p.client_id === c.id ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join('');
    const pil = (_D.pillars || []).filter(x => !p.client_id || x.client_id === p.client_id).map(x => `<option value="${x.id}"${p.pilar_id === x.id ? ' selected' : ''}>${_e(x.nombre)}</option>`).join('');
    const m = document.createElement('div'); m.id = 'ct-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) cerrar(); };
    m.innerHTML = `<div class="fin-pi-box ct-box">
      <div class="fin-pi-box__hd"><h3>${p.id ? 'Pieza' : 'Nueva pieza'}</h3><button class="fin-pi-x" onclick="ContenidoModule.cerrar()">✕</button></div>
      <div class="flt-body ct-form" id="ct-form">${_formHtml(cli, pil)}</div>
      <div class="fin-pi-box__ft"><span>${p.id ? `<button type="button" class="btn btn--ghost btn--sm ct-del" onclick="ContenidoModule.borrar()">Eliminar</button> <button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.duplicar()">Duplicar</button>` : ''}</span>
        <div class="fin-pi-ft-btns"><button class="btn btn--ghost btn--sm" onclick="ContenidoModule.cerrar()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="ContenidoModule.guardar()">Guardar</button></div></div></div>`;
    document.body.appendChild(m); setTimeout(() => document.getElementById('ct-f-t')?.focus(), 30);
  }
  function _formHtml(cli, pil) {
    const p = _p;
    const etapas = ETAPAS.map(([k, l]) => `<option value="${k}"${p.estado === k ? ' selected' : ''}>${l}</option>`).join('');
    const fmt = FORMATOS.map(([k, l]) => `<option value="${k}"${p.formato === k ? ' selected' : ''}>${l}</option>`).join('');
    const team = (_D.team || []).map(n => `<option${p.responsable === n ? ' selected' : ''}>${_e(n)}</option>`).join('');
    const redes = REDES.map(([k, l]) => `<button type="button" class="ct-pick${p.redes.includes(k) ? ' on' : ''}" onclick="ContenidoModule.red('${k}')">${l}</button>`).join('');
    const copy = p.redes.length ? p.redes.map(k => { const v = p.copy[k] || '', lim = LIMITE[k]; return `<label class="ct-lbl">${_e(_lbl(REDES, k))} <small id="ct-cc-${k}" class="${lim && v.length > lim ? 'is-over' : ''}">${v.length}${lim ? ' / ' + lim : ''}</small><textarea class="ct-ta" rows="4" oninput="ContenidoModule.copia('${k}',this)" placeholder="Texto para ${_e(_lbl(REDES, k))}…">${_e(v)}</textarea></label>`; }).join('') : '<div class="ct-empty ct-empty--s">Elige las redes arriba para escribir el texto de cada una.</div>';
    const chk = p.checklist.map((i, n) => `<div class="ct-chk"><input type="checkbox" ${i.ok ? 'checked' : ''} onchange="ContenidoModule.chk(${n},this.checked)"><span class="${i.ok ? 'is-ok' : ''}">${_e(i.t)}</span><button type="button" onclick="ContenidoModule.chkDel(${n})" aria-label="Quitar">×</button></div>`).join('');
    const enl = p.enlaces.map((i, n) => `<div class="ct-chk"><a href="${_e(i.u)}" target="_blank" rel="noopener">${_e(i.t || i.u)}</a><button type="button" onclick="ContenidoModule.enlDel(${n})" aria-label="Quitar">×</button></div>`).join('');
    return `<label class="ct-lbl">Título o idea<input id="ct-f-t" class="ct-in" value="${_e(p.titulo)}" oninput="ContenidoModule._s('titulo',this.value)" placeholder="Ej. 3 errores al elegir un colchón"></label>
      <div class="ct-row3"><label class="ct-lbl">Cliente<select class="ct-in" onchange="ContenidoModule._s('client_id',this.value?+this.value:null);ContenidoModule._s('pilar_id',null);ContenidoModule.recargar()"><option value="">Sin cliente</option>${cli}</select></label>
        <label class="ct-lbl">Etapa<select class="ct-in" onchange="ContenidoModule._s('estado',this.value)">${etapas}</select></label>
        <label class="ct-lbl">Formato<select class="ct-in" onchange="ContenidoModule._s('formato',this.value)">${fmt}</select></label></div>
      <div class="ct-lbl">Redes<div class="ct-picks">${redes}</div></div>
      <div class="ct-row3"><label class="ct-lbl">Pilar<select class="ct-in" onchange="ContenidoModule._s('pilar_id',this.value?+this.value:null)"><option value="">—</option>${pil}</select></label>
        <label class="ct-lbl">Responsable<select class="ct-in" onchange="ContenidoModule._s('responsable',this.value)"><option value="">—</option>${team}</select></label>
        <div class="ct-lbl ct-dt">Fecha y hora<div><input type="date" class="ct-in" value="${_e(p.fecha_plan)}" onchange="ContenidoModule._s('fecha_plan',this.value)"><input type="time" class="ct-in" value="${_e(p.hora_plan)}" onchange="ContenidoModule._s('hora_plan',this.value)"></div></div></div>
      <label class="ct-lbl">Brief: de qué trata, objetivo y enfoque<textarea class="ct-ta" rows="3" oninput="ContenidoModule._s('brief',this.value)" placeholder="Qué queremos lograr con esta pieza, a quién le habla, idea central…">${_e(p.brief)}</textarea></label>
      <div class="ct-sec">Texto por red</div><div id="ct-copy">${copy}</div>
      <div class="ct-sec">Pendientes</div><div id="ct-chk">${chk}</div><div class="ct-add"><input id="ct-chk-n" class="ct-in" placeholder="Ej. Grabar video, pedir logo, revisar ortografía…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.chkAdd()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.chkAdd()">Añadir</button></div>
      <div class="ct-sec">Archivos y enlaces (Drive, Canva, Figma…)</div><div id="ct-enl">${enl}</div><div class="ct-add"><input id="ct-enl-t" class="ct-in" placeholder="Nombre"><input id="ct-enl-u" class="ct-in" placeholder="https://…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.enlAdd()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.enlAdd()">Añadir</button></div>
      <label class="ct-lbl">Notas internas<textarea class="ct-ta" rows="2" oninput="ContenidoModule._s('notas',this.value)">${_e(p.notas)}</textarea></label>
      ${p.id ? `<label class="ct-lbl">Enlace de la publicación<input class="ct-in" value="${_e(p.link_publicado || '')}" oninput="ContenidoModule._s('link_publicado',this.value)" placeholder="https://…"></label>
      <div class="ct-sec">Comentarios</div><div id="ct-cm">${_comentariosHtml()}</div><div class="ct-add"><input id="ct-cm-n" class="ct-in" placeholder="Escribe un comentario…" onkeydown="if(event.key==='Enter'){event.preventDefault();ContenidoModule.comentar()}"><button type="button" class="btn btn--ghost btn--sm" onclick="ContenidoModule.comentar()">Enviar</button></div>` : ''}`;
  }
  function _s(k, v) { _p[k] = v; }
  function recargar() { const f = document.getElementById('ct-form'); if (!f) return; const cli = (_D.clients || []).map(c => `<option value="${c.id}"${_p.client_id === c.id ? ' selected' : ''}>${_e(c.empresa || c.nombre)}</option>`).join(''); const pil = (_D.pillars || []).filter(x => !_p.client_id || x.client_id === _p.client_id).map(x => `<option value="${x.id}"${_p.pilar_id === x.id ? ' selected' : ''}>${_e(x.nombre)}</option>`).join(''); f.innerHTML = _formHtml(cli, pil); }
  function red(k) { const i = _p.redes.indexOf(k); if (i >= 0) _p.redes.splice(i, 1); else _p.redes.push(k); recargar(); }
  function copia(k, el) { _p.copy[k] = el.value; const c = document.getElementById('ct-cc-' + k), lim = LIMITE[k]; if (c) { c.textContent = el.value.length + (lim ? ' / ' + lim : ''); c.classList.toggle('is-over', !!(lim && el.value.length > lim)); } }
  function chk(n, ok) { _p.checklist[n].ok = ok; recargar(); }
  function chkDel(n) { _p.checklist.splice(n, 1); recargar(); }
  function chkAdd() { const i = document.getElementById('ct-chk-n'); const t = (i.value || '').trim(); if (!t) return; _p.checklist.push({ t, ok: false }); recargar(); setTimeout(() => document.getElementById('ct-chk-n')?.focus(), 10); }
  function enlDel(n) { _p.enlaces.splice(n, 1); recargar(); }
  function enlAdd() { const u = (document.getElementById('ct-enl-u').value || '').trim(), t = (document.getElementById('ct-enl-t').value || '').trim(); if (!u) return; _p.enlaces.push({ t, u: /^https?:\/\//i.test(u) ? u : 'https://' + u }); recargar(); }
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
  async function borrar() {
    if (!_p || !_p.id || !confirm('¿Eliminar esta pieza? No se puede deshacer.')) return;
    try { await _j('/content/pieces/' + _p.id, { method: 'DELETE' }); _D.pieces = _D.pieces.filter(x => x.id !== _p.id); cerrar(); _pintar(); _toast('Pieza eliminada'); } catch (e) { _toast(e.message, 'error'); }
  }
  function duplicar() { if (!_p) return; const c = JSON.parse(JSON.stringify(_p)); c.id = 0; c.titulo = c.titulo + ' (copia)'; c.estado = 'desarrollo'; c.fecha_plan = ''; c.link_publicado = ''; c.checklist.forEach(i => { i.ok = false; }); _p = c; _comments = []; _modal(); }

  return { render, filtrar, mes, dia, capturar, mover, dragStart, soltar, soltarDia, addCuenta, borrarCuenta, addPilar, borrarPilar, nueva, abrir, cerrar, guardar, borrar, duplicar, red, copia, chk, chkDel, chkAdd, enlDel, enlAdd, comentar, recargar, _s };
})();
