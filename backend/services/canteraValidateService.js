'use strict';

/**
 * canteraValidateService.js — el "motor fijo" de Cantera.
 *
 * Jenny nunca escribe ni ve este prompt. Lo único que ella escribe por
 * borrador es ICP (texto libre) + Tiers (ángulos del ICP, cada uno con su
 * criterio) + Puestos por Tier (a quién contactar y a quién excluir). Este
 * motor combina eso con las reglas de investigación que SÍ son fijas y
 * reutilizables para cualquier cliente:
 *   - Verificar con evidencia real (mínimo de fuentes independientes),
 *     nunca inferir de una sola palabra clave.
 *   - Investigar en internet (web_search) antes de decidir.
 *   - Devolver SIEMPRE el mismo formato de salida, para que el resto del
 *     pipeline (guardar en DB, mostrar en la tabla) no dependa del cliente.
 *
 * Un batch de Cantera SOLO investiga cada EMPRESA una vez (nunca por
 * contacto — varias personas de la misma empresa comparten un solo
 * resultado de Tier), y recién con eso decide la prioridad entre sus
 * contactos según Puestos por Tier.
 */

const MODEL = 'claude-sonnet-5';
const RATES = { 'claude-sonnet-5': { in: 3, out: 15 } };

function _sumUsage(u) {
  return {
    in: (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0),
    out: u?.output_tokens || 0,
  };
}
function _extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

function _tiersBlock(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return '(sin Tiers definidos — usa "calificada" / "descartada" según el ICP)';
  return tiers.map((t, i) =>
    `${i + 1}. ${t.clave || 'TIER_' + (i + 1)} — ${t.nombre || ''}\n   Criterio: ${t.criterio || ''}` +
    (t.descarte ? `\n   Esto NO califica para este Tier si: ${t.descarte}` : '')
  ).join('\n');
}
function _puestosBlock(puestos, tiers) {
  const claves = (tiers || []).map(t => t.clave).filter(Boolean);
  if (!puestos || !Object.keys(puestos).length) return '(sin puestos definidos — prioriza por seniority/cargo relevante al ICP)';
  return claves.concat(Object.keys(puestos).filter(k => !claves.includes(k))).map(clave => {
    const list = puestos[clave] || [];
    if (!list.length) return '';
    const rows = list.map((p, i) =>
      `   ${i + 1}. ${p.titulo}${p.tipo === 'descarte' ? ' → DESCARTAR' : p.tipo === 'respaldo' ? ' (respaldo)' : ' (decide)'}` +
      (p.exclusion ? ` — excluir si: ${p.exclusion}` : '')
    ).join('\n');
    return `Para ${clave}:\n${rows}`;
  }).filter(Boolean).join('\n\n');
}

