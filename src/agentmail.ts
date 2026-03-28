import http from "http";
import { Webhook } from "svix";
import { isInAllowlist } from "./allowlist.js";
import { enqueueMessage } from "./queue.js";
import { log } from "./log.js";

let webhookSecret: string | undefined;

export function setAgentmailWebhookSecret(secret: string | undefined): void {
  webhookSecret = secret;
}

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

function parseEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  if (match !== null) {
    return match[1].toLowerCase();
  }
  return from.toLowerCase();
}

interface AgentmailAttachment {
  attachment_id: string;
  filename: string;
  size: number;
  content_type: string;
}

export async function handleAgentmailWebhook(payload: unknown): Promise<void> {
  const payloadObj = payload as Record<string, unknown>;
  const message = payloadObj.message as Record<string, unknown>;

  const from = message.from as string;
  const inboxId = message.inbox_id as string;
  const threadId = message.thread_id as string;
  const messageId = message.message_id as string;
  const subject = message.subject as string | undefined;
  const text = (message.text as string | undefined) ?? "";
  const rawAttachments = (message.attachments as AgentmailAttachment[] | undefined) ?? [];

  const senderEmail = parseEmailAddress(from);

  log.info("[stavrobot] Agentmail webhook received from:", senderEmail);

  const headerLine = `[Inbox: ${inboxId} | Thread: ${threadId} | Message: ${messageId}]`;

  const lines: string[] = [headerLine];

  if (subject !== undefined && subject !== "") {
    lines.push(`Subject: ${subject}`);
  }

  lines.push("");
  lines.push(text);

  if (rawAttachments.length > 0) {
    lines.push("");
    lines.push("Attachments:");
    for (const attachment of rawAttachments) {
      lines.push(
        `- ${attachment.filename} (${attachment.content_type}, ${attachment.size} bytes, attachmentId: ${attachment.attachment_id})`,
      );
    }
  }

  const formattedMessage = lines.join("\n");

  if (!isInAllowlist("agentmail", senderEmail)) {
    log.info("[stavrobot] Agentmail message from disallowed address:", senderEmail);
    return;
  }

  log.info("[stavrobot] Enqueueing agentmail message from:", senderEmail);
  void enqueueMessage(formattedMessage, "agentmail", senderEmail);
}

export function handleAgentmailWebhookRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void {
  void (async (): Promise<void> => {
    try {
      if (webhookSecret === undefined) {
        log.warn("[stavrobot] Agentmail webhook secret not set, rejecting request");
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const svixId = request.headers["svix-id"];
      const svixTimestamp = request.headers["svix-timestamp"];
      const svixSignature = request.headers["svix-signature"];

      if (
        typeof svixId !== "string" ||
        typeof svixTimestamp !== "string" ||
        typeof svixSignature !== "string"
      ) {
        log.info("[stavrobot] Agentmail webhook rejected: missing Svix headers");
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const rawBody = await readBody(request);

      const wh = new Webhook(webhookSecret);
      try {
        wh.verify(rawBody, {
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": svixSignature,
        });
      } catch {
        log.info("[stavrobot] Agentmail webhook rejected: invalid Svix signature");
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const eventType = (parsedBody as Record<string, unknown>).event_type;
      if (eventType !== "message.received") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));

      void handleAgentmailWebhook(parsedBody).catch((error: unknown) => {
        log.error("[stavrobot] Error processing agentmail webhook:", error);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Request body too large") {
        if (!response.headersSent) {
          response.writeHead(413, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Request body too large" }));
        }
        return;
      }
      log.error("[stavrobot] Error handling agentmail webhook request:", error);
      if (!response.headersSent) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: errorMessage }));
      }
    }
  })();
}
