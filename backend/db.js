'use strict';

/**
 * db.js — PostgreSQL connection pool (singleton)
 *
 * CONNECTION STRATEGY
 * ───────────────────
 * We parse DATABASE_URL manually and pass every parameter explicitly to
 * the pg Pool constructor. This prevents the pg library from falling back
 * to its own environment-variable defaults (PGHOST, PGPORT, PGDATABASE,
 * PGUSER, PGPASSWORD) which can silently redirect connections to
 * 127.0.0.1:5432 when the primary host is unreachable.
 *
 * If DATABASE_URL is missing or unparseable the process exits immediately
 * with a clear message — there is no localhost fallback, ever.
 *
 * RENDER INTERNAL vs EXTERNAL URL
 * ────────────────────────────────
 * Use the "Internal Database URL" shown in Render's database info page.
 * It looks like:
 *   postgresql://user:pass@dpg-xxxxxxxx-a/dbname
 *
 * That hostname (dpg-…-a) is only resolvable from Render services in the
 * SAME REGION. If you see ENOTFOUND, verify both the web service and the
 * database are in the same region (Render dashboard → Settings → Region).
 * If they differ, change the web service region to match, then redeploy.
 *
 * The "External Database URL" (…ohio.render.com:5432) works from anywhere
 * but is slower; use it only as a temporary fallback during debugging.
 */

const { Pool } = require('pg');

// ── 1. Require DATABASE_URL ────────────────────────────────────────
const RAW_URL = process.env.DATABASE_URL;

if (!RAW_URL) {
  console.error(
    '[db] FATAL: DATABASE_URL is not set.\n' +
    '     Add it in Render → Environment (use the Internal Database URL).'
  );
  process.exit(1);
}

// ── 2. Parse the URL — crash clearly if it is malformed ───────────
let _parsed;
try {
  _parsed = new URL(RAW_URL);
} catch (_) {
  console.error('[db] FATAL: DATABASE_URL is not a valid URL:', RAW_URL);
  process.exit(1);
}

const DB_HOST = _parsed.hostname;
const DB_PORT = parseInt(_parsed.port, 10) || 5432;
const DB_USER = decodeURIComponent(_parsed.username);
const DB_PASS = decodeURIComponent(_parsed.password);
const DB_NAME = _parsed.pathname.replace(/^\//, '');

if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.error(
    `[db] FATAL: DATABASE_URL is incomplete.\n` +
    `     host="${DB_HOST}" user="${DB_USER}" db="${DB_NAME}"\n` +
    `     Expected format: postgresql://user:pass@hostname/dbname`
  );
  process.exit(1);
}

console.log(`[db] resolved → host=${DB_HOST} port=${DB_PORT} db=${DB_NAME} user=${DB_USER}`);

// ── 3. Create pool with explicit params — no pg env-var fallback ───
// Passing each field individually means pg has nothing to infer from
// PGHOST / PGPORT / etc., eliminating the 127.0.0.1 fallback path.
const pool = new Pool({
  host:     DB_HOST,
  port:     DB_PORT,
  user:     DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  ssl:      { rejectUnauthorized: false },  // required for Render managed Postgres
  max:                      10,
  idleTimeoutMillis:        30_000,
  connectionTimeoutMillis:   5_000,
});

pool.on('error', err => {
  console.error('[db] unexpected pool error:', err.message);
});

// Fija cada conexión a UTC−5 (Lima = Bogotá, sin horario de verano) para que
// CURRENT_DATE / NOW()::date y las conversiones de timestamptz reflejen la zona
// horaria del equipo, no la del servidor (Vultr, normalmente UTC). Sin esto, a
// partir de las 19:00 hora local el "día de hoy" del servidor ya sería el de mañana.
pool.on('connect', client => {
  client.query("SET TIME ZONE 'America/Bogota'").catch(err =>
    console.error('[db] no se pudo fijar la zona horaria de la sesión:', err.message));
});

