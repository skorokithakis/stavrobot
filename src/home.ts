import http from "http";
import type pg from "pg";
import type { Config } from "./config.js";
import { log } from "./log.js";

const startTime = Date.now();

function formatUptime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.join(", ");
}

interface MessageStats {
  total: string;
  signal: string;
  telegram: string;
  whatsapp: string;
  web: string;
  agent: string;
}

function buildHtml(config: Config, uptime: string, stats: MessageStats): string {
  const services = [
    { name: "Signal", enabled: config.signal !== undefined },
    { name: "Telegram", enabled: config.telegram !== undefined },
    { name: "WhatsApp", enabled: config.whatsapp !== undefined },
    { name: "Coder", enabled: config.coder !== undefined },
  ];

  const serviceRows = services
    .map(
      (service) =>
        `<div class="stat-row">
      <span class="stat-label">${service.name}</span>
      <span class="stat-value ${service.enabled ? "enabled" : "disabled"}">${service.enabled ? "Enabled" : "Disabled"}</span>
    </div>`,
    )
    .join("\n    ");

  const navLinkHtml = `<a href="/explorer">Database explorer</a>
    <a href="/settings">Settings</a>
    <a href="/settings/allowlist" style="margin-left: 24px">Allowlist</a>
    <a href="/settings/plugins" style="margin-left: 24px">Plugins</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stavrobot</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js" integrity="sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.2/dist/purify.min.js" integrity="sha384-8hAfZQ5Oqos5HLTHfR0sLvvwpcVI4fGhV+0Dj/HCcpkKaacivQs82XHmvLOnAhXn" crossorigin="anonymous"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f8f9fa;
      color: #1a1a1a;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      display: flex;
      flex-direction: column;
    }
    @media (max-width: 480px) {
      body { padding: 12px; }
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 24px;
      flex-shrink: 0;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .section {
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .section a {
      display: block;
      font-size: 15px;
      color: #d97706;
      text-decoration: none;
      padding: 4px 0;
    }
    .section a:hover {
      text-decoration: underline;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 14px;
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #555; }
    .stat-value { font-weight: 500; }
    .enabled { color: #15803d; }
    .disabled { color: #9ca3af; }

    /* Page layout */
    .page-layout {
      display: flex;
      gap: 24px;
      align-items: flex-start;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .chat-column {
      flex: 6;
      min-width: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .dashboard-column {
      flex: 4;
      min-width: 0;
      height: 100%;
      overflow-y: auto;
    }
    @media (max-width: 768px) {
      html, body { height: auto; overflow: visible; }
      .page-layout {
        flex-direction: column;
        overflow: visible;
      }
      .chat-column {
        height: 60vh;
        width: 100%;
      }
      .dashboard-column {
        height: auto;
        overflow-y: visible;
        width: 100%;
      }
    }

    /* Chat panel */
    .chat-panel {
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .chat-panel-header {
      padding: 16px;
      border-bottom: 1px solid #f0f0f0;
      flex-shrink: 0;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .chat-message {
      display: flex;
      flex-direction: column;
      max-width: 85%;
    }
    .chat-message.user {
      align-self: flex-end;
      align-items: flex-end;
    }
    .chat-message.agent {
      align-self: flex-start;
      align-items: flex-start;
    }
    .chat-message-sender {
      font-size: 11px;
      font-weight: 600;
      color: #888;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .chat-message-bubble {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
      word-break: break-word;
    }
    .chat-message.user .chat-message-bubble {
      background: #fef3c7;
      color: #1a1a1a;
      border-bottom-right-radius: 4px;
    }
    .chat-message.agent .chat-message-bubble {
      background: #f3f4f6;
      color: #1a1a1a;
      border-bottom-left-radius: 4px;
    }
    .chat-message.error .chat-message-bubble {
      background: #fee2e2;
      color: #991b1b;
    }
    /* Markdown content inside agent bubbles */
    .chat-message-bubble p { margin-bottom: 8px; }
    .chat-message-bubble p:last-child { margin-bottom: 0; }
    .chat-message-bubble ul,
    .chat-message-bubble ol { margin: 8px 0 8px 20px; }
    .chat-message-bubble li { margin-bottom: 4px; }
    .chat-message-bubble pre {
      background: #f5f5f5;
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
    }
    .chat-message-bubble code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
      background: #f5f5f5;
      padding: 1px 4px;
      border-radius: 3px;
    }
    .chat-message-bubble pre code {
      background: none;
      padding: 0;
    }
    .chat-message-bubble blockquote {
      border-left: 3px solid #d97706;
      margin: 8px 0;
      padding-left: 12px;
      color: #555;
    }
    .chat-message-bubble h1,
    .chat-message-bubble h2,
    .chat-message-bubble h3 {
      font-size: 15px;
      font-weight: 600;
      margin: 10px 0 6px;
    }
    .chat-message-bubble a {
      color: #d97706;
      text-decoration: underline;
    }

    /* Thinking indicator */
    .thinking-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      background: #f3f4f6;
      border-radius: 12px;
      border-bottom-left-radius: 4px;
      font-size: 13px;
      color: #888;
      align-self: flex-start;
    }
    .thinking-dot {
      width: 6px;
      height: 6px;
      background: #d97706;
      border-radius: 50%;
      animation: thinking-pulse 1.2s ease-in-out infinite;
    }
    .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes thinking-pulse {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }

    /* Chat input area */
    .chat-input-area {
      padding: 12px 16px;
      border-top: 1px solid #f0f0f0;
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
    }
    .chat-textarea {
      flex: 1;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: none;
      min-height: 38px;
      max-height: 160px;
      overflow-y: auto;
      outline: none;
      transition: border-color 0.15s;
    }
    .chat-textarea:focus {
      border-color: #d97706;
    }
    .chat-textarea:disabled {
      background: #f9fafb;
      color: #9ca3af;
    }
    .chat-send-btn {
      background: #d97706;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
      height: 38px;
      flex-shrink: 0;
    }
    .chat-send-btn:hover:not(:disabled) {
      background: #b45309;
    }
    .chat-send-btn:disabled {
      background: #e5e7eb;
      color: #9ca3af;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <h1>Stavrobot</h1>

  <div class="page-layout">
    <div class="chat-column">
      <div class="chat-panel">
        <div class="chat-panel-header">
          <h2>Chat</h2>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
          <textarea
            id="chat-input"
            class="chat-textarea"
            placeholder="Type a message..."
            rows="1"
          ></textarea>
          <button id="chat-send-btn" class="chat-send-btn">Send</button>
        </div>
      </div>
    </div>

    <div class="dashboard-column">
      <div class="section">
        <h2>Bot info</h2>
        <div class="stat-row">
          <span class="stat-label">Provider</span>
          <span class="stat-value">${config.provider}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Model</span>
          <span class="stat-value">${config.model}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Uptime</span>
          <span class="stat-value">${uptime}</span>
        </div>
      </div>

      <div class="section">
        <h2>Services</h2>
        ${serviceRows}
      </div>

      <div class="section">
        <h2>Message statistics</h2>
        <div class="stat-row">
          <span class="stat-label">Total inbound messages</span>
          <span class="stat-value">${stats.total}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Signal</span>
          <span class="stat-value">${stats.signal}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Telegram</span>
          <span class="stat-value">${stats.telegram}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">WhatsApp</span>
          <span class="stat-value">${stats.whatsapp}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Web API</span>
          <span class="stat-value">${stats.web}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Agents</span>
          <span class="stat-value">${stats.agent}</span>
        </div>
      </div>

      <div class="section">
        <h2>Navigation</h2>
        ${navLinkHtml}
      </div>
    </div>
  </div>

  <script>
    (function () {
      const messagesEl = document.getElementById("chat-messages");
      const inputEl = document.getElementById("chat-input");
      const sendBtn = document.getElementById("chat-send-btn");

      function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function setInputEnabled(enabled) {
        inputEl.disabled = !enabled;
        sendBtn.disabled = !enabled;
      }

      function appendMessage(sender, contentHtml, isHtml, extraClass) {
        const wrapper = document.createElement("div");
        wrapper.className = "chat-message " + sender + (extraClass ? " " + extraClass : "");

        const senderEl = document.createElement("div");
        senderEl.className = "chat-message-sender";
        senderEl.textContent = sender === "user" ? "You" : "Stavrobot";

        const bubble = document.createElement("div");
        bubble.className = "chat-message-bubble";
        if (isHtml) {
          bubble.innerHTML = contentHtml;
        } else {
          bubble.textContent = contentHtml;
        }

        wrapper.appendChild(senderEl);
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        scrollToBottom();
        return wrapper;
      }

      function showThinking() {
        const wrapper = document.createElement("div");
        wrapper.className = "thinking-indicator";
        wrapper.id = "thinking-indicator";
        wrapper.innerHTML =
          '<div class="thinking-dot"></div>' +
          '<div class="thinking-dot"></div>' +
          '<div class="thinking-dot"></div>';
        messagesEl.appendChild(wrapper);
        scrollToBottom();
      }

      function hideThinking() {
        const el = document.getElementById("thinking-indicator");
        if (el) {
          el.remove();
        }
      }

      // Auto-grow the textarea as the user types.
      inputEl.addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 160) + "px";
      });

      async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text) {
          return;
        }

        inputEl.value = "";
        inputEl.style.height = "auto";
        setInputEnabled(false);

        appendMessage("user", text, false, null);
        showThinking();

        try {
          let responseText;
          try {
            const response = await fetch("/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ message: text }),
            });

            if (!response.ok) {
              throw new Error("Server returned " + response.status);
            }

            const data = await response.json();
            if (typeof data.response === "string" && data.response.length > 0) {
              responseText = data.response;
            } else {
              responseText = "(empty response)";
            }
          } catch (error) {
            hideThinking();
            appendMessage("agent", "Error: " + (error.message || String(error)), false, "error");
            return;
          }

          hideThinking();
          if (typeof marked !== "undefined" && typeof marked.parse === "function") {
            const html = DOMPurify.sanitize(marked.parse(responseText));
            appendMessage("agent", html, true, null);
          } else {
            appendMessage("agent", responseText, false, null);
          }
        } finally {
          setInputEnabled(true);
          inputEl.focus();
        }
      }

      sendBtn.addEventListener("click", function () {
        void sendMessage();
      });

      inputEl.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void sendMessage();
        }
      });

      inputEl.focus();
    })();
  </script>
</body>
</html>`;
}

export async function serveHomePage(
  response: http.ServerResponse,
  config: Config,
  pool: pg.Pool,
): Promise<void> {
  try {
    log.debug("[stavrobot] serveHomePage: querying message stats");

    const result = await pool.query<MessageStats>(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE ii.service = 'signal') AS signal,
        COUNT(*) FILTER (WHERE ii.service = 'telegram') AS telegram,
        COUNT(*) FILTER (WHERE ii.service = 'whatsapp') AS whatsapp,
        COUNT(*) FILTER (WHERE m.sender_identity_id IS NULL AND m.sender_agent_id IS NULL) AS web,
        COUNT(*) FILTER (WHERE m.sender_agent_id IS NOT NULL) AS agent
      FROM messages m
      LEFT JOIN interlocutor_identities ii ON ii.id = m.sender_identity_id
      WHERE m.role = 'user'
    `);

    const stats = result.rows[0];
    const uptime = formatUptime(Date.now() - startTime);
    const html = buildHtml(config, uptime, stats);

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
