import fs from "fs/promises";
import path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { encodeToToon } from "./toon.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { internalFetch } from "./internal-fetch.js";
import { toolError, toolSuccess } from "./tool-result.js";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";
const CLAUDE_CODE_BASE_URL = "http://coder:3002";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface BundleManifest {
  editable?: boolean;
  permissions?: string[];
  tools?: ToolManifest[];
  [key: string]: unknown;
}

interface ToolManifest {
  name: string;
  parameters?: Record<string, { type: string; description?: string }>;
  [key: string]: unknown;
}

interface TransportedFile {
  filename: string;
  data: string;
}

interface PluginRunResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

function isPluginRunResult(value: unknown): value is PluginRunResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["success"] === "boolean";
}

// Formats any plugin-runner management response for the agent. Responses with a
// "message" field (install, update, remove, configure, create) are extracted and
// optionally augmented with init_output and warnings. Responses without a "message"
// field (list, show) are TOON-encoded. Falls back to raw text if parsing or encoding
// fails, because message delivery matters more than formatting.
function formatPluginRunnerResponse(responseText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return responseText;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["message"] === "string") {
    let result = obj["message"];

    if (typeof obj["init_output"] === "string") {
      result += `\n\nInit script output:\n\`\`\`\n${obj["init_output"]}\n\`\`\``;
    }

    if (Array.isArray(obj["warnings"]) && obj["warnings"].length > 0) {
      const warnings = (obj["warnings"] as unknown[])
        .filter((w): w is string => typeof w === "string")
        .join("\n");
      if (warnings.length > 0) {
        result += `\n\nWarnings:\n${warnings}`;
      }
    }

    return result;
  }

  try {
    return encodeToToon(parsed);
  } catch {
    return responseText;
  }
}

function formatRunPluginToolResult(pluginName: string, toolName: string, responseText: string, statusCode: number): string {
  if (statusCode === 202) {
    return `Tool "${toolName}" (plugin "${pluginName}") is running asynchronously. The result will arrive when it completes.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (!isPluginRunResult(parsed)) {
    return responseText;
  }

  if (parsed.success) {
    const output = typeof parsed.output === "string" ? parsed.output : encodeToToon(parsed.output);
    return `The run of tool "${toolName}" (plugin "${pluginName}") returned:\n\`\`\`\n${output}\n\`\`\``;
  } else {
    const error = parsed.error ?? "Unknown error";
    return `The run of tool "${toolName}" (plugin "${pluginName}") failed:\n\`\`\`\n${error}\n\`\`\``;
  }
}

const MANAGE_PLUGINS_HELP_TEXT = `manage_plugins: install, update, remove, configure, list, show, or create plugins.

Actions:
- install: install a plugin from a git URL. Parameters: url (required).
- update: update an installed plugin to the latest version from its git repository. Parameters: name (required).
- remove: remove an installed plugin. Parameters: name (required).
- configure: set configuration values for a plugin. The config keys must match what the plugin's manifest declares. Parameters: name (required), config (required, JSON string). When a plugin requires sensitive values (API keys, tokens, passwords), tell the user they can either configure them through the settings page at /settings/plugins or paste the values in the chat. Any secrets the user provides must be treated as secrets: only pass them to this configure action, and never store, refer to, or repeat them in any other context (emails, messages, summaries, etc.).
- list: list all installed plugins. No additional parameters.
- show: show all tools in a plugin, including their names, descriptions, and parameter schemas. Parameters: name (required).
- create: create a new empty editable plugin. Parameters: name (required), plugin_description (required). Only available when the coder is configured.
- help: show this help text.`;

