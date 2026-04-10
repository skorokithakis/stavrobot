import { describe, it, expect, vi, type MockedFunction, beforeEach } from "vitest";
import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import type { Pool } from "pg";
import { serializeMessagesForSummary, filterToolsForSubagent, formatPluginListSection, truncateContext, createManageKnowledgeTool, injectAutoSearchBlock, pendingAutoSearchBlocks, handlePrompt, createAgent, escalatingSummarize, selectCompactionCutIndex, isTurnBoundary } from "./agent/index.js";
import { getApiKey } from "./auth.js";
import { loadMessages, loadAllMemories, loadAllScratchpadTitles, getMainAgentId, saveMessage } from "./database.js";
import { runSearch } from "./search.js";
import { internalFetch } from "./internal-fetch.js";

// Mock all heavy dependencies so the module loads without real infrastructure.
vi.mock("./database.js", () => ({
  executeSql: vi.fn(),
  loadMessages: vi.fn(),
  saveMessage: vi.fn(),
  saveCompaction: vi.fn(),
  loadLatestCompaction: vi.fn(),
  loadAllMemories: vi.fn(),
  upsertMemory: vi.fn(),
  deleteMemory: vi.fn(),
  upsertScratchpad: vi.fn(),
  deleteScratchpad: vi.fn(),
  readScratchpad: vi.fn(),
  createCronEntry: vi.fn(),
  updateCronEntry: vi.fn(),
  deleteCronEntry: vi.fn(),
  listCronEntries: vi.fn(),
  loadAllScratchpadTitles: vi.fn(),
  resolveRecipient: vi.fn(),
  resolveInterlocutorByName: vi.fn(),
  getMainAgentId: vi.fn(),
  loadAgent: vi.fn(),
}));
vi.mock("./config.js", () => ({
  loadPostgresConfig: vi.fn().mockReturnValue({}),
  OWNER_CHANNELS: [],
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./allowlist.js", () => ({ isInAllowlist: vi.fn() }));
vi.mock("./uploads.js", () => ({}));
vi.mock("./auth.js", () => ({ getApiKey: vi.fn() }));
vi.mock("./queue.js", () => ({}));
vi.mock("./scheduler.js", () => ({ reloadScheduler: vi.fn() }));
vi.mock("./plugin-tools.js", () => ({
  createManagePluginsTool: vi.fn().mockReturnValue(makeMinimalTool("manage_plugins")),
  createRunPluginToolTool: vi.fn().mockReturnValue(makeMinimalTool("run_plugin_tool")),
  createRequestCodingTaskTool: vi.fn().mockReturnValue(makeMinimalTool("request_coding_task")),
}));
vi.mock("./python.js", () => ({ createRunPythonTool: vi.fn().mockReturnValue(makeMinimalTool("run_python")) }));
vi.mock("./pages.js", () => ({ createManagePagesTool: vi.fn().mockReturnValue(makeMinimalTool("manage_pages")) }));
vi.mock("./files.js", () => ({ createManageFilesTool: vi.fn().mockReturnValue(makeMinimalTool("manage_files")) }));
vi.mock("./interlocutors.js", () => ({ createManageInterlocutorsTool: vi.fn().mockReturnValue(makeMinimalTool("manage_interlocutors")) }));
vi.mock("./agents.js", () => ({ createManageAgentsTool: vi.fn().mockReturnValue(makeMinimalTool("manage_agents")) }));
vi.mock("./send-agent-message.js", () => ({ createSendAgentMessageTool: vi.fn().mockReturnValue(makeMinimalTool("send_agent_message")) }));
vi.mock("./search.js", () => ({ createSearchTool: vi.fn().mockReturnValue(makeMinimalTool("search")), runSearch: vi.fn() }));
vi.mock("./upload-tools.js", () => ({ createManageUploadsTool: vi.fn().mockReturnValue(makeMinimalTool("manage_uploads")) }));
vi.mock("./telegram.js", () => ({ convertMarkdownToTelegramHtml: vi.fn() }));
vi.mock("./toon.js", () => ({ encodeToToon: vi.fn() }));
vi.mock("./signal.js", () => ({ sendSignalMessage: vi.fn() }));
vi.mock("./telegram-api.js", () => ({ sendTelegramMessage: vi.fn() }));
vi.mock("./internal-fetch.js", () => ({ internalFetch: vi.fn() }));
vi.mock("./whatsapp-api.js", () => ({
  getWhatsappSocket: vi.fn(),
  e164ToJid: vi.fn(),
  sendWhatsappTextMessage: vi.fn(),
}));
vi.mock("./email-api.js", () => ({ sendEmail: vi.fn() }));
vi.mock("./temp-dir.js", () => ({ TEMP_ATTACHMENTS_DIR: "/tmp/attachments" }));
vi.mock("./errors.js", () => ({ AbortError: class AbortError extends Error {} }));
vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Object: vi.fn().mockReturnValue({}),
    String: vi.fn().mockReturnValue({}),
    Optional: vi.fn().mockReturnValue({}),
    Union: vi.fn().mockReturnValue({}),
    Literal: vi.fn().mockReturnValue({}),
    Number: vi.fn().mockReturnValue({}),
    Boolean: vi.fn().mockReturnValue({}),
    Array: vi.fn().mockReturnValue({}),
    Record: vi.fn().mockReturnValue({}),
  },
  getModel: vi.fn().mockReturnValue({ contextWindow: 200000 }),
  complete: vi.fn(),
}));
// makeMinimalTool is hoisted so it can be used in vi.mock factories below.
// Tool factory mocks need to return a valid AgentTool so createAgent can call
// wrapToolWithLogging on each tool without crashing.
const { makeMinimalTool } = vi.hoisted(() => {
  function makeMinimalTool(name: string): { name: string; label: string; description: string; parameters: Record<string, never>; execute: () => Promise<never> } {
    return {
      name,
      label: name,
      description: `Mock ${name}`,
      parameters: {},
      execute: async () => { throw new Error(`${name} not implemented in tests`); },
    };
  }
  return { makeMinimalTool };
});

