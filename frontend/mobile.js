// Móvil y tablet: cajón del menú lateral (☰), estado «inicio» y navegación lista → detalle (chats, inbox).
// Las reglas visuales viven en mobile.css.
(function () {
  const mq = window.matchMedia('(max-width: 900px)');
  const mqDetail = window.matchMedia('(max-width: 720px)');   // en pantallas más anchas, lista y detalle caben lado a lado
  const body = document.body;
  let bar = null, labelSel = '', labelTimer = null;

  function closeNav() { body.classList.remove('nav-open'); }
  function toggleNav() { body.classList.toggle('nav-open'); }
  window.toggleNavDrawer = toggleNav;
  window.closeNavDrawer = closeNav;

  // ── Lista → detalle ──
  // En el móvil no cabe la lista y la conversación a la vez: al abrir una conversación se muestra SOLA, con una barra «‹ Volver» arriba.
  function _label() {
    if (!bar) return;
    const el = labelSel && document.querySelector(labelSel);
    bar.querySelector('.m-backbar__t').textContent = (el && el.textContent.trim()) || '';
  }
  // Solo cuenta si la persona acaba de tocar algo: las aperturas automáticas (el chat que se abre solo al cargar, un refresco) no deben saltarse la lista.
  let lastTap = 0;
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { lastTap = Date.now(); }, true));
  function show(key, sel) {
    if (!mqDetail.matches || Date.now() - lastTap > 3000) return;
    [...body.classList].filter(c => c.startsWith('m-detail--')).forEach(c => body.classList.remove(c));
    body.classList.add('m-detail', 'm-detail--' + key);
    labelSel = sel || '';
    _label(); clearTimeout(labelTimer); labelTimer = setTimeout(_label, 450);
    const m = document.querySelector('.app-main'); if (m) m.scrollTop = 0;
  }
  function hide() {
    [...body.classList].filter(c => c === 'm-detail' || c.startsWith('m-detail--')).forEach(c => body.classList.remove(c));
  }
  window.MobileNav = { show, hide };

  function syncHome() {
    const shell = document.getElementById('appShell');
    body.classList.toggle('is-home', !!(shell && shell.classList.contains('home-mode')));
    if (body.classList.contains('is-home')) { closeNav(); hide(); }
  }
  function init() {
    bar = document.createElement('div'); bar.id = 'm-backbar';
    bar.innerHTML = '<button type="button" class="m-backbar__b" aria-label="Volver a la lista"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>Volver</span></button><span class="m-backbar__t"></span>';
    bar.querySelector('button').addEventListener('click', hide);
    body.appendChild(bar);

    const shell = document.getElementById('appShell');
    if (shell) new MutationObserver(syncHome).observe(shell, { attributes: true, attributeFilter: ['class'] });
    syncHome();
    // Elegir una sección (o volver a «Módulos») cierra el cajón y cualquier conversación abierta.
    document.addEventListener('click', e => {
      if (e.target.closest('#sidebar .snav-item, #sidebar .snav-back, .lm2-nav__item, .lm2-nav .snav-back')) { hide(); if (mq.matches) setTimeout(closeNav, 30); }
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeNav(); } });
    const onChange = () => { if (!mq.matches) closeNav(); if (!mqDetail.matches) hide(); };
    (mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange));
    (mqDetail.addEventListener ? mqDetail.addEventListener('change', onChange) : mqDetail.addListener(onChange));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// Espacios (móvil): el árbol de espacios es una barra compacta; un toque en su cabecera lo despliega y elegir algo lo vuelve a plegar.
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('.sp-tree'); if (!t || !window.matchMedia('(max-width: 720px)').matches) return;
  if (e.target.closest('.sp-hb, .sp-add, button, input')) { if (e.target.closest('.sp-add, .sp-hb')) t.classList.add('is-open'); return; }
  if (e.target.closest('.sp-tree__h')) { t.classList.toggle('is-open'); return; }
  if (e.target.closest('.sp-all, .sp-pj')) setTimeout(() => t.classList.remove('is-open'), 60);
}, true);

