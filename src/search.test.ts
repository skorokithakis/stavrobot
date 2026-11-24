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

  it.each([
    {
      label: "embeddings are not configured",
      embeddingsConfig: undefined,
      apiFails: false,
    },
    {
      label: "the embedding API call fails",
      embeddingsConfig,
      apiFails: true,
    },
  ])("leaves queryEmbedding undefined when $label", async ({ embeddingsConfig: config, apiFails }) => {
    if (apiFails) {
      fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));
    }
    loadLatestCompactionMock.mockResolvedValue({ id: 1, summary: "s", upToMessageId: 100 });

    const pool = poolWithEmptyMessages();
    const results = await runSearch(pool, "hello world", 5, 1, config);

    expect(results.queryEmbedding).toBeUndefined();
  });
});

describe("runSearch — recent-message exclusion", () => {
  const embedding = [0.1, 0.2, 0.3];
  const compaction = { id: 1, summary: "s", upToMessageId: 75 };

  interface MessageQueryCase {
    label: string;
    isMessageQuery: (text: string) => boolean;
    embeddingsConfig: EmbeddingsConfig | undefined;
    compaction: typeof compaction | null;
    expectIdBound: boolean;
    expectedUpToMessageId: number | undefined;
  }

  const cases: MessageQueryCase[] = [
    {
      label: "full-text path, no compaction",
      isMessageQuery: isFullTextMessageQuery,
      embeddingsConfig: undefined,
      compaction: null,
      expectIdBound: false,
      expectedUpToMessageId: undefined,
    },
    {
      label: "semantic path, no compaction",
      isMessageQuery: isSemanticMessageQuery,
      embeddingsConfig,
      compaction: null,
      expectIdBound: false,
      expectedUpToMessageId: undefined,
    },
    {
      label: "full-text path, with a compaction",
      isMessageQuery: isFullTextMessageQuery,
      embeddingsConfig: undefined,
      compaction,
      expectIdBound: true,
      expectedUpToMessageId: compaction.upToMessageId,
    },
    {
      label: "semantic path, with a compaction",
      isMessageQuery: isSemanticMessageQuery,
      embeddingsConfig,
      compaction,
      expectIdBound: true,
      expectedUpToMessageId: compaction.upToMessageId,
    },
  ];

  it.each(cases)("$label", async (testCase) => {
    loadLatestCompactionMock.mockResolvedValue(testCase.compaction);
    if (testCase.embeddingsConfig !== undefined) {
      fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);
    }

    let messageQuery: { text: string; values?: unknown[] } | undefined;

    const pool = makeMockPool((text, values) => {
      if (testCase.isMessageQuery(text)) {
        messageQuery = { text, values };
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, testCase.embeddingsConfig);

    expect(messageQuery).toBeDefined();
    // The compaction rows must carry the $4 bound specifically, so a clause that
    // refers to the wrong parameter fails; the no-compaction rows must carry no
    // bound at all.
    expect(messageQuery!.text.includes("m.id <=")).toBe(testCase.expectIdBound);
    expect(messageQuery!.text.includes("m.id <= $4")).toBe(testCase.expectIdBound);
    expect(messageQuery!.values?.[3]).toBe(testCase.expectedUpToMessageId);
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
