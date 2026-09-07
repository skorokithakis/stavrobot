import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { Config } from "./config.js";
import { AuthError, getApiKey } from "./auth.js";

const PROVIDER_ID = "test-oauth";

let temporaryDirectory: string;
let authFile: string;

function createConfig(): Config {
  return {
    provider: PROVIDER_ID,
    authFile,
  } as unknown as Config;
}

function createOAuthAuth(apiKey: string): OAuthAuth {
  return {
    name: "Test OAuth",
    login: vi.fn(),
    refresh: vi.fn(),
    toAuth: vi.fn().mockResolvedValue({ apiKey }),
  };
}

beforeEach((): void => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stavrobot-auth-"));
  authFile = path.join(temporaryDirectory, "auth.json");
});

afterEach((): void => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("getApiKey", (): void => {
  it("accepts an untagged legacy credential without refreshing it", async (): Promise<void> => {
    const legacyCredentials = {
      [PROVIDER_ID]: {
        refresh: "legacy-refresh-token",
        access: "legacy-access-token",
        expires: Date.now() + 60_000,
      },
    };
    fs.writeFileSync(authFile, JSON.stringify(legacyCredentials), "utf-8");
    const oauth = createOAuthAuth("resolved-api-key");

    await expect(getApiKey(createConfig(), () => oauth)).resolves.toBe("resolved-api-key");

    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(oauth.toAuth).toHaveBeenCalledWith(expect.objectContaining({
      type: "oauth",
      refresh: "legacy-refresh-token",
      access: "legacy-access-token",
    }));
    expect(JSON.parse(fs.readFileSync(authFile, "utf-8"))).toEqual(legacyCredentials);
  });

  it("refreshes expired credentials and persists the type-tagged replacement", async (): Promise<void> => {
    const expiredCredentials = {
      refresh: "expired-refresh-token",
      access: "expired-access-token",
      expires: Date.now() - 1,
    };
    const refreshedCredentials: OAuthCredential = {
      type: "oauth",
      refresh: "refreshed-refresh-token",
      access: "refreshed-access-token",
      expires: Date.now() + 60_000,
    };
    fs.writeFileSync(authFile, JSON.stringify({ [PROVIDER_ID]: expiredCredentials }), "utf-8");
    const oauth = createOAuthAuth("refreshed-api-key");
    vi.mocked(oauth.refresh).mockResolvedValue(refreshedCredentials);

    await expect(getApiKey(createConfig(), () => oauth)).resolves.toBe("refreshed-api-key");

    expect(oauth.refresh).toHaveBeenCalledOnce();
    expect(oauth.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ type: "oauth", refresh: "expired-refresh-token" }),
      expect.any(AbortSignal),
    );
    expect(oauth.toAuth).toHaveBeenCalledWith(refreshedCredentials);
    expect(JSON.parse(fs.readFileSync(authFile, "utf-8"))).toEqual({ [PROVIDER_ID]: refreshedCredentials });
  });

  it("raises AuthError after three failed refresh attempts", async (): Promise<void> => {
    fs.writeFileSync(authFile, JSON.stringify({
      [PROVIDER_ID]: {
        refresh: "expired-refresh-token",
        access: "expired-access-token",
        expires: Date.now() - 1,
      },
    }), "utf-8");
    const oauth = createOAuthAuth("unused-api-key");
    vi.mocked(oauth.refresh).mockRejectedValue(new Error("refresh failed"));
    vi.useFakeTimers();

    const result = expect(getApiKey(createConfig(), () => oauth)).rejects.toThrow(AuthError);
    await vi.runAllTimersAsync();
    await result;
    expect(oauth.refresh).toHaveBeenCalledTimes(3);
  });

  it("raises AuthError when the auth file is missing", async (): Promise<void> => {
    const oauth = createOAuthAuth("unused-api-key");

    await expect(getApiKey(createConfig(), () => oauth)).rejects.toThrow("Auth file not found. Login required.");
  });

  it("raises AuthError when OAuth auth does not yield an API key", async (): Promise<void> => {
    fs.writeFileSync(authFile, JSON.stringify({
      [PROVIDER_ID]: {
        refresh: "valid-refresh-token",
        access: "valid-access-token",
        expires: Date.now() + 60_000,
      },
    }), "utf-8");
    const oauth = createOAuthAuth("unused-api-key");
    vi.mocked(oauth.toAuth).mockResolvedValue({});

    await expect(getApiKey(createConfig(), () => oauth)).rejects.toThrow("did not return an API key");
  });
});
