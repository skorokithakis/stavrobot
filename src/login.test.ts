import { EventEmitter } from "events";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { Config } from "./config.js";
import { handleLoginEvents, handleLoginRespond, type OAuthAuthResolver } from "./login.js";

const PROVIDER_ID = "test-oauth";

interface MockResponse {
  writes: string[];
  statusCode: number | undefined;
  writeHead(statusCode: number): void;
  write(chunk: string): boolean;
  end(chunk?: string): void;
}

let temporaryDirectory: string;
let authFile: string;

function makeResponse(): MockResponse {
  return {
    writes: [],
    statusCode: undefined,
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    },
    end(chunk?: string): void {
      if (chunk !== undefined) {
        this.writes.push(chunk);
      }
    },
  };
}

function makeEventRequest(): http.IncomingMessage {
  return new EventEmitter() as unknown as http.IncomingMessage;
}

function makeBodyRequest(body: string): http.IncomingMessage {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from(body);
    },
  } as unknown as http.IncomingMessage;
}

function createConfig(): Config {
  return {
    provider: PROVIDER_ID,
    authFile,
  } as unknown as Config;
}

beforeEach((): void => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stavrobot-login-"));
  authFile = path.join(temporaryDirectory, "auth.json");
});

afterEach((): void => {
  vi.restoreAllMocks();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("handleLoginEvents", (): void => {
  it("streams OAuth events, accepts a prompt response, and preserves existing credentials", async (): Promise<void> => {
    const credential: OAuthCredential = {
      type: "oauth",
      refresh: "new-refresh-token",
      access: "new-access-token",
      expires: Date.now() + 60_000,
    };
    fs.writeFileSync(authFile, JSON.stringify({
      "other-provider": { type: "api_key", key: "keep-me" },
    }), "utf-8");
    const oauth: OAuthAuth = {
      name: "Test OAuth",
      login: async (interaction): Promise<OAuthCredential> => {
        interaction.notify({ type: "auth_url", url: "https://example.test/login", instructions: "Open the link." });
        const response = await interaction.prompt({ type: "manual_code", message: "Paste the code." });
        expect(response).toBe("redirect-url");
        return credential;
      },
      refresh: vi.fn(),
      toAuth: vi.fn(),
    };
    const resolveProvider: OAuthAuthResolver = (): OAuthAuth => oauth;
    const eventsResponse = makeResponse();

    const loginResult = handleLoginEvents(
      makeEventRequest(),
      eventsResponse as unknown as http.ServerResponse,
      createConfig(),
      resolveProvider,
    );
    const promptResponse = makeResponse();
    await handleLoginRespond(
      makeBodyRequest(JSON.stringify({ value: "redirect-url" })),
      promptResponse as unknown as http.ServerResponse,
    );
    await loginResult;

    const events = eventsResponse.writes.join("");
    expect(events).toContain("event: auth");
    expect(events).toContain("event: prompt");
    expect(events).toContain("event: success");
    expect(promptResponse.statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(authFile, "utf-8"))).toEqual({
      "other-provider": { type: "api_key", key: "keep-me" },
      [PROVIDER_ID]: credential,
    });
  });

  it("clears an aborted prompt so a new login flow can start", async (): Promise<void> => {
    const credential: OAuthCredential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    };
    let loginCalls = 0;
    const oauth: OAuthAuth = {
      name: "Test OAuth",
      login: async (interaction): Promise<OAuthCredential> => {
        loginCalls += 1;
        if (loginCalls === 1) {
          const promptController = new AbortController();
          const promptResult = interaction.prompt({
            type: "manual_code",
            message: "Paste the code.",
            signal: promptController.signal,
          });
          promptController.abort();
          await expect(promptResult).rejects.toThrow("Login prompt cancelled");
        }
        return credential;
      },
      refresh: vi.fn(),
      toAuth: vi.fn(),
    };
    const resolveProvider: OAuthAuthResolver = (): OAuthAuth => oauth;
    const firstResponse = makeResponse();

    await handleLoginEvents(
      makeEventRequest(),
      firstResponse as unknown as http.ServerResponse,
      createConfig(),
      resolveProvider,
    );

    const secondResponse = makeResponse();
    await handleLoginEvents(
      makeEventRequest(),
      secondResponse as unknown as http.ServerResponse,
      createConfig(),
      resolveProvider,
    );

    expect(loginCalls).toBe(2);
    expect(firstResponse.writes.join("")).toContain("event: prompt");
    expect(firstResponse.writes.join("")).toContain("event: success");
    expect(secondResponse.writes.join("")).toContain("event: success");
  });
});
