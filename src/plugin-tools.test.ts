import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRunPluginToolTool, createManagePluginsTool, createRequestCodingTaskTool } from "./plugin-tools.js";
import { initInternalFetch } from "./internal-fetch.js";
import fs from "fs/promises";
import path from "path";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";

// Initialize internalFetch with a dummy password so tests can call it without
// going through main(). The actual password value does not matter here because
// tests stub the global fetch and never make real HTTP requests.
initInternalFetch("test-password");

vi.mock("fs/promises", () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from("file content")),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
  },
}));

function mockFetch(status: number, body: string): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    status,
    text: () => Promise.resolve(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchSequence(...responses: Array<{ status: number; body: string }>): void {
  let mock = vi.fn();
  for (const { status, body } of responses) {
    mock = mock.mockResolvedValueOnce({
      status,
      text: () => Promise.resolve(body),
    });
  }
  vi.stubGlobal("fetch", mock);
}

function asText(content: unknown): string {
  return (content as { type: string; text: string }).text;
}

describe("createRunPluginToolTool", () => {
  const tool = createRunPluginToolTool();

  beforeEach(() => {
    vi.mocked(fs.rm).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockClear().mockResolvedValue(Buffer.from("file content") as unknown as string);
    vi.mocked(fs.readdir).mockClear().mockResolvedValue([] as unknown as never[]);
    vi.mocked(fs.stat).mockClear().mockResolvedValue({ size: 0 } as unknown as import("fs").Stats);
  });

  it("rejects invalid plugin and tool names without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const badPlugin = await tool.execute("call-bad-plugin", {
      plugin: "example/config",
      tool: "mytool",
      parameters: "{}",
    });
    expect(asText(badPlugin.content[0])).toBe("Error: invalid plugin name.");

    const badTool = await tool.execute("call-bad-tool", {
      plugin: "myplugin",
      tool: "../../config",
      parameters: "{}",
    });
    expect(asText(badTool.content[0])).toBe("Error: invalid tool name.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "a successful sync result with string output",
      response: { success: true, output: "hello world" },
      expected: 'The run of tool "mytool" (plugin "myplugin") returned:\n```\nhello world\n```',
    },
    {
      description: "a successful sync result with object output as TOON",
      response: { success: true, output: { key: "value" } },
      expected: 'The run of tool "mytool" (plugin "myplugin") returned:\n```\nkey: value\n```',
    },
    {
      description: "a failed sync result with error message",
      response: { success: false, error: "something went wrong" },
      expected: 'The run of tool "mytool" (plugin "myplugin") failed:\n```\nsomething went wrong\n```',
    },
  ])("formats $description", async ({ response, expected }) => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify(response) },
    );
    const result = await tool.execute("call-1", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe(expected);
  });

  it("returns async message for 202 response", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 202, body: JSON.stringify({ status: "running" }) },
    );
    const result = await tool.execute("call-5", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe('Tool "mytool" (plugin "myplugin") is running asynchronously. The result will arrive when it completes.');
  });

  it.each([
    {
      description: "the run response is not valid JSON",
      body: "not json at all",
      expected: "not json at all",
    },
    {
      description: "the JSON does not have a 'success' boolean",
      body: JSON.stringify({ result: "something" }),
      expected: JSON.stringify({ result: "something" }),
    },
  ])("falls back to raw text when $description", async ({ body, expected }) => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body },
    );
    const result = await tool.execute("call-6", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe(expected);
  });

  it("keeps files from an earlier call by writing each call into a new output directory", async () => {
    const fileData = Buffer.from("hello file").toString("base64");
    const runResponse = { status: 200, body: JSON.stringify({ success: true, output: "done", files: [{ filename: "report.txt", data: fileData }] }) };
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      runResponse,
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      runResponse,
    );
    await tool.execute("call-keep-1", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    await tool.execute("call-keep-2", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const writtenPaths = vi.mocked(fs.writeFile).mock.calls.map((call) => String(call[0]));
    expect(writtenPaths).toHaveLength(2);
    expect(writtenPaths[0]).not.toBe(writtenPaths[1]);
    for (const writtenPath of writtenPaths) {
      expect(path.dirname(writtenPath)).toMatch(new RegExp(`^${TEMP_ATTACHMENTS_DIR}/output-[0-9a-f-]{36}$`));
    }
    expect(vi.mocked(fs.rm)).not.toHaveBeenCalled();
  });

  it("saves transported files and appends 'Output files' listing to result", async () => {
    const fileData = Buffer.from("hello file").toString("base64");
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done", files: [{ filename: "report.txt", data: fileData }] }) },
    );
    vi.mocked(fs.readdir).mockResolvedValueOnce(["report.txt"] as unknown as never[]);
    vi.mocked(fs.stat).mockResolvedValueOnce({ size: 1536 } as unknown as import("fs").Stats);
    const result = await tool.execute("call-9", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const expectedDir = String(vi.mocked(fs.mkdir).mock.calls[0][0]);
    expect(expectedDir).toMatch(new RegExp(`^${TEMP_ATTACHMENTS_DIR}/output-[0-9a-f-]{36}$`));
    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
      path.join(expectedDir, "report.txt"),
      Buffer.from(fileData, "base64"),
    );
    expect(asText(result.content[0])).toContain(`\n\nOutput files:\n- ${path.join(expectedDir, "report.txt")} (1.5 KB)`);
  });

  it.each([
    { description: "when files array is empty", response: { success: true, output: "done", files: [] } },
    { description: "when files entries are invalid", response: { success: true, output: "done", files: [{ bad: "entry" }] } },
    { description: "when response has no files field", response: { success: true, output: "done" } },
  ])("does not append 'Output files' $description", async ({ response }) => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify(response) },
    );
    const result = await tool.execute("call-10", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).not.toContain("Output files");
    expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
  });

  it("returns an error when the plugin is not found (404)", async () => {
    mockFetchSequence({ status: 404, body: "Not found" });
    const result = await tool.execute("call-13", { plugin: "missing", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe("Plugin 'missing' not found.");
  });

  it("returns an error when the plugin is disabled (permissions: [])", async () => {
    mockFetchSequence({ status: 200, body: JSON.stringify({ name: "myplugin", permissions: [] }) });
    const result = await tool.execute("call-14", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe("Plugin 'myplugin' not found.");
  });

  it("returns an error when the tool is not in the explicit permissions list", async () => {
    mockFetchSequence({ status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["other_tool"] }) });
    const result = await tool.execute("call-15", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(asText(result.content[0])).toBe("Tool 'mytool' not found on plugin 'myplugin'.");
  });

  it("includes available tools in the error when the manifest has a tools array", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["search", "lookup"],
      tools: [
        { name: "search", parameters: { query: { type: "string" }, count: { type: "integer" } } },
        { name: "lookup", parameters: { id: { type: "string" } } },
        { name: "hidden", parameters: {} },
      ],
    };
    mockFetchSequence({ status: 200, body: JSON.stringify(manifest) });
    const result = await tool.execute("call-15b", { plugin: "myplugin", tool: "missing_tool", parameters: "{}" });
    expect(asText(result.content[0])).toBe("Tool 'missing_tool' not found on plugin 'myplugin'. Available tools: search (query: string, count: integer), lookup (id: string)");
  });

  it("omits the available tools part when no permitted tools are in the manifest", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["other_tool"],
      tools: [
        { name: "hidden", parameters: {} },
      ],
    };
    mockFetchSequence({ status: 200, body: JSON.stringify(manifest) });
    const result = await tool.execute("call-15c", { plugin: "myplugin", tool: "missing_tool", parameters: "{}" });
    expect(asText(result.content[0])).toBe("Tool 'missing_tool' not found on plugin 'myplugin'.");
  });

  it("does not leak tools that are not in the permissions list", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["allowed_tool"],
      tools: [
        { name: "allowed_tool", parameters: { query: { type: "string" } } },
        { name: "secret_tool", parameters: { key: { type: "string" } } },
      ],
    };
    mockFetchSequence({ status: 200, body: JSON.stringify(manifest) });
    const result = await tool.execute("call-15d", { plugin: "myplugin", tool: "missing_tool", parameters: "{}" });
    const text = asText(result.content[0]);
    expect(text).toContain("allowed_tool");
    expect(text).not.toContain("secret_tool");
  });

  it.each([
    {
      description: "the tool is in the explicit permissions list",
      manifest: { name: "myplugin", permissions: ["mytool", "other_tool"] },
      tool: "mytool",
    },
    {
      description: "permissions is ['*'] (wildcard)",
      manifest: { name: "myplugin", permissions: ["*"] },
      tool: "anytool",
    },
    {
      description: "the manifest has no permissions field",
      manifest: { name: "myplugin" },
      tool: "mytool",
    },
  ])("proceeds when $description", async ({ manifest, tool: toolName }) => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    const result = await tool.execute("call-16", { plugin: "myplugin", tool: toolName, parameters: "{}" });
    expect(asText(result.content[0])).toBe(`The run of tool "${toolName}" (plugin "myplugin") returned:\n\`\`\`\ndone\n\`\`\``);
  });

  it("resolves file parameters to TransportedFile objects before sending to plugin-runner", async () => {
    const fileContent = Buffer.from("audio data");
    vi.mocked(fs.readFile).mockResolvedValueOnce(fileContent as unknown as string);
    const filePath = path.join(TEMP_ATTACHMENTS_DIR, "upload-abc.ogg");
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file", description: "Audio file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    await tool.execute("call-file-1", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: filePath }) });
    expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith(filePath);
    const fetchMock = vi.mocked(globalThis.fetch);
    const runCallBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { audio: { filename: string; data: string } };
    expect(runCallBody.audio).toEqual({
      filename: "upload-abc.ogg",
      data: fileContent.toString("base64"),
    });
  });

  it("does not modify non-file parameters when resolving file parameters", async () => {
    const fileContent = Buffer.from("audio data");
    vi.mocked(fs.readFile).mockResolvedValueOnce(fileContent as unknown as string);
    const filePath = path.join(TEMP_ATTACHMENTS_DIR, "upload-abc.ogg");
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" }, label: { type: "string" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    await tool.execute("call-file-2", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: filePath, label: "my label" }) });
    const fetchMock = vi.mocked(globalThis.fetch);
    const runCallBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { audio: { filename: string; data: string }; label: string };
    expect(runCallBody.label).toBe("my label");
    expect(runCallBody.audio.filename).toBe("upload-abc.ogg");
  });

  it.each([
    { description: "an absolute path outside TEMP_ATTACHMENTS_DIR", path: "/etc/passwd" },
    { description: "a path traversal out of TEMP_ATTACHMENTS_DIR", path: path.join(TEMP_ATTACHMENTS_DIR, "../../../etc/passwd") },
  ])("rejects file parameters with $description", async ({ path: filePath }) => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
    );
    await expect(
      tool.execute("call-file-3", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: filePath }) }),
    ).rejects.toThrow("not under the allowed directory");
  });

  it.each([
    {
      description: "when the tool is not found in the manifest",
      manifest: {
        name: "myplugin",
        permissions: ["*"],
        tools: [{ name: "othertool", parameters: { audio: { type: "file" } } }],
      },
    },
    {
      description: "when the manifest has no tools array",
      manifest: { name: "myplugin", permissions: ["*"] },
    },
  ])("passes parameters as-is $description", async ({ manifest }) => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    await tool.execute("call-file-5", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: "/some/path" }) });
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
    const fetchMock = vi.mocked(globalThis.fetch);
    const runCallBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { audio: string };
    expect(runCallBody.audio).toBe("/some/path");
  });

  it("runs a batch sequentially and numbers each result", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "first" }) },
      { status: 200, body: JSON.stringify({ success: true, output: "second" }) },
    );
    const result = await tool.execute("call-batch-1", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{ value: 1 }, { value: 2 }]),
    });
    expect(asText(result.content[0])).toBe(
      'Batch run of tool "mytool" (plugin "myplugin"): 2 calls.\n\n' +
      'Call 1:\nThe run of tool "mytool" (plugin "myplugin") returned:\n```\nfirst\n```\n\n' +
      'Call 2:\nThe run of tool "mytool" (plugin "myplugin") returned:\n```\nsecond\n```',
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)).toEqual({ value: 1 });
    expect(JSON.parse((fetchMock.mock.calls[2][1] as { body: string }).body)).toEqual({ value: 2 });
    expect(vi.mocked(fs.rm)).not.toHaveBeenCalled();
  });

  it("writes each batch item's files into its own output directory", async () => {
    const fileData = Buffer.from("hello file").toString("base64");
    const runResponse = { status: 200, body: JSON.stringify({ success: true, output: "done", files: [{ filename: "report.txt", data: fileData }] }) };
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      runResponse,
      runResponse,
    );
    await tool.execute("call-batch-dirs", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{}, {}]),
    });
    const writtenPaths = vi.mocked(fs.writeFile).mock.calls.map((call) => String(call[0]));
    expect(writtenPaths).toHaveLength(2);
    expect(path.dirname(writtenPaths[0])).not.toBe(path.dirname(writtenPaths[1]));
  });

  it("continues the batch when one call fails and still numbers every result", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: false, error: "boom" }) },
      { status: 200, body: JSON.stringify({ success: true, output: "recovered" }) },
    );
    const result = await tool.execute("call-batch-2", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{}, {}]),
    });
    const text = asText(result.content[0]);
    expect(text).toContain('Call 1:\nThe run of tool "mytool" (plugin "myplugin") failed:\n```\nboom\n```');
    expect(text).toContain('Call 2:\nThe run of tool "mytool" (plugin "myplugin") returned:\n```\nrecovered\n```');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it("turns a per-call error into a failed call and keeps going", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "second ok" }) },
    );
    const result = await tool.execute("call-batch-3", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{ audio: "/etc/passwd" }, {}]),
    });
    const text = asText(result.content[0]);
    expect(text).toContain('Call 1:\nThe run of tool "mytool" (plugin "myplugin") failed:\n```\nFile parameter \'audio\' path is not under the allowed directory: /etc/passwd\n```');
    expect(text).toContain('Call 2:\nThe run of tool "mytool" (plugin "myplugin") returned:\n```\nsecond ok\n```');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("does not send non-object batch items and reports them as failed calls", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "ok" }) },
    );
    const result = await tool.execute("call-batch-invalid", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([null, 42, "hello", [1, 2], { value: "ok" }]),
    });
    const text = asText(result.content[0]);
    expect(text).toContain('Call 1:\nThe run of tool "mytool" (plugin "myplugin") failed:\n```\nBatch item 1 is not a JSON object.\n```');
    expect(text).toContain("Call 2:\nThe run of tool");
    expect(text).toContain("Call 3:\nThe run of tool");
    expect(text).toContain("Call 4:\nThe run of tool");
    expect(text).toContain('Call 5:\nThe run of tool "mytool" (plugin "myplugin") returned:\n```\nok\n```');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("resolves file parameters per batch item", async () => {
    const fileContent = Buffer.from("audio data");
    vi.mocked(fs.readFile).mockResolvedValue(fileContent as unknown as string);
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "one" }) },
      { status: 200, body: JSON.stringify({ success: true, output: "two" }) },
    );
    const firstPath = path.join(TEMP_ATTACHMENTS_DIR, "one.ogg");
    const secondPath = path.join(TEMP_ATTACHMENTS_DIR, "two.ogg");
    await tool.execute("call-batch-files", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{ audio: firstPath }, { audio: secondPath }]),
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const firstBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body) as { audio: { filename: string } };
    const secondBody = JSON.parse((fetchMock.mock.calls[2][1] as { body: string }).body) as { audio: { filename: string } };
    expect(firstBody.audio.filename).toBe("one.ogg");
    expect(secondBody.audio.filename).toBe("two.ogg");
  });

  it("rejects a batch for an async tool before running anything", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", async: true, parameters: {} }],
    };
    mockFetchSequence({ status: 200, body: JSON.stringify(manifest) });
    const result = await tool.execute("call-batch-async", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: JSON.stringify([{}]),
    });
    expect(asText(result.content[0])).toBe('Error: tool "mytool" (plugin "myplugin") is asynchronous and cannot be run in a batch. Run it once per call with a single parameters object.');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("returns an error for an empty parameters array", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool.execute("call-batch-empty", {
      plugin: "myplugin",
      tool: "mytool",
      parameters: "[]",
    });
    expect(asText(result.content[0])).toBe("Error: the parameters array is empty; provide at least one set of parameters.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createManagePluginsTool", () => {
  // formatPluginRunnerResponse is shared by every action that returns a message,
  // so the response formatting is covered once here rather than per action.
  describe("response formatting", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it.each([
      {
        description: "returns the message field",
        body: JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' installed successfully." }),
        expected: "Plugin 'myplugin' installed successfully.",
      },
      {
        description: "appends init_output when present",
        body: JSON.stringify({
          name: "myplugin",
          message: "Plugin 'myplugin' installed successfully.",
          init_output: "Installed dependencies.\n",
        }),
        expected: "Plugin 'myplugin' installed successfully.\n\nInit script output:\n```\nInstalled dependencies.\n\n```",
      },
      {
        description: "appends instructions when present",
        body: JSON.stringify({
          name: "myplugin",
          message: "Plugin 'myplugin' installed successfully.",
          instructions: "Set the API key in the settings page.",
        }),
        expected: "Plugin 'myplugin' installed successfully.\n\nSetup instructions:\nSet the API key in the settings page.",
      },
      {
        description: "appends warnings when present",
        body: JSON.stringify({ message: "Plugin 'myplugin' installed successfully.", warnings: ["Could not connect"] }),
        expected: "Plugin 'myplugin' installed successfully.\n\nWarnings:\nCould not connect",
      },
      {
        description: "does not append empty warnings",
        body: JSON.stringify({ message: "Plugin 'myplugin' installed successfully.", warnings: [] }),
        expected: "Plugin 'myplugin' installed successfully.",
      },
      {
        description: "falls back to raw text when the response is not valid JSON",
        body: "not json",
        expected: "not json",
      },
      {
        description: "TOON-encodes the response when there is no message field",
        body: JSON.stringify({ name: "myplugin" }),
        expected: "name: myplugin",
      },
    ])("$description", async ({ body, expected }) => {
      mockFetch(200, body);
      const result = await tool.execute("call-1", { action: "install", url: "https://example.com/plugin.git" });
      expect(asText(result.content[0])).toBe(expected);
    });
  });

  describe("create action", () => {
    it("calls POST /create with the correct body and returns the message field", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' created." }));
      const result = await tool.execute("call-1", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      expect(asText(result.content[0])).toBe("Plugin 'myplugin' created.");
      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://plugin-runner:3003/create",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "myplugin", description: "A test plugin." }),
        }),
      );
    });

    it("returns an error when coder is not enabled", async () => {
      const tool = createManagePluginsTool({ coderEnabled: false });
      const result = await tool.execute("call-2", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      expect(asText(result.content[0])).toBe("Error: the create action requires the coder to be configured.");
    });
  });

  describe("add_mcp action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("calls POST /add-mcp with the parsed server spec and returns the message field", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myserver' added." }));
      const server = JSON.stringify({ command: "npx", args: ["-y", "@example/mcp-server"], env: { API_KEY: "secret" } });
      const result = await tool.execute("call-1", { action: "add_mcp", name: "myserver", plugin_description: "A test MCP server.", server });
      expect(asText(result.content[0])).toBe("Plugin 'myserver' added.");
      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://plugin-runner:3003/add-mcp",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "myserver",
            description: "A test MCP server.",
            server: { command: "npx", args: ["-y", "@example/mcp-server"], env: { API_KEY: "secret" } },
          }),
        }),
      );
    });

    it("returns an error when server is not valid JSON", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await tool.execute("call-3", {
        action: "add_mcp",
        name: "myserver",
        plugin_description: "A test MCP server.",
        server: "not json",
      });
      expect(asText(result.content[0])).toBe("Error: server is not valid JSON.");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("list action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("filters disabled plugins and strips the permissions field from each plugin", async () => {
      mockFetch(200, JSON.stringify({
        plugins: [
          { name: "enabled", permissions: ["*"] },
          { name: "disabled", permissions: [] },
          { name: "partial", permissions: ["tool1"] },
          { name: "noperms" },
        ],
      }));
      const result = await tool.execute("call-permissions", { action: "list" });
      const text = asText(result.content[0]);
      expect(text).toContain("enabled");
      expect(text).toContain("partial");
      expect(text).toContain("noperms");
      expect(text).not.toContain("disabled");
      expect(text).not.toContain("permissions");
    });

    // The plugins-array branch is the list-specific logic; the no-array branch
    // falls through to the shared TOON formatting.
    it("formats the raw response when there is no plugins array", async () => {
      mockFetch(200, JSON.stringify([{ name: "plugin1" }, { name: "plugin2" }]));
      const result = await tool.execute("call-1", { action: "list" });
      const text = asText(result.content[0]);
      expect(text).not.toContain('{"name"');
      expect(text).toContain("plugin1");
      expect(text).toContain("plugin2");
    });
  });

  describe("show action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("rejects a plugin name containing a slash without making a request", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await tool.execute("call-invalid-name", { action: "show", name: "example/config" });
      expect(asText(result.content[0])).toBe("Error: invalid plugin name.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 'not found' for a disabled plugin (permissions: [])", async () => {
      mockFetch(200, JSON.stringify({ name: "disabled", permissions: [], tools: [{ name: "tool1" }] }));
      const result = await tool.execute("call-3", { action: "show", name: "disabled" });
      expect(asText(result.content[0])).toBe("Plugin 'disabled' not found.");
    });

    it("filters tools to only permitted ones when permissions is an explicit list", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions: ["tool1", "tool3"],
        tools: [
          { name: "tool1", description: "First tool" },
          { name: "tool2", description: "Second tool" },
          { name: "tool3", description: "Third tool" },
        ],
      }));
      const result = await tool.execute("call-4", { action: "show", name: "myplugin" });
      const text = asText(result.content[0]);
      expect(text).toContain("tool1");
      expect(text).not.toContain("tool2");
      expect(text).toContain("tool3");
    });

    it.each([
      { description: "when permissions is ['*'] (wildcard)", permissions: ["*"] },
      { description: "when the permissions field is absent", permissions: undefined },
    ])("does not filter tools $description", async ({ permissions }) => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions,
        tools: [
          { name: "tool1", description: "First tool" },
          { name: "tool2", description: "Second tool" },
        ],
      }));
      const result = await tool.execute("call-5", { action: "show", name: "myplugin" });
      const text = asText(result.content[0]);
      expect(text).toContain("tool1");
      expect(text).toContain("tool2");
    });

    it.each([
      { description: "when permissions is ['*'] (wildcard)", permissions: ["*"] },
      { description: "when permissions is an explicit list", permissions: ["tool1"] },
    ])("strips the permissions field from the manifest $description", async ({ permissions }) => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions,
        tools: [{ name: "tool1", description: "First tool" }],
      }));
      const result = await tool.execute("call-8", { action: "show", name: "myplugin" });
      const text = asText(result.content[0]);
      expect(text).toContain("myplugin");
      expect(text).not.toContain("permissions");
    });
  });

  describe("configure action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("strips the permissions key from the config before forwarding", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured." }));
      await tool.execute("call-permissions", { action: "configure", name: "myplugin", config: '{"key":"value","permissions":["*"]}' });
      const fetchMock = vi.mocked(globalThis.fetch);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { name: string; config: Record<string, unknown> };
      expect(body.config).not.toHaveProperty("permissions");
      expect(body.config).toHaveProperty("key", "value");
    });
  });
});

