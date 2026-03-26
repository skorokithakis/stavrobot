import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { createManageFilesTool } from "./files.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";

const FILES_DIR = path.join(TEMP_ATTACHMENTS_DIR, "files");

function asText(content: unknown): string {
  return (content as { type: string; text: string }).text;
}

async function writeTestFile(filename: string, content: string): Promise<string> {
  await fs.mkdir(FILES_DIR, { recursive: true });
  const filePath = path.join(FILES_DIR, filename);
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

describe("manage_files - search", () => {
  const tool = createManageFilesTool();
  const testFilename = "files-test-search.txt";
  let testFilePath: string;

  afterEach(async () => {
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("returns matching lines with line numbers for substring match", async () => {
    testFilePath = await writeTestFile(testFilename, "hello world\nfoo bar\nhello again\n");
    const result = await tool.execute("call-1", { action: "search", filename: testFilename, pattern: "hello" });
    const text = asText(result.content[0]);
    expect(text).toContain("1: hello world");
    expect(text).toContain("3: hello again");
    expect(text).not.toContain("foo bar");
  });

  it("returns 'no matches found' when pattern does not match", async () => {
    testFilePath = await writeTestFile(testFilename, "hello world\nfoo bar\n");
    const result = await tool.execute("call-2", { action: "search", filename: testFilename, pattern: "zzznomatch" });
    const text = asText(result.content[0]);
    expect(text).toMatch(/no matches found/i);
  });

  it("supports regex mode", async () => {
    testFilePath = await writeTestFile(testFilename, "abc123\ndef456\nabc789\n");
    const result = await tool.execute("call-3", { action: "search", filename: testFilename, pattern: "^abc", regex: true });
    const text = asText(result.content[0]);
    expect(text).toContain("1: abc123");
    expect(text).toContain("3: abc789");
    expect(text).not.toContain("def456");
  });

  it("returns a tool error for an invalid regex", async () => {
    testFilePath = await writeTestFile(testFilename, "some content\n");
    const result = await tool.execute("call-4", { action: "search", filename: testFilename, pattern: "[invalid", regex: true });
    const text = asText(result.content[0]);
    expect(text).toMatch(/invalid regular expression/i);
  });

  it("caps results at 100 and appends truncation notice", async () => {
    const manyLines = Array.from({ length: 150 }, (_, i) => `match line ${i + 1}`).join("\n");
    testFilePath = await writeTestFile(testFilename, manyLines);
    const result = await tool.execute("call-5", { action: "search", filename: testFilename, pattern: "match line" });
    const text = asText(result.content[0]);
    const lineCount = text.split("\n").filter((l) => /^\d+:/.test(l)).length;
    expect(lineCount).toBe(100);
    expect(text).toContain("showing 100 of 150 matches");
  });

  it("returns an error when filename is missing", async () => {
    testFilePath = path.join(FILES_DIR, testFilename);
    const result = await tool.execute("call-6", { action: "search", pattern: "hello" });
    expect(asText(result.content[0])).toMatch(/filename is required/i);
  });

  it("returns an error when pattern is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-7", { action: "search", filename: testFilename });
    expect(asText(result.content[0])).toMatch(/pattern is required/i);
  });

  it("rejects paths outside TEMP_ATTACHMENTS_DIR", async () => {
    testFilePath = path.join(FILES_DIR, testFilename);
    const result = await tool.execute("call-8", { action: "search", filename: "/etc/passwd", pattern: "root" });
    expect(asText(result.content[0])).toMatch(/path must be under/i);
  });
});

describe("manage_files - read_lines", () => {
  const tool = createManageFilesTool();
  const testFilename = "files-test-read-lines.txt";
  let testFilePath: string;

  afterEach(async () => {
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("returns the requested range with line number prefixes and total count", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\nline4\nline5\n");
    const result = await tool.execute("call-1", { action: "read_lines", filename: testFilename, from: 2, to: 4 });
    const text = asText(result.content[0]);
    expect(text).toContain("2: line2");
    expect(text).toContain("3: line3");
    expect(text).toContain("4: line4");
    expect(text).not.toContain("1: line1");
    expect(text).not.toContain("5: line5");
    expect(text).toContain("lines 2-4 of");
  });

  it("returns an error when 'from' is below 1", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\n");
    const result = await tool.execute("call-2", { action: "read_lines", filename: testFilename, from: -5, to: 2 });
    const text = asText(result.content[0]);
    expect(text).toMatch(/from must be an integer >= 1/i);
  });

  it("clamps 'to' to the last line when beyond EOF", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\n");
    const result = await tool.execute("call-3", { action: "read_lines", filename: testFilename, from: 2, to: 999 });
    const text = asText(result.content[0]);
    expect(text).toContain("2: line2");
    expect(text).toContain("3: line3");
  });

  it("returns empty with total count when 'from' is beyond EOF", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-4", { action: "read_lines", filename: testFilename, from: 100, to: 200 });
    const text = asText(result.content[0]);
    expect(text).toContain("100-200");
  });

  it("returns an error when filename is missing", async () => {
    testFilePath = path.join(FILES_DIR, testFilename);
    const result = await tool.execute("call-5", { action: "read_lines", from: 1, to: 5 });
    expect(asText(result.content[0])).toMatch(/filename is required/i);
  });

  it("returns an error when from is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-6", { action: "read_lines", filename: testFilename, to: 5 });
    expect(asText(result.content[0])).toMatch(/from is required/i);
  });

  it("returns an error when to is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-7", { action: "read_lines", filename: testFilename, from: 1 });
    expect(asText(result.content[0])).toMatch(/to is required/i);
  });

  it("returns an error when from is less than 1", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-8", { action: "read_lines", filename: testFilename, from: 0, to: 2 });
    expect(asText(result.content[0])).toMatch(/from must be an integer >= 1/i);
  });

  it("returns an error when from is a non-integer", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-9", { action: "read_lines", filename: testFilename, from: 1.5, to: 2 });
    expect(asText(result.content[0])).toMatch(/from must be an integer >= 1/i);
  });

  it("returns an error when to is a non-integer", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-10", { action: "read_lines", filename: testFilename, from: 1, to: 1.5 });
    expect(asText(result.content[0])).toMatch(/to must be an integer/i);
  });
});

