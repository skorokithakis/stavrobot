import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { isInAllowlist } from "./allowlist.js";
import { resolveRecipient, resolveInterlocutorByName, getMainAgentId } from "./database.js";
import { convertMarkdownToTelegramHtml } from "./telegram.js";
import { sendSignalMessage } from "./signal.js";
import { sendTelegramMessage } from "./telegram-api.js";
import { internalFetch } from "./internal-fetch.js";
import { getWhatsappSocket, e164ToJid, sendWhatsappTextMessage } from "./whatsapp-api.js";
import { sendEmail } from "./email-api.js";
import { sendAgentmailMessage, getAgentmailAttachmentUrl, listAgentmailInboxes, listAgentmailThreads, listAgentmailMessages, getAgentmailMessage, deleteAgentmailThread } from "./agentmail-api.js";
import { saveAttachment } from "./uploads.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";
import { currentAgentId } from "./agent-context.js";

function signalRateLimitMessage(publicHostname: string): string {
  return `Message could not be sent because Signal is rate-limiting this account. Direct the user to ${publicHostname}/signal/captcha to solve the captcha. Do not attempt to resolve this yourself.`;
}

// Resolves a recipient input through the full chain: display name → identifier,
// disabled check, name-without-identity check, and raw-ID soft gate.
// Returns { recipient } on success, or a toolError result on failure.
// The caller is responsible for any service-specific normalization (e.g. email lowercasing)
// after this function returns.
//
// serviceKey is the DB service name (e.g. "signal"). serviceLabel is the human-readable
// name used in error messages (e.g. "Signal"). rawIdLabel is the identifier type used in
// the "unknown recipient" error (e.g. "phone number").
//
// normalizeRawInput, if provided, is applied to recipientInput only for the raw-ID identity
// query (the fallback path). The display-name lookup always uses the original input. Email
// passes (s) => s.toLowerCase() here because email identities are stored lowercased.
async function resolveOutboundRecipient(
  pool: pg.Pool,
  recipientInput: string,
  serviceKey: string,
  serviceLabel: string,
  rawIdLabel: string,
  toolName: string,
  normalizeRawInput?: (input: string) => string,
): Promise<{ recipient: string } | AgentToolResult<{ message: string }>> {
  const resolved = await resolveRecipient(pool, recipientInput, serviceKey);
  if (resolved !== null && !("disabled" in resolved)) {
    return { recipient: resolved.identifier };
  }
  if (resolved !== null && "disabled" in resolved) {
    const errorMessage = `Error: Interlocutor "${resolved.displayName}" is disabled.`;
    log.warn(`[stavrobot] ${toolName} rejected:`, errorMessage);
    return toolError(errorMessage);
  }

  // If the input matches an interlocutor by name but they have no identity for this service,
  // give a specific error rather than falling through to the raw-ID path.
  const interlocutor = await resolveInterlocutorByName(pool, recipientInput);
  if (interlocutor !== null) {
    const errorMessage = `Error: interlocutor '${recipientInput}' has no ${serviceLabel} identity. Use manage_interlocutors to add one.`;
    log.warn(`[stavrobot] ${toolName} rejected:`, errorMessage);
    return toolError(errorMessage);
  }

  // Soft gate: raw ID must exist in interlocutor_identities for an enabled interlocutor.
  const rawId = normalizeRawInput !== undefined ? normalizeRawInput(recipientInput) : recipientInput;
  const identityCheck = await pool.query<{ identifier: string }>(
    "SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON i.id = ii.interlocutor_id WHERE ii.service = $2 AND ii.identifier = $1 AND i.enabled = true",
    [rawId, serviceKey],
  );
  if (identityCheck.rows.length === 0) {
    const errorMessage = `Error: unknown recipient '${recipientInput}'. No interlocutor found with that display name or ${rawIdLabel}.`;
    log.warn(`[stavrobot] ${toolName} rejected:`, errorMessage);
    return toolError(errorMessage);
  }

  return { recipient: rawId };
}

