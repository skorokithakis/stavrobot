import { complete, type TextContent, type ImageContent, type ThinkingContent, type ToolCall } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "../config.js";
import type { SearchResults } from "../search.js";
import { extractText } from "../embeddings.js";
import { log } from "../log.js";

export function buildPromptSuffix(publicHostname: string): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? "UTC";
  return `\n\nYour external hostname is ${publicHostname}. All times are in ${timezone}. Do not convert times to other timezones unless explicitly asked, or the user is in another timezone.`;
}

export const AUTO_SEARCH_MIN_LENGTH = 10;
export const AUTO_SEARCH_LIMIT = 5;
export const AUTO_SEARCH_SNIPPET_LENGTH = 200;
export const AUTO_SEARCH_SOURCES = ["signal", "telegram", "whatsapp", "email"];

function buildKeywordSnippet(text: string, query: string): string {
  const words = query.split(/\s+/).filter((word) => word.length > 2);
  const lowerText = text.toLowerCase();

  let anchorPosition = -1;
  for (const word of words) {
    const position = lowerText.indexOf(word.toLowerCase());
    if (position !== -1) {
      anchorPosition = position;
      break;
    }
  }

  const start = anchorPosition === -1
    ? 0
    : Math.max(0, anchorPosition - Math.floor(AUTO_SEARCH_SNIPPET_LENGTH / 2));
  const end = Math.min(text.length, start + AUTO_SEARCH_SNIPPET_LENGTH);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function buildAutoSearchBlock(results: SearchResults, query: string): string {
  const parts: string[] = ["[Auto-search results for context — do not mention these to the user unless relevant]"];

  for (const tableResult of results.tableResults) {
    parts.push("");
    parts.push(`Table: ${tableResult.tableName} (${tableResult.matchCount} match(es))`);
    for (const row of tableResult.rows) {
      const rowText = Object.values(row)
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      parts.push(`- ${buildKeywordSnippet(rowText, query)}`);
    }
  }

  if (results.messages.length > 0) {
    parts.push("");
    parts.push(`Messages (${results.messages.length} match(es)):`);
    for (const message of results.messages) {
      const timestamp = message.created_at.toISOString();
      const rawContent = (message.content as { content?: unknown }).content ?? message.content;
      const text = extractText(rawContent);
      const snippet = buildKeywordSnippet(text, query);
      parts.push(`- [${timestamp}] ${message.role}: ${snippet}`);
    }
  }

  return parts.join("\n");
}

// Holds the auto-search block for the current turn, keyed by Agent instance.
// Using a WeakMap ensures each Agent's pending block is isolated from others,
// and entries are garbage-collected when the Agent is no longer referenced.
// Exported for testing only.
export const pendingAutoSearchBlocks = new WeakMap<Agent, string | undefined>();

// Conservative estimate: structured data and non-English text tokenize at
// closer to 3 chars/token rather than the 4 chars/token typical of English prose.
export const CHARS_PER_TOKEN = 3;

// Images use a fixed 1000-token estimate because actual cost depends on
// resolution, which we don't have at this point.
function estimateBlockTokens(block: TextContent | ImageContent | ThinkingContent | ToolCall): number {
  if (block.type === "text") {
    return block.text.length / CHARS_PER_TOKEN;
  }
  if (block.type === "image") {
    return 1000;
  }
  if (block.type === "thinking") {
    return block.thinking.length / CHARS_PER_TOKEN;
  }
  return JSON.stringify(block.arguments).length / CHARS_PER_TOKEN;
}

export function estimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        total += message.content.length / CHARS_PER_TOKEN;
      } else {
        for (const block of message.content) {
          total += estimateBlockTokens(block);
        }
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        total += estimateBlockTokens(block);
      }
    } else if (message.role === "toolResult") {
      for (const block of message.content) {
        total += estimateBlockTokens(block);
      }
    }
  }
  return total;
}

