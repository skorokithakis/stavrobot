import { Marked, type RendererObject, type Tokens } from "marked";
import type { TelegramConfig } from "./config.js";
import { enqueueMessage } from "./queue.js";

interface TelegramVoice {
  file_id: string;
}

interface TelegramMessage {
  chat: { id: number };
  text?: string;
  caption?: string;
  voice?: TelegramVoice;
  audio?: TelegramVoice;
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

export async function registerTelegramWebhook(config: TelegramConfig): Promise<void> {
  const webhookUrl = `${config.webhookHost}/telegram/webhook`;
  console.log("[stavrobot] Registering Telegram webhook:", webhookUrl);

  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    }
  );

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    throw new Error(`Failed to register Telegram webhook: ${result.description ?? "unknown error"}`);
  }

  console.log("[stavrobot] Telegram webhook registered successfully.");
}

async function downloadVoiceAsBase64(config: TelegramConfig, fileId: string): Promise<string> {
  console.log("[stavrobot] Fetching Telegram file info for file_id:", fileId);

  const fileInfoResponse = await fetch(
    `https://api.telegram.org/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const fileInfo = await fileInfoResponse.json() as GetFileResponse;

  if (!fileInfo.ok) {
    throw new Error(`Telegram getFile failed for file_id ${fileId}`);
  }

  const filePath = fileInfo.result.file_path;
  console.log("[stavrobot] Downloading Telegram file:", filePath);

  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${config.botToken}/${filePath}`
  );
  const arrayBuffer = await fileResponse.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  console.log("[stavrobot] Downloaded audio, size (bytes):", arrayBuffer.byteLength);
  return base64;
}

export async function handleTelegramWebhook(
  body: unknown,
  config: TelegramConfig
): Promise<void> {
  if (!isTelegramUpdate(body)) {
    console.log("[stavrobot] Telegram webhook received non-object body, ignoring.");
    return;
  }

  const update = body as TelegramUpdate;

  if (update.message === undefined) {
    console.log("[stavrobot] Telegram update has no message, ignoring.");
    return;
  }

  const rawMessage = update.message as unknown;
  if (!isTelegramMessage(rawMessage)) {
    console.log("[stavrobot] Telegram message missing chat.id, ignoring.");
    return;
  }

  const message = rawMessage;
  const chatId = message.chat.id;

  if (!config.allowedChatIds.includes(chatId)) {
    console.log("[stavrobot] Telegram message from disallowed chat ID:", chatId);
    return;
  }

  const voiceOrAudio = message.voice ?? message.audio;

  if (voiceOrAudio !== undefined) {
    const fileId = voiceOrAudio.file_id;
    console.log("[stavrobot] Telegram voice/audio message from chat:", chatId);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void downloadVoiceAsBase64(config, fileId).then((audioBase64) => {
      void enqueueMessage(message.text ?? message.caption, "telegram", String(chatId), audioBase64);
    }).catch((error: unknown) => {
      console.error("[stavrobot] Error downloading Telegram voice/audio:", error);
    });
    return;
  }

  if (message.text !== undefined) {
    console.log("[stavrobot] Telegram text message from chat:", chatId);
    // Fire-and-forget: Telegram requires a fast 200 response, so we don't await.
    void enqueueMessage(message.text, "telegram", String(chatId));
    return;
  }

  console.log("[stavrobot] Telegram message has neither text nor voice/audio, ignoring.");
}
