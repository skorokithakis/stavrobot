import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyTelegramEntitiesToMarkdown, startTelegramPolling, runTelegramPollingLoop } from "./telegram.js";
import { enqueueMessage } from "./queue.js";
import { log } from "./log.js";
import type { TelegramConfig } from "./config.js";

// Mock the queue and allowlist so polling tests can assert that updates reach the
// handler without touching real infrastructure.
vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn().mockResolvedValue("ok"),
  initializeQueue: vi.fn(),
}));

vi.mock("./allowlist.js", () => ({
  isInAllowlist: vi.fn().mockReturnValue(true),
}));

function jsonResponse(payload: unknown): Response {
  return { json: async () => payload } as unknown as Response;
}

describe("applyTelegramEntitiesToMarkdown", () => {
  it("returns text unchanged when entities is undefined", () => {
    expect(applyTelegramEntitiesToMarkdown("hello world", undefined)).toBe("hello world");
  });

  it("returns text unchanged when entities is empty", () => {
    expect(applyTelegramEntitiesToMarkdown("hello world", [])).toBe("hello world");
  });

  it("applies bold formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("hello world", [
      { type: "bold", offset: 6, length: 5 },
    ]);
    expect(result).toBe("hello **world**");
  });

  it("applies italic formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("hello world", [
      { type: "italic", offset: 0, length: 5 },
    ]);
    expect(result).toBe("_hello_ world");
  });

  it("applies strikethrough formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("hello world", [
      { type: "strikethrough", offset: 0, length: 11 },
    ]);
    expect(result).toBe("~~hello world~~");
  });

  it("applies inline code formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("run ls -la now", [
      { type: "code", offset: 4, length: 6 },
    ]);
    expect(result).toBe("run `ls -la` now");
  });

  it("applies pre formatting without language", () => {
    const result = applyTelegramEntitiesToMarkdown("code block", [
      { type: "pre", offset: 0, length: 10 },
    ]);
    expect(result).toBe("```\ncode block\n```");
  });

  it("applies pre formatting with language", () => {
    const result = applyTelegramEntitiesToMarkdown("const x = 1", [
      { type: "pre", offset: 0, length: 11, language: "javascript" },
    ]);
    expect(result).toBe("```javascript\nconst x = 1\n```");
  });

  it("applies text_link formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("click here for more", [
      { type: "text_link", offset: 6, length: 4, url: "https://example.com" },
    ]);
    expect(result).toBe("click [here](https://example.com) for more");
  });

  it("skips text_link when url is missing", () => {
    const result = applyTelegramEntitiesToMarkdown("click here", [
      { type: "text_link", offset: 6, length: 4 },
    ]);
    expect(result).toBe("click here");
  });

  it("applies spoiler formatting", () => {
    const result = applyTelegramEntitiesToMarkdown("secret text here", [
      { type: "spoiler", offset: 0, length: 11 },
    ]);
    expect(result).toBe("<spoiler>secret text</spoiler> here");
  });

  it("ignores unknown entity types", () => {
    const result = applyTelegramEntitiesToMarkdown("@username hello", [
      { type: "mention", offset: 0, length: 9 },
    ]);
    expect(result).toBe("@username hello");
  });

  it("ignores url entity type", () => {
    const result = applyTelegramEntitiesToMarkdown("visit https://example.com now", [
      { type: "url", offset: 6, length: 19 },
    ]);
    expect(result).toBe("visit https://example.com now");
  });

  it("handles multiple non-overlapping entities", () => {
    const result = applyTelegramEntitiesToMarkdown("bold and italic text", [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 9, length: 6 },
    ]);
    expect(result).toBe("**bold** and _italic_ text");
  });

  it("handles nested entities (bold inside italic)", () => {
    // "hello world" with italic over the whole string and bold over "world".
    // The marker-insertion approach inserts markers at their positions in order,
    // so the italic close and bold close both land at position 11. Since italic
    // was added first, its close marker appears first, producing _hello **world_**
    // rather than perfectly nested _hello **world**_. This matches the Signal
    // converter's behaviour and is the expected output of this algorithm.
    const result = applyTelegramEntitiesToMarkdown("hello world", [
      { type: "italic", offset: 0, length: 11 },
      { type: "bold", offset: 6, length: 5 },
    ]);
    expect(result).toBe("_hello **world_**");
  });

  it("handles adjacent entities without bleeding", () => {
    const result = applyTelegramEntitiesToMarkdown("bolditalic", [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 4, length: 6 },
    ]);
    expect(result).toBe("**bold**_italic_");
  });

  it("handles emoji (surrogate pair) correctly with UTF-16 offsets", () => {
    // "Hi 😀 there" — the emoji is U+1F600, which is 2 UTF-16 code units.
    // Telegram would report offset=3 for the emoji (length=2) and offset=6 for " there".
    // We bold " there" which starts at UTF-16 offset 6 (after "Hi " + emoji).
    const text = "Hi \u{1F600} there";
    const result = applyTelegramEntitiesToMarkdown(text, [
      { type: "bold", offset: 6, length: 6 },
    ]);
    expect(result).toBe("Hi \u{1F600} **there**");
  });

  it("handles emoji at the start with correct UTF-16 offsets", () => {
    // "😀 hello" — emoji is 2 UTF-16 units, so "hello" starts at offset 3.
    const text = "\u{1F600} hello";
    const result = applyTelegramEntitiesToMarkdown(text, [
      { type: "bold", offset: 3, length: 5 },
    ]);
    expect(result).toBe("\u{1F600} **hello**");
  });

  it("handles entity spanning the entire text", () => {
    const result = applyTelegramEntitiesToMarkdown("all bold", [
      { type: "bold", offset: 0, length: 8 },
    ]);
    expect(result).toBe("**all bold**");
  });

  it("returns text unchanged when all entities are of ignored types", () => {
    const result = applyTelegramEntitiesToMarkdown("@user #tag /cmd", [
      { type: "mention", offset: 0, length: 5 },
      { type: "hashtag", offset: 6, length: 4 },
      { type: "bot_command", offset: 11, length: 4 },
    ]);
    expect(result).toBe("@user #tag /cmd");
  });
});

