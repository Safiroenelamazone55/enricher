'use strict';

/**
 * app.js — B2B Email Enricher Frontend
 * Vanilla JS · no framework
 */

const API = 'https://enricher-ix3b.onrender.com/api';

// ── Helpers ──────────────────────────────────────────────────
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

function confBadge(c) {
  const map = { 'very-high': 'vh', 'high': 'h', 'medium': 'm', 'low': 'l', 'very-low': 'vl' };
  const cls = map[c] ?? 'vl';
  const lbl = { 'very-high': 'Very high', 'high': 'High', 'medium': 'Medium', 'low': 'Low', 'very-low': 'Very low' }[c] ?? c;
  return `<span class="badge badge--${cls}">${lbl}</span>`;
}

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`pane-${btn.dataset.tab}`).classList.add('active');
  });
});

// ═════════════════════════════════════════════════════════════
// SINGLE LEAD
// ═════════════════════════════════════════════════════════════

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
    const res  = await fetch(`${API}/enrich`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ firstName: fn, lastName: ln, company: co, linkedinUrl: $('s_li').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderSingleResult(data);
  } catch (err) {
    showAlert($('singleErr'), `Error: ${err.message}`);
  } finally {
    setBtn($('btnSingle'), false);
  }
});

$('btnClearSingle').addEventListener('click', () => {
  [$('s_fn'), $('s_ln'), $('s_co'), $('s_li')].forEach(el => { el.value = ''; el.classList.remove('err'); });
  hideAlert($('singleErr'));
  $('singleResult').classList.add('hidden');
});

function renderSingleResult(d) {
  const best = d.candidates?.[0];
  const mx   = d.mxFound
    ? `<span class="mx-ok">✓ MX found</span> <span class="mono" style="font-size:.72rem;color:var(--muted)">${esc(d.mxHost || '')}</span>`
    : `<span class="mx-no">✗ No MX records</span>`;

  let html = `
    <div style="margin-bottom:14px">
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:4px">Domain</div>
      <div style="font-weight:700;font-size:.95rem">${esc(d.domain || '—')}</div>
      <div style="margin-top:4px">${mx}</div>
      ${d.warning ? `<div class="alert alert--warn" style="margin-top:8px;padding:7px 12px">${esc(d.warning)}</div>` : ''}
    </div>`;

  if (!d.candidates || d.candidates.length === 0) {
    html += `<div style="color:var(--muted);font-size:.85rem">No candidates could be generated.</div>`;
  } else {
    if (best) {
      html += `
        <div style="background:var(--ok-bg);border:1px solid var(--ok-b);border-radius:var(--rs);padding:12px 16px;margin-bottom:14px">
          <div style="font-size:.72rem;font-weight:700;color:var(--ok);margin-bottom:4px">⭐ BEST MATCH</div>
          <div style="font-family:ui-monospace,monospace;font-size:1rem;font-weight:700;word-break:break-all">${esc(best.email)}</div>
          <div style="display:flex;gap:10px;margin-top:6px;align-items:center">
            ${renderScoreBar(best.score)}
            ${confBadge(best.confidence)}
            <span style="font-size:.72rem;color:var(--muted)">${esc(best.pattern)}</span>
          </div>
        </div>`;
    }

    html += `<div style="font-size:.78rem;font-weight:700;color:var(--muted);margin-bottom:8px">ALL CANDIDATES (${d.candidates.length})</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto">`;

    d.candidates.forEach((c, i) => {
      html += `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border-radius:var(--rs);border:1px solid var(--border)">
          <span style="font-size:.72rem;color:var(--muted);min-width:18px;text-align:center">${i + 1}</span>
          <span class="mono" style="flex:1;word-break:break-all">${esc(c.email)}</span>
          ${renderScoreBar(c.score)}
          ${confBadge(c.confidence)}
        </div>`;
    });

    html += `</div>
      <button class="btn btn--ghost btn--sm" id="copySingle" style="margin-top:12px">📋 Copy best email</button>`;
  }

  $('singleResultContent').innerHTML = html;
  $('singleResult').classList.remove('hidden');

  const copyBtn = $('copySingle');
  if (copyBtn && best) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(best.email).then(() => {
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy best email'; }, 2000);
      });
    });
  }
}

// ═════════════════════════════════════════════════════════════
// BATCH UPLOAD
// ═════════════════════════════════════════════════════════════

