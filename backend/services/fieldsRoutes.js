'use strict';
// Estados y campos personalizados por proyecto (estilo ClickUp).
//  · projects.estados: lista de estados propia del proyecto [{k, n, c, t}] — «t» es la categoría (pendiente|en_progreso|bloqueado|completado|cancelado)
//    y es lo que sigue usando el resto del sistema (tasks.estado); tasks.status_key guarda el estado propio elegido. null = los 5 estados de siempre.
//  · projects.campos: columnas personalizadas [{id, n, t, o:[{k,n,c}], v, mon}]; tasks.campos guarda los valores {id: valor}.
const CATS = ['pendiente', 'en_progreso', 'bloqueado', 'completado', 'cancelado'];
const TIPOS = ['texto', 'area', 'numero', 'fecha', 'lista', 'etiquetas', 'casilla', 'dinero', 'correo', 'telefono', 'sitio', 'calificacion', 'progreso', 'progreso_auto', 'personas', 'votacion'];
const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : d);
const slug = (s, d) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || d;

function normEstados(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const seen = new Set(), out = [];
  for (const e of arr.slice(0, 20)) {
    if (!e) continue; let k = slug(e.k || e.n, 'e' + out.length); while (seen.has(k)) k += '_';
    seen.add(k); out.push({ k, n: String(e.n || k).trim().slice(0, 40) || k, c: hex(e.c, '#87909E'), t: CATS.includes(e.t) ? e.t : 'pendiente' });
  }
  return out.length ? out : null;
}
function normCampos(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const f of arr.slice(0, 40)) {
    if (!f || !TIPOS.includes(f.t)) continue;
    let id = /^[A-Za-z0-9_]{1,30}$/.test(String(f.id || '')) ? f.id : 'f' + Date.now().toString(36) + out.length; while (seen.has(id)) id += 'x'; seen.add(id);
    const o = ['lista', 'etiquetas'].includes(f.t) ? (Array.isArray(f.o) ? f.o : []).slice(0, 40).map((x, i) => ({ k: slug(x.k || x.n, 'o' + i), n: String(x.n || x.k || '').trim().slice(0, 40), c: hex(x.c, '#4194F6') })).filter(x => x.n) : undefined;
    out.push({ id, n: String(f.n || 'Campo').trim().slice(0, 50) || 'Campo', t: f.t, ...(o ? { o } : {}), v: f.v !== false, ...(f.t === 'dinero' ? { mon: String(f.mon || 'USD').slice(0, 4) } : {}) });
  }
  return out;
}
function cleanVal(f, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return undefined;
  switch (f.t) {
    case 'numero': case 'dinero': case 'progreso': case 'calificacion': case 'votacion': { const n = +v; return isFinite(n) ? n : undefined; }
    case 'casilla': return !!v;
    case 'fecha': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined;
    case 'lista': return (f.o || []).some(o => o.k === v) ? String(v) : undefined;
    case 'etiquetas': { const ks = new Set((f.o || []).map(o => o.k)); const a = (Array.isArray(v) ? v : [v]).map(String).filter(k => ks.has(k)); return a.length ? a : undefined; }
    case 'personas': { const a = (Array.isArray(v) ? v : [v]).map(x => String(x).slice(0, 80)); return a.length ? a : undefined; }
    case 'progreso_auto': return undefined;
    default: return String(v).slice(0, f.t === 'area' ? 4000 : 500);
  }
}

