import http from "http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "./config.js";

vi.mock("./allowlist.js", () => ({
  getAllowlist: vi.fn(),
  saveAllowlist: vi.fn(),
  getOwnerIdentities: vi.fn(),
  getRejectedSenders: vi.fn(),
}));

import { getAllowlist, saveAllowlist, getOwnerIdentities, getRejectedSenders } from "./allowlist.js";
import { handleGetAllowlistRequest, handlePutAllowlistRequest, serveSettingsHubPage } from "./settings.js";

const mockGetAllowlist = vi.mocked(getAllowlist);
const mockSaveAllowlist = vi.mocked(saveAllowlist);
const mockGetOwnerIdentities = vi.mocked(getOwnerIdentities);
const mockGetRejectedSenders = vi.mocked(getRejectedSenders);

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

interface MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

function makeMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    headers: {},
    body: undefined,
    writeHead(status: number, headers?: Record<string, string>): void {
      this.statusCode = status;
      if (headers) {
        Object.assign(this.headers, headers);
      }
    },
    end(body: string): void {
      this.body = body;
    },
  };
  return response;
}

function makeMockRequest(body: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const chunks = [Buffer.from(body)];
  return {
    headers,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRejectedSenders.mockReturnValue([]);
});

describe("handleGetAllowlistRequest", () => {
  it("returns 200 with allowlist and ownerIdentities", () => {
    mockGetAllowlist.mockReturnValue({ signal: ["+1111111111"], telegram: [42], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [] });

    const response = makeMockResponse();
    const config = makeConfig({ owner: { name: "Owner", signal: "+1111111111" } });

    handleGetAllowlistRequest(response as unknown as http.ServerResponse, config);

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.signal).toEqual(["+1111111111"]);
    expect(parsed.allowlist.telegram).toEqual([42]);
    expect(parsed.ownerIdentities.signal).toEqual(["+1111111111"]);
    expect(parsed.ownerIdentities.telegram).toEqual([]);
  });

  it("returns rejected senders with lastSeen serialized as an ISO string", () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockGetRejectedSenders.mockReturnValue([
      { service: "telegram", identifier: "-100123", label: "Group", lastSeen: new Date("2026-10-11T10:00:00.000Z"), count: 3 },
      { service: "signal", identifier: "+2222222222", label: undefined, lastSeen: new Date("2026-10-11T09:00:00.000Z"), count: 1 },
    ]);

    const response = makeMockResponse();
    handleGetAllowlistRequest(response as unknown as http.ServerResponse, makeConfig());

    const parsed = JSON.parse(response.body!);
    expect(parsed.rejected).toEqual([
      { service: "telegram", identifier: "-100123", label: "Group", lastSeen: "2026-10-11T10:00:00.000Z", count: 3 },
      { service: "signal", identifier: "+2222222222", lastSeen: "2026-10-11T09:00:00.000Z", count: 1 },
    ]);
  });
});

