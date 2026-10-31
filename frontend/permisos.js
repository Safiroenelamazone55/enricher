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

  // ── matriz de módulos (nivel + alcance) ──
  function matrix(vals, opts) {
    opts = opts || {};
    let g = '', h = '';
    for (const m of _cat.modulos) {
      if (m.g !== g) { g = m.g; h += `<tr class="pm-g"><td colspan="3">${esc(g)}</td></tr>`; }
      const v = vals[m.k], inh = opts.inherit && !v;
      const eff = v || (opts.base && opts.base[m.k]) || { n: 0, a: 'todo' };
      h += `<tr><td class="pm-m">${esc(m.l)}</td>
        <td><select class="pm-s" data-k="${m.k}" data-f="n" onchange="PermsUI.set('${m.k}','n',this.value)"${opts.ro ? ' disabled' : ''}>${opts.inherit ? `<option value="-1"${inh ? ' selected' : ''}>Según el rol (${NIVELES[eff.n]})</option>` : ''}${NIVELES.map((l, i) => `<option value="${i}"${!inh && eff.n === i ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td>${m.alc ? `<select class="pm-s" data-k="${m.k}" data-f="a" onchange="PermsUI.set('${m.k}','a',this.value)"${opts.ro || inh ? ' disabled' : ''}><option value="todo"${eff.a === 'todo' ? ' selected' : ''}>Todo el equipo</option><option value="suyo"${eff.a === 'suyo' ? ' selected' : ''}>${m.k === 'outreach' ? 'Solo sus clientes asignados' : 'Solo lo suyo y lo compartido'}</option></select>` : '<span class="pm-na">—</span>'}</td></tr>`;
    }
    return `<table class="pm-t"><thead><tr><th>Módulo</th><th>Nivel de acceso</th><th>Qué ve</th></tr></thead><tbody>${h}</tbody></table>`;
  }
  function set(k, f, v) {
    const target = _persona != null && document.getElementById('pm-modal') ? _pdraft : _draft;
    if (f === 'n' && +v === -1) { delete target[k]; if (target === _pdraft) _repaintPersona(); return; }
    const cur = target[k] || (target === _pdraft ? { ..._cat.efectivos[_pdraft.__rol || 'miembro'][k] } : { ..._cat.efectivos[_rol][k] });
    cur[f] = f === 'n' ? +v : v; target[k] = cur;
    if (target === _pdraft) _repaintPersona();
  }

  async function load() {
    const root = document.getElementById('cfg-permisos-mount'); if (!root) return;
    root.innerHTML = '<p class="pm-p">Cargando…</p>';
    try { _cat = await api('/perms/catalog'); } catch (e) { root.innerHTML = `<p class="pm-p">${esc(e.message)}</p>`; return; }
    if (!['manager', 'miembro', 'lector'].includes(_rol)) _rol = 'miembro';
    _draft = JSON.parse(JSON.stringify(_cat.efectivos[_rol])); paint();
  }
  function pickRol(r) { _rol = r; _draft = JSON.parse(JSON.stringify(_cat.efectivos[r])); paint(); }
  function paint() {
    const root = document.getElementById('cfg-permisos-mount'); if (!root || !_cat) return;
    const R = k => _cat.roles.find(r => r.k === k), edit = ['manager', 'miembro', 'lector'];
    const cus = !!_cat.personalizados[_rol];
    root.innerHTML = `
      <p class="pm-p">Cada persona del equipo tiene un <b>rol</b>, y cada rol trae permisos <b>predeterminados</b> por módulo. Aquí puedes ajustarlos por módulo, y también por persona. El <b>Propietario</b> y los <b>Administradores</b> lo ven y gestionan todo; son quienes supervisan y asignan.</p>
      <div class="pm-roles">${edit.map(k => `<button class="pm-r${_rol === k ? ' on' : ''}" onclick="PermsUI.pickRol('${k}')"><b>${esc(R(k).l)}</b><span>${esc(R(k).d)}</span></button>`).join('')}</div>
      <div class="pm-bar"><span>Permisos del rol <b>${esc(R(_rol).l)}</b>${cus ? ' <em>(personalizado)</em>' : ' <em>(predeterminado)</em>'}</span><span style="flex:1"></span>
        ${cus ? '<button class="btn btn--ghost btn--sm" onclick="PermsUI.resetRol()">Restablecer predeterminado</button>' : ''}<button class="btn btn--primary btn--sm" onclick="PermsUI.saveRol()">Guardar cambios</button></div>
      ${matrix(_draft, {})}
      <h4 class="pm-h">Personas</h4>
      <p class="pm-p">Cambia el rol de cada persona o dale permisos distintos a los de su rol.</p>
      <div class="pm-ppl">${_cat.miembros.map(m => `<div class="pm-pp"><div><b>${esc(m.nombre)}</b><span>${esc(m.email || '')}</span></div>
        <span class="pm-badge">${m.cargo === 'Propietario' ? 'Propietario' : esc((R(m.rol) || { l: m.rol }).l)}${m.permisos && Object.keys(m.permisos).length ? ' · ajustado' : ''}</span>
        ${m.cargo === 'Propietario' ? '<span class="pm-na">Acceso total</span>' : `<button class="btn btn--ghost btn--sm" onclick="PermsUI.openPersona(${m.id})">Editar acceso</button>`}</div>`).join('') || '<p class="pm-p">Aún no hay personas en el equipo.</p>'}</div>
      <h4 class="pm-h">Equipo por cliente outbound</h4>
      <p class="pm-p">Marca quién trabaja en cada cliente. Las personas con Outreach en «Solo sus clientes asignados» solo verán los clientes donde estén marcadas (o sean el Responsable). Los administradores y quienes ven «Todo el equipo» aparecen atenuados: ya ven todos.</p>
      <div id="pm-clients"></div>`;
    paintClients();
  }
  async function saveRol() {
    try { await put('/perms/roles/' + _rol, { permisos: _draft }); showBanner('Permisos del rol guardados', 'success'); await load(); } catch (e) { showBanner(e.message, 'error'); }
  }
  async function resetRol() {
    if (!confirm('¿Volver a los permisos predeterminados de este rol?')) return;
    try { await put('/perms/roles/' + _rol + '/reset', {}); showBanner('Restablecido', 'success'); await load(); } catch (e) { showBanner(e.message, 'error'); }
  }

  // ── modal por persona ──
  const modal = (t, b, w) => { document.getElementById('pm-modal')?.remove(); const m = document.createElement('div'); m.id = 'pm-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); }; m.innerHTML = `<div class="fin-pi-box" style="max-width:${w || 560}px"><div class="fin-pi-box__hd"><h3>${t}</h3><button class="fin-pi-x" onclick="document.getElementById('pm-modal').remove()">✕</button></div><div class="sp-mb pm-mb">${b}</div></div>`; document.body.appendChild(m); return m; };
  function openPersona(id) {
    const m = _cat.miembros.find(x => x.id === id); if (!m) return;
    _persona = id; _pdraft = { ...(m.permisos || {}) }; _pdraft.__rol = m.rol || 'miembro'; _repaintPersona(true);
  }
  function _repaintPersona(first) {
    const m = _cat.miembros.find(x => x.id === _persona), rol = _pdraft.__rol, admin = rol === 'admin';
    const vals = { ..._pdraft }; delete vals.__rol;
    const body = `<div class="pm-bar"><label style="font-size:.82rem;font-weight:700">Rol</label><select class="pm-s" onchange="PermsUI.setPRol(this.value)">${_cat.roles.filter(r => r.k !== 'propietario').map(r => `<option value="${r.k}"${rol === r.k ? ' selected' : ''}>${esc(r.l)}</option>`).join('')}</select></div>
      ${admin ? '<p class="pm-p">Los administradores lo ven y gestionan todo; no se les pueden restringir módulos.</p>' : `<p class="pm-p">Deja «Según el rol» en lo que no quieras cambiar.</p>${matrix(vals, { inherit: true, base: _cat.efectivos[rol] })}`}
      <div class="sp-mf"><button class="btn btn--ghost btn--sm" onclick="document.getElementById('pm-modal').remove()">Cancelar</button><button class="btn btn--primary btn--sm" onclick="PermsUI.savePersona()">Guardar</button></div>`;
    const el = document.getElementById('pm-modal'), sc = el ? el.querySelector('.pm-mb').scrollTop : 0;
    modal('Acceso de ' + esc(m.nombre), body, 640);
    if (!first) document.querySelector('#pm-modal .pm-mb').scrollTop = sc;
  }
  function setPRol(r) { _pdraft.__rol = r; _repaintPersona(); }
  async function savePersona() {
    const permisos = { ..._pdraft }, rol = permisos.__rol; delete permisos.__rol;
    try { await put('/perms/members/' + _persona, { rol, permisos }); document.getElementById('pm-modal')?.remove(); showBanner('Acceso actualizado', 'success'); _persona = null; await load(); }
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
  return { clientTeam, setClientTeam, load, pickRol, saveRol, resetRol, set, openPersona, setPRol, savePersona, share, setShare, applyNav };
})();
