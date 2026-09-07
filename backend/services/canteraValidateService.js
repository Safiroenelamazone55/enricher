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
// Tarifas por modelo (USD por millón de tokens) — pedido explícito 2026-09-06:
// "siempre tener un modelo asignado... por cliente", no uno fijo. Un modelo
// sin tarifa confirmada aquí reporta costo 0 en vez de inventar un número
// (mismo criterio ya usado para Kimi).
const RATES = {
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'gemini-3.1-pro-preview': { in: 2, out: 12 },
  'gemini-3.7-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash': { in: 1.5, out: 9 },
};
const NVIDIA_MODEL = 'moonshotai/kimi-k3';
const { webSearch } = require('./webSearchService');

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
3. RECOLECTA evidencia de al menos 5 FUENTES independientes cuando existan (sitio oficial, LinkedIn, noticias/prensa, ofertas de empleo activas, registros públicos, directorios de industria). Una FUENTE es un origen distinto de información — no cada página individual dentro del mismo sitio. Visitar 5 páginas distintas del sitio web oficial (Inicio, Nosotros, Servicios, Equipo, Noticias) cuenta como UNA sola fuente, no cinco. Cuando el sitio web oficial sea relevante, revisa TODAS sus páginas relevantes antes de darlo por agotado — no te quedes solo en la portada. Prioriza fuentes oficiales y recientes sobre agregadores de terceros — los directorios tipo Crunchbase/ZoomInfo pueden estar desactualizados o mal categorizados; trátalos como pista, nunca como prueba final. Si después de una búsqueda exhaustiva no existen 5 fuentes distintas para esta empresa (empresas pequeñas o con poca presencia digital), dilo explícitamente y baja la confianza en vez de forzar el número.
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
- "alta": 5 o más fuentes independientes confirman el criterio decisivo del Tier, incluyendo al menos una fuente primaria (sitio oficial, comunicado propio, oferta de empleo activa).
- "media": evidencia razonable pero incompleta — entre 3 y 4 fuentes, o fuentes indirectas que apuntan al criterio sin confirmarlo del todo.
- "baja": 1 o 2 fuentes, o ninguna fuente directa del criterio decisivo; clasificaste por indicios razonables pero sin confirmación sólida.

- Estás investigando UNA sola empresa en esta llamada — no hay lote ni presión de tiempo. Tómate los usos de web_search que necesites (hasta el límite disponible) antes de decidir; una respuesta rápida pero mal verificada es peor que una que tardó más. No hay ninguna ventaja en responder rápido — la única métrica que importa es que cada afirmación esté respaldada por lo que de verdad encontraste.

CRITERIO DE CALIFICACIÓN (definido por el cliente para este borrador):

PERFIL DE CLIENTE IDEAL (ICP):
${batch.icp || '(sin ICP definido)'}

TIERS (ángulos del ICP — clasifica en el que mejor calce; si no calza en ninguno, es "descartada"):
${_tiersBlock(batch.tiers)}

PUESTOS A CONTACTAR POR TIER (para decidir prioridad de contacto una vez clasificada la empresa):
${_puestosBlock(batch.puestos, batch.tiers)}

PRIORIDAD (qué tan urgente es trabajar esta empresa AHORA frente a las demás calificadas — no confundir con el Tier, que es a qué segmento pertenece):
- "alta": calificó con margen claro en su Tier (no por poco) Y tiene al menos un contacto "decide" identificado.
- "baja": calificó por un margen ajustado, o solo hay contactos "respaldo" disponibles (ningún "decide"), o se descartó.
- "media": los demás casos.

NOTA (resumen, SIEMPRE obligatorio, tanto si calificó como si se descartó): una o dos frases que cualquiera pueda leer sin abrir la evidencia completa — qué hace la empresa y por qué calificó (o por qué no). Nunca la dejes vacía.

