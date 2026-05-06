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
  firstname:    ['firstname','first_name','first name','nombre','prenom','given name','givenname'],
  lastname:     ['lastname','last_name','last name','apellido','surname','family name','familyname','nom'],
  company:      ['company','empresa','organisation','organization','compañia','companyurl','company url','website','site','url'],
  linkedinurl:  ['linkedin','linkedinurl','linkedin url','linkedin_url','perfil linkedin','profile'],
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
 * Parse an uploaded Excel or CSV file buffer into an array of lead objects.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {{ leads: Array, warnings: string[] }}
 */
function parseLeadsFile(buffer, mimetype) {
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

  headerRow.forEach((h, i) => {
    const field = mapHeader(h);
    if (field && !(field in Object.fromEntries(Object.entries(colMap).map(([k,v])=>[v,k])))) {
      colMap[i] = field;
    }
  });

  const found = new Set(Object.values(colMap));
  if (!found.has('firstname')) warnings.push('Column "firstName" not found — will be empty.');
  if (!found.has('lastname'))  warnings.push('Column "lastName" not found — will be empty.');
  if (!found.has('company'))   warnings.push('Column "company/website" not found — domain resolution skipped.');

  // ── Index of known columns (to detect extras) ───────────
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
      if (field === 'firstname')   lead.firstName   = val;
      if (field === 'lastname')    lead.lastName    = val;
      if (field === 'company')     lead.company     = val;
      if (field === 'linkedinurl') lead.linkedinUrl = val;
    }
    // ── Extra columns (phone, position, CRM id, etc.) ─────
    // Stored under lead._extra so they survive through enrichment
    // and get persisted in verifications.lead_data
    const extra = {};
    headerRow.forEach((h, idx) => {
      if (!knownIndexes.has(idx) && h && String(h).trim()) {
        const key = String(h).trim();
        const val = String(row[idx] ?? '').trim();
        if (val) extra[key] = val;
      }
    });
    if (Object.keys(extra).length > 0) lead._extra = extra;

    leads.push(lead);
  }

  return { leads, warnings };
}

/**
 * Build an Excel workbook buffer from enrichment results.
 *
 * @param {Array} results  - enriched lead objects
 * @returns {Buffer}
 */
function buildResultsExcel(results) {
  // ── Sheet 1: Summary (one row per lead, best email) ──────
  const summaryData = [
    ['First Name','Last Name','Company','Domain','MX Found','Best Email','Score','Confidence','Pattern','# Candidates','Warning'],
  ];

  for (const r of results) {
    const best = r.candidates?.[0] ?? null;
    summaryData.push([
      r.firstName,
      r.lastName,
      r.company,
      r.domain         ?? '',
      r.mxFound        ? 'YES' : 'NO',
      best?.email      ?? '',
      best?.score      ?? '',
      best?.confidence ?? '',
      best?.pattern    ?? '',
      r.candidates?.length ?? 0,
      r.warning        ?? '',
    ]);
  }

  // ── Sheet 2: All candidates (one row per email candidate) ─
  const candidatesData = [
    ['First Name','Last Name','Company','Domain','Email','Pattern','Rank','Score','Confidence'],
  ];

  for (const r of results) {
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

module.exports = { parseLeadsFile, buildResultsExcel, buildTemplateExcel };
