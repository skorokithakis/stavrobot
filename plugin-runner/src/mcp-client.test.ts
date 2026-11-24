import { describe, it, expect } from "vitest";

import {
  buildStdioLaunch,
  parseMcpServerSpec,
  toToolManifest,
  translateCallToolResult,
  validateMcpServerSpec,
} from "./mcp-client.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

describe("validateMcpServerSpec", () => {
  const acceptedSpecs: Array<[string, unknown]> = [
    ["a minimal stdio spec", { command: "npx" }],
    [
      "a stdio spec with args and env",
      { command: "npx", args: ["-y", "@example/mcp-server"], env: { API_KEY: "secret" } },
    ],
    [
      "a Claude Desktop stdio spec with a type key",
      { type: "stdio", command: "npx", args: ["-y", "@example/mcp-server"] },
    ],
    ["a minimal streamable HTTP spec", { url: "https://example.com/mcp" }],
    ["a streamable HTTP spec with a type key", { type: "http", url: "https://example.com/mcp" }],
    [
      "a streamable HTTP spec with headers",
      { url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } },
    ],
    ["an env key that is a valid variable name", { command: "npx", env: { _OK_1: "x" } }],
    [
      "a header name that is an HTTP token",
      { url: "https://example.com/mcp", headers: { "X-Custom.Header_1~": "x" } },
    ],
  ];

  it.each(acceptedSpecs)("accepts %s", (_description, spec) => {
    expect(validateMcpServerSpec(spec)).toBeNull();
  });

  const rejectedSpecs: Array<[string, unknown, string | null]> = [
    ["a type key with any other value", { type: "sse", url: "https://example.com/mcp" }, "'type' must be"],
    ["a non-string type key", { type: 42, command: "npx" }, "'type' must be"],
    ["null", null, null],
    ["a string", "npx", null],
    ["a number", 42, null],
    ["an empty array", [], null],
    ["an array of strings", ["npx"], null],
    ["a spec with both command and url", { command: "npx", url: "https://example.com/mcp" }, "not both"],
    ["a spec with neither command nor url", { args: [] }, "'command' field"],
    ["unknown fields", { command: "npx", cwd: "/tmp" }, "Unknown server spec fields: cwd"],
    ["a command key that is undefined", { url: "https://example.com/mcp", command: undefined }, null],
    ["an empty command", { command: "" }, null],
    ["a non-string command", { command: 42 }, null],
    ["a non-string args element", { command: "npx", args: [1] }, null],
    ["a non-array args value", { command: "npx", args: "oops" }, null],
    ["a non-string env value", { command: "npx", env: { A: 1 } }, null],
    ["a non-object env value", { command: "npx", env: ["A"] }, null],
    [
      "an env key starting with a digit",
      { command: "npx", env: { "1BAD": "x" } },
      "not a valid environment variable name",
    ],
    [
      "an env key containing a dash",
      { command: "npx", env: { "BAD-KEY": "x" } },
      "not a valid environment variable name",
    ],
    [
      "an env key containing a space",
      { command: "npx", env: { "A B": "x" } },
      "not a valid environment variable name",
    ],
    ["a url that is not a URL", { url: "not a url" }, "valid URL"],
    ["a non-HTTP url", { url: "ftp://example.com/mcp" }, "http"],
    ["a non-string url", { url: 42 }, null],
    ["a non-string header value", { url: "https://example.com/mcp", headers: { A: 1 } }, null],
    ["a non-object headers value", { url: "https://example.com/mcp", headers: "A" }, null],
    [
      "a header name containing a space",
      { url: "https://example.com/mcp", headers: { "Bad Header": "x" } },
      "header name",
    ],
    [
      "a header name containing a colon",
      { url: "https://example.com/mcp", headers: { "Bad:Name": "x" } },
      "header name",
    ],
  ];

  it.each(rejectedSpecs)("rejects %s", (_description, spec, expectedMessage) => {
    const message = validateMcpServerSpec(spec);
    if (expectedMessage === null) {
      expect(message).not.toBeNull();
    } else {
      expect(message).toContain(expectedMessage);
    }
  });

  it("rejects header values containing CR or LF without echoing them", () => {
    const message = validateMcpServerSpec({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret-token\r\nX-Injected: yes" },
    });

    expect(message).toBe('header "Authorization" has an invalid value');
    expect(message).not.toContain("secret-token");
    expect(
      validateMcpServerSpec({ url: "https://example.com/mcp", headers: { "X-Test": "value\n" } })
    ).toBe('header "X-Test" has an invalid value');
    expect(
      validateMcpServerSpec({ url: "https://example.com/mcp", headers: { "X-Test": "value\u0000x" } })
    ).toBe('header "X-Test" has an invalid value');
    expect(
      validateMcpServerSpec({ url: "https://example.com/mcp", headers: { Authorization: "Bearer fine" } })
    ).toBeNull();
  });

  it("rejects env values containing CR, LF, or NUL without echoing them", () => {
    for (const value of ["secret\rX", "secret\nX", "secret\0X"]) {
      const message = validateMcpServerSpec({ command: "npx", env: { API_KEY: value } });
      expect(message).toBe('env "API_KEY" has an invalid value');
      expect(message).not.toContain("secret");
    }
    expect(validateMcpServerSpec({ command: "npx", env: { API_KEY: "normal value" } })).toBeNull();
  });
});

