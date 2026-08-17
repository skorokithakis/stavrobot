import http from "http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "./config.js";

vi.mock("./allowlist.js", () => ({
  getAllowlist: vi.fn(),
  saveAllowlist: vi.fn(),
  getOwnerIdentities: vi.fn(),
}));

import { getAllowlist, saveAllowlist, getOwnerIdentities } from "./allowlist.js";
import { handleGetAllowlistRequest, handlePutAllowlistRequest, serveAllowlistPage } from "./settings.js";

const mockGetAllowlist = vi.mocked(getAllowlist);
const mockSaveAllowlist = vi.mocked(saveAllowlist);
const mockGetOwnerIdentities = vi.mocked(getOwnerIdentities);

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
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

function makeMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    headers: {},
    body: undefined,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>): void {
      this.statusCode = status;
      if (headers) {
        Object.assign(this.headers, headers);
      }
      this.headersSent = true;
    },
    end(body: string): void {
      this.body = body;
    },
  };
  return response;
}

function makeMockRequest(body: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const chunks = [Buffer.from(body)];
  let index = 0;
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
});

describe("handleGetAllowlistRequest", () => {
  it("returns 200 with allowlist and ownerIdentities", () => {
    mockGetAllowlist.mockReturnValue({ signal: ["+1111111111"], telegram: [42], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [], agentmail: [] });

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

  it("calls getOwnerIdentities with the config", () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });

    const response = makeMockResponse();
    const config = makeConfig();

    handleGetAllowlistRequest(response as unknown as http.ServerResponse, config);

    expect(mockGetOwnerIdentities).toHaveBeenCalledWith(config);
  });

  it("includes notes in the response", () => {
    mockGetAllowlist.mockReturnValue({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [], agentmail: [], notes: { "+1111111111": "Mom" } });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });

    const response = makeMockResponse();
    handleGetAllowlistRequest(response as unknown as http.ServerResponse, makeConfig());

    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.notes).toEqual({ "+1111111111": "Mom" });
  });
});

