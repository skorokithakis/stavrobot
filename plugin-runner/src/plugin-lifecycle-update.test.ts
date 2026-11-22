import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFileSync } from "child_process";
import { Readable } from "stream";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type { BundleManifest, LoadedBundle } from "./bundle-registry.js";
import { GIT_INSTALLED_DIR_NAME } from "./bundle-registry.js";

const { runScriptMock, loadBundlesMock, findBundleMock, postCallbackMock, bundleState } = vi.hoisted(
  () => ({
    runScriptMock: vi.fn(),
    loadBundlesMock: vi.fn(),
    findBundleMock: vi.fn(),
    postCallbackMock: vi.fn(),
    bundleState: { pluginDir: null as string | null, pluginName: "my-plugin" },
  }),
);

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

vi.mock("./script-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./script-runner.js")>();
  return { ...actual, runScript: runScriptMock, postCallback: postCallbackMock };
});

vi.mock("./bundle-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundle-registry.js")>();
  return { ...actual, loadBundles: loadBundlesMock, findBundle: findBundleMock };
});

import { handleUpdate } from "./plugin-lifecycle.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-update-test-"));
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

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function writeManifest(dir: string, manifest: BundleManifest): void {
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function commit(dir: string, message: string): void {
  git(["add", "-A"], dir);
  git(["commit", "-m", message], dir);
}

interface TestRepo {
  pluginsDir: string;
  pluginDir: string;
  originDir: string;
}

function createRepo(initialManifest: BundleManifest): TestRepo {
  const root = makeTempDir();
  const pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);
  const originDir = path.join(root, "origin");
  fs.mkdirSync(originDir);

  git(["init"], originDir);
  git(["config", "user.email", "test@example.com"], originDir);
  git(["config", "user.name", "Test"], originDir);
  writeManifest(originDir, initialManifest);
  commit(originDir, "Initial commit");

  const pluginDir = path.join(pluginsDir, "my-plugin");
  git(["clone", originDir, pluginDir], root);

  fs.mkdirSync(path.join(pluginsDir, GIT_INSTALLED_DIR_NAME), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, GIT_INSTALLED_DIR_NAME, "my-plugin"), "");

  return { pluginsDir, pluginDir, originDir };
}

function updateOrigin(repo: TestRepo, mutate: (dir: string) => void, message: string): string {
  mutate(repo.originDir);
  commit(repo.originDir, message);
  return git(["rev-parse", "HEAD"], repo.originDir);
}

function syncFromOrigin(repo: TestRepo): string {
  git(["fetch", "origin"], repo.pluginDir);
  git(["reset", "--hard", "origin/HEAD"], repo.pluginDir);
  return git(["rev-parse", "HEAD"], repo.pluginDir);
}

beforeEach(() => {
  runScriptMock.mockReset();
  loadBundlesMock.mockReset();
  findBundleMock.mockReset();
  postCallbackMock.mockReset();
  bundleState.pluginDir = null;

  findBundleMock.mockImplementation((name: string): LoadedBundle | null => {
    if (bundleState.pluginDir === null || name !== bundleState.pluginName) {
      return null;
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundleState.pluginDir, "manifest.json"), "utf-8"),
    ) as BundleManifest;
    return {
      bundleDir: bundleState.pluginDir,
      manifest,
      type: "script",
      tools: [],
      permissions: ["*"],
    };
  });
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

async function runUpdate(response: FakeResponse): Promise<void> {
  await handleUpdate(
    makeRequest({ name: "my-plugin" }),
    response as unknown as http.ServerResponse,
    readRequestBody,
  );
}

