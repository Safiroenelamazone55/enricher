// ─────────────────────────────────────────────────────────────────────
// IMAP Watcher — vigilante de respuestas por buzón real (Mailboxes F2)
//
// Cada 3 min recorre los buzones lm_mailboxes con estado='conectado'
// (los 'solo_envio' no tienen IMAP). Por buzón:
//   1. Abre INBOX y lee SOLO lo nuevo usando un cursor UID persistido
//      (imap_uidvalidity + imap_last_uid). Primera vez: ancla el cursor
//      al final del buzón SIN procesar histórico (no inundar con correo viejo).
//   2. Parsea cada mensaje nuevo (mailparser) y lo clasifica:
//        bounce → remitente mailer-daemon/postmaster o asunto undeliverable
//        ooo    → headers Auto-Submitted/X-Autoreply o asunto out-of-office
//        reply  → lo demás
//   3. Matchea el remitente contra lm_contacts (email o email_personal) del
//      workspace. Solo guarda en lm_inbox_messages lo relevante:
//      contacto conocido (reply/ooo) o rebotes (para marcar inválidos).
//   4. Respuesta REAL de contacto → misma auto-pausa que el watcher de Gmail:
//      lm_contact_sequences='respondido', disposition='respondio',
//      pipeline estado='respondio', activity 'respuesta', y el último
//      lm_messages 'sent' de ese contacto pasa a 'replied'.
//   5. Rebote → intenta extraer el destinatario fallido del cuerpo; si es un
//      contacto: lm_messages='bounced', email_status='invalid', pausa secuencias.
//
// Un fallo en un buzón NO detiene a los demás (try/catch por buzón).
// ─────────────────────────────────────────────────────────────────────

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { decPass } = require('./mailboxService');

let _timer = null;
let _running = false;

const TICK_MS        = 3 * 60 * 1000;  // cada 3 min
const MAX_PER_TICK   = 50;             // máx mensajes nuevos procesados por buzón por tick
const MAX_SOURCE     = 512 * 1024;     // no descargar cuerpos gigantes (512 KB)
const BODY_MAX_CHARS = 20000;          // texto guardado en DB (suficiente para el Inbox)

// ── Clasificación ────────────────────────────────────────────────────
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery|maildelivery/i;
const BOUNCE_SUBJ = /undeliver|delivery (status|failure|has failed)|returned mail|mail delivery failed|failure notice|no se pudo entregar|entrega fallida/i;
const OOO_SUBJ    = /out of office|automatic reply|auto[- ]?reply|autoreply|away from|vacation|fuera de (la )?oficina|respuesta automática|ausen(te|cia)/i;

function classify(parsed) {
  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject  = parsed.subject || '';
  const headers  = parsed.headers;
  if (BOUNCE_FROM.test(fromAddr) || BOUNCE_SUBJ.test(subject)) return 'bounce';
  const autoSub = headers.get('auto-submitted');
  if (autoSub && String(autoSub).toLowerCase() !== 'no') return 'ooo';
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return 'ooo';
  if (OOO_SUBJ.test(subject)) return 'ooo';
  return 'reply';
}

// Texto plano del mensaje, sin la cola citada del hilo (líneas "> ..." y "On ... wrote:").
function cleanBody(parsed) {
  let txt = parsed.text || '';
  if (!txt && parsed.html) txt = String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const lines = String(txt).split('\n');
  const out = [];
  for (const ln of lines) {
    if (/^\s*(>|On .{5,80} wrote:|El .{5,80} escribió:)/.test(ln)) break;
    out.push(ln);
  }
  const cleaned = out.join('\n').trim();
  return (cleaned || String(txt).trim()).slice(0, BODY_MAX_CHARS);
}

// Emails candidatos dentro de un rebote (para ubicar al contacto que rebotó).
function bounceRecipients(parsed) {
  const txt = ((parsed.text || '') + ' ' + (parsed.html || '')).slice(0, 30000);
  const set = new Set();
  for (const m of txt.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!BOUNCE_FROM.test(e)) set.add(e);
  }
  return [...set].slice(0, 10);
}

// ── Efectos en el CRM ────────────────────────────────────────────────

