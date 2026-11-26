// Acceso de FLOW (se muestra sobre la página de LinkedIn y dentro del panel lateral). La contraseña solo viaja a Nova; no se guarda aquí.
const $ = id => document.getElementById(id);
const msg = (cmd, datos) => new Promise(res => { try { chrome.runtime.sendMessage({ cmd, datos }, r => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || {}))); } catch (e) { res({ error: String(e) }); } });
const APP = 'https://app.novacentrax.com/', PEDIR = 'https://calendly.com/novacentrax/30min';
let poll = 0;
const cerrar = ok => { clearInterval(poll); try { parent.postMessage({ flowLogin: true, ok: !!ok }, '*'); } catch (_) {} };
const ok = () => { const v = /.+@.+\..+/.test($('lg-email').value.trim()) && $('lg-pass').value.length > 0; $('lg-go').disabled = !v; $('lg-go').className = 'lgo' + (v ? ' on' : ''); };
const aviso = (t, bueno) => { const e = $('lg-err'); e.textContent = t; e.style.color = bueno ? '#12805C' : ''; };
// si la sesión de Nova se abre en otra pestaña (Google, Nova…), entra sola
const vigilar = () => { clearInterval(poll); poll = setInterval(async () => { const r = await msg('par_estado'); if (r && r.nova === 'ok') cerrar(true); }, 3000); };
vigilar();
$('lg-email').oninput = ok; $('lg-pass').oninput = ok;
$('lg-eye').onclick = () => { const p = $('lg-pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
$('lg-x').onclick = () => cerrar(false);
$('lg-google').onclick = async () => { aviso(''); const r = await msg('nova_google'); if (r && r.error) aviso(r.error); else aviso('Termina el acceso con Google en la pestaña que se abrió…', true); };
$('lg-ms').onclick = () => aviso('El acceso con Microsoft aún no está disponible en Nova. Usa tu correo o Google.');
$('lg-sso').onclick = () => aviso('El acceso con la organización (SSO) aún no está disponible en Nova. Usa tu correo o Google.');
$('lg-crear').onclick = () => { try { chrome.tabs.create({ url: PEDIR }); } catch (_) { window.open(PEDIR, '_blank'); } };
$('lg-forgot').onclick = async () => {
  const email = $('lg-email').value.trim();
  if (!/.+@.+\..+/.test(email)) { aviso('Escribe tu correo arriba y vuelve a pulsar «¿Olvidaste la contraseña?».'); $('lg-email').focus(); return; }
  aviso('Enviando…', true);
  const r = await msg('nova_forgot', { email });
  aviso(r && r.error ? r.error : 'Si ese correo tiene acceso, te enviamos un enlace para crear la contraseña.', !(r && r.error));
};
$('lg-form').onsubmit = async ev => {
  ev.preventDefault();
  const b = $('lg-go'); b.disabled = true; b.textContent = 'Entrando…'; aviso('');
  const r = await msg('nova_login', { email: $('lg-email').value.trim(), password: $('lg-pass').value });
  $('lg-pass').value = ''; b.textContent = 'Inicia sesión'; ok();
  if (!r || r.error || !r.ok) { aviso((r && r.error) || 'No se pudo iniciar sesión'); return; }
  cerrar(true);
};
