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
  const r = e.resumen, box = $('extra'); $('h-n').textContent = r ? r.en_cola : 0; if (!r) { box.innerHTML = ''; return; }
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

// ── cabecera y atajos (estilo lemlist) ──
const NOVA_LM = APP + '?tab=lead-manager';
const abrirU = u => chrome.tabs.create({ url: u });
$('h-nova').onclick = () => abrirU(APP);
$('h-cola').onclick = () => mostrarPestana('lista');
$('e-lista').onclick = () => mostrarPestana('lista');
$('e-err').onclick = () => mostrarPestana('errores');
async function bienvenida() {
  const r = await msg('par_estado'); const { estado, paused } = await chrome.storage.local.get({ estado: {}, paused: true });
  const nombre = String(r && r.usuario || '').split(/[ @]/)[0];
  $('hola-t').textContent = '¡Bienvenido' + (nombre ? ', ' + nombre.charAt(0).toUpperCase() + nombre.slice(1) : '') + '!';
  $('hola-s').textContent = paused ? 'Actívala para que FLOW empiece a trabajar.' : 'FLOW trabaja con tus topes y horario.';
}
function mostrarLogin(on) { const l = $('login-wrap'); if (l) l.hidden = !on; }
window.addEventListener('message', ev => {
  if (!ev.data || !ev.data.flowLogin) return;
  mostrarLogin(false);
  if (ev.data.ok) { _gateOk = true; conectar(); }
});
let _gateOk = false, _cli = null, _ctx = { cuentas: [], clientes: [], slug: '' };
async function conectar() {
  $('err').textContent = ''; $('elegir').hidden = true; $('gate').hidden = true; $('accion-extra').hidden = true;
  $('pasos').innerHTML = paso(false, 'Buscando tu sesión de Nova y de LinkedIn…');
  const r = await msg('par_estado');
  if (r.error) { $('pasos').innerHTML = paso(false, 'No pude comprobar la conexión'); $('err').textContent = r.error; $('accion-extra').hidden = false; accion = APP; $('abrir').textContent = 'Abrir Nova'; return; }
  const nova = r.nova === 'ok';
  mostrarLogin(r.nova === 'sin_sesion');
  if (!nova) {
    $('pasos').innerHTML = paso(false, r.nova === 'sin_sesion' ? 'Inicia sesión con tu cuenta de Nova' : 'No pude hablar con Nova');
    if (r.nova === 'error') $('err').textContent = r.detalle || '';
    accion = APP; $('abrir').textContent = 'Abrir Nova'; $('accion-extra').hidden = false;
    return;
  }
  // Siempre se pide confirmar con qué cuenta de Nova se entra (no se aprovecha la sesión en silencio)
  if (!_gateOk) { $('pasos').innerHTML = ''; $('gate-user').textContent = r.usuario || 'Tu cuenta de Nova'; $('gate').hidden = false; return; }
  if (!r.sesion_linkedin) {
    $('pasos').innerHTML = paso(true, 'Sesión de Nova (' + esc(r.usuario || '') + ')') + paso(false, 'Inicia sesión en LinkedIn en este Chrome');
    accion = 'https://www.linkedin.com/login'; $('abrir').textContent = 'Abrir LinkedIn'; $('accion-extra').hidden = false;
    return;
  }
  if (!r.li_slug) { $('pasos').innerHTML = paso(true, 'Sesión de Nova (' + esc(r.usuario || '') + ')') + paso(false, 'Leyendo tu cuenta de LinkedIn…'); setTimeout(conectar, 2500); return; }
  $('pasos').innerHTML = '';
  $('slug').textContent = 'linkedin.com/in/' + r.li_slug; $('elegir-user').textContent = r.usuario || '';
  _ctx = { cuentas: r.cuentas || [], clientes: r.clientes || [], slug: r.li_slug };
  const propia = _ctx.cuentas.find(c => c.li_slug && c.li_slug === r.li_slug);
  _cli = propia ? (propia.outbound_client_id || 0) : null;   // si este LinkedIn ya estaba conectado, se propone su mismo cliente
  $('cbuscar').value = ''; pintarClientes(); $('elegir').hidden = false;
}
function pintarClientes() {
  const q = $('cbuscar').value.trim().toLowerCase();
  const cl = _ctx.clientes.filter(c => !q || c.nombre.toLowerCase().includes(q));
  const filaC = (id, nombre, sub) => '<div class="cli' + (_cli === id ? ' on' : '') + '" data-id="' + id + '"><i>' + esc((nombre || '?')[0].toUpperCase()) + '</i><div><b>' + esc(nombre) + '</b><small>' + esc(sub) + '</small></div><span class="ck"></span></div>';
  $('clist').innerHTML = cl.map(c => {
    const ac = _ctx.cuentas.filter(a => a.outbound_client_id === c.id);
    return filaC(c.id, c.nombre, ac.length ? 'Cuenta de LinkedIn: ' + ac.map(a => a.li_slug ? '@' + a.li_slug : 'sin vincular').join(', ') : 'Aún sin cuenta de LinkedIn');
  }).join('') + (q ? '' : filaC(0, 'Sin cliente (solo pruebas)', 'No se liga a ningún cliente outbound')) || '<div class="vacio">No hay clientes que coincidan.</div>';
  const sel = _cli ? _ctx.clientes.find(c => c.id === _cli) : null;
  const otra = sel && _ctx.cuentas.find(a => a.outbound_client_id === sel.id && a.li_slug && a.li_slug !== _ctx.slug);
  $('caviso').textContent = otra ? 'Este cliente ya tiene otra cuenta de LinkedIn conectada (@' + otra.li_slug + '). Esta será una segunda cuenta.' : '';
  $('vincular').disabled = _cli === null;
}
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let pestana = 'estado';
function mostrarPestana(p) {
  pestana = p;
  $('t-pro').className = p === 'prospecto' ? 'on' : ''; $('t-estado').className = p === 'estado' ? 'on' : ''; $('t-lista').className = p === 'lista' ? 'on' : ''; $('t-err').className = p === 'errores' ? 'on' : '';
  $('tab-prospecto').hidden = p !== 'prospecto'; $('tab-estado').hidden = p !== 'estado'; $('tab-lista').hidden = p !== 'lista'; $('tab-errores').hidden = p !== 'errores';
  if (p === 'prospecto') { _proSig = ''; pintarProspecto(); }
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
  $('vinculada').hidden = !token; $('conectar').hidden = !!token; $('tabs').hidden = !token; document.body.classList.toggle('sinvin', !token);
  if (!token && pestana !== 'estado') mostrarPestana('estado');
  if (token) pintarVinculada();
  pintarErrores();
  pintarAlerta();
  if (token) bienvenida();
}

