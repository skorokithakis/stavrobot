import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createManageInterlocutorsTool } from "./interlocutors.js";

// Mock the database module so getOwnerInterlocutorId returns a stable value.
vi.mock("./database.js", () => ({
  getOwnerInterlocutorId: () => 1,
}));

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text content block");
  }
  return block.text;
}

// Build a mock Pool whose query() can be configured per test. connect() returns
// a client that delegates to the same queryImpl and has a no-op release().
function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  const client = {
    query: vi.fn().mockImplementation(queryImpl),
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    query: vi.fn().mockImplementation(queryImpl),
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

function makeEmptyPool(): Pool {
  return makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
}

// A minimal interlocutor row returned by fetchInterlocutorById for id=10.
const interlocutorRow10 = {
  id: 10,
  display_name: "Alice",
  agent_id: 3,
  owner: false,
  enabled: true,
  created_at: new Date("2024-01-01"),
  service: null,
  identifier: null,
};

// A minimal interlocutor row returned by fetchInterlocutorById for id=5.
const interlocutorRow5 = {
  id: 5,
  display_name: "Bob",
  agent_id: null,
  owner: false,
  enabled: true,
  created_at: new Date("2024-01-01"),
  service: null,
  identifier: null,
};

describe("manage_interlocutors — owner protection", () => {
  it.each([
    { description: "update", params: { action: "update", id: 1, display_name: "Hacked" } },
    { description: "delete", params: { action: "delete", id: 1 } },
    { description: "add_identity", params: { action: "add_identity", id: 1, service: "signal", identifier: "+1" } },
    { description: "remove_identity", params: { action: "remove_identity", id: 1, service: "signal", identifier: "+1" } },
  ])("refuses to $description the owner interlocutor", async ({ params }) => {
    const tool = createManageInterlocutorsTool(makeEmptyPool());
    const result = await tool.execute("call-1", params);
    expect(makeText(result)).toContain("Cannot modify the owner interlocutor");
  });
});

describe("manage_interlocutors — create", () => {
  it.each([
    { description: "implicitly enabled", params: { display_name: "Alice" } },
    { description: "explicitly enabled", params: { display_name: "Alice", enabled: true } },
  ])("returns an error when creating an $description interlocutor without agent_id", async ({ params }) => {
    const tool = createManageInterlocutorsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "create", ...params });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot create an enabled interlocutor without an agent_id");
  });

  it("creates an interlocutor without identity and returns the full record", async () => {
    // The transaction runs on the client: BEGIN, INSERT interlocutor, COMMIT.
    let clientCallCount = 0;
    const pool = makeMockPool((text: string) => {
      clientCallCount++;
      // Second call is the INSERT returning the new ID.
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1 } as unknown as QueryResult);
      }
      // The pool.query call for fetchInterlocutorById.
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ id: 42, display_name: "Alice", agent_id: 5, owner: false, enabled: true, created_at: new Date("2024-01-01"), service: null, identifier: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", agent_id: 5, instructions: "Be polite." });
    expect(makeText(result)).toContain("Alice");
    expect(result.details).toMatchObject({ id: 42, display_name: "Alice" });
  });

  it("creates an interlocutor with identity when both service and identifier are provided", async () => {
    // The transaction runs on the client: BEGIN, INSERT interlocutor, INSERT identity, COMMIT.
    let clientCallCount = 0;
    const pool = makeMockPool((text: string) => {
      clientCallCount++;
      // Second call is the INSERT interlocutor returning the new ID.
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 } as unknown as QueryResult);
      }
      // Third call is the INSERT identity — return rowCount: 1 to indicate success.
      if (clientCallCount === 3) {
        return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
      }
      // The pool.query call for fetchInterlocutorById.
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ id: 7, display_name: "Bob", agent_id: 2, owner: false, enabled: true, created_at: new Date("2024-01-01"), service: "signal", identifier: "+1234567890" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    // Must provide agent_id when creating an enabled interlocutor.
    const result = await tool.execute("call-1", {
      action: "create",
      display_name: "Bob",
      agent_id: 2,
      instructions: "Help with code.",
      service: "signal",
      identifier: "+1234567890",
    });
    expect(makeText(result)).toContain("Bob");
    expect(result.details).toMatchObject({ id: 7, display_name: "Bob" });
  });

  it("allows creating a disabled interlocutor without agent_id", async () => {
    let clientCallCount = 0;
    const pool = makeMockPool((text: string) => {
      clientCallCount++;
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ id: 42, display_name: "Alice", agent_id: null, owner: false, enabled: false, created_at: new Date("2024-01-01"), service: null, identifier: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", enabled: false });
    // The fake returns whatever state the test says, so also verify that
    // enabled: false was actually written by the INSERT.
    const poolMock = pool as unknown as { connect: ReturnType<typeof vi.fn> };
    const clientMock = await poolMock.connect() as unknown as { query: ReturnType<typeof vi.fn> };
    const insertCall = clientMock.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO interlocutors"),
    );
    expect(insertCall).toBeDefined();
    expect((insertCall as unknown[])[0]).toContain("enabled");
    expect((insertCall as unknown[])[1]).toContain(false);
    expect(result.details).toMatchObject({ id: 42, enabled: false });
  });

  it("returns an error and rolls back when the identity conflicts during create", async () => {
    // The transaction runs on the client: BEGIN, INSERT interlocutor, INSERT identity (conflict), ROLLBACK.
    let clientCallCount = 0;
    const pool = makeMockPool(() => {
      clientCallCount++;
      // Second call is the INSERT interlocutor returning the new ID.
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 } as unknown as QueryResult);
      }
      // Third call is the INSERT identity — return rowCount: 0 to simulate a conflict.
      if (clientCallCount === 3) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    // Must provide agent_id when creating an enabled interlocutor.
    const result = await tool.execute("call-1", {
      action: "create",
      display_name: "Bob",
      agent_id: 2,
      service: "signal",
      identifier: "+1234567890",
    });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("signal");
    expect(makeText(result)).toContain("+1234567890");
    expect(makeText(result)).toContain("already assigned to another interlocutor");
  });
});

