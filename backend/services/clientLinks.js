'use strict';
// Registro "qué empresas y contactos pertenecen a qué cliente" (lm_company_clients / lm_contact_clients)
// y la regla "este contacto ya fue contactado por ESTE cliente".
//
// Modelo (pedido explícito 2026-10-26):
//  · Una empresa existe UNA sola vez en el CRM y puede estar asociada a varios clientes, sin duplicarse.
//  · Un contacto existe una sola vez, puede estar en varias secuencias/campañas/clientes.
//  · Un contacto ya contactado por un cliente NO se vuelve a contactar para ese mismo cliente
//    (ni en otra secuencia suya). Para OTRO cliente sí se permite (se informa).
//
// "Contactado por el cliente X" = hay un mensaje enviado, o un paso hecho (paso>1, respondió o terminó),
// en una secuencia de X. Es deliberadamente conservador: un falso positivo es preferible a escribir dos veces.

async function linkCompany(q, uid, companyId, clientId, source) {
  if (!companyId || !clientId) return;
  await q.query(
    `INSERT INTO lm_company_clients (user_id, company_id, outbound_client_id, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, outbound_client_id) DO NOTHING`, [uid, companyId, clientId, source || '']);
}

async function linkContact(q, uid, contactId, clientId, source) {
  if (!contactId || !clientId) return;
  await q.query(
    `INSERT INTO lm_contact_clients (user_id, contact_id, outbound_client_id, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (contact_id, outbound_client_id) DO NOTHING`, [uid, contactId, clientId, source || '']);
}

// Contactos (de la lista) que YA fueron contactados por el cliente, o que están en marcha en otra
// secuencia suya. Devuelve Map(contactId → { motivo: 'contactado'|'en_secuencia', fecha, canal, sequence_id, secuencia }).
// opts.excludeSequenceId: ignora esa secuencia (la de destino: de eso ya se ocupa el "ya enrolado").
async function blockedByClient(q, uid, contactIds, clientId, opts) {
  const out = new Map();
  const ids = (contactIds || []).filter(Boolean);
  if (!ids.length || !clientId) return out;
  const exSeq = (opts && opts.excludeSequenceId) || null;

  // 1) Mensajes enviados desde una secuencia de este cliente.
  const msgs = (await q.query(
    `SELECT DISTINCT ON (m.contact_id) m.contact_id, m.sent_at AS fecha, m.sequence_id, s.nombre AS secuencia
       FROM lm_messages m JOIN sequences s ON s.id = m.sequence_id
      WHERE m.user_id=$1 AND m.contact_id = ANY($2::int[]) AND s.outbound_client_id=$3
        AND ($4::int IS NULL OR s.id <> $4) AND m.sent_at IS NOT NULL AND m.estado IN ('sent','replied','bounced')
      ORDER BY m.contact_id, m.sent_at DESC`, [uid, ids, clientId, exSeq])).rows;
  msgs.forEach(r => out.set(r.contact_id, { motivo: 'contactado', fecha: r.fecha, canal: 'email', sequence_id: r.sequence_id, secuencia: r.secuencia }));

  // 2) Inscripciones de este cliente: con avance (paso>1 / respondió / terminó) = contactado; activas o pausadas = en secuencia.
  const enr = (await q.query(
    `SELECT DISTINCT ON (cs.contact_id) cs.contact_id, cs.sequence_id, s.nombre AS secuencia, cs.estado, cs.paso,
            COALESCE(cs.paso_date::timestamptz, cs.next_action_at, cs.created_at) AS fecha
       FROM lm_contact_sequences cs JOIN sequences s ON s.id = cs.sequence_id
      WHERE cs.user_id=$1 AND cs.contact_id = ANY($2::int[]) AND s.outbound_client_id=$3 AND ($4::int IS NULL OR s.id <> $4)
      ORDER BY cs.contact_id, (cs.paso > 1 OR cs.estado IN ('respondido','terminado')) DESC, cs.created_at DESC`, [uid, ids, clientId, exSeq])).rows;
  for (const r of enr) {
    const avanzo = r.paso > 1 || r.estado === 'respondido' || r.estado === 'terminado';
    if (avanzo) { if (!out.has(r.contact_id)) out.set(r.contact_id, { motivo: 'contactado', fecha: r.fecha, canal: '', sequence_id: r.sequence_id, secuencia: r.secuencia }); }
    else if (['activo', 'pausado'].includes(r.estado) && !out.has(r.contact_id)) out.set(r.contact_id, { motivo: 'en_secuencia', fecha: r.fecha, canal: '', sequence_id: r.sequence_id, secuencia: r.secuencia });
  }
  return out;
}

module.exports = { linkCompany, linkContact, blockedByClient };