// FakeAgent is hoisted so it can be referenced in the vi.mock factory below.
// It captures the transformContext callback from createAgent and calls it when
// prompt() is invoked, allowing integration tests to observe what context the
// agent would send to the LLM without needing a real LLM connection.
const { FakeAgent } = vi.hoisted(() => {
  class FakeAgent {
    private transformContextFn?: (messages: unknown[]) => Promise<unknown[]>;
    public capturedContextMessages: unknown[] | undefined;
    public messages: unknown[] = [];
    public error: unknown = undefined;
    public tools: unknown[] = [];
    // Set this before calling prompt() to make it throw.
    public promptError: Error | undefined = undefined;
    // Steered messages to emit as message_end events during prompt().
    public steeringMessages: unknown[] = [];
    private listeners: Array<(e: unknown) => void> = [];

    constructor(opts?: { transformContext?: (messages: unknown[]) => Promise<unknown[]> }) {
      this.transformContextFn = opts?.transformContext;
    }

    get state(): { tools: unknown[]; messages: unknown[]; error: unknown } {
      return { tools: this.tools, messages: this.messages, error: this.error };
    }

    replaceMessages(ms: unknown[]): void {
      this.messages = ms;
    }

    setSystemPrompt(_v: string): void {}

    setTools(t: unknown[]): void {
      this.tools = t;
    }

    subscribe(fn: (e: unknown) => void): () => void {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      };
    }

    emit(event: unknown): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    appendMessage(_m: unknown): void {}

    async prompt(message: unknown): Promise<void> {
      if (this.promptError !== undefined) {
        throw this.promptError;
      }
      if (this.transformContextFn !== undefined) {
        // Mirror the real Agent: append the incoming user message to the stored
        // messages before invoking transformContext, so the callback sees the
        // full context (history + new prompt) exactly as the real agent does.
        const userMessage = typeof message === "string"
          ? { role: "user", content: message, timestamp: Date.now() }
          : message;
        this.capturedContextMessages = await this.transformContextFn([...this.messages, userMessage]);
      }
      // Fire message_end for the initial prompt message (mirrors the real agent-loop).
      const promptMessage = typeof message === "string"
        ? { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }
        : message;
      this.emit({ type: "message_end", message: promptMessage });
      // Fire message_end for any queued steered messages.
      for (const steered of this.steeringMessages) {
        this.emit({ type: "message_end", message: steered });
      }
      this.steeringMessages = [];
    }
  }

  return { FakeAgent };
});

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: FakeAgent,
}));

// Helper to build a minimal assistant message without filling in all required
// fields that the serializer never reads (api, provider, model, usage).
function assistantMessage(content: AgentMessage["content"]): AgentMessage {
  return { role: "assistant", content, stopReason: "stop" } as unknown as AgentMessage;
}

// Helper to build a minimal tool result message.
function toolResultMessage(toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("serializeMessagesForSummary", () => {
  it("serializes a plain user message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello there", timestamp: 0 },
    ];
    expect(serializeMessagesForSummary(messages)).toBe("User: Hello there");
  });

  it("serializes an assistant text-only message", () => {
    const messages: AgentMessage[] = [
      assistantMessage([{ type: "text", text: "Hi!" }]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe("Assistant: Hi!");
  });

  it("serializes a tool call with string arguments", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc1",
          name: "send_signal_message",
          arguments: { recipient: "+1234567890", message: "Hello!" },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      `Assistant called send_signal_message(recipient="+1234567890", message="Hello!")`,
    );
  });

  it("serializes a tool call with number and boolean arguments without quotes", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc2",
          name: "some_tool",
          arguments: { count: 42, enabled: true, disabled: false },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Assistant called some_tool(count=42, enabled=true, disabled=false)",
    );
  });

  it("serializes a tool call with null argument without quotes", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc3",
          name: "some_tool",
          arguments: { value: null },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Assistant called some_tool(value=null)",
    );
  });

  it("serializes a tool call with an object argument using JSON.stringify", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc4",
          name: "execute_sql",
          arguments: { query: "SELECT 1", options: { timeout: 5000 } },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      `Assistant called execute_sql(query="SELECT 1", options={"timeout":5000})`,
    );
  });

  it("emits tool call lines after the assistant text line when both are present", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        { type: "text", text: "Sending now." },
        {
          type: "toolCall",
          id: "tc5",
          name: "send_signal_message",
          arguments: { recipient: "+1", message: "Hi" },
        },
      ]),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      `Assistant: Sending now.\nAssistant called send_signal_message(recipient="+1", message="Hi")`,
    );
  });

  it("emits one line per tool call when multiple tool calls are present", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc6",
          name: "tool_a",
          arguments: { x: "foo" },
        },
        {
          type: "toolCall",
          id: "tc7",
          name: "tool_b",
          arguments: { y: 1 },
        },
      ]),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      `Assistant called tool_a(x="foo")\nAssistant called tool_b(y=1)`,
    );
  });

  it("serializes a tool result message", () => {
    const messages: AgentMessage[] = [
      toolResultMessage("execute_sql", "1 row returned"),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Tool result (execute_sql): 1 row returned",
    );
  });

  it("handles a full conversation with user, assistant text+tool, and tool result", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Send a message to Alice", timestamp: 0 },
      assistantMessage([
        { type: "text", text: "Sure, sending now." },
        {
          type: "toolCall",
          id: "tc1",
          name: "send_signal_message",
          arguments: { recipient: "+1", message: "Hey Alice!" },
        },
      ]),
      toolResultMessage("send_signal_message", "Message sent successfully."),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      [
        "User: Send a message to Alice",
        "Assistant: Sure, sending now.",
        `Assistant called send_signal_message(recipient="+1", message="Hey Alice!")`,
        "Tool result (send_signal_message): Message sent successfully.",
      ].join("\n"),
    );
  });
});

// Minimal AgentTool factory for testing filterToolsForSubagent.
function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: {} as AgentTool["parameters"],
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
  };
}

