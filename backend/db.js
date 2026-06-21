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

    // ── Google Calendar integration ───────────────────────────────────
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token  TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expiry  TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gcal_event_id TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exchange_rates JSONB NOT NULL DEFAULT '{}';`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]';`);

    console.log('[db] tables ready (users, verifications, batch_jobs, clients, projects, tasks, payments, team_members, workspaces, workspace_invites, chat_messages, leads, meetings)');
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
