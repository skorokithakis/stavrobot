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

  it("formats a successful sync result with string output", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "hello world" }) },
    );
    const result = await tool.execute("call-1", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\nhello world\n```');
  });

  it("formats a successful sync result with object output as TOON", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: { key: "value" } }) },
    );
    const result = await tool.execute("call-2", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\nkey: value\n```');
  });

  it("formats a failed sync result with error message", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: false, error: "something went wrong" }) },
    );
    const result = await tool.execute("call-3", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nsomething went wrong\n```');
  });

  it("uses 'Unknown error' when failure has no error field", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: false }) },
    );
    const result = await tool.execute("call-4", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nUnknown error\n```');
  });

  it("returns async message for 202 response", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 202, body: JSON.stringify({ status: "running" }) },
    );
    const result = await tool.execute("call-5", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('Tool "mytool" (plugin "myplugin") is running asynchronously. The result will arrive when it completes.');
  });

  it("falls back to raw text when run response is not valid JSON", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: "not json at all" },
    );
    const result = await tool.execute("call-6", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("not json at all");
  });

  it("falls back to raw text when JSON does not have a 'success' boolean", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ result: "something" }) },
    );
    const result = await tool.execute("call-7", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe(JSON.stringify({ result: "something" }));
  });

  it("clears the plugin files directory before making the run HTTP request", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    await tool.execute("call-8", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(vi.mocked(fs.rm)).toHaveBeenCalledWith(
      path.join(TEMP_ATTACHMENTS_DIR, "myplugin"),
      { recursive: true, force: true },
    );
  });

  it("saves transported files and appends 'Output files' listing to result", async () => {
    const fileData = Buffer.from("hello file").toString("base64");
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done", files: [{ filename: "report.txt", data: fileData }] }) },
    );
    const expectedDir = path.join(TEMP_ATTACHMENTS_DIR, "myplugin");
    vi.mocked(fs.readdir).mockResolvedValueOnce(["report.txt"] as unknown as never[]);
    vi.mocked(fs.stat).mockResolvedValueOnce({ size: 1536 } as unknown as import("fs").Stats);
    const result = await tool.execute("call-9", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
      path.join(expectedDir, "report.txt"),
      Buffer.from(fileData, "base64"),
    );
    expect(text).toContain(`\n\nOutput files:\n- ${path.join(expectedDir, "report.txt")} (1.5 KB)`);
  });

  it("does not append 'Output files' when files array is empty", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done", files: [] }) },
    );
    const result = await tool.execute("call-10", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Output files");
    expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
  });

  it("does not append 'Output files' when files entries are invalid", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done", files: [{ bad: "entry" }] }) },
    );
    const result = await tool.execute("call-11", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Output files");
    expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
  });

  it("does not append 'Output files' when response has no files field", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    const result = await tool.execute("call-12", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Output files");
  });

  it("returns an error when the plugin is not found (404)", async () => {
    mockFetchSequence({ status: 404, body: "Not found" });
    const result = await tool.execute("call-13", { plugin: "missing", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'missing' not found.");
  });

  it("returns an error when the plugin is disabled (permissions: [])", async () => {
    mockFetchSequence({ status: 200, body: JSON.stringify({ name: "myplugin", permissions: [] }) });
    const result = await tool.execute("call-14", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'myplugin' not found.");
  });

  it("returns an error when the tool is not in the explicit permissions list", async () => {
    mockFetchSequence({ status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["other_tool"] }) });
    const result = await tool.execute("call-15", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Tool 'mytool' not found on plugin 'myplugin'.");
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
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Tool 'missing_tool' not found on plugin 'myplugin'. Available tools: search (query: string, count: integer), lookup (id: string)");
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
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Tool 'missing_tool' not found on plugin 'myplugin'.");
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
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("allowed_tool");
    expect(text).not.toContain("secret_tool");
  });

  it("proceeds when the tool is in the explicit permissions list", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["mytool", "other_tool"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    const result = await tool.execute("call-16", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\ndone\n```');
  });

  it("proceeds when permissions is ['*'] (wildcard)", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin", permissions: ["*"] }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    const result = await tool.execute("call-17", { plugin: "myplugin", tool: "anytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "anytool" (plugin "myplugin") returned:\n```\ndone\n```');
  });

  it("proceeds when manifest has no permissions field", async () => {
    mockFetchSequence(
      { status: 200, body: JSON.stringify({ name: "myplugin" }) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    const result = await tool.execute("call-18", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\ndone\n```');
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

  it("rejects file parameters whose path is not under TEMP_ATTACHMENTS_DIR", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
    );
    await expect(
      tool.execute("call-file-3", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: "/etc/passwd" }) }),
    ).rejects.toThrow("not under the allowed directory");
  });

  it("rejects path traversal attempts in file parameters", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "mytool", parameters: { audio: { type: "file" } } }],
    };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
    );
    const traversalPath = path.join(TEMP_ATTACHMENTS_DIR, "../../../etc/passwd");
    await expect(
      tool.execute("call-file-4", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: traversalPath }) }),
    ).rejects.toThrow("not under the allowed directory");
  });

  it("passes parameters as-is when the tool is not found in the manifest", async () => {
    const manifest = {
      name: "myplugin",
      permissions: ["*"],
      tools: [{ name: "othertool", parameters: { audio: { type: "file" } } }],
    };
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

  it("passes parameters as-is when the manifest has no tools array", async () => {
    const manifest = { name: "myplugin", permissions: ["*"] };
    mockFetchSequence(
      { status: 200, body: JSON.stringify(manifest) },
      { status: 200, body: JSON.stringify({ success: true, output: "done" }) },
    );
    await tool.execute("call-file-6", { plugin: "myplugin", tool: "mytool", parameters: JSON.stringify({ audio: "/some/path" }) });
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });
});

