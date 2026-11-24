const $ = id => document.getElementById(id);
const APP = 'https://app.novacentrax.com/';
let accion = null;   // qué hace el botón «Abrir»

const msg = (cmd, datos) => new Promise(res => { try { chrome.runtime.sendMessage({ cmd, datos }, r => res(r || { error: 'sin_respuesta' })); } catch (e) { res({ error: String(e) }); } });

async function pintarVinculada() {
  const { paused, estado } = await chrome.storage.local.get({ paused: true, estado: {} });
  $('pill').textContent = paused ? 'En pausa' : 'Activa'; $('pill').className = 'pill ' + (paused ? 'off' : 'on');
  $('toggle').textContent = paused ? 'Activar' : 'Pausar';
  const e = estado.msg ? estado : { msg: 'Listo.', nivel: 'ok' };
  $('st').textContent = e.msg + (e.t ? ' · ' + new Date(e.t).toLocaleTimeString() : '') + (e.slug ? '  ·  Cuenta de LinkedIn en este Chrome: ' + e.slug : ''); $('st').className = 'st ' + (e.nivel || '');
}

const paso = (ok, t) => `<div class="step${ok ? ' ok' : ''}"><i>${ok ? '✓' : '·'}</i><span>${t}</span></div>`;

async function conectar() {
  $('err').textContent = ''; $('elegir').hidden = true; $('accion-extra').hidden = true;
  $('pasos').innerHTML = paso(false, 'Buscando tu sesión de Nova y de LinkedIn…');
  const r = await msg('par_estado');
  if (r.error) { $('pasos').innerHTML = paso(false, 'No pude comprobar la conexión'); $('err').textContent = r.error; return; }
  const nova = r.nova === 'ok';
  $('pasos').innerHTML = paso(nova, nova ? 'Sesión de Nova detectada' + (r.usuario ? ' (' + r.usuario + ')' : '') : 'Inicia sesión en Nova en este Chrome') + paso(!!r.sesion_linkedin, r.sesion_linkedin ? 'Sesión de LinkedIn detectada' : 'Inicia sesión en LinkedIn en este Chrome');
  if (!nova || !r.sesion_linkedin) {
    accion = !nova ? APP : 'https://www.linkedin.com/login';
    $('abrir').textContent = !nova ? 'Abrir Nova' : 'Abrir LinkedIn'; $('accion-extra').hidden = false;
    if (r.nova === 'error') $('err').textContent = r.detalle || '';
    return;
  }
  if (!r.li_slug) { $('pasos').innerHTML += paso(false, 'Leyendo tu cuenta de LinkedIn…'); setTimeout(conectar, 2500); return; }
  $('slug').textContent = 'linkedin.com/in/' + r.li_slug;
  const libres = r.cuentas || [];
  $('cuenta').innerHTML = '<option value="">＋ Crear una cuenta nueva en Nova</option>' + libres.map(c => `<option value="${c.id}">${esc(c.nombre)}${c.cliente ? ' · ' + esc(c.cliente) : ''}${c.li_slug ? ' (ya ligada a ' + esc(c.li_slug) + ')' : ''}</option>`).join('');
  $('cliente').innerHTML = '<option value="">— Ninguno —</option>' + (r.clientes || []).map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
  $('nueva').hidden = false; $('elegir').hidden = false;
}
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function pintar() {
  const { token } = await chrome.storage.local.get({ token: '' });
  $('vinculada').hidden = !token; $('conectar').hidden = !!token;
  if (token) pintarVinculada();
}

$('cuenta').onchange = () => { $('nueva').hidden = !!$('cuenta').value; };
$('abrir').onclick = () => { if (accion) chrome.tabs.create({ url: accion }); };
$('reintentar').onclick = conectar;
$('vincular').onclick = async () => {
  const b = $('vincular'); b.disabled = true; b.textContent = 'Conectando…'; $('err').textContent = '';
  const id = Number($('cuenta').value) || 0;
  const r = await msg('par_vincular', id ? { account_id: id } : { nombre: $('nombre').value.trim() || 'Cuenta LinkedIn', cliente_id: Number($('cliente').value) || null });
  if (!r || r.error || !r.ok) { b.disabled = false; b.textContent = 'Permitir y conectar'; $('err').textContent = (r && r.error) || 'No se pudo conectar'; return; }
  pintar();
};
$('save').onclick = async () => {
  const v = $('tok').value.trim();
  if (!/^nvli_[a-f0-9]+$/i.test(v)) { $('err').textContent = 'El token debe empezar por nvli_'; return; }
  await chrome.storage.local.set({ token: v, paused: true, estado: {} }); $('tok').value = ''; pintar();
};
$('desvincular').onclick = async () => { await chrome.storage.local.set({ token: '', paused: true, estado: {}, identidad: { slug: '', t: 0 } }); pintar(); conectar(); };
$('toggle').onclick = async () => {
  const { paused } = await chrome.storage.local.get({ paused: true });
  await chrome.storage.local.set({ paused: !paused }); pintarVinculada();
  if (paused) chrome.runtime.sendMessage({ cmd: 'tick' });
};
$('now').onclick = () => chrome.runtime.sendMessage({ cmd: 'tick' }, () => pintarVinculada());
chrome.storage.onChanged.addListener(() => pintar());
pintar().then(async () => { const { token } = await chrome.storage.local.get({ token: '' }); if (!token) conectar(); });
