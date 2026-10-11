import { Marked, type RendererObject, type Tokens } from "marked";
import type { TelegramConfig } from "./config.js";
import { isInAllowlist, recordRejectedSender } from "./allowlist.js";
import { enqueueMessage, type Participant } from "./queue.js";
import { saveAttachment, type FileAttachment } from "./uploads.js";
import { log } from "./log.js";

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  chat: { id: number; type: string; title?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  voice?: TelegramVoice;
  audio?: TelegramVoice;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

interface GetUpdatesResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  result?: TelegramUpdate[];
}

interface GetFileResponse {
  ok: boolean;
  result: { file_path: string };
}

// Escapes characters that have special meaning in Telegram's HTML parse mode.
function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const telegramRenderer: RendererObject = {
  strong({ tokens }: Tokens.Strong): string {
    const inner = this.parser.parseInline(tokens);
    return `<b>${inner}</b>`;
  },

  em({ tokens }: Tokens.Em): string {
    const inner = this.parser.parseInline(tokens);
    return `<i>${inner}</i>`;
  },

  del({ tokens }: Tokens.Del): string {
    const inner = this.parser.parseInline(tokens);
    return `<s>${inner}</s>`;
  },

  codespan({ text }: Tokens.Codespan): string {
    return `<code>${escapeTelegramHtml(text)}</code>`;
  },

  code({ text, lang }: Tokens.Code): string {
    const langAttr = lang !== undefined && lang !== "" ? ` class="language-${escapeTelegramHtml(lang)}"` : "";
    return `<pre><code${langAttr}>${escapeTelegramHtml(text)}</code></pre>\n`;
  },

  link({ href, tokens }: Tokens.Link): string {
    const inner = this.parser.parseInline(tokens);
    return `<a href="${escapeTelegramHtml(href)}">${inner}</a>`;
  },

  // Telegram has no heading tags; render as bold text followed by a newline.
  heading({ tokens }: Tokens.Heading): string {
    const inner = this.parser.parseInline(tokens);
    return `<b>${inner}</b>\n`;
  },

  blockquote({ tokens }: Tokens.Blockquote): string {
    const inner = this.parser.parse(tokens);
    return `<blockquote>${inner}</blockquote>\n`;
  },

  // Telegram has no list tags; render as plain text with bullet/number characters.
  list(token: Tokens.List): string {
    const lines: string[] = [];
    for (let index = 0; index < token.items.length; index++) {
      const item = token.items[index];
      const prefix = token.ordered ? `${(typeof token.start === "number" ? token.start : 1) + index}.` : "•";
      const inner = this.parser.parse(item.tokens).trim();
      lines.push(`${prefix} ${inner}`);
    }
    return lines.join("\n") + "\n";
  },

  listitem(item: Tokens.ListItem): string {
    return this.parser.parse(item.tokens);
  },

  paragraph({ tokens }: Tokens.Paragraph): string {
    const inner = this.parser.parseInline(tokens);
    return `${inner}\n\n`;
  },

  // Strip unsupported HTML tags from raw HTML blocks.
  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeTelegramHtml(text);
  },

  // Horizontal rules have no Telegram equivalent; render as a blank line.
  hr(): string {
    return "\n";
  },

  // Images have no Telegram equivalent; render as the alt text.
  image({ text }: Tokens.Image): string {
    return escapeTelegramHtml(text);
  },

  br(): string {
    return "\n";
  },
};

const telegramMarked = new Marked({ renderer: telegramRenderer });

export async function convertMarkdownToTelegramHtml(markdown: string): Promise<string> {
  const result = await telegramMarked.parse(markdown, { async: true });
  // Trim trailing whitespace that accumulates from paragraph double-newlines.
  return result.trim();
}

// Returns the number of UTF-16 code units for a single Unicode code point.
function utf16Length(codePoint: number): number {
  return codePoint >= 0x10000 ? 2 : 1;
}

