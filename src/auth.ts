import fs from "fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { Config } from "./config.js";
import { log } from "./log.js";

const BACKGROUND_REFRESH_INTERVAL_MILLISECONDS = 30 * 60 * 1000;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

type CredentialsMap = Record<string, OAuthCredentials>;

const MAX_RETRIES = 3;
const BASE_DELAY_MILLISECONDS = 1000;

async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Retrieves an API key, either directly from config or by resolving OAuth
// credentials from the auth file. When using OAuth, refreshed credentials are
// persisted back to disk so subsequent calls reuse the updated token. Retries
// with exponential backoff on transient failures to handle cases where the
// Anthropic OAuth endpoint is temporarily unreachable.
export async function getApiKey(config: Config): Promise<string> {
  if (config.apiKey !== undefined) {
    return config.apiKey;
  }

  const authFile = config.authFile as string;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let credentials: CredentialsMap;
      try {
        credentials = JSON.parse(fs.readFileSync(authFile, "utf-8")) as CredentialsMap;
      } catch (readError) {
        if (readError instanceof Error && (readError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AuthError("Auth file not found. Login required.");
        }
        throw readError;
      }

      const provider = getOAuthProvider(config.provider);
      if (provider === undefined) {
        throw new AuthError(`Unknown OAuth provider "${config.provider}".`);
      }

      let providerCredentials = credentials[config.provider];
      if (providerCredentials === undefined) {
        throw new AuthError(`No OAuth credentials found for provider "${config.provider}" in ${authFile}. Run the Pi coding agent /login command to authenticate.`);
      }

      log.debug(`[stavrobot] OAuth token state: refresh=...${providerCredentials.refresh.slice(-8)}, access=...${providerCredentials.access.slice(-8)}, expires=${providerCredentials.expires}`);

      if (Date.now() >= providerCredentials.expires) {
        providerCredentials = await provider.refreshToken(providerCredentials);
        credentials[config.provider] = providerCredentials;
        fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2));
        log.debug(`[stavrobot] OAuth token refreshed: refresh=...${providerCredentials.refresh.slice(-8)}, access=...${providerCredentials.access.slice(-8)}, expires=${providerCredentials.expires}`);
      }

      if (attempt > 0) {
        log.info(`[stavrobot] OAuth token resolved after ${attempt + 1} attempts.`);
      }

      return provider.getApiKey(providerCredentials);
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Auth failures are not transient, no point retrying.
      if (error instanceof AuthError) {
        throw error;
      }

      const delayMilliseconds = BASE_DELAY_MILLISECONDS * Math.pow(2, attempt);
      log.error(`[stavrobot] OAuth token refresh failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorMessage}. Retrying in ${delayMilliseconds}ms...`);
      await sleep(delayMilliseconds);
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AuthError(`OAuth token refresh failed after ${MAX_RETRIES} attempts: ${finalMessage}`);
}

export function startBackgroundTokenRefresh(config: Config): void {
  if (config.apiKey !== undefined) {
    return;
  }

  setInterval(() => {
    void (async () => {
      try {
        await getApiKey(config);
        log.debug("[stavrobot] Background token refresh succeeded.");
      } catch (error) {
        log.error("[stavrobot] Background token refresh failed:", error instanceof Error ? error.message : String(error));
      }
    })();
  }, BACKGROUND_REFRESH_INTERVAL_MILLISECONDS);
}
