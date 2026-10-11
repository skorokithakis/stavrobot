import http from "http";
import type { Config } from "./config.js";
import { getAllowlist, saveAllowlist, getOwnerIdentities, getRejectedSenders } from "./allowlist.js";
import type { Allowlist } from "./allowlist.js";
import { log } from "./log.js";
import { escapeHtml, renderPageShell } from "./shell.js";
import { getUptime } from "./uptime.js";

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
  log.debug("[stavrobot] handleGetAllowlistRequest: returning allowlist, owner identities, and rejected senders");
  const allowlist = getAllowlist();
  const ownerIdentities = getOwnerIdentities(config);
  const rejected = getRejectedSenders().map((entry) => ({
    service: entry.service,
    identifier: entry.identifier,
    label: entry.label,
    lastSeen: entry.lastSeen.toISOString(),
    count: entry.count,
  }));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ allowlist, ownerIdentities, rejected }));
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

  if (!Array.isArray(obj.email) || !obj.email.every((item) => typeof item === "string")) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'email' must be an array of strings" }));
    return;
  }

  const trimmedEmail = (obj.email as string[]).map((item) => item.trim().toLowerCase());
  if (trimmedEmail.some((item) => item.length === 0)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "'email' must be an array of non-empty strings" }));
    return;
  }

  // Simple format check: something@something.something. We intentionally avoid
  // strict RFC 5321 validation — the goal is only to catch obvious typos.
  const emailPattern = /^[^@]+@[^@]+\.[^@]+$/;
  const invalidEmail = trimmedEmail.find((item) => item !== "*" && !emailPattern.test(item));
  if (invalidEmail !== undefined) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: `Invalid email address "${invalidEmail}".`,
      }),
    );
    return;
  }

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

  // Signal identities may be a phone number (E.164), a UUID, or a group ID
  // (an opaque base64-ish string), so we only reject entries containing
  // whitespace. Empty strings are already rejected above.
  const invalidSignal = trimmedSignal.find((item) => item !== "*" && /\s/.test(item));
  if (invalidSignal !== undefined) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: `Invalid Signal entry "${invalidSignal}": must not contain whitespace.`,
      }),
    );
    return;
  }

  const e164Pattern = /^\+[1-9]\d{1,14}$/;

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
    email: [...new Set(trimmedEmail)],
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
  for (const ownerEmail of ownerIdentities.email) {
    if (!submitted.email.includes(ownerEmail)) {
      submitted.email.push(ownerEmail);
    }
  }

  // Prune notes whose keys don't correspond to any entry in any service list.
  // Telegram entries are numbers in the array but string keys in the notes map.
  const allEntryKeys = new Set<string>([
    ...submitted.signal,
    ...submitted.telegram.map((entry) => String(entry)),
    ...submitted.whatsapp,
    ...submitted.email,
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

const ALLOWLIST_PAGE_CONTENT = `<div class="sb-page-h">
    <div>
      <h1 class="sb-h1">Allowlist</h1>
      <p>Only these identities can message Stavrobot. Each change saves at once.</p>
    </div>
    <span class="sb-feedback" id="feedback-desktop" role="status" hidden></span>
  </div>

  <div id="allowlist-root" class="sb-stack">
    <div class="sb-mobile-only">
      <div class="sb-stack" style="gap:12px">
        <p class="sb-muted" style="margin:0;font-size:14px">Only these identities can message Stavrobot. Each change saves at once.</p>
        <div style="overflow-x:auto;margin:0 -16px;padding:0 16px">
          <div class="sb-seg allowlist-seg" role="group" aria-label="Filter by service"></div>
        </div>
        <div class="sb-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
          <input class="sb-input sb-input-lg" type="search" id="allowlist-search-mobile" aria-label="Search identifiers and notes" placeholder="Search">
        </div>
        <span class="sb-feedback" id="feedback-mobile" role="status" hidden></span>
        <button class="sb-btn sb-btn-primary sb-btn-lg sb-btn-block" type="button" data-requires-load disabled data-action="open-add"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add an entry</button>
      </div>
    </div>

    <div class="sb-split">
      <div class="sb-stack">
        <section class="sb-card sb-desktop-only" style="overflow:hidden">
          <div class="sb-card-h" style="flex-wrap:wrap">
            <div class="sb-seg allowlist-seg" role="group" aria-label="Filter by service"></div>
            <div class="sb-search" style="width:260px">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
              <input class="sb-input" type="search" id="allowlist-search-desktop" aria-label="Search identifiers and notes" placeholder="Search identifiers and notes">
            </div>
          </div>
          <div class="sb-table-wrap">
            <table class="sb-table">
              <thead><tr><th class="is-upper" style="width:120px">Service</th><th class="is-upper" style="width:320px">Identifier</th><th class="is-upper">Note</th><th style="width:60px"><span class="sb-sr">Actions</span></th></tr></thead>
              <tbody id="allowlist-tbody"></tbody>
            </table>
          </div>
          <div id="allowlist-empty-desktop"></div>
        </section>

        <section class="sb-card sb-mobile-only" style="overflow:hidden">
          <div id="allowlist-mobile-rows"></div>
          <div id="allowlist-empty-mobile"></div>
        </section>

        <section class="sb-card sb-desktop-only" style="overflow:hidden" id="rejected-card-desktop" hidden aria-labelledby="rej-desktop">
          <div class="sb-card-h">
            <div><h2 class="sb-h2" id="rej-desktop">Recently rejected</h2><div class="sb-small sb-muted">People who messaged the bot but are not on the allowlist. Hidden when empty.</div></div>
            <span class="sb-badge sb-badge-solid" id="rejected-count-desktop">0</span>
          </div>
          <div class="sb-table-wrap">
            <table class="sb-table">
              <thead><tr><th class="is-upper" style="width:120px">Service</th><th class="is-upper" style="width:260px">Identifier</th><th class="is-upper">Display name</th><th class="is-upper" style="width:100px;text-align:right">Messages</th><th class="is-upper" style="width:170px">Last seen</th><th style="width:140px"><span class="sb-sr">Actions</span></th></tr></thead>
              <tbody id="rejected-tbody"></tbody>
            </table>
          </div>
        </section>

        <section class="sb-card sb-mobile-only" style="overflow:hidden" id="rejected-card-mobile" hidden aria-labelledby="rej-mobile">
          <div class="sb-card-h" style="padding:12px 16px">
            <div><h2 class="sb-h2" id="rej-mobile">Recently rejected</h2><div class="sb-small sb-muted">Not on the allowlist</div></div>
            <span class="sb-badge sb-badge-solid" id="rejected-count-mobile">0</span>
          </div>
          <div id="rejected-mobile-rows"></div>
        </section>
      </div>

      <div class="sb-desktop-only">
        <div class="sb-stack">
          <section class="sb-card" id="add-card">
            <div class="sb-card-h"><h2 class="sb-h2">Add an entry</h2></div>
            <div class="sb-card-b" id="add-form-home">
              <form class="sb-stack" id="add-form" style="gap:16px" novalidate aria-label="Add an entry">
                <div class="sb-field">
                  <label for="add-service">Service</label>
                  <div class="sb-select-wrap sb-desktop-only">
                    <select id="add-service" class="sb-input" data-requires-load disabled>
                      <option value="signal">Signal</option>
                      <option value="email">Email</option>
                      <option value="telegram">Telegram</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                  </div>
                  <div class="sb-mobile-only">
                    <div class="sb-seg" id="add-service-seg" role="group" aria-label="Service" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">
                      <button type="button" class="is-active" data-requires-load disabled data-action="pick-service" data-service="signal" style="height:38px;justify-content:center">Signal</button>
                      <button type="button" data-requires-load disabled data-action="pick-service" data-service="email" style="height:38px;justify-content:center">Email</button>
                      <button type="button" data-requires-load disabled data-action="pick-service" data-service="telegram" style="height:38px;justify-content:center;padding:0 6px">Telegram</button>
                      <button type="button" data-requires-load disabled data-action="pick-service" data-service="whatsapp" style="height:38px;justify-content:center;padding:0 6px">WhatsApp</button>
                    </div>
                  </div>
                </div>
                <div class="sb-field">
                  <label for="add-ident" id="add-ident-label">Phone number</label>
                  <input id="add-ident" class="sb-input sb-mono" data-requires-load disabled placeholder="+44 7700 900000" autocomplete="off" spellcheck="false">
                  <span class="sb-hint" id="add-ident-hint">Phone number, UUID, or group ID, or * to allow anyone on Signal.</span>
                  <span class="sb-field-error" id="add-error" hidden><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg><span id="add-error-text"></span></span>
                </div>
                <div class="sb-field">
                  <label for="add-note">Note <span class="sb-opt">(optional)</span></label>
                  <input id="add-note" class="sb-input" data-requires-load disabled placeholder="For example: work phone" autocomplete="off">
                </div>
                <button class="sb-btn sb-btn-primary" type="submit" id="add-submit" data-requires-load disabled><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add to allowlist</button>
              </form>
            </div>
          </section>
          <div class="sb-callout is-info">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.5"></path></svg>
            <div><strong>Owner identities</strong>They come from Config and are always allowed, so they have no remove button.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="sb-scrim" id="add-scrim" hidden></div>
    <div class="sb-sheet" id="add-sheet" style="gap:16px" hidden role="dialog" aria-modal="true" aria-labelledby="add-sheet-title">
      <div class="sb-sheet-grip"></div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h2 class="sb-h2" id="add-sheet-title">Add an entry</h2>
        <button class="sb-btn sb-btn-ghost sb-btn-icon sb-btn-lg" type="button" data-action="close-add" aria-label="Close" style="margin-right:-8px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
      </div>
      <div id="add-sheet-body"></div>
      <span class="sb-hint" style="text-align:center">The sheet closes after a successful add, and the page shows "Added ...".</span>
    </div>
  </div>`;

const ALLOWLIST_PAGE_SCRIPT = `<script>
(function () {
  var ICON = {
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>',
    spinner: '<span class="sb-spinner"></span>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 0 1 1-1h9"></path></svg>',
    copied: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>Copied',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>',
    trashLg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>',
    lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Locked: the owner cannot be removed"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
    lockLg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Locked: the owner cannot be removed"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
    lockSm: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
    lockSmMobile: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
    plusSm: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    searchBig: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>',
    shieldBig: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"></path></svg>'
  };

  var SERVICE_ORDER = ["signal", "email", "telegram", "whatsapp"];
  var SERVICE_LABEL = { signal: "Signal", email: "Email", telegram: "Telegram", whatsapp: "WhatsApp" };

  var state = {
    signal: [],
    telegram: [],
    whatsapp: [],
    email: [],
    notes: {},
    owner: { signal: [], telegram: [], whatsapp: [], email: [] },
    rejected: [],
    filter: "all",
    search: "",
    lastAdd: null,
    loaded: false,
    saving: false,
    loadError: false
  };

  var editingService = "signal";
  var feedbackTimer = null;
  var tintTimer = null;

  var root = document.getElementById("allowlist-root");
  var tbody = document.getElementById("allowlist-tbody");
  var mobileRows = document.getElementById("allowlist-mobile-rows");
  var emptyDesktop = document.getElementById("allowlist-empty-desktop");
  var emptyMobile = document.getElementById("allowlist-empty-mobile");
  var rejectedTbody = document.getElementById("rejected-tbody");
  var rejectedMobileRows = document.getElementById("rejected-mobile-rows");
  var rejectedCardDesktop = document.getElementById("rejected-card-desktop");
  var rejectedCardMobile = document.getElementById("rejected-card-mobile");
  var rejectedCountDesktop = document.getElementById("rejected-count-desktop");
  var rejectedCountMobile = document.getElementById("rejected-count-mobile");
  var feedbackDesktop = document.getElementById("feedback-desktop");
  var feedbackMobile = document.getElementById("feedback-mobile");
  var searchDesktop = document.getElementById("allowlist-search-desktop");
  var searchMobile = document.getElementById("allowlist-search-mobile");
  var addForm = document.getElementById("add-form");
  var addFormHome = document.getElementById("add-form-home");
  var addSheetBody = document.getElementById("add-sheet-body");
  var addSheet = document.getElementById("add-sheet");
  var addScrim = document.getElementById("add-scrim");
  var addServiceSelect = document.getElementById("add-service");
  var addServiceSeg = document.getElementById("add-service-seg");
  var identInput = document.getElementById("add-ident");
  var identLabel = document.getElementById("add-ident-label");
  var identHint = document.getElementById("add-ident-hint");
  var noteInput = document.getElementById("add-note");
  var addError = document.getElementById("add-error");
  var addErrorText = document.getElementById("add-error-text");
  var addSubmit = document.getElementById("add-submit");

  function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function listFor(service) { return state[service]; }
  function keysFor(service) { return state[service].map(String); }
  function isOwnerValue(service, value) { return state.owner[service].map(String).indexOf(String(value)) !== -1; }
  function isDuplicate(service, value) { return keysFor(service).indexOf(String(value)) !== -1; }
  function isInAnyList(value) {
    var key = String(value);
    return state.signal.map(String).indexOf(key) !== -1 ||
      state.telegram.map(String).indexOf(key) !== -1 ||
      state.whatsapp.map(String).indexOf(key) !== -1 ||
      state.email.map(String).indexOf(key) !== -1;
  }
  function rowKey(service, value) { return service + "|" + String(value); }

  function stripFormatting(value) {
    return String(value).replace(/[\\u200B-\\u200F\\u2028-\\u202F\\u2060-\\u206F\\uFEFF]/g, "").trim();
  }
  function validateSignal(raw) {
    var value = stripFormatting(raw);
    if (!value) { return { error: "Enter a phone number, UUID, or group ID." }; }
    if (value !== "*" && /\\s/.test(value)) { return { error: "Must not contain spaces." }; }
    return { value: value };
  }
  function validateEmail(raw) {
    var value = String(raw).trim().toLowerCase();
    if (!value) { return { error: "Enter an email address." }; }
    if (value !== "*" && !/@[^@]+\\./.test(value)) { return { error: "Enter a full email address, like name@example.com." }; }
    return { value: value };
  }
  function validateTelegram(raw) {
    var value = String(raw).trim();
    if (!value) { return { error: "Enter a numeric user ID." }; }
    if (value === "*") { return { value: "*" }; }
    var number = Number(value);
    if (!Number.isInteger(number) || String(number) !== value) { return { error: "Enter a numeric user ID, or * to allow anyone on Telegram." }; }
    return { value: number };
  }
  function validateWhatsapp(raw) {
    var value = stripFormatting(raw);
    if (!value) { return { error: "Enter a phone number." }; }
    if (value !== "*" && !/^\\+[1-9]\\d{1,14}$/.test(value)) { return { error: "Use the international format (E.164), like +1234567890." }; }
    return { value: value };
  }

  var FIELD = {
    signal: { label: "Phone number", placeholder: "+44 7700 900000", hint: "Phone number, UUID, or group ID, or * to allow anyone on Signal.", validate: validateSignal },
    email: { label: "Email address", placeholder: "name@example.com", hint: "Or * to allow anyone on email.", validate: validateEmail },
    telegram: { label: "Numeric user ID", placeholder: "123456789", hint: "A numeric user ID, or * to allow anyone on Telegram.", validate: validateTelegram },
    whatsapp: { label: "Phone number", placeholder: "+1234567890", hint: "International format, or * to allow anyone on WhatsApp.", validate: validateWhatsapp }
  };

  function captureData() {
    return {
      signal: state.signal.slice(),
      telegram: state.telegram.slice(),
      whatsapp: state.whatsapp.slice(),
      email: state.email.slice(),
      notes: Object.assign({}, state.notes),
      owner: {
        signal: state.owner.signal.slice(),
        telegram: state.owner.telegram.slice(),
        whatsapp: state.owner.whatsapp.slice(),
        email: state.owner.email.slice()
      }
    };
  }
  function restoreData(snapshot) {
    state.signal = snapshot.signal;
    state.telegram = snapshot.telegram;
    state.whatsapp = snapshot.whatsapp;
    state.email = snapshot.email;
    state.notes = snapshot.notes;
    state.owner = snapshot.owner;
  }
  function applyServer(data) {
    var allowlist = data.allowlist;
    var owners = data.ownerIdentities;
    state.signal = allowlist.signal.slice();
    state.telegram = allowlist.telegram.slice();
    state.whatsapp = allowlist.whatsapp.slice();
    state.email = allowlist.email.slice();
    state.notes = Object.assign({}, allowlist.notes);
    state.owner = {
      signal: owners.signal.slice(),
      telegram: owners.telegram.slice(),
      whatsapp: owners.whatsapp.slice(),
      email: owners.email.slice()
    };
  }

  function buildRows() {
    var rows = [];
    var i;
    for (i = 0; i < SERVICE_ORDER.length; i++) {
      var wildService = SERVICE_ORDER[i];
      var wildValues = listFor(wildService);
      for (var w = 0; w < wildValues.length; w++) {
        if (String(wildValues[w]) === "*" && !isOwnerValue(wildService, wildValues[w])) {
          rows.push({ service: wildService, value: wildValues[w], owner: false, wildcard: true });
        }
      }
    }
    for (i = 0; i < SERVICE_ORDER.length; i++) {
      var ownerService = SERVICE_ORDER[i];
      var ownerValues = listFor(ownerService);
      for (var o = 0; o < ownerValues.length; o++) {
        if (isOwnerValue(ownerService, ownerValues[o])) {
          rows.push({ service: ownerService, value: ownerValues[o], owner: true, wildcard: false });
        }
      }
    }
    for (i = 0; i < SERVICE_ORDER.length; i++) {
      var service = SERVICE_ORDER[i];
      var values = listFor(service);
      for (var v = 0; v < values.length; v++) {
        if (String(values[v]) !== "*" && !isOwnerValue(service, values[v])) {
          rows.push({ service: service, value: values[v], owner: false, wildcard: false });
        }
      }
    }
    return rows;
  }

  function visibleRows() {
    var query = state.search.trim().toLowerCase();
    var rows = buildRows();
    var output = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (state.filter !== "all" && row.service !== state.filter) { continue; }
      if (query) {
        var note = state.notes[String(row.value)] || "";
        if (String(row.value).toLowerCase().indexOf(query) === -1 && note.toLowerCase().indexOf(query) === -1) { continue; }
      }
      output.push(row);
    }
    return output;
  }

  function computeCounts() {
    var rows = buildRows();
    var counts = { all: rows.length, signal: 0, email: 0, telegram: 0, whatsapp: 0 };
    for (var i = 0; i < rows.length; i++) {
      counts[rows[i].service] += 1;
    }
    return counts;
  }

  function segButton(key, label, count) {
    return '<button type="button" class="' + (state.filter === key ? "is-active" : "") + '" data-action="filter" data-filter="' + key + '">' + esc(label) + ' <span class="sb-seg-count">' + count + '</span></button>';
  }
  function renderSegs() {
    var counts = computeCounts();
    var html = segButton("all", "All", counts.all);
    for (var i = 0; i < SERVICE_ORDER.length; i++) {
      var service = SERVICE_ORDER[i];
      html += segButton(service, SERVICE_LABEL[service], counts[service]);
    }
    var segs = document.querySelectorAll(".allowlist-seg");
    for (var j = 0; j < segs.length; j++) {
      segs[j].innerHTML = html;
    }
  }

  function identifierCell(row) {
    if (row.owner) {
      return '<span style="display:inline-flex;align-items:center;gap:8px"><span class="sb-mono">' + esc(row.value) + '</span><span class="sb-badge">' + ICON.lockSm + 'owner</span></span>';
    }
    if (row.wildcard) {
      return '<span style="display:inline-flex;align-items:center;gap:8px"><span class="sb-badge sb-badge-accent" style="font-size:14px">*</span><strong style="font-weight:500">Anyone on ' + esc(SERVICE_LABEL[row.service].toLowerCase()) + '</strong></span>';
    }
    return '<span class="sb-mono">' + esc(row.value) + '</span>';
  }
  function noteCell(row) {
    if (row.owner) { return '<td class="sb-muted">Always allowed. Set in Config.</td>'; }
    if (row.wildcard) { return '<td class="sb-muted">Wildcard: any sender can message the bot</td>'; }
    var note = state.notes[String(row.value)];
    if (note) { return '<td>' + esc(note) + '</td>'; }
    return '<td class="sb-faint">No note</td>';
  }
  function actionCell(row) {
    if (row.owner) {
      return '<td class="is-action"><span class="sb-faint" title="The owner cannot be removed" style="display:inline-flex;width:32px;height:32px;align-items:center;justify-content:center">' + ICON.lock + '</span></td>';
    }
    var label = row.wildcard ? "the " + SERVICE_LABEL[row.service].toLowerCase() + " wildcard" : String(row.value);
    return '<td class="is-action"><button class="sb-btn sb-btn-icon sb-btn-sm sb-btn-icon-danger" type="button" data-requires-load data-action="remove" data-service="' + esc(row.service) + '" data-value="' + esc(String(row.value)) + '" aria-label="Remove ' + esc(label) + '">' + ICON.trash + '</button></td>';
  }
  function desktopRow(row) {
    return '<tr data-row-key="' + esc(rowKey(row.service, row.value)) + '"><td><span class="sb-badge">' + esc(row.service) + '</span></td><td>' + identifierCell(row) + '</td>' + noteCell(row) + actionCell(row) + '</tr>';
  }

  function mobileRow(row) {
    var key = ' data-row-key="' + esc(rowKey(row.service, row.value)) + '"';
    var badge = '<span class="sb-badge">' + esc(row.service) + '</span>';
    if (row.owner) {
      return '<div class="sb-row" style="padding:10px 4px 10px 16px;min-height:64px"' + key + '>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;gap:8px;align-items:center">' + badge + '<span class="sb-mono">' + esc(row.value) + '</span></div>' +
          '<div class="sb-small sb-muted" style="margin-top:2px;display:flex;gap:6px;align-items:center"><span class="sb-badge" style="height:20px">' + ICON.lockSmMobile + 'owner</span>Always allowed</div>' +
        '</div>' +
        '<span class="sb-faint" title="The owner cannot be removed" style="display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center">' + ICON.lockLg + '</span>' +
      '</div>';
    }
    var identifier;
    var sub;
    if (row.wildcard) {
      identifier = '<span class="sb-badge sb-badge-accent" style="font-size:14px">*</span><strong style="font-weight:500">Anyone on ' + esc(SERVICE_LABEL[row.service].toLowerCase()) + '</strong>';
      sub = '<div class="sb-small sb-muted" style="margin-top:2px">Wildcard: any sender can message the bot</div>';
    } else {
      var note = state.notes[String(row.value)];
      identifier = '<span class="sb-mono sb-trunc">' + esc(row.value) + '</span>';
      sub = note ? '<div class="sb-small sb-muted" style="margin-top:2px">' + esc(note) + '</div>' : '<div class="sb-small sb-faint" style="margin-top:2px">No note</div>';
    }
    var removeLabel = row.wildcard ? "the " + SERVICE_LABEL[row.service].toLowerCase() + " wildcard" : String(row.value);
    return '<div class="sb-row" style="padding:10px 4px 10px 16px;min-height:64px"' + key + '>' +
      '<div style="flex:1;min-width:0"><div style="display:flex;gap:8px;align-items:center">' + badge + identifier + '</div>' + sub + '</div>' +
      '<button class="sb-btn sb-btn-icon sb-btn-lg sb-btn-icon-danger" type="button" data-requires-load data-action="remove" data-service="' + esc(row.service) + '" data-value="' + esc(String(row.value)) + '" aria-label="Remove ' + esc(removeLabel) + '">' + ICON.trashLg + '</button>' +
    '</div>';
  }

  function stateBlock(kind, title, text, action) {
    var icon = kind === "search" ? ICON.searchBig : ICON.shieldBig;
    var style = kind === "list" ? ' style="border-top:1px solid var(--border)"' : "";
    var button = action ? '<button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-action="show-all">Show all services</button>' : "";
    return '<div class="sb-state"' + style + '><div class="sb-state-icon">' + icon + '</div><strong>' + esc(title) + '</strong><p>' + esc(text) + '</p>' + button + '</div>';
  }
  function renderEmpty(rows) {
    var html = "";
    if (!state.loaded) {
      if (state.loadError) {
        html = '<div class="sb-state is-error"><div class="sb-state-icon">' + ICON.warn + '</div><strong>Could not load the allowlist</strong><p>The server did not answer. Your entries are untouched.</p><button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-action="retry-load">Try again</button></div>';
      } else {
        html = '<div class="sb-state"><span class="sb-spinner sb-spinner-lg" style="color:var(--muted)"></span><strong>Loading allowlist...</strong></div>';
      }
      emptyDesktop.innerHTML = html;
      emptyMobile.innerHTML = html;
      return;
    }
    var query = state.search.trim();
    var hasNonOwner = false;
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].owner) { hasNonOwner = true; break; }
    }
    if (rows.length === 0) {
      if (state.filter !== "all") {
        var label = SERVICE_LABEL[state.filter];
        html = stateBlock("search", "No " + label + " entries", "Nobody on " + label + " can message the bot.", true);
      } else if (query) {
        html = stateBlock("search", "No matching entries", "Try a different search.");
      } else {
        html = stateBlock("list", "Only you can message the bot", "Add a phone number, a username or an email address to let someone else in.");
      }
    } else if (state.filter === "all" && !query && !hasNonOwner) {
      html = stateBlock("list", "Only you can message the bot", "Add a phone number, a username or an email address to let someone else in.");
    }
    emptyDesktop.innerHTML = html;
    emptyMobile.innerHTML = html;
  }

  function normalizeRejected(entry) {
    if (entry.service === "telegram") {
      var value = parseInt(entry.identifier, 10);
      if (!Number.isInteger(value) || String(value) !== entry.identifier) { return null; }
      return value;
    }
    if (entry.service === "email") { return entry.identifier.trim().toLowerCase(); }
    return stripFormatting(entry.identifier);
  }
  function rejectedPresent(entry) {
    var value = normalizeRejected(entry);
    if (value === null) { return false; }
    return keysFor(entry.service).indexOf(String(value)) !== -1;
  }
  function visibleRejected() {
    var output = [];
    for (var i = 0; i < state.rejected.length; i++) {
      if (!rejectedPresent(state.rejected[i])) {
        output.push({ entry: state.rejected[i], index: i });
      }
    }
    return output;
  }
  function pad2(value) { return value < 10 ? "0" + value : String(value); }
  function formatDateParts(iso) {
    var date = new Date(iso);
    return {
      date: date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()),
      time: pad2(date.getHours()) + ":" + pad2(date.getMinutes())
    };
  }
  function formatRelative(iso) {
    var date = new Date(iso);
    var now = new Date();
    var time = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (date.getTime() >= startOfToday.getTime()) { return "today " + time; }
    if (date.getTime() >= startOfToday.getTime() - 86400000) { return "yesterday " + time; }
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return date.getDate() + " " + months[date.getMonth()] + " " + time;
  }
  function countText(count) { return count + (count === 1 ? " message" : " messages"); }
  function copyButton(value) {
    return '<button class="sb-copy" type="button" data-action="copy" data-value="' + esc(value) + '" aria-label="Copy ' + esc(value) + '">' + ICON.copy + '</button>';
  }

  function rejectedDesktopRow(item) {
    var entry = item.entry;
    var name = entry.label ? esc(entry.label) : '<span class="sb-faint">Not given</span>';
    var parts = formatDateParts(entry.lastSeen);
    return '<tr>' +
      '<td><span class="sb-badge">' + esc(entry.service) + '</span></td>' +
      '<td><span style="display:inline-flex;align-items:center;gap:2px"><span class="sb-mono">' + esc(entry.identifier) + '</span>' + copyButton(entry.identifier) + '</span></td>' +
      '<td>' + name + '</td>' +
      '<td class="sb-cell-num">' + entry.count + '</td>' +
      '<td class="sb-cell-date">' + parts.date + ' <span>' + parts.time + '</span></td>' +
      '<td class="is-action" style="width:140px"><button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-requires-load data-action="add-rejected" data-index="' + item.index + '">' + ICON.plusSm + 'Add</button></td>' +
    '</tr>';
  }
  function rejectedMobileRow(item) {
    var entry = item.entry;
    var name = entry.label ? '<div class="sb-small">' + esc(entry.label) + '</div>' : '<div class="sb-small sb-faint">No display name</div>';
    var seen = '<div class="sb-small sb-muted">' + countText(entry.count) + ' · last seen ' + esc(formatRelative(entry.lastSeen)) + '</div>';
    return '<div class="sb-row" style="padding:12px 16px;align-items:flex-start">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;gap:6px;align-items:center"><span class="sb-badge">' + esc(entry.service) + '</span><span class="sb-mono sb-trunc">' + esc(entry.identifier) + '</span>' + copyButton(entry.identifier) + '</div>' +
        name + seen +
      '</div>' +
      '<button class="sb-btn sb-btn-secondary sb-btn-lg" type="button" data-requires-load data-action="add-rejected" data-index="' + item.index + '" style="padding:0 14px">Add</button>' +
    '</div>';
  }

  function renderRejected() {
    var rows = visibleRejected();
    var count = rows.length;
    rejectedCardDesktop.hidden = count === 0;
    rejectedCardMobile.hidden = count === 0;
    rejectedCountDesktop.textContent = String(count);
    rejectedCountMobile.textContent = String(count);
    var desktopHtml = "";
    var mobileHtml = "";
    for (var i = 0; i < rows.length; i++) {
      desktopHtml += rejectedDesktopRow(rows[i]);
      mobileHtml += rejectedMobileRow(rows[i]);
    }
    rejectedTbody.innerHTML = desktopHtml;
    rejectedMobileRows.innerHTML = mobileHtml;
  }

  function applyTint() {
    if (!state.lastAdd) { return; }
    var key = rowKey(state.lastAdd.service, state.lastAdd.value);
    var elements = document.querySelectorAll("[data-row-key]");
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].getAttribute("data-row-key") === key) {
        elements[i].classList.add("is-selected");
      }
    }
  }
  function startTint(service, value) {
    state.lastAdd = { service: service, value: String(value) };
    applyTint();
    if (tintTimer) { clearTimeout(tintTimer); }
    tintTimer = setTimeout(function () {
      state.lastAdd = null;
      var selected = document.querySelectorAll("[data-row-key].is-selected");
      for (var i = 0; i < selected.length; i++) {
        selected[i].classList.remove("is-selected");
      }
    }, 4000);
  }

  function renderAllowlist() {
    var rows = visibleRows();
    var tableHtml = "";
    var listHtml = "";
    for (var i = 0; i < rows.length; i++) {
      tableHtml += desktopRow(rows[i]);
      listHtml += mobileRow(rows[i]);
    }
    tbody.innerHTML = tableHtml;
    mobileRows.innerHTML = listHtml;
    renderEmpty(rows);
    renderSegs();
    renderRejected();
    applyTint();
    updateMutationControls();
  }

  // Mutations stay disabled until the initial load succeeds and while a save is
  // in flight, so a stale response can never roll back a later change.
  function updateMutationControls() {
    var controls = root.querySelectorAll("[data-requires-load]");
    var enabled = state.loaded && !state.saving;
    for (var i = 0; i < controls.length; i++) {
      controls[i].disabled = !enabled;
    }
  }

  function showFeedback(kind, text, autoHide) {
    var className = "sb-feedback" + (kind === "success" ? " is-success" : kind === "error" ? " is-error" : "");
    var icon = kind === "busy" ? ICON.spinner : kind === "success" ? ICON.check : ICON.warn;
    var targets = [feedbackDesktop, feedbackMobile];
    for (var i = 0; i < targets.length; i++) {
      var element = targets[i];
      element.className = className;
      element.setAttribute("role", kind === "error" ? "alert" : "status");
      if (text) {
        element.innerHTML = icon + esc(text);
        element.hidden = false;
      } else {
        element.innerHTML = "";
        element.hidden = true;
      }
    }
    if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null; }
    if (autoHide && text) {
      feedbackTimer = setTimeout(function () { showFeedback("", "", false); }, 4000);
    }
  }
  function serverError(result, fallback) {
    if (result && result.data && typeof result.data.error === "string" && result.data.error) { return result.data.error; }
    return fallback;
  }
  function persist() {
    return fetch("/api/settings/allowlist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signal: state.signal,
        telegram: state.telegram,
        whatsapp: state.whatsapp,
        email: state.email,
        notes: state.notes
      })
    }).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, data: data };
      }, function () {
        return { ok: response.ok, data: {} };
      });
    });
  }

  function addEntry(service, value, note, fromForm) {
    if (!state.loaded || state.saving) { return; }
    var snapshot = captureData();
    var label = SERVICE_LABEL[service];
    var display = String(value);
    state.saving = true;
    showFeedback("busy", "Adding " + display + " to " + label + "...");
    listFor(service).push(value);
    if (note) { state.notes[display] = note; }
    renderAllowlist();
    persist().then(function (result) {
      if (!result.ok) {
        restoreData(snapshot);
        renderAllowlist();
        showFeedback("error", serverError(result, "Could not save."));
        return;
      }
      applyServer(result.data);
      renderAllowlist();
      startTint(service, value);
      showFeedback("success", "Added " + display + " to " + label, true);
      if (fromForm) {
        identInput.value = "";
        noteInput.value = "";
        clearFieldError();
        if (!addSheet.hidden) { closeAddSheet(); }
        identInput.focus();
      }
    }).catch(function () {
      restoreData(snapshot);
      renderAllowlist();
      showFeedback("error", "Could not save: the server did not answer. Try again.");
    }).finally(function () {
      state.saving = false;
      updateMutationControls();
    });
  }

  function removeEntry(service, value) {
    if (!state.loaded || state.saving) { return; }
    var snapshot = captureData();
    var display = String(value);
    state.saving = true;
    showFeedback("busy", "Removing " + display + "...");
    var list = listFor(service);
    var index = list.map(String).indexOf(display);
    if (index === -1) { state.saving = false; return; }
    list.splice(index, 1);
    if (!isInAnyList(display)) { delete state.notes[display]; }
    renderAllowlist();
    persist().then(function (result) {
      if (!result.ok) {
        restoreData(snapshot);
        renderAllowlist();
        showFeedback("error", serverError(result, "Could not save."));
        return;
      }
      applyServer(result.data);
      renderAllowlist();
      showFeedback("success", "Removed " + display, true);
    }).catch(function () {
      restoreData(snapshot);
      renderAllowlist();
      showFeedback("error", "Could not save: the server did not answer. Try again.");
    }).finally(function () {
      state.saving = false;
      updateMutationControls();
    });
  }

  function addRejected(index, button) {
    if (!state.loaded || state.saving) { return; }
    var entry = state.rejected[index];
    if (!entry) { return; }
    var value = normalizeRejected(entry);
    if (value === null) {
      showFeedback("error", "Cannot add " + entry.identifier + ": a numeric user ID must be a whole number.");
      return;
    }
    if (isDuplicate(entry.service, value)) {
      showFeedback("error", "Already on the allowlist.");
      return;
    }
    var snapshot = captureData();
    var label = SERVICE_LABEL[entry.service];
    var display = String(value);
    state.saving = true;
    updateMutationControls();
    if (button) {
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<span class="sb-spinner"></span>Adding';
    }
    listFor(entry.service).push(value);
    if (entry.label) { state.notes[display] = entry.label; }
    showFeedback("busy", "Adding " + display + " to " + label + "...");
    persist().then(function (result) {
      if (!result.ok) {
        restoreData(snapshot);
        renderAllowlist();
        showFeedback("error", serverError(result, "Could not save."));
        return;
      }
      applyServer(result.data);
      renderAllowlist();
      startTint(entry.service, value);
      showFeedback("success", "Added " + display + " to " + label, true);
    }).catch(function () {
      restoreData(snapshot);
      renderAllowlist();
      showFeedback("error", "Could not save: the server did not answer. Try again.");
    }).finally(function () {
      state.saving = false;
      updateMutationControls();
    });
  }

  function copyIdentifier(value, button) {
    if (!navigator.clipboard) {
      showFeedback("error", "Clipboard is not available.");
      return;
    }
    navigator.clipboard.writeText(value).then(function () {
      button.classList.add("is-copied");
      button.setAttribute("aria-label", "Copied");
      button.innerHTML = ICON.copied;
      setTimeout(function () {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", "Copy " + value);
        button.innerHTML = ICON.copy;
      }, 1200);
    }).catch(function () {
      showFeedback("error", "Could not copy to clipboard.");
    });
  }

  function showFieldError(message) {
    addError.hidden = false;
    addErrorText.textContent = message;
    identInput.classList.add("is-invalid");
    identInput.setAttribute("aria-invalid", "true");
    identInput.setAttribute("aria-describedby", "add-error");
  }
  function clearFieldError() {
    addError.hidden = true;
    addErrorText.textContent = "";
    identInput.classList.remove("is-invalid");
    identInput.removeAttribute("aria-invalid");
    identInput.setAttribute("aria-describedby", "add-ident-hint");
  }
  function updateServicePicker() {
    addServiceSelect.value = editingService;
    var buttons = addServiceSeg.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute("data-service") === editingService) {
        buttons[i].classList.add("is-active");
      } else {
        buttons[i].classList.remove("is-active");
      }
    }
  }
  function setService(service) {
    if (!FIELD[service]) { return; }
    editingService = service;
    identLabel.textContent = FIELD[service].label;
    identInput.placeholder = FIELD[service].placeholder;
    identHint.textContent = FIELD[service].hint;
    clearFieldError();
    updateServicePicker();
  }

  function openAddSheet() {
    addSheetBody.appendChild(addForm);
    addSubmit.classList.add("sb-btn-lg", "sb-btn-block");
    addSheet.hidden = false;
    addScrim.hidden = false;
    updateServicePicker();
    identInput.focus();
  }
  function closeAddSheet() {
    addFormHome.appendChild(addForm);
    addSubmit.classList.remove("sb-btn-lg", "sb-btn-block");
    addSheet.hidden = true;
    addScrim.hidden = true;
  }

  function handleAddSubmit(event) {
    event.preventDefault();
    var result = FIELD[editingService].validate(identInput.value);
    if (result.error) {
      showFieldError(result.error);
      identInput.focus();
      return;
    }
    if (isDuplicate(editingService, result.value)) {
      showFieldError("Already on the allowlist.");
      return;
    }
    clearFieldError();
    addEntry(editingService, result.value, noteInput.value.trim(), true);
  }

  function handleAction(event) {
    var target = event.target.closest("[data-action]");
    if (!target) { return; }
    var action = target.getAttribute("data-action");
    if (action === "filter") {
      state.filter = target.getAttribute("data-filter");
      renderAllowlist();
      return;
    }
    if (action === "show-all") {
      state.filter = "all";
      renderAllowlist();
      return;
    }
    if (action === "remove") {
      removeEntry(target.getAttribute("data-service"), target.getAttribute("data-value"));
      return;
    }
    if (action === "copy") {
      copyIdentifier(target.getAttribute("data-value"), target);
      return;
    }
    if (action === "add-rejected") {
      addRejected(parseInt(target.getAttribute("data-index"), 10), target);
      return;
    }
    if (action === "pick-service") {
      setService(target.getAttribute("data-service"));
      return;
    }
    if (action === "open-add") {
      openAddSheet();
      return;
    }
    if (action === "close-add") {
      closeAddSheet();
      return;
    }
    if (action === "retry-load") {
      loadAllowlist();
      return;
    }
  }

  function handleSearch(event) {
    state.search = event.target.value;
    searchDesktop.value = state.search;
    searchMobile.value = state.search;
    renderAllowlist();
  }

  root.addEventListener("click", handleAction);
  searchDesktop.addEventListener("input", handleSearch);
  searchMobile.addEventListener("input", handleSearch);
  addForm.addEventListener("submit", handleAddSubmit);
  addServiceSelect.addEventListener("change", function () { setService(addServiceSelect.value); });
  addScrim.addEventListener("click", closeAddSheet);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !addSheet.hidden) { closeAddSheet(); }
  });
  identInput.addEventListener("blur", function () {
    if (String(identInput.value).trim() === "") { return; }
    var result = FIELD[editingService].validate(identInput.value);
    if (result.error) { showFieldError(result.error); }
  });
  identInput.addEventListener("input", function () {
    var result = FIELD[editingService].validate(identInput.value);
    if (!result.error) { clearFieldError(); }
  });

  function loadAllowlist() {
    state.loaded = false;
    state.loadError = false;
    renderAllowlist();
    fetch("/api/settings/allowlist").then(function (response) {
      if (!response.ok) { throw new Error("Could not load the allowlist."); }
      return response.json();
    }).then(function (data) {
      applyServer(data);
      state.rejected = (data.rejected || []).slice();
      state.loaded = true;
      state.loadError = false;
      renderAllowlist();
    }).catch(function () {
      state.loaded = false;
      state.loadError = true;
      renderAllowlist();
    });
  }

  setService("signal");
  loadAllowlist();
})();
</script>`;

export function serveAllowlistPage(response: http.ServerResponse, config: Config): void {
  const html = renderPageShell({
    title: "Allowlist",
    content: ALLOWLIST_PAGE_CONTENT + ALLOWLIST_PAGE_SCRIPT,
    nav: { active: "allowlist", model: config.model, uptime: getUptime() },
  });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

const CONFIG_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--muted)"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"></path><circle cx="15" cy="6" r="2"></circle><circle cx="9" cy="12" r="2"></circle><circle cx="17" cy="18" r="2"></circle></svg>';

const LOGIN_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--muted)"><circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9M16 7l3 3M14 9l2 2"></path></svg>';

const CAPTCHA_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--muted)"><path d="M4 5h16v11H9l-5 4z"></path><path d="m9 10 2 2 4-4"></path></svg>';