export function applyTelegramEntitiesToMarkdown(text: string, entities: TelegramEntity[] | undefined): string {
  if (entities === undefined || entities.length === 0) {
    return text;
  }

  // Each event is (utf16Position, isClose, markerString).
  // isClose is used as a sort key so that close markers sort before open markers
  // at the same position, preventing adjacent spans from bleeding into each other.
  const events: Array<[number, boolean, string]> = [];

  for (const entity of entities) {
    const end = entity.offset + entity.length;
    let openMarker: string;
    let closeMarker: string;

    switch (entity.type) {
      case "bold":
        openMarker = "**";
        closeMarker = "**";
        break;
      case "italic":
        openMarker = "_";
        closeMarker = "_";
        break;
      case "strikethrough":
        openMarker = "~~";
        closeMarker = "~~";
        break;
      case "code":
        openMarker = "`";
        closeMarker = "`";
        break;
      case "pre": {
        const lang = entity.language !== undefined && entity.language !== "" ? entity.language : "";
        openMarker = `\`\`\`${lang}\n`;
        closeMarker = "\n```";
        break;
      }
      case "text_link":
        if (entity.url === undefined) {
          continue;
        }
        openMarker = "[";
        closeMarker = `](${entity.url})`;
        break;
      case "spoiler":
        openMarker = "<spoiler>";
        closeMarker = "</spoiler>";
        break;
      default:
        // All other entity types (mention, hashtag, url, etc.) are ignored.
        continue;
    }

    events.push([entity.offset, false, openMarker]);
    events.push([end, true, closeMarker]);
  }

  if (events.length === 0) {
    return text;
  }

  // Sort by position; at the same position, close markers (true) come before
  // open markers (false) so that adjacent annotations do not bleed into each other.
  events.sort(([positionA, isCloseA], [positionB, isCloseB]) => {
    if (positionA !== positionB) {
      return positionA - positionB;
    }
    // Close (true=1) before open (false=0): sort descending on the boolean value.
    return (isCloseB ? 1 : 0) - (isCloseA ? 1 : 0);
  });

  // Walk the text once, advancing by UTF-16 code units to match Telegram's offsets.
  const totalUtf16 = [...text].reduce((sum, char) => sum + utf16Length(char.codePointAt(0) ?? 0), 0);
  const resultParts: string[] = [];
  let previousPythonIndex = 0;
  let previousUtf16Offset = 0;

  for (const [utf16Position, , marker] of events) {
    const clampedPosition = Math.max(0, Math.min(utf16Position, totalUtf16));
    const delta = clampedPosition - previousUtf16Offset;

    let pythonIndex = previousPythonIndex;
    let unitsWalked = 0;
    while (unitsWalked < delta && pythonIndex < text.length) {
      const codePoint = text.codePointAt(pythonIndex) ?? 0;
      unitsWalked += utf16Length(codePoint);
      // Advance by 2 for surrogate pairs (code points >= U+10000), 1 otherwise.
      pythonIndex += codePoint >= 0x10000 ? 2 : 1;
    }

    resultParts.push(text.slice(previousPythonIndex, pythonIndex));
    resultParts.push(marker);
    previousPythonIndex = pythonIndex;
    previousUtf16Offset = clampedPosition;
  }

  resultParts.push(text.slice(previousPythonIndex));
  return resultParts.join("");
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return typeof value === "object" && value !== null;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "chat" in value &&
    typeof (value as Record<string, unknown>).chat === "object" &&
    (value as Record<string, unknown>).chat !== null &&
    "id" in ((value as Record<string, unknown>).chat as object) &&
    typeof ((value as Record<string, { id: unknown }>).chat).id === "number"
  );
}

const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
// Abort slightly above the long-poll timeout so a half-open connection cannot hang the loop forever.
const TELEGRAM_POLL_ABORT_MILLISECONDS = 40000;
const TELEGRAM_POLL_ERROR_RETRY_MILLISECONDS = 5000;

