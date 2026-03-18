import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { EmbeddingsConfig } from "./config.js";
import { fetchEmbeddings, extractText } from "./embeddings.js";
import { getMainAgentId } from "./database.js";
import { encodeToToon } from "./toon.js";
import { log } from "./log.js";

const EXCLUDED_TABLES = new Set(["messages", "compactions"]);
const TEXT_LIKE_TYPES = new Set(["text", "varchar", "character", "character varying"]);
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 20;
const RRF_K = 60;
const TEXT_TRUNCATION_LIMIT = 4000;

interface ColumnRow {
  table_name: string;
  column_name: string;
  has_created_at: boolean;
}

export interface TableResult {
  tableName: string;
  matchCount: number;
  rows: Record<string, unknown>[];
}

interface MessageRow {
  id: number;
  role: string;
  content: unknown;
  created_at: Date;
}

export interface RankedMessage {
  id: number;
  role: string;
  content: unknown;
  created_at: Date;
  score: number;
}

export interface SearchResults {
  tableResults: TableResult[];
  messages: RankedMessage[];
  queryEmbedding?: number[];
}

export async function runSearch(
  pool: pg.Pool,
  query: string,
  limit: number,
  mainAgentId: number,
  embeddingsConfig?: EmbeddingsConfig,
): Promise<SearchResults> {
  const columnsResult = await pool.query<ColumnRow>(
    `SELECT
       c.table_name,
       c.column_name,
       EXISTS (
         SELECT 1
         FROM information_schema.columns c2
         WHERE c2.table_schema = 'public'
           AND c2.table_name = c.table_name
           AND c2.column_name = 'created_at'
       ) AS has_created_at
     FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.data_type = ANY($1)
     ORDER BY c.table_name, c.column_name`,
    [Array.from(TEXT_LIKE_TYPES)],
  );

  // Group text-like columns by table, skipping excluded tables.
  const tableColumns = new Map<string, string[]>();
  const tableHasCreatedAt = new Map<string, boolean>();
  for (const row of columnsResult.rows) {
    if (EXCLUDED_TABLES.has(row.table_name)) {
      continue;
    }
    const columns = tableColumns.get(row.table_name) ?? [];
    columns.push(row.column_name);
    tableColumns.set(row.table_name, columns);
    tableHasCreatedAt.set(row.table_name, row.has_created_at);
  }

  const tableResults: TableResult[] = [];

  for (const [tableName, columns] of tableColumns) {
    // Build a tsvector expression that concatenates all text columns.
    const tsvectorExpr = columns
      .map((column) => `coalesce("${column}", '')`)
      .join(" || ' ' || ");

    const orderClause = tableHasCreatedAt.get(tableName) === true
      ? `ORDER BY "created_at" DESC`
      : "";

    const searchQuery = `
      SELECT *
      FROM "${tableName}"
      WHERE to_tsvector('english', ${tsvectorExpr}) @@ plainto_tsquery('english', $1)
      ${orderClause}
      LIMIT ${limit}
    `;

    const searchResult = await pool.query(searchQuery, [query]);

    if (searchResult.rows.length > 0) {
      tableResults.push({
        tableName,
        matchCount: searchResult.rows.length,
        rows: searchResult.rows as Record<string, unknown>[],
      });
      log.debug(`[stavrobot] search: table "${tableName}" returned ${searchResult.rows.length} match(es)`);
    }
  }

  // Full-text search on messages. We extract only the text parts from the
  // JSONB content to avoid hitting Postgres's 1MB tsvector limit that would
  // be triggered by casting the whole blob (which includes metadata, model
  // info, usage stats, etc.). User messages may store their inner content as
  // a plain string; assistant messages store it as an array of typed parts.
  const fullTextResult = await pool.query<MessageRow>(
    `SELECT m.id, m.role, m.content, m.created_at
     FROM messages m
     WHERE m.role IN ('user', 'assistant')
       AND m.agent_id = $3
       AND to_tsvector('english',
         CASE
           WHEN jsonb_typeof(m.content->'content') = 'string' THEN m.content->>'content'
           WHEN jsonb_typeof(m.content->'content') = 'array' THEN (
             SELECT coalesce(string_agg(part->>'text', ' '), '')
             FROM jsonb_array_elements(m.content->'content') AS part
             WHERE part->>'type' = 'text'
           )
           ELSE ''
         END
       ) @@ plainto_tsquery('english', $1)
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [query, limit, mainAgentId],
  );
  log.debug(`[stavrobot] search: messages full-text returned ${fullTextResult.rows.length} match(es)`);

  // Assign RRF ranks to full-text results (1-indexed).
  const fullTextRanks = new Map<number, number>();
  for (let i = 0; i < fullTextResult.rows.length; i++) {
    fullTextRanks.set(fullTextResult.rows[i].id, i + 1);
  }

  // Semantic search on messages when embeddings are configured.
  const semanticRanks = new Map<number, number>();
  const semanticRows = new Map<number, MessageRow>();
  let queryEmbedding: number[] | undefined;

  if (embeddingsConfig !== undefined) {
    const truncatedQuery = query.slice(0, TEXT_TRUNCATION_LIMIT);
    try {
      const embeddings = await fetchEmbeddings([truncatedQuery], embeddingsConfig.apiKey);
      queryEmbedding = embeddings[0];
      const queryVector = `[${queryEmbedding.join(",")}]`;

      const semanticResult = await pool.query<MessageRow>(
        `SELECT m.id, m.role, m.content, m.created_at
         FROM messages m
         JOIN message_embeddings me ON me.message_id = m.id
         WHERE m.role IN ('user', 'assistant')
           AND m.agent_id = $3
         ORDER BY me.embedding <=> $1
         LIMIT $2`,
        [queryVector, limit, mainAgentId],
      );
      log.debug(`[stavrobot] search: messages semantic returned ${semanticResult.rows.length} match(es)`);

      for (let i = 0; i < semanticResult.rows.length; i++) {
        const row = semanticResult.rows[i];
        semanticRanks.set(row.id, i + 1);
        semanticRows.set(row.id, row);
      }
    } catch (error) {
      log.error("[stavrobot] search: embedding call failed, falling back to full-text only:", error instanceof Error ? error.message : String(error));
    }
  }

  // Merge full-text and semantic results using Reciprocal Rank Fusion.
  const allMessageIds = new Set<number>([
    ...fullTextResult.rows.map((row) => row.id),
    ...semanticRanks.keys(),
  ]);

  const mergedMessages: RankedMessage[] = [];
  for (const messageId of allMessageIds) {
    const ftRank = fullTextRanks.get(messageId);
    const semRank = semanticRanks.get(messageId);

    let score = 0;
    if (ftRank !== undefined) {
      score += 1 / (RRF_K + ftRank);
    }
    if (semRank !== undefined) {
      score += 1 / (RRF_K + semRank);
    }

    // Prefer the row from full-text results; fall back to semantic results.
    const row = fullTextResult.rows.find((r) => r.id === messageId) ?? semanticRows.get(messageId);
    if (row === undefined) {
      continue;
    }

    mergedMessages.push({ ...row, score });
  }

  // Sort by descending RRF score and take the top N.
  mergedMessages.sort((a, b) => b.score - a.score);
  const topMessages = mergedMessages.slice(0, limit);

  return { tableResults, messages: topMessages, queryEmbedding };
}

export function createSearchTool(pool: pg.Pool, embeddingsConfig?: EmbeddingsConfig): AgentTool {
  return {
    name: "db_search",
    label: "Search",
    description: "Search conversation history and all database tables. Always call this tool when the user asks about something that seems familiar but isn't in your current context — search before saying you don't remember.",
    parameters: Type.Object({
      query: Type.String({ description: "The text to search for" }),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum number of rows to return per table. Default: ${LIMIT_DEFAULT}, max: ${LIMIT_MAX}.`,
          default: LIMIT_DEFAULT,
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { query, limit: rawLimit } = params as { query: string; limit?: number };
      const limit = Math.min(LIMIT_MAX, Math.max(1, rawLimit ?? LIMIT_DEFAULT));

      const mainAgentId = getMainAgentId();
      const { tableResults, messages: topMessages } = await runSearch(pool, query, limit, mainAgentId, embeddingsConfig);

      const parts: string[] = [];

      for (const tableResult of tableResults) {
        parts.push(`Table: ${tableResult.tableName} (${tableResult.matchCount} match(es))`);
        parts.push(encodeToToon(tableResult.rows));
      }

      if (topMessages.length > 0) {
        parts.push(`Messages (${topMessages.length} match(es)):`);
        for (const message of topMessages) {
          const timestamp = message.created_at.toISOString();
          // The content field may be a nested object with a content property (as
          // stored by the embeddings worker), or a plain string/array.
          const rawContent = (message.content as { content?: unknown }).content ?? message.content;
          const text = extractText(rawContent);
          parts.push(`[id:${message.id}] [${timestamp}] ${message.role}: ${text}`);
        }
      }

      if (parts.length === 0) {
        const noResultsMessage = `No results found for "${query}".`;
        log.debug("[stavrobot] search: no results found");
        return {
          content: [{ type: "text" as const, text: noResultsMessage }],
          details: { result: noResultsMessage },
        };
      }

      const result = parts.join("\n\n");

      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
