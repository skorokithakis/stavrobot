import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  handleGetConfigRequest,
  handlePutConfigRequest,
  serveConfigSettingsPage,
} from "./config-settings.js";

const BASE_TOML = `provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
password = "test-password"

[owner]
name = "Stavros"
`;

interface MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

function makeMockResponse(): MockResponse {
  return {
    statusCode: undefined,
    headers: {},
    body: undefined,
    writeHead(status: number, headers?: Record<string, string>): void {
      this.statusCode = status;
      if (headers !== undefined) {
        Object.assign(this.headers, headers);
      }
    },
    end(body: string): void {
      this.body = body;
    },
  };
}

function makeMockRequest(body: string): http.IncomingMessage {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from(body);
    },
  } as unknown as http.IncomingMessage;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    publicHostname: "https://example.com",
    baseSystemPrompt: "You are a bot.",
    compactionPrompt: "Compact.",
    compactionBulletPrompt: "Compact.",
    baseAgentPrompt: "You are Stavrobot.",
    owner: { name: "Owner" },
    ...overrides,
  } as Config;
}

const originalConfigPath = process.env.CONFIG_PATH;
let temporaryDirectory: string;
let configPath: string;

beforeEach((): void => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stavrobot-config-settings-"));
  configPath = path.join(temporaryDirectory, "config.toml");
  process.env.CONFIG_PATH = configPath;
});

afterEach((): void => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  if (originalConfigPath === undefined) {
    delete process.env.CONFIG_PATH;
  } else {
    process.env.CONFIG_PATH = originalConfigPath;
  }
});

describe("serveConfigSettingsPage", (): void => {
  it("serves the shell with a client-loaded editor and banner states", (): void => {
    const response = makeMockResponse();

    serveConfigSettingsPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain('href="/assets/sb.css"');
    expect(response.body).toContain('id="config-content"');
    expect(response.body).toContain("sb-input sb-code-editor");
    expect(response.body).toContain("/api/settings/config");
    expect(response.body).toContain('cache: "no-store"');
    expect(response.body).toContain("Save and restart");
    expect(response.body).toContain("Loading config...");
    expect(response.body).toContain("Saving...");
    expect(response.body).toContain("Saved, restarting...");
    expect(response.body).toContain("Could not load config.toml.");
    expect(response.body).toContain("Unsaved changes");
    expect(response.body).toContain("Go to line");
  });

  it("keeps the manual restart warning accurate", (): void => {
    const response = makeMockResponse();

    serveConfigSettingsPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain("Saving restarts the bot");
    expect(response.body).toContain("plugin-runner");
    expect(response.body).toContain("coder");
    expect(response.body).toContain("signal-bridge");
    expect(response.body).toContain("python-runner");
  });

  it("shows the configured model in the shell navigation", (): void => {
    const response = makeMockResponse();

    serveConfigSettingsPage(
      response as unknown as http.ServerResponse,
      makeConfig({ model: "claude-opus-4-20250514" }),
    );

    expect(response.body).toContain("claude-opus-4-20250514");
    expect(response.body).toContain('href="/settings/config" aria-current="page"');
  });
});

describe("handleGetConfigRequest", (): void => {
  it("returns the raw config file content", (): void => {
    const content = `# Keep comments intact\n${BASE_TOML}`;
    fs.writeFileSync(configPath, content, "utf-8");
    const response = makeMockResponse();

    handleGetConfigRequest(response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!).content).toBe(content);
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });
});

describe("handlePutConfigRequest", (): void => {
  it("rejects invalid TOML without changing the config file", async (): Promise<void> => {
    fs.writeFileSync(configPath, BASE_TOML, "utf-8");
    const response = makeMockResponse();

    await handlePutConfigRequest(
      makeMockRequest(JSON.stringify({ content: "not valid TOML = [" })),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body!).error).toBeTruthy();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(BASE_TOML);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it("rejects valid TOML without a password without changing the config file", async (): Promise<void> => {
    fs.writeFileSync(configPath, BASE_TOML, "utf-8");
    const response = makeMockResponse();
    const contentWithoutPassword = BASE_TOML.replace('password = "test-password"\n', "");

    await handlePutConfigRequest(
      makeMockRequest(JSON.stringify({ content: contentWithoutPassword })),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body!).error).toBe("Config must specify a password.");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(BASE_TOML);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it("backs up, writes, and restarts after accepting valid TOML", async (): Promise<void> => {
    const originalContent = BASE_TOML;
    const updatedContent = BASE_TOML.replace("claude-sonnet-4-20250514", "claude-opus-4-20250514");
    fs.writeFileSync(configPath, originalContent, "utf-8");
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => undefined as never);
    const response = makeMockResponse();

    await handlePutConfigRequest(
      makeMockRequest(JSON.stringify({ content: updatedContent })),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(200);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(updatedContent);
    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe(originalContent);
    expect(exitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
