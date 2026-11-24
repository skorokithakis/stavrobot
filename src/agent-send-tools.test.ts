import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createSendSignalMessageTool, createSendTelegramMessageTool, createSendWhatsappMessageTool, createSendEmailTool } from "./send-tools.js";
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

import { resolveRecipient, resolveInterlocutorByName, getMainAgentId } from "./database.js";
import { isInAllowlist } from "./allowlist.js";
import { getWhatsappSocket, sendWhatsappTextMessage } from "./whatsapp-api.js";
import { sendEmail } from "./email-api.js";
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

// resolveOutboundRecipient is shared by all four send tools and each tool only
// differs in its service key and human-readable service label, so the recipient
// resolution cases run as tables over the tools rather than per channel.
interface Channel {
  description: string;
  factory: (pool: Pool, config: Config) => AgentTool;
  config: Config;
  serviceLabel: string;
  recipient: string;
  params: (recipient: string) => Record<string, unknown>;
}

const signalChannel: Channel = {
  description: "Signal",
  factory: createSendSignalMessageTool,
  config: makeConfig({ signal: { account: "+1111111111" } }),
  serviceLabel: "Signal",
  recipient: "+1234567890",
  params: (recipient) => ({ recipient, message: "hello" }),
};

const telegramChannel: Channel = {
  description: "Telegram",
  factory: createSendTelegramMessageTool,
  config: makeConfig({ telegram: { botToken: "tok" } }),
  serviceLabel: "Telegram",
  recipient: "99999",
  params: (recipient) => ({ recipient, message: "hello" }),
};

const whatsappChannel: Channel = {
  description: "WhatsApp",
  factory: createSendWhatsappMessageTool,
  config: makeConfig({ whatsapp: { account: "test" } }),
  serviceLabel: "WhatsApp",
  recipient: "+1234567890",
  params: (recipient) => ({ recipient, message: "hello" }),
};

const emailChannel: Channel = {
  description: "email",
  factory: createSendEmailTool,
  config: makeConfig(),
  serviceLabel: "email",
  recipient: "mom@example.com",
  params: (recipient) => ({ recipient, subject: "Hi", message: "hello" }),
};

const channels: Channel[] = [signalChannel, telegramChannel, whatsappChannel, emailChannel];

describe("recipient resolution", () => {
  it.each(channels)("$description rejects a raw identifier that resolves but is not in the allowlist", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const tool = channel.factory(makeIdentityFoundPool(channel.recipient), channel.config);
    const result = await tool.execute("call-1", channel.params(channel.recipient));
    expect(makeText(result)).toContain(`not in the ${channel.serviceLabel} allowlist`);
  });

  it.each(channels)("$description rejects when the interlocutor has no $description identity", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const tool = channel.factory(makeEmptyPool(), channel.config);
    const result = await tool.execute("call-1", channel.params("Mom"));
    expect(makeText(result)).toContain(`has no ${channel.serviceLabel} identity`);
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  // The raw-ID path also covers a disabled interlocutor: the JOIN with
  // interlocutors filters it out, so it surfaces as an unknown recipient.
  it.each(channels)("$description rejects a recipient that does not resolve to an enabled interlocutor", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const tool = channel.factory(makeEmptyPool(), channel.config);
    const result = await tool.execute("call-1", channel.params(channel.recipient));
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain(channel.recipient);
  });

  it.each(channels)("$description rejects when a resolved identifier is not in the allowlist", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: channel.recipient });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const tool = channel.factory(makeEmptyPool(), channel.config);
    const result = await tool.execute("call-1", channel.params("Mom"));
    expect(makeText(result)).toContain(`not in the ${channel.serviceLabel} allowlist`);
  });

  it.each(channels)("$description rejects a disabled interlocutor", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const tool = channel.factory(makeEmptyPool(), channel.config);
    const result = await tool.execute("call-1", channel.params("Mom"));
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });

  // This is the only check of the query that keeps disabled interlocutors from
  // resolving through their raw identifier.
  it.each(channels)("$description checks enabled=true when resolving a raw identifier", async (channel) => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const { pool, capturedQuery } = makeCapturingPool();
    const tool = channel.factory(pool, channel.config);
    await tool.execute("call-1", channel.params(channel.recipient));
    expect(capturedQuery.text).toContain("JOIN interlocutors");
    expect(capturedQuery.text).toContain("enabled = true");
    expect(capturedQuery.text).toContain("service = $2");
  });
});

describe("send_signal_message — configuration and rate limiting", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects when signal config is missing (no allowlist)", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(false);
    const config = makeConfig({ signal: undefined });
    const tool = createSendSignalMessageTool(makeEmptyPool(), config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("returns rate limit instructions on 429 for text-only path", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      text: async () => JSON.stringify({ error: "rate_limited", retryAfterSeconds: 86400 }),
    } as unknown as Response);

    const config = makeConfig();
    const tool = createSendSignalMessageTool(makeEmptyPool(), config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    const text = makeText(result);
    expect(text).toContain("rate-limiting");
    expect(text).toContain("https://example.com/signal/captcha");
  });
});

describe("send_telegram_message — configuration", () => {
  it("rejects when telegram config is missing", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const config = makeConfig({ telegram: undefined });
    const tool = createSendTelegramMessageTool(makeEmptyPool(), config);
    const result = await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(makeText(result)).toContain("Telegram is not configured");
  });
});

