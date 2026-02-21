import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const TOOL_RUNNER_BASE_URL = "http://tool-runner:3001";
const CLAUDE_CODE_BASE_URL = "http://coder:3002";

export function createListBundlesTool(): AgentTool {
  return {
    name: "list_bundles",
    label: "List bundles",
    description: "List all available tool bundles. Returns bundle names and descriptions. Use this to discover what tool bundles are available before inspecting them.",
    parameters: Type.Object({}),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      console.log("[stavrobot] list_bundles called");
      const response = await fetch(`${TOOL_RUNNER_BASE_URL}/bundles`);
      const result = await response.text();
      console.log("[stavrobot] list_bundles result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createShowBundleTool(): AgentTool {
  return {
    name: "show_bundle",
    label: "Show bundle",
    description: "Show all tools in a bundle, including their names, descriptions, and parameter schemas. Use this to understand what tools a bundle provides and how to call them.",
    parameters: Type.Object({
      name: Type.String({ description: "The bundle name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] show_bundle called:", name);
      const response = await fetch(`${TOOL_RUNNER_BASE_URL}/bundles/${name}`);
      if (response.status === 404) {
        const result = `Bundle '${name}' not found.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const result = await response.text();
      console.log("[stavrobot] show_bundle result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRunBundleToolTool(): AgentTool {
  return {
    name: "run_tool",
    label: "Run tool",
    description: "Run a tool from a bundle with the given parameters. The parameters must match the tool's schema as shown by show_bundle.",
    parameters: Type.Object({
      bundle: Type.String({ description: "The bundle name." }),
      tool: Type.String({ description: "The tool name." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { bundle, tool, parameters } = params as { bundle: string; tool: string; parameters: string };
      console.log("[stavrobot] run_tool called: bundle:", bundle, "tool:", tool, "parameters:", parameters);
      const parsedParameters = JSON.parse(parameters) as unknown;
      const response = await fetch(`${TOOL_RUNNER_BASE_URL}/bundles/${bundle}/tools/${tool}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedParameters),
      });
      const result = await response.text();
      console.log("[stavrobot] run_tool result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRequestCodingTaskTool(): AgentTool {
  return {
    name: "request_coding_task",
    label: "Request coding task",
    description: "Request the coding agent to create or modify a custom tool. This is asynchronous — the result will arrive later as a message from the coder agent. Describe what you want the tool to do clearly and completely.",
    parameters: Type.Object({
      message: Type.String({ description: "A detailed description of what tool to create or modify." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { message } = params as { message: string };
      const taskId = crypto.randomUUID();
      console.log("[stavrobot] request_coding_task called: taskId", taskId, "message:", message);
      await fetch(`${CLAUDE_CODE_BASE_URL}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, message }),
      });
      const result = `Coding task ${taskId} submitted. The coder agent will respond when done.`;
      console.log("[stavrobot] request_coding_task submitted:", taskId);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