export function createManagePluginsTool(options: { coderEnabled: boolean }): AgentTool {
  return {
    name: "manage_plugins",
    label: "Manage plugins",
    description: "Install, update, remove, configure, list, show, or create plugins. Always use the 'help' action for guidance first.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("install"),
        Type.Literal("update"),
        Type.Literal("remove"),
        Type.Literal("configure"),
        Type.Literal("list"),
        Type.Literal("show"),
        Type.Literal("create"),
        Type.Literal("help"),
      ], { description: "Action to perform: install, update, remove, configure, list, show, create, or help." }),
      name: Type.Optional(Type.String({ description: "The plugin name. Required for update, remove, configure, show, and create." })),
      url: Type.Optional(Type.String({ description: "The git repository URL to clone. Required for install." })),
      config: Type.Optional(Type.String({ description: "JSON string of configuration values to set. Required for configure." })),
      plugin_description: Type.Optional(Type.String({ description: "A short description of what the plugin does. Required for create." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        name?: string;
        url?: string;
        config?: string;
        plugin_description?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return toolSuccess(MANAGE_PLUGINS_HELP_TEXT);
      }

      if (action === "install") {
        if (raw.url === undefined || raw.url.trim() === "") {
          return toolError("Error: url is required for install.");
        }
        const url = raw.url;
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const responseText = await response.text();
        return toolSuccess(formatPluginRunnerResponse(responseText));
      }

      if (action === "update") {
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for update.");
        }
        const name = raw.name;
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const responseText = await response.text();
        return toolSuccess(formatPluginRunnerResponse(responseText));
      }

      if (action === "remove") {
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for remove.");
        }
        const name = raw.name;
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const responseText = await response.text();
        return toolSuccess(formatPluginRunnerResponse(responseText));
      }

      if (action === "configure") {
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for configure.");
        }
        if (raw.config === undefined || raw.config.trim() === "") {
          return toolError("Error: config is required for configure.");
        }
        const name = raw.name;
        const config = raw.config;
        let parsedConfig: unknown;
        try {
          parsedConfig = JSON.parse(config);
        } catch {
          return toolError("Error: config is not valid JSON.");
        }
        // Plugin permissions are set via the web UI only. The LLM must not be
        // able to modify its own tool restrictions (user decision, see DECISIONLOG.md).
        if (typeof parsedConfig === "object" && parsedConfig !== null) {
          delete (parsedConfig as Record<string, unknown>)["permissions"];
        }
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, config: parsedConfig }),
        });
        const responseText = await response.text();
        return toolSuccess(formatPluginRunnerResponse(responseText));
      }

      if (action === "list") {
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
        const responseText = await response.text();
        let result: string;
        try {
          const parsed = JSON.parse(responseText) as unknown;
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "plugins" in parsed &&
            Array.isArray((parsed as Record<string, unknown>).plugins)
          ) {
            const obj = parsed as Record<string, unknown>;
            const plugins = (obj.plugins as unknown[]).filter((plugin) => {
              if (typeof plugin !== "object" || plugin === null) return true;
              const pluginObj = plugin as Record<string, unknown>;
              return !(Array.isArray(pluginObj.permissions) && pluginObj.permissions.length === 0);
            });
            const cleaned = plugins.map((plugin) => {
              if (typeof plugin === "object" && plugin !== null) {
                const { permissions, ...rest } = plugin as Record<string, unknown>;
                return rest;
              }
              return plugin;
            });
            result = formatPluginRunnerResponse(JSON.stringify({ ...obj, plugins: cleaned }));
          } else {
            result = formatPluginRunnerResponse(responseText);
          }
        } catch {
          result = formatPluginRunnerResponse(responseText);
        }
        return toolSuccess(result);
      }

      if (action === "show") {
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for show.");
        }
        const name = raw.name;
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${name}`);
        if (response.status === 404) {
          return toolSuccess(`Plugin '${name}' not found.`);
        }
        const responseText = await response.text();
        let result: string;
        try {
          const parsed = JSON.parse(responseText) as unknown;
          if (typeof parsed === "object" && parsed !== null) {
            const manifest = parsed as Record<string, unknown>;
            if (Array.isArray(manifest.permissions) && manifest.permissions.length === 0) {
              // Treat disabled plugins as not found so the LLM cannot discover them.
              result = `Plugin '${name}' not found.`;
            } else {
              if (
                Array.isArray(manifest.permissions) &&
                !manifest.permissions.includes("*") &&
                Array.isArray(manifest.tools)
              ) {
                const permittedTools = manifest.permissions as string[];
                const filteredTools = (manifest.tools as unknown[]).filter((tool) => {
                  if (typeof tool !== "object" || tool === null) return false;
                  const toolObj = tool as Record<string, unknown>;
                  return typeof toolObj.name === "string" && permittedTools.includes(toolObj.name);
                });
                const { permissions: _permissions, ...cleanManifest } = manifest;
                result = formatPluginRunnerResponse(JSON.stringify({ ...cleanManifest, tools: filteredTools }));
              } else {
                const { permissions: _permissions, ...cleanManifest } = manifest;
                result = formatPluginRunnerResponse(JSON.stringify(cleanManifest));
              }
            }
          } else {
            result = formatPluginRunnerResponse(responseText);
          }
        } catch {
          result = formatPluginRunnerResponse(responseText);
        }
        return toolSuccess(result);
      }

      if (action === "create") {
        if (!options.coderEnabled) {
          return toolError("Error: the create action requires the coder to be configured.");
        }
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for create.");
        }
        if (raw.plugin_description === undefined || raw.plugin_description.trim() === "") {
          return toolError("Error: plugin_description is required for create.");
        }
        const name = raw.name;
        const description = raw.plugin_description;
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description }),
        });
        const responseText = await response.text();
        return toolSuccess(formatPluginRunnerResponse(responseText));
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: install, update, remove, configure, list, show, create, help.`);
    },
  };
}

