import http from "http";
import type pg from "pg";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { escapeHtml, renderPageShell } from "./shell.js";
import { getUptime } from "./uptime.js";

interface MessageStats {
  total: string;
  web: string;
  owner: string;
  others: string;
  agents: string;
}

type ServiceStatus = "enabled" | "disabled" | "inbound" | "outbound";

function getEmailStatus(config: Config): ServiceStatus {
  if (config.email === undefined) return "disabled";
  const hasInbound = config.email.webhookSecret !== undefined;
  const hasOutbound = config.email.smtpHost !== undefined;
  if (hasInbound && hasOutbound) return "enabled";
  if (hasInbound) return "inbound";
  if (hasOutbound) return "outbound";
  return "disabled";
}

function renderServiceStatus(status: ServiceStatus): string {
  switch (status) {
    case "enabled":
      return '<span class="sb-status is-on"><span class="sb-dot sb-dot-on"></span>Enabled</span>';
    case "disabled":
      return '<span class="sb-status is-off"><span class="sb-dot"></span>Disabled</span>';
    case "inbound":
      return '<span class="sb-status is-warn"><span class="sb-dot sb-dot-half"></span>Inbound only</span>';
    case "outbound":
      return '<span class="sb-status is-warn"><span class="sb-dot sb-dot-half" style="transform: scaleX(-1)"></span>Outbound only</span>';
  }
}