describe("parseMcpServerSpec", () => {
  it.each<[string, unknown, unknown]>([
    ["the object form", { command: "npx" }, { command: "npx" }],
    ["a string containing JSON", '{"url":"https://example.com/mcp"}', { url: "https://example.com/mcp" }],
  ])("parses %s", (_description, input, expected) => {
    expect(parseMcpServerSpec(input)).toEqual(expected);
  });

  it.each<[string, unknown, string]>([
    ["an invalid spec", {}, "'command' field"],
    ["a string that is not JSON", "npx", "'server' is not valid JSON"],
  ])("throws for %s", (_description, input, expectedMessage) => {
    expect(() => parseMcpServerSpec(input)).toThrow(expectedMessage);
  });

  it("does not echo the input in the JSON parse error", () => {
    const secret = '{"headers":{"Authorization":"Bearer super-secret-token"}, oops';
    let message = "";
    try {
      parseMcpServerSpec(secret);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("'server' is not valid JSON");
    expect(message).not.toContain("super-secret-token");
  });
});

describe("buildStdioLaunch", () => {
  const trustedEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/plugins/example",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  };

  it("runs setpriv by absolute path with only the trusted environment", () => {
    const launch = buildStdioLaunch(
      {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
        env: { LD_PRELOAD: "/tmp/evil.so", TOKEN: "secret" },
      },
      1000,
      1001,
      trustedEnv,
    );

    expect(launch.command).toBe("/usr/bin/setpriv");
    expect(launch.env).toEqual(trustedEnv);
    expect(launch.env).not.toHaveProperty("LD_PRELOAD");
    expect(launch.env).not.toHaveProperty("TOKEN");
    expect(launch.args).toEqual([
      "--reuid=1000",
      "--regid=1001",
      "--clear-groups",
      "--",
      "/usr/bin/env",
      "--",
      "LD_PRELOAD=/tmp/evil.so",
      "TOKEN=secret",
      "npx",
      "-y",
      "@example/mcp-server",
    ]);
  });

  it("applies the spec env only after the env binary", () => {
    const launch = buildStdioLaunch(
      { command: "npx", env: { LD_PRELOAD: "/tmp/evil.so" } },
      1000,
      1001,
      trustedEnv,
    );

    const envIndex = launch.args.indexOf("/usr/bin/env");
    const preloadIndex = launch.args.findIndex((argument) => argument.startsWith("LD_PRELOAD="));
    expect(envIndex).toBeGreaterThan(-1);
    expect(preloadIndex).toBeGreaterThan(envIndex);
    expect(launch.env["LD_PRELOAD"]).toBeUndefined();
  });

  it("works with no spec env", () => {
    const launch = buildStdioLaunch({ command: "npx" }, 1000, 1001, trustedEnv);

    expect(launch.args.slice(-3)).toEqual(["/usr/bin/env", "--", "npx"]);
  });
});

describe("toToolManifest", () => {
  it("maps name, description, parameters, and required flags", () => {
    const tool = {
      name: "search",
      description: "Search things",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer" },
          filter: { anyOf: [{ type: "string" }, { type: "number" }] },
          nested: { type: "object", description: "Nested object" },
        },
        required: ["query", "filter"],
      },
    } as unknown as Tool;

    expect(toToolManifest(tool)).toEqual({
      name: "search",
      description: "Search things",
      entrypoint: "",
      async: true,
      parameters: {
        query: { type: "string", description: "Search query (required)" },
        limit: { type: "integer", description: "" },
        filter: { type: "object", description: "(required)" },
        nested: { type: "object", description: "Nested object" },
      },
    });
  });

  it("uses an empty description when the tool has none", () => {
    const tool = {
      name: "ping",
      inputSchema: { type: "object" },
    } as unknown as Tool;

    expect(toToolManifest(tool)).toEqual({
      name: "ping",
      description: "",
      entrypoint: "",
      async: true,
      parameters: {},
    });
  });

  it("treats a non-object property as an untyped object", () => {
    const tool = {
      name: "odd",
      inputSchema: {
        type: "object",
        properties: {
          anything: true,
        },
      },
    } as unknown as Tool;

    expect(toToolManifest(tool).parameters["anything"]).toEqual({
      type: "object",
      description: "",
    });
  });
});

