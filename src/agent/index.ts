import fs from "node:fs/promises";
import pg from "pg";
import { Type, getModel, type Model, type Api, type TextContent, type ImageContent, type AssistantMessage, type ToolCall } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config } from "../config.js";
import type { FileAttachment } from "../uploads.js";
import { getApiKey } from "../auth.js";
import { executeSql, loadMessages, saveMessage, saveCompaction, loadLatestCompaction, loadAllMemories, upsertMemory, deleteMemory, upsertScratchpad, deleteScratchpad, readScratchpad, createCronEntry, updateCronEntry, deleteCronEntry, listCronEntries, loadAllScratchpadTitles, getMainAgentId, loadAgent, type Memory, type Agent as AgentRow } from "../database.js";
import type { RoutingResult } from "../queue.js";
import { reloadScheduler } from "../scheduler.js";
import { createManagePluginsTool, createRunPluginToolTool, createRequestCodingTaskTool } from "../plugin-tools.js";
import { createRunPythonTool } from "../python.js";
import { createManagePagesTool } from "../pages.js";
import { createManageFilesTool } from "../files.js";
import { createManageInterlocutorsTool } from "../interlocutors.js";
import { createManageAgentsTool } from "../agents.js";
import { createSendAgentMessageTool } from "../send-agent-message.js";
import { createSearchTool, runSearch } from "../search.js";
import { createManageUploadsTool } from "../upload-tools.js";
import { encodeToToon } from "../toon.js";
import { log } from "../log.js";
import { AbortError } from "../errors.js";
import { toolError, toolSuccess } from "../tool-result.js";
import { createSendSignalMessageTool, createSendTelegramMessageTool, createSendWhatsappMessageTool, createSendEmailTool } from "../send-tools.js";
import { currentAgentId, setCurrentAgentId } from "../agent-context.js";
export { currentAgentId } from "../agent-context.js";
import {
  buildPromptSuffix,
  AUTO_SEARCH_MIN_LENGTH,
  AUTO_SEARCH_LIMIT,
  AUTO_SEARCH_SOURCES,
  buildAutoSearchBlock,
  pendingAutoSearchBlocks,
  estimateTokens,
  truncateContext,
  injectAutoSearchBlock,
  serializeMessagesForSummary,
  escalatingSummarize,
  selectCompactionCutIndex,
} from "./compaction.js";
import {
  filterToolsForSubagent,
  buildPluginAccessMap,
  fetchPluginList,
  fetchPluginDetails,
  formatPluginListSection,
  type PluginEntry,
} from "./plugins.js";
export { TEMP_ATTACHMENTS_DIR } from "../temp-dir.js";
export { AbortError } from "../errors.js";
export { createSendSignalMessageTool, createSendTelegramMessageTool, createSendWhatsappMessageTool, createSendEmailTool } from "../send-tools.js";

// Re-export everything from the extracted modules so external importers that
// import from "./agent.js" continue to work without changes.
export {
  buildPromptSuffix,
  AUTO_SEARCH_MIN_LENGTH,
  AUTO_SEARCH_LIMIT,
  AUTO_SEARCH_SNIPPET_LENGTH,
  AUTO_SEARCH_SOURCES,
  buildAutoSearchBlock,
  pendingAutoSearchBlocks,
  CHARS_PER_TOKEN,
  estimateTokens,
  isTurnBoundary,
  selectCompactionCutIndex,
  truncateContext,
  injectAutoSearchBlock,
  serializeMessagesForSummary,
  escalatingSummarize,
} from "./compaction.js";
export {
  filterToolsForSubagent,
  buildPluginAccessMap,
  fetchPluginList,
  fetchPluginDetails,
  formatPluginListSection,
} from "./plugins.js";
export type { PluginEntry } from "./plugins.js";

// A simple boolean flag to prevent concurrent compaction runs. If a compaction
// is already in progress when another request triggers the threshold, we skip
// rather than queue, because queuing would compact already-compacted messages.
let compactionInProgress = false;