let uploadedFile  = null;
let batchResults  = [];
let filteredRows  = [];
let currentPage   = 1;
const PAGE_SIZE   = 20;
let lastXlsBuffer = null;

// Upload zone
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

function setFile(f) {
  uploadedFile = f;
  $('fileLabel').textContent = `📎 ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
  $('btnBatch').disabled         = false;
  $('btnBatchPreview').disabled  = false;
  hideAlert($('batchErr'));
  hideAlert($('batchWarn'));
}

// ── Enrich + download Excel directly ─────────────────────────
$('btnBatch').addEventListener('click', () => runBatch('download'));

// ── Enrich + show preview table ───────────────────────────────
$('btnBatchPreview').addEventListener('click', () => runBatch('preview'));

async function runBatch(mode) {
  if (!uploadedFile) return;

  setBtn($('btnBatch'), true);
  setBtn($('btnBatchPreview'), true);
  hideAlert($('batchErr'));
  hideAlert($('batchWarn'));
  $('batchPreview').classList.add('hidden');

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

  try {
    if (mode === 'preview') {
      // JSON path — single request, no double upload
      const res = await fetch(`${API}/enrich/upload-json`, { method: 'POST', body: formData });
      clearInterval(timer);
      fill.style.width = '100%';

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
      $('batchPreview').classList.remove('hidden');
      $('batchPreview').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } else {
      // Excel download path
      const res = await fetch(`${API}/enrich/upload`, { method: 'POST', body: formData });
      clearInterval(timer);
      fill.style.width = '100%';

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

// ── Download result again ─────────────────────────────────────
$('btnDownloadResult').addEventListener('click', () => {
  if (lastXlsBuffer) downloadBuffer(lastXlsBuffer, `enriched_${Date.now()}.xlsx`);
});

// ── Search ────────────────────────────────────────────────────
$('searchBox').addEventListener('input', () => {
  const q = $('searchBox').value.toLowerCase();
  filteredRows = q
    ? batchResults.filter(r =>
        `${r.firstName} ${r.lastName} ${r.domain} ${r.company}`.toLowerCase().includes(q))
    : [...batchResults];
  currentPage = 1;
  renderPreviewTable();
});

// ── Render table ──────────────────────────────────────────────
function renderPreviewTable() {
  const total    = filteredRows.length;
  const pages    = Math.ceil(total / PAGE_SIZE);
  const start    = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredRows.slice(start, start + PAGE_SIZE);

  const counts = { ok: 0, warn: 0, err: 0, muted: 0 };
  batchResults.forEach(r => {
    const s = r.candidates?.[0]?.score ?? 0;
    if      (s >= 70) counts.ok++;
    else if (s >= 45) counts.warn++;
    else if (s >= 20) counts.err++;
    else              counts.muted++;
  });

  $('batchStats').innerHTML = `
    <div class="stat stat--ok">  <span class="num">${counts.ok}</span>   High confidence</div>
    <div class="stat stat--warn"><span class="num">${counts.warn}</span>  Medium</div>
    <div class="stat stat--err"> <span class="num">${counts.err}</span>   Low</div>
    <div class="stat stat--muted"><span class="num">${counts.muted}</span> No MX / unresolved</div>
    <div class="stat" style="margin-left:auto"><span class="num">${batchResults.length}</span> Total leads</div>
  `;

  $('previewTitle').textContent = `Results: ${total} leads${total !== batchResults.length ? ` (filtered from ${batchResults.length})` : ''}`;

  const tbody = $('previewBody');
  tbody.innerHTML = '';

  pageRows.forEach((r, i) => {
    const best    = r.candidates?.[0];
    const globalI = start + i;

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
      <td><span class="mono">${esc(best?.email || '—')}</span></td>
      <td>${best ? renderScoreBar(best.score) : '—'}</td>
      <td>${best ? confBadge(best.confidence) : '—'}</td>
      <td>${r.candidates?.length ?? 0}</td>
      <td>
        ${r.candidates?.length > 1
          ? `<button class="expand-btn" data-idx="${globalI}">▾ More</button>`
          : ''}
      </td>
    `;
    tbody.appendChild(tr);

    if (r.candidates?.length > 1) {
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
  prev.className  = 'page-btn';
  prev.textContent = '←';
  prev.disabled   = currentPage === 1;
  prev.addEventListener('click', () => { currentPage--; renderPreviewTable(); });
  pag.appendChild(prev);

  const start = Math.max(1, currentPage - 2);
  const end   = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) {
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
