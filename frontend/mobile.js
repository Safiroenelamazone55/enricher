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
  function show(key, sel) {
    if (!mqDetail.matches) return;
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
