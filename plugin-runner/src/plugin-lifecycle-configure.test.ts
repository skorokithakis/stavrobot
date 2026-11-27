import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { Readable } from "stream";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type { BundleConfigField } from "./bundle-registry.js";

const { findBundleMock } = vi.hoisted(() => ({
  findBundleMock: vi.fn(),
}));

vi.mock("./plugin-user.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-user.js")>();
  return {
    ...actual,
    getPluginUserIds: (): { uid: number; gid: number } => ({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    }),
  };
});

vi.mock("./bundle-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundle-registry.js")>();
  return { ...actual, loadBundles: (): void => undefined, findBundle: findBundleMock };
});

import { handleConfigure } from "./plugin-lifecycle.js";

const PLUGIN_NAME = "my-plugin";

const CONFIG_SCHEMA: Record<string, BundleConfigField> = {
  apiKey: { description: "API key", required: true },
  label: { description: "Label", required: false, secret: false },
  enabled: { description: "Enabled", required: false, type: "boolean" },
  retries: { description: "Retries", required: false, type: "number" },
  mode: { description: "Mode", required: false, type: "select", options: ["fast", "slow"] },
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-configure-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeBundle(bundleDir: string): unknown {
  return {
    bundleDir,
    manifest: {
      name: PLUGIN_NAME,
      description: "Test plugin",
      config: CONFIG_SCHEMA,
    },
    type: "script",
    tools: [],
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

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function configure(
  bundleDir: string,
  config: Record<string, unknown>,
): Promise<FakeResponse> {
  findBundleMock.mockReturnValue(makeBundle(bundleDir));
  const response = makeResponse();
  await handleConfigure(
    makeRequest({ name: PLUGIN_NAME, config }),
    response as unknown as http.ServerResponse,
    readRequestBody,
  );
  return response;
}

beforeEach(() => {
  findBundleMock.mockReset();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("handleConfigure typed value validation", () => {
  // The rejected value may be a secret the user pasted into the chat, so the
  // error must name the key and expected type without echoing it.
  const rejections: Array<[string, unknown, string]> = [
    ["enabled", "not-a-boolean", "boolean"],
    ["retries", "not-a-number", "number"],
    ["mode", "not-an-option", "options"],
  ];

  it.each(rejections)("rejects a bad value for \"%s\" without echoing it", async (key, value, expected) => {
    const bundleDir = makeTempDir();
    const configPath = path.join(bundleDir, "config.json");
    const existingConfig = { permissions: ["*"], apiKey: "existing-secret" };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    const response = await configure(bundleDir, { [key]: value });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toContain(key);
    expect(body.error).toContain(expected);
    expect(response.body).not.toContain(String(value));
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual(existingConfig);
  });

  it("accepts correct typed values and does not type-check secret or text values", async () => {
    const bundleDir = makeTempDir();

    const response = await configure(bundleDir, {
      apiKey: { nested: "object" },
      label: 42,
      enabled: true,
      retries: 2.5,
      mode: "fast",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(bundleDir, "config.json"), "utf-8"))).toEqual({
      apiKey: { nested: "object" },
      label: 42,
      enabled: true,
      retries: 2.5,
      mode: "fast",
    });
  });
});