describe("filterToolsForSubagent", () => {
  it("excludes tools not in the allowed list", () => {
    const tools = [makeTool("execute_sql"), makeTool("manage_cron"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, ["execute_sql"], []);
    expect(result.map((t) => t.name)).toEqual(["execute_sql", "send_agent_message"]);
  });

  it("always includes send_agent_message even when not listed", () => {
    const tools = [makeTool("execute_sql"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, ["execute_sql"], []);
    expect(result.map((t) => t.name)).toContain("send_agent_message");
  });

  it("includes send_agent_message only once when explicitly listed", () => {
    const tools = [makeTool("execute_sql"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, ["execute_sql", "send_agent_message"], []);
    const names = result.map((t) => t.name);
    expect(names.filter((n) => n === "send_agent_message")).toHaveLength(1);
  });

  it("includes a tool as-is when a bare name is given", async () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors"], []);
    expect(result[0]).toBe(tool);
  });

  it("wraps execute for dotted entries and allows the listed action", async () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors.list"], []);
    const wrapped = result.find((t) => t.name === "manage_interlocutors");
    expect(wrapped).toBeDefined();
    // The wrapped tool should not be the original object.
    expect(wrapped).not.toBe(tool);
    // Calling with the allowed action should delegate to the original execute.
    await wrapped!.execute("id1", { action: "list" });
    expect(tool.execute).toHaveBeenCalledWith("id1", { action: "list" }, undefined, undefined);
  });

  it("wraps execute and rejects a disallowed action", async () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors.list"], []);
    const wrapped = result.find((t) => t.name === "manage_interlocutors");
    const response = await wrapped!.execute("id1", { action: "create" }) as AgentToolResult<{ message: string }>;
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not allowed") });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("create") });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("combines multiple dotted entries for the same tool", async () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors.list", "manage_interlocutors.create"], []);
    const wrapped = result.find((t) => t.name === "manage_interlocutors");
    // Both allowed actions should pass through.
    await wrapped!.execute("id1", { action: "list" });
    await wrapped!.execute("id2", { action: "create" });
    expect(tool.execute).toHaveBeenCalledTimes(2);
    // A third action should be rejected.
    const response = await wrapped!.execute("id3", { action: "delete" }) as AgentToolResult<{ message: string }>;
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not allowed") });
  });

  it("bare name takes precedence over dotted entries for the same tool", async () => {
    const tool = makeTool("manage_interlocutors");
    // Both a bare name and a dotted entry are present.
    const result = filterToolsForSubagent([tool], ["manage_interlocutors", "manage_interlocutors.list"], []);
    const included = result.find((t) => t.name === "manage_interlocutors");
    // The bare name wins: the original tool object is returned unchanged.
    expect(included).toBe(tool);
  });

  it("rejects calls with no action param when tool is action-scoped", async () => {
    const tool = makeTool("some_tool");
    const result = filterToolsForSubagent([tool], ["some_tool.list"], []);
    const wrapped = result.find((t) => t.name === "some_tool");
    // No action field in params: should be rejected, not delegated.
    const response = await wrapped!.execute("id1", { query: "SELECT 1" }) as AgentToolResult<{ message: string }>;
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("requires an action parameter") });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("some_tool") });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("list") });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("rejects calls with action: undefined when tool is action-scoped", async () => {
    const tool = makeTool("some_tool");
    const result = filterToolsForSubagent([tool], ["some_tool.list"], []);
    const wrapped = result.find((t) => t.name === "some_tool");
    // Explicit action: undefined should also be rejected.
    const response = await wrapped!.execute("id1", { action: undefined }) as AgentToolResult<{ message: string }>;
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("requires an action parameter") });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("some_tool") });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("list") });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("returns empty list (except send_agent_message) when allowed list is empty", () => {
    const tools = [makeTool("execute_sql"), makeTool("manage_cron")];
    const result = filterToolsForSubagent(tools, [], []);
    // send_agent_message is not in the tools array, so nothing is returned.
    expect(result).toHaveLength(0);
  });

  it("includes send_agent_message from tools when allowed list is empty", () => {
    const tools = [makeTool("execute_sql"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, [], []);
    expect(result.map((t) => t.name)).toEqual(["send_agent_message"]);
  });

  it("error message lists allowed actions sorted alphabetically", async () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors.update", "manage_interlocutors.list"], []);
    const wrapped = result.find((t) => t.name === "manage_interlocutors");
    const response = await wrapped!.execute("id1", { action: "delete" }) as AgentToolResult<{ message: string }>;
    const text = (response.content[0] as { type: string; text: string }).text;
    expect(text).toContain("list, update");
  });

  it("wrapped tool description includes restriction notice with sorted actions", () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors.update", "manage_interlocutors.list"], []);
    const wrapped = result.find((t) => t.name === "manage_interlocutors");
    expect(wrapped!.description).toBe("Tool manage_interlocutors (Restricted to actions: list, update.)");
  });

  it("unwrapped tool (bare name entry) has its original description unchanged", () => {
    const tool = makeTool("manage_interlocutors");
    const result = filterToolsForSubagent([tool], ["manage_interlocutors"], []);
    const included = result.find((t) => t.name === "manage_interlocutors");
    expect(included!.description).toBe("Tool manage_interlocutors");
  });

  // run_plugin_tool enforcement via allowedPlugins

  it("excludes run_plugin_tool when allowedPlugins is empty", () => {
    const tools = [makeTool("run_plugin_tool"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, [], []);
    expect(result.map((t) => t.name)).not.toContain("run_plugin_tool");
  });

  it("excludes run_plugin_tool even when it appears in allowedTools (allowedPlugins is empty)", () => {
    const tools = [makeTool("run_plugin_tool"), makeTool("send_agent_message")];
    const result = filterToolsForSubagent(tools, ["run_plugin_tool"], []);
    expect(result.map((t) => t.name)).not.toContain("run_plugin_tool");
  });

  it("includes run_plugin_tool as-is when allowedPlugins is ['*']", () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["*"]);
    const included = result.find((t) => t.name === "run_plugin_tool");
    expect(included).toBe(tool);
  });

  it("includes run_plugin_tool (wrapped) when allowedPlugins has specific entries", () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather"]);
    const included = result.find((t) => t.name === "run_plugin_tool");
    expect(included).toBeDefined();
    expect(included).not.toBe(tool);
  });

  it("wrapped run_plugin_tool allows access to a fully-allowed plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    await wrapped.execute("id1", { plugin: "weather", tool: "get_forecast" });
    expect(tool.execute).toHaveBeenCalled();
  });

  it("wrapped run_plugin_tool allows access to a specific tool in a plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather.get_forecast"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    await wrapped.execute("id1", { plugin: "weather", tool: "get_forecast" });
    expect(tool.execute).toHaveBeenCalled();
  });

  it("wrapped run_plugin_tool rejects a disallowed plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    const response = await wrapped.execute("id1", { plugin: "calendar", tool: "list_events" }) as AgentToolResult<{ message: string }>;
    const text = (response.content[0] as { type: string; text: string }).text;
    expect(text).toContain("calendar");
    expect(text).toContain("list_events");
    expect(text).toContain("not in this agent's allowed plugins");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("wrapped run_plugin_tool rejects a disallowed tool within an allowed plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather.get_forecast"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    const response = await wrapped.execute("id1", { plugin: "weather", tool: "set_location" }) as AgentToolResult<{ message: string }>;
    const text = (response.content[0] as { type: string; text: string }).text;
    expect(text).toContain("weather");
    expect(text).toContain("set_location");
    expect(text).toContain("not in this agent's allowed plugins");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("wrapped run_plugin_tool allows multiple specific tools in the same plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather.get_forecast", "weather.get_current"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    await wrapped.execute("id1", { plugin: "weather", tool: "get_forecast" });
    await wrapped.execute("id2", { plugin: "weather", tool: "get_current" });
    expect(tool.execute).toHaveBeenCalledTimes(2);
    const response = await wrapped.execute("id3", { plugin: "weather", tool: "set_location" }) as AgentToolResult<{ message: string }>;
    const text = (response.content[0] as { type: string; text: string }).text;
    expect(text).toContain("not in this agent's allowed plugins");
  });

  it("bare plugin name takes precedence over dotted entries for the same plugin", async () => {
    const tool = makeTool("run_plugin_tool");
    // "weather" (bare) should allow all tools, even though "weather.get_forecast" is also listed.
    const result = filterToolsForSubagent([tool], [], ["weather", "weather.get_forecast"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    await wrapped.execute("id1", { plugin: "weather", tool: "any_tool" });
    expect(tool.execute).toHaveBeenCalled();
  });

  it("wrapped run_plugin_tool passes through when plugin/tool params are missing", async () => {
    const tool = makeTool("run_plugin_tool");
    const result = filterToolsForSubagent([tool], [], ["weather"]);
    const wrapped = result.find((t) => t.name === "run_plugin_tool")!;
    // Missing params: delegate to original (let it handle the error).
    await wrapped.execute("id1", { plugin: "weather" });
    expect(tool.execute).toHaveBeenCalled();
  });
});

describe("formatPluginListSection", () => {
  it("formats a list of plugins without tool details", () => {
    const plugins = [
      { name: "hackernews", description: "Hacker News integration" },
      { name: "weather", description: "Weather forecasts" },
    ];
    const result = formatPluginListSection(plugins);
    expect(result).toBe(
      "Available plugins:\n- hackernews: Hacker News integration\n- weather: Weather forecasts",
    );
  });

  it("includes tool names when toolDetails is provided", () => {
    const plugins = [{ name: "hackernews", description: "Hacker News integration" }];
    const toolDetails = new Map([["hackernews", ["get_front_page", "get_comments"]]]);
    const result = formatPluginListSection(plugins, toolDetails);
    expect(result).toBe(
      "Available plugins:\n- hackernews: Hacker News integration\n  Tools: get_front_page, get_comments",
    );
  });

  it("omits the Tools line when the plugin has no tools in toolDetails", () => {
    const plugins = [{ name: "hackernews", description: "Hacker News integration" }];
    const toolDetails = new Map([["hackernews", [] as string[]]]);
    const result = formatPluginListSection(plugins, toolDetails);
    expect(result).toBe("Available plugins:\n- hackernews: Hacker News integration");
  });

  it("omits the Tools line when the plugin is absent from toolDetails", () => {
    const plugins = [{ name: "hackernews", description: "Hacker News integration" }];
    const toolDetails = new Map<string, string[]>();
    const result = formatPluginListSection(plugins, toolDetails);
    expect(result).toBe("Available plugins:\n- hackernews: Hacker News integration");
  });

  it("formats multiple plugins with mixed tool detail availability", () => {
    const plugins = [
      { name: "hackernews", description: "Hacker News integration" },
      { name: "weather", description: "Weather forecasts" },
    ];
    const toolDetails = new Map([
      ["hackernews", ["get_front_page", "get_comments"]],
      ["weather", [] as string[]],
    ]);
    const result = formatPluginListSection(plugins, toolDetails);
    expect(result).toBe(
      "Available plugins:\n- hackernews: Hacker News integration\n  Tools: get_front_page, get_comments\n- weather: Weather forecasts",
    );
  });
});

describe("truncateContext", () => {
  // Each character is 1/3 token, so 3 chars = 1 token.

  it("returns messages unchanged when total tokens are within budget", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: 0 },
    ];
    // "Hello" = 5 chars = 1.25 tokens; budget of 10 is plenty.
    const result = truncateContext(messages, 10);
    expect(result).toBe(messages);
  });

  it("returns the same array reference when no truncation is needed", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hi", timestamp: 0 },
    ];
    const result = truncateContext(messages, 100);
    expect(result).toBe(messages);
  });

  it("truncates a string-content user message that exceeds the budget", () => {
    // 40 chars = ~13.3 tokens; budget = 5 tokens.
    const longText = "a".repeat(40);
    const messages: AgentMessage[] = [
      { role: "user", content: longText, timestamp: 0 },
    ];
    const result = truncateContext(messages, 5);
    expect(result).not.toBe(messages);
    const content = (result[0] as { role: string; content: string }).content;
    expect(content).toContain("[truncated]");
    expect(content.length).toBeLessThan(longText.length);
  });

  it("truncates a text block in a tool result message", () => {
    // 400 chars = ~133 tokens; budget = 10 tokens.
    const longText = "x".repeat(400);
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "execute_sql",
        content: [{ type: "text", text: longText }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const result = truncateContext(messages, 10);
    expect(result).not.toBe(messages);
    const block = (result[0] as { content: Array<{ type: string; text: string }> }).content[0];
    expect(block.text).toContain("[truncated]");
    expect(block.text.length).toBeLessThan(longText.length);
  });

  it("truncates the largest text block first when multiple blocks exist", () => {
    // Small block: 40 chars = ~13 tokens. Large block: 400 chars = ~133 tokens.
    // Budget = 30 tokens. Total = ~147 tokens, excess = ~117 tokens.
    const smallText = "s".repeat(40);
    const largeText = "L".repeat(400);
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "execute_sql",
        content: [
          { type: "text", text: smallText },
          { type: "text", text: largeText },
        ],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const result = truncateContext(messages, 30);
    const content = (result[0] as { content: Array<{ type: string; text: string }> }).content;
    // The large block should be truncated.
    expect(content[1].text).toContain("[truncated]");
    expect(content[1].text.length).toBeLessThan(largeText.length);
    // The small block should be untouched (large block absorbed all excess).
    expect(content[0].text).toBe(smallText);
  });

  it("does not mutate the original messages array or its blocks", () => {
    const longText = "z".repeat(400);
    const originalBlock = { type: "text" as const, text: longText };
    const originalMessage = {
      role: "toolResult" as const,
      toolCallId: "tc1",
      toolName: "execute_sql",
      content: [originalBlock],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
    const messages: AgentMessage[] = [originalMessage];

    truncateContext(messages, 10);

    // Original array and message must be untouched.
    expect(messages[0]).toBe(originalMessage);
    expect((originalMessage as { content: Array<{ text: string }> }).content[0]).toBe(originalBlock);
    expect(originalBlock.text).toBe(longText);
  });

  it("does not modify ToolCall blocks", () => {
    // A large tool call argument should not be truncated.
    const largeArg = "q".repeat(400);
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc1",
          name: "execute_sql",
          arguments: { query: largeArg },
        },
      ]),
    ];
    // Budget is tiny — but tool calls must not be touched.
    const result = truncateContext(messages, 1);
    const block = (result[0] as { content: Array<{ type: string; arguments: Record<string, string> }> }).content[0];
    expect(block.arguments.query).toBe(largeArg);
  });

  it("does not modify ImageContent blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    // Budget is tiny — but image blocks must not be touched.
    const result = truncateContext(messages, 1);
    const block = (result[0] as { content: Array<{ type: string; data: string }> }).content[0];
    expect(block.data).toBe("base64data");
  });

  it("handles an assistant message with a text block", () => {
    const longText = "a".repeat(400);
    const messages: AgentMessage[] = [
      assistantMessage([{ type: "text", text: longText }]),
    ];
    const result = truncateContext(messages, 10);
    const block = (result[0] as { content: Array<{ type: string; text: string }> }).content[0];
    expect(block.text).toContain("[truncated]");
    expect(block.text.length).toBeLessThan(longText.length);
  });

  it("handles a user message with array content containing a text block", () => {
    const longText = "b".repeat(400);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: longText }],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const result = truncateContext(messages, 10);
    const block = (result[0] as { content: Array<{ type: string; text: string }> }).content[0];
    expect(block.text).toContain("[truncated]");
    expect(block.text.length).toBeLessThan(longText.length);
  });

  it("does not grow the context when a text block is shorter than the truncation suffix", () => {
    // A 4-char block is ~1.3 tokens. The truncation suffix "\n[truncated]" is 12 chars.
    // Without the guard, truncating would replace 4 chars with 12, making things worse.
    const tinyText = "abcd";
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "execute_sql",
        content: [{ type: "text", text: tinyText }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const originalTokens = tinyText.length / 3;
    // Budget below the block's token count to trigger truncation logic.
    const result = truncateContext(messages, originalTokens - 0.1);
    const block = (result[0] as { content: Array<{ type: string; text: string }> }).content[0];
    // The block must not have grown: the suffix alone is longer than the original.
    expect(block.text.length).toBeLessThanOrEqual(tinyText.length);
  });
});

