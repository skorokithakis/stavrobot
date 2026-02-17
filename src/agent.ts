import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { Type, getModel, type TextContent, complete } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config, TtsConfig } from "./config.js";
import { getApiKey } from "./auth.js";
import { executeSql, loadMessages, saveMessage, saveCompaction, loadLatestCompaction, loadAllMemories, upsertMemory, deleteMemory, createCronEntry, updateCronEntry, deleteCronEntry, listCronEntries, type Memory } from "./database.js";
import { reloadScheduler } from "./scheduler.js";

// A simple boolean flag to prevent concurrent compaction runs. If a compaction
// is already in progress when another request triggers the threshold, we skip
// rather than queue, because queuing would compact already-compacted messages.
let compactionInProgress = false;

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
    description: "Create or update a persistent memory. To create a new memory, omit the id. To update an existing memory, provide its id. Memories persist across sessions and are shown to you at the start of every conversation.",
    parameters: Type.Object({
      id: Type.Optional(Type.Number({ description: "The id of the memory to update. Omit to create a new memory." })),
      content: Type.String({ description: "The content of the memory." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { id, content } = params as { id?: number; content: string };
      const memoryId = await upsertMemory(pool, id, content);
      const message = id === undefined ? `Memory ${memoryId} created.` : `Memory ${memoryId} updated.`;
      console.log(`[stavrobot] ${message} Content: ${content}`);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export function createDeleteMemoryTool(pool: pg.Pool): AgentTool {
  return {
    name: "delete_memory",
    label: "Delete memory",
    description: "Delete a persistent memory by its id.",
    parameters: Type.Object({
      id: Type.Number({ description: "The id of the memory to delete." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { id } = params as { id: number };
      await deleteMemory(pool, id);
      const message = `Memory ${id} deleted.`;
      console.log(`[stavrobot] ${message}`);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export function createTextToSpeechTool(ttsConfig: TtsConfig): AgentTool {
  return {
    name: "text_to_speech",
    label: "Text to speech",
    description: "Convert text to speech audio. Returns a file path to the generated audio file. Use this to create voice notes that can be sent via send_signal_message.",
    parameters: Type.Object({
      text: Type.String({ description: "The text to convert to speech." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ filePath: string }>> => {
      const { text } = params as { text: string };

      console.log("[stavrobot] text_to_speech called: text length", text.length);

      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ttsConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: ttsConfig.model, voice: ttsConfig.voice, input: text }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI TTS API error ${response.status}: ${errorText}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tts-"));
      const filePath = path.join(tempDirectory, "audio.mp3");
      await fs.writeFile(filePath, audioBuffer);

      console.log("[stavrobot] text_to_speech result:", filePath);

      return {
        content: [{ type: "text" as const, text: filePath }],
        details: { filePath },
      };
    },
  };
}

export function createSendSignalMessageTool(): AgentTool {
  return {
    name: "send_signal_message",
    label: "Send Signal message",
    description: "Send a message via Signal to a phone number. Can send text, an audio voice note (from a file path returned by text_to_speech), or both.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Phone number in international format (e.g., \"+1234567890\")." }),
      message: Type.Optional(Type.String({ description: "Text message to send." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment (e.g., from text_to_speech tool output)." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        recipient: string;
        message?: string;
        attachmentPath?: string;
      };

      const recipient = raw.recipient;
      const message = raw.message?.trim() || undefined;
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      console.log("[stavrobot] send_signal_message called:", { recipient, hasAttachment: attachmentPath !== undefined });

      if (message === undefined && attachmentPath === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: at least one of message or attachmentPath must be provided." }],
          details: { message: "Error: at least one of message or attachmentPath must be provided." },
        };
      }

      const body: {
        recipient: string;
        message?: string;
        attachment?: string;
        attachmentFilename?: string;
      } = { recipient, message };

      if (attachmentPath !== undefined) {
        const fileBuffer = await fs.readFile(attachmentPath);
        body.attachment = fileBuffer.toString("base64");
        body.attachmentFilename = path.basename(attachmentPath);
        // Only delete files that were created in the OS temp directory to avoid
        // accidentally removing arbitrary files the agent was given access to.
        if (attachmentPath.startsWith(os.tmpdir())) {
          await fs.unlink(attachmentPath);
        }
      }

      const response = await fetch("http://signal-bridge:8081/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();

      if (!response.ok) {
        let errorMessage = responseText;
        try {
          const parsed = JSON.parse(responseText) as unknown;
          if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof (parsed as { error: unknown }).error === "string") {
            errorMessage = (parsed as { error: string }).error;
          }
        } catch {
          // Fall back to raw text if JSON parsing fails.
        }
        throw new Error(`Signal bridge error ${response.status}: ${errorMessage}`);
      }

      try {
        const parsed = JSON.parse(responseText) as unknown;
        if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || (parsed as { ok: unknown }).ok !== true) {
          throw new Error(`Signal bridge returned unexpected response: ${responseText}`);
        }
      } catch (parseError) {
        if (parseError instanceof SyntaxError) {
          throw new Error(`Signal bridge returned non-JSON success response: ${responseText}`);
        }
        throw parseError;
      }

      console.log("[stavrobot] send_signal_message bridge response status:", response.status);

      const successMessage = "Message sent successfully.";
      return {
        content: [{ type: "text" as const, text: successMessage }],
        details: { message: successMessage },
      };
    },
  };
}

export function createManageCronTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_cron",
    label: "Manage cron",
    description: "Create, update, delete, or list scheduled cron entries. Recurring entries use cron expressions (e.g. '0 9 * * *' for daily at 9am). One-shot entries use an ISO datetime.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("list"),
      ], { description: "Action to perform: create, update, delete, or list." }),
      id: Type.Optional(Type.Number({ description: "Entry id. Required for update and delete." })),
      schedule: Type.Optional(Type.String({ description: "Cron expression for recurring entries (e.g. '*/30 * * * *'). Mutually exclusive with fire_at." })),
      fire_at: Type.Optional(Type.String({ description: "ISO 8601 datetime for one-shot entries (e.g. '2026-03-01T09:00:00Z'). Mutually exclusive with schedule." })),
      note: Type.Optional(Type.String({ description: "The note/message for this cron entry. Required for create." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        id?: number;
        schedule?: string;
        fire_at?: string;
        note?: string;
      };

      const action = raw.action;

      if (action === "create") {
        if (raw.note === undefined || raw.note.trim() === "") {
          return {
            content: [{ type: "text" as const, text: "Error: note is required for create." }],
            details: { message: "Error: note is required for create." },
          };
        }
        if (raw.schedule === undefined && raw.fire_at === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: exactly one of schedule or fire_at must be provided." }],
            details: { message: "Error: exactly one of schedule or fire_at must be provided." },
          };
        }
        if (raw.schedule !== undefined && raw.fire_at !== undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: schedule and fire_at are mutually exclusive." }],
            details: { message: "Error: schedule and fire_at are mutually exclusive." },
          };
        }
        const cronExpression = raw.schedule ?? null;
        const fireAt = raw.fire_at !== undefined ? new Date(raw.fire_at) : null;
        const entry = await createCronEntry(pool, cronExpression, fireAt, raw.note.trim());
        await reloadScheduler(pool);
        const message = `Cron entry ${entry.id} created.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "update") {
        if (raw.id === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: id is required for update." }],
            details: { message: "Error: id is required for update." },
          };
        }
        if (raw.schedule !== undefined && raw.fire_at !== undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: schedule and fire_at are mutually exclusive." }],
            details: { message: "Error: schedule and fire_at are mutually exclusive." },
          };
        }
        const fields: { cronExpression?: string | null; fireAt?: Date | null; note?: string } = {};
        if (raw.schedule !== undefined) {
          fields.cronExpression = raw.schedule;
          fields.fireAt = null;
        }
        if (raw.fire_at !== undefined) {
          fields.cronExpression = null;
          fields.fireAt = new Date(raw.fire_at);
        }
        if (raw.note !== undefined) {
          fields.note = raw.note;
        }
        await updateCronEntry(pool, raw.id, fields);
        await reloadScheduler(pool);
        const message = `Cron entry ${raw.id} updated.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "delete") {
        if (raw.id === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: id is required for delete." }],
            details: { message: "Error: id is required for delete." },
          };
        }
        await deleteCronEntry(pool, raw.id);
        await reloadScheduler(pool);
        const message = `Cron entry ${raw.id} deleted.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "list") {
        const entries = await listCronEntries(pool);
        const message = JSON.stringify(entries);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Error: unknown action '${action}'. Valid actions: create, update, delete, list.` }],
        details: { message: `Error: unknown action '${action}'.` },
      };
    },
  };
}

export async function createAgent(config: Config, pool: pg.Pool): Promise<Agent> {
  const model = getModel(config.provider as any, config.model as any);
  const messages = await loadMessages(pool);
  const tools = [createExecuteSqlTool(pool), createUpdateMemoryTool(pool), createDeleteMemoryTool(pool), createSendSignalMessageTool(), createManageCronTool(pool)];
  if (config.tts !== undefined) {
    tools.push(createTextToSpeechTool(config.tts));
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools,
      messages,
    },
    getApiKey: () => getApiKey(config),
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

function formatDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[date.getDay()];
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${day} ${year}-${month}-${dayOfMonth} ${hours}:${minutes}:${seconds}`;
}

function formatUserMessage(userMessage: string, source?: string, sender?: string): string {
  const time = formatDate(new Date());
  const resolvedSource = source ?? "cli";
  const resolvedSender = sender ?? "unknown";
  return `Time: ${time}\nSource: ${resolvedSource}\nSender: ${resolvedSender}\nText: ${userMessage}`;
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string,
  config: Config,
  source?: string,
  sender?: string
): Promise<string> {
  const memories = await loadAllMemories(pool);
  
  if (memories.length === 0) {
    agent.setSystemPrompt(config.systemPrompt);
  } else {
    const memoryLines: string[] = [
      "These are your memories, they are things you stored yourself. Use the `update_memory` tool to update a memory, and the `delete_memory` tool to delete a memory. You should add anything that seems important to the user, anything that might have bearing on the future, or anything that will be important to recall later. However, do keep them to a few paragraphs, to avoid filling up the context.",
      "",
      "Here are your memories:",
      "",
    ];
    
    for (const memory of memories) {
      memoryLines.push(`[Memory ${memory.id}]`);
      memoryLines.push(memory.content);
      memoryLines.push("");
    }
    
    const injectionText = memoryLines.join("\n");
    agent.setSystemPrompt(`${config.systemPrompt}\n\n${injectionText}`);
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

  const messageToSend = formatUserMessage(userMessage, source, sender);

  console.log("[stavrobot] Sending message to agent:", messageToSend);

  try {
    await agent.prompt(messageToSend);
  } finally {
    unsubscribe();
    await Promise.all(savePromises);
  }

  if (agent.state.error) {
    const errorJson = JSON.stringify(agent.state.error);
    console.error("[stavrobot] Agent error:", errorJson);
    throw new Error(`Agent error: ${errorJson}`);
  }

  if (agent.state.messages.length > 40 && !compactionInProgress) {
    compactionInProgress = true;
    try {
      const currentMessages = agent.state.messages;

      // Advance the cut point past any leading toolResult messages so we never
      // split a tool-use/tool-result pair across the compaction boundary.
      let cutIndex = currentMessages.length - 20;
      while (cutIndex < currentMessages.length && currentMessages[cutIndex].role === "toolResult") {
        cutIndex++;
      }

      // If every message in the tail window is a toolResult, cutIndex has advanced
      // past the end of the array. keepCount would be 0, causing OFFSET -1 in the
      // SQL query, which is a PostgreSQL error. Skip compaction for this turn.
      if (cutIndex >= currentMessages.length) {
        console.warn("[stavrobot] Compaction skipped: all tail messages are toolResult, no safe cut point found.");
      } else {
        const messagesToCompact = currentMessages.slice(0, cutIndex);
        const messagesToKeep = currentMessages.slice(cutIndex);

        const serializedMessages = serializeMessagesForSummary(messagesToCompact);
        const summarySystemPrompt = "Summarize the following conversation concisely. Preserve all important facts, decisions, user preferences, and context. The summary will replace these messages in the conversation history.";
        
        const apiKey = await getApiKey(config);
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
          { apiKey }
        );

        const summaryText = response.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("");

        const previousCompaction = await loadLatestCompaction(pool);
        const previousBoundary = previousCompaction ? previousCompaction.upToMessageId : 0;

        // The offset must match the number of messages we are keeping so that the
        // DB boundary aligns with the in-memory cut point.
        const keepCount = messagesToKeep.length;
        const cutoffResult = await pool.query(
          `SELECT id FROM messages WHERE id > $1 ORDER BY id DESC LIMIT 1 OFFSET ${keepCount - 1}`,
          [previousBoundary]
        );
        const upToMessageId = cutoffResult.rows[0].id as number;

        await saveCompaction(pool, summaryText, upToMessageId);

        const syntheticMessage: AgentMessage = {
          role: "user",
          content: [{ type: "text", text: `[Summary of earlier conversation]\n${summaryText}` }],
          timestamp: Date.now(),
        };

        const newMessages = [syntheticMessage, ...messagesToKeep];
        agent.replaceMessages(newMessages);
        console.log(`[stavrobot] Compacted ${messagesToCompact.length} messages into summary, kept ${messagesToKeep.length} recent messages.`);
      }
    } finally {
      compactionInProgress = false;
    }
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
