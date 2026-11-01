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
    spaces: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>', plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', left: '<polyline points="15 18 9 12 15 6"/>', right: '<polyline points="9 18 15 12 9 6"/>', down: '<polyline points="6 9 12 15 18 9"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-5-5.7"/>', check: '<polyline points="20 6 9 17 4 12"/>', x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>', copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  };
  const S = { tab: 'mi', view: 'hoja', week: monday(todayL()), range: null, fCli: '', fProj: '', fSpace: '', meta: null, hideWk: false, fFact: 'all', fTag: '', fTime: 'all', fArch: 'hide', fSort: 'new', member: null, memberId: null, fromTeam: false, settings: null, entries: [], rows: [], team: null, mine: null, foldDays: {}, memberFilter: 'all' };
  try { const pf = JSON.parse(localStorage.getItem('ts_prefs') || '{}'); if (pf.view) S.view = pf.view; if (pf.hideWk) S.hideWk = true; if (pf.tab) S.tab = pf.tab; } catch (_) {}
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
  // Periodo visible: una semana (por defecto) o un rango libre (15 días, 30 días, mes, personalizado)
  const rStart = () => S.range ? S.range.start : S.week;
  const rEnd = () => S.range ? S.range.end : addD(S.week, 6);
  const nDays = (a, z) => Math.round((new Date(z + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1;
  const weekDays = () => { const out = []; for (let d = rStart(), n = 0; d <= rEnd() && n < 125; d = addD(d, 1), n++) out.push(d); return out; };
  const visDays = () => weekDays().filter(d => !S.hideWk || dowIdx(d) < 5);
  const weekCap = () => weekDays().reduce((a, d) => a + capDay(d), 0);
  const weekLabel = () => { const a = rStart(), z = rEnd(); return S.range && a.slice(0, 4) !== z.slice(0, 4) ? `${dShort(a)} ${a.slice(0, 4)} - ${dShort(z)} ${z.slice(0, 4)}` : `${dShort(a)} - ${dShort(z)}`; };
  const teamUrl = () => S.range ? `/timesheets/team?week_start=${rStart()}&to=${rEnd()}` : '/timesheets/team?week_start=' + S.week;
  const monthRange = d => { const y = d.getUTCFullYear(), m = d.getUTCMonth(); return { kind: 'mes', start: new Date(Date.UTC(y, m, 1, 12)).toISOString().slice(0, 10), end: new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10) }; };

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
  function active() { return S.tab !== 'informe' && !!$('pane-mgmt-timetracking')?.classList.contains('active'); }
  async function open() {
    if (!$('ts-root')) return;
    try { S.settings = await api('/timesheets/settings'); } catch (_) {}
    await loadMeta();
    if (!isAdmin() && (S.tab === 'todas' || S.tab === 'aprob' || S.tab === 'ajustes')) S.tab = 'mi';
    paint();
  }
  function paint() {
    const root = $('ts-root'); if (!root) return;
    const adm = isAdmin(), tab = (k, l) => `<button type="button" class="ts-tab${S.tab === k || (k === 'mi' && S.tab === 'detalle') || (k === 'dash' && S.tab === 'informe') ? ' on' : ''}" onclick="TimesheetModule.go('${k}')">${l}</button>`;
    root.innerHTML = `<div class="ts-top"><span class="ts-ttl">${ic(IC.alarm, 17)}Hojas de horas</span><span class="ts-sep"></span>${tab('mi', 'Mi hoja de horas')}${adm ? tab('todas', 'Todas las hojas de horas') + tab('aprob', 'Aprobaciones') : ''}${tab('dash', 'Dashboard')}
      <span class="ts-sp"></span>${adm ? `<button type="button" class="ts-btn" onclick="TimesheetModule.go('ajustes')">${ic(IC.gear, 14)}Ajustes</button>` : ''}</div><div id="ts-body" class="ts-body"></div>`;
    const wrap = $('tt-report-wrap'); if (wrap) wrap.style.display = S.tab === 'informe' ? '' : 'none';
    if (S.tab === 'informe') { $('ts-body').innerHTML = `<div class="ts-back"><button type="button" class="ts-btn" onclick="TimesheetModule.go('dash')">${ic(IC.back, 14)}Volver al dashboard</button><span>Informe detallado: facturación, revisión de tiempo e impresión</span></div>`; try { TimerModule.loadReport(); } catch (_) {} return; }
    paintBody();
  }
  function go(k, sec) { popClose(); if (k === 'ajustes' && sec) S.setSec = sec; if (k === S.tab && k !== 'mi' && !(k === 'ajustes' && sec)) return; if (k === 'mi') { S.member = null; S.memberId = null; S.fromTeam = false; } S.tab = k; paint(); }
  const refresh = () => { if (active()) paintBody(); };
  async function paintBody() {
    const b = $('ts-body'); if (!b) return;
    try {
      if (S.tab === 'mi' || S.tab === 'detalle') await bodyHoja();
      else if (S.tab === 'todas') await bodyTodas();
      else if (S.tab === 'aprob') await bodyAprob();
      else if (S.tab === 'dash') await bodyDash();
      else if (S.tab === 'ajustes') bodyAjustes();
    } catch (e) { b.innerHTML = `<div class="ts-empty"><b>No se pudo cargar</b><span>${esc(e.message)}</span></div>`; }
  }

  // ── navegación de semana ──
  const weekNav = (extra, weekOnly) => `<div class="ts-wk"><button type="button" class="ts-ib" onclick="TimesheetModule.nav(-1)">${ic(IC.left, 17)}</button><button type="button" class="ts-ib" onclick="TimesheetModule.nav(1)">${ic(IC.right, 17)}</button>
    <button type="button" class="ts-wk__l" onclick="TimesheetModule.weekMenu(event${weekOnly ? ',true' : ''})">${weekLabel()}${ic(IC.down, 15)}</button>${extra || ''}</div>`;
  function nav(n) {
    if (!S.range) S.week = addD(S.week, 7 * n);
    else if (S.range.kind === 'mes') { const d = new Date(S.range.start + 'T12:00:00Z'); S.range = monthRange(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12))); }
    else { const len = nDays(S.range.start, S.range.end); S.range = { kind: S.range.kind, start: addD(S.range.start, len * n), end: addD(S.range.end, len * n) }; }
    paintBody();
  }
  function weekMenu(ev, weekOnly) {
    const cur = monday(todayL()), t = todayL(), k = x => S.range && S.range.kind === x, w = x => !S.range && S.week === x;
    const o = (l, on, fn) => `<button type="button" class="ts-mi${on ? ' on' : ''}" onclick="${fn}"><span>${l}</span>${on ? ic(IC.check, 14) : ''}</button>`;
    const rng = weekOnly ? '' : o('Últimos 15 días', k('15d'), "TimesheetModule.setRange('15d')") + o('Últimos 30 días', k('30d'), "TimesheetModule.setRange('30d')") + o('Este mes', k('mes') && S.range.start === monthRange(new Date(t + 'T12:00:00Z')).start, "TimesheetModule.setRange('mes')") + o('Mes pasado', false, "TimesheetModule.setRange('mesp')")
      + `<div class="ts-ms"></div><div class="ts-rg"><b>Rango personalizado</b><div class="ts-rg__r"><label>Desde<input type="date" id="ts-rg1" value="${rStart()}"></label><label>Hasta<input type="date" id="ts-rg2" value="${rEnd()}"></label></div><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.applyRange()">Aplicar</button></div>`;
    popOpen(ev.currentTarget, `${o('Esta semana', w(cur), `TimesheetModule.setWeek('${cur}')`)}${o('Semana pasada', w(addD(cur, -7)), `TimesheetModule.setWeek('${addD(cur, -7)}')`)}${rng}<div class="ts-ms"></div><label class="ts-mi ts-mi--d">Ir a la semana de…<input type="date" onchange="TimesheetModule.setWeek(this.value)"></label>`, 'ts-pop--w');
  }
  function setWeek(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return; popClose(); S.range = null; S.week = monday(d); paintBody(); }
  function setRange(kind) {
    popClose(); const t = todayL();
    if (kind === '15d') S.range = { kind, start: addD(t, -14), end: t };
    else if (kind === '30d') S.range = { kind, start: addD(t, -29), end: t };
    else if (kind === 'mes') S.range = monthRange(new Date(t + 'T12:00:00Z'));
    else { const d = new Date(t + 'T12:00:00Z'); S.range = monthRange(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 12))); }
    paintBody();
  }
  function applyRange() {
    const a = $('ts-rg1') && $('ts-rg1').value, z = $('ts-rg2') && $('ts-rg2').value;
    if (!a || !z) { showBanner('Elige las dos fechas', 'info'); return; } if (z < a) { showBanner('La fecha final debe ser posterior a la inicial', 'info'); return; } if (nDays(a, z) > 92) { showBanner('El rango máximo es de 92 días', 'info'); return; }
    popClose(); S.range = { kind: 'custom', start: a, end: z }; paintBody();
  }

  // ── cliente / proyecto / espacio de trabajo de cada entrada ──
  async function loadMeta() {
    if (S.meta) return S.meta;
    try { const [pr, sp] = await Promise.all([api('/mgmt/projects'), api('/mgmt/spaces')]); S.meta = { proj: new Map((Array.isArray(pr) ? pr : []).map(p => [p.id, p])), spaces: new Map([[0, 'Principal'], ...(Array.isArray(sp) ? sp : []).map(x => [x.id, x.nombre])]) }; }
    catch (_) { S.meta = { proj: new Map(), spaces: new Map([[0, 'Principal']]) }; }
    return S.meta;
  }
  const spaceOf = e => { const p = S.meta && e.project_id != null ? S.meta.proj.get(e.project_id) : null; return p ? (p.space_id || 0) : null; };
  const cliOf = e => e.client_nombre || 'Sin cliente';
  const projOfE = e => e.proj_nombre || e.project_nombre || 'Sin proyecto';
  const okF = (e, skip) => (skip === 'cli' || !S.fCli || cliOf(e) === S.fCli) && (skip === 'proj' || !S.fProj || projOfE(e) === S.fProj) && (skip === 'space' || S.fSpace === '' || String(spaceOf(e)) === S.fSpace);
  const anyF = () => !!(S.fCli || S.fProj || S.fSpace || S.fTag || S.fFact !== 'all' || S.fArch !== 'hide' || S.fTime !== 'all');
  const spaceName = v => (S.meta && S.meta.spaces.get(+v)) || ('Espacio ' + v);

  // ── filtros ──
  function chip(kind, icon, label, on) { return `<button type="button" class="ts-chip${on ? ' on' : ''}" onclick="TimesheetModule.fMenu(event,'${kind}')">${ic(icon, 14)}${label}</button>`; }
  const hideSw = () => `<label class="ts-sw"><input type="checkbox" ${S.hideWk ? 'checked' : ''} onchange="TimesheetModule.setHideWk(this.checked)"><i></i>Ocultar fines de semana</label>`;
  function setHideWk(v) { S.hideWk = !!v; paintBody(); }
  const fl = (base, v) => v ? `${base}: ${esc(String(v).length > 22 ? String(v).slice(0, 21) + '…' : v)}` : base;
  function filterBar(opts) {
    opts = opts || {};
    return `<div class="ts-filters">${chip('fact', IC.dollar, 'Estado facturable', S.fFact !== 'all')}${chip('cli', IC.users, fl('Cliente', S.fCli), !!S.fCli)}${chip('proj', IC.list, fl('Proyecto', S.fProj), !!S.fProj)}${chip('space', IC.spaces, fl('Espacio', S.fSpace !== '' ? spaceName(S.fSpace) : ''), S.fSpace !== '')}${chip('tag', IC.tag, 'Etiqueta', !!S.fTag)}${opts.time ? chip('time', IC.clock, 'Tiempo registrado', S.fTime !== 'all') : ''}${chip('arch', IC.box, 'Tareas archivadas', S.fArch !== 'hide')}${opts.sort ? chip('sort', IC.up, 'Fecha agregada', S.fSort !== 'new') : ''}
      ${anyF() ? `<button type="button" class="ts-clear" onclick="TimesheetModule.clearF()">Limpiar filtros</button>` : ''}<span class="ts-sp"></span>${hideSw()}${opts.right || ''}</div>`;
  }
  function fMenu(ev, kind) {
    const it = (cur, v, l) => `<button type="button" class="ts-mi${cur === v ? ' on' : ''}" onclick="TimesheetModule.fSet('${kind}','${String(v).replace(/'/g, '')}')"><span>${l}</span>${cur === v ? ic(IC.check, 14) : ''}</button>`;
    let h = '';
    if (kind === 'fact') h = it(S.fFact, 'all', 'Mostrar ambas') + it(S.fFact, 'yes', 'Mostrar solo los facturables') + it(S.fFact, 'no', 'Mostrar solo los no facturables');
    else if (kind === 'time') h = it(S.fTime, 'all', 'Todas las tareas') + it(S.fTime, 'con', 'Con tiempo registrado') + it(S.fTime, 'sin', 'Sin tiempo registrado');
    else if (kind === 'arch') h = it(S.fArch, 'hide', 'Ocultar archivadas') + it(S.fArch, 'show', 'Incluir archivadas') + it(S.fArch, 'only', 'Solo archivadas');
    else if (kind === 'sort') h = it(S.fSort, 'new', 'Más recientes primero') + it(S.fSort, 'old', 'Más antiguas primero');
    else if (kind === 'tag') { const tags = [...new Set((S.entries || []).flatMap(e => e.etiquetas || []))].sort(); h = it(S.fTag, '', 'Todas') + (tags.map(t => it(S.fTag, t, esc(t))).join('') || '<div class="ts-mn">Aún no hay etiquetas en esta semana.</div>'); }
    else if (kind === 'cli' || kind === 'proj' || kind === 'space') {
      const base = (S.entries || []).filter(e => countable(e) && okF(e, kind)), m = S.meta || { spaces: new Map([[0, 'Principal']]) };
      const vals = kind === 'cli' ? [...new Set(base.map(cliOf))].sort().map(x => ({ v: x, l: x })) : kind === 'proj' ? [...new Set(base.map(projOfE))].sort().map(x => ({ v: x, l: x })) : [...new Set(base.map(spaceOf).filter(x => x != null))].map(id => ({ v: String(id), l: m.spaces.get(id) || 'Espacio ' + id }));
      const cur = kind === 'cli' ? S.fCli : kind === 'proj' ? S.fProj : S.fSpace; window.__tsO = vals;
      const row = (i, l, on) => `<button type="button" class="ts-mi${on ? ' on' : ''}" onclick="TimesheetModule.fPick('${kind}',${i})"><span>${l}</span>${on ? ic(IC.check, 14) : ''}</button>`;
      h = `<div class="ts-ml">${row(-1, kind === 'cli' ? 'Todos los clientes' : kind === 'proj' ? 'Todos los proyectos' : 'Todos los espacios', cur === '')}${vals.map((o, i) => row(i, esc(o.l), cur === o.v)).join('') || '<div class="ts-mn">Sin datos en este periodo.</div>'}</div>`;
    }
    popOpen(ev.currentTarget, h);
  }
  function fPick(kind, i) { popClose(); const v = i < 0 ? '' : ((window.__tsO || [])[i] || {}).v || ''; if (kind === 'cli') { S.fCli = v; S.fProj = ''; } else if (kind === 'proj') S.fProj = v; else { S.fSpace = v; S.fCli = ''; S.fProj = ''; } paintBody(); }
  function clearF() { S.fCli = ''; S.fProj = ''; S.fSpace = ''; S.fTag = ''; S.fFact = 'all'; S.fArch = 'hide'; S.fTime = 'all'; paintBody(); }
  function fSet(kind, v) { popClose(); ({ fact: () => S.fFact = v, time: () => S.fTime = v, arch: () => S.fArch = v, sort: () => S.fSort = v, tag: () => S.fTag = v })[kind](); paintBody(); }
  const passEntry = e => {
    if (S.fFact !== 'all' && billable(e) !== (S.fFact === 'yes')) return false;
    if (S.fTag && !(e.etiquetas || []).includes(S.fTag)) return false;
    if (S.fArch === 'hide' && e.task_archivada) return false;
    if (S.fArch === 'only' && !e.task_archivada) return false;
    if (!okF(e)) return false;
    return true;
  };

  // ── datos de entradas de la semana (propias o de un miembro) ──
  async function loadEntries(allMembers) {
    const start = `${rStart()}T00:00:00-05:00`, end = `${rEnd()}T23:59:59.999-05:00`, mq = allMembers ? '&member=all' : (S.member ? `&member=${encodeURIComponent(S.member)}` : '');
    const list = await api(`/timer/entries?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${mq}`);
    S.entries = Array.isArray(list) ? list : []; try { TimerModule.setEntries(S.entries); } catch (_) {}
    return S.entries;
  }
  const pinKey = () => 'ts_pins_' + (S.range ? S.range.start + '_' + S.range.end : S.week);
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
    if (!S.member && !S.range) { try { S.mine = await api('/timesheets/mine?week_start=' + S.week); } catch (_) { S.mine = null; } } else S.mine = null;
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
    const c = cfg(); if (!c.aprob_activas || S.range) return '';   // el envío y la aprobación son por semana
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
    const grand = rows.reduce((a, r) => a + r.total, 0), cols = days.length > 9 ? `grid-template-columns:260px repeat(${days.length},84px) 128px` : `grid-template-columns:minmax(250px,1.8fr) repeat(${days.length},minmax(92px,1fr)) 128px`;
    const th = days.map(d => { const cp = capDay(d), t = dayTot[d] || 0, pc = cp > 0 ? Math.min(100, t / cp * 100) : (t > 0 ? 100 : 0); return `<div class="tsh-d${d === today ? ' is-today' : ''}${cp === 0 ? ' is-off' : ''}"><span>${dHead(d)}</span><b>${fmtH(t)}</b><i class="tsh-bar"><u class="${t >= cp && cp > 0 ? 'ok' : ''}" style="width:${pc}%"></u></i></div>`; }).join('');
    const body = rows.map(r => `<div class="tsh-r" style="${cols}"><div class="tsh-t"><div class="tsh-t__n"><a href="javascript:void(0)" ${r.taskId ? `onclick="openTaskAnywhere(${r.taskId})"` : ''}>${esc(r.titulo)}</a>${r.archivada ? '<em>archivada</em>' : ''}</div><small>${esc(r.ctx)}</small></div>`
      + days.map(d => { const s = r.days[d] || 0; return `<button type="button" class="tsh-c${s ? ' has' : ''}${capDay(d) === 0 ? ' is-off' : ''}" onclick="TimesheetModule.cell(event,'${r.key}','${d}')">${s ? fmtH(s) : '<i>+</i>'}</button>`; }).join('')
      + `<div class="tsh-tot">${r.total ? fmtH(r.total) : '—'}${r.taskId && !S.member ? `<button type="button" class="tsh-play" title="Iniciar cronómetro" onclick="TimerModule.toggleTask(${r.taskId})">${ic(IC.play, 12)}</button>` : ''}</div></div>`).join('');
    const empty = !rows.length ? emptyCards() : '';
    g.innerHTML = `<div class="tsh"><div class="tsh-h" style="${cols}"><div class="tsh-h0">Tarea / Ubicación</div>${th}<div class="tsh-d tsh-d--t"><span>Total</span><b>${fmtH(grand)}</b><i class="tsh-bar"><u class="${weekCap() && grand >= weekCap() ? 'ok' : ''}" style="width:${weekCap() ? Math.min(100, grand / weekCap() * 100) : 0}%"></u></i></div></div>${body}${empty}</div>
      <div class="ts-foot"><button type="button" class="ts-btn ts-btn--p" onclick="TimesheetModule.addTask(event)">${ic(IC.plus, 15)}Agregar tarea</button><span class="ts-capn">Capacidad ${S.range ? 'del periodo' : 'semanal'}: ${fmtH(weekCap())}</span></div>`;
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
      try { const len = weekDays().length, s0 = addD(rStart(), -len), l = await api(`/timer/entries?start=${encodeURIComponent(s0 + 'T00:00:00-05:00')}&end=${encodeURIComponent(addD(s0, len - 1) + 'T23:59:59.999-05:00')}`);
        const ids = [...new Set((l || []).filter(e => e.task_id).map(e => e.task_id))]; if (!ids.length) { showBanner('El periodo anterior no tiene tareas con tiempo', 'info'); return; } setPins([...pins(), ...ids]); drawHoja(); } catch (e) { err(e); }
    }
  }
  function manual(pre) { popClose(); try { TimerModule.openManual(pre || { fecha: weekDays().includes(todayL()) ? todayL() : rStart() }); } catch (e) { err(e); } }
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
    manual({ fecha: weekDays().includes(todayL()) ? todayL() : rStart(), taskId: id, titulo: t.titulo, ctx: t.project_nombre || '' });
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
    const [team] = await Promise.all([api(teamUrl()), loadEntries(true)]); S.team = team;
    drawTodas();
  }
  function drawTodas() {
    const b = $('ts-body'), t = S.team; if (!b || !t) return; const days = visDays(), today = todayL();
    let ps = t.personas || []; if (S.memberFilter !== 'all') ps = ps.filter(p => String(p.user_id) === String(S.memberFilter));
    const agg = {}; (S.entries || []).filter(e => countable(e) && passEntry(e)).forEach(e => { const a = agg[e.user_id] = agg[e.user_id] || { dias: {}, total: 0 }, d = limaDay(e.started_at), x = dur(e); a.dias[d] = (a.dias[d] || 0) + x; a.total += x; });
    const cols = days.length > 9 ? `grid-template-columns:300px repeat(${days.length},84px) 96px` : `grid-template-columns:minmax(300px,1.8fr) repeat(${days.length},minmax(84px,1fr)) 96px`;
    const sel = (t.personas || []).find(p => String(p.user_id) === String(S.memberFilter));
    const memberBtn = `<button type="button" class="ts-btn ts-btn--sel" onclick="TimesheetModule.memberMenu(event)">${sel ? esc(sel.nombre) : 'Todos los miembros'}${ic(IC.down, 14)}</button>`;
    const rows = ps.map(p => `<div class="tsh-r tsh-r--p" style="${cols}"><div class="tsh-p"><span class="ts-av">${esc(ini(p.nombre))}</span><div><b>${esc(p.nombre)}</b><small>${fmtH(p.capacidad_s)}</small></div><span class="ts-st ts-st--${p.estado}">${p.estado === 'pendiente' ? '' : stLabel(p.estado)}</span><button type="button" class="ts-btn ts-btn--open" onclick="TimesheetModule.openMember(${p.user_id})">Abrir ${ic(IC.right, 13)}</button></div>`
      + days.map(d => `<div class="tsh-pc${capDay(d) === 0 ? ' is-off' : ''}${d === today ? ' is-today' : ''}">${fmtH(((agg[p.user_id] || {}).dias || {})[d] || 0)}</div>`).join('') + `<div class="tsh-pc tsh-pc--t">${fmtH((agg[p.user_id] || {}).total || 0)}</div></div>`).join('');
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
    if (S.range) { S.week = monday(rEnd()); S.range = null; }   // las aprobaciones son por semana
    b.innerHTML = '<div class="ts-loading">Cargando…</div>'; S.team = await api('/timesheets/team?week_start=' + S.week);
    const lim = `${DIAS[c.limite_dia - 1]} ${hm('2000-01-01T' + c.limite_hora + ':00-05:00')}`, ps = S.team.personas || [];
    const rows = ps.map(p => `<div class="tsa-r"><div class="tsa-n"><span class="ts-av">${esc(ini(p.nombre))}</span><div><b>${esc(p.nombre)}</b><span class="ts-st ts-st--${p.estado}">${stLabel(p.estado)}</span></div></div><div>${fmtH(p.total)}</div><div>${fmtH(p.capacidad_s)}</div><div>${fmtH(p.facturable)}</div><div class="${p.excede_s ? 'is-bad' : ''}">${p.excede_s ? fmtH(p.excede_s) : '—'}</div><div class="tsa-a">${reviewBtns(p.user_id, p.estado)}<button type="button" class="ts-btn" onclick="TimesheetModule.openMember(${p.user_id})">Abrir</button></div></div>`).join('');
    b.innerHTML = `<div class="ts-aph"><h2>Aprobaciones de hojas de horas</h2><span class="ts-sp"></span><span class="ts-dl">Fecha límite: ${lim} · Recordatorio ${c.rec_antes_h ? c.rec_antes_h + ' h antes' : 'desactivado'}</span><button type="button" class="ts-btn" onclick="TimesheetModule.deadlineModal()">${ic(IC.clock, 14)}Fecha límite y recordatorios</button></div>
      <div class="ts-row1">${weekNav('', true)}</div><div class="tsa"><div class="tsa-r tsa-r--h"><div>Detalles</div><div>Registrado</div><div>Capacidad</div><div>Facturable</div><div>Excede la capacidad</div><div>Revisión</div></div>${rows}</div>`;
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

  // ── Ajustes · Cronograma de trabajo: ver más abajo (menú lateral) ──
  async function saveCfg(patch) { try { S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), patch))); drawSec(); } catch (e) { err(e); drawSec(); } }
  function toggleDia(d) { const cur = cfg().dias_laborales.slice(), i = cur.indexOf(d); if (i >= 0) { if (cur.length === 1) { showBanner('Debe haber al menos un día laborable', 'info'); return; } cur.splice(i, 1); } else cur.push(d); saveCfg({ dias_laborales: cur }); }
  // las horas se guardan sin repintar la página (si no, el campo pierde el foco a mitad de escribir) y con una pequeña espera
  let _hT = null;
  function saveHoras() {
    clearTimeout(_hT);
    _hT = setTimeout(async () => {
      const hi = $('ts-hi') && $('ts-hi').value, hf = $('ts-hf') && $('ts-hf').value; if (!hi || !hf) return;
      try {
        S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), { hora_ini: hi, hora_fin: hf })));
        const h = hoursPerDay(), sm = document.querySelector('.ts-crow small'); if (sm) sm.textContent = `Capacidad diaria: ${fmtH(h * 3600)} • Capacidad semanal: ${fmtH(h * 3600 * cfg().dias_laborales.length)}`;
        showBanner('✓ Horario guardado', 'success');
      } catch (e) { err(e); bodyAjustes(); }
    }, 600);
  }
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

  // ═════════ Dashboard (gráficas) ═════════
  const PAL = ['#00804C', '#4C7DF0', '#F2A93B', '#8B5CF6', '#E5484D', '#17A6B7', '#D6409F', '#8B9690'];
  const MESL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const D = { period: 'week', anchor: todayL(), member: 'me', project: 'all', client: '', space: '', from: addD(todayL(), -29), to: todayL() };
  let _charts = [];
  const killCharts = () => { _charts.forEach(c => { try { c.destroy(); } catch (_) {} }); _charts = []; };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1;
  function dashRange() {
    const a = D.anchor;
    if (D.period === 'week') { const s = monday(a), e = addD(s, 6); return { start: s, end: e, label: `${dShort(s)} - ${dShort(e)}` }; }
    if (D.period === 'month') { const d = new Date(a + 'T12:00:00Z'), y = d.getUTCFullYear(), m = d.getUTCMonth(); return { start: new Date(Date.UTC(y, m, 1, 12)).toISOString().slice(0, 10), end: new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10), label: `${cap1(MESL[m])} ${y}` }; }
    if (D.period === 'custom') { let a = D.from || addD(todayL(), -29), z = D.to || todayL(); if (a > z) [a, z] = [z, a]; if (daysBetween(a, z) > 120) a = addD(z, -119); return { start: a, end: z, label: `${dShort(a)}${a.slice(0, 4) !== z.slice(0, 4) ? ' ' + a.slice(0, 4) : ''} - ${dShort(z)} ${z.slice(0, 4)}` }; }
    const e = todayL(), n = D.period === '15d' ? 15 : 30; return { start: addD(e, -(n - 1)), end: e, label: `Últimos ${n} días` };
  }
  const prevRange = r => { const n = daysBetween(r.start, r.end); return { start: addD(r.start, -n), end: addD(r.start, -1) }; };
  function dashNav(n) {
    if (D.period === 'week') D.anchor = addD(D.anchor, 7 * n);
    else if (D.period === 'month') { const d = new Date(D.anchor + 'T12:00:00Z'); D.anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 15, 12)).toISOString().slice(0, 10); }
    else return;
    bodyDash();
  }
  function dashSet(k, v) { D[k] = v; if (k === 'period') D.anchor = todayL(); (k === 'member' || k === 'period' || k === 'from' || k === 'to') ? bodyDash() : drawDash(); }
  async function bodyDash() {
    const b = $('ts-body'); killCharts(); b.innerHTML = '<div class="ts-loading">Cargando…</div>'; await loadMeta();
    const r = dashRange(), p = prevRange(r), t0 = p.start < addD(r.end, -55) ? p.start : addD(r.end, -55), mq = D.member === 'me' ? '' : `&member=${encodeURIComponent(D.member)}`;
    const [ents, team] = await Promise.all([api(`/timer/entries?start=${encodeURIComponent(t0 + 'T00:00:00-05:00')}&end=${encodeURIComponent(r.end + 'T23:59:59.999-05:00')}${mq}`), isAdmin() ? api('/timesheets/team?week_start=' + monday(todayL())).catch(() => null) : Promise.resolve(null)]);
    S.dashEntries = Array.isArray(ents) ? ents : []; S.dashTeam = team; drawDash();
  }
  function heatGrid(list) {
    const g = Array.from({ length: 7 }, () => Array(24).fill(0)), OFF = -5 * 3600e3;
    list.forEach(e => { let t = new Date(e.started_at).getTime() + OFF; const t1 = (e.ended_at ? new Date(e.ended_at).getTime() : Date.now()) + OFF; let n = 0;
      while (t < t1 && n++ < 48) { const d = new Date(t), nx = Math.min(t1, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)); g[(d.getUTCDay() + 6) % 7][d.getUTCHours()] += (nx - t) / 1000; t = nx; } });
    return g;
  }
  function drawDash() {
    const b = $('ts-body'); if (!b || S.tab !== 'dash') return; killCharts();
    const r = dashRange(), pr = prevRange(r), all = (S.dashEntries || []).filter(countable), adm = isAdmin();
    const projOf = e => e.proj_nombre || e.project_nombre || 'Sin proyecto', projs = [...new Set(all.map(projOf))].sort();
    if (D.project !== 'all' && !projs.includes(D.project)) D.project = 'all';
    const sel = e => (D.project === 'all' || projOf(e) === D.project) && (!D.client || cliOf(e) === D.client) && (D.space === '' || String(spaceOf(e)) === D.space), inR = (e, a, z) => { const d = limaDay(e.started_at); return d >= a && d <= z; };
    const cur = all.filter(e => sel(e) && inR(e, r.start, r.end)), prv = all.filter(e => sel(e) && inR(e, pr.start, pr.end)), sum = l => l.reduce((a, e) => a + dur(e), 0);
    const tot = sum(cur), totP = sum(prv), fact = sum(cur.filter(billable)), team = S.dashTeam, nP = D.member === 'all' ? Math.max(1, (team && team.personas.length) || 1) : 1;
    let cap = 0; for (let d = r.start, n = 0; d <= r.end && n < 400; d = addD(d, 1), n++) cap += capDay(d); cap *= nP;
    const tareas = new Set(cur.filter(e => e.task_id).map(e => e.task_id)).size, diasReg = new Set(cur.map(e => limaDay(e.started_at))).size;
    const dlt = totP > 0 ? Math.round((tot - totP) / totP * 100) : null;
    const kpi = (l, v, s, cls) => `<div class="tsd-k"><span>${l}</span><b>${v}</b><small class="${cls || ''}">${s}</small></div>`;
    const kpis = kpi('Horas registradas', fmtH(tot), dlt == null ? 'Sin periodo anterior para comparar' : `${dlt >= 0 ? '▲ +' : '▼ '}${dlt}% vs. periodo anterior`, dlt == null ? '' : dlt >= 0 ? 'up' : 'dn')
      + kpi('Capacidad usada', cap ? Math.round(tot / cap * 100) + '%' : '—', `de ${fmtH(cap)} disponibles`) + kpi('Facturables', fmtH(fact), `${tot ? Math.round(fact / tot * 100) : 0}% del total`)
      + kpi('Tareas trabajadas', tareas, `${diasReg} día${diasReg === 1 ? '' : 's'} con registro`) + kpi('Promedio diario', fmtH(diasReg ? tot / diasReg : 0), 'por día con registro');
    const top = (list, keyF, n) => { const m = new Map(); list.forEach(e => { const k = keyF(e); m.set(k, (m.get(k) || 0) + dur(e)); }); return [...m.entries()].sort((a, z) => z[1] - a[1]).slice(0, n); };
    let byProj = top(cur, projOf, 99); if (byProj.length > 7) { const rest = byProj.slice(7).reduce((a, x) => a + x[1], 0); byProj = byProj.slice(0, 7).concat([['Otros', rest]]); }
    const byTask = top(cur, e => e.task_titulo || 'Sin tarea', 8), byClient = top(cur, e => e.client_nombre || 'Sin cliente', 8);
    const names = {}; if (team) team.personas.forEach(p => { names[p.user_id] = p.nombre; });
    const byPers = D.member === 'all' ? top(cur, e => names[e.user_id] || ('Usuario ' + e.user_id), 10) : [];
    const days = []; for (let d = r.start, n = 0; d <= r.end && n < 125; d = addD(d, 1), n++) days.push(d);
    const dayF = {}, dayN = {}; cur.forEach(e => { const d = limaDay(e.started_at), h = dur(e) / 3600, o = billable(e) ? dayF : dayN; o[d] = (o[d] || 0) + h; });
    const mw = monday(r.end), weeks = Array.from({ length: 8 }, (_, i) => addD(mw, -7 * (7 - i)));
    const wTot = weeks.map(w => sum(all.filter(e => sel(e) && inR(e, w, addD(w, 6)))) / 3600), wCap = weeks.map(w => Array.from({ length: 7 }, (_, i) => capDay(addD(w, i))).reduce((a, x) => a + x, 0) / 3600 * nP);
    const hg = heatGrid(cur), hmax = Math.max(1, ...hg.flat());
    const ext = {}; (S.dashEntries || []).filter(e => !countable(e) && inR(e, r.start, r.end)).forEach(e => { let m = e.metadata; if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = {}; } } m = m || {}; const web = e.source === 'browser_extension', nm = (web ? m.websiteDomain : m.appName) || ''; if (!nm) return; const k = (web ? 'w' : 'a') + nm; (ext[k] = ext[k] || { nm, web, s: 0 }).s += dur(e); });
    const extL = Object.values(ext).sort((a, z) => z.s - a.s).slice(0, 6), extMax = extL.length ? extL[0].s : 1;
    const seg = (k, l) => `<button type="button" class="${D.period === k ? 'on' : ''}" onclick="TimesheetModule.dashSet('period','${k}')">${l}</button>`;
    const memSel = adm && team ? `<select class="ts-sel" onchange="TimesheetModule.dashSet('member',this.value)"><option value="me"${D.member === 'me' ? ' selected' : ''}>Mi tiempo</option><option value="all"${D.member === 'all' ? ' selected' : ''}>Todo el equipo</option>${team.personas.map(p => `<option value="${esc(p.nombre)}"${D.member === p.nombre ? ' selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>` : '';
    const prSel = `<select class="ts-sel" onchange="TimesheetModule.dashSet('project',this.value)"><option value="all">Todos los proyectos</option>${projs.map(p => `<option value="${esc(p)}"${D.project === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>`;
    const cliOpts = [...new Set(all.map(cliOf))].sort(), spIds = [...new Set(all.map(spaceOf).filter(x => x != null))];
    const cliSel = `<select class="ts-sel" onchange="TimesheetModule.dashSet('client',this.value)"><option value="">Todos los clientes</option>${cliOpts.map(x => `<option value="${esc(x)}"${D.client === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
    const spSel = `<select class="ts-sel" onchange="TimesheetModule.dashSet('space',this.value)"><option value="">Todos los espacios</option>${spIds.map(id => `<option value="${id}"${D.space === String(id) ? ' selected' : ''}>${esc(spaceName(id))}</option>`).join('')}</select>`;
    const card = (cls, t, body, sub) => `<div class="tsd-card ${cls}"><div class="tsd-ch0"><h4>${t}</h4>${sub ? `<span>${sub}</span>` : ''}</div>${body}</div>`;
    const legend = byProj.map((x, i) => `<div class="tsd-lg"><i style="background:${PAL[i % PAL.length]}"></i><span>${esc(x[0])}</span><b>${fmtH(x[1])}</b><em>${tot ? Math.round(x[1] / tot * 100) : 0}%</em></div>`).join('');
    const hours = Array.from({ length: 24 }, (_, h) => h), DS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const heat = `<div class="tsd-heat"><div class="tsd-heat__h"><span></span>${hours.map(h => `<em>${h % 3 === 0 ? h : ''}</em>`).join('')}</div>${hg.map((row, di) => `<div class="tsd-heat__r"><span>${DS[di]}</span>${row.map((v, h) => `<i title="${DS[di]} ${h}:00 · ${fmtH(v)}" style="--a:${v ? (0.14 + 0.86 * v / hmax).toFixed(2) : 0}"></i>`).join('')}</div>`).join('')}</div>`;
    const apps = extL.length ? `<div class="tsd-apps">${extL.map(x => `<div class="tsd-app"><span class="tsd-app__n">${ic(x.web ? '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>' : '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', 15)}${esc(x.nm)}</span><i><u style="width:${Math.round(x.s / extMax * 100)}%"></u></i><b>${fmtH(x.s)}</b></div>`).join('')}</div>`
      : `<div class="ts-empty ts-empty--in tsd-emp"><span>Conecta la extensión del navegador o el agente de escritorio para ver aquí las apps y sitios donde realmente trabajaste.</span><button type="button" class="ts-btn" onclick="TimesheetModule.go('ajustes','conexiones')">${ic(IC.gear, 14)}Configurar conexiones</button></div>`;
    const none = !cur.length;
    const empty = '<div class="tsd-none">Sin registros en este periodo</div>';
    b.innerHTML = `<div class="tsd-top"><div class="ts-seg">${seg('week', 'Semana')}${seg('month', 'Mes')}${seg('15d', '15 días')}${seg('30d', '30 días')}${seg('custom', 'Personalizado')}</div>
        ${D.period !== 'week' && D.period !== 'month' ? `${D.period === 'custom' ? `<span class="tsd-cr"><input type="date" value="${esc(D.from)}" onchange="TimesheetModule.dashSet('from',this.value)"><span>–</span><input type="date" value="${esc(D.to)}" onchange="TimesheetModule.dashSet('to',this.value)"></span>` : ''}<b class="tsd-lbl">${r.label}</b>` : `<div class="ts-wk"><button type="button" class="ts-ib" onclick="TimesheetModule.dashNav(-1)">${ic(IC.left, 17)}</button><button type="button" class="ts-ib" onclick="TimesheetModule.dashNav(1)">${ic(IC.right, 17)}</button><b class="tsd-lbl">${r.label}</b></div>`}
        <span class="ts-sp"></span>${memSel}${spSel}${cliSel}${prSel}<button type="button" class="ts-btn" onclick="TimesheetModule.go('informe')">${ic(IC.list, 14)}Informe detallado</button></div>
      <div class="tsd-kpis">${kpis}</div>
      <div class="tsd-grid">
        ${card('tsd-c8', 'Horas por día', none ? empty : '<div class="tsd-ch"><canvas id="tsd-a"></canvas></div>', 'facturable y no facturable frente a la capacidad')}
        ${card('tsd-c4', 'Por proyecto', none ? empty : `<div class="tsd-ch tsd-ch--d"><canvas id="tsd-b"></canvas><div class="tsd-dc"><b>${fmtH(tot)}</b><span>total</span></div></div><div class="tsd-lgs">${legend}</div>`)}
        ${card('tsd-c6', 'Tendencia de 8 semanas', '<div class="tsd-ch"><canvas id="tsd-c"></canvas></div>', 'horas por semana')}
        ${card('tsd-c6', 'Tareas con más horas', none ? empty : '<div class="tsd-ch"><canvas id="tsd-d"></canvas></div>')}
        ${card('tsd-c8', 'Cuándo trabajas', none ? empty : heat, 'intensidad por día y hora (hora de Lima)')}
        ${card('tsd-c4', D.member === 'all' ? 'Por persona' : 'Por cliente', none ? empty : '<div class="tsd-ch"><canvas id="tsd-f"></canvas></div>')}
        ${card('tsd-c12', 'Apps y sitios usados', apps, 'registrados por la extensión o el agente')}
      </div>`;
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.color = '#5F6B64';
    const hh = v => v + 'h', grid = { color: '#EEF0EE' }, tipH = c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmtH((c.parsed.y != null && c.chart.options.indexAxis !== 'y' ? c.parsed.y : c.parsed.x) * 3600)}`;
    const mk = (id, cfg) => { const el = $(id); if (el) _charts.push(new Chart(el, cfg)); };
    const base = { responsive: true, maintainAspectRatio: false };
    if (!none) {
      mk('tsd-a', { type: 'bar', data: { labels: days.map(d => D.period === 'week' ? `${DOW[dowIdx(d)].slice(0, 3)} ${+d.slice(8)}` : String(+d.slice(8))), datasets: [
        { label: 'Facturable', data: days.map(d => +(dayF[d] || 0).toFixed(2)), backgroundColor: '#00804C', borderRadius: 4, stack: 'h', maxBarThickness: 34 },
        { label: 'No facturable', data: days.map(d => +(dayN[d] || 0).toFixed(2)), backgroundColor: '#B9D8C9', borderRadius: 4, stack: 'h', maxBarThickness: 34 },
        { type: 'line', label: 'Capacidad', data: days.map(d => capDay(d) / 3600 * nP), borderColor: '#8B9690', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, stepped: true }] },
        options: Object.assign({}, base, { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: tipH } } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { callback: hh }, grid } } }) });
      mk('tsd-b', { type: 'doughnut', data: { labels: byProj.map(x => x[0]), datasets: [{ data: byProj.map(x => +(x[1] / 3600).toFixed(2)), backgroundColor: byProj.map((_, i) => PAL[i % PAL.length]), borderWidth: 0 }] }, options: Object.assign({}, base, { cutout: '70%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.label}: ${fmtH(c.parsed * 3600)}` } } } }) });
      mk('tsd-d', { type: 'bar', data: { labels: byTask.map(x => x[0].length > 36 ? x[0].slice(0, 35) + '…' : x[0]), datasets: [{ data: byTask.map(x => +(x[1] / 3600).toFixed(2)), backgroundColor: '#00804C', borderRadius: 4, maxBarThickness: 18 }] }, options: Object.assign({}, base, { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: tipH } } }, scales: { x: { beginAtZero: true, ticks: { callback: hh }, grid }, y: { grid: { display: false } } } }) });
      const pl = D.member === 'all' ? byPers : byClient;
      mk('tsd-f', { type: 'bar', data: { labels: pl.map(x => x[0].length > 26 ? x[0].slice(0, 25) + '…' : x[0]), datasets: [{ data: pl.map(x => +(x[1] / 3600).toFixed(2)), backgroundColor: '#4C7DF0', borderRadius: 4, maxBarThickness: 18 }] }, options: Object.assign({}, base, { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: tipH } } }, scales: { x: { beginAtZero: true, ticks: { callback: hh }, grid }, y: { grid: { display: false } } } }) });
    }
    mk('tsd-c', { type: 'line', data: { labels: weeks.map(w => dShort(w)), datasets: [
      { label: 'Horas', data: wTot.map(v => +v.toFixed(2)), borderColor: '#00804C', backgroundColor: 'rgba(0,128,76,.10)', fill: true, tension: .15, pointRadius: 3, pointBackgroundColor: '#00804C', borderWidth: 2 },
      { label: 'Capacidad', data: wCap, borderColor: '#8B9690', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }] },
      options: Object.assign({}, base, { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: tipH } } }, scales: { x: { grid: { display: false } }, y: { min: 0, beginAtZero: true, ticks: { callback: hh }, grid } } }) });
  }

  // ═════════ Ajustes (menú lateral estilo «Todos los ajustes») ═════════
  const SECS = [['h', 'Hojas de horas'], ['cronograma', 'Cronograma de trabajo'], ['capacidad', 'Capacidad por persona'], ['aprob', 'Aprobaciones'], ['etiquetas', 'Etiquetas de tiempo'], ['h', 'Conexiones'], ['conexiones', 'Extensión y agente'], ['h', 'Mis ajustes'], ['prefs', 'Preferencias'], ['h', 'Administrador'], ['registro', 'Registro de actividad']];
  function bodyAjustes() {
    const b = $('ts-body'); if (!b) return; S.setSec = S.setSec || 'cronograma';
    b.innerHTML = `<div class="ts-sl"><nav class="ts-sn"><div class="ts-sn__t"><button type="button" class="ts-ib" onclick="TimesheetModule.go('mi')" title="Volver">${ic(IC.back, 18)}</button>Ajustes</div>${SECS.map(([k, l]) => k === 'h' ? `<div class="ts-sn__h">${l}</div>` : `<button type="button" class="ts-sn__i${S.setSec === k ? ' on' : ''}" onclick="TimesheetModule.setSec('${k}')">${l}</button>`).join('')}</nav><div class="ts-sc" id="ts-sc"></div></div>`;
    drawSec();
  }
  function setSec(k) { S.setSec = k; bodyAjustes(); }
  function drawSec() { const f = { cronograma: secCronograma, capacidad: secCapacidad, aprob: secAprob, etiquetas: secEtiquetas, conexiones: secConexiones, prefs: secPrefs, registro: secRegistro }[S.setSec] || secCronograma; f(); }
  const secHd = (t, p) => `<div class="ts-set__hd"><h2>${t}</h2></div><p class="ts-set__p ts-set__p--0">${p}</p>`;
  function secCronograma() {
    const c = cfg(), cap = hoursPerDay(), ab = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'], libres = (c.no_laborales || []).slice().sort((a, z) => a.fecha.localeCompare(z.fecha));
    $('ts-sc').innerHTML = `${secHd('Cronograma de trabajo', 'Define el horario de trabajo de tu equipo para calcular la capacidad de las hojas de horas y anticipar el impacto de los días libres.')}
      <h3>Días laborables</h3><div class="ts-card"><span>Elige qué días trabaja tu equipo</span><div class="ts-days">${[1, 2, 3, 4, 5, 6, 7].map((d, i) => `<button type="button" class="ts-dchip${c.dias_laborales.includes(d) ? ' on' : ''}" onclick="TimesheetModule.toggleDia(${d})">${ab[i]}</button>`).join('')}</div></div>
      <h3>Horas de trabajo</h3><div class="ts-card ts-card--col"><div class="ts-crow"><b>Horario</b><span>La misma hora todos los días</span></div><div class="ts-crow"><div><b>Horas diarias</b><small>Capacidad diaria: ${fmtH(cap * 3600)} • Capacidad semanal: ${fmtH(cap * 3600 * c.dias_laborales.length)}</small></div><div class="ts-hrs"><input type="time" id="ts-hi" value="${c.hora_ini}" onchange="TimesheetModule.saveHoras()"><span>a</span><input type="time" id="ts-hf" value="${c.hora_fin}" onchange="TimesheetModule.saveHoras()"></div></div></div>
      <h3>Días no laborables</h3><div class="ts-card ts-card--col">${libres.length ? libres.map(x => `<div class="ts-crow"><div><b>${esc(x.nombre || 'Día libre')}</b><small>${dLong(x.fecha)} ${x.fecha.slice(0, 4)}</small></div><button type="button" class="ts-ib" title="Quitar" onclick="TimesheetModule.delLibre('${x.fecha}')">${ic(IC.x, 15)}</button></div>`).join('') : `<div class="ts-empty ts-empty--in"><div class="ts-empty__i">${ic(IC.cal, 34)}</div><b>Personaliza el horario de trabajo de tu equipo</b><span>Agrega días no laborables o excepciones para alinear la capacidad con la disponibilidad real.</span></div>`}<div class="ts-crow ts-crow--f"><button type="button" class="ts-btn" onclick="TimesheetModule.libreModal()">${ic(IC.plus, 14)}Añadir días libres</button></div></div>`;
  }
  async function secCapacidad() {
    const sc = $('ts-sc'); sc.innerHTML = secHd('Capacidad por persona', 'Por defecto cada persona tiene la capacidad del cronograma de trabajo. Cambia aquí las horas semanales de quien trabaja a medio tiempo o con otro horario.') + '<div class="ts-loading">Cargando…</div>';
    const t = await api('/timesheets/team?week_start=' + monday(todayL())); if (S.tab !== 'ajustes' || S.setSec !== 'capacidad') return; const def = fmtH(t.capacidad_s);
    sc.innerHTML = secHd('Capacidad por persona', 'Por defecto cada persona tiene la capacidad del cronograma de trabajo. Cambia aquí las horas semanales de quien trabaja a medio tiempo o con otro horario.')
      + `<div class="ts-card ts-card--col">${(t.personas || []).map(p => `<div class="ts-crow"><div class="ts-pp"><span class="ts-av">${esc(ini(p.nombre))}</span><div><b>${esc(p.nombre)}</b><small>${p.capacidad_h_override != null ? 'Capacidad personalizada' : 'Usa la capacidad general (' + def + ')'}</small></div></div><div class="ts-hrs"><input type="number" min="0" max="168" step="0.5" class="ts-num" value="${p.capacidad_h_override != null ? p.capacidad_h_override : ''}" placeholder="${(t.capacidad_s / 3600).toFixed(1).replace('.0', '')}" onchange="TimesheetModule.saveCap(${p.user_id},this.value)"><span>h / semana</span>${p.capacidad_h_override != null ? `<button type="button" class="ts-btn" onclick="TimesheetModule.saveCap(${p.user_id},'')">Restablecer</button>` : ''}</div></div>`).join('')}</div>`;
  }
  async function saveCap(uid, v) {
    const m = Object.assign({}, cfg().cap_personas || {}); if (v === '' || v == null) delete m[uid]; else m[uid] = Number(v);
    try { S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), { cap_personas: m }))); showBanner('✓ Capacidad actualizada', 'success'); secCapacidad(); } catch (e) { err(e); secCapacidad(); }
  }
  function secAprob() {
    const c = cfg(), lim = `${DIAS[c.limite_dia - 1]} ${hm('2000-01-01T' + c.limite_hora + ':00-05:00')}`;
    $('ts-sc').innerHTML = `${secHd('Aprobaciones', 'Cada persona envía su hoja de la semana y un administrador la aprueba o la devuelve. Al aprobarla, sus entradas quedan bloqueadas.')}
      <div class="ts-card"><div><b>Aprobaciones de hojas de horas</b><small class="ts-sm">${c.aprob_activas ? 'Activadas: cada semana se envía una hoja por persona.' : 'Desactivadas: las hojas no necesitan aprobación.'}</small></div><label class="ts-sw"><input type="checkbox" ${c.aprob_activas ? 'checked' : ''} onchange="TimesheetModule.toggleAprob(this.checked)"><i></i></label></div>
      ${c.aprob_activas ? `<h3>Plazo y recordatorios</h3><div class="ts-card ts-card--col"><div class="ts-crow"><span>Fecha límite de entrega</span><b>${lim}</b></div><div class="ts-crow"><span>Recordar antes de la fecha límite</span><b>${c.rec_antes_h ? c.rec_antes_h + ' h antes' : 'Nunca'}</b></div><div class="ts-crow"><span>Recordar después de la fecha límite</span><b>${c.rec_despues_h ? c.rec_despues_h + ' h después' : 'Nunca'}</b></div><div class="ts-crow ts-crow--f"><button type="button" class="ts-btn" onclick="TimesheetModule.deadlineModal()">${ic(IC.clock, 14)}Editar fecha límite y recordatorios</button></div></div>` : ''}`;
  }
  async function toggleAprob(v) { if (v && !cfg().aprob_activas) { deadlineModal(); drawSec(); return; } try { S.settings = Object.assign(cfg(), await send('/timesheets/settings', 'PUT', Object.assign({}, cfg(), { aprob_activas: !!v }))); drawSec(); } catch (e) { err(e); drawSec(); } }
  async function secEtiquetas() {
    const sc = $('ts-sc'), hd = secHd('Etiquetas de tiempo', 'Las etiquetas que tu equipo pone a las entradas de tiempo. Renombra una para corregirla, o dale el nombre de otra para unirlas.');
    sc.innerHTML = hd + '<div class="ts-loading">Cargando…</div>'; const l = await api('/timesheets/tags'); if (S.tab !== 'ajustes' || S.setSec !== 'etiquetas') return;
    sc.innerHTML = hd + (l.length ? `<div class="ts-card ts-card--col">${l.map(x => `<div class="ts-crow"><div><span class="ts-tg">${esc(x.tag)}</span><small class="ts-sm">${x.n} entrada${x.n === 1 ? '' : 's'}</small></div><div class="ts-hrs"><button type="button" class="ts-btn" data-t="${esc(x.tag)}" onclick="TimesheetModule.tagRename(this.dataset.t)">Renombrar</button><button type="button" class="ts-btn" data-t="${esc(x.tag)}" onclick="TimesheetModule.tagRemove(this.dataset.t)">Quitar</button></div></div>`).join('')}</div>` : `<div class="ts-empty"><div class="ts-empty__i">${ic(IC.tag, 34)}</div><b>Aún no hay etiquetas</b><span>Se crean desde la vista «Entradas de tiempo», con el icono de etiqueta de cada entrada.</span></div>`);
  }
  async function tagRename(t) { const to = prompt(`Nuevo nombre para «${t}» (si ya existe, se unen):`, t); if (to == null || !to.trim() || to.trim() === t) return; try { const j = await send('/timesheets/tags/rename', 'POST', { from: t, to: to.trim() }); showBanner(`✓ ${j.entradas} entrada(s) actualizada(s)`, 'success'); secEtiquetas(); } catch (e) { err(e); } }
  async function tagRemove(t) { if (!confirm(`¿Quitar la etiqueta «${t}» de todas las entradas?`)) return; try { const j = await send('/timesheets/tags/rename', 'POST', { from: t, to: '' }); showBanner(`✓ Etiqueta quitada de ${j.entradas} entrada(s)`, 'success'); secEtiquetas(); } catch (e) { err(e); } }
  const ago = d => { if (!d) return 'nunca'; const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000); return s < 3600 ? 'hace ' + Math.max(1, Math.floor(s / 60)) + ' min' : s < 86400 ? 'hace ' + Math.floor(s / 3600) + ' h' : 'hace ' + Math.floor(s / 86400) + ' d'; };
  async function secConexiones() {
    const sc = $('ts-sc'), hd = secHd('Extensión y agente', 'Conecta la extensión del navegador o el agente de escritorio para registrar en qué webs y apps trabajas fuera de Nova. Esas horas confirman tu actividad; no se suman dos veces.');
    sc.innerHTML = hd + '<div class="ts-loading">Cargando…</div>'; const c = await api('/timesheets/connections'); if (S.tab !== 'ajustes' || S.setSec !== 'conexiones') return;
    const f = c.fuentes || {}, src = (k, t, d, icon) => { const x = f[k]; return `<div class="ts-card ts-cx"><span class="ts-cx__i">${ic(icon, 22)}</span><div><b>${t}</b><small class="ts-sm">${d}</small></div><span class="ts-st ${x ? 'ts-st--aprobada' : ''}">${x ? `Activo · ${x.n} registros (30 d) · ${ago(x.ultimo)}` : 'Sin conexión'}</span></div>`; };
    sc.innerHTML = hd + src('browser_extension', 'Extensión del navegador', 'Webs y pestañas del navegador', '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>')
      + src('desktop_agent', 'Agente de escritorio', 'Apps de escritorio y todos los perfiles de Chrome', '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>')
      + `<h3>Token de conexión</h3><div class="ts-card"><div><b>Generar un token</b><small class="ts-sm">Un mismo token conecta el agente y la extensión. Se muestra una sola vez: cópialo y pégalo en el instalador o en la extensión.</small></div><button type="button" class="ts-btn ts-btn--p" onclick="TimerModule.connectExtension()">${ic(IC.plus, 14)}Generar token</button></div>`
      + (c.tokens.length ? `<h3>Tokens activos</h3><div class="ts-card ts-card--col">${c.tokens.map(t => `<div class="ts-crow"><div><b>${esc(t.label || 'Token')}</b><small class="ts-sm">Creado ${ago(t.created_at)} · último uso ${ago(t.last_used_at)}</small></div><button type="button" class="ts-btn" onclick="TimesheetModule.revokeToken(${t.id})">Revocar</button></div>`).join('')}</div>` : '');
  }
  async function revokeToken(id) { if (!confirm('¿Revocar este token? El agente o la extensión que lo use dejará de registrar.')) return; try { await api('/timesheets/tokens/' + id, { method: 'DELETE' }); showBanner('Token revocado', 'success'); secConexiones(); } catch (e) { err(e); } }
  const prefs = () => { try { return JSON.parse(localStorage.getItem('ts_prefs') || '{}'); } catch (_) { return {}; } };
  function setPref(k, v) { const p = prefs(); p[k] = v; try { localStorage.setItem('ts_prefs', JSON.stringify(p)); } catch (_) {} if (k === 'view') S.view = v; if (k === 'hideWk') S.hideWk = !!v; showBanner('✓ Preferencia guardada', 'success'); }
  function secPrefs() {
    const p = prefs(), opt = (v, l, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`;
    $('ts-sc').innerHTML = `${secHd('Preferencias', 'Cómo quieres ver las hojas de horas. Se guardan solo en este navegador.')}
      <div class="ts-card ts-card--col"><div class="ts-crow"><b>Pestaña inicial</b><select class="ts-sel" onchange="TimesheetModule.setPref('tab',this.value)">${opt('mi', 'Mi hoja de horas', p.tab || 'mi')}${opt('dash', 'Dashboard', p.tab || 'mi')}</select></div>
        <div class="ts-crow"><b>Vista de la hoja</b><select class="ts-sel" onchange="TimesheetModule.setPref('view',this.value)">${opt('hoja', 'Hoja de horas', p.view || 'hoja')}${opt('entradas', 'Entradas de tiempo', p.view || 'hoja')}</select></div>
        <div class="ts-crow"><b>Ocultar fines de semana</b><label class="ts-sw"><input type="checkbox" ${p.hideWk ? 'checked' : ''} onchange="TimesheetModule.setPref('hideWk',this.checked)"><i></i></label></div></div>`;
  }
  const ACC = { ajustes: 'Ajustes', enviar: 'Hoja enviada', aprobar: 'Hoja aprobada', rechazar: 'Hoja rechazada', reabrir: 'Hoja reabierta', etiquetas: 'Etiquetas', token: 'Token' };
  async function secRegistro() {
    const sc = $('ts-sc'), hd = secHd('Registro de actividad', 'Cambios de configuración, envíos y aprobaciones de las hojas de horas (los últimos 100).');
    sc.innerHTML = hd + '<div class="ts-loading">Cargando…</div>'; const l = await api('/timesheets/audit'); if (S.tab !== 'ajustes' || S.setSec !== 'registro') return;
    sc.innerHTML = hd + (l.length ? `<div class="ts-card ts-card--col">${l.map(x => `<div class="ts-crow"><div><b>${esc(ACC[x.accion] || x.accion)}</b><small class="ts-sm">${esc(x.actor_name || 'Alguien')} · ${esc(x.detalle)}</small></div><small class="ts-sm">${new Date(x.created_at).toLocaleString('es-ES', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div>`).join('')}</div>` : `<div class="ts-empty"><b>Todavía no hay actividad registrada</b><span>Aquí aparecerán los cambios y aprobaciones desde ahora.</span></div>`);
  }

  return { fPick, clearF, setRange, applyRange, dashNav, dashSet, setSec, saveCap, toggleAprob, tagRename, tagRemove, revokeToken, setPref, open, active, handlesRefresh: active, refresh, go, nav, weekMenu, setWeek, fMenu, fSet, setHideWk, setView, cell, addAt, edit, del, addTask, pickSearch, pick, empty, manual, fold, meta, tagMenu, tagAdd, tagDel, rowMenu, approve,
    submit, review, memberMenu, setMember, openMember, deadlineModal, saveDeadline, toggleDia, saveHoras, delLibre, libreModal, saveLibre };
})();
