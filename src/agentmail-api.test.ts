import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWebhooksList = vi.fn();
const mockWebhooksGet = vi.fn();
const mockWebhooksCreate = vi.fn();

vi.mock("agentmail", () => ({
  AgentMailClient: vi.fn().mockImplementation(() => ({
    webhooks: {
      list: mockWebhooksList,
      get: mockWebhooksGet,
      create: mockWebhooksCreate,
    },
  })),
}));

import { initializeAgentmailClient, registerAgentmailWebhook } from "./agentmail-api.js";

beforeEach(() => {
  vi.clearAllMocks();
  initializeAgentmailClient("test-api-key");
});

describe("registerAgentmailWebhook", () => {
  it("creates a new webhook and returns its secret when none exists", async () => {
    mockWebhooksList.mockResolvedValue({ webhooks: [], nextPageToken: undefined });
    mockWebhooksCreate.mockResolvedValue({
      webhookId: "wh_new",
      url: "https://example.com/agentmail/webhook",
      secret: "created-secret",
      enabled: true,
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const secret = await registerAgentmailWebhook("https://example.com");

    expect(mockWebhooksCreate).toHaveBeenCalledWith({
      url: "https://example.com/agentmail/webhook",
      eventTypes: ["message.received"],
    });
    expect(mockWebhooksGet).not.toHaveBeenCalled();
    expect(secret).toBe("created-secret");
  });

  it("fetches full webhook details via get() when a matching webhook is found in list()", async () => {
    mockWebhooksList.mockResolvedValue({
      webhooks: [
        {
          webhookId: "wh_existing",
          url: "https://example.com/agentmail/webhook",
          // secret intentionally absent to simulate production list() behaviour
          enabled: true,
          updatedAt: new Date(),
          createdAt: new Date(),
        },
      ],
      nextPageToken: undefined,
    });
    mockWebhooksGet.mockResolvedValue({
      webhookId: "wh_existing",
      url: "https://example.com/agentmail/webhook",
      secret: "fetched-secret",
      enabled: true,
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const secret = await registerAgentmailWebhook("https://example.com");

    expect(mockWebhooksGet).toHaveBeenCalledWith("wh_existing");
    expect(mockWebhooksCreate).not.toHaveBeenCalled();
    expect(secret).toBe("fetched-secret");
  });

  it("paginates through all webhooks before checking for a match", async () => {
    mockWebhooksList
      .mockResolvedValueOnce({
        webhooks: [
          {
            webhookId: "wh_other",
            url: "https://other.example.com/agentmail/webhook",
            secret: "other-secret",
            enabled: true,
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        ],
        nextPageToken: "page2",
      })
      .mockResolvedValueOnce({
        webhooks: [
          {
            webhookId: "wh_target",
            url: "https://example.com/agentmail/webhook",
            enabled: true,
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        ],
        nextPageToken: undefined,
      });
    mockWebhooksGet.mockResolvedValue({
      webhookId: "wh_target",
      url: "https://example.com/agentmail/webhook",
      secret: "target-secret",
      enabled: true,
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const secret = await registerAgentmailWebhook("https://example.com");

    expect(mockWebhooksList).toHaveBeenCalledTimes(2);
    expect(mockWebhooksGet).toHaveBeenCalledWith("wh_target");
    expect(secret).toBe("target-secret");
  });
});
