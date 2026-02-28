import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { Type, getModel, type TextContent, type ImageContent, type AssistantMessage, type ToolCall, complete } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { isInAllowlist } from "./allowlist.js";
import type { FileAttachment } from "./uploads.js";
import { transcribeAudio } from "./stt.js";
import { getApiKey } from "./auth.js";
import { executeSql, loadMessages, saveMessage, saveCompaction, loadLatestCompaction, loadAllMemories, upsertMemory, deleteMemory, upsertScratchpad, deleteScratchpad, createCronEntry, updateCronEntry, deleteCronEntry, listCronEntries, loadAllScratchpadTitles, resolveRecipient, resolveInterlocutorByName, getMainAgentId, loadAgent, type Memory } from "./database.js";
import type { RoutingResult } from "./queue.js";
import { reloadScheduler } from "./scheduler.js";
import { createManagePluginsTool, createRunPluginToolTool, createRequestCodingTaskTool } from "./plugin-tools.js";
import { createRunPythonTool } from "./python.js";
import { createManagePagesTool } from "./pages.js";
import { createManageFilesTool } from "./files.js";
import { createManageInterlocutorsTool } from "./interlocutors.js";
import { createManageAgentsTool } from "./agents.js";
import { createSendAgentMessageTool } from "./send-agent-message.js";
import { createSearchTool } from "./search.js";
import { createManageUploadsTool } from "./upload-tools.js";
import { convertMarkdownToTelegramHtml } from "./telegram.js";
import { encodeToToon } from "./toon.js";
import { sendSignalMessage } from "./signal.js";
import { sendTelegramMessage } from "./telegram-api.js";
import { getWhatsappSocket, e164ToJid, sendWhatsappTextMessage } from "./whatsapp-api.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
export { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";

function buildPromptSuffix(publicHostname: string): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? "UTC";
  return `\n\nYour external hostname is ${publicHostname}. All times are in ${timezone}. Do not convert times to other timezones unless explicitly asked, or the user is in another timezone.`;
}

// A simple boolean flag to prevent concurrent compaction runs. If a compaction
// is already in progress when another request triggers the threshold, we skip
// rather than queue, because queuing would compact already-compacted messages.
let compactionInProgress = false;

// Set to the agent ID whose compaction just finished. The next handlePrompt
// call for that agent checks this and reloads messages from the DB. Stored as
// an ID rather than a boolean so that a compaction for agent A does not trigger
// a reload when the next message is for agent B.
let compactionCompletedForAgent: number | null = null;

// The agent ID currently being processed by handlePrompt. Set at the start of
// each handlePrompt call. The queue is single-threaded so there is no race
// condition. The send_agent_message tool reads this to identify the sender.
export let currentAgentId: number = 0;

export const STAVROBOT_DEBUG = process.env.STAVROBOT_DEBUG === "1";

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

const MANAGE_KNOWLEDGE_HELP_TEXT = `manage_knowledge: upsert or delete entries in the two-tier knowledge store.

Stores:
- memory: full content is injected into the system prompt every turn. Use for frequently needed facts, user preferences, and anything that should always be in context. Keep entries concise — they consume context on every request.
- scratchpad: only titles are injected each turn; bodies are read on demand via execute_sql. Use for less frequent, longer-form knowledge such as reference material, detailed notes, or anything that doesn't need to be in context every turn.

Actions:
- upsert: create or update an entry. Parameters: store (required), id (omit to create, provide to update), content (required for memory), title (required for scratchpad), body (required for scratchpad).
- delete: remove an entry by id. Parameters: store (required), id (required).
- help: show this help text.

Constraints:
- Memory entries are injected in full every turn; keep them concise.
- Scratchpad bodies are not injected automatically; read them via execute_sql on the "scratchpad" table.`;

