import http from "http";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Config } from "./config.js";
import {
  getTableSchema,
  handleTableSchemaRequest,
  serveExplorerPage,
} from "./explorer.js";

interface MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

function makeMockResponse(): MockResponse {
  return {
    statusCode: undefined,
    headers: {},
    body: undefined,
    writeHead(status: number, headers?: Record<string, string>): void {
      this.statusCode = status;
      if (headers !== undefined) {
        Object.assign(this.headers, headers);
      }
    },
    end(body: string): void {
      this.body = body;
    },
  };
}

function makePool(responses: Array<{ rows: unknown[] }>): pg.Pool {
  let index = 0;
  return {
    query: vi.fn(async () => responses[index++]),
  } as unknown as pg.Pool;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    apiKey: "test-key",
    publicHostname: "https://example.com",
    baseSystemPrompt: "You are a bot.",
    compactionPrompt: "Compact.",
    compactionBulletPrompt: "Compact.",
    baseAgentPrompt: "You are Stavrobot.",
    owner: { name: "Owner" },
    ...overrides,
  } as Config;
}

const AGENTS_COLUMNS = [
  { column_name: "id", data_type: "integer", is_nullable: "NO", is_primary_key: true },
  { column_name: "name", data_type: "text", is_nullable: "YES", is_primary_key: false },
];

describe("getTableSchema", (): void => {
  it("marks primary key columns", async (): Promise<void> => {
    const pool = makePool([{ rows: [{ exists: 1 }] }, { rows: AGENTS_COLUMNS }]);

    const schema = await getTableSchema(pool, "agents");

    expect(schema).not.toBeNull();
    expect(schema?.columns).toEqual([
      { name: "id", type: "integer", nullable: false, primaryKey: true },
      { name: "name", type: "text", nullable: true, primaryKey: false },
    ]);
  });

  it("returns null when the table does not exist", async (): Promise<void> => {
    const pool = makePool([{ rows: [] }]);

    const schema = await getTableSchema(pool, "missing");

    expect(schema).toBeNull();
  });
});

describe("handleTableSchemaRequest", (): void => {
  it("returns the schema with primary key flags", async (): Promise<void> => {
    const pool = makePool([{ rows: [{ exists: 1 }] }, { rows: AGENTS_COLUMNS }]);
    const response = makeMockResponse();

    await handleTableSchemaRequest(response as unknown as http.ServerResponse, pool, "agents");

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({
      name: "agents",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true },
        { name: "name", type: "text", nullable: true, primaryKey: false },
      ],
    });
  });

  it("returns 404 for a missing table", async (): Promise<void> => {
    const pool = makePool([{ rows: [] }]);
    const response = makeMockResponse();

    await handleTableSchemaRequest(response as unknown as http.ServerResponse, pool, "missing");

    expect(response.statusCode).toBe(404);
  });
});

describe("serveExplorerPage", (): void => {
  it("renders the shared shell with the Database navigation active", (): void => {
    const response = makeMockResponse();

    serveExplorerPage(response as unknown as http.ServerResponse, makeConfig({ model: "claude-opus-5-5" }));

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain('href="/assets/sb.css"');
    expect(response.body).toContain('class="sb-nav-item is-active" href="/explorer"');
    expect(response.body).toContain("claude-opus-5-5");
    expect(response.body).toContain('class="sb-tabbar"');
  });

  it("renders the table picker, schema dialog and row panel regions", (): void => {
    const response = makeMockResponse();

    serveExplorerPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain('id="db-table-select"');
    expect(response.body).toContain('id="db-schema-overlay"');
    expect(response.body).toContain('id="db-picker-overlay"');
    expect(response.body).toContain('id="db-sort-overlay"');
    expect(response.body).toContain("data-open-sort");
    expect(response.body).toContain("data-sort-column");
    expect(response.body).toContain('id="db-row-panel"');
    expect(response.body).toContain("/api/explorer/tables");
    expect(response.body).toContain("primary key");
  });

  it("makes the mobile sort hint a control wired to the sort sheet", (): void => {
    const response = makeMockResponse();

    serveExplorerPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain('id="db-sort-hint" type="button" data-open-sort');
    expect(response.body).toContain("data-sort-dir");
  });
});
