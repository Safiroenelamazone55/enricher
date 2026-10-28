// Etiquetas @Miembro en comentarios y notas: guarda la mención (campana de Nova) y manda copia por correo.
// El correo sale por SES con el nombre de quien etiqueta y su dirección como «Responder a».
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let _ready = false;
async function ensureTable(pool) {
  if (_ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id                 SERIAL      PRIMARY KEY,
      workspace_owner_id INTEGER     NOT NULL,
      mentioned_user_id  INTEGER,
      member_id          INTEGER     NOT NULL,
      by_user_id         INTEGER,
      by_name            TEXT        NOT NULL DEFAULT '',
      kind               TEXT        NOT NULL,
      task_id            INTEGER,
      project_id         INTEGER,
      excerpt            TEXT        NOT NULL DEFAULT '',
      read               BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_user_idx ON mentions (mentioned_user_id, read)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS mentions_note_uq ON mentions (kind, task_id, member_id) WHERE kind IN ('task_note','task_desc')`);
  _ready = true;
}

// Miembros activos cuyo «@Nombre» aparece en el texto (el nombre más largo gana; sin distinguir mayúsculas/acentos).
const _nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function findMentioned(members, text) {
  const t = _nrm(text), out = [];
  for (const m of [...members].sort((a, b) => b.nombre.length - a.nombre.length)) {
    const n = _nrm(m.nombre).trim(); if (!n) continue;
    const re = new RegExp('(^|[^\\p{L}\\p{N}])@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u');
    if (re.test(t)) out.push(m);
  }
  return out;
}

async function _sendMail({ to, byName, byEmail, subject, html, text }) {
  if (!process.env.SES_FROM_EMAIL || !process.env.AWS_ACCESS_KEY_ID) return false;
  const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
  const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
  await ses.send(new SendEmailCommand({
    Source: `"${String(byName || 'Nova').replace(/"/g, '')} (vía Nova)" <${process.env.SES_FROM_EMAIL}>`,
    ReplyToAddresses: byEmail ? [byEmail] : undefined,
    Destination: { ToAddresses: [to] },
    Message: { Subject: { Data: subject }, Body: { Html: { Data: html }, Text: { Data: text } } },
  }));
  return true;
}

const KIND_LBL = { task_comment: 'un comentario', task_note: 'las notas', task_desc: 'la descripción', project_comment: 'un comentario del proyecto' };

// kind: task_comment | task_note | task_desc | project_comment. Devuelve cuántas personas se etiquetaron.
async function process(pool, { wid, user, kind, taskId, projectId, text, appUrl }) {
  await ensureTable(pool);
  // team_members.user_id es el dueño del workspace; la cuenta de cada miembro se enlaza por correo.
  const { rows: team } = await pool.query(
    `SELECT tm.id, tm.nombre, tm.email, (SELECT u.id FROM users u WHERE LOWER(u.email) = LOWER(tm.email) LIMIT 1) AS login_id
       FROM team_members tm WHERE tm.user_id = $1 AND tm.estado = 'activo'`, [wid]);
  const myEmail = String(user.email || '').toLowerCase();
  const tagged = findMentioned(team, text).filter(m => m.login_id !== user.id && String(m.email || '').toLowerCase() !== myEmail);
  if (!tagged.length) return 0;
  let title = '', proj = projectId || null;
  if (taskId) {
    const { rows } = await pool.query(`SELECT titulo, project_id FROM tasks WHERE id=$1 AND user_id=$2`, [taskId, wid]);
    if (!rows[0]) return 0; title = rows[0].titulo; proj = rows[0].project_id;
  } else if (projectId) {
    const { rows } = await pool.query(`SELECT nombre FROM projects WHERE id=$1 AND user_id=$2`, [projectId, wid]);
    title = rows[0] ? rows[0].nombre : '';
  }
  const excerpt = String(text).replace(/\s+/g, ' ').trim().slice(0, 280);
  const link = (appUrl || process.env.APP_URL || '') + (taskId ? `/?task=${taskId}` : '');
  let n = 0;
  for (const m of tagged) {
    const ins = await pool.query(
      `INSERT INTO mentions (workspace_owner_id, mentioned_user_id, member_id, by_user_id, by_name, kind, task_id, project_id, excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [wid, m.login_id || null, m.id, user.id, user.name || '', kind, taskId || null, proj, excerpt]);
    if (!ins.rows[0]) continue;      // ya se le avisó de esta nota
    n++;
    if (!m.email) continue;
    const what = KIND_LBL[kind] || 'un mensaje';
    const subject = `${user.name || 'Alguien'} te etiquetó en «${title || 'Nova'}»`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#F7F6F3;font-family:Arial,Helvetica,sans-serif">
      <div style="max-width:520px;margin:28px auto;background:#fff;border:1px solid #E7E4DE;border-radius:12px;overflow:hidden">
        <div style="padding:20px 26px;border-bottom:1px solid #EFECE6"><div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8F8B83">Te etiquetaron</div>
          <div style="font-size:17px;font-weight:700;color:#33302C;margin-top:4px">${esc(user.name || 'Alguien')} te mencionó en ${esc(what)}</div></div>
        <div style="padding:20px 26px">
          ${title ? `<div style="font-size:13px;color:#6C6862;margin-bottom:10px">${taskId ? 'Tarea' : 'Proyecto'}: <b style="color:#33302C">${esc(title)}</b></div>` : ''}
          <div style="background:#FAF9F7;border:1px solid #EFECE6;border-left:3px solid #2F6BFF;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:#33302C;white-space:pre-wrap">${esc(excerpt)}</div>
          ${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#2F6BFF;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px">Ver en Nova</a></p>` : ''}
          <p style="margin:18px 0 0;font-size:12px;color:#A19D95">Puedes responder a este correo: le llegará a ${esc(user.name || 'quien te etiquetó')}.</p>
        </div></div></body></html>`;
    const textBody = `${user.name || 'Alguien'} te etiquetó en ${what}${title ? ` de «${title}»` : ''}:\n\n${excerpt}\n\n${link}`;
    _sendMail({ to: m.email, byName: user.name, byEmail: user.email, subject, html, text: textBody })
      .then(ok => { if (ok) console.log(`[mention] correo → ${m.email}`); })
      .catch(e => console.warn('[mention] correo falló:', e.message));
  }
  return n;
}

module.exports = { ensureTable, findMentioned, process };
