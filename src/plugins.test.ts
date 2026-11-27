import http from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { initInternalFetch } from "./internal-fetch.js";
import {
  handlePluginAddMcpRequest,
  handlePluginConfigRequest,
  servePluginsPage,
} from "./plugins.js";

// Initialize internalFetch with a dummy password so tests can call the proxy
// handlers without going through main(). Tests stub the global fetch.
initInternalFetch("test-password");

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

function mockFetch(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(body),
    }),
  );
}

function makeMockRequest(
  body: string,
  headers: http.IncomingHttpHeaders = { "content-type": "application/json" },
): http.IncomingMessage {
  return {
    headers,
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer, void, unknown> {
      yield Buffer.from(body);
    },
  } as unknown as http.IncomingMessage;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
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

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe("handlePluginConfigRequest", (): void => {
  it("returns per-key set flags and schema without any config values", async (): Promise<void> => {
    mockFetch(
      200,
      JSON.stringify({
        schema: {
          serverUrl: { description: "The server address.", required: true },
          apiKey: { description: "The API key.", required: true },
          defaultCalendar: { description: "Calendar to use.", required: false },
        },
        values: {
          serverUrl: "https://dav.example.com/",
          apiKey: "super-secret-token",
          permissions: ["*"],
        },
      }),
    );
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "caldav",
      "test-password",
    );

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body!);
    expect(parsed.schema).toEqual({
      serverUrl: { description: "The server address.", required: true, type: "secret" },
      apiKey: { description: "The API key.", required: true, type: "secret" },
      defaultCalendar: { description: "Calendar to use.", required: false, type: "secret" },
    });
    expect(parsed.set).toEqual({ serverUrl: true, apiKey: true, defaultCalendar: false });
    expect(parsed.values).toEqual({});
    expect(response.body).not.toContain("super-secret-token");
    expect(response.body).not.toContain("dav.example.com");
    expect(response.body).not.toContain("permissions");
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  it("passes types through and returns values only for non-secret fields", async (): Promise<void> => {
    mockFetch(
      200,
      JSON.stringify({
        schema: {
          region: { description: "Region.", required: false, type: "text" },
          username: { description: "Username.", required: false, type: "text" },
          missingUsername: { description: "Unset username.", required: false, type: "text" },
          apiKey: { description: "API key.", required: true },
          booleanFlag: { description: "Boolean flag.", required: false, type: "boolean" },
          count: { description: "Count.", required: false, type: "number" },
          mode: { description: "Mode.", required: false, type: "select", options: ["fast", "slow"] },
          unknownType: { description: "Unknown type.", required: false, type: "colour" },
          brokenSelect: { description: "Broken select.", required: false, type: "select", options: [] },
          emptyOptionSelect: {
            description: "Empty option select.",
            required: false,
            type: "select",
            options: ["fast", ""],
          },
        },
        values: {
          region: "eu-west-1",
          username: "stavros",
          apiKey: "key-secret-value",
          booleanFlag: true,
          count: 3,
          mode: "fast",
          unknownType: "unknown-secret-value",
          brokenSelect: "broken-secret-value",
          emptyOptionSelect: "empty-option-secret-value",
        },
      }),
    );
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "calendar",
      "test-password",
    );

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body!);
    expect(parsed.schema).toEqual({
      region: { description: "Region.", required: false, type: "text" },
      username: { description: "Username.", required: false, type: "text" },
      missingUsername: { description: "Unset username.", required: false, type: "text" },
      apiKey: { description: "API key.", required: true, type: "secret" },
      booleanFlag: { description: "Boolean flag.", required: false, type: "boolean" },
      count: { description: "Count.", required: false, type: "number" },
      mode: { description: "Mode.", required: false, type: "select", options: ["fast", "slow"] },
      unknownType: { description: "Unknown type.", required: false, type: "secret" },
      brokenSelect: { description: "Broken select.", required: false, type: "secret" },
      emptyOptionSelect: { description: "Empty option select.", required: false, type: "secret" },
    });
    expect(parsed.set).toEqual({
      region: true,
      username: true,
      missingUsername: false,
      apiKey: true,
      booleanFlag: true,
      count: true,
      mode: true,
      unknownType: true,
      brokenSelect: true,
      emptyOptionSelect: true,
    });
    expect(parsed.values).toEqual({
      region: "eu-west-1",
      username: "stavros",
      booleanFlag: true,
      count: 3,
      mode: "fast",
    });
    const secretValues = [
      "key-secret-value",
      "unknown-secret-value",
      "broken-secret-value",
      "empty-option-secret-value",
    ];
    for (const secretValue of secretValues) {
      expect(response.body).not.toContain(secretValue);
    }
  });

  it("defaults the type to secret when the manifest omits it", async (): Promise<void> => {
    mockFetch(
      200,
      JSON.stringify({
        schema: { region: { description: "Region.", required: false } },
        values: { region: "eu-west-1" },
      }),
    );
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "calendar",
      "test-password",
    );

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body!);
    expect(parsed.schema.region.type).toBe("secret");
    expect(parsed.values).toEqual({});
    expect(response.body).not.toContain("eu-west-1");
  });

  it("drops manifest defaults so they never reach the browser", async (): Promise<void> => {
    mockFetch(
      200,
      JSON.stringify({
        schema: { apiKey: { description: "Key.", required: false, default: "leaked-default" } },
        values: {},
      }),
    );
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "weather",
      "test-password",
    );

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body!);
    expect(parsed.schema.apiKey).toEqual({ description: "Key.", required: false, type: "secret" });
    expect(parsed.set).toEqual({ apiKey: false });
    expect(parsed.values).toEqual({});
    expect(response.body).not.toContain("leaked-default");
  });

  it("passes through plugin-runner errors without transforming them", async (): Promise<void> => {
    mockFetch(404, JSON.stringify({ error: "Bundle not found" }));
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "missing",
      "test-password",
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(JSON.stringify({ error: "Bundle not found" }));
  });

  it("fails with a clear error when the server password is not configured", async (): Promise<void> => {
    const response = makeMockResponse();

    await handlePluginConfigRequest(
      response as unknown as http.ServerResponse,
      "caldav",
      undefined,
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body!).error).toContain("password");
  });
});