describe("createManageKnowledgeTool — read action", () => {
  // Import the mocked readScratchpad after vi.mock has been set up.
  async function getReadScratchpadMock(): Promise<MockedFunction<() => Promise<unknown>>> {
    const db = await import("./database.js");
    return db.readScratchpad as unknown as MockedFunction<() => Promise<unknown>>;
  }

  it("returns the title and body when the entry exists", async () => {
    const readScratchpad = await getReadScratchpadMock();
    readScratchpad.mockResolvedValueOnce({ id: 5, title: "My note", body: "Some content." });

    const tool = createManageKnowledgeTool({} as Pool);
    const result = await tool.execute("tc1", { action: "read", store: "scratchpad", id: 5 });

    expect(result.content[0]).toMatchObject({ type: "text", text: "Title: My note\n\nSome content." });
  });

  it("returns an error when the entry is not found", async () => {
    const readScratchpad = await getReadScratchpadMock();
    readScratchpad.mockResolvedValueOnce(null);

    const tool = createManageKnowledgeTool({} as Pool);
    const result = await tool.execute("tc1", { action: "read", store: "scratchpad", id: 99 });

    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not found") });
  });

  it("returns an error when store is not scratchpad", async () => {
    const tool = createManageKnowledgeTool({} as Pool);
    const result = await tool.execute("tc1", { action: "read", store: "memory", id: 1 });

    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("only supported for the scratchpad store") });
  });

  it("returns an error when id is missing", async () => {
    const tool = createManageKnowledgeTool({} as Pool);
    const result = await tool.execute("tc1", { action: "read", store: "scratchpad" });

    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("id is required") });
  });
});

