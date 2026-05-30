import type { AgentTool } from "@earendil-works/pi-agent-core";
import { internalFetch } from "../internal-fetch.js";
import { log } from "../log.js";
import { toolError } from "../tool-result.js";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

/**
 * Parses an allowed_tools list and returns the filtered (and possibly wrapped)
 * tool list for a subagent. `send_agent_message` is always included.
 *
 * Entries without a dot grant full access to that tool. Entries with a dot
 * (e.g. "manage_interlocutors.list") restrict the tool to only the named
 * action. Multiple dotted entries for the same tool combine. A bare name
 * takes precedence over any dotted entries for the same tool.
 *
 * `run_plugin_tool` is controlled exclusively by `allowedPlugins`, not by
 * `allowedTools`. If `allowedPlugins` is empty, `run_plugin_tool` is excluded.
 * If it contains `"*"`, `run_plugin_tool` is included as-is. Otherwise,
 * `run_plugin_tool` is included with its execute wrapped to enforce access.
 */
export function filterToolsForSubagent(tools: AgentTool[], allowedTools: string[], allowedPlugins: string[]): AgentTool[] {
  // Always include send_agent_message regardless of the whitelist.
  const fullyAllowed = new Set<string>(["send_agent_message"]);
  const actionMap = new Map<string, Set<string>>();

  for (const entry of allowedTools) {
    const dotIndex = entry.indexOf(".");
    if (dotIndex === -1) {
      // run_plugin_tool is controlled by allowedPlugins, not allowedTools.
      if (entry !== "run_plugin_tool") {
        fullyAllowed.add(entry);
      }
    } else {
      const toolName = entry.slice(0, dotIndex);
      const action = entry.slice(dotIndex + 1);
      if (!actionMap.has(toolName)) {
        actionMap.set(toolName, new Set());
      }
      actionMap.get(toolName)!.add(action);
    }
  }

  const result: AgentTool[] = [];

  for (const tool of tools) {
    if (tool.name === "run_plugin_tool") {
      // run_plugin_tool is handled separately based on allowedPlugins.
      if (allowedPlugins.length === 0) {
        // No plugin access: exclude run_plugin_tool entirely.
        continue;
      }
      if (allowedPlugins.includes("*")) {
        // Wildcard: include as-is, all plugins allowed.
        result.push(tool);
      } else {
        // Specific plugins: wrap execute to enforce per-plugin/tool access.
        const pluginAccessMap = buildPluginAccessMap(allowedPlugins);
        const originalExecute = tool.execute;
        const wrappedTool: AgentTool = {
          ...tool,
          execute: async (toolCallId, params, signal, onUpdate) => {
            const raw = params as Record<string, unknown>;
            const pluginName = typeof raw["plugin"] === "string" ? raw["plugin"] : undefined;
            const toolName = typeof raw["tool"] === "string" ? raw["tool"] : undefined;
            if (pluginName === undefined || toolName === undefined) {
              return originalExecute(toolCallId, params, signal, onUpdate);
            }
            const access = pluginAccessMap.get(pluginName);
            if (access === undefined) {
              return toolError(`Plugin '${pluginName}' (tool '${toolName}') is not in this agent's allowed plugins.`);
            }
            if (access !== "*" && !access.has(toolName)) {
              return toolError(`Plugin '${pluginName}' (tool '${toolName}') is not in this agent's allowed plugins.`);
            }
            return originalExecute(toolCallId, params, signal, onUpdate);
          },
        };
        result.push(wrappedTool);
      }
      continue;
    }

    if (fullyAllowed.has(tool.name)) {
      // Bare name entry: include as-is, all actions allowed.
      result.push(tool);
    } else if (actionMap.has(tool.name)) {
      // Dotted entries only: wrap execute to enforce action-level filtering.
      const allowedActions = actionMap.get(tool.name)!;
      const toolName = tool.name;
      const originalExecute = tool.execute;
      const list = [...allowedActions].sort().join(", ");
      const wrappedTool: AgentTool = {
        ...tool,
        description: `${tool.description} (Restricted to actions: ${list}.)`,
        execute: async (toolCallId, params, signal, onUpdate) => {
          const action = (params as Record<string, unknown>)["action"];
          if (typeof action !== "string") {
            return toolError(`Tool "${toolName}" requires an action parameter because it is scoped to specific actions. Allowed actions: ${list}.`);
          }
          if (!allowedActions.has(action)) {
            return toolError(`Action "${action}" is not allowed on tool "${toolName}". Allowed actions: ${list}.`);
          }
          return originalExecute(toolCallId, params, signal, onUpdate);
        },
      };
      result.push(wrappedTool);
    }
    // Otherwise: tool is not in the whitelist, exclude it.
  }

  return result;
}

