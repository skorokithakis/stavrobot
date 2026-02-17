import pg from "pg";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PostgresConfig } from "./config.js";

export async function connectDatabase(config: PostgresConfig): Promise<pg.Pool> {
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

export async function initializeMemorySchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL,
      CHECK (id = 1)
    )
  `);
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

export async function readMemory(pool: pg.Pool): Promise<string> {
  const result = await pool.query("SELECT content FROM memory WHERE id = 1");
  if (result.rows.length === 0) {
    return "";
  }
  return result.rows[0].content as string;
}

export async function updateMemory(pool: pg.Pool, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO memory (id, content) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
    [content]
  );
}

export interface Compaction {
  id: number;
  summary: string;
  upToMessageId: number;
}

export async function loadLatestCompaction(pool: pg.Pool): Promise<Compaction | null> {
  const result = await pool.query(
    "SELECT id, summary, up_to_message_id FROM compactions ORDER BY id DESC LIMIT 1"
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

export async function saveCompaction(pool: pg.Pool, summary: string, upToMessageId: number): Promise<void> {
  await pool.query(
    "INSERT INTO compactions (summary, up_to_message_id) VALUES ($1, $2)",
    [summary, upToMessageId]
  );
}

export async function loadMessages(pool: pg.Pool): Promise<AgentMessage[]> {
  const compaction = await loadLatestCompaction(pool);
  
  if (compaction === null) {
    const result = await pool.query("SELECT content FROM messages ORDER BY id");
    return result.rows.map((row) => row.content as AgentMessage);
  }
  
  const result = await pool.query(
    "SELECT content FROM messages WHERE id > $1 ORDER BY id",
    [compaction.upToMessageId]
  );
  const messages = result.rows.map((row) => row.content as AgentMessage);
  
  const syntheticMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: compaction.summary }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "synthetic-compaction",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  
  return [syntheticMessage, ...messages];
}

export async function saveMessage(pool: pg.Pool, message: AgentMessage): Promise<void> {
  await pool.query(
    "INSERT INTO messages (role, content) VALUES ($1, $2)",
    [message.role, message]
  );
}

export async function executeSql(pool: pg.Pool, sql: string): Promise<string> {
  const result = await pool.query(sql);
  
  if (result.command === "SELECT") {
    return JSON.stringify(result.rows);
  } else {
    return JSON.stringify({ rowCount: result.rowCount });
  }
}
