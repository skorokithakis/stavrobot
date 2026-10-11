import fs from "fs";
import http from "http";
import type { Config } from "./config.js";
import { getConfigPath, parseConfig } from "./config.js";
import { log } from "./log.js";
import { renderPageShell } from "./shell.js";
import { getUptime } from "./uptime.js";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function handleGetConfigRequest(response: http.ServerResponse): void {
  try {
    const configPath = getConfigPath();
    const content = fs.readFileSync(configPath, "utf-8");
    log.debug("[stavrobot] handleGetConfigRequest: returning config content");
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ content }));
  } catch (error: unknown) {
    log.error("[stavrobot] handleGetConfigRequest: unable to read config", getErrorMessage(error));
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unable to read config." }));
  }
}

export async function handlePutConfigRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Request body must be a JSON object" }));
    return;
  }

  const content = (parsed as Record<string, unknown>).content;
  if (typeof content !== "string") {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'content' must be a string" }));
    return;
  }

  try {
    parseConfig(content);
  } catch (error: unknown) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: getErrorMessage(error) }));
    return;
  }

  try {
    const configPath = getConfigPath();
    fs.copyFileSync(configPath, `${configPath}.bak`);
    fs.writeFileSync(configPath, content, "utf-8");
  } catch (error: unknown) {
    log.error("[stavrobot] handlePutConfigRequest: unable to save config", getErrorMessage(error));
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unable to save config." }));
    return;
  }

  log.info("[stavrobot] handlePutConfigRequest: config saved, restarting application");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({}));
  setTimeout((): void => {
    process.exit(0);
  }, 500);
}

