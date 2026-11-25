const $ = id => document.getElementById(id);
const APP = 'https://app.novacentrax.com/';
let accion = null;   // qué hace el botón «Abrir»

const msg = (cmd, datos) => new Promise(res => { try { chrome.runtime.sendMessage({ cmd, datos }, r => res(r || { error: 'sin_respuesta' })); } catch (e) { res({ error: String(e) }); } });

async function pintarVinculada() {
  const { paused, estado } = await chrome.storage.local.get({ paused: true, estado: {} });
  const e = estado.msg ? estado : { msg: 'Listo.', nivel: 'ok' };
  const novaPausa = !paused && /^cuenta_(pausada|restringida)/.test(e.motivo || '');
  const on = !paused && !novaPausa;
  $('hero').className = 'hero' + (on ? ' on' : '');
  $('pill').textContent = on ? 'Activa' : (novaPausa ? 'Pausada en Nova' : 'En pausa');
  $('sub').textContent = on ? 'Ejecutando lo que Nova programe, con sus topes' : (novaPausa ? 'Nova mantiene esta cuenta en pausa' : 'Nada se ejecuta hasta que la actives');
  $('toggle').textContent = paused ? 'Activar' : 'Pausar';
  $('toggle').className = paused ? 'go' : 'pri';
  $('swon').checked = on;
  $('st').className = 'msg ' + (e.nivel || '');
  $('st').innerHTML = '<div>' + esc(e.msg) + (e.t ? '<small>Última comprobación: ' + new Date(e.t).toLocaleTimeString() + '</small>' : '') + '</div>';
  $('acctslug').textContent = e.slug ? 'linkedin.com/in/' + e.slug : 'Leyendo cuenta…';
  pintarExtra(on ? e : { ...e, resumen: null });
}

const TIPO = { visit: 'Visitar perfil', invite: 'Enviar invitación', message: 'Enviar mensaje', inmail: 'Enviar InMail' };
function faltan(ts) { const m = Math.max(0, Math.round((new Date(ts) - Date.now()) / 60000)); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; }
const hh = n => String(n).padStart(2, '0') + ':00';
function pintarExtra(e) {
  const r = e.resumen, box = $('extra'); if (!r) { box.innerHTML = ''; return; }
  const v = r.ventana || {}, pt = r.por_tipo || {}, prox = r.proximas || [];
  const hora = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const partes = [pt.visit && pt.visit + ' visitas', pt.invite && pt.invite + ' invitaciones', pt.message && pt.message + ' mensajes', pt.inmail && pt.inmail + ' InMail'].filter(Boolean).join(' · ');
  const hoy = prox.filter(p => p.hoy), luego = prox.filter(p => !p.hoy);
  const fila = p => '<div class="nx"><span class="tm">~' + hora(p.ts) + '</span><i class="tp ' + esc(p.tipo) + '">' + esc(TIPO[p.tipo] || p.tipo) + '</i><span class="nm">' + esc(p.quien) + '</span></div>';
  let h = '<div class="sec">Próximas acciones de hoy' + (hoy.length ? '<span class="ct">' + hoy.length + '</span>' : '') + '</div>';
  if (!r.en_cola) h += '<div class="vacio">No hay nada programado para esta cuenta todavía.</div>';
  else {
    h += '<div class="nxl">' + (hoy.length ? hoy.map(fila).join('') : '<div class="nx"><span class="nm" style="color:var(--mut)">Nada más por hoy: lo siguiente sale en el próximo horario.</span></div>')
      + (luego.length ? '<div class="nx sep">Después</div>' + luego.map(fila).join('') : '') + '</div>'
      + '<p class="foot">Horas estimadas: cambian un poco cada vez a propósito' + (r.en_cola > prox.length ? ' · y ' + (r.en_cola - prox.length) + ' más en cola' : '') + '.</p>';
  }
  let cuando, sub;
  if (v.en_ventana) { cuando = 'Trabajando'; sub = 'hasta las ' + esc(v.finTxt || hh(v.fin)); }
  else if (v.descanso) { cuando = 'Descanso'; sub = 'vuelve a las ' + esc(v.hora) + ' (faltan ' + faltan(v.ts) + ')'; }
  else if (v.ts) { cuando = esc(v.dia) + ' ' + hora(v.ts); sub = 'trabaja de ' + esc(v.hora) + ' a ' + esc(v.finTxt || hh(v.fin)) + ' · ' + esc(v.tz); }
  else { cuando = 'Sin horario'; sub = 'revisa los días en Nova'; }
  h += '<div class="sec">Resumen</div><div class="tiles"><div class="tile"><small>En cola</small><b>' + r.en_cola + '</b><span>' + (partes || 'vacía') + '</span></div><div class="tile"><small>Horario</small><b>' + cuando + '</b><span>' + sub + '</span></div></div>';
  if (e.modo !== 'auto') h += '<details class="card" style="margin-top:14px"><summary>Qué pasa en modo asistido</summary><div class="in-d">La extensión abre cada perfil en una pestaña de LinkedIn. <b>Las visitas se hacen solas.</b> En invitaciones y mensajes deja el texto escrito y <b>tú pulsas «Enviar»</b>; luego sigue con la siguiente. Mantén este Chrome abierto con LinkedIn iniciado.</div></details>';
  box.innerHTML = h;
}
setInterval(() => { pintar(); }, 30000);

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

