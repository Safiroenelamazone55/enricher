// Reloj de prospección: panel lateral (como WhatsApp/Slack) con la hora local de países y ciudades principales y si están en horario laboral.
//   Verde  = en horario laboral ahora (se puede prospectar)
//   Ámbar  = abren pronto (en las próximas 4 h)
//   Sin color = fuera de horario
// Horario laboral de referencia: 9:00–18:00 de lunes a viernes (viernes–sábado en los países donde el fin de semana es ese).
// Cada fila se puede expandir para ver la etapa de la jornada con una barra vertical que avanza.
const WorldClockModule = (() => {
  const WORK_START = 9 * 60, WORK_END = 18 * 60;
  const SOON_MIN = 240;            // «próximos»: abren dentro de 4 h
  const FRI_SAT = [5, 6];          // días de descanso (0=domingo…6=sábado) donde no es sábado–domingo
  // [ciudad, país, zona IANA, alias de búsqueda, fin de semana]
  const PLACES = [
    ['Lima', 'Perú', 'America/Lima', 'peru'],
    ['Bogotá', 'Colombia', 'America/Bogota', ''],
    ['Quito', 'Ecuador', 'America/Guayaquil', ''],
    ['La Paz', 'Bolivia', 'America/La_Paz', ''],
    ['Santiago', 'Chile', 'America/Santiago', ''],
    ['Buenos Aires', 'Argentina', 'America/Argentina/Buenos_Aires', ''],
    ['Montevideo', 'Uruguay', 'America/Montevideo', ''],
    ['Asunción', 'Paraguay', 'America/Asuncion', ''],
    ['Caracas', 'Venezuela', 'America/Caracas', ''],
    ['São Paulo', 'Brasil', 'America/Sao_Paulo', 'brazil sao paulo rio'],
    ['Ciudad de México', 'México', 'America/Mexico_City', 'mexico cdmx'],
    ['Panamá', 'Panamá', 'America/Panama', 'panama'],
    ['San José', 'Costa Rica', 'America/Costa_Rica', ''],
    ['Ciudad de Guatemala', 'Guatemala', 'America/Guatemala', ''],
    ['Santo Domingo', 'República Dominicana', 'America/Santo_Domingo', 'dominicana'],
    ['San Juan', 'Puerto Rico', 'America/Puerto_Rico', ''],
    ['Nueva York', 'Estados Unidos', 'America/New_York', 'usa us eeuu eua new york miami boston atlanta este east'],
    ['Chicago', 'Estados Unidos', 'America/Chicago', 'usa us eeuu eua texas dallas houston austin central'],
    ['Denver', 'Estados Unidos', 'America/Denver', 'usa us eeuu eua montaña mountain phoenix'],
    ['Los Ángeles', 'Estados Unidos', 'America/Los_Angeles', 'usa us eeuu eua california san francisco seattle pacific'],
    ['Toronto', 'Canadá', 'America/Toronto', 'canada montreal ottawa'],
    ['Vancouver', 'Canadá', 'America/Vancouver', 'canada'],
    ['Madrid', 'España', 'Europe/Madrid', 'spain barcelona valencia alicante'],
    ['Lisboa', 'Portugal', 'Europe/Lisbon', 'lisbon porto'],
    ['Londres', 'Reino Unido', 'Europe/London', 'uk united kingdom england inglaterra london'],
    ['Dublín', 'Irlanda', 'Europe/Dublin', 'ireland dublin'],
    ['París', 'Francia', 'Europe/Paris', 'france paris'],
    ['Berlín', 'Alemania', 'Europe/Berlin', 'germany berlin munich munchen frankfurt'],
    ['Ámsterdam', 'Países Bajos', 'Europe/Amsterdam', 'holanda netherlands amsterdam'],
    ['Bruselas', 'Bélgica', 'Europe/Brussels', 'belgium brussels'],
    ['Roma', 'Italia', 'Europe/Rome', 'italy rome milan milano'],
    ['Zúrich', 'Suiza', 'Europe/Zurich', 'switzerland zurich ginebra geneva'],
    ['Viena', 'Austria', 'Europe/Vienna', 'vienna'],
    ['Estocolmo', 'Suecia', 'Europe/Stockholm', 'sweden stockholm'],
    ['Oslo', 'Noruega', 'Europe/Oslo', 'norway'],
    ['Copenhague', 'Dinamarca', 'Europe/Copenhagen', 'denmark copenhagen'],
    ['Helsinki', 'Finlandia', 'Europe/Helsinki', 'finland'],
    ['Varsovia', 'Polonia', 'Europe/Warsaw', 'poland warsaw'],
    ['Praga', 'Chequia', 'Europe/Prague', 'republica checa czech prague'],
    ['Atenas', 'Grecia', 'Europe/Athens', 'greece athens'],
    ['Bucarest', 'Rumanía', 'Europe/Bucharest', 'romania rumania'],
    ['Estambul', 'Turquía', 'Europe/Istanbul', 'turkey turkiye istanbul'],
    ['Kiev', 'Ucrania', 'Europe/Kyiv', 'ukraine kyiv'],
    ['Dubái', 'Emiratos Árabes Unidos', 'Asia/Dubai', 'uae emirates dubai abu dhabi'],
    ['Riad', 'Arabia Saudita', 'Asia/Riyadh', 'saudi arabia riyadh', FRI_SAT],
    ['Doha', 'Catar', 'Asia/Qatar', 'qatar', FRI_SAT],
    ['Tel Aviv', 'Israel', 'Asia/Jerusalem', 'israel jerusalem', FRI_SAT],
    ['El Cairo', 'Egipto', 'Africa/Cairo', 'egypt cairo', FRI_SAT],
    ['Casablanca', 'Marruecos', 'Africa/Casablanca', 'morocco'],
    ['Lagos', 'Nigeria', 'Africa/Lagos', ''],
    ['Nairobi', 'Kenia', 'Africa/Nairobi', 'kenya'],
    ['Johannesburgo', 'Sudáfrica', 'Africa/Johannesburg', 'south africa johannesburg cape town ciudad del cabo'],
    ['Bombay', 'India', 'Asia/Kolkata', 'india mumbai delhi bangalore'],
    ['Karachi', 'Pakistán', 'Asia/Karachi', 'pakistan'],
    ['Daca', 'Bangladés', 'Asia/Dhaka', 'bangladesh dhaka'],
    ['Singapur', 'Singapur', 'Asia/Singapore', 'singapore'],
    ['Kuala Lumpur', 'Malasia', 'Asia/Kuala_Lumpur', 'malaysia'],
    ['Yakarta', 'Indonesia', 'Asia/Jakarta', 'jakarta'],
    ['Manila', 'Filipinas', 'Asia/Manila', 'philippines'],
    ['Ciudad Ho Chi Minh', 'Vietnam', 'Asia/Ho_Chi_Minh', 'saigon'],
    ['Bangkok', 'Tailandia', 'Asia/Bangkok', 'thailand'],
    ['Hong Kong', 'Hong Kong', 'Asia/Hong_Kong', ''],
    ['Shanghái', 'China', 'Asia/Shanghai', 'china beijing pekin'],
    ['Taipéi', 'Taiwán', 'Asia/Taipei', 'taiwan'],
    ['Tokio', 'Japón', 'Asia/Tokyo', 'japan tokyo'],
    ['Seúl', 'Corea del Sur', 'Asia/Seoul', 'korea seoul'],
    ['Sídney', 'Australia', 'Australia/Sydney', 'sydney'],
    ['Melbourne', 'Australia', 'Australia/Melbourne', ''],
    ['Perth', 'Australia', 'Australia/Perth', ''],
    ['Auckland', 'Nueva Zelanda', 'Pacific/Auckland', 'new zealand'],
  ];
  const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const _fmtCache = {};
  function _parts(tz, date) {
    const f = _fmtCache[tz] || (_fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }));
    const o = {}; f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
    return { wd: _WD[o.weekday], min: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
  }
  const _hhmm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return h + ':' + String(mm).padStart(2, '0'); };
  const _clock = m => { const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h >= 12 ? 'pm' : 'am'; return ((h % 12) || 12) + ':' + String(mm).padStart(2, '0') + ' ' + ap; };
  function _dur(min) {
    min = Math.max(0, Math.round(min));
    if (min < 60) return min + ' min';
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d) return d + ' d' + (h ? ' ' + h + ' h' : '');
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function _state(p, now) {
    const [city, country, tz, , off] = p;
    const rest = off || [0, 6];
    const t = _parts(tz, now);
    const work = d => !rest.includes(d);
    const open = work(t.wd) && t.min >= WORK_START && t.min < WORK_END;
    let wait = null;
    if (!open) for (let k = 0; k <= 7; k++) { const d = (t.wd + k) % 7; if (work(d) && (k > 0 || t.min < WORK_START)) { wait = k * 1440 + WORK_START - t.min; break; } }
    const prog = !work(t.wd) ? 0 : t.min <= WORK_START ? 0 : t.min >= WORK_END ? 1 : (t.min - WORK_START) / (WORK_END - WORK_START);
    const kind = open ? 'open' : (wait != null && wait <= SOON_MIN ? 'soon' : 'off');
    let etapa;
    if (open) etapa = t.min < 12 * 60 ? 'Mañana' : t.min < 14 * 60 ? 'Mediodía' : t.min < 17 * 60 ? 'Tarde' : 'Cierre de jornada';
    else etapa = !work(t.wd) ? 'Día de descanso' : t.min >= WORK_END ? 'Jornada terminada' : 'Aún no empieza';
    return { city, country, tz, t, open, wait, prog, kind, etapa, left: open ? WORK_END - t.min : null };
  }
  let _q = '', _openKey = '', _exp = new Set(), _timer = null, _panel = null;
  const _key = s => s.tz + '|' + s.city;
  function _rowHtml(s) {
    const k = _key(s), ex = _exp.has(k);
    const sub = s.open ? 'cierra en ' + _dur(s.left) : (s.wait != null ? 'abre en ' + _dur(s.wait) : '');
    const pct = Math.round(s.prog * 100);
    return `<div class="wcl-row wcl-row--${s.kind}${ex ? ' is-open' : ''}">
      <button type="button" class="wcl-row__main" onclick="WorldClockModule.toggleRow(this.dataset.k)" data-k="${_esc(k)}" aria-expanded="${ex}">
        <span class="wcl-dot"></span>
        <span class="wcl-row__who"><b>${_esc(s.city)}</b><small>${_esc(s.country)}</small></span>
        <span class="wcl-row__time"><b>${_clock(s.t.min)}</b><small>${_esc(sub)}</small></span>
        <svg class="wcl-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      ${ex ? `<div class="wcl-row__more">
        <div class="wcl-bar" title="${pct}% de la jornada"><span class="wcl-bar__lbl wcl-bar__lbl--t">${_hhmm(WORK_START)}</span><span class="wcl-bar__track"><span class="wcl-bar__fill" style="height:${pct}%"></span><span class="wcl-bar__now" style="top:${pct}%"></span></span><span class="wcl-bar__lbl wcl-bar__lbl--b">${_hhmm(WORK_END)}</span></div>
        <div class="wcl-more__txt">
          <div class="wcl-more__stage">${_esc(s.etapa)}</div>
          <div class="wcl-more__line">${s.open ? 'Jornada al ' + pct + '%' : s.wait != null ? 'Abre en ' + _dur(s.wait) : ''}</div>
          <div class="wcl-more__line">Horario laboral ${_hhmm(WORK_START)}–${_hhmm(WORK_END)} · ${_esc(s.tz.replace(/_/g, ' '))}</div>
        </div>
      </div>` : ''}
    </div>`;
  }
  function _group(title, cls, list) {
    if (!list.length) return '';
    return `<div class="wcl-group wcl-group--${cls}"><div class="wcl-group__hd"><span>${title}</span><i>${list.length}</i></div>${list.map(_rowHtml).join('')}</div>`;
  }
  function _body() {
    const now = new Date(), q = _norm(_q).trim();
    let list = PLACES.filter(p => !q || _norm(p[0] + ' ' + p[1] + ' ' + p[3] + ' ' + p[2]).includes(q)).map(p => _state(p, now));
    const open = list.filter(s => s.kind === 'open').sort((a, b) => b.left - a.left);
    const soon = list.filter(s => s.kind === 'soon').sort((a, b) => a.wait - b.wait);
    const off = list.filter(s => s.kind === 'off').sort((a, b) => (a.wait == null ? 1e9 : a.wait) - (b.wait == null ? 1e9 : b.wait));
    if (!list.length) return `<div class="wcl-empty">Sin coincidencias para «${_esc(_q)}».</div>`;
    return _group('Disponibles ahora', 'open', open) + _group('Abren pronto', 'soon', soon) + _group('Fuera de horario', 'off', off);
  }
  function _head() {
    const now = new Date(), loc = _parts(Intl.DateTimeFormat().resolvedOptions().timeZone, now);
    const tzName = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop().replace(/_/g, ' ');
    return `<b>${_clock(loc.min)}</b><span>Tu hora · ${_esc(tzName)}</span>`;
  }
  function _paint() {
    if (!_panel) return;
    const h = _panel.querySelector('.wcl-now'); if (h) h.innerHTML = _head();
    const b = _panel.querySelector('.wcl-list'); if (b) { const st = b.scrollTop; b.innerHTML = _body(); b.scrollTop = st; }
  }
  function open() {
    if (_panel) return;
    const bar = document.getElementById('global-topbar');
    const top = bar ? Math.round(bar.getBoundingClientRect().bottom) : 56;
    _panel = document.createElement('div'); _panel.className = 'wcl-panel'; _panel.style.top = top + 'px';
    _panel.innerHTML = `<div class="wcl-hd"><div class="wcl-hd__t"><div><h3>Horario de prospección</h3><div class="wcl-now">${_head()}</div></div>
        <button type="button" class="wcl-x" onclick="WorldClockModule.close()" aria-label="Cerrar">✕</button></div>
        <label class="wcl-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
          <input type="text" id="wcl-q" placeholder="Buscar país o ciudad…" autocomplete="off" spellcheck="false" value="${_esc(_q)}" oninput="WorldClockModule.search(this.value)"></label>
        <div class="wcl-legend"><span class="wcl-lg wcl-lg--open">Disponibles</span><span class="wcl-lg wcl-lg--soon">Pronto</span><span class="wcl-lg wcl-lg--off">Fuera de horario</span></div></div>
      <div class="wcl-list">${_body()}</div>`;
    document.body.appendChild(_panel);
    requestAnimationFrame(() => { _panel && _panel.classList.add('on'); const i = document.getElementById('wcl-q'); if (i) i.focus(); });
    clearInterval(_timer); _timer = setInterval(_paint, 30000);
    document.addEventListener('keydown', _esc_key);
    document.addEventListener('mousedown', _outside, true);
  }
  function _esc_key(e) { if (e.key === 'Escape') close(); }
  function _outside(e) {
    if (!_panel) return;
    if (_panel.contains(e.target) || e.target.closest('#wcl-btn')) return;
    close();
  }
  function close() {
    clearInterval(_timer); _timer = null;
    document.removeEventListener('keydown', _esc_key);
    document.removeEventListener('mousedown', _outside, true);
    const p = _panel; _panel = null;
    if (p) { p.classList.remove('on'); setTimeout(() => p.remove(), 160); }
    document.getElementById('wcl-btn')?.classList.remove('is-active');
  }
  function toggle() { if (_panel) close(); else { open(); document.getElementById('wcl-btn')?.classList.add('is-active'); } }
  function search(v) { _q = v || ''; _paint(); }
  function toggleRow(k) { if (_exp.has(k)) _exp.delete(k); else _exp.add(k); _paint(); }
  return { toggle, open, close, search, toggleRow };
})();