describe("injectAutoSearchBlock", () => {
  it("returns messages unchanged when searchBlock is undefined", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: 0 },
    ];
    const result = injectAutoSearchBlock(messages, undefined);
    expect(result).toBe(messages);
  });

  it("returns messages unchanged when there are no user messages", () => {
    const messages: AgentMessage[] = [
      assistantMessage([{ type: "text", text: "Hi!" }]),
    ];
    const result = injectAutoSearchBlock(messages, "search results");
    expect(result).toBe(messages);
  });

  it("appends the search block to a string-content user message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: 0 },
    ];
    const result = injectAutoSearchBlock(messages, "search results");
    expect(result).not.toBe(messages);
    const content = (result[0] as { content: string }).content;
    expect(content).toBe("Hello\n\nsearch results");
  });

  it("appends to the last user message, not an earlier one", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "First message", timestamp: 0 },
      assistantMessage([{ type: "text", text: "Response" }]),
      { role: "user", content: "Second message", timestamp: 1 },
    ];
    const result = injectAutoSearchBlock(messages, "search results");
    const firstContent = (result[0] as { content: string }).content;
    const lastContent = (result[2] as { content: string }).content;
    expect(firstContent).toBe("First message");
    expect(lastContent).toBe("Second message\n\nsearch results");
  });

  it("appends to the last text block in an array-content user message", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const result = injectAutoSearchBlock(messages, "search results");
    const content = (result[0] as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toBe("Hello\n\nsearch results");
  });

  it("adds a new text block when array-content user message has no text blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const result = injectAutoSearchBlock(messages, "search results");
    const content = (result[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "text", text: "search results" });
  });

  it("does not mutate the original messages or their content arrays", () => {
    const originalContent = [{ type: "text" as const, text: "Hello" }];
    const originalMessage = {
      role: "user" as const,
      content: originalContent,
      timestamp: 0,
    } as unknown as AgentMessage;
    const messages: AgentMessage[] = [originalMessage];

    injectAutoSearchBlock(messages, "search results");

    expect(messages[0]).toBe(originalMessage);
    expect((originalMessage as { content: typeof originalContent }).content).toBe(originalContent);
    expect(originalContent[0].text).toBe("Hello");
  });

  it("does not mutate the original messages array when content is a string", () => {
    const originalMessage = { role: "user" as const, content: "Hello", timestamp: 0 };
    const messages: AgentMessage[] = [originalMessage];

    injectAutoSearchBlock(messages, "search results");

    expect(messages[0]).toBe(originalMessage);
    expect(originalMessage.content).toBe("Hello");
  });
});

// Minimal config for integration tests that exercise handlePrompt and createAgent.
// Only the fields read by the code paths under test are populated.
const minimalConfig = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  apiKey: "test-key",
  baseSystemPrompt: "You are a helpful assistant.",
  baseAgentPrompt: "You are a subagent.",
  publicHostname: "localhost",
  compactionPrompt: "Summarize.",
} as unknown as import("./config.js").Config;

// Minimal routing result for the main agent.
const mainAgentRouting = {
  agentId: 1,
  senderIdentityId: undefined,
  senderAgentId: undefined,
  senderLabel: "test-user",
  isMainAgent: true,
};

// Minimal pool stub: only the methods called by handlePrompt are needed.
function makePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Pool;
}

