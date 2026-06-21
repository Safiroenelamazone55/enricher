'use strict';
console.log('[Enricher] app.js v2026-05-28-B loaded');

/**
 * app.js — B2B Email Enricher Frontend
 * Vanilla JS · no framework
 */

const API = 'https://api.kiwoc.com/api';

// ── Helpers ──────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function showAlert(el, msg, type = 'err') {
  el.className = `alert alert--${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAlert(el) { el.classList.add('hidden'); }

function setBtn(btn, loading) {
  btn.disabled = loading;
  const text = btn.querySelector('.btn__text');
  const spin = btn.querySelector('.spin');
  if (text) text.classList.toggle('hidden', loading);
  if (spin) spin.classList.toggle('hidden', !loading);
}

function scoreColor(s) {
  return s >= 75 ? '#16a34a' : s >= 55 ? '#d97706' : s >= 35 ? '#dc2626' : '#9ca3af';
}

function renderScoreBar(score) {
  const c = scoreColor(score);
  return `<div class="score-wrap">
    <span class="score-n" style="color:${c}">${score}</span>
    <div class="score-b"><div class="score-b__f" style="width:${score}%;background:${c}"></div></div>
  </div>`;
}

/**
 * Returns an HTML badge for a confidence value.
 */
function confBadge(c) {
  const map = {
    'guaranteed':   { cls: 'guaranteed', label: 'Verificado ✓' },
    'very-high':    { cls: 'vh',         label: 'Verificación alta' },
    'high':         { cls: 'h',          label: 'Alta probabilidad' },
    'medium':       { cls: 'm',          label: 'Probable (revisar)' },
    'low':          { cls: 'l',          label: 'Baja certeza' },
    'pending':      { cls: 'pending',    label: 'Pendiente…' },
    'unverifiable': { cls: 'unverifiable', label: 'No verificable' },
    'very-low':     { cls: 'vl',         label: 'Muy baja' },
    'none':         { cls: 'vl',         label: 'Sin datos' },
  };
  const entry = map[c] ?? { cls: 'vl', label: c ?? '—' };
  return `<span class="badge badge--${entry.cls}">${entry.label}</span>`;
}

/**
 * Small pill showing where the email was found.
 */
function sourcePill(source) {
  if (!source || source === 'inferred') return '';
  const icons = {
    'smtp':    '📡 SMTP',
    'bounce':  '📧 Correo real',
    'scraped': '🔍 Web',
    'github':  '🐙 GitHub',
  };
  const label = icons[source] ?? source;
  return `<span class="source-pill">${label}</span>`;
}

/**
 * Catch-all warning icon with CSS tooltip.
 */
function catchAllWarn() {
  return `<span class="warn-icon">⚠️
    <span class="tip">El dominio acepta cualquier correo —<br>no se puede verificar completamente.</span>
  </span>`;
}

// =================================================================
// AUTHENTICATION
// =================================================================

/**
 * Fetch wrapper that always sends cookies.
 * Use instead of bare fetch() for all API calls.
 */
function apiFetch(url, opts = {}) {
  return fetch(url, { credentials: 'include', ...opts });
}

function applyBranding({ companyName, companyLogo, workspaceName } = {}) {
  const wsTag      = $('ws-name-tag');
  const nameEl     = $('brand-company-name');
  const iconWrap   = $('brand-icon-wrap');

  if (wsTag && workspaceName) wsTag.textContent = workspaceName;

  if (nameEl) nameEl.textContent = companyName || 'Nova';

  if (iconWrap) {
    if (companyLogo) {
      iconWrap.innerHTML = `<img src="${companyLogo}" style="max-width:calc(100% - 20px);max-height:calc(100% - 20px);width:auto;height:auto;object-fit:contain;display:block;" onerror="this.parentElement.innerHTML='<svg width=68 height=68 viewBox=&quot;0 0 100 100&quot; fill=none><path d=&quot;M50 3 L63 38 L97 50 L63 62 L50 97 L37 62 L3 50 L37 38 Z&quot; fill=&quot;currentColor&quot;/></svg>'">`;
    } else {
      iconWrap.innerHTML = `<svg width="68" height="68" viewBox="0 0 100 100" fill="none"><path d="M50 3 L63 38 L97 50 L63 62 L50 97 L37 62 L3 50 L37 38 Z" fill="currentColor"/></svg>`;
    }
  }
}

/**
 * On page load: call /api/auth/me to determine login state.
 * Shows either the auth wall or the full app.
 */
async function initAuth() {
  const authBar  = $('authBar');
  const authWall = $('authWall');
  const appShell = $('appShell');

  // Detect ?join=TOKEN or ?gcal= in the URL before the auth check
  const urlParams  = new URLSearchParams(window.location.search);
  const joinToken  = urlParams.get('join');
  const gcalParam  = urlParams.get('gcal');
  if (joinToken || gcalParam) history.replaceState(null, '', window.location.pathname);
  if (gcalParam === 'ok')    setTimeout(() => showBanner('✓ Google Calendar conectado — tus eventos aparecerán en el calendario', 'success'), 1200);
  if (gcalParam === 'error') setTimeout(() => showBanner('No se pudo conectar Google Calendar. Inténtalo de nuevo.', 'error'), 800);

  try {
    const res  = await apiFetch(`${API}/auth/me`);
    const data = await res.json();

    if (data.loggedIn) {
      // ── If there's a pending join token, process it first ──
      if (joinToken && !data.workspace_id) {
        try {
          await apiFetch(`${API}/workspace/accept-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: joinToken }),
          });
          // Reload so session reflects the new workspace membership
          location.reload();
          return;
        } catch (_) { /* ignore — fall through to normal load */ }
      }

      // ── Apply workspace branding to sidebar ───────────────
      applyBranding(data);

      // ── Make brand clickable for owners ───────────────────
      if (data.isOwner) {
        const brand = $('sidebar-brand');
        if (brand) {
          brand.style.cursor = 'pointer';
          brand.onclick = () => WorkspaceModule.openNameModal();
        }
        const invBtn = $('invite-btn');
        if (invBtn) invBtn.style.display = '';
      }

      // ── Store auth info globally for modules to read ────────
      window._authUser = data;

      authBar.innerHTML = `
        <div class="auth-user" style="cursor:${data.isOwner ? 'pointer' : 'default'}" ${data.isOwner ? 'onclick="WorkspaceModule.openNameModal()" title="Cambiar nombre del workspace"' : ''}>
          <img src="${data.avatar || `https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(data.name || data.email || 'user')}`}" alt="" class="auth-user__avatar"/>
          <div style="flex:1;min-width:0">
            <div class="auth-user__name">${esc(data.name || data.email)}</div>
            ${!data.isOwner ? `<div style="font-size:.68rem;color:#A8A29E">Miembro</div>` : ''}
          </div>
          <a href="${API}/auth/logout" class="btn btn--ghost btn--sm" id="btnLogout" onclick="event.stopPropagation()">Salir</a>
        </div>`;

      const logoutBtn = $('btnLogout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async e => {
          e.preventDefault();
          await apiFetch(`${API}/auth/logout`);
          location.reload();
        });
      }

      authWall.classList.add('hidden');
      appShell.classList.remove('hidden');
      initApp();
      await FxRatesModule.load();
      DashboardModule.load();
      ChatModule.init();
      TimerModule.init();

    } else {
      // ── Not logged in ─────────────────────────────────────
      // If there's a join token, show a join banner on the auth wall
      if (joinToken) {
        const joinBanner = document.createElement('div');
        joinBanner.className = 'join-banner';
        joinBanner.innerHTML = `
          <div class="join-banner__title">Te han invitado a un workspace</div>
          <div class="join-banner__sub">Inicia sesión con Google para unirte</div>`;
        const card = authWall.querySelector('.auth-wall__card');
        if (card) card.prepend(joinBanner);
      }

      const loginUrl = joinToken
        ? `${API}/auth/google?join=${encodeURIComponent(joinToken)}`
        : `${API}/auth/google`;

      authBar.innerHTML = `
        <a href="${loginUrl}" class="btn btn--google btn--sm">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" width="15" height="15"/>
          Sign in
        </a>`;
      // Also update auth wall button to include join token
      const wallBtn = authWall.querySelector('a[href*="auth/google"]');
      if (wallBtn && joinToken) wallBtn.href = loginUrl;

      authWall.classList.remove('hidden');
      appShell.classList.add('hidden');
    }

  } catch (err) {
    authBar.innerHTML = `<span style="font-size:.78rem;color:var(--err)">⚠ Can't reach server</span>`;
    authWall.classList.remove('hidden');
    appShell.classList.add('hidden');
    console.error('[auth] /api/auth/me failed:', err.message);
  }
}

// ── Show error banner if redirected back with ?error= ─────────────
(function checkUrlError() {
  const params = new URLSearchParams(window.location.search);
  const error  = params.get('error');
  if (!error) return;

  // Clean the query string from the URL without reloading
  history.replaceState(null, '', window.location.pathname);

  const messages = {
    unauthorized: '⛔ Tu cuenta de Google no tiene acceso a esta herramienta. Contactá al administrador.',
    auth_failed:  '⚠️ Hubo un problema al iniciar sesión. Intentá de nuevo.',
  };
  const msg = messages[error] || `Error de autenticación: ${error}`;

  // Inject a dismissible banner above the auth wall
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:300',
    'background:#7f1d1d;color:#fff;font-size:.85rem;font-weight:600',
    'padding:13px 20px;display:flex;align-items:center;justify-content:space-between',
    'gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.25)',
  ].join(';');
  banner.innerHTML = `<span>${msg}</span>
    <button style="background:rgba(255,255,255,.2);border:none;border-radius:6px;
      color:#fff;padding:4px 12px;cursor:pointer;font-size:.8rem;font-weight:600"
      onclick="this.parentElement.remove()">Cerrar</button>`;
  document.body.prepend(banner);
})();

// ── Global exchange rates ─────────────────────────────────────────
window._fxRates = {};   // { PEN: 3.70, COP: 4200, ... }  1 USD = X moneda

// ── Multi-responsable chip helpers (global) ───────────────────────
function _respToggle(el, wrapId) {
  el.classList.toggle('resp-chip--on');
  const wrap = document.getElementById(wrapId);
  const hidden = document.getElementById(wrapId.replace('-chips', 's-val'));
  if (!hidden) return;
  hidden.value = JSON.stringify(
    [...wrap.querySelectorAll('.resp-chip--on')].map(c => c.dataset.name)
  );
}

async function _loadRespChips(wrapId, selected = []) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.innerHTML = '<span class="resp-loading">Cargando…</span>';
  try {
    const res = await apiFetch(`${API}/mgmt/team`);
    const members = res.ok ? await res.json() : [];
    const hidden = document.getElementById(wrapId.replace('-chips', 's-val'));
    if (!members.length) {
      wrap.innerHTML = '<span class="resp-loading">Sin miembros en el equipo</span>';
      return;
    }
    wrap.innerHTML = members.map(m => {
      const on = selected.includes(m.nombre);
      return `<button type="button" class="resp-chip${on ? ' resp-chip--on' : ''}"
        data-name="${esc(m.nombre)}" onclick="_respToggle(this,'${wrapId}')"
        >${esc(m.nombre)}</button>`;
    }).join('');
    if (hidden) hidden.value = JSON.stringify(selected);
  } catch {
    wrap.innerHTML = '<span class="resp-loading">Error al cargar</span>';
  }
}

function _respVal(hiddenId) {
  try { return JSON.parse(document.getElementById(hiddenId)?.value || '[]'); }
  catch { return []; }
}

// Simple top toast
function snavToggle(id) {
  const body = document.getElementById('snav-body-' + id);
  const hdr  = document.getElementById('snav-hdr-' + id);
  if (!body || !hdr) return;
  const isOpen = !body.classList.contains('snav-section-body--collapsed');
  body.classList.toggle('snav-section-body--collapsed', isOpen);
  hdr.setAttribute('aria-expanded', String(!isOpen));
}

function showBanner(msg, type) {
  const el = document.createElement('div');
  const bg = type === 'success' ? '#166534' : type === 'error' ? '#7f1d1d' : '#1e3a5f';
  el.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:9999;background:${bg};color:#fff;font-size:.84rem;font-weight:600;padding:11px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.2);animation:slideDown .2s ease`;
  el.innerHTML = `<span>${msg}</span><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.18);border:none;border-radius:5px;color:#fff;padding:3px 10px;cursor:pointer;font-size:.78rem">✕</button>`;
  document.body.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

// Run auth check immediately
initAuth();

// =================================================================
// CLIENTS MODULE
// =================================================================

const ClientsModule = (() => {
  let _clients = [];
  let _editId  = null;
  let _filterEstado = '';
  let _contacts = [];

  const AVATAR_COLORS = ['#C4B5FD','#FBBFB0','#A7F3D0','#BAE6FD','#FDE68A','#FDBA74','#5EEAD4'];

  function _avatarColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function _initials(nombre) {
    const parts = (nombre || '?').trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
  }

  function _estadoBadge(estado) {
    const map = {
      activo:    { bg: '#A7F3D0', color: '#065F46', label: 'Activo' },
      inactivo:  { bg: '#E7E5E0', color: '#57534E', label: 'Inactivo' },
      potencial: { bg: '#C4B5FD', color: '#4C1D95', label: 'Potencial' },
      pausado:   { bg: '#FDE68A', color: '#78350F', label: 'Pausado' },
    };
    const m = map[estado] || map.activo;
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  async function load() {
    const loading  = $('clients-loading');
    const empty    = $('clients-empty');
    const tableWrap = $('clients-table-wrap');
    if (!loading) return;
    loading.style.display = 'flex';
    empty.style.display   = 'none';
    tableWrap.style.display = 'none';
    try {
      const res = await apiFetch(`${API}/mgmt/clients`);
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error(await res.text());
      _clients = await res.json();
      render();
    } catch (e) {
      console.error('[clients] load error:', e);
      loading.innerHTML = `<span style="color:var(--err)">Error al cargar clientes.</span>`;
    } finally {
      loading.style.display = 'none';
    }
  }

  function filter() {
    render();
  }

  function setFilter(estado) {
    _filterEstado = estado;
    document.querySelectorAll('#pane-mgmt-clients .filter-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.estado === estado);
    });
    render();
  }

  function render() {
    const tbody     = $('clients-tbody');
    const empty     = $('clients-empty');
    const tableWrap = $('clients-table-wrap');
    if (!tbody) return;

    const q = ($('clients-search')?.value || '').toLowerCase();
    let list = _clients;
    if (_filterEstado) list = list.filter(c => c.estado === _filterEstado);
    if (q) list = list.filter(c =>
      (c.nombre + ' ' + c.empresa + ' ' + c.email).toLowerCase().includes(q)
    );

    if (!list.length) {
      tableWrap.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';
    tableWrap.style.display = '';

    tbody.innerHTML = list.map(c => `
      <tr class="clients-table__row" onclick="ClientsModule.openDrawer(${c.id})">
        <td class="client-col--name">
          <div class="client-cell-name">
            <img class="client-avatar" src="https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(c.nombre)}" alt=""/>
            <div class="client-name-line">
              <span class="client-nombre">${esc(c.nombre)}</span>${c.empresa ? `<span class="client-empresa-inline"> · ${esc(c.empresa)}</span>` : ''}
            </div>
          </div>
        </td>
        <td class="client-col--email client-meta">${c.email ? `<span class="cell-clip">${esc(c.email)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="client-col--phone client-meta">${c.telefono ? esc(c.telefono) : '<span class="muted">—</span>'}</td>
        <td class="client-col--country client-meta">${c.pais ? esc(c.pais) : '<span class="muted">—</span>'}</td>
        <td class="client-col--status">${_estadoBadge(c.estado)}</td>
        <td class="client-col--actions">
          <div class="client-actions-cell">
            <button class="client-action-btn" title="Editar"
              onclick="event.stopPropagation();ClientsModule.openDrawer(${c.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="client-action-btn client-action-btn--danger" title="Eliminar"
              onclick="event.stopPropagation();ClientsModule.confirmDelete(${c.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  async function openDrawer(id = null) {
    _editId = id ?? null;
    _contacts = [];
    const form    = $('clients-form');
    const title   = $('clients-drawer-title');
    const saveBtn = $('clients-save-btn');
    const section = $('clients-contacts-section');
    if (!form) return;
    form.reset();
    closeContactForm();
    if (_editId) {
      const c = _clients.find(x => x.id === _editId);
      if (!c) return;
      title.textContent   = 'Editar cliente';
      saveBtn.textContent = 'Guardar cambios';
      form.nombre.value   = c.nombre;
      form.empresa.value  = c.empresa;
      form.email.value    = c.email;
      form.telefono.value = c.telefono;
      form.pais.value     = c.pais;
      form.estado.value   = c.estado;
      form.notas.value    = c.notas;
      if (section) section.style.display = '';
      _loadContacts();
    } else {
      title.textContent   = 'Nuevo cliente';
      saveBtn.textContent = 'Crear cliente';
      if (section) section.style.display = 'none';
    }
    $('clients-drawer').classList.add('open');
    $('clients-drawer-overlay').classList.add('open');
    setTimeout(() => form.nombre.focus(), 150);
  }

  async function _loadContacts() {
    const list = $('clients-contacts-list');
    if (!list || !_editId) return;
    list.innerHTML = '<span class="resp-loading">Cargando…</span>';
    try {
      const res = await apiFetch(`${API}/mgmt/clients/${_editId}/contacts`);
      _contacts = res.ok ? await res.json() : [];
      _renderContacts();
    } catch {
      list.innerHTML = '<span class="resp-loading">Error al cargar</span>';
    }
  }

  function _renderContacts() {
    const list = $('clients-contacts-list');
    if (!list) return;
    if (!_contacts.length) {
      list.innerHTML = '<div class="contacts-empty">Sin contactos adicionales</div>';
      return;
    }
    list.innerHTML = _contacts.map(ct => `
      <div class="contact-card" id="cc-${ct.id}">
        <div class="contact-card__avatar">${_initials(ct.nombre)}</div>
        <div class="contact-card__info">
          <div class="contact-card__name">${esc(ct.nombre)}${ct.cargo ? `<span class="contact-card__role">${esc(ct.cargo)}</span>` : ''}</div>
          ${ct.email    ? `<a class="contact-card__meta" href="mailto:${esc(ct.email)}">${esc(ct.email)}</a>` : ''}
          ${ct.telefono ? `<span class="contact-card__meta">${esc(ct.telefono)}</span>` : ''}
        </div>
        <div class="contact-card__actions">
          <button class="contact-card__btn" title="Editar" onclick="ClientsModule.openEditContact(${ct.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="contact-card__btn contact-card__btn--danger" title="Eliminar" onclick="ClientsModule.deleteContact(${ct.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  function openAddContact() {
    $('ccf-id').value       = '';
    $('ccf-nombre').value   = '';
    $('ccf-cargo').value    = '';
    $('ccf-email').value    = '';
    $('ccf-telefono').value = '';
    $('clients-contact-form').style.display = '';
    $('ccf-nombre').focus();
  }

  function openEditContact(contactId) {
    const ct = _contacts.find(c => c.id === contactId);
    if (!ct) return;
    $('ccf-id').value       = ct.id;
    $('ccf-nombre').value   = ct.nombre;
    $('ccf-cargo').value    = ct.cargo;
    $('ccf-email').value    = ct.email;
    $('ccf-telefono').value = ct.telefono;
    $('clients-contact-form').style.display = '';
    $('ccf-nombre').focus();
  }

  function closeContactForm() {
    const f = $('clients-contact-form');
    if (f) f.style.display = 'none';
  }

  async function saveContact() {
    const nombre = $('ccf-nombre')?.value.trim();
    if (!nombre) { $('ccf-nombre').focus(); return; }
    const id       = $('ccf-id')?.value ? parseInt($('ccf-id').value) : null;
    const payload  = {
      nombre,
      cargo:    $('ccf-cargo')?.value.trim()    || '',
      email:    $('ccf-email')?.value.trim()    || '',
      telefono: $('ccf-telefono')?.value.trim() || '',
    };
    const btn = $('clients-contact-form')?.querySelector('.btn--primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      const url    = id
        ? `${API}/mgmt/clients/${_editId}/contacts/${id}`
        : `${API}/mgmt/clients/${_editId}/contacts`;
      const res = await apiFetch(url, {
        method:  id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const saved = await res.json();
      if (id) {
        const idx = _contacts.findIndex(c => c.id === id);
        if (idx !== -1) _contacts[idx] = saved;
      } else {
        _contacts.push(saved);
      }
      _renderContacts();
      closeContactForm();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar contacto'; }
    }
  }

  async function deleteContact(contactId) {
    const ct = _contacts.find(c => c.id === contactId);
    if (!confirm(`¿Eliminar a "${ct?.nombre}"?`)) return;
    try {
      const res = await apiFetch(
        `${API}/mgmt/clients/${_editId}/contacts/${contactId}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error('Error al eliminar');
      _contacts = _contacts.filter(c => c.id !== contactId);
      _renderContacts();
    } catch (e) { alert('Error: ' + e.message); }
  }

  function closeDrawer() {
    $('clients-drawer')?.classList.remove('open');
    $('clients-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function save(e) {
    e.preventDefault();
    const form    = e.target;
    const saveBtn = $('clients-save-btn');
    const data = {
      nombre:           form.nombre.value.trim(),
      empresa:          form.empresa.value.trim(),
      email:            form.email.value.trim(),
      telefono:         form.telefono.value.trim(),
      pais:             form.pais.value.trim(),
      estado:           form.estado.value,
      notas:            form.notas.value.trim(),
    };
    const orig = saveBtn.textContent;
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/clients${_editId ? '/' + _editId : ''}`,
        {
          method:  _editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(data),
        }
      );
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      closeDrawer();
      await load();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = orig;
    }
  }

  async function confirmDelete(id) {
    const c = _clients.find(x => x.id === id);
    if (!confirm(`¿Eliminar a "${c?.nombre}"? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await apiFetch(`${API}/mgmt/clients/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      await load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  return {
    load, filter, setFilter, render,
    openDrawer, closeDrawer, save, confirmDelete,
    openAddContact, openEditContact, closeContactForm, saveContact, deleteContact,
  };
})();

// =================================================================
// FINANCE MODULE
// =================================================================

const FinanceModule = (() => {
  let _payments     = [];
  let _editId       = null;
  let _filterEstado = '';
  let _allClients   = [];
  let _allProjects  = [];
  let _period       = 'semana';   // 'semana' | 'mes' | 'rango'
  let _rangeFrom    = null;
  let _rangeTo      = null;

  function _money(n, cur, decimals = 2) {
    if (n == null || n === '' || isNaN(parseFloat(n))) return '—';
    cur = cur || 'USD';
    try {
      return new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(parseFloat(n));
    } catch {
      return cur + ' ' + parseFloat(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
  }

  function _toUsdEquiv(amt, cur) {
    if (amt == null || amt === '' || isNaN(parseFloat(amt))) return null;
    amt = parseFloat(amt);
    if (!cur || cur === 'USD') return amt;
    const rate = (window._fxRates || {})[cur];
    return rate > 0 ? amt / rate : null;
  }

  function _fmtByCur(byCur) {
    const entries = Object.entries(byCur || {}).filter(([, v]) => v > 0);
    if (!entries.length) return _money(0, 'USD', 0);
    let totalUSD = 0, noRate = [];
    for (const [cur, amt] of entries) {
      if (cur === 'USD') totalUSD += amt;
      else {
        const rate = (window._fxRates || {})[cur];
        if (rate > 0) totalUSD += amt / rate;
        else noRate.push({ cur, amt });
      }
    }
    if (!noRate.length) return _money(totalUSD, 'USD', 0);
    const rawStr = noRate.map(({ cur, amt }) => _money(amt, cur, 0)).join(' · ');
    return totalUSD > 0 ? `${_money(totalUSD, 'USD', 0)} + ${rawStr}` : rawStr;
  }

  function _periodBounds() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (_period === 'semana') {
      const dow   = (today.getDay() + 6) % 7; // Monday = 0
      const start = new Date(today); start.setDate(today.getDate() - dow);
      const end   = new Date(start); end.setDate(start.getDate() + 7);
      return { start, end };
    }
    if (_period === 'mes') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end   = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return { start, end };
    }
    if (_rangeFrom && _rangeTo) {
      const start = new Date(_rangeFrom + 'T00:00:00');
      const end   = new Date(_rangeTo   + 'T00:00:00'); end.setDate(end.getDate() + 1);
      return { start, end };
    }
    return null;
  }

  function _periodLabel() {
    if (_period === 'semana') return 'esta semana';
    if (_period === 'mes')    return 'este mes';
    if (_rangeFrom && _rangeTo) {
      const f = new Date(_rangeFrom + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
      const t = new Date(_rangeTo   + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
      return `${f} – ${t}`;
    }
    return 'rango sin definir';
  }

  function setPeriod(p) {
    _period = p;
    document.querySelectorAll('#pane-mgmt-finance .an-period').forEach(b => b.classList.toggle('an-period--on', b.dataset.period === p));
    const rangeEl = $('fin-range-inputs');
    if (rangeEl) rangeEl.style.display = p === 'rango' ? 'flex' : 'none';
    _updateStats();
    render();
  }

  function applyRange() {
    _rangeFrom = $('fin-range-from')?.value || null;
    _rangeTo   = $('fin-range-to')?.value   || null;
    _updateStats();
    render();
  }

  function _isOverdue(p) {
    if (p.estado !== 'pendiente' || !p.fecha_esperada) return false;
    const today = new Date(); today.setHours(0,0,0,0);
    return new Date(String(p.fecha_esperada).split('T')[0] + 'T00:00:00') < today;
  }

  function _estadoBadge(p) {
    if (p.estado === 'cobrado')
      return `<span class="client-badge" style="background:#A7F3D0;color:#065F46">✓ Cobrado</span>`;
    if (p.estado === 'vencido' || _isOverdue(p))
      return `<span class="client-badge" style="background:#FBBFB0;color:#9F1239">⚠ Vencido</span>`;
    return `<span class="client-badge" style="background:#FDE68A;color:#78350F">● Pendiente</span>`;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  function _updateStats() {
    const bounds = _periodBounds();
    const netByCur = {}, brutoByCur = {}, pendByCur = {}, ovByCur = {};
    for (const p of _payments) {
      const net   = parseFloat(p.monto_neto ?? p.monto_bruto ?? 0);
      const bruto = parseFloat(p.monto_bruto ?? 0);
      const cur   = p.project_moneda || 'USD';
      if (p.estado === 'cobrado' && p.fecha_pagada && bounds) {
        const d = new Date(String(p.fecha_pagada).split('T')[0] + 'T00:00:00');
        if (d >= bounds.start && d < bounds.end) {
          netByCur[cur]   = (netByCur[cur]   || 0) + net;
          brutoByCur[cur] = (brutoByCur[cur] || 0) + bruto;
        }
      }
      if (p.estado === 'pendiente') {
        if (_isOverdue(p)) ovByCur[cur] = (ovByCur[cur] || 0) + net;
        else              pendByCur[cur] = (pendByCur[cur] || 0) + net;
      }
      if (p.estado === 'vencido') ovByCur[cur] = (ovByCur[cur] || 0) + net;
    }
    const setStr = (id, str) => { const el = $(id); if (el) el.textContent = str; };
    setStr('fin-stat-neto-lbl',  `Cobrado neto (${_periodLabel()})`);
    setStr('fin-stat-bruto-lbl', `Cobrado bruto (${_periodLabel()})`);
    setStr('fin-stat-neto',    _fmtByCur(netByCur));
    setStr('fin-stat-bruto',   _fmtByCur(brutoByCur));
    setStr('fin-stat-pending', _fmtByCur(pendByCur));
    setStr('fin-stat-overdue', _fmtByCur(ovByCur));
  }

  // ── Load ───────────────────────────────────────────────────────────

  async function load() {
    const loading   = $('fin-loading');
    const empty     = $('fin-empty');
    const tableWrap = $('fin-table-wrap');
    if (!loading) return;
    loading.style.display   = 'flex';
    empty.style.display     = 'none';
    tableWrap.style.display = 'none';
    try {
      const res = await apiFetch(`${API}/mgmt/payments`);
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error(await res.text());
      _payments = await res.json();
      _updateStats();
      render();
    } catch (e) {
      console.error('[finance] load error:', e);
      loading.innerHTML = '<span style="color:var(--err)">Error al cargar pagos.</span>';
    } finally {
      loading.style.display = 'none';
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  function filter() { render(); }

  function setFilter(estado) {
    _filterEstado = estado;
    document.querySelectorAll('#pane-mgmt-finance .filter-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.estado === estado);
    });
    render();
  }

  function _estadoText(p) {
    if (p.estado === 'cobrado') return 'Cobrado';
    if (p.estado === 'vencido' || _isOverdue(p)) return 'Vencido';
    return 'Pendiente';
  }

  function _filteredList() {
    const q = ($('fin-search')?.value || '').toLowerCase();
    let list = _payments;

    if (_filterEstado) {
      list = list.filter(p => {
        if (_filterEstado === 'vencido') return p.estado === 'vencido' || _isOverdue(p);
        if (_filterEstado === 'pendiente') return p.estado === 'pendiente' && !_isOverdue(p);
        return p.estado === _filterEstado;
      });
    }
    if (q) list = list.filter(p =>
      (p.concepto + ' ' + (p.client_nombre || '') + ' ' + (p.project_nombre || '')).toLowerCase().includes(q)
    );

    // El período sólo filtra filas ya cobradas — pendientes/vencidos siempre se muestran
    const bounds = _periodBounds();
    if (bounds) {
      list = list.filter(p => {
        if (p.estado !== 'cobrado' || !p.fecha_pagada) return true;
        const d = new Date(String(p.fecha_pagada).split('T')[0] + 'T00:00:00');
        return d >= bounds.start && d < bounds.end;
      });
    }
    return list;
  }

  function render() {
    const tbody     = $('fin-tbody');
    const empty     = $('fin-empty');
    const tableWrap = $('fin-table-wrap');
    if (!tbody) return;

    const list = _filteredList();

    if (!list.length) {
      tableWrap.style.display = 'none';
      empty.style.display     = 'flex';
      return;
    }
    empty.style.display     = 'none';
    tableWrap.style.display = '';

    tbody.innerHTML = list.map(p => {
      const cur    = p.project_moneda || 'USD';
      const bruto  = parseFloat(p.monto_bruto ?? 0);
      const net    = parseFloat(p.monto_neto ?? p.monto_bruto ?? 0);
      const usdEq  = _toUsdEquiv(net, cur);
      const isCob  = p.estado === 'cobrado';
      const isOv   = p.estado === 'vencido' || _isOverdue(p);
      const amtCls = isCob ? 'fin-amount fin-amount--cobrado' : isOv ? 'fin-amount fin-amount--vencido' : 'fin-amount';

      const dlRaw = p.fecha_esperada ? p.fecha_esperada.split('T')[0] : null;
      const dlDate = dlRaw ? new Date(dlRaw + 'T00:00:00') : null;
      const dlLabel = dlDate ? dlDate.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
      const today = new Date(); today.setHours(0,0,0,0);
      const dlHtml = (dlDate && dlDate < today && !isCob)
        ? `<span style="color:#DC2626;font-weight:600">${dlLabel}</span>`
        : `<span>${dlLabel}</span>`;

      const isTask  = p.source === 'task';
      const rowClick = isTask ? `TasksModule.openDrawer(${p.task_id})` : `FinanceModule.openDrawer(${p.id})`;
      const actionsHtml = isTask
        ? `<span class="fin-task-tag" title="Cobrado desde la tarea — edítalo ahí">🔗 Tarea</span>`
        : `<div class="client-actions-cell">
            <button class="client-action-btn" title="Editar"
              onclick="event.stopPropagation();FinanceModule.openDrawer(${p.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="client-action-btn client-action-btn--danger" title="Eliminar"
              onclick="event.stopPropagation();FinanceModule.confirmDelete(${p.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>`;

      return `<tr class="clients-table__row" onclick="${rowClick}">
        <td>
          <div class="client-nombre">${esc(p.concepto || '—')}</div>
          <div class="client-meta" style="font-size:.73rem">${p.client_nombre ? esc(p.client_nombre) + (p.client_empresa ? ' · ' + esc(p.client_empresa) : '') : '<span class="muted">Sin cliente</span>'}</div>
        </td>
        <td class="client-meta">${p.project_nombre ? esc(p.project_nombre) : '<span class="muted">—</span>'}</td>
        <td class="client-meta">${esc(cur)}</td>
        <td class="client-meta">${_money(bruto, cur)}</td>
        <td>
          <div class="${amtCls}">${_money(net, cur)}</div>
          ${p.porcentaje ? `<div class="fin-comision">${p.porcentaje}%</div>` : ''}
        </td>
        <td class="client-meta">${usdEq != null ? _money(usdEq, 'USD') : '<span class="muted" title="Configura la tasa de cambio en el Dashboard">—</span>'}</td>
        <td class="client-meta">${dlHtml}</td>
        <td>${_estadoBadge(p)}</td>
        <td>${actionsHtml}</td>
      </tr>`;
    }).join('');
  }

  // ── Drawer ─────────────────────────────────────────────────────────

  async function _loadClients() {
    const sel = $('pay-client-select');
    if (!sel) return;
    try {
      const res = await apiFetch(`${API}/mgmt/clients`);
      _allClients = res.ok ? await res.json() : [];
      sel.innerHTML = '<option value="">Sin cliente</option>' +
        _allClients.map(c =>
          `<option value="${c.id}" data-comision="${c.comision_default ?? ''}">${esc(c.nombre)}${c.empresa ? ' — ' + esc(c.empresa) : ''}</option>`
        ).join('');
    } catch { sel.innerHTML = '<option value="">Error al cargar</option>'; }
  }

  async function _loadProjects(clientId, selectedId) {
    const sel = $('pay-project-select');
    if (!sel) return;
    try {
      const res = await apiFetch(`${API}/mgmt/projects`);
      _allProjects = res.ok ? await res.json() : [];
      const filtered = clientId ? _allProjects.filter(p => p.client_id == clientId) : _allProjects;
      sel.innerHTML = '<option value="">Sin proyecto</option>' +
        filtered.map(p =>
          `<option value="${p.id}" data-comision="${p.comision ?? ''}" ${p.id == selectedId ? 'selected' : ''}>${esc(p.nombre)}</option>`
        ).join('');
    } catch { sel.innerHTML = '<option value="">Error al cargar</option>'; }
  }

  function onClientChange(sel) {
    _loadProjects(sel.value, null);
  }

  function onProjectChange(sel) {
    const opt = sel.options[sel.selectedIndex];
    const comision = opt?.dataset?.comision;
    if (comision) {
      const pctEl = $('pay-porcentaje');
      if (pctEl) { pctEl.value = comision; calcNeto(); }
    }
  }

  function calcNeto() {
    const bruto = parseFloat($('pay-monto-bruto')?.value) || 0;
    const pct   = parseFloat($('pay-porcentaje')?.value)  || 0;
    const netoEl = $('pay-monto-neto');
    if (netoEl && bruto && pct) netoEl.value = (bruto * pct / 100).toFixed(2);
  }

  function onEstadoChange(sel) {
    const row = $('pay-fecha-pagada-row');
    if (row) row.style.display = sel.value === 'cobrado' ? '' : 'none';
  }

  async function openDrawer(id = null) {
    _editId = id ?? null;
    const form    = $('pay-form');
    const title   = $('pay-drawer-title');
    const saveBtn = $('pay-save-btn');
    if (!form) return;
    form.reset();
    const fechaRow = $('pay-fecha-pagada-row');
    if (fechaRow) fechaRow.style.display = 'none';

    await _loadClients();
    await _loadProjects(null, null);

    if (_editId) {
      const p = _payments.find(x => x.id === _editId);
      if (!p) return;
      title.textContent              = 'Editar pago';
      saveBtn.textContent            = 'Guardar cambios';
      form.concepto.value            = p.concepto;
      form.estado.value              = p.estado;
      form.monto_bruto.value         = p.monto_bruto ?? '';
      form.porcentaje.value          = p.porcentaje ?? '';
      form.monto_neto.value          = p.monto_neto ?? '';
      if (p.fecha_esperada) form.fecha_esperada.value = p.fecha_esperada.split('T')[0];
      if (p.fecha_pagada)   form.fecha_pagada.value   = p.fecha_pagada.split('T')[0];
      if (p.estado === 'cobrado' && fechaRow) fechaRow.style.display = '';
      form.notas.value               = p.notas ?? '';
      // Set client then refresh project list
      if (p.client_id) {
        $('pay-client-select').value = p.client_id;
        await _loadProjects(p.client_id, p.project_id);
      }
      // Auto-fill commission from project
      if (p.project_id && !form.porcentaje.value) {
        const projOpt = $('pay-project-select').options[$('pay-project-select').selectedIndex];
        if (projOpt?.dataset?.comision) { form.porcentaje.value = projOpt.dataset.comision; calcNeto(); }
      }
    } else {
      title.textContent   = 'Nuevo pago';
      saveBtn.textContent = 'Registrar pago';
    }

    $('pay-drawer').classList.add('open');
    $('pay-drawer-overlay').classList.add('open');
    setTimeout(() => form.concepto.focus(), 150);
  }

  function closeDrawer() {
    $('pay-drawer')?.classList.remove('open');
    $('pay-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function save(e) {
    e.preventDefault();
    const form    = e.target;
    const saveBtn = $('pay-save-btn');
    const data = {
      concepto:       form.concepto.value.trim(),
      client_id:      form.client_id.value  ? parseInt(form.client_id.value)  : null,
      project_id:     form.project_id.value ? parseInt(form.project_id.value) : null,
      monto_bruto:    parseFloat(form.monto_bruto.value)  || 0,
      porcentaje:     form.porcentaje.value ? parseFloat(form.porcentaje.value) : null,
      monto_neto:     form.monto_neto.value ? parseFloat(form.monto_neto.value) : null,
      fecha_esperada: form.fecha_esperada.value || null,
      fecha_pagada:   form.fecha_pagada.value   || null,
      estado:         form.estado.value,
      notas:          form.notas.value.trim(),
    };
    const orig = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/payments${_editId ? '/' + _editId : ''}`,
        { method: _editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      );
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      closeDrawer();
      await load();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = orig;
    }
  }

  async function confirmDelete(id) {
    const p = _payments.find(x => x.id === id);
    if (!confirm(`¿Eliminar "${p?.concepto || 'este pago'}"? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await apiFetch(`${API}/mgmt/payments/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      await load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ── Export PDF ────────────────────────────────────────────────────

  function exportPdf() {
    if (!window.jspdf) { alert('No se pudo cargar el generador de PDF. Recarga la página e intenta de nuevo.'); return; }
    const list = _filteredList();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });

    doc.setFontSize(15);
    doc.text('Finanzas', 14, 15);
    doc.setFontSize(9);
    doc.setTextColor(120, 113, 108);
    doc.text(`Período: ${_periodLabel()}  ·  Generado: ${new Date().toLocaleDateString('es-MX')}`, 14, 21);

    const rows = list.map(p => {
      const cur   = p.project_moneda || 'USD';
      const bruto = parseFloat(p.monto_bruto ?? 0);
      const net   = parseFloat(p.monto_neto ?? p.monto_bruto ?? 0);
      const usdEq = _toUsdEquiv(net, cur);
      return [
        p.concepto || '—',
        p.client_nombre || '—',
        p.project_nombre || '—',
        cur,
        _money(bruto, cur),
        _money(net, cur),
        usdEq != null ? _money(usdEq, 'USD') : '—',
        p.fecha_esperada ? p.fecha_esperada.split('T')[0] : '—',
        _estadoText(p),
      ];
    });

    doc.autoTable({
      startY: 26,
      head: [['Concepto', 'Cliente', 'Proyecto', 'Moneda', 'Bruto', 'Neto', 'Equiv. USD', 'F. Esperada', 'Estado']],
      body: rows,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [248, 143, 34] },
    });

    doc.save(`finanzas_${_periodLabel().replace(/[^\w]+/g, '_')}.pdf`);
  }

  return { load, filter, setFilter, setPeriod, applyRange, render, openDrawer, closeDrawer, save, confirmDelete, onClientChange, onProjectChange, calcNeto, onEstadoChange, exportPdf };
})();

// =================================================================
// FX RATES MODULE — tasas de cambio a USD
// =================================================================
const FxRatesModule = (() => {
  async function load() {
    try {
      const res = await apiFetch(`${API}/mgmt/exchange-rates`);
      if (res.ok) window._fxRates = await res.json();
    } catch {}
  }

  async function open() {
    await load();
    // Detect non-USD currencies in use from active projects
    let usedCurs = [];
    try {
      const res = await apiFetch(`${API}/mgmt/projects`);
      if (res.ok) {
        const projs = await res.json();
        usedCurs = [...new Set(projs.map(p => p.moneda).filter(m => m && m !== 'USD'))];
      }
    } catch {}

    const rowsEl = $('fx-rows');
    const noEl   = $('fx-no-currencies');
    if (!rowsEl) return;

    if (!usedCurs.length) {
      rowsEl.innerHTML = '';
      if (noEl) noEl.style.display = '';
    } else {
      if (noEl) noEl.style.display = 'none';
      rowsEl.innerHTML = usedCurs.map(cur => `
        <div class="fx-row">
          <span class="fx-row__label">1 USD =</span>
          <input class="form-input fx-row__input" type="number" min="0.0001" step="any"
                 id="fx-rate-${cur}" placeholder="ej: 3.70"
                 value="${window._fxRates[cur] || ''}">
          <span class="fx-row__cur">${cur}</span>
        </div>`).join('');
    }
    $('fx-overlay').classList.remove('hidden');
    $('fx-modal').classList.remove('hidden');
  }

  function close() {
    $('fx-overlay')?.classList.add('hidden');
    $('fx-modal')?.classList.add('hidden');
  }

  async function save() {
    const rates = {};
    document.querySelectorAll('[id^="fx-rate-"]').forEach(inp => {
      const cur = inp.id.replace('fx-rate-', '');
      const val = parseFloat(inp.value);
      if (val > 0) rates[cur] = val;
    });
    const btn = $('fx-save-btn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(`${API}/mgmt/exchange-rates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rates),
      });
      if (!res.ok) throw new Error('Error al guardar');
      window._fxRates = rates;
      close();
      AnalyticsModule.load();
      FinanceModule.load();
      DashboardModule.load();
    } catch (e) { alert('Error: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }

  return { load, open, close, save };
})();

// =================================================================
// DASHBOARD MODULE
// =================================================================

const DashboardModule = (() => {
  const QUOTES = [
    'Un paso a la vez. El progreso importa más que la perfección.',
    'Empieza donde estás, usa lo que tienes, haz lo que puedes.',
    'La disciplina es hacer lo que debes, cuando debes hacerlo.',
    'Pequeñas acciones consistentes crean grandes resultados.',
    'Hoy es una nueva oportunidad de avanzar.',
    'El trabajo bien hecho habla por sí mismo.',
    'Claridad sobre el ruido. Foco sobre la urgencia.',
    'No tienes que ser perfecto. Solo tienes que empezar.',
    'Un cliente a la vez, una tarea a la vez.',
    'La simplicidad es la sofisticación máxima.',
    'Lo que se mide, se mejora.',
    'Haz hoy lo que tu yo de mañana te agradecerá.',
  ];

  function _myName() {
    return window._authUser?.memberNombre || window._authUser?.name || '';
  }

  function _isAdmin() {
    const u = window._authUser;
    if (!u) return false;
    return u.isOwner || ['admin', 'manager'].includes(u.memberRol);
  }

  function _greeting() {
    const h = new Date().getHours();
    const saludo = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
    const nombre = (_myName()).split(' ')[0];
    return nombre ? `${saludo}, ${nombre}` : saludo;
  }

  function _quote() {
    return QUOTES[new Date().getDay() % QUOTES.length];
  }

  // ── Avatar system ─────────────────────────────────────────────
  const _AVATARS = {
    combat: [
      { id:'ghost',    src:'/ghosts.png',                                                                   label:'Ghost',    bg:'',        pos:'center bottom', type:'character' },
      { id:'warrior',  src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=warrior',                       label:'Warrior',  bg:'#1a1a2e', pos:'center center'},
      { id:'mage',     src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=archmage',                      label:'Mage',     bg:'#2d1b69', pos:'center center'},
      { id:'assassin', src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=assassin',                      label:'Assassin', bg:'#1c0a00', pos:'center center'},
      { id:'paladin',  src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=paladin',                       label:'Paladin',  bg:'#0d2137', pos:'center center'},
      { id:'archer',   src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=ranger',                        label:'Archer',   bg:'#0f2318', pos:'center center'},
      { id:'necro',    src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=necromancer',                   label:'Necro',    bg:'#100010', pos:'center center'},
      { id:'knight',   src:'https://api.dicebear.com/9.x/pixel-art/svg?seed=darknight',                     label:'Knight',   bg:'#1a0a0a', pos:'center center'},
    ],
    robo: [
      { id:'bot-alpha', src:'https://api.dicebear.com/9.x/bottts/svg?seed=alpha',   label:'Alpha',  bg:'#0d1b2a' },
      { id:'bot-omega', src:'https://api.dicebear.com/9.x/bottts/svg?seed=omega',   label:'Omega',  bg:'#1a0d2e' },
      { id:'bot-cyber', src:'https://api.dicebear.com/9.x/bottts/svg?seed=cyber',   label:'Cyber',  bg:'#002b1a' },
      { id:'bot-nova',  src:'https://api.dicebear.com/9.x/bottts/svg?seed=nova',    label:'Nova',   bg:'#1a1a00' },
      { id:'bot-titan', src:'https://api.dicebear.com/9.x/bottts/svg?seed=titan',   label:'Titan',  bg:'#1a0000' },
      { id:'bot-rex',   src:'https://api.dicebear.com/9.x/bottts/svg?seed=rex',     label:'Rex',    bg:'#001a1a' },
      { id:'bot-zero',  src:'https://api.dicebear.com/9.x/bottts/svg?seed=zero',    label:'Zero',   bg:'#0a0a1a' },
      { id:'bot-glitch',src:'https://api.dicebear.com/9.x/bottts/svg?seed=glitch',  label:'Glitch', bg:'#0f000f' },
    ],
  };

  let _avClickCount = 0;
  let _avClickTimer = null;

  function _allAvatars() {
    return [..._AVATARS.combat, ..._AVATARS.robo];
  }

  function _applyAvatarById(id) {
    const av = _allAvatars().find(a => a.id === id);
    const avatarEl = $('d3-avatar');
    if (!avatarEl) return;
    if (!av) return;
    const isChar = av.type === 'character';
    avatarEl.className = 'd3-avatar' + (isChar ? ' d3-avatar--character' : '');
    avatarEl.style.background = isChar ? '' : (av.bg || '');
    avatarEl.innerHTML = `<img src="${av.src}" alt="${av.label}">`;
  }

  function _onAvatarClick() {
    _avClickCount++;
    clearTimeout(_avClickTimer);
    _avClickTimer = setTimeout(() => { _avClickCount = 0; }, 700);

    const el = $('d3-avatar');
    if (!el) return;
    // Animate the img so the circle frame stays fixed
    const target = el.querySelector('img') || el;
    target.classList.remove('av-anim-pirouette', 'av-anim-double', 'av-anim-killstreak');
    void target.offsetWidth; // force reflow

    if (_avClickCount >= 3) {
      target.classList.add('av-anim-killstreak');
      _burstParticles(el, ['💥','🔥','💀','⚡','🎯','🩸'], 16);
    } else if (_avClickCount === 2) {
      target.classList.add('av-anim-double');
      _burstParticles(el, ['💀','⚡','🔥'], 8);
    } else {
      target.classList.add('av-anim-pirouette');
    }
  }

  function _burstParticles(el, emojis, count) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'av-particle';
      p.textContent = emojis[i % emojis.length];
      const angle = ((360 / count) * i - 90) * (Math.PI / 180);
      const dist = 55 + Math.random() * 55;
      p.style.cssText = `left:${cx}px;top:${cy}px;--tx:${(Math.cos(angle)*dist).toFixed(1)}px;--ty:${(Math.sin(angle)*dist).toFixed(1)}px;animation-delay:${i * 25}ms`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1100);
    }
  }

  function openAvatarPicker() {
    if ($('av-picker-modal')) return;
    const saved = localStorage.getItem('kw_avatar') || '';
    const modal = document.createElement('div');
    modal.id = 'av-picker-modal';
    modal.className = 'av-picker-backdrop';
    modal.onclick = e => { if (e.target === modal) closeAvatarPicker(); };
    modal.innerHTML = `
      <div class="av-picker-box">
        <div class="av-picker-hdr">
          <span class="av-picker-title">Elige tu avatar</span>
          <button class="av-picker-close" onclick="DashboardModule.closeAvatarPicker()">✕</button>
        </div>
        <div class="av-picker-tabs">
          <button class="av-ptab av-ptab--on" onclick="DashboardModule._avSwitchTab('combat',this)">⚔️ Combate</button>
          <button class="av-ptab" onclick="DashboardModule._avSwitchTab('robo',this)">🤖 Robots</button>
        </div>
        <div class="av-grid" id="av-picker-grid">${_avGridHtml('combat', saved)}</div>
      </div>`;
    document.body.appendChild(modal);
  }

  function _avGridHtml(tab, selected) {
    return (_AVATARS[tab] || []).map(av => `
      <div class="av-option${av.id === selected ? ' av-option--on' : ''}"
           style="background:${av.bg || '#1a1a1a'}"
           onclick="DashboardModule.selectAvatar('${av.id}')"
           title="${av.label}">
        <img src="${av.src}" alt="${av.label}" style="object-position:${av.pos||'center center'}">
        <span class="av-option-lbl">${av.label}</span>
      </div>`).join('');
  }

  function _avSwitchTab(tab, btn) {
    document.querySelectorAll('.av-ptab').forEach(b => b.classList.remove('av-ptab--on'));
    btn.classList.add('av-ptab--on');
    const saved = localStorage.getItem('kw_avatar') || '';
    const grid = $('av-picker-grid');
    if (grid) grid.innerHTML = _avGridHtml(tab, saved);
  }

  function selectAvatar(id) {
    localStorage.setItem('kw_avatar', id);
    _applyAvatarById(id);
    document.querySelectorAll('.av-option').forEach(el => el.classList.remove('av-option--on'));
    const clickedEl = document.querySelector(`.av-option[onclick*="'${id}'"]`);
    if (clickedEl) clickedEl.classList.add('av-option--on');
    setTimeout(closeAvatarPicker, 280);
  }

  function closeAvatarPicker() {
    const el = $('av-picker-modal');
    if (el) el.remove();
  }

  // ── Hero render ───────────────────────────────────────────────
  function _renderHero(todayCount, overdueCount, projectsCount, alertCount) {
    const u = window._authUser || {};
    const name     = u.memberNombre || u.name || '';
    const photoUrl = u.avatar || '';
    const rolLabel = u.isOwner ? 'Propietaria · Admin' : (u.memberRol === 'admin' ? 'Administrador' : 'Miembro');

    const avatarEl = $('d3-avatar');
    if (avatarEl) {
      const savedAvatar = localStorage.getItem('kw_avatar');
      if (savedAvatar) {
        _applyAvatarById(savedAvatar);
      } else if (photoUrl) {
        const ini = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
        const hue = name.charCodeAt(0) * 47 % 360;
        avatarEl.innerHTML = `<img src="${photoUrl}" alt="${esc(name)}" onerror="this.parentElement.style.background='hsl(${hue},40%,88%)';this.parentElement.style.color='hsl(${hue},50%,32%)';this.parentElement.textContent='${ini}'">`;
      } else {
        const ini = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
        const hue = name ? (name.charCodeAt(0) * 47 % 360) : 30;
        avatarEl.style.background = `hsl(${hue},40%,88%)`;
        avatarEl.style.color = `hsl(${hue},50%,32%)`;
        avatarEl.textContent = ini;
      }
    }
    const nameEl = $('d3-profile-name');
    const roleEl = $('d3-profile-role');
    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = rolLabel;
  }

  async function load() {
    const greetEl = $('dash2-greeting');
    const quoteEl = $('dash2-quote');
    const loadEl  = $('dash2-loading');
    const bodyEl  = $('dash2-body');
    if (!loadEl) return;

    if (greetEl) greetEl.textContent = _greeting();
    if (quoteEl) quoteEl.textContent = '';

    loadEl.classList.remove('hidden');
    bodyEl.classList.add('hidden');

    try {
      const [dashRes, clientsRes] = await Promise.all([
        apiFetch(`${API}/mgmt/dashboard`),
        apiFetch(`${API}/mgmt/clients`),
      ]);
      if (dashRes.status === 401) { location.reload(); return; }
      if (!dashRes.ok) throw new Error(await dashRes.text());

      const dash    = await dashRes.json();
      const clients = clientsRes.ok ? await clientsRes.json() : [];

      const tareasCount    = dash.tareas_count    || 0;
      const todayTasks     = dash.tareas_hoy      || [];
      const overdue        = dash.tareas_urgentes || [];
      const proyectosCount = dash.proyectos_count || 0;

      _renderHero(tareasCount, proyectosCount, 0, 0);
      _renderTasks(tareasCount, todayTasks, overdue);
      AnalyticsModule.load();

      loadEl.classList.add('hidden');
      bodyEl.classList.remove('hidden');
    } catch (e) {
      console.error('[dashboard] load error:', e);
      if (loadEl) loadEl.innerHTML = '<span style="color:var(--err)">Error al cargar el dashboard.</span>';
    }
  }

  function _renderTasks(count, todayTasks, overdue) {
    const el = $('dash2-tasks');
    if (!el) return;
    const header = `
      <div class="d3-card-header">
        <span class="d3-card-title">Mis tareas</span>
        ${count > 0 ? `<span class="d3-card-count">${count}</span>` : ''}
        <span class="d3-card-link" onclick="document.querySelector('[data-tab=mgmt-tasks]').click()">Ver todo →</span>
      </div>`;
    if (count === 0) {
      el.innerHTML = header + `
        <div class="d3-clients-total" onclick="document.querySelector('[data-tab=mgmt-tasks]').click()">
          <span class="d3-clients-num">0</span>
          <span class="d3-clients-label">tareas pendientes</span>
        </div>`;
      return;
    }
    const todayHtml = todayTasks.length === 0
      ? `<div class="d3-empty"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>Sin tareas para hoy</div>`
      : todayTasks.map(t => _taskRow(t, false)).join('');
    const overdueHtml = overdue.length === 0 ? '' : `
      <div class="d3-section-label d3-section-label--warn">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>
        Vencidas · ${overdue.length}
      </div>
      ${overdue.map(t => _taskRow(t, true)).join('')}`;
    el.innerHTML = header + `
      <div class="d3-section-label">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
        Hoy
      </div>
      ${todayHtml}${overdueHtml}`;
  }

  const _STATUS_CFG = {
    pendiente:   { dot: 'pendiente',   label: 'Pendiente',   icon: `<circle cx="8" cy="8" r="5.5" stroke="#C8BCAC" stroke-width="1.5" fill="none"/>` },
    en_progreso: { dot: 'inprogress',  label: 'En progreso', icon: `<circle cx="8" cy="8" r="6.5" fill="#6366F1"/><path d="M5 8 L7.5 10.5 L11 6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".4"/><path d="M5.5 8a2.5 2.5 0 0 1 4.5-1.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none"/>` },
    completado:  { dot: 'done',        label: 'Completado',  icon: `<circle cx="8" cy="8" r="6.5" fill="#22C55E"/><path d="M5 8 L7.2 10.5 L11 6" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` },
    bloqueado:   { dot: 'blocked',     label: 'Bloqueado',   icon: `<circle cx="8" cy="8" r="6.5" fill="#EF4444"/><line x1="5.5" y1="8" x2="10.5" y2="8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>` },
  };

  function _statusSvg(estado) {
    const cfg = _STATUS_CFG[estado] || _STATUS_CFG.pendiente;
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${cfg.icon}</svg>`;
  }

  function _taskRow(t, isOverdue) {
    const dl = t.deadline
      ? new Date(String(t.deadline).split('T')[0] + 'T00:00:00')
          .toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
      : null;
    const meta = [t.project_nombre, t.client_nombre].filter(Boolean).join(' · ');
    const estado = t.estado || 'pendiente';
    return `<div class="d3-task-row${isOverdue ? ' d3-task-row--overdue' : ''}" data-task-id="${t.id}" onclick="TasksModule.openDrawer(${t.id})">
      <button class="d3-status-btn d3-status-btn--${(_STATUS_CFG[estado]||_STATUS_CFG.pendiente).dot}"
              onclick="event.stopPropagation();DashboardModule.openStatusMenu(event,${t.id})"
              title="Cambiar estado">${_statusSvg(estado)}</button>
      <div class="d3-task-body">
        <span class="d3-task-name${isOverdue ? ' d3-task-name--overdue' : ''}">${esc(t.titulo)}</span>
        ${meta ? `<span class="d3-task-meta">${esc(meta)}</span>` : ''}
      </div>
      ${dl ? `<span class="d3-task-date${isOverdue ? ' d3-task-date--overdue' : ''}">${dl}</span>` : ''}
      <button class="d3-play-btn" data-timer-task="${t.id}" title="Iniciar timer"
              onclick="event.stopPropagation();TimerModule.toggleTask(${t.id})">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
      <span class="task-elapsed" data-timer-display="${t.id}" hidden></span>
    </div>`;
  }

  let _statusMenuClose = null;
  function openStatusMenu(e, taskId) {
    if (_statusMenuClose) { _statusMenuClose(); return; }
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'd3-status-menu';
    const opts = [
      { value: 'pendiente',   label: 'Pendiente',   dot: '#C8BCAC', fill: false },
      { value: 'en_progreso', label: 'En progreso', dot: '#6366F1', fill: true },
      { value: 'completado',  label: 'Completado',  dot: '#22C55E', fill: true },
      { value: 'bloqueado',   label: 'Bloqueado',   dot: '#EF4444', fill: true },
    ];
    menu.innerHTML = opts.map(o => `
      <button class="d3-status-opt" onclick="DashboardModule.setTaskStatus(${taskId},'${o.value}',this)">
        <span class="d3-status-opt__dot" style="background:${o.fill ? o.dot : 'transparent'};border:1.5px solid ${o.dot}"></span>
        ${esc(o.label)}
      </button>`).join('');
    menu.style.cssText = `position:fixed;z-index:9999;top:${rect.bottom + 6}px;left:${rect.left - 4}px`;
    document.body.appendChild(menu);
    _statusMenuClose = () => {
      menu.remove();
      document.removeEventListener('click', _statusMenuClose);
      _statusMenuClose = null;
    };
    setTimeout(() => document.addEventListener('click', _statusMenuClose), 0);
  }

  async function setTaskStatus(taskId, newStatus, optEl) {
    if (_statusMenuClose) _statusMenuClose();
    try {
      await apiFetch(`${API}/mgmt/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: newStatus }),
      });
      const row = document.querySelector(`[data-task-id="${taskId}"]`);
      if (!row) return;
      if (newStatus === 'completado') {
        row.style.transition = 'opacity .35s, transform .35s';
        row.style.opacity = '0';
        row.style.transform = 'translateX(8px)';
        setTimeout(() => { row.remove(); }, 360);
      } else {
        const cfg = _STATUS_CFG[newStatus] || _STATUS_CFG.pendiente;
        const btn = row.querySelector('.d3-status-btn');
        if (btn) {
          btn.className = `d3-status-btn d3-status-btn--${cfg.dot}`;
          btn.innerHTML = _statusSvg(newStatus);
        }
      }
    } catch (err) { console.error('[dash] status update failed', err); }
  }

  function _renderProjects(count) {
    const el = $('dash2-projects');
    if (!el) return;
    el.innerHTML = `
      <div class="d3-card-header">
        <span class="d3-card-title">Mis proyectos</span>
        <span class="d3-card-link" onclick="document.querySelector('[data-tab=mgmt-projects]').click()">Ver todo →</span>
      </div>
      <div class="d3-clients-total" onclick="document.querySelector('[data-tab=mgmt-projects]').click()">
        <span class="d3-clients-num">${count}</span>
        <span class="d3-clients-label">${count === 1 ? 'proyecto activo' : 'proyectos activos'}</span>
      </div>`;
  }

  function _renderClients(clients) {
    const el = $('dash2-clients');
    if (!el) return;
    const count = clients.filter(c => c.estado === 'activo').length;
    el.innerHTML = `
      <div class="d3-card-header">
        <span class="d3-card-title">Clientes activos</span>
        <span class="d3-card-link" onclick="document.querySelector('[data-tab=mgmt-clients]').click()">Ver todo →</span>
      </div>
      <div class="d3-clients-total" onclick="document.querySelector('[data-tab=mgmt-clients]').click()">
        <span class="d3-clients-num">${count}</span>
        <span class="d3-clients-label">${count === 1 ? 'cliente activo' : 'clientes activos'}</span>
      </div>`;
  }

  function _renderAlerts(data, isAdminUser) {
    const el = $('dash2-alerts');
    if (!el) return;
    if (!isAdminUser) { el.classList.add('hidden'); return; }

    el.classList.remove('hidden');

    if (!data || data.total === 0) {
      el.className = 'd3-alerts-wrap d3-alerts-wrap--ok';
      el.innerHTML = `
        <div class="d3-alert-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span class="d3-alert-title">Todo en orden</span>
          <span style="font-size:.62rem;color:#065F46;">Sin pendientes de integridad</span>
        </div>`;
      return;
    }

    el.className = 'd3-alerts-wrap';
    const groups = [
      { key: 'proyectos_sin_tareas',   icon: '📁', label: 'Proyecto sin tareas',    action: () => `document.querySelector('[data-tab=mgmt-tasks]').click()`,    btn: '+ Tarea' },
      { key: 'tareas_sin_deadline',    icon: '📅', label: 'Sin fecha límite',        action: x  => `TasksModule.openDrawer(${x.id})`,                             btn: 'Fijar fecha' },
      { key: 'tareas_sin_responsable', icon: '👤', label: 'Sin responsable',         action: x  => `TasksModule.openDrawer(${x.id})`,                             btn: 'Asignar' },
      { key: 'clientes_sin_proyecto',  icon: '🏢', label: 'Cliente sin proyecto',    action: () => `document.querySelector('[data-tab=mgmt-projects]').click()`, btn: '+ Proyecto' },
    ].filter(g => data[g.key]?.length > 0);

    const itemsHtml = groups.flatMap(g =>
      data[g.key].slice(0, 4).map(item => `
        <div class="d3-alert-row">
          <span class="d3-alert-icon">${g.icon}</span>
          <div class="d3-alert-body">
            <span class="d3-alert-label">${g.label}</span>
            <span class="d3-alert-name">${esc(item.nombre || item.titulo || '')}</span>
          </div>
          <button class="d3-alert-btn" onclick="${g.action(item)}">${g.btn} →</button>
        </div>`)
    ).join('');

    el.innerHTML = `
      <div class="d3-alert-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="#D97706"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>
        <span class="d3-alert-title">Requieren atención</span>
        <span class="d3-alert-count">${data.total}</span>
      </div>
      <div class="d3-alert-items">${itemsHtml}</div>`;
  }

  function _setNavBadge(tabName, count) {
    const badge = document.querySelector(`.snav-item[data-tab="${tabName}"] .snav-badge`);
    if (!badge) return;
    badge.textContent = count > 0 ? count : '';
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  return { load, openStatusMenu, setTaskStatus, _onAvatarClick, openAvatarPicker, closeAvatarPicker, selectAvatar, _avSwitchTab };
})();

// =================================================================
// ANALYTICS MODULE
// =================================================================

const AnalyticsModule = (() => {
  let _data   = null;
  let _charts = [];
  let _state  = { tab: 'rev', period: 'week', member: 'all' };

  // Chart.js global polish
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = 'var(--font)';
    Chart.defaults.animation.duration = 750;
    Chart.defaults.animation.easing = 'easeOutCubic';
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: '#1C1917',
      titleColor: '#A8A29E',
      bodyColor: '#FAFAF9',
      padding: 11,
      cornerRadius: 9,
      displayColors: false,
      titleFont: { size: 11 },
      bodyFont: { size: 13, weight: '600' },
    });
  }

  // ── Date helpers ──────────────────────────────────────────────
  function _weekRange(offsetWeeks = 0) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    // Find most recent Monday (getDay: 0=Sun, 1=Mon…6=Sat)
    const daysSinceMon = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysSinceMon + offsetWeeks * 7);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    return { start: monday.toISOString(), end: nextMonday.toISOString() };
  }

  function _monthRange(offsetMonths = 0) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + offsetMonths;
    const start = new Date(y, m, 1);
    const end   = new Date(y, m + 1, 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function _buildUrl() {
    const cur  = _state.period === 'week' ? _weekRange(0)   : _monthRange(0);
    const prev = _state.period === 'week' ? _weekRange(-1)  : _monthRange(-1);
    return `${API}/analytics/summary`
      + `?start=${encodeURIComponent(cur.start)}&end=${encodeURIComponent(cur.end)}`
      + `&prev_start=${encodeURIComponent(prev.start)}&prev_end=${encodeURIComponent(prev.end)}`;
  }

  // ── Label helpers ─────────────────────────────────────────────
  function _weekLabels() {
    const { start } = _weekRange(0);
    const DAYS = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dow = d.getDay();
      return DAYS[dow === 0 ? 6 : dow - 1];
    });
  }

  function _monthLabels() { return ['Sem 1','Sem 2','Sem 3','Sem 4']; }

  // Fill an API series (e.g. [{date,total}]) into a fixed-slot array
  function _fillDays(series, key) {
    const { start } = _weekRange(0);
    const map = {};
    series.forEach(r => { map[r.date] = r[key]; });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return Number(map[d.toISOString().split('T')[0]] || 0);
    });
  }

  function _fillWeeks(series, key) {
    const { start: ms } = _monthRange(0);
    const origin = new Date(ms);
    const buckets = [0, 0, 0, 0];
    series.forEach(r => {
      const diff = Math.floor((new Date(r.date) - origin) / (7 * 86400 * 1000));
      const idx  = Math.min(3, Math.max(0, diff));
      buckets[idx] += Number(r[key] || 0);
    });
    return buckets;
  }

  function _pct(cur, prv) {
    if (!prv || prv === 0) return null;
    return Math.round((cur - prv) / prv * 100);
  }

  function _fmtH(s) { return Math.round(s / 3600) + 'h'; }
  function _fmtMoney(n, cur) {
    if (!n && n !== 0) return '$0';
    cur = cur || 'USD';
    try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
    catch { return cur + ' ' + Math.round(n).toLocaleString('es-MX'); }
  }
  function _fmtByCur(byCur) {
    const entries = Object.entries(byCur || {}).filter(([, v]) => v > 0);
    if (!entries.length) return _fmtMoney(0, 'USD');
    let totalUSD = 0, noRate = [];
    for (const [cur, amt] of entries) {
      if (cur === 'USD') { totalUSD += amt; }
      else {
        const rate = (window._fxRates || {})[cur];
        if (rate > 0) totalUSD += amt / rate;
        else noRate.push({ cur, amt });
      }
    }
    const usdStr = _fmtMoney(totalUSD, 'USD');
    if (!noRate.length) return usdStr;
    const rawStr = noRate.map(({cur, amt}) => _fmtMoney(amt, cur)).join(' · ');
    return totalUSD > 0 ? `${usdStr} + ${rawStr}` : rawStr;
  }

  // ── Mini sparklines (inline SVG) ──────────────────────────────
  function _svgLine(vals, color) {
    if (!vals || !vals.length) return '';
    const W = 100, H = 34, px = 1, py = 4;
    const max = Math.max(...vals, 1);
    const pts = vals.map((v, i) => ({
      x: px + (i / Math.max(vals.length - 1, 1)) * (W - px * 2),
      y: H - py - (v / max) * (H - py * 2 - 2),
    }));
    // Smooth cubic bezier path
    const line = pts.reduce((acc, p, i) => {
      if (i === 0) return `M${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      const p0 = pts[i - 1];
      const cx = ((p0.x + p.x) / 2).toFixed(2);
      return `${acc} C${cx},${p0.y.toFixed(2)} ${cx},${p.y.toFixed(2)} ${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    }, '');
    const last = pts[pts.length - 1], first = pts[0];
    const fill = `${line} L${last.x.toFixed(2)},${H} L${first.x.toFixed(2)},${H} Z`;
    const uid = 'sg' + Math.random().toString(36).slice(2, 7);
    return `<defs>
      <linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="${fill}" fill="url(#${uid})" stroke="none" class="an-sfill"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" class="an-sline"/>`;
  }

  function _svgBars(vals, color) {
    if (!vals || !vals.length) return '';
    const W = 100, H = 34, px = 2, py = 2;
    const max = Math.max(...vals, 1);
    const step = (W - px * 2) / vals.length;
    const bw = Math.max(5, step * 0.62);
    return vals.map((v, i) => {
      const h = Math.max(v > 0 ? 2.5 : 0, (v / max) * (H - py * 2));
      const x = px + i * step + (step - bw) / 2;
      const y = H - py - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}"
        rx="3" fill="${color}" opacity="${v > 0 ? '1' : '0.12'}"
        class="an-sbar" style="animation-delay:${i * 55}ms"/>`;
    }).join('');
  }

  // ── Load & render mini cards ──────────────────────────────────
  async function load() {
    const el = $('dash2-analytics-mini');
    if (!el) return;

    el.innerHTML = `
      ${_miniSkel('Cobrado (7 días)')}
      ${_miniSkel('Pipeline activo')}
      ${_miniSkel('Tareas completadas')}`;

    try {
      const res = await apiFetch(_buildUrl());
      if (!res.ok) throw new Error(await res.text());
      _data = await res.json();
      _renderMini();
      // If the analytics pane is already open, refresh its charts with new data
      if (!$('dash2-analytics-pane')?.classList.contains('hidden')) _drawCharts();
    } catch (e) {
      console.error('[analytics] load error:', e);
      _data = {
        revenue:  { series: [], total: 0, prev_total: 0, cobrado_count: 0 },
        pipeline: { total: 0, count: 0, pending: 0 },
        tasks:    { completed_series: [], created_series: [], by_member: [], total_completed: 0, prev_completed: 0 },
        time:     { by_member: [], daily_series: [], total_active_s: 0, prev_active_s: 0 },
      };
      _renderMini();
    }
  }

  function _miniSkel(label) {
    return `<div class="an-mini an-mini--loading">
      <div class="an-mini-label">${label}</div>
      <div class="an-mini-val">—</div></div>`;
  }

  function _renderMini() {
    const el = $('dash2-analytics-mini');
    if (!el || !_data) return;
    const { revenue, pipeline, tasks } = _data;

    const rPct = _pct(revenue.total, revenue.prev_total);
    const tPct = _pct(tasks.total_completed, tasks.prev_completed);

    const revSpark  = _svgLine(_fillDays(revenue.series || [], 'total'), '#F88F22');
    const taskSpark = _svgBars(_fillDays(tasks.completed_series || [], 'count'), '#1D9E75');

    const pip = pipeline || { total: 0, count: 0, pending: 0 };
    const pipLabel = pip.count > 0 ? `${pip.count} proy. activo${pip.count !== 1 ? 's' : ''}` : 'Sin proyectos activos';

    const revStr = _fmtByCur(revenue.by_currency);
    const pipStr = _fmtByCur(pip.by_currency);

    el.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:4px">
        <button class="fx-cfg-btn" onclick="FxRatesModule.open()" title="Configurar tasas de cambio">⚙ Tasas</button>
      </div>
      ${_miniCard('rev',   'Cobrado (semana)',   revenue.total, 'money', revStr,         rPct, revSpark)}
      ${_miniCard('rev',   'Pipeline activo',    pip.total,     'money', pipStr,         null, '', pipLabel)}
      ${_miniCard('tasks', 'Tareas completadas', tasks.total_completed, 'count', tasks.total_completed, tPct, taskSpark)}`;

    // Count-up animation only for count values (money already formatted with correct currency)
    el.querySelectorAll('.an-mini-val[data-raw]').forEach(valEl => {
      const raw = +valEl.dataset.raw;
      const type = valEl.dataset.type;
      if (!raw || raw <= 0 || type === 'money') return;
      const dur = 700, t0 = performance.now();
      const tick = now => {
        const p = Math.min((now - t0) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        valEl.textContent = String(Math.round(raw * ease));
        if (p < 1) requestAnimationFrame(tick);
        else valEl.textContent = String(raw);
      };
      requestAnimationFrame(tick);
    });
  }

  function _miniCard(tab, label, rawVal, rawType, val, pct, spark, sublabel) {
    const badge = pct !== null
      ? `<div class="an-mini-badge ${pct >= 0 ? 'an-badge-up' : 'an-badge-dn'}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%</div>`
      : (sublabel ? `<div class="an-mini-sub">${sublabel}</div>` : '');
    const sparkSvg = spark
      ? `<svg class="an-spark" viewBox="0 0 100 34" preserveAspectRatio="none">${spark}</svg>`
      : '';
    return `<div class="an-mini" role="button" tabindex="0"
        onclick="AnalyticsModule.open('${tab}')"
        onkeydown="if(event.key==='Enter')AnalyticsModule.open('${tab}')">
      <div class="an-mini-label">${label}</div>
      <div class="an-mini-val" data-raw="${rawVal}" data-type="${rawType}">${val}</div>
      ${badge}
      ${sparkSvg}
    </div>`;
  }

  // ── Open / close analytics pane ───────────────────────────────
  function open(tab) {
    _state.tab    = tab;
    _state.period = 'week';
    $('d3-grid').classList.add('hidden');
    $('dash2-analytics-pane').classList.remove('hidden');
    _renderPane();
  }

  function close() {
    $('d3-grid').classList.remove('hidden');
    $('dash2-analytics-pane').classList.add('hidden');
    _destroyCharts();
  }

  function _destroyCharts() {
    _charts.forEach(c => { try { c.destroy(); } catch(_) {} });
    _charts = [];
  }

  function switchTab(t) {
    _state.tab = t;
    document.querySelectorAll('.an-tab').forEach(b => b.classList.toggle('an-tab--on', b.dataset.tab === t));
    _drawCharts();
  }

  function switchPeriod(p) {
    _state.period = p;
    document.querySelectorAll('.an-period').forEach(b => b.classList.toggle('an-period--on', b.dataset.period === p));
    // Fetch fresh data for new period then redraw
    apiFetch(_buildUrl())
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { _data = d; _drawCharts(); } })
      .catch(() => {});
  }

  function switchMember(m) {
    _state.member = m;
    _drawCharts();
  }

  // ── Render full analytics pane ────────────────────────────────
  function _renderPane() {
    const el = $('dash2-analytics-pane');
    if (!el) return;

    const isAdmin = window._authUser?.isOwner || ['admin','manager'].includes(window._authUser?.memberRol);
    const memberOpts = (_data?.time?.by_member || [])
      .map(m => `<option value="${esc(m.nombre)}">${esc(m.nombre.split(' ')[0])}</option>`)
      .join('');

    el.innerHTML = `<div class="an-pane-inner">
      <div class="an-pane-hdr">
        <button class="an-back-btn" onclick="AnalyticsModule.close()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Dashboard
        </button>
        <div class="an-hdr-right">
          <div class="an-tabs">
            ${['rev','tasks','time'].map(t => {
              const label = t==='rev'?'Ingresos':t==='tasks'?'Tareas':'Tiempo';
              return `<button class="an-tab${_state.tab===t?' an-tab--on':''}" data-tab="${t}"
                onclick="AnalyticsModule.switchTab('${t}')">${label}</button>`;
            }).join('')}
          </div>
          <div class="an-ctrls">
            <button class="an-period${_state.period==='week'?' an-period--on':''}" data-period="week"
              onclick="AnalyticsModule.switchPeriod('week')">Semana</button>
            <button class="an-period${_state.period==='month'?' an-period--on':''}" data-period="month"
              onclick="AnalyticsModule.switchPeriod('month')">Mes</button>
            ${isAdmin ? `<select class="an-member-sel" onchange="AnalyticsModule.switchMember(this.value)">
              <option value="all">Todo el equipo</option>
              <option value="me">Solo yo</option>
              ${memberOpts}
            </select>` : ''}
          </div>
        </div>
      </div>
      <div class="an-kpi-row" id="an-kpi-row"></div>
      <div class="an-legend" id="an-legend1"></div>
      <div class="an-chart-wrap" id="an-c1-wrap" style="height:210px"><canvas id="an-c1"></canvas></div>
      <hr class="an-divider">
      <div class="an-legend" id="an-legend2"></div>
      <div class="an-chart-wrap" id="an-c2-wrap" style="height:130px"><canvas id="an-c2"></canvas></div>
    </div>`;

    _drawCharts();
  }

  // ── Chart drawing ─────────────────────────────────────────────
  const _xS = {
    grid:   { display: false },
    border: { display: false },
    ticks:  { font: { size: 11 }, color: '#A8A29E' },
  };
  const _yG = {
    grid:   { color: 'rgba(120,113,108,.07)', lineWidth: 1 },
    border: { display: false, dash: [3, 4] },
    ticks:  { font: { size: 11 }, color: '#A8A29E' },
  };

  // Returns a Chart.js backgroundColor callback that creates a vertical gradient
  function _gradFn(r, g, b, a1 = 0.28, a2 = 0.0) {
    return ctx => {
      const { chart } = ctx;
      const { ctx: c, chartArea } = chart;
      if (!chartArea) return `rgba(${r},${g},${b},${a1})`;
      const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      grad.addColorStop(0, `rgba(${r},${g},${b},${a1})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},${a2})`);
      return grad;
    };
  }

  function _mkChart(id, cfg) {
    const canvas = $(id);
    if (!canvas) return;
    const ch = new Chart(canvas, cfg);
    _charts.push(ch);
    return ch;
  }

  function _kpi(items) {
    return items.map(i => `<div class="an-kpi">
      <div class="an-kpi-lbl">${i.l}</div>
      <div class="an-kpi-val">${i.v}</div>
      <div class="an-kpi-sub"${i.c?` style="color:${i.c}"`:''}">${i.s}</div>
    </div>`).join('');
  }

  function _leg(id, items, note) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = items.map(i =>
      `<span class="an-leg-item"><b style="background:${i.c}"></b>${i.l}</span>`
    ).join('') + (note ? `<span class="an-leg-note">— ${note}</span>` : '');
  }

  function _drawCharts() {
    if (!_data) return;
    _destroyCharts();
    const { tab } = _state;
    if (tab === 'rev')   _drawRevenue();
    else if (tab === 'tasks') _drawTasks();
    else                      _drawTime();
  }

  // Revenue ──────────────────────────────────────────────────────
  function _drawRevenue() {
    const d = _data.revenue;
    const fill = _state.period === 'week'
      ? (s, k) => _fillDays(s, k)
      : (s, k) => _fillWeeks(s, k);
    const labels = _state.period === 'week' ? _weekLabels() : _monthLabels();

    const cur  = fill(d.series || [], 'total');
    // For the previous period comparison line we show prev_total as a flat baseline
    // (we only have prev total, not daily series for prev period in a simple call)
    const tot  = cur.reduce((a,b)=>a+b,0);
    const pct  = _pct(tot, d.prev_total);
    const best = Math.max(...cur, 0);
    const bestLbl = labels[cur.indexOf(best)] || '';
    const active = cur.filter(v=>v>0).length || 1;

    const pip2 = _data.pipeline || { total: 0, count: 0, pending: 0 };
    const cobCount = _data.revenue?.cobrado_count || 0;
    const cobSub = cobCount > 0
      ? cobCount + ' tarea' + (cobCount !== 1 ? 's' : '') + ' cobrada' + (cobCount !== 1 ? 's' : '')
      : (pct !== null ? (pct >= 0 ? '↑' : '↓') + ' ' + Math.abs(pct) + '% vs período anterior' : 'Sin cobros en el período');

    const cobradoStr = _fmtByCur(_data.revenue?.by_currency);
    const pendingStr = _fmtByCur(pip2.pending_by_currency);

    const periodH   = (_data.time?.total_active_s || 0) / 3600;
    const totUSD    = (() => {
      let s = 0;
      for (const [cur, amt] of Object.entries(_data.revenue?.by_currency || {})) {
        if (!amt) continue;
        if (cur === 'USD') s += amt;
        else { const r = (window._fxRates||{})[cur]; if (r > 0) s += amt / r; }
      }
      return s;
    })();
    const avgPerH    = periodH > 0 && totUSD > 0 ? Math.round(totUSD / periodH) : 0;
    const avgPerHStr = avgPerH > 0 ? _fmtMoney(avgPerH, 'USD') + '/h' : '—';
    const avgPerHSub = periodH > 0 ? periodH.toFixed(1) + 'h trabajadas en el período' : 'Sin horas registradas';

    $('an-kpi-row').innerHTML = _kpi([
      { l:'Cobrado',         v: cobradoStr,  s: cobSub, c: '' },
      { l:'Por cobrar',      v: pendingStr,  s: pip2.pending > 0 ? 'tareas con monto sin cobrar' : 'Todo cobrado ✓' },
      { l:'Promedio / hora', v: avgPerHStr,  s: avgPerHSub },
    ]);
    _leg('an-legend1', [{ c:'#F88F22', l:'Facturación' }]);
    _leg('an-legend2', [{ c:'#F88F22', l:'Cobrado diario' }, { c:'rgba(180,178,169,.5)', l:'Sin cobro' }], 'desglose por día');

    $('an-c1-wrap').style.height = '210px';
    _mkChart('an-c1', {
      type: 'line',
      data: { labels, datasets: [{
        data: cur, borderColor: '#F88F22',
        backgroundColor: _gradFn(248, 143, 34, 0.30),
        fill: true, tension: .4, borderWidth: 2.5,
        pointRadius: 4, pointHoverRadius: 6,
        pointBackgroundColor: '#F88F22', pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: '#F88F22', pointHoverBorderWidth: 2.5,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false,
          callbacks: { label: c => ' ' + _fmtMoney(c.raw) } } },
        scales: { x: _xS, y: { ..._yG, ticks: { ..._yG.ticks, callback: v => '$' + (v >= 1000 ? Math.round(v/1000) + 'k' : v) } } }
      }
    });

    // Second chart: daily hours worked as context for revenue
    const dailyH = _fillDays(_data.time.daily_series || [], 'active_s').map(v => Math.round(v / 360) / 10);
    _leg('an-legend2', [{ c:'#378ADD', l:'Horas activas' }], 'contexto de tiempo del período');
    $('an-c2-wrap').style.height = '120px';
    _mkChart('an-c2', {
      type: 'bar',
      data: { labels, datasets: [{
        data: dailyH,
        backgroundColor: _gradFn(55, 138, 221, 0.70),
        borderRadius: 5, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.raw + 'h' } } },
        scales: { x: _xS, y: { ..._yG, ticks: { ..._yG.ticks, callback: v => v + 'h' } } }
      }
    });
  }

  // Tasks ────────────────────────────────────────────────────────
  function _drawTasks() {
    const d = _data.tasks;
    const fill = _state.period === 'week'
      ? (s, k) => _fillDays(s, k)
      : (s, k) => _fillWeeks(s, k);
    const labels = _state.period === 'week' ? _weekLabels() : _monthLabels();

    const done = fill(d.completed_series || [], 'count');
    const made = fill(d.created_series   || [], 'count');
    const totD = done.reduce((a,b)=>a+b, 0);
    const totM = made.reduce((a,b)=>a+b, 0);
    const pct  = _pct(totD, d.prev_completed);
    const rate = Math.round(totD / Math.max(totM,1) * 100);

    $('an-kpi-row').innerHTML = _kpi([
      { l:'Completadas', v:totD, s: pct!==null?(pct>=0?'↑':'↓')+' '+Math.abs(pct)+'% vs período anterior':'Sin comparativa', c: pct!==null?(pct>=0?'#27500A':'#791F1F'):'' },
      { l:'Creadas',     v:totM, s: totD>=totM?'Backlog bajando ✓':'Backlog creciendo ⚠' },
      { l:'Tasa',        v:rate+'%', s:'completadas vs creadas' },
    ]);
    _leg('an-legend1', [{ c:'#1D9E75', l:'Completadas' }, { c:'rgba(180,178,169,.6)', l:'Creadas' }]);

    $('an-c1-wrap').style.height = '210px';
    _mkChart('an-c1', {
      type: 'bar',
      data: { labels, datasets: [
        { data:done, backgroundColor:'#1D9E75', borderRadius:4, borderSkipped:false },
        { data:made, backgroundColor:'rgba(180,178,169,.4)', borderColor:'#C4C2BA', borderWidth:1, borderRadius:4, borderSkipped:false },
      ]},
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ mode:'index', intersect:false } },
        scales:{ x:_xS, y:{..._yG, ticks:{..._yG.ticks, stepSize:1}} }
      }
    });

    // By member
    const members = (_state.member === 'all')
      ? (d.by_member || [])
      : (d.by_member || []).filter(m => m.nombre === _state.member || (_state.member === 'me' && m.nombre === (window._authUser?.memberNombre || window._authUser?.name)));

    const mbLabels = members.map(m => m.nombre.split(' ')[0]);
    const mbDone   = members.map(m => m.completed);
    const mbOver   = members.map(m => m.overdue);
    _leg('an-legend2', [{ c:'#1D9E75', l:'Completadas' }, { c:'#E24B4A', l:'Vencidas' }], 'por miembro');

    const h2 = Math.max(4, members.length) * 52 + 70;
    $('an-c2-wrap').style.height = h2 + 'px';
    _mkChart('an-c2', {
      type: 'bar',
      data: { labels: mbLabels.length ? mbLabels : ['Sin datos'], datasets: [
        { data: mbDone.length ? mbDone : [0], backgroundColor:'#1D9E75', borderRadius:4, borderSkipped:false },
        { data: mbOver.length ? mbOver : [0], backgroundColor:'#E24B4A', borderRadius:4, borderSkipped:false },
      ]},
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ mode:'index', intersect:false } },
        scales:{ x:_xS, y:{..._yG, ticks:{..._yG.ticks, stepSize:1}} }
      }
    });
  }

  // Time ─────────────────────────────────────────────────────────
  function _drawTime() {
    const d = _data.time;
    const myName = window._authUser?.memberNombre || window._authUser?.name || '';
    const members = _state.member === 'all'
      ? (d.by_member || [])
      : _state.member === 'me'
        ? (d.by_member || []).filter(m => m.nombre === myName)
        : (d.by_member || []).filter(m => m.nombre === _state.member);

    const labels  = members.map(m => m.nombre.split(' ')[0]);
    const activeH = members.map(m => Math.round(m.active_s / 360) / 10);
    const totalH  = members.map(m => Math.round(m.total_s  / 360) / 10);

    const totAct = members.reduce((s,m)=>s+m.active_s,0);
    const totReg = members.reduce((s,m)=>s+m.total_s, 0);
    const prod   = totReg > 0 ? Math.round(totAct/totReg*100) : 0;
    const pct    = _pct(d.total_active_s, d.prev_active_s);

    $('an-kpi-row').innerHTML = _kpi([
      { l:'Horas activas',     v:_fmtH(totAct), s: pct!==null?(pct>=0?'↑':'↓')+' '+Math.abs(pct)+'% vs período anterior':'Sin comparativa', c: pct!==null?(pct>=0?'#27500A':'#791F1F'):'' },
      { l:'Total registrado',  v:_fmtH(totReg), s:members.length+' persona'+(members.length!==1?'s':'') },
      { l:'Productividad',     v:prod+'%',       s:'tiempo activo vs registrado' },
    ]);
    _leg('an-legend1', [{ c:'#378ADD', l:'Horas activas' }, { c:'#B5D4F4', l:'Total registrado' }]);

    const h1 = Math.max(4, members.length) * 52 + 60;
    $('an-c1-wrap').style.height = h1 + 'px';
    _mkChart('an-c1', {
      type: 'bar',
      data: { labels: labels.length ? labels : ['Sin datos'], datasets: [
        { data: activeH.length ? activeH : [0], backgroundColor:'#378ADD', borderRadius:4, borderSkipped:false },
        { data: totalH.length  ? totalH  : [0], backgroundColor:'#B5D4F4', borderRadius:4, borderSkipped:false },
      ]},
      options: {
        indexAxis:'y',
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ mode:'index', intersect:false, callbacks:{ label:c=>' '+c.raw+'h' } } },
        scales:{
          y:{ grid:{display:false}, ticks:{font:{size:12}} },
          x:{..._yG, ticks:{..._yG.ticks, callback:v=>v+'h'}}
        }
      }
    });

    // Daily hours line
    const dayLabels = _weekLabels();
    const dailyH    = _fillDays(d.daily_series || [], 'active_s').map(v => Math.round(v/360)/10);
    _leg('an-legend2', [{ c:'#378ADD', l:'Horas activas diarias' }]);

    $('an-c2-wrap').style.height = '130px';
    _mkChart('an-c2', {
      type: 'line',
      data: { labels: dayLabels, datasets: [{
        data: dailyH, borderColor: '#378ADD',
        backgroundColor: _gradFn(55, 138, 221, 0.28),
        fill: true, tension: .4, borderWidth: 2.5,
        pointRadius: 4, pointHoverRadius: 6,
        pointBackgroundColor: '#378ADD', pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: '#378ADD', pointHoverBorderWidth: 2.5,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.raw + 'h' } } },
        scales: { x: _xS, y: { ..._yG, ticks: { ..._yG.ticks, callback: v => v + 'h' } } }
      }
    });
  }

  return { load, open, close, switchTab, switchPeriod, switchMember };
})();

// =================================================================
// TASKS MODULE
// =================================================================

const TasksModule = (() => {
  let _tasks        = [];
  let _editId       = null;
  let _filterEstado = '';
  let _filterPrio   = '';
  let _filterMember = '';
  let _filterFecha  = '';
  let _teamMembers  = [];
  let _currentView  = 'list';
  let _calYear      = new Date().getFullYear();
  let _qeTaskId     = null;
  let _calMonth     = new Date().getMonth();
  let _calView      = 'mes';
  let _calWeekOf    = (() => {
    const d = new Date(); d.setHours(0,0,0,0);
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return d;
  })();
  let _calDayOf     = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

  // ── Badge helpers ──────────────────────────────────────────────────

  function _estadoBadge(estado) {
    const icons = {
      pendiente:   `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#9CA3AF" stroke-width="1.5" stroke-dasharray="2.8 1.8"/></svg>`,
      en_progreso: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#F97316" stroke-width="1.5"/><path d="M7 1.5 A5.5 5.5 0 0 0 7 12.5 Z" fill="#F97316"/></svg>`,
      bloqueado:   `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#EF4444" stroke-width="1.5"/><line x1="4.5" y1="4.5" x2="9.5" y2="9.5" stroke="#EF4444" stroke-width="1.5" stroke-linecap="round"/><line x1="9.5" y1="4.5" x2="4.5" y2="9.5" stroke="#EF4444" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      completado:  `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" fill="#22C55E"/><polyline points="4.5,7.5 6.5,9.5 9.5,5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    };
    const labels = { pendiente:'Pendiente', en_progreso:'En progreso', bloqueado:'Bloqueado', completado:'Completado' };
    const key = estado || 'pendiente';
    return `<span class="tsb tsb--${key} tsb--static">${icons[key]||icons.pendiente}${labels[key]||key}</span>`;
  }

  function _prioridadBadge(prioridad) {
    const map = {
      alta:  { bg: '#FBBFB0', color: '#9F1239', label: '↑ Alta' },
      media: { bg: '#FDE68A', color: '#78350F', label: '→ Media' },
      baja:  { bg: '#E7E5E0', color: '#57534E', label: '↓ Baja' },
    };
    const m = map[prioridad] || map.media;
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function _deadlineCell(d, estado) {
    if (!d) return '<span class="muted">—</span>';
    const date    = new Date(String(d).split('T')[0] + 'T00:00:00');
    const today   = new Date(); today.setHours(0,0,0,0);
    const overdue = date < today && estado !== 'completado';
    const label   = date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    return overdue
      ? `<span style="color:#DC2626;font-weight:600">⚠ ${label}</span>`
      : label;
  }

  // ── Load ───────────────────────────────────────────────────────────

  function _hideAllViews() {
    ['tasks-view-list', 'tasks-view-kanban', 'tasks-view-calendar'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
  }

  function _applyView() {
    _hideAllViews();
    const toolbar   = $('tasks-list-toolbar');
    const estadoSel = $('tasks-estado-select');
    const showBar   = _currentView === 'list' || _currentView === 'kanban';
    if (toolbar)   toolbar.style.display   = showBar ? '' : 'none';
    if (estadoSel) estadoSel.style.display = _currentView === 'list' ? '' : 'none';
    const viewEl = $('tasks-view-' + _currentView);
    if (viewEl) viewEl.style.display = '';
    if (_currentView === 'list')     render();
    if (_currentView === 'kanban')   _renderKanban();
    if (_currentView === 'calendar') _renderCalendar($('tasks-cal-inner'));
  }

  function _populateMemberFilter() {
    const sel = $('tasks-member-filter');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Miembro</option><option value="__none__">Sin asignar</option>';
    (_teamMembers || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.nombre;
      opt.textContent = m.nombre;
      if (m.nombre === prev) opt.selected = true;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  async function load() {
    const loading = $('tasks-loading');
    if (!loading) return;
    loading.style.display = 'flex';
    _hideAllViews();
    try {
      const [tasksRes, teamRes] = await Promise.all([
        apiFetch(`${API}/mgmt/tasks`),
        apiFetch(`${API}/mgmt/team`),
      ]);
      if (tasksRes.status === 401) { location.reload(); return; }
      if (!tasksRes.ok) throw new Error(await tasksRes.text());
      _tasks       = await tasksRes.json();
      _teamMembers = teamRes.ok ? await teamRes.json() : [];
      _populateMemberFilter();
      _applyView();
    } catch (e) {
      console.error('[tasks] load error:', e);
      loading.innerHTML = '<span style="color:var(--err)">Error al cargar tareas.</span>';
    } finally {
      loading.style.display = 'none';
    }
  }

  // ── View switching ─────────────────────────────────────────────────

  function setView(v) {
    _currentView = v;
    document.querySelectorAll('#tasks-view-tabs .view-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === v);
    });
    _applyView();
  }

  // ── Lista / Kanban shared ───────────────────────────────────────────

  let _dragTaskId = null;

  function _rerender() {
    if (_currentView === 'kanban') _renderKanban();
    else render();
  }

  function _getFilteredTasks() {
    const q = ($('tasks-search')?.value || '').toLowerCase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today); endOfWeek.setDate(today.getDate() + (6 - today.getDay()));
    let list = _tasks;
    if (_filterPrio) list = list.filter(t => t.prioridad === _filterPrio);
    if (_filterMember === '__none__') {
      list = list.filter(t => !t.responsable && (!t.responsables || !t.responsables.length));
    } else if (_filterMember) {
      const lm = _filterMember.toLowerCase();
      list = list.filter(t =>
        (t.responsables || []).some(r => r.toLowerCase() === lm) ||
        (t.responsable || '').toLowerCase() === lm
      );
    }
    if (_filterFecha) {
      list = list.filter(t => {
        const d = t.deadline ? new Date(String(t.deadline).split('T')[0] + 'T00:00:00') : null;
        if (_filterFecha === 'hoy')       return d && d.getTime() === today.getTime();
        if (_filterFecha === 'semana')    return d && d >= today && d <= endOfWeek;
        if (_filterFecha === 'vencido')   return d && d < today && t.estado !== 'completado';
        if (_filterFecha === 'sin_fecha') return !d;
        return true;
      });
    }
    if (q) list = list.filter(t =>
      (t.titulo + ' ' + (t.project_nombre || '') + ' ' + (t.client_nombre || '') + ' ' + (t.responsable || '') + ' ' + (t.responsables || []).join(' ')).toLowerCase().includes(q)
    );
    return list;
  }

  function filter() { _rerender(); }

  function setFilter(estado) {
    _filterEstado = estado;
    const sel = $('tasks-estado-select');
    if (sel) { sel.value = estado; sel.classList.toggle('filter-select--active', !!estado); }
    render();
  }

  function setFilterPrio(prio) {
    _filterPrio = prio;
    const sel = $('tasks-prio-select');
    if (sel) { sel.value = prio; sel.classList.toggle('filter-select--active', !!prio); }
    _rerender();
  }

  function setFilterMember(member) {
    _filterMember = member;
    const sel = $('tasks-member-filter');
    if (sel) sel.classList.toggle('filter-select--active', !!member);
    _rerender();
  }

  function setFilterFecha(fecha) {
    _filterFecha = fecha;
    const sel = $('tasks-fecha-select');
    if (sel) { sel.value = fecha; sel.classList.toggle('filter-select--active', !!fecha); }
    _rerender();
  }

  function render() {
    const tbody     = $('tasks-tbody');
    const empty     = $('tasks-empty');
    const tableWrap = $('tasks-table-wrap');
    if (!tbody) return;

    const q = ($('tasks-search')?.value || '').toLowerCase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today); endOfWeek.setDate(today.getDate() + (6 - today.getDay()));

    let list = _tasks;
    if (_filterEstado) list = list.filter(t => t.estado === _filterEstado);
    if (_filterPrio)   list = list.filter(t => t.prioridad === _filterPrio);
    if (_filterMember === '__none__') {
      list = list.filter(t => !t.responsable && (!t.responsables || !t.responsables.length));
    } else if (_filterMember) {
      const lm = _filterMember.toLowerCase();
      list = list.filter(t =>
        (t.responsables || []).some(r => r.toLowerCase() === lm) ||
        (t.responsable || '').toLowerCase() === lm
      );
    }
    if (_filterFecha) {
      list = list.filter(t => {
        const d = t.deadline ? new Date(String(t.deadline).split('T')[0] + 'T00:00:00') : null;
        if (_filterFecha === 'hoy')      return d && d.getTime() === today.getTime();
        if (_filterFecha === 'semana')   return d && d >= today && d <= endOfWeek;
        if (_filterFecha === 'vencido')  return d && d < today && t.estado !== 'completado';
        if (_filterFecha === 'sin_fecha') return !d;
        return true;
      });
    }
    if (q) list = list.filter(t =>
      (t.titulo + ' ' + (t.project_nombre || '') + ' ' + (t.client_nombre || '') + ' ' + (t.responsable || '') + ' ' + (t.responsables || []).join(' ')).toLowerCase().includes(q)
    );

    if (!list.length) {
      tableWrap.style.display = 'none';
      empty.style.display     = 'flex';
      return;
    }
    empty.style.display     = 'none';
    tableWrap.style.display = '';

    const prioColors = { alta: '#F87171', media: '#FBBF24', baja: '#6EE7B7' };

    tbody.innerHTML = list.map(t => `
      <tr class="clients-table__row" onclick="TasksModule.openDrawer(${t.id})">
        <td class="ct-name-cell">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <div style="width:8px;height:8px;border-radius:2px;background:${prioColors[t.prioridad] || '#FBBF24'};flex-shrink:0"></div>
            <span class="ct-name">${esc(t.titulo)}</span>
          </div>
        </td>
        <td class="client-meta ct-proj-cell">
          ${t.project_nombre ? `<span style="white-space:nowrap">${esc(t.project_nombre)}${t.client_nombre ? ' <span style="color:var(--muted)">· ' + esc(t.client_nombre) + '</span>' : ''}</span>` : '<span class="muted">—</span>'}
        </td>
        <td class="tip-cell" onclick="event.stopPropagation();TasksModule.openQuickEdit(event,${t.id})">${_estadoBadge(t.estado)}</td>
        <td class="tip-cell" onclick="event.stopPropagation();TasksModule.openQuickEdit(event,${t.id})">${_prioridadBadge(t.prioridad)}</td>
        <td class="tip-cell" onclick="event.stopPropagation();TasksModule.openQuickEdit(event,${t.id})">${_deadlineCell(t.deadline, t.estado)}</td>
        <td class="tip-cell" onclick="event.stopPropagation();TasksModule.openQuickEdit(event,${t.id})">${(t.responsables?.length ? t.responsables : t.responsable ? [t.responsable] : []).map(r=>`<span class="resp-pill">${esc(r)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td onclick="event.stopPropagation()" class="tt-task-timer-cell">
          <span class="task-elapsed" data-timer-display="${t.id}" hidden></span>
          <button class="tt-task-play-btn" data-timer-task="${t.id}" title="Iniciar timer"
            onclick="TimerModule.toggleTask(${t.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </td>
        <td>
          <div class="client-actions-cell">
            <button class="client-action-btn" title="Editar"
              onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="client-action-btn client-action-btn--danger" title="Eliminar"
              onclick="event.stopPropagation();TasksModule.confirmDelete(${t.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // ── Kanban view ────────────────────────────────────────────────────

  function _renderKanban() {
    const prioColor = { alta: '#EF4444', media: '#F59E0B', baja: '#22C55E' };
    const filtered  = _getFilteredTasks();

    for (const estado of ['bloqueado', 'pendiente', 'en_progreso', 'completado']) {
      const colEl   = $('kanban-col-' + estado);
      const countEl = $('kanban-count-' + estado);
      if (!colEl) continue;

      const tasks = filtered.filter(t => t.estado === estado);
      if (countEl) countEl.textContent = tasks.length;

      if (!tasks.length) {
        colEl.innerHTML = '<div class="kanban-empty">Sin tareas</div>';
      } else {
        colEl.innerHTML = tasks.map(t => {
          const dot = prioColor[t.prioridad] || prioColor.media;
          const respArr = t.responsables?.length ? t.responsables : (t.responsable ? [t.responsable] : []);
          const whoHtml = respArr.map(r => {
            const ini = r.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
            return `<span class="kc-who" title="${esc(r)}">${ini}</span>`;
          }).join('');
          return `<div class="kanban-card" draggable="true"
            ondragstart="TasksModule.kanbanDragStart(event,${t.id})"
            ondragend="TasksModule.kanbanDragEnd(event)"
            onclick="TasksModule.openDrawer(${t.id})">
            <div class="kc-top">
              <span class="kc-dot" style="background:${dot}"></span>
              <span class="kc-title">${esc(t.titulo)}</span>
            </div>
            <div class="kc-meta">
              ${t.project_nombre ? `<span class="kc-proj">${esc(t.project_nombre)}</span>` : '<span></span>'}
              <div class="kc-actions">
                ${whoHtml}
                <span class="task-elapsed" data-timer-display="${t.id}" hidden></span>
                <button class="kc-play-btn" data-timer-task="${t.id}" title="Iniciar timer"
                        onclick="event.stopPropagation();TimerModule.toggleTask(${t.id})">
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:100%;height:100%"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
              </div>
            </div>
          </div>`;
        }).join('');
      }

      // drop zone — set after innerHTML (element-level, survives children changes)
      const _e = estado;
      colEl.ondragover  = ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; colEl.classList.add('kanban-cards--over'); };
      colEl.ondragleave = ev => { if (!colEl.contains(ev.relatedTarget)) colEl.classList.remove('kanban-cards--over'); };
      colEl.ondrop      = ev => {
        ev.preventDefault();
        colEl.classList.remove('kanban-cards--over');
        const id = _dragTaskId ?? parseInt(ev.dataTransfer.getData('text/plain'), 10);
        if (id) TasksModule.moveTaskToStatus(id, _e);
      };
    }
    TimerModule.syncButtons();
  }

  function kanbanDragStart(e, taskId) {
    _dragTaskId = taskId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(taskId));
    const card = e.target.closest ? e.target.closest('.kanban-card') : e.target;
    setTimeout(() => { if (card) card.classList.add('kanban-card--dragging'); }, 0);
  }

  function kanbanDragEnd(e) {
    const card = e.target.closest ? e.target.closest('.kanban-card') : e.target;
    if (card) card.classList.remove('kanban-card--dragging');
    document.querySelectorAll('.kanban-cards--over').forEach(el => el.classList.remove('kanban-cards--over'));
    _dragTaskId = null;
  }

  async function moveTaskToStatus(taskId, estado) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task || task.estado === estado) return;
    task.estado = estado;
    _renderKanban();
    try {
      await apiFetch(`${API}/mgmt/tasks/${taskId}/status`, {
        method: 'PATCH', body: JSON.stringify({ estado })
      });
    } catch {
      task.estado = task.estado; // already mutated; silent fail
    }
  }

  // ── Calendar view ──────────────────────────────────────────────────

  // ── Calendar helpers ──────────────────────────────────────────────
  const _MONTHS       = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const _MONTHS_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const _DAYS_SHORT   = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const _DAYNAMES     = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const _PRIO_BG      = { alta: '#FBBFB0', media: '#FDE68A', baja: '#E7E5E0' };
  const _PRIO_COL     = { alta: '#9F1239', media: '#78350F', baja: '#57534E' };
  const _EST_BG       = { pendiente:'#E7E5E0', en_curso:'#A7F3D0', bloqueado:'#FBBFB0', completado:'#BAE6FD' };
  const _EST_COL      = { pendiente:'#57534E', en_curso:'#065F46', bloqueado:'#9F1239', completado:'#0369A1' };
  const _EST_LBL      = { pendiente:'Pendiente', en_curso:'En curso', bloqueado:'Bloqueado', completado:'Completado' };
  const _arrowL       = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  const _arrowR       = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  function _isoDate(d) {
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  function _viewToggle() {
    return `<div class="cal-view-toggle">
      <button class="cal-vbtn${_calView==='mes'?' active':''}" onclick="TasksModule.setCalView('mes')">Mes</button>
      <button class="cal-vbtn${_calView==='semana'?' active':''}" onclick="TasksModule.setCalView('semana')">Semana</button>
      <button class="cal-vbtn${_calView==='dia'?' active':''}" onclick="TasksModule.setCalView('dia')">Día</button>
    </div>`;
  }

  // ── Month view (also used by mini cal in tasks list) ───────────────
  function _renderCalendar(el, fullPage = false) {
    if (!el) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const pad   = n => String(n).padStart(2, '0');
    const todayStr  = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
    const firstDay  = new Date(_calYear, _calMonth, 1);
    const totalDays = new Date(_calYear, _calMonth + 1, 0).getDate();
    const firstDow  = (firstDay.getDay() + 6) % 7;

    const byDate = {};
    for (const t of _tasks) {
      if (!t.deadline) continue;
      const d = t.deadline.split('T')[0];
      (byDate[d] = byDate[d] || []).push(t);
    }

    let cells = '';
    for (let i = 0; i < firstDow; i++)
      cells += '<div class="cal-cell cal-cell--blank"></div>';

    for (let d = 1; d <= totalDays; d++) {
      const ds       = `${_calYear}-${pad(_calMonth+1)}-${pad(d)}`;
      const isToday  = ds === todayStr;
      const isPast   = new Date(ds + 'T00:00:00') < today;
      const dayTasks = byDate[ds] || [];
      const visible  = dayTasks.slice(0, 3);
      const overflow = dayTasks.length - visible.length;
      const chips    = visible.map(t => {
        const od  = isPast && t.estado !== 'completado';
        const bg  = od ? '#FEE2E2' : (_PRIO_BG[t.prioridad] || _PRIO_BG.media);
        const col = od ? '#9F1239' : (_PRIO_COL[t.prioridad] || _PRIO_COL.media);
        return `<div class="cal-chip" style="background:${bg};color:${col}${od?';border-color:#FCA5A5':''}" onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})" title="${esc(t.titulo)}">${esc(t.titulo)}</div>`;
      }).join('');
      const more = overflow > 0 ? `<div class="cal-chip cal-chip--more">+${overflow}</div>` : '';
      cells += `<div class="cal-cell${isToday?' cal-cell--today':''}"><span class="cal-cell__num">${d}</span>${chips}${more}</div>`;
    }

    const filled = firstDow + totalDays;
    const trail  = filled % 7 ? 7 - (filled % 7) : 0;
    for (let i = 0; i < trail; i++)
      cells += '<div class="cal-cell cal-cell--blank"></div>';

    el.innerHTML = `<div class="cal-wrap${fullPage?' cal-wrap--full':''}">
      <div class="cal-nav">
        ${fullPage ? _viewToggle() : ''}
        <button class="cal-nav-btn" onclick="TasksModule.calPrev()">${_arrowL}</button>
        <span class="cal-month-label">${_MONTHS[_calMonth]} ${_calYear}</span>
        <button class="cal-nav-btn" onclick="TasksModule.calNext()">${_arrowR}</button>
      </div>
      <div class="cal-grid${fullPage?' cal-grid--full':''}">
        <div class="cal-dow">L</div><div class="cal-dow">M</div><div class="cal-dow">X</div><div class="cal-dow">J</div><div class="cal-dow">V</div><div class="cal-dow">S</div><div class="cal-dow">D</div>
        ${cells}
      </div>
    </div>`;
  }

  // ── Week view ──────────────────────────────────────────────────────
  function _renderWeekCal(el) {
    if (!el) return;
    const today  = new Date(); today.setHours(0,0,0,0);
    const monday = new Date(_calWeekOf);
    const sunday = new Date(monday.getTime() + 6*86400000);
    const label  = monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()}–${sunday.getDate()} ${_MONTHS_SHORT[monday.getMonth()]} ${monday.getFullYear()}`
      : `${monday.getDate()} ${_MONTHS_SHORT[monday.getMonth()]} – ${sunday.getDate()} ${_MONTHS_SHORT[sunday.getMonth()]} ${sunday.getFullYear()}`;

    const cols = Array.from({length:7}, (_,i) => {
      const day     = new Date(monday.getTime() + i*86400000);
      const ds      = _isoDate(day);
      const isToday = day.getTime() === today.getTime();
      const isPast  = day < today;
      const chips   = _tasks.filter(t => t.deadline && t.deadline.split('T')[0] === ds).map(t => {
        const od = isPast && t.estado !== 'completado';
        const bg = od ? '#FEE2E2' : (_PRIO_BG[t.prioridad] || _PRIO_BG.media);
        const co = od ? '#9F1239' : (_PRIO_COL[t.prioridad] || _PRIO_COL.media);
        return `<div class="cal-chip" style="background:${bg};color:${co}${od?';border-color:#FCA5A5':''}" onclick="TasksModule.openDrawer(${t.id})" title="${esc(t.titulo)}">${esc(t.titulo)}</div>`;
      }).join('');
      return `<div class="cal-week-col${isToday?' cal-week-col--today':''}">
        <div class="cal-week-col__head">
          <span class="cal-week-dow">${_DAYS_SHORT[i]}</span>
          <span class="cal-week-num${isToday?' cal-week-num--today':''}">${day.getDate()}</span>
        </div>
        <div class="cal-week-body">${chips||'<span class="cal-week-empty">—</span>'}</div>
      </div>`;
    }).join('');

    el.innerHTML = `<div class="cal-wrap cal-wrap--full">
      <div class="cal-nav">
        ${_viewToggle()}
        <button class="cal-nav-btn" onclick="TasksModule.calPrev()">${_arrowL}</button>
        <span class="cal-month-label">Semana ${label}</span>
        <button class="cal-nav-btn" onclick="TasksModule.calNext()">${_arrowR}</button>
      </div>
      <div class="cal-week-grid">${cols}</div>
    </div>`;
  }

  // ── Day view ───────────────────────────────────────────────────────
  function _renderDayCal(el) {
    if (!el) return;
    const today  = new Date(); today.setHours(0,0,0,0);
    const ds     = _isoDate(_calDayOf);
    const isPast = _calDayOf < today;
    const label  = `${_DAYNAMES[_calDayOf.getDay()]} ${_calDayOf.getDate()} ${_MONTHS_SHORT[_calDayOf.getMonth()]} ${_calDayOf.getFullYear()}`;

    const items = _tasks.filter(t => t.deadline && t.deadline.split('T')[0] === ds).map(t => {
      const od = isPast && t.estado !== 'completado';
      return `<div class="cal-day-item${od?' cal-day-item--overdue':''}" onclick="TasksModule.openDrawer(${t.id})">
        <div class="cal-day-item__bar" style="background:${_EST_BG[t.estado]||'#E7E5E0'}"></div>
        <div class="cal-day-item__body">
          <div class="cal-day-item__title">${esc(t.titulo)}</div>
          <div class="cal-day-item__meta">
            ${(t.responsables?.length ? t.responsables : t.responsable ? [t.responsable] : []).map(r=>`<span class="cal-day-meta-tag">${esc(r)}</span>`).join('')}
            <span class="client-badge" style="background:${_EST_BG[t.estado]||'#E7E5E0'};color:${_EST_COL[t.estado]||'#57534E'}">${_EST_LBL[t.estado]||t.estado}</span>
            ${od?`<span class="client-badge" style="background:#FEE2E2;color:#9F1239">Vencida</span>`:''}
          </div>
        </div>
      </div>`;
    }).join('') || '<div style="padding:40px;text-align:center;color:var(--muted)">Sin tareas con deadline este día</div>';

    el.innerHTML = `<div class="cal-wrap cal-wrap--full">
      <div class="cal-nav">
        ${_viewToggle()}
        <button class="cal-nav-btn" onclick="TasksModule.calPrev()">${_arrowL}</button>
        <span class="cal-month-label" style="min-width:240px">${label}</span>
        <button class="cal-nav-btn" onclick="TasksModule.calNext()">${_arrowR}</button>
      </div>
      <div class="cal-day-list">${items}</div>
    </div>`;
  }

  // ── Full-pane dispatcher ───────────────────────────────────────────
  function _renderFullCal(el) {
    if (_calView === 'semana') return _renderWeekCal(el);
    if (_calView === 'dia')    return _renderDayCal(el);
    return _renderCalendar(el, true);
  }

  function setCalView(v) {
    _calView = v;
    const calPane = $('cal-pane-container');
    if (calPane && calPane.style.display !== 'none') _renderFullCal(calPane);
  }

  function calPrev() {
    if (_calView === 'mes') {
      if (--_calMonth < 0) { _calMonth = 11; _calYear--; }
    } else if (_calView === 'semana') {
      _calWeekOf = new Date(_calWeekOf.getTime() - 7*86400000);
    } else {
      _calDayOf = new Date(_calDayOf.getTime() - 86400000);
    }
    _rerenderActiveCal();
  }

  function calNext() {
    if (_calView === 'mes') {
      if (++_calMonth > 11) { _calMonth = 0; _calYear++; }
    } else if (_calView === 'semana') {
      _calWeekOf = new Date(_calWeekOf.getTime() + 7*86400000);
    } else {
      _calDayOf = new Date(_calDayOf.getTime() + 86400000);
    }
    _rerenderActiveCal();
  }

  function _rerenderActiveCal() {
    const tasksCal = $('tasks-cal-inner');
    const calPane  = $('cal-pane-container');
    if (tasksCal && $('tasks-view-calendar')?.style.display !== 'none')
      _renderCalendar(tasksCal);
    if (calPane && calPane.style.display !== 'none')
      _renderFullCal(calPane);
  }

  async function loadForCalPane() {
    const loading   = $('cal-pane-loading');
    const container = $('cal-pane-container');
    if (!loading || !container) return;
    loading.style.display   = 'flex';
    container.style.display = 'none';
    try {
      if (!_tasks.length) {
        const res = await apiFetch(`${API}/mgmt/tasks`);
        if (res.status === 401) { location.reload(); return; }
        if (res.ok) _tasks = await res.json();
      }
    } catch (e) { console.error('[tasks] cal-pane load:', e); }
    finally {
      loading.style.display   = 'none';
      container.style.display = '';
      _renderFullCal(container);
    }
  }

  // ── Drawer ─────────────────────────────────────────────────────────

  async function _fetchAndPopulateProjects(selectedId) {
    const sel = $('tasks-project-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Cargando proyectos…</option>';
    try {
      const res = await apiFetch(`${API}/mgmt/projects`);
      const projects = res.ok ? await res.json() : [];
      sel.innerHTML = '<option value="">Seleccionar proyecto…</option>' +
        projects.map(p =>
          `<option value="${p.id}" ${selectedId == p.id ? 'selected' : ''}>${esc(p.nombre)}${p.client_nombre ? ' · ' + esc(p.client_nombre) : ''}</option>`
        ).join('');
    } catch {
      sel.innerHTML = '<option value="">Error al cargar proyectos</option>';
    }
  }

  async function _fetchAndPopulateTeam(selected = '') {
    const pick = Array.isArray(selected) ? (selected[0] || '') : (selected || '');
    try {
      const res  = await apiFetch(`${API}/mgmt/team`);
      const team = res.ok ? await res.json() : [];
      _teamMembers = team;
      _setRespDd(pick);
    } catch { _setRespDd(pick); }
  }

  function _setRespDd(value) {
    const hidden = $('task-responsable-select');
    const label  = $('task-resp-label');
    const list   = $('task-resp-list');
    if (hidden) hidden.value = value;
    if (label)  label.textContent = value || 'Sin asignar';
    if (!list)  return;
    const items = [{ nombre: '', label: 'Sin asignar', none: true }, ..._teamMembers.map(m => ({ nombre: m.nombre, label: m.nombre }))];
    list.innerHTML = items.map(it => `
      <div class="cdd__item${it.none ? ' cdd__item--none' : ''}${it.nombre === value ? ' cdd__item--selected' : ''}"
           onclick="TasksModule._pickResp('${esc(it.nombre)}')">
        ${esc(it.label)}
      </div>`).join('');
  }

  function toggleRespDd() {
    const dd   = $('task-resp-dd');
    const list = $('task-resp-list');
    if (!dd || !list) return;
    const open = list.style.display !== 'none';
    if (open) { _closeRespDd(); return; }
    list.style.display = 'block';
    dd.classList.add('cdd--open');
    setTimeout(() => document.addEventListener('click', _respDdOutside), 0);
  }

  function _closeRespDd() {
    const dd   = $('task-resp-dd');
    const list = $('task-resp-list');
    if (list) list.style.display = 'none';
    if (dd)   dd.classList.remove('cdd--open');
    document.removeEventListener('click', _respDdOutside);
  }

  function _respDdOutside(e) {
    const dd = $('task-resp-dd');
    if (dd && !dd.contains(e.target)) _closeRespDd();
  }

  function _pickResp(nombre) {
    _setRespDd(nombre);
    _closeRespDd();
  }

  async function _fetchTaskTitle(taskId) {
    const cached = _tasks.find(x => x.id === taskId);
    if (cached) return cached.titulo;
    try {
      const res = await apiFetch(`${API}/mgmt/tasks/${taskId}`);
      if (res.ok) return (await res.json()).titulo;
    } catch {}
    return `#${taskId}`;
  }

  async function _applyParentBadge(parentTaskId) {
    const badge = $('task-parent-badge');
    const input = $('task-parent-id');
    if (input) input.value = parentTaskId || '';
    if (!badge) return;
    if (!parentTaskId) { badge.style.display = 'none'; return; }
    badge.textContent  = `Subtarea de: ${await _fetchTaskTitle(parentTaskId)}`;
    badge.style.display = '';
  }

  async function openDrawer(id = null, presetProjectId = null, presetParentTaskId = null) {
    _editId = id ?? null;
    const form    = $('tasks-form');
    const title   = $('tasks-drawer-title');
    const saveBtn = $('tasks-save-btn');
    const delBtn  = $('tasks-delete-btn');
    const projSel = $('tasks-project-select');
    if (!form) return;
    form.reset();
    if (projSel) projSel.disabled = false;
    await _applyParentBadge(null);

    if (_editId) {
      const t = _tasks.find(x => x.id === _editId);
      if (!t) return;
      title.textContent       = 'Editar tarea';
      saveBtn.textContent     = 'Guardar cambios';
      if (delBtn) delBtn.style.display = '';
      form.titulo.value       = t.titulo;
      form.estado.value       = t.estado;
      form.prioridad.value    = t.prioridad;
      form.descripcion.value  = t.descripcion;
      form.notas.value        = t.notas;
      if (t.deadline) form.deadline.value = t.deadline.split('T')[0];
      await _applyParentBadge(t.parent_task_id);
      await Promise.all([
        _fetchAndPopulateProjects(t.project_id),
        _fetchAndPopulateTeam(t.responsable || ''),
      ]);
    } else {
      title.textContent   = presetParentTaskId ? 'Nueva subtarea' : 'Nueva tarea';
      saveBtn.textContent  = presetParentTaskId ? 'Crear subtarea' : 'Crear tarea';
      if (delBtn) delBtn.style.display = 'none';
      await _applyParentBadge(presetParentTaskId);
      await Promise.all([
        _fetchAndPopulateProjects(presetProjectId),
        _fetchAndPopulateTeam(''),
      ]);
      if (projSel) projSel.disabled = !!presetParentTaskId;
    }

    $('tasks-drawer').classList.add('open');
    $('tasks-drawer-overlay').classList.add('open');
    setTimeout(() => form.titulo.focus(), 150);
  }

  function closeDrawer() {
    $('tasks-drawer')?.classList.remove('open');
    $('tasks-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function save(e) {
    e.preventDefault();
    const form    = e.target;
    const saveBtn = $('tasks-save-btn');
    const responsable = $('task-responsable-select')?.value || '';
    const data = {
      titulo:        form.titulo.value.trim(),
      project_id:    parseInt(form.project_id.value),
      descripcion:   form.descripcion.value.trim(),
      estado:        form.estado.value,
      prioridad:     form.prioridad.value,
      responsable,
      responsables:  responsable ? [responsable] : [],
      deadline:      form.deadline.value || null,
      notas:         form.notas.value.trim(),
      parent_task_id: form.parent_task_id.value ? parseInt(form.parent_task_id.value) : null,
    };
    const orig = saveBtn.textContent;
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/tasks${_editId ? '/' + _editId : ''}`,
        {
          method:  _editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(data),
        }
      );
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      closeDrawer();
      await load();
      if (data.project_id) ProjectsModule.refreshCard(data.project_id);
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = orig;
    }
  }

  async function confirmDelete(id) {
    const targetId = id ?? _editId;
    const t = _tasks.find(x => x.id === targetId);
    const kids = _tasks.filter(x => x.parent_task_id === targetId);
    const msg = kids.length
      ? `Esta tarea tiene ${kids.length} subtarea${kids.length !== 1 ? 's' : ''}. ¿Deseas eliminar todo?`
      : `¿Eliminar "${t?.titulo}"? Esta acción no se puede deshacer.`;
    if (!confirm(msg)) return;
    closeDrawer();
    try {
      const res = await apiFetch(`${API}/mgmt/tasks/${targetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      await load();
      if (t?.project_id) ProjectsModule.refreshCard(t.project_id);
    } catch (e) { alert('Error: ' + e.message); }
  }

  /* ── quick-edit mini modal ───────────────────── */
  const _QE_ESTADO = [
    { val: 'pendiente',   label: 'Pendiente',   bg: '#F3F4F6', clr: '#6B7280' },
    { val: 'en_progreso', label: 'En progreso', bg: '#FFE4CC', clr: '#92400E' },
    { val: 'bloqueado',   label: 'Bloqueado',   bg: '#FFD0D0', clr: '#991B1B' },
    { val: 'completado',  label: 'Completado',  bg: '#BBF7D0', clr: '#14532D' },
  ];
  const _QE_PRIO = [
    { val: 'alta',  label: '↑ Alta',  bg: '#FECACA', clr: '#991B1B' },
    { val: 'media', label: '→ Media', bg: '#FEF3C7', clr: '#92400E' },
    { val: 'baja',  label: '↓ Baja',  bg: '#D1FAE5', clr: '#065F46' },
  ];

  function openQuickEdit(e, taskId) {
    e.stopPropagation();
    const t = _tasks.find(x => x.id === taskId);
    if (!t) return;
    _qeTaskId = taskId;
    const qe = $('task-quick-edit');
    if (!qe) return;

    const chips = (opts, field) => opts.map(o =>
      `<button class="tqe-chip${t[field] === o.val ? ' tqe-chip--on' : ''}"
               style="background:${o.bg};color:${o.clr}"
               onclick="event.stopPropagation();TasksModule.qeChip(this,'${field}');"
               data-val="${o.val}">${o.label}</button>`
    ).join('');

    const memberOpts = _teamMembers.map(m =>
      `<option value="${esc(m.nombre)}"${t.responsable === m.nombre ? ' selected' : ''}>${esc(m.nombre)}</option>`
    ).join('');

    const dl = t.deadline ? String(t.deadline).split('T')[0] : '';

    qe.innerHTML = `
      <div class="tqe-hdr">
        <span class="tqe-title">Editar rápido</span>
        <button class="tqe-x" onclick="event.stopPropagation();TasksModule.closeQuickEdit()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="tqe-row">
        <span class="tqe-lbl">Estado</span>
        <div class="tqe-chips" id="tqe-estado">${chips(_QE_ESTADO,'estado')}</div>
      </div>
      <div class="tqe-row">
        <span class="tqe-lbl">Prioridad</span>
        <div class="tqe-chips" id="tqe-prio">${chips(_QE_PRIO,'prioridad')}</div>
      </div>
      <div class="tqe-row">
        <span class="tqe-lbl">Deadline</span>
        <input type="date" id="tqe-deadline" class="tqe-input" value="${dl}" onclick="event.stopPropagation()">
      </div>
      <div class="tqe-row">
        <span class="tqe-lbl">Responsable</span>
        <select id="tqe-resp" class="tqe-input" onclick="event.stopPropagation()">
          <option value="">Sin asignar</option>
          ${memberOpts}
        </select>
      </div>
      <div class="tqe-footer">
        <button class="tqe-save" onclick="event.stopPropagation();TasksModule.saveQuickEdit()">Guardar</button>
      </div>`;

    const rect = e.currentTarget.closest('tr').getBoundingClientRect();
    qe.style.display = 'block';
    const top = Math.min(rect.bottom + 6, window.innerHeight - 310);
    const left = Math.min(rect.left + 80, window.innerWidth - 310);
    qe.style.top  = Math.max(8, top) + 'px';
    qe.style.left = Math.max(8, left) + 'px';

    setTimeout(() => document.addEventListener('click', _qeOutside), 0);
  }

  function _qeOutside(e) {
    const qe = $('task-quick-edit');
    if (qe && !qe.contains(e.target)) {
      closeQuickEdit();
    }
  }

  function qeChip(btn, field) {
    const container = btn.closest('.tqe-chips');
    container.querySelectorAll('.tqe-chip').forEach(c => c.classList.remove('tqe-chip--on'));
    btn.classList.add('tqe-chip--on');
  }

  function closeQuickEdit() {
    const qe = $('task-quick-edit');
    if (qe) qe.style.display = 'none';
    document.removeEventListener('click', _qeOutside);
    _qeTaskId = null;
  }

  async function saveQuickEdit() {
    const t = _tasks.find(x => x.id === _qeTaskId);
    if (!t) return;
    const estado     = $('tqe-estado')?.querySelector('.tqe-chip--on')?.dataset.val || t.estado;
    const prioridad  = $('tqe-prio')?.querySelector('.tqe-chip--on')?.dataset.val  || t.prioridad;
    const deadline   = $('tqe-deadline')?.value || null;
    const responsable = $('tqe-resp')?.value || '';
    closeQuickEdit();
    t.estado = estado; t.prioridad = prioridad;
    t.deadline = deadline; t.responsable = responsable;
    t.responsables = responsable ? [responsable] : [];
    render();
    try {
      await apiFetch(`${API}/mgmt/tasks/${t.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titulo: t.titulo, project_id: t.project_id,
          descripcion: t.descripcion || '', estado, prioridad,
          responsable, responsables: responsable ? [responsable] : [],
          deadline: deadline || null, notas: t.notas || '',
        }),
      });
    } catch { /* optimistic */ }
  }

  return {
    load, filter, setFilter, setFilterPrio, setFilterMember, setFilterFecha, render,
    setView, calPrev, calNext, setCalView, loadForCalPane,
    openDrawer, closeDrawer, save, confirmDelete,
    openQuickEdit, closeQuickEdit, qeChip, saveQuickEdit,
    kanbanDragStart, kanbanDragEnd, moveTaskToStatus,
    toggleRespDd, _pickResp,
  };
})();

// =================================================================
// CALENDAR MODULE — full redesigned calendar + meetings view
// =================================================================

const CalendarModule = (() => {
  let _meetings   = [];
  let _tasks      = [];
  let _timeOff    = [];
  let _gcalEvents   = [];
  let _gcalConn     = false;
  let _timeEntries  = [];
  let _tab          = 'all';
  let _weekOf     = null;

  const HOUR_H = 56;
  const GRID_S = 8;
  const GRID_E = 20;

  const _WKS  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const _DOMF = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const _MON  = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
                  'septiembre','octubre','noviembre','diciembre'];
  const _MONS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const _CARD_COLORS = ['#BAE6FD','#C4B5FD','#A7F3D0','#FBBFB0','#FDE68A','#5EEAD4','#FDBA74'];

  function _pad(n) { return String(n).padStart(2,'0'); }
  function _iso(d) { return `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`; }
  function _monday(d) {
    const day = new Date(d); day.setHours(0,0,0,0);
    const dow = day.getDay();
    day.setDate(day.getDate() + (dow === 0 ? -6 : 1 - dow));
    return day;
  }
  function _parseT(t) {
    if (!t) return null;
    const p = String(t).split(':');
    return { h: +p[0], m: +p[1] };
  }
  function _fmtT(t) {
    if (!t) return '';
    const { h, m } = _parseT(t);
    return `${h % 12 || 12}:${_pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // ── Load ───────────────────────────────────────────────────────────
  async function load() {
    if (!_weekOf) _weekOf = _monday(new Date());
    const cont = $('cal-pane-container');
    const spin = $('cal-pane-loading');
    if (!cont || !spin) return;
    spin.style.display = 'flex';
    cont.style.display = 'none';
    try {
      const weekStart = _weekOf || _monday(new Date());
      const weekEnd   = new Date(weekStart.getTime() + 7 * 86400000);
      const [mr, tr, tor, gcr, ter] = await Promise.all([
        apiFetch(`${API}/mgmt/meetings`),
        apiFetch(`${API}/mgmt/tasks`),
        apiFetch(`${API}/mgmt/time-off`),
        apiFetch(`${API}/gcal/events?start=${weekStart.toISOString()}&end=${weekEnd.toISOString()}`),
        apiFetch(`${API}/timer/entries?start=${weekStart.toISOString()}&end=${weekEnd.toISOString()}`),
      ]);
      if (mr.ok)  _meetings    = await mr.json();
      if (tr.ok)  _tasks       = await tr.json();
      if (tor.ok) _timeOff     = await tor.json();
      if (gcr.ok) { const gd = await gcr.json(); _gcalConn = gd.connected; _gcalEvents = gd.events || []; }
      if (ter.ok) _timeEntries = await ter.json();
    } catch (e) { console.error('[cal] load:', e); }
    spin.style.display = 'none';
    cont.style.display = '';
    render();
  }

  async function connectGcal() {
    window.location.href = `${API}/gcal/connect`;
  }

  async function disconnectGcal() {
    if (!confirm('¿Desconectar Google Calendar?')) return;
    await apiFetch(`${API}/gcal/disconnect`, { method: 'POST' });
    _gcalConn = false; _gcalEvents = [];
    render();
  }

  async function syncTaskToGcal(taskId) {
    try {
      await apiFetch(`${API}/gcal/sync-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
    } catch (e) { console.warn('[gcal] sync failed:', e.message); }
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    const cont = $('cal-pane-container');
    if (!cont) return;
    const today   = new Date(); today.setHours(0,0,0,0);
    const todayDs = _iso(today);
    const weekDays = Array.from({length:7}, (_,i) => {
      const d = new Date(_weekOf.getTime() + i * 86400000);
      return { d, ds: _iso(d), isToday: _iso(d) === todayDs };
    });
    const wDs = new Set(weekDays.map(x => x.ds));
    const tMtgs  = _meetings.filter(m => String(m.fecha).split('T')[0] === todayDs);
    const tTasks = _tasks.filter(t => t.deadline && String(t.deadline).split('T')[0] === todayDs);
    const wMtgs  = _meetings.filter(m => wDs.has(String(m.fecha).split('T')[0]));
    const wTasks = _tasks.filter(t => t.deadline && wDs.has(String(t.deadline).split('T')[0]));
    const wTOff  = _timeOff.filter(o => {
      const s = String(o.fecha_inicio).split('T')[0];
      const e = String(o.fecha_fin).split('T')[0];
      return [...wDs].some(ds => ds >= s && ds <= e);
    });
    const s = weekDays[0].d, e = weekDays[6].d;
    const rangeLabel = s.getMonth() === e.getMonth()
      ? `${s.getDate()} – ${e.getDate()} ${_MONS[s.getMonth()]} ${s.getFullYear()}`
      : `${s.getDate()} ${_MONS[s.getMonth()]} – ${e.getDate()} ${_MONS[e.getMonth()]} ${e.getFullYear()}`;

    cont.innerHTML = `<div class="cal2">
      ${_hdr(today, tMtgs.length, tTasks.length)}
      ${_fbar(rangeLabel)}
      ${_tabs(wMtgs.length, wTasks.length, wTOff.length)}
      ${_cards(weekDays, todayDs)}
      ${_grid(weekDays, todayDs)}
    </div>`;

    requestAnimationFrame(() => {
      const wrap = document.getElementById('cal-grid-scroll');
      if (!wrap) return;
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      if (h >= GRID_S && h < GRID_E) {
        wrap.scrollTop = Math.max(0, ((h - GRID_S) * 60 + m) / 60 * HOUR_H - 100);
      }
    });
  }

  function _hdr(today, mc, tc) {
    const full = `${_DOMF[today.getDay()]}, ${today.getDate()} de ${_MON[today.getMonth()]} ${today.getFullYear()}`;
    const sub  = mc + tc === 0
      ? 'Sin reuniones ni tareas para hoy'
      : [mc ? `${mc} reunión${mc !== 1 ? 'es' : ''}` : null,
         tc ? `${tc} tarea${tc !== 1 ? 's' : ''}` : null]
          .filter(Boolean).join(' y ') + ' para hoy';
    return `<div class="cal2__hdr">
      <div class="cal2__hdr-left">
        <div class="cal2__hdr-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </div>
        <div>
          <div class="cal2__hdr-title">${esc(full)}</div>
          <div class="cal2__hdr-sub">${esc(sub)}</div>
        </div>
      </div>
      <div class="cal2__hdr-actions">
        ${_gcalConn
          ? `<button class="cal2__gcal-btn cal2__gcal-btn--conn" onclick="CalendarModule.disconnectGcal()" title="Google Calendar conectado — clic para desconectar">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" fill="#34A853"/></svg>
               Google Calendar
             </button>`
          : `<button class="cal2__gcal-btn" onclick="CalendarModule.connectGcal()" title="Conectar Google Calendar">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="#FBBC05"/><path d="M17.545 13.023H12V10.5h8.1c.1.5.155 1.02.155 1.5 0 4.42-2.965 7.5-8.255 7.5-4.97 0-9-4.03-9-9s4.03-9 9-9c2.43 0 4.465.885 6.03 2.34L16.15 5.71C15.045 4.67 13.6 4 12 4 7.58 4 4 7.58 4 12s3.58 8 8 8c4.7 0 7.5-3.3 7.5-8 0-.33-.03-.66-.09-.977h-7.865v2.5h5.91z" fill="#4285F4"/></svg>
               Conectar Google Cal
             </button>`
        }
        <button class="btn btn--primary btn--sm" onclick="MeetingsModule.openDrawer()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nueva reunión
        </button>
      </div>
    </div>`;
  }

  function _fbar(rangeLabel) {
    const today    = new Date(); today.setHours(0,0,0,0);
    const thisWeek = _monday(today).getTime() === _weekOf.getTime();
    return `<div class="cal2__fbar">
      <button class="cal2__fbtn${thisWeek ? ' cal2__fbtn--on' : ''}" onclick="CalendarModule.goToday()">Hoy</button>
      <div class="cal2__fnav">
        <button class="cal2__fnavbtn" onclick="CalendarModule.prev()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button class="cal2__fnavbtn" onclick="CalendarModule.next()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="cal2__range">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        ${esc(rangeLabel)}
      </div>
    </div>`;
  }

  function _tabs(mc, tc, oc) {
    const items = [
      { id: 'all',      label: 'Todo programado' },
      { id: 'meetings', label: 'Reuniones',    count: mc },
      { id: 'tasks',    label: 'Tareas',       count: tc },
      { id: 'timeoff',  label: 'Tiempo libre', count: oc },
    ];
    return `<div class="cal2__tabs">
      ${items.map(t => `<button class="cal2__tab${_tab === t.id ? ' active' : ''}" onclick="CalendarModule.setTab('${t.id}')">
        ${esc(t.label)}${t.count !== undefined ? ` <span class="cal2__tab-n">${t.count}</span>` : ''}
      </button>`).join('')}
      <div style="flex:1"></div>
      <button class="cal2__tab-action" onclick="TimeOffModule.openDrawer()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Registrar ausencia
      </button>
    </div>`;
  }

  function _cards(weekDays, todayDs) {
    if (_tab === 'tasks') return '';
    const wDs = new Set(weekDays.map(x => x.ds));

    // ── Time Off cards ────────────────────────────────────────────────
    if (_tab === 'timeoff') {
      const list = _timeOff.filter(o => {
        const s = String(o.fecha_inicio).split('T')[0];
        const e = String(o.fecha_fin).split('T')[0];
        return [...wDs].some(ds => ds >= s && ds <= e);
      });
      if (!list.length) return `<div class="cal2__empty-cards">Sin ausencias registradas esta semana</div>`;
      const motivos = { 'Vacaciones':'🏖','Enfermedad':'🤒','Personal':'🏠','Feriado':'📅','Otro':'📌' };
      const html = list.map(o => {
        const si  = String(o.fecha_inicio).split('T')[0];
        const ei  = String(o.fecha_fin).split('T')[0];
        const di  = new Date(si + 'T00:00:00'), de = new Date(ei + 'T00:00:00');
        const days = Math.round((de - di) / 86400000) + 1;
        const fmt  = d => `${d.getDate()} ${_MONS[d.getMonth()]}`;
        return `<div class="cal2-card cal2-card--off" onclick="TimeOffModule.openDrawer(${o.id})">
          <div class="cal2-card__body">
            <div class="cal2-card__top">
              <div class="cal2-card__title">${esc(o.member_nombre || '—')}</div>
              <button class="cal2-card__chevron" onclick="event.stopPropagation();TimeOffModule.openDrawer(${o.id})">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>
            <div class="cal2-card__time">${fmt(di)} – ${fmt(de)}</div>
          </div>
          <div class="cal2-card__foot cal2-card__foot--off">
            <span class="cal2-card__status-text">${motivos[o.motivo] || '📌'} ${esc(o.motivo)}</span>
            <span class="cal2-card__days">${days} día${days !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
      }).join('');
      return `<div class="cal2__cards-wrap"><div class="cal2__cards">${html}</div></div>`;
    }

    // ── Meeting cards ─────────────────────────────────────────────────
    const list = _meetings
      .filter(m => wDs.has(String(m.fecha).split('T')[0]) && m.estado !== 'cancelada')
      .sort((a, b) => {
        const da = String(a.fecha).split('T')[0], db = String(b.fecha).split('T')[0];
        return da !== db ? da < db ? -1 : 1 : (a.hora_inicio || '') < (b.hora_inicio || '') ? -1 : 1;
      });
    if (!list.length) return '';

    const html = list.map((m) => {
      const ds      = String(m.fecha).split('T')[0];
      const isToday = ds === todayDs;
      const isPast  = ds < todayDs;
      const date    = new Date(ds + 'T00:00:00');
      const dLabel  = isToday ? 'Hoy' : `${_WKS[(date.getDay() + 6) % 7]} ${date.getDate()}`;
      const timeStr = m.hora_inicio
        ? `${_fmtT(m.hora_inicio)}${m.hora_fin ? ' – ' + _fmtT(m.hora_fin) : ''}`
        : 'Sin hora definida';
      const footClass = isToday ? 'cal2-card__foot--today'
                      : isPast  ? 'cal2-card__foot--past'
                      :           'cal2-card__foot--upcoming';
      let atts = []; try { atts = JSON.parse(m.attendees || '[]'); } catch {}
      return `<div class="cal2-card">
        <div class="cal2-card__body">
          <div class="cal2-card__top">
            <div class="cal2-card__title">${esc(m.titulo)}</div>
            <button class="cal2-card__chevron" onclick="MeetingsModule.openDrawer(${m.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          <div class="cal2-card__time">${esc(timeStr)}</div>
          ${atts.length ? `<div class="cal2-card__atts">${esc(atts.slice(0,3).join(', '))}${atts.length>3?` +${atts.length-3}`:''}</div>` : ''}
        </div>
        <div class="cal2-card__foot ${footClass}">
          <span class="cal2-card__status-text">● ${esc(dLabel)}</span>
          ${m.link
            ? `<a class="cal2-card__link" href="${esc(m.link)}" target="_blank" rel="noopener">Unirse a reunión</a>`
            : `<button class="cal2-card__link" onclick="MeetingsModule.openDrawer(${m.id})">Ver detalle</button>`}
        </div>
      </div>`;
    }).join('');
    return `<div class="cal2__cards-wrap"><div class="cal2__cards">${html}</div></div>`;
  }

  function _grid(weekDays, todayDs) {
    const hours = Array.from({length: GRID_E - GRID_S}, (_, i) => GRID_S + i);
    const _now   = new Date();
    const _nowPx = (_now.getHours() >= GRID_S && _now.getHours() < GRID_E)
      ? Math.round(((_now.getHours() - GRID_S) * 60 + _now.getMinutes()) / 60 * HOUR_H)
      : -1;

    const timeCol = `<div class="cal2-tlabels">
      <div class="cal2-tlabels__top"></div>
      <div class="cal2-tlabels__allday">Todo el día</div>
      ${hours.map(h => `<div class="cal2-tlabel">${h > 12 ? (h - 12) + ' PM' : h === 12 ? '12 PM' : h + ' AM'}</div>`).join('')}
    </div>`;

    const cols = weekDays.map((day, i) => {
      const { d, ds, isToday } = day;

      const dayTasks = (_tab === 'all' || _tab === 'tasks')
        ? _tasks.filter(t => t.deadline && String(t.deadline).split('T')[0] === ds)
        : [];
      const taskChips = dayTasks.map(t =>
        `<div class="cal2-tchip" onclick="TasksModule.openDrawer(${t.id})" title="${esc(t.titulo)}">${esc(t.titulo)}</div>`
      ).join('');

      const dayMtgs = (_tab === 'all' || _tab === 'meetings')
        ? _meetings.filter(m => String(m.fecha).split('T')[0] === ds && m.estado !== 'cancelada')
        : [];

      const noTimeMtgs = dayMtgs.filter(m => !m.hora_inicio).map(m =>
        `<div class="cal2-tchip cal2-tchip--mtg" onclick="MeetingsModule.openDrawer(${m.id})" title="${esc(m.titulo)}">${esc(m.titulo)}</div>`
      ).join('');

      // Time off chips for this day
      const dayOff = (_tab === 'all' || _tab === 'timeoff')
        ? _timeOff.filter(o => {
            const s = String(o.fecha_inicio).split('T')[0];
            const e = String(o.fecha_fin).split('T')[0];
            return ds >= s && ds <= e;
          })
        : [];
      const offChips = dayOff.map(o =>
        `<div class="cal2-tchip cal2-tchip--off" onclick="TimeOffModule.openDrawer(${o.id})" title="${esc(o.member_nombre)} – ${esc(o.motivo)}">${esc((o.member_nombre||'').split(' ')[0])}</div>`
      ).join('');

      // Google Calendar events for this day
      const dayGcal = _gcalEvents.filter(ev => {
        const evDate = (ev.start || '').split('T')[0];
        return evDate === ds;
      });
      const gcalAllDay = dayGcal.filter(ev => ev.allDay).map(ev =>
        `<div class="cal2-tchip cal2-tchip--gcal" title="${esc(ev.title)}"${ev.link ? ` onclick="window.open('${esc(ev.link)}','_blank')"` : ''}>${esc(ev.title)}</div>`
      ).join('');
      const gcalTimed = dayGcal.filter(ev => !ev.allDay).map(ev => {
        const stDt = new Date(ev.start);
        const enDt = new Date(ev.end || ev.start);
        const stH = stDt.getHours(), stM = stDt.getMinutes();
        const enH = enDt.getHours(), enM = enDt.getMinutes();
        if (stH < GRID_S || stH >= GRID_E) return '';
        const topPx = ((stH - GRID_S) * 60 + stM) / 60 * HOUR_H;
        const durMin = (enH * 60 + enM) - (stH * 60 + stM);
        const hPx   = Math.max(24, durMin / 60 * HOUR_H - 2);
        const timeStr = `${stH%12||12}:${String(stM).padStart(2,'0')} ${stH<12?'AM':'PM'}`;
        return `<div class="cal2-event cal2-event--gcal" style="top:${topPx}px;height:${hPx}px"${ev.link ? ` onclick="window.open('${esc(ev.link)}','_blank')"` : ''}>
          <div class="cal2-event__title">${esc(ev.title)}</div>
          <div class="cal2-event__time">${timeStr}</div>
        </div>`;
      }).join('');

      const timedBlocks = dayMtgs.filter(m => m.hora_inicio).map((m, mi) => {
        const st     = _parseT(m.hora_inicio);
        const et     = _parseT(m.hora_fin);
        const bg     = _CARD_COLORS[(mi + i) % _CARD_COLORS.length];
        const topPx  = Math.max(0, ((st.h - GRID_S) * 60 + st.m) / 60 * HOUR_H);
        const endMin = et ? (et.h - GRID_S) * 60 + et.m : (st.h - GRID_S) * 60 + st.m + 60;
        const stMin  = (st.h - GRID_S) * 60 + st.m;
        const hPx    = Math.max(26, (endMin - stMin) / 60 * HOUR_H - 2);
        return `<div class="cal2-event" style="top:${topPx}px;height:${hPx}px;background:${bg}" onclick="MeetingsModule.openDrawer(${m.id})">
          <div class="cal2-event__title">${esc(m.titulo)}</div>
          <div class="cal2-event__time">${_fmtT(m.hora_inicio)}${m.hora_fin ? ' – ' + _fmtT(m.hora_fin) : ''}</div>
        </div>`;
      }).join('');

      const dayEntries = _timeEntries.filter(e => {
        const ed = new Date(e.started_at); ed.setHours(0,0,0,0);
        return ed.toDateString() === d.toDateString();
      });
      const timerBlocks = dayEntries.map(e => {
        const st  = new Date(e.started_at);
        const en  = e.ended_at ? new Date(e.ended_at) : new Date();
        const stH = st.getHours(), stM = st.getMinutes();
        const enH = en.getHours(), enM = en.getMinutes();
        if (stH < GRID_S || stH >= GRID_E) return '';
        const topPx  = ((stH - GRID_S) * 60 + stM) / 60 * HOUR_H;
        const durMin = Math.max(1, (enH * 60 + enM) - (stH * 60 + stM));
        const hPx    = Math.max(20, durMin / 60 * HOUR_H);
        const running = !e.ended_at;
        const totalSec = running ? Math.round((en - st) / 1000) : (e.duration_s || 0);
        const hh = Math.floor(totalSec / 3600), mm = Math.floor((totalSec % 3600) / 60);
        const dur = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
        const timeStr = `${String(stH).padStart(2,'0')}:${String(stM).padStart(2,'0')}`;
        return `<div class="cal2-event cal2-event--timer${running ? ' cal2-event--running' : ''}"
          style="top:${topPx}px;height:${hPx}px"
          title="${esc(e.task_titulo || 'Sin tarea')}"
          ${running ? `id="cal-timer-running" data-started-at="${st.toISOString()}"` : ''}>
          <div class="cal2-event__title">⏱ ${esc(e.task_titulo || 'Sin tarea')}</div>
          <div class="cal2-event__time"${running ? ' id="cal-timer-dur"' : ''}>${timeStr} · ${dur}</div>
        </div>`;
      }).join('');

      const nowLine = (isToday && _nowPx >= 0)
        ? `<div class="cal2-now-line" style="top:${_nowPx}px"></div>` : '';

      return `<div class="cal2-col${isToday ? ' cal2-col--today' : ''}">
        <div class="cal2-col__hdr">
          <span class="cal2-col__dow" translate="no">${_WKS[i]}</span>
          <span class="cal2-col__num${isToday ? ' cal2-col__num--today' : ''}">${d.getDate()}</span>
        </div>
        <div class="cal2-col__allday">${taskChips}${noTimeMtgs}${offChips}${gcalAllDay}</div>
        <div class="cal2-col__body">${timedBlocks}${gcalTimed}${timerBlocks}${nowLine}</div>
      </div>`;
    }).join('');

    return `<div class="cal2-grid-wrap" id="cal-grid-scroll">
      <div class="cal2-grid">
        ${timeCol}
        <div class="cal2-cols">${cols}</div>
      </div>
    </div>`;
  }

  function setTab(t)  { _tab = t; render(); }
  function prev()     { _weekOf = new Date(_weekOf.getTime() - 7 * 86400000); render(); }
  function next()     { _weekOf = new Date(_weekOf.getTime() + 7 * 86400000); render(); }
  function goToday()  { _weekOf = _monday(new Date()); render(); }
  async function refresh() { _meetings = []; _tasks = []; _timeOff = []; _timeEntries = []; await load(); }

  function tickRunning() {
    const el = document.getElementById('cal-timer-running');
    if (!el) return;
    const st  = new Date(el.dataset.startedAt);
    const now = new Date();
    const stH = st.getHours(), stM = st.getMinutes();
    const nowH = now.getHours(), nowM = now.getMinutes();
    const durMin = Math.max(1, (nowH * 60 + nowM) - (stH * 60 + stM));
    el.style.height = Math.max(20, durMin / 60 * HOUR_H) + 'px';
    const totalSec = Math.round((now - st) / 1000);
    const hh = Math.floor(totalSec / 3600), mm = Math.floor((totalSec % 3600) / 60);
    const durEl = document.getElementById('cal-timer-dur');
    if (durEl) {
      const timeStr = `${String(stH).padStart(2,'0')}:${String(stM).padStart(2,'0')}`;
      const dur = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
      durEl.textContent = `${timeStr} · ${dur}`;
    }
  }

  return { load, setTab, prev, next, goToday, refresh, connectGcal, disconnectGcal, syncTaskToGcal, tickRunning };
})();

// =================================================================
// MEETINGS MODULE — drawer CRUD for meetings
// =================================================================

const MeetingsModule = (() => {
  let _editId = null;

  async function openDrawer(id = null) {
    _editId = id ?? null;
    const form    = $('meetings-form');
    const title   = $('meeting-drawer-title');
    const saveBtn = $('meeting-save-btn');
    const delBtn  = $('meeting-delete-btn');
    if (!form) return;
    form.reset();
    await _loadTeam();

    if (_editId) {
      const res = await apiFetch(`${API}/mgmt/meetings`);
      const all = res.ok ? await res.json() : [];
      const m   = all.find(x => x.id === _editId);
      if (!m) return;
      title.textContent      = 'Editar reunión';
      saveBtn.textContent    = 'Guardar cambios';
      delBtn.style.display   = '';
      form.titulo.value      = m.titulo;
      form.fecha.value       = String(m.fecha).split('T')[0];
      form.hora_inicio.value = m.hora_inicio ? String(m.hora_inicio).slice(0, 5) : '';
      form.hora_fin.value    = m.hora_fin    ? String(m.hora_fin).slice(0, 5)    : '';
      form.link.value        = m.link || '';
      form.descripcion.value = m.descripcion || '';
      form.estado.value      = m.estado || 'programada';
      let atts = []; try { atts = JSON.parse(m.attendees || '[]'); } catch {}
      document.querySelectorAll('#meeting-attendees-list input[type=checkbox]').forEach(cb => {
        cb.checked = atts.includes(cb.value);
      });
    } else {
      title.textContent    = 'Nueva reunión';
      saveBtn.textContent  = 'Crear reunión';
      delBtn.style.display = 'none';
      const now = new Date();
      form.fecha.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    }

    $('meeting-drawer').classList.add('open');
    $('meeting-drawer-overlay').classList.add('open');
  }

  function closeDrawer() {
    $('meeting-drawer')?.classList.remove('open');
    $('meeting-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function _loadTeam() {
    const list = $('meeting-attendees-list');
    if (!list) return;
    list.innerHTML = '<span class="muted" style="font-size:.8rem">Cargando…</span>';
    try {
      const res = await apiFetch(`${API}/mgmt/team`);
      const members = res.ok ? await res.json() : [];
      if (!members.length) {
        list.innerHTML = '<span class="muted" style="font-size:.8rem">Sin miembros de equipo</span>';
        return;
      }
      list.innerHTML = members.map(m =>
        `<label class="meeting-attendee">
           <input type="checkbox" value="${esc(m.nombre)}">
           <span class="meeting-attendee__avatar">${esc((m.nombre || '?')[0].toUpperCase())}</span>
           <span class="meeting-attendee__name">${esc(m.nombre)}</span>
           ${m.cargo ? `<span class="meeting-attendee__cargo">${esc(m.cargo)}</span>` : ''}
         </label>`
      ).join('');
    } catch {
      list.innerHTML = '<span class="muted" style="font-size:.8rem">Error al cargar</span>';
    }
  }

  async function save(e) {
    e.preventDefault();
    const form    = e.target;
    const saveBtn = $('meeting-save-btn');
    const attendees = Array.from(
      document.querySelectorAll('#meeting-attendees-list input[type=checkbox]:checked')
    ).map(cb => cb.value);

    const data = {
      titulo:      form.titulo.value.trim(),
      fecha:       form.fecha.value,
      hora_inicio: form.hora_inicio.value || null,
      hora_fin:    form.hora_fin.value    || null,
      descripcion: form.descripcion.value.trim(),
      link:        form.link.value.trim(),
      attendees,
      estado:      form.estado.value,
    };
    const orig = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/meetings${_editId ? '/' + _editId : ''}`,
        { method: _editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data) }
      );
      if (!res.ok) throw new Error((await res.json()).error || 'Error');
      closeDrawer();
      CalendarModule.refresh();
    } catch (err) { alert('Error: ' + err.message); }
    finally { saveBtn.disabled = false; saveBtn.textContent = orig; }
  }

  async function confirmDelete() {
    if (!_editId || !confirm('¿Eliminar esta reunión?')) return;
    try {
      await apiFetch(`${API}/mgmt/meetings/${_editId}`, { method: 'DELETE' });
      closeDrawer();
      CalendarModule.refresh();
    } catch (e) { alert('Error: ' + e.message); }
  }

  return { openDrawer, closeDrawer, save, confirmDelete };
})();

// =================================================================
// TIME OFF MODULE — drawer CRUD for team member absences
// =================================================================

const TimeOffModule = (() => {
  let _editId = null;

  async function openDrawer(id = null) {
    _editId = id ?? null;
    const title   = $('timeoff-drawer-title');
    const saveBtn = $('timeoff-save-btn');
    const delBtn  = $('timeoff-delete-btn');

    // Reset form fields manually (no form.reset() to avoid losing team list)
    $('timeoff-inicio').value = '';
    $('timeoff-fin').value    = '';
    $('timeoff-notas').value  = '';
    $('timeoff-motivo').value = 'Vacaciones';

    await _loadTeam();

    if (_editId) {
      const res  = await apiFetch(`${API}/mgmt/time-off`);
      const all  = res.ok ? await res.json() : [];
      const o    = all.find(x => x.id === _editId);
      if (!o) return;
      title.textContent        = 'Editar tiempo libre';
      saveBtn.textContent      = 'Guardar cambios';
      delBtn.style.display     = '';
      $('timeoff-member').value = String(o.member_id);
      $('timeoff-inicio').value = String(o.fecha_inicio).split('T')[0];
      $('timeoff-fin').value    = String(o.fecha_fin).split('T')[0];
      $('timeoff-motivo').value = o.motivo || 'Vacaciones';
      $('timeoff-notas').value  = o.notas || '';
    } else {
      title.textContent    = 'Registrar tiempo libre';
      saveBtn.textContent  = 'Guardar';
      delBtn.style.display = 'none';
      const now = new Date();
      const p   = n => String(n).padStart(2,'0');
      const today = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`;
      $('timeoff-inicio').value = today;
      $('timeoff-fin').value    = today;
    }

    $('timeoff-drawer').classList.add('open');
    $('timeoff-drawer-overlay').classList.add('open');
  }

  function closeDrawer() {
    $('timeoff-drawer')?.classList.remove('open');
    $('timeoff-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function _loadTeam() {
    const sel = $('timeoff-member');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Seleccionar miembro…</option>';
    try {
      const res = await apiFetch(`${API}/mgmt/team`);
      const members = res.ok ? await res.json() : [];
      members.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.nombre + (m.cargo ? ` · ${m.cargo}` : '');
        sel.appendChild(opt);
      });
      if (prev) sel.value = prev;
    } catch { /* ignore */ }
  }

  async function save(e) {
    e.preventDefault();
    const saveBtn = $('timeoff-save-btn');
    const data = {
      member_id:   parseInt($('timeoff-member').value),
      fecha_inicio: $('timeoff-inicio').value,
      fecha_fin:    $('timeoff-fin').value,
      motivo:       $('timeoff-motivo').value,
      notas:        $('timeoff-notas').value.trim(),
    };
    if (!data.member_id) { alert('Selecciona un miembro'); return; }
    const orig = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/time-off${_editId ? '/' + _editId : ''}`,
        { method: _editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data) }
      );
      if (!res.ok) throw new Error((await res.json()).error || 'Error');
      closeDrawer();
      CalendarModule.refresh();
    } catch (err) { alert('Error: ' + err.message); }
    finally { saveBtn.disabled = false; saveBtn.textContent = orig; }
  }

  async function confirmDelete() {
    if (!_editId || !confirm('¿Eliminar este período de tiempo libre?')) return;
    try {
      await apiFetch(`${API}/mgmt/time-off/${_editId}`, { method: 'DELETE' });
      closeDrawer();
      CalendarModule.refresh();
    } catch (e) { alert('Error: ' + e.message); }
  }

  return { openDrawer, closeDrawer, save, confirmDelete };
})();

// =================================================================
// PROJECTS MODULE
// =================================================================

const ProjectsModule = (() => {
  let _projects     = [];
  let _editId       = null;
  let _filterEstado = '';
  let _filterMember = '';
  let _view         = 'timeline';
  let _taskCache    = {};   // pid → tasks[]
  let _activeTabs   = {};   // pid → tab name
  let _expandedTasks    = new Set();   // taskId → subtasks shown (Timeline + Lista)
  let _expandedProjects = new Set();   // pid → tasks shown (Lista only)

  function _estadoBadge(estado) {
    const map = {
      activo:     { bg: '#A7F3D0', color: '#065F46', label: 'Activo' },
      completado: { bg: '#BAE6FD', color: '#0369A1', label: 'Completado' },
      pausado:    { bg: '#FDE68A', color: '#78350F', label: 'Pausado' },
      cancelado:  { bg: '#FBBFB0', color: '#9F1239', label: 'Cancelado' },
    };
    const m = map[estado] || map.activo;
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function _prioridadBadge(prioridad) {
    const map = {
      alta:  { bg: '#FBBFB0', color: '#9F1239', label: '↑ Alta' },
      media: { bg: '#FDE68A', color: '#78350F', label: '→ Media' },
      baja:  { bg: '#E7E5E0', color: '#57534E', label: '↓ Baja' },
    };
    const m = map[prioridad] || map.media;
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function _tipoBadge(tipo) {
    const map = {
      fijo:    { bg: '#DDD6FE', color: '#4C1D95', label: 'Precio fijo' },
      horas:   { bg: '#BAE6FD', color: '#0369A1', label: 'Por horas' },
      semanal: { bg: '#A7F3D0', color: '#065F46', label: 'Semanal' },
    };
    const m = map[tipo] || map.fijo;
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function _fmtDate(d) {
    if (!d) return '<span class="muted">—</span>';
    return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _fmtMoney(v, moneda) {
    if (v == null || v === '') return '<span class="muted">—</span>';
    const cur = moneda || 'USD';
    try {
      return new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
    } catch {
      return cur + ' ' + Number(v).toLocaleString('es-MX');
    }
  }

  function _getMoneda() {
    const tipo = $('proj-tipo')?.value || 'fijo';
    if (tipo === 'fijo')    return $('proj-moneda')?.value       || 'USD';
    if (tipo === 'horas')   return $('proj-moneda-horas')?.value || 'USD';
    if (tipo === 'semanal') return $('proj-moneda-semanal')?.value || 'USD';
    return 'USD';
  }

  function onTipoChange(tipo) {
    $('proj-bloque-fijo').style.display    = tipo === 'fijo'    ? '' : 'none';
    $('proj-bloque-horas').style.display   = tipo === 'horas'   ? '' : 'none';
    $('proj-bloque-semanal').style.display = tipo === 'semanal' ? '' : 'none';
  }

  async function load() {
    const loading   = $('projects-loading');
    const empty     = $('projects-empty');
    const tableWrap = $('projects-table-wrap');
    if (!loading) return;
    loading.style.display   = 'flex';
    empty.style.display     = 'none';
    tableWrap.style.display = 'none';
    try {
      const res = await apiFetch(`${API}/mgmt/projects`);
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error(await res.text());
      _projects = await res.json();
      _populateMemberDropdown();
      render();
    } catch (e) {
      console.error('[projects] load error:', e);
      loading.innerHTML = '<span style="color:var(--err)">Error al cargar proyectos.</span>';
    } finally {
      loading.style.display = 'none';
    }
  }

  function filter() { render(); }

  function setFilter(estado) {
    _filterEstado = estado;
    document.querySelectorAll('#pane-mgmt-projects .filter-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.estado === estado);
    });
    render();
  }

  function setMemberFilter(val) {
    _filterMember = val;
    const sel = $('proj-member-filter');
    if (sel) {
      sel.classList.toggle('filter-select--active', !!val);
    }
    render();
  }

  async function _populateMemberDropdown() {
    const sel = $('proj-member-filter');
    if (!sel) return;
    const current = sel.value;
    let members = [];
    try {
      const res = await apiFetch(`${API}/mgmt/team`);
      if (res.ok) members = (await res.json()).map(m => m.nombre).filter(Boolean).sort();
    } catch (_) {
      members = [...new Set(_projects.flatMap(p => p.responsables?.length ? p.responsables : p.responsable ? [p.responsable] : []))].sort();
    }
    sel.innerHTML = `
      <option value="">Todos los miembros</option>
      <option value="__none__">Sin asignar</option>
      ${members.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
    `;
    if (members.includes(current) || current === '__none__') sel.value = current;
  }

  /* ── filtered list ─────────────────────────── */
  function _filtered() {
    const q = ($('projects-search')?.value || '').toLowerCase();
    let list = _projects;
    if (_filterEstado) list = list.filter(p => p.estado === _filterEstado);
    if (_filterMember === '__none__') {
      list = list.filter(p => !p.responsable && !p.responsable_id && (!p.responsables || !p.responsables.length));
    } else if (_filterMember) {
      const lm = _filterMember.toLowerCase();
      list = list.filter(p =>
        (p.responsables || []).some(r => r.toLowerCase() === lm) ||
        (p.responsable || '').toLowerCase() === lm
      );
    }
    if (q) list = list.filter(p =>
      (p.nombre + ' ' + (p.client_nombre || '') + ' ' + (p.client_empresa || '') + ' ' + (p.responsable || '') + ' ' + (p.responsables || []).join(' ')).toLowerCase().includes(q)
    );
    return list;
  }

  /* ── main render dispatcher ─────────────────── */
  function render() {
    const empty     = $('projects-empty');
    const cards     = $('projects-cards');
    const tableWrap = $('projects-table-wrap');
    if (!cards) return;

    const list = _filtered();

    if (!list.length) {
      cards.style.display     = 'none';
      tableWrap.style.display = 'none';
      empty.style.display     = 'flex';
      return;
    }
    empty.style.display = 'none';

    if (_view === 'timeline') {
      tableWrap.style.display = 'none';
      cards.style.display     = '';
      cards.innerHTML = list.map(p => _cardHtml(p)).join('');
      // async-load tasks for each card's General tab
      list.forEach(p => _loadAndRenderGeneral(p));
    } else {
      cards.style.display     = 'none';
      tableWrap.style.display = '';
      _renderTable(list);
    }
  }

  /* ── sidebar config ─────────────────────────── */
  function _sideConfig(p) {
    const today = new Date(); today.setHours(0,0,0,0);
    if (p.estado === 'completado') return { scheme: 'green',  icon: '✓',  label: '',      num: '' };
    if (p.estado === 'cancelado')  return { scheme: 'gray',   icon: '✕',  label: '',      num: '' };
    if (p.estado === 'pausado')    return { scheme: 'amber',  icon: '⏸', label: 'PAUSA', num: '' };
    if (!p.fecha_fin) return { scheme: 'violet', icon: '📋', label: '', num: '' };
    const fin  = new Date(String(p.fecha_fin).split('T')[0] + 'T00:00:00');
    const diff = Math.round((fin - today) / 86400000);
    if (diff < 0)  return { scheme: 'red',    icon: '!', label: 'Due',  num: Math.abs(diff) };
    if (diff <= 7) return { scheme: 'amber',  icon: '!', label: 'Due',  num: diff };
    return              { scheme: 'blue',   icon: '○', label: 'Days',  num: diff };
  }

  /* ── generate card HTML ─────────────────────── */
  function _cardHtml(p) {
    const cfg   = _sideConfig(p);
    const tab   = _activeTabs[p.id] || 'general';
    const fin   = p.fecha_fin ? new Date(String(p.fecha_fin).split('T')[0] + 'T00:00:00') : null;
    const finFmt = fin ? fin.toLocaleDateString('es-MX', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    // money helper (inline, no HTML)
    const money = (v, m) => {
      if (!v) return '—';
      try { return new Intl.NumberFormat('es-MX',{style:'currency',currency:m||'USD',maximumFractionDigits:0}).format(v); }
      catch { return `${m||'USD'} ${v}`; }
    };

    // value display
    const tipo = p.tipo_proyecto || 'fijo';
    let totalVal = '—', totalMeta = '';
    if (tipo === 'fijo' && p.valor_total) {
      totalVal  = money(p.valor_total, p.moneda);
      totalMeta = '1 contrato';
    } else if (tipo === 'horas' && p.tarifa_hora) {
      totalVal  = money(p.tarifa_hora, p.moneda) + '/h';
      totalMeta = p.horas_estimadas ? `~${p.horas_estimadas}h estimadas` : 'Por horas';
    } else if (tipo === 'semanal') {
      totalVal  = p.horas_semanales ? `${p.horas_semanales}h/sem` : '—';
      totalMeta = p.tarifa_hora ? money(p.tarifa_hora, p.moneda) + '/h' : '';
    }

    return `
    <div class="pjcard" id="pjcard-${p.id}">

      <!-- LEFT SIDEBAR -->
      <div class="pjcard__side pjcard__side--${cfg.scheme}">
        <div class="pjcard__due-icon pjcard__due-icon--${cfg.scheme}">${cfg.icon}</div>
        ${cfg.num !== ''
          ? `<div class="pjcard__due-row">
               <div class="pjcard__due-small">${cfg.label}</div>
               <div class="pjcard__due-num pjcard__due-num--${cfg.scheme}">${cfg.num}</div>
             </div>`
          : `<div class="pjcard__due-row">
               <div class="pjcard__due-small">${p.estado.toUpperCase()}</div>
             </div>`
        }
        <div class="pjcard__prog">
          <strong id="pjprog-txt-${p.id}">— </strong>tareas
          <div class="pjcard__prog-bar">
            <div class="pjcard__prog-fill" id="pjprog-fill-${p.id}" style="width:0%"></div>
          </div>
        </div>
        <div class="pjcard__complete">
          <div class="pjcard__complete-lbl">Completar antes</div>
          <div class="pjcard__complete-date">${finFmt}</div>
        </div>
      </div>

      <!-- MAIN CONTENT -->
      <div class="pjcard__main">
        <div class="pjcard__head">
          <div class="pjcard__title-block">
            <div class="pjcard__name">${esc(p.nombre)}</div>
            <div class="pjcard__client">${p.client_nombre ? esc(p.client_nombre) + (p.client_empresa ? ' · ' + esc(p.client_empresa) : '') : ''}</div>
          </div>
          <div class="pjcard__actions">
            <button class="pjcard__act" title="Editar" onclick="ProjectsModule.openDrawer(${p.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="pjcard__act pjcard__act--danger" title="Eliminar" onclick="ProjectsModule.confirmDelete(${p.id})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>

        <!-- sub-tabs -->
        <div class="pjcard__tabs">
          <button class="pjcard__tab${tab==='general'   ?' pjcard__tab--active':''}" onclick="ProjectsModule.switchTab(${p.id},'general')">General</button>
          <button class="pjcard__tab${tab==='info'      ?' pjcard__tab--active':''}" onclick="ProjectsModule.switchTab(${p.id},'info')">Más info</button>
          <button class="pjcard__tab${tab==='financials'?' pjcard__tab--active':''}" onclick="ProjectsModule.switchTab(${p.id},'financials')">Finanzas del proyecto</button>
          <button class="pjcard__tab${tab==='links'      ?' pjcard__tab--active':''}" onclick="ProjectsModule.switchTab(${p.id},'links')">Archivos</button>
        </div>

        <!-- tab content -->
        <div class="pjcard__content" id="pjcontent-${p.id}">
          ${_tabContent(p, tab, _taskCache[p.id] || [])}
        </div>
      </div>
    </div>`;
  }

  /* ── tab content by name ────────────────────── */
  function _tabContent(p, tab, tasks) {
    if (tab === 'general')    return _tabGeneral(p, tasks);
    if (tab === 'financials') return _tabFinancials(p, tasks);
    if (tab === 'links')      return _tabLinks(p);
    return _tabInfo(p);
  }

  /* ── GENERAL: task timeline ─────────────────── */
  function _newTaskBtn(p) {
    return `<div class="pjt-add-row">
      <button type="button" class="btn btn--ghost btn--sm" onclick="event.stopPropagation();TasksModule.openDrawer(null,${p.id})">+ Nueva tarea</button>
    </div>`;
  }

  const _TASK_ESTADO_BG  = { pendiente:'#F3F4F6', en_progreso:'#FFE4CC', bloqueado:'#FFD0D0', completado:'#BBF7D0' };
  const _TASK_ESTADO_CLR = { pendiente:'#6B7280', en_progreso:'#92400E', bloqueado:'#991B1B', completado:'#14532D' };
  const _TASK_ESTADO_LBL = { pendiente:'Pendiente', en_progreso:'En progreso', bloqueado:'Bloqueado', completado:'Completado' };
  const _TASK_PRIO_DOT   = { alta:'#EF4444', media:'#F59E0B', baja:'#10B981' };

  const _chevronSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

  function _chevronHtml(taskId, childCount) {
    if (!childCount) return `<span class="pjt-chevron pjt-chevron--ghost">${_chevronSvg}</span>`;
    const open = _expandedTasks.has(taskId);
    return `<button type="button" class="pjt-chevron${open ? ' pjt-chevron--open' : ''}"
      onclick="event.stopPropagation();ProjectsModule.toggleTaskExpand(${taskId})"
      title="${open ? 'Ocultar' : 'Mostrar'} subtareas">${_chevronSvg}</button>`;
  }

  function _taskRowHtml(t, kids) {
    const dot  = _TASK_PRIO_DOT[t.prioridad] || '#9CA3AF';
    const bg   = _TASK_ESTADO_BG[t.estado]  || '#F3F4F6';
    const clr  = _TASK_ESTADO_CLR[t.estado] || '#6B7280';
    const lbl  = _TASK_ESTADO_LBL[t.estado] || t.estado || 'Pendiente';
    const done = kids.filter(k => k.estado === 'completado').length;
    return `<div class="pjt-row" data-task-id="${t.id}"
        onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})"
        oncontextmenu="event.preventDefault();event.stopPropagation();ProjectsModule.openSubtaskMenu(event,${t.id},${t.project_id})">
      ${_chevronHtml(t.id, kids.length)}
      <span class="pjt-row__dot" style="background:${dot}"></span>
      <span class="pjt-row__name">${esc(t.titulo)}</span>
      ${kids.length ? `<span class="pjt-subcount">${done}/${kids.length} subtarea${kids.length !== 1 ? 's' : ''}</span>` : ''}
      <span class="pjt-row__tag" style="background:${bg};color:${clr}">${lbl}</span>
      <button type="button" class="pjt-add-sub" title="Agregar subtarea"
        onclick="event.stopPropagation();TasksModule.openDrawer(null,${t.project_id},${t.id})">+ Subtarea</button>
    </div>`;
  }

  function _subtaskRowHtml(t) {
    const dot = _TASK_PRIO_DOT[t.prioridad] || '#9CA3AF';
    const bg  = _TASK_ESTADO_BG[t.estado]  || '#F3F4F6';
    const clr = _TASK_ESTADO_CLR[t.estado] || '#6B7280';
    const lbl = _TASK_ESTADO_LBL[t.estado] || t.estado || 'Pendiente';
    return `<div class="pjt-subrow" onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})">
      <span class="pjt-row__dot pjt-row__dot--sm" style="background:${dot}"></span>
      <span class="pjt-row__name pjt-row__name--sub">${esc(t.titulo)}</span>
      <span class="pjt-row__tag pjt-row__tag--sm" style="background:${bg};color:${clr}">${lbl}</span>
    </div>`;
  }

  function _tabGeneral(p, tasks) {
    const all      = tasks || [];
    const parents  = all.filter(t => !t.parent_task_id);
    const children = all.filter(t => t.parent_task_id);
    const childrenOf = pid => children.filter(c => c.parent_task_id === pid);

    if (!parents.length) {
      return `${_newTaskBtn(p)}
              <div class="pjcard__tl-label">HOY</div>
              <div class="pjt-empty">Sin tareas asignadas a este proyecto.</div>`;
    }
    // group by date
    const today = new Date(); today.setHours(0,0,0,0);
    const todayS = today.toISOString().split('T')[0];
    const byDate = {};
    parents.forEach(t => {
      const ds = t.deadline ? String(t.deadline).split('T')[0] : 'sin-fecha';
      if (!byDate[ds]) byDate[ds] = [];
      byDate[ds].push(t);
    });
    const DAYS_ES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const MONS_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const fmtHdr = ds => {
      if (ds === 'sin-fecha') return 'Sin fecha';
      const d = new Date(ds + 'T00:00:00');
      return `${DAYS_ES[d.getDay()].toUpperCase()} ${d.getDate()} ${MONS_ES[d.getMonth()].toUpperCase()}`;
    };
    const sorted = Object.keys(byDate).sort();
    const rows = sorted.map(ds => {
      const isT = ds === todayS;
      const taskRows = byDate[ds].map(t => {
        const kids = childrenOf(t.id);
        const subHtml = (kids.length && _expandedTasks.has(t.id))
          ? `<div class="pjt-subgroup">${kids.map(_subtaskRowHtml).join('')}</div>`
          : '';
        return _taskRowHtml(t, kids) + subHtml;
      }).join('');
      return `<div class="pjt-group">
        <div class="pjt-group__hdr${isT?' pjt-group__hdr--today':''}">${isT?'<span class="pjt-today-dot"></span>':''}${fmtHdr(ds)}</div>
        ${taskRows}
      </div>`;
    }).join('');
    return `${_newTaskBtn(p)}<div class="pjt-list">${rows}</div>`;
  }

  /* ── subtareas: estado compartido (Timeline + Lista) ─ */
  function _findProjectIdForTask(taskId) {
    for (const pid in _taskCache) {
      if (_taskCache[pid].some(t => t.id === taskId)) return +pid;
    }
    return null;
  }

  function toggleTaskExpand(taskId) {
    if (_expandedTasks.has(taskId)) _expandedTasks.delete(taskId);
    else _expandedTasks.add(taskId);
    if (_view === 'timeline') {
      const pid = _findProjectIdForTask(taskId);
      const p   = pid != null ? _projects.find(x => x.id === pid) : null;
      const cont = pid != null ? $(`pjcontent-${pid}`) : null;
      if (p && cont && (_activeTabs[pid] || 'general') === 'general') {
        cont.innerHTML = _tabGeneral(p, _taskCache[pid] || []);
      }
    } else {
      _renderTable(_filtered());
    }
  }

  let _subtaskMenuClose = null;
  function openSubtaskMenu(e, taskId, projectId) {
    if (_subtaskMenuClose) { _subtaskMenuClose(); return; }
    const menu = document.createElement('div');
    menu.className = 'd3-status-menu';
    menu.innerHTML = `<button class="d3-status-opt" onclick="ProjectsModule._createSubtaskFromMenu(${projectId},${taskId})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Crear subtarea
      </button>`;
    menu.style.cssText = `position:fixed;z-index:9999;top:${e.clientY + 4}px;left:${e.clientX + 4}px`;
    document.body.appendChild(menu);
    _subtaskMenuClose = () => {
      menu.remove();
      document.removeEventListener('click', _subtaskMenuClose);
      _subtaskMenuClose = null;
    };
    setTimeout(() => document.addEventListener('click', _subtaskMenuClose), 0);
  }

  function _createSubtaskFromMenu(projectId, taskId) {
    if (_subtaskMenuClose) _subtaskMenuClose();
    TasksModule.openDrawer(null, projectId, taskId);
  }

  /* ── FINANCIALS tab ─────────────────────────── */
  function _tabFinancials(p, tasks) {
    const money = (v, m) => {
      if (v === null || v === undefined || v === '') return '—';
      const n = +v;
      if (isNaN(n)) return '—';
      try { return new Intl.NumberFormat('es-MX',{style:'currency',currency:m||'USD',maximumFractionDigits:0}).format(n); }
      catch { return `${m||'USD'} ${n}`; }
    };
    const mon      = p.moneda || 'USD';
    const total    = p.valor_total || 0;
    const cobrado  = tasks.reduce((s, t) => s + (t.cobrado ? (+t.monto || 0) : 0), 0);
    const pendiente = Math.max(total - cobrado, 0);

    const taskRows = tasks.map(t => {
      const mv = t.monto != null ? t.monto : '';
      return `<div class="pjfin__task-row">
        <span class="pjfin__task-name" onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})">${esc(t.titulo)}</span>
        <div class="pjfin__task-monto">
          <span class="pjfin__task-currency">${mon}</span>
          <input class="pjfin__monto-input" type="number" min="0" placeholder="—" value="${mv}"
            onblur="ProjectsModule.updateTaskMonto(${t.id},this.value,${p.id})"
            onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value='${mv}';this.blur();}"/>
        </div>
        <button class="pjfin__cobrado-btn${t.cobrado?' pjfin__cobrado-btn--on':''}"
          onclick="ProjectsModule.toggleTaskCobrado(${t.id},${!t.cobrado},${p.id})">
          ${t.cobrado ? 'Cobrado' : 'Pendiente'}
        </button>
      </div>`;
    }).join('');

    return `
    <div class="pjfin__stats">
      <div class="pjfin__stat">
        <span class="pjfin__stat-lbl">Total proyecto</span>
        <span class="pjfin__stat-val">${money(total, mon)}</span>
      </div>
      <div class="pjfin__stat pjfin__stat--paid">
        <span class="pjfin__stat-lbl">Total cobrado</span>
        <span class="pjfin__stat-val">${money(cobrado || null, mon)}</span>
      </div>
      <div class="pjfin__stat pjfin__stat--due">
        <span class="pjfin__stat-lbl">Pendiente</span>
        <span class="pjfin__stat-val">${money(pendiente || null, mon)}</span>
      </div>
    </div>
    ${tasks.length ? `<div class="pjfin__section-title" style="margin-top:16px;margin-bottom:6px">TAREAS</div>
    <div class="pjfin__tasks">${taskRows}</div>` : '<div class="pjfin__empty-tasks">Sin tareas asignadas</div>'}`;
  }

  /* ── MORE INFO tab ──────────────────────────── */
  function _tabInfo(p) {
    return `<div class="pjinfo__edit">
      <textarea class="form-input form-textarea pjinfo__textarea" rows="4"
        placeholder="Objetivos, alcance, detalles del proyecto…"
        onblur="ProjectsModule.updateDescripcion(${p.id},this.value)"
        onkeydown="if(event.key==='Escape'){this.value=${JSON.stringify(p.descripcion || '')};this.blur();}"
      >${esc(p.descripcion || '')}</textarea>
      <span class="pjinfo__save-hint" id="pjinfo-saved-${p.id}"></span>
    </div>`;
  }

  async function updateDescripcion(pid, value) {
    const p = _projects.find(x => x.id === pid);
    if (!p) return;
    const trimmed = value.trim();
    if (trimmed === (p.descripcion || '')) return;
    const hint = $(`pjinfo-saved-${pid}`);
    if (hint) hint.textContent = 'Guardando…';
    const data = {
      nombre:          p.nombre,
      client_id:       p.client_id,
      descripcion:     trimmed,
      estado:          p.estado,
      prioridad:       p.prioridad,
      responsable:     p.responsable || '',
      responsable_id:  p.responsable_id || null,
      responsables:    p.responsables || [],
      fecha_inicio:    p.fecha_inicio ? p.fecha_inicio.split('T')[0] : null,
      fecha_fin:       p.fecha_fin    ? p.fecha_fin.split('T')[0]    : null,
      tipo_proyecto:   p.tipo_proyecto || 'fijo',
      moneda:          p.moneda || 'USD',
      valor_total:     p.valor_total,
      tarifa_hora:     p.tarifa_hora,
      horas_estimadas: p.horas_estimadas,
      horas_semanales: p.horas_semanales,
      horario_semanal: p.horario_semanal || '',
      comision:        p.comision,
    };
    try {
      const res = await apiFetch(`${API}/mgmt/projects/${pid}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('Error al guardar');
      p.descripcion = trimmed;
      if (hint) {
        hint.textContent = 'Guardado ✓';
        setTimeout(() => { if (hint) hint.textContent = ''; }, 1500);
      }
    } catch (e) {
      if (hint) hint.textContent = 'Error al guardar';
    }
  }

  /* ── ARCHIVOS tab: enlaces (Drive, brief, etc.) ─ */
  function _tabLinks(p) {
    const links = Array.isArray(p.links) ? p.links : [];
    const rows = links.map((l, i) => `
      <div class="pjlinks__row">
        <input class="pjlinks__label" type="text" placeholder="Ej: Carpeta de archivos, Brief…"
          value="${esc(l.label || '')}" onchange="ProjectsModule._setLinkField(${p.id},${i},'label',this.value)">
        <input class="pjlinks__url" type="url" placeholder="https://…"
          value="${esc(l.url || '')}" onchange="ProjectsModule._setLinkField(${p.id},${i},'url',this.value)">
        ${l.url ? `<a class="pjlinks__open" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="Abrir">↗</a>` : '<span class="pjlinks__open pjlinks__open--disabled">↗</span>'}
        <button type="button" class="pjlinks__del" title="Eliminar" onclick="ProjectsModule.removeLink(${p.id},${i})">×</button>
      </div>`).join('');

    return `<div class="pjlinks">
      ${links.length ? `<div class="pjlinks__list">${rows}</div>` : '<div class="pjt-empty">Sin archivos o enlaces todavía.</div>'}
      <div class="pjlinks__footer">
        <button type="button" class="btn btn--ghost btn--sm" onclick="ProjectsModule.addLink(${p.id})">+ Agregar enlace</button>
        <span style="display:flex;align-items:center;gap:8px">
          <span class="pjinfo__save-hint" id="pjlinks-saved-${p.id}"></span>
          <button type="button" class="btn btn--primary btn--sm" onclick="ProjectsModule.saveLinks(${p.id})">Guardar</button>
        </span>
      </div>
    </div>`;
  }

  function _rerenderLinksTab(pid) {
    const p = _projects.find(x => x.id === pid);
    const cont = $(`pjcontent-${pid}`);
    if (p && cont) cont.innerHTML = _tabLinks(p);
  }

  function addLink(pid) {
    const p = _projects.find(x => x.id === pid);
    if (!p) return;
    if (!Array.isArray(p.links)) p.links = [];
    p.links.push({ label: '', url: '' });
    _rerenderLinksTab(pid);
  }

  function removeLink(pid, idx) {
    const p = _projects.find(x => x.id === pid);
    if (!p || !Array.isArray(p.links)) return;
    p.links.splice(idx, 1);
    _rerenderLinksTab(pid);
  }

  function _setLinkField(pid, idx, field, value) {
    const p = _projects.find(x => x.id === pid);
    if (!p || !Array.isArray(p.links) || !p.links[idx]) return;
    p.links[idx][field] = value;
  }

  async function saveLinks(pid) {
    const p = _projects.find(x => x.id === pid);
    if (!p) return;
    const hint = $(`pjlinks-saved-${pid}`);
    if (hint) hint.textContent = 'Guardando…';
    const links = (p.links || []).filter(l => (l.label && l.label.trim()) || (l.url && l.url.trim()));
    try {
      const res = await apiFetch(`${API}/mgmt/projects/${pid}/links`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links })
      });
      if (!res.ok) throw new Error('Error al guardar');
      p.links = links;
      _rerenderLinksTab(pid);
      const hint2 = $(`pjlinks-saved-${pid}`);
      if (hint2) {
        hint2.textContent = 'Guardado ✓';
        setTimeout(() => { if (hint2) hint2.textContent = ''; }, 1500);
      }
    } catch (e) {
      if (hint) hint.textContent = 'Error al guardar';
    }
  }

  /* ── switch sub-tab ─────────────────────────── */
  const _TAB_PREFIX = { general: 'gen', info: 'más', financials: 'fin', links: 'arch' };
  function switchTab(pid, tab) {
    _activeTabs[pid] = tab;
    const card = $(`pjcard-${pid}`);
    if (!card) return;
    card.querySelectorAll('.pjcard__tab').forEach(b =>
      b.classList.toggle('pjcard__tab--active', b.textContent.trim().toLowerCase().startsWith(_TAB_PREFIX[tab] || 'gen'))
    );
    const content = $(`pjcontent-${pid}`);
    if (content) {
      const p = _projects.find(x => x.id === pid);
      if (p) content.innerHTML = _tabContent(p, tab, _taskCache[pid] || []);
    }
  }

  /* ── async-load tasks for a card ────────────── */
  async function _loadAndRenderGeneral(p) {
    try {
      const res = await apiFetch(`${API}/mgmt/tasks`);
      if (!res.ok) return;
      const all = await res.json();
      const tasks = (Array.isArray(all) ? all : []).filter(t => t.project_id === p.id);
      _taskCache[p.id] = tasks;
      // update progress bar
      const total = tasks.length;
      const done  = tasks.filter(t => t.estado === 'completado').length;
      const pct   = total ? Math.round(done / total * 100) : 0;
      const txt   = $(`pjprog-txt-${p.id}`);
      const fill  = $(`pjprog-fill-${p.id}`);
      if (txt)  txt.textContent  = `${done}/${total} `;
      if (fill) fill.style.width = `${pct}%`;
      // refresh active tab content
      const tab = _activeTabs[p.id] || 'general';
      const cont = $(`pjcontent-${p.id}`);
      if (cont) {
        if (tab === 'general')    cont.innerHTML = _tabGeneral(p, tasks);
        if (tab === 'financials') cont.innerHTML = _tabFinancials(p, tasks);
      }
    } catch { /* silent */ }
  }

  async function refreshCard(pid) {
    const p = _projects.find(x => x.id === pid);
    if (!p) return;
    if (_view === 'timeline') {
      _loadAndRenderGeneral(p);
    } else if (_expandedProjects.has(pid)) {
      await _ensureAllTasksLoaded();
      _renderTable(_filtered());
    }
  }

  async function toggleTaskCobrado(taskId, cobrado, projectId) {
    try {
      await apiFetch(`${API}/mgmt/tasks/${taskId}/billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cobrado })
      });
      const cache = _taskCache[projectId];
      if (cache) { const t = cache.find(x => x.id === taskId); if (t) t.cobrado = cobrado; }
      const p = _projects.find(x => x.id === projectId);
      if (p && (_activeTabs[projectId] || 'general') === 'financials') {
        const cont = $(`pjcontent-${projectId}`);
        if (cont) cont.innerHTML = _tabFinancials(p, _taskCache[projectId] || []);
      }
    } catch {}
  }

  async function updateTaskMonto(taskId, val, projectId) {
    try {
      const monto = val === '' ? null : +val;
      await apiFetch(`${API}/mgmt/tasks/${taskId}/billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monto })
      });
      const cache = _taskCache[projectId];
      if (cache) { const t = cache.find(x => x.id === taskId); if (t) t.monto = monto; }
      const p = _projects.find(x => x.id === projectId);
      if (p && (_activeTabs[projectId] || 'general') === 'financials') {
        const cont = $(`pjcontent-${projectId}`);
        if (cont) cont.innerHTML = _tabFinancials(p, _taskCache[projectId] || []);
      }
    } catch {}
  }

  /* ── table view (Lista) ─────────────────────── */
  async function toggleProjectExpand(pid) {
    if (_expandedProjects.has(pid)) {
      _expandedProjects.delete(pid);
      _renderTable(_filtered());
      return;
    }
    _expandedProjects.add(pid);
    _renderTable(_filtered());
    if (!_taskCache[pid]) {
      await _ensureAllTasksLoaded();
      _renderTable(_filtered());
    }
  }

  async function _ensureAllTasksLoaded() {
    try {
      const res = await apiFetch(`${API}/mgmt/tasks`);
      if (!res.ok) return;
      const all = await res.json();
      const byProject = {};
      (Array.isArray(all) ? all : []).forEach(t => {
        (byProject[t.project_id] = byProject[t.project_id] || []).push(t);
      });
      _projects.forEach(p => { _taskCache[p.id] = byProject[p.id] || []; });
    } catch {}
  }

  function _taskTreeHtml(pid) {
    const tasks = _taskCache[pid];
    if (tasks === undefined) return `<div class="pjlist-tasks__loading">Cargando tareas…</div>`;
    const parents = tasks.filter(t => !t.parent_task_id);
    if (!parents.length) {
      return `<div class="pjlist-tasks__empty">Sin tareas asignadas.</div>${_newTaskBtn({ id: pid })}`;
    }
    const childrenOf = parentId => tasks.filter(t => t.parent_task_id === parentId);
    const rows = parents.map(t => {
      const kids = childrenOf(t.id);
      const done = kids.filter(k => k.estado === 'completado').length;
      const isOpen = _expandedTasks.has(t.id);
      const subHtml = (kids.length && isOpen)
        ? `<div class="pjlist-sub-group">${kids.map(k => `
            <div class="pjlist-sub-row" onclick="event.stopPropagation();TasksModule.openDrawer(${k.id})">
              <span class="pjt-row__dot pjt-row__dot--sm" style="background:${_TASK_PRIO_DOT[k.prioridad] || '#9CA3AF'}"></span>
              <span class="pjlist-sub-name">${esc(k.titulo)}</span>
              <span class="pjt-row__tag pjt-row__tag--sm" style="background:${_TASK_ESTADO_BG[k.estado]||'#F3F4F6'};color:${_TASK_ESTADO_CLR[k.estado]||'#6B7280'}">${_TASK_ESTADO_LBL[k.estado]||k.estado}</span>
            </div>`).join('')}</div>`
        : '';
      return `<div class="pjlist-task-row" data-task-id="${t.id}"
          onclick="event.stopPropagation();TasksModule.openDrawer(${t.id})"
          oncontextmenu="event.preventDefault();event.stopPropagation();ProjectsModule.openSubtaskMenu(event,${t.id},${pid})">
        ${_chevronHtml(t.id, kids.length)}
        <span class="pjt-row__dot" style="background:${_TASK_PRIO_DOT[t.prioridad] || '#9CA3AF'}"></span>
        <span class="pjlist-task-name">${esc(t.titulo)}</span>
        ${kids.length ? `<span class="pjt-subcount">${done}/${kids.length} subtarea${kids.length !== 1 ? 's' : ''}</span>` : ''}
        <span class="pjt-row__tag" style="background:${_TASK_ESTADO_BG[t.estado]||'#F3F4F6'};color:${_TASK_ESTADO_CLR[t.estado]||'#6B7280'}">${_TASK_ESTADO_LBL[t.estado]||t.estado}</span>
        <button type="button" class="pjt-add-sub" title="Agregar subtarea"
          onclick="event.stopPropagation();TasksModule.openDrawer(null,${pid},${t.id})">+ Subtarea</button>
      </div>${subHtml}`;
    }).join('');
    return `<div class="pjlist-tasks">${rows}</div>${_newTaskBtn({ id: pid })}`;
  }

  function _renderTable(list) {
    const tbody = $('projects-tbody');
    if (!tbody) return;
    const prioColors = { alta: '#F87171', media: '#FBBF24', baja: '#6EE7B7' };
    tbody.innerHTML = list.map(p => {
      const mon = p.moneda || 'USD';
      const money = (v) => {
        if (!v) return '<span class="muted">—</span>';
        try { return new Intl.NumberFormat('es-MX',{style:'currency',currency:mon,maximumFractionDigits:0}).format(v); }
        catch { return `${mon} ${v}`; }
      };
      let val = '';
      if (p.tipo_proyecto === 'fijo') val = money(p.valor_total);
      else if (p.tipo_proyecto === 'horas') val = p.tarifa_hora ? money(p.tarifa_hora) + '/h' : '<span class="muted">—</span>';
      else val = money(p.valor_total);
      const isOpen = _expandedProjects.has(p.id);
      const expandRow = isOpen
        ? `<tr class="pjlist-expand-row"><td colspan="7">${_taskTreeHtml(p.id)}</td></tr>`
        : '';
      return `<tr class="clients-table__row" onclick="ProjectsModule.toggleProjectExpand(${p.id})">
        <td><div style="display:flex;align-items:center;gap:8px">
          <button type="button" class="pjt-chevron${isOpen ? ' pjt-chevron--open' : ''}" onclick="event.stopPropagation();ProjectsModule.toggleProjectExpand(${p.id})">${_chevronSvg}</button>
          <div style="width:8px;height:8px;border-radius:2px;background:${prioColors[p.prioridad]||'#FBBF24'};flex-shrink:0"></div>
          <span class="client-nombre">${esc(p.nombre)}</span>
        </div></td>
        <td class="client-meta">${p.client_nombre ? esc(p.client_nombre) : '<span class="muted">—</span>'}</td>
        <td>${_estadoBadge(p.estado)}</td>
        <td>${_tipoBadge(p.tipo_proyecto || 'fijo')}</td>
        <td class="client-meta">${_fmtDate(p.fecha_fin)}</td>
        <td class="client-meta">${val}</td>
        <td><div class="client-actions-cell">
          <button class="client-action-btn" onclick="event.stopPropagation();ProjectsModule.openDrawer(${p.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="client-action-btn client-action-btn--danger" onclick="event.stopPropagation();ProjectsModule.confirmDelete(${p.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div></td>
      </tr>${expandRow}`;
    }).join('');
  }

  /* ── setView ────────────────────────────────── */
  function setView(v) {
    _view = v;
    $('pv-tab-timeline')?.classList.toggle('pv-view--active', v === 'timeline');
    $('pv-tab-lista')?.classList.toggle('pv-view--active', v === 'lista');
    render();
  }

  async function _fetchAndPopulateClients(selectedId) {
    const sel = $('projects-client-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Cargando clientes…</option>';
    try {
      const res = await apiFetch(`${API}/mgmt/clients`);
      const clients = res.ok ? await res.json() : [];
      sel.innerHTML =
        '<option value="">Seleccionar cliente…</option>' +
        clients.map(c =>
          `<option value="${c.id}" ${selectedId == c.id ? 'selected' : ''}>${esc(c.nombre)}${c.empresa ? ' · ' + esc(c.empresa) : ''}</option>`
        ).join('') +
        '<option value="__new__" class="opt-create-new">＋ Crear nuevo cliente</option>';
      sel.onchange = function() {
        if (this.value === '__new__') { this.value = ''; _openQuickClientModal(); }
      };
    } catch {
      sel.innerHTML = '<option value="">Error al cargar clientes</option>';
    }
  }

  function _openQuickClientModal() {
    if ($('qc-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'qc-modal';
    modal.innerHTML = `
      <div class="qc-backdrop" onclick="ProjectsModule.closeQuickClientModal()"></div>
      <div class="qc-box">
        <div class="qc-header">
          <span class="qc-title">Nuevo cliente</span>
          <button class="qc-close" onclick="ProjectsModule.closeQuickClientModal()">✕</button>
        </div>
        <form id="qc-form" onsubmit="ProjectsModule.saveQuickClient(event)">
          <div class="qc-field">
            <label class="qc-label">Nombre <span style="color:var(--brand)">*</span></label>
            <input class="qc-input" name="nombre" required placeholder="Ej. María García" autofocus/>
          </div>
          <div class="qc-field">
            <label class="qc-label">Empresa</label>
            <input class="qc-input" name="empresa" placeholder="Ej. Acme Corp"/>
          </div>
          <div class="qc-field">
            <label class="qc-label">Email</label>
            <input class="qc-input" name="email" type="email" placeholder="correo@empresa.com"/>
          </div>
          <div class="qc-field">
            <label class="qc-label">Teléfono</label>
            <input class="qc-input" name="telefono" placeholder="+52 55 0000 0000"/>
          </div>
          <div class="qc-actions">
            <button type="button" class="qc-btn qc-btn--cancel" onclick="ProjectsModule.closeQuickClientModal()">Cancelar</button>
            <button type="submit" class="qc-btn qc-btn--save" id="qc-save-btn">Crear cliente</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(modal);
    setTimeout(() => modal.querySelector('[name=nombre]')?.focus(), 50);
  }

  function closeQuickClientModal() {
    $('qc-modal')?.remove();
  }

  async function saveQuickClient(e) {
    e.preventDefault();
    const form = e.target;
    const btn  = $('qc-save-btn');
    const data = {
      nombre:   form.nombre.value.trim(),
      empresa:  form.empresa.value.trim(),
      email:    form.email.value.trim(),
      telefono: form.telefono.value.trim(),
      estado:   'activo',
    };
    btn.disabled = true; btn.textContent = 'Creando…';
    try {
      const res = await apiFetch(`${API}/mgmt/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const client = await res.json();
      closeQuickClientModal();
      await _fetchAndPopulateClients(client.id);
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled = false; btn.textContent = 'Crear cliente';
    }
  }

  async function openDrawer(id = null) {
    _editId = id ?? null;
    const title   = $('projects-drawer-title');
    const saveBtn = $('projects-save-btn');
    const delBtn  = $('proj-delete-btn');
    if (!title) return;

    if (_editId) {
      const p = _projects.find(x => x.id === _editId);
      if (!p) return;
      title.textContent = 'Editar proyecto';
      saveBtn.textContent = 'Guardar cambios';
      if (delBtn) delBtn.style.display = '';
      $('proj-edit-id').value   = p.id;
      $('proj-nombre').value    = p.nombre || '';
      $('proj-estado').value    = p.estado || 'activo';
      $('proj-prioridad').value = p.prioridad || 'media';
      $('proj-descripcion').value = p.descripcion || '';
      if (p.fecha_inicio) $('proj-fecha-inicio').value = p.fecha_inicio.split('T')[0];
      if (p.fecha_fin)    $('proj-fecha-fin').value    = p.fecha_fin.split('T')[0];

      const tipo = p.tipo_proyecto || 'fijo';
      $('proj-tipo').value = tipo;
      onTipoChange(tipo);

      const mon = p.moneda || 'USD';
      if (tipo === 'fijo') {
        $('proj-valor-total').value = p.valor_total ?? '';
        $('proj-moneda').value      = mon;
      } else if (tipo === 'horas') {
        $('proj-tarifa-hora').value = p.tarifa_hora ?? '';
        $('proj-horas-est').value   = p.horas_estimadas ?? '';
        $('proj-moneda-horas').value = mon;
      } else if (tipo === 'semanal') {
        $('proj-tarifa-hora-s').value  = p.tarifa_hora ?? '';
        $('proj-horas-sem').value      = p.horas_semanales ?? '';
        $('proj-horario').value        = p.horario_semanal || '';
        $('proj-moneda-semanal').value = mon;
      }

      if ($('proj-comision')) $('proj-comision').value = p.comision ?? '';
      await _fetchAndPopulateClients(p.client_id);
    } else {
      title.textContent   = 'Nuevo proyecto';
      saveBtn.textContent = 'Crear proyecto';
      if (delBtn) delBtn.style.display = 'none';
      $('proj-edit-id').value = '';
      $('proj-nombre').value  = '';
      $('proj-estado').value  = 'activo';
      $('proj-prioridad').value = 'media';
      $('proj-descripcion').value = '';
      $('proj-fecha-inicio').value = '';
      $('proj-fecha-fin').value    = '';
      $('proj-tipo').value = 'fijo';
      onTipoChange('fijo');
      $('proj-valor-total').value = '';
      $('proj-moneda').value      = 'USD';
      if ($('proj-comision')) $('proj-comision').value = '';
      await _fetchAndPopulateClients(null);
    }

    $('projects-drawer').classList.add('open');
    $('projects-drawer-overlay').classList.add('open');
    setTimeout(() => $('proj-nombre')?.focus(), 150);
  }

  function closeDrawer() {
    $('projects-drawer')?.classList.remove('open');
    $('projects-drawer-overlay')?.classList.remove('open');
    _editId = null;
  }

  async function save(e) {
    e.preventDefault();
    const saveBtn = $('projects-save-btn');
    const tipo = $('proj-tipo').value;

    let tarifa_hora = null, horas_estimadas = null, horas_semanales = null,
        horario_semanal = '', valor_total = null, moneda = 'USD';

    if (tipo === 'fijo') {
      valor_total = $('proj-valor-total').value ? parseFloat($('proj-valor-total').value) : null;
      moneda      = $('proj-moneda').value || 'USD';
    } else if (tipo === 'horas') {
      tarifa_hora      = $('proj-tarifa-hora').value ? parseFloat($('proj-tarifa-hora').value) : null;
      horas_estimadas  = $('proj-horas-est').value  ? parseFloat($('proj-horas-est').value)   : null;
      moneda           = $('proj-moneda-horas').value || 'USD';
    } else if (tipo === 'semanal') {
      tarifa_hora     = $('proj-tarifa-hora-s').value ? parseFloat($('proj-tarifa-hora-s').value) : null;
      horas_semanales = $('proj-horas-sem').value     ? parseFloat($('proj-horas-sem').value)     : null;
      horario_semanal = $('proj-horario').value?.trim() || '';
      moneda          = $('proj-moneda-semanal').value || 'USD';
    }

    const data = {
      nombre:          $('proj-nombre').value.trim(),
      client_id:       parseInt($('projects-client-select').value) || null,
      descripcion:     $('proj-descripcion').value.trim(),
      estado:          $('proj-estado').value,
      prioridad:       $('proj-prioridad').value,
      responsable_id:  null,
      fecha_inicio:    $('proj-fecha-inicio').value || null,
      fecha_fin:       $('proj-fecha-fin').value    || null,
      tipo_proyecto:   tipo,
      moneda,
      valor_total,
      tarifa_hora,
      horas_estimadas,
      horas_semanales,
      horario_semanal,
      comision:        $('proj-comision')?.value ? parseFloat($('proj-comision').value) : null,
    };

    const orig = saveBtn.textContent;
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Guardando…';
    try {
      const res = await apiFetch(
        `${API}/mgmt/projects${_editId ? '/' + _editId : ''}`,
        { method: _editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      );
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
      closeDrawer();
      await load();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = orig;
    }
  }

  async function confirmDelete(id) {
    const targetId = id ?? _editId;
    const p = _projects.find(x => x.id === targetId);
    if (!confirm(`¿Eliminar "${p?.nombre}"? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await apiFetch(`${API}/mgmt/projects/${targetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      closeDrawer();
      await load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  return { load, filter, setFilter, setMemberFilter, render, onTipoChange, openDrawer, closeDrawer, save, confirmDelete, setView, switchTab, toggleTaskCobrado, updateTaskMonto, updateDescripcion, addLink, removeLink, _setLinkField, saveLinks, refreshCard, closeQuickClientModal, saveQuickClient, toggleTaskExpand, toggleProjectExpand, openSubtaskMenu, _createSubtaskFromMenu };
})();

// =================================================================
// BLOCKS MODULE — filtered view of estado='bloqueado' tasks
// =================================================================

const BlocksModule = (() => {
  let _all = [], _filter = 'all', _q = '';

  function _isOverdue(t) {
    if (!t.deadline) return false;
    return new Date(t.deadline) < new Date(new Date().toDateString());
  }

  function _prioBadge(p) {
    const map = {
      alta:  { label: 'Alta',  bg: '#FBBFB0', color: '#9F1239' },
      media: { label: 'Media', bg: '#FDE68A', color: '#78350F' },
      baja:  { label: 'Baja',  bg: '#A7F3D0', color: '#065F46' },
    };
    const m = map[p] || { label: p, bg: '#F5F5F4', color: '#57534E' };
    return `<span class="client-badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  async function load() {
    document.getElementById('blk-loading').style.display = 'flex';
    document.getElementById('blk-table-wrap').style.display = 'none';
    document.getElementById('blk-empty').style.display = 'none';
    try {
      const res = await apiFetch(`${API}/mgmt/tasks`);
      const data = await res.json();
      _all = (Array.isArray(data) ? data : []).filter(t => t.estado === 'bloqueado');
      render();
    } catch(e) { alert('Error cargando bloqueos: ' + e.message); }
    finally { document.getElementById('blk-loading').style.display = 'none'; }
  }

  function filter(q) { _q = (q || '').toLowerCase(); render(); }
  function setFilter(f, el) {
    _filter = f;
    document.querySelectorAll('[data-blk]').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    render();
  }

  function render() {
    const today = new Date(new Date().toDateString());
    let rows = _all.filter(t => {
      if (_filter === 'alta'    && t.prioridad !== 'alta')                return false;
      if (_filter === 'vencido' && !_isOverdue(t))                        return false;
      if (_q) {
        const hay = [t.titulo, t.responsable, ...(t.responsables||[]), t.notas, t.project_nombre, t.client_nombre].join(' ').toLowerCase();
        if (!hay.includes(_q)) return false;
      }
      return true;
    });

    const tbody = document.getElementById('blk-tbody');
    if (!rows.length) {
      document.getElementById('blk-table-wrap').style.display = 'none';
      document.getElementById('blk-empty').style.display = 'flex';
      return;
    }
    document.getElementById('blk-empty').style.display = 'none';
    document.getElementById('blk-table-wrap').style.display = '';

    tbody.innerHTML = rows.map(t => {
      const overdue = _isOverdue(t);
      const dl = t.deadline
        ? `<span${overdue ? ' class="blk-overdue-chip"' : ''}>${new Date(t.deadline).toLocaleDateString('es-ES',{day:'2-digit',month:'short'})}</span>`
        : '<span style="color:var(--muted)">—</span>';
      const proj = t.project_nombre
        ? `${esc(t.project_nombre)}${t.client_nombre ? ' · <span style="color:var(--muted)">' + esc(t.client_nombre) + '</span>' : ''}` : '—';
      return `<tr class="clients-table__row">
        <td style="font-weight:600">${esc(t.titulo)}</td>
        <td>${proj}</td>
        <td>${(t.responsables?.length ? t.responsables : t.responsable ? [t.responsable] : []).map(r=>esc(r)).join(', ') || '<span style="color:var(--muted)">—</span>'}</td>
        <td><span class="blk-motivo">${t.notas ? esc(t.notas) : '<span style="color:var(--muted)">—</span>'}</span></td>
        <td>${dl}</td>
        <td>${_prioBadge(t.prioridad)}</td>
        <td class="client-actions-cell">
          <button class="client-action-btn" onclick="TasksModule.openDrawer(${t.id})" title="Editar en Tareas">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  return { load, filter, setFilter, render };
})();

// =================================================================
// TEAM MODULE — CRUD for team_members
// =================================================================

const TeamModule = (() => {
  let _all = [], _filter = 'all', _q = '';

  const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', miembro: 'Miembro', freelance: 'Freelance' };
  const ROLE_COLORS = {
    admin:     'background:#EDE9FE;color:#5B21B6',
    manager:   'background:#DBEAFE;color:#1E40AF',
    miembro:   'background:#F5F5F4;color:#57534E',
    freelance: 'background:#FEF3C7;color:#92400E',
  };

  function _initials(name) {
    return (name || '?').split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
  }
  function _avatarColor(name) {
    const colors = ['#7C3AED','#2563EB','#059669','#D97706','#DC2626','#7C3AED','#0891B2'];
    let h = 0; for (const c of (name||'')) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF;
    return colors[h % colors.length];
  }

  async function load() {
    document.getElementById('team-loading').style.display = 'flex';
    document.getElementById('team-table-wrap').style.display = 'none';
    document.getElementById('team-empty').style.display = 'none';
    try {
      const res = await apiFetch(`${API}/mgmt/team`);
      const data = await res.json();
      _all = Array.isArray(data) ? data : [];
      render();
    } catch(e) { alert('Error cargando equipo: ' + e.message); }
    finally { document.getElementById('team-loading').style.display = 'none'; }
  }

  function filter(q) { _q = (q || '').toLowerCase(); render(); }
  function setFilter(f, el) {
    _filter = f;
    document.querySelectorAll('[data-team]').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    render();
  }

  function render() {
    let rows = _all.filter(m => {
      if (_filter === 'activo'   && m.estado !== 'activo')   return false;
      if (_filter === 'inactivo' && m.estado !== 'inactivo') return false;
      if (_q) {
        const hay = [m.nombre, m.email, m.rol, m.notas].join(' ').toLowerCase();
        if (!hay.includes(_q)) return false;
      }
      return true;
    });

    const tbody = document.getElementById('team-tbody');
    if (!rows.length) {
      document.getElementById('team-table-wrap').style.display = 'none';
      document.getElementById('team-empty').style.display = 'flex';
      return;
    }
    document.getElementById('team-empty').style.display = 'none';
    document.getElementById('team-table-wrap').style.display = '';

    tbody.innerHTML = rows.map(m => {
      const n = parseInt(m.tareas_activas, 10) || 0;
      const wClass = n === 0 ? 'workload-badge--zero' : n >= 5 ? 'workload-badge--high' : '';
      const rolStyle = ROLE_COLORS[m.rol] || ROLE_COLORS.miembro;
      const bg = _avatarColor(m.nombre);
      return `<tr class="clients-table__row">
        <td>
          <div class="team-member-cell">
            <img class="team-avatar" src="https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(m.nombre)}" style="object-fit:cover" alt=""/>
            <div>
              <div class="team-member-cell__name">${esc(m.nombre)}</div>
            </div>
          </div>
        </td>
        <td>${m.email ? esc(m.email) : '<span style="color:var(--muted)">—</span>'}</td>
        <td><span class="client-badge" style="${rolStyle}">${ROLE_LABELS[m.rol] || m.rol}</span></td>
        <td><span class="client-badge" style="${m.estado==='activo'?'background:#A7F3D0;color:#065F46':'background:#F5F5F4;color:#57534E'}">${m.estado==='activo'?'Activo':'Inactivo'}</span></td>
        <td><span class="workload-badge ${wClass}">${n} tarea${n!==1?'s':''}</span></td>
        <td><span class="blk-motivo">${m.notas ? esc(m.notas) : '<span style="color:var(--muted)">—</span>'}</span></td>
        <td class="client-actions-cell">
          <button class="client-action-btn" onclick="TeamModule.openDrawer(${m.id})" title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  function openDrawer(id) {
    const m = id ? _all.find(x => x.id === id) : null;
    document.getElementById('team-drawer-title').textContent = m ? 'Editar miembro' : 'Nuevo miembro';
    document.getElementById('team-id').value    = m ? m.id : '';
    document.getElementById('team-nombre').value = m ? m.nombre : '';
    document.getElementById('team-email').value  = m ? (m.email || '') : '';
    document.getElementById('team-rol').value    = m ? (m.rol || 'miembro') : 'miembro';
    document.getElementById('team-cargo').value  = m ? (m.cargo || '') : '';
    document.getElementById('team-estado').value = m ? (m.estado || 'activo') : 'activo';
    document.getElementById('team-notas').value  = m ? (m.notas || '') : '';
    document.getElementById('team-save-btn').textContent = m ? 'Guardar cambios' : 'Guardar miembro';
    document.getElementById('team-delete-btn').style.display = m ? '' : 'none';
    document.getElementById('team-drawer-overlay').classList.add('open');
    document.getElementById('team-drawer').classList.add('open');
    setTimeout(() => document.getElementById('team-nombre').focus(), 80);
  }

  function closeDrawer() {
    document.getElementById('team-drawer-overlay').classList.remove('open');
    document.getElementById('team-drawer').classList.remove('open');
  }

  async function save(e) {
    e.preventDefault();
    const id = document.getElementById('team-id').value;
    const body = {
      nombre: document.getElementById('team-nombre').value.trim(),
      email:  document.getElementById('team-email').value.trim(),
      rol:    document.getElementById('team-rol').value,
      cargo:  document.getElementById('team-cargo').value.trim(),
      estado: document.getElementById('team-estado').value,
      notas:  document.getElementById('team-notas').value.trim(),
    };
    const btn = document.getElementById('team-save-btn');
    btn.disabled = true;
    try {
      if (id) await apiFetch(`${API}/mgmt/team/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      else     await apiFetch(`${API}/mgmt/team`,      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      closeDrawer();
      load();
    } catch(err) { alert('Error guardando miembro: ' + err.message); }
    finally { btn.disabled = false; }
  }

  async function confirmDelete() {
    const id = document.getElementById('team-id').value;
    if (!id || !confirm('¿Eliminar este miembro del equipo?')) return;
    try {
      await apiFetch(`${API}/mgmt/team/${id}`, { method: 'DELETE' });
      closeDrawer();
      load();
    } catch(err) { alert('Error eliminando miembro: ' + err.message); }
  }

  return { load, filter, setFilter, render, openDrawer, closeDrawer, save, confirmDelete };
})();

// =================================================================
// LEAD MANAGER MODULE
// =================================================================

const LeadManagerModule = (() => {
  let _data   = [];
  let _stage  = '';

  const STAGE_LABELS = {
    nuevo: 'Nuevo', contactado: 'Contactado', propuesta: 'Propuesta',
    negociacion: 'Negociación', ganado: 'Ganado', perdido: 'Perdido',
  };
  const STAGE_STYLES = {
    nuevo:       'background:#BFDBFE;color:#1E40AF',
    contactado:  'background:#FDE68A;color:#92400E',
    propuesta:   'background:#FDBA74;color:#9A3412',
    negociacion: 'background:#DDD6FE;color:#5B21B6',
    ganado:      'background:#A7F3D0;color:#065F46',
    perdido:     'background:#F5F5F4;color:#57534E',
  };

  async function load() {
    $('lm-loading').style.display = '';
    $('lm-empty').classList.add('hidden');
    $('lm-table-wrap').classList.add('hidden');
    try {
      const res = await apiFetch(`${API}/leads`);
      _data = await res.json();
      if (!Array.isArray(_data)) _data = [];
    } catch (e) {
      console.warn('[lm] load error:', e.message);
      _data = [];
    }
    $('lm-loading').style.display = 'none';
    filter();
  }

  function filter() {
    const q = ($('lm-search')?.value || '').toLowerCase();
    let items = _data;
    if (_stage) items = items.filter(l => l.stage === _stage);
    if (q) items = items.filter(l =>
      (l.nombre + l.empresa + l.email + l.cargo).toLowerCase().includes(q)
    );
    render(items);
  }

  function setFilter(stage) {
    _stage = stage;
    document.querySelectorAll('#lm-filter-bar .filter-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.stage === stage);
    });
    filter();
  }

  function render(items) {
    if (!items.length) {
      $('lm-empty').classList.remove('hidden');
      $('lm-table-wrap').classList.add('hidden');
      return;
    }
    $('lm-empty').classList.add('hidden');
    $('lm-table-wrap').classList.remove('hidden');
    $('lm-tbody').innerHTML = items.map(l => {
      const valor = l.valor_estimado ? `$${Number(l.valor_estimado).toLocaleString()}` : '—';
      return `<tr class="clients-table__row" onclick="LeadManagerModule.openDrawer(${l.id})" style="cursor:pointer">
        <td>
          <div class="client-cell-name">
            <img class="client-avatar" src="https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(l.nombre)}" style="object-fit:cover" alt=""/>
            <div>
              <div class="client-nombre">${esc(l.nombre)}</div>
              ${l.cargo ? `<div class="client-empresa">${esc(l.cargo)}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="client-meta">${l.empresa ? esc(l.empresa) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="client-meta">${l.email ? esc(l.email) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="client-meta">${esc(l.fuente || 'manual')}</td>
        <td><span class="client-badge" style="${STAGE_STYLES[l.stage] || ''}">${STAGE_LABELS[l.stage] || l.stage}</span></td>
        <td class="client-meta">${valor}</td>
      </tr>`;
    }).join('');
  }

  function openDrawer(id) {
    const lead = id ? _data.find(l => l.id === id) : null;
    $('lm-drawer-title').textContent = lead ? 'Editar lead' : 'Nuevo lead';
    $('lm-id').value       = lead?.id || '';
    $('lm-nombre').value   = lead?.nombre || '';
    $('lm-empresa').value  = lead?.empresa || '';
    $('lm-email').value    = lead?.email || '';
    $('lm-cargo').value    = lead?.cargo || '';
    $('lm-telefono').value = lead?.telefono || '';
    $('lm-pais').value     = lead?.pais || '';
    $('lm-stage').value    = lead?.stage || 'nuevo';
    $('lm-valor').value    = lead?.valor_estimado || '';
    $('lm-fuente').value   = lead?.fuente || 'manual';
    $('lm-notas').value    = lead?.notas || '';
    $('lm-delete-btn').style.display  = lead ? '' : 'none';
    $('lm-convert-btn').style.display = (lead && lead.stage !== 'ganado') ? '' : 'none';
    $('lm-drawer-overlay').classList.remove('hidden');
    $('lm-drawer').classList.add('open');
    setTimeout(() => $('lm-nombre').focus(), 50);
  }

  function closeDrawer() {
    $('lm-drawer-overlay').classList.add('hidden');
    $('lm-drawer').classList.remove('open');
  }

  async function save(event) {
    event.preventDefault();
    const id = $('lm-id').value;
    const payload = {
      nombre:         $('lm-nombre').value.trim(),
      empresa:        $('lm-empresa').value.trim(),
      email:          $('lm-email').value.trim(),
      cargo:          $('lm-cargo').value.trim(),
      telefono:       $('lm-telefono').value.trim(),
      pais:           $('lm-pais').value.trim(),
      stage:          $('lm-stage').value,
      valor_estimado: $('lm-valor').value ? Number($('lm-valor').value) : null,
      fuente:         $('lm-fuente').value,
      notas:          $('lm-notas').value.trim(),
    };
    const btn = $('lm-save-btn');
    btn.disabled = true;
    try {
      const res = await apiFetch(
        `${API}/leads${id ? `/${id}` : ''}`,
        { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (!res.ok) throw new Error((await res.json()).error || 'Error');
      closeDrawer();
      await load();
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function confirmDelete() {
    const id = $('lm-id').value;
    if (!id || !confirm('¿Eliminar este lead?')) return;
    try {
      const res = await apiFetch(`${API}/leads/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Error');
      closeDrawer();
      await load();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function convertToClient() {
    const id = $('lm-id').value;
    if (!id || !confirm('¿Convertir este lead a cliente?\nSe creará en la sección Clientes.')) return;
    try {
      const res = await apiFetch(`${API}/leads/${id}/convert`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Error');
      closeDrawer();
      await load();
      alert('¡Lead convertido a cliente exitosamente!');
    } catch (e) { alert('Error: ' + e.message); }
  }

  return { load, filter, setFilter, openDrawer, closeDrawer, save, confirmDelete, convertToClient };
})();

// =================================================================
// WORKSPACE MODULE — name modal + invite flow
// =================================================================

const WorkspaceModule = (() => {
  const _ROL_HINTS = {
    miembro:  'Puede ver y trabajar en tareas asignadas',
    manager:  'Puede crear y editar proyectos, tareas y clientes',
    admin:    'Acceso completo — igual que el dueño del workspace',
  };

  function openInvite() {
    resetInvite();
    $('invite-overlay').classList.remove('hidden');
    $('invite-modal').classList.remove('hidden');
    setTimeout(() => $('invite-nombre').focus(), 80);
  }
  function closeInvite() {
    $('invite-overlay').classList.add('hidden');
    $('invite-modal').classList.add('hidden');
  }
  function resetInvite() {
    $('invite-form-wrap').style.display = '';
    $('invite-link-wrap').style.display = 'none';
    $('invite-nombre').value = '';
    $('invite-email').value  = '';
    $('invite-cargo').value  = '';
    $('invite-rol').value    = 'miembro';
    _updateRolHint('miembro');
    const btn = $('invite-gen-btn');
    btn.disabled    = false;
    btn.textContent = 'Generar link de invitación';
    // Wire rol hint
    $('invite-rol').onchange = e => _updateRolHint(e.target.value);
  }
  function _updateRolHint(rol) {
    const hint = $('invite-rol-hint');
    if (hint) hint.textContent = _ROL_HINTS[rol] || '';
  }
  async function generateInvite() {
    const nombre = $('invite-nombre').value.trim();
    const email  = $('invite-email').value.trim();
    const cargo  = $('invite-cargo').value.trim();
    const nivel  = $('invite-rol').value;
    if (!nombre) { $('invite-nombre').focus(); return; }
    if (!email)  { $('invite-email').focus();  return; }
    const btn = $('invite-gen-btn');
    btn.disabled    = true;
    btn.textContent = 'Generando…';
    try {
      const res  = await apiFetch(`${API}/workspace/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, email, cargo, nivel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      $('invite-link-input').value = data.invite_url;
      // Show success header
      const avatarEl = $('invite-success-avatar');
      const nameEl   = $('invite-success-name');
      const cargoEl  = $('invite-success-cargo');
      if (avatarEl) avatarEl.innerHTML = `<img src="https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(nombre)}" style="width:36px;height:36px;border-radius:50%">`;
      if (nameEl)   nameEl.textContent  = nombre;
      if (cargoEl)  cargoEl.textContent = cargo ? `${cargo} · ${nivel}` : nivel;
      $('invite-form-wrap').style.display = 'none';
      $('invite-link-wrap').style.display = '';
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled    = false;
      btn.textContent = 'Generar link de invitación';
    }
  }
  async function copyInvite() {
    const url = $('invite-link-input').value;
    try {
      await navigator.clipboard.writeText(url);
      $('invite-copy-btn').textContent = '✓ Copiado';
      setTimeout(() => { $('invite-copy-btn').textContent = 'Copiar'; }, 2000);
    } catch (_) {
      $('invite-link-input').select();
    }
  }

  let _logoData = ''; // base64 or URL currently staged in the modal

  function openNameModal() {
    const ws = window._authUser || {};
    $('wsname-input').value        = $('ws-name-tag')?.textContent || '';
    $('brand-company-input').value = ws.companyName || '';
    _logoData = ws.companyLogo || '';
    _applyLogoPreview(_logoData);
    $('brand-logo-url').value = _logoData.startsWith('data:') ? '' : _logoData;
    _updateLivePreview();
    $('wsname-overlay').classList.remove('hidden');
    $('wsname-modal').classList.remove('hidden');
    setTimeout(() => $('brand-company-input').focus(), 80);

    // Live preview updates on typing
    $('brand-company-input').oninput = _updateLivePreview;
    $('wsname-input').oninput        = _updateLivePreview;
  }

  function closeNameModal() {
    $('wsname-overlay').classList.add('hidden');
    $('wsname-modal').classList.add('hidden');
  }

  function onLogoFile(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('El logo no puede superar 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      _logoData = e.target.result;
      $('brand-logo-url').value = '';
      _applyLogoPreview(_logoData);
      _updateLivePreview();
    };
    reader.readAsDataURL(file);
  }

  function onLogoUrl(url) {
    _logoData = url.trim();
    _applyLogoPreview(_logoData);
    _updateLivePreview();
  }

  function clearLogo() {
    _logoData = '';
    $('brand-logo-url').value = '';
    $('brand-logo-file').value = '';
    _applyLogoPreview('');
    _updateLivePreview();
  }

  function _applyLogoPreview(src) {
    const preview = $('brand-logo-preview');
    const clearBtn = $('brand-logo-clear');
    if (!preview) return;
    if (src) {
      preview.innerHTML = `<img src="${src}" style="width:48px;height:48px;object-fit:contain;border-radius:6px" onerror="WorkspaceModule.clearLogo()">`;
      if (clearBtn) clearBtn.style.display = '';
    } else {
      preview.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
      if (clearBtn) clearBtn.style.display = 'none';
    }
  }

  function _updateLivePreview() {
    const name    = $('brand-company-input')?.value.trim() || 'Empresa';
    const tag     = $('wsname-input')?.value.trim()        || 'workspace';
    const prevName = $('brand-prev-name');
    const prevTag  = $('brand-prev-tag');
    const prevIcon = $('brand-prev-icon');
    if (prevName) prevName.textContent = name;
    if (prevTag)  prevTag.textContent  = tag;
    if (prevIcon) {
      prevIcon.innerHTML = _logoData
        ? `<img src="${_logoData}" style="width:28px;height:28px;object-fit:contain;border-radius:4px" onerror="this.style.display='none'">`
        : `<svg width="14" height="14" viewBox="0 0 100 100" fill="none"><path d="M50 3 L63 38 L97 50 L63 62 L50 97 L37 62 L3 50 L37 38 Z" fill="#7C3AED"/></svg>`;
    }
  }

  async function saveName() {
    const name        = $('wsname-input').value.trim();
    const companyName = $('brand-company-input').value.trim();
    if (!name) { alert('El nombre del workspace es requerido'); return; }
    try {
      const res = await apiFetch(`${API}/workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, company_name: companyName, company_logo: _logoData }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      // Apply to sidebar immediately
      applyBranding({ companyName, companyLogo: _logoData, workspaceName: name });
      if (window._authUser) {
        window._authUser.companyName  = companyName;
        window._authUser.companyLogo  = _logoData;
        window._authUser.workspaceName = name;
      }
      closeNameModal();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  return { openInvite, closeInvite, resetInvite, generateInvite, copyInvite, openNameModal, closeNameModal, saveName, onLogoFile, onLogoUrl, clearLogo };
})();

// =================================================================
// WORKLOAD MODULE — team capacity panel inside calendar pane
// =================================================================

const WorkloadModule = (() => {
  let _activeTab = 'calendario';

  function switchTab(tab) {
    _activeTab = tab;
    const calSec = $('cal-section');
    const wlSec  = $('wl-section');
    if (calSec) calSec.style.display = tab === 'calendario' ? '' : 'none';
    if (wlSec)  wlSec.style.display  = tab === 'carga' ? '' : 'none';
    document.querySelectorAll('.cal-pane-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.ct === tab)
    );
    if (tab === 'carga') load();
  }

  async function load() {
    const loadEl   = $('wl-loading');
    const contentEl = $('wl-content');
    if (!loadEl) return;
    loadEl.style.display    = 'flex';
    contentEl.style.display = 'none';
    try {
      const [tasksRes, teamRes] = await Promise.all([
        apiFetch(`${API}/mgmt/tasks`),
        apiFetch(`${API}/mgmt/team`),
      ]);
      const tasks = tasksRes.ok ? await tasksRes.json() : [];
      const team  = teamRes.ok  ? await teamRes.json()  : [];
      render(tasks, team);
    } catch (e) {
      console.error('[workload] load error:', e);
    } finally {
      loadEl.style.display    = 'none';
      contentEl.style.display = '';
    }
  }

  function render(tasks, team) {
    const el = $('wl-content');
    if (!el) return;

    if (!team.length) {
      el.innerHTML = '<div class="clients-empty" style="display:flex"><span>No hay miembros en el equipo aún</span></div>';
      return;
    }

    const ESTADOS  = ['pendiente','en_curso','bloqueado','completado'];
    const EST_BG   = { pendiente:'#E7E5E0', en_curso:'#A7F3D0', bloqueado:'#FBBFB0', completado:'#BAE6FD' };
    const EST_LBL  = { pendiente:'Pendiente', en_curso:'En curso', bloqueado:'Bloqueado', completado:'Completado' };
    const today    = new Date(); today.setHours(0,0,0,0);

    const cards = team.map(m => {
      const myTasks = tasks.filter(t =>
        (t.responsables || []).includes(m.nombre) || t.responsable === m.nombre
      );
      const counts  = {};
      ESTADOS.forEach(s => { counts[s] = myTasks.filter(t => t.estado === s).length; });
      const total   = myTasks.length;
      const active  = myTasks.filter(t => t.estado !== 'completado').length;
      const overdue = myTasks.filter(t => t.deadline && t.estado !== 'completado' && new Date(t.deadline) < today).length;

      const bar = total > 0
        ? ESTADOS.map(s => {
            const pct = (counts[s] / total) * 100;
            return pct > 0 ? `<div style="width:${pct.toFixed(1)}%;background:${EST_BG[s]};height:100%;flex-shrink:0" title="${EST_LBL[s]}: ${counts[s]}"></div>` : '';
          }).join('')
        : '';

      const preview = myTasks.filter(t => t.estado !== 'completado').slice(0,3).map(t => {
        const od = t.deadline && new Date(t.deadline) < today;
        return `<div class="wl-task-item${od?' wl-task-item--overdue':''}">
          <span class="wl-task-dot" style="background:${EST_BG[t.estado]||'#E7E5E0'}"></span>
          <span class="wl-task-title">${esc(t.titulo)}</span>
          ${t.deadline?`<span class="wl-task-date">${new Date(t.deadline).toLocaleDateString('es-ES',{day:'2-digit',month:'short'})}</span>`:''}
        </div>`;
      }).join('');

      return `<div class="wl-card">
        <div class="wl-card__head">
          <img class="wl-avatar" src="https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(m.nombre)}" alt="">
          <div class="wl-card__info">
            <div class="wl-card__name">${esc(m.nombre)}</div>
            <div class="wl-card__role">${esc(m.rol||m.cargo||'')}</div>
          </div>
          <div class="wl-card__counts">
            <div class="wl-count wl-count--active">${active} activa${active!==1?'s':''}</div>
            ${overdue?`<div class="wl-count wl-count--overdue">⚠ ${overdue} vencida${overdue>1?'s':''}</div>`:''}
          </div>
        </div>
        ${total>0?`<div class="wl-bar">${bar}</div>
        <div class="wl-legend">${ESTADOS.filter(s=>counts[s]>0).map(s=>
          `<span class="wl-legend-dot" style="background:${EST_BG[s]}"></span><span class="wl-legend-label">${EST_LBL[s]} (${counts[s]})</span>`
        ).join('')}</div>`:'<div style="color:var(--muted);font-size:.8rem;padding:4px 0 8px">Sin tareas asignadas</div>'}
        ${preview}
        ${active>3?`<div style="color:var(--muted);font-size:.75rem;margin-top:6px">+${active-3} tarea${active-3>1?'s':''} más</div>`:''}
      </div>`;
    }).join('');

    const totalActive = tasks.filter(t => t.estado !== 'completado').length;
    const unassigned  = tasks.filter(t => !t.responsable && (!t.responsables || !t.responsables.length) && t.estado !== 'completado').length;

    el.innerHTML = `
      <div class="wl-summary">
        <div class="wl-summary-item"><span class="wl-summary-num">${totalActive}</span><span class="wl-summary-lbl">tareas activas</span></div>
        <div class="wl-summary-item"><span class="wl-summary-num">${team.length}</span><span class="wl-summary-lbl">miembro${team.length!==1?'s':''}</span></div>
        ${unassigned?`<div class="wl-summary-item wl-summary-item--warn"><span class="wl-summary-num">${unassigned}</span><span class="wl-summary-lbl">sin asignar</span></div>`:''}
      </div>
      <div class="wl-cards">${cards}</div>`;
  }

  return { switchTab, load };
})();

// =================================================================
// CHAT MODULE — real-time Socket.io
// =================================================================

const ChatModule = (() => {
  let _socket    = null;
  let _channel   = 'general';
  let _allCh     = [];
  let _unread    = {};
  let _connected = false;
  let _audioCtx = (() => {
    try { return new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return null; }
  })();

  function _storageKey() {
    return `chat_unread_${window._authUser?.id || 'guest'}`;
  }
  function _saveUnread() {
    try { localStorage.setItem(_storageKey(), JSON.stringify(_unread)); } catch(e) {}
  }
  function _loadUnread() {
    try {
      const s = localStorage.getItem(_storageKey());
      if (s) _unread = JSON.parse(s);
    } catch(e) {}
  }

  // Unlock AudioContext on any user interaction (browser autoplay policy)
  function _unlockAudio() {
    if (!_audioCtx || _audioCtx.state !== 'suspended') return;
    _audioCtx.resume().catch(() => {});
  }
  ['click', 'keydown', 'mousedown', 'touchstart', 'pointerdown'].forEach(ev => {
    document.addEventListener(ev, _unlockAudio, { capture: true, passive: true });
  });

  function _playNotifSound() {
    try {
      const ctx = _audioCtx;
      const now = ctx.currentTime;

      // ── Bass thump (vibración) ─────────────────────────────
      const thump  = ctx.createOscillator();
      const thumpG = ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(160, now);
      thump.frequency.exponentialRampToValueAtTime(38, now + .13);
      thump.connect(thumpG);
      thumpG.connect(ctx.destination);
      thumpG.gain.setValueAtTime(0, now);
      thumpG.gain.linearRampToValueAtTime(0.9, now + .004);
      thumpG.gain.exponentialRampToValueAtTime(.001, now + .18);
      thump.start(now);
      thump.stop(now + .2);

      // ── Chime (tono claro) ─────────────────────────────────
      function chime(freq, t, vol) {
        const osc  = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const g    = ctx.createGain();
        osc.type = osc2.type = 'sine';
        osc.frequency.value  = freq;
        osc2.frequency.value = freq * 2.4;
        osc.connect(g); osc2.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + .005);
        g.gain.exponentialRampToValueAtTime(.001, t + .85);
        osc.start(t);  osc.stop(t + .9);
        osc2.start(t); osc2.stop(t + .35);
      }
      chime(587.3, now + .04, .45);   // D5 — nota principal
      chime(880.0, now + .19, .30);   // A5 — respuesta
    } catch(e) {}
  }

  function _playNotif() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'running') {
      _playNotifSound();
    } else if (_audioCtx.state === 'suspended') {
      _audioCtx.resume().then(_playNotifSound).catch(() => {});
    }
  }

  function _connect() {
    if (_socket) return;
    _socket = io('https://api.kiwoc.com', {
      withCredentials: true,
      transports: ['polling', 'websocket'],
    });
    _socket.on('connect', () => {
      _connected = true;
      _socket.emit('join_channel', _channel);
    });
    _socket.on('disconnect', () => { _connected = false; });
    _socket.on('new_message', msg => _appendMessage(msg));
  }

  async function load() {
    _loadUnread();
    _updateBadge();
    _connect();
    try {
      const [pRes, mRes] = await Promise.all([
        apiFetch(`${API}/mgmt/projects`),
        apiFetch(`${API}/workspace/members`),
      ]);
      const projects = await pRes.json();
      const members  = await mRes.json();
      const myId = window._authUser?.id;

      const channels = [
        { id: 'general', name: 'general', type: 'channel' },
        ...(Array.isArray(projects) ? projects.map(p => ({
          id: `project:${p.id}`, name: p.nombre, type: 'project',
          clientNombre: p.client_nombre || p.client_empresa || null,
          clientId: p.client_id || null,
          archived: p.estado && p.estado !== 'activo',
        })) : []),
      ];
      const dms = (Array.isArray(members) ? members : [])
        .filter(m => m.id !== myId)
        .map(m => {
          const ids = [myId, m.id].sort((a, b) => a - b);
          return { id: `dm:${ids[0]}:${ids[1]}`, name: m.name || m.email, type: 'dm', avatar: m.avatar };
        });

      _allCh = [...channels, ...dms];
      _renderLists();
      await _loadMsgs(_channel, 'chat-messages');
      await _loadMsgs(_channel, 'rchat-messages');
    } catch (e) {
      console.warn('[chat] load error:', e.message);
    }
    const loadEl = $('chat-loading');
    if (loadEl) loadEl.style.display = 'none';
  }

  // Section collapse state
  const _collapsed = {};

  function _renderLists() {
    _renderList('chat-channels');
    _renderList('rchat-channels');
    const active = _allCh.find(c => c.id === _channel);
    if (!active) return;

    const prefix = active.type === 'dm' ? '@' : '#';

    // Right sidebar header
    const lbl  = $('rchat-ch-label');
    const hash = $('rchat-ctx-hash');
    if (hash) hash.textContent = prefix;
    if (lbl) {
      if (active.type === 'project' && active.clientNombre) {
        lbl.innerHTML = `${esc(active.clientNombre)} <span style="color:#C4BAB3;font-weight:400">/ ${esc(active.name)}</span>`;
      } else {
        lbl.textContent = active.name;
      }
    }

    // Full chat pane header
    const mainName  = $('chat-main-name');
    const mainBadge = $('chat-main-badge');
    const mainTopic = $('chat-main-topic');
    const composer  = $('chat-input');
    if (mainName)  mainName.textContent  = active.name;
    if (mainBadge) mainBadge.textContent = prefix;
    if (mainTopic) mainTopic.textContent = active.type === 'project' && active.clientNombre
      ? `${active.clientNombre} / ${active.name}`
      : active.topic || (active.type === 'dm' ? 'Conversación directa' : 'Canal del equipo');
    if (composer)  composer.placeholder  = `Mensaje en ${prefix}${active.name}`;

    // Member pill — show workspace member count
    _updateMemberPill();
  }

  async function _updateMemberPill() {
    const pill  = $('chat-member-pill');
    const count = $('chat-member-count');
    const avs   = $('chat-member-avs');
    if (!pill || !count) return;
    try {
      const res  = await apiFetch(`${API}/mgmt/team`);
      const data = await res.json();
      const members = Array.isArray(data) ? data : (data.members || []);
      const n = members.length;
      count.textContent = n ? `${n} miembro${n !== 1 ? 's' : ''}` : '—';
      if (avs) {
        avs.innerHTML = members.slice(0, 3).map(m => {
          const ini = (m.nombre || m.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
          return `<div class="chat-member-av" title="${esc(m.nombre || m.name || '')}">${ini}</div>`;
        }).join('');
      }
    } catch { /* ignore */ }
  }

  function _sectionLabel(key, label, isFull) {
    if (!isFull) {
      return `<div class="chat-ch-slabel"><span>${label}</span></div>`;
    }
    const col = _collapsed[key] ? ' chat-ch-slabel--collapsed' : '';
    return `<div class="chat-ch-slabel${col}" onclick="ChatModule.toggleSection('${key}')">
      <span class="chat-ch-slabel__chev">▾</span> <span>${label}</span>
    </div>`;
  }

  function toggleSection(key) {
    _collapsed[key] = !_collapsed[key];
    _renderList('chat-channels');
  }

  function _chRow(ch) {
    const active   = ch.id === _channel;
    const unread   = _unread[ch.id] || 0;
    const safeId   = ch.id.replace(/'/g, '');
    const archived = ch.archived ? ' chat-ch--archived' : '';

    let iconHtml;
    if (ch.type === 'dm') {
      const ini = (ch.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      iconHtml = `<div class="chat-ch__avatar-wrap">
        <div class="chat-ch__avatar-sm">${ini}</div>
        <div class="chat-ch__online"></div>
      </div>`;
    } else {
      const icon = ch.type === 'dm' ? '@' : '#';
      iconHtml = `<span class="chat-ch__icon">${icon}</span>`;
    }

    const sub = ch.type === 'project' && ch.clientNombre
      ? `<span class="chat-ch__sub">${esc(ch.clientNombre)}</span>` : '';

    return `<div class="chat-ch${active ? ' chat-ch--active' : ''}${!active && unread ? ' chat-ch--unread' : ''}${archived}"
      onclick="ChatModule.selectChannel('${safeId}')">
      ${iconHtml}
      <span class="chat-ch__body"><span class="chat-ch__name">${esc(ch.name)}</span>${sub}</span>
      ${unread ? `<span class="chat-unread">${unread}</span>` : ''}
    </div>`;
  }

  function _renderList(containerId, query) {
    const container = $(containerId);
    if (!container) return;
    let html = '';
    const q      = (query || '').toLowerCase().trim();
    const isFull = containerId === 'chat-channels';

    if (q) {
      const pool   = isFull ? _allCh : _allCh.filter(c => !c.archived);
      const scored = pool.map(ch => {
        const hay = (ch.name + ' ' + (ch.clientNombre || '')).toLowerCase();
        if (hay.startsWith(q))  return { ch, score: 2 };
        if (hay.includes(q))    return { ch, score: 1 };
        return null;
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      html = scored.length
        ? scored.map(({ ch }) => _chRow(ch)).join('')
        : `<div class="chat-ch-empty">Sin resultados para "<strong>${esc(q)}</strong>"</div>`;
    } else {
      const isActive = c => !c.archived;

      const generalChs = _allCh.filter(c => c.type === 'channel' && isActive(c));
      if (generalChs.length) {
        html += _sectionLabel('channels', 'Canales', isFull);
        if (!_collapsed['channels'] || !isFull) html += generalChs.map(_chRow).join('');
      }

      const projectChs = _allCh.filter(c => c.type === 'project' && isActive(c));
      if (projectChs.length) {
        html += _sectionLabel('projects', 'Proyectos', isFull);
        if (!_collapsed['projects'] || !isFull) {
          const byClient = {};
          for (const ch of projectChs) {
            (byClient[ch.clientNombre || 'Proyectos'] ??= []).push(ch);
          }
          for (const chs of Object.values(byClient)) html += chs.map(_chRow).join('');
        }
      }

      const dmChs = _allCh.filter(c => c.type === 'dm');
      if (dmChs.length) {
        html += _sectionLabel('dms', 'Mensajes directos', isFull);
        if (!_collapsed['dms'] || !isFull) html += dmChs.map(_chRow).join('');
      }

      if (isFull) {
        const archivedChs = _allCh.filter(c => c.type === 'project' && c.archived);
        if (archivedChs.length) {
          html += _sectionLabel('archived', 'Archivados', isFull);
          if (!_collapsed['archived']) html += archivedChs.map(_chRow).join('');
        }
        html += `<button class="chat-ch-add" onclick="void 0">
          <div class="chat-ch-add__plus">+</div>
          <span>Agregar un canal</span>
        </button>`;
      }
    }
    container.innerHTML = html;
  }

  function filterChannels(q) {
    _renderList('rchat-channels', q);
  }

  async function _loadMsgs(channel, containerId) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:.82rem;padding:40px 0">Cargando…</div>`;
    try {
      const res  = await apiFetch(`${API}/chat/messages/${encodeURIComponent(channel)}`);
      const msgs = await res.json();
      if (!Array.isArray(msgs) || !msgs.length) {
        el.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:.82rem;padding:40px 0">Sin mensajes aún. ¡Sé el primero!</div>`;
        return;
      }
      el.innerHTML = msgs.map((m, i) => _msgHtml(m, msgs[i - 1], false)).join('');
      _lastMsg[containerId] = msgs[msgs.length - 1];
      el.scrollTop = el.scrollHeight;
    } catch (e) {
      el.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:.82rem;padding:40px 0">Error al cargar mensajes.</div>`;
    }
  }

  // Track last rendered message per container for grouping
  const _lastMsg = {};

  function _msgHtml(msg, prevMsg, isNew) {
    const me   = msg.sender_id === window._authUser?.id;
    const time = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    // ── Date separator ──
    let dateSep = '';
    if (!prevMsg) {
      // First message — always show date
      const d = new Date(msg.created_at);
      const today = new Date(); today.setHours(0,0,0,0);
      const yesterday = new Date(today.getTime() - 86400000);
      const lbl = d >= today ? 'Hoy'
                : d >= yesterday ? 'Ayer'
                : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
      dateSep = `<div class="chat-date-sep"><span>${lbl}</span></div>`;
    } else {
      const pc = new Date(prevMsg.created_at).toDateString();
      const cc = new Date(msg.created_at).toDateString();
      if (pc !== cc) {
        const d = new Date(msg.created_at);
        const today = new Date(); today.setHours(0,0,0,0);
        const yesterday = new Date(today.getTime() - 86400000);
        const lbl = d >= today ? 'Hoy'
                  : d >= yesterday ? 'Ayer'
                  : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
        dateSep = `<div class="chat-date-sep"><span>${lbl}</span></div>`;
      }
    }

    // ── Grouping: same sender, same day, within 5 minutes ──
    const grouped = !dateSep && prevMsg &&
      prevMsg.sender_id === msg.sender_id &&
      (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 5 * 60 * 1000;

    // ── Avatar — always shown (own or other) ──
    let _avSrc, _avIni;
    if (me) {
      const myName = window._authUser?.memberNombre || window._authUser?.name || 'Yo';
      _avIni = myName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      _avSrc = window._authUser?.avatar || window._authUser?.picture || null;
    } else {
      _avIni = (msg.sender_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      _avSrc = msg.sender_avatar || null;
    }
    const avatarHtml = `<div class="chat-msg__avatar">${
      _avSrc
        ? `<img src="${_avSrc}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='flex'">`
        + `<div class="chat-msg__avatar-init" style="display:none">${_avIni}</div>`
        : `<div class="chat-msg__avatar-init">${_avIni}</div>`
    }</div>`;

    // ── Header (name + time) — on first message of every group, including own ──
    const displayName = me
      ? (window._authUser?.memberNombre || window._authUser?.name || 'Tú')
      : (msg.sender_name || 'Desconocido');
    const headerHtml = !grouped
      ? `<div class="chat-msg__header">
           <span class="chat-msg__sender">${esc(displayName)}</span>
           <span class="chat-msg__header-time">${time}</span>
         </div>`
      : '';

    const newCls     = isNew ? ' chat-msg--new' : '';
    const groupedCls = grouped ? ' chat-msg--grouped' : '';

    // ── Quoted reply block ──
    let replyHtml = '';
    if (msg.reply_to) {
      const rt = typeof msg.reply_to === 'string' ? JSON.parse(msg.reply_to) : msg.reply_to;
      replyHtml = `<div class="chat-msg-reply">
        <div class="chat-msg-reply__bar"></div>
        <div class="chat-msg-reply__inner">
          <span class="chat-msg-reply__sender">${esc(rt.sender || '')}</span>
          <span class="chat-msg-reply__text">${esc((rt.preview || '').slice(0, 120))}</span>
        </div>
      </div>`;
    }

    // Hover action toolbar — 3 iOS-style reaction icons + reply + 3-dot menu
    const _ico = (d, w) => `<svg width="${w||14}" height="${w||14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const actionsHtml = `<div class="chat-msg-actions">
      <button class="chat-msg-act chat-msg-act--react" onclick="ChatModule.toggleReact(event,'👍')" title="Positivo">
        ${_ico('<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>')}
        <span class="chat-msg-act-tip">Positivo</span>
      </button>
      <button class="chat-msg-act chat-msg-act--react" onclick="ChatModule.toggleReact(event,'❤️')" title="Me encanta">
        ${_ico('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>')}
        <span class="chat-msg-act-tip">Me encanta</span>
      </button>
      <button class="chat-msg-act chat-msg-act--react" onclick="ChatModule.toggleReact(event,'😂')" title="Jaja">
        ${_ico('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>')}
        <span class="chat-msg-act-tip">Jaja</span>
      </button>
      <div class="chat-msg-act-sep"></div>
      <button class="chat-msg-act" onclick="ChatModule.replyTo(event)">
        ${_ico('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>')}
        <span class="chat-msg-act-tip">Responder</span>
      </button>
      ${me ? `<button class="chat-msg-act" onclick="ChatModule.openMsgMenu(event)">
        ${_ico('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>')}
        <span class="chat-msg-act-tip">Más acciones</span>
      </button>` : ''}
    </div>`;

    return `${dateSep}<div class="chat-msg${me ? ' chat-msg--me' : ''}${newCls}${groupedCls}" data-msg-id="${msg.id || ''}">
      ${avatarHtml}
      <div class="chat-msg__body">
        ${headerHtml}
        ${replyHtml}
        <div class="chat-msg__bubble-wrap">
          <div class="chat-msg__bubble">${esc(msg.content)}</div>
          <span class="chat-msg__hover-time">${time}</span>
        </div>
      </div>
      ${actionsHtml}
    </div>`;
  }

  function _appendMessage(msg) {
    const isOwn    = msg.sender_id === window._authUser?.id;
    const isCurrent = msg.channel === _channel;

    // Only render message in the view if it belongs to the active channel
    if (isCurrent) {
      for (const id of ['chat-messages', 'rchat-messages']) {
        const el = $(id);
        if (!el) continue;
        if (el.childElementCount === 1 && el.firstElementChild?.textContent?.includes('Sin mensajes')) {
          el.innerHTML = '';
          _lastMsg[id] = null;
        }
        const prev = _lastMsg[id] || null;
        el.insertAdjacentHTML('beforeend', _msgHtml(msg, prev, true));
        _lastMsg[id] = msg;
        el.scrollTop = el.scrollHeight;
      }
    }

    // Sound + unread badge for messages from OTHER users
    if (!isOwn) {
      _playNotif();
      const panelOpen = !$('rchat')?.classList.contains('rchat--collapsed');
      if (!isCurrent || !panelOpen) {
        _unread[msg.channel] = (_unread[msg.channel] || 0) + 1;
        _updateBadge();
        _renderLists();
      }
    }
  }

  function _updateBadge() {
    const total = Object.values(_unread).reduce((a, b) => a + b, 0);
    for (const id of ['chat-badge', 'rchat-badge']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = total || '';
      el.classList.toggle('hidden', !total);
    }
    _saveUnread();
  }

  async function selectChannel(id) {
    _channel = id;
    _unread[id] = 0;
    _saveUnread();
    _updateBadge();
    _lastMsg['chat-messages']  = null;
    _lastMsg['rchat-messages'] = null;
    if (_socket && _connected) _socket.emit('join_channel', id);
    _renderLists();
    await _loadMsgs(id, 'chat-messages');
    await _loadMsgs(id, 'rchat-messages');
    const drop = $('rchat-chdrop');
    if (drop && !drop.classList.contains('hidden')) drop.classList.add('hidden');
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  function onInputChange(el) {
    const btn = $('chat-send-btn');
    if (btn) btn.disabled = !el.value.trim();
  }

  function focusInput() {
    const input = $('chat-input');
    if (input) { input.focus(); }
  }

  function fmt(type) {
    const input = $('chat-input');
    if (!input) return;
    const start = input.selectionStart;
    const end   = input.selectionEnd;
    const sel   = input.value.slice(start, end);
    const wrap  = type === 'bold' ? '**' : type === 'italic' ? '_' : type === 'code' ? '`' : '';
    if (!wrap) return;
    const before = input.value.slice(0, start);
    const after  = input.value.slice(end);
    input.value  = before + wrap + (sel || 'texto') + wrap + after;
    const cur    = start + wrap.length;
    input.setSelectionRange(cur, cur + (sel || 'texto').length);
    input.focus();
    onInputChange(input);
  }

  function insertMention() {
    const input = $('chat-input');
    if (!input) return;
    const pos = input.selectionStart;
    input.value = input.value.slice(0, pos) + '@' + input.value.slice(pos);
    input.setSelectionRange(pos + 1, pos + 1);
    input.focus();
    onInputChange(input);
  }

  function toggleReact(e, emoji) {
    e.stopPropagation();
    const msgEl = e.target.closest('.chat-msg');
    if (!msgEl) return;
    const body = msgEl.querySelector('.chat-msg__body');
    let reactions = body.querySelector('.chat-reactions');
    if (!reactions) {
      reactions = document.createElement('div');
      reactions.className = 'chat-reactions';
      body.appendChild(reactions);
    }
    const existing = [...reactions.querySelectorAll('.chat-reaction')]
      .find(r => r.dataset.emoji === emoji);
    if (existing) {
      const isMine = existing.classList.contains('chat-reaction--mine');
      const cnt    = existing.querySelector('.chat-reaction__count');
      const n      = parseInt(cnt.textContent) + (isMine ? -1 : 1);
      if (n <= 0) {
        existing.remove();
        if (!reactions.children.length) reactions.remove();
      } else {
        cnt.textContent = n;
        existing.classList.toggle('chat-reaction--mine', !isMine);
      }
    } else {
      const btn = document.createElement('button');
      btn.className    = 'chat-reaction chat-reaction--mine';
      btn.dataset.emoji = emoji;
      btn.innerHTML    = `${emoji} <span class="chat-reaction__count">1</span>`;
      btn.onclick      = ev => ChatModule.toggleReact(ev, emoji);
      reactions.appendChild(btn);
    }
  }

  // ── Reply ──────────────────────────────────────────────────
  let _replyCtx = null;

  function replyTo(e) {
    const msgEl = e.target.closest('.chat-msg');
    if (!msgEl) return;
    const sender  = msgEl.querySelector('.chat-msg__sender')?.textContent?.trim() || '';
    const preview = msgEl.querySelector('.chat-msg__bubble')?.textContent?.trim() || '';
    _replyCtx = { sender, preview };
    const banner = $('chat-reply-banner');
    if (banner) {
      $('chat-reply-sender').textContent  = sender;
      $('chat-reply-preview').textContent = preview.slice(0, 100) + (preview.length > 100 ? '…' : '');
      banner.classList.remove('hidden');
    }
    focusInput();
  }

  function cancelReply() {
    _replyCtx = null;
    $('chat-reply-banner')?.classList.add('hidden');
  }

  // ── 3-dot context menu ─────────────────────────────────────
  let _ctxMenu = null;

  function _closeCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }

  function openMsgMenu(e) {
    e.stopPropagation();
    _closeCtxMenu();
    const msgEl = e.target.closest('.chat-msg');
    if (!msgEl) return;

    const menu = document.createElement('div');
    menu.className = 'chat-ctx-menu';
    const isPinned = msgEl.classList.contains('chat-msg--pinned');
    menu.innerHTML = `
      <button class="chat-ctx-item" id="_ctx-pin">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 17-1-1-4.5-4.5A4 4 0 0 1 12 5.5l4.5 4.5 1 1"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="5" y1="12" x2="3" y2="12"/></svg>
        ${isPinned ? 'Desfijar mensaje' : 'Fijar mensaje'}
      </button>
      <div class="chat-ctx-sep"></div>
      <button class="chat-ctx-item" id="_ctx-edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        Editar mensaje
      </button>
      <div class="chat-ctx-sep"></div>
      <button class="chat-ctx-item chat-ctx-item--danger" id="_ctx-del">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        Eliminar mensaje
      </button>`;

    // Position below the ⋯ button
    const rect = e.currentTarget.getBoundingClientRect();
    const menuW = 170;
    menu.style.top  = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, rect.right - menuW) + 'px';
    document.body.appendChild(menu);
    _ctxMenu = menu;

    menu.querySelector('#_ctx-pin').onclick  = () => { _closeCtxMenu(); pinMsg(msgEl); };
    menu.querySelector('#_ctx-edit').onclick = () => { _closeCtxMenu(); editMsg(msgEl); };
    menu.querySelector('#_ctx-del').onclick  = () => { _closeCtxMenu(); deleteMsg(msgEl); };

    setTimeout(() => document.addEventListener('click', _closeCtxMenu, { once: true }), 0);
  }

  function editMsg(msgEl) {
    const bubble = msgEl.querySelector('.chat-msg__bubble');
    if (!bubble) return;
    const original = bubble.textContent;

    const wrap = document.createElement('div');
    const ta = document.createElement('textarea');
    ta.className = 'chat-msg-edit-input';
    ta.value = original;
    const hint = document.createElement('div');
    hint.className = 'chat-msg-edit-hint';
    hint.textContent = 'Enter para guardar · Esc para cancelar';
    wrap.appendChild(ta);
    wrap.appendChild(hint);
    bubble.replaceWith(wrap);

    autoResize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const finish = (save) => {
      const newBubble = document.createElement('div');
      newBubble.className = 'chat-msg__bubble';
      newBubble.textContent = save && ta.value.trim() ? ta.value.trim() : original;
      wrap.replaceWith(newBubble);
    };
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') finish(false);
    });
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('input', () => autoResize(ta));
  }

  function deleteMsg(msgEl) {
    msgEl.style.transition = 'opacity .18s, transform .18s';
    msgEl.style.opacity    = '0';
    msgEl.style.transform  = 'translateX(6px)';
    setTimeout(() => msgEl.remove(), 190);
  }

  // ── Pin ─────────────────────────────────────────────────────
  let _pinnedOpen = false;

  async function pinMsg(msgEl) {
    const msgId = msgEl.dataset.msgId;
    if (!msgId) return;
    try {
      const res  = await apiFetch(`${API}/chat/messages/${msgId}/pin`, { method: 'PATCH' });
      const data = await res.json();
      const isPinned = data.pinned;
      // Update visual state on the message row
      msgEl.classList.toggle('chat-msg--pinned', isPinned);
      let badge = msgEl.querySelector('.chat-pin-badge');
      if (isPinned && !badge) {
        badge = document.createElement('div');
        badge.className = 'chat-pin-badge';
        badge.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 17-1-1-4.5-4.5A4 4 0 0 1 12 5.5l4.5 4.5 1 1"/><line x1="12" y1="17" x2="12" y2="22"/></svg> Fijado`;
        msgEl.querySelector('.chat-msg__body').prepend(badge);
      } else if (!isPinned && badge) {
        badge.remove();
      }
      // Refresh panel if open
      if (_pinnedOpen) _loadPinnedMsgs();
    } catch (e) { console.warn('[pin]', e.message); }
  }

  async function _loadPinnedMsgs() {
    const list = $('chat-pinned-list');
    if (!list) return;
    list.innerHTML = `<div class="chat-pinned-empty" style="color:#C4BAB3">Cargando…</div>`;
    try {
      const res  = await apiFetch(`${API}/chat/pinned/${encodeURIComponent(_channel)}`);
      const msgs = await res.json();
      if (!msgs.length) {
        list.innerHTML = `<div class="chat-pinned-empty">No hay mensajes fijados en este canal</div>`;
        return;
      }
      list.innerHTML = msgs.map(m => {
        const t = m.pinned_at ? new Date(m.pinned_at).toLocaleDateString('es-ES', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
        return `<div class="chat-pinned-item">
          <button class="chat-pinned-item__unpin" onclick="ChatModule.unpinById(${m.id}, this)" title="Desfijar">× Desfijar</button>
          <div class="chat-pinned-item__sender">${esc(m.sender_name || 'Desconocido')}</div>
          <div class="chat-pinned-item__text">${esc(m.content)}</div>
          <div class="chat-pinned-item__meta">Fijado ${t}</div>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<div class="chat-pinned-empty">Error al cargar</div>`;
    }
  }

  async function unpinById(msgId, btn) {
    try {
      await apiFetch(`${API}/chat/messages/${msgId}/pin`, { method: 'PATCH' });
      btn.closest('.chat-pinned-item').remove();
      // Update badge on the message in chat if visible
      const msgEl = document.querySelector(`.chat-msg[data-msg-id="${msgId}"]`);
      if (msgEl) {
        msgEl.classList.remove('chat-msg--pinned');
        msgEl.querySelector('.chat-pin-badge')?.remove();
      }
      if (!$('chat-pinned-list').children.length) {
        $('chat-pinned-list').innerHTML = `<div class="chat-pinned-empty">No hay mensajes fijados en este canal</div>`;
      }
    } catch (e) { console.warn('[unpin]', e.message); }
  }

  function togglePinnedPanel() {
    _pinnedOpen = !_pinnedOpen;
    const panel = $('chat-pinned-panel');
    const btn   = $('chat-hdr-pin-btn');
    panel?.classList.toggle('open', _pinnedOpen);
    btn?.classList.toggle('chat-hdr-btn--active', _pinnedOpen);
    if (_pinnedOpen) _loadPinnedMsgs();
  }

  function closePinnedPanel() {
    _pinnedOpen = false;
    $('chat-pinned-panel')?.classList.remove('open');
    $('chat-hdr-pin-btn')?.classList.remove('chat-hdr-btn--active');
  }

  // ── Send ────────────────────────────────────────────────────
  function send() {
    const input = $('chat-input');
    const content = input?.value.trim();
    if (!content || !_socket) return;
    _socket.emit('send_message', {
      channel:  _channel,
      content,
      reply_to: _replyCtx || null,
    });
    cancelReply();
    input.value = '';
    input.style.height = 'auto';
    onInputChange(input);
  }

  function rsend() {
    const input = $('rchat-input');
    const content = input?.value.trim();
    if (!content || !_socket) return;
    _socket.emit('send_message', { channel: _channel, content });
    input.value = '';
  }

  function clearCurrentUnread() {
    _unread[_channel] = 0;
    _updateBadge();
    _renderLists();
  }

  // Called once after auth — starts socket and restores badge without opening the panel
  function init() {
    _loadUnread();
    _updateBadge();
    _connect();
  }

  return { init, load, selectChannel, send, rsend, clearCurrentUnread, filterChannels, autoResize, onInputChange, focusInput, fmt, insertMention, toggleReact, toggleSection, replyTo, cancelReply, openMsgMenu, togglePinnedPanel, closePinnedPanel, unpinById };
})();

// =================================================================
// RIGHT CHAT PANEL
// =================================================================

const RChatPanel = (() => {
  let _open = false;
  let _view = 'chat';

  function open(view) {
    const panel = $('rchat');
    if (!panel) return;
    if (_open && _view === view) { close(); return; }
    _view = view;
    _open = true;
    panel.classList.remove('rchat--collapsed');
    _applyView();
    if (view === 'chat')   { ChatModule.load(); ChatModule.clearCurrentUnread(); }
    if (view === 'notifs') RNotifPanel.load();
    if (view === 'notes')  NotesModule.load();
  }

  function switchTab(view) {
    if (_view === view) return;
    _view = view;
    _applyView();
    if (view === 'chat')   ChatModule.load();
    if (view === 'notifs') RNotifPanel.load();
    if (view === 'notes')  NotesModule.load();
  }

  function close() {
    _open = false;
    $('rchat')?.classList.add('rchat--collapsed');
  }

  function toggle() { _open ? close() : open('chat'); }

  function _applyView() {
    const panel      = $('rchat');
    const chatView   = $('rchat-view-chat');
    const notifView  = $('rchat-view-notifs');
    const notesView  = $('rchat-view-notes');
    const ctxBtn     = $('rchat-ch-btn');
    const title      = $('rchat-panel-title');
    const vswChat    = $('rchat-vsw-chat');
    const vswNotif   = $('rchat-vsw-notifs');
    const vswNotes   = $('rchat-vsw-notes');
    const isChat     = _view === 'chat';
    const isNotes    = _view === 'notes';
    const isNotifs   = _view === 'notifs';

    chatView?.classList.toggle('hidden', !isChat);
    notifView?.classList.toggle('hidden', !isNotifs);
    notesView?.classList.toggle('hidden', !isNotes);
    if (ctxBtn) ctxBtn.style.display = isChat ? '' : 'none';
    panel?.classList.toggle('rchat--notifs', isNotifs);
    if (title) title.textContent = isChat ? 'Equipo' : isNotes ? 'Notas' : 'Alertas';
    vswChat?.classList.toggle('active', isChat);
    vswNotif?.classList.toggle('active', isNotifs);
    vswNotes?.classList.toggle('active', isNotes);

    $('rchat-strip-chat')?.classList.toggle('active', isChat);
    $('rchat-strip-notifs')?.classList.toggle('active', isNotifs);
  }

  function toggleChannels() {
    const drop = $('rchat-chdrop');
    if (!drop) return;
    const opening = drop.classList.contains('hidden');
    drop.classList.toggle('hidden');
    if (opening) {
      const inp = $('rchat-chsearch');
      if (inp) { inp.value = ''; inp.focus(); }
      ChatModule.filterChannels('');
    }
  }

  return { open, close, toggle, switchTab, toggleChannels };
})();

// =================================================================
// NOTES MODULE — quick capture panel
// =================================================================
const NotesModule = (() => {
  const STORE = 'kiwoc_notes_v1';
  let _notes    = [];
  let _projects = [];

  function _loadStore() {
    try { _notes = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { _notes = []; }
  }
  function _saveStore() {
    localStorage.setItem(STORE, JSON.stringify(_notes));
  }

  async function load() {
    _loadStore();
    _render();
    const res = await apiFetch(`${API}/mgmt/projects`);
    if (res.ok) _projects = await res.json();
  }

  function add() {
    const inp  = $('rnotes-input');
    const text = inp?.value.trim();
    if (!text) return;
    _notes.unshift({ id: Date.now(), text, created_at: new Date().toISOString(), converted: false });
    _saveStore();
    if (inp) inp.value = '';
    _render();
  }

  function del(id) {
    _notes = _notes.filter(n => n.id !== id);
    _saveStore();
    _render();
  }

  function _render() {
    const list = $('rnotes-list');
    if (!list) return;
    if (!_notes.length) {
      list.innerHTML = `<div class="rnotes__empty">Sin notas aún.<br>Escribe una idea arriba y presiona Enter.</div>`;
      return;
    }
    const todayStr     = new Date().toISOString().split('T')[0];
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const groups = {};
    for (const n of _notes) {
      const day = n.created_at.split('T')[0];
      (groups[day] = groups[day] || []).push(n);
    }
    list.innerHTML = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(day => {
      const lbl = day === todayStr ? 'Hoy'
                : day === yesterdayStr ? 'Ayer'
                : new Date(day + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' });
      return `<div class="rnotes__group">
        <div class="rnotes__day-label">${lbl}</div>
        ${groups[day].map(n => _noteHtml(n)).join('')}
      </div>`;
    }).join('');
  }

  function _noteHtml(n) {
    const time = new Date(n.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const convertBtn = n.converted
      ? `<span class="rnotes__converted-chip">✓ Tarea</span>`
      : `<button class="rnotes__action-btn" onclick="NotesModule.openConvert(${n.id})" title="Convertir a tarea">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
         </button>`;
    return `<div class="rnotes__note${n.converted ? ' rnotes__note--done' : ''}" id="rnote-${n.id}">
      <div class="rnotes__note-text">${esc(n.text)}</div>
      <div class="rnotes__note-actions">
        <span class="rnotes__time">${time}</span>
        ${convertBtn}
        <button class="rnotes__action-btn rnotes__action-btn--del" onclick="NotesModule.del(${n.id})" title="Eliminar">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`;
  }

  function openConvert(id) {
    const note = _notes.find(n => n.id === id);
    const el   = $(`rnote-${id}`);
    if (!note || !el) return;
    const projOpts = _projects.map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
    el.innerHTML = `<div class="rnotes__convert-form">
      <input type="text" id="rnotes-conv-title" class="rnotes__convert-input" value="${esc(note.text)}" placeholder="Título de la tarea">
      <select id="rnotes-conv-proj" class="rnotes__convert-select">
        <option value="">Sin proyecto</option>
        ${projOpts}
      </select>
      <input type="date" id="rnotes-conv-dl" class="rnotes__convert-input">
      <div class="rnotes__convert-btns">
        <button class="btn btn--primary btn--sm" onclick="NotesModule.createTask(${id})">Crear tarea</button>
        <button class="btn btn--ghost btn--sm" onclick="NotesModule.load()">Cancelar</button>
      </div>
    </div>`;
  }

  async function createTask(noteId) {
    const note   = _notes.find(n => n.id === noteId);
    if (!note) return;
    const titulo     = $('rnotes-conv-title')?.value.trim() || note.text;
    const project_id = $('rnotes-conv-proj')?.value ? +$('rnotes-conv-proj').value : null;
    const deadline   = $('rnotes-conv-dl')?.value || null;
    const res = await apiFetch(`${API}/mgmt/tasks`, {
      method: 'POST',
      body: JSON.stringify({ titulo, project_id, estado: 'pendiente', prioridad: 'media',
                             responsable: '', deadline, notas: note.text, monto: null, cobrado: false }),
    });
    if (res.ok) {
      note.converted = true;
      _saveStore();
      _render();
      if (typeof TasksModule !== 'undefined') TasksModule.load();
    }
  }

  return { load, add, del, openConvert, createTask };
})();

// =================================================================
// RIGHT NOTIFICATIONS PANEL
// =================================================================

const RNotifPanel = (() => {
  let _pendingTaskId  = null;
  let _pendingMembers = [];   // multi-select
  let _teamCache      = null;

  async function load() {
    const el = $('rnotif-content');
    if (!el) return;
    el.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:.82rem;padding:44px 0">Cargando alertas…</div>`;
    try {
      const res  = await apiFetch(`${API}/mgmt/integrity`);
      const data = await res.json();
      _render(data);
      _updateBadge(data.total || 0);
    } catch (e) {
      el.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:.82rem;padding:44px 0">Error al cargar.</div>`;
    }
  }

  function _updateBadge(total) {
    for (const id of ['rchat-notif-badge', 'rchat-notif-dot']) {
      const el = $(id);
      if (!el) continue;
      if (id === 'rchat-notif-badge') el.textContent = total || '';
      el.classList.toggle('hidden', !total);
    }
  }

  function _render(data) {
    const el = $('rnotif-content');
    if (!el) return;

    const total = data.total || 0;
    if (!total) {
      el.innerHTML = `<div class="rnotif__ok">
        <div class="rnotif__ok-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <p class="rnotif__ok-title">Todo en orden</p>
        <span class="rnotif__ok-sub">Sin alertas de integridad</span>
      </div>`;
      return;
    }

    const cats = [
      { key: 'clientes_sin_proyecto',  dot: '#FDBA74', lbl: 'Clientes sin proyecto',   nameKey: 'nombre', subKey: 'empresa' },
      { key: 'proyectos_sin_tareas',   dot: '#C4B5FD', lbl: 'Proyectos sin tareas',    nameKey: 'nombre', subKey: 'client_nombre' },
      { key: 'tareas_sin_deadline',    dot: '#FDE68A', lbl: 'Tareas sin fecha límite', nameKey: 'titulo', subKey: null, mode: 'deadline' },
      { key: 'tareas_sin_responsable', dot: '#FBBFB0', lbl: 'Tareas sin responsable',  nameKey: 'titulo', subKey: null, mode: 'member' },
    ];

    let html = '';
    for (const cat of cats) {
      const items = data[cat.key] || [];
      if (!items.length) continue;
      html += `<div class="rnotif__cat">
        <div class="rnotif__cat-hdr">
          <span class="rnotif__cat-dot" style="background:${cat.dot}"></span>
          <span class="rnotif__cat-lbl">${cat.lbl}</span>
          <span class="rnotif__cat-cnt">${items.length}</span>
        </div>`;

      for (const item of items.slice(0, 6)) {
        const name = esc(item[cat.nameKey] || '');
        const sub  = cat.subKey ? esc(item[cat.subKey] || '') : '';

        if (cat.mode === 'deadline') {
          const ctx = [item.client_nombre, item.project_nombre].filter(Boolean).map(esc).join(' · ');
          html += `<div class="rnotif__item rnotif__item--clickable" data-task-id="${item.id}"
            onclick="RNotifPanel.pickDeadline(event,${item.id})">
            <div class="rnotif__item-body">
              <span class="rnotif__item-name">${name}</span>
              ${ctx ? `<span class="rnotif__item-sub">${ctx}</span>` : ''}
            </div>
            <span class="rnotif__item-hint rnotif__item-hint--date" title="Fijar fecha">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </span>
          </div>`;
        } else if (cat.mode === 'member') {
          html += `<div class="rnotif__item rnotif__item--clickable" data-task-id="${item.id}"
            onclick="RNotifPanel.pickMember(event,${item.id})">
            <div class="rnotif__item-body">
              <span class="rnotif__item-name">${name}</span>
            </div>
            <span class="rnotif__item-hint rnotif__item-hint--member" title="Asignar responsable">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </span>
          </div>`;
        } else {
          html += `<div class="rnotif__item">
            <span class="rnotif__item-name">${name}</span>
            ${sub ? `<span class="rnotif__item-sub">${sub}</span>` : ''}
          </div>`;
        }
      }

      if (items.length > 6) {
        html += `<div class="rnotif__item-more">+${items.length - 6} más…</div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;

    // Inject floating date popover (once)
    if (!$('rnotif-date-pop')) {
      const pop = document.createElement('div');
      pop.id = 'rnotif-date-pop';
      pop.className = 'rnotif-date-pop';
      pop.style.display = 'none';
      pop.innerHTML = `
        <div class="rnotif-date-pop__label">Fecha límite</div>
        <input type="date" id="rnotif-date-inp" class="rnotif-date-pop__input">
        <div class="rnotif-date-pop__footer">
          <button class="rnotif-date-pop__cancel" onclick="RNotifPanel.closeDatePop()">Cancelar</button>
          <button class="rnotif-date-pop__save" onclick="RNotifPanel.confirmDeadline()">Guardar</button>
        </div>`;
      document.body.appendChild(pop);
    }

    // Inject floating member popover (once)
    if (!$('rnotif-member-pop')) {
      const pop = document.createElement('div');
      pop.id = 'rnotif-member-pop';
      pop.className = 'rnotif-date-pop';
      pop.style.display = 'none';
      pop.innerHTML = `
        <div class="rnotif-date-pop__label">Asignar responsable</div>
        <div id="rnotif-member-chips" class="rnotif-member-chips">Cargando…</div>
        <div class="rnotif-date-pop__footer">
          <span id="rnotif-member-count" class="rnotif-member-count"></span>
          <button class="rnotif-date-pop__cancel" onclick="RNotifPanel.closeMemberPop()">Cancelar</button>
          <button class="rnotif-date-pop__save" id="rnotif-member-save" onclick="RNotifPanel.confirmMember()" disabled>Guardar</button>
        </div>`;
      document.body.appendChild(pop);
    }
  }

  function pickDeadline(e, taskId) {
    _pendingTaskId = taskId;
    const pop = $('rnotif-date-pop');
    if (!pop) return;
    // Default to today
    const inp = $('rnotif-date-inp');
    if (inp) inp.value = new Date().toISOString().split('T')[0];
    // Position near the button
    const rect = e.currentTarget.getBoundingClientRect();
    pop.style.display = 'block';
    const popW = 220, popH = 120;
    let left = rect.left - popW - 8;
    let top  = rect.top;
    if (left < 8) left = rect.right + 8;
    if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
    setTimeout(() => inp?.focus(), 50);
    setTimeout(() => document.addEventListener('click', _popOutside), 0);
  }

  function _popOutside(e) {
    const pop = $('rnotif-date-pop');
    if (pop && !pop.contains(e.target)) closeDatePop();
  }

  function closeDatePop() {
    const pop = $('rnotif-date-pop');
    if (pop) pop.style.display = 'none';
    document.removeEventListener('click', _popOutside);
    _pendingTaskId = null;
  }

  async function confirmDeadline() {
    const date = $('rnotif-date-inp')?.value;
    if (!date || !_pendingTaskId) return;
    const taskId = _pendingTaskId;
    const saveBtn = document.querySelector('.rnotif-date-pop__save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }
    try {
      const res = await apiFetch(`${API}/mgmt/tasks/${taskId}/deadline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deadline: date }),
      });
      if (!res.ok) throw new Error('Error al guardar');
      closeDatePop();
      // Animate item out then reload
      const row = document.querySelector(`[data-task-id="${taskId}"]`);
      if (row) {
        row.style.transition = 'opacity .25s, transform .25s';
        row.style.opacity = '0';
        row.style.transform = 'translateX(12px)';
        setTimeout(() => load(), 300);
      } else {
        load();
      }
    } catch (err) {
      alert('Error: ' + err.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar'; }
    }
  }

  async function pickMember(e, taskId) {
    _pendingTaskId  = taskId;
    _pendingMembers = [];
    const pop = $('rnotif-member-pop');
    if (!pop) return;
    const chips    = $('rnotif-member-chips');
    const saveBtn  = $('rnotif-member-save');
    const countEl  = $('rnotif-member-count');
    if (chips)   chips.innerHTML = '<span style="color:var(--muted);font-size:12px">Cargando…</span>';
    if (saveBtn) saveBtn.disabled = true;
    if (countEl) countEl.textContent = '';

    // Position
    const rect = e.currentTarget.getBoundingClientRect();
    pop.style.display = 'block';
    let left = rect.left - 230 - 8;
    let top  = rect.top;
    if (left < 8) left = rect.right + 8;
    if (top + 180 > window.innerHeight - 8) top = window.innerHeight - 180 - 8;
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';

    // Load team
    try {
      if (!_teamCache) {
        const res = await apiFetch(`${API}/mgmt/team`);
        _teamCache = res.ok ? await res.json() : [];
      }
      if (chips) {
        chips.innerHTML = _teamCache.length
          ? _teamCache.map(m => `
              <button type="button" class="rnotif-member-chip" data-name="${esc(m.nombre)}"
                onclick="RNotifPanel._selectMember(this,'${esc(m.nombre)}')">
                ${esc(m.nombre)}
              </button>`).join('')
          : '<span style="color:var(--muted);font-size:12px">Sin miembros</span>';
      }
    } catch {
      if (chips) chips.innerHTML = '<span style="color:var(--muted);font-size:12px">Error</span>';
    }
    setTimeout(() => document.addEventListener('click', _memberPopOutside), 0);
  }

  function _selectMember(el, name) {
    // Toggle: add or remove from selection
    const idx = _pendingMembers.indexOf(name);
    if (idx === -1) _pendingMembers.push(name);
    else            _pendingMembers.splice(idx, 1);

    el.classList.toggle('rnotif-member-chip--on', _pendingMembers.includes(name));

    // Update save button and counter label
    const saveBtn = $('rnotif-member-save');
    const countEl = $('rnotif-member-count');
    if (saveBtn) saveBtn.disabled = _pendingMembers.length === 0;
    if (countEl) countEl.textContent = _pendingMembers.length > 0
      ? `${_pendingMembers.length} seleccionado${_pendingMembers.length > 1 ? 's' : ''}`
      : '';
  }

  function _memberPopOutside(e) {
    const pop = $('rnotif-member-pop');
    if (pop && !pop.contains(e.target)) closeMemberPop();
  }

  function closeMemberPop() {
    const pop = $('rnotif-member-pop');
    if (pop) pop.style.display = 'none';
    document.removeEventListener('click', _memberPopOutside);
    _pendingTaskId  = null;
    _pendingMembers = [];
  }

  async function confirmMember() {
    if (!_pendingTaskId || !_pendingMembers.length) return;
    const taskId      = _pendingTaskId;
    const responsables = [..._pendingMembers];
    const saveBtn = $('rnotif-member-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }
    try {
      const res = await apiFetch(`${API}/mgmt/tasks/${taskId}/responsable`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ responsable: responsables[0], responsables }),
      });
      if (!res.ok) throw new Error('Error al guardar');
      closeMemberPop();
      const row = document.querySelector(`[data-task-id="${taskId}"]`);
      if (row) {
        row.style.transition = 'opacity .25s, transform .25s';
        row.style.opacity    = '0';
        row.style.transform  = 'translateX(12px)';
        setTimeout(() => load(), 300);
      } else {
        load();
      }
    } catch (err) {
      alert('Error: ' + err.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar'; }
    }
  }

  return {
    load, updateBadge: _updateBadge,
    pickDeadline, closeDatePop, confirmDeadline,
    pickMember, _selectMember, closeMemberPop, confirmMember,
  };
})();

// =================================================================
// TIMER MODULE
// =================================================================
const TimerModule = (() => {
  const IDLE_MS  = 5 * 60 * 1000;
  const PULSE_MS = 30 * 1000;
  const LS_KEY   = 'nova_timer_session';

  let _entryId      = null;
  let _startedAt    = null;
  let _activeS      = 0;
  let _idleS        = 0;
  let _isIdle       = false;
  let _lastActivity = Date.now();
  let _pulseTimer   = null;
  let _idleTimer    = null;
  let _displayTimer = null;
  let _taskId       = null;
  let _taskTitle    = '';
  let _isAdmin      = false;

  function _loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (s?.entryId && s?.startedAt) {
        _entryId   = s.entryId;
        _startedAt = new Date(s.startedAt);
        _activeS   = s.activeS || 0;
        _idleS     = s.idleS   || 0;
        _taskId    = s.taskId  || null;
        _taskTitle = s.taskTitle || '';
        return true;
      }
    } catch (_) {}
    return false;
  }

  function _saveSession() {
    if (!_entryId) { localStorage.removeItem(LS_KEY); return; }
    localStorage.setItem(LS_KEY, JSON.stringify({
      entryId: _entryId, startedAt: _startedAt?.toISOString(),
      activeS: _activeS, idleS: _idleS, taskId: _taskId, taskTitle: _taskTitle,
    }));
  }

  function _fmtElapsed(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  }

  function _fmtDur(s) {
    if (!s) return '0m';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function _elapsed() {
    return _startedAt ? Math.round((Date.now() - _startedAt.getTime()) / 1000) : 0;
  }

  function _currentActive() {
    const idleNow = _isIdle ? Math.round((Date.now() - _lastActivity) / 1000) : 0;
    return Math.max(0, _elapsed() - _idleS - idleNow);
  }

  function _onActivity() {
    const now = Date.now();
    if (_isIdle && _entryId) {
      _idleS += Math.round((now - _lastActivity) / 1000);
      _isIdle = false;
      _updateWidget();
    }
    _lastActivity = now;
    clearTimeout(_idleTimer);
    if (_entryId) _idleTimer = setTimeout(_onIdle, IDLE_MS);
  }

  function _onIdle() {
    if (!_entryId) return;
    _isIdle = true;
    _lastActivity = Date.now();
    _updateWidget();
  }

  function _onVisibility() {
    if (document.hidden) { _onIdle(); } else { _onActivity(); }
  }

  function _updateWidget() {
    const widget = $('tt-widget');
    if (!widget) return;
    if (!_entryId) {
      widget.classList.add('tt-widget--hidden');
      _updatePlayButtons();
      return;
    }
    widget.classList.remove('tt-widget--hidden');
    const elapsed = _elapsed();
    const display = widget.querySelector('.tt-widget__time');
    const statusEl = widget.querySelector('.tt-widget__status');
    const taskEl  = widget.querySelector('.tt-widget__task');
    const bar     = widget.querySelector('.tt-widget__bar-fill');
    const pctEl   = widget.querySelector('.tt-widget__pct');
    if (display)  display.textContent  = _fmtElapsed(elapsed);
    if (statusEl) { statusEl.className = `tt-widget__status ${_isIdle ? 'tt-widget__status--idle' : 'tt-widget__status--active'}`; statusEl.textContent = _isIdle ? '● Inactivo' : '● Activo'; }
    if (taskEl)   taskEl.textContent   = _taskTitle || 'Sin tarea';
    const pct = elapsed > 0 ? Math.round((_currentActive() / elapsed) * 100) : 100;
    if (bar)  bar.style.width   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '% activo';
    _updatePlayButtons();
  }

  async function _pulse() {
    if (!_entryId) return;
    try {
      await apiFetch(`${API}/timer/${_entryId}/pulse`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_s: _currentActive(), idle_s: _idleS }),
      });
    } catch (_) {}
    _saveSession();
  }

  function _startListeners() {
    document.addEventListener('mousemove', _onActivity, { passive: true });
    document.addEventListener('keydown', _onActivity, { passive: true });
    document.addEventListener('click', _onActivity, { passive: true });
    document.addEventListener('visibilitychange', _onVisibility);
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(_onIdle, IDLE_MS);
  }

  function _stopListeners() {
    document.removeEventListener('mousemove', _onActivity);
    document.removeEventListener('keydown', _onActivity);
    document.removeEventListener('click', _onActivity);
    document.removeEventListener('visibilitychange', _onVisibility);
    clearTimeout(_idleTimer);
  }

  async function start(taskId) {
    if (_entryId) await stop();
    try {
      const res = await apiFetch(`${API}/timer/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId || null }),
      });
      if (!res.ok) return;
      const data = await res.json();
      _entryId   = data.entryId;
      _startedAt = new Date(data.startedAt);
      _activeS   = 0; _idleS = 0; _taskId = taskId;
      _taskTitle = data.taskTitulo || '';
      _isIdle    = false; _lastActivity = Date.now();
      _saveSession();
      _startListeners();
      clearInterval(_displayTimer);
      _displayTimer = setInterval(_updateWidget, 1000);
      clearInterval(_pulseTimer);
      _pulseTimer = setInterval(_pulse, PULSE_MS);
      _updateWidget();
      showBanner(`Timer iniciado${_taskTitle ? ': ' + _taskTitle : ''}`, 'success');
    } catch (e) { console.error('[timer] start:', e); }
  }

  async function stop() {
    if (!_entryId) return;
    clearInterval(_pulseTimer); clearInterval(_displayTimer); clearTimeout(_idleTimer);
    const idleNow = _isIdle ? Math.round((Date.now() - _lastActivity) / 1000) : 0;
    try {
      await apiFetch(`${API}/timer/${_entryId}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_s: _currentActive(), idle_s: _idleS + idleNow }),
      });
    } catch (_) {}
    _entryId = null; _startedAt = null; _activeS = 0; _idleS = 0; _taskId = null; _taskTitle = '';
    _isIdle  = false;
    _saveSession(); _stopListeners(); _updateWidget();
    showBanner('Timer detenido', 'info');
    setTimeout(loadReport, 300);
  }

  const _PLAY_SVG  = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:100%;height:100%"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const _PAUSE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:100%;height:100%"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;

  function _updatePlayButtons() {
    const hms = _fmtElapsed(_elapsed());
    document.querySelectorAll('[data-timer-task]').forEach(btn => {
      const tid = parseInt(btn.dataset.timerTask, 10);
      const active = !!_entryId && _taskId === tid;
      btn.innerHTML = active ? _PAUSE_SVG : _PLAY_SVG;
      btn.classList.toggle('tt-btn--active', active);
      btn.title = active ? 'Pausar / Detener timer' : 'Iniciar timer';
      document.querySelectorAll(`[data-timer-display="${tid}"]`).forEach(disp => {
        disp.textContent = active ? hms : ''; disp.hidden = !active;
      });
    });
    CalendarModule.tickRunning();
  }

  function toggleTask(taskId) {
    if (_entryId && _taskId === taskId) stop();
    else start(taskId);
  }

  function startFromTask(taskId) { start(taskId); }

  async function init() {
    const user = window._authUser;
    _isAdmin = !!(user?.isOwner || ['admin', 'manager'].includes(user?.memberRol));

    if (_loadSession()) {
      try {
        const res = await apiFetch(`${API}/timer/running`);
        if (res.ok) {
          const data = await res.json();
          if (data.running && data.entryId === _entryId) {
            _startedAt = new Date(data.startedAt);
            _activeS   = data.activeS || 0;
            _idleS     = data.idleS   || 0;
            _startListeners();
            clearInterval(_displayTimer);
            _displayTimer = setInterval(_updateWidget, 1000);
            clearInterval(_pulseTimer);
            _pulseTimer   = setInterval(_pulse, PULSE_MS);
            _updateWidget();
          } else {
            _entryId = null; localStorage.removeItem(LS_KEY); _updateWidget();
          }
        }
      } catch (_) { _updateWidget(); }
    } else {
      _updateWidget();
    }
    loadReport();
  }

  async function loadReport() {
    const pane = $('tt-report-root');
    if (!pane) return;

    const today = new Date();
    const dow   = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow));
    monday.setHours(0,0,0,0);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    sunday.setHours(23,59,59,999);

    try {
      const [todayRes, weekRes] = await Promise.all([
        apiFetch(`${API}/timer/today`),
        apiFetch(`${API}/timer/report?start=${monday.toISOString()}&end=${sunday.toISOString()}`),
      ]);
      const todayData = todayRes.ok ? await todayRes.json() : [];
      const weekData  = weekRes.ok  ? await weekRes.json()  : { totalS: 0, byDay: [], byTask: [] };

      let teamData = null;
      if (_isAdmin) {
        const teamRes = await apiFetch(`${API}/timer/team?start=${monday.toISOString()}&end=${sunday.toISOString()}`);
        if (teamRes.ok) teamData = await teamRes.json();
      }

      _renderReport(pane, todayData, weekData, teamData);
    } catch (e) { console.error('[timer] loadReport:', e); }
  }

  function _renderReport(pane, todayEntries, weekData, teamData) {
    const days = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    const todayTotal  = todayEntries.reduce((a, e) => a + (e.duration_s || 0), 0);
    const todayActive = todayEntries.reduce((a, e) => a + (e.active_s || 0), 0);
    const activePct   = todayTotal > 0 ? Math.round((todayActive / todayTotal) * 100) : 0;
    const maxDay = Math.max(...(weekData.byDay || []).map(d => d.duration_s || 0), 1);

    const barsHtml = (weekData.byDay || []).map((d, i) => {
      const pct = Math.round(((d.duration_s || 0) / maxDay) * 100);
      return `<div class="tt-bar-col">
        <div class="tt-bar-track"><div class="tt-bar-fill${d.isToday ? ' tt-bar-fill--today' : ''}" style="height:${pct}%"></div></div>
        <div class="tt-bar-label${d.isToday ? ' tt-bar-label--today' : ''}">${days[i] || ''}</div>
        <div class="tt-bar-val">${_fmtDur(d.duration_s)}</div>
      </div>`;
    }).join('');

    const entriesHtml = todayEntries.length === 0
      ? `<div class="tt-empty">Sin sesiones hoy. Usa el botón ▶ en una tarea o el widget de la barra lateral.</div>`
      : todayEntries.map(e => `
        <div class="tt-entry">
          <div class="tt-entry__left">
            <div class="tt-entry__task">${esc(e.task_titulo || 'Sin tarea')}</div>
            ${e.project_nombre ? `<div class="tt-entry__project">${esc(e.project_nombre)}</div>` : ''}
          </div>
          <div class="tt-entry__right">
            <span class="tt-entry__dur">${_fmtDur(e.duration_s)}</span>
            <span class="tt-entry__activepct">${e.duration_s > 0 ? Math.round((e.active_s / e.duration_s) * 100) : 0}% activo</span>
            <button class="tt-entry__del" onclick="TimerModule.deleteEntry(${e.id})" title="Eliminar">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </div>`).join('');

    const byTaskHtml = (weekData.byTask || []).map(t => {
      const pct = weekData.totalS > 0 ? Math.round((t.total_s / weekData.totalS) * 100) : 0;
      return `<div class="tt-task-row">
        <div class="tt-task-row__name">${esc(t.task_titulo || 'Sin tarea')}</div>
        <div class="tt-task-row__bar-wrap"><div class="tt-task-row__bar" style="width:${pct}%"></div></div>
        <div class="tt-task-row__dur">${_fmtDur(t.total_s)}</div>
      </div>`;
    }).join('');

    const teamHtml = teamData ? `
      <div class="tt-card tt-card--print">
        <div class="tt-card__title">Equipo — esta semana</div>
        <table class="tt-team-table">
          <thead><tr><th>Miembro</th><th>Tiempo total</th><th>% Activo</th><th>Sesiones</th></tr></thead>
          <tbody>${teamData.map(m => `
            <tr>
              <td>${esc(m.nombre || '—')}</td>
              <td>${_fmtDur(m.totalS)}</td>
              <td>${m.totalS > 0 ? Math.round((m.activeS / m.totalS) * 100) : 0}%</td>
              <td>${m.sessions}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    pane.innerHTML = `
      <div class="tt-page-header">
        <div>
          <h2 class="tt-page-title">Time Tracking</h2>
          <div class="tt-page-sub">Semana actual</div>
        </div>
        <button class="tt-print-btn" onclick="window.print()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Imprimir reporte
        </button>
      </div>

      <div class="tt-stats-row">
        <div class="tt-stat"><div class="tt-stat__val">${_fmtDur(todayTotal)}</div><div class="tt-stat__label">Hoy</div></div>
        <div class="tt-stat"><div class="tt-stat__val">${activePct}%</div><div class="tt-stat__label">Activo hoy</div></div>
        <div class="tt-stat"><div class="tt-stat__val">${todayEntries.length}</div><div class="tt-stat__label">Sesiones hoy</div></div>
        <div class="tt-stat"><div class="tt-stat__val">${_fmtDur(weekData.totalS)}</div><div class="tt-stat__label">Esta semana</div></div>
      </div>

      <div class="tt-card tt-card--print">
        <div class="tt-card__title">Semana — ${_fmtDur(weekData.totalS || 0)} total</div>
        <div class="tt-bars">${barsHtml}</div>
      </div>

      <div class="tt-card tt-card--print">
        <div class="tt-card__title">Entradas de hoy</div>
        <div class="tt-entries">${entriesHtml}</div>
      </div>

      ${(weekData.byTask || []).length ? `
      <div class="tt-card tt-card--print">
        <div class="tt-card__title">Por tarea — esta semana</div>
        ${byTaskHtml}
      </div>` : ''}

      ${teamHtml}
    `;
  }

  async function deleteEntry(id) {
    if (!confirm('¿Eliminar esta entrada de tiempo?')) return;
    await apiFetch(`${API}/timer/${id}`, { method: 'DELETE' });
    loadReport();
  }

  return { init, start, stop, startFromTask, toggleTask, loadReport, deleteEntry, syncButtons: _updatePlayButtons };
})();

// =================================================================
// APP — wired after successful auth
// =================================================================

function initApp() {

  // ── Tab switching ───────────────────────────────────────────────
  let _verifLoaded = false;

  // Wire both old .tab buttons and new .snav-item sidebar buttons
  function _switchTab(tabName) {
    document.querySelectorAll('.tab,.snav-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(t => t.classList.add('active'));
    $(`pane-${tabName}`)?.classList.add('active');
    if (tabName === 'batch') { _checkPersistedJob(); _loadBatchHistory(); }
    if (tabName === 'verifications' && !_verifLoaded) {
      _verifLoaded = true;
      loadTagSuggestions();
      loadVerifications();
    }
    if (tabName === 'mgmt-dashboard') DashboardModule.load();
    if (tabName === 'mgmt-finance')   FinanceModule.load();
    if (tabName === 'mgmt-clients')   ClientsModule.load();
    if (tabName === 'mgmt-projects')  ProjectsModule.load();
    if (tabName === 'mgmt-tasks')     TasksModule.load();
    if (tabName === 'mgmt-calendar')  CalendarModule.load();
    if (tabName === 'mgmt-blocks')    BlocksModule.load();
    if (tabName === 'mgmt-team')      TeamModule.load();
    if (tabName === 'mgmt-chat')          ChatModule.load();
    if (tabName === 'lead-manager')       LeadManagerModule.load();
    if (tabName === 'mgmt-timetracking')  TimerModule.loadReport();
  }

  document.querySelectorAll('.tab, .snav-item').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });

  // ═══════════════════════════════════════════════════════════════
  // SINGLE LEAD
  // ═══════════════════════════════════════════════════════════════

  $('btnSingle').addEventListener('click', async () => {
    const fn = $('s_fn').value.trim();
    const ln = $('s_ln').value.trim();
    const co = $('s_co').value.trim();

    hideAlert($('singleErr'));
    [$('s_fn'), $('s_ln'), $('s_co')].forEach(el => el.classList.remove('err'));

    if (!fn) $('s_fn').classList.add('err');
    if (!ln) $('s_ln').classList.add('err');
    if (!co) $('s_co').classList.add('err');
    if (!fn || !ln || !co) {
      showAlert($('singleErr'), 'First name, last name and company/website are required.');
      return;
    }

    setBtn($('btnSingle'), true);
    $('singleResult').classList.add('hidden');

    try {
      const tag = $('s_tag').value.trim() || undefined;
      const res  = await apiFetch(`${API}/enrich`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firstName: fn, lastName: ln, company: co, linkedinUrl: $('s_li').value.trim(), tag }),
      });
      const data = await res.json();
      if (res.status === 401) {
        // Session expired — force re-login
        location.reload();
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderSingleResult(data);
    } catch (err) {
      showAlert($('singleErr'), `Error: ${err.message}`);
    } finally {
      setBtn($('btnSingle'), false);
    }
  });

  $('btnClearSingle')?.addEventListener('click', () => {
    [$('s_fn'), $('s_ln'), $('s_co'), $('s_li'), $('s_tag')].forEach(el => { if (el) { el.value = ''; el.classList.remove('err'); } });
    hideAlert($('singleErr'));
    $('singleResult')?.classList.add('hidden');
  });

  // ═══════════════════════════════════════════════════════════════
  // BATCH UPLOAD
  // ═══════════════════════════════════════════════════════════════

  let uploadedFile  = null;
  let batchResults  = [];
  let filteredRows  = [];
  let currentPage   = 1;
  const PAGE_SIZE   = 20;
  let lastXlsBuffer = null;

  const zone = $('uploadZone');
  zone.addEventListener('click', () => $('fileInput').click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); });

  // Field labels for the mapping UI
  // ── Field options for mapping dropdown ──────────────────────────
  const FIELD_OPTIONS = [
    { value: '',             label: '— Campo extra (se conserva) —', group: '' },
    { value: '__ignore__',   label: '✕ Ignorar (no incluir)',        group: '' },

    // ── Campos críticos para enriquecimiento ─────────────────────
    { value: 'firstname',    label: 'Nombre',              group: '⚡ Enriquecimiento (requeridos)' },
    { value: 'lastname',     label: 'Apellido',            group: '⚡ Enriquecimiento (requeridos)' },
    { value: 'company',      label: 'Sitio web / Empresa', group: '⚡ Enriquecimiento (requeridos)' },
    { value: 'linkedinurl',  label: 'LinkedIn URL',        group: '⚡ Enriquecimiento (requeridos)' },

    // ── Información básica del contacto ──────────────────────────
    { value: 'nombreCompleto',    label: 'Nombre completo',       group: 'Información básica del contacto' },
    { value: 'cargo',             label: 'Cargo',                  group: 'Información básica del contacto' },
    { value: 'area',              label: 'Área / Departamento',    group: 'Información básica del contacto' },
    { value: 'nivelJerarquico',   label: 'Nivel jerárquico',       group: 'Información básica del contacto' },
    { value: 'email',             label: 'Correo electrónico',     group: 'Información básica del contacto' },
    { value: 'emailSecundario',   label: 'Correo secundario',      group: 'Información básica del contacto' },
    { value: 'telefono',          label: 'Teléfono',               group: 'Información básica del contacto' },
    { value: 'celular',           label: 'Celular',                group: 'Información básica del contacto' },
    { value: 'whatsapp',          label: 'WhatsApp',               group: 'Información básica del contacto' },
    { value: 'sitioWeb',          label: 'Sitio web personal',     group: 'Información básica del contacto' },
    { value: 'idioma',            label: 'Idioma preferido',       group: 'Información básica del contacto' },
    { value: 'zonaHoraria',       label: 'Zona horaria',           group: 'Información básica del contacto' },

    // ── Información de la empresa ─────────────────────────────────
    { value: 'nombreEmpresa',     label: 'Nombre de la empresa',   group: 'Información de la empresa' },
    { value: 'sitioEmpresa',      label: 'Sitio web de la empresa',group: 'Información de la empresa' },
    { value: 'industria',         label: 'Industria / Sector',     group: 'Información de la empresa' },
    { value: 'tamanoEmpresa',     label: 'Tamaño de empresa',      group: 'Información de la empresa' },
    { value: 'numEmpleados',      label: 'Número de empleados',    group: 'Información de la empresa' },
    { value: 'facturacion',       label: 'Facturación anual',      group: 'Información de la empresa' },
    { value: 'anoFundacion',      label: 'Año de fundación',       group: 'Información de la empresa' },
    { value: 'descripcionEmpresa',label: 'Descripción de la empresa',group:'Información de la empresa' },
    { value: 'tecnologias',       label: 'Tecnologías utilizadas', group: 'Información de la empresa' },
    { value: 'oficinaPrincipal',  label: 'Oficina principal',      group: 'Información de la empresa' },
    { value: 'pais',              label: 'País',                   group: 'Información de la empresa' },
    { value: 'region',            label: 'Región / Provincia',     group: 'Información de la empresa' },
    { value: 'ciudad',            label: 'Ciudad',                 group: 'Información de la empresa' },
    { value: 'direccion',         label: 'Dirección',              group: 'Información de la empresa' },
    { value: 'codigoPostal',      label: 'Código postal',          group: 'Información de la empresa' },
    { value: 'linkedinEmpresa',   label: 'LinkedIn de la empresa', group: 'Información de la empresa' },

    // ── Información comercial del lead ───────────────────────────
    { value: 'estadoLead',        label: 'Estado del lead',        group: 'Información comercial' },
    { value: 'etapaCiclo',        label: 'Etapa del ciclo de vida',group: 'Información comercial' },
    { value: 'pipeline',          label: 'Pipeline',               group: 'Información comercial' },
    { value: 'etapaOportunidad',  label: 'Etapa de oportunidad',   group: 'Información comercial' },
    { value: 'fuenteLead',        label: 'Fuente del lead',        group: 'Información comercial' },
    { value: 'fuenteOriginal',    label: 'Fuente original',        group: 'Información comercial' },
    { value: 'campana',           label: 'Campaña',                group: 'Información comercial' },
    { value: 'utmSource',         label: 'UTM Source',             group: 'Información comercial' },
    { value: 'utmMedium',         label: 'UTM Medium',             group: 'Información comercial' },
    { value: 'utmCampaign',       label: 'UTM Campaign',           group: 'Información comercial' },
    { value: 'utmContent',        label: 'UTM Content',            group: 'Información comercial' },
    { value: 'utmTerm',           label: 'UTM Term',               group: 'Información comercial' },
    { value: 'nivelInteres',      label: 'Nivel de interés',       group: 'Información comercial' },
    { value: 'interesProducto',   label: 'Interés en producto',    group: 'Información comercial' },
    { value: 'interesServicio',   label: 'Interés en servicio',    group: 'Información comercial' },
    { value: 'presupuesto',       label: 'Presupuesto',            group: 'Información comercial' },
    { value: 'valorEstimado',     label: 'Valor estimado',         group: 'Información comercial' },
    { value: 'tiempoCompra',      label: 'Tiempo estimado de compra',group:'Información comercial' },
    { value: 'prioridad',         label: 'Prioridad',              group: 'Información comercial' },
    { value: 'etiquetas',         label: 'Etiquetas',              group: 'Información comercial' },
    { value: 'notas',             label: 'Notas',                  group: 'Información comercial' },
    { value: 'problemas',         label: 'Problemas detectados',   group: 'Información comercial' },
    { value: 'casoUso',           label: 'Caso de uso',            group: 'Información comercial' },
    { value: 'ultimoContacto',    label: 'Fecha de último contacto',group:'Información comercial' },
    { value: 'proximoSeguimiento',label: 'Próxima fecha de seguimiento',group:'Información comercial' },
    { value: 'responsableComercial',label:'Responsable comercial', group: 'Información comercial' },

    // ── Prospección B2B ──────────────────────────────────────────
    { value: 'coincidenciaICP',   label: 'Coincidencia con ICP',   group: 'Prospección B2B' },
    { value: 'buyerPersona',      label: 'Tipo de buyer persona',  group: 'Prospección B2B' },
    { value: 'tomadorDecision',   label: 'Tomador de decisión',    group: 'Prospección B2B' },
    { value: 'rolCompra',         label: 'Rol en la compra',       group: 'Prospección B2B' },
    { value: 'nivelGerencial',    label: 'Nivel gerencial',        group: 'Prospección B2B' },
    { value: 'telefonoDirecto',   label: 'Teléfono directo',       group: 'Prospección B2B' },
    { value: 'correoCorporativo', label: 'Correo corporativo',     group: 'Prospección B2B' },
    { value: 'correoPersonal',    label: 'Correo personal',        group: 'Prospección B2B' },
    { value: 'senalesIntencion',  label: 'Señales de intención',   group: 'Prospección B2B' },
    { value: 'techStack',         label: 'Tecnologías usadas',     group: 'Prospección B2B' },
    { value: 'senalesContratacion',label:'Señales de contratación',group: 'Prospección B2B' },
    { value: 'etapaInversion',    label: 'Etapa de inversión',     group: 'Prospección B2B' },
    { value: 'montoInversion',    label: 'Monto de inversión',     group: 'Prospección B2B' },

    // ── Actividad y engagement ───────────────────────────────────
    { value: 'ultimoEmailAbierto',label: 'Último email abierto',   group: 'Actividad y engagement' },
    { value: 'ultimoClick',       label: 'Último clic en email',   group: 'Actividad y engagement' },
    { value: 'reunionesAgendadas',label: 'Reuniones agendadas',    group: 'Actividad y engagement' },
    { value: 'resultadoLlamada',  label: 'Resultado de llamada',   group: 'Actividad y engagement' },
    { value: 'fueContactado',     label: '¿Fue contactado?',       group: 'Actividad y engagement' },
    { value: 'respondio',         label: '¿Respondió?',            group: 'Actividad y engagement' },
    { value: 'demoAgendada',      label: '¿Demo agendada?',        group: 'Actividad y engagement' },
    { value: 'pruebaIniciada',    label: '¿Prueba iniciada?',      group: 'Actividad y engagement' },
    { value: 'esCliente',         label: '¿Es cliente?',           group: 'Actividad y engagement' },
    { value: 'puntajeLead',       label: 'Puntaje del lead',       group: 'Actividad y engagement' },
    { value: 'puntajeInteraccion',label: 'Puntaje de interacción', group: 'Actividad y engagement' },

    // ── Campos de sistema ────────────────────────────────────────
    { value: 'idRegistro',        label: 'ID del registro',        group: 'Sistema / Automatización' },
    { value: 'idExterno',         label: 'ID externo',             group: 'Sistema / Automatización' },
    { value: 'loteImportacion',   label: 'Lote de importación',    group: 'Sistema / Automatización' },
    { value: 'fechaCreacion',     label: 'Fecha de creación',      group: 'Sistema / Automatización' },
    { value: 'fechaActualizacion',label: 'Fecha de actualización', group: 'Sistema / Automatización' },
    { value: 'archivoFuente',     label: 'Archivo fuente',         group: 'Sistema / Automatización' },
    { value: 'consentimientoGDPR',label: 'Consentimiento GDPR',    group: 'Sistema / Automatización' },
    { value: 'estadoSuscripcion', label: 'Estado de suscripción',  group: 'Sistema / Automatización' },
    { value: 'estadoDuplicado',   label: 'Estado de duplicado',    group: 'Sistema / Automatización' },

    // ── Outbound / Cold email ────────────────────────────────────
    { value: 'temperatura',       label: 'Lead frío o caliente',   group: 'Outbound / Cold email' },
    { value: 'nombreSecuencia',   label: 'Nombre de secuencia',    group: 'Outbound / Cold email' },
    { value: 'pasoSecuencia',     label: 'Paso de secuencia',      group: 'Outbound / Cold email' },
    { value: 'estadoOutreach',    label: 'Estado de outreach',     group: 'Outbound / Cold email' },
    { value: 'estadoRebote',      label: 'Estado de rebote',       group: 'Outbound / Cold email' },
    { value: 'sentimientoRespuesta',label:'Sentimiento de respuesta',group:'Outbound / Cold email' },
    { value: 'linkReunion',       label: 'Link de reunión',        group: 'Outbound / Cold email' },
    { value: 'notasSDR',          label: 'Notas SDR',              group: 'Outbound / Cold email' },

    // ── Campos B2B comunes ───────────────────────────────────────
    { value: 'dominioEmpresa',    label: 'Dominio de empresa',     group: 'Campos B2B comunes' },
    { value: 'correoLaboral',     label: 'Correo laboral',         group: 'Campos B2B comunes' },
    { value: 'linkedinPersonal',  label: 'LinkedIn personal',      group: 'Campos B2B comunes' },
    { value: 'rangoFacturacion',  label: 'Rango de facturación',   group: 'Campos B2B comunes' },
    { value: 'categoriaIndustria',label: 'Categoría de industria', group: 'Campos B2B comunes' },
    { value: 'responsableCRM',    label: 'Responsable CRM',        group: 'Campos B2B comunes' },
  ];

  // ── Extended aliases for client-side auto-detection ──────────────
  const CLIENT_ALIASES = {
    firstname:   ['firstname','first_name','first name','nombre','prenom','given name','givenname',
                  'nombres','nombre del contacto','first','fname','nombre(s)','name','nombre completo'],
    lastname:    ['lastname','last_name','last name','apellido','surname','family name','familyname',
                  'nom','apellidos','apellido(s)','last','lname'],
    company:     ['company','empresa','organisation','organization','companyurl','company url',
                  'website','site','url','web','domain','dominio','sitio web','company website',
                  'company name','nombre de la empresa','org','account','employer','web de empresa',
                  'company domain','company web','webpage'],
    linkedinurl: ['linkedin','linkedinurl','linkedin url','linkedin_url','perfil linkedin','profile',
                  'linkedin profile','linkedin profile url','personal linkedin','linkedin personal',
                  'url de linkedin','linkedin del contacto','linkedin contact'],
  };

  // ── Smart field guesser: header name + data pattern analysis ────
  function guessField(headerRaw, sampleValues = []) {
    const h       = String(headerRaw).toLowerCase().trim().replace(/\s+/g,' ');
    const samples = sampleValues.map(v => String(v).trim()).filter(Boolean);
    const total   = samples.length;

    // ── Pattern matchers ──────────────────────────────────────
    const isEmail    = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    const isLinkedIn = v => /linkedin\.com\/(in\/|pub\/)/.test(v);
    const isLinkedInCo = v => /linkedin\.com\/company/.test(v);
    const isUrl      = v => /^https?:\/\//i.test(v);
    const isDomain   = v => /^[a-z0-9][a-z0-9\-]*\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(v) && !v.includes('@');
    const isPhone    = v => /^[\+\d][\d\s\-\(\)\.]{5,18}$/.test(v.replace(/\s/g,''));
    const isSingleWord = v => /^\S+$/.test(v) && v.length < 30;
    const isCapName  = v => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(v);

    // ── Score-based data pattern analysis ─────────────────────
    if (total >= 2) {
      const pct = fn => samples.filter(fn).length / total;

      if (pct(isLinkedIn) >= 0.5)   return 'linkedinurl';
      if (pct(isLinkedInCo) >= 0.5) return '__ignore__';
      if (pct(isEmail) >= 0.5)      return 'email';
      if (pct(v => isUrl(v) && !isLinkedIn(v)) >= 0.5) return 'company';
      if (pct(isDomain) >= 0.6)     return 'company';
      if (pct(isPhone) >= 0.5)      return 'telefono';

      // If all values are single capitalized words → likely firstname or lastname
      if (pct(v => isSingleWord(v) && isCapName(v)) >= 0.7) {
        // Disambiguate: if header hints at last, pick lastname
        if (/last|apellido|surname|family/i.test(h)) return 'lastname';
        if (/first|nombre|given|prenom/i.test(h))    return 'firstname';
        // Can't tell from data alone — leave for header check below
      }
    }

    // ── Header-based: LinkedIn URLs ───────────────────────────
    if (isLinkedIn(h))   return 'linkedinurl';
    if (isLinkedInCo(h)) return '__ignore__';
    if (isUrl(h) && !h.includes('linkedin.com')) return 'company';

    // ── Header alias lookup ───────────────────────────────────
    for (const [field, aliases] of Object.entries(CLIENT_ALIASES)) {
      if (aliases.includes(h)) return field;
    }

    // ── Keyword heuristics on header ─────────────────────────
    if (/\bfirst\b|nombre(?! de|.*empresa)|prenom|\bgiven\b/i.test(h) &&
        !/last|apellido|family|empresa|company/i.test(h)) return 'firstname';
    if (/\blast\b|apellido|surname|\bfamily\b/i.test(h)) return 'lastname';
    if (/company|empresa|domain|dominio|website|sitio web|org\b|web\b/i.test(h)) return 'company';
    if (/linkedin/i.test(h)) return 'linkedinurl';
    if (/\bemail\b|correo|mail\b/i.test(h)) return 'email';
    if (/\bphone\b|tel[eé]fono|\btel\b|celular|m[oó]vil|whatsapp/i.test(h)) return 'telefono';
    if (/\btitle\b|cargo|puesto|position|job title/i.test(h)) return 'cargo';
    if (/country|pa[ií]s\b/i.test(h)) return 'pais';
    if (/city|ciudad/i.test(h)) return 'ciudad';
    if (/industry|industria|sector/i.test(h)) return 'industria';

    return ''; // extra field, preserve as-is
  }

  /** Read headers + sample rows from a CSV/TSV file in the browser */
  function readCsvHeaders(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const text  = e.target.result || '';
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) { resolve({ headers: [], sampleRows: [] }); return; }
        const firstLine = lines[0];
        const delim = firstLine.includes('\t') ? '\t'
                    : firstLine.includes(';')  ? ';' : ',';
        const parseRow = l => l.split(delim).map(h => h.replace(/^["']|["']$/g,'').trim());
        const headers    = parseRow(firstLine);
        const sampleRows = lines.slice(1, 6).map(parseRow);
        resolve({ headers, sampleRows });
      };
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsText(file.slice(0, 32768)); // 32 KB — enough for 5+ rows
    });
  }

  // ── Searchable custom select for column mapping ───────────────────
  function _buildSearchableSelect(colIdx, selectedValue) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-sel';
    wrap.dataset.colIdx = colIdx;
    wrap.dataset.value  = selectedValue;

    const getLabel = v => (FIELD_OPTIONS.find(o => o.value === v) || {}).label || '— Campo extra —';

    // Trigger (shows current selection)
    const trigger = document.createElement('div');
    trigger.className = 'cm-sel__trigger';
    trigger.innerHTML = `<span class="cm-sel__label">${esc(getLabel(selectedValue))}</span><span class="cm-sel__arrow">▾</span>`;

    // Search input
    const input = document.createElement('input');
    input.className  = 'cm-sel__search hidden';
    input.type       = 'text';
    input.placeholder= 'Buscar campo…';
    input.autocomplete = 'off';

    // Dropdown list
    const list = document.createElement('div');
    list.className = 'cm-sel__list hidden';

    function renderList(q = '') {
      list.innerHTML = '';
      const query = q.toLowerCase().trim();
      let lastGroup = null;
      FIELD_OPTIONS.forEach(opt => {
        const matchLabel = opt.label.toLowerCase().includes(query);
        const matchVal   = opt.value.toLowerCase().includes(query);
        if (query && !matchLabel && !matchVal) return;
        if (opt.group && opt.group !== lastGroup) {
          const g = document.createElement('div');
          g.className   = 'cm-sel__group';
          g.textContent = opt.group;
          list.appendChild(g);
          lastGroup = opt.group;
        }
        const item = document.createElement('div');
        item.className    = 'cm-sel__item' + (opt.value === wrap.dataset.value ? ' cm-sel__item--active' : '');
        item.textContent  = opt.label;
        item.dataset.value = opt.value;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          wrap.dataset.value   = opt.value;
          trigger.querySelector('.cm-sel__label').textContent = opt.label;
          // Update active state
          list.querySelectorAll('.cm-sel__item').forEach(el => el.classList.toggle('cm-sel__item--active', el.dataset.value === opt.value));
          close();
        });
        list.appendChild(item);
      });
      if (!list.children.length) {
        list.innerHTML = '<div style="padding:8px 12px;font-size:.75rem;color:var(--muted)">Sin resultados</div>';
      }
    }

    function open() {
      renderList('');
      trigger.classList.add('hidden');
      input.classList.remove('hidden');
      list.classList.remove('hidden');
      input.value = '';
      input.focus();

      // Smart positioning: open toward the side with MORE space
      requestAnimationFrame(() => {
        const rect       = wrap.getBoundingClientRect();
        const LIST_H     = 200; // max-height of dropdown
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        // Open upward only when there's MORE space above than below
        if (spaceAbove > spaceBelow && spaceBelow < LIST_H) {
          list.classList.add('cm-sel__list--up');
        } else {
          list.classList.remove('cm-sel__list--up');
        }
      });
    }
    function close() {
      list.classList.add('hidden');
      list.classList.remove('cm-sel__list--up');
      input.classList.add('hidden');
      trigger.classList.remove('hidden');
    }

    trigger.addEventListener('click', open);
    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('blur', () => setTimeout(close, 160));
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        const first = list.querySelector('.cm-sel__item');
        if (first) first.dispatchEvent(new MouseEvent('mousedown'));
      }
    });

    wrap.appendChild(trigger);
    wrap.appendChild(input);
    wrap.appendChild(list);
    return wrap;
  }

  // Store raw file data for toggling header mode
  let _rawFileHeaders = [];
  let _rawFileSamples = [];

  function renderMappingPanel(headers, suggestions, sampleRows = [], hasHeader = true) {
    const panel = _getMappingContainer();
    panel.innerHTML = '';

    // Header + toggle
    panel.insertAdjacentHTML('beforeend', `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div class="col-map-panel__title" style="margin-bottom:0">🗂 Asigna las columnas</div>
        <label class="col-map-header-toggle" title="Si tu archivo no tiene una fila de títulos, desactiva esto">
          <input type="checkbox" id="toggleHasHeader" ${hasHeader ? 'checked' : ''}/>
          <span>Primera fila = encabezado</span>
        </label>
      </div>
      <div class="col-map-panel__hint">
        Detectado automáticamente — ajusta si alguno está mal.
        <strong>Campo extra</strong> = se conserva. <strong>✕ Ignorar</strong> = se descarta.
      </div>
    `);

    // Table-style layout for clarity
    const table = document.createElement('div');
    table.className = 'col-map-table';
    table.innerHTML = `
      <div class="col-map-table__head">
        <span>Columna del archivo</span>
        <span>Ejemplo de datos</span>
        <span>Asignar como</span>
      </div>`;
    panel.appendChild(table);

    headers.forEach((h, idx) => {
      // Get sample values for this column
      const sampleVals = sampleRows.map(row => row[idx] || '').filter(Boolean);
      const suggested  = suggestions[idx] || guessField(h, sampleVals) || '';

      const row = document.createElement('div');
      row.className = 'col-map-table__row';

      // Column name
      const nameCell = document.createElement('div');
      nameCell.className = 'col-map-col-name';
      nameCell.title = h;
      nameCell.textContent = h || `columna ${idx + 1}`;

      // Sample data — show first 3 values as chips
      const sampleCell = document.createElement('div');
      sampleCell.className = 'col-map-sample';
      const top3 = sampleVals.slice(0, 2);
      sampleCell.innerHTML = top3.length
        ? top3.map(v => `<span class="col-map-sample-chip">${esc(v.length > 16 ? v.slice(0,14)+'…' : v)}</span>`).join('')
        : '<span style="color:var(--muted);font-style:italic;font-size:.72rem">sin datos</span>';
      sampleCell.title = sampleVals.join(' · ');

      // Searchable custom select
      const sel = _buildSearchableSelect(idx, suggested);

      // Visual cue: highlight auto-detected key fields
      if (['firstname','lastname','company','linkedinurl'].includes(suggested)) {
        row.classList.add('col-map-table__row--detected');
      }

      row.appendChild(nameCell);
      row.appendChild(sampleCell);
      row.appendChild(sel);
      table.appendChild(row);
    });

    // ── "Primera fila = encabezado" toggle ────────────────────
    panel.querySelector('#toggleHasHeader')?.addEventListener('change', function() {
      if (this.checked) {
        // Treat row 0 as header again
        renderMappingPanel(_rawFileHeaders, {}, _rawFileSamples, true);
      } else {
        // Row 0 is data — generate column names, include row 0 in samples
        const genHeaders = _rawFileHeaders.map((_, i) => `Columna ${i + 1}`);
        const samplesWithRow0 = [_rawFileHeaders, ..._rawFileSamples];
        renderMappingPanel(genHeaders, {}, samplesWithRow0, false);
      }
    });
  }

  async function setFile(f) {
    uploadedFile = f;
    $('fileLabel').textContent = `📎 ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;

    $('btnBatch').disabled = true;
    hideAlert($('batchErr'));
    hideAlert($('batchWarn'));
    _showMappingLoading();

    const isCsv = /\.(csv|tsv|txt)$/i.test(f.name);

    try {
      if (isCsv) {
        // For CSV: read headers client-side (no sample rows from server)
        const { headers, sampleRows: csvSamples } = await readCsvHeaders(f);
        if (headers.length > 0) {
          _rawFileHeaders = headers;
          _rawFileSamples = csvSamples;
          renderMappingPanel(headers, {}, csvSamples, true);
        } else {
          _showMappingError('No se encontraron columnas en la primera fila del archivo.');
        }
      } else {
        // Excel: call server to get headers + suggestions + sample rows
        const fd = new FormData();
        fd.append('file', f);
        const res = await apiFetch(`${API}/enrich/parse-headers`, { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          if (data.headers && data.headers.length > 0) {
            // Store raw data for header toggle
            _rawFileHeaders = data.headers;
            _rawFileSamples = data.sampleRows || [];
            renderMappingPanel(data.headers, data.suggestions || {}, data.sampleRows || [], true);
          } else {
            _showMappingError('El archivo no tiene encabezados.');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          _showMappingError(`Error del servidor (${res.status}): ${err.error || 'desconocido'}`);
        }
      }
    } catch (e) {
      _showMappingError('Error leyendo el archivo: ' + e.message);
    } finally {
      $('btnBatch').disabled = false;
    }
  }

  function _getMappingContainer() {
    let panel = $('colMapPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'colMapPanel';
      panel.className = 'col-map-panel';
      const fileInput = $('fileInput');
      if (fileInput && fileInput.parentNode) {
        fileInput.parentNode.insertBefore(panel, fileInput.nextSibling);
      } else {
        document.querySelector('#pane-batch .card--lift')?.appendChild(panel);
      }
    }
    panel.style.display = 'block';
    panel.classList.remove('hidden');
    return panel;
  }

  function _showMappingLoading() {
    const panel = _getMappingContainer();
    panel.innerHTML = '<div class="col-map-panel__title">🗂 Detectando columnas…</div>';
  }

  function _showMappingError(msg) {
    const panel = _getMappingContainer();
    panel.innerHTML = `<div class="col-map-panel__title">⚠️ ${esc(msg)}</div>
      <div class="col-map-panel__hint">Puedes continuar y el sistema intentará detectar las columnas automáticamente.</div>`;
  }

  /** Read the current state of the mapping panel → { colIndex: fieldName } */
  function getColumnMapping() {
    const mapping = {};
    // Read from new custom searchable selects
    document.querySelectorAll('.cm-sel').forEach(sel => {
      const v = sel.dataset.value;
      if (v) mapping[sel.dataset.colIdx] = v;
    });
    // Fallback: legacy native selects
    document.querySelectorAll('.col-map-select').forEach(sel => {
      if (sel.value && !mapping[sel.dataset.colIdx]) mapping[sel.dataset.colIdx] = sel.value;
    });
    return mapping;
  }

  // ── Mode selector ─────────────────────────────────────────────
  let _batchMode = 'discovery'; // default: discovery (no SES)

  function _updateModeBtn() {
    const btnLabel = $('btnBatch')?.querySelector('.btn__text');
    if (_batchMode === 'discovery') {
      if (btnLabel) btnLabel.textContent = '🔍 Descubrir emails';
    } else {
      if (btnLabel) btnLabel.textContent = '🎯 Verificar emails';
    }
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _batchMode = btn.dataset.mode;
      _updateModeBtn();
    });
  });

  $('btnBatch').addEventListener('click', () => runBatch());
  // Hide preview button if it still exists in old HTML
  $('btnBatchPreview')?.style && ($('btnBatchPreview').style.display = 'none');

  // ── Job banner helpers ─────────────────────────────────────────
  function _setBanner(html, cls = '') {
    const b = $('batchJobBanner');
    if (!b) return;
    b.innerHTML = html;
    b.className = cls;
    b.classList.remove('hidden');
  }
  function _hideBanner() {
    const b = $('batchJobBanner');
    if (b) { b.classList.add('hidden'); b.innerHTML = ''; }
  }

  // ── Poll a running/done job ────────────────────────────────────
  let _activePollTimer = null;
  function _startPolling(jobId, count) {
    if (_activePollTimer) clearInterval(_activePollTimer);

    const prog  = $('batchProgress');
    const fill  = $('batchFill');
    const label = $('batchLabel');
    if (prog) prog.classList.add('show');
    if (fill)  fill.style.width = '5%';
    if (label) label.textContent = `⏳ Procesando ${count ?? '…'} leads en segundo plano…`;

    _setBanner(
      `<div class="alert alert--warn" style="margin:0">⏳ Enriquecimiento en curso — puedes cerrar esta pestaña y volver más tarde.</div>`
    );

    let dots = 0;
    _activePollTimer = setInterval(async () => {
      try {
        const pollRes = await apiFetch(`${API}/enrich/job/${jobId}`);
        if (!pollRes.ok) { clearInterval(_activePollTimer); return; }
        const pollData = await pollRes.json();

        dots = (dots + 1) % 4;
        if (label) label.textContent = `⏳ Procesando${'.'.repeat(dots + 1)}`;
        if (fill)  fill.style.width = pollData.status === 'done'
          ? '100%'
          : `${Math.min(90, parseInt(fill.style.width || '5') + 3)}%`;

        if (pollData.status === 'done') {
          clearInterval(_activePollTimer);
          _activePollTimer = null;
          localStorage.removeItem('enricher_jobId');

          if (fill)  fill.style.width = '100%';
          if (label) label.textContent = '✅ ¡Listo!';
          setTimeout(() => { prog?.classList.remove('show'); if (fill) fill.style.width = '0%'; }, 1500);

          batchResults = pollData.results || [];
          filteredRows = [...batchResults];
          currentPage  = 1;

          if (pollData.warnings?.length) showAlert($('batchWarn'), pollData.warnings.join(' · '), 'warn');

          renderPreviewTable();
          $('batchPreview')?.classList.remove('hidden');
          $('batchPreview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

          // Silently repair any verifications records missing _rawColumns
          _repairLeadData(batchResults);

          // Wire download button to job xlsx
          _wireDownloadBtn(jobId, batchResults.length);
          _setBanner(
            `<div class="alert alert--ok" style="margin:0">✅ ${batchResults.length} leads enriquecidos. <a href="#" id="bannerDlLink" style="font-weight:700;color:var(--brand)">⬇ Descargar Excel</a></div>`
          );
          document.getElementById('bannerDlLink')?.addEventListener('click', e => {
            e.preventDefault(); _downloadJobXlsx(jobId);
          });

          setBtn($('btnBatch'), false);

        } else if (pollData.status === 'error') {
          clearInterval(_activePollTimer);
          _activePollTimer = null;
          localStorage.removeItem('enricher_jobId');
          showAlert($('batchErr'), `Error en el trabajo: ${pollData.error || 'desconocido'}`);
          _hideBanner();
          if (prog) prog.classList.remove('show');
          setBtn($('btnBatch'), false);
        }
      } catch (pollErr) {
        clearInterval(_activePollTimer);
        _activePollTimer = null;
        showAlert($('batchErr'), `Error al consultar estado: ${pollErr.message}`);
        _hideBanner();
        setBtn($('btnBatch'), false);
      }
    }, 4000);
  }

  function _wireDownloadBtn(jobId, total) {
    const dlBtn = $('btnDownloadResult');
    if (!dlBtn) return;
    dlBtn.onclick = e => { e.preventDefault(); _downloadJobXlsx(jobId); };
  }

  async function _downloadJobXlsx(jobId) {
    try {
      const xlsRes = await apiFetch(`${API}/enrich/job/${jobId}?format=xlsx`);
      if (xlsRes.ok) {
        const buf = await xlsRes.arrayBuffer();
        lastXlsBuffer = buf;
        downloadBuffer(buf, `enriched_${Date.now()}.xlsx`);
      }
    } catch(e) { alert('No se pudo descargar: ' + e.message); }
  }

  // ── On batch-tab activate: check for persisted job ─────────────
  function _checkPersistedJob() {
    try {
      const raw = localStorage.getItem('enricher_jobId');
      if (!raw) return;
      const { jobId, count, ts } = JSON.parse(raw);

      // Jobs older than 2 hours: clear silently (server already marked as error)
      if (Date.now() - ts > 2 * 60 * 60 * 1000) {
        localStorage.removeItem('enricher_jobId');
        _setBanner(`<div class="alert alert--err" style="margin:0">⚠️ El procesamiento anterior expiró (el servidor se reinició). Vuelve a subir el archivo.</div>`);
        return;
      }

      // Quick status check before resuming poll
      apiFetch(`${API}/enrich/job/${jobId}`).then(async r => {
        if (!r.ok) { localStorage.removeItem('enricher_jobId'); return; }
        const d = await r.json();

        if (d.status === 'done') {
          localStorage.removeItem('enricher_jobId');
          batchResults = d.results || [];
          filteredRows = [...batchResults];
          currentPage  = 1;
          renderPreviewTable();
          $('batchPreview')?.classList.remove('hidden');
          _wireDownloadBtn(jobId, batchResults.length);
          _repairLeadData(batchResults);
          _setBanner(
            `<div class="alert alert--ok" style="margin:0">✅ ${batchResults.length} leads enriquecidos. <a href="#" id="bannerDlLink" style="font-weight:700;color:var(--brand)">⬇ Descargar Excel</a></div>`
          );
          document.getElementById('bannerDlLink')?.addEventListener('click', e => {
            e.preventDefault(); _downloadJobXlsx(jobId);
          });

        } else if (d.status === 'running') {
          _startPolling(jobId, count);

        } else if (d.status === 'error') {
          // Server restarted mid-job or other failure
          localStorage.removeItem('enricher_jobId');
          _setBanner(`<div class="alert alert--err" style="margin:0">⚠️ ${d.error || 'El procesamiento falló. Vuelve a subir el archivo.'}</div>`);

        } else {
          localStorage.removeItem('enricher_jobId');
        }
      }).catch(() => { localStorage.removeItem('enricher_jobId'); });
    } catch(e) { /* ignore parse errors */ }
  }

  // ── Main runBatch: always async background ─────────────────────
  async function runBatch() {
    if (!uploadedFile) return;

    setBtn($('btnBatch'), true);
    hideAlert($('batchErr'));
    hideAlert($('batchWarn'));
    $('batchPreview')?.classList.add('hidden');
    _hideBanner();

    const prog  = $('batchProgress');
    const fill  = $('batchFill');
    const label = $('batchLabel');
    if (prog)  prog.classList.add('show');
    if (fill)  fill.style.width = '0%';
    if (label) label.textContent = 'Subiendo archivo…';

    const formData = new FormData();
    formData.append('file', uploadedFile);
    formData.append('batchMode', _batchMode); // 'discovery' | 'verify'
    const batchTag = ($('b_tag')?.value || '').trim();
    if (batchTag) formData.append('tag', batchTag);
    const mapping = getColumnMapping();
    if (Object.keys(mapping).length) formData.append('mapping', JSON.stringify(mapping));

    try {
      const startRes = await apiFetch(`${API}/enrich/upload-async`, { method: 'POST', body: formData });
      if (startRes.status === 401) { location.reload(); return; }
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({ error: `HTTP ${startRes.status}` }));
        throw new Error(err.error || `HTTP ${startRes.status}`);
      }
      const { jobId, count } = await startRes.json();

      // Persist so user can close laptop and come back
      localStorage.setItem('enricher_jobId', JSON.stringify({ jobId, count, ts: Date.now() }));

      _startPolling(jobId, count);
      // _startPolling re-enables btnBatch when done; return here to skip finally re-enable
      return;

    } catch (err) {
      showAlert($('batchErr'), `Error: ${err.message}`);
      if (prog) prog.classList.remove('show');
      setBtn($('btnBatch'), false);
    }
  }

  function downloadBuffer(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  $('btnDownloadResult').addEventListener('click', () => {
    if (lastXlsBuffer) downloadBuffer(lastXlsBuffer, `enriched_${Date.now()}.xlsx`);
  });

  // ── Silently repair verifications records missing _rawColumns ──
  function _repairLeadData(results) {
    const toRepair = results.filter(r => r.bestEmail && (r._rawColumns || r._extra));
    if (!toRepair.length) return;
    apiFetch(`${API}/enrich/repair-lead-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: toRepair }),
    }).then(r => r.json()).then(d => {
      if (d.updated > 0) console.log(`[repair] updated ${d.updated} verifications with _rawColumns`);
    }).catch(() => {});
  }

  $('searchBox').addEventListener('input', () => {
    const q = $('searchBox').value.toLowerCase();
    filteredRows = q
      ? batchResults.filter(r =>
          `${r.firstName} ${r.lastName} ${r.domain} ${r.company}`.toLowerCase().includes(q))
      : [...batchResults];
    currentPage = 1;
    renderPreviewTable();
  });

  // ── Render batch preview table ─────────────────────────────────
  function renderPreviewTable() {
    const total    = filteredRows.length;
    const pages    = Math.ceil(total / PAGE_SIZE);
    const start    = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filteredRows.slice(start, start + PAGE_SIZE);

    const counts = { verified: 0, probable: 0, low: 0, none: 0 };
    batchResults.forEach(r => {
      const c = r.confidence || 'none';
      if      (c === 'guaranteed' || c === 'very-high') counts.verified++;
      else if (c === 'high' || c === 'medium')          counts.probable++;
      else if (c === 'low' || c === 'pending')          counts.low++;
      else                                              counts.none++;
    });

    $('batchStats').innerHTML = `
      <div class="stat stat--ok">  <span class="num">${counts.verified}</span> Verificados</div>
      <div class="stat stat--warn"><span class="num">${counts.probable}</span> Probables</div>
      <div class="stat stat--err"> <span class="num">${counts.low}</span>      Baja certeza</div>
      <div class="stat stat--muted"><span class="num">${counts.none}</span>    Sin datos</div>
      <div class="stat" style="margin-left:auto"><span class="num">${batchResults.length}</span> Total</div>
    `;

    $('previewTitle').textContent =
      `Results: ${total} leads${total !== batchResults.length ? ` (filtered from ${batchResults.length})` : ''}`;

    const tbody = $('previewBody');
    tbody.innerHTML = '';

    pageRows.forEach((r, i) => {
      const bestEmail  = r.bestEmail || r.candidates?.[0]?.email || null;
      const confidence = r.confidence || r.candidates?.[0]?.confidence || 'none';
      const bestScore  = r.bestScore  ?? r.candidates?.[0]?.score ?? 0;
      const catchAll   = r.isCatchAll;
      const globalI    = start + i;

      const emailCell = bestEmail
        ? `<span class="mono" style="font-weight:700">${esc(bestEmail)}</span>${catchAll ? ' ' + catchAllWarn() : ''}`
        : '<span style="color:var(--muted)">—</span>';

      const tr = document.createElement('tr');
      tr.id = `row-${globalI}`;
      tr.innerHTML = `
        <td>${start + i + 1}</td>
        <td>
          <div class="tbl__name">${esc(r.firstName)} ${esc(r.lastName)}</div>
          <div class="tbl__co">${esc(r.company)}</div>
        </td>
        <td><span class="mono">${esc(r.domain || '—')}</span></td>
        <td>${r.mxFound ? '<span class="mx-ok">✓</span>' : '<span class="mx-no">✗</span>'}</td>
        <td>${emailCell}</td>
        <td>${confBadge(confidence)}</td>
        <td>${bestEmail ? renderScoreBar(bestScore) : '—'}</td>
        <td>${r.candidates?.length ?? 0}</td>
        <td>
          ${(r.candidates?.length ?? 0) > 1
            ? `<button class="expand-btn" data-idx="${globalI}">▾ More</button>`
            : ''}
        </td>
      `;
      tbody.appendChild(tr);

      if ((r.candidates?.length ?? 0) > 1) {
        const expandRow = document.createElement('tr');
        expandRow.id = `expand-${globalI}`;
        expandRow.className = 'candidates-row hidden';
        expandRow.innerHTML = `<td colspan="9">
          <div class="candidates-inner">
            ${r.candidates.slice(1).map(c => `
              <div class="cand-card">
                <div class="cand-card__email">${esc(c.email)}</div>
                <div class="cand-card__meta">
                  <span>Pattern: <strong>${esc(c.pattern)}</strong></span>
                  <span>Score: <strong style="color:${scoreColor(c.score)}">${c.score}</strong></span>
                  ${confBadge(c.confidence)}
                </div>
              </div>`).join('')}
          </div>
        </td>`;
        tbody.appendChild(expandRow);
      }
    });

    tbody.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx  = btn.dataset.idx;
        const exp  = $(`expand-${idx}`);
        const open = !exp.classList.contains('hidden');
        exp.classList.toggle('hidden', open);
        btn.textContent = open ? '▾ More' : '▴ Less';
      });
    });

    renderPagination(pages);
  }

  function renderPagination(pages) {
    const pag = $('pagination');
    pag.innerHTML = '';
    if (pages <= 1) return;

    const prev = document.createElement('button');
    prev.className   = 'page-btn';
    prev.textContent = '←';
    prev.disabled    = currentPage === 1;
    prev.addEventListener('click', () => { currentPage--; renderPreviewTable(); });
    pag.appendChild(prev);

    const rangeStart = Math.max(1, currentPage - 2);
    const rangeEnd   = Math.min(pages, rangeStart + 4);
    for (let p = rangeStart; p <= rangeEnd; p++) {
      const btn = document.createElement('button');
      btn.className   = `page-btn${p === currentPage ? ' active' : ''}`;
      btn.textContent = p;
      btn.addEventListener('click', () => { currentPage = p; renderPreviewTable(); });
      pag.appendChild(btn);
    }

    const info = document.createElement('span');
    info.className   = 'page-info';
    info.textContent = `${currentPage} / ${pages}`;
    pag.appendChild(info);

    const next = document.createElement('button');
    next.className   = 'page-btn';
    next.textContent = '→';
    next.disabled    = currentPage === pages;
    next.addEventListener('click', () => { currentPage++; renderPreviewTable(); });
    pag.appendChild(next);
  }


  // ═══════════════════════════════════════════════════════════════
  // MIS VERIFICACIONES
  // ═══════════════════════════════════════════════════════════════

  async function loadVerifications(filters = {}) {
    // Accept both old string (tag only) and new object {tag, from, to}
    if (typeof filters === 'string') filters = { tag: filters };
    const body    = $('verifBody');
    const errEl   = $('verifErr');
    const btn     = $('btnRefreshVerif');

    hideAlert(errEl);
    setBtn(btn, true);
    body.innerHTML = '<div class="verif-empty">Cargando…</div>';

    try {
      const qs  = _filtersToQS(filters);
      const url = `${API}/user/verifications${qs}`;
      const res  = await apiFetch(url);
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const rows = data.verifications || [];

      if (rows.length === 0) {
        const hasFilters = filters.tag || filters.from || filters.to;
        const emptyMsg = hasFilters
          ? `No hay verificaciones con los filtros aplicados.`
          : 'No tienes verificaciones aún.';
        body.innerHTML = `<div class="verif-empty">${emptyMsg}</div>`;
        return;
      }

      const statusMeta = {
        pending:  { icon: '🟡', label: 'Verificando…', cls: 'vstatus--pending'  },
        verified: { icon: '🟢', label: 'Verificado',   cls: 'vstatus--verified' },
        bounced:  { icon: '🔴', label: 'Rebote',       cls: 'vstatus--bounced'  },
        error:    { icon: '⛔', label: 'Error de envío', cls: 'vstatus--error'  },
      };

      // Only 'error' rows are retryable — pending = still being verified normally
      const errorCount = rows.filter(r => r.status === 'error').length;


      // Build column headers: use the record with the MOST _rawColumns entries
      // as the template (most complete = most likely from latest upload).
      const colHeaderSet = new Set();
      const colHeaders   = [];

      const rowsWithRaw = rows.filter(r =>
        Array.isArray(r.leadData?._rawColumns) && r.leadData._rawColumns.length > 0
      );

      if (rowsWithRaw.length > 0) {
        // Pick the record with the most columns
        const templateRow = rowsWithRaw.reduce((best, r) =>
          r.leadData._rawColumns.length > best.leadData._rawColumns.length ? r : best
        );
        templateRow.leadData._rawColumns.forEach(({ header }) => {
          if (header && !colHeaderSet.has(header)) { colHeaderSet.add(header); colHeaders.push(header); }
        });
      } else {
        // Fallback: no _rawColumns — use _extra keys
        rows.forEach(r => {
          Object.keys(r.leadData?._extra || {}).forEach(k => {
            if (!colHeaderSet.has(k)) { colHeaderSet.add(k); colHeaders.push(k); }
          });
        });
      }

      const rowsHtml = rows.map((r, idx) => {
        const isCatchAll_     = !!(r.leadData?.isCatchAll);
        const verifiedByReoon = !!(r.leadData?.verifiedByReoon);

        // Status + confidence combined
        let s, confidenceBadge;

        if (isCatchAll_) {
          s = { icon: '⚠️', label: 'Acepta todo · 0%', cls: 'vstatus--catchall' };
          confidenceBadge = '';
        } else if (r.status === 'verified') {
          if (verifiedByReoon) {
            s = { icon: '🎯', label: 'Verificado · ~90%', cls: 'vstatus--reoon' };
            confidenceBadge = '';
          } else {
            s = { icon: '✉️', label: 'Verificado · ~65%', cls: 'vstatus--ses' };
            confidenceBadge = '';
          }
        } else {
          s = statusMeta[r.status] ?? { icon: '⚪', label: r.status, cls: '' };
          confidenceBadge = '';
        }

        const date = r.createdAt
          ? new Date(r.createdAt).toLocaleString('es-AR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })
          : '—';

        const ld        = r.leadData || {};
        const extra     = ld._extra || {};
        const canRetry  = r.status === 'error';

        const emailCell = r.status === 'pending'
          ? `<span class="mono verif-email--pending" title="Verificación en curso…">${esc(r.email)}</span>`
          : `<span class="mono">${esc(r.email)}</span>`;

        const catchAllBadge = isCatchAll_
          ? `<span class="badge badge--catchall" title="Acepta cualquier email">⚠️ Sí</span>`
          : '';

        // ── Frozen columns (always visible, don't scroll) ──────────
        const frozenCells = `
          <td class="vt-frozen vt-frozen--cb verif-cb-cell">
            <input type="checkbox" class="verif-cb" data-vid="${esc(r.bounceVerifyId)}"
              data-status="${esc(r.status)}"/>
          </td>
          <td class="vt-frozen vt-frozen--status">
            <span class="badge ${esc(s.cls)}">${s.icon} ${s.label}</span>
            ${confidenceBadge}
            ${catchAllBadge}
          </td>
          <td class="vt-frozen vt-frozen--email">${emailCell}</td>`;

        // ── Scrollable columns — exact original file order ─────────
        // Use _rawColumns if available (preserves original order),
        // otherwise fall back to colHeaders derived from _extra.
        const rawCols = Array.isArray(ld._rawColumns) ? ld._rawColumns : null;
        const rawMap  = rawCols
          ? Object.fromEntries(rawCols.map(c => [c.header, c.value]))
          : {};

        const dataCells = colHeaders.map(h => {
          const val = rawMap[h] ?? (ld._extra?.[h] ?? '');
          return `<td class="vt-scroll" title="${esc(val)}">${esc(val)}</td>`;
        }).join('');

        const scrollCells = `
          ${dataCells}
          <td class="vt-scroll" style="white-space:nowrap;font-size:.75rem;color:var(--muted)">${date}</td>
          <td class="vt-scroll">${r.tag ? `<span class="verif-tag">${esc(r.tag)}</span>` : ''}</td>`;

        return `<tr class="${canRetry ? 'verif-row--retryable' : ''}" data-vid="${esc(r.bounceVerifyId)}" data-retryable="${canRetry}">
          ${frozenCells}${scrollCells}
        </tr>`;
      }).join('');

      const filterPills = [
        filters.tag  ? `<span class="vf-pill">🏷 ${esc(filters.tag)}</span>`  : '',
        filters.from ? `<span class="vf-pill">📅 Desde ${esc(filters.from)}</span>` : '',
        filters.to   ? `<span class="vf-pill">📅 Hasta ${esc(filters.to)}</span>`   : '',
      ].filter(Boolean).join('');
      const filterNote = filterPills
        ? `<span style="display:flex;gap:4px;flex-wrap:wrap">${filterPills}</span>` : '';

      // Floating action bar — appears when any row is selected
      const retryBarHtml = `
        <div class="verif-retry-bar hidden" id="verifRetryBar">
          <span class="verif-retry-bar__count" id="retryCount">0 seleccionadas</span>
          <button class="btn btn--green btn--sm"   id="btnExportSelected">⬇ Exportar seleccionadas</button>
          <button class="btn btn--primary btn--sm" id="btnRetrySelected">⟳ Revivir errores</button>
          <button class="btn btn--danger btn--sm"  id="btnDismissSelected">✕ Descartar seleccionadas</button>
          <button class="btn btn--ghost btn--sm"   id="btnRetryClear">Cancelar</button>
        </div>`;

      // "Select all errors" quick action — only shown when there are error rows
      const selectPendingBtn = errorCount > 0
        ? `<button class="btn btn--outline btn--sm" id="btnSelectPending" style="margin-left:8px">
             ⛔ Seleccionar ${errorCount} con error${errorCount !== 1 ? 'es' : ''}
           </button>`
        : '';

      // Dynamic column headers — original file order
      const colHeadersHtml = colHeaders.map(h =>
        `<th class="vt-scroll vt-col-header">${esc(h)}</th>`
      ).join('');

      body.innerHTML = `
        ${retryBarHtml}
        <div class="verif-controls">
          <label style="display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--muted);cursor:pointer">
            <input type="checkbox" id="verifSelectAll"/> Seleccionar todas
          </label>
          ${selectPendingBtn}
          ${colHeaders.length > 0 ? `
            <div class="verif-col-search">
              <input type="text" id="verifColSearch" placeholder="🔍 Buscar columna…"
                style="padding:5px 10px;border:1.5px solid var(--border);border-radius:var(--rs);
                       font-size:.78rem;outline:none;width:160px"/>
            </div>` : ''}
        </div>
        <div class="vt-wrap">
          <table class="verif-table vt-table">
            <thead><tr>
              <th class="vt-frozen vt-frozen--cb" style="width:32px"></th>
              <th class="vt-frozen vt-frozen--status">Estado</th>
              <th class="vt-frozen vt-frozen--email">Email verificado</th>
              ${colHeadersHtml}
              <th class="vt-scroll">Fecha</th>
              <th class="vt-scroll">Etiqueta</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <p style="font-size:.75rem;color:var(--muted);margin-top:10px;text-align:right;display:flex;align-items:center;gap:8px;justify-content:flex-end">
          ${filterNote}
          <span class="verif-footer-count">${rows.length} verificación${rows.length !== 1 ? 'es' : ''}</span>
        </p>`;

      // ── Column search: highlight matching headers ─────────────────
      body.querySelector('#verifColSearch')?.addEventListener('input', function() {
        const q = this.value.toLowerCase().trim();
        body.querySelectorAll('.vt-col-header').forEach((th, colIdx) => {
          const match = !q || th.textContent.toLowerCase().includes(q);
          th.style.background = (match && q) ? '#fef3c7' : '';
          // Highlight corresponding body cells (col offset: 3 frozen cols + colIdx + 1)
          const nthChild = colIdx + 4;
          body.querySelectorAll(`.vt-table tbody tr td:nth-child(${nthChild})`).forEach(td => {
            td.style.background = (match && q) ? '#fefce8' : '';
          });
        });
        if (q) {
          const firstMatch = [...body.querySelectorAll('.vt-col-header')]
            .find(th => th.textContent.toLowerCase().includes(q));
          firstMatch?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      });

      // ── Checkbox + retry logic ────────────────────────────────────
      const retryBar       = body.querySelector('#verifRetryBar');
      const retryCountEl   = body.querySelector('#retryCount');
      const selectAllCb    = body.querySelector('#verifSelectAll');
      const selectPendingB = body.querySelector('#btnSelectPending');
      const btnRetry       = body.querySelector('#btnRetrySelected');
      const btnDismiss     = body.querySelector('#btnDismissSelected');
      const btnExportSel   = body.querySelector('#btnExportSelected');
      const btnRetryClear  = body.querySelector('#btnRetryClear');
      const allCbs         = () => [...body.querySelectorAll('.verif-cb')];

      function _updateRetryBar() {
        const checked     = allCbs().filter(c => c.checked);
        const errorCount  = checked.filter(c => c.dataset.status === 'error').length;
        if (checked.length > 0) {
          retryCountEl.textContent = `${checked.length} seleccionada${checked.length !== 1 ? 's' : ''}`;
          retryBar?.classList.remove('hidden');
          // Show retry/dismiss only when errors are selected
          if (btnRetry)   btnRetry.style.display   = errorCount > 0 ? '' : 'none';
          // Dismiss always visible when rows selected
        } else {
          retryBar?.classList.add('hidden');
          if (selectAllCb) selectAllCb.checked = false;
        }
      }

      body.querySelectorAll('.verif-cb').forEach(cb => {
        cb.addEventListener('change', _updateRetryBar);
      });

      selectAllCb?.addEventListener('change', () => {
        allCbs().forEach(cb => { cb.checked = selectAllCb.checked; });
        _updateRetryBar();
      });

      selectPendingB?.addEventListener('click', () => {
        // Select all error rows only
        allCbs().forEach(cb => { cb.checked = cb.dataset.status === 'error'; });
        _updateRetryBar();
      });

      btnExportSel?.addEventListener('click', async () => {
        const checked = allCbs().filter(c => c.checked);
        if (!checked.length) return;
        // Build a mini CSV from the visible row data
        const vids = new Set(checked.map(c => c.dataset.vid));
        // Find verif data from rows array (stored in closure)
        const selected = rows.filter(r => vids.has(r.bounceVerifyId));
        // Use same export endpoint but with IDs filter — simplest: client-side CSV
        const colHeadersAll = colHeaders.length ? ['emailVerificado','estado','etiqueta','fecha',...colHeaders] : ['emailVerificado','estado','etiqueta','fecha'];
        const csvEscCl = v => { const s = String(v??''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
        const lines = [colHeadersAll.join(',')];
        selected.forEach(r => {
          const ld = r.leadData || {};
          const rawMap = {};
          if (Array.isArray(ld._rawColumns)) ld._rawColumns.forEach(({header,value}) => { rawMap[header]=value; });
          else Object.assign(rawMap, ld._extra || {});
          const fixed = [
            csvEscCl(r.email), csvEscCl(r.status), csvEscCl(r.tag||''),
            csvEscCl(r.createdAt ? new Date(r.createdAt).toLocaleDateString('es') : ''),
          ];
          const extras = colHeaders.map(h => csvEscCl(rawMap[h] ?? ''));
          lines.push([...fixed, ...extras].join(','));
        });
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `seleccion_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(a.href);
      });

      btnRetryClear?.addEventListener('click', () => {
        allCbs().forEach(cb => { cb.checked = false; });
        if (selectAllCb) selectAllCb.checked = false;
        retryBar?.classList.add('hidden');
      });

      btnRetry?.addEventListener('click', async () => {
        const checked = allCbs().filter(c => c.checked);
        if (!checked.length) return;
        const verifyIds = checked.map(c => c.dataset.vid);

        btnRetry.disabled = true;
        btnRetry.textContent = `Enviando…`;

        try {
          const res = await apiFetch(`${API}/user/verifications/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ verifyIds }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

          // Flash success, then reload
          retryBar.innerHTML = `<span style="color:#16a34a;font-weight:600">
            ✅ ${data.sent} email${data.sent !== 1 ? 's' : ''} re-enviados${data.failed ? ` · ${data.failed} fallaron` : ''} — recargando…
          </span>`;
          setTimeout(() => loadVerifications(filters), 1800);

        } catch (err) {
          btnRetry.disabled = false;
          btnRetry.textContent = '⟳ Revivir y re-enviar';
          showAlert(errEl, `Error al re-verificar: ${err.message}`);
        }
      });

      btnDismiss?.addEventListener('click', async () => {
        const checked = allCbs().filter(c => c.checked);
        if (!checked.length) return;

        // Confirmation dialog
        const confirmed = confirm(
          `⚠️ ¿Confirmas descartar ${checked.length} verificación${checked.length !== 1 ? 'es' : ''}?\n\nEsta acción las eliminará del dashboard. No se puede deshacer.`
        );
        if (!confirmed) return;

        const verifyIds = checked.map(c => c.dataset.vid);

        btnDismiss.disabled = true;
        btnDismiss.textContent = 'Descartando…';

        try {
          const res = await apiFetch(`${API}/user/verifications/dismiss`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ verifyIds }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

          // Remove dismissed rows from DOM immediately — no need to reload
          checked.forEach(cb => {
            const tr = cb.closest('tr');
            // Also remove the extra-fields row if it exists
            const nextTr = tr?.nextElementSibling;
            if (nextTr?.classList.contains('hidden') && nextTr.id?.startsWith('verif-extra-')) {
              nextTr.remove();
            }
            tr?.remove();
          });

          retryBar?.classList.add('hidden');
          if (selectAllCb) selectAllCb.checked = false;

          // Update the counter at the bottom
          const remaining = body.querySelectorAll('.verif-cb').length;
          body.querySelector('.verif-footer-count') &&
            (body.querySelector('.verif-footer-count').textContent = `${remaining} verificación${remaining !== 1 ? 'es' : ''}`);

        } catch (err) {
          btnDismiss.disabled = false;
          btnDismiss.textContent = '✕ Descartar';
          showAlert(errEl, `Error al descartar: ${err.message}`);
        }
      });

    } catch (err) {
      showAlert(errEl, `Error al cargar verificaciones: ${err.message}`);
      body.innerHTML = '';
    } finally {
      setBtn(btn, false);
    }
  }

  // Populate the datalist with the user's existing tags
  async function loadTagSuggestions() {
    try {
      const res  = await apiFetch(`${API}/user/verifications/tags`);
      if (!res.ok) return;
      const data = await res.json();
      const tags = data.tags || [];
      // Populate <select> dropdown
      const sel = $('filterTag');
      if (sel) {
        const current = sel.value;
        sel.innerHTML = `<option value="">Todas las etiquetas</option>` +
          tags.map(t => `<option value="${esc(t)}"${t === current ? ' selected' : ''}>${esc(t)}</option>`).join('');
      }
    } catch (_) { /* non-critical */ }
  }

  // _verifLoaded declared at top of initApp, tab switching handled by _switchTab

  // ── Filter state ──────────────────────────────────────────────
  let _activeFilters = { tag: '', from: '', to: '', status: '' };

  function _filtersToQS(f) {
    const p = new URLSearchParams();
    if (f.tag)    p.set('tag',    f.tag);
    if (f.from)   p.set('from',   f.from);
    if (f.to)     p.set('to',     f.to);
    if (f.status) p.set('status', f.status);
    const qs = p.toString();
    return qs ? '?' + qs : '';
  }

  function _countActiveFilters(f) {
    return [f.tag, f.from || f.to, f.status].filter(Boolean).length;
  }

  function _updateFilterBadge() {
    const n = _countActiveFilters(_activeFilters);
    const badge = $('filterBadge');
    if (!badge) return;
    if (n > 0) { badge.textContent = n; badge.classList.remove('hidden'); }
    else        { badge.classList.add('hidden'); }
  }

  function _updateActivePills() {
    const container = $('activeFilterPills');
    if (!container) return;
    const f = _activeFilters;
    const pills = [];
    const statusLabels = {
      'reoon':     '🎯 Verificado ~90%',
      'ses':       '✉️ Verificado ~65%',
      'pending':   '🟡 Verificando…',
      'catch-all': '⚠️ Acepta todo · 0%',
      'bounced':   '🔴 Rebote',
      'error':     '⛔ Con error',
    };
    if (f.status) pills.push(`<span class="vf-pill">${statusLabels[f.status] || f.status}</span>`);
    if (f.tag)    pills.push(`<span class="vf-pill">🏷 ${esc(f.tag)}</span>`);
    if (f.from && f.to) pills.push(`<span class="vf-pill">📅 ${esc(f.from)} → ${esc(f.to)}</span>`);
    else if (f.from)    pills.push(`<span class="vf-pill">📅 Desde ${esc(f.from)}</span>`);
    else if (f.to)      pills.push(`<span class="vf-pill">📅 Hasta ${esc(f.to)}</span>`);
    container.innerHTML = pills.join('');
  }

  // ── Filter panel toggle ────────────────────────────────────────
  $('btnToggleFilter')?.addEventListener('click', () => {
    $('filterPanel')?.classList.toggle('hidden');
  });

  // ── Status chips ───────────────────────────────────────────────
  $('statusChips')?.querySelectorAll('.vf-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('statusChips').querySelectorAll('.vf-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _activeFilters.status = chip.dataset.status || '';
      console.log('[filter] status chip clicked:', _activeFilters.status);
    });
  });

  // ── Date preset chips ──────────────────────────────────────────
  $('dateChips')?.querySelectorAll('.vf-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('dateChips').querySelectorAll('.vf-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const preset = chip.dataset.preset;
      const today  = new Date();
      const fmt    = d => d.toISOString().slice(0, 10);

      $('customDateRange')?.classList.toggle('hidden', preset !== 'custom');

      if (preset === 'today') {
        _activeFilters.from = _activeFilters.to = fmt(today);
      } else if (preset === 'yesterday') {
        const y = new Date(today); y.setDate(y.getDate() - 1);
        _activeFilters.from = _activeFilters.to = fmt(y);
      } else if (preset === '7d') {
        const s = new Date(today); s.setDate(s.getDate() - 6);
        _activeFilters.from = fmt(s); _activeFilters.to = fmt(today);
      } else if (preset === '30d') {
        const s = new Date(today); s.setDate(s.getDate() - 29);
        _activeFilters.from = fmt(s); _activeFilters.to = fmt(today);
      } else if (preset === 'custom') {
        // will be set by date inputs
      } else {
        _activeFilters.from = _activeFilters.to = '';
      }

      if (preset !== 'custom') {
        if ($('filterFrom')) $('filterFrom').value = _activeFilters.from;
        if ($('filterTo'))   $('filterTo').value   = _activeFilters.to;
      }
    });
  });

  $('filterFrom')?.addEventListener('change', () => { _activeFilters.from = $('filterFrom').value; });
  $('filterTo')?.addEventListener('change',   () => { _activeFilters.to   = $('filterTo').value;   });

  // ── Tag select (populated by loadTagSuggestions) ───────────────
  $('filterTag')?.addEventListener('change', () => {
    _activeFilters.tag = $('filterTag')?.value || '';
  });

  // ── Apply: read state directly from UI at click time ──────────
  $('btnFilterVerif')?.addEventListener('click', () => {
    // Read from UI elements, not from _activeFilters (avoids stale state)
    const activeStatusChip = $('statusChips')?.querySelector('.vf-chip.active');
    const activeDateChip   = $('dateChips')?.querySelector('.vf-chip.active');
    const preset           = activeDateChip?.dataset.preset || '';

    _activeFilters.status = activeStatusChip?.dataset.status || '';
    _activeFilters.tag    = ($('filterTag')?.value  || '').trim();
    _activeFilters.from   = ($('filterFrom')?.value || '').trim();
    _activeFilters.to     = ($('filterTo')?.value   || '').trim();

    // If a non-custom preset is active, recalculate dates from today
    const today = new Date();
    const fmt   = d => d.toISOString().slice(0, 10);
    if (preset === 'today')     { _activeFilters.from = _activeFilters.to = fmt(today); }
    else if (preset === 'yesterday') {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      _activeFilters.from = _activeFilters.to = fmt(y);
    }
    else if (preset === '7d')  { const s = new Date(today); s.setDate(s.getDate()-6); _activeFilters.from = fmt(s); _activeFilters.to = fmt(today); }
    else if (preset === '30d') { const s = new Date(today); s.setDate(s.getDate()-29); _activeFilters.from = fmt(s); _activeFilters.to = fmt(today); }
    else if (preset === '')    { _activeFilters.from = _activeFilters.to = ''; }
    // 'custom' → keep whatever is in filterFrom/filterTo inputs

    console.log('[filter] applying:', JSON.stringify(_activeFilters));

    _verifLoaded = true;
    _updateFilterBadge();
    _updateActivePills();
    $('filterPanel')?.classList.add('hidden');
    loadVerifications(_activeFilters);
  });

  $('btnClearFilter')?.addEventListener('click', () => {
    _activeFilters = { tag: '', from: '', to: '', status: '' };
    if ($('filterTag'))  $('filterTag').value  = '';
    if ($('filterFrom')) $('filterFrom').value = '';
    if ($('filterTo'))   $('filterTo').value   = '';
    $('statusChips')?.querySelectorAll('.vf-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
    $('dateChips')?.querySelectorAll('.vf-chip').forEach((c, i)   => c.classList.toggle('active', i === 0));
    $('customDateRange')?.classList.add('hidden');
    _updateFilterBadge();
    _updateActivePills();
    $('filterPanel')?.classList.add('hidden');
    _verifLoaded = true;
    loadVerifications({});
  });

  $('btnRefreshVerif')?.addEventListener('click', () => {
    loadTagSuggestions();
    loadVerifications(_activeFilters);
  });

  $('btnExportVerif')?.addEventListener('click', async () => {
    const url = `${API}/user/verifications/export${_filtersToQS(_activeFilters)}`;
    try {
      const res = await apiFetch(url);
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `verificaciones_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showAlert($('verifErr'), `Error al exportar: ${err.message}`);
    }
  });

  // Check for a persisted job from a previous session on initial load
  _checkPersistedJob();

  // ── Historial de cargas ────────────────────────────────────────
  async function _loadBatchHistory() {
    const body = $('historyBody');
    if (!body) return;
    try {
      const res  = await apiFetch(`${API}/enrich/jobs`);
      if (!res.ok) return;
      const data = await res.json();
      const jobs = data.jobs || [];

      if (!jobs.length) {
        body.innerHTML = `<div style="color:var(--muted);font-size:.82rem;padding:8px 0">No hay cargas anteriores.</div>`;
        return;
      }

      body.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:.8rem">
          <thead>
            <tr style="border-bottom:1.5px solid var(--border)">
              <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:700">Fecha</th>
              <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:700">Leads</th>
              <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:700">Estado</th>
              <th style="padding:6px 10px"></th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map(j => {
              const date = j.createdAt
                ? new Date(j.createdAt).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
                : '—';
              const statusBadge = j.status === 'done'
                ? `<span style="color:var(--ok);font-weight:600">✅ Listo</span>`
                : j.status === 'running'
                ? `<span style="color:var(--warn);font-weight:600">⏳ Procesando</span>`
                : `<span style="color:var(--err);font-weight:600">❌ Error</span>`;
              const verifyBtn = j.status === 'done'
                ? `<button class="btn btn--primary btn--sm" onclick="_verifyHistoryJob('${esc(j.jobId)}', ${j.total ?? 0})">🎯 Verificar</button>`
                : '';
              const cleanBtn = j.status === 'done'
                ? `<button class="btn btn--ghost btn--sm" onclick="_downloadCleanJob('${esc(j.jobId)}')" title="Exportar con datos limpios">🧹 Exportar limpio</button>`
                : '';
              const dlBtn = j.status === 'done'
                ? `<button class="btn btn--outline btn--sm" onclick="_downloadHistoryJob('${esc(j.jobId)}')">⬇ Descargar</button>`
                : '';
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:7px 10px">${date}</td>
                <td style="padding:7px 10px">${j.total ?? '—'}</td>
                <td style="padding:7px 10px">${statusBadge}</td>
                <td style="padding:7px 10px;display:flex;gap:6px">${dlBtn}${cleanBtn}${verifyBtn}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (_) {
      body.innerHTML = `<div style="color:var(--muted);font-size:.82rem">No se pudo cargar el historial.</div>`;
    }
  }

  // Expose download function globally for inline onclick
  window._downloadCleanJob = async (jobId) => {
    try {
      const res = await apiFetch(`${API}/enrich/job/${jobId}?format=xlsx-clean`);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        downloadBuffer(buf, `limpio_${jobId.slice(0,8)}.xlsx`);
      }
    } catch(e) { alert('Error al descargar: ' + e.message); }
  };

  window._downloadHistoryJob = async (jobId) => {
    try {
      const res = await apiFetch(`${API}/enrich/job/${jobId}?format=xlsx`);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        downloadBuffer(buf, `enrichment_${jobId.slice(0,8)}.xlsx`);
      }
    } catch(e) { alert('Error al descargar: ' + e.message); }
  };

  window._verifyHistoryJob = async (jobId, total) => {
    const confirmed = confirm(
      `🎯 ¿Enviar ${total} leads a verificación real?\n\nSe enviarán emails reales vía SES a los mejores candidatos de este grupo.\nAparecerán en "Mis Verificaciones" en ~1 hora.\n\n⚠️ Requiere que AWS SES esté activo.`
    );
    if (!confirmed) return;

    try {
      // Get job results first
      const resJob = await apiFetch(`${API}/enrich/job/${jobId}`);
      if (!resJob.ok) { alert('No se pudo obtener los resultados del job.'); return; }
      const jobData = await resJob.json();
      const results = jobData.results || [];
      const withEmail = results.filter(r => r.bestEmail || r.candidates?.[0]?.email);

      if (!withEmail.length) { alert('No hay emails para verificar en esta carga.'); return; }

      // Send to verify-batch
      const res = await apiFetch(`${API}/enrich/verify-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: withEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      alert(`✅ ${data.sent} emails enviados a verificación.\nAparecerán en "Mis Verificaciones" en ~1 hora.`);
    } catch(e) {
      alert('Error al verificar: ' + e.message);
    }
  };

  $('btnRefreshHistory')?.addEventListener('click', _loadBatchHistory);
  _loadBatchHistory(); // load on init

  // Check for a persisted job from a previous session on initial load
  _checkPersistedJob();

  // Pre-cargar badge de alertas de integridad al iniciar
  apiFetch(`${API}/mgmt/integrity`)
    .then(r => r.json())
    .then(d => RNotifPanel.updateBadge(d.total || 0))
    .catch(() => {});

} // end initApp()


// ═══════════════════════════════════════════════════════════════════
// SINGLE RESULT RENDERER  (outside initApp — used by single lead)
// ═══════════════════════════════════════════════════════════════════

function renderSingleResult(d) {
  const bestEmail  = d.bestEmail;
  const confidence = d.confidence || 'low';
  const catchAll   = d.isCatchAll;
  const hasBounce  = !!(d.bounceVerifyId && d.bounceVerificationPending);

  const bestCand = d.candidates?.find(c => c.email === bestEmail) ?? d.candidates?.[0];

  const mx = d.mxFound
    ? `<span class="mx-ok">✓ MX found</span> <span class="mono" style="font-size:.72rem;color:var(--muted)">${esc(d.mxHost || '')}</span>`
    : `<span class="mx-no">✗ No MX records</span>`;

  let html = `
    <div style="margin-bottom:14px">
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:4px">Domain</div>
      <div style="font-weight:700;font-size:.95rem">${esc(d.domain || '—')}</div>
      <div style="margin-top:4px">${mx}</div>
      ${d.warning ? `<div class="alert alert--warn" style="margin-top:8px;padding:7px 12px">${esc(d.warning)}</div>` : ''}
    </div>`;

  if (!bestEmail) {
    html += `<div style="color:var(--muted);font-size:.85rem">No email could be found for this lead.</div>`;
  } else {
    const blockClass = catchAll ? 'catchall'
                     : (confidence === 'low' || confidence === 'unverifiable' || confidence === 'none') ? 'low-conf'
                     : '';

    html += `
      <div class="best-email-block ${blockClass}">
        <div class="best-email-label">⭐ Mejor coincidencia</div>
        <div class="best-email-addr">${esc(bestEmail)}</div>
        <div class="best-email-meta">
          ${confBadge(confidence)}
          ${sourcePill(d.bestSource)}
          ${catchAll ? catchAllWarn() : ''}
          ${bestCand ? `<span style="font-size:.72rem;color:var(--muted)">${esc(bestCand.pattern)}</span>` : ''}
        </div>
        ${bestCand ? `<div style="margin-top:8px">${renderScoreBar(bestCand.score)}</div>` : ''}
      </div>`;

    if (hasBounce) {
      html += `
        <div class="bounce-notice">
          <div class="bounce-notice__spin"></div>
          Verificación por correo real en curso — resultado disponible en ~1 hora.
          <span style="font-size:.68rem;color:#64748b;margin-left:auto">ID: ${esc(d.bounceVerifyId.slice(0,8))}…</span>
        </div>`;
    }

    if (d.candidates?.length > 0) {
      html += `
        <div style="font-size:.72rem;font-weight:700;color:var(--muted);letter-spacing:.06em;margin:18px 0 8px">
          TODOS LOS CANDIDATOS (${d.candidates.length})
        </div>
        <div class="cand-table-wrap">
          <table class="cand-table">
            <thead>
              <tr>
                <th style="width:28px">#</th>
                <th>Email</th>
                <th style="width:48px">SMTP</th>
                <th style="width:80px">Score</th>
                <th>Confianza</th>
              </tr>
            </thead>
            <tbody>`;

      d.candidates.forEach((c, i) => {
        const isBest  = c.email === bestEmail;
        const smtpDot = c.smtpStatus === 'valid'   ? '<span class="smtp-dot smtp-dot--valid"  title="SMTP válido">●</span>'
                      : c.smtpStatus === 'invalid' ? '<span class="smtp-dot smtp-dot--invalid" title="SMTP inválido">●</span>'
                      : c.smtpStatus === 'unknown' ? '<span class="smtp-dot smtp-dot--unknown" title="SMTP desconocido">●</span>'
                      : '<span class="smtp-dot smtp-dot--none">—</span>';
        html += `
              <tr class="${isBest ? 'cand-row--best' : ''}">
                <td class="cand-num">${i + 1}</td>
                <td class="cand-email mono${isBest ? ' cand-email--best' : ''}">${esc(c.email)}</td>
                <td style="text-align:center">${smtpDot}</td>
                <td>${renderScoreBar(c.score)}</td>
                <td>${confBadge(c.confidence)}</td>
              </tr>`;
      });

      html += `
            </tbody>
          </table>
        </div>
        <button class="btn btn--ghost btn--sm" id="copySingle" style="margin-top:12px">📋 Copiar mejor email</button>`;
    }
  }

  $('singleResultContent').innerHTML = html;
  $('singleResult').classList.remove('hidden');

  const copyBtn = $('copySingle');
  if (copyBtn && bestEmail) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(bestEmail).then(() => {
        copyBtn.textContent = '✓ ¡Copiado!';
        setTimeout(() => { copyBtn.textContent = '📋 Copiar mejor email'; }, 2000);
      });
    });
  }
}
