'use strict';
// Time Tracking · Hojas de horas (estilo ClickUp): Mi hoja · Todas las hojas · Aprobaciones · Reporte · Ajustes (Cronograma de trabajo).
// Reutiliza lo que ya existe: TimerModule (agregar tiempo, editar sesión, borrar, aprobar, reporte) y /api/timer/entries.
const TimesheetModule = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'America/Lima';
  const U = () => window._authUser || {};
  const isAdmin = () => { const u = U(); return !!(u.isOwner || ['admin', 'manager'].includes(u.memberRol)); };
  const MES = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.'], DOW = ['Lun.', 'Mar.', 'Mié.', 'Jue.', 'Vie.', 'Sáb.', 'Dom.'];
  const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
  const limaDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
  const todayL = () => limaDay(Date.now());
  const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const monday = s => { const d = new Date(s + 'T12:00:00Z'); return addD(s, -((d.getUTCDay() + 6) % 7)); };
  const dowIdx = s => (new Date(s + 'T12:00:00Z').getUTCDay() + 6) % 7;   // 0 = lunes
  const dShort = s => { const d = new Date(s + 'T12:00:00Z'); return `${MES[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const dHead = s => { const d = new Date(s + 'T12:00:00Z'); return `${DOW[dowIdx(s)]}, ${cap1(MES[d.getUTCMonth()])} ${d.getUTCDate()}`; };
  const dLong = s => { const d = new Date(s + 'T12:00:00Z'); return `${DOW[dowIdx(s)].toLowerCase()}, ${MES[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const hm = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const fmtH = sec => { sec = Math.max(0, Math.round(sec || 0)); let h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); if (m === 60) { h++; m = 0; } return h && m ? `${h}h ${m}m` : h ? `${h}h` : m ? `${m}m` : '0h'; };
  const ini = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const ic = (d, sz) => `<svg width="${sz || 15}" height="${sz || 15}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const IC = {
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', alarm: '<circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 14 15"/><path d="M5 3L2 6M22 6l-3-3"/>',
    dollar: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>', tag: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    box: '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><line x1="10" y1="13" x2="14" y2="13"/>', up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    grid: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="10" x2="9" y2="21"/>', list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>', plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', left: '<polyline points="15 18 9 12 15 6"/>', right: '<polyline points="9 18 15 12 9 6"/>', down: '<polyline points="6 9 12 15 18 9"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-5-5.7"/>', check: '<polyline points="20 6 9 17 4 12"/>', x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>', copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  };
  const S = { tab: 'mi', view: 'hoja', week: monday(todayL()), hideWk: false, fFact: 'all', fTag: '', fTime: 'all', fArch: 'hide', fSort: 'new', member: null, memberId: null, fromTeam: false, settings: null, entries: [], rows: [], team: null, mine: null, foldDays: {}, memberFilter: 'all' };
  const api = async (u, o) => { const r = await apiFetch(API + u, o); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; };
  const send = (u, m, b) => api(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const err = e => showBanner(e.message || String(e), 'error');
  const dur = e => e.ended_at ? (e.duration_s || 0) : Math.max(e.duration_s || 0, Math.round((Date.now() - new Date(e.started_at)) / 1000));
  const countable = e => { const s = e.source || 'manual_timer'; return s !== 'browser_extension' && s !== 'desktop_agent'; };
  const billable = e => e.facturable != null ? !!e.facturable : (e.tipo_proyecto === 'horas' && +e.tarifa_hora > 0);
  const tasksAll = () => (typeof TasksModule !== 'undefined' && TasksModule._getTasks) ? TasksModule._getTasks() : [];

  // ── configuración / capacidad ──
  const cfg = () => S.settings || { dias_laborales: [1, 2, 3, 4, 5], hora_ini: '09:00', hora_fin: '17:00', no_laborales: [], aprob_activas: false, limite_dia: 5, limite_hora: '17:00', rec_antes_h: 24, rec_despues_h: 8 };
  const hoursPerDay = () => { const c = cfg(), a = c.hora_ini.split(':'), b = c.hora_fin.split(':'); return Math.max(0, ((+b[0] * 60 + +b[1]) - (+a[0] * 60 + +a[1])) / 60); };
  const capDay = d => { const c = cfg(); return c.dias_laborales.includes(dowIdx(d) + 1) && !(c.no_laborales || []).some(x => x.fecha === d) ? hoursPerDay() * 3600 : 0; };
  const weekDays = () => Array.from({ length: 7 }, (_, i) => addD(S.week, i));
  const visDays = () => weekDays().filter(d => !S.hideWk || dowIdx(d) < 5);
  const weekCap = () => weekDays().reduce((a, d) => a + capDay(d), 0);
  const weekLabel = () => `${dShort(S.week)} - ${dShort(addD(S.week, 6))}`;

  // ── ventanitas ──
  let _pop = null, _popOff = null;
  function popClose() { if (_pop) { _pop.remove(); _pop = null; } if (_popOff) { document.removeEventListener('mousedown', _popOff, true); _popOff = null; } }
  function popOpen(anchor, html, cls, alignRight) {
    popClose(); const p = document.createElement('div'); p.className = 'ts-pop ' + (cls || ''); p.innerHTML = html; document.body.appendChild(p); _pop = p;
    const r = anchor.getBoundingClientRect(); let left = alignRight ? r.right - p.offsetWidth : r.left; left = Math.max(8, Math.min(left, innerWidth - p.offsetWidth - 8));
    let top = r.bottom + 6; if (top + p.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - p.offsetHeight - 6);
    p.style.left = left + 'px'; p.style.top = top + 'px';
    _popOff = ev => { if (!p.contains(ev.target)) popClose(); }; setTimeout(() => document.addEventListener('mousedown', _popOff, true), 0); return p;
  }
  function modal(title, body, foot, wide) {
    $('ts-modal')?.remove(); const m = document.createElement('div'); m.id = 'ts-modal'; m.className = 'fin-pi-backdrop'; m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="fin-pi-box" style="max-width:${wide || 480}px"><div class="fin-pi-box__hd"><h3>${title}</h3><button class="fin-pi-x" onclick="document.getElementById('ts-modal').remove()">✕</button></div><div class="ts-mb">${body}</div>${foot ? `<div class="ts-mf">${foot}</div>` : ''}</div>`;
    document.body.appendChild(m); return m;
  }

  // ── esqueleto: pestañas + cuerpo ──
  function active() { return S.tab !== 'reporte' && !!$('pane-mgmt-timetracking')?.classList.contains('active'); }
  async function open() {
    if (!$('ts-root')) return;
    try { S.settings = await api('/timesheets/settings'); } catch (_) {}
    if (!isAdmin() && (S.tab === 'todas' || S.tab === 'aprob' || S.tab === 'ajustes')) S.tab = 'mi';
    paint();
  }
  function paint() {
    const root = $('ts-root'); if (!root) return;
    const adm = isAdmin(), tab = (k, l) => `<button type="button" class="ts-tab${S.tab === k || (k === 'mi' && S.tab === 'detalle') ? ' on' : ''}" onclick="TimesheetModule.go('${k}')">${l}</button>`;
    root.innerHTML = `<div class="ts-top"><span class="ts-ttl">${ic(IC.alarm, 17)}Hojas de horas</span><span class="ts-sep"></span>${tab('mi', 'Mi hoja de horas')}${adm ? tab('todas', 'Todas las hojas de horas') + tab('aprob', 'Aprobaciones') : ''}${tab('reporte', 'Reporte')}
      <span class="ts-sp"></span>${adm ? `<button type="button" class="ts-btn" onclick="TimesheetModule.go('ajustes')">${ic(IC.gear, 14)}Ajustes</button>` : ''}</div><div id="ts-body" class="ts-body"></div>`;
    const wrap = $('tt-report-wrap'); if (wrap) wrap.style.display = S.tab === 'reporte' ? '' : 'none';
    if (S.tab === 'reporte') { $('ts-body').innerHTML = ''; try { TimerModule.loadReport(); } catch (_) {} return; }
    paintBody();
  }
  function go(k) { popClose(); if (k === S.tab && k !== 'mi') return; if (k === 'mi') { S.member = null; S.memberId = null; S.fromTeam = false; } S.tab = k; paint(); }
  const refresh = () => { if (active()) paintBody(); };
  async function paintBody() {
    const b = $('ts-body'); if (!b) return;
    try {
      if (S.tab === 'mi' || S.tab === 'detalle') await bodyHoja();
      else if (S.tab === 'todas') await bodyTodas();
      else if (S.tab === 'aprob') await bodyAprob();
      else if (S.tab === 'ajustes') bodyAjustes();
    } catch (e) { b.innerHTML = `<div class="ts-empty"><b>No se pudo cargar</b><span>${esc(e.message)}</span></div>`; }
  }

  // ── navegación de semana ──
  const weekNav = (extra) => `<div class="ts-wk"><button type="button" class="ts-ib" onclick="TimesheetModule.nav(-1)">${ic(IC.left, 17)}</button><button type="button" class="ts-ib" onclick="TimesheetModule.nav(1)">${ic(IC.right, 17)}</button>
    <button type="button" class="ts-wk__l" onclick="TimesheetModule.weekMenu(event)">${weekLabel()}${ic(IC.down, 15)}</button>${extra || ''}</div>`;
  function nav(n) { S.week = addD(S.week, 7 * n); paintBody(); }
  function weekMenu(ev) {
    const cur = monday(todayL()), o = (l, w) => `<button type="button" class="ts-mi${S.week === w ? ' on' : ''}" onclick="TimesheetModule.setWeek('${w}')">${l}</button>`;
    popOpen(ev.currentTarget, `${o('Esta semana', cur)}${o('Semana pasada', addD(cur, -7))}<div class="ts-ms"></div><label class="ts-mi ts-mi--d">Elegir fecha<input type="date" onchange="TimesheetModule.setWeek(this.value)"></label>`);
  }
  function setWeek(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return; popClose(); S.week = monday(d); paintBody(); }

  // ── filtros ──
  function chip(kind, icon, label, on) { return `<button type="button" class="ts-chip${on ? ' on' : ''}" onclick="TimesheetModule.fMenu(event,'${kind}')">${ic(icon, 14)}${label}</button>`; }
  const hideSw = () => `<label class="ts-sw"><input type="checkbox" ${S.hideWk ? 'checked' : ''} onchange="TimesheetModule.setHideWk(this.checked)"><i></i>Ocultar fines de semana</label>`;
  function setHideWk(v) { S.hideWk = !!v; paintBody(); }
  function filterBar(opts) {
    opts = opts || {};
    return `<div class="ts-filters">${chip('fact', IC.dollar, 'Estado facturable', S.fFact !== 'all')}${chip('tag', IC.tag, 'Etiqueta', !!S.fTag)}${opts.time ? chip('time', IC.clock, 'Tiempo registrado', S.fTime !== 'all') : ''}${chip('arch', IC.box, 'Tareas archivadas', S.fArch !== 'hide')}${opts.sort ? chip('sort', IC.up, 'Fecha agregada', S.fSort !== 'new') : ''}
      <span class="ts-sp"></span>${hideSw()}${opts.right || ''}</div>`;
  }
  function fMenu(ev, kind) {
    const it = (cur, v, l) => `<button type="button" class="ts-mi${cur === v ? ' on' : ''}" onclick="TimesheetModule.fSet('${kind}','${String(v).replace(/'/g, '')}')"><span>${l}</span>${cur === v ? ic(IC.check, 14) : ''}</button>`;
    let h = '';
    if (kind === 'fact') h = it(S.fFact, 'all', 'Mostrar ambas') + it(S.fFact, 'yes', 'Mostrar solo los facturables') + it(S.fFact, 'no', 'Mostrar solo los no facturables');
    else if (kind === 'time') h = it(S.fTime, 'all', 'Todas las tareas') + it(S.fTime, 'con', 'Con tiempo registrado') + it(S.fTime, 'sin', 'Sin tiempo registrado');
    else if (kind === 'arch') h = it(S.fArch, 'hide', 'Ocultar archivadas') + it(S.fArch, 'show', 'Incluir archivadas') + it(S.fArch, 'only', 'Solo archivadas');
    else if (kind === 'sort') h = it(S.fSort, 'new', 'Más recientes primero') + it(S.fSort, 'old', 'Más antiguas primero');
    else if (kind === 'tag') { const tags = [...new Set((S.entries || []).flatMap(e => e.etiquetas || []))].sort(); h = it(S.fTag, '', 'Todas') + (tags.map(t => it(S.fTag, t, esc(t))).join('') || '<div class="ts-mn">Aún no hay etiquetas en esta semana.</div>'); }
    popOpen(ev.currentTarget, h);
  }
  function fSet(kind, v) { popClose(); ({ fact: () => S.fFact = v, time: () => S.fTime = v, arch: () => S.fArch = v, sort: () => S.fSort = v, tag: () => S.fTag = v })[kind](); paintBody(); }
  const passEntry = e => {
    if (S.fFact !== 'all' && billable(e) !== (S.fFact === 'yes')) return false;
    if (S.fTag && !(e.etiquetas || []).includes(S.fTag)) return false;
    if (S.fArch === 'hide' && e.task_archivada) return false;
    if (S.fArch === 'only' && !e.task_archivada) return false;
    return true;
  };

  // ── datos de entradas de la semana (propias o de un miembro) ──
  async function loadEntries() {
    const start = `${S.week}T00:00:00-05:00`, end = `${addD(S.week, 6)}T23:59:59.999-05:00`, mq = S.member ? `&member=${encodeURIComponent(S.member)}` : '';
    const list = await api(`/timer/entries?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${mq}`);
    S.entries = Array.isArray(list) ? list : []; try { TimerModule.setEntries(S.entries); } catch (_) {}
    return S.entries;
  }
  const pinKey = () => 'ts_pins_' + S.week;
  const pins = () => { if (S.member) return []; try { return JSON.parse(localStorage.getItem(pinKey()) || '[]'); } catch (_) { return []; } };
  const setPins = a => { try { localStorage.setItem(pinKey(), JSON.stringify([...new Set(a)].slice(0, 80))); } catch (_) {} };
  function buildRows(entries) {
    const rows = new Map();
    const add = (key, b) => { if (!rows.has(key)) rows.set(key, { key, taskId: b.taskId || null, titulo: b.titulo, ctx: b.ctx || '', days: {}, total: 0, entries: [], created: b.created || '', archivada: !!b.archivada }); return rows.get(key); };
    entries.filter(e => countable(e) && passEntry(e)).forEach(e => {
      const r = add(e.task_id ? 't' + e.task_id : 'x' + (e.task_titulo || ''), { taskId: e.task_id, titulo: e.task_titulo || 'Sin tarea seleccionada', ctx: [e.proj_nombre || e.project_nombre, e.client_nombre].filter(Boolean).join(' · '), created: e.creada_at, archivada: e.task_archivada });
      const d = limaDay(e.started_at), s = dur(e); r.days[d] = (r.days[d] || 0) + s; r.total += s; r.entries.push(e); if (e.creada_at && (!r.created || e.creada_at < r.created)) r.created = e.creada_at;
    });
    const all = tasksAll();
    pins().forEach(id => { const key = 't' + id; if (rows.has(key)) return; const t = all.find(x => x.id === id); if (!t) return; if (S.fArch === 'hide' && t.archivada) return; if (S.fArch === 'only' && !t.archivada) return; add(key, { taskId: id, titulo: t.titulo, ctx: t.project_nombre || '', created: '9999', archivada: t.archivada }); });
    let list = [...rows.values()];
    if (S.fTime === 'con') list = list.filter(r => r.total > 0); if (S.fTime === 'sin') list = list.filter(r => r.total === 0);
    list.sort((a, b) => S.fSort === 'old' ? String(a.created).localeCompare(String(b.created)) : String(b.created).localeCompare(String(a.created)));
    return list;
  }

  // ── Mi hoja / detalle de un miembro ──
  const viewSwitch = () => `<div class="ts-seg"><button type="button" class="${S.view === 'hoja' ? 'on' : ''}" onclick="TimesheetModule.setView('hoja')">${ic(IC.grid, 15)}Hoja de horas</button><button type="button" class="${S.view === 'entradas' ? 'on' : ''}" onclick="TimesheetModule.setView('entradas')">${ic(IC.list, 15)}Entradas de tiempo</button></div>`;
  function setView(v) { S.view = v; paintBody(); }
  async function bodyHoja() {
    const b = $('ts-body'); b.innerHTML = '<div class="ts-loading">Cargando…</div>';
    await loadEntries();
    if (!S.member) { try { S.mine = await api('/timesheets/mine?week_start=' + S.week); } catch (_) { S.mine = null; } } else S.mine = null;
    const adm = isAdmin();
    let head = '';
    if (S.member) head = `<div class="ts-who"><button type="button" class="ts-ib" onclick="TimesheetModule.go('todas')" title="Volver">${ic(IC.back, 18)}</button><span class="ts-av">${esc(ini(S.member))}</span><b>${esc(S.member)}</b><span class="ts-sp"></span><span class="ts-tz">${ic('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 14)}Zona horaria: -05 (UTC-5)</span></div>`;
    const sub = submissionBar();
    const bar = `${head}<div class="ts-row1">${weekNav()}${sub}</div>`;
    const wrapRight = `<span class="ts-viewsw">${viewSwitch()}</span>`;
    b.innerHTML = `${bar}${filterBar({ time: S.view === 'hoja', sort: S.view === 'hoja', right: wrapRight })}<div id="ts-grid"></div>`;
    S.view === 'hoja' ? drawHoja() : drawEntradas();
  }
  function submissionBar() {
    const c = cfg(); if (!c.aprob_activas) return '';
    const lim = `${DIAS[c.limite_dia - 1]} ${hm('2000-01-01T' + c.limite_hora + ':00-05:00')}`;
    if (S.member) { // un admin revisando a otra persona
      const p = S.team && (S.team.personas || []).find(x => x.nombre === S.member); const st = p ? p.estado : 'pendiente', uid = p ? p.user_id : S.memberId;
      return `<div class="ts-sub"><span class="ts-st ts-st--${st}">${stLabel(st)}</span>${uid ? reviewBtns(uid, st) : ''}</div>`;
    }
    const st = S.mine ? S.mine.estado : 'pendiente';
    return `<div class="ts-sub"><span class="ts-dl">Fecha límite: ${lim}</span><span class="ts-st ts-st--${st}">${stLabel(st)}</span>${st === 'aprobada' || st === 'enviada' ? '' : `<button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.submit()">Enviar hoja de horas</button>`}</div>`;
  }
  const stLabel = s => ({ pendiente: 'Sin enviar', enviada: 'Enviada', aprobada: 'Aprobada', rechazada: 'Rechazada' })[s] || s;
  const reviewBtns = (uid, st) => st === 'aprobada' ? `<button type="button" class="ts-btn" onclick="TimesheetModule.review(${uid},'reabrir')">Reabrir</button>`
    : `<button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.review(${uid},'aprobar')">Aprobar</button>${st === 'rechazada' ? '' : `<button type="button" class="ts-btn" onclick="TimesheetModule.review(${uid},'rechazar')">Rechazar</button>`}`;
  async function submit() { try { await send('/timesheets/submit', 'POST', { week_start: S.week }); showBanner('✓ Hoja enviada para aprobación', 'success'); paintBody(); } catch (e) { err(e); } }
  async function review(uid, accion) {
    let nota = ''; if (accion === 'rechazar') { nota = prompt('Motivo del rechazo (opcional):', '') || ''; }
    try { const j = await send('/timesheets/review', 'POST', { user_id: uid, week_start: S.week, accion, nota }); showBanner(accion === 'aprobar' ? `✓ Hoja aprobada (${j.entradas} entradas bloqueadas)` : accion === 'reabrir' ? 'Hoja reabierta' : 'Hoja rechazada', 'success'); paintBody(); } catch (e) { err(e); }
  }

  function drawHoja() {
    const g = $('ts-grid'); if (!g) return; const days = visDays(), rows = buildRows(S.entries), today = todayL(); S.rows = rows;
    const dayTot = {}; rows.forEach(r => Object.entries(r.days).forEach(([d, s]) => { dayTot[d] = (dayTot[d] || 0) + s; }));
    const grand = rows.reduce((a, r) => a + r.total, 0), cols = `grid-template-columns:minmax(250px,1.8fr) repeat(${days.length},minmax(92px,1fr)) 128px`;
    const th = days.map(d => { const cp = capDay(d), t = dayTot[d] || 0, pc = cp > 0 ? Math.min(100, t / cp * 100) : (t > 0 ? 100 : 0); return `<div class="tsh-d${d === today ? ' is-today' : ''}${cp === 0 ? ' is-off' : ''}"><span>${dHead(d)}</span><b>${fmtH(t)}</b><i class="tsh-bar"><u class="${t >= cp && cp > 0 ? 'ok' : ''}" style="width:${pc}%"></u></i></div>`; }).join('');
    const body = rows.map(r => `<div class="tsh-r" style="${cols}"><div class="tsh-t"><div class="tsh-t__n"><a href="javascript:void(0)" ${r.taskId ? `onclick="openTaskAnywhere(${r.taskId})"` : ''}>${esc(r.titulo)}</a>${r.archivada ? '<em>archivada</em>' : ''}</div><small>${esc(r.ctx)}</small></div>`
      + days.map(d => { const s = r.days[d] || 0; return `<button type="button" class="tsh-c${s ? ' has' : ''}${capDay(d) === 0 ? ' is-off' : ''}" onclick="TimesheetModule.cell(event,'${r.key}','${d}')">${s ? fmtH(s) : '<i>+</i>'}</button>`; }).join('')
      + `<div class="tsh-tot">${r.total ? fmtH(r.total) : '—'}${r.taskId && !S.member ? `<button type="button" class="tsh-play" title="Iniciar cronómetro" onclick="TimerModule.toggleTask(${r.taskId})">${ic(IC.play, 12)}</button>` : ''}</div></div>`).join('');
    const empty = !rows.length ? emptyCards() : '';
    g.innerHTML = `<div class="tsh"><div class="tsh-h" style="${cols}"><div class="tsh-h0">Tarea / Ubicación</div>${th}<div class="tsh-d tsh-d--t"><span>Total</span><b>${fmtH(grand)}</b><i class="tsh-bar"><u class="${weekCap() && grand >= weekCap() ? 'ok' : ''}" style="width:${weekCap() ? Math.min(100, grand / weekCap() * 100) : 0}%"></u></i></div></div>${body}${empty}</div>
      <div class="ts-foot"><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.addTask(event)">${ic(IC.plus, 15)}Agregar tarea</button><span class="ts-capn">Capacidad semanal: ${fmtH(weekCap())}</span></div>`;
  }
  function emptyCards() {
    const c = (k, i, l) => `<button type="button" class="ts-ec" onclick="TimesheetModule.empty('${k}',event)">${ic(i, 20)}<span>${l}</span></button>`;
    return `<div class="ts-empty ts-empty--in"><div class="ts-empty__i">${ic(IC.alarm, 38)}</div><b>Añade entradas a la hoja de horas de esta semana</b><div class="ts-ecs">${S.member ? '' : c('asig', IC.users, 'Todas las tareas asignadas') + c('prev', IC.copy, 'Tareas de la semana pasada')}${c('uno', IC.plus, 'Tareas individuales')}${c('reg', IC.clock, 'Registrar el tiempo')}</div></div>`;
  }
  async function empty(k, ev) {
    if (k === 'reg') return manual();
    if (k === 'uno') return addTask(ev);
    if (k === 'asig') {
      const me = String(U().memberNombre || U().name || '').toLowerCase(), mine = t => (t.responsables || []).some(r => String(r).toLowerCase() === me) || String(t.responsable || '').toLowerCase() === me;
      const ids = tasksAll().filter(t => mine(t) && !t.archivada && t.estado !== 'completado' && t.estado !== 'cancelado' && !t.parent_task_id).slice(0, 40).map(t => t.id);
      if (!ids.length) { showBanner('No tienes tareas abiertas asignadas', 'info'); return; } setPins([...pins(), ...ids]); drawHoja(); return;
    }
    if (k === 'prev') {
      try { const s0 = addD(S.week, -7), l = await api(`/timer/entries?start=${encodeURIComponent(s0 + 'T00:00:00-05:00')}&end=${encodeURIComponent(addD(s0, 6) + 'T23:59:59.999-05:00')}`);
        const ids = [...new Set((l || []).filter(e => e.task_id).map(e => e.task_id))]; if (!ids.length) { showBanner('La semana pasada no tiene tareas con tiempo', 'info'); return; } setPins([...pins(), ...ids]); drawHoja(); } catch (e) { err(e); }
    }
  }
  function manual(pre) { popClose(); try { TimerModule.openManual(pre || { fecha: weekDays().includes(todayL()) ? todayL() : S.week }); } catch (e) { err(e); } }
  function addTask(ev) {
    const anchor = ev && ev.currentTarget || $('ts-grid');
    const p = popOpen(anchor, `<input class="ts-pq" id="ts-pq" placeholder="Buscar tarea…" autocomplete="off" oninput="TimesheetModule.pickSearch(this.value)"><div class="ts-pl" id="ts-pl"></div>`, 'ts-pop--w');
    pickSearch(''); setTimeout(() => $('ts-pq')?.focus(), 20); return p;
  }
  function pickSearch(q) {
    const box = $('ts-pl'); if (!box) return; const n = String(q || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let l = tasksAll().filter(t => !t.archivada && t.estado !== 'cancelado'); if (n) l = l.filter(t => nrm(t.titulo).includes(n) || nrm(t.project_nombre).includes(n)); else l = l.filter(t => t.estado !== 'completado');
    l = l.slice(0, 12); window.__tsPick = l.map(t => t.id);
    box.innerHTML = l.map((t, i) => `<button type="button" class="ts-pi" onclick="TimesheetModule.pick(${i})"><span>${esc(t.titulo)}</span><em>${esc(t.project_nombre || '')}</em></button>`).join('') || '<div class="ts-mn">Sin resultados</div>';
  }
  function pick(i) {
    const id = (window.__tsPick || [])[i]; if (!id) return; const t = tasksAll().find(x => x.id === id); popClose(); if (!t) return;
    if (!S.member) setPins([...pins(), id]);
    manual({ fecha: weekDays().includes(todayL()) ? todayL() : S.week, taskId: id, titulo: t.titulo, ctx: t.project_nombre || '' });
  }
  function cell(ev, key, day) {
    const r = S.rows.find(x => x.key === key); if (!r) return; const es = r.entries.filter(e => limaDay(e.started_at) === day).sort((a, z) => new Date(a.started_at) - new Date(z.started_at)), adm = isAdmin();
    const list = es.map(e => `<div class="ts-ce"><div class="ts-ce__t"><b>${hm(e.started_at)}${e.ended_at ? ' – ' + hm(e.ended_at) : ' · en curso'}</b><span>${fmtH(dur(e))}</span></div>${e.notes ? `<small>${esc(e.notes)}</small>` : ''}
      <div class="ts-ce__a">${e.approved ? `<span class="ts-lk" title="Aprobada">${ic(IC.lock, 13)}Aprobada</span>` : ''}<button type="button" onclick="TimesheetModule.edit(${e.id})">Editar</button>${(!e.approved || adm) ? `<button type="button" class="is-del" onclick="TimesheetModule.del(${e.id})">Eliminar</button>` : ''}</div></div>`).join('');
    popOpen(ev.currentTarget, `<div class="ts-cp"><div class="ts-cp__h"><b>${esc(r.titulo)}</b><span>${dLong(day)} · ${fmtH(r.days[day] || 0)}</span></div>${list || '<div class="ts-mn">Sin entradas este día.</div>'}<button type="button" class="ts-btn ts-btn--p ts-cp__add" onclick="TimesheetModule.addAt('${key}','${day}')">${ic(IC.plus, 14)}Agregar tiempo</button></div>`, 'ts-pop--w');
  }
  function addAt(key, day) { const r = S.rows.find(x => x.key === key); if (!r) return; manual({ fecha: day > todayL() ? todayL() : day, taskId: r.taskId, titulo: r.titulo, ctx: r.ctx }); }
  function edit(id) { popClose(); try { TimerModule.openEntryEdit(id); } catch (e) { err(e); } }
  function del(id) { popClose(); TimerModule.deleteEntry(id); }

  // ── Entradas de tiempo ──
  function drawEntradas() {
    const g = $('ts-grid'); if (!g) return; const today = todayL(), vis = new Set(visDays());
    const es = S.entries.filter(e => countable(e) && passEntry(e) && vis.has(limaDay(e.started_at))).sort((a, z) => new Date(z.started_at) - new Date(a.started_at));
    const by = {}; es.forEach(e => { (by[limaDay(e.started_at)] = by[limaDay(e.started_at)] || []).push(e); });
    const days = Object.keys(by).sort().reverse(), adm = isAdmin();
    const group = d => { const list = by[d], tot = list.reduce((a, e) => a + dur(e), 0), cp = capDay(d), open = !S.foldDays[d], pc = cp > 0 ? Math.min(100, tot / cp * 100) : (tot > 0 ? 100 : 0);
      const rows = list.map(e => { const lock = e.approved && !adm, tags = (e.etiquetas || []);
        return `<div class="tse-r${e.approved ? ' is-ap' : ''}"><div class="tse-t">${ic(IC.alarm, 15)}<a href="javascript:void(0)" ${e.task_id ? `onclick="openTaskAnywhere(${e.task_id})"` : ''}>${esc(e.task_titulo || 'Sin tarea seleccionada')}</a></div>
          <div class="tse-n">${lock ? `<span>${esc(e.notes) || '–'}</span>` : `<input value="${esc(e.notes || '')}" placeholder="–" maxlength="1000" onchange="TimesheetModule.meta(${e.id},{notes:this.value})">`}</div>
          <div class="tse-f"><button type="button" class="tse-fb${billable(e) ? ' on' : ''}" ${lock ? 'disabled' : ''} title="${billable(e) ? 'Facturable' : 'No facturable'}" onclick="TimesheetModule.meta(${e.id},{facturable:${!billable(e)}})">${ic(IC.dollar, 14)}</button></div>
          <div class="tse-g">${tags.map(t => `<span class="ts-tg">${esc(t)}</span>`).join('')}<button type="button" class="tse-tb" ${lock ? 'disabled' : ''} title="Etiquetas" onclick="TimesheetModule.tagMenu(event,${e.id})">${ic(IC.tag, 14)}</button></div>
          <div class="tse-h">${hm(e.started_at)}</div><div class="tse-h tse-h--m">–</div><div class="tse-h">${e.ended_at ? hm(e.ended_at) : '<em>en curso</em>'}</div><div class="tse-d">${fmtH(dur(e))}</div>
          <div class="tse-m"><button type="button" class="ts-ib" onclick="TimesheetModule.rowMenu(event,${e.id})">${ic(IC.dots, 16)}</button></div></div>`; }).join('');
      return `<div class="tse-g0"><div class="tse-gh"><button type="button" class="ts-fold${open ? ' is-open' : ''}" onclick="TimesheetModule.fold('${d}')"><i></i>${dLong(d)}${d === today ? ' <em>hoy</em>' : ''}</button><span class="ts-sp"></span><div class="tse-gs"><b>${fmtH(tot)}${cp ? ` <span>/ ${fmtH(cp)}</span>` : ''}</b><i class="tsh-bar"><u class="${cp && tot >= cp ? 'ok' : 'bad'}" style="width:${pc}%"></u></i></div></div>
        ${open ? `<div class="tse"><div class="tse-r tse-r--h"><div>Tarea</div><div>Descripción</div><div>Facturable</div><div>Etiquetas</div><div>Hora de inicio</div><div></div><div>Hora de finalización</div><div>Tiempo registrado</div><div></div></div>${rows}</div>` : ''}</div>`; };
    g.innerHTML = (days.length ? days.map(group).join('') : `<div class="ts-empty"><div class="ts-empty__i">${ic(IC.alarm, 38)}</div><b>Sin entradas de tiempo esta semana</b><span>Registra tiempo con el cronómetro o agrégalo a mano.</span></div>`)
      + `<div class="ts-foot"><button type="button" class="ts-btn" onclick="TimesheetModule.manual()">${ic(IC.plus, 15)}Agregar entrada</button></div>`;
  }
  function fold(d) { S.foldDays[d] = !S.foldDays[d]; drawEntradas(); }
  async function meta(id, patch) {
    const e = S.entries.find(x => x.id === id); if (!e) return;
    try { const j = await send(`/timer/${id}/meta`, 'PATCH', patch); Object.assign(e, { notes: j.notes, facturable: j.facturable, etiquetas: j.etiquetas }); drawEntradas(); } catch (er) { err(er); drawEntradas(); }
  }
  function tagMenu(ev, id) {
    const e = S.entries.find(x => x.id === id); if (!e) return; const tags = e.etiquetas || [];
    const known = [...new Set(S.entries.flatMap(x => x.etiquetas || []))].filter(t => !tags.includes(t)).slice(0, 8);
    popOpen(ev.currentTarget, `<div class="ts-tp"><div class="ts-tp__c">${tags.map(t => `<span class="ts-tg">${esc(t)}<button type="button" onclick="TimesheetModule.tagDel(${id},'${esc(t).replace(/'/g, '')}')">×</button></span>`).join('') || '<em>Sin etiquetas</em>'}</div>
      <input class="ts-pq" id="ts-tq" maxlength="30" placeholder="Nueva etiqueta y Enter" onkeydown="if(event.key==='Enter'){event.preventDefault();TimesheetModule.tagAdd(${id},this.value)}">${known.length ? `<div class="ts-tp__k">${known.map(t => `<button type="button" onclick="TimesheetModule.tagAdd(${id},'${esc(t).replace(/'/g, '')}')">${esc(t)}</button>`).join('')}</div>` : ''}</div>`);
    setTimeout(() => $('ts-tq')?.focus(), 20);
  }
  function tagAdd(id, v) { v = String(v || '').trim(); const e = S.entries.find(x => x.id === id); if (!e || !v) return; popClose(); meta(id, { etiquetas: [...(e.etiquetas || []), v] }); }
  function tagDel(id, v) { const e = S.entries.find(x => x.id === id); if (!e) return; popClose(); meta(id, { etiquetas: (e.etiquetas || []).filter(t => t !== v) }); }
  function rowMenu(ev, id) {
    const e = S.entries.find(x => x.id === id); if (!e) return; const adm = isAdmin();
    popOpen(ev.currentTarget, `<button type="button" class="ts-mi" onclick="TimesheetModule.edit(${id})">Editar entrada</button>${adm && countable(e) ? `<button type="button" class="ts-mi" onclick="TimesheetModule.approve(${id},${!e.approved})">${e.approved ? 'Reabrir (quitar aprobación)' : 'Aprobar entrada'}</button>` : ''}${(!e.approved || adm) ? `<button type="button" class="ts-mi ts-mi--del" onclick="TimesheetModule.del(${id})">Eliminar</button>` : ''}`, '', true);
  }
  function approve(id, v) { popClose(); TimerModule.approveEntry(id, v); }

  // ── Todas las hojas de horas (equipo) ──
  async function bodyTodas() {
    const b = $('ts-body'); b.innerHTML = '<div class="ts-loading">Cargando…</div>';
    S.team = await api('/timesheets/team?week_start=' + S.week);
    drawTodas();
  }
  function drawTodas() {
    const b = $('ts-body'), t = S.team; if (!b || !t) return; const days = visDays(), today = todayL();
    let ps = t.personas || []; if (S.memberFilter !== 'all') ps = ps.filter(p => String(p.user_id) === String(S.memberFilter));
    const cols = `grid-template-columns:minmax(300px,1.8fr) repeat(${days.length},minmax(84px,1fr)) 96px`;
    const sel = (t.personas || []).find(p => String(p.user_id) === String(S.memberFilter));
    const memberBtn = `<button type="button" class="ts-btn ts-btn--sel" onclick="TimesheetModule.memberMenu(event)">${sel ? esc(sel.nombre) : 'Todos los miembros'}${ic(IC.down, 14)}</button>`;
    const rows = ps.map(p => `<div class="tsh-r tsh-r--p" style="${cols}"><div class="tsh-p"><span class="ts-av">${esc(ini(p.nombre))}</span><div><b>${esc(p.nombre)}</b><small>${fmtH(p.capacidad_s)}</small></div><span class="ts-st ts-st--${p.estado}">${p.estado === 'pendiente' ? '' : stLabel(p.estado)}</span><button type="button" class="ts-btn ts-btn--open" onclick="TimesheetModule.openMember(${p.user_id})">Abrir ${ic(IC.right, 13)}</button></div>`
      + days.map(d => `<div class="tsh-pc${capDay(d) === 0 ? ' is-off' : ''}${d === today ? ' is-today' : ''}">${fmtH(p.dias[d] || 0)}</div>`).join('') + `<div class="tsh-pc tsh-pc--t">${fmtH(p.total)}</div></div>`).join('');
    b.innerHTML = `<div class="ts-row1">${weekNav()}<span class="ts-sp"></span>${memberBtn}</div>${filterBar({ right: '' })}
      <div class="tsh"><div class="tsh-h" style="${cols}"><div class="tsh-h0">Personas (${ps.length})</div>${days.map(d => `<div class="tsh-d${d === today ? ' is-today' : ''}"><span>${dHead(d)}</span></div>`).join('')}<div class="tsh-d tsh-d--t"><span>Total</span></div></div>${rows || '<div class="ts-empty ts-empty--in"><b>Sin personas</b></div>'}</div>`;
  }
  function memberMenu(ev) { const ps = (S.team && S.team.personas) || [], it = (v, l) => `<button type="button" class="ts-mi${String(S.memberFilter) === String(v) ? ' on' : ''}" onclick="TimesheetModule.setMember('${v}')">${esc(l)}</button>`; popOpen(ev.currentTarget, it('all', 'Todos los miembros') + ps.map(p => it(p.user_id, p.nombre)).join(''), '', true); }
  function setMember(v) { popClose(); S.memberFilter = v; drawTodas(); }
  function openMember(uid) { const p = (S.team.personas || []).find(x => x.user_id === uid); if (!p) return; S.member = p.nombre; S.memberId = uid; S.fromTeam = true; S.tab = 'detalle'; paint(); }

  // ── Aprobaciones ──
  async function bodyAprob() {
    const b = $('ts-body'), c = cfg();
    if (!c.aprob_activas) { b.innerHTML = `<div class="ts-aph"><h2>Aprobaciones de hojas de horas</h2></div><div class="ts-empty"><div class="ts-empty__i">${ic(IC.check, 38)}</div><b>Aprueba las hojas de horas de tu equipo</b><span>Cada persona envía su semana y tú la apruebas o la devuelves. Al aprobarla, sus entradas quedan bloqueadas.</span><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.deadlineModal()">Configurar aprobaciones</button></div>`; return; }
    b.innerHTML = '<div class="ts-loading">Cargando…</div>'; S.team = await api('/timesheets/team?week_start=' + S.week);
    const lim = `${DIAS[c.limite_dia - 1]} ${hm('2000-01-01T' + c.limite_hora + ':00-05:00')}`, ps = S.team.personas || [];
    const rows = ps.map(p => `<div class="tsa-r"><div class="tsa-n"><span class="ts-av">${esc(ini(p.nombre))}</span><div><b>${esc(p.nombre)}</b><span class="ts-st ts-st--${p.estado}">${stLabel(p.estado)}</span></div></div><div>${fmtH(p.total)}</div><div>${fmtH(p.capacidad_s)}</div><div>${fmtH(p.facturable)}</div><div class="${p.excede_s ? 'is-bad' : ''}">${p.excede_s ? fmtH(p.excede_s) : '—'}</div><div class="tsa-a">${reviewBtns(p.user_id, p.estado)}<button type="button" class="ts-btn" onclick="TimesheetModule.openMember(${p.user_id})">Abrir</button></div></div>`).join('');
    b.innerHTML = `<div class="ts-aph"><h2>Aprobaciones de hojas de horas</h2><span class="ts-sp"></span><span class="ts-dl">Fecha límite: ${lim} · Recordatorio ${c.rec_antes_h ? c.rec_antes_h + ' h antes' : 'desactivado'}</span><button type="button" class="ts-btn" onclick="TimesheetModule.deadlineModal()">${ic(IC.clock, 14)}Fecha límite y recordatorios</button></div>
      <div class="ts-row1">${weekNav()}</div><div class="tsa"><div class="tsa-r tsa-r--h"><div>Detalles</div><div>Registrado</div><div>Capacidad</div><div>Facturable</div><div>Excede la capacidad</div><div>Revisión</div></div>${rows}</div>`;
  }
  function deadlineModal() {
    const c = cfg(), opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${l}</option>`;
    const horas = Array.from({ length: 24 }, (_, h) => { const v = String(h).padStart(2, '0') + ':00'; return opt(v, hm('2000-01-01T' + v + ':00-05:00'), c.limite_hora); }).join('');
    const antes = [[0, 'Nunca'], [1, '1 h antes'], [2, '2 h antes'], [6, '6 h antes'], [12, '12 h antes'], [24, '24 h antes'], [48, '48 h antes']].map(([v, l]) => opt(v, l, c.rec_antes_h)).join('');
    const desp = [[0, 'Nunca'], [1, '1 h después'], [2, '2 h después'], [4, '4 h después'], [8, '8 h después'], [12, '12 h después'], [24, '24 h después']].map(([v, l]) => opt(v, l, c.rec_despues_h)).join('');
    modal('Establecer fecha límite y recordatorios para la hoja de horas', `<div class="ts-fs"><b>Plazos de entrega de la hoja de horas</b>
      <label class="ts-fl"><span>${ic(IC.cal, 15)}Fecha límite</span><select id="ts-ld">${DIAS.map((d, i) => opt(i + 1, d, c.limite_dia)).join('')}</select></label>
      <label class="ts-fl"><span>${ic(IC.clock, 15)}Hora límite</span><select id="ts-lh">${horas}</select></label></div>
      <div class="ts-fs"><b>Envía recordatorios</b>
      <label class="ts-fl"><span>${ic(IC.alarm, 15)}Recordar antes de la fecha límite</span><select id="ts-ra">${antes}</select></label>
      <label class="ts-fl"><span>${ic(IC.alarm, 15)}Recordar después de la fecha límite</span><select id="ts-rd">${desp}</select></label></div>`,
      `<button type="button" class="ts-btn" onclick="document.getElementById('ts-modal').remove()">Cancelar</button><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.saveDeadline()">Continuar</button>`, 520);
  }
  async function saveDeadline() {
    const g = id => $(id).value; try { S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), { aprob_activas: true, limite_dia: +g('ts-ld'), limite_hora: g('ts-lh'), rec_antes_h: +g('ts-ra'), rec_despues_h: +g('ts-rd') }))); $('ts-modal')?.remove(); showBanner('✓ Aprobaciones configuradas', 'success'); paintBody(); } catch (e) { err(e); }
  }

  // ── Ajustes · Cronograma de trabajo ──
  function bodyAjustes() {
    const b = $('ts-body'), c = cfg(), cap = hoursPerDay(), lunDom = [1, 2, 3, 4, 5, 6, 7], ab = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];
    const libres = (c.no_laborales || []).slice().sort((a, z) => a.fecha.localeCompare(z.fecha));
    b.innerHTML = `<div class="ts-set"><div class="ts-set__hd"><button type="button" class="ts-ib" onclick="TimesheetModule.go('mi')" title="Volver">${ic(IC.back, 18)}</button><h2>Cronograma de trabajo</h2></div>
      <p class="ts-set__p">Define el horario de trabajo de tu equipo para calcular la capacidad de las hojas de horas y anticipar el impacto de los días libres.</p>
      <h3>Días laborables</h3><div class="ts-card"><span>Elige qué días trabaja tu equipo</span><div class="ts-days">${lunDom.map((d, i) => `<button type="button" class="ts-dchip${c.dias_laborales.includes(d) ? ' on' : ''}" onclick="TimesheetModule.toggleDia(${d})">${ab[i]}</button>`).join('')}</div></div>
      <h3>Horas de trabajo</h3><div class="ts-card ts-card--col"><div class="ts-crow"><b>Horario</b><span>La misma hora todos los días</span></div><div class="ts-crow"><div><b>Horas diarias</b><small>Capacidad diaria: ${fmtH(cap * 3600)} • Capacidad semanal: ${fmtH(cap * 3600 * c.dias_laborales.length)}</small></div><div class="ts-hrs"><input type="time" id="ts-hi" value="${c.hora_ini}" onchange="TimesheetModule.saveHoras()"><span>a</span><input type="time" id="ts-hf" value="${c.hora_fin}" onchange="TimesheetModule.saveHoras()"></div></div></div>
      <h3>Días no laborables</h3><div class="ts-card ts-card--col">${libres.length ? libres.map(x => `<div class="ts-crow"><div><b>${esc(x.nombre || 'Día libre')}</b><small>${dLong(x.fecha)} ${x.fecha.slice(0, 4)}</small></div><button type="button" class="ts-ib" title="Quitar" onclick="TimesheetModule.delLibre('${x.fecha}')">${ic(IC.x, 15)}</button></div>`).join('') : `<div class="ts-empty ts-empty--in"><div class="ts-empty__i">${ic(IC.cal, 34)}</div><b>Personaliza el horario de trabajo de tu equipo</b><span>Agrega días no laborables o excepciones para alinear la capacidad con la disponibilidad real.</span></div>`}<div class="ts-crow ts-crow--f"><button type="button" class="ts-btn" onclick="TimesheetModule.libreModal()">${ic(IC.plus, 14)}Añadir días libres</button></div></div></div>`;
  }
  async function saveCfg(patch) { try { S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), patch))); bodyAjustes(); } catch (e) { err(e); bodyAjustes(); } }
  function toggleDia(d) { const cur = cfg().dias_laborales.slice(), i = cur.indexOf(d); if (i >= 0) { if (cur.length === 1) { showBanner('Debe haber al menos un día laborable', 'info'); return; } cur.splice(i, 1); } else cur.push(d); saveCfg({ dias_laborales: cur }); }
  function saveHoras() { saveCfg({ hora_ini: $('ts-hi').value, hora_fin: $('ts-hf').value }); }
  function delLibre(f) { saveCfg({ no_laborales: (cfg().no_laborales || []).filter(x => x.fecha !== f) }); }
  function libreModal() {
    modal('Añadir días libres', `<label class="ts-fl ts-fl--c"><span>Nombre</span><input type="text" id="ts-ln" maxlength="60" placeholder="Ej. Feriado, vacaciones del equipo"></label><label class="ts-fl ts-fl--c"><span>Desde</span><input type="date" id="ts-l1"></label><label class="ts-fl ts-fl--c"><span>Hasta (opcional)</span><input type="date" id="ts-l2"></label>`,
      `<button type="button" class="ts-btn" onclick="document.getElementById('ts-modal').remove()">Cancelar</button><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.saveLibre()">Añadir</button>`, 440);
  }
  function saveLibre() {
    const a = $('ts-l1').value, z = $('ts-l2').value || a, nombre = $('ts-ln').value.trim(); if (!a) { showBanner('Elige la fecha', 'info'); return; } if (z < a) { showBanner('La fecha final debe ser posterior', 'info'); return; }
    const out = (cfg().no_laborales || []).slice(); for (let d = a, n = 0; d <= z && n < 60; d = addD(d, 1), n++) if (!out.some(x => x.fecha === d)) out.push({ fecha: d, nombre });
    $('ts-modal')?.remove(); saveCfg({ no_laborales: out });
  }

  return { open, active, handlesRefresh: active, refresh, go, nav, weekMenu, setWeek, fMenu, fSet, setHideWk, setView, cell, addAt, edit, del, addTask, pickSearch, pick, empty, manual, fold, meta, tagMenu, tagAdd, tagDel, rowMenu, approve,
    submit, review, memberMenu, setMember, openMember, deadlineModal, saveDeadline, toggleDia, saveHoras, delLibre, libreModal, saveLibre };
})();
