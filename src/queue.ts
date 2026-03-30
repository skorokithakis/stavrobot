import type pg from "pg";
import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { handlePrompt, formatUserMessage } from "./agent/index.js";
import { AbortError } from "./errors.js";
import { AuthError } from "./auth.js";
import { isInAllowlist } from "./allowlist.js";
import { sendSignalMessage } from "./signal.js";
import { sendTelegramMessage } from "./telegram-api.js";
import { sendWhatsappTextMessage } from "./whatsapp-api.js";
import type { FileAttachment } from "./uploads.js";
import { getMainAgentId, isOwnerIdentity, resolveInterlocutor, loadAgent } from "./database.js";
import { log } from "./log.js";

export const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

// Sources that require allowlist + interlocutor lookup before routing.
// All other external sources route directly to the main agent.
const GATED_SOURCES: string[] = ["signal", "telegram", "whatsapp", "email"];

// Channels where the owner interacts in real-time. Used to decide whether an
// incoming message while the agent is busy should steer the running turn
// instead of being queued behind it.
const INTERACTIVE_SOURCES: string[] = ["signal", "telegram", "whatsapp", "email"];

function isInteractiveOwnerMessage(source: string | undefined, sender: string | undefined): boolean {
  if (source === undefined) {
    // CLI calls have no source and are always from the owner.
    return true;
  }
  return INTERACTIVE_SOURCES.includes(source) && sender !== undefined && isOwnerIdentity(source, sender);
}

// Whether the message currently being processed belongs to the owner's
// conversation. Used to guard steering so owner messages don't get injected
// into subagent conversations.
function isCurrentEntryOwnerConversation(): boolean {
  if (currentEntry === undefined) return false;
  if (currentEntry.source === undefined) return true;
  if (currentEntry.sender === undefined) return false;
  return isOwnerIdentity(currentEntry.source, currentEntry.sender);
}

export interface RoutingResult {
  agentId: number;
  senderIdentityId: number | undefined;
  senderAgentId: number | undefined;
  senderLabel: string;
  isMainAgent: boolean;
}

interface QueueEntry {
  message: string | undefined;
  source: string | undefined;
  sender: string | undefined;
  attachments: FileAttachment[] | undefined;
  targetAgentId: number | undefined;
  retries: number;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

const queue: QueueEntry[] = [];
let processing = false;
let currentEntry: QueueEntry | undefined;

let queueAgent: Agent | undefined;
let queuePool: pg.Pool | undefined;
let queueConfig: Config | undefined;

export function initializeQueue(agent: Agent, pool: pg.Pool, config: Config): void {
  queueAgent = agent;
  queuePool = pool;
  queueConfig = config;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Internal sources are system-generated (not from external interlocutors) and
// always route to the owner conversation.
function isInternalSource(source: string): boolean {
  return source === "cli" || source === "cron" || source === "coder" || source === "upload" || source.startsWith("plugin:");
}

async function resolveTargetAgent(
  pool: pg.Pool,
  source: string | undefined,
  sender: string | undefined,
  targetAgentId: number | undefined,
): Promise<RoutingResult | null> {
  const mainAgentId = getMainAgentId();

  // Agent-to-agent message: targetAgentId must be set.
  if (source === "agent") {
    if (targetAgentId === undefined) {
      return null;
    }
    const senderAgentId = sender !== undefined ? Number(sender) : undefined;
    let senderLabel = "agent";
    if (senderAgentId !== undefined) {
      const senderAgent = await loadAgent(pool, senderAgentId);
      if (senderAgent !== null) {
        senderLabel = `${senderAgent.name} (ID: ${senderAgentId})`;
      }
    }
    return {
      agentId: targetAgentId,
      senderIdentityId: undefined,
      senderAgentId,
      senderLabel,
      isMainAgent: targetAgentId === mainAgentId,
    };
  }

  // If targetAgentId is set on a non-agent source, use it directly.
  if (targetAgentId !== undefined) {
    return {
      agentId: targetAgentId,
      senderIdentityId: undefined,
      senderAgentId: undefined,
      senderLabel: source ?? "unknown",
      isMainAgent: targetAgentId === mainAgentId,
    };
  }

  // Pure CLI call: no source and no sender. Route to main agent.
  if (source === undefined && sender === undefined) {
    return {
      agentId: mainAgentId,
      senderIdentityId: undefined,
      senderAgentId: undefined,
      senderLabel: "owner",
      isMainAgent: true,
    };
  }

  // Named internal sources (cli, cron, coder, plugin:*) always go to main agent.
  if (source !== undefined && isInternalSource(source)) {
    return {
      agentId: mainAgentId,
      senderIdentityId: undefined,
      senderAgentId: undefined,
      senderLabel: source,
      isMainAgent: true,
    };
  }

  // External messages require both source and sender. Drop if either is missing.
  if (source === undefined || sender === undefined) {
    return null;
  }

  // If the sender matches the owner's configured identities, route to main agent
  // without a DB lookup.
  if (isOwnerIdentity(source, sender)) {
    return {
      agentId: mainAgentId,
      senderIdentityId: undefined,
      senderAgentId: undefined,
      senderLabel: "owner",
      isMainAgent: true,
    };
  }

  // Non-gated external sources (e.g. pendant) route directly to the main agent
  // without allowlist or interlocutor checks.
  if (!GATED_SOURCES.includes(source)) {
    return {
      agentId: mainAgentId,
      senderIdentityId: undefined,
      senderAgentId: undefined,
      senderLabel: source,
      isMainAgent: true,
    };
  }

  // Hard gate: sender must be in the allowlist. Owner messages bypass this
  // check above, and internal sources are handled earlier in this function.
  if (!isInAllowlist(source, sender)) {
    log.info(`[stavrobot] Dropping message from sender not in allowlist: source=${source}, sender=${sender}`);
    return null;
  }

  // Look up the sender in the interlocutor_identities table (soft gate).
  const interlocutor = await resolveInterlocutor(pool, source, sender);
  if (interlocutor === null) {
    return null;
  }
  return {
    agentId: interlocutor.agentId,
    senderIdentityId: interlocutor.identityId,
    senderAgentId: undefined,
    senderLabel: interlocutor.displayName,
    isMainAgent: interlocutor.agentId === mainAgentId,
  };
}

// Extracts the human-readable message from a provider error string like:
// `Agent error: "400 {"type":"error","error":{"type":"...","message":"..."}}"`.
// Falls back to the raw error string if parsing fails.
export function parseProviderErrorMessage(errorMessage: string): string {
  const jsonMatch = /\d{3} (\{.+\})"?$/.exec(errorMessage);
  if (jsonMatch !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "error" in parsed &&
        parsed.error !== null &&
        typeof parsed.error === "object" &&
        "message" in parsed.error &&
        typeof (parsed.error as Record<string, unknown>).message === "string"
      ) {
        return (parsed.error as Record<string, unknown>).message as string;
      }
    } catch {
      // Fall through to return the raw error message.
    }
  }
  return errorMessage;
}

