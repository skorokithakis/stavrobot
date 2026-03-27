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
  vi.resetModules();
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

describe("loadConfig baseUrl validation", () => {
  const BASE_TOML_WITH_BASE_URL = `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
contextWindow = 128000
maxTokens = 8192
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;

  it("loads successfully when baseUrl is set with all required fields", async () => {
    setupMocks(BASE_TOML_WITH_BASE_URL);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.contextWindow).toBe(128000);
    expect(config.maxTokens).toBe(8192);
  });

  it("defaults api to openai-completions when baseUrl is set and api is omitted", async () => {
    setupMocks(BASE_TOML_WITH_BASE_URL);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.api).toBe("openai-completions");
  });

  it("uses the api value from TOML when baseUrl is set and api is specified", async () => {
    const toml = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "proxy-key"
baseUrl = "https://proxy.example.com"
contextWindow = 200000
maxTokens = 8192
api = "anthropic-messages"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.api).toBe("anthropic-messages");
  });

  it("throws when baseUrl is set and api is an unsupported value", async () => {
    const toml = `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
contextWindow = 128000
maxTokens = 8192
api = "openai-responses"
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow(
      'Config api must be one of: openai-completions, anthropic-messages. Got: "openai-responses".',
    );
  });

  it("throws when baseUrl and authFile are both set", async () => {
    const toml = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
authFile = "/app/data/auth.json"
baseUrl = "https://proxy.example.com"
contextWindow = 200000
maxTokens = 8192
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config must not specify both baseUrl and authFile.");
  });

  it("throws when baseUrl is set but contextWindow is missing", async () => {
    const toml = `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
maxTokens = 8192
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config must specify contextWindow when baseUrl is set.");
  });

  it("throws when baseUrl is set but maxTokens is missing", async () => {
    const toml = `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
contextWindow = 128000
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config must specify maxTokens when baseUrl is set.");
  });

  it("ignores baseUrl-related fields when baseUrl is absent", async () => {
    setupMocks(BASE_TOML);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.baseUrl).toBeUndefined();
    expect(config.contextWindow).toBeUndefined();
    expect(config.maxTokens).toBeUndefined();
    expect(config.api).toBeUndefined();
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
