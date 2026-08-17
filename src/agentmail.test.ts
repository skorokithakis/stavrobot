import http from "http";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("svix", () => ({
  Webhook: vi.fn().mockImplementation(() => ({
    verify: vi.fn(),
  })),
}));

vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn(),
}));

vi.mock("./allowlist.js", () => ({
  isInAllowlist: vi.fn(),
}));

import { Webhook } from "svix";
import { isInAllowlist } from "./allowlist.js";
import { enqueueMessage } from "./queue.js";
import {
  setAgentmailWebhookSecret,
  handleAgentmailWebhookRequest,
  handleAgentmailWebhook,
} from "./agentmail.js";

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

describe("handleAgentmailWebhookRequest — secret not set", () => {
  it("returns 401 when webhook secret is not set", async () => {
    vi.clearAllMocks();
    setAgentmailWebhookSecret(undefined);

    const request = makeMockRequest("{}", {
      "svix-id": "id",
      "svix-timestamp": "ts",
      "svix-signature": "sig",
    });
    const response = makeMockResponse();

    handleAgentmailWebhookRequest(request, response as unknown as http.ServerResponse);

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(401);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toBe("Unauthorized");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  setAgentmailWebhookSecret("test-secret");
});

describe("handleAgentmailWebhookRequest", () => {
  it("returns 401 when Svix headers are missing", async () => {
    const request = makeMockRequest("{}");
    const response = makeMockResponse();

    handleAgentmailWebhookRequest(request, response as unknown as http.ServerResponse);

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(401);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toBe("Unauthorized");
  });

  it("returns 401 when Svix signature verification fails", async () => {
    const mockVerify = vi.fn().mockImplementation(() => {
      throw new Error("Invalid signature");
    });
    vi.mocked(Webhook).mockImplementation(() => ({ verify: mockVerify }) as unknown as InstanceType<typeof Webhook>);

    const request = makeMockRequest("{}", {
      "svix-id": "msg_123",
      "svix-timestamp": "1234567890",
      "svix-signature": "v1,invalid",
    });
    const response = makeMockResponse();

    handleAgentmailWebhookRequest(request, response as unknown as http.ServerResponse);

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(401);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.error).toBe("Unauthorized");
  });

  it("returns 200 and ignores non-message.received events", async () => {
    const mockVerify = vi.fn();
    vi.mocked(Webhook).mockImplementation(() => ({ verify: mockVerify }) as unknown as InstanceType<typeof Webhook>);

    const payload = JSON.stringify({ event_type: "message.sent" });
    const request = makeMockRequest(payload, {
      "svix-id": "msg_123",
      "svix-timestamp": "1234567890",
      "svix-signature": "v1,valid",
    });
    const response = makeMockResponse();

    handleAgentmailWebhookRequest(request, response as unknown as http.ServerResponse);

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(200);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.ok).toBe(true);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it("returns 200 and processes message.received events", async () => {
    const mockVerify = vi.fn();
    vi.mocked(Webhook).mockImplementation(() => ({ verify: mockVerify }) as unknown as InstanceType<typeof Webhook>);
    vi.mocked(isInAllowlist).mockReturnValue(true);

    const payload = JSON.stringify({
      event_type: "message.received",
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        subject: "Hello",
        text: "Hi there",
        attachments: [],
      },
    });
    const request = makeMockRequest(payload, {
      "svix-id": "msg_123",
      "svix-timestamp": "1234567890",
      "svix-signature": "v1,valid",
    });
    const response = makeMockResponse();

    handleAgentmailWebhookRequest(request, response as unknown as http.ServerResponse);

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(200);
    });

    const parsed = JSON.parse(response.body!);
    expect(parsed.ok).toBe(true);
  });
});

