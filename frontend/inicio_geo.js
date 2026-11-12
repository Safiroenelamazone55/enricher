/* Selector de país / ciudad con zona horaria para el formulario de inicio.
   Se despliega al hacer clic, filtra al escribir (país o ciudad, sin importar tildes) y guarda
   «País, Ciudad (GMT±n)», el mismo formato de ejemplo que ya tenía el campo. Si no está en la lista, se puede escribir libre. */
(function () {
  // [ISO país, ciudad (es), ciudad (en), zona IANA]
  const D = [
    ['PE','Lima','Lima','America/Lima'],['ES','Madrid','Madrid','Europe/Madrid'],['ES','Barcelona','Barcelona','Europe/Madrid'],['ES','Islas Canarias','Canary Islands','Atlantic/Canary'],
    ['MX','Ciudad de México','Mexico City','America/Mexico_City'],['MX','Monterrey','Monterrey','America/Monterrey'],['MX','Guadalajara','Guadalajara','America/Mexico_City'],['MX','Tijuana','Tijuana','America/Tijuana'],['MX','Cancún','Cancun','America/Cancun'],
    ['CO','Bogotá','Bogota','America/Bogota'],['CO','Medellín','Medellin','America/Bogota'],['AR','Buenos Aires','Buenos Aires','America/Argentina/Buenos_Aires'],['AR','Córdoba','Cordoba','America/Argentina/Cordoba'],
    ['CL','Santiago','Santiago','America/Santiago'],['UY','Montevideo','Montevideo','America/Montevideo'],['PY','Asunción','Asuncion','America/Asuncion'],['BO','La Paz','La Paz','America/La_Paz'],
    ['EC','Quito','Quito','America/Guayaquil'],['VE','Caracas','Caracas','America/Caracas'],['PA','Ciudad de Panamá','Panama City','America/Panama'],['CR','San José','San Jose','America/Costa_Rica'],
    ['GT','Ciudad de Guatemala','Guatemala City','America/Guatemala'],['SV','San Salvador','San Salvador','America/El_Salvador'],['HN','Tegucigalpa','Tegucigalpa','America/Tegucigalpa'],['NI','Managua','Managua','America/Managua'],
    ['DO','Santo Domingo','Santo Domingo','America/Santo_Domingo'],['PR','San Juan','San Juan','America/Puerto_Rico'],['CU','La Habana','Havana','America/Havana'],['JM','Kingston','Kingston','America/Jamaica'],
    ['BR','São Paulo','Sao Paulo','America/Sao_Paulo'],['BR','Río de Janeiro','Rio de Janeiro','America/Sao_Paulo'],['BR','Brasilia','Brasilia','America/Sao_Paulo'],['BR','Manaos','Manaus','America/Manaus'],
    ['US','Nueva York','New York','America/New_York'],['US','Miami','Miami','America/New_York'],['US','Boston','Boston','America/New_York'],['US','Atlanta','Atlanta','America/New_York'],['US','Washington D. C.','Washington, D.C.','America/New_York'],
    ['US','Chicago','Chicago','America/Chicago'],['US','Houston','Houston','America/Chicago'],['US','Dallas','Dallas','America/Chicago'],['US','Austin','Austin','America/Chicago'],
    ['US','Denver','Denver','America/Denver'],['US','Phoenix','Phoenix','America/Phoenix'],['US','Los Ángeles','Los Angeles','America/Los_Angeles'],['US','San Francisco','San Francisco','America/Los_Angeles'],['US','Seattle','Seattle','America/Los_Angeles'],['US','Las Vegas','Las Vegas','America/Los_Angeles'],
    ['US','Anchorage','Anchorage','America/Anchorage'],['US','Honolulu','Honolulu','Pacific/Honolulu'],
    ['CA','Toronto','Toronto','America/Toronto'],['CA','Montreal','Montreal','America/Toronto'],['CA','Vancouver','Vancouver','America/Vancouver'],['CA','Calgary','Calgary','America/Edmonton'],['CA','Winnipeg','Winnipeg','America/Winnipeg'],['CA','Halifax','Halifax','America/Halifax'],
    ['GB','Londres','London','Europe/London'],['GB','Mánchester','Manchester','Europe/London'],['GB','Edimburgo','Edinburgh','Europe/London'],['IE','Dublín','Dublin','Europe/Dublin'],['PT','Lisboa','Lisbon','Europe/Lisbon'],['PT','Oporto','Porto','Europe/Lisbon'],
    ['FR','París','Paris','Europe/Paris'],['DE','Berlín','Berlin','Europe/Berlin'],['DE','Múnich','Munich','Europe/Berlin'],['DE','Fráncfort','Frankfurt','Europe/Berlin'],['IT','Roma','Rome','Europe/Rome'],['IT','Milán','Milan','Europe/Rome'],
    ['NL','Ámsterdam','Amsterdam','Europe/Amsterdam'],['BE','Bruselas','Brussels','Europe/Brussels'],['CH','Zúrich','Zurich','Europe/Zurich'],['AT','Viena','Vienna','Europe/Vienna'],['LU','Luxemburgo','Luxembourg','Europe/Luxembourg'],
    ['SE','Estocolmo','Stockholm','Europe/Stockholm'],['NO','Oslo','Oslo','Europe/Oslo'],['DK','Copenhague','Copenhagen','Europe/Copenhagen'],['FI','Helsinki','Helsinki','Europe/Helsinki'],['IS','Reikiavik','Reykjavik','Atlantic/Reykjavik'],
    ['PL','Varsovia','Warsaw','Europe/Warsaw'],['CZ','Praga','Prague','Europe/Prague'],['HU','Budapest','Budapest','Europe/Budapest'],['RO','Bucarest','Bucharest','Europe/Bucharest'],['BG','Sofía','Sofia','Europe/Sofia'],
    ['GR','Atenas','Athens','Europe/Athens'],['TR','Estambul','Istanbul','Europe/Istanbul'],['UA','Kiev','Kyiv','Europe/Kyiv'],['RU','Moscú','Moscow','Europe/Moscow'],['RS','Belgrado','Belgrade','Europe/Belgrade'],['HR','Zagreb','Zagreb','Europe/Zagreb'],
    ['EE','Tallin','Tallinn','Europe/Tallinn'],['LV','Riga','Riga','Europe/Riga'],['LT','Vilna','Vilnius','Europe/Vilnius'],['MT','La Valeta','Valletta','Europe/Malta'],['CY','Nicosia','Nicosia','Asia/Nicosia'],
    ['AE','Dubái','Dubai','Asia/Dubai'],['AE','Abu Dabi','Abu Dhabi','Asia/Dubai'],['SA','Riad','Riyadh','Asia/Riyadh'],['QA','Doha','Doha','Asia/Qatar'],['KW','Kuwait','Kuwait City','Asia/Kuwait'],['BH','Manama','Manama','Asia/Bahrain'],['OM','Mascate','Muscat','Asia/Muscat'],
    ['IL','Tel Aviv','Tel Aviv','Asia/Jerusalem'],['JO','Amán','Amman','Asia/Amman'],['LB','Beirut','Beirut','Asia/Beirut'],['IR','Teherán','Tehran','Asia/Tehran'],['IQ','Bagdad','Baghdad','Asia/Baghdad'],
    ['EG','El Cairo','Cairo','Africa/Cairo'],['MA','Casablanca','Casablanca','Africa/Casablanca'],['DZ','Argel','Algiers','Africa/Algiers'],['TN','Túnez','Tunis','Africa/Tunis'],['NG','Lagos','Lagos','Africa/Lagos'],['GH','Acra','Accra','Africa/Accra'],
    ['KE','Nairobi','Nairobi','Africa/Nairobi'],['ET','Adís Abeba','Addis Ababa','Africa/Addis_Ababa'],['ZA','Johannesburgo','Johannesburg','Africa/Johannesburg'],['ZA','Ciudad del Cabo','Cape Town','Africa/Johannesburg'],['TZ','Dar es Salaam','Dar es Salaam','Africa/Dar_es_Salaam'],['UG','Kampala','Kampala','Africa/Kampala'],
    ['PK','Karachi','Karachi','Asia/Karachi'],['PK','Lahore','Lahore','Asia/Karachi'],['PK','Islamabad','Islamabad','Asia/Karachi'],['IN','Bombay (Mumbai)','Mumbai','Asia/Kolkata'],['IN','Nueva Delhi','New Delhi','Asia/Kolkata'],['IN','Bangalore','Bangalore','Asia/Kolkata'],['IN','Hyderabad','Hyderabad','Asia/Kolkata'],
    ['BD','Daca','Dhaka','Asia/Dhaka'],['LK','Colombo','Colombo','Asia/Colombo'],['NP','Katmandú','Kathmandu','Asia/Kathmandu'],['AF','Kabul','Kabul','Asia/Kabul'],['UZ','Taskent','Tashkent','Asia/Tashkent'],['KZ','Almaty','Almaty','Asia/Almaty'],
    ['CN','Shanghái','Shanghai','Asia/Shanghai'],['CN','Pekín','Beijing','Asia/Shanghai'],['CN','Shenzhen','Shenzhen','Asia/Shanghai'],['HK','Hong Kong','Hong Kong','Asia/Hong_Kong'],['TW','Taipéi','Taipei','Asia/Taipei'],
    ['JP','Tokio','Tokyo','Asia/Tokyo'],['JP','Osaka','Osaka','Asia/Tokyo'],['KR','Seúl','Seoul','Asia/Seoul'],['SG','Singapur','Singapore','Asia/Singapore'],['MY','Kuala Lumpur','Kuala Lumpur','Asia/Kuala_Lumpur'],
    ['TH','Bangkok','Bangkok','Asia/Bangkok'],['VN','Ho Chi Minh','Ho Chi Minh City','Asia/Ho_Chi_Minh'],['VN','Hanói','Hanoi','Asia/Bangkok'],['ID','Yakarta','Jakarta','Asia/Jakarta'],['PH','Manila','Manila','Asia/Manila'],
    ['AU','Sídney','Sydney','Australia/Sydney'],['AU','Melbourne','Melbourne','Australia/Melbourne'],['AU','Brisbane','Brisbane','Australia/Brisbane'],['AU','Perth','Perth','Australia/Perth'],['AU','Adelaida','Adelaide','Australia/Adelaide'],['NZ','Auckland','Auckland','Pacific/Auckland'],
  ];
  const DIAL = { PE:'51',ES:'34',MX:'52',CO:'57',AR:'54',CL:'56',UY:'598',PY:'595',BO:'591',EC:'593',VE:'58',PA:'507',CR:'506',GT:'502',SV:'503',HN:'504',NI:'505',DO:'1',PR:'1',CU:'53',JM:'1',BR:'55',US:'1',CA:'1',GB:'44',IE:'353',PT:'351',FR:'33',DE:'49',IT:'39',NL:'31',BE:'32',CH:'41',AT:'43',LU:'352',SE:'46',NO:'47',DK:'45',FI:'358',IS:'354',PL:'48',CZ:'420',HU:'36',RO:'40',BG:'359',GR:'30',TR:'90',UA:'380',RU:'7',RS:'381',HR:'385',EE:'372',LV:'371',LT:'370',MT:'356',CY:'357',AE:'971',SA:'966',QA:'974',KW:'965',BH:'973',OM:'968',IL:'972',JO:'962',LB:'961',IR:'98',IQ:'964',EG:'20',MA:'212',DZ:'213',TN:'216',NG:'234',GH:'233',KE:'254',ET:'251',ZA:'27',TZ:'255',UG:'256',PK:'92',IN:'91',BD:'880',LK:'94',NP:'977',AF:'93',UZ:'998',KZ:'7',CN:'86',HK:'852',TW:'886',JP:'81',KR:'82',SG:'65',MY:'60',TH:'66',VN:'84',ID:'62',PH:'63',AU:'61',NZ:'64' };
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const names = {};
  function pais(cc, lang) {
    const k = cc + lang; if (names[k]) return names[k];
    let n = cc; try { n = new Intl.DisplayNames([lang], { type: 'region' }).of(cc) || cc; } catch (_) {}
    return (names[k] = n);
  }
  function gmt(tz) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
      return (p && p.value || '').replace('UTC', 'GMT') || 'GMT';
    } catch (_) { return 'GMT'; }
  }
  const items = lang => D.map(([cc, ces, cen, tz]) => {
    const city = lang === 'en' ? cen : ces, pn = pais(cc, lang), g = gmt(tz);
    return { cc, label: `${pn}, ${city} (${g})`, p: pn, c: city, g, key: norm(pais(cc, 'es') + ' ' + pais(cc, 'en') + ' ' + ces + ' ' + cen + ' ' + tz.replace(/_/g, ' ')) };
  });

  // Convierte un <input> en el selector desplegable. onValue(valor) avisa del cambio.
  function attach(input, lang, onValue) {
    if (!input || input.dataset.geo) return; input.dataset.geo = '1';
    const L = items(lang), en = lang === 'en';
    const wrap = document.createElement('div'); wrap.className = 'geo'; input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.placeholder = en ? 'Click and type a country or city' : 'Haz clic y escribe un país o ciudad';
    const caret = document.createElement('span'); caret.className = 'geo__c'; caret.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; wrap.appendChild(caret);
    const box = document.createElement('div'); box.className = 'geo__l'; box.hidden = true; wrap.appendChild(box);
    let cur = [], act = -1;
    const hi = (txt, q) => { const e = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); return e(txt); };
    function filtrar() {
      const q = norm(input.value), parts = q.split(/\s+/).filter(Boolean);
      // si el valor ya es una opción completa, muestra todo para poder cambiarla
      const exacta = L.some(x => norm(x.label) === q);
      cur = (!parts.length || exacta) ? L : L.filter(x => parts.every(w => x.key.includes(w)));
      act = cur.length && parts.length && !exacta ? 0 : -1;
      pintar();
    }
    function pintar() {
      const q = input.value.trim();
      box.innerHTML = cur.map((x, i) => `<div class="geo__o${i === act ? ' on' : ''}" role="option" data-i="${i}"><b>${hi(x.p)}</b>, ${hi(x.c)} <span>${x.g}</span></div>`).join('')
        + (q && !cur.some(x => x.label === q) ? `<div class="geo__o geo__free" data-free="1">${en ? 'Use' : 'Usar'} «${hi(q)}»</div>` : '')
        + (!cur.length && !q ? `<div class="geo__e">${en ? 'No matches' : 'Sin coincidencias'}</div>` : '');
      const a = box.querySelector('.on'); if (a) a.scrollIntoView({ block: 'nearest' });
    }
    function abrir() { box.hidden = false; filtrar(); }
    function cerrar() { box.hidden = true; }
    function elegir(x) { input.value = x.label; cerrar(); onValue(input.value, x); input.dispatchEvent(new Event('change', { bubbles: true })); }
    input.addEventListener('focus', abrir); input.addEventListener('click', () => { if (box.hidden) abrir(); });
    input.addEventListener('input', () => { box.hidden = false; filtrar(); });
    input.addEventListener('keydown', e => {
      if (box.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { abrir(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { act = Math.min(cur.length - 1, act + 1); pintar(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { act = Math.max(0, act - 1); pintar(); e.preventDefault(); }
      else if (e.key === 'Enter' && !box.hidden) { if (cur[act]) { elegir(cur[act]); e.preventDefault(); } else cerrar(); }
      else if (e.key === 'Escape' || e.key === 'Tab') cerrar();
    });
    box.addEventListener('mousedown', e => {   // mousedown: se elige antes de que el campo pierda el foco
      e.preventDefault(); const o = e.target.closest('.geo__o'); if (!o) return;
      if (o.dataset.free) { cerrar(); onValue(input.value); return; }
      elegir(cur[+o.dataset.i]);
    });
    caret.addEventListener('mousedown', e => { e.preventDefault(); if (box.hidden) { input.focus(); abrir(); } else cerrar(); });
    document.addEventListener('mousedown', e => { if (!wrap.contains(e.target)) cerrar(); });
  }

  // Prefijo telefónico: botón desplegable con buscador + número. Guarda «+51 987654321» en el campo original (oculto).
  function phone(hidden, lang, onValue) {
    if (!hidden || hidden.dataset.geo) return null; hidden.dataset.geo = '1';
    const en = lang === 'en', paises = [...new Set(D.map(x => x[0]))].map(cc => ({ cc, n: pais(cc, lang), d: DIAL[cc], key: norm(pais(cc, 'es') + ' ' + pais(cc, 'en') + ' +' + DIAL[cc]) })).filter(x => x.d).sort((a, b) => a.n.localeCompare(b.n, lang));
    const val = hidden.value || '';
    let dial = '', num = val, manual = false;
    const m = val.match(/^\+(\d{1,3})\s*(.*)$/);
    if (m) { const cand = [m[1], m[1].slice(0, 2), m[1].slice(0, 1)].find(c => paises.some(p => p.d === c)); if (cand) { dial = cand; num = (m[1].slice(cand.length) + ' ' + m[2]).trim(); manual = true; } }
    const wrap = document.createElement('div'); wrap.className = 'geo geo--ph'; hidden.parentNode.insertBefore(wrap, hidden);
    hidden.type = 'hidden'; wrap.appendChild(hidden);
    const row = document.createElement('div'); row.className = 'geo__row'; wrap.appendChild(row);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'geo__pre'; row.appendChild(btn);
    const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'tel'; inp.maxLength = 30; inp.value = num; inp.placeholder = en ? 'Phone number' : 'Número'; inp.setAttribute('autocomplete', 'off'); row.appendChild(inp);
    const pop = document.createElement('div'); pop.className = 'geo__l geo__pop'; pop.hidden = true; wrap.appendChild(pop);
    const q = document.createElement('input'); q.type = 'text'; q.className = 'geo__q'; q.placeholder = en ? 'Search country or code' : 'Busca país o prefijo'; q.setAttribute('autocomplete', 'off'); pop.appendChild(q);
    const ul = document.createElement('div'); pop.appendChild(ul);
    const pintaBtn = () => { btn.innerHTML = (dial ? '+' + dial : (en ? 'Code' : 'Prefijo')) + ' <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'; };
    const sync = () => {
      const n = inp.value.trim(), nuevo = n ? (dial ? '+' + dial + ' ' : '') + n : '';
      if (hidden.value !== nuevo) { hidden.value = nuevo; onValue(nuevo); hidden.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    ['input', 'change'].forEach(t => inp.addEventListener(t, e => { e.stopPropagation(); sync(); }));
    let sel = [];
    const lista = () => {
      const w = norm(q.value).split(/\s+/).filter(Boolean).map(s => s.replace(/^\+/, ''));
      sel = w.length ? paises.filter(p => w.every(s => p.key.includes(s))) : paises;
      ul.innerHTML = sel.map((p, i) => `<div class="geo__o${p.d === dial ? ' on' : ''}" data-i="${i}"><b>${p.n}</b> <span>+${p.d}</span></div>`).join('') || `<div class="geo__e">${en ? 'No matches' : 'Sin coincidencias'}</div>`;
    };
    const abrir = () => { pop.hidden = false; q.value = ''; lista(); q.focus(); const a = ul.querySelector('.on'); if (a) a.scrollIntoView({ block: 'nearest' }); };
    const cerrar = () => { pop.hidden = true; };
    const elegir = d => { dial = d; manual = true; pintaBtn(); cerrar(); sync(); inp.focus(); };
    btn.addEventListener('click', () => (pop.hidden ? abrir() : cerrar()));
    q.addEventListener('input', lista);
    q.addEventListener('keydown', e => { if (e.key === 'Escape') { cerrar(); btn.focus(); } else if (e.key === 'Enter') { e.preventDefault(); if (sel[0]) elegir(sel[0].d); } });
    ul.addEventListener('mousedown', e => { e.preventDefault(); const o = e.target.closest('.geo__o'); if (o && sel[+o.dataset.i]) elegir(sel[+o.dataset.i].d); });
    document.addEventListener('mousedown', e => { if (!wrap.contains(e.target)) cerrar(); });
    pintaBtn();
    return {
      // al elegir el país en el campo de zona horaria: pone su prefijo, salvo que la persona ya haya elegido uno a mano
      setCountry(cc) { const d = DIAL[cc]; if (!d || manual) return; dial = d; pintaBtn(); sync(); },
    };
  }
  window.GEO = { attach, phone, ccDe: label => { const x = items('es').concat(items('en')).find(i => i.label === label); return x && x.cc; } };
})();