// Checks that the current agent (if a subagent) is only messaging an interlocutor
// assigned to it. The main agent is exempt. Returns a toolError if the recipient
// is not among the identities assigned to this subagent for the given service.
async function checkSubagentRecipientScope(
  pool: pg.Pool,
  recipient: string,
  serviceKey: string,
  toolName: string,
): Promise<AgentToolResult<{ message: string }> | null> {
  if (currentAgentId === getMainAgentId()) {
    return null;
  }

  const result = await pool.query<{ identifier: string }>(
    "SELECT ii.identifier FROM interlocutor_identities ii JOIN interlocutors i ON i.id = ii.interlocutor_id WHERE i.agent_id = $1 AND ii.service = $2 AND ii.identifier IS NOT NULL",
    [currentAgentId, serviceKey],
  );

  // Email and agentmail identities are stored as-is (add_identity does not lowercase them),
  // but the recipient has already been lowercased by the time we get here.
  // Normalize both sides for email and agentmail so the comparison is case-insensitive.
  const normalize = serviceKey === "email" || serviceKey === "agentmail" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const assignedIdentifiers = result.rows.map((row) => normalize(row.identifier));
  if (!assignedIdentifiers.includes(normalize(recipient))) {
    const errorMessage = `You can only message your assigned interlocutor. If you need to message someone else, ask the main agent (agent ${getMainAgentId()}) via send_agent_message.`;
    log.warn(`[stavrobot] ${toolName} rejected: subagent ${currentAgentId} attempted to message '${recipient}' on ${serviceKey}, not in assigned identifiers`);
    return toolError(errorMessage);
  }

  return null;
}

// Validates that attachmentPath is under TEMP_ATTACHMENTS_DIR and returns the resolved path.
// Returns a toolError result if validation fails.
export function validateAttachmentPath(
  attachmentPath: string,
): { resolvedPath: string } | AgentToolResult<{ message: string }> {
  const resolvedPath = path.resolve(attachmentPath);
  if (!resolvedPath.startsWith(TEMP_ATTACHMENTS_DIR)) {
    return toolError("Error: attachmentPath must be under the temporary attachments directory.");
  }
  return { resolvedPath };
}