describe("handlePutAllowlistRequest", () => {
  it("saves the allowlist and returns 200 with updated data", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+2222222222"], telegram: [99], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();
    const config = makeConfig();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, config);

    expect(response.statusCode).toBe(200);
    expect(mockSaveAllowlist).toHaveBeenCalledWith({ signal: ["+2222222222"], telegram: [99], whatsapp: [], email: [], notes: {} });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.signal).toEqual(["+2222222222"]);
    expect(parsed.allowlist.telegram).toEqual([99]);
  });

  it.each([
    { name: "the body is not JSON", body: "not json", error: /Invalid JSON/i },
    { name: "the body is not an object", body: JSON.stringify(["+1111111111"]), error: /JSON object/i },
    {
      name: "email is not an array of strings",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [123] }),
      error: /email/i,
    },
    {
      name: "email is missing from the request body",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [] }),
      error: /email/i,
    },
    {
      name: "email contains empty strings",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [""] }),
      error: /email/i,
    },
    {
      name: "email contains an invalid address",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["notanemail"] }),
      error: /notanemail/,
    },
    {
      name: "signal is not an array of strings",
      body: JSON.stringify({ signal: [123], telegram: [], whatsapp: [], email: [] }),
      error: /signal/i,
    },
    {
      name: "signal contains empty strings",
      body: JSON.stringify({ signal: [""], telegram: [], whatsapp: [], email: [] }),
      error: /signal/i,
    },
    {
      name: "signal contains only whitespace",
      body: JSON.stringify({ signal: ["   "], telegram: [], whatsapp: [], email: [] }),
      error: /signal/i,
    },
    {
      name: "signal contains whitespace",
      body: JSON.stringify({ signal: ["not a number"], telegram: [], whatsapp: [], email: [] }),
      error: /not a number.*whitespace/i,
    },
    {
      name: "telegram is not an array of integers",
      body: JSON.stringify({ signal: [], telegram: [42.5], whatsapp: [], email: [] }),
      error: /telegram/i,
    },
    {
      name: "telegram contains numeric strings instead of numbers",
      body: JSON.stringify({ signal: [], telegram: ["42"], whatsapp: [], email: [] }),
      error: /telegram/i,
    },
    {
      name: "whatsapp is not an array of strings",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [123], email: [] }),
      error: /whatsapp/i,
    },
    {
      name: "whatsapp contains a non-E.164 number",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: ["notanumber"], email: [] }),
      error: /notanumber.*E\.164/i,
    },
    {
      name: "notes is not a plain object",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], notes: "not-an-object" }),
      error: /notes/i,
    },
    {
      name: "notes contains non-string values",
      body: JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], notes: { "+1111111111": 42 } }),
      error: /notes/i,
    },
  ])("returns 400 when $name", async ({ body, error }) => {
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(error);
  });

  interface OwnerIdentityRow {
    service: "signal" | "telegram" | "whatsapp" | "email";
    ownerIdentities: { signal: string[]; telegram: number[]; whatsapp: string[]; email: string[] };
    ownerId: string | number;
    submittedId: string | number;
  }

  it.each<OwnerIdentityRow>([
    {
      service: "signal",
      ownerIdentities: { signal: ["+9999999999"], telegram: [], whatsapp: [], email: [] },
      ownerId: "+9999999999",
      submittedId: "+1111111111",
    },
    {
      service: "telegram",
      ownerIdentities: { signal: [], telegram: [12345], whatsapp: [], email: [] },
      ownerId: 12345,
      submittedId: 99,
    },
    {
      service: "whatsapp",
      ownerIdentities: { signal: [], telegram: [], whatsapp: ["+8888888888"], email: [] },
      ownerId: "+8888888888",
      submittedId: "+1111111111",
    },
    {
      service: "email",
      ownerIdentities: { signal: [], telegram: [], whatsapp: [], email: ["owner@example.com"] },
      ownerId: "owner@example.com",
      submittedId: "other@example.com",
    },
  ])("re-adds the missing owner $service identity before saving", async ({ service, ownerIdentities, ownerId, submittedId }) => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue(ownerIdentities);
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's identity.
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], [service]: [submittedId] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved[service]).toContain(ownerId);
    expect(saved[service]).toContain(submittedId);
  });

  it("does not duplicate owner identity when already present in submitted list", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+9999999999"], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+9999999999", "+1111111111"], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal.filter((n: string) => n === "+9999999999")).toHaveLength(1);
  });

  it("accepts UUID and group ID signal entries", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const groupId = "group.abc123+/=";
    const request = makeMockRequest(JSON.stringify({ signal: [uuid, groupId], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toEqual([uuid, groupId]);
  });

  it("trims signal entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(JSON.stringify({ signal: ["  +1111111111  "], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toEqual(["+1111111111"]);
  });

  it.each([
    {
      service: "signal",
      submitted: ["+1111111111", "+2222222222", "+1111111111"],
      expected: ["+1111111111", "+2222222222"],
    },
    { service: "telegram", submitted: [42, 99, 42], expected: [42, 99] },
    {
      service: "whatsapp",
      submitted: ["+1111111111", "+2222222222", "+1111111111"],
      expected: ["+1111111111", "+2222222222"],
    },
    { service: "email", submitted: ["a@b.com", "c@d.com", "a@b.com"], expected: ["a@b.com", "c@d.com"] },
  ] as const)("deduplicates $service entries before saving", async ({ service, submitted, expected }) => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(
      JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], [service]: submitted }),
    );
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved[service]).toEqual(expected);
  });

  it.each(["signal", "telegram", "whatsapp", "email"] as const)(
    "accepts '*' as a valid %s entry and saves it",
    async (service) => {
      mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
      mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
      mockSaveAllowlist.mockImplementation(() => undefined);

      const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], [service]: ["*"] });
      const request = makeMockRequest(body);
      const response = makeMockResponse();

      await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

      expect(response.statusCode).toBe(200);
      const saved = mockSaveAllowlist.mock.calls[0][0];
      expect(saved[service]).toContain("*");
    },
  );

  it("prunes orphaned notes whose keys are not in any service list", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({
      signal: ["+1111111111"],
      telegram: [],
      whatsapp: [],
      email: [],
      notes: { "+1111111111": "Mom", "+9999999999": "Orphan" },
    });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.notes).toEqual({ "+1111111111": "Mom" });
    expect(saved.notes["+9999999999"]).toBeUndefined();
  });

  it("keeps telegram notes using string keys", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({
      signal: [],
      telegram: [123456789],
      whatsapp: [],
      email: [],
      notes: { "123456789": "Work group" },
    });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.notes).toEqual({ "123456789": "Work group" });
  });

  it("normalizes email addresses to lowercase before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["User@Example.COM"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.email).toEqual(["user@example.com"]);
  });

  it("includes email entries in allEntryKeys so email notes are not pruned", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({
      signal: [],
      telegram: [],
      whatsapp: [],
      email: ["user@example.com"],
      notes: { "user@example.com": "Work contact" },
    });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.notes).toEqual({ "user@example.com": "Work contact" });
  });
});

describe("serveSettingsHubPage", () => {
  it("escapes the provider and model instead of injecting markup", () => {
    const response = makeMockResponse();

    serveSettingsHubPage(
      response as unknown as http.ServerResponse,
      makeConfig({ provider: '<img src=x onerror="alert(1)">', model: "<b>m</b>" }),
    );

    expect(response.body).not.toContain("<img src=x");
    expect(response.body).toContain("&lt;img src=x");
    expect(response.body).toContain("&lt;b&gt;m&lt;/b&gt;");
  });
});
