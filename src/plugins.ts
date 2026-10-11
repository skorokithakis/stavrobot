import http from "http";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { internalFetch } from "./internal-fetch.js";
import { renderPageShell } from "./shell.js";
import { getUptime } from "./uptime.js";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PluginConfigFieldSchema {
  description: string;
  required: boolean;
}

export interface PluginConfigProxyResponse {
  schema: Record<string, PluginConfigFieldSchema>;
  set: Record<string, boolean>;
}

export async function handlePluginsListRequest(
  response: http.ServerResponse,
): Promise<void> {
  log.debug("[stavrobot] handlePluginsListRequest: proxying GET /bundles");
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
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
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${encodeURIComponent(pluginName)}`);
  const body = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginDetailRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(body);
}

// The plugin-runner returns config values that may contain secrets. The browser
// must never receive them: this proxy rewrites the response to report, per key,
// only whether a value is set, plus the (non-secret) manifest schema. The
// configure endpoint still accepts values and merges them server-side.
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
  const pluginResponse = await internalFetch(
    `${PLUGIN_RUNNER_BASE_URL}/bundles/${encodeURIComponent(pluginName)}/config`,
  );
  const body = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginConfigRequest: response status", pluginResponse.status);

  if (!pluginResponse.ok) {
    response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
    response.end(body);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid response from plugin-runner." }));
    return;
  }

  const schemaSource = isRecord(parsed) && isRecord(parsed["schema"]) ? parsed["schema"] : {};
  const values = isRecord(parsed) && isRecord(parsed["values"]) ? parsed["values"] : {};

  // Rebuild the schema from known, non-secret fields only. In particular, drop
  // the manifest's `default`, which may in principle hold a sensitive value.
  const schema: Record<string, PluginConfigFieldSchema> = {};
  for (const [key, entry] of Object.entries(schemaSource)) {
    if (!isRecord(entry)) {
      continue;
    }
    schema[key] = {
      description: typeof entry["description"] === "string" ? entry["description"] : "",
      required: entry["required"] === true,
    };
  }

  const set: Record<string, boolean> = {};
  for (const key of Object.keys(schema)) {
    set[key] = Object.prototype.hasOwnProperty.call(values, key);
  }

  const result: PluginConfigProxyResponse = { schema, set };
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(result));
}

export async function handlePluginInstallRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  log.debug("[stavrobot] handlePluginInstallRequest: proxying POST /install");
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
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
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
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
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
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
  const pluginResponse = await internalFetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await pluginResponse.text();
  log.debug("[stavrobot] handlePluginConfigureRequest: response status", pluginResponse.status);
  response.writeHead(pluginResponse.status, { "Content-Type": "application/json" });
  response.end(responseBody);
}

function buildPluginsContent(): string {
  return `<div class="sb-page-h" style="align-items: flex-start">
  <div>
    <h1 class="sb-h1">Plugins</h1>
    <p>Plugins give Stavrobot tools. Install one from a git repository.</p>
  </div>
  <form style="display: flex; flex-direction: column; gap: 8px; width: 560px" data-install-form>
    <div class="sb-input-row">
      <label for="install-url" class="sb-sr">Git repository URL</label>
      <input id="install-url" class="sb-input sb-mono" data-install-url placeholder="https://github.com/example/stavrobot-plugin.git">
      <button class="sb-btn sb-btn-primary" type="button" data-install-btn>Install</button>
    </div>
    <span class="sb-feedback" data-install-feedback role="status"></span>
  </form>
</div>

<div class="sb-mobile-only" data-mobile-install>
  <form style="display: flex; flex-direction: column; gap: 8px" data-install-form>
    <div class="sb-input-row">
      <label for="install-url-mobile" class="sb-sr">Git repository URL</label>
      <input id="install-url-mobile" class="sb-input sb-input-lg sb-mono" data-install-url placeholder="Git repository URL">
      <button class="sb-btn sb-btn-primary sb-btn-lg" type="button" data-install-btn>Install</button>
    </div>
    <span class="sb-feedback" data-install-feedback role="status"></span>
  </form>
</div>

<div class="sb-plugins-layout">
  <section class="sb-card" id="installed-card" style="overflow: hidden" aria-labelledby="installed-heading">
    <div class="sb-card-h"><h2 class="sb-h2" id="installed-heading">Installed</h2><span class="sb-badge sb-badge-solid" data-count-badge>0</span></div>
    <div data-list-body><div class="sb-state"><span class="sb-spinner sb-spinner-lg" style="color: var(--muted)"></span><strong>Loading plugins...</strong></div></div>
  </section>
  <section class="sb-card sb-detail-card" id="plugin-detail" hidden></section>
</div>

<div class="sb-confirm-mobile" data-confirm-mobile hidden>
  <div class="sb-confirm-scrim" data-confirm-cancel></div>
  <div class="sb-sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title-mobile">
    <div class="sb-sheet-grip"></div>
    <strong id="confirm-title-mobile" style="font-size: 17px" data-confirm-title></strong>
    <p class="sb-muted" style="margin: 0; font-size: 15px">Stavrobot loses its tools and its saved settings. You cannot undo this.</p>
    <span class="sb-feedback" data-confirm-feedback role="alert"></span>
    <button class="sb-btn sb-btn-danger-fill sb-btn-lg sb-btn-block" type="button" data-confirm-delete>Delete plugin</button>
    <button class="sb-btn sb-btn-secondary sb-btn-lg sb-btn-block" type="button" data-confirm-cancel>Cancel</button>
  </div>
</div>

<script>
(function () {
  var LIST_URL = "/api/settings/plugins/list";
  var CONFIGURE_URL = "/api/settings/plugins/configure";
  var UPDATE_URL = "/api/settings/plugins/update";
  var REMOVE_URL = "/api/settings/plugins/remove";
  var INSTALL_URL = "/api/settings/plugins/install";

  var state = { plugins: [], selectedName: null, mobileShowDetail: false, confirmName: null };
  var mobileQuery = window.matchMedia("(max-width: 768px)");

  var listBody = document.querySelector("[data-list-body]");
  var countBadge = document.querySelector("[data-count-badge]");
  var listCard = document.getElementById("installed-card");
  var detailCard = document.getElementById("plugin-detail");
  var confirmMobile = document.querySelector("[data-confirm-mobile]");
  var shellHeader = document.querySelector(".sb-page > .sb-m-header");
  var mobileHeading = shellHeader ? shellHeader.querySelector("h1") : null;
  var originalHeading = mobileHeading ? mobileHeading.textContent : "Plugins";

  var CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';
  var CHECK_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';
  var ERROR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';
  var ERROR_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';
  var CHEV = '<svg class="sb-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  var SELECT_CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  var SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>';
  var UPDATE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"></path></svg>';
  var TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>';
  var BACK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg>';
  var SPINNER = '<span class="sb-spinner"></span>';

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function findPlugin(name) {
    for (var i = 0; i < state.plugins.length; i++) {
      if (state.plugins[i].name === name) {
        return state.plugins[i];
      }
    }
    return null;
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  function fetchDetail(name) {
    return fetchJson("/api/settings/plugins/" + encodeURIComponent(name) + "/detail");
  }

  function fetchConfig(name) {
    return fetchJson("/api/settings/plugins/" + encodeURIComponent(name) + "/config");
  }

  function permissionMode(plugin) {
    var permissions = plugin.permissions || [];
    if (permissions.length === 1 && permissions[0] === "*") {
      return "all";
    }
    if (permissions.length === 0) {
      return "none";
    }
    return "selected";
  }

  function selectedToolCount(plugin) {
    var permissions = plugin.permissions || [];
    var tools = plugin.tools || [];
    var count = 0;
    for (var i = 0; i < tools.length; i++) {
      if (permissions.indexOf(tools[i].name) !== -1) {
        count++;
      }
    }
    return count;
  }

  function missingRequired(plugin) {
    var schema = plugin.schema || {};
    var set = plugin.set || {};
    var missing = 0;
    for (var key in schema) {
      if (Object.prototype.hasOwnProperty.call(schema, key) && schema[key].required && !set[key]) {
        missing++;
      }
    }
    return missing;
  }

  function permissionStatusHtml(plugin) {
    var mode = permissionMode(plugin);
    if (mode === "all") {
      return '<span class="sb-status is-on" style="font-size: 12px"><span class="sb-dot sb-dot-on"></span>All tools</span>';
    }
    if (mode === "none") {
      return '<span class="sb-status is-err" style="font-size: 12px"><span class="sb-dot sb-dot-err"></span>No tools</span>';
    }
    return '<span class="sb-status is-warn" style="font-size: 12px"><span class="sb-dot sb-dot-warn"></span>Selected tools (' + selectedToolCount(plugin) + " of " + (plugin.tools || []).length + ")</span>";
  }

  function renderList() {
    if (countBadge) {
      countBadge.textContent = String(state.plugins.length);
    }
    if (!listBody) {
      return;
    }
    if (state.plugins.length === 0) {
      listBody.innerHTML = '<div class="sb-state"><div class="sb-state-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"></path></svg></div><strong>No plugins installed</strong><p>Paste a git repository URL above to install one.</p></div>';
      return;
    }
    var html = "";
    for (var i = 0; i < state.plugins.length; i++) {
      html += listItemHtml(state.plugins[i]);
    }
    listBody.innerHTML = html;
  }

  function listItemHtml(plugin) {
    var isActive = plugin.name === state.selectedName && (!mobileQuery.matches || state.mobileShowDetail);
    var badge = plugin.editable
      ? '<span class="sb-badge sb-badge-accent" style="margin-left: 6px">editable</span>'
      : '<span class="sb-badge" style="margin-left: 6px">git</span>';
    var notConfigured = missingRequired(plugin) > 0
      ? '<span class="sb-status is-err" style="font-size: 12px">Not configured</span>'
      : "";
    var subStyle = notConfigured ? ' style="display: flex; gap: 10px"' : "";
    return '<button class="sb-list-item' + (isActive ? " is-active" : "") + '" type="button" data-name="' + esc(plugin.name) + '"' + (isActive ? ' aria-current="true"' : "") + ">"
      + '<span class="sb-list-item-main"><span>' + esc(plugin.name) + " " + badge + "</span>"
      + '<span class="sb-list-item-sub"' + subStyle + ">" + permissionStatusHtml(plugin) + notConfigured + "</span></span>"
      + CHEV + "</button>";
  }

  function settingsStatusHtml(plugin) {
    var missing = missingRequired(plugin);
    if (missing > 0) {
      var noun = missing === 1 ? "field is" : "fields are";
      return '<span class="sb-status is-err sb-small"><span class="sb-dot sb-dot-err"></span>Not configured: ' + missing + " required " + noun + " missing</span>";
    }
    return '<span class="sb-status is-on sb-small"><span class="sb-dot sb-dot-on"></span>Configured</span>';
  }

  function configFieldHtml(key, field, isSet) {
    var requiredBadge = field.required ? '<span class="sb-req">Required</span>' : '<span class="sb-opt">(optional)</span>';
    var hint = field.description ? '<span class="sb-hint">' + esc(field.description) + "</span>" : "";
    var label = esc(key) + " " + requiredBadge;
    if (isSet) {
      return '<div class="sb-field" data-field="' + esc(key) + '">'
        + '<span class="sb-field-label">' + label + "</span>"
        + '<div class="sb-secret" data-secret><span class="sb-status is-on" style="font-size: 13px">' + CHECK_SM + "Set</span>"
        + '<span class="sb-dots">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span>'
        + '<button class="sb-btn sb-btn-ghost sb-btn-sm" type="button" data-replace="' + esc(key) + '">Replace</button></div>'
        + hint + "</div>";
    }
    if (field.required) {
      var errorId = "cfge-" + esc(key);
      return '<div class="sb-field" data-field="' + esc(key) + '">'
        + '<label for="cfg-' + esc(key) + '">' + label + "</label>"
        + '<input id="cfg-' + esc(key) + '" class="sb-input sb-mono is-invalid" type="text" data-config-input="' + esc(key) + '" placeholder="Not set: ' + esc(field.description) + '" aria-invalid="true" aria-describedby="' + errorId + '">'
        + '<span id="' + errorId + '" class="sb-field-error">' + ERROR_SM + "Required. The plugin does not work until this is set.</span>"
        + "</div>";
    }
    return '<div class="sb-field" data-field="' + esc(key) + '">'
      + '<span class="sb-field-label">' + label + "</span>"
      + '<div class="sb-secret" data-secret><span class="sb-status is-off" style="font-size: 13px">Not set</span>'
      + '<span class="sb-dots"></span>'
      + '<button class="sb-btn sb-btn-ghost sb-btn-sm" type="button" data-replace="' + esc(key) + '">Set value</button></div>'
      + hint + "</div>";
  }

  function settingsSectionHtml(plugin) {
    var schema = plugin.schema || {};
    var set = plugin.set || {};
    var fields = "";
    for (var key in schema) {
      if (Object.prototype.hasOwnProperty.call(schema, key)) {
        fields += configFieldHtml(key, schema[key], Boolean(set[key]));
      }
    }
    return '<div class="sb-detail-sec" data-settings-section>'
      + '<div class="sb-sec-h"><h3 class="sb-h3">Settings</h3>' + settingsStatusHtml(plugin) + "</div>"
      + fields
      + '<div class="sb-controls-row"><button class="sb-btn sb-btn-primary" type="button" data-save-settings disabled>Save settings</button><span class="sb-hint">Saved values are never shown again. Use Replace to change one.</span></div>'
      + "</div>";
  }

  function toolRowsHtml(plugin) {
    var tools = plugin.tools || [];
    var permissions = plugin.permissions || [];
    var mode = permissionMode(plugin);
    var html = "";
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      var checked = mode === "all" || (mode === "selected" && permissions.indexOf(tool.name) !== -1);
      html += '<label class="sb-check" data-tool-row="' + esc(tool.name) + '">'
        + '<input class="sb-checkbox" type="checkbox" data-tool="' + esc(tool.name) + '"' + (checked ? " checked" : "") + ">"
        + '<span><span class="sb-mono" style="display: block">' + esc(tool.name) + "</span>";
      if (tool.description) {
        html += '<span class="sb-muted sb-small">' + esc(tool.description) + "</span>";
      }
      html += "</span></label>";
    }
    return html;
  }

  function permissionsSectionHtml(plugin) {
    var mode = permissionMode(plugin);
    var tools = plugin.tools || [];
    var many = tools.length > 8;
    var html = '<div class="sb-detail-sec" data-perm-section>'
      + '<h3 class="sb-h3">Permissions</h3>'
      + '<div class="sb-field" style="width: 300px"><label for="perm-select">Agents can use</label>'
      + '<div class="sb-select-wrap"><select class="sb-input" id="perm-select" data-perm-select>'
      + '<option value="all"' + (mode === "all" ? " selected" : "") + ">All tools</option>"
      + '<option value="selected"' + (mode === "selected" ? " selected" : "") + ">Selected tools</option>"
      + '<option value="none"' + (mode === "none" ? " selected" : "") + ">No tools</option>"
      + "</select>" + SELECT_CHEV + "</div></div>"
      + '<div class="sb-checklist' + (mode === "selected" ? "" : " is-readonly") + '" data-checklist>'
      + '<div class="sb-checklist-h" data-checklist-h><label class="sb-check" style="font-weight: 500"><input class="sb-checkbox" type="checkbox" data-select-all>Select all</label><span class="sb-muted" data-count></span></div>';
    if (many) {
      html += '<div data-filter-wrap' + (mode === "selected" ? "" : " hidden") + '><div style="padding: 8px; border-bottom: 1px solid var(--border)"><div class="sb-search">' + SEARCH + '<input class="sb-input" type="search" data-filter placeholder="Filter ' + tools.length + ' tools" style="height: 32px" aria-label="Filter tools"></div></div></div>';
    }
    html += '<div class="sb-checklist-body" data-checklist-body>' + toolRowsHtml(plugin) + "</div></div>"
      + '<div class="sb-controls-row"><button class="sb-btn sb-btn-primary" type="button" data-save-permissions>Save permissions</button><span class="sb-feedback" data-perm-feedback role="status"></span></div>'
      + '<span class="sb-hint">With "All tools" or "No tools", the list shows the tools without checkboxes.</span>'
      + "</div>";
    return html;
  }

  function dangerZoneHtml(plugin) {
    return '<div class="sb-danger-zone" style="max-width: 720px"><div><strong>Delete this plugin</strong><span>Stavrobot loses its tools and its saved settings. You cannot undo this.</span></div>'
      + '<div class="sb-confirm"><button class="sb-btn sb-btn-danger" type="button" data-delete>' + TRASH + "Delete</button>"
      + '<div class="sb-popover sb-confirm-pop" data-confirm-pop role="dialog" aria-modal="true" aria-labelledby="confirm-title-desktop" hidden>'
      + '<strong id="confirm-title-desktop" data-confirm-title></strong>'
      + "<p>Stavrobot loses its tools and its saved settings. You cannot undo this.</p>"
      + '<span class="sb-feedback" data-confirm-feedback role="alert"></span>'
      + '<div class="sb-actions"><button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-confirm-cancel>Cancel</button><button class="sb-btn sb-btn-danger-fill sb-btn-sm" type="button" data-confirm-delete>Delete</button></div>'
      + "</div></div></div>";
  }

  function detailHtml(plugin) {
    var tools = plugin.tools || [];
    var schema = plugin.schema || {};
    var badge = plugin.editable
      ? '<span class="sb-badge sb-badge-accent">editable</span>'
      : '<span class="sb-badge">git</span>';
    var updateButton = plugin.editable
      ? ""
      : '<button class="sb-btn sb-btn-secondary" type="button" data-update>' + UPDATE + "Update</button>";
    var html = '<div class="sb-card-h sb-detail-h">'
      + '<div class="sb-detail-title"><h2 class="sb-h2" style="font-size: 22px">' + esc(plugin.name) + "</h2>" + badge + "</div>"
      + '<div style="display: flex; align-items: center; gap: 12px"><span class="sb-feedback" data-detail-feedback role="status"></span>' + updateButton + "</div>"
      + "</div>"
      + '<div class="sb-detail-b">';
    if (plugin.description) {
      html += '<p style="margin: 0; max-width: 720px">' + esc(plugin.description) + "</p>";
    }
    if (tools.length === 0) {
      html += '<div class="sb-detail-sec"><h3 class="sb-h3">Tools (0)</h3><div class="sb-state" style="padding: 20px; border: 1px dashed var(--border-strong); border-radius: 10px"><strong style="font-size: 14px">This plugin has no tools</strong><p style="font-size: 13px">Agents cannot call it, so it has no permissions.</p></div></div>';
    }
    if (Object.keys(schema).length > 0) {
      html += settingsSectionHtml(plugin);
    }
    if (tools.length > 0) {
      html += permissionsSectionHtml(plugin);
    }
    html += dangerZoneHtml(plugin) + "</div>";
    return html;
  }

  function renderDetail() {
    var plugin = findPlugin(state.selectedName);
    if (!plugin) {
      detailCard.innerHTML = "";
      return;
    }
    detailCard.innerHTML = detailHtml(plugin);
    updateSettingsDirty();
    applyPermissionMode();
  }

  function updateView() {
    var plugin = findPlugin(state.selectedName);
    // The tab bar is rendered after this script, so look it up lazily.
    var tabbar = document.querySelector(".sb-tabbar");
    var mobileInstall = document.querySelector("[data-mobile-install]");
    if (mobileQuery.matches) {
      var showDetail = state.mobileShowDetail && plugin !== null;
      listCard.hidden = showDetail;
      detailCard.hidden = !showDetail;
      if (mobileInstall) {
        mobileInstall.hidden = showDetail;
      }
      if (showDetail) {
        setMobileHeaderDetail(plugin.name);
      } else {
        resetMobileHeader();
      }
      if (tabbar) {
        tabbar.hidden = showDetail;
      }
    } else {
      listCard.hidden = false;
      detailCard.hidden = plugin === null;
      if (mobileInstall) {
        mobileInstall.hidden = false;
      }
      resetMobileHeader();
      if (tabbar) {
        tabbar.hidden = false;
      }
    }
  }

  function setMobileHeaderDetail(name) {
    if (!shellHeader) {
      return;
    }
    if (mobileHeading) {
      mobileHeading.textContent = name;
    }
    var logo = shellHeader.querySelector(".sb-logo");
    if (logo) {
      logo.hidden = true;
    }
    var pill = shellHeader.querySelector(".sb-pill");
    if (pill) {
      pill.hidden = true;
    }
    var back = shellHeader.querySelector("[data-back]");
    if (!back) {
      back = document.createElement("button");
      back.type = "button";
      back.className = "sb-btn sb-btn-ghost sb-btn-icon sb-btn-lg";
      back.setAttribute("data-back", "");
      back.setAttribute("aria-label", "Back to plugins");
      back.innerHTML = BACK;
      shellHeader.insertBefore(back, shellHeader.firstChild);
    }
  }

  function resetMobileHeader() {
    if (!shellHeader) {
      return;
    }
    if (mobileHeading) {
      mobileHeading.textContent = originalHeading;
    }
    var logo = shellHeader.querySelector(".sb-logo");
    if (logo) {
      logo.hidden = false;
    }
    var pill = shellHeader.querySelector(".sb-pill");
    if (pill) {
      pill.hidden = false;
    }
    var back = shellHeader.querySelector("[data-back]");
    if (back) {
      back.remove();
    }
  }

  function selectPlugin(name, focusItem) {
    state.selectedName = name;
    if (mobileQuery.matches) {
      state.mobileShowDetail = true;
    }
    renderList();
    renderDetail();
    updateView();
    if (focusItem) {
      var item = listBody.querySelector('[data-name="' + name + '"]');
      if (item) {
        item.focus();
      }
    }
  }

  function backToDetailList() {
    state.mobileShowDetail = false;
    renderList();
    updateView();
  }

  async function reloadPlugin(name) {
    var plugin = findPlugin(name);
    if (!plugin) {
      return null;
    }
    var results = await Promise.all([fetchDetail(name), fetchConfig(name)]);
    var detail = results[0];
    var config = results[1];
    if (detail.ok && detail.data && typeof detail.data === "object") {
      plugin.description = detail.data.description || plugin.description;
      plugin.editable = detail.data.editable !== undefined ? detail.data.editable : plugin.editable;
      plugin.permissions = detail.data.permissions || plugin.permissions;
      plugin.tools = detail.data.tools || [];
    }
    if (config.ok && config.data && typeof config.data === "object") {
      plugin.schema = config.data.schema || {};
      plugin.set = config.data.set || {};
    }
    return plugin;
  }

  async function loadAll() {
    if (listBody) {
      listBody.innerHTML = '<div class="sb-state"><span class="sb-spinner sb-spinner-lg" style="color: var(--muted)"></span><strong>Loading plugins...</strong></div>';
    }
    var listResult = await fetchJson(LIST_URL);
    if (!listResult.ok) {
      throw new Error(listResult.data && listResult.data.error ? listResult.data.error : "Could not load the plugin list.");
    }
    var list = listResult.data && Array.isArray(listResult.data.plugins) ? listResult.data.plugins : [];
    var loaded = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var results = await Promise.all([fetchDetail(item.name), fetchConfig(item.name)]);
      var detail = results[0].ok && results[0].data ? results[0].data : {};
      var config = results[1].ok && results[1].data ? results[1].data : {};
      loaded.push({
        name: item.name,
        description: detail.description || item.description || "",
        editable: detail.editable !== undefined ? detail.editable : item.editable,
        permissions: detail.permissions || item.permissions || ["*"],
        tools: detail.tools || [],
        schema: config.schema || {},
        set: config.set || {},
      });
    }
    state.plugins = loaded;
    if (findPlugin(state.selectedName) === null) {
      state.selectedName = loaded.length > 0 ? loaded[0].name : null;
      state.mobileShowDetail = false;
    }
  }

  function setInstallFeedback(text, kind) {
    var elements = document.querySelectorAll("[data-install-feedback]");
    for (var i = 0; i < elements.length; i++) {
      elements[i].className = "sb-feedback" + (kind === true ? " is-success" : kind === false ? " is-error" : "");
      if (kind === true) {
        elements[i].innerHTML = CHECK + esc(text);
      } else if (kind === false) {
        elements[i].innerHTML = ERROR + esc(text);
      } else {
        elements[i].innerHTML = text ? SPINNER + esc(text) : "";
      }
    }
  }

  function setInstallBusy(busy) {
    var buttons = document.querySelectorAll("[data-install-btn]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = busy;
      if (busy) {
        buttons[i].classList.add("is-loading");
        buttons[i].setAttribute("aria-busy", "true");
        buttons[i].innerHTML = SPINNER + "Installing...";
      } else {
        buttons[i].classList.remove("is-loading");
        buttons[i].setAttribute("aria-busy", "false");
        buttons[i].innerHTML = "Install";
      }
    }
  }

  function setDetailFeedback(text, kind) {
    var element = detailCard.querySelector("[data-detail-feedback]");
    if (!element) {
      return;
    }
    element.className = "sb-feedback" + (kind === true ? " is-success" : kind === false ? " is-error" : "");
    if (kind === true) {
      element.innerHTML = CHECK + esc(text);
    } else if (kind === false) {
      element.innerHTML = ERROR + esc(text);
    } else {
      element.innerHTML = text ? SPINNER + esc(text) : "";
    }
  }

  function setPermFeedback(text, kind) {
    var element = detailCard.querySelector("[data-perm-feedback]");
    if (!element) {
      return;
    }
    element.className = "sb-feedback" + (kind === true ? " is-success" : kind === false ? " is-error" : "");
    if (kind === true) {
      element.innerHTML = CHECK + esc(text);
    } else if (kind === false) {
      element.innerHTML = ERROR + esc(text);
    } else {
      element.innerHTML = text ? SPINNER + esc(text) : "";
    }
  }

  function setButtonBusy(buttons, label) {
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i]._originalHtml === undefined) {
        buttons[i]._originalHtml = buttons[i].innerHTML;
      }
      buttons[i].disabled = true;
      buttons[i].classList.add("is-loading");
      buttons[i].innerHTML = SPINNER + label;
    }
  }

  function restoreButtons(buttons) {
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = false;
      buttons[i].classList.remove("is-loading");
      if (buttons[i]._originalHtml !== undefined) {
        buttons[i].innerHTML = buttons[i]._originalHtml;
      }
    }
  }

  async function installPlugin(form) {
    var urlInput = form.querySelector("[data-install-url]");
    var url = urlInput ? urlInput.value.trim() : "";
    if (!url) {
      if (urlInput) {
        urlInput.focus();
      }
      return;
    }
    setInstallBusy(true);
    setInstallFeedback("", null);
    try {
      var result = await fetchJson(INSTALL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      });
      if (!result.ok) {
        setInstallBusy(false);
        setInstallFeedback(result.data && result.data.error ? result.data.error : "Installation failed.", false);
        return;
      }
      var inputs = document.querySelectorAll("[data-install-url]");
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = "";
      }
      await loadAll();
      var name = result.data && result.data.name ? result.data.name : null;
      if (name) {
        selectPlugin(name);
      } else {
        renderList();
        renderDetail();
        updateView();
      }
      var message = name ? 'Installed "' + name + '".' : "Installed.";
      var plugin = name ? findPlugin(name) : null;
      if (plugin) {
        var count = (plugin.tools || []).length;
        message += count === 0 ? " It has no tools." : " It has " + count + " tool" + (count === 1 ? "." : "s.");
      }
      setInstallFeedback(message, true);
    } catch (error) {
      setInstallFeedback("Could not reach the server.", false);
    } finally {
      setInstallBusy(false);
    }
  }

  async function updatePlugin() {
    var plugin = findPlugin(state.selectedName);
    if (!plugin || plugin.editable) {
      return;
    }
    setDetailFeedback("Updating...", null);
    var buttons = detailCard.querySelectorAll("[data-update]");
    setButtonBusy(buttons, "Updating...");
    try {
      var result = await fetchJson(UPDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: plugin.name }),
      });
      if (result.ok) {
        await reloadPlugin(plugin.name);
        renderList();
        renderDetail();
        updateView();
        setDetailFeedback("Updated", true);
      } else {
        setDetailFeedback(result.data && result.data.error ? result.data.error : "Update failed.", false);
      }
    } catch (error) {
      setDetailFeedback("Could not reach the server.", false);
    } finally {
      restoreButtons(buttons);
    }
  }

  function updateSettingsDirty() {
    var inputs = detailCard.querySelectorAll("[data-config-input]");
    var dirty = false;
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i]._edited === true) {
        dirty = true;
        break;
      }
    }
    var button = detailCard.querySelector("[data-save-settings]");
    if (button) {
      button.disabled = !dirty;
    }
  }

  function revealConfigInput(key) {
    var field = detailCard.querySelector('[data-field="' + key + '"]');
    if (!field) {
      return;
    }
    var secret = field.querySelector("[data-secret]");
    if (!secret) {
      return;
    }
    var input = document.createElement("input");
    input.type = "text";
    input.className = "sb-input sb-mono";
    input.setAttribute("data-config-input", key);
    input.placeholder = "New value";
    secret.parentNode.replaceChild(input, secret);
    input.focus();
    updateSettingsDirty();
  }

  async function saveSettings() {
    var plugin = findPlugin(state.selectedName);
    if (!plugin) {
      return;
    }
    var inputs = detailCard.querySelectorAll("[data-config-input]");
    var config = {};
    var hasEdited = false;
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i]._edited === true) {
        config[inputs[i].getAttribute("data-config-input")] = inputs[i].value;
        hasEdited = true;
      }
    }
    if (!hasEdited) {
      return;
    }
    setDetailFeedback("Saving...", null);
    try {
      var result = await fetchJson(CONFIGURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: plugin.name, config: config }),
      });
      if (result.ok) {
        for (var key in config) {
          if (Object.prototype.hasOwnProperty.call(config, key)) {
            plugin.set[key] = true;
          }
        }
        renderList();
        renderDetail();
        updateView();
        setDetailFeedback("Saved", true);
      } else {
        setDetailFeedback(result.data && result.data.error ? result.data.error : "Failed to save settings.", false);
      }
    } catch (error) {
      setDetailFeedback("Could not reach the server.", false);
    }
  }

  function applyPermissionMode() {
    var select = detailCard.querySelector("[data-perm-select]");
    if (!select) {
      return;
    }
    var mode = select.value;
    var checklist = detailCard.querySelector("[data-checklist]");
    var filterWrap = detailCard.querySelector("[data-filter-wrap]");
    var checkboxes = detailCard.querySelectorAll("[data-tool]");
    if (mode === "selected") {
      if (checklist) {
        checklist.classList.remove("is-readonly");
      }
      if (filterWrap) {
        filterWrap.hidden = false;
      }
    } else {
      if (checklist) {
        checklist.classList.add("is-readonly");
      }
      var checked = mode === "all";
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = checked;
      }
      if (filterWrap) {
        filterWrap.hidden = true;
      }
      var filter = detailCard.querySelector("[data-filter]");
      if (filter) {
        filter.value = "";
      }
      applyToolFilter();
    }
    updatePermCount();
  }

  function updatePermCount() {
    var checkboxes = detailCard.querySelectorAll("[data-tool]");
    var total = checkboxes.length;
    var count = 0;
    for (var i = 0; i < total; i++) {
      if (checkboxes[i].checked) {
        count++;
      }
    }
    var countElement = detailCard.querySelector("[data-count]");
    if (countElement) {
      countElement.textContent = count + " of " + total + " tools";
    }
    var selectAll = detailCard.querySelector("[data-select-all]");
    if (selectAll) {
      selectAll.checked = total > 0 && count === total;
      selectAll.indeterminate = count > 0 && count < total;
    }
  }

  function toggleSelectAll(checked) {
    var checkboxes = detailCard.querySelectorAll("[data-tool]");
    for (var i = 0; i < checkboxes.length; i++) {
      checkboxes[i].checked = checked;
    }
  }

  function applyToolFilter() {
    var filter = detailCard.querySelector("[data-filter]");
    var query = filter ? filter.value.trim().toLowerCase() : "";
    var rows = detailCard.querySelectorAll("[data-tool-row]");
    for (var i = 0; i < rows.length; i++) {
      var name = (rows[i].getAttribute("data-tool-row") || "").toLowerCase();
      rows[i].hidden = query !== "" && name.indexOf(query) === -1;
    }
    updatePermCount();
  }

  async function savePermissions() {
    var plugin = findPlugin(state.selectedName);
    if (!plugin) {
      return;
    }
    var select = detailCard.querySelector("[data-perm-select]");
    var mode = select ? select.value : "all";
    var permissions;
    if (mode === "all") {
      permissions = ["*"];
    } else if (mode === "none") {
      permissions = [];
    } else {
      permissions = [];
      var checkboxes = detailCard.querySelectorAll("[data-tool]");
      for (var i = 0; i < checkboxes.length; i++) {
        if (checkboxes[i].checked) {
          permissions.push(checkboxes[i].getAttribute("data-tool"));
        }
      }
    }
    setPermFeedback("Saving...", null);
    try {
      var result = await fetchJson(CONFIGURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: plugin.name, config: { permissions: permissions } }),
      });
      if (result.ok) {
        plugin.permissions = permissions;
        renderList();
        setPermFeedback("Saved", true);
      } else {
        setPermFeedback(result.data && result.data.error ? result.data.error : "Failed to save permissions.", false);
      }
    } catch (error) {
      setPermFeedback("Could not reach the server.", false);
    }
  }

  function openConfirm(name) {
    if (!name) {
      return;
    }
    state.confirmName = name;
    var titles = document.querySelectorAll("[data-confirm-title]");
    for (var i = 0; i < titles.length; i++) {
      titles[i].textContent = 'Delete plugin "' + name + '"?';
    }
    var popover = detailCard.querySelector("[data-confirm-pop]");
    if (popover) {
      popover.hidden = false;
    }
    confirmMobile.hidden = false;
    var feedbacks = document.querySelectorAll("[data-confirm-feedback]");
    for (var f = 0; f < feedbacks.length; f++) {
      feedbacks[f].className = "sb-feedback";
      feedbacks[f].textContent = "";
    }
    var cancel = mobileQuery.matches
      ? confirmMobile.querySelector("[data-confirm-cancel]")
      : popover
        ? popover.querySelector("[data-confirm-cancel]")
        : null;
    if (cancel) {
      cancel.focus();
    }
  }

  function closeConfirm() {
    state.confirmName = null;
    var popover = detailCard.querySelector("[data-confirm-pop]");
    if (popover) {
      popover.hidden = true;
    }
    if (confirmMobile) {
      confirmMobile.hidden = true;
    }
  }

  async function confirmDelete() {
    var name = state.confirmName;
    if (!name) {
      return;
    }
    var deleteButtons = document.querySelectorAll("[data-confirm-delete]");
    setButtonBusy(deleteButtons, "Removing...");
    var feedbacks = document.querySelectorAll("[data-confirm-feedback]");
    function setConfirmError(message) {
      for (var f = 0; f < feedbacks.length; f++) {
        feedbacks[f].className = "sb-feedback is-error";
        feedbacks[f].innerHTML = ERROR + esc(message);
      }
    }
    try {
      var result = await fetchJson(REMOVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name }),
      });
      if (result.ok) {
        closeConfirm();
        state.selectedName = null;
        await loadAll();
        renderList();
        renderDetail();
        updateView();
      } else {
        setConfirmError(result.data && result.data.error ? result.data.error : "Delete failed.");
      }
    } catch (error) {
      setConfirmError("Could not reach the server.");
    } finally {
      restoreButtons(deleteButtons);
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest("[data-confirm-delete]")) {
      confirmDelete();
      return;
    }
    if (target.closest("[data-confirm-cancel]")) {
      closeConfirm();
      return;
    }
    if (target.closest("[data-install-btn]")) {
      var form = target.closest("[data-install-form]");
      if (form) {
        installPlugin(form);
      }
      return;
    }
    if (target.closest("[data-retry]")) {
      init();
      return;
    }
    if (target.closest("[data-back]")) {
      backToDetailList();
      return;
    }
    if (target.closest("[data-replace]")) {
      revealConfigInput(target.closest("[data-replace]").getAttribute("data-replace"));
      return;
    }
    if (target.closest("[data-save-settings]")) {
      saveSettings();
      return;
    }
    if (target.closest("[data-save-permissions]")) {
      savePermissions();
      return;
    }
    if (target.closest("[data-update]")) {
      updatePlugin();
      return;
    }
    if (target.closest("[data-delete]")) {
      openConfirm(state.selectedName);
      return;
    }
    var listItem = target.closest("[data-name]");
    if (listItem) {
      selectPlugin(listItem.getAttribute("data-name"));
    }
  });

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!target || !target.matches) {
      return;
    }
    if (target.matches("[data-perm-select]")) {
      applyPermissionMode();
      return;
    }
    if (target.matches("[data-select-all]")) {
      toggleSelectAll(target.checked);
      updatePermCount();
      return;
    }
    if (target.matches("[data-tool]")) {
      updatePermCount();
    }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || !target.matches) {
      return;
    }
    if (target.matches("[data-filter]")) {
      applyToolFilter();
      return;
    }
    if (target.matches("[data-config-input]")) {
      target._edited = true;
      updateSettingsDirty();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.confirmName !== null) {
      closeConfirm();
      return;
    }
    if (event.key === "Enter" && event.target && event.target.matches && event.target.matches("[data-install-url]")) {
      event.preventDefault();
      var form = event.target.closest("[data-install-form]");
      if (form) {
        installPlugin(form);
      }
    }
  });

  listCard.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    if (state.plugins.length === 0) {
      return;
    }
    event.preventDefault();
    var index = -1;
    for (var i = 0; i < state.plugins.length; i++) {
      if (state.plugins[i].name === state.selectedName) {
        index = i;
      }
    }
    var next = event.key === "ArrowDown" ? index + 1 : index - 1;
    if (next < 0) {
      next = 0;
    }
    if (next >= state.plugins.length) {
      next = state.plugins.length - 1;
    }
    selectPlugin(state.plugins[next].name, true);
  });

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", function () {
      state.mobileShowDetail = false;
      renderList();
      updateView();
    });
  }

  async function init() {
    try {
      await loadAll();
      renderList();
      renderDetail();
      updateView();
    } catch (error) {
      if (listBody) {
        listBody.innerHTML = '<div class="sb-state is-error"><div class="sb-state-icon">' + ERROR + '</div><strong>Could not load plugins</strong><p>' + esc(error && error.message ? error.message : String(error)) + '</p><button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-retry>' + UPDATE + "Try again</button></div>";
      }
      detailCard.hidden = true;
    }
  }

  init();
})();
</script>`;
}

export function servePluginsPage(response: http.ServerResponse, config: Config): void {
  const html = renderPageShell({
    title: "Plugins",
    content: buildPluginsContent(),
    nav: { active: "plugins", model: config.model, uptime: getUptime() },
  });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}
