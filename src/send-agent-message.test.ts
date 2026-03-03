import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createSendAgentMessageTool } from "./send-agent-message.js";

vi.mock("./database.js", () => ({
  loadAgent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn(),
}));

import { loadAgent } from "./database.js";
import { enqueueMessage } from "./queue.js";

const mockLoadAgent = vi.mocked(loadAgent);
const mockEnqueueMessage = vi.mocked(enqueueMessage);

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("send_agent_message", () => {
  it("returns error when target agent doesn't exist", async () => {
    mockLoadAgent.mockResolvedValueOnce(null);
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const getCurrentAgentId = vi.fn().mockReturnValue(1);
    const tool = createSendAgentMessageTool(pool, getCurrentAgentId);
    const result = await tool.execute("call-1", { agent_id: 99, message: "hello" });
    expect(makeText(result)).toContain("agent 99 not found");
  });

  it("sends a message and returns confirmation", async () => {
    mockLoadAgent.mockResolvedValueOnce({
      id: 2,
      name: "helper",
      systemPrompt: "Help users.",
      allowedTools: [],
      createdAt: new Date("2024-01-01"),
    });
    mockEnqueueMessage.mockResolvedValueOnce("");
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const getCurrentAgentId = vi.fn().mockReturnValue(1);
    const tool = createSendAgentMessageTool(pool, getCurrentAgentId);
    const result = await tool.execute("call-1", { agent_id: 2, message: "hello" });
    expect(makeText(result)).toBe("Message sent to agent 2.");
  });

  it("calls enqueueMessage with correct parameters", async () => {
    mockLoadAgent.mockResolvedValueOnce({
      id: 2,
      name: "helper",
      systemPrompt: "Help users.",
      allowedTools: [],
      createdAt: new Date("2024-01-01"),
    });
    mockEnqueueMessage.mockResolvedValueOnce("");
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const getCurrentAgentId = vi.fn().mockReturnValue(3);
    const tool = createSendAgentMessageTool(pool, getCurrentAgentId);
    await tool.execute("call-1", { agent_id: 2, message: "task for you" });
    expect(mockEnqueueMessage).toHaveBeenCalledWith("task for you", "agent", "3", undefined, 2);
  });

  it("uses the getCurrentAgentId callback to determine the sender", async () => {
    mockLoadAgent.mockResolvedValueOnce({
      id: 5,
      name: "worker",
      systemPrompt: "Do work.",
      allowedTools: [],
      createdAt: new Date("2024-01-01"),
    });
    mockEnqueueMessage.mockResolvedValueOnce("");
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const getCurrentAgentId = vi.fn().mockReturnValue(7);
    const tool = createSendAgentMessageTool(pool, getCurrentAgentId);
    await tool.execute("call-1", { agent_id: 5, message: "ping" });
    expect(getCurrentAgentId).toHaveBeenCalled();
    expect(mockEnqueueMessage).toHaveBeenCalledWith("ping", "agent", "7", undefined, 5);
  });
});
