import fs from "fs";
import http from "http";
import { getConfigPath, parseConfig } from "./config.js";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";


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

const CONFIG_SETTINGS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Config editor</title>
  <style>
    ${getBaseStyles()}
    body { padding: 24px; }
    .notice {
      margin-bottom: 12px;
      padding: 12px;
      border: 1px solid var(--color-error-border);
      border-radius: 6px;
      background: var(--color-error-bg);
      font-size: 14px;
      line-height: 1.45;
    }
    .notice p + p { margin-top: 8px; }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 600;
    }
    textarea {
      display: block;
      width: 100%;
      min-height: 460px;
      padding: 12px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      line-height: 1.45;
      resize: vertical;
    }
    textarea:disabled { background: var(--color-input-disabled-bg); }
    #status {
      display: block;
      min-height: 20px;
      margin-top: 12px;
      font-size: 14px;
    }
    #status.status-success { color: var(--color-success); }
    #status.status-error { color: var(--color-error); }
  </style>
</head>
<body>
  <h1>Config editor</h1>
  <div class="section">
    <div class="notice">
      <p>Saving restarts the bot and interrupts any in-progress agent turn.</p>
      <p>plugin-runner, coder, signal-bridge, and python-runner read config.toml only at their own startup. Changes affecting them, such as the password, require manually restarting those containers.</p>
    </div>
    <label for="config-content">config.toml</label>
    <textarea id="config-content" rows="24" spellcheck="false" disabled></textarea>
    <button class="btn btn-primary" id="save-button" type="button" disabled>Save</button>
    <p id="status" role="status" aria-live="polite"></p>
  </div>

  <script>
    const configContent = document.getElementById("config-content");
    const saveButton = document.getElementById("save-button");
    const status = document.getElementById("status");

    function setStatus(message, isError) {
      status.textContent = message;
      status.className = isError ? "status-error" : "status-success";
    }

    async function loadConfig() {
      try {
        const response = await fetch("/api/settings/config", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || typeof data.content !== "string") {
          throw new Error(data.error || "Unable to load config.");
        }
        configContent.value = data.content;
        configContent.disabled = false;
        saveButton.disabled = false;
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    }

    async function saveConfig() {
      saveButton.disabled = true;
      setStatus("Saving...", false);

      try {
        const response = await fetch("/api/settings/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: configContent.value }),
        });
        if (response.ok) {
          setStatus("Saved, restarting…", false);
          return;
        }

        const data = await response.json();
        throw new Error(data.error || "Unable to save config.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
        saveButton.disabled = false;
      }
    }

    saveButton.addEventListener("click", () => {
      void saveConfig();
    });
    void loadConfig();
  </script>
</body>
</html>`;

export function serveConfigSettingsPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(CONFIG_SETTINGS_PAGE_HTML);
}
