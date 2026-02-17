import pg from "pg";
import { Type, getModel, type TextContent, complete, type AssistantMessage } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { executeSql, loadMessages, saveMessage, readMemory, updateMemory, saveCompaction, loadLatestCompaction } from "./database.js";

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
  const tools = [createExecuteSqlTool(pool), createUpdateMemoryTool(pool)];

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

function serializeMessagesForSummary(messages: AgentMessage[]): string {
  const lines: string[] = [];
  
  for (const message of messages) {
    if (message.role === "user") {
      let textContent: string;
      if (typeof message.content === "string") {
        textContent = message.content;
      } else {
        const content = Array.isArray(message.content) ? message.content : [];
        textContent = content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("");
      }
      lines.push(`User: ${textContent}`);
    } else if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const textContent = content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (textContent) {
        lines.push(`Assistant: ${textContent}`);
      }
    } else if (message.role === "toolResult") {
      const content = Array.isArray(message.content) ? message.content : [];
      const textContent = content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");
      lines.push(`Tool result (${message.toolName}): ${textContent}`);
    }
  }
  
  return lines.join("\n");
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string,
  config: Config
): Promise<string> {
  const memory = await readMemory(pool);
  
  if (memory === "") {
    agent.setSystemPrompt(config.systemPrompt);
  } else {
    const systemPromptWithMemory = `${config.systemPrompt}\n\n<memory>\n${memory}\n</memory>`;
    agent.setSystemPrompt(systemPromptWithMemory);
  }

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

  if (agent.state.messages.length > 40) {
    const currentMessages = agent.state.messages;
    const messagesToCompact = currentMessages.slice(0, -20);
    const messagesToKeep = currentMessages.slice(-20);

    const serializedMessages = serializeMessagesForSummary(messagesToCompact);
    const summarySystemPrompt = "Summarize the following conversation concisely. Preserve all important facts, decisions, user preferences, and context. The summary will replace these messages in the conversation history.";
    
    const response = await complete(
      agent.state.model,
      {
        systemPrompt: summarySystemPrompt,
        messages: [
          {
            role: "user" as const,
            content: serializedMessages,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: config.apiKey }
    );

    const summaryText = response.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");

    const previousCompaction = await loadLatestCompaction(pool);
    const previousBoundary = previousCompaction ? previousCompaction.upToMessageId : 0;
    
    const cutoffResult = await pool.query(
      "SELECT id FROM messages WHERE id > $1 ORDER BY id DESC LIMIT 1 OFFSET 19",
      [previousBoundary]
    );
    const upToMessageId = cutoffResult.rows[0].id as number;

    await saveCompaction(pool, summaryText, upToMessageId);

    const syntheticMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: summaryText }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "synthetic-compaction",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const newMessages = [syntheticMessage, ...messagesToKeep];
    agent.replaceMessages(newMessages);
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
