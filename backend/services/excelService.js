/**
 * excelService.js
 * Read lead lists from Excel/CSV uploads.
 * Write enrichment results back to Excel.
 * Uses the `xlsx` (SheetJS) library — pure JS, no native deps.
 */

const XLSX = require('xlsx');

// ── Column name aliases (case-insensitive, trimmed) ──────────
// Maps user column names → internal field names
const FIELD_ALIASES = {
  firstname:   ['firstname','first_name','first name','nombre','prenom','given name','givenname',
                'nombres','nombre del contacto','first','fname','nombre(s)'],
  lastname:    ['lastname','last_name','last name','apellido','surname','family name','familyname',
                'nom','apellidos','apellido(s)','last','lname'],
  company:     ['company','empresa','organisation','organization','companyurl','company url',
                'website','site','url','web','domain','dominio','sitio web','company website',
                'company name','nombre de la empresa','org','account','empleador','employer'],
  linkedinurl: ['linkedin','linkedinurl','linkedin url','linkedin_url','perfil linkedin','profile',
                'linkedin profile','linkedin profile url','personal linkedin','linkedin personal',
                'url de linkedin','linkedin del contacto','linkedin contact'],
};

/**
 * Map a raw header string to our internal field name.
 * Returns null if unknown.
 */
function mapHeader(raw) {
  const h = String(raw).toLowerCase().trim().replace(/\s+/g,' ');
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

/**
 * Read only the header row of a file and return column names + auto-suggestions.
 *
 * @param {Buffer} buffer
 * @returns {{ headers: string[], suggestions: Object.<number,string> }}
 */
function parseHeaders(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File has no sheets.');
  const sheet = workbook.Sheets[sheetName];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) throw new Error('File is empty.');

  const headers = rows[0].map(h => String(h).trim());

  // Return up to 5 sample data rows — more rows = smarter pattern detection
  const sampleRows = rows.slice(1, 6).map(row =>
    headers.map((_, i) => String(row[i] ?? '').trim())
  );

  // Also return the raw first row values so frontend can toggle "no header" mode
  // (treat row 0 as data, not headers)
  const firstDataRow = rows[1]
    ? headers.map((_, i) => String(rows[1][i] ?? '').trim())
    : [];

  const suggestions = {};
  const usedFields  = new Set();
  headers.forEach((h, i) => {
    const field = mapHeader(h);
    if (field && !usedFields.has(field)) {
      suggestions[i] = field;
      usedFields.add(field);
    }
  });
  return { headers, suggestions, sampleRows, firstDataRow };
}

/**
 * Parse an uploaded Excel or CSV file buffer into an array of lead objects.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @param {Object|null} customMapping  colIndex(string) → field ('firstname'|'lastname'|'company'|'linkedinurl')
 * @returns {{ leads: Array, warnings: string[] }}
 */