describe("translateCallToolResult", () => {
  function callResult(content: unknown[], extra: Record<string, unknown> = {}): CallToolResult {
    return { content, ...extra } as unknown as CallToolResult;
  }

  it("joins text items with newlines", () => {
    const result = translateCallToolResult(
      callResult([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ])
    );

    expect(result).toEqual({ success: true, output: "first\nsecond", files: [] });
  });

  it("turns images into files with an extension from the mime type", () => {
    const result = translateCallToolResult(
      callResult([
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "image", data: "anBlZw==", mimeType: "image/jpeg" },
      ])
    );

    expect(result).toEqual({
      success: true,
      output: "",
      files: [
        { filename: "image-1.png", data: "aW1hZ2U=" },
        { filename: "image-2.jpg", data: "anBlZw==" },
      ],
    });
  });

  it("appends embedded text resources to the output", () => {
    const result = translateCallToolResult(
      callResult([
        { type: "text", text: "before" },
        {
          type: "resource",
          resource: { uri: "file:///tmp/notes.txt", mimeType: "text/plain", text: "resource text" },
        },
      ])
    );

    expect(result).toEqual({ success: true, output: "before\nresource text", files: [] });
  });

  it("names blob resources from the URI's last path segment", () => {
    const result = translateCallToolResult(
      callResult([
        {
          type: "resource",
          resource: { uri: "file:///tmp/report.pdf?download=1", mimeType: "application/pdf", blob: "cGRm" },
        },
      ])
    );

    expect(result).toEqual({
      success: true,
      output: "",
      files: [{ filename: "report.pdf", data: "cGRm" }],
    });
  });

  it("falls back to resource-<n> when the URI has no usable filename", () => {
    const result = translateCallToolResult(
      callResult([
        { type: "resource", resource: { uri: "https://example.com/", mimeType: "application/octet-stream", blob: "YQ==" } },
        { type: "resource", resource: { uri: "file:///tmp/..", mimeType: "application/octet-stream", blob: "Yg==" } },
      ])
    );

    expect(result).toEqual({
      success: true,
      output: "",
      files: [
        { filename: "resource-1", data: "YQ==" },
        { filename: "resource-2", data: "Yg==" },
      ],
    });
  });

  it("reports isError results as failures with the text as the error", () => {
    const result = translateCallToolResult(
      callResult([{ type: "text", text: "something went wrong" }], { isError: true })
    );

    expect(result).toEqual({ success: false, error: "something went wrong" });
  });

  it("uses a placeholder error when an isError result has no text", () => {
    const result = translateCallToolResult(callResult([], { isError: true }));

    expect(result).toEqual({ success: false, error: "(no output)" });
  });

  it("returns (no output) when there is no content", () => {
    const result = translateCallToolResult(callResult([]));

    expect(result).toEqual({ success: true, output: "(no output)", files: [] });
  });

  it("ignores structuredContent", () => {
    const result = translateCallToolResult(
      callResult([], { structuredContent: { answer: 42 } })
    );

    expect(result).toEqual({ success: true, output: "(no output)", files: [] });
  });

  it("ignores content kinds the app cannot represent", () => {
    const result = translateCallToolResult(
      callResult([
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        { type: "resource_link", uri: "https://example.com", name: "link" },
        { type: "text", text: "kept" },
      ])
    );

    expect(result).toEqual({ success: true, output: "kept", files: [] });
  });
});
