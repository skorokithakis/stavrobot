import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createSendSignalMessageTool, createSendTelegramMessageTool, createSendWhatsappMessageTool, createSendEmailTool, createSendAgentmailTool, createDownloadAgentmailAttachmentTool } from "./send-tools.js";
import type { Config } from "./config.js";
import { initInternalFetch } from "./internal-fetch.js";

// Initialize internalFetch with a dummy password so tests can call it without
// going through main(). The actual password value does not matter here because
// tests stub the global fetch and never make real HTTP requests.
initInternalFetch("test-password");

// Mock the database module so resolveRecipient, resolveInterlocutorByName, and
// getMainAgentId can be controlled per test.
vi.mock("./database.js", () => ({
  resolveRecipient: vi.fn(),
  resolveInterlocutorByName: vi.fn(),
  getMainAgentId: vi.fn().mockReturnValue(1),
}));

// Mock agent-context so currentAgentId can be controlled per test.
// The mock exposes a mutable currentAgentId that tests can override via
// Object.defineProperty on the module namespace.
vi.mock("./agent-context.js", () => {
  let _currentAgentId = 1;
  return {
    get currentAgentId() { return _currentAgentId; },
    setCurrentAgentId(id: number) { _currentAgentId = id; },
  };
});

// Mock the allowlist module so tests can control which identifiers are allowed
// without touching the filesystem or module-level state.
vi.mock("./allowlist.js", () => ({
  isInAllowlist: vi.fn(),
}));

// Mock the whatsapp-api module so tests can control socket availability.
vi.mock("./whatsapp-api.js", () => ({
  getWhatsappSocket: vi.fn(),
  e164ToJid: vi.fn((phone: string) => `${phone.replace("+", "")}@s.whatsapp.net`),
  sendWhatsappTextMessage: vi.fn(),
}));

// Mock the email-api module so tests can control sendEmail behavior.
vi.mock("./email-api.js", () => ({
  sendEmail: vi.fn(),
  initializeEmailTransport: vi.fn(),
}));

// Mock the agentmail-api module so tests can control sendAgentmailMessage and getAgentmailAttachmentUrl.
vi.mock("./agentmail-api.js", () => ({
  sendAgentmailMessage: vi.fn(),
  getAgentmailAttachmentUrl: vi.fn(),
  initializeAgentmailClient: vi.fn(),
  registerAgentmailWebhook: vi.fn(),
}));

// Mock the uploads module so tests can control saveAttachment.
vi.mock("./uploads.js", () => ({
  saveAttachment: vi.fn(),
}));

import { resolveRecipient, resolveInterlocutorByName, getMainAgentId } from "./database.js";
import { isInAllowlist } from "./allowlist.js";
import { getWhatsappSocket, sendWhatsappTextMessage } from "./whatsapp-api.js";
import { sendEmail } from "./email-api.js";
import { sendAgentmailMessage, getAgentmailAttachmentUrl } from "./agentmail-api.js";
import { saveAttachment } from "./uploads.js";
import { setCurrentAgentId } from "./agent-context.js";

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text content block");
  }
  return block.text;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    publicHostname: "https://example.com",
    baseSystemPrompt: "You are a bot.",
    baseAgentPrompt: "You are a bot.",
    owner: { name: "Owner" },
    signal: { account: "+1111111111" },
    telegram: { botToken: "test-token" },
    email: {
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "user@example.com",
      smtpPassword: "secret",
      fromAddress: "bot@example.com",
      webhookSecret: "webhook-secret",
    },
    ...overrides,
  } as Config;
}

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
    connect: vi.fn(),
  } as unknown as Pool;
}

// A pool that returns no rows for any identity check (recipient not in interlocutor_identities).
function makeEmptyPool(): Pool {
  return makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
}

// A pool that returns a row for the identity check (recipient exists in interlocutor_identities).
function makeIdentityFoundPool(identifier: string): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [{ identifier }], rowCount: 1 } as unknown as QueryResult),
  );
}

// A pool that captures the SQL query text for assertion and returns no rows.
function makeCapturingPool(): { pool: Pool; capturedQuery: { text: string | undefined } } {
  const capturedQuery: { text: string | undefined } = { text: undefined };
  const pool = makeMockPool((text: string) => {
    capturedQuery.text = text;
    return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
  });
  return { pool, capturedQuery };
}

