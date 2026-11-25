// Lanzador flotante de FLOW en LinkedIn (como el de Apollo): un cuadradito con el muñeco pegado al borde derecho.
// Al pulsarlo se abre el panel de FLOW a un lado de la página; se puede subir/bajar arrastrándolo. Vive en un Shadow DOM: no toca el estilo de LinkedIn.
(function () {
  if (window.top !== window || window.__flowLauncher) return;
  window.__flowLauncher = true;
  const host = document.createElement('div');
  host.id = 'flow-launcher-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483646';
  const sh = host.attachShadow({ mode: 'closed' });
  const logo = chrome.runtime.getURL('icons/icon128.png');
  sh.innerHTML = `<style>
    .tab{position:fixed;right:0;width:46px;height:46px;border-radius:12px 0 0 12px;background:#fff;box-shadow:-2px 2px 12px rgba(20,30,60,.28);border:1px solid #E3E6EC;border-right:0;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;transition:width .15s,box-shadow .15s}
    .tab:hover{width:54px;box-shadow:-3px 3px 16px rgba(20,30,60,.38)}
    .tab img{width:34px;height:34px;border-radius:9px;pointer-events:none;display:block}
    .tab .hide{position:absolute;top:-7px;left:-7px;width:18px;height:18px;border-radius:50%;background:#577090;color:#fff;font:700 12px/18px system-ui;text-align:center;display:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}
    .tab:hover .hide{display:block}
    .tab .dot{position:absolute;top:4px;left:5px;width:10px;height:10px;border-radius:50%;background:#12805C;border:2px solid #fff;display:none}
    .tab.on .dot{display:block}
    .panel{position:fixed;top:0;right:0;height:100vh;width:480px;max-width:92vw;background:#FBFBFB;box-shadow:-6px 0 28px rgba(20,30,60,.28);border-left:1px solid #E3E6EC;display:none;flex-direction:column}
    .panel.open{display:flex}
    .bar{height:40px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;background:#fff;border-bottom:1px solid #EFEFEF;font:600 13px system-ui,sans-serif;color:#577090}
    .bar button{all:unset;cursor:pointer;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font:400 20px system-ui;color:#577090}
    .bar button:hover{background:#F0F2F6}
    iframe{border:0;flex:1;width:100%}
  </style>
  <div class="tab" id="tab" title="FLOW · abrir (arrastra para subir o bajar)"><span class="hide" id="hide" title="Ocultar (se vuelve a mostrar desde el panel de FLOW → Avanzado)">×</span><span class="dot"></span><img src="${logo}" alt="FLOW"></div>
  <div class="panel" id="panel"><div class="bar"><span>FLOW</span><button id="x" title="Cerrar">×</button></div></div>`;
  const tab = sh.getElementById('tab'), panel = sh.getElementById('panel');
  let frame = null, top = 190;
  const clamp = v => Math.max(60, Math.min(window.innerHeight - 60, v));
  const place = () => { tab.style.top = clamp(top) + 'px'; };
  try { chrome.storage.local.get({ lanzadorTop: 190 }, r => { top = Number(r.lanzadorTop) || 190; place(); }); } catch (_) { place(); }
  const abrir = on => {
    if (on) { if (!frame) { frame = document.createElement('iframe'); frame.src = chrome.runtime.getURL('sidepanel.html?p=2'); panel.appendChild(frame); } panel.classList.add('open'); tab.style.display = 'none'; }
    else { panel.classList.remove('open'); tab.style.display = 'flex'; }
  };
  sh.getElementById('hide').addEventListener('pointerdown', e => { e.stopPropagation(); });
  sh.getElementById('hide').addEventListener('pointerup', e => { e.stopPropagation(); try { chrome.storage.local.set({ lanzadorOculto: true }); } catch (_) {} });
  const visible = () => { try { chrome.storage.local.get({ lanzadorOculto: false }, r => { host.style.display = r.lanzadorOculto ? 'none' : ''; }); } catch (_) {} };
  visible(); try { chrome.storage.onChanged.addListener(visible); } catch (_) {}
  sh.getElementById('x').onclick = () => abrir(false);
  let drag = null;
  tab.addEventListener('pointerdown', e => { drag = { y: e.clientY, t: top, moved: false }; tab.setPointerCapture(e.pointerId); });
  tab.addEventListener('pointermove', e => { if (!drag) return; const d = e.clientY - drag.y; if (Math.abs(d) > 4) drag.moved = true; if (drag.moved) { top = clamp(drag.t + d); place(); } });
  tab.addEventListener('pointerup', e => {
    const d = drag; drag = null; try { tab.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!d) return;
    if (d.moved) { try { chrome.storage.local.set({ lanzadorTop: top }); } catch (_) {} } else abrir(true);
  });
  window.addEventListener('resize', place);
  // punto verde si la extensión está activa
  const estado = () => { try { chrome.storage.local.get({ paused: true, token: '' }, r => tab.classList.toggle('on', !r.paused && !!r.token)); } catch (_) {} };
  estado(); try { chrome.storage.onChanged.addListener(estado); } catch (_) {}
  const montar = () => { if (!document.documentElement.contains(host)) document.documentElement.appendChild(host); };
  montar(); setInterval(montar, 4000);   // LinkedIn reescribe el DOM: si lo quita, se vuelve a poner
})();
