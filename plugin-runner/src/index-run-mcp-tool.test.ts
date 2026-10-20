import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { Readable } from "stream";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/client";
import type { McpCallOptions } from "./mcp-client.js";
import { ASYNC_TIMEOUT_MS, TOOL_TIMEOUT_MS } from "./script-runner.js";

const { connectMock, callToolMock, postCallbackMock, loadBundlesMock, findBundleMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  callToolMock: vi.fn(),
  postCallbackMock: vi.fn(),
  loadBundlesMock: vi.fn(),
  findBundleMock: vi.fn(),
}));

vi.mock("./mcp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client.js")>();
  return { ...actual, connect: connectMock, callTool: callToolMock };
});

vi.mock("./script-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./script-runner.js")>();
  return { ...actual, postCallback: postCallbackMock };
});

vi.mock("./bundle-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundle-registry.js")>();
  return { ...actual, loadBundles: loadBundlesMock, findBundle: findBundleMock };
});

import { handleRunTool } from "./index.js";

const BUNDLE_NAME = "mcp-plugin";
const TOOL_NAME = "search";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-mcp-run-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeMcpBundle(bundleDir: string): unknown {
  return {
    bundleDir,
    manifest: { name: BUNDLE_NAME, description: "Test MCP plugin", type: "mcp" },
    type: "mcp",
    tools: [
      {
        toolDir: bundleDir,
        manifest: {
          name: TOOL_NAME,
          description: "Search",
          entrypoint: "",
          async: true,
          parameters: {},
        },
      },
    ],
    permissions: ["*"],
  };
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

function callResult(content: unknown[], extra: Record<string, unknown> = {}): CallToolResult {
  return { content, ...extra } as unknown as CallToolResult;
}

let bundleDir: string;

beforeEach(() => {
  vi.useFakeTimers();

  connectMock.mockReset();
  connectMock.mockResolvedValue({ tools: [], instructions: undefined });
  callToolMock.mockReset();
  postCallbackMock.mockReset();
  loadBundlesMock.mockReset();
  findBundleMock.mockReset();

  bundleDir = makeTempDir();
  fs.writeFileSync(path.join(bundleDir, "config.json"), JSON.stringify({ permissions: ["*"] }));
  findBundleMock.mockReturnValue(makeMcpBundle(bundleDir));
});

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("handleRunTool for MCP bundles", () => {
  it("returns 200 with the translated result when the call finishes quickly", async () => {
    callToolMock.mockResolvedValue(callResult([{ type: "text", text: "hello" }]));

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({ query: "hello" }),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true, output: "hello" });
    expect(postCallbackMock).not.toHaveBeenCalled();

    expect(callToolMock).toHaveBeenCalledTimes(1);
    const [calledBundle, calledTool, calledArgs, calledOptions] = callToolMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      McpCallOptions,
    ];
    expect(calledBundle).toBe(BUNDLE_NAME);
    expect(calledTool).toBe(TOOL_NAME);
    expect(calledArgs).toEqual({ query: "hello" });
    expect(calledOptions.timeoutMs).toBe(ASYNC_TIMEOUT_MS);
    expect(calledOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("includes translated files in the synchronous response", async () => {
    callToolMock.mockResolvedValue(
      callResult([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]),
    );

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      success: true,
      output: "",
      files: [{ filename: "image-1.png", data: "aW1hZ2U=" }],
    });
  });

  it("returns 500 when the tool reports an error", async () => {
    callToolMock.mockResolvedValue(callResult([{ type: "text", text: "bad input" }], { isError: true }));

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ success: false, error: "bad input" });
    expect(postCallbackMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the call fails within the sync window", async () => {
    callToolMock.mockRejectedValue(new Error("connection dropped"));

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ success: false, error: "connection dropped" });
  });

  it("rejects a disabled MCP plugin without starting its server", async () => {
    fs.writeFileSync(path.join(bundleDir, "config.json"), JSON.stringify({ permissions: [] }));

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({ query: "hello" }),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "Plugin is disabled" });
    expect(connectMock).not.toHaveBeenCalled();
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("rejects a non-permitted MCP tool without starting its server", async () => {
    fs.writeFileSync(path.join(bundleDir, "config.json"), JSON.stringify({ permissions: ["other"] }));

    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({ query: "hello" }),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "Tool not permitted" });
    expect(connectMock).not.toHaveBeenCalled();
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a JSON object", async () => {
    const response = makeResponse();
    await handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest([{ query: "batched" }]),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(400);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("responds 202 and posts the result when the call outlives the sync window", async () => {
    let resolveCall: (result: CallToolResult) => void = () => undefined;
    callToolMock.mockReturnValue(
      new Promise<CallToolResult>((resolve) => {
        resolveCall = resolve;
      }),
    );

    let resolveCallback: (args: unknown[]) => void = () => undefined;
    const callbackCalled = new Promise<unknown[]>((resolve) => {
      resolveCallback = resolve;
    });
    postCallbackMock.mockImplementation(async (...args: unknown[]): Promise<void> => {
      resolveCallback(args);
    });

    const response = makeResponse();
    const runPromise = handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({ query: "slow" }),
      response as unknown as http.ServerResponse,
    );

    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await runPromise;

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ status: "running" });
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(postCallbackMock).not.toHaveBeenCalled();

    resolveCall(callResult([{ type: "text", text: "late result" }]));
    const callbackArgs = await callbackCalled;

    expect(callbackArgs[0]).toBe(`plugin:${BUNDLE_NAME}/${TOOL_NAME}`);
    expect(callbackArgs[1]).toBe(
      `The run of tool "${TOOL_NAME}" (plugin "${BUNDLE_NAME}") returned:\n\`\`\`\nlate result\n\`\`\``,
    );
    expect(callbackArgs[2]).toEqual([]);
  });

  it("posts a timeout failure when the call never completes", async () => {
    callToolMock.mockImplementation(
      (
        _bundle: string,
        _tool: string,
        _args: Record<string, unknown>,
        options: McpCallOptions,
      ): Promise<CallToolResult> =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    let resolveCallback: (args: unknown[]) => void = () => undefined;
    const callbackCalled = new Promise<unknown[]>((resolve) => {
      resolveCallback = resolve;
    });
    postCallbackMock.mockImplementation(async (...args: unknown[]): Promise<void> => {
      resolveCallback(args);
    });

    const response = makeResponse();
    const runPromise = handleRunTool(
      BUNDLE_NAME,
      TOOL_NAME,
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await runPromise;

    expect(response.statusCode).toBe(202);

    await vi.advanceTimersByTimeAsync(ASYNC_TIMEOUT_MS - TOOL_TIMEOUT_MS);
    const callbackArgs = await callbackCalled;

    expect(callbackArgs[0]).toBe(`plugin:${BUNDLE_NAME}/${TOOL_NAME}`);
    expect(callbackArgs[1]).toBe(
      `The run of tool "${TOOL_NAME}" (plugin "${BUNDLE_NAME}") failed:\n\`\`\`\nTool "${TOOL_NAME}" (plugin "${BUNDLE_NAME}") exceeded the timeout of ${ASYNC_TIMEOUT_MS / 1000} seconds\n\`\`\``,
    );
  });
});