describe("isInAllowlist (via send tools)", () => {
  it("send_signal_message rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeIdentityFoundPool("+9999999999");
    const config = makeConfig({ signal: { account: "+1111111111" } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("send_telegram_message rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeIdentityFoundPool("11111");
    const config = makeConfig({ telegram: { botToken: "tok" } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "11111", message: "hello" });
    expect(makeText(result)).toContain("not in the Telegram allowlist");
  });
});

describe("send_signal_message — recipient resolution", () => {
  it("returns error when no message or attachment is provided", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890" });
    expect(makeText(result)).toContain("at least one of message or attachmentPath must be provided");
  });

  it("rejects with a specific error when interlocutor exists but has no Signal identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("has no Signal identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Unknown Person", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("Unknown Person");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig({ signal: { account: "+1111111111" } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("rejects when signal config is missing (no allowlist)", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig({ signal: undefined });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  it("rejects with unknown recipient when raw phone number belongs to a disabled interlocutor", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    // The pool returns no rows because the JOIN filters out disabled interlocutors.
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
  });

  it("uses a query that joins interlocutors and checks enabled=true for the Signal raw-ID path", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    expect(capturedQuery.text).toContain("service = $2");
  });
});

describe("send_telegram_message — recipient resolution", () => {
  it("returns error when no message or attachment is provided", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999" });
    expect(makeText(result)).toContain("at least one of message or attachmentPath must be provided");
  });

  it("rejects with a specific error when interlocutor exists but has no Telegram identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("has no Telegram identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Unknown Person", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("Unknown Person");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "11111" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig({ telegram: { botToken: "tok" } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Telegram allowlist");
  });

  it("rejects when telegram config is missing", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig({ telegram: undefined });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(makeText(result)).toContain("Telegram is not configured");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  it("rejects with unknown recipient when raw chat ID belongs to a disabled interlocutor", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    // The pool returns no rows because the JOIN filters out disabled interlocutors.
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
  });

  it("uses a query that joins interlocutors and checks enabled=true for the Telegram raw-ID path", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    expect(capturedQuery.text).toContain("service = $2");
  });
});

describe("send_signal_message — rate limiting", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns rate limit instructions on 429 for text-only path", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      text: async () => JSON.stringify({ error: "rate_limited", retryAfterSeconds: 86400 }),
    } as unknown as Response);

    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    const text = makeText(result);
    expect(text).toContain("rate-limiting");
    expect(text).toContain("https://example.com/signal/captcha");
  });

});

describe("isInAllowlist (via send tools) — WhatsApp", () => {
  it("send_whatsapp_message rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeIdentityFoundPool("+9999999999");
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    expect(makeText(result)).toContain("not in the WhatsApp allowlist");
  });
});

describe("send_whatsapp_message — recipient resolution", () => {
  it("returns error when no message or attachment is provided", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890" });
    expect(makeText(result)).toContain("at least one of message or attachmentPath must be provided");
  });

  it("rejects with a specific error when interlocutor exists but has no WhatsApp identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("has no WhatsApp identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Unknown Person", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("Unknown Person");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the WhatsApp allowlist");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  it("rejects with unknown recipient when raw phone number belongs to a disabled interlocutor", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    // The pool returns no rows because the JOIN filters out disabled interlocutors.
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
  });

  it("uses a query that joins interlocutors and checks enabled=true for the WhatsApp raw-ID path", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    expect(capturedQuery.text).toContain("service = $2");
  });
});

describe("send_whatsapp_message — text send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendWhatsappTextMessage).mockResolvedValue(undefined);
  });

  it("calls sendWhatsappTextMessage with the resolved recipient and message", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(vi.mocked(sendWhatsappTextMessage)).toHaveBeenCalledWith("+1234567890", "hello");
    expect(makeText(result)).toBe("Message sent successfully.");
  });
});

describe("send_whatsapp_message — attachment send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
  });

  it("returns error when WhatsApp socket is not connected", async () => {
    vi.mocked(getWhatsappSocket).mockReturnValue(undefined);
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", attachmentPath: "/tmp/stavrobot-temp/test.jpg" });
    expect(makeText(result)).toContain("WhatsApp is not connected");
  });

  it("returns error when attachmentPath is outside the temp directory", async () => {
    vi.mocked(getWhatsappSocket).mockReturnValue({ sendMessage: vi.fn() } as unknown as ReturnType<typeof getWhatsappSocket>);
    const pool = makeEmptyPool();
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", attachmentPath: "/etc/passwd" });
    expect(makeText(result)).toContain("attachmentPath must be under the temporary attachments directory");
  });
});

