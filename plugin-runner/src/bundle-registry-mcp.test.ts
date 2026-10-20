import fs from "fs";
import os from "os";
import path from "path";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import type { ToolManifest } from "./bundle-registry.js";

const { getCachedToolsMock } = vi.hoisted(() => ({
  getCachedToolsMock: vi.fn((): ToolManifest[] => []),
}));

vi.mock("./mcp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client.js")>();
  return { ...actual, getCachedTools: getCachedToolsMock };
});

import { getBundles, loadBundles } from "./bundle-registry.js";

const tempDirs: string[] = [];

function makePluginsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runner-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function mcpTool(name: string): ToolManifest {
  return {
    name,
    description: `${name} tool`,
    entrypoint: "",
    async: true,
    parameters: {},
  };
}

beforeEach(() => {
  getCachedToolsMock.mockReset();
  getCachedToolsMock.mockReturnValue([]);
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("loadBundles for MCP bundles", () => {
  it("detects the mcp type and uses the cached tools instead of scanning directories", () => {
    const pluginsDir = makePluginsDir();
    const bundleDir = path.join(pluginsDir, "remote");

    writeJson(path.join(bundleDir, "manifest.json"), {
      name: "remote",
      description: "Remote MCP server",
      type: "mcp",
      config: { server: { description: "MCP server spec (JSON)", required: true } },
    });
    writeJson(path.join(bundleDir, "config.json"), {
      permissions: ["*"],
      server: { url: "https://example.com/mcp" },
    });

    // A directory that would be picked up as a script tool if the tool scan ran.
    writeJson(path.join(bundleDir, "local-tool", "manifest.json"), {
      name: "local-tool",
      description: "Should be ignored",
      entrypoint: "run.sh",
      parameters: {},
    });

    getCachedToolsMock.mockReturnValue([mcpTool("search")]);

    loadBundles(pluginsDir);

    const bundles = getBundles();
    expect(bundles).toHaveLength(1);
    expect(bundles[0].type).toBe("mcp");
    expect(bundles[0].tools.map((tool) => tool.manifest.name)).toEqual(["search"]);
    expect(getCachedToolsMock).toHaveBeenCalledWith("remote");
  });

  it("reports no tools for an MCP bundle that has not connected yet", () => {
    const pluginsDir = makePluginsDir();
    const bundleDir = path.join(pluginsDir, "remote");

    writeJson(path.join(bundleDir, "manifest.json"), {
      name: "remote",
      description: "Remote MCP server",
      type: "mcp",
    });
    writeJson(path.join(bundleDir, "config.json"), {
      permissions: ["*"],
      server: { url: "https://example.com/mcp" },
    });

    loadBundles(pluginsDir);

    expect(getBundles()[0].tools).toEqual([]);
  });

  it("defaults a manifest without a type to script and still scans tool directories", () => {
    const pluginsDir = makePluginsDir();
    const bundleDir = path.join(pluginsDir, "local");

    writeJson(path.join(bundleDir, "manifest.json"), {
      name: "local",
      description: "Local plugin",
    });
    writeJson(path.join(bundleDir, "config.json"), { permissions: ["*"] });
    writeJson(path.join(bundleDir, "convert", "manifest.json"), {
      name: "convert",
      description: "Convert",
      entrypoint: "run.sh",
      parameters: {},
    });

    loadBundles(pluginsDir);

    const bundle = getBundles()[0];
    expect(bundle.type).toBe("script");
    expect(bundle.tools.map((tool) => tool.manifest.name)).toEqual(["convert"]);
    expect(getCachedToolsMock).not.toHaveBeenCalled();
  });
});