// ═══ Teléfono: navegación tipo app ═══
// En pantallas ≤ 720 px la navegación pasa a una barra inferior (4 accesos del módulo + «Más»); lo demás va en una hoja que sube desde abajo.
(function () {
  const mq = window.matchMedia('(max-width: 720px)');
  const body = document.body;
  let bar = null, sheet = null, last = '';
  const NS = 'http://www.w3.org/2000/svg';
  const ico = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const MORE = ico('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>');
  const OPS_MAIN = [['mgmt-dashboard', 'Inicio'], ['mgmt-mywork', 'Mi trabajo'], ['mgmt-calendar', 'Calendario'], ['mgmt-chat', 'Chat']];
  const OUT_MAIN = [['dashboard', 'Dashboard'], ['x-cantera', 'Borradores'], ['campaigns', 'Campañas'], ['inbox', 'Inbox']];

  function mode() {
    if (body.classList.contains('is-home')) return null;
    const lm = document.getElementById('pane-lead-manager');
    if ((lm && lm.classList.contains('active')) || document.querySelector('.pane--embedded.active')) return 'out';
    if (document.querySelector('.snav-item[data-tab^="mgmt-"].active')) return 'ops';
    return null;
  }
  const svgOf = el => { const s = el && el.querySelector('svg'); return s ? s.outerHTML.replace(/width="\d+"/, 'width="22"').replace(/height="\d+"/, 'height="22"') : ico('<circle cx="12" cy="12" r="9"/>'); };
  const opsBtn = tab => document.querySelector('#sidebar .snav-item[data-tab="' + tab + '"]');
  const outBtn = k => [...document.querySelectorAll('.lm2-nav__item')].find(b => (b.getAttribute('onclick') || '').includes("go('" + k + "')"));
  const labelOf = b => ((b.querySelector('.lm2-nav__lbl, .snav-item__label') || {}).textContent || b.getAttribute('data-tooltip') || b.textContent || '').trim();
  const find = (m, k) => (m === 'ops' ? opsBtn(k) : outBtn(k));

  function render() {
    if (!bar) return;
    const m = mq.matches ? mode() : null;
    body.classList.toggle('m-bar', !!m);
    if (!m) { bar.innerHTML = ''; last = ''; return; }
    const main = m === 'ops' ? OPS_MAIN : OUT_MAIN;
    const activeBtn = m === 'ops' ? document.querySelector('#sidebar .snav-item[data-tab^="mgmt-"].active') : document.querySelector('.lm2-nav__item.active');
    const activeKey = m === 'ops' ? (activeBtn && activeBtn.dataset.tab) : (main.find(([k]) => { const b = outBtn(k); return b && b.classList.contains('active'); }) || [])[0];
    const sig = m + '|' + (activeKey || (activeBtn ? labelOf(activeBtn) : ''));
    if (sig === last && bar.innerHTML) return; last = sig;
    bar.innerHTML = main.map(([k, l]) => { const b = find(m, k); return `<button type="button" class="m-tb${activeKey === k ? ' on' : ''}" data-k="${k}" data-m="${m}">${svgOf(b)}<span>${l}</span></button>`; }).join('')
      + `<button type="button" class="m-tb${activeKey ? '' : ' on'}" data-more="1">${MORE}<span>Más</span></button>`;
  }
  function closeSheet() { if (sheet) { sheet.classList.remove('on'); setTimeout(() => sheet && sheet.remove(), 180); sheet = null; } }
  function openSheet() {
    closeSheet(); const m = mode(); if (!m) return;
    const main = (m === 'ops' ? OPS_MAIN : OUT_MAIN).map(x => x[0]);
    let items = [];
    if (m === 'ops') {
      const seen = new Set();
      const EXC = ['mgmt-projects', 'mgmt-tasks'];
      const scope = document.querySelector('#sidebar .snav-group.mod-on') || document.getElementById('sidebar');
      scope.querySelectorAll('.snav-item[data-tab^="mgmt-"]').forEach(b => { const k = b.dataset.tab; if (seen.has(k) || main.includes(k) || EXC.includes(k)) return; seen.add(k); items.push({ svg: svgOf(b), l: labelOf(b), on: b.classList.contains('active'), go: () => b.click() }); });
      const tool = (l, svg, fn) => items.push({ svg, l, go: fn });
      tool('Bloc de notas', ico('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v2h6V3M9 10h6M9 14h6"/>'), () => window.NotepadModule && NotepadModule.toggle());
      tool('Horario de prospección', ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), () => window.WorldClockModule && WorldClockModule.toggle());
    } else {
      document.querySelectorAll('.lm2-nav__item').forEach(b => { const o = b.getAttribute('onclick') || ''; const mm = o.match(/go\('([^']+)'\)/); if (!mm || main.includes(mm[1])) return; items.push({ svg: svgOf(b), l: labelOf(b).replace(/\d+$/, '').trim(), on: b.classList.contains('active'), go: () => b.click() }); });
    }
    items.push({ svg: ico('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'), l: 'Módulos', go: () => { try { goHome(); } catch (_) {} } });
    sheet = document.createElement('div'); sheet.id = 'm-sheet'; sheet.innerHTML = '<div class="m-sheet__bg"></div><div class="m-sheet__box"><div class="m-sheet__grip"></div><div class="m-sheet__t">Más secciones</div><div class="m-sheet__grid"></div></div>';
    const grid = sheet.querySelector('.m-sheet__grid');
    items.forEach(it => { const b = document.createElement('button'); b.type = 'button'; b.className = 'm-sh' + (it.on ? ' on' : ''); b.innerHTML = it.svg + '<span>' + it.l + '</span>'; b.onclick = () => { closeSheet(); setTimeout(it.go, 120); }; grid.appendChild(b); });
    sheet.querySelector('.m-sheet__bg').onclick = closeSheet;
    document.body.appendChild(sheet); requestAnimationFrame(() => sheet && sheet.classList.add('on'));
  }
  function init() {
    bar = document.createElement('nav'); bar.id = 'm-tabbar'; bar.setAttribute('aria-label', 'Navegación principal'); document.body.appendChild(bar);
    bar.addEventListener('click', e => {
      const b = e.target.closest('.m-tb'); if (!b) return;
      if (b.dataset.more) { openSheet(); return; }
      closeSheet(); const t = find(b.dataset.m, b.dataset.k); if (t) t.click(); setTimeout(render, 150);
    });
    document.addEventListener('click', () => setTimeout(render, 160), true);
    window.addEventListener('popstate', () => setTimeout(render, 160));
    setInterval(() => { if (mq.matches) render(); }, 1000);
    (mq.addEventListener ? mq.addEventListener('change', render) : mq.addListener(render));
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