function parseLeadsFile(buffer, mimetype, customMapping = null) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel file has no sheets.');

  const sheet = workbook.Sheets[sheetName];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) throw new Error('File must have a header row + at least one data row.');

  // ── Map header row ───────────────────────────────────────
  const headerRow = rows[0].map(String);
  const colMap    = {};   // colIndex → internal field name
  const warnings  = [];

  if (customMapping && typeof customMapping === 'object' && Object.keys(customMapping).length) {
    // Use caller-supplied mapping (from column-mapping UI).
    // When multiple columns map to the same field (e.g. two "company" cols),
    // keep ALL of them — conflict resolution happens per-row below.
    for (const [idxStr, field] of Object.entries(customMapping)) {
      const idx = parseInt(idxStr);
      const norm = (field || '').toLowerCase().trim().replace(/[^a-z]/g, '');
      if (!isNaN(idx) && norm) colMap[idx] = norm;
    }
  } else {
    const usedFields = new Set();
    headerRow.forEach((h, i) => {
      const field = mapHeader(h);
      if (field && !usedFields.has(field)) {
        colMap[i] = field;
        usedFields.add(field);
      }
    });
  }

  const found = new Set(Object.values(colMap));
  if (!found.has('firstname')) warnings.push('Column "firstName" not found — will be empty.');
  if (!found.has('lastname'))  warnings.push('Column "lastName" not found — will be empty.');
  if (!found.has('company'))   warnings.push('Column "company/website" not found — domain resolution skipped.');

  // ── Index of known columns (to detect extras) ───────────
  // __ignore__ columns: included in knownIndexes so they don't appear in _extra
  const ignoredIndexes = new Set(
    Object.entries(colMap).filter(([,v]) => v === '__ignore__').map(([k]) => Number(k))
  );
  const knownIndexes = new Set(Object.keys(colMap).map(Number));

  // ── Build lead objects ───────────────────────────────────
  const leads = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip fully empty rows
    if (row.every(cell => !String(cell).trim())) continue;

    const lead = { firstName: '', lastName: '', company: '', linkedinUrl: '', _row: i + 1 };
    for (const [idxStr, field] of Object.entries(colMap)) {
      const idx = parseInt(idxStr);
      const val = String(row[idx] ?? '').trim();
      if (!val) continue;
      if (field === 'firstname')   lead.firstName   = val;
      if (field === 'lastname')    lead.lastName    = val;
      if (field === 'linkedinurl') lead.linkedinUrl = val;
      if (field === 'company') {
        // Prefer a non-LinkedIn URL over a LinkedIn company URL.
        // If we already have a good company value, only override if
        // the current value is better (not a linkedin.com URL).
        const isLinkedin = /linkedin\.com/i.test(val);
        const currentIsLinkedin = /linkedin\.com/i.test(lead.company);
        if (!lead.company || (currentIsLinkedin && !isLinkedin)) {
          lead.company = val;
        }
      }
    }
    // ── Extra columns ────────────────────────────────────────
    // Mapped non-core fields use their mapped key (e.g. 'cargo', 'pais').
    // Unmapped columns use the original header. Ignored columns are skipped.
    const CORE_FIELDS = new Set(['firstname','lastname','company','linkedinurl','__ignore__']);
    const extra = {};

    // 1. Explicitly mapped non-core fields → use mapped key as label
    for (const [idxStr, field] of Object.entries(colMap)) {
      if (CORE_FIELDS.has(field)) continue;
      const idx = parseInt(idxStr);
      const val = String(row[idx] ?? '').trim();
      if (val) extra[field] = val;
    }

    // 2. Unmapped columns → use original header as key
    headerRow.forEach((h, idx) => {
      if (knownIndexes.has(idx)) return;   // already handled above or ignored
      if (!h || !String(h).trim()) return;
      const key = String(h).trim();
      const val = String(row[idx] ?? '').trim();
      if (val) extra[key] = val;
    });
    if (Object.keys(extra).length > 0) lead._extra = extra;

    // ── Preserve original column order ────────────────────
    // _rawColumns stores ALL columns (mapped + unmapped) in the exact
    // order they appeared in the file. Used by the verifications table
    // to display columns without reordering.
    lead._rawColumns = headerRow
      .map((h, idx) => {
        if (ignoredIndexes.has(idx)) return null;  // skip ignored columns
        const rawHeader = String(h).trim();
        if (!rawHeader) return null;
        // Use mapped label as header when it's a non-core mapped field
        const mapped = colMap[idx];
        const header = (mapped && !CORE_FIELDS.has(mapped)) ? mapped : rawHeader;
        const val = String(row[idx] ?? '').trim();
        return { header, value: val };
      })
      .filter(Boolean);

    leads.push(lead);
  }

  return { leads, warnings };
}

// ── Data cleaning helpers ─────────────────────────────────────

const CARGO_KEYWORDS = [
  'especialista','director','gerente','jefe','coordinador','analista',
  'manager','consultor','supervisor','presidente','vicepresidente',
  'subgerente','asistente','ejecutivo','ingeniero','técnico','licenciado',
  'contador','abogado','economista','arquitecto','médico','doctor',
  'ceo','cto','cfo','coo','ciso','vp','svp','evp',
  'head','lead','chief','officer','founder','co-founder','cofundador',
  'socio','asociado','encargado','responsable','operador','investigador',
  'agente','asesor','promotor','representante','delegado','intendente',
];

