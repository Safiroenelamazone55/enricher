// ─────────────────────────────────────────────────────────────────────
// AI Personalize Service — el diferenciador premium (Fable 5 + Haiku)
//
// Ruteo por valor (disciplina de costo):
//   · tier 'alto'    → claude-fable-5  (investiga a fondo + copy premium;
//                       effort high, thinking siempre on, refusal fallbacks a Opus)
//   · tier 'volumen' → claude-haiku-4-5 (rápido y barato; SIN effort — Haiku lo rechaza)
//
// Genera un borrador estructurado {asunto, cuerpo, notas} anclado en los datos
// reales del contacto/empresa (y en el ángulo base del paso si existe). Se guarda
// en lm_ai_drafts con status='draft' — Jenny revisa/edita y aprueba; el motor de
// envío solo usa borradores 'approved'. Presupuesto mensual en USD por workspace.
//
// Requiere ANTHROPIC_API_KEY en el entorno. Cola en memoria con concurrencia 1.
// ─────────────────────────────────────────────────────────────────────

const MODEL_HIGH   = 'claude-fable-5';
const MODEL_VOLUME = 'claude-haiku-4-5';

// Precios por 1M tokens (input / output) — para estimar costo y el presupuesto.
const RATES = {
  'claude-fable-5':   { in: 10, out: 50 },
  'claude-opus-4-8':  { in: 5,  out: 25 },
  'claude-haiku-4-5': { in: 1,  out: 5 },
};

const _queue = [];
const _queued = new Set();        // dedupe por `${contactId}:${stepId}`
let _working = false;

function queueSize() { return _queue.length + (_working ? 1 : 0); }

function _key(contactId, stepId) { return `${contactId}:${stepId || 0}`; }

function queuePersonalize(pool, userId, items) {
  // items: [{ contactId, stepId, sequenceId, tier }]
  let added = 0;
  for (const it of items) {
    const k = _key(it.contactId, it.stepId);
    if (_queued.has(k)) continue;
    _queued.add(k);
    _queue.push({ userId, ...it });
    added++;
  }
  if (added && !_working) _drain(pool).catch(e => console.warn('[ai-personalize] drain:', e.message));
  return { queued: added, pending: queueSize() };
}

async function _drain(pool) {
  _working = true;
  try {
    while (_queue.length) {
      const job = _queue.shift();
      try { await _personalizeOne(pool, job); }
      catch (e) { console.warn(`[ai-personalize] contacto ${job.contactId}:`, e.message); }
      finally { _queued.delete(_key(job.contactId, job.stepId)); }
    }
  } finally { _working = false; }
}

// Gasto del mes en curso (para el presupuesto).
async function _spentThisMonth(pool, userId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd),0)::float AS spent FROM lm_ai_drafts
      WHERE user_id=$1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
    [userId]
  );
  return r.spent || 0;
}

async function getSettings(pool, userId) {
  const { rows } = await pool.query(`SELECT * FROM lm_ai_settings WHERE user_id=$1`, [userId]);
  const s = rows[0] || {
    user_id: userId, enabled: true, monthly_budget_usd: 20,
    model_high: MODEL_HIGH, model_volume: MODEL_VOLUME, idioma: 'auto',
  };
  s.spent_month = await _spentThisMonth(pool, userId);
  return s;
}

// Decide el tier de un contacto si no viene explícito (cuenta de alto valor).
function _autoTier(c) {
  const tier = (c.target_tier || '').toLowerCase();
  const prio = (c.contact_priority || '').toLowerCase();
  if (/(tier\s*1|alto|high|a\b|estratég|priorit)/.test(tier + ' ' + prio)) return 'alto';
  return 'volumen';
}

