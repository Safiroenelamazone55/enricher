// Lanzador flotante de FLOW en LinkedIn (como el de Apollo): un cuadradito con el muñeco pegado al borde derecho.
// Al pulsarlo se abre el panel de FLOW a un lado de la página (la empuja a la izquierda); se puede subir/bajar arrastrándolo.
// Vive en un Shadow DOM y se construye SOLO con la API del DOM (nada de innerHTML): LinkedIn filtra el HTML insertado como texto.
(function () {
  if (window.top !== window || window.__flowLauncher) return;
  window.__flowLauncher = true;
  try {
    const el = (tag, props, kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); (kids || []).forEach(k => n.appendChild(k)); return n; };
    const host = document.createElement('div');
    host.id = 'flow-launcher-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647';
    const sh = host.attachShadow({ mode: 'open' });
    const css = el('style', {
      textContent: `
      .tab{position:fixed;right:0;width:46px;height:46px;border-radius:12px 0 0 12px;background:#fff;box-shadow:-2px 2px 12px rgba(20,30,60,.28);border:1px solid #E3E6EC;border-right:0;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;transition:width .15s,box-shadow .15s;box-sizing:border-box}
      .tab:hover{width:54px;box-shadow:-3px 3px 16px rgba(20,30,60,.38)}
      .tab img{width:34px;height:34px;border-radius:9px;pointer-events:none;display:block}
      .tab .dot{position:absolute;top:4px;left:5px;width:10px;height:10px;border-radius:50%;background:#12805C;border:2px solid #fff;display:none;box-sizing:content-box}
      .tab.on .dot{display:block}
      .tab .hide{position:absolute;top:-7px;left:-7px;width:18px;height:18px;border-radius:50%;background:#577090;color:#fff;font:700 12px/18px system-ui;text-align:center;display:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}
      .tab:hover .hide{display:block}
      .panel{position:fixed;top:0;right:0;height:100vh;width:480px;max-width:92vw;background:#FBFBFB;box-shadow:-6px 0 28px rgba(20,30,60,.28);border-left:1px solid #E3E6EC;display:none;flex-direction:column;box-sizing:border-box}
      .panel.open{display:flex}
      .bar{height:40px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;background:#fff;border-bottom:1px solid #EFEFEF;font:600 13px system-ui,sans-serif;color:#577090}
      .bar button{all:unset;cursor:pointer;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font:400 20px system-ui;color:#577090}
      .bar button:hover{background:#F0F2F6}
      iframe{border:0;flex:1;width:100%}`,
    });
    const logo = el('img', { src: chrome.runtime.getURL('icons/icon128.png'), alt: 'FLOW' });
    const dot = el('span', { className: 'dot' });
    const hide = el('span', { className: 'hide', textContent: '×', title: 'Ocultar (se vuelve a mostrar desde el panel de FLOW → Avanzado)' });
    const tab = el('div', { className: 'tab', title: 'FLOW · abrir (arrastra para subir o bajar)' }, [hide, dot, logo]);
    const x = el('button', { textContent: '×', title: 'Cerrar' });
    const panel = el('div', { className: 'panel' }, [el('div', { className: 'bar' }, [el('span', { textContent: 'FLOW' }), x])]);
    sh.appendChild(css); sh.appendChild(tab); sh.appendChild(panel);

    let frame = null, top = 190;
    const clamp = v => Math.max(60, Math.min(window.innerHeight - 60, v));
    const place = () => { tab.style.top = clamp(top) + 'px'; };
    place();
    try { chrome.storage.local.get({ lanzadorTop: 190 }, r => { top = Number(r.lanzadorTop) || 190; place(); }); } catch (_) {}

    // Al abrir, la página se empuja a la izquierda (margen derecho en <html>) para que el panel no tape nada.
    const ANCHO = 480, empujar = on => {
      const h = document.documentElement;
      if (on) { h.style.setProperty('transition', 'margin-right .15s', 'important'); h.style.setProperty('margin-right', Math.min(ANCHO, window.innerWidth * 0.92) + 'px', 'important'); }
      else { h.style.removeProperty('margin-right'); setTimeout(() => h.style.removeProperty('transition'), 250); }
    };
    const abrirIframe = () => {
      if (!frame) { frame = el('iframe', { src: chrome.runtime.getURL('sidepanel.html?p=2') }); panel.appendChild(frame); }
      panel.classList.add('open'); tab.style.display = 'none'; empujar(true);
    };
    // Lo normal: abre el panel lateral REAL de Chrome (encoge de verdad la página, nada queda tapado). Si no se pudiera, panel flotante.
    const abrirPanelReal = () => { try { chrome.runtime.sendMessage({ cmd: 'abrirPanel' }, r => { if (chrome.runtime.lastError || !r || !r.ok) abrirIframe(); }); } catch (_) { abrirIframe(); } };
    let loginFrame = null;
    const quitarLogin = () => { if (loginFrame) { loginFrame.remove(); loginFrame = null; } };
    window.addEventListener('message', ev => { if (loginFrame && ev.source === loginFrame.contentWindow && ev.data && ev.data.flowLogin) { quitarLogin(); if (ev.data.ok) abrirPanelReal(); } });
    const mostrarLogin = () => {
      if (loginFrame) return;
      loginFrame = el('iframe', { src: chrome.runtime.getURL('login.html') });
      loginFrame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:transparent';
      sh.appendChild(loginFrame);
    };
    const abrir = on => {
      if (on) {
        try {
          chrome.storage.local.get({ token: '' }, st => {
            if (st && st.token) return abrirPanelReal();
            chrome.runtime.sendMessage({ cmd: 'par_estado' }, p => { if (!chrome.runtime.lastError && p && p.nova === 'sin_sesion') mostrarLogin(); else abrirPanelReal(); });
          });
        } catch (_) { abrirPanelReal(); }
      } else { panel.classList.remove('open'); tab.style.display = 'flex'; empujar(false); }
    };
    x.onclick = () => abrir(false);
    window.addEventListener('message', ev => { if (ev.data && ev.data.flowCerrar) abrir(false); });

    hide.addEventListener('pointerdown', e => e.stopPropagation());
    hide.addEventListener('pointerup', e => { e.stopPropagation(); try { chrome.storage.local.set({ lanzadorOculto: true }); } catch (_) {} });
    let drag = null;
    tab.addEventListener('pointerdown', e => { drag = { y: e.clientY, t: top, moved: false }; try { tab.setPointerCapture(e.pointerId); } catch (_) {} });
    tab.addEventListener('pointermove', e => { if (!drag) return; const d = e.clientY - drag.y; if (Math.abs(d) > 4) drag.moved = true; if (drag.moved) { top = clamp(drag.t + d); place(); } });
    tab.addEventListener('pointerup', e => {
      const d = drag; drag = null; try { tab.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!d) return;
      if (d.moved) { try { chrome.storage.local.set({ lanzadorTop: top }); } catch (_) {} } else abrir(true);
    });
    window.addEventListener('resize', place);

    const estado = () => { try { chrome.storage.local.get({ paused: true, token: '', lanzadorOculto: false }, r => { tab.classList.toggle('on', !r.paused && !!r.token); host.style.display = r.lanzadorOculto ? 'none' : ''; }); } catch (_) {} };
    estado(); try { chrome.storage.onChanged.addListener(estado); } catch (_) {}

    const montar = () => { if (!document.documentElement.contains(host)) document.documentElement.appendChild(host); };
    montar(); setInterval(montar, 3000);   // LinkedIn reescribe el DOM: si lo quita, se vuelve a poner
    console.log('[FLOW] lanzador listo');
  } catch (e) { console.warn('[FLOW] lanzador falló:', e && e.message); }
})();