async function _onReply(pool, mb, contact, parsed, snippet) {
  // Auto-pausa TODAS las secuencias activas del contacto (jamás seguir tras respuesta).
  const paused = await pool.query(
    `UPDATE lm_contact_sequences SET estado='respondido', paused_reason='respondio', next_action_at=NULL
      WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`,
    [mb.user_id, contact.id]
  );
  await pool.query(
    `UPDATE lm_contacts SET disposition='respondio', updated_at=NOW()
      WHERE id=$1 AND (disposition='' OR disposition IS NULL)`,
    [contact.id]
  );
  // Pipeline automático: solo hacia adelante (nuevo/contactado → respondio).
  await pool.query(
    `UPDATE lm_contacts SET estado='respondio', updated_at=NOW()
      WHERE id=$1 AND estado IN ('nuevo','contactado')`,
    [contact.id]
  );
  // Último mensaje enviado a este contacto → replied (métricas de secuencia).
  await pool.query(
    `UPDATE lm_messages SET estado='replied', replied_at=NOW()
      WHERE id = (SELECT id FROM lm_messages
                   WHERE user_id=$1 AND contact_id=$2 AND estado='sent'
                   ORDER BY sent_at DESC NULLS LAST LIMIT 1)`,
    [mb.user_id, contact.id]
  );
  await pool.query(
    `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
     VALUES ($1,$2,'respuesta','email',$3,NOW(),'hecha')`,
    [mb.user_id, contact.id,
     `Respondió a "${parsed.subject || '(sin asunto)'}"${snippet ? ' — ' + snippet.slice(0, 200) : ''}`]
  );
  console.log(`[imap-watcher] respuesta de ${contact.email} → auto-pausa (${paused.rowCount} secuencias)`);
}

async function _onBounce(pool, mb, parsed) {
  const candidates = bounceRecipients(parsed);
  if (!candidates.length) return null;
  const { rows: [contact] } = await pool.query(
    `SELECT id, email FROM lm_contacts WHERE user_id=$1 AND LOWER(email) = ANY($2) LIMIT 1`,
    [mb.user_id, candidates]
  );
  if (!contact) return null;
  await pool.query(
    `UPDATE lm_messages SET estado='bounced'
      WHERE id = (SELECT id FROM lm_messages
                   WHERE user_id=$1 AND contact_id=$2 AND estado='sent'
                   ORDER BY sent_at DESC NULLS LAST LIMIT 1)`,
    [mb.user_id, contact.id]
  );
  await pool.query(`UPDATE lm_contacts SET email_status='invalid', updated_at=NOW() WHERE id=$1`, [contact.id]);
  await pool.query(
    `UPDATE lm_contact_sequences SET estado='pausado', paused_reason='email_invalido', next_action_at=NULL
      WHERE user_id=$1 AND contact_id=$2 AND estado='activo'`,
    [mb.user_id, contact.id]
  );
  await pool.query(
    `INSERT INTO activities (user_id, contact_id, tipo, canal, nota, fecha, estado)
     VALUES ($1,$2,'tarea','email',$3,NOW(),'pendiente')`,
    [mb.user_id, contact.id, `Rebote: el email ${contact.email} no existe — corregir dato para reanudar`]
  );
  console.log(`[imap-watcher] rebote de ${contact.email} → email inválido + pausa`);
  return contact;
}

// ── Un buzón ─────────────────────────────────────────────────────────

