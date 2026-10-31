'use strict';
// Roles y permisos del espacio de trabajo.
//  · Niveles por módulo: 0 sin acceso · 1 ver · 2 editar · 3 administrar. Alcance (en módulos con datos por persona): «todo» o «suyo» (solo lo asignado o compartido).
//  · Cada rol trae permisos PREDETERMINADOS (aquí abajo); el Propietario/Admin puede cambiar los de un rol (tabla perm_roles) y los de una persona (team_members.permisos).
//  · El Propietario (dueño de la cuenta) y el rol Administrador tienen siempre todo. Se aplica en el SERVIDOR (guardia global sobre /api), no solo ocultando botones.
//  · Uso compartido por espacio o proyecto (tabla resource_shares): Ver · Comentar · Editar · Completo, para quien solo ve «lo suyo».

const MODULOS = [
  { k: 'dashboard', l: 'Dashboard', g: 'Operaciones', alc: true }, { k: 'mywork', l: 'Mi trabajo', g: 'Operaciones', alc: false },
  { k: 'oportunidades', l: 'Oportunidades', g: 'Negocio', alc: true }, { k: 'clientes', l: 'Clientes', g: 'Negocio', alc: true }, { k: 'proyectos', l: 'Proyectos', g: 'Negocio', alc: true },
  { k: 'espacios', l: 'Espacios', g: 'Trabajo', alc: true }, { k: 'tareas', l: 'Tareas', g: 'Trabajo', alc: true }, { k: 'calendario', l: 'Calendario', g: 'Trabajo', alc: true },
  { k: 'tiempo', l: 'Time Tracking', g: 'Gestión', alc: true }, { k: 'equipo', l: 'Equipo', g: 'Gestión', alc: false }, { k: 'finanzas', l: 'Finanzas y montos', g: 'Gestión', alc: false },
  { k: 'slack', l: 'Slack', g: 'Comunicación', alc: false }, { k: 'whatsapp', l: 'WhatsApp', g: 'Comunicación', alc: false }, { k: 'bloqueos', l: 'Bloqueos', g: 'Comunicación', alc: true },
  { k: 'outreach', l: 'Outreach', g: 'Outreach', alc: false }, { k: 'datos', l: 'Datos (enriquecimiento)', g: 'Datos', alc: false },
  { k: 'contenido', l: 'Contenido', g: 'Contenido', alc: false }, { k: 'plantillas', l: 'Plantillas', g: 'Plantillas', alc: false },
  { k: 'config', l: 'Configuración y usuarios', g: 'Administración', alc: false },
];
const ROLES = [
  { k: 'propietario', l: 'Propietario', fijo: true, d: 'Dueño de la cuenta: todo, siempre.' },
  { k: 'admin', l: 'Administrador', fijo: true, d: 'Ve y gestiona todo, asigna y supervisa al equipo.' },
  { k: 'manager', l: 'Manager', d: 'Gestiona y supervisa el trabajo del equipo; sin finanzas ni configuración.' },
  { k: 'miembro', l: 'Miembro', d: 'Trabaja en sus proyectos y tareas; no ve el resto.' },
  { k: 'lector', l: 'Solo lectura', d: 'Puede ver lo que se le comparte, sin editar.' },
];
const NIV = { ninguno: 0, ver: 1, editar: 2, admin: 3 };
const P = (n, a) => ({ n, a: a || 'todo' });
const mk = o => Object.fromEntries(MODULOS.map(m => [m.k, o[m.k] || P(0)]));
const ALL = mk(Object.fromEntries(MODULOS.map(m => [m.k, P(3)])));
const DEFAULTS = {
  admin: ALL,
  manager: mk({ dashboard: P(1), mywork: P(2), oportunidades: P(2), clientes: P(2), proyectos: P(2), espacios: P(2), tareas: P(2), calendario: P(1), tiempo: P(1), equipo: P(1), slack: P(2), whatsapp: P(2), bloqueos: P(2), outreach: P(2), datos: P(2), contenido: P(2), plantillas: P(2) }),
  miembro: mk({ dashboard: P(1, 'suyo'), mywork: P(2), clientes: P(1, 'suyo'), proyectos: P(2, 'suyo'), espacios: P(2, 'suyo'), tareas: P(2), calendario: P(1, 'suyo'), tiempo: P(2, 'suyo'), equipo: P(1), slack: P(2), whatsapp: P(1), bloqueos: P(2, 'suyo'), contenido: P(1), plantillas: P(1) }),
  lector: mk({ dashboard: P(1, 'suyo'), mywork: P(1), proyectos: P(1, 'suyo'), espacios: P(1, 'suyo'), tareas: P(1), calendario: P(1, 'suyo'), equipo: P(1), plantillas: P(1) }),
};
const norm = (v, m) => { if (!v || typeof v !== 'object') return null; const n = Math.max(0, Math.min(3, parseInt(v.n, 10) || 0)); return { n, a: m.alc && v.a === 'suyo' ? 'suyo' : 'todo' }; };
// permisos efectivos: predeterminado del rol → personalización del rol (perm_roles) → ajustes de la persona (team_members.permisos)
function resolve(rol, rolCustom, overrides) {
  if (rol === 'propietario' || rol === 'admin') return ALL;
  const base = DEFAULTS[rol] || DEFAULTS.miembro, out = {};
  for (const m of MODULOS) out[m.k] = norm(overrides && overrides[m.k], m) || norm(rolCustom && rolCustom[m.k], m) || base[m.k];
  return out;
}
// ruta → módulo (lo que no está aquí, no se restringe: autenticación, notificaciones, chat interno…)
const RUTAS = [
  [/^\/mgmt\/(opportunities|opportunity-tasks)(\/|$)/, 'oportunidades'], [/^\/mgmt\/clients(\/|$)/, 'clientes'], [/^\/mgmt\/(projects|project-templates|task-templates)(\/|$)/, 'proyectos'],
  [/^\/mgmt\/(spaces|space-views)(\/|$)/, 'espacios'], [/^\/mgmt\/(tasks|recur-subtasks|plan-overrides|meetings)(\/|$)/, 'tareas'],
  [/^\/(timer|mgmt\/time-off)(\/|$)/, 'tiempo'], [/^\/mgmt\/team(\/|$)/, 'equipo'], [/^\/mgmt\/(fin-|payments|pagos-internos|exchange-rates)/, 'finanzas'],
  [/^\/slack(\/|$)/, 'slack'], [/^\/wa\//, 'whatsapp'], [/^\/(lm|outbound-clients|sequences|sequence-steps|campaigns|leads|activities|tel)(\/|$)/, 'outreach'],
  [/^\/(cantera|user\/verifications|tools)(\/|$)/, 'datos'], [/^\/content\/(?!public)/, 'contenido'], [/^\/tpl(\/|$)/, 'plantillas'],
];
const BORRAR_ADMIN = new Set(['proyectos', 'clientes', 'espacios', 'outreach', 'finanzas', 'oportunidades', 'datos']);
const needLevel = (mod, method) => (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') ? 1 : (method === 'DELETE' && BORRAR_ADMIN.has(mod) ? 3 : 2);
const SHARE_N = { ver: 1, comentar: 1, editar: 2, completo: 3 };
const MONEY_P = ['valor_total', 'tarifa_hora', 'comision', 'precio_semanal', 'reparto', 'cobro_semanal', 'moneda'], MONEY_T = ['monto', 'cobrado', 'cobrado_at', 'en_cuenta', 'en_cuenta_at', 'estado_financiero', 'billing_week', 'semana_week'];

function mount(app, { pool, requireAuth }) {
  (async () => {
    try {
      await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS permisos JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`CREATE TABLE IF NOT EXISTS perm_roles (user_id INTEGER NOT NULL, rol TEXT NOT NULL, permisos JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (user_id, rol))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS resource_shares (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, tipo TEXT NOT NULL, recurso_id INTEGER NOT NULL, member_id INTEGER NOT NULL, nivel TEXT NOT NULL DEFAULT 'editar', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tipo, recurso_id, member_id))`);
    } catch (e) { console.warn('[perms] tablas', e.message); }
  })();

  const cache = new Map();   // «owner|email» → { ts, ctx } (30 s); se vacía al cambiar permisos
  const clear = () => cache.clear();
  async function ctx(req) {
    if (req._pctx) return req._pctx;
    const u = req.user, owner = u.workspace_id || u.id;
    let c;
    if (!u.workspace_id) c = { owner, isOwner: true, rol: 'propietario', perms: ALL, nombre: u.name, memberId: null };
    else {
      const key = owner + '|' + String(u.email || '').toLowerCase(), hit = cache.get(key);
      if (hit && Date.now() - hit.ts < 30000) c = hit.ctx;
      else {
        const { rows: [tm] } = await pool.query(`SELECT id, nombre, rol, permisos FROM team_members WHERE user_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`, [owner, u.email]);
        const rol = tm ? (tm.rol || 'miembro') : 'miembro';
        const { rows: [rc] } = await pool.query(`SELECT permisos FROM perm_roles WHERE user_id=$1 AND rol=$2`, [owner, rol]);
        c = { owner, isOwner: false, rol, perms: resolve(rol, rc && rc.permisos, tm && tm.permisos), nombre: (tm && tm.nombre) || u.name, memberId: tm ? tm.id : null, estado: tm ? tm.estado : 'activo' };
        cache.set(key, { ts: Date.now(), ctx: c });
      }
    }
    req._pctx = c; return c;
  }
  const lvl = (c, m) => (c.perms[m] ? c.perms[m].n : 0), scope = (c, m) => (c.perms[m] ? c.perms[m].a : 'todo');

  // proyectos visibles para quien tiene alcance «suyo»: responsable, con tareas asignadas, o compartidos (proyecto o espacio)
  async function visibleProjects(req) {
    const c = await ctx(req); if (c.isOwner || scope(c, 'proyectos') === 'todo') return null;
    const { rows } = await pool.query(`SELECT p.id FROM projects p WHERE p.user_id=$1 AND ($2 = ANY(COALESCE(p.responsables,'{}')) OR p.responsable=$2
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=p.id AND ($2 = ANY(COALESCE(t.responsables,'{}')) OR t.responsable=$2))
        OR EXISTS (SELECT 1 FROM resource_shares s WHERE s.user_id=$1 AND s.member_id=$3 AND ((s.tipo='project' AND s.recurso_id=p.id) OR (s.tipo='space' AND s.recurso_id=COALESCE(p.space_id,0)))))`, [c.owner, c.nombre, c.memberId || 0]);
    return new Set(rows.map(r => r.id));
  }
  async function shareLevel(c, projectId) {   // nivel dado por «uso compartido» sobre un proyecto (o su espacio): null si no hay
    if (!c.memberId) return null;
    const { rows } = await pool.query(`SELECT s.nivel FROM resource_shares s JOIN projects p ON p.id=$3 WHERE s.user_id=$1 AND s.member_id=$2 AND ((s.tipo='project' AND s.recurso_id=p.id) OR (s.tipo='space' AND s.recurso_id=COALESCE(p.space_id,0)))`, [c.owner, c.memberId, projectId]);
    if (!rows.length) return null; return rows.map(r => r.nivel).sort((a, b) => SHARE_N[b] - SHARE_N[a])[0];
  }
  const strip = (rows, keys) => rows.map(r => { const o = { ...r }; keys.forEach(k => delete o[k]); return o; });
  async function filterProjects(req, rows) {
    const c = await ctx(req); if (c.isOwner) return rows; const vis = await visibleProjects(req); let out = vis ? rows.filter(r => vis.has(r.id)) : rows;
    return lvl(c, 'finanzas') < 1 ? strip(out, MONEY_P) : out;
  }
  async function filterTasks(req, rows) {
    const c = await ctx(req); if (c.isOwner) return rows; const vis = await visibleProjects(req); let out = vis ? rows.filter(r => !r.project_id || vis.has(r.project_id)) : rows;
    if (scope(c, 'tareas') === 'suyo') out = out.filter(r => (r.responsables || []).includes(c.nombre) || r.responsable === c.nombre || r.created_by_name === c.nombre);
    return lvl(c, 'finanzas') < 1 ? strip(out, MONEY_T) : out;
  }
  async function filterClients(req, rows) {
    const c = await ctx(req); if (c.isOwner || scope(c, 'clientes') === 'todo') return rows;
    const { rows: pr } = await pool.query(`SELECT id, client_id FROM projects WHERE user_id=$1`, [c.owner]); const vis = await visibleProjects(req);
    const ok = new Set(pr.filter(p => !vis || vis.has(p.id)).map(p => p.client_id)); return rows.filter(r => ok.has(r.id));
  }
  async function filterSpaces(req, rows) {
    const c = await ctx(req); if (c.isOwner || scope(c, 'espacios') === 'todo') return rows;
    const vis = await visibleProjects(req), { rows: pr } = await pool.query(`SELECT id, space_id FROM projects WHERE user_id=$1`, [c.owner]);
    const ok = new Set(pr.filter(p => !vis || vis.has(p.id)).map(p => p.space_id || 0));
    const { rows: sh } = await pool.query(`SELECT recurso_id FROM resource_shares WHERE user_id=$1 AND member_id=$2 AND tipo='space'`, [c.owner, c.memberId || 0]); sh.forEach(s => ok.add(s.recurso_id));
    return rows.filter(r => ok.has(r.id));
  }

  // ── guardia global: ningún endpoint de un módulo sin permiso, ni escribir con permiso de solo ver ──
  app.use('/api', async (req, res, next) => {
    try {
      if (!req.user || !(req.isAuthenticated && req.isAuthenticated())) return next();
      const p = req.path, method = req.method;
      let mod = null; for (const [re, m] of RUTAS) if (re.test(p)) { mod = m; break; }
      if (!mod) return next();
      const c = await ctx(req); if (c.isOwner) return next();
      if (c.estado === 'inactivo') return res.status(403).json({ error: 'Tu acceso está desactivado' });
      if (mod === 'equipo' && method === 'GET') return next();   // el listado del equipo lo necesita cualquiera para asignar tareas
      if (mod === 'tiempo' && /^\/timer\/(team|export)/.test(p) && lvl(c, 'tiempo') < 2 && scope(c, 'tiempo') === 'suyo') return res.status(403).json({ error: 'Solo puedes ver tu propio tiempo' });
      let need = needLevel(mod, method), have = lvl(c, mod);
      // un proyecto concreto: debe estar entre los visibles y respetar el nivel de «uso compartido»
      let pid = null;
      const mp = p.match(/^\/mgmt\/projects\/(\d+)/); if (mp) pid = +mp[1];
      const mt = p.match(/^\/mgmt\/tasks\/(\d+)/);
      if (!pid && mt) { const { rows: [t] } = await pool.query(`SELECT project_id FROM tasks WHERE id=$1 AND user_id=$2`, [+mt[1], c.owner]); pid = t ? t.project_id : null; }
      if (!pid && mod === 'tareas' && method === 'POST' && req.body && req.body.project_id) pid = +req.body.project_id || null;
      if (pid && (mod === 'proyectos' || mod === 'tareas')) {
        const vis = await visibleProjects(req);
        if (vis && !vis.has(pid)) return res.status(404).json({ error: 'No encontrado' });
        const sl = await shareLevel(c, pid);
        if (sl) {
          const comentario = sl === 'comentar' && method === 'POST' && /\/(activity|comments?)(\/|$)/.test(p);
          have = comentario ? Math.max(have, need) : Math.min(have || 3, SHARE_N[sl]);
        }
      }
      if (have < need) return res.status(403).json({ error: 'No tienes permiso para esto', modulo: mod });
      next();
    } catch (e) { console.error('[perms]', e.message); res.status(503).json({ error: 'No se pudieron comprobar los permisos' }); }
  });

  const isAdmin = async req => { const c = await ctx(req); return c.isOwner || c.rol === 'admin' || lvl(c, 'config') >= 3; };
  // ── API de gestión de permisos ──
  app.get('/api/perms/me', requireAuth, async (req, res) => { try { const c = await ctx(req); res.json({ rol: c.rol, owner: c.isOwner, nombre: c.nombre, permisos: c.perms, admin: await isAdmin(req) }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
  app.get('/api/perms/catalog', requireAuth, async (req, res) => {
    try {
      if (!(await isAdmin(req))) return res.status(403).json({ error: 'Solo un administrador puede ver esto' });
      const owner = req.workspaceOwnerId, { rows: rc } = await pool.query(`SELECT rol, permisos FROM perm_roles WHERE user_id=$1`, [owner]);
      const custom = Object.fromEntries(rc.map(r => [r.rol, r.permisos])), roles = {};
      for (const r of ROLES) roles[r.k] = resolve(r.k, custom[r.k], null);
      const { rows: ms } = await pool.query(`SELECT tm.id, tm.nombre, tm.email, tm.rol, tm.cargo, tm.estado, tm.permisos, u.workspace_id FROM team_members tm LEFT JOIN users u ON LOWER(u.email)=LOWER(tm.email) AND (u.workspace_id=$1 OR u.id=$1) WHERE tm.user_id=$1 ORDER BY tm.id`, [owner]);
      res.json({ modulos: MODULOS, roles: ROLES, niveles: ['Sin acceso', 'Ver', 'Editar', 'Administrar'], efectivos: roles, personalizados: custom, miembros: ms.map(m => ({ ...m, es_propietario: m.cargo === 'Propietario' })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/perms/roles/:rol', requireAuth, async (req, res) => {
    try {
      if (!(await isAdmin(req))) return res.status(403).json({ error: 'Solo un administrador puede cambiar los roles' });
      const rol = req.params.rol; if (!['manager', 'miembro', 'lector'].includes(rol)) return res.status(400).json({ error: 'Ese rol no se puede cambiar' });
      const out = {}; for (const m of MODULOS) { const v = norm((req.body && req.body.permisos || {})[m.k], m); if (v) out[m.k] = v; }
      await pool.query(`INSERT INTO perm_roles (user_id, rol, permisos) VALUES ($1,$2,$3::jsonb) ON CONFLICT (user_id, rol) DO UPDATE SET permisos=$3::jsonb`, [req.workspaceOwnerId, rol, JSON.stringify(out)]);
      clear(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/perms/roles/:rol/reset', requireAuth, async (req, res) => {
    try { if (!(await isAdmin(req))) return res.status(403).json({ error: 'Solo un administrador' }); await pool.query(`DELETE FROM perm_roles WHERE user_id=$1 AND rol=$2`, [req.workspaceOwnerId, req.params.rol]); clear(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/perms/members/:id', requireAuth, async (req, res) => {
    try {
      const c = await ctx(req); if (!(await isAdmin(req))) return res.status(403).json({ error: 'Solo un administrador puede cambiar permisos' });
      const id = parseInt(req.params.id, 10), owner = req.workspaceOwnerId, b = req.body || {};
      const { rows: [tm] } = await pool.query(`SELECT id, rol, cargo, email FROM team_members WHERE id=$1 AND user_id=$2`, [id, owner]); if (!tm) return res.status(404).json({ error: 'Persona no encontrada' });
      if (tm.cargo === 'Propietario') return res.status(400).json({ error: 'El propietario siempre tiene acceso total' });
      if (tm.id === c.memberId && b.rol && b.rol !== 'admin' && !c.isOwner) return res.status(400).json({ error: 'No puedes quitarte tu propio rol de administrador' });
      const rol = ['admin', 'manager', 'miembro', 'lector'].includes(b.rol) ? b.rol : tm.rol;
      const ov = {}; if (b.permisos && typeof b.permisos === 'object') for (const m of MODULOS) { const v = norm(b.permisos[m.k], m); if (v) ov[m.k] = v; }
      await pool.query(`UPDATE team_members SET rol=$3, permisos=$4::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [id, owner, rol, JSON.stringify(rol === 'admin' ? {} : ov)]);
      clear(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // uso compartido de un espacio o proyecto
  app.get('/api/perms/shares', requireAuth, async (req, res) => {
    try {
      const tipo = req.query.tipo === 'space' ? 'space' : 'project', rid = parseInt(req.query.id, 10) || 0, c = await ctx(req);
      if (!c.isOwner && lvl(c, tipo === 'space' ? 'espacios' : 'proyectos') < 2) return res.status(403).json({ error: 'Sin permiso' });
      const { rows } = await pool.query(`SELECT s.member_id, s.nivel, tm.nombre, tm.email, tm.rol FROM resource_shares s JOIN team_members tm ON tm.id=s.member_id WHERE s.user_id=$1 AND s.tipo=$2 AND s.recurso_id=$3`, [req.workspaceOwnerId, tipo, rid]);
      const { rows: ms } = await pool.query(`SELECT id, nombre, email, rol, cargo, estado, permisos FROM team_members WHERE user_id=$1 ORDER BY nombre`, [req.workspaceOwnerId]);
      res.json({ compartidos: rows, equipo: ms.map(m => ({ id: m.id, nombre: m.nombre, email: m.email, rol: m.rol, cargo: m.cargo, estado: m.estado, ve_todo: m.rol === 'admin' || m.cargo === 'Propietario' || (resolve(m.rol, null, m.permisos)[tipo === 'space' ? 'espacios' : 'proyectos'].a === 'todo' && resolve(m.rol, null, m.permisos)[tipo === 'space' ? 'espacios' : 'proyectos'].n > 0) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/perms/shares', requireAuth, async (req, res) => {
    try {
      const b = req.body || {}, tipo = b.tipo === 'space' ? 'space' : 'project', rid = parseInt(b.recurso_id, 10), mid = parseInt(b.member_id, 10), c = await ctx(req);
      if (!c.isOwner && lvl(c, tipo === 'space' ? 'espacios' : 'proyectos') < 3 && c.rol !== 'manager') return res.status(403).json({ error: 'Sin permiso para compartir' });
      if (!mid || (tipo === 'project' && !rid)) return res.status(400).json({ error: 'Datos incompletos' });
      if (!b.nivel) await pool.query(`DELETE FROM resource_shares WHERE user_id=$1 AND tipo=$2 AND recurso_id=$3 AND member_id=$4`, [req.workspaceOwnerId, tipo, rid, mid]);
      else { if (!SHARE_N[b.nivel]) return res.status(400).json({ error: 'Nivel inválido' }); await pool.query(`INSERT INTO resource_shares (user_id, tipo, recurso_id, member_id, nivel) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tipo, recurso_id, member_id) DO UPDATE SET nivel=$5`, [req.workspaceOwnerId, tipo, rid, mid, b.nivel]); }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return { ctx, filterProjects, filterTasks, filterClients, filterSpaces, visibleProjects, clear, resolve, MODULOS, ROLES, DEFAULTS, RUTAS, needLevel, ALL };
}
module.exports = { mount, MODULOS, ROLES, DEFAULTS, resolve, RUTAS, needLevel };