// Returns true if messages[index] is a user message at a turn boundary — i.e.,
// a safe place to cut the conversation history. A user message is a turn
// boundary when:
//   - It is the first message (index 0), OR
//   - The previous message is also a user message (consecutive user messages), OR
//   - The previous message is an assistant message with no toolCall blocks.
//
// Steering injects user messages mid-turn (between an assistant toolCall and its
// toolResult). Cutting there would orphan the toolResult and cause a 400 from the
// Anthropic API. Those injected messages are NOT turn boundaries.
export function isTurnBoundary(messages: AgentMessage[], index: number): boolean {
  if (messages[index].role !== "user") {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const previous = messages[index - 1];
  if (previous.role === "user") {
    return true;
  }
  if (previous.role === "assistant") {
    const hasToolCall = (previous.content as Array<{ type: string }>).some((block) => block.type === "toolCall");
    return !hasToolCall;
  }
  // Previous message is a toolResult — we are mid-turn.
  return false;
}

// Fraction of effective context used as the pre-send truncation budget.
export const TRUNCATION_BUDGET_FRACTION = 0.8;
// Fraction of effective context at which compaction is triggered.
export const COMPACTION_THRESHOLD_FRACTION = 0.6;
// Fraction of the compaction threshold to keep after compaction.
export const COMPACTION_KEEP_FRACTION = 0.5;

// Selects the index of the first message to keep after compaction, or null if
// no safe cut point exists. The cut always lands on a turn-boundary user message
// so the compacted slice never ends mid-tool-use/tool-result pair.
//
// The algorithm walks backward from the end of messages accumulating tokens
// until the keep budget (50% of threshold) is exceeded, then advances forward
// to the next turn-boundary user message. If no such message exists forward of
// the cut, it falls back to scanning backward for the nearest earlier one. If
// there are no turn-boundary user messages at all, null is returned and
// compaction is skipped.
export function selectCompactionCutIndex(messages: AgentMessage[], compactionTokenThreshold: number): number | null {
  const keepTokenBudget = compactionTokenThreshold * COMPACTION_KEEP_FRACTION;
  let accumulatedTokens = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokens([messages[i]]);
    if (accumulatedTokens + messageTokens > keepTokenBudget) {
      cutIndex = i + 1;
      break;
    }
    accumulatedTokens += messageTokens;
    cutIndex = i;
  }

  if (cutIndex === 0) {
    return null;
  }

  // Advance forward to the next turn-boundary user message.
  while (cutIndex < messages.length && !isTurnBoundary(messages, cutIndex)) {
    cutIndex++;
  }

  if (cutIndex < messages.length) {
    return cutIndex;
  }

  // No turn-boundary user message found forward — scan backward to find the
  // nearest earlier one. This compacts less of the history (keeps more) but
  // still makes progress.
  let backwardIndex = cutIndex - 1;
  while (backwardIndex >= 0 && !isTurnBoundary(messages, backwardIndex)) {
    backwardIndex--;
  }
  if (backwardIndex <= 0) {
    return null;
  }
  log.info(`[stavrobot] Forward scan found no user message, fell back to backward scan (cutIndex=${backwardIndex}).`);
  return backwardIndex;
}

// Messages and blocks are copied only when modified to avoid mutating the
// caller's data.
export function truncateContext(messages: AgentMessage[], tokenBudget: number): AgentMessage[] {
  if (estimateTokens(messages) <= tokenBudget) {
    return messages;
  }

  type TextBlockRef = {
    messageIndex: number;
    blockIndex: number;
    // For user messages with string content, blockIndex is -1.
    isStringContent: boolean;
    charCount: number;
  };

  const textBlocks: TextBlockRef[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role === "user") {
      if (typeof message.content === "string") {
        textBlocks.push({ messageIndex, blockIndex: -1, isStringContent: true, charCount: message.content.length });
      } else {
        for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
          const block = message.content[blockIndex];
          if (block.type === "text") {
            textBlocks.push({ messageIndex, blockIndex, isStringContent: false, charCount: block.text.length });
          }
        }
      }
    } else if (message.role === "assistant") {
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        if (block.type === "text") {
          textBlocks.push({ messageIndex, blockIndex, isStringContent: false, charCount: block.text.length });
        }
      }
    } else if (message.role === "toolResult") {
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        if (block.type === "text") {
          textBlocks.push({ messageIndex, blockIndex, isStringContent: false, charCount: block.text.length });
        }
      }
    }
  }

  // Largest blocks first: trimming them is most likely to bring us under budget
  // in a single pass, reducing the number of blocks we need to touch.
  textBlocks.sort((a, b) => b.charCount - a.charCount);

  const result: AgentMessage[] = [...messages];
  let currentTokens = estimateTokens(messages);

  for (const ref of textBlocks) {
    if (currentTokens <= tokenBudget) {
      break;
    }

    const excess = currentTokens - tokenBudget;
    const truncationSuffix = "\n[truncated]";
    const charsToRemove = Math.ceil(excess * CHARS_PER_TOKEN) + truncationSuffix.length;
    const newCharCount = Math.max(0, ref.charCount - charsToRemove);

    // Skip blocks where the suffix alone would make the result longer than the
    // original, which would increase token usage instead of reducing it.
    if (newCharCount + truncationSuffix.length >= ref.charCount) {
      continue;
    }

    const message = result[ref.messageIndex];

    if (ref.isStringContent && message.role === "user") {
      const newText = (message.content as string).slice(0, newCharCount) + truncationSuffix;
      result[ref.messageIndex] = { ...message, content: newText };
      currentTokens -= (ref.charCount - newText.length) / CHARS_PER_TOKEN;
    } else if (!ref.isStringContent) {
      let contentArray: (TextContent | ImageContent | ThinkingContent | ToolCall)[];
      if (result[ref.messageIndex] === messages[ref.messageIndex]) {
        if (message.role === "user" && Array.isArray(message.content)) {
          contentArray = [...message.content];
          result[ref.messageIndex] = { ...message, content: contentArray } as AgentMessage;
        } else if (message.role === "assistant") {
          contentArray = [...message.content];
          result[ref.messageIndex] = { ...message, content: contentArray } as AgentMessage;
        } else if (message.role === "toolResult") {
          contentArray = [...message.content];
          result[ref.messageIndex] = { ...message, content: contentArray } as AgentMessage;
        } else {
          continue;
        }
      } else {
        const alreadyCopied = result[ref.messageIndex];
        if (alreadyCopied.role === "user" && Array.isArray(alreadyCopied.content)) {
          contentArray = alreadyCopied.content as (TextContent | ImageContent)[];
        } else if (alreadyCopied.role === "assistant") {
          contentArray = alreadyCopied.content;
        } else if (alreadyCopied.role === "toolResult") {
          contentArray = alreadyCopied.content;
        } else {
          continue;
        }
      }

      const block = contentArray[ref.blockIndex] as TextContent;
      const newText = block.text.slice(0, newCharCount) + truncationSuffix;
      contentArray[ref.blockIndex] = { ...block, text: newText };
      currentTokens -= (ref.charCount - newText.length) / CHARS_PER_TOKEN;
    }
  }

  log.info(`[stavrobot] truncateContext: reduced estimated tokens from ${Math.round(estimateTokens(messages))} to ${Math.round(estimateTokens(result))} (budget: ${tokenBudget})`);

  return result;
}

