// ═══════════════════════════════════════════════════════════════
// Espacios (Operaciones): árbol Espacio → Proyecto («lista») y vista de lista estilo ClickUp con agrupar, columnas, filtros y subtareas.
// Usa los mismos datos y el mismo menú/panel que Tareas (TasksModule), así que todo cambio se refleja en ambos sitios.
// ═══════════════════════════════════════════════════════════════
const SpacesModule = (() => {
  const LS = 'nova_spaces_ui';
  let _spaces = [], _projects = [], _tasks = [], _team = [], _loaded = false, _views = [], _viewSel = {}, _calRef = null, _ganttScale = 'semana';
  let _selSpace = null, _selProj = null;             // null/null = Todas las tareas
  let _view = 'lista', _group = 'estado', _showClosed = false, _expandSubs = true, _q = '', _me = false, _fEstado = [], _fPrio = [], _fPers = [];
  let _cols = ['prioridad'];                           // columnas extra visibles (además de Nombre · Estado · Fecha límite · Persona)
  const _collapsedG = new Set(), _collapsedT = new Set(), _openSp = new Set(['p0']);
  let _pop = null, _popOff = null, _addingSpace = false;
  try { const u = JSON.parse(localStorage.getItem(LS) || '{}'); if (u.view) _view = u.view; if (u.group) _group = u.group; if (Array.isArray(u.cols)) _cols = u.cols; if (typeof u.expandSubs === 'boolean') _expandSubs = u.expandSubs; if (u.selProj) _selProj = u.selProj; if (u.selSpace != null) _selSpace = u.selSpace; if (u.viewSel) _viewSel = u.viewSel; } catch (_) {}
  const _save = () => { try { localStorage.setItem(LS, JSON.stringify({ view: _view, group: _group, cols: _cols, expandSubs: _expandSubs, selProj: _selProj, selSpace: _selSpace, viewSel: _viewSel })); } catch (_) {} };
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
      const [sr, pr, tr, mr, vr] = await Promise.all([apiFetch(`${API}/mgmt/spaces`), apiFetch(`${API}/mgmt/projects`), apiFetch(`${API}/mgmt/tasks`), apiFetch(`${API}/mgmt/team`), apiFetch(`${API}/mgmt/space-views`)]);
      _views = vr.ok ? await vr.json() : [];
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
  function selView(id) { _viewSel[_sk()] = id; _closePop(); _save(); _paintMain(); }
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
    const cv = _curView(); _view = cv.tipo;
    const listish = ['lista', 'tabla', 'tablero'].includes(_view), noBar = ['formulario', 'documento', 'pizarra'].includes(_view);
    const ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const meOn = _me, persOn = _fPers.length;
    m.innerHTML = `<div class="sp-top"><div class="sp-crumb">${sp ? `<span class="sp-sq sp-sq--s" style="background:${sp.color || '#7C5CE0'}">${_nrm(sp.nombre).slice(0, 1).toUpperCase()}</span><span class="sp-crumb__a">${esc(sp.nombre)}</span><span class="sp-crumb__s">/</span>` : ''}<b>${p ? esc(p.nombre) : (sp ? 'Todas las listas' : 'Todas las tareas')}</b>${p && p.client_nombre ? `<span class="sp-crumb__c">${esc(p.client_nombre)}</span>` : ''}</div>
        ${p ? `<button type="button" class="sp-link" onclick="abrirVentanaProyecto(${p.id})">Abrir proyecto ›</button>` : ''}</div>
      <div class="sp-tabs">${_viewsOf(_sk()).map(v => `<span class="sp-tab sp-tab--v${cv.id === v.id ? ' on' : ''}" title="${esc(v.nombre || (_VT[v.tipo] || [''])[0])}" onclick="SpacesModule.selView('${v.id}')"><i class="sp-tab__i" style="color:${(_VT[v.tipo] || _VT.lista)[2]}">${_ico((_VT[v.tipo] || _VT.lista)[3])}</i><b class="sp-tab__x" title="Renombrar o quitar" onclick="SpacesModule.viewOpts(event,'${v.id}')">⋯</b></span>`).join('')}<button type="button" class="sp-tab sp-tab--add" title="Añadir vista" onclick="SpacesModule.viewMenu(event)">＋</button></div>
      ${noBar ? '' : `<div class="sp-bar"><div class="sp-bar__l">
          ${listish ? `<button type="button" class="sp-chip" onclick="SpacesModule.groupMenu(event)">${ico('<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>')} ${{ estado: 'Estado', prioridad: 'Prioridad', persona: 'Persona', fecha: 'Fecha límite', ninguno: 'Sin agrupar' }[_group]}</button>
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
    const b = $q('sp-body'); if (!b) return;
    _colStop();
    if (_view === 'formulario') { _paintForm(b); return; }
    if (_view === 'documento') { _paintDoc(b); return; }
    if (_view === 'pizarra') { _paintWb(b); return; }
    let all = _scope().filter(_passes);
    if (_view === 'panel') { _paintPanel(b, all); return; }
    if (!_showClosed) all = all.filter(t => _isOpen(t) || all.some(c => c.parent_task_id === t.id && _isOpen(c)));
    if (_view === 'tablero') { _paintBoard(b, all); return; }
    if (_view === 'calendario') { _paintCal(b, all); return; }
    if (_view === 'gantt') { _paintGantt(b, all); return; }
    if (_view === 'galeria') { _paintGal(b, all); return; }
    _paintList(b, all);
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
      if (_col.apply) _col.apply(j.config); _setSt(_col.pend.set.size || _col.pend.del.size ? 'Guardando…' : '✓ Guardado');
    } catch (e) {
      _col.sending = false; p.set.forEach((d, id) => { if (!_col.pend.set.has(id)) _col.pend.set.set(id, d); }); p.del.forEach(id => _col.pend.del.add(id)); if (p.order && !_col.pend.order) _col.pend.order = p.order;
      _setSt('No se pudo guardar · reintentando…'); clearTimeout(_col.sendT); _col.sendT = setTimeout(_colFlush, 3000);
    }
  }
  const _PCOL = ['#2F6BFF', '#E8920F', '#2E9E5B', '#D9534F', '#7C5CE0', '#0891B2'];
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

  // ── Documento (por bloques) ──
  const _blkHtml = (b, n) => `<div class="sp-blk sp-blk--${b.t}" data-id="${esc(b.id)}" data-t="${b.t}"${b.t === 'ol' ? ` data-n="${n}"` : ''}>${_clean(b.html) || '<br>'}</div>`;
  let _docLast = new Map(), _docOrder = '';
  function _numberOl() { let n = 0; document.querySelectorAll('#sp-doc > .sp-blk').forEach(x => { if (x.dataset.t === 'ol') { n++; x.dataset.n = n; } else n = 0; }); }
  function _docNorm() {
    const ed = $q('sp-doc'); if (!ed) return;
    const seen = new Set();
    [...ed.childNodes].forEach(n => { if (n.nodeType === 3 || (n.nodeType === 1 && !/^(DIV|P|H1|H2|LI)$/.test(n.tagName))) { const d = document.createElement('div'); n.replaceWith(d); d.appendChild(n); } });
    [...ed.children].forEach(c => {
      if (c.tagName !== 'DIV') { const d = document.createElement('div'); d.innerHTML = c.innerHTML; c.replaceWith(d); c = d; }
      c.classList.add('sp-blk'); const t = ['p', 'h1', 'h2', 'ul', 'ol'].includes(c.dataset.t) ? c.dataset.t : 'p'; c.dataset.t = t;
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
    const blocks = [...ed.children].map(c => ({ id: c.dataset.id, t: c.dataset.t, html: c.innerHTML === '<br>' ? '' : c.innerHTML })), ids = blocks.map(x => x.id), order = ids.join(',');
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
        if (el.dataset.t !== b.t) { el.dataset.t = b.t; el.className = 'sp-blk sp-blk--' + b.t; }
        const cur = el.innerHTML === '<br>' ? '' : el.innerHTML, nh = _clean(b.html); if (cur !== nh) el.innerHTML = nh || '<br>';
        if (ed.children[i] !== el && !dirty.has(b.id)) ed.insertBefore(el, ed.children[i] || null);
      }
      if (!dirty.has(b.id)) _docLast.set(b.id, b.t + '|' + (b.html || ''));
    });
    const ids = new Set(want.map(b => b.id)); [...ed.children].forEach(c => { if (!ids.has(c.dataset.id) && !dirty.has(c.dataset.id)) { c.remove(); _docLast.delete(c.dataset.id); } });
    _numberOl(); _docOrder = [...ed.children].map(c => c.dataset.id).join(',');
  }
  function _paintDoc(b) {
    const v = _curView(); if (v.virtual) { b.innerHTML = '<div class="sp-e sp-e--c">Añade un documento con «＋ Vista».</div>'; return; }
    const btn = (c, l, t) => `<button type="button" class="sp-dtb" title="${t}" onmousedown="event.preventDefault();SpacesModule.docCmd('${c}')">${l}</button>`;
    const cfg = v.config && Array.isArray(v.config.blocks) ? v.config : { blocks: [{ id: 'b0', t: 'p', html: (v.config && typeof v.config.html === 'string') ? v.config.html : '' }], rev: (v.config && v.config.rev) || 0 };
    b.innerHTML = `<div class="sp-docw"><div class="sp-dtbar">${btn('t:h1', 'H1', 'Título')}${btn('t:h2', 'H2', 'Subtítulo')}${btn('t:p', '¶', 'Párrafo')}${btn('t:ul', '• Lista', 'Lista con viñetas')}${btn('t:ol', '1. Lista', 'Lista numerada')}<span class="sp-dtbar__s"></span>${btn('bold', '<b>B</b>', 'Negrita')}${btn('italic', '<i>I</i>', 'Cursiva')}${btn('underline', '<u>U</u>', 'Subrayado')}${btn('strikeThrough', '<s>S</s>', 'Tachado')}${btn('link', 'Enlace', 'Enlace')}${btn('removeFormat', 'Limpiar', 'Quitar formato')}<span class="sp-pres" id="sp-pres"></span><span class="sp-dtbar__st" id="sp-doc-st">✓ Guardado</span></div>
      <div class="sp-doc" id="sp-doc" contenteditable="true" spellcheck="true">${cfg.blocks.map((x, i) => _blkHtml(x, i + 1)).join('')}</div></div>`;
    v.config = cfg; _docLast = new Map(cfg.blocks.map(x => [x.id, x.t + '|' + (x.html || '')])); _docOrder = cfg.blocks.map(x => x.id).join(','); _numberOl();
    const ed = $q('sp-doc');
    ed.addEventListener('input', _docSync);
    ed.addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text/plain'); if (t == null) return; e.preventDefault(); document.execCommand('insertText', false, t); });
    ed.addEventListener('keydown', e => {
      const cur = _curBlock(); if (!cur) return;
      if (e.key === 'Enter' && !e.shiftKey && ['ul', 'ol'].includes(cur.dataset.t) && !cur.textContent.trim()) { e.preventDefault(); cur.dataset.t = 'p'; cur.className = 'sp-blk sp-blk--p'; _docSync(); return; }
      if (e.key === 'Enter' && !e.shiftKey && ['h1', 'h2'].includes(cur.dataset.t)) setTimeout(() => { const c2 = _curBlock(); if (c2 && c2 !== cur && /^h/.test(c2.dataset.t)) { c2.dataset.t = 'p'; c2.className = 'sp-blk sp-blk--p'; _docSync(); } }, 0);
      if (e.key === 'Backspace' && cur.dataset.t !== 'p') { const sel = getSelection(); if (sel && sel.isCollapsed) { const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(cur); r.setEnd(sel.anchorNode, sel.anchorOffset); if (!r.toString().length) { e.preventDefault(); cur.dataset.t = 'p'; cur.className = 'sp-blk sp-blk--p'; _docSync(); } } }
    });
    _colStart(v, 'sp-doc-st', _docApply); _colPoll();
  }
  function _curBlock() { const sel = getSelection(); const n = sel && sel.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && el.closest ? el.closest('#sp-doc > .sp-blk') : null; }
  function docCmd(c) {
    const ed = $q('sp-doc'); if (!ed) return; ed.focus();
    if (c.startsWith('t:')) { const cur = _curBlock(); if (!cur) return; const t = c.slice(2); cur.dataset.t = (cur.dataset.t === t && t !== 'p') ? 'p' : t; cur.className = 'sp-blk sp-blk--' + cur.dataset.t; }
    else if (c === 'link') { const u = prompt('Dirección del enlace (https://…)'); if (u && /^https?:\/\//i.test(u)) document.execCommand('createLink', false, u); }
    else document.execCommand(c, false, null);
    _docSync();
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
        <div class="sp-dc"><h4>Por lista (abiertas)</h4>${bars(porProj, '#7C5CE0')}</div><div class="sp-dc"><h4>Por prioridad (abiertas)</h4>${bars(porPrio)}</div>
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
    docCmd, wbAdd, wbDel, setView, selView, viewMenu, addView, viewOpts, renameView, delView, calNav, ganttScale, formSend, setGroup, toggleSubs, toggleClosed, toggleMe, setQ, groupMenu, filterMenu, persMenu, fEstado, fPrio, fPers, clearFilters, colsMenu, toggleCol,
    toggleG, toggleT, drop, estMenu, setEstado, prio, resp, date, newTask };
})();
