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
  it.each([
    {
      name: "the file is not a JSON object",
      file: ["+1111111111"],
      error: "allowlist.json must be a JSON object",
    },
    {
      name: "signal is not an array of strings",
      file: { signal: [123], telegram: [] },
      error: "'signal' must be an array of strings",
    },
    {
      name: "signal is missing",
      file: { telegram: [] },
      error: "'signal' must be an array of strings",
    },
    {
      name: "signal is not an array",
      file: { signal: "+1111111111", telegram: [] },
      error: "'signal' must be an array of strings",
    },
    {
      name: "telegram is not an array of numbers",
      file: { signal: [], telegram: ["42"] },
      error: "'telegram' must be an array of numbers",
    },
    {
      name: "telegram is missing",
      file: { signal: ["+1111111111"] },
      error: "'telegram' must be an array of numbers",
    },
    {
      name: "telegram is not an array",
      file: { signal: [], telegram: 42 },
      error: "'telegram' must be an array of numbers",
    },
    {
      name: "whatsapp is not an array of strings",
      file: { signal: [], telegram: [], whatsapp: [123] },
      error: "'whatsapp' must be an array of strings",
    },
    {
      name: "whatsapp is not an array",
      file: { signal: [], telegram: [], whatsapp: "+1111111111" },
      error: "'whatsapp' must be an array of strings",
    },
    {
      name: "email is not an array of strings",
      file: { signal: [], telegram: [], email: [123] },
      error: "'email' must be an array of strings",
    },
    {
      name: "email is not an array",
      file: { signal: [], telegram: [], email: "user@example.com" },
      error: "'email' must be an array of strings",
    },
    {
      name: "notes is not a plain object",
      file: { signal: [], telegram: [], notes: "not-an-object" },
      error: "'notes' must be a plain object",
    },
    {
      name: "notes is an array",
      file: { signal: [], telegram: [], notes: [] },
      error: "'notes' must be a plain object",
    },
    {
      name: "notes contains non-string values",
      file: { signal: [], telegram: [], notes: { "+1111111111": 42 } },
      error: "'notes' values must be strings",
    },
  ])("throws when $name", async ({ file, error }) => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(file));

    const { loadAllowlist } = await import("./allowlist.js");
    expect(() => loadAllowlist(makeConfig())).toThrow(error);
  });

  it("accepts '*' as a valid telegram entry without throwing", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ signal: [], telegram: ["*"] }));
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.telegram).toEqual(["*"]);
  });
});

describe("loadAllowlist", () => {
  it("loads entries and notes from file when allowlist.json exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        signal: ["+1111111111"],
        telegram: [42],
        whatsapp: ["+2222222222"],
        notes: { "+1111111111": "Mom" },
      }),
    );
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const allowlist = loadAllowlist(makeConfig());

    expect(allowlist.signal).toEqual(["+1111111111"]);
    expect(allowlist.telegram).toEqual([42]);
    expect(allowlist.whatsapp).toEqual(["+2222222222"]);
    expect(allowlist.notes).toEqual({ "+1111111111": "Mom" });
  });

  it.each([
    { field: "whatsapp", expected: [] },
    { field: "notes", expected: {} },
    { field: "email", expected: [] },
  ] as const)(
    "defaults $field when the field is absent in an existing allowlist.json",
    async ({ field, expected }) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ signal: ["+1111111111"], telegram: [42] }));
      mockWriteFileSync.mockImplementation(() => undefined);

      const { loadAllowlist } = await import("./allowlist.js");
      const allowlist = loadAllowlist(makeConfig());

      expect(allowlist[field]).toEqual(expected);
    },
  );

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

  it.each([
    { service: "signal", owner: { signal: "+9999999999" }, expected: "+9999999999" },
    { service: "telegram", owner: { telegram: "12345" }, expected: 12345 },
    { service: "whatsapp", owner: { whatsapp: "+9999999999" }, expected: "+9999999999" },
    { service: "email", owner: { email: "owner@example.com" }, expected: "owner@example.com" },
  ] as const)(
    "auto-seeds the owner $service identity when not already present",
    async ({ service, owner, expected }) => {
      mockExistsSync.mockReturnValue(false);
      mockWriteFileSync.mockImplementation(() => undefined);

      const { loadAllowlist } = await import("./allowlist.js");
      const allowlist = loadAllowlist(makeConfig({ owner: { name: "Owner", ...owner } }));

      expect(allowlist[service]).toContain(expected);
    },
  );

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

  it.each([
    { service: "signal", identifier: "+9999999999" },
    { service: "whatsapp", identifier: "+9999999999" },
    { service: "email", identifier: "owner@example.com" },
  ] as const)(
    "does not duplicate the owner $service identity when already present in file",
    async ({ service, identifier }) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], [service]: [identifier] }),
      );
      mockWriteFileSync.mockImplementation(() => undefined);

      const { loadAllowlist } = await import("./allowlist.js");
      const config = makeConfig({ owner: { name: "Owner", [service]: identifier } });
      const allowlist = loadAllowlist(config);

      expect(allowlist[service].filter((entry) => entry === identifier)).toHaveLength(1);
      // No write needed since nothing changed.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    },
  );

  it("normalizes owner email to lowercase when seeding", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", email: "Owner@Example.COM" } });
    const allowlist = loadAllowlist(config);

    expect(allowlist.email).toContain("owner@example.com");
    expect(allowlist.email).not.toContain("Owner@Example.COM");
  });
});

