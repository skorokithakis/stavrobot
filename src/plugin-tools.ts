import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

export function createInstallPluginTool(): AgentTool {
  return {
    name: "install_plugin",
    label: "Install plugin",
    description: "Install a plugin from a git repository URL. Returns the plugin manifest and any configuration requirements.",
    parameters: Type.Object({
      url: Type.String({ description: "The git repository URL to clone." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { url } = params as { url: string };
      console.log("[stavrobot] install_plugin called:", url);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const result = await response.text();
      console.log("[stavrobot] install_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createUpdatePluginTool(): AgentTool {
  return {
    name: "update_plugin",
    label: "Update plugin",
    description: "Update an installed plugin to the latest version from its git repository.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] update_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.text();
      console.log("[stavrobot] update_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRemovePluginTool(): AgentTool {
  return {
    name: "remove_plugin",
    label: "Remove plugin",
    description: "Remove an installed plugin.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] remove_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.text();
      console.log("[stavrobot] remove_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createConfigurePluginTool(): AgentTool {
  return {
    name: "configure_plugin",
    label: "Configure plugin",
    description: "Set configuration values for a plugin. The config keys must match what the plugin's manifest declares. Pass the config as a JSON string.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
      config: Type.String({ description: "JSON string of configuration values to set." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name, config } = params as { name: string; config: string };
      console.log("[stavrobot] configure_plugin called: name:", name, "config:", config);
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(config);
      } catch {
        const result = "Error: config is not valid JSON.";
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config: parsedConfig }),
      });
      const result = await response.text();
      console.log("[stavrobot] configure_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createListPluginsTool(): AgentTool {
  return {
    name: "list_plugins",
    label: "List plugins",
    description: "List all installed plugins. Returns plugin names and descriptions.",
    parameters: Type.Object({}),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      console.log("[stavrobot] list_plugins called");
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
      const result = await response.text();
      console.log("[stavrobot] list_plugins result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createShowPluginTool(): AgentTool {
  return {
    name: "show_plugin",
    label: "Show plugin",
    description: "Show all tools in a plugin, including their names, descriptions, and parameter schemas.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] show_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${name}`);
      if (response.status === 404) {
        const result = `Plugin '${name}' not found.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const result = await response.text();
      console.log("[stavrobot] show_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRunPluginToolTool(): AgentTool {
  return {
    name: "run_plugin_tool",
    label: "Run plugin tool",
    description: "Run a tool from an installed plugin with the given parameters. The parameters must match the tool's schema as shown by show_plugin.",
    parameters: Type.Object({
      plugin: Type.String({ description: "The plugin name." }),
      tool: Type.String({ description: "The tool name." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { plugin, tool, parameters } = params as { plugin: string; tool: string; parameters: string };
      console.log("[stavrobot] run_plugin_tool called: plugin:", plugin, "tool:", tool, "parameters:", parameters);
      const parsedParameters = JSON.parse(parameters) as unknown;
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}/tools/${tool}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedParameters),
      });
      const result = await response.text();
      console.log("[stavrobot] run_plugin_tool result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
