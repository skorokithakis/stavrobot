import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createAgent as createAgentInDb,
  updateAgent,
  listAgents,
  getMainAgentId,
} from "./database.js";
import { encodeToToon } from "./toon.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";

const SUBAGENT_TOOL_ALLOWLIST = new Set([
  "send_signal_message",
  "send_telegram_message",
  "send_whatsapp_message",
  "send_email",
  "manage_files",
  "manage_uploads",
  "run_python",
  "db_search",
]);

function buildHelpText(): string {
  const mainAgentId = getMainAgentId();
  return `manage_agents tool — full documentation

Actions:

help — Show this documentation.

create — Create a new subagent.
  name (required): A short, descriptive name for the agent.
  system_prompt (required): The agent's specific instructions, context, and constraints. This is appended to the base agent prompt. Write it as if you're briefing a colleague on a task — include what the agent should do, what information it has, and what constraints it must follow.
  allowed_tools (optional): Whitelist of core tool names the agent may use. Defaults to [] (no tools). Allowed values: send_signal_message, send_telegram_message, send_whatsapp_message, send_email, manage_files, manage_uploads, run_python, db_search. Use dot notation to scope to specific actions: "manage_uploads.read" allows only the read action of that tool. send_agent_message is always available to all agents — do not include it here. If allowed_plugins is non-empty, run_plugin_tool is implicitly available — do not include it here either.
  allowed_plugins (optional): Whitelist of plugins the agent may use. Defaults to [] (no plugins). Use ["*"] to allow all plugins, ["weather"] to allow all tools in the weather plugin, or ["weather.get_forecast"] to allow a specific tool. Empty list or omission means no plugin access. When non-empty, run_plugin_tool is implicitly available.
  Returns the new agent's ID.

update — Update an existing agent's fields. Only provided fields are updated. Refuses to modify agent ${mainAgentId} (the main agent).
  id (required): Agent ID.
  name (optional): New name.
  system_prompt (optional): New system prompt.
  allowed_tools (optional): New allowed tools list.
  allowed_plugins (optional): New allowed plugins list.

list — List all agents. No parameters.

---

Guidance on creating subagents:

- Give agents the minimum tool privileges needed for their task. Start with fewer tools; the subagent can ask for more via send_agent_message.
- Match the channel tool to the task. If the subagent's job is to handle an email conversation, give it send_email — not send_signal_message. A subagent can only message its assigned interlocutor, so the tool must match the channel the interlocutor uses.
- send_agent_message is always available to all agents regardless of their allowed_tools list — do not include it in the list.
- The allowed_tools field is a whitelist: [] means no tools, and an explicit list like ["send_telegram_message"] means only those tools. Use dot notation to restrict to specific actions: ["manage_uploads.read", "manage_uploads.write"] allows only read and write.
- Always scope plugin access to the specific tools needed. Use dot notation: ["caldav.list_events", "caldav.get_event"] rather than ["caldav"]. Granting a whole plugin or ["*"] gives the subagent access to every tool in that plugin, including destructive ones — only do this when every tool is genuinely needed.
- The subagent's system prompt automatically includes the list of available plugins and their tools, so the subagent will know what it can use — you do not need to describe the plugins in the system_prompt.
- Provide the subagent with all the information it needs to perform its task in the system_prompt field, but no more than necessary. Information about the person it's talking to, the places or facts of the task, etc are especially helpful.
- Instruct the subagent to ask the main agent (agent ${mainAgentId}) if it needs information or tools it doesn't have.
- After creating a subagent, send it its first task via send_agent_message.

Guidance on the system_prompt field:

This is appended to a base agent prompt. It should contain the subagent's specific instructions, context, and constraints. Write it as if you're briefing a colleague on a task: what they should do, what they know, and what they must not do.

Note: agent ${mainAgentId} is the main agent and cannot be modified via this tool.`;
}

function validateAllowedTools(allowedTools: string[]): string[] {
  return allowedTools.filter((entry) => {
    const toolName = entry.includes(".") ? entry.split(".")[0] : entry;
    return !SUBAGENT_TOOL_ALLOWLIST.has(toolName);
  });
}

