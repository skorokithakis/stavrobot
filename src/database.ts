import fs from "fs";
import pg from "pg";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadPostgresConfig, OWNER_CHANNELS } from "./config.js";
import { encodeToToon } from "./toon.js";
import type { OwnerConfig } from "./config.js";
import { log } from "./log.js";
import { matchesEmailEntry } from "./allowlist.js";

export async function connectDatabase(): Promise<pg.Pool> {
  const config = loadPostgresConfig();
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  return pool;
}

export async function initializeSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function initializeMemoriesSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Backfill existing tables that predate the timestamp columns.
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
}

export async function initializeCompactionsSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compactions (
      id SERIAL PRIMARY KEY,
      summary TEXT NOT NULL,
      up_to_message_id INTEGER NOT NULL REFERENCES messages(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// Set by seedOwner() on startup. Null until seeding completes.
let ownerInterlocutorId: number | null = null;
// Set by seedOwner() on startup. Null until seeding completes.
let mainAgentId: number | null = null;
// Keyed as "service:identifier" for O(1) lookup.
let ownerIdentitySet: Set<string> = new Set();
// Owner email patterns (may include wildcards) for use with matchesEmailEntry.
let ownerEmailEntries: string[] = [];

export function getOwnerInterlocutorId(): number {
  if (ownerInterlocutorId === null) {
    throw new Error("Owner interlocutor ID accessed before seedOwner() completed.");
  }
  return ownerInterlocutorId;
}

export function getMainAgentId(): number {
  if (mainAgentId === null) {
    throw new Error("Main agent ID accessed before seedOwner() completed.");
  }
  return mainAgentId;
}

export function isOwnerIdentity(service: string, identifier: string): boolean {
  if (service === "email") {
    return ownerEmailEntries.some((entry) => matchesEmailEntry(identifier, entry));
  }
  return ownerIdentitySet.has(`${service}:${identifier}`);
}

export async function initializeAgentsSchema(pool: pg.Pool): Promise<void> {
  // The agents table must be created first because messages, compactions, and
  // interlocutors all reference it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      allowed_tools TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_plugins TEXT[] NOT NULL DEFAULT '{}'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS interlocutors (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL UNIQUE,
      owner BOOLEAN NOT NULL DEFAULT FALSE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      agent_id INTEGER REFERENCES agents(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The old schema had an instructions column; remove it if it exists.
  await pool.query(`ALTER TABLE interlocutors DROP COLUMN IF EXISTS instructions`);
  // The old schema had no agent_id column; add it if it doesn't exist.
  await pool.query(`ALTER TABLE interlocutors ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON interlocutors (owner) WHERE owner = true
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interlocutor_identities (
      id SERIAL PRIMARY KEY,
      interlocutor_id INTEGER NOT NULL REFERENCES interlocutors(id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      identifier TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The old schema had identifier NOT NULL; make it nullable to support soft-deletion.
  await pool.query(`ALTER TABLE interlocutor_identities ALTER COLUMN identifier DROP NOT NULL`);
  // The old schema had a regular UNIQUE (service, identifier) constraint. Drop it before
  // creating the partial index, which only covers non-null identifiers to allow multiple
  // soft-deleted rows per service.
  await pool.query(`
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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS interlocutor_identities_service_identifier
      ON interlocutor_identities (service, identifier)
      WHERE identifier IS NOT NULL
  `);

  // Drop the old interlocutor_id columns from messages and compactions (added by the
  // previous schema migration). There is no production data in these columns.
  await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS interlocutor_id`);
  await pool.query(`ALTER TABLE compactions DROP COLUMN IF EXISTS interlocutor_id`);

  // Add agent_id as nullable first so existing rows (which predate the agents system)
  // can be backfilled before the NOT NULL constraint is applied.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);
  await pool.query(`ALTER TABLE compactions ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`);

  // Add the sender columns to messages. Both are nullable; at most one may be set per row.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER REFERENCES interlocutor_identities(id)`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_agent_id INTEGER REFERENCES agents(id)`);

  // Enforce the at-most-one-sender invariant. The constraint name is stable so
  // IF NOT EXISTS semantics are achieved by catching the duplicate-object error.
  await pool.query(`
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
}

export async function seedOwner(pool: pg.Pool, ownerConfig: OwnerConfig): Promise<number> {
  // Seed the main agent (agent 1) first. Its system prompt is built at runtime from
  // files, so we store an empty string here and never read it back from the DB.
  const agentResult = await pool.query<{ id: number }>(
    `INSERT INTO agents (id, name, system_prompt, allowed_tools, allowed_plugins)
     VALUES (1, 'main', '', '{*}', '{*}')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, allowed_plugins = '{*}'
     RETURNING id`,
  );
  const seededMainAgentId = agentResult.rows[0].id;
  log.info(`[stavrobot] Main agent seeded: id=${seededMainAgentId}`);

  // Backfill existing messages and compactions that predate the agents system.
  const messagesResult = await pool.query(
    "UPDATE messages SET agent_id = $1 WHERE agent_id IS NULL",
    [seededMainAgentId],
  );
  const compactionsResult = await pool.query(
    "UPDATE compactions SET agent_id = $1 WHERE agent_id IS NULL",
    [seededMainAgentId],
  );
  log.info(`[stavrobot] Backfilled ${messagesResult.rowCount ?? 0} message(s) and ${compactionsResult.rowCount ?? 0} compaction(s) to main agent`);

  // Use a select-then-insert/update pattern because the partial unique index on
  // owner=true cannot be used as an ON CONFLICT target in standard SQL.
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM interlocutors WHERE owner = true",
  );

  let ownerId: number;
  if (existing.rows.length > 0) {
    ownerId = existing.rows[0].id;
    await pool.query(
      "UPDATE interlocutors SET display_name = $1, agent_id = $2 WHERE id = $3",
      [ownerConfig.name, seededMainAgentId, ownerId],
    );
    log.info(`[stavrobot] Owner interlocutor updated: id=${ownerId}, name=${ownerConfig.name}`);
  } else {
    const result = await pool.query<{ id: number }>(
      "INSERT INTO interlocutors (display_name, owner, agent_id) VALUES ($1, true, $2) RETURNING id",
      [ownerConfig.name, seededMainAgentId],
    );
    ownerId = result.rows[0].id;
    log.info(`[stavrobot] Owner interlocutor created: id=${ownerId}, name=${ownerConfig.name}`);
  }

  // Upsert each configured identity for the owner.
  const identities: Array<{ service: string; identifier: string }> = [];
  for (const channel of OWNER_CHANNELS) {
    const value = ownerConfig[channel];
    if (value !== undefined) {
      const identifier = channel === "email" ? value.toLowerCase() : value;
      identities.push({ service: channel, identifier });
    }
  }

  for (const identity of identities) {
    // The partial unique index only covers rows where identifier IS NOT NULL, so
    // the ON CONFLICT clause must repeat the same WHERE predicate.
    await pool.query(
      `INSERT INTO interlocutor_identities (interlocutor_id, service, identifier)
       VALUES ($1, $2, $3)
       ON CONFLICT (service, identifier) WHERE identifier IS NOT NULL
       DO UPDATE SET interlocutor_id = $1`,
      [ownerId, identity.service, identity.identifier],
    );
    log.info(`[stavrobot] Owner identity upserted: service=${identity.service}, identifier=${identity.identifier}`);
  }

  ownerInterlocutorId = ownerId;
  mainAgentId = seededMainAgentId;
  ownerIdentitySet = new Set(identities.map(({ service, identifier }) => `${service}:${identifier}`));
  ownerEmailEntries = identities
    .filter(({ service }) => service === "email")
    .map(({ identifier }) => identifier);

  return ownerId;
}

export interface Agent {
  id: number;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  allowedPlugins: string[];
  createdAt: Date;
}

export async function loadAgent(pool: pg.Pool, agentId: number): Promise<Agent | null> {
  const result = await pool.query<{
    id: number;
    name: string;
    system_prompt: string;
    allowed_tools: string[];
    allowed_plugins: string[];
    created_at: Date;
  }>(
    "SELECT id, name, system_prompt, allowed_tools, allowed_plugins, created_at FROM agents WHERE id = $1",
    [agentId],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    allowedTools: row.allowed_tools,
    allowedPlugins: row.allowed_plugins,
    createdAt: row.created_at,
  };
}

export async function createAgent(
  pool: pg.Pool,
  name: string,
  systemPrompt: string,
  allowedTools: string[],
  allowedPlugins: string[],
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO agents (name, system_prompt, allowed_tools, allowed_plugins) VALUES ($1, $2, $3, $4) RETURNING id",
    [name, systemPrompt, allowedTools, allowedPlugins],
  );
  const newId = result.rows[0].id;
  log.info(`[stavrobot] Agent created: id=${newId}, name=${name}`);
  return newId;
}

export async function updateAgent(
  pool: pg.Pool,
  agentId: number,
  fields: { name?: string; systemPrompt?: string; allowedTools?: string[]; allowedPlugins?: string[] },
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (fields.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(fields.name);
  }
  if (fields.systemPrompt !== undefined) {
    setClauses.push(`system_prompt = $${paramIndex++}`);
    values.push(fields.systemPrompt);
  }
  if (fields.allowedTools !== undefined) {
    setClauses.push(`allowed_tools = $${paramIndex++}`);
    values.push(fields.allowedTools);
  }
  if (fields.allowedPlugins !== undefined) {
    setClauses.push(`allowed_plugins = $${paramIndex++}`);
    values.push(fields.allowedPlugins);
  }

  if (setClauses.length === 0) {
    return;
  }

  values.push(agentId);
  await pool.query(
    `UPDATE agents SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
    values,
  );
  log.info(`[stavrobot] Agent updated: id=${agentId}`);
}

export async function listAgents(pool: pg.Pool): Promise<Agent[]> {
  const result = await pool.query<{
    id: number;
    name: string;
    system_prompt: string;
    allowed_tools: string[];
    allowed_plugins: string[];
    created_at: Date;
  }>(
    "SELECT id, name, system_prompt, allowed_tools, allowed_plugins, created_at FROM agents ORDER BY id",
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    allowedTools: row.allowed_tools,
    allowedPlugins: row.allowed_plugins,
    createdAt: row.created_at,
  }));
}

export interface Memory {
  id: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function loadAllMemories(pool: pg.Pool): Promise<Memory[]> {
  const result = await pool.query("SELECT id, content, created_at, updated_at FROM memories ORDER BY created_at");
  return result.rows.map((row) => ({
    id: row.id as number,
    content: row.content as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }));
}

export async function upsertMemory(pool: pg.Pool, id: number | undefined, content: string): Promise<{ id: number; rowCount: number }> {
  if (id === undefined) {
    const result = await pool.query(
      "INSERT INTO memories (content) VALUES ($1) RETURNING id",
      [content]
    );
    return { id: result.rows[0].id as number, rowCount: 1 };
  } else {
    const result = await pool.query(
      "UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2",
      [content, id]
    );
    return { id, rowCount: result.rowCount ?? 0 };
  }
}

export async function deleteMemory(pool: pg.Pool, id: number): Promise<number> {
  const result = await pool.query("DELETE FROM memories WHERE id = $1", [id]);
  return result.rowCount ?? 0;
}

export interface Compaction {
  id: number;
  summary: string;
  upToMessageId: number;
}

export interface InterlocutorInfo {
  interlocutorId: number;
  identityId: number;
  agentId: number;
  isOwner: boolean;
  displayName: string;
}

export async function resolveInterlocutorByName(
  pool: pg.Pool,
  displayName: string,
): Promise<{ id: number } | null> {
  const result = await pool.query<{ id: number }>(
    "SELECT id FROM interlocutors WHERE display_name = $1",
    [displayName],
  );
  if (result.rows.length === 0) {
    return null;
  }
  return { id: result.rows[0].id };
}

export async function resolveRecipient(
  pool: pg.Pool,
  displayName: string,
  service: string,
): Promise<{ identifier: string } | { disabled: true; displayName: string } | null> {
  const result = await pool.query<{ identifier: string | null; enabled: boolean }>(
    // Exclude soft-deleted identities (identifier IS NULL) from recipient resolution.
    `SELECT ii.identifier, i.enabled
     FROM interlocutors i
     LEFT JOIN interlocutor_identities ii ON ii.interlocutor_id = i.id AND ii.service = $2 AND ii.identifier IS NOT NULL
     WHERE i.display_name = $1`,
    [displayName, service],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  if (!row.enabled) {
    return { disabled: true, displayName };
  }
  if (row.identifier === null) {
    return null;
  }
  return { identifier: row.identifier };
}

export async function resolveInterlocutor(
  pool: pg.Pool,
  service: string,
  identifier: string,
): Promise<InterlocutorInfo | null> {
  const result = await pool.query<{
    interlocutor_id: number;
    identity_id: number;
    agent_id: number | null;
    display_name: string;
  }>(
    `SELECT i.id AS interlocutor_id, ii.id AS identity_id, i.agent_id, i.display_name
     FROM interlocutor_identities ii
     JOIN interlocutors i ON i.id = ii.interlocutor_id
     WHERE ii.service = $1 AND ii.identifier = $2 AND i.enabled = true`,
    [service, identifier],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  // Interlocutors with no assigned agent have their messages dropped by the queue.
  if (row.agent_id === null) {
    return null;
  }
  return {
    interlocutorId: row.interlocutor_id,
    identityId: row.identity_id,
    agentId: row.agent_id,
    isOwner: row.interlocutor_id === getOwnerInterlocutorId(),
    displayName: row.display_name,
  };
}

export async function loadLatestCompaction(pool: pg.Pool, agentId: number): Promise<Compaction | null> {
  const result = await pool.query(
    "SELECT id, summary, up_to_message_id FROM compactions WHERE agent_id = $1 ORDER BY id DESC LIMIT 1",
    [agentId],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id as number,
    summary: row.summary as string,
    upToMessageId: row.up_to_message_id as number,
  };
}

export async function saveCompaction(pool: pg.Pool, summary: string, upToMessageId: number, agentId: number): Promise<void> {
  await pool.query(
    "INSERT INTO compactions (summary, up_to_message_id, agent_id) VALUES ($1, $2, $3)",
    [summary, upToMessageId, agentId],
  );
}

export async function loadMessages(pool: pg.Pool, agentId: number): Promise<AgentMessage[]> {
  const compaction = await loadLatestCompaction(pool, agentId);

  if (compaction === null) {
    const result = await pool.query(
      "SELECT content FROM messages WHERE agent_id = $1 ORDER BY id",
      [agentId],
    );
    return result.rows.map((row) => row.content as AgentMessage);
  }

  const result = await pool.query(
    "SELECT content FROM messages WHERE agent_id = $1 AND id > $2 ORDER BY id",
    [agentId, compaction.upToMessageId],
  );
  let messages = result.rows.map((row) => row.content as AgentMessage);

  // Drop any leading toolResult messages. These can appear when the compaction
  // boundary landed just before a tool-result row that belongs to a tool-use
  // block already included in the summary. Keeping them would produce an
  // orphaned tool_result with no preceding assistant/tool_use, which the API
  // rejects with a 400.
  let firstNonToolResult = 0;
  while (firstNonToolResult < messages.length && messages[firstNonToolResult].role === "toolResult") {
    firstNonToolResult++;
  }
  if (firstNonToolResult > 0) {
    messages = messages.slice(firstNonToolResult);
  }

  const syntheticMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: `[Summary of earlier conversation]\n${compaction.summary}` }],
    timestamp: Date.now(),
  };

  return [syntheticMessage, ...messages];
}

export async function saveMessage(
  pool: pg.Pool,
  message: AgentMessage,
  agentId: number,
  senderIdentityId?: number,
  senderAgentId?: number,
): Promise<void> {
  await pool.query(
    "INSERT INTO messages (role, content, agent_id, sender_identity_id, sender_agent_id) VALUES ($1, $2, $3, $4, $5)",
    [message.role, message, agentId, senderIdentityId ?? null, senderAgentId ?? null],
  );
}

export async function initializeCronSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
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
}

