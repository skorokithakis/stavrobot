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

describe("manage_interlocutors — help", () => {
  it("returns documentation text", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "help" });
    const text = makeText(result);
    expect(text).toContain("create");
    expect(text).toContain("update");
    expect(text).toContain("delete");
    expect(text).toContain("add_identity");
    expect(text).toContain("remove_identity");
    expect(text).toContain("list");
    expect(text).toContain("agent_id");
    expect(text).toContain("subagent");
  });

  it("documents the enabled parameter for create", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "help" });
    const text = makeText(result);
    // The create section should mention enabled as an optional parameter.
    expect(text).toContain("enabled");
  });
});

describe("manage_interlocutors — create", () => {
  it("returns an error when display_name is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", instructions: "some instructions" });
    expect(makeText(result)).toContain("display_name is required");
  });

  it("creates an interlocutor with agent_id and returns the full record", async () => {
    let clientCallCount = 0;
    const pool = makeMockPool((text: string) => {
      clientCallCount++;
      // Second client call is the INSERT returning the new ID.
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 } as unknown as QueryResult);
      }
      // The pool.query call for fetchInterlocutorById (SELECT with WHERE i.id = $1).
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({ rows: [interlocutorRow10], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", agent_id: 3 });
    const text = makeText(result);
    // The result should be TOON-encoded and contain the interlocutor's display_name.
    expect(text).toContain("Alice");
    expect(result.details).toMatchObject({ id: 10, display_name: "Alice" });
  });

  it("returns an error when only service is provided without identifier", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", instructions: "hi", service: "signal" });
    expect(makeText(result)).toContain("service and identifier must both be provided or both absent");
  });

  it("returns an error when only identifier is provided without service", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", instructions: "hi", identifier: "+1234567890" });
    expect(makeText(result)).toContain("service and identifier must both be provided or both absent");
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
    // Must provide agent_id when creating an enabled interlocutor.
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", agent_id: 5, instructions: "Be polite." });
    const text = makeText(result);
    expect(text).toContain("Alice");
    expect(result.details).toMatchObject({ id: 42, display_name: "Alice" });
  });

  it("returns an error when creating an enabled interlocutor without agent_id", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice" });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot create an enabled interlocutor without an agent_id");
  });

  it("returns an error when creating an explicitly enabled interlocutor without agent_id", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Alice", enabled: true });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot create an enabled interlocutor without an agent_id");
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
    expect(result.details).toMatchObject({ id: 42, enabled: false });
  });

  it("creates an interlocutor with enabled: false and the record reflects disabled state", async () => {
    let clientCallCount = 0;
    const pool = makeMockPool((text: string) => {
      clientCallCount++;
      // Second call is the INSERT returning the new ID.
      if (clientCallCount === 2) {
        return Promise.resolve({ rows: [{ id: 20 }], rowCount: 1 } as unknown as QueryResult);
      }
      // The pool.query call for fetchInterlocutorById — returns enabled: false.
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ id: 20, display_name: "Charlie", agent_id: null, owner: false, enabled: false, created_at: new Date("2024-01-01"), service: null, identifier: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "create", display_name: "Charlie", enabled: false });
    // Verify the INSERT included the enabled column.
    const poolMock = pool as unknown as { connect: ReturnType<typeof vi.fn> };
    const clientMock = await poolMock.connect() as unknown as { query: ReturnType<typeof vi.fn> };
    const insertCall = clientMock.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO interlocutors"),
    );
    expect(insertCall).toBeDefined();
    expect((insertCall as unknown[])[0]).toContain("enabled");
    expect((insertCall as unknown[])[1]).toContain(false);
    // The returned record should show enabled: false.
    expect(result.details).toMatchObject({ id: 20, enabled: false });
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
    const text = makeText(result);
    expect(text).toContain("Bob");
    expect(result.details).toMatchObject({ id: 7, display_name: "Bob" });
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
  it("returns an error when id is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", display_name: "New Name" });
    expect(makeText(result)).toContain("id is required");
  });

  it("refuses to update the owner interlocutor", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 1, display_name: "Hacked" });
    expect(makeText(result)).toContain("Cannot modify the owner interlocutor");
  });

  it("returns an error when no fields are provided", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5 });
    expect(makeText(result)).toContain("no fields to update");
    expect(makeText(result)).toContain("enabled");
  });

  it("updates enabled to false and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, enabled: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, enabled: false });
    expect(result.details).toMatchObject({ id: 5, enabled: false });
    expect(makeText(result)).toContain("Bob");
  });

  it("returns an error when enabling an interlocutor that has no agent_id", async () => {
    const pool = makeMockPool((text: string) => {
      // The SELECT for current state returns agent_id: null, enabled: false.
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({
          rows: [{ enabled: false, agent_id: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, enabled: true });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot enable an interlocutor without an agent_id");
  });

  it("returns an error when clearing agent_id on an enabled interlocutor", async () => {
    const pool = makeMockPool((text: string) => {
      // The SELECT for current state returns agent_id: 3, enabled: true.
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({
          rows: [{ enabled: true, agent_id: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    // Clearing agent_id (sentinel 0) on an enabled interlocutor should be rejected.
    const result = await tool.execute("call-1", { action: "update", id: 5, agent_id: 0 });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("cannot enable an interlocutor without an agent_id");
  });

  it("updates enabled to true when the interlocutor has an agent_id", async () => {
    const pool = makeMockPool((text: string) => {
      // The SELECT for current state returns agent_id: 3, enabled: false.
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({
          rows: [{ enabled: false, agent_id: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow10, enabled: true }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 10, enabled: true });
    expect(result.details).toMatchObject({ id: 10, enabled: true });
  });

  it("updates display_name and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, display_name: "Alice Updated" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, display_name: "Alice Updated" });
    expect(result.details).toMatchObject({ id: 5, display_name: "Alice Updated" });
    expect(makeText(result)).toContain("Alice Updated");
  });

  it("updates agent_id and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, agent_id: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, agent_id: 3 });
    expect(result.details).toMatchObject({ id: 5, agent_id: 3 });
  });

  it("clears agent_id when set to 0 on a disabled interlocutor and returns the full record", async () => {
    const pool = makeMockPool((text: string) => {
      // The SELECT for current state returns agent_id: 3, enabled: false.
      if (text.includes("SELECT enabled, agent_id")) {
        return Promise.resolve({
          rows: [{ enabled: false, agent_id: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("WHERE i.id")) {
        return Promise.resolve({
          rows: [{ ...interlocutorRow5, agent_id: null, enabled: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 5, agent_id: 0 });
    expect(result.details).toMatchObject({ id: 5, agent_id: null });
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
  it("returns an error when id is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "delete" });
    expect(makeText(result)).toContain("id is required");
  });

  it("refuses to delete the owner interlocutor", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "delete", id: 1 });
    expect(makeText(result)).toContain("Cannot modify the owner interlocutor");
  });

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
  it("returns an error when id is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", service: "signal", identifier: "+1" });
    expect(makeText(result)).toContain("id is required");
  });

  it("refuses to add identity to the owner interlocutor", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", id: 1, service: "signal", identifier: "+1" });
    expect(makeText(result)).toContain("Cannot modify the owner interlocutor");
  });

  it("returns an error when service is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", id: 5, identifier: "+1" });
    expect(makeText(result)).toContain("service is required");
  });

  it("returns an error when identifier is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", id: 5, service: "signal" });
    expect(makeText(result)).toContain("identifier is required");
  });

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
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "add_identity", id: 5, service: "signal", identifier: "+1234567890" });
    expect(makeText(result)).toContain("Error:");
    expect(makeText(result)).toContain("signal");
    expect(makeText(result)).toContain("+1234567890");
    expect(makeText(result)).toContain("already assigned to another interlocutor");
  });
});

describe("manage_interlocutors — remove_identity", () => {
  it("returns an error when id is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "remove_identity", service: "signal", identifier: "+1" });
    expect(makeText(result)).toContain("id is required");
  });

  it("refuses to remove identity from the owner interlocutor", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "remove_identity", id: 1, service: "signal", identifier: "+1" });
    expect(makeText(result)).toContain("Cannot modify the owner interlocutor");
  });

  it("returns an error when service is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "remove_identity", id: 5, identifier: "+1" });
    expect(makeText(result)).toContain("service is required");
  });

  it("returns an error when identifier is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "remove_identity", id: 5, service: "signal" });
    expect(makeText(result)).toContain("identifier is required");
  });

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
      { id: 1, display_name: "Owner", agent_id: 1, owner: true, enabled: true, created_at: new Date("2024-01-01"), service: "signal", identifier: "+1111111111" },
      { id: 2, display_name: "Alice", agent_id: 2, owner: false, enabled: true, created_at: new Date("2024-02-01"), service: "telegram", identifier: "99999" },
      { id: 2, display_name: "Alice", agent_id: 2, owner: false, enabled: true, created_at: new Date("2024-02-01"), service: "signal", identifier: "+2222222222" },
      { id: 3, display_name: "Bob", agent_id: null, owner: false, enabled: false, created_at: new Date("2024-03-01"), service: null, identifier: null },
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
    expect(text).not.toContain("instructions");
  });
});

describe("manage_interlocutors — unknown action", () => {
  it("returns an error for an unknown action", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageInterlocutorsTool(pool);
    const result = await tool.execute("call-1", { action: "frobnicate" });
    expect(makeText(result)).toContain("unknown action");
    expect(makeText(result)).toContain("frobnicate");
  });
});
