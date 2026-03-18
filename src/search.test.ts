import { describe, it, expect, vi } from "vitest";
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
}));
vi.mock("./toon.js", () => ({
  encodeToToon: vi.fn().mockReturnValue(""),
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchEmbeddings } from "./embeddings.js";
import { runSearch } from "./search.js";
import type { EmbeddingsConfig } from "./config.js";

const fetchEmbeddingsMock = vi.mocked(fetchEmbeddings);

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

// Returns an empty result for all queries (no matches).
function emptyPool(): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
  );
}

const embeddingsConfig: EmbeddingsConfig = { apiKey: "test-key" };

describe("runSearch — queryEmbedding in SearchResults", () => {
  it("populates queryEmbedding when embeddings are configured and the API call succeeds", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toEqual(embedding);
  });

  it("leaves queryEmbedding undefined when embeddings are not configured", async () => {
    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, undefined);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("leaves queryEmbedding undefined when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("still returns search results even when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.tableResults).toEqual([]);
    expect(results.messages).toEqual([]);
  });
});
