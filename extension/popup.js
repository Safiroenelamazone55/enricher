const $ = id => document.getElementById(id);
const DEFAULT_API = 'https://api.kiwoc.com/api';

// La API de Nova vive SIEMPRE en api.kiwoc.com/api. Corrige el error común de
// pegar la URL de la web (enricher.kiwoc.com / app / www) en vez de la API,
// y garantiza el sufijo /api. Sin esto, los envíos van a un 404 → "Sin conexión".
function normalizeApi(raw) {
  let v = (raw || '').trim();
  if (!v) return DEFAULT_API;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (/(^|\.)kiwoc\.com$/i.test(u.hostname)) return DEFAULT_API;
    let path = u.pathname.replace(/\/+$/, '');
    if (!/\/api$/i.test(path)) path += '/api';
    return u.origin + path;
  } catch { return DEFAULT_API; }
}

function fmt(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }

// Token de extensión (Fase 2.1) → Authorization: Bearer. Si no hay, cae a la cookie de sesión.
function authOpts(extToken) {
  const o = { credentials: 'include' };
  if (extToken) o.headers = { 'Authorization': 'Bearer ' + extToken };
  return o;
}

function ago(ts) {
  if (!ts) return 'aún no';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}

async function refresh() {
  const store = await chrome.storage.local.get(['apiBase', 'enabled', 'buffer', 'extToken', 'lastFlush']);
  const apiBase = normalizeApi(store.apiBase ?? DEFAULT_API);
  if (apiBase !== store.apiBase) chrome.storage.local.set({ apiBase });   // auto-corrige un valor mal pegado
  const { enabled = true, buffer = [], extToken = '', lastFlush = 0 } = store;
  $('enabled').checked = !!enabled;
  $('api').value = apiBase;
  $('token').value = extToken;
  $('pending').textContent = buffer.length;
  $('sync-txt').textContent = enabled ? `Sincronización automática · última ${ago(lastFlush)}` : 'Envío pausado';
  document.getElementById('sync').classList.toggle('sync--off', !enabled);

  // Estado de conexión (token de extensión o sesión de Nova del navegador)
  const conn = $('conn');
  conn.textContent = 'Comprobando…'; conn.className = 'pill pill--soon';
  try {
    const r = await fetch(`${apiBase}/timer/running`, authOpts(extToken));
    if (r.status === 401) { conn.textContent = extToken ? 'Token inválido' : 'Inicia sesión'; conn.className = 'pill pill--off'; }
    else if (r.ok)        { conn.textContent = 'Conectado';     conn.className = 'pill pill--on'; }
    else                  { conn.textContent = 'Sin conexión';  conn.className = 'pill pill--off'; }
  } catch { conn.textContent = 'Sin conexión'; conn.className = 'pill pill--off'; }

  // Tiempo web registrado hoy (solo bloques de esta extensión)
  try {
    const r = await fetch(`${apiBase}/timer/today`, authOpts(extToken));
    if (r.ok) {
      const rows = await r.json();
      const s = (Array.isArray(rows) ? rows : []).filter(x => x.source === 'browser_extension').reduce((a, x) => a + (x.duration_s || 0), 0);
      $('today').textContent = fmt(s);
    }
  } catch {}
}

$('enabled').addEventListener('change', e => chrome.storage.local.set({ enabled: e.target.checked }));
$('api').addEventListener('change', e => chrome.storage.local.set({ apiBase: normalizeApi(e.target.value) }, refresh));
$('token').addEventListener('change', e => chrome.storage.local.set({ extToken: e.target.value.trim() }, refresh));
$('flush').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'flush' }, () => setTimeout(refresh, 400)));

// Tick ligero (sin red) para que el "última hace Xs" y los pendientes se vean en vivo.
async function lightTick() {
  const { enabled = true, buffer = [], lastFlush = 0 } = await chrome.storage.local.get(['enabled', 'buffer', 'lastFlush']);
  $('pending').textContent = buffer.length;
  $('sync-txt').textContent = enabled ? `Sincronización automática · última ${ago(lastFlush)}` : 'Envío pausado';
}
setInterval(lightTick, 2000);

refresh();
