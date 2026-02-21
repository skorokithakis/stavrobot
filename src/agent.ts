import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { Type, getModel, type TextContent, type ImageContent, complete } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config, TelegramConfig, TtsConfig } from "./config.js";
import type { FileAttachment } from "./uploads.js";
import { transcribeAudio } from "./stt.js";
import { getApiKey } from "./auth.js";
import { executeSql, loadMessages, saveMessage, saveCompaction, loadLatestCompaction, loadAllMemories, upsertMemory, deleteMemory, createCronEntry, updateCronEntry, deleteCronEntry, listCronEntries, type Memory } from "./database.js";
import { reloadScheduler } from "./scheduler.js";
import { createWebSearchTool } from "./web-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createListBundlesTool, createShowBundleTool, createRunBundleToolTool, createRequestCodingTaskTool } from "./coder-tools.js";
import { createInstallPluginTool, createUpdatePluginTool, createRemovePluginTool, createConfigurePluginTool, createListPluginsTool, createShowPluginTool, createRunPluginToolTool } from "./plugin-tools.js";
import { createRunPythonTool } from "./python.js";
import { createUpsertPageTool, createDeletePageTool } from "./pages.js";
import { createReadUploadTool, createDeleteUploadTool } from "./upload-tools.js";
import { convertMarkdownToTelegramHtml } from "./telegram.js";
import { sendSignalMessage } from "./signal.js";
import { sendTelegramMessage } from "./telegram-api.js";

// Ephemeral files created by the agent (e.g. TTS output) are written here so
// the send tools can identify them for auto-deletion without risking deletion
// of user-uploaded files that also live under /tmp.
export const TEMP_ATTACHMENTS_DIR = "/tmp/stavrobot-temp";

function buildPromptSuffix(publicHostname: string): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? "UTC";
  return `\n\nYour external hostname is ${publicHostname}. All times are in ${timezone}. Do not convert times to other timezones unless explicitly asked, or the user is in another timezone.`;
}

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
      await fs.mkdir(TEMP_ATTACHMENTS_DIR, { recursive: true });
      const tempDirectory = await fs.mkdtemp(path.join(TEMP_ATTACHMENTS_DIR, "tts-"));
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

      if (attachmentPath !== undefined) {
        const fileBuffer = await fs.readFile(attachmentPath);
        const body: {
          recipient: string;
          message?: string;
          attachment: string;
          attachmentFilename: string;
        } = {
          recipient,
          message,
          attachment: fileBuffer.toString("base64"),
          attachmentFilename: path.basename(attachmentPath),
        };

        // Only delete files that were created in the temp attachments directory
        // to avoid accidentally removing arbitrary files the agent was given access to.
        if (attachmentPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
          await fs.unlink(attachmentPath);
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
      }

      await sendSignalMessage(recipient, message as string);

      const successMessage = "Message sent successfully.";
      return {
        content: [{ type: "text" as const, text: successMessage }],
        details: { message: successMessage },
      };
    },
  };
}

