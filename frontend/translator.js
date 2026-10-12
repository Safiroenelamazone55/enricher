/* Traductor integrado: icono junto a los editores de mensaje (WhatsApp, paso de secuencia, plantilla).
   Un clic traduce el texto escrito al idioma sugerido; la flechita elige otro idioma. Ctrl+Z deshace la traducción.
   Motor: POST /api/translate (backend → Cloudflare Workers AI, cuota gratuita). Las variables {{…}} no se tocan. */
(function () {
  'use strict';
  const LANGS = [['en', 'Inglés'], ['es', 'Español'], ['pt', 'Portugués'], ['fr', 'Francés'], ['de', 'Alemán'], ['it', 'Italiano']];
  const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
  const STOP = {
    en: 'the and you your with that this for are have will would could can please thanks hi hello just from about what when how our they not but was were been'.split(' '),
    es: 'el la los las que de y en un una por con para como pero más muy hola gracias favor puedes puede está estoy tengo mensaje nuestro sobre cuando donde'.split(' '),
    pt: 'o os as que de e em um uma por com para como mas mais muito olá obrigado obrigada você está estou tenho nosso sobre quando onde não'.split(' '),
    fr: 'le les des une est dans pour avec vous nous que qui pas bonjour merci mais très être avoir notre sur quand'.split(' '),
    de: 'der die das und ist nicht mit für ein eine sie wir ich bitte danke hallo aber sehr auf von wenn wie'.split(' '),
    it: 'il lo la gli che di e un una per con come ma più molto ciao grazie sono questo nostro quando dove non',
  };
  STOP.it = STOP.it.split(' ');
  function guess(text) {
    const w = String(text || '').toLowerCase().normalize('NFC').match(/[a-záéíóúñãõçàâêôüäöß]+/g) || [];
    if (w.length < 3) return null;
    let best = null, bs = 0;
    Object.keys(STOP).forEach(l => { const set = new Set(STOP[l]); const s = w.reduce((n, x) => n + (set.has(x) ? 1 : 0), 0); if (s > bs) { bs = s; best = l; } });
    return bs >= 2 ? best : null;
  }
  const pref = (ctx, v) => { try { if (v) localStorage.setItem('tr_target_' + ctx, v); else return localStorage.getItem('tr_target_' + ctx); } catch (e) { /* sin almacenamiento */ } return null; };
  const toast = (m, t) => { try { if (typeof showBanner === 'function') showBanner(m, t || 'info'); } catch (e) { /* sin aviso */ } };

  function kindFor(el) {
    if (el.id === 'qwa-input' || el.id === 'ocwa-input') return 'whatsapp';
    if (el.tagName === 'INPUT' || el.id === 'tpl-asunto') return 'subject';
    const cn = document.getElementById('step-canal'); const canal = cn && cn.value;
    if (canal === 'linkedin') return 'linkedin';
    if (canal === 'whatsapp') return 'whatsapp';
    return 'email';
  }
  function suggest(el, ctx) {
    const mine = guess(el.value);
    let chat = null;
    const box = el.id === 'qwa-input' ? document.getElementById('qwa-messages') : el.id === 'ocwa-input' ? document.getElementById('ocwa-messages') : null;
    if (box) {
      const txt = [...box.querySelectorAll('.wa-msg--in .wa-msg__bubble')].slice(-8).map(b => b.textContent).join(' ');
      chat = guess(txt);
    }
    if (chat && chat !== mine) return chat;
    const saved = pref(ctx);
    if (saved && saved !== mine) return saved;
    return mine === 'en' ? 'es' : 'en';
  }

  async function run(el, target, btn, ctx) {
    const text = el.value;
    if (!text.trim()) return toast('Escribe primero el texto que quieres traducir', 'info');
    btn.classList.add('tr-busy'); btn.disabled = true;
    try {
      const r = await apiFetch(`${API}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, target, kind: kindFor(el) }) });
      const j = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) throw new Error(j.error || 'No se pudo traducir');
      pref(ctx, target);
      el.focus(); el.select();
      // insertText conserva el historial nativo: Ctrl+Z devuelve el texto original
      if (!document.execCommand || !document.execCommand('insertText', false, j.text)) { el.value = j.text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      toast('Traducido al ' + (LANGS.find(l => l[0] === target) || [0, target])[1].toLowerCase() + ' · Ctrl+Z para deshacer', 'success');
    } catch (e) { toast(e.message || 'No se pudo traducir', 'error'); }
    btn.classList.remove('tr-busy'); btn.disabled = false;
    refresh(el, btn, ctx);
  }
  function refresh(el, btn, ctx) {
    const t = suggest(el, ctx); btn._t = t;
    const lbl = (LANGS.find(l => l[0] === t) || [0, t])[1];
    btn.title = 'Traducir al ' + lbl.toLowerCase();
    const b = btn.querySelector('.tr-code'); if (b) b.textContent = t.toUpperCase();
  }
  function menu(el, btn, ctx) {
    document.querySelectorAll('.tr-menu').forEach(m => m.remove());
    const m = document.createElement('div'); m.className = 'tr-menu';
    m.innerHTML = '<div class="tr-menu__h">Traducir a…</div>' + LANGS.map(l => `<div class="tr-it${l[0] === btn._t ? ' on' : ''}" data-l="${l[0]}">${l[1]}</div>`).join('');
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 170)) + 'px';
    m.style.top = (r.top - m.offsetHeight - 6 < 8 ? r.bottom + 6 : r.top - m.offsetHeight - 6) + 'px';
    const close = () => { m.remove(); document.removeEventListener('mousedown', away, true); };
    const away = e => { if (!m.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    m.addEventListener('click', e => { const d = e.target.closest('.tr-it'); if (!d) return; close(); run(el, d.dataset.l, btn, ctx); });
  }
  function mk(el, ctx) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'tr-btn';
    btn.innerHTML = ICON + '<span class="tr-code"></span>';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => run(el, btn._t, btn, ctx));
    btn.addEventListener('contextmenu', e => { e.preventDefault(); menu(el, btn, ctx); });
    const car = document.createElement('button'); car.type = 'button'; car.className = 'tr-car'; car.title = 'Elegir idioma'; car.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    car.addEventListener('mousedown', e => e.preventDefault());
    car.addEventListener('click', () => menu(el, btn, ctx));
    const g = document.createElement('span'); g.className = 'tr-grp'; g.appendChild(btn); g.appendChild(car);
    el.addEventListener('focus', () => refresh(el, btn, ctx));
    refresh(el, btn, ctx);
    return g;
  }

  function attachWa(el) {
    if (el._tr) return; el._tr = true;
    const g = mk(el, 'wa'); g.classList.add('tr-grp--wa');
    el.insertAdjacentElement('afterend', g);
  }
  function attachField(el) {
    if (el._tr) return; el._tr = true;
    const wrap = el.closest('.vc-wrap'); if (!wrap) { el._tr = false; return; }
    const g = mk(el, el.tagName === 'INPUT' || el.id === 'tpl-asunto' ? 'subj' : 'body'); g.classList.add('tr-grp--field');
    wrap.appendChild(g);
  }
  function scan(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('#qwa-input, #ocwa-input').forEach(attachWa);
    root.querySelectorAll('.vc-ta').forEach(attachField);
  }
  function start() {
    scan(document.body);
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