// Set to the agent ID whose compaction just finished. The next handlePrompt
// call for that agent checks this and reloads messages from the DB. Stored as
// an ID rather than a boolean so that a compaction for agent A does not trigger
// a reload when the next message is for agent B.
let compactionCompletedForAgent: number | null = null;

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
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { query } = params as { query: string };
      const result = await executeSql(pool, query);
      return toolSuccess(result);
    },
  };
}

const MANAGE_KNOWLEDGE_HELP_TEXT = `manage_knowledge: upsert, delete, or read entries in the two-tier knowledge store.

Stores:
- memory: full content is injected into the system prompt every turn. Use for frequently needed facts, user preferences, and anything that should always be in context. Keep entries concise — they consume context on every request.
- scratchpad: only titles are injected each turn; bodies are read on demand via the read action. Use for less frequent, longer-form knowledge such as reference material, detailed notes, or anything that doesn't need to be in context every turn. Note here anything you learn about the user. Keep titles short and descriptive (under 50 characters) so you can tell at a glance what each entry contains.

Actions:
- upsert: create or update an entry. Parameters: store (required), id (omit to create, provide to update), content (required for memory), title (required for scratchpad), body (required for scratchpad).
- delete: remove an entry by id. Parameters: store (required), id (required).
- read: read a scratchpad entry's title and body by id. Parameters: store (must be "scratchpad"), id (required).
- help: show this help text.

Constraints:
- Memory entries are injected in full every turn; keep them concise.
- Scratchpad bodies are not injected automatically; use the read action to retrieve them.`;

