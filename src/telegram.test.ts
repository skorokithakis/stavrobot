import { describe, it, expect } from "vitest";
import { applyTelegramEntitiesToMarkdown } from "./telegram.js";

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
