import http from "http";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  getTableSchema,
  handleTableSchemaRequest,
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