async function _personalizeOne(pool, job) {
  const { userId, contactId, stepId, sequenceId } = job;
  const cfg = await getSettings(pool, userId);
  if (cfg.enabled === false) throw new Error('IA desactivada en configuración');

  // Presupuesto: si ya se pasó, no gastar más.
  if (cfg.spent_month >= Number(cfg.monthly_budget_usd)) {
    await _saveError(pool, userId, contactId, stepId, sequenceId,
      `Presupuesto mensual agotado ($${cfg.monthly_budget_usd})`);
    return;
  }

  const { rows: [c] } = await pool.query(`
    SELECT k.id, k.nombre, k.apellido, k.email, k.cargo, k.seniority, k.departamento,
           k.empresa_nombre, k.ciudad, k.pais, k.linkedin, k.target_tier, k.contact_priority,
           k.buyer_role, co.nombre AS company_nombre, co.industria, co.tamano, co.website,
           co.descripcion, co.tecnologias, co.funding, co.pais AS company_pais
      FROM lm_contacts k
      LEFT JOIN lm_companies co ON co.id = k.company_id
     WHERE k.id=$1 AND k.user_id=$2
  `, [contactId, userId]);
  if (!c) return;

  const tier  = job.tier || _autoTier(c);
  const model = tier === 'alto' ? (cfg.model_high || MODEL_HIGH) : (cfg.model_volume || MODEL_VOLUME);

  // Ángulo base: reutiliza el paso de la secuencia (oferta real de Jenny) si existe.
  let baseAsunto = '', baseCuerpo = '';
  if (stepId) {
    const { rows: [st] } = await pool.query(
      `SELECT titulo, plantilla FROM sequence_steps WHERE id=$1`, [stepId]);
    if (st) { baseAsunto = st.titulo || ''; baseCuerpo = st.plantilla || ''; }
  }

  const result = await _callModel(model, tier, cfg, c, baseAsunto, baseCuerpo);

  const rate = RATES[result.servedModel] || RATES[model] || { in: 1, out: 5 };
  const cost = (result.inputTokens * rate.in + result.outputTokens * rate.out) / 1e6;

  await pool.query(`
    INSERT INTO lm_ai_drafts
      (user_id, contact_id, step_id, sequence_id, tier, model, asunto, cuerpo, research_notes,
       input_tokens, output_tokens, cost_usd, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
  `, [userId, contactId, stepId || null, sequenceId || null, tier, result.servedModel || model,
      result.asunto, result.cuerpo, result.notas,
      result.inputTokens, result.outputTokens, cost]);
  console.log(`[ai-personalize] ${c.nombre} ${c.apellido} · ${tier}/${result.servedModel} · $${cost.toFixed(4)}`);
}

async function _saveError(pool, userId, contactId, stepId, sequenceId, msg) {
  await pool.query(`
    INSERT INTO lm_ai_drafts (user_id, contact_id, step_id, sequence_id, status, error)
    VALUES ($1,$2,$3,$4,'discarded',$5)
  `, [userId, contactId, stepId || null, sequenceId || null, msg.slice(0, 400)]);
}

function _contactFacts(c) {
  const L = [];
  const add = (k, v) => { if (v) L.push(`${k}: ${v}`); };
  add('Nombre', [c.nombre, c.apellido].filter(Boolean).join(' '));
  add('Cargo', c.cargo); add('Seniority', c.seniority); add('Departamento', c.departamento);
  add('Rol de compra', c.buyer_role);
  add('Empresa', c.company_nombre || c.empresa_nombre);
  add('Industria', c.industria); add('Tamaño', c.tamano);
  add('Ubicación', [c.ciudad, c.pais || c.company_pais].filter(Boolean).join(', '));
  add('Web', c.website);
  add('Descripción empresa', c.descripcion);
  add('Tecnologías', c.tecnologias); add('Funding', c.funding);
  return L.join('\n');
}

// Extrae el primer objeto JSON de un texto (tolera fences ```json o texto alrededor).
function _extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

function _sumUsage(u) {
  return {
    in: (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0),
    out: u?.output_tokens || 0,
  };
}