describe("manage_interlocutors — update", () => {
  it.each([
    {
      description: "enabling an interlocutor that has no agent_id",
      params: { action: "update", id: 5, enabled: true },
      current: { enabled: false, agent_id: null },
    },
    {
      description: "clearing agent_id on an enabled interlocutor",
      params: { action: "update", id: 5, agent_id: 0 },
      current: { enabled: true, agent_id: 3 },
    },
  ])("returns an error when $description", async ({ params, current }) => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({ rows: [current], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", params);
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot enable an interlocutor without an agent_id");
  });

  it.each([
    {
      description: "updates enabled to false",
      params: { id: 5, enabled: false },
      record: { ...interlocutorRow5, enabled: false },
      expected: { id: 5, enabled: false },
    },
    {
      description: "updates enabled to true when the interlocutor has an agent_id",
      params: { id: 10, enabled: true },
      record: { ...interlocutorRow10, enabled: true },
      expected: { id: 10, enabled: true },
    },
    {
      description: "updates display_name",
      params: { id: 5, display_name: "Alice Updated" },
      record: { ...interlocutorRow5, display_name: "Alice Updated" },
      expected: { id: 5, display_name: "Alice Updated" },
    },
    {
      description: "updates agent_id",
      params: { id: 5, agent_id: 3 },
      record: { ...interlocutorRow5, agent_id: 3 },
      expected: { id: 5, agent_id: 3 },
    },
    {
      description: "clears agent_id when set to 0 on a disabled interlocutor",
      params: { id: 5, agent_id: 0 },
      record: { ...interlocutorRow5, agent_id: null, enabled: false },
      expected: { id: 5, agent_id: null },
    },
  ])("$description and returns the full record", async ({ params, record, expected }) => {
    const pool = makeMockPool((text: string) => {
      // The SELECT for current state returns an enabled interlocutor with an
      // agent, so the enabled/agent_id invariant passes for every row.
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({
          rows: [{ enabled: false, agent_id: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({ rows: [record], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", ...params });
    expect(result.details).toMatchObject(expected);
    expect(makeText(result)).toContain(record.display_name);
  });

  it("updates mentions_only and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, mentions_only: true }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, mentions_only: true });
    expect(result.details).toMatchObject({ id: 5, mentions_only: true });
    expect(makeText(result)).toContain("Bob");
    const queryMock = pool.query as unknown as ReturnType<typeof vi.fn>;
    const updateCall = queryMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("UPDATE interlocutors"),
    );
    expect(updateCall?.[0]).toContain("mentions_only");
    expect(updateCall?.[1]).toContain(true);
  });

  it("returns a not-found error when the id does not exist", async () => {
    const pool = makeMockPool((text: string) => {
      // The UPDATE succeeds (affects zero rows silently), and the subsequent
      // fetchInterlocutorById returns no rows because the id doesn't exist.
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 999, display_name: "Ghost" });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("999");
    expect(makeText(result)).toContain("not found");
  });
});

describe("manage_interlocutors — delete", () => {
  it("removes identities from an interlocutor and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [interlocutorRow5],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "delete", id: 5 });
    expect(result.details).toMatchObject({ id: 5 });
    expect(makeText(result)).toContain("Bob");
  });
});

describe("manage_interlocutors — add_identity", () => {
  it("adds an identity and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, service: "signal", identifier: "+1234567890" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", id: 5, service: "signal", identifier: "+1234567890" });
    expect(result.details).toMatchObject({ id: 5 });
    expect(makeText(result)).toContain("+1234567890");
  });

  it("returns an error when the identity conflicts during add_identity", async () => {
    const tool = createManageInterlocutorsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "add_identity", id: 5, service: "signal", identifier: "+1234567890" });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("signal");
    expect(makeText(result)).toContain("+1234567890");
    expect(makeText(result)).toContain("already assigned to another interlocutor");
  });
});

describe("manage_interlocutors — remove_identity", () => {
  it("removes an identity and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [interlocutorRow5],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "remove_identity", id: 5, service: "signal", identifier: "+1234567890" });
    expect(result.details).toMatchObject({ id: 5 });
    expect(makeText(result)).toContain("Bob");
  });
});

