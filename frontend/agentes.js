// Configuración → Agentes: estado de los agentes de vigilancia del sistema (los corre el servidor cada pocos minutos).
const AgentesModule = (() => {
  let _data = null, _busy = new Set(), _timer = null;
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
  function _render() {
    const root = document.getElementById('agt-root'); if (!root) return;
    if (!_data) { root.innerHTML = '<div class="agt-empty">Cargando agentes…</div>'; return; }
    const ags = _data.agents || [];
    const act = ags.filter(a => a.enabled !== false);
    const n = k => act.filter(a => a.status === k).length;
    const areas = [...new Set(ags.map(a => a.area))];
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
      ${(_data.events || []).length ? `<div class="agt-ev">${_data.events.map(e => `<div class="agt-ev__row">
          <span class="agt-badge agt-badge--${e.severity === 'fail' ? 'fail' : 'warn'}">${e.severity === 'fail' ? 'Falla' : 'Atención'}</span>
          <span class="agt-ev__n">${esc(NAMES[e.key] || e.key)}</span>
          <span class="agt-ev__m">${esc(e.message)}</span>
          <span class="agt-ev__t">${_ago(e.created_at)}${e.resolved_at ? ' · <em>resuelto</em>' : (e.dismissed ? ' · <em>descartado</em>' : ' · <b>abierto</b>')}</span>
          ${(!e.resolved_at && !e.dismissed) ? `<button type="button" class="agt-btn agt-btn--ghost" onclick="AgentesModule.dismiss(${e.id})">Descartar</button>` : '<span></span>'}
        </div>`).join('')}</div>` : '<div class="agt-empty">Sin avisos todavía. Cuando un agente detecte algo, aparecerá aquí y en la campana de alertas.</div>'}
      <p class="agt-foot">Los agentes revisan solos mientras el sistema esté encendido. Un aviso se genera cuando el problema persiste en dos revisiones seguidas, y se cierra solo cuando se arregla.</p>`;
  }
  async function load() {
    _render();
    try {
      const r = await apiFetch(API_B() + '/watchdog'); if (!r.ok) throw new Error('Error ' + r.status);
      _data = await r.json(); _render();
    } catch (e) { const root = document.getElementById('agt-root'); if (root) root.innerHTML = '<div class="agt-empty">No se pudo cargar: ' + esc(e.message) + '</div>'; }
    clearInterval(_timer); _timer = setInterval(() => { if (!document.getElementById('agt-root') || document.querySelector('[data-sec="agentes"]')?.hidden) { clearInterval(_timer); return; } _refresh(); }, 30000);
  }
  async function _refresh() { try { const r = await apiFetch(API_B() + '/watchdog'); if (r.ok) { _data = await r.json(); _render(); } } catch (_) {} }
  async function runOne(key) {
    _busy.add(key); _render();
    try { await apiFetch(API_B() + '/watchdog/' + key + '/run', { method: 'POST' }); } catch (_) {}
    _busy.delete(key); await _refresh(); if (window.RNotifPanel) RNotifPanel.load();
  }
  async function runAll() {
    _busy.add('*'); _render();
    try { await apiFetch(API_B() + '/watchdog/run-all', { method: 'POST' }); } catch (_) {}
    _busy.delete('*'); await _refresh(); if (window.RNotifPanel) RNotifPanel.load();
  }
  async function toggle(key, on) {
    try { await apiFetch(API_B() + '/watchdog/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!on }) }); } catch (_) {}
    await _refresh();
  }
  async function dismiss(id) {
    try { await apiFetch(API_B() + '/watchdog/events/' + id + '/dismiss', { method: 'POST' }); } catch (_) {}
    await _refresh(); if (window.RNotifPanel) RNotifPanel.load();
  }
  return { load, runOne, runAll, toggle, dismiss };
})();
