import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { Readable } from "stream";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const { connectMock, disconnectMock, loadBundlesMock, findBundleMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  loadBundlesMock: vi.fn(),
  findBundleMock: vi.fn(),
}));

vi.mock("./mcp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client.js")>();
  return { ...actual, connect: connectMock, disconnect: disconnectMock };
});

vi.mock("./plugin-user.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-user.js")>();
  return {
    ...actual,
    ensurePluginUser: (): { uid: number; gid: number } => ({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    }),
    getPluginUserIds: (): { uid: number; gid: number } => ({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    }),
  };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

vi.mock("./bundle-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundle-registry.js")>();
  return { ...actual, loadBundles: loadBundlesMock, findBundle: findBundleMock };
});

import { handleAddMcp, handleConfigure } from "./plugin-lifecycle.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeResponse {
  statusCode: number;
  body: string;
  writeHead(code: number): void;
  end(body: string): void;
}

function makeResponse(): FakeResponse {
  return {
    statusCode: 0,
    body: "",
    writeHead(code: number): void {
      this.statusCode = code;
    },
    end(body: string): void {
      this.body = body;
    },
  };
}

function makeRequest(body: unknown): http.IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
}

beforeEach(() => {
  connectMock.mockReset();
  disconnectMock.mockReset();
  loadBundlesMock.mockReset();
  findBundleMock.mockReset();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("handleAddMcp", () => {
  it("writes the manifest and config, connects, and reports the tools", async () => {
    connectMock.mockResolvedValue({
      tools: [
        {
          name: "search",
          description: "Search",
          entrypoint: "",
          async: true,
          parameters: {},
        },
      ],
      instructions: "Use search carefully.",
    });

    const pluginsDir = makeTempDir();
    const response = makeResponse();

    await handleAddMcp(
      makeRequest({
        name: "my-mcp",
        description: "Test MCP server",
        server: { command: "npx", args: ["-y", "@example/mcp-server"], env: { TOKEN: "secret" } },
      }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { message: string; warnings: string[] };
    expect(body.warnings).toEqual([]);
    expect(body.message).toContain("my-mcp");
    expect(body.message).toContain("search");

    const bundleDir = path.join(pluginsDir, "my-mcp");
    expect(readJson(path.join(bundleDir, "manifest.json"))).toEqual({
      name: "my-mcp",
      description: "Test MCP server",
      type: "mcp",
      config: { server: { description: "MCP server spec (JSON)", required: true } },
      instructions: "Use search carefully.",
    });
    expect(readJson(path.join(bundleDir, "config.json"))).toEqual({
      permissions: ["*"],
      server: { command: "npx", args: ["-y", "@example/mcp-server"], env: { TOKEN: "secret" } },
    });
    expect(fs.statSync(bundleDir).mode & 0o777).toBe(0o700);
    expect(connectMock).toHaveBeenCalledWith("my-mcp");
  });

  it("keeps the plugin and warns when the server cannot be connected to", async () => {
    connectMock.mockRejectedValue(new Error("spawn setpriv ENOENT"));

    const pluginsDir = makeTempDir();
    const response = makeResponse();

    await handleAddMcp(
      makeRequest({
        name: "broken-mcp",
        description: "Broken",
        server: { url: "https://example.com/mcp" },
      }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { message: string; warnings: string[] };
    expect(body.message).toContain("added successfully");
    expect(body.warnings).toEqual(["Could not connect to the MCP server: spawn setpriv ENOENT"]);
    expect(fs.existsSync(path.join(pluginsDir, "broken-mcp", "manifest.json"))).toBe(true);
  });

  it("does not follow a symlinked manifest.json when storing instructions", async () => {
    const pluginsDir = makeTempDir();
    const targetDir = makeTempDir();
    const target = path.join(targetDir, "root-only.json");
    fs.writeFileSync(target, JSON.stringify({ secret: "do-not-copy" }));

    connectMock.mockImplementation(async () => {
      const manifestPath = path.join(pluginsDir, "symlink-mcp", "manifest.json");
      fs.rmSync(manifestPath);
      fs.symlinkSync(target, manifestPath);
      return { tools: [], instructions: "New instructions" };
    });

    const response = makeResponse();
    await handleAddMcp(
      makeRequest({ name: "symlink-mcp", description: "Sneaky", server: { command: "npx" } }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(readJson(target)).toEqual({ secret: "do-not-copy" });
    expect(fs.existsSync(path.join(pluginsDir, "symlink-mcp", "manifest.json"))).toBe(false);
  });

  it("rejects an invalid server spec without creating the plugin", async () => {
    const pluginsDir = makeTempDir();
    const response = makeResponse();

    await handleAddMcp(
      makeRequest({ name: "bad-mcp", description: "Bad", server: { command: "npx", url: "https://x" } }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.stringContaining("not both") });
    expect(fs.existsSync(path.join(pluginsDir, "bad-mcp"))).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid plugin name", async () => {
    const pluginsDir = makeTempDir();
    const response = makeResponse();

    await handleAddMcp(
      makeRequest({ name: "Bad_Name", description: "Bad", server: { command: "npx" } }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(response.statusCode).toBe(400);
    expect(fs.existsSync(path.join(pluginsDir, "Bad_Name"))).toBe(false);
  });

  it("rejects a name that already exists", async () => {
    const pluginsDir = makeTempDir();
    fs.mkdirSync(path.join(pluginsDir, "taken"));
    const response = makeResponse();

    await handleAddMcp(
      makeRequest({ name: "taken", description: "Existing", server: { command: "npx" } }),
      response as unknown as http.ServerResponse,
      readRequestBody,
      pluginsDir,
    );

    expect(response.statusCode).toBe(409);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("handleConfigure for MCP bundles", () => {
  function makeMcpBundle(bundleDir: string): unknown {
    return {
      bundleDir,
      manifest: {
        name: "my-mcp",
        description: "Test MCP server",
        type: "mcp",
        config: { server: { description: "MCP server spec (JSON)", required: true } },
      },
      type: "mcp",
      tools: [],
      permissions: ["*"],
    };
  }

  it("parses a string server spec, stores it as an object, and disconnects", async () => {
    const bundleDir = makeTempDir();
    fs.writeFileSync(
      path.join(bundleDir, "config.json"),
      JSON.stringify({ permissions: ["*"], server: { command: "npx" } }, null, 2),
    );
    findBundleMock.mockReturnValue(makeMcpBundle(bundleDir));

    const response = makeResponse();
    await handleConfigure(
      makeRequest({
        name: "my-mcp",
        config: { server: '{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer token"}}' },
      }),
      response as unknown as http.ServerResponse,
      readRequestBody,
    );

    expect(response.statusCode).toBe(200);
    expect(readJson(path.join(bundleDir, "config.json"))).toEqual({
      permissions: ["*"],
      server: { url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } },
    });
    expect(disconnectMock).toHaveBeenCalledWith("my-mcp");
  });

  it("returns a fixed message when the server string is not valid JSON", async () => {
    const bundleDir = makeTempDir();
    const originalConfig = { permissions: ["*"], server: { command: "npx" } };
    fs.writeFileSync(path.join(bundleDir, "config.json"), JSON.stringify(originalConfig, null, 2));
    findBundleMock.mockReturnValue(makeMcpBundle(bundleDir));

    const response = makeResponse();
    await handleConfigure(
      makeRequest({
        name: "my-mcp",
        config: { server: '{"headers":{"Authorization":"Bearer secret-token"}, oops' },
      }),
      response as unknown as http.ServerResponse,
      readRequestBody,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "Invalid server spec: 'server' is not valid JSON",
    });
    expect(response.body).not.toContain("secret-token");
    expect(readJson(path.join(bundleDir, "config.json"))).toEqual(originalConfig);
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid server spec and leaves the config and connection alone", async () => {
    const bundleDir = makeTempDir();
    const originalConfig = { permissions: ["*"], server: { command: "npx" } };
    fs.writeFileSync(path.join(bundleDir, "config.json"), JSON.stringify(originalConfig, null, 2));
    findBundleMock.mockReturnValue(makeMcpBundle(bundleDir));

    const response = makeResponse();
    await handleConfigure(
      makeRequest({ name: "my-mcp", config: { server: '{"command":""}' } }),
      response as unknown as http.ServerResponse,
      readRequestBody,
    );

    expect(response.statusCode).toBe(400);
    expect(readJson(path.join(bundleDir, "config.json"))).toEqual(originalConfig);
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
