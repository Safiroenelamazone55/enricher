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
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`pane-${btn.dataset.tab}`).classList.add('active');
    });
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

  $('btnBatch').addEventListener('click', () => runBatch('download'));
  $('btnBatchPreview').addEventListener('click', () => runBatch('preview'));

  async function runBatch(mode) {
    if (!uploadedFile) return;

    setBtn($('btnBatch'), true);
    setBtn($('btnBatchPreview'), true);
    hideAlert($('batchErr'));
    hideAlert($('batchWarn'));
    $('batchPreview')?.classList.add('hidden');

    const prog  = $('batchProgress');
    const fill  = $('batchFill');
    const label = $('batchLabel');
    prog.classList.add('show');
    fill.style.width = '0%';
    label.textContent = 'Uploading file…';

    let pct = 0;
    const timer = setInterval(() => {
      const inc = pct < 40 ? 5 : pct < 75 ? 2 : pct < 90 ? 0.5 : 0.1;
      pct = Math.min(pct + inc, 93);
      fill.style.width = pct + '%';
      label.textContent = pct < 30 ? 'Uploading file…' : pct < 60 ? 'Resolving domains…' : 'Scoring candidates…';
    }, 250);

    const formData = new FormData();
    formData.append('file', uploadedFile);
    const batchTag = ($('b_tag')?.value || '').trim();
    if (batchTag) formData.append('tag', batchTag);
    const mapping = getColumnMapping();
    if (Object.keys(mapping).length) formData.append('mapping', JSON.stringify(mapping));

    try {
      if (mode === 'preview') {
        const res = await apiFetch(`${API}/enrich/upload-json`, { method: 'POST', body: formData });
        clearInterval(timer);
        fill.style.width = '100%';

        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        batchResults = data.results || [];
        filteredRows = [...batchResults];
        currentPage  = 1;

        if (data.warnings?.length) showAlert($('batchWarn'), data.warnings.join(' · '), 'warn');

        renderPreviewTable();
        $('batchPreview')?.classList.remove('hidden');
        $('batchPreview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

      } else {
        const res = await apiFetch(`${API}/enrich/upload`, { method: 'POST', body: formData });
        clearInterval(timer);
        fill.style.width = '100%';

        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        const warnings = res.headers.get('X-Parse-Warnings');
        if (warnings) {
          try {
            const w = JSON.parse(warnings);
            if (w.length) showAlert($('batchWarn'), w.join(' · '), 'warn');
          } catch (_) {}
        }

        const xlsBuffer = await res.arrayBuffer();
        lastXlsBuffer   = xlsBuffer;
        downloadBuffer(xlsBuffer, `enriched_${Date.now()}.xlsx`);
        showAlert($('batchWarn'), '✓ File enriched and downloaded. Use "Preview in table" to see results here.', 'ok');
      }

    } catch (err) {
      clearInterval(timer);
      showAlert($('batchErr'), `Error: ${err.message}`);
    } finally {
      setTimeout(() => { prog.classList.remove('show'); fill.style.width = '0%'; }, 700);
      setBtn($('btnBatch'), false);
      setBtn($('btnBatchPreview'), false);
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
        pending:  { icon: '🟡', label: 'Pendiente',  cls: 'vstatus--pending'  },
        verified: { icon: '🟢', label: 'Verificado', cls: 'vstatus--verified' },
        bounced:  { icon: '🔴', label: 'Rebote',     cls: 'vstatus--bounced'  },
      };

      const rowsHtml = rows.map((r, idx) => {
        const s   = statusMeta[r.status] ?? { icon: '⚪', label: r.status, cls: '' };
        const date = r.createdAt
          ? new Date(r.createdAt).toLocaleString('es-AR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })
          : '—';

        const ld        = r.leadData || {};
        const firstName = esc(ld.firstName || '');
        const lastName  = esc(ld.lastName  || '');
        const extra     = ld._extra && Object.keys(ld._extra).length > 0 ? ld._extra : null;

        // Email borroso mientras está pendiente
        const emailCell = r.status === 'pending'
          ? `<span class="mono verif-email--pending" title="Verificación en curso…">${esc(r.email)}</span>`
          : `<span class="mono">${esc(r.email)}</span>`;

        const expandBtn = extra
          ? `<button class="expand-btn verif-expand-btn" data-vidx="${idx}">▾ +${Object.keys(extra).length}</button>`
          : '';

        const mainRow = `<tr>
          <td>${firstName || '<span style="color:var(--muted)">—</span>'}</td>
          <td>${lastName  || '<span style="color:var(--muted)">—</span>'}</td>
          <td>${emailCell}</td>
          <td>${r.tag ? `<span class="verif-tag">${esc(r.tag)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
          <td><span class="badge ${esc(s.cls)}">${s.icon} ${s.label}</span></td>
          <td style="white-space:nowrap;font-size:.78rem;color:var(--muted)">${date}</td>
          <td>${expandBtn}</td>
        </tr>`;

        const extraRow = extra ? `<tr id="verif-extra-${idx}" class="hidden">
          <td colspan="7" style="padding:0">
            <div class="verif-extra-grid">
              ${Object.entries(extra).map(([k, v]) =>
                `<div class="verif-extra-item"><span class="verif-extra-key">${esc(k)}</span><span class="verif-extra-val">${esc(v)}</span></div>`
              ).join('')}
            </div>
          </td>
        </tr>` : '';

        return mainRow + extraRow;
      }).join('');

      const filterNote = tag
        ? `<span style="background:var(--ok-bg);border:1px solid var(--ok-b);border-radius:4px;
             padding:2px 8px;font-size:.73rem;color:var(--ok-t)">🏷 ${esc(tag)}</span>`
        : '';

      body.innerHTML = `
        <div class="tbl-wrap">
          <table class="verif-table">
            <thead><tr>
              <th>Nombre</th><th>Apellido</th><th>Email</th>
              <th>Etiqueta</th><th>Estado</th><th>Fecha</th><th></th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <p style="font-size:.75rem;color:var(--muted);margin-top:10px;text-align:right;display:flex;align-items:center;gap:8px;justify-content:flex-end">
          ${filterNote}
          ${rows.length} verificación${rows.length !== 1 ? 'es' : ''}
        </p>`;

      // Wire expand buttons for extra fields
      body.querySelectorAll('.verif-expand-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx  = btn.dataset.vidx;
          const row  = document.getElementById(`verif-extra-${idx}`);
          const open = !row.classList.contains('hidden');
          row.classList.toggle('hidden', open);
          btn.textContent = open ? `▾ +${btn.textContent.match(/\d+/)?.[0] ?? ''}` : `▴ menos`;
        });
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

  // Load when the tab is first activated
  let _verifLoaded = false;
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'verifications' && !_verifLoaded) {
        _verifLoaded = true;
        loadTagSuggestions();
        loadVerifications();
      }
    });
  });

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
        <div style="font-size:.78rem;font-weight:700;color:var(--muted);margin:14px 0 8px">
          TODOS LOS CANDIDATOS (${d.candidates.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto">`;

      d.candidates.forEach((c, i) => {
        const isBest = c.email === bestEmail;
        const smtpDot = c.smtpStatus === 'valid'   ? '🟢'
                      : c.smtpStatus === 'invalid' ? '🔴'
                      : c.smtpStatus === 'unknown' ? '⚪'
                      : '';
        html += `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
            background:${isBest ? 'var(--ok-bg)' : 'var(--bg)'};
            border-radius:var(--rs);
            border:1px solid ${isBest ? 'var(--ok-b)' : 'var(--border)'}">
            <span style="font-size:.72rem;color:var(--muted);min-width:18px;text-align:center">${i + 1}</span>
            <span class="mono" style="flex:1;word-break:break-all;font-weight:${isBest ? '700' : '400'}">${esc(c.email)}</span>
            <span style="font-size:.75rem">${smtpDot}</span>
            ${renderScoreBar(c.score)}
            ${confBadge(c.confidence)}
          </div>`;
      });

      html += `</div>
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
