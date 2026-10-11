import http from "http";
import { simpleParser } from "mailparser";
import type { EmailConfig } from "./config.js";
import { isInAllowlist, recordRejectedSender } from "./allowlist.js";
import { enqueueMessage } from "./queue.js";
import { saveAttachment, type FileAttachment } from "./uploads.js";
import { log } from "./log.js";

async function readBody(
  request: http.IncomingMessage,
  maxBytes: number = 10 * 1024 * 1024,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > maxBytes) {
      request.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface EmailWebhookPayload {
  from: string;
  to: string;
  raw: string;
}

function isEmailWebhookPayload(value: unknown): value is EmailWebhookPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).from === "string" &&
    typeof (value as Record<string, unknown>).to === "string" &&
    typeof (value as Record<string, unknown>).raw === "string"
  );
}

export async function handleEmailWebhook(payload: EmailWebhookPayload): Promise<void> {
  const from = payload.from.toLowerCase();
  const raw = payload.raw;

  log.info("[stavrobot] Email webhook received from:", from);

  const parsed = await simpleParser(raw);

  const subject = parsed.subject ?? "";
  const bodyText = parsed.text ?? (parsed.html !== undefined && parsed.html !== false ? "" : "");

  const attachments: FileAttachment[] = [];
  for (const attachment of parsed.attachments) {
    const filename = attachment.filename ?? `attachment-${attachments.length + 1}`;
    const mimeType = attachment.contentType;
    const content = attachment.content;

    log.info("[stavrobot] Saving email attachment:", filename, "mimeType:", mimeType);
    const { storedPath } = await saveAttachment(content, filename, mimeType);
    attachments.push({
      storedPath,
      originalFilename: filename,
      mimeType,
      size: content.length,
    });
  }

  const formattedMessage =
    subject !== ""
      ? `Subject: ${subject}\n\n${bodyText}`
      : bodyText;

  if (!isInAllowlist("email", from)) {
    const fromDisplayName = parsed.from?.value[0]?.name;
    const senderLabel =
      fromDisplayName !== undefined && fromDisplayName.trim() !== "" ? fromDisplayName : undefined;
    recordRejectedSender("email", from, senderLabel);
    log.info("[stavrobot] Email from disallowed address:", from);
    return;
  }

  log.info("[stavrobot] Enqueueing email message from:", from);
  void enqueueMessage(
    formattedMessage,
    "email",
    from,
    attachments.length > 0 ? attachments : undefined,
  );
}

export function handleEmailWebhookRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: EmailConfig,
): void {
  const authHeader = request.headers["authorization"];
  if (authHeader === undefined || authHeader !== `Bearer ${config.webhookSecret}`) {
    log.info("[stavrobot] Email webhook rejected: invalid or missing Authorization header");
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  void (async (): Promise<void> => {
    try {
      const body = await readBody(request);
      let parsedBody: unknown;

      try {
        parsedBody = JSON.parse(body);
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!isEmailWebhookPayload(parsedBody)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid payload: expected { from, to, raw }" }));
        return;
      }

      // Respond 200 immediately before processing — the Cloudflare worker requires a fast response.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));

      void handleEmailWebhook(parsedBody).catch((error: unknown) => {
        log.error("[stavrobot] Error processing email webhook:", error);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Request body too large") {
        if (!response.headersSent) {
          response.writeHead(413, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Request body too large" }));
        }
        return;
      }
      log.error("[stavrobot] Error handling email webhook request:", error);
      if (!response.headersSent) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: errorMessage }));
      }
    }
  })();
}