const LEGAL_SUFFIXES = /\b(s\.?a\.?a?\.?|s\.?r\.?l\.?|s\.?a\.?c\.?|e\.?i\.?r\.?l\.?|s\.?a\.?s\.?|ltda?\.?|inc\.?|corp\.?|llc\.?|gmbh|bv|nv|plc|pty)\b\.?/gi;

function _toTitleCase(str) {
  if (!str) return '';
  const minorWords = new Set(['de','del','la','las','los','el','y','e','a','en','con','por','para','sin','sobre']);
  return str.toLowerCase().trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 || !minorWords.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ');
}

function cleanCargo(raw) {
  if (!raw) return '';
  return _toTitleCase(
    raw.replace(/[|/\\&+]+/g, ' y ')
       .replace(/\s{2,}/g, ' ')
       .trim()
  );
}

function cleanEmpresa(raw) {
  if (!raw) return '';
  return _toTitleCase(
    raw.replace(LEGAL_SUFFIXES, '')
       .replace(/[.,;|]+$/g, '')
       .replace(/\s{2,}/g, ' ')
       .trim()
  );
}

function cleanNombre(raw) {
  if (!raw) return { clean: '', original: raw || '' };
  const original = raw.trim();
  const words = original.split(/\s+/);

  // Find first word that looks like a job title keyword
  let cutAt = words.length;
  for (let i = 2; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-záéíóúñü]/g, '');
    if (CARGO_KEYWORDS.includes(w)) { cutAt = i; break; }
  }

  const clean = _toTitleCase(words.slice(0, cutAt).join(' '));
  const wasChanged = clean.toLowerCase() !== original.toLowerCase();
  return { clean, original: wasChanged ? original : '' };
}

/**
 * Build a CLEAN version of the results Excel.
 * Applies data normalization: Title Case names, clean job titles,
 * remove legal suffixes from company names.
 */