type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;
type SleepFunction = (milliseconds: number) => Promise<void>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function deleteTelegramWebhook(config: TelegramConfig, fetchFunction: FetchFunction): Promise<void> {
  log.info("[stavrobot] Deleting Telegram webhook to enable long polling.");

  const response = await fetchFunction(
    `https://api.telegram.org/bot${config.botToken}/deleteWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: false }),
    }
  );

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    throw new Error(`Failed to delete Telegram webhook: ${result.description ?? "unknown error"}`);
  }

  log.info("[stavrobot] Telegram webhook deleted; starting long polling.");
}

// Deletes any webhook, then runs the getUpdates loop in the background forever.
export async function startTelegramPolling(
  config: TelegramConfig,
  fetchFunction: FetchFunction = fetch,
  sleepFunction: SleepFunction = sleep
): Promise<void> {
  await deleteTelegramWebhook(config, fetchFunction);
  void runTelegramPollingLoop(config, fetchFunction, sleepFunction);
}

// Long-polls getUpdates and hands each update to the handler, advancing the offset past
// the last update seen. Errors are logged and retried forever; the loop never exits.
export async function runTelegramPollingLoop(
  config: TelegramConfig,
  fetchFunction: FetchFunction = fetch,
  sleepFunction: SleepFunction = sleep
): Promise<void> {
  let offset: number | undefined;

  for (;;) {
    try {
      const response = await fetchFunction(
        `https://api.telegram.org/bot${config.botToken}/getUpdates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message"],
            ...(offset !== undefined ? { offset } : {}),
          }),
          signal: AbortSignal.timeout(TELEGRAM_POLL_ABORT_MILLISECONDS),
        }
      );

      const result = await response.json() as GetUpdatesResponse;

      if (!result.ok) {
        if (result.error_code === 409) {
          log.error("[stavrobot] Telegram polling conflict (409): another instance is polling getUpdates, or a webhook is still set. Stop the other instance or delete the webhook.");
        } else {
          log.error(`[stavrobot] Telegram getUpdates failed${result.error_code !== undefined ? ` (${result.error_code})` : ""}: ${result.description ?? "unknown error"}`);
        }
        await sleepFunction(TELEGRAM_POLL_ERROR_RETRY_MILLISECONDS);
        continue;
      }

      const updates = result.result ?? [];
      for (const update of updates) {
        await handleTelegramUpdate(update, config);
        // Advance per update so that, if a later handler in the batch throws, the
        // already-enqueued earlier updates are not fetched and replayed again.
        if (typeof update.update_id === "number") {
          offset = update.update_id + 1;
        }
      }
    } catch (error) {
      log.error("[stavrobot] Telegram polling error:", error);
      await sleepFunction(TELEGRAM_POLL_ERROR_RETRY_MILLISECONDS);
    }
  }
}

async function downloadTelegramFile(config: TelegramConfig, fileId: string): Promise<Buffer> {
  log.debug("[stavrobot] Fetching Telegram file info for file_id:", fileId);

  const fileInfoResponse = await fetch(
    `https://api.telegram.org/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const fileInfo = await fileInfoResponse.json() as GetFileResponse;

  if (!fileInfo.ok) {
    throw new Error(`Telegram getFile failed for file_id ${fileId}`);
  }

  const filePath = fileInfo.result.file_path;
  log.debug("[stavrobot] Downloading Telegram file:", filePath);

  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${config.botToken}/${filePath}`
  );
  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  log.debug("[stavrobot] Downloaded file, size (bytes):", arrayBuffer.byteLength);
  return buffer;
}


// Telegram users may have a full name, only a username, or neither. Build the
// most human-readable name available, falling back to the numeric id.
function telegramUserName(from: TelegramUser): string {
  const fullName = [from.first_name, from.last_name]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join(" ")
    .trim();
  if (fullName !== "") {
    return fullName;
  }
  if (from.username !== undefined && from.username.trim() !== "") {
    return from.username;
  }
  return String(from.id);
}