async function _checkMailbox(pool, mb) {
  const pass = decPass(mb.pass_enc);
  const client = new ImapFlow({
    host: mb.imap_host, port: mb.imap_port, secure: true,
    auth: { user: mb.email, pass },
    logger: false, emitLogs: false,
  });
  await client.connect();
  try {
    const box = await client.mailboxOpen('INBOX');
    const uidValidity = Number(box.uidValidity || 0);
    const uidNext     = Number(box.uidNext || 1);

    // Primera vez o carpeta reseteada: anclar cursor al final, sin procesar histórico.
    if (!mb.imap_last_uid || Number(mb.imap_uidvalidity) !== uidValidity) {
      await pool.query(
        `UPDATE lm_mailboxes SET imap_uidvalidity=$1, imap_last_uid=$2, last_checked_at=NOW(), last_error='' WHERE id=$3`,
        [uidValidity, uidNext - 1, mb.id]
      );
      return { anchored: true, procesados: 0 };
    }

    const lastUid = Number(mb.imap_last_uid);
    let maxUid = lastUid;
    let procesados = 0;

    // `${lastUid+1}:*` devuelve al menos el último mensaje aunque su UID sea menor → filtrar.
    for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: { maxLength: MAX_SOURCE } }, { uid: true })) {
      if (msg.uid <= lastUid) continue;
      if (msg.uid > maxUid) maxUid = msg.uid;
      if (procesados >= MAX_PER_TICK) continue; // avanzar cursor igual; lo no procesado ya quedó atrás
      procesados++;

      try {
        const parsed = await simpleParser(msg.source);
        const tipo = classify(parsed);
        const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
        const fromName = parsed.from?.value?.[0]?.name || '';
        if (!fromAddr) continue;
        if (fromAddr === String(mb.email).toLowerCase()) continue; // eco de nosotros mismos

        let contact = null;
        if (tipo === 'bounce') {
          contact = await _onBounce(pool, mb, parsed);
        } else {
          const { rows } = await pool.query(
            `SELECT id, email, nombre, apellido FROM lm_contacts
              WHERE user_id=$1 AND (LOWER(email)=$2 OR LOWER(email_personal)=$2) LIMIT 1`,
            [mb.user_id, fromAddr]
          );
          contact = rows[0] || null;
        }

        // Solo guardar lo relevante: contacto del CRM, o rebote (aunque no matchee).
        if (!contact && tipo !== 'bounce') continue;

        const snippet = cleanBody(parsed);
        await pool.query(
          `INSERT INTO lm_inbox_messages
             (user_id, mailbox_id, outbound_client_id, contact_id, imap_uid, message_id,
              in_reply_to, from_email, from_name, asunto, cuerpo, tipo, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (mailbox_id, imap_uid) DO NOTHING`,
          [mb.user_id, mb.id, mb.outbound_client_id, contact ? contact.id : null, msg.uid,
           parsed.messageId || '', parsed.inReplyTo || '', fromAddr, fromName,
           (parsed.subject || '').slice(0, 500), snippet, tipo,
           parsed.date || new Date()]
        );

        if (tipo === 'reply' && contact) await _onReply(pool, mb, contact, parsed, snippet);
        // OOO: se guarda para el Inbox pero NO pausa (el contacto no respondió de verdad).
      } catch (e) {
        console.warn(`[imap-watcher] ${mb.email} uid ${msg.uid}:`, e.message);
      }
    }

    await pool.query(
      `UPDATE lm_mailboxes SET imap_last_uid=$1, last_checked_at=NOW(), last_error='' WHERE id=$2`,
      [maxUid, mb.id]
    );
    return { anchored: false, procesados };
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── Tick global ──────────────────────────────────────────────────────

async function tick(pool) {
  if (_running) return;
  _running = true;
  try {
    const { rows: boxes } = await pool.query(
      `SELECT * FROM lm_mailboxes WHERE estado='conectado' AND imap_host <> '' ORDER BY id`
    );
    for (const mb of boxes) {
      try {
        const r = await _checkMailbox(pool, mb);
        if (r.procesados) console.log(`[imap-watcher] ${mb.email}: ${r.procesados} mensajes nuevos`);
      } catch (e) {
        // login caído / servidor no responde: registrar sin marcar el buzón como roto
        // (un blip de red no debe apagar el envío; solo se refleja en last_error).
        console.warn(`[imap-watcher] ${mb.email}:`, e.message);
        await pool.query(
          `UPDATE lm_mailboxes SET last_checked_at=NOW(), last_error=$1 WHERE id=$2`,
          [('IMAP: ' + e.message).slice(0, 300), mb.id]
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[imap-watcher] tick:', e.message);
  } finally { _running = false; }
}

function startImapWatcher(pool) {
  if (_timer) return;
  _timer = setInterval(() => tick(pool), TICK_MS);
  _timer.unref?.();
  // Primer chequeo al minuto de arrancar (deja que el boot termine tranquilo).
  setTimeout(() => tick(pool), 60 * 1000).unref?.();
  console.log('[imap-watcher] started (tick 3min)');
}

module.exports = { startImapWatcher, tick, classify, cleanBody, bounceRecipients };
