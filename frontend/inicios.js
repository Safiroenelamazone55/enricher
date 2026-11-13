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
  const ACC = { creado: 'Enlace creado', enlace_renovado: 'Enlace renovado', enlace_renovado_nuevo: 'Enlace renovado (token nuevo)', enlace_revocado: 'Enlace revocado', idioma_cambiado: 'Idioma del formulario cambiado', correo_enviado: 'Formulario enviado por correo', mensaje_enviado: 'Mensaje enviado', enlace_enviado: 'Enlace marcado como enviado', recordatorio_enviado: 'Recordatorio enviado',
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
  // Columnas: las fijas del seguimiento + cualquier campo del formulario (todos los clientes tienen la misma estructura).
  // Lo que elijas se guarda en este navegador y aplica a todas las filas.
  const COLS_DEF = ['empresa', 'contacto', 'estado', 'enviado_en', 'canal', 'mailInf', 'salesnav', 'mailEstado', 'atiende', 'progreso', 'revisado'];
  const META = [['empresa', 'Empresa'], ['estado', 'Estado'], ['enviado_en', 'Enviado'], ['progreso', 'Progreso'], ['revisado', 'Revisado']];
  let _cols = (() => { try { const a = JSON.parse(localStorage.getItem('ini_cols_v1')); if (Array.isArray(a) && a.length) return a; } catch (_) {} return COLS_DEF.slice(); })();
  const guardaCols = () => { try { localStorage.setItem('ini_cols_v1', JSON.stringify(_cols)); } catch (_) {} };
  function catalogo() {   // [{ sec, items: [[key, etiqueta]] }]
    const out = [{ sec: 'Seguimiento', items: META }];
    if (_schema) for (const s of _schema.secciones) {
      const items = s.campos.filter(c => c.tipo !== 'check' && !c.sensible && c.id !== 'razon').map(c => [c.id, c.es]);
      if (items.length) out.push({ sec: (s.titulo && s.titulo.es) || '', items });
    }
    return out;
  }
  const etiqueta = k => { for (const g of catalogo()) { const f = g.items.find(i => i[0] === k); if (f) return f[1]; } return k; };
  const MAPAS = () => ({ canal: CANAL, salesnav: SN, mailEstado: MAILE });
  function texto(x, k) {   // texto de una celda de campo del formulario
    const raw = x.v && x.v[k] != null ? x.v[k] : x[k];
    if (raw == null || raw === '') return '';
    const m = MAPAS()[k]; if (m && m[raw]) return m[raw];
    const c = campoDe(k); if (c && c.opts) { const o = c.opts.find(o => o.v === raw); if (o) return o.es; }
    return String(raw);
  }
  function celda(x, k) {
    if (k === 'empresa') return `<td><b>${E(x.empresa || '—')}</b></td>`;
    if (k === 'estado') return `<td>${chip(x.estado)}</td>`;
    if (k === 'enviado_en') return `<td>${fdate(x.enviado_en)}</td>`;
    if (k === 'progreso') return `<td><div class="ini-bar" title="${x.progreso} %"><i style="width:${x.progreso}%"></i></div><small>${x.progreso} %</small></td>`;
    if (k === 'revisado') return `<td>${x.revisado ? '✓ ' + fdate(x.revisado_en) : '—'}</td>`;
    const t = texto(x, k); return `<td title="${E(t)}">${E(t || '—')}</td>`;
  }
  const valorOrden = (x, k) => (k === 'empresa' || k === 'estado' || k === 'enviado_en' || k === 'progreso' || k === 'revisado') ? x[k] : texto(x, k);
  function filtradas() {
    const q = _q.trim().toLowerCase();
    let r = _rows.filter(x => (!_fe || x.estado === _fe) && (!q || [x.empresa, x.contacto, x.mailInf, x.atiende, x.canal].join(' ').toLowerCase().includes(q)));
    const k = _sort.k, d = _sort.d;
    r.sort((a, b) => { const A = valorOrden(a, k), B = valorOrden(b, k); if (typeof A === 'number' || typeof B === 'number' || typeof A === 'boolean') return ((+A || 0) - (+B || 0)) * d; return String(A || '').localeCompare(String(B || ''), 'es') * d; });
    return r;
  }
  function pintarLista() {
    const r = filtradas(), th = _cols.map(k => [k, etiqueta(k)]).map(([k, l]) => `<th class="ini-th" onclick="InicioModule.ordenar('${k}')">${l}${_sort.k === k ? (_sort.d > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '<th class="ini-th ini-gearc"><button class="ini-plus" title="Agregar o quitar columnas" onclick="event.stopPropagation();InicioModule.menuCols(this)">+</button></th>';
    const tr = r.map(x => `<tr onclick="InicioModule.abrirFicha(${x.id})">${_cols.map(k => celda(x, k)).join('')}<td class="ini-gearc"><button class="ini-gear" title="Opciones" onclick="event.stopPropagation();InicioModule.menuFila(${x.id},this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></td></tr>`).join('');
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
      <p class="ini-hint">El enlace es único para este cliente, caduca a los 15 días y no pide cuenta ni contraseña. Se precarga con lo que ya sabemos del cliente.</p>
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cancelar</button><button class="btn btn-primary" onclick="InicioModule._nuevoCrear()">Crear enlace</button></div>`);
  }
  function _nuevoCambio() { const v = $('ini-nc').value; $('ini-nn').style.display = v ? 'none' : ''; }
  async function _nuevoCrear() {
    const cid = parseInt($('ini-nc').value, 10) || null, data = { cliente_id: cid, idioma: $('ini-ni').value };
    try {
      if (!cid) {   // el servidor crea el cliente en Operaciones (o reutiliza el que ya existe)
        const emp = $('ini-ne').value.trim(), con = $('ini-nco').value.trim();
        if (!emp && !con) return msg('Escribe la empresa o el nombre del contacto', 'error');
        Object.assign(data, { crear_cliente: true, empresa: emp, contacto: con, correo: $('ini-nm').value.trim() });
      }
      const r = await _post('/inicios', data); mostrarEnlace(r); if (_host && !_f) cargar(); } catch (e) { msg(e.message, 'error'); }
  }
  // Desde la ficha del cliente (Operaciones → Clientes)
  async function crearParaCliente(cid) {
    try { const r = await _post('/inicios', { cliente_id: cid }); mostrarEnlace(r); } catch (e) { msg(e.message, 'error'); }
  }
  function mostrarEnlace(r) {
    modal(`<h3 class="ini-mh">${r.existente ? 'Este cliente ya tiene un enlace' : 'Enlace de inicio listo'}</h3>
      <p class="ini-hint" style="margin-top:0">${r.existente ? 'Sigue vigente: es el mismo enlace.' : 'Envíaselo al cliente. Caduca a los 15 días.'}</p>
      <input class="ini-in" id="ini-url" readonly value="${E(r.url)}" onfocus="this.select()">
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cerrar</button><button class="btn btn-ghost" onclick="window.open('${E(r.url)}','_blank','noopener')">Abrir</button>
      <button class="btn btn-ghost" onclick="InicioModule.cerrar();InicioModule.ir(${r.id})">Ver ficha</button><button class="btn btn-primary" onclick="InicioModule.copiarEnlace(${r.id})">Copiar enlace y marcar como enviado</button></div>`);
  }
  // ══ Selector de columnas (botón «+» al final de la cabecera) ══
  function cerrarCols() { const m = $('ini-cmenu'); if (m) m.remove(); document.removeEventListener('mousedown', fueraCols, true); }
  function fueraCols(e) { const m = $('ini-cmenu'); if (m && !m.contains(e.target) && !(e.target.closest && e.target.closest('.ini-plus'))) cerrarCols(); }
  function pintaCols(q) {
    const w = String(q || '').toLowerCase().trim(), box = $('ini-clist'); if (!box) return;
    box.innerHTML = catalogo().map(g => {
      const its = g.items.filter(([k, l]) => !w || l.toLowerCase().includes(w));
      return its.length ? `<div class="ini-cg">${E(g.sec)}</div>` + its.map(([k, l]) => `<label class="ini-ci"><input type="checkbox" ${_cols.includes(k) ? 'checked' : ''} onchange="InicioModule.alternaCol('${k}',this.checked)"><span>${E(l)}</span></label>`).join('') : '';
    }).join('') || '<div class="ini-ce">Sin coincidencias</div>';
  }
  function menuCols(btn) {
    if ($('ini-cmenu')) return cerrarCols();
    const m = document.createElement('div'); m.id = 'ini-cmenu'; m.className = 'ini-gmenu ini-cmenu';
    m.innerHTML = `<div class="ini-ch">Columnas</div><input class="ini-in ini-cq" placeholder="Buscar campo…" oninput="InicioModule._buscaCol(this.value)"><div id="ini-clist" class="ini-clist"></div><div class="ini-cf"><button class="ini-gm" onclick="InicioModule.restauraCols()">Restablecer</button></div>`;
    document.body.appendChild(m); pintaCols('');
    const b = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) + 'px';
    m.style.top = (b.bottom + h + 8 > innerHeight ? Math.max(8, innerHeight - h - 8) : b.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', fueraCols, true), 0);
  }
  function alternaCol(k, on) {
    _cols = on ? (_cols.includes(k) ? _cols : _cols.concat(k)) : _cols.filter(x => x !== k);
    if (!_cols.length) _cols = ['empresa'];
    guardaCols(); pintarLista();
  }
  function restauraCols() { _cols = COLS_DEF.slice(); guardaCols(); pintarLista(); pintaCols(($('ini-cmenu') && $('ini-cmenu').querySelector('.ini-cq').value) || ''); }

  // ══ Menú de opciones de cada fila (ruedita) ══
  function cerrarMenu() { const m = $('ini-gmenu'); if (m) m.remove(); document.removeEventListener('click', cerrarMenu, true); }
  function menuFila(id, btn) {
    cerrarMenu(); const x = _rows.find(r => r.id === id); if (!x) return;
    const m = document.createElement('div'); m.id = 'ini-gmenu'; m.className = 'ini-gmenu';
    const it = (fn, t, cls) => `<button class="ini-gm${cls ? ' ' + cls : ''}" onclick="InicioModule.cerrarMenu();InicioModule.${fn}">${t}</button>`;
    m.innerHTML = it(`copiarFila(${id})`, 'Copiar enlace') + it(`abrirForm(${id})`, 'Abrir el formulario') + it(`msgFila(${id},'formulario',true)`, 'Enviar el formulario…') + it(`msgFila(${id},'recordatorio',true)`, 'Recordar datos faltantes…') + it(`abrirFicha(${id})`, 'Ver ficha') + '<div class="ini-gsep"></div><div class="ini-gl">Idioma del formulario</div>'
      + it(`idiomaFila(${id},'es')`, (x.idioma !== 'en' ? '✓ ' : '') + 'Español') + it(`idiomaFila(${id},'en')`, (x.idioma === 'en' ? '✓ ' : '') + 'English')
      + '<div class="ini-gsep"></div>' + it(`renovarFila(${id})`, 'Renovar 15 días') + it(`revocarFila(${id})`, 'Revocar enlace', 'ini-gm--bad');
    document.body.appendChild(m);
    const b = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) + 'px';
    m.style.top = (b.bottom + h + 8 > innerHeight ? Math.max(8, b.top - h - 4) : b.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', cerrarMenu, true), 0);
  }
  async function _url(id) { const f = await _j('/inicios/' + id); return f.url; }
  async function copiarFila(id) { try { await copiar(await _url(id), 'Enlace copiado'); try { await _post(`/inicios/${id}/marcar-enviado`); } catch (_) {} cargar(); } catch (e) { msg(e.message, 'error'); } }
  // ══ Configuración → Integraciones: envío principal ══
  async function cargarEnvio() {
    const host = $('cfg-envio-body'); if (!host) return;
    try {
      const d = await _j('/workspace/envio');
      const sel = (id, arr, cur, vacio) => `<select class="form-input" id="${id}" style="max-width:420px" onchange="InicioModule.guardarEnvio()"><option value="">${vacio}</option>${arr.map(x => `<option value="${x.id}"${x.id === cur ? ' selected' : ''}>${E(x.label)}</option>`).join('')}</select>`;
      host.innerHTML = `<div class="ini-cfg"><label>Buzón de correo principal</label>${sel('cfg-envio-bz', d.buzones, d.buzon_id, 'Sin elegir (se propone el primero)')}
        <label>WhatsApp principal</label>${sel('cfg-envio-wa', d.lineas, d.wa_id, 'Sin elegir (se propone el primero)')}
        <p class="fin-cfg-hint" id="cfg-envio-msg">Es el que se propone al enviar formularios y recordatorios a tus clientes; siempre puedes cambiarlo en cada envío.</p></div>`;
    } catch (e) { host.textContent = e.message; }
  }
  async function guardarEnvio() {
    const m = $('cfg-envio-msg');
    try { await _post('/workspace/envio', { buzon_id: $('cfg-envio-bz').value || null, wa_id: $('cfg-envio-wa').value || null }, 'PUT'); if (m) { m.textContent = 'Guardado ✓'; setTimeout(cargarEnvio, 1200); } }
    catch (e) { if (m) m.textContent = e.message; }
  }

  // ══ Enviar el formulario / recordar lo pendiente (correo o WhatsApp, plantilla ES/EN editable) ══
  let _msg = { canal: 'correo', idioma: '', lista: true, remitente: '', cc: '' };
  async function msgFila(id, tipo, nuevo) {
    if (nuevo) _msg = { canal: 'correo', idioma: '', lista: true, remitente: '', cc: '' };
    let d; try { d = await _j(`/inicios/${id}/mensaje?canal=${_msg.canal}&tipo=${tipo}&idioma=${_msg.idioma}&lista=${_msg.lista ? 1 : 0}`); } catch (e) { return msg(e.message, 'error'); }
    if (tipo === 'recordatorio' && !d.pendientes.length) return msg('Este cliente no tiene datos pendientes.', 'success');
    _msg.idioma = d.idioma; const wa = d.canal === 'wa', en = d.idioma === 'en', pend = d.pendientes || [];
    const rem = d.remitentes || [], remSel = rem.some(r => String(r.id) === String(_msg.remitente)) ? _msg.remitente : (rem[0] ? rem[0].id : '');
    modal(`<h3 class="ini-mh">${tipo === 'recordatorio' ? 'Recordar datos faltantes' : 'Enviar el formulario'}</h3>
      <div class="ini-seg" role="tablist"><button class="${!wa ? 'on' : ''}" onclick="InicioModule._msgCanal(${id},'${tipo}','correo')">Correo</button><button class="${wa ? 'on' : ''}" onclick="InicioModule._msgCanal(${id},'${tipo}','wa')">WhatsApp</button></div>
      <label class="ini-l">${wa ? 'Número de WhatsApp del cliente' : 'Para'}</label><input class="ini-in" id="ini-mto" ${wa ? 'type="tel"' : 'type="email"'} value="${E(d.to)}" placeholder="${wa ? '+51 987654321' : 'correo del cliente'}">
      ${wa ? '' : `<label class="ini-l">CC <span class="ini-opt">(opcional · separa varios con coma)</span></label><input class="ini-in" id="ini-mcc" type="text" value="${E(_msg.cc || '')}" placeholder="equipo@empresa.com, otra@empresa.com" oninput="InicioModule._msgCc(this.value)">`}
      <label class="ini-l">${wa ? 'Se envía desde (línea de WhatsApp)' : 'Se envía desde (buzón)'}</label>
      ${rem.length ? `<select class="ini-in" id="ini-mrm" onchange="InicioModule._msgRem(this.value)">${rem.map(r => `<option value="${r.id}"${String(r.id) === String(remSel) ? ' selected' : ''}>${E(r.label)}</option>`).join('')}</select>`
        : `<div class="ini-warn">${wa ? 'No tienes líneas de WhatsApp disponibles: no hay ninguna conectada o tu nivel de acceso no te permite usarlas.' : 'No tienes buzones disponibles: no hay ninguno conectado o tu nivel de acceso no te permite enviar desde ellos.'}</div>`}
      <div class="ini-two"><div><label class="ini-l">Idioma de la plantilla</label><select class="ini-in" id="ini-mid" onchange="InicioModule._msgRecarga(${id},'${tipo}')"><option value="es"${!en ? ' selected' : ''}>Español</option><option value="en"${en ? ' selected' : ''}>English</option></select></div>
        ${(d.gracias || tipo === 'recordatorio') ? '' : `<label class="ini-chk"><input type="checkbox" id="ini-mls" ${_msg.lista ? 'checked' : ''} onchange="InicioModule._msgRecarga(${id},'${tipo}')"><span>Incluir lo pendiente</span></label>`}</div>
      ${wa ? '' : `<label class="ini-l">Asunto</label><input class="ini-in" id="ini-mas" value="${E(d.asunto)}">`}
      <label class="ini-l">Mensaje <span class="ini-opt">(puedes editarlo; el enlace del formulario va dentro del mensaje)</span></label><textarea class="ini-in" id="ini-mcu" rows="9">${E(d.cuerpo)}</textarea>
      <div class="ini-minfo"><div><b>Cuándo sale:</b> al instante, al pulsar «Enviar».</div>
        <div><b>Le falta responder${pend.length ? ` (${pend.length})` : ''}:</b> ${pend.length ? `<details class="ini-det"><summary>ver lista</summary><ul>${pend.map(x => `<li>${E(x)}</li>`).join('')}</ul></details>` : 'nada, está completo. Se envía solo el agradecimiento.'}</div></div>
      <div class="ini-acts"><button class="btn btn-ghost" onclick="InicioModule.cerrar()">Cancelar</button><button class="btn btn-primary" id="ini-menv" onclick="InicioModule._msgEnviar(${id},'${tipo}')">Enviar</button></div>`);
  }
  const _msgCanal = (id, tipo, c) => { _msg.canal = c; _msg.remitente = ''; msgFila(id, tipo); };
  const _msgRem = v => { _msg.remitente = v; };
  const _msgCc = v => { _msg.cc = v; };
  const _msgRecarga = (id, tipo) => { _msg.idioma = $('ini-mid').value; _msg.lista = $('ini-mls') ? $('ini-mls').checked : true; msgFila(id, tipo); };
  async function _msgEnviar(id, tipo) {
    const b = $('ini-menv'); b.disabled = true; b.textContent = 'Enviando…';
    try {
      await _post(`/inicios/${id}/enviar-mensaje`, { canal: _msg.canal, to: $('ini-mto').value.trim(), idioma: $('ini-mid').value, asunto: $('ini-mas') ? $('ini-mas').value : '', cc: $('ini-mcc') ? $('ini-mcc').value : '', cuerpo: $('ini-mcu').value, remitente_id: $('ini-mrm') ? $('ini-mrm').value : '' });
      cerrar(); msg(_msg.canal === 'wa' ? 'Enviado por WhatsApp' : 'Correo enviado', 'success'); cargar();
    } catch (e) { b.disabled = false; b.textContent = 'Enviar'; msg(e.message, 'error'); }
  }
  async function pendientesFila(id) {
    try {
      let to = '';
      for (let i = 0; i < 2; i++) {
        try { await _post(`/inicios/${id}/recordatorio`, to ? { to } : {}); msg('Correo enviado al cliente con los puntos pendientes', 'success'); cargar(); return; }
        catch (e) { if (!/Falta el correo/.test(e.message) || i) throw e; to = (prompt('¿A qué correo se lo enviamos?') || '').trim(); if (!to) return; }
      }
    } catch (e) { msg(e.message, 'error'); }
  }
  async function abrirForm(id) { try { window.open(await _url(id), '_blank', 'noopener'); } catch (e) { msg(e.message, 'error'); } }
  async function idiomaFila(id, l) { try { await _post(`/inicios/${id}/idioma`, { idioma: l }); msg(l === 'en' ? 'Formulario en English' : 'Formulario en español', 'success'); cargar(); } catch (e) { msg(e.message, 'error'); } }
  async function renovarFila(id) { try { await _post(`/inicios/${id}/renovar`); msg('Enlace renovado 15 días', 'success'); cargar(); } catch (e) { msg(e.message, 'error'); } }
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
  const renovar = () => accion('renovar', 'Enlace renovado 15 días');
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
    cargarEnvio, guardarEnvio, msgFila, _msgCanal, _msgRem, _msgCc, _msgRecarga, _msgEnviar, menuCols, cerrarCols, alternaCol, restauraCols, _buscaCol: pintaCols, menuFila, cerrarMenu, pendientesFila, copiarFila, abrirForm, idiomaFila, renovarFila, revocarFila, marcarEnviado, renovar, revocar, recordatorio, revisar, borrarAccesos, portal };
})();
window.InicioModule = InicioModule;
