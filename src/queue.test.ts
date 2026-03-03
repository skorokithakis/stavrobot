import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { AuthError } from "./auth.js";
import type { RoutingResult } from "./queue.js";

// Mock the modules that processQueue depends on so tests don't need real infrastructure.
vi.mock("./agent.js", () => ({
  handlePrompt: vi.fn(),
}));
vi.mock("./signal.js", () => ({
  sendSignalMessage: vi.fn(),
}));
vi.mock("./telegram-api.js", () => ({
  sendTelegramMessage: vi.fn(),
}));
vi.mock("./database.js", () => ({
  getOwnerInterlocutorId: vi.fn().mockReturnValue(1),
  getMainAgentId: vi.fn().mockReturnValue(1),
  isOwnerIdentity: vi.fn().mockReturnValue(false),
  resolveInterlocutor: vi.fn(),
  loadAgent: vi.fn().mockResolvedValue(null),
}));
vi.mock("./allowlist.js", () => ({
  isInAllowlist: vi.fn().mockReturnValue(false),
}));

import { handlePrompt } from "./agent.js";
import { getMainAgentId, isOwnerIdentity, resolveInterlocutor } from "./database.js";
import { isInAllowlist } from "./allowlist.js";
import { initializeQueue, enqueueMessage } from "./queue.js";

const mockHandlePrompt = vi.mocked(handlePrompt);
const mockGetMainAgentId = vi.mocked(getMainAgentId);
const mockIsOwnerIdentity = vi.mocked(isOwnerIdentity);
const mockResolveInterlocutor = vi.mocked(resolveInterlocutor);
const mockIsInAllowlist = vi.mocked(isInAllowlist);

// Minimal stubs — the queue only passes these through to handlePrompt, which is mocked.
const stubAgent = {} as unknown as Agent;
const stubPool = {} as unknown as pg.Pool;
const stubConfig = { publicHostname: "http://localhost" } as unknown as Config;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMainAgentId.mockReturnValue(1);
  mockIsOwnerIdentity.mockReturnValue(false);
  mockIsInAllowlist.mockReturnValue(false);
  mockHandlePrompt.mockResolvedValue("");
  initializeQueue(stubAgent, stubPool, stubConfig);
});

describe("processQueue non-retryable 400 error handling", () => {
  it("resolves with a user-facing message immediately when the error contains '400 {'", async () => {
    mockHandlePrompt.mockRejectedValueOnce(
      new Error('Agent error: "400 {"type":"error","error":{"type":"invalid_request_error","message":"orphaned tool_result"}}"'),
    );

    const result = await enqueueMessage("hello");

    expect(result).toBe("Something went wrong processing your message. Please try again.");
    // handlePrompt was called exactly once — no retry.
    expect(mockHandlePrompt).toHaveBeenCalledTimes(1);
  });

  it("retries when the error does not contain '400 {'", async () => {
    // Fail twice with a 500-style error, then succeed.
    mockHandlePrompt
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce("ok");

    // Override the sleep delay to zero so the test doesn't take 60 s.
    vi.useFakeTimers();
    const resultPromise = enqueueMessage("hello");
    // Advance past both retry delays.
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const result = await resultPromise;
    expect(result).toBe("ok");
    expect(mockHandlePrompt).toHaveBeenCalledTimes(3);
  });

  it("resolves with the auth message and does not retry on AuthError", async () => {
    mockHandlePrompt.mockRejectedValueOnce(new AuthError("token expired"));

    const result = await enqueueMessage("hello");

    expect(result).toContain("Authentication required");
    expect(mockHandlePrompt).toHaveBeenCalledTimes(1);
  });
});