let pestana = 'estado';
function mostrarPestana(p) {
  pestana = p;
  $('t-estado').className = p === 'estado' ? 'on' : ''; $('t-err').className = p === 'errores' ? 'on' : '';
  $('tab-estado').hidden = p !== 'estado'; $('tab-errores').hidden = p !== 'errores';
  if (p === 'errores') pintarErrores();
}
const fechaE = t => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function pintarErrores() {
  const { errores } = await chrome.storage.local.get({ errores: [] });
  const dia = errores.filter(e => e.nivel === 'error' && Date.now() - e.t < 864e5).length;
  $('nerr').hidden = !dia; $('nerr').textContent = dia;
  if (pestana !== 'errores') return;
  $('errlista').innerHTML = errores.length ? errores.map(e => '<div class="er ' + esc(e.nivel) + '"><b>' + esc(e.tipo) + '</b>' + (e.n > 1 ? '<span class="n">×' + e.n + '</span>' : '') + '<span class="t">' + esc(fechaE(e.t)) + '</span><div>' + esc(e.msg) + '</div>' + (e.ctx ? '<details><summary style="padding:4px 0 0;font-size:11.5px">Detalle técnico</summary><pre>' + esc(JSON.stringify(e.ctx, null, 1)) + '</pre></details>' : '') + '</div>').join('') : '<div class="card"><small>Todo en orden: no hay errores registrados.</small></div>';
}
async function informe() {
  const { errores, estado, identidad, paused } = await chrome.storage.local.get({ errores: [], estado: {}, identidad: {}, paused: true });
  const man = chrome.runtime.getManifest();
  const l = ['FLOW v' + man.version + ' — informe', 'Generado: ' + new Date().toLocaleString(), 'Cuenta de LinkedIn en este Chrome: ' + (identidad.slug ? 'linkedin.com/in/' + identidad.slug : '(sin leer)'), 'Extensión: ' + (paused ? 'en pausa' : 'activa'), 'Estado: ' + (estado.msg || '—'), '', 'Últimos errores y avisos (' + Math.min(errores.length, 25) + ' de ' + errores.length + '):'];
  errores.slice(0, 25).forEach(e => l.push('[' + fechaE(e.t) + '] ' + e.nivel.toUpperCase() + ' ' + e.tipo + (e.n > 1 ? ' ×' + e.n : '') + ' — ' + e.msg + (e.ctx ? ' ' + JSON.stringify(e.ctx) : '')));
  return l.join('\n');
}
$('t-estado').onclick = () => mostrarPestana('estado');
$('t-err').onclick = () => mostrarPestana('errores');
$('copiar').onclick = async () => {
  const txt = await informe();
  try { await navigator.clipboard.writeText(txt); } catch (_) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  $('copiado').hidden = false; setTimeout(() => { $('copiado').hidden = true; }, 2500);
};
$('limpiar').onclick = async () => { await chrome.storage.local.set({ errores: [] }); pintarErrores(); };

async function pintar() {
  const { token } = await chrome.storage.local.get({ token: '' });
  $('vinculada').hidden = !token; $('conectar').hidden = !!token; $('tabs').hidden = !token;
  if (!token && pestana !== 'estado') mostrarPestana('estado');
  if (token) pintarVinculada();
  pintarErrores();
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
  $('toggle').disabled = true; $('swon').disabled = true;
  await msg('activar', paused);   // un solo interruptor: extensión + cuenta en Nova
  $('toggle').disabled = false; $('swon').disabled = false;
  pintarVinculada();
};
$('swon').onchange = () => $('toggle').onclick();
// Se abre como desplegable ancho desde el icono (como lemlist); «Panel lateral» la deja fija a un costado si la prefieres
if (/[?&]p=1/.test(location.search)) {
  document.body.classList.add('pop'); $('lateral').hidden = false;
  $('lateral').onclick = async () => { try { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); } catch (e) { $('lateral').textContent = 'No disponible'; } };
}
$('probar').onclick = async () => { $('probar').disabled = true; await msg('probar'); $('probar').disabled = false; pintarVinculada(); };
$('now').onclick = () => chrome.runtime.sendMessage({ cmd: 'tick' }, () => pintarVinculada());
chrome.storage.onChanged.addListener(() => pintar());
pintar().then(async () => { const { token } = await chrome.storage.local.get({ token: '' }); if (!token) conectar(); });
