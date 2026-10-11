import http from "http";
import fs from "fs";
import path from "path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthPrompt, OAuthAuth, OAuthCredentials } from "@earendil-works/pi-ai";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { renderPageShell, escapeHtml } from "./shell.js";

// Module-level state for the pending prompt resolver and rejecter. Safe because
// this is a single-user bot — only one login flow runs at a time.
let pendingPromptResolver: ((value: string) => void) | null = null;
// Rejecting this causes the library's oauth.login() to throw, which triggers
// its internal cleanup (cancelWait, closing the callback server). Only used for
// timeout cancellation — disconnects must not cancel the flow.
let pendingPromptReject: ((error: Error) => void) | null = null;
let pendingPromptAbortCleanup: (() => void) | null = null;
// Set to true when the timeout fires before the library has called prompt(), so
// that callback can reject immediately when it does run.
let loginCancelled = false;

// Module-level state for the active login flow.
let loginFlowActive = false;
// Monotonically increasing counter so stale disconnect handlers from an old
// flow cannot accidentally clear state that belongs to a newer flow.
let loginFlowCounter = 0;
// Per-flow AbortController so the library's oauth.login() can be cancelled
// on timeout, including for device-code flows that poll in the background.
let activeFlowController: AbortController | null = null;

// The current SSE response to write events to. Swapped on reconnection without
// restarting the underlying oauth.login() call.
let activeResponse: http.ServerResponse | null = null;
let activeIsConnected = false;

// Stored so a reconnecting client can be replayed to the same point in the flow.
let lastAuthEvent: { url: string; instructions: string | undefined } | null = null;
let lastDeviceCodeInfo: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number } | null = null;
let lastPromptMessage: string | null = null;

// Cleared when the flow completes or times out.
let flowTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export type OAuthAuthResolver = (providerId: string) => OAuthAuth | undefined;

export function resolveOAuthAuth(providerId: string): OAuthAuth | undefined {
  const provider = builtinProviders().find((candidate) => candidate.id === providerId);
  return provider?.auth.oauth;
}

const LOGO_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"></rect><path d="M12 7V4"></path><circle cx="9" cy="13" r="1" fill="currentColor"></circle><circle cx="15" cy="13" r="1" fill="currentColor"></circle></svg>';

const BRAND_HTML = `<div class="sb-brand sb-auth-brand"><div class="sb-logo">${LOGO_SVG}</div>Stavrobot</div>`;

const EXTERNAL_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>';

const SMALL_EXTERNAL_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>';

const COPY_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 0 1 1-1h9"></path></svg>';

const CHECK_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';

const WARN_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

const WARN_ICON_SMALL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

const RETRY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"></path></svg>';

