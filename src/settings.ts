import http from "http";
import type { Config } from "./config.js";
import { getAllowlist, saveAllowlist, getOwnerIdentities } from "./allowlist.js";
import type { Allowlist } from "./allowlist.js";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function handleGetAllowlistRequest(
  response: http.ServerResponse,
  config: Config,
): void {
  log.debug("[stavrobot] handleGetAllowlistRequest: returning allowlist and owner identities");
  const allowlist = getAllowlist();
  const ownerIdentities = getOwnerIdentities(config);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ allowlist, ownerIdentities }));
}

export async function handlePutAllowlistRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: Config,
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

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.signal) || !obj.signal.every((item) => typeof item === "string")) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'signal' must be an array of non-empty strings" }));
    return;
  }

  // Strip Unicode directional and formatting characters (e.g. U+2068/U+2069)
  // that messaging apps silently wrap around phone numbers when copying.
  const trimmedSignal = (obj.signal as string[]).map((item) => item.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "").trim());
  if (trimmedSignal.some((item) => item.length === 0)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'signal' must be an array of non-empty strings" }));
    return;
  }

  const e164Pattern = /^\+[1-9]\d{1,14}$/;
  const invalidSignal = trimmedSignal.find((item) => item !== "*" && !e164Pattern.test(item));
  if (invalidSignal !== undefined) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: `Invalid Signal number "${invalidSignal}": must be in E.164 format (e.g. +1234567890).`,
      }),
    );
    return;
  }

  if (
    !Array.isArray(obj.telegram) ||
    !obj.telegram.every((item) => item === "*" || (typeof item === "number" && Number.isInteger(item)))
  ) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'telegram' must be an array of integers" }));
    return;
  }

  if (!Array.isArray(obj.whatsapp) || !obj.whatsapp.every((item) => typeof item === "string")) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'whatsapp' must be an array of non-empty strings" }));
    return;
  }

  const trimmedWhatsapp = (obj.whatsapp as string[]).map((item) => item.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "").trim());
  if (trimmedWhatsapp.some((item) => item.length === 0)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'whatsapp' must be an array of non-empty strings" }));
    return;
  }

  const invalidWhatsapp = trimmedWhatsapp.find((item) => item !== "*" && !e164Pattern.test(item));
  if (invalidWhatsapp !== undefined) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: `Invalid WhatsApp number "${invalidWhatsapp}": must be in E.164 format (e.g. +1234567890).`,
      }),
    );
    return;
  }

  if (obj.notes !== undefined) {
    if (typeof obj.notes !== "object" || obj.notes === null || Array.isArray(obj.notes)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "'notes' must be a plain object" }));
      return;
    }
    const notesObj = obj.notes as Record<string, unknown>;
    if (!Object.values(notesObj).every((value) => typeof value === "string")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "'notes' values must be strings" }));
      return;
    }
  }

  const submittedNotes = (obj.notes ?? {}) as Record<string, string>;

  const submitted: Allowlist = {
    signal: [...new Set(trimmedSignal)],
    telegram: [...new Set(obj.telegram as (number | string)[])],
    whatsapp: [...new Set(trimmedWhatsapp)],
    notes: submittedNotes,
  };

  // Ensure owner identities are always present even if the UI omitted them.
  const ownerIdentities = getOwnerIdentities(config);
  for (const ownerSignal of ownerIdentities.signal) {
    if (!submitted.signal.includes(ownerSignal)) {
      submitted.signal.push(ownerSignal);
    }
  }
  for (const ownerTelegram of ownerIdentities.telegram) {
    if (!submitted.telegram.includes(ownerTelegram)) {
      submitted.telegram.push(ownerTelegram);
    }
  }
  for (const ownerWhatsapp of ownerIdentities.whatsapp) {
    if (!submitted.whatsapp.includes(ownerWhatsapp)) {
      submitted.whatsapp.push(ownerWhatsapp);
    }
  }

  // Prune notes whose keys don't correspond to any entry in any service list.
  // Telegram entries are numbers in the array but string keys in the notes map.
  const allEntryKeys = new Set<string>([
    ...submitted.signal,
    ...submitted.telegram.map((entry) => String(entry)),
    ...submitted.whatsapp,
  ]);
  const prunedNotes: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted.notes)) {
    if (allEntryKeys.has(key)) {
      prunedNotes[key] = value;
    }
  }
  submitted.notes = prunedNotes;

  saveAllowlist(submitted);
  log.debug("[stavrobot] handlePutAllowlistRequest: allowlist saved", submitted);

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ allowlist: submitted, ownerIdentities }));
}

