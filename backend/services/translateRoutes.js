// Traductor integrado (WhatsApp, plantillas, pasos de secuencia).
// Usa Cloudflare Workers AI por REST desde este backend: plan gratuito (cuota diaria incluida), sin recargas ni saldo prepago.
// Entorno: CF_AI_TOKEN (token de API con permiso "Workers AI"), CF_ACCOUNT_ID (opcional, hay un valor por defecto),
//          CF_AI_MODEL (opcional).
// Las variables {{...}} se protegen con marcadores antes de enviar el texto y se restauran después; si el modelo no
// devuelve todos los marcadores, se reintenta y, si sigue fallando, se rechaza (nunca se devuelve texto con variables rotas).

const ACCOUNT = process.env.CF_ACCOUNT_ID || '1ccea266c34bd258145f6e001271d214';
const MODEL = process.env.CF_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LANGS = { en: 'English', es: 'Spanish (neutral Latin American)', pt: 'Portuguese (Brazilian)', fr: 'French', de: 'German', it: 'Italian' };
const KIND = {
  whatsapp: 'a WhatsApp chat message between business contacts: natural, warm and professional, short sentences, keep line breaks and emojis as they are',
  email: 'a professional outreach email body: clear, courteous, natural for a native speaker, keep paragraphs and line breaks',
  subject: 'an email subject line: short, natural, no quotation marks and no final period',
  linkedin: 'a LinkedIn message: concise, friendly and professional',
};
const hits = new Map(); // límite por usuario: 40 traducciones por minuto

function limited(uid) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(uid, arr);
  return arr.length > 40;
}

async function runModel(system, user) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.CF_AI_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1400, temperature: 0.1 }),
  });
  let j = null; try { j = await r.json(); } catch (_) { /* sin cuerpo */ }
  if (!r.ok || !j || j.success === false) {
    const msg = (j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status);
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const out = j.result && (j.result.response != null ? j.result.response : (j.result.choices && j.result.choices[0] && j.result.choices[0].message && j.result.choices[0].message.content));
  return String(out == null ? '' : out).trim();
}

function mount(app, { requireAuth }) {
  app.post('/api/translate', requireAuth, async (req, res) => {
    try {
      if (!process.env.CF_AI_TOKEN) return res.status(503).json({ error: 'El traductor aún no está configurado en el servidor (falta CF_AI_TOKEN).' });
      const b = req.body || {};
      const text = String(b.text || '');
      const target = LANGS[b.target] ? b.target : null;
      const kind = KIND[b.kind] ? b.kind : 'email';
      if (!text.trim()) return res.status(400).json({ error: 'No hay texto para traducir' });
      if (!target) return res.status(400).json({ error: 'Idioma de destino no válido' });
      if (text.length > 4000) return res.status(400).json({ error: 'El texto es demasiado largo (máximo 4000 caracteres)' });
      if (limited(req.workspaceOwnerId)) return res.status(429).json({ error: 'Demasiadas traducciones seguidas; espera un momento' });

      // proteger variables {{...}}
      const vars = [];
      const protectedText = text.replace(/\{\{[^{}\n]*\}\}/g, m => { vars.push(m); return `⟦${vars.length}⟧`; });
      const system = `You are a professional translator. Translate the user's text into ${LANGS[target]}. The text is ${KIND[kind]}.\n`
        + 'Rules: (1) Output ONLY the translation, with no quotes, notes or explanations. (2) Preserve the meaning, tone and register; do not add or remove information. '
        + '(3) Keep every marker like ⟦1⟧ ⟦2⟧ exactly as written, once each, in a natural position for the target language; never translate or alter them. '
        + '(4) Do not translate names of people, companies, products, URLs, emails or numbers. (5) Keep line breaks, bullet points and emojis. '
        + '(6) If the text is already entirely in the target language, return it unchanged.';

      const check = out => vars.every((_, i) => (out.split(`⟦${i + 1}⟧`).length - 1) === 1);
      let out = await runModel(system, protectedText);
      if (!check(out)) out = await runModel(system + '\nIMPORTANT: the previous attempt lost or duplicated a ⟦n⟧ marker. Include each marker exactly once.', protectedText);
      if (!out) return res.status(502).json({ error: 'El traductor no devolvió texto' });
      if (!check(out)) return res.status(502).json({ error: 'No se pudo traducir conservando las variables; inténtalo de nuevo' });
      out = out.replace(/^["“«]\s*|\s*["”»]$/g, (m, off) => (text.trim().startsWith(m.trim()) ? m : ''));
      vars.forEach((v, i) => { out = out.split(`⟦${i + 1}⟧`).join(v); });
      res.json({ text: out, target });
    } catch (err) {
      const quota = err.status === 429 || /neuron|limit|quota/i.test(err.message || '');
      console.error('[translate]', err.message);
      res.status(quota ? 429 : 500).json({ error: quota ? 'Se agotó la cuota gratuita de hoy del traductor; vuelve a intentarlo mañana.' : 'No se pudo traducir ahora mismo' });
    }
  });
}

module.exports = { mount };
