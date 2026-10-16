import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tempDir: string;

vi.mock("./temp-dir.js", async () => {
  const actual = await vi.importActual<typeof import("./temp-dir.js")>("./temp-dir.js");
  return {
    ...actual,
    get TEMP_ATTACHMENTS_DIR(): string {
      return tempDir;
    },
  };
});
vi.mock("./database.js", () => ({ listCronEntries: vi.fn(), deleteCronEntry: vi.fn() }));
vi.mock("./queue.js", () => ({ enqueueMessage: vi.fn() }));

import { cleanupOldUploads } from "./scheduler.js";

const FOUR_DAYS_SECONDS = 4 * 24 * 60 * 60;

function makeOld(target: string): void {
  const oldTime = Date.now() / 1000 - FOUR_DAYS_SECONDS;
  fs.utimesSync(target, oldTime, oldTime);
}

describe("cleanupOldUploads", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stavrobot-scheduler-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deletes old output directories recursively and keeps fresh ones", async () => {
    const oldDir = path.join(tempDir, "output-old");
    const freshDir = path.join(tempDir, "output-fresh");
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, "report.txt"), "old");
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(freshDir, "report.txt"), "fresh");
    makeOld(oldDir);

    await cleanupOldUploads();

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(path.join(freshDir, "report.txt"))).toBe(true);
  });

  it("still deletes old uploads and ignores other old entries", async () => {
    const oldUpload = path.join(tempDir, "upload-abc.txt");
    const otherDir = path.join(tempDir, "files");
    fs.writeFileSync(oldUpload, "x");
    fs.mkdirSync(otherDir);
    makeOld(oldUpload);
    makeOld(otherDir);

    await cleanupOldUploads();

    expect(fs.existsSync(oldUpload)).toBe(false);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});