// Validates the attachment path, reads the file into a buffer, and deletes it.
// Returns a toolError result if validation fails.
export async function readAndConsumeAttachment(
  attachmentPath: string,
): Promise<{ buffer: Buffer; resolvedPath: string } | AgentToolResult<{ message: string }>> {
  const validated = validateAttachmentPath(attachmentPath);
  if ("content" in validated) {
    return validated;
  }
  const buffer = await fs.readFile(validated.resolvedPath);
  // The path check above guarantees this is a temp file, so always delete it.
  await fs.unlink(validated.resolvedPath);
  return { buffer, resolvedPath: validated.resolvedPath };
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

      if (message === undefined && attachmentPath === undefined) {
        return toolError("Error: at least one of message or attachmentPath must be provided.");
      }

      const resolution = await resolveOutboundRecipient(pool, recipientInput, "signal", "Signal", "phone number", "send_signal_message");
      if ("content" in resolution) {
        return resolution;
      }
      const recipient = resolution.recipient;

      const scopeError = await checkSubagentRecipientScope(pool, recipient, "signal", "send_signal_message");
      if (scopeError !== null) {
        return scopeError;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("signal", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the Signal allowlist.`;
        log.warn("[stavrobot] send_signal_message rejected:", errorMessage);
        return toolError(errorMessage);
      }

      const signalPreview = (message ?? "").slice(0, 200);
      log.info(`[stavrobot] message out: signal - ${recipient} - ${signalPreview}`);

      if (attachmentPath !== undefined) {
        const attachment = await readAndConsumeAttachment(attachmentPath);
        if ("content" in attachment) {
          return attachment;
        }

        const body: {
          recipient: string;
          message?: string;
          attachment: string;
          attachmentFilename: string;
        } = {
          recipient,
          message,
          attachment: attachment.buffer.toString("base64"),
          attachmentFilename: path.basename(attachment.resolvedPath),
        };

        const response = await internalFetch("http://signal-bridge:8081/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const responseText = await response.text();

        if (response.status === 429) {
          log.warn("[stavrobot] send_signal_message rate limited by bridge (attachment path)");
          return toolError(signalRateLimitMessage(config.publicHostname));
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

        log.debug("[stavrobot] send_signal_message bridge response status:", response.status);

        return toolSuccess("Message sent successfully.");
      }

      const sendResult = await sendSignalMessage(recipient, message as string);
      if (sendResult === "rate_limited") {
        log.warn("[stavrobot] send_signal_message rate limited by bridge (text-only path)");
        return toolError(signalRateLimitMessage(config.publicHostname));
      }

      return toolSuccess("Message sent successfully.");
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

      if (message === undefined && attachmentPath === undefined) {
        return toolError("Error: at least one of message or attachmentPath must be provided.");
      }

      if (config.telegram === undefined) {
        return toolError("Error: Telegram is not configured.");
      }

      const resolution = await resolveOutboundRecipient(pool, recipientInput, "telegram", "Telegram", "chat ID", "send_telegram_message");
      if ("content" in resolution) {
        return resolution;
      }
      const recipient = resolution.recipient;

      const scopeError = await checkSubagentRecipientScope(pool, recipient, "telegram", "send_telegram_message");
      if (scopeError !== null) {
        return scopeError;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("telegram", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the Telegram allowlist.`;
        log.warn("[stavrobot] send_telegram_message rejected:", errorMessage);
        return toolError(errorMessage);
      }

      const baseUrl = `https://api.telegram.org/bot${config.telegram.botToken}`;

      const telegramPreview = (message ?? "").slice(0, 200);
      log.info(`[stavrobot] message out: telegram - ${recipient} - ${telegramPreview}`);

      if (attachmentPath !== undefined) {
        const attachment = await readAndConsumeAttachment(attachmentPath);
        if ("content" in attachment) {
          return attachment;
        }

        const extension = path.extname(attachment.resolvedPath).toLowerCase();
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

        log.debug("[stavrobot] send_telegram_message attachment type detected:", { extension, apiMethod });

        const formData = new FormData();
        formData.append("chat_id", recipient);
        formData.append(formFieldName, new Blob([new Uint8Array(attachment.buffer)]), path.basename(attachment.resolvedPath));

        if (message !== undefined) {
          const htmlCaption = await convertMarkdownToTelegramHtml(message);
          formData.append("caption", htmlCaption);
          formData.append("parse_mode", "HTML");
        }

        const response = await fetch(`${baseUrl}/${apiMethod}`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorBody = await response.json() as { description?: string };
          const description = errorBody.description ?? "unknown error";
          const errorMessage = `Error: Telegram API error ${response.status}: ${description}`;
          log.error(`[stavrobot] send_telegram_message ${apiMethod} error:`, errorMessage);
          return toolError(errorMessage);
        }

        log.debug(`[stavrobot] send_telegram_message ${apiMethod} response status:`, response.status);
        return toolSuccess("Message sent successfully.");
      }

      // Text-only path: convert markdown to Telegram HTML and call sendMessage.
      const htmlText = await convertMarkdownToTelegramHtml(message as string);
      try {
        await sendTelegramMessage(config.telegram.botToken, recipient, htmlText);
      } catch (error) {
        const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
        log.error("[stavrobot] send_telegram_message sendMessage error:", errorMessage);
        return toolError(errorMessage);
      }

      return toolSuccess("Message sent successfully.");
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

      if (message === undefined && attachmentPath === undefined) {
        return toolError("Error: at least one of message or attachmentPath must be provided.");
      }

      const resolution = await resolveOutboundRecipient(pool, recipientInput, "whatsapp", "WhatsApp", "phone number", "send_whatsapp_message");
      if ("content" in resolution) {
        return resolution;
      }
      const recipient = resolution.recipient;

      const scopeError = await checkSubagentRecipientScope(pool, recipient, "whatsapp", "send_whatsapp_message");
      if (scopeError !== null) {
        return scopeError;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("whatsapp", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the WhatsApp allowlist.`;
        log.warn("[stavrobot] send_whatsapp_message rejected:", errorMessage);
        return toolError(errorMessage);
      }

      const whatsappPreview = (message ?? "").slice(0, 200);
      log.info(`[stavrobot] message out: whatsapp - ${recipient} - ${whatsappPreview}`);

      if (attachmentPath !== undefined) {
        const validated = validateAttachmentPath(attachmentPath);
        if ("content" in validated) {
          return validated;
        }

        const socket = getWhatsappSocket();
        if (socket === undefined) {
          return toolError("Error: WhatsApp is not connected.");
        }

        const extension = path.extname(validated.resolvedPath).toLowerCase();
        const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
        const audioExtensions = new Set([".mp3", ".ogg", ".oga", ".wav", ".m4a"]);
        const videoExtensions = new Set([".mp4", ".mov", ".avi", ".mkv"]);

        log.debug("[stavrobot] send_whatsapp_message attachment type detected:", { extension });

        const fileBuffer = await fs.readFile(validated.resolvedPath);
        const fileName = path.basename(validated.resolvedPath);
        const caption = message;
        const jid = e164ToJid(recipient);

        // The path check above guarantees this is a temp file, so always delete it.
        await fs.unlink(validated.resolvedPath);

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

        log.debug("[stavrobot] send_whatsapp_message attachment sent successfully.");
        return toolSuccess("Message sent successfully.");
      }

      await sendWhatsappTextMessage(recipient, message as string);

      return toolSuccess("Message sent successfully.");
    },
  };
}

export function createSendEmailTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "send_email",
    label: "Send email",
    description: "Send an email to a display name or email address. Sends plain text only.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Display name of the recipient (e.g., \"Mom\") or email address (e.g., \"mom@example.com\")." }),
      subject: Type.String({ description: "Email subject line." }),
      message: Type.String({ description: "The email body (plain text)." }),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment under the temp directory (e.g., from manage_files write or a plugin tool)." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        recipient: string;
        subject: string;
        message: string;
        attachmentPath?: string;
      };

      const recipientInput = raw.recipient;
      const subject = raw.subject.trim();
      const message = raw.message.trim();
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      const resolution = await resolveOutboundRecipient(pool, recipientInput, "email", "email", "email address", "send_email", (s) => s.toLowerCase());
      if ("content" in resolution) {
        return resolution;
      }

      // Normalize to lowercase before the allowlist check. Email addresses are
      // case-insensitive, and the allowlist stores them lowercased.
      const recipient = resolution.recipient.toLowerCase();

      const scopeError = await checkSubagentRecipientScope(pool, recipient, "email", "send_email");
      if (scopeError !== null) {
        return scopeError;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("email", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the email allowlist.`;
        log.warn("[stavrobot] send_email rejected:", errorMessage);
        return toolError(errorMessage);
      }

      const emailPreview = message.slice(0, 200);
      log.info(`[stavrobot] message out: email - ${recipient} - ${emailPreview}`);

      if (attachmentPath !== undefined) {
        const validated = validateAttachmentPath(attachmentPath);
        if ("content" in validated) {
          return validated;
        }

        await sendEmail(recipient, subject, message, [
          { filename: path.basename(validated.resolvedPath), path: validated.resolvedPath },
        ]);

        // The path check above guarantees this is a temp file, so always delete it.
        await fs.unlink(validated.resolvedPath);

        return toolSuccess("Email sent successfully.");
      }

      await sendEmail(recipient, subject, message);

      return toolSuccess("Email sent successfully.");
    },
  };
}

