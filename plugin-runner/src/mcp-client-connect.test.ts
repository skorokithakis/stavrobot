import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { TOOL_TIMEOUT_MS } from "./script-runner.js";

const { FakeClient, FakeTransport, clientInstances, transportInstances } = vi.hoisted(() => {
  let nextClientId = 0;

  class FakeClient {
    static nextConnectGate: Promise<void> | undefined = undefined;

    id = nextClientId++;
    connectGate: Promise<void> | undefined = FakeClient.nextConnectGate;
    callToolError: Error | undefined = undefined;
    callToolCalls = 0;
    closed = false;

    constructor(_clientInfo: unknown) {
      FakeClient.nextConnectGate = undefined;
      clientInstances.push(this);
    }

    async connect(_transport: unknown): Promise<void> {
      if (this.connectGate !== undefined) {
        await this.connectGate;
      }
    }

    async listTools(): Promise<{
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { type: string; properties: Record<string, never> };
      }>;
    }> {
      return {
        tools: [
          {
            name: `tool-${this.id}`,
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }

    getInstructions(): string | undefined {
      return undefined;
    }

    async callTool(_params: unknown): Promise<unknown> {
      this.callToolCalls++;
      if (this.callToolError !== undefined) {
        throw this.callToolError;
      }
      return { content: [{ type: "text", text: "ok" }] };
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  class FakeTransport {
    onclose: (() => void) | undefined = undefined;
    onerror: ((error: Error) => void) | undefined = undefined;
    onmessage: unknown = undefined;
    closed = false;

    constructor(_url: unknown, _options?: unknown) {
      transportInstances.push(this);
    }

    async start(): Promise<void> {
      return;
    }

    async send(_message: unknown): Promise<void> {
      return;
    }

    async close(): Promise<void> {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.onclose?.();
    }
  }

  const clientInstances: FakeClient[] = [];
  const transportInstances: FakeTransport[] = [];

  return { FakeClient, FakeTransport, clientInstances, transportInstances };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const fakeFs = {
    ...actual,
    readFileSync: (): string =>
      JSON.stringify({ permissions: ["*"], server: { url: "https://example.com/mcp" } }),
  };
  return { ...fakeFs, default: fakeFs };
});

vi.mock("./plugin-user.js", () => ({
  getPluginUserIds: (): { uid: number; gid: number } => ({ uid: 1000, gid: 1000 }),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return { ...actual, Client: FakeClient, StreamableHTTPClientTransport: FakeTransport };
});

import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { callTool, connect, disconnect, getCachedTools } from "./mcp-client.js";

beforeEach(() => {
  vi.useFakeTimers();
  clientInstances.length = 0;
  transportInstances.length = 0;
  FakeClient.nextConnectGate = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connection recovery", () => {
  it("reconnects after an HTTP 404 from a remote tool call", async () => {
    await connect("remote-404");
    const firstClient = clientInstances[0];
    firstClient.callToolError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Error POSTing to endpoint: Not Found",
      { status: 404 },
    );

    await expect(callTool("remote-404", "tool", {})).rejects.toBeInstanceOf(SdkHttpError);
    expect(firstClient.callToolCalls).toBe(1);

    // The entry was marked disconnected, so the next use builds a new session.
    await connect("remote-404");
    expect(clientInstances).toHaveLength(2);
    expect(getCachedTools("remote-404").map((tool) => tool.name)).toEqual([
      `tool-${clientInstances[1].id}`,
    ]);
  });

  it("closes the transport and clears the entry when connecting times out", async () => {
    let releaseConnect: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    FakeClient.nextConnectGate = gate;

    const connecting = connect("slow-connect");
    const rejection = expect(connecting).rejects.toThrow(
      `Timed out connecting to MCP server for plugin "slow-connect" after ${TOOL_TIMEOUT_MS / 1000} seconds`,
    );

    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await rejection;

    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0].closed).toBe(true);
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].closed).toBe(true);

    // A fresh attempt is not blocked by the timed-out one.
    await connect("slow-connect");
    expect(clientInstances).toHaveLength(2);

    // Let the abandoned attempt finish; it must not disturb the new connection.
    releaseConnect();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("cancels a pending connect on disconnect without replacing the new connection", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    FakeClient.nextConnectGate = gate;

    const firstAttempt = connect("abandoned");
    const abandoned = expect(firstAttempt).rejects.toThrow(
      `MCP connection attempt for plugin "abandoned" was abandoned`,
    );

    await disconnect("abandoned");
    expect(clientInstances[0].closed).toBe(true);
    expect(transportInstances[0].closed).toBe(true);

    // The next connect starts fresh even though the first attempt is still pending.
    await connect("abandoned");
    expect(clientInstances).toHaveLength(2);

    releaseFirst();
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);

    // The abandoned attempt did not replace the new connection's tools.
    expect(getCachedTools("abandoned").map((tool) => tool.name)).toEqual([
      `tool-${clientInstances[1].id}`,
    ]);

    await connect("abandoned");
    expect(clientInstances).toHaveLength(2);
  });
});
