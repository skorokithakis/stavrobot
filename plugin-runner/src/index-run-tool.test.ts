import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import http from "http";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type { ScriptResult } from "./script-runner.js";

const { runScriptMock, findBundleMock, postCallbackMock, createdRunDirs } = vi.hoisted(() => ({
  runScriptMock: vi.fn(),
  findBundleMock: vi.fn(),
  postCallbackMock: vi.fn(),
  createdRunDirs: [] as string[],
}));

vi.mock("./script-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./script-runner.js")>();
  return {
    ...actual,
    runScript: runScriptMock,
    postCallback: postCallbackMock,
    createRunTempDir: (uid: number, gid: number, baseDir?: string): string => {
      const runTempDir = actual.createRunTempDir(uid, gid, baseDir);
      createdRunDirs.push(runTempDir);
      return runTempDir;
    },
  };
});

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
  return {
    ...actual,
    loadBundles: (): void => undefined,
    findBundle: findBundleMock,
  };
});

import {
  buildScriptEnv,
  createRunTempDir,
  removeLegacyPluginTempDir,
  removeStaleRunTempDirs,
} from "./script-runner.js";
import { handleRunTool } from "./index.js";

const TEST_PLUGIN_NAME = "plugin-runner-test-plugin";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-run-test-"));
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

function makeBundle(toolDir: string, async: boolean): unknown {
  return {
    bundleDir: toolDir,
    manifest: { name: TEST_PLUGIN_NAME, description: "Test plugin" },
    tools: [
      {
        toolDir,
        manifest: {
          name: "convert",
          description: "Test tool",
          entrypoint: "run.sh",
          async,
          parameters: {
            input: { type: "file", description: "Input file" },
          },
        },
      },
    ],
    permissions: ["*"],
  };
}

function fileParam(contents: string): { filename: string; data: string } {
  return { filename: "input.txt", data: Buffer.from(contents).toString("base64") };
}

beforeEach(() => {
  runScriptMock.mockReset();
  findBundleMock.mockReset();
  postCallbackMock.mockReset();
  createdRunDirs.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("handleRunTool run isolation", () => {
  it("gives overlapping runs of one plugin separate input and output files", async () => {
    const toolDir = makeTempDir();
    findBundleMock.mockReturnValue(makeBundle(toolDir, false));

    // Both fake runs start before either is allowed to finish, so the test
    // fails if the runs share a directory.
    let startedCount = 0;
    let releaseRuns: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });

    const inputContentsSeen: string[] = [];
    const runTempDirsSeen: string[] = [];

    runScriptMock.mockImplementation(
      async (
        _entrypoint: string,
        _cwd: string,
        _uid: number,
        _gid: number,
        stdin: string,
        _timeoutMs: number,
        runTempDir: string,
      ): Promise<ScriptResult> => {
        const params = JSON.parse(stdin) as { input: string };
        const inputContents = fs.readFileSync(params.input, "utf-8");
        inputContentsSeen.push(inputContents);
        runTempDirsSeen.push(runTempDir);

        // While this run is in progress, its directory holds only its own input.
        expect(fs.readdirSync(runTempDir)).toEqual(["input.txt"]);

        startedCount++;
        if (startedCount === 2) {
          releaseRuns();
        }
        await bothStarted;

        fs.writeFileSync(path.join(runTempDir, `output-${inputContents}.txt`), `out-${inputContents}`);
        return { success: true, output: `done ${inputContents}` };
      },
    );

    const contents = ["alpha", "beta"];
    const responses = await Promise.all(
      contents.map((inputContents) => {
        const response = makeResponse();
        return handleRunTool(
          TEST_PLUGIN_NAME,
          "convert",
          makeRequest({ input: fileParam(inputContents) }),
          response as unknown as http.ServerResponse,
        ).then(() => response);
      }),
    );

    expect(inputContentsSeen.sort()).toEqual(["alpha", "beta"]);
    expect(new Set(runTempDirsSeen).size).toBe(2);

    for (let index = 0; index < responses.length; index++) {
      const response = responses[index];
      const inputContents = contents[index];
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body) as {
        success: boolean;
        output: string;
        files: { filename: string; data: string }[];
      };
      expect(body.success).toBe(true);
      expect(body.output).toBe(`done ${inputContents}`);
      // The input file stays in the run directory and is transported too, as
      // before; what matters is that nothing from the other run leaks in.
      expect(body.files.map((file) => file.filename).sort()).toEqual(
        ["input.txt", `output-${inputContents}.txt`].sort(),
      );
      const filesByName = new Map(body.files.map((file) => [file.filename, file.data]));
      expect(Buffer.from(filesByName.get("input.txt") as string, "base64").toString("utf-8")).toBe(
        inputContents,
      );
      expect(
        Buffer.from(filesByName.get(`output-${inputContents}.txt`) as string, "base64").toString("utf-8"),
      ).toBe(`out-${inputContents}`);
    }

    for (const runTempDir of runTempDirsSeen) {
      expect(fs.existsSync(runTempDir)).toBe(false);
    }
  });

  it("rejects an input filename that escapes the run temp directory", async () => {
    const toolDir = makeTempDir();
    findBundleMock.mockReturnValue(makeBundle(toolDir, false));

    const response = makeResponse();
    await handleRunTool(
      TEST_PLUGIN_NAME,
      "convert",
      makeRequest({ input: { filename: "../escaped.txt", data: Buffer.from("x").toString("base64") } }),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'Invalid filename in file parameter "input"' });
    expect(runScriptMock).not.toHaveBeenCalled();
  });
});