export function createSendTelegramMessageTool(config: TelegramConfig): AgentTool {
  return {
    name: "send_telegram_message",
    label: "Send Telegram message",
    description: "Send a message via Telegram to a chat ID. Can send text, a file attachment (image, audio, or any other file), or both.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Telegram chat ID to send the message to." }),
      message: Type.Optional(Type.String({ description: "Text message to send. Markdown formatting is supported." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment. Images (jpg, jpeg, png, gif, webp), audio (mp3, ogg, oga, wav, m4a), and any other file type are supported." })),
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

      console.log("[stavrobot] send_telegram_message called:", { recipient, hasAttachment: attachmentPath !== undefined });

      if (message === undefined && attachmentPath === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: at least one of message or attachmentPath must be provided." }],
          details: { message: "Error: at least one of message or attachmentPath must be provided." },
        };
      }

      const baseUrl = `https://api.telegram.org/bot${config.botToken}`;

      if (attachmentPath !== undefined) {
        const extension = path.extname(attachmentPath).toLowerCase();
        const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
        const audioExtensions = new Set([".mp3", ".ogg", ".oga", ".wav", ".m4a"]);

        let apiMethod: string;
        let formFieldName: string;
        if (imageExtensions.has(extension)) {
          apiMethod = "sendPhoto";
          formFieldName = "photo";
        } else if (audioExtensions.has(extension)) {
          apiMethod = "sendVoice";
          formFieldName = "voice";
        } else {
          apiMethod = "sendDocument";
          formFieldName = "document";
        }

        console.log("[stavrobot] send_telegram_message attachment type detected:", { extension, apiMethod });

        const fileBuffer = await fs.readFile(attachmentPath);
        const formData = new FormData();
        formData.append("chat_id", recipient);
        formData.append(formFieldName, new Blob([fileBuffer]), path.basename(attachmentPath));

        if (message !== undefined) {
          const htmlCaption = await convertMarkdownToTelegramHtml(message);
          formData.append("caption", htmlCaption);
          formData.append("parse_mode", "HTML");
        }

        // Only delete files that were created in the temp attachments directory
        // to avoid accidentally removing arbitrary files the agent was given access to.
        if (attachmentPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
          await fs.unlink(attachmentPath);
        }

        const response = await fetch(`${baseUrl}/${apiMethod}`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorBody = await response.json() as { description?: string };
          const description = errorBody.description ?? "unknown error";
          const errorMessage = `Error: Telegram API error ${response.status}: ${description}`;
          console.error(`[stavrobot] send_telegram_message ${apiMethod} error:`, errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        console.log(`[stavrobot] send_telegram_message ${apiMethod} response status:`, response.status);
        const successMessage = "Message sent successfully.";
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: { message: successMessage },
        };
      }

      // Text-only path: convert markdown to Telegram HTML and call sendMessage.
      const htmlText = await convertMarkdownToTelegramHtml(message as string);
      try {
        await sendTelegramMessage(config.botToken, recipient, htmlText);
      } catch (error) {
        const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
        console.error("[stavrobot] send_telegram_message sendMessage error:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

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
  const tools = [createExecuteSqlTool(pool), createUpdateMemoryTool(pool), createDeleteMemoryTool(pool), createSendSignalMessageTool(), createManageCronTool(pool), createRunPythonTool(), createUpsertPageTool(pool), createDeletePageTool(pool), createReadUploadTool(), createDeleteUploadTool()];
  if (config.webSearch !== undefined) {
    tools.push(createWebSearchTool(config.webSearch));
  }
  if (config.webFetch !== undefined) {
    tools.push(createWebFetchTool(config.webFetch));
  }
  if (config.tts !== undefined) {
    tools.push(createTextToSpeechTool(config.tts));
  }
  if (config.coder !== undefined) {
    tools.push(
      createListBundlesTool(),
      createShowBundleTool(),
      createRunBundleToolTool(),
      createRequestCodingTaskTool(),
    );
  }
  tools.push(
    createInstallPluginTool(),
    createUpdatePluginTool(),
    createRemovePluginTool(),
    createConfigurePluginTool(),
    createListPluginsTool(),
    createShowPluginTool(),
    createRunPluginToolTool(),
  );
  if (config.telegram !== undefined) {
    tools.push(createSendTelegramMessageTool(config.telegram));
  }

  const effectiveBasePrompt = (config.customPrompt !== undefined
    ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
    : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveBasePrompt,
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
  userMessage: string | undefined,
  config: Config,
  source?: string,
  sender?: string,
  audio?: string,
  audioContentType?: string,
  attachments?: FileAttachment[]
): Promise<string> {
  const memories = await loadAllMemories(pool);

  const effectiveBasePrompt = (config.customPrompt !== undefined
    ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
    : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

  if (memories.length === 0) {
    agent.setSystemPrompt(effectiveBasePrompt);
  } else {
    const memoryLines: string[] = [
      "These are your memories, they are things you stored yourself. Use the `update_memory` tool to update a memory, and the `delete_memory` tool to delete a memory. You should add anything that seems important to the user, anything that might have bearing on the future, or anything that will be important to recall later. However, do keep them to a few paragraphs, to avoid filling up the context.",
      "",
      "Here are your memories:",
      "",
    ];

    for (const memory of memories) {
      const created = memory.createdAt.toISOString();
      const updated = memory.updatedAt.toISOString();
      const timestamp = created === updated
        ? `created ${created}`
        : `created ${created}, updated ${updated}`;
      memoryLines.push(`[Memory ${memory.id}] (${timestamp})`);
      memoryLines.push(memory.content);
      memoryLines.push("");
    }

    const injectionText = memoryLines.join("\n");
    agent.setSystemPrompt(`${effectiveBasePrompt}\n\n${injectionText}`);
  }

  const savePromises: Promise<void>[] = [];

  let resolvedMessage = userMessage;

  if (audio !== undefined) {
    if (config.stt !== undefined) {
      const audioBuffer = Buffer.from(audio, "base64");
      const resolvedContentType = audioContentType ?? "audio/ogg";
      const transcription = await transcribeAudio(audioBuffer, config.stt, resolvedContentType);
      const voiceNote = `[Voice note]: ${transcription}`;
      resolvedMessage = resolvedMessage !== undefined ? `${resolvedMessage}\n${voiceNote}` : voiceNote;
    } else {
      console.warn("[stavrobot] Audio received but [stt] is not configured; ignoring audio.");
    }
  }

  const imageContents: ImageContent[] = [];

  if (attachments !== undefined && attachments.length > 0) {
    for (const attachment of attachments) {
      const isImage = attachment.mimeType.startsWith("image/");
      const notification =
        `A file was received.\n` +
        `Original filename: ${attachment.originalFilename}\n` +
        `Stored at: ${attachment.storedPath}\n` +
        `MIME type: ${attachment.mimeType}\n` +
        `Size: ${attachment.size} bytes\n\n` +
        `If this is an image, it is already included below. Otherwise, you do not need to read it right now. ` +
        `If you need to read it, use the read_upload tool. ` +
        `You shouldn't need to delete it, but if you do, you can use the delete_upload tool.`;
      resolvedMessage = resolvedMessage !== undefined ? `${resolvedMessage}\n\n${notification}` : notification;

      if (isImage) {
        const fileData = await fs.readFile(attachment.storedPath);
        imageContents.push({ type: "image", data: fileData.toString("base64"), mimeType: attachment.mimeType });
      }
    }
  }

  const messageToSend = formatUserMessage(resolvedMessage ?? "", source, sender);

  console.log("[stavrobot] Sending message to agent:", messageToSend);

  // The Pi agent loop's getApiKey callback runs inside an async context where thrown
  // errors become unhandled promise rejections that crash Node rather than propagating
  // through the stream's async iterator. By checking auth here before entering the agent
  // loop, we ensure AuthError propagates cleanly to the queue's error handler. This does
  // not cover the rare case where a token expires mid-conversation between tool calls.
  await getApiKey(config);

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
    if (imageContents.length > 0) {
      await agent.prompt(messageToSend, imageContents);
    } else {
      await agent.prompt(messageToSend);
    }
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
