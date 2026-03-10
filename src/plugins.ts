import http from "http";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handlePluginsListRequest(
  response: http.ServerResponse,
): Promise<void> {
  log.debug("[stavrobot] handlePluginsListRequest: proxying GET /bundles");
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
  const body = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginsListRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(body);
}

export async function handlePluginDetailRequest(
  response: http.ServerResponse,
  pluginName: string,
): Promise<void> {
  log.debug("[stavrobot] handlePluginDetailRequest: proxying GET /bundles/:name for", pluginName);
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${encodeURIComponent(pluginName)}`);
  const body = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginDetailRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(body);
}

// This returns actual config values which may contain secrets. It is only exposed on the
// authenticated main server (port 3000). It must never be exposed to the LLM agent.
export async function handlePluginConfigRequest(
  response: http.ServerResponse,
  pluginName: string,
  password: string | undefined,
): Promise<void> {
  if (password === undefined) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Server password not configured; cannot proxy config request." }));
    return;
  }
  log.debug("[stavrobot] handlePluginConfigRequest: proxying GET /bundles/:name/config for", pluginName);
  const pluginResponse = await fetch(
    `${PLUGIN_RUNNER_BASE_URL}/bundles/${encodeURIComponent(pluginName)}/config`,
    {
      headers: { "Authorization": `Bearer ${password}` },
    },
  );
  const body = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginConfigRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(body);
}

export async function handlePluginInstallRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  log.debug("[stavrobot] handlePluginInstallRequest: proxying POST /install");
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginInstallRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(responseBody);
}

export async function handlePluginUpdateRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  log.debug("[stavrobot] handlePluginUpdateRequest: proxying POST /update");
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginUpdateRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(responseBody);
}

export async function handlePluginRemoveRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  log.debug("[stavrobot] handlePluginRemoveRequest: proxying POST /remove");
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginRemoveRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(responseBody);
}

export async function handlePluginConfigureRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  log.debug("[stavrobot] handlePluginConfigureRequest: proxying POST /configure");
  const pluginResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginConfigureRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(responseBody);
}

const PLUGINS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plugins</title>
  <style>
    ${getBaseStyles()}
    body { padding: 24px; }
    h1 { margin-bottom: 20px; }
    .install-form {
      background: var(--color-surface);
      box-shadow: 0 1px 3px var(--color-shadow), 0 1px 2px var(--color-shadow-secondary);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      display: flex;
      gap: 8px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .install-form input[type="text"] {
      flex: 1;
      min-width: 0;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 14px;
      transition: all 0.15s ease;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .install-form button {
      padding: 8px 16px;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: 0 1px 2px var(--color-shadow);
      transition: all 0.15s ease;
      width: 100%;
    }
    @media (min-width: 481px) {
      .install-form button { width: auto; }
    }
    .install-form button:hover:not(:disabled) { background: var(--color-accent-hover); box-shadow: 0 2px 4px var(--color-shadow); transform: translateY(-1px); }
    .install-form button:disabled { opacity: 0.5; cursor: default; }
    #install-message {
      width: 100%;
      font-size: 13px;
      margin-top: 4px;
    }
    #install-message.success { color: var(--color-success); }
    #install-message.error { color: var(--color-error); }
    #plugin-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .plugin-card {
      background: var(--color-surface);
      box-shadow: 0 1px 3px var(--color-shadow), 0 1px 2px var(--color-shadow-secondary);
      border-radius: 8px;
      padding: 16px;
      border-left: 4px solid var(--color-success);
      transition: border-color 0.15s ease;
    }
    .plugin-card.perm-all { border-left-color: var(--color-success); }
    .plugin-card.perm-selected { border-left-color: var(--color-accent); }
    .plugin-card.perm-disabled { border-left-color: var(--color-error); }
    .plugin-card.collapsed {
      cursor: pointer;
    }
    .plugin-header {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
    }
    .plugin-header .chevron {
      margin-left: auto;
      font-size: 10px;
      color: var(--color-text-muted);
      transition: transform 0.2s ease;
      /* Rotated 90deg when expanded so it points down; default points right. */
      transform: rotate(0deg);
    }
    .plugin-card:not(.collapsed) .plugin-header .chevron {
      transform: rotate(90deg);
    }
    .plugin-body {
      margin-top: 8px;
    }
    .plugin-card.collapsed .plugin-body {
      display: none;
    }
    .plugin-name {
      font-size: 16px;
      font-weight: 600;
    }
    .plugin-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--color-border-light);
      color: var(--color-text-secondary);
      border: 1px solid var(--color-border);
    }
    .plugin-description {
      font-size: 14px;
      color: var(--color-text-secondary);
      margin-bottom: 12px;
    }
    .tools-section {
      margin-bottom: 12px;
    }
    .tools-section h3 {
      font-size: 12px;
      font-weight: 600;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .tool-item {
      font-size: 13px;
      padding: 4px 0;
      border-bottom: 1px solid var(--color-border-light);
    }
    .tool-item:last-child { border-bottom: none; }
    .tool-name { font-weight: 500; }
    .tool-description { color: var(--color-text-secondary); margin-left: 6px; }
    @media (max-width: 480px) {
      .tool-description { display: block; margin-left: 0; margin-top: 2px; }
    }
    .permissions-section {
      margin-bottom: 12px;
    }
    .permissions-section h3 {
      font-size: 12px;
      font-weight: 600;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .permissions-mode {
      margin-bottom: 8px;
    }
    .permissions-mode select {
      padding: 6px 8px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 13px;
      background: var(--color-surface);
      color: var(--color-text);
      transition: all 0.15s ease;
    }
    .permissions-tools {
      margin-bottom: 8px;
    }
    .permissions-tool-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 13px;
    }
    .permissions-tool-item input[type="checkbox"] {
      cursor: pointer;
    }
    .config-section {
      margin-bottom: 12px;
    }
    .config-section h3 {
      font-size: 12px;
      font-weight: 600;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .config-field {
      margin-bottom: 8px;
    }
    .config-field label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--color-text-secondary);
      margin-bottom: 3px;
    }
    .config-field label .required-mark {
      color: var(--color-error);
      margin-left: 2px;
    }
    .config-field input[type="text"] {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 13px;
      transition: all 0.15s ease;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    @media (max-width: 480px) {
      .actions { flex-direction: column; }
      .actions .btn { width: 100%; text-align: center; }
    }
    .btn {
      padding: 6px 14px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      background: var(--color-surface);
      color: var(--color-text);
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) { background: var(--color-bg); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .btn-primary {
      background: var(--color-accent);
      color: #fff;
      border-color: var(--color-accent);
      box-shadow: 0 1px 2px var(--color-shadow);
    }
    .btn-primary:hover:not(:disabled) { background: var(--color-accent-hover); border-color: var(--color-accent-hover); box-shadow: 0 2px 4px var(--color-shadow); transform: translateY(-1px); }
    .btn-danger {
      color: var(--color-error);
      border-color: var(--color-error-border);
    }
    .btn-danger:hover:not(:disabled) { background: var(--color-error-bg); }
    .card-message {
      font-size: 13px;
      margin-top: 8px;
    }
    .card-message.success { color: var(--color-success); }
    .card-message.error { color: var(--color-error); }
    #loading {
      color: var(--color-text-muted);
      font-size: 14px;
      padding: 24px 0;
    }
  </style>
</head>
<body>
  <h1>Plugins</h1>

  <div class="install-form">
    <input type="text" id="install-url" placeholder="Git repository URL..." />
    <button id="install-btn" onclick="installPlugin()">Install</button>
    <div id="install-message"></div>
  </div>

  <div id="plugin-list">
    <div id="loading">Loading plugins...</div>
  </div>

  <script>
    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = String(text);
      return div.innerHTML;
    }

    async function loadPlugins() {
      const listEl = document.getElementById("plugin-list");
      listEl.innerHTML = '<div id="loading">Loading plugins...</div>';

      const listResponse = await fetch("/api/settings/plugins/list");
      const listData = await listResponse.json();
      const plugins = listData.plugins || [];

      if (plugins.length === 0) {
        listEl.innerHTML = '<div id="loading">No plugins installed.</div>';
        return;
      }

      // Fetch detail and config for all plugins in parallel.
      const pluginData = await Promise.all(plugins.map(async (plugin) => {
        const [detailResponse, configResponse] = await Promise.all([
          fetch(\`/api/settings/plugins/\${encodeURIComponent(plugin.name)}/detail\`),
          fetch(\`/api/settings/plugins/\${encodeURIComponent(plugin.name)}/config\`),
        ]);
        const detail = await detailResponse.json();
        const config = await configResponse.json();
        return { plugin, detail, config };
      }));

      listEl.innerHTML = "";
      for (const { plugin, detail, config } of pluginData) {
        listEl.appendChild(renderPluginCard(plugin, detail, config));
      }
    }

    function renderPluginCard(plugin, detail, config) {
      const card = document.createElement("div");
      card.className = "plugin-card";
      card.id = "card-" + plugin.name;

      const tools = detail.tools || [];
      const schema = (config && config.schema) ? config.schema : {};
      const values = (config && config.values) ? config.values : {};
      const hasConfig = Object.keys(schema).length > 0;

      const toolsHtml = tools.length > 0
        ? \`<div class="tools-section">
            <h3>Tools (\${tools.length})</h3>
            \${tools.map(tool => \`
              <div class="tool-item">
                <span class="tool-name">\${escapeHtml(tool.name)}</span>
                \${tool.description ? \`<span class="tool-description">— \${escapeHtml(tool.description)}</span>\` : ""}
              </div>
            \`).join("")}
          </div>\`
        : "";

      const permissions = detail.permissions || [];
      let permissionsMode;
      if (permissions.length === 1 && permissions[0] === "*") {
        permissionsMode = "all";
      } else if (permissions.length === 0) {
        permissionsMode = "disabled";
      } else {
        permissionsMode = "selected";
      }

      const permissionsToolsHtml = tools.length > 0
        ? \`<div class="permissions-tools" id="perm-tools-\${escapeHtml(plugin.name)}" style="\${permissionsMode !== "selected" ? "display:none;" : ""}">
            \${tools.map(tool => \`
              <div class="permissions-tool-item">
                <input type="checkbox"
                  id="perm-\${escapeHtml(plugin.name)}-\${escapeHtml(tool.name)}"
                  data-tool="\${escapeHtml(tool.name)}"
                  \${permissions.includes(tool.name) ? "checked" : ""}
                />
                <label for="perm-\${escapeHtml(plugin.name)}-\${escapeHtml(tool.name)}">\${escapeHtml(tool.name)}</label>
              </div>
            \`).join("")}
          </div>\`
        : "";

      const permissionsHtml = \`<div class="permissions-section">
          <h3>Permissions</h3>
          <div class="permissions-mode">
            <select id="perm-mode-\${escapeHtml(plugin.name)}" onchange="onPermissionsModeChange('\${escapeHtml(plugin.name)}')">
              <option value="all" \${permissionsMode === "all" ? "selected" : ""}>All tools</option>
              <option value="disabled" \${permissionsMode === "disabled" ? "selected" : ""}>Disabled</option>
              <option value="selected" \${permissionsMode === "selected" ? "selected" : ""}>Selected tools</option>
            </select>
          </div>
          \${permissionsToolsHtml}
          <div class="actions" style="margin-top:8px;">
            <button class="btn btn-primary" onclick="savePermissions('\${escapeHtml(plugin.name)}')">Save permissions</button>
          </div>
        </div>\`;

      const configHtml = hasConfig
        ? \`<div class="config-section">
            <h3>Configuration</h3>
            \${Object.entries(schema).map(([key, fieldSchema]) => {
              const field = fieldSchema;
              const currentValue = values[key] !== undefined ? values[key] : "";
              const isRequired = field.required === true;
              return \`<div class="config-field">
                <label>
                  \${escapeHtml(key)}\${isRequired ? '<span class="required-mark">*</span>' : ""}
                </label>
                <input type="text"
                  id="config-\${escapeHtml(plugin.name)}-\${escapeHtml(key)}"
                  data-key="\${escapeHtml(key)}"
                  placeholder="\${field.description ? escapeHtml(field.description) : ""}"
                  value="\${escapeHtml(String(currentValue))}"
                />
              </div>\`;
            }).join("")}
            <div class="actions" style="margin-top:8px;">
              <button class="btn btn-primary" onclick="saveConfig('\${escapeHtml(plugin.name)}')">Save config</button>
            </div>
          </div>\`
        : "";

      const updateBtn = plugin.editable === false
        ? \`<button class="btn" onclick="updatePlugin('\${escapeHtml(plugin.name)}')">Update</button>\`
        : "";

      card.className = "plugin-card collapsed perm-" + permissionsMode;
      card.innerHTML = \`
        <div class="plugin-header">
          <span class="plugin-name">\${escapeHtml(plugin.name)}</span>
          <span class="plugin-badge">\${plugin.editable ? "editable" : "git"}</span>
          <span class="chevron">&#9658;</span>
        </div>
        <div class="plugin-body">
          \${plugin.description ? \`<div class="plugin-description">\${escapeHtml(plugin.description)}</div>\` : ""}
          \${toolsHtml}
          \${permissionsHtml}
          \${configHtml}
          <div class="actions">
            \${updateBtn}
            <button class="btn btn-danger" onclick="deletePlugin('\${escapeHtml(plugin.name)}')">Delete</button>
          </div>
          <div class="card-message" id="msg-\${escapeHtml(plugin.name)}"></div>
        </div>
      \`;

      card.querySelector(".plugin-header").addEventListener("click", (e) => {
        e.stopPropagation();
        card.classList.toggle("collapsed");
      });
      card.addEventListener("click", () => {
        if (!card.classList.contains("collapsed")) return;
        card.classList.remove("collapsed");
      });

      for (const input of card.querySelectorAll(".config-field input[data-key]")) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") saveConfig(plugin.name);
        });
      }

      return card;
    }

    function showCardMessage(pluginName, text, isError) {
      const el = document.getElementById("msg-" + pluginName);
      if (!el) return;
      el.textContent = text;
      el.className = "card-message " + (isError ? "error" : "success");
    }

    async function installPlugin() {
      const urlInput = document.getElementById("install-url");
      const btn = document.getElementById("install-btn");
      const msgEl = document.getElementById("install-message");
      const url = urlInput.value.trim();
      if (!url) return;

      btn.disabled = true;
      btn.textContent = "Installing...";
      msgEl.textContent = "";
      msgEl.className = "";

      const response = await fetch("/api/settings/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();

      btn.disabled = false;
      btn.textContent = "Install";

      if (response.ok) {
        msgEl.textContent = data.message || "Installed successfully.";
        msgEl.className = "success";
        urlInput.value = "";
        await loadPlugins();
      } else {
        msgEl.textContent = data.error || data.message || "Installation failed.";
        msgEl.className = "error";
      }
    }

    async function updatePlugin(name) {
      showCardMessage(name, "Updating...", false);
      const response = await fetch("/api/settings/plugins/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (response.ok) {
        showCardMessage(name, data.message || "Updated successfully.", false);
        await loadPlugins();
      } else {
        showCardMessage(name, data.error || data.message || "Update failed.", true);
      }
    }

    async function deletePlugin(name) {
      if (!window.confirm("Delete plugin \\"" + name + "\\"? This cannot be undone.")) return;
      showCardMessage(name, "Deleting...", false);
      const response = await fetch("/api/settings/plugins/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (response.ok) {
        await loadPlugins();
      } else {
        showCardMessage(name, data.error || data.message || "Delete failed.", true);
      }
    }

    async function saveConfig(name) {
      const card = document.getElementById("card-" + name);
      const inputs = card.querySelectorAll(".config-field input[data-key]");
      const config = {};
      for (const input of inputs) {
        config[input.dataset.key] = input.value;
      }
      showCardMessage(name, "Saving...", false);
      const response = await fetch("/api/settings/plugins/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config }),
      });
      const data = await response.json();
      if (response.ok) {
        showCardMessage(name, data.message || "Config saved.", false);
      } else {
        showCardMessage(name, data.error || data.message || "Failed to save config.", true);
      }
    }

    function onPermissionsModeChange(name) {
      const select = document.getElementById("perm-mode-" + name);
      const toolsEl = document.getElementById("perm-tools-" + name);
      if (!toolsEl) return;
      toolsEl.style.display = select.value === "selected" ? "" : "none";
    }

    async function savePermissions(name) {
      const select = document.getElementById("perm-mode-" + name);
      let permissions;
      if (select.value === "all") {
        permissions = ["*"];
      } else if (select.value === "disabled") {
        permissions = [];
      } else {
        const toolsEl = document.getElementById("perm-tools-" + name);
        const checkboxes = toolsEl ? toolsEl.querySelectorAll("input[type='checkbox'][data-tool]") : [];
        permissions = Array.from(checkboxes)
          .filter(cb => cb.checked)
          .map(cb => cb.dataset.tool);
      }
      showCardMessage(name, "Saving...", false);
      const response = await fetch("/api/settings/plugins/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config: { permissions } }),
      });
      const data = await response.json();
      if (response.ok) {
        showCardMessage(name, data.message || "Permissions saved.", false);
        const card = document.getElementById("card-" + name);
        card.classList.remove("perm-all", "perm-selected", "perm-disabled");
        card.classList.add("perm-" + select.value);
      } else {
        showCardMessage(name, data.error || data.message || "Failed to save permissions.", true);
      }
    }

    loadPlugins();

    document.getElementById("install-url").addEventListener("keydown", (event) => {
      if (event.key === "Enter") installPlugin();
    });
  </script>
</body>
</html>`;

export function servePluginsPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(PLUGINS_PAGE_HTML);
}
