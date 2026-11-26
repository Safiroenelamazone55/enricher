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
  $('sub').textContent = on ? 'Trabajando dentro de tus topes' : (novaPausa ? 'En pausa en Nova' : 'Actívala para empezar');
  $('toggle').textContent = paused ? 'Activar' : 'Pausar';
  $('toggle').className = paused ? 'go' : 'pri';
  $('swon').checked = on;
  $('st').className = 'msg ' + (e.nivel || '');
  $('st').innerHTML = '<div>' + esc(e.msg) + (e.t ? '<small>Revisado ' + new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</small>' : '') + '</div>';
  {
    // Muestra el nombre y el usuario de LinkedIn, no la URL completa
    const base = String(e.slug || '').replace(/-[a-z0-9]{6,12}$/i, '');
    const nombre = base.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    $('acctname').textContent = e.slug ? (nombre || e.slug) : 'Leyendo cuenta…';
    $('acctslug').textContent = e.slug ? '@' + e.slug : 'Cuenta de LinkedIn en este Chrome';
  }
  pintarExtra(on ? e : { ...e, resumen: null });
  const md = $('modo');
  if (e.modo === 'auto') { md.className = 'modo au'; md.innerHTML = '<b>Automático</b><span>Envía solo, con topes y horario.</span>'; }
  else if (e.modo) { md.className = 'modo as'; md.innerHTML = '<b>Asistido</b><span>Tú pulsas <u>«Enviar»</u>.</span>'; }
  else { md.className = 'modo nd'; md.innerHTML = '<b>Detectando…</b><span></span>'; }

}

const TIPO = { visit: 'Visitar perfil', invite: 'Enviar invitación', message: 'Enviar mensaje', inmail: 'Enviar InMail', react: 'Reaccionar', follow: 'Seguir perfil', comment: 'Comentar' };
function faltan(ts) { const m = Math.max(0, Math.round((new Date(ts) - Date.now()) / 60000)); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; }
const hh = n => String(n).padStart(2, '0') + ':00';
function pintarExtra(e) {
  const r = e.resumen, box = $('extra'); if (!r) { box.innerHTML = ''; return; }
  const v = r.ventana || {}, pt = r.por_tipo || {}, prox = r.proximas || [];
  const hora = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const partes = [pt.visit && pt.visit + ' visitas', pt.invite && pt.invite + ' invitaciones', pt.message && pt.message + ' mensajes', pt.inmail && pt.inmail + ' InMail'].filter(Boolean).join(' · ');
  const hoy = prox.filter(p => p.hoy), luego = prox.filter(p => !p.hoy);
  const fila = p => '<div class="nx"><span class="tm">~' + hora(p.ts) + '</span><i class="tp ' + esc(p.tipo) + '">' + esc(TIPO[p.tipo] || p.tipo) + '</i><span class="nm">' + esc(p.quien) + '</span></div>';
  let h = '';
  let cuando, sub;
  if (v.en_ventana) { cuando = 'Trabajando'; sub = 'hasta las ' + esc(v.finTxt || hh(v.fin)); }
  else if (v.descanso) { cuando = 'Descanso'; sub = 'vuelve a las ' + esc(v.hora) + ' · ' + faltan(v.ts); }
  else if (v.ts) { cuando = esc(v.dia) + ' ' + hora(v.ts); sub = 'trabaja de ' + esc(v.hora) + ' a ' + esc(v.finTxt || hh(v.fin)) + ' · ' + esc(v.tz); }
  else { cuando = 'Sin horario'; sub = 'revisa los días en Nova'; }
  h += '<div class="sec">Resumen</div><div class="tiles"><div class="tile"><small>En cola</small><b>' + r.en_cola + '</b><span>' + (partes || 'vacía') + '</span></div><div class="tile"><small>Horario</small><b>' + cuando + '</b><span>' + sub + '</span></div></div>';
  if (e.modo !== 'auto') h += '<details class="card" style="margin-top:14px"><summary>Qué pasa en modo asistido</summary><div class="in-d">La extensión abre cada perfil en una pestaña de LinkedIn. <b>Las visitas se hacen solas.</b> En invitaciones y mensajes deja el texto escrito y <b>tú pulsas «Enviar»</b>; luego sigue con la siguiente. Mantén este Chrome abierto con LinkedIn iniciado.</div></details>';
  box.innerHTML = h;
}
let _proxT = 0;
async function pintarProx(forzar) {
  const box = $('prox'); if (!box) return;
  if (!forzar && Date.now() - _proxT < 15000) return;
  _proxT = Date.now();
  const r = await msg('cola');
  if (!r || r.error) { box.innerHTML = '<div class="sec">Próximas acciones de hoy</div><div class="vacio">No pude cargar la lista (' + esc((r && r.error) || 'sin respuesta') + ').</div>'; return; }
  const hora = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hoy = r.cola.filter(p => p.hoy), ver = hoy.slice(0, 6);
  const fila = p => '<div class="nx' + (p.en_curso ? ' cur' : '') + '"><span class="tm">' + (p.en_curso ? 'ahora' : '~' + hora(p.ts)) + '</span><i class="tp ' + esc(p.tipo) + '">' + esc(TIPO[p.tipo] || p.tipo) + '</i><span class="nm">' + esc(p.quien) + '</span></div>';
  let h = '<div class="sec">Próximas acciones de hoy' + (hoy.length ? '<span class="ct">' + hoy.length + '</span>' : '') + '</div>';
  if (!r.total) h += '<div class="vacio">No hay nada programado para esta cuenta todavía.</div>';
  else h += '<div class="nxl">' + (ver.length ? ver.map(fila).join('') : '<div class="nx"><span class="nm" style="color:var(--mut)">Nada más por hoy (' + r.total + ' en cola).</span></div>') + '<button class="vermas" id="vermas">Ver toda la lista (' + r.total + (r.total >= 80 ? '+' : '') + ') →</button></div><p class="foot">Horas estimadas: cambian un poco cada vez a propósito.</p>';
  box.innerHTML = h;
  const vm = $('vermas'); if (vm) vm.onclick = () => mostrarPestana('lista');
}
setInterval(() => { pintar(); if (pestana === 'lista') pintarLista(); }, 30000);