FORMATO DE SALIDA — responde ÚNICAMENTE un objeto JSON válido, sin texto ni fences alrededor, con esta forma exacta:
{
  "tier_clave": "TIER_1A o vacío si se descarta",
  "confianza": "alta | media | baja",
  "prioridad": "alta | media | baja",
  "nota": "resumen breve y útil en una o dos frases — nunca vacío",
  "evidencia": [{"fuente": "nombre de la fuente", "url": "https://...", "resumen": "qué dice y por qué importa"}],
  "motivo_descarte": "vacío si calificó; si no, la razón exacta y específica a ESTA empresa",
  "contactos": [{"cargo": "el cargo tal como aparece en la lista que te paso", "puesto_estado": "decide | respaldo | descartado", "motivo": "por qué, especialmente si se descarta un cargo parecido"}]
}
El array "contactos" debe traer EXACTAMENTE los cargos que te paso abajo, uno por uno, en el mismo orden — nunca inventes contactos nuevos ni los omitas.`;
}

// El prompt de usuario (los datos crudos de la empresa) es igual sin importar
// qué modelo investigue — solo cambia el "cerebro" y quién ejecuta la
// búsqueda, nunca el criterio ni los datos que se le entregan.
function _buildUserPrompt(company, contactos) {
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
  return `EMPRESA A INVESTIGAR:\n${datos}\n\nCARGOS DE LOS CONTACTOS IMPORTADOS PARA ESTA EMPRESA (clasifica cada uno):\n${cargos}\n\nInvestiga y devuelve el JSON.`;
}

// Despachador — el motor de IA es una elección por borrador (batch.motor_ia,
// pedido explícito 2026-09-06: "no debe ser solo para Claude"), no algo fijo
// en el código. El prompt fijo (_buildSystemPrompt) y el formato de salida
// son EXACTAMENTE los mismos para cualquier motor — lo único que cambia es
// quién razona y quién ejecuta la búsqueda real en internet.
//
// La CLAVE a usar es por cliente outbound (cantera_provider_keys, pedido
// explícito 2026-09-06: "no quiero estarlo actualizando aquí... quiero crear
// varios en Gemini por proyecto, uno para cada cliente"). Si el borrador no
// tiene cliente asignado o el cliente no configuró una clave para ese motor,
// se usa la variable de entorno global — el comportamiento de siempre sigue
// intacto para quien no use este sistema nuevo.
async function _resolveProviderKey(pool, uid, batch, motor) {
  if (!batch.outbound_client_id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM cantera_provider_keys WHERE user_id=$1 AND outbound_client_id=$2 AND provider=$3 AND activo=true`,
    [uid, batch.outbound_client_id, motor]);
  return rows[0] || null;
}
async function _registrarGasto(pool, keyRow, cost) {
  if (!keyRow || !cost) return;
  await pool.query(`UPDATE cantera_provider_keys SET gasto_acumulado = gasto_acumulado + $1 WHERE id=$2`, [cost, keyRow.id]);
}
async function validateCompany(pool, uid, batch, company, contactos) {
  const motor = ['kimi', 'gemini'].includes(batch.motor_ia) ? batch.motor_ia : 'claude';
  const keyRow = await _resolveProviderKey(pool, uid, batch, motor);
  if (keyRow && keyRow.limite_usd > 0 && Number(keyRow.gasto_acumulado) >= Number(keyRow.limite_usd)) {
    throw new Error(`Límite de $${keyRow.limite_usd} USD alcanzado para este cliente en ${motor} — sube el límite en Configuración o cambia de motor.`);
  }
  const apiKey = keyRow?.api_key || '';
  const modelo = keyRow?.modelo || '';
  const result = motor === 'kimi' ? await _validateCompanyKimi(batch, company, contactos, apiKey)
    : motor === 'gemini' ? await _validateCompanyGemini(batch, company, contactos, apiKey, modelo)
    : await _validateCompanyClaude(batch, company, contactos, apiKey, modelo);
  await _registrarGasto(pool, keyRow, result.cost);
  return result;
}