describe("pendingAutoSearchBlocks — integration tests via handlePrompt and createAgent", () => {
  it("cleans up the pending block when a pre-prompt exception is thrown", async () => {
    // Set up database mocks for this test.
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(loadAllMemories).mockResolvedValue([]);
    vi.mocked(loadAllScratchpadTitles).mockResolvedValue([]);
    vi.mocked(getMainAgentId).mockReturnValue(1);

    // internalFetch is called by fetchPluginList; return an empty plugin list.
    vi.mocked(internalFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    } as unknown as Response);

    // runSearch returns a result so handlePrompt sets a pending block.
    vi.mocked(runSearch).mockResolvedValue({
      tableResults: [{ tableName: "notes", matchCount: 1, rows: [{ body: "relevant note" }] }],
      messages: [],
    });

    const agent = await createAgent(minimalConfig, makePool());
    const fakeAgent = agent as unknown as InstanceType<typeof FakeAgent>;

    // getApiKey throws after the block is set, triggering the finally cleanup.
    // The assertion inside the mock proves the pending block was set before the
    // exception propagated, making the subsequent cleanup assertion meaningful.
    vi.mocked(getApiKey).mockImplementation(async () => {
      expect(pendingAutoSearchBlocks.has(fakeAgent as unknown as Agent)).toBe(true);
      throw new Error("auth failed");
    });

    let caughtError: unknown;
    try {
      await handlePrompt(agent, makePool(), "find my notes", minimalConfig, mainAgentRouting, "signal");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    // The finally block in handlePrompt must have deleted the entry.
    expect(pendingAutoSearchBlocks.has(fakeAgent as unknown as Agent)).toBe(false);
  });

  it("does not inject the turn-1 auto-search block into the turn-2 prompt context", async () => {
    // Set up database mocks for both turns.
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(loadAllMemories).mockResolvedValue([]);
    vi.mocked(loadAllScratchpadTitles).mockResolvedValue([]);
    vi.mocked(getMainAgentId).mockReturnValue(1);

    vi.mocked(internalFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    } as unknown as Response);

    // getApiKey succeeds for both turns.
    vi.mocked(getApiKey).mockResolvedValue("test-key");

    const pool = makePool();
    const agent = await createAgent(minimalConfig, pool);
    const fakeAgent = agent as unknown as InstanceType<typeof FakeAgent>;

    // Turn 1: auto-search returns results, so a block is set and injected.
    vi.mocked(runSearch).mockResolvedValueOnce({
      tableResults: [{ tableName: "notes", matchCount: 1, rows: [{ body: "turn 1 result" }] }],
      messages: [],
    });

    await handlePrompt(agent, pool, "find my notes", minimalConfig, mainAgentRouting, "signal");

    // After turn 1, the finally block must have cleared the pending entry.
    expect(pendingAutoSearchBlocks.has(fakeAgent as unknown as Agent)).toBe(false);

    // Turn 2: auto-search returns no results, so no block is set.
    vi.mocked(runSearch).mockResolvedValueOnce({
      tableResults: [],
      messages: [],
    });

    await handlePrompt(agent, pool, "what did I say?", minimalConfig, mainAgentRouting, "signal");

    // The entry-point delete at the top of handlePrompt ran, and no new block
    // was set. The transformContext callback must therefore see no block.
    expect(pendingAutoSearchBlocks.has(fakeAgent as unknown as Agent)).toBe(false);

    // Verify that the captured context for turn 2 does not contain the turn-1
    // auto-search block. capturedContextMessages holds what transformContext
    // returned on the most recent prompt() call. The assertions are
    // unconditional: a missing or empty context is itself a test failure,
    // because FakeAgent.prompt() always populates capturedContextMessages when
    // transformContextFn is set (and createAgent always sets it).
    const capturedMessages = fakeAgent.capturedContextMessages as Array<{ role: string; content: unknown }>;
    expect(capturedMessages).toBeDefined();
    const lastUserMessage = capturedMessages.filter((m) => m.role === "user").at(-1);
    expect(lastUserMessage).toBeDefined();
    const contentText = typeof lastUserMessage!.content === "string"
      ? lastUserMessage!.content
      : JSON.stringify(lastUserMessage!.content);
    expect(contentText).not.toContain("turn 1 result");
    expect(contentText).not.toContain("Auto-search results");
  });
});

describe("escalatingSummarize", () => {
  const mockComplete = vi.mocked(complete);

  const fakeModel = {} as Parameters<typeof escalatingSummarize>[2];
  const fakeConfig = {
    compactionPrompt: "Summarize this.",
    compactionBulletPrompt: "Bullet points. Target: {target} tokens maximum.",
  } as Parameters<typeof escalatingSummarize>[1];
  const fakeApiKey = "test-api-key";

  function makeCompleteResponse(text: string): ReturnType<typeof complete> {
    return Promise.resolve({
      content: [{ type: "text", text }],
    } as Awaited<ReturnType<typeof complete>>);
  }

  beforeEach(() => {
    mockComplete.mockReset();
  });

  it("returns level 1 summary when it is shorter than the input", async () => {
    const input = "A".repeat(100);
    const shortSummary = "Short summary.";
    mockComplete.mockReturnValueOnce(makeCompleteResponse(shortSummary));

    const result = await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    expect(result).toBe(shortSummary);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    // Level 1 uses the compaction prompt.
    expect(mockComplete.mock.calls[0][1].systemPrompt).toBe(fakeConfig.compactionPrompt);
  });

  it("falls back to level 2 when level 1 summary is not shorter than the input", async () => {
    const input = "A long enough input string.";
    const bloatedSummary = "A".repeat(input.length + 10);
    const bulletSummary = "- fact";
    mockComplete
      .mockReturnValueOnce(makeCompleteResponse(bloatedSummary))
      .mockReturnValueOnce(makeCompleteResponse(bulletSummary));

    const result = await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    expect(result).toBe(bulletSummary);
    expect(mockComplete).toHaveBeenCalledTimes(2);
    // Level 2 uses the bullet prompt with {target} replaced.
    const level2Prompt = mockComplete.mock.calls[1][1].systemPrompt as string;
    expect(level2Prompt).not.toContain("{target}");
    expect(level2Prompt).toContain("tokens maximum");
  });

  it("falls back to level 3 truncation when both LLM levels fail to shorten", async () => {
    const input = "A".repeat(200);
    const bloated = "B".repeat(input.length + 10);
    mockComplete
      .mockReturnValueOnce(makeCompleteResponse(bloated))
      .mockReturnValueOnce(makeCompleteResponse(bloated));

    const result = await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result).toContain("[truncated due to compaction failure]");
    // Level 3 must produce a result strictly shorter than the input.
    expect(result.length).toBeLessThan(input.length);
  });

  it("level 3 result is strictly shorter than the input for a long input", async () => {
    const input = "X".repeat(3000);
    const bloated = "Y".repeat(input.length + 1);
    mockComplete
      .mockReturnValueOnce(makeCompleteResponse(bloated))
      .mockReturnValueOnce(makeCompleteResponse(bloated));

    const result = await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    expect(result).toContain("[truncated due to compaction failure]");
    expect(result.length).toBeLessThan(input.length);
  });

  it("level 3 result is strictly shorter than a short input (50 chars) when both LLM levels fail", async () => {
    // With a 50-char input, the old code would produce 50 + 38 = 88 chars (longer than input).
    // The fix must ensure the result is always strictly shorter than the input.
    const input = "A".repeat(50);
    const bloated = "B".repeat(input.length + 10);
    mockComplete
      .mockReturnValueOnce(makeCompleteResponse(bloated))
      .mockReturnValueOnce(makeCompleteResponse(bloated));

    const result = await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result).toContain("[truncated due to compaction failure]");
    expect(result.length).toBeLessThan(input.length);
  });

  it("replaces {target} placeholder in bullet prompt with computed token count", async () => {
    // Input of 300 chars → ~100 estimated tokens → target = 50.
    const input = "A".repeat(300);
    const bloated = "B".repeat(input.length + 1);
    const bulletSummary = "- item";
    mockComplete
      .mockReturnValueOnce(makeCompleteResponse(bloated))
      .mockReturnValueOnce(makeCompleteResponse(bulletSummary));

    await escalatingSummarize(input, fakeConfig, fakeModel, fakeApiKey);

    const level2Prompt = mockComplete.mock.calls[1][1].systemPrompt as string;
    // 300 chars / 3 / 2 = 50 tokens target.
    expect(level2Prompt).toContain("50");
  });
});

// Build a user message with a string content of the given character length.
// Each character is 1/3 token (CHARS_PER_TOKEN = 3), so charCount / 3 = tokens.
function userMsg(charCount: number): AgentMessage {
  return { role: "user", content: "u".repeat(charCount), timestamp: 0 };
}

function assistantMsg(charCount: number): AgentMessage {
  return assistantMessage([{ type: "text", text: "a".repeat(charCount) }]);
}

