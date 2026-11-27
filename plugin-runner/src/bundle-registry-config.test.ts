import { describe, it, expect, afterEach, vi } from "vitest";

import type { BundleConfigField } from "./bundle-registry.js";
import { resolveConfigSchema } from "./bundle-registry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConfigSchema", () => {
  it("uses explicit types, derives secrecy from them, and keeps defaults", () => {
    const schema = resolveConfigSchema("my-plugin", {
      apiKey: { description: "API key", required: true },
      label: { description: "Label", required: false, secret: false },
      enabled: { description: "Enabled", required: false, type: "boolean" },
      retries: { description: "Retries", required: false, type: "number", default: 3 },
      mode: { description: "Mode", required: false, type: "select", options: ["fast", "slow"] },
      note: { description: "Note", required: false, type: "text" },
    });

    expect(schema["apiKey"]).toEqual({
      description: "API key",
      required: true,
      type: "secret",
    });
    expect(schema["label"]).toEqual({
      description: "Label",
      required: false,
      type: "text",
    });
    expect(schema["enabled"]).toMatchObject({ type: "boolean" });
    expect(schema["retries"]).toMatchObject({ type: "number", default: 3 });
    expect(schema["mode"]).toEqual({
      description: "Mode",
      required: false,
      type: "select",
      options: ["fast", "slow"],
    });
    expect(schema["note"]).toMatchObject({ type: "text" });
  });

  // A malformed manifest must degrade to the pre-types behaviour instead of
  // making the field unconfigurable.
  const fallbacks: Array<[string, Record<string, unknown>]> = [
    ["an unknown type", { description: "Mode", required: false, type: "colour" }],
    ["a non-string type", { description: "Mode", required: false, type: 7 }],
    ["a select without options", { description: "Mode", required: false, type: "select" }],
    ["a select with empty options", { description: "Mode", required: false, type: "select", options: [] }],
    [
      "a select with non-string options",
      { description: "Mode", required: false, type: "select", options: ["fast", 1] },
    ],
    [
      "a select with an empty-string option",
      { description: "Mode", required: false, type: "select", options: ["fast", ""] },
    ],
    [
      "an object-valued type",
      { description: "Mode", required: false, type: { toString: null } },
    ],
  ];

  it.each(fallbacks)("falls back to secret and warns for %s", (_label, field) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const schema = resolveConfigSchema("my-plugin", {
      mode: field as unknown as BundleConfigField,
    });

    expect(schema["mode"]).toEqual({
      description: "Mode",
      required: false,
      type: "secret",
    });
    expect(schema["mode"]).not.toHaveProperty("options");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain("my-plugin");
    expect(warning.mock.calls[0][0]).toContain("mode");
  });
});