describe("handleUpdate for git-installed plugins", () => {
  it("returns early without running init, defaults, or instructions when HEAD is unchanged", async () => {
    const repo = createRepo({
      name: "my-plugin",
      description: "Test plugin",
      instructions: "Old setup instructions",
      config: {
        token: { description: "Token", required: false, default: "default-token" },
      },
      init: { entrypoint: "init.sh" },
    });
    fs.writeFileSync(path.join(repo.originDir, "init.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    commit(repo.originDir, "Add init script");
    const head = syncFromOrigin(repo);

    bundleState.pluginDir = repo.pluginDir;
    const response = makeResponse();
    await runUpdate(response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toEqual({
      name: "my-plugin",
      description: "Test plugin",
      changed: false,
      message: `Plugin 'my-plugin' is already up to date (${head.slice(0, 7)}).`,
    });
    expect(body.instructions).toBeUndefined();
    expect(body.init_output).toBeUndefined();
    expect(runScriptMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo.pluginDir, "config.json"))).toBe(false);
  });

  it("recovers when the clone has no origin/HEAD ref and the default branch was renamed", async () => {
    const repo = createRepo({ name: "my-plugin", description: "Test plugin" });
    git(["branch", "-m", "main"], repo.originDir);
    git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo.pluginDir);

    bundleState.pluginDir = repo.pluginDir;
    const response = makeResponse();
    await runUpdate(response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["changed"]).toBe(false);
  });

  it("runs init, applies defaults, and reports the commit range when HEAD changes", async () => {
    const repo = createRepo({
      name: "my-plugin",
      description: "Old description",
      instructions: "Old setup instructions",
      config: {
        token: { description: "Token", required: false, default: "default-token" },
      },
      init: { entrypoint: "init.sh" },
    });
    fs.writeFileSync(path.join(repo.originDir, "init.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    commit(repo.originDir, "Add init script");
    const oldHead = syncFromOrigin(repo);

    const newHead = updateOrigin(
      repo,
      (dir) =>
        writeManifest(dir, {
          name: "my-plugin",
          description: "New description",
          instructions: "New setup instructions",
          config: {
            token: { description: "Token", required: false, default: "default-token" },
          },
          init: { entrypoint: "init.sh" },
        }),
      "Change the plugin",
    );

    runScriptMock.mockResolvedValue({ success: true, output: "init ran\n" });
    bundleState.pluginDir = repo.pluginDir;
    const response = makeResponse();
    await runUpdate(response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["changed"]).toBe(true);
    expect(body["from"]).toBe(oldHead.slice(0, 7));
    expect(body["to"]).toBe(newHead.slice(0, 7));
    expect(body["description"]).toBe("New description");
    expect(body["instructions"]).toBe("New setup instructions");
    expect(body["init_output"]).toBe("init ran\n");
    expect(body["message"]).toContain(`${oldHead.slice(0, 7)}..${newHead.slice(0, 7)}`);
    expect(body["message"]).toContain("Change the plugin");
    expect(body["message"]).toContain("Relay them to the user verbatim");
    expect(runScriptMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(repo.pluginDir, "config.json"), "utf-8"))).toEqual({
      token: "default-token",
    });
  });

  it("does not return unchanged instructions or the relay line", async () => {
    const repo = createRepo({
      name: "my-plugin",
      description: "Old description",
      instructions: "Same setup instructions",
    });

    updateOrigin(
      repo,
      (dir) =>
        writeManifest(dir, {
          name: "my-plugin",
          description: "New description",
          instructions: "Same setup instructions",
        }),
      "Change the description",
    );

    bundleState.pluginDir = repo.pluginDir;
    const response = makeResponse();
    await runUpdate(response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["changed"]).toBe(true);
    expect(body["instructions"]).toBeUndefined();
    expect(body["message"]).not.toContain("Relay them to the user verbatim");
  });

  it("rolls HEAD back when the sync init fails so the next update retries it", async () => {
    const repo = createRepo({
      name: "my-plugin",
      description: "Old description",
      init: { entrypoint: "init.sh" },
    });
    fs.writeFileSync(path.join(repo.originDir, "init.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    commit(repo.originDir, "Add init script");
    const oldHead = syncFromOrigin(repo);

    updateOrigin(
      repo,
      (dir) => {
        writeManifest(dir, {
          name: "my-plugin",
          description: "New description",
          init: { entrypoint: "init.sh" },
        });
        fs.writeFileSync(path.join(dir, "init.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      },
      "Break the init script",
    );

    runScriptMock.mockResolvedValue({ success: false, output: "", error: "boom" });
    bundleState.pluginDir = repo.pluginDir;
    const failedResponse = makeResponse();
    await runUpdate(failedResponse);

    expect(failedResponse.statusCode).toBe(500);
    expect(JSON.parse(failedResponse.body)).toMatchObject({
      error: expect.stringContaining("Init script failed: boom"),
    });
    expect(git(["rev-parse", "HEAD"], repo.pluginDir)).toBe(oldHead);

    runScriptMock.mockResolvedValue({ success: true, output: "init retried\n" });
    const retriedResponse = makeResponse();
    await runUpdate(retriedResponse);

    expect(retriedResponse.statusCode).toBe(200);
    const body = JSON.parse(retriedResponse.body) as Record<string, unknown>;
    expect(body["changed"]).toBe(true);
    expect(runScriptMock).toHaveBeenCalledTimes(2);
  });

  it("caps the changelog at 20 lines and notes the remainder", async () => {
    const repo = createRepo({ name: "my-plugin", description: "Test plugin" });

    for (let index = 1; index <= 25; index++) {
      const label = String(index).padStart(2, "0");
      git(["commit", "--allow-empty", "-m", `Change ${label}`], repo.originDir);
    }

    bundleState.pluginDir = repo.pluginDir;
    const response = makeResponse();
    await runUpdate(response);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const message = body["message"] as string;
    expect(body["changed"]).toBe(true);
    expect(message).toContain("Change 25");
    expect(message).toContain("(more commits not shown.)");
    expect(message).not.toContain("Change 05");
  });
});
