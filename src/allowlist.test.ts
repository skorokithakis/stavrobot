import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { Config } from "./config.js";

vi.mock("fs");

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    publicHostname: "https://example.com",
    baseSystemPrompt: "You are a bot.",
    compactionPrompt: "Compact.",
    baseAgentPrompt: "You are Stavrobot.",
    owner: { name: "Owner" },
    ...overrides,
  } as Config;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadAllowlist — malformed file", () => {
  it("throws when the file is not a JSON object", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(["+1111111111"]));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("allowlist.json must be a JSON object");
  });

  it("throws when signal is missing", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ telegram: [42] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'signal' must be an array of strings");
  });

  it("throws when telegram is missing", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'telegram' must be an array of numbers");
  });

  it("throws when whatsapp contains non-strings", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: [123] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'whatsapp' must be an array of strings");
  });

  it("throws when whatsapp is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: "+1111111111" }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'whatsapp' must be an array of strings");
  });

  it("throws when email contains non-strings", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: [123] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'email' must be an array of strings");
  });

  it("throws when email is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: "user@example.com" }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'email' must be an array of strings");
  });

  it("throws when agentmail contains non-strings", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: [123] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'agentmail' must be an array of strings");
  });

  it("throws when agentmail is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: "user@agentmail.io" }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'agentmail' must be an array of strings");
  });

  it("throws when signal contains non-strings", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [123], telegram: [] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'signal' must be an array of strings");
  });

  it("throws when telegram contains non-numbers", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: ["42"] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'telegram' must be an array of numbers");
  });

  it("accepts '*' as a valid telegram entry without throwing", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.telegram).toEqual(["*"]);
  });

  it("throws when signal is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: "+1111111111", telegram: [] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'signal' must be an array of strings");
  });

  it("throws when telegram is not an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: 42 }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'telegram' must be an array of numbers");
  });

  it("throws when notes is not a plain object", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], notes: "not-an-object" }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'notes' must be a plain object");
  });

  it("throws when notes is an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], notes: [] }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'notes' must be a plain object");
  });

  it("throws when notes contains non-string values", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], notes: { "+1111111111": 42 } }));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow("'notes' values must be strings");
  });
});

describe("loadAllowlist", () => {
  it("loads from file when allowlist.json exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42], whatsapp: ["+2222222222"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig();
    const allowlist = loadAllowlist(config);

    expect(allowlist.signal).toEqual(["+1111111111"]);
    expect(allowlist.telegram).toEqual([42]);
    expect(allowlist.whatsapp).toEqual(["+2222222222"]);
  });

  it("defaults whatsapp to [] when field is absent in existing allowlist.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.whatsapp).toEqual([]);
  });

  it("defaults notes to {} when field is absent in existing allowlist.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.notes).toEqual({});
  });

  it("loads notes from file when present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ signal: ["+1111111111"], telegram: [42], notes: { "+1111111111": "Mom" } }),
    );
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.notes).toEqual({ "+1111111111": "Mom" });
  });

  it("creates an empty allowlist when file does not exist and no config values", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig();
    const allowlist = loadAllowlist(config);

    expect(allowlist.signal).toEqual([]);
    expect(allowlist.telegram).toEqual([]);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("migrates allowedNumbers and allowedChatIds from config when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({
      signal: { account: "+0000000000", allowedNumbers: ["+1111111111", "+2222222222"] },
      telegram: { botToken: "tok", allowedChatIds: [100, 200] },
    });
    const allowlist = loadAllowlist(config);

    expect(allowlist.signal).toContain("+1111111111");
    expect(allowlist.signal).toContain("+2222222222");
    expect(allowlist.telegram).toContain(100);
    expect(allowlist.telegram).toContain(200);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("auto-seeds owner signal identity when not already present", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", signal: "+9999999999" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.signal).toContain("+9999999999");
  });

  it("auto-seeds owner telegram identity when not already present", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", telegram: "12345" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.telegram).toContain(12345);
  });

  it("does not duplicate owner identity when already present in file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+9999999999"], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", signal: "+9999999999" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.signal.filter((n) => n === "+9999999999")).toHaveLength(1);
    // No write needed since nothing changed.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("saves after auto-seeding owner identity", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", signal: "+9999999999" } });
    loadAllowlist(config);

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it("skips owner telegram seed and does not throw when owner.telegram is not a valid integer", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", telegram: "not-a-number" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.telegram).toEqual([]);
  });

  it("auto-seeds owner whatsapp identity when not already present", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", whatsapp: "+9999999999" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.whatsapp).toContain("+9999999999");
  });

  it("does not duplicate owner whatsapp identity when already present in file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: ["+9999999999"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", whatsapp: "+9999999999" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.whatsapp.filter((n) => n === "+9999999999")).toHaveLength(1);
    // No write needed since nothing changed.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("defaults email to [] when field is absent in existing allowlist.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.email).toEqual([]);
  });

  it("auto-seeds owner email identity when not already present", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "owner@example.com" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.email).toContain("owner@example.com");
  });

  it("normalizes owner email to lowercase when seeding", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "Owner@Example.COM" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.email).toContain("owner@example.com");
    expect(allowlist.email).not.toContain("Owner@Example.COM");
  });

  it("does not duplicate owner email identity when already present in file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["owner@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "owner@example.com" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.email.filter((e) => e === "owner@example.com")).toHaveLength(1);
    // No write needed since nothing changed.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("defaults agentmail to [] when field is absent in existing allowlist.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.agentmail).toEqual([]);
  });

  it("auto-seeds owner agentmail identity when not already present", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", agentmail: "owner@agentmail.io" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.agentmail).toContain("owner@agentmail.io");
  });

  it("normalizes owner agentmail to lowercase when seeding", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", agentmail: "Owner@Agentmail.IO" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.agentmail).toContain("owner@agentmail.io");
    expect(allowlist.agentmail).not.toContain("Owner@Agentmail.IO");
  });

  it("does not duplicate owner agentmail identity when already present in file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["owner@agentmail.io"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", agentmail: "owner@agentmail.io" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.agentmail.filter((e) => e === "owner@agentmail.io")).toHaveLength(1);
    // No write needed since nothing changed.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("getAllowlist", () => {
  it("returns the in-memory allowlist after loading", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, getAllowlist } = await import("./allowlist.js");
    const config = makeConfig();
    loadAllowlist(config);

    const allowlist = getAllowlist();
    expect(allowlist.signal).toEqual(["+1111111111"]);
    expect(allowlist.telegram).toEqual([42]);
    expect(allowlist.notes).toEqual({});
  });

  it("includes notes in the returned copy", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ signal: ["+1111111111"], telegram: [42], notes: { "+1111111111": "Mom" } }),
    );
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, getAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    const allowlist = getAllowlist();
    expect(allowlist.notes).toEqual({ "+1111111111": "Mom" });
  });
});

