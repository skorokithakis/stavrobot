import http from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { initInternalFetch } from "./internal-fetch.js";
import {
  handlePluginConfigRequest,
  handlePluginsListRequest,
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
      serverUrl: { description: "The server address.", required: true },
      apiKey: { description: "The API key.", required: true },
      defaultCalendar: { description: "Calendar to use.", required: false },
    });
    expect(parsed.set).toEqual({ serverUrl: true, apiKey: true, defaultCalendar: false });
    expect(response.body).not.toContain("super-secret-token");
    expect(response.body).not.toContain("dav.example.com");
    expect(response.body).not.toContain("permissions");
    expect(response.headers["Cache-Control"]).toBe("no-store");
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
    expect(parsed.schema.apiKey).toEqual({ description: "Key.", required: false });
    expect(parsed.set).toEqual({ apiKey: false });
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

describe("handlePluginsListRequest", (): void => {
  it("proxies the plugin-runner list response unchanged", async (): Promise<void> => {
    const listBody = JSON.stringify({ plugins: [{ name: "weather", editable: false, permissions: ["*"] }] });
    mockFetch(200, listBody);
    const response = makeMockResponse();

    await handlePluginsListRequest(response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(listBody);
  });
});

describe("servePluginsPage", (): void => {
  it("renders the shared shell with the Plugins navigation active", (): void => {
    const response = makeMockResponse();

    servePluginsPage(response as unknown as http.ServerResponse, makeConfig({ model: "claude-opus-5-5" }));

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain('href="/assets/sb.css"');
    expect(response.body).toContain('class="sb-nav-item is-active" href="/settings/plugins"');
    expect(response.body).toContain("claude-opus-5-5");
    expect(response.body).toContain('class="sb-tabbar"');
  });

  it("renders the install form, list and detail regions and proxy endpoints", (): void => {
    const response = makeMockResponse();

    servePluginsPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain("data-install-form");
    expect(response.body).toContain("data-list-body");
    expect(response.body).toContain('id="plugin-detail"');
    expect(response.body).toContain("/api/settings/plugins/list");
    expect(response.body).toContain("/api/settings/plugins/install");
    expect(response.body).toContain("/api/settings/plugins/configure");
    expect(response.body).toContain("/api/settings/plugins/update");
    expect(response.body).toContain("/api/settings/plugins/remove");
  });

  it("renders confirm feedback in both the desktop popover and the mobile sheet", (): void => {
    const response = makeMockResponse();

    servePluginsPage(response as unknown as http.ServerResponse, makeConfig());

    const matches = response.body!.match(/data-confirm-feedback/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("drives the settings form from set flags instead of config values", (): void => {
    const response = makeMockResponse();

    servePluginsPage(response as unknown as http.ServerResponse, makeConfig());

    expect(response.body).toContain("data-config-input");
    expect(response.body).toContain("Saved values are never shown again. Use Replace to change one.");
    expect(response.body).not.toContain(".values");
    expect(response.body).not.toContain("values[");
  });
});
