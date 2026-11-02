// Avisos emergentes (como en el celular): aparecen arriba a la derecha unos segundos y se van solos.
// Llegan por socket ('notif' del servidor, 'system_alert') o se lanzan desde el código con NovaToast.show().
const NovaToast = (() => {
  const MAX = 3, MS = 6500;
  let host = null, sock = null;
  const IC = {
    whatsapp: '<path d="M4 20l1.3-4.2A8 8 0 1 1 8.4 18.8z"/>',
    mencion: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>',
    slack: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    info: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 21h4"/>',
  };
  function _host() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div'); host.id = 'nt-host'; host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host); return host;
  }
  function show(o) {
    o = o || {};
    const h = _host(), kind = IC[o.kind] ? o.kind : 'info';
    while (h.children.length >= MAX) h.firstChild.remove();
    const el = document.createElement('div'); el.className = 'nt nt--' + kind + (o.onClick ? ' nt--go' : '');
    el.innerHTML = '<span class="nt__ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + IC[kind] + '</svg></span>' +
      '<span class="nt__b"><b class="nt__t"></b><span class="nt__x"></span></span><button class="nt__c" aria-label="Cerrar">×</button>';
    el.querySelector('.nt__t').textContent = o.titulo || '';
    const x = el.querySelector('.nt__x'); x.textContent = o.texto || ''; if (!o.texto) x.remove();
    let timer = null;
    const close = () => { clearTimeout(timer); el.classList.add('nt--out'); setTimeout(() => el.remove(), 220); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, o.ms || MS); };
    el.addEventListener('mouseenter', () => clearTimeout(timer)); el.addEventListener('mouseleave', arm);
    el.querySelector('.nt__c').onclick = e => { e.stopPropagation(); close(); };
    el.onclick = () => { if (o.onClick) { try { o.onClick(); } catch (_) {} } close(); };
    h.appendChild(el); arm();
  }
  function _go(n) {
    if (n.kind === 'whatsapp') {
      if (typeof selectModule === 'function') selectModule('chat');
      setTimeout(() => { try { if (typeof WaChatModule !== 'undefined' && n.chat) WaChatModule.abrirChat(n.chat, n.titulo); } catch (_) {} }, 400);
    } else if (n.kind === 'mencion' && n.task_id && typeof openTaskAnywhere === 'function') {
      openTaskAnywhere(n.task_id);
    } else if (typeof RChatPanel !== 'undefined') RChatPanel.open('notifs');
  }
  function connect() {
    if (sock || typeof io === 'undefined') return;
    sock = io('https://api.novacentrax.com', { withCredentials: true, transports: ['polling', 'websocket'] });
    sock.on('notif', n => {
      const me = window._authUser && window._authUser.id;
      if (n.para && me && +n.para !== +me) return;
      show({ kind: n.kind, titulo: n.titulo, texto: n.texto, onClick: () => _go(n) });
      try { if (typeof RNotifPanel !== 'undefined') RNotifPanel.load(); } catch (_) {}
    });
  }
  const t = setInterval(() => { if (window._authUser) { clearInterval(t); connect(); } }, 1500);
  return { show, connect };
})();

// Texto cortado con «…»: al pasar el cursor se muestra completo (tooltip nativo), en cualquier lista, tabla o tarjeta.
document.addEventListener('mouseover', e => {
  let el = e.target;
  for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
    if (el.title || el.nodeType !== 1 || !el.textContent || el.children.length > 3) continue;
    const cs = getComputedStyle(el);
    const cut = (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1);
    if (cut) { el.title = el.textContent.replace(/\s+/g, ' ').trim(); return; }
  }
}, true);
