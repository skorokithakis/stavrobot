import pg from "pg";
import { Type, getModel, type TextContent } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { executeSql, loadMessages, saveMessage, readMemory, updateMemory } from "./database.js";

export function createExecuteSqlTool(pool: pg.Pool): AgentTool {
  return {
    name: "execute_sql",
    label: "Execute SQL",
    description: "Execute arbitrary SQL queries against the PostgreSQL database. Supports all SQL operations including CREATE TABLE, INSERT, UPDATE, DELETE, SELECT, ALTER TABLE, DROP TABLE, and more. Use this to store and retrieve any information in the database.",
    parameters: Type.Object({
      query: Type.String({ description: "The SQL query to execute" }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { query } = params as { query: string };
      const result = await executeSql(pool, query);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createUpdateMemoryTool(pool: pg.Pool): AgentTool {
  return {
    name: "update_memory",
    label: "Update memory",
    description: "Update your persistent memory. This memory is injected into your system prompt at the start of every session, so use it to store important facts, user preferences, and context that should persist. Pass the complete new memory content — this replaces the entire memory. Pass an empty string to clear it.",
    parameters: Type.Object({
      content: Type.String({ description: "The complete new memory content. Replaces the entire existing memory." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { content } = params as { content: string };
      await updateMemory(pool, content);
      const message = content === "" ? "Memory cleared." : "Memory updated.";
      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export async function createAgent(config: Config, pool: pg.Pool): Promise<Agent> {
  const model = getModel(config.provider as any, config.model as any);
  const messages = await loadMessages(pool);
  const tools = [createExecuteSqlTool(pool)];

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools,
      messages,
    },
    getApiKey: () => config.apiKey,
  });

  return agent;
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string
): Promise<string> {
  const savePromises: Promise<void>[] = [];

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message;
      if (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      ) {
        savePromises.push(saveMessage(pool, message));
      }
    }
  });

  try {
    await agent.prompt(userMessage);
  } finally {
    unsubscribe();
    await Promise.all(savePromises);
  }

  const lastAssistantMessage = agent.state.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistantMessage) {
    return "";
  }

  const responseText = lastAssistantMessage.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  return responseText;
}
