import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createSendSignalMessageTool, createSendTelegramMessageTool, createSendWhatsappMessageTool } from "./agent.js";
import type { Config } from "./config.js";

// Mock the database module so resolveRecipient and resolveInterlocutorByName can be controlled per test.
vi.mock("./database.js", () => ({
  resolveRecipient: vi.fn(),
  resolveInterlocutorByName: vi.fn(),
}));

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

import { resolveRecipient, resolveInterlocutorByName } from "./database.js";
import { isInAllowlist } from "./allowlist.js";
import { getWhatsappSocket, sendWhatsappTextMessage } from "./whatsapp-api.js";

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
    expect(capturedQuery.text).toContain("service = 'signal'");
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
    expect(capturedQuery.text).toContain("service = 'telegram'");
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
    expect(capturedQuery.text).toContain("service = 'whatsapp'");
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