function _buildSystemPrompt(batch) {
  return `Eres un analista de inteligencia comercial B2B especializado en debida diligencia de prospección. Tu estándar es el de un memo interno que un director va a leer y usar para decidir en qué empresa invertir tiempo de venta real — no el de un resumen superficial. Cada afirmación que hagas debe poder defenderse señalando la página exacta donde la viste.

Tu única tarea en esta llamada: investigar UNA empresa específica y clasificarla según el criterio EXACTO que te doy abajo — nunca según tu propio criterio de qué "suena" bien o tu conocimiento previo del sector.

═══════════════════════════════════
PROTOCOLO DE INVESTIGACIÓN (en orden)
═══════════════════════════════════
1. IDENTIFICA la empresa exacta. Si el nombre es genérico o común, confírmalo cruzando dominio/sitio web, país y sector antes de seguir — nunca asumas que el primer resultado con un nombre parecido es la empresa correcta. Si hay varias empresas con nombres similares y no puedes confirmar cuál es, dilo explícitamente y baja la confianza.
2. DISTINGUE estructura societaria: si la empresa es una filial, marca o división de un grupo mayor, evalúa el ICP contra LA ENTIDAD QUE REALMENTE OPERA (la que aparece en los datos importados) — no contra el grupo matriz completo, salvo que el ICP pida explícitamente evaluar al grupo.
3. RECOLECTA evidencia de al menos 3 fuentes independientes cuando existan (sitio oficial, LinkedIn, noticias/prensa, ofertas de empleo activas, registros públicos, directorios de industria). Prioriza fuentes oficiales y recientes sobre agregadores de terceros — los directorios tipo Crunchbase/ZoomInfo pueden estar desactualizados o mal categorizados; trátalos como pista, nunca como prueba final.
4. VERIFICA CADA CRITERIO DEL TIER por separado con su propia evidencia directa. Si el criterio depende de un HECHO puntual y verificable (ej. "tiene flota propia", "opera en X país", "usa tal tecnología"), ese hecho necesita SU PROPIA evidencia directa — no basta con fuentes genéricas sobre la empresa si ninguna confirma ese hecho en particular.
5. CLASIFICA los contactos importados por cargo, cruzando la lista de Puestos a Contactar de abajo.
6. AUTOCHEQUEO antes de responder (hazlo en tu razonamiento, no lo muestres en la respuesta final):
   - ¿Cada entrada de "evidencia" viene de una página que de verdad abriste con web_search en ESTA investigación? Si no puedes recordar el contenido exacto de una fuente, no la cites.
   - ¿Alguna conclusión se apoya en una sola palabra clave o un solo cargo de LinkedIn sin confirmación independiente? Si sí, bájala a "pista sin confirmar" y ajusta la confianza.
   - ¿La confianza que vas a reportar refleja honestamente cuánta evidencia real reuniste, o es optimismo?
   - ¿Evaluaste la entidad correcta (no una matriz o filial equivocada)?

═══════════════════════════════════
REGLAS DE EVIDENCIA (fijas, no negociables — cada una existe porque ya se vio fallar)
═══════════════════════════════════
- PROHIBIDO citar una fuente que no abriste de verdad en esta misma investigación. Cada "evidencia" debe venir de una página que realmente recuperaste con web_search — nunca un nombre de fuente que "suena típico" del rubro.
- El campo "resumen" de cada evidencia debe describir lo que ESA página específica dice — nunca una idea general parafraseada de memoria. Si no puedes decir con precisión qué dice la página, no la cites.
- PROHIBIDO inferir un hecho operativo (posee flota, fabrica en sitio, tiene cierto tamaño, opera en cierto país, etc.) a partir de UN SOLO cargo o palabra clave en un título de LinkedIn. Es una pista para investigar, nunca la prueba en sí — busca confirmación explícita antes de darlo por cierto.
- No clasifiques por una sola palabra clave o por el sector que aparece en LinkedIn sin verificar el contenido real.
- No inventes datos. Si algo no se puede verificar, dilo — nunca lo asumas como cierto. Ante la duda entre "calificar apresuradamente" y "bajar la confianza o descartar por falta de evidencia", elige siempre lo segundo.
- Si la evidencia es antigua (ej. más de 2 años para un dato operativo que cambia, como tamaño de equipo) o contradictoria entre fuentes, dilo explícitamente en el resumen o el motivo_descarte.
- Las fuentes pueden estar en cualquier idioma — léelas en su idioma original, pero escribe tus resúmenes en español.

CALIBRACIÓN DE CONFIANZA (usa este criterio exacto, no una impresión general):
- "alta": 3 o más fuentes independientes confirman el criterio decisivo del Tier, incluyendo al menos una fuente primaria (sitio oficial, comunicado propio, oferta de empleo activa).
- "media": evidencia razonable pero incompleta — 2 fuentes, o fuentes indirectas que apuntan al criterio sin confirmarlo del todo.
- "baja": 1 fuente o ninguna fuente directa del criterio decisivo; clasificaste por indicios razonables pero sin confirmación sólida.

- Estás investigando UNA sola empresa en esta llamada — no hay lote ni presión de tiempo. Tómate los usos de web_search que necesites (hasta el límite disponible) antes de decidir; una respuesta rápida pero mal verificada es peor que una que tardó más. No hay ninguna ventaja en responder rápido — la única métrica que importa es que cada afirmación esté respaldada por lo que de verdad encontraste.

CRITERIO DE CALIFICACIÓN (definido por el cliente para este borrador):

PERFIL DE CLIENTE IDEAL (ICP):
${batch.icp || '(sin ICP definido)'}

TIERS (ángulos del ICP — clasifica en el que mejor calce; si no calza en ninguno, es "descartada"):
${_tiersBlock(batch.tiers)}

PUESTOS A CONTACTAR POR TIER (para decidir prioridad de contacto una vez clasificada la empresa):
${_puestosBlock(batch.puestos, batch.tiers)}

FORMATO DE SALIDA — responde ÚNICAMENTE un objeto JSON válido, sin texto ni fences alrededor, con esta forma exacta:
{
  "tier_clave": "TIER_1A o vacío si se descarta",
  "confianza": "alta | media | baja",
  "evidencia": [{"fuente": "nombre de la fuente", "url": "https://...", "resumen": "qué dice y por qué importa"}],
  "motivo_descarte": "vacío si calificó; si no, la razón exacta y específica a ESTA empresa",
  "contactos": [{"cargo": "el cargo tal como aparece en la lista que te paso", "puesto_estado": "decide | respaldo | descartado", "motivo": "por qué, especialmente si se descarta un cargo parecido"}]
}
El array "contactos" debe traer EXACTAMENTE los cargos que te paso abajo, uno por uno, en el mismo orden — nunca inventes contactos nuevos ni los omitas.`;
}