describe("manage_files - write_lines", () => {
  const tool = createManageFilesTool();
  const testFilename = "files-test-write-lines.txt";
  let testFilePath: string;

  afterEach(async () => {
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("replaces the specified line range with new content", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\nline4\nline5\n");
    // 5 real lines; replacing 2 lines (2-3) with 3 new lines: 5 - 2 + 3 = 6.
    const result = await tool.execute("call-1", { action: "write_lines", filename: testFilename, from: 2, to: 3, content: "new2\nnew3\nnew3b" });
    expect(asText(result.content[0])).toContain("6");
    const written = await fs.readFile(testFilePath, "utf-8");
    expect(written).toBe("line1\nnew2\nnew3\nnew3b\nline4\nline5\n");
  });

  it("inserts before a line when from > to (e.g. from: 3, to: 2)", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\n");
    await tool.execute("call-2", { action: "write_lines", filename: testFilename, from: 2, to: 1, content: "inserted" });
    const written = await fs.readFile(testFilePath, "utf-8");
    expect(written).toBe("line1\ninserted\nline2\nline3\n");
  });

  it("deletes lines when content is empty", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\nline4\n");
    await tool.execute("call-3", { action: "write_lines", filename: testFilename, from: 2, to: 3, content: "" });
    const written = await fs.readFile(testFilePath, "utf-8");
    expect(written).toBe("line1\nline4\n");
  });

  it("returns the new total line count", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\n");
    // 3 real lines; replacing 1 line (1-1) with 3 new lines: 3 - 1 + 3 = 5.
    const result = await tool.execute("call-4", { action: "write_lines", filename: testFilename, from: 1, to: 1, content: "a\nb\nc" });
    const text = asText(result.content[0]);
    expect(text).toContain("5");
  });

  it("returns an error when filename is missing", async () => {
    testFilePath = path.join(FILES_DIR, testFilename);
    const result = await tool.execute("call-5", { action: "write_lines", from: 1, to: 2, content: "x" });
    expect(asText(result.content[0])).toMatch(/filename is required/i);
  });

  it("returns an error when from is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-6", { action: "write_lines", filename: testFilename, to: 1, content: "x" });
    expect(asText(result.content[0])).toMatch(/from is required/i);
  });

  it("returns an error when to is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-7", { action: "write_lines", filename: testFilename, from: 1, content: "x" });
    expect(asText(result.content[0])).toMatch(/to is required/i);
  });

  it("returns an error when content is missing", async () => {
    testFilePath = await writeTestFile(testFilename, "content\n");
    const result = await tool.execute("call-8", { action: "write_lines", filename: testFilename, from: 1, to: 1 });
    expect(asText(result.content[0])).toMatch(/content is required/i);
  });

  it("returns an error when from is 0", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-9", { action: "write_lines", filename: testFilename, from: 0, to: 1, content: "x" });
    expect(asText(result.content[0])).toMatch(/from must be an integer >= 1/i);
  });

  it("returns an error when from is negative", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-10", { action: "write_lines", filename: testFilename, from: -1, to: 1, content: "x" });
    expect(asText(result.content[0])).toMatch(/from must be an integer >= 1/i);
  });

  it("returns an error when from is a non-integer", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-11", { action: "write_lines", filename: testFilename, from: 1.5, to: 2, content: "x" });
    expect(asText(result.content[0])).toMatch(/from must be an integer >= 1/i);
  });

  it("returns an error when to is a non-integer", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\n");
    const result = await tool.execute("call-12", { action: "write_lines", filename: testFilename, from: 1, to: 1.5, content: "x" });
    expect(asText(result.content[0])).toMatch(/to must be an integer/i);
  });

  it("preserves trailing newline after write", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3\n");
    await tool.execute("call-13", { action: "write_lines", filename: testFilename, from: 2, to: 2, content: "replaced" });
    const written = await fs.readFile(testFilePath, "utf-8");
    expect(written).toBe("line1\nreplaced\nline3\n");
  });

  it("does not add trailing newline when original had none", async () => {
    testFilePath = await writeTestFile(testFilename, "line1\nline2\nline3");
    await tool.execute("call-14", { action: "write_lines", filename: testFilename, from: 2, to: 2, content: "replaced" });
    const written = await fs.readFile(testFilePath, "utf-8");
    expect(written).toBe("line1\nreplaced\nline3");
  });
});