// Resolves parameters declared as type "file" in the tool manifest from file paths
// to TransportedFile objects. Parameters of other types are passed through unchanged.
// If the tool is not found in the manifest, parameters are returned as-is.
async function resolveFileParameters(
  plugin: string,
  tool: string,
  manifest: unknown,
  parameters: unknown,
): Promise<unknown> {
  if (
    !isBundleManifest(manifest) ||
    !Array.isArray(manifest.tools) ||
    typeof parameters !== "object" ||
    parameters === null
  ) {
    return parameters;
  }

  const toolManifest = manifest.tools.find((t) => t.name === tool);
  if (toolManifest === undefined || toolManifest.parameters === undefined) {
    return parameters;
  }

  const params = parameters as Record<string, unknown>;
  const resolved: Record<string, unknown> = { ...params };

  for (const [key, schema] of Object.entries(toolManifest.parameters)) {
    if (schema.type !== "file") continue;
    const value = params[key];
    if (typeof value !== "string") continue;

    const resolvedPath = path.resolve(value);
    const tempDir = path.resolve(TEMP_ATTACHMENTS_DIR);
    if (!resolvedPath.startsWith(tempDir + path.sep) && resolvedPath !== tempDir) {
      throw new Error(`File parameter '${key}' path is not under the allowed directory: ${value}`);
    }

    const data = await fs.readFile(resolvedPath);
    const transportedFile: TransportedFile = {
      filename: path.basename(resolvedPath),
      data: data.toString("base64"),
    };
    resolved[key] = transportedFile;
    log.debug(`[stavrobot] run_plugin_tool: resolved file parameter '${key}' for plugin '${plugin}', tool '${tool}'`);
  }

  return resolved;
}

