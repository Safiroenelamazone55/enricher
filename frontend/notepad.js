'use strict';
// Paneles de la barra superior (Bloc de notas, Horario de prospección, Slack/WhatsApp/alertas): solo uno abierto a la vez.
window._novaCloseTopPanels = window._novaCloseTopPanels || function (except) {
  const P = { notas: () => (typeof NotepadModule !== 'undefined' ? NotepadModule : null), reloj: () => (typeof WorldClockModule !== 'undefined' ? WorldClockModule : null), chat: () => (typeof RChatPanel !== 'undefined' ? RChatPanel : null) };
  Object.keys(P).forEach(k => { if (k === except) return; try { const m = P[k](); if (m && m.isOpen && m.isOpen()) m.close(); } catch (_) {} });
};
// Bloc de notas (barra superior): panel flotante con notas personales. Lista con búsqueda, acciones al pasar el mouse
// (editar · crear tarea · descargar · archivar · eliminar) y editor con autoguardado.
const NotepadModule = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const I = (d, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICO = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>', plus: '<path d="M12 5v14M5 12h14"/>', back: '<path d="M15 18l-6-6 6-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    task: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    dl: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9.5 14.5L12 17l2.5-2.5"/>',
    arch: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    del: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', check: '<polyline points="20 6 9 17 4 12"/>',
    pad: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v2h6V3M9 10h6M9 14h6"/>',
  };
  let notes = [], view = 'list', q = '', searching = false, showArch = false, recent = true, cur = null, wide = false, loaded = false, menu = '', timer = null, projects = null;

  const lines = n => String(n.cuerpo || '').split('\n').map(x => x.trim()).filter(Boolean);
  const titleOf = n => (lines(n)[0] || 'Nota sin título').slice(0, 90);
  const subOf = n => (lines(n)[1] || '').slice(0, 110);
  const toast = (m, t) => { try { if (typeof showBanner === 'function') showBanner(m, t || 'success'); } catch (_) {} };
  const find = id => notes.find(n => n.id === id);

  async function load() {
    try {
      const r = await apiFetch(`${API}/notes`); if (r.ok) notes = await r.json();
      // notas del panel anterior (guardadas solo en este navegador): se pasan a la cuenta una sola vez
      let old = []; try { old = JSON.parse(localStorage.getItem('kiwoc_notes_v1') || '[]'); } catch (_) {}
      if (Array.isArray(old) && old.length) {
        for (const o of old.slice().reverse()) {
          if (!o || !o.text) continue;
          const pr = await apiFetch(`${API}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuerpo: o.text, created_at: o.created_at }) });
          if (pr.ok) notes.push(await pr.json());
        }
        try { localStorage.removeItem('kiwoc_notes_v1'); } catch (_) {}
        notes.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      }
    } catch (_) {}
    loaded = true; paint();
  }

  function ensure() {
    if ($('npd')) return $('npd');
    const d = document.createElement('div'); d.id = 'npd'; d.className = 'npd'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Bloc de notas');
    document.body.appendChild(d);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('npd') && !$('npd').classList.contains('hidden') && !(e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) close(); });
    document.addEventListener('mousedown', e => { if (menu && e.target && e.target.closest && !e.target.closest('.npd__menu,[data-npd-menu]')) { menu = ''; paint(); } });
    return d;
  }
  function isOpen() { const d = $('npd'); return !!d && !d.classList.contains('hidden'); }
  function open() { if (window._novaCloseTopPanels) window._novaCloseTopPanels('notas'); ensure().classList.remove('hidden'); document.getElementById('npd-btn')?.classList.add('on'); if (!loaded) { paint(); load(); } else paint(); }
  function close() { saveNow(); $('npd')?.classList.add('hidden'); document.getElementById('npd-btn')?.classList.remove('on'); }
  function toggle() { const d = $('npd'); if (d && !d.classList.contains('hidden')) close(); else open(); }

  function visible() {
    let a = notes.filter(n => !!n.archivada === showArch);
    if (q.trim()) { const k = q.trim().toLowerCase(); a = a.filter(n => String(n.cuerpo).toLowerCase().includes(k)); }
    return a.sort(recent ? (x, y) => new Date(y.updated_at) - new Date(x.updated_at) : (x, y) => new Date(x.created_at) - new Date(y.created_at));
  }

  function paint() {
    const d = ensure(); d.classList.toggle('npd--wide', wide);
    if (view === 'edit' && cur && find(cur)) return paintEdit(d, find(cur));
    view = 'list';
    const list = visible();
    const head = searching
      ? `<div class="npd__h"><span class="npd__si">${I(ICO.search, 15)}</span><input id="npd-q" class="npd__q" placeholder="Buscar" value="${esc(q)}" oninput="NotepadModule.search(this.value)"><button class="npd__ib" onclick="NotepadModule.searchOff()" title="Cerrar búsqueda">${I(ICO.x)}</button></div>`
      : `<div class="npd__h"><b>${showArch ? 'Notas archivadas' : 'Bloc de notas'}</b><span class="npd__sp"></span><button class="npd__ib" onclick="NotepadModule.searchOn()" title="Buscar">${I(ICO.search)}</button><button class="npd__ib" data-npd-menu onclick="NotepadModule.menuToggle('list')" title="Más opciones">${I(ICO.dots)}</button><button class="npd__ib" onclick="NotepadModule.close()" title="Cerrar">${I(ICO.x)}</button></div>`;
    const menuH = menu === 'list' ? `<div class="npd__menu"><button onclick="NotepadModule.toggleArch()">${I(ICO.arch, 15)}<span>${showArch ? 'Ocultar archivados' : 'Mostrar archivados'}</span></button><button onclick="NotepadModule.toggleRecent()"><span class="npd__upd">${I('<path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>', 15)}</span><span>Ordenar por recientes</span><i class="npd__sw${recent ? ' on' : ''}"></i></button></div>` : '';
    const rows = !loaded ? '<div class="npd__empty">Cargando…</div>' : list.length ? list.map(n => `<div class="npd__row" onclick="NotepadModule.edit(${n.id})">
        <div class="npd__t"><b>${esc(titleOf(n))}</b>${subOf(n) ? `<small>${esc(subOf(n))}</small>` : ''}</div>
        <div class="npd__acts" onclick="event.stopPropagation()">
          <button title="Editar" onclick="NotepadModule.edit(${n.id})">${I(ICO.edit, 15)}</button>
          <button title="${n.task_id ? 'Ya es una tarea' : 'Crear tarea'}" ${n.task_id ? 'class="done"' : ''} onclick="NotepadModule.taskForm(${n.id})">${I(n.task_id ? ICO.check : ICO.task, 15)}</button>
          <button title="Descargar" onclick="NotepadModule.download(${n.id})">${I(ICO.dl, 15)}</button>
          <button title="${n.archivada ? 'Desarchivar' : 'Archivar'}" onclick="NotepadModule.archive(${n.id})">${I(ICO.arch, 15)}</button>
          <button title="Eliminar" onclick="NotepadModule.remove(${n.id})">${I(ICO.del, 15)}</button>
        </div></div>`).join('')
      : `<div class="npd__empty">${q.trim() ? 'Ninguna nota coincide con tu búsqueda.' : showArch ? 'No tienes notas archivadas.' : 'Aún no tienes notas.<br>Crea la primera con «Nueva nota».'}</div>`;
    d.innerHTML = `${head}${menuH}<div class="npd__list">${rows}</div><button class="npd__new" onclick="NotepadModule.create()">${I(ICO.plus, 15)}<span>Nueva nota</span></button>${taskHtml()}`;
    if (searching) { const i = $('npd-q'); if (i && document.activeElement !== i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  function paintEdit(d, n) {
    const menuH = menu === 'edit' ? `<div class="npd__menu"><button onclick="NotepadModule.copy(${n.id})">${I(ICO.copy, 15)}<span>Copiar texto</span></button><button onclick="NotepadModule.archive(${n.id},true)">${I(ICO.arch, 15)}<span>${n.archivada ? 'Desarchivar' : 'Archivar'}</span></button><button class="danger" onclick="NotepadModule.remove(${n.id},true)">${I(ICO.del, 15)}<span>Eliminar</span></button></div>` : '';
    d.innerHTML = `<div class="npd__h"><button class="npd__ib" onclick="NotepadModule.back()" title="Volver">${I(ICO.back)}</button><b id="npd-title" class="npd__ttl">${esc(titleOf(n))}</b><span class="npd__sp"></span><button class="npd__ib" data-npd-menu onclick="NotepadModule.menuToggle('edit')" title="Más opciones">${I(ICO.dots)}</button><button class="npd__ib" onclick="NotepadModule.close()" title="Cerrar">${I(ICO.x)}</button></div>${menuH}
      <textarea id="npd-body" class="npd__body" placeholder="Escribe aquí…" spellcheck="true" oninput="NotepadModule.typing(${n.id},this.value)">${esc(n.cuerpo)}</textarea>
      <div class="npd__foot"><button title="${wide ? 'Reducir' : 'Ampliar'}" onclick="NotepadModule.wideToggle()">${I(ICO.expand, 15)}</button><button title="Imprimir" onclick="NotepadModule.print(${n.id})">${I(ICO.print, 15)}</button><button title="${n.task_id ? 'Ya es una tarea' : 'Crear tarea'}" ${n.task_id ? 'class="done"' : ''} onclick="NotepadModule.taskForm(${n.id})">${I(n.task_id ? ICO.check : ICO.task, 15)}</button><button title="Descargar" onclick="NotepadModule.download(${n.id})">${I(ICO.dl, 15)}</button></div>${taskHtml()}`;
    const t = $('npd-body'); if (t && !t._f) { t._f = 1; t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }

  // ── acciones ──
  function searchOn() { searching = true; paint(); }
  function searchOff() { searching = false; q = ''; paint(); }
  function search(v) { q = v; const l = document.querySelector('#npd .npd__list'); if (!l) return; const keep = searching; paint(); if (keep) { const i = $('npd-q'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } } }
  function menuToggle(k) { menu = menu === k ? '' : k; paint(); }
  function toggleArch() { showArch = !showArch; menu = ''; paint(); }
  function toggleRecent() { recent = !recent; paint(); }
  function wideToggle() { saveNow(); wide = !wide; paint(); }
  async function create() {
    try {
      const r = await apiFetch(`${API}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuerpo: '' }) });
      if (!r.ok) throw 0; const n = await r.json(); notes.unshift(n); showArch = false; searching = false; q = ''; cur = n.id; view = 'edit'; paint();
    } catch (_) { toast('No se pudo crear la nota', 'error'); }
  }
  function edit(id) { cur = id; view = 'edit'; menu = ''; paint(); }
  async function back() {
    await saveNow(); const n = find(cur);
    if (n && !String(n.cuerpo).trim() && !n.task_id) { await apiFetch(`${API}/notes/${n.id}`, { method: 'DELETE' }).catch(() => {}); notes = notes.filter(x => x.id !== n.id); }
    view = 'list'; cur = null; menu = ''; paint();
  }
  function typing(id, v) {
    const n = find(id); if (!n) return; n.cuerpo = v; n.updated_at = new Date().toISOString();
    const t = $('npd-title'); if (t) t.textContent = titleOf(n);
    clearTimeout(timer); timer = setTimeout(saveNow, 600);
  }
  async function saveNow() {
    clearTimeout(timer); timer = null; const n = cur && find(cur); if (!n || view !== 'edit') return;
    try { await apiFetch(`${API}/notes/${n.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuerpo: n.cuerpo }) }); } catch (_) {}
  }
  async function archive(id, fromEdit) {
    const n = find(id); if (!n) return; if (fromEdit) await saveNow();
    const r = await apiFetch(`${API}/notes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivada: !n.archivada }) });
    if (r.ok) { n.archivada = !n.archivada; toast(n.archivada ? 'Nota archivada' : 'Nota restaurada'); }
    if (fromEdit) { view = 'list'; cur = null; } menu = ''; paint();
  }
  async function remove(id, fromEdit) {
    if (!confirm('¿Eliminar esta nota? No se puede deshacer.')) return;
    await apiFetch(`${API}/notes/${id}`, { method: 'DELETE' }).catch(() => {});
    notes = notes.filter(n => n.id !== id); if (fromEdit) { view = 'list'; cur = null; } menu = ''; paint(); toast('Nota eliminada');
  }
  function copy(id) { const n = find(id); if (!n) return; try { navigator.clipboard.writeText(n.cuerpo || ''); toast('Texto copiado'); } catch (_) {} menu = ''; paint(); }
  function download(id) {
    const n = find(id); if (!n) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([n.cuerpo || ''], { type: 'text/plain;charset=utf-8' }));
    a.download = (titleOf(n).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'nota') + '.txt'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function print(id) {
    const n = find(id); if (!n) return; const w = window.open('', '_blank'); if (!w) return;
    w.document.write(`<title>${esc(titleOf(n))}</title><body style="font:15px/1.6 Inter,Segoe UI,sans-serif;padding:32px;white-space:pre-wrap">${esc(n.cuerpo)}</body>`); w.document.close(); w.focus(); w.print();
  }

  // ── crear tarea desde una nota ──
  let tf = null;
  async function taskForm(id) {
    const n = find(id); if (!n || n.task_id) return; if (view === 'edit') await saveNow();
    tf = { id, titulo: titleOf(n) === 'Nota sin título' ? '' : titleOf(n) }; paint();
    if (!projects) { try { const r = await apiFetch(`${API}/mgmt/projects`); projects = r.ok ? await r.json() : []; } catch (_) { projects = []; } }
    const s = $('npd-tf-proj'); if (s) s.innerHTML = '<option value="">Elige un proyecto</option>' + projects.filter(p => !p.archivado).map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
    $('npd-tf-t')?.focus();
  }
  function taskHtml() {
    if (!tf) return '';
    return `<div class="npd__ov" onclick="if(event.target===this)NotepadModule.taskCancel()"><div class="npd__tf"><b>Crear tarea desde la nota</b>
      <input id="npd-tf-t" type="text" maxlength="200" placeholder="Título de la tarea" value="${esc(tf.titulo)}">
      <select id="npd-tf-proj"><option value="">Elige un proyecto</option></select><input id="npd-tf-d" type="date">
      <div class="npd__tfb"><button class="npd__b" onclick="NotepadModule.taskCancel()">Cancelar</button><button class="npd__b npd__b--p" onclick="NotepadModule.taskSave()">Crear tarea</button></div></div></div>`;
  }
  function taskCancel() { tf = null; paint(); }
  async function taskSave() {
    const n = tf && find(tf.id); if (!n) return;
    const titulo = ($('npd-tf-t')?.value || '').trim(); if (!titulo) { $('npd-tf-t')?.focus(); return; }
    const pid = $('npd-tf-proj')?.value, dl = $('npd-tf-d')?.value || null;
    if (!pid) { $('npd-tf-proj')?.focus(); toast('Elige el proyecto de la tarea', 'error'); return; }
    try {
      const r = await apiFetch(`${API}/mgmt/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo, project_id: pid ? +pid : null, estado: 'pendiente', prioridad: 'media', responsable: '', deadline: dl, notas: n.cuerpo, monto: null, cobrado: false }) });
      if (!r.ok) throw 0; const t = await r.json();
      await apiFetch(`${API}/notes/${n.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: t.id || t.task?.id || null }) });
      n.task_id = t.id || (t.task && t.task.id) || -1; tf = null; paint(); toast('Tarea creada desde la nota');
      if (typeof TasksModule !== 'undefined' && TasksModule.load) TasksModule.load();
    } catch (_) { toast('No se pudo crear la tarea', 'error'); }
  }

  return { isOpen, toggle, open, close, load, searchOn, searchOff, search, menuToggle, toggleArch, toggleRecent, wideToggle, create, edit, back, typing, archive, remove, copy, download, print, taskForm, taskCancel, taskSave };
})();