describe("manage_files - line count correctness", () => {
  const tool = createManageFilesTool();
  const testFilename = "files-test-linecount.txt";
  let testFilePath: string;

  afterEach(async () => {
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File may not exist; ignore.
    }
  });

  it("reports 3 lines for a file with trailing newline", async () => {
    testFilePath = await writeTestFile(testFilename, "a\nb\nc\n");
    const result = await tool.execute("call-1", { action: "read_lines", filename: testFilename, from: 1, to: 10 });
    const text = asText(result.content[0]);
    expect(text).toContain("of 3 total");
  });

  it("reports 3 lines for a file without trailing newline", async () => {
    testFilePath = await writeTestFile(testFilename, "a\nb\nc");
    const result = await tool.execute("call-2", { action: "read_lines", filename: testFilename, from: 1, to: 10 });
    const text = asText(result.content[0]);
    expect(text).toContain("of 3 total");
  });

  it("search does not report a phantom empty line at end of file with trailing newline", async () => {
    testFilePath = await writeTestFile(testFilename, "hello\nworld\n");
    // Use regex ".*" to match every line; only real lines should appear.
    const result = await tool.execute("call-3", { action: "search", filename: testFilename, pattern: ".*", regex: true });
    const text = asText(result.content[0]);
    // Only lines 1 and 2 should match; no phantom line 3.
    const lineNumbers = [...text.matchAll(/^(\d+):/gm)].map((match) => Number(match[1]));
    expect(lineNumbers).toEqual([1, 2]);
  });
});

