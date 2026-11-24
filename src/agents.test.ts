import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createManageAgentsTool } from "./agents.js";

vi.mock("./database.js", () => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  getMainAgentId: vi.fn().mockReturnValue(1),
}));

import { createAgent, updateAgent } from "./database.js";

const mockCreateAgent = vi.mocked(createAgent);
const mockUpdateAgent = vi.mocked(updateAgent);

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text content block");
  }
  return block.text;
}

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

describe("manage_agents — create", () => {
  it("creates an agent and returns the new ID", async () => {
    mockCreateAgent.mockResolvedValueOnce(5);
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help users.", allowed_tools: ["send_telegram_message"] });
    expect(makeText(result)).toBe("Agent 5 created.");
  });

  it("defaults allowed_tools to [] when not provided", async () => {
    mockCreateAgent.mockResolvedValueOnce(7);
    const pool = makeEmptyPool();
    const tool = createManageAgentsTool(pool);
    await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help users." });
    expect(mockCreateAgent).toHaveBeenCalledWith(pool, "helper", "Help users.", [], []);
  });

  it.each([
    {
      description: "tool names that are not allowlisted",
      params: { allowed_tools: ["execute_sql", "manage_interlocutors"] },
      error: "invalid allowed_tools entries",
      entries: ["execute_sql", "manage_interlocutors"],
    },
    {
      description: "dot-notation entries for non-allowlisted tools",
      params: { allowed_tools: ["manage_interlocutors.list"] },
      error: "invalid allowed_tools entries",
      entries: ["manage_interlocutors.list"],
    },
    {
      description: "malformed allowed_plugins entries",
      params: { allowed_plugins: [".bad", "ok", "also..bad"] },
      error: "invalid allowed_plugins entries",
      entries: [".bad", "also..bad"],
    },
  ])("rejects $description on create", async ({ params, error, entries }) => {
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help.", ...params });
    const text = makeText(result);
    expect(text).toContain(error);
    for (const entry of entries) {
      expect(text).toContain(entry);
    }
  });

  it.each([
    {
      description: "dot-notation entries for allowlisted tools",
      params: { allowed_tools: ["manage_uploads.read"] },
      newId: 8,
    },
    {
      description: "valid allowed_plugins entries",
      params: { allowed_plugins: ["*", "weather", "weather.get_forecast"] },
      newId: 9,
    },
  ])("accepts $description on create", async ({ params, newId }) => {
    mockCreateAgent.mockResolvedValueOnce(newId);
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help.", ...params });
    expect(makeText(result)).toBe(`Agent ${newId} created.`);
  });
});

describe("manage_agents — update", () => {
  it("returns error when trying to update agent 1", async () => {
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "update", id: 1, name: "hacked" });
    expect(makeText(result)).toContain("Cannot modify agent 1");
  });

  it.each([
    { description: "updates an agent by name", params: { name: "updated name" } },
    {
      description: "accepts valid allowed_tools and allowed_plugins",
      params: { allowed_tools: ["run_python"], allowed_plugins: ["weather.get_forecast"] },
    },
  ])("$description and returns confirmation", async ({ params }) => {
    mockUpdateAgent.mockResolvedValueOnce(undefined);
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "update", id: 3, ...params });
    expect(makeText(result)).toBe("Agent 3 updated.");
  });

  it.each([
    {
      description: "tool names that are not allowlisted in allowed_tools",
      params: { allowed_tools: ["execute_sql"] },
      error: "invalid allowed_tools entries",
      entries: ["execute_sql"],
    },
    {
      description: "malformed allowed_plugins entries",
      params: { allowed_plugins: ["trailing."] },
      error: "invalid allowed_plugins entries",
      entries: ["trailing."],
    },
  ])("rejects $description on update", async ({ params, error, entries }) => {
    const tool = createManageAgentsTool(makeEmptyPool());
    const result = await tool.execute("call-1", { action: "update", id: 3, ...params });
    const text = makeText(result);
    expect(text).toContain(error);
    for (const entry of entries) {
      expect(text).toContain(entry);
    }
  });
});
