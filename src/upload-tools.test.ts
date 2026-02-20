import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TextContent } from "@mariozechner/pi-ai";
import { createReadUploadTool, createDeleteUploadTool } from "./upload-tools.js";
import { UPLOADS_DIR } from "./uploads.js";

function asText(content: unknown): string {
  const item = content as TextContent;
  return item.text;
}

async function writeTestFile(filename: string, content: string): Promise<string> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("createReadUploadTool", () => {
  const tool = createReadUploadTool();
  const testFilename = "upload-test-read-tool.txt";
  const testPath = path.join(UPLOADS_DIR, testFilename);

  afterEach(async () => {
    try {
      await fs.unlink(testPath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("returns file contents for a valid upload file", async () => {
    await writeTestFile(testFilename, "hello from test");
    const result = await tool.execute("call-1", { path: testPath });
    expect(asText(result.content[0])).toBe("hello from test");
  });

  it("returns an error message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { path: path.join(UPLOADS_DIR, "upload-nonexistent-xyz.txt") });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects paths outside the uploads directory", async () => {
    const result = await tool.execute("call-3", { path: "/etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("rejects paths that traverse out of the uploads directory", async () => {
    const result = await tool.execute("call-4", { path: path.join(UPLOADS_DIR, "../etc/passwd") });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-5", { path: path.join(UPLOADS_DIR, "upload-perm-denied.txt") })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });
});

describe("createDeleteUploadTool", () => {
  const tool = createDeleteUploadTool();
  const testFilename = "upload-test-delete-tool.txt";
  const testPath = path.join(UPLOADS_DIR, testFilename);

  beforeEach(async () => {
    await writeTestFile(testFilename, "to be deleted");
  });

  afterEach(async () => {
    try {
      await fs.unlink(testPath);
    } catch {
      // File may already be deleted; ignore.
    }
  });

  it("deletes the file and returns a success message", async () => {
    const result = await tool.execute("call-1", { path: testPath });
    expect(asText(result.content[0])).toMatch(/deleted/i);
    expect(await fileExists(testPath)).toBe(false);
  });

  it("returns a 'not found' message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { path: path.join(UPLOADS_DIR, "upload-nonexistent-xyz.txt") });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects paths outside the uploads directory", async () => {
    const result = await tool.execute("call-3", { path: "/etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("rejects paths that traverse out of the uploads directory", async () => {
    const result = await tool.execute("call-4", { path: path.join(UPLOADS_DIR, "../etc/passwd") });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-5", { path: path.join(UPLOADS_DIR, "upload-perm-denied.txt") })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });
});
