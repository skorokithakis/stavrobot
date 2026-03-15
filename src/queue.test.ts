import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { AuthError } from "./auth.js";
import { AbortError } from "./errors.js";
import type { RoutingResult } from "./queue.js";

// Mock the modules that processQueue depends on so tests don't need real infrastructure.
vi.mock("./agent.js", () => ({
  handlePrompt: vi.fn(),
  formatUserMessage: vi.fn((message: string, source?: string) => `[${source ?? "cli"}] ${message}`),
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

import { handlePrompt, formatUserMessage } from "./agent.js";
import { getMainAgentId, isOwnerIdentity, resolveInterlocutor } from "./database.js";
import { isInAllowlist } from "./allowlist.js";
import { initializeQueue, enqueueMessage } from "./queue.js";

const mockHandlePrompt = vi.mocked(handlePrompt);
const mockFormatUserMessage = vi.mocked(formatUserMessage);
const mockGetMainAgentId = vi.mocked(getMainAgentId);
const mockIsOwnerIdentity = vi.mocked(isOwnerIdentity);
const mockResolveInterlocutor = vi.mocked(resolveInterlocutor);
const mockIsInAllowlist = vi.mocked(isInAllowlist);

// Minimal stubs — the queue only passes these through to handlePrompt, which is mocked.
const mockAbort = vi.fn();
const mockSteer = vi.fn();
const stubAgent = { abort: mockAbort, steer: mockSteer } as unknown as Agent;
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

describe("/stop command", () => {
  it("returns 'Aborted.' immediately when agent is idle and does not enqueue", async () => {
    const result = await enqueueMessage("/stop");

    expect(result).toBe("Aborted.");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("is case-insensitive and trims whitespace", async () => {
    const result = await enqueueMessage("  /STOP  ");

    expect(result).toBe("Aborted.");
    expect(mockHandlePrompt).not.toHaveBeenCalled();
  });

  it("calls agent.abort() and resolves cleanly when agent is processing", async () => {
    // Make handlePrompt hang until abort is called, then throw AbortError.
    mockHandlePrompt.mockImplementationOnce(
      () => new Promise<string>((_, reject) => {
        mockAbort.mockImplementationOnce(() => {
          reject(new AbortError());
        });
      }),
    );

    const promptPromise = enqueueMessage("hello");
    // Yield to let processQueue start and call handlePrompt.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopResult = await enqueueMessage("/stop");
    expect(stopResult).toBe("Aborted.");
    expect(mockAbort).toHaveBeenCalledOnce();

    const promptResult = await promptPromise;
    expect(promptResult).toBe("Aborted.");
    expect(mockHandlePrompt).toHaveBeenCalledOnce();
  });
});

describe("steering", () => {
  it("steers the running agent when the owner sends a message on an interactive source while processing an owner conversation", async () => {
    mockIsOwnerIdentity.mockReturnValue(true);
    mockHandlePrompt.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        // Resolve after a tick so the steering message arrives while processing.
        setTimeout(() => resolve("done"), 10);
      }),
    );

    // The first message must be from the owner so the current entry is an owner conversation.
    const promptPromise = enqueueMessage("first message", "signal", "+1234567890");
    // Yield to let processQueue start and call handlePrompt.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const steerResult = await enqueueMessage("steer me", "signal", "+1234567890");
    expect(steerResult).toBe("Message received, steering the current request.");
    expect(mockSteer).toHaveBeenCalledOnce();
    expect(mockFormatUserMessage).toHaveBeenCalledWith("steer me", "signal", "+1234567890");
    // The original prompt should still complete normally.
    await promptPromise;
    expect(mockHandlePrompt).toHaveBeenCalledOnce();
  });

  it("steers the running agent when the owner sends a CLI message (no source) while processing", async () => {
    mockHandlePrompt.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), 10);
      }),
    );

    // CLI message: no source, no sender — always treated as owner.
    const promptPromise = enqueueMessage("first message");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const steerResult = await enqueueMessage("steer me");
    expect(steerResult).toBe("Message received, steering the current request.");
    expect(mockSteer).toHaveBeenCalledOnce();
    expect(mockFormatUserMessage).toHaveBeenCalledWith("steer me", undefined, undefined);

    await promptPromise;
  });

  it("does not steer when the message is undefined (attachment-only)", async () => {
    mockIsOwnerIdentity.mockReturnValue(true);
    mockHandlePrompt.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), 10);
      }),
    );

    const promptPromise = enqueueMessage("first message", "signal", "+1234567890");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Attachment-only message: message is undefined.
    const attachment = { storedPath: "/tmp/stavrobot-temp/upload-abc.jpg", originalFilename: "photo.jpg", mimeType: "image/jpeg", size: 1024 };
    await enqueueMessage(undefined, "signal", "+1234567890", [attachment]);
    expect(mockSteer).not.toHaveBeenCalled();

    await promptPromise;
  });

  it("does not steer when the sender is not the owner on an interactive source", async () => {
    // mockIsOwnerIdentity returns false by default from beforeEach.
    mockIsInAllowlist.mockReturnValue(true);
    mockResolveInterlocutor.mockResolvedValue({
      interlocutorId: 42,
      identityId: 10,
      agentId: 1,
      isOwner: false,
      displayName: "Alice",
    });
    mockHandlePrompt.mockResolvedValue("done");

    const promptPromise = enqueueMessage("first message");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Non-owner message on an interactive source should queue, not steer.
    const secondPromise = enqueueMessage("hi from alice", "signal", "+9876543210");
    expect(mockSteer).not.toHaveBeenCalled();

    await promptPromise;
    await secondPromise;
  });

  it("does not steer when the agent is not processing", async () => {
    mockIsOwnerIdentity.mockReturnValue(true);

    // No active processing — message should be queued normally.
    await enqueueMessage("hello", "signal", "+1234567890");
    expect(mockSteer).not.toHaveBeenCalled();
    expect(mockHandlePrompt).toHaveBeenCalledOnce();
  });

  it("does not steer when the current entry is a non-owner conversation (subagent)", async () => {
    // isOwnerIdentity returns true only for the owner's number, not Alice's.
    mockIsOwnerIdentity.mockImplementation(
      (_source: string, sender: string) => sender === "+1111111111",
    );
    mockIsInAllowlist.mockReturnValue(true);
    mockResolveInterlocutor.mockResolvedValue({
      interlocutorId: 42,
      identityId: 10,
      agentId: 2,
      isOwner: false,
      displayName: "Alice",
    });
    mockHandlePrompt.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), 10);
      }),
    );

    // Alice's message starts processing — not the owner's conversation.
    const promptPromise = enqueueMessage("hello from alice", "signal", "+9876543210");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Owner sends a message while Alice's conversation is processing.
    // isInteractiveOwnerMessage returns true (owner on interactive source),
    // but isCurrentEntryOwnerConversation returns false (Alice's entry).
    const ownerMessage = enqueueMessage("owner message", "telegram", "+1111111111");
    expect(mockSteer).not.toHaveBeenCalled();

    await promptPromise;
    await ownerMessage;
  });
});
