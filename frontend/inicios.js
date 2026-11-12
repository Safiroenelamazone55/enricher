// Módulo «Inicios de cliente»: lista tipo Excel + ficha de cada cliente con lo que completó en su formulario de inicio.
// Base de datos previa al acceso al portal. Las contraseñas llegan cifradas: se muestran/copian bajo demanda y cada vez queda anotado.
const InicioModule = (() => {
  const E = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const seguro = u => (/^https?:\/\/[^\s<>"']+$/i.test(String(u || '')) ? String(u) : '');   // el cliente escribe estos enlaces: solo http(s), nunca javascript:
  const $ = id => document.getElementById(id);
  let _host = null, _schema = null, _rows = [], _q = '', _fe = '', _sort = { k: 'actualizado_en', d: -1 }, _f = null, _shown = {}, _loading = false;
  const ESTADOS = { sin_enviar: ['Sin enviar', '#64748B', '#EEF1F5'], enviado: ['Enviado', '#2563EB', '#E3ECFD'], en_curso: ['En curso', '#B45309', '#FEF3C7'], recibido: ['Recibido', '#0F766E', '#D9F3EF'], revisado: ['Revisado', '#15803D', '#DDF4E4'], portal: ['Portal activo', '#0B2A5B', '#DCE6F7'] };
  const CANAL = { linkedin: 'LinkedIn', linkedin_whatsapp: 'LinkedIn · WhatsApp', whatsapp: 'WhatsApp', email: 'Correo' };
  const SN = { tengo: 'Sí, ya tiene', anadir: 'Quiere añadirlo', no: 'No lo quiere' };
  const MAILE = { creado: 'Creado', despues: 'Lo enviará después' };
  const ACC = { creado: 'Enlace creado', enlace_renovado: 'Enlace renovado', enlace_renovado_nuevo: 'Enlace renovado (token nuevo)', enlace_revocado: 'Enlace revocado', idioma_cambiado: 'Idioma del formulario cambiado', enlace_enviado: 'Enlace marcado como enviado', recordatorio_enviado: 'Recordatorio enviado',
    mostrar_secreto: 'Mostró una contraseña', copiar_secreto: 'Copió una contraseña', editar_secreto: 'Editó una contraseña', exportar_accesos: 'Exportó accesos (CSV)', revisado: 'Marcó como revisado', portal_activado: 'Dio acceso al portal', accesos_borrados: 'Borró los accesos', accesos_borrados_auto: 'Accesos borrados automáticamente' };

  async function _j(url, opts) {
    const r = await apiFetch(API + url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'No se pudo completar'); e.data = d; throw e; }
    return d;
  }
  const _post = (url, data, method) => _j(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const msg = (m, t) => { try { showBanner(m, t || 'success'); } catch (_) {} };
  const chip = k => { const e = ESTADOS[k] || [k, '#64748B', '#EEF1F5']; return `<span class="ini-chip" style="color:${e[1]};background:${e[2]}">${E(e[0])}</span>`; };
  const fdate = s => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }); };
  const fdt = s => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  async function copiar(txt, ok) { try { await navigator.clipboard.writeText(String(txt)); msg(ok || 'Copiado'); } catch (_) { msg('No se pudo copiar', 'error'); } }
  const campoDe = id => (_schema ? _schema.secciones.flatMap(s => s.campos).find(c => c.id === id) : null);

  // ══ Lista tipo Excel ══
  async function render(id) {
    _host = $(id) || _host; if (!_host) return;
    if (!_schema) { try { _schema = await _j('/inicios/schema'); } catch (e) { _host.innerHTML = `<div class="ini-empty">${E(e.message)}</div>`; return; } }
    if (_f) return abrirFicha(_f.id, true);
    await cargar();
  }
  async function cargar() {
    if (_loading) return; _loading = true;
    try { _rows = await _j('/inicios'); } catch (e) { _host.innerHTML = `<div class="ini-empty">${E(e.message)}</div>`; _loading = false; return; }
    _loading = false; pintarLista();
  }
  const COLS = [['empresa', 'Empresa'], ['contacto', 'Contacto'], ['estado', 'Estado'], ['enviado_en', 'Enviado'], ['canal', 'Canal preferido'], ['mailInf', 'Correo de informes'], ['salesnav', 'Sales Navigator'], ['mailEstado', 'Correo asignado'], ['atiende', 'Atiende las reuniones'], ['progreso', 'Progreso'], ['revisado', 'Revisado']];
  function filtradas() {
    const q = _q.trim().toLowerCase();
    let r = _rows.filter(x => (!_fe || x.estado === _fe) && (!q || [x.empresa, x.contacto, x.mailInf, x.atiende, x.canal].join(' ').toLowerCase().includes(q)));
    const k = _sort.k, d = _sort.d;
    r.sort((a, b) => { const A = a[k], B = b[k]; if (typeof A === 'number' || typeof B === 'number' || typeof A === 'boolean') return ((+A || 0) - (+B || 0)) * d; return String(A || '').localeCompare(String(B || ''), 'es') * d; });
    return r;
  }
  function pintarLista() {
    const r = filtradas(), th = COLS.map(([k, l]) => `<th class="ini-th" onclick="InicioModule.ordenar('${k}')">${l}${_sort.k === k ? (_sort.d > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '<th class="ini-th ini-gearc"></th>';
    const tr = r.map(x => `<tr onclick="InicioModule.abrirFicha(${x.id})"><td><b>${E(x.empresa || '—')}</b></td><td>${E(x.contacto || '—')}</td><td>${chip(x.estado)}</td><td>${fdate(x.enviado_en)}</td><td>${E(CANAL[x.canal] || '—')}</td><td>${E(x.mailInf || '—')}</td><td>${E(SN[x.salesnav] || '—')}</td><td>${E(MAILE[x.mailEstado] || '—')}</td><td>${E(x.atiende || '—')}</td>
      <td><div class="ini-bar" title="${x.progreso} %"><i style="width:${x.progreso}%"></i></div><small>${x.progreso} %</small></td><td>${x.revisado ? '✓ ' + fdate(x.revisado_en) : '—'}</td><td class="ini-gearc"><button class="ini-gear" title="Opciones" onclick="event.stopPropagation();InicioModule.menuFila(${x.id},this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></td></tr>`).join('');
    const opts = `<option value="">Todos los estados</option>` + Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}"${_fe === k ? ' selected' : ''}>${v[0]}</option>`).join('');
    _host.innerHTML = `<div class="ini-wrap"><div class="ini-head"><div><h1 class="ini-h1">Inicios de cliente</h1><p class="ini-sub">Lo que cada cliente completó en su formulario de inicio. Es la base de datos previa al acceso al portal.</p></div>
      <div class="ini-tools"><input class="ini-in" id="ini-q" placeholder="Buscar…" value="${E(_q)}" oninput="InicioModule.buscar(this.value)"><select class="ini-in" onchange="InicioModule.filtrar(this.value)">${opts}</select>
      <button class="btn btn-ghost" onclick="InicioModule.csv(false)">Exportar CSV</button><button class="btn btn-ghost" onclick="InicioModule.csv(true)" title="Incluye las contraseñas (pide confirmación y queda anotado)">Incluir accesos</button>
      <button class="btn btn-primary" onclick="InicioModule.nuevo()">＋ Crear enlace de inicio</button></div></div>
      ${r.length ? `<div class="ini-scroll"><table class="ini-tbl"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>` : `<div class="ini-empty">${_rows.length ? 'Ningún resultado con estos filtros.' : 'Aún no hay formularios de inicio. Crea el primer enlace con «Crear enlace de inicio» o desde la ficha de un cliente.'}</div>`}</div>`;
    const q = $('ini-q'); if (q && document.activeElement !== q && _q) { /* mantiene el foco al escribir */ }
  }
  function ordenar(k) { _sort = _sort.k === k ? { k, d: -_sort.d } : { k, d: 1 }; pintarLista(); }
  function buscar(v) { _q = v; pintarLista(); const q = $('ini-q'); if (q) { q.focus(); q.setSelectionRange(v.length, v.length); } }
  function filtrar(v) { _fe = v; pintarLista(); }

  async function csv(acc) {
    if (acc && !confirm('El CSV incluirá las contraseñas de LinkedIn y del correo asignado, en texto visible.\n\nQuedará anotado quién las exportó y cuándo. ¿Continuar?')) return;
    try {
      const r = await apiFetch(API + '/inicios/export.csv' + (acc ? '?accesos=1&confirmar=1' : ''));
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'No se pudo exportar'); }
      const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
      a.href = url; a.download = 'inicios-de-cliente' + (acc ? '-con-accesos' : '') + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { msg(e.message, 'error'); }
  }

  // ══ Crear enlace ══
  function modal(html) {
    cerrar(); const m = document.createElement('div'); m.className = 'ini-modal'; m.id = 'ini-modal';
    m.innerHTML = `<div class="ini-modal__bg" onclick="InicioModule.cerrar()"></div><div class="ini-modal__box">${html}</div>`; document.body.appendChild(m);
  }
  function cerrar() { const m = $('ini-modal'); if (m) m.remove(); }
  async function nuevo() {
    let cl = []; try { cl = await _j('/mgmt/clients'); } catch (_) {}
    const opts = (Array.isArray(cl) ? cl : []).map(c => `<option value="${c.id}">${E(c.empresa || c.nombre)}${c.empresa && c.nombre ? ' · ' + E(c.nombre) : ''}</option>`).join('');
    modal(`<h3 class="ini-mh">Crear enlace de inicio</h3><label class="ini-l">Cliente</label><select class="ini-in" id="ini-nc" onchange="InicioModule._nuevoCambio()"><option value="">+ Crear cliente nuevo (en Operaciones)</option>${opts}</select>
      <div id="ini-nn"><p class="ini-hint" style="margin:6px 0 0">Se guarda como cliente en <b>Operaciones → Clientes</b> y queda listo para proyectos y facturación.</p><label class="ini-l">Empresa</label><input class="ini-in" id="ini-ne"><label class="ini-l">Nombre del contacto</label><input class="ini-in" id="ini-nco"><label class="ini-l">Correo <span class="ini-opt">(opcional)</span></label><input class="ini-in" id="ini-nm" type="email"></div>
      <label class="ini-l">Idioma del formulario</label><select class="ini-in" id="ini-ni"><option value="es">Español</option><option value="en">English</option></select>
      <p class="ini-hint">El enlace es único para este cliente, caduca a los 30 días y no pide cuenta ni contraseña. Se precarga con lo que ya sabemos del cliente.</p>
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cancelar</button><button class="btn btn-primary" onclick="InicioModule._nuevoCrear()">Crear enlace</button></div>`);
  }
  function _nuevoCambio() { const v = $('ini-nc').value; $('ini-nn').style.display = v ? 'none' : ''; }
  async function _nuevoCrear() {
    const cid = parseInt($('ini-nc').value, 10) || null, data = { cliente_id: cid, idioma: $('ini-ni').value };
    try {
      if (!cid) {
        const emp = $('ini-ne').value.trim(), con = $('ini-nco').value.trim(), mail = $('ini-nm').value.trim();
        if (!emp && !con) return msg('Escribe la empresa o el nombre del contacto', 'error');
        let c;
        try { c = await _post('/mgmt/clients', { nombre: con || emp, empresa: emp, email: mail, tipo: 'cliente' }); }
        catch (e) { if (e.data && e.data.existing) c = e.data.existing; else throw e; }   // ya existía: se usa ese
        data.cliente_id = c.id;
      }
      const r = await _post('/inicios', data); mostrarEnlace(r); if (_host && !_f) cargar(); } catch (e) { msg(e.message, 'error'); }
  }
  // Desde la ficha del cliente (Operaciones → Clientes)
  async function crearParaCliente(cid) {
    try { const r = await _post('/inicios', { cliente_id: cid }); mostrarEnlace(r); } catch (e) { msg(e.message, 'error'); }
  }
  function mostrarEnlace(r) {
    modal(`<h3 class="ini-mh">${r.existente ? 'Este cliente ya tiene un enlace' : 'Enlace de inicio listo'}</h3>
      <p class="ini-hint" style="margin-top:0">${r.existente ? 'Sigue vigente: es el mismo enlace.' : 'Envíaselo al cliente. Caduca a los 30 días.'}</p>
      <input class="ini-in" id="ini-url" readonly value="${E(r.url)}" onfocus="this.select()">
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cerrar</button><button class="btn btn-ghost" onclick="window.open('${E(r.url)}','_blank','noopener')">Abrir</button>
      <button class="btn btn-ghost" onclick="InicioModule.cerrar();InicioModule.ir(${r.id})">Ver ficha</button><button class="btn btn-primary" onclick="InicioModule.copiarEnlace(${r.id})">Copiar enlace y marcar como enviado</button></div>`);
  }
  // ══ Menú de opciones de cada fila (ruedita) ══
  function cerrarMenu() { const m = $('ini-gmenu'); if (m) m.remove(); document.removeEventListener('click', cerrarMenu, true); }
  function menuFila(id, btn) {
    cerrarMenu(); const x = _rows.find(r => r.id === id); if (!x) return;
    const m = document.createElement('div'); m.id = 'ini-gmenu'; m.className = 'ini-gmenu';
    const it = (fn, t, cls) => `<button class="ini-gm${cls ? ' ' + cls : ''}" onclick="InicioModule.cerrarMenu();InicioModule.${fn}">${t}</button>`;
    m.innerHTML = it(`copiarFila(${id})`, 'Copiar enlace') + it(`abrirForm(${id})`, 'Abrir el formulario') + it(`abrirFicha(${id})`, 'Ver ficha') + '<div class="ini-gsep"></div><div class="ini-gl">Idioma del formulario</div>'
      + it(`idiomaFila(${id},'es')`, (x.idioma !== 'en' ? '✓ ' : '') + 'Español') + it(`idiomaFila(${id},'en')`, (x.idioma === 'en' ? '✓ ' : '') + 'English')
      + '<div class="ini-gsep"></div>' + it(`renovarFila(${id})`, 'Renovar 30 días') + it(`revocarFila(${id})`, 'Revocar enlace', 'ini-gm--bad');
    document.body.appendChild(m);
    const b = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) + 'px';
    m.style.top = (b.bottom + h + 8 > innerHeight ? Math.max(8, b.top - h - 4) : b.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', cerrarMenu, true), 0);
  }
  async function _url(id) { const f = await _j('/inicios/' + id); return f.url; }
  async function copiarFila(id) { try { await copiar(await _url(id), 'Enlace copiado'); try { await _post(`/inicios/${id}/marcar-enviado`); } catch (_) {} cargar(); } catch (e) { msg(e.message, 'error'); } }
  async function abrirForm(id) { try { window.open(await _url(id), '_blank', 'noopener'); } catch (e) { msg(e.message, 'error'); } }
  async function idiomaFila(id, l) { try { await _post(`/inicios/${id}/idioma`, { idioma: l }); msg(l === 'en' ? 'Formulario en English' : 'Formulario en español', 'success'); cargar(); } catch (e) { msg(e.message, 'error'); } }
  async function renovarFila(id) { try { await _post(`/inicios/${id}/renovar`); msg('Enlace renovado 30 días', 'success'); cargar(); } catch (e) { msg(e.message, 'error'); } }
  async function revocarFila(id) { if (!confirm('El enlace dejará de funcionar de inmediato. ¿Revocarlo?')) return; try { await _post(`/inicios/${id}/revocar`); msg('Enlace revocado', 'success'); cargar(); } catch (e) { msg(e.message, 'error'); } }
  async function copiarEnlace(id) {
    const u = $('ini-url') ? $('ini-url').value : (_f && _f.url);
    await copiar(u, 'Enlace copiado');
    try { await _post(`/inicios/${id}/marcar-enviado`); } catch (_) {}
    cerrar(); if (_f && _f.id === id) abrirFicha(id, true); else if (_host && !_f) cargar();
  }

  // ══ Ficha ══
  async function abrirFicha(id, keep) {
    try { _f = await _j('/inicios/' + id); } catch (e) { msg(e.message, 'error'); _f = null; return cargar(); }
    if (!keep) _shown = {};
    pintarFicha();
  }
  // Abre la ficha desde fuera del módulo (aviso emergente, ficha de cliente): cambia a la sección y luego la abre
  function ir(id) { _f = null; try { selectModule('inicios'); } catch (_) {} setTimeout(() => abrirFicha(id), 350); }
  function volver() { _f = null; _shown = {}; cargar(); }

  const falta = id => _f.faltan.includes(id);
  function fila(c) {
    const f = _f, v = f.respuestas[c.id], lbl = E(c.es) + (c.req ? '<span class="ini-rq"> *</span>' : '');
    const bad = (c.req && falta(c.id) && c.tipo !== 'check') || f.formato[c.id];
    let ctl;
    if (c.tipo === 'check') {
      const when = f.acuerdos[c.id];
      return `<div class="ini-f ini-f--ck${falta(c.id) ? ' bad' : ''}"><label class="ini-ck"><input type="checkbox" ${when ? 'checked' : ''} onchange="InicioModule.guardarCampo('${c.id}',this.checked,true)"><span>${E(c.es)}${when ? `<small>Aceptado el ${fdt(when)}</small>` : ''}</span></label></div>`;
    }
    if (c.sensible) {
      const set = f.secretos[c.id], sh = _shown[c.id];
      return `<div class="ini-f${bad ? ' bad' : ''}"><label class="ini-l">${lbl}</label><div class="ini-row"><input class="ini-in" readonly id="ini-s-${c.id}" value="${set ? (sh ? E(sh) : '••••••••••') : ''}" placeholder="${set ? '' : 'Sin valor'}">
        ${set ? `<button class="btn btn-ghost btn-sm" onclick="InicioModule.mostrar('${c.id}')">${sh ? 'Ocultar' : 'Mostrar'}</button><button class="btn btn-ghost btn-sm" onclick="InicioModule.copiarSecreto('${c.id}')">Copiar</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="InicioModule.cambiarSecreto('${c.id}')">${set ? 'Cambiar' : 'Escribir'}</button></div></div>`;
    }
    if (c.tipo === 'long') ctl = `<textarea class="ini-in" rows="3" onchange="InicioModule.guardarCampo('${c.id}',this.value)">${E(v || '')}</textarea>`;
    else if (c.tipo === 'select') ctl = `<select class="ini-in" onchange="InicioModule.guardarCampo('${c.id}',this.value)"><option value=""></option>${c.opts.map(o => `<option value="${E(o.v)}"${o.v === v ? ' selected' : ''}>${E(o.es)}</option>`).join('')}</select>`;
    else ctl = `<input class="ini-in" type="text" value="${E(v || '')}" onchange="InicioModule.guardarCampo('${c.id}',this.value)">`;
    const extra = c.tipo === 'url' && seguro(v) ? `<a class="ini-lnk" href="${E(seguro(v))}" target="_blank" rel="noopener noreferrer">Abrir</a>` : '';
    return `<div class="ini-f${bad ? ' bad' : ''}"><label class="ini-l">${lbl}</label><div class="ini-row">${ctl}${extra}<button class="btn btn-ghost btn-sm" onclick="InicioModule.copiarCampo('${c.id}')">Copiar</button></div>${f.formato[c.id] ? '<p class="ini-err">Formato no válido</p>' : ''}</div>`;
  }
  function pintarFicha() {
    const f = _f, R = f.respuestas, puedeRev = f.estado === 'recibido' && f.completo, puedePortal = f.estado === 'revisado' && f.completo;
    const vig = f.vigente ? 'Vigente hasta ' + fdate(f.expira_en) : (f.revocado ? 'Revocado' : 'Caducado el ' + fdate(f.expira_en));
    const logo = seguro(R.logo) ? `<a href="${E(seguro(R.logo))}" target="_blank" rel="noopener noreferrer"><img class="ini-logo" src="${E(seguro(R.logo))}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('(sin vista previa)'))"></a>` : '<span class="ini-mut">Sin logo</span>';
    const fact = `<div class="ini-card ini-bill"><div class="ini-ct">Facturación</div><div class="ini-bg">
      ${[['Razón social', R.razon], ['NIF / CIF / VAT', R.nif], ['Dirección fiscal', R.dir], ['Correo de informes y facturación', R.mailInf]].map(([l, v]) => `<div><small>${l}</small><b>${E(v || '—')}</b></div>`).join('')}
      <div><small>Logo</small>${logo}</div></div>
      ${R.salesnav === 'anadir' ? '<div class="ini-line">Línea opcional de factura: <b>LinkedIn Sales Navigator US$50/mes (60 % de descuento)</b></div>' : ''}</div>`;
    const aviso = f.faltan.length ? `<div class="ini-warn">Faltan ${f.faltan.length} obligatorio${f.faltan.length === 1 ? '' : 's'}: ${E(f.faltan.map(id => (campoDe(id) || {}).es || id).join(' · '))}</div>` : '';
    const secs = _schema.secciones.map((s, i) => `<section class="ini-card"><div class="ini-ct"><b>${i + 1}</b> ${E(s.titulo.es)}</div>${s.campos.map(fila).join('')}</section>`).join('');
    const aud = (f.auditoria || []).length ? f.auditoria.map(a => `<tr><td>${fdt(a.ts)}</td><td>${E(a.quien)}</td><td>${E(ACC[a.accion] || a.accion)}${a.campo ? ' · ' + E(a.campo) : ''}</td></tr>`).join('') : '<tr><td colspan="3" class="ini-mut">Sin movimientos</td></tr>';
    _host.innerHTML = `<div class="ini-wrap"><div class="ini-gh"><button class="ini-back" onclick="InicioModule.volver()">← Inicios de cliente</button></div>
      <div class="ini-head"><div><h1 class="ini-h1">${E(f.empresa || 'Cliente')} ${chip(f.estado)}</h1><p class="ini-sub">${E(f.contacto || '')}${f.contacto ? ' · ' : ''}Progreso ${f.progreso} % · ${f.enviado_en ? 'Enviado ' + fdt(f.enviado_en) : 'Aún no enviado'}${f.revisado ? ' · Revisado ' + fdate(f.revisado_en) : ''}</p></div>
        <div class="ini-tools">
          <button class="btn btn-ghost" onclick="InicioModule.recordatorio()" ${f.estado === 'recibido' || f.estado === 'revisado' || f.estado === 'portal' ? 'disabled' : ''}>Reenviar recordatorio</button>
          <button class="btn btn-ghost" onclick="InicioModule.borrarAccesos()" ${(f.secretos.liPass || f.secretos.mailPass) ? '' : 'disabled'} title="Elimina las contraseñas guardadas y lo deja anotado">Borrar accesos</button>
          <button class="btn btn-ghost" onclick="InicioModule.revisar()" ${puedeRev ? '' : 'disabled'} title="${puedeRev ? 'Pasa los datos a la ficha del cliente' : 'Disponible cuando el cliente envía el formulario con todos los obligatorios'}">Marcar revisado</button>
          <button class="btn btn-primary" onclick="InicioModule.portal()" ${puedePortal ? '' : 'disabled'} title="${puedePortal ? '' : 'Se activa cuando el estado es «Revisado» y todos los obligatorios están completos'}">Dar acceso al portal</button></div></div>
      ${aviso}
      <div class="ini-card ini-link"><div class="ini-ct">Enlace del cliente</div><div class="ini-row"><input class="ini-in" readonly value="${E(f.url)}" onfocus="this.select()"><button class="btn btn-ghost btn-sm" onclick="InicioModule.copiar(${JSON.stringify(f.url).replace(/"/g, '&quot;')},'Enlace copiado')">Copiar</button><button class="btn btn-ghost btn-sm" onclick="InicioModule.marcarEnviado()">Marcar enviado</button><button class="btn btn-ghost btn-sm" onclick="InicioModule.renovar()">Renovar</button><button class="btn btn-ghost btn-sm" onclick="InicioModule.revocar()" ${f.revocado ? 'disabled' : ''}>Revocar</button></div>
        <p class="ini-hint">${vig}${f.cliente ? ' · Cliente: ' + E(f.cliente.empresa || f.cliente.nombre) : ''}${f.accesos_borrados ? ' · Accesos borrados' : ''}${f.ultimo_recordatorio ? ' · Último recordatorio ' + fdt(f.ultimo_recordatorio) : ''}</p></div>
      ${fact}${secs}
      <section class="ini-card"><div class="ini-ct">Nota interna</div><textarea class="ini-in" rows="3" placeholder="Solo la ves tú" onchange="InicioModule.guardarNota(this.value)">${E(f.nota_interna || '')}</textarea></section>
      <section class="ini-card"><div class="ini-ct">Auditoría de accesos y cambios</div><table class="ini-aud"><tbody>${aud}</tbody></table></section></div>`;
  }

  const recargar = () => abrirFicha(_f.id, true);
  async function guardarCampo(id, val, esAcuerdo) {
    try { await _post('/inicios/' + _f.id, esAcuerdo ? { acuerdos: { [id]: !!val } } : { respuestas: { [id]: val } }, 'PUT'); msg('Guardado'); await recargar(); } catch (e) { msg(e.message, 'error'); }
  }
  async function guardarNota(v) { try { await _post('/inicios/' + _f.id, { nota_interna: v }, 'PUT'); msg('Nota guardada'); _f.nota_interna = v; } catch (e) { msg(e.message, 'error'); } }
  function copiarCampo(id) { const v = _f.respuestas[id]; if (v) copiar(v); else msg('Sin valor para copiar', 'error'); }
  async function mostrar(id) {
    if (_shown[id]) { delete _shown[id]; return pintarFicha(); }
    try { const r = await _post(`/inicios/${_f.id}/secreto`, { campo: id, accion: 'mostrar' }); _shown[id] = r.valor; await recargar(); setTimeout(() => { if (_shown[id]) { delete _shown[id]; if (_f) pintarFicha(); } }, 30000); } catch (e) { msg(e.message, 'error'); }
  }
  async function copiarSecreto(id) { try { const r = await _post(`/inicios/${_f.id}/secreto`, { campo: id, accion: 'copiar' }); await copiar(r.valor, 'Contraseña copiada (queda anotado; el portapapeles se limpia en 30 s)'); setTimeout(() => { try { navigator.clipboard.writeText(' '); } catch (_) {} }, 30000); await recargar(); } catch (e) { msg(e.message, 'error'); } }
  function cambiarSecreto(id) {
    modal(`<h3 class="ini-mh">${E((campoDe(id) || {}).es || id)}</h3><input class="ini-in" id="ini-sv" autocomplete="off" spellcheck="false" placeholder="Nueva contraseña"><div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cancelar</button><button class="btn btn-primary" onclick="InicioModule._guardarSecreto('${id}')">Guardar</button></div>`);
    setTimeout(() => { const i = $('ini-sv'); if (i) i.focus(); }, 30);
  }
  async function _guardarSecreto(id) { const v = $('ini-sv').value; cerrar(); delete _shown[id]; await guardarCampo(id, v); }

  async function accion(ruta, ok, data) { try { const r = await _post(`/inicios/${_f.id}/${ruta}`, data); if (ok) msg(ok); await recargar(); return r; } catch (e) { msg(e.message, 'error'); } }
  const marcarEnviado = () => accion('marcar-enviado', 'Marcado como enviado');
  const renovar = () => accion('renovar', 'Enlace renovado 30 días');
  function revocar() { if (confirm('El enlace dejará de funcionar de inmediato. ¿Revocarlo?')) accion('revocar', 'Enlace revocado'); }
  async function recordatorio() {
    const to = prompt('¿A qué correo envío el recordatorio?', (_f.respuestas.mailInf || '').trim()); if (to == null) return;
    try { await _post(`/inicios/${_f.id}/recordatorio`, { to }); msg('Recordatorio enviado'); await recargar(); } catch (e) { msg(e.message + (e.data && e.data.url ? ' — copia el enlace y envíaselo tú' : ''), 'error'); }
  }
  async function revisar() { if (!confirm('Se pasarán los datos de facturación y comunicación a la ficha del cliente (o se creará si no existe). ¿Marcar como revisado?')) return; const r = await accion('revisar', 'Revisado: datos pasados a la ficha del cliente'); return r; }
  function borrarAccesos() { if (confirm('Se eliminarán las contraseñas guardadas de LinkedIn y del correo asignado. No se puede deshacer, pero queda anotado. ¿Borrarlas?')) accion('borrar-accesos', 'Accesos borrados'); }
  async function portal() {
    if (!confirm('Se creará el acceso del cliente al portal con su correo de informes y se le enviará la invitación. ¿Continuar?')) return;
    const r = await accion('portal'); if (!r) return;
    modal(`<h3 class="ini-mh">Acceso al portal creado</h3><p class="ini-hint" style="margin-top:0">Usuario: <b>${E(r.email)}</b><br>Contraseña temporal (solo se muestra ahora): <b id="ini-pw">${E(r.password)}</b><br>${r.invite && r.invite.sent ? 'Se envió la invitación por correo.' : 'No se pudo enviar la invitación por correo: pásale tú estos datos.'}</p>
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.copiar('${E(r.password)}','Contraseña copiada')">Copiar contraseña</button><button class="btn btn-primary" onclick="InicioModule.cerrar()">Cerrar</button></div>`);
  }

  return { render, ordenar, buscar, filtrar, csv, nuevo, _nuevoCambio, _nuevoCrear, crearParaCliente, copiarEnlace, abrirFicha, ir, volver, cerrar, copiar, guardarCampo, guardarNota, copiarCampo, mostrar, copiarSecreto, cambiarSecreto, _guardarSecreto,
    menuFila, cerrarMenu, copiarFila, abrirForm, idiomaFila, renovarFila, revocarFila, marcarEnviado, renovar, revocar, recordatorio, revisar, borrarAccesos, portal };
})();
window.InicioModule = InicioModule;