const CONFIG_EDITOR_CONTENT = `<div class="sb-page-h">
  <div>
    <h1 class="sb-h1">Config</h1>
    <p>The main settings file, <span class="sb-mono">config.toml</span>. Edit it as text, then save.</p>
  </div>
  <button class="sb-btn sb-btn-primary" data-save-button type="button" disabled>Save and restart</button>
</div>

<div class="sb-callout is-warning">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20h19z"></path><path d="M12 10v4M12 17v.5"></path></svg>
  <div><strong>Saving restarts the bot</strong>It also interrupts any in-progress agent turn. plugin-runner, coder, signal-bridge, and python-runner read config.toml only at their own startup, so changes that affect them need a manual restart of those containers.</div>
</div>

<div class="sb-banner is-progress" id="config-banner" role="status">
  <span id="config-banner-icon"><span class="sb-spinner"></span></span>
  <span id="config-banner-text">Loading config...</span>
  <button class="sb-btn sb-btn-secondary sb-btn-sm sb-banner-action sb-hidden" id="config-banner-action" type="button"></button>
</div>

<div class="sb-field">
  <div class="sb-field-head">
    <label class="sb-field-label" for="config-content">config.toml</label>
    <span class="sb-hint sb-hidden" id="config-unsaved">Unsaved changes</span>
  </div>
  <textarea id="config-content" class="sb-input sb-code-editor" spellcheck="false" placeholder="Loading config..." aria-describedby="config-hint" disabled></textarea>
  <span class="sb-hint" id="config-hint">Plain text. Drag the bottom edge to make it taller.</span>
</div>

<button class="sb-btn sb-btn-primary sb-btn-lg sb-btn-block sb-config-save-mobile" data-save-button type="button" disabled>Save and restart</button>

<script>
(function () {
  const editor = document.getElementById("config-content");
  const saveButtons = document.querySelectorAll("[data-save-button]");
  const banner = document.getElementById("config-banner");
  const bannerIcon = document.getElementById("config-banner-icon");
  const bannerText = document.getElementById("config-banner-text");
  const bannerAction = document.getElementById("config-banner-action");
  const unsavedIndicator = document.getElementById("config-unsaved");

  const SPINNER_ICON = '<span class="sb-spinner"></span>';
  const CHECK_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';
  const ERROR_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

  let savedContent = "";
  let isLoading = true;

  function showBanner(state, text, actionLabel, actionHandler) {
    banner.className = "sb-banner is-" + state;
    banner.setAttribute("role", state === "error" ? "alert" : "status");
    if (state === "progress") {
      bannerIcon.innerHTML = SPINNER_ICON;
    } else if (state === "success") {
      bannerIcon.innerHTML = CHECK_ICON;
    } else {
      bannerIcon.innerHTML = ERROR_ICON;
    }
    bannerText.textContent = text;
    if (actionLabel) {
      bannerAction.textContent = actionLabel;
      bannerAction.onclick = actionHandler;
      bannerAction.classList.remove("sb-hidden");
    } else {
      bannerAction.onclick = null;
      bannerAction.classList.add("sb-hidden");
    }
  }

  function hideBanner() {
    banner.classList.add("sb-hidden");
  }

  function setEnabled(enabled) {
    editor.disabled = !enabled;
    for (const button of saveButtons) {
      button.disabled = !enabled;
    }
  }

  function updateUnsaved() {
    if (isLoading || editor.value === savedContent) {
      unsavedIndicator.classList.add("sb-hidden");
    } else {
      unsavedIndicator.classList.remove("sb-hidden");
    }
  }

  function parseLineNumber(message) {
    const match = message.match(/\\b(?:row|line)\\s+(\\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  function goToLine(lineNumber) {
    const lines = editor.value.split("\\n");
    if (lineNumber < 1 || lineNumber > lines.length) {
      return;
    }
    let offset = 0;
    for (let index = 0; index < lineNumber - 1; index++) {
      offset += lines[index].length + 1;
    }
    editor.focus();
    editor.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
    const step = isNaN(lineHeight) ? 21 : lineHeight;
    editor.scrollTop = Math.max(0, (lineNumber - 1) * step - editor.clientHeight / 3);
  }

  function showSaveError(message) {
    const firstLine = message.split("\\n")[0].trim();
    const text = firstLine.length > 0 ? firstLine : "Could not save config.";
    const lineNumber = parseLineNumber(message);
    if (lineNumber === null) {
      showBanner("error", text);
    } else {
      showBanner("error", text, "Go to line " + lineNumber, function () {
        goToLine(lineNumber);
      });
    }
  }

  async function loadConfig() {
    isLoading = true;
    setEnabled(false);
    unsavedIndicator.classList.add("sb-hidden");
    showBanner("progress", "Loading config...");
    try {
      const response = await fetch("/api/settings/config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || typeof data.content !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : "Could not load config.toml.");
      }
      editor.value = data.content;
      savedContent = data.content;
      isLoading = false;
      setEnabled(true);
      hideBanner();
      updateUnsaved();
    } catch (error) {
      isLoading = false;
      setEnabled(false);
      editor.placeholder = "";
      showBanner("error", "Could not load config.toml.", "Try again", function () {
        void loadConfig();
      });
    }
  }

  async function saveConfig() {
    setEnabled(false);
    unsavedIndicator.classList.add("sb-hidden");
    showBanner("progress", "Saving...");
    try {
      const response = await fetch("/api/settings/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editor.value }),
      });
      if (response.ok) {
        showBanner("success", "Saved, restarting... The bot will be back in a few seconds.");
        return;
      }
      const data = await response.json().catch(function () {
        return {};
      });
      showSaveError(typeof data.error === "string" ? data.error : "Could not save config.");
    } catch (error) {
      showSaveError("Could not reach the server.");
    }
    setEnabled(true);
    updateUnsaved();
  }

  for (const button of saveButtons) {
    button.addEventListener("click", function () {
      void saveConfig();
    });
  }
  editor.addEventListener("input", updateUnsaved);
  void loadConfig();
})();
</script>`;

export function serveConfigSettingsPage(response: http.ServerResponse, config: Config): void {
  const html = renderPageShell({
    title: "Config",
    content: CONFIG_EDITOR_CONTENT,
    nav: { active: "config", model: config.model, uptime: getUptime() },
  });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}