// Injects the auto-search block ephemerally into the last user message in the
// context. Returns the messages array unchanged if there is no block or no user
// message. Does not mutate the original message objects.
export function injectAutoSearchBlock(messages: AgentMessage[], searchBlock: string | undefined): AgentMessage[] {
  if (searchBlock === undefined) {
    return messages;
  }

  const lastUserIndex = messages.reduce(
    (found, message, index) => (message.role === "user" ? index : found),
    -1,
  );

  if (lastUserIndex === -1) {
    return messages;
  }

  const lastUserMessage = messages[lastUserIndex];

  // Narrow to UserMessage: only user messages have string | array content.
  if (lastUserMessage.role !== "user") {
    return messages;
  }

  let updatedMessage: AgentMessage;

  if (typeof lastUserMessage.content === "string") {
    updatedMessage = { ...lastUserMessage, content: `${lastUserMessage.content}\n\n${searchBlock}` };
  } else {
    // Array content: find the last text block and append to it, or add a new one.
    const contentArray = [...lastUserMessage.content];
    const lastTextIndex = contentArray.reduce(
      (found, block, index) => (block.type === "text" ? index : found),
      -1,
    );

    if (lastTextIndex !== -1) {
      const textBlock = contentArray[lastTextIndex] as TextContent;
      contentArray[lastTextIndex] = { ...textBlock, text: `${textBlock.text}\n\n${searchBlock}` };
    } else {
      contentArray.push({ type: "text", text: searchBlock });
    }

    updatedMessage = { ...lastUserMessage, content: contentArray };
  }

  const result = [...messages];
  result[lastUserIndex] = updatedMessage;
  return result;
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

export async function escalatingSummarize(
  inputText: string,
  config: Config,
  model: Model<Api>,
  apiKey: string,
): Promise<string> {
  const inputLength = inputText.length;

  // Level 1: use the existing compaction prompt.
  const level1Response = await complete(
    model,
    {
      systemPrompt: config.compactionPrompt,
      messages: [
        {
          role: "user" as const,
          content: [
            "Summarize the conversation inside <conversation> tags according to your system instructions.",
            "",
            "<conversation>",
            inputText,
            "</conversation>",
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, temperature: 0.1 },
  );

  const level1Text = level1Response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (level1Text.length < inputLength) {
    return level1Text;
  }

  // Level 2: bullet-point prompt targeting half the input's estimated token count.
  const targetTokens = Math.round(inputLength / 3 / 2);
  log.info(`[stavrobot] Compaction level 1 failed (summary ${level1Text.length} chars >= input ${inputLength} chars), attempting level 2 bullet-point summary (target: ${targetTokens} tokens).`);

  const bulletPrompt = config.compactionBulletPrompt.replace("{target}", String(targetTokens));

  const level2Response = await complete(
    model,
    {
      systemPrompt: bulletPrompt,
      messages: [
        {
          role: "user" as const,
          content: [
            "Summarize the conversation inside <conversation> tags according to your system instructions.",
            "",
            "<conversation>",
            inputText,
            "</conversation>",
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, temperature: 0.1 },
  );

  const level2Text = level2Response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (level2Text.length < inputLength) {
    return level2Text;
  }

  // Level 3: deterministic truncation — no LLM call.
  log.info(`[stavrobot] Compaction level 2 failed (summary ${level2Text.length} chars >= input ${inputLength} chars), falling back to level 3 truncation.`);

  const suffix = "\n[truncated due to compaction failure]";
  // Guarantee the result is strictly shorter than the input. If the input is
  // shorter than the suffix itself (an extreme edge case that should never
  // occur in practice), just return the suffix — the input was tiny and
  // shouldn't have triggered compaction.
  const truncateLength = Math.max(0, inputLength - suffix.length - 1);
  return inputText.slice(0, truncateLength) + suffix;
}