async function _validateCompanyClaude(batch, company, contactos, apiKeyOverride, modelOverride) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { throw new Error('Falta @anthropic-ai/sdk (npm install en backend)'); }
  const apiKey = apiKeyOverride || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY (global o por cliente en Configuración)');
  const client = new Anthropic({ apiKey });
  const model = modelOverride || MODEL;

  const system = _buildSystemPrompt(batch);
  const user = _buildUserPrompt(company, contactos);

  const resp = await client.messages.create({
    model, max_tokens: 8000, system,
    thinking: { type: 'adaptive' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 20 }],
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

// Kimi-K3 (vía NVIDIA) no trae búsqueda en internet incorporada como Claude
// — solo sabe "pedir usar una herramienta". La búsqueda real la ejecutamos
// nosotros (webSearchService, Brave Search) cada vez que el modelo la pide,
// en un ciclo manual de ida-y-vuelta (formato estándar de function calling
// tipo OpenAI: choices[0].message.tool_calls / role:"tool"). Mismo prompt
// fijo, mismo límite de búsquedas (20) y mismo formato de salida que Claude.
async function _nvidiaChat(messages, tools, apiKey) {
  if (!apiKey) throw new Error('Falta NVIDIA_API_KEY (global o por cliente en Configuración)');
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: NVIDIA_MODEL, messages, tools, tool_choice: 'auto', max_tokens: 8000, temperature: 1, reasoning_effort: 'max' }),
  });
  if (!resp.ok) throw new Error(`NVIDIA API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}
async function _validateCompanyKimi(batch, company, contactos, apiKeyOverride) {
  const apiKey = apiKeyOverride || process.env.NVIDIA_API_KEY;
  const system = _buildSystemPrompt(batch);
  const user = _buildUserPrompt(company, contactos);
  const tools = [{
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Busca en internet y devuelve una lista de resultados (título, url, descripción) para la consulta dada. Úsala cuantas veces necesites antes de decidir.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Los términos de búsqueda' } }, required: ['query'] },
    },
  }];
  let messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let totalIn = 0, totalOut = 0, searches = 0;
  const MAX_ROUNDS = 10, MAX_SEARCHES = 20;
  let finalText = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await _nvidiaChat(messages, tools, apiKey);
    const choice = resp.choices?.[0];
    if (!choice) throw new Error('Respuesta vacía de NVIDIA/Kimi-K3');
    totalIn += resp.usage?.prompt_tokens || 0;
    totalOut += resp.usage?.completion_tokens || 0;
    messages.push(choice.message);
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      finalText = choice.message.content || '';
      break;
    }
    for (const tc of choice.message.tool_calls) {
      if (searches >= MAX_SEARCHES) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Límite de búsquedas alcanzado — decide con la evidencia que ya reuniste.' });
        continue;
      }
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args vacíos si el modelo mandó algo inválido */ }
      let results;
      try { results = await webSearch(args.query || company.nombre, 5); }
      catch (e) { results = [{ error: e.message }]; }
      searches++;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(results) });
    }
  }
  let parsed;
  try { parsed = JSON.parse(_extractJson(finalText)); } catch (e) { throw new Error('El modelo no devolvió JSON válido: ' + e.message); }
  // NVIDIA NIM todavía no tiene un precio confirmado para Kimi-K3 en nuestra
  // tabla de tarifas — se reporta el costo en 0 en vez de inventar un número.
  // Cuando se confirme el precio real, agregarlo a RATES y calcular aquí igual
  // que con Claude.
  return { parsed, cost: 0, model: NVIDIA_MODEL, inputTokens: totalIn, outputTokens: totalOut };
}

// Gemini 3 Pro — a diferencia de Kimi, SÍ trae búsqueda real integrada
// (herramienta "google_search", la ejecuta Google mismo del lado del
// servidor) — no necesita nuestra búsqueda propia. Precio de referencia:
// $2/$12 por millón de tokens (confirmado 2026-09), calculado aquí mismo
// porque no viene en la respuesta de la API.
// gemini-3-pro-preview fue retirado por Google (confirmado 2026-09-07 por el
// propio error 404 de la API, que recomendó explícitamente este reemplazo) —
// si vuelve a pasar con otro modelo, el error real de Google siempre queda
// visible en motivo_descarte, nunca se traga en silencio.
const GEMINI_MODEL = 'gemini-3.1-pro-preview';
async function _validateCompanyGemini(batch, company, contactos, apiKeyOverride, modelOverride) {
  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta GEMINI_API_KEY (global o por cliente en Configuración)');
  const model = modelOverride || GEMINI_MODEL;
  const system = _buildSystemPrompt(batch);
  const user = _buildUserPrompt(company, contactos);
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!resp.ok) throw new Error(`Gemini API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const texto = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n').trim();
  if (!texto) throw new Error('Gemini no devolvió texto — posible bloqueo de contenido o error silencioso: ' + JSON.stringify(data).slice(0, 300));
  let parsed;
  try { parsed = JSON.parse(_extractJson(texto)); } catch (e) { throw new Error('El modelo no devolvió JSON válido: ' + e.message); }
  const inTok = data.usageMetadata?.promptTokenCount || 0;
  const outTok = data.usageMetadata?.candidatesTokenCount || 0;
  const rate = RATES[model] || RATES[GEMINI_MODEL];
  const cost = (inTok * rate.in + outTok * rate.out) / 1e6;
  return { parsed, cost, model, inputTokens: inTok, outputTokens: outTok };
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
  // de calificación nuevo sin tener que reabrir cada empresa a mano. Tampoco
  // filtra por paso1_estado (pedido explícito 2026-09-07: "no importa si es
  // descartado en el paso 1... si quiero omitirlas, las ocultaría con el
  // filtro" antes de seleccionar) — una selección manual siempre se respeta
  // tal cual. Ese filtro solo aplica al modo automático (sin selección).
  const { rows: companies } = await pool.query(
    Array.isArray(companyIds) && companyIds.length
      ? `SELECT * FROM cantera_companies WHERE batch_id=$1 AND user_id=$2 AND id = ANY($3::int[]) ORDER BY id ASC`
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
          paso2_estado=$1, tier_clave=$2, confianza=$3, evidencia=$4::jsonb, motivo_descarte=$5, prioridad=$6, nota_manual=$7, validado_at=NOW()
        WHERE id=$8`,
        [aprobado ? 'aprobado' : 'descartado', tierClave, String(parsed.confianza || ''),
         JSON.stringify(parsed.evidencia || []), String(parsed.motivo_descarte || ''),
         String(parsed.prioridad || ''), String(parsed.nota || ''), company.id]);

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