describe("isInAllowlist (via send tools) — email", () => {
  it("send_email rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeIdentityFoundPool("stranger@example.com");
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "stranger@example.com", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("not in the email allowlist");
  });
});

describe("send_email — recipient resolution", () => {
  it("rejects with a specific error when interlocutor exists but has no email identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("has no email identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "unknown@example.com", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("unknown@example.com");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "stranger@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("not in the email allowlist");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  it("rejects with unknown recipient when raw email belongs to a disabled interlocutor", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    // The pool returns no rows because the JOIN filters out disabled interlocutors.
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "disabled@example.com", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
  });

  it("uses a query that joins interlocutors and checks enabled=true for the email raw-ID path", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    await tool.execute("call-1", { recipient: "test@example.com", subject: "Hi", message: "hello" });
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    expect(capturedQuery.text).toContain("service = $2");
  });

  it("normalizes recipient email to lowercase before allowlist check", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
    const pool = makeIdentityFoundPool("test@example.com");
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    await tool.execute("call-1", { recipient: "TEST@EXAMPLE.COM", subject: "Hi", message: "hello" });
    expect(vi.mocked(isInAllowlist)).toHaveBeenCalledWith("email", "test@example.com");
  });
});

describe("send_email — text send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "mom@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("calls sendEmail with the resolved recipient, subject, and message", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hello", message: "hi there" });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith("mom@example.com", "Hello", "hi there");
    expect(makeText(result)).toBe("Email sent successfully.");
  });
});

describe("send_email — attachment send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "mom@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("returns error when attachmentPath is outside the temp directory", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hi", message: "hello", attachmentPath: "/etc/passwd" });
    expect(makeText(result)).toContain("attachmentPath must be under the temporary attachments directory");
  });
});

// A pool that returns assigned identifiers for the scoping query (agent_id-based)
// and a found row for the raw-ID identity check.
function makeScopingPool(assignedIdentifiers: string[], rawIdentifier: string): Pool {
  return makeMockPool((text: string) => {
    if (text.includes("agent_id")) {
      // Scoping query: return the assigned identifiers.
      return Promise.resolve({
        rows: assignedIdentifiers.map((identifier) => ({ identifier })),
        rowCount: assignedIdentifiers.length,
      } as unknown as QueryResult);
    }
    // Raw-ID identity check: return a found row so resolution succeeds.
    return Promise.resolve({ rows: [{ identifier: rawIdentifier }], rowCount: 1 } as unknown as QueryResult);
  });
}