async function sendErrorToSource(
  source: string | undefined,
  sender: string | undefined,
  config: Config,
  message: string,
): Promise<void> {
  if (source === "signal" && sender !== undefined) {
    try {
      await sendSignalMessage(sender, message);
    } catch (sendError) {
      log.error(`[stavrobot] Failed to send Signal error notification: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    }
  } else if (source === "telegram" && sender !== undefined) {
    try {
      await sendTelegramMessage(config.telegram!.botToken, sender, message);
    } catch (sendError) {
      log.error(`[stavrobot] Failed to send Telegram error notification: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    }
  } else if (source === "whatsapp" && sender !== undefined) {
    try {
      await sendWhatsappTextMessage(sender, message);
    } catch (sendError) {
      log.error(`[stavrobot] Failed to send WhatsApp error notification: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    }
  }
}

async function processQueue(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const entry = queue.shift()!;
    const preview = (entry.message ?? "").slice(0, 200);
    log.info(`[stavrobot] message in: ${entry.source} - ${entry.sender} - ${preview}`);
    currentEntry = entry;
    try {
      const routing = await resolveTargetAgent(queuePool!, entry.source, entry.sender, entry.targetAgentId);
      if (routing === null) {
        log.warn(`[stavrobot] Dropping message: could not resolve target agent. source=${entry.source}, sender=${entry.sender}`);
        entry.resolve("");
        continue;
      }
      const response = await handlePrompt(queueAgent!, queuePool!, entry.message, queueConfig!, routing, entry.source, entry.attachments);
      entry.resolve(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof AbortError) {
        log.info("[stavrobot] Agent was aborted, resolving cleanly.");
        entry.resolve("Aborted.");
      } else if (error instanceof AuthError) {
        log.error(`[stavrobot] Auth failure, not retrying: ${errorMessage}`);
        const loginMessage = `Authentication required. Visit ${queueConfig!.publicHostname}/login to log in.`;
        await sendErrorToSource(entry.source, entry.sender, queueConfig!, loginMessage);
        entry.resolve(loginMessage);
      } else if (errorMessage.includes("400 {")) {
        log.error(`[stavrobot] Non-retryable API error (400 client error), not retrying: ${errorMessage}`);
        const userMessage = `Something went wrong: ${parseProviderErrorMessage(errorMessage)}`;
        await sendErrorToSource(entry.source, entry.sender, queueConfig!, userMessage);
        entry.resolve(userMessage);
      } else if (entry.retries < MAX_RETRIES) {
        const attempt = entry.retries + 1;
        log.info(`[stavrobot] Message failed (attempt ${attempt}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS / 1000}s: ${errorMessage}`);
        await sleep(RETRY_DELAY_MS);
        queue.push({ ...entry, retries: attempt });
      } else {
        log.error(`[stavrobot] Message failed after ${MAX_RETRIES + 1} attempts, giving up: ${errorMessage}`);
        const userMessage = `Something went wrong: ${parseProviderErrorMessage(errorMessage)}`;
        await sendErrorToSource(entry.source, entry.sender, queueConfig!, userMessage);
        entry.resolve(userMessage);
      }
    } finally {
      currentEntry = undefined;
    }
  }
  processing = false;
}

export function enqueueMessage(
  message: string | undefined,
  source?: string,
  sender?: string,
  attachments?: FileAttachment[],
  targetAgentId?: number,
): Promise<string> {
  if (message !== undefined && message.trim().toLowerCase() === "/stop") {
    if (processing) {
      log.info("[stavrobot] /stop received, aborting running agent.");
      queueAgent!.abort();
    } else {
      log.info("[stavrobot] /stop received but agent is idle, no-op.");
    }
    return Promise.resolve("Aborted.");
  }

  if (processing && message !== undefined && isCurrentEntryOwnerConversation() && isInteractiveOwnerMessage(source, sender)) {
    const formatted = formatUserMessage(message, source, "owner");
    const agentMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: formatted }],
      timestamp: Date.now(),
    };
    queueAgent!.steer(agentMessage);
    log.info(`[stavrobot] Steering agent with message from ${source ?? "cli"}.`);
    return Promise.resolve("Message received, steering the current request.");
  }

  return new Promise<string>((resolve, reject) => {
    queue.push({ message, source, sender, attachments, targetAgentId, retries: 0, resolve, reject });
    if (!processing) {
      void processQueue();
    }
  });
}
