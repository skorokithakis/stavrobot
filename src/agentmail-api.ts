import { AgentMailClient } from "agentmail";
import type { AgentMail } from "agentmail";
import { log } from "./log.js";

let client: AgentMailClient | undefined;

export function initializeAgentmailClient(apiKey: string): void {
  log.info("[stavrobot] Initializing AgentMail client");
  client = new AgentMailClient({ apiKey });
}

export async function registerAgentmailWebhook(publicHostname: string): Promise<string> {
  if (client === undefined) {
    throw new Error("AgentMail client is not initialized");
  }

  const targetUrl = `${publicHostname}/agentmail/webhook`;

  const allWebhooks: AgentMail.webhooks.Webhook[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.webhooks.list({ pageToken });
    allWebhooks.push(...page.webhooks);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  const existing = allWebhooks.find((webhook) => webhook.url === targetUrl);

  if (existing !== undefined) {
    log.info("[stavrobot] Reusing existing AgentMail webhook:", targetUrl);
    const full = await client.webhooks.get(existing.webhookId);
    return full.secret;
  }

  log.info("[stavrobot] Creating AgentMail webhook:", targetUrl);
  const created = await client.webhooks.create({
    url: targetUrl,
    eventTypes: ["message.received"],
  });

  return created.secret;
}

interface OutboundAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export async function sendAgentmailMessage(
  inboxId: string,
  to: string,
  subject: string,
  text: string,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
): Promise<void> {
  if (client === undefined) {
    throw new Error("AgentMail client is not initialized");
  }

  const html = text
    .split(/\n\n+/)
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("");

  const sdkAttachments: AgentMail.SendAttachment[] | undefined =
    attachments !== undefined && attachments.length > 0
      ? attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
        }))
      : undefined;

  if (replyToMessageId !== undefined) {
    log.info("[stavrobot] Replying to AgentMail message:", replyToMessageId, "in inbox:", inboxId);
    await client.inboxes.messages.reply(inboxId, replyToMessageId, {
      text,
      html,
      attachments: sdkAttachments,
    });
  } else {
    log.info("[stavrobot] Sending AgentMail message to:", to, "from inbox:", inboxId);
    await client.inboxes.messages.send(inboxId, {
      to,
      subject,
      text,
      html,
      attachments: sdkAttachments,
    });
  }
}

interface AttachmentUrlResult {
  downloadUrl: string;
  filename: string | undefined;
  contentType: string | undefined;
  size: number;
}

export async function getAgentmailAttachmentUrl(
  inboxId: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentUrlResult> {
  if (client === undefined) {
    throw new Error("AgentMail client is not initialized");
  }

  const response = await client.inboxes.messages.getAttachment(inboxId, messageId, attachmentId);

  return {
    downloadUrl: response.downloadUrl,
    filename: response.filename,
    contentType: response.contentType,
    size: response.size,
  };
}
