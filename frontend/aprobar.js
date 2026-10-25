// Página pública: el cliente revisa las piezas y las aprueba o pide cambios, sin iniciar sesión.
(function () {
  const API = /^(localhost|127\.)/.test(location.hostname) ? 'http://localhost:3000/api' : 'https://api.novacentrax.com/api';
  const token = (location.pathname.split('/').filter(Boolean).pop() || '').replace(/[^a-f0-9]/gi, '');
  const $ = id => document.getElementById(id);
  const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const RED = { instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn', facebook: 'Facebook', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads', blog: 'Blog', otra: 'Otra' };
  const FMT = { post: 'Post', carrusel: 'Carrusel', reel: 'Reel', story: 'Story', video: 'Video', articulo: 'Artículo', hilo: 'Hilo', otro: 'Otro' };
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  let D = null; const sel = {};
  const nombre = () => { try { return localStorage.getItem('apr_nombre') || ''; } catch (_) { return ''; } };
  function fecha(s) { if (!s) return 'Sin fecha'; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return d.getDate() + ' ' + MES[d.getMonth()] + ' ' + d.getFullYear(); }

  function card(p) {
    const redes = p.redes || [], r = sel[p.id] || redes[0] || '', txt = (p.copy || {})[r] || '';
    const m = p.media || [];
    const media = m.length ? `<div class="media m${Math.min(m.length, 4)}">${m.slice(0, 4).map(x => x.tipo === 'imagen' ? `<img src="${e(x.url)}" alt="" loading="lazy">` : x.tipo === 'video' ? `<video src="${e(x.url)}" controls playsinline preload="metadata"></video>` : `<a class="doc" href="${e(x.url)}" target="_blank" rel="noopener">Abrir ${e(x.nombre)}</a>`).join('')}</div>` : '';
    const estado = p.aprob_estado === 'aprobado' ? '<div class="st ok">Aprobada. Gracias.</div>' : p.aprob_estado === 'cambios' ? `<div class="st bad">Pediste cambios${p.aprob_nota ? ': ' + e(p.aprob_nota) : ''}. Los revisaremos y te avisaremos.</div>` : '';
    const cm = (p.comentarios || []).length ? `<div class="cm">${p.comentarios.map(c => `<div><b>${e(c.autor)}</b> <small>${e(new Date(c.created_at).toLocaleDateString('es-PE'))}</small><br>${e(c.texto)}</div>`).join('')}</div>` : '';
    const cerrada = p.aprob_estado === 'aprobado';
    return `<article class="card" id="p${p.id}">
      <div class="card__h"><b>${e(p.titulo)}</b><div class="meta"><span class="tag">${e(FMT[p.formato] || p.formato)}</span><span>${e(fecha(p.fecha_plan))}${p.hora_plan ? ' · ' + e(p.hora_plan) : ''}</span></div></div>
      ${redes.length > 1 ? `<div class="tabs">${redes.map(x => `<button class="${x === r ? 'on' : ''}" onclick="APR.red(${p.id},'${x}')">${e(RED[x] || x)}</button>`).join('')}</div>` : (redes[0] ? `<div class="sub">${e(RED[redes[0]] || redes[0])}</div>` : '')}
      ${media}<div class="txt">${e(txt) || '<span style="color:#98A39D">Sin texto para esta red.</span>'}${p.hashtags ? `<div class="h">${e(p.hashtags)}</div>` : ''}</div>
      ${p.primer_comentario ? `<div class="sub">Primer comentario: ${e(p.primer_comentario)}</div>` : ''}${estado}${cm}
      ${cerrada ? '' : `<div class="acts"><button class="btn ok" onclick="APR.ok(${p.id},this)">Aprobar</button><button class="btn no" onclick="APR.cambiar(${p.id})">Pedir cambios</button>
        <div class="chg" id="chg${p.id}"><textarea id="n${p.id}" placeholder="Cuéntanos qué cambiarías: texto, imagen, fecha…"></textarea><button class="btn ok" onclick="APR.enviar(${p.id},this)">Enviar cambios</button></div></div>`}
    </article>`;
  }
  function paint() {
    $('t').textContent = D.titulo || 'Contenido para aprobar'; $('s').textContent = D.cliente ? 'Para ' + D.cliente : '';
    const pend = D.pieces.filter(p => p.aprob_estado !== 'aprobado').length;
    $('m').innerHTML = `<div class="who"><span>Tu nombre:</span><input id="nom" value="${e(nombre())}" placeholder="Para saber quién respondió" oninput="try{localStorage.setItem('apr_nombre',this.value)}catch(_){}"></div>
      ${D.pieces.map(card).join('') || '<div class="err">No hay piezas en este envío.</div>'}
      <div class="done">${pend ? pend + ' pieza(s) por revisar.' : 'Todo revisado. Gracias.'}</div>`;
  }
  async function send(pid, body) {
    const r = await fetch(`${API}/content/public/${token}/${pid}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ nombre: ($('nom') || {}).value || '' }, body)) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'No se pudo enviar');
  }
  async function reload() { const r = await fetch(`${API}/content/public/${token}`); if (r.ok) { D = await r.json(); paint(); } }
  window.APR = {
    red(id, r) { sel[id] = r; paint(); },
    cambiar(id) { const c = $('chg' + id); c.style.display = c.style.display === 'block' ? 'none' : 'block'; const t = $('n' + id); if (t) t.focus(); },
    async ok(id, b) { b.disabled = true; try { await send(id, { decision: 'aprobado' }); await reload(); } catch (x) { alert(x.message); b.disabled = false; } },
    async enviar(id, b) { const n = ($('n' + id).value || '').trim(); if (!n) { $('n' + id).focus(); return; } b.disabled = true; try { await send(id, { decision: 'cambios', nota: n }); await reload(); } catch (x) { alert(x.message); b.disabled = false; } },
  };
  (async () => {
    if (!token) { $('m').innerHTML = '<div class="err">Enlace no válido.</div>'; return; }
    try { const r = await fetch(`${API}/content/public/${token}`); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Este enlace ya no está disponible.'); D = d; paint(); }
    catch (x) { $('t').textContent = 'Enlace no disponible'; $('m').innerHTML = `<div class="err">${e(x.message)}</div>`; }
  })();
})();
