import pg from "pg";
import { log } from "./log.js";

// Each migration is a function that receives a client (within a transaction)
// and applies schema changes. Migration 0 is the baseline: it creates all
// tables in their final form and applies any ALTER TABLE statements needed
// to bring existing databases up to date. Migrations 1+ are non-idempotent
// and run exactly once.
type Migration = (client: pg.PoolClient) => Promise<void>;

const migrations: Migration[] = [
  // Migration 0: baseline schema. All CREATE TABLE statements use IF NOT EXISTS
  // and all ALTER TABLE statements use IF NOT EXISTS / IF EXISTS so this is safe
  // to run against both fresh and existing databases.
  //
  // Table creation order follows FK dependencies:
  //   agents → interlocutors → interlocutor_identities → messages → compactions
  async (client) => {
    // Silences the collation version mismatch warning that appears when switching
    // between Postgres images (e.g. stock postgres:17 to pgvector/pgvector:pg17).
    await client.query(`DO $$ BEGIN EXECUTE 'ALTER DATABASE ' || quote_ident(current_database()) || ' REFRESH COLLATION VERSION'; END $$`);

    // agents must be created first because messages, compactions, and interlocutors
    // all reference it via foreign keys.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        allowed_tools TEXT[] NOT NULL DEFAULT '{}',
        allowed_plugins TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing databases created before allowed_plugins was added need this column.
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_plugins TEXT[] NOT NULL DEFAULT '{}'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS interlocutors (
        id SERIAL PRIMARY KEY,
        display_name TEXT NOT NULL UNIQUE,
        owner BOOLEAN NOT NULL DEFAULT FALSE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        agent_id INTEGER REFERENCES agents(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing databases may have the old instructions column or be missing agent_id.
    await client.query(`ALTER TABLE interlocutors DROP COLUMN IF EXISTS instructions`);
    await client.query(`ALTER TABLE interlocutors ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON interlocutors (owner) WHERE owner = true
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS interlocutor_identities (
        id SERIAL PRIMARY KEY,
        interlocutor_id INTEGER NOT NULL REFERENCES interlocutors(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        identifier TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing databases may have identifier as NOT NULL; make it nullable to support
    // soft-deletion.
    await client.query(`ALTER TABLE interlocutor_identities ALTER COLUMN identifier DROP NOT NULL`);
    // Drop the old regular UNIQUE constraint before creating the partial index, which
    // only covers non-null identifiers to allow multiple soft-deleted rows per service.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'interlocutor_identities_service_identifier_key'
            AND conrelid = 'interlocutor_identities'::regclass
        ) THEN
          ALTER TABLE interlocutor_identities DROP CONSTRAINT interlocutor_identities_service_identifier_key;
        END IF;
      END
      $$
    `);
    // Soft-deleted rows (identifier IS NULL) must not conflict with each other, so we
    // use a partial unique index that only covers non-null identifiers.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS interlocutor_identities_service_identifier
        ON interlocutor_identities (service, identifier)
        WHERE identifier IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        agent_id INTEGER REFERENCES agents(id),
        sender_identity_id INTEGER REFERENCES interlocutor_identities(id),
        sender_agent_id INTEGER REFERENCES agents(id)
      )
    `);
    // Existing databases need these columns added if they predate them.
    await client.query(`ALTER TABLE messages DROP COLUMN IF EXISTS interlocutor_id`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER REFERENCES interlocutor_identities(id)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_agent_id INTEGER REFERENCES agents(id)`);
    // Enforce the at-most-one-sender invariant.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'messages_at_most_one_sender'
        ) THEN
          ALTER TABLE messages ADD CONSTRAINT messages_at_most_one_sender
            CHECK (
              NOT (sender_identity_id IS NOT NULL AND sender_agent_id IS NOT NULL)
            );
        END IF;
      END
      $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing databases created before these columns were added need them backfilled.
    await client.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await client.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compactions (
        id SERIAL PRIMARY KEY,
        summary TEXT NOT NULL,
        up_to_message_id INTEGER NOT NULL REFERENCES messages(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        agent_id INTEGER REFERENCES agents(id)
      )
    `);
    // Existing databases need these columns added if they predate them.
    await client.query(`ALTER TABLE compactions DROP COLUMN IF EXISTS interlocutor_id`);
    await client.query(`ALTER TABLE compactions ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_entries (
        id SERIAL PRIMARY KEY,
        cron_expression TEXT,
        fire_at TIMESTAMPTZ,
        note TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (cron_expression IS NOT NULL AND fire_at IS NULL) OR
          (cron_expression IS NULL AND fire_at IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        mimetype TEXT NOT NULL,
        data BYTEA NOT NULL,
        is_public BOOLEAN NOT NULL DEFAULT FALSE,
        queries JSONB,
        mutations JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing databases may be missing these columns or have the old schema.
    await client.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS queries JSONB`);
    await client.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS mutations JSONB`);
    await client.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
    await client.query(`ALTER TABLE pages DROP COLUMN IF EXISTS updated_at`);
    // Drop the old unique constraint on path alone and replace it with a composite
    // unique constraint on (path, version) to support multiple version rows per path.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'pages_path_key'
            AND conrelid = 'pages'::regclass
        ) THEN
          ALTER TABLE pages DROP CONSTRAINT pages_path_key;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'pages_path_version_key'
            AND conrelid = 'pages'::regclass
        ) THEN
          ALTER TABLE pages ADD CONSTRAINT pages_path_version_key UNIQUE (path, version);
        END IF;
      END
      $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS scratchpad (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id),
        embedding vector(1536) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create the schema_version table and set version to 0 if it doesn't exist.
    // The CHECK (id = 1) constraint enforces that only one row can ever exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        version INTEGER NOT NULL
      )
    `);
    await client.query(`
      INSERT INTO schema_version (version)
      SELECT 0
      WHERE NOT EXISTS (SELECT 1 FROM schema_version)
    `);
  },
];

export async function runMigrations(pool: pg.Pool): Promise<void> {
  // Run migration 0 first (outside the version-gated loop) because it creates
  // the schema_version table itself. It is idempotent so running it on an
  // already-initialized database is safe.
  const bootstrapClient = await pool.connect();
  try {
    await migrations[0](bootstrapClient);
    log.info("[stavrobot] Migration 0 applied (baseline schema).");
  } finally {
    bootstrapClient.release();
  }

  // Read the current version after migration 0 has ensured the table exists.
  const versionResult = await pool.query<{ version: number }>("SELECT version FROM schema_version WHERE id = 1");
  let currentVersion = versionResult.rows[0].version;
  log.info(`[stavrobot] Current schema version: ${currentVersion}`);

  // Apply any pending migrations in order.
  for (let index = currentVersion + 1; index < migrations.length; index++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migrations[index](client);
      await client.query("UPDATE schema_version SET version = $1 WHERE id = 1", [index]);
      await client.query("COMMIT");
      currentVersion = index;
      log.info(`[stavrobot] Migration ${index} applied.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (currentVersion === 0) {
    log.info("[stavrobot] Schema is up to date.");
  }
}
