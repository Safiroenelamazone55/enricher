// Módulo «Warm-up» (estilo Lemwarm): panel de control, salud de los buzones, grupo de calentamiento y pruebas de bandeja.
// Usa lo global de app.js: API, apiFetch, esc, showBanner, novaConfirm.
const WarmupModule = (() => {
  const BODY = { 'warmup': 'warmup-body', 'warmup-buzones': 'warmup-buzones-body', 'warmup-pool': 'warmup-pool-body', 'warmup-pruebas': 'warmup-pruebas-body' };
  let _b = null, _pool = null, _tab = 'warmup', _open = new Set(), _poll = 0, _cargando = false;
  const el = id => document.getElementById(id);
  const hoy = () => { const d = new Date(); return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' }); };
  const SV = (d, w) => `<svg width="${w || 16}" height="${w || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const color = n => n === null || n === undefined ? '#98A1AC' : n >= 90 ? '#16A34A' : n >= 65 ? '#D97706' : '#DC2626';
  const ring = (n, sz) => {
    sz = sz || 44; const r = (sz - 6) / 2, c = 2 * Math.PI * r, v = n === null || n === undefined ? 0 : Math.max(0, Math.min(100, n)), col = color(n);
    return `<span class="wm-ring" style="width:${sz}px;height:${sz}px"><svg width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}"><circle cx="${sz / 2}" cy="${sz / 2}" r="${r}" fill="none" stroke="#ECEAE6" stroke-width="4"/><circle cx="${sz / 2}" cy="${sz / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${sz / 2} ${sz / 2})"/></svg><b style="color:${col}">${n === null || n === undefined ? '—' : n}</b></span>`;
  };
  const chip = (t, k) => `<span class="wm-chip wm-chip--${k || 'gris'}">${esc(t)}</span>`;
  const faseChip = f => ({ rampa: chip('Subiendo', 'azul'), estabilizacion: chip('Estabilizando', 'ambar'), activo: chip('Activo', 'verde'), limite: chip('Límite fijo', 'gris'), sin: chip('Sin rampa', 'gris') }[f && f.fase] || chip('—'));
  const ago = d => { if (!d) return ''; const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };
  const nombre = () => { const u = window._authUser || {}; return String(u.memberNombre || u.name || '').split(' ')[0] || ''; };

  async function _load() {
    _cargando = true;
    try {
      const [a, p] = await Promise.all([apiFetch(`${API}/lm/warmup/buzones`).then(r => r.ok ? r.json() : []).catch(() => []), apiFetch(`${API}/lm/warmup/pool`).then(r => r.ok ? r.json() : []).catch(() => [])]);
      _b = a; _pool = p;
    } finally { _cargando = false; }
  }
  function _titulo(t, s, acc) { return `<div class="wm-hd"><div><h1>${t}</h1>${s ? `<p>${s}</p>` : ''}</div>${acc || ''}</div>`; }
  function _pintar() {
    const host = el(BODY[_tab]); if (!host) return;
    if (_b === null) { host.innerHTML = '<div class="wm"><div class="wm-vacio">Cargando…</div></div>'; return; }
    host.innerHTML = '<div class="wm">' + ({ 'warmup': _dash, 'warmup-buzones': _buzones, 'warmup-pool': _grupo, 'warmup-pruebas': _pruebas }[_tab] || _dash)() + '</div>';
    clearTimeout(_poll);
    if (_tab === 'warmup-pool' && (_pool || []).some(x => x.estado === 'probando')) _poll = setTimeout(async () => { if (_tab !== 'warmup-pool') return; await _load(); _pintar(); }, 3000);
  }
  async function render(tab) {
    _tab = BODY[tab] ? tab : 'warmup';
    _pintar();
    if (!_cargando) { await _load(); _pintar(); }
  }

  // ── Panel de control ──
  function _dash() {
    const b = _b || [], pl = _pool || [];
    const verdes = b.filter(x => x.salud && x.salud.nota >= 90).length, autos = b.filter(x => x.ramp_auto).length, conPool = pl.filter(x => x.estado === 'conectado').length;
    const pasos = [
      { t: 'Conecta tus buzones', ok: b.length > 0, txt: b.length ? `${b.length} buzón${b.length > 1 ? 'es' : ''} conectado${b.length > 1 ? 's' : ''}` : 'Aún no hay buzones', btn: b.length ? 'Ver buzones' : 'Conectar buzón', f: b.length ? "WarmupModule.ir('warmup-buzones')" : "selectModule('leadmanagement')" },
      { t: 'Revisa la salud del dominio', ok: b.length > 0 && verdes === b.length, txt: b.length ? `${verdes} de ${b.length} en verde (90 o más)` : 'Primero conecta un buzón', btn: 'Revisar', f: "WarmupModule.ir('warmup-buzones')" },
      { t: 'Activa el ajuste automático', ok: b.length > 0 && autos === b.length, txt: b.length ? `${autos} de ${b.length} con ajuste automático` : 'Primero conecta un buzón', btn: 'Configurar', f: "WarmupModule.ir('warmup-buzones')" },
      { t: 'Crea tu grupo de calentamiento', ok: conPool >= 10, txt: pl.length ? `${conPool} de ${pl.length} buzones listos` : 'Importa tus buzones de calentamiento', btn: pl.length ? 'Ver grupo' : 'Importar buzones', f: "WarmupModule.ir('warmup-pool')" },
    ];
    let actual = pasos.findIndex(p => !p.ok); if (actual < 0) actual = 99;
    const cards = pasos.map((p, i) => `<div class="wm-step ${p.ok ? 'is-ok' : i === actual ? 'is-now' : 'is-next'}"><div class="wm-step__t"><span class="wm-step__n">${p.ok ? SV('<path d="M20 6 9 17l-5-5"/>', 14) : i + 1}</span>${esc(p.t)}</div><div class="wm-step__d">${esc(p.txt)}</div><button class="wm-btn${p.ok ? '' : i === actual ? ' wm-btn--pri' : ''}" ${i > actual ? 'disabled' : ''} onclick="${p.f}">${p.ok ? '✓ ' : ''}${esc(p.btn)}</button></div>`).join('');
    const notas = b.map(x => x.salud && x.salud.nota).filter(n => n !== null && n !== undefined);
    const media = notas.length ? Math.round(notas.reduce((a, n) => a + n, 0) / notas.length) : null;
    const env = b.reduce((a, x) => a + (x.enviados_hoy || 0), 0), cupo = b.every(x => x.cap_hoy !== null) ? b.reduce((a, x) => a + (x.cap_hoy || 0), 0) : null;
    const n14 = b.reduce((a, x) => a + x.n14, 0), b14 = b.reduce((a, x) => a + x.b14, 0);
    const kp = (l, v, s) => `<div class="wm-kpi"><div class="wm-kpi__v">${v}</div><div class="wm-kpi__l">${l}</div><div class="wm-kpi__s">${s || ''}</div></div>`;
    const alertas = b.filter(x => x.estado !== 'conectado' || (x.salud && x.salud.nota < 90) || (x.n14 >= 10 && x.tasa_rebote > 5)).map(x => {
      const m = x.estado !== 'conectado' ? `El buzón está ${esc(x.estado)}${x.last_error ? ': ' + esc(x.last_error) : ''}.` : x.n14 >= 10 && x.tasa_rebote > 5 ? `Rebote de ${x.tasa_rebote} % en 14 días (${x.b14} de ${x.n14} envíos): baja el volumen y limpia la lista.` : x.consejo ? esc(x.consejo.texto) : '';
      return `<div class="wm-al"><b>${esc(x.email)}</b><span>${m}</span></div>`;
    }).join('');
    return _titulo(`Bienvenido${nombre() ? ' ' + esc(nombre()) : ''} 👋`, 'Cuida la reputación de tus buzones antes de enviar en volumen.') +
      `<div class="wm-steps">${cards}</div>
       <div class="wm-kpis">${kp('Buzones conectados', b.length, b.length ? `${b.filter(x => x.estado === 'conectado').length} funcionando` : '')}${kp('Nota media', media === null ? '—' : media, media === null ? 'Sin revisiones todavía' : media >= 90 ? 'Listo para enviar' : media >= 65 ? 'Solo calentar, sin subir volumen' : 'Arreglar antes de enviar')}${kp('Enviados hoy', env, cupo === null ? 'Sin tope' : `de ${cupo} de cupo`)}${kp('Rebote (14 días)', n14 ? (b14 / n14 * 100).toFixed(1) + ' %' : '—', n14 ? `${b14} de ${n14} envíos` : 'Sin envíos')}</div>
       <div class="wm-card"><div class="wm-card__t">Qué atender ahora</div>${alertas || '<div class="wm-vacio" style="padding:18px">Todo en orden: ningún buzón necesita atención.</div>'}</div>`;
  }

  // ── Buzones ──
  function _buzones() {
    const b = _b || [];
    const fila = x => {
      const s = x.salud, abierto = _open.has(x.id), f = x.fase;
      const pct = x.cap_hoy ? Math.min(100, Math.round(x.enviados_hoy / x.cap_hoy * 100)) : 0;
      const det = !abierto ? '' : `<div class="wm-det">
        <div class="wm-det__col"><div class="wm-det__t">Puntuación${s ? ` · ${s.puntos} de ${s.de} puntos medibles` : ''}</div>
          ${s ? s.factores.map(g => `<div class="wm-fac"><span class="wm-fac__n">${esc(g.nombre)}</span><span class="wm-fac__p">${g.medido ? `${g.pts}/${g.max}` : `<i>sin medir · ${g.max}</i>`}</span><div class="wm-fac__d">${esc(g.detalle)}</div></div>`).join('') : '<div class="wm-vacio" style="padding:12px 0">Revisando el dominio…</div>'}
          ${s ? `<div class="wm-det__s">Revisado ${ago(s.revisadoEn)}</div>` : ''}</div>
        <div class="wm-det__col"><div class="wm-det__t">Calentamiento</div>
          <div class="wm-fac"><span class="wm-fac__n">Fase</span><span class="wm-fac__p">${esc(f.texto)}</span><div class="wm-fac__d">${esc(f.detalle || '')}</div></div>
          ${x.ramp_on ? `<div class="wm-fac"><span class="wm-fac__n">Rampa</span><span class="wm-fac__p">${x.ramp_start} → ${x.ramp_target}</span><div class="wm-fac__d">Sube ${x.ramp_step} al día cada semana hasta ${x.ramp_target}.</div></div>` : ''}
          <div class="wm-det__t" style="margin-top:14px">Últimos cambios</div>
          ${x.eventos.length ? x.eventos.map(e => `<div class="wm-ev"><span>${esc(e.detalle)}</span><i>${ago(e.at)}</i></div>`).join('') : '<div class="wm-fac__d">Todavía no hay cambios automáticos.</div>'}</div></div>`;
      return `<div class="wm-row${abierto ? ' is-open' : ''}">
        <div class="wm-row__main" onclick="WarmupModule.abrir(${x.id})">
          <span class="wm-av">${esc((x.email || '?')[0].toUpperCase())}</span>
          <div class="wm-row__id"><b>${esc(x.email)}</b><small>${esc(x.cliente || 'Sin cliente')} · ${esc(x.provider)}${x.estado !== 'conectado' ? ' · ' + esc(x.estado) : ''}</small></div>
          ${ring(s ? s.nota : null)}
          <div class="wm-row__f">${faseChip(f)}<small>${esc(f.detalle || '')}</small></div>
          <div class="wm-row__c"><div class="wm-bar"><i style="width:${pct}%"></i></div><small>${x.enviados_hoy} de ${x.cap_hoy === null ? '∞' : x.cap_hoy} hoy</small></div>
          <div class="wm-row__r"><b>${x.tasa_rebote === null ? '—' : x.tasa_rebote + ' %'}</b><small>rebote 14 d</small></div>
          <span class="wm-chev">${SV('<path d="m6 9 6 6 6-6"/>')}</span>
        </div>
        <div class="wm-row__act" onclick="event.stopPropagation()">
          <label class="wm-sw" title="Sube el cupo si los rebotes son bajos y lo baja si son altos"><input type="checkbox" ${x.ramp_auto ? 'checked' : ''} ${x.ramp_on ? '' : 'disabled'} onchange="WarmupModule.auto(${x.id},this.checked)"><span></span>Ajuste automático</label>
          <button class="wm-btn" onclick="WarmupModule.revisar(${x.id},this)">Revisar ahora</button>
        </div>${det}</div>`;
    };
    return _titulo('Buzones', 'Salud y calentamiento de los buzones de tus clientes.') +
      (b.length ? `<div class="wm-list">${b.map(fila).join('')}</div>` : '<div class="wm-card"><div class="wm-vacio">Aún no hay buzones conectados. Conéctalos desde Outreach → Clientes outbound → Remitentes.</div></div>');
  }

  // ── Grupo de calentamiento ──
  function _grupo() {
    const pl = _pool || [], listos = pl.filter(x => x.estado === 'conectado').length;
    const est = x => ({ conectado: chip('Conectado', 'verde'), solo_envio: chip('Solo envío', 'ambar'), probando: chip('Probando…', 'azul'), error: chip('Error', 'rojo') }[x.estado] || chip(x.estado));
    return _titulo('Grupo de calentamiento', `${pl.length ? `${listos} de ${pl.length} buzones listos. ` : ''}Buzones propios que se escriben entre sí para dar actividad y reputación a los demás.`,
        `<button class="wm-btn wm-btn--pri" onclick="WarmupModule.importar()">+ Importar buzones</button>`) +
      `<div class="wm-aviso">${SV('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', 16)}<span>Aquí se guardan y verifican los buzones (con la contraseña cifrada). El envío de calentamiento entre ellos todavía <b>no está activo</b>: se enciende cuando el grupo esté completo y probado.</span></div>` +
      (pl.length ? `<div class="wm-card wm-tbl"><div class="wm-tr wm-tr--h"><span>Buzón</span><span>Proveedor</span><span>Estado</span><span></span></div>${pl.map(x => `<div class="wm-tr"><span class="wm-tr__e"><b>${esc(x.email)}</b>${x.last_error ? `<small>${esc(x.last_error)}</small>` : ''}</span><span>${esc(x.provider)}</span><span>${est(x)}</span><span class="wm-tr__a"><button class="wm-btn" onclick="WarmupModule.probar(${x.id})">Probar</button><button class="wm-btn wm-btn--rojo" onclick="WarmupModule.quitar(${x.id})">Quitar</button></span></div>`).join('')}</div>`
        : '<div class="wm-card"><div class="wm-vacio">Todavía no hay buzones en el grupo. Importa los que creaste (correo y contraseña de aplicación).</div></div>');
  }
  function importar() {
    el('wm-modal')?.remove();
    const m = document.createElement('div'); m.id = 'wm-modal'; m.className = 'wm-modal'; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="wm-modal__box"><div class="wm-modal__hd"><h3>Importar buzones de calentamiento</h3><button class="wm-x" onclick="document.getElementById('wm-modal').remove()">✕</button></div>
      <p class="wm-modal__p">Pega una línea por buzón: <code>correo,contraseña de aplicación</code> (hasta 40). Se prueban solos y la contraseña se guarda cifrada.</p>
      <div class="wm-modal__g"><label>Proveedor<select id="wm-prov" onchange="document.getElementById('wm-zreg').style.display=this.value==='zoho'?'':'none'"><option value="zoho">Zoho Mail</option><option value="google">Google Workspace / Gmail</option><option value="microsoft">Microsoft 365 (SMTP con contraseña)</option><option value="otro">Otro (SMTP/IMAP)</option></select></label>
      <label id="wm-zreg">Región de Zoho<select id="wm-zr"><option value="com">com (EE. UU.)</option><option value="eu">eu (Europa)</option><option value="in">in (India)</option><option value="com.au">com.au</option><option value="jp">jp</option></select></label></div>
      <textarea id="wm-filas" rows="9" placeholder="calentar1@tudominio.com,abcd efgh ijkl mnop&#10;calentar2@tudominio.com,..." spellcheck="false"></textarea>
      <div id="wm-err" class="wm-err" style="display:none"></div>
      <div class="wm-modal__ft"><button class="wm-btn" onclick="document.getElementById('wm-modal').remove()">Cancelar</button><button class="wm-btn wm-btn--pri" id="wm-go" onclick="WarmupModule.enviarImport()">Importar y probar</button></div></div>`;
    document.body.appendChild(m); setTimeout(() => el('wm-filas')?.focus(), 50);
  }
  async function enviarImport() {
    const filas = String((el('wm-filas') || {}).value || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const i = l.search(/[,;\t]/); return i < 0 ? { email: l, password: '' } : { email: l.slice(0, i).trim(), password: l.slice(i + 1).trim() }; });
    const err = el('wm-err'); err.style.display = 'none';
    if (!filas.length) { err.textContent = 'Pega al menos una línea.'; err.style.display = ''; return; }
    const btn = el('wm-go'); btn.disabled = true; btn.textContent = 'Importando…';
    try {
      const r = await apiFetch(`${API}/lm/warmup/pool/importar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: el('wm-prov').value, zoho_region: el('wm-zr').value, filas }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'No se pudo importar');
      el('wm-modal')?.remove(); showBanner(`✓ ${d.total} buzón${d.total > 1 ? 'es' : ''} importado${d.total > 1 ? 's' : ''}: se están probando`, 'success');
      await _load(); _pintar();
    } catch (e) { err.textContent = e.message; err.style.display = ''; btn.disabled = false; btn.textContent = 'Importar y probar'; }
  }
  async function probar(id) { await apiFetch(`${API}/lm/warmup/pool/${id}/probar`, { method: 'POST' }); await _load(); _pintar(); }
  async function quitar(id) {
    const p = (_pool || []).find(x => x.id === id);
    if (!(await novaConfirm({ title: '¿Quitar este buzón del grupo?', message: p ? `Se elimina <b>${esc(p.email)}</b> de Nova (no se borra la cuenta de correo).` : '', ok: 'Quitar', cancel: 'Cancelar', tone: 'danger' }))) return;
    await apiFetch(`${API}/lm/warmup/pool/${id}`, { method: 'DELETE' }); await _load(); _pintar();
  }

  // ── Pruebas de bandeja ──
  function _pruebas() {
    return _titulo('Pruebas de bandeja', 'Comprueba en qué carpeta cae un correo antes de lanzar una campaña.') +
      `<div class="wm-card"><div class="wm-vacio"><b>Próximamente</b><br>Se enviará un correo de prueba desde un buzón a cuentas semilla (Gmail, Outlook, Zoho…) y se leerá por IMAP si cayó en Entrada, Promociones o Spam.<br>Necesita 4–6 cuentas semilla conectadas.</div></div>`;
  }

  // ── acciones ──
  function ir(t) { if (typeof window._novaSwitchTab === 'function') window._novaSwitchTab(t); }
  function abrir(id) { _open.has(id) ? _open.delete(id) : _open.add(id); _pintar(); }
  async function revisar(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Revisando…'; }
    try {
      const r = await apiFetch(`${API}/lm/warmup/buzones/${id}/revisar`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
      _open.add(id); await _load(); _pintar(); showBanner('✓ Buzón revisado', 'success');
    } catch (e) { showBanner('No se pudo revisar: ' + e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Revisar ahora'; } }
  }
  async function auto(id, on) {
    const x = (_b || []).find(y => y.id === id);
    try {
      const r = await apiFetch(`${API}/lm/warmup/buzones/${id}/auto`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: on, techo: x ? x.ramp_techo : 60 }) });
      if (!r.ok) throw new Error('Error'); if (x) x.ramp_auto = on;
      showBanner(on ? 'Ajuste automático activado: el cupo se revisa cada día' : 'Ajuste automático desactivado', 'success');
    } catch (_) { showBanner('No se pudo guardar', 'error'); await _load(); _pintar(); }
  }
  return { render, ir, abrir, revisar, auto, importar, enviarImport, probar, quitar };
})();