const CHEVRON_ICON =
  '<svg class="sb-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';

function renderSettingsLink(href: string, icon: string, title: string, hint: string): string {
  return `<a class="sb-list-item" href="${href}" style="min-height:60px">${icon}<span class="sb-list-item-main"><span>${escapeHtml(title)}</span><span class="sb-list-item-sub">${escapeHtml(hint)}</span></span>${CHEVRON_ICON}</a>`;
}

export function serveSettingsHubPage(response: http.ServerResponse, config: Config): void {
  const uptime = getUptime();
  const content = `<div class="sb-page-h"><h1 class="sb-h1">Settings</h1></div>
<div class="sb-stack" style="gap:20px">
  <section class="sb-stack" style="gap:8px" aria-labelledby="settings-bot">
    <span class="sb-label" id="settings-bot" style="padding-left:4px">Bot</span>
    <div class="sb-card" style="overflow:hidden">
      ${renderSettingsLink("/settings/config", CONFIG_ICON, "Config", "Edit config.toml. Saving restarts the bot.")}
    </div>
  </section>
  <section class="sb-stack" style="gap:8px" aria-labelledby="settings-connections">
    <span class="sb-label" id="settings-connections" style="padding-left:4px">Connections</span>
    <div class="sb-card" style="overflow:hidden">
      ${renderSettingsLink("/login", LOGIN_ICON, "Provider login", "Sign in to your model provider.")}
      ${renderSettingsLink("/signal/captcha", CAPTCHA_ICON, "Signal captcha", "Use when Signal asks for a captcha")}
    </div>
  </section>
  <section class="sb-stack" style="gap:8px" aria-labelledby="settings-about">
    <span class="sb-label" id="settings-about" style="padding-left:4px">About</span>
    <div class="sb-card" style="padding:2px 16px">
      <div class="sb-kv"><span>Provider</span><span class="sb-mono">${escapeHtml(config.provider)}</span></div>
      <div class="sb-kv"><span>Model</span><span class="sb-mono">${escapeHtml(config.model)}</span></div>
      <div class="sb-kv"><span>Uptime</span><span>${escapeHtml(uptime)}</span></div>
    </div>
  </section>
</div>`;
  const html = renderPageShell({
    title: "Settings",
    content,
    nav: { active: "settings", model: config.model, uptime },
  });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}
