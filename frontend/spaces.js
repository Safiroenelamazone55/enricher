// ═══════════════════════════════════════════════════════════════
// Espacios (Operaciones): árbol Espacio → Proyecto («lista») y vista de lista estilo ClickUp con agrupar, columnas, filtros y subtareas.
// Usa los mismos datos y el mismo menú/panel que Tareas (TasksModule), así que todo cambio se refleja en ambos sitios.
// ═══════════════════════════════════════════════════════════════
const SpacesModule = (() => {
  const LS = 'nova_spaces_ui';
  let _spaces = [], _projects = [], _tasks = [], _team = [], _loaded = false, _views = [], _viewSel = {}, _calRef = null, _ganttScale = 'semana';
  let _selSpace = null, _selProj = null;             // null/null = Todas las tareas
  let _view = 'lista', _group = 'estado', _showClosed = true, _expandSubs = true, _q = '', _me = false, _fEstado = [], _fPrio = [], _fPers = [];
  let _cols = ['prioridad'];                           // columnas extra visibles (además de Nombre · Estado · Fecha límite · Persona)
  const _collapsedG = new Set(), _collapsedT = new Set(), _openSp = new Set(['p0']);
  let _pop = null, _popOff = null, _addingSpace = false;
  let _tq = '', _tqOpen = false, _showArch = false, _showAll = true;   // barra lateral: búsqueda, mostrar archivados, mostrar todos los espacios (incl. vacíos)
  try { const u = JSON.parse(localStorage.getItem('nova_sp_tree') || '{}'); _showArch = !!u.arch; _showAll = u.all !== false; } catch (_) {}
  const _saveT = () => { try { localStorage.setItem('nova_sp_tree', JSON.stringify({ arch: _showArch, all: _showAll })); } catch (_) {} };
  let _mode = 'tasks', _cfg = false, _pfE = '', _pfP = '', _pfC = '', _pq = '', _pMe = false;   // _mode: 'tasks' (vistas) o 'proyectos' (tabla de todos los proyectos); _cfg: pestaña Configuración del proyecto abierta
  try { const u = JSON.parse(localStorage.getItem(LS) || '{}'); if (u.view) _view = u.view; if (u.group) _group = u.group; if (Array.isArray(u.cols)) _cols = u.cols; if (typeof u.expandSubs === 'boolean') _expandSubs = u.expandSubs; if (u.selProj) _selProj = u.selProj; if (u.selSpace != null) _selSpace = u.selSpace; if (u.viewSel) _viewSel = u.viewSel; } catch (_) {}
  const _save = () => { try { localStorage.setItem(LS, JSON.stringify({ view: _view, group: _group, cols: _cols, expandSubs: _expandSubs, selProj: _selProj, selSpace: _selSpace, viewSel: _viewSel })); } catch (_) {} };
  const $q = id => document.getElementById(id);
  const _nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const _d10 = v => v ? String(v).split('T')[0] : '';
  const _today = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  const _fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : '';
  const _isOpen = t => t.estado !== 'completado' && t.estado !== 'cancelado';
  const _ESTADOS = [['pendiente', 'Pendiente', '#87909E'], ['en_progreso', 'En progreso', '#4194F6'], ['bloqueado', 'Bloqueado', '#F04F4F'], ['completado', 'Completado', '#6BC950'], ['cancelado', 'Cancelado', '#B0B5BD']];
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
      const [sr, pr, tr, mr, vr] = await Promise.all([apiFetch(`${API}/mgmt/spaces`), apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/tasks`), apiFetch(`${API}/mgmt/team`), apiFetch(`${API}/mgmt/space-views`)]);
      _views = vr.ok ? await vr.json() : [];
      _spaces = sr.ok ? await sr.json() : []; _projects = pr.ok ? await pr.json() : []; _tasks = tr.ok ? await tr.json() : []; _team = mr.ok ? await mr.json() : [];
    } catch (e) { console.error('[spaces] load', e); }
    _loaded = true;
    try { const pp = parseInt(new URLSearchParams(location.search).get('p'), 10); if (pp && !window.__spLinkDone) { window.__spLinkDone = true; const pj = _projects.find(x => x.id === pp); if (pj) { _selProj = pp; _selSpace = pj.space_id || 0; _openSp.add('p' + _selSpace); } } } catch (_) {}
    if (_selProj && !_projects.some(p => p.id === _selProj)) _selProj = null;
    else if (_selProj) { const sp0 = _projects.find(p => p.id === _selProj); if (sp0) { _selSpace = sp0.space_id || 0; _openSp.add('p' + _selSpace); } }
    render();
  }
  function _fromTasks(arr) { if (arr && arr !== _tasks) _tasks = arr; if ($q('spaces-root') && $q('pane-mgmt-spaces')?.classList.contains('active')) _paintMain(); }
  function _adopt() { try { if (!_tasks.length && TasksModule._getTasks) _tasks = TasksModule._getTasks(); TasksModule._adopt(_tasks); } catch (e) { console.error('[spaces] adopt', e); } }

  // ── estructura ──
  const _projsOf = sid => _projects.filter(p => (p.space_id || 0) === (sid || 0) && (p.estado || 'activo') !== 'cancelado' && !p.archivado);
  const _cnt = pid => _tasks.filter(t => t.project_id === pid && !t.archivada && !t.parent_task_id && _isOpen(t)).length;
  const _scope = () => {
    let ps = _selProj ? [_selProj] : (_selSpace != null ? _projsOf(_selSpace).map(p => p.id) : _projects.filter(p => !p.archivado).map(p => p.id));
    return _tasks.filter(t => !t.archivada && ps.includes(t.project_id));
  };
  const _title = () => { const p = _projects.find(x => x.id === _selProj); const sp = _selSpace != null ? (_selSpace === 0 ? { nombre: 'Principal' } : _spaces.find(s => s.id === _selSpace)) : null; return { sp, p }; };

  // ── esqueleto ──
  function render() {
    const root = $q('spaces-root'); if (!root) return;
    root.innerHTML = `<div class="spw"><aside class="sp-tree" id="sp-tree"></aside><section class="sp-main" id="sp-main"></section></div>`;
    _paintTree(); _paintMain();
  }
  const _treeProjs = sid => _projects.filter(p => (p.space_id || 0) === (sid || 0) && (p.estado || 'activo') !== 'cancelado' && (_showArch || !p.archivado));
  function _paintTree() {
    const t = $q('sp-tree'); if (!t) return;
    const q = _nrm(_tq.trim());
    const spRow = (id, nombre, color, openBase) => {
      let ps = _treeProjs(id); const nm = q && _nrm(nombre).includes(q);
      if (q && !nm) ps = ps.filter(p => _nrm(p.nombre).includes(q));
      if (q ? !(nm || ps.length) : (!_showAll && !ps.length && _selSpace !== id)) return '';
      const open = q ? true : openBase;
      return `<div class="sp-sp${_mode === 'tasks' && _selSpace === id && !_selProj ? ' on' : ''}">
        <div class="sp-sp__h" onclick="SpacesModule.toggleSp(${id})"><span class="sp-sq" style="background:${color}">${_nrm(nombre).slice(0, 1).toUpperCase() || '?'}</span><span class="sp-sp__n">${esc(nombre)}</span>
          <button class="sp-ic" title="Agregar lista" onclick="event.stopPropagation();SpacesModule.spaceMenu(event,${id})">+</button>${id ? `<button class="sp-ic" title="Más" onclick="event.stopPropagation();SpacesModule.spaceOpts(event,${id})">⋯</button>` : ''}</div>
        ${open ? `<div class="sp-sp__b">${ps.map(p => _pjRow(id, p)).join('') || '<div class="sp-e">Sin listas todavía</div>'}</div>` : ''}</div>`;
    };
    const rows = spRow(0, 'Principal', '#007AFF', _openSp.has('p0')) + _spaces.map(s => spRow(s.id, s.nombre, s.color, _openSp.has('p' + s.id))).join('');
    const head = _tqOpen
      ? `<div class="sp-tsearch">${_I('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}<input id="sp-tq" type="text" autocomplete="off" placeholder="Buscar en la barra lateral…" value="${esc(_tq)}" oninput="SpacesModule.treeQ(this.value)" onkeydown="if(event.key==='Escape')SpacesModule.treeSearch(false)"><button type="button" class="sp-tsearch__x" title="${_tq ? 'Borrar' : 'Cerrar'}" onclick="SpacesModule.treeClear()">✕</button></div>`
      : `<div class="sp-tree__h"><b>Espacios</b><span class="sp-hb"><button class="sp-add sp-add--g" title="Más opciones" onclick="SpacesModule.treeMenu(event)">⋯</button><button class="sp-add sp-add--g" title="Buscar en la barra lateral" onclick="SpacesModule.treeSearch(true)">${_I('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}</button><button class="sp-add" title="Nuevo espacio" onclick="SpacesModule.newSpace()">+</button></span></div>`;
    t.innerHTML = `${head}
      ${q ? '' : `<button type="button" class="sp-all${_mode === 'tasks' && _selSpace == null && !_selProj ? ' on' : ''}" onclick="SpacesModule.pick(null,null)"><span class="sp-all__i">✱</span>Todas las tareas</button>
      <button type="button" class="sp-all${_mode === 'proyectos' ? ' on' : ''}" onclick="SpacesModule.showProjectsGo()"><span class="sp-all__i">▤</span>Todos los proyectos</button>
      ${_favHtml()}`}
      ${rows || `<div class="sp-e">Sin resultados para «${esc(_tq)}»</div>`}
      ${q ? '' : (_addingSpace ? `<div class="sp-newin"><input id="sp-new" placeholder="Nombre del espacio" onkeydown="if(event.key==='Enter')SpacesModule.saveSpace(this.value);if(event.key==='Escape')SpacesModule.cancelSpace()" onblur="SpacesModule.saveSpace(this.value)"></div>` : `<button type="button" class="sp-newsp" onclick="SpacesModule.newSpace()">+ Nuevo espacio</button>`)}`;
    if (_addingSpace) setTimeout(() => $q('sp-new')?.focus(), 20);
    if (_tqOpen) { const i = $q('sp-tq'); if (i) { i.focus(); const n = i.value.length; try { i.setSelectionRange(n, n); } catch (_) {} } }
  }
  // buscar en la barra lateral + menú «···» (crear/administrar espacios, cerrar carpetas, mostrar todos/archivados)
  function treeSearch(on) { _tqOpen = on === undefined ? !_tqOpen : !!on; if (!_tqOpen) _tq = ''; _paintTree(); }
  function treeQ(v) { _tq = String(v || ''); _paintTree(); }
  function treeClear() { if (_tq) _tq = ''; else _tqOpen = false; _paintTree(); }
  function _tmHtml() {
    const it = (ic, l, k, sw) => `<button type="button" class="sp-pm__i" onclick="SpacesModule.treeAct('${k}')">${_I(ic)}<span>${l}</span>${sw === undefined ? '' : `<i class="sp-sw${sw ? ' on' : ''}"></i>`}</button>`;
    return it(_IC.plus, 'Crear espacio', 'new') + it('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>', 'Administrar espacios', 'mng') + '<div class="sp-pm__s"></div>'
      + it('<polyline points="18 15 12 9 6 15"/>', 'Cerrar todas las carpetas', 'fold') + '<div class="sp-pm__s"></div>'
      + it('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', 'Mostrar todos los espacios', 'all', _showAll)
      + it(_IC.arc, 'Mostrar archivados', 'arch', _showArch);
  }
  function treeMenu(ev) { _openPop(ev.currentTarget, _tmHtml(), 'sp-pm'); }
  function treeAct(k) {
    if (k === 'new') { _closePop(); newSpace(); }
    else if (k === 'mng') { _closePop(); mgOpen(); }
    else if (k === 'fold') { _closePop(); _openSp.clear(); _paintTree(); }
    else if (k === 'all' || k === 'arch') {
      if (k === 'all') _showAll = !_showAll; else _showArch = !_showArch; _saveT();
      if (!_showArch && _selProj && (_pjOf(_selProj) || {}).archivado) { _selProj = null; _paintMain(); }
      _paintTree(); const pop = document.querySelector('.sp-pm'); if (pop) pop.innerHTML = _tmHtml();
    }
  }
  function mgOpen() {
    const rows = [{ id: 0, nombre: 'Principal', color: '#007AFF' }, ..._spaces].map(s => { const n = _projects.filter(p => (p.space_id || 0) === s.id && !p.archivado && (p.estado || 'activo') !== 'cancelado').length;
      return `<div class="sp-mg__r"><span class="sp-sq" style="background:${s.color || '#007AFF'}">${_nrm(s.nombre).slice(0, 1).toUpperCase() || '?'}</span><b>${esc(s.nombre)}</b><em>${n} proyecto${n === 1 ? '' : 's'}</em>${s.id ? `<span class="sp-mg__b"><button type="button" class="btn btn--ghost btn--sm" onclick="SpacesModule.mgAct('ren',${s.id})">Renombrar</button><button type="button" class="btn btn--ghost btn--sm" onclick="SpacesModule.mgAct('share',${s.id})">Permisos</button><button type="button" class="btn btn--ghost btn--danger btn--sm" onclick="SpacesModule.mgAct('del',${s.id})">Eliminar</button></span>` : ''}</div>`; }).join('');
    _modal({ t: 'Administrar espacios', b: `<div class="sp-mg">${rows}</div><div class="sp-mg__f"><button type="button" class="btn btn--primary btn--sm" onclick="SpacesModule.mgAct('new')">+ Crear espacio</button></div>` }, 600);
  }
  async function mgAct(k, id) {
    if (k === 'ren') { await renameSpace(id); mgOpen(); }
    else if (k === 'del') { await delSpace(id); mgOpen(); }
    else if (k === 'share') { _close(); shareSpace(id); }
    else if (k === 'new') { _close(); newSpace(); }
  }
  // fila de un proyecto en el árbol (icono/color propios, contador y menú ⋯ al pasar el cursor)
  const _fav = () => { try { return JSON.parse(localStorage.getItem('nova_sp_fav') || '[]'); } catch (_) { return []; } };
  const _isFav = pid => _fav().includes(pid);
  function _pjRow(sid, p) {
    const ic = p.icono ? `<i class="sp-pj__e" style="${p.color ? 'background:' + p.color + '22' : ''}">${esc(p.icono)}</i>` : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${p.color || 'currentColor'}" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>`;
    return `<div class="sp-pjw"><button type="button" class="sp-pj${_selProj === p.id ? ' on' : ''}${p.archivado ? ' sp-pj--arch' : ''}" onclick="SpacesModule.pick(${sid},${p.id})">${ic}<span>${esc(p.nombre)}</span>${p.archivado ? '<b class="sp-pj__arch">Archivado</b>' : ''}${_isFav(p.id) ? '<b class="sp-pj__f">★</b>' : ''}<em>${_cnt(p.id) || ''}</em></button><button type="button" class="sp-pj__m" title="Opciones del proyecto" onclick="event.stopPropagation();SpacesModule.projMenu(event,${p.id})">⋯</button></div>`;
  }
  function _favHtml() {
    const fv = _fav().map(id => _projects.find(p => p.id === id)).filter(p => p && !p.archivado); if (!fv.length) return '';
    return `<div class="sp-favh">★ Favoritos</div>${fv.map(p => _pjRow(p.space_id || 0, p)).join('')}`;
  }
  function toggleSp(id) { const k = 'p' + id; if (_openSp.has(k)) _openSp.delete(k); else _openSp.add(k); _mode = 'tasks'; _cfg = false; _selSpace = id; _selProj = null; _save(); _paintTree(); _paintMain(); }
  function pick(sid, pid) { _mode = 'tasks'; _cfg = false; _selSpace = sid; _selProj = pid; if (sid != null) _openSp.add('p' + sid); _save(); _paintTree(); _paintMain(); }
  function newSpace() { _addingSpace = true; _paintTree(); }
  function cancelSpace() { _addingSpace = false; _paintTree(); }
  async function saveSpace(v) {
    v = String(v || '').trim(); if (!_addingSpace) return; _addingSpace = false;
    if (!v) { _paintTree(); return; }
    try { const colors = ['#007AFF', '#2F6BFF', '#E8920F', '#2E9E5B', '#D9534F', '#0891B2']; const r = await apiFetch(`${API}/mgmt/spaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: v, color: colors[_spaces.length % colors.length] }) }); if (!r.ok) throw new Error((await r.json()).error); const s = await r.json(); _spaces.push(s); _openSp.add('p' + s.id); _selSpace = s.id; _selProj = null; _save(); }
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
    _openPop(ev.currentTarget, `<div class="sp-pop__h">Agregar lista a este espacio</div><button class="sp-pop__i" onclick="SpacesModule.newProject(${sid || 0})">＋ Crear proyecto nuevo en este espacio</button><button class="sp-pop__i" onclick="SpacesModule.tplCreateOpen(${sid || 0})">＋ Crear proyecto desde plantilla</button>${others.length ? '<div class="sp-pop__s">Mover un proyecto existente aquí</div><div class="sp-pop__l">' + others.map(p => `<button class="sp-pop__i" onclick="SpacesModule.moveProj(${p.id},${sid || 0})">${esc(p.nombre)}</button>`).join('') + '</div>' : ''}`);
  }
  function newProject(sid) { _closePop(); try { ProjectsModule.openDrawer(null, null, sid || null); } catch (e) { console.error('[spaces] nuevo proyecto', e); showBanner('No se pudo abrir el formulario de proyecto', 'error'); } }
  async function moveProj(pid, sid) {
    _closePop();
    try { const r = await apiFetch(`${API}/mgmt/projects/${pid}/space`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space_id: sid || null }) }); if (!r.ok) throw new Error('Error'); const p = _projects.find(x => x.id === pid); if (p) p.space_id = sid || null; _openSp.add('p' + sid); }
    catch (e) { showBanner('No se pudo mover el proyecto', 'error'); }
    _paintTree(); _paintMain();
  }
  function spaceOpts(ev, sid) { _openPop(ev.currentTarget, `<button class="sp-pop__i" onclick="SpacesModule.renameSpace(${sid})">Renombrar</button><button class="sp-pop__i" onclick="SpacesModule.shareSpace(${sid})">Uso compartido y permisos</button><button class="sp-pop__i sp-pop__i--del" onclick="SpacesModule.delSpace(${sid})">Eliminar espacio</button>`); }
  async function renameSpace(sid) { _closePop(); const s = _spaces.find(x => x.id === sid); const v = prompt('Nombre del espacio', s ? s.nombre : ''); if (!v || !v.trim()) return; try { const r = await apiFetch(`${API}/mgmt/spaces/${sid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: v }) }); if (r.ok) Object.assign(s, await r.json()); } catch (_) {} _paintTree(); _paintMain(); }
  async function delSpace(sid) {
    _closePop(); const s = _spaces.find(x => x.id === sid); if (!confirm(`¿Eliminar el espacio «${s ? s.nombre : ''}»? Sus proyectos NO se borran: pasan a «Principal».`)) return;
    try { await apiFetch(`${API}/mgmt/spaces/${sid}`, { method: 'DELETE' }); _spaces = _spaces.filter(x => x.id !== sid); _projects.forEach(p => { if (p.space_id === sid) p.space_id = null; }); if (_selSpace === sid) { _selSpace = null; _selProj = null; } _save(); } catch (_) { showBanner('No se pudo eliminar', 'error'); }
    _paintTree(); _paintMain();
  }


  // ── Vistas del espacio (como ClickUp): cada espacio tiene sus propias vistas, con nombre, y se pueden añadir, renombrar y quitar ──
  const _ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const _VT = {
    lista:      ['Lista', 'Ve tareas, estados y personas', '#6B6760', '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'],
    tablero:    ['Tablero – Kanban', 'Mueve tareas entre columnas', '#4A55E0', '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/>'],
    tabla:      ['Tabla', 'Todas las tareas en filas y columnas', '#2E9E5B', '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'],
    calendario: ['Calendario', 'Planifica por fecha límite', '#F2762E', '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'],
    gantt:      ['Gantt', 'Planifica tiempos y duración', '#E5484D', '<line x1="4" y1="6" x2="14" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="16" y2="18"/>'],
    galeria:    ['Galería', 'Tarjetas de tareas', '#5B6BC0', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'],
    panel:      ['Panel', 'Métricas y estadísticas', '#B050D0', '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'],
    formulario: ['Formulario', 'Crea tareas desde un formulario', '#6C4CE0', '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'],
    documento:  ['Documento', 'Colabora y documenta lo que sea', '#2F6BFF', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>'],
    pizarra:    ['Pizarra', 'Visualiza y debate ideas', '#E8920F', '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'],
  };
  const _VT_SOON = [['Artifact', 'Crear con IA en esta ubicación']];
  const _VT_DEFAULT = ['lista', 'tablero', 'tabla', 'calendario'];
  // clave de las vistas: «p<id>» si hay un proyecto (lista) elegido; si no, «s<id>» del espacio (s-1 = Todas las tareas)
  const _sk = () => (_selProj ? 'p' + _selProj : 's' + (_selSpace == null ? -1 : _selSpace));
  const _isProjKey = k => String(k).startsWith('p');
  const _realViews = k => _views.filter(v => _isProjKey(k) ? v.project_id === +String(k).slice(1) : (!v.project_id && v.space_id === +String(k).slice(1)));
  function _viewsOf(k) {
    const own = _realViews(k).sort((a, b) => a.orden - b.orden || a.id - b.id);
    return own.length ? own : _VT_DEFAULT.map(t => ({ id: 'd:' + t, tipo: t, nombre: _VT[t][0], virtual: true }));
  }
  function _curView() { const vs = _viewsOf(_sk()), id = _viewSel[_sk()]; return vs.find(v => String(v.id) === String(id)) || vs[0]; }
  // las vistas por defecto (virtuales) se guardan de verdad la primera vez que se modifica algo
  async function _materialize(k) {
    if (_realViews(k).length) return;
    const defs = _VT_DEFAULT.map(t => ({ tipo: t, nombre: _VT[t][0] }));
    const r = await apiFetch(`${API}/mgmt/space-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space_id: _isProjKey(k) ? 0 : +String(k).slice(1), project_id: _isProjKey(k) ? +String(k).slice(1) : null, views: defs }) });
    if (!r.ok) throw new Error('No se pudieron guardar las vistas');
    const rows = await r.json(); _views.push(...rows);
    const cur = _viewSel[k]; if (String(cur || '').startsWith('d:')) { const m = rows.find(x => 'd:' + x.tipo === cur); if (m) _viewSel[k] = m.id; }
  }
  function selView(id) { _cfg = false; _viewSel[_sk()] = id; _closePop(); _save(); _paintMain(); }
  function viewMenu(ev) {
    _openPop(ev.currentTarget, `<div class="sp-pop__h">Popular</div><div class="sp-vgrid">${Object.keys(_VT).map(t => `<button type="button" class="sp-vopt" onclick="SpacesModule.addView('${t}')"><span class="sp-vopt__i" style="background:${_VT[t][2]}">${_ico(_VT[t][3])}</span><span><b>${_VT[t][0]}</b><em>${_VT[t][1]}</em></span></button>`).join('')}</div>
      <div class="sp-pop__h">Próximamente</div><div class="sp-vgrid">${_VT_SOON.map(([n, d]) => `<div class="sp-vopt sp-vopt--off"><span class="sp-vopt__i" style="background:#B4AFA8">${_ico('<circle cx="12" cy="12" r="9"/>')}</span><span><b>${n}</b><em>${d}</em></span></div>`).join('')}</div>`, 'sp-pop--vw');
  }
  async function addView(tipo) {
    _closePop();
    try {
      const k = _sk(); await _materialize(k);
      const r = await apiFetch(`${API}/mgmt/space-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space_id: _isProjKey(k) ? 0 : +String(k).slice(1), project_id: _isProjKey(k) ? +String(k).slice(1) : null, tipo, nombre: _VT[tipo][0] }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      const v = await r.json(); _views.push(v); _viewSel[k] = v.id; _save();
    } catch (e) { showBanner('No se pudo añadir la vista: ' + e.message, 'error'); }
    _paintMain();
  }
  function viewOpts(ev, id) { ev.stopPropagation(); _openPop(ev.currentTarget, `<button class="sp-pop__i" onclick="SpacesModule.renameView('${id}')">Renombrar</button><button class="sp-pop__i sp-pop__i--del" onclick="SpacesModule.delView('${id}')">Quitar vista</button>`); }
  async function renameView(id) {
    _closePop();
    try {
      const k = _sk(); const cur = _viewsOf(k).find(v => String(v.id) === String(id)); const nm = prompt('Nombre de la vista', cur ? cur.nombre : ''); if (!nm || !nm.trim()) return;
      await _materialize(k); const real = String(id).startsWith('d:') ? _realViews(k).find(v => 'd:' + v.tipo === String(id)) : _views.find(v => String(v.id) === String(id));
      const r = await apiFetch(`${API}/mgmt/space-views/${real.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: nm.trim() }) });
      if (r.ok) Object.assign(real, await r.json());
    } catch (e) { showBanner('No se pudo renombrar', 'error'); }
    _paintMain();
  }
  async function delView(id) {
    _closePop();
    try {
      const k = _sk(); if (_viewsOf(k).length <= 1) { showBanner('Deja al menos una vista aquí', 'info'); return; }
      if (!confirm('¿Quitar esta vista? Las tareas no se borran.')) return;
      await _materialize(k); const real = String(id).startsWith('d:') ? _realViews(k).find(v => 'd:' + v.tipo === String(id)) : _views.find(v => String(v.id) === String(id));
      await apiFetch(`${API}/mgmt/space-views/${real.id}`, { method: 'DELETE' }); _views = _views.filter(v => v.id !== real.id); delete _viewSel[k]; _save();
    } catch (e) { showBanner('No se pudo quitar la vista', 'error'); }
    _paintMain();
  }


  // ═══ Menú ⋯ de un proyecto (como el de una «lista» de ClickUp): favorito, nombre, vínculo, crear, color/ícono, información, plantillas, importar, mover, duplicar, archivar, eliminar ═══
  const _pjOf = pid => _projects.find(p => p.id === pid);
  const _plain = n => String(n || '').replace(/^P\d{3,}\s*[·\-—:]?\s*/i, '').trim();
  const _I = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const _IC = { star: '<polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/>', edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>', plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', pal: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/>', info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>', tpl: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>', imp: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', mv: '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>', dup: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', arc: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>', del: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' };
  let _pmPid = 0;
  function _pmMainHtml() {
    const pid = _pmPid, p = _pjOf(pid); if (!p) return '';
    const it = (ic, l, fn, cls) => `<button type="button" class="sp-pm__i${cls ? ' ' + cls : ''}" onclick="${fn}">${_I(_IC[ic])}<span>${l}</span></button>`;
    const sub = (ic, l, k) => `<button type="button" class="sp-pm__i" onclick="SpacesModule.pmSub('${k}')">${_I(_IC[ic])}<span>${l}</span><i>›</i></button>`;
    return `<div class="sp-pm__t">${esc(_plain(p.nombre))}</div>${it('star', _isFav(pid) ? 'Quitar de favoritos' : 'Marcar como favorito', 'SpacesModule.pmFav()')}${it('edit', 'Cambiar el nombre', 'SpacesModule.pmRename()')}${it('link', 'Copiar vínculo', 'SpacesModule.pmLink()')}<div class="sp-pm__s"></div>
      ${sub('plus', 'Crear nuevo', 'new')}${sub('pal', 'Color e ícono', 'color')}${it('info', 'Información del proyecto', 'SpacesModule.pmInfo()')}<div class="sp-pm__s"></div>
      ${sub('tpl', 'Plantillas', 'tpl')}${sub('imp', 'Importaciones', 'imp')}<div class="sp-pm__s"></div>${it('link', 'Uso compartido y permisos', 'SpacesModule.pmShare()')}${sub('mv', 'Mover', 'mv')}${it('dup', 'Duplicar', 'SpacesModule.pmDup()')}${it('arc', p.archivado ? 'Restaurar (quitar de archivados)' : 'Archivar', 'SpacesModule.pmArch()')}${it('del', 'Eliminar', 'SpacesModule.pmDel()', 'sp-pm__i--del')}`;
  }
  function projMenu(ev, pid) { _pmPid = pid; if (!_pjOf(pid)) return; _openPop(ev.currentTarget, _pmMainHtml(), 'sp-pm'); }
  function pmBack() { const pop = document.querySelector('.sp-pm'); if (pop) pop.innerHTML = _pmMainHtml(); }
  function pmSub(k) {
    const pop = document.querySelector('.sp-pm'); if (!pop) return; const p = _pjOf(_pmPid); if (!p) return;
    const back = t => `<button type="button" class="sp-pm__b" onclick="SpacesModule.pmBack()">‹ ${t}</button>`;
    const it = (ic, l, fn) => `<button type="button" class="sp-pm__i" onclick="${fn}">${_I(_IC[ic] || _IC.plus)}<span>${l}</span></button>`;
    let h = '';
    if (k === 'new') h = back('Crear nuevo') + it('plus', 'Tarea', 'SpacesModule.pmNewTask()') + [['documento', 'Documento'], ['formulario', 'Formulario'], ['panel', 'Panel'], ['pizarra', 'Pizarra']].map(([t, l]) => it('plus', l + ' <em>(vista)</em>', `SpacesModule.pmAddView('${t}')`)).join('') + '<div class="sp-pm__s"></div>' + it('imp', 'Importar hoja de cálculo', 'SpacesModule.impOpen()') + it('tpl', 'Aplicar una plantilla', 'SpacesModule.tplApplyOpen()');
    else if (k === 'tpl') h = back('Plantillas') + it('tpl', 'Establecer plantilla de tarea predeterminada', 'SpacesModule.tdOpen()') + '<div class="sp-pm__s"></div>' + it('tpl', 'Aplicar una plantilla', 'SpacesModule.tplApplyOpen()') + it('imp', 'Guardar como plantilla', 'SpacesModule.tplSaveOpen()') + it('dup', 'Actualizar plantilla existente', 'SpacesModule.tplRefreshOpen()') + '<div class="sp-pm__s"></div>' + it('edit', 'Administrar plantillas', 'SpacesModule.tplManage()');
    else if (k === 'imp') h = back('Importaciones') + it('imp', 'Archivo de hoja de cálculo (Excel / CSV)', 'SpacesModule.impOpen()') + '<div class="sp-pm__n">Otras herramientas (Asana, Trello, Notion…) llegarán después.</div>';
    else if (k === 'mv') { const cur = p.space_id || 0; h = back('Mover a…') + [{ id: 0, nombre: 'Principal' }, ..._spaces].map(s => `<button type="button" class="sp-pm__i" onclick="SpacesModule.pmMove(${s.id})"><span class="sp-sq sp-sq--s" style="background:${s.color || '#007AFF'}">${_nrm(s.nombre).slice(0, 1).toUpperCase()}</span><span>${esc(s.nombre)}</span>${cur === s.id ? '<i>✓</i>' : ''}</button>`).join(''); }
    else if (k === 'color') {
      const cols = ['#007AFF', '#2F6BFF', '#0891B2', '#2E9E5B', '#E8920F', '#D9534F', '#D6409F', '#6B6760'], emos = ['📁', '📌', '🚀', '🎯', '📣', '💼', '🛒', '🧾', '📞', '✉️', '💡', '🔧', '📈', '🧪', '🏠', '🌍', '🎨', '🧠', '⚙️', '🔔', '📅', '⭐', '🤝', '💰'];
      h = back('Color e ícono') + `<div class="sp-pm__n">Color</div><div class="sp-pm__cols">${cols.map(c => `<button type="button" style="background:${c}" class="${p.color === c ? 'on' : ''}" onclick="SpacesModule.pmStyle('color','${c}')"></button>`).join('')}</div><div class="sp-pm__n">Ícono</div><div class="sp-pm__emos">${emos.map(e => `<button type="button" class="${p.icono === e ? 'on' : ''}" onclick="SpacesModule.pmStyle('icono','${e}')">${e}</button>`).join('')}</div><button type="button" class="sp-pm__i" onclick="SpacesModule.pmStyle('reset')"><span>Restablecer</span></button>`;
    }
    pop.innerHTML = h;
  }
  async function _reload() {
    try { const [pr, tr, sr, vr] = await Promise.all([apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/tasks`), apiFetch(`${API}/mgmt/spaces`), apiFetch(`${API}/mgmt/space-views`)]); if (pr.ok) _projects = await pr.json(); if (tr.ok) _tasks = await tr.json(); if (sr.ok) _spaces = await sr.json(); if (vr.ok) _views = await vr.json(); } catch (_) {}
    if (_selProj && !_projects.some(p => p.id === _selProj && (!p.archivado || _showArch))) _selProj = null;
    _paintTree(); _paintMain();
  }
  const _post = (url, body, m) => apiFetch(`${API}${url}`, { method: m || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const _err = async (r, d) => { try { return (await r.json()).error || d; } catch (_) { return d; } };
  function pmFav() { _closePop(); const f = _fav(), i = f.indexOf(_pmPid); if (i >= 0) f.splice(i, 1); else f.push(_pmPid); try { localStorage.setItem('nova_sp_fav', JSON.stringify(f)); } catch (_) {} _paintTree(); }
  async function pmRename() {
    _closePop(); const p = _pjOf(_pmPid); const v = prompt('Nombre del proyecto', _plain(p.nombre)); if (!v || !v.trim()) return;
    const r = await _post(`/mgmt/projects/${_pmPid}/meta`, { nombre: v.trim() }, 'PATCH'); if (!r.ok) { showBanner(await _err(r, 'No se pudo renombrar'), 'error'); return; } const j = await r.json(); p.nombre = j.nombre; _paintTree(); _paintMain();
  }
  function pmLink() { _closePop(); const u = `${location.origin}/?tab=mgmt-spaces&p=${_pmPid}`; try { navigator.clipboard.writeText(u); showBanner('✓ Vínculo copiado', 'success'); } catch (_) { prompt('Copia el vínculo', u); } }
  function pmNewTask() { _closePop(); pick(_pjOf(_pmPid).space_id || 0, _pmPid); setTimeout(() => newTask('pendiente'), 60); }
  async function pmAddView(t) { _closePop(); const p = _pjOf(_pmPid); pick(p.space_id || 0, _pmPid); await addView(t); }
  async function pmMove(sid) { _closePop(); await moveProj(_pmPid, sid); }
  async function pmStyle(k, v) {
    const body = k === 'reset' ? { color: '', icono: '' } : { [k]: v }; const r = await _post(`/mgmt/projects/${_pmPid}/meta`, body, 'PATCH'); if (!r.ok) return; const j = await r.json(); Object.assign(_pjOf(_pmPid), j); _paintTree(); _paintMain(); pmSub('color');
  }
  async function pmArch() {
    _closePop(); const p = _pjOf(_pmPid), back = !!p.archivado; if (!back && !confirm(`¿Archivar «${_plain(p.nombre)}»? Deja de verse en Espacios y Proyectos, pero no se borra nada. Puedes verlo de nuevo con «Mostrar archivados».`)) return;
    const r = await _post(`/mgmt/projects/${_pmPid}/meta`, { archivado: !back }, 'PATCH'); if (!r.ok) { showBanner(back ? 'No se pudo restaurar' : 'No se pudo archivar', 'error'); return; } p.archivado = !back; if (!back && _selProj === _pmPid && !_showArch) _selProj = null; showBanner(back ? '✓ Proyecto restaurado' : '✓ Proyecto archivado', 'success'); _paintTree(); _paintMain();
  }
  async function pmDel() {
    _closePop(); const p = _pjOf(_pmPid), n = _tasks.filter(t => t.project_id === _pmPid).length;
    if (!confirm(`¿Eliminar «${_plain(p.nombre)}» y sus ${n} tarea(s)? Esta acción no se puede deshacer.\n\n(Si solo quieres sacarlo de la vista, usa «Archivar».)`)) return;
    const r = await apiFetch(`${API}/mgmt/projects/${_pmPid}`, { method: 'DELETE' }); if (!r.ok) { showBanner(await _err(r, 'No se pudo eliminar'), 'error'); return; } showBanner('Proyecto eliminado', 'success'); _selProj = null; await _reload();
  }
  // ── ventanas (modales) ──
  function _modal(html, wide) { document.getElementById('sp-modal')?.remove(); const m = document.createElement('div'); m.id = 'sp-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); }; m.innerHTML = `<div class="fin-pi-box" style="max-width:${wide || 520}px"><div class="fin-pi-box__hd"><h3>${html.t}</h3><button class="fin-pi-x" onclick="document.getElementById('sp-modal').remove()">✕</button></div><div class="sp-mb">${html.b}</div></div>`; document.body.appendChild(m); return m; }
  const _close = () => document.getElementById('sp-modal')?.remove();
  const _ck = (id, l, on, hint) => `<label class="sp-ck"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span>${l}${hint ? `<em>${hint}</em>` : ''}</span></label>`;
  const _v = id => (document.getElementById(id) || {}).value || '', _c = id => !!(document.getElementById(id) || {}).checked;
  function pmShare() { _closePop(); const p = _pjOf(_pmPid); if (p) PermsUI.share('project', p.id, _plain(p.nombre)); }
  function shareSpace(sid) { _closePop(); const s = _spaces.find(x => x.id === sid); PermsUI.share('space', sid, s ? s.nombre : 'Espacio'); }
  function pmInfo() {
    _closePop(); const p = _pjOf(_pmPid), ts = _tasks.filter(t => t.project_id === _pmPid && !t.archivada), abiertas = ts.filter(t => _isOpen(t)).length;
    const row = (k, v) => v ? `<div class="sp-if"><span>${k}</span><b>${v}</b></div>` : '';
    _modal({ t: 'Información del proyecto', b: `${row('Nombre', esc(p.nombre))}${row('Cliente', esc((p.client_nombre || '') + (p.client_empresa ? ' · ' + p.client_empresa : '')))}${row('Estado', esc(p.estado || ''))}${row('Espacio', esc(p.space_id ? ((_spaces.find(s => s.id === p.space_id) || {}).nombre || '') : 'Principal'))}${row('Responsables', esc((p.responsables && p.responsables.length ? p.responsables : (p.responsable ? [p.responsable] : [])).join(', ')))}${row('Inicio', _fmtD(_d10(p.fecha_inicio)))}${row('Fin', _fmtD(_d10(p.fecha_fin)))}${row('Tareas', `${ts.length} (${abiertas} abiertas)`)}${row('Valor', p.valor_total ? esc((p.moneda || 'USD') + ' ' + p.valor_total) : '')}${row('Creado', p.created_at ? new Date(p.created_at).toLocaleDateString('es') : '')}${row('Código', esc((String(p.nombre).match(/^P\d{3,}/) || [''])[0]))}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="abrirVentanaProyecto(${p.id});document.getElementById('sp-modal').remove()">Abrir proyecto ›</button></div>` }, 460);
  }
  async function pmDup() {
    _closePop(); const p = _pjOf(_pmPid);
    _modal({ t: 'Duplicar proyecto', b: `<p class="sp-mp">Se crea «Copia de ${esc(_plain(p.nombre))}» en el mismo espacio y cliente.</p>${_ck('dp-t', 'Copiar tareas y subtareas', true, 'quedan como pendientes, sin horas ni cobros')}${_ck('dp-r', 'Mantener las personas asignadas', true)}${_ck('dp-v', 'Copiar vistas, documentos y pizarras', true)}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.pmDupGo()">Duplicar</button></div>` }, 460);
  }
  async function pmDupGo() {
    const r = await _post(`/mgmt/projects/${_pmPid}/duplicate`, { con_tareas: _c('dp-t'), con_responsables: _c('dp-r'), con_vistas: _c('dp-v') }); if (!r.ok) { showBanner(await _err(r, 'No se pudo duplicar'), 'error'); return; }
    const j = await r.json(); _close(); showBanner(`✓ Proyecto duplicado (${j.tareas} tareas)`, 'success'); await _reload(); const np = _pjOf(j.id); if (np) pick(np.space_id || 0, np.id);
  }
  // ── Plantillas de proyecto ──
  let _tpls = [];
  async function _loadTpls() { try { const r = await apiFetch(`${API}/mgmt/project-templates`); _tpls = r.ok ? await r.json() : []; } catch (_) { _tpls = []; } return _tpls; }
  const _tplOpts = `${_ck('tp-t', 'Tareas y subtareas', true)}${_ck('tp-r', 'Personas asignadas', false)}${_ck('tp-f', 'Fechas', true, 'se guardan relativas al inicio (día 0, día 3…) y se recalculan al usar la plantilla')}${_ck('tp-v', 'Vistas, documentos y pizarras', true)}${_ck('tp-c', 'Datos de cobro y horarios', true)}`;
  const _tplOptsRead = () => ({ tareas: _c('tp-t'), subtareas: _c('tp-t'), responsables: _c('tp-r'), fechas: _c('tp-f'), vistas: _c('tp-v'), cobro: _c('tp-c') });
  function tplSaveOpen() {
    _closePop(); const p = _pjOf(_pmPid);
    _modal({ t: 'Guardar como plantilla', b: `<p class="sp-mp">Guarda la estructura de «${esc(_plain(p.nombre))}» para repetir ese proceso con otros clientes.</p><label class="sp-fl">Nombre de la plantilla<input id="tp-n" value="${esc(_plain(p.nombre))}"></label><label class="sp-fl">Descripción (opcional)<input id="tp-d" placeholder="Para qué sirve"></label><div class="sp-mh">Qué se guarda</div>${_tplOpts}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.tplSaveGo()">Guardar plantilla</button></div>` }, 520);
  }
  async function tplSaveGo() {
    const n = _v('tp-n').trim(); if (!n) { showBanner('Ponle un nombre', 'error'); return; }
    const r = await _post('/mgmt/project-templates', { project_id: _pmPid, nombre: n, descripcion: _v('tp-d'), opciones: _tplOptsRead() }); if (!r.ok) { showBanner(await _err(r, 'No se pudo guardar'), 'error'); return; }
    const j = await r.json(); _close(); showBanner(`✓ Plantilla «${j.nombre}» guardada (${j.n_tareas} tareas, ${j.n_vistas} vistas)`, 'success');
  }
  async function tplRefreshOpen() {
    _closePop(); const ts = await _loadTpls(); if (!ts.length) { showBanner('Aún no hay plantillas: guarda una primero', 'info'); return; }
    _modal({ t: 'Actualizar plantilla existente', b: `<p class="sp-mp">La plantilla elegida se reemplaza por el estado actual de este proyecto.</p><label class="sp-fl">Plantilla<select id="tr-id">${ts.map(t => `<option value="${t.id}">${esc(t.nombre)} · ${t.n_tareas} tareas</option>`).join('')}</select></label><div class="sp-mh">Qué se guarda</div>${_tplOpts}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.tplRefreshGo()">Actualizar</button></div>` }, 520);
  }
  async function tplRefreshGo() {
    const r = await _post(`/mgmt/project-templates/${_v('tr-id')}/refresh`, { project_id: _pmPid, opciones: _tplOptsRead() }, 'PUT'); if (!r.ok) { showBanner(await _err(r, 'No se pudo actualizar'), 'error'); return; }
    const j = await r.json(); _close(); showBanner(`✓ Plantilla «${j.nombre}» actualizada`, 'success');
  }
  async function _tplApplyOpenOld() {
    _closePop(); const ts = await _loadTpls(); if (!ts.length) { showBanner('Aún no hay plantillas: guarda una desde un proyecto («Plantillas › Guardar como plantilla»)', 'info'); return; }
    const p = _pjOf(_pmPid), hoy = _today();
    _modal({ t: 'Aplicar una plantilla', b: `<p class="sp-mp">Añade a «${esc(_plain(p.nombre))}» las tareas y vistas de una plantilla.</p><label class="sp-fl">Plantilla<select id="ta-id">${ts.map(t => `<option value="${t.id}">${esc(t.nombre)} · ${t.n_tareas} tareas</option>`).join('')}</select></label>
      <label class="sp-fl">Fecha de inicio (las fechas de las tareas se calculan desde aquí)<input id="ta-f" type="date" value="${_d10(p.fecha_inicio) || hoy}"></label><div class="sp-mh">Personas asignadas</div>${_radios('ta-r', 'plantilla')}${_ck('ta-v', 'Añadir también las vistas, documentos y pizarras', true)}${_ck('ta-a', 'Aplicar los ajustes de la plantilla (descripción, cobro, horarios)', false)}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.tplApplyGo()">Aplicar</button></div>` }, 520);
  }
  const _radios = (n, def) => [['plantilla', 'Las de la plantilla'], ['yo', 'Asignármelas a mí'], ['ninguno', 'Sin asignar']].map(([v, l]) => `<label class="sp-rd"><input type="radio" name="${n}" value="${v}"${v === def ? ' checked' : ''}> ${l}</label>`).join('');
  const _rad = n => (document.querySelector(`input[name="${n}"]:checked`) || {}).value || 'plantilla';
  async function tplApplyGo() {
    const r = await _post(`/mgmt/project-templates/${_v('ta-id')}/apply`, { project_id: _pmPid, fecha_inicio: _v('ta-f'), responsables: _rad('ta-r'), yo: _myNm(), con_vistas: _c('ta-v'), aplicar_ajustes: _c('ta-a') }); if (!r.ok) { showBanner(await _err(r, 'No se pudo aplicar'), 'error'); return; }
    const j = await r.json(); _close(); showBanner(`✓ Plantilla aplicada: ${j.tareas} tareas y ${j.vistas} vistas`, 'success'); await _reload();
  }
  const _myNm = () => String(window._authUser?.memberNombre || window._authUser?.name || '');
  // Crear un proyecto NUEVO desde una plantilla (desde «＋» del espacio o desde Proyectos)
  async function _tplCreateOpenOld(sid) {
    _closePop(); const [ts, cr] = await Promise.all([_loadTpls(), apiFetch(`${API}/mgmt/clients`)]); const cls = cr.ok ? await cr.json() : [];
    try { const sr = await apiFetch(`${API}/mgmt/spaces`); if (sr.ok) _spaces = await sr.json(); } catch (_) {}
    if (!ts.length) { showBanner('Aún no hay plantillas: abre un proyecto y usa «Plantillas › Guardar como plantilla»', 'info'); return; }
    _modal({ t: 'Crear proyecto desde plantilla', b: `<label class="sp-fl">Plantilla<select id="tc-id">${ts.map(t => `<option value="${t.id}">${esc(t.nombre)} · ${t.n_tareas} tareas</option>`).join('')}</select></label>
      <label class="sp-fl">Nombre del proyecto *<input id="tc-n" placeholder="Ej.: Adquisición B2B · Cliente X"></label>
      <div class="sp-fr"><label class="sp-fl">Cliente *<select id="tc-c"><option value="">Selecciona…</option>${cls.map(c => `<option value="${c.id}">${esc(c.nombre)}${c.empresa ? ' · ' + esc(c.empresa) : ''}</option>`).join('')}</select></label>
      <label class="sp-fl">Espacio<select id="tc-s"><option value="0">Principal</option>${_spaces.map(s => `<option value="${s.id}"${s.id === sid ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></label></div>
      <label class="sp-fl">Fecha de inicio *<input id="tc-f" type="date" value="${_today()}"></label><div class="sp-mh">Personas asignadas</div>${_radios('tc-r', 'plantilla')}<div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" id="tc-go" onclick="SpacesModule.tplCreateGo()">Crear proyecto</button></div>` }, 540);
  }
  async function tplCreateGo() {
    const n = _v('tc-n').trim(), cid = +_v('tc-c'), f = _v('tc-f'); if (!n || !cid || !f) { showBanner('Falta el nombre, el cliente o la fecha de inicio', 'error'); return; }
    const btn = document.getElementById('tc-go'); if (btn) { btn.disabled = true; btn.textContent = 'Creando…'; }
    try {
      const r = await _post('/mgmt/projects', { nombre: n, client_id: cid, estado: 'activo', fecha_inicio: f, prioridad: 'media', tipo_proyecto: 'fijo', moneda: 'USD', responsables: [], responsable: '' }); if (!r.ok) throw new Error(await _err(r, 'No se pudo crear el proyecto'));
      const np = await r.json(); const sid = +_v('tc-s') || 0;
      if (sid) await _post(`/mgmt/projects/${np.id}/space`, { space_id: sid }, 'PATCH');
      const ra = await _post(`/mgmt/project-templates/${_v('tc-id')}/apply`, { project_id: np.id, fecha_inicio: f, responsables: _rad('tc-r'), yo: _myNm(), con_vistas: true, aplicar_ajustes: true }); if (!ra.ok) throw new Error(await _err(ra, 'El proyecto se creó, pero no se pudo aplicar la plantilla'));
      const j = await ra.json(); _close(); showBanner(`✓ Proyecto creado desde la plantilla (${j.tareas} tareas)`, 'success'); await _reload(); pick(sid, np.id);
    } catch (e) { showBanner(e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Crear proyecto'; } }
  }
  async function _tplManageOld() {
    _closePop(); const ts = await _loadTpls();
    _modal({ t: 'Plantillas de proyecto', b: ts.length ? `<div class="sp-tl">${ts.map(t => `<div class="sp-tl__r"><div><b>${esc(t.nombre)}</b><em>${t.n_tareas} tareas · ${t.n_vistas} vistas${t.created_by ? ' · por ' + esc(t.created_by) : ''}</em></div><span><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tplRename(${t.id})">Renombrar</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tplDelete(${t.id})">Eliminar</button></span></div>`).join('')}</div>` : '<p class="sp-mp">Aún no hay plantillas. Abre un proyecto y usa «Plantillas › Guardar como plantilla».</p>' }, 560);
  }
  async function tplRename(id) { const t = _tpls.find(x => x.id === id), v = prompt('Nombre de la plantilla', t ? t.nombre : ''); if (!v || !v.trim()) return; const r = await _post(`/mgmt/project-templates/${id}`, { nombre: v.trim() }, 'PATCH'); if (r.ok) tplManage(); }
  async function tplDelete(id) { if (!confirm('¿Eliminar esta plantilla? Los proyectos ya creados con ella no cambian.')) return; await apiFetch(`${API}/mgmt/project-templates/${id}`, { method: 'DELETE' }); tplManage(); }
  // ── plantilla de tarea predeterminada ──
  function tdOpen() {
    _closePop(); const p = _pjOf(_pmPid), td = p.task_defaults || {}, cl = (td.checklists && td.checklists[0]) || null;
    _modal({ t: 'Plantilla de tarea predeterminada', b: `<p class="sp-mp">Cada tarea nueva de «${esc(_plain(p.nombre))}» nacerá con estos valores (lo que escribas al crearla manda sobre ellos).</p><label class="sp-fl">Descripción<textarea id="td-d" rows="3">${esc(td.descripcion || '')}</textarea></label>
      <div class="sp-fr"><label class="sp-fl">Prioridad<select id="td-p"><option value="">Sin cambiar</option>${['alta', 'media', 'baja'].map(x => `<option value="${x}"${td.prioridad === x ? ' selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></label><label class="sp-fl">Duración estimada (min)<input id="td-m" type="number" min="0" value="${td.duracion_est_min || ''}"></label></div>
      <label class="sp-fl">Etiquetas (separadas por comas)<input id="td-e" value="${esc((td.etiquetas || []).join(', '))}"></label>
      <label class="sp-fl">Checklist — título<input id="td-ct" value="${esc(cl ? cl.titulo : '')}" placeholder="Ej.: Pasos del proceso"></label><label class="sp-fl">Checklist — un paso por línea<textarea id="td-ci" rows="4">${esc(cl ? (cl.items || []).map(i => i.texto).join('\n') : '')}</textarea></label>
      <div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tdClear()">Quitar plantilla</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.tdSave()">Guardar</button></div>` }, 520);
  }
  async function tdSave() {
    const items = _v('td-ci').split('\n').map(x => x.trim()).filter(Boolean), body = { descripcion: _v('td-d'), prioridad: _v('td-p'), duracion_est_min: _v('td-m'), etiquetas: _v('td-e').split(',').map(x => x.trim()).filter(Boolean), checklists: items.length ? [{ titulo: _v('td-ct') || 'Checklist', items: items.map(texto => ({ texto })) }] : [] };
    const r = await _post(`/mgmt/projects/${_pmPid}/task-defaults`, body, 'PUT'); if (!r.ok) { showBanner(await _err(r, 'No se pudo guardar'), 'error'); return; } _pjOf(_pmPid).task_defaults = (await r.json()).task_defaults; _close(); showBanner('✓ Plantilla de tarea guardada', 'success');
  }
  async function tdClear() { const r = await _post(`/mgmt/projects/${_pmPid}/task-defaults`, {}, 'PUT'); if (r.ok) { _pjOf(_pmPid).task_defaults = {}; _close(); showBanner('Plantilla de tarea quitada', 'success'); } }
  // ── importar tareas desde Excel / CSV ──
  let _imp = null;
  function impOpen() {
    _closePop(); const p = _pjOf(_pmPid);
    _modal({ t: 'Importar tareas desde hoja de cálculo', b: `<p class="sp-mp">Sube un Excel o CSV: una fila por tarea. Se reconocen las columnas <b>Título</b> (o Tarea/Nombre), Descripción, Prioridad, Estado, Responsable, Fecha límite, Fecha inicio y «Subtarea de» (título de la tarea principal).</p><input type="file" id="im-f" accept=".csv,.xlsx,.xls" onchange="SpacesModule.impRead(this.files[0])"><div id="im-p" class="sp-imp"></div><div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('sp-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" id="im-go" onclick="SpacesModule.impGo()" disabled>Importar</button></div>` }, 640);
  }
  const _HDR = { titulo: ['titulo', 'tarea', 'nombre', 'task', 'name', 'title', 'task name'], descripcion: ['descripcion', 'description', 'detalle', 'notas'], prioridad: ['prioridad', 'priority'], estado: ['estado', 'status'], responsable: ['responsable', 'asignado', 'persona asignada', 'assignee', 'owner', 'asignado a'], deadline: ['fecha limite', 'fecha de vencimiento', 'vence', 'deadline', 'due date', 'due', 'fecha fin', 'fin'], fecha_inicio: ['fecha inicio', 'fecha de inicio', 'inicio', 'start date', 'start'], subtarea_de: ['subtarea de', 'padre', 'parent', 'tarea principal'] };
  const _iso = v => { if (v == null || v === '') return ''; if (v instanceof Date) return isNaN(v) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; } return ''; };
  const _nz = s => _nrm(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function impRead(file) {
    if (!file) return; const box = $q('im-p'); if (typeof XLSX === 'undefined') { box.textContent = 'No se pudo cargar el lector de Excel. Recarga la página.'; return; }
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(rd.result), { type: 'array', cellDates: true }), ws = wb.Sheets[wb.SheetNames[0]], rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
        if (!rows.length) { box.textContent = 'El archivo no tiene filas.'; return; }
        const keys = Object.keys(rows[0]), map = {}; Object.entries(_HDR).forEach(([f, al]) => { const k = keys.find(k => al.includes(_nz(k))); if (k) map[f] = k; });
        if (!map.titulo) { box.innerHTML = `<span style="color:#B42318">No encuentro la columna del título. Columnas del archivo: ${esc(keys.join(', '))}. Renombra una a «Título» o «Tarea».</span>`; return; }
        const PR = { alta: 'alta', urgente: 'alta', high: 'alta', urgent: 'alta', media: 'media', normal: 'media', medium: 'media', baja: 'baja', low: 'baja' };
        const ES = { pendiente: 'pendiente', 'to do': 'pendiente', todo: 'pendiente', 'por hacer': 'pendiente', 'en curso': 'en_progreso', 'en progreso': 'en_progreso', 'in progress': 'en_progreso', bloqueado: 'bloqueado', blocked: 'bloqueado', completado: 'completado', hecho: 'completado', done: 'completado', complete: 'completado', cancelado: 'cancelado' };
        const out = rows.map(r => ({ titulo: String(r[map.titulo] || '').trim(), descripcion: map.descripcion ? String(r[map.descripcion] || '') : '', prioridad: map.prioridad ? (PR[_nz(r[map.prioridad])] || '') : '', estado: map.estado ? (ES[_nz(r[map.estado])] || '') : '', responsable: map.responsable ? String(r[map.responsable] || '').trim() : '', deadline: map.deadline ? _iso(r[map.deadline]) : '', fecha_inicio: map.fecha_inicio ? _iso(r[map.fecha_inicio]) : '', subtarea_de: map.subtarea_de ? String(r[map.subtarea_de] || '').trim() : '' })).filter(r => r.titulo);
        _imp = out; $q('im-go').disabled = !out.length;
        box.innerHTML = `<div class="sp-mh">${out.length} tarea(s) listas · columnas reconocidas: ${Object.keys(map).map(k => esc(k)).join(', ')}</div><table class="sp-it"><thead><tr><th>Título</th><th>Prioridad</th><th>Estado</th><th>Responsable</th><th>Fecha límite</th></tr></thead><tbody>${out.slice(0, 6).map(r => `<tr><td>${esc(r.titulo)}</td><td>${esc(r.prioridad || '—')}</td><td>${esc(r.estado || 'pendiente')}</td><td>${esc(r.responsable || '—')}</td><td>${esc(r.deadline || '—')}</td></tr>`).join('')}</tbody></table>${out.length > 6 ? `<em>…y ${out.length - 6} más</em>` : ''}`;
      } catch (e) { box.textContent = 'No se pudo leer el archivo: ' + e.message; }
    };
    rd.readAsArrayBuffer(file);
  }
  async function impGo() {
    if (!_imp || !_imp.length) return; const btn = $q('im-go'); btn.disabled = true; btn.textContent = 'Importando…';
    const r = await _post(`/mgmt/projects/${_pmPid}/import-tasks`, { rows: _imp }); if (!r.ok) { showBanner(await _err(r, 'No se pudo importar'), 'error'); btn.disabled = false; btn.textContent = 'Importar'; return; }
    const j = await r.json(); _close(); showBanner(`✓ ${j.creadas} tareas importadas`, 'success'); _imp = null; await _reload();
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
  function setGroup(g) { _closePop(); _group = g; _save(); _paintMain(); }
  function toggleSubs() { _expandSubs = !_expandSubs; _save(); _paintMain(); }
  function toggleClosed() { _showClosed = !_showClosed; _paintMain(); }
  function toggleMe() { _me = !_me; _paintMain(); }
  function setQ(v) { _q = v; _paintBody(); }
  function groupMenu(ev) { _openPop(ev.currentTarget, `<div class="sp-pop__h">Agrupar por</div>${[['estado', 'Estado'], ['prioridad', 'Prioridad'], ['persona', 'Persona asignada'], ['fecha', 'Fecha límite'], ...(_selProj ? _fields(_selProj).filter(f => ['lista', 'etiquetas', 'casilla', 'personas'].includes(f.t)).map(f => ['f:' + f.id, 'Campo: ' + f.n]) : []), ['ninguno', 'Ninguno']].map(([k, l]) => `<button class="sp-pop__i${_group === k ? ' on' : ''}" onclick="SpacesModule.setGroup('${k}')">${l}${_group === k ? ' ✓' : ''}</button>`).join('')}`); }
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
  function colsMenu(ev) { _openPop(ev.currentTarget, `<div class="sp-pop__h">Columnas</div>${Object.entries(_COLS).map(([k, l]) => `<label class="sp-pop__o"><input type="checkbox" ${_cols.includes(k) ? 'checked' : ''} onchange="SpacesModule.toggleCol('${k}',this.checked)"><span>${l}</span></label>`).join('')}${_selProj ? `<div class="sp-pop__h">Campos del proyecto</div>${_fields(_selProj).map(f => `<label class="sp-pop__o"><input type="checkbox" ${f.v !== false ? 'checked' : ''} onchange="SpacesModule.fmVisPop('${f.id}',this.checked)"><span>${esc(f.n)}</span></label>`).join('')}<button class="sp-pop__i" onclick="SpacesModule.fieldsOpen()">Administrar campos…</button>` : ''}<div class="sp-pop__h">Opciones</div><label class="sp-pop__o"><input type="checkbox" ${_expandSubs ? 'checked' : ''} onchange="SpacesModule.toggleSubs()"><span>Mostrar subtareas</span></label>`, 'sp-pop--w'); }
  function toggleCol(k, on) { _cols = on ? [...new Set([..._cols, k])] : _cols.filter(c => c !== k); _save(); _paintBody(); }

  // ── cabecera + barra ──
  function _paintMain() {
    const m = $q('sp-main'); if (!m) return;
    if (_mode === 'proyectos' && !_selProj) { _paintProjects(m); return; }
    const { sp, p } = _title();
    if (!p) _cfg = false;
    const nF = _fEstado.length + _fPrio.length + (_q ? 1 : 0);
    const cv = _curView(); _view = cv.tipo;
    const listish = ['lista', 'tabla', 'tablero'].includes(_view), noBar = ['formulario', 'documento', 'pizarra'].includes(_view) || (p && _cfg);
    const ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const meOn = _me, persOn = _fPers.length;
    m.innerHTML = `<div class="sp-top"><div class="sp-crumb">${sp ? `<span class="sp-sq sp-sq--s" style="background:${sp.color || '#007AFF'}">${_nrm(sp.nombre).slice(0, 1).toUpperCase()}</span><span class="sp-crumb__a">${esc(sp.nombre)}</span><span class="sp-crumb__s">/</span>` : ''}<b>${p ? esc(p.nombre) : (sp ? 'Todas las listas' : 'Todas las tareas')}</b>${p && p.client_nombre ? `<span class="sp-crumb__c">${esc(p.client_nombre)}</span>` : ''}</div>
</div>
      <div class="sp-tabs">${_viewsOf(_sk()).map(v => `<span class="sp-tab sp-tab--v${cv.id === v.id && !_cfg ? ' on' : ''}" title="${esc(v.nombre || (_VT[v.tipo] || [''])[0])}" onclick="SpacesModule.selView('${v.id}')"><i class="sp-tab__i" style="color:${(_VT[v.tipo] || _VT.lista)[2]}">${_ico((_VT[v.tipo] || _VT.lista)[3])}</i><b class="sp-tab__x" title="Renombrar o quitar" onclick="SpacesModule.viewOpts(event,'${v.id}')">⋯</b></span>`).join('')}<button type="button" class="sp-tab sp-tab--add" title="Añadir vista" onclick="SpacesModule.viewMenu(event)">＋</button>${p ? `<span class="sp-tabs__gap"></span><button type="button" class="sp-tab sp-tab--cfg${_cfg ? ' on' : ''}" title="Configuración del proyecto: datos, tiempo, costos, equipo y plantillas" onclick="SpacesModule.cfgOpen()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><b>Configuración</b></button>` : ''}</div>
      ${noBar ? '' : `<div class="sp-bar"><div class="sp-bar__l">
          ${listish ? `<button type="button" class="sp-chip" onclick="SpacesModule.groupMenu(event)">${ico('<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>')} ${{ estado: 'Estado', prioridad: 'Prioridad', persona: 'Persona', fecha: 'Fecha límite', ninguno: 'Sin agrupar' }[_group] || 'Campo'}</button>
          <button type="button" class="sp-chip${_expandSubs ? ' on' : ''}" onclick="SpacesModule.toggleSubs()">${ico('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v4a4 4 0 0 0 4 4h6"/>')} ${_expandSubs ? 'Expandidos' : 'Contraídos'}</button>
          <button type="button" class="sp-ibtn" title="Columnas" onclick="SpacesModule.colsMenu(event)">${ico('<rect x="3" y="4" width="18" height="16"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>')}</button>` : ''}</div>
        <div class="sp-bar__r">
          <button type="button" class="sp-ibtn${nF ? ' on' : ''}" title="Filtros" onclick="SpacesModule.filterMenu(event)">${ico('<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/>')}${nF ? `<i>${nF}</i>` : ''}</button>
          <button type="button" class="sp-ibtn${_showClosed ? ' on' : ''}" title="Mostrar tareas cerradas" onclick="SpacesModule.toggleClosed()">${ico('<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>')}</button>
          <button type="button" class="sp-ibtn${persOn ? ' on' : ''}" title="Persona asignada" onclick="SpacesModule.persMenu(event)">${ico('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M17 4a3.5 3.5 0 0 1 0 7"/>')}</button>
          <button type="button" class="sp-me${meOn ? ' on' : ''}" title="Sólo mis tareas" onclick="SpacesModule.toggleMe()">${esc(_ini(window._authUser?.memberNombre || window._authUser?.name || 'Yo'))}</button>
          <label class="sp-search">${ico('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>')}<input value="${esc(_q)}" placeholder="Buscar…" oninput="SpacesModule.setQ(this.value)"></label>
          <button type="button" class="btn btn--primary btn--sm sp-newt" onclick="SpacesModule.newTask()">＋ Tarea</button></div></div>`}
      <div class="sp-body" id="sp-body"></div>`;
    _paintBody();
  }
  function _paintBody() {
    const b = $q('sp-body'); if (!b) return; _fcc = null;
    if (_selProj && _cfg) { _colStop(); _paintCfg(); return; }
    _colStop();
    if (_view === 'formulario') { _paintForm(b); return; }
    if (_view === 'documento') { _paintDoc(b); return; }
    if (_view === 'pizarra') { _paintWb(b); return; }
    let all = _scope().filter(_passes);
    if (_view === 'panel') { _paintPanel(b, all); return; }
    if (!_showClosed) all = all.filter(t => _isOpen(t) || all.some(c => c.parent_task_id === t.id && _isOpen(c)));
    if (_view === 'tablero') { _paintBoard(b, all); try { TimerModule.syncButtons(); } catch (_) {} return; }
    if (_view === 'calendario') { _paintCal(b, all); return; }
    if (_view === 'gantt') { _paintGantt(b, all); return; }
    if (_view === 'galeria') { _paintGal(b, all); return; }
    _paintList(b, all);
    try { TimerModule.syncButtons(); } catch (_) {}
  }
  function setView(v) { const vs = _viewsOf(_sk()), m = vs.find(x => x.tipo === v); if (m) selView(m.id); }


  // ═══ Edición SIMULTÁNEA de Documento y Pizarra ═══
  // El contenido se guarda por bloques (documento) o elementos (pizarra), cada uno con su id. Lo que escribes se envía en ~0,6 s y los cambios de los demás
  // llegan cada 2 s sin molestar lo que estás escribiendo: dos personas en partes distintas nunca se pisan; en el mismo bloque gana el último guardado.
  const _col = { rev: 0, timer: null, view: null, pend: { set: new Map(), del: new Set(), order: null }, sendT: null, sending: false, focus: '', apply: null, statusId: '' };
  const _myName = () => String(window._authUser?.memberNombre || window._authUser?.name || 'Alguien');
  const _clean = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '').replace(/javascript:/gi, '');
  const _uid = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const _setSt = t => { const e = $q(_col.statusId); if (e) e.textContent = t; };
  function _colStop() { if (_col.pend.set.size || _col.pend.del.size || _col.pend.order) _colFlush(); clearInterval(_col.timer); _col.timer = null; clearTimeout(_col.sendT); _col.view = null; _col.apply = null; }
  function _colStart(v, statusId, apply) {
    _colStop(); _col.view = v; _col.statusId = statusId; _col.apply = apply; _col.rev = (v.config && v.config.rev) || 0;
    _col.timer = setInterval(_colPoll, 2000);
  }
  const _dirtyIds = () => new Set([..._col.pend.set.keys(), ..._col.pend.del, _col.focus].filter(Boolean));
  async function _colPoll() {
    const v = _col.view; if (!v || document.hidden || _col.sending) return;
    if (!$q('sp-doc') && !$q('sp-wb')) { _colStop(); return; }   // saliste de la vista
    try {
      const r = await apiFetch(`${API}/mgmt/space-views/${v.id}/state?rev=${_col.rev}&name=${encodeURIComponent(_myName())}&focus=${encodeURIComponent(_col.focus || '')}`); if (!r.ok) return;
      const j = await r.json(); _paintPresence(j.editing || []);
      if (j.same) return;
      _col.rev = j.rev; v.config = j.config; if (_col.apply) _col.apply(j.config);
    } catch (_) {}
  }
  function _colQueue(setId, data, delId, order) {
    const p = _col.pend; if (setId) { p.set.set(setId, data); p.del.delete(setId); } if (delId) { p.del.add(delId); p.set.delete(delId); } if (order) p.order = order;
    _setSt('Guardando…'); clearTimeout(_col.sendT); _col.sendT = setTimeout(_colFlush, 600);
  }
  async function _colFlush() {
    const v = _col.view, p = _col.pend; if (!v || _col.sending || (!p.set.size && !p.del.size && !p.order)) return;
    _col.pend = { set: new Map(), del: new Set(), order: null }; _col.sending = true;
    try {
      const r = await apiFetch(`${API}/mgmt/space-views/${v.id}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [...p.set].map(([id, data]) => ({ id, data })), del: [...p.del], order: p.order, name: _myName() }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      const j = await r.json(); _col.rev = j.rev; v.config = j.config; _col.sending = false;
      if (_col.apply) _col.apply(j.config); _setSt(_col.pend.set.size || _col.pend.del.size ? 'Guardando…' : 'Guardado');
    } catch (e) {
      _col.sending = false; p.set.forEach((d, id) => { if (!_col.pend.set.has(id)) _col.pend.set.set(id, d); }); p.del.forEach(id => _col.pend.del.add(id)); if (p.order && !_col.pend.order) _col.pend.order = p.order;
      _setSt('No se pudo guardar · reintentando…'); clearTimeout(_col.sendT); _col.sendT = setTimeout(_colFlush, 3000);
    }
  }
  const _PCOL = ['#2F6BFF', '#E8920F', '#2E9E5B', '#D9534F', '#007AFF', '#0891B2'];
  const _pcol = n => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % _PCOL.length; return _PCOL[h]; };
  function _paintPresence(ed) {
    const el = $q('sp-pres'); if (el) el.innerHTML = ed.length ? ed.map(e => `<span class="sp-pr" style="--c:${_pcol(e.name)}"><i></i>${esc(e.name)}</span>`).join('') + '<em>también está aquí</em>' : '';
    document.querySelectorAll('[data-ed]').forEach(x => { x.removeAttribute('data-ed'); x.style.removeProperty('--ec'); });
    ed.forEach(e => { if (!e.focus) return; const t = document.querySelector(`[data-id="${CSS.escape(e.focus)}"]`); if (t) { t.setAttribute('data-ed', e.name); t.style.setProperty('--ec', _pcol(e.name)); } });
  }
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection(); const n = sel && sel.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); const b = el && el.closest && el.closest('#sp-doc .sp-blk, #sp-wb .sp-wbi');
    _col.focus = b ? b.dataset.id : '';
  });

  // ── Documento (por bloques, estilo ClickUp: menú «/», barra flotante, colores, insignias, menciones) ──
  // iconos del documento (SVG, no emojis)
  const _SVG = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const _DIC = {
    p: '<path d="M13 4v16M17 4v16M13 4H9.5a4.5 4.5 0 0 0 0 9H13"/>', todo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
    ul: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    ol: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2M4 14h2l-2 4h2"/>',
    quote: '<path d="M7 7h4v4c0 3-1 5-4 6M15 7h4v4c0 3-1 5-4 6"/>', code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>', ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    warn: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
    err: '<path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    vio: '<path d="M12 3l1.8 4.9 4.9 1.8-4.9 1.8L12 16.4l-1.8-4.9-4.9-1.8 4.9-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z"/>',
    hr: '<line x1="4" y1="12" x2="20" y2="12"/>', link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    eraser: '<path d="m7 21-4-4 10-10 7 7-6 6z"/><path d="M22 21H7"/>', at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  };
  const _DI = k => _SVG(_DIC[k]);
  const _DOC_T = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'todox', 'quote', 'code', 'hr', 'call-info', 'call-ok', 'call-warn', 'call-err', 'call-vio'];
  const _LISTY = ['ul', 'ol', 'todo', 'todox', 'quote', 'call-info', 'call-ok', 'call-warn', 'call-err', 'call-vio'];
  const _TXT = [['#1F1D1B', 'Predeterminado'], ['#D12F34', 'Rojo'], ['#E5600F', 'Naranja'], ['#B88700', 'Amarillo'], ['#2E6BE5', 'Azul'], ['#8147C0', 'Violeta'], ['#C73A93', 'Rosa'], ['#278A5B', 'Verde'], ['#757780', 'Gris']];
  const _HLT = [['#FDE3E3', 'Rojo'], ['#FFE6D2', 'Naranja'], ['#FFF2B3', 'Amarillo'], ['#DCEAFF', 'Azul'], ['#EBDEFA', 'Violeta'], ['#FBDDEF', 'Rosa'], ['#D9F2E3', 'Verde'], ['#ECECEF', 'Gris']];
  const _BDG = [['red', 'roja'], ['orange', 'naranja'], ['yellow', 'amarilla'], ['blue', 'azul'], ['violet', 'violeta'], ['pink', 'rosa'], ['green', 'verde'], ['gray', 'gris']];
  const _blkHtml = (b, n) => `<div class="sp-blk sp-blk--${b.t}" data-id="${esc(b.id)}" data-t="${b.t}"${b.t === 'ol' ? ` data-n="${n}"` : ''}${b.t === 'hr' ? ' contenteditable="false"' : ''}>${b.t === 'hr' ? '<br>' : (_clean(b.html) || '<br>')}</div>`;
  let _docLast = new Map(), _docOrder = '';
  function _setT(el, t) { el.dataset.t = t; el.className = 'sp-blk sp-blk--' + t; if (t === 'hr') { el.setAttribute('contenteditable', 'false'); el.innerHTML = '<br>'; } else el.removeAttribute('contenteditable'); }
  function _numberOl() { let n = 0; document.querySelectorAll('#sp-doc > .sp-blk').forEach(x => { if (x.dataset.t === 'ol') { n++; x.dataset.n = n; } else n = 0; }); }
  function _docNorm() {
    const ed = $q('sp-doc'); if (!ed) return;
    const seen = new Set();
    [...ed.childNodes].forEach(n => { if (n.nodeType === 3 || (n.nodeType === 1 && !/^(DIV|P|H1|H2|LI)$/.test(n.tagName))) { const d = document.createElement('div'); n.replaceWith(d); d.appendChild(n); } });
    [...ed.children].forEach(c => {
      if (c.tagName !== 'DIV') { const d = document.createElement('div'); d.innerHTML = c.innerHTML; c.replaceWith(d); c = d; }
      const t = _DOC_T.includes(c.dataset.t) ? c.dataset.t : 'p'; c.dataset.t = t;
      c.className = 'sp-blk sp-blk--' + t;
      if (!c.dataset.id || seen.has(c.dataset.id)) c.dataset.id = _uid();
      seen.add(c.dataset.id); if (!c.innerHTML.trim()) c.innerHTML = '<br>';
    });
    if (!ed.children.length) ed.innerHTML = _blkHtml({ id: _uid(), t: 'p', html: '' }, 1);
    _numberOl();
  }
  function _docSync() {
    const ed = $q('sp-doc'); if (!ed) return;
    _docNorm();
    const blocks = [...ed.children].map(c => ({ id: c.dataset.id, t: c.dataset.t, html: c.dataset.t === 'hr' ? '' : (c.innerHTML === '<br>' ? '' : c.innerHTML) })), ids = blocks.map(x => x.id), order = ids.join(',');
    let any = false;
    blocks.forEach(x => { const k = x.t + '|' + x.html; if (_docLast.get(x.id) !== k) { _colQueue(x.id, { t: x.t, html: x.html }); _docLast.set(x.id, k); any = true; } });
    [..._docLast.keys()].forEach(id => { if (!ids.includes(id)) { _docLast.delete(id); _colQueue(null, null, id); any = true; } });
    if (order !== _docOrder) { _docOrder = order; _colQueue(null, null, null, ids); any = true; }
    if (!any) return;
  }
  function _docApply(cfg) {
    const ed = $q('sp-doc'); if (!ed) return; const dirty = _dirtyIds(), want = cfg.blocks || [];
    want.forEach((b, i) => {
      let el = ed.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
      if (!el) { const tmp = document.createElement('div'); tmp.innerHTML = _blkHtml(b, 1); el = tmp.firstChild; ed.insertBefore(el, ed.children[i] || null); }
      else if (!dirty.has(b.id)) {
        if (el.dataset.t !== b.t) _setT(el, b.t);
        if (b.t !== 'hr') { const cur = el.innerHTML === '<br>' ? '' : el.innerHTML, nh = _clean(b.html); if (cur !== nh) el.innerHTML = nh || '<br>'; }
        if (ed.children[i] !== el && !dirty.has(b.id)) ed.insertBefore(el, ed.children[i] || null);
      }
      if (!dirty.has(b.id)) _docLast.set(b.id, b.t + '|' + (b.t === 'hr' ? '' : (b.html || '')));
    });
    const ids = new Set(want.map(b => b.id)); [...ed.children].forEach(c => { if (!ids.has(c.dataset.id) && !dirty.has(c.dataset.id)) { c.remove(); _docLast.delete(c.dataset.id); } });
    _numberOl(); _docOrder = [...ed.children].map(c => c.dataset.id).join(',');
  }

  // menú «/» (bloques, formato, colores, insignias) y «@» (menciones)
  const _nr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const _ESC = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function _slashItems() {
    const T = (t, l, ic, kw) => ({ g: 'Texto', l, ic, kw, run: () => _applyType(t) });
    const SV = (it, k) => (it.svg = _DI(k), it);
    const C = (t, l, ic, kw) => ({ g: 'Banners', l, ic, kw: 'banner callout ' + kw, run: () => _applyType(t) });
    const F = (g, l, ic, kw, run) => ({ g, l, ic, kw, run });
    return [
      SV(T('p', 'Texto normal', '', 'parrafo texto'), 'p'), T('h1', 'Título 1', 'H1', 'titulo encabezado'), T('h2', 'Título 2', 'H2', 'subtitulo'), T('h3', 'Título 3', 'H3', 'subtitulo'),
      SV(T('todo', 'Lista de control', '', 'checklist tareas pendientes casilla'), 'todo'), SV(T('ul', 'Lista con viñetas', '', 'bullets'), 'ul'), SV(T('ol', 'Lista numerada', '', 'numeros'), 'ol'), SV(T('quote', 'Cita', '', 'bloque cita quote'), 'quote'), SV(T('code', 'Bloque de código', '', 'codigo code'), 'code'),
      SV(C('call-info', 'Banner informativo', '', 'info azul'), 'info'), SV(C('call-ok', 'Banner de éxito', '', 'exito verde'), 'ok'), SV(C('call-warn', 'Banner de aviso', '', 'aviso amarillo'), 'warn'), SV(C('call-err', 'Banner de alerta', '', 'alerta peligro rojo'), 'err'), SV(C('call-vio', 'Banner violeta', '', 'nota violeta'), 'vio'),
      SV(F('Avanzado', 'Divisor', '', 'linea separador', () => _applyType('hr')), 'hr'),
      SV(F('Avanzado', 'Mencionar a una persona', '', 'persona mencion arroba', () => _openMenu('mention', '')), 'at'),
      F('Formato', 'Negrita', 'B', 'bold', () => docCmd('bold')), F('Formato', 'Cursiva', 'I', 'italic', () => docCmd('italic')), F('Formato', 'Tachado', 'S', 'strike', () => docCmd('strikeThrough')),
      SV(F('Formato', 'Código insertado', '', 'inline code', () => docCmd('icode')), 'code'), SV(F('Formato', 'Vínculo de sitio web', '', 'enlace link url', () => docCmd('link')), 'link'), SV(F('Formato', 'Borrar formato', '', 'limpiar quitar', () => docCmd('removeFormat')), 'eraser'),
      ..._TXT.map(([c, n]) => ({ g: 'Colores del texto', l: n, ic: 'A', ic_c: c, kw: 'color texto ' + n, run: () => docCmd('fc:' + c) })),
      ..._HLT.map(([c, n]) => ({ g: 'Resaltados', l: 'Resaltado ' + n.toLowerCase(), ic: 'A', ic_bg: c, kw: 'resaltado destacado fondo ' + n, run: () => docCmd('bg:' + c) })),
      ..._BDG.map(([k, n]) => ({ g: 'Insignias', l: 'Insignia ' + n, ic: '●', ic_b: k, kw: 'insignia etiqueta badge ' + n, run: () => docCmd('bdg:' + k) })),
      ..._BDG.map(([k, n]) => ({ g: 'Insignias', l: 'Insignia ' + n + ' fuerte', ic: '●', ic_b: k + ' sp-bdg--s', kw: 'insignia etiqueta badge fuerte ' + n, run: () => docCmd('bdg:' + k + ' sp-bdg--s') })),
    ];
  }
  const _sl = { open: false, mode: 'slash', items: [], all: [], sel: 0, q: '', el: null };
  function _caretRect() { const sel = getSelection(); if (!sel.rangeCount) return null; const r = sel.getRangeAt(0).cloneRange(); r.collapse(true); let b = r.getBoundingClientRect(); if (!b.width && !b.height) { const cur = _curBlock(); if (cur) b = cur.getBoundingClientRect(); } return b; }
  function _openMenu(mode, q) {
    _sl.mode = mode; _sl.q = q;
    _sl.all = mode === 'mention' ? [...new Set(_team.map(x => x.nombre).filter(Boolean))].map(n => ({ g: 'Personas', l: n, ic: _ini(n), kw: n, run: () => docCmd('men:' + n) })) : _slashItems();
    _menuFilter(); if (!_sl.items.length) { _closeMenu(); return; }
    if (!_sl.el) { _sl.el = document.createElement('div'); _sl.el.id = 'sp-slash'; _sl.el.className = 'sp-slash'; document.body.appendChild(_sl.el); _sl.el.addEventListener('mousedown', e => e.preventDefault()); }
    _sl.open = true; _menuPaint(); _menuPlace();
  }
  function _menuFilter() { const q = _nr(_sl.q); _sl.items = q ? _sl.all.filter(i => _nr(i.l + ' ' + (i.kw || '')).includes(q)) : _sl.all; if (_sl.sel >= _sl.items.length) _sl.sel = 0; }
  function _menuPaint() {
    const el = _sl.el; if (!el) return; let g = '', h = '';
    _sl.items.forEach((it, i) => {
      if (it.g !== g) { g = it.g; h += `<div class="sp-slash__g">${esc(g)}</div>`; }
      const icst = it.ic_c ? `color:${it.ic_c};font-weight:800` : it.ic_bg ? `background:${it.ic_bg}` : '';
      const ic = it.ic_b ? `<i class="sp-slash__i"><span class="sp-bdg sp-bdg--${it.ic_b}" style="padding:0 5px">Ab</span></i>` : `<i class="sp-slash__i" style="${icst}">${it.svg || esc(it.ic)}</i>`;
      h += `<button type="button" class="sp-slash__r${i === _sl.sel ? ' on' : ''}" data-i="${i}" onclick="SpacesModule.slashPick(${i})" onmousemove="SpacesModule.slashHover(${i})">${ic}<span>${esc(it.l)}</span></button>`;
    });
    el.innerHTML = h || '<div class="sp-slash__g">Sin resultados</div>'; const on = el.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function _menuPlace() {
    const el = _sl.el, r = _caretRect(); if (!el || !r) return; const w = 300, x = Math.min(r.left, innerWidth - w - 12);
    const below = innerHeight - r.bottom - 16, above = r.top - 16, down = below >= 260 || below >= above, room = Math.max(120, Math.min(360, down ? below : above));
    el.style.maxHeight = room + 'px'; el.style.left = Math.max(10, x) + 'px';
    el.style.top = (down ? r.bottom + 6 : Math.max(10, r.top - el.offsetHeight - 6)) + 'px';
  }
  function _closeMenu() { _sl.open = false; if (_sl.el) { _sl.el.remove(); _sl.el = null; } }
  function slashHover(i) { if (_sl.sel === i) return; _sl.sel = i; const el = _sl.el; if (el) el.querySelectorAll('.sp-slash__r').forEach((b, k) => b.classList.toggle('on', k === i)); }
  function slashPick(i) {
    const it = _sl.items[i]; if (!it) return;
    const mode = _sl.mode, q = _sl.q; _closeMenu(); _delTrigger(mode === 'mention' ? '@' : '/', q); it.run(); _docSync();
  }
  // borra el «/texto» o «@texto» escrito para abrir el menú
  function _delTrigger(ch, q) {
    const sel = getSelection(); if (!sel.rangeCount) return; const n = sel.anchorNode, off = sel.anchorOffset; if (!n || n.nodeType !== 3) return;
    const before = n.textContent.slice(0, off), i = before.lastIndexOf(ch + q); if (i < 0) return;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ch.length + q.length); r.deleteContents(); sel.removeAllRanges(); sel.addRange(r);
  }
  function _slashCheck() {
    const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) { if (_sl.open) _closeMenu(); return; }
    const n = sel.anchorNode; if (!n || n.nodeType !== 3 || !$q('sp-doc') || !$q('sp-doc').contains(n)) { if (_sl.open) _closeMenu(); return; }
    const before = n.textContent.slice(0, sel.anchorOffset), m = before.match(/(?:^|\s)\/([^\/\n]{0,24})$/), a = before.match(/(?:^|\s)@([^@\n]{0,24})$/);
    if (m) { _sl.sel = _sl.open && _sl.mode === 'slash' ? _sl.sel : 0; _openMenu('slash', m[1]); }
    else if (a) { _sl.sel = _sl.open && _sl.mode === 'mention' ? _sl.sel : 0; _openMenu('mention', a[1]); }
    else if (_sl.open) _closeMenu();
  }
  function _applyType(t) {
    const cur = _curBlock(); if (!cur) return;
    if (t === 'hr') { _setT(cur, 'hr'); const p = document.createElement('div'); p.dataset.id = _uid(); p.dataset.t = 'p'; p.className = 'sp-blk sp-blk--p'; p.innerHTML = '<br>'; cur.after(p); const r = document.createRange(); r.setStart(p, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
    const same = cur.dataset.t === t && t !== 'p';
    _setT(cur, same ? 'p' : t);
    if (!cur.innerHTML.trim()) cur.innerHTML = '<br>';
  }

  // barra flotante al seleccionar texto
  function _bubUpdate() {
    const ed = $q('sp-doc'), sel = getSelection(); let bub = $q('sp-bub');
    const ok = ed && sel.rangeCount && !sel.isCollapsed && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode);
    if (!ok) { if (bub) bub.style.display = 'none'; return; }
    if (!bub) return; const r = sel.getRangeAt(0).getBoundingClientRect(); if (!r.width && !r.height) { bub.style.display = 'none'; return; }
    bub.style.display = 'flex'; const w = bub.offsetWidth || 300; bub.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'; bub.style.top = Math.max(8, r.top - 44) + 'px';
  }
  document.addEventListener('selectionchange', _bubUpdate);
  document.addEventListener('scroll', () => { if (_sl.open) _closeMenu(); const b = $q('sp-bub'); if (b) b.style.display = 'none'; }, true);

  function _paintDoc(b) {
    const v = _curView(); if (v.virtual) { b.innerHTML = '<div class="sp-e sp-e--c">Añade un documento con «＋ Vista».</div>'; return; }
    const btn = (c, l, t, x) => `<button type="button" class="sp-dtb${x ? ' ' + x : ''}" title="${t}" onmousedown="event.preventDefault();SpacesModule.docCmd('${c}')">${l}</button>`;
    const pal = (k, t, l) => `<button type="button" class="sp-dtb" title="${t}" onmousedown="event.preventDefault();SpacesModule.docColor('${k}',this)">${l}</button>`;
    const cfg = v.config && Array.isArray(v.config.blocks) ? v.config : { blocks: [{ id: 'b0', t: 'p', html: (v.config && typeof v.config.html === 'string') ? v.config.html : '' }], rev: (v.config && v.config.rev) || 0 };
    const inline = `${btn('bold', '<b>B</b>', 'Negrita')}${btn('italic', '<i>I</i>', 'Cursiva')}${btn('underline', '<u>U</u>', 'Subrayado')}${btn('strikeThrough', '<s>S</s>', 'Tachado')}${btn('icode', _DI('code'), 'Código insertado')}${btn('link', _DI('link'), 'Enlace')}${pal('fc', 'Color del texto', '<span style="border-bottom:3px solid #E5600F;line-height:1">A</span>')}${pal('bg', 'Resaltado', '<span style="background:#FFF2B3;padding:0 4px">A</span>')}${pal('bdg', 'Insignia', '<span class="sp-bdg sp-bdg--blue" style="padding:0 5px;font-size:.7rem">Ab</span>')}`;
    b.innerHTML = `<div class="sp-docw"><div class="sp-dtbar">${btn('t:h1', 'H1', 'Título 1')}${btn('t:h2', 'H2', 'Título 2')}${btn('t:h3', 'H3', 'Título 3')}${btn('t:p', _DI('p'), 'Texto normal')}<span class="sp-dtbar__s"></span>${btn('t:ul', _DI('ul'), 'Lista con viñetas')}${btn('t:ol', _DI('ol'), 'Lista numerada')}${btn('t:todo', _DI('todo'), 'Lista de control')}${btn('t:quote', _DI('quote'), 'Cita')}${btn('t:code', _DI('code'), 'Bloque de código')}${btn('t:call-info', _DI('info'), 'Banner')}${btn('t:hr', _DI('hr'), 'Divisor')}<span class="sp-dtbar__s"></span>${inline}${btn('removeFormat', _DI('eraser'), 'Quitar formato')}<span class="sp-pres" id="sp-pres"></span><span class="sp-dtbar__st" id="sp-doc-st">Guardado</span></div>
      <div class="sp-dpage"><input class="sp-dtitle" id="sp-dtitle" value="${esc(v.nombre && v.nombre !== 'Documento' ? v.nombre : '')}" placeholder="Documento sin título" maxlength="120" onchange="SpacesModule.docTitle(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('sp-doc').focus();}">
        <div class="sp-dhint">Escribe <kbd>/</kbd> para insertar bloques, <kbd>@</kbd> para mencionar a alguien</div>
        <div class="sp-doc" id="sp-doc" contenteditable="true" spellcheck="true">${cfg.blocks.map((x, i) => _blkHtml(x, i + 1)).join('')}</div></div>
      <div class="sp-bub" id="sp-bub" style="display:none">${inline}</div></div>`;
    v.config = cfg; _docLast = new Map(cfg.blocks.map(x => [x.id, x.t + '|' + (x.t === 'hr' ? '' : (x.html || ''))])); _docOrder = cfg.blocks.map(x => x.id).join(','); _numberOl();
    const ed = $q('sp-doc');
    ed.addEventListener('input', () => { _docSync(); _slashCheck(); });
    ed.addEventListener('blur', () => setTimeout(() => { if (_sl.open && document.activeElement !== ed) _closeMenu(); }, 120));
    ed.addEventListener('click', e => {
      const bl = e.target.closest && e.target.closest('.sp-blk'); if (!bl) return;
      if (/^todox?$/.test(bl.dataset.t) && e.clientX - bl.getBoundingClientRect().left < 28) { _setT(bl, bl.dataset.t === 'todo' ? 'todox' : 'todo'); _docSync(); }
    });
    ed.addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text/plain'); if (t == null) return; e.preventDefault(); document.execCommand('insertText', false, t); });
    ed.addEventListener('keydown', e => {
      if (_sl.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); _sl.sel = (_sl.sel + (e.key === 'ArrowDown' ? 1 : -1) + _sl.items.length) % _sl.items.length; _menuPaint(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashPick(_sl.sel); return; }
        if (e.key === 'Escape') { e.preventDefault(); _closeMenu(); return; }
      }
      const cur = _curBlock(); if (!cur) return; const t = cur.dataset.t;
      if (e.key === 'Enter' && !e.shiftKey && _LISTY.includes(t) && !cur.textContent.trim()) { e.preventDefault(); _setT(cur, 'p'); cur.innerHTML = '<br>'; _docSync(); return; }
      if (e.key === 'Enter' && !e.shiftKey && t === 'code') {
        e.preventDefault();
        const sel = getSelection(), rr = sel.getRangeAt(0).cloneRange(); rr.selectNodeContents(cur); rr.setStart(sel.anchorNode, sel.anchorOffset);
        if (!rr.toString().length && /\n$/.test(cur.textContent)) {           // línea en blanco al final + Enter = salir del bloque de código
          cur.textContent = cur.textContent.replace(/\n+$/, ''); const p = document.createElement('div'); p.dataset.id = _uid(); p.dataset.t = 'p'; p.className = 'sp-blk sp-blk--p'; p.innerHTML = '<br>'; cur.after(p);
          const r2 = document.createRange(); r2.setStart(p, 0); r2.collapse(true); sel.removeAllRanges(); sel.addRange(r2); _docSync(); return;
        }
        document.execCommand('insertText', false, '\n'); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && /^h[123]$/.test(t)) setTimeout(() => { const c2 = _curBlock(); if (c2 && c2 !== cur && /^h/.test(c2.dataset.t)) { _setT(c2, 'p'); _docSync(); } }, 0);
      if (e.key === 'Enter' && !e.shiftKey && t === 'todox') setTimeout(() => { const c2 = _curBlock(); if (c2 && c2 !== cur && c2.dataset.t === 'todox') { _setT(c2, 'todo'); _docSync(); } }, 0);
      if (e.key === 'Backspace' && t !== 'p' && t !== 'hr') { const sel = getSelection(); if (sel && sel.isCollapsed) { const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(cur); r.setEnd(sel.anchorNode, sel.anchorOffset); if (!r.toString().length) { e.preventDefault(); _setT(cur, 'p'); if (!cur.innerHTML.trim()) cur.innerHTML = '<br>'; _docSync(); } } }
    });
    _colStart(v, 'sp-doc-st', _docApply); _colPoll();
  }
  function _curBlock() { const sel = getSelection(); const n = sel && sel.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && el.closest ? el.closest('#sp-doc > .sp-blk') : null; }
  function docCmd(c) {
    const ed = $q('sp-doc'); if (!ed) return; ed.focus();
    if (c.startsWith('t:')) { const cur = _curBlock(); if (!cur) return; const t = c.slice(2); if (t === 'hr') _applyType('hr'); else _applyType(t); }
    else if (c === 'link') { const u = prompt('Dirección del enlace (https://…)'); if (u && /^https?:\/\//i.test(u)) document.execCommand('createLink', false, u); }
    else if (c === 'icode') { const s = String(getSelection()); document.execCommand('insertHTML', false, `<code>${_ESC(s || 'código')}</code>&#8203;`); }
    else if (c.startsWith('fc:')) document.execCommand('foreColor', false, c.slice(3));
    else if (c.startsWith('bg:')) document.execCommand('hiliteColor', false, c.slice(3));
    else if (c.startsWith('bdg:')) { const s = String(getSelection()); document.execCommand('insertHTML', false, `<span class="sp-bdg sp-bdg--${c.slice(4)}">${_ESC(s || 'Insignia')}</span>&#8203;`); }
    else if (c.startsWith('men:')) document.execCommand('insertHTML', false, `<span class="sp-men">@${_ESC(c.slice(4))}</span>&nbsp;`);
    else document.execCommand(c, false, null);
    _docSync(); _bubUpdate();
  }
  // selector de colores (texto, resaltado e insignias)
  function docColor(kind, anchor) {
    const sw = kind === 'fc' ? _TXT.map(([c, n]) => `<button type="button" class="sp-sw" title="${n}" style="background:${c}" onmousedown="event.preventDefault();SpacesModule.docColorSet('fc:${c}')"></button>`).join('')
      : kind === 'bg' ? _HLT.map(([c, n]) => `<button type="button" class="sp-sw" title="${n}" style="background:${c};box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)" onmousedown="event.preventDefault();SpacesModule.docColorSet('bg:${c}')"></button>`).join('') + `<button type="button" class="sp-sw sp-sw--x" title="Quitar resaltado" onmousedown="event.preventDefault();SpacesModule.docColorSet('bg:transparent')">✕</button>`
      : _BDG.map(([k, n]) => `<button type="button" class="sp-sw sp-sw--b" title="Insignia ${n}" onmousedown="event.preventDefault();SpacesModule.docColorSet('bdg:${k}')"><span class="sp-bdg sp-bdg--${k}">Ab</span></button>`).join('') + _BDG.map(([k, n]) => `<button type="button" class="sp-sw sp-sw--b" title="Insignia ${n} fuerte" onmousedown="event.preventDefault();SpacesModule.docColorSet('bdg:${k} sp-bdg--s')"><span class="sp-bdg sp-bdg--${k} sp-bdg--s">Ab</span></button>`).join('');
    _openPop(anchor, `<div class="sp-sws">${sw}</div>`, 'sp-pop--w');
  }
  function docColorSet(c) { _closePop(); docCmd(c); }
  async function docTitle(val) {
    const v = _curView(); if (!v || v.virtual) return; const nm = String(val || '').trim() || 'Documento';
    try { const r = await apiFetch(`${API}/mgmt/space-views/${v.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: nm }) }); if (r.ok) { v.nombre = nm; const t = document.querySelector('.sp-tab--v.on'); if (t) t.title = nm; } } catch (_) { showBanner('No se pudo guardar el título', 'error'); }
  }

  // ── Pizarra (elementos que se arrastran) ──
  const _WB_COL = ['#FFF3A8', '#BFE3FF', '#C8F0CF', '#FFD0D8', '#E0D0FF'];
  const _wbItem = it => `<div class="sp-wbi sp-wbi--${it.t}" data-id="${esc(it.id)}" style="left:${it.x}px;top:${it.y}px;${it.t === 'nota' ? 'background:' + esc(it.color || '#FFF3A8') : ''}"><div class="sp-wbi__h"><span>${it.t === 'nota' ? '' : 'Texto'}</span><button type="button" title="Quitar" onclick="SpacesModule.wbDel('${esc(it.id)}')">✕</button></div><div class="sp-wbi__t" contenteditable="true" spellcheck="true">${esc(it.text || '')}</div></div>`;
  let _wbItems = [];
  const _wbData = it => ({ t: it.t, x: it.x, y: it.y, color: it.color || '', text: it.text || '' });
  function _wbApply(cfg) {
    const cv = $q('sp-wb'); if (!cv) return; const dirty = _dirtyIds(), want = cfg.items || [];
    want.forEach(it => {
      let el = cv.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
      if (!el) { cv.insertAdjacentHTML('beforeend', _wbItem(it)); }
      else if (!dirty.has(it.id) && !el.classList.contains('is-drag')) {
        el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; if (it.t === 'nota') el.style.background = it.color || '#FFF3A8';
        const tx = el.querySelector('.sp-wbi__t'); if (tx && tx.innerText !== (it.text || '')) tx.textContent = it.text || '';
      }
    });
    const ids = new Set(want.map(x => x.id)); [...cv.querySelectorAll('.sp-wbi')].forEach(el => { if (!ids.has(el.dataset.id) && !dirty.has(el.dataset.id)) el.remove(); });
    _wbItems = want.map(x => ({ ...x }));
  }
  function _paintWb(b) {
    const v = _curView(); if (v.virtual) { b.innerHTML = '<div class="sp-e sp-e--c">Añade una pizarra con «＋ Vista».</div>'; return; }
    const cfg = v.config && Array.isArray(v.config.items) ? v.config : { items: [], rev: (v.config && v.config.rev) || 0 }; v.config = cfg; _wbItems = cfg.items.map(x => ({ ...x }));
    b.innerHTML = `<div class="sp-wbw"><div class="sp-wbbar"><span>Añadir</span>${_WB_COL.map(c => `<button type="button" class="sp-wbn" style="background:${c}" title="Nota" onclick="SpacesModule.wbAdd('nota','${c}')"></button>`).join('')}<button type="button" class="sp-chip" onclick="SpacesModule.wbAdd('texto','')">＋ Texto</button><span class="sp-pres" id="sp-pres"></span><span class="sp-dtbar__st" id="sp-wb-st">✓ Guardado</span></div>
      <div class="sp-wbc" id="sp-wb">${cfg.items.map(_wbItem).join('')}</div></div>`;
    const cv = $q('sp-wb');
    cv.addEventListener('input', e => { const el = e.target.closest('[data-id]'); if (!el) return; const it = _wbItems.find(x => x.id === el.dataset.id); if (it) { it.text = e.target.innerText; _colQueue(it.id, _wbData(it)); } });
    cv.addEventListener('mousedown', e => {
      const h = e.target.closest('.sp-wbi__h'); if (!h || e.target.closest('button')) return;
      const el = h.closest('[data-id]'), it = _wbItems.find(x => x.id === el.dataset.id); if (!it) return;
      const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y; el.classList.add('is-drag'); _col.focus = it.id;
      const mv = ev => { it.x = Math.max(0, ox + ev.clientX - sx); it.y = Math.max(0, oy + ev.clientY - sy); el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); el.classList.remove('is-drag'); _colQueue(it.id, _wbData(it)); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); e.preventDefault();
    });
    _colStart(v, 'sp-wb-st', _wbApply); _colPoll();
  }
  function wbAdd(t, color) {
    const cv = $q('sp-wb'); if (!cv) return; const n = _wbItems.length;
    const it = { id: _uid(), t, x: 30 + (n % 6) * 40 + Math.floor(n / 6) * 20, y: 30 + (n % 6) * 30, color: color || '', text: '' };
    _wbItems.push(it); cv.insertAdjacentHTML('beforeend', _wbItem(it)); _colQueue(it.id, _wbData(it));
    const el = cv.querySelector(`[data-id="${it.id}"] .sp-wbi__t`); if (el) el.focus();
  }
  function wbDel(id) { _wbItems = _wbItems.filter(x => x.id !== id); const el = $q('sp-wb') && $q('sp-wb').querySelector(`[data-id="${CSS.escape(id)}"]`); if (el) el.remove(); _colQueue(null, null, id); }

  // ── calendario del espacio: tareas en su fecha límite ──
  function calNav(d) { const r = _calRef || new Date(); _calRef = d === 0 ? new Date() : new Date(r.getFullYear(), r.getMonth() + d, 1); _paintBody(); }
  function _paintCal(b, all) {
    const ref = _calRef || new Date(), y = ref.getFullYear(), mo = ref.getMonth();
    const startDow = (new Date(y, mo, 1).getDay() + 6) % 7, dim = new Date(y, mo + 1, 0).getDate(), td = _today();
    const by = {}; let sinFecha = 0;
    all.forEach(t => { const d = _d10(t.deadline); if (!d) { sinFecha++; return; } (by[d] = by[d] || []).push(t); });
    const wd = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'], total = Math.ceil((startDow + dim) / 7) * 7;
    let cells = '';
    for (let i = 0; i < total; i++) {
      const n = i - startDow + 1;
      if (n < 1 || n > dim) { cells += '<div class="sp-cal__c sp-cal__c--out"></div>'; continue; }
      const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`, ts = (by[key] || []).sort((a, c) => a.id - c.id);
      const chip = t => { const e = _EST[t.estado || 'pendiente'] || _EST.pendiente; return `<button type="button" class="sp-cal__t" style="--c:${e[2]}" title="${esc(t.titulo)}${t.project_nombre ? ' · ' + esc(t.project_nombre) : ''}" onclick="openTaskAnywhere(${t.id})"><i></i>${esc(t.titulo)}</button>`; };
      cells += `<div class="sp-cal__c${key === td ? ' is-today' : ''}${key < td ? ' is-past' : ''}"><div class="sp-cal__n">${n}</div>${ts.slice(0, 3).map(chip).join('')}${ts.length > 3 ? `<button type="button" class="sp-cal__m" onclick="this.parentNode.querySelectorAll('.sp-cal__x').forEach(e=>e.hidden=false);this.remove()">+${ts.length - 3} más</button>${ts.slice(3).map(t => chip(t).replace('class="sp-cal__t"', 'class="sp-cal__t sp-cal__x" hidden')).join('')}` : ''}</div>`;
    }
    b.innerHTML = `<div class="sp-cal"><div class="sp-cal__hd"><b>${ref.toLocaleDateString('es', { month: 'long', year: 'numeric' })}</b><span><button class="sp-chip" onclick="SpacesModule.calNav(-1)">‹</button><button class="sp-chip" onclick="SpacesModule.calNav(0)">Hoy</button><button class="sp-chip" onclick="SpacesModule.calNav(1)">›</button></span>${sinFecha ? `<em>${sinFecha} tarea${sinFecha === 1 ? '' : 's'} sin fecha límite</em>` : ''}</div>
      <div class="sp-cal__g">${wd.map(w => `<div class="sp-cal__w">${w}</div>`).join('')}${cells}</div></div>`;
  }

  // ── Gantt: barras de inicio a fecha límite, agrupadas por lista (proyecto) ──
  function ganttScale(v) { _ganttScale = v; _paintBody(); }
  function _paintGantt(b, all) {
    const mains = all.filter(t => !t.parent_task_id), dd = x => _d10(x), DAY = 864e5;
    const ts = mains.map(t => { const s0 = dd(t.fecha_inicio) || dd(t.deadline), e0 = dd(t.deadline) || dd(t.fecha_inicio); return { t, s: s0 ? new Date(s0 + 'T00:00:00') : null, e: e0 ? new Date(e0 + 'T00:00:00') : null }; });
    const dated = ts.filter(x => x.s && x.e), und = ts.filter(x => !(x.s && x.e));
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let min = new Date(Math.min(now, ...dated.map(x => x.s))), max = new Date(Math.max(+now + 21 * DAY, ...dated.map(x => x.e)));
    min = new Date(+min - 3 * DAY); max = new Date(+max + 7 * DAY);
    const dw = { dia: 34, semana: 15, mes: 5 }[_ganttScale], days = Math.round((max - min) / DAY) + 1, W = days * dw, off = d => Math.round((d - min) / DAY) * dw;
    // cabecera: meses arriba, días/semanas abajo
    let months = '', labels = '';
    for (let i = 0, cur = null, st = 0; i <= days; i++) {
      const d = new Date(+min + i * DAY), key = i < days ? d.getFullYear() + '-' + d.getMonth() : null;
      if (key !== cur) { if (cur !== null) months += `<div class="sp-gt__mo" style="left:${st * dw}px;width:${(i - st) * dw}px">${new Date(+min + st * DAY).toLocaleDateString('es', { month: 'long', year: 'numeric' })}</div>`; cur = key; st = i; }
    }
    for (let i = 0; i < days; i++) { const d = new Date(+min + i * DAY); if (_ganttScale === 'dia') labels += `<div class="sp-gt__d${d.getDay() % 6 === 0 ? ' we' : ''}" style="left:${i * dw}px;width:${dw}px">${d.getDate()}</div>`; else if (_ganttScale === 'semana' && d.getDay() === 1) labels += `<div class="sp-gt__d" style="left:${i * dw}px;width:${7 * dw}px">${d.getDate()}/${d.getMonth() + 1}</div>`; }
    const byProj = new Map(); dated.sort((a, c) => a.s - c.s).forEach(x => { const k = x.t.project_nombre || 'Sin lista'; if (!byProj.has(k)) byProj.set(k, []); byProj.get(k).push(x); });
    const bar = x => { const e = _EST[x.t.estado || 'pendiente'] || _EST.pendiente, w = Math.max(dw, off(x.e) - off(x.s) + dw); return `<div class="sp-gt__r"><div class="sp-gt__nm" title="${esc(x.t.titulo)}" onclick="openTaskAnywhere(${x.t.id})"><i style="background:${e[2]}"></i>${esc(x.t.titulo)}</div><div class="sp-gt__tl" style="width:${W}px"><button type="button" class="sp-gt__b" style="left:${off(x.s)}px;width:${w}px;background:${e[2]}" title="${esc(x.t.titulo)} · ${_fmtD(dd(x.t.fecha_inicio) || dd(x.t.deadline))} → ${_fmtD(dd(x.t.deadline) || dd(x.t.fecha_inicio))}" onclick="openTaskAnywhere(${x.t.id})">${w > 90 ? esc(x.t.titulo) : ''}</button></div></div>`; };
    const groups = [...byProj.entries()].map(([k, xs]) => `<div class="sp-gt__g"><div class="sp-gt__gh"><span>${esc(k)}</span><em>${xs.length}</em></div>${xs.map(bar).join('')}</div>`).join('');
    const todayX = off(now) + dw / 2;
    b.innerHTML = `<div class="sp-gt"><div class="sp-gt__bar"><span>Escala</span>${['dia', 'semana', 'mes'].map(k => `<button class="sp-chip${_ganttScale === k ? ' on' : ''}" onclick="SpacesModule.ganttScale('${k}')">${{ dia: 'Día', semana: 'Semana', mes: 'Mes' }[k]}</button>`).join('')}</div>
      ${dated.length ? `<div class="sp-gt__sc"><div class="sp-gt__in" style="min-width:${260 + W}px"><div class="sp-gt__hd"><div class="sp-gt__nm sp-gt__nm--h">Tarea</div><div class="sp-gt__tl" style="width:${W}px"><div class="sp-gt__m">${months}</div><div class="sp-gt__l">${labels}</div></div></div>
        <div class="sp-gt__body">${groups}<div class="sp-gt__today" style="left:${260 + todayX}px"></div></div></div></div>` : '<div class="sp-e sp-e--c">Ninguna tarea tiene fecha de inicio o límite todavía.</div>'}
      ${und.length ? `<div class="sp-gt__un"><b>Sin fechas (${und.length})</b>${und.slice(0, 12).map(x => `<button type="button" onclick="openTaskAnywhere(${x.t.id})">${esc(x.t.titulo)}</button>`).join('')}${und.length > 12 ? `<em>+${und.length - 12} más</em>` : ''}</div>` : ''}</div>`;
  }

  // ── galería: tarjetas ──
  function _paintGal(b, all) {
    const mains = all.filter(t => !t.parent_task_id).sort((a, c) => (_d10(a.deadline) || '9999').localeCompare(_d10(c.deadline) || '9999') || a.id - c.id);
    if (!mains.length) { b.innerHTML = '<div class="sp-e sp-e--c">No hay tareas que mostrar aquí.</div>'; return; }
    b.innerHTML = `<div class="sp-gal">${mains.map(t => {
      const e = _EST[t.estado || 'pendiente'] || _EST.pendiente, d = _d10(t.deadline), od = d && d < _today() && _isOpen(t), p = _PRIO[t.prioridad || 'media'], subs = all.filter(c => c.parent_task_id === t.id).length;
      return `<div class="sp-gal__c" onclick="openTaskAnywhere(${t.id})"><div class="sp-gal__s" style="background:${e[2]}"></div><div class="sp-gal__b"><span class="sp-est" style="--c:${e[2]}">${esc(e[1]).toUpperCase()}</span><div class="sp-gal__t">${esc(t.titulo)}</div><div class="sp-gal__m">${esc([t.project_nombre, t.client_nombre].filter(Boolean).join(' · '))}</div>
        <div class="sp-gal__f"><span>${p ? `<i class="sp-dot" style="background:${p[1]}"></i>${p[0]}` : ''}</span>${d ? `<span class="${od ? 'is-od' : ''}">${_fmtD(d)}</span>` : ''}${subs ? `<span>⑂ ${subs}</span>` : ''}<span class="sp-gal__av">${_resp(t).slice(0, 3).map(n => `<span class="sp-av" title="${esc(n)}">${esc(_ini(n))}</span>`).join('')}</span></div></div></div>`;
    }).join('')}</div>`;
  }

  // ── panel: métricas del espacio ──
  function _paintPanel(b, all) {
    const td = _today(), wk = new Date(); wk.setDate(wk.getDate() + 7); const wks = `${wk.getFullYear()}-${String(wk.getMonth() + 1).padStart(2, '0')}-${String(wk.getDate()).padStart(2, '0')}`;
    const mains = all.filter(t => !t.parent_task_id), open = mains.filter(_isOpen), dd = t => _d10(t.deadline);
    const venc = open.filter(t => dd(t) && dd(t) < td), hoy = open.filter(t => dd(t) === td), prox = open.filter(t => dd(t) > td && dd(t) <= wks), hechas = mains.filter(t => t.estado === 'completado');
    const kpi = (l, n, c) => `<div class="sp-dk"><span>${l}</span><b style="${c ? 'color:' + c : ''}">${n}</b></div>`;
    const bars = (rows, color) => { const mx = Math.max(1, ...rows.map(r => r[1])); return rows.length ? rows.map(r => `<div class="sp-db"><span title="${esc(r[0])}">${esc(r[0])}</span><div><i style="width:${Math.round(r[1] * 100 / mx)}%;background:${r[2] || color}"></i></div><em>${r[1]}</em></div>`).join('') : '<div class="sp-e">Sin datos</div>'; };
    const count = (arr, f) => { const m = new Map(); arr.forEach(t => [].concat(f(t)).forEach(k => m.set(k, (m.get(k) || 0) + 1))); return [...m.entries()].sort((a, c) => c[1] - a[1]); };
    const porEst = _ESTADOS.map(e => [e[1], mains.filter(t => (t.estado || 'pendiente') === e[0]).length, e[2]]).filter(r => r[1]);
    const porPers = count(open, t => _resp(t).length ? _resp(t) : ['Sin asignar']).slice(0, 8), porProj = count(open, t => t.project_nombre || 'Sin lista').slice(0, 8);
    const porPrio = Object.entries(_PRIO).map(([k, v]) => [v[0], open.filter(t => (t.prioridad || 'media') === k).length, v[1]]);
    const next = open.filter(t => dd(t)).sort((a, c) => dd(a).localeCompare(dd(c))).slice(0, 8);
    const total = mains.length, pct = total ? Math.round(hechas.length * 100 / total) : 0;
    b.innerHTML = `<div class="sp-dash"><div class="sp-dash__k">${kpi('Abiertas', open.length)}${kpi('Vencidas', venc.length, venc.length ? '#D9534F' : '')}${kpi('Para hoy', hoy.length)}${kpi('Próximos 7 días', prox.length)}${kpi('Completadas', hechas.length, '#2E9E5B')}${kpi('Avance', pct + '%')}</div>
      <div class="sp-dash__g"><div class="sp-dc"><h4>Por estado</h4>${bars(porEst)}</div><div class="sp-dc"><h4>Por persona (abiertas)</h4>${bars(porPers, '#5B6BC0')}</div>
        <div class="sp-dc"><h4>Por lista (abiertas)</h4>${bars(porProj, '#007AFF')}</div><div class="sp-dc"><h4>Por prioridad (abiertas)</h4>${bars(porPrio)}</div>
        <div class="sp-dc sp-dc--w"><h4>Próximos vencimientos</h4>${next.length ? next.map(t => { const od = dd(t) < td; return `<div class="sp-dn" onclick="openTaskAnywhere(${t.id})"><span class="${od ? 'is-od' : ''}">${_fmtD(dd(t))}</span><b>${esc(t.titulo)}</b><em>${esc(t.project_nombre || '')}</em></div>`; }).join('') : '<div class="sp-e">Nada con fecha</div>'}</div></div></div>`;
  }

  // ── formulario: crear tareas del espacio ──
  function _paintForm(b) {
    const ps = (_selProj ? _projects.filter(p => p.id === _selProj) : (_selSpace != null ? _projsOf(_selSpace) : _projects).filter(p => (p.estado || 'activo') === 'activo'));
    if (!ps.length) { b.innerHTML = '<div class="sp-e sp-e--c">Primero crea una lista (proyecto) en este espacio.</div>'; return; }
    b.innerHTML = `<div class="sp-form"><h3>Nueva tarea</h3><p>Rellena el formulario y la tarea se crea en la lista que elijas.</p>
      <label>Nombre de la tarea *<input id="sf-t" placeholder="Qué hay que hacer"></label>
      <label>Lista<select id="sf-p">${ps.map(p => `<option value="${p.id}">${esc(p.nombre)}${p.client_nombre ? ' · ' + esc(p.client_nombre) : ''}</option>`).join('')}</select></label>
      <label>Descripción<textarea id="sf-d" rows="3" placeholder="Detalles (opcional)"></textarea></label>
      <div class="sp-form__r"><label>Persona asignada<select id="sf-r"><option value="">Sin asignar</option>${_team.filter(m => m.estado !== 'inactivo').map(m => `<option value="${esc(m.nombre)}"${(window._authUser && (window._authUser.memberNombre || window._authUser.name)) === m.nombre ? ' selected' : ''}>${esc(m.nombre)}</option>`).join('')}</select></label>
        <label>Prioridad<select id="sf-pr"><option value="alta">Alta</option><option value="media" selected>Media</option><option value="baja">Baja</option></select></label>
        <label>Fecha límite<input id="sf-f" type="date"></label></div>
      <button class="btn btn--primary" onclick="SpacesModule.formSend()">Crear tarea</button><span class="sp-form__ok" id="sf-ok"></span></div>`;
  }
  async function formSend() {
    const t = ($q('sf-t').value || '').trim(); if (!t) { showBanner('Escribe el nombre de la tarea', 'error'); return; }
    const pid = +$q('sf-p').value, resp = $q('sf-r').value;
    try {
      const r = await apiFetch(`${API}/mgmt/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo: t, project_id: pid, descripcion: $q('sf-d').value || '', prioridad: $q('sf-pr').value, deadline: $q('sf-f').value || null, responsables: resp ? [resp] : [], estado: 'pendiente' }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      const nt = await r.json(); const pj = _projects.find(x => x.id === pid); nt.project_nombre = pj ? pj.nombre : ''; nt.client_nombre = pj ? pj.client_nombre : ''; _tasks.unshift(nt);
      $q('sf-t').value = ''; $q('sf-d').value = ''; $q('sf-ok').textContent = '✓ Tarea creada'; setTimeout(() => { const o = $q('sf-ok'); if (o) o.textContent = ''; }, 3000); _paintTree();
    } catch (e) { showBanner('No se pudo crear la tarea: ' + e.message, 'error'); }
  }

  // ── lista ──
  // Completado y Cancelado se ven siempre como grupo (con su contador); la primera vez salen plegados para no estorbar. El botón ✓ de la barra los oculta del todo.
  const _closedSeen = new Set();
  function _groups(mains) {
    const gs = _groups0(mains), cust = _selProj && _custom(_selProj);
    gs.forEach(g => { if (!g.est) return; const cat = cust ? ((_stList(_selProj).find(e => e.k === g.est) || {}).t) : g.est; if ((cat === 'completado' || cat === 'cancelado') && !_closedSeen.has(g.key)) { _closedSeen.add(g.key); _collapsedG.add(g.key); } });
    return gs;
  }
  function _groups0(mains) {
    const g = _view === 'tabla' ? 'ninguno' : _group;
    if (g === 'ninguno') return [{ key: 'all', label: '', color: '', tasks: mains, flat: true }];
    if (g === 'estado' && _selProj && _custom(_selProj)) return _stList(_selProj).filter(e => _showClosed || (e.t !== 'completado' && e.t !== 'cancelado')).map(e => ({ key: e.k, label: e.n, color: e.c, tasks: mains.filter(t => _taskSt(t).k === e.k), est: e.k }));
    if (g === 'estado') return _ESTADOS.filter(e => _showClosed || (e[0] !== 'completado' && e[0] !== 'cancelado')).map(e => ({ key: e[0], label: e[1], color: e[2], tasks: mains.filter(t => (t.estado || 'pendiente') === e[0]), est: e[0] }));
    if (g.startsWith('f:') && _selProj) {
      const f = _fields(_selProj).find(x => x.id === g.slice(2));
      if (f) {
        const val = t => (t.campos || {})[f.id];
        if (f.t === 'casilla') return [['Sí', '#6BC950', t => !!val(t)], ['No', '#87909E', t => !val(t)]].map(([l, c, fn]) => ({ key: l, label: l, color: c, tasks: mains.filter(fn) }));
        if (f.t === 'personas') { const ns = [...new Set(mains.flatMap(t => val(t) || []))].sort(); return [...ns.map(n => ({ key: n, label: n, color: '#4194F6', tasks: mains.filter(t => (val(t) || []).includes(n)) })), { key: '_', label: 'Sin valor', color: '#87909E', tasks: mains.filter(t => !(val(t) || []).length) }]; }
        return [...(f.o || []).map(o => ({ key: o.k, label: o.n, color: o.c, tasks: mains.filter(t => f.t === 'lista' ? val(t) === o.k : (val(t) || []).includes(o.k)) })), { key: '_', label: 'Sin valor', color: '#87909E', tasks: mains.filter(t => f.t === 'lista' ? !val(t) : !(val(t) || []).length) }];
      }
    }
    if (g === 'prioridad') return Object.entries(_PRIO).map(([k, v]) => ({ key: k, label: v[0], color: v[1], tasks: mains.filter(t => (t.prioridad || 'media') === k) }));
    if (g === 'persona') { const names = [...new Set(mains.flatMap(t => _resp(t).length ? _resp(t) : ['Sin asignar']))].sort(); return names.map(n => ({ key: n, label: n, color: '#5B6BC0', tasks: mains.filter(t => (_resp(t).length ? _resp(t) : ['Sin asignar']).includes(n)) })); }
    const td = _today(), wk = new Date(); wk.setDate(wk.getDate() + 7); const wks = `${wk.getFullYear()}-${String(wk.getMonth() + 1).padStart(2, '0')}-${String(wk.getDate()).padStart(2, '0')}`; const dd = t => _d10(t.deadline);
    return [['v', 'Vencidas', '#D9534F', t => dd(t) && dd(t) < td], ['h', 'Hoy', '#3F5BD0', t => dd(t) === td], ['s', 'Próximos 7 días', '#E8920F', t => dd(t) > td && dd(t) <= wks], ['d', 'Más adelante', '#2E9E5B', t => dd(t) > wks], ['n', 'Sin fecha', '#9A958C', t => !dd(t)]].map(([k, l, c, f]) => ({ key: k, label: l, color: c, tasks: mains.filter(f) }));
  }
  function _statusRing(t) {
    const e0 = _EST[t.estado || 'pendiente'] || _EST.pendiente, e = [e0[0], e0[1], _taskSt(t).c];
    if (t.estado === 'completado') return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${e[2]}"/><polyline points="7 12.5 10.5 16 17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (t.estado === 'en_progreso') return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="${e[2]}" stroke-width="2.4"/><circle cx="12" cy="12" r="4.2" fill="${e[2]}"/></svg>`;
    return `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="${e[2]}" stroke-width="2.2" ${t.estado === 'pendiente' || !t.estado ? 'stroke-dasharray="3 3"' : ''}/></svg>`;
  }
  function _row(t, depth, kids, cols, trail, last) {
    const st = _taskSt(t), e = [t.estado, st.n, st.c], d = _d10(t.deadline), od = d && d < _today() && _isOpen(t), rs = _resp(t), open = !_collapsedT.has(t.id), p = _PRIO[t.prioridad || 'media'];
    const cell = {
      prioridad: `<div class="sp-c sp-c--m"><button class="sp-cb" onclick="SpacesModule.prio(event,${t.id})">${TasksModule.prioBadge(t.prioridad || 'media')}</button></div>`,
      inicio: `<div class="sp-c sp-c--m sp-dim">${_fmtD(_d10(t.fecha_inicio)) || '—'}</div>`,
      estimado: `<div class="sp-c sp-c--m sp-dim">${t.duracion_est_min ? _fmtEst(t.duracion_est_min) : '—'}</div>`,
      etiquetas: `<div class="sp-c sp-c--l">${(t.etiquetas || []).slice(0, 3).map(_tagChip).join('') || '<span class="sp-dim">—</span>'}</div>`,
      horas: `<div class="sp-c sp-c--m sp-dim">${(+t.horas_track || 0) ? (+t.horas_track) + 'h' : '—'}</div>`,
      proyecto: `<div class="sp-c sp-c--l sp-dim">${esc(t.project_nombre || '')}</div>`,
    };
    return `<div class="sp-r${depth ? ' sp-r--sub' : ''}" data-id="${t.id}" style="--d:${depth}" oncontextmenu="SpacesModule.ctx(event,${t.id})">
      <div class="sp-c sp-c--n">${Array.from({ length: depth }, (_, i) => `<span class="sp-gd${i === depth - 1 ? (last ? ' sp-gd--end' : ' sp-gd--mid') : (trail && trail[i + 1] ? ' sp-gd--line' : '')}"></span>`).join('')}${kids ? `<button class="sp-car" onclick="SpacesModule.toggleT(${t.id})">${open ? '▾' : '▸'}</button>` : (depth ? '' : '<span class="sp-car"></span>')}<button class="sp-ring" title="Cambiar estado" onclick="SpacesModule.estMenu(event,${t.id})">${_statusRing(t)}</button>
        <span class="sp-tt" onclick="openTaskAnywhere(${t.id})">${esc(t.titulo)}</span>${kids ? `<span class="sp-sb" title="${kids} subtarea(s)">⑂ ${kids}</span>` : ''}${depth < 2 ? `<button class="sp-addsub" title="Agregar subtarea" onclick="SpacesModule.addSub(event,${t.id})">＋ subtarea</button>` : ''}</div>
      <div class="sp-c sp-c--e"><button class="sp-cb" onclick="SpacesModule.estMenu(event,${t.id})"><span class="sp-tag" style="--c:${e[2]}">${esc(e[1])}</span></button></div>
      <div class="sp-c sp-c--d"><button class="sp-cb" onclick="SpacesModule.date(event,${t.id})">${d ? TasksModule.dueCell(t.deadline, t.estado, t.fecha_inicio) : '<span class="tl-due tl-due--none">＋</span>'}</button></div>
      <div class="sp-c sp-c--p"><button class="sp-as" onclick="SpacesModule.resp(event,${t.id})">${rs.length ? `<span class="tl-who-wrap">${rs.slice(0, 3).map(n => `<span class="tl-who" title="${esc(n)}">${esc(_ini(n))}</span>`).join('')}${rs.length > 3 ? `<span class="tl-who tl-who--more">+${rs.length - 3}</span>` : ''}</span>` : '<span class="tl-who tl-who--add">＋</span>'}</button></div>
      ${cols.map(c => cell[c]).join('')}${_fcols().map(f => _fcell(t, f)).join('')}<div class="sp-c sp-c--x"><span class="sp-el task-elapsed" data-timer-display="${t.id}" hidden></span>${TasksModule.timerBtn(t.id, 'sp-play')}<button class="sp-rowb" title="Opciones" onclick="SpacesModule.menu(event,${t.id})">⋯</button></div></div>`;
  }
  function _head(cols) { return `<div class="sp-r sp-r--h"><div class="sp-c sp-c--n">Nombre</div><div class="sp-c sp-c--e">Estado</div><div class="sp-c sp-c--d">Fecha límite</div><div class="sp-c sp-c--p">Persona asignada</div>${cols.map(c => `<div class="sp-c ${c === 'etiquetas' || c === 'proyecto' ? 'sp-c--l' : 'sp-c--m'}">${_COLS[c]}</div>`).join('')}${_fcols().map(f => `<div class="sp-c sp-c--f" title="${esc(f.n)}">${esc(f.n)}</div>`).join('')}<div class="sp-c sp-c--x"><button class="sp-plus" title="Columnas y campos" onclick="SpacesModule.fieldsOpen()">＋</button></div></div>`; }
  // trail[d] = si el antepasado de nivel d tiene hermanos después (para dibujar las líneas guía en «L»); last = si esta fila es la última de su grupo
  function _tree(t, byParent, depth, cols, out, trail, last) {
    trail = trail || [];
    const kids = (byParent.get(t.id) || []).filter(c => _showClosed || _isOpen(c));
    out.push(_row(t, depth, kids.length, cols, trail, last));
    if (kids.length && _expandSubs && !_collapsedT.has(t.id)) kids.forEach((k, i) => _tree(k, byParent, depth + 1, cols, out, trail.concat([!last]), i === kids.length - 1));
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
      return `<div class="sp-g">${g.flat ? '' : `<div class="sp-g__h"><button class="sp-car" onclick="SpacesModule.toggleG('${esc(g.key).replace(/'/g, '&#39;')}')">${open ? '▾' : '▸'}</button><span class="sp-tag" style="--c:${g.color}">${esc(g.label)}</span><span class="sp-gn">${g.tasks.length}</span>${g.est ? `<button class="sp-gp" title="Agregar tarea" onclick="SpacesModule.newTask('${g.est}',this)">＋</button>` : ''}</div>`}
        ${open ? _head(cols) + rows.join('') + `<div class="sp-add-r"><button type="button" onclick="SpacesModule.newTask('${g.est || 'pendiente'}',this)">＋ Agregar Tarea</button></div>` : ''}</div>`;
    }).join('') + `</div>`;
  }
  function toggleG(k) { if (_collapsedG.has(k)) _collapsedG.delete(k); else _collapsedG.add(k); _paintBody(); }
  function toggleT(id) { if (_collapsedT.has(id)) _collapsedT.delete(id); else _collapsedT.add(id); _paintBody(); }

  // ── tablero ──
  function _paintBoard(b, all) {
    const mains = all.filter(t => !t.parent_task_id);
    const cust = !!(_selProj && _custom(_selProj));
    const cols = (cust ? _stList(_selProj).map(e => [e.k, e.n, e.c, e.t]) : _ESTADOS.map(e => [e[0], e[1], e[2], e[0]])).filter(e => _showClosed || (e[3] !== 'completado' && e[3] !== 'cancelado'));
    b.innerHTML = `<div class="kanban-board sp-kb">${cols.map(([k, l, c]) => { const ts = mains.filter(t => (cust ? _taskSt(t).k : (t.estado || 'pendiente')) === k).sort((a, d) => (_d10(a.deadline) || '9999').localeCompare(_d10(d.deadline) || '9999')); return `<div class="kanban-col" ondragover="event.preventDefault();this.classList.add('is-over')" ondragleave="this.classList.remove('is-over')" ondrop="SpacesModule.drop(event,'${k}')"><div class="kanban-col__head"><div class="kanban-col__title"><span class="kanban-col__dot" style="background:${c}"></span>${l}<span class="kanban-count">${ts.length}</span></div><button class="kanban-col__add" title="Nueva tarea" onclick="SpacesModule.newTask('${k}',this)">+</button></div><div class="kanban-cards">${ts.map(_card).join('') || '<div class="kanban-empty">Sin tareas</div>'}</div></div>`; }).join('')}</div>`;
  }
  // La tarjeta es la misma que en Tareas: cronómetro, subtareas con progreso, menú ⋯ y clic derecho; aquí solo cambia a dónde abre y cómo se arrastra.
  function _card(t) {
    _adopt();
    return TasksModule.kcCard(t)
      .replace(/onclick="TasksModule\.openTaskPage\(\d+\)"/, `onclick="openTaskAnywhere(${t.id})" oncontextmenu="SpacesModule.ctx(event,${t.id})"`)
      .replace(/ondragstart="TasksModule\.kanbanDragStart\(event,\d+\)"/, `ondragstart="event.dataTransfer.setData('text/plain','${t.id}');event.dataTransfer.effectAllowed='move'"`)
      .replace(/\s*ondragend="TasksModule\.kanbanDragEnd\(event\)"/, '');
  }
  async function drop(ev, estado) { ev.preventDefault(); ev.currentTarget.classList.remove('is-over'); const id = parseInt(ev.dataTransfer.getData('text/plain'), 10); if (!id) return; if (_selProj && _custom(_selProj)) { await setEstado(id, estado); return; } _adopt(); try { await TasksModule.moveTaskToStatus(id, estado); } catch (_) {} _paintMain(); }

  // ── acciones por tarea (mismo menú y selectores que Tareas) ──
  function estMenu(ev, id) { ev.stopPropagation(); const t = _tk(id), l = t ? _stList(t.project_id) : _defSt, cur = t ? _taskSt(t).k : ''; _openPop(ev.currentTarget, `<div class="sp-pop__h">Estado</div>${l.map(e => `<button class="sp-pop__i${e.k === cur ? ' on' : ''}" onclick="SpacesModule.setEstado(${id},'${e.k}')"><i class="sp-dot" style="background:${e.c}"></i>${esc(e.n)}</button>`).join('')}`); }
  async function setEstado(id, key) {
    _closePop(); _adopt(); const t = _tk(id); if (!t) return;
    const st = _stList(t.project_id).find(e => e.k === key);
    if (_custom(t.project_id) && st) {
      try { if ((t.estado || 'pendiente') !== st.t) await TasksModule.moveTaskToStatus(id, st.t); const r = await _post(`/mgmt/tasks/${id}/status-key`, { key }, 'PATCH'); if (r.ok) { t.status_key = key; t.estado = st.t; } } catch (_) {}
    } else { try { await TasksModule.moveTaskToStatus(id, key); } catch (_) {} t.estado = key; }
    _paintMain(); _paintTree(); _refreshFields(id);
  }
  function prio(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcPrioPopover(ev, id); }
  function resp(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcRespPopover(ev, id); }
  function date(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKcDatePopover(ev, id); }
  // «＋ Tarea» / «＋ Agregar Tarea»: ventanita con el nombre y (si hace falta) la lista donde va
  function newTask(estado, anchor) {
    const ps = (_selProj ? _projects.filter(p => p.id === _selProj) : (_selSpace != null ? _projsOf(_selSpace) : _projects).filter(p => (p.estado || 'activo') === 'activo'));
    if (!ps.length) { showBanner('Primero crea o elige una lista (proyecto) en este espacio', 'error'); return; }
    const a = anchor || document.querySelector('.sp-newt') || document.body;
    const p = _openPop(a, `<div class="sp-pop__h">Nueva tarea${estado && estado !== 'pendiente' ? ' · ' + ((_EST[estado] || [0, ''])[1] || ((_stList(_selProj).find(e => e.k === estado) || {}).n) || '') : ''}</div>
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
    const cs = _custom(pid) ? _stList(pid).find(e => e.k === estado) : null;
    try {
      const r = await apiFetch(`${API}/mgmt/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo, project_id: pid, estado: cs ? cs.t : estado, responsables: window._authUser?.memberNombre ? [window._authUser.memberNombre] : [] }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      const t = await r.json(); if (cs) { const r2 = await _post(`/mgmt/tasks/${t.id}/status-key`, { key: cs.k }, 'PATCH'); if (r2.ok) { t.status_key = cs.k; t.estado = cs.t; } } const pj = _projects.find(x => x.id === pid); t.project_nombre = pj ? pj.nombre : ''; t.client_nombre = pj ? pj.client_nombre : ''; _tasks.unshift(t);
      showBanner('✓ Tarea creada', 'success');
    } catch (e) { showBanner('No se pudo crear la tarea: ' + e.message, 'error'); }
    _paintMain(); _paintTree();
  }

  // ═══ Estados y campos personalizados por proyecto (estilo ClickUp) ═══
  // Estados propios: la categoría («t») sigue siendo lo que usa el resto del sistema; tasks.status_key guarda el estado elegido.
  const _defSt = _ESTADOS.map(e => ({ k: e[0], n: e[1], c: e[2], t: e[0] }));
  const _custom = pid => { const p = _pjOf(pid); return !!(p && Array.isArray(p.estados) && p.estados.length); };
  const _stList = pid => (_custom(pid) ? _pjOf(pid).estados : _defSt);
  function _taskSt(t) {
    const l = _stList(t.project_id);
    if (_custom(t.project_id)) return l.find(e => e.k === t.status_key) || l.find(e => e.t === (t.estado || 'pendiente')) || l[0];
    return l.find(e => e.k === (t.estado || 'pendiente')) || l[0];
  }
  const _tk = id => _tasks.find(x => x.id === id) || (typeof TasksModule !== 'undefined' && TasksModule.getTask ? TasksModule.getTask(id) : null);
  const _fields = pid => { const p = _pjOf(pid); return p && Array.isArray(p.campos) ? p.campos : []; };
  // En un proyecto: sus campos visibles. En «Todas las tareas», un espacio o cualquier vista con varios proyectos: columnas por NOMBRE de campo (cada tarea muestra el de su proyecto)
  let _aggVis = []; try { _aggVis = JSON.parse(localStorage.getItem('nova_sp_aggf') || '[]'); } catch (_) {}
  let _fcc = null;
  const _scopePids = () => [...new Set(_scope().map(t => t.project_id))].filter(Boolean);
  function _aggKeys() { const m = new Map(); _scopePids().forEach(pid => _fields(pid).forEach(f => { const k = f.n + '|' + f.t; if (!m.has(k)) m.set(k, { k, n: f.n, t: f.t }); })); return [...m.values()].sort((a, b) => a.n.localeCompare(b.n, 'es')); }
  function _fcols() { if (_fcc) return _fcc; if (_selProj) return (_fcc = _fields(_selProj).filter(f => f.v !== false)); const vis = new Set(_aggVis); return (_fcc = _aggKeys().filter(x => vis.has(x.k)).map(x => ({ agg: true, key: x.k, n: x.n, t: x.t }))); }
  const _OPC = ['#4194F6', '#6BC950', '#F8AE00', '#FF7800', '#F04F4F', '#A875FF', '#08BDBA', '#87909E'];
  const _FT = [
    ['lista', 'Lista desplegable', 'Una opción para categorizar', '<polyline points="6 9 12 15 18 9"/>'], ['texto', 'Texto', 'Una línea de contexto', '<line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="14" x2="14" y2="14"/>'],
    ['fecha', 'Fecha', 'Fechas que no son el límite', '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>'],
    ['area', 'Texto extenso', 'Detalles largos', '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/>'], ['numero', 'Número', 'Cualquier cantidad', '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/><line x1="10" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="14" y2="20"/>'],
    ['etiquetas', 'Etiquetas', 'Varias opciones a la vez', '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.2"/>'], ['casilla', 'Casilla de selección', 'Sí o no', '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'],
    ['dinero', 'Dinero', 'Presupuestos, costos, tarifas', '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2a2.5 2 0 0 1-2.5-1.5M12 6v1.5M12 16.5V18"/>'],
    ['correo', 'Correo electrónico', 'Direcciones de correo', '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>'], ['telefono', 'Teléfono', 'Números de contacto', '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'],
    ['sitio', 'Sitio web', 'Vínculos y recursos', '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'], ['calificacion', 'Calificación', 'De 1 a 5 estrellas', '<polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/>'],
    ['progreso', 'Progreso (manual)', 'Barra de 0 a 100 %', '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M3 12h9"/>'], ['progreso_auto', 'Progreso (automático)', 'Según las subtareas', '<path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/>'],
    ['personas', 'Personas', 'Equipo que no es el asignado', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/>'], ['votacion', 'Votación', 'Cuenta de votos a favor', '<path d="M12 19V5M5 12l7-7 7 7"/>'],
  ];
  const _FTN = Object.fromEntries(_FT.map(x => [x[0], x[1]]));
  const _FDIM = '<span class="sp-dim">—</span>';
  const _star = on => `<svg width="13" height="13" viewBox="0 0 24 24" fill="${on ? '#F8AE00' : 'none'}" stroke="${on ? '#F8AE00' : '#C9C5BD'}" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/></svg>`;
  function _fview(t, f) {
    const v = (t.campos || {})[f.id];
    if (f.t === 'progreso_auto') { const kids = _tasks.filter(x => x.parent_task_id === t.id && !x.archivada); if (!kids.length) return _FDIM; const pc = Math.round(kids.filter(x => x.estado === 'completado').length / kids.length * 100); return `<span class="sp-fp"><i style="width:${pc}%"></i></span><em class="sp-fpn">${pc}%</em>`; }
    if (f.t === 'casilla') return v ? `<span class="sp-fck sp-fck--on">${_SVGS('<path d="m5 12 4 4 10-10"/>', 12)}</span>` : '<span class="sp-fck"></span>';
    if (f.t === 'votacion') return `<span class="sp-fvote">${_SVGS('<path d="M12 19V5M5 12l7-7 7 7"/>', 12)}${+v || 0}</span>`;
    if (v === undefined || v === null || v === '') return _FDIM;
    switch (f.t) {
      case 'lista': { const o = (f.o || []).find(x => x.k === v); return o ? `<span class="sp-ftag" style="--c:${o.c}">${esc(o.n)}</span>` : _FDIM; }
      case 'etiquetas': { const a = (v || []).map(k => (f.o || []).find(x => x.k === k)).filter(Boolean); return a.slice(0, 2).map(o => `<span class="sp-ftag" style="--c:${o.c}">${esc(o.n)}</span>`).join('') + (a.length > 2 ? `<em class="sp-fpn">+${a.length - 2}</em>` : ''); }
      case 'numero': return esc(Number(v).toLocaleString('es-ES'));
      case 'dinero': return esc((f.mon || 'USD') + ' ' + Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 }));
      case 'fecha': return esc(_fmtD(v));
      case 'calificacion': return [1, 2, 3, 4, 5].map(i => _star(i <= v)).join('');
      case 'progreso': return `<span class="sp-fp"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><em class="sp-fpn">${Math.round(v)}%</em>`;
      case 'personas': return `<span class="tl-who-wrap">${v.slice(0, 3).map(n => `<span class="tl-who" title="${esc(n)}">${esc(_ini(n))}</span>`).join('')}${v.length > 3 ? `<span class="tl-who tl-who--more">+${v.length - 3}</span>` : ''}</span>`;
      case 'sitio': return `<a class="sp-flink" href="${esc(/^https?:/i.test(v) ? v : 'https://' + v)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(String(v).replace(/^https?:\/\//i, ''))}</a>`;
      case 'correo': return `<a class="sp-flink" href="mailto:${esc(v)}" onclick="event.stopPropagation()">${esc(v)}</a>`;
      default: return `<span class="sp-ftxt">${esc(v)}</span>`;
    }
  }
  const _SVGS = (d, sz) => `<svg width="${sz || 15}" height="${sz || 15}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const _fcell = (t, f) => { const r = f.agg ? _fields(t.project_id).find(x => x.n + '|' + x.t === f.key) : f; return `<div class="sp-c sp-c--f">${r ? `<button type="button" class="sp-fv" onclick="SpacesModule.fEdit(event,${t.id},'${r.id}')">${_fview(t, r)}</button>` : '<span class="sp-dim">—</span>'}</div>`; };
  async function _fSave(tid, fid, val) {
    const t = _tk(tid), r = await _post(`/mgmt/tasks/${tid}/campos`, { values: { [fid]: val } }, 'PATCH');
    if (!r.ok) { showBanner(await _err(r, 'No se pudo guardar el campo'), 'error'); return false; }
    const j = await r.json(); if (t) t.campos = j.campos || {}; return true;
  }
  function _refreshFields(tid) { try { const mw = document.getElementById('pane-mgmt-mywork'); if (mw && mw.classList.contains('active') && window.MyWorkModule) MyWorkModule._fromTasks(); } catch (_) {} if ($q('sp-body') && !(_selProj && _cfg) && _mode === 'tasks') _paintBody(); if ($q('tskd-fields')) renderTaskFields(tid, 'tskd-fields'); if ($q('tkx-props')) { try { TasksModule._tdPaintProps(tid); TasksModule._tdPaintSubs(tid); } catch (_) {} } }
  async function fSet(tid, fid, val, keep) { await _fSave(tid, fid, val); if (!keep) _closePop(); _refreshFields(tid); }
  async function fTog(tid, fid, key, on) { const t = _tk(tid), cur = (((t && t.campos) || {})[fid] || []).slice(), i = cur.indexOf(key); if (on && i < 0) cur.push(key); if (!on && i >= 0) cur.splice(i, 1); await _fSave(tid, fid, cur); _refreshFields(tid); }
  function fEdit(ev, tid, fid) {
    ev.stopPropagation(); const t = _tk(tid), f = t && _fields(t.project_id).find(x => x.id === fid); if (!f) return;
    const v = (t.campos || {})[fid];
    if (f.t === 'casilla') { fSet(tid, fid, !v, true); return; }
    if (f.t === 'votacion') { fSet(tid, fid, (+v || 0) + 1, true); return; }
    if (f.t === 'progreso_auto') return;
    let h = `<div class="sp-pop__h">${esc(f.n)}</div>`;
    const clear = v ? `<button class="sp-pop__i" onclick="SpacesModule.fSet(${tid},'${fid}',null)">Quitar valor</button>` : '';
    if (f.t === 'lista') h += (f.o || []).map(o => `<button class="sp-pop__i${v === o.k ? ' on' : ''}" onclick="SpacesModule.fSet(${tid},'${fid}','${o.k}')"><i class="sp-dot" style="background:${o.c}"></i>${esc(o.n)}</button>`).join('') + clear;
    else if (f.t === 'etiquetas') h += `<div class="sp-pop__l">${(f.o || []).map(o => `<label class="sp-pop__o"><input type="checkbox" ${(v || []).includes(o.k) ? 'checked' : ''} onchange="SpacesModule.fTog(${tid},'${fid}','${o.k}',this.checked)"><span class="sp-ftag" style="--c:${o.c}">${esc(o.n)}</span></label>`).join('')}</div>`;
    else if (f.t === 'personas') h += `<div class="sp-pop__l">${[...new Set(_team.map(x => x.nombre).filter(Boolean))].map(n => `<label class="sp-pop__o"><input type="checkbox" data-n="${esc(n)}" ${(v || []).includes(n) ? 'checked' : ''} onchange="SpacesModule.fTog(${tid},'${fid}',this.dataset.n,this.checked)"><span>${esc(n)}</span></label>`).join('')}</div>`;
    else if (f.t === 'calificacion') h += `<div class="sp-frate">${[1, 2, 3, 4, 5].map(i => `<button type="button" onclick="SpacesModule.fSet(${tid},'${fid}',${i})">${_star(i <= (v || 0))}</button>`).join('')}</div>${clear}`;
    else if (f.t === 'area') h += `<textarea class="sp-pop__in" id="sp-fin" rows="4">${esc(v || '')}</textarea><button class="btn btn--primary btn--sm sp-pop__go" onclick="SpacesModule.fSet(${tid},'${fid}',document.getElementById('sp-fin').value)">Guardar</button>`;
    else { const ty = { numero: 'number', dinero: 'number', progreso: 'number', fecha: 'date', correo: 'email', telefono: 'tel', sitio: 'url' }[f.t] || 'text'; h += `<input class="sp-pop__in" id="sp-fin" type="${ty}" ${f.t === 'progreso' ? 'min="0" max="100"' : ''} step="any" value="${esc(v == null ? '' : v)}" placeholder="${f.t === 'progreso' ? '0 a 100' : (f.t === 'sitio' ? 'https://…' : '')}"><button class="btn btn--primary btn--sm sp-pop__go" onclick="SpacesModule.fSet(${tid},'${fid}',document.getElementById('sp-fin').value)">Guardar</button>${clear}`; }
    const p = _openPop(ev.currentTarget, h, 'sp-pop--w'), inp = p && p.querySelector('#sp-fin');
    if (inp) { inp.focus(); inp.onkeydown = e => { if (e.key === 'Enter' && f.t !== 'area') { e.preventDefault(); fSet(tid, fid, inp.value); } if (e.key === 'Escape') _closePop(); }; }
  }
  // campos y estados en el panel de la tarea (página de detalle)
  async function renderTaskFields(tid, cid) {
    const box = $q(cid); if (!box) return;
    if (!_projects.length) { try { const [pr, tr, mr] = await Promise.all([apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/tasks`), apiFetch(`${API}/mgmt/team`)]); if (pr.ok) _projects = await pr.json(); if (tr.ok && !_tasks.length) _tasks = await tr.json(); if (mr.ok && !_team.length) _team = await mr.json(); } catch (_) {} }
    const t = _tk(tid); if (!t || !t.project_id || !_pjOf(t.project_id)) { box.innerHTML = ''; return; }
    const fs = _fields(t.project_id), cust = _custom(t.project_id); if (!fs.length && !cust && !t.project_id) { box.innerHTML = ''; return; }
    const rows = fs.map(f => { const v = (t.campos || {})[f.id]; return { f, empty: v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) }; });
    const nEmpty = rows.filter(r => r.empty).length, vis = _tkHideEmpty ? rows.filter(r => !r.empty) : rows;
    box.innerHTML = vis.map(({ f }) => `<div class="tkx-fr"><span class="tkx-fr__l">${esc(f.n)}</span><button type="button" class="sp-fv sp-fv--lg" onclick="SpacesModule.fEdit(event,${tid},'${f.id}')">${_fview(t, f)}</button></div>`).join('')
      + (nEmpty ? `<button type="button" class="tkx-fr__t" onclick="SpacesModule.tkToggleEmpty(${tid})">${_tkHideEmpty ? 'Mostrar' : 'Ocultar'} campos vacíos ${nEmpty}</button>` : '')
      + (!fs.length ? '<div class="tkx-fr__e">Este proyecto aún no tiene campos. Usa «+» para agregarlos.</div>' : '');
  }
  let _tkHideEmpty = false;
  function tkToggleEmpty(tid) { _tkHideEmpty = !_tkHideEmpty; renderTaskFields(tid, 'tskd-fields'); }
  function fieldsOpenFor(pid) { _closePop(); document.getElementById('sp-modal')?.remove(); _fmPid = pid || 0; _fmMode = 'list'; _fmTab = 'exist'; _fmQ = ''; _fmPaint(true); }
  // marcar / reabrir como completada (usa la categoría «completado» de los estados del proyecto)
  function toggleDone(id) {
    _adopt(); const t = _tk(id); if (!t) return; const l = _stList(t.project_id), cat = e => e.t || e.k;
    const done = l.find(e => cat(e) === 'completado'), open = l.find(e => cat(e) === 'pendiente') || l[0];
    const k = t.estado === 'completado' ? (open && open.k) : (done && done.k); if (k) setEstado(id, k);
  }
  // Para Mi trabajo y otras pantallas: estados propios y campos de cada tarea según SU proyecto
  async function ensure() { if (_projects.length) return; try { const [pr, mr] = await Promise.all([apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/team`)]); if (pr.ok) _projects = await pr.json(); if (mr.ok && !_team.length) _team = await mr.json(); } catch (_) {} }
  function statusTag(t) { const st = _taskSt(t); return `<span class="sp-tag sp-tag--s" style="--c:${st.c}">${esc(st.n)}</span>`; }
  function chipsFor(t, max) {
    const out = [];
    for (const f of _fields(t.project_id)) { if (f.v === false || f.t === 'progreso_auto' || f.t === 'votacion') continue; const v = (t.campos || {})[f.id]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue; out.push(`<span class="mw-fchip"><em>${esc(f.n)}</em>${_fview(t, f)}</span>`); if (out.length >= (max || 3)) break; }
    return out.join('');
  }
  function fieldKeys() { const m = new Map(); _projects.forEach(p => (p.campos || []).forEach(f => { const k = f.n + '|' + f.t; if (!m.has(k)) m.set(k, { k, n: f.n, t: f.t }); })); return [...m.values()].sort((a, b) => a.n.localeCompare(b.n, 'es')); }
  function fcellFor(t, key) { const [n, ty] = String(key).split('|'), f = _fields(t.project_id).find(x => x.n === n && x.t === ty); return f ? `<button type="button" class="sp-fv" onclick="MyWorkModule.fEdit(event,${t.id},'${f.id}')">${_fview(t, f)}</button>` : '<span class="sp-dim">—</span>'; }
  async function _saveSchema(pid, patch) {
    const r = await _post(`/mgmt/projects/${pid}/schema`, patch, 'PUT');
    if (!r.ok) { showBanner(await _err(r, 'No se pudo guardar'), 'error'); return false; }
    const j = await r.json(), p = _pjOf(pid); if (p) { p.estados = j.estados; p.campos = j.campos; } return true;
  }

  // ── administrador de campos (Se muestran · Crear nuevo · Agregar existente) ──
  let _fmPid = 0, _fmMode = 'list', _fmType = '', _fmEdit = null;
  // ── panel lateral «Campos» (estilo ClickUp): buscador · Crear nuevo / Agregar existente · secciones plegables con interruptores ──
  let _fmTab = 'exist', _fmQ = '', _fmFold = new Set();
  const _BIC = { prioridad: '<path d="M5 22V4"/><path d="M5 4h12l-2 4 2 4H5"/>', inicio: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>', estimado: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', etiquetas: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.2"/>', horas: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', proyecto: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>', estado: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>', fecha: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>', persona: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>', nombre: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="14" y2="12"/>' };
  function fieldsOpen() { _closePop(); document.getElementById('sp-modal')?.remove(); _fmPid = _selProj || 0; _fmMode = 'list'; _fmTab = 'exist'; _fmQ = ''; _fmPaint(true); }
  function fdClose() { const d = $q('sp-fdr'); if (d) d.remove(); }
  function fdTab(t) { _fmTab = t; _fmMode = 'list'; _fmPaint(); }
  function fdQ(v) { _fmQ = v; _fmPaint(); }
  function fdFold(k) { if (_fmFold.has(k)) _fmFold.delete(k); else _fmFold.add(k); _fmPaint(); }
  function fmCol(k, on) { toggleCol(k, on); _fmPaint(); }
  function _fmSync() { if ($q('sp-fdr')) _fmPaint(); if (_selProj && _cfg) { if ($q('cfg-fld')) _cfgFldPaint(); } else if (_mode === 'tasks') _paintBody(); }
  function _fmPaint(first) {
    const p = _pjOf(_fmPid), fs = _fields(_fmPid), q = _nrm(_fmQ), ok = n => !q || _nrm(n).includes(q);
    const ic = d => `<i class="fd-i">${_SVGS(d, 15)}</i>`;
    const ftIc = t => ic((_FT.find(x => x[0] === t) || [0, 0, 0, '<circle cx="12" cy="12" r="9"/>'])[3]);
    const sw = (on, js, locked) => `<label class="fm-sw${locked ? ' fm-sw--off' : ''}"><input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="${js}"><span></span></label>`;
    const row = (icon, name, on, js, extra, locked) => ok(name) ? `<div class="fd-r">${icon}<span class="fd-n">${esc(name)}</span>${extra || ''}${sw(on, js, locked)}</div>` : '';
    const sec = (key, title, rows) => { const n = rows.filter(Boolean).length; return `<div class="fd-sec"><button type="button" class="fd-h" onclick="SpacesModule.fdFold('${key}')"><svg width="9" height="9" viewBox="0 0 10 10" style="transform:rotate(${_fmFold.has(key) ? -90 : 0}deg)"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>${title}<em>${n}</em></button>${_fmFold.has(key) ? '' : rows.join('')}</div>`; };
    const editBtns = f => `<button class="fm-b fd-ed" title="Editar" onclick="SpacesModule.fmEdit('${f.id}')">${_SVGS('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 13)}</button><button class="fm-b fd-ed" title="Eliminar el campo y sus valores" onclick="SpacesModule.fmDel('${f.id}')">${_SVGS('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', 13)}</button>`;
    let tabs = '', list = '';
    if (_fmMode === 'form') {
      const f = _fmEdit ? fs.find(x => x.id === _fmEdit) : null, t = f ? f.t : _fmType, withOpt = ['lista', 'etiquetas'].includes(t);
      list = `<button class="fm-back" onclick="SpacesModule.fmBack()">‹ Volver</button><div class="sp-mh">${f ? 'Editar campo' : 'Nuevo campo · ' + esc(_FTN[t] || t)}</div>
        ${!p ? `<label class="pcf-f"><span>Aplicar a</span><select class="form-input" id="fm-ap"><option value="all">Todos los proyectos de esta vista (${_scopePids().length})</option>${_scopePids().map(id => `<option value="${id}">${esc(_plain((_pjOf(id) || {}).nombre || ''))}</option>`).join('')}</select></label>` : ''}
        <label class="pcf-f"><span>Nombre</span><input class="form-input" id="fm-n" value="${esc(f ? f.n : '')}" placeholder="Ej. Canal" maxlength="50"></label>
        ${withOpt ? `<label class="pcf-f"><span>Opciones (una por línea)</span><textarea class="form-input" id="fm-o" rows="6" placeholder="LinkedIn\nEmail\nWhatsApp">${esc(f ? (f.o || []).map(o => o.n).join('\n') : '')}</textarea></label>` : ''}
        ${t === 'dinero' ? `<label class="pcf-f"><span>Moneda</span><select class="form-input" id="fm-m">${['USD', 'EUR', 'COP', 'MXN', 'ARS', 'PEN', 'CLP', 'BRL'].map(m => `<option${f && f.mon === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>` : ''}
        <div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.fmBack()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.fmSave()">${f ? 'Guardar' : 'Crear campo'}</button></div>`;
    } else {
      tabs = `<button type="button" class="${_fmTab === 'new' ? 'on' : ''}" onclick="SpacesModule.fdTab('new')">Crear nuevo</button><button type="button" class="${_fmTab === 'exist' ? 'on' : ''}" onclick="SpacesModule.fdTab('exist')">Agregar existente</button>`;
      if (_fmTab === 'new') {
        const pop = ['lista', 'texto', 'fecha', 'area', 'numero', 'etiquetas'], card = x => ok(x[1]) ? `<button type="button" class="fd-t" onclick="SpacesModule.fmNew('${x[0]}')">${ic(x[3])}<span><b>${x[1]}</b><em>${x[2]}</em></span></button>` : '';
        list = sec('pop', 'Popular', _FT.filter(x => pop.includes(x[0])).map(card)) + sec('all', 'Todos', _FT.map(card));
      } else {
        const vis = !p ? new Set(_aggVis) : null;
        const customs = !p ? _aggKeys().map(x => ({ id: x.k, n: x.n, t: x.t, v: vis.has(x.k) })) : fs;
        const toggle = f => !p ? `SpacesModule.fmAggVis(this.dataset.k,this.checked)" data-k="${esc(f.id)}` : `SpacesModule.fmVis('${f.id}',this.checked)`;
        const crow = (f, extra) => row(ftIc(f.t), f.n, f.v !== false, toggle(f), extra || (p ? editBtns(f) : ''));
        const lock = [['nombre', 'Nombre de la tarea'], ['estado', 'Estado'], ['fecha', 'Fecha límite'], ['persona', 'Persona asignada']].map(([k, l]) => row(ic(_BIC[k]), l, true, '', '', true));
        const bi = Object.entries(_COLS).filter(([k]) => !(k === 'proyecto' && _selProj));
        const shown = [...lock, ...bi.filter(([k]) => _cols.includes(k)).map(([k, l]) => row(ic(_BIC[k]), l, true, `SpacesModule.fmCol('${k}',this.checked)`)), ...customs.filter(f => f.v !== false).map(f => crow(f))];
        const props = bi.filter(([k]) => !_cols.includes(k)).map(([k, l]) => row(ic(_BIC[k]), l, false, `SpacesModule.fmCol('${k}',this.checked)`));
        const hidden = customs.filter(f => f.v === false).map(f => crow(f));
        const others = [];
        if (p) { _projects.forEach(o => { if (o.id !== _fmPid) (o.campos || []).forEach(f => { if (!fs.some(x => x.n === f.n && x.t === f.t) && !others.some(x => x.n === f.n && x.t === f.t)) others.push({ ...f, from: o.nombre }); }); }); _fmOthers = others; }
        list = sec('se', 'Se muestran', shown) + sec('pr', 'Propiedades', props) + sec('cu', 'Campos personalizados', hidden.length || !customs.length ? hidden : [])
          + (p && others.length ? sec('ot', 'De otros proyectos', others.slice(0, 30).map((f, i) => ok(f.n) ? `<div class="fd-r">${ftIc(f.t)}<span class="fd-n">${esc(f.n)}<small>${esc(f.from)}</small></span><button class="btn btn--ghost btn--sm" onclick="SpacesModule.fmAdd(${i})">Añadir</button></div>` : '')) : '')
          + (!customs.length ? `<p class="sp-mp" style="padding:8px 14px">${p ? 'Este proyecto todavía no tiene campos propios.' : 'Los proyectos de esta vista aún no tienen campos propios.'} Crea uno en «Crear nuevo».</p>` : '');
      }
    }
    let d = $q('sp-fdr');
    if (!d) {
      d = document.createElement('div'); d.id = 'sp-fdr'; d.className = 'fdr';
      d.innerHTML = `<div class="fdr__hd"><b>Campos</b><button type="button" class="fm-b" title="Cerrar" onclick="SpacesModule.fdClose()">${_SVGS('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', 16)}</button></div><div class="fdr__q" id="fdr-q"><input id="fdr-qi" placeholder="Buscar campos de tarea" oninput="SpacesModule.fdQ(this.value)"></div><div class="fdr__tabs" id="fdr-tabs"></div><div class="fdr__body" id="fdr-list"></div>`;
      document.body.appendChild(d);
    }
    $q('fdr-tabs').innerHTML = tabs; $q('fdr-q').style.display = _fmMode === 'form' ? 'none' : ''; $q('fdr-list').innerHTML = list;
  }
  let _fmOthers = [];
  function fmAggVis(k, on) { _aggVis = on ? [...new Set([..._aggVis, k])] : _aggVis.filter(x => x !== k); try { localStorage.setItem('nova_sp_aggf', JSON.stringify(_aggVis)); } catch (_) {} _fcc = null; if (_mode === 'tasks') _paintBody(); }
  function fmBack() { _fmMode = 'list'; _fmEdit = null; _fmPaint(); }
  function fmNew(t) { _fmMode = 'form'; _fmType = t; _fmEdit = null; _fmPaint(); setTimeout(() => $q('fm-n') && $q('fm-n').focus(), 30); }
  function fmEdit(id) { _fmMode = 'form'; _fmEdit = id; _fmPaint(); }
  async function fmVis(id, on) { const p = _pjOf(_fmPid), campos = _fields(_fmPid).map(f => f.id === id ? { ...f, v: on } : f); if (await _saveSchema(_fmPid, { campos })) _fmSync(); }
  async function fmVisPop(id, on) { _fmPid = _selProj; await fmVis(id, on); _closePop(); }
  async function fmDel(id) { const f = _fields(_fmPid).find(x => x.id === id); if (!f || !confirm(`¿Eliminar el campo «${f.n}»? Se borran sus valores en todas las tareas de este proyecto.`)) return; if (await _saveSchema(_fmPid, { campos: _fields(_fmPid).filter(x => x.id !== id) })) { _fmPaint(); _fmSync(); } }
  async function fmAdd(i) { const f = _fmOthers[i]; if (!f) return; const copy = { ...f, id: 'f' + Date.now().toString(36), v: true }; delete copy.from; if (await _saveSchema(_fmPid, { campos: [..._fields(_fmPid), copy] })) { _fmPaint(); _fmSync(); } }
  async function fmSave() {
    const n = String(($q('fm-n') || {}).value || '').trim(); if (!n) { showBanner('Ponle un nombre al campo', 'error'); return; }
    const cur = _fields(_fmPid), f = _fmEdit ? cur.find(x => x.id === _fmEdit) : null, t = f ? f.t : _fmType;
    const o = ['lista', 'etiquetas'].includes(t) ? String(($q('fm-o') || {}).value || '').split('\n').map(s => s.trim()).filter(Boolean).map((nm, i) => { const old = f && (f.o || []).find(x => x.n === nm); return { n: nm, k: old ? old.k : undefined, c: old ? old.c : _OPC[i % _OPC.length] }; }) : undefined;
    if (['lista', 'etiquetas'].includes(t) && !o.length) { showBanner('Añade al menos una opción', 'error'); return; }
    if (!_fmPid) {   // vista con varios proyectos: el campo se crea en cada proyecto elegido
      const sel = ($q('fm-ap') || {}).value || 'all', targets = sel === 'all' ? _scopePids() : [+sel], base = { n, t, ...(o ? { o } : {}), ...(t === 'dinero' ? { mon: ($q('fm-m') || {}).value || 'USD' } : {}) };
      let ok = true;
      for (const pid of targets) { const c2 = _fields(pid); if (c2.some(x => x.n === n && x.t === t)) continue; if (!(await _saveSchema(pid, { campos: [...c2, { ...base, id: 'f' + Date.now().toString(36) + pid, v: true }] }))) { ok = false; break; } }
      if (ok) { const k = n + '|' + t; if (!_aggVis.includes(k)) { _aggVis.push(k); try { localStorage.setItem('nova_sp_aggf', JSON.stringify(_aggVis)); } catch (_) {} } _fmMode = 'list'; _fmEdit = null; _fmPaint(); _fmSync(); showBanner('✓ Campo creado en ' + targets.length + ' proyecto' + (targets.length === 1 ? '' : 's'), 'success'); }
      return;
    }
    const nf = { ...(f || { id: 'f' + Date.now().toString(36), v: true }), n, t, ...(o ? { o } : {}), ...(t === 'dinero' ? { mon: ($q('fm-m') || {}).value || 'USD' } : {}) };
    const campos = f ? cur.map(x => x.id === f.id ? nf : x) : [...cur, nf];
    if (await _saveSchema(_fmPid, { campos })) { _fmMode = 'list'; _fmEdit = null; _fmPaint(); _fmSync(); }
  }

  // ── estados del proyecto (en Configuración) ──
  let _cfgEst = [];
  const _CATN = { pendiente: 'Pendiente (sin empezar)', en_progreso: 'En curso', bloqueado: 'Bloqueado', completado: 'Completado', cancelado: 'Cancelado' };
  function _cfgEstPaint() {
    const box = $q('cfg-est'); if (!box) return;
    box.innerHTML = _cfgEst.map((e, i) => `<div class="pcf-er"><input type="color" value="${esc(e.c)}" title="Color" onchange="SpacesModule.cfgEstSet(${i},'c',this.value)"><input class="form-input" value="${esc(e.n)}" maxlength="40" oninput="SpacesModule.cfgEstSet(${i},'n',this.value)"><select class="form-input" title="Categoría: lo que significa para el resto del sistema" onchange="SpacesModule.cfgEstSet(${i},'t',this.value)">${Object.entries(_CATN).map(([k, l]) => `<option value="${k}"${e.t === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="fm-b" title="Subir" onclick="SpacesModule.cfgEstMove(${i},-1)">${_SVGS('<polyline points="6 15 12 9 18 15"/>', 14)}</button><button type="button" class="fm-b" title="Bajar" onclick="SpacesModule.cfgEstMove(${i},1)">${_SVGS('<polyline points="6 9 12 15 18 9"/>', 14)}</button><button type="button" class="fm-b" title="Quitar" onclick="SpacesModule.cfgEstDel(${i})">${_SVGS('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', 14)}</button></div>`).join('');
  }
  function cfgEstSet(i, k, v) { if (_cfgEst[i]) _cfgEst[i][k] = v; }
  function cfgEstMove(i, d) { const j = i + d; if (j < 0 || j >= _cfgEst.length) return; [_cfgEst[i], _cfgEst[j]] = [_cfgEst[j], _cfgEst[i]]; _cfgEstPaint(); }
  function cfgEstDel(i) { if (_cfgEst.length <= 1) { showBanner('Deja al menos un estado', 'error'); return; } _cfgEst.splice(i, 1); _cfgEstPaint(); }
  function cfgEstAdd() { _cfgEst.push({ k: 'e' + Date.now().toString(36), n: 'Nuevo estado', c: _OPC[_cfgEst.length % _OPC.length], t: 'en_progreso' }); _cfgEstPaint(); }
  async function cfgEstSave(reset) {
    const pid = _selProj; if (!pid) return;
    if (!reset && !_cfgEst.some(e => e.t === 'completado')) { showBanner('Incluye al menos un estado de categoría «Completado»', 'error'); return; }
    if (await _saveSchema(pid, { estados: reset ? null : _cfgEst })) { showBanner(reset ? 'Estados restablecidos' : 'Estados guardados', 'success'); if (reset) _cfgEst = _defSt.map(e => ({ ...e })); else _cfgEst = _pjOf(pid).estados.map(e => ({ ...e })); _cfgEstPaint(); _paintTree(); }
  }
  function _cfgFldPaint() {
    const box = $q('cfg-fld'); if (!box) return; const fs = _fields(_selProj);
    box.innerHTML = fs.length ? fs.map(f => `<div class="fm-r"><b>${esc(f.n)}</b><em>${esc(_FTN[f.t] || f.t)}${f.v === false ? ' · oculto' : ''}</em></div>`).join('') : '<p class="pcf-p">Sin campos propios todavía.</p>';
  }

  // ═══ Centro de plantillas (estilo ClickUp): galería con vista previa → detalle que se despliega → usar la plantilla ═══
  const _tc = { list: [], full: {}, q: '', f: { estados: false, campos: false, documento: false, pizarra: false }, view: 'grid', cur: null, slide: 0, acc: new Set(), ctx: {}, o: null, ddq: '' };
  const _VTN = { lista: 'Lista', tablero: 'Tablero', tabla: 'Tabla', calendario: 'Calendario', gantt: 'Cronograma', galeria: 'Galería', panel: 'Panel', formulario: 'Formulario', documento: 'Documento', pizarra: 'Pizarra' };
  const _VTI = { lista: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>', tablero: '<rect x="3" y="3" width="6" height="14" rx="1.5"/><rect x="11" y="3" width="6" height="9" rx="1.5"/>', tabla: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>', calendario: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>', gantt: '<line x1="4" y1="7" x2="14" y2="7"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="6" y1="17" x2="16" y2="17"/>', documento: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>', pizarra: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>' };
  const _tcSt = d => (d.proyecto && Array.isArray(d.proyecto.estados) && d.proyecto.estados.length) ? d.proyecto.estados : _defSt;
  // vistas previas dibujadas con los datos reales de la plantilla (miniaturas)
  function _pvList(d) { const es = _tcSt(d).slice(0, 3), ts = (d.tareas || []).filter(x => !x.parent); return `<div class="pv">${es.map((e, i) => `<div class="pv-g"><i class="pv-tag" style="background:${e.c}">${esc(e.n)}</i></div>${ts.slice(i * 2, i * 2 + 2).map(t => `<div class="pv-r"><u></u><span>${esc(t.titulo)}</span><i class="pv-chip" style="background:${e.c}"></i></div>`).join('')}`).join('')}</div>`; }
  function _pvBoard(d) { const es = _tcSt(d).slice(0, 4), ts = (d.tareas || []).filter(x => !x.parent); return `<div class="pv pv--b">${es.map((e, i) => `<div class="pv-col"><i class="pv-tag" style="background:${e.c}">${esc(e.n)}</i>${ts.slice(i * 2, i * 2 + 2).map(t => `<div class="pv-card">${esc(t.titulo)}</div>`).join('')}</div>`).join('')}</div>`; }
  function _pvDoc(d) { const v = (d.vistas || []).find(x => x.tipo === 'documento'), bl = v && v.config && v.config.blocks ? v.config.blocks.slice(0, 9) : []; return `<div class="pv pv--d">${bl.map(b => b.t === 'h1' ? `<div class="pv-h1">${esc(String(b.html).replace(/<[^>]*>/g, ''))}</div>` : b.t === 'h2' ? `<div class="pv-h2">${esc(String(b.html).replace(/<[^>]*>/g, ''))}</div>` : `<div class="pv-ln${/^call-/.test(b.t) ? ' pv-ln--c' : ''}"></div>`).join('')}</div>`; }
  function _pvWb(d) { const v = (d.vistas || []).find(x => x.tipo === 'pizarra'), it = v && v.config && v.config.items ? v.config.items.slice(0, 6) : []; return `<div class="pv pv--w">${it.map((n, i) => `<div class="pv-note" style="background:${esc(n.color || '#FFF3A8')};left:${6 + (i % 3) * 32}%;top:${10 + Math.floor(i / 3) * 44}%">${esc(String(n.text || '').split('\n')[0])}</div>`).join('')}</div>`; }
  const _slidesOf = d => { const t = (d.vistas || []).map(v => v.tipo); return [['Lista', _pvList], ...(t.includes('tablero') ? [['Tablero', _pvBoard]] : []), ...(t.includes('documento') ? [['Documento', _pvDoc]] : []), ...(t.includes('pizarra') ? [['Pizarra', _pvWb]] : [])]; };

  async function tplCenter(ctx) {
    _closePop(); document.getElementById('sp-modal')?.remove(); _tc.ctx = ctx || {}; _tc.view = 'grid'; _tc.cur = null; _tc.q = ''; _tc.acc = new Set();
    const m = _tcMount(); m.querySelector('.tc-box').innerHTML = '<div class="sp-load" style="margin:auto">Cargando plantillas…</div>';
    try {
      _tc.list = await _loadTpls(); const fl = await Promise.all(_tc.list.map(t => apiFetch(`${API}/mgmt/project-templates/${t.id}`).then(r => r.ok ? r.json() : null).catch(() => null))); _tc.full = {}; fl.forEach(x => { if (x) _tc.full[x.id] = x; });
      const [sr, cr] = await Promise.all([apiFetch(`${API}/mgmt/spaces`), apiFetch(`${API}/mgmt/clients`)]); if (sr.ok) _spaces = await sr.json(); _tc.clients = cr.ok ? await cr.json() : [];
    } catch (e) { console.error('[tpl] centro', e); }
    _tcPaint();
  }
  function _tcMount() { let m = $q('tc-modal'); if (!m) { m = document.createElement('div'); m.id = 'tc-modal'; m.className = 'tc-bd'; m.innerHTML = '<div class="tc-box"></div>'; m.onclick = e => { if (e.target === m) tcClose(); }; document.body.appendChild(m); } return m; }
  function tcClose() { const m = $q('tc-modal'); if (m) m.remove(); }
  const _XI = _SVGS('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', 18);
  function _tcPaint() {
    const m = _tcMount(), box = m.querySelector('.tc-box'); box.className = 'tc-box' + (_tc.view === 'grid' ? '' : ' tc-box--col');
    box.innerHTML = _tc.view === 'grid' ? _tcGrid() : _tc.view === 'detail' ? _tcDetail() : _tcUse();
    const q = $q('tc-q'); if (q && document.activeElement !== q && _tc.focusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
  function _tcFiltered() {
    const q = _nrm(_tc.q), f = _tc.f;
    return _tc.list.filter(t => (!q || _nrm(t.nombre + ' ' + (t.descripcion || '')).includes(q)) && (!f.estados || t.n_estados > 0) && (!f.campos || t.n_campos > 0) && (!f.documento || (t.tipos || []).includes('documento')) && (!f.pizarra || (t.tipos || []).includes('pizarra')));
  }
  function _tcGrid() {
    const ls = _tcFiltered(), ck = (k, l) => `<label class="tc-ck"><input type="checkbox" ${_tc.f[k] ? 'checked' : ''} onchange="SpacesModule.tcFilter('${k}',this.checked)"><span>${l}</span></label>`;
    return `<aside class="tc-side"><div class="tc-logo"><i>${_SVGS('<path d="M12 3l1.8 4.9 4.9 1.8-4.9 1.8L12 16.4l-1.8-4.9-4.9-1.8 4.9-1.8z"/>', 17)}</i><b>Centro de plantillas</b></div>
      <button class="tc-nav on">${_SVGS('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', 15)}Mis plantillas<em>${_tc.list.length}</em></button>
      <div class="tc-sh">Contiene</div>${ck('estados', 'Estados propios')}${ck('campos', 'Campos personalizados')}${ck('documento', 'Documento')}${ck('pizarra', 'Pizarra')}
      <div class="tc-sh">Cómo se usan</div><p class="tc-hint">Una plantilla incluye tareas, subtareas, estados, campos y vistas. Se puede crear un proyecto nuevo con ella o aplicarla a uno que ya existe.</p></aside>
      <section class="tc-main"><div class="tc-top"><label class="tc-search">${_SVGS('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>', 16)}<input id="tc-q" placeholder="Buscar plantillas…" value="${esc(_tc.q)}" oninput="SpacesModule.tcQ(this.value)"></label><button class="tc-x" title="Cerrar" onclick="SpacesModule.tcClose()">${_XI}</button></div>
      <div class="tc-scroll"><h3 class="tc-h3">Mis plantillas</h3>${ls.length ? `<div class="tc-grid">${ls.map(t => { const f = _tc.full[t.id]; return `<div class="tc-card" onclick="SpacesModule.tcOpen(${t.id})"><div class="tc-prev">${f ? _pvList(f.data || {}) : ''}</div><div class="tc-cb"><i class="tc-cico">${_SVGS('<path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/>', 15)}</i><div><b>${esc(t.nombre)}</b><span>${t.n_tareas} tareas · ${t.n_vistas} vistas${t.n_campos ? ' · ' + t.n_campos + ' campos' : ''}</span></div></div></div>`; }).join('')}</div>` : `<p class="sp-mp" style="padding:20px 4px">${_tc.list.length ? 'Ninguna plantilla coincide con la búsqueda.' : 'Aún no tienes plantillas: abre un proyecto y usa «Plantillas › Guardar como plantilla».'}</p>`}</div></section>`;
  }
  function tcQ(v) { _tc.q = v; _tc.focusQ = true; _tcPaint(); }
  function tcFilter(k, on) { _tc.f[k] = on; _tc.focusQ = false; _tcPaint(); }
  function tcOpen(id) { _tc.cur = _tc.full[id] || null; if (!_tc.cur) return; _tc.view = 'detail'; _tc.slide = 0; _tc.acc = new Set(['estados']); _tcPaint(); }
  function tcBack() { if (_tc.view === 'use') _tc.view = 'detail'; else { _tc.view = 'grid'; _tc.cur = null; } _tc.focusQ = false; _tcPaint(); }
  function tcSlide(d) { const n = _slidesOf(_tc.cur.data || {}).length; _tc.slide = (_tc.slide + d + n) % n; _tcPaint(); }
  function tcAcc(k) { if (_tc.acc.has(k)) _tc.acc.delete(k); else _tc.acc.add(k); _tcPaint(); }
  function _tcDetail() {
    const t = _tc.cur, d = t.data || {}, pr = d.proyecto || {}, sl = _slidesOf(d), tareas = d.tareas || [], vistas = d.vistas || [], campos = pr.campos || [], es = Array.isArray(pr.estados) ? pr.estados : [];
    const subs = tareas.filter(x => x.parent).length, mains = tareas.filter(x => !x.parent), open = k => _tc.acc.has(k);
    const acc = (k, ico, title, sub, body) => `<div class="tc-acc"><button type="button" class="tc-ah" onclick="SpacesModule.tcAcc('${k}')"><i>${_SVGS(ico, 18)}</i><span><b>${title}</b><em>${sub}</em></span><svg width="12" height="12" viewBox="0 0 10 10" style="transform:rotate(${open(k) ? 180 : 0}deg)"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>${open(k) ? `<div class="tc-ab">${body}</div>` : ''}</div>`;
    const dt = new Date(t.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    return `<div class="tc-dh"><button type="button" class="tc-back" onclick="SpacesModule.tcBack()">${_SVGS('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 16)} Atrás</button><b>Centro de plantillas</b><button class="tc-x" title="Cerrar" onclick="SpacesModule.tcClose()">${_XI}</button></div>
      <div class="tc-dbody"><div class="tc-dmain"><div class="tc-dtitle"><i class="tc-ico">${_SVGS('<path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>', 28)}</i><div><h2>${esc(t.nombre)}</h2><span>Tipo: Proyecto</span></div><button class="btn btn--primary" onclick="SpacesModule.tcUse()">Utilizar plantilla</button></div>
        <div class="tc-gal"><div class="tc-slide"><div class="tc-sbar"><span>${sl[_tc.slide][0]}</span></div>${sl[_tc.slide][1](d)}${sl.length > 1 ? `<button class="tc-sa tc-sa--l" onclick="SpacesModule.tcSlide(-1)">‹</button><button class="tc-sa tc-sa--r" onclick="SpacesModule.tcSlide(1)">›</button><div class="tc-dots">${sl.map((_, i) => `<i class="${i === _tc.slide ? 'on' : ''}"></i>`).join('')}</div>` : ''}</div>
          <div class="tc-desc"><h4>Descripción de la plantilla</h4><p>${esc(t.descripcion || pr.descripcion || 'Sin descripción.')}</p></div></div>
        <h4 class="tc-inc">La plantilla incluye</h4>
        ${acc('estados', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>', 'Estados', es.length ? `${es.length} estados propios incluidos` : 'Usa los 5 estados de siempre', es.length ? `<div class="tc-chips">${es.map(e => `<span class="sp-tag" style="--c:${e.c}">${esc(e.n)}</span>`).join('')}</div><p class="tc-note">Categorías: ${[...new Set(es.map(e => (_CATN[e.t] || e.t)))].join(' · ')}</p>` : '<p class="tc-note">Pendiente · En progreso · Bloqueado · Completado · Cancelado.</p>')}
        ${acc('campos', '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 'Campos personalizados', campos.length ? `${campos.length} campos personalizados incluidos` : 'Sin campos propios', campos.length ? `<div class="tc-chips">${campos.map(f => `<span class="tc-chip">${esc(f.n)}<em>${esc(_FTN[f.t] || f.t)}</em></span>`).join('')}</div>` : '<p class="tc-note">Esta plantilla no trae columnas personalizadas.</p>')}
        ${acc('vistas', '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>', 'Tipos de vista', `${vistas.length} vistas incluidas`, `<div class="tc-chips">${vistas.map(v => `<span class="tc-chip tc-chip--v">${_SVGS(_VTI[v.tipo] || _VTI.lista, 14)}${esc(v.nombre || _VTN[v.tipo] || v.tipo)}<em>${esc(_VTN[v.tipo] || v.tipo)}</em></span>`).join('')}</div>`)}
        ${acc('tareas', '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', 'Tareas y subtareas', `${mains.length} tareas · ${subs} subtareas`, `<ul class="tc-tl">${mains.slice(0, 60).map(x => { const k = tareas.filter(y => y.parent === x.ref).length; return `<li><b>${esc(x.titulo)}</b>${k ? `<em>${k} subtarea${k === 1 ? '' : 's'}</em>` : ''}${k ? `<ul>${tareas.filter(y => y.parent === x.ref).map(y => `<li>${esc(y.titulo)}</li>`).join('')}</ul>` : ''}</li>`; }).join('')}</ul>`)}
      </div>
      <aside class="tc-dside"><div class="tc-by"><i>${_SVGS('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>', 18)}</i><div><b>${t.created_by === 'Nova' ? 'Por Nova' : 'Por ' + esc(t.created_by || 'tu equipo')}</b><span>${t.created_by === 'Nova' ? 'Plantilla del sistema, editable y copiable.' : 'Creada en tu espacio de trabajo.'}</span></div></div>
        <div class="tc-meta"><span>FECHA DE CREACIÓN</span><b>${dt}</b></div><div class="tc-meta"><span>CONTENIDO</span><b>${tareas.length} tareas · ${vistas.length} vistas</b></div>
        <div class="tc-acts"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tplRename(${t.id})">Renombrar</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tplDelete(${t.id})">Eliminar</button></div></aside></div>`;
  }
  // ── paso 2: usar la plantilla (proyecto nuevo o uno que ya existe) ──
  function tcUse() {
    const c = _tc.ctx || {}, pj = c.pid ? _pjOf(c.pid) : null;
    _tc.o = { dest: c.pid ? 'existente' : 'nuevo', name: '', client: '', sid: c.sid || 0, pid: c.pid || 0, existentes: 'mantener', all: true, el: { tareas: true, sub: true, vistas: true, campos: true, ajustes: true }, resp: 'plantilla', fechas: 'reprogramar', fecha: (pj && pj.fecha_inicio ? _d10(pj.fecha_inicio) : '') || _today() };
    _tc.view = 'use'; _tcPaint();
  }
  const _seg = (items, cur, js) => `<div class="tc-seg">${items.map(([k, l, ic]) => `<button type="button" class="${cur === k ? 'on' : ''}" onclick="${js.replace('%k', k)}">${ic ? _SVGS(ic, 15) : ''}${l}</button>`).join('')}</div>`;
  function _ddHtml(id, items, sel, ph) { const cur = items.find(x => String(x.v) === String(sel)); return `<div class="tc-dd" id="tc-dd-${id}"><button type="button" class="tc-ddb" onclick="SpacesModule.tcDD('${id}')"><span>${cur ? esc(cur.l) : ph}</span><svg width="11" height="11" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button></div>`; }
  const _ddItems = id => id === 'space' ? [{ v: 0, l: 'Principal' }, ..._spaces.map(s => ({ v: s.id, l: s.nombre }))] : _projects.filter(p => !p.archivado).map(p => ({ v: p.id, l: p.nombre, sub: p.space_id ? ((_spaces.find(s => s.id === p.space_id) || {}).nombre || '') : 'Principal' }));
  function tcDD(id) {
    const box = $q('tc-dd-' + id); if (!box) return; const ex = box.querySelector('.tc-ddl'); if (ex) { ex.remove(); return; }
    document.querySelectorAll('.tc-ddl').forEach(x => x.remove()); _tc.ddq = '';
    box.insertAdjacentHTML('beforeend', `<div class="tc-ddl"><input placeholder="Buscar…" oninput="SpacesModule.tcDDQ('${id}',this.value)"><div class="tc-dds">Explorar</div><div class="tc-ddi" id="tc-ddi-${id}"></div></div>`); _ddFill(id); const i = box.querySelector('input'); if (i) i.focus();
  }
  function _ddFill(id) { const el = $q('tc-ddi-' + id); if (!el) return; const q = _nrm(_tc.ddq), sel = id === 'space' ? _tc.o.sid : _tc.o.pid; el.innerHTML = _ddItems(id).filter(x => !q || _nrm(x.l).includes(q)).map(x => `<button type="button" class="${String(x.v) === String(sel) ? 'on' : ''}" onclick="SpacesModule.tcDDPick('${id}',${x.v})">${esc(x.l)}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</button>`).join('') || '<div class="tc-dds">Sin resultados</div>'; }
  function tcDDQ(id, v) { _tc.ddq = v; _ddFill(id); }
  function tcDDPick(id, v) { if (id === 'space') _tc.o.sid = v; else { _tc.o.pid = v; const pj = _pjOf(v); if (pj && pj.fecha_inicio) _tc.o.fecha = _d10(pj.fecha_inicio); } _tcPaint(); }
  function tcSet(k, v) { _tc.o[k] = v; }
  function tcSeg(k, v) { _tc.o[k] = v; _tcPaint(); }
  function tcEl(k, on) { _tc.o.el[k] = on; if (k === 'tareas' && !on) _tc.o.el.sub = false; _tcPaint(); }
  function _tcUse() {
    const o = _tc.o, t = _tc.cur, nuevo = o.dest === 'nuevo', el = o.el, ck = (k, l, dis) => `<label class="tc-ck"><input type="checkbox" ${el[k] ? 'checked' : ''} ${dis ? 'disabled' : ''} onchange="SpacesModule.tcEl('${k}',this.checked)"><span>${l}</span></label>`;
    return `<div class="tc-dh"><button type="button" class="tc-back" onclick="SpacesModule.tcBack()">${_SVGS('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 16)} Atrás</button><b>Usa la plantilla de proyecto</b><button class="tc-x" title="Cerrar" onclick="SpacesModule.tcClose()">${_XI}</button></div>
      <div class="tc-ubody"><div class="tc-uform">
        <div class="tc-l">¿Qué quieres hacer?</div>${_seg([['nuevo', 'Crear un proyecto nuevo'], ['existente', 'Aplicar a un proyecto existente']], o.dest, "SpacesModule.tcSeg('dest','%k')")}
        ${nuevo ? `<label class="tc-l" for="tc-name">Nombre del proyecto</label><input class="tc-in" id="tc-name" placeholder="${esc(t.nombre)}" value="${esc(o.name)}" oninput="SpacesModule.tcSet('name',this.value)">
          <div class="tc-l">Cliente <b>*</b></div><select class="tc-in" onchange="SpacesModule.tcSet('client',this.value)"><option value="">Selecciona un cliente…</option>${(_tc.clients || []).map(c => `<option value="${c.id}"${String(o.client) === String(c.id) ? ' selected' : ''}>${esc(c.nombre)}${c.empresa ? ' · ' + esc(c.empresa) : ''}</option>`).join('')}</select>
          <div class="tc-l">¿Dónde debería crearse este proyecto? <b>*</b></div>${_ddHtml('space', _ddItems('space'), o.sid, 'Elige un espacio')}`
          : `<div class="tc-l">Proyecto al que se aplica <b>*</b></div>${_ddHtml('proj', _ddItems('proj'), o.pid, 'Elige un proyecto')}
          <div class="tc-l">Si el proyecto ya tiene tareas</div><div class="tc-box2"><label class="tc-rd"><input type="radio" name="tc-ex" ${o.existentes === 'mantener' ? 'checked' : ''} onchange="SpacesModule.tcSet('existentes','mantener')"><span>Mantener las tareas actuales y añadir las de la plantilla</span></label><label class="tc-rd"><input type="radio" name="tc-ex" ${o.existentes === 'archivar' ? 'checked' : ''} onchange="SpacesModule.tcSet('existentes','archivar')"><span>Archivar las tareas actuales y empezar con las de la plantilla</span></label></div>`}
        <div class="tc-l">Opciones de importación</div><div class="tc-box2">${_seg([['todo', 'Importar todo', '<path d="M12 3l1.8 4.9 4.9 1.8-4.9 1.8L12 16.4l-1.8-4.9-4.9-1.8 4.9-1.8z"/>'], ['custom', 'Personalizar elementos importados', '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>']], o.all ? 'todo' : 'custom', "SpacesModule.tcSeg('all','%k'==='todo')".replace("'%k'==='todo'", "'%k'==='todo'"))}
          ${o.all ? '<p class="tc-note">Todas las tareas, subtareas, vistas, estados, campos y ajustes se importarán exactamente como están.</p>' : `<div class="tc-cks">${ck('tareas', 'Tareas')}${ck('sub', 'Subtareas', !el.tareas)}${ck('vistas', 'Vistas (incluye documento y pizarra)')}${ck('campos', 'Estados y campos personalizados')}${ck('ajustes', 'Ajustes del proyecto (descripción, prioridad, cobro)')}</div>`}
          <div class="tc-l" style="margin-top:12px">Personas asignadas a las tareas</div><div class="tc-cks">${[['plantilla', 'Las de la plantilla'], ['yo', 'Asignármelas a mí'], ['ninguno', 'Sin asignar']].map(([k, l]) => `<label class="tc-rd"><input type="radio" name="tc-rs" ${o.resp === k ? 'checked' : ''} onchange="SpacesModule.tcSet('resp','${k}')"><span>${l}</span></label>`).join('')}</div></div>
        <div class="tc-l">Fecha de inicio y fecha límite</div><div class="tc-box2">${_seg([['reprogramar', 'Reprogramar fechas', '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>'], ['ninguna', 'Sin fechas', '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>']], o.fechas, "SpacesModule.tcSeg('fechas','%k')")}
          ${o.fechas === 'reprogramar' ? `<p class="tc-note">Las fechas de la plantilla se mueven a partir de esta fecha de inicio${nuevo ? '' : ' (por defecto, la del proyecto)'}.</p><input class="tc-in" type="date" value="${esc(o.fecha)}" onchange="SpacesModule.tcSet('fecha',this.value)">` : '<p class="tc-note">Las tareas se crearán sin fecha de inicio ni fecha límite.</p>'}</div>
      </div></div>
      <div class="tc-uf"><span class="tc-info">${_SVGS('<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 14)} ${nuevo ? 'Esto creará un proyecto nuevo en el espacio elegido.' : 'Esto añadirá el contenido de la plantilla al proyecto elegido.'}</span><span><button class="btn btn--ghost btn--sm" onclick="SpacesModule.tcClose()">Cancelar</button> <button class="btn btn--primary btn--sm" id="tc-go" onclick="SpacesModule.tcGo()">Utilizar plantilla</button></span></div>`;
  }
  async function tcGo() {
    const o = _tc.o, t = _tc.cur, nuevo = o.dest === 'nuevo', f = o.fechas === 'reprogramar' ? o.fecha : '';
    if (nuevo && !o.client) { showBanner('Elige el cliente del proyecto', 'error'); return; }
    if (!nuevo && !o.pid) { showBanner('Elige el proyecto al que se aplicará', 'error'); return; }
    if (o.fechas === 'reprogramar' && !f) { showBanner('Elige la fecha de inicio', 'error'); return; }
    const btn = $q('tc-go'); if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
    try {
      let pid = o.pid, sid = 0;
      if (nuevo) {
        const r = await _post('/mgmt/projects', { nombre: (o.name || '').trim() || t.nombre, client_id: +o.client, estado: 'activo', fecha_inicio: f || _today(), prioridad: 'media', tipo_proyecto: 'fijo', moneda: 'USD', responsables: [], responsable: '' }); if (!r.ok) throw new Error(await _err(r, 'No se pudo crear el proyecto'));
        const np = await r.json(); pid = np.id; sid = +o.sid || 0; if (sid) await _post(`/mgmt/projects/${pid}/space`, { space_id: sid }, 'PATCH');
      } else { const pj = _pjOf(pid); sid = pj ? (pj.space_id || 0) : 0; }
      const el = o.el, all = o.all;
      const ra = await _post(`/mgmt/project-templates/${t.id}/apply`, { project_id: pid, fecha_inicio: f || undefined, fechas: o.fechas, responsables: o.resp, yo: _myNm(), con_tareas: all || el.tareas, con_subtareas: all || el.sub, con_vistas: all || el.vistas, con_campos: all || el.campos, aplicar_ajustes: all || el.ajustes, existentes: nuevo ? undefined : o.existentes });
      if (!ra.ok) throw new Error(await _err(ra, nuevo ? 'El proyecto se creó, pero no se pudo aplicar la plantilla' : 'No se pudo aplicar la plantilla'));
      const j = await ra.json(); tcClose(); showBanner(`✓ Plantilla aplicada (${j.tareas} tareas, ${j.vistas} vistas)`, 'success'); await _reload(); pick(sid, pid);
    } catch (e) { showBanner(e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Utilizar plantilla'; } }
  }
  const tplManage = () => tplCenter({});
  const tplApplyOpen = () => tplCenter({ pid: _pmPid });
  const tplCreateOpen = sid => tplCenter({ sid: sid || 0 });

  // ═══ Todos los proyectos (sustituye a la antigua sección «Proyectos») ═══
  function showProjects() { _mode = 'proyectos'; _selProj = null; _selSpace = null; _cfg = false; _save(); }
  function showTasks() { _mode = 'tasks'; _selProj = null; _selSpace = null; _cfg = false; _save(); }
  function openProject(pid) {
    const p = _projects.find(x => x.id === pid); _mode = 'tasks'; _cfg = false; _selProj = pid; _selSpace = p ? (p.space_id || 0) : 0; if (_selSpace != null) _openSp.add('p' + _selSpace); _save();
    if ($q('spaces-root') && _loaded) { _paintTree(); _paintMain(); }
  }
  const _PJE = [['activo', 'Activo', '#4194F6'], ['pausado', 'Pausado', '#F8AE00'], ['completado', 'Completado', '#6BC950'], ['cancelado', 'Cancelado', '#87909E']];
  const _pjProg = pid => { const ts = _tasks.filter(t => t.project_id === pid && !t.archivada && !t.parent_task_id); return { n: ts.length, done: ts.filter(t => t.estado === 'completado').length }; };
  function pjF(k, v) { if (k === 'e') _pfE = v; else if (k === 'p') _pfP = v; else if (k === 'c') _pfC = v; else if (k === 'me') _pMe = !_pMe; else if (k === 'q') { _pq = v; _paintPjTable(); return; } _paintMain(); }
  function _paintPjTable() {
    const box = $q('pj2-body'); if (!box) return;
    let ps = _projects.filter(p => !p.archivado);
    if (_pfE) ps = ps.filter(p => (p.estado || 'activo') === _pfE); else ps = ps.filter(p => (p.estado || 'activo') !== 'cancelado');
    if (_pMe) ps = ps.filter(p => _resp(p).some(n => _nrm(n) === _meName()));
    if (_pfP) ps = ps.filter(p => _resp(p).includes(_pfP));
    if (_pfC) ps = ps.filter(p => String(p.client_id) === _pfC);
    if (_pq) { const q = _nrm(_pq); ps = ps.filter(p => _nrm(p.nombre + ' ' + (p.client_nombre || '')).includes(q)); }
    const money = _projects.some(p => 'valor_total' in p), spN = id => id ? ((_spaces.find(s => s.id === id) || {}).nombre || '') : 'Principal';
    box.innerHTML = ps.length ? `<div class="pj2-r pj2-r--h"><div class="pj2-n">Proyecto</div><div class="pj2-c">Cliente</div><div class="pj2-e">Estado</div><div class="pj2-p">Equipo</div><div class="pj2-f">Fechas</div><div class="pj2-t">Tareas</div>${money ? '<div class="pj2-v">Valor</div>' : ''}<div class="pj2-x"></div></div>`
      + ps.map(p => { const e = _PJE.find(x => x[0] === (p.estado || 'activo')) || _PJE[0], g = _pjProg(p.id), pc = g.n ? Math.round(g.done / g.n * 100) : 0, rs = _resp(p);
        const ic = p.icono ? `<i class="sp-pj__e" style="${p.color ? 'background:' + p.color + '22' : ''}">${esc(p.icono)}</i>` : `<i class="pj2-dot" style="background:${p.color || '#007AFF'}"></i>`;
        return `<div class="pj2-r" onclick="SpacesModule.pick(${p.space_id || 0},${p.id})"><div class="pj2-n">${ic}<b title="${esc(p.nombre)} · ${esc(spN(p.space_id))}">${esc(p.nombre)}</b></div>
          <div class="pj2-c" title="${esc(p.client_nombre || '')}">${esc(p.client_nombre || '—')}</div>
          <div class="pj2-e"><button class="pj2-st" style="--c:${e[2]}" onclick="event.stopPropagation();SpacesModule.pjEst(event,${p.id})">${e[1]}</button></div>
          <div class="pj2-p">${rs.slice(0, 4).map(n => `<span class="sp-av" title="${esc(n)}">${esc(_ini(n))}</span>`).join('') || '<span class="sp-dim">—</span>'}</div>
          <div class="pj2-f">${p.fecha_inicio || p.fecha_fin ? `${_fmtD(_d10(p.fecha_inicio)) || '…'} → ${_fmtD(_d10(p.fecha_fin)) || '…'}` : '<span class="sp-dim">—</span>'}</div>
          <div class="pj2-t"><div class="pj2-bar"><i style="width:${pc}%"></i></div><span>${g.done}/${g.n}</span></div>
          ${money ? `<div class="pj2-v">${p.valor_total ? esc((p.moneda || 'USD') + ' ' + Number(p.valor_total).toLocaleString('es-ES')) : '<span class="sp-dim">—</span>'}</div>` : ''}
          <div class="pj2-x"><button class="sp-pj__m" style="opacity:1" title="Opciones del proyecto" onclick="event.stopPropagation();SpacesModule.projMenu(event,${p.id})">⋯</button></div></div>`; }).join('')
      : '<div class="sp-e" style="padding:30px;text-align:center">No hay proyectos con esos filtros.</div>';
  }
  function _paintProjects(m) {
    const names = [...new Set(_team.map(x => x.nombre).filter(Boolean))], cls = [...new Map(_projects.filter(p => p.client_id).map(p => [p.client_id, p.client_nombre || ('Cliente ' + p.client_id)])).entries()];
    const n = _projects.filter(p => !p.archivado && (p.estado || 'activo') === 'activo').length;
    m.innerHTML = `<div class="sp-top"><div class="sp-crumb"><b>Todos los proyectos</b><span class="sp-crumb__c">${n} activos</span></div></div>
      <div class="pj2-bar"><div class="pj2-bar__l"><label class="sp-search"><input value="${esc(_pq)}" placeholder="Buscar proyecto o cliente…" oninput="SpacesModule.pjF('q',this.value)"></label>
        <select class="pj2-sel" onchange="SpacesModule.pjF('e',this.value)"><option value="">Todos los estados</option>${_PJE.map(e => `<option value="${e[0]}"${_pfE === e[0] ? ' selected' : ''}>${e[1]}</option>`).join('')}</select>
        <select class="pj2-sel" onchange="SpacesModule.pjF('p',this.value)"><option value="">Toda persona</option>${names.map(x => `<option${_pfP === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <select class="pj2-sel" onchange="SpacesModule.pjF('c',this.value)"><option value="">Todo cliente</option>${cls.map(([id, nm]) => `<option value="${id}"${_pfC === String(id) ? ' selected' : ''}>${esc(nm)}</option>`).join('')}</select>
        <button type="button" class="sp-me${_pMe ? ' on' : ''}" title="Solo mis proyectos" onclick="SpacesModule.pjF('me')">${esc(_ini(window._authUser?.memberNombre || window._authUser?.name || 'Yo'))}</button></div>
        <button type="button" class="btn btn--primary btn--sm" onclick="SpacesModule.newProject(0)">＋ Proyecto</button></div>
      <div class="sp-body"><div id="pj2-body" class="pj2"></div></div>`;
    _paintPjTable();
  }
  function pjEst(ev, id) { ev.stopPropagation(); _openPop(ev.currentTarget, `<div class="sp-pop__h">Estado del proyecto</div>${_PJE.map(e => `<button class="sp-pop__i" onclick="SpacesModule.pjSetEst(${id},'${e[0]}')"><i class="sp-dot" style="background:${e[2]}"></i>${e[1]}</button>`).join('')}`); }
  async function pjSetEst(id, est) {
    _closePop(); const r = await _post(`/mgmt/projects/${id}/estado`, { estado: est }, 'PATCH');
    if (!r.ok) { showBanner(await _err(r, 'No se pudo cambiar el estado'), 'error'); return; }
    const p = _pjOf(id); if (p) p.estado = est; _paintMain(); _paintTree();
  }

  // ═══ Configuración del proyecto (pestaña junto a las vistas) ═══
  function cfgOpen() { _cfg = true; _closePop(); _paintMain(); }
  let _cfgSum = null, _cfgResp = [], _cfgRep = [];
  const _hh = s => (s / 3600).toFixed(1).replace(/\.0$/, '') + ' h', _mh = m => (m / 60).toFixed(1).replace(/\.0$/, '') + ' h';
  const _fv = v => (v == null || v === '') ? '' : String(v).replace(/\.00$/, '');
  async function _paintCfg() {
    const b = $q('sp-body'); if (!b) return; const p = _pjOf(_selProj); if (!p) return; const pid = p.id;
    b.innerHTML = '<div class="sp-load">Cargando configuración…</div>';
    let sum = { tareas: {}, tiempo: { por_persona: [] } };
    try {
      const [sr, cr] = await Promise.all([apiFetch(`${API}/mgmt/projects/${pid}/config-summary`), _clients.l ? null : apiFetch(`${API}/mgmt/clients`)]);
      if (sr.ok) sum = await sr.json(); if (cr && cr.ok) _clients.l = await cr.json();
    } catch (e) { console.error('[spaces] cfg', e); }
    if (!(_cfg && _selProj === pid) || !$q('sp-body')) return;
    _cfgEst = _custom(pid) ? p.estados.map(e => ({ ...e })) : _defSt.map(e => ({ ...e }));
    _cfgSum = sum; _cfgResp = [..._resp(p)]; _cfgRep = Array.isArray(p.reparto) ? p.reparto.map(r => ({ ...r })) : [];
    const money = 'valor_total' in p, t = sum.tiempo || { por_persona: [] }, tk = sum.tareas || {};
    const fld = (l, id, v, type, ph, hint) => `<label class="pcf-f"><span>${l}</span><input class="form-input" id="${id}" type="${type || 'text'}" value="${esc(v == null ? '' : v)}" placeholder="${ph || ''}"${type === 'number' ? ' step="any" min="0"' : ''}>${hint ? `<em>${hint}</em>` : ''}</label>`;
    const sel = (l, id, opts, cur) => `<label class="pcf-f"><span>${l}</span><select class="form-input" id="${id}">${opts.map(o => `<option value="${esc(o[0])}"${String(cur) === String(o[0]) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    const cl = (_clients.l || []).map(c => [c.id, c.nombre + (c.empresa ? ' · ' + c.empresa : '')]);
    const real = t.real_s || 0, est = t.est_min || 0, base = (+p.horas_estimadas || 0) * 3600 || est * 60, usoPc = base ? Math.round(real / base * 100) : null;
    const cs = sum.costos, pend = cs ? Math.max(0, cs.monto - cs.cobrado) : 0, hrs = real / 3600;
    const people = (t.por_persona || []).map(x => `<div class="pcf-pr"><span>${esc(x.nombre)}</span><b>${_hh(x.s)}</b></div>`).join('') || '<div class="sp-dim" style="font-size:.78rem">Aún no hay horas registradas.</div>';
    b.innerHTML = `<div class="pcf">
      <div class="pcf-hd"><div><b>Configuración del proyecto</b><span>Todo lo que define, mide y cobra este proyecto. El avance y las gráficas están en la vista Panel.</span></div><button class="btn btn--primary btn--sm" id="pcf-save" onclick="SpacesModule.cfgSave()">Guardar cambios</button></div>
      <div class="pcf-grid">
      <section class="pcf-c"><h4>Datos del proyecto</h4>
        ${fld('Nombre', 'cfg-nombre', p.nombre)}
        <div class="pcf-2">${sel('Cliente', 'cfg-cliente', cl.length ? cl : [[p.client_id, p.client_nombre || '']], p.client_id)}${sel('Estado', 'cfg-estado', _PJE.map(e => [e[0], e[1]]), p.estado || 'activo')}</div>
        <div class="pcf-2">${sel('Prioridad', 'cfg-prio', [['alta', 'Alta'], ['media', 'Media'], ['baja', 'Baja']], p.prioridad || 'media')}<span></span></div>
        <div class="pcf-2">${fld('Inicio', 'cfg-ini', _d10(p.fecha_inicio), 'date')}${fld('Fin', 'cfg-fin', _d10(p.fecha_fin), 'date')}</div>
        <label class="pcf-f"><span>Descripción</span><textarea class="form-input" id="cfg-desc" rows="3">${esc(p.descripcion || '')}</textarea></label>
        <div class="pcf-f"><span>Responsables</span><div class="pcf-chips">${[...new Set(_team.map(x => x.nombre).filter(Boolean))].map(n => `<button type="button" class="pcf-chip${_cfgResp.includes(n) ? ' on' : ''}" onclick="SpacesModule.cfgResp(this)" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>
      </section>
      <section class="pcf-c"><h4>Tiempo</h4>
        <div class="pcf-kpis"><div><b>${est ? _mh(est) : '—'}</b><span>Estimado en tareas</span></div><div><b>${_hh(real)}</b><span>Trabajado</span></div><div><b>${usoPc == null ? '—' : usoPc + '%'}</b><span>Del estimado${(+p.horas_estimadas) ? ' del proyecto' : ''}</span></div></div>
        <div class="pcf-2">${fld('Horas estimadas del proyecto', 'cfg-hest', _fv(p.horas_estimadas), 'number', 'ej. 120')}${fld('Horas por semana', 'cfg-hsem', _fv(p.horas_semanales), 'number', 'ej. 10')}</div>
        ${fld('Horario semanal', 'cfg-hor', p.horario_semanal || '', 'text', 'ej. Lun–Vie 9:00–13:00')}
        <div class="pcf-sub">Horas por persona</div>${people}
      </section>
      ${money ? `<section class="pcf-c"><h4>Costos y cobro</h4>
        <div class="pcf-2">${sel('Tipo de cobro', 'cfg-tipo', [['fijo', 'Precio fijo'], ['horas', 'Por horas']], p.tipo_proyecto || 'fijo')}${sel('Moneda', 'cfg-mon', ['USD', 'EUR', 'COP', 'MXN', 'ARS', 'PEN', 'CLP', 'BRL'].map(x => [x, x]), p.moneda || 'USD')}</div>
        <div class="pcf-2">${fld('Valor total', 'cfg-valor', _fv(p.valor_total), 'number')}${fld('Tarifa por hora', 'cfg-tarifa', _fv(p.tarifa_hora), 'number')}</div>
        <div class="pcf-2">${fld('Comisión (%)', 'cfg-com', _fv(p.comision), 'number')}${fld('Precio semanal', 'cfg-psem', _fv(p.precio_semanal), 'number')}</div>
        <label class="sp-ck"><input type="checkbox" id="cfg-cobro"${p.cobro_semanal ? ' checked' : ''}><span>Cobro semanal automático<em>crea cada semana la tarea de cobro</em></span></label>
        ${cs ? `<div class="pcf-kpis"><div><b>${_m(cs.monto, p)}</b><span>Facturado en tareas</span></div><div><b>${_m(cs.cobrado, p)}</b><span>Cobrado</span></div><div><b>${_m(pend, p)}</b><span>Pendiente</span></div></div>${p.valor_total && hrs > 0 ? `<div class="pcf-note">Valor efectivo: <b>${_m(+p.valor_total / hrs, p)} por hora trabajada</b></div>` : ''}` : ''}
        <div class="pcf-sub">Reparto entre el equipo <em id="cfg-rep-sum"></em></div><div id="cfg-rep"></div>
        <button type="button" class="pcf-add" onclick="SpacesModule.cfgRepAdd()">＋ Añadir persona al reparto</button>
      </section>` : ''}
      <section class="pcf-c pcf-c--wide"><h4>Estados del proyecto</h4>
        <p class="pcf-p">Los estados que usa este tipo de trabajo. Cada uno pertenece a una categoría: es lo que entiende el resto del sistema (Mi trabajo, Dashboard, cobros). ${_custom(pid) ? '' : '<b>Ahora usa los 5 estados de siempre.</b>'}</p>
        <div id="cfg-est"></div>
        <div class="pcf-btns"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgEstAdd()">＋ Añadir estado</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgEstSave(true)">Volver a los 5 de siempre</button><button class="btn btn--primary btn--sm" onclick="SpacesModule.cfgEstSave()">Guardar estados</button></div>
      </section>
      <section class="pcf-c"><h4>Campos personalizados</h4>
        <p class="pcf-p">Columnas propias de este proyecto (texto, fecha, listas, etiquetas, dinero…). Elige cuáles se ven en la lista.</p>
        <div id="cfg-fld"></div>
        <div class="pcf-btns"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.fieldsOpen()">Administrar campos…</button></div>
      </section>
      <section class="pcf-c"><h4>Equipo y acceso</h4>
        <p class="pcf-p">Quién puede ver y trabajar en este proyecto, aparte de quienes lo ven por su rol.</p>
        <button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('share')">Uso compartido y permisos…</button>
      </section>
      <section class="pcf-c"><h4>Plantillas y valores por defecto</h4>
        <p class="pcf-p">Reutiliza la estructura de este proyecto o define cómo nacen sus tareas.</p>
        <div class="pcf-btns"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('td')">Tarea predeterminada…</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('tplSave')">Guardar como plantilla…</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('tplApply')">Aplicar una plantilla…</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('imp')">Importar tareas…</button></div>
      </section>
      <section class="pcf-c pcf-c--danger"><h4>Acciones del proyecto</h4>
        <div class="pcf-btns"><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('dup')">Duplicar</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('link')">Copiar vínculo</button><button class="btn btn--ghost btn--sm" onclick="SpacesModule.cfgAct('arc')">Archivar</button><button class="btn btn--ghost btn--danger btn--sm" onclick="SpacesModule.cfgAct('del')">Eliminar</button></div>
      </section></div></div>`;
    _cfgRepPaint(); _cfgEstPaint(); _cfgFldPaint();
  }
  const _clients = { l: null };
  const _m = (v, p) => (p.moneda || 'USD') + ' ' + Number(v || 0).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  function cfgResp(btn) { btn.classList.toggle('on'); const n = btn.dataset.n; _cfgResp = btn.classList.contains('on') ? [...new Set([..._cfgResp, n])] : _cfgResp.filter(x => x !== n); }
  function _cfgRepPaint() {
    const box = $q('cfg-rep'); if (!box) return; const names = [...new Set(_team.map(x => x.nombre).filter(Boolean))];
    box.innerHTML = _cfgRep.map((r, i) => `<div class="pcf-rr"><select class="form-input" onchange="SpacesModule.cfgRepSet(${i},'nombre',this.value)">${names.map(n => `<option${n === r.nombre ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><input class="form-input" type="number" min="0" max="100" value="${r.pct}" oninput="SpacesModule.cfgRepSet(${i},'pct',this.value)"><span>%</span><button type="button" class="sp-pj__m" style="opacity:1" onclick="SpacesModule.cfgRepDel(${i})">✕</button></div>`).join('') || '<div class="sp-dim" style="font-size:.78rem">Sin reparto: el 100 % es del responsable.</div>';
    const tot = _cfgRep.reduce((a, r) => a + (+r.pct || 0), 0), s = $q('cfg-rep-sum'); if (s) s.textContent = _cfgRep.length ? `· suma ${tot}%` : '';
    if (s) s.style.color = _cfgRep.length && tot !== 100 ? '#D9534F' : '';
  }
  function cfgRepAdd() { const names = [...new Set(_team.map(x => x.nombre).filter(Boolean))], used = new Set(_cfgRep.map(r => r.nombre)); _cfgRep.push({ nombre: names.find(n => !used.has(n)) || names[0] || '', pct: _cfgRep.length ? 0 : 100 }); _cfgRepPaint(); }
  function cfgRepSet(i, k, v) { if (_cfgRep[i]) { _cfgRep[i][k] = k === 'pct' ? (+v || 0) : v; if (k === 'pct') { const tot = _cfgRep.reduce((a, r) => a + (+r.pct || 0), 0), s = $q('cfg-rep-sum'); if (s) { s.textContent = `· suma ${tot}%`; s.style.color = tot !== 100 ? '#D9534F' : ''; } } } }
  function cfgRepDel(i) { _cfgRep.splice(i, 1); _cfgRepPaint(); }
  function cfgAct(a) {
    _pmPid = _selProj; if (!_pjOf(_pmPid)) return;
    ({ share: pmShare, td: tdOpen, tplSave: tplSaveOpen, tplApply: tplApplyOpen, imp: impOpen, dup: pmDup, link: pmLink, arc: pmArch, del: pmDel })[a]();
  }
  async function cfgSave() {
    const p = _pjOf(_selProj); if (!p) return; const v = id => (document.getElementById(id) || {}).value, num = id => { const x = v(id); return x === '' || x == null ? null : +x; };
    const nombre = String(v('cfg-nombre') || '').trim(); if (!nombre) { showBanner('El proyecto necesita un nombre', 'error'); return; }
    const body = { nombre, client_id: +v('cfg-cliente') || p.client_id, descripcion: v('cfg-desc') || '', prioridad: v('cfg-prio'), fecha_inicio: v('cfg-ini') || null, fecha_fin: v('cfg-fin') || null, responsables: _cfgResp, horas_estimadas: num('cfg-hest'), horas_semanales: num('cfg-hsem'), horario_semanal: v('cfg-hor') || '' };
    const money = 'valor_total' in p;
    if (money) {
      Object.assign(body, { tipo_proyecto: v('cfg-tipo'), moneda: v('cfg-mon'), valor_total: num('cfg-valor'), tarifa_hora: num('cfg-tarifa'), comision: num('cfg-com') });
      const tot = _cfgRep.reduce((a, r) => a + (+r.pct || 0), 0); if (_cfgRep.length && tot !== 100) { showBanner('El reparto debe sumar 100 % (ahora suma ' + tot + ' %)', 'error'); return; }
    }
    const btn = $q('pcf-save'); if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      body.estado = p.estado || 'activo';                                   // el PUT no cambia el estado: eso va por su propia ruta (cierra clientes sin proyectos activos)
      const r = await _post(`/mgmt/projects/${p.id}`, body, 'PUT'); if (!r.ok) throw new Error(await _err(r, 'No se pudo guardar'));
      const nuevoEst = v('cfg-estado'); if (nuevoEst && nuevoEst !== (p.estado || 'activo')) { const re = await _post(`/mgmt/projects/${p.id}/estado`, { estado: nuevoEst }, 'PATCH'); if (!re.ok) throw new Error(await _err(re, 'No se pudo cambiar el estado')); }
      if (money) { const rb = await _post(`/mgmt/projects/${p.id}/billing-cfg`, { cobro_semanal: !!(document.getElementById('cfg-cobro') || {}).checked, precio_semanal: num('cfg-psem'), reparto: _cfgRep }, 'PATCH'); if (!rb.ok) throw new Error(await _err(rb, 'No se pudo guardar el cobro')); }
      showBanner('✓ Proyecto guardado', 'success'); await _reload(); _cfg = true; _paintMain();
    } catch (e) { showBanner(e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios'; } }
  }

  // ═══ Tareas y subtareas: mismo menú, cronómetro y tarjetas que tenía Tareas ═══
  function ctx(ev, id) { ev.preventDefault(); ev.stopPropagation(); _adopt(); TasksModule.openKanbanMenu(ev, id); }
  function addSub(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openDrawer(null, null, id); }
  function menu(ev, id) { ev.stopPropagation(); _adopt(); TasksModule.openKanbanMenu(ev, id); }

  function showProjectsGo() { showProjects(); _paintTree(); _paintMain(); }

  return { tplCenter, tcClose, tcQ, tcFilter, tcOpen, tcBack, tcSlide, tcAcc, tcUse, tcDD, tcDDQ, tcDDPick, tcSet, tcSeg, tcEl, tcGo, fdClose, fdTab, fdQ, fdFold, fmCol, fmAggVis, isCustom: pid => _custom(pid), ensure, statusTag, chipsFor, fieldKeys, fcellFor, fEdit, fSet, fTog, renderTaskFields, fieldsOpen, fmBack, fmNew, fmEdit, fmVis, fmVisPop, fmDel, fmAdd, fmSave, cfgEstSet, cfgEstMove, cfgEstDel, cfgEstAdd, cfgEstSave, showProjects, showTasks, showProjectsGo, openProject, pjF, pjEst, pjSetEst, cfgOpen, cfgSave, cfgResp, cfgRepAdd, cfgRepSet, cfgRepDel, cfgAct, ctx, addSub, menu, load, render, _fromTasks, toggleSp, pick, newSpace, cancelSpace, saveSpace, spaceMenu, spaceOpts, newProject, moveProj, renameSpace, delSpace,
    tkToggleEmpty, fieldsOpenFor, toggleDone, treeSearch, treeQ, treeClear, treeMenu, treeAct, mgOpen, mgAct, projMenu, pmShare, shareSpace, pmBack, pmSub, pmFav, pmRename, pmLink, pmNewTask, pmAddView, pmMove, pmStyle, pmArch, pmDel, pmInfo, pmDup, pmDupGo, tplSaveOpen, tplSaveGo, tplRefreshOpen, tplRefreshGo, tplApplyOpen, tplApplyGo, tplCreateOpen, tplCreateGo, tplManage, tplRename, tplDelete, tdOpen, tdSave, tdClear, impOpen, impRead, impGo,
    docCmd, wbAdd, wbDel, setView, selView, viewMenu, addView, viewOpts, renameView, delView, calNav, ganttScale, formSend, setGroup, toggleSubs, toggleClosed, toggleMe, setQ, groupMenu, filterMenu, persMenu, fEstado, fPrio, fPers, clearFilters, colsMenu, toggleCol,
    toggleG, toggleT, drop, estMenu, setEstado, prio, resp, date, newTask, slashPick, slashHover, docColor, docColorSet, docTitle };
})();