describe("saveAllowlist", () => {
  it("writes pretty-printed JSON to the file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, saveAllowlist, getAllowlist } = await import("./allowlist.js");
    const config = makeConfig();
    loadAllowlist(config);

    const newAllowlist = { signal: ["+5555555555"], telegram: [99], whatsapp: ["+7777777777"], email: [], agentmail: [], notes: { "+5555555555": "Test note" } };
    saveAllowlist(newAllowlist);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain("\n");
    expect(JSON.parse(written)).toEqual(newAllowlist);
    expect(getAllowlist()).toEqual(newAllowlist);
  });

  it("writes notes to the file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, saveAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    saveAllowlist({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [], agentmail: [], notes: { "+1111111111": "Work" } });

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.notes).toEqual({ "+1111111111": "Work" });
  });
});

describe("isInAllowlist", () => {
  it("returns true for a signal number in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("signal", "+1111111111")).toBe(true);
  });

  it("returns false for a signal number not in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("signal", "+9999999999")).toBe(false);
  });

  it("returns true for a telegram chat ID in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("telegram", "42")).toBe(true);
  });

  it("returns false for a telegram chat ID not in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("telegram", "99")).toBe(false);
  });

  it("returns false for an unknown service", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("sms", "+1111111111")).toBe(false);
  });

  it("returns true for a whatsapp number in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: ["+1111111111"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("whatsapp", "+1111111111")).toBe(true);
  });

  it("returns false for a whatsapp number not in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: ["+1111111111"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("whatsapp", "+9999999999")).toBe(false);
  });

  it("returns false for a telegram identifier that converts to NaN", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("telegram", "not-a-number")).toBe(false);
  });

  it("returns false for a telegram identifier that converts to a float", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [42] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("telegram", "42.5")).toBe(false);
  });

  it("returns true for any signal identifier when the allowlist contains '*'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["*"], telegram: [] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("signal", "+1111111111")).toBe(true);
    expect(isInAllowlist("signal", "+9999999999")).toBe(true);
  });

  it("returns true for any telegram identifier when the allowlist contains '*'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("telegram", "42")).toBe(true);
    expect(isInAllowlist("telegram", "99999")).toBe(true);
  });

  it("returns true for any whatsapp identifier when the allowlist contains '*'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], whatsapp: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("whatsapp", "+1111111111")).toBe(true);
    expect(isInAllowlist("whatsapp", "+9999999999")).toBe(true);
  });

  it("returns true for an email address in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["user@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "user@example.com")).toBe(true);
  });

  it("returns false for an email address not in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["user@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "other@example.com")).toBe(false);
  });

  it("matches email case-insensitively", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["user@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "User@Example.COM")).toBe(true);
  });

  it("returns true for any email identifier when the allowlist contains '*'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "anyone@example.com")).toBe(true);
    expect(isInAllowlist("email", "other@test.org")).toBe(true);
  });

  it("returns true for an email matching a domain wildcard pattern in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["*@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "user@example.com")).toBe(true);
    expect(isInAllowlist("email", "other@example.com")).toBe(true);
  });

  it("returns false for an email not matching a domain wildcard pattern in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], email: ["*@example.com"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("email", "user@other.com")).toBe(false);
  });

  it("returns true for an agentmail address in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["user@agentmail.io"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("agentmail", "user@agentmail.io")).toBe(true);
  });

  it("returns false for an agentmail address not in the allowlist", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["user@agentmail.io"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("agentmail", "other@agentmail.io")).toBe(false);
  });

  it("matches agentmail case-insensitively", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["user@agentmail.io"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("agentmail", "User@Agentmail.IO")).toBe(true);
  });

  it("returns true for any agentmail identifier when the allowlist contains '*'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("agentmail", "anyone@agentmail.io")).toBe(true);
    expect(isInAllowlist("agentmail", "other@test.org")).toBe(true);
  });

  it("returns true for an agentmail address matching a domain wildcard pattern", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: [], agentmail: ["*@agentmail.io"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist("agentmail", "user@agentmail.io")).toBe(true);
    expect(isInAllowlist("agentmail", "other@agentmail.io")).toBe(true);
  });
});