/**
 * Parses an allowedPlugins array into a map of pluginName -> Set<toolName> | "*".
 * A bare plugin name (e.g. "weather") maps to "*" (all tools allowed).
 * A dotted entry (e.g. "weather.get_forecast") maps to a set of allowed tool names.
 * Multiple dotted entries for the same plugin are combined into one set.
 */
export function buildPluginAccessMap(allowedPlugins: string[]): Map<string, Set<string> | "*"> {
  const map = new Map<string, Set<string> | "*">();
  for (const entry of allowedPlugins) {
    const dotIndex = entry.indexOf(".");
    if (dotIndex === -1) {
      // Bare plugin name: all tools in this plugin are allowed.
      map.set(entry, "*");
    } else {
      const pluginName = entry.slice(0, dotIndex);
      const toolName = entry.slice(dotIndex + 1);
      // A bare entry for the same plugin takes precedence over dotted entries.
      if (map.get(pluginName) !== "*") {
        if (!map.has(pluginName)) {
          map.set(pluginName, new Set());
        }
        (map.get(pluginName) as Set<string>).add(toolName);
      }
    }
  }
  return map;
}

interface PluginSummary {
  name: string;
  description: string;
  editable: boolean;
  permissions: string[];
}

export interface PluginEntry {
  name: string;
  description: string;
}

interface PluginManifestTool {
  name: string;
  [key: string]: unknown;
}

interface PluginManifest {
  tools?: PluginManifestTool[];
  permissions?: string[];
  [key: string]: unknown;
}

export async function fetchPluginList(): Promise<PluginEntry[] | undefined> {
  try {
    const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
    if (!response.ok) {
      log.warn(`[stavrobot] fetchPluginList: plugin runner returned ${response.status}`);
      return undefined;
    }
    const data = await response.json() as { plugins: PluginSummary[] };
    // Skip plugins with an empty permissions array — they are soft-disabled.
    // Guard against missing permissions (e.g., during rolling deploys) by treating it as visible.
    const visiblePlugins = data.plugins.filter((plugin) => !Array.isArray(plugin.permissions) || plugin.permissions.length > 0);
    return visiblePlugins.map((plugin) => ({ name: plugin.name, description: plugin.description }));
  } catch (error) {
    log.warn("[stavrobot] fetchPluginList: failed to fetch plugin list:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Fetches the manifest for each plugin and returns a map of plugin name to the
 * list of tool names the agent is allowed to use. The `accessMap` controls which
 * tools are visible: a "*" entry means all tools in the manifest are included,
 * while a Set entry restricts to only those tool names. Fetches are done in
 * parallel; failures for individual plugins are logged and skipped.
 */
export async function fetchPluginDetails(
  pluginNames: string[],
  accessMap: Map<string, Set<string> | "*">,
): Promise<Map<string, string[]>> {
  const results = await Promise.all(
    pluginNames.map(async (name): Promise<[string, string[]] | null> => {
      try {
        const response = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${name}`);
        if (!response.ok) {
          log.warn(`[stavrobot] fetchPluginDetails: plugin runner returned ${response.status} for plugin "${name}"`);
          return null;
        }
        const manifest = await response.json() as PluginManifest;
        const allTools = manifest.tools ?? [];
        const access = accessMap.get(name);
        let visibleTools: string[];
        if (access === "*") {
          visibleTools = allTools.map((tool) => tool.name);
        } else if (access instanceof Set) {
          // Only include tools the agent has explicit access to.
          visibleTools = allTools.map((tool) => tool.name).filter((toolName) => (access as Set<string>).has(toolName));
        } else {
          visibleTools = [];
        }
        return [name, visibleTools];
      } catch (error) {
        log.warn(`[stavrobot] fetchPluginDetails: failed to fetch manifest for plugin "${name}":`, error instanceof Error ? error.message : String(error));
        return null;
      }
    }),
  );
  const map = new Map<string, string[]>();
  for (const result of results) {
    if (result !== null) {
      map.set(result[0], result[1]);
    }
  }
  return map;
}

export function formatPluginListSection(plugins: PluginEntry[], toolDetails?: Map<string, string[]>): string {
  const lines = ["Available plugins:"];
  for (const plugin of plugins) {
    lines.push(`- ${plugin.name}: ${plugin.description}`);
    if (toolDetails !== undefined) {
      const tools = toolDetails.get(plugin.name);
      if (tools !== undefined && tools.length > 0) {
        lines.push(`  Tools: ${tools.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}
