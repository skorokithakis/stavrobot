import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

vi.mock("fs");

const mockReadFileSync = vi.mocked(fs.readFileSync);

// A minimal valid TOML config that satisfies all existing required fields.
const BASE_TOML = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;

function setupMocks(toml: string): void {
  mockReadFileSync.mockImplementation((path: unknown) => {
    if (path === "config.toml") return toml;
    if (path === "prompts/system-prompt.txt") return "You are a bot.";
    if (path === "prompts/compaction-prompt.txt") return "Compaction prompt.";
    if (path === "prompts/compaction-bullet-prompt.txt") return "Bullet prompt. Target: {target} tokens maximum.";
    if (path === "prompts/agent-prompt.txt") return "You are Stavrobot.";
    throw new Error(`Unexpected readFileSync call: ${String(path)}`);
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadConfig owner validation", () => {
  it("loads successfully when [owner] section is present with a name", async () => {
    setupMocks(BASE_TOML);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.owner.name).toBe("Stavros");
  });

  it("throws when [owner] section is missing", async () => {
    const tomlWithoutOwner = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
`;
    setupMocks(tomlWithoutOwner);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config must specify an [owner] section.");
  });

  it("throws when [owner] name is missing", async () => {
    const tomlWithEmptyOwner = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
signal = "+1234567890"
`;
    setupMocks(tomlWithEmptyOwner);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config [owner] section must specify a non-empty name.");
  });

  it("throws when [owner] name is an empty string", async () => {
    const tomlWithEmptyName = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
name = ""
`;
    setupMocks(tomlWithEmptyName);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config [owner] section must specify a non-empty name.");
  });

  it("parses optional signal and telegram fields", async () => {
    const tomlWithIdentities = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
signal = "+1234567890"
telegram = "987654321"
`;
    setupMocks(tomlWithIdentities);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.owner.signal).toBe("+1234567890");
    expect(config.owner.telegram).toBe("987654321");
  });

  it("allows owner with only a name and no channel identities", async () => {
    setupMocks(BASE_TOML);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.owner.signal).toBeUndefined();
    expect(config.owner.telegram).toBeUndefined();
  });

  it("loads baseAgentPrompt from agent-prompt.txt", async () => {
    setupMocks(BASE_TOML);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.baseAgentPrompt).toBe("You are Stavrobot.");
  });
});

describe("loadConfig compactionTokenThreshold", () => {
  it("defaults to 80000 when the key is omitted from the TOML", async () => {
    setupMocks(BASE_TOML);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.compactionTokenThreshold).toBe(80000);
  });

  it("uses the value from TOML when the key is present", async () => {
    const tomlWithThreshold = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
compactionTokenThreshold = 50000

[owner]
name = "Stavros"
`;
    setupMocks(tomlWithThreshold);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.compactionTokenThreshold).toBe(50000);
  });
});

describe("loadConfig openai-compatible provider validation", () => {
  it("throws when provider is openai-compatible and baseUrl is missing", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config must specify baseUrl when provider is \"openai-compatible\".");
  });

  it("throws when baseUrl is set for a non-openai-compatible provider", async () => {
    const toml = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
baseUrl = "http://localhost:8317/v1"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config baseUrl is only valid when provider is \"openai-compatible\".");
  });

  it("loads successfully for openai-compatible provider with baseUrl", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
baseUrl = "http://localhost:8317/v1"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.baseUrl).toBe("http://localhost:8317/v1");
    expect(config.contextWindow).toBeUndefined();
    expect(config.maxTokens).toBeUndefined();
  });

  it("throws when baseUrl is empty for openai-compatible provider", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
baseUrl = ""
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config baseUrl must not be empty.");
  });

  it("throws when baseUrl is whitespace-only for openai-compatible provider", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
baseUrl = "   "
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config baseUrl must not be empty.");
  });

  it("throws when baseUrl does not start with http:// or https://", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
baseUrl = "localhost:8317/v1"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config baseUrl must start with http:// or https://.");
  });

  it("loads contextWindow and maxTokens overrides when set", async () => {
    const toml = `
provider = "openai-compatible"
model = "claude-sonnet-4-6"
apiKey = "test-key"
baseUrl = "http://localhost:8317/v1"
contextWindow = 200000
maxTokens = 64000
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.contextWindow).toBe(200000);
    expect(config.maxTokens).toBe(64000);
  });
});
