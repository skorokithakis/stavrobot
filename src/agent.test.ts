import { describe, it, expect, vi, type MockedFunction } from "vitest";
import type { AgentMessage, AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Pool } from "pg";
import { serializeMessagesForSummary, filterToolsForSubagent, formatPluginListSection, truncateContext, createManageKnowledgeTool } from "./agent.js";

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
  createManagePluginsTool: vi.fn(),
  createRunPluginToolTool: vi.fn(),
  createRequestCodingTaskTool: vi.fn(),
}));
vi.mock("./python.js", () => ({ createRunPythonTool: vi.fn() }));
vi.mock("./pages.js", () => ({ createManagePagesTool: vi.fn() }));
vi.mock("./files.js", () => ({ createManageFilesTool: vi.fn() }));
vi.mock("./interlocutors.js", () => ({ createManageInterlocutorsTool: vi.fn() }));
vi.mock("./agents.js", () => ({ createManageAgentsTool: vi.fn() }));
vi.mock("./send-agent-message.js", () => ({ createSendAgentMessageTool: vi.fn() }));
vi.mock("./search.js", () => ({ createSearchTool: vi.fn() }));
vi.mock("./upload-tools.js", () => ({ createManageUploadsTool: vi.fn() }));
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
  getModel: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn(),
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
  // Each character is 1/4 token, so 4 chars = 1 token.

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
    // 40 chars = 10 tokens; budget = 5 tokens.
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
    // 400 chars = 100 tokens; budget = 10 tokens.
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
    // Small block: 40 chars = 10 tokens. Large block: 400 chars = 100 tokens.
    // Budget = 30 tokens. Total = 110 tokens, excess = 80 tokens = 320 chars.
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
    // A 4-char block is 1 token. The truncation suffix "\n[truncated]" is 12 chars.
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
    const originalTokens = tinyText.length / 4;
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
