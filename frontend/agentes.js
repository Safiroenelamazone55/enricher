// Configuración → Agentes: estado de los agentes de vigilancia del sistema (los corre el servidor cada pocos minutos).
// Cada aviso se abre para ver el ERROR EXACTO (mensaje completo, dónde ocurre, cuántas veces) y debajo hay un Registro de errores permanente
// para volver, copiar el error tal cual y arreglarlo.
const AgentesModule = (() => {
  let _data = null, _busy = new Set(), _timer = null, _errs = null;
  const _open = new Set(), _errOpen = new Set();
  const API_B = () => (typeof API !== 'undefined' ? API : '/api');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ST = { ok: ['En orden', 'ok'], warn: ['Atención', 'warn'], fail: ['Falla', 'fail'], info: ['Informativo', 'info'], pendiente: ['Sin revisar', 'pend'] };
  const NAMES = { base_datos: 'Base de datos', servidor: 'Servidor (RAM y disco)', app_web: 'Aplicación web y API', buzones: 'Buzones de correo', envios_email: 'Envíos de email', rebotes: 'Rebotes de correo', whatsapp: 'WhatsApp', errores_servidor: 'Errores del servidor', integraciones: 'Integraciones pendientes' };
  window._agentNames = NAMES;
  function _ago(d) {
    if (!d) return 'nunca';
    const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return 'hace un momento';
    const m = Math.round(s / 60); if (m < 60) return 'hace ' + m + ' min';
    const h = Math.round(m / 60); if (h < 48) return 'hace ' + h + ' h';
    return 'hace ' + Math.round(h / 24) + ' d';
  }
  const _fecha = d => { try { return new Date(d).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'medium' }); } catch (_) { return String(d || ''); } };
  const _banner = (m, t) => { if (typeof showBanner === 'function') showBanner(m, t || 'success'); };
  // Copiar al portapapeles (con alternativa si el navegador no lo permite en este contexto).
  async function _copy(text) {
    try { await Promise.race([navigator.clipboard.writeText(text), new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 1500))]); return true; }
    catch (_) {
      try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
      catch (__) { return false; }
    }
  }
  const _txtErr = x => `[${x.tipo || 'Error'}] ×${x.veces}${x.origen ? ' · en ' + x.origen : ''}\n${x.mensaje || ''}${(x.stack || []).length ? '\n' + x.stack.map(f => '    ' + f).join('\n') : ''}`;
  function _card(a) {
    const [lbl, cls] = ST[a.status] || ST.pendiente;
    const off = a.enabled === false;
    return `<div class="agt-card${off ? ' is-off' : ''}">
      <span class="agt-dot agt-dot--${off ? 'pend' : cls}" title="${off ? 'Desactivado' : lbl}"></span>
      <div class="agt-main">
        <div class="agt-row1"><b>${esc(a.name)}</b><span class="agt-badge agt-badge--${off ? 'pend' : cls}">${off ? 'Desactivado' : lbl}</span></div>
        <div class="agt-desc">${esc(a.desc)}</div>
        <div class="agt-msg">${off ? 'Este agente no está revisando.' : esc(a.message || '')}</div>
      </div>
      <div class="agt-side">
        <span class="agt-when">${off ? '' : _ago(a.last_run_at) + ' · cada ' + a.every + ' min'}</span>
        <div class="agt-btns">
          <button type="button" class="agt-btn" ${_busy.has(a.key) || off ? 'disabled' : ''} onclick="AgentesModule.runOne('${a.key}')">${_busy.has(a.key) ? 'Revisando…' : 'Revisar ahora'}</button>
          <label class="agt-sw" title="${off ? 'Activar' : 'Desactivar'}"><input type="checkbox" ${off ? '' : 'checked'} onchange="AgentesModule.toggle('${a.key}',this.checked)"><span></span></label>
        </div>
      </div>
    </div>`;
  }
  // Un aviso del historial: se abre para ver el mensaje COMPLETO y los errores exactos que lo causaron.
  function _evHtml(e) {
    const open = _open.has(e.id), det = (e.detail && e.detail.errores) || [];
    const abierto = !e.resolved_at && !e.dismissed;
    return `<div class="agt-ev__item${open ? ' is-open' : ''}">
      <div class="agt-ev__row" onclick="AgentesModule.toggleEv(${e.id})" title="Ver el detalle exacto">
        <span class="agt-badge agt-badge--${e.severity === 'fail' ? 'fail' : 'warn'}">${e.severity === 'fail' ? 'Falla' : 'Atención'}</span>
        <span class="agt-ev__n"><i class="agt-ev__chev">▸</i> ${esc(NAMES[e.key] || e.key)}</span>
        <span class="agt-ev__m">${esc(e.message)}</span>
        <span class="agt-ev__t">${_ago(e.created_at)}${e.resolved_at ? ' · <em>resuelto</em>' : (e.dismissed ? ' · <em>descartado</em>' : ' · <b>abierto</b>')}</span>
        ${abierto ? `<button type="button" class="agt-btn agt-btn--ghost" onclick="event.stopPropagation();AgentesModule.dismiss(${e.id})">Descartar</button>` : '<span></span>'}
      </div>
      ${open ? `<div class="agt-ev__x">
        <div class="agt-x__h"><b>Detalle del aviso</b><span class="agt-x__d">${_fecha(e.created_at)}${e.resolved_at ? ' · resuelto ' + _fecha(e.resolved_at) : ''}</span>
          <button type="button" class="agt-btn agt-btn--ghost" onclick="AgentesModule.copyEv(${e.id})">Copiar todo</button></div>
        <pre class="agt-pre">${esc(e.message)}</pre>
        ${det.length ? `<div class="agt-x__h" style="margin-top:12px"><b>Errores exactos detectados (${det.length})</b><span class="agt-x__d">agrupados: el mismo error con otros números cuenta como uno</span></div>
          ${det.map(x => `<div class="agt-err"><div class="agt-err__h"><span class="agt-badge agt-badge--fail">${esc(x.tipo || 'Error')}</span><b>×${x.veces}</b>${x.origen ? `<span class="agt-err__o">${esc(x.origen)}</span>` : ''}</div>
            <pre class="agt-pre">${esc(x.mensaje)}${(x.stack || []).length ? '\n\n' + esc(x.stack.slice(0, 8).join('\n')) : ''}</pre></div>`).join('')}` : ''}
      </div>` : ''}
    </div>`;
  }
  // Registro permanente de errores distintos.
  const _EST = { abierto: ['Abierto', 'fail'], resuelto: ['Resuelto', 'ok'], ignorado: ['Ignorado', 'pend'] };
  function _errHtml(x) {
    const open = _errOpen.has(x.id), [lbl, cls] = _EST[x.estado] || _EST.abierto;
    return `<div class="agt-ev__item${open ? ' is-open' : ''}">
      <div class="agt-er__row" onclick="AgentesModule.toggleErr(${x.id})" title="Ver el error completo">
        <span class="agt-badge agt-badge--${cls}">${lbl}</span>
        <span class="agt-ev__n"><i class="agt-ev__chev">▸</i> ${esc(x.tipo || 'Error')} <b>×${x.veces}</b></span>
        <span class="agt-ev__m">${esc(String(x.mensaje || '').replace(/\s+/g, ' '))}</span>
        <span class="agt-ev__t">última ${_ago(x.ultima_vez)}</span>
      </div>
      ${open ? `<div class="agt-ev__x">
        <div class="agt-x__h"><b>${esc(x.tipo || 'Error')}</b><span class="agt-x__d">${x.veces} vez/veces · primera ${_fecha(x.primera_vez)} · última ${_fecha(x.ultima_vez)}${x.origen ? ' · en ' + esc(x.origen) : ''}</span>
          <button type="button" class="agt-btn agt-btn--ghost" onclick="AgentesModule.copyErr(${x.id})">Copiar error</button></div>
        <pre class="agt-pre">${esc(x.mensaje)}${x.stack ? '\n\n' + esc(x.stack) : ''}</pre>
        <div class="agt-x__h" style="margin-top:10px">
          <select class="agt-sel" onchange="AgentesModule.setErr(${x.id}, {estado: this.value})">${Object.entries(_EST).map(([k, [l]]) => `<option value="${k}"${x.estado === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <input class="agt-note" placeholder="Nota: qué se probó, qué falta…" value="${esc(x.nota || '')}" onchange="AgentesModule.setErr(${x.id}, {nota: this.value})">
        </div>
      </div>` : ''}
    </div>`;
  }
  function _render() {
    const root = document.getElementById('agt-root'); if (!root) return;
    if (!_data) { root.innerHTML = '<div class="agt-empty">Cargando agentes…</div>'; return; }
    const ags = _data.agents || [];
    const act = ags.filter(a => a.enabled !== false);
    const n = k => act.filter(a => a.status === k).length;
    const areas = [...new Set(ags.map(a => a.area))];
    const errs = _errs || [], nAb = errs.filter(x => x.estado === 'abierto').length;
    root.innerHTML = `
      <div class="agt-sum">
        <div class="agt-sum__pills">
          <span class="agt-pill agt-pill--ok"><i></i>${n('ok')} en orden</span>
          <span class="agt-pill agt-pill--warn"><i></i>${n('warn')} con atención</span>
          <span class="agt-pill agt-pill--fail"><i></i>${n('fail')} con falla</span>
        </div>
        <button type="button" class="btn btn--primary btn--sm" ${_busy.has('*') ? 'disabled' : ''} onclick="AgentesModule.runAll()">${_busy.has('*') ? 'Revisando…' : 'Revisar todo ahora'}</button>
      </div>
      ${areas.map(ar => `<h4 class="agt-area">${esc(ar)}</h4>${ags.filter(a => a.area === ar).map(_card).join('')}`).join('')}
      <h4 class="agt-area">Historial de avisos</h4>
      ${(_data.events || []).length ? `<div class="agt-ev">${_data.events.map(_evHtml).join('')}</div>` : '<div class="agt-empty">Sin avisos todavía. Cuando un agente detecte algo, aparecerá aquí y en la campana de alertas.</div>'}
      <div class="agt-area agt-area--row"><h4 style="margin:0">Registro de errores</h4>
        ${errs.length ? `<span class="agt-x__d">${nAb} abierto(s) · ${errs.length} distinto(s) en total</span><button type="button" class="agt-btn agt-btn--ghost" onclick="AgentesModule.copyInforme()">Copiar informe de los abiertos</button>` : ''}</div>
      ${errs.length ? `<div class="agt-ev">${errs.map(_errHtml).join('')}</div>` : '<div class="agt-empty">Aquí quedará cada error distinto del servidor, con su mensaje completo, dónde ocurre y cuántas veces, para que puedas volver a revisarlo y optimizar. Aparecerá en cuanto el servidor registre alguno.</div>'}
      <p class="agt-foot">Los agentes revisan solos mientras el sistema esté encendido. Un aviso se genera cuando el problema persiste en dos revisiones seguidas, y se cierra solo cuando se arregla. El registro de errores no se borra: un error resuelto que reaparece se vuelve a abrir.</p>`;
  }
  async function _loadErrs() { try { const r = await apiFetch(API_B() + '/watchdog/errors'); if (r.ok) _errs = await r.json(); } catch (_) {} }
  async function load() {
    _render();
    try {
      const r = await apiFetch(API_B() + '/watchdog'); if (!r.ok) throw new Error('Error ' + r.status);
      _data = await r.json(); await _loadErrs(); _render();
    } catch (e) { const root = document.getElementById('agt-root'); if (root) root.innerHTML = '<div class="agt-empty">No se pudo cargar: ' + esc(e.message) + '</div>'; }
    clearInterval(_timer); _timer = setInterval(() => { if (!document.getElementById('agt-root') || document.querySelector('[data-sec="agentes"]')?.hidden) { clearInterval(_timer); return; } _refresh(); }, 30000);
  }
  async function _refresh() { try { const r = await apiFetch(API_B() + '/watchdog'); if (r.ok) { _data = await r.json(); await _loadErrs(); _render(); } } catch (_) {} }
  async function runOne(key) {
    _busy.add(key); _render();
    try { await apiFetch(API_B() + '/watchdog/' + key + '/run', { method: 'POST' }); } catch (_) {}
    _busy.delete(key); await _refresh(); if (typeof RNotifPanel !== 'undefined') RNotifPanel.load();
  }
  async function runAll() {
    _busy.add('*'); _render();
    try { await apiFetch(API_B() + '/watchdog/run-all', { method: 'POST' }); } catch (_) {}
    _busy.delete('*'); await _refresh(); if (typeof RNotifPanel !== 'undefined') RNotifPanel.load();
  }
  async function toggle(key, on) {
    try { await apiFetch(API_B() + '/watchdog/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!on }) }); } catch (_) {}
    await _refresh();
  }
  async function dismiss(id) {
    try { await apiFetch(API_B() + '/watchdog/events/' + id + '/dismiss', { method: 'POST' }); } catch (_) {}
    await _refresh(); if (typeof RNotifPanel !== 'undefined') RNotifPanel.load();
  }
  function toggleEv(id) { if (_open.has(id)) _open.delete(id); else _open.add(id); _render(); }
  function toggleErr(id) { if (_errOpen.has(id)) _errOpen.delete(id); else _errOpen.add(id); _render(); }
  async function copyEv(id) {
    const e = (_data && _data.events || []).find(x => x.id === id); if (!e) return;
    const det = (e.detail && e.detail.errores) || [];
    const t = `[${_fecha(e.created_at)}] ${NAMES[e.key] || e.key} — ${e.severity}\n${e.message}` + (det.length ? '\n\nERRORES EXACTOS:\n' + det.map(_txtErr).join('\n\n') : '');
    _banner(await _copy(t) ? '✓ Copiado' : 'No se pudo copiar', await _copy(t) ? 'success' : 'error');
  }
  async function copyErr(id) {
    const x = (_errs || []).find(e => e.id === id); if (!x) return;
    const ok = await _copy(_txtErr({ ...x, stack: x.stack ? x.stack.split('\n') : [] }) + `\nPrimera vez: ${_fecha(x.primera_vez)} · última: ${_fecha(x.ultima_vez)}${x.nota ? '\nNota: ' + x.nota : ''}`);
    _banner(ok ? '✓ Error copiado' : 'No se pudo copiar', ok ? 'success' : 'error');
  }
  async function copyInforme() {
    const ab = (_errs || []).filter(x => x.estado === 'abierto');
    const t = `INFORME DE ERRORES ABIERTOS (${ab.length}) — ${_fecha(new Date())}\n\n` + ab.map((x, i) => `#${i + 1} ` + _txtErr({ ...x, stack: x.stack ? x.stack.split('\n') : [] }) + `\nPrimera vez: ${_fecha(x.primera_vez)} · última: ${_fecha(x.ultima_vez)}${x.nota ? '\nNota: ' + x.nota : ''}`).join('\n\n----------\n\n');
    const ok = await _copy(t); _banner(ok ? `✓ Informe copiado (${ab.length} errores)` : 'No se pudo copiar', ok ? 'success' : 'error');
  }
  async function setErr(id, body) {
    try { await apiFetch(API_B() + '/watchdog/errors/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
    await _loadErrs(); _render();
  }
  return { load, runOne, runAll, toggle, dismiss, toggleEv, toggleErr, copyEv, copyErr, copyInforme, setErr };
})();
