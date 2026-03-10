import http from "http";
import fs from "fs";
import path from "path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Log in with Anthropic</title>
  <style>
    ${getBaseStyles()}
    body {
      max-width: 440px;
      margin: 80px auto;
      padding: 0 24px;
      line-height: 1.5;
    }
    p { color: var(--color-text-secondary); margin-bottom: 16px; }
    a { color: var(--color-accent); text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      margin: 8px 0 16px;
      font-size: 1em;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface);
      color: var(--color-text);
    }
    button {
      padding: 12px 24px;
      font-size: 1em;
      cursor: pointer;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-weight: 500;
    }
    button:hover { background: var(--color-accent-hover); }
    #status { margin-top: 20px; color: var(--color-text-secondary); }
  </style>
</head>
<body>
  <h1>Log in with Anthropic</h1>
  <p id="auth-link-container"></p>
  <p>
    After completing login, copy the code from the callback page and paste it below.
  </p>
  <input type="text" id="code-input" placeholder="Paste authorization code here" />
  <button id="submit-btn" onclick="submitCode()">Submit</button>
  <div id="status"></div>
  <script>
    const CLIENT_ID = ${JSON.stringify(CLIENT_ID)};
    const AUTHORIZATION_URL = ${JSON.stringify(AUTHORIZATION_URL)};
    const REDIRECT_URI = ${JSON.stringify(REDIRECT_URI)};
    const SCOPES = ${JSON.stringify(SCOPES)};

    let pkceVerifier = null;

    function base64urlEncode(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=/g, "");
    }

    async function generatePkce() {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
      const length = 64;
      const randomValues = new Uint8Array(length);
      crypto.getRandomValues(randomValues);
      const verifier = Array.from(randomValues)
        .map(v => chars[v % chars.length])
        .join("");

      const encoder = new TextEncoder();
      const data = encoder.encode(verifier);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const challenge = base64urlEncode(hashBuffer);

      return { verifier, challenge };
    }

    async function init() {
      const { verifier, challenge } = await generatePkce();
      pkceVerifier = verifier;

      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state: verifier,
        code_challenge: challenge,
        code_challenge_method: "S256",
        code: "true",
      });
      const authUrl = AUTHORIZATION_URL + "?" + params.toString();

      const container = document.getElementById("auth-link-container");
      const link = document.createElement("a");
      link.href = authUrl;
      link.target = "_blank";
      link.textContent = "Log in with Anthropic";
      container.appendChild(link);
    }

    async function submitCode() {
      const code = document.getElementById("code-input").value.trim();
      const statusEl = document.getElementById("status");

      if (!code) {
        statusEl.textContent = "Please paste the authorization code first.";
        return;
      }
      if (!pkceVerifier) {
        statusEl.textContent = "PKCE verifier not ready. Please reload the page.";
        return;
      }

      statusEl.textContent = "Submitting...";

      try {
        const response = await fetch("/providers/anthropic/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, verifier: pkceVerifier }),
        });
        const data = await response.json();
        if (data.success) {
          statusEl.textContent = "Login successful. You can close this page.";
        } else {
          statusEl.textContent = "Login failed: " + (data.error || "Unknown error");
        }
      } catch (error) {
        statusEl.textContent = "Request failed: " + error.message;
      }
    }

    init();
  </script>
</body>
</html>`;

export function serveLoginPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(LOGIN_PAGE_HTML);
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function handleLoginPost(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: Config,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
    return;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    typeof (parsed as Record<string, unknown>).code !== "string" ||
    !("verifier" in parsed) ||
    typeof (parsed as Record<string, unknown>).verifier !== "string"
  ) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Request body must include code and verifier strings" }));
    return;
  }

  const { code: rawCode, verifier } = parsed as { code: string; verifier: string };

  // The code from the callback page is formatted as "code#state".
  const hashIndex = rawCode.indexOf("#");
  if (hashIndex === -1) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Invalid authorization code format. Expected code#state." }));
    return;
  }
  const code = rawCode.slice(0, hashIndex);
  const state = rawCode.slice(hashIndex + 1);

  log.debug("[stavrobot] handleLoginPost: exchanging authorization code for tokens");

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[stavrobot] handleLoginPost: token request failed:", message);
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: message }));
    return;
  }

  let tokenBody: unknown;
  try {
    tokenBody = await tokenResponse.json();
  } catch {
    log.error("[stavrobot] handleLoginPost: token endpoint returned non-JSON response");
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Token endpoint returned a non-JSON response." }));
    return;
  }

  if (!tokenResponse.ok) {
    const errorMessage = typeof tokenBody === "object" && tokenBody !== null && "error" in tokenBody
      ? String((tokenBody as Record<string, unknown>).error)
      : `HTTP ${tokenResponse.status}`;
    log.error("[stavrobot] handleLoginPost: token endpoint returned error:", errorMessage);
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: errorMessage }));
    return;
  }

  if (
    typeof tokenBody !== "object" ||
    tokenBody === null ||
    typeof (tokenBody as Record<string, unknown>).access_token !== "string" ||
    typeof (tokenBody as Record<string, unknown>).refresh_token !== "string" ||
    typeof (tokenBody as Record<string, unknown>).expires_in !== "number"
  ) {
    log.error("[stavrobot] handleLoginPost: token response missing expected fields:", tokenBody);
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Token endpoint response is missing expected fields." }));
    return;
  }

  const tokenData = tokenBody as TokenResponse;

  const authFile = config.authFile;
  if (authFile === undefined) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "authFile not configured" }));
    return;
  }

  let credentials: Record<string, unknown> = {};
  try {
    const existing = fs.readFileSync(authFile, "utf-8");
    try {
      credentials = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      log.error("[stavrobot] handleLoginPost: auth file contains invalid JSON:", authFile);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "Auth file contains invalid JSON. Manual intervention required." }));
      return;
    }
  } catch (error) {
    // Only ENOENT (file not found) is expected — any other error is a real problem.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      log.error("[stavrobot] handleLoginPost: failed to read auth file:", message);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: `Failed to read auth file: ${message}` }));
      return;
    }
  }

  credentials[config.provider] = {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
  };

  try {
    const authDir = path.dirname(authFile);
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2), "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[stavrobot] handleLoginPost: failed to write auth file:", message);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: `Failed to write auth file: ${message}` }));
    return;
  }

  log.debug("[stavrobot] handleLoginPost: credentials written to", authFile);

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ success: true }));
}