export function createManageKnowledgeTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_knowledge",
    label: "Manage knowledge",
    description: "Upsert or delete entries in the two-tier knowledge store (memory and scratchpad). Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upsert"),
        Type.Literal("delete"),
        Type.Literal("help"),
      ], { description: "Action to perform: upsert, delete, or help." }),
      store: Type.Optional(Type.Union([
        Type.Literal("memory"),
        Type.Literal("scratchpad"),
      ], { description: "Which store to operate on: memory or scratchpad." })),
      id: Type.Optional(Type.Number({ description: "Entry id. Omit to create a new entry (upsert); required for delete." })),
      content: Type.Optional(Type.String({ description: "Memory content. Required when upserting a memory entry." })),
      title: Type.Optional(Type.String({ description: "Scratchpad title. Required when upserting a scratchpad entry." })),
      body: Type.Optional(Type.String({ description: "Scratchpad body. Required when upserting a scratchpad entry." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        store?: string;
        id?: number;
        content?: string;
        title?: string;
        body?: string;
      };

      const { action, store } = raw;

      console.log(`[stavrobot] manage_knowledge called: action=${action} store=${store} id=${raw.id}`);

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: MANAGE_KNOWLEDGE_HELP_TEXT }],
          details: { message: MANAGE_KNOWLEDGE_HELP_TEXT },
        };
      }

      if (action === "upsert") {
        if (store === undefined) {
          const errorMessage = "Error: store is required for upsert.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        if (store === "memory") {
          if (raw.content === undefined || raw.content.trim() === "") {
            const errorMessage = "Error: content is required when upserting a memory entry.";
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const memoryResult = await upsertMemory(pool, raw.id, raw.content);
          if (raw.id !== undefined && memoryResult.rowCount === 0) {
            const errorMessage = `Error: memory ${raw.id} not found.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const message = raw.id === undefined ? `Memory ${memoryResult.id} created.` : `Memory ${memoryResult.id} updated.`;
          console.log(`[stavrobot] ${message}`);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        if (store === "scratchpad") {
          if (raw.title === undefined || raw.title.trim() === "") {
            const errorMessage = "Error: title is required when upserting a scratchpad entry.";
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          if (raw.body === undefined || raw.body.trim() === "") {
            const errorMessage = "Error: body is required when upserting a scratchpad entry.";
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const scratchpadResult = await upsertScratchpad(pool, raw.id, raw.title, raw.body);
          if (raw.id !== undefined && scratchpadResult.rowCount === 0) {
            const errorMessage = `Error: scratchpad entry ${raw.id} not found.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const message = raw.id === undefined ? `Scratchpad entry ${scratchpadResult.id} created.` : `Scratchpad entry ${scratchpadResult.id} updated.`;
          console.log(`[stavrobot] ${message}`);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        const errorMessage = `Error: unknown store '${store}'. Valid stores: memory, scratchpad.`;
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      if (action === "delete") {
        if (store === undefined) {
          const errorMessage = "Error: store is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        if (store === "memory") {
          const rowCount = await deleteMemory(pool, raw.id);
          if (rowCount === 0) {
            const errorMessage = `Error: memory ${raw.id} not found.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const message = `Memory ${raw.id} deleted.`;
          console.log(`[stavrobot] ${message}`);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        if (store === "scratchpad") {
          const rowCount = await deleteScratchpad(pool, raw.id);
          if (rowCount === 0) {
            const errorMessage = `Error: scratchpad entry ${raw.id} not found.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          const message = `Scratchpad entry ${raw.id} deleted.`;
          console.log(`[stavrobot] ${message}`);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        const errorMessage = `Error: unknown store '${store}'. Valid stores: memory, scratchpad.`;
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: upsert, delete, help.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { message: errorMessage },
      };
    },
  };
}

function signalRateLimitMessage(publicHostname: string): string {
  return `Message could not be sent because Signal is rate-limiting this account. Direct the user to ${publicHostname}/signal/captcha to solve the captcha. Do not attempt to resolve this yourself.`;
}

export function createSendSignalMessageTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "send_signal_message",
    label: "Send Signal message",
    description: "Send a message via Signal to a display name or phone number. Can send text, a file attachment (from manage_files or a plugin tool), or both.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Display name of the recipient (e.g., \"Mom\") or phone number in international format (e.g., \"+1234567890\")." }),
      message: Type.Optional(Type.String({ description: "Text message to send." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment under the temp directory (e.g., from manage_files write or a plugin tool)." })),
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

      const recipientInput = raw.recipient;
      const message = raw.message?.trim() || undefined;
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      console.log("[stavrobot] send_signal_message called:", { recipient: recipientInput, hasAttachment: attachmentPath !== undefined });

      if (message === undefined && attachmentPath === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: at least one of message or attachmentPath must be provided." }],
          details: { message: "Error: at least one of message or attachmentPath must be provided." },
        };
      }

      // Resolve display name to phone number, falling back to treating the input as a raw phone number.
      const resolved = await resolveRecipient(pool, recipientInput, "signal");
      let recipient: string;
      if (resolved !== null && !("disabled" in resolved)) {
        recipient = resolved.identifier;
      } else if (resolved !== null && "disabled" in resolved) {
        const errorMessage = `Error: Interlocutor "${resolved.displayName}" is disabled.`;
        console.warn("[stavrobot] send_signal_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      } else {
        // If the input matches an interlocutor by name but they have no Signal identity,
        // give a specific error rather than falling through to the raw-ID path.
        const interlocutor = await resolveInterlocutorByName(pool, recipientInput);
        if (interlocutor !== null) {
          const errorMessage = `Error: interlocutor '${recipientInput}' has no Signal identity. Use manage_interlocutors to add one.`;
          console.warn("[stavrobot] send_signal_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        // Soft gate: raw ID must exist in interlocutor_identities for an enabled interlocutor.
        const identityCheck = await pool.query<{ identifier: string }>(
          "SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON i.id = ii.interlocutor_id WHERE ii.service = 'signal' AND ii.identifier = $1 AND i.enabled = true",
          [recipientInput],
        );
        if (identityCheck.rows.length === 0) {
          const errorMessage = `Error: unknown recipient '${recipientInput}'. No interlocutor found with that display name or phone number.`;
          console.warn("[stavrobot] send_signal_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        recipient = recipientInput;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("signal", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the Signal allowlist.`;
        console.warn("[stavrobot] send_signal_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      if (STAVROBOT_DEBUG) {
        const preview = (message ?? "").slice(0, 200);
        console.log(`[stavrobot] [debug] Sending: signal - ${recipient} - ${preview}`);
      }

      if (attachmentPath !== undefined) {
        const resolvedAttachmentPath = path.resolve(attachmentPath);
        if (!resolvedAttachmentPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
          return {
            content: [{ type: "text" as const, text: "Error: attachmentPath must be under the temporary attachments directory." }],
            details: { message: "Error: attachmentPath must be under the temporary attachments directory." },
          };
        }
        const fileBuffer = await fs.readFile(resolvedAttachmentPath);
        const body: {
          recipient: string;
          message?: string;
          attachment: string;
          attachmentFilename: string;
        } = {
          recipient,
          message,
          attachment: fileBuffer.toString("base64"),
          attachmentFilename: path.basename(resolvedAttachmentPath),
        };

        // The path check above guarantees this is a temp file, so always delete it.
        await fs.unlink(resolvedAttachmentPath);

        const response = await fetch("http://signal-bridge:8081/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const responseText = await response.text();

        if (response.status === 429) {
          console.warn("[stavrobot] send_signal_message rate limited by bridge (attachment path)");
          const rateLimitMessage = signalRateLimitMessage(config.publicHostname);
          return {
            content: [{ type: "text" as const, text: rateLimitMessage }],
            details: { message: rateLimitMessage },
          };
        }

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

      const sendResult = await sendSignalMessage(recipient, message as string);
      if (sendResult === "rate_limited") {
        console.warn("[stavrobot] send_signal_message rate limited by bridge (text-only path)");
        const rateLimitMessage = signalRateLimitMessage(config.publicHostname);
        return {
          content: [{ type: "text" as const, text: rateLimitMessage }],
          details: { message: rateLimitMessage },
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

export function createSendTelegramMessageTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "send_telegram_message",
    label: "Send Telegram message",
    description: "Send a message via Telegram to a display name or chat ID. Can send text, a file attachment (image, audio, or any other file), or both.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Display name of the recipient (e.g., \"Mom\") or Telegram chat ID." }),
      message: Type.Optional(Type.String({ description: "Text message to send. Markdown formatting is supported." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment under the temp directory (e.g., from manage_files write or a plugin tool). Images (jpg, jpeg, png, gif, webp), audio (mp3, ogg, oga, wav, m4a), and any other file type are supported." })),
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

      const recipientInput = raw.recipient;
      const message = raw.message?.trim() || undefined;
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      console.log("[stavrobot] send_telegram_message called:", { recipient: recipientInput, hasAttachment: attachmentPath !== undefined });

      if (message === undefined && attachmentPath === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: at least one of message or attachmentPath must be provided." }],
          details: { message: "Error: at least one of message or attachmentPath must be provided." },
        };
      }

      if (config.telegram === undefined) {
        const errorMessage = "Error: Telegram is not configured.";
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      // Resolve display name to chat ID, falling back to treating the input as a raw chat ID.
      const resolved = await resolveRecipient(pool, recipientInput, "telegram");
      let recipient: string;
      if (resolved !== null && !("disabled" in resolved)) {
        recipient = resolved.identifier;
      } else if (resolved !== null && "disabled" in resolved) {
        const errorMessage = `Error: Interlocutor "${resolved.displayName}" is disabled.`;
        console.warn("[stavrobot] send_telegram_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      } else {
        // If the input matches an interlocutor by name but they have no Telegram identity,
        // give a specific error rather than falling through to the raw-ID path.
        const interlocutor = await resolveInterlocutorByName(pool, recipientInput);
        if (interlocutor !== null) {
          const errorMessage = `Error: interlocutor '${recipientInput}' has no Telegram identity. Use manage_interlocutors to add one.`;
          console.warn("[stavrobot] send_telegram_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        // Soft gate: raw ID must exist in interlocutor_identities for an enabled interlocutor.
        const identityCheck = await pool.query<{ identifier: string }>(
          "SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON i.id = ii.interlocutor_id WHERE ii.service = 'telegram' AND ii.identifier = $1 AND i.enabled = true",
          [recipientInput],
        );
        if (identityCheck.rows.length === 0) {
          const errorMessage = `Error: unknown recipient '${recipientInput}'. No interlocutor found with that display name or chat ID.`;
          console.warn("[stavrobot] send_telegram_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        recipient = recipientInput;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("telegram", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the Telegram allowlist.`;
        console.warn("[stavrobot] send_telegram_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      const baseUrl = `https://api.telegram.org/bot${config.telegram.botToken}`;

      if (STAVROBOT_DEBUG) {
        const preview = (message ?? "").slice(0, 200);
        console.log(`[stavrobot] [debug] Sending: telegram - ${recipient} - ${preview}`);
      }

      if (attachmentPath !== undefined) {
        const resolvedAttachmentPath = path.resolve(attachmentPath);
        if (!resolvedAttachmentPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
          return {
            content: [{ type: "text" as const, text: "Error: attachmentPath must be under the temporary attachments directory." }],
            details: { message: "Error: attachmentPath must be under the temporary attachments directory." },
          };
        }

        const extension = path.extname(resolvedAttachmentPath).toLowerCase();
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

        const fileBuffer = await fs.readFile(resolvedAttachmentPath);
        const formData = new FormData();
        formData.append("chat_id", recipient);
        formData.append(formFieldName, new Blob([fileBuffer]), path.basename(resolvedAttachmentPath));

        if (message !== undefined) {
          const htmlCaption = await convertMarkdownToTelegramHtml(message);
          formData.append("caption", htmlCaption);
          formData.append("parse_mode", "HTML");
        }

        // The path check above guarantees this is a temp file, so always delete it.
        await fs.unlink(resolvedAttachmentPath);

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
        await sendTelegramMessage(config.telegram.botToken, recipient, htmlText);
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

export function createSendWhatsappMessageTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "send_whatsapp_message",
    label: "Send WhatsApp message",
    description: "Send a message via WhatsApp to a display name or phone number in E.164 format. Can send text, a file attachment (image, audio, video, or any other file), or both.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Display name of the recipient (e.g., \"Mom\") or phone number in E.164 format (e.g., \"+1234567890\")." }),
      message: Type.Optional(Type.String({ description: "Text message to send." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment under the temp directory (e.g., from manage_files write or a plugin tool). Images (jpg, jpeg, png, gif, webp), audio (mp3, ogg, oga, wav, m4a), video (mp4, mov, avi, mkv), and any other file type are supported." })),
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

      const recipientInput = raw.recipient;
      const message = raw.message?.trim() || undefined;
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      console.log("[stavrobot] send_whatsapp_message called:", { recipient: recipientInput, hasAttachment: attachmentPath !== undefined });

      if (message === undefined && attachmentPath === undefined) {
        return {
          content: [{ type: "text" as const, text: "Error: at least one of message or attachmentPath must be provided." }],
          details: { message: "Error: at least one of message or attachmentPath must be provided." },
        };
      }

      // Resolve display name to phone number, falling back to treating the input as a raw phone number.
      const resolved = await resolveRecipient(pool, recipientInput, "whatsapp");
      let recipient: string;
      if (resolved !== null && !("disabled" in resolved)) {
        recipient = resolved.identifier;
      } else if (resolved !== null && "disabled" in resolved) {
        const errorMessage = `Error: Interlocutor "${resolved.displayName}" is disabled.`;
        console.warn("[stavrobot] send_whatsapp_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      } else {
        // If the input matches an interlocutor by name but they have no WhatsApp identity,
        // give a specific error rather than falling through to the raw-ID path.
        const interlocutor = await resolveInterlocutorByName(pool, recipientInput);
        if (interlocutor !== null) {
          const errorMessage = `Error: interlocutor '${recipientInput}' has no WhatsApp identity. Use manage_interlocutors to add one.`;
          console.warn("[stavrobot] send_whatsapp_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        // Soft gate: raw ID must exist in interlocutor_identities for an enabled interlocutor.
        const identityCheck = await pool.query<{ identifier: string }>(
          "SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON i.id = ii.interlocutor_id WHERE ii.service = 'whatsapp' AND ii.identifier = $1 AND i.enabled = true",
          [recipientInput],
        );
        if (identityCheck.rows.length === 0) {
          const errorMessage = `Error: unknown recipient '${recipientInput}'. No interlocutor found with that display name or phone number.`;
          console.warn("[stavrobot] send_whatsapp_message rejected:", errorMessage);
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        recipient = recipientInput;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("whatsapp", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the WhatsApp allowlist.`;
        console.warn("[stavrobot] send_whatsapp_message rejected:", errorMessage);
        return {
          content: [{ type: "text" as const, text: errorMessage }],
          details: { message: errorMessage },
        };
      }

      if (STAVROBOT_DEBUG) {
        const preview = (message ?? "").slice(0, 200);
        console.log(`[stavrobot] [debug] Sending: whatsapp - ${recipient} - ${preview}`);
      }

      if (attachmentPath !== undefined) {
        const resolvedAttachmentPath = path.resolve(attachmentPath);
        if (!resolvedAttachmentPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
          return {
            content: [{ type: "text" as const, text: "Error: attachmentPath must be under the temporary attachments directory." }],
            details: { message: "Error: attachmentPath must be under the temporary attachments directory." },
          };
        }

        const socket = getWhatsappSocket();
        if (socket === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: WhatsApp is not connected." }],
            details: { message: "Error: WhatsApp is not connected." },
          };
        }

        const extension = path.extname(resolvedAttachmentPath).toLowerCase();
        const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
        const audioExtensions = new Set([".mp3", ".ogg", ".oga", ".wav", ".m4a"]);
        const videoExtensions = new Set([".mp4", ".mov", ".avi", ".mkv"]);

        console.log("[stavrobot] send_whatsapp_message attachment type detected:", { extension });

        const fileBuffer = await fs.readFile(resolvedAttachmentPath);
        const fileName = path.basename(resolvedAttachmentPath);
        const caption = message;
        const jid = e164ToJid(recipient);

        // The path check above guarantees this is a temp file, so always delete it.
        await fs.unlink(resolvedAttachmentPath);

        if (imageExtensions.has(extension)) {
          await socket.sendMessage(jid, { image: fileBuffer, caption });
        } else if (audioExtensions.has(extension)) {
          let mimetype: string;
          if (extension === ".mp3") {
            mimetype = "audio/mpeg";
          } else if (extension === ".ogg" || extension === ".oga") {
            mimetype = "audio/ogg";
          } else if (extension === ".wav") {
            mimetype = "audio/wav";
          } else {
            mimetype = "audio/mp4";
          }
          await socket.sendMessage(jid, { audio: fileBuffer, mimetype, ptt: true });
        } else if (videoExtensions.has(extension)) {
          await socket.sendMessage(jid, { video: fileBuffer, caption });
        } else {
          const mimetype = "application/octet-stream";
          await socket.sendMessage(jid, { document: fileBuffer, fileName, mimetype });
        }

        console.log("[stavrobot] send_whatsapp_message attachment sent successfully.");
        const successMessage = "Message sent successfully.";
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: { message: successMessage },
        };
      }

      await sendWhatsappTextMessage(recipient, message as string);

      const successMessage = "Message sent successfully.";
      return {
        content: [{ type: "text" as const, text: successMessage }],
        details: { message: successMessage },
      };
    },
  };
}

const MANAGE_CRON_HELP_TEXT = `manage_cron: create, update, delete, or list scheduled cron entries.

Actions:
- create: create a new cron entry. Parameters: note (required), schedule or fire_at (exactly one required).
- update: update an existing entry. Parameters: id (required), note (optional), schedule or fire_at (optional, mutually exclusive).
- delete: remove an entry. Parameters: id (required).
- list: list all cron entries. Returns a JSON array of entries.
- help: show this help text.

Constraints:
- schedule: a cron expression for recurring entries (e.g. '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 minutes).
- fire_at: an ISO 8601 datetime for one-shot entries (e.g. '2026-03-01T09:00:00Z'). The entry is removed after it fires.
- schedule and fire_at are mutually exclusive.`;

export function createManageCronTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_cron",
    label: "Manage cron",
    description: "Create, update, delete, or list scheduled cron entries. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("list"),
        Type.Literal("help"),
      ], { description: "Action to perform: create, update, delete, list, or help." }),
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

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: MANAGE_CRON_HELP_TEXT }],
          details: { message: MANAGE_CRON_HELP_TEXT },
        };
      }

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
        const message = encodeToToon(entries);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Error: unknown action '${action}'. Valid actions: create, update, delete, list, help.` }],
        details: { message: `Error: unknown action '${action}'.` },
      };
    },
  };
}

export async function createAgent(config: Config, pool: pg.Pool): Promise<Agent> {
  const model = getModel(config.provider as any, config.model as any);
  const tools = [createExecuteSqlTool(pool), createManageKnowledgeTool(pool), createSendSignalMessageTool(pool, config), createManageCronTool(pool), createRunPythonTool(), createManagePagesTool(pool), createManageUploadsTool(), createSearchTool(pool), createManageFilesTool(), createManageInterlocutorsTool(pool), createManageAgentsTool(pool), createSendAgentMessageTool(pool, () => currentAgentId)];
  tools.push(
    createManagePluginsTool({ coderEnabled: config.coder !== undefined }),
    createRunPluginToolTool(),
  );
  if (config.coder !== undefined) {
    tools.push(
      createRequestCodingTaskTool(),
    );
  }
  if (config.telegram !== undefined) {
    tools.push(createSendTelegramMessageTool(pool, config));
  }
  if (config.whatsapp !== undefined) {
    tools.push(createSendWhatsappMessageTool(pool, config));
  }

  const effectiveBasePrompt = (config.customPrompt !== undefined
    ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
    : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveBasePrompt,
      model,
      tools,
      messages: [],
    },
    getApiKey: () => getApiKey(config),
  });

  return agent;
}

export function serializeMessagesForSummary(messages: AgentMessage[]): string {
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
      for (const block of content) {
        if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          const args = Object.entries(toolCall.arguments)
            .map(([key, value]) => {
              if (typeof value === "string") {
                return `${key}=${JSON.stringify(value)}`;
              }
              if (typeof value === "object" && value !== null) {
                return `${key}=${JSON.stringify(value)}`;
              }
              return `${key}=${String(value)}`;
            })
            .join(", ");
          lines.push(`Assistant called ${toolCall.name}(${args})`);
        }
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

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

/**
 * Parses an allowed_tools list and returns the filtered (and possibly wrapped)
 * tool list for a subagent. `send_agent_message` is always included.
 *
 * Entries without a dot grant full access to that tool. Entries with a dot
 * (e.g. "manage_interlocutors.list") restrict the tool to only the named
 * action. Multiple dotted entries for the same tool combine. A bare name
 * takes precedence over any dotted entries for the same tool.
 */
export function filterToolsForSubagent(tools: AgentTool[], allowedTools: string[]): AgentTool[] {
  // Always include send_agent_message regardless of the whitelist.
  const fullyAllowed = new Set<string>(["send_agent_message"]);
  const actionMap = new Map<string, Set<string>>();

  for (const entry of allowedTools) {
    const dotIndex = entry.indexOf(".");
    if (dotIndex === -1) {
      fullyAllowed.add(entry);
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
            const errorMessage = `Tool "${toolName}" requires an action parameter because it is scoped to specific actions. Allowed actions: ${list}.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
          }
          if (!allowedActions.has(action)) {
            const errorMessage = `Action "${action}" is not allowed on tool "${toolName}". Allowed actions: ${list}.`;
            return {
              content: [{ type: "text" as const, text: errorMessage }],
              details: { message: errorMessage },
            };
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

interface PluginSummary {
  name: string;
  description: string;
  editable: boolean;
}

async function fetchPluginListSection(): Promise<string | undefined> {
  try {
    const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
    if (!response.ok) {
      console.warn(`[stavrobot] fetchPluginListSection: plugin runner returned ${response.status}`);
      return undefined;
    }
    const data = await response.json() as { plugins: PluginSummary[] };
    const plugins = data.plugins;
    if (plugins.length === 0) {
      return undefined;
    }
    const lines = ["Available plugins:"];
    for (const plugin of plugins) {
      lines.push(`- ${plugin.name}: ${plugin.description}`);
    }
    console.log(`[stavrobot] fetchPluginListSection: injecting ${plugins.length} plugin(s) into system prompt`);
    return lines.join("\n");
  } catch (error) {
    console.warn("[stavrobot] fetchPluginListSection: failed to fetch plugin list:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string | undefined,
  config: Config,
  routing: RoutingResult,
  source?: string,
  audio?: string,
  audioContentType?: string,
  attachments?: FileAttachment[]
): Promise<string> {
  const { agentId, senderIdentityId, senderAgentId, senderLabel, isMainAgent } = routing;

  // Track the current agent ID so the send_agent_message tool can identify the
  // sender. The queue is single-threaded so this is safe without locking.
  currentAgentId = agentId;

  // Always load and swap in the correct conversation's messages. replaceMessages()
  // is a cheap array swap, and this ensures the agent always has the right history
  // regardless of which agent received the previous message.
  const conversationMessages = await loadMessages(pool, agentId);

  // If a background compaction just finished for this agent, the reload above
  // already picks up the compacted state. Clear the flag only when it matches
  // the current agent so we don't discard a pending reload for a different
  // conversation.
  if (compactionCompletedForAgent === agentId) {
    compactionCompletedForAgent = null;
    console.log(`[stavrobot] Cleared compaction-completed flag for agent ${agentId}.`);
    if (STAVROBOT_DEBUG) {
      console.log("[stavrobot] [debug] Reloaded messages:");
      for (let i = 0; i < conversationMessages.length; i++) {
        const message = conversationMessages[i];
        const textPreview = typeof message.content === "string"
          ? message.content.slice(0, 200)
          : Array.isArray(message.content)
            ? message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("").slice(0, 200)
            : "";
        console.log(`[stavrobot] [debug]   [${i}] role=${message.role} text=${textPreview}`);
      }
    }
  }

  agent.replaceMessages(conversationMessages);
  console.log(`[stavrobot] Loaded ${conversationMessages.length} messages for agent ${agentId}.`);

  const pluginListSection = await fetchPluginListSection();

  // Load the subagent's DB row once here so it can be used for both system
  // prompt assembly and tool filtering without a second DB round-trip.
  const subagentRow = isMainAgent ? null : await loadAgent(pool, agentId);

  let systemPrompt: string;

  if (isMainAgent) {
    const memories = await loadAllMemories(pool);
    const scratchpadTitles = await loadAllScratchpadTitles(pool);

    const effectiveBasePrompt = (config.customPrompt !== undefined
      ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
      : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

    const promptWithPlugins = pluginListSection !== undefined
      ? `${effectiveBasePrompt}\n\n${pluginListSection}`
      : effectiveBasePrompt;

    systemPrompt = promptWithPlugins;

    if (memories.length > 0) {
      const memoryLines: string[] = [
        "These are your memories, they are things you stored yourself. Use the `manage_knowledge` tool (store: \"memory\") to upsert or delete memories. You should add anything that seems important to the user, anything that might have bearing on the future, or anything that will be important to recall later. Keep memories concise — they are injected in full every turn, so avoid storing large amounts of text here. Use the scratchpad for less frequent or longer-form knowledge.",
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

      systemPrompt = `${systemPrompt}\n\n${memoryLines.join("\n")}`;
    }

    if (scratchpadTitles.length > 0) {
      const scratchpadLines = ["Your scratchpad (use manage_knowledge with store: \"scratchpad\" to upsert or delete entries; read bodies via execute_sql on the \"scratchpad\" table):", ""];
      for (const entry of scratchpadTitles) {
        scratchpadLines.push(`[Scratchpad ${entry.id}] ${entry.title}`);
      }
      console.log(`[stavrobot] Injecting ${scratchpadTitles.length} scratchpad title(s) into system prompt`);
      systemPrompt = `${systemPrompt}\n\n${scratchpadLines.join("\n")}`;
    }
  } else {
    const agentSystemPrompt = subagentRow?.systemPrompt ?? "";
    const subagentAllowedTools = subagentRow?.allowedTools ?? [];

    const basePrompt = config.baseAgentPrompt + buildPromptSuffix(config.publicHostname);

    // Only inject the plugin list if the agent has plugin-related tools in its
    // whitelist. Injecting it for agents that cannot use plugins would be noise.
    const hasPluginTools = subagentAllowedTools.includes("*") ||
      subagentAllowedTools.includes("run_plugin_tool") ||
      subagentAllowedTools.includes("manage_plugins");
    const promptWithPlugins = pluginListSection !== undefined && hasPluginTools
      ? `${basePrompt}\n\n${pluginListSection}`
      : basePrompt;

    systemPrompt = agentSystemPrompt.trim() !== ""
      ? `${promptWithPlugins}\n\n${agentSystemPrompt}`
      : promptWithPlugins;
  }

  agent.setSystemPrompt(systemPrompt);

  const savePromises: Promise<void>[] = [];

  let resolvedMessage = userMessage;

  if (audio !== undefined) {
    if (config.stt !== undefined) {
      const audioBuffer = Buffer.from(audio, "base64");
      const resolvedContentType = audioContentType ?? "audio/ogg";
      const transcription = await transcribeAudio(audioBuffer, config.stt, resolvedContentType);
      const voiceNote = `[Voice note transcript]: ${transcription}`;
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
        `If you need to read it, use the manage_uploads tool with action "read". ` +
        `You shouldn't need to delete it, but if you do, use manage_uploads with action "delete".`;
      resolvedMessage = resolvedMessage !== undefined ? `${resolvedMessage}\n\n${notification}` : notification;

      if (isImage) {
        const fileData = await fs.readFile(attachment.storedPath);
        imageContents.push({ type: "image", data: fileData.toString("base64"), mimeType: attachment.mimeType });
      }
    }
  }

  const messageToSend = formatUserMessage(resolvedMessage ?? "", source, senderLabel);

  console.log("[stavrobot] Sending message to agent:", messageToSend);

  // Filter tools for subagents based on their allowed_tools list. The main
  // agent always gets the full tool set. For subagents, we temporarily swap
  // the tool list before the prompt and restore it after. The Agent class
  // provides a public setTools() method for this purpose.
  const fullTools = agent.state.tools;
  if (!isMainAgent) {
    const allowedTools = subagentRow?.allowedTools ?? [];
    // A wildcard means all tools are allowed (should only be agent 1 in practice).
    if (!allowedTools.includes("*")) {
      const filteredTools = filterToolsForSubagent(fullTools, allowedTools);
      agent.setTools(filteredTools);
    }
  }

  // The Pi agent loop's getApiKey callback runs inside an async context where thrown
  // errors become unhandled promise rejections that crash Node rather than propagating
  // through the stream's async iterator. By checking auth here before entering the agent
  // loop, we ensure AuthError propagates cleanly to the queue's error handler. This does
  // not cover the rare case where a token expires mid-conversation between tool calls.
  await getApiKey(config);

  // Track whether the first user message has been saved so we can attach sender
  // metadata only to that message.
  let firstUserMessageSaved = false;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message;
      if (message.role === "assistant") {
        const assistantMessage = message as unknown as AssistantMessage;
        if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
          return;
        }
      }
      if (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      ) {
        // Only the inbound user message carries sender metadata. Assistant and
        // toolResult messages are produced by the agent itself and have no
        // external sender.
        if (message.role === "user" && !firstUserMessageSaved) {
          firstUserMessageSaved = true;
          savePromises.push(saveMessage(pool, message, agentId, senderIdentityId, senderAgentId));
        } else {
          savePromises.push(saveMessage(pool, message, agentId));
        }
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
    // Restore the full tool list if it was filtered for a subagent.
    if (!isMainAgent) {
      agent.setTools(fullTools);
    }
    unsubscribe();
    await Promise.all(savePromises);
  }

  if (agent.state.error) {
    const errorJson = JSON.stringify(agent.state.error);
    console.error("[stavrobot] Agent error:", errorJson);
    // Remove error/aborted assistant messages from in-memory state so the next
    // prompt starts clean. These messages are stripped by the library's
    // transformMessages anyway, but leaving them in state can orphan adjacent
    // toolResult messages and cause 400 errors on subsequent prompts.
    const cleanedMessages = agent.state.messages.filter((message) => {
      if (message.role !== "assistant") return true;
      const assistantMessage = message as unknown as AssistantMessage;
      return assistantMessage.stopReason !== "error" && assistantMessage.stopReason !== "aborted";
    });
    agent.replaceMessages(cleanedMessages);
    agent.state.error = undefined;
    throw new Error(`Agent error: ${errorJson}`);
  }

  const lastAssistantMessage = agent.state.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");

  const responseText = lastAssistantMessage
    ? lastAssistantMessage.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("")
    : "";

  if (agent.state.messages.length > 40 && !compactionInProgress) {
    compactionInProgress = true;
    // Snapshot the messages now so the background task works on a stable slice
    // and never touches agent.state.messages directly.
    const currentMessages = agent.state.messages.slice();

    if (STAVROBOT_DEBUG) {
      console.log(`[stavrobot] [debug] Compaction triggered: ${currentMessages.length} messages in memory`);
      for (let i = 0; i < currentMessages.length; i++) {
        const message = currentMessages[i];
        const textPreview = typeof message.content === "string"
          ? message.content.slice(0, 200)
          : Array.isArray(message.content)
            ? message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("").slice(0, 200)
            : "";
        console.log(`[stavrobot] [debug]   [${i}] role=${message.role} text=${textPreview}`);
      }
    }

    void (async () => {
      try {
        // Advance the cut point to the next user message. A user message is always a
        // safe compaction boundary: it is never part of a tool-use/tool-result pair and
        // is never stripped by the library's transformMessages. Landing on an assistant
        // message risks orphaning a toolResult that follows it, which the Anthropic API
        // rejects with a 400 error.
        let cutIndex = currentMessages.length - 20;
        while (cutIndex < currentMessages.length && currentMessages[cutIndex].role !== "user") {
          cutIndex++;
        }

        // If no user message was found in the tail window, skip compaction for this turn.
        if (cutIndex >= currentMessages.length) {
          console.warn("[stavrobot] Compaction skipped: no user message found in tail window, no safe cut point found.");
          return;
        }

        const messagesToCompact = currentMessages.slice(0, cutIndex);
        const messagesToKeep = currentMessages.slice(cutIndex);

        if (STAVROBOT_DEBUG) {
          console.log(`[stavrobot] [debug] Cut point: index=${cutIndex}, compacting=${messagesToCompact.length}, keeping=${messagesToKeep.length}`);
          console.log(`[stavrobot] [debug] Last compacted message: role=${messagesToCompact[messagesToCompact.length - 1].role}`);
          console.log(`[stavrobot] [debug] First kept message: role=${messagesToKeep[0].role}`);
        }

        const serializedMessages = serializeMessagesForSummary(messagesToCompact);

        if (STAVROBOT_DEBUG) {
          console.log(`[stavrobot] [debug] Serialized input for summarizer (${serializedMessages.length} chars):`);
          console.log(serializedMessages);
        }

        const summarySystemPrompt = config.compactionPrompt;

        const apiKey = await getApiKey(config);
        const response = await complete(
          agent.state.model,
          {
            systemPrompt: summarySystemPrompt,
            messages: [
              {
                role: "user" as const,
                content: [
                  "Summarize the conversation inside <conversation> tags according to your system instructions.",
                  "",
                  "<conversation>",
                  serializedMessages,
                  "</conversation>",
                ].join("\n"),
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey, temperature: 0.1 }
        );

        const summaryText = response.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("");

        const previousCompaction = await loadLatestCompaction(pool, agentId);
        const previousBoundary = previousCompaction ? previousCompaction.upToMessageId : 0;

        // The boundary must be the last compacted message id. loadMessages keeps
        // rows with id > upToMessageId, so using keepCount (not keepCount - 1)
        // preserves exactly messagesToKeep. The query is scoped to this agent
        // so the boundary is correct even when multiple agents share the same
        // messages table.
        const keepCount = messagesToKeep.length;
        const cutoffResult = await pool.query(
          `SELECT id FROM messages WHERE agent_id = $1 AND id > $2 ORDER BY id DESC LIMIT 1 OFFSET ${keepCount}`,
          [agentId, previousBoundary],
        );
        if (cutoffResult.rows.length === 0) {
          console.warn("[stavrobot] Compaction skipped: no cutoff message found for computed boundary.");
          return;
        }
        const upToMessageId = cutoffResult.rows[0].id as number;

        if (STAVROBOT_DEBUG) {
          console.log(`[stavrobot] [debug] Boundary: previousBoundary=${previousBoundary}, keepCount=${keepCount}, upToMessageId=${upToMessageId}`);
        }

        await saveCompaction(pool, summaryText, upToMessageId, agentId);
        console.log(`[stavrobot] Background compaction complete: compacted ${messagesToCompact.length} messages, kept ${messagesToKeep.length}.`);
        compactionCompletedForAgent = agentId;
      } catch (error) {
        console.error("[stavrobot] Background compaction failed:", error instanceof Error ? error.message : String(error));
      } finally {
        compactionInProgress = false;
      }
    })();
  }

  return responseText;
}
