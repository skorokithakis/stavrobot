import { randomUUID } from "node:crypto";
import { Marked, type RendererObject, type Tokens } from "marked";
import type { TelegramConfig } from "./config.js";
import { isInAllowlist } from "./allowlist.js";
import { enqueueMessage } from "./queue.js";
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

interface TelegramMessage {
  chat: { id: number };
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
  message?: TelegramMessage;
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

export async function registerTelegramWebhook(config: TelegramConfig, publicHostname: string): Promise<string> {
  const webhookUrl = `${publicHostname}/telegram/webhook`;
  const secret = randomUUID();
  const secretFingerprint = secret.slice(0, 8);
  log.info("[stavrobot] Registering Telegram webhook:", webhookUrl);

  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
    }
  );

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    throw new Error(`Failed to register Telegram webhook: ${result.description ?? "unknown error"}`);
  }

  log.info("[stavrobot] Telegram webhook registered successfully.");

  log.debug(`[stavrobot] [debug] setWebhook: url=${webhookUrl}, secret=${secretFingerprint}..., status=${response.status}`);

  // Verify the webhook state Telegram actually stored.
  if (log.isDebugEnabled()) {
    const infoResponse = await fetch(
      `https://api.telegram.org/bot${config.botToken}/getWebhookInfo`
    );
    const info = await infoResponse.json() as {
      ok: boolean;
      result?: {
        url?: string;
        has_custom_certificate?: boolean;
        pending_update_count?: number;
        last_error_date?: number;
        last_error_message?: string;
      };
    };
    if (info.ok && info.result !== undefined) {
      const r = info.result;
      log.debug(`[stavrobot] [debug] getWebhookInfo: url=${r.url}, pending=${r.pending_update_count}, lastError=${r.last_error_message ?? "none"}, customCert=${r.has_custom_certificate}`);
    } else {
      log.debug("[stavrobot] [debug] getWebhookInfo: failed or empty result");
    }
  }

  return secret;
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


export async function handleTelegramWebhook(
  body: unknown,
  config: TelegramConfig
): Promise<void> {
  if (!isTelegramUpdate(body)) {
    log.debug("[stavrobot] Telegram webhook received non-object body, ignoring.");
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

  const updateType = message.voice || message.audio ? "voice" : message.photo ? "photo" : message.document ? "document" : message.text ? "text" : "unknown";
  log.debug(`[stavrobot] [debug] Webhook accepted: chatId=${chatId}, type=${updateType}`);

  if (!isInAllowlist("telegram", String(chatId))) {
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
      void enqueueMessage(formattedText ?? formattedCaption, "telegram", String(chatId), [attachment]);
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
      void enqueueMessage(formattedCaption, "telegram", String(chatId), [attachment]);
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
      void enqueueMessage(formattedCaption, "telegram", String(chatId), [attachment]);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading Telegram document:", error);
    });
    return;
  }

  if (formattedText !== undefined) {
    log.debug("[stavrobot] Telegram text message from chat:", chatId);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void enqueueMessage(formattedText, "telegram", String(chatId));
    return;
  }

  log.debug("[stavrobot] Telegram message has no supported content, ignoring.");
}