describe("Telegram long polling", () => {
  const config: TelegramConfig = { botToken: "test-token" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands updates to the handler and advances the offset to last update_id + 1", async () => {
    interface RecordedCall {
      url: string;
      body: Record<string, unknown>;
    }
    const calls: RecordedCall[] = [];
    const fetchFunction = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (calls.length === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 100, message: { chat: { id: 1 }, text: "first" } },
            { update_id: 101, message: { chat: { id: 1 }, text: "second" } },
          ],
        });
      }
      return jsonResponse({ ok: false, error_code: 500, description: "boom" });
    });
    const sleepFunction = vi.fn(async (): Promise<void> => {
      throw new Error("stop");
    });

    await expect(runTelegramPollingLoop(config, fetchFunction, sleepFunction)).rejects.toThrow("stop");

    expect(enqueueMessage).toHaveBeenCalledTimes(2);
    expect(enqueueMessage).toHaveBeenNthCalledWith(1, "first", "telegram", "1");
    expect(enqueueMessage).toHaveBeenNthCalledWith(2, "second", "telegram", "1");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.offset).toBe(102);
    expect(calls[1].body.timeout).toBe(30);
    expect(calls[1].body.allowed_updates).toEqual(["message"]);
    expect(sleepFunction).toHaveBeenCalledWith(5000);
  });

  it("retries after a thrown error without losing the offset", async () => {
    const offsets: unknown[] = [];
    let callCount = 0;
    const fetchFunction = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      offsets.push(JSON.parse(String(init?.body)).offset);
      if (callCount === 1) {
        throw new Error("network down");
      }
      if (callCount === 2) {
        return jsonResponse({ ok: true, result: [{ update_id: 7, message: { chat: { id: 1 }, text: "hi" } }] });
      }
      return jsonResponse({ ok: false, error_code: 500, description: "boom" });
    });
    // The first sleep lets the loop retry; the second stops it.
    let sleepCount = 0;
    const sleepFunction = vi.fn(async (): Promise<void> => {
      sleepCount += 1;
      if (sleepCount >= 2) {
        throw new Error("stop");
      }
    });

    await expect(runTelegramPollingLoop(config, fetchFunction, sleepFunction)).rejects.toThrow("stop");

    expect(fetchFunction).toHaveBeenCalledTimes(3);
    expect(offsets).toEqual([undefined, undefined, 8]);
    expect(sleepFunction).toHaveBeenCalledWith(5000);
  });

  it("advances the offset per update when a later handler in the batch throws", async () => {
    const enqueueMock = vi.mocked(enqueueMessage);
    enqueueMock.mockImplementationOnce(async () => "ok");
    // A synchronous throw becomes a rejection of handleTelegramUpdate's promise.
    enqueueMock.mockImplementationOnce((): never => {
      throw new Error("handler boom");
    });

    const offsets: unknown[] = [];
    let callCount = 0;
    const fetchFunction = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      offsets.push(JSON.parse(String(init?.body)).offset);
      if (callCount === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 10, message: { chat: { id: 1 }, text: "first" } },
            { update_id: 11, message: { chat: { id: 1 }, text: "second" } },
          ],
        });
      }
      // Reached only if the loop kept going after the second handler threw.
      throw new Error("stop");
    });
    // The first sleep lets the loop retry after the handler throws; the second stops it.
    let sleepCount = 0;
    const sleepFunction = vi.fn(async (): Promise<void> => {
      sleepCount += 1;
      if (sleepCount >= 2) {
        throw new Error("stop-loop");
      }
    });

    await expect(runTelegramPollingLoop(config, fetchFunction, sleepFunction)).rejects.toThrow("stop-loop");

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(fetchFunction).toHaveBeenCalledTimes(2);
    expect(offsets).toEqual([undefined, 11]);
  });

  it("logs a clear conflict message when error_code is 409", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation((): void => {});
    const fetchFunction = vi.fn(async (): Promise<Response> =>
      jsonResponse({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" })
    );
    const sleepFunction = vi.fn(async (): Promise<void> => {
      throw new Error("stop");
    });

    await expect(runTelegramPollingLoop(config, fetchFunction, sleepFunction)).rejects.toThrow("stop");

    const loggedMessage = String(errorSpy.mock.calls[0][0]);
    expect(loggedMessage).toMatch(/409/);
    expect(loggedMessage).toMatch(/another instance/i);
    errorSpy.mockRestore();
  });

  it("throws when deleteWebhook fails", async () => {
    const fetchFunction = vi.fn(async (): Promise<Response> =>
      jsonResponse({ ok: false, description: "nope" })
    );

    await expect(startTelegramPolling(config, fetchFunction)).rejects.toThrow(/delete Telegram webhook/);
  });

  it("awaits deleteWebhook before the first getUpdates", async () => {
    const order: string[] = [];
    const fetchFunction = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/deleteWebhook")) {
        order.push("deleteWebhook");
        return jsonResponse({ ok: true, result: true });
      }
      order.push("getUpdates");
      // Never resolve so the background loop parks without timers.
      return new Promise<Response>(() => {});
    });

    await startTelegramPolling(config, fetchFunction);

    await vi.waitFor(() => {
      expect(order).toContain("getUpdates");
    });
    expect(order[0]).toBe("deleteWebhook");
  });
});
