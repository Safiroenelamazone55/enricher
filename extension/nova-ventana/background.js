'use strict';
// Nova · Ventana de búsqueda
// Nova abre las búsquedas de Google/IA y los perfiles de LinkedIn en una ventana a la derecha. Google corta la conexión entre Nova y esa ventana,
// así que Nova no puede reutilizarla y abría una nueva en cada clic. Una extensión sí puede: guarda el id de la ventana y le cambia la dirección.

const PERMITIDOS = /(^|\.)(google\.[a-z.]+|linkedin\.com)$/i;   // solo Google y LinkedIn
const VERSION = chrome.runtime.getManifest().version;

async function abrir(slot, url, b) {
  const clave = 'win_' + slot;
  const st = await chrome.storage.session.get(clave);
  const id = st[clave];
  if (id) {
    try {
      const w = await chrome.windows.get(id, { populate: true });
      const tab = w.tabs && w.tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url, active: true });
        await chrome.windows.update(id, { focused: true });
        return 'reutilizada';
      }
    } catch (_) { /* la cerraron: se crea otra */ }
  }
  const o = { url, type: 'popup', focused: true };
  if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) { o.width = Math.round(b.width); o.height = Math.round(b.height); o.left = Math.round(b.left || 0); o.top = Math.round(b.top || 0); }
  const w = await chrome.windows.create(o);
  await chrome.storage.session.set({ [clave]: w.id });
  return 'creada';
}

chrome.runtime.onMessageExternal.addListener((msg, sender, responder) => {
  if (!msg) return;
  if (msg.type === 'nova-ping') { responder({ ok: true, version: VERSION }); return; }
  if (msg.type !== 'nova-open') return;
  let u;
  try { u = new URL(String(msg.url || '')); } catch (_) { responder({ ok: false, error: 'dirección no válida' }); return; }
  if (u.protocol !== 'https:' || !PERMITIDOS.test(u.hostname)) { responder({ ok: false, error: 'sitio no permitido' }); return; }
  const slot = msg.slot === 'linkedin' ? 'linkedin' : 'busqueda';
  abrir(slot, u.href, msg.bounds).then(r => responder({ ok: true, r })).catch(e => responder({ ok: false, error: String(e && e.message || e) }));
  return true;   // respuesta asíncrona
});
