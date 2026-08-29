import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("serves a client-loaded editor with restart warnings", (): void => {
    const response = makeMockResponse();

    serveConfigSettingsPage(response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="config-content"');
    expect(response.body).toContain("/api/settings/config");
    expect(response.body).toContain('cache: "no-store"');
    expect(response.body).toContain("Saving restarts the bot and interrupts any in-progress agent turn.");
    expect(response.body).toContain("require manually restarting those containers.");
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
