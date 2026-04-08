import http from "http";
import fs from "fs";
import path from "path";
import { getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

// Module-level state for the pending prompt resolver and rejecter. Safe because
// this is a single-user bot — only one login flow runs at a time.
let pendingPromptResolver: ((value: string) => void) | null = null;
// Rejecting this causes the library's provider.login() to throw, which triggers
// its internal cleanup (cancelWait, closing the callback server). Only used for
// timeout cancellation — disconnects must not cancel the flow.
let pendingPromptReject: ((error: Error) => void) | null = null;
// Set to true when the timeout fires before the library has called onPrompt or
// onManualCodeInput, so those callbacks can reject immediately when they do run.
let loginCancelled = false;

// Module-level state for the active login flow.
let activeLoginPromise: Promise<void> | null = null;
// Monotonically increasing counter so stale disconnect handlers from an old
// flow cannot accidentally clear state that belongs to a newer flow.
let loginFlowCounter = 0;

// The current SSE response to write events to. Swapped on reconnection without
// restarting the underlying provider.login() call.
let activeResponse: http.ServerResponse | null = null;
let activeIsConnected = false;

// Stored so a reconnecting client can be replayed to the same point in the flow.
let lastAuthEvent: { url: string; instructions: string | undefined } | null = null;
let lastPromptMessage: string | null = null;

// Cleared when the flow completes or times out.
let flowTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

function buildLoginPageHtml(providerName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Log in with ${providerName}</title>
  <style>
    ${getBaseStyles()}
    body {
      max-width: 480px;
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
    #prompt-section { display: none; }
    #auth-section { display: none; }
  </style>
</head>
<body>
  <h1>Log in with ${providerName}</h1>
  <div id="status">Connecting...</div>
  <div id="auth-section">
    <p id="auth-link-container"></p>
    <p id="auth-instructions"></p>
    <p>
      Important: after login, you might see an error page. This is expected.
      If that happens, copy the full URL from your browser address bar and paste it into the box below when prompted.
    </p>
  </div>
  <div id="prompt-section">
    <p id="prompt-message"></p>
    <input type="text" id="prompt-input" autofocus placeholder="Paste the full redirect URL (or code) here" />
    <button onclick="submitPrompt()">Submit</button>
  </div>
  <script>
    const evtSource = new EventSource("/login/events");

    evtSource.addEventListener("auth", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "";
      const section = document.getElementById("auth-section");
      section.style.display = "block";
      const container = document.getElementById("auth-link-container");
      const link = document.createElement("a");
      link.href = data.url;
      link.target = "_blank";
      link.textContent = "Open this link to log in";
      container.innerHTML = "";
      container.appendChild(link);
      const instructionsEl = document.getElementById("auth-instructions");
      instructionsEl.textContent = data.instructions || "";
    });

    evtSource.addEventListener("prompt", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "";
      const section = document.getElementById("prompt-section");
      section.style.display = "block";
      document.getElementById("prompt-message").textContent = data.message;
      const input = document.getElementById("prompt-input");
      input.value = "";
      input.focus();
    });

    evtSource.addEventListener("progress", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = data.message;
    });

    evtSource.addEventListener("success", function(event) {
      evtSource.close();
      document.getElementById("status").textContent = "Login successful. You can close this page.";
      document.getElementById("auth-section").style.display = "none";
      document.getElementById("prompt-section").style.display = "none";
    });

    evtSource.addEventListener("error_event", function(event) {
      evtSource.close();
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "Login failed: " + data.message;
    });

    async function submitPrompt() {
      const value = document.getElementById("prompt-input").value;
      document.getElementById("prompt-section").style.display = "none";
      document.getElementById("status").textContent = "Submitting...";
      try {
        await fetch("/login/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      } catch (error) {
        document.getElementById("status").textContent = "Request failed: " + error.message;
      }
    }
  </script>
</body>
</html>`;
}

function sendSseEvent(response: http.ServerResponse, eventName: string, data: unknown): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Writes an SSE event to the active connection if one is alive.
function sendActiveSseEvent(eventName: string, data: unknown): void {
  if (activeResponse !== null && activeIsConnected) {
    sendSseEvent(activeResponse, eventName, data);
  }
}

function clearFlowState(flowId: number): void {
  if (flowId !== loginFlowCounter) {
    return;
  }
  if (flowTimeoutHandle !== null) {
    clearTimeout(flowTimeoutHandle);
    flowTimeoutHandle = null;
  }
  activeLoginPromise = null;
  activeResponse = null;
  activeIsConnected = false;
  lastAuthEvent = null;
  lastPromptMessage = null;
  pendingPromptResolver = null;
  pendingPromptReject = null;
  loginCancelled = false;
}

export function serveLoginPage(response: http.ServerResponse, config: Config): void {
  const provider = getOAuthProvider(config.provider);
  const providerName = provider !== undefined ? provider.name : config.provider;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(buildLoginPageHtml(providerName));
}

export async function handleLoginEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: Config,
): Promise<void> {
  if (config.authFile === undefined) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    sendSseEvent(response, "error_event", { message: "authFile not configured" });
    response.end();
    return;
  }

  const provider = getOAuthProvider(config.provider);
  if (provider === undefined) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const validIds = getOAuthProviders().map((p) => p.id).join(", ");
    sendSseEvent(response, "error_event", { message: `Unknown OAuth provider "${config.provider}". Valid OAuth providers: ${validIds}` });
    response.end();
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  // If a flow is already running, attach this new SSE connection to it instead
  // of restarting. This handles page reloads: the browser's EventSource
  // reconnects automatically, and we replay the stored state so the user sees
  // the same auth URL and prompt they saw before the reload.
  if (activeLoginPromise !== null) {
    log.debug("[stavrobot] handleLoginEvents: attaching new SSE connection to existing flow");

    activeResponse = response;
    activeIsConnected = true;
    const thisResponse = response;

    request.on("close", () => {
      log.debug("[stavrobot] handleLoginEvents: reconnected client disconnected");
      if (thisResponse === activeResponse) {
        activeIsConnected = false;
      }
    });

    // Replay stored state so the reconnected client catches up.
    if (lastAuthEvent !== null) {
      sendSseEvent(response, "auth", { url: lastAuthEvent.url, instructions: lastAuthEvent.instructions });
    }
    if (lastPromptMessage !== null) {
      if (pendingPromptResolver !== null) {
        // The prompt is still waiting for user input.
        sendSseEvent(response, "prompt", { message: lastPromptMessage });
      } else {
        // The prompt was already answered; the flow is waiting for the provider.
        sendSseEvent(response, "progress", { message: "Waiting for authorization..." });
      }
    }

    return;
  }

  loginFlowCounter += 1;
  const flowId = loginFlowCounter;

  activeResponse = response;
  activeIsConnected = true;

  request.on("close", () => {
    log.debug(`[stavrobot] handleLoginEvents: client disconnected (flow ${flowId})`);
    if (flowId === loginFlowCounter) {
      activeIsConnected = false;
    }
  });

  log.debug(`[stavrobot] handleLoginEvents: starting login flow ${flowId} for provider "${config.provider}"`);

  // These are assigned synchronously inside the Promise constructor, so they
  // are always non-null by the time the try block runs. TypeScript cannot infer
  // this, so we use non-null assertions at the call sites.
  let resolveActiveLogin!: () => void;
  let rejectActiveLogin!: (error: unknown) => void;
  activeLoginPromise = new Promise<void>((resolve, reject) => {
    resolveActiveLogin = resolve;
    rejectActiveLogin = reject;
  });

  // Cancel the flow if no client reconnects within the timeout window. This
  // prevents the library's callback server from staying open indefinitely when
  // the user abandons the login page.
  flowTimeoutHandle = setTimeout(() => {
    if (flowId === loginFlowCounter && activeLoginPromise !== null) {
      log.warn(`[stavrobot] handleLoginEvents: flow ${flowId} timed out after ${FLOW_TIMEOUT_MS / 1000}s`);
      if (pendingPromptReject !== null) {
        // The library is currently blocked waiting for user input. Rejecting its
        // promise causes it to call cancelWait() and close the callback server.
        // The resulting throw propagates to the catch block, which calls
        // rejectActiveLogin and runs clearFlowState via finally.
        pendingPromptReject(new Error("Login flow timed out"));
      } else {
        // The library hasn't called onPrompt/onManualCodeInput yet (or has
        // already moved past it). Mark the flow cancelled so those callbacks
        // reject immediately if they are called, and also reject the wrapper
        // promise directly so the flow doesn't hang.
        loginCancelled = true;
        rejectActiveLogin(new Error("Login flow timed out"));
      }
    }
  }, FLOW_TIMEOUT_MS);

  try {
    const credentials = await provider.login({
      onAuth: (info) => {
        log.debug("[stavrobot] handleLoginEvents: onAuth called, sending auth event");
        lastAuthEvent = { url: info.url, instructions: info.instructions };
        sendActiveSseEvent("auth", { url: info.url, instructions: info.instructions });
      },
      onPrompt: (prompt) => {
        log.debug("[stavrobot] handleLoginEvents: onPrompt called, sending prompt event");
        return new Promise<string>((resolve, reject) => {
          if (loginCancelled) {
            reject(new Error("Login flow timed out"));
            return;
          }
          lastPromptMessage = prompt.message;
          pendingPromptResolver = resolve;
          pendingPromptReject = reject;
          sendActiveSseEvent("prompt", { message: prompt.message });
        });
      },
      onProgress: (message) => {
        log.debug("[stavrobot] handleLoginEvents: onProgress:", message);
        sendActiveSseEvent("progress", { message });
      },
      // Races against the provider's local callback server. In a remote deployment
      // the browser redirect hits localhost on the container, not the user's machine,
      // so the callback server never receives the code. Providing this callback lets
      // the user paste the redirect URL or code manually, whichever arrives first wins.
      onManualCodeInput: () => {
        log.debug("[stavrobot] handleLoginEvents: onManualCodeInput called, sending prompt event");
        return new Promise<string>((resolve, reject) => {
          if (loginCancelled) {
            reject(new Error("Login flow timed out"));
            return;
          }
          const message = "Paste the authorization code or full redirect URL from your browser:";
          lastPromptMessage = message;
          pendingPromptResolver = resolve;
          pendingPromptReject = reject;
          sendActiveSseEvent("prompt", { message });
        });
      },
    });

    log.debug("[stavrobot] handleLoginEvents: login succeeded, saving credentials");

    const authFile = config.authFile;
    let existingCredentials: Record<string, OAuthCredentials> = {};
    try {
      const existing = fs.readFileSync(authFile, "utf-8");
      existingCredentials = JSON.parse(existing) as Record<string, OAuthCredentials>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    existingCredentials[config.provider] = credentials;

    const authDir = path.dirname(authFile);
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(existingCredentials, null, 2), "utf-8");

    log.debug("[stavrobot] handleLoginEvents: credentials written to", authFile);

    if (activeIsConnected && activeResponse !== null) {
      sendSseEvent(activeResponse, "success", {});
      activeResponse.end();
    }

    resolveActiveLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[stavrobot] handleLoginEvents: login failed:", message);
    if (activeIsConnected && activeResponse !== null) {
      sendSseEvent(activeResponse, "error_event", { message });
      activeResponse.end();
    }
    rejectActiveLogin(error);
  } finally {
    // Clean up module-level state so a future flow starts fresh.
    clearFlowState(flowId);
  }
}

export async function handleLoginRespond(
  request: http.IncomingMessage,
  response: http.ServerResponse,
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
    response.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("value" in parsed) ||
    typeof (parsed as Record<string, unknown>).value !== "string"
  ) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Request body must include a value string" }));
    return;
  }

  const { value } = parsed as { value: string };

  if (pendingPromptResolver === null) {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "No pending prompt" }));
    return;
  }

  log.debug("[stavrobot] handleLoginRespond: resolving pending prompt");
  const resolver = pendingPromptResolver;
  pendingPromptResolver = null;
  pendingPromptReject = null;
  resolver(value);

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}
