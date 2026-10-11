import http from "http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmailConfig } from "./config.js";

vi.mock("mailparser", () => ({
  simpleParser: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn(),
}));

vi.mock("./allowlist.js", () => ({
  isInAllowlist: vi.fn(),
  recordRejectedSender: vi.fn(),
}));

vi.mock("./uploads.js", () => ({
  saveAttachment: vi.fn(),
}));

import { handleEmailWebhookRequest } from "./email.js";

function makeConfig(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "bot@example.com",
    smtpPassword: "password",
    fromAddress: "bot@example.com",
    webhookSecret: "test-secret",
    ...overrides,
  };
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

describe("handleEmailWebhookRequest", () => {
  it("returns 401 when Authorization header is missing", () => {
    const request = makeMockRequest("{}");
    const response = makeMockResponse();
    const config = makeConfig();

    handleEmailWebhookRequest(request, response as unknown as http.ServerResponse, config);

    expect(response.statusCode).toBe(401);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toBe("Unauthorized");
  });

  it("returns 401 when Authorization header has wrong token", () => {
    const request = makeMockRequest("{}", { authorization: "Bearer wrong-token" });
    const response = makeMockResponse();
    const config = makeConfig();

    handleEmailWebhookRequest(request, response as unknown as http.ServerResponse, config);

    expect(response.statusCode).toBe(401);
    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toBe("Unauthorized");
  });

  it("returns 200 when Authorization header is correct", async () => {
    const payload = JSON.stringify({ from: "sender@example.com", to: "bot@example.com", raw: "raw email content" });
    const request = makeMockRequest(payload, { authorization: "Bearer test-secret" });
    const response = makeMockResponse();
    const config = makeConfig();

    // Import the mocked simpleParser to set up its return value.
    const { simpleParser } = await import("mailparser");
    vi.mocked(simpleParser).mockResolvedValue({
      subject: "Test",
      text: "Hello",
      html: false,
      attachments: [],
    } as unknown as Awaited<ReturnType<typeof simpleParser>>);

    handleEmailWebhookRequest(request, response as unknown as http.ServerResponse, config);

    // The response is written asynchronously after reading the body.
    await vi.waitFor(() => {
      expect(response.statusCode).toBe(200);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.ok).toBe(true);
  });
});