describe("createRequestCodingTaskTool", () => {
  const tool = createRequestCodingTaskTool();

  it("returns an error when the plugin is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 404,
      text: () => Promise.resolve("Not found"),
    }));
    const result = await tool.execute("call-1", { plugin: "missing", message: "Add a tool." });
    expect(asText(result.content[0])).toBe("Plugin 'missing' not found. Create it first with manage_plugins (action: create).");
  });

  it("returns an error when the plugin is not editable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ name: "gitplugin", editable: false })),
    }));
    const result = await tool.execute("call-2", { plugin: "gitplugin", message: "Add a tool." });
    expect(asText(result.content[0])).toBe("Plugin 'gitplugin' is not editable. Only locally created plugins can be modified by the coding agent; git-installed and MCP plugins are never editable.");
  });

  it("submits the task to the coder when the plugin is editable", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ name: "myplugin", editable: true })),
      })
      .mockResolvedValueOnce({
        status: 202,
        text: () => Promise.resolve(""),
      }),
    );
    const result = await tool.execute("call-3", { plugin: "myplugin", message: "Add a hello tool." });
    expect(asText(result.content[0])).toMatch(/^Coding task .+ submitted for plugin 'myplugin'\. The coder agent will respond when done\.$/);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://plugin-runner:3003/bundles/myplugin",
      expect.objectContaining({
        headers: expect.objectContaining({ "Authorization": expect.stringMatching(/^Basic /) }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://coder:3002/code",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"plugin":"myplugin"'),
      }),
    );
  });
});