const SETTINGS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Settings</title>
  <style>
    ${getBaseStyles()}
    body { padding: 24px; }
    .entry-list {
      list-style: none;
      margin-bottom: 12px;
    }
    .entry-list li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--color-border-light);
      font-size: 14px;
    }
    .entry-list li:last-child { border-bottom: none; }
    .entry-value { flex: 1; }
    .owner-label {
      font-size: 12px;
      color: var(--color-text-muted);
      font-style: italic;
    }
    .note-text {
      font-size: 13px;
      color: var(--color-text-muted);
    }
    .add-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .add-row input[type="text"] {
      flex: 1;
      min-width: 0;
      padding: 7px 10px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 14px;
      transition: all 0.15s ease;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .btn {
      padding: 7px 14px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      background: var(--color-surface);
      transition: all 0.15s ease;
      white-space: nowrap;
      color: var(--color-text);
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
      padding: 4px 10px;
      font-size: 12px;
    }
    .btn-danger:hover:not(:disabled) { background: var(--color-error-bg); }
    #status {
      font-size: 13px;
      margin-top: 8px;
      display: block;
    }
    #status.success { color: var(--color-success); }
    #status.error { color: var(--color-error); }
    #loading {
      color: var(--color-text-muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <h1>Settings</h1>

  <div id="loading">Loading...</div>

  <div id="content" style="display:none">
    <div class="section">
      <h2>Signal allowlist</h2>
      <ul class="entry-list" id="signal-list"></ul>
      <div class="add-row">
        <input type="text" id="signal-input" placeholder="+1234567890" />
        <input type="text" id="signal-note-input" placeholder="Note (optional)" />
        <button class="btn" onclick="addSignalEntry()">Add</button>
      </div>
    </div>

    <div class="section">
      <h2>Telegram allowlist</h2>
      <ul class="entry-list" id="telegram-list"></ul>
      <div class="add-row">
        <input type="text" id="telegram-input" placeholder="Chat ID (e.g. 123456789)" />
        <input type="text" id="telegram-note-input" placeholder="Note (optional)" />
        <button class="btn" onclick="addTelegramEntry()">Add</button>
      </div>
    </div>

    <div class="section">
      <h2>WhatsApp allowlist</h2>
      <ul class="entry-list" id="whatsapp-list"></ul>
      <div class="add-row">
        <input type="text" id="whatsapp-input" placeholder="+1234567890" />
        <input type="text" id="whatsapp-note-input" placeholder="Note (optional)" />
        <button class="btn" onclick="addWhatsappEntry()">Add</button>
      </div>
    </div>

    <span id="status"></span>
  </div>

  <script>
    let signalEntries = [];
    let telegramEntries = [];
    let whatsappEntries = [];
    let ownerSignal = [];
    let ownerTelegram = [];
    let ownerWhatsapp = [];
    let notes = {};

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = String(text);
      return div.innerHTML;
    }

    function renderSignalList() {
      const list = document.getElementById("signal-list");
      if (signalEntries.length === 0) {
        list.innerHTML = '<li style="color:var(--color-text-muted);font-size:13px;">No entries.</li>';
        return;
      }
      list.innerHTML = signalEntries.map((entry, index) => {
        const isOwner = ownerSignal.includes(entry);
        const note = notes[entry];
        return \`<li>
          <span class="entry-value">\${escapeHtml(entry)}</span>
          \${note ? \`<span class="note-text">\${escapeHtml(note)}</span>\` : ""}
          \${isOwner
            ? '<span class="owner-label">(owner)</span>'
            : \`<button class="btn btn-danger" onclick="removeSignalEntry(\${index})">Delete</button>\`
          }
        </li>\`;
      }).join("");
    }

    function renderTelegramList() {
      const list = document.getElementById("telegram-list");
      if (telegramEntries.length === 0) {
        list.innerHTML = '<li style="color:var(--color-text-muted);font-size:13px;">No entries.</li>';
        return;
      }
      list.innerHTML = telegramEntries.map((entry, index) => {
        const isOwner = ownerTelegram.includes(entry);
        const key = String(entry);
        const note = notes[key];
        return \`<li>
          <span class="entry-value">\${escapeHtml(String(entry))}</span>
          \${note ? \`<span class="note-text">\${escapeHtml(note)}</span>\` : ""}
          \${isOwner
            ? '<span class="owner-label">(owner)</span>'
            : \`<button class="btn btn-danger" onclick="removeTelegramEntry(\${index})">Delete</button>\`
          }
        </li>\`;
      }).join("");
    }

    function renderWhatsappList() {
      const list = document.getElementById("whatsapp-list");
      if (whatsappEntries.length === 0) {
        list.innerHTML = '<li style="color:var(--color-text-muted);font-size:13px;">No entries.</li>';
        return;
      }
      list.innerHTML = whatsappEntries.map((entry, index) => {
        const isOwner = ownerWhatsapp.includes(entry);
        const note = notes[entry];
        return \`<li>
          <span class="entry-value">\${escapeHtml(entry)}</span>
          \${note ? \`<span class="note-text">\${escapeHtml(note)}</span>\` : ""}
          \${isOwner
            ? '<span class="owner-label">(owner)</span>'
            : \`<button class="btn btn-danger" onclick="removeWhatsappEntry(\${index})">Delete</button>\`
          }
        </li>\`;
      }).join("");
    }

    function isIdentifierInAnyList(key) {
      return signalEntries.includes(key) ||
        telegramEntries.map(String).includes(key) ||
        whatsappEntries.includes(key);
    }

    function removeSignalEntry(index) {
      const entry = signalEntries[index];
      signalEntries.splice(index, 1);
      if (!isIdentifierInAnyList(entry)) {
        delete notes[entry];
      }
      renderSignalList();
      saveAllowlist();
    }

    function removeTelegramEntry(index) {
      const entry = telegramEntries[index];
      const key = String(entry);
      telegramEntries.splice(index, 1);
      if (!isIdentifierInAnyList(key)) {
        delete notes[key];
      }
      renderTelegramList();
      saveAllowlist();
    }

    function removeWhatsappEntry(index) {
      const entry = whatsappEntries[index];
      whatsappEntries.splice(index, 1);
      if (!isIdentifierInAnyList(entry)) {
        delete notes[entry];
      }
      renderWhatsappList();
      saveAllowlist();
    }

    function addSignalEntry() {
      const input = document.getElementById("signal-input");
      const noteInput = document.getElementById("signal-note-input");
      const value = input.value.replace(/[\\u200B-\\u200F\\u2028-\\u202F\\u2060-\\u206F\\uFEFF]/g, "").trim();
      if (!value) return;
      if (value !== "*" && !/^\\+[1-9]\\d{1,14}$/.test(value)) {
        setStatus("Invalid number: must be in E.164 format (e.g. +1234567890).", true);
        return;
      }
      if (signalEntries.includes(value)) {
        setStatus("That number is already in the list.", true);
        return;
      }
      const note = noteInput.value.trim();
      if (note) {
        notes[value] = note;
      }
      signalEntries.push(value);
      input.value = "";
      noteInput.value = "";
      renderSignalList();
      setStatus("", false);
      saveAllowlist();
    }

    function addTelegramEntry() {
      const input = document.getElementById("telegram-input");
      const noteInput = document.getElementById("telegram-note-input");
      const raw = input.value.trim();
      if (!raw) return;
      if (raw === "*") {
        if (telegramEntries.includes("*")) {
          setStatus("That chat ID is already in the list.", true);
          return;
        }
        const note = noteInput.value.trim();
        if (note) {
          notes["*"] = note;
        }
        telegramEntries.push("*");
        input.value = "";
        noteInput.value = "";
        renderTelegramList();
        setStatus("", false);
        saveAllowlist();
        return;
      }
      const value = parseInt(raw, 10);
      if (!Number.isInteger(value) || String(value) !== raw) {
        setStatus("Telegram chat ID must be an integer.", true);
        return;
      }
      if (telegramEntries.includes(value)) {
        setStatus("That chat ID is already in the list.", true);
        return;
      }
      const note = noteInput.value.trim();
      if (note) {
        notes[String(value)] = note;
      }
      telegramEntries.push(value);
      input.value = "";
      noteInput.value = "";
      renderTelegramList();
      setStatus("", false);
      saveAllowlist();
    }

    function addWhatsappEntry() {
      const input = document.getElementById("whatsapp-input");
      const noteInput = document.getElementById("whatsapp-note-input");
      const value = input.value.replace(/[\\u200B-\\u200F\\u2028-\\u202F\\u2060-\\u206F\\uFEFF]/g, "").trim();
      if (!value) return;
      if (value !== "*" && !/^\\+[1-9]\\d{1,14}$/.test(value)) {
        setStatus("Invalid number: must be in E.164 format (e.g. +1234567890).", true);
        return;
      }
      if (whatsappEntries.includes(value)) {
        setStatus("That number is already in the list.", true);
        return;
      }
      const note = noteInput.value.trim();
      if (note) {
        notes[value] = note;
      }
      whatsappEntries.push(value);
      input.value = "";
      noteInput.value = "";
      renderWhatsappList();
      setStatus("", false);
      saveAllowlist();
    }

    function setStatus(text, isError) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.className = text ? (isError ? "error" : "success") : "";
    }

    async function loadAllowlistData() {
      try {
        const response = await fetch("/api/settings/allowlist");
        if (!response.ok) {
          document.getElementById("loading").style.display = "none";
          document.getElementById("content").style.display = "";
          setStatus("Failed to load settings.", true);
          return;
        }
        const data = await response.json();
        signalEntries = data.allowlist.signal.slice();
        telegramEntries = data.allowlist.telegram.slice();
        whatsappEntries = data.allowlist.whatsapp.slice();
        notes = Object.assign({}, data.allowlist.notes);
        ownerSignal = data.ownerIdentities.signal.slice();
        ownerTelegram = data.ownerIdentities.telegram.slice();
        ownerWhatsapp = data.ownerIdentities.whatsapp.slice();

        document.getElementById("loading").style.display = "none";
        document.getElementById("content").style.display = "";

        renderSignalList();
        renderTelegramList();
        renderWhatsappList();
      } catch (error) {
        document.getElementById("loading").style.display = "none";
        document.getElementById("content").style.display = "";
        setStatus("Failed to load settings.", true);
      }
    }

    async function saveAllowlist() {
      try {
        const response = await fetch("/api/settings/allowlist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signal: signalEntries, telegram: telegramEntries, whatsapp: whatsappEntries, notes }),
        });
        const data = await response.json();
        if (response.ok) {
          signalEntries = data.allowlist.signal.slice();
          telegramEntries = data.allowlist.telegram.slice();
          whatsappEntries = data.allowlist.whatsapp.slice();
          notes = Object.assign({}, data.allowlist.notes);
          ownerSignal = data.ownerIdentities.signal.slice();
          ownerTelegram = data.ownerIdentities.telegram.slice();
          ownerWhatsapp = data.ownerIdentities.whatsapp.slice();
          renderSignalList();
          renderTelegramList();
          renderWhatsappList();
          setStatus("", false);
        } else {
          setStatus(data.error || "Failed to save.", true);
        }
      } catch (error) {
        setStatus("Failed to save.", true);
      }
    }

    document.getElementById("signal-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addSignalEntry();
    });
    document.getElementById("signal-note-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addSignalEntry();
    });

    document.getElementById("telegram-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTelegramEntry();
    });
    document.getElementById("telegram-note-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTelegramEntry();
    });

    document.getElementById("whatsapp-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addWhatsappEntry();
    });
    document.getElementById("whatsapp-note-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addWhatsappEntry();
    });

    loadAllowlistData();
  </script>
</body>
</html>`;

export function serveAllowlistPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(SETTINGS_PAGE_HTML);
}

const SETTINGS_HUB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Settings</title>
  <style>
    ${getBaseStyles()}
    body { padding: 24px; }
    .section a {
      display: block;
      font-size: 15px;
      color: var(--color-accent);
      text-decoration: none;
      padding: 4px 0;
    }
    .section a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>Settings</h1>
  <div class="section">
    <a href="/settings/allowlist">Manage allowlist</a>
    <a href="/settings/plugins">Manage plugins</a>
  </div>
</body>
</html>`;

export function serveSettingsHubPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(SETTINGS_HUB_HTML);
}
