'use strict';
// Agente de IA del Dashboard — como el "lemAgent" de Lemlist: responde preguntas sobre
// campañas, prospectos y secuencias leyendo los datos REALES del workspace con tool-use,
// nunca inventando cifras. Requiere ANTHROPIC_API_KEY (mismo bloqueo que el resto de la IA
// de Nova — ver aiPersonalizeService.js). Sin herramientas que escriban nada todavía: las
// acciones de "crear campaña" etc. las hace la UI normal, no el chat.
const MODEL = 'claude-sonnet-5';
const SYSTEM = 'Eres el asistente de Nova, un CRM de prospección outbound para agencias. Respondes en español, breve y directo. Usa SIEMPRE las herramientas para cualquier cifra o dato — nunca inventes números ni nombres. Si una herramienta no encuentra nada, dilo con claridad.';

const TOOLS = [
  {
    name: 'resumen_general',
    description: 'Totales del workspace: contactos, empresas, clientes outbound, campañas y secuencias activas, y leads por etapa (disposition).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_contactos',
    description: 'Busca contactos por nombre, empresa o cargo (y opcionalmente país). Devuelve hasta 10.',
    input_schema: { type: 'object', properties: { q: { type: 'string', description: 'texto a buscar en nombre, apellido, empresa o cargo' }, pais: { type: 'string' } }, required: ['q'] },
  },
  {
    name: 'resumen_campana',
    description: 'Busca una campaña por nombre o código (ej. C0003-MWH-S1) y da sus cifras: total de contactos del cliente, cuántos respondieron, cuántos están interesados y cuántas reuniones.',
    input_schema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  },
  {
    name: 'resumen_secuencias',
    description: 'Lista las secuencias activas del workspace con cuántos contactos tiene cada una en curso ahora mismo.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function _runTool(pool, uid, name, input) {
  if (name === 'resumen_general') {
    const [{ rows: [k] }, { rows: [camp] }, { rows: [seq] }, { rows: leads }] = await Promise.all([
      pool.query(`SELECT (SELECT COUNT(*) FROM lm_contacts WHERE user_id=$1) AS contactos, (SELECT COUNT(*) FROM lm_companies WHERE user_id=$1) AS empresas, (SELECT COUNT(*) FROM outbound_clients WHERE user_id=$1) AS clientes`, [uid]),
      pool.query(`SELECT COUNT(*)::int n FROM campaigns WHERE user_id=$1 AND estado='activa'`, [uid]),
      pool.query(`SELECT COUNT(*)::int n FROM sequences WHERE user_id=$1 AND estado='activa'`, [uid]),
      pool.query(`SELECT disposition, COUNT(*)::int n FROM lm_contacts WHERE user_id=$1 AND disposition IS NOT NULL AND disposition <> '' GROUP BY disposition ORDER BY n DESC`, [uid]),
    ]);
    return { ...k, campanas_activas: camp.n, secuencias_activas: seq.n, leads_por_etapa: leads };
  }
  if (name === 'buscar_contactos') {
    const q = `%${String(input.q || '').toLowerCase()}%`;
    const params = input.pais ? [uid, q, input.pais] : [uid, q];
    const { rows } = await pool.query(
      `SELECT nombre, apellido, cargo, empresa_nombre, pais, disposition FROM lm_contacts
        WHERE user_id=$1 AND (LOWER(nombre||' '||COALESCE(apellido,'')) LIKE $2 OR LOWER(COALESCE(empresa_nombre,'')) LIKE $2 OR LOWER(COALESCE(cargo,'')) LIKE $2)
        ${input.pais ? 'AND LOWER(COALESCE(pais,\'\'))=LOWER($3)' : ''} ORDER BY id DESC LIMIT 10`, params);
    return { resultados: rows };
  }
  if (name === 'resumen_campana') {
    const q = `%${String(input.nombre || '').toLowerCase()}%`;
    const { rows: [c] } = await pool.query(`SELECT id, nombre, codigo, estado, outbound_client_id FROM campaigns WHERE user_id=$1 AND (LOWER(nombre) LIKE $2 OR LOWER(COALESCE(codigo,'')) LIKE $2) LIMIT 1`, [uid, q]);
    if (!c) return { error: 'No encontré ninguna campaña con ese nombre o código.' };
    const { rows: [st] } = await pool.query(
      `SELECT COUNT(DISTINCT k.id)::int AS total_contactos,
              COUNT(DISTINCT k.id) FILTER (WHERE k.disposition='respondio')::int AS respondio,
              COUNT(DISTINCT k.id) FILTER (WHERE k.disposition='interesado')::int AS interesado,
              COUNT(DISTINCT k.id) FILTER (WHERE k.disposition='reunion')::int AS reunion,
              COUNT(DISTINCT k.id) FILTER (WHERE k.disposition='no_contactar')::int AS no_contactar
         FROM lm_contact_clients lcc JOIN lm_contacts k ON k.id=lcc.contact_id
        WHERE lcc.outbound_client_id=$1`, [c.outbound_client_id || 0]);
    return { campana: { nombre: c.nombre, codigo: c.codigo, estado: c.estado }, stats: st };
  }
  if (name === 'resumen_secuencias') {
    const { rows } = await pool.query(
      `SELECT s.nombre, COUNT(cs.id) FILTER (WHERE cs.estado='activo')::int AS en_curso
         FROM sequences s LEFT JOIN lm_contact_sequences cs ON cs.sequence_id=s.id
        WHERE s.user_id=$1 AND s.estado='activa' GROUP BY s.id, s.nombre ORDER BY en_curso DESC LIMIT 20`, [uid]);
    return { secuencias: rows };
  }
  return { error: 'Herramienta desconocida' };
}

function mount(app, { pool, requireAuth }) {
  app.post('/api/ai/agent/chat', requireAuth, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Falta configurar la clave de IA en el servidor (ANTHROPIC_API_KEY). El resto de la IA de Nova tiene el mismo bloqueo.' });
      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk'); } catch { return res.status(500).json({ error: 'Falta @anthropic-ai/sdk en el servidor (npm install)' }); }
      const uid = req.workspaceOwnerId;
      const mensaje = String(req.body?.mensaje || '').slice(0, 2000);
      if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
      const historial = Array.isArray(req.body?.historial)
        ? req.body.historial.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }))
        : [];
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      let messages = historial.length ? historial : [{ role: 'user', content: mensaje }];
      if (historial.length && historial[historial.length - 1].content !== mensaje) messages = [...historial, { role: 'user', content: mensaje }];
      let resp = await client.messages.create({ model: MODEL, max_tokens: 1024, tools: TOOLS, system: SYSTEM, messages });
      let loops = 0;
      while (resp.stop_reason === 'tool_use' && loops < 4) {
        loops++;
        const toolUses = resp.content.filter(b => b.type === 'tool_use');
        const toolResults = [];
        for (const tu of toolUses) {
          let out; try { out = await _runTool(pool, uid, tu.name, tu.input || {}); } catch (e) { out = { error: e.message }; }
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
        }
        messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
        resp = await client.messages.create({ model: MODEL, max_tokens: 1024, tools: TOOLS, system: SYSTEM, messages });
      }
      const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || 'No tengo una respuesta para eso.';
      res.json({ respuesta: texto });
    } catch (e) { console.error('[ai-agent-chat]', e.message); res.status(500).json({ error: 'No se pudo responder: ' + e.message }); }
  });
}
module.exports = { mount };