const paso = (ok, t) => `<div class="step${ok ? ' ok' : ''}"><i>${ok ? '✓' : '·'}</i><span>${t}</span></div>`;

let _lgT = 0;
function mostrarLogin(on) {
  const l = $('login'); if (!l) return;
  l.hidden = !on;
  clearInterval(_lgT);
  if (on) _lgT = setInterval(() => { if (!$('login').hidden) conectar(); }, 4000);   // si inició sesión en Nova en otra pestaña, entra solo
}
const lgOk = () => { const ok = /.+@.+\..+/.test($('lg-email').value.trim()) && $('lg-pass').value.length > 0; $('lg-go').disabled = !ok; $('lg-go').className = 'lgo' + (ok ? ' on' : ''); };
$('lg-email').oninput = lgOk; $('lg-pass').oninput = lgOk;
$('lg-eye').onclick = () => { const p = $('lg-pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
$('lg-x').onclick = () => { clearInterval(_lgT); $('login').hidden = true; };
$('lg-nova').onclick = () => chrome.tabs.create({ url: APP });
$('lg-abrir').onclick = () => chrome.tabs.create({ url: APP });
$('lg-forgot').onclick = () => chrome.tabs.create({ url: APP });
$('lg-form').onsubmit = async ev => {
  ev.preventDefault();
  const b = $('lg-go'); b.disabled = true; b.textContent = 'Entrando…'; $('lg-err').textContent = '';
  const r = await msg('nova_login', { email: $('lg-email').value.trim(), password: $('lg-pass').value });
  $('lg-pass').value = ''; b.textContent = 'Inicia sesión'; lgOk();
  if (!r || r.error || !r.ok) { $('lg-err').textContent = (r && r.error) || 'No se pudo iniciar sesión'; return; }
  $('lg-email').value = ''; lgOk(); conectar();
};
async function conectar() {
  $('err').textContent = ''; $('elegir').hidden = true; $('accion-extra').hidden = true;
  $('pasos').innerHTML = paso(false, 'Buscando tu sesión de Nova y de LinkedIn…');
  const r = await msg('par_estado');
  if (r.error) { $('pasos').innerHTML = paso(false, 'No pude comprobar la conexión'); $('err').textContent = r.error; return; }
  const nova = r.nova === 'ok';
  mostrarLogin(r.nova === 'sin_sesion');
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
  $('t-estado').className = p === 'estado' ? 'on' : ''; $('t-lista').className = p === 'lista' ? 'on' : ''; $('t-err').className = p === 'errores' ? 'on' : '';
  $('tab-estado').hidden = p !== 'estado'; $('tab-lista').hidden = p !== 'lista'; $('tab-errores').hidden = p !== 'errores';
  if (p === 'errores') pintarErrores();
  if (p === 'lista') pintarLista();
}
async function pintarLista() {
  const r = await msg('cola');
  const box = $('lista-body');
  if (!r || r.error) { box.innerHTML = '<div class="vacio">No pude cargar la lista (' + esc((r && r.error) || 'sin respuesta') + '). Reintenta en un momento.</div>'; return; }
  const hora = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fila = p => '<div class="nx' + (p.en_curso ? ' cur' : '') + '"><span class="tm">' + (p.en_curso ? 'ahora' : '~' + hora(p.ts)) + '</span><i class="tp ' + esc(p.tipo) + '">' + esc(TIPO[p.tipo] || p.tipo) + '</i><span class="nm">' + esc(p.quien) + '</span>' + (p.campana ? '<span class="cp" title="' + esc(p.campana) + '">' + esc(p.campana) + '</span>' : '') + '</div>';
  const hoy = r.cola.filter(p => p.hoy), luego = r.cola.filter(p => !p.hoy);
  const diaDe = ts => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  const filaL = p => fila(p).replace('<span class="tm">~', '<span class="tm">' + esc(diaDe(p.ts)) + ' ~');
  const hechas = (r.hechas || []).map(p => '<div class="nx hecha"><span class="tm">' + hora(p.t) + '</span><i class="tp ' + esc(p.tipo) + '">' + esc(TIPO[p.tipo] || p.tipo) + '</i><span class="nm">' + esc(p.quien) + '</span><span class="' + (p.estado === 'done' ? 'ok' : 'ko') + '">' + (p.estado === 'done' ? '✓' : p.estado === 'skipped' ? '↷' : '✕') + '</span></div>').join('');
  $('lista-ct').textContent = r.total + (r.total >= 80 ? '+' : '') + ' en cola';
  let h = '';
  if (hoy.length) h += '<div class="nxl">' + '<div class="nx sep">Por hacer hoy</div>' + hoy.map(fila).join('') + '</div>';
  if (luego.length) h += '<div class="nxl" style="margin-top:12px"><div class="nx sep">Después</div>' + luego.map(filaL).join('') + '</div>';
  if (hechas) h += '<div class="nxl" style="margin-top:12px"><div class="nx sep">Hechas en las últimas 24 h</div>' + hechas + '</div>';
  box.innerHTML = h || '<div class="vacio">No hay nada programado para esta cuenta todavía.</div>';
}
const fechaE = t => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function pintarAlerta() {
  const box = $('alerta'); if (!box) return;
  const { errores, estado, alertaVista } = await chrome.storage.local.get({ errores: [], estado: {}, alertaVista: 0 });
  const e = errores.find(x => x.nivel === 'error' && Date.now() - x.t < 2 * 3600e3 && x.t > alertaVista);
  const bloqueo = !e && estado && estado.nivel === 'err' ? estado : null;
  if (!e && !bloqueo) { box.hidden = true; return; }
  const txt = e ? e.tipo.replace(/_/g, ' ') + ': ' + String(e.msg || '').slice(0, 110) : String(bloqueo.msg || '').slice(0, 130);
  box.innerHTML = '<span class="tx"><b>Hay un error</b>' + esc(txt) + '</span><button id="alerta-mas">Ver más ›</button><button class="x" id="alerta-x" title="Ocultar">×</button>';
  box.hidden = false;
  $('alerta-mas').onclick = () => mostrarPestana('errores');
  $('alerta-x').onclick = async () => { await chrome.storage.local.set({ alertaVista: Date.now() }); box.hidden = true; };
}
async function pintarErrores() {
  pintarAlerta();
  const { errores } = await chrome.storage.local.get({ errores: [] });
  const dia = errores.filter(e => e.nivel === 'error' && Date.now() - e.t < 864e5).length;
  $('nerr').hidden = !dia; $('nerr').textContent = dia;
  if (pestana !== 'errores') return;
  const ICO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  $('errlista').innerHTML = errores.length ? errores.map((e, i) => '<div class="code ' + esc(e.nivel) + '"><button class="cpi" data-i="' + i + '" title="Copiar este error">' + ICO + '</button><span class="ch">[' + esc(fechaE(e.t)) + '] ' + esc(String(e.nivel).toUpperCase()) + ' ' + esc(e.tipo) + (e.n > 1 ? ' ×' + e.n : '') + '</span>' + esc(e.msg) + (e.ctx ? '\n' + esc(JSON.stringify(e.ctx)) : '') + '</div>').join('') : '<div class="code"><button class="cpi" data-i="-1" title="Copiar informe">' + ICO + '</button><span class="ch">// errores</span><span class="ok">✓ Sin errores registrados</span></div>';
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
$('t-lista').onclick = () => mostrarPestana('lista');
$('copiar').onclick = async () => {
  const txt = await informe();
  try { await navigator.clipboard.writeText(txt); } catch (_) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  $('copiado').hidden = false; setTimeout(() => { $('copiado').hidden = true; }, 2500);
};
$('errlista').addEventListener('click', async ev => {
  const b = ev.target.closest('.cpi'); if (!b) return;
  const { errores, estado, identidad } = await chrome.storage.local.get({ errores: [], estado: {}, identidad: {} });
  const e = errores[Number(b.dataset.i)];
  const txt = !e ? await informe() : ['FLOW v' + chrome.runtime.getManifest().version + ' — error', 'Cuenta: ' + (identidad.slug ? 'linkedin.com/in/' + identidad.slug : '(sin leer)'), '[' + fechaE(e.t) + '] ' + e.nivel.toUpperCase() + ' ' + e.tipo + (e.n > 1 ? ' ×' + e.n : ''), e.msg, e.ctx ? JSON.stringify(e.ctx) : '', 'Estado: ' + (estado.msg || '—')].filter(Boolean).join('\n');
  try { await navigator.clipboard.writeText(txt); } catch (_) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  b.classList.add('hecho'); const h = b.innerHTML; b.textContent = '✓'; setTimeout(() => { b.innerHTML = h; b.classList.remove('hecho'); }, 1500);
});
$('limpiar').onclick = async () => { await chrome.storage.local.set({ errores: [] }); pintarErrores(); };

async function pintar() {
  const { token } = await chrome.storage.local.get({ token: '' });
  $('vinculada').hidden = !token; $('conectar').hidden = !!token; $('tabs').hidden = !token;
  if (!token && pestana !== 'estado') mostrarPestana('estado');
  if (token) pintarVinculada();
  pintarErrores();
  pintarAlerta();
}

chrome.storage.local.get({ lanzadorOculto: false }, r => { $('vlanz').checked = !r.lanzadorOculto; });
$('vlanz').onchange = () => chrome.storage.local.set({ lanzadorOculto: !$('vlanz').checked });
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
if (/[?&]p=2/.test(location.search)) document.body.classList.add('emb');   // dentro del lanzador flotante de LinkedIn
if (/[?&]p=1/.test(location.search)) {
  document.body.classList.add('pop'); $('lateral').hidden = false;
  $('lateral').onclick = async () => { try { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); } catch (e) { $('lateral').textContent = 'No disponible'; } };
}
$('probar').onclick = async () => { $('probar').disabled = true; await msg('probar'); $('probar').disabled = false; pintarVinculada(); };
$('now').onclick = () => chrome.runtime.sendMessage({ cmd: 'tick' }, () => pintarVinculada());
chrome.storage.onChanged.addListener(() => pintar());
pintar().then(async () => { const { token } = await chrome.storage.local.get({ token: '' }); if (!token) conectar(); });