describe("matchesEmailEntry", () => {
  it("matches a domain wildcard against an address at that domain", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("user@example.com", "*@example.com")).toBe(true);
  });

  it("does not match a domain wildcard against an address at a different domain", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("user@other.com", "*@example.com")).toBe(false);
  });

  it("does not match a domain wildcard against an address with @ in the local part", async () => {
    // Security test: * must not cross the @ boundary.
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry('"user@example.com"@evil.com', "*@example.com")).toBe(false);
  });

  it("matches a plus-tag wildcard against a tagged address", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("myuser+tag@gmail.com", "myuser+*@gmail.com")).toBe(true);
  });

  it("does not match a plus-tag wildcard against a different local part", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("other@gmail.com", "myuser+*@gmail.com")).toBe(false);
  });

  it("matches an exact pattern against the same address", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("exact@example.com", "exact@example.com")).toBe(true);
  });

  it("does not match an exact pattern against a different address", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("other@example.com", "exact@example.com")).toBe(false);
  });

  it("matches any address when the pattern is the bare wildcard *", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("anyone@anywhere.org", "*")).toBe(true);
  });

  it("matches case-insensitively", async () => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry("User@Example.COM", "*@example.com")).toBe(true);
  });
});

describe("getOwnerIdentities", () => {
  it("returns empty arrays when owner has no channel identities", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner" } });
    const identities = getOwnerIdentities(config);

    expect(identities.signal).toEqual([]);
    expect(identities.telegram).toEqual([]);
    expect(identities.whatsapp).toEqual([]);
    expect(identities.email).toEqual([]);
    expect(identities.agentmail).toEqual([]);
  });

  it("returns the owner signal number when set", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", signal: "+1234567890" } });
    const identities = getOwnerIdentities(config);

    expect(identities.signal).toEqual(["+1234567890"]);
  });

  it("returns the owner telegram ID as a number when set", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", telegram: "99999" } });
    const identities = getOwnerIdentities(config);

    expect(identities.telegram).toEqual([99999]);
  });

  it("returns the owner whatsapp number when set", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", whatsapp: "+1234567890" } });
    const identities = getOwnerIdentities(config);

    expect(identities.whatsapp).toEqual(["+1234567890"]);
  });

  it("returns the owner email address when set", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "owner@example.com" } });
    const identities = getOwnerIdentities(config);

    expect(identities.email).toEqual(["owner@example.com"]);
  });

  it("normalizes owner email to lowercase in getOwnerIdentities", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "Owner@Example.COM" } });
    const identities = getOwnerIdentities(config);

    expect(identities.email).toEqual(["owner@example.com"]);
  });

  it("returns the owner agentmail address when set", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", agentmail: "owner@agentmail.io" } });
    const identities = getOwnerIdentities(config);

    expect(identities.agentmail).toEqual(["owner@agentmail.io"]);
  });

  it("normalizes owner agentmail to lowercase in getOwnerIdentities", async () => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", agentmail: "Owner@Agentmail.IO" } });
    const identities = getOwnerIdentities(config);

    expect(identities.agentmail).toEqual(["owner@agentmail.io"]);
  });
});