async function _callModel(model, tier, cfg, contact, baseAsunto, baseCuerpo) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { throw new Error('Falta @anthropic-ai/sdk (npm install en backend)'); }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en el entorno');
  const client = new Anthropic();

  const idioma = cfg.idioma && cfg.idioma !== 'auto'
    ? `Escribe SIEMPRE en ${cfg.idioma}.`
    : 'Escribe en el idioma apropiado para el contacto (español para LATAM/España; inglés en otros casos), salvo señal clara de otro idioma.';

  // Solo el tier ALTO investiga en internet (Fable) — el volumen se ancla en los
  // datos importados para mantenerlo barato.
  const useWeb = tier === 'alto';

  const system =
    `Eres un SDR experto en cold outreach B2B. Escribes emails breves, humanos y personalizados que consiguen respuesta. ` +
    `${idioma} Prohibido: relleno, adulación genérica, "espero que estés bien", promesas vagas, más de ~120 palabras en el cuerpo. ` +
    `Ancla la personalización en datos concretos y verificables del contacto/empresa. Un solo CTA claro y de baja fricción. Sin placeholders tipo {{...}}: usa datos reales. ` +
    (useWeb
      ? `Antes de escribir, INVESTIGA en internet (web_search) la empresa y a la persona: noticias recientes, iniciativas, stack, señales de crecimiento — y úsalo como gancho concreto. No inventes datos: si no encuentras algo verificable, usa lo que ya tienes. `
      : ``) +
    `Devuelve ÚNICAMENTE un objeto JSON válido, sin texto ni fences alrededor, con esta forma exacta: ` +
    `{"asunto": "...", "cuerpo": "...", "notas": "..."} — notas = 1-2 frases de en qué te basaste (cita la señal encontrada).`;

  const base = (baseAsunto || baseCuerpo)
    ? `\n\nÁNGULO/OFERTA BASE (personalízala, no la cites literal):\nAsunto base: ${baseAsunto}\nCuerpo base: ${baseCuerpo}`
    : '\n\nNo hay ángulo base: propón uno relevante para el cargo y la industria.';

  const user =
    `Contacto a personalizar:\n${_contactFacts(contact)}${base}\n\nEscribe el email listo para enviar a esta persona.`;

  const isFable = (model === 'claude-fable-5' || model === 'claude-mythos-5');
  const baseReq = { model, max_tokens: 2500, system };
  if (useWeb) baseReq.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }];
  if (isFable) {
    // Fable 5: thinking siempre on (omitir el parámetro), effort en output_config,
    // y refusal fallbacks a Opus 4.8 por defecto (opt-in).
    baseReq.output_config = { effort: 'high' };
    baseReq.betas = ['server-side-fallback-2026-06-01'];
    baseReq.fallbacks = [{ model: 'claude-opus-4-8' }];
  }
  const send = req => isFable ? client.beta.messages.create(req) : client.messages.create(req);

  // Bucle por si el web_search server-side pausa el turno (pause_turn).
  let messages = [{ role: 'user', content: user }];
  let totalIn = 0, totalOut = 0, resp;
  for (let i = 0; i < 6; i++) {
    resp = await send({ ...baseReq, messages });
    const u = _sumUsage(resp.usage); totalIn += u.in; totalOut += u.out;
    if (resp.stop_reason === 'refusal') {
      throw new Error('El modelo rechazó la solicitud (safety): ' + (resp.stop_details?.category || ''));
    }
    if (resp.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: resp.content }]; continue; }
    break;
  }

  const texts = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  let parsed = { asunto: '', cuerpo: '', notas: '' };
  try { parsed = JSON.parse(_extractJson(texts)); } catch { parsed.cuerpo = texts; }

  return {
    asunto: String(parsed.asunto || '').slice(0, 300),
    cuerpo: String(parsed.cuerpo || '').slice(0, 4000),
    notas:  String(parsed.notas || '').slice(0, 600),
    inputTokens:  totalIn,
    outputTokens: totalOut,
    servedModel:  resp.model || model,
  };
}

module.exports = { queuePersonalize, queueSize, getSettings, RATES };
