import type http from "http";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { serveHomePage } from "./home.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    publicHostname: "https://example.com",
    password: "test-password",
    baseSystemPrompt: "",
    compactionPrompt: "",
    compactionBulletPrompt: "",
    baseAgentPrompt: "",
    owner: { name: "Stavros" },
    ...overrides,
  };
}

interface Capture {
  statusCode: number | undefined;
  body: string;
}

function makeResponse(capture: Capture): http.ServerResponse {
  return {
    writeHead(status: number): void {
      capture.statusCode = status;
    },
    end(body?: string): void {
      capture.body = body ?? "";
    },
  } as unknown as http.ServerResponse;
}

const STATS = {
  total: "4050",
  web: "312",
  owner: "1946",
  others: "588",
  agents: "1204",
};

function makePool(rows: unknown[] = [STATS]): pg.Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.Pool;
}

async function render(config: Config, rows: unknown[] = [STATS]): Promise<string> {
  const capture: Capture = { statusCode: undefined, body: "" };
  await serveHomePage(makeResponse(capture), config, makePool(rows));
  expect(capture.statusCode).toBe(200);
  return capture.body;
}

describe("serveHomePage — shell and header", (): void => {
  it("renders the shell chrome and the online pill", async (): Promise<void> => {
    const html = await render(makeConfig());

    expect(html).toContain('href="/assets/sb.css"');
    expect(html).toContain('class="sb-sidebar"');
    expect(html).toContain('class="sb-nav-item is-active" href="/"');
    expect(html).toContain("sb-tabbar");
    expect(html).toContain('<h1 class="sb-h1">Overview</h1>');
    expect(html).toContain("sb-pill");
    expect(html).toContain("Online ·");
  });
});

describe("serveHomePage — cards", (): void => {
  it("renders bot info from the config", async (): Promise<void> => {
    const html = await render(makeConfig({ provider: "openai", model: "gpt-5" }));

    expect(html).toContain("Bot info");
    expect(html).toContain('<span class="sb-mono">openai</span>');
    expect(html).toContain('<span class="sb-mono">gpt-5</span>');
  });

  it("renders every service status as a dot and a word", async (): Promise<void> => {
    const html = await render(
      makeConfig({
        signal: { account: "+15551234" },
        email: { webhookSecret: "secret" },
        coder: { model: "sonnet" },
      }),
    );

    expect(html).toContain('href="/settings/config"');
    expect(html).toContain('class="sb-status is-on"><span class="sb-dot sb-dot-on"></span>Enabled');
    expect(html).toContain('class="sb-status is-off"><span class="sb-dot"></span>Disabled');
    expect(html).toContain(
      'class="sb-status is-warn"><span class="sb-dot sb-dot-half"></span>Inbound only',
    );
  });

  it("marks outbound-only email with a reversed half dot", async (): Promise<void> => {
    const outboundConfig = makeConfig({
      email: { smtpHost: "smtp.example.com", webhookSecret: undefined as unknown as string },
    });
    const html = await render(outboundConfig);

    expect(html).toContain('style="transform: scaleX(-1)"');
    expect(html).toContain("Outbound only");
  });

  it("formats the message statistics and labels the web and internal bucket", async (): Promise<void> => {
    const html = await render(makeConfig());

    expect(html).toContain("Message statistics");
    expect(html).toContain("From the web chat and internal");
    expect(html).toContain("From the owner");
    expect(html).toContain("From other people");
    expect(html).toContain("From agents");
    expect(html).toContain(">312<");
    expect(html).toContain(">1,946<");
    expect(html).toContain(">588<");
    expect(html).toContain(">1,204<");
    expect(html).toContain(">4,050<");
  });

  it("renders the chat card with composer and empty state", async (): Promise<void> => {
    const html = await render(makeConfig());

    expect(html).toContain("Talks to the main agent");
    expect(html).toContain('id="chat-empty"');
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('id="chat-send"');
    expect(html).toContain("Enter to send, Shift+Enter for a new line");
    expect(html).toContain("DOMPurify.sanitize(marked.parse(text))");
  });
});

describe("serveHomePage — escaping and errors", (): void => {
  it("escapes the provider and model instead of injecting markup", async (): Promise<void> => {
    const html = await render(
      makeConfig({ provider: '<img src=x onerror="alert(1)">', model: "<b>m</b>" }),
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;b&gt;m&lt;/b&gt;");
  });

  it("returns 500 when the statistics query fails", async (): Promise<void> => {
    const capture: Capture = { statusCode: undefined, body: "" };
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("database down")),
    } as unknown as pg.Pool;

    await serveHomePage(makeResponse(capture), makeConfig(), pool);

    expect(capture.statusCode).toBe(500);
    expect(capture.body).toContain("database down");
  });
});