const NIGHTLY_CHECKUP_CRON_PATH = "prompts/nightly-checkup-cron.txt";
const NIGHTLY_REVIEW_MARKER = "[nightly-review]";
const NIGHTLY_REVIEW_CRON_EXPRESSION = "0 3 * * *";

export async function seedNightlyReview(pool: pg.Pool): Promise<void> {
  let promptText: string;
  try {
    promptText = fs.readFileSync(NIGHTLY_CHECKUP_CRON_PATH, "utf-8").trimEnd();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      log.warn(`[stavrobot] ${NIGHTLY_CHECKUP_CRON_PATH} not found, skipping nightly review seed.`);
      return;
    }
    throw error;
  }

  const note = `${NIGHTLY_REVIEW_MARKER} ${promptText}`;

  const existing = await pool.query<{ id: number; note: string }>(
    "SELECT id, note FROM cron_entries WHERE note LIKE $1",
    [`${NIGHTLY_REVIEW_MARKER}%`],
  );

  if (existing.rows.length === 0) {
    await pool.query(
      "INSERT INTO cron_entries (cron_expression, note) VALUES ($1, $2)",
      [NIGHTLY_REVIEW_CRON_EXPRESSION, note],
    );
    log.info("[stavrobot] Nightly review cron entry created.");
  } else {
    const row = existing.rows[0];
    if (row.note !== note) {
      await pool.query(
        "UPDATE cron_entries SET note = $1 WHERE id = $2",
        [note, row.id],
      );
      log.info("[stavrobot] Nightly review cron entry updated.");
    } else {
      log.info("[stavrobot] Nightly review cron entry is up to date.");
    }
  }
}