function formatCount(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderBotInfoCard(config: Config, uptime: string): string {
  return `<section class="sb-card">
    <div class="sb-card-h"><h2 class="sb-h2">Bot info</h2></div>
    <div class="sb-card-b" style="padding-top: 4px; padding-bottom: 4px">
      <div class="sb-kv"><span>Provider</span><span class="sb-mono">${escapeHtml(config.provider)}</span></div>
      <div class="sb-kv"><span>Model</span><span class="sb-mono">${escapeHtml(config.model)}</span></div>
      <div class="sb-kv"><span>Uptime</span><span>${escapeHtml(uptime)}</span></div>
    </div>
  </section>`;
}

function renderServicesCard(config: Config): string {
  const services: Array<{ name: string; status: ServiceStatus }> = [
    { name: "Signal", status: config.signal !== undefined ? "enabled" : "disabled" },
    { name: "Telegram", status: config.telegram !== undefined ? "enabled" : "disabled" },
    { name: "WhatsApp", status: config.whatsapp !== undefined ? "enabled" : "disabled" },
    { name: "Email", status: getEmailStatus(config) },
    { name: "Coder", status: config.coder !== undefined ? "enabled" : "disabled" },
    { name: "Embeddings", status: config.embeddings !== undefined ? "enabled" : "disabled" },
  ];

  const rows = services
    .map(
      (service) =>
        `\n    <div class="sb-row"><span style="flex: 1">${service.name}</span>${renderServiceStatus(service.status)}</div>`,
    )
    .join("");

  return `<section class="sb-card">
    <div class="sb-card-h"><h2 class="sb-h2">Services</h2><a href="/settings/config" class="sb-small">Change in Config</a></div>${rows}
  </section>`;
}

function renderStatisticsCard(stats: MessageStats): string {
  const rows: Array<{ label: string; value: string; total?: boolean }> = [
    { label: "From the web chat and internal", value: stats.web },
    { label: "From the owner", value: stats.owner },
    { label: "From other people", value: stats.others },
    { label: "From agents", value: stats.agents },
    { label: "Total", value: stats.total, total: true },
  ];

  const rowsHtml = rows
    .map((row) => {
      const label = row.total
        ? `<span style="color: var(--text)">${row.label}</span>`
        : `<span>${row.label}</span>`;
      const attributes = row.total ? ' style="font-weight: 600"' : "";
      return `\n      <div class="sb-kv"${attributes}>${label}<span class="sb-mono sb-num">${formatCount(row.value)}</span></div>`;
    })
    .join("");

  return `<section class="sb-card">
    <div class="sb-card-h"><h2 class="sb-h2">Message statistics</h2><span class="sb-small sb-muted">All time</span></div>
    <div class="sb-card-b" style="padding-top: 4px; padding-bottom: 4px">${rowsHtml}
    </div>
  </section>`;
}

function renderChatCard(): string {
  return `<section class="sb-card sb-chat" aria-label="Chat with Stavrobot">
    <div class="sb-card-h"><h2 class="sb-h2">Chat</h2><span class="sb-small sb-muted">Talks to the main agent</span></div>
    <div class="sb-chat-log" id="chat-log" role="log" aria-live="polite">
      <div class="sb-state" id="chat-empty" style="margin: auto">
        <div class="sb-state-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5z"></path></svg></div>
        <strong>No messages yet</strong>
        <p>Send a message to talk to the main agent.</p>
      </div>
    </div>
    <div class="sb-composer">
      <label for="chat-input" class="sb-sr">Message</label>
      <textarea id="chat-input" class="sb-input" placeholder="Message Stavrobot" rows="1"></textarea>
      <button id="chat-send" class="sb-btn sb-btn-primary sb-btn-icon sb-btn-lg" type="button" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12 20 4l-6 16-3-7z"></path></svg></button>
    </div>
    <div class="sb-composer-hint">Enter to send, Shift+Enter for a new line</div>
  </section>`;
}

function renderChatScript(): string {
  return `<script>
    (function () {
      var log = document.getElementById("chat-log");
      var empty = document.getElementById("chat-empty");
      var input = document.getElementById("chat-input");
      var send = document.getElementById("chat-send");
      var pending = false;

      var SEND_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12 20 4l-6 16-3-7z"></path></svg>';
      var ERROR_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';

      function scrollToBottom() {
        log.scrollTop = log.scrollHeight;
      }

      function hideEmpty() {
        empty.style.display = "none";
      }

      function pad(value) {
        return value < 10 ? "0" + value : String(value);
      }

      function formatTime(date) {
        var hours = pad(date.getHours());
        var minutes = pad(date.getMinutes());
        var now = new Date();
        var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (date.getTime() >= startOfToday.getTime()) {
          return hours + ":" + minutes;
        }
        var startOfYesterday = new Date(startOfToday.getTime() - 86400000);
        if (date.getTime() >= startOfYesterday.getTime()) {
          return "Yesterday " + hours + ":" + minutes;
        }
        var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return months[date.getMonth()] + " " + date.getDate() + " " + hours + ":" + minutes;
      }

      function makeMeta(name, time) {
        var meta = document.createElement("div");
        meta.className = "sb-msg-meta";
        var label = document.createElement("b");
        label.textContent = name;
        meta.appendChild(label);
        if (time) {
          meta.appendChild(document.createTextNode(time));
        }
        return meta;
      }

      function appendUserMessage(text) {
        hideEmpty();
        var wrapper = document.createElement("div");
        wrapper.className = "sb-msg sb-msg-user";
        wrapper.appendChild(makeMeta("You", formatTime(new Date())));
        var bubble = document.createElement("div");
        bubble.className = "sb-bubble";
        bubble.textContent = text;
        wrapper.appendChild(bubble);
        log.appendChild(wrapper);
        scrollToBottom();
      }

      function appendBotMessage(text) {
        hideEmpty();
        var wrapper = document.createElement("div");
        wrapper.className = "sb-msg sb-msg-bot";
        wrapper.appendChild(makeMeta("Stavrobot", formatTime(new Date())));
        var bubble = document.createElement("div");
        bubble.className = "sb-bubble sb-md";
        if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
          bubble.innerHTML = DOMPurify.sanitize(marked.parse(text));
        } else {
          bubble.textContent = text;
        }
        wrapper.appendChild(bubble);
        log.appendChild(wrapper);
        scrollToBottom();
      }

      function appendErrorMessage(message, failedText) {
        hideEmpty();
        var wrapper = document.createElement("div");
        wrapper.className = "sb-msg sb-msg-bot sb-msg-error";
        wrapper.appendChild(makeMeta("Stavrobot", formatTime(new Date())));
        var bubble = document.createElement("div");
        bubble.className = "sb-bubble";
        bubble.innerHTML = ERROR_ICON;
        var body = document.createElement("div");
        var title = document.createElement("strong");
        title.style.display = "block";
        title.textContent = "The bot did not reply";
        var detail = document.createElement("span");
        detail.className = "sb-muted";
        detail.textContent = message;
        var again = document.createElement("button");
        again.type = "button";
        again.className = "sb-btn sb-btn-ghost sb-btn-sm";
        again.style.margin = "4px 0 0 -12px";
        again.textContent = "Send again";
        again.addEventListener("click", function () {
          if (failedText) {
            void sendMessage(failedText, false);
          }
        });
        body.appendChild(title);
        body.appendChild(detail);
        body.appendChild(document.createElement("br"));
        body.appendChild(again);
        bubble.appendChild(body);
        wrapper.appendChild(bubble);
        log.appendChild(wrapper);
        scrollToBottom();
      }

      function showTyping() {
        var wrapper = document.createElement("div");
        wrapper.className = "sb-msg sb-msg-bot";
        wrapper.id = "chat-typing";
        wrapper.setAttribute("aria-live", "polite");
        var meta = document.createElement("div");
        meta.className = "sb-msg-meta";
        var label = document.createElement("b");
        label.textContent = "Stavrobot";
        meta.appendChild(label);
        meta.appendChild(document.createTextNode("is thinking"));
        wrapper.appendChild(meta);
        var bubble = document.createElement("div");
        bubble.className = "sb-bubble sb-typing";
        bubble.setAttribute("aria-label", "Stavrobot is thinking");
        bubble.innerHTML = "<i></i><i></i><i></i>";
        wrapper.appendChild(bubble);
        log.appendChild(wrapper);
        scrollToBottom();
      }

      function hideTyping() {
        var element = document.getElementById("chat-typing");
        if (element) {
          element.remove();
        }
      }

      function setPending(value) {
        pending = value;
        input.disabled = value;
        if (value) {
          input.placeholder = "Waiting for the reply...";
          send.classList.add("is-loading");
          send.setAttribute("aria-busy", "true");
          send.setAttribute("aria-label", "Sending");
          send.innerHTML = '<span class="sb-spinner"></span>';
        } else {
          input.placeholder = "Message Stavrobot";
          send.classList.remove("is-loading");
          send.setAttribute("aria-busy", "false");
          send.setAttribute("aria-label", "Send");
          send.innerHTML = SEND_ICON;
        }
      }

      async function sendMessage(text, appendUser) {
        if (pending) {
          return;
        }
        var trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        if (appendUser) {
          appendUserMessage(trimmed);
        }
        input.value = "";
        input.style.height = "";
        showTyping();
        setPending(true);
        try {
          var response = await fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ message: trimmed }),
          });
          hideTyping();
          if (!response.ok) {
            appendErrorMessage("Server returned " + response.status, trimmed);
            return;
          }
          var data = await response.json();
          var responseText = typeof data.response === "string" && data.response.length > 0 ? data.response : "(empty response)";
          appendBotMessage(responseText);
        } catch (error) {
          hideTyping();
          appendErrorMessage(error && error.message ? error.message : String(error), trimmed);
        } finally {
          setPending(false);
          input.focus();
        }
      }

      input.addEventListener("input", function () {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 160) + "px";
      });

      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void sendMessage(input.value, true);
        }
      });

      send.addEventListener("click", function () {
        void sendMessage(input.value, true);
      });

      input.focus();
    })();
  </script>`;
}

function buildContent(config: Config, uptime: string, stats: MessageStats): string {
  return `<div class="sb-page-h"><h1 class="sb-h1">Overview</h1><span class="sb-pill"><span class="sb-dot sb-dot-on"></span>Online · ${escapeHtml(uptime)}</span></div>
  <div class="sb-overview">
    ${renderChatCard()}
    <div class="sb-overview-side">
      ${renderBotInfoCard(config, uptime)}
      ${renderServicesCard(config)}
      ${renderStatisticsCard(stats)}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js" integrity="sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.2/dist/purify.min.js" integrity="sha384-8hAfZQ5Oqos5HLTHfR0sLvvwpcVI4fGhV+0Dj/HCcpkKaacivQs82XHmvLOnAhXn" crossorigin="anonymous"></script>
  ${renderChatScript()}`;
}

function buildHomePage(config: Config, uptime: string, stats: MessageStats): string {
  return renderPageShell({
    title: "Overview",
    mobileTitle: "Stavrobot",
    content: buildContent(config, uptime, stats),
    nav: { active: "overview", model: config.model, uptime },
  });
}

export async function serveHomePage(
  response: http.ServerResponse,
  config: Config,
  pool: pg.Pool,
): Promise<void> {
  try {
    log.debug("[stavrobot] serveHomePage: querying message statistics");

    const result = await pool.query<MessageStats>(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE m.sender_identity_id IS NULL AND m.sender_agent_id IS NULL) AS web,
        COUNT(*) FILTER (WHERE m.sender_agent_id IS NOT NULL) AS agents,
        COUNT(*) FILTER (WHERE m.sender_identity_id IS NOT NULL AND i.owner = true) AS owner,
        COUNT(*) FILTER (WHERE m.sender_identity_id IS NOT NULL AND i.owner = false) AS others
      FROM messages m
      LEFT JOIN interlocutor_identities ii ON ii.id = m.sender_identity_id
      LEFT JOIN interlocutors i ON i.id = ii.interlocutor_id
      WHERE m.role = 'user'
    `);

    const stats = result.rows[0];
    const uptime = getUptime();
    const html = buildHomePage(config, uptime, stats);

    log.debug("[stavrobot] serveHomePage: serving home page");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  } catch (error) {
    log.error("[stavrobot] Error serving home page:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}