function validateAllowedPlugins(allowedPlugins: string[]): string[] {
  // Each entry must be "*" or a non-empty string with no leading/trailing dots and no double dots.
  return allowedPlugins.filter((entry) => {
    if (entry === "*") return false;
    if (entry.length === 0) return true;
    if (entry.startsWith(".") || entry.endsWith(".")) return true;
    if (entry.includes("..")) return true;
    return false;
  });
}

export function createManageAgentsTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_agents",
    label: "Manage agents",
    description: `Manage subagents — LLM agents that can be created to perform specific tasks. Each agent has a name, a system prompt, and a list of allowed tools. Use the "help" action to learn how to use this tool.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("help"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("list"),
      ]),
      id: Type.Optional(Type.Number()),
      name: Type.Optional(Type.String()),
      system_prompt: Type.Optional(Type.String()),
      allowed_tools: Type.Optional(Type.Array(Type.String())),
      allowed_plugins: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        id?: number;
        name?: string;
        system_prompt?: string;
        allowed_tools?: string[];
        allowed_plugins?: string[];
      };

      const { action } = raw;

      if (action === "help") {
        return toolSuccess(buildHelpText());
      }

      if (action === "create") {
        if (raw.name === undefined || raw.name.trim() === "") {
          return toolError("Error: name is required for create.");
        }
        if (raw.system_prompt === undefined) {
          return toolError("Error: system_prompt is required for create.");
        }

        const allowedTools = raw.allowed_tools ?? [];
        const allowedPlugins = raw.allowed_plugins ?? [];

        const invalidTools = validateAllowedTools(allowedTools);
        if (invalidTools.length > 0) {
          return toolError(`Error: invalid allowed_tools entries: ${invalidTools.join(", ")}. Allowed tools: ${[...SUBAGENT_TOOL_ALLOWLIST].join(", ")}.`);
        }

        const invalidPlugins = validateAllowedPlugins(allowedPlugins);
        if (invalidPlugins.length > 0) {
          return toolError(`Error: invalid allowed_plugins entries: ${invalidPlugins.join(", ")}. Each entry must be "*", a plugin name, or "pluginname.toolname".`);
        }

        const newId = await createAgentInDb(pool, raw.name.trim(), raw.system_prompt, allowedTools, allowedPlugins);
        const message = `Agent ${newId} created.`;
        log.info(`[stavrobot] ${message}`);
        return toolSuccess(message);
      }

      if (action === "update") {
        if (raw.id === undefined) {
          return toolError("Error: id is required for update.");
        }
        if (raw.id === getMainAgentId()) {
          return toolError(`Error: Cannot modify agent ${getMainAgentId()} (the main agent).`);
        }

        const fields: { name?: string; systemPrompt?: string; allowedTools?: string[]; allowedPlugins?: string[] } = {};
        if (raw.name !== undefined) {
          fields.name = raw.name.trim();
        }
        if (raw.system_prompt !== undefined) {
          fields.systemPrompt = raw.system_prompt;
        }
        if (raw.allowed_tools !== undefined) {
          fields.allowedTools = raw.allowed_tools;
        }
        if (raw.allowed_plugins !== undefined) {
          fields.allowedPlugins = raw.allowed_plugins;
        }

        if (Object.keys(fields).length === 0) {
          return toolError("Error: no fields to update. Provide at least one of name, system_prompt, allowed_tools, or allowed_plugins.");
        }

        if (fields.allowedTools !== undefined) {
          const invalidTools = validateAllowedTools(fields.allowedTools);
          if (invalidTools.length > 0) {
            return toolError(`Error: invalid allowed_tools entries: ${invalidTools.join(", ")}. Allowed tools: ${[...SUBAGENT_TOOL_ALLOWLIST].join(", ")}.`);
          }
        }

        if (fields.allowedPlugins !== undefined) {
          const invalidPlugins = validateAllowedPlugins(fields.allowedPlugins);
          if (invalidPlugins.length > 0) {
            return toolError(`Error: invalid allowed_plugins entries: ${invalidPlugins.join(", ")}. Each entry must be "*", a plugin name, or "pluginname.toolname".`);
          }
        }

        await updateAgent(pool, raw.id, fields);
        const message = `Agent ${raw.id} updated.`;
        log.info(`[stavrobot] ${message}`);
        return toolSuccess(message);
      }

      if (action === "list") {
        const agents = await listAgents(pool);
        return toolSuccess(encodeToToon(agents));
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: help, create, update, list.`);
    },
  };
}