export function createManageKnowledgeTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_knowledge",
    label: "Manage knowledge",
    description: "Upsert or delete entries in the two-tier knowledge store (memory and scratchpad). Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upsert"),
        Type.Literal("delete"),
        Type.Literal("read"),
        Type.Literal("help"),
      ], { description: "Action to perform: upsert, delete, read, or help." }),
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

      if (action === "help") {
        return toolSuccess(MANAGE_KNOWLEDGE_HELP_TEXT);
      }

      if (action === "upsert") {
        if (store === undefined) {
          return toolError("Error: store is required for upsert.");
        }

        if (store === "memory") {
          if (raw.content === undefined || raw.content.trim() === "") {
            return toolError("Error: content is required when upserting a memory entry.");
          }
          const memoryResult = await upsertMemory(pool, raw.id, raw.content);
          if (raw.id !== undefined && memoryResult.rowCount === 0) {
            return toolError(`Error: memory ${raw.id} not found.`);
          }
          const message = raw.id === undefined ? `Memory ${memoryResult.id} created.` : `Memory ${memoryResult.id} updated.`;
          log.info(`[stavrobot] ${message}`);
          return toolSuccess(message);
        }

        if (store === "scratchpad") {
          if (raw.title === undefined || raw.title.trim() === "") {
            return toolError("Error: title is required when upserting a scratchpad entry.");
          }
          if (raw.body === undefined || raw.body.trim() === "") {
            return toolError("Error: body is required when upserting a scratchpad entry.");
          }
          const scratchpadResult = await upsertScratchpad(pool, raw.id, raw.title, raw.body);
          if (raw.id !== undefined && scratchpadResult.rowCount === 0) {
            return toolError(`Error: scratchpad entry ${raw.id} not found.`);
          }
          const message = raw.id === undefined ? `Scratchpad entry ${scratchpadResult.id} created.` : `Scratchpad entry ${scratchpadResult.id} updated.`;
          log.info(`[stavrobot] ${message}`);
          return toolSuccess(message);
        }

        return toolError(`Error: unknown store '${store}'. Valid stores: memory, scratchpad.`);
      }

      if (action === "delete") {
        if (store === undefined) {
          return toolError("Error: store is required for delete.");
        }

        if (raw.id === undefined) {
          return toolError("Error: id is required for delete.");
        }

        if (store === "memory") {
          const rowCount = await deleteMemory(pool, raw.id);
          if (rowCount === 0) {
            return toolError(`Error: memory ${raw.id} not found.`);
          }
          const message = `Memory ${raw.id} deleted.`;
          log.info(`[stavrobot] ${message}`);
          return toolSuccess(message);
        }

        if (store === "scratchpad") {
          const rowCount = await deleteScratchpad(pool, raw.id);
          if (rowCount === 0) {
            return toolError(`Error: scratchpad entry ${raw.id} not found.`);
          }
          const message = `Scratchpad entry ${raw.id} deleted.`;
          log.info(`[stavrobot] ${message}`);
          return toolSuccess(message);
        }

        return toolError(`Error: unknown store '${store}'. Valid stores: memory, scratchpad.`);
      }

      if (action === "read") {
        if (store !== "scratchpad") {
          return toolError("Error: read is only supported for the scratchpad store.");
        }

        if (raw.id === undefined) {
          return toolError("Error: id is required for read.");
        }

        const entry = await readScratchpad(pool, raw.id);
        if (entry === null) {
          return toolError(`Error: scratchpad entry ${raw.id} not found.`);
        }

        log.info(`[stavrobot] Scratchpad entry ${entry.id} read.`);
        const message = `Title: ${entry.title}\n\n${entry.body}`;
        return toolSuccess(message);
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: upsert, delete, read, help.`);
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
        return toolSuccess(MANAGE_CRON_HELP_TEXT);
      }

      if (action === "create") {
        if (raw.note === undefined || raw.note.trim() === "") {
          return toolError("Error: note is required for create.");
        }
        if (raw.schedule === undefined && raw.fire_at === undefined) {
          return toolError("Error: exactly one of schedule or fire_at must be provided.");
        }
        if (raw.schedule !== undefined && raw.fire_at !== undefined) {
          return toolError("Error: schedule and fire_at are mutually exclusive.");
        }
        const cronExpression = raw.schedule ?? null;
        const fireAt = raw.fire_at !== undefined ? new Date(raw.fire_at) : null;
        const entry = await createCronEntry(pool, cronExpression, fireAt, raw.note.trim());
        await reloadScheduler(pool);
        const message = `Cron entry ${entry.id} created.`;
        log.info(`[stavrobot] ${message}`);
        return toolSuccess(message);
      }

      if (action === "update") {
        if (raw.id === undefined) {
          return toolError("Error: id is required for update.");
        }
        if (raw.schedule !== undefined && raw.fire_at !== undefined) {
          return toolError("Error: schedule and fire_at are mutually exclusive.");
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
        log.info(`[stavrobot] ${message}`);
        return toolSuccess(message);
      }

      if (action === "delete") {
        if (raw.id === undefined) {
          return toolError("Error: id is required for delete.");
        }
        await deleteCronEntry(pool, raw.id);
        await reloadScheduler(pool);
        const message = `Cron entry ${raw.id} deleted.`;
        log.info(`[stavrobot] ${message}`);
        return toolSuccess(message);
      }

      if (action === "list") {
        const entries = await listCronEntries(pool);
        return toolSuccess(encodeToToon(entries));
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: create, update, delete, list, help.`);
    },
  };
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function wrapToolWithLogging(tool: AgentTool): AgentTool {
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const compactParams = truncate(JSON.stringify(params), 200);
      log.info(`[stavrobot] tool: ${tool.name}(${compactParams})`);
      const result = await originalExecute(toolCallId, params, signal, onUpdate);
      const textBlock = result.content.find((block): block is { type: "text"; text: string } => block.type === "text");
      const compactResult = truncate(textBlock !== undefined ? textBlock.text : "(no text content)", 200);
      log.info(`[stavrobot] tool: ${tool.name} -> ${compactResult}`);
      return result;
    },
  };
}