// ── Plantilla «Adquisición comercial» (basada en cómo trabajas campañas outbound) ──
const D = n => n;   // días desde el inicio del proyecto
function tplAdquisicion() {
  const op = (...a) => a.map(([n, c]) => ({ k: slug(n, 'o'), n, c }));
  const estados = [
    { k: 'por_iniciar', n: 'Por iniciar', c: '#87909E', t: 'pendiente' }, { k: 'investigando', n: 'Investigando', c: '#A875FF', t: 'en_progreso' },
    { k: 'en_preparacion', n: 'En preparación', c: '#4194F6', t: 'en_progreso' }, { k: 'en_ejecucion', n: 'En ejecución', c: '#FF7800', t: 'en_progreso' },
    { k: 'esperando_respuesta', n: 'Esperando respuesta', c: '#08BDBA', t: 'en_progreso' }, { k: 'bloqueado', n: 'Bloqueado', c: '#F04F4F', t: 'bloqueado' },
    { k: 'completado', n: 'Completado', c: '#6BC950', t: 'completado' }, { k: 'cancelado', n: 'Cancelado', c: '#B0B5BD', t: 'cancelado' },
  ];
  const campos = [
    { id: 'etapa', n: 'Etapa', t: 'lista', o: op(['Preparación', '#4194F6'], ['Lanzamiento', '#FF7800'], ['Seguimiento', '#08BDBA'], ['Cierre', '#6BC950']), v: true },
    { id: 'canal', n: 'Canal', t: 'etiquetas', o: op(['LinkedIn', '#0A66C2'], ['Email', '#F8AE00'], ['WhatsApp', '#25D366'], ['Llamada', '#A875FF'], ['Reunión', '#F04F4F']), v: true },
    { id: 'tipo', n: 'Tipo de trabajo', t: 'lista', o: op(['Reunión', '#F04F4F'], ['Investigación', '#A875FF'], ['Lista de empresas', '#4194F6'], ['Verificación de datos', '#08BDBA'], ['Mensajes', '#F8AE00'], ['Configuración', '#87909E'], ['Seguimiento', '#FF7800'], ['Reporte', '#6BC950']), v: true },
    { id: 'tier', n: 'Tier ICP', t: 'lista', o: op(['Tier 1', '#6BC950'], ['Tier 2', '#F8AE00'], ['Tier 3', '#87909E']), v: false },
    { id: 'meta', n: 'Meta (contactos)', t: 'numero', v: true },
    { id: 'avance', n: 'Avance', t: 'progreso', v: true },
    { id: 'aprobado', n: 'Aprobado por el cliente', t: 'casilla', v: false },
    { id: 'lanzamiento', n: 'Fecha de lanzamiento', t: 'fecha', v: false },
    { id: 'contacto_cliente', n: 'Contacto en el cliente', t: 'texto', v: false },
    { id: 'enlace', n: 'Enlace (lista / documento)', t: 'sitio', v: false },
    { id: 'notas_cliente', n: 'Comentarios del cliente', t: 'area', v: false },
  ];
  const T = (ref, parent, titulo, prio, ini, dl, min, key, c) => ({ ref, parent, titulo, descripcion: '', prioridad: prio, responsables: [], notas: '', etiquetas: [], checklists: [], duracion_est_min: min || null, off_ini: ini, off_dl: dl, status_key: key || 'por_iniciar', campos: c || {} });
  const tareas = [
    T(1, null, 'Reunión de kickoff y brief del cliente', 'alta', D(0), D(1), 60, 'por_iniciar', { etapa: 'preparacion', canal: ['reunion'], tipo: 'reunion' }),
    T(2, null, 'Definir ICP, tiers y propuesta de valor', 'alta', D(0), D(3), 180, 'por_iniciar', { etapa: 'preparacion', tipo: 'investigacion', avance: 0 }),
    T(3, 2, 'Definir industrias, tamaño y geografías objetivo', 'alta', D(0), D(1), 60), T(4, 2, 'Definir cargos objetivo (decisores) y roles de respaldo', 'alta', D(1), D(2), 45),
    T(5, 2, 'Redactar la propuesta de valor en una frase', 'media', D(2), D(2), 30), T(6, 2, 'Validar el ICP con el cliente', 'alta', D(2), D(3), 30),
    T(7, null, 'Armar la lista de empresas', 'alta', D(2), D(6), 480, 'por_iniciar', { etapa: 'preparacion', tipo: 'lista_de_empresas', canal: ['linkedin'], meta: 200, avance: 0 }),
    T(8, 7, 'Extraer empresas (Sales Navigator / Apollo)', 'alta', D(2), D(4), 180), T(9, 7, 'Limpiar duplicados y empresas fuera del ICP', 'media', D(4), D(5), 90),
    T(10, 7, 'Priorizar por tier', 'media', D(5), D(5), 60), T(11, 7, 'Subir la lista a Cantera y mover al CRM', 'alta', D(5), D(6), 60),
    T(12, null, 'Encontrar y verificar contactos', 'alta', D(4), D(8), 480, 'por_iniciar', { etapa: 'preparacion', tipo: 'verificacion_de_datos', canal: ['email', 'linkedin'], meta: 200, avance: 0 }),
    T(13, 12, 'Buscar decisores por empresa', 'alta', D(4), D(6), 240), T(14, 12, 'Obtener y verificar emails', 'alta', D(5), D(7), 120),
    T(15, 12, 'Completar LinkedIn y teléfono', 'media', D(6), D(7), 90), T(16, 12, 'Revisar datos faltantes o incorrectos', 'media', D(7), D(8), 60),
    T(17, null, 'Redactar mensajes de outreach', 'alta', D(5), D(8), 300, 'por_iniciar', { etapa: 'preparacion', tipo: 'mensajes', canal: ['email', 'linkedin'], avance: 0 }),
    T(18, 17, 'Email: primer contacto y seguimientos', 'alta', D(5), D(7), 120), T(19, 17, 'LinkedIn: invitación y mensaje de seguimiento', 'alta', D(5), D(7), 90),
    T(20, 17, 'WhatsApp (si aplica)', 'baja', D(6), D(7), 30), T(21, 17, 'Versiones por idioma', 'media', D(7), D(8), 60), T(22, 17, 'Aprobación del cliente', 'alta', D(8), D(8), 30),
    T(23, null, 'Estrategia y calendario de la campaña', 'media', D(3), D(6), 120, 'por_iniciar', { etapa: 'preparacion', tipo: 'configuracion' }),
    T(24, null, 'Configurar campaña, secuencia y buzón', 'alta', D(7), D(9), 180, 'por_iniciar', { etapa: 'lanzamiento', tipo: 'configuracion', canal: ['email'], avance: 0 }),
    T(25, 24, 'Conectar el buzón del cliente y la firma', 'alta', D(7), D(8), 45), T(26, 24, 'Crear la secuencia y sus pasos', 'alta', D(8), D(9), 90),
    T(27, 24, 'Ventana de envío y límite diario', 'media', D(8), D(9), 30), T(28, 24, 'Prueba de envío interna', 'alta', D(9), D(9), 30),
    T(29, null, 'Lanzar la campaña', 'alta', D(9), D(10), 60, 'por_iniciar', { etapa: 'lanzamiento', tipo: 'seguimiento', canal: ['email', 'linkedin'] }),
    T(30, null, 'Primeros envíos y control de rebotes', 'alta', D(10), D(13), 120, 'por_iniciar', { etapa: 'lanzamiento', tipo: 'seguimiento', canal: ['email'] }),
  ];
  // Desde el primer envío (semana 2) entra la rutina semanal; el proyecto dura siempre 1 mes (30 días).
  let ref = 31;
  [['Semana 2 (desde el primer envío)', 10, 13], ['Semana 3', 14, 20], ['Semana 4', 21, 27]].forEach(([nom, a, z]) => {
    const pa = ref++;
    tareas.push(T(pa, null, 'Rutina de seguimiento · ' + nom, 'media', D(a), D(z), null, 'por_iniciar', { etapa: 'seguimiento', tipo: 'seguimiento', canal: ['email', 'linkedin'] }));
    [['Revisar Inbox y respuestas pendientes', 'media', 60], ['Trabajar tareas y cola de empresas', 'media', 120], ['Seguimiento a interesados y agendar reuniones', 'alta', 90], ['Revisar métricas de secuencias y ajustar', 'media', 60], ['Reporte semanal al cliente', 'media', 45]]
      .forEach(([t, pr, m]) => tareas.push(T(ref++, pa, t, pr, D(a), D(z), m)));
  });
  tareas.push(T(ref++, null, 'Informe final y siguientes pasos', 'media', D(27), D(30), 90, 'por_iniciar', { etapa: 'cierre', tipo: 'reporte' }));
  const B = (t, html) => ({ id: 'b' + Math.random().toString(36).slice(2, 9), t, html });
  const doc = { rev: 0, blocks: [
    B('h1', 'Brief de adquisición comercial'), B('call-info', 'Completa este documento con el cliente en el kickoff. Todo el equipo lo usa como fuente de verdad de la campaña.'),
    B('h2', 'Cliente y objetivo'), B('ul', 'Cliente / empresa: '), B('ul', 'Qué vende y a quién: '), B('ul', 'Objetivo de la campaña (reuniones, demos, ventas): '), B('ul', 'Meta numérica y plazo: '),
    B('h2', 'ICP (cliente ideal)'), B('ul', 'Industrias: '), B('ul', 'Tamaño de empresa: '), B('ul', 'Geografías e idiomas: '), B('ul', 'Cargos decisores: '), B('ul', 'Tier 1 / Tier 2 / Tier 3 (criterios): '),
    B('h2', 'Propuesta de valor'), B('quote', 'Una frase: qué problema resolvemos y con qué resultado.'),
    B('h2', 'Canales y ritmo'), B('todo', 'Email (buzón del cliente, ventana de envío, límite diario)'), B('todo', 'LinkedIn (perfil desde el que se escribe)'), B('todo', 'WhatsApp / llamadas (si aplica)'),
    B('h2', 'Exclusiones y riesgos'), B('call-warn', 'Lista de empresas, dominios o contactos que NO se deben contactar y cualquier restricción del cliente.'),
    B('h2', 'Contactos y accesos'), B('ul', 'Contacto en el cliente: '), B('ul', 'Quién aprueba los mensajes: '), B('p', ''),
  ] };
  const N = (id, x, y, color, text) => ({ id, t: 'nota', x, y, color, text });
  const wb = { rev: 0, items: [N('n1', 40, 40, '#FFF3A8', 'ICP\nIndustrias · tamaño · geografía · cargos'), N('n2', 260, 40, '#BFE3FF', 'Propuesta de valor\nQué problema resolvemos y con qué resultado'), N('n3', 480, 40, '#C8F0CF', 'Canales\nEmail · LinkedIn · WhatsApp · llamadas'), N('n4', 40, 220, '#FFD0D8', 'Riesgos\nRebotes, reputación del dominio, exclusiones'), N('n5', 260, 220, '#E0D0FF', 'Mensajes clave\nGancho · prueba social · llamada a la acción'), N('n6', 480, 220, '#FFF3A8', 'Métricas\nContactados · respuestas · reuniones · ganados')] };
  const vistas = [
    { tipo: 'lista', nombre: 'Lista', orden: 1, config: {} }, { tipo: 'tablero', nombre: 'Tablero', orden: 2, config: {} }, { tipo: 'tabla', nombre: 'Tabla', orden: 3, config: {} },
    { tipo: 'calendario', nombre: 'Calendario', orden: 4, config: {} }, { tipo: 'gantt', nombre: 'Cronograma', orden: 5, config: {} },
    { tipo: 'documento', nombre: 'Brief y ICP', orden: 6, config: doc }, { tipo: 'pizarra', nombre: 'Estrategia', orden: 7, config: wb },
  ];
  return { proyecto: { descripcion: 'Campaña de adquisición comercial outbound: de definir el ICP a lanzar, dar seguimiento y reportar al cliente. Dura 1 mes: preparación y lanzamiento en las semanas 1–2; desde el primer envío, rutina semanal.', prioridad: 'media', task_defaults: {}, duracion_dias: 30, estados, campos }, tareas, vistas, fuente: 'Plantilla del sistema' };
}