describe("send_whatsapp_message — sends", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendWhatsappTextMessage).mockResolvedValue(undefined);
  });

  it("calls sendWhatsappTextMessage with the resolved recipient and message", async () => {
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(makeEmptyPool(), config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", message: "hello" });
    expect(vi.mocked(sendWhatsappTextMessage)).toHaveBeenCalledWith("+1234567890", "hello");
    expect(makeText(result)).toBe("Message sent successfully.");
  });

  it("returns error when WhatsApp socket is not connected", async () => {
    vi.mocked(getWhatsappSocket).mockReturnValue(undefined);
    const config = makeConfig({ whatsapp: { account: "test" } });
    const tool = createSendWhatsappMessageTool(makeEmptyPool(), config);
    const result = await tool.execute("call-1", { recipient: "+1234567890", attachmentPath: "/tmp/stavrobot-temp/test.jpg" });
    expect(makeText(result)).toContain("WhatsApp is not connected");
  });
});

describe("attachment path validation", () => {
  it.each([
    { description: "WhatsApp", channel: whatsappChannel },
    { description: "email", channel: emailChannel },
  ])("rejects an $description attachmentPath outside the temp directory", async ({ channel }) => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: channel.recipient });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    const tool = channel.factory(makeEmptyPool(), channel.config);
    const result = await tool.execute("call-1", {
      ...channel.params(channel.recipient),
      attachmentPath: "/etc/passwd",
    });
    expect(makeText(result)).toContain("attachmentPath must be under the temporary attachments directory");
  });
});

describe("send_email — text send", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "mom@example.com" });
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("calls sendEmail with the resolved recipient, subject, and message", async () => {
    const tool = createSendEmailTool(makeEmptyPool(), makeConfig());
    const result = await tool.execute("call-1", { recipient: "Mom", subject: "Hello", message: "hi there" });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith("mom@example.com", "Hello", "hi there");
    expect(makeText(result)).toBe("Email sent successfully.");
  });
});

describe("send_email — recipient normalization", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("normalizes recipient email to lowercase before allowlist check", async () => {
    const tool = createSendEmailTool(makeIdentityFoundPool("test@example.com"), makeConfig());
    await tool.execute("call-1", { recipient: "TEST@EXAMPLE.COM", subject: "Hi", message: "hello" });
    expect(vi.mocked(isInAllowlist)).toHaveBeenCalledWith("email", "test@example.com");
  });
});

describe("subagent recipient scoping", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Default: main agent (ID 1). Tests that need a subagent override this.
    setCurrentAgentId(1);
    vi.mocked(getMainAgentId).mockReturnValue(1);
    vi.mocked(isInAllowlist).mockReturnValue(true);
    vi.mocked(sendWhatsappTextMessage).mockResolvedValue(undefined);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
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

  // The main-agent rows send to a recipient that is absent from every
  // assignment list, so they fail if the main-agent exemption is removed.
  it.each([
    {
      description: "allows the main agent to send to a Signal recipient that is not assigned to anyone",
      channel: signalChannel,
      agentId: 1,
      recipient: "+9999999999",
      assignedIdentifiers: ["+1111111111"],
    },
    {
      description: "allows a subagent to send to its assigned Signal interlocutor",
      channel: signalChannel,
      agentId: 2,
      recipient: "+1234567890",
      assignedIdentifiers: ["+1234567890"],
    },
    {
      description: "allows a subagent to send to its assigned Telegram interlocutor",
      channel: telegramChannel,
      agentId: 2,
      recipient: "99999",
      assignedIdentifiers: ["99999"],
    },
    {
      description: "allows a subagent to send to its assigned WhatsApp interlocutor",
      channel: whatsappChannel,
      agentId: 2,
      recipient: "+1234567890",
      assignedIdentifiers: ["+1234567890"],
    },
    {
      description: "allows the main agent to send email to a recipient that is not assigned to anyone",
      channel: emailChannel,
      agentId: 1,
      recipient: "anyone@example.com",
      assignedIdentifiers: ["mom@example.com"],
    },
  ])("$description", async ({ channel, agentId, recipient, assignedIdentifiers }) => {
    setCurrentAgentId(agentId);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: recipient });
    const pool = makeScopingPool(assignedIdentifiers, recipient);
    const tool = channel.factory(pool, channel.config);
    const result = await tool.execute("call-1", channel.params(recipient));
    expect(makeText(result)).not.toContain("assigned interlocutor");
  });

  // The rejection rows assign a different recipient, so they fail if the guard
  // only rejects subagents with no assignments at all.
  it.each([
    { description: "Signal", channel: signalChannel, recipient: "+9999999999", assignedIdentifiers: ["+1234567890"] },
    { description: "Telegram", channel: telegramChannel, recipient: "88888", assignedIdentifiers: ["99999"] },
    { description: "WhatsApp", channel: whatsappChannel, recipient: "+9999999999", assignedIdentifiers: ["+1234567890"] },
    { description: "email", channel: emailChannel, recipient: "other@example.com", assignedIdentifiers: ["mom@example.com"] },
  ])("rejects a subagent sending to a different $description interlocutor", async ({ channel, recipient, assignedIdentifiers }) => {
    setCurrentAgentId(2);
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: recipient });
    const pool = makeScopingPool(assignedIdentifiers, recipient);
    const tool = channel.factory(pool, channel.config);
    const result = await tool.execute("call-1", channel.params(recipient));
    expect(makeText(result)).toContain("assigned interlocutor");
    expect(makeText(result)).toContain("in your final response");
  });
});