describe("subagent recipient scoping", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Default: main agent (ID 1). Tests that need a subagent override this.
    setCurrentAgentId(1);
    vi.mocked(getMainAgentId).mockReturnValue(1);
    vi.mocked(isInAllowlist).mockReturnValue(true);
    // Stub fetch to return a successful Signal bridge response so tests that
    // pass the scoping check don't fail on a real HTTP request.
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response);
  });

  afterEach(() => {
    // Reset to main agent after each test.
    setCurrentAgentId(1);
    global.fetch = originalFetch;
  });

  it("allows main agent to send to any Signal recipient", async () => {
    // Main agent (ID 1) is exempt from scoping.
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    const pool = makeScopingPool(["+1111111111"], "+9999999999");
    const config = makeConfig({ signal: { account: "+1111111111" } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    // Should not be rejected by scoping (may fail for other reasons like signal bridge, but not scoping).
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("allows subagent to send to its assigned Signal interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    // The scoping pool returns +1234567890 as the assigned identifier for agent 2.
    const pool = makeScopingPool(["+1234567890"], "+1234567890");
    const config = makeConfig({ signal: { account: "+1111111111" } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("rejects subagent sending to a different Signal interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    // The scoping pool returns only +1234567890 as assigned to agent 2.
    const pool = makeScopingPool(["+1234567890"], "+9999999999");
    const config = makeConfig({ signal: { account: "+1111111111" } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("send_agent_message");
  });

  it("allows subagent to send to its assigned Telegram interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "99999" });
    const pool = makeScopingPool(["99999"], "99999");
    const config = makeConfig({ telegram: { botToken: "tok" } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("rejects subagent sending to a different Telegram interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "88888" });
    const pool = makeScopingPool(["99999"], "88888");
    const config = makeConfig({ telegram: { botToken: "tok" } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "88888", message: "hello" });
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("send_agent_message");
  });

  it("allows subagent to send to its assigned WhatsApp interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(sendWhatsappTextMessage).mockResolvedValue(undefined);
    const pool = makeScopingPool(["+1234567890"], "+1234567890");
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("rejects subagent sending to a different WhatsApp interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    const pool = makeScopingPool(["+1234567890"], "+9999999999");
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("send_agent_message");
  });

  it("rejects subagent sending to a different email interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "other@example.com" });
    // The scoping pool returns only mom@example.com as assigned to agent 2.
    const pool = makeScopingPool(["mom@example.com"], "other@example.com");
    const config = makeConfig();
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "other@example.com", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("send_agent_message");
  });

  it("allows main agent to send email to any recipient", async () => {
    // Main agent (ID 1) is exempt from scoping.
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "anyone@example.com" });
    const pool = makeScopingPool(["mom@example.com"], "anyone@example.com");
    const config = makeConfig();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
    const tool = createSendEmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "anyone@example.com", subject: "Hi", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("allows main agent to send agentmail to any recipient", async () => {
    // Main agent (ID 1) is exempt from scoping.
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "anyone@example.com" });
    const pool = makeScopingPool(["assigned@example.com"], "anyone@example.com");
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    vi.mocked(sendAgentmailMessage).mockResolvedValue(undefined);
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "anyone@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("allows subagent to send to its assigned agentmail interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "assigned@example.com" });
    const pool = makeScopingPool(["assigned@example.com"], "assigned@example.com");
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    vi.mocked(sendAgentmailMessage).mockResolvedValue(undefined);
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "assigned@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  it("rejects subagent sending to a different agentmail interlocutor", async () => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "other@example.com" });
    // The scoping pool returns only assigned@example.com as assigned to agent 2.
    const pool = makeScopingPool(["assigned@example.com"], "other@example.com");
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "other@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("send_agent_message");
  });
});

describe("isInAllowlist (via send tools) — agentmail", () => {
  it("send_agentmail rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeIdentityFoundPool("stranger@example.com");
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "stranger@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("not in the agentmail allowlist");
  });
});

describe("send_agentmail — recipient resolution", () => {
  it("rejects with a specific error when interlocutor exists but has no agentmail identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("has no agentmail identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "unknown@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("unknown@example.com");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "stranger@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("not in the agentmail allowlist");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  it("rejects with unknown recipient when raw email belongs to a disabled interlocutor", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    // The pool returns no rows because the JOIN filters out disabled interlocutors.
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "disabled@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
  });

  it("uses a query that joins interlocutors and checks enabled=true for the agentmail raw-ID path", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    await tool.execute("call-1", { recipient: "test@example.com", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    // The shared resolveOutboundRecipient helper uses a parameterized query ($2 for service).
    expect(capturedQuery.text).toContain("service = $2");
  });

  it("normalizes recipient email to lowercase before allowlist check", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendAgentmailMessage).mockResolvedValue(undefined);
    const pool = makeIdentityFoundPool("test@example.com");
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    await tool.execute("call-1", { recipient: "TEST@EXAMPLE.COM", inboxId: "inbox-1", subject: "Hi", message: "hello" });
    expect(vi.mocked(isInAllowlist)).toHaveBeenCalledWith("agentmail", "test@example.com");
  });
});

describe("send_agentmail — text send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "mom@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendAgentmailMessage).mockResolvedValue(undefined);
  });

  it("calls sendAgentmailMessage with the resolved recipient, inboxId, subject, and message", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hello", message: "hi there" });
    expect(vi.mocked(sendAgentmailMessage)).toHaveBeenCalledWith("inbox-1", "mom@example.com", "Hello", "hi there", undefined);
    expect(makeText(result)).toBe("Message sent successfully.");
  });

  it("passes replyToMessageId when provided", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Re: Hello", message: "reply body", replyToMessageId: "msg-42" });
    expect(vi.mocked(sendAgentmailMessage)).toHaveBeenCalledWith("inbox-1", "mom@example.com", "Re: Hello", "reply body", "msg-42");
  });
});

