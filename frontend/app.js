'use strict';

/**
 * app.js — B2B Email Enricher Frontend
 * Vanilla JS · no framework
 */

const API = 'https://enricher-t04s.onrender.com/api';

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

/**
 * On page load: call /api/auth/me to determine login state.
 * Shows either the auth wall or the full app.
 */
async function initAuth() {
  const authBar  = $('authBar');
  const authWall = $('authWall');
  const appShell = $('appShell');

  try {
    const res  = await apiFetch(`${API}/auth/me`);
    const data = await res.json();

    if (data.loggedIn) {
      // ── Logged in — show the app ──────────────────────────
      authBar.innerHTML = `
        <div class="auth-user">
          ${data.avatar
            ? `<img src="${esc(data.avatar)}" alt="" class="auth-user__avatar"/>`
            : `<div class="auth-user__initials">${esc((data.name || data.email || '?')[0].toUpperCase())}</div>`
          }
          <span class="auth-user__name">${esc(data.name || data.email)}</span>
          <a href="${API}/auth/logout" class="btn btn--ghost btn--sm" id="btnLogout">Sign out</a>
        </div>`;

      // Sign-out: call API then reload to show auth wall
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
      initApp();  // wire up all enrichment listeners

    } else {
      // ── Not logged in — show auth wall ────────────────────
      authBar.innerHTML = `
        <a href="${API}/auth/google" class="btn btn--google btn--sm">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" width="15" height="15"/>
          Sign in
        </a>`;
      authWall.classList.remove('hidden');
      appShell.classList.add('hidden');
    }

  } catch (err) {
    // Network error or server down — show minimal error in bar
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

// Run auth check immediately
initAuth();

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
    if (tabName === 'batch') _checkPersistedJob();
    if (tabName === 'verifications' && !_verifLoaded) {
      _verifLoaded = true;
      loadTagSuggestions();
      loadVerifications();
    }
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
  const FIELD_OPTIONS = [
    { value: '',            label: '— ignorar —' },
    { value: 'firstname',   label: 'Nombre (firstName)' },
    { value: 'lastname',    label: 'Apellido (lastName)' },
    { value: 'company',     label: 'Empresa / URL (company)' },
    { value: 'linkedinurl', label: 'LinkedIn URL' },
  ];

  // Known aliases for client-side auto-detection (mirrors backend FIELD_ALIASES)
  const CLIENT_ALIASES = {
    firstname:   ['firstname','first_name','first name','nombre','prenom','given name','givenname'],
    lastname:    ['lastname','last_name','last name','apellido','surname','family name','familyname','nom'],
    company:     ['company','empresa','organisation','organization','compañia','companyurl','company url','website','site','url','web','webpage','web page','company website','company web','domain','dominio','sitio web','sitio'],
    linkedinurl: ['linkedin','linkedinurl','linkedin url','linkedin_url','perfil linkedin','profile','linkedin profile','linkedin profile url','personal linkedin','linkedin personal'],
  };

  function guessField(raw) {
    const h = String(raw).toLowerCase().trim().replace(/\s+/g,' ');
    // LinkedIn personal profile URLs → linkedinurl
    if (/linkedin\.com\/(in\/|pub\/)/.test(h)) return 'linkedinurl';
    // LinkedIn company URLs → ignore (not useful as domain)
    if (/linkedin\.com\/company/.test(h)) return '';
    // Any http URL that is NOT linkedin → likely company website
    if (/^https?:\/\//.test(h) && !h.includes('linkedin.com')) return 'company';
    for (const [field, aliases] of Object.entries(CLIENT_ALIASES)) {
      if (aliases.includes(h)) return field;
    }
    return '';
  }

  /** Read first row of a CSV/TSV file purely in the browser */
  function readCsvHeaders(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const text = e.target.result || '';
        const firstLine = text.split(/\r?\n/)[0] || '';
        // Detect delimiter: comma, semicolon, or tab
        const delim = firstLine.includes('\t') ? '\t'
                    : firstLine.includes(';')  ? ';' : ',';
        const headers = firstLine.split(delim).map(h => h.replace(/^["']|["']$/g,'').trim());
        resolve(headers);
      };
      reader.onerror = () => reject(new Error('FileReader error'));
      // Read only first 4 KB — enough for the header row
      reader.readAsText(file.slice(0, 4096));
    });
  }

  function renderMappingPanel(headers, suggestions) {
    const panel = _getMappingContainer();
    panel.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'col-map-panel__title';
    title.textContent = '🗂 Asigna las columnas de tu archivo';
    const hint = document.createElement('div');
    hint.className = 'col-map-panel__hint';
    hint.textContent = 'El sistema detectó las columnas abajo. Ajusta si alguna no es correcta. Las columnas sin asignar se guardan como campos extra.';
    panel.appendChild(title);
    panel.appendChild(hint);

    const rowsDiv = document.createElement('div');
    rowsDiv.id = 'colMapRows';
    rowsDiv.className = 'col-map-rows';
    panel.appendChild(rowsDiv);

    headers.forEach((h, idx) => {
      const suggested = suggestions[idx] || guessField(h) || '';
      const row = document.createElement('div');
      row.className = 'col-map-row';

      const label = document.createElement('span');
      label.className = 'col-map-col-name';
      label.textContent = h || `columna ${idx + 1}`;

      const arrow = document.createElement('span');
      arrow.className = 'col-map-arrow';
      arrow.textContent = '→';

      const sel = document.createElement('select');
      sel.className = 'col-map-select';
      sel.dataset.colIdx = idx;
      FIELD_OPTIONS.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === suggested) o.selected = true;
        sel.appendChild(o);
      });

      row.appendChild(label);
      row.appendChild(arrow);
      row.appendChild(sel);
      rowsDiv.appendChild(row);
    });

  }

  async function setFile(f) {
    uploadedFile = f;
    $('fileLabel').textContent = `📎 ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;

    // Keep buttons disabled until mapping is resolved
    $('btnBatch').disabled        = true;
    $('btnBatchPreview').disabled = true;
    hideAlert($('batchErr'));
    hideAlert($('batchWarn'));

    // Show "loading" panel immediately (synchronous, before any async)
    _showMappingLoading();

    const isCsv = /\.(csv|tsv|txt)$/i.test(f.name);

    try {
      if (isCsv) {
        const headers = await readCsvHeaders(f);
        if (headers.length > 0) {
          renderMappingPanel(headers, {});
        } else {
          _showMappingError('No se encontraron columnas en la primera fila del archivo.');
        }
      } else {
        // Excel — call server
        const fd = new FormData();
        fd.append('file', f);
        const res = await apiFetch(`${API}/enrich/parse-headers`, { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          if (data.headers && data.headers.length > 0) {
            renderMappingPanel(data.headers, data.suggestions || {});
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
      // Enable buttons only after mapping panel is ready
      $('btnBatch').disabled        = false;
      $('btnBatchPreview').disabled = false;
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
    document.querySelectorAll('#colMapRows .col-map-select').forEach(sel => {
      if (sel.value) mapping[sel.dataset.colIdx] = sel.value;
    });
    return mapping;
  }

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

  async function loadVerifications(tag = '') {
    const body    = $('verifBody');
    const errEl   = $('verifErr');
    const btn     = $('btnRefreshVerif');

    hideAlert(errEl);
    setBtn(btn, true);
    body.innerHTML = '<div class="verif-empty">Cargando…</div>';

    try {
      const url = tag
        ? `${API}/user/verifications?tag=${encodeURIComponent(tag)}`
        : `${API}/user/verifications`;
      const res  = await apiFetch(url);
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const rows = data.verifications || [];

      if (rows.length === 0) {
        const emptyMsg = tag
          ? `No hay verificaciones con la etiqueta "<strong>${esc(tag)}</strong>".`
          : 'No tienes verificaciones pendientes.';
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

      // Collect ALL column headers in original file order using _rawColumns.
      // _rawColumns = [{header, value}, ...] — exact order from the uploaded file.
      // Falls back to _extra keys if _rawColumns not available (older records).
      const colHeaderSet = new Set();
      const colHeaders   = [];   // ordered list of original column headers
      rows.forEach(r => {
        const raw = r.leadData?._rawColumns;
        if (Array.isArray(raw)) {
          raw.forEach(({ header }) => {
            if (!colHeaderSet.has(header)) { colHeaderSet.add(header); colHeaders.push(header); }
          });
        } else {
          // Fallback: _extra keys (unordered but better than nothing)
          Object.keys(r.leadData?._extra || {}).forEach(k => {
            if (!colHeaderSet.has(k)) { colHeaderSet.add(k); colHeaders.push(k); }
          });
        }
      });

      const rowsHtml = rows.map((r, idx) => {
        const isCatchAll_ = !!(r.leadData?.isCatchAll);
        const s = isCatchAll_
          ? { icon: '⚠️', label: 'Acepta todo', cls: 'vstatus--catchall' }
          : (statusMeta[r.status] ?? { icon: '⚪', label: r.status, cls: '' });
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
              ${canRetry ? '' : 'disabled title="Solo errores de envío pueden reintentarse"'}/>
          </td>
          <td class="vt-frozen vt-frozen--status">
            <span class="badge ${esc(s.cls)}">${s.icon} ${s.label}</span>
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

      const filterNote = tag
        ? `<span style="background:var(--ok-bg);border:1px solid var(--ok-b);border-radius:4px;
             padding:2px 8px;font-size:.73rem;color:var(--ok-t)">🏷 ${esc(tag)}</span>`
        : '';

      // Floating retry bar (hidden until checkboxes are ticked)
      const retryBarHtml = `
        <div class="verif-retry-bar hidden" id="verifRetryBar">
          <span class="verif-retry-bar__count" id="retryCount">0 seleccionadas</span>
          <button class="btn btn--primary btn--sm" id="btnRetrySelected">⟳ Revivir y re-enviar</button>
          <button class="btn btn--danger btn--sm"  id="btnDismissSelected">✕ Descartar</button>
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
      const btnRetryClear  = body.querySelector('#btnRetryClear');
      const allCbs         = () => [...body.querySelectorAll('.verif-cb:not(:disabled)')];

      function _updateRetryBar() {
        const checked = allCbs().filter(c => c.checked);
        if (checked.length > 0) {
          retryCountEl.textContent = `${checked.length} seleccionada${checked.length !== 1 ? 's' : ''}`;
          retryBar?.classList.remove('hidden');
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
        // Select all error rows (retryable ones)
        allCbs().forEach(cb => { cb.checked = true; });
        _updateRetryBar();
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
          setTimeout(() => loadVerifications(tag), 1800);

        } catch (err) {
          btnRetry.disabled = false;
          btnRetry.textContent = '⟳ Revivir y re-enviar';
          showAlert(errEl, `Error al re-verificar: ${err.message}`);
        }
      });

      btnDismiss?.addEventListener('click', async () => {
        const checked = allCbs().filter(c => c.checked);
        if (!checked.length) return;
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
      const dl   = $('tagSuggestions');
      dl.innerHTML = (data.tags || [])
        .map(t => `<option value="${esc(t)}">`)
        .join('');
    } catch (_) { /* non-critical */ }
  }

  // _verifLoaded declared at top of initApp, tab switching handled by _switchTab

  function _getFilterTag() { return ($('filterTag')?.value || '').trim(); }

  $('btnRefreshVerif')?.addEventListener('click', () => {
    loadTagSuggestions();
    loadVerifications(_getFilterTag());
  });

  $('btnFilterVerif')?.addEventListener('click', () => {
    _verifLoaded = true;
    loadVerifications(_getFilterTag());
  });

  $('filterTag')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      _verifLoaded = true;
      loadVerifications(_getFilterTag());
    }
  });

  $('btnExportVerif')?.addEventListener('click', async () => {
    const tag = _getFilterTag();
    const url = tag
      ? `${API}/user/verifications/export?tag=${encodeURIComponent(tag)}`
      : `${API}/user/verifications/export`;
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
