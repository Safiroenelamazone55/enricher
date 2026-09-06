'use strict';

/**
 * webSearchService.js — búsqueda en internet propia, independiente de
 * cualquier proveedor de IA. Existe porque Claude trae su búsqueda ya
 * integrada y operada por Anthropic, pero otros modelos (ej. Kimi-K3 vía
 * NVIDIA) solo saben "pedir usar una herramienta" sin tener ninguna
 * conectada — si el motor de Cantera va a poder correr con cualquier
 * modelo que soporte tool calling, la búsqueda tiene que ser nuestra, no
 * de un proveedor de IA en particular (pedido explícito 2026-09-06: "no
 * debe ser solo para Claude").
 *
 * Usa Brave Search API (BRAVE_API_KEY en el .env del servidor).
 */

async function webSearch(query, count = 5) {
  if (!process.env.BRAVE_API_KEY) throw new Error('Falta BRAVE_API_KEY en el entorno');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, Math.max(1, count))}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
  });
  if (!resp.ok) throw new Error(`Brave Search error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return (data.web?.results || []).map(r => ({ titulo: r.title, url: r.url, descripcion: r.description }));
}

module.exports = { webSearch };