describe("isInAllowlist", () => {
  it.each([
    {
      name: "a signal number in the allowlist",
      stored: { signal: ["+1111111111"] },
      service: "signal",
      identifier: "+1111111111",
      expected: true,
    },
    {
      name: "a signal number not in the allowlist",
      stored: { signal: ["+1111111111"] },
      service: "signal",
      identifier: "+9999999999",
      expected: false,
    },
    {
      name: "a telegram chat ID in the allowlist",
      stored: { telegram: [42] },
      service: "telegram",
      identifier: "42",
      expected: true,
    },
    {
      name: "a telegram chat ID not in the allowlist",
      stored: { telegram: [42] },
      service: "telegram",
      identifier: "99",
      expected: false,
    },
    {
      name: "a telegram identifier that converts to NaN",
      stored: { telegram: [42] },
      service: "telegram",
      identifier: "not-a-number",
      expected: false,
    },
    {
      name: "a telegram identifier that converts to a float",
      stored: { telegram: [42] },
      service: "telegram",
      identifier: "42.5",
      expected: false,
    },
    {
      name: "an unknown service",
      stored: {},
      service: "sms",
      identifier: "+1111111111",
      expected: false,
    },
    {
      name: "a whatsapp number in the allowlist",
      stored: { whatsapp: ["+1111111111"] },
      service: "whatsapp",
      identifier: "+1111111111",
      expected: true,
    },
    {
      name: "a whatsapp number not in the allowlist",
      stored: { whatsapp: ["+1111111111"] },
      service: "whatsapp",
      identifier: "+9999999999",
      expected: false,
    },
    {
      name: "a signal identifier when the allowlist contains '*'",
      stored: { signal: ["*"] },
      service: "signal",
      identifier: "+1111111111",
      expected: true,
    },
    {
      name: "another signal identifier when the allowlist contains '*'",
      stored: { signal: ["*"] },
      service: "signal",
      identifier: "+9999999999",
      expected: true,
    },
    {
      name: "a telegram identifier when the allowlist contains '*'",
      stored: { telegram: ["*"] },
      service: "telegram",
      identifier: "42",
      expected: true,
    },
    {
      name: "another telegram identifier when the allowlist contains '*'",
      stored: { telegram: ["*"] },
      service: "telegram",
      identifier: "99999",
      expected: true,
    },
    {
      name: "a whatsapp identifier when the allowlist contains '*'",
      stored: { whatsapp: ["*"] },
      service: "whatsapp",
      identifier: "+1111111111",
      expected: true,
    },
    {
      name: "another whatsapp identifier when the allowlist contains '*'",
      stored: { whatsapp: ["*"] },
      service: "whatsapp",
      identifier: "+9999999999",
      expected: true,
    },
    {
      name: "an email address in the allowlist",
      stored: { email: ["user@example.com"] },
      service: "email",
      identifier: "user@example.com",
      expected: true,
    },
    {
      name: "an email address not in the allowlist",
      stored: { email: ["user@example.com"] },
      service: "email",
      identifier: "other@example.com",
      expected: false,
    },
    {
      name: "an email address that matches case-insensitively",
      stored: { email: ["user@example.com"] },
      service: "email",
      identifier: "User@Example.COM",
      expected: true,
    },
    {
      name: "an email identifier when the allowlist contains '*'",
      stored: { email: ["*"] },
      service: "email",
      identifier: "anyone@example.com",
      expected: true,
    },
    {
      name: "another email identifier when the allowlist contains '*'",
      stored: { email: ["*"] },
      service: "email",
      identifier: "other@test.org",
      expected: true,
    },
    {
      name: "an email matching a domain wildcard pattern in the allowlist",
      stored: { email: ["*@example.com"] },
      service: "email",
      identifier: "user@example.com",
      expected: true,
    },
    {
      name: "another email matching a domain wildcard pattern in the allowlist",
      stored: { email: ["*@example.com"] },
      service: "email",
      identifier: "other@example.com",
      expected: true,
    },
    {
      name: "an email not matching a domain wildcard pattern in the allowlist",
      stored: { email: ["*@example.com"] },
      service: "email",
      identifier: "user@other.com",
      expected: false,
    },
  ])("returns $expected for $name", async ({ stored, service, identifier, expected }) => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], ...stored }),
    );
    mockWriteFileSync.mockImplementation(() => undefined);

    const { loadAllowlist, isInAllowlist } = await import("./allowlist.js");
    loadAllowlist(makeConfig());

    expect(isInAllowlist(service, identifier)).toBe(expected);
  });
});

