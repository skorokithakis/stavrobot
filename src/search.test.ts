import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";

vi.mock("./embeddings.js", () => ({
  fetchEmbeddings: vi.fn(),
  extractText: vi.fn().mockImplementation((content: unknown) => {
    if (typeof content === "string") return content;
    return "";
  }),
}));
vi.mock("./database.js", () => ({
  getMainAgentId: vi.fn().mockReturnValue(1),
  loadLatestCompaction: vi.fn(),
}));
vi.mock("./toon.js", () => ({
  encodeToToon: vi.fn().mockReturnValue(""),
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchEmbeddings } from "./embeddings.js";
import { loadLatestCompaction } from "./database.js";
import { createSearchTool, runSearch } from "./search.js";
import type { EmbeddingsConfig } from "./config.js";

const fetchEmbeddingsMock = vi.mocked(fetchEmbeddings);
const loadLatestCompactionMock = vi.mocked(loadLatestCompaction);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no compaction exists.
  loadLatestCompactionMock.mockResolvedValue(null);
});

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

const isColumnDiscoveryQuery = (text: string): boolean => text.includes("information_schema");
const isFullTextMessageQuery = (text: string): boolean =>
  text.includes("FROM messages") && text.includes("m.role") && !text.includes("JOIN message_embeddings");
const isSemanticMessageQuery = (text: string): boolean =>
  text.includes("JOIN message_embeddings");

// Returns an empty result for all queries (no matches, no messages).
function emptyPool(): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
  );
}

// Returns a pool where message queries return empty results.
// Used when a compaction is configured via loadLatestCompactionMock.
function poolWithEmptyMessages(): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
  );
}

const embeddingsConfig: EmbeddingsConfig = { apiKey: "test-key" };

describe("runSearch — queryEmbedding in SearchResults", () => {
  it("populates queryEmbedding when embeddings are configured and the API call succeeds", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const pool = poolWithEmptyMessages();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toEqual(embedding);
  });

  it("leaves queryEmbedding undefined when embeddings are not configured", async () => {
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const pool = poolWithEmptyMessages();
    const results = await runSearch(pool, "hello world", 5, 1, undefined);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("leaves queryEmbedding undefined when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const pool = poolWithEmptyMessages();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("still returns search results even when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const pool = poolWithEmptyMessages();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.tableResults).toEqual([]);
    expect(results.messages).toEqual([]);
  });
});

