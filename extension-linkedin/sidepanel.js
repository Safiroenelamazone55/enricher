const $ = id => document.getElementById(id);
async function pintar() {
  const { token, paused, estado } = await chrome.storage.local.get({ token: '', paused: true, estado: {} });
  $('pill').textContent = paused ? 'En pausa' : 'Activa'; $('pill').className = 'pill ' + (paused ? 'off' : 'on');
  $('toggle').textContent = paused ? 'Activar' : 'Pausar';
  const e = estado.msg ? estado : { msg: token ? 'Listo.' : 'Pega el token de la cuenta para empezar.', nivel: token ? 'ok' : 'warn' };
  $('st').textContent = e.msg + (e.t ? ' · ' + new Date(e.t).toLocaleTimeString() : '') + (e.slug ? '  ·  Cuenta de LinkedIn en este Chrome: ' + e.slug : ''); $('st').className = 'st ' + (e.nivel || '');
  if (token && !$('tok').value) $('tok').placeholder = 'Token guardado (' + token.slice(0, 9) + '…)';
}
$('save').onclick = async () => {
  const v = $('tok').value.trim();
  if (!/^nvli_[a-f0-9]+$/i.test(v)) { $('st').textContent = 'El token debe empezar por nvli_'; return; }
  await chrome.storage.local.set({ token: v, paused: true, estado: {} }); $('tok').value = ''; pintar();
};
$('toggle').onclick = async () => {
  const { paused } = await chrome.storage.local.get({ paused: true });
  await chrome.storage.local.set({ paused: !paused }); pintar();
  if (paused) chrome.runtime.sendMessage({ cmd: 'tick' });
};
$('now').onclick = () => chrome.runtime.sendMessage({ cmd: 'tick' }).then(pintar);
chrome.storage.onChanged.addListener(pintar); pintar();