describe("createManagePluginsTool", () => {
  describe("help action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns help text", async () => {
      const result = await tool.execute("call-1", { action: "help" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("manage_plugins");
      expect(text).toContain("install");
      expect(text).toContain("create");
    });
  });

  describe("install action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' installed successfully." }));
      const result = await tool.execute("call-1", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' installed successfully.",
        init_output: "Installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.\n\nInit script output:\n```\nInstalled dependencies.\n\n```");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-3", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("TOON-encodes the response when JSON has no message field", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin" }));
      const result = await tool.execute("call-4", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("name: myplugin");
    });

    it("returns an error when url is missing", async () => {
      const result = await tool.execute("call-5", { action: "install" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: url is required for install.");
    });
  });

  describe("update action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' updated successfully." }));
      const result = await tool.execute("call-1", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' updated successfully.",
        init_output: "Re-installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.\n\nInit script output:\n```\nRe-installed dependencies.\n\n```");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-3", { action: "update" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for update.");
    });
  });

  describe("create action", () => {
    it("calls POST /create with the correct body and returns the message field", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' created." }));
      const result = await tool.execute("call-1", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' created.");
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
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: the create action requires the coder to be configured.");
    });

    it("returns an error when name is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-3", { action: "create", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for create.");
    });

    it("returns an error when plugin_description is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-4", { action: "create", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: plugin_description is required for create.");
    });
  });

  describe("list action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("TOON-encodes the plugin list response", async () => {
      mockFetch(200, JSON.stringify([{ name: "plugin1" }, { name: "plugin2" }]));
      const result = await tool.execute("call-1", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      // TOON format uses column headers like {name} rather than JSON object syntax.
      expect(text).not.toContain('{"name"');
      expect(text).toContain("plugin1");
      expect(text).toContain("plugin2");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-2", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("strips the permissions field from each plugin in the list", async () => {
      mockFetch(200, JSON.stringify({
        plugins: [
          { name: "enabled", permissions: ["*"] },
          { name: "partial", permissions: ["tool1"] },
        ],
      }));
      const result = await tool.execute("call-permissions", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("enabled");
      expect(text).toContain("partial");
      expect(text).not.toContain("permissions");
    });

    it("filters out disabled plugins (permissions: []) from the list", async () => {
      mockFetch(200, JSON.stringify({
        plugins: [
          { name: "enabled", permissions: ["*"] },
          { name: "disabled", permissions: [] },
          { name: "partial", permissions: ["tool1"] },
        ],
      }));
      const result = await tool.execute("call-3", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("enabled");
      expect(text).not.toContain("disabled");
      expect(text).toContain("partial");
    });

    it("keeps plugins with no permissions field in the list", async () => {
      mockFetch(200, JSON.stringify({
        plugins: [
          { name: "noperms" },
          { name: "disabled", permissions: [] },
        ],
      }));
      const result = await tool.execute("call-4", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("noperms");
      expect(text).not.toContain("disabled");
    });

    it("falls back to formatting the raw response when the response has no plugins array", async () => {
      mockFetch(200, JSON.stringify([{ name: "plugin1" }]));
      const result = await tool.execute("call-5", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("plugin1");
    });
  });

  describe("show action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("TOON-encodes the plugin manifest response", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", tools: ["tool1"] }));
      const result = await tool.execute("call-1", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).not.toContain("{");
      expect(text).toContain("myplugin");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-2", { action: "show" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for show.");
    });

    it("returns 'not found' for a disabled plugin (permissions: [])", async () => {
      mockFetch(200, JSON.stringify({ name: "disabled", permissions: [], tools: [{ name: "tool1" }] }));
      const result = await tool.execute("call-3", { action: "show", name: "disabled" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'disabled' not found.");
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
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("tool1");
      expect(text).not.toContain("tool2");
      expect(text).toContain("tool3");
    });

    it("does not filter tools when permissions is ['*'] (wildcard)", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions: ["*"],
        tools: [
          { name: "tool1", description: "First tool" },
          { name: "tool2", description: "Second tool" },
        ],
      }));
      const result = await tool.execute("call-5", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("tool1");
      expect(text).toContain("tool2");
    });

    it("does not filter tools when permissions field is absent", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        tools: [
          { name: "tool1", description: "First tool" },
          { name: "tool2", description: "Second tool" },
        ],
      }));
      const result = await tool.execute("call-6", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("tool1");
      expect(text).toContain("tool2");
    });

    it("falls back to raw formatting when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-7", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("strips the permissions field from the manifest when permissions is ['*']", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions: ["*"],
        tools: [{ name: "tool1", description: "First tool" }],
      }));
      const result = await tool.execute("call-8", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("myplugin");
      expect(text).not.toContain("permissions");
    });

    it("strips the permissions field from the manifest when permissions is an explicit list", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        permissions: ["tool1"],
        tools: [{ name: "tool1", description: "First tool" }],
      }));
      const result = await tool.execute("call-9", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("myplugin");
      expect(text).not.toContain("permissions");
    });
  });

  describe("remove action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' removed." }));
      const result = await tool.execute("call-1", { action: "remove", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' removed.");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-2", { action: "remove", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-3", { action: "remove" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for remove.");
    });
  });

  describe("configure action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured." }));
      const result = await tool.execute("call-1", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.");
    });

    it("strips the permissions key from the config before forwarding", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured." }));
      await tool.execute("call-permissions", { action: "configure", name: "myplugin", config: '{"key":"value","permissions":["*"]}' });
      const fetchMock = vi.mocked(globalThis.fetch);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { name: string; config: Record<string, unknown> };
      expect(body.config).not.toHaveProperty("permissions");
      expect(body.config).toHaveProperty("key", "value");
    });

    it("appends warnings when present and non-empty", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured.", warnings: ["Unknown key: foo"] }));
      const result = await tool.execute("call-2", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.\n\nWarnings:\nUnknown key: foo");
    });

    it("does not append warnings when warnings array is empty", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured.", warnings: [] }));
      const result = await tool.execute("call-3", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-4", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-5", { action: "configure", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for configure.");
    });

    it("returns an error when config is missing", async () => {
      const result = await tool.execute("call-6", { action: "configure", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: config is required for configure.");
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
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'missing' not found. Create it first with manage_plugins (action: create).");
  });

  it("returns an error when the plugin is not editable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ name: "gitplugin", editable: false })),
    }));
    const result = await tool.execute("call-2", { plugin: "gitplugin", message: "Add a tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'gitplugin' is not editable. Only locally created plugins can be modified by the coding agent.");
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
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/^Coding task .+ submitted for plugin 'myplugin'\. The coder agent will respond when done\.$/);
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