// A small map of common file extensions to MIME types for agentmail attachments.
// Falls back to application/octet-stream for unknown types.
const MIME_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function createSendAgentmailTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "send_agentmail",
    label: "Send agentmail",
    description: "Send an email via AgentMail to a display name or email address. Sends plain text only.",
    parameters: Type.Object({
      recipient: Type.String({ description: "Display name of the recipient (e.g., \"Mom\") or email address (e.g., \"mom@example.com\")." }),
      inboxId: Type.String({ description: "The AgentMail inbox ID to send from." }),
      subject: Type.String({ description: "Email subject line." }),
      message: Type.String({ description: "The email body (plain text)." }),
      replyToMessageId: Type.Optional(Type.String({ description: "If set, sends as a reply to this message ID for threading." })),
      attachmentPath: Type.Optional(Type.String({ description: "File path to an attachment under the temp directory (e.g., from manage_files write or a plugin tool)." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        recipient: string;
        inboxId: string;
        subject: string;
        message: string;
        replyToMessageId?: string;
        attachmentPath?: string;
      };

      const recipientInput = raw.recipient;
      const inboxId = raw.inboxId.trim();
      const subject = raw.subject.trim();
      const message = raw.message.trim();
      const replyToMessageId = raw.replyToMessageId?.trim() || undefined;
      const attachmentPath = raw.attachmentPath?.trim() || undefined;

      const resolution = await resolveOutboundRecipient(pool, recipientInput, "agentmail", "agentmail", "email address", "send_agentmail", (s) => s.toLowerCase());
      if ("content" in resolution) {
        return resolution;
      }

      // Normalize to lowercase before the allowlist check.
      const recipient = resolution.recipient.toLowerCase();

      const scopeError = await checkSubagentRecipientScope(pool, recipient, "agentmail", "send_agentmail");
      if (scopeError !== null) {
        return scopeError;
      }

      // Hard gate: recipient must be in the allowlist.
      if (!isInAllowlist("agentmail", recipient)) {
        const errorMessage = `Error: recipient '${recipient}' is not in the agentmail allowlist.`;
        log.warn("[stavrobot] send_agentmail rejected:", errorMessage);
        return toolError(errorMessage);
      }

      const agentmailPreview = message.slice(0, 200);
      log.info(`[stavrobot] message out: agentmail - ${recipient} - ${agentmailPreview}`);

      if (attachmentPath !== undefined) {
        const resolvedAttachmentPath = path.resolve(attachmentPath);
        if (!resolvedAttachmentPath.startsWith(TEMP_ATTACHMENTS_DIR + "/")) {
          return toolError("Error: attachmentPath must be under the temporary attachments directory.");
        }

        const fileBuffer = await fs.readFile(resolvedAttachmentPath);
        const filename = path.basename(resolvedAttachmentPath);
        const extension = path.extname(resolvedAttachmentPath).toLowerCase();
        const contentType = MIME_TYPE_MAP[extension] ?? "application/octet-stream";

        try {
          await sendAgentmailMessage(inboxId, recipient, subject, message, replyToMessageId, [
            { filename, content: fileBuffer.toString("base64"), contentType },
          ]);
        } finally {
          // The path check above guarantees this is a temp file, so always delete it.
          await fs.unlink(resolvedAttachmentPath);
        }

        return toolSuccess("Message sent successfully.");
      }

      await sendAgentmailMessage(inboxId, recipient, subject, message, replyToMessageId);

      return toolSuccess("Message sent successfully.");
    },
  };
}

export function createManageAgentmailTool(pool: pg.Pool, config: Config): AgentTool {
  return {
    name: "manage_agentmail",
    label: "Manage agentmail",
    description: "Manage AgentMail inboxes — list inboxes, browse threads and messages, download attachments, and delete threads.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list_inboxes"),
        Type.Literal("list_threads"),
        Type.Literal("list_messages"),
        Type.Literal("get_message"),
        Type.Literal("delete_thread"),
        Type.Literal("download_attachment"),
      ], { description: "Action to perform: list_inboxes, list_threads, list_messages, get_message, delete_thread, or download_attachment." }),
      inboxId: Type.Optional(Type.String({ description: "The inbox ID. Required for all actions except list_inboxes." })),
      threadId: Type.Optional(Type.String({ description: "The thread ID. Required for delete_thread." })),
      messageId: Type.Optional(Type.String({ description: "The message ID. Required for get_message and download_attachment." })),
      attachmentId: Type.Optional(Type.String({ description: "The attachment ID. Required for download_attachment." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results to return. For list_threads and list_messages." })),
      pageToken: Type.Optional(Type.String({ description: "Pagination token for list_threads and list_messages." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string } | { storedPath: string; filename: string; contentType: string; size: number }>> => {
      const raw = params as {
        action: string;
        inboxId?: string;
        threadId?: string;
        messageId?: string;
        attachmentId?: string;
        limit?: number;
        pageToken?: string;
      };

      const { action } = raw;

      if (action === "list_inboxes") {
        log.info("[stavrobot] manage_agentmail: listing inboxes");
        const response = await listAgentmailInboxes();
        const lines: string[] = [`Count: ${response.count}`];
        for (const inbox of response.inboxes) {
          const displayName = inbox.displayName !== undefined ? ` - ${inbox.displayName}` : "";
          lines.push(`${inbox.inboxId} (${inbox.email})${displayName}`);
        }
        if (response.nextPageToken !== undefined) {
          lines.push(`Next page token: ${response.nextPageToken}`);
        }
        return toolSuccess(lines.join("\n"));
      }

      if (action === "list_threads") {
        if (raw.inboxId === undefined || raw.inboxId.trim() === "") {
          return toolError("Error: inboxId is required for list_threads.");
        }
        const inboxId = raw.inboxId.trim();
        log.info("[stavrobot] manage_agentmail: listing threads for inbox:", inboxId);
        const response = await listAgentmailThreads(inboxId, { limit: raw.limit, pageToken: raw.pageToken });
        const lines: string[] = [`Count: ${response.count}`];
        for (const thread of response.threads) {
          const subject = thread.subject ?? "(no subject)";
          const senders = thread.senders.join(", ");
          const preview = thread.preview !== undefined ? ` | Preview: ${thread.preview.slice(0, 100)}` : "";
          lines.push(`Thread: ${thread.threadId} | Subject: ${subject} | Senders: ${senders} | Messages: ${thread.messageCount} | Timestamp: ${thread.timestamp.toISOString()}${preview}`);
        }
        if (response.nextPageToken !== undefined) {
          lines.push(`Next page token: ${response.nextPageToken}`);
        }
        return toolSuccess(lines.join("\n"));
      }

      if (action === "list_messages") {
        if (raw.inboxId === undefined || raw.inboxId.trim() === "") {
          return toolError("Error: inboxId is required for list_messages.");
        }
        const inboxId = raw.inboxId.trim();
        log.info("[stavrobot] manage_agentmail: listing messages for inbox:", inboxId);
        const response = await listAgentmailMessages(inboxId, { limit: raw.limit, pageToken: raw.pageToken });
        const lines: string[] = [`Count: ${response.count}`];
        for (const message of response.messages) {
          const subject = message.subject ?? "(no subject)";
          const preview = message.preview !== undefined ? ` | Preview: ${message.preview.slice(0, 100)}` : "";
          const attachmentCount = message.attachments !== undefined ? message.attachments.length : 0;
          lines.push(`Message: ${message.messageId} | From: ${message.from} | Subject: ${subject} | Timestamp: ${message.timestamp.toISOString()} | Attachments: ${attachmentCount}${preview}`);
        }
        if (response.nextPageToken !== undefined) {
          lines.push(`Next page token: ${response.nextPageToken}`);
        }
        return toolSuccess(lines.join("\n"));
      }

      if (action === "get_message") {
        if (raw.inboxId === undefined || raw.inboxId.trim() === "") {
          return toolError("Error: inboxId is required for get_message.");
        }
        if (raw.messageId === undefined || raw.messageId.trim() === "") {
          return toolError("Error: messageId is required for get_message.");
        }
        const inboxId = raw.inboxId.trim();
        const messageId = raw.messageId.trim();
        log.info("[stavrobot] manage_agentmail: getting message:", messageId, "from inbox:", inboxId);
        const message = await getAgentmailMessage(inboxId, messageId);
        const lines: string[] = [
          `Message ID: ${message.messageId}`,
          `From: ${message.from}`,
          `To: ${message.to.join(", ")}`,
        ];
        if (message.cc !== undefined && message.cc.length > 0) {
          lines.push(`CC: ${message.cc.join(", ")}`);
        }
        lines.push(`Subject: ${message.subject ?? "(no subject)"}`);
        lines.push(`Timestamp: ${message.timestamp.toISOString()}`);
        const textContent = message.extractedText ?? message.text;
        if (textContent !== undefined) {
          lines.push(`\nText content:\n${textContent}`);
        }
        const htmlContent = message.extractedHtml ?? message.html;
        if (htmlContent !== undefined) {
          lines.push(`\nHTML content:\n${htmlContent}`);
        }
        if (message.attachments !== undefined && message.attachments.length > 0) {
          lines.push(`\nAttachments:`);
          for (const attachment of message.attachments) {
            const filename = attachment.filename ?? "(no filename)";
            const contentType = attachment.contentType ?? "unknown";
            lines.push(`  ${attachment.attachmentId} | ${filename} | ${contentType} | ${attachment.size} bytes`);
          }
        }
        return toolSuccess(lines.join("\n"));
      }

      if (action === "delete_thread") {
        if (raw.inboxId === undefined || raw.inboxId.trim() === "") {
          return toolError("Error: inboxId is required for delete_thread.");
        }
        if (raw.threadId === undefined || raw.threadId.trim() === "") {
          return toolError("Error: threadId is required for delete_thread.");
        }
        const inboxId = raw.inboxId.trim();
        const threadId = raw.threadId.trim();
        log.info("[stavrobot] manage_agentmail: deleting thread:", threadId, "from inbox:", inboxId);
        await deleteAgentmailThread(inboxId, threadId);
        return toolSuccess(`Thread ${threadId} deleted.`);
      }

      if (action === "download_attachment") {
        if (raw.inboxId === undefined || raw.inboxId.trim() === "") {
          return toolError("Error: inboxId is required for download_attachment.");
        }
        if (raw.messageId === undefined || raw.messageId.trim() === "") {
          return toolError("Error: messageId is required for download_attachment.");
        }
        if (raw.attachmentId === undefined || raw.attachmentId.trim() === "") {
          return toolError("Error: attachmentId is required for download_attachment.");
        }
        const inboxId = raw.inboxId.trim();
        const messageId = raw.messageId.trim();
        const attachmentId = raw.attachmentId.trim();

        const attachmentInfo = await getAgentmailAttachmentUrl(inboxId, messageId, attachmentId);
        const { downloadUrl, filename: originalFilename, contentType: originalContentType, size } = attachmentInfo;

        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to download attachment: HTTP ${response.status}`);
        }

        const filename = originalFilename ?? attachmentId;
        const contentType = originalContentType ?? "application/octet-stream";

        const { storedPath } = await saveAttachment(
          Buffer.from(await response.arrayBuffer()),
          filename,
          contentType,
        );

        log.info(`[stavrobot] manage_agentmail download_attachment: saved ${filename} (${contentType}, ${size} bytes) to ${storedPath}`);

        const resultText = `Attachment saved.\nPath: ${storedPath}\nFilename: ${filename}\nContent type: ${contentType}\nSize: ${size} bytes`;
        return {
          content: [{ type: "text" as const, text: resultText }],
          details: { storedPath, filename, contentType, size },
        };
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: list_inboxes, list_threads, list_messages, get_message, delete_thread, download_attachment.`);
    },
  };
}