describe("send_agentmail — attachment send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "mom@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendAgentmailMessage).mockResolvedValue(undefined);
  });

  it("returns error when attachmentPath is outside the temp directory", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello", attachmentPath: "/etc/passwd" });
    expect(makeText(result)).toContain("attachmentPath must be under the temporary attachments directory");
  });

  it("rejects a path that is a sibling directory of TEMP_ATTACHMENTS_DIR (path traversal)", async () => {
    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);
    // /tmp/stavrobot-temp-evil/foo starts with /tmp/stavrobot-temp but is not inside it
    const result = await tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello", attachmentPath: "/tmp/stavrobot-temp-evil/foo.txt" });
    expect(makeText(result)).toContain("attachmentPath must be under the temporary attachments directory");
  });

  it("deletes the temp file even when sendAgentmailMessage throws", async () => {
    vi.mocked(sendAgentmailMessage).mockRejectedValue(new Error("send failed"));

    // We need a real temp file for the tool to read and then delete.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join("/tmp/stavrobot-temp", "test-cleanup.txt");
    await fs.mkdir("/tmp/stavrobot-temp", { recursive: true });
    await fs.writeFile(filePath, "test content");

    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createSendAgentmailTool(pool, config);

    await expect(
      tool.execute("call-1", { recipient: "Mom", inboxId: "inbox-1", subject: "Hi", message: "hello", attachmentPath: filePath }),
    ).rejects.toThrow("send failed");

    // File must have been deleted despite the error.
    await expect(fs.access(filePath)).rejects.toThrow();
  });
});

describe("download_agentmail_attachment — happy path", () => {
  it("fetches the attachment URL, saves it, and returns the stored path and metadata", async () => {
    vi.mocked(getAgentmailAttachmentUrl).mockResolvedValue({
      downloadUrl: "https://cdn.example.com/attachment.pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1024,
    });

    const fakeArrayBuffer = new ArrayBuffer(8);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => fakeArrayBuffer,
    } as unknown as Response);

    vi.mocked(saveAttachment).mockResolvedValue({
      storedPath: "/tmp/stavrobot-temp/upload-abc123.pdf",
      storedFilename: "upload-abc123.pdf",
    });

    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createDownloadAgentmailAttachmentTool(pool, config);
    const result = await tool.execute("call-1", { inboxId: "inbox-1", messageId: "msg-1", attachmentId: "att-1" });

    expect(vi.mocked(getAgentmailAttachmentUrl)).toHaveBeenCalledWith("inbox-1", "msg-1", "att-1");
    expect(vi.mocked(saveAttachment)).toHaveBeenCalledWith(
      expect.any(Buffer),
      "report.pdf",
      "application/pdf",
    );

    const text = makeText(result);
    expect(text).toContain("/tmp/stavrobot-temp/upload-abc123.pdf");
    expect(text).toContain("report.pdf");
    expect(text).toContain("application/pdf");
    expect(text).toContain("1024");

    expect(result.details).toMatchObject({
      storedPath: "/tmp/stavrobot-temp/upload-abc123.pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1024,
    });
  });

  it("falls back to attachmentId as filename and application/octet-stream when metadata is absent", async () => {
    vi.mocked(getAgentmailAttachmentUrl).mockResolvedValue({
      downloadUrl: "https://cdn.example.com/blob",
      filename: undefined,
      contentType: undefined,
      size: 512,
    });

    const fakeArrayBuffer = new ArrayBuffer(4);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => fakeArrayBuffer,
    } as unknown as Response);

    vi.mocked(saveAttachment).mockResolvedValue({
      storedPath: "/tmp/stavrobot-temp/upload-xyz.bin",
      storedFilename: "upload-xyz.bin",
    });

    const pool = makeEmptyPool();
    const config = makeConfig({ agentmail: { apiKey: "test-agentmail-key" } });
    const tool = createDownloadAgentmailAttachmentTool(pool, config);
    await tool.execute("call-1", { inboxId: "inbox-1", messageId: "msg-1", attachmentId: "att-99" });

    expect(vi.mocked(saveAttachment)).toHaveBeenCalledWith(
      expect.any(Buffer),
      "att-99",
      "application/octet-stream",
    );
  });
});
