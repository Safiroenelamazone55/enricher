// Puente entre la página de Nova (app.novacentrax.com) y la extensión: así «Conectar cuenta» funciona como iniciar sesión con Google,
// sin copiar ni pegar ningún token. Solo se acepta lo que escribe la propia página (mismo origen); la extensión solo obedece órdenes de vinculación,
// activación y estado, nunca ejecuta nada de LinkedIn a petición de la página.
(() => {
  if (window.__novaLiPuente) return; window.__novaLiPuente = true;
  const ORDENES = new Set(['hello', 'vincular', 'activar', 'estado']);
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__nova_li !== true || d.dir !== 'to-ext' || !ORDENES.has(d.cmd)) return;
    try {
      chrome.runtime.sendMessage({ cmd: 'puente', orden: d.cmd, datos: d.datos || {} }, resp => {
        window.postMessage({ __nova_li: true, dir: 'from-ext', id: d.id, cmd: d.cmd, resp: resp || { error: 'sin_respuesta' } }, location.origin);
      });
    } catch (e) { window.postMessage({ __nova_li: true, dir: 'from-ext', id: d.id, cmd: d.cmd, resp: { error: 'extension_no_disponible' } }, location.origin); }
  });
  // Aviso de que la extensión está instalada (Nova lo detecta sin preguntar)
  window.postMessage({ __nova_li: true, dir: 'from-ext', id: 'ready', cmd: 'ready', resp: { instalada: true } }, location.origin);
})();
