/* Variables {{...}} como chips en los editores de mensaje de Lead Manager (paso y plantilla).
   - Se pintan como una sola pieza (fondo celeste + texto azul) sobre el mismo textarea/input: el valor sigue siendo texto plano.
   - Borrar (Backspace/Supr) junto a una variable, o con parte de ella seleccionada, la quita entera, llaves incluidas.
   - Las flechas saltan la variable completa; con el mouse el cursor nunca queda dentro.
   - Al escribir «{{» (o «{{nom») se despliega, justo debajo, la lista de variables parecidas. Enter/Tab o clic la inserta. */
(function () {
  'use strict';
  const SEL = 'textarea.step-var-ta, input.step-var-asunto, #tpl-cuerpo, #tpl-asunto, #step-asu-only';
  const TOK = /\{\{[^{}\n]*\}\}/g;
  const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'wordSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'textAlign'];
  const reg = new Set();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function tokens(v) { const a = []; let m; TOK.lastIndex = 0; while ((m = TOK.exec(v))) a.push([m.index, m.index + m[0].length]); return a; }
  function varList() { try { return (window.__lmVarList ? window.__lmVarList() : []) || []; } catch (e) { return []; } }
  function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }

  function attach(el) {
    if (el._vc || !el.parentNode) return;
    el._vc = true;
    const multi = el.tagName === 'TEXTAREA';
    const cs0 = getComputedStyle(el);
    const wrap = document.createElement('div');
    wrap.className = 'vc-wrap' + (multi ? '' : ' vc-wrap--line');
    wrap.style.background = cs0.backgroundColor;
    wrap.style.borderRadius = cs0.borderRadius;
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    const back = document.createElement('div'); back.className = 'vc-back'; back.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(back, el);
    const menu = document.createElement('div'); menu.className = 'vc-menu'; wrap.appendChild(menu);
    el.classList.add('vc-ta');
    const st = { open: false, items: [], idx: 0, from: 0 };
    reg.add(el);

    function styleSync() {
      const cs = getComputedStyle(el);
      COPY.forEach(k => { back.style[k] = cs[k]; });
      back.style.borderStyle = 'solid'; back.style.borderColor = 'transparent';
      if (multi) {
        const bl = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        const sb = Math.max(0, el.offsetWidth - el.clientWidth - bl);
        back.style.paddingRight = ((parseFloat(cs.paddingRight) || 0) + sb) + 'px';
      }
      el._vcw = el.offsetWidth;
    }
    function render() {
      const v = el.value; el._vcv = v;
      if (el._vcw !== el.offsetWidth) styleSync();
      const caret = st.open ? el.selectionStart : -1;
      let out = '', last = 0;
      const put = (a, b) => { let seg = esc(v.slice(a, b)); return seg; };
      const T = tokens(v);
      const cuts = [];
      T.forEach(([x, y]) => cuts.push([x, y]));
      let i = 0;
      const emit = (a, b, isTok) => {
        if (b <= a) return;
        if (caret >= a && caret <= b && !isTok) { out += put(a, caret) + '<span class="vc-caret"></span>' + put(caret, b); return; }
        out += isTok ? '<mark class="vc-tok">' + put(a, b) + '</mark>' : put(a, b);
      };
      cuts.forEach(([x, y]) => { emit(last, x, false); emit(x, y, true); last = y; });
      emit(last, v.length, false);
      if (caret >= 0 && caret === v.length && !out.includes('vc-caret')) out += '<span class="vc-caret"></span>';
      back.innerHTML = out + (multi ? '​' : '');
      back.scrollTop = el.scrollTop; back.scrollLeft = el.scrollLeft;
    }
    el._vcRender = render;
    styleSync(); render();

    function closeMenu() { st.open = false; menu.style.display = 'none'; }
    function openMenu() {
      menu.innerHTML = st.items.map((it, n) => `<div class="vc-it${n === st.idx ? ' on' : ''}" data-n="${n}"><span>${esc(it[1])}</span><code>{{${esc(it[0])}}}</code></div>`).join('');
      menu.style.display = 'block'; st.open = true;
      render();
      const c = back.querySelector('.vc-caret');
      if (c) {
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        const left = Math.min(Math.max(0, c.offsetLeft), Math.max(0, wrap.clientWidth - menu.offsetWidth - 4));
        menu.style.left = left + 'px'; menu.style.top = (c.offsetTop - el.scrollTop + lh + 6) + 'px';
      }
    }
    function refreshMenu() {
      if (el.selectionStart !== el.selectionEnd) return closeMenu();
      const pos = el.selectionStart, before = el.value.slice(0, pos);
      const m = /\{\{([\wáéíóúñÁÉÍÓÚÑ ]*)$/.exec(before);
      if (!m) return closeMenu();
      const q = norm(m[1]).trim();
      st.items = varList().filter(it => !q || norm(it[0] + ' ' + it[1]).includes(q)).slice(0, 8);
      if (!st.items.length) return closeMenu();
      st.from = m.index; st.idx = Math.min(st.idx, st.items.length - 1);
      openMenu();
    }
    function pick(n) {
      const it = st.items[n]; if (!it) return;
      const ins = '{{' + it[0] + '}}';
      const end = el.selectionStart;
      // si ya hay «}}» justo después del cursor (porque se escribió el cierre), se absorbe
      const tail = el.value.slice(end, end + 2) === '}}' ? 2 : 0;
      el.setRangeText(ins, st.from, end + tail, 'end');
      closeMenu(); fire(el); render(); el.focus();
    }
    menu.addEventListener('mousedown', e => { e.preventDefault(); const d = e.target.closest('.vc-it'); if (d) pick(+d.dataset.n); });

    el.addEventListener('input', () => { render(); refreshMenu(); });
    el.addEventListener('scroll', () => { back.scrollTop = el.scrollTop; back.scrollLeft = el.scrollLeft; });
    el.addEventListener('blur', () => setTimeout(closeMenu, 120));
    el.addEventListener('keydown', e => {
      if (st.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); st.idx = (st.idx + 1) % st.items.length; return openMenu(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); st.idx = (st.idx - 1 + st.items.length) % st.items.length; return openMenu(); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(st.idx); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeMenu(); }
      }
      const s = el.selectionStart, en = el.selectionEnd, T = tokens(el.value);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        let a = s, b = en;
        if (s === en) {
          const t = T.find(([x, y]) => e.key === 'Backspace' ? (s > x && s <= y) : (s >= x && s < y));
          if (!t) return; a = t[0]; b = t[1];
        } else {
          T.forEach(([x, y]) => { if (a > x && a < y) a = x; if (b > x && b < y) b = y; });
          if (a === s && b === en) return;
        }
        e.preventDefault(); el.setRangeText('', a, b, 'end'); fire(el); render(); return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey && !e.metaKey && s === en) {
        const t = e.key === 'ArrowLeft' ? T.find(([x, y]) => s === y) : T.find(([x, y]) => s === x);
        if (t) { e.preventDefault(); const p = e.key === 'ArrowLeft' ? t[0] : t[1]; el.setSelectionRange(p, p); closeMenu(); }
      }
    });
    function snap() {
      if (el.selectionStart !== el.selectionEnd) return;
      const s = el.selectionStart, t = tokens(el.value).find(([x, y]) => s > x && s < y);
      if (t) { const p = (s - t[0]) < (t[1] - s) ? t[0] : t[1]; el.setSelectionRange(p, p); }
    }
    el.addEventListener('mouseup', () => setTimeout(snap, 0));
    el.addEventListener('focus', () => setTimeout(snap, 0));
    el.addEventListener('click', () => closeMenu());
  }

  function scan(root) { if (root.querySelectorAll) { if (root.matches && root.matches(SEL)) attach(root); root.querySelectorAll(SEL).forEach(attach); } }
  function start() {
    scan(document.body);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) scan(n); }))).observe(document.body, { childList: true, subtree: true });
    // el valor lo cambian también otras funciones (insertar variable, usar plantilla…): se repinta si cambió
    setInterval(() => { reg.forEach(el => { if (!el.isConnected) { reg.delete(el); return; } if (el._vcv !== el.value && el._vcRender) el._vcRender(); }); }, 150);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