describe("handleRunTool run cleanup", () => {
  it("removes the run directory after a successful async run and sends its files in the callback", async () => {
    const toolDir = makeTempDir();
    findBundleMock.mockReturnValue(makeBundle(toolDir, true));

    let runTempDir: string | undefined;
    runScriptMock.mockImplementation(
      async (
        _entrypoint: string,
        _cwd: string,
        _uid: number,
        _gid: number,
        _stdin: string,
        _timeoutMs: number,
        tempDir: string,
      ): Promise<ScriptResult> => {
        runTempDir = tempDir;
        fs.writeFileSync(path.join(tempDir, "result.txt"), "result");
        return { success: true, output: "done" };
      },
    );

    let resolveCallback: (args: unknown[]) => void = () => undefined;
    const callbackCalled = new Promise<unknown[]>((resolve) => {
      resolveCallback = resolve;
    });
    postCallbackMock.mockImplementation(async (...args: unknown[]): Promise<void> => {
      resolveCallback(args);
    });

    const response = makeResponse();
    await handleRunTool(
      TEST_PLUGIN_NAME,
      "convert",
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(202);
    const callbackArgs = await callbackCalled;
    expect(callbackArgs[0]).toBe(`plugin:${TEST_PLUGIN_NAME}/convert`);
    expect(callbackArgs[1]).toContain("done");
    expect(callbackArgs[2]).toEqual([
      { filename: "result.txt", data: Buffer.from("result").toString("base64") },
    ]);
    expect(fs.existsSync(runTempDir as string)).toBe(false);
  });

  it("removes the run directory when a sync script fails", async () => {
    const toolDir = makeTempDir();
    findBundleMock.mockReturnValue(makeBundle(toolDir, false));

    let runTempDir: string | undefined;
    runScriptMock.mockImplementation(
      async (
        _entrypoint: string,
        _cwd: string,
        _uid: number,
        _gid: number,
        _stdin: string,
        _timeoutMs: number,
        tempDir: string,
      ): Promise<ScriptResult> => {
        runTempDir = tempDir;
        return { success: false, output: "boom", error: "boom" };
      },
    );

    const response = makeResponse();
    await handleRunTool(
      TEST_PLUGIN_NAME,
      "convert",
      makeRequest({}),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ success: false, error: "boom" });
    expect(fs.existsSync(runTempDir as string)).toBe(false);
  });

  it("removes the run directory when parameter validation fails", async () => {
    const toolDir = makeTempDir();
    findBundleMock.mockReturnValue(makeBundle(toolDir, false));

    const response = makeResponse();
    await handleRunTool(
      TEST_PLUGIN_NAME,
      "convert",
      makeRequest({ notAParameter: "value" }),
      response as unknown as http.ServerResponse,
    );

    expect(response.statusCode).toBe(400);
    expect(runScriptMock).not.toHaveBeenCalled();
    expect(createdRunDirs).toHaveLength(1);
    expect(fs.existsSync(createdRunDirs[0])).toBe(false);
  });
});