export async function handleTelegramUpdate(
  body: unknown,
  config: TelegramConfig
): Promise<void> {
  if (!isTelegramUpdate(body)) {
    log.debug("[stavrobot] Telegram update is not an object, ignoring.");
    return;
  }

  const update = body as TelegramUpdate;

  if (update.message === undefined) {
    log.debug("[stavrobot] Telegram update has no message, ignoring.");
    return;
  }

  const rawMessage = update.message as unknown;
  if (!isTelegramMessage(rawMessage)) {
    log.debug("[stavrobot] Telegram message missing chat.id, ignoring.");
    return;
  }

  const message = rawMessage;
  const chatId = message.chat.id;

  // Group messages are still routed per chat ID; the participant identifies the
  // individual member who sent them, and the sender label labels the chat for
  // the rejected-sender buffer.
  const isGroupChat = message.chat.type !== "private";
  const fromName = message.from !== undefined ? telegramUserName(message.from) : String(chatId);
  const participant: Participant | undefined =
    isGroupChat && message.from !== undefined ? { id: String(message.from.id), name: fromName } : undefined;
  const senderLabel = isGroupChat ? message.chat.title ?? String(chatId) : fromName;

  const updateType = message.voice || message.audio ? "voice" : message.photo ? "photo" : message.document ? "document" : message.text ? "text" : "unknown";
  log.debug(`[stavrobot] [debug] Update accepted: chatId=${chatId}, type=${updateType}`);

  if (!isInAllowlist("telegram", String(chatId))) {
    recordRejectedSender("telegram", String(chatId), senderLabel);
    log.info("[stavrobot] Telegram message from disallowed chat ID:", chatId);
    return;
  }

  const formattedText = message.text !== undefined
    ? applyTelegramEntitiesToMarkdown(message.text, message.entities)
    : undefined;
  const formattedCaption = message.caption !== undefined
    ? applyTelegramEntitiesToMarkdown(message.caption, message.caption_entities)
    : undefined;

  const voiceOrAudio = message.voice ?? message.audio;

  if (voiceOrAudio !== undefined) {
    const fileId = voiceOrAudio.file_id;
    // Telegram voice notes are always OGG Opus; fall back to that if mime_type is absent.
    const mimeType = voiceOrAudio.mime_type ?? "audio/ogg";
    log.debug("[stavrobot] Telegram voice/audio message from chat:", chatId, "mimeType:", mimeType);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void downloadTelegramFile(config, fileId).then(async (buffer) => {
      const filename = `voice-${fileId}.ogg`;
      const { storedPath } = await saveAttachment(buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: buffer.length,
      };
      void enqueueMessage(formattedText ?? formattedCaption, "telegram", String(chatId), [attachment], undefined, participant, senderLabel);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading Telegram voice/audio:", error);
    });
    return;
  }

  if (message.photo !== undefined) {
    // Pick the last element, which Telegram guarantees is the highest resolution.
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;
    log.debug("[stavrobot] Telegram photo message from chat:", chatId, "file_id:", fileId);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void downloadTelegramFile(config, fileId).then(async (buffer) => {
      const filename = `photo-${fileId}.jpg`;
      const mimeType = "image/jpeg";
      const { storedPath } = await saveAttachment(buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: buffer.length,
      };
      void enqueueMessage(formattedCaption, "telegram", String(chatId), [attachment], undefined, participant, senderLabel);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading Telegram photo:", error);
    });
    return;
  }

  if (message.document !== undefined) {
    const document = message.document;
    const fileId = document.file_id;
    const mimeType = document.mime_type ?? "application/octet-stream";
    const filename = document.file_name ?? `document-${fileId}`;
    log.debug("[stavrobot] Telegram document message from chat:", chatId, "file_id:", fileId, "mimeType:", mimeType);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void downloadTelegramFile(config, fileId).then(async (buffer) => {
      const { storedPath } = await saveAttachment(buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: buffer.length,
      };
      void enqueueMessage(formattedCaption, "telegram", String(chatId), [attachment], undefined, participant, senderLabel);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading Telegram document:", error);
    });
    return;
  }

  if (formattedText !== undefined) {
    log.debug("[stavrobot] Telegram text message from chat:", chatId);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void enqueueMessage(formattedText, "telegram", String(chatId), undefined, undefined, participant, senderLabel);
    return;
  }

  log.debug("[stavrobot] Telegram message has no supported content, ignoring.");
}