chrome.storage.local.get({ lanzadorOculto: false }, r => { $('vlanz').checked = !r.lanzadorOculto; });
$('vlanz').onchange = () => chrome.storage.local.set({ lanzadorOculto: !$('vlanz').checked });
$('cbuscar').oninput = pintarClientes;
$('clist').onclick = ev => { const f = ev.target.closest('.cli'); if (!f) return; _cli = Number(f.dataset.id); pintarClientes(); };
$('gate-ok').onclick = () => { _gateOk = true; conectar(); };
$('gate-otro').onclick = async () => { $('gate-otro').disabled = true; await msg('nova_logout'); $('gate-otro').disabled = false; _gateOk = false; conectar(); };
$('abrir').onclick = () => { if (accion) chrome.tabs.create({ url: accion }); };
$('reintentar').onclick = conectar;
$('vincular').onclick = async () => {
  const b = $('vincular'); b.disabled = true; b.textContent = 'Conectando…'; $('err').textContent = '';
  const cli = _cli || null, nomCli = (_ctx.clientes.find(c => c.id === cli) || {}).nombre || '';
  // la cuenta de ese cliente que aún no tiene LinkedIn (o ya es éste); si no hay, se crea una nueva (Nova no duplica el mismo LinkedIn)
  const ya = cli ? _ctx.cuentas.find(a => a.outbound_client_id === cli && (!a.li_slug || a.li_slug === _ctx.slug)) : null;
  const r = await msg('par_vincular', ya ? { account_id: ya.id } : { nombre: (nomCli ? nomCli + ' · ' : '') + _ctx.slug, cliente_id: cli });
  if (!r || r.error || !r.ok) { b.disabled = false; b.textContent = 'Permitir y conectar'; $('err').textContent = (r && r.error) || 'No se pudo conectar'; return; }
  b.textContent = 'Permitir y conectar'; pintar();
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

// ═══════════════ Ficha del prospecto, Ajustes y menús (estilo lemlist) ═══════════════
const IC = {
  bulb: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>',
  gear: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  out: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  mail: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  tel: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  plane: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
  plus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  ok: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

// ── Menús del encabezado: el de las tres secciones (icono con flecha) y el de los tres puntos ──
let _popK = '';
function popup(k, items) {
  const p = $('pop');
  if (!p.hidden && _popK === k) { p.hidden = true; return; }
  _popK = k;
  p.innerHTML = items.map((i, n) => '<button data-i="' + n + '" class="' + (i.cls || '') + '">' + (i.ico || '') + '<span>' + i.t + '</span></button>').join('');
  p.hidden = false;
  p.onclick = ev => { const b = ev.target.closest('button'); if (!b) return; p.hidden = true; items[Number(b.dataset.i)].f(); };
}
document.addEventListener('click', ev => { if (!ev.target.closest('#pop, #h-vistas, #h-mas')) $('pop').hidden = true; });
$('h-vistas').onclick = () => popup('v', [
  ...(perfilActual.hayPerfil ? [{ t: 'Prospecto', f: () => mostrarPestana('prospecto'), cls: pestana === 'prospecto' ? 'cur' : '' }] : []),
  { t: 'Estado', f: () => mostrarPestana('estado'), cls: pestana === 'estado' ? 'cur' : '' },
  { t: 'Lista Outreach', f: () => mostrarPestana('lista'), cls: pestana === 'lista' ? 'cur' : '' },
  { t: 'Errores', f: () => mostrarPestana('errores'), cls: pestana === 'errores' ? 'cur' : '' }]);
$('h-mas').onclick = () => popup('m', [
  { t: '¿Cómo hacerlo?', ico: IC.bulb, f: () => { $('pag-how').hidden = false; } },
  { t: 'Ajustes', ico: IC.gear, f: () => abrirAjustes() },
  { t: 'Cerrar sesión', ico: IC.out, cls: 'danger', f: () => { $('cf').hidden = false; } }]);
const cerrarPanel = () => { if (document.body.classList.contains('emb')) { try { parent.postMessage({ flowCerrar: true }, '*'); } catch (_) {} } else window.close(); };
$('h-x').onclick = cerrarPanel;

// ── Ajustes (como la página de ajustes de lemlist) ──
let _ajT = 0;
async function abrirAjustes() {
  $('pag-ajustes').hidden = false;
  const r = await msg('par_estado');
  const mail = String((r && r.usuario) || '');
  const loc = mail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+.*$/, '').trim();
  const nom = loc.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || mail || 'Tu cuenta';
  $('aj-nom').textContent = nom; $('aj-mail').textContent = mail;
  $('aj-ini').textContent = nom.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const p = await msg('prefs', {});
  if (!p || p.error) { $('aj-rest').textContent = '—'; $('aj-de').textContent = ''; $('aj-det').textContent = 'No pude leer los datos de hoy (' + ((p && p.error) || 'sin respuesta') + ').'; return; }
  const pr = p.prefs || {}, h = p.hoy || {};
  document.querySelectorAll('input[name=dup]').forEach(x => { x.checked = x.value === (pr.dup_modo || 'esta'); });
  $('aj-dias-on').checked = !!pr.dup_dias_on; $('aj-dias').value = pr.dup_dias || 30; ajSub();
  $('aj-rest').textContent = h.restantes != null ? h.restantes : '—';
  $('aj-de').textContent = h.tope ? 'de ' + h.tope + ' de hoy' : '';
  const t = h.topes || {}, x = h.por_tipo || {};
  $('aj-det').textContent = 'Hechas hoy: ' + (h.hechas || 0) + ' · invitaciones ' + (x.invite || 0) + '/' + (t.invite || 0) + ' · visitas ' + (x.visit || 0) + '/' + (t.visit || 0) + ' · mensajes ' + (x.message || 0) + '/' + (t.message || 0);
}
const ajSub = () => { const m = (document.querySelector('input[name=dup]:checked') || {}).value; $('aj-sub').dataset.off = m === 'activa' ? '0' : '1'; };
async function ajGuardar() {
  ajSub();
  const modo = (document.querySelector('input[name=dup]:checked') || {}).value || 'esta';
  const r = await msg('prefs', { guardar: true, dup_modo: modo, dup_dias_on: $('aj-dias-on').checked, dup_dias: Number($('aj-dias').value) || 30 });
  const ok = $('aj-ok'); ok.style.color = r && !r.error ? '' : 'var(--err)'; ok.textContent = r && !r.error ? '✓ Guardado' : 'No se pudo guardar: ' + ((r && r.error) || 'sin respuesta');
  clearTimeout(_ajT); _ajT = setTimeout(() => { ok.textContent = ''; }, 2500);
}
document.querySelectorAll('input[name=dup]').forEach(x => { x.onchange = ajGuardar; });
$('aj-dias-on').onchange = ajGuardar; $('aj-dias').onchange = ajGuardar;
chrome.storage.local.get({ mantenerDespierto: true }, r => { $('aj-despierto').checked = r.mantenerDespierto !== false; });
$('aj-despierto').onchange = () => chrome.storage.local.set({ mantenerDespierto: $('aj-despierto').checked });
$('aj-atras').onclick = () => { $('pag-ajustes').hidden = true; };
$('aj-x').onclick = () => { $('pag-ajustes').hidden = true; cerrarPanel(); };
$('aj-lista').onclick = () => { $('pag-ajustes').hidden = true; mostrarPestana('lista'); };
$('aj-nova').onclick = () => abrirU(APP);
$('aj-inv').onclick = () => abrirU(APP + '?tab=mgmt-team');
$('aj-out').onclick = () => { $('cf').hidden = false; };
$('aj-avanzado').onclick = () => { $('pag-ajustes').hidden = true; mostrarPestana('estado'); const d = $('avanzado'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
$('how-atras').onclick = () => { $('pag-how').hidden = true; };
$('how-x').onclick = () => { $('pag-how').hidden = true; cerrarPanel(); };
$('cf-no').onclick = () => { $('cf').hidden = true; };
$('cf-si').onclick = () => { $('cf').hidden = true; $('pag-ajustes').hidden = true; $('desvincular').click(); };
document.querySelectorAll('.at').forEach(b => { b.onclick = () => { const a = b.dataset.a; if (a === 'ajustes') abrirAjustes(); else abrirU(NOVA_LM); }; });

// ── Pestaña «Prospecto»: quién es la persona que tienes abierta en LinkedIn y qué puedes hacer con ella en Nova ──
let perfilActual = { hayPerfil: false };
let pro = null, _proSig = '', _proBusy = false;
const iniciales = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const proFirma = () => JSON.stringify([perfilActual.slug, perfilActual.nombre, perfilActual.titular, perfilActual.empresa, pro && pro.contacto && [pro.contacto.id, pro.contacto.email, pro.contacto.email_status, pro.contacto.telefono], pro && (pro.inscrito || []).map(i => i.id + i.estado), pro && pro.error]);
async function refrescarPerfil(forzar) {
  if (_proBusy) return; _proBusy = true;
  try {
    const { token } = await chrome.storage.local.get({ token: '' });
    const p = await msg('perfil_leer');
    const nuevo = !!(p && p.hayPerfil);
    const cambio = nuevo && (!perfilActual.hayPerfil || perfilActual.slug !== p.slug);
    perfilActual = nuevo ? p : { hayPerfil: false };
    $('t-pro').hidden = !(token && nuevo);
    if (!nuevo) { if (pestana === 'prospecto') mostrarPestana('estado'); pro = null; _proSig = ''; return; }
    if (cambio || forzar || !pro) {
      if (cambio) { pro = null; _proSig = ''; _pm = { t: '', n: '' }; if (token) mostrarPestana('prospecto'); }
      if (token) { const r = await msg('prospecto', { slug: p.slug }); pro = r && !r.error ? r : { contacto: null, inscrito: [], secuencias: [], error: (r && r.error) || 'sin respuesta' }; }
    }
    if (pestana === 'prospecto') pintarProspecto();
  } finally { _proBusy = false; }
}
function pintarProspecto() {
  const sig = proFirma(); if (sig === _proSig && $('pro-body').innerHTML) return; _proSig = sig;
  const box = $('pro-body'), p = perfilActual, c = pro && pro.contacto;
  if (!p.hayPerfil) { box.innerHTML = '<div class="vacio">Abre el perfil de un prospecto en LinkedIn y aparecerá aquí.</div>'; return; }
  const ins = (pro && pro.inscrito) || [];
  const ST = { valid: ['ok', 'Verificado', 'El email existe y acepta correo'], invalid: ['err', 'Rebotado', 'El email no existe o rebota: no se le escribe'], 'catch-all': ['warn', 'Acepta todo', 'El dominio acepta cualquier dirección: no se puede confirmar'], risky: ['warn', 'Dudoso', 'No se pudo confirmar con certeza'], manual: ['ok', 'Confirmado', 'Confirmado a mano'], blocked: ['err', 'Bloqueado', 'El servidor de correo bloquea la comprobación'], unknown: ['', 'Sin verificar', 'No se pudo comprobar'] };
  const stEmail = c && c.email ? (ST[c.email_status] || ['', 'Sin verificar', 'Aún no se ha comprobado']) : null;
  const pillEmail = stEmail ? '<span class="pf-find st ' + stEmail[0] + '" id="pf-fe" title="' + esc(stEmail[2]) + '">' + esc(stEmail[1]) + '</span>' : '<button class="pf-find" id="pf-fe">Encontrar email</button>';
  const tieneTel = !!(c && (c.telefono || c.movil));
  const pillTel = tieneTel ? '' : '<button class="pf-find" id="pf-ft">Encontrar teléfono</button>';
  const refCamp = ins.find(i => i.estado === 'activo') || ins[0];
  const nomCamp = refCamp ? (refCamp.campana || refCamp.nombre) : '';
  const btnCamp = ins.length
    ? '<button class="pri en" id="pf-camp" title="' + esc(ins.map(i => (i.campana ? i.campana + ' · ' : '') + i.nombre + (i.estado === 'activo' ? '' : ' (' + i.estado + ')')).join('\n') + '\nClic para añadirlo a otra') + '">' + IC.ok + '<span class="tx">En campaña: ' + esc(nomCamp) + (ins.length > 1 ? ' +' + (ins.length - 1) : '') + '</span></button>'
    : '<button class="pri" id="pf-camp">' + IC.plane + 'Añadir a la campaña</button>';
  box.innerHTML =
    '<div class="pf-head">' + (p.foto ? '<img class="pf-av" alt="" src="' + esc(p.foto) + '">' : '<div class="pf-av">' + esc(iniciales(p.nombre)) + '</div>') +
    '<div class="pf-nm"><b>' + esc(p.nombre) + '</b><i class="vl">in</i></div></div>' +
    '<div class="pf-sub">' + (p.titular ? '<div class="t">' + esc(p.titular) + '</div>' : '') + (p.empresa ? '<span class="pf-chip"><i>' + esc(iniciales(p.empresa)) + '</i><span>' + esc(p.empresa) + '</span></span>' : '') + '</div>' +
    (p.ubicacion ? '<div class="pf-loc">' + esc(p.ubicacion) + (p.grado ? ' · ' + esc(p.grado) : '') + '</div>' : '') +
    '<div class="pf-acts">' + btnCamp + '<button id="pf-save"' + (c ? ' class="hecho" disabled' : '') + '>' + (c ? IC.ok + 'Guardado en Nova' : IC.plus + 'Guardar contacto') + '</button></div>' +
    '<div id="pf-msg" class="pf-msg">' + htmlMsg() + '</div><div id="pf-pick"></div>' +
    (pro && pro.error ? '<div class="msg warn pf-msg"><div>No pude consultar a Nova (' + esc(pro.error) + '). Reintento solo.</div></div>' : '') +
    (ins.length ? '<div class="pf-seq">' + ins.map(i => '<span class="' + (i.estado === 'activo' ? '' : 'p') + '" title="Paso ' + esc(i.paso) + '">' + esc(i.nombre) + (i.estado === 'activo' ? '' : ' · ' + esc(i.estado)) + '</span>').join('') + '</div>' : '') +
    '<div class="pf-card"><h3>Información de contacto</h3>' +
    '<label for="pf-email">Email</label><div class="pf-in">' + IC.mail + '<input id="pf-email" type="email" placeholder="Introducir email" autocomplete="off" value="' + esc(c ? c.email : '') + '">' + pillEmail + '</div><div class="pf-nota" id="pf-email-n"></div>' +
    '<label for="pf-tel">Teléfono</label><div class="pf-in">' + IC.tel + '<input id="pf-tel" type="tel" placeholder="Introducir número de teléfono" autocomplete="off" value="' + esc(c ? (c.telefono || c.movil || '') : '') + '">' + pillTel + '</div><div class="pf-nota" id="pf-tel-n"></div></div>';
}
let _pm = { t: '', n: '' };   // último aviso de la ficha: sobrevive a que la ficha se repinte
const htmlMsg = () => _pm.t ? '<div class="msg ' + (_pm.n || '') + '"><div>' + esc(_pm.t) + '</div></div>' : '';
const proMsg = (t, nivel) => { _pm = { t: t || '', n: nivel || '' }; const m = $('pf-msg'); if (m) m.innerHTML = htmlMsg(); };
const proNota = (id, t, nivel) => { const m = $(id); if (m) { m.className = 'pf-nota' + (nivel ? ' ' + nivel : ''); m.textContent = t || ''; } };
async function asegurarContacto() {
  if (pro && pro.contacto) return pro.contacto;
  const p = perfilActual;
  const r = await msg('prospecto_guardar', { slug: p.slug, nombre: p.nombre, cargo: p.titular, empresa: p.empresa, ubicacion: p.ubicacion });
  if (!r || r.error || !r.contacto) throw new Error((r && r.error) || 'No se pudo guardar en Nova');
  pro = { ...(pro || {}), contacto: r.contacto, inscrito: r.inscrito || [], secuencias: (pro && pro.secuencias) || [] };
  return { ...r.contacto, _nuevo: !r.existia };
}
async function recargarPro() { const r = await msg('prospecto', { slug: perfilActual.slug }); if (r && !r.error) pro = r; pintarProspecto(); }
async function proGuardar() {
  const b = $('pf-save'); b.disabled = true;
  try { const c = await asegurarContacto(); proMsg(c._nuevo === false ? 'Este prospecto ya estaba en Nova.' : 'Guardado en Nova. Ya lo puedes añadir a una secuencia.', 'ok'); _proSig = ''; pintarProspecto(); }
  catch (e) { proMsg(e.message, 'err'); b.disabled = false; }
}
function proElegir() {
  const box = $('pf-pick'); if (box.innerHTML) { box.innerHTML = ''; return; }
  const sec = (pro && pro.secuencias) || [];
  const cli = pro && pro.cliente && pro.cliente.nombre;
  const lista = (q) => {
    const f = sec.filter(s => !q || (s.nombre + ' ' + s.campana + ' ' + s.cliente).toLowerCase().includes(q.toLowerCase()));
    const fila = s => '<button class="it" data-id="' + s.id + '"><b>' + esc(s.nombre) + '</b><small>' + esc([s.campana, s.cliente].filter(Boolean).join(' · ')) + (s.estado === 'draft' ? ' · borrador' : s.estado === 'activa' ? '' : ' · ' + esc(s.estado)) + '</small></button>';
    const a = f.filter(s => s.del_cliente), o = f.filter(s => !s.del_cliente);
    return (a.length ? '<div class="sep">' + (cli ? 'Del cliente ' + esc(cli) : 'Del cliente de esta cuenta') + '</div>' + a.map(fila).join('') : '') + (o.length ? '<div class="sep">Otras secuencias</div>' + o.map(fila).join('') : '') + (!f.length ? '<div class="vacio" style="border:0">No hay secuencias que coincidan.</div>' : '');
  };
  box.innerHTML = '<div class="pf-pick"><input id="pf-q" placeholder="Buscar secuencia…" autocomplete="off"><div class="ls" id="pf-ls">' + lista('') + '</div></div>';
  $('pf-q').oninput = () => { $('pf-ls').innerHTML = lista($('pf-q').value.trim()); };
  $('pf-q').focus();
  $('pf-ls').onclick = async ev => {
    const it = ev.target.closest('.it'); if (!it) return;
    box.innerHTML = ''; proMsg('Añadiendo…', '');
    try {
      const c = await asegurarContacto();
      const r = await msg('prospecto_campana', { contact_id: c.id, sequence_id: Number(it.dataset.id) });
      if (r && r.ok) proMsg('✓ Añadido a «' + r.secuencia + '». FLOW lo trabajará con tus topes y horario.', 'ok');
      else proMsg((r && (r.motivo || r.error)) || 'No se pudo añadir.', 'warn');
      await recargarPro();
    } catch (e) { proMsg(e.message, 'err'); }
  };
}
async function proDato(campo, valor) {
  const nid = campo === 'email' ? 'pf-email-n' : 'pf-tel-n';
  try {
    const c = await asegurarContacto();
    const r = await msg('prospecto_datos', { contact_id: c.id, [campo]: valor });
    if (r && r.error) return proNota(nid, r.error, 'err');
    proNota(nid, valor ? '✓ Guardado' : '', 'ok'); if (campo === 'email' && valor) setTimeout(recargarPro, 6000);
  } catch (e) { proNota(nid, e.message, 'err'); }
}
async function proBuscarEmail() {
  const b = $('pf-fe'); if (b.disabled) return; b.disabled = true; b.textContent = 'Buscando…'; proNota('pf-email-n', 'Buscando con el buscador de Nova (puede tardar hasta un minuto)…', '');
  try {
    const c = await asegurarContacto();
    if (c.email) { proNota('pf-email-n', 'Ya tiene un email guardado.', 'warn'); return; }
    const r = await msg('prospecto_datos', { contact_id: c.id, accion: 'buscar_email' });
    if (!r || r.error) { proNota('pf-email-n', (r && r.error) || 'No se pudo buscar', 'err'); return; }
    for (let i = 0; i < 18; i++) {
      await new Promise(res => setTimeout(res, 4000));
      const q = await msg('prospecto', { slug: perfilActual.slug });
      if (q && q.contacto && (q.contacto.email || q.contacto.email_status)) {
        pro = q; _proSig = '';
        if (q.contacto.email) { pintarProspecto(); return; }
        proNota('pf-email-n', 'No encontré un email fiable para esta persona. Si lo tienes, escríbelo.', 'warn'); return;
      }
    }
    proNota('pf-email-n', 'Sigue buscando en segundo plano; vuelve a abrir la ficha en un minuto.', 'warn');
  } catch (e) { proNota('pf-email-n', e.message, 'err'); }
  finally { const bb = $('pf-fe'); if (bb && bb.tagName === 'BUTTON') { bb.disabled = false; bb.textContent = 'Encontrar email'; } }
}
async function proBuscarTel() {
  try {
    const c = await asegurarContacto();
    const r = await msg('prospecto_datos', { contact_id: c.id, accion: 'buscar_telefono' });
    if (r && r.telefono) { $('pf-tel').value = r.telefono; proNota('pf-tel-n', 'Teléfono que Nova ya tenía de esta persona.', 'ok'); }
    else proNota('pf-tel-n', 'Nova aún no tiene un buscador de teléfonos conectado: escríbelo a mano si lo tienes.', 'warn');
  } catch (e) { proNota('pf-tel-n', e.message, 'err'); }
}
$('pro-body').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.id === 'pf-save') proGuardar(); else if (b.id === 'pf-camp') proElegir(); else if (b.id === 'pf-fe' && b.tagName === 'BUTTON') proBuscarEmail(); else if (b.id === 'pf-ft') proBuscarTel();
});
$('pro-body').addEventListener('change', ev => {
  if (ev.target.id === 'pf-email') proDato('email', ev.target.value.trim());
  else if (ev.target.id === 'pf-tel') proDato('telefono', ev.target.value.trim());
});
$('pro-body').addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.target.id === 'pf-email' || ev.target.id === 'pf-tel')) ev.target.blur(); });
$('t-pro').onclick = () => mostrarPestana('prospecto');
// LinkedIn cambia de perfil sin recargar la página: el lanzador avisa; además se comprueba cada pocos segundos
window.addEventListener('message', ev => { if (ev.data && ev.data.flowUrl) refrescarPerfil(); });
try { parent.postMessage({ flowListo: true }, '*'); } catch (_) {}
setInterval(() => { if (document.visibilityState === 'visible') refrescarPerfil(); }, 3000);
refrescarPerfil(true);