export async function createAgent(config: Config, pool: pg.Pool): Promise<Agent> {
  const model: Model<Api> = config.baseUrl !== undefined
    ? {
        id: config.model,
        name: config.model,
        api: config.api as Api,
        provider: config.provider,
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow!,
        maxTokens: config.maxTokens!,
      }
    : getModel(config.provider as any, config.model as any);
  const tools = [createExecuteSqlTool(pool), createManageKnowledgeTool(pool), createSendSignalMessageTool(pool, config), createManageCronTool(pool), createRunPythonTool(), createManagePagesTool(pool), createManageUploadsTool(), createSearchTool(pool, config.embeddings), createManageFilesTool(), createManageInterlocutorsTool(pool), createManageAgentsTool(pool), createSendAgentMessageTool(pool, () => currentAgentId)];
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
  if (config.email !== undefined && config.email.smtpHost !== undefined) {
    tools.push(createSendEmailTool(pool, config));
  }

  const effectiveBasePrompt = (config.customPrompt !== undefined
    ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
    : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

  const tokenBudget = Math.floor(model.contextWindow * 0.8);

  // Declare agent as Agent | undefined so the transformContext closure can
  // safely guard against the (theoretical) case where it fires before the
  // assignment completes. In practice the callback is only invoked during
  // agent.prompt(), which happens after createAgent returns, but the guard
  // makes the invariant explicit and prevents WeakMap.get(undefined) from
  // throwing if the timing assumption ever changes.
  let agentRef: Agent | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveBasePrompt,
      model,
      thinkingLevel: "off",
      tools: tools.map(wrapToolWithLogging),
      messages: [],
    },
    getApiKey: () => getApiKey(config),
    transformContext: async (messages) => {
      const truncated = truncateContext(messages, tokenBudget);
      const searchBlock = agentRef !== undefined ? pendingAutoSearchBlocks.get(agentRef) : undefined;
      return injectAutoSearchBlock(truncated, searchBlock);
    },
  });
  agentRef = agent;

  return agent;
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

export function formatUserMessage(userMessage: string, source?: string, sender?: string): string {
  const time = formatDate(new Date());
  const resolvedSource = source ?? "cli";
  const resolvedSender = sender ?? "unknown";
  return `Time: ${time}\nSource: ${resolvedSource}\nSender: ${resolvedSender}\nText: ${userMessage}`;
}

function buildMainAgentSystemPrompt(config: Config, allPlugins: PluginEntry[] | undefined, memories: Memory[], scratchpadTitles: { id: number; title: string }[]): string {
  const effectiveBasePrompt = (config.customPrompt !== undefined
    ? `${config.baseSystemPrompt}\n\n${config.customPrompt}`
    : config.baseSystemPrompt) + buildPromptSuffix(config.publicHostname);

  const visiblePlugins = allPlugins !== undefined && allPlugins.length > 0 ? allPlugins : undefined;
  const pluginListSection = visiblePlugins !== undefined ? formatPluginListSection(visiblePlugins) : undefined;
  log.debug(`[stavrobot] fetchPluginList: injecting ${visiblePlugins?.length ?? 0} plugin(s) into system prompt`);

  const promptWithPlugins = pluginListSection !== undefined
    ? `${effectiveBasePrompt}\n\n${pluginListSection}`
    : effectiveBasePrompt;

  let systemPrompt = promptWithPlugins;

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
    const scratchpadLines = ["Your scratchpad (use manage_knowledge with store: \"scratchpad\" to upsert, delete, or read entries; use the read action to retrieve a body by id):", ""];
    for (const entry of scratchpadTitles) {
      scratchpadLines.push(`[Scratchpad ${entry.id}] ${entry.title}`);
    }
    log.debug(`[stavrobot] Injecting ${scratchpadTitles.length} scratchpad title(s) into system prompt`);
    systemPrompt = `${systemPrompt}\n\n${scratchpadLines.join("\n")}`;
  }

  return systemPrompt;
}