describe("selectCompactionCutIndex", () => {
  // threshold = 300 tokens → keepBudget = 150 tokens = 450 chars

  it("returns the index of the first user message after the token-based cut (forward path)", () => {
    // Build a history where the last few messages fit within the keep budget and
    // the cut lands exactly on a user message, so the forward scan succeeds immediately.
    // threshold = 300 tokens, keepBudget = 150 tokens = 450 chars.
    // Messages (each 100 chars = ~33 tokens):
    //   [0] user 100 chars
    //   [1] assistant 100 chars
    //   [2] user 100 chars   ← cut lands here (accumulated = 33+33 = 66 < 150, then adding [0] would exceed)
    //   [3] assistant 100 chars
    //   [4] user 100 chars   ← keep budget: 33+33+33 = 99 < 150, adding [1] would be 132 < 150, adding [0] = 165 > 150 → cutIndex = 1
    // Actually let's use larger messages to make the arithmetic clear.
    // 5 messages of 150 chars each = 50 tokens each. keepBudget = 150 tokens.
    // Walk backward: i=4 acc=50, i=3 acc=100, i=2 acc=150 (exactly at budget, not exceeded), i=1: 150+50=200 > 150 → cutIndex = 2.
    // messages[2].role = "user" → forward scan stops immediately → returns 2.
    const messages: AgentMessage[] = [
      userMsg(150),       // [0]
      assistantMsg(150),  // [1]
      userMsg(150),       // [2] ← expected cut point
      assistantMsg(150),  // [3]
      userMsg(150),       // [4]
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBe(2);
  });

  it("falls back to backward scan when no user message exists after the cut (backward path)", () => {
    // threshold = 300 tokens, keepBudget = 150 tokens = 450 chars.
    // Messages:
    //   [0] user 150 chars (50 tokens)
    //   [1] assistant 150 chars (50 tokens)
    //   [2] user 150 chars (50 tokens)
    //   [3] assistant 450 chars (150 tokens) ← huge response
    //   [4] assistant 150 chars (50 tokens)
    // Walk backward: i=4 acc=50, i=3: 50+150=200 > 150 → cutIndex = 4.
    // Forward scan from 4: messages[4].role = "assistant" → advance to 5 → out of bounds.
    // Backward scan from 4: messages[4]="assistant", messages[3]="assistant", messages[2]="user" → backwardIndex = 2.
    const messages: AgentMessage[] = [
      userMsg(150),       // [0]
      assistantMsg(150),  // [1]
      userMsg(150),       // [2] ← expected backward fallback cut point
      assistantMsg(450),  // [3] huge response
      assistantMsg(150),  // [4]
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBe(2);
  });

  it("returns null when there are no user messages at all", () => {
    // All assistant messages — no safe cut point exists.
    const messages: AgentMessage[] = [
      assistantMsg(150),
      assistantMsg(150),
      assistantMsg(150),
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBeNull();
  });

  it("returns null when the only user message is at index 0 (backward scan would return 0)", () => {
    // threshold = 300 tokens, keepBudget = 150 tokens = 450 chars.
    // Messages:
    //   [0] user 30 chars (10 tokens)
    //   [1] assistant 1500 chars (500 tokens) ← huge, exceeds keep budget
    // Walk backward: i=1: 0+500 > 150 → cutIndex = 2.
    // Forward scan from 2: out of bounds.
    // Backward scan from 2: messages[1]="assistant", messages[0]="user" → backwardIndex = 0.
    // backwardIndex <= 0 → return null (compacting zero messages is pointless).
    const messages: AgentMessage[] = [
      userMsg(30),          // [0] only user message
      assistantMsg(1500),   // [1] huge response
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBeNull();
  });

  it("returns null when all messages fit within the keep budget", () => {
    // threshold = 300 tokens, keepBudget = 150 tokens.
    // 2 messages of 30 chars each = 10 tokens each = 20 tokens total < 150.
    // The backward loop never sets cutIndex away from 0 → returns null.
    const messages: AgentMessage[] = [
      userMsg(30),
      assistantMsg(30),
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBeNull();
  });

  it("forward scan skips a steered user message and finds a valid turn boundary further ahead", () => {
    // The backward walk lands on a steered user message (injected mid-turn between
    // a toolCall and its toolResult). The forward scan must skip it and advance to
    // the real turn boundary at [5].
    // threshold=200, keepBudget=100. The toolCall at [1] is ~50 tokens so the
    // backward walk sets cutIndex=2 (the steered user message).
    const assistantWithToolCall = assistantMessage([{ type: "toolCall", id: "tc1", name: "execute_sql", arguments: { query: "x".repeat(140) } }]);
    const messages: AgentMessage[] = [
      userMsg(60),              // [0] real turn boundary
      assistantWithToolCall,    // [1] has toolCall (~50 tokens)
      userMsg(60),              // [2] steered mid-turn (NOT a boundary)
      toolResultMessage("execute_sql", "a".repeat(60)),  // [3]
      assistantMsg(60),         // [4] text-only
      userMsg(60),              // [5] real turn boundary ← expected cut point
    ];
    const result = selectCompactionCutIndex(messages, 200);
    expect(result).toBe(5);
  });

  it("backward scan fallback skips steered user messages when forward scan finds no boundary", () => {
    // The forward scan exhausts the message list without finding a turn-boundary
    // user message. The backward scan must also skip steered (mid-turn) user
    // messages and land on the nearest earlier real turn boundary at [2].
    // threshold=300, keepBudget=150. The tail of the history (messages [4]–[7])
    // contains only non-boundary user messages, so both scans must skip them.
    const assistantWithToolCall = assistantMessage([{ type: "toolCall", id: "tc1", name: "execute_sql", arguments: {} }]);
    const messages: AgentMessage[] = [
      userMsg(150),             // [0] real turn boundary
      assistantMsg(150),        // [1] text-only
      userMsg(150),             // [2] real turn boundary ← expected cut point
      assistantWithToolCall,    // [3] has toolCall
      userMsg(150),             // [4] steered mid-turn (NOT a boundary)
      toolResultMessage("execute_sql", "a".repeat(150)),  // [5]
      userMsg(150),             // [6] user after toolResult (NOT a boundary)
      assistantMsg(150),        // [7]
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBe(2);
  });

  it("skips a steered user message in the backward scan fallback", () => {
    // When the forward scan finds no turn-boundary user message, the backward scan
    // must also skip steered (mid-turn) user messages and land on [2].
    // threshold=300, keepBudget=150. The large toolResult at [5] forces the
    // backward walk to set cutIndex=6, and neither scan finds a boundary after it.
    const assistantWithToolCall = assistantMessage([{ type: "toolCall", id: "tc1", name: "execute_sql", arguments: {} }]);
    const messages: AgentMessage[] = [
      userMsg(150),             // [0] real turn boundary
      assistantMsg(150),        // [1] text-only
      userMsg(150),             // [2] real turn boundary ← expected cut point
      assistantWithToolCall,    // [3] has toolCall
      userMsg(150),             // [4] steered mid-turn (NOT a boundary)
      toolResultMessage("execute_sql", "a".repeat(450)),  // [5] large
      assistantMsg(150),        // [6]
    ];
    const result = selectCompactionCutIndex(messages, 300);
    expect(result).toBe(2);
  });
});

describe("handlePrompt — user message persistence", () => {
  const mockSaveMessage = vi.mocked(saveMessage);

  function setupCommonMocks(): void {
    vi.clearAllMocks();
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(loadAllMemories).mockResolvedValue([]);
    vi.mocked(loadAllScratchpadTitles).mockResolvedValue([]);
    vi.mocked(getMainAgentId).mockReturnValue(1);
    vi.mocked(internalFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    } as unknown as Response);
    vi.mocked(getApiKey).mockResolvedValue("test-key");
    vi.mocked(runSearch).mockResolvedValue({ tableResults: [], messages: [] });
    mockSaveMessage.mockResolvedValue(42);
  }

  it("saves the user message before agent.prompt() so it persists even when prompt throws", async () => {
    setupCommonMocks();

    const agent = await createAgent(minimalConfig, makePool());
    const fakeAgent = agent as unknown as InstanceType<typeof FakeAgent>;
    fakeAgent.promptError = new Error("model unreachable");

    let caughtError: unknown;
    try {
      await handlePrompt(agent, makePool(), "hello", minimalConfig, mainAgentRouting);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    // saveMessage must have been called with a user message before the error.
    const userSave = mockSaveMessage.mock.calls.find(
      (call) => (call[1] as { role: string }).role === "user",
    );
    expect(userSave).toBeDefined();
  });

  it("does not save the user message again on a retry (isRetry: true)", async () => {
    setupCommonMocks();

    const agent = await createAgent(minimalConfig, makePool());

    await handlePrompt(agent, makePool(), "hello", minimalConfig, mainAgentRouting, undefined, undefined, true);

    const userSaves = mockSaveMessage.mock.calls.filter(
      (call) => (call[1] as { role: string }).role === "user",
    );
    expect(userSaves).toHaveLength(0);
  });

  it("saves the user message exactly once on a non-retry (isRetry: false)", async () => {
    setupCommonMocks();

    const agent = await createAgent(minimalConfig, makePool());

    await handlePrompt(agent, makePool(), "hello", minimalConfig, mainAgentRouting, undefined, undefined, false);

    const userSaves = mockSaveMessage.mock.calls.filter(
      (call) => (call[1] as { role: string }).role === "user",
    );
    expect(userSaves).toHaveLength(1);
  });

  it("inserts the auto-search embedding into message_embeddings when available", async () => {
    setupCommonMocks();
    // Return a query embedding so the embedding insert path is exercised.
    vi.mocked(runSearch).mockResolvedValue({
      tableResults: [],
      messages: [],
      queryEmbedding: [0.1, 0.2, 0.3],
    });

    const pool = makePool();
    const agent = await createAgent(minimalConfig, pool);

    await handlePrompt(agent, pool, "find something", minimalConfig, mainAgentRouting, "signal");

    const mockQuery = vi.mocked(pool.query as (...args: unknown[]) => unknown);
    const embeddingInsert = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("message_embeddings"),
    );
    expect(embeddingInsert).toBeDefined();
  });

  it("does not insert an embedding on retry even when auto-search returns one", async () => {
    setupCommonMocks();
    vi.mocked(runSearch).mockResolvedValue({
      tableResults: [],
      messages: [],
      queryEmbedding: [0.1, 0.2, 0.3],
    });

    const pool = makePool();
    const agent = await createAgent(minimalConfig, pool);

    await handlePrompt(agent, pool, "find something", minimalConfig, mainAgentRouting, "signal", undefined, true);

    const mockQuery = vi.mocked(pool.query as (...args: unknown[]) => unknown);
    const embeddingInsert = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("message_embeddings"),
    );
    expect(embeddingInsert).toBeUndefined();
  });

  it("saves steered user messages that arrive as message_end events during prompt()", async () => {
    setupCommonMocks();

    const agent = await createAgent(minimalConfig, makePool());
    const fakeAgent = agent as unknown as InstanceType<typeof FakeAgent>;

    // Queue a steered message to be emitted during prompt().
    const steeredMessage = {
      role: "user",
      content: [{ type: "text", text: "steered message" }],
      timestamp: Date.now(),
    };
    fakeAgent.steeringMessages = [steeredMessage];

    await handlePrompt(agent, makePool(), "initial message", minimalConfig, mainAgentRouting);

    const userSaves = mockSaveMessage.mock.calls.filter(
      (call) => (call[1] as { role: string }).role === "user",
    );
    // Exactly two user saves: the initial message (pre-prompt) and the steered message (subscriber).
    expect(userSaves).toHaveLength(2);
    // The steered message must be saved without sender metadata (no senderIdentityId/senderAgentId).
    const steeredSave = userSaves[1];
    expect((steeredSave[1] as { content: unknown }).content).toEqual(steeredMessage.content);
    expect(steeredSave[3]).toBeUndefined();
    expect(steeredSave[4]).toBeUndefined();
  });

  it("does not save the initial message_end event from the agent-loop as a duplicate", async () => {
    setupCommonMocks();

    const agent = await createAgent(minimalConfig, makePool());

    // No steered messages — only the initial prompt fires a message_end event.
    await handlePrompt(agent, makePool(), "hello", minimalConfig, mainAgentRouting);

    const userSaves = mockSaveMessage.mock.calls.filter(
      (call) => (call[1] as { role: string }).role === "user",
    );
    // Exactly one user save: the pre-prompt save. The message_end for the initial
    // prompt must be skipped by the subscriber.
    expect(userSaves).toHaveLength(1);
  });
});

describe("isTurnBoundary", () => {
  it("returns true for the first message when it is a user message", () => {
    const messages: AgentMessage[] = [
      userMsg(10),
      assistantMsg(10),
    ];
    expect(isTurnBoundary(messages, 0)).toBe(true);
  });

  it("returns false for a non-user message", () => {
    const messages: AgentMessage[] = [
      userMsg(10),
      assistantMsg(10),
    ];
    expect(isTurnBoundary(messages, 1)).toBe(false);
  });

  it("returns true for a user message after a text-only assistant message", () => {
    const messages: AgentMessage[] = [
      userMsg(10),
      assistantMsg(10),
      userMsg(10),
    ];
    expect(isTurnBoundary(messages, 2)).toBe(true);
  });

  it("returns false for a user message after an assistant message with a toolCall block", () => {
    const assistantWithToolCall = assistantMessage([{ type: "toolCall", id: "tc1", name: "execute_sql", arguments: {} }]);
    const messages: AgentMessage[] = [
      userMsg(10),
      assistantWithToolCall,
      userMsg(10),
    ];
    expect(isTurnBoundary(messages, 2)).toBe(false);
  });

  it("returns false for a user message after a toolResult message", () => {
    const messages: AgentMessage[] = [
      userMsg(10),
      toolResultMessage("execute_sql", "result"),
      userMsg(10),
    ];
    expect(isTurnBoundary(messages, 2)).toBe(false);
  });

  it("returns true for consecutive user messages", () => {
    const messages: AgentMessage[] = [
      userMsg(10),
      userMsg(10),
    ];
    expect(isTurnBoundary(messages, 1)).toBe(true);
  });
});