describe("handlePluginAddMcpRequest", (): void => {
  it("forwards the request body to the plugin-runner add-mcp endpoint", async (): Promise<void> => {
    const responseBody = JSON.stringify({
      message: "MCP server plugin 'example' added successfully.",
      warnings: [],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve(responseBody),
    });
    vi.stubGlobal("fetch", fetchMock);
    const requestBody = JSON.stringify({
      name: "example",
      description: "An example MCP server.",
      server: { command: "npx", args: ["-y", "@example/mcp-server"] },
    });
    const response = makeMockResponse();

    await handlePluginAddMcpRequest(
      makeMockRequest(requestBody),
      response as unknown as http.ServerResponse,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://plugin-runner:3003/add-mcp",
      expect.objectContaining({
        method: "POST",
        body: requestBody,
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(responseBody);
  });

  it.each([
    { label: "a non-JSON content type", headers: { "content-type": "application/x-www-form-urlencoded" } },
    { label: "a missing content type", headers: {} },
  ])("rejects $label without forwarding the request", async ({ headers }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = makeMockResponse();

    await handlePluginAddMcpRequest(
      makeMockRequest(
        JSON.stringify({ name: "example", description: "An example.", server: { command: "npx" } }),
        headers,
      ),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.body!)).toEqual({ error: "Content-Type must be application/json" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("servePluginsPage", (): void => {
  it("escapes the plugin connection error in the detail view", (): void => {
    const response = makeMockResponse();

    servePluginsPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain("esc(plugin.error)");
  });
});
