'use strict';
// Inicio (Dashboard): bandeja «Para ti» + cobros, bloqueos, próximos 7 días, agenda de hoy, Outreach y equipo.
// Se pinta después de que DashboardModule carga (recibe las tareas ya descargadas).
const HomeModule = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const U = () => window._authUser || {};
  const myName = () => String(U().memberNombre || U().name || '').toLowerCase();
  const mine = t => (t.responsables || []).some(r => String(r).toLowerCase() === myName()) || String(t.responsable || '').toLowerCase() === myName();
  const isOpen = t => t.estado !== 'completado' && t.estado !== 'cancelado';
  const d10 = v => v ? String(v).split('T')[0] : '';
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ini = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const perm = k => { const u = U(); return u.isOwner || !u.permisos || (u.permisos[k] && u.permisos[k].n > 0); };
  const isAdminish = () => { const u = U(); return u.isOwner || ['admin', 'manager'].includes(u.memberRol); };
  const api = async (u, o) => { const r = await apiFetch(API + u, o); if (!r.ok) throw new Error('http ' + r.status); return r.json(); };
  const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  function ago(d) {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'ahora'; if (s < 3600) return Math.floor(s / 60) + ' min'; if (s < 86400) return Math.floor(s / 3600) + ' h'; if (s < 604800) return Math.floor(s / 86400) + ' d';
    return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  const money = (v, m) => (m || 'USD') + ' ' + Number(v || 0).toLocaleString('es-ES', { maximumFractionDigits: 0 });
  const card = (id, title, body, right) => { const el = $(id); if (!el) return; el.style.display = ''; el.innerHTML = `<div class="hm-hd"><b>${title}</b>${right || ''}</div>${body}`; };
  const empty = t => `<div class="hm-e">${t}</div>`;

  let _tab = 'todo', _d = null, _tasks = [], _poll = null, _msgs = { slack: 0, wa: 0, mail: 0 };

  // ── Para ti ──
  async function loadParaTi() {
    try { _d = await api('/home/para-ti'); } catch (_) { _d = _d || { respuestas: [], asignados: [], nuevos: [] }; }
    try {
      const wa = parseInt(($('wa-badge') || {}).textContent, 10) || 0, sl = parseInt(($('chat-badge') || {}).textContent, 10) || 0;
      let mail = 0; if (perm('outreach')) { try { const nc = await api('/lm/nav-counts'); mail = nc.inbox || 0; } catch (_) {} }
      _msgs = { slack: sl, wa, mail };
    } catch (_) {}
    paintParaTi();
  }
  const VERBO = { mencion: 'te mencionó en', respuesta: 'respondió en', nuevo: 'comentó en', asignado: 'te asignó un comentario en' };
  function item(x, kind) {
    const tipo = kind === 'asignado' ? 'asignado' : x.tipo, n = x.n > 1 ? `${x.n} comentarios nuevos en` : VERBO[tipo];
    const acts = kind === 'asignado'
      ? `<button class="hm-b2 hm-b2--ok" title="Marcar como resuelto" onclick="event.stopPropagation();HomeModule.resolve(${x.id})">Resolver</button>`
      : `<button class="hm-b2" title="Marcar como visto" onclick="event.stopPropagation();HomeModule.seen(${x.task_id || 0},${x.tipo === 'mencion' ? x.id : 0})">✓</button>`;
    return `<div class="hm-it hm-it--${tipo}" onclick="HomeModule.go(${x.task_id || 0},${x.tipo === 'mencion' ? x.id : 0})">
      <span class="hm-av hm-av--${tipo}">${kind === 'asignado' ? '⚑' : esc(ini(x.by))}</span>
      <div class="hm-bd"><div class="hm-t"><b>${esc(x.by || 'Alguien')}</b> ${n} <span class="hm-ref">${esc(x.titulo || 'una tarea')}</span></div>
        ${x.texto ? `<div class="hm-x">${esc(x.texto)}</div>` : ''}<div class="hm-m">${esc(x.project_nombre || '')}${x.project_nombre ? ' · ' : ''}${ago(x.at)}</div></div>
      <div class="hm-ac">${acts}</div></div>`;
  }
  function paintParaTi() {
    const d = _d || { respuestas: [], asignados: [], nuevos: [] }, nMsg = _msgs.slack + _msgs.wa + _msgs.mail;
    const cnt = { respuestas: d.respuestas.length, asignados: d.asignados.length, nuevos: d.nuevos.length, mensajes: nMsg };
    const total = cnt.respuestas + cnt.asignados + cnt.nuevos;
    const tabs = [['todo', 'Todo', total + (nMsg ? 0 : 0)], ['respuestas', 'Respuestas', cnt.respuestas], ['asignados', 'Asignados', cnt.asignados], ['nuevos', 'Nuevos', cnt.nuevos], ['mensajes', 'Mensajes', nMsg]];
    let list = '';
    const byDate = a => a.sort((p, q) => new Date(q.at) - new Date(p.at));
    if (_tab === 'todo') list = byDate([...d.asignados.map(x => ({ ...x, _k: 'asignado' })), ...d.respuestas.map(x => ({ ...x, _k: 'r' })), ...d.nuevos.map(x => ({ ...x, _k: 'n' }))]).map(x => item(x, x._k === 'asignado' ? 'asignado' : '')).join('');
    else if (_tab === 'respuestas') list = d.respuestas.map(x => item(x, '')).join('');
    else if (_tab === 'asignados') list = d.asignados.map(x => item(x, 'asignado')).join('');
    else if (_tab === 'nuevos') list = d.nuevos.map(x => item(x, '')).join('');
    const msgRows = `<div class="hm-msgs">${[['Slack', _msgs.slack, 'mgmt-chat', 'Chat con los clientes'], ['WhatsApp', _msgs.wa, 'mgmt-wa', 'Chats sin leer'], ['Respuestas de prospectos', _msgs.mail, 'outreach-inbox', 'Correo de Outreach']].filter(r => r[0] !== 'Respuestas de prospectos' || perm('outreach')).map(r => `<button class="hm-msg${r[1] ? ' hm-msg--on' : ''}" onclick="HomeModule.openMsg('${r[2]}')"><b>${r[1]}</b><span>${r[0]}<em>${r[3]}</em></span></button>`).join('')}</div>`;
    const body = _tab === 'mensajes' ? msgRows : (list || empty({ respuestas: 'No tienes respuestas pendientes', asignados: 'No tienes comentarios asignados', nuevos: 'No hay comentarios nuevos', todo: 'Estás al día ✨' }[_tab])) + (_tab === 'todo' && nMsg ? msgRows : '');
    card('dash2-paratii', 'Para ti' + (total ? `<span class="hm-n">${total}</span>` : ''), `<div class="hm-tabs">${tabs.map(([k, l, n]) => `<button class="hm-tab${_tab === k ? ' on' : ''}" onclick="HomeModule.tab('${k}')">${l}${n ? `<i>${n > 99 ? '99+' : n}</i>` : ''}</button>`).join('')}</div><div class="hm-list">${body}</div>`,
      total ? '<button class="hm-lnk" onclick="HomeModule.seenAll()">Marcar todo como visto</button>' : '');
  }
  function tab(k) { _tab = k; paintParaTi(); }
  async function go(taskId, mencionId) { if (taskId) { openTaskAnywhere(taskId); post('/home/seen', { task_id: taskId, mencion_id: mencionId || 0 }).then(loadParaTi).catch(() => {}); } }
  async function seen(taskId, mencionId) { try { await post('/home/seen', { task_id: taskId, mencion_id: mencionId || 0 }); } catch (_) {} loadParaTi(); }
  async function seenAll() { try { await post('/home/seen', { all: true }); showBanner('✓ Todo marcado como visto', 'success'); } catch (_) {} loadParaTi(); }
  async function resolve(id) { try { await post(`/home/assigned/${id}/resolve`, {}); showBanner('✓ Comentario resuelto', 'success'); } catch (_) { showBanner('No se pudo resolver', 'error'); } loadParaTi(); }
  function openMsg(k) {
    if (k === 'outreach-inbox') { try { selectModule('leadmanagement'); setTimeout(() => { try { LeadManagerModule.go('inbox'); } catch (_) {} }, 300); } catch (_) {} return; }
    document.querySelector(`.snav-item[data-tab="${k}"]`)?.click();
  }

  // ── Cobros ──
  async function loadCobros() {
    const el = $('dash2-cobros'); if (!el) return; el.style.display = 'none';
    if (!perm('finanzas')) return;
    try {
      const c = await api('/home/cobros'); if (c.oculto) return;
      if (!c.n_por_cobrar && !c.en_curso) { card('dash2-cobros', 'Cobros', empty('No tienes cobros pendientes')); return; }
      const px = c.proximo, f = px && (px.billing_week || px.deadline) ? new Date(d10(px.billing_week || px.deadline) + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : '';
      card('dash2-cobros', 'Cobros', `<div class="hm-kp"><div><b>${money(c.por_cobrar, c.moneda)}</b><span>Por cobrar · ${c.n_por_cobrar} tarea${c.n_por_cobrar === 1 ? '' : 's'} listas</span></div>${c.en_curso ? `<div><b>${money(c.en_curso, c.moneda)}</b><span>En curso</span></div>` : ''}</div>
        ${(c.lista || []).map(r => `<div class="hm-row" onclick="openTaskAnywhere(${r.id})"><span class="hm-row__t">${esc(r.titulo)}<em>${esc(r.project_nombre || '')}</em></span><b>${money(r.monto, r.moneda)}</b></div>`).join('')}
        ${px && !(c.lista || []).length ? `<div class="hm-row" onclick="openTaskAnywhere(${px.id})"><span class="hm-row__t">Próximo: ${esc(px.titulo)}<em>${esc(px.project_nombre || '')}${f ? ' · ' + f : ''}</em></span><b>${money(px.monto, px.moneda)}</b></div>` : ''}`);
    } catch (_) {}
  }

  // ── Bloqueos / próximos 7 días (desde las tareas ya cargadas) ──
  function paintBloq() {
    const T = _tasks.filter(isOpen), byId = new Map(_tasks.map(t => [t.id, t]));
    const bloqueadas = T.filter(t => t.estado === 'bloqueado' && mine(t));
    const blocking = new Map();                                   // tarea mía → tareas que esperan por ella
    T.forEach(t => (t.waiting_on || []).forEach(w => { const wt = byId.get(w.id); if (wt && isOpen(wt) && mine(wt)) { if (!blocking.has(wt.id)) blocking.set(wt.id, []); blocking.get(wt.id).push(t); } }));
    const row = (t, extra) => `<div class="hm-row" onclick="openTaskAnywhere(${t.id})"><span class="hm-row__t">${esc(t.titulo)}<em>${esc(t.project_nombre || '')}${extra ? ' · ' + extra : ''}</em></span></div>`;
    const nBl = bloqueadas.length + blocking.size;
    if (!nBl) { card('dash2-bloq', 'Bloqueos', empty('Nada bloqueado ni bloqueando a otros ✓')); return; }
    card('dash2-bloq', 'Bloqueos', `${bloqueadas.length ? `<div class="hm-sub">Bloqueadas (${bloqueadas.length})</div>${bloqueadas.slice(0, 5).map(t => row(t)).join('')}` : ''}
      ${blocking.size ? `<div class="hm-sub">Bloqueas a otras personas (${blocking.size})</div>${[...blocking.entries()].slice(0, 5).map(([id, ws]) => row(byId.get(id), `espera: ${ws.slice(0, 2).map(x => esc(x.titulo)).join(', ')}${ws.length > 2 ? '…' : ''}`)).join('')}` : ''}`,
      `<span class="hm-n hm-n--w">${nBl}</span>`);
  }
  function paintProx() {
    const today = ymd(new Date()), end = new Date(); end.setDate(end.getDate() + 7); const e7 = ymd(end);
    const T = _tasks.filter(t => isOpen(t) && mine(t) && !t.parent_task_id && d10(t.deadline) > today && d10(t.deadline) <= e7).sort((a, b) => d10(a.deadline).localeCompare(d10(b.deadline)));
    if (!T.length) { card('dash2-prox', 'Próximos 7 días', empty('No tienes fechas límite esta semana')); return; }
    const lbl = d => { const dt = new Date(d + 'T00:00:00'), t = new Date(); t.setDate(t.getDate() + 1); return ymd(t) === d ? 'Mañana' : dt.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' }); };
    let last = '', h = '';
    T.slice(0, 12).forEach(t => { const d = d10(t.deadline); if (d !== last) { last = d; h += `<div class="hm-sub">${lbl(d)}</div>`; } h += `<div class="hm-row" onclick="openTaskAnywhere(${t.id})"><span class="hm-row__t">${esc(t.titulo)}<em>${esc(t.project_nombre || '')}</em></span></div>`; });
    card('dash2-prox', 'Próximos 7 días', h, `<span class="hm-n">${T.length}</span>`);
  }

  // ── Agenda de hoy ──
  async function loadAgenda() {
    const today = ymd(new Date()); let ev = [];
    try { (await api('/mgmt/meetings')).filter(m => d10(m.fecha) === today && m.estado !== 'cancelada').forEach(m => ev.push({ t: String(m.hora_inicio || '').slice(0, 5), f: String(m.hora_fin || '').slice(0, 5), n: m.titulo || 'Reunión', link: m.link })); } catch (_) {}
    try {
      const st = await api('/gcal/status');
      if (st && st.connected) {
        const a = new Date(); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setDate(b.getDate() + 1);
        const g = await api(`/gcal/events?start=${encodeURIComponent(a.toISOString())}&end=${encodeURIComponent(b.toISOString())}`);
        (Array.isArray(g) ? g : (g.events || [])).forEach(x => { const s = x.start && (x.start.dateTime || x.start.date) || x.start || '', e = x.end && (x.end.dateTime || x.end.date) || x.end || ''; const tm = v => (String(v).length > 10 ? new Date(v).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''); const o = { t: tm(s), f: tm(e), n: x.summary || x.titulo || 'Evento', link: x.hangoutLink || x.htmlLink }; if (!ev.some(y => y.n === o.n && y.t === o.t)) ev.push(o); });
      }
    } catch (_) {}
    ev.sort((p, q) => (p.t || '99').localeCompare(q.t || '99'));
    card('dash2-agenda', 'Agenda de hoy', ev.length ? ev.map(e => `<div class="hm-row"><span class="hm-tm">${esc(e.t || 'Todo el día')}${e.f ? '<i>–' + esc(e.f) + '</i>' : ''}</span><span class="hm-row__t">${esc(e.n)}</span>${e.link ? `<a class="hm-b2" href="${esc(e.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Unirse</a>` : ''}</div>`).join('') : empty('Sin reuniones hoy'), ev.length ? `<span class="hm-n">${ev.length}</span>` : '');
  }

  // ── Outreach (solo con acceso) ──
  async function loadOutreach() {
    const el = $('dash2-outreach'); if (!el) return; el.style.display = 'none'; if (!perm('outreach')) return;
    try {
      const n = await api('/lm/nav-counts'); const rows = [['Respuestas de prospectos sin leer', n.inbox], ['Tareas y seguimientos de hoy', n.tasks], ['Por calificar (respondieron)', n.leads], ['Por aprobar / WhatsApp', n.wa]].filter(r => r[1]);
      card('dash2-outreach', 'Outreach', rows.length ? rows.map(r => `<div class="hm-row" onclick="HomeModule.openMsg('outreach-inbox')"><span class="hm-row__t">${r[0]}</span><b class="hm-cnt">${r[1]}</b></div>`).join('') : empty('Todo al día en Outreach ✓'));
    } catch (_) {}
  }

  // ── Equipo hoy (solo administradores y managers) ──
  async function loadTeam() {
    const el = $('dash2-team'); if (!el) return; el.style.display = 'none'; if (!isAdminish()) return;
    try {
      const a = new Date(); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setDate(b.getDate() + 1);
      const [team, hrs] = await Promise.all([api('/mgmt/team'), api(`/timer/team?start=${encodeURIComponent(a.toISOString())}&end=${encodeURIComponent(b.toISOString())}`).catch(() => [])]);
      const today = ymd(new Date()), hmap = new Map((hrs || []).map(h => [String(h.nombre || '').toLowerCase(), h.totalS || 0]));
      const rows = team.filter(m => (m.estado || 'activo') === 'activo').map(m => {
        const nm = String(m.nombre || '').toLowerCase(), mt = _tasks.filter(t => isOpen(t) && !t.parent_task_id && ((t.responsables || []).some(r => String(r).toLowerCase() === nm) || String(t.responsable || '').toLowerCase() === nm));
        return { n: m.nombre, abiertas: mt.length, venc: mt.filter(t => d10(t.deadline) && d10(t.deadline) < today).length, s: hmap.get(nm) || 0 };
      }).sort((p, q) => q.venc - p.venc || q.abiertas - p.abiertas);
      card('dash2-team', 'Equipo hoy', rows.map(r => `<div class="hm-row hm-row--p"><span class="hm-av hm-av--n">${esc(ini(r.n))}</span><span class="hm-row__t">${esc(r.n)}<em>${r.abiertas} abiertas${r.venc ? ` · <i class="hm-red">${r.venc} vencidas</i>` : ''}</em></span><span class="hm-hr${r.s ? '' : ' hm-hr--0'}">${r.s ? (r.s / 3600).toFixed(1).replace(/\.0$/, '') + ' h' : 'sin tiempo'}</span></div>`).join('') || empty('Sin personas en el equipo'));
    } catch (_) {}
  }

  // ── orquestación ──
  function render(allTasks) {
    _tasks = Array.isArray(allTasks) ? allTasks : _tasks;
    paintBloq(); paintProx();
    loadParaTi(); loadCobros(); loadAgenda(); loadOutreach(); loadTeam();
    clearInterval(_poll); _poll = setInterval(() => { const p = $('pane-mgmt-dashboard'); if (p && p.classList.contains('active') && !document.hidden) loadParaTi(); }, 60000);
  }
  return { render, tab, go, seen, seenAll, resolve, openMsg, refresh: loadParaTi };
})();