describe("handlePutAllowlistRequest", () => {
  it("saves the allowlist and returns 200 with updated data", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+2222222222"], telegram: [99], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();
    const config = makeConfig();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, config);

    expect(response.statusCode).toBe(200);
    expect(mockSaveAllowlist).toHaveBeenCalledWith({ signal: ["+2222222222"], telegram: [99], whatsapp: [], email: [], agentmail: [], notes: {} });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.signal).toEqual(["+2222222222"]);
    expect(parsed.allowlist.telegram).toEqual([99]);
  });

  it("returns 400 for invalid JSON", async () => {
    const request = makeMockRequest("not json");
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/Invalid JSON/i);
  });

  it("returns 400 when body is not an object", async () => {
    const request = makeMockRequest(JSON.stringify(["+1111111111"]));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/JSON object/i);
  });

  it("returns 400 when signal is not an array of strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [123], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/signal/i);
  });

  it("returns 400 when signal contains empty strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [""], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/signal/i);
  });

  it("returns 400 when telegram is not an array of integers", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [42.5], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/telegram/i);
  });

  it("returns 400 when telegram contains strings instead of numbers", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: ["42"], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/telegram/i);
  });

  it("re-adds missing owner signal identity before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+9999999999"], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's number.
    const body = JSON.stringify({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toContain("+9999999999");
    expect(saved.signal).toContain("+1111111111");
  });

  it("re-adds missing owner telegram identity before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [12345], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's chat ID.
    const body = JSON.stringify({ signal: [], telegram: [99], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.telegram).toContain(12345);
    expect(saved.telegram).toContain(99);
  });

  it("does not duplicate owner identity when already present in submitted list", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+9999999999"], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+9999999999", "+1111111111"], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal.filter((n: string) => n === "+9999999999")).toHaveLength(1);
  });

  it("returns ownerIdentities in the response", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: ["+9999999999"], telegram: [12345], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+9999999999"], telegram: [12345], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    const parsed = JSON.parse(response.body!);
    expect(parsed.ownerIdentities.signal).toEqual(["+9999999999"]);
    expect(parsed.ownerIdentities.telegram).toEqual([12345]);
  });

  it("returns 400 when signal contains a non-E.164 number", async () => {
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });

    const request = makeMockRequest(JSON.stringify({ signal: ["banana"], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/banana/);
    expect(parsed.error).toMatch(/E\.164/i);
  });

  it("returns 400 when signal number is missing the leading plus sign", async () => {
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });

    const request = makeMockRequest(JSON.stringify({ signal: ["12345678901"], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/E\.164/i);
  });

  it("returns 400 when signal contains whitespace-only strings", async () => {
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });

    const request = makeMockRequest(JSON.stringify({ signal: ["   "], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/signal/i);
  });

  it("trims signal entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(JSON.stringify({ signal: ["  +1111111111  "], telegram: [], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toEqual(["+1111111111"]);
  });

  it("deduplicates signal entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(
      JSON.stringify({ signal: ["+1111111111", "+2222222222", "+1111111111"], telegram: [], whatsapp: [], email: [] }),
    );
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toEqual(["+1111111111", "+2222222222"]);
  });

  it("deduplicates telegram entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [42, 99, 42], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.telegram).toEqual([42, 99]);
  });

  it("saves whatsapp entries and returns them in the response", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: ["+3333333333"], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    expect(mockSaveAllowlist).toHaveBeenCalledWith({ signal: [], telegram: [], whatsapp: ["+3333333333"], email: [], agentmail: [], notes: {} });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.whatsapp).toEqual(["+3333333333"]);
  });

  it("returns 400 when whatsapp is not an array of strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [123], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/whatsapp/i);
  });

  it("returns 400 when whatsapp contains a non-E.164 number", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: ["notanumber"], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/notanumber/);
    expect(parsed.error).toMatch(/E\.164/i);
  });

  it("deduplicates whatsapp entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const request = makeMockRequest(
      JSON.stringify({ signal: [], telegram: [], whatsapp: ["+1111111111", "+2222222222", "+1111111111"], email: [] }),
    );
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.whatsapp).toEqual(["+1111111111", "+2222222222"]);
  });

  it("re-adds missing owner whatsapp identity before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: ["+8888888888"], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's WhatsApp number.
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: ["+1111111111"], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.whatsapp).toContain("+8888888888");
    expect(saved.whatsapp).toContain("+1111111111");
  });

  it("accepts '*' as a valid signal entry and saves it", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["*"], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.signal).toContain("*");
  });

  it("accepts '*' as a valid telegram entry and saves it", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: ["*"], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.telegram).toContain("*");
  });

  it("accepts '*' as a valid whatsapp entry and saves it", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: ["*"], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.whatsapp).toContain("*");
  });

  it("returns 400 when telegram contains a non-integer string other than '*'", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: ["notanumber"], whatsapp: [], email: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/telegram/i);
  });

  it("saves notes when provided and returns them in the response", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [], notes: { "+1111111111": "Mom" } });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.notes).toEqual({ "+1111111111": "Mom" });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.notes).toEqual({ "+1111111111": "Mom" });
  });

  it("defaults notes to {} when absent from request body", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: ["+1111111111"], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.notes).toEqual({});
  });

  it("prunes orphaned notes whose keys are not in any service list", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
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
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
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

  it("returns 400 when notes is not a plain object", async () => {
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], notes: "not-an-object" });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/notes/i);
  });

  it("returns 400 when notes contains non-string values", async () => {
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], notes: { "+1111111111": 42 } });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/notes/i);
  });
  it("saves email entries and returns them in the response", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["user@example.com"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    expect(mockSaveAllowlist).toHaveBeenCalledWith({ signal: [], telegram: [], whatsapp: [], email: ["user@example.com"], agentmail: [], notes: {} });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.email).toEqual(["user@example.com"]);
  });

  it("returns 400 when email is not an array of strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [123] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/email/i);
  });

  it("returns 400 when email contains empty strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [""] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/email/i);
  });

  it("returns 400 when email contains an invalid address", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["notanemail"] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/notanemail/);
  });

  it("returns 400 when email is missing from the request body", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/email/i);
  });

  it("normalizes email addresses to lowercase before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["User@Example.COM"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.email).toEqual(["user@example.com"]);
  });

  it("deduplicates email entries before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["a@b.com", "c@d.com", "a@b.com"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.email).toEqual(["a@b.com", "c@d.com"]);
  });

  it("accepts '*' as a valid email entry and saves it", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["*"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.email).toContain("*");
  });

  it("re-adds missing owner email identity before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: ["owner@example.com"], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's email.
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: ["other@example.com"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.email).toContain("owner@example.com");
    expect(saved.email).toContain("other@example.com");
  });

  it("includes email entries in allEntryKeys so email notes are not pruned", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
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

  it("saves agentmail entries and returns them in the response", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["user@agentmail.io"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    expect(mockSaveAllowlist).toHaveBeenCalledWith({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["user@agentmail.io"], notes: {} });
    const parsed = JSON.parse(response.body!);
    expect(parsed.allowlist.agentmail).toEqual(["user@agentmail.io"]);
  });

  it("returns 400 when agentmail is not an array of strings", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [123] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/agentmail/i);
  });

  it("returns 400 when agentmail contains an invalid address", async () => {
    const request = makeMockRequest(JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["notanemail"] }));
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toMatch(/notanemail/);
  });

  it("re-adds missing owner agentmail identity before saving", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["owner@agentmail.io"] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Submit without the owner's agentmail address.
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["other@agentmail.io"] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.agentmail).toContain("owner@agentmail.io");
    expect(saved.agentmail).toContain("other@agentmail.io");
  });

  it("preserves existing agentmail entries when agentmail is absent from request body", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: ["existing@agentmail.io"], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    // Body omits agentmail entirely — existing entries must not be wiped.
    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.agentmail).toContain("existing@agentmail.io");
  });

  it("uses empty agentmail when absent from request body and stored list is empty", async () => {
    mockGetAllowlist.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [], notes: {} });
    mockGetOwnerIdentities.mockReturnValue({ signal: [], telegram: [], whatsapp: [], email: [], agentmail: [] });
    mockSaveAllowlist.mockImplementation(() => undefined);

    const body = JSON.stringify({ signal: [], telegram: [], whatsapp: [], email: [] });
    const request = makeMockRequest(body);
    const response = makeMockResponse();

    await handlePutAllowlistRequest(request, response as unknown as http.ServerResponse, makeConfig());

    expect(response.statusCode).toBe(200);
    const saved = mockSaveAllowlist.mock.calls[0][0];
    expect(saved.agentmail).toEqual([]);
  });
});

describe("serveAllowlistPage", () => {
  it("returns 200 with HTML content type", () => {
    const response = makeMockResponse();

    serveAllowlistPage(response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("returns HTML containing the settings heading", () => {
    const response = makeMockResponse();

    serveAllowlistPage(response as unknown as http.ServerResponse);

    expect(response.body).toContain("<h1>Settings</h1>");
  });

  it("returns HTML containing the Signal, Telegram, WhatsApp, Email, and Agentmail sections", () => {
    const response = makeMockResponse();

    serveAllowlistPage(response as unknown as http.ServerResponse);

    expect(response.body).toContain("Signal allowlist");
    expect(response.body).toContain("Telegram allowlist");
    expect(response.body).toContain("WhatsApp allowlist");
    expect(response.body).toContain("Email allowlist");
    expect(response.body).toContain("Agentmail allowlist");
  });
});