describe("message routing", () => {
  it("routes CLI messages (no source) to the owner conversation", async () => {
    await enqueueMessage("hello");

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.agentId).toBe(1);
    expect(routingArg.senderLabel).toBe("owner");
    // resolveInterlocutor should not be called for CLI messages.
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes cron messages to the owner conversation", async () => {
    await enqueueMessage("reminder", "cron", undefined);

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.senderLabel).toBe("cron");
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes coder messages to the owner conversation", async () => {
    await enqueueMessage("task done", "coder", undefined);

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.senderLabel).toBe("coder");
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes upload messages to the owner conversation", async () => {
    const attachment = { storedPath: "/tmp/upload-abc.jpg", originalFilename: "photo.jpg", mimeType: "image/jpeg", size: 1024 };
    await enqueueMessage(undefined, "upload", undefined, [attachment]);

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.agentId).toBe(1);
    expect(routingArg.senderLabel).toBe("upload");
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes plugin:* messages to the owner conversation", async () => {
    await enqueueMessage("result", "plugin:myplugin", undefined);

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.senderLabel).toBe("plugin:myplugin");
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes owner identity messages to the owner conversation without a DB lookup", async () => {
    mockIsOwnerIdentity.mockReturnValue(true);

    await enqueueMessage("hello", "signal", "+1234567890");

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.senderLabel).toBe("owner");
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("resolves non-owner messages via the interlocutor_identities table", async () => {
    mockIsInAllowlist.mockReturnValue(true);
    mockResolveInterlocutor.mockResolvedValue({
      interlocutorId: 42,
      identityId: 10,
      agentId: 5,
      isOwner: false,
      displayName: "Alice",
    });

    await enqueueMessage("hi", "signal", "+9876543210");

    expect(mockResolveInterlocutor).toHaveBeenCalledWith(stubPool, "signal", "+9876543210");
    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.agentId).toBe(5);
    expect(routingArg.isMainAgent).toBe(false);
    expect(routingArg.senderLabel).toBe("Alice");
    expect(routingArg.senderIdentityId).toBe(10);
  });

  it("drops messages from senders not in the allowlist", async () => {
    // isInAllowlist already returns false from beforeEach.
    const result = await enqueueMessage("hi", "signal", "+0000000000");

    expect(result).toBe("");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
    // The message must be dropped before the DB lookup.
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("drops messages from unknown interlocutors and resolves with empty string", async () => {
    mockIsInAllowlist.mockReturnValue(true);
    mockResolveInterlocutor.mockResolvedValue(null);

    const result = await enqueueMessage("hi", "signal", "+0000000000");

    expect(result).toBe("");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
  });

  it("drops a non-internal message that has a source but no sender", async () => {
    const result = await enqueueMessage("hi", "signal", undefined);

    expect(result).toBe("");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("drops a message that has a sender but no source", async () => {
    const result = await enqueueMessage("hi", undefined, "+1234567890");

    expect(result).toBe("");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes non-gated external sources to the main agent without allowlist or interlocutor checks", async () => {
    // isInAllowlist returns false from beforeEach, but pendant should bypass it.
    await enqueueMessage("hello", "pendant", "device-123");

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.isMainAgent).toBe(true);
    expect(routingArg.agentId).toBe(1);
    expect(routingArg.senderLabel).toBe("pendant");
    expect(mockIsInAllowlist).not.toHaveBeenCalled();
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("routes agent-to-agent messages to the target agent", async () => {
    mockResolveInterlocutor.mockResolvedValue(null);

    await enqueueMessage("hello from agent 1", "agent", "1", undefined, 2);

    expect(mockHandlePrompt).toHaveBeenCalledOnce();
    const routingArg = mockHandlePrompt.mock.calls[0][4] as RoutingResult;
    expect(routingArg.agentId).toBe(2);
    expect(routingArg.isMainAgent).toBe(false);
    expect(routingArg.senderAgentId).toBe(1);
    // resolveInterlocutor should not be called for agent-to-agent messages.
    expect(mockResolveInterlocutor).not.toHaveBeenCalled();
  });

  it("drops agent-to-agent messages when targetAgentId is not set", async () => {
    const result = await enqueueMessage("hello", "agent", "1");

    expect(result).toBe("");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
  });
});