export interface CronEntry {
  id: number;
  cronExpression: string | null;
  fireAt: Date | null;
  note: string;
}

export async function createCronEntry(
  pool: pg.Pool,
  cronExpression: string | null,
  fireAt: Date | null,
  note: string,
): Promise<CronEntry> {
  const result = await pool.query(
    "INSERT INTO cron_entries (cron_expression, fire_at, note) VALUES ($1, $2, $3) RETURNING id, cron_expression, fire_at, note",
    [cronExpression, fireAt, note],
  );
  const row = result.rows[0];
  return {
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  };
}

export async function updateCronEntry(
  pool: pg.Pool,
  id: number,
  fields: { cronExpression?: string | null; fireAt?: Date | null; note?: string },
): Promise<CronEntry> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if ("cronExpression" in fields) {
    setClauses.push(`cron_expression = $${paramIndex++}`);
    values.push(fields.cronExpression);
  }
  if ("fireAt" in fields) {
    setClauses.push(`fire_at = $${paramIndex++}`);
    values.push(fields.fireAt);
  }
  if ("note" in fields) {
    setClauses.push(`note = $${paramIndex++}`);
    values.push(fields.note);
  }

  values.push(id);
  const result = await pool.query(
    `UPDATE cron_entries SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING id, cron_expression, fire_at, note`,
    values,
  );
  const row = result.rows[0];
  return {
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  };
}