function buildCleanExcel(results) {
  const validResults = (results || []).filter(r => r && (r.firstName || r.lastName || r.domain || r.company));

  // Collect original file columns
  const origColSet = new Set();
  const origCols   = [];
  for (const r of validResults) {
    if (Array.isArray(r._rawColumns)) {
      r._rawColumns.forEach(({ header }) => {
        if (header && !origColSet.has(header)) { origColSet.add(header); origCols.push(header); }
      });
    }
  }

  // Column name mappings for cleaning
  const CARGO_COLS   = new Set(['cargo','job title','jobtitle','título','puesto','position','role']);
  const EMPRESA_COLS = new Set(['empresa','company','organization','organisation','nombreempresa','nombre de la empresa','company name']);
  const NOMBRE_COLS  = new Set(['nombre completo','full name','fullname','nombre','first name','firstname','nombre de pila','last name','lastname','apellido']);

  const cleanCols = [...origCols, 'Email encontrado','Dominio','MX','Score','Confianza','Patrón','# Candidatos'];
  // Add nombre_original only if we have a name column
  const hasNameCol = origCols.some(h => NOMBRE_COLS.has(h.toLowerCase()));
  if (hasNameCol) cleanCols.push('nombre_original');

  const sheetData = [cleanCols];

  for (const r of validResults) {
    const rawMap = {};
    if (Array.isArray(r._rawColumns)) {
      r._rawColumns.forEach(({ header, value }) => { rawMap[header] = value; });
    }

    let nombreOriginal = '';
    const cleanedMap = {};

    origCols.forEach(h => {
      const val = rawMap[h] ?? '';
      const hLow = h.toLowerCase();
      if (CARGO_COLS.has(hLow)) {
        cleanedMap[h] = cleanCargo(val);
      } else if (EMPRESA_COLS.has(hLow)) {
        cleanedMap[h] = cleanEmpresa(val);
      } else if (NOMBRE_COLS.has(hLow)) {
        const { clean, original } = cleanNombre(val);
        cleanedMap[h] = clean;
        if (original) nombreOriginal = original;
      } else {
        cleanedMap[h] = val;
      }
    });

    const best = r.candidates?.[0] ?? null;
    const origValues  = origCols.map(h => cleanedMap[h] ?? '');
    const enrichValues = [
      best?.email ?? r.bestEmail ?? '',
      r.domain    ?? '',
      r.mxFound   ? 'Sí' : 'No',
      best?.score ?? '',
      best?.confidence ?? '',
      best?.pattern ?? '',
      r.candidates?.length ?? 0,
    ];

    const row = [...origValues, ...enrichValues];
    if (hasNameCol) row.push(nombreOriginal);
    sheetData.push(row);
  }

  const wb = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet(sheetData);
  _styleSheet(ws, sheetData[0].length);
  XLSX.utils.book_append_sheet(wb, ws, 'Limpio');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Build an Excel workbook buffer from enrichment results.
 *
 * @param {Array} results  - enriched lead objects
 * @returns {Buffer}
 */
function buildResultsExcel(results) {
  // ── Collect original file columns from _rawColumns ────────
  // Preserves the exact order and names from the uploaded file.
  const origColSet = new Set();
  const origCols   = [];
  const validResults = (results || []).filter(r => r && (r.firstName || r.lastName || r.domain || r.company));

  for (const r of validResults) {
    const raw = r._rawColumns;
    if (Array.isArray(raw)) {
      raw.forEach(({ header }) => {
        if (header && !origColSet.has(header)) { origColSet.add(header); origCols.push(header); }
      });
    }
  }

  // Enrichment result columns (always present)
  const enrichCols = ['Email encontrado','Dominio','MX','Score','Confianza','Patrón','# Candidatos','Aviso'];

  // ── Sheet 1: Summary (one row per lead, best email) ──────
  const summaryData = [
    [...origCols, ...enrichCols],
  ];

  for (const r of validResults) {
    const best = r.candidates?.[0] ?? null;

    // Original file columns in order
    const rawMap = {};
    if (Array.isArray(r._rawColumns)) {
      r._rawColumns.forEach(({ header, value }) => { rawMap[header] = value; });
    } else if (r._extra) {
      Object.assign(rawMap, r._extra);
      rawMap['First Name'] = r.firstName || '';
      rawMap['Last Name']  = r.lastName  || '';
      rawMap['Company']    = r.company   || '';
    }
    const origValues = origCols.map(h => rawMap[h] ?? '');

    // Enrichment values
    const enrichValues = [
      best?.email      ?? r.bestEmail ?? '',
      r.domain         ?? '',
      r.mxFound        ? 'Sí' : 'No',
      best?.score      ?? '',
      best?.confidence ?? '',
      best?.pattern    ?? '',
      r.candidates?.length ?? 0,
      r.warning        ?? '',
    ];

    summaryData.push([...origValues, ...enrichValues]);
  }

  // ── Sheet 2: All candidates (one row per email candidate) ─
  const candidatesData = [
    ['First Name','Last Name','Company','Domain','Email','Pattern','Rank','Score','Confidence'],
  ];

  for (const r of validResults) {
    for (const c of (r.candidates ?? [])) {
      candidatesData.push([
        r.firstName,
        r.lastName,
        r.company,
        r.domain ?? '',
        c.email,
        c.pattern,
        c.rank,
        c.score,
        c.confidence,
      ]);
    }
  }

  // ── Build workbook ────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  _styleSheet(ws1, summaryData[0].length);
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  const ws2 = XLSX.utils.aoa_to_sheet(candidatesData);
  _styleSheet(ws2, candidatesData[0].length);
  XLSX.utils.book_append_sheet(wb, ws2, 'All Candidates');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Set column widths for readability. */
function _styleSheet(ws, colCount) {
  const widths = [12,12,20,24,10,30,8,10,24,12,30];
  ws['!cols'] = Array.from({ length: colCount }, (_, i) => ({ wch: widths[i] ?? 14 }));
}

/**
 * Generate a simple template Excel file for users to fill in.
 */
function buildTemplateExcel() {
  const data = [
    ['firstName','lastName','company','linkedinUrl'],
    ['John','Doe','https://acme.com','https://linkedin.com/in/johndoe'],
    ['Ana María','López García','acme.io',''],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 28 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseLeadsFile, parseHeaders, buildResultsExcel, buildCleanExcel, buildTemplateExcel, FIELD_ALIASES };