// ── 4. Schema migration ────────────────────────────────────────────
async function initDb() {
  // Smoke-test the connection before running DDL so the error message
  // names the real host instead of a pg internal address.
  let client;
  try {
    client = await pool.connect();
    console.log('[db] connection established');
  } catch (err) {
    console.error(
      `[db] FATAL: cannot connect to ${DB_HOST}:${DB_PORT} — ${err.message}\n` +
      `     If you see ENOTFOUND, check that the Render web service and the\n` +
      `     database are in the SAME region (Render dashboard → Settings → Region).\n` +
      `     Then paste the "Internal Database URL" into the DATABASE_URL env var.`
    );
    throw err;
  } finally {
    client?.release();
  }

  try {
    // ── users table (Google OAuth) ───────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL      PRIMARY KEY,
        google_id   TEXT        UNIQUE NOT NULL,
        email       TEXT        NOT NULL,
        name        TEXT        NOT NULL DEFAULT '',
        avatar      TEXT        NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id);
    `);

    // ── verifications table ──────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        bounceVerifyId  TEXT        PRIMARY KEY,
        email           TEXT        NOT NULL,
        leadId          TEXT        NOT NULL DEFAULT '',
        messageId       TEXT        NOT NULL DEFAULT '',
        status          TEXT        NOT NULL
                          CHECK (status IN ('pending', 'verified', 'bounced', 'error'))
                          DEFAULT 'pending',
        confidence      TEXT        NOT NULL DEFAULT 'pending',
        user_id         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      );
    `);

    // Allow 'error' status on existing tables (safe: IF NOT EXISTS equivalent via DO block)
    await pool.query(`
      DO $$
      BEGIN
        ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_status_check;
        ALTER TABLE verifications ADD CONSTRAINT verifications_status_check
          CHECK (status IN ('pending','verified','bounced','error'));
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);

    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    // Ordered list of remaining candidates to try after a hard bounce (cascade)
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS remaining_candidates JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    // User-defined label for grouping / filtering verifications
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS tag TEXT;
    `);

    // Full lead data snapshot (firstName, lastName, company, + any extra CRM fields)
    await pool.query(`
      ALTER TABLE verifications
        ADD COLUMN IF NOT EXISTS lead_data JSONB;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_email_idx
        ON verifications (lower(email));
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_messageid_idx
        ON verifications (messageId);
    `);

    // ── batch_jobs table ─────────────────────────────────────────
    // Persists background enrichment jobs so they survive server restarts.
    // Previously stored in-memory (_jobs Map) which was lost on Render restart.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        job_id      TEXT        PRIMARY KEY,
        user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        status      TEXT        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','done','error')),
        total       INTEGER     NOT NULL DEFAULT 0,
        results     JSONB,
        warnings    JSONB,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS batch_jobs_user_idx ON batch_jobs (user_id);
    `);

    // Auto-clean jobs older than 7 days to keep the table small
    await pool.query(`
      DELETE FROM batch_jobs WHERE created_at < NOW() - INTERVAL '7 days';
    `);

    // ── Dolor 1: mark stuck jobs as error on startup ──────────────
    // If the server restarted while a job was running, it stays 'running'
    // forever. Mark any job older than 2 hours as error so the frontend
    // shows a clear message instead of spinning indefinitely.
    const { rows: stuckJobs } = await pool.query(`
      UPDATE batch_jobs
         SET status = 'error',
             error  = 'El servidor se reinició durante el procesamiento. Vuelve a subir el archivo.',
             finished_at = NOW()
       WHERE status = 'running'
         AND created_at < NOW() - INTERVAL '2 hours'
       RETURNING job_id
    `);
    if (stuckJobs.length > 0)
      console.log(`[db] cleared ${stuckJobs.length} stuck job(s) from previous run`);

    // ── Dolor 5: index on leadid for sweep performance ────────────
    // The catch-all sweep does GROUP BY leadid — without an index it
    // does a full table scan. Partial index (non-null leadid only).
    await pool.query(`
      CREATE INDEX IF NOT EXISTS verifications_leadid_status_idx
        ON verifications (leadid, status)
        WHERE leadid IS NOT NULL AND leadid != '';
    `);

    // ── clients table ────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id               SERIAL      PRIMARY KEY,
        user_id          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        nombre           TEXT        NOT NULL,
        empresa          TEXT        NOT NULL DEFAULT '',
        email            TEXT        NOT NULL DEFAULT '',
        telefono         TEXT        NOT NULL DEFAULT '',
        pais             TEXT        NOT NULL DEFAULT '',
        estado           TEXT        NOT NULL DEFAULT 'activo',
        notas            TEXT        NOT NULL DEFAULT '',
        comision_default NUMERIC(5,2),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS clients_user_idx ON clients (user_id);
    `);

    // ── clients: new enriched fields (idempotent) ─────────────────
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS cargo        TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS sitio_web    TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS linkedin     TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS industria    TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS pais_empresa TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ciudad       TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS notas_empresa TEXT NOT NULL DEFAULT '';`);
    // Dos niveles: 'cliente' (tiene proyectos) y 'contacto' (registrado desde Oportunidades u otro
    // origen, aún sin proyecto). Los contactos NO generan la alerta "cliente sin proyecto"; al
    // crearles su primer proyecto se promueven a 'cliente' automáticamente.
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'cliente';`);

    // ── client_contacts table ─────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_contacts (
        id         SERIAL      PRIMARY KEY,
        client_id  INTEGER     NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        nombre     TEXT        NOT NULL DEFAULT '',
        email      TEXT        NOT NULL DEFAULT '',
        telefono   TEXT        NOT NULL DEFAULT '',
        cargo      TEXT        NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS client_contacts_client_idx ON client_contacts(client_id);
    `);

    // ── projects table ───────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id               SERIAL      PRIMARY KEY,
        user_id          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        client_id        INTEGER     REFERENCES clients(id) ON DELETE SET NULL,
        nombre           TEXT        NOT NULL,
        descripcion      TEXT        NOT NULL DEFAULT '',
        estado           TEXT        NOT NULL DEFAULT 'activo',
        responsable      TEXT        NOT NULL DEFAULT '',
        fecha_inicio     DATE,
        fecha_fin        DATE,
        valor_total      NUMERIC(12,2),
        prioridad        TEXT        NOT NULL DEFAULT 'media',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS projects_user_idx   ON projects (user_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS projects_client_idx ON projects (client_id);
    `);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS comision NUMERIC(5,2);`);

    // ── tasks table ──────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          SERIAL      PRIMARY KEY,
        user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        project_id  INTEGER     REFERENCES projects(id) ON DELETE SET NULL,
        titulo      TEXT        NOT NULL,
        descripcion TEXT        NOT NULL DEFAULT '',
        estado      TEXT        NOT NULL DEFAULT 'pendiente',
        prioridad   TEXT        NOT NULL DEFAULT 'media',
        responsable TEXT        NOT NULL DEFAULT '',
        deadline    DATE,
        notas       TEXT        NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS tasks_user_idx    ON tasks (user_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id);
    `);
    await pool.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
    `);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS monto NUMERIC(12,2);`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cobrado BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cobrado_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estado_financiero TEXT NOT NULL DEFAULT 'sin_revisar';`);
    // Facturación por miembro: cobrado (cliente pagó) ≠ en_cuenta (ya transferido a la cuenta personal).
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS en_cuenta BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS en_cuenta_at TIMESTAMPTZ;`);
    // Tarea de cobro semanal auto-creada: lunes de su semana (idempotencia de ensure-weekly).
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS billing_week DATE;`);
    // Proyectos con cobro semanal (tarea de cobro auto por semana) + reparto por proyecto
    // reparto JSONB: [{"nombre":"Jenny","pct":30},{"nombre":"José","pct":70}] · null/[] = 100% del responsable.
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS cobro_semanal BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Semana de TRABAJO automática: cada domingo se crea la tarea contenedora de la semana
    // entrante ("ABREV · 27 jul – 2 ago"), heredando el plan (horas/días/hora) de la anterior.
    // Es independiente del cobro semanal (esa es la tarea de facturación).
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS semana_auto BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Abreviatura del contrato para los títulos ('' = se deriva del nombre del proyecto).
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS abrev TEXT NOT NULL DEFAULT '';`);
    // Plan de trabajo POR PROYECTO: días de la semana, meta de horas y hora de inicio.
    // La tarea semanal que se crea cada domingo lo hereda (antes solo se copiaba de la
    // semana anterior, así que no había dónde definirlo la primera vez).
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_dias  TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_horas NUMERIC(6,2);`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_hora  INTEGER;`);
    // Lunes de la semana que representa la tarea (idempotencia de la creación automática).
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS semana_week DATE;`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS precio_semanal NUMERIC(12,2);`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS reparto JSONB;`);
    // Rango de fechas: las tareas PADRE usan [fecha_inicio, deadline]; las subtareas usan deadline (fecha fija).
    // deadline = fin del rango; fecha_inicio = inicio (solo tareas padre). Null = comportamiento de fecha única (legacy).
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fecha_inicio DATE;`);
    // Plan de trabajo recurrente (sugerido): días de la semana a trabajar + meta de horas + hora de inicio.
    // plan_dias: índices de día separados por coma, 0=Lun … 6=Dom (ej. "1,3" = Mar y Jue).
    // plan_horas: meta TOTAL de horas (se reparte entre las ocurrencias de esos días dentro de [fecha_inicio, deadline]).
    // plan_hora: hora de inicio 0–23. Aplica a la SUBTAREA cuando la tarea tiene subtareas.
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_dias TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_horas NUMERIC(6,2);`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_hora INTEGER;`);
    // CC de la respuesta: si no se guarda, el envio programado la manda solo al
    // contacto y pierde a todos los que iban en copia.
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS cc_emails TEXT NOT NULL DEFAULT '';`);
    // Destinatarios del correo entrante: sin ellos, responder solo iba al remitente
    // y se caian del hilo todos los que estaban en CC.
    await pool.query(`ALTER TABLE lm_inbox_messages ADD COLUMN IF NOT EXISTS to_emails TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_inbox_messages ADD COLUMN IF NOT EXISTS cc_emails TEXT NOT NULL DEFAULT '';`);
    // Workspaces de Slack conectados. Uno por cliente: la idea es dejar de saltar de
    // uno a otro. El token va CIFRADO (mismo AES-256-GCM que las contrasenas de los
    // buzones); en claro no se guarda nunca.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slack_workspaces (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id     TEXT    NOT NULL,
        team_name   TEXT    NOT NULL DEFAULT '',
        etiqueta    TEXT    NOT NULL DEFAULT '',
        token_enc   TEXT    NOT NULL,
        token_tipo  TEXT    NOT NULL DEFAULT 'bot',
        scopes      TEXT    NOT NULL DEFAULT '',
        bot_user_id TEXT    NOT NULL DEFAULT '',
        estado      TEXT    NOT NULL DEFAULT 'conectado',
        ultimo_error TEXT   NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, team_id)
      );`);
    // Canal de Slack ligado a un proyecto: el id del canal (y de que workspace).
    // Con esto la automatizacion sabe que canal renombrar o archivar cuando el
    // proyecto cambia de estado, sin adivinar por el nombre.
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_channel_id TEXT;`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_ws_id INTEGER;`);
    // Color del proyecto en el calendario (hex). NULL = se asigna uno estable por id.
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS color TEXT;`);
    // Excepciones al plan recurrente: mover UN día concreto sin tocar el resto de la semana.
    // hora NULL + skip=true → ese día no se trabaja. Si no hay fila, manda el plan de la tarea.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_plan_overrides (
        id       SERIAL PRIMARY KEY,
        user_id  INTEGER NOT NULL,
        task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        fecha    DATE NOT NULL,
        hora     INTEGER,
        minutos  INTEGER,
        skip     BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (task_id, fecha)
      );`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tpo_user_fecha ON task_plan_overrides(user_id, fecha);`);
    await pool.query(`ALTER TABLE slack_workspaces ADD COLUMN IF NOT EXISTS es_default_proyectos BOOLEAN NOT NULL DEFAULT false;`);
    // Logo real del team (team.info) en vez de mostrar solo la inicial en el riel de chat.
    await pool.query(`ALTER TABLE slack_workspaces ADD COLUMN IF NOT EXISTS icon_url TEXT NOT NULL DEFAULT '';`);
    // Visibilidad por espacio conectado: 'todos' (todo el equipo) | 'admin' (solo
    // admins) | 'solo_yo' (privado, solo quien lo conectó). connected_by guarda a
    // la PERSONA real que conectó (user_id sigue siendo el dueño del workspace,
    // compartido por todos — hacía falta distinguir quién conectó cada uno para
    // poder marcarlo privado).
    await pool.query(`ALTER TABLE slack_workspaces ADD COLUMN IF NOT EXISTS visibilidad TEXT NOT NULL DEFAULT 'todos';`);
    await pool.query(`ALTER TABLE slack_workspaces ADD COLUMN IF NOT EXISTS connected_by INTEGER;`);
    await pool.query(`UPDATE slack_workspaces SET connected_by = user_id WHERE connected_by IS NULL;`);
    // Id de la persona DENTRO de Slack (auth.test) para ese token — sirve para
    // detectar "ese directo soy yo" y mostrarlo primero, marcado "(yo)".
    await pool.query(`ALTER TABLE slack_workspaces ADD COLUMN IF NOT EXISTS slack_user_id TEXT NOT NULL DEFAULT '';`);
    // Respaldo de "ya lo marqué leído": para conversaciones viejas (fuera del
    // historial que retiene el plan gratis de Slack, ~90 días) Slack se queda
    // pegado en unread_count_display=1 pese a conversations.mark — y como no se
    // puede traer conversations.history tan atrás, tampoco hay ts que darle al
    // mark. Por eso el respaldo usa la HORA REAL en la que se marcó leído
    // (marcado_at), no un ts de Slack: si no hay actividad de Slack más nueva
    // que esa hora, se ignora su conteo aunque Slack siga reportándolo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slack_leido_override (
        id           SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        canal_id     TEXT    NOT NULL,
        marcado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workspace_id, canal_id)
      )`);
    // CREATE TABLE IF NOT EXISTS no toca columnas de una tabla que ya existía de
    // un primer intento con leido_ts NOT NULL — sin este ALTER, todo INSERT
    // fallaba en silencio (atrapado por el try/catch del endpoint) y el respaldo
    // nunca se guardaba.
    await pool.query(`ALTER TABLE slack_leido_override DROP COLUMN IF EXISTS leido_ts;`);
    // Programación en Calendario (cuándo planeo trabajar la tarea — independiente del deadline)
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prog_fecha DATE;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prog_inicio TEXT;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prog_min INTEGER;`);
    await pool.query(`UPDATE tasks SET cobrado_at=updated_at WHERE cobrado=true AND cobrado_at IS NULL;`);
    await pool.query(`ALTER TABLE tasks    ADD COLUMN IF NOT EXISTS responsables TEXT[] NOT NULL DEFAULT '{}';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS responsables TEXT[] NOT NULL DEFAULT '{}';`);
    await pool.query(`UPDATE tasks    SET responsables = ARRAY[responsable] WHERE responsable <> '' AND responsables = '{}';`);
    await pool.query(`UPDATE projects SET responsables = ARRAY[responsable] WHERE responsable <> '' AND responsables = '{}';`);

    // ── meetings table ────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id          SERIAL       PRIMARY KEY,
        user_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
        titulo      TEXT         NOT NULL DEFAULT '',
        fecha       DATE         NOT NULL,
        hora_inicio TIME,
        hora_fin    TIME,
        descripcion TEXT         NOT NULL DEFAULT '',
        link        TEXT         NOT NULL DEFAULT '',
        attendees   TEXT         NOT NULL DEFAULT '[]',
        estado      TEXT         NOT NULL DEFAULT 'programada',
        created_at  TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS meetings_user_idx  ON meetings (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS meetings_fecha_idx ON meetings (fecha);`);
    // Recordatorio: minutos antes de la hora de inicio para avisar (NULL = sin
    // recordatorio). "enviado" evita que el job de recordatorios lo repita.
    await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recordatorio_min INTEGER;`);
    await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recordatorio_enviado BOOLEAN NOT NULL DEFAULT FALSE;`);

    // ── time_off table ────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS time_off (
        id           SERIAL       PRIMARY KEY,
        user_id      INTEGER      REFERENCES users(id)         ON DELETE SET NULL,
        member_id    INTEGER      REFERENCES team_members(id)  ON DELETE CASCADE,
        fecha_inicio DATE         NOT NULL,
        fecha_fin    DATE         NOT NULL,
        motivo       TEXT         NOT NULL DEFAULT 'Vacaciones',
        notas        TEXT         NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS time_off_user_idx ON time_off (user_id);`);

    // ── payments table ───────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id             SERIAL        PRIMARY KEY,
        user_id        INTEGER       REFERENCES users(id)    ON DELETE SET NULL,
        client_id      INTEGER       REFERENCES clients(id)  ON DELETE SET NULL,
        project_id     INTEGER       REFERENCES projects(id) ON DELETE SET NULL,
        concepto       TEXT          NOT NULL DEFAULT '',
        monto_bruto    NUMERIC(12,2) NOT NULL DEFAULT 0,
        porcentaje     NUMERIC(5,2),
        monto_neto     NUMERIC(12,2),
        fecha_esperada DATE,
        fecha_pagada   DATE,
        estado         TEXT          NOT NULL DEFAULT 'pendiente',
        notas          TEXT          NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS payments_user_idx   ON payments (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS payments_client_idx ON payments (client_id);`);

    // ── team_members table ───────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id         SERIAL      PRIMARY KEY,
        user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        nombre     TEXT        NOT NULL,
        email      TEXT        NOT NULL DEFAULT '',
        rol        TEXT        NOT NULL DEFAULT 'miembro',
        estado     TEXT        NOT NULL DEFAULT 'activo',
        notas      TEXT        NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS team_user_idx ON team_members (user_id);`);
    await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cargo TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'activo';`);

    // ── workspace_id on users (null = owner, set = member) ────────────
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    // ── workspaces table ─────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id             SERIAL      PRIMARY KEY,
        owner_id       INTEGER     REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        name           TEXT        NOT NULL DEFAULT 'Mi Workspace',
        company_name   TEXT        NOT NULL DEFAULT '',
        company_logo   TEXT        NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS company_logo TEXT NOT NULL DEFAULT '';`);

    // ── workspace_invites table ──────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id                   SERIAL      PRIMARY KEY,
        workspace_owner_id   INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        email                TEXT        NOT NULL,
        token                TEXT        NOT NULL UNIQUE,
        expires_at           TIMESTAMPTZ NOT NULL,
        used                 BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ws_invites_token_idx ON workspace_invites (token);`);
    await pool.query(`ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS nombre TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS cargo  TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS nivel  TEXT NOT NULL DEFAULT 'miembro';`);

    // ── chat_messages table ──────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id                   SERIAL      PRIMARY KEY,
        workspace_owner_id   INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        channel              TEXT        NOT NULL,
        sender_id            INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        content              TEXT        NOT NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS chat_msgs_ws_ch_idx
        ON chat_messages (workspace_owner_id, channel, created_at DESC);
    `);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to JSONB;`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;`);

    // ── projects — nuevas columnas (tipo, moneda, horas) ─────────────
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tipo_proyecto TEXT NOT NULL DEFAULT 'fijo';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS moneda TEXT NOT NULL DEFAULT 'USD';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tarifa_hora NUMERIC(10,2);`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS horas_estimadas NUMERIC(8,2);`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS horas_semanales NUMERIC(6,2);`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS horario_semanal TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS responsable_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL;`);

    // ── leads table ──────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id             SERIAL        PRIMARY KEY,
        user_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        nombre         TEXT          NOT NULL,
        empresa        TEXT          NOT NULL DEFAULT '',
        email          TEXT          NOT NULL DEFAULT '',
        telefono       TEXT          NOT NULL DEFAULT '',
        pais           TEXT          NOT NULL DEFAULT '',
        cargo          TEXT          NOT NULL DEFAULT '',
        stage          TEXT          NOT NULL DEFAULT 'nuevo'
                         CHECK (stage IN ('nuevo','contactado','propuesta','negociacion','ganado','perdido')),
        fuente         TEXT          NOT NULL DEFAULT 'manual',
        valor_estimado NUMERIC(12,2),
        notas          TEXT          NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_user_idx ON leads (user_id);`);

    // ── outbound_clients (Lead Manager — unidad principal: cliente outbound) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbound_clients (
        id             SERIAL        PRIMARY KEY,
        user_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        nombre         TEXT          NOT NULL,
        estado         TEXT          NOT NULL DEFAULT 'preparacion'
                         CHECK (estado IN ('preparacion','activo','pausado','cerrado')),
        responsable    TEXT          NOT NULL DEFAULT '',
        canal          TEXT          NOT NULL DEFAULT '',
        website        TEXT          NOT NULL DEFAULT '',
        mercado        TEXT          NOT NULL DEFAULT '',
        icp            TEXT          NOT NULL DEFAULT '',
        proxima_accion TEXT          NOT NULL DEFAULT '',
        notas          TEXT          NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS outbound_clients_user_idx ON outbound_clients (user_id);`);
    // Buzón de envío del cliente (ej. Zoho que él proporciona) y CC solicitado — informativos, se muestran en la tarea.
    await pool.query(`ALTER TABLE outbound_clients ADD COLUMN IF NOT EXISTS from_email TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE outbound_clients ADD COLUMN IF NOT EXISTS cc_email   TEXT NOT NULL DEFAULT '';`);
    // Identidad del perfil de LinkedIn desde el que se comenta e invita (cada cliente tiene
    // el suyo). La IA de comentarios la usa para saber QUIÉN escribe: sin esto inventa un rol.
    await pool.query(`ALTER TABLE outbound_clients ADD COLUMN IF NOT EXISTS li_cargo    TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE outbound_clients ADD COLUMN IF NOT EXISTS li_empresa  TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE outbound_clients ADD COLUMN IF NOT EXISTS li_que_hace TEXT NOT NULL DEFAULT '';`);
    // leads ahora pueden pertenecer a un cliente outbound (nullable → no rompe leads existentes)
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS outbound_client_id INTEGER REFERENCES outbound_clients(id) ON DELETE SET NULL;`);

    // ── campaigns (Lead Manager Fase 2: campaña pertenece a un cliente outbound) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id                 SERIAL        PRIMARY KEY,
        user_id            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        outbound_client_id INTEGER       REFERENCES outbound_clients(id) ON DELETE CASCADE,
        nombre             TEXT          NOT NULL,
        estado             TEXT          NOT NULL DEFAULT 'draft'
                             CHECK (estado IN ('draft','activa','pausada','cerrada')),
        mercado            TEXT          NOT NULL DEFAULT '',
        icp                TEXT          NOT NULL DEFAULT '',
        canal              TEXT          NOT NULL DEFAULT '',
        canal_secundario   TEXT          NOT NULL DEFAULT '',
        objetivo           TEXT          NOT NULL DEFAULT '',
        fecha_inicio       DATE,
        notas              TEXT          NOT NULL DEFAULT '',
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS campaigns_user_idx ON campaigns (user_id);`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;`);

    // ── sequences + steps (Lead Manager Fase 3: planificación manual, sin envío automático) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sequences (
        id                 SERIAL        PRIMARY KEY,
        user_id            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        outbound_client_id INTEGER       REFERENCES outbound_clients(id) ON DELETE CASCADE,
        campaign_id        INTEGER       REFERENCES campaigns(id) ON DELETE SET NULL,
        nombre             TEXT          NOT NULL,
        objetivo           TEXT          NOT NULL DEFAULT '',
        estado             TEXT          NOT NULL DEFAULT 'draft'
                             CHECK (estado IN ('draft','activa','pausada','archivada')),
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS sequences_user_idx ON sequences (user_id);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sequence_steps (
        id          SERIAL        PRIMARY KEY,
        user_id     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        sequence_id INTEGER       REFERENCES sequences(id) ON DELETE CASCADE,
        dia         INTEGER       NOT NULL DEFAULT 1,
        canal       TEXT          NOT NULL DEFAULT 'email'
                      CHECK (canal IN ('email','linkedin','call','task','whatsapp')),
        titulo      TEXT          NOT NULL DEFAULT '',
        plantilla   TEXT          NOT NULL DEFAULT '',
        orden       INTEGER       NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS sequence_steps_seq_idx ON sequence_steps (sequence_id);`);
    // A/B testing: variantes de mensaje por paso + modo de reparto (off/random/segment) y campo del segmento.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS variants      JSONB NOT NULL DEFAULT '[]';`);
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS variant_mode  TEXT  NOT NULL DEFAULT 'off';`);
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS variant_field TEXT  NOT NULL DEFAULT '';`);
    // Hora opcional para hacer la tarea de este paso (HH:MM en hora local de quien la ejecuta). '' = todo el día.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS hora TEXT NOT NULL DEFAULT '';`);
    // Asunto del email SEPARADO del título del paso (el título es el nombre interno).
    // Antes el motor usaba titulo como asunto — confuso y sin campo propio en la UI.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS asunto TEXT NOT NULL DEFAULT '';`);
    // CC por paso: por defecto va el CC del cliente en cada envío; cc_off=TRUE lo quita en ESTE paso.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS cc_off BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Condición de rama del paso: '' = para todos; 'replied' = solo si el contacto respondió/aceptó;
    // 'no_reply' = solo si NO respondió. El motor salta los pasos cuya condición no aplica al contacto.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS cond TEXT NOT NULL DEFAULT '';`);
    // Acción del paso dentro del canal (LinkedIn: invitación con/sin nota, mensaje, follow…;
    // WhatsApp: mensaje/llamada; Llamada: llamada/voicemail). '' = acción por defecto del canal.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS accion TEXT NOT NULL DEFAULT '';`);
    // Zona horaria del prospecto por secuencia (IANA, p. ej. America/New_York) → ventana de envío sugerida.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT '';`);
    // Arranque escalonado (drip): nº de contactos nuevos a arrancar por día al enrolar. 0 = todos el mismo día.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS drip_per_day INTEGER NOT NULL DEFAULT 0;`);
    // Días de cadencia permitidos (Lun→Dom, '1'=sí). Default L–V. Los pasos/tareas caen solo en estos días.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS send_days TEXT NOT NULL DEFAULT '1111100';`);
    // Fecha de inicio (calendario): el "día 1" de los contactos que enroles no arranca antes de esta fecha. NULL = arranca al enrolar.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS starts_on DATE;`);
    // Límite diario de envíos POR SECUENCIA (cada cliente da su buzón). 0 = usa el límite global del workspace.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 0;`);
    // Contexto del segmento POR SECUENCIA: cada secuencia puede atacar un mercado/ICP distinto dentro
    // de la campaña (ej. Tier 1 · EE.UU. vs Tier 2 · LATAM). Salen en el informe PDF; si están vacíos,
    // el informe cae a los de la campaña.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS mercado TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS icp     TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS notas   TEXT NOT NULL DEFAULT '';`);
    // A quién buscar en LinkedIn dentro de cada empresa, EN ORDEN DE PRIORIDAD (target 1 = puesto
    // ideal, target 2 = alternativa si no lo encuentra). Distinto de `icp` (que describe el perfil
    // de la empresa, no el puesto de la persona) — se muestra en el task-runner de Cola de empresas
    // para saber a quién buscar antes de abrir LinkedIn Sales Navigator. Dos columnas cortas en vez
    // de una sola de texto libre: un solo input largo activaba el autocompletado de Chrome (sugería
    // texto guardado de otros formularios, ej. búsquedas de LinkedIn), pisando lo que se escribía.
    await pool.query(`ALTER TABLE sequences DROP COLUMN IF EXISTS target_roles;`);
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS target_role_1 TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS target_role_2 TEXT NOT NULL DEFAULT '';`);
    // Modo de envío por secuencia (estilo Outreach.io):
    //   manual      → se maneja externamente (tareas); el motor NO envía nada. Default.
    //   auto        → el motor envía solo por el buzón del cliente.
    //   preaprobado → el motor redacta el email y espera aprobación; al aprobar, sale solo.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS send_mode         TEXT    NOT NULL DEFAULT 'manual';`);
    // Minutos mínimos entre envíos automáticos de ESTA secuencia (anti-ráfaga).
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS send_interval_min INTEGER NOT NULL DEFAULT 5;`);
    // Auto-activación: al llegar starts_on, el motor pasa la secuencia a 'activa' solo.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS auto_activar      BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Canal principal de la secuencia: cuando el contacto acepta/responde, el
    // re-enrutado a la rama 'replied' PRIORIZA pasos de este canal (linkedin/email).
    // '' = auto (comportamiento clásico: primer paso replied sin importar canal).
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS preferred_channel TEXT NOT NULL DEFAULT '';`);
    // Nutrición automática (diseño acordado 2026-09-02): si esta secuencia termina TODOS
    // sus pasos sin que el contacto haya dado ninguna señal (disposition vacío), se le
    // asigna disposition='mas_adelante' con nurture_at = hoy + este número de días —
    // NULL/0 = apagado, nunca se reinscribe sola en ninguna secuencia (ver sendEngine.js
    // _maybeAutoNurture y services/nurtureWatcher.js). Por defecto NULL: no se activa
    // retroactivamente en secuencias existentes, cada una lo prende a propósito.
    await pool.query(`ALTER TABLE sequences ADD COLUMN IF NOT EXISTS nurture_days INTEGER;`);

    // Notificaciones descartadas a mano (pedido 2026-09-02: "Descartar" con doble clic
    // en el panel de Notificaciones) — kind+ref_id identifica la alerta puntual (ej.
    // 'tareas_vencidas'+task.id); se filtra en el próximo cálculo mientras el dato
    // subyacente no cambie (si la tarea vuelve a vencer con OTRA fecha, no aplica un
    // dismissal viejo porque ref_id es siempre el id de la tarea/proyecto, no de "un
    // vencimiento" — un descarte de "vencida" dura hasta que la propia tarea cambie de
    // categoría, ej. se completa o se le pone fecha nueva, momento en que deja de
    // aparecer en esa categoría de todas formas).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notif_dismissals (
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT        NOT NULL,
        ref_id     INTEGER     NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, kind, ref_id)
      );
    `);

    // ── activities (Lead Manager Fase 4: touches registrados + tareas comerciales) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id                 SERIAL        PRIMARY KEY,
        user_id            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        lead_id            INTEGER       REFERENCES leads(id) ON DELETE CASCADE,
        outbound_client_id INTEGER       REFERENCES outbound_clients(id) ON DELETE CASCADE,
        campaign_id        INTEGER       REFERENCES campaigns(id) ON DELETE SET NULL,
        tipo               TEXT          NOT NULL DEFAULT 'nota',
        canal              TEXT          NOT NULL DEFAULT '',
        nota               TEXT          NOT NULL DEFAULT '',
        fecha              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        estado             TEXT          NOT NULL DEFAULT 'hecha'
                             CHECK (estado IN ('hecha','pendiente')),
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS activities_user_idx ON activities (user_id);`);
    // Fase 5: clasificación de sentimiento para respuestas (Inbox)
    await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS sentimiento TEXT NOT NULL DEFAULT '';`);
    // Quién escribió la nota/comentario (pedido 2026-09-02: notas de Deal con fecha+hora
    // y miembro, sin que se vea como título — solo un dato de contexto discreto).
    await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS autor TEXT NOT NULL DEFAULT '';`);

    // ── Lead Manager · Empresas + Contactos (importables, estilo Apollo/HubSpot) ──
    // lm_companies: cuentas objetivo. Se deduplican por dominio normalizado (o nombre).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_companies (
        id                 SERIAL        PRIMARY KEY,
        user_id            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        nombre             TEXT          NOT NULL DEFAULT '',
        dominio            TEXT          NOT NULL DEFAULT '',
        website            TEXT          NOT NULL DEFAULT '',
        industria          TEXT          NOT NULL DEFAULT '',
        tamano             TEXT          NOT NULL DEFAULT '',
        ingresos           TEXT          NOT NULL DEFAULT '',
        telefono           TEXT          NOT NULL DEFAULT '',
        linkedin           TEXT          NOT NULL DEFAULT '',
        ciudad             TEXT          NOT NULL DEFAULT '',
        region             TEXT          NOT NULL DEFAULT '',
        pais               TEXT          NOT NULL DEFAULT '',
        fundada            TEXT          NOT NULL DEFAULT '',
        outbound_client_id INTEGER       REFERENCES outbound_clients(id) ON DELETE SET NULL,
        notas              TEXT          NOT NULL DEFAULT '',
        raw                JSONB         NOT NULL DEFAULT '{}',
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_companies_user_idx ON lm_companies (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_companies_dom_idx  ON lm_companies (user_id, dominio);`);

    // lm_contacts: personas ligadas a una empresa (company_id). Se deduplican por email.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_contacts (
        id                 SERIAL        PRIMARY KEY,
        user_id            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        company_id         INTEGER       REFERENCES lm_companies(id) ON DELETE SET NULL,
        nombre             TEXT          NOT NULL DEFAULT '',
        apellido           TEXT          NOT NULL DEFAULT '',
        email              TEXT          NOT NULL DEFAULT '',
        telefono           TEXT          NOT NULL DEFAULT '',
        movil              TEXT          NOT NULL DEFAULT '',
        cargo              TEXT          NOT NULL DEFAULT '',
        seniority          TEXT          NOT NULL DEFAULT '',
        departamento       TEXT          NOT NULL DEFAULT '',
        linkedin           TEXT          NOT NULL DEFAULT '',
        empresa_nombre     TEXT          NOT NULL DEFAULT '',
        ciudad             TEXT          NOT NULL DEFAULT '',
        region             TEXT          NOT NULL DEFAULT '',
        pais               TEXT          NOT NULL DEFAULT '',
        estado             TEXT          NOT NULL DEFAULT 'nuevo',
        fuente             TEXT          NOT NULL DEFAULT 'import',
        outbound_client_id INTEGER       REFERENCES outbound_clients(id) ON DELETE SET NULL,
        notas              TEXT          NOT NULL DEFAULT '',
        raw                JSONB         NOT NULL DEFAULT '{}',
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_contacts_user_idx    ON lm_contacts (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_contacts_company_idx ON lm_contacts (company_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_contacts_email_idx   ON lm_contacts (user_id, email);`);
    // Campos adicionales (import Apollo/HubSpot): más atributos de empresa + email personal del contacto.
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS direccion     TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS codigo_postal TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS descripcion   TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS tecnologias   TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS funding       TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS email_personal TEXT NOT NULL DEFAULT '';`);
    // Cualificación outbound (import Apollo/HubSpot): tier/foco de la cuenta + prioridad y rol de compra del contacto.
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS target_tier      TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS contact_priority TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS buyer_role       TEXT NOT NULL DEFAULT '';`);
    // Disposición outbound (independiente del paso): respondio/reunion/no_interesado/no_contactar. Vacío = sin marcar.
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS disposition      TEXT NOT NULL DEFAULT '';`);
    // Derivación: quién refirió a este contacto (el lead que dijo "habla con X" o al que
    // reemplaza). Da trazabilidad en ambos sentidos dentro de la misma empresa.
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS referred_by      INTEGER REFERENCES lm_contacts(id) ON DELETE SET NULL;`);
    // Sentido inverso: a quién derivó ESTE contacto (se setea junto con referred_by del
    // nuevo, en /lm/contacts/:id/refer). Sin esto, la ficha/tabla del que derivó no tenía
    // forma de saber a quién — solo quedaba como texto suelto en la actividad.
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS derivado_a       INTEGER REFERENCES lm_contacts(id) ON DELETE SET NULL;`);
    // Nota opcional dejada al derivar (ej. "me pasó su correo directo") — vive en el
    // NUEVO contacto para poder mostrarla en un banner fijo de su ficha/tarea (pedido
    // 2026-09-03: que no se pueda evitar leerla al trabajar a un contacto derivado).
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS referred_note    TEXT NOT NULL DEFAULT '';`);
    // Nurturing: fecha en la que hay que retomar a un contacto marcado "Más adelante".
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS nurture_at       DATE;`);
    // "Aceptó en LinkedIn" deja de ocupar disposition (2026-09-03, a pedido de Jenny):
    // es un evento de UN canal, no un estado del contacto — antes tapaba una respuesta
    // real (compartía el mismo campo que "Interesado") y confundía el pipeline. Pasa a
    // ser su propio timestamp; sigue disparando el re-enrutado a la rama "replied" igual
    // que antes, solo que ya no pisa disposition. Ver server.js /contacts/:id/disposition.
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS li_aceptado_at   TIMESTAMPTZ;`);
    await pool.query(`UPDATE lm_contacts SET li_aceptado_at = COALESCE(li_aceptado_at, updated_at) WHERE disposition = 'aceptado';`);
    await pool.query(`UPDATE lm_contacts SET disposition = '' WHERE disposition = 'aceptado';`);
    // Deals: capa financiera del pipeline por contacto (valor estimado · probabilidad · cierre)
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS deal_valor       NUMERIC(12,2);`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS deal_moneda      TEXT NOT NULL DEFAULT 'USD';`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS deal_prob        INTEGER;`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS deal_cierre      DATE;`);
    // Backfill del pipeline automático (idempotente; red de seguridad en cada boot):
    // 1er paso completado → contactado; disposición positiva → respondio; descartes → perdido.
    // Solo desde etapas anteriores — nunca toca propuesta/negociación/ganado (manual).
    await pool.query(`UPDATE lm_contacts k SET estado='contactado', updated_at=NOW()
      WHERE k.estado='nuevo' AND EXISTS (SELECT 1 FROM lm_contact_sequences cs
        WHERE cs.contact_id=k.id AND cs.user_id=k.user_id AND (cs.paso > 1 OR cs.estado='terminado'))`);
    await pool.query(`UPDATE lm_contacts SET estado='respondio', updated_at=NOW()
      WHERE disposition IN ('respondio','reunion') AND estado IN ('nuevo','contactado')`);
    await pool.query(`UPDATE lm_contacts SET estado='perdido', updated_at=NOW()
      WHERE disposition IN ('no_interesado','no_contactar') AND estado IN ('nuevo','contactado','respondio')`);
    // lm_templates: biblioteca de plantillas/assets (Email & LinkedIn) con variables, reutilizables en secuencias.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_templates (
        id         SERIAL        PRIMARY KEY,
        user_id    INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        nombre     TEXT          NOT NULL DEFAULT '',
        canal      TEXT          NOT NULL DEFAULT 'linkedin',
        tipo       TEXT          NOT NULL DEFAULT 'plantilla',
        asunto     TEXT          NOT NULL DEFAULT '',
        cuerpo     TEXT          NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_templates_user_idx ON lm_templates (user_id);`);
    // Etiquetas libres (CSV) para organizar/filtrar la biblioteca sin restringir reutilización.
    await pool.query(`ALTER TABLE lm_templates ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '';`);
    // Secuencias vinculadas (CSV de ids) — solo para ubicar/filtrar rápido, NO restringe el uso.
    await pool.query(`ALTER TABLE lm_templates ADD COLUMN IF NOT EXISTS sequence_ids TEXT NOT NULL DEFAULT '';`);
    // Segmento / ICP de la empresa — parámetro típico para ángulos por segmento en las secuencias.
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS segmento TEXT NOT NULL DEFAULT '';`);
    // Pertenencias muchos-a-muchos: contacto ↔ secuencia / campaña (la membresía se agrega, el contacto NO se duplica).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_contact_sequences (
        id          SERIAL        PRIMARY KEY,
        user_id     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        contact_id  INTEGER       NOT NULL REFERENCES lm_contacts(id) ON DELETE CASCADE,
        sequence_id INTEGER       NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (contact_id, sequence_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cseq_user_idx    ON lm_contact_sequences (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cseq_contact_idx ON lm_contact_sequences (contact_id);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_contact_campaigns (
        id          SERIAL        PRIMARY KEY,
        user_id     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        contact_id  INTEGER       NOT NULL REFERENCES lm_contacts(id) ON DELETE CASCADE,
        campaign_id INTEGER       NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (contact_id, campaign_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_ccmp_user_idx    ON lm_contact_campaigns (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_ccmp_contact_idx ON lm_contact_campaigns (contact_id);`);
    // Actividades por contacto (reuniones, tareas, notas, llamadas…): reusa la tabla activities.
    await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES lm_contacts(id) ON DELETE CASCADE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS activities_contact_idx ON activities (contact_id);`);
    // Estado de enrolamiento del contacto en la secuencia (progreso).
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS paso   INTEGER NOT NULL DEFAULT 1;`);
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS estado TEXT    NOT NULL DEFAULT 'activo';`);

    // ── Time Tracking ────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS time_entries (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        task_titulo     TEXT NOT NULL DEFAULT '',
        project_nombre  TEXT NOT NULL DEFAULT '',
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at        TIMESTAMPTZ,
        duration_s      INTEGER NOT NULL DEFAULT 0,
        active_s        INTEGER NOT NULL DEFAULT 0,
        idle_s          INTEGER NOT NULL DEFAULT 0,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS time_entries_user_idx ON time_entries (user_id, started_at DESC);`);
    // ── Time Tracking — arquitectura multi-fuente (Fase 1 web · Fase 2 browser ext · Fase 3 desktop agent) ──
    // source:        manual_timer | nova_web | browser_extension | desktop_agent | calendar_block | imported
    // activity_type: active_work | idle | break | meeting | app_usage | website_usage | unknown
    // metadata (JSONB) guarda lo opcional/futuro: appName, websiteDomain, windowTitle, confidence,
    //   y asociaciones extra (opportunityId, clientId, subtaskId) hasta que existan columnas propias.
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS source        TEXT  NOT NULL DEFAULT 'manual_timer';`);
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS activity_type TEXT  NOT NULL DEFAULT 'active_work';`);
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS metadata      JSONB NOT NULL DEFAULT '{}';`);
    // Aprobación de nómina: el admin revisa/edita y aprueba las sesiones. Una sesión aprobada
    // queda bloqueada para el miembro (solo el admin la reabre). approved_by = users.id del admin.
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approved    BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approved_by INTEGER;`);
    // Tokens de extensión/agente (Fase 2.1): auth por Bearer, independiente de cookies de sesión.
    // Se guarda solo el hash sha256; el token en claro se muestra UNA vez al generarlo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ext_tokens (
        id           SERIAL      PRIMARY KEY,
        user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT        NOT NULL UNIQUE,
        label        TEXT        NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked      BOOLEAN     NOT NULL DEFAULT FALSE
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ext_tokens_hash_idx ON ext_tokens (token_hash);`);

    // ── Google Calendar integration ───────────────────────────────────
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token  TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expiry  TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gcal_event_id TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exchange_rates JSONB NOT NULL DEFAULT '{}';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS descripcion_updated_by TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS descripcion_updated_at TIMESTAMPTZ;`);
    // Vínculo con el cliente de Outreach (outbound_clients): el mismo cliente puede vivir
    // como proyecto en Operaciones y como cliente outbound en Outreach sin relación entre
    // ambos. Al vincularlos se activa el catálogo de tareas recurrentes propias de outbound
    // (ver POST /api/mgmt/projects/:id/outbound-link).
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS outbound_client_id INTEGER REFERENCES outbound_clients(id) ON DELETE SET NULL;`);

    // ── Finance: comisión variable por cobro (canal + monto fijo) ─────
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS canal          TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS comision_monto NUMERIC(12,2);`);
    // ── Finance: moneda original + tipo de cambio referencial + costo extra ─
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS moneda      TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS tipo_cambio NUMERIC(12,4);`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS costo_extra NUMERIC(12,2);`);
    // disponibilidad del cobro: 'disponible' (listo para distribuir) | 'liberacion' (cobrado en plataforma, aún reteniendo)
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS disponibilidad TEXT NOT NULL DEFAULT 'disponible';`);

    // ── Finance: configuración financiera (singleton por workspace) ───
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_config (
        user_id           INTEGER       PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        impuesto_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0,
        reserva_pct       NUMERIC(5,2)  NOT NULL DEFAULT 0,
        comision_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0,
        costos_operativos NUMERIC(12,2) NOT NULL DEFAULT 0,
        moneda_principal  TEXT          NOT NULL DEFAULT 'USD',
        periodo_default   TEXT          NOT NULL DEFAULT 'mes',
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);

    // ── Finance: config financiera por miembro (socio / sueldo) ───────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_member_config (
        id          SERIAL        PRIMARY KEY,
        user_id     INTEGER       NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
        member_id   INTEGER       NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
        es_socio    BOOLEAN       NOT NULL DEFAULT FALSE,
        socio_pct   NUMERIC(5,2)  NOT NULL DEFAULT 0,
        socio_regla TEXT          NOT NULL DEFAULT 'despues',
        tipo_pago   TEXT          NOT NULL DEFAULT 'manual',
        monto_pago  NUMERIC(12,2) NOT NULL DEFAULT 0,
        moneda_pago TEXT          NOT NULL DEFAULT 'USD',
        updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, member_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS fin_member_config_user_idx ON fin_member_config (user_id);`);

    // ── Finance: pagos internos (abonos a socios / equipo / colaboradores) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagos_internos (
        id           SERIAL        PRIMARY KEY,
        user_id      INTEGER       NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
        member_id    INTEGER       REFERENCES team_members(id)          ON DELETE SET NULL,
        persona      TEXT          NOT NULL DEFAULT '',
        tipo         TEXT          NOT NULL DEFAULT 'equipo',
        periodo_tipo TEXT          NOT NULL DEFAULT 'mes',
        periodo_ref  TEXT          NOT NULL DEFAULT '',
        monto        NUMERIC(12,2) NOT NULL DEFAULT 0,
        moneda       TEXT          NOT NULL DEFAULT 'USD',
        fecha_pago   DATE,
        metodo       TEXT          NOT NULL DEFAULT '',
        referencia   TEXT          NOT NULL DEFAULT '',
        nota         TEXT          NOT NULL DEFAULT '',
        estado       TEXT          NOT NULL DEFAULT 'pendiente',
        created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS pagos_internos_user_idx   ON pagos_internos (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS pagos_internos_member_idx ON pagos_internos (member_id);`);

    // ── Finance: gastos operativos + aportes a caja (Gastos / Caja) ──
    // tipo: 'gasto' | 'aporte'. Caja = Σ aportes − Σ gastos pagados desde caja (montos manuales, sin %).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_movimientos (
        id           SERIAL        PRIMARY KEY,
        user_id      INTEGER       NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        tipo         TEXT          NOT NULL DEFAULT 'gasto',
        concepto     TEXT          NOT NULL DEFAULT '',
        categoria    TEXT          NOT NULL DEFAULT '',
        proveedor    TEXT          NOT NULL DEFAULT '',
        monto        NUMERIC(12,2) NOT NULL DEFAULT 0,
        moneda       TEXT          NOT NULL DEFAULT 'USD',
        tipo_cambio  NUMERIC(12,4),
        fecha        DATE,
        estado       TEXT          NOT NULL DEFAULT 'pagado',
        pagado_desde TEXT          NOT NULL DEFAULT '',
        origen       TEXT          NOT NULL DEFAULT '',
        project_id   INTEGER       REFERENCES projects(id) ON DELETE SET NULL,
        client_id    INTEGER       REFERENCES clients(id)  ON DELETE SET NULL,
        responsable  TEXT          NOT NULL DEFAULT '',
        nota         TEXT          NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS fin_movimientos_user_idx ON fin_movimientos (user_id);`);

    // ── Oportunidades (procesos pre-proyecto: aplicaciones, invitaciones…) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id               SERIAL        PRIMARY KEY,
        user_id          INTEGER       NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        titulo           TEXT          NOT NULL DEFAULT '',
        cliente          TEXT          NOT NULL DEFAULT '',
        client_id        INTEGER       REFERENCES clients(id)  ON DELETE SET NULL,
        canal            TEXT          NOT NULL DEFAULT '',
        estado           TEXT          NOT NULL DEFAULT 'nueva',
        etapa_actual     TEXT          NOT NULL DEFAULT 'aplicacion',
        prioridad        TEXT          NOT NULL DEFAULT 'media',
        responsable      TEXT          NOT NULL DEFAULT '',
        proxima_accion   TEXT          NOT NULL DEFAULT '',
        descripcion      TEXT          NOT NULL DEFAULT '',
        notas            TEXT          NOT NULL DEFAULT '',
        valor_estimado   NUMERIC(12,2),
        moneda           TEXT          NOT NULL DEFAULT 'USD',
        project_id       INTEGER       REFERENCES projects(id) ON DELETE SET NULL,
        fecha_aplicacion DATE,
        etapas           JSONB         NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS opportunities_user_idx ON opportunities (user_id);`);
    await pool.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS propuesta TEXT  NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS links     JSONB NOT NULL DEFAULT '[]';`);

    // ── Tareas internas de oportunidad (pre-proyecto, NO tareas de proyecto) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS opportunity_tasks (
        id             SERIAL      PRIMARY KEY,
        user_id        INTEGER     NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
        opportunity_id INTEGER     NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        titulo         TEXT        NOT NULL DEFAULT '',
        etapa          TEXT        NOT NULL DEFAULT 'aplicacion',
        estado         TEXT        NOT NULL DEFAULT 'pendiente',
        prioridad      TEXT        NOT NULL DEFAULT 'media',
        responsable    TEXT        NOT NULL DEFAULT '',
        fecha_limite   DATE,
        notas          TEXT        NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS opportunity_tasks_opp_idx ON opportunity_tasks (opportunity_id);`);
    // tareas de oportunidad como tareas reales: presupuesto + tiempo (informativos, NO en Finanzas)
    await pool.query(`ALTER TABLE opportunity_tasks ADD COLUMN IF NOT EXISTS presupuesto     NUMERIC(12,2);`);
    await pool.query(`ALTER TABLE opportunity_tasks ADD COLUMN IF NOT EXISTS horas_estimadas NUMERIC(8,2);`);

    // ── task_dependencies: task_id ESPERA A / está bloqueada por depends_on_id (estilo ClickUp) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id            SERIAL      PRIMARY KEY,
        task_id       INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_id INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (task_id, depends_on_id),
        CHECK  (task_id <> depends_on_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS task_deps_task_idx ON task_dependencies (task_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS task_deps_dep_idx  ON task_dependencies (depends_on_id);`);

    // ── LM Fase A: motor de envío automático (sequences → emails reales) ──
    // Scopes concedidos en la conexión Google (calendar / gmail.send / gmail.readonly).
    // La conexión Gmail usa include_granted_scopes: un solo refresh token cubre todo.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_scopes TEXT NOT NULL DEFAULT '';`);
    // Verificación de email del contacto (resultado del pipeline /api/enrich interno).
    // email_status: '' (sin verificar) | valid | invalid | catch-all | risky | blocked | unknown
    //             | bounced (rebotó al enviar — marcado a mano) | manual (ingresado/confirmado a mano, enviable)
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_status      TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_score       INTEGER;`);
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;`);
    // Canal LinkedIn no válido para este contacto (perfil falso/inactivo): el motor de tareas
    // salta sus pasos de LinkedIn y sigue por la ruta de email — NO se saca de la secuencia.
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS no_linkedin BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Mismo patrón que no_linkedin, para WhatsApp/Llamada: número presente pero confirmado
    // incorrecto (no ausente — la ausencia de dato ya se detecta sola sin necesitar esta marca).
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS no_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS no_phone    BOOLEAN NOT NULL DEFAULT FALSE;`);
    // "Por corregir": falta/está mal un dato para contactar → pausa sus secuencias hasta arreglarlo.
    // '' (ok) | falta_email | falta_linkedin | dato_incorrecto
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS data_issue TEXT NOT NULL DEFAULT '';`);
    // Memoria de intentos SMTP por email (persiste entre reinicios): dentro de la ventana de
    // reintento, verificar de nuevo reutiliza el último resultado en vez de re-sondear el servidor.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_smtp_attempts (
        id        SERIAL      PRIMARY KEY,
        user_id   INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        email     TEXT        NOT NULL,
        status    TEXT        NOT NULL DEFAULT '',
        score     INTEGER,
        tried_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, email)
      );
    `);
    // Estado de avance automático del enrolamiento: cuándo toca el próximo paso y por qué se pausó.
    // estado (ya existe): activo | pausado | respondido | completado | bounce
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS paused_reason  TEXT NOT NULL DEFAULT '';`);
    // Día efectivo de arranque (día 1) de ESTE contacto en la secuencia. NULL → se usa created_at (compat).
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS start_date DATE;`);
    // Fecha en que el paso ACTUAL quedó activo (= día en que se completó el anterior). El siguiente paso
    // se agenda desde aquí (retraso corre la cadencia, como Outreach). NULL → ancla en start_date/created_at.
    await pool.query(`ALTER TABLE lm_contact_sequences ADD COLUMN IF NOT EXISTS paso_date DATE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cseq_next_idx ON lm_contact_sequences (estado, next_action_at);`);
    // Espera relativa entre pasos (días desde el paso anterior; complementa 'dia' absoluto).
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS espera_dias INTEGER NOT NULL DEFAULT 0;`);
    // Reply threading: si TRUE, el paso email se envía como respuesta al último
    // email enviado a ese contacto en la misma secuencia (In-Reply-To + References
    // del smtp_message_id anterior + prefijo "Re: " al asunto si falta). Permite
    // encadenar el segundo/tercer email en el mismo hilo, como hace Apollo/Instantly.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS reply_to_prev BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Pasos que dependen de una publicación (comentar / reaccionar): ventana de antigüedad
    // aceptable del post (0 = sin límite) y reacción sugerida. La ventana convierte
    // "sin actividad reciente" en un criterio objetivo en vez de un juicio del momento.
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS post_dias INTEGER NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS reaccion  TEXT    NOT NULL DEFAULT '';`);
    // lm_mailboxes: buzones reales por cliente outbound (SMTP+IMAP, cualquier proveedor).
    // pass_enc = contraseña de aplicación cifrada AES-256-GCM (nunca en claro).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_mailboxes (
        id                 SERIAL      PRIMARY KEY,
        user_id            INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        outbound_client_id INTEGER     REFERENCES outbound_clients(id) ON DELETE CASCADE,
        email              TEXT        NOT NULL,
        provider           TEXT        NOT NULL DEFAULT 'otro',
        smtp_host          TEXT        NOT NULL DEFAULT '',
        smtp_port          INTEGER     NOT NULL DEFAULT 465,
        smtp_secure        BOOLEAN     NOT NULL DEFAULT true,
        imap_host          TEXT        NOT NULL DEFAULT '',
        imap_port          INTEGER     NOT NULL DEFAULT 993,
        pass_enc           TEXT        NOT NULL DEFAULT '',
        estado             TEXT        NOT NULL DEFAULT 'nuevo',
        last_error         TEXT        NOT NULL DEFAULT '',
        verified_at        TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS lm_mailboxes_client_uq ON lm_mailboxes (user_id, outbound_client_id);`);
    // F2 (vigilante IMAP): cursor de lectura por buzón. uidvalidity cambia si el servidor
    // resetea la carpeta (hay que re-anclar el cursor); last_uid = último UID ya procesado.
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS imap_uidvalidity BIGINT NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS imap_last_uid    BIGINT NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS last_checked_at  TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS sent_folder      TEXT NOT NULL DEFAULT '';`);
    // OAuth (F4): para Microsoft 365 donde el tenant bloquea autenticación básica IMAP.
    // auth_method='basic' (default, usa pass_enc) o 'oauth' (usa oauth_* y hace XOAUTH2).
    // Los tokens se cifran con el mismo AES-256-GCM que pass_enc (encPass/decPass).
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS auth_method      TEXT NOT NULL DEFAULT 'basic';`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_provider   TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_access_enc TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_refresh_enc TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_scopes     TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS oauth_tenant_id  TEXT NOT NULL DEFAULT '';`);
    // Firma HTML por buzón (independiente por cliente). Acepta el HTML tal cual
    // (con <img base64>, <a>, estilos inline, etc.). Si está vacío, el motor cae
    // a lm_send_settings.firma del user (comportamiento previo). Se edita desde
    // la tarjeta del buzón en el detalle del cliente outbound.
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS signature_html TEXT NOT NULL DEFAULT '';`);
    // Solicitud de admin consent: si el tenant del cliente exige aprobación del admin
    // (AADSTS65001 en el OAuth), el buzón queda marcado y la UI ofrece enviarle un
    // correo al admin con el link de admin-consent listo. El timestamp evita spam.
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS needs_admin_consent BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS admin_consent_requested_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS admin_consent_sent_to TEXT NOT NULL DEFAULT '';`);
    // Nombre del remitente POR BUZÓN: antes todo envío usaba lm_send_settings.from_name
    // (global por usuario), así que un cliente veía el nombre de OTRO (bug real: MWHAds
    // mostrando "Alberto Santos", el nombre configurado para Greglo). Vacío = usa el
    // global como fallback (sin romper buzones que aún no lo configuraron).
    await pool.query(`ALTER TABLE lm_mailboxes ADD COLUMN IF NOT EXISTS from_name TEXT NOT NULL DEFAULT '';`);

    // lm_inbox_messages: correos ENTRANTES detectados por el vigilante IMAP (F2).
    // Solo se guardan los relevantes: remitente que es contacto del CRM, o rebotes.
    // tipo: reply (respuesta real) | ooo (out-of-office) | bounce (rebote) | otro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_inbox_messages (
        id                 SERIAL      PRIMARY KEY,
        user_id            INTEGER     REFERENCES users(id)            ON DELETE CASCADE,
        mailbox_id         INTEGER     REFERENCES lm_mailboxes(id)     ON DELETE CASCADE,
        outbound_client_id INTEGER     REFERENCES outbound_clients(id) ON DELETE SET NULL,
        contact_id         INTEGER     REFERENCES lm_contacts(id)      ON DELETE SET NULL,
        imap_uid           BIGINT      NOT NULL DEFAULT 0,
        message_id         TEXT        NOT NULL DEFAULT '',
        in_reply_to        TEXT        NOT NULL DEFAULT '',
        from_email         TEXT        NOT NULL DEFAULT '',
        from_name          TEXT        NOT NULL DEFAULT '',
        asunto             TEXT        NOT NULL DEFAULT '',
        cuerpo             TEXT        NOT NULL DEFAULT '',
        tipo               TEXT        NOT NULL DEFAULT 'reply',
        leido              BOOLEAN     NOT NULL DEFAULT FALSE,
        received_at        TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox_id, imap_uid)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_inbox_user_idx    ON lm_inbox_messages (user_id, received_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_inbox_contact_idx ON lm_inbox_messages (contact_id);`);

    // lm_notes: notas internas sobre un contacto (Inbox → modo "Nota interna").
    // A diferencia de lm_inbox_messages/lm_messages, NUNCA se manda como email —
    // solo queda visible para el equipo dentro del mismo hilo de conversación.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_notes (
        id          SERIAL      PRIMARY KEY,
        user_id     INTEGER     REFERENCES users(id)        ON DELETE CASCADE,
        contact_id  INTEGER     REFERENCES lm_contacts(id)  ON DELETE CASCADE,
        member_id   INTEGER     REFERENCES team_members(id) ON DELETE SET NULL,
        autor       TEXT        NOT NULL DEFAULT '',
        texto       TEXT        NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_notes_contact_idx ON lm_notes (contact_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_notes_user_idx    ON lm_notes (user_id, created_at DESC);`);

    // lm_forwards: reenvíos reales por email a alguien que NO es el prospecto (un
    // compañero, alguien nuevo) — "Reenviar" del Inbox. Va en tabla propia, separada
    // de lm_messages, para que NO cuente como "ya le respondí al prospecto" en las
    // métricas/estado del hilo (last_out_at, sent_count, etc.) — es una conversación
    // interna que sale por el mismo buzón, no una respuesta al prospecto.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_forwards (
        id               SERIAL      PRIMARY KEY,
        user_id          INTEGER     REFERENCES users(id)       ON DELETE CASCADE,
        contact_id       INTEGER     REFERENCES lm_contacts(id) ON DELETE CASCADE,
        mailbox_id       INTEGER     REFERENCES lm_mailboxes(id) ON DELETE SET NULL,
        to_email         TEXT        NOT NULL DEFAULT '',
        asunto           TEXT        NOT NULL DEFAULT '',
        cuerpo           TEXT        NOT NULL DEFAULT '',
        smtp_message_id  TEXT        NOT NULL DEFAULT '',
        sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_forwards_contact_idx ON lm_forwards (contact_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_forwards_user_idx    ON lm_forwards (user_id, sent_at DESC);`);

    // lm_messages: cada email real enviado por el motor (asunto/cuerpo ya renderizados).
    // estado: queued | sent | bounced | replied | failed
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_messages (
        id              SERIAL      PRIMARY KEY,
        user_id         INTEGER     REFERENCES users(id)        ON DELETE SET NULL,
        contact_id      INTEGER     NOT NULL REFERENCES lm_contacts(id) ON DELETE CASCADE,
        sequence_id     INTEGER     REFERENCES sequences(id)      ON DELETE SET NULL,
        step_id         INTEGER     REFERENCES sequence_steps(id) ON DELETE SET NULL,
        asunto          TEXT        NOT NULL DEFAULT '',
        cuerpo          TEXT        NOT NULL DEFAULT '',
        to_email        TEXT        NOT NULL DEFAULT '',
        estado          TEXT        NOT NULL DEFAULT 'queued',
        track_token     TEXT        UNIQUE,
        gmail_message_id TEXT       NOT NULL DEFAULT '',
        gmail_thread_id  TEXT       NOT NULL DEFAULT '',
        error           TEXT        NOT NULL DEFAULT '',
        sent_at         TIMESTAMPTZ,
        replied_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_messages_user_idx    ON lm_messages (user_id, sent_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_messages_contact_idx ON lm_messages (contact_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_messages_thread_idx  ON lm_messages (gmail_thread_id);`);
    // lm_message_events: open | click | bounce | reply (tracking granular por mensaje).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_message_events (
        id         SERIAL      PRIMARY KEY,
        message_id INTEGER     NOT NULL REFERENCES lm_messages(id) ON DELETE CASCADE,
        tipo       TEXT        NOT NULL,
        url        TEXT        NOT NULL DEFAULT '',
        ip         TEXT        NOT NULL DEFAULT '',
        user_agent TEXT        NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_msg_events_msg_idx ON lm_message_events (message_id, tipo);`);
    // lm_send_settings: configuración de envío por workspace (singleton, patrón fin_config).
    // Ventana horaria en hora LOCAL del timezone indicado; límites conservadores por defecto.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_send_settings (
        user_id          INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
        from_name        TEXT        NOT NULL DEFAULT '',
        daily_limit      INTEGER     NOT NULL DEFAULT 30,
        throttle_seconds INTEGER     NOT NULL DEFAULT 90,
        window_start     INTEGER     NOT NULL DEFAULT 9,
        window_end       INTEGER     NOT NULL DEFAULT 18,
        send_weekends    BOOLEAN     NOT NULL DEFAULT FALSE,
        timezone         TEXT        NOT NULL DEFAULT 'America/Lima',
        firma            TEXT        NOT NULL DEFAULT '',
        track_opens      BOOLEAN     NOT NULL DEFAULT TRUE,
        track_clicks     BOOLEAN     NOT NULL DEFAULT TRUE,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Recordatorio por inactividad (pedido 2026-09-02: "necesito que el sistema me
    // recuerde por defecto, no que yo tenga que configurarlo"). Prendido de fábrica en
    // 24h — 0 lo apaga para quien no lo quiera. Ver services/followupWatcher.js.
    await pool.query(`ALTER TABLE lm_send_settings ADD COLUMN IF NOT EXISTS followup_hours INTEGER NOT NULL DEFAULT 24;`);
    // lm_daily_reports: snapshot del reporte diario (1 por día por workspace).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_daily_reports (
        id         SERIAL      PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fecha      DATE        NOT NULL,
        data       JSONB       NOT NULL DEFAULT '{}',
        emailed    BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, fecha)
      );
    `);

    // F2: envíos por buzón del cliente (SMTP). mailbox_id = por qué buzón salió;
    // smtp_message_id = header Message-ID (threading real en respuestas).
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS mailbox_id      INTEGER REFERENCES lm_mailboxes(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS smtp_message_id TEXT NOT NULL DEFAULT '';`);
    // Envío programado (estado='scheduled'): el motor lo despacha cuando scheduled_at vence.
    // in_reply_to se congela al programar para conservar el threading aunque lleguen más correos.
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS in_reply_to  TEXT NOT NULL DEFAULT '';`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_messages_sched_idx ON lm_messages (estado, scheduled_at) WHERE estado='scheduled';`);

    // ── LM · A/B (Fase B3): variante usada en cada envío/touch, para medir cuál convierte ──
    await pool.query(`ALTER TABLE lm_messages ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE activities  ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '';`);
    // Backfill: las tareas manuales ya guardaban "· Variante X" al final de la nota.
    await pool.query(`
      UPDATE activities SET variant = trim(substring(nota from '· Variante (.*)$'))
       WHERE variant = '' AND nota LIKE '%· Variante %';
    `);

    // ── LM · Personalización con IA (Fable 5 alto valor · Haiku volumen) ──
    // Config por workspace (singleton, patrón fin_config). Presupuesto mensual en USD.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_ai_settings (
        user_id            INTEGER      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
        monthly_budget_usd NUMERIC(10,2) NOT NULL DEFAULT 20,
        model_high         TEXT         NOT NULL DEFAULT 'claude-fable-5',
        model_volume       TEXT         NOT NULL DEFAULT 'claude-haiku-4-5',
        idioma             TEXT         NOT NULL DEFAULT 'auto',
        updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    // Borradores generados por IA: 1 por contacto+paso (o suelto). status: draft|approved|discarded.
    // tier: alto (Fable) | volumen (Haiku). Guarda tokens y costo estimado para el presupuesto.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_ai_drafts (
        id             SERIAL       PRIMARY KEY,
        user_id        INTEGER      REFERENCES users(id)          ON DELETE SET NULL,
        contact_id     INTEGER      NOT NULL REFERENCES lm_contacts(id) ON DELETE CASCADE,
        step_id        INTEGER      REFERENCES sequence_steps(id) ON DELETE SET NULL,
        sequence_id    INTEGER      REFERENCES sequences(id)      ON DELETE SET NULL,
        tier           TEXT         NOT NULL DEFAULT 'volumen',
        model          TEXT         NOT NULL DEFAULT '',
        asunto         TEXT         NOT NULL DEFAULT '',
        cuerpo         TEXT         NOT NULL DEFAULT '',
        research_notes TEXT         NOT NULL DEFAULT '',
        input_tokens   INTEGER      NOT NULL DEFAULT 0,
        output_tokens  INTEGER      NOT NULL DEFAULT 0,
        cost_usd       NUMERIC(10,5) NOT NULL DEFAULT 0,
        status         TEXT         NOT NULL DEFAULT 'draft',
        error          TEXT         NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_ai_drafts_user_idx    ON lm_ai_drafts (user_id, created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_ai_drafts_contact_idx ON lm_ai_drafts (contact_id, step_id);`);

    // ── Recurrencia multi-cadencia (escala "Trabajo semanal" a semanal/mensual/
    // trimestral) — semana_auto sigue siendo el on/off; recur_freq elige la
    // cadencia. Default 'weekly' deja el comportamiento actual intacto para
    // todos los proyectos que ya tenían semana_auto=true.
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS recur_freq TEXT NOT NULL DEFAULT 'weekly';`);
    // Plantillas de SUBTAREAS recurrentes por proyecto — antes solo existía
    // "copiar subtareas de la semana anterior" (manual); esto las genera solas,
    // con su propia cadencia (puede ser distinta a la del contenedor).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_recur_subtasks (
        id           SERIAL      PRIMARY KEY,
        user_id      INTEGER     NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        project_id   INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        titulo       TEXT        NOT NULL,
        descripcion  TEXT        NOT NULL DEFAULT '',
        prioridad    TEXT        NOT NULL DEFAULT 'media',
        responsable  TEXT        NOT NULL DEFAULT '',
        responsables TEXT[]      NOT NULL DEFAULT '{}',
        freq         TEXT        NOT NULL DEFAULT 'weekly',
        activo       BOOLEAN     NOT NULL DEFAULT TRUE,
        orden        INTEGER     NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS project_recur_subtasks_proj_idx ON project_recur_subtasks (project_id);`);
    // 'outbound_catalog' marca las que se crearon solas al vincular el cliente outbound —
    // así no se duplican si se vuelve a vincular, y la UI puede distinguirlas de las manuales.
    await pool.query(`ALTER TABLE project_recur_subtasks ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT '';`);
    // Traza + idempotencia de las subtareas que generó una plantilla: una fila
    // por (plantilla, período) — sin esto se duplicaría cada vez que corre el cron.
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_template_id INTEGER REFERENCES project_recur_subtasks(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_anchor DATE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS tasks_recur_idx ON tasks (recur_template_id, recur_anchor);`);

    // ── Cola de empresas (outreach "empresa primero", estilo LinkedIn Sales Navigator) ──
    // Puente entre "tengo la empresa calificada" y "tengo a la persona": mucho más simple
    // que lm_contact_sequences (sin paso/paso_date) porque SIEMPRE representa "Paso 1:
    // falta encontrar al decisor en LinkedIn y mandarle la invitación". Al agregar el
    // contacto encontrado, la fila pasa a 'trabajada' y el contacto sigue el pipeline
    // normal desde el Paso 2 (ver POST /api/lm/company-sequences/:id/convert).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_company_sequences (
        id          SERIAL      PRIMARY KEY,
        user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        company_id  INTEGER     NOT NULL REFERENCES lm_companies(id) ON DELETE CASCADE,
        sequence_id INTEGER     NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        estado      TEXT        NOT NULL DEFAULT 'pendiente',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, sequence_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cocseq_user_idx ON lm_company_sequences (user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cocseq_seq_idx  ON lm_company_sequences (sequence_id, estado);`);

    // URL de LinkedIn Sales Navigator de la empresa — distinta del LinkedIn público (linkedin),
    // que es la que ella usa de verdad para prospectar. El botón "LinkedIn ↗" de Cola de
    // empresas prioriza esta si existe.
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS linkedin_sales_nav TEXT NOT NULL DEFAULT '';`);

    // ── Campos personalizados (Field 1..10, renombrables desde Configuración) ──
    // Slots genéricos en companies/contacts + tabla de labels por usuario. Un campo solo
    // aparece en filtros/import/modal/export si tiene label no vacío (ver lm_custom_field_labels).
    for (let i = 1; i <= 10; i++) {
      await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS campo${i} TEXT NOT NULL DEFAULT '';`);
      await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS campo${i} TEXT NOT NULL DEFAULT '';`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lm_custom_field_labels (
        id         SERIAL      PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity     TEXT        NOT NULL,
        field_key  TEXT        NOT NULL,
        label      TEXT        NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, entity, field_key)
      );
    `);

    // Análisis / por qué calificó — texto libre (ICP research), independiente en empresa y
    // contacto: la empresa puede calificar por un motivo y el contacto en particular por otro.
    await pool.query(`ALTER TABLE lm_companies ADD COLUMN IF NOT EXISTS analisis TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts  ADD COLUMN IF NOT EXISTS analisis TEXT NOT NULL DEFAULT '';`);

    // Reparto por día de la Cola de empresas (mismo "arranque escalonado · X por día" que ya
    // usan los contactos) — sin esto, TODAS las empresas enroladas de una vez caían como
    // tareas "para hoy" sin respetar el límite diario configurado en la secuencia.
    await pool.query(`ALTER TABLE lm_company_sequences ADD COLUMN IF NOT EXISTS due_date DATE;`);
    await pool.query(`UPDATE lm_company_sequences SET due_date = created_at::date WHERE due_date IS NULL;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lm_cocseq_due_idx ON lm_company_sequences (sequence_id, due_date);`);

    // ── WhatsApp de trabajo (Baileys) — Operaciones ─────────────────────────
    // v1: el WhatsApp propio de Jenny, conectado por QR (no Business API oficial —
    // ver decisión en memoria). user_id permite en el futuro más de una conexión
    // (ej. un WhatsApp por cliente outbound), aunque hoy la UI solo usa una.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_connections (
        id           SERIAL      PRIMARY KEY,
        user_id      INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        nombre       TEXT        NOT NULL DEFAULT 'WhatsApp de trabajo',
        numero       TEXT        NOT NULL DEFAULT '',
        estado       TEXT        NOT NULL DEFAULT 'desconectado'
                       CHECK (estado IN ('desconectado','esperando_qr','conectado')),
        session_dir  TEXT        NOT NULL,
        qr_actual    TEXT        NOT NULL DEFAULT '',
        connected_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_connections_user_idx ON wa_connections (user_id);`);
    // msg_id es el Baileys key.id — la clave real de deduplicación: el mismo mensaje
    // puede llegar dos veces (reconexión, eco del propio envío) y sin este UNIQUE se
    // duplicaría en el historial cada vez.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id            SERIAL      PRIMARY KEY,
        connection_id INTEGER     NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        chat_jid      TEXT        NOT NULL,
        msg_id        TEXT        NOT NULL,
        from_me       BOOLEAN     NOT NULL DEFAULT FALSE,
        nombre        TEXT        NOT NULL DEFAULT '',
        texto         TEXT        NOT NULL DEFAULT '',
        ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (connection_id, msg_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_messages_chat_idx ON wa_messages (connection_id, chat_jid, ts);`);
    // "Responder a este mensaje": reply_to_id es el msg_id citado (si lo tenemos guardado
    // se puede abrir); reply_to_texto es una copia del texto citado para poder mostrar la
    // vista previa aunque el original sea de antes de conectar Nova y no esté en la tabla.
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reply_to_id     TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reply_to_texto  TEXT NOT NULL DEFAULT '';`);
    // Envío programado: msg_id de una fila 'programado' es un placeholder local (no
    // existe todavía en WhatsApp) hasta que waService la envía de verdad y reemplaza
    // el msg_id por el real que devuelve Baileys.
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS estado        TEXT NOT NULL DEFAULT 'enviado';`);
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS scheduled_at  TIMESTAMPTZ;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_messages_sched_idx ON wa_messages (estado, scheduled_at) WHERE estado='programado';`);
    // Directorio de nombres (contactos guardados en el teléfono + gente que ya
    // escribió) — separado de wa_messages para poder listar "con quién puedo
    // escribir" (el "Nuevo chat") sin depender de que ya exista una conversación.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_contacts (
        id            SERIAL      PRIMARY KEY,
        connection_id INTEGER     NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        jid           TEXT        NOT NULL,
        nombre        TEXT        NOT NULL DEFAULT '',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (connection_id, jid)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_contacts_conn_idx ON wa_contacts (connection_id);`);
    // Reacciones (👍❤️😂...) — un cupo para "la mía" y uno para "la del otro" por
    // mensaje, que es como WhatsApp las maneja en 1:1 (una persona, una reacción
    // vigente; mandar otra reemplaza la anterior, vacío la quita).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_reactions (
        id            SERIAL      PRIMARY KEY,
        connection_id INTEGER     NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        chat_jid      TEXT        NOT NULL,
        msg_id        TEXT        NOT NULL,
        from_me       BOOLEAN     NOT NULL DEFAULT FALSE,
        emoji         TEXT        NOT NULL DEFAULT '',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (connection_id, msg_id, from_me)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_reactions_msg_idx ON wa_reactions (connection_id, msg_id);`);
    // No leídos: DEFAULT TRUE deja "leído" todo lo que ya existe (el historial recién
    // sincronizado no debe aparecer como si fuera nuevo) — solo los mensajes que
    // lleguen EN VIVO de ahora en más se insertan con leido=FALSE (ver waService).
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS leido BOOLEAN NOT NULL DEFAULT TRUE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_messages_noleido_idx ON wa_messages (connection_id, chat_jid) WHERE NOT leido;`);
    // "Eliminar para todos": no se borra la fila (rompería reply_to_id de quien lo citó
    // y perdería el rastro) — se marca, y la burbuja se pinta como WhatsApp la muestra
    // ("Se eliminó este mensaje"), ver waService._guardarMensaje.
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS eliminado BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Fotos: media_url apunta a /wa-media/... (servido desde disco, ver server.js —
    // WhatsApp no da una URL pública propia); texto hace de caption. media_type hoy
    // solo vale 'image' (video/documento quedan fuera por ahora).
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_url  TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT '';`);
    // Mensaje importante (⭐, como el "destacado" de WhatsApp) — toggle simple, sin lista
    // aparte todavía: se ve como una estrellita junto a la hora del mensaje.
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS importante BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Tarjetas de contacto compartidas por WhatsApp: se guarda el número (si el vCard
    // lo trae) para poder abrir un chat directo a ESA persona con un clic, en vez de
    // solo mostrar el nombre como texto plano. Ver waService.js _guardarMensaje.
    await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';`);

    // Quién puede ver cada conexión (antes cualquiera con acceso a Operaciones la
    // veía) + una conexión propia por cliente outbound en vez de una sola compartida.
    // Mismo patrón que ya usa slack_workspaces.visibilidad/connected_by.
    await pool.query(`ALTER TABLE wa_connections ADD COLUMN IF NOT EXISTS outbound_client_id   INTEGER REFERENCES outbound_clients(id) ON DELETE CASCADE;`);
    await pool.query(`ALTER TABLE wa_connections ADD COLUMN IF NOT EXISTS connected_by         INTEGER;`);
    await pool.query(`ALTER TABLE wa_connections ADD COLUMN IF NOT EXISTS visibilidad          TEXT NOT NULL DEFAULT 'solo_yo';`);
    await pool.query(`ALTER TABLE wa_connections ADD COLUMN IF NOT EXISTS visibilidad_niveles  TEXT[] NOT NULL DEFAULT '{}';`);
    await pool.query(`ALTER TABLE wa_connections ADD COLUMN IF NOT EXISTS visibilidad_miembros INTEGER[] NOT NULL DEFAULT '{}';`);
    // La conexión de Operaciones que ya existía no tenía dueño ni control — pasa a
    // privada (solo quien la conectó) desde ahora, decisión explícita de Jenny.
    await pool.query(`UPDATE wa_connections SET connected_by = user_id, visibilidad = 'solo_yo' WHERE connected_by IS NULL;`);
    // Un WhatsApp por cliente outbound como máximo (NULL = Operaciones, sin límite).
    // Reemplazado abajo por wa_connection_clients (many-to-many) — pedido 2026-09-02:
    // Jenny quiere asignar el MISMO WhatsApp a varios clientes outbound a la vez (p.
    // ej. el de Operaciones sirviendo también de contacto directo para 2-3 clientes).
    await pool.query(`DROP INDEX IF EXISTS wa_connections_client_uq;`);

    // wa_connection_clients: a qué clientes outbound está asignada cada conexión.
    // outbound_client_id en wa_connections queda como dato histórico de cómo se creó
    // (no se usa más para resolver a quién pertenece) — la fuente de verdad pasa a ser
    // esta tabla, que sí permite una conexión en varios clientes. Sin fila acá = solo
    // vive en Operaciones (comportamiento de siempre para lo que nunca se asignó).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_connection_clients (
        connection_id      INTEGER NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        outbound_client_id INTEGER NOT NULL REFERENCES outbound_clients(id) ON DELETE CASCADE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (connection_id, outbound_client_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_connection_clients_client_idx ON wa_connection_clients (outbound_client_id);`);
    // Migra lo que ya estaba asignado 1-a-1 antes de este cambio.
    await pool.query(`
      INSERT INTO wa_connection_clients (connection_id, outbound_client_id)
      SELECT id, outbound_client_id FROM wa_connections WHERE outbound_client_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);

    // Vínculo manual contacto↔chat — necesario porque WhatsApp a veces no manda el
    // número real del contacto, solo un "@lid" (identificador interno, privacidad de
    // negocio) que Baileys no siempre logra traducir a un número. En esos casos abrir
    // el WhatsApp de un contacto desde Leads/Ficha (que arma el jid a partir de su
    // teléfono) no encuentra la conversación real, aunque ya exista con mensajes e
    // incluso uno programado — caso real detectado 2026-09-02 con Johanna Albarracin
    // (chat guardado como "238989361594370@lid", su ficha nunca tuvo ese jid). Este
    // vínculo permite decir a mano "esta conversación específica es de este contacto".
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_jid_links (
        connection_id INTEGER NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        contact_id    INTEGER NOT NULL REFERENCES lm_contacts(id) ON DELETE CASCADE,
        chat_jid      TEXT    NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (connection_id, contact_id)
      );
    `);

    // Etiquetas de chat (estilo Chatwoot) — a nivel de WORKSPACE (user_id), no por
    // conexión: la misma etiqueta ("Cliente", "Urgente"...) sirve sin importar en cuál
    // de tus WhatsApp esté el chat. wa_chat_tags es la asignación puntual chat↔etiqueta.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_tags (
        id         SERIAL      PRIMARY KEY,
        user_id    INTEGER     NOT NULL,
        nombre     TEXT        NOT NULL,
        color      TEXT        NOT NULL DEFAULT '#6366F1',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, nombre)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_chat_tags (
        connection_id INTEGER NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        chat_jid      TEXT    NOT NULL,
        tag_id        INTEGER NOT NULL REFERENCES wa_tags(id) ON DELETE CASCADE,
        PRIMARY KEY (connection_id, chat_jid, tag_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_chat_tags_chat_idx ON wa_chat_tags (connection_id, chat_jid);`);
    // Metadatos por chat que no viven en wa_messages (no hay una fila "chat" propia —
    // el chat se deriva de sus mensajes): fijado y recordatorio de seguimiento.
    // snooze_until en el futuro = "pospuesto", pasa a la sección normal solo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_chat_meta (
        connection_id INTEGER     NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        chat_jid      TEXT        NOT NULL,
        pinned        BOOLEAN     NOT NULL DEFAULT FALSE,
        snooze_until  TIMESTAMPTZ,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (connection_id, chat_jid)
      );
    `);
    // Asignado (nombre del miembro, mismo criterio que tasks.responsable — texto, no FK)
    // y estado de la conversación (abierto/pendiente/resuelto, estilo Chatwoot).
    await pool.query(`ALTER TABLE wa_chat_meta ADD COLUMN IF NOT EXISTS asignado_a TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE wa_chat_meta ADD COLUMN IF NOT EXISTS estado_conv TEXT NOT NULL DEFAULT 'abierto';`);
    // Prioridad del chat ('' | baja | media | alta) — pedido explícito 2026-09-02,
    // mismo patrón que estado_conv. Visible con color en la lista de chats (Operaciones
    // y la pestaña WhatsApp de Outreach) y editable desde el menú "⋮" en ambos lugares.
    await pool.query(`ALTER TABLE wa_chat_meta ADD COLUMN IF NOT EXISTS prioridad TEXT NOT NULL DEFAULT '';`);
    // Notas internas por chat — nunca se envían al contacto, solo las ve el equipo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_chat_notes (
        id            SERIAL      PRIMARY KEY,
        connection_id INTEGER     NOT NULL REFERENCES wa_connections(id) ON DELETE CASCADE,
        chat_jid      TEXT        NOT NULL,
        autor         TEXT        NOT NULL DEFAULT '',
        texto         TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_chat_notes_chat_idx ON wa_chat_notes (connection_id, chat_jid, created_at);`);

    console.log('[db] tables ready (users, verifications, batch_jobs, clients, projects, tasks, payments, team_members, workspaces, workspace_invites, chat_messages, leads, meetings, fin_config, fin_member_config, pagos_internos, opportunities, opportunity_tasks)');
  } catch (err) {
    console.error('[db] initDb failed:', err.message);
    throw err;
  }
}

// ── User helpers ───────────────────────────────────────────────────

async function findOrCreateUser({ googleId, email, name, avatar }) {
  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, name, avatar)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE
       SET email  = EXCLUDED.email,
           name   = EXCLUDED.name,
           avatar = EXCLUDED.avatar
     RETURNING id, google_id, email, name, avatar, created_at`,
    [googleId, email, name || '', avatar || '']
  );
  return rows[0];
}

async function findUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, google_id, email, name, avatar, workspace_id, created_at
       FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function closeDb() {
  try { await pool.end(); console.log('[db] pool closed'); }
  catch (err) { console.error('[db] pool close error:', err.message); }
}

process.on('SIGINT',  () => closeDb().finally(() => process.exit(0)));
process.on('SIGTERM', () => closeDb().finally(() => process.exit(0)));

module.exports = { pool, initDb, closeDb, findOrCreateUser, findUserById };
