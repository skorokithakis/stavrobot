import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createAgent as createAgentInDb,
  updateAgent,
  listAgents,
} from "./database.js";
import { encodeToToon } from "./toon.js";

const HELP_TEXT = `manage_agents tool — full documentation

Actions:

help — Show this documentation.

create — Create a new subagent.
  name (required): A short, descriptive name for the agent.
  system_prompt (required): The agent's specific instructions, context, and constraints. This is appended to the base agent prompt. Write it as if you're briefing a colleague on a task — include what the agent should do, what information it has, and what constraints it must follow.
  allowed_tools (optional): Whitelist of tool names the agent may use. Defaults to [] (no tools). An explicit list like ["send_telegram_message"] means only those tools are available. Use dot notation to scope to specific actions: "manage_interlocutors.list" allows only the list action of that tool. send_agent_message is always available to all agents regardless of this list — do not include it here.
  Returns the new agent's ID.

update — Update an existing agent's fields. Only provided fields are updated. Refuses to modify agent 1 (the main agent).
  id (required): Agent ID.
  name (optional): New name.
  system_prompt (optional): New system prompt.
  allowed_tools (optional): New allowed tools list.

list — List all agents. No parameters.

---

Guidance on creating subagents:

- Give agents the minimum tool privileges needed for their task. Start with fewer tools; the subagent can ask for more via send_agent_message.
- send_agent_message is always available to all agents regardless of their allowed_tools list — do not include it in the list.
- The allowed_tools field is a whitelist: [] means no tools, and an explicit list like ["send_telegram_message"] means only those tools. Use dot notation to restrict to specific actions: ["manage_interlocutors.list", "manage_interlocutors.create"] allows only list and create.
- Almost never give a subagent execute_sql — it can read the entire database and escalate its own privileges.
- Provide the subagent with all the information it needs to perform its task in the system_prompt field, but no more than necessary. Information about the person it's talking to, the places or facts of the task, etc are especially helpful.
- Instruct the subagent to ask the main agent (agent 1) if it needs information or tools it doesn't have.
- After creating a subagent, send it its first task via send_agent_message.

Guidance on the system_prompt field:

This is appended to a base agent prompt. It should contain the subagent's specific instructions, context, and constraints. Write it as if you're briefing a colleague on a task: what they should do, what they know, and what they must not do.

Note: agent 1 is the main agent and cannot be modified via this tool.`;

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
      };

      const { action } = raw;

      console.log(`[stavrobot] manage_agents called: action=${action} id=${raw.id}`);
      if (process.env.STAVROBOT_DEBUG === "1") {
        console.log(`[stavrobot] [debug] manage_agents: ${JSON.stringify(raw)}`);
      }

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: HELP_TEXT }],
          details: { message: HELP_TEXT },
        };
      }

      if (action === "create") {
        if (raw.name === undefined || raw.name.trim() === "") {
          const errorMessage = "Error: name is required for create.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.system_prompt === undefined) {
          const errorMessage = "Error: system_prompt is required for create.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const allowedTools = raw.allowed_tools ?? [];
        const newId = await createAgentInDb(pool, raw.name.trim(), raw.system_prompt, allowedTools);
        const message = `Agent ${newId} created.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "update") {
        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for update.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.id === 1) {
          const errorMessage = "Error: Cannot modify agent 1 (the main agent).";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const fields: { name?: string; systemPrompt?: string; allowedTools?: string[] } = {};
        if (raw.name !== undefined) {
          fields.name = raw.name.trim();
        }
        if (raw.system_prompt !== undefined) {
          fields.systemPrompt = raw.system_prompt;
        }
        if (raw.allowed_tools !== undefined) {
          fields.allowedTools = raw.allowed_tools;
        }

        if (Object.keys(fields).length === 0) {
          const errorMessage = "Error: no fields to update. Provide at least one of name, system_prompt, or allowed_tools.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        await updateAgent(pool, raw.id, fields);
        const message = `Agent ${raw.id} updated.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "list") {
        const agents = await listAgents(pool);
        const message = encodeToToon(agents);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: help, create, update, list.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { message: errorMessage },
      };
    },
  };
}