function buildLoginPageHtml(providerName: string): string {
  const escapedProviderName = escapeHtml(providerName);
  const content = `${BRAND_HTML}
<main class="sb-card" aria-labelledby="login-title">
  <div class="sb-auth-h">
    <span class="sb-label">Provider login</span>
    <h1 id="login-title">Connect to ${escapedProviderName}</h1>
    <p class="sb-muted" id="login-subtitle">Stavrobot needs your permission to use your account.</p>
  </div>
  <div>
    <div class="sb-state" id="state-connecting" aria-busy="true">
      <span class="sb-spinner sb-spinner-lg sb-muted"></span>
      <strong>Connecting...</strong>
      <p>Asking the provider for a login link.</p>
    </div>
    <div class="sb-auth-pad" id="state-redirect" hidden>
      <ol class="sb-steps">
        <li>
          <div class="sb-step-stack">
            <span id="redirect-instructions">Open this link to log in. It opens in a new tab.</span>
            <a class="sb-btn sb-btn-secondary" id="redirect-link" href="#" target="_blank" rel="noopener">Open the login page${EXTERNAL_ICON}</a>
          </div>
        </li>
        <li>Log in and select <strong>Authorize</strong>.</li>
        <li id="redirect-step3">
          <span id="redirect-return">Come back to this page.</span>
          <div class="sb-field" id="redirect-field" hidden>
            <label for="redirect-input" id="redirect-label">Paste the code here</label>
            <input id="redirect-input" class="sb-input sb-mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="code#state">
            <span class="sb-hint" id="redirect-hint">The provider shows the code after you authorize. Copy it and paste it here.</span>
            <span class="sb-field-error" id="redirect-error" hidden>${WARN_ICON_SMALL}Enter the code the provider shows after you authorize.</span>
          </div>
        </li>
      </ol>
      <button class="sb-btn sb-btn-primary sb-btn-lg sb-btn-block" id="redirect-submit" type="button" hidden>Submit</button>
    </div>
    <div class="sb-auth-pad is-tight" id="state-device" hidden>
      <ol class="sb-steps">
        <li class="sb-desktop-only"><span>Go to <a id="device-link" href="#" target="_blank" rel="noopener">the verification page</a>${SMALL_EXTERNAL_ICON}</span></li>
        <li class="sb-mobile-only">
          <div class="sb-step-stack">
            <span>Open the device page.</span>
            <a class="sb-btn sb-btn-secondary sb-btn-lg sb-btn-block" id="device-link-block" href="#" target="_blank" rel="noopener"><span id="device-link-block-text">the verification page</span>${EXTERNAL_ICON}</a>
          </div>
        </li>
        <li>Type this code:</li>
      </ol>
      <div class="sb-code-display">
        <code id="device-code"></code>
        <button class="sb-btn sb-btn-secondary sb-btn-icon" id="device-copy" type="button" aria-label="Copy code">${COPY_ICON}</button>
      </div>
      <div class="sb-desktop-only"><span class="sb-feedback" role="status"><span class="sb-spinner"></span><span id="device-status-text">Waiting for you to approve.</span></span></div>
      <div class="sb-mobile-only"><div class="sb-banner is-progress" role="status"><span class="sb-spinner"></span><span id="device-status-text-mobile">Waiting for you to approve.</span></div></div>
    </div>
    <div class="sb-auth-pad is-list" id="state-progress" hidden>
      <div class="sb-banner is-progress" role="status"><span class="sb-spinner"></span><span id="progress-latest"></span></div>
      <ul class="sb-progress-list" id="progress-list"></ul>
    </div>
    <div class="sb-state is-success" id="state-success" hidden>
      <div class="sb-state-icon">${CHECK_ICON}</div>
      <strong>Connected</strong>
      <p>Stavrobot can now use your ${escapedProviderName} account.</p>
      <a class="sb-btn sb-btn-primary" href="/">Go to Overview</a>
    </div>
    <div class="sb-state is-error" id="state-failure" hidden>
      <div class="sb-state-icon">${WARN_ICON}</div>
      <strong>Login failed</strong>
      <p class="sb-mono sb-failure-msg" id="failure-message"></p>
      <button class="sb-btn sb-btn-primary" id="failure-retry" type="button">${RETRY_ICON}Start again</button>
    </div>
  </div>
</main>
<script>
(function () {
  var evtSource = new EventSource("/login/events");
  var stateNames = ["connecting", "redirect", "device", "progress", "success", "failure"];
  var countdownHandle = null;
  var progressMessages = [];
  var submitting = false;
  var CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';
  var SPIN = '<span class="sb-spinner sb-spinner-sm"></span>';

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showState(name) {
    for (var i = 0; i < stateNames.length; i++) {
      byId("state-" + stateNames[i]).hidden = stateNames[i] !== name;
    }
    var subtitle = byId("login-subtitle");
    if (name === "device") {
      subtitle.textContent = "Type this code on the provider's site.";
      subtitle.hidden = false;
    } else if (name === "connecting" || name === "redirect") {
      subtitle.textContent = "Stavrobot needs your permission to use your account.";
      subtitle.hidden = false;
    } else {
      subtitle.hidden = true;
    }
  }

  function clearCountdown() {
    if (countdownHandle !== null) { clearInterval(countdownHandle); countdownHandle = null; }
  }

  function pad(value) { return (value < 10 ? "0" : "") + value; }

  function setDeviceStatus(message) {
    byId("device-status-text").textContent = message;
    byId("device-status-text-mobile").textContent = message;
  }

  function startCountdown(totalSeconds) {
    clearCountdown();
    var remaining = totalSeconds;
    function tick() {
      if (remaining <= 0) {
        clearCountdown();
        setDeviceStatus("The code has expired.");
        return;
      }
      var minutes = Math.floor(remaining / 60);
      var seconds = remaining % 60;
      setDeviceStatus("Waiting for you to approve. The code expires in " + pad(minutes) + ":" + pad(seconds) + ".");
      remaining -= 1;
    }
    tick();
    countdownHandle = setInterval(tick, 1000);
  }

  function renderProgress() {
    var latest = progressMessages[progressMessages.length - 1] || "";
    byId("progress-latest").textContent = latest;
    var list = byId("progress-list");
    list.innerHTML = "";
    for (var i = 0; i < progressMessages.length; i++) {
      var isLast = i === progressMessages.length - 1;
      var item = document.createElement("li");
      item.className = "sb-status " + (isLast ? "is-off" : "is-on");
      item.innerHTML = (isLast ? SPIN : CHECK) + escapeHtml(progressMessages[i]);
      list.appendChild(item);
    }
  }

  function clearFieldError() {
    byId("redirect-input").classList.remove("is-invalid");
    byId("redirect-input").removeAttribute("aria-invalid");
    byId("redirect-error").hidden = true;
    byId("redirect-hint").hidden = false;
  }

  function showFieldError() {
    byId("redirect-input").classList.add("is-invalid");
    byId("redirect-input").setAttribute("aria-invalid", "true");
    byId("redirect-error").hidden = false;
    byId("redirect-hint").hidden = true;
  }

  function showPrompt() {
    byId("redirect-return").hidden = true;
    byId("redirect-field").hidden = false;
    byId("redirect-submit").hidden = false;
    byId("redirect-input").focus();
  }

  function resetPromptSubmission() {
    submitting = false;
    var button = byId("redirect-submit");
    button.classList.remove("is-loading");
    button.disabled = false;
  }

  function submitPrompt() {
    if (submitting) { return; }
    var input = byId("redirect-input");
    var value = input.value.trim();
    if (value.length === 0) { showFieldError(); input.focus(); return; }
    clearFieldError();
    submitting = true;
    var button = byId("redirect-submit");
    button.classList.add("is-loading");
    button.disabled = true;
    fetch("/login/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value }),
    }).then(function (response) {
      if (!response.ok) { throw new Error("Request failed (" + response.status + ")"); }
    }).catch(function (error) {
      submitting = false;
      button.classList.remove("is-loading");
      button.disabled = false;
      byId("failure-message").textContent = error instanceof Error ? error.message : String(error);
      showState("failure");
    });
  }

  evtSource.addEventListener("auth", function (event) {
    var data = JSON.parse(event.data);
    if (typeof data.instructions === "string" && data.instructions.trim() !== "") {
      byId("redirect-instructions").textContent = data.instructions;
    }
    byId("redirect-link").href = data.url;
    showState("redirect");
  });

  evtSource.addEventListener("prompt", function (event) {
    var data = JSON.parse(event.data);
    if (typeof data.message === "string" && data.message.trim() !== "") {
      byId("redirect-label").textContent = data.message;
    }
    resetPromptSubmission();
    byId("redirect-input").value = "";
    clearFieldError();
    showState("redirect");
    showPrompt();
  });

  evtSource.addEventListener("device_code", function (event) {
    var data = JSON.parse(event.data);
    var text = data.verificationUri;
    try {
      var url = new URL(data.verificationUri);
      text = url.host + url.pathname;
    } catch (parseError) {
      text = data.verificationUri;
    }
    byId("device-link").href = data.verificationUri;
    byId("device-link").textContent = text;
    byId("device-link-block").href = data.verificationUri;
    byId("device-link-block-text").textContent = text;
    byId("device-code").textContent = data.userCode;
    if (typeof data.expiresInSeconds === "number" && data.expiresInSeconds > 0) {
      startCountdown(data.expiresInSeconds);
    } else {
      setDeviceStatus("Waiting for you to approve.");
    }
    showState("device");
  });

  evtSource.addEventListener("progress", function (event) {
    var data = JSON.parse(event.data);
    progressMessages.push(data.message);
    renderProgress();
    showState("progress");
  });

  evtSource.addEventListener("success", function () {
    evtSource.close();
    clearCountdown();
    showState("success");
  });

  evtSource.addEventListener("error_event", function (event) {
    evtSource.close();
    clearCountdown();
    var data = JSON.parse(event.data);
    byId("failure-message").textContent = data.message;
    showState("failure");
  });

  byId("redirect-submit").addEventListener("click", submitPrompt);
  byId("redirect-input").addEventListener("input", clearFieldError);
  byId("redirect-input").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); submitPrompt(); }
  });
  byId("device-copy").addEventListener("click", function () {
    var button = byId("device-copy");
    if (!navigator.clipboard || !navigator.clipboard.writeText) { return; }
    navigator.clipboard.writeText(byId("device-code").textContent).then(function () {
      button.classList.add("is-copied");
      setTimeout(function () { button.classList.remove("is-copied"); }, 1500);
    }, function () {});
  });
  byId("failure-retry").addEventListener("click", function () { window.location.reload(); });
})();
</script>`;

  return renderPageShell({ title: `Log in with ${providerName}`, content });
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

function clearPendingPrompt(): void {
  if (pendingPromptAbortCleanup !== null) {
    pendingPromptAbortCleanup();
    pendingPromptAbortCleanup = null;
  }
  pendingPromptResolver = null;
  pendingPromptReject = null;
}

function getPromptCancellationError(prompt: AuthPrompt, flowSignal: AbortSignal): Error | undefined {
  if (loginCancelled || flowSignal.aborted) {
    return new Error("Login flow timed out");
  }
  if (prompt.signal?.aborted) {
    return new Error("Login prompt cancelled");
  }
  return undefined;
}

function waitForPrompt(prompt: AuthPrompt, flowSignal: AbortSignal): Promise<string> {
  const cancellationError = getPromptCancellationError(prompt, flowSignal);
  if (cancellationError !== undefined) {
    return Promise.reject(cancellationError);
  }

  return new Promise((resolve, reject) => {
    const signal = prompt.signal;

    const abortPendingPrompt = (): void => {
      if (pendingPromptReject !== reject) {
        return;
      }
      clearPendingPrompt();
      reject(new Error("Login prompt cancelled"));
    };

    lastPromptMessage = prompt.message;
    pendingPromptResolver = resolve;
    pendingPromptReject = reject;
    if (signal !== undefined) {
      signal.addEventListener("abort", abortPendingPrompt, { once: true });
      pendingPromptAbortCleanup = (): void => {
        signal.removeEventListener("abort", abortPendingPrompt);
      };
    }
    log.debug(`[stavrobot] handleLoginEvents: prompt called (${prompt.type}), sending prompt event`);
    sendActiveSseEvent("prompt", { message: prompt.message });
  });
}

function clearFlowState(flowId: number): void {
  if (flowId !== loginFlowCounter) {
    return;
  }
  if (flowTimeoutHandle !== null) {
    clearTimeout(flowTimeoutHandle);
    flowTimeoutHandle = null;
  }
  const pendingReject = pendingPromptReject;
  clearPendingPrompt();
  if (pendingReject !== null) {
    pendingReject(new Error("Login flow finished"));
  }
  if (activeFlowController !== null) {
    activeFlowController.abort();
    activeFlowController = null;
  }
  loginFlowActive = false;
  activeResponse = null;
  activeIsConnected = false;
  lastAuthEvent = null;
  lastDeviceCodeInfo = null;
  lastPromptMessage = null;
  loginCancelled = false;
}

export function serveLoginPage(response: http.ServerResponse, config: Config): void {
  const provider = builtinProviders().find((candidate) => candidate.id === config.provider && candidate.auth.oauth !== undefined);
  const providerName = provider?.name ?? config.provider;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(buildLoginPageHtml(providerName));
}

export async function handleLoginEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: Config,
  resolveProvider: OAuthAuthResolver = resolveOAuthAuth,
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

  const oauth = resolveProvider(config.provider);
  if (oauth === undefined) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const validIds = builtinProviders().filter((candidate) => candidate.auth.oauth !== undefined).map((candidate) => candidate.id).join(", ");
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
  if (loginFlowActive) {
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
    if (lastDeviceCodeInfo !== null) {
      sendSseEvent(response, "device_code", lastDeviceCodeInfo);
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
  loginFlowActive = true;

  activeResponse = response;
  activeIsConnected = true;

  request.on("close", () => {
    log.debug(`[stavrobot] handleLoginEvents: client disconnected (flow ${flowId})`);
    if (flowId === loginFlowCounter) {
      activeIsConnected = false;
    }
  });

  log.debug(`[stavrobot] handleLoginEvents: starting login flow ${flowId} for provider "${config.provider}"`);

  // Per-flow AbortController so we can cancel oauth.login() on timeout.
  // This is captured in the timeout closure below; clearFlowState resets the
  // module-level reference and aborts any leftover controller.
  const flowController = new AbortController();
  activeFlowController = flowController;

  // Cancel the flow if no client reconnects within the timeout window. This
  // prevents the library's callback server from staying open indefinitely when
  // the user abandons the login page.
  flowTimeoutHandle = setTimeout(() => {
    if (flowId === loginFlowCounter && loginFlowActive) {
      log.warn(`[stavrobot] handleLoginEvents: flow ${flowId} timed out after ${FLOW_TIMEOUT_MS / 1000}s`);
      loginCancelled = true;
      const pendingReject = pendingPromptReject;
      if (pendingReject !== null) {
        clearPendingPrompt();
      }
      flowController.abort();
      if (pendingReject !== null) {
        // The library is currently blocked waiting for user input. Rejecting its
        // promise causes it to call cancelWait() and close the callback server.
        // The resulting throw propagates to the catch block, which sends an
        // error event, then runs clearFlowState via finally.
        pendingReject(new Error("Login flow timed out"));
      } else {
        // The library hasn't called prompt() yet (or has already moved past it).
        // A later prompt rejects immediately because the flow is already marked
        // cancelled.
        //
        // Known limitation: cancellation here relies on the provider honouring
        // the abort signal. The built-in device-code providers (GitHub Copilot,
        // OpenAI Codex) forward it, and prompt-based providers (Anthropic, the
        // default) settle via the rejected prompt above. A hypothetical provider
        // that polls in the background without a pending prompt AND ignores the
        // signal would not settle oauth.login() here, leaving the flow running
        // until it completes. We do not race/detach oauth.login() because that
        // would leak its callback server — the abort signal is the library's
        // public cancellation contract and we rely on it.
      }
    }
  }, FLOW_TIMEOUT_MS);

  try {
    const credentials = await oauth.login({
      signal: flowController.signal,
      notify: (event): void => {
        switch (event.type) {
          case "auth_url":
            log.debug("[stavrobot] handleLoginEvents: auth_url received, sending auth event");
            lastAuthEvent = { url: event.url, instructions: event.instructions };
            sendActiveSseEvent("auth", { url: event.url, instructions: event.instructions });
            return;
          case "device_code":
            log.debug("[stavrobot] handleLoginEvents: device_code received, sending device_code event");
            lastDeviceCodeInfo = {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds,
              expiresInSeconds: event.expiresInSeconds,
            };
            sendActiveSseEvent("device_code", lastDeviceCodeInfo);
            return;
          case "progress":
          case "info":
            log.debug(`[stavrobot] handleLoginEvents: ${event.type}:`, event.message);
            sendActiveSseEvent("progress", { message: event.message });
            return;
        }
      },
      prompt: async (prompt): Promise<string> => {
        const cancellationError = getPromptCancellationError(prompt, flowController.signal);
        if (cancellationError !== undefined) {
          throw cancellationError;
        }

        if (prompt.type === "select") {
          const options = prompt.options.map((option) => option.id).join(", ");
          log.debug(`[stavrobot] handleLoginEvents: select prompt received, options: [${options}]`);
          const preferenceOrder = ["copy_code", "device_code", "device-code", "browser"];
          for (const preferredId of preferenceOrder) {
            if (prompt.options.some((option) => option.id === preferredId)) {
              log.debug(`[stavrobot] handleLoginEvents: select prompt picking '${preferredId}'`);
              return preferredId;
            }
          }
          log.debug(`[stavrobot] handleLoginEvents: select prompt has no preferred option, picking first: ${prompt.options[0].id}`);
          return prompt.options[0].id;
        }

        return waitForPrompt(prompt, flowController.signal);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[stavrobot] handleLoginEvents: login failed:", message);
    if (activeIsConnected && activeResponse !== null) {
      sendSseEvent(activeResponse, "error_event", { message });
      activeResponse.end();
    }
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
  clearPendingPrompt();
  resolver(value);

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}