describe("runSearch — recent-message exclusion", () => {
  it("searches all messages when no compaction exists (full-text path)", async () => {
    // No compaction: loadLatestCompaction returns null (default in beforeEach).
    const oldMessage = {
      id: 5,
      role: "user",
      content: { content: "old message" },
      created_at: new Date("2024-01-01"),
    };

    const pool = makeMockPool((text) => {
      if (isFullTextMessageQuery(text)) {
        return Promise.resolve({ rows: [oldMessage], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "old message", 5, 1, undefined);

    expect(results.messages).toHaveLength(1);
    expect(results.messages[0].id).toBe(5);
  });

  it("does not apply an id upper bound when no compaction exists (full-text path)", async () => {
    // No compaction: the SQL must not contain an id upper-bound clause.
    let fullTextQueryText: string | undefined;

    const pool = makeMockPool((text) => {
      if (isFullTextMessageQuery(text)) {
        fullTextQueryText = text;
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, undefined);

    expect(fullTextQueryText).toBeDefined();
    expect(fullTextQueryText).not.toContain("m.id <=");
  });

  it("does not apply an id upper bound when no compaction exists (semantic path)", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    let semanticQueryText: string | undefined;

    const pool = makeMockPool((text) => {
      if (isSemanticMessageQuery(text)) {
        semanticQueryText = text;
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, embeddingsConfig);

    expect(semanticQueryText).toBeDefined();
    expect(semanticQueryText).not.toContain("m.id <=");
  });

  it("returns table results even when no compaction exists", async () => {
    // Table search always runs regardless of compaction state.
    let tableQueryCount = 0;
    const pool = makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        return Promise.resolve({
          rows: [{ table_name: "notes", column_name: "body", has_created_at: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (!isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          return Promise.resolve({
            rows: [{ id: 1, body: "match" }],
            rowCount: 1,
          } as unknown as QueryResult);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "match", 5, 1, undefined);

    expect(results.tableResults).toHaveLength(1);
    expect(results.messages).toEqual([]);
  });

  it("returns message hits from the older portion when a compaction exists (full-text path)", async () => {
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 50 });

    const oldMessage = {
      id: 5,
      role: "user",
      content: { content: "old message" },
      created_at: new Date("2024-01-01"),
    };

    const pool = makeMockPool((text) => {
      if (isFullTextMessageQuery(text)) {
        return Promise.resolve({ rows: [oldMessage], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "old message", 5, 1, undefined);

    expect(results.messages).toHaveLength(1);
    expect(results.messages[0].id).toBe(5);
  });

  it("passes upToMessageId to the full-text query so recent messages are excluded", async () => {
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 75 });

    let fullTextQueryValues: unknown[] | undefined;

    const pool = makeMockPool((text, values) => {
      if (isFullTextMessageQuery(text)) {
        fullTextQueryValues = values;
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, undefined);

    // The fourth parameter ($4) must be the upToMessageId (75).
    expect(fullTextQueryValues).toBeDefined();
    expect((fullTextQueryValues as unknown[])[3]).toBe(75);
  });

  it("excludes recent messages from results.messages on the full-text path", async () => {
    // upToMessageId = 100: ids 10 and 50 are old (<= 100), ids 110 and 200 are recent (> 100).
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const oldMessage1 = { id: 10, role: "user", content: { content: "old one" }, created_at: new Date("2024-01-01") };
    const oldMessage2 = { id: 50, role: "assistant", content: { content: "old two" }, created_at: new Date("2024-01-02") };

    const pool = makeMockPool((text) => {
      if (isFullTextMessageQuery(text)) {
        // The SQL must contain the compaction clause; if it is absent the test fails here.
        expect(text).toContain("m.id <= $4");
        // Return only the old messages, simulating what the SQL WHERE m.id <= $4 clause produces.
        return Promise.resolve({ rows: [oldMessage1, oldMessage2], rowCount: 2 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "test", 5, 1, undefined);

    const resultIds = results.messages.map((m) => m.id);
    // Old messages must be present.
    expect(resultIds).toContain(10);
    expect(resultIds).toContain(50);
  });

  it("passes upToMessageId to the semantic query so recent messages are excluded", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 75 });

    let semanticQueryValues: unknown[] | undefined;

    const pool = makeMockPool((text, values) => {
      if (isSemanticMessageQuery(text)) {
        semanticQueryValues = values;
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, embeddingsConfig);

    // The fourth parameter ($4) must be the upToMessageId (75).
    expect(semanticQueryValues).toBeDefined();
    expect((semanticQueryValues as unknown[])[3]).toBe(75);
  });

  it("excludes recent messages from results.messages on the semantic path", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    // upToMessageId = 100: ids 20 and 60 are old (<= 100), ids 120 and 180 are recent (> 100).
    const oldMessage1 = { id: 20, role: "user", content: { content: "old sem one" }, created_at: new Date("2024-01-01") };
    const oldMessage2 = { id: 60, role: "assistant", content: { content: "old sem two" }, created_at: new Date("2024-01-02") };

    const pool = makeMockPool((text) => {
      if (isSemanticMessageQuery(text)) {
        // The SQL must contain the compaction clause; if it is absent the test fails here.
        expect(text).toContain("m.id <= $4");
        // Return only the old messages, simulating what the SQL WHERE m.id <= $4 clause produces.
        return Promise.resolve({ rows: [oldMessage1, oldMessage2], rowCount: 2 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "test", 5, 1, embeddingsConfig);

    const resultIds = results.messages.map((m) => m.id);
    // Old messages must be present.
    expect(resultIds).toContain(20);
    expect(resultIds).toContain(60);
  });
});

describe("runSearch — agent scoping", () => {
  const columnRows = [
    { table_name: "notes", column_name: "body", has_created_at: false },
    { table_name: "memories", column_name: "content", has_created_at: true },
    { table_name: "scratchpad", column_name: "title", has_created_at: true },
  ];

  interface CapturedQuery {
    text: string;
    values?: unknown[];
  }

  function scopingPool(captured: CapturedQuery[]): Pool {
    return makeMockPool((text, values) => {
      if (isColumnDiscoveryQuery(text)) {
        return Promise.resolve({
          rows: columnRows,
          rowCount: columnRows.length,
        } as unknown as QueryResult);
      }
      captured.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
  }

  it("filters memories and scratchpad to the main agent", async () => {
    const captured: CapturedQuery[] = [];
    await runSearch(scopingPool(captured), "test", 10, 1, undefined);

    const memoriesQuery = captured.find((query) => query.text.includes(`FROM "memories"`));
    expect(memoriesQuery).toBeDefined();
    expect(memoriesQuery?.text).toContain(`"agent_id" = $2`);
    expect(memoriesQuery?.values).toEqual(["test", 1]);

    const scratchpadQuery = captured.find((query) => query.text.includes(`FROM "scratchpad"`));
    expect(scratchpadQuery).toBeDefined();
    expect(scratchpadQuery?.text).toContain(`"agent_id" = $2`);
    expect(scratchpadQuery?.values).toEqual(["test", 1]);

    // Other tables are not agent-scoped for the main agent.
    const notesQuery = captured.find((query) => query.text.includes(`FROM "notes"`));
    expect(notesQuery).toBeDefined();
    expect(notesQuery?.text).not.toContain(`"agent_id"`);
    expect(notesQuery?.values).toEqual(["test"]);
  });

  it("searches only messages, memories, and scratchpad for a subagent", async () => {
    const captured: CapturedQuery[] = [];
    const pool = scopingPool(captured);

    await runSearch(pool, "test", 10, 2, undefined);

    expect(captured.some((query) => query.text.includes(`FROM "notes"`))).toBe(false);

    const memoriesQuery = captured.find((query) => query.text.includes(`FROM "memories"`));
    expect(memoriesQuery?.values).toEqual(["test", 2]);

    const scratchpadQuery = captured.find((query) => query.text.includes(`FROM "scratchpad"`));
    expect(scratchpadQuery?.values).toEqual(["test", 2]);

    const fullTextQuery = captured.find((query) => isFullTextMessageQuery(query.text));
    expect(fullTextQuery?.values?.[2]).toBe(2);

    expect(loadLatestCompactionMock).toHaveBeenCalledWith(pool, 2);
  });

  it("db_search searches as the currently running agent", async () => {
    const captured: CapturedQuery[] = [];
    const pool = scopingPool(captured);
    const tool = createSearchTool(pool, () => 2, undefined);

    await tool.execute("call-1", { query: "test" });

    const fullTextQuery = captured.find((query) => isFullTextMessageQuery(query.text));
    expect(fullTextQuery?.values?.[2]).toBe(2);
  });
});

describe("runSearch — table result row capping", () => {
  // Builds a pool that returns one fake table with `rowCount` rows.
  function poolWithTableRows(rowCount: number): Pool {
    let tableQueryCount = 0;
    return makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        // Return one fake table with one text column.
        return Promise.resolve({
          rows: [{ table_name: "notes", column_name: "body", has_created_at: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (!isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, body: `row${i + 1}` }));
          return Promise.resolve({ rows, rowCount } as unknown as QueryResult);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
  }

  // Builds a pool that returns rows for two different tables.
  function poolWithTwoTableResults(firstCount: number, secondCount: number): Pool {
    let tableQueryCount = 0;
    return makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        return Promise.resolve({
          rows: [
            { table_name: "notes", column_name: "body", has_created_at: false },
            { table_name: "tasks", column_name: "title", has_created_at: false },
          ],
          rowCount: 2,
        } as unknown as QueryResult);
      }
      if (!isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          const rows = Array.from({ length: firstCount }, (_, i) => ({ id: i + 1, body: `a${i}` }));
          return Promise.resolve({ rows, rowCount: firstCount } as unknown as QueryResult);
        }
        if (tableQueryCount === 2) {
          const rows = Array.from({ length: secondCount }, (_, i) => ({ id: i + 1, title: `b${i}` }));
          return Promise.resolve({ rows, rowCount: secondCount } as unknown as QueryResult);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
  }

  it("returns all rows when total is within the 5-row cap", async () => {
    const pool = poolWithTableRows(3);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(3);
  });

  it("caps total table rows at 5 when a single table returns more", async () => {
    const pool = poolWithTableRows(10);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(5);
  });

  it("caps total rows at 5 across two tables", async () => {
    // First table: 4 rows, second table: 4 rows — total should be capped at 5.
    const pool = poolWithTwoTableResults(4, 4);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(5);
    // First table gets 4 rows, second gets only 1.
    expect(results.tableResults[0].rows).toHaveLength(4);
    expect(results.tableResults[1].rows).toHaveLength(1);
  });

  it("excludes tables entirely when the cap is already reached by earlier tables", async () => {
    // First table: 5 rows, second table: 3 rows — second table should be excluded.
    const pool = poolWithTwoTableResults(5, 3);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    expect(results.tableResults).toHaveLength(1);
    expect(results.tableResults[0].rows).toHaveLength(5);
  });
});
