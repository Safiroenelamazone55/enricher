'use strict';
// Roles y permisos (Configuración › Roles y permisos) + «Uso compartido» de espacios/proyectos + menús ocultos según permiso.
// Todo se aplica de verdad en el servidor (services/permissions.js); aquí solo se muestra y se edita.
const PermsUI = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NIVELES = ['Sin acceso', 'Ver', 'Editar', 'Administrar'];
  const SHARE = { ver: 'Solo ver', comentar: 'Comentar', editar: 'Editar', completo: 'Acceso completo' };
  let _cat = null, _rol = 'miembro', _draft = {}, _persona = null, _pdraft = {};

  // ── menús: lo que no puedes usar no aparece ──
  const TAB_MOD = { 'mgmt-dashboard': 'dashboard', 'mgmt-mywork': 'mywork', 'mgmt-opportunities': 'oportunidades', 'mgmt-clients': 'clientes', 'mgmt-projects': 'proyectos', 'mgmt-spaces': 'espacios', 'mgmt-tasks': 'tareas', 'mgmt-calendar': 'calendario', 'mgmt-timetracking': 'tiempo', 'mgmt-team': 'equipo', 'mgmt-chat': 'slack', 'mgmt-wa': 'whatsapp', 'mgmt-blocks': 'bloqueos' };
  const MOD_MOD = { enricher: 'datos', cantera: 'datos', herramientas: 'datos', leadmanagement: 'outreach', finance: 'finanzas', contenido: 'contenido', plantillas: 'plantillas', config: 'config' };
  function applyNav() {
    const u = window._authUser; if (!u || u.isOwner || !u.permisos) return;
    const no = k => !(u.permisos[k] && u.permisos[k].n > 0);
    document.querySelectorAll('.snav-item[data-tab]').forEach(b => { const m = TAB_MOD[b.dataset.tab]; if (m && no(m)) b.style.display = 'none'; });
    document.querySelectorAll('.snav-mod[data-module]').forEach(b => { const m = MOD_MOD[b.dataset.module]; if (m && no(m)) b.style.display = 'none'; });
    if (u.permisos.config && u.permisos.config.n < 3) document.querySelectorAll('#snav-body-config .snav-item[data-sec="permisos"]').forEach(b => { b.style.display = 'none'; });
  }
  (function wait(n) { if (window._authUser) return applyNav(); if (n < 60) setTimeout(() => wait(n + 1), 400); })(0);

  const api = async (u, o) => { const r = await apiFetch(API + u, o); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Error'); return j; };
  const put = (u, b) => api(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  // ── presentación: pestañas Roles · Personas · Clientes; cada módulo con botones de nivel ──
  const HINT = { dashboard: 'Panel de resumen', mywork: 'Su trabajo del día', oportunidades: 'Pipeline de oportunidades', clientes: 'Cartera de clientes', proyectos: 'Proyectos y plantillas', espacios: 'Espacios y vistas', tareas: 'Tareas y subtareas', calendario: 'Calendario y reuniones', tiempo: 'Horas trabajadas', equipo: 'Personas del equipo', finanzas: 'Montos, cobros y pagos', slack: 'Chat con los clientes', whatsapp: 'Chats y líneas', bloqueos: 'Bloqueos reportados', outreach: 'Contactos, secuencias, Inbox y llamadas', datos: 'Enriquecimiento, Cantera y herramientas', contenido: 'Calendario de contenido', plantillas: 'Plantillas de mensajes', config: 'Usuarios, integraciones y roles' };
  const LV = [['Sin acceso', 'No lo ve ni en el menú'], ['Ver', 'Puede consultar, no cambiar nada'], ['Editar', 'Puede crear y modificar'], ['Administrar', 'Además puede borrar y configurar']];
  let _tab = 'roles', _pmOpen = false;
  const tgt = () => (_pmOpen ? _pdraft : _draft);
  const baseOf = () => (_pmOpen ? _cat.efectivos[_pdraft.__rol || 'miembro'] : _cat.efectivos[_rol]);

  // una fila de módulo: nombre + ayuda, botones de nivel y alcance
  function row(m, v, o) {
    const inh = o.inherit && !v, eff = v || (o.base && o.base[m.k]) || { n: 0, a: 'todo' };
    const seg = LV.map(([l, tip], i) => `<button type="button" class="pm2-sg${!inh && eff.n === i ? ' on n' + i : ''}" title="${tip}" onclick="PermsUI.setN('${m.k}',${i})">${l}</button>`).join('');
    const rolBtn = o.inherit ? `<button type="button" class="pm2-sg pm2-sg--rol${inh ? ' on' : ''}" title="Usa lo que define su rol (${LV[eff.n][0]})" onclick="PermsUI.setN('${m.k}',-1)">Según rol</button>` : '';
    const sc = m.alc && eff.n > 0 && !inh ? `<div class="pm2-sc">Qué ve <button type="button" class="pm2-pill${eff.a === 'todo' ? ' on' : ''}" onclick="PermsUI.setA('${m.k}','todo')">Todo el equipo</button><button type="button" class="pm2-pill${eff.a === 'suyo' ? ' on' : ''}" onclick="PermsUI.setA('${m.k}','suyo')">${m.k === 'outreach' ? 'Solo sus clientes asignados' : 'Solo lo suyo y lo compartido'}</button></div>` : '';
    return `<div class="pm2-row"><div class="pm2-row__t"><b>${esc(m.l)}</b><span>${esc(HINT[m.k] || '')}</span></div><div class="pm2-row__c"><div class="pm2-segs">${rolBtn}${seg}</div>${sc}</div></div>`;
  }
  function rows(vals, o) {
    let g = '', h = '';
    for (const m of _cat.modulos) { if (m.g !== g) { g = m.g; h += `<div class="pm2-g">${esc(g)}</div>`; } h += row(m, vals[m.k], o); }
    return h;
  }
  function summary(eff) {
    const lv = m => (eff[m.k] ? eff[m.k].n : 0), names = f => _cat.modulos.filter(m => f(lv(m))).map(m => m.l);
    const li = (c, t, a) => a.length ? `<div class="pm2-sm__r"><i class="${c}"></i><span><b>${t}</b> ${esc(a.join(', '))}</span></div>` : '';
    return `<div class="pm2-sm">${li('g', 'Puede trabajar en:', names(n => n >= 2))}${li('b', 'Solo consultar:', names(n => n === 1))}${li('x', 'Sin acceso a:', names(n => n === 0))}</div>`;
  }
  const dirty = () => JSON.stringify(_draft) !== JSON.stringify(_cat.efectivos[_rol]);

  async function load() {
    const root = document.getElementById('cfg-permisos-mount'); if (!root) return;
    root.innerHTML = '<p class="pm-p">Cargando…</p>';
    try { _cat = await api('/perms/catalog'); } catch (e) { root.innerHTML = `<p class="pm-p">${esc(e.message)}</p>`; return; }
    if (!['manager', 'miembro', 'lector'].includes(_rol)) _rol = 'miembro';
    _draft = JSON.parse(JSON.stringify(_cat.efectivos[_rol])); paint();
  }
  function tab(t) { _tab = t; paint(); }
  function pickRol(r) { if (dirty() && !confirm('Tienes cambios sin guardar en este rol. ¿Descartarlos?')) return; _rol = r; _draft = JSON.parse(JSON.stringify(_cat.efectivos[r])); paint(); }
  function paint() {
    const root = document.getElementById('cfg-permisos-mount'); if (!root || !_cat) return;
    const tabs = [['roles', 'Roles', 'Qué puede hacer cada tipo de persona'], ['personas', 'Personas', 'Rol y ajustes de cada una'], ['clientes', 'Clientes outbound', 'Quién trabaja en cada cliente']];
    root.innerHTML = `<div class="pm2">
      <p class="pm2-intro">Define <b>quién puede hacer qué</b>. Cada persona tiene un <b>rol</b> con permisos ya preparados; los puedes ajustar por rol y también persona por persona. Los <b>Administradores</b> ven y gestionan todo, y son quienes supervisan y asignan.</p>
      <div class="pm2-tabs">${tabs.map(([k, l, d]) => `<button class="pm2-tab${_tab === k ? ' on' : ''}" onclick="PermsUI.tab('${k}')"><b>${l}</b><span>${d}</span></button>`).join('')}</div>
      <div id="pm2-body"></div></div>`;
    ({ roles: paintRoles, personas: paintPersonas, clientes: paintClientsTab })[_tab]();
  }
  function paintRoles() {
    const R = k => _cat.roles.find(r => r.k === k), edit = ['manager', 'miembro', 'lector'];
    document.getElementById('pm2-body').innerHTML = `<div class="pm2-roles">
      <div class="pm2-rl">${edit.map(k => `<button class="pm2-rb${_rol === k ? ' on' : ''}" onclick="PermsUI.pickRol('${k}')"><b>${esc(R(k).l)}</b><span>${esc(R(k).d)}</span></button>`).join('')}
        <div class="pm2-rb pm2-rb--fix"><b>Administrador</b><span>Siempre tiene acceso total. No se puede restringir.</span></div></div>
      <div class="pm2-card" id="pm2-rp"></div></div>`;
    paintRolePanel();
  }
  function paintRolePanel() {
    const R = _cat.roles.find(r => r.k === _rol), d = dirty(), cus = !!_cat.personalizados[_rol], el = document.getElementById('pm2-rp'); if (!el) return;
    el.innerHTML = `<div class="pm2-hd"><div><h4>${esc(R.l)}</h4><span>${cus ? 'Permisos personalizados' : 'Permisos predeterminados'}</span></div><div class="pm2-hd__b">
        ${cus ? '<button class="btn btn--ghost btn--sm" onclick="PermsUI.resetRol()">Volver al predeterminado</button>' : ''}<button class="btn btn--primary btn--sm" ${d ? '' : 'disabled'} onclick="PermsUI.saveRol()">${d ? 'Guardar cambios' : 'Sin cambios'}</button></div></div>
      ${summary(_draft)}
      <div class="pm2-lg">${LV.map(([l, t], i) => `<span><i class="n${i}"></i><b>${l}</b> ${t}</span>`).join('')}</div>
      <div class="pm2-rows">${rows(_draft, {})}</div>`;
  }
  function paintPersonas() {
    const R = k => (_cat.roles.find(r => r.k === k) || { l: k }).l, ini = n => (n || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
    document.getElementById('pm2-body').innerHTML = `<div class="pm2-card pm2-list">${_cat.miembros.map(m => `<div class="pm2-pp"><span class="pm2-av">${esc(ini(m.nombre))}</span><div class="pm2-pp__n"><b>${esc(m.nombre)}</b><span>${esc(m.email || '')}</span></div>
      <span class="pm2-badge">${m.cargo === 'Propietario' ? 'Propietario' : esc(R(m.rol))}</span>${m.permisos && Object.keys(m.permisos).length ? '<span class="pm2-badge pm2-badge--aj">Ajustado</span>' : ''}
      ${m.cargo === 'Propietario' ? '<span class="pm-na">Acceso total</span>' : `<button class="btn btn--ghost btn--sm" onclick="PermsUI.openPersona(${m.id})">Editar acceso</button>`}</div>`).join('') || '<p class="pm-p">Aún no hay personas en el equipo.</p>'}</div>`;
  }
  function paintClientsTab() {
    document.getElementById('pm2-body').innerHTML = `<div class="pm2-card"><p class="pm2-note">Marca quién trabaja en cada cliente. Quien tenga Outreach en «Solo sus clientes asignados» únicamente verá los clientes donde esté marcado (o sea el Responsable). Los atenuados ya ven todos por su rol.</p><div id="pm-clients"></div></div>`;
    paintClients();
  }
  function setN(k, n) {
    const t = tgt(), m = _cat.modulos.find(x => x.k === k);
    if (n === -1) delete t[k]; else { const cur = t[k] || { ...baseOf()[k] }; cur.n = n; if (!m.alc) cur.a = 'todo'; t[k] = cur; }
    _refresh();
  }
  function setA(k, a) { const t = tgt(); t[k] = { ...(t[k] || baseOf()[k]), a }; _refresh(); }
  function _refresh() { if (_pmOpen) _repaintPersona(); else paintRolePanel(); }
  async function saveRol() {
    try { await put('/perms/roles/' + _rol, { permisos: _draft }); showBanner('Permisos del rol guardados', 'success'); await load(); } catch (e) { showBanner(e.message, 'error'); }
  }
  async function resetRol() {
    if (!confirm('¿Volver a los permisos predeterminados de este rol?')) return;
    try { await put('/perms/roles/' + _rol + '/reset', {}); showBanner('Restablecido', 'success'); await load(); } catch (e) { showBanner(e.message, 'error'); }
  }

  // ── modal por persona ──
  const modal = (t, b, w) => { document.getElementById('pm-modal')?.remove(); const m = document.createElement('div'); m.id = 'pm-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) { m.remove(); _pmOpen = false; } }; m.innerHTML = `<div class="fin-pi-box" style="max-width:${w || 560}px"><div class="fin-pi-box__hd"><h3>${t}</h3><button class="fin-pi-x" onclick="document.getElementById('pm-modal').remove();PermsUI.closeP()">✕</button></div><div class="sp-mb pm-mb">${b}</div></div>`; document.body.appendChild(m); return m; };
  function closeP() { _pmOpen = false; }
  function openPersona(id) {
    const m = _cat.miembros.find(x => x.id === id); if (!m) return;
    _persona = id; _pdraft = { ...(m.permisos || {}) }; _pdraft.__rol = m.rol || 'miembro'; _pmOpen = true; _repaintPersona(true);
  }
  function _repaintPersona(first) {
    const m = _cat.miembros.find(x => x.id === _persona), rol = _pdraft.__rol, admin = rol === 'admin';
    const vals = { ..._pdraft }; delete vals.__rol; const eff = {}; for (const mod of _cat.modulos) eff[mod.k] = vals[mod.k] || _cat.efectivos[rol][mod.k];
    const body = `<div class="pm2-pr"><label>Rol de esta persona</label><div class="pm2-segs">${_cat.roles.filter(r => r.k !== 'propietario').map(r => `<button type="button" class="pm2-sg${rol === r.k ? ' on n2' : ''}" onclick="PermsUI.setPRol('${r.k}')">${esc(r.l)}</button>`).join('')}</div></div>
      ${admin ? '<p class="pm2-note">Los administradores lo ven y gestionan todo; no se les pueden restringir módulos.</p>' : `${summary(eff)}<p class="pm2-note">Deja <b>Según rol</b> en lo que no quieras cambiar. Lo que marques aquí solo vale para esta persona.</p><div class="pm2-rows">${rows(vals, { inherit: true, base: _cat.efectivos[rol] })}</div>`}
      <div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('pm-modal').remove();PermsUI.closeP()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="PermsUI.savePersona()">Guardar</button></div>`;
    const sc = first ? 0 : (document.querySelector('#pm-modal .pm-mb') || { scrollTop: 0 }).scrollTop;
    modal('Acceso de ' + esc(m.nombre), body, 720);
    if (!first) document.querySelector('#pm-modal .pm-mb').scrollTop = sc;
  }
  function setPRol(r) { _pdraft.__rol = r; _repaintPersona(); }
  async function savePersona() {
    const permisos = { ..._pdraft }, rol = permisos.__rol; delete permisos.__rol;
    try { await put('/perms/members/' + _persona, { rol, permisos }); document.getElementById('pm-modal')?.remove(); _pmOpen = false; showBanner('Acceso actualizado', 'success'); _persona = null; await load(); }
    catch (e) { showBanner(e.message, 'error'); }
  }

  // ── Uso compartido de un espacio o proyecto ──
  let _sh = null;
  async function share(tipo, id, nombre) {
    try { const j = await api(`/perms/shares?tipo=${tipo}&id=${id}`); _sh = { tipo, id, nombre, ...j }; _paintShare(); }
    catch (e) { showBanner(e.message, 'error'); }
  }
  function _paintShare() {
    const s = _sh, byM = Object.fromEntries(s.compartidos.map(c => [c.member_id, c.nivel]));
    const rows = s.equipo.filter(m => m.cargo !== 'Propietario').map(m => {
      const lv = byM[m.id] || '', auto = m.ve_todo;
      return `<div class="pm-sh"><div><b>${esc(m.nombre)}</b><span>${esc(m.email || '')}${auto ? ' · ya lo ve por su rol' : ''}</span></div>
        <select class="pm-s" ${auto && !lv ? 'disabled' : ''} onchange="PermsUI.setShare(${m.id},this.value)"><option value="">${auto ? 'Por su rol' : 'Sin acceso'}</option>${Object.entries(SHARE).map(([k, l]) => `<option value="${k}"${lv === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
    }).join('');
    modal(`Uso compartido · ${esc(s.nombre || (s.tipo === 'space' ? 'Espacio' : 'Proyecto'))}`,
      `<p class="pm-p">Elige quién puede ver y trabajar en ${s.tipo === 'space' ? 'este espacio (y todos sus proyectos)' : 'este proyecto'}. Los administradores siempre lo ven. Quien solo ve «lo suyo» y no está aquí ni asignado, no lo verá.</p>${rows || '<p class="pm-p">No hay otras personas en el equipo.</p>'}`, 520);
  }
  async function setShare(mid, nivel) {
    try { await put('/perms/shares', { tipo: _sh.tipo, recurso_id: _sh.id, member_id: mid, nivel }); showBanner('Acceso actualizado', 'success'); const j = await api(`/perms/shares?tipo=${_sh.tipo}&id=${_sh.id}`); Object.assign(_sh, j); }
    catch (e) { showBanner(e.message, 'error'); }
  }

  // ── Equipo asignado a un cliente outbound (dentro de la ficha del cliente) ──
  function _chips(j, cid) {
    const set = new Set(j.asignados);
    return `<div class="pm-chips">${j.equipo.map(m => { const auto = m.ve_todo, on = set.has(m.id) || (j.responsable && j.responsable.trim().toLowerCase() === (m.nombre || '').trim().toLowerCase());
      return `<label class="pm-chip${on ? ' on' : ''}${auto ? ' pm-chip--auto' : ''}" title="${auto ? 'Ya ve todos los clientes por su rol' : ''}"><input type="checkbox" ${on ? 'checked' : ''} ${auto ? 'disabled' : ''} onchange="PermsUI.setClientTeam(${cid},${m.id},this.checked,this)">${esc(m.nombre)}</label>`; }).join('')}</div>`;
  }
  // Configuración › Roles y permisos: equipo asignado a cada cliente outbound
  async function paintClients() {
    const box = document.getElementById('pm-clients'); if (!box) return;
    let cl = []; try { cl = await api('/outbound-clients'); } catch (_) {}
    box.innerHTML = cl.length ? cl.map(c => `<div class="pm-cl"><div class="pm-cl__n"><b>${esc(c.nombre)}</b><span>${esc(c.estado || '')}</span></div><div id="pm-cl-${c.id}" class="pm-cl__t"></div></div>`).join('') : '<p class="pm-p">Aún no hay clientes outbound.</p>';
    cl.forEach(c => clientTeam(c.id, 'pm-cl-' + c.id, true));
  }
  async function clientTeam(cid, boxId, compact) {
    const box = document.getElementById(boxId || 'obc-team'); if (!box) return;
    let j; try { j = await api('/perms/client-team?client=' + cid); } catch (e) { box.innerHTML = ''; return; }
    const set = new Set(j.asignados);
    box.innerHTML = compact ? '' : `<div class="fin-cfg-lbl" style="margin-bottom:2px">Equipo asignado a este cliente</div>
      <span class="seq-drip-hint">Las personas con acceso «Solo sus clientes asignados» a Outreach solo verán los clientes donde estén marcadas (o sean el Responsable). Los administradores ven todos.</span>
      ${_chips(j, cid)}`;
    if (compact) box.innerHTML = _chips(j, cid);
  }
  async function setClientTeam(cid, mid, on, el) {
    try { await put('/perms/client-team', { client_id: cid, member_id: mid, asignado: !!on }); el.parentElement.classList.toggle('on', !!on); }
    catch (e) { el.checked = !on; showBanner(e.message, 'error'); }
  }
  return { clientTeam, setClientTeam, load, tab, pickRol, saveRol, resetRol, setN, setA, openPersona, setPRol, savePersona, closeP, share, setShare, applyNav };
})();