describe("manage_files - copy", () => {
  const tool = createManageFilesTool();
  const sourceFilename = "files-test-copy-source.txt";
  const destFilename = "files-test-copy-dest.txt";
  let sourceFilePath: string;
  let destFilePath: string;

  afterEach(async () => {
    for (const filePath of [sourceFilePath, destFilePath]) {
      try {
        await fs.unlink(filePath);
      } catch {
        // File may not exist; ignore.
      }
    }
  });

  it("copies the file and returns the absolute destination path", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "copy me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-1", { action: "copy", source: sourceFilename, destination: destFilename });
    const text = asText(result.content[0]);
    expect(text).toBe(destFilePath);
    expect(await fileExists(destFilePath)).toBe(true);
    expect(await fs.readFile(destFilePath, "utf-8")).toBe("copy me");
    expect(await fileExists(sourceFilePath)).toBe(true);
  });

  it("returns an error when source is missing", async () => {
    sourceFilePath = path.join(FILES_DIR, sourceFilename);
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-2", { action: "copy", destination: destFilename });
    expect(asText(result.content[0])).toMatch(/source is required/i);
  });

  it("returns an error when destination is missing", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "copy me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-3", { action: "copy", source: sourceFilename });
    expect(asText(result.content[0])).toMatch(/destination is required/i);
  });

  it("rejects source paths outside TEMP_ATTACHMENTS_DIR", async () => {
    sourceFilePath = path.join(FILES_DIR, sourceFilename);
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-4", { action: "copy", source: "/etc/passwd", destination: destFilename });
    expect(asText(result.content[0])).toMatch(/path must be under/i);
  });

  it("rejects destination paths outside TEMP_ATTACHMENTS_DIR", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "copy me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-5", { action: "copy", source: sourceFilename, destination: "/tmp/evil" });
    expect(asText(result.content[0])).toMatch(/path must be under/i);
  });
});

describe("manage_files - move", () => {
  const tool = createManageFilesTool();
  const sourceFilename = "files-test-move-source.txt";
  const destFilename = "files-test-move-dest.txt";
  let sourceFilePath: string;
  let destFilePath: string;

  afterEach(async () => {
    for (const filePath of [sourceFilePath, destFilePath]) {
      try {
        await fs.unlink(filePath);
      } catch {
        // File may not exist; ignore.
      }
    }
  });

  it("moves the file and returns the absolute destination path", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "move me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-1", { action: "move", source: sourceFilename, destination: destFilename });
    const text = asText(result.content[0]);
    expect(text).toBe(destFilePath);
    expect(await fileExists(destFilePath)).toBe(true);
    expect(await fs.readFile(destFilePath, "utf-8")).toBe("move me");
    expect(await fileExists(sourceFilePath)).toBe(false);
  });

  it("returns an error when source is missing", async () => {
    sourceFilePath = path.join(FILES_DIR, sourceFilename);
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-2", { action: "move", destination: destFilename });
    expect(asText(result.content[0])).toMatch(/source is required/i);
  });

  it("returns an error when destination is missing", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "move me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-3", { action: "move", source: sourceFilename });
    expect(asText(result.content[0])).toMatch(/destination is required/i);
  });

  it("rejects source paths outside TEMP_ATTACHMENTS_DIR", async () => {
    sourceFilePath = path.join(FILES_DIR, sourceFilename);
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-4", { action: "move", source: "/etc/passwd", destination: destFilename });
    expect(asText(result.content[0])).toMatch(/path must be under/i);
  });

  it("rejects destination paths outside TEMP_ATTACHMENTS_DIR", async () => {
    sourceFilePath = await writeTestFile(sourceFilename, "move me");
    destFilePath = path.join(FILES_DIR, destFilename);
    const result = await tool.execute("call-5", { action: "move", source: sourceFilename, destination: "/tmp/evil" });
    expect(asText(result.content[0])).toMatch(/path must be under/i);
  });
});