export function createRunPluginToolTool(): AgentTool {
  return {
    name: "run_plugin_tool",
    label: "Run plugin tool",
    description: "Run a tool from an installed plugin with the given parameters. The parameters must match the tool's schema as shown by manage_plugins (action: show). For parameters with type \"file\", pass the absolute path to the file (e.g. a path returned by manage_files or received as an incoming attachment).",
    parameters: Type.Object({
      plugin: Type.String({ description: "The plugin name." }),
      tool: Type.String({ description: "The tool name." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { plugin, tool, parameters } = params as { plugin: string; tool: string; parameters: string };
      const parsedParameters = JSON.parse(parameters) as unknown;

      const bundleResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}`);
      if (bundleResponse.status === 404) {
        return toolSuccess(`Plugin '${plugin}' not found.`);
      }
      const bundleText = await bundleResponse.text();
      let manifest: unknown;
      try {
        manifest = JSON.parse(bundleText) as unknown;
      } catch {
        return toolSuccess(`Failed to parse plugin manifest for '${plugin}'.`);
      }
      if (isBundleManifest(manifest) && Array.isArray(manifest.permissions)) {
        const permissions = manifest.permissions as string[];
        if (permissions.length === 0) {
          log.debug(`[stavrobot] run_plugin_tool: rejected '${plugin}/${tool}' — plugin is disabled`);
          return toolSuccess(`Plugin '${plugin}' not found.`);
        }
        if (!permissions.includes("*") && !permissions.includes(tool)) {
          const availableTools = Array.isArray(manifest.tools)
            ? (manifest.tools as ToolManifest[]).filter(
                (t) => typeof t.name === "string" && permissions.includes(t.name)
              )
            : [];
          const availablePart =
            availableTools.length > 0
              ? ` Available tools: ${formatAvailableTools(availableTools)}`
              : "";
          const result = `Tool '${tool}' not found on plugin '${plugin}'.${availablePart}`;
          log.debug(`[stavrobot] run_plugin_tool: rejected '${plugin}/${tool}' — tool not in permissions list`);
          return toolSuccess(result);
        }
      }

      const pluginFilesDir = path.join(TEMP_ATTACHMENTS_DIR, plugin);
      // Clear stale files from previous runs.
      await fs.rm(pluginFilesDir, { recursive: true, force: true });

      const resolvedParameters = await resolveFileParameters(plugin, tool, manifest, parsedParameters);

      const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}/tools/${tool}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resolvedParameters),
      });
      const responseText = await response.text();
      let result = formatRunPluginToolResult(plugin, tool, responseText, response.status);

      let filesDir: string | undefined;
      try {
        const parsed = JSON.parse(responseText) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "files" in parsed &&
          Array.isArray((parsed as Record<string, unknown>).files)
        ) {
          const files = (parsed as Record<string, unknown>).files as unknown[];
          const validFiles = files.filter(
            (f): f is { filename: string; data: string } =>
              typeof f === "object" &&
              f !== null &&
              typeof (f as Record<string, unknown>).filename === "string" &&
              typeof (f as Record<string, unknown>).data === "string"
          );
          if (validFiles.length > 0) {
            await fs.mkdir(pluginFilesDir, { recursive: true });
            for (const file of validFiles) {
              const filePath = path.join(pluginFilesDir, file.filename);
              await fs.writeFile(filePath, Buffer.from(file.data, "base64"));
            }
            filesDir = pluginFilesDir;
            log.debug(`[stavrobot] run_plugin_tool: saved ${validFiles.length} file(s) to ${pluginFilesDir}`);
          }
        }
      } catch {
        // If JSON parsing fails here, formatRunPluginToolResult already handled it.
      }

      if (filesDir !== undefined) {
        const entries = await fs.readdir(filesDir);
        const lines = await Promise.all(
          entries.map(async (entry) => {
            const filePath = path.join(filesDir, entry);
            const stat = await fs.stat(filePath);
            return `- ${filePath} (${formatFileSize(stat.size)})`;
          }),
        );
        result += `\n\nOutput files:\n${lines.join("\n")}`;
      }

      return toolSuccess(result);
    },
  };
}

function isBundleManifest(value: unknown): value is BundleManifest {
  return typeof value === "object" && value !== null;
}

function formatAvailableTools(tools: ToolManifest[]): string {
  return tools
    .map((t) => {
      const params = t.parameters !== undefined
        ? Object.entries(t.parameters)
            .map(([name, schema]) => `${name}: ${schema.type}`)
            .join(", ")
        : "";
      return params.length > 0 ? `${t.name} (${params})` : t.name;
    })
    .join(", ");
}

export function createRequestCodingTaskTool(): AgentTool {
  return {
    name: "request_coding_task",
    label: "Request coding task",
    description: "Send a coding task to the coding agent to create or modify a specific plugin. The plugin must be editable (locally created, not installed from a git repository). This is asynchronous — the result will arrive later as a message from the coder agent. Describe what you want clearly and completely.",
    parameters: Type.Object({
      plugin: Type.String({ description: "The name of the plugin to create or modify. Must be an editable (locally created) plugin." }),
      message: Type.String({ description: "A detailed description of what to create or modify in the plugin." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { plugin, message } = params as { plugin: string; message: string };

      const bundleResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}`);
      if (bundleResponse.status === 404) {
        return toolSuccess(`Plugin '${plugin}' not found. Create it first with manage_plugins (action: create).`);
      }

      const bundleText = await bundleResponse.text();
      let manifest: unknown;
      try {
        manifest = JSON.parse(bundleText) as unknown;
      } catch {
        return toolSuccess(`Failed to parse plugin manifest for '${plugin}'.`);
      }

      if (!isBundleManifest(manifest) || manifest.editable !== true) {
        return toolSuccess(`Plugin '${plugin}' is not editable. Only locally created plugins can be modified by the coding agent.`);
      }

      const taskId = crypto.randomUUID();
      log.debug("[stavrobot] request_coding_task submitting: taskId", taskId, "plugin:", plugin, "message:", message);
      await internalFetch(`${CLAUDE_CODE_BASE_URL}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, plugin, message }),
      });
      return toolSuccess(`Coding task ${taskId} submitted for plugin '${plugin}'. The coder agent will respond when done.`);
    },
  };
}
