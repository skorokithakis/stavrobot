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

describe("serveHomePage — escaping and errors", (): void => {
  it("sanitizes rendered chat Markdown before inserting it", async (): Promise<void> => {
    const html = await render(makeConfig());

    expect(html).toContain("DOMPurify.sanitize(marked.parse(text))");
  });

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