describe("run temp directory lifecycle", () => {
  it("creates unique directories with mode 700", () => {
    const baseDir = makeTempDir();
    const first = createRunTempDir(process.getuid?.() ?? 0, process.getgid?.() ?? 0, baseDir);
    const second = createRunTempDir(process.getuid?.() ?? 0, process.getgid?.() ?? 0, baseDir);

    expect(first).not.toBe(second);
    expect(fs.statSync(first).mode & 0o777).toBe(0o700);
    expect(fs.statSync(second).mode & 0o777).toBe(0o700);
    expect(fs.statSync(first).uid).toBe(process.getuid?.() ?? 0);
    expect(fs.statSync(first).gid).toBe(process.getgid?.() ?? 0);
  });

  it("removes stale run directories but leaves other directories alone", () => {
    const baseDir = makeTempDir();
    const staleRunDir = path.join(baseDir, "stavrobot-run-stale");
    const unrelatedDir = path.join(baseDir, "some-plugin");
    fs.mkdirSync(staleRunDir);
    fs.mkdirSync(unrelatedDir);

    removeStaleRunTempDirs(baseDir);

    expect(fs.existsSync(staleRunDir)).toBe(false);
    expect(fs.existsSync(unrelatedDir)).toBe(true);
  });

  it("warns and removes the legacy plugin temp directory without transporting it", () => {
    const baseDir = makeTempDir();
    const legacyDir = path.join(baseDir, "my-plugin");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "old-output.txt"), "old");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    removeLegacyPluginTempDir("my-plugin", baseDir);

    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STAVROBOT_TEMP_DIR"));
  });

  it("warns and removes a legacy path that is a regular file", () => {
    const baseDir = makeTempDir();
    const legacyPath = path.join(baseDir, "my-plugin");
    fs.writeFileSync(legacyPath, "not a directory");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    removeLegacyPluginTempDir("my-plugin", baseDir);

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STAVROBOT_TEMP_DIR"));
  });

  it("warns and removes a legacy path that is a symlink without touching its target", () => {
    const baseDir = makeTempDir();
    const targetDir = makeTempDir();
    fs.writeFileSync(path.join(targetDir, "keep.txt"), "keep");
    const legacyPath = path.join(baseDir, "my-plugin");
    fs.symlinkSync(targetDir, legacyPath);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    removeLegacyPluginTempDir("my-plugin", baseDir);

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, "keep.txt"), "utf-8")).toBe("keep");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("STAVROBOT_TEMP_DIR"));
  });
});

describe("buildScriptEnv", () => {
  it("passes the run temp directory as STAVROBOT_TEMP_DIR", () => {
    const env = buildScriptEnv("/cache/plugin/uv", "/cache/plugin/home", "/tmp/stavrobot-run-abc");

    expect(env["STAVROBOT_TEMP_DIR"]).toBe("/tmp/stavrobot-run-abc");
  });

  it("does not set STAVROBOT_TEMP_DIR for init scripts", () => {
    const env = buildScriptEnv("/cache/plugin/uv", "/cache/plugin/home");

    expect(env).not.toHaveProperty("STAVROBOT_TEMP_DIR");
  });
});
