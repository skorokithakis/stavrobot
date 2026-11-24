import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import { getConfigPath, parseConfig } from "./config.js";

vi.mock("fs");

const mockReadFileSync = vi.mocked(fs.readFileSync);

// A minimal valid TOML config that satisfies all existing required fields.
const BASE_TOML = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
password = "test-password"

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

afterEach((): void => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("parseConfig", (): void => {
  it("parses and validates TOML without loading prompt files", (): void => {
    const config = parseConfig(BASE_TOML);

    expect(config.owner.name).toBe("Stavros");
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("requires a non-empty password", (): void => {
    expect(() => parseConfig(BASE_TOML.replace('password = "test-password"', 'password = ""'))).toThrow(
      "Config must specify a password.",
    );
    expect(() => parseConfig(BASE_TOML.replace('password = "test-password"\n', ""))).toThrow(
      "Config must specify a password.",
    );
  });
});

describe("getConfigPath", (): void => {
  it("falls back to config.toml when CONFIG_PATH is empty", (): void => {
    const previousConfigPath = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = "";
    try {
      expect(getConfigPath()).toBe("config.toml");
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.CONFIG_PATH;
      } else {
        process.env.CONFIG_PATH = previousConfigPath;
      }
    }
  });
});

describe("loadConfig owner validation", () => {
  it.each([
    {
      name: "[owner] section is missing",
      toml: `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
`,
      error: "Config must specify an [owner] section.",
    },
    {
      name: "[owner] name is missing",
      toml: `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
signal = "+1234567890"
`,
      error: "Config [owner] section must specify a non-empty name.",
    },
    {
      name: "[owner] name is an empty string",
      toml: `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"

[owner]
name = ""
`,
      error: "Config [owner] section must specify a non-empty name.",
    },
  ])("throws when $name", async ({ toml, error }) => {
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow(error);
  });

  it("parses optional signal and telegram fields", async () => {
    const tomlWithIdentities = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
password = "test-password"

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
password = "test-password"

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
password = "test-password"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.api).toBe("anthropic-messages");
  });

  it.each([
    {
      name: "api is an unsupported value",
      toml: `
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
`,
      error: 'Config api must be one of: openai-completions, anthropic-messages. Got: "openai-responses".',
    },
    {
      name: "baseUrl and authFile are both set",
      toml: `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
authFile = "/app/data/auth.json"
baseUrl = "https://proxy.example.com"
contextWindow = 200000
maxTokens = 8192
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`,
      error: "Config must not specify both baseUrl and authFile.",
    },
    {
      name: "contextWindow is missing",
      toml: `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
maxTokens = 8192
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`,
      error: "Config must specify contextWindow when baseUrl is set.",
    },
    {
      name: "maxTokens is missing",
      toml: `
provider = "openai"
model = "llama3.2"
apiKey = "ollama"
baseUrl = "http://localhost:11434/v1"
contextWindow = 128000
publicHostname = "https://example.com"

[owner]
name = "Stavros"
`,
      error: "Config must specify maxTokens when baseUrl is set.",
    },
  ])("throws when baseUrl is set and $name", async ({ toml, error }) => {
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow(error);
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

describe("loadConfig reasoning", () => {
  const BASE_TOML_PREFIX = `
provider = "openai"
model = "gpt-oss:120b"
apiKey = "ollama"
baseUrl = "https://ollama.com/v1"
contextWindow = 128000
maxTokens = 8192
`;
  const OWNER_TOML_SUFFIX = `
publicHostname = "https://example.com"
password = "test-password"

[owner]
name = "Stavros"
`;

  it.each([
    { name: "defaults to false when omitted", fragment: "", expected: false },
    { name: "uses the value from TOML when true", fragment: "reasoning = true\n", expected: true },
  ])("reasoning $name", async ({ fragment, expected }) => {
    setupMocks(`${BASE_TOML_PREFIX}${fragment}${OWNER_TOML_SUFFIX}`);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.reasoning).toBe(expected);
  });

  it("throws when reasoning is not a boolean and baseUrl is set", async () => {
    setupMocks(`${BASE_TOML_PREFIX}reasoning = "yes"\n${OWNER_TOML_SUFFIX}`);
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow("Config reasoning must be a boolean when baseUrl is set.");
  });

  it("ignores reasoning when baseUrl is absent", async () => {
    const toml = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
reasoning = "yes"
publicHostname = "https://example.com"
password = "test-password"

[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.reasoning).toBe("yes");
  });
});

describe("loadConfig contextTokensK", () => {
  it.each([
    { name: "is undefined when the key is omitted from the TOML", fragment: "", expected: undefined },
    { name: "uses the value from TOML when the key is present", fragment: "contextTokensK = 50\n", expected: 50 },
  ])("$name", async ({ fragment, expected }) => {
    const toml = `
provider = "anthropic"
model = "claude-sonnet-4-20250514"
apiKey = "test-key"
publicHostname = "https://example.com"
password = "test-password"
${fragment}
[owner]
name = "Stavros"
`;
    setupMocks(toml);
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.contextTokensK).toBe(expected);
  });
});
