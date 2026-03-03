import { describe, it, expect, vi } from "vitest";
import type { AgentMessage, AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { serializeMessagesForSummary, filterToolsForSubagent, formatPluginListSection } from "./agent.js";

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