export async function deleteCronEntry(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM cron_entries WHERE id = $1", [id]);
}

export async function listCronEntries(pool: pg.Pool): Promise<CronEntry[]> {
  const result = await pool.query(
    "SELECT id, cron_expression, fire_at, note FROM cron_entries ORDER BY id",
  );
  return result.rows.map((row) => ({
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  }));
}

export async function initializePagesSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      mimetype TEXT NOT NULL,
      data BYTEA NOT NULL,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS queries JSONB`);
}

export interface Page {
  mimetype: string;
  data: Buffer;
  isPublic: boolean;
  queries: Record<string, string> | null;
}

export async function getPageByPath(pool: pg.Pool, path: string): Promise<Page | null> {
  const result = await pool.query(
    "SELECT mimetype, data, is_public, queries FROM pages WHERE path = $1",
    [path],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    mimetype: row.mimetype as string,
    data: row.data as Buffer,
    isPublic: row.is_public as boolean,
    queries: row.queries as Record<string, string> | null,
  };
}

export async function getPageQueryByPath(
  pool: pg.Pool,
  pagePath: string,
  queryName: string,
): Promise<{ query: string; isPublic: boolean } | null> {
  const result = await pool.query(
    "SELECT queries->>$2 AS query, is_public FROM pages WHERE path = $1",
    [pagePath, queryName],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  const query = row.query as string | null;
  if (query === null) {
    return null;
  }
  return {
    query,
    isPublic: row.is_public as boolean,
  };
}

export async function upsertPage(
  pool: pg.Pool,
  path: string,
  mimetype?: string,
  content?: string,
  isPublic?: boolean,
  queries?: Record<string, string>,
): Promise<string> {
  const existing = await pool.query("SELECT 1 FROM pages WHERE path = $1", [path]);

  if (existing.rows.length === 0) {
    if (content === undefined || mimetype === undefined) {
      return "Error: content and mimetype are required when creating a new page.";
    }
    await pool.query(
      `INSERT INTO pages (path, mimetype, data, is_public, queries)
       VALUES ($1, $2, convert_to($3, 'UTF8'), $4, $5)`,
      [path, mimetype, content, isPublic ?? false, queries !== undefined ? JSON.stringify(queries) : null],
    );
    return `Page created at /pages/${path}`;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (mimetype !== undefined) {
    setClauses.push(`mimetype = $${paramIndex++}`);
    values.push(mimetype);
  }
  if (content !== undefined) {
    setClauses.push(`data = convert_to($${paramIndex++}, 'UTF8')`);
    values.push(content);
  }
  if (isPublic !== undefined) {
    setClauses.push(`is_public = $${paramIndex++}`);
    values.push(isPublic);
  }
  if (queries !== undefined) {
    setClauses.push(`queries = $${paramIndex++}`);
    values.push(JSON.stringify(queries));
  }

  if (setClauses.length === 0) {
    return "Error: no fields to update. Provide at least one of mimetype, content, is_public, or queries.";
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(path);

  await pool.query(
    `UPDATE pages SET ${setClauses.join(", ")} WHERE path = $${paramIndex}`,
    values,
  );
  return `Page updated at /pages/${path}`;
}

export async function deletePage(pool: pg.Pool, path: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM pages WHERE path = $1", [path]);
  return (result.rowCount ?? 0) > 0;
}

export async function initializeScratchpadSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scratchpad (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export interface ScratchpadTitle {
  id: number;
  title: string;
}

export async function loadAllScratchpadTitles(pool: pg.Pool): Promise<ScratchpadTitle[]> {
  const result = await pool.query("SELECT id, title FROM scratchpad ORDER BY created_at");
  return result.rows.map((row) => ({
    id: row.id as number,
    title: row.title as string,
  }));
}

export async function upsertScratchpad(pool: pg.Pool, id: number | undefined, title: string, body: string): Promise<{ id: number; rowCount: number }> {
  if (id === undefined) {
    const result = await pool.query(
      "INSERT INTO scratchpad (title, body) VALUES ($1, $2) RETURNING id",
      [title, body],
    );
    return { id: result.rows[0].id as number, rowCount: 1 };
  } else {
    const result = await pool.query(
      "UPDATE scratchpad SET title = $1, body = $2, updated_at = NOW() WHERE id = $3",
      [title, body, id],
    );
    return { id, rowCount: result.rowCount ?? 0 };
  }
}

export async function deleteScratchpad(pool: pg.Pool, id: number): Promise<number> {
  const result = await pool.query("DELETE FROM scratchpad WHERE id = $1", [id]);
  return result.rowCount ?? 0;
}

export async function executeSql(pool: pg.Pool, sql: string): Promise<string> {
  const result = await pool.query(sql);

  if (result.command === "SELECT") {
    return encodeToToon(result.rows);
  } else {
    return encodeToToon({ rowCount: result.rowCount });
  }
}