describe("manage_interlocutors — list", () => {
  it("returns TOON-encoded interlocutors with their identities", async () => {
    const rows = [
      { id: 1, display_name: "Owner", agent_id: 1, owner: true, enabled: true, mentions_only: false, created_at: new Date("2024-01-01"), service: "signal", identifier: "+1111111111" },
      { id: 2, display_name: "Alice", agent_id: 2, owner: false, enabled: true, mentions_only: true, created_at: new Date("2024-02-01"), service: "telegram", identifier: "99999" },
      { id: 2, display_name: "Alice", agent_id: 2, owner: false, enabled: true, mentions_only: true, created_at: new Date("2024-02-01"), service: "signal", identifier: "+2222222222" },
      { id: 3, display_name: "Bob", agent_id: null, owner: false, enabled: false, mentions_only: false, created_at: new Date("2024-03-01"), service: null, identifier: null },
    ];
    const pool = makeMockPool(() =>
      Promise.resolve({ rows, rowCount: rows.length } as unknown as QueryResult),
    );
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "list" });
    const text = makeText(result);

    // The output is TOON-encoded, not JSON. Verify key fields appear in the output.
    expect(text).toContain("Owner");
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    expect(text).toContain("+1111111111");
    expect(text).toContain("99999");
    expect(text).toContain("+2222222222");
    expect(text).toContain("agent_id");
    expect(text).toContain("mentions_only");
    expect(text).not.toContain("instructions");
  });
});