async function validateCompany(pool, uid, batch, company, contactos) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { throw new Error('Falta @anthropic-ai/sdk (npm install en backend)'); }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en el entorno');
  const client = new Anthropic();

  const system = _buildSystemPrompt(batch);
  const datos = [
    `Nombre: ${company.nombre}`,
    company.dominio ? `Dominio: ${company.dominio}` : '',
    company.website ? `Website: ${company.website}` : '',
    company.pais ? `País (según lo importado): ${company.pais}` : '',
    company.industria ? `Industria (según lo importado): ${company.industria}` : '',
    company.tamano ? `Tamaño (según lo importado): ${company.tamano}` : '',
    company.linkedin ? `LinkedIn: ${company.linkedin}` : '',
  ].filter(Boolean).join('\n');
  const cargos = contactos.map(c => `- ${c.cargo || '(sin cargo)'}`).join('\n') || '(sin contactos importados para esta empresa)';
  const user = `EMPRESA A INVESTIGAR:\n${datos}\n\nCARGOS DE LOS CONTACTOS IMPORTADOS PARA ESTA EMPRESA (clasifica cada uno):\n${cargos}\n\nInvestiga y devuelve el JSON.`;

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 8000, system,
    thinking: { type: 'adaptive' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }],
    messages: [{ role: 'user', content: user }],
  });
  const u = _sumUsage(resp.usage);
  const texto = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  let parsed;
  try { parsed = JSON.parse(_extractJson(texto)); } catch (e) { throw new Error('El modelo no devolvió JSON válido: ' + e.message); }

  const rate = RATES[resp.model] || RATES[MODEL];
  const cost = (u.in * rate.in + u.out * rate.out) / 1e6;
  return { parsed, cost, model: resp.model || MODEL, inputTokens: u.in, outputTokens: u.out };
}

// Corre el paso 2 sobre las empresas del batch que siguen pendientes de
// investigar. NO exige que el paso 1 (filtros básicos) se haya corrido antes
// — el orden de los pasos lo decide la usuaria, no el sistema (pedido
// explícito 2026-09-06: "no quiero que el sistema reconozca ese proceso como
// pasos en orden"). Solo se excluye lo que el paso 1 descartó explícitamente
// (esa decisión sí se respeta); lo "pendiente" (filtro nunca corrido) entra
// igual. Secuencial (concurrencia 1) a propósito: cada llamada investiga en
// internet y cuesta dinero real — no queremos 50 llamadas en paralelo.
async function runBatchValidation(pool, uid, batchId, { onProgress, companyIds } = {}) {
  const { rows: [batch] } = await pool.query(`SELECT * FROM cantera_batches WHERE id=$1 AND user_id=$2`, [batchId, uid]);
  if (!batch) throw new Error('Borrador no encontrado');
  // `companyIds`: selección explícita (con confirmación ya hecha en el
  // frontend) que FUERZA la reinvestigación sin importar paso2_estado actual
  // — pedido explícito 2026-09-06, para poder re-investigar con un Criterio
  // de calificación nuevo sin tener que reabrir cada empresa a mano.
  const { rows: companies } = await pool.query(
    Array.isArray(companyIds) && companyIds.length
      ? `SELECT * FROM cantera_companies WHERE batch_id=$1 AND user_id=$2 AND paso1_estado <> 'descartado' AND id = ANY($3::int[]) ORDER BY id ASC`
      : `SELECT * FROM cantera_companies WHERE batch_id=$1 AND user_id=$2 AND paso1_estado <> 'descartado' AND paso2_estado='pendiente' ORDER BY id ASC`,
    Array.isArray(companyIds) && companyIds.length ? [batchId, uid, companyIds] : [batchId, uid]);

  let done = 0, errores = 0, costoTotal = 0;
  for (const company of companies) {
    try {
      const { rows: contactos } = await pool.query(`SELECT * FROM cantera_contacts WHERE company_id=$1 AND user_id=$2`, [company.id, uid]);
      const { parsed, cost } = await validateCompany(pool, uid, batch, company, contactos);
      costoTotal += cost;

      const tierClave = String(parsed.tier_clave || '').trim();
      const aprobado = !!tierClave;
      await pool.query(`
        UPDATE cantera_companies SET
          paso2_estado=$1, tier_clave=$2, confianza=$3, evidencia=$4::jsonb, motivo_descarte=$5, validado_at=NOW()
        WHERE id=$6`,
        [aprobado ? 'aprobado' : 'descartado', tierClave, String(parsed.confianza || ''),
         JSON.stringify(parsed.evidencia || []), String(parsed.motivo_descarte || ''), company.id]);

      // Empareja cada contacto importado con su resultado por CARGO (mismo orden/texto
      // que se le mandó al modelo) — si no calza ninguno, queda pendiente sin tocar.
      const usados = new Set();
      for (const res of (parsed.contactos || [])) {
        const match = contactos.find(c => !usados.has(c.id) && (c.cargo || '').trim().toLowerCase() === (res.cargo || '').trim().toLowerCase());
        if (!match) continue;
        usados.add(match.id);
        await pool.query(`UPDATE cantera_contacts SET puesto_estado=$1, puesto_motivo=$2 WHERE id=$3`,
          [['decide', 'respaldo', 'descartado'].includes(res.puesto_estado) ? res.puesto_estado : 'pendiente', String(res.motivo || ''), match.id]);
      }
      done++;
    } catch (e) {
      errores++;
      await pool.query(`UPDATE cantera_companies SET paso2_estado='error', motivo_descarte=$1 WHERE id=$2`, [String(e.message).slice(0, 400), company.id]);
    }
    if (onProgress) onProgress({ done: done + errores, total: companies.length });
  }
  return { total: companies.length, done, errores, costoTotal };
}

module.exports = { runBatchValidation, validateCompany };
