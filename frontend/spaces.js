// ═══════════════════════════════════════════════════════════════
// Espacios (Operaciones): árbol Espacio → Proyecto («lista») y vista de lista estilo ClickUp con agrupar, columnas, filtros y subtareas.
// Usa los mismos datos y el mismo menú/panel que Tareas (TasksModule), así que todo cambio se refleja en ambos sitios.
// ═══════════════════════════════════════════════════════════════
const SpacesModule = (() => {
  const LS = 'nova_spaces_ui';
  let _spaces = [], _projects = [], _tasks = [], _team = [], _loaded = false;
  let _selSpace = null, _selProj = null;             // null/null = Todas las tareas
  let _view = 'lista', _group = 'estado', _showClosed = false, _expandSubs = true, _q = '', _me = false, _fEstado = [], _fPrio = [], _fPers = [];
  let _cols = ['prioridad'];                           // columnas extra visibles (además de Nombre · Estado · Fecha límite · Persona)
  const _collapsedG = new Set(), _collapsedT = new Set(), _openSp = new Set(['p0']);
  let _pop = null, _popOff = null, _addingSpace = false;
  try { const u = JSON.parse(localStorage.getItem(LS) || '{}'); if (u.view) _view = u.view; if (u.group) _group = u.group; if (Array.isArray(u.cols)) _cols = u.cols; if (typeof u.expandSubs === 'boolean') _expandSubs = u.expandSubs; if (u.selProj) _selProj = u.selProj; if (u.selSpace != null) _selSpace = u.selSpace; } catch (_) {}
  const _save = () => { try { localStorage.setItem(LS, JSON.stringify({ view: _view, group: _group, cols: _cols, expandSubs: _expandSubs, selProj: _selProj, selSpace: _selSpace })); } catch (_) {} };
  const $q = id => document.getElementById(id);
  const _nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const _d10 = v => v ? String(v).split('T')[0] : '';
  const _today = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  const _fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : '';
  const _isOpen = t => t.estado !== 'completado' && t.estado !== 'cancelado';
  const _ESTADOS = [['pendiente', 'Pendiente', '#9A958C'], ['en_progreso', 'En curso', '#3F5BD0'], ['bloqueado', 'Bloqueado', '#D9534F'], ['completado', 'Completado', '#2E9E5B'], ['cancelado', 'Cancelado', '#B4AFA8']];
  const _EST = Object.fromEntries(_ESTADOS.map(e => [e[0], e]));
  const _PRIO = { alta: ['Alta', '#EF4444'], media: ['Media', '#F59E0B'], baja: ['Baja', '#10B981'] };
  const _resp = t => (t.responsables && t.responsables.length) ? t.responsables : (t.responsable ? [t.responsable] : []);
  const _ini = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const _meName = () => String(window._authUser?.memberNombre || window._authUser?.name || '').toLowerCase();

  // ── carga ──
  async function load() {
    const root = $q('spaces-root'); if (!root) return;
    if (!_loaded) root.innerHTML = '<div class="sp-load">Cargando espacios…</div>';
    try {
      const [sr, pr, tr, mr] = await Promise.all([apiFetch(`${API}/mgmt/spaces`), apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/tasks`), apiFetch(`${API}/mgmt/team`)]);
      _spaces = sr.ok ? await sr.json() : []; _projects = pr.ok ? await pr.json() : []; _tasks = tr.ok ? await tr.json() : []; _team = mr.ok ? await mr.json() : [];
    } catch (e) { console.error('[spaces] load', e); }
    _loaded = true;
    if (_selProj && !_projects.some(p => p.id === _selProj)) _selProj = null;
    render();
  }
  function _fromTasks(arr) { if (arr && arr !== _tasks) _tasks = arr; if ($q('spaces-root') && $q('pane-mgmt-spaces')?.classList.contains('active')) _paintMain(); }
  function _adopt() { try { TasksModule._adopt(_tasks); } catch (e) { console.error('[spaces] adopt', e); } }

  // ── estructura ──
  const _projsOf = sid => _projects.filter(p => (p.space_id || 0) === (sid || 0) && (p.estado || 'activo') !== 'cancelado');
  const _cnt = pid => _tasks.filter(t => t.project_id === pid && !t.archivada && !t.parent_task_id && _isOpen(t)).length;
  const _scope = () => {
    let ps = _selProj ? [_selProj] : (_selSpace != null ? _projsOf(_selSpace).map(p => p.id) : _projects.map(p => p.id));
    return _tasks.filter(t => !t.archivada && ps.includes(t.project_id));
  };
  const _title = () => { const p = _projects.find(x => x.id === _selProj); const sp = _selSpace != null ? (_selSpace === 0 ? { nombre: 'Principal' } : _spaces.find(s => s.id === _selSpace)) : null; return { sp, p }; };

  // ── esqueleto ──
  function render() {
    const root = $q('spaces-root'); if (!root) return;
    root.innerHTML = `<div class="spw"><aside class="sp-tree" id="sp-tree"></aside><section class="sp-main" id="sp-main"></section></div>`;
    _paintTree(); _paintMain();
  }
  function _paintTree() {
    const t = $q('sp-tree'); if (!t) return;
    const spRow = (id, nombre, color, open) => {
      const ps = _projsOf(id);
      return `<div class="sp-sp${_selSpace === id && !_selProj ? ' on' : ''}">
        <div class="sp-sp__h" onclick="SpacesModule.toggleSp(${id})"><span class="sp-sq" style="background:${color}">${_nrm(nombre).slice(0, 1).toUpperCase() || '?'}</span><span class="sp-sp__n">${esc(nombre)}</span>
          <button class="sp-ic" title="Agregar lista" onclick="event.stopPropagation();SpacesModule.spaceMenu(event,${id})">+</button>${id ? `<button class="sp-ic" title="Más" onclick="event.stopPropagation();SpacesModule.spaceOpts(event,${id})">⋯</button>` : ''}</div>
        ${open ? `<div class="sp-sp__b">${ps.map(p => `<button type="button" class="sp-pj${_selProj === p.id ? ' on' : ''}" onclick="SpacesModule.pick(${id},${p.id})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg><span>${esc(p.nombre)}</span><em>${_cnt(p.id) || ''}</em></button>`).join('') || '<div class="sp-e">Sin listas todavía</div>'}</div>` : ''}</div>`;
    };
    t.innerHTML = `<div class="sp-tree__h"><b>Espacios</b><button class="sp-add" title="Nuevo espacio" onclick="SpacesModule.newSpace()">+</button></div>
      <button type="button" class="sp-all${_selSpace == null && !_selProj ? ' on' : ''}" onclick="SpacesModule.pick(null,null)"><span class="sp-all__i">✱</span>Todas las tareas</button>
      ${spRow(0, 'Principal', '#7C5CE0', _openSp.has('p0'))}${_spaces.map(s => spRow(s.id, s.nombre, s.color, _openSp.has('p' + s.id))).join('')}
      ${_addingSpace ? `<div class="sp-newin"><input id="sp-new" placeholder="Nombre del espacio" onkeydown="if(event.key==='Enter')SpacesModule.saveSpace(this.value);if(event.key==='Escape')SpacesModule.cancelSpace()" onblur="SpacesModule.saveSpace(this.value)"></div>` : `<button type="button" class="sp-newsp" onclick="SpacesModule.newSpace()">+ Nuevo espacio</button>`}`;
    if (_addingSpace) setTimeout(() => $q('sp-new')?.focus(), 20);
  }
  function toggleSp(id) { const k = 'p' + id; if (_openSp.has(k)) _openSp.delete(k); else _openSp.add(k); _selSpace = id; _selProj = null; _save(); _paintTree(); _paintMain(); }
  function pick(sid, pid) { _selSpace = sid; _selProj = pid; if (sid != null) _openSp.add('p' + sid); _save(); _paintTree(); _paintMain(); }
  function newSpace() { _addingSpace = true; _paintTree(); }
  function cancelSpace() { _addingSpace = false; _paintTree(); }
  async function saveSpace(v) {
    v = String(v || '').trim(); if (!_addingSpace) return; _addingSpace = false;
    if (!v) { _paintTree(); return; }
    try { const colors = ['#7C5CE0', '#2F6BFF', '#E8920F', '#2E9E5B', '#D9534F', '#0891B2']; const r = await apiFetch(`${API}/mgmt/spaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: v, color: colors[_spaces.length % colors.length] }) }); if (!r.ok) throw new Error((await r.json()).error); const s = await r.json(); _spaces.push(s); _openSp.add('p' + s.id); _selSpace = s.id; _selProj = null; _save(); }
    catch (e) { showBanner('No se pudo crear el espacio: ' + e.message, 'error'); }
    _paintTree(); _paintMain();
  }
  // ── ventanitas ──
  function _closePop() { if (_pop) { _pop.remove(); _pop = null; } if (_popOff) { document.removeEventListener('mousedown', _popOff, true); _popOff = null; } }
  function _openPop(anchorEl, html, cls) {
    _closePop(); const p = document.createElement('div'); p.className = 'sp-pop ' + (cls || ''); p.innerHTML = html; document.body.appendChild(p); _pop = p;
    const r = anchorEl.getBoundingClientRect(); let left = r.left, top = r.bottom + 4;
    if (left + p.offsetWidth > innerWidth - 8) left = Math.max(8, r.right - p.offsetWidth);
    if (top + p.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - p.offsetHeight - 4);
    p.style.left = left + 'px'; p.style.top = top + 'px';
    _popOff = ev => { if (!p.contains(ev.target)) _closePop(); }; setTimeout(() => document.addEventListener('mousedown', _popOff, true), 0); return p;
  }
  function spaceMenu(ev, sid) {
    const others = _projects.filter(p => (p.space_id || 0) !== (sid || 0) && (p.estado || 'activo') !== 'cancelado');
    _openPop(ev.currentTarget, `<div class="sp-pop__h">Agregar lista a este espacio</div><button class="sp-pop__i" onclick="SpacesModule.newProject(${sid || 0})">＋ Crear proyecto nuevo en este espacio</button>${others.length ? '<div class="sp-pop__s">Mover un proyecto existente aquí</div><div class="sp-pop__l">' + others.map(p => `<button class="sp-pop__i" onclick="SpacesModule.moveProj(${p.id},${sid || 0})">${esc(p.nombre)}</button>`).join('') + '</div>' : ''}`);
  }
  function newProject(sid) { _closePop(); try { document.querySelector('[data-tab=mgmt-projects]')?.click(); setTimeout(() => ProjectsModule.openDrawer && ProjectsModule.openDrawer(null, null, sid || null), 300); } catch (_) {} }
  async function moveProj(pid, sid) {
    _closePop();
    try { const r = await apiFetch(`${API}/mgmt/projects/${pid}/space`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space_id: sid || null }) }); if (!r.ok) throw new Error('Error'); const p = _projects.find(x => x.id === pid); if (p) p.space_id = sid || null; _openSp.add('p' + sid); }
    catch (e) { showBanner('No se pudo mover el proyecto', 'error'); }
    _paintTree(); _paintMain();
  }
  function spaceOpts(ev, sid) { _openPop(ev.currentTarget, `<button class="sp-pop__i" onclick="SpacesModule.renameSpace(${sid})">Renombrar</button><button class="sp-pop__i sp-pop__i--del" onclick="SpacesModule.delSpace(${sid})">Eliminar espacio</button>`); }
  async function renameSpace(sid) { _closePop(); const s = _spaces.find(x => x.id === sid); const v = prompt('Nombre del espacio', s ? s.nombre : ''); if (!v || !v.trim()) return; try { const r = await apiFetch(`${API}/mgmt/spaces/${sid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: v }) }); if (r.ok) Object.assign(s, await r.json()); } catch (_) {} _paintTree(); _paintMain(); }
  async function delSpace(sid) {
    _closePop(); const s = _spaces.find(x => x.id === sid); if (!confirm(`¿Eliminar el espacio «${s ? s.nombre : ''}»? Sus proyectos NO se borran: pasan a «Principal».`)) return;
    try { await apiFetch(`${API}/mgmt/spaces/${sid}`, { method: 'DELETE' }); _spaces = _spaces.filter(x => x.id !== sid); _projects.forEach(p => { if (p.space_id === sid) p.space_id = null; }); if (_selSpace === sid) { _selSpace = null; _selProj = null; } _save(); } catch (_) { showBanner('No se pudo eliminar', 'error'); }
    _paintTree(); _paintMain();
  }

  // ── filtros / opciones ──
  const _passes = t => {
    if (_q && !_nrm([t.titulo, t.project_nombre, t.client_nombre].join(' ')).includes(_nrm(_q))) return false;
    if (_me && !_resp(t).some(r => r.toLowerCase() === _meName())) return false;
    if (_fEstado.length && !_fEstado.includes(t.estado || 'pendiente')) return false;
    if (_fPrio.length && !_fPrio.includes(t.prioridad || 'media')) return false;
    if (_fPers.length && !_resp(t).some(r => _fPers.includes(r))) return false;
    return true;
  };
  function setView(v) { _view = v; _save(); _paintMain(); }
  function setGroup(g) { _closePop(); _group = g; _save(); _paintMain(); }
  function toggleSubs() { _expandSubs = !_expandSubs; _save(); _paintMain(); }
  function toggleClosed() { _showClosed = !_showClosed; _paintMain(); }
  function toggleMe() { _me = !_me; _paintMain(); }
  function setQ(v) { _q = v; _paintBody(); }
  function groupMenu(ev) { _openPop(ev.currentTarget, `<div class="sp-pop__h">Agrupar por</div>${[['estado', 'Estado'], ['prioridad', 'Prioridad'], ['persona', 'Persona asignada'], ['fecha', 'Fecha límite'], ['ninguno', 'Ninguno']].map(([k, l]) => `<button class="sp-pop__i${_group === k ? ' on' : ''}" onclick="SpacesModule.setGroup('${k}')">${l}${_group === k ? ' ✓' : ''}</button>`).join('')}`); }
  function _chk(arr, v, fn) { return `<label class="sp-pop__o"><input type="checkbox" ${arr.includes(v[0]) ? 'checked' : ''} onchange="SpacesModule.${fn}('${esc(v[0]).replace(/'/g, '&#39;')}',this.checked)"><span>${esc(v[1])}</span></label>`; }
  function filterMenu(ev) {
    _openPop(ev.currentTarget, `<div class="sp-pop__h">Estado</div>${_ESTADOS.map(e => _chk(_fEstado, [e[0], e[1]], 'fEstado')).join('')}<div class="sp-pop__h">Prioridad</div>${Object.entries(_PRIO).map(([k, v]) => _chk(_fPrio, [k, v[0]], 'fPrio')).join('')}<button class="sp-pop__i sp-pop__i--del" onclick="SpacesModule.clearFilters()">Limpiar filtros</button>`, 'sp-pop--w');
  }
  function persMenu(ev) { _openPop(ev.currentTarget, `<div class="sp-pop__h">Persona asignada</div>${_team.filter(m => m.estado !== 'inactivo').map(m => _chk(_fPers, [m.nombre, m.nombre], 'fPers')).join('')}<button class="sp-pop__i sp-pop__i--del" onclick="SpacesModule.clearFilters()">Limpiar</button>`, 'sp-pop--w'); }
  const _tog = (arr, v, on) => on ? (arr.includes(v) ? arr : [...arr, v]) : arr.filter(x => x !== v);
  function fEstado(v, on) { _fEstado = _tog(_fEstado, v, on); _paintMain(); }
  function fPrio(v, on) { _fPrio = _tog(_fPrio, v, on); _paintMain(); }
  function fPers(v, on) { _fPers = _tog(_fPers, v, on); _paintMain(); }
  function clearFilters() { _fEstado = []; _fPrio = []; _fPers = []; _me = false; _q = ''; _closePop(); _paintMain(); }
  const _COLS = { prioridad: 'Prioridad', inicio: 'Fecha de inicio', estimado: 'Duración estimada', etiquetas: 'Etiquetas', horas: 'Horas trabajadas', proyecto: 'Lista' };
  function colsMenu(ev) { _openPop(ev.currentTarget, `<div class="sp-pop__h">Columnas</div>${Object.entries(_COLS).map(([k, l]) => `<label class="sp-pop__o"><input type="checkbox" ${_cols.includes(k) ? 'checked' : ''} onchange="SpacesModule.toggleCol('${k}',this.checked)"><span>${l}</span></label>`).join('')}<div class="sp-pop__h">Opciones</div><label class="sp-pop__o"><input type="checkbox" ${_expandSubs ? 'checked' : ''} onchange="SpacesModule.toggleSubs()"><span>Mostrar subtareas</span></label>`, 'sp-pop--w'); }
  function toggleCol(k, on) { _cols = on ? [...new Set([..._cols, k])] : _cols.filter(c => c !== k); _save(); _paintBody(); }

  // ── cabecera + barra ──
  function _paintMain() {
    const m = $q('sp-main'); if (!m) return;
    const { sp, p } = _title();
    const nF = _fEstado.length + _fPrio.length + (_q ? 1 : 0);
    const tabs = [['lista', 'Lista'], ['tablero', 'Tablero'], ['tabla', 'Tabla'], ['calendario', 'Calendario']];
    const ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const meOn = _me, persOn = _fPers.length;
    m.innerHTML = `<div class="sp-top"><div class="sp-crumb">${sp ? `<span class="sp-sq sp-sq--s" style="background:${sp.color || '#7C5CE0'}">${_nrm(sp.nombre).slice(0, 1).toUpperCase()}</span><span class="sp-crumb__a">${esc(sp.nombre)}</span><span class="sp-crumb__s">/</span>` : ''}<b>${p ? esc(p.nombre) : (sp ? 'Todas las listas' : 'Todas las tareas')}</b>${p && p.client_nombre ? `<span class="sp-crumb__c">${esc(p.client_nombre)}</span>` : ''}</div>
        ${p ? `<button type="button" class="sp-link" onclick="abrirVentanaProyecto(${p.id})">Abrir proyecto ›</button>` : ''}</div>
      <div class="sp-tabs">${tabs.map(([k, l]) => `<button type="button" class="sp-tab${_view === k ? ' on' : ''}" onclick="SpacesModule.setView('${k}')">${l}</button>`).join('')}<span class="sp-tab sp-tab--add" title="Más vistas próximamente">＋ Vista</span></div>
      <div class="sp-bar"><div class="sp-bar__l">
          <button type="button" class="sp-chip" onclick="SpacesModule.groupMenu(event)">${ico('<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>')} ${{ estado: 'Estado', prioridad: 'Prioridad', persona: 'Persona', fecha: 'Fecha límite', ninguno: 'Sin agrupar' }[_group]}</button>
          <button type="button" class="sp-chip${_expandSubs ? ' on' : ''}" onclick="SpacesModule.toggleSubs()">${ico('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v4a4 4 0 0 0 4 4h6"/>')} ${_expandSubs ? 'Expandidos' : 'Contraídos'}</button>
          <button type="button" class="sp-ibtn" title="Columnas" onclick="SpacesModule.colsMenu(event)">${ico('<rect x="3" y="4" width="18" height="16"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>')}</button></div>
        <div class="sp-bar__r">
          <button type="button" class="sp-ibtn${nF ? ' on' : ''}" title="Filtros" onclick="SpacesModule.filterMenu(event)">${ico('<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/>')}${nF ? `<i>${nF}</i>` : ''}</button>
          <button type="button" class="sp-ibtn${_showClosed ? ' on' : ''}" title="Mostrar tareas cerradas" onclick="SpacesModule.toggleClosed()">${ico('<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>')}</button>
          <button type="button" class="sp-ibtn${persOn ? ' on' : ''}" title="Persona asignada" onclick="SpacesModule.persMenu(event)">${ico('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M17 4a3.5 3.5 0 0 1 0 7"/>')}</button>
          <button type="button" class="sp-me${meOn ? ' on' : ''}" title="Sólo mis tareas" onclick="SpacesModule.toggleMe()">${esc(_ini(window._authUser?.memberNombre || window._authUser?.name || 'Yo'))}</button>
          <label class="sp-search">${ico('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>')}<input value="${esc(_q)}" placeholder="Buscar…" oninput="SpacesModule.setQ(this.value)"></label>
          <button type="button" class="btn btn--primary btn--sm sp-newt" onclick="SpacesModule.newTask()">＋ Tarea</button></div></div>
      <div class="sp-body" id="sp-body"></div>`;
    _paintBody();
  }
  function _paintBody() {
    const b = $q('sp-body'); if (!b) return;
    if (_view === 'calendario') { b.innerHTML = `<div class="sp-e sp-e--c">El calendario de un proyecto vive en su ventana de tareas.<br><button class="btn btn--primary btn--sm" onclick="${_selProj ? `abrirVentanaProyecto(${_selProj})` : `document.querySelector('[data-tab=mgmt-calendar]').click()`}">${_selProj ? 'Abrir calendario del proyecto' : 'Abrir calendario general'}</button></div>`; return; }
    let all = _scope().filter(_passes);
    if (!_showClosed) all = all.filter(t => _isOpen(t) || all.some(c => c.parent_task_id === t.id && _isOpen(c)));
    if (_view === 'tablero') { _paintBoard(b, all); return; }
    _paintList(b, all);
  }

  // ── lista ──
  function _groups(mains) {
    const g = _view === 'tabla' ? 'ninguno' : _group;
    if (g === 'ninguno') return [{ key: 'all', label: '', color: '', tasks: mains, flat: true }];
    if (g === 'estado') return _ESTADOS.filter(e => _showClosed || (e[0] !== 'completado' && e[0] !== 'cancelado')).map(e => ({ key: e[0], label: e[1], color: e[2], tasks: mains.filter(t => (t.estado || 'pendiente') === e[0]), est: e[0] }));
    if (g === 'prioridad') return Object.entries(_PRIO).map(([k, v]) => ({ key: k, label: v[0], color: v[1], tasks: mains.filter(t => (t.prioridad || 'media') === k) }));
    if (g === 'persona') { const names = [...new Set(mains.flatMap(t => _resp(t).length ? _resp(t) : ['Sin asignar']))].sort(); return names.map(n => ({ key: n, label: n, color: '#5B6BC0', tasks: mains.filter(t => (_resp(t).length ? _resp(t) : ['Sin asignar']).includes(n)) })); }
    const td = _today(), wk = new Date(); wk.setDate(wk.getDate() + 7); const wks = `${wk.getFullYear()}-${String(wk.getMonth() + 1).padStart(2, '0')}-${String(wk.getDate()).padStart(2, '0')}`; const dd = t => _d10(t.deadline);
    return [['v', 'Vencidas', '#D9534F', t => dd(t) && dd(t) < td], ['h', 'Hoy', '#3F5BD0', t => dd(t) === td], ['s', 'Próximos 7 días', '#E8920F', t => dd(t) > td && dd(t) <= wks], ['d', 'Más adelante', '#2E9E5B', t => dd(t) > wks], ['n', 'Sin fecha', '#9A958C', t => !dd(t)]].map(([k, l, c, f]) => ({ key: k, label: l, color: c, tasks: mains.filter(f) }));
  }
  function _statusRing(t) {
    const e = _EST[t.estado || 'pendiente'] || _EST.pendiente;
    if (t.estado === 'completado') return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${e[2]}"/><polyline points="7 12.5 10.5 16 17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (t.estado === 'en_progreso') return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="${e[2]}" stroke-width="2.4"/><circle cx="12" cy="12" r="4.2" fill="${e[2]}"/></svg>`;
    return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="${e[2]}" stroke-width="2.2" ${t.estado === 'pendiente' || !t.estado ? 'stroke-dasharray="3 3"' : ''}/></svg>`;
  }
  function _row(t, depth, kids, cols) {
    const e = _EST[t.estado || 'pendiente'] || _EST.pendiente, d = _d10(t.deadline), od = d && d < _today() && _isOpen(t), rs = _resp(t), open = !_collapsedT.has(t.id), p = _PRIO[t.prioridad || 'media'];
    const cell = {
      prioridad: `<div class="sp-c sp-c--m"><button class="sp-pr" onclick="SpacesModule.prio(event,${t.id})">${p ? `<i style="background:${p[1]}"></i>${p[0]}` : '—'}</button></div>`,
      inicio: `<div class="sp-c sp-c--m sp-dim">${_fmtD(_d10(t.fecha_inicio)) || '—'}</div>`,
      estimado: `<div class="sp-c sp-c--m sp-dim">${t.duracion_est_min ? _fmtEst(t.duracion_est_min) : '—'}</div>`,
      etiquetas: `<div class="sp-c sp-c--l">${(t.etiquetas || []).slice(0, 3).map(_tagChip).join('') || '<span class="sp-dim">—</span>'}</div>`,
      horas: `<div class="sp-c sp-c--m sp-dim">${(+t.horas_track || 0) ? (+t.horas_track) + 'h' : '—'}</div>`,
      proyecto: `<div class="sp-c sp-c--l sp-dim">${esc(t.project_nombre || '')}</div>`,
    };
    return `<div class="sp-r${depth ? ' sp-r--sub' : ''}" data-id="${t.id}" style="--d:${depth}">
      <div class="sp-c sp-c--n"><span class="sp-ind" style="width:${depth * 22}px"></span>${kids ? `<button class="sp-car" onclick="SpacesModule.toggleT(${t.id})">${open ? '▾' : '▸'}</button>` : '<span class="sp-car"></span>'}<button class="sp-ring" title="Cambiar estado" onclick="SpacesModule.estMenu(event,${t.id})">${_statusRing(t)}</button>
        <span class="sp-tt" onclick="openTaskAnywhere(${t.id})">${esc(t.titulo)}</span>${kids ? `<span class="sp-sb" title="${kids} subtarea(s)">⑂ ${kids}</span>` : ''}${(t.checklists || []).length ? '' : ''}</div>
      <div class="sp-c sp-c--e"><button class="sp-est" style="--c:${e[2]}" onclick="SpacesModule.estMenu(event,${t.id})">${esc(e[1]).toUpperCase()}</button></div>
      <div class="sp-c sp-c--d"><button class="sp-dt${od ? ' is-od' : ''}${d ? '' : ' is-empty'}" onclick="SpacesModule.date(event,${t.id})">${d ? _fmtD(d) : '＋'}</button></div>
      <div class="sp-c sp-c--p"><button class="sp-as" onclick="SpacesModule.resp(event,${t.id})">${rs.length ? rs.slice(0, 3).map(n => `<span class="sp-av" title="${esc(n)}">${esc(_ini(n))}</span>`).join('') : '<span class="sp-av sp-av--add">＋</span>'}</button></div>
      ${cols.map(c => cell[c]).join('')}<div class="sp-c sp-c--x"></div></div>`;
  }
  function _head(cols) { return `<div class="sp-r sp-r--h"><div class="sp-c sp-c--n">Nombre</div><div class="sp-c sp-c--e">Estado</div><div class="sp-c sp-c--d">Fecha límite</div><div class="sp-c sp-c--p">Persona asignada</div>${cols.map(c => `<div class="sp-c ${c === 'etiquetas' || c === 'proyecto' ? 'sp-c--l' : 'sp-c--m'}">${_COLS[c]}</div>`).join('')}<div class="sp-c sp-c--x"><button class="sp-plus" title="Columnas" onclick="SpacesModule.colsMenu(event)">＋</button></div></div>`; }
  function _tree(t, byParent, depth, cols, out) {
    const kids = (byParent.get(t.id) || []).filter(c => _showClosed || _isOpen(c));
    out.push(_row(t, depth, kids.length, cols));
    if (kids.length && _expandSubs && !_collapsedT.has(t.id)) kids.forEach(k => _tree(k, byParent, depth + 1, cols, out));
  }
  function _paintList(b, all) {
    const cols = _cols.filter(c => _COLS[c] && !(c === 'proyecto' && _selProj));
    const ids = new Set(all.map(t => t.id)), byParent = new Map();
    all.forEach(t => { if (t.parent_task_id && ids.has(t.parent_task_id)) { if (!byParent.has(t.parent_task_id)) byParent.set(t.parent_task_id, []); byParent.get(t.parent_task_id).push(t); } });
    const mains = all.filter(t => !(t.parent_task_id && ids.has(t.parent_task_id)));
    const sorter = (a, c) => (_d10(a.deadline) || '9999').localeCompare(_d10(c.deadline) || '9999') || a.id - c.id;
    if (!mains.length) { b.innerHTML = `<div class="sp-e sp-e--c">No hay tareas que mostrar aquí.${_selProj ? '<br><button class="btn btn--primary btn--sm" onclick="SpacesModule.newTask()">＋ Crear la primera tarea</button>' : ''}</div>`; return; }
    const gs = _groups(mains.slice().sort(sorter));
    b.innerHTML = `<div class="sp-scroll">` + gs.filter(g => g.tasks.length || g.est).map(g => {
      const open = !_collapsedG.has(g.key), rows = [];
      if (open) g.tasks.forEach(t => _tree(t, byParent, 0, cols, rows));
      return `<div class="sp-g">${g.flat ? '' : `<div class="sp-g__h"><button class="sp-car" onclick="SpacesModule.toggleG('${esc(g.key).replace(/'/g, '&#39;')}')">${open ? '▾' : '▸'}</button><span class="sp-gl" style="background:${g.color}">${esc(g.label)}</span><span class="sp-gn">${g.tasks.length}</span>${g.est ? `<button class="sp-gp" title="Agregar tarea" onclick="SpacesModule.newTask('${g.est}',this)">＋</button>` : ''}</div>`}
        ${open ? _head(cols) + rows.join('') + `<div class="sp-add-r"><button type="button" onclick="SpacesModule.newTask('${g.est || 'pendiente'}',this)">＋ Agregar Tarea</button></div>` : ''}</div>`;
    }).join('') + `</div>`;
  }
  function toggleG(k) { if (_collapsedG.has(k)) _collapsedG.delete(k); else _collapsedG.add(k); _paintBody(); }
  function toggleT(id) { if (_collapsedT.has(id)) _collapsedT.delete(id); else _collapsedT.add(id); _paintBody(); }

  // ── tablero ──
  function _paintBoard(b, all) {
    const mains = all.filter(t => !t.parent_task_id);
    const cols = _ESTADOS.filter(e => _showClosed || (e[0] !== 'completado' && e[0] !== 'cancelado'));
    b.innerHTML = `<div class="kanban-board sp-kb">${cols.map(([k, l, c]) => { const ts = mains.filter(t => (t.estado || 'pendiente') === k).sort((a, d) => (_d10(a.deadline) || '9999').localeCompare(_d10(d.deadline) || '9999')); return `<div class="kanban-col" ondragover="event.preventDefault();this.classList.add('is-over')" ondragleave="this.classList.remove('is-over')" ondrop="SpacesModule.drop(event,'${k}')"><div class="kanban-col__head"><div class="kanban-col__title"><span class="kanban-col__dot" style="background:${c}"></span>${l}<span class="kanban-count">${ts.length}</span></div><button class="kanban-col__add" title="Nueva tarea" onclick="SpacesModule.newTask('${k}',this)">+</button></div><div class="kanban-cards">${ts.map(_card).join('') || '<div class="kanban-empty">Sin tareas</div>'}</div></div>`; }).join('')}</div>`;
  }
  function _card(t) {
    const d = _d10(t.deadline), od = d && d < _today() && _isOpen(t), p = _PRIO[t.prioridad || 'media'], ctx = [t.project_nombre, t.client_nombre].filter(Boolean).join(' · ');
    return `<div class="kanban-card" draggable="true" onclick="openTaskAnywhere(${t.id})" ondragstart="event.dataTransfer.setData('text/plain','${t.id}');event.dataTransfer.effectAllowed='move'">
      <div class="kc-hdr"><span class="kc-title">${esc(t.titulo)}</span></div>${ctx ? `<div class="kc-meta"><span class="kc-project">${esc(ctx)}</span></div>` : ''}${typeof _taskBadgesHtml === 'function' ? _taskBadgesHtml(t) : ''}
      <div class="kc-foot"><span class="kc-prio kc-prio--${t.prioridad || 'media'}">${p ? p[0] : ''}</span>${d ? `<span class="kc-dl${od ? ' kc-dl--ov' : ''}">${_fmtD(d)}</span>` : ''}<div class="kc-who-wrap">${_resp(t).slice(0, 2).map(n => `<span class="kc-who" title="${esc(n)}">${esc(_ini(n))}</span>`).join('')}</div></div></div>`;
  }
  async function drop(ev, estado) { ev.preventDefault(); ev.currentTarget.classList.remove('is-over'); const id = parseInt(ev.dataTransfer.getData('text/plain'), 10); if (!id) return; _adopt(); try { await TasksModule.moveTaskToStatus(id, estado); } catch (_) {} _paintMain(); }

  // ── acciones por tarea (mismo menú y selectores que Tareas) ──
  function estMenu(ev, id) { ev.stopPropagation(); _openPop(ev.currentTarget, `<div class="sp-pop__h">Estado</div>${_ESTADOS.map(e => `<button class="sp-pop__i" onclick="SpacesModule.setEstado(${id},'${e[0]}')"><i class="sp-dot" style="background:${e[2]}"></i>${e[1]}</button>`).join('')}`); }
  async function setEstado(id, est) { _closePop(); _adopt(); try { await TasksModule.moveTaskToStatus(id, est); } catch (_) {} const t = _tasks.find(x => x.id === id); if (t) t.estado = est; _paintMain(); _paintTree(); }
  function prio(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcPrioPopover(ev, id); }
  function resp(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcRespPopover(ev, id); }
  function date(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcDatePopover(ev, id); }
  // «＋ Tarea» / «＋ Agregar Tarea»: ventanita con el nombre y (si hace falta) la lista donde va
  function newTask(estado, anchor) {
    const ps = (_selProj ? _projects.filter(p => p.id === _selProj) : (_selSpace != null ? _projsOf(_selSpace) : _projects).filter(p => (p.estado || 'activo') === 'activo'));
    if (!ps.length) { showBanner('Primero crea o elige una lista (proyecto) en este espacio', 'error'); return; }
    const a = anchor || document.querySelector('.sp-newt') || document.body;
    const p = _openPop(a, `<div class="sp-pop__h">Nueva tarea${estado && estado !== 'pendiente' ? ' · ' + (_EST[estado] || [0, ''])[1] : ''}</div>
      <input class="sp-pop__in" id="sp-nt" placeholder="Nombre de la tarea" autocomplete="off">
      ${ps.length > 1 ? `<select class="sp-pop__in" id="sp-np">${ps.map(x => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('')}</select>` : ''}
      <button class="btn btn--primary btn--sm sp-pop__go" id="sp-ngo">Crear tarea</button>`, 'sp-pop--w');
    const go = () => _createTask(($q('sp-nt').value || '').trim(), $q('sp-np') ? +$q('sp-np').value : ps[0].id, estado || 'pendiente');
    p.querySelector('#sp-ngo').onclick = go; p.querySelector('#sp-nt').onkeydown = e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') _closePop(); };
    setTimeout(() => $q('sp-nt') && $q('sp-nt').focus(), 20);
  }
  async function _createTask(titulo, pid, estado) {
    if (!titulo) { showBanner('Escribe el nombre de la tarea', 'error'); return; }
    _closePop();
    try {
      const r = await apiFetch(`${API}/mgmt/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo, project_id: pid, estado, responsables: window._authUser?.memberNombre ? [window._authUser.memberNombre] : [] }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      const t = await r.json(); const pj = _projects.find(x => x.id === pid); t.project_nombre = pj ? pj.nombre : ''; t.client_nombre = pj ? pj.client_nombre : ''; _tasks.unshift(t);
      showBanner('✓ Tarea creada', 'success');
    } catch (e) { showBanner('No se pudo crear la tarea: ' + e.message, 'error'); }
    _paintMain(); _paintTree();
  }

  return { load, render, _fromTasks, toggleSp, pick, newSpace, cancelSpace, saveSpace, spaceMenu, spaceOpts, newProject, moveProj, renameSpace, delSpace,
    setView, setGroup, toggleSubs, toggleClosed, toggleMe, setQ, groupMenu, filterMenu, persMenu, fEstado, fPrio, fPers, clearFilters, colsMenu, toggleCol,
    toggleG, toggleT, drop, estMenu, setEstado, prio, resp, date, newTask };
})();
