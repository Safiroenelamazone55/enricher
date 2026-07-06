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
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_status      TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_score       INTEGER;`);
    await pool.query(`ALTER TABLE lm_contacts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;`);
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