function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS estados JSONB`);
      await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS campos JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_key TEXT`);
      await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS campos JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_una_vez (nombre TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      // plantilla «Adquisición comercial» para cada espacio de trabajo (una sola vez: si la borras, no vuelve)
      const { rows: owners } = await pool.query(`SELECT id FROM users WHERE workspace_id IS NULL`);
      for (const o of owners) {
        const nom = 'tpl_adquisicion_v1_' + o.id;
        const { rowCount } = await pool.query(`SELECT 1 FROM migraciones_una_vez WHERE nombre=$1`, [nom]); if (rowCount) continue;
        const data = tplAdquisicion();
        await pool.query(`INSERT INTO project_templates (user_id, nombre, descripcion, data, created_by) VALUES ($1,$2,$3,$4::jsonb,'Nova')`, [o.id, 'Adquisición comercial', 'Campaña outbound completa: ICP, listas, verificación, mensajes, lanzamiento, seguimiento y reporte. Con estados propios, columnas, documento de brief y pizarra de estrategia.', JSON.stringify(data)]);
        await pool.query(`INSERT INTO migraciones_una_vez (nombre) VALUES ($1) ON CONFLICT DO NOTHING`, [nom]);
      }
      // v2: semanas 1–2 de arranque + rutina semanal desde el primer envío + duración de 1 mes (solo la plantilla de sistema sin editar nombre)
      for (const o of owners) {
        const nom2 = 'tpl_adquisicion_v2_' + o.id;
        const { rowCount: yaV2 } = await pool.query(`SELECT 1 FROM migraciones_una_vez WHERE nombre=$1`, [nom2]); if (yaV2) continue;
        await pool.query(`UPDATE project_templates SET data=$2::jsonb, descripcion=$3, updated_at=NOW() WHERE user_id=$1 AND nombre='Adquisición comercial' AND created_by='Nova'`, [o.id, JSON.stringify(tplAdquisicion()), 'Campaña outbound de 1 mes: semanas 1–2 de preparación y lanzamiento (ICP, listas, verificación, mensajes, campaña) y, desde el primer envío, rutina semanal de seguimiento, métricas y reporte. Con estados propios, columnas, brief y pizarra de estrategia.']);
        await pool.query(`INSERT INTO migraciones_una_vez (nombre) VALUES ($1) ON CONFLICT DO NOTHING`, [nom2]);
      }
    } catch (e) { console.warn('[fields] init', e.message); }
  })();

  // estados + campos del proyecto
  app.put('/api/mgmt/projects/:id/schema', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), b = req.body || {}, wid = req.workspaceOwnerId;
      const { rows: [cur] } = await pool.query(`SELECT estados, campos FROM projects WHERE id=$1 AND user_id=$2`, [id, wid]); if (!cur) return res.status(404).json({ error: 'Proyecto no encontrado' });
      const estados = 'estados' in b ? normEstados(b.estados) : cur.estados, campos = 'campos' in b ? normCampos(b.campos) : (cur.campos || []);
      const { rows: [p] } = await pool.query(`UPDATE projects SET estados=$3::jsonb, campos=$4::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id, estados, campos`, [id, wid, estados ? JSON.stringify(estados) : null, JSON.stringify(campos)]);
      // tareas con un estado que ya no existe → vuelven al primero de su categoría; valores de campos borrados se limpian
      await pool.query(`UPDATE tasks SET status_key=NULL WHERE project_id=$1 AND user_id=$2 AND status_key IS NOT NULL AND ($3::jsonb IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements($3::jsonb) e WHERE e->>'k'=tasks.status_key))`, [id, wid, estados ? JSON.stringify(estados) : null]);
      const ids = campos.map(f => f.id);
      await pool.query(`UPDATE tasks SET campos = COALESCE((SELECT jsonb_object_agg(k, v) FROM jsonb_each(tasks.campos) AS x(k, v) WHERE k = ANY($3::text[])), '{}'::jsonb) WHERE project_id=$1 AND user_id=$2 AND campos <> '{}'::jsonb`, [id, wid, ids]);
      res.json(p);
    } catch (e) { console.error('[fields] schema', e.message); res.status(500).json({ error: 'No se pudo guardar' }); }
  });
  // estado propio de una tarea (la categoría se aplica aparte con la ruta de estado de siempre)
  app.patch('/api/mgmt/tasks/:id/status-key', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), key = String((req.body || {}).key || ''), wid = req.workspaceOwnerId;
      const { rows: [r] } = await pool.query(`SELECT p.estados FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND t.user_id=$2`, [id, wid]);
      if (!r || !Array.isArray(r.estados) || !r.estados.some(e => e.k === key)) return res.status(400).json({ error: 'Estado no válido para este proyecto' });
      const tipo = r.estados.find(e => e.k === key).t;
      await pool.query(`UPDATE tasks SET status_key=$2, estado=$3, updated_at=NOW() WHERE id=$1 AND user_id=$4`, [id, key, tipo, wid]);
      res.json({ ok: true, key, estado: tipo });
    } catch (e) { res.status(500).json({ error: 'No se pudo cambiar el estado' }); }
  });
  // valores de campos personalizados de una tarea
  app.patch('/api/mgmt/tasks/:id/campos', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), wid = req.workspaceOwnerId, vals = (req.body || {}).values || {};
      const { rows: [r] } = await pool.query(`SELECT t.campos, p.campos AS defs FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND t.user_id=$2`, [id, wid]);
      if (!r) return res.status(404).json({ error: 'Tarea no encontrada' });
      const defs = Object.fromEntries((r.defs || []).map(f => [f.id, f])), out = { ...(r.campos || {}) };
      for (const [fid, v] of Object.entries(vals)) { const f = defs[fid]; if (!f) continue; const c = cleanVal(f, v); if (c === undefined) delete out[fid]; else out[fid] = c; }
      const { rows: [t] } = await pool.query(`UPDATE tasks SET campos=$2::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$3 RETURNING id, campos`, [id, JSON.stringify(out), wid]);
      res.json(t);
    } catch (e) { res.status(500).json({ error: 'No se pudo guardar el campo' }); }
  });
}
module.exports = { mount, normEstados, normCampos, cleanVal, tplAdquisicion };