async function buildSubagentSystemPrompt(config: Config, subagentRow: AgentRow | null, allPlugins: PluginEntry[] | undefined): Promise<string> {
  const agentSystemPrompt = subagentRow?.systemPrompt ?? "";
  const subagentAllowedPlugins = subagentRow?.allowedPlugins ?? [];

  const basePrompt = config.baseAgentPrompt.replace("{{main_agent_id}}", String(getMainAgentId())) + buildPromptSuffix(config.publicHostname);

  // Only inject the plugin list if the agent has plugin access. Injecting it
  // for agents with no plugin access would be noise.
  let pluginListSection: string | undefined;
  if (subagentAllowedPlugins.length > 0 && allPlugins !== undefined && allPlugins.length > 0) {
    let pluginsToShow: PluginEntry[];
    let accessMap: Map<string, Set<string> | "*">;
    if (subagentAllowedPlugins.includes("*")) {
      pluginsToShow = allPlugins;
      // Wildcard access: all tools in every plugin are visible.
      accessMap = new Map(allPlugins.map((plugin) => [plugin.name, "*"]));
    } else {
      accessMap = buildPluginAccessMap(subagentAllowedPlugins);
      // Filter to only the plugins the agent has access to. A dotted entry
      // like "weather.get_forecast" still grants access to the "weather" plugin
      // listing, so we extract the plugin name from both bare and dotted entries.
      const accessiblePluginNames = new Set(accessMap.keys());
      pluginsToShow = allPlugins.filter((plugin) => accessiblePluginNames.has(plugin.name));
    }
    if (pluginsToShow.length > 0) {
      const pluginNames = pluginsToShow.map((plugin) => plugin.name);
      const toolDetails = await fetchPluginDetails(pluginNames, accessMap);
      pluginListSection = formatPluginListSection(pluginsToShow, toolDetails);
      log.debug(`[stavrobot] fetchPluginList: injecting ${pluginsToShow.length} plugin(s) into subagent system prompt`);
    }
  }

  const promptWithPlugins = pluginListSection !== undefined
    ? `${basePrompt}\n\n${pluginListSection}`
    : basePrompt;

  return agentSystemPrompt.trim() !== ""
    ? `${promptWithPlugins}\n\n${agentSystemPrompt}`
    : promptWithPlugins;
}

async function processAttachments(attachments: FileAttachment[]): Promise<{ resolvedMessage: string | undefined; imageContents: ImageContent[] }> {
  let resolvedMessage: string | undefined;
  const imageContents: ImageContent[] = [];

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

  return { resolvedMessage, imageContents };
}

