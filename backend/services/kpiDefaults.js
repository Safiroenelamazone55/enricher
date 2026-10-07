// KPIs del portal por cliente.
//  - portal_kpis : lo que la agencia eligió A MANO en la pestaña Portal del cliente (manda siempre; '' = sin elección propia).
//  - seq_kpis    : lo que la agencia muestra en las métricas de las secuencias de ese cliente (ids del catálogo de secuencias).
// Sin elección manual, el portal parte de los KPIs de las secuencias (traducidos a los del portal); sin ninguno, muestra todos.
const PORTAL_KPI_IDS = ['contacted', 'replies', 'meetings', 'touches', 'accept', 'opens', 'clicks'];
const SEQ_KPI_IDS = ['contactados', 'enviados', 'aperturas', 'clics', 'respuesta', 'respuestas', 'rebotes', 'linkedin', 'invitaciones', 'reuniones'];
// Los KPIs de secuencia que no tienen equivalente en el portal (rebotes, invitaciones) simplemente no se trasladan.
const SEQ_TO_PORTAL = { contactados: 'contacted', enviados: 'touches', aperturas: 'opens', clics: 'clicks', respuesta: 'replies', respuestas: 'replies', linkedin: 'accept', reuniones: 'meetings' };

function parse(txt, valid) { return String(txt || '').split(',').map(x => x.trim()).filter(x => valid.includes(x)); }

// row = { portal_kpis, seq_kpis } → { kpis: [ids del portal] | null (= todos), origen: 'manual' | 'secuencias' | 'todos' }
function effective(row) {
  row = row || {};
  const manual = parse(row.portal_kpis, PORTAL_KPI_IDS);
  if (manual.length) return { kpis: manual, origen: 'manual' };
  const mapped = [...new Set(parse(row.seq_kpis, SEQ_KPI_IDS).map(x => SEQ_TO_PORTAL[x]).filter(Boolean))];
  if (mapped.length) return { kpis: PORTAL_KPI_IDS.filter(x => mapped.includes(x)), origen: 'secuencias' };
  return { kpis: null, origen: 'todos' };
}

module.exports = { PORTAL_KPI_IDS, SEQ_KPI_IDS, SEQ_TO_PORTAL, parse, effective };