describe("handleAgentmailWebhook", () => {
  it("parses plain email address from 'from' field", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Hello",
      },
    });

    expect(isInAllowlist).toHaveBeenCalledWith("agentmail", "sender@example.com");
  });

  it("parses display name format 'Display Name <email@example.com>'", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "John Doe <john@example.com>",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Hello",
      },
    });

    expect(isInAllowlist).toHaveBeenCalledWith("agentmail", "john@example.com");
  });

  it("lowercases the email address", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "SENDER@EXAMPLE.COM",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Hello",
      },
    });

    expect(isInAllowlist).toHaveBeenCalledWith("agentmail", "sender@example.com");
  });

  it("returns early without enqueueing when sender is not in allowlist", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(false);

    await handleAgentmailWebhook({
      message: {
        from: "stranger@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Hello",
      },
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it("enqueues message with correct source and sender when allowed", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        subject: "Test Subject",
        text: "Hello world",
      },
    });

    expect(enqueueMessage).toHaveBeenCalledWith(
      expect.stringContaining("Hello world"),
      "agentmail",
      "sender@example.com",
    );
  });

  it("formats message with header line, subject, and text body", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        subject: "Test Subject",
        text: "Hello world",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("[Inbox: inbox-1 | Thread: thread-1 | Message: msg-1]");
    expect(formattedMessage).toContain("Subject: Test Subject");
    expect(formattedMessage).toContain("Hello world");
  });

  it("omits Subject line when subject is undefined", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Hello world",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).not.toContain("Subject:");
    expect(formattedMessage).toContain("Hello world");
  });

  it("omits Subject line when subject is empty string", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        subject: "",
        text: "Hello world",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).not.toContain("Subject:");
  });

  it("uses empty string for text when text is undefined", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
      },
    });

    expect(enqueueMessage).toHaveBeenCalled();
    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("[Inbox: inbox-1 | Thread: thread-1 | Message: msg-1]");
  });

  it("includes attachments section when attachments are present", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "See attached",
        attachments: [
          {
            attachment_id: "att-1",
            filename: "document.pdf",
            size: 12345,
            content_type: "application/pdf",
          },
        ],
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("Attachments:");
    expect(formattedMessage).toContain(
      "- document.pdf (application/pdf, 12345 bytes, attachmentId: att-1)",
    );
  });

  it("omits Attachments section when attachments array is empty", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "No attachments",
        attachments: [],
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).not.toContain("Attachments:");
  });

  it("omits Attachments section when attachments field is absent", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "No attachments",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).not.toContain("Attachments:");
  });

  it("appends HTML section when html is present and no extracted_html", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Plain text",
        html: "<p>HTML content</p>",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("Plain text");
    expect(formattedMessage).toContain("--- HTML version ---");
    expect(formattedMessage).toContain("<p>HTML content</p>");
  });

  it("prefers extracted_html over html when both are present", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Plain text",
        html: "<p>Full HTML with quoted history</p>",
        extracted_html: "<p>Extracted HTML only</p>",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("<p>Extracted HTML only</p>");
    expect(formattedMessage).not.toContain("<p>Full HTML with quoted history</p>");
  });

  it("prefers extracted_text over text when both are present", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Full text with quoted history",
        extracted_text: "Extracted text only",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("Extracted text only");
    expect(formattedMessage).not.toContain("Full text with quoted history");
  });

  it("includes HTML section when only html is available and no text", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        html: "<p>HTML only email</p>",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).toContain("--- HTML version ---");
    expect(formattedMessage).toContain("<p>HTML only email</p>");
  });

  it("omits HTML section when no html fields are present", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "Plain text only",
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    expect(formattedMessage).not.toContain("--- HTML version ---");
  });

  it("HTML section appears before Attachments section", async () => {
    vi.mocked(isInAllowlist).mockReturnValue(true);

    await handleAgentmailWebhook({
      message: {
        from: "sender@example.com",
        inbox_id: "inbox-1",
        thread_id: "thread-1",
        message_id: "msg-1",
        text: "See attached",
        html: "<p>See attached</p>",
        attachments: [
          {
            attachment_id: "att-1",
            filename: "file.pdf",
            size: 100,
            content_type: "application/pdf",
          },
        ],
      },
    });

    const formattedMessage = vi.mocked(enqueueMessage).mock.calls[0][0] as string;
    const htmlIndex = formattedMessage.indexOf("--- HTML version ---");
    const attachmentsIndex = formattedMessage.indexOf("Attachments:");
    expect(htmlIndex).toBeGreaterThan(-1);
    expect(attachmentsIndex).toBeGreaterThan(-1);
    expect(htmlIndex).toBeLessThan(attachmentsIndex);
  });
});