function triggerCompactionIfNeeded(agent: Agent, pool: pg.Pool, agentId: number, config: Config): void {
  if (estimateTokens(agent.state.messages) <= config.compactionTokenThreshold || compactionInProgress) {
    return;
  }

  compactionInProgress = true;
  // Snapshot the messages now so the background task works on a stable slice
  // and never touches agent.state.messages directly.
  const currentMessages = agent.state.messages.slice();

  log.debug(`[stavrobot] [debug] Compaction triggered: ${currentMessages.length} messages, ~${Math.round(estimateTokens(currentMessages))} estimated tokens`);

  void (async () => {
    try {
      const cutIndexOrNull = selectCompactionCutIndex(currentMessages, config.compactionTokenThreshold);
      if (cutIndexOrNull === null) {
        log.warn("[stavrobot] Compaction skipped: no safe cut point found (no user messages or all messages fit within the keep budget).");
        return;
      }
      const cutIndex = cutIndexOrNull;

      const messagesToCompact = currentMessages.slice(0, cutIndex);
      const messagesToKeep = currentMessages.slice(cutIndex);

      log.debug(`[stavrobot] [debug] Cut point: index=${cutIndex}, compacting=${messagesToCompact.length}, keeping=${messagesToKeep.length}`);
      log.debug(`[stavrobot] [debug] Last compacted message: role=${messagesToCompact[messagesToCompact.length - 1].role}`);
      log.debug(`[stavrobot] [debug] First kept message: role=${messagesToKeep[0].role}`);

      const serializedMessages = serializeMessagesForSummary(messagesToCompact);

      log.debug(`[stavrobot] [debug] Serialized input for summarizer (${serializedMessages.length} chars): ${serializedMessages.split("\n")[0]}`);

      // Capture the maximum message id in the DB before summarization starts.
      // Summarization can take several seconds, during which new messages may
      // be inserted. Without this anchor, the OFFSET-based boundary query
      // below could land on a message that was never part of the snapshot,
      // setting upToMessageId past unsummarized messages.
      const maxIdResult = await pool.query<{ max_id: number }>(
        "SELECT MAX(id) as max_id FROM messages WHERE agent_id = $1",
        [agentId],
      );
      const snapshotMaxId = maxIdResult.rows[0].max_id;

      const apiKey = await getApiKey(config);
      const summaryText = await escalatingSummarize(serializedMessages, config, agent.state.model, apiKey);

      const previousCompaction = await loadLatestCompaction(pool, agentId);
      const previousBoundary = previousCompaction ? previousCompaction.upToMessageId : 0;

      // The boundary must be the last compacted message id. loadMessages keeps
      // rows with id > upToMessageId, so using keepCount (not keepCount - 1)
      // preserves exactly messagesToKeep. The query is scoped to this agent
      // and bounded by snapshotMaxId so the OFFSET only counts messages that
      // existed when compaction started, not any inserted during summarization.
      const keepCount = messagesToKeep.length;
      const cutoffResult = await pool.query(
        `SELECT id FROM messages WHERE agent_id = $1 AND id > $2 AND id <= $3 ORDER BY id DESC LIMIT 1 OFFSET ${keepCount}`,
        [agentId, previousBoundary, snapshotMaxId],
      );
      if (cutoffResult.rows.length === 0) {
        log.warn("[stavrobot] Compaction skipped: no cutoff message found for computed boundary.");
        return;
      }
      const upToMessageId = cutoffResult.rows[0].id as number;

      log.debug(`[stavrobot] [debug] Boundary: previousBoundary=${previousBoundary}, keepCount=${keepCount}, upToMessageId=${upToMessageId}`);

      await saveCompaction(pool, summaryText, upToMessageId, agentId);
      log.info(`[stavrobot] Background compaction complete: compacted ${messagesToCompact.length} messages, kept ${messagesToKeep.length}.`);
      compactionCompletedForAgent = agentId;
    } catch (error) {
      log.error("[stavrobot] Background compaction failed:", error instanceof Error ? error.message : String(error));
    } finally {
      compactionInProgress = false;
    }
  })();
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string | undefined,
  config: Config,
  routing: RoutingResult,
  source?: string,
  attachments?: FileAttachment[]
): Promise<string> {
  pendingAutoSearchBlocks.delete(agent);

  const { agentId, senderIdentityId, senderAgentId, senderLabel, isMainAgent } = routing;

  // Track the current agent ID so the send_agent_message tool can identify the
  // sender. The queue is single-threaded so this is safe without locking.
  setCurrentAgentId(agentId);

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
    log.debug(`[stavrobot] Cleared compaction-completed flag for agent ${agentId}.`);
    log.debug(`[stavrobot] [debug] Reloaded ${conversationMessages.length} messages`);
  }

  agent.replaceMessages(conversationMessages);
  log.debug(`[stavrobot] Loaded ${conversationMessages.length} messages for agent ${agentId}.`);

  const allPlugins = await fetchPluginList();

  // Load the subagent's DB row once here so it can be used for both system
  // prompt assembly and tool filtering without a second DB round-trip.
  const subagentRow = isMainAgent ? null : await loadAgent(pool, agentId);

  let systemPrompt: string;

  if (isMainAgent) {
    const memories = await loadAllMemories(pool);
    const scratchpadTitles = await loadAllScratchpadTitles(pool);
    systemPrompt = buildMainAgentSystemPrompt(config, allPlugins, memories, scratchpadTitles);
  } else {
    systemPrompt = await buildSubagentSystemPrompt(config, subagentRow, allPlugins);
  }

  agent.setSystemPrompt(systemPrompt);

  let saveChain: Promise<unknown> = Promise.resolve();

  let resolvedMessage = userMessage;

  let imageContents: ImageContent[] = [];

  if (attachments !== undefined && attachments.length > 0) {
    const processed = await processAttachments(attachments);
    resolvedMessage = processed.resolvedMessage !== undefined
      ? (resolvedMessage !== undefined ? `${resolvedMessage}\n\n${processed.resolvedMessage}` : processed.resolvedMessage)
      : resolvedMessage;
    imageContents = processed.imageContents;
  }

  let autoSearchEmbedding: number[] | undefined;

  if (
    isMainAgent &&
    source !== undefined &&
    AUTO_SEARCH_SOURCES.includes(source) &&
    resolvedMessage !== undefined &&
    resolvedMessage.length >= AUTO_SEARCH_MIN_LENGTH
  ) {
    const searchStart = Date.now();
    try {
      const searchResults = await runSearch(pool, resolvedMessage, AUTO_SEARCH_LIMIT, getMainAgentId(), config.embeddings);
      const searchDuration = Date.now() - searchStart;
      log.debug(`[stavrobot] auto-search completed in ${searchDuration}ms (${searchResults.tableResults.length} table results, ${searchResults.messages.length} messages)`);

      autoSearchEmbedding = searchResults.queryEmbedding;

      const hasResults = searchResults.tableResults.length > 0 || searchResults.messages.length > 0;
      if (hasResults) {
        pendingAutoSearchBlocks.set(agent, buildAutoSearchBlock(searchResults, resolvedMessage));
      }
    } catch (error) {
      log.warn("[stavrobot] auto-search failed, continuing without results:", error instanceof Error ? error.message : String(error));
    }
  }

  // The try/finally starts here — after the auto-search block may have been
  // set — so that pendingAutoSearchBlocks.delete(agent) runs on every exit
  // path, including exceptions thrown by getApiKey, setTools, or subscribe
  // before agent.prompt is reached.
  try {
    const messageToSend = formatUserMessage(resolvedMessage ?? "", source, senderLabel);

    // Filter tools for subagents based on their allowed_tools list. The main
    // agent always gets the full tool set. For subagents, we temporarily swap
    // the tool list before the prompt and restore it after. The Agent class
    // provides a public setTools() method for this purpose.
    const fullTools = agent.state.tools;
    if (!isMainAgent) {
      const allowedTools = subagentRow?.allowedTools ?? [];
      const allowedPlugins = subagentRow?.allowedPlugins ?? [];
      // A wildcard means all tools are allowed (should only be the main agent in practice).
      if (!allowedTools.includes("*")) {
        const filteredTools = filterToolsForSubagent(fullTools, allowedTools, allowedPlugins);
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
            saveChain = saveChain.then(async () => {
              const messageId = await saveMessage(pool, message, agentId, senderIdentityId, senderAgentId);
              if (autoSearchEmbedding !== undefined) {
                const vectorLiteral = `[${autoSearchEmbedding.join(",")}]`;
                await pool.query(
                  "INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                  [messageId, vectorLiteral],
                );
                log.debug(`[stavrobot] auto-search embedding stored for message ${messageId}`);
              }
            });
          } else {
            saveChain = saveChain.then(() => saveMessage(pool, message, agentId));
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
      await saveChain;
    }
  } finally {
    pendingAutoSearchBlocks.delete(agent);
  }

  if (agent.state.error) {
    const errorJson = JSON.stringify(agent.state.error);
    // Check if the error was caused by an intentional abort by looking at the
    // last assistant message's stopReason. agent.state.error is a plain string
    // (the error message), not the message object, so we must inspect the
    // conversation history instead.
    const wasAborted = agent.state.messages.some((message) => {
      if (message.role !== "assistant") return false;
      const assistantMessage = message as unknown as AssistantMessage;
      return assistantMessage.stopReason === "aborted";
    });
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
    if (wasAborted) {
      log.info("[stavrobot] Agent aborted.");
      const cancellationMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "[The user cancelled the previous request with /stop.]" }],
        timestamp: Date.now(),
      };
      agent.appendMessage(cancellationMessage);
      await saveMessage(pool, cancellationMessage, agentId);
      throw new AbortError();
    }
    log.error("[stavrobot] Agent error:", errorJson);
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

  triggerCompactionIfNeeded(agent, pool, agentId, config);

  return responseText;
}