describe("matchesEmailEntry", () => {
  it.each([
    { name: "a domain wildcard against an address at that domain", email: "user@example.com", pattern: "*@example.com", expected: true },
    { name: "a domain wildcard against an address at a different domain", email: "user@other.com", pattern: "*@example.com", expected: false },
    // Security test: * must not cross the @ boundary.
    { name: "a domain wildcard against an address with @ in the local part", email: '"user@example.com"@evil.com', pattern: "*@example.com", expected: false },
    { name: "a plus-tag wildcard against a tagged address", email: "myuser+tag@gmail.com", pattern: "myuser+*@gmail.com", expected: true },
    { name: "a plus-tag wildcard against a different local part", email: "other@gmail.com", pattern: "myuser+*@gmail.com", expected: false },
    { name: "an exact pattern against the same address", email: "exact@example.com", pattern: "exact@example.com", expected: true },
    { name: "an exact pattern against a different address", email: "other@example.com", pattern: "exact@example.com", expected: false },
    { name: "the bare wildcard against any address", email: "anyone@anywhere.org", pattern: "*", expected: true },
    { name: "case-insensitively", email: "User@Example.COM", pattern: "*@example.com", expected: true },
  ])("matches $name", async ({ email, pattern, expected }) => {
    const { matchesEmailEntry } = await import("./allowlist.js");
    expect(matchesEmailEntry(email, pattern)).toBe(expected);
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
  });

  it.each([
    {
      name: "signal",
      owner: { signal: "+1234567890" },
      expected: { signal: ["+1234567890"], telegram: [], whatsapp: [], email: [] },
    },
    {
      name: "telegram number",
      owner: { telegram: "99999" },
      expected: { signal: [], telegram: [99999], whatsapp: [], email: [] },
    },
    {
      name: "whatsapp",
      owner: { whatsapp: "+1234567890" },
      expected: { signal: [], telegram: [], whatsapp: ["+1234567890"], email: [] },
    },
    {
      name: "lowercased email",
      owner: { email: "Owner@Example.COM" },
      expected: { signal: [], telegram: [], whatsapp: [], email: ["owner@example.com"] },
    },
  ])("returns the owner $name identity", async ({ owner, expected }) => {
    const { getOwnerIdentities } = await import("./allowlist.js");
    const config = makeConfig({ owner: { name: "Owner", ...owner } });
    expect(getOwnerIdentities(config)).toEqual(expected);
  });
});

describe("rejected-sender buffer", () => {
  it("records a new sender with count 1, most recent first", async () => {
    const { recordRejectedSender, getRejectedSenders } = await import("./allowlist.js");
    recordRejectedSender("telegram", "111", "Group A");
    recordRejectedSender("signal", "+222", undefined);

    const senders = getRejectedSenders();
    expect(senders.map((entry) => [entry.service, entry.identifier])).toEqual([
      ["signal", "+222"],
      ["telegram", "111"],
    ]);
    expect(senders[1].label).toBe("Group A");
    expect(senders[1].count).toBe(1);
    expect(senders[1].lastSeen).toBeInstanceOf(Date);
    expect(senders[0].label).toBeUndefined();
  });

  it("dedupes by service+identifier, bumping count and moving the entry to the front", async () => {
    const { recordRejectedSender, getRejectedSenders } = await import("./allowlist.js");
    recordRejectedSender("telegram", "111", "Group A");
    recordRejectedSender("signal", "+222", undefined);
    recordRejectedSender("telegram", "111", "Group A renamed");

    const senders = getRejectedSenders();
    expect(senders).toHaveLength(2);
    expect(senders[0].identifier).toBe("111");
    expect(senders[0].count).toBe(2);
    expect(senders[0].label).toBe("Group A renamed");
  });

  it("treats the same identifier on different services as separate entries", async () => {
    const { recordRejectedSender, getRejectedSenders } = await import("./allowlist.js");
    recordRejectedSender("telegram", "111", undefined);
    recordRejectedSender("signal", "111", undefined);
    expect(getRejectedSenders()).toHaveLength(2);
  });

  it("caps the buffer at 50 entries, dropping the oldest", async () => {
    const { recordRejectedSender, getRejectedSenders } = await import("./allowlist.js");
    for (let index = 0; index < 55; index += 1) {
      recordRejectedSender("telegram", String(index), undefined);
    }

    const senders = getRejectedSenders();
    expect(senders).toHaveLength(50);
    expect(senders[0].identifier).toBe("54");
    expect(senders[49].identifier).toBe("5");
  });
});
