import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { createManageUploadsTool } from "./upload-tools.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";

function asText(content: unknown): string {
  const item = content as TextContent;
  return item.text;
}

function asImage(content: unknown): ImageContent {
  return content as ImageContent;
}

async function writeTestFile(filename: string, content: string): Promise<string> {
  await fs.mkdir(TEMP_ATTACHMENTS_DIR, { recursive: true });
  const filePath = path.join(TEMP_ATTACHMENTS_DIR, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function writeTestBinaryFile(filename: string, data: Buffer): Promise<string> {
  await fs.mkdir(TEMP_ATTACHMENTS_DIR, { recursive: true });
  const filePath = path.join(TEMP_ATTACHMENTS_DIR, filename);
  await fs.writeFile(filePath, data);
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

describe("createManageUploadsTool - help", () => {
  const tool = createManageUploadsTool();

  it("returns help text for the help action", async () => {
    const result = await tool.execute("call-help", { action: "help" });
    expect(result.content[0].type).toBe("text");
    expect(asText(result.content[0])).toMatch(/manage_uploads/i);
  });
});

describe("createManageUploadsTool - read", () => {
  const tool = createManageUploadsTool();
  const testFilename = "upload-test-read-tool.txt";
  const testPath = path.join(TEMP_ATTACHMENTS_DIR, testFilename);

  afterEach(async () => {
    try {
      await fs.unlink(testPath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("returns file contents for a valid .txt upload file", async () => {
    await writeTestFile(testFilename, "hello from test");
    const result = await tool.execute("call-1", { action: "read", path: testPath });
    expect(result.content[0].type).toBe("text");
    expect(asText(result.content[0])).toBe("hello from test");
  });

  it("returns an error message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { action: "read", path: path.join(TEMP_ATTACHMENTS_DIR, "upload-nonexistent-xyz.txt") });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects paths outside the uploads directory", async () => {
    const result = await tool.execute("call-3", { action: "read", path: "/etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("rejects paths that traverse out of the uploads directory", async () => {
    const result = await tool.execute("call-4", { action: "read", path: path.join(TEMP_ATTACHMENTS_DIR, "../etc/passwd") });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-5", { action: "read", path: path.join(TEMP_ATTACHMENTS_DIR, "upload-perm-denied.txt") })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });

  it("returns ImageContent with base64 data and correct MIME type for a .jpg file", async () => {
    const imageFilename = "upload-test-read-tool.jpg";
    const imageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // minimal JPEG header bytes
    const imagePath = await writeTestBinaryFile(imageFilename, imageData);
    try {
      const result = await tool.execute("call-6", { action: "read", path: imagePath });
      const imageContent = asImage(result.content[0]);
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/jpeg");
      expect(imageContent.data).toBe(imageData.toString("base64"));
    } finally {
      await fs.unlink(imagePath);
    }
  });

  it("returns ImageContent with correct MIME type for a .png file", async () => {
    const imageFilename = "upload-test-read-tool.png";
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // minimal PNG header bytes
    const imagePath = await writeTestBinaryFile(imageFilename, imageData);
    try {
      const result = await tool.execute("call-7", { action: "read", path: imagePath });
      const imageContent = asImage(result.content[0]);
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/png");
    } finally {
      await fs.unlink(imagePath);
    }
  });

  it("returns an error message for unsupported binary files like .pdf", async () => {
    const pdfFilename = "upload-test-read-tool.pdf";
    const pdfPath = await writeTestBinaryFile(pdfFilename, Buffer.from("%PDF-1.4"));
    try {
      const result = await tool.execute("call-8", { action: "read", path: pdfPath });
      expect(result.content[0].type).toBe("text");
      expect(asText(result.content[0])).toMatch(/cannot read binary file/i);
      expect(asText(result.content[0])).toContain(".pdf");
    } finally {
      await fs.unlink(pdfPath);
    }
  });

  it("returns text content for a file with no extension", async () => {
    const noExtFilename = "upload-test-read-tool-noext";
    const noExtPath = path.join(TEMP_ATTACHMENTS_DIR, noExtFilename);
    await fs.mkdir(TEMP_ATTACHMENTS_DIR, { recursive: true });
    await fs.writeFile(noExtPath, "plain text content", "utf-8");
    try {
      const result = await tool.execute("call-9", { action: "read", path: noExtPath });
      expect(result.content[0].type).toBe("text");
      expect(asText(result.content[0])).toBe("plain text content");
    } finally {
      await fs.unlink(noExtPath);
    }
  });

  it("returns an error when path is missing", async () => {
    const result = await tool.execute("call-10", { action: "read" });
    expect(asText(result.content[0])).toMatch(/path is required/i);
  });
});

describe("createManageUploadsTool - delete", () => {
  const tool = createManageUploadsTool();
  const testFilename = "upload-test-delete-tool.txt";
  const testPath = path.join(TEMP_ATTACHMENTS_DIR, testFilename);

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
    const result = await tool.execute("call-1", { action: "delete", path: testPath });
    expect(asText(result.content[0])).toMatch(/deleted/i);
    expect(await fileExists(testPath)).toBe(false);
  });

  it("returns a 'not found' message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { action: "delete", path: path.join(TEMP_ATTACHMENTS_DIR, "upload-nonexistent-xyz.txt") });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects paths outside the uploads directory", async () => {
    const result = await tool.execute("call-3", { action: "delete", path: "/etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("rejects paths that traverse out of the uploads directory", async () => {
    const result = await tool.execute("call-4", { action: "delete", path: path.join(TEMP_ATTACHMENTS_DIR, "../etc/passwd") });
    expect(asText(result.content[0])).toMatch(/invalid path/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-5", { action: "delete", path: path.join(TEMP_ATTACHMENTS_DIR, "upload-perm-denied.txt") })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });

  it("returns an error when path is missing", async () => {
    const result = await tool.execute("call-6", { action: "delete" });
    expect(asText(result.content[0])).toMatch(/path is required/i);
  });
});
